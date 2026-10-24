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
  /** Elevation and albedo at a unit direction in the planet-fixed frame. */
  sample(dx: number, dy: number, dz: number, out: MarsGlobeSample): MarsGlobeSample;
  /** Cheap high-frequency albedo multiplier around 1 (≈ 0.86..1.14). */
  detail(dx: number, dy: number, dz: number): number;
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

/** Build a globe sampler for a Mars world (the default generator world when `params` is omitted). */
export function createMarsGlobeSampler(params: MarsGenParams = createMarsGenParams()): MarsGlobeSampler {
  const scanner = new MarsCraterScanner(params.seed);
  const radius = params.radius ?? MARS_RADIUS_M;
  const markSeed = params.seed + 911;
  const detailSeed = params.seed + 1303;
  return {
    radius,
    sample(dx, dy, dz, out) {
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
    detail(dx, dy, dz) {
      const n = marsFbm3(dx * 26, dy * 26, dz * 26, { octaves: 3, lacunarity: 2.2, gain: 0.5, frequency: 1, seed: detailSeed });
      return 1 + 0.16 * n;
    },
  };
}
