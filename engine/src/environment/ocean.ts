/**
 * Ocean (fe-33): wind-driven sea state on top of the Phase 8b Gerstner water.
 *
 * The water program already renders up to {@link MAX_WATER_WAVES} Gerstner components, a fresnel
 * sky reflection, crest whitecaps and (fe-33) an analytic shoreline with depth colour, shoaling,
 * breaking and swash foam (`scene.settings.water.shore`). This module turns *weather* into that
 * wave set so any scene can drive a sea from a wind speed and direction:
 *
 * - {@link oceanWavesFromWind} — a fully-developed Pierson–Moskowitz sea for a 10 m wind: the peak
 *   period `Tp = 2π·U / (0.877·g)`, significant height `Hs = 0.21·U²/g` (capped by `maxHeight` so a
 *   200 km/h wind does not drown a demo camera), deep-water dispersion `c = √(gλ/2π)`, and the
 *   components fanned ±spread around the wind with shorter, smaller harmonics. `choppiness` rises
 *   with the wind (white water appears around Beaufort 4–5).
 * - {@link applyOceanState} — writes those waves + choppiness + whitecap threshold into the scene.
 * - {@link oceanGridSource} — a water grid whose spacing grows away from a focus point, so the
 *   near-shore swell gets dense vertices and the horizon gets cheap ones.
 * - {@link oceanQualityForTier} — grid density + wave count per device tier (low/medium/high).
 *
 * Same CPU/GPU contract as the rest of the water: every number written here is what the shader
 * evaluates, so `sampleWater` agrees with the rendered sea.
 */

import type { Scene, WaterWaveParams } from "../scene/scene.js";
import type { DeviceTier } from "../core/deviceTier.js";
import { clamp } from "../math/scalar.js";
import { MAX_WATER_WAVES, type WaterGridSource } from "./water.js";

export const OCEAN_GRAVITY = 9.81;

export interface OceanWindOptions {
  /** 10 m wind speed in m/s. */
  windSpeed: number;
  /** Direction the wind blows *toward*, radians in XZ (0 = +X, π/2 = +Z). */
  direction: number;
  /** Cap on the significant wave height in metres. Default 6. */
  maxHeight?: number;
  /** Floor height so a calm sea still moves. Default 0.12. */
  minHeight?: number;
  /** Half-angle (radians) the components fan around the wind. Default 0.45. */
  spread?: number;
  /** Components to produce (1..8; 5+ adds wave groups and chop). Default 8. */
  waveCount?: number;
  /** Extra steepness multiplier on top of the wind-driven one. Default 1. */
  choppiness?: number;
  /** Phase seed so two seas built from the same wind do not line up. Default 0. */
  seed?: number;
}

export interface OceanState {
  waves: WaterWaveParams[];
  /** Wind-driven crest sharpness multiplier for `scene.settings.water.choppiness`. */
  choppiness: number;
  /** Whitecap crest threshold for `scene.settings.water.foamThreshold` (lower = more foam). */
  foamThreshold: number;
  /** Significant wave height actually used (after the caps). */
  significantHeight: number;
  /** Peak wavelength in metres. */
  peakWavelength: number;
}

/** Pierson–Moskowitz significant wave height (m) for a fully developed sea. */
export function pmSignificantHeight(windSpeed: number): number {
  const u = Math.max(0, windSpeed);
  return (0.21 * u * u) / OCEAN_GRAVITY;
}

/** Pierson–Moskowitz peak wavelength (m): deep-water λ of the peak period. */
export function pmPeakWavelength(windSpeed: number): number {
  const u = Math.max(0.5, windSpeed);
  const omega = (0.877 * OCEAN_GRAVITY) / u;
  return (2 * Math.PI * OCEAN_GRAVITY) / (omega * omega);
}

/** Deep-water phase speed for a wavelength. */
export function deepWaterSpeed(wavelength: number): number {
  return Math.sqrt((OCEAN_GRAVITY * Math.max(1e-3, wavelength)) / (2 * Math.PI));
}

// Relative wavelength / amplitude / angle of the four components (peak, then shorter harmonics).
const COMPONENTS = [
  { len: 1, amp: 1, angle: 0, steep: 0.55 },
  { len: 0.62, amp: 0.55, angle: 1, steep: 0.5 },
  { len: 0.37, amp: 0.3, angle: -1, steep: 0.45 },
  { len: 0.19, amp: 0.14, angle: 0.4, steep: 0.4 },
  // fe-34 (5..8 components): a near-twin of the peak (wave groups — sets of big waves every
  // ~12 crests where the two beat in phase, lulls between), a cross-sea and short wind chop.
  { len: 0.92, amp: 0.85, angle: 0.12, steep: 0.5 },
  { len: 0.12, amp: 0.08, angle: -0.7, steep: 0.35 },
  { len: 0.5, amp: 0.32, angle: -0.55, steep: 0.45 },
  { len: 0.075, amp: 0.045, angle: 0.9, steep: 0.3 },
] as const;

/**
 * A wind-driven Gerstner wave set. Amplitudes are scaled so the components' amplitude sum is
 * `Hs / 2` (the crest-to-mean of a significant wave); wavelengths are capped at 400 m so the
 * shader's grid can still resolve them.
 */
export function oceanWavesFromWind(options: OceanWindOptions): OceanState {
  const count = clamp(Math.floor(options.waveCount ?? MAX_WATER_WAVES), 1, MAX_WATER_WAVES);
  const maxH = Math.max(0.01, options.maxHeight ?? 6);
  const minH = Math.min(maxH, Math.max(0, options.minHeight ?? 0.12));
  const hs = clamp(pmSignificantHeight(options.windSpeed), minH, maxH);
  // Waves in a capped sea are shorter than a fully developed one: shrink λ with the same ratio,
  // otherwise a capped hurricane sea would be impossibly long, low swells.
  const developed = pmSignificantHeight(options.windSpeed);
  const capRatio = developed > hs && developed > 0 ? Math.sqrt(hs / developed) : 1;
  const peak = clamp(pmPeakWavelength(options.windSpeed) * capRatio, 4, 400);
  const spread = options.spread ?? 0.45;
  const seed = options.seed ?? 0;
  let ampSum = 0;
  for (let i = 0; i < count; i++) ampSum += COMPONENTS[i]!.amp;
  const waves: WaterWaveParams[] = [];
  for (let i = 0; i < count; i++) {
    const c = COMPONENTS[i]!;
    const a = options.direction + c.angle * spread;
    const wavelength = peak * c.len;
    waves.push({
      directionX: Math.cos(a),
      directionZ: Math.sin(a),
      wavelength,
      amplitude: (hs * 0.5 * c.amp) / ampSum,
      speed: deepWaterSpeed(wavelength),
      steepness: c.steep,
      phase: (seed * 2.399963 + i * 1.7) % (2 * Math.PI),
    });
  }
  // Beaufort 4 (~6 m/s) starts whitecaps; by ~25 m/s the sea is streaked white.
  const w = Math.max(0, options.windSpeed);
  const choppiness = clamp(0.8 + w / 30, 0.8, 1.9) * (options.choppiness ?? 1);
  const foamThreshold = clamp(0.92 - (w - 5) * 0.012, 0.5, 0.92);
  return { waves, choppiness, foamThreshold, significantHeight: hs, peakWavelength: peak };
}

/** Write an {@link OceanState} into the scene's water block. */
export function applyOceanState(scene: Scene, state: OceanState): void {
  scene.setWater({ waves: state.waves, choppiness: state.choppiness, foamThreshold: state.foamThreshold });
}

export interface OceanQuality {
  /** Grid segments per side for {@link oceanGridSource}. */
  gridSegments: number;
  /** Gerstner components to evaluate. */
  waveCount: number;
}

/** Ocean grid density + wave count per device tier. */
export function oceanQualityForTier(tier: DeviceTier): OceanQuality {
  switch (tier) {
    case "low":
      return { gridSegments: 128, waveCount: 4 };
    case "medium":
      return { gridSegments: 192, waveCount: 6 };
    default:
      return { gridSegments: 288, waveCount: 8 };
  }
}

/**
 * An XZ water grid of edge `size` centred on the origin whose vertex spacing grows with distance
 * from `(focusX, focusZ)` (`exponent` > 1 concentrates vertices at the focus; 1 is uniform). Bounds
 * are padded by `amplitude` like {@link waterGridSource}.
 */
export function oceanGridSource(size: number, segments: number, amplitude: number, focusX = 0, focusZ = 0, exponent = 2): WaterGridSource {
  const seg = Math.max(2, Math.floor(segments));
  const n = seg + 1;
  const half = size / 2;
  const p = Math.max(1, exponent);
  const axis = (focus: number): Float64Array => {
    // Map u ∈ [0, 1] → [-half, half] with the dense band at `focus`.
    const out = new Float64Array(n);
    const f = clamp(focus, -half * 0.9, half * 0.9);
    const lower = f + half;
    const upper = half - f;
    const total = lower + upper;
    const split = lower / total;
    for (let i = 0; i < n; i++) {
      const u = i / seg;
      if (u <= split) {
        const t = split > 0 ? (split - u) / split : 0;
        out[i] = f - lower * Math.pow(t, p);
      } else {
        const t = (u - split) / (1 - split);
        out[i] = f + upper * Math.pow(t, p);
      }
    }
    out[0] = -half;
    out[n - 1] = half;
    return out;
  };
  const xs = axis(focusX);
  const zs = axis(focusZ);
  const count = n * n;
  const positions = new Float32Array(count * 3);
  const normals = new Float32Array(count * 3);
  const uvs = new Float32Array(count * 2);
  let v = 0;
  for (let iz = 0; iz < n; iz++) {
    for (let ix = 0; ix < n; ix++) {
      positions[v * 3] = xs[ix]!;
      positions[v * 3 + 2] = zs[iz]!;
      normals[v * 3 + 1] = 1;
      uvs[v * 2] = ix / seg;
      uvs[v * 2 + 1] = iz / seg;
      v++;
    }
  }
  const indices = new Uint32Array(seg * seg * 6);
  let o = 0;
  for (let iz = 0; iz < seg; iz++) {
    for (let ix = 0; ix < seg; ix++) {
      const a = iz * n + ix;
      const b = a + 1;
      const c = a + n;
      const d = c + 1;
      indices[o++] = a;
      indices[o++] = c;
      indices[o++] = b;
      indices[o++] = b;
      indices[o++] = c;
      indices[o++] = d;
    }
  }
  const pad = Math.max(0.5, amplitude);
  return { positions, normals, uvs, indices, boundsMin: [-half, -pad, -half], boundsMax: [half, pad, half] };
}
