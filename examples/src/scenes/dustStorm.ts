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
