/**
 * World-population benchmark (Phase 14, docs/RENDERING.md §4e).
 *
 * Three costs make a population cheap or not, and each is measured here against the thing it replaces:
 *
 * - **The scatter** — one bounded pass per (chunk, type) over the chunk's heightmap, run once when the
 *   chunk streams in. `scatterPopulationChunk` is that algorithm in TypeScript (the same code the
 *   engine runs), swept over the six presets so the cost is reported per type rather than for one
 *   favourable density.
 * - **The per-frame instance records** — the cost residency removes. Without a `residencyKey` the
 *   renderer composes every visible instance's matrix + tint into the frame's arena and uploads the
 *   arena every frame; with one, the block is composed and uploaded once and a steady frame does
 *   nothing at all. Both arms are measured here as *whole frames* on the mock device through
 *   `Renderer.renderScene`, so the numbers include the compose, the `writeBuffer` and the batch
 *   bookkeeping rather than an isolated inner loop.
 * - **The LOD mirror** — one `sqrt` and one threshold walk per *chained* batch per frame, plus two
 *   words in the record the device pass would otherwise own. Measured as the frame-time difference
 *   between a scene of chained geometries and the same scene of single-level ones, and as the index
 *   count the selection actually saves at distance.
 *
 * What cannot be measured here, and where it is instead: the device half. The mock records compute
 * dispatches but executes no WGSL, so `forge.objects.cull`'s level selection and the vertex-stage work
 * a coarser level avoids are not timings — they are pinned by `tests/objectCulling.test.ts` (the CPU
 * twin writes the same record words from the same rule, byte for byte), by `tests/rendering.test.ts`
 * (the prepass, the shadow maps and the record all draw the level the distance selected) and by
 * `check:browser` on a real adapter (the pass compiles, runs, and the two cullers present the same
 * picture). The index counts below are the honest stand-in for the GPU saving: they are what the
 * vertex stage is asked to run.
 *
 * The guards are shape checks, not stopwatch thresholds, so a slower CI runner does not turn a correct
 * build red — except one catastrophe bound per arm, because a population path that ate a frame's whole
 * budget would be a regression rather than a slow machine.
 */

import {
  AABB,
  Camera,
  GraphicsDevice,
  InstanceStruct,
  Material,
  POPULATION_PRESETS,
  POPULATION_PRESET_NAMES,
  PopulationInstanceBlock,
  Renderer,
  Scene,
  SceneObject,
  Vec3,
  createLodPrimitive,
  createRock,
  resolvePopulationTypeSpec,
  rockGeometrySource,
  scatterPopulationChunk,
  selectLodLevel,
  type Geometry,
  type PopulationCollector,
  type PopulationSource,
  type PopulationSubmission,
  type PopulationTypeSpec,
} from "@forge/engine";
import type { BenchmarkResult } from "./ecs.bench.ts";

/** The demo's chunk size; a block's capacity is its type's own `maxPerChunk`. */
const CHUNK_SIZE = 128;
/**
 * Chunks offered per frame: 12 × 10 of them, ~1.5 km of ground. The count is what makes the two
 * instance arms separable — 4 300 records are ~345 KB of compose + `writeBuffer` per frame on the
 * arena arm and none on the resident one, which is a difference a noisy runner can still see.
 */
const CHUNK_GRID = { x: 12, z: 10 };
const RECORD_BYTES = InstanceStruct.byteSize("storage");

/** Flat ground at y = 0: the scatter's slope and height rules then accept every candidate. */
function flatSampler(): { heightAt: () => number; normalYAt: () => number } {
  return { heightAt: () => 0, normalYAt: () => 1 };
}

export interface ScatterTiming {
  preset: string;
  id: number;
  densityGrid: number;
  /** Candidates the stratified grid visits (densityGrid²), accepted or not. */
  candidates: number;
  instances: number;
  /** Milliseconds per (chunk, type) scatter. */
  scatterMs: number;
}

/**
 * The same type at rising grid densities. A per-candidate cost that grows with the grid is a scatter
 * that allocates or re-samples per candidate instead of drawing a bounded stream; the presets cannot
 * show that on their own because their fixed cost (seeding the stream, clearing the block) dominates
 * at four candidates and disappears at a thousand.
 */
export interface ScatterSweepPoint {
  densityGrid: number;
  candidates: number;
  instances: number;
  scatterMs: number;
  perCandidateUs: number;
}

export interface ResidencyTiming {
  chunks: number;
  /** Instances offered across all chunks, in view or not (residency is resolved before the frustum). */
  offeredInstances: number;
  /** Instances the frames actually drew (the frustum decides, not the bench). */
  instances: number;
  batches: number;
  /** Per-frame milliseconds, arena arm: compose every record and upload the arena, every frame. */
  arenaFrameMs: number;
  arenaUploads: number;
  arenaUploadedBytes: number;
  /** Per-frame milliseconds of the resident arm's *first* frame: allocate, compose, upload once. */
  residentFirstMs: number;
  residentFirstUploads: number;
  residentFirstBytes: number;
  /** Per-frame milliseconds of every frame after it: nothing to compose, nothing to upload. */
  residentSteadyMs: number;
  residentSteadyUploads: number;
  residentSteadyBytes: number;
  /** Bytes of instance buffer the resident region holds (the slots, bucket-rounded). */
  residentBytes: number;
}

export interface LodTiming {
  batches: number;
  /** Per-frame milliseconds with a three-level chain on every batch (the mirror runs per batch). */
  chainedFrameMs: number;
  /** Per-frame milliseconds with the same batches on single-level geometry. */
  plainFrameMs: number;
  chainedTriangles: number;
  plainTriangles: number;
  /** Indices one chained draw issues at 10 m and at 500 m, and the ratio between them. */
  nearIndices: number;
  farIndices: number;
  reduction: number;
}

export interface PopulationBenchmarkReport {
  results: BenchmarkResult[];
  scatter: ScatterTiming[];
  sweep: ScatterSweepPoint[];
  residency: ResidencyTiming;
  lod: LodTiming;
}

/**
 * Per-frame milliseconds for `fn`, as the median of `runs` samples. A frame of population work is a
 * fraction of a millisecond — inside `performance.now()`'s resolution and the JIT's warm-up — so the
 * first call picks a repeat count that makes each sample about 4 ms of work, and divides it back out.
 */
function timedPerFrame(runs: number, fn: () => void): number {
  const t0 = performance.now();
  fn();
  const single = Math.max(performance.now() - t0, 1e-4);
  const batch = Math.max(1, Math.min(400, Math.round(4 / single)));
  const samples: number[] = [];
  for (let i = 0; i < runs; i++) {
    const start = performance.now();
    for (let k = 0; k < batch; k++) fn();
    samples.push((performance.now() - start) / batch);
  }
  samples.sort((a, b) => a - b);
  return samples[samples.length >> 1]!;
}

/** A source that offers a fixed list of submissions every frame — a streamed disc, minus the streaming. */
class BenchPopulation extends SceneObject implements PopulationSource {
  readonly name = "bench-population";
  readonly submissions: readonly PopulationSubmission[];

  // No parameter properties: `npm run bench` runs these files through Node's strip-only TypeScript
  // loader, which rejects them (and the other benches do not use them either).
  constructor(submissions: readonly PopulationSubmission[]) {
    super();
    this.submissions = submissions;
  }

  collectPopulations(collector: PopulationCollector): void {
    for (let i = 0; i < this.submissions.length; i++) collector.addPopulationBatch(this.submissions[i]!);
  }
}

/** One grid of (chunk, type) blocks scattered over flat ground, as submissions the renderer accepts. */
function benchSubmissions(geometry: Geometry, material: Material, spec: PopulationTypeSpec, resident: boolean): PopulationSubmission[] {
  const resolved = resolvePopulationTypeSpec(spec);
  const out: PopulationSubmission[] = [];
  for (let cz = 0; cz < CHUNK_GRID.z; cz++) {
    for (let cx = 0; cx < CHUNK_GRID.x; cx++) {
      const block = new PopulationInstanceBlock(resolved.maxPerChunk);
      scatterPopulationChunk(spec, 4242, cx, cz, CHUNK_SIZE, flatSampler(), block);
      // Spread the chunks over the ground the scatter thinks it is: the block's positions are chunk
      // local, so the batch's bounds are the chunk's own cell in the grid.
      const originX = (cx - CHUNK_GRID.x / 2) * CHUNK_SIZE;
      const originZ = (cz - CHUNK_GRID.z / 2) * CHUNK_SIZE;
      for (let k = 0; k < block.count; k++) {
        block.positions[k * 3] = block.positions[k * 3]! + originX;
        block.positions[k * 3 + 2] = block.positions[k * 3 + 2]! + originZ;
      }
      const half = CHUNK_SIZE / 2;
      out.push({
        geometry,
        material,
        instances: block,
        bounds: new AABB(new Vec3(originX - half, -2, originZ - half), new Vec3(originX + half, 2, originZ + half)),
        castShadow: false,
        maxDistance: 0,
        ...(resident
          ? {
              residencyKey: `bench:${resolved.id}:${cx},${cz}`,
              residencyVersion: 1,
            }
          : {}),
      });
    }
  }
  return out;
}

/**
 * A scene, a camera overlooking the grid, and a renderer ready to draw it.
 *
 * The frame is deliberately bare — no shadows, sky, prepass, SSAO, bloom or HDR chain — because what
 * is being compared is the population path, and a mock device spends most of a full frame validating
 * passes that both arms run identically. A bare frame puts the instance records back in the
 * measurement's foreground; `check:browser` is what proves the full frame on a real device.
 */
async function benchFrame(device: GraphicsDevice, geometry: Geometry, material: Material, submissions: readonly PopulationSubmission[]) {
  const scene = new Scene({ name: "population-bench" });
  scene.settings.hdr = false;
  const cameraEntity = scene.createTransformedEntity("camera", new Vec3(0, 60, -420));
  const camera = new Camera();
  camera.fovY = Math.PI / 3;
  camera.near = 0.5;
  camera.far = 2400;
  scene.world.addComponent(cameraEntity.id, camera);
  cameraEntity.transform.lookAt(new Vec3(0, 0, 120));
  scene.add(new BenchPopulation(submissions));
  const renderer = new Renderer(device, {
    shadows: false,
    bloom: false,
    sky: false,
    depthPrepass: false,
    ssao: false,
    clusteredLighting: false,
    shadowMapSize: 256,
  });
  return { scene, renderer };
}

export async function runPopulationBenchmark(runs = 5): Promise<PopulationBenchmarkReport> {
  const results: BenchmarkResult[] = [];
  const sampler = flatSampler();

  // ------------------------------------------------------------- the scatter, per preset
  const scatter: ScatterTiming[] = [];
  for (const name of POPULATION_PRESET_NAMES) {
    const spec = POPULATION_PRESETS[name];
    const resolved = resolvePopulationTypeSpec(spec);
    const block = new PopulationInstanceBlock(resolved.maxPerChunk);
    const scatterMs = timedPerFrame(runs, () => scatterPopulationChunk(spec, 4242, 3, -2, CHUNK_SIZE, sampler, block));
    scatter.push({
      preset: name,
      id: resolved.id,
      densityGrid: resolved.densityGrid,
      candidates: resolved.densityGrid * resolved.densityGrid,
      instances: block.count,
      scatterMs,
    });
    results.push({
      name: `scatter ${name} (chunk ${CHUNK_SIZE} m, grid ${resolved.densityGrid}x${resolved.densityGrid})`,
      count: block.count,
      durationMs: scatterMs,
      opsPerSec: scatterMs > 0 ? block.count / (scatterMs / 1000) : 0,
    });
  }

  // One type at rising densities: the linearity check the six presets cannot make between themselves.
  const sweep: ScatterSweepPoint[] = [];
  for (const densityGrid of [8, 16, 24, 32]) {
    const spec: PopulationTypeSpec = { ...POPULATION_PRESETS.rock, densityGrid };
    const resolved = resolvePopulationTypeSpec(spec);
    const block = new PopulationInstanceBlock(resolved.maxPerChunk);
    const scatterMs = timedPerFrame(runs, () => scatterPopulationChunk(spec, 4242, 3, -2, CHUNK_SIZE, sampler, block));
    sweep.push({
      densityGrid,
      candidates: resolved.densityGrid * resolved.densityGrid,
      instances: block.count,
      scatterMs,
      perCandidateUs: (scatterMs / resolved.densityGrid ** 2) * 1000,
    });
  }

  const device = await GraphicsDevice.create({ forceMock: true });
  device.resize(320, 180);
  const rockSpec: PopulationTypeSpec = { ...POPULATION_PRESETS.rock, scaleMin: 0.8, scaleMax: 1.2 };

  // ------------------------------------------------- per-frame records: arena vs device-resident
  const material = new Material({ label: "bench-rock", color: 0x997755, roughness: 0.95 });
  const plainGeometry = createRock(device, { radius: 0.8, segments: 7, seed: 7 });
  const arenaSubmissions = benchSubmissions(plainGeometry, material, rockSpec, false);
  const residentSubmissions = benchSubmissions(plainGeometry, material, rockSpec, true);

  const arena = await benchFrame(device, plainGeometry, material, arenaSubmissions);
  arena.renderer.renderScene(arena.scene);
  const arenaFrameMs = timedPerFrame(runs, () => arena.renderer.renderScene(arena.scene));
  const arenaStats = { ...arena.renderer.stats };
  arena.renderer.dispose();
  arena.scene.dispose();

  const resident = await benchFrame(device, plainGeometry, material, residentSubmissions);
  const firstStart = performance.now();
  resident.renderer.renderScene(resident.scene);
  const residentFirstMs = performance.now() - firstStart;
  const firstStats = { ...resident.renderer.stats };
  const residentSteadyMs = timedPerFrame(runs, () => resident.renderer.renderScene(resident.scene));
  const steadyStats = { ...resident.renderer.stats };
  resident.renderer.dispose();
  resident.scene.dispose();

  const offeredInstances = arenaSubmissions.reduce((sum, submission) => sum + submission.instances.count, 0);
  const residency: ResidencyTiming = {
    chunks: arenaSubmissions.length,
    offeredInstances,
    instances: arenaStats.populationInstances,
    batches: arenaStats.populationBatches,
    arenaFrameMs,
    arenaUploads: arenaStats.populationUploads,
    arenaUploadedBytes: arenaStats.populationUploadedBytes,
    residentFirstMs,
    residentFirstUploads: firstStats.populationUploads,
    residentFirstBytes: firstStats.populationUploadedBytes,
    residentSteadyMs,
    residentSteadyUploads: steadyStats.populationUploads,
    residentSteadyBytes: steadyStats.populationUploadedBytes,
    residentBytes: steadyStats.populationResidentBytes,
  };
  results.push({
    name: `population frame, ${residency.chunks} chunks / ${residency.instances} instances (arena)`,
    count: residency.instances,
    durationMs: arenaFrameMs,
    opsPerSec: arenaFrameMs > 0 ? residency.instances / (arenaFrameMs / 1000) : 0,
  });
  results.push({
    name: `population frame, ${residency.chunks} chunks / ${residency.instances} instances (device-resident)`,
    count: residency.instances,
    durationMs: residentSteadyMs,
    opsPerSec: residentSteadyMs > 0 ? residency.instances / (residentSteadyMs / 1000) : 0,
  });

  // ------------------------------------------------------- the LOD mirror, and what it saves
  // A rock chain of the shape the demo uses: the same shape at 10, 6 and 4 segments (`rockGeometrySource`
  // clamps below four), switching at 140 m and 340 m — 600, 216 and 96 indices.
  const SEGMENTS = [10, 6, 4];
  const DISTANCES = [140, 340];
  const chainedGeometry = createLodPrimitive(device, {
    build: (level) => rockGeometrySource({ radius: 0.8, segments: SEGMENTS[level]!, seed: 7, roughness: 0.34 }),
    levels: SEGMENTS.length,
    distances: DISTANCES,
  });
  const chainedSubmissions = benchSubmissions(chainedGeometry, material, rockSpec, true);
  const chained = await benchFrame(device, chainedGeometry, material, chainedSubmissions);
  chained.renderer.renderScene(chained.scene);
  const chainedFrameMs = timedPerFrame(runs, () => chained.renderer.renderScene(chained.scene));
  const chainedStats = { ...chained.renderer.stats };
  chained.renderer.dispose();
  chained.scene.dispose();

  // The resident arm above is the same scene on single-level geometry, so its steady frame is the
  // comparison — same chunks, same instances, same camera, no chain to mirror.
  const lod: LodTiming = {
    batches: chainedStats.lodBatches,
    chainedFrameMs,
    plainFrameMs: residentSteadyMs,
    chainedTriangles: chainedStats.triangles,
    plainTriangles: steadyStats.triangles,
    nearIndices: chainedGeometry.lodWindow(selectLodLevel(chainedGeometry.lods!, 10)).indexCount,
    farIndices: chainedGeometry.lodWindow(selectLodLevel(chainedGeometry.lods!, 500)).indexCount,
    reduction: 0,
  };
  lod.reduction = lod.nearIndices / Math.max(1, lod.farIndices);
  results.push({
    name: `population frame, ${lod.batches} chained batches (LOD mirror, device-resident)`,
    count: chainedStats.populationInstances,
    durationMs: chainedFrameMs,
    opsPerSec: chainedFrameMs > 0 ? chainedStats.populationInstances / (chainedFrameMs / 1000) : 0,
  });

  chainedGeometry.dispose();
  plainGeometry.dispose();
  material.dispose();
  await device.dispose();

  return { results, scatter, sweep, residency, lod };
}

/**
 * Shape checks over a run — no stopwatch thresholds except one catastrophe bound per arm. Returns the
 * lines to print, and throws when a shape is wrong (a scatter that is not linear in its candidates, a
 * resident frame that still uploads, a mirror that costs more than the work it saves).
 */
export function assertPopulationBenchmark(report: PopulationBenchmarkReport): string[] {
  const notes: string[] = [];

  // 1. Populating a chunk is a streamer's budget line, not a frame's: every type has to scatter well
  //    inside a millisecond, and all six together (what one chunk of the demo costs on arrival) inside
  //    a couple of them, or `generationsPerFrame` could not be honoured at any useful value.
  const totalInstances = report.scatter.reduce((sum, s) => sum + s.instances, 0);
  if (totalInstances === 0) throw new Error("no preset scattered a single instance on flat ground — the bench measured an empty loop");
  const scatterTotal = report.scatter.reduce((sum, s) => sum + s.scatterMs, 0);
  for (const timing of report.scatter) {
    if (timing.instances === 0) throw new Error(`the "${timing.preset}" preset scattered nothing on flat ground — its own limits reject every candidate`);
    if (!(timing.scatterMs < 0.5)) {
      throw new Error(`scattering one "${timing.preset}" chunk took ${timing.scatterMs.toFixed(2)} ms — a streamer budgeted in chunks per frame cannot use it`);
    }
  }
  if (!(scatterTotal < 2)) {
    throw new Error(`all six presets together took ${scatterTotal.toFixed(2)} ms for one chunk — a chunk arrival would cost a frame`);
  }
  notes.push(
    `scatter per (chunk, type): ${report.scatter.map((s) => `${s.preset} ${s.scatterMs.toFixed(3)} ms → ${s.instances}/${s.candidates}`).join(", ")}; all six ${scatterTotal.toFixed(3)} ms`,
  );

  // 2. The scatter is O(candidates): one bounded set of random draws per grid cell, accepted or not.
  //    Measured on one type at rising densities, because across the six presets the fixed cost (seeding
  //    the stream, clearing the block) dominates the small grids and hides the per-candidate one.
  const small = report.sweep[0]!;
  const large = report.sweep[report.sweep.length - 1]!;
  const previous = report.sweep[report.sweep.length - 2]!;
  const growth = large.perCandidateUs / Math.max(previous.perCandidateUs, 1e-9);
  if (!(growth < 2.5)) {
    throw new Error(`per-candidate scatter cost grew ${growth.toFixed(2)}x from ${previous.candidates} to ${large.candidates} candidates — the scatter is not linear in its grid`);
  }
  notes.push(
    `scatter linearity: ${report.sweep.map((p) => `${p.candidates} cand ${p.perCandidateUs.toFixed(2)}µs`).join(" → ")} per candidate (${growth.toFixed(2)}x over the last step), ` +
      `${small.scatterMs.toFixed(3)} ms at ${small.densityGrid}x${small.densityGrid} → ${large.scatterMs.toFixed(3)} ms at ${large.densityGrid}x${large.densityGrid}`,
  );

  const r = report.residency;
  if (r.instances === 0 || r.batches === 0) throw new Error("the population bench drew nothing — the grid is out of the frustum");

  // 2. Residency is defined by what a steady frame does *not* do. The arena arm composes and uploads
  //    every visible instance's record every frame; the resident arm uploads them once, on the frame
  //    it first saw the key, and then nothing — a steady frame that still uploads is the regression
  //    this whole step exists to remove.
  if (r.arenaUploads !== 0 || r.arenaUploadedBytes !== 0) {
    throw new Error(`the arena arm reported ${r.arenaUploads} population uploads — those counters belong to the resident path alone`);
  }
  if (r.residentFirstUploads < r.chunks) {
    throw new Error(`the resident arm's first frame uploaded ${r.residentFirstUploads} record ranges for ${r.chunks} chunks`);
  }
  // Every offered chunk is uploaded on first sight, in view or not: residency is resolved before the
  // frustum test, so a chunk that swings into view a frame later draws from memory already written.
  if (r.residentFirstBytes !== r.offeredInstances * RECORD_BYTES) {
    throw new Error(`the first frame uploaded ${r.residentFirstBytes} bytes for ${r.offeredInstances} offered instances (${r.offeredInstances * RECORD_BYTES} expected at ${RECORD_BYTES} B per record)`);
  }
  if (r.residentSteadyUploads !== 0 || r.residentSteadyBytes !== 0) {
    throw new Error(`a steady device-resident frame uploaded ${r.residentSteadyUploads} ranges / ${r.residentSteadyBytes} bytes — the records are not staying on the device`);
  }
  notes.push(
    `per-frame records, ${r.chunks} chunks (${r.offeredInstances} offered, ${r.instances} drawn in ${r.batches} batches): ` +
      `the arena composes and uploads ${r.instances * RECORD_BYTES} B every frame; the resident path uploads ${r.residentFirstBytes} B once ` +
      `(first frame ${r.residentFirstMs.toFixed(2)} ms, ${r.residentBytes} B of slots held) and then 0 B`,
  );

  // 3. The steady resident frame must not be *slower* than the arena frame it replaces: residency
  //    trades a per-frame compose for bookkeeping (a key lookup, a frame stamp, a sweep). The bound is
  //    loose — a noisy CI machine moves both arms — but a resident frame that cost twice the arena
  //    frame would mean the bookkeeping, not the uploads, was the expensive half.
  if (!(r.residentSteadyMs < r.arenaFrameMs * 1.6 + 0.25)) {
    throw new Error(`a steady device-resident frame costs ${r.residentSteadyMs.toFixed(2)} ms against the arena's ${r.arenaFrameMs.toFixed(2)} ms — residency is not paying for itself`);
  }
  notes.push(`frame time ${r.arenaFrameMs.toFixed(2)} ms (arena) → ${r.residentSteadyMs.toFixed(2)} ms (device-resident), ${r.residentBytes} B of instance buffer held in slots`);
  // The frame times are *reported*, not guarded: the same arena frame measured 3.1, 3.3 and 4.7 ms
  // across three runs of this tree, so a ratio guard here would flake on a loaded runner while the
  // thing it protects — records composed and written once instead of every frame — is exactly what the
  // byte counters above assert deterministically. What is guarded is that the frame stays a frame.
  if (!(r.residentSteadyMs < 40)) {
    throw new Error(`one resident population frame on the mock took ${r.residentSteadyMs.toFixed(1)} ms for ${r.instances} instances — a frame's whole budget`);
  }

  // 4. The mirror is per chained batch and must stay small next to the frame it is part of; the saving
  //    is the index count the level selection removes, which is the vertex-stage work a real device
  //    does not run (and the mock cannot time).
  const l = report.lod;
  if (l.batches === 0) throw new Error("no batch carried a LOD chain — the mirror was never exercised");
  if (!(l.chainedFrameMs < l.plainFrameMs * 1.6 + 0.25)) {
    throw new Error(`a frame of ${l.batches} chained batches costs ${l.chainedFrameMs.toFixed(2)} ms against ${l.plainFrameMs.toFixed(2)} ms unchained — the LOD mirror is not one sqrt and a threshold walk per batch`);
  }
  if (!(l.reduction >= 4)) {
    throw new Error(`the chain's coarsest level draws ${l.farIndices} of ${l.nearIndices} indices (${l.reduction.toFixed(1)}x) — a level that saves nothing is not a level`);
  }
  // The frame's own triangle count is the saving a real device's vertex stage sees: the mock does not
  // rasterize, but it does report what each draw asked for.
  if (!(l.plainTriangles > l.chainedTriangles * 1.5)) {
    throw new Error(`the chained frame drew ${l.chainedTriangles} triangles against ${l.plainTriangles} unchained — the level selection is not reaching the draws`);
  }
  notes.push(
    `LOD mirror: ${l.chainedFrameMs.toFixed(2)} ms/frame with ${l.batches} chained batches vs ${l.plainFrameMs.toFixed(2)} ms unchained; ` +
      `one draw issues ${l.nearIndices} indices at 10 m and ${l.farIndices} at 500 m (${l.reduction.toFixed(1)}x fewer), ` +
      `frame triangles ${l.plainTriangles} → ${l.chainedTriangles}`,
  );

  return notes;
}
