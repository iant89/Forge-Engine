/**
 * The ambience audio input (Phase 20.5/20.6) built from the environment's state. Audio and the
 * environment do not import each other (lint:arch); this returns plain data shaped like
 * `AmbienceInput` (audio/ambience.ts) from the weather, the ground's memory of it and the listener's
 * situation, which the host passes to `EnvironmentSoundscape.update`.
 */

import { clamp } from "../math/scalar.js";
import { snowFraction, type SurfaceWeatherState } from "./surfaceWeather.js";
import type { WeatherState } from "./weather.js";

export interface AmbienceListenerContext {
  /** Sun elevation (degrees): `DayNightCycle.elevationDeg`. Default 30. */
  sunElevationDeg?: number;
  /** Listener yaw (radians, 0 faces +Z). Default 0. */
  listenerYaw?: number;
  underwater?: boolean;
  /** 0 open air … 1 indoors. */
  enclosure?: number;
  /** 0 open field … 1 canyon / street. */
  reflectivity?: number;
  /** 0..1 surf at the listener. */
  surf?: number;
}

export interface AmbienceSoundInput {
  windSpeed: number;
  windDirection: number;
  gust: number;
  rain: number;
  snowfall: number;
  storm: number;
  wetness: number;
  puddles: number;
  snowCover: number;
  sunElevationDeg: number;
  temperatureC: number;
  listenerYaw: number;
  underwater: boolean;
  enclosure: number;
  reflectivity: number;
  surf: number;
}

/** Precipitation splits into liquid rain and snowfall by temperature, as the surface model does. */
export function ambienceSoundInput(weather: WeatherState, surface: SurfaceWeatherState, context: AmbienceListenerContext = {}): AmbienceSoundInput {
  const p = clamp(weather.precipitation01, 0, 1);
  const sf = snowFraction(weather.temperatureC);
  return {
    windSpeed: Math.max(0, weather.windSpeed),
    windDirection: weather.windDirection,
    gust: clamp(weather.gust, 0, 1),
    rain: p * (1 - sf),
    snowfall: p * sf,
    storm: clamp(weather.storm01, 0, 1),
    wetness: clamp(surface.wetness, 0, 1),
    puddles: clamp(surface.puddles, 0, 1),
    snowCover: clamp(surface.snow, 0, 1),
    sunElevationDeg: context.sunElevationDeg ?? 30,
    temperatureC: weather.temperatureC,
    listenerYaw: context.listenerYaw ?? 0,
    underwater: context.underwater ?? false,
    enclosure: clamp(context.enclosure ?? 0, 0, 1),
    reflectivity: clamp(context.reflectivity ?? 0.1, 0, 1),
    surf: clamp(context.surf ?? 0, 0, 1),
  };
}
