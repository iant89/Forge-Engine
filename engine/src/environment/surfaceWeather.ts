/**
 * Surface weather (Phase 17.4): what the weather *leaves on the ground* and what that does to the
 * simulation.
 *
 * `WeatherState` is the atmosphere; {@link SurfaceWeatherState} is the ground's memory of it —
 * wetness, standing water (puddles) and snow depth — integrated over time, so a shower wets a road
 * within a minute but it takes ten to dry, and snow only lies once the air is below freezing.
 * Everything here is pure and deterministic; `WeatherSystem` owns one instance and publishes it to
 * `scene.settings.surface` (the renderer's terrain/standard shading reads it) and to gameplay through
 * {@link tyreGripFactor} (vehicle traction), {@link weatherSoundInput} (audio),
 * {@link weatherPrecipitationDrive} (rain/snow particles) and {@link weatherOceanOptions} (water).
 */

import { clamp } from "../math/scalar.js";
import type { WeatherState } from "./weather.js";
import { DMath } from "../math/detmath.js";

export interface SurfaceWeatherState {
  /** 0..1 film wetness (darkens albedo, raises gloss). */
  wetness: number;
  /** 0..1 standing water on flat ground (puddle coverage). */
  puddles: number;
  /** 0..1 snow cover (1 ≈ fully covered up-facing ground). */
  snow: number;
}

export interface SurfaceWeatherRates {
  /** Seconds for a cloudburst to fully wet dry ground. Default 45. */
  wetting: number;
  /** Seconds (at 15 °C, 50 % RH, no wind) for wet ground to dry by 1/e. Default 600. */
  drying: number;
  /** Seconds of cloudburst to fill puddles completely. Default 600. */
  puddleFill: number;
  /** Seconds for puddles to drain/evaporate by 1/e (×4 slower than drying). Default 2400. */
  puddleDrain: number;
  /** Seconds of heavy snowfall to fully cover the ground. Default 600. */
  snowFall: number;
  /** Seconds per °C above zero to melt full cover. Default 900. */
  snowMelt: number;
}

export const DEFAULT_SURFACE_RATES: Readonly<SurfaceWeatherRates> = Object.freeze({
  wetting: 45,
  drying: 600,
  puddleFill: 600,
  puddleDrain: 2400,
  snowFall: 600,
  snowMelt: 900,
});

export function createSurfaceWeather(): SurfaceWeatherState {
  return { wetness: 0, puddles: 0, snow: 0 };
}

/** Fraction of precipitation falling as snow at `temperatureC` (0 above +2 °C, 1 below −1 °C). */
export function snowFraction(temperatureC: number): number {
  return clamp((2 - temperatureC) / 3, 0, 1);
}

/**
 * Advance the surface state by `dt` seconds under `weather`. Rain wets (and, past half intensity,
 * fills puddles); snow accumulates when cold and melts — into wetness — when warm; evaporation
 * scales with temperature, dryness of the air and wind. Pure; mutates and returns `state`.
 */
export function stepSurfaceWeather(state: SurfaceWeatherState, weather: WeatherState, dt: number, rates: SurfaceWeatherRates = DEFAULT_SURFACE_RATES): SurfaceWeatherState {
  if (!(dt > 0) || !Number.isFinite(dt)) return state;
  const p = clamp(weather.precipitation01, 0, 1);
  const sf = snowFraction(weather.temperatureC);
  const rain = p * (1 - sf);
  const snowfall = p * sf;
  // Evaporation: warmer, drier, windier air dries faster; frozen ground barely dries.
  const warm = clamp((weather.temperatureC + 5) / 20, 0.05, 2);
  const dryAir = clamp(1 - weather.humidity01, 0.05, 1) * 2;
  const wind = 1 + Math.max(0, weather.windSpeed) / 10;
  const evaporation = (warm * dryAir * wind) / rates.drying;
  // Melt (°C above zero), feeding wetness.
  const melt = state.snow > 0 ? (Math.max(0, weather.temperatureC) / rates.snowMelt) * dt : 0;
  const melted = Math.min(state.snow, melt);
  state.snow = clamp(state.snow - melted + (snowfall / rates.snowFall) * dt, 0, 1);
  // Wetness relaxes toward the rain intensity (any measurable rain wets fully over time).
  const wetTarget = rain > 0.02 ? 1 : 0;
  if (rain > 0.02) state.wetness += (wetTarget - state.wetness) * (1 - DMath.exp(-(dt * (0.25 + rain)) / rates.wetting));
  state.wetness = clamp(state.wetness + melted * 2 - state.wetness * (1 - DMath.exp(-dt * evaporation)) * (rain > 0.02 ? 0 : 1), 0, 1);
  // Puddles need sustained rain over already-wet ground.
  const fill = Math.max(0, rain - 0.5) * state.wetness;
  if (fill > 0) state.puddles = clamp(state.puddles + (fill / 0.5 / rates.puddleFill) * dt, 0, 1);
  else state.puddles = clamp(state.puddles * DMath.exp((-dt * evaporation * rates.drying) / rates.puddleDrain), 0, 1);
  // Puddles can't outlast the film around them by much.
  state.puddles = Math.min(state.puddles, Math.min(1, state.wetness * 1.25));
  return state;
}

/**
 * Tyre–road friction multiplier for a surface state (1 = dry). Wet asphalt keeps ≈ 75 % of dry μ,
 * standing water drops it toward ≈ 55 % (partial aquaplaning), packed snow ≈ 30 %. Multiplies the
 * Pacejka peak `D = μ·Fz` in `Vehicle` through `Vehicle.surfaceGrip`.
 */
export function tyreGripFactor(surface: SurfaceWeatherState): number {
  const wet = 1 - 0.25 * clamp(surface.wetness, 0, 1);
  const puddle = 1 - 0.27 * clamp(surface.puddles, 0, 1);
  const snow = 1 - 0.7 * Math.sqrt(clamp(surface.snow, 0, 1));
  return clamp(Math.min(wet * puddle, snow), 0.2, 1);
}

/** The audio driver input (`StormSoundscape.set`) for a weather state. */
export function weatherSoundInput(weather: WeatherState, surf = 0): { windSpeed: number; gust: number; rain: number; surf: number } {
  const p = clamp(weather.precipitation01, 0, 1) * (1 - snowFraction(weather.temperatureC) * 0.85);
  return { windSpeed: Math.max(0, weather.windSpeed), gust: clamp(weather.gust, 0, 1), rain: p, surf: clamp(surf, 0, 1) };
}

/** A `PrecipitationField` drive callback body for a weather state (snow falls as slow, wind-led flakes). */
export function weatherPrecipitationDrive(weather: WeatherState): { intensity: number; windX: number; windZ: number; snow: number } {
  return {
    intensity: clamp(weather.precipitation01, 0, 1),
    windX: DMath.sin(weather.windDirection) * weather.windSpeed,
    windZ: DMath.cos(weather.windDirection) * weather.windSpeed,
    snow: snowFraction(weather.temperatureC),
  };
}

/** `oceanWavesFromWind` options for a weather state: the sea follows the wind, storms raise it. */
export function weatherOceanOptions(weather: WeatherState): { windSpeed: number; direction: number; choppiness: number; heightScale: number } {
  // Compass direction (clockwise from north, toward) → water XZ angle (atan2(z, x)).
  const direction = Math.PI / 2 - weather.windDirection;
  return {
    windSpeed: Math.max(0, weather.windSpeed),
    direction,
    choppiness: 1 + 0.35 * clamp(weather.storm01, 0, 1) + 0.15 * clamp(weather.precipitation01, 0, 1),
    heightScale: 0.55 + 0.45 * clamp(weather.storm01, 0, 1),
  };
}

/**
 * Visibility (metres to 5 % contrast) for a fog density — Koschmieder, `ln 20 / σ` — so tests and
 * gameplay (AI sight range) read the same number the renderer's exponential fog produces.
 */
export function visibilityForFogDensity(density: number): number {
  return density > 1e-6 ? DMath.log(20) / density : Number.POSITIVE_INFINITY;
}
