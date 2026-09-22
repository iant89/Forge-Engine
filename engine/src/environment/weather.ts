/**
 * Weather state (Phase 8b): where the air goes, how wet it is, how warm it is.
 *
 * `WeatherSystem` is a `SceneObject` that owns the atmosphere's *thermodynamic* state — the mean
 * wind, gusts, temperature, humidity, precipitation and storm intensity — and integrates it toward
 * a target on the fixed-step clock, exactly like `DayNightCycle` integrates its calendar. The
 * state is deliberately coarse (one value per channel for the whole scene); spatial variation is a
 * pure function of position and time sampled through `sampleWindAt` / `sampleTemperatureAt` /
 * `samplePrecipitationAt`, so gameplay, particles and audio can query the weather anywhere without
 * owning a grid.
 *
 * Frozen turbulence: the gust field is noise sampled at `(p − wind·t)`, i.e. eddies are advected by
 * the mean wind instead of evolving. Sampling downwind later equals sampling upwind earlier (pinned
 * by `tests/environment8b.test.ts`), which is both the cheapest plausible gust model and exactly
 * deterministic — no history, no grid, no worker round-trip.
 *
 * The system optionally *drives* the scene (all three switches default to on):
 *  - `driveFog`: fog density rises with precipitation (rain is visible as lost visibility);
 *  - `driveSky`: the sky's turbidity (haze) rises with humidity and storm;
 *  - `driveClouds`: `scene.settings.clouds.coverage` follows the weather's cloud cover.
 * The base values the drives add onto are captured on attach; only the *deltas* are owned here, so
 * a scene's art direction survives and `driveFog: false` leaves the fog alone entirely.
 */

import { SceneObject, type Scene } from "../scene/scene.js";
import type { SystemContext } from "../scene/systems.js";
import { fbm2 } from "../math/noise.js";
import { clamp, lerpAngle, TAU } from "../math/scalar.js";
import { Vec2 } from "../math/vec.js";

/** One snapshot of the weather. All fields are plain numbers (serialisable, comparable). */
export interface WeatherState {
  /** Mean horizontal wind speed, m/s. */
  windSpeed: number;
  /** Compass direction the wind blows *toward*, radians clockwise from north (like solar azimuth). */
  windDirection: number;
  /** Turbulence intensity 0..1 (gust amplitude relative to the mean wind). */
  gust: number;
  /** Air temperature at sea level, °C. */
  temperatureC: number;
  /** Relative humidity 0..1. */
  humidity01: number;
  /** Precipitation rate 0..1 (0 = dry, 1 = cloudburst). */
  precipitation01: number;
  /** Convective/storm intensity 0..1 (drives the lightning rate and darkens clouds). */
  storm01: number;
  /** Cloud cover 0..1 (drives `scene.settings.clouds.coverage` when `driveClouds`). */
  cloudCoverage: number;
}

export type WeatherChannel = keyof WeatherState;

/** Per-channel exponential time constants (seconds) for the drift toward the target. */
export interface WeatherTimeConstants {
  windSpeed: number;
  windDirection: number;
  gust: number;
  temperatureC: number;
  humidity01: number;
  precipitation01: number;
  storm01: number;
  cloudCoverage: number;
}

export const DEFAULT_WEATHER_TAU: Readonly<WeatherTimeConstants> = Object.freeze({
  windSpeed: 30,
  windDirection: 60,
  gust: 20,
  temperatureC: 600,
  humidity01: 300,
  precipitation01: 120,
  storm01: 180,
  cloudCoverage: 240,
});

function fullState(partial: Partial<WeatherState>, fallback: WeatherState): WeatherState {
  return {
    windSpeed: partial.windSpeed ?? fallback.windSpeed,
    windDirection: partial.windDirection ?? fallback.windDirection,
    gust: partial.gust ?? fallback.gust,
    temperatureC: partial.temperatureC ?? fallback.temperatureC,
    humidity01: partial.humidity01 ?? fallback.humidity01,
    precipitation01: partial.precipitation01 ?? fallback.precipitation01,
    storm01: partial.storm01 ?? fallback.storm01,
    cloudCoverage: partial.cloudCoverage ?? fallback.cloudCoverage,
  };
}

export function cloneWeatherState(state: WeatherState): WeatherState {
  return { ...state };
}

/** Authoring presets: complete, mutually consistent (temperature, humidity, rain, cover). */
export const WEATHER_PRESETS: Readonly<Record<"clear" | "overcast" | "rain" | "storm", Readonly<WeatherState>>> = Object.freeze({
  clear: Object.freeze({ windSpeed: 3, windDirection: Math.PI / 4, gust: 0.2, temperatureC: 20, humidity01: 0.3, precipitation01: 0, storm01: 0, cloudCoverage: 0.15 }),
  overcast: Object.freeze({ windSpeed: 6, windDirection: Math.PI / 3, gust: 0.4, temperatureC: 14, humidity01: 0.8, precipitation01: 0.05, storm01: 0.05, cloudCoverage: 0.8 }),
  rain: Object.freeze({ windSpeed: 9, windDirection: Math.PI / 2, gust: 0.6, temperatureC: 11, humidity01: 0.95, precipitation01: 0.7, storm01: 0.2, cloudCoverage: 0.95 }),
  storm: Object.freeze({ windSpeed: 16, windDirection: (2 * Math.PI) / 3, gust: 1, temperatureC: 12, humidity01: 1, precipitation01: 1, storm01: 1, cloudCoverage: 1 }),
});

export type WeatherPresetName = keyof typeof WEATHER_PRESETS;

/** Mean temperature lapse rate with altitude (°C per metre). */
export const TEMPERATURE_LAPSE_PER_M = 0.0065;

/**
 * Exponential approach: after `tau` seconds the gap to the target shrinks to 1/e. `tau <= 0`
 * snaps. This is the whole integrator — closed form, no overshoot, step-count independent to
 * float precision (a 120 × 1/60 run and a 60 × 1/30 run agree, pinned by the tests).
 */
export function approachExponential(current: number, target: number, dt: number, tau: number): number {
  if (!(dt > 0)) return current;
  if (!(tau > 0)) return target;
  if (current === target) return current;
  return target + (current - target) * Math.exp(-dt / tau);
}

/** Wrap an angle to [0, 2π). */
export function wrapAngle(angle: number): number {
  const m = angle % TAU;
  return m < 0 ? m + TAU : m;
}

export interface WeatherOptions {
  name?: string;
  /** Deterministic seed for the gust/temperature/precipitation fields. Default 1337. */
  seed?: number;
  /** Starting state (a preset name or a partial state over `clear`). */
  initial?: WeatherPresetName | Partial<WeatherState>;
  /** Target state the weather drifts toward (same shape). Default: the initial state. */
  target?: WeatherPresetName | Partial<WeatherState>;
  /** Per-channel time constants; defaults in `DEFAULT_WEATHER_TAU`. */
  tau?: Partial<WeatherTimeConstants>;
  /** Spatial scale of the gust eddies (noise units per metre). Default 0.02 (≈ 50 m eddies). */
  gustScale?: number;
  /** Spatial scale of the temperature/precipitation patches. Default 0.004 (≈ 250 m). */
  patchScale?: number;
  /** Write `scene.settings.fog.density` from the precipitation. Default true. */
  driveFog?: boolean;
  /** Fog density added at full precipitation. Default 0.02. */
  rainFogDensity?: number;
  /** Write `scene.settings.sky.turbidity` from humidity/storm. Default true. */
  driveSky?: boolean;
  /** Extra turbidity at full humidity / full storm. Defaults 2 / 4. */
  humidityTurbidity?: number;
  stormTurbidity?: number;
  /** Write `scene.settings.clouds.coverage` from the cloud cover. Default true. */
  driveClouds?: boolean;
}

const CLOUD_FBM_OCTAVES = 4;
const SCRATCH_WIND = new Vec2();

export class WeatherSystem extends SceneObject {
  readonly name: string;
  readonly seed: number;
  readonly state: WeatherState;
  readonly target: WeatherState;
  readonly tau: WeatherTimeConstants;
  readonly gustScale: number;
  readonly patchScale: number;
  driveFog: boolean;
  rainFogDensity: number;
  driveSky: boolean;
  humidityTurbidity: number;
  stormTurbidity: number;
  driveClouds: boolean;
  /** Seconds of simulated weather time advanced since creation. */
  simulatedSeconds = 0;

  private baseFogDensity = 0;
  private baseTurbidity = 2;
  private captured = false;

  constructor(options: WeatherOptions = {}) {
    super();
    this.name = options.name ?? "weather";
    this.seed = options.seed ?? 1337;
    const initialBase = typeof options.initial === "string" ? WEATHER_PRESETS[options.initial] : WEATHER_PRESETS.clear;
    const initialPartial = typeof options.initial === "string" ? {} : (options.initial ?? {});
    this.state = fullState(initialPartial, initialBase);
    const targetBase = typeof options.target === "string" ? WEATHER_PRESETS[options.target] : initialBase;
    const targetPartial = typeof options.target === "string" ? {} : (options.target ?? initialPartial);
    this.target = fullState(targetPartial, targetBase);
    this.tau = { ...DEFAULT_WEATHER_TAU, ...options.tau };
    this.gustScale = options.gustScale ?? 0.02;
    this.patchScale = options.patchScale ?? 0.004;
    this.driveFog = options.driveFog ?? true;
    this.rainFogDensity = options.rainFogDensity ?? 0.02;
    this.driveSky = options.driveSky ?? true;
    this.humidityTurbidity = options.humidityTurbidity ?? 2;
    this.stormTurbidity = options.stormTurbidity ?? 4;
    this.driveClouds = options.driveClouds ?? true;
  }

  /** Replace the drift target (a preset or a partial state over the current target). */
  setTarget(target: WeatherPresetName | Partial<WeatherState>): this {
    const base = typeof target === "string" ? WEATHER_PRESETS[target] : this.target;
    const partial = typeof target === "string" ? {} : target;
    Object.assign(this.target, fullState(partial, base));
    return this;
  }

  /** Snap the current state (a preset or a partial state over the current state). */
  snapTo(state: WeatherPresetName | Partial<WeatherState>): this {
    const base = typeof state === "string" ? WEATHER_PRESETS[state] : this.state;
    const partial = typeof state === "string" ? {} : state;
    Object.assign(this.state, fullState(partial, base));
    this.apply();
    return this;
  }

  override onAttach(scene: Scene): void {
    this.baseFogDensity = scene.settings.fog.density;
    this.baseTurbidity = scene.settings.sky.turbidity;
    this.captured = true;
    this.apply();
  }

  override update(context: SystemContext): void {
    const seconds = context.fixedSteps * context.fixedDt;
    if (seconds !== 0) this.advance(seconds);
    else this.apply();
  }

  /** Advance the drift toward the target (seconds of simulated time). */
  advance(seconds: number): this {
    if (!(seconds > 0) || !Number.isFinite(seconds)) return this;
    this.simulatedSeconds += seconds;
    const s = this.state;
    const t = this.target;
    s.windSpeed = Math.max(0, approachExponential(s.windSpeed, t.windSpeed, seconds, this.tau.windSpeed));
    // The direction drifts along the shortest arc (a 350° → 10° change turns +20°, not −340°).
    const rate = this.tau.windDirection > 0 ? 1 - Math.exp(-seconds / this.tau.windDirection) : 1;
    s.windDirection = wrapAngle(lerpAngle(s.windDirection, t.windDirection, rate));
    s.gust = clamp(approachExponential(s.gust, t.gust, seconds, this.tau.gust), 0, 1);
    s.temperatureC = approachExponential(s.temperatureC, t.temperatureC, seconds, this.tau.temperatureC);
    s.humidity01 = clamp(approachExponential(s.humidity01, t.humidity01, seconds, this.tau.humidity01), 0, 1);
    s.precipitation01 = clamp(approachExponential(s.precipitation01, t.precipitation01, seconds, this.tau.precipitation01), 0, 1);
    s.storm01 = clamp(approachExponential(s.storm01, t.storm01, seconds, this.tau.storm01), 0, 1);
    s.cloudCoverage = clamp(approachExponential(s.cloudCoverage, t.cloudCoverage, seconds, this.tau.cloudCoverage), 0, 1);
    this.apply();
    return this;
  }

  /** Push the driven scene settings (idempotent for the current state). */
  apply(): void {
    const scene = this.scene;
    if (!scene || !this.captured) return;
    if (this.driveFog) scene.settings.fog.density = Math.max(0, this.baseFogDensity + this.state.precipitation01 * this.rainFogDensity);
    if (this.driveSky) scene.settings.sky.turbidity = clamp(this.baseTurbidity + this.state.humidity01 * this.humidityTurbidity + this.state.storm01 * this.stormTurbidity, 2, 14);
    if (this.driveClouds) {
      scene.settings.clouds.coverage = this.state.cloudCoverage;
      const wind = this.meanWind(SCRATCH_WIND);
      scene.settings.clouds.windX = wind.x;
      scene.settings.clouds.windZ = wind.y;
    }
  }

  /** Mean wind vector (m/s, +x east / +y north→+z) at the current state. */
  meanWind(out = new Vec2()): Vec2 {
    return out.set(Math.sin(this.state.windDirection) * this.state.windSpeed, Math.cos(this.state.windDirection) * this.state.windSpeed);
  }

  /**
   * Wind at a world position and time (m/s): the mean wind plus gust turbulence. The turbulence
   * is bounded by `gust · (2 + 0.3 · speed)` per component and is exactly reproducible for a
   * (x, z, t, seed) tuple. `t` defaults to the simulated clock.
   */
  sampleWindAt(x: number, z: number, out = new Vec2(), t = this.simulatedSeconds): Vec2 {
    const s = this.state;
    const wx = Math.sin(s.windDirection) * s.windSpeed;
    const wz = Math.cos(s.windDirection) * s.windSpeed;
    // Advect the sample point upwind: eddies ride the mean flow (frozen turbulence).
    const px = (x - wx * t) * this.gustScale;
    const pz = (z - wz * t) * this.gustScale;
    const amp = s.gust * (2 + 0.3 * s.windSpeed);
    const nx = fbm2(px, pz, this.seed, { octaves: CLOUD_FBM_OCTAVES });
    const nz = fbm2(px + 13.7, pz - 7.1, this.seed ^ 0x51ed, { octaves: CLOUD_FBM_OCTAVES });
    return out.set(wx + nx * amp, wz + nz * amp);
  }

  /**
   * Air temperature (°C) at a world position: the state temperature, minus the lapse rate with
   * height above sea level, plus a ±1.5 °C patch field.
   */
  sampleTemperatureAt(x: number, y: number, z: number, t = this.simulatedSeconds): number {
    const s = this.state;
    const wx = Math.sin(s.windDirection) * s.windSpeed;
    const wz = Math.cos(s.windDirection) * s.windSpeed;
    const patch = fbm2((x - wx * t) * this.patchScale, (z - wz * t) * this.patchScale, this.seed ^ 0x2bc3, { octaves: 3 });
    return s.temperatureC - TEMPERATURE_LAPSE_PER_M * y + patch * 1.5;
  }

  /**
   * Precipitation rate 0..1 at a world position: the state rate modulated by patchiness
   * (0.6 + 0.8 · fbm01), so a dry state is dry everywhere and a cloudburst rains everywhere.
   */
  samplePrecipitationAt(x: number, z: number, t = this.simulatedSeconds): number {
    const s = this.state;
    if (s.precipitation01 <= 0) return 0;
    const wx = Math.sin(s.windDirection) * s.windSpeed;
    const wz = Math.cos(s.windDirection) * s.windSpeed;
    const f = fbm2((x - wx * t) * this.patchScale, (z - wz * t) * this.patchScale, this.seed ^ 0x77aa, { octaves: 3 }) * 0.5 + 0.5;
    return clamp(s.precipitation01 * (0.6 + 0.8 * f), 0, 1);
  }

  override stats(): Record<string, number | string | boolean> {
    const s = this.state;
    return {
      windSpeed: Math.round(s.windSpeed * 100) / 100,
      windDirectionDeg: Math.round((s.windDirection * 180) / Math.PI),
      temperatureC: Math.round(s.temperatureC * 10) / 10,
      humidity: Math.round(s.humidity01 * 1000) / 1000,
      precipitation: Math.round(s.precipitation01 * 1000) / 1000,
      storm: Math.round(s.storm01 * 1000) / 1000,
      cloudCoverage: Math.round(s.cloudCoverage * 1000) / 1000,
    };
  }
}
