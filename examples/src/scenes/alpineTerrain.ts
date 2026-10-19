/**
 * The Alpine rescue demo's ground: terrain pipeline, winter splat weights and layer set.
 *
 * Pipeline: the engine's analytic `RealisticHeightGenerator` → `TrackGradingGenerator` (the graded
 * road bed and depot pad, see `alpineRoute.ts`) → `ClimateBiomeGenerator` (only for `cell.slopes`;
 * the splat weights below replace its biome weights). Every stage is a pure function of world
 * position, so chunks agree on shared borders and all LODs sample one surface. The scene used to
 * run thermal erosion and river carving too; thermal erosion leaves each chunk's border vertices
 * disagreeing with its neighbour's (cracks up to ~6 m — right along the route's chunk edge), and
 * river carving punches isolated crater pits, so neither is part of this pipeline.
 *
 * Material: four PBR layers (snow, rock, scree, tundra) blended per vertex from slope, curvature
 * and world-space noise — gentle ground holds snow, ridges and wind-scoured patches show tundra,
 * steep faces are rock with scree below. The engine's weather snow (`scene.settings.surface.snow`)
 * then settles on whatever faces up, so the same ground reads bare, patchy or buried as it snows.
 */

import {
  ClimateBiomeGenerator,
  Color,
  createWorldCell,
  GeneratorPipeline,
  LayeredTerrainMaterial,
  RealisticHeightGenerator,
  TrackGradingGenerator,
  clamp,
  fbm2,
  smoothstep,
  type GradedCorridor,
  type RealisticHeightOptions,
  type SplatTextureSet,
  type TerrainSurfaceLayer,
  type WorldCell,
} from "@forge/engine";
import { ALPINE_LAYER_ORDER } from "../textures/alpine.js";
import { ALPINE_SEED } from "./alpineRoute.js";

/** The mountain valley's macro shape (unchanged from the original demo, so the mission sites hold). */
export const ALPINE_HEIGHT_OPTIONS: RealisticHeightOptions = {
  seaLevel: 0,
  continentalAmplitude: 80,
  mountainAmplitude: 160,
  hillAmplitude: 35,
  detailAmplitude: 5,
  warpAmount: 60,
};

/** The natural height at any point (exact, no chunks needed): what the road design samples. */
export function alpineNaturalHeight(): (x: number, z: number) => number {
  const generator = new RealisticHeightGenerator(ALPINE_HEIGHT_OPTIONS);
  return (x, z) => generator.sampleHeight(x, z, ALPINE_SEED);
}

/**
 * The surface height at any point *as the streamed terrain will have it* — natural height with the
 * road and pad graded in — without waiting for chunks to stream. It runs the grading stage on a
 * one-vertex cell, so it is the stage's own arithmetic (to the millimetre), which makes it the
 * right function for placing forest, boulders and markers at build time.
 */
export function createGradedHeight(corridors: readonly GradedCorridor[]): (x: number, z: number) => number {
  const natural = alpineNaturalHeight();
  const stage = new TrackGradingGenerator({ corridors });
  const cell = createWorldCell(0, 0, 1, 2, ALPINE_SEED);
  return (x, z) => {
    cell.cx = x;
    cell.cz = z;
    cell.heights[0] = natural(x, z);
    stage.process(cell);
    return cell.heights[0]!;
  };
}

/** Height → grade the road/pad → slopes. Pure per vertex, so chunk borders and LODs agree. */
export function createAlpinePipeline(corridors: readonly GradedCorridor[]): GeneratorPipeline {
  return new GeneratorPipeline()
    .addStage(new RealisticHeightGenerator(ALPINE_HEIGHT_OPTIONS))
    .addStage(new TrackGradingGenerator({ corridors }))
    .addStage(new ClimateBiomeGenerator({}));
}

// ------------------------------------------------------------------ winter ground weights

const PATCH_SEED = 0x1d3b;
const FINE_SEED = 0x7f4a;

/** Layer weights (snow, rock, scree, tundra) at one vertex, before normalisation. */
export function alpineWeightsAt(slope: number, curvature: number, patch: number, fine: number, out: Float32Array): Float32Array {
  // Gentle ground holds the snow; steep faces shed it.
  const gentle = smoothstep(0.64, 0.3, slope);
  const steep = smoothstep(0.42, 0.86, slope);
  const mid = smoothstep(0.2, 0.46, slope) * (1 - smoothstep(0.62, 0.95, slope));
  // Convex ground (ridges, knolls: negative Laplacian) is wind-scoured; hollows keep their snow.
  const convex = smoothstep(0.0, 0.14, -curvature);
  const hollow = smoothstep(0.0, 0.14, curvature);
  const scoured = clamp(0.5 + patch * 0.85 + convex * 0.9 - hollow * 0.5 - 0.62, 0, 1);
  const grit = 0.5 + 0.5 * fine;
  out[0] = gentle * (1 - 0.72 * scoured) + 0.06;
  out[1] = steep * (0.72 + 0.28 * grit) + convex * 0.22 * smoothstep(0.28, 0.5, slope);
  out[2] = mid * (0.45 + 0.55 * grit) * (1 - 0.5 * steep) + 0.03;
  out[3] = gentle * scoured * 0.95 * (1 - steep);
  return out;
}

/**
 * RGBA8 splat weights for a streamed cell: one texel per vertex. Slope comes from `cell.slopes`;
 * curvature (a 4-neighbour Laplacian) and the patch/fine noise are functions of world position, so
 * the texture stays continuous across chunks.
 */
export function alpineGroundWeights(cell: WorldCell): Uint8Array {
  const res = cell.resolution;
  const step = cell.size / (res - 1);
  const originX = cell.cx * cell.size;
  const originZ = cell.cz * cell.size;
  const out = new Uint8Array(res * res * 4);
  const w = new Float32Array(4);
  const h = cell.heights;
  const at = (i: number, j: number): number => h[Math.max(0, Math.min(res - 1, j)) * res + Math.max(0, Math.min(res - 1, i))]!;
  for (let j = 0; j < res; j++) {
    for (let i = 0; i < res; i++) {
      const idx = j * res + i;
      const wx = originX + i * step;
      const wz = originZ + j * step;
      const lap = (at(i - 1, j) + at(i + 1, j) + at(i, j - 1) + at(i, j + 1) - 4 * at(i, j)) / (step * step);
      const patch = fbm2(wx / 46, wz / 46, PATCH_SEED, { octaves: 3 });
      const fine = fbm2(wx / 11, wz / 11, FINE_SEED, { octaves: 2 });
      alpineWeightsAt(cell.slopes[idx]!, lap, patch, fine, w);
      const sum = w[0]! + w[1]! + w[2]! + w[3]!;
      const inv = sum > 1e-6 ? 1 / sum : 0;
      for (let c = 0; c < 4; c++) out[idx * 4 + c] = Math.round((sum > 1e-6 ? w[c]! * inv : c === 0 ? 1 : 0) * 255);
    }
  }
  return out;
}

// ------------------------------------------------------------------ layers + material

/** What each ground layer should average out to once lit (linear albedo). */
const LAYER_TARGETS: Record<(typeof ALPINE_LAYER_ORDER)[number], readonly [number, number, number]> = {
  snow: [0.8, 0.84, 0.89],
  rock: [0.17, 0.17, 0.175],
  scree: [0.21, 0.2, 0.185],
  tundra: [0.21, 0.155, 0.09],
};

/**
 * The four layers with colours chosen so that `layer colour × mean texture albedo` hits each
 * target — the textures carry detail, the colours carry the hue (the Mars set's contract).
 */
export function createAlpineLayers(meanLinear: ReadonlyArray<readonly [number, number, number]>): TerrainSurfaceLayer[] {
  const colour = (kind: (typeof ALPINE_LAYER_ORDER)[number]): Color => {
    const index = ALPINE_LAYER_ORDER.indexOf(kind);
    const mean = meanLinear[index] ?? [1, 1, 1];
    const target = LAYER_TARGETS[kind];
    return new Color(
      clamp(target[0] / Math.max(0.05, mean[0]), 0, 1.6),
      clamp(target[1] / Math.max(0.05, mean[1]), 0, 1.6),
      clamp(target[2] / Math.max(0.05, mean[2]), 0, 1.6),
      1,
    );
  };
  return [
    { name: "snow", color: colour("snow"), roughness: 0.92, metallic: 0, textureSize: 6.5, normalScale: 0.9, macroVariation: 0.05, microDetail: 0.05 },
    { name: "rock", color: colour("rock"), roughness: 0.88, metallic: 0, textureSize: 5.5, normalScale: 1.15, macroVariation: 0.09, microDetail: 0.14 },
    { name: "scree", color: colour("scree"), roughness: 0.93, metallic: 0, textureSize: 3.6, normalScale: 1.0, macroVariation: 0.08, microDetail: 0.12 },
    { name: "tundra", color: colour("tundra"), roughness: 0.96, metallic: 0, textureSize: 3.2, normalScale: 0.9, macroVariation: 0.1, microDetail: 0.1 },
  ];
}

/** The engine's layered terrain material with the demo's winter weights in place of the stock biome mix. */
export class AlpineTerrainMaterial extends LayeredTerrainMaterial {
  constructor(maps: SplatTextureSet, meanLinear: ReadonlyArray<readonly [number, number, number]>) {
    super({ label: "alpine-terrain", maps, layers: createAlpineLayers(meanLinear) });
  }

  override weightPixels(cell: WorldCell): Uint8Array {
    return alpineGroundWeights(cell);
  }
}
