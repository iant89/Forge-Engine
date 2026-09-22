/**
 * Environment (Phase 8a): where the sun is, what the sky looks like, how far you can see.
 *
 * - `solar.ts`      — NOAA/Meeus sun position for a latitude, longitude and UTC instant.
 * - `atmosphere.ts` — single-scattering sky model + Earth/Mars presets; the CPU twin of the sky shader.
 * - `fog.ts`        — fog transmittance formulas, the CPU twin of the standard shader's fog.
 * - `dayNight.ts`   — `DayNightCycle` scene object that drives the sun light, ambient and fog.
 *
 * Depends on `scene`, `math` and `core` only; `rendering` imports from here (never the reverse).
 * Weather, clouds, water and lightning are Phase 8b and will join this module.
 */

export * from "./solar.js";
export * from "./atmosphere.js";
export * from "./fog.js";
export * from "./dayNight.js";
