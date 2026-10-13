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
    sheetCapacity: 88_000,
    devilCapacity: 24_000,
    sheetRate: 32_000,
    devils: 6,
    devilRate: 18_000,
    shadowMapSize: 2048,
    shadowCascades: 3,
  }),
  reduced: Object.freeze({
    sheetCapacity: 10_000,
    devilCapacity: 6_000,
    sheetRate: 3_200,
    devils: 3,
    devilRate: 4_500,
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

export type DevilState = "free" | "orbiting" | "dying";

/** Why a devil left (for the HUD/tests): its life ran out, it drifted away, or an interaction. */
export type DevilEndCause = "expired" | "far" | "consumed" | "merged" | "orbit-died";

export interface DevilOrbit {
  /** Host devil id (big–small orbit) or partner id (mutual orbit of two small ones). */
  otherId: number;
  mutual: boolean;
  angle: number;
  radius: number;
  /** Signed angular speed (rad/s). */
  rate: number;
  /** Seconds left before the outcome is applied. */
  timer: number;
  outcome: "consume" | "die" | "combine" | "separate" | "one-dies" | "both-die";
}

export interface DustDevil {
  id: number;
  /** Stable GPU particle / impostor slot (0..maxDevils-1); never reused until this devil is gone. */
  slot: number;
  x: number;
  z: number;
  vx: number;
  vz: number;
  /** Rankine core radius (m): solid-body rotation inside, 1/r decay outside. The devil's width. */
  coreRadius: number;
  /** Beyond this the devil has no effect (m). */
  outerRadius: number;
  /** Peak tangential speed at the core edge (m/s); the sign is the spin direction. */
  swirl: number;
  life: number;
  age: number;
  /** Per-devil look multiplier on the impostor opacity (some devils are denser than others). */
  opacity: number;
  /** Fade-out duration (s) of the life envelope; shortened when a devil is consumed. */
  fadeOut: number;
  /** Growth target for the core radius after consuming / combining (eased, no pop). */
  targetCore: number;
  state: DevilState;
  orbit: DevilOrbit | null;
  endCause: DevilEndCause | null;
}

/** Peak tangential wind of a medium devil at the core edge, before size scaling and envelope. */
export const DEVIL_SWIRL_MIN = 16;
export const DEVIL_SWIRL_MAX = 28;
/** Ramp in/out time (s) so devils never pop. */
export const DEVIL_FADE = 4;
/** Fade (s) of a devil swallowed by another (it is dragged into the absorber while it fades). */
export const DEVIL_CONSUME_FADE = 2;
/** Spawned width range (m) and the cap growth can reach. */
export const DEVIL_CORE_MIN = 2;
export const DEVIL_CORE_MAX_SPAWN = 7;
export const DEVIL_CORE_CAP = 9;
/** Reference width: a devil this wide has size factor 1. */
export const DEVIL_CORE_REF = 4.5;
/** Below this width a devil counts as small for interactions. */
export const DEVIL_SMALL_CORE = 3.6;
/** Big–small pair when the big core is at least this many times the small one. */
export const DEVIL_BIG_RATIO = 1.4;

/**
 * Size → wind: the swirl a devil of core radius `core` gets from a base swirl. Square-root scaling
 * clamped to [0.6, 1.5], so wide devils push and lift the rover harder and narrow ones less.
 */
export function devilSizeFactor(core: number): number {
  return Math.max(0.6, Math.min(1.5, Math.sqrt(core / DEVIL_CORE_REF)));
}

/** Lifespan (s) for a width: narrow devils die quickly (~10–16 s), wide ones last ~35–50 s. */
export function devilLifespan(core: number, jitter01: number): number {
  const w = Math.max(0, Math.min(1, (core - DEVIL_CORE_MIN) / (DEVIL_CORE_MAX_SPAWN - DEVIL_CORE_MIN)));
  return 10 + 34 * w * w + 6 * jitter01;
}

/** Life envelope 0..1. */
export function devilEnvelope(devil: Pick<DustDevil, "age" | "life"> & Partial<Pick<DustDevil, "fadeOut">>): number {
  const inRamp = devil.age / DEVIL_FADE;
  const outRamp = (devil.life - devil.age) / (devil.fadeOut ?? DEVIL_FADE);
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

/** Interaction probabilities (seeded rolls; the same seed replays the same story). */
export interface DevilRules {
  bigConsumes: number;
  orbitThenConsumed: number;
  smallMerge: number;
  combine: number;
  separate: number;
  oneDies: number;
  orbitMin: number;
  orbitMax: number;
}

export const DEVIL_RULES: Readonly<DevilRules> = Object.freeze({
  /** Big meets small: chance the big one swallows it at once (else the small one orbits it). */
  bigConsumes: 0.55,
  /** After orbiting a big one: chance it is consumed (else it dies out). */
  orbitThenConsumed: 0.6,
  /** Two small ones touch: chance they merge at once (else they orbit each other). */
  smallMerge: 0.15,
  /** Mutual-orbit outcomes (cumulative): combine, separate, one dies, both die. */
  combine: 0.35,
  separate: 0.35,
  oneDies: 0.2,
  /** Orbit durations (s). */
  orbitMin: 3,
  orbitMax: 8,
});

/**
 * Seeded devil population around the rover. Devils spawn upwind with their own width, density and
 * lifespan (narrow ones die fast), drift down the storm wind with a seeded wander and a gentle bias
 * toward the rover, and interact: a big devil can swallow a small one (growing), or the small one
 * orbits it before being consumed or dying; two small ones can merge or orbit each other, then
 * combine, separate, or die. Every devil holds a stable slot so GPU particle systems never jump
 * between devils; a devil frees its slot only after its envelope has faded to zero.
 */
export class DustDevilField {
  readonly devils: DustDevil[] = [];
  readonly maxDevils: number;
  /** Ended devils since the last reset, by cause (tests + HUD). */
  readonly ended: Record<DevilEndCause, number> = { expired: 0, far: 0, consumed: 0, merged: 0, "orbit-died": 0 };
  private readonly rng: Rng;
  private nextId = 0;

  readonly rules: Readonly<DevilRules>;

  /** `rules` overrides the interaction odds (tests force each outcome); the scene uses the defaults. */
  constructor(maxDevils: number, seed = STORM_SEED + 101, rules: Readonly<DevilRules> = DEVIL_RULES) {
    this.maxDevils = Math.max(0, Math.floor(maxDevils));
    this.rules = rules;
    this.rng = new Rng(seed);
  }

  /** Back to the fixed-seed initial state: no devils, the spawn stream replays from its seed. */
  reset(): void {
    this.devils.length = 0;
    this.rng.reset();
    this.nextId = 0;
    for (const k of Object.keys(this.ended) as DevilEndCause[]) this.ended[k] = 0;
  }

  /** Active slots at this storm intensity: one in a lull, all of them at the gust peak. */
  activeSlots(intensity: number): number {
    if (this.maxDevils === 0) return 0;
    return Math.max(1, Math.round(this.maxDevils * Math.max(0, Math.min(1, intensity))));
  }

  /** The devil that owns GPU slot `slot`, if any. */
  bySlot(slot: number): DustDevil | undefined {
    for (const d of this.devils) if (d.slot === slot) return d;
    return undefined;
  }

  byId(id: number): DustDevil | undefined {
    for (const d of this.devils) if (d.id === id) return d;
    return undefined;
  }

  /** Living (not fading-out) devils: what counts toward the active-slot target. */
  liveCount(): number {
    let n = 0;
    for (const d of this.devils) if (d.state !== "dying") n++;
    return n;
  }

  private freeSlot(): number {
    for (let s = 0; s < this.maxDevils; s++) if (!this.bySlot(s)) return s;
    return -1;
  }

  /** Build a devil with the given width (tests use this to stage encounters). */
  makeDevil(x: number, z: number, coreRadius: number, slot = this.freeSlot()): DustDevil {
    const rng = this.rng;
    const core = Math.max(DEVIL_CORE_MIN * 0.5, coreRadius);
    return {
      id: this.nextId++,
      slot,
      x,
      z,
      vx: 0,
      vz: 0,
      coreRadius: core,
      outerRadius: core * rng.nextRange(3.5, 4.5),
      swirl: rng.nextRange(DEVIL_SWIRL_MIN, DEVIL_SWIRL_MAX) * devilSizeFactor(core) * (rng.nextFloat() < 0.5 ? -1 : 1),
      life: devilLifespan(core, rng.nextFloat()),
      age: 0,
      opacity: rng.nextRange(0.75, 1.2),
      fadeOut: DEVIL_FADE,
      targetCore: core,
      state: "free",
      orbit: null,
      endCause: null,
    };
  }

  private spawn(roverX: number, roverZ: number, windX: number, windZ: number, slot: number): DustDevil {
    const rng = this.rng;
    const windLen = Math.hypot(windX, windZ) || 1;
    const upwind = Math.atan2(-windZ / windLen, -windX / windLen);
    const angle = upwind + rng.nextSignedFloat() * 1.1;
    const dist = rng.nextRange(55, 110);
    // Skewed width: many narrow rope devils, a few wide dark columns.
    const u = rng.nextFloat();
    const core = DEVIL_CORE_MIN + (DEVIL_CORE_MAX_SPAWN - DEVIL_CORE_MIN) * u * u;
    return this.makeDevil(roverX + Math.cos(angle) * dist, roverZ + Math.sin(angle) * dist, core, slot);
  }

  /** Start a devil's fade-out (no pop): it keeps its slot until the envelope reaches zero. */
  private end(d: DustDevil, cause: DevilEndCause, fade = DEVIL_FADE): void {
    if (d.state === "dying") return;
    d.state = "dying";
    d.orbit = null;
    d.endCause = cause;
    // Never raise the envelope: a devil already fading out with less than `fade` left keeps its
    // own ramp (re-scaling fadeOut there would jump the out-ramp up, a visible pop).
    if (d.life - d.age > fade) {
      d.fadeOut = fade;
      d.life = d.age + fade;
    }
    this.ended[cause]++;
  }

  /** `big` absorbs `small`: area-conserving width growth (eased), stronger swirl, longer life. */
  private absorb(big: DustDevil, small: DustDevil, cause: DevilEndCause): void {
    const grown = Math.min(DEVIL_CORE_CAP, Math.hypot(big.targetCore, small.targetCore));
    const ratio = grown / Math.max(1e-6, big.targetCore);
    big.targetCore = grown;
    big.swirl = Math.sign(big.swirl || 1) * Math.min(DEVIL_SWIRL_MAX * 1.5, Math.abs(big.swirl) * Math.sqrt(ratio));
    big.life = Math.max(big.life, big.age + 12);
    big.opacity = Math.min(1.3, big.opacity + 0.05);
    this.end(small, cause, DEVIL_CONSUME_FADE);
    small.orbit = { otherId: big.id, mutual: false, angle: 0, radius: 0, rate: 0, timer: 0, outcome: "consume" };
  }

  private startOrbit(a: DustDevil, b: DustDevil, mutual: boolean): void {
    const rng = this.rng;
    const timer = rng.nextRange(this.rules.orbitMin, this.rules.orbitMax);
    const dir = rng.nextFloat() < 0.5 ? -1 : 1;
    if (!mutual) {
      // `a` (small) circles `b` (big) just outside its core.
      const outcome = rng.nextFloat() < this.rules.orbitThenConsumed ? "consume" : "die";
      a.state = "orbiting";
      a.orbit = { otherId: b.id, mutual: false, angle: Math.atan2(a.z - b.z, a.x - b.x), radius: b.coreRadius + a.coreRadius * 1.2, rate: dir * 0.9, timer, outcome };
      return;
    }
    const r = rng.nextFloat();
    const R = this.rules;
    const outcome = r < R.combine ? "combine" : r < R.combine + R.separate ? "separate" : r < R.combine + R.separate + R.oneDies ? "one-dies" : "both-die";
    const mx = (a.x + b.x) / 2;
    const mz = (a.z + b.z) / 2;
    const radius = Math.max(1.5, Math.hypot(a.x - b.x, a.z - b.z) / 2);
    // Only the lower id carries the shared orbit; the partner just points back to it.
    a.state = "orbiting";
    b.state = "orbiting";
    a.orbit = { otherId: b.id, mutual: true, angle: Math.atan2(a.z - mz, a.x - mx), radius, rate: dir * 1.4, timer, outcome };
    b.orbit = { otherId: a.id, mutual: true, angle: 0, radius, rate: 0, timer: Infinity, outcome };
  }

  /** Close enough to interact: cores overlapping the other's inner swirl. */
  static touching(a: DustDevil, b: DustDevil): boolean {
    return Math.hypot(a.x - b.x, a.z - b.z) < (a.coreRadius + b.coreRadius) * 1.6;
  }

  private interact(dt: number): void {
    const list = this.devils;
    // Pair encounters in stable (id) order for determinism.
    for (let i = 0; i < list.length; i++) {
      const a = list[i]!;
      if (a.state !== "free") continue;
      for (let j = i + 1; j < list.length; j++) {
        const b = list[j]!;
        if (b.state !== "free" || a.state !== "free") continue;
        if (!DustDevilField.touching(a, b)) continue;
        const big = a.coreRadius >= b.coreRadius ? a : b;
        const small = big === a ? b : a;
        if (big.coreRadius >= small.coreRadius * DEVIL_BIG_RATIO) {
          if (this.rng.nextFloat() < this.rules.bigConsumes) this.absorb(big, small, "consumed");
          else this.startOrbit(small, big, false);
        } else if (a.coreRadius < DEVIL_SMALL_CORE && b.coreRadius < DEVIL_SMALL_CORE) {
          if (this.rng.nextFloat() < this.rules.smallMerge) this.absorb(big, small, "merged");
          else this.startOrbit(a, b, true);
        }
        // Two similar large devils just pass through each other.
      }
    }
    // Advance orbits and resolve outcomes.
    for (const d of list) {
      const o = d.orbit;
      if (!o || d.state !== "orbiting") continue;
      const other = this.byId(o.otherId);
      if (!other || other.state === "dying") {
        // Host or partner vanished: fly free again.
        d.state = "free";
        d.orbit = null;
        continue;
      }
      if (o.mutual && o.timer === Infinity) continue; // the partner carries the shared orbit
      o.timer -= dt;
      o.angle += o.rate * dt;
      if (o.mutual) {
        const mx = (d.x + other.x) / 2;
        const mz = (d.z + other.z) / 2;
        o.radius = Math.max(1.2, o.radius - dt * 0.15); // spiral in slowly
        d.x = mx + Math.cos(o.angle) * o.radius;
        d.z = mz + Math.sin(o.angle) * o.radius;
        other.x = mx - Math.cos(o.angle) * o.radius;
        other.z = mz - Math.sin(o.angle) * o.radius;
      } else {
        d.x = other.x + Math.cos(o.angle) * o.radius;
        d.z = other.z + Math.sin(o.angle) * o.radius;
      }
      d.vx = other.vx;
      d.vz = other.vz;
      if (o.timer > 0) continue;
      if (!o.mutual) {
        if (o.outcome === "consume") this.absorb(other, d, "consumed");
        else this.end(d, "orbit-died");
        continue;
      }
      const big = d.coreRadius >= other.coreRadius ? d : other;
      const small = big === d ? other : d;
      if (o.outcome === "combine") {
        this.absorb(big, small, "merged");
        big.state = "free";
        big.orbit = null;
      } else if (o.outcome === "separate") {
        for (const [p, s] of [[d, 1], [other, -1]] as const) {
          p.state = "free";
          p.orbit = null;
          // Fling apart along the orbit radius so they do not re-touch immediately.
          p.vx += Math.cos(o.angle) * 4 * s;
          p.vz += Math.sin(o.angle) * 4 * s;
          p.x += Math.cos(o.angle) * (p.coreRadius * 2) * s;
          p.z += Math.sin(o.angle) * (p.coreRadius * 2) * s;
        }
      } else if (o.outcome === "one-dies") {
        this.end(small, "orbit-died");
        big.state = "free";
        big.orbit = null;
      } else {
        this.end(d, "orbit-died");
        this.end(other, "orbit-died");
      }
    }
  }

  step(dt: number, intensity: number, windX: number, windZ: number, roverX: number, roverZ: number): void {
    const slots = this.activeSlots(intensity);
    for (let i = this.devils.length - 1; i >= 0; i--) {
      const d = this.devils[i]!;
      d.age += dt;
      const far = Math.hypot(d.x - roverX, d.z - roverZ) > 260;
      if (far && d.state !== "dying") {
        // Out of sight: drop at once (no one sees a pop 260 m away in the storm).
        this.ended.far++;
        this.devils.splice(i, 1);
        continue;
      }
      if (d.age >= d.life) {
        if (d.state !== "dying") this.ended.expired++;
        this.devils.splice(i, 1);
      }
    }
    while (this.liveCount() < slots) {
      const slot = this.freeSlot();
      if (slot < 0) break;
      this.devils.push(this.spawn(roverX, roverZ, windX, windZ, slot));
    }
    for (const d of this.devils) {
      // Ease width growth (and the outer radius with it) so a consuming devil swells smoothly.
      if (d.targetCore !== d.coreRadius) {
        const next = d.coreRadius + (d.targetCore - d.coreRadius) * Math.min(1, dt * 0.8);
        d.outerRadius *= next / d.coreRadius;
        d.coreRadius = Math.abs(d.targetCore - next) < 1e-3 ? d.targetCore : next;
      }
      if (d.state === "dying" && d.orbit) {
        // Consumed: dragged into the absorber while it fades.
        const host = this.byId(d.orbit.otherId);
        if (host) {
          const k = Math.min(1, dt * 2);
          d.x += (host.x - d.x) * k;
          d.z += (host.z - d.z) * k;
          continue;
        }
      }
      if (d.state === "orbiting") continue;
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
    this.interact(dt);
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
    // Wide devils carry a stronger swirl (devilSizeFactor), so they lift harder too.
    const strength = Math.min(1.5, Math.abs(devil.swirl) / DEVIL_SWIRL_MAX);
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
export const DEVIL_FUNNEL_HEIGHT_PER_CORE = 6;
/** Column height floor (m): red-frontier columns are 48–84 m tall whatever their width (fe-21). */
export const DEVIL_FUNNEL_HEIGHT_BASE = 36;
/** Full-grown funnel height (m) for a core radius: 48 m for the narrowest, ~78 m for the widest spawns. */
export function devilFunnelHeight(coreRadius: number): number {
  return DEVIL_FUNNEL_HEIGHT_BASE + coreRadius * DEVIL_FUNNEL_HEIGHT_PER_CORE;
}
// ---------------------------------------------------------------- red-frontier vortex (fe-21)
//
// Ported from iant89/red-frontier `src/render/particles/effects.ts` (`DustDevil`): the funnel
// profile `0.3 + 1.7 h^0.9` with a breathing bulge, a top that wobbles on two incommensurate sines
// while the base stays planted (clamped to 1.7 footprints), a column that grows up out of the
// ground over ~3 s at birth, and a diameter that thins toward a thread as the devil dies.

/** red-frontier footprint radius `baseR` per metre of Forge core radius (its 2.7–5.8 m → our 2–9 m cores). */
export const DEVIL_RF_BASE_PER_CORE = 0.9;
/** Seconds for a newborn column to climb to full height (red-frontier `growth`, 3.1 s). */
export const DEVIL_GROW_TIME = 3.1;
/**
 * fe-22: the swirl column's radius as a fraction of fe-21's, so the particle
 * swarm wraps (skirt and base cloud keep their fe-21 width) tightly around the restored old-devil core instead of a wide hollow tube.
 */
export const DEVIL_SWIRL_RADIUS_SCALE = 0.55;
/**
 * fe-22c: the swarm's on-screen width is NOT set by where grains spawn. The swirl module's 1/r
 * tangential push (terminal speed ≈ S/(drag·r)) flings grains out until centrifugal v²/r balances
 * the axis spring k·r, i.e. r⁴ ≈ (S/drag)²/k — about 6–7 m for fe-21's S=60, k=5, whatever the
 * emit radius. Width ∝ √S / k^¼, so S×0.55 and k×0.55⁻² give ≈0.55× the radial spread.
 */
export const DEVIL_SWIRL_ACCEL_FE21 = 60;
export const DEVIL_AXIS_PULL_FE21 = 5;
export const DEVIL_SWIRL_ACCEL = DEVIL_SWIRL_ACCEL_FE21 * DEVIL_SWIRL_RADIUS_SCALE;
export const DEVIL_AXIS_PULL = DEVIL_AXIS_PULL_FE21 / (DEVIL_SWIRL_RADIUS_SCALE * DEVIL_SWIRL_RADIUS_SCALE);

function devilHash(id: number, k: number): number {
  const x = Math.sin(id * 12.9898 + k * 78.233) * 43758.5453;
  return x - Math.floor(x);
}

/**
 * Axis offset (m) at height `u` 0..1 and time `t` (red-frontier `axisAt`): zero at the ground,
 * leaning as `u^1.25` toward a top that wobbles on two incommensurate sines per devil, its
 * amplitude capped at 1.7 footprints so the crown never tears loose from the lower vortex.
 */
export function devilFunnelSway(devil: Pick<DustDevil, "id" | "coreRadius">, u: number, t: number, out: { x: number; z: number } = { x: 0, z: 0 }): { x: number; z: number } {
  const id = devil.id;
  const wobA = devilHash(id, 1) * Math.PI * 2;
  const wobB = devilHash(id, 2) * Math.PI * 2;
  const f1 = 0.5 + devilHash(id, 3) * 0.4;
  const f2 = 1.1 + devilHash(id, 4) * 0.7;
  const baseR = devil.coreRadius * DEVIL_RF_BASE_PER_CORE;
  const amp = baseR * (0.75 + 0.35 * Math.sin(t * 0.21 + wobB));
  let ox = Math.sin(t * f1 + wobA) * amp + Math.sin(t * f2 + wobB) * amp * 0.45;
  let oz = Math.cos(t * f1 * 0.83 + wobB) * amp + Math.cos(t * f2 + wobA) * amp * 0.45;
  const mag = Math.hypot(ox, oz);
  const cap = baseR * 1.7;
  if (mag > cap) {
    ox *= cap / mag;
    oz *= cap / mag;
  }
  const lean = Math.pow(Math.max(0, Math.min(1, u)), 1.25);
  out.x = ox * lean;
  out.z = oz * lean;
  return out;
}

/**
 * Lifecycle shape (red-frontier birth/death): `growth` 0..1 climbs (smoothstep) over
 * {@link DEVIL_GROW_TIME} so the column rises out of the ground; `radiusScale` follows the life
 * envelope (0.3..1) so a dying or consumed devil thins to a thread instead of holding its girth.
 */
export function devilVortexLife(devil: Pick<DustDevil, "age" | "life"> & Partial<Pick<DustDevil, "fadeOut">>): { growth: number; radiusScale: number } {
  const g = Math.max(0, Math.min(1, devil.age / DEVIL_GROW_TIME));
  return { growth: Math.max(0.06, g * g * (3 - 2 * g)), radiusScale: 0.3 + 0.7 * devilEnvelope(devil) };
}

export interface DevilParticleLook {
  /** Column (true) or ground (skirt / base cloud, false) emission frame. */
  column: boolean;
  /** fe-21d: this frame feeds the slow, low base dust cloud (wind-stretched via `groundWind`). */
  base: boolean;
  vortex: { height: number; bias: number; radiusBase: number; radiusTop: number; spin: number; outward: number; leanX: number; leanZ: number };
  speedMin: number;
  speedMax: number;
  lifeMin: number;
  lifeMax: number;
  axisPull: number;
  axisHeight: number;
  leanX: number;
  leanZ: number;
  swirl: number;
  sizeStart: number;
  sizeEnd: number;
}

/**
 * Emitter frame cycle: frame 0 skirt, frame 1 base cloud (fe-21d), the rest column. Per-second
 * weights below keep the live count inside one devil's capacity (see {@link devilEmitRate}).
 */
export const DEVIL_EMIT_CYCLE = 5;
export const DEVIL_SKIRT_FRAMES = 1;
export const DEVIL_BASE_FRAMES = 1;
/**
 * Spawn weights out of {@link DEVIL_WEIGHT_TOTAL} (red-frontier's 420/s). fe-21f: the longer-lived
 * base cloud is paid for by trimming the column (300 → 210), keeping live counts inside capacity.
 */
export const DEVIL_WEIGHT_TOTAL = 420;
export const DEVIL_COLUMN_WEIGHT = 210;
export const DEVIL_SKIRT_WEIGHT = 80;
export const DEVIL_BASE_WEIGHT = 84;
/** Base cloud: wide, low, slow-swirling skirt of dust around the devil's foot (fe-21d). */
export const DEVIL_BASE_CLOUD = Object.freeze({
  height: 1.6,
  radiusBase: 0.9,
  radiusTop: 1.8,
  spinFactor: 0.22,
  outward: 1.2,
  speedMin: 0.25,
  speedMax: 0.8,
  lifeMin: 2.0,
  lifeMax: 3.0,
  /** Height band (m) where `groundWind` acts and the axis spring relaxes. */
  windHeight: 3.0,
});
/** Ground-wind acceleration per m/s of storm wind: a lull floor plus a gust boost. */
export const DEVIL_BASE_WIND_LULL = 0.12;
export const DEVIL_BASE_WIND_GUST = 0.6;

/**
 * fe-21d: horizontal acceleration (m/s²) pushing a devil's base cloud downwind. Rises with the gust
 * share of `intensity` (0 at {@link LULL_INTENSITY}, 1 at the peak), so strong gusts smear the cloud
 * into a downwind tail while lulls barely nudge it.
 */
export function devilBaseWind(windX: number, windZ: number, intensity: number, out: { x: number; z: number } = { x: 0, z: 0 }): { x: number; z: number } {
  const gust = Math.max(0, Math.min(1, (intensity - LULL_INTENSITY) / (1 - LULL_INTENSITY)));
  const k = DEVIL_BASE_WIND_LULL + DEVIL_BASE_WIND_GUST * gust;
  out.x = windX * k;
  out.z = windZ * k;
  return out;
}
/** Devil swarm grain colour, LINEAR (sRGB #6b3d24 dark rust lifted soil; `colorAlt` blends it toward the rock tone per grain). */
export const DEVIL_SWARM_COLOR = Object.freeze({ r: 0.147, g: 0.047, b: 0.018, a: 1 });
/**
 * Darker rock tone the per-grain colour variation blends toward (linear of sRGB #4a3226). Particle
 * colours are LINEAR HDR values drawn unlit, then lifted by exposure 1.25, ACES and sRGB encoding —
 * so the old sRGB-looking 0.5/0.31/0.2 came out pale beige (fe-21b).
 */
export const DEVIL_SWARM_ROCK = Object.freeze({ r: 0.069, g: 0.032, b: 0.019, a: 1 });
/** Fixed sim modules for devil dust (shared by column and skirt particles of one system). */
export const DEVIL_DUST_GRAVITY = -0.3;
export const DEVIL_DUST_DRAG = 0.6;
/** Seconds of red-frontier's birth ground-burst (skirt-only, boosted) at the start of a devil's life. */
export const DEVIL_BURST_TIME = 0.5;

/**
 * Per-devil, per-frame emitter shape (red-frontier `emitColumn` / `emitSkirt` / `burstGround`).
 * One GPU system per devil alternates frames: column frames spawn up a height-biased (`rand^1.35`),
 * flaring, leaning ring with a tangential rim speed and an updraft that weakens with height, and a
 * horizontal spring holds them on the leaning axis; skirt frames spawn a wide low ring blasting
 * outward. Particle sizes stay Forge's fine grain (fe-18), not red-frontier's 2–6 m sprites.
 */
export function devilParticleLook(
  devil: Pick<DustDevil, "id" | "coreRadius" | "swirl"> & Partial<Pick<DustDevil, "age" | "life" | "fadeOut">>,
  t = 0,
  frame = 0,
  out?: DevilParticleLook,
): DevilParticleLook {
  const life = devilVortexLife({ age: devil.age ?? 1e3, life: devil.life ?? 2e3, fadeOut: devil.fadeOut });
  const fullHeight = devilFunnelHeight(devil.coreRadius);
  const height = fullHeight * life.growth;
  const baseR = devil.coreRadius * DEVIL_RF_BASE_PER_CORE * life.radiusScale;
  const colR = baseR * DEVIL_SWIRL_RADIUS_SCALE;
  const top = devilFunnelSway(devil, 1, t);
  const dir = Math.sign(devil.swirl || 1);
  const bursting = (devil.age ?? 1e3) < DEVIL_BURST_TIME;
  const slot = frame % DEVIL_EMIT_CYCLE;
  const column = !bursting && slot >= DEVIL_SKIRT_FRAMES + DEVIL_BASE_FRAMES;
  const base = !bursting && !column && slot >= DEVIL_SKIRT_FRAMES;
  const spin = 2.6 + devilHash(devil.id, 6) * 1.4;
  const o: DevilParticleLook = out ?? {
    column,
    base,
    vortex: { height: 0, bias: 1, radiusBase: 0, radiusTop: 0, spin: 0, outward: 0, leanX: 0, leanZ: 0 },
    speedMin: 0, speedMax: 0, lifeMin: 0, lifeMax: 0, axisPull: 0, axisHeight: 1, leanX: 0, leanZ: 0, swirl: 0, sizeStart: 0, sizeEnd: 0,
  };
  const v = o.vortex;
  o.column = column;
  o.base = base;
  o.axisPull = DEVIL_AXIS_PULL;
  o.axisHeight = Math.max(1, height);
  o.leanX = top.x;
  o.leanZ = top.z;
  o.swirl = dir * DEVIL_SWIRL_ACCEL;
  // Fine grain (fe-21b): many small motes read as dense dust, not big flakes.
  o.sizeStart = DEVIL_GRAIN_START;
  o.sizeEnd = DEVIL_GRAIN_END;
  if (column) {
    v.height = height; v.bias = 1.35; v.radiusBase = colR * 0.35; v.radiusTop = colR * 1.1;
    v.spin = dir * spin * 0.6; v.outward = 0; v.leanX = top.x; v.leanZ = top.z;
    o.speedMin = 5.5; o.speedMax = 11.3; o.lifeMin = 0.95; o.lifeMax = 1.7;
  } else if (base) {
    // Base cloud: short, wide, slowly turning dust around the foot; the scene's groundWind drags it.
    const b = DEVIL_BASE_CLOUD;
    v.height = b.height; v.bias = 1.6; v.radiusBase = baseR * b.radiusBase; v.radiusTop = baseR * b.radiusTop;
    v.spin = dir * spin * b.spinFactor; v.outward = b.outward; v.leanX = 0; v.leanZ = 0;
    o.speedMin = b.speedMin; o.speedMax = b.speedMax; o.lifeMin = b.lifeMin; o.lifeMax = b.lifeMax;
  } else {
    // Skirt: a wide ring hugging the ground, thrown outward.
    v.height = 1.2; v.bias = 1; v.radiusBase = baseR * 1.2; v.radiusTop = baseR * 2.4;
    v.spin = 0; v.outward = bursting ? 6 : 8; v.leanX = 0; v.leanZ = 0;
    o.speedMin = bursting ? 1.4 : 0.9; o.speedMax = bursting ? 4 : 2.3; o.lifeMin = 0.55; o.lifeMax = bursting ? 1.4 : 1;
  }
  return o;
}

/** Devil grain size over life (m). fe-21g: ~1.7× larger to offset the soft sprite falloff. */
export const DEVIL_GRAIN_START = 0.2;
export const DEVIL_GRAIN_END = 0.5;
/**
 * fe-21c: bimodal grain mix — this share of devil grains is drawn {@link DEVIL_COARSE_SCALE}× larger
 * to fill the voids between fine motes (same particle count, so budgets are unchanged).
 */
export const DEVIL_COARSE_FRACTION = 0.2;
/** fe-21d: more coarse grains but a smaller multiplier, so the largest (end-of-life) stays ≈0.9 m, not a blob. */
export const DEVIL_COARSE_SCALE = 2.2;
/** Mild per-grain size spread so the fine layer isn't uniform. */
export const DEVIL_SIZE_VARIATION = 0.35;

/** Emission rate multiplier for a frame of {@link devilParticleLook}: keeps the per-second mix (and the burst) right. */
export function devilEmitRate(baseRate: number, look: Pick<DevilParticleLook, "column"> & Partial<Pick<DevilParticleLook, "base">>, envelope: number, bursting: boolean): number {
  if (bursting) return baseRate * 0.6;
  const vigour = Math.pow(Math.max(0, envelope), 1.15) * (0.3 + 0.7 * envelope);
  // Per-second weights (red-frontier column/skirt plus the fe-21d base cloud), corrected for how
  // many frames of the cycle each kind owns.
  const total = DEVIL_WEIGHT_TOTAL;
  const columnFrames = DEVIL_EMIT_CYCLE - DEVIL_SKIRT_FRAMES - DEVIL_BASE_FRAMES;
  const share = look.column
    ? (DEVIL_COLUMN_WEIGHT / total) * (DEVIL_EMIT_CYCLE / columnFrames)
    : look.base
      ? (DEVIL_BASE_WEIGHT / total) * (DEVIL_EMIT_CYCLE / DEVIL_BASE_FRAMES)
      : (DEVIL_SKIRT_WEIGHT / total) * (DEVIL_EMIT_CYCLE / DEVIL_SKIRT_FRAMES);
  return Math.min(baseRate, baseRate * vigour * share);
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

// ---------------------------------------------------------------- dust palette + devil look (fe-19)

type Rgba = { r: number; g: number; b: number; a: number };
/**
 * Grain colours sampled from the scene's own palette (same space as the particle tints): the
 * terrain/drift dust (0xc08050 family) as the base and the boulders (0x7a5040) as the alternate.
 * Each particle blends a stable random amount toward the rock tone plus a brightness jitter.
 */
export const STORM_DUST_PALETTE: Readonly<{ dust: Rgba; rock: Rgba; sheetVariation: number; devilVariation: number }> = Object.freeze({
  dust: Object.freeze({ r: 0.78, g: 0.48, b: 0.28, a: 1 }),
  rock: Object.freeze({ r: 0.46, g: 0.29, b: 0.22, a: 1 }),
  sheetVariation: 0.6,
  devilVariation: 0.85,
});

// ---------------------------------------------------------------- old-devil core (fe-22)
//
// fe-22: the fe-18/fe-19 funnel cards come back as an inner core, wrapped by the narrower fe-21 swirl.

/** Funnel radius at the ground and the top, as fractions of the core radius. */
export const DEVIL_FUNNEL_BASE = 0.32;
export const DEVIL_FUNNEL_WAIST = 0.26;
export const DEVIL_FUNNEL_TOP = 0.62;

/**
 * Funnel radius (as a fraction of the core radius) at normalized height `u` 0..1: pinched just above
 * the skirt, narrow for most of the column, widening slightly toward the top (the reference image).
 */
export function devilFunnelProfile(u: number): number {
  const x = Math.max(0, Math.min(1, u));
  if (x < 0.12) return DEVIL_FUNNEL_BASE + (DEVIL_FUNNEL_WAIST - DEVIL_FUNNEL_BASE) * smooth(x / 0.12);
  return DEVIL_FUNNEL_WAIST + (DEVIL_FUNNEL_TOP - DEVIL_FUNNEL_WAIST) * Math.pow((x - 0.12) / 0.88, 1.6);
}


/** Rings up a core card. */
export const FUNNEL_RINGS = 14;
export interface FunnelMesh { positions: Float32Array; normals: Float32Array; uvs: Float32Array; indices: Uint16Array }
// ---------------------------------------------------------------- soft funnel cards (fe-18 captain: soften)

/**
 * Near-camera dissolve for the funnel impostors: 0 within `DEVIL_FADE_NEAR` m of the devil's axis
 * (fe-22: inside the wrapping swirl the core stays visible much closer than the fe-18 10–45 m), 1 beyond `DEVIL_FADE_FAR`.
 */
export const DEVIL_FADE_NEAR = 4;
export const DEVIL_FADE_FAR = 20;
export function devilShellFade(distance: number): number {
  return smooth((distance - DEVIL_FADE_NEAR) / (DEVIL_FADE_FAR - DEVIL_FADE_NEAR));
}

/** Columns across a funnel card: left edge, core, right edge (uv.x 0, 0.5, 1). */
export const CARD_COLUMNS = 3;
export const CARD_VERTEX_COUNT = FUNNEL_RINGS * CARD_COLUMNS;

function cardIndices(): Uint16Array {
  const idx: number[] = [];
  for (let k = 0; k < FUNNEL_RINGS - 1; k++) {
    for (let c = 0; c < CARD_COLUMNS - 1; c++) {
      const a = k * CARD_COLUMNS + c;
      idx.push(a, a + 1, a + 1 + CARD_COLUMNS, a, a + 1 + CARD_COLUMNS, a + CARD_COLUMNS);
    }
  }
  return new Uint16Array(idx);
}
const CARD_INDICES = cardIndices();

/**
 * A camera-facing funnel card: each ring becomes a horizontal span perpendicular to the view, as wide
 * as the swaying funnel profile, so the soft-edged texture gives a view-angle falloff (thin wispy
 * edges, dense core) like a fresnel fade, at one quad strip per layer. `vScroll` scrolls the
 * turbulence texture upward over time. Positions are relative to the devil's ground point.
 */
export function buildFunnelCard(
  devil: Pick<DustDevil, "id" | "coreRadius" | "swirl" | "x" | "z">,
  height: number,
  widthScale: number,
  t: number,
  camX: number,
  camZ: number,
  vScroll: number,
  out?: FunnelMesh,
): FunnelMesh {
  const mesh: FunnelMesh = out ?? {
    positions: new Float32Array(CARD_VERTEX_COUNT * 3),
    normals: new Float32Array(CARD_VERTEX_COUNT * 3),
    uvs: new Float32Array(CARD_VERTEX_COUNT * 2),
    indices: CARD_INDICES,
  };
  let tx = camX - devil.x;
  let tz = camZ - devil.z;
  const tl = Math.hypot(tx, tz) || 1;
  tx /= tl;
  tz /= tl;
  // Right vector across the view (horizontal, perpendicular to the camera direction).
  const rx = -tz;
  const rz = tx;
  const sway = { x: 0, z: 0 };
  for (let k = 0; k < FUNNEL_RINGS; k++) {
    const u = k / (FUNNEL_RINGS - 1);
    devilFunnelSway(devil, u, t, sway);
    // Breathing lumps advected upward break up the silhouette.
    const lump = 1 + 0.22 * Math.sin(u * 11 - t * 2.3 + devil.id) + 0.12 * Math.sin(u * 23 + t * 3.1);
    const half = devilFunnelProfile(u) * devil.coreRadius * widthScale * lump;
    for (let c = 0; c < CARD_COLUMNS; c++) {
      const s = (c / (CARD_COLUMNS - 1)) * 2 - 1;
      const i = k * CARD_COLUMNS + c;
      mesh.positions[i * 3] = sway.x + rx * half * s;
      mesh.positions[i * 3 + 1] = u * height;
      mesh.positions[i * 3 + 2] = sway.z + rz * half * s;
      mesh.normals[i * 3] = tx;
      mesh.normals[i * 3 + 1] = 0;
      mesh.normals[i * 3 + 2] = tz;
      mesh.uvs[i * 2] = c / (CARD_COLUMNS - 1);
      mesh.uvs[i * 2 + 1] = u * 2.5 - vScroll;
    }
  }
  return mesh;
}

/**
 * RGBA8 pixels for the funnel card texture: alpha falls off smoothly to 0 at both side edges
 * (the view-angle fade), is densest at the core, and is broken up by streaky turbulence that
 * tiles vertically (the card scrolls it upward). Colour darkens toward the core.
 */
export function devilCardPixels(width = 64, height = 128, seed = 7): Uint8Array {
  const px = new Uint8Array(width * height * 4);
  const rng = new Rng(seed);
  const ph = Array.from({ length: 6 }, () => rng.nextFloat() * Math.PI * 2);
  for (let y = 0; y < height; y++) {
    const v = y / height;
    for (let x = 0; x < width; x++) {
      const u = (x + 0.5) / width;
      const across = Math.sin(Math.PI * u); // 0 at edges, 1 at core
      const edge = Math.pow(across, 1.1); // fe-22: fuller core, still soft at the side edges
      // Tileable in v: integer frequencies of 2π v.
      const w = 2 * Math.PI * v;
      const n =
        0.5 +
        0.28 * Math.sin(w * 2 + u * 7 + ph[0]!) +
        0.16 * Math.sin(w * 3 - u * 13 + ph[1]!);
      // fe-22: only low vertical frequencies; the old 7/13/23-per-tile terms stretched over a
      // 50–80 m column aliased into horizontal "ladder" rungs.
      const wisp = Math.max(0, Math.min(1, n));
      const a = edge * (0.65 + 0.35 * wisp);
      const dark = 0.55 + 0.45 * (1 - across);
      const i = (y * width + x) * 4;
      px[i] = Math.round(107 * dark);
      px[i + 1] = Math.round(61 * dark);
      px[i + 2] = Math.round(36 * dark);
      px[i + 3] = Math.round(255 * Math.max(0, Math.min(1, a)));
    }
  }
  return px;
}

/**
 * Card opacity for a devil: base layer opacity × its own density × life envelope × near-camera
 * dissolve, with only a light storm-intensity dimming.
 */
export function devilCardOpacity(base: number, devil: Pick<DustDevil, "opacity" | "age" | "life" | "fadeOut">, fade: number, intensity: number): number {
  return Math.min(1, base * devil.opacity * devilEnvelope(devil) * fade * (0.85 + 0.15 * intensity));
}

/**
 * fe-22: width scales (× {@link devilFunnelProfile} × core radius) of the two old-devil core cards.
 * The dense card sits well inside the swirl column; the wispy one stays within the swirl's radius
 * (fe-22 tune: the first 0.8/1.5 cards poked out of the swirl as pale flat bands).
 */
export const DEVIL_CORE_CARD_WIDTH = Object.freeze({ core: 0.5, outer: 0.65 });
/** Half-width (m) of a core card at height `u`, before its turbulence lumps. */
/** fe-22: core card opacities (denser than fe-19's 0.85/0.45 cards so the inner funnel reads dark). */
export const DEVIL_CORE_OPACITY = Object.freeze({ core: 1, outer: 0.7 });
export function devilCoreCardHalfWidth(coreRadius: number, u: number, widthScale: number): number {
  return devilFunnelProfile(u) * coreRadius * widthScale;
}

/**
 * fe-22c: CPU replica of the GPU integrator for a devil's column grains (vortex spawn, gravity,
 * swirl, ground-wind band weight on the spring, axis spring, drag; no lean, no turbulence), used to
 * measure the steady-state horizontal spread. Returns the median and 90th-percentile radius (m) of
 * live column grains above the ground band.
 */
export function devilColumnSpread(
  devil: Pick<DustDevil, "id" | "coreRadius" | "swirl">,
  opts: { swirlAccel?: number; axisPull?: number; radiusScale?: number; seconds?: number } = {},
): { p50: number; p90: number } {
  const S = opts.swirlAccel ?? DEVIL_SWIRL_ACCEL;
  const k = opts.axisPull ?? DEVIL_AXIS_PULL;
  const look = devilParticleLook({ ...devil, age: 100, life: 1000, fadeOut: DEVIL_FADE }, 0, DEVIL_SKIRT_FRAMES + DEVIL_BASE_FRAMES);
  const rs = (opts.radiusScale ?? DEVIL_SWIRL_RADIUS_SCALE) / DEVIL_SWIRL_RADIUS_SCALE;
  const v = look.vortex;
  const rng = new Rng(4242 + devil.id);
  const dt = 1 / 60;
  const ps: { x: number; y: number; z: number; vx: number; vy: number; vz: number; life: number }[] = [];
  const radii: number[] = [];
  const steps = Math.round((opts.seconds ?? 6) * 60);
  const dir = Math.sign(devil.swirl || 1);
  for (let n = 0; n < steps; n++) {
    for (let e = 0; e < 20; e++) {
      const h01 = Math.pow(Math.max(rng.nextFloat(), 1e-4), v.bias);
      const spread = 0.72 + 0.55 * rng.nextFloat();
      const r = (v.radiusBase + (v.radiusTop - v.radiusBase) * Math.pow(Math.max(h01, 1e-4), 0.9)) * spread * rs;
      const a = rng.nextFloat() * Math.PI * 2, ca = Math.cos(a), sa = Math.sin(a);
      const rim = v.spin * r;
      const up = (look.speedMin + (look.speedMax - look.speedMin) * rng.nextFloat()) * (1 - 0.42 * h01);
      ps.push({ x: ca * r, y: h01 * v.height, z: sa * r, vx: -sa * rim + ca * v.outward, vy: up, vz: ca * rim + sa * v.outward, life: look.lifeMin + (look.lifeMax - look.lifeMin) * rng.nextFloat() });
    }
    for (let i = ps.length - 1; i >= 0; i--) {
      const p = ps[i]!;
      p.vy += DEVIL_DUST_GRAVITY * dt;
      const rr = Math.max(Math.hypot(p.x, p.z), 0.5);
      // tangent (toA.z, -toA.x)/r with toA = -p
      p.vx += (-p.z / rr) * (dir * S * dt / rr);
      p.vz += (p.x / rr) * (dir * S * dt / rr);
      const gw = 1 - smooth(Math.max(0, Math.min(1, p.y / DEVIL_BASE_CLOUD.windHeight)));
      p.vx += -p.x * k * (1 - 0.7 * gw) * dt;
      p.vz += -p.z * k * (1 - 0.7 * gw) * dt;
      const damp = Math.max(0, 1 - DEVIL_DUST_DRAG * dt);
      p.vx *= damp; p.vy *= damp; p.vz *= damp;
      p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
      p.life -= dt;
      if (p.life <= 0) { ps.splice(i, 1); continue; }
      if (n > 120 && n % 10 === 0 && p.y > DEVIL_BASE_CLOUD.windHeight) radii.push(Math.hypot(p.x, p.z));
    }
  }
  radii.sort((a, b) => a - b);
  return { p50: radii[Math.floor(radii.length * 0.5)] ?? 0, p90: radii[Math.floor(radii.length * 0.9)] ?? 0 };
}
