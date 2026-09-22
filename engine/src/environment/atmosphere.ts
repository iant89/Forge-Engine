/**
 * Analytic atmosphere (Phase 8a): single-scattering sky with Rayleigh molecules, Mie aerosols and
 * an ozone absorption layer around a spherical planet — the Nishita/O'Neil model with Bruneton's
 * sea-level coefficients. This file is the **reference implementation**: the WGSL in
 * `rendering/shaders/sky.ts` marches the same integral with the same constants (delivered through
 * `SkyUniforms`, never retyped), and `tests/environment.test.ts` pins this code against closed forms
 * and published values:
 *
 *  - `rayleighCoefficient(λ)` reproduces the (5.802, 13.558, 33.1)·10⁻⁶ m⁻¹ table for 680/550/440 nm;
 *  - the vertical Rayleigh optical depth is `β·H` (≈ 0.108 in the green — the textbook 0.1);
 *  - the horizon-to-zenith air-mass ratio of a spherical exponential atmosphere is ≈ √(πR/2H) ≈ 35;
 *  - both phase functions integrate to one over the sphere.
 *
 * Geometry: the planet is centred at the origin of "atmosphere space"; the observer sits at
 * `(0, R + h, 0)` where `h` is the height above sea level, and directions use the engine's axes
 * (+Y up), so a render-local view direction can be passed straight in. Everything is in metres.
 *
 * Radiance units are scene-relative: `sunIntensity` is the sun's irradiance at the top of the
 * atmosphere per channel, in the same units as `Light.intensity`. The model returns linear RGB.
 *
 * Nothing here allocates per call once the model exists: outputs are written into caller-provided
 * `Float64Array(3)`/`Vec3`s, so `DayNightCycle` can evaluate ambient and horizon colours every frame.
 */

import { Vec3 } from "../math/vec.js";
import type { SkyQuality } from "../scene/scene.js";

export type RGB = readonly [number, number, number];

export interface AtmosphereParams {
  /** Planet radius, metres. */
  planetRadius: number;
  /** Height of the marched atmosphere above sea level, metres (density beyond is ignored). */
  atmosphereHeight: number;
  /** Rayleigh scattering coefficient at sea level per channel, 1/m. Rayleigh does not absorb. */
  rayleighScattering: RGB;
  /** Exponential scale height of the molecular atmosphere, metres. */
  rayleighScaleHeight: number;
  /** Mie (aerosol) scattering coefficient at sea level per channel, 1/m. */
  mieScattering: RGB;
  /** Mie extinction per channel, 1/m (≥ scattering; the difference is absorption). */
  mieExtinction: RGB;
  mieScaleHeight: number;
  /** Cornette–Shanks asymmetry `g` in (−1, 1); ~0.76 for haze, higher for dust. */
  mieAnisotropy: number;
  /** Ozone absorption per channel at the layer's peak density, 1/m. */
  ozoneAbsorption: RGB;
  /** Centre and half-width (metres) of the tent-shaped ozone layer. */
  ozoneCenter: number;
  ozoneWidth: number;
  /** Albedo of the ground seen below the horizon (per channel). */
  groundAlbedo: RGB;
  /** Sun irradiance at the top of the atmosphere, per channel (scene units). */
  sunIntensity: number;
  /** Samples along the view ray and along each light ray. */
  viewSamples: number;
  lightSamples: number;
}

/**
 * Earth: Bruneton & Neyret 2008 coefficients (Rayleigh at 680/550/440 nm, Mie with albedo 0.9),
 * scale heights 8 km / 1.2 km, ozone layer peaking at 25 km.
 */
export const EARTH_ATMOSPHERE: Readonly<AtmosphereParams> = Object.freeze({
  planetRadius: 6371e3,
  atmosphereHeight: 80e3,
  rayleighScattering: [5.802e-6, 13.558e-6, 33.1e-6] as const,
  rayleighScaleHeight: 8000,
  mieScattering: [3.996e-6, 3.996e-6, 3.996e-6] as const,
  mieExtinction: [4.44e-6, 4.44e-6, 4.44e-6] as const,
  mieScaleHeight: 1200,
  mieAnisotropy: 0.76,
  ozoneAbsorption: [0.65e-6, 1.881e-6, 0.085e-6] as const,
  ozoneCenter: 25e3,
  ozoneWidth: 15e3,
  groundAlbedo: [0.1, 0.1, 0.1] as const,
  sunIntensity: 20,
  viewSamples: 16,
  lightSamples: 8,
});

/**
 * Mars: a thin CO₂ atmosphere (~0.6 % of Earth's surface pressure; CO₂ scatters ~2.5× per molecule)
 * with an 11 km scale height, and suspended dust that scatters red more than blue and absorbs blue
 * — which is what makes the daytime sky butterscotch. No ozone layer. Values are tuned to the
 * qualitative record (Viking/Pathfinder sky colour), not measured coefficients; the famous blue
 * sunset aureole needs a wavelength-dependent Mie lobe, which this single-`g` model does not have.
 */
export const MARS_ATMOSPHERE: Readonly<AtmosphereParams> = Object.freeze({
  planetRadius: 3389.5e3,
  atmosphereHeight: 90e3,
  rayleighScattering: [0.087e-6, 0.203e-6, 0.497e-6] as const,
  rayleighScaleHeight: 11100,
  mieScattering: [33e-6, 21e-6, 10e-6] as const,
  mieExtinction: [36e-6, 30e-6, 26e-6] as const,
  mieScaleHeight: 11000,
  mieAnisotropy: 0.7,
  ozoneAbsorption: [0, 0, 0] as const,
  ozoneCenter: 25e3,
  ozoneWidth: 15e3,
  groundAlbedo: [0.25, 0.15, 0.08] as const,
  sunIntensity: 20,
  viewSamples: 16,
  lightSamples: 8,
});

/**
 * Ray-march sample counts (view samples, light samples per view sample) behind
 * `SceneSkySettings.quality`. The renderer marches the sky pass with these and `DayNightCycle`
 * evaluates its horizon colour with the same pair, so the fog colour matches the sky it fades into.
 */
export const SKY_QUALITY_SAMPLES: Readonly<Record<SkyQuality, readonly [number, number]>> = Object.freeze({
  low: [8, 4] as const,
  medium: [16, 8] as const,
  high: [32, 16] as const,
});

/** A mutable copy of `base` with `overrides` applied (arrays are copied, never shared). */
export function createAtmosphere(overrides: Partial<AtmosphereParams> = {}, base: Readonly<AtmosphereParams> = EARTH_ATMOSPHERE): AtmosphereParams {
  const copy = (c: RGB): RGB => [c[0], c[1], c[2]];
  const merged = { ...base, ...overrides };
  return {
    ...merged,
    rayleighScattering: copy(merged.rayleighScattering),
    mieScattering: copy(merged.mieScattering),
    mieExtinction: copy(merged.mieExtinction),
    ozoneAbsorption: copy(merged.ozoneAbsorption),
    groundAlbedo: copy(merged.groundAlbedo),
  };
}

// ------------------------------------------------------------------ closed forms

/**
 * Rayleigh scattering coefficient of air at sea level for a wavelength in nanometres, 1/m:
 * `β = 8π³ (n² − 1)² / (3 N λ⁴) · (6 + 3ρ) / (6 − 7ρ)` with refractive index `n = 1.0003`,
 * number density `N = 2.545·10²⁵ m⁻³` and King's depolarisation factor `ρ = 0.035`. Reproduces
 * the 680/550/440 nm table in `EARTH_ATMOSPHERE.rayleighScattering` to better than 1 %.
 */
export function rayleighCoefficient(wavelengthNm: number, options: { refractiveIndex?: number; numberDensity?: number; depolarization?: number } = {}): number {
  const n = options.refractiveIndex ?? 1.0003;
  const N = options.numberDensity ?? 2.545e25;
  const rho = options.depolarization ?? 0.035;
  const lambda = wavelengthNm * 1e-9;
  const n2 = n * n - 1;
  const king = (6 + 3 * rho) / (6 - 7 * rho);
  return ((8 * Math.PI ** 3 * n2 * n2) / (3 * N * lambda ** 4)) * king;
}

/** Rayleigh phase function, normalised over the sphere. */
export function rayleighPhase(cosTheta: number): number {
  return (3 / (16 * Math.PI)) * (1 + cosTheta * cosTheta);
}

/** Cornette–Shanks aerosol phase function, normalised over the sphere. */
export function miePhase(cosTheta: number, g: number): number {
  const g2 = g * g;
  const denom = 1 + g2 - 2 * g * cosTheta;
  return ((3 * (1 - g2)) / (8 * Math.PI * (2 + g2))) * ((1 + cosTheta * cosTheta) / (denom * Math.sqrt(denom)));
}

/** Henyey–Greenstein phase function (kept for callers that want the cheaper lobe). */
export function henyeyGreensteinPhase(cosTheta: number, g: number): number {
  const g2 = g * g;
  const denom = 1 + g2 - 2 * g * cosTheta;
  return (1 - g2) / (4 * Math.PI * denom * Math.sqrt(denom));
}

/**
 * Ray/sphere intersections for a sphere at the origin. Returns the far root (the exit distance) or
 * −1 when the ray misses or the sphere lies entirely behind the origin.
 */
export function raySphereExit(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, radius: number): number {
  const b = ox * dx + oy * dy + oz * dz;
  const c = ox * ox + oy * oy + oz * oz - radius * radius;
  const disc = b * b - c;
  if (disc < 0) return -1;
  const t = -b + Math.sqrt(disc);
  return t < 0 ? -1 : t;
}

/** Nearest positive intersection distance with a sphere at the origin, or −1. */
export function raySphereEntry(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, radius: number): number {
  const b = ox * dx + oy * dy + oz * dz;
  const c = ox * ox + oy * oy + oz * oz - radius * radius;
  const disc = b * b - c;
  if (disc < 0) return -1;
  const s = Math.sqrt(disc);
  const t0 = -b - s;
  if (t0 > 0) return t0;
  const t1 = -b + s;
  return t1 > 0 ? t1 : -1;
}

// ------------------------------------------------------------------ model

/**
 * Evaluates the atmosphere for one parameter set. All methods take directions as unit vectors in
 * engine axes and the observer height above sea level in metres; results are linear RGB in
 * `sunIntensity` units. The sample counts come from the params unless a method says otherwise.
 */
export class AtmosphereModel {
  private readonly od = new Float64Array(3);
  private readonly odLight = new Float64Array(3);
  private readonly sum = new Float64Array(6);
  private readonly tmp = new Float64Array(3);

  constructor(readonly params: AtmosphereParams) {}

  /** Tent-profile ozone density in [0, 1] at height `h` above sea level. */
  ozoneDensity(h: number): number {
    const p = this.params;
    return p.ozoneWidth > 0 ? Math.max(0, 1 - Math.abs(h - p.ozoneCenter) / p.ozoneWidth) : 0;
  }

  /**
   * Optical depth per channel along a ray from `(ox, oy, oz)` in direction `(dx, dy, dz)` over
   * `length` metres, midpoint rule with `samples` segments. Includes Rayleigh, Mie extinction and
   * ozone. Writes `out` and returns it.
   */
  opticalDepth(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, length: number, samples: number, out: Float64Array): Float64Array {
    const p = this.params;
    const ds = length / samples;
    let dR = 0;
    let dM = 0;
    let dO = 0;
    for (let i = 0; i < samples; i++) {
      const t = (i + 0.5) * ds;
      const px = ox + dx * t;
      const py = oy + dy * t;
      const pz = oz + dz * t;
      const h = Math.sqrt(px * px + py * py + pz * pz) - p.planetRadius;
      dR += Math.exp(-h / p.rayleighScaleHeight) * ds;
      dM += Math.exp(-h / p.mieScaleHeight) * ds;
      dO += this.ozoneDensity(h) * ds;
    }
    out[0] = p.rayleighScattering[0] * dR + p.mieExtinction[0] * dM + p.ozoneAbsorption[0] * dO;
    out[1] = p.rayleighScattering[1] * dR + p.mieExtinction[1] * dM + p.ozoneAbsorption[1] * dO;
    out[2] = p.rayleighScattering[2] * dR + p.mieExtinction[2] * dM + p.ozoneAbsorption[2] * dO;
    return out;
  }

  /**
   * Transmittance from a point at `height` above sea level to the top of the atmosphere along a
   * unit direction; zero when the ray hits the planet. `samples` defaults to `lightSamples`.
   */
  transmittance(height: number, dx: number, dy: number, dz: number, out: Float64Array, samples = this.params.lightSamples): Float64Array {
    const p = this.params;
    const oy = p.planetRadius + Math.max(0, height);
    if (raySphereEntry(0, oy, 0, dx, dy, dz, p.planetRadius) > 0) {
      out[0] = out[1] = out[2] = 0;
      return out;
    }
    const tTop = raySphereExit(0, oy, 0, dx, dy, dz, p.planetRadius + p.atmosphereHeight);
    if (tTop <= 0) {
      out[0] = out[1] = out[2] = 1;
      return out;
    }
    this.opticalDepth(0, oy, 0, dx, dy, dz, tTop, samples, this.tmp);
    out[0] = Math.exp(-this.tmp[0]!);
    out[1] = Math.exp(-this.tmp[1]!);
    out[2] = Math.exp(-this.tmp[2]!);
    return out;
  }

  /** Transmittance toward the sun for an observer at `height` (the colour of direct sunlight). */
  sunTransmittance(sunDir: Vec3, height: number, out: Float64Array, samples = this.params.lightSamples): Float64Array {
    return this.transmittance(height, sunDir.x, sunDir.y, sunDir.z, out, samples);
  }

  /**
   * Single-scattered sky radiance (plus the lit ground below the horizon) seen from `height` along
   * `viewDir` with the sun at `sunDir`. This is the integral the sky shader evaluates per pixel.
   */
  skyRadiance(viewDir: Vec3, sunDir: Vec3, height: number, out: Float64Array, viewSamples = this.params.viewSamples, lightSamples = this.params.lightSamples, phaseG = this.params.mieAnisotropy): Float64Array {
    const p = this.params;
    const R = p.planetRadius;
    const oy = R + Math.max(0, height);
    const dx = viewDir.x;
    const dy = viewDir.y;
    const dz = viewDir.z;
    out[0] = out[1] = out[2] = 0;
    const tTop = raySphereExit(0, oy, 0, dx, dy, dz, R + p.atmosphereHeight);
    if (tTop <= 0) return out;
    const tGround = raySphereEntry(0, oy, 0, dx, dy, dz, R);
    const hitsGround = tGround > 0;
    const tMax = hitsGround ? tGround : tTop;
    const cosTheta = dx * sunDir.x + dy * sunDir.y + dz * sunDir.z;
    const phaseR = rayleighPhase(cosTheta);
    const phaseM = miePhase(cosTheta, phaseG);
    const od = this.od;
    const odl = this.odLight;
    const sum = this.sum;
    sum.fill(0);
    let odR = 0;
    let odM = 0;
    let odO = 0;
    const invN = 1 / viewSamples;
    let tPrev = 0;
    for (let i = 0; i < viewSamples; i++) {
      // Cubic spacing: segment i spans tMax·[(i/N)³, ((i+1)/N)³]. A horizon ray is hundreds of
      // kilometres long but nearly all of its in-scattered blue comes from the first few tens, so
      // uniform segments miss most of it at low sample counts (the shader uses the same spacing).
      const u = (i + 1) * invN;
      const tNext = tMax * u * u * u;
      const ds = tNext - tPrev;
      const t = 0.5 * (tPrev + tNext);
      tPrev = tNext;
      const px = dx * t;
      const py = oy + dy * t;
      const pz = dz * t;
      const h = Math.sqrt(px * px + py * py + pz * pz) - R;
      const dR = Math.exp(-h / p.rayleighScaleHeight) * ds;
      const dM = Math.exp(-h / p.mieScaleHeight) * ds;
      const dO = this.ozoneDensity(h) * ds;
      odR += dR;
      odM += dM;
      odO += dO;
      if (raySphereEntry(px, py, pz, sunDir.x, sunDir.y, sunDir.z, R) > 0) continue; // sun below the local horizon
      const tLight = raySphereExit(px, py, pz, sunDir.x, sunDir.y, sunDir.z, R + p.atmosphereHeight);
      if (tLight <= 0) continue;
      this.opticalDepth(px, py, pz, sunDir.x, sunDir.y, sunDir.z, tLight, lightSamples, odl);
      for (let c = 0; c < 3; c++) {
        od[c] = p.rayleighScattering[c]! * odR + p.mieExtinction[c]! * odM + p.ozoneAbsorption[c]! * odO;
        const attenuation = Math.exp(-(od[c]! + odl[c]!));
        sum[c] += attenuation * dR;
        sum[3 + c] += attenuation * dM;
      }
    }
    for (let c = 0; c < 3; c++) {
      out[c] = p.sunIntensity * (p.rayleighScattering[c]! * sum[c]! * phaseR + p.mieScattering[c]! * sum[3 + c]! * phaseM);
    }
    if (hitsGround) {
      // Lambertian ground lit by the attenuated sun, seen through the whole view path.
      const gx = dx * tGround;
      const gy = oy + dy * tGround;
      const gz = dz * tGround;
      const len = Math.sqrt(gx * gx + gy * gy + gz * gz) || 1;
      const nDotL = Math.max(0, (gx * sunDir.x + gy * sunDir.y + gz * sunDir.z) / len);
      if (nDotL > 0) {
        this.transmittance(len - R, sunDir.x, sunDir.y, sunDir.z, odl, lightSamples);
        for (let c = 0; c < 3; c++) {
          const viewT = Math.exp(-(p.rayleighScattering[c]! * odR + p.mieExtinction[c]! * odM + p.ozoneAbsorption[c]! * odO));
          out[c] += viewT * (p.groundAlbedo[c]! / Math.PI) * p.sunIntensity * odl[c]! * nDotL;
        }
      }
    }
    return out;
  }

  /**
   * Cosine-weighted mean sky radiance over the upper hemisphere (irradiance / π) from `count`
   * Fibonacci-distributed directions; this is what `DayNightCycle` writes as the ambient colour.
   */
  skyAmbient(sunDir: Vec3, height: number, out: Float64Array, count = 24, viewSamples = 8, lightSamples = 4): Float64Array {
    out[0] = out[1] = out[2] = 0;
    const dir = SCRATCH_DIR;
    const golden = Math.PI * (3 - Math.sqrt(5));
    // A strongly forward-peaked Mie lobe (dust) cannot be integrated by a few dozen directions —
    // whichever sample lands nearest the sun dominates the mean. The estimate therefore evaluates
    // the lobe with |g| capped at ESTIMATE_G: the scattered energy is unchanged (the phase function
    // is normalised), only its angular spread is widened to what the sample set can resolve.
    const g = clampG(this.params.mieAnisotropy);
    for (let i = 0; i < count; i++) {
      // Cosine-weighted hemisphere: y = sqrt(1 - u) gives pdf ∝ cos θ, so a plain mean is E/π.
      const u = (i + 0.5) / count;
      const y = Math.sqrt(1 - u);
      const r = Math.sqrt(u);
      const phi = i * golden;
      dir.set(r * Math.cos(phi), y, r * Math.sin(phi));
      this.skyRadiance(dir, sunDir, height, this.tmp, viewSamples, lightSamples, g);
      out[0] += this.tmp[0]!;
      out[1] += this.tmp[1]!;
      out[2] += this.tmp[2]!;
    }
    out[0] /= count;
    out[1] /= count;
    out[2] /= count;
    return out;
  }

  /**
   * Mean sky radiance just above the horizon (elevation `elevationRad`, default 1.5°) over `count`
   * azimuths — the colour distant geometry should fade to when fog is driven by the sky.
   */
  horizonColor(sunDir: Vec3, height: number, out: Float64Array, count = 8, elevationRad = 0.026, viewSamples = 8, lightSamples = 4): Float64Array {
    out[0] = out[1] = out[2] = 0;
    const dir = SCRATCH_DIR;
    const ce = Math.cos(elevationRad);
    const se = Math.sin(elevationRad);
    const g = clampG(this.params.mieAnisotropy); // see skyAmbient
    for (let i = 0; i < count; i++) {
      const a = ((i + 0.5) / count) * Math.PI * 2;
      dir.set(ce * Math.sin(a), se, ce * Math.cos(a));
      this.skyRadiance(dir, sunDir, height, this.tmp, viewSamples, lightSamples, g);
      out[0] += this.tmp[0]!;
      out[1] += this.tmp[1]!;
      out[2] += this.tmp[2]!;
    }
    out[0] /= count;
    out[1] /= count;
    out[2] /= count;
    return out;
  }
}

const SCRATCH_DIR = new Vec3();
/** Widest Mie lobe the hemispherical estimates evaluate (see `AtmosphereModel.skyAmbient`). */
const ESTIMATE_G = 0.5;
function clampG(g: number): number {
  return Math.max(-ESTIMATE_G, Math.min(ESTIMATE_G, g));
}
