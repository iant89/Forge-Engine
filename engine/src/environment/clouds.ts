/**
 * Layered clouds (Phase 8b): one procedural cloud deck drawn inside the sky pass.
 *
 * The deck is a horizontal plane at `height` metres above sea level. Its density is a pure
 * function of world XZ — fbm noise remapped by the coverage so that `coverage = 0` is a clear sky
 * and `coverage = 1` is overcast, monotonically (pinned by `tests/environment8b.test.ts`). The
 * same remap and the same shading run on the CPU here and in WGSL (`rendering/shaders/sky.ts`):
 * the two agree on the formulas but not on the noise basis (the CPU samples `math/noise.ts`
 * Perlin fbm, the GPU a float32 value-noise fbm — bit equality was never on the table, and the
 * tests pin the CPU side while the browser gate pins the GPU side's presence and direction).
 *
 * Lighting comes from the Phase 8a sky, not from new constants: direct sun through
 * `AtmosphereModel.sunTransmittance`, diffuse from `AtmosphereModel.skyAmbient`, and the horizon
 * from `horizonColor` (the water's sky tint reuses it). `SkyLightingCache` evaluates the three
 * only when the sun has moved, because the hemispherical integrals cost ~0.25 ms and the sun
 * moves arcseconds per frame.
 */

import { Vec3 } from "../math/vec.js";
import { Color } from "../math/color.js";
import { clamp } from "../math/scalar.js";
import { fbm2 } from "../math/noise.js";
import { AtmosphereModel, type AtmosphereParams } from "./atmosphere.js";

/** Art parameters of the deck (mirrors `SceneCloudSettings`; the scene owns the live copy). */
export interface CloudLayerParams {
  /** Fraction of the sky covered, 0..1. */
  coverage: number;
  /** Vertical optical thickness multiplier 0..1 (thin cirrus → thunderhead). */
  density: number;
  /** Deck altitude above sea level, metres. */
  height: number;
  /** World metres per noise unit (smaller = larger clouds). */
  scale: number;
  /** Deterministic seed of the coverage field. */
  seed: number;
  /** Forward-scattering (silver lining) strength around the sun, 0..2. */
  silverLining: number;
  /** Cloud albedo (linear RGB; Mars dust clouds are pinkish). */
  albedo: Color;
}

export function defaultCloudLayerParams(): CloudLayerParams {
  return { coverage: 0, density: 0.8, height: 1500, scale: 0.0008, seed: 4242, silverLining: 0.8, albedo: new Color(1, 1, 1) };
}

/** fbm octaves behind the coverage field (both the CPU sampler and the WGSL twin use 4). */
export const CLOUD_FBM_OCTAVES = 4;

/** Coverage noise in [0, 1] at a world XZ (before the coverage remap). */
export function cloudFieldAt(x: number, z: number, scale: number, seed: number): number {
  return fbm2(x * scale, z * scale, seed, { octaves: CLOUD_FBM_OCTAVES }) * 0.5 + 0.5;
}

/**
 * Cloud density 0..1 at a world XZ: the coverage field remapped so the *mean* over a large area
 * tracks `coverage`. The remap window slides with the coverage — for a fixed noise value the
 * density is non-decreasing in coverage, which is what makes the slider honest.
 */
export function cloudDensityAt(x: number, z: number, coverage: number, density: number, scale: number, seed: number): number {
  const c = clamp(coverage, 0, 1);
  if (c <= 0) return 0;
  if (c >= 1) return clamp(density, 0, 1);
  const f = cloudFieldAt(x, z, scale, seed);
  const edge0 = 1 - c - 0.15;
  const edge1 = 1 - c + 0.25;
  const t = clamp((f - edge0) / (edge1 - edge0), 0, 1);
  const smooth = t * t * (3 - 2 * t);
  return smooth * clamp(density, 0, 1);
}

/**
 * Mean density over an N×N grid (the honest definition of "coverage"): used by the tests to pin
 * monotonicity and the clear/overcast endpoints, and by tools to calibrate the slider.
 */
export function meanCloudDensity(coverage: number, density: number, scale: number, seed: number, samples = 24, extent = 20000): number {
  let sum = 0;
  for (let iz = 0; iz < samples; iz++) {
    for (let ix = 0; ix < samples; ix++) {
      const x = (ix + 0.5 - samples / 2) * (extent / samples);
      const z = (iz + 0.5 - samples / 2) * (extent / samples);
      sum += cloudDensityAt(x, z, coverage, density, scale, seed);
    }
  }
  return sum / (samples * samples);
}

export interface CloudShading {
  /** Direct sun colour (linear RGB): `sunTransmittance × sunIntensity`. */
  sunTint: Float64Array | ArrayLike<number>;
  /** Diffuse sky light (linear RGB): `skyAmbient`. */
  ambientTint: Float64Array | ArrayLike<number>;
  /** Albedo multiplier (linear RGB). */
  albedo: Color;
  /** Forward-scattering strength (the `silverLining` knob). */
  silverLining: number;
}

/**
 * Cloud radiance (linear RGB) for a view/sun pair at a given density — the formula the sky
 * shader's cloud layer evaluates per pixel. Dense cores transmit less sun
 * (`0.25 + 0.75·e^(−2.5·d)`), everything receives the ambient, and the forward lobe
 * (`(max(cos θ, 0))^6`) silvers the lining around the sun.
 */
export function cloudRadiance(viewDir: Vec3, sunDir: Vec3, density: number, shading: CloudShading, out: Float64Array): Float64Array {
  const d = clamp(density, 0, 1);
  const cosTheta = Math.max(0, viewDir.x * sunDir.x + viewDir.y * sunDir.y + viewDir.z * sunDir.z);
  const transmitted = 0.25 + 0.75 * Math.exp(-2.5 * d);
  const silver = 1 + shading.silverLining * cosTheta ** 6;
  out[0] = shading.albedo.r * (shading.sunTint[0]! * transmitted + shading.ambientTint[0]!) * silver;
  out[1] = shading.albedo.g * (shading.sunTint[1]! * transmitted + shading.ambientTint[1]!) * silver;
  out[2] = shading.albedo.b * (shading.sunTint[2]! * transmitted + shading.ambientTint[2]!) * silver;
  return out;
}

/**
 * Opacity of the deck for a view ray: `1 − e^(−3d)`, faded near the horizon (below ~4.5° the
 * plane intersection races to infinity and the layer would alias into stripes).
 */
export function cloudAlpha(density: number, viewElevation: number): number {
  const d = clamp(density, 0, 1);
  if (d <= 0) return 0;
  const horizonFade = clamp((viewElevation - 0.005) / (0.08 - 0.005), 0, 1);
  const smooth = horizonFade * horizonFade * (3 - 2 * horizonFade);
  return (1 - Math.exp(-3 * d)) * smooth;
}

const COS_REEVALUATE = Math.cos(0.05 * (Math.PI / 180));
const SUN_TINT_SAMPLES = 16;

/**
 * Per-frame sun/ambient/horizon tints for the cloud deck and the water, evaluated from the live
 * atmosphere and recomputed only when the sun has moved by more than ~0.05° (or the atmosphere
 * or observer height changed). The renderer owns one and uploads the tints into the cloud and
 * water uniform blocks every frame; the values only move when this reports dirty.
 */
export class SkyLightingCache {
  readonly sunTint = new Float64Array(3);
  readonly ambientTint = new Float64Array(3);
  readonly horizonTint = new Float64Array(3);
  evaluations = 0;

  private readonly lastSun = new Vec3(0, 0, 0);
  private lastAtmosphere: Readonly<AtmosphereParams> | null = null;
  private lastHeight = NaN;
  private dirty = true;

  /** Force re-evaluation on the next `update` (atmosphere contents mutated in place). */
  invalidate(): void {
    this.dirty = true;
  }

  /**
   * Refresh the tints for a sun direction / atmosphere / observer height. Returns true when the
   * values were recomputed. `sunIntensity` scales the direct term (the scene's sky exposure).
   */
  update(sunDir: Vec3, atmosphere: Readonly<AtmosphereParams>, observerHeight: number, sunIntensity: number): boolean {
    const moved = this.lastSun.dot(sunDir) < COS_REEVALUATE;
    if (!this.dirty && !moved && this.lastAtmosphere === atmosphere && this.lastHeight === observerHeight) return false;
    this.dirty = false;
    this.evaluations++;
    this.lastSun.copyFrom(sunDir);
    this.lastAtmosphere = atmosphere;
    this.lastHeight = observerHeight;
    // A scratch model over the *live* params object (never copied): the tints track the scene.
    const model = new AtmosphereModel(atmosphere as AtmosphereParams);
    model.sunTransmittance(sunDir, observerHeight, this.sunTint, SUN_TINT_SAMPLES);
    this.sunTint[0]! *= sunIntensity;
    this.sunTint[1]! *= sunIntensity;
    this.sunTint[2]! *= sunIntensity;
    model.skyAmbient(sunDir, observerHeight, this.ambientTint, 12, 8, 4);
    model.horizonColor(sunDir, observerHeight, this.horizonTint, 8, 0.026, 8, 4);
    return true;
  }
}
