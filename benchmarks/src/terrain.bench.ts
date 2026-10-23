/**
 * Phase 22.3 terrain benchmark matrix.
 *
 * The terrain implementation is already deterministic and bounded; this matrix makes each of its
 * expensive boundaries measurable without pretending that a Node stopwatch is a GPU claim:
 * generation and erosion run the pure CPU stages, LOD exercises the same visible-cell selector,
 * streaming drives a real TerrainWorld through cold, resident, moved and cache-return frames, and
 * mesh generation builds the same skirted TerrainTile source the renderer uploads.
 */

import {
  Camera,
  Clock,
  GeneratorPipeline,
  HeightGenerator,
  HydraulicErosionGenerator,
  Logger,
  Profiler,
  Scene,
  SystemScratch,
  TerrainLOD,
  TerrainTile,
  TerrainWorld,
  ThermalErosionGenerator,
  Transform,
  Vec3,
  cellFromResult,
  createWorldCell,
  generateTerrainCell,
  resolutionForLod,
  terrainCellPayload,
  type LODSelection,
  type SystemContext,
  type TerrainCellTaskResult,
} from "@forge/engine";
import type { BenchmarkResult } from "./ecs.bench.ts";

export interface TerrainBenchmarkOptions {
  /** Cell grid sizes used by the worker-equivalent generation sweep. */
  generationResolutions?: readonly number[];
  /** Grid size used by the isolated thermal/hydraulic erosion sweep. */
  erosionResolution?: number;
  /** Grid sizes whose skirted geometry sources are built. */
  meshResolutions?: readonly number[];
  /** Median samples for pure CPU rows. */
  runs?: number;
  /** Number of resident chunks the streaming scenario may keep. */
  streamingVisibleChunks?: number;
}

export interface TerrainGenerationTiming {
  resolution: number;
  durationMs: number;
  bytes: number;
  minHeight: number;
  maxHeight: number;
  scatters: number;
  digest: number;
  deterministic: boolean;
}

export interface TerrainGenerationBenchmarkReport {
  results: BenchmarkResult[];
  timings: TerrainGenerationTiming[];
}

export interface TerrainErosionTiming {
  kind: "thermal" | "hydraulic";
  resolution: number;
  iterations: number;
  durationMs: number;
  changedSamples: number;
  absoluteDelta: number;
  minHeight: number;
  maxHeight: number;
}

export interface TerrainErosionBenchmarkReport {
  results: BenchmarkResult[];
  timings: TerrainErosionTiming[];
}

export interface TerrainLODBenchmarkReport {
  results: BenchmarkResult[];
  durationMs: number;
  selectedChunks: number;
  lodLevels: number[];
  resolutions: number[];
  morphSamples: number;
}

export interface TerrainStreamingFrame {
  durationMs: number;
  generated: number;
  inline: number;
  cacheHits: number;
  cacheMisses: number;
  residentChunks: number;
  residentBytes: number;
  readyChunks: number;
}

export interface TerrainStreamingBenchmarkReport {
  results: BenchmarkResult[];
  cold: TerrainStreamingFrame;
  steadyMs: number;
  moved: TerrainStreamingFrame;
  returned: TerrainStreamingFrame;
  visibleBudget: number;
  maxResidentChunks: number;
  cacheHits: number;
  generatedFrames: number;
}

export interface TerrainMeshTiming {
  resolution: number;
  durationMs: number;
  vertices: number;
  indices: number;
  expectedVertices: number;
  expectedIndices: number;
  minHeight: number;
  maxHeight: number;
}

export interface TerrainMeshBenchmarkReport {
  results: BenchmarkResult[];
  timings: TerrainMeshTiming[];
}

export interface TerrainBenchmarkReport {
  results: BenchmarkResult[];
  generation: TerrainGenerationBenchmarkReport;
  erosion: TerrainErosionBenchmarkReport;
  lod: TerrainLODBenchmarkReport;
  streaming: TerrainStreamingBenchmarkReport;
  mesh: TerrainMeshBenchmarkReport;
  notes: string[];
}

const DEFAULT_GENERATION_RESOLUTIONS = [33, 65, 129];
const DEFAULT_MESH_RESOLUTIONS = [17, 33, 65];
const DEFAULT_RUNS = 3;
const TERRAIN_SEED = 22_303;
const TERRAIN_SIZE = 128;

function median(samples: readonly number[]): number {
  const ordered = [...samples].sort((a, b) => a - b);
  return ordered[Math.floor(ordered.length / 2)] ?? 0;
}

function timed(runs: number, fn: () => void): number {
  // Warm the function once so a first JIT transition is not reported as the terrain algorithm.
  fn();
  const samples: number[] = [];
  for (let i = 0; i < Math.max(1, runs); i++) {
    const start = performance.now();
    fn();
    samples.push(performance.now() - start);
  }
  return median(samples);
}

function finite(value: number, label: string): void {
  if (!Number.isFinite(value)) throw new Error(`terrain benchmark produced a non-finite ${label}`);
}

function digestFloats(values: Float32Array, seed: number): number {
  const bits = new Uint32Array(values.buffer, values.byteOffset, values.byteLength / 4);
  let hash = seed >>> 0;
  for (let i = 0; i < bits.length; i++) hash = Math.imul(hash ^ bits[i]!, 16_777_619) >>> 0;
  return hash >>> 0;
}

function digestCell(cell: TerrainCellTaskResult): number {
  let hash = digestFloats(cell.heights, 2_166_136_261);
  hash = digestFloats(cell.slopes, hash);
  return digestFloats(cell.biomes, hash);
}

function generationPayload(resolution: number): ReturnType<typeof terrainCellPayload> {
  const pipeline = GeneratorPipeline.createDefault(TERRAIN_SEED);
  return terrainCellPayload(pipeline, TERRAIN_SEED, 3, -2, TERRAIN_SIZE, resolution);
}

function runGenerationBenchmark(resolutions: readonly number[], runs: number): TerrainGenerationBenchmarkReport {
  const timings: TerrainGenerationTiming[] = [];
  for (const requested of resolutions) {
    const resolution = Math.max(2, Math.floor(requested));
    const payload = generationPayload(resolution);
    const reference = generateTerrainCell(payload);
    let latest: TerrainCellTaskResult | undefined;
    const durationMs = timed(runs, () => {
      latest = generateTerrainCell(payload);
    });
    const repeat = generateTerrainCell(payload);
    const result = latest!;
    const digest = digestCell(result);
    const repeatDigest = digestCell(repeat);
    timings.push({
      resolution,
      durationMs,
      bytes: result.bytes,
      minHeight: result.minHeight,
      maxHeight: result.maxHeight,
      scatters: result.scatters.length,
      digest,
      deterministic: digest === digestCell(reference) && digest === repeatDigest,
    });
  }
  return {
    timings,
    results: timings.map((timing) => ({
      name: `terrain generation ${timing.resolution}×${timing.resolution}`,
      count: timing.resolution * timing.resolution,
      durationMs: timing.durationMs,
      opsPerSec: (timing.resolution * timing.resolution * 1000) / Math.max(timing.durationMs, 1e-9),
    })),
  };
}

function baseErosionCell(resolution: number): { cell: ReturnType<typeof createWorldCell>; source: Float32Array } {
  const cell = createWorldCell(1, -1, TERRAIN_SIZE, resolution, TERRAIN_SEED);
  // Use a relief scale that contains real talus work; a very smooth low-amplitude tile can
  // legitimately have no slope above the thermal threshold and would measure only the loop shell.
  new HeightGenerator({ octaves: 4, amplitude: 120 }).process(cell);
  return { cell, source: new Float32Array(cell.heights) };
}

function runErosionBenchmark(resolutionOption: number, runs: number): TerrainErosionBenchmarkReport {
  const resolution = Math.max(9, Math.floor(resolutionOption));
  const base = baseErosionCell(resolution);
  const timings: TerrainErosionTiming[] = [];
  const stages = [
    { kind: "thermal" as const, iterations: 3, stage: new ThermalErosionGenerator({ iterations: 3 }) },
    { kind: "hydraulic" as const, iterations: 5, stage: new HydraulicErosionGenerator({ iterations: 5 }) },
  ];

  for (const entry of stages) {
    let finalHeights = new Float32Array(base.source);
    const durationMs = timed(runs, () => {
      base.cell.heights.set(base.source);
      entry.stage.process(base.cell);
      finalHeights = new Float32Array(base.cell.heights);
    });
    let changedSamples = 0;
    let absoluteDelta = 0;
    let minHeight = Infinity;
    let maxHeight = -Infinity;
    for (let i = 0; i < finalHeights.length; i++) {
      const value = finalHeights[i]!;
      finite(value, `${entry.kind} erosion height`);
      minHeight = Math.min(minHeight, value);
      maxHeight = Math.max(maxHeight, value);
      const delta = Math.abs(value - base.source[i]!);
      absoluteDelta += delta;
      if (delta > 1e-6) changedSamples++;
    }
    timings.push({
      kind: entry.kind,
      resolution,
      iterations: entry.iterations,
      durationMs,
      changedSamples,
      absoluteDelta,
      minHeight,
      maxHeight,
    });
  }

  return {
    timings,
    results: timings.map((timing) => ({
      name: `terrain ${timing.kind} erosion ${timing.resolution}×${timing.resolution}`,
      count: timing.resolution * timing.resolution * timing.iterations,
      durationMs: timing.durationMs,
      opsPerSec: (timing.resolution * timing.resolution * timing.iterations * 1000) / Math.max(timing.durationMs, 1e-9),
    })),
  };
}

function runLODBenchmark(runs: number): TerrainLODBenchmarkReport {
  const lod = new TerrainLOD({
    baseChunkSize: 64,
    maxLOD: 4,
    lodDistances: [96, 192, 384, 768, 1536],
    transitionWidth: 0.2,
  });
  const camera = new Vec3(0, 20, 0);
  let selections: LODSelection[] = [];
  const durationMs = timed(runs, () => {
    selections = lod.selectVisibleChunks(camera, 1024);
    for (const selection of selections) resolutionForLod(33, selection.lod);
  });
  const levels = [...new Set(selections.map((selection) => selection.lod))].sort((a, b) => a - b);
  const resolutions = [...new Set(selections.map((selection) => resolutionForLod(33, selection.lod)))].sort((a, b) => a - b);
  const morphSamples = selections.filter((selection) => selection.geomorphAlpha > 0 && selection.geomorphAlpha < 1).length;
  return {
    durationMs,
    selectedChunks: selections.length,
    lodLevels: levels,
    resolutions,
    morphSamples,
    results: [
      {
        name: "terrain LOD selection + resolution/geomorph",
        count: selections.length,
        durationMs,
        opsPerSec: (selections.length * 1000) / Math.max(durationMs, 1e-9),
      },
    ],
  };
}

function makeTerrainContext(scene: Scene): SystemContext {
  return {
    world: scene.world,
    clock: new Clock(),
    dt: 1 / 60,
    fixedDt: 1 / 60,
    fixedSteps: 1,
    alpha: 0,
    elapsed: 0,
    frame: 1,
    logger: new Logger(),
    profiler: new Profiler(),
    services: { get: () => undefined, engineConfig: {} },
    scratch: new SystemScratch(),
  };
}

function readyChunkCount(terrain: TerrainWorld): number {
  let count = 0;
  for (const chunk of terrain.chunks.values()) if (chunk.state === "ready") count++;
  return count;
}

function streamFrame(terrain: TerrainWorld, context: SystemContext, camera: Transform, x: number, z: number): TerrainStreamingFrame {
  camera.setPosition(x, 20, z);
  const start = performance.now();
  terrain.update(context, 1 / 60);
  return {
    durationMs: performance.now() - start,
    generated: terrain.streamingStats.generatedThisFrame,
    inline: terrain.streamingStats.inlineThisFrame,
    cacheHits: terrain.streamingStats.cacheHits,
    cacheMisses: terrain.streamingStats.cacheMisses,
    residentChunks: terrain.chunks.size,
    residentBytes: terrain.streamingStats.residentBytes,
    readyChunks: readyChunkCount(terrain),
  };
}

function runStreamingBenchmark(visibleChunksOption: number): TerrainStreamingBenchmarkReport {
  const visibleBudget = Math.max(4, Math.floor(visibleChunksOption));
  const scene = new Scene({ name: "phase22-terrain-benchmark" });
  const terrain = new TerrainWorld({
    seed: TERRAIN_SEED,
    chunkSize: 64,
    chunkResolution: 17,
    viewDistance: 128,
    maxLOD: 3,
    visibleChunks: visibleBudget,
    generationsPerFrame: visibleBudget,
    uploadsPerFrame: visibleBudget,
    syncGeneration: true,
    horizonSkirt: false,
    warmUpChunks: visibleBudget,
  });
  scene.add(terrain);
  const cameraEntity = scene.createEntity("terrain-benchmark-camera");
  cameraEntity.add(new Camera());
  const camera = cameraEntity.add(new Transform());
  const context = makeTerrainContext(scene);

  const cold = streamFrame(terrain, context, camera, 0, 0);
  const steadySamples: number[] = [];
  for (let i = 0; i < 4; i++) steadySamples.push(streamFrame(terrain, context, camera, 0, 0).durationMs);
  const moved = streamFrame(terrain, context, camera, 640, 640);
  const returned = streamFrame(terrain, context, camera, 0, 0);
  const maxResidentChunks = Math.max(cold.residentChunks, moved.residentChunks, returned.residentChunks);
  const cacheHits = returned.cacheHits;
  const generatedFrames = cold.generated + moved.generated + returned.generated;
  const steadyMs = median(steadySamples);
  scene.dispose();

  return {
    cold,
    steadyMs,
    moved,
    returned,
    visibleBudget,
    maxResidentChunks,
    cacheHits,
    generatedFrames,
    results: [
      { name: "terrain streaming cold update", count: cold.generated, durationMs: cold.durationMs, opsPerSec: cold.generated * 1000 / Math.max(cold.durationMs, 1e-9) },
      { name: "terrain streaming resident update", count: steadySamples.length, durationMs: steadyMs, opsPerSec: steadySamples.length * 1000 / Math.max(steadyMs, 1e-9) },
      { name: "terrain streaming camera move + return", count: moved.generated + returned.generated, durationMs: moved.durationMs + returned.durationMs, opsPerSec: (moved.generated + returned.generated) * 1000 / Math.max(moved.durationMs + returned.durationMs, 1e-9) },
    ],
  };
}

function expectedMeshVertices(resolution: number): number {
  return resolution * resolution + 4 * resolution;
}

function expectedMeshIndices(resolution: number): number {
  return ((resolution - 1) * (resolution - 1) + 4 * (resolution - 1)) * 6;
}

function runMeshBenchmark(resolutions: readonly number[], runs: number): TerrainMeshBenchmarkReport {
  const timings: TerrainMeshTiming[] = [];
  for (const requested of resolutions) {
    const resolution = Math.max(3, Math.floor(requested));
    const source = cellFromResult(generateTerrainCell(generationPayload(resolution)));
    let lastTile: TerrainTile | undefined;
    const durationMs = timed(runs, () => {
      lastTile?.dispose();
      lastTile = new TerrainTile({
        cx: source.cx,
        cz: source.cz,
        size: source.size,
        resolution,
        lod: 1,
        geomorphAlpha: 0.25,
        skirtDepth: 8,
        cell: source,
      });
    });
    const tile = lastTile!;
    const positions = tile.geometrySource.positions;
    const indices = tile.geometrySource.indices;
    if (!indices) throw new Error(`terrain mesh ${resolution} did not produce indices`);
    let minHeight = Infinity;
    let maxHeight = -Infinity;
    for (let i = 1; i < positions.length; i += 3) {
      minHeight = Math.min(minHeight, positions[i]!);
      maxHeight = Math.max(maxHeight, positions[i]!);
    }
    tile.dispose();
    timings.push({
      resolution,
      durationMs,
      vertices: positions.length / 3,
      indices: indices.length,
      expectedVertices: expectedMeshVertices(resolution),
      expectedIndices: expectedMeshIndices(resolution),
      minHeight,
      maxHeight,
    });
  }
  return {
    timings,
    results: timings.map((timing) => ({
      name: `terrain mesh generation ${timing.resolution}×${timing.resolution} + skirts`,
      count: timing.vertices,
      durationMs: timing.durationMs,
      opsPerSec: (timing.vertices * 1000) / Math.max(timing.durationMs, 1e-9),
    })),
  };
}

/** Run the renderer-independent Phase 22.3 terrain matrix. */
export function runTerrainBenchmark(options: TerrainBenchmarkOptions = {}): TerrainBenchmarkReport {
  const runs = Math.max(1, Math.floor(options.runs ?? DEFAULT_RUNS));
  const generation = runGenerationBenchmark(options.generationResolutions ?? DEFAULT_GENERATION_RESOLUTIONS, runs);
  const erosion = runErosionBenchmark(options.erosionResolution ?? 65, runs);
  const lod = runLODBenchmark(runs);
  const streaming = runStreamingBenchmark(options.streamingVisibleChunks ?? 12);
  const mesh = runMeshBenchmark(options.meshResolutions ?? DEFAULT_MESH_RESOLUTIONS, runs);
  return {
    results: [...generation.results, ...erosion.results, ...lod.results, ...streaming.results, ...mesh.results],
    generation,
    erosion,
    lod,
    streaming,
    mesh,
    notes: [],
  };
}

/** Correctness, resource-shape and catastrophe guards for Phase 22.3. */
export function assertTerrainBenchmark(report: TerrainBenchmarkReport): string[] {
  const notes: string[] = [];
  for (const timing of report.generation.timings) {
    if (!timing.deterministic) throw new Error(`terrain generation ${timing.resolution} is not deterministic`);
    if (!(timing.bytes > 0) || !(timing.maxHeight > timing.minHeight)) throw new Error(`terrain generation ${timing.resolution} produced an empty height range`);
    if (!(timing.scatters > 0)) throw new Error(`terrain generation ${timing.resolution} produced no scatter instances`);
    finite(timing.durationMs, `generation ${timing.resolution} duration`);
  }
  const largestGeneration = report.generation.timings.at(-1)!;
  notes.push(`generation: ${report.generation.timings.length} deterministic grids, largest ${largestGeneration.resolution}×${largestGeneration.resolution} in ${largestGeneration.durationMs.toFixed(2)} ms (${largestGeneration.bytes} bytes)`);

  for (const timing of report.erosion.timings) {
    if (!(timing.changedSamples > 0) || !(timing.absoluteDelta > 0)) throw new Error(`${timing.kind} erosion changed no terrain samples`);
    if (!(timing.maxHeight > timing.minHeight)) throw new Error(`${timing.kind} erosion flattened the terrain unexpectedly`);
    finite(timing.durationMs, `${timing.kind} erosion duration`);
  }
  notes.push(`erosion: thermal ${report.erosion.timings[0]!.durationMs.toFixed(2)} ms + hydraulic ${report.erosion.timings[1]!.durationMs.toFixed(2)} ms at ${report.erosion.timings[0]!.resolution}×${report.erosion.timings[0]!.resolution}`);

  if (report.lod.lodLevels.length < 3 || report.lod.resolutions.length < 3) throw new Error(`terrain LOD selected too few levels (${report.lod.lodLevels.join(",")})`);
  if (!(report.lod.morphSamples > 0)) throw new Error("terrain LOD selected no geomorph transition samples");
  notes.push(`LOD: ${report.lod.selectedChunks} selected chunks across levels ${report.lod.lodLevels.join("/")} (${report.lod.resolutions.join("/")} grid resolutions), ${report.lod.morphSamples} transition samples`);

  const stream = report.streaming;
  if (stream.maxResidentChunks > stream.visibleBudget) throw new Error(`terrain streaming exceeded visible budget (${stream.maxResidentChunks}/${stream.visibleBudget})`);
  if (!(stream.cold.readyChunks > 0) || !(stream.moved.readyChunks > 0) || !(stream.returned.readyChunks > 0)) throw new Error("terrain streaming did not produce ready chunks at every camera position");
  if (!(stream.cacheHits > 0)) throw new Error("terrain streaming camera return did not hit the generation cache");
  if (!(stream.generatedFrames > 0)) throw new Error("terrain streaming generated no chunks");
  notes.push(`streaming: cold ${stream.cold.generated} chunks, resident ${stream.steadyMs.toFixed(2)} ms, moved ${stream.moved.generated}, return cache hits ${stream.cacheHits}, ${stream.maxResidentChunks}/${stream.visibleBudget} resident`);

  for (const timing of report.mesh.timings) {
    if (timing.vertices !== timing.expectedVertices || timing.indices !== timing.expectedIndices) throw new Error(`terrain mesh ${timing.resolution} has ${timing.vertices}/${timing.indices} instead of ${timing.expectedVertices}/${timing.expectedIndices}`);
    if (!(timing.maxHeight > timing.minHeight)) throw new Error(`terrain mesh ${timing.resolution} has no height range`);
    finite(timing.durationMs, `mesh ${timing.resolution} duration`);
  }
  const largestMesh = report.mesh.timings.at(-1)!;
  notes.push(`mesh: largest ${largestMesh.resolution}×${largestMesh.resolution} source has ${largestMesh.vertices} vertices / ${largestMesh.indices} indices in ${largestMesh.durationMs.toFixed(2)} ms`);

  const totalMs = report.results.reduce((sum, entry) => sum + entry.durationMs, 0);
  if (totalMs >= 20_000) throw new Error(`terrain benchmark matrix exceeded catastrophe bound (${totalMs.toFixed(1)} ms)`);
  return notes;
}
