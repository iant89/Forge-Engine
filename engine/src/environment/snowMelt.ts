/**
 * Snow melt physics (fe-38): a point energy balance, shared by per-object snow cover
 * ({@link SnowMeltSystem}) and the ground field ({@link GroundMoistureField}).
 *
 * Snow at 0 °C melts when the net energy into its surface is positive:
 *
 *   Q = (1 − α)·(S·cosθ + D)  +  h(u)·T_air  +  L_net  (+ substrate heat through a thin layer)
 *
 * S is the direct-beam irradiance (W/m²), D the diffuse sky irradiance, α the snow albedo (0.85
 * fresh → ~0.5 wet and dirty), h(u) = 5 + 4·u the bulk turbulent transfer (W/m²K, u wind m/s),
 * L_net the long-wave loss to a clear sky (−60 W/m² clear, 0 under full cover). The melt rate is
 * Q / (ρ_snow·L_f) metres of snow per second (L_f = 334 kJ/kg). Q ≤ 0 melts nothing (cold content
 * and refreeze are not tracked: liquid water instead drains out of the pack).
 * Full summer sun on fresh snow (S = 1000, cosθ = 0.7, T = 5 °C, u = 2): Q ≈ 105 + 65 − 30 ≈ 140
 * W/m² → 1.4 mm/h of water, 4.7 mm/h of 300 kg/m³ snow — the classic 10–40 mm w.e./day.
 */

import { clamp } from "../math/scalar.js";
import type { Scene } from "../scene/scene.js";
import type { Light } from "../scene/components/index.js";
import type { WeatherSystem } from "./weather.js";
import { DMath } from "../math/detmath.js";

export const LATENT_HEAT_FUSION = 334_000; // J/kg
export const WATER_DENSITY = 1000; // kg/m³
export const DEFAULT_SNOW_DENSITY = 300; // kg/m³ (settled snow)

/** What the sky and air deliver to a melting surface right now. */
export interface MeltEnvironment {
  /** Unit vector toward the sun (y up). */
  sunDirection: { x: number; y: number; z: number };
  /** Direct-beam irradiance normal to the beam, W/m² (0 at night / sun below the horizon). */
  sunIrradiance: number;
  /** Diffuse sky irradiance on a horizontal surface, W/m². */
  diffuseIrradiance: number;
  airTemperatureC: number;
  windSpeed: number;
  /** 0..1 cloud cover (long-wave loss falls with it). */
  cloudCover: number;
  /** 0..1 precipitation intensity (rain adds water to the ground field). */
  precipitation: number;
  /** 0..1 relative humidity (slows evaporation). */
  humidity: number;
}

export function createMeltEnvironment(overrides: Partial<MeltEnvironment> = {}): MeltEnvironment {
  return {
    sunDirection: { x: 0, y: 1, z: 0 },
    sunIrradiance: 0,
    diffuseIrradiance: 0,
    airTemperatureC: 0,
    windSpeed: 0,
    cloudCover: 0,
    precipitation: 0,
    humidity: 0.5,
    ...overrides,
  };
}

/** Fresh snow reflects ~85 %; wet snow ~55 %. */
export function snowAlbedo(wetness: number): number {
  return 0.85 - 0.3 * clamp(wetness, 0, 1);
}

export interface MeltSurface {
  /** cos of the angle between the surface normal and the sun (clamped ≥ 0 by the caller or here). */
  cosIncidence: number;
  /** Fraction of the sky dome the surface sees (1 flat/up, 0.5 vertical). Default 1. */
  skyView?: number;
  albedo: number;
  /** Extra heat from below (W/m², e.g. a warm engine bay or a sun-warmed dark rock through thin snow). */
  substrateFlux?: number;
}

/** Net energy into a 0 °C snow surface, W/m² (may be negative). */
export function snowEnergyBalance(env: MeltEnvironment, surface: MeltSurface): number {
  const absorb = 1 - clamp(surface.albedo, 0, 1);
  const view = clamp(surface.skyView ?? 1, 0, 1);
  const shortwave = absorb * (env.sunIrradiance * Math.max(0, surface.cosIncidence) + env.diffuseIrradiance * view);
  const sensible = (5 + 4 * Math.max(0, env.windSpeed)) * env.airTemperatureC;
  const longwave = -60 * (1 - clamp(env.cloudCover, 0, 1)) * view;
  return shortwave + sensible + longwave + (surface.substrateFlux ?? 0);
}

/** Metres of snow (of `density`) melted per second by energy `q` (W/m²); 0 when q ≤ 0. */
export function meltRate(q: number, density = DEFAULT_SNOW_DENSITY): number {
  return q > 0 ? q / (density * LATENT_HEAT_FUSION) : 0;
}

/**
 * Heat a sun-warmed substrate passes into thin snow above it: once the layer is thinner than the
 * light's ~3 cm e-folding depth, the beam reaches the object below (dark rock/paint absorbs it) and
 * conducts back up — why snow vanishes from dark objects first.
 */
export function substrateFlux(env: MeltEnvironment, depth: number, substrateAlbedo: number, cosIncidence: number): number {
  const reach = DMath.exp(-Math.max(0, depth) / 0.03);
  return reach * (1 - clamp(substrateAlbedo, 0, 1)) * env.sunIrradiance * Math.max(0, cosIncidence) * 0.6;
}

export interface MeltEnvironmentOptions {
  /** W/m² of direct beam per unit of directional-light intensity. Default 250 (sun intensity 4 → 1000 W/m²). */
  irradiancePerUnit?: number;
  /** Air temperature used when no WeatherSystem is present. Default 5 °C. */
  airTemperatureC?: number;
}

/**
 * Read the melt environment from a scene: the brightest directional light (already dimmed by the
 * weather's cloud cover) is the sun, the ambient term the diffuse sky, and the WeatherSystem (when
 * given) supplies air temperature, wind, cover, rain and humidity.
 */
export function sampleMeltEnvironment(scene: Scene, weather: WeatherSystem | null, out: MeltEnvironment, options: MeltEnvironmentOptions = {}, scratch: Light[] = []): MeltEnvironment {
  const perUnit = options.irradiancePerUnit ?? 250;
  let best: Light | null = null;
  for (const light of scene.collectLights(scratch)) {
    if (light.kind !== "directional") continue;
    if (!best || light.intensity > best.intensity) best = light;
  }
  if (best) {
    const d = best.direction;
    const len = DMath.hypot(d.x, d.y, d.z) || 1;
    out.sunDirection.x = -d.x / len;
    out.sunDirection.y = -d.y / len;
    out.sunDirection.z = -d.z / len;
    out.sunIrradiance = out.sunDirection.y > 0 ? best.intensity * perUnit : 0;
  } else {
    out.sunIrradiance = 0;
  }
  const a = scene.settings.ambientColor;
  const lum = 0.2126 * a.r + 0.7152 * a.g + 0.0722 * a.b;
  // The ambient term is a radiance (the shader multiplies albedo by it without 1/π): E = π·L.
  out.diffuseIrradiance = Math.PI * lum * scene.settings.ambientIntensity * perUnit;
  if (weather) {
    const s = weather.state;
    out.airTemperatureC = s.temperatureC;
    out.windSpeed = s.windSpeed;
    out.cloudCover = s.cloudCoverage;
    out.precipitation = s.precipitation01;
    out.humidity = s.humidity01;
  } else {
    out.airTemperatureC = options.airTemperatureC ?? 5;
  }
  return out;
}
