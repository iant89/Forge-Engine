/**
 * Light-count stress benchmark (Phase 13.4, docs/RENDERING.md §4c).
 *
 * The cluster build is three stages, and 13.4's split exists because they scale differently:
 *
 * - `prepare` — O(lights): a bounding sphere, the culls and the tile/slice extent per light.
 * - `count` — O(lights × slices + clusters): the per-slice difference plane, *independent of how much
 *   of the grid the lights cover*. It stays on the CPU because its output is needed exactly and
 *   immediately (the fragment stage indexes with `counts`, `stats` reports them, `lightsDropped` is a
 *   correctness signal).
 * - `fill` — O(coverage): every (cluster, light) cell the ranges cover, which is the only stage whose
 *   cost grows with how much of the frame the lights touch. This is the stage `forge.lights.assign`
 *   takes over on the device.
 *
 * The sweep below holds the coverage fixed while the light count moves, and vice versa, so the column
 * that grows with coverage — and only that column — is the one 13.4 removed from the frame's critical
 * path. Two rigs:
 *
 * - **spread**: the demo's `+36 lamps` rig shape (docs' 10 × 8 ground grid, 1.8 m range), scaled to the
 *   light count. Each lamp covers a handful of clusters, so coverage grows with the *light count*.
 * - **dense**: the same lights stacked in a 2 m blob with a 16 m range — the worst case a scene can
 *   hand the rasteriser, every light reaching every cluster. Coverage saturates at
 *   `CLUSTER_COUNT × lights` (256 lamps → 786 432 cells), which is the number §4c quotes.
 *
 * The guards are shape checks, not stopwatch thresholds, so a slower CI runner does not turn a
 * correct build red: `count` must not grow with coverage, and the fill's cost must follow the coverage
 * (the dense rig has ~100× the covered cells of the spread rig at the same light count). One generous
 * absolute bound is kept as a catastrophe check — the CPU fill is now the *fallback*, and a fallback
 * that takes seconds would be a regression, not a slow machine.
 *
 * The GPU fill itself cannot be timed here: the mock device records dispatches but executes no WGSL.
 * What the device's shader *does* is pinned by `tests/lightCulling.test.ts` (its TypeScript twin,
 * byte for byte), compiled by `check:browser`, and A/B'd on pixels by the browser gate.
 */

import { CLUSTER_COUNT, ClusterGrid, Mat4, MAX_LIGHTS_PER_CLUSTER, Vec3, type ClusterCameraParams, type ClusterLightSource } from "@forge/engine";
import type { BenchmarkResult } from "./ecs.bench.ts";

const NEAR = 0.1;
const FAR = 60;

/** The demo's PBR fixture framing: a camera 13 m out and 5 m up, looking at the rig. */
const camera = (): ClusterCameraParams => {
  const view = new Mat4().setLookAt(new Vec3(0, 5, 12.5), new Vec3(0, 1, 0), new Vec3(0, 1, 0));
  const proj = new Mat4().setPerspective(Math.PI / 3, 16 / 9, NEAR, FAR);
  return { view, proj00: proj.m[0]!, proj11: proj.m[5]!, near: NEAR, far: FAR };
};

/** A point light with the field set `ClusterLightSource` needs (`clusteredScene` builds the same). */
const pointLight = (x: number, y: number, z: number, range: number, intensity = 11): ClusterLightSource => ({
  x,
  y,
  z,
  range,
  spot: false,
  dirX: 0,
  dirY: -1,
  dirZ: 0,
  outerCone: 0.5,
  intensity,
  colorLuma: 0.7,
});

/** The demo's rig: a square grid of low, short-range lamps over the ground the camera looks at. */
export function spreadRig(lights: number): ClusterLightSource[] {
  const side = Math.max(1, Math.ceil(Math.sqrt(lights)));
  const step = 10 / Math.max(1, side - 1);
  const out: ClusterLightSource[] = [];
  for (let i = 0; i < lights; i++) {
    const x = ((i % side) - (side - 1) / 2) * step;
    const z = (Math.floor(i / side) - (side - 1) / 2) * (8 / Math.max(1, side - 1));
    out.push(pointLight(x, 0.75 + (i % 3) * 0.45, z, 1.8));
  }
  return out;
}

/**
 * The worst case: every lamp in a 2 m blob with a 16 m range, so its bounding sphere reaches every
 * tile and every slice of the grid. The cap limits what a *cluster* keeps (32 by influence), but the
 * rasteriser still has to *consider* every (light, cluster) pair.
 */
export function denseRig(lights: number): ClusterLightSource[] {
  const out: ClusterLightSource[] = [];
  for (let i = 0; i < lights; i++) {
    const a = (i / Math.max(1, lights)) * Math.PI * 2;
    out.push(pointLight(Math.cos(a) * 1.0, 0.75 + (i % 3) * 0.45, Math.sin(a) * 1.0, 16));
  }
  return out;
}

export interface LightStageTiming {
  /** Lights prepared, before `MAX_CLUSTERED_LIGHTS` caps them. */
  lights: number;
  /** Lights the range pass kept (reaching the grid). */
  live: number;
  /** Cluster list entries the fill wrote. */
  indices: number;
  prepareMs: number;
  countMs: number;
  /** `rasterize` minus `count`: the coverage-proportional stage, on the CPU. */
  fillMs: number;
}

export interface LightCullingBenchmarkReport {
  results: BenchmarkResult[];
  spread: LightStageTiming[];
  dense: LightStageTiming[];
  /** Cluster list entries the dense rig wrote at the highest light count (the 786 432-cell claim). */
  denseIndices: number;
}

/**
 * Per-frame milliseconds for one stage, as the median of `runs` samples. One frame of a small rig is
 * a handful of microseconds — inside `performance.now()`'s resolution and the JIT's warm-up — so the
 * first frame sets a batch size that makes each sample about 2 ms of work, and the batch is divided
 * back out. The numbers in the table are therefore per frame, not per measurement.
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

/** One light count, one rig: prepare, count and fill, each timed on its own grid instance. */
export function timeLightStages(lights: readonly ClusterLightSource[], runs = 5): LightStageTiming {
  const params = camera();
  const grid = new ClusterGrid();
  const countGrid = new ClusterGrid();
  const rasterGrid = new ClusterGrid();
  let live = 0;
  let indices = 0;
  const prepareMs = timedPerFrame(runs, () => {
    const ranges = grid.prepare(lights, params, lights.length);
    live = ranges.live;
  });
  const countMs = timedPerFrame(runs, () => {
    const ranges = countGrid.prepare(lights, params, lights.length);
    countGrid.count(ranges);
  });
  const rasterMs = timedPerFrame(runs, () => {
    const ranges = rasterGrid.prepare(lights, params, lights.length);
    const result = rasterGrid.rasterize(ranges);
    indices = result.indexCount;
  });
  // `rasterize` is `count` + `fill`, both on the same grid, so the difference isolates the fill. The
  // two timings are separate calls, so a sub-10 µs fill reads as noise around zero; the rigs that
  // matter (dense, hundreds of lights) are milliseconds.
  return { lights: lights.length, live, indices, prepareMs, countMs, fillMs: Math.max(0, rasterMs - countMs) };
}

/**
 * Every light count and both rigs. Counts stay at or below `MAX_CLUSTERED_LIGHTS` (256): beyond that
 * the builder truncates before the rasteriser ever sees the light, so the sweep would measure the cap.
 */
export function runLightCullingBenchmark(counts: readonly number[] = [16, 64, 256]): LightCullingBenchmarkReport {
  const results: BenchmarkResult[] = [];
  const spread: LightStageTiming[] = [];
  const dense: LightStageTiming[] = [];
  for (const lights of counts) {
    const a = timeLightStages(spreadRig(lights));
    const b = timeLightStages(denseRig(lights));
    spread.push(a);
    dense.push(b);
    results.push({
      name: `${lights} lights, spread rig: fill (CPU)`,
      count: a.indices,
      durationMs: a.fillMs,
      opsPerSec: Math.round((a.indices / Math.max(a.fillMs, 1e-6)) * 1000),
    });
    results.push({
      name: `${lights} lights, dense rig: fill (CPU)`,
      count: b.indices,
      durationMs: b.fillMs,
      opsPerSec: Math.round((b.indices / Math.max(b.fillMs, 1e-6)) * 1000),
    });
    results.push({
      name: `${lights} lights, dense rig: count (CPU, stays)`,
      count: b.live,
      durationMs: b.countMs,
      opsPerSec: Math.round((b.live / Math.max(b.countMs, 1e-6)) * 1000),
    });
  }
  return { results, spread, dense, denseIndices: dense[dense.length - 1]?.indices ?? 0 };
}

/**
 * The claims, as assertions: coverage drives the fill and nothing else, and the dense rig really is
 * the worst case it is documented to be. Failing these is failing 13.4's reason to exist.
 */
export function assertLightBenchmark(report: LightCullingBenchmarkReport): string[] {
  const notes: string[] = [];
  const last = <T>(v: T[]): T => v[v.length - 1]!;
  const dense = last(report.dense);
  const spread = last(report.spread);

  // 1. The dense rig saturates the grid: every light reaches every cluster, up to the per-cluster cap.
  if (dense.indices !== CLUSTER_COUNT * MAX_LIGHTS_PER_CLUSTER) {
    throw new Error(
      `the dense rig did not saturate the grid: ${dense.indices} entries, expected ${CLUSTER_COUNT * MAX_LIGHTS_PER_CLUSTER} (${dense.live} lights × ${CLUSTER_COUNT} clusters, capped at ${MAX_LIGHTS_PER_CLUSTER} per cluster)`,
    );
  }
  notes.push(`dense ${dense.lights} lights → ${dense.indices} entries (${CLUSTER_COUNT} clusters × cap ${MAX_LIGHTS_PER_CLUSTER})`);

  // 2. Coverage drives the fill: the dense rig's fill is orders of magnitude past the spread rig's at
  //    the same light count. A conservative factor (10×) keeps this a claim about the algorithm rather
  //    than about the machine.
  const ratio = dense.fillMs / Math.max(spread.fillMs, 1e-6);
  if (!(ratio > 10)) {
    throw new Error(`the fill did not follow coverage: dense ${dense.fillMs.toFixed(3)} ms vs spread ${spread.fillMs.toFixed(3)} ms at ${dense.lights} lights (${ratio.toFixed(1)}×)`);
  }
  notes.push(`fill follows coverage: dense ${ratio.toFixed(0)}× the spread rig at ${dense.lights} lights (${spread.indices} vs ${dense.indices} entries)`);

  // 3. The counting pass — the stage the frame keeps — must not grow with coverage. Its cost is a
  //    function of (lights, slices, clusters), so the sparse rig is *not* materially cheaper than the
  //    saturating one. A 4× window absorbs timer noise and a small dependency on the light count.
  if (!(dense.countMs < spread.countMs * 4 + 1)) {
    throw new Error(`the counting pass tracked coverage: dense ${dense.countMs.toFixed(3)} ms vs spread ${spread.countMs.toFixed(3)} ms at ${dense.lights} lights`);
  }
  notes.push(`count stays flat: ${spread.countMs.toFixed(3)} ms (spread) vs ${dense.countMs.toFixed(3)} ms (dense) at ${dense.lights} lights`);

  // 4. Catastrophe check. The CPU fill is the fallback path now; a fallback measured in seconds is a
  //    product bug, not a slow runner (local SwiftShader-era hardware measures ~14 ms here).
  if (dense.fillMs >= 1000) {
    throw new Error(`the CPU fill of the saturating rig took ${dense.fillMs.toFixed(1)} ms (${dense.indices} entries) — the fallback is no longer a fallback`);
  }
  notes.push(`CPU fill of the worst case: ${dense.fillMs.toFixed(2)} ms (${spread.fillMs.toFixed(3)} ms for the demo-shaped rig)`);
  return notes;
}
