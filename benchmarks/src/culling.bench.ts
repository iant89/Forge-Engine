/**
 * Object-culling stress benchmark (Phase 13.5, docs/RENDERING.md §4d).
 *
 * The culler has two halves with very different costs, and 13.5's split follows exactly that:
 *
 * - **The cull itself** — O(batches): a sphere/plane test per batch for the frustum, one distance
 *   comparison when the batch has a limit, and (with occlusion on) one projected rectangle plus a walk
 *   over the pyramid texels it covers. `cullBatchesOnCpu` is that algorithm in TypeScript and the
 *   device's `forge.objects.cull` is its transcription, one invocation per batch in
 *   `ceil(batches / 64)` workgroups.
 * - **The pyramid** — O(pixels of the depth target): level 0 reads every depth texel of the frame and
 *   each further level halves it. `buildHizOnCpu` is what that costs on the CPU, and it is why the
 *   twin does *not* do occlusion at all: the device reduces the depth in the same frame's command
 *   buffer for a fraction of the dispatch budget, and the CPU would have to read the depth back first
 *   (a stall) to do the same work.
 *
 * The sweep below holds the scene fixed and moves the batch count, measuring the three tests
 * separately, then builds a 1280×720 pyramid once per frame to show the stage the twin skips. The GPU
 * pass cannot be timed here — the mock device records dispatches but executes no WGSL — so what the
 * device *does* is pinned by `tests/objectCulling.test.ts` (the twin, byte for byte) and by
 * `check:browser` (the pass compiles, runs, and draws the same frame the twin draws).
 *
 * The guards are shape checks, not stopwatch thresholds, so a slower CI runner does not turn a correct
 * build red: the per-batch cost must not grow super-linearly with the batch count, the occlusion test
 * must stay in the same order of magnitude as the frustum test, and one frame of the twin at the
 * 8192-batch cap must stay inside a catastrophe bound. A fallback that took a whole frame's budget
 * would be a regression, not a slow machine.
 *
 * **Phase 13.6 does not add a curve to this file.** The record write (`CULL_FLAG_RECORDS`) is one
 * `u32` store and one `atomicAdd` inside the invocation the sweep already measures, and the compaction
 * slot is the other counter — both are per batch and constant-size, so the twin's numbers above still
 * bound the device pass. What 13.6 changes is what the *draw* costs: a zero-instance record never
 * enters the vertex stage, which is work per instance that a mock device cannot time either (the mock
 * counts the vertices the record asks for; the saving is measured as a difference in
 * `tests/frame.test.ts` and on a real device by `check:browser`'s identical-picture A/B). The budget
 * argument for `indirectDraws` is the same one 13.5 made for the pass: one word per batch decided on
 * the device beats a per-batch draw call the CPU issues and a vertex stage that runs for nothing.
 */

import {
  CULL_FLAG_DISTANCE,
  CULL_FLAG_FRUSTUM,
  CULL_FLAG_OCCLUSION,
  MAX_CULLED_BATCHES,
  Mat4,
  Vec3,
  buildHizOnCpu,
  cullBatchesOnCpu,
  hizLevelCount,
  type ObjectCullParams,
} from "@forge/engine";
import type { BenchmarkResult } from "./ecs.bench.ts";

const WIDTH = 1280;
const HEIGHT = 720;
const NEAR = 0.5;
const FAR = 400;

/** A camera 12 m out, 6 m up, looking at the origin — the demo's framing, with a 400 m far plane. */
function cameraParams(): ObjectCullParams {
  const view = new Mat4().setLookAt(new Vec3(0, 6, 12), new Vec3(0, 1, 0), new Vec3(0, 1, 0));
  const proj = new Mat4().setPerspective(Math.PI / 3, WIDTH / HEIGHT, NEAR, FAR);
  const viewProj = new Mat4().multiplyMatrices(proj, view);
  return {
    view: view.m,
    proj: proj.m,
    viewProj: viewProj.m,
    cameraPos: { x: 0, y: 6, z: 12 },
    near: NEAR,
    far: FAR,
    width: WIDTH,
    height: HEIGHT,
    flags: CULL_FLAG_FRUSTUM,
    hizLevels: 0,
  };
}

/**
 * A field of batches over the ground the camera looks at, like the demo's rigs: a grid of small boxes
 * at 0.5–3 m, plus every 16th one with a distance limit so the distance test has work to do. The
 * shapes are deterministic, so two runs measure the same scene.
 */
function batchBounds(count: number): Float32Array {
  const out = new Float32Array(count * 8);
  const side = Math.max(1, Math.ceil(Math.sqrt(count)));
  const step = 40 / Math.max(1, side);
  for (let i = 0; i < count; i++) {
    const x = ((i % side) - (side - 1) / 2) * step;
    const z = (Math.floor(i / side) - (side - 1) / 2) * step;
    const r = 0.5 + (i % 5) * 0.5;
    const base = i * 8;
    out[base] = x - r;
    out[base + 1] = 0.5;
    out[base + 2] = z - r;
    out[base + 3] = i % 16 === 0 ? 25 : 0; // a distance limit on every 16th batch
    out[base + 4] = x + r;
    out[base + 5] = 0.5 + r * 2;
    out[base + 6] = z + r;
  }
  return out;
}

/** A 1280×720 depth image with a wall over the left half, the way a real frame's depth arrives. */
function depthImage(): Float32Array {
  const depth = new Float32Array(WIDTH * HEIGHT).fill(1);
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH >> 1; x++) depth[y * WIDTH + x] = 0.2;
  }
  return depth;
}

export interface CullTiming {
  batches: number;
  /** Frustum only, milliseconds per frame. */
  frustumMs: number;
  /** Frustum + the distance limits, milliseconds per frame. */
  distanceMs: number;
  /** Frustum + distance + the HiZ rectangle and texel walk (the pyramid is built once, not here). */
  occlusionMs: number;
  culledFrustum: number;
  culledDistance: number;
  culledOccluded: number;
}

export interface CullingBenchmarkReport {
  results: BenchmarkResult[];
  timings: CullTiming[];
  /** `buildHizOnCpu` over one 1280×720 frame, the reduction the CPU twin does not do. */
  pyramidMs: number;
  levels: number;
  /** Milliseconds per batch at each size, for the linearity guard (`occlusionMs / batches`). */
  perBatch: number[];
}

/**
 * Per-frame milliseconds for `fn`, as the median of `runs` samples. One frame of culling is a handful
 * of microseconds — inside `performance.now()`'s resolution and the JIT's warm-up — so the first call
 * sets a batch size that makes each sample about 2 ms of work, and the batch is divided back out.
 */
function timedPerFrame(runs: number, fn: () => void): number {
  const t0 = performance.now();
  fn();
  const single = Math.max(performance.now() - t0, 1e-4);
  const batch = Math.max(1, Math.min(2000, Math.round(2 / single)));
  const samples: number[] = [];
  for (let i = 0; i < runs; i++) {
    const start = performance.now();
    for (let k = 0; k < batch; k++) fn();
    samples.push((performance.now() - start) / batch);
  }
  samples.sort((a, b) => a - b);
  return samples[samples.length >> 1]!;
}

export function runCullingBenchmark(sizes: readonly number[] = [512, 2048, MAX_CULLED_BATCHES], runs = 5): CullingBenchmarkReport {
  const base = cameraParams();
  const depth = depthImage();
  const levels = hizLevelCount(WIDTH, HEIGHT);
  const pyramid = buildHizOnCpu(depth, WIDTH, HEIGHT, NEAR, FAR, levels);
  const timings: CullTiming[] = [];
  const results: BenchmarkResult[] = [];

  for (const batches of sizes) {
    const bounds = batchBounds(batches);
    const words = new Uint32Array(batches);
    const frustumParams: ObjectCullParams = { ...base, flags: CULL_FLAG_FRUSTUM };
    const distanceParams: ObjectCullParams = { ...base, flags: CULL_FLAG_FRUSTUM | CULL_FLAG_DISTANCE };
    const occlusionParams: ObjectCullParams = { ...base, flags: CULL_FLAG_FRUSTUM | CULL_FLAG_DISTANCE | CULL_FLAG_OCCLUSION, hizLevels: levels };

    const frustumMs = timedPerFrame(runs, () => cullBatchesOnCpu(bounds, batches, frustumParams, words));
    const distanceMs = timedPerFrame(runs, () => cullBatchesOnCpu(bounds, batches, distanceParams, words));
    const occlusionMs = timedPerFrame(runs, () => cullBatchesOnCpu(bounds, batches, occlusionParams, words, pyramid));
    const stats = cullBatchesOnCpu(bounds, batches, occlusionParams, words, pyramid);
    // The verdicts have to be non-trivial, or the timings above measure an empty loop.
    if (stats.culledFrustum + stats.culledDistance + stats.culledOccluded === 0) {
      throw new Error(`the culling benchmark culled nothing at ${batches} batches — the field is out of the frustum or the planes are wrong`);
    }
    timings.push({ batches, frustumMs, distanceMs, occlusionMs, culledFrustum: stats.culledFrustum, culledDistance: stats.culledDistance, culledOccluded: stats.culledOccluded });
    results.push({
      name: `object cull ${batches} batches (cpu twin, frustum+distance+hiz)`,
      count: batches,
      durationMs: occlusionMs,
      opsPerSec: occlusionMs > 0 ? batches / (occlusionMs / 1000) : 0,
    });
  }

  // The stage the twin skips: one 1280x720 reduce per frame, which is what the device's
  // `forge.hiz.0..<n>` passes do inside the frame's own command buffer.
  const pyramidMs = timedPerFrame(Math.max(3, runs >> 1), () => buildHizOnCpu(depth, WIDTH, HEIGHT, NEAR, FAR, levels));
  results.push({
    name: `hiz pyramid ${WIDTH}x${HEIGHT} (cpu twin, ${levels} levels)`,
    count: WIDTH * HEIGHT,
    durationMs: pyramidMs,
    opsPerSec: WIDTH * HEIGHT / (pyramidMs / 1000),
  });

  return { results, timings, pyramidMs, levels, perBatch: timings.map((t) => t.occlusionMs / t.batches) };
}

/**
 * Shape checks over a run — no stopwatch thresholds except one catastrophe bound. Returns the lines to
 * print. Throws when a shape is wrong (a quadratic culler, a distance test that costs more than the
 * whole frame budget, the pyramid-free path accidentally doing occlusion).
 */
export function assertCullingBenchmark(report: CullingBenchmarkReport): string[] {
  const last = report.timings[report.timings.length - 1]!;
  const previous = report.timings[report.timings.length - 2] ?? report.timings[0]!;
  const notes: string[] = [];

  // 1. Cost per batch must not grow with the batch count: the culler is O(batches) (with a small
  //    constant for the occlusion rectangle), and a growth in the per-batch cost is a quadratic
  //    structure (or a per-batch allocation) that the device path would inherit. The two largest
  //    sizes are the comparison — both measured the same way, so a noisy machine moves both.
  const growth = (last.occlusionMs / last.batches) / (previous.occlusionMs / previous.batches);
  if (!(growth < 4)) {
    throw new Error(`per-batch culling cost grew ${growth.toFixed(1)}x from ${previous.batches} to ${last.batches} batches — the culler is not linear in the batch count`);
  }
  notes.push(
    `per-batch cost ${((previous.occlusionMs / previous.batches) * 1000).toFixed(3)}µs at ${previous.batches} → ` +
      `${((last.occlusionMs / last.batches) * 1000).toFixed(3)}µs at ${last.batches} (${growth.toFixed(2)}x, linear within the guard)`,
  );

  // 2. The distance test is a comparison per batch with a limit, so it must stay within a small factor
  //    of the frustum test. The bound is loose on purpose: this runs on CI machines with other load.
  if (!(previous.frustumMs > 0) || !(last.frustumMs > 0)) {
    throw new Error("the frustum arm timed as zero — the benchmark measured nothing");
  }
  const distanceShare = last.distanceMs / last.frustumMs;
  if (!(distanceShare < 8)) {
    throw new Error(`the distance test costs ${distanceShare.toFixed(1)}x the frustum test — the per-batch limit is not a comparison`);
  }
  notes.push(`frustum ${last.frustumMs.toFixed(2)} ms vs frustum+distance ${last.distanceMs.toFixed(2)} ms at ${last.batches} batches (${distanceShare.toFixed(2)}x)`);

  // 3. One catastrophe bound: the twin at the cap must fit inside a frame. The device path is the
  //    default; this is the mock/fallback path, and a fallback that ate a whole frame's budget would
  //    be a regression on every CI run.
  if (!(last.occlusionMs < 50)) {
    throw new Error(`the CPU twin takes ${last.occlusionMs.toFixed(1)} ms for ${last.batches} batches — a fallback cannot cost a frame's budget`);
  }
  notes.push(`cpu twin at the ${MAX_CULLED_BATCHES}-batch cap: ${last.occlusionMs.toFixed(2)} ms/frame (frustum ${last.frustumMs.toFixed(2)}, distance ${last.distanceMs.toFixed(2)}, occluded ${last.culledOccluded})`);

  // 4. And the reason the twin leaves occlusion to the device: the pyramid alone costs more than the
  //    cull it feeds. (Not a hard guard against a fast machine — reported, with the level count.)
  const pyramidVsCull = report.pyramidMs / Math.max(last.occlusionMs, 1e-6);
  if (!(report.pyramidMs < 500)) {
    throw new Error(`building the ${report.levels}-level pyramid on the CPU takes ${report.pyramidMs.toFixed(1)} ms per frame`);
  }
  notes.push(`pyramid ${WIDTH}x${HEIGHT} / ${report.levels} levels: ${report.pyramidMs.toFixed(2)} ms/frame on the CPU (${pyramidVsCull.toFixed(1)}x the cull it feeds) — the device reduces it in-frame, the twin cannot`);
  return notes;
}
