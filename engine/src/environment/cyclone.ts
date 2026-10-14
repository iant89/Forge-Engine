/**
 * Tropical cyclones (fe-33): a scriptable hurricane wind/rain/cloud field and the scene driver.
 *
 * A scene scripts a storm as a {@link CycloneTrack}: keyframes in seconds giving the centre's
 * position, maximum sustained wind, radius of maximum wind (the eyewall), eye radius, rain
 * intensity and surge. Everything physical is derived here, so a different scene can script a
 * different storm (a fish storm that never lands, a weakening Cat 1, a southern-hemisphere
 * cyclone) with keyframes alone:
 *
 * - {@link cycloneWindAt} — a modified Rankine/Holland vortex: a near-calm eye, a steep eyewall
 *   ramp to `maxWind` at `radiusMaxWind`, `(Rm/r)^decay` fall-off outside, 20° frictional inflow,
 *   cyclonic rotation (counter-clockwise for `hemisphere: 1`) and half the translation speed added
 *   (the "dangerous semicircle").
 * - {@link cycloneRainAt} — eyewall ring + logarithmic spiral rainbands, dry eye.
 * - {@link cycloneCoverAt} — cloud cover: overcast core, a clear eye, bands thinning outward.
 * - {@link cyclonePhaseAt} — where an observer is: `clear`, `outer-bands`, `rainbands`,
 *   `eyewall`, `eye`.
 * - {@link saffirSimpsonCategory} — 1-minute sustained wind → TD / TS / Cat 1–5.
 * - {@link CycloneSystem} — a `SceneObject` that runs the track on the fixed-step clock and drives
 *   the scene at an observer point: clouds (cover, density, deck wind), fog, the ocean
 *   (`oceanWavesFromWind`, swell radiating from the storm, choppiness, whitecaps) and storm surge.
 *   The light factors and rain rate are exposed for the host's sun/rain field.
 *
 * Depends on `scene`, `math`, `core` and environment siblings only.
 */

import { SceneObject, type Scene } from "../scene/scene.js";
import { Color } from "../math/color.js";
import type { SystemContext } from "../scene/systems.js";
import { clamp } from "../math/scalar.js";
import { approachExponential, stormLightFactors } from "./weather.js";
import { applyOceanState, oceanWavesFromWind, type OceanState } from "./ocean.js";

/** One scripted moment of a storm. Values interpolate linearly between keyframes. */
export interface CycloneKeyframe {
  /** Seconds on the cyclone clock. */
  time: number;
  /** Centre position (world XZ, metres). */
  x: number;
  z: number;
  /** Maximum 1-minute sustained wind, m/s. */
  maxWind: number;
  /** Radius of maximum wind (eyewall), metres. */
  radiusMaxWind: number;
  /** Radius of the calm eye, metres (< radiusMaxWind). */
  eyeRadius: number;
  /** Rain intensity 0..1 at the eyewall (bands scale from it). */
  rain: number;
  /** Peak storm surge (m) under the eyewall. Default 0. */
  surge?: number;
}

export interface CycloneState {
  time: number;
  x: number;
  z: number;
  maxWind: number;
  radiusMaxWind: number;
  eyeRadius: number;
  rain: number;
  surge: number;
  /** Translation velocity of the centre (m/s on the cyclone clock). */
  velocityX: number;
  velocityZ: number;
}

export function createCycloneState(): CycloneState {
  return { time: 0, x: 0, z: 0, maxWind: 0, radiusMaxWind: 1, eyeRadius: 0, rain: 0, surge: 0, velocityX: 0, velocityZ: 0 };
}

/** A storm script: keyframes sorted by time; clamps at both ends. */
export class CycloneTrack {
  readonly keys: readonly CycloneKeyframe[];

  constructor(keys: readonly CycloneKeyframe[]) {
    if (keys.length === 0) throw new Error("CycloneTrack needs at least one keyframe");
    this.keys = [...keys].sort((a, b) => a.time - b.time);
  }

  get duration(): number {
    return this.keys[this.keys.length - 1]!.time;
  }

  sample(t: number, out: CycloneState = createCycloneState()): CycloneState {
    const keys = this.keys;
    let i = 0;
    while (i < keys.length - 1 && keys[i + 1]!.time <= t) i++;
    const a = keys[i]!;
    const b = keys[Math.min(i + 1, keys.length - 1)]!;
    const span = b.time - a.time;
    const u = span > 0 ? clamp((t - a.time) / span, 0, 1) : 0;
    const lerp = (p: number, q: number): number => p + (q - p) * u;
    out.time = t;
    out.x = lerp(a.x, b.x);
    out.z = lerp(a.z, b.z);
    out.maxWind = lerp(a.maxWind, b.maxWind);
    out.radiusMaxWind = Math.max(1, lerp(a.radiusMaxWind, b.radiusMaxWind));
    out.eyeRadius = clamp(lerp(a.eyeRadius, b.eyeRadius), 0, out.radiusMaxWind * 0.95);
    out.rain = clamp(lerp(a.rain, b.rain), 0, 1);
    out.surge = lerp(a.surge ?? 0, b.surge ?? 0);
    const moving = span > 0 && t >= a.time && t <= b.time;
    out.velocityX = moving ? (b.x - a.x) / span : 0;
    out.velocityZ = moving ? (b.z - a.z) / span : 0;
    return out;
  }
}

/** Saffir–Simpson thresholds (1-minute sustained, m/s): TS ≥ 17.5, Cat 1 ≥ 33, … Cat 5 ≥ 70. */
export const SAFFIR_SIMPSON_MS = [17.5, 33, 42.7, 49.4, 58.1, 70] as const;

/** −1 depression, 0 tropical storm, 1..5 hurricane category. */
export function saffirSimpsonCategory(windMs: number): number {
  let c = -1;
  for (let i = 0; i < SAFFIR_SIMPSON_MS.length; i++) if (windMs >= SAFFIR_SIMPSON_MS[i]!) c = i;
  return c;
}

/** Human label for {@link saffirSimpsonCategory}. */
export function saffirSimpsonLabel(windMs: number): string {
  const c = saffirSimpsonCategory(windMs);
  if (c < 0) return "Tropical Depression";
  if (c === 0) return "Tropical Storm";
  return `Category ${c} Hurricane`;
}

export interface CycloneFieldOptions {
  /** 1 = northern hemisphere (counter-clockwise), −1 = southern. Default 1. */
  hemisphere?: number;
  /** Outer decay exponent of `(Rm/r)^decay`. Default 0.55. */
  decay?: number;
  /** Fraction of maxWind left in the middle of the eye. Default 0.08. */
  eyeCalm?: number;
  /** Frictional inflow angle (radians). Default 20°. */
  inflow?: number;
  /** Number of spiral rainbands. Default 3. */
  bands?: number;
  /**
   * Real seconds per track second when a scene compresses a storm's days into minutes (default 1).
   * The track's translation velocity is divided by it before the forward-motion term is added, so
   * a 2-minute demo track still has a realistic ~5 m/s forward speed in its wind field.
   */
  timeCompression?: number;
  /** Fraction of the forward speed added to the vortex. Default 0.5. */
  translation?: number;
}

export interface CycloneWind {
  x: number;
  z: number;
  speed: number;
}

/** Radial wind profile (m/s, before translation) at distance `r` from the centre. */
export function cycloneWindProfile(state: CycloneState, r: number, options: CycloneFieldOptions = {}): number {
  const rm = state.radiusMaxWind;
  const eye = state.eyeRadius;
  const calm = options.eyeCalm ?? 0.08;
  const decay = options.decay ?? 0.55;
  if (r >= rm) return state.maxWind * Math.pow(rm / Math.max(r, 1e-3), decay);
  if (r <= eye) return state.maxWind * calm * (eye > 0 ? r / eye : 1);
  const u = (r - eye) / Math.max(1e-3, rm - eye);
  const s = u * u * (3 - 2 * u);
  return state.maxWind * (calm + (1 - calm) * s);
}

/** Surface wind vector at a world XZ (see module doc). */
export function cycloneWindAt(state: CycloneState, x: number, z: number, options: CycloneFieldOptions = {}, out: CycloneWind = { x: 0, z: 0, speed: 0 }): CycloneWind {
  const dx = x - state.x;
  const dz = z - state.z;
  const r = Math.hypot(dx, dz);
  const v = cycloneWindProfile(state, r, options);
  const h = options.hemisphere ?? 1;
  const inflow = options.inflow ?? (20 * Math.PI) / 180;
  let wx = 0;
  let wz = 0;
  if (r > 1e-3) {
    const rx = dx / r;
    const rz = dz / r;
    // Tangent of a counter-clockwise (h = 1) rotation in the XZ plane, turned inward by `inflow`.
    const tx = -rz * h;
    const tz = rx * h;
    const c = Math.cos(inflow);
    const sn = Math.sin(inflow);
    wx = (tx * c - rx * sn) * v;
    wz = (tz * c - rz * sn) * v;
  }
  // Half the forward motion adds to the vortex (strongest on the right of track in the north).
  const forward = (options.translation ?? 0.5) / Math.max(1e-6, options.timeCompression ?? 1);
  wx += state.velocityX * forward;
  wz += state.velocityZ * forward;
  out.x = wx;
  out.z = wz;
  out.speed = Math.hypot(wx, wz);
  return out;
}

/** Spiral-band modulation 0..1 at a polar position (logarithmic spirals, `bands` arms). */
export function cycloneBandAt(state: CycloneState, x: number, z: number, options: CycloneFieldOptions = {}): number {
  const dx = x - state.x;
  const dz = z - state.z;
  const r = Math.hypot(dx, dz);
  if (r <= state.radiusMaxWind) return 0;
  const arms = options.bands ?? 3;
  const theta = Math.atan2(dz, dx) * (options.hemisphere ?? 1);
  // Pitch ~ 15°: θ grows by ln(r/Rm)/tan(15°) along an arm.
  const spiral = theta + Math.log(r / state.radiusMaxWind) / Math.tan((15 * Math.PI) / 180);
  const s = 0.5 + 0.5 * Math.cos(arms * spiral);
  return s * s;
}

/** Rain intensity 0..1 at a world XZ: dry eye, torrential eyewall, banded outskirts. */
export function cycloneRainAt(state: CycloneState, x: number, z: number, options: CycloneFieldOptions = {}): number {
  const r = Math.hypot(x - state.x, z - state.z);
  const rm = state.radiusMaxWind;
  if (r < state.eyeRadius) return 0;
  const wall = Math.exp(-Math.pow((r - rm) / (0.6 * rm), 2));
  const reach = Math.exp(-r / (10 * rm));
  const band = cycloneBandAt(state, x, z, options) * reach;
  return clamp(state.rain * Math.max(wall, 0.15 * reach + 0.85 * band), 0, 1);
}

/** Cloud cover 0..1: overcast core, open eye (`eyeCover`), bands thinning far out. */
export function cycloneCoverAt(state: CycloneState, x: number, z: number, eyeCover = 0.12, options: CycloneFieldOptions = {}): number {
  const r = Math.hypot(x - state.x, z - state.z);
  const rm = state.radiusMaxWind;
  if (r < state.eyeRadius) {
    const u = r / Math.max(1e-3, state.eyeRadius);
    return eyeCover + (1 - eyeCover) * Math.pow(u, 6);
  }
  const strength = clamp(state.maxWind / 33, 0.35, 1);
  const core = Math.exp(-Math.pow(r / (6 * rm), 2));
  const band = cycloneBandAt(state, x, z, options) * Math.exp(-r / (14 * rm));
  return clamp(0.25 + 0.75 * strength * Math.max(core, 0.6 * band + 0.25 * Math.exp(-r / (12 * rm))), 0, 1);
}

export type CyclonePhase = "clear" | "outer-bands" | "rainbands" | "eyewall" | "eye";

export function cyclonePhaseAt(state: CycloneState, x: number, z: number): CyclonePhase {
  const r = Math.hypot(x - state.x, z - state.z);
  const rm = state.radiusMaxWind;
  if (r < state.eyeRadius) return "eye";
  if (r < rm * 1.6) return "eyewall";
  if (r < rm * 6) return "rainbands";
  if (r < rm * 16) return "outer-bands";
  return "clear";
}

/** What the storm is doing at the observer this frame. */
export interface CycloneObserverSample {
  phase: CyclonePhase;
  distance: number;
  wind: CycloneWind;
  /** Wind the sea has caught up to (lags the air by `seaTau`). */
  seaWind: number;
  rain: number;
  cover: number;
  /** Severity 0..1 (local wind / 70 m/s). */
  storm: number;
  sunFactor: number;
  ambientFactor: number;
  surge: number;
  category: number;
  /** 0..1 how dark the sky overhead is (drives cloud albedo + fog colour; hosts can dim lights). */
  darkness: number;
}

const CLOUD_ALBEDO = new Color(1, 1, 1);
const FOG_CLEAR = new Color(0.62, 0.7, 0.8);
const FOG_STORM = new Color(0.07, 0.08, 0.09);

export interface CycloneSystemOptions extends CycloneFieldOptions {
  name?: string;
  track: CycloneTrack;
  /** Where the effects are evaluated (usually the camera or the scene's focal point). */
  observer: () => { x: number; z: number };
  /** Cyclone seconds per simulated second. Default 1. */
  timeScale?: number;
  /** Drive `scene.settings.clouds` (cover, density, deck wind). Default true. */
  driveClouds?: boolean;
  /** Drive the exp2 fog density from rain + cover. Default true. */
  driveFog?: boolean;
  fogClear?: number;
  fogStorm?: number;
  /** Fog colour (linear RGB) in clear air and under the eyewall. */
  fogColorClear?: Color;
  fogColorStorm?: Color;
  /** Cloud albedo under the darkest part of the storm (1 = white deck). Default 0.28. */
  stormCloudAlbedo?: number;
  /** Drive the ocean waves + surge. Default true (no-op while water is disabled). */
  driveOcean?: boolean;
  /** Cap on the significant wave height the ocean is allowed. Default 5. */
  maxWaveHeight?: number;
  /** Ocean wave count (tier knob). Default 4. */
  waveCount?: number;
  /** Mean sea level the surge is added to. Default the water level at attach. */
  seaLevel?: number;
  /** Seconds the sea takes to build with the wind. Default 6. */
  seaTau?: number;
  /** Seconds the sea takes to lie down when the wind drops (seas outlast the wind, e.g. in the eye). Default 25. */
  seaDecayTau?: number;
  /** Cover in the eye. Default 0.12. */
  eyeCover?: number;
  /**
   * Carve the eye into the cloud deck as a local hole with an eyewall ring (the deck's
   * `hole*` settings) instead of clearing the whole sky while the observer is in the eye.
   * `scale` shrinks the eye toward the observer for the visual (a real 15–30 km eye under a 1–2 km
   * deck would sit on the horizon; 0.1–0.2 puts the wall at a readable elevation). Omit to keep
   * the global-cover behaviour.
   */
  eyeHole?: { scale: number; wallScale?: number };
  /** Minimum light factors under the eyewall. Default 0.12 sun / 0.35 ambient. */
  minimumSun?: number;
  minimumAmbient?: number;
}

/**
 * Runs a {@link CycloneTrack} on the fixed-step clock and drives the scene at the observer. The
 * host reads {@link observed} for its sun light, rain field and HUD.
 */
export class CycloneSystem extends SceneObject {
  readonly name: string;
  readonly options: CycloneSystemOptions;
  track: CycloneTrack;
  time = 0;
  timeScale: number;
  paused = false;
  readonly state = createCycloneState();
  readonly observed: CycloneObserverSample = {
    phase: "clear",
    distance: 0,
    wind: { x: 0, z: 0, speed: 0 },
    seaWind: 0,
    rain: 0,
    cover: 0,
    storm: 0,
    sunFactor: 1,
    ambientFactor: 1,
    surge: 0,
    category: -1,
    darkness: 0,
  };
  ocean: OceanState | null = null;
  private seaWind = 0;
  private seaDir = 0;
  private seaLevel = 0;
  private primed = false;

  constructor(options: CycloneSystemOptions) {
    super();
    this.name = options.name ?? "cyclone";
    this.options = options;
    this.track = options.track;
    this.timeScale = options.timeScale ?? 1;
  }

  override onAttach(scene: Scene): void {
    this.seaLevel = this.options.seaLevel ?? scene.settings.water.level;
    this.evaluate(0);
  }

  /**
   * Jump the storm clock (replay / scrub). The sea is re-run over the preceding `warmup` seconds
   * so it carries the same lag it would have had playing through (the eye keeps its big swell).
   */
  seek(time: number, warmup = 40): void {
    const target = clamp(time, 0, this.track.duration);
    this.primed = false;
    const start = Math.max(0, target - warmup);
    const step = 0.5;
    this.time = start;
    this.evaluate(0, false);
    for (let t = start + step; t < target; t += step) {
      this.time = t;
      this.evaluate(step, false);
    }
    this.time = target;
    this.evaluate(target > start ? Math.min(step, target - start) : 0);
  }

  get finished(): boolean {
    return this.time >= this.track.duration;
  }

  override update(context: SystemContext): void {
    const dt = context.fixedSteps * context.fixedDt;
    if (!this.paused && dt > 0) this.time = Math.min(this.track.duration, this.time + dt * this.timeScale);
    this.evaluate(this.paused ? 0 : dt * this.timeScale);
  }

  /** Recompute the observer sample and push it into the scene (`dt` drives the sea lag). */
  evaluate(dt: number, applyToScene = true): void {
    const s = this.track.sample(this.time, this.state);
    const o = this.options;
    const p = o.observer();
    const obs = this.observed;
    cycloneWindAt(s, p.x, p.z, o, obs.wind);
    obs.distance = Math.hypot(p.x - s.x, p.z - s.z);
    obs.phase = cyclonePhaseAt(s, p.x, p.z);
    obs.rain = cycloneRainAt(s, p.x, p.z, o);
    obs.cover = cycloneCoverAt(s, p.x, p.z, o.eyeCover ?? 0.12, o);
    obs.storm = clamp(obs.wind.speed / 70, 0, 1);
    obs.category = saffirSimpsonCategory(s.maxWind);
    const light = stormLightFactors(obs.cover, Math.max(obs.storm, obs.rain), o.minimumSun ?? 0.12, o.minimumAmbient ?? 0.35);
    obs.sunFactor = light.sun * (1 - 0.5 * obs.rain);
    obs.ambientFactor = light.ambient;
    obs.surge = s.surge * Math.exp(-Math.pow(obs.distance / (2.5 * s.radiusMaxWind), 2));
    // The sea follows the wind with a lag; swell radiates away from the centre.
    const tau = o.seaTau ?? 6;
    const awayX = p.x - s.x;
    const awayZ = p.z - s.z;
    const swellDir = Math.atan2(awayZ, awayX);
    if (!this.primed) {
      this.seaWind = obs.wind.speed;
      this.seaDir = swellDir;
      this.primed = true;
    } else if (dt > 0) {
      const rising = obs.wind.speed > this.seaWind;
      this.seaWind = approachExponential(this.seaWind, obs.wind.speed, dt, rising ? tau : (o.seaDecayTau ?? 25));
      const delta = Math.atan2(Math.sin(swellDir - this.seaDir), Math.cos(swellDir - this.seaDir));
      this.seaDir += delta * (1 - Math.exp(-dt / tau));
    }
    obs.seaWind = this.seaWind;
    const scene = this.scene;
    if (!scene || !applyToScene) return;
    // How dark the storm is overhead: thick deck + heavy rain + wind, nothing in the clear eye.
    obs.darkness = clamp(Math.max(obs.rain, obs.storm * 0.9) * clamp((obs.cover - 0.3) / 0.6, 0, 1), 0, 1);
    if (o.driveClouds ?? true) {
      const albedo = 1 - (1 - (o.stormCloudAlbedo ?? 0.28)) * obs.darkness;
      CLOUD_ALBEDO.set(albedo, albedo, albedo * 1.03);
      const hole = o.eyeHole;
      if (hole && s.eyeRadius > 0) {
        // The deck stays overcast through the eye; the hole (fixed in the world, following the
        // storm centre scaled toward the observer) opens the sky overhead and rings it with wall.
        const k = Math.max(1e-4, hole.scale);
        const deckCover = cycloneCoverAt(s, p.x, p.z, 1, o);
        scene.setClouds({
          coverage: deckCover,
          density: 0.6 + 0.4 * deckCover,
          windX: obs.wind.x * 0.6,
          windZ: obs.wind.z * 0.6,
          albedo: CLOUD_ALBEDO,
          holeX: p.x + (s.x - p.x) * k,
          holeZ: p.z + (s.z - p.z) * k,
          holeRadius: s.eyeRadius * k,
          holeWall: Math.max(s.radiusMaxWind - s.eyeRadius, s.eyeRadius * 0.5) * k * (hole.wallScale ?? 1.5),
          holeStrength: 1,
        });
      } else {
        scene.setClouds({ coverage: obs.cover, density: 0.6 + 0.4 * obs.cover, windX: obs.wind.x * 0.6, windZ: obs.wind.z * 0.6, albedo: CLOUD_ALBEDO, holeStrength: 0 });
      }
    }
    if (o.driveFog ?? true) {
      const clear = o.fogClear ?? 0.0006;
      const storm = o.fogStorm ?? 0.012;
      const a = o.fogColorClear ?? FOG_CLEAR;
      const b = o.fogColorStorm ?? FOG_STORM;
      const k = obs.darkness;
      // Mutate the scene's own colour (setFog would adopt a shared object).
      scene.settings.fog.color.set(a.r + (b.r - a.r) * k, a.g + (b.g - a.g) * k, a.b + (b.b - a.b) * k);
      scene.setFog("exp2", { density: clear + (storm - clear) * clamp(obs.rain * 0.8 + obs.storm * 0.4, 0, 1) });
    }
    if ((o.driveOcean ?? true) && scene.settings.water.enabled) {
      // Blend the swell direction with the local wind so a strong onshore wind piles the sea up.
      const windDir = Math.atan2(obs.wind.z, obs.wind.x);
      const w = clamp(obs.wind.speed / 60, 0, 0.5);
      const dir = Math.atan2(Math.sin(this.seaDir) * (1 - w) + Math.sin(windDir) * w, Math.cos(this.seaDir) * (1 - w) + Math.cos(windDir) * w);
      this.ocean = oceanWavesFromWind({ windSpeed: this.seaWind, direction: dir, maxHeight: o.maxWaveHeight ?? 5, waveCount: o.waveCount ?? 4, seed: 3 });
      applyOceanState(scene, this.ocean);
      scene.setWater({ level: this.seaLevel + obs.surge });
    }
  }

  override stats(): Record<string, number | string | boolean> {
    return {
      time: Math.round(this.time * 10) / 10,
      phase: this.observed.phase,
      wind: Math.round(this.observed.wind.speed * 10) / 10,
      category: this.observed.category,
      rain: Math.round(this.observed.rain * 100) / 100,
    };
  }
}
