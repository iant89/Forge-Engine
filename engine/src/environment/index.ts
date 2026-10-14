/**
 * Environment (Phases 8a + 8b): where the sun is, what the sky looks like, how far you can see —
 * and the weather that moves through it.
 *
 * - `solar.ts`      — NOAA/Meeus sun position for a latitude, longitude and UTC instant.
 * - `atmosphere.ts` — sky model + Earth/Mars presets; the CPU twin of the sky shader.
 * - `multiScattering.ts` — Phase 17.1 multiple-scattering table (second-and-higher-order light),
 *                      the CPU twin of the two passes in `rendering/shaders/multiScattering.ts`.
 * - `fog.ts`        — fog transmittance formulas, the CPU twin of the standard shader's fog.
 * - `dayNight.ts`   — `DayNightCycle` scene object that drives the sun light, ambient and fog.
 * - `weather.ts`    — `WeatherSystem`: wind/gusts/temperature/humidity/precipitation/storm state on
 *                      the fixed-step clock, with frozen-turbulence field sampling.
 * - `clouds.ts`     — the procedural cloud deck: coverage remap, the Phase 17.3 multi-layer stack
 *                      (column profile, sun-path shadow march, octave LOD fade), the CPU radiance
 *                      twin of the sky shader's deck, and the sun/ambient/horizon lighting cache.
 * - `water.ts`      — Gerstner waves (CPU sampler + `WaterSurface` mesh owner) and the underwater test.
 * - `lightning.ts`  — `LightningSystem`: Poisson-scheduled strikes, fractal bolts, flash envelope.
 *
 * Depends on `scene`, `math` and `core` only; `rendering` imports from here (never the reverse).
 */

export * from "./solar.js";
export * from "./atmosphere.js";
export * from "./multiScattering.js";
export * from "./fog.js";
export * from "./dayNight.js";
export * from "./weather.js";
export * from "./clouds.js";
export * from "./water.js";
export * from "./ocean.js";
export * from "./cyclone.js";
export * from "./lightning.js";
