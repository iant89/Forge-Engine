/**
 * Dry, deterministic Mars weather profiles for the reference showcase (Phase 23.2).
 *
 * Mars does not use the terrestrial rain/snow presets: precipitation stays zero, the ground remains
 * dry, and the storm channel represents suspended dust. The shared WeatherSystem still owns the
 * fixed-step drift, wind field, cloud advection, dry storm haze and lighting attenuation; keeping the
 * profiles here makes the planet-specific choices explicit without changing the generic environment
 * contract.
 */

import type { WeatherState } from "@forge/engine";

export type MarsWeatherMode = "clear" | "dust" | "global-dust";

export const MARS_WEATHER_NAMES: readonly MarsWeatherMode[] = ["clear", "dust", "global-dust"];

/** Complete profiles so a mode switch cannot retain a terrestrial precipitation or humidity value. */
export const MARS_WEATHER_PROFILES: Readonly<Record<MarsWeatherMode, Readonly<WeatherState>>> = Object.freeze({
  clear: Object.freeze({
    windSpeed: 3.5,
    windDirection: 0.7,
    gust: 0.12,
    temperatureC: -55,
    humidity01: 0.04,
    precipitation01: 0,
    storm01: 0,
    cloudCoverage: 0.04,
  }),
  dust: Object.freeze({
    windSpeed: 14,
    windDirection: 1.1,
    gust: 0.65,
    temperatureC: -48,
    humidity01: 0.08,
    precipitation01: 0,
    storm01: 0.55,
    cloudCoverage: 0.18,
  }),
  "global-dust": Object.freeze({
    windSpeed: 24,
    windDirection: 1.25,
    gust: 1,
    temperatureC: -38,
    humidity01: 0.12,
    precipitation01: 0,
    storm01: 0.95,
    cloudCoverage: 0.55,
  }),
});

export function marsWeatherProfile(mode: MarsWeatherMode): WeatherState {
  return { ...MARS_WEATHER_PROFILES[mode] };
}
