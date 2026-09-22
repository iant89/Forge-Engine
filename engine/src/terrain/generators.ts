/**
 * Procedural Terrain Generators & Pipeline.
 *
 * All generation functions are pure and deterministic in `(seed, cx, cz)`:
 *  - main thread and worker pool execute the identical math;
 *  - results are order-independent and bit-for-bit reproducible.
 */

import { NoiseField } from "../math/noise.js";
import { Rng, chunkSeed, hash2i } from "../math/rng.js";
import { clamp } from "../math/scalar.js";

export interface ScatterInstance {
  x: number;
  y: number;
  z: number;
  scale: number;
  rotationY: number;
  type: number;
}

export interface WorldCell {
  cx: number;
  cz: number;
  size: number;
  resolution: number;
  seed: number;
  heights: Float32Array;
  slopes: Float32Array;
  /** 4 weights per vertex for splat materials (R, G, B, A). */
  biomes: Float32Array;
  scatters: ScatterInstance[];
}

export interface TerrainStage {
  readonly name: string;
  process(cell: WorldCell): void;
}

/**
 * Allocate an empty cell grid for chunk `(cx, cz)`.
 *
 * Every consumer of the pipeline (the tile that becomes a mesh, the heightmap behind an elevation
 * query on a chunk that is not resident yet) has to agree on the grid it samples, so the cell shape
 * lives here rather than being re-derived at each call site.
 */
export function createWorldCell(cx: number, cz: number, size: number, resolution: number, seed: number): WorldCell {
  const count = resolution * resolution;
  return {
    cx,
    cz,
    size,
    resolution,
    seed,
    heights: new Float32Array(count),
    slopes: new Float32Array(count),
    biomes: new Float32Array(count * 4),
    scatters: [],
  };
}

// ------------------------------------------------------------------ Height Generator

export interface HeightGeneratorOptions {
  octaves?: number;
  frequency?: number;
  amplitude?: number;
  lacunarity?: number;
  gain?: number;
  ridgeWeight?: number;
  seaLevel?: number;
}

export class HeightGenerator implements TerrainStage {
  readonly name = "height";
  readonly octaves: number;
  readonly frequency: number;
  readonly amplitude: number;
  readonly lacunarity: number;
  readonly gain: number;
  readonly ridgeWeight: number;
  readonly seaLevel: number;

  constructor(options: HeightGeneratorOptions = {}) {
    this.octaves = options.octaves ?? 5;
    this.frequency = options.frequency ?? 1 / 256;
    this.amplitude = options.amplitude ?? 40;
    this.lacunarity = options.lacunarity ?? 2.0;
    this.gain = options.gain ?? 0.5;
    this.ridgeWeight = options.ridgeWeight ?? 0.35;
    this.seaLevel = options.seaLevel ?? 0;
  }

  /** Pure deterministic height calculation at world coordinates (worldX, worldZ). */
  sampleHeight(worldX: number, worldZ: number, seed: number): number {
    const field = new NoiseField(seed, {
      octaves: this.octaves,
      lacunarity: this.lacunarity,
      gain: this.gain,
    });

    const nx = worldX * this.frequency;
    const nz = worldZ * this.frequency;

    // Base rolling terrain fBm
    const base = field.fbm(nx, nz, 101);

    // Mountain ridges
    const ridge = field.ridged(nx * 1.5, nz * 1.5, 202);

    // Large-scale continental shelf / elevation swell
    const swell = field.fbm(nx * 0.25, nz * 0.25, 303) * 0.5;

    const blended = (1 - this.ridgeWeight) * base + this.ridgeWeight * ridge + swell;
    return this.seaLevel + blended * this.amplitude;
  }

  process(cell: WorldCell): void {
    const res = cell.resolution;
    const step = cell.size / (res - 1);
    const originX = cell.cx * cell.size;
    const originZ = cell.cz * cell.size;

    for (let j = 0; j < res; j++) {
      for (let i = 0; i < res; i++) {
        const wx = originX + i * step;
        const wz = originZ + j * step;
        cell.heights[j * res + i] = this.sampleHeight(wx, wz, cell.seed);
      }
    }
  }
}

// ------------------------------------------------------------------ Crater Generator

export interface CraterGeneratorOptions {
  density?: number;
  minRadius?: number;
  maxRadius?: number;
  depthRatio?: number;
  rimRatio?: number;
}

export class CraterGenerator implements TerrainStage {
  readonly name = "crater";
  readonly density: number;
  readonly minRadius: number;
  readonly maxRadius: number;
  readonly depthRatio: number;
  readonly rimRatio: number;

  constructor(options: CraterGeneratorOptions = {}) {
    this.density = options.density ?? 0.3;
    this.minRadius = options.minRadius ?? 15;
    this.maxRadius = options.maxRadius ?? 60;
    this.depthRatio = options.depthRatio ?? 0.3;
    this.rimRatio = options.rimRatio ?? 0.15;
  }

  process(cell: WorldCell): void {
    // Deterministic crater placement around cell and immediate neighbours (3x3 chunk search)
    const res = cell.resolution;
    const step = cell.size / (res - 1);
    const originX = cell.cx * cell.size;
    const originZ = cell.cz * cell.size;

    for (let ocx = cell.cx - 1; ocx <= cell.cx + 1; ocx++) {
      for (let ocz = cell.cz - 1; ocz <= cell.cz + 1; ocz++) {
        const h = hash2i(ocx, ocz, cell.seed ^ 0x517cc1b7);
        const normH = (h >>> 0) / 0xffffffff;
        if (normH > this.density) continue;

        const rng = new Rng(chunkSeed(ocx, ocz, 999, cell.seed));
        const craterX = ocx * cell.size + rng.nextFloat() * cell.size;
        const craterZ = ocz * cell.size + rng.nextFloat() * cell.size;
        const radius = this.minRadius + rng.nextFloat() * (this.maxRadius - this.minRadius);
        const depth = radius * this.depthRatio;
        const rimHeight = radius * this.rimRatio;
        const rimRadius = radius * 1.15;

        // Apply crater profile to local grid vertices
        for (let j = 0; j < res; j++) {
          const wz = originZ + j * step;
          const dz = wz - craterZ;
          if (Math.abs(dz) > rimRadius * 1.5) continue;

          for (let i = 0; i < res; i++) {
            const wx = originX + i * step;
            const dx = wx - craterX;
            const dist = Math.hypot(dx, dz);
            if (dist > rimRadius * 1.5) continue;

            const idx = j * res + i;
            if (dist < radius) {
              // Parabolic depression inside bowl
              const normDist = dist / radius;
              const depression = depth * (1.0 - normDist * normDist);
              cell.heights[idx]! -= depression;

              // Optional central peak for large craters (> 40m radius)
              if (radius > 40 && dist < radius * 0.25) {
                const peakDist = dist / (radius * 0.25);
                const peak = depth * 0.45 * (1.0 - peakDist * peakDist);
                cell.heights[idx]! += peak;
              }
            } else if (dist <= rimRadius * 1.5) {
              // Uplifted rim wall falling off with smoothstep
              const normRim = (dist - radius) / (rimRadius * 0.5);
              if (normRim <= 1.0) {
                const rim = rimHeight * (1.0 - normRim * normRim);
                cell.heights[idx]! += rim;
              }
            }
          }
        }
      }
    }
  }
}

// ------------------------------------------------------------------ Erosion Generator

export interface ErosionGeneratorOptions {
  iterations?: number;
  talusAngle?: number;
  erosionRate?: number;
}

export class ErosionGenerator implements TerrainStage {
  readonly name = "erosion";
  readonly iterations: number;
  readonly talusAngle: number;
  readonly erosionRate: number;

  constructor(options: ErosionGeneratorOptions = {}) {
    this.iterations = options.iterations ?? 2;
    this.talusAngle = options.talusAngle ?? 0.7; // ~40 degrees
    this.erosionRate = options.erosionRate ?? 0.15;
  }

  process(cell: WorldCell): void {
    const res = cell.resolution;
    const step = cell.size / (res - 1);
    const maxSlopeHeight = Math.tan(this.talusAngle) * step;

    for (let iter = 0; iter < this.iterations; iter++) {
      for (let j = 1; j < res - 1; j++) {
        for (let i = 1; i < res - 1; i++) {
          const idx = j * res + i;
          const h = cell.heights[idx]!;

          // Check 4 cardinal neighbours
          const nU = cell.heights[(j - 1) * res + i]!;
          const nD = cell.heights[(j + 1) * res + i]!;
          const nL = cell.heights[j * res + (i - 1)]!;
          const nR = cell.heights[j * res + (i + 1)]!;

          const minN = Math.min(nU, nD, nL, nR);
          const diff = h - minN;

          if (diff > maxSlopeHeight) {
            const excess = (diff - maxSlopeHeight) * this.erosionRate;
            cell.heights[idx]! -= excess;
          }
        }
      }
    }
  }
}

// ------------------------------------------------------------------ Biome Generator

export class BiomeGenerator implements TerrainStage {
  readonly name = "biome";

  process(cell: WorldCell): void {
    const res = cell.resolution;
    const step = cell.size / (res - 1);

    for (let j = 0; j < res; j++) {
      for (let i = 0; i < res; i++) {
        const idx = j * res + i;
        const h = cell.heights[idx]!;

        // Estimate slope via central difference
        const iL = Math.max(0, i - 1);
        const iR = Math.min(res - 1, i + 1);
        const jD = Math.max(0, j - 1);
        const jU = Math.min(res - 1, j + 1);

        const hL = cell.heights[j * res + iL]!;
        const hR = cell.heights[j * res + iR]!;
        const hD = cell.heights[jD * res + i]!;
        const hU = cell.heights[jU * res + i]!;

        const dx = (hR - hL) / ((iR - iL) * step);
        const dz = (hU - hD) / ((jU - jD) * step);
        const slope = Math.atan(Math.hypot(dx, dz));
        cell.slopes[idx] = slope;

        // Splat map weight distribution:
        // w0: flat lowlands (slope < 20 deg)
        // w1: steep cliff rock (slope > 35 deg)
        // w2: transitional gravel/scree (20 - 35 deg)
        // w3: high elevation peaks
        let wCliff = clamp((slope - 0.35) / 0.35, 0, 1);
        let wHigh = clamp((h - 25) / 25, 0, 1);
        let wLow = clamp((0.4 - slope) / 0.4, 0, 1) * (1 - wHigh);
        let wScree = clamp(1.0 - (wCliff + wHigh + wLow), 0, 1);

        const sum = wLow + wCliff + wScree + wHigh;
        const norm = sum > 0 ? 1 / sum : 1;

        const bIdx = idx * 4;
        cell.biomes[bIdx] = wLow * norm;
        cell.biomes[bIdx + 1] = wCliff * norm;
        cell.biomes[bIdx + 2] = wScree * norm;
        cell.biomes[bIdx + 3] = wHigh * norm;
      }
    }
  }
}

// ------------------------------------------------------------------ Scatter Generator

export interface ScatterGeneratorOptions {
  countPerChunk?: number;
  maxSlope?: number;
}

export class ScatterGenerator implements TerrainStage {
  readonly name = "scatter";
  readonly countPerChunk: number;
  readonly maxSlope: number;

  constructor(options: ScatterGeneratorOptions = {}) {
    this.countPerChunk = options.countPerChunk ?? 12;
    this.maxSlope = options.maxSlope ?? 0.55; // ~31 deg
  }

  process(cell: WorldCell): void {
    const rng = new Rng(chunkSeed(cell.cx, cell.cz, 42, cell.seed));
    const res = cell.resolution;
    const step = cell.size / (res - 1);
    const originX = cell.cx * cell.size;
    const originZ = cell.cz * cell.size;

    for (let k = 0; k < this.countPerChunk; k++) {
      const lx = rng.nextFloat() * cell.size;
      const lz = rng.nextFloat() * cell.size;

      const gi = Math.floor(lx / step);
      const gj = Math.floor(lz / step);
      if (gi >= res - 1 || gj >= res - 1) continue;

      const idx = gj * res + gi;
      const slope = cell.slopes[idx]!;
      if (slope > this.maxSlope) continue;

      const fx = (lx - gi * step) / step;
      const fz = (lz - gj * step) / step;

      const h00 = cell.heights[gj * res + gi]!;
      const h10 = cell.heights[gj * res + gi + 1]!;
      const h01 = cell.heights[(gj + 1) * res + gi]!;
      const h11 = cell.heights[(gj + 1) * res + gi + 1]!;

      const y = (h00 * (1 - fx) + h10 * fx) * (1 - fz) + (h01 * (1 - fx) + h11 * fx) * fz;

      cell.scatters.push({
        x: originX + lx,
        y,
        z: originZ + lz,
        scale: 0.5 + rng.nextFloat() * 1.5,
        rotationY: rng.nextFloat() * Math.PI * 2,
        type: Math.floor(rng.nextFloat() * 3),
      });
    }
  }
}

// ------------------------------------------------------------------ Generator Pipeline

export class GeneratorPipeline {
  readonly stages: TerrainStage[] = [];

  addStage(stage: TerrainStage): this {
    this.stages.push(stage);
    return this;
  }

  execute(cell: WorldCell): void {
    for (const stage of this.stages) {
      stage.process(cell);
    }
  }

  static createDefault(_seed: number, heightOptions?: HeightGeneratorOptions): GeneratorPipeline {
    return new GeneratorPipeline()
      .addStage(new HeightGenerator(heightOptions))
      .addStage(new CraterGenerator())
      .addStage(new ErosionGenerator())
      .addStage(new BiomeGenerator())
      .addStage(new ScatterGenerator());
  }
}
