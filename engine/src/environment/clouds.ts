/**
 * Layered clouds (Phase 8b, extended by Phase 17.3): a procedural cloud deck drawn inside the sky
 * pass and, since 17.3, shading the scene below it.
 *
 * The deck is a **stack of sub-layers** — up to {@link MAX_CLOUD_LAYERS} horizontal sheets evenly
 * spaced through a slab of `thickness` metres centred on `height` above sea level. Each sheet's
 * density is a pure function of world XZ — fbm noise remapped by the coverage so that
 * `coverage = 0` is a clear sky and `coverage = 1` is overcast, monotonically (pinned by
 * `tests/environment/environment8b.test.ts`) — and each sheet advects slightly differently, so
 * the stack gains vertical structure instead of being one pattern repeated. `layerCount = 1`
 * reproduces the Phase 8b single plane exactly, which is what keeps the 8b pins valid.
 *
 * The same remap, the same stacking, the same sun-path march and the same LOD fade run on the CPU
 * here and in WGSL (`rendering/shaders/cloudLayer.ts`): the two agree on the formulas but not on the
 * noise basis (the CPU samples `math/noise.ts` Perlin fbm, the GPU a float32 value-noise fbm — bit
 * equality was never on the table, and the tests pin the CPU side while the browser gate pins the
 * GPU side's presence and direction).
 *
 * Lighting comes from the Phase 8a sky, not from new constants: direct sun through
 * `AtmosphereModel.sunTransmittance`, diffuse from `AtmosphereModel.skyAmbient`, and the horizon
 * from `horizonColor` (the water's sky tint reuses it). `SkyLightingCache` evaluates the three
 * only when the sun has moved, because the hemispherical integrals cost ~0.25 ms and the sun
 * moves arcseconds per frame.
 *
 * Phase 17.3 adds three things on top of the 8b plane:
 *
 *  - {@link cloudDeckColumnAt} / {@link cloudDeckRadiance}: the stack's column density and the
 *    front-to-back composite the sky pass evaluates per pixel;
 *  - {@link cloudDeckShadowTau} / {@link cloudDeckTransmittance}: the sun ray's optical depth
 *    through the stack — the deck's own shading uses it per layer (better shadowing *inside* the
 *    cloud) and terrain/standard/water geometry uses it to receive the deck's shadow;
 *  - {@link cloudOctaveWeight} / {@link cloudFieldLod}: an octave fade against the sampling
 *    footprint (the deck's own "mipmap"), so a grazing ray stops resolving octaves it cannot
 *    resolve instead of aliasing them into frame-to-frame shimmer. The fade scales the octave's
 *    contribution; the normaliser keeps counting it, so faded detail really does thin out.
 */

import { Vec3 } from "../math/vec.js";
import { Color } from "../math/color.js";
import { clamp } from "../math/scalar.js";
import { perlin2 } from "../math/noise.js";
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

/** Lacunarity of the octave series — the same value `fbm2` and the WGSL loop step by. */
export const CLOUD_FBM_LACUNARITY = 2.03;

/**
 * Temporal-stability window (Phase 17.3): an octave whose world wavelength is shorter than this
 * many sampling footprints is invisible to the raster anyway and fades to zero over the next few
 * (the Nyquist band). Without it a grazing ray resolves a different octave per pixel per frame and
 * the deck's horizon shimmers; with it the far deck settles into the octaves it can actually hold.
 */
export const CLOUD_DETAIL_FADE_NEAR = 1;
export const CLOUD_DETAIL_FADE_FAR = 3;

/**
 * How much of octave `i` survives at a footprint of `footprintNoise` noise units. Octave `i`'s
 * wavelength is `lacunarity^-i` noise units, so the fade is the Nyquist band around the footprint.
 * The *normaliser* in the fbm below is deliberately not faded: a fade must shrink the octave's
 * contribution, not renormalise it away, or the series would never thin out.
 */
export function cloudOctaveWeight(octave: number, footprintNoise: number): number {
  if (footprintNoise <= 0) return 1;
  const wavelength = CLOUD_FBM_LACUNARITY ** -octave;
  const t = clamp((wavelength / footprintNoise - CLOUD_DETAIL_FADE_NEAR) / (CLOUD_DETAIL_FADE_FAR - CLOUD_DETAIL_FADE_NEAR), 0, 1);
  return t * t * (3 - 2 * t);
}

/** The same in world metres: octave `i` of a field whose scale is `scale` metres⁻¹. */
export function cloudOctaveFade(octave: number, scale: number, footprint: number): number {
  return cloudOctaveWeight(octave, footprint * scale);
}

/**
 * fbm in *noise units* with the octave fade — the CPU twin of the WGSL `cloudFbm` (same 4 octaves,
 * same lacunarity, same normalisation). `perlin2` is the CPU basis and value noise the GPU one, so
 * the two agree on the formula and the statistics, never bit-for-bit.
 */
export function cloudFieldLod(px: number, pz: number, seed: number, footprintNoise: number): number {
  let sum = 0;
  let amp = 0.5;
  let norm = 0;
  let qx = px;
  let qz = pz;
  for (let i = 0; i < CLOUD_FBM_OCTAVES; i++) {
    const fade = cloudOctaveWeight(i, footprintNoise);
    if (fade > 0.001) {
      sum += perlin2(qx, qz, (seed + i * 0x9e3779b9) | 0) * amp * fade;
      norm += amp;
    } else if (footprintNoise > 0) {
      break; // nothing further up the series can be resolvable either
    }
    amp *= 0.5;
    qx = qx * CLOUD_FBM_LACUNARITY + 11.3;
    qz = qz * CLOUD_FBM_LACUNARITY - 7.7;
  }
  return norm > 0 ? sum / norm : 0;
}

/**
 * The footprint one pixel covers at the deck's own plane (metres) — the analytic twin of the
 * `dpdx`/`dpdy` the sky shader measures, for tests and tools. A ray at `elevation` radians from an
 * observer `deckHeight - observerHeight` metres below the plane hits it `dh/sin(el)` metres out;
 * moving one pixel sideways moves that hit point by `pixelAngle·distance`, and moving it *up or
 * down* moves it by `pixelAngle·distance/sin(el)`, which is the term that dominates near the
 * horizon (~2.7 km per pixel at 1.7°, at a 1.5 km deck — this is why the deck aliases there).
 */
export function cloudFootprintAt(deckHeight: number, observerHeight: number, elevation: number, pixelAngle: number): number {
  const dh = Math.max(deckHeight - observerHeight, 0);
  const el = Math.max(elevation, 1e-3);
  return pixelAngle * (dh / Math.sin(el)) * Math.max(1, 1 / Math.sin(el));
}

/** Coverage noise in [0, 1] at a world XZ (before the coverage remap). */
export function cloudFieldAt(x: number, z: number, scale: number, seed: number, footprint = 0): number {
  // One code path with or without a footprint: a footprint of zero fades nothing, so the field is
  // continuous as the fade switches in (a branch to a second noise realisation would not be).
  return cloudFieldLod(x * scale, z * scale, seed, footprint * scale) * 0.5 + 0.5;
}

/**
 * Cloud density 0..1 at a world XZ: the coverage field remapped so the *mean* over a large area
 * tracks `coverage`. The remap window slides with the coverage — for a fixed noise value the
 * density is non-decreasing in coverage, which is what makes the slider honest.
 */
export function cloudDensityAt(x: number, z: number, coverage: number, density: number, scale: number, seed: number, footprint = 0): number {
  const c = clamp(coverage, 0, 1);
  if (c <= 0) return 0;
  if (c >= 1) return clamp(density, 0, 1);
  const f = cloudFieldAt(x, z, scale, seed, footprint);
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
 * (`0.25 + 0.75·e^(−2.5·(d + sunPathDensity))`), everything receives the ambient, and the forward
 * lobe (`(max(cos θ, 0))^6`) silvers the lining around the sun. `sunPathDensity` is the shader's
 * three-sample deck self-shadow integral; callers without a spatial density field may omit it.
 */
export function cloudRadiance(viewDir: Vec3, sunDir: Vec3, density: number, shading: CloudShading, out: Float64Array, sunPathDensity = 0): Float64Array {
  const d = clamp(density, 0, 1);
  const shadow = Math.max(0, sunPathDensity);
  const cosTheta = Math.max(0, viewDir.x * sunDir.x + viewDir.y * sunDir.y + viewDir.z * sunDir.z);
  const transmitted = 0.25 + 0.75 * Math.exp(-2.5 * (d + shadow));
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

// ------------------------------------------------------------------ Phase 17.3: the layered deck

/** Sub-layers a deck can be split into — the length of `CloudUniforms.layers`. */
export const MAX_CLOUD_LAYERS = 4;
/**
 * Extinction per unit of a layer's column density: `alpha = 1 − e^(−CLOUD_EXTINCTION·column)`.
 * `layerCount = 1` gives exactly the Phase 8b `1 − e^(−3d)`.
 */
export const CLOUD_EXTINCTION = 3;
/** The same extinction for the sun's path through the deck (the 8b shading curve, generalised). */
export const CLOUD_SUN_EXTINCTION = 2.5;
/** Dense cores never go completely black — the 8b art floor, kept per layer. */
export const CLOUD_MIN_TRANSMIT = 0.25;
/** Sun-ray samples a *shaded pixel* takes through the stack by default (the device's step count). */
export const CLOUD_SHADOW_STEPS = 3;
/** The CPU reference march: dense enough that its own step error is far below the noise-basis gap. */
export const CLOUD_SHADOW_REFERENCE_STEPS = 24;
/** Clamp on the sun ray's secant (1/cos elevation): a sun on the horizon must not march forever. */
export const CLOUD_SUN_SECANT_LIMIT = 8;

/**
 * The multi-layer deck's arithmetic (Phase 17.3) — the fields `SceneCloudSettings` carries. The
 * scene's own object is structurally compatible, so it can be passed in directly.
 */
export interface CloudDeckParams {
  coverage: number;
  density: number;
  /** Deck altitude above sea level, metres — the *centre* of the slab. */
  height: number;
  /** Total vertical extent of the deck, metres (sub-layers are evenly spaced through it). */
  thickness: number;
  /** World metres per noise unit of the bottom layer. */
  scale: number;
  seed: number;
  /** Sub-layers, 1..MAX_CLOUD_LAYERS. 1 is the Phase 8b plane. */
  layers: number;
  /** Per-layer noise-scale multiplier: layer `i` samples at `scale·layerScale^i`. */
  layerScale: number;
  /** Per-layer advection spread: layer `i` drifts at `wind·(1 + (i + 0.5)/n − 0.5)·layerDrift`. */
  layerDrift: number;
  windX: number;
  windZ: number;
  /** Sun-ray samples per shaded deck pixel (the device's march). */
  shadowSteps: number;
  /** Shade the scene below with the deck's shadow. */
  surfaceShadows: boolean;
  /** 0..1 multiplier on the shadow's optical depth (0 = shadows off, 1 = physical). */
  shadowStrength: number;
}

export function defaultCloudDeckParams(): CloudDeckParams {
  return {
    coverage: 0,
    density: 0.8,
    height: 1500,
    thickness: 400,
    scale: 0.0008,
    seed: 4242,
    layers: 3,
    layerScale: 0.9,
    layerDrift: 0.35,
    windX: 2,
    windZ: 1,
    shadowSteps: CLOUD_SHADOW_STEPS,
    surfaceShadows: true,
    shadowStrength: 1,
  };
}

/** Sub-layers actually used: `layers` rounded and clamped (1 = the Phase 8b single plane). */
export function cloudLayerCount(deck: CloudDeckParams): number {
  return clamp(Math.round(deck.layers), 1, MAX_CLOUD_LAYERS);
}

/** Vertical extent of one sub-layer, metres. */
export function cloudLayerThickness(deck: CloudDeckParams): number {
  return Math.max(deck.thickness, 0) / cloudLayerCount(deck);
}

/** Centre height (above sea level) of sub-layer `i`: evenly spaced through the slab. */
export function cloudLayerCentre(deck: CloudDeckParams, i: number): number {
  const n = cloudLayerCount(deck);
  return deck.height + ((clamp(i, 0, n - 1) + 0.5) / n - 0.5) * deck.thickness;
}

/**
 * Sub-layer `i`'s share of the column's optical depth: a smooth bell through the slab (middles
 * heavier than edges), normalised so the weights sum to one. A uniform deck's column density is
 * then exactly the 8b density at any `layerCount` — the property the coverage statistics ride on.
 */
export function cloudLayerWeight(deck: CloudDeckParams, i: number): number {
  const n = cloudLayerCount(deck);
  const profile = (k: number): number => 0.55 + 0.45 * Math.sin((Math.PI * (k + 0.5)) / n);
  let sum = 0;
  for (let k = 0; k < n; k++) sum += profile(k);
  return profile(clamp(i, 0, n - 1)) / (sum || 1);
}

/** Noise scale of sub-layer `i` (finer with height: cirrus above cumulus). */
export function cloudLayerScale(deck: CloudDeckParams, i: number): number {
  return deck.scale * deck.layerScale ** clamp(i, 0, MAX_CLOUD_LAYERS - 1);
}

/** Advection of sub-layer `i` after `seconds`: the mean wind, spread by `layerDrift`. */
export function cloudLayerDrift(deck: CloudDeckParams, i: number, seconds: number): { x: number; z: number } {
  const n = cloudLayerCount(deck);
  const factor = 1 + ((clamp(i, 0, n - 1) + 0.5) / n - 0.5) * deck.layerDrift;
  return { x: deck.windX * seconds * factor, z: deck.windZ * seconds * factor };
}

/**
 * Sub-layer `i`'s density 0..1 at a world XZ after `seconds` of advection — the same coverage
 * remap as `cloudDensityAt`, on the layer's own scale/seed/drift and with the LOD fade applied.
 */
export function cloudLayerDensityAt(x: number, z: number, deck: CloudDeckParams, i: number, seconds: number, footprint = 0): number {
  const drift = cloudLayerDrift(deck, i, seconds);
  const n = cloudLayerCount(deck);
  const seed = (deck.seed + clamp(i, 0, n - 1)) | 0;
  return cloudDensityAt(x + drift.x, z + drift.z, deck.coverage, deck.density, cloudLayerScale(deck, i), seed, footprint);
}

/** The deck's column density 0..1: the weighted mean over the sub-layers. */
export function cloudDeckColumnAt(x: number, z: number, deck: CloudDeckParams, seconds: number, footprint = 0): number {
  const n = cloudLayerCount(deck);
  let column = 0;
  for (let i = 0; i < n; i++) {
    column += cloudLayerWeight(deck, i) * cloudLayerDensityAt(x, z, deck, i, seconds, footprint);
  }
  return clamp(column, 0, 1);
}

/** Which sub-layer a height above sea level falls in (the march's and the shader's own index). */
export function cloudLayerIndexAt(deck: CloudDeckParams, heightAboveSea: number): number {
  const n = cloudLayerCount(deck);
  const base = deck.height - deck.thickness / 2;
  const thickness = cloudLayerThickness(deck);
  return clamp(Math.floor((heightAboveSea - base) / Math.max(thickness, 1e-3)), 0, n - 1);
}

/**
 * Optical depth of the deck along the sun ray above a point at `height` (metres above sea level):
 * the sun-path march both the deck's own shading and every shadowed surface evaluate. The ray is
 * sampled `steps` times through the layers above the point, dense layers weighting more (the
 * column profile), with the secant clamped at the horizon. Units are "density × path/thickness",
 * so a fully overcast deck at 45° elevation gives ~1.4 and the 8b shading curve applies unchanged.
 */
export function cloudDeckShadowTau(
  x: number,
  z: number,
  height: number,
  sunDir: Vec3,
  deck: CloudDeckParams,
  seconds: number,
  footprint = 0,
  steps = CLOUD_SHADOW_REFERENCE_STEPS,
): number {
  const thickness = cloudLayerThickness(deck);
  const bottom = deck.height - deck.thickness / 2;
  const top = deck.height + deck.thickness / 2;
  if (sunDir.y <= 0.02 || deck.coverage <= 0 || deck.density <= 0) return 0;
  const start = Math.max(height, bottom);
  const span = top - start;
  if (span <= 0) return 0;
  const secant = Math.min(1 / Math.max(sunDir.y, 1e-3), CLOUD_SUN_SECANT_LIMIT);
  const maxSteps = Math.max(Math.round(steps), 1);
  // The sample count follows the path length (the shader's own rule): a layer near the top is
  // barely shadowed by the deck above it and takes a single sample.
  const count = Math.max(Math.round((maxSteps * span) / Math.max(thickness, 1e-3)), 1);
  const dh = span / count;
  let tau = 0;
  for (let s = 0; s < count; s++) {
    const y = start + (s + 0.5) * dh;
    const along = (y - height) * secant;
    const layer = cloudLayerIndexAt(deck, y);
    const d = cloudLayerDensityAt(x + sunDir.x * along, z + sunDir.z * along, deck, layer, seconds, footprint);
    tau += d * cloudLayerWeight(deck, layer) * dh;
  }
  // `tau` is a density × height sum; normalising by the *sub-layer* thickness turns it into the
  // secant-scaled path integral the shading curve wants (a single layer reproduces the 8b look).
  return (secant * tau) / Math.max(thickness, 1e-3);
}

/** Fraction of the sun that reaches a point through the deck: `e^(−k·strength·τ)`, 1 = clear. */
export function cloudDeckTransmittance(
  x: number,
  z: number,
  height: number,
  sunDir: Vec3,
  deck: CloudDeckParams,
  seconds: number,
  footprint = 0,
  steps = CLOUD_SHADOW_REFERENCE_STEPS,
): number {
  if (!deck.surfaceShadows || deck.shadowStrength <= 0) return 1;
  const tau = cloudDeckShadowTau(x, z, height, sunDir, deck, seconds, footprint, steps);
  return Math.exp(-CLOUD_SUN_EXTINCTION * clamp(deck.shadowStrength, 0, 4) * tau);
}

/**
 * The deck's own radiance and opacity along a view ray — the CPU twin of the WGSL `cloudDeck`.
 * Sub-layers are composited front to back (the ray meets the lower sheet first), each shaded by
 * `cloudRadiance` with its own column contribution and the sun path above it. `out` receives
 * linear RGB and the returned value is the composite opacity, so a caller can blend it over
 * whatever was behind the deck exactly as the sky shader does.
 */
export function cloudDeckRadiance(
  viewDir: Vec3,
  sunDir: Vec3,
  deck: CloudDeckParams,
  shading: CloudShading,
  seconds: number,
  observerHeight: number,
  out: Float64Array,
  footprint = 0,
  steps = CLOUD_SHADOW_REFERENCE_STEPS,
): number {
  out[0] = 0;
  out[1] = 0;
  out[2] = 0;
  if (deck.coverage <= 0.001 || !Number.isFinite(viewDir.y) || viewDir.y <= 0.005) return 0;
  const n = cloudLayerCount(deck);
  const midDistance = Math.max((deck.height - observerHeight) / viewDir.y, 1e-3);
  const layerColor = new Float64Array(3);
  let transmittance = 1;
  for (let i = 0; i < n; i++) {
    const centre = cloudLayerCentre(deck, i);
    const dh = centre - observerHeight;
    if (dh <= 0) continue;
    const t = dh / viewDir.y;
    const x = viewDir.x * t;
    const z = viewDir.z * t;
    // Each sheet is sampled at its own footprint: the ray is `t` metres out, so one pixel covers
    // proportionally more ground than it does at the deck's centre height.
    const layerFootprint = footprint <= 0 ? 0 : (footprint * t) / midDistance;
    const column = cloudLayerWeight(deck, i) * cloudLayerDensityAt(x, z, deck, i, seconds, layerFootprint);
    if (column <= 1e-4) continue;
    const sunPath = cloudDeckShadowTau(x, z, centre, sunDir, deck, seconds, layerFootprint, steps);
    cloudRadiance(viewDir, sunDir, column, shading, layerColor, sunPath);
    const layerAlpha = cloudAlpha(column, viewDir.y);
    for (let c = 0; c < 3; c++) out[c]! += transmittance * layerAlpha * layerColor[c]!;
    transmittance *= 1 - layerAlpha;
  }
  return clamp(1 - transmittance, 0, 1);
}
