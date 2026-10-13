/**
 * Mars Dust Storm Survival: the scene's deterministic, DOM- and GPU-free game model.
 *
 * Everything here is analytic and seeded so the course, gusts and dust devils replay identically
 * (captain decision D4: fixed seed) and can be pinned by Node tests without booting WebGPU:
 *
 * - {@link StormField}: gust cycles with lulls (D8). `intensity(t)` drives fog, light, particles,
 *   devil spawning and how fast dust piles up.
 * - {@link DustDevilField}: Rankine vortices that drift with the wind and push, yaw, lift and can
 *   flip the rover (D5). {@link devilRoverForce} is the one coupling the scene applies.
 * - {@link DustAccumulation}: dust piling against the rover and props on their windward side. The
 *   heightfield never changes (D1); burial is a pile depth that sticks the rover, rendered as
 *   mounds by the scene (D2).
 * - {@link StormCourse}: sky-beam checkpoints reached in sequence, time penalties, the last
 *   checkpoint for hard-mode resets, and the win state.
 * - {@link STORM_DIFFICULTY}: easy = soft stuck you rock free with throttle plus a time penalty;
 *   hard = buried (or flipped) sends you back to the last checkpoint (D3).
 * - {@link STORM_QUALITY_TIERS}: reduced iOS tier vs the full desktop storm (D6).
 */

import { Rng } from "@forge/engine";

export const STORM_SEED = 0x5d057;

// ---------------------------------------------------------------- quality tiers (D6)

export type StormQualityTier = "full" | "reduced";

export interface StormQualitySettings {
  /** Capacity of the camera-centred storm-sheet GPU particle system. */
  sheetCapacity: number;
  /**
   * Capacity of each dust devil's own GPU particle system (one per devil slot). Capped hard on
   * the reduced tier so sheet + every devil stays inside the iOS particle budget.
   */
  devilCapacity: number;
  /** Storm-sheet spawn rate at full intensity (particles/s). */
  sheetRate: number;
  /** Simultaneous dust devils, and each column's spawn rate (particles/s). */
  devils: number;
  devilRate: number;
  /** Shadow map size; the reduced tier also drops a cascade. */
  shadowMapSize: number;
  shadowCascades: number;
}

export const STORM_QUALITY_TIERS: Readonly<Record<StormQualityTier, Readonly<StormQualitySettings>>> = Object.freeze({
  full: Object.freeze({
    sheetCapacity: 112_000,
    devilCapacity: 8_000,
    sheetRate: 40_000,
    devils: 6,
    devilRate: 3_000,
    shadowMapSize: 2048,
    shadowCascades: 3,
  }),
  reduced: Object.freeze({
    sheetCapacity: 22_000,
    devilCapacity: 2_000,
    sheetRate: 7_000,
    devils: 3,
    devilRate: 1_000,
    shadowMapSize: 1024,
    shadowCascades: 2,
  }),
});

/** iOS/iPadOS Safari gets the reduced 30 fps tier; everything else runs the full storm. */
/** Total GPU particles a tier can hold: the sheet plus every devil slot. */
export function stormParticleBudget(q: Readonly<StormQualitySettings>): number {
  return q.sheetCapacity + q.devils * q.devilCapacity;
}

export function stormQualityForPlatform(os: string): StormQualityTier {
  return os === "ios" ? "reduced" : "full";
}

// ---------------------------------------------------------------- difficulty (D3)

export type StormDifficulty = "easy" | "hard";

export interface StormDifficultyRules {
  /** What happens when the rover's pile reaches {@link BURIAL_STUCK}. */
  onStuck: "soft" | "reset";
  /** What happens when a devil leaves the rover on its side or roof. */
  onFlip: "right" | "reset";
  /** Seconds added once per soft-stuck episode or auto-righting. */
  timePenalty: number;
}

export const STORM_DIFFICULTY: Readonly<Record<StormDifficulty, Readonly<StormDifficultyRules>>> = Object.freeze({
  easy: Object.freeze({ onStuck: "soft", onFlip: "right", timePenalty: 15 }),
  hard: Object.freeze({ onStuck: "reset", onFlip: "reset", timePenalty: 0 }),
});

// ---------------------------------------------------------------- storm field (D8)

/** Seconds per gust cycle: lull → build → gust → ease. */
export const GUST_PERIOD = 48;
/** Fraction of the cycle spent in the lull (the window to dig out). */
export const GUST_LULL_FRACTION = 0.3;
export const LULL_INTENSITY = 0.35;
export const GUST_INTENSITY = 1;
/** Mean wind speed (m/s) at full intensity; the field scales it by intensity. */
export const STORM_WIND_SPEED = 26;

export type StormPhase = "lull" | "building" | "gust" | "easing";

const smooth = (t: number): number => {
  const x = Math.max(0, Math.min(1, t));
  return x * x * (3 - 2 * x);
};

/**
 * Analytic storm: gust envelope with lulls plus seeded jitter, and a slowly veering wind heading.
 * Pure in `t`, so any system (and any test) samples the same storm at the same time.
 */
export class StormField {
  readonly seed: number;
  private readonly phase0: number;
  private readonly headingBase: number;

  constructor(seed = STORM_SEED) {
    this.seed = seed;
    const rng = new Rng(seed);
    this.phase0 = rng.nextFloat() * 1000;
    this.headingBase = rng.nextFloat() * Math.PI * 2;
  }

  /** Position inside the current gust cycle, 0..1. */
  cycle(t: number): number {
    const c = (Math.max(0, t) / GUST_PERIOD) % 1;
    return c;
  }

  phase(t: number): StormPhase {
    const c = this.cycle(t);
    const l = GUST_LULL_FRACTION;
    if (c < l) return "lull";
    if (c < l + 0.2) return "building";
    if (c < 0.85) return "gust";
    return "easing";
  }

  /** Storm intensity 0..1: lull plateau, ramp, gusting peak with jitter, ease back to the lull. */
  intensity(t: number): number {
    const c = this.cycle(t);
    const l = GUST_LULL_FRACTION;
    let envelope: number;
    if (c < l) envelope = 0;
    else if (c < l + 0.2) envelope = smooth((c - l) / 0.2);
    else if (c < 0.85) envelope = 1;
    else envelope = 1 - smooth((c - 0.85) / 0.15);
    const tt = t + this.phase0;
    const jitter = 0.5 + 0.25 * Math.sin(tt * 1.7) + 0.15 * Math.sin(tt * 4.3 + 1.1) + 0.1 * Math.sin(tt * 9.1 + 2.3);
    const peak = GUST_INTENSITY - 0.18 * (1 - jitter);
    const value = LULL_INTENSITY + (peak - LULL_INTENSITY) * envelope;
    return Math.max(0, Math.min(1, value));
  }

  /** Wind heading (radians, 0 = +X) veering ±25° over a few minutes. */
  heading(t: number): number {
    const tt = t + this.phase0;
    return this.headingBase + 0.44 * Math.sin(tt * 0.021) + 0.08 * Math.sin(tt * 0.13);
  }

  /** Mean horizontal wind (m/s) at time `t`. */
  wind(t: number, out: { x: number; z: number } = { x: 0, z: 0 }): { x: number; z: number } {
    const speed = STORM_WIND_SPEED * this.intensity(t);
    const h = this.heading(t);
    out.x = Math.cos(h) * speed;
    out.z = Math.sin(h) * speed;
    return out;
  }
}

// ---------------------------------------------------------------- dust devils (D5)

export interface DustDevil {
  id: number;
  x: number;
  z: number;
  vx: number;
  vz: number;
  /** Rankine core radius (m): solid-body rotation inside, 1/r decay outside. */
  coreRadius: number;
  /** Beyond this the devil has no effect (m). */
  outerRadius: number;
  /** Peak tangential speed at the core edge (m/s); the sign is the spin direction. */
  swirl: number;
  life: number;
  age: number;
}

/** Peak tangential wind of a devil at the core edge, before the life envelope. */
export const DEVIL_SWIRL_MIN = 16;
export const DEVIL_SWIRL_MAX = 28;
/** Ramp in/out time (s) so devils never pop. */
export const DEVIL_FADE = 4;

/** Life envelope 0..1. */
export function devilEnvelope(devil: DustDevil): number {
  const inRamp = devil.age / DEVIL_FADE;
  const outRamp = (devil.life - devil.age) / DEVIL_FADE;
  return Math.max(0, Math.min(1, inRamp, outRamp));
}

/** Rankine tangential speed (m/s, signed by spin) at horizontal distance `r`. */
export function devilTangentialSpeed(devil: DustDevil, r: number): number {
  if (r >= devil.outerRadius) return 0;
  const rc = devil.coreRadius;
  const base = r < rc ? (devil.swirl * r) / rc : (devil.swirl * rc) / r;
  // Taper the 1/r tail to zero at the outer radius so the push has no step.
  const taper = r < rc ? 1 : 1 - smooth((r - rc) / Math.max(1e-6, devil.outerRadius - rc));
  return base * taper * devilEnvelope(devil);
}

/**
 * Seeded devil population around the rover. Devils spawn upwind, drift down the storm wind with
 * a seeded wander and a gentle bias toward the rover (so they are an actual hazard), and respawn
 * when their life ends or they drift out of range. More spawn slots are active in gusts.
 */
export class DustDevilField {
  readonly devils: DustDevil[] = [];
  readonly maxDevils: number;
  private readonly rng: Rng;
  private nextId = 0;

  constructor(maxDevils: number, seed = STORM_SEED + 101) {
    this.maxDevils = Math.max(0, Math.floor(maxDevils));
    this.rng = new Rng(seed);
  }

  /** Back to the fixed-seed initial state: no devils, the spawn stream replays from its seed. */
  reset(): void {
    this.devils.length = 0;
    this.rng.reset();
    this.nextId = 0;
  }

  /** Active slots at this storm intensity: one in a lull, all of them at the gust peak. */
  activeSlots(intensity: number): number {
    if (this.maxDevils === 0) return 0;
    return Math.max(1, Math.round(this.maxDevils * Math.max(0, Math.min(1, intensity))));
  }

  private spawn(roverX: number, roverZ: number, windX: number, windZ: number): DustDevil {
    const rng = this.rng;
    const windLen = Math.hypot(windX, windZ) || 1;
    const upwind = Math.atan2(-windZ / windLen, -windX / windLen);
    const angle = upwind + rng.nextSignedFloat() * 1.1;
    const dist = rng.nextRange(55, 110);
    const coreRadius = rng.nextRange(3, 6);
    return {
      id: this.nextId++,
      x: roverX + Math.cos(angle) * dist,
      z: roverZ + Math.sin(angle) * dist,
      vx: 0,
      vz: 0,
      coreRadius,
      outerRadius: coreRadius * rng.nextRange(3.5, 4.5),
      swirl: rng.nextRange(DEVIL_SWIRL_MIN, DEVIL_SWIRL_MAX) * (rng.nextFloat() < 0.5 ? -1 : 1),
      life: rng.nextRange(28, 46),
      age: 0,
    };
  }

  step(dt: number, intensity: number, windX: number, windZ: number, roverX: number, roverZ: number): void {
    const slots = this.activeSlots(intensity);
    for (let i = this.devils.length - 1; i >= 0; i--) {
      const d = this.devils[i]!;
      d.age += dt;
      const far = Math.hypot(d.x - roverX, d.z - roverZ) > 260;
      if (d.age >= d.life || far) this.devils.splice(i, 1);
    }
    while (this.devils.length < slots) this.devils.push(this.spawn(roverX, roverZ, windX, windZ));
    for (const d of this.devils) {
      // Drift at ~30% of the storm wind, wander, and steer weakly toward the rover.
      const toX = roverX - d.x;
      const toZ = roverZ - d.z;
      const toLen = Math.hypot(toX, toZ) || 1;
      const wander = Math.sin(d.age * 0.37 + d.id * 1.9);
      const targetVx = windX * 0.3 + (toX / toLen) * 2.2 + wander * 1.5 * (-toZ / toLen);
      const targetVz = windZ * 0.3 + (toZ / toLen) * 2.2 + wander * 1.5 * (toX / toLen);
      const k = Math.min(1, dt * 0.8);
      d.vx += (targetVx - d.vx) * k;
      d.vz += (targetVz - d.vz) * k;
      d.x += d.vx * dt;
      d.z += d.vz * dt;
    }
  }
}

export interface DevilRoverForce {
  /** Horizontal acceleration on the chassis (m/s²). */
  ax: number;
  az: number;
  /** Yaw angular acceleration (rad/s²). */
  yawAccel: number;
  /** Upward acceleration from the core updraft (m/s²); 0 outside the core. */
  lift: number;
  /** Roll angular acceleration (rad/s²) that can tip the rover over inside the core. */
  rollAccel: number;
}

/** Gains for {@link devilRoverForce}; tuned for the 1025 kg rover under Mars gravity. */
export const DEVIL_PUSH_GAIN = 0.16;
export const DEVIL_INFLOW_FRACTION = 0.35;
export const DEVIL_YAW_GAIN = 0.11;
/** Lift peaks at the eye; 3.72 m/s² would cancel Mars gravity. */
export const DEVIL_LIFT_MAX = 6.5;
export const DEVIL_ROLL_GAIN = 0.32;

/**
 * Force a devil applies to a rover at (x, z): drag toward the swirl (tangential) and the inflow
 * (radial), a yaw torque in the spin direction, and — inside the core only — an updraft and a roll
 * torque strong enough to lift the wheels and flip the rover in the strongest devils.
 */
export function devilRoverForce(devil: DustDevil, x: number, z: number, out: DevilRoverForce = { ax: 0, az: 0, yawAccel: 0, lift: 0, rollAccel: 0 }): DevilRoverForce {
  out.ax = 0;
  out.az = 0;
  out.yawAccel = 0;
  out.lift = 0;
  out.rollAccel = 0;
  const dx = x - devil.x;
  const dz = z - devil.z;
  const r = Math.hypot(dx, dz);
  const v = devilTangentialSpeed(devil, r);
  if (v === 0) return out;
  const rx = r > 1e-6 ? dx / r : 1;
  const rz = r > 1e-6 ? dz / r : 0;
  // Counter-clockwise tangent seen from above (+Y up): (-rz, rx). Positive swirl spins that way.
  const tx = -rz;
  const tz = rx;
  const push = DEVIL_PUSH_GAIN * v * Math.abs(v) * 0.1;
  const inflow = DEVIL_PUSH_GAIN * DEVIL_INFLOW_FRACTION * v * v * 0.1;
  out.ax = tx * push - rx * inflow;
  out.az = tz * push - rz * inflow;
  out.yawAccel = DEVIL_YAW_GAIN * v;
  if (r < devil.coreRadius) {
    const eye = 1 - r / devil.coreRadius;
    const strength = Math.abs(devil.swirl) / DEVIL_SWIRL_MAX;
    const env = devilEnvelope(devil);
    out.lift = DEVIL_LIFT_MAX * (0.4 + 0.6 * eye) * strength * env;
    out.rollAccel = DEVIL_ROLL_GAIN * v * (0.5 + eye);
  }
  return out;
}

// ---------------------------------------------------------------- accumulation (D1/D2)

/** Rover burial (0..1) at which it is stuck. */
export const BURIAL_STUCK = 0.6;
/** Easy mode: the rover is free again once the pile is dug back below this. */
export const BURIAL_FREE = 0.3;
/** Burial per second while parked at intensity 1 (≈ 15 s from clean to stuck in a gust). */
export const BURIAL_RATE = 0.04;
/** Below this ground speed (m/s) the rover counts as staying put. */
export const BURIAL_STILL_SPEED = 0.35;
/** Burial shed per second per m/s of driving. */
export const BURIAL_SHED_RATE = 0.08;
/** Burial removed per throttle pump (a rising edge) while stuck, and per second of held throttle. */
export const BURIAL_PUMP = 0.07;
export const BURIAL_HOLD_DIG = 0.025;

export interface DustPile {
  /** Obstacle centre and radius the pile leans against. */
  x: number;
  z: number;
  radius: number;
  /** Current pile depth (m) and the most it can hold. */
  depth: number;
  maxDepth: number;
}

/** Windward contact point of a pile: on the obstacle's upwind face, offset by its radius. */
export function pileWindwardPoint(pile: DustPile, windX: number, windZ: number, out: { x: number; z: number } = { x: 0, z: 0 }): { x: number; z: number } {
  const len = Math.hypot(windX, windZ);
  const ux = len > 1e-6 ? windX / len : 1;
  const uz = len > 1e-6 ? windZ / len : 0;
  out.x = pile.x - ux * pile.radius * 0.9;
  out.z = pile.z - uz * pile.radius * 0.9;
  return out;
}

/**
 * Dust piling against obstacles. Props accumulate toward their cap on the windward face at a rate
 * set by storm intensity; the rover's own pile (`burial`, 0..1) grows while it stays put and is
 * shed by driving or dug out by pumping the throttle.
 */
export class DustAccumulation {
  readonly piles: DustPile[] = [];
  /** Rover burial 0..1. */
  burial = 0;
  private lastThrottle = 0;

  addPile(x: number, z: number, radius: number, maxDepth = radius * 0.7): DustPile {
    const pile = { x, z, radius, depth: 0, maxDepth };
    this.piles.push(pile);
    return pile;
  }

  /** Props: windward piles fill at `0.02 m/s × intensity` up to their cap. */
  stepPiles(dt: number, intensity: number): void {
    for (const pile of this.piles) {
      pile.depth = Math.min(pile.maxDepth, pile.depth + 0.02 * intensity * dt * (pile.maxDepth / 0.7));
    }
  }

  /**
   * Rover pile. `speed` is ground speed; `throttle` 0..1; `stuck` says the scene is holding the
   * rover (only then does throttle dig rather than drive). Returns the new burial.
   */
  stepRover(dt: number, intensity: number, speed: number, throttle: number, stuck: boolean): number {
    let b = this.burial;
    if (stuck) {
      const rising = throttle > 0.5 && this.lastThrottle <= 0.5;
      if (rising) b -= BURIAL_PUMP;
      if (throttle > 0.5) b -= BURIAL_HOLD_DIG * dt;
      // The storm still piles on while you dig: a gust can out-pace slow pumping.
      b += BURIAL_RATE * intensity * dt * 0.5;
    } else if (speed < BURIAL_STILL_SPEED) {
      b += BURIAL_RATE * intensity * dt;
    } else {
      b -= BURIAL_SHED_RATE * speed * dt;
    }
    this.lastThrottle = throttle;
    this.burial = Math.max(0, Math.min(1, b));
    return this.burial;
  }

  resetRover(): void {
    this.burial = 0;
    this.lastThrottle = 0;
  }

  /** Empty every prop pile and the rover pile (a run restart). */
  reset(): void {
    for (const pile of this.piles) pile.depth = 0;
    this.resetRover();
  }
}

// ---------------------------------------------------------------- course (D4)

export interface StormCheckpoint {
  x: number;
  z: number;
}

/** Metres from the beam axis that count as reaching it. */
export const CHECKPOINT_REACH = 8;
export const STORM_CHECKPOINT_COUNT = 6;

/**
 * Layout seed surveyed on the seed-1337 Mars surface from the showcase spawn: the steepest 4 m
 * grade on any straight leg is ≈23°, so every beam is reachable without detours (the first seeds
 * tried crossed 35° crater walls).
 */
export const STORM_COURSE_SEED = STORM_SEED + 106;

/**
 * Fixed-seed checkpoint layout: a meandering line of beams 70–110 m apart starting from the spawn,
 * so every run (and every gate) drives the same course.
 */
export function stormCheckpointLayout(spawnX: number, spawnZ: number, count = STORM_CHECKPOINT_COUNT, seed = STORM_COURSE_SEED): StormCheckpoint[] {
  const rng = new Rng(seed);
  const out: StormCheckpoint[] = [];
  let heading = rng.nextFloat() * Math.PI * 2;
  let x = spawnX;
  let z = spawnZ;
  for (let i = 0; i < count; i++) {
    heading += rng.nextSignedFloat() * 0.8;
    const step = rng.nextRange(70, 110);
    x += Math.cos(heading) * step;
    z += Math.sin(heading) * step;
    out.push({ x, z });
  }
  return out;
}

export type StormRunState = "driving" | "won";

/**
 * Checkpoint sequence + run clock. `elapsed` counts driving time; `penalty` adds difficulty time
 * penalties; `total` is what the HUD shows. `lastReached` is where hard mode respawns (−1 = start).
 */
export class StormCourse {
  readonly checkpoints: readonly StormCheckpoint[];
  readonly spawnX: number;
  readonly spawnZ: number;
  index = 0;
  elapsed = 0;
  penalty = 0;
  resets = 0;
  state: StormRunState = "driving";

  constructor(checkpoints: readonly StormCheckpoint[], spawnX: number, spawnZ: number) {
    this.checkpoints = checkpoints;
    this.spawnX = spawnX;
    this.spawnZ = spawnZ;
  }

  /** Back to the start: first beam active, clock, penalty and resets cleared. */
  reset(): void {
    this.index = 0;
    this.elapsed = 0;
    this.penalty = 0;
    this.resets = 0;
    this.state = "driving";
  }

  get total(): number {
    return this.elapsed + this.penalty;
  }

  get active(): StormCheckpoint | null {
    return this.state === "won" ? null : (this.checkpoints[this.index] ?? null);
  }

  get lastReached(): number {
    return this.index - 1;
  }

  /** Where hard mode sends the rover back to: the last reached beam, or the spawn. */
  respawnPoint(): { x: number; z: number } {
    const cp = this.checkpoints[this.index - 1];
    return cp ? { x: cp.x, z: cp.z } : { x: this.spawnX, z: this.spawnZ };
  }

  /** Advance the clock and test the active beam. Returns true on the frame a beam is reached. */
  step(dt: number, x: number, z: number): boolean {
    if (this.state === "won") return false;
    this.elapsed += dt;
    const cp = this.checkpoints[this.index];
    if (!cp) return false;
    if (Math.hypot(x - cp.x, z - cp.z) > CHECKPOINT_REACH) return false;
    this.index++;
    if (this.index >= this.checkpoints.length) this.state = "won";
    return true;
  }

  /** Bearing (radians) from the rover heading to the active beam, wrapped to (−π, π]. */
  bearing(x: number, z: number, yaw: number): number {
    const cp = this.active;
    if (!cp) return 0;
    // Vehicle yaw 0 faces +Z; atan2(dx, dz) uses the same convention.
    let a = Math.atan2(cp.x - x, cp.z - z) - yaw;
    while (a <= -Math.PI) a += Math.PI * 2;
    while (a > Math.PI) a -= Math.PI * 2;
    return a;
  }

  distance(x: number, z: number): number {
    const cp = this.active;
    return cp ? Math.hypot(cp.x - x, cp.z - z) : 0;
  }
}

/** True when the chassis is on its side or roof (|roll| or |pitch| past 80°). */
export function isRoverFlipped(roll: number, pitch: number): boolean {
  const lim = (80 * Math.PI) / 180;
  return Math.abs(roll) > lim || Math.abs(pitch) > lim;
}

// ---------------------------------------------------------------- slope-draped drift mounds (fe-18)

/** Height of the terrain at (x, z); the scene passes the Mars heightfield query. */
export type GroundHeightFn = (x: number, z: number) => number;

/** Angle of repose of the drift dust (≈ dry Mars regolith, 30–34°). No dust surface is steeper. */
export const DUST_REPOSE_DEG = 32;
export const DUST_REPOSE_SLOPE = Math.tan((DUST_REPOSE_DEG * Math.PI) / 180);
/**
 * Terrain steeper than this fraction of the repose slope cannot hold a full mound: what is left
 * after the terrain uses up the slope budget is the mound's own gradient (floored so the math stays
 * finite; the height is cut instead, i.e. the dust slid off).
 */
const REPOSE_MIN_BUDGET = 0.15;
/** Downslope stretch is capped at this multiple of the wind-shaped radius; beyond it, height drops. */
export const DRIFT_MAX_STRETCH = 3;
/** Mound mesh resolution: rings from centre to rim, and segments around. */
export const DRIFT_RINGS = 6;
export const DRIFT_SEGMENTS = 20;
/** Interior vertices sit this far above the sampled ground so coarse triangles never dip into it. */
export const DRIFT_LIFT = 0.03;
/** The skirt ring below the rim is sunk this far under the ground (hides any gap at the edge). */
export const DRIFT_SKIRT_DEPTH = 0.35;

export interface DriftMoundInput {
  /** Where the dust gathers (windward contact point, or a rover's footprint). */
  x: number;
  z: number;
  /** Peak height (m) the dust would reach on flat ground. */
  height: number;
  /** Wind-shaped semi-axes on flat ground: `along` the wind direction, `across` it. */
  along: number;
  across: number;
  /** Orientation of the `along` axis (radians, 0 = +X, CCW toward +Z). */
  heading: number;
}

/**
 * The angle-of-repose shape of a mound on the local slope. Radius varies with direction φ (radians,
 * 0 = +X): the wind ellipse, stretched downslope until no flank (pile gradient + terrain drop) is
 * steeper than {@link DUST_REPOSE_SLOPE}. Height is cut only if the stretch cap is hit.
 */
export interface DriftMoundShape {
  x: number;
  z: number;
  height: number;
  along: number;
  across: number;
  heading: number;
  /** Terrain gradient magnitude (rise/run) at the centre and the downhill direction (radians). */
  slope: number;
  downhill: number;
}

/** Central-difference terrain gradient at (x, z). */
export function groundGradient(ground: GroundHeightFn, x: number, z: number, h = 0.75): { gx: number; gz: number } {
  return {
    gx: (ground(x + h, z) - ground(x - h, z)) / (2 * h),
    gz: (ground(x, z + h) - ground(x, z - h)) / (2 * h),
  };
}

/** Terrain drop (rise/run, positive = going down) along direction φ for a shape. */
const dropAlong = (shape: Pick<DriftMoundShape, "slope" | "downhill">, phi: number): number => shape.slope * Math.cos(phi - shape.downhill);

/** Wind-ellipse radius in direction φ. */
const ellipseRadius = (s: Pick<DriftMoundInput, "along" | "across" | "heading">, phi: number): number => {
  const c = Math.cos(phi - s.heading) / Math.max(1e-6, s.along);
  const n = Math.sin(phi - s.heading) / Math.max(1e-6, s.across);
  return 1 / Math.sqrt(c * c + n * n);
};

/**
 * Radius of the mound footprint in direction φ: the wind ellipse, or wider where the paraboloid
 * flank (max gradient 2H/R at the rim) plus the terrain drop would exceed the repose slope.
 */
export function driftMoundRadius(shape: DriftMoundShape, phi: number): number {
  const base = ellipseRadius(shape, phi);
  if (shape.height <= 0) return base;
  const budget = Math.max(REPOSE_MIN_BUDGET * DUST_REPOSE_SLOPE, DUST_REPOSE_SLOPE - Math.max(0, dropAlong(shape, phi)));
  return Math.min(base * DRIFT_MAX_STRETCH, Math.max(base, (2 * shape.height) / budget));
}

/**
 * Settle a drift on the terrain: measure the local slope, then cut the height until every direction's
 * flank fits the repose budget within the stretch cap (the dust that would not fit slid away).
 */
export function settleDriftMound(input: DriftMoundInput, ground: GroundHeightFn): DriftMoundShape {
  const g = groundGradient(ground, input.x, input.z);
  const slope = Math.hypot(g.gx, g.gz);
  const shape: DriftMoundShape = {
    x: input.x,
    z: input.z,
    height: Math.max(0, input.height),
    along: Math.max(0.05, input.along),
    across: Math.max(0.05, input.across),
    heading: input.heading,
    slope,
    downhill: slope > 1e-6 ? Math.atan2(-g.gz, -g.gx) : 0,
  };
  // Worst direction is straight downhill (largest drop) at its capped radius.
  let maxH = Infinity;
  for (let i = 0; i < DRIFT_SEGMENTS; i++) {
    const phi = (i / DRIFT_SEGMENTS) * Math.PI * 2;
    const budget = Math.max(REPOSE_MIN_BUDGET * DUST_REPOSE_SLOPE, DUST_REPOSE_SLOPE - Math.max(0, dropAlong(shape, phi)));
    maxH = Math.min(maxH, (budget * ellipseRadius(shape, phi) * DRIFT_MAX_STRETCH) / 2);
  }
  shape.height = Math.min(shape.height, maxH);
  return shape;
}

/** Mound height above the ground at a point (0 outside the footprint). */
export function driftMoundHeightAt(shape: DriftMoundShape, x: number, z: number): number {
  const dx = x - shape.x;
  const dz = z - shape.z;
  const r = Math.hypot(dx, dz);
  const R = driftMoundRadius(shape, Math.atan2(dz, dx));
  if (r >= R) return 0;
  const q = r / R;
  return shape.height * (1 - q * q);
}

export interface DriftMoundMesh {
  /** Positions relative to (shape.x, baseY, shape.z) so the entity sits at that origin. */
  positions: Float32Array;
  normals: Float32Array;
  uvs: Float32Array;
  indices: Uint16Array;
  baseY: number;
}

/** Vertex count of a drift mound mesh: centre, rings, and the sunken skirt ring. */
export const DRIFT_VERTEX_COUNT = 1 + DRIFT_RINGS * DRIFT_SEGMENTS + DRIFT_SEGMENTS;

/** Shared index buffer topology: a fan, ring strips, and a skirt strip down from the rim. */
function driftIndices(): Uint16Array {
  const S = DRIFT_SEGMENTS;
  const idx: number[] = [];
  const ring = (k: number, s: number): number => 1 + (k - 1) * S + (s % S);
  for (let s = 0; s < S; s++) idx.push(0, ring(1, s + 1), ring(1, s));
  for (let k = 1; k < DRIFT_RINGS; k++) {
    for (let s = 0; s < S; s++) {
      const a = ring(k, s);
      const b = ring(k, s + 1);
      const c = ring(k + 1, s);
      const d = ring(k + 1, s + 1);
      idx.push(a, b, d, a, d, c);
    }
  }
  const skirt = (s: number): number => 1 + DRIFT_RINGS * S + (s % S);
  for (let s = 0; s < S; s++) {
    const a = ring(DRIFT_RINGS, s);
    const b = ring(DRIFT_RINGS, s + 1);
    idx.push(a, b, skirt(s + 1), a, skirt(s + 1), skirt(s));
  }
  return new Uint16Array(idx);
}
const DRIFT_INDICES = driftIndices();

/**
 * Drape a settled mound onto the heightfield: every vertex samples the ground under it, the rim
 * ring lies exactly on the ground, and a skirt ring drops {@link DRIFT_SKIRT_DEPTH} below it, so no
 * edge of the pile ever floats over a slope. Pass `out` to reuse arrays (same topology every time).
 * `lift` raises interior vertices off the ground (z-fight / coarse-triangle guard).
 */
export function buildDriftMoundMesh(shape: DriftMoundShape, ground: GroundHeightFn, out?: DriftMoundMesh, lift = DRIFT_LIFT): DriftMoundMesh {
  const S = DRIFT_SEGMENTS;
  const mesh: DriftMoundMesh = out ?? {
    positions: new Float32Array(DRIFT_VERTEX_COUNT * 3),
    normals: new Float32Array(DRIFT_VERTEX_COUNT * 3),
    uvs: new Float32Array(DRIFT_VERTEX_COUNT * 2),
    indices: DRIFT_INDICES,
    baseY: 0,
  };
  const baseY = ground(shape.x, shape.z);
  mesh.baseY = baseY;
  const p = mesh.positions;
  const uv = mesh.uvs;
  const put = (i: number, wx: number, wy: number, wz: number, u: number, v: number): void => {
    p[i * 3] = wx - shape.x;
    p[i * 3 + 1] = wy - baseY;
    p[i * 3 + 2] = wz - shape.z;
    uv[i * 2] = u;
    uv[i * 2 + 1] = v;
  };
  put(0, shape.x, baseY + shape.height + lift, shape.z, 0.5, 0.5);
  for (let s = 0; s < S; s++) {
    const phi = (s / S) * Math.PI * 2;
    const c = Math.cos(phi);
    const n = Math.sin(phi);
    const R = driftMoundRadius(shape, phi);
    for (let k = 1; k <= DRIFT_RINGS; k++) {
      const q = k / DRIFT_RINGS;
      const wx = shape.x + c * R * q;
      const wz = shape.z + n * R * q;
      const h = shape.height * (1 - q * q);
      const ringLift = k < DRIFT_RINGS ? lift : 0;
      put(1 + (k - 1) * S + s, wx, ground(wx, wz) + h + ringLift, wz, 0.5 + 0.5 * c * q, 0.5 + 0.5 * n * q);
    }
    const wx = shape.x + c * R;
    const wz = shape.z + n * R;
    put(1 + DRIFT_RINGS * S + s, wx, ground(wx, wz) - DRIFT_SKIRT_DEPTH, wz, 0.5 + 0.5 * c, 0.5 + 0.5 * n);
  }
  // Smooth normals: accumulate face normals.
  const nrm = mesh.normals;
  nrm.fill(0);
  const idx = mesh.indices;
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t]! * 3;
    const b = idx[t + 1]! * 3;
    const c = idx[t + 2]! * 3;
    const ux = p[b]! - p[a]!, uy = p[b + 1]! - p[a + 1]!, uz = p[b + 2]! - p[a + 2]!;
    const vx = p[c]! - p[a]!, vy = p[c + 1]! - p[a + 1]!, vz = p[c + 2]! - p[a + 2]!;
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    for (const v of [a, b, c]) {
      nrm[v] = nrm[v]! + nx;
      nrm[v + 1] = nrm[v + 1]! + ny;
      nrm[v + 2] = nrm[v + 2]! + nz;
    }
  }
  for (let i = 0; i < nrm.length; i += 3) {
    const l = Math.hypot(nrm[i]!, nrm[i + 1]!, nrm[i + 2]!) || 1;
    nrm[i] = nrm[i]! / l;
    nrm[i + 1] = nrm[i + 1]! / l;
    nrm[i + 2] = nrm[i + 2]! / l;
  }
  return mesh;
}

// ---------------------------------------------------------------- particle look (fe-18)

/**
 * Airborne storm-sheet particle look. fe-18 shrank the grains (captain: "too large") to ~0.6× the
 * fe-16 sizes and raised per-particle opacity so the haze keeps its density: coverage scales with
 * size², and the extra alpha plus fog carry the rest without adding particles (budget unchanged).
 */
export const STORM_SHEET_LOOK = Object.freeze({
  size: 0.05,
  sizeStart: 0.035,
  sizeEnd: 0.085,
  sizeVariation: 0.45,
  alpha: 0.46,
});
/** fe-16 sheet sizes, kept for the regression test that pins "smaller than before". */
export const STORM_SHEET_LOOK_FE16 = Object.freeze({ size: 0.08, sizeStart: 0.06, sizeEnd: 0.14, alpha: 0.3 });

// ---------------------------------------------------------------- tornado devils (fe-18)

/** Visual funnel height (m) per metre of core radius; the reference columns are thin and tall. */
export const DEVIL_FUNNEL_HEIGHT_PER_CORE = 11;
/** Funnel radius at the ground and the top, as fractions of the core radius. */
export const DEVIL_FUNNEL_BASE = 0.32;
export const DEVIL_FUNNEL_WAIST = 0.26;
export const DEVIL_FUNNEL_TOP = 0.62;
/** Skirt (ground debris cloud) radius and height as multiples of the core radius. */
export const DEVIL_SKIRT_RADIUS = 1.15;
export const DEVIL_SKIRT_HEIGHT = 0.9;

/**
 * Funnel radius (as a fraction of the core radius) at normalized height `u` 0..1: pinched just above
 * the skirt, narrow for most of the column, widening slightly toward the top (the reference image).
 */
export function devilFunnelProfile(u: number): number {
  const x = Math.max(0, Math.min(1, u));
  if (x < 0.12) return DEVIL_FUNNEL_BASE + (DEVIL_FUNNEL_WAIST - DEVIL_FUNNEL_BASE) * smooth(x / 0.12);
  return DEVIL_FUNNEL_WAIST + (DEVIL_FUNNEL_TOP - DEVIL_FUNNEL_WAIST) * Math.pow((x - 0.12) / 0.88, 1.6);
}

/**
 * Rope-like sway of the funnel axis (m) at height `u` 0..1 and time `t`: zero at the ground, growing
 * with height, two incommensurate waves so neighbouring devils never move in lockstep.
 */
export function devilFunnelSway(devil: Pick<DustDevil, "id" | "coreRadius">, u: number, t: number, out: { x: number; z: number } = { x: 0, z: 0 }): { x: number; z: number } {
  const amp = devil.coreRadius * 0.55 * Math.pow(Math.max(0, Math.min(1, u)), 1.3);
  const ph = devil.id * 2.39;
  out.x = amp * (Math.sin(t * 0.7 + u * 3.1 + ph) + 0.4 * Math.sin(t * 1.9 + u * 7.3 + ph * 1.7));
  out.z = amp * (Math.cos(t * 0.6 + u * 2.7 + ph) + 0.4 * Math.cos(t * 2.3 + u * 6.1 + ph * 1.3));
  return out;
}

/**
 * Per-devil particle emitter shape (column + skirt share one system): a narrow core column fed from
 * the base with a fast updraft, a strong inward attractor so it stays rope-thin, and a swirl.
 */
export function devilParticleLook(devil: Pick<DustDevil, "coreRadius" | "swirl">): {
  jitterXZ: number;
  jitterY: number;
  speedMin: number;
  speedMax: number;
  coneAngle: number;
  attractorHeight: number;
  attractorStrength: number;
  swirl: number;
  sizeStart: number;
  sizeEnd: number;
} {
  const height = devil.coreRadius * DEVIL_FUNNEL_HEIGHT_PER_CORE;
  return {
    jitterXZ: devil.coreRadius * 0.45,
    jitterY: 0.8,
    speedMin: 9,
    speedMax: 17,
    coneAngle: 0.18,
    attractorHeight: height * 0.55,
    attractorStrength: 9,
    swirl: Math.sign(devil.swirl || 1) * 160,
    sizeStart: 0.05,
    sizeEnd: 0.16,
  };
}

/** Funnel shell mesh resolution: rings up the column and segments around it. */
export const FUNNEL_RINGS = 14;
export const FUNNEL_SEGMENTS = 14;
export const FUNNEL_VERTEX_COUNT = FUNNEL_RINGS * FUNNEL_SEGMENTS;

export interface FunnelMesh {
  positions: Float32Array;
  normals: Float32Array;
  uvs: Float32Array;
  indices: Uint16Array;
}

function funnelIndices(): Uint16Array {
  const idx: number[] = [];
  const S = FUNNEL_SEGMENTS;
  for (let k = 0; k < FUNNEL_RINGS - 1; k++) {
    for (let s = 0; s < S; s++) {
      const a = k * S + s;
      const b = k * S + ((s + 1) % S);
      idx.push(a, b + S, b, a, a + S, b + S);
    }
  }
  return new Uint16Array(idx);
}
const FUNNEL_INDICES = funnelIndices();

/**
 * An open, lumpy, swaying shell around a devil's axis, relative to its ground point. `profile(u)`
 * gives the radius in core radii at normalized height u; `scale` widens it (outer shell vs dense
 * core). The lumps are angular waves advected by the devil's spin, so the surface visibly rotates.
 */
export function buildFunnelMesh(
  devil: Pick<DustDevil, "id" | "coreRadius" | "swirl">,
  height: number,
  profile: (u: number) => number,
  scale: number,
  t: number,
  swayScale = 1,
  out?: FunnelMesh,
): FunnelMesh {
  const S = FUNNEL_SEGMENTS;
  const mesh: FunnelMesh = out ?? {
    positions: new Float32Array(FUNNEL_VERTEX_COUNT * 3),
    normals: new Float32Array(FUNNEL_VERTEX_COUNT * 3),
    uvs: new Float32Array(FUNNEL_VERTEX_COUNT * 2),
    indices: FUNNEL_INDICES,
  };
  const spin = Math.sign(devil.swirl || 1) * 1.6;
  const sway = { x: 0, z: 0 };
  for (let k = 0; k < FUNNEL_RINGS; k++) {
    const u = k / (FUNNEL_RINGS - 1);
    devilFunnelSway(devil, u, t, sway);
    const r0 = profile(u) * devil.coreRadius * scale;
    for (let s = 0; s < S; s++) {
      const phi = (s / S) * Math.PI * 2;
      const lump = 1 + 0.2 * Math.sin(3 * (phi - spin * t) + u * 9 + devil.id) + 0.1 * Math.sin(5 * (phi - spin * t * 1.3) - u * 13);
      const r = r0 * lump;
      const c = Math.cos(phi);
      const n = Math.sin(phi);
      const i = k * S + s;
      mesh.positions[i * 3] = sway.x * swayScale + c * r;
      mesh.positions[i * 3 + 1] = u * height;
      mesh.positions[i * 3 + 2] = sway.z * swayScale + n * r;
      mesh.normals[i * 3] = c;
      mesh.normals[i * 3 + 1] = 0;
      mesh.normals[i * 3 + 2] = n;
      mesh.uvs[i * 2] = s / S;
      mesh.uvs[i * 2 + 1] = u;
    }
  }
  return mesh;
}

/** Skirt profile: a wide, low debris cloud that narrows into the funnel. */
export function devilSkirtProfile(u: number): number {
  const x = Math.max(0, Math.min(1, u));
  return DEVIL_SKIRT_RADIUS * (1 - 0.55 * smooth(x)) ;
}

/**
 * Footprint growth for a young pile: a thin dusting covers only part of the full footprint, so an
 * early pile reads as a small drift instead of a wide flat plate. 1 once the pile is ~¼ as tall as
 * its long semi-axis.
 */
export function driftFootprintGrowth(height: number, along: number, across: number): number {
  const full = 0.25 * Math.max(along, across, 1e-6);
  return Math.max(0.2, Math.min(1, Math.sqrt(Math.max(0, height) / full)));
}

// ---------------------------------------------------------------- waypoint guidance (fe-18)

export interface StripMesh {
  positions: Float32Array;
  normals: Float32Array;
  uvs: Float32Array;
  indices: Uint16Array;
}

/** Height above the sampled terrain for draped guidance meshes (beam ring, easy path). */
export const BEAM_RING_OFFSET = 0.12;
export const GUIDE_PATH_OFFSET = 0.1;
export const BEAM_RING_SEGMENTS = 48;

/**
 * A flat annulus draped onto the heightfield around a beam: every inner and outer vertex samples
 * the ground and sits `offset` above it, so on a hill the ring follows the slope instead of being
 * half-buried on the uphill side and floating on the downhill side. Positions are relative to
 * (cx, ground(cx, cz), cz).
 */
export function buildDrapedRing(cx: number, cz: number, radius: number, width: number, ground: GroundHeightFn, segments = BEAM_RING_SEGMENTS, offset = BEAM_RING_OFFSET): StripMesh & { baseY: number } {
  const n = segments;
  const baseY = ground(cx, cz);
  const positions = new Float32Array(n * 2 * 3);
  const normals = new Float32Array(n * 2 * 3);
  const uvs = new Float32Array(n * 2 * 2);
  const idx: number[] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    for (let j = 0; j < 2; j++) {
      const r = j === 0 ? radius - width / 2 : radius + width / 2;
      const wx = cx + Math.cos(a) * r;
      const wz = cz + Math.sin(a) * r;
      const v = i * 2 + j;
      positions[v * 3] = wx - cx;
      positions[v * 3 + 1] = ground(wx, wz) + offset - baseY;
      positions[v * 3 + 2] = wz - cz;
      normals[v * 3 + 1] = 1;
      uvs[v * 2] = i / n;
      uvs[v * 2 + 1] = j;
    }
    const a0 = i * 2;
    const b0 = ((i + 1) % n) * 2;
    idx.push(a0, b0, b0 + 1, a0, b0 + 1, a0 + 1);
  }
  return { positions, normals, uvs, indices: new Uint16Array(idx), baseY };
}

/** Guide-path resolution and reach (m): beyond `GUIDE_PATH_MAX` only the first stretch is drawn. */
export const GUIDE_PATH_POINTS = 32;
export const GUIDE_PATH_MAX = 90;
export const GUIDE_PATH_HALF_WIDTH = 0.45;

/** The easy-mode glowing path is drawn only in easy, and only while there is a beam to reach. */
export function guidePathEnabled(difficulty: StormDifficulty, hasTarget: boolean): boolean {
  return difficulty === "easy" && hasTarget;
}

/**
 * A ribbon from the rover toward the next beam, draped on the terrain `offset` above it. Positions
 * are relative to (x0, ground(x0, z0), z0). The strip starts a little ahead of the rover (so it
 * does not sit under the chassis) and fades out along its length via uv.y (0 near → 1 far).
 */
export function buildGuidePath(x0: number, z0: number, x1: number, z1: number, ground: GroundHeightFn, out?: StripMesh & { baseY: number }, offset = GUIDE_PATH_OFFSET): StripMesh & { baseY: number } {
  const N = GUIDE_PATH_POINTS;
  const mesh = out ?? {
    positions: new Float32Array(N * 2 * 3),
    normals: new Float32Array(N * 2 * 3),
    uvs: new Float32Array(N * 2 * 2),
    indices: (() => {
      const idx: number[] = [];
      for (let i = 0; i < N - 1; i++) {
        const a = i * 2;
        idx.push(a, a + 2, a + 3, a, a + 3, a + 1);
      }
      return new Uint16Array(idx);
    })(),
    baseY: 0,
  };
  const baseY = ground(x0, z0);
  mesh.baseY = baseY;
  const dx = x1 - x0;
  const dz = z1 - z0;
  const dist = Math.hypot(dx, dz);
  const ux = dist > 1e-6 ? dx / dist : 1;
  const uz = dist > 1e-6 ? dz / dist : 0;
  const start = Math.min(2.5, dist);
  const end = Math.min(dist, GUIDE_PATH_MAX);
  for (let i = 0; i < N; i++) {
    const t = start + ((end - start) * i) / (N - 1);
    const cxw = x0 + ux * t;
    const czw = z0 + uz * t;
    for (let j = 0; j < 2; j++) {
      const side = j === 0 ? -GUIDE_PATH_HALF_WIDTH : GUIDE_PATH_HALF_WIDTH;
      const wx = cxw - uz * side;
      const wz = czw + ux * side;
      const v = i * 2 + j;
      mesh.positions[v * 3] = wx - x0;
      mesh.positions[v * 3 + 1] = ground(wx, wz) + offset - baseY;
      mesh.positions[v * 3 + 2] = wz - z0;
      mesh.normals[v * 3] = 0;
      mesh.normals[v * 3 + 1] = 1;
      mesh.normals[v * 3 + 2] = 0;
      mesh.uvs[v * 2] = j;
      mesh.uvs[v * 2 + 1] = i / (N - 1);
    }
  }
  return mesh;
}

/**
 * Is `target` inside the camera's view? Projects onto the camera basis and compares the angular
 * offsets against the half-FOVs scaled by `margin` (< 1 = must be well inside the frame).
 */
export function waypointInView(
  eye: { x: number; y: number; z: number },
  forward: { x: number; y: number; z: number },
  target: { x: number; y: number; z: number },
  fovY: number,
  aspect: number,
  margin = 1,
): boolean {
  const dx = target.x - eye.x;
  const dy = target.y - eye.y;
  const dz = target.z - eye.z;
  const depth = dx * forward.x + dy * forward.y + dz * forward.z;
  if (depth <= 0.01) return false;
  // Camera right = forward × up(0,1,0), normalized; camera up = right × forward.
  let rx = -forward.z;
  let rz = forward.x;
  const rl = Math.hypot(rx, rz) || 1;
  rx /= rl;
  rz /= rl;
  const ux = -rz * forward.y;
  const uy = rz * forward.x - rx * forward.z;
  const uz = rx * forward.y;
  const sx = (dx * rx + dz * rz) / depth;
  const sy = (dx * ux + dy * uy + dz * uz) / depth;
  const ty = Math.tan(fovY / 2) * margin;
  return Math.abs(sy) <= ty && Math.abs(sx) <= ty * aspect;
}

/** Hysteresis for the off-screen arrow: show after it is clearly out, hide once clearly in. */
export const ARROW_SHOW_DELAY = 0.35;
export const ARROW_HIDE_DELAY = 0.35;
/** Inner margin for "clearly in view" (hide) vs the frame edge for "out of view" (show). */
export const ARROW_IN_MARGIN = 0.8;
export const ARROW_OUT_MARGIN = 1.0;

/**
 * Off-screen waypoint arrow visibility with spatial (two margins) and temporal (delays) hysteresis,
 * so a beam grazing the frame edge never makes the arrow flicker.
 */
export class WaypointArrowState {
  visible = false;
  private timer = 0;

  /** `inner`: target inside the inner margin; `outer`: inside the frame at all. */
  step(dt: number, inner: boolean, outer: boolean, hasTarget: boolean): boolean {
    if (!hasTarget) {
      this.visible = false;
      this.timer = 0;
      return false;
    }
    const wantShow = !outer;
    const wantHide = inner;
    if (!this.visible && wantShow) {
      this.timer += dt;
      if (this.timer >= ARROW_SHOW_DELAY) {
        this.visible = true;
        this.timer = 0;
      }
    } else if (this.visible && wantHide) {
      this.timer += dt;
      if (this.timer >= ARROW_HIDE_DELAY) {
        this.visible = false;
        this.timer = 0;
      }
    } else {
      this.timer = 0;
    }
    return this.visible;
  }

  reset(): void {
    this.visible = false;
    this.timer = 0;
  }
}

/**
 * A chunky extruded arrow pointing along +X (shaft + head), centred on the origin; the scene yaws it
 * toward the beam. Flat-shaded enough for an emissive material.
 */
export function buildArrowMesh(length = 2.4, width = 1.3, thickness = 0.3): StripMesh {
  const L = length;
  const hw = width / 2;
  const sw = hw * 0.42;
  const head = L * 0.42;
  const x0 = -L / 2;
  const xh = L / 2 - head;
  const x1 = L / 2;
  const outline: [number, number][] = [
    [x0, -sw], [xh, -sw], [xh, -hw], [x1, 0], [xh, hw], [xh, sw], [x0, sw],
  ];
  const n = outline.length;
  const pos: number[] = [];
  const nrm: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  const t = thickness / 2;
  // Top and bottom caps (fan-free triangulation: shaft quad + head triangle).
  for (const [y, ny] of [[t, 1], [-t, -1]] as const) {
    const base = pos.length / 3;
    for (const [x, z] of outline) {
      pos.push(x, y, z);
      nrm.push(0, ny, 0);
      uv.push((x - x0) / L, (z + hw) / width);
    }
    const tris = [[0, 1, 5], [0, 5, 6], [2, 3, 4]];
    for (const [a, b, c] of tris) {
      if (ny > 0) idx.push(base + a!, base + c!, base + b!);
      else idx.push(base + a!, base + b!, base + c!);
    }
  }
  // Side walls.
  for (let i = 0; i < n; i++) {
    const [ax, az] = outline[i]!;
    const [bx, bz] = outline[(i + 1) % n]!;
    const ex = bx - ax;
    const ez = bz - az;
    const l = Math.hypot(ex, ez) || 1;
    const nx = ez / l;
    const nz = -ex / l;
    const base = pos.length / 3;
    pos.push(ax, t, az, bx, t, bz, bx, -t, bz, ax, -t, az);
    for (let k = 0; k < 4; k++) {
      nrm.push(nx, 0, nz);
      uv.push(k === 1 || k === 2 ? 1 : 0, k >= 2 ? 1 : 0);
    }
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  return { positions: new Float32Array(pos), normals: new Float32Array(nrm), uvs: new Float32Array(uv), indices: new Uint16Array(idx) };
}

/** The off-screen waypoint arrow is an EASY-mode aid only, like the path (captain fe-18). */
export function waypointArrowEnabled(difficulty: StormDifficulty): boolean {
  return difficulty === "easy";
}

// ---------------------------------------------------------------- beam pulse (fe-18)

/** Seconds per beam pulse; one bright band leaves the ground each period and climbs the beam. */
export const BEAM_PULSE_PERIOD = 1.6;
/** Fraction of the beam height the band climbs before it has faded out. */
export const BEAM_PULSE_REACH = 0.6;

export interface BeamPulse {
  /** Multiplier on the beam's emissive strength (rhythmic, never below 0.75). */
  glow: number;
  /** Multiplier on the beam's radius (subtle breathing). */
  width: number;
  /** Height of the travelling band as a 0..1 fraction of the beam, rising each period. */
  band: number;
  /** Band opacity: bright at the base, fading as it rises. */
  bandOpacity: number;
}

/** Beam pulse at time `t`: a glow throb plus a band travelling up the beam into the sky. */
export function beamPulse(t: number, out: BeamPulse = { glow: 1, width: 1, band: 0, bandOpacity: 0 }): BeamPulse {
  const phase = (((t / BEAM_PULSE_PERIOD) % 1) + 1) % 1;
  const throb = Math.pow(0.5 + 0.5 * Math.cos(phase * Math.PI * 2), 2); // peaks as a band launches
  out.glow = 0.75 + 0.55 * throb;
  out.width = 1 + 0.12 * throb;
  out.band = phase * BEAM_PULSE_REACH;
  out.bandOpacity = 0.55 * (1 - smooth(phase)) * smooth(phase / 0.08);
  return out;
}
