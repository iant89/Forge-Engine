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
 * by `tests/environment/environment8b.test.ts`), which is both the cheapest plausible gust model and exactly
 * deterministic — no history, no grid, no worker round-trip.
 *
 * The system optionally *drives* the scene (all four switches default to on):
 *  - `driveFog`: fog density rises with precipitation (rain is visible as lost visibility);
 *  - `driveSky`: the sky's turbidity (haze) rises with humidity and storm;
 *  - `driveClouds`: `scene.settings.clouds.coverage` follows the weather's cloud cover;
 *  - `driveLighting`: cloud/storm cover attenuates directional and ambient light with safe floors.
 * The base values the drives add onto are captured on attach; only the *deltas* are owned here, so
 * a scene's art direction survives and `driveFog: false` leaves the fog alone entirely. A scene that
 * changes its own base fog later (say, drawing terrain farther and thinning the fog to match) says so
 * with `setBaseFogDensity`; writing `scene.settings.fog.density` directly would be overwritten.
 */

import { captureState, restoreState, type StateRecord } from "../core/snapshot.js";
import { UsageError } from "../core/errors.js";
import { SceneObject, type Scene } from "../scene/scene.js";
import type { SystemContext } from "../scene/systems.js";
import { fbm2 } from "../math/noise.js";
import { clamp, lerpAngle, TAU } from "../math/scalar.js";
import { Vec2 } from "../math/vec.js";
import { setWorldSurfaceGrip } from "../scene/surfaceGrip.js";
import { applyOceanState, oceanWavesFromWind, type OceanWindOptions } from "./ocean.js";
import { createSurfaceWeather, stepSurfaceWeather, tyreGripFactor, weatherOceanOptions, DEFAULT_SURFACE_RATES, type SurfaceWeatherRates, type SurfaceWeatherState } from "./surfaceWeather.js";
import { Light } from "../scene/components/index.js";
import { DMath } from "../math/detmath.js";

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
  return target + (current - target) * DMath.exp(-dt / tau);
}

/** Wrap an angle to [0, 2π). */
export function wrapAngle(angle: number): number {
  const m = angle % TAU;
  return m < 0 ? m + TAU : m;
}

/** Cloud/storm attenuation applied to direct and ambient scene lighting. */
export function stormLightFactors(coverage: number, storm: number, minimumSun = 0.2, minimumAmbient = 0.5): { sun: number; ambient: number } {
  const cover = clamp(coverage, 0, 1);
  const severe = clamp(storm, 0, 1);
  return {
    sun: clamp(1 - cover * 0.62 - severe * 0.18, clamp(minimumSun, 0, 1), 1),
    ambient: clamp(1 - cover * 0.32 - severe * 0.18, clamp(minimumAmbient, 0, 1), 1),
  };
}

/**
 * Cloud skylight is grey: a deck scatters nearly wavelength-independently, so the clear-sky blue of
 * the hemispherical ambient fades as cover grows. Returns the fraction of the ambient's chroma to
 * remove (0 clear, 0.9 at full cover / storm).
 */
export function overcastAmbientNeutral(coverage: number, storm: number): number {
  return clamp(clamp(coverage, 0, 1) * 0.85 + clamp(storm, 0, 1) * 0.1, 0, 0.9);
}

/**
 * Desaturate a linear RGB ambient toward its own luminance (Rec. 709) by `neutral`, keeping the
 * luminance, so weather changes the ambient's colour without changing its brightness.
 */
export function neutralizeAmbient(color: { r: number; g: number; b: number }, neutral: number, out: { r: number; g: number; b: number }): typeof out {
  const k = clamp(neutral, 0, 1);
  const y = 0.2126 * color.r + 0.7152 * color.g + 0.0722 * color.b;
  out.r = color.r + (y - color.r) * k;
  out.g = color.g + (y - color.g) * k;
  out.b = color.b + (y - color.b) * k;
  return out;
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
  /** Write `scene.settings.fog.density` from precipitation and optional storm haze. Default true. */
  driveFog?: boolean;
  /** Fog density added at full precipitation. Default 0.02. */
  rainFogDensity?: number;
  /** Extra fog density added at full storm, useful for dry dust storms. Default 0. */
  stormFogDensity?: number;
  /** Write `scene.settings.sky.turbidity` from humidity/storm. Default true. */
  driveSky?: boolean;
  /** Extra turbidity at full humidity / full storm. Defaults 2 / 4. */
  humidityTurbidity?: number;
  stormTurbidity?: number;
  /** Write `scene.settings.clouds.coverage` from the cloud cover. Default true. */
  driveClouds?: boolean;
  /** Attenuate directional and ambient light under cloud/storm cover. Default true. */
  driveLighting?: boolean;
  /** Minimum directional-light multiplier at maximum overcast storm. Default 0.2. */
  minimumSunLight?: number;
  /** Minimum ambient-intensity multiplier at maximum overcast storm. Default 0.5. */
  minimumAmbientLight?: number;
  /** Phase 17.4: write the integrated ground state to `scene.settings.surface`. Default true. */
  driveSurface?: boolean;
  /** Starting ground state (e.g. `{ wetness: 1 }` for a scene that opens after rain). */
  initialSurface?: Partial<SurfaceWeatherState>;
  /** Surface wetting/drying/snow rates; defaults in `DEFAULT_SURFACE_RATES`. */
  surfaceRates?: Partial<SurfaceWeatherRates>;
  /** Phase 17.4: publish `tyreGripFactor(surface)` for the world; `VehicleSystem` applies it to every vehicle's `surfaceGrip`. Default true. */
  driveVehicles?: boolean;
  /**
   * Phase 17.4: rebuild the scene's Gerstner sea from the wind (`oceanWavesFromWind`) when the
   * water is enabled. Default false (scenes with hand-authored waves keep them). Extra options
   * (`maxHeight`, `waveCount`, …) pass through.
   */
  driveWater?: boolean | Omit<Partial<OceanWindOptions>, "windSpeed" | "direction">;
}

const CLOUD_FBM_OCTAVES = 4;
const SCRATCH_WIND = new Vec2();

export class WeatherSystem extends SceneObject {
  private lastAmbientColor: { r: number; g: number; b: number } | null = null;
  /**
   * Fraction of the direct sunlight the cloud cover removes that returns as neutral diffuse skylight
   * (scaled down by storm severity: a cumulonimbus reflects and absorbs most of it). Default 0.8;
   * 0 restores the old dim-only behaviour.
   */
  cloudDiffuseTransfer = 0.8;
  /**
   * Extra share of the returned skylight that stands in for the cloud base lighting the shadows the
   * remaining direct beam still casts (a point source cannot cast soft shadows). Default 0.5.
   */
  cloudShadowFill = 0.5;
  private ambientColorSource: { r: number; g: number; b: number } | null = null;
  readonly name: string;
  readonly seed: number;
  readonly state: WeatherState;
  readonly target: WeatherState;
  readonly tau: WeatherTimeConstants;
  readonly gustScale: number;
  readonly patchScale: number;
  driveFog: boolean;
  rainFogDensity: number;
  stormFogDensity: number;
  driveSky: boolean;
  humidityTurbidity: number;
  stormTurbidity: number;
  driveClouds: boolean;
  driveLighting: boolean;
  minimumSunLight: number;
  minimumAmbientLight: number;
  /** Seconds of simulated weather time advanced since creation. */
  simulatedSeconds = 0;
  /** Phase 17.4: the ground's integrated memory of the weather (wet film, puddles, snow). */
  readonly surface: SurfaceWeatherState;
  readonly surfaceRates: SurfaceWeatherRates;
  driveSurface: boolean;
  driveVehicles: boolean;
  driveWater: false | Omit<Partial<OceanWindOptions>, "windSpeed" | "direction">;
  private lastWaterWind = Number.NaN;
  private lastWaterDirection = Number.NaN;
  private lastWaterStorm = Number.NaN;

  private baseFogDensity = 0;
  private baseTurbidity = 2;
  private captured = false;
  private previousSunFactor = 1;
  private previousAmbientFactor = 1;
  private readonly lightingScratch: Light[] = [];
  private readonly attenuatedLights = new WeakSet<Light>();
  private readonly lastLightOutput = new WeakMap<Light, number>();
  private lastAmbientOutput = Number.NaN;

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
    this.stormFogDensity = Math.max(0, options.stormFogDensity ?? 0);
    this.driveSky = options.driveSky ?? true;
    this.humidityTurbidity = options.humidityTurbidity ?? 2;
    this.stormTurbidity = options.stormTurbidity ?? 4;
    this.driveClouds = options.driveClouds ?? true;
    this.driveLighting = options.driveLighting ?? true;
    this.minimumSunLight = clamp(options.minimumSunLight ?? 0.2, 0, 1);
    this.minimumAmbientLight = clamp(options.minimumAmbientLight ?? 0.5, 0, 1);
    this.surface = { ...createSurfaceWeather(), ...options.initialSurface };
    this.surfaceRates = { ...DEFAULT_SURFACE_RATES, ...options.surfaceRates };
    this.driveSurface = options.driveSurface ?? true;
    this.driveVehicles = options.driveVehicles ?? true;
    this.driveWater = options.driveWater === true ? {} : options.driveWater || false;
  }

  /** Tyre grip multiplier for the current ground state (1 = dry); see `tyreGripFactor`. */
  get grip(): number {
    return tyreGripFactor(this.surface);
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

  /**
   * Phase 19.1: the weather now, where it is heading, the ground's wetness/puddles/snow, the
   * simulated clock (the gust field is a pure function of seed and clock) and the drive knobs.
   */
  override saveState(): Record<string, unknown> {
    // Keep the default snapshot byte-for-byte compatible with the pre-dust-haze contract. The new
    // option is opt-in, so only persist it when it is active; loadState treats an absent value as the
    // existing zero default. This avoids changing unrelated replay fixtures while still round-tripping
    // a Mars dry-storm configuration.
    const saved: Record<string, unknown> = {
      seed: this.seed,
      gustScale: this.gustScale,
      patchScale: this.patchScale,
      tau: { ...this.tau },
      state: { ...this.state },
      target: { ...this.target },
      surface: { ...this.surface },
      simulatedSeconds: this.simulatedSeconds,
      driveFog: this.driveFog,
      rainFogDensity: this.rainFogDensity,
      driveSky: this.driveSky,
      humidityTurbidity: this.humidityTurbidity,
      stormTurbidity: this.stormTurbidity,
      driveClouds: this.driveClouds,
      driveLighting: this.driveLighting,
      minimumSunLight: this.minimumSunLight,
      minimumAmbientLight: this.minimumAmbientLight,
      driveSurface: this.driveSurface,
      driveVehicles: this.driveVehicles,
      cloudDiffuseTransfer: this.cloudDiffuseTransfer,
      cloudShadowFill: this.cloudShadowFill,
    };
    if (this.stormFogDensity !== 0) saved.stormFogDensity = this.stormFogDensity;
    return saved;
  }

  /** Returns warnings for construction-time settings (seed, time constants, scales) that differ. */
  override loadState(saved: Record<string, unknown>): string[] {
    const warnings: string[] = [];
    const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
    for (const k of ["seed", "gustScale", "patchScale"] as const) {
      const v = num(saved[k]);
      if (v !== undefined && v !== this[k]) warnings.push(`${k} ${v} differs from this system's ${this[k]} (set at construction)`);
    }
    const tau = saved["tau"];
    if (tau && typeof tau === "object" && JSON.stringify({ ...this.tau }) !== JSON.stringify(tau)) warnings.push("tau differs from this system's (set at construction)");
    const merge = (into: Record<string, number>, from: unknown): void => {
      if (!from || typeof from !== "object") return;
      for (const k of Object.keys(into)) {
        const v = num((from as Record<string, unknown>)[k]);
        if (v !== undefined) into[k] = v;
      }
    };
    merge(this.state as unknown as Record<string, number>, saved["state"]);
    merge(this.target as unknown as Record<string, number>, saved["target"]);
    merge(this.surface as unknown as Record<string, number>, saved["surface"]);
    this.simulatedSeconds = num(saved["simulatedSeconds"]) ?? this.simulatedSeconds;
    for (const k of ["driveFog", "driveSky", "driveClouds", "driveLighting", "driveSurface", "driveVehicles"] as const) {
      if (typeof saved[k] === "boolean") this[k] = saved[k] as boolean;
    }
    for (const k of ["rainFogDensity", "stormFogDensity", "humidityTurbidity", "stormTurbidity", "minimumSunLight", "minimumAmbientLight", "cloudDiffuseTransfer", "cloudShadowFill"] as const) {
      const v = num(saved[k]);
      if (v !== undefined) this[k] = v;
    }
    if (this.scene) this.apply();
    return warnings;
  }

  /**
   * Phase 19.3: the weather's whole mid-run state (current/target state, surface, clock, the change
   * detectors and lighting memory it carries between updates), captured structurally.
   */
  override snapshotState(): StateRecord {
    return captureState(this, { skip: ["scene", "lightingScratch"] });
  }

  override restoreSnapshotState(state: StateRecord): void {
    restoreState(this, state, this.name);
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
    const rate = this.tau.windDirection > 0 ? 1 - DMath.exp(-seconds / this.tau.windDirection) : 1;
    s.windDirection = wrapAngle(lerpAngle(s.windDirection, t.windDirection, rate));
    s.gust = clamp(approachExponential(s.gust, t.gust, seconds, this.tau.gust), 0, 1);
    s.temperatureC = approachExponential(s.temperatureC, t.temperatureC, seconds, this.tau.temperatureC);
    s.humidity01 = clamp(approachExponential(s.humidity01, t.humidity01, seconds, this.tau.humidity01), 0, 1);
    s.precipitation01 = clamp(approachExponential(s.precipitation01, t.precipitation01, seconds, this.tau.precipitation01), 0, 1);
    s.storm01 = clamp(approachExponential(s.storm01, t.storm01, seconds, this.tau.storm01), 0, 1);
    s.cloudCoverage = clamp(approachExponential(s.cloudCoverage, t.cloudCoverage, seconds, this.tau.cloudCoverage), 0, 1);
    // Ground state integrates on the same clock, in ≤ 1 s slices so a long skip stays accurate.
    let left = seconds;
    while (left > 0) {
      const step = Math.min(1, left);
      stepSurfaceWeather(this.surface, s, step, this.surfaceRates);
      left -= step;
    }
    this.apply();
    return this;
  }

  /**
   * Replace the base fog density the weather adds its rain/storm haze onto (captured from the scene on
   * attach), and push it now. Must be finite and ≥ 0.
   */
  setBaseFogDensity(density: number): void {
    if (!(Number.isFinite(density) && density >= 0)) {
      throw new UsageError(`WeatherSystem.setBaseFogDensity: density must be a finite number >= 0 (got ${density})`);
    }
    this.baseFogDensity = density;
    this.apply();
  }

  /** Push the driven scene settings (idempotent for the current state). */
  apply(): void {
    const scene = this.scene;
    if (!scene || !this.captured) return;
    if (this.driveFog) {
      scene.settings.fog.density = Math.max(
        0,
        this.baseFogDensity + this.state.precipitation01 * this.rainFogDensity + this.state.storm01 * this.stormFogDensity,
      );
    }
    if (this.driveSky) scene.settings.sky.turbidity = clamp(this.baseTurbidity + this.state.humidity01 * this.humidityTurbidity + this.state.storm01 * this.stormTurbidity, 2, 14);
    if (this.driveClouds) {
      scene.settings.clouds.coverage = this.state.cloudCoverage;
      const wind = this.meanWind(SCRATCH_WIND);
      scene.settings.clouds.windX = wind.x;
      scene.settings.clouds.windZ = wind.y;
    }
    const factors = this.driveLighting
      ? stormLightFactors(this.state.cloudCoverage, this.state.storm01, this.minimumSunLight, this.minimumAmbientLight)
      : { sun: 1, ambient: 1 };
    const lights = scene.collectLights(this.lightingScratch);
    // Sunlight the deck takes out of the direct beam is not lost: most of it reaches the ground as
    // diffuse skylight from the cloud base (cos-weighted, as a radiance like ambientColor).
    let cloudDiffuse = 0;
    for (const light of lights) {
      if (light.kind !== "directional") continue;
      const lastOutput = this.lastLightOutput.get(light);
      const unchanged = this.attenuatedLights.has(light) && lastOutput !== undefined && Math.abs(light.intensity - lastOutput) <= 1e-9;
      const undimmed = unchanged ? light.intensity / Math.max(1e-6, this.previousSunFactor) : light.intensity;
      light.intensity = undimmed * factors.sun;
      const lum = 0.2126 * light.color.x + 0.7152 * light.color.y + 0.0722 * light.color.z;
      cloudDiffuse += ((undimmed - light.intensity) * Math.max(0, -light.direction.y) * lum) / Math.PI;
      this.attenuatedLights.add(light);
      this.lastLightOutput.set(light, light.intensity);
    }
    const ambientUnchanged = Number.isFinite(this.lastAmbientOutput) && Math.abs(scene.settings.ambientIntensity - this.lastAmbientOutput) <= 1e-9;
    const undimmedAmbient = ambientUnchanged
      ? scene.settings.ambientIntensity / Math.max(1e-6, this.previousAmbientFactor)
      : scene.settings.ambientIntensity;
    scene.settings.ambientIntensity = undimmedAmbient * factors.ambient;
    // Overcast skylight is grey: neutralize the clear-sky ambient's blue by cloud cover. Idempotent
    // like the intensity: if nobody rewrote the colour since our last write, start from the source.
    const c = scene.settings.ambientColor;
    const last = this.lastAmbientColor;
    const ours = last !== null && Math.abs(c.r - last.r) <= 1e-9 && Math.abs(c.g - last.g) <= 1e-9 && Math.abs(c.b - last.b) <= 1e-9;
    if (!this.driveLighting && ours && this.ambientColorSource) {
      // Lighting drive switched off: hand back the colour we were given.
      c.r = this.ambientColorSource.r;
      c.g = this.ambientColorSource.g;
      c.b = this.ambientColorSource.b;
      this.lastAmbientColor = null;
    }
    if (this.driveLighting) {
      if (!ours) this.ambientColorSource = { r: c.r, g: c.g, b: c.b };
      neutralizeAmbient(this.ambientColorSource!, overcastAmbientNeutral(this.state.cloudCoverage, this.state.storm01), c);
      const transfer = this.cloudDiffuseTransfer * (1 - 0.75 * clamp(this.state.storm01, 0, 1));
      // A cloud base is an extended source: it also fills the shadows the remaining direct beam casts.
      const add = (transfer * cloudDiffuse * (1 + this.cloudShadowFill)) / Math.max(1e-6, scene.settings.ambientIntensity);
      c.r += add;
      c.g += add;
      c.b += add;
      this.lastAmbientColor = { r: c.r, g: c.g, b: c.b };
    }
    if (this.driveSurface) {
      scene.settings.surface.wetness = this.surface.wetness;
      scene.settings.surface.puddles = this.surface.puddles;
      scene.settings.surface.snow = this.surface.snow;
    }
    // Published through the scene layer; VehicleSystem applies it on its next fixed step.
    setWorldSurfaceGrip(scene.world, this.driveVehicles ? tyreGripFactor(this.surface) : undefined);
    if (this.driveWater && scene.settings.water.enabled) this.applyWater(scene);
    this.lastAmbientOutput = scene.settings.ambientIntensity;
    this.previousSunFactor = factors.sun;
    this.previousAmbientFactor = factors.ambient;
  }

  /** Rebuild the sea from the wind when it has moved enough to matter (wave sets are not free). */
  private applyWater(scene: Scene): void {
    const s = this.state;
    if (Math.abs(s.windSpeed - this.lastWaterWind) < 0.25 && Math.abs(s.windDirection - this.lastWaterDirection) < 0.02 && Math.abs(s.storm01 - this.lastWaterStorm) < 0.02) return;
    this.lastWaterWind = s.windSpeed;
    this.lastWaterDirection = s.windDirection;
    this.lastWaterStorm = s.storm01;
    const drive = weatherOceanOptions(s);
    const extra = this.driveWater || {};
    applyOceanState(scene, oceanWavesFromWind({ seed: this.seed, ...extra, windSpeed: drive.windSpeed, direction: drive.direction, heightScale: (extra.heightScale ?? 1) * drive.heightScale, choppiness: (extra.choppiness ?? 1) * drive.choppiness }));
  }

  /** Mean wind vector (m/s, +x east / +y north→+z) at the current state. */
  meanWind(out = new Vec2()): Vec2 {
    return out.set(DMath.sin(this.state.windDirection) * this.state.windSpeed, DMath.cos(this.state.windDirection) * this.state.windSpeed);
  }

  /**
   * Wind at a world position and time (m/s): the mean wind plus gust turbulence. The turbulence
   * is bounded by `gust · (2 + 0.3 · speed)` per component and is exactly reproducible for a
   * (x, z, t, seed) tuple. `t` defaults to the simulated clock.
   */
  sampleWindAt(x: number, z: number, out = new Vec2(), t = this.simulatedSeconds): Vec2 {
    const s = this.state;
    const wx = DMath.sin(s.windDirection) * s.windSpeed;
    const wz = DMath.cos(s.windDirection) * s.windSpeed;
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
    const wx = DMath.sin(s.windDirection) * s.windSpeed;
    const wz = DMath.cos(s.windDirection) * s.windSpeed;
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
    const wx = DMath.sin(s.windDirection) * s.windSpeed;
    const wz = DMath.cos(s.windDirection) * s.windSpeed;
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
