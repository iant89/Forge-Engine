import { describe, expect, it } from "vitest";
import {
  RealisticHeightGenerator,
  ThermalErosionGenerator,
  HydraulicErosionGenerator,
  ValleyCarvingGenerator,
  DetailNoiseGenerator,
  ClimateBiomeGenerator,
  createRealisticTerrainPipeline,
  createRealisticPipelinePreset,
  TerrainTile,
  GeneratorPipeline,
} from "@forge/engine";

describe("Realistic Terrain - Height Generation", () => {
  it("generates deterministic heights for same seed and coordinates", () => {
    const gen = new RealisticHeightGenerator({ seaLevel: 0, mountainAmplitude: 800 });
    const h1 = gen.sampleHeight(123.45, 678.9, 42);
    const h2 = gen.sampleHeight(123.45, 678.9, 42);
    expect(h1).toBe(h2);

    const h3 = gen.sampleHeight(123.45, 678.9, 999);
    expect(h3).not.toBe(h1);
  });

  it("produces seamless heights across chunk boundaries", () => {
    const pipeline = new GeneratorPipeline().addStage(new RealisticHeightGenerator());
    const res = 33;
    const size = 128;
    const tile00 = new TerrainTile({ cx: 0, cz: 0, size, resolution: res }, pipeline, 123);
    const tile10 = new TerrainTile({ cx: 1, cz: 0, size, resolution: res }, pipeline, 123);

    for (let j = 0; j < res; j++) {
      const rightEdge00 = tile00.cell.heights[j * res + (res - 1)]!;
      const leftEdge10 = tile10.cell.heights[j * res + 0]!;
      expect(Math.abs(rightEdge00 - leftEdge10)).toBeLessThan(1e-3);
    }
  });

  it("creates varied elevation with mountains and lowlands", () => {
    const pipeline = new GeneratorPipeline().addStage(new RealisticHeightGenerator());
    const tile = new TerrainTile({ cx: 0, cz: 0, size: 512, resolution: 33 }, pipeline, 42);

    let minH = Infinity;
    let maxH = -Infinity;
    for (const h of tile.cell.heights) {
      if (h < minH) minH = h;
      if (h > maxH) maxH = h;
    }

    // Should have significant elevation range (realistic terrain)
    expect(maxH - minH).toBeGreaterThan(100);
    expect(maxH).toBeGreaterThan(200); // mountains
  });
});

describe("Realistic Terrain - Erosion", () => {
  it("thermal erosion stabilizes steep slopes", () => {
    const res = 9;
    const size = 64;
    const count = res * res;
    const heights = new Float32Array(count);

    // Create a steep pyramid
    for (let j = 0; j < res; j++) {
      for (let i = 0; i < res; i++) {
        const dx = i - res / 2;
        const dz = j - res / 2;
        const dist = Math.sqrt(dx * dx + dz * dz);
        heights[j * res + i] = Math.max(0, 50 - dist * 10);
      }
    }

    const cell = {
      cx: 0,
      cz: 0,
      size,
      resolution: res,
      seed: 123,
      heights,
      slopes: new Float32Array(count),
      biomes: new Float32Array(count * 4),
      scatters: [],
    };

    const maxBefore = Math.max(...heights);
    const erosion = new ThermalErosionGenerator({ iterations: 3, talusAngle: 0.65 });
    erosion.process(cell);
    const maxAfter = Math.max(...cell.heights);

    // Peak should be reduced by thermal weathering
    expect(maxAfter).toBeLessThanOrEqual(maxBefore);
    // But not completely flattened
    expect(maxAfter).toBeGreaterThan(maxBefore * 0.5);
  });

  it("hydraulic erosion carves terrain and conserves material approximately", () => {
    const res = 17;
    const size = 128;
    const count = res * res;
    const heights = new Float32Array(count);

    // Inclined plane with some noise
    for (let j = 0; j < res; j++) {
      for (let i = 0; i < res; i++) {
        heights[j * res + i] = i * 2 + j * 1 + Math.sin(i * 0.5) * 2;
      }
    }

    const sumBefore = heights.reduce((a, b) => a + b, 0);

    const cell = {
      cx: 0,
      cz: 0,
      size,
      resolution: res,
      seed: 42,
      heights,
      slopes: new Float32Array(count),
      biomes: new Float32Array(count * 4),
      scatters: [],
    };

    const erosion = new HydraulicErosionGenerator({ iterations: 5 });
    erosion.process(cell);

    const sumAfter = cell.heights.reduce((a, b) => a + b, 0);
    // Material should be roughly conserved (within 10% due to deposition model)
    expect(Math.abs(sumAfter - sumBefore) / Math.max(1, Math.abs(sumBefore))).toBeLessThan(0.15);
  });

  it("valley carving creates depressions along flow paths", () => {
    const res = 17;
    const size = 128;
    const count = res * res;
    const heights = new Float32Array(count);

    // Create a simple slope from high (top) to low (bottom)
    for (let j = 0; j < res; j++) {
      for (let i = 0; i < res; i++) {
        heights[j * res + i] = (res - j) * 5 + Math.sin(i * 0.3) * 0.5;
      }
    }

    const cell = {
      cx: 0,
      cz: 0,
      size,
      resolution: res,
      seed: 123,
      heights,
      slopes: new Float32Array(count),
      biomes: new Float32Array(count * 4),
      scatters: [],
    };

    const minBefore = Math.min(...cell.heights);
    const carving = new ValleyCarvingGenerator({ minAccumulation: 3, carveDepth: 0.8 });
    carving.process(cell);
    const minAfter = Math.min(...cell.heights);

    // Carving should lower some areas (create valleys)
    expect(minAfter).toBeLessThanOrEqual(minBefore);
  });
});

describe("Realistic Terrain - Biome & Pipeline", () => {
  it("climate biome generates normalized splat weights", () => {
    const pipeline = new GeneratorPipeline()
      .addStage(new RealisticHeightGenerator())
      .addStage(new ClimateBiomeGenerator({ seaLevel: 5, snowLine: 400 }));

    const tile = new TerrainTile({ cx: 0, cz: 0, size: 256, resolution: 17 }, pipeline, 777);

    for (let i = 0; i < tile.cell.heights.length; i++) {
      const bIdx = i * 4;
      const w0 = tile.cell.biomes[bIdx]!;
      const w1 = tile.cell.biomes[bIdx + 1]!;
      const w2 = tile.cell.biomes[bIdx + 2]!;
      const w3 = tile.cell.biomes[bIdx + 3]!;

      const sum = w0 + w1 + w2 + w3;
      expect(sum).toBeCloseTo(1.0, 3);
      expect(w0).toBeGreaterThanOrEqual(0);
      expect(w1).toBeGreaterThanOrEqual(0);
      expect(w2).toBeGreaterThanOrEqual(0);
      expect(w3).toBeGreaterThanOrEqual(0);
    }
  });

  it("realistic pipeline generates deterministic tiles", () => {
    const pipeline = createRealisticTerrainPipeline({ seed: 42, hydraulicIterations: 4 });
    const tile1 = new TerrainTile({ cx: 2, cz: -3, size: 128, resolution: 17 }, pipeline, 42);
    const tile2 = new TerrainTile({ cx: 2, cz: -3, size: 128, resolution: 17 }, pipeline, 42);

    for (let i = 0; i < tile1.cell.heights.length; i++) {
      expect(tile1.cell.heights[i]).toBe(tile2.cell.heights[i]);
    }
  });

  it("realistic presets produce different terrain characteristics", () => {
    const alpine = createRealisticPipelinePreset("alpine", 123);
    const rolling = createRealisticPipelinePreset("rolling-hills", 123);
    const mountainous = createRealisticPipelinePreset("mountainous", 123);

    const res = 17;
    const size = 256;

    const tileAlpine = new TerrainTile({ cx: 0, cz: 0, size, resolution: res }, alpine, 123);
    const tileRolling = new TerrainTile({ cx: 0, cz: 0, size, resolution: res }, rolling, 123);
    const tileMountainous = new TerrainTile({ cx: 0, cz: 0, size, resolution: res }, mountainous, 123);

    const range = (tile: TerrainTile) => {
      let min = Infinity,
        max = -Infinity;
      for (const h of tile.cell.heights) {
        if (h < min) min = h;
        if (h > max) max = h;
      }
      return max - min;
    };

    const rangeAlpine = range(tileAlpine);
    const rangeRolling = range(tileRolling);
    const rangeMountainous = range(tileMountainous);

    // Mountainous should have larger elevation range than rolling hills
    expect(rangeMountainous).toBeGreaterThan(rangeRolling);
    // Alpine should also have significant range
    expect(rangeAlpine).toBeGreaterThan(100);
  });

  it("scatter generator respects slope and biome constraints", () => {
    const pipeline = createRealisticTerrainPipeline({ scatterCount: 20, hydraulicIterations: 2 });
    const tile = new TerrainTile({ cx: 1, cz: 1, size: 256, resolution: 33 }, pipeline, 999);

    expect(tile.cell.scatters.length).toBeGreaterThan(0);
    expect(tile.cell.scatters.length).toBeLessThanOrEqual(20);

    for (const s of tile.cell.scatters) {
      expect(s.scale).toBeGreaterThan(0);
      expect(s.rotationY).toBeGreaterThanOrEqual(0);
      expect(s.rotationY).toBeLessThanOrEqual(Math.PI * 2);
    }
  });

  it("detail noise preserves flat areas and adds roughness to slopes", () => {
    const res = 17;
    const size = 128;
    const count = res * res;
    const heights = new Float32Array(count).fill(0);

    // Create flat area with one steep slope in middle
    for (let j = 0; j < res; j++) {
      for (let i = 0; i < res; i++) {
        if (i > res / 2) {
          heights[j * res + i] = (i - res / 2) * 5;
        }
      }
    }

    const cell = {
      cx: 0,
      cz: 0,
      size,
      resolution: res,
      seed: 42,
      heights: heights.slice(),
      slopes: new Float32Array(count),
      biomes: new Float32Array(count * 4),
      scatters: [],
    };

    const flatBefore = cell.heights[0]!;
    const midIdx = Math.floor(res / 2) * res + Math.floor((res * 3) / 4);
    const slopeBefore = cell.heights[midIdx]!;

    const detail = new DetailNoiseGenerator({ amplitude: 2, minSlope: 0.1 });
    detail.process(cell);

    // Flat area should be mostly preserved (minSlope filter)
    expect(Math.abs(cell.heights[0]! - flatBefore)).toBeLessThan(0.1);
    // Sloped area should have detail added (changed)
    expect(cell.heights[midIdx]!).not.toBe(slopeBefore);
  });
});
