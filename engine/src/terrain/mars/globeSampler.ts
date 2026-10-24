/**
 * The ported Mars planet as a **globe surface**: one function from a unit direction to the surface
 * elevation and an orbital-view albedo, for a viewer that sees the whole planet at once.
 *
 * It is the same geology the tile stage evaluates (`marsSampleAnalytic`: dichotomy, craters, shield
 * volcanoes, the canyon, cinder cones), read at planetary scale instead of per tile vertex, plus a
 * coloured interpretation of it: a ferric-dust base that brightens with elevation and is broken up by
 * a low-frequency albedo-marking field (the dark/bright regions an orbiter sees), volcanic flanks and
 * crater floors tinted by their material class, and a cheap high-frequency `detail` term so a texture
 * baked from a coarse elevation grid is not smooth. Colours are sRGB bytes (0–255 as floats) because
 * they feed an sRGB texture.
 *
 * `sample` costs ~50 µs (the crater scanner dominates), which is why the consumer
 * (`rendering/planetGlobe.ts`) calls it on a 1° grid, time-sliced across frames, and interpolates;
 * `detail` is ~0.5 µs and is called per texel.
 *
 * The result structurally satisfies `PlanetSurfaceSampler` (`rendering/planetGlobe.ts`); this file does
 * not import rendering so terrain keeps its dependency direction.
 */

import { MARS_RADIUS_M, createMarsGenParams, type MarsGenParams } from "./config.js";
import { MarsCraterScanner, MarsMaterial, marsSampleAnalytic } from "./geology.js";
import { marsFbm3 } from "./noise3.js";
import type { MarsHeightAtlas } from "./heightAtlas.js";

export interface MarsGlobeSample {
  /** Metres above the reference sphere. */
  elevation: number;
  /** sRGB 0..255. */
  r: number;
  g: number;
  b: number;
}

export interface MarsGlobeSampler {
  readonly radius: number;
  /** True while a height atlas with data is attached: elevations are real MOLA heights, not the procedural model. */
  readonly hasRealElevation: boolean;
  /** Attach (or, with `null`, detach) the real-elevation atlas. Later samples use it; nothing is re-sampled. */
  setAtlas(atlas: MarsHeightAtlas | null): void;
  /**
   * Elevation and albedo at a unit direction in the planet-fixed frame. `footprintRad` is the angular
   * size of the cell the caller will interpolate this sample over (a globe pass's grid spacing): over
   * real data it band-limits the height by averaging several taps across the footprint, so a coarse grid
   * does not alias fine terrain. Omit it for a point sample.
   */
  sample(dx: number, dy: number, dz: number, out: MarsGlobeSample, footprintRad?: number): MarsGlobeSample;
  /** Cheap high-frequency albedo multiplier around 1 (≈ 0.86..1.14). */
  detail(dx: number, dy: number, dz: number): number;
  /**
   * Elevation only (metres) at a unit direction: the atlas height (band-limited over `footprintRad`
   * like `sample`) where there is real data, else the procedural model's (as expensive as `sample`).
   * Over real data it skips the albedo work, which is what makes a fine detail-patch grid affordable.
   */
  elevation(dx: number, dy: number, dz: number, footprintRad?: number): number;
}

// Linear-ish sRGB palette, chosen against orbital photography: dark basaltic sand, ferric dust,
// bright aeolian dust. (Mars' mean albedo is only ~0.25, so none of these is bright.)
const DARK: readonly [number, number, number] = [82, 62, 54];
const DUST: readonly [number, number, number] = [188, 124, 82];
const BRIGHT: readonly [number, number, number] = [222, 164, 114];
const VOLCANIC: readonly [number, number, number] = [104, 80, 70];
const SEDIMENT: readonly [number, number, number] = [214, 150, 102];

function mix3(a: readonly [number, number, number], b: readonly [number, number, number], t: number, out: MarsGlobeSample): void {
  out.r = a[0] + (b[0] - a[0]) * t;
  out.g = a[1] + (b[1] - a[1]) * t;
  out.b = a[2] + (b[2] - a[2]) * t;
}

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);

/**
 * Hypsometric albedo ramp (elevation metres → sRGB), the base the real-elevation globe is tinted by:
 * deep basins and the north plains read dark and brown, the mid-level plains and highlands ferric
 * orange, and the high volcanic rises pale with dust. It is a *tint* under the albedo-marking field,
 * not a replacement for it (Mars' real albedo is not a function of height).
 */
const ELEVATION_RAMP: readonly (readonly [number, number, number, number])[] = [
  [-8000, 70, 52, 50],
  [-5000, 98, 68, 56],
  [-2500, 140, 92, 68],
  [0, 176, 114, 78],
  [3000, 200, 136, 94],
  [8000, 214, 160, 118],
  [14000, 224, 184, 148],
  [21000, 238, 212, 186],
];

function elevationRamp(elevation: number, out: MarsGlobeSample): void {
  const n = ELEVATION_RAMP.length;
  if (elevation <= ELEVATION_RAMP[0]![0]) {
    out.r = ELEVATION_RAMP[0]![1];
    out.g = ELEVATION_RAMP[0]![2];
    out.b = ELEVATION_RAMP[0]![3];
    return;
  }
  for (let i = 1; i < n; i++) {
    const hi = ELEVATION_RAMP[i]!;
    if (elevation <= hi[0]) {
      const lo = ELEVATION_RAMP[i - 1]!;
      const t = (elevation - lo[0]) / (hi[0] - lo[0]);
      out.r = lo[1] + (hi[1] - lo[1]) * t;
      out.g = lo[2] + (hi[2] - lo[2]) * t;
      out.b = lo[3] + (hi[3] - lo[3]) * t;
      return;
    }
  }
  const last = ELEVATION_RAMP[n - 1]!;
  out.r = last[1];
  out.g = last[2];
  out.b = last[3];
}

/** Real heights above which a spot is volcanic and below which it is deep basin/canyon floor (metres). */
const REAL_VOLCANIC_ABOVE_M = 10000;
const REAL_BASIN_BELOW_M = -5500;

/** Build a globe sampler for a Mars world (the default generator world when `params` is omitted). */
export function createMarsGlobeSampler(
  params: MarsGenParams = createMarsGenParams(),
  options: { atlas?: MarsHeightAtlas | null } = {},
): MarsGlobeSampler {
  const scanner = new MarsCraterScanner(params.seed);
  let atlas: MarsHeightAtlas | null = options.atlas ?? null;
  const tint: MarsGlobeSample = { elevation: 0, r: 0, g: 0, b: 0 };
  /** Node spacing of the finest loaded level, radians (face centre). */
  const nodeSpacing = (a: MarsHeightAtlas): number => (Math.PI / 2) / ((a.resolutions[0] ?? 512) - 1);
  // Tangent frame scratch (east-ish, north-ish) of the direction being sampled.
  let tex = 1, tez = 0, tnx = 0, tny = 0, tnz = 1;
  const setFrame = (dx: number, dy: number, dz: number): void => {
    // east = Y × dir, north = dir × east (the exact orientation is irrelevant, only that they are orthonormal).
    let ex = dz;
    let ez = -dx;
    let el = Math.hypot(ex, ez);
    if (el < 1e-6) { ex = 1; ez = 0; el = 1; }
    tex = ex / el;
    tez = ez / el;
    tnx = dy * tez;
    tny = dz * tex - dx * tez;
    tnz = -dy * tex;
  };
  const tap = (a: MarsHeightAtlas, dx: number, dy: number, dz: number, east: number, north: number): number =>
    a.sample(dx + tex * east + tnx * north, dy + tny * north, dz + tez * east + tnz * north, "bilinear");
  /** Band-limited atlas height: a k×k grid of taps across `footprintRad` (k from the footprint / node spacing). */
  const realHeight = (a: MarsHeightAtlas, dx: number, dy: number, dz: number, footprintRad: number): number => {
    const spacing = nodeSpacing(a);
    const k = footprintRad > spacing * 1.5 ? Math.min(4, Math.round(footprintRad / spacing)) : 1;
    if (k <= 1) return a.sample(dx, dy, dz, "bilinear");
    let sum = 0;
    let count = 0;
    for (let j = 0; j < k; j++) {
      const oj = ((j + 0.5) / k - 0.5) * footprintRad;
      for (let i = 0; i < k; i++) {
        const h = tap(a, dx, dy, dz, ((i + 0.5) / k - 0.5) * footprintRad, oj);
        if (h === h) { sum += h; count++; }
      }
    }
    return count ? sum / count : Number.NaN;
  };
  const radius = params.radius ?? MARS_RADIUS_M;
  const radiusM = radius;
  const markSeed = params.seed + 911;
  const detailSeed = params.seed + 1303;
  /** Albedo over real elevation: markings × hypsometric ramp, volcanic highs, basin sediment, slope darkening. */
  const sampleReal = (dx: number, dy: number, dz: number, elevation: number, footprintRad: number, out: MarsGlobeSample): MarsGlobeSample => {
    const a = atlas!;
    const mark = marsFbm3(dx * 2.6, dy * 2.6, dz * 2.6, { octaves: 4, lacunarity: 2.1, gain: 0.55, frequency: 1, seed: markSeed });
    // The elevation term of the procedural albedo is dropped here: the ramp carries it.
    const dust = clamp01(0.52 + 0.9 * mark);
    if (dust < 0.55) mix3(DARK, DUST, dust / 0.55, out);
    else mix3(DUST, BRIGHT, (dust - 0.55) / 0.45, out);
    elevationRamp(elevation, tint);
    // Tint the marking colour toward the ramp colour, keeping the marking's own brightness variation.
    const RAMP = 0.5;
    const m = (0.3 * out.r + 0.59 * out.g + 0.11 * out.b) / 138.6;
    out.r += (tint.r * m - out.r) * RAMP;
    out.g += (tint.g * m - out.g) * RAMP;
    out.b += (tint.b * m - out.b) * RAMP;
    if (elevation > REAL_VOLCANIC_ABOVE_M) {
      const t = clamp01((elevation - REAL_VOLCANIC_ABOVE_M) / 9000);
      // Dust-mantled high flanks: darker basalt just above the threshold, pale dust toward the summit.
      mix3(VOLCANIC, BRIGHT, t, tint);
      out.r += (tint.r - out.r) * 0.6;
      out.g += (tint.g - out.g) * 0.6;
      out.b += (tint.b - out.b) * 0.6;
    } else if (elevation < REAL_BASIN_BELOW_M) {
      const t = 0.35 * clamp01((REAL_BASIN_BELOW_M - elevation) / 2500);
      out.r += (SEDIMENT[0] - out.r) * t;
      out.g += (SEDIMENT[1] - out.g) * t;
      out.b += (SEDIMENT[2] - out.b) * t;
    }
    // Steep ground sheds its dust: darken by the local slope (finite differences about one node / footprint).
    const spacing = nodeSpacing(a);
    const d = Math.max(spacing, footprintRad * 0.5);
    const hE = tap(a, dx, dy, dz, d, 0);
    const hW = tap(a, dx, dy, dz, -d, 0);
    const hN = tap(a, dx, dy, dz, 0, d);
    const hS = tap(a, dx, dy, dz, 0, -d);
    const slope = hE === hE && hW === hW && hN === hN && hS === hS ? Math.hypot(hE - hW, hN - hS) / (2 * d * radiusM) : 0;
    const steep = clamp01((slope - 0.015) / 0.12);
    const k = 1 - 0.28 * steep;
    out.r *= k;
    out.g *= k;
    out.b *= k;
    out.elevation = elevation;
    return out;
  };
  return {
    radius,
    get hasRealElevation(): boolean {
      return !!atlas && atlas.facesLoaded().length > 0;
    },
    setAtlas(next) {
      atlas = next;
    },
    sample(dx, dy, dz, out, footprintRad = 0) {
      // Real elevation where the atlas has this face; otherwise the procedural model (unchanged).
      if (atlas) {
        setFrame(dx, dy, dz);
        const real = realHeight(atlas, dx, dy, dz, footprintRad);
        if (real === real) return sampleReal(dx, dy, dz, real, footprintRad, out);
      }
      const s = marsSampleAnalytic(dx, dy, dz, params, scanner);
      // Albedo markings: large dark and bright provinces, a little more dust on high ground.
      const mark = marsFbm3(dx * 2.6, dy * 2.6, dz * 2.6, { octaves: 4, lacunarity: 2.1, gain: 0.55, frequency: 1, seed: markSeed });
      const dust = clamp01(0.52 + 0.9 * mark + 0.035 * (s.elevation / 1000));
      if (dust < 0.55) mix3(DARK, DUST, dust / 0.55, out);
      else mix3(DUST, BRIGHT, (dust - 0.55) / 0.45, out);
      let k = 1;
      switch (s.material) {
        case MarsMaterial.VolcanicFlank: {
          // Fresh basalt low on the flank, dust-mantled toward the summit.
          mix3(VOLCANIC, BRIGHT, clamp01((s.elevation - 5000) / 9000), out);
          break;
        }
        case MarsMaterial.CraterFloor:
          k = 0.9;
          break;
        case MarsMaterial.LayeredSediment: {
          const t = 0.55;
          out.r += (SEDIMENT[0] - out.r) * t;
          out.g += (SEDIMENT[1] - out.g) * t;
          out.b += (SEDIMENT[2] - out.b) * t;
          break;
        }
        case MarsMaterial.ExposedBedrock:
          k = 0.93;
          break;
        default:
          break;
      }
      out.r *= k;
      out.g *= k;
      out.b *= k;
      out.elevation = s.elevation;
      return out;
    },
    elevation(dx, dy, dz, footprintRad = 0) {
      if (atlas) {
        setFrame(dx, dy, dz);
        const real = realHeight(atlas, dx, dy, dz, footprintRad);
        if (real === real) return real;
      }
      return marsSampleAnalytic(dx, dy, dz, params, scanner).elevation;
    },
    detail(dx, dy, dz) {
      const n = marsFbm3(dx * 26, dy * 26, dz * 26, { octaves: 3, lacunarity: 2.2, gain: 0.5, frequency: 1, seed: detailSeed });
      return 1 + 0.16 * n;
    },
  };
}
