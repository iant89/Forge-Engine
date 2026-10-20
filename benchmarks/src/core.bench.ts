/**
 * Phase 22.1 core benchmark matrix.
 *
 * These workloads cover the pieces that every larger subsystem builds on:
 *
 * - allocation-free vector and matrix kernels;
 * - the inline TaskScheduler's queue, dispatch and deduplication paths; and
 * - ResourceRegistry load, cache-hit, handle-release and LRU-eviction paths.
 *
 * The benchmark reports timings, but its automatic guards primarily assert work shape and
 * correctness. Absolute stopwatch thresholds are deliberately catastrophe bounds: ordinary CI hosts
 * vary too much for a narrow number to be meaningful. Historical constant-factor comparison belongs
 * to Phase 22.7 and consumes the JSON snapshot emitted by benchmarks/run.mjs.
 */

import {
  Mat4,
  ResourceRegistry,
  TaskScheduler,
  Vec3,
  hasTaskHandler,
  registerTaskHandler,
  type ResourceDescriptor,
  type ResourceHandle,
} from "@forge/engine";
import type { BenchmarkResult } from "./ecs.bench.ts";

const TASK_NAME = "benchmark.phase22.core";
const RESOURCE_BYTES = 64;

function result(name: string, count: number, durationMs: number): BenchmarkResult {
  return {
    name,
    count,
    durationMs,
    opsPerSec: Math.round((count / Math.max(durationMs, 1e-6)) * 1000),
  };
}

function taskValue(value: number): number {
  return Math.imul((value ^ 0x9e3779b9) >>> 0, 2654435761) >>> 0;
}

interface MathBenchmarkReport {
  vectorIterations: number;
  matrixIterations: number;
  vectorChecksum: number;
  matrixChecksum: number;
  vectorMs: number;
  matrixMs: number;
}

interface SchedulerBenchmarkReport {
  tasks: number;
  subscribers: number;
  completed: number;
  failed: number;
  dedupHits: number;
  checksum: number;
  expectedChecksum: number;
  dispatchMs: number;
  dedupMs: number;
}

interface ResourceBenchmarkReport {
  resources: number;
  loads: number;
  deduped: number;
  evictions: number;
  disposed: number;
  peakBytes: number;
  remainingEntries: number;
  remainingBytes: number;
  checksum: number;
  expectedChecksum: number;
  loadMs: number;
  cacheHitMs: number;
  releaseEvictMs: number;
}

export interface CoreBenchmarkOptions {
  vectorIterations?: number;
  matrixIterations?: number;
  schedulerTasks?: number;
  schedulerSubscribers?: number;
  resources?: number;
}

export interface CoreBenchmarkReport {
  results: BenchmarkResult[];
  math: MathBenchmarkReport;
  scheduler: SchedulerBenchmarkReport;
  resources: ResourceBenchmarkReport;
}

function runMathBenchmark(vectorIterations: number, matrixIterations: number): MathBenchmarkReport {
  const a = new Vec3();
  const b = new Vec3();
  const out = new Vec3();
  let vectorChecksum = 0;

  // Warm both branches of normalize before measuring. The timed loop reuses all three vectors and
  // therefore measures math rather than garbage collection.
  for (let i = 0; i < Math.min(4096, vectorIterations); i++) {
    a.set((i & 31) + 1, ((i >> 3) & 31) - 15, ((i * 7) & 63) - 31);
    b.set(((i * 3) & 63) - 31, ((i * 5) & 31) + 1, ((i * 11) & 63) - 31);
    Vec3.crossInto(a, b, out);
    out.normalize();
  }

  const vectorStart = performance.now();
  for (let i = 0; i < vectorIterations; i++) {
    a.set((i & 31) + 1, ((i >> 3) & 31) - 15, ((i * 7) & 63) - 31);
    b.set(((i * 3) & 63) - 31, ((i * 5) & 31) + 1, ((i * 11) & 63) - 31);
    Vec3.crossInto(a, b, out);
    out.normalize();
    vectorChecksum += out.x * 0.5 + out.y * 0.25 + out.z * 0.125;
  }
  const vectorMs = performance.now() - vectorStart;

  const left = new Mat4().setPerspective(Math.PI / 3, 16 / 9, 0.1, 1000);
  const right = new Mat4().setLookAt(new Vec3(4, 8, -12), new Vec3(0, 1, 4), Vec3.up);
  const product = new Mat4();
  let matrixChecksum = 0;
  for (let i = 0; i < Math.min(2048, matrixIterations); i++) product.multiplyMatrices(left, right);

  const matrixStart = performance.now();
  for (let i = 0; i < matrixIterations; i++) {
    // Change two source words so an optimizing runtime cannot treat the multiplication as a constant.
    right.m[12] = ((i & 1023) - 512) * 0.001;
    right.m[13] = (((i * 7) & 511) - 256) * 0.002;
    product.multiplyMatrices(left, right);
    matrixChecksum += product.m[0]! + product.m[5]! + product.m[12]! * 0.01 + product.m[13]! * 0.02;
  }
  const matrixMs = performance.now() - matrixStart;

  return {
    vectorIterations,
    matrixIterations,
    vectorChecksum,
    matrixChecksum,
    vectorMs,
    matrixMs,
  };
}

async function runSchedulerBenchmark(tasks: number, subscribers: number): Promise<SchedulerBenchmarkReport> {
  if (!hasTaskHandler(TASK_NAME)) {
    registerTaskHandler<{ value: number }, number>(TASK_NAME, ({ value }) => taskValue(value));
  }

  const scheduler = new TaskScheduler({ inline: true, maxConcurrent: 64, maxQueue: tasks + 128 });
  let checksum = 0;
  let expectedChecksum = 0;
  let dispatchMs = 0;
  let dedupMs = 0;
  try {
    const dispatchStart = performance.now();
    const pending: Promise<number>[] = [];
    for (let i = 0; i < tasks; i++) {
      pending.push(scheduler.submit({ name: TASK_NAME, key: `bench:unique:${i}`, payload: { value: i } }));
      expectedChecksum = (expectedChecksum + taskValue(i)) >>> 0;
    }
    const values = await Promise.all(pending);
    dispatchMs = performance.now() - dispatchStart;
    for (const value of values) checksum = (checksum + value) >>> 0;

    // All subscriptions are issued before the first inline handler can finish its awaited turn, so
    // this is one actual task and N-1 dedup hits rather than N cache misses measured by accident.
    const dedupStart = performance.now();
    const fanout: Promise<number>[] = [];
    for (let i = 0; i < subscribers; i++) {
      fanout.push(scheduler.submit({ name: TASK_NAME, key: "bench:shared", payload: { value: 0x1234 } }));
    }
    const shared = await Promise.all(fanout);
    dedupMs = performance.now() - dedupStart;
    const expectedShared = taskValue(0x1234);
    for (const value of shared) {
      if (value !== expectedShared) checksum = Number.NaN;
    }

    const stats = scheduler.stats;
    return {
      tasks,
      subscribers,
      completed: stats.completed,
      failed: stats.failed,
      dedupHits: stats.dedupHits,
      checksum,
      expectedChecksum,
      dispatchMs,
      dedupMs,
    };
  } finally {
    scheduler.dispose();
  }
}

async function runResourceBenchmark(resources: number): Promise<ResourceBenchmarkReport> {
  const registry = new ResourceRegistry({ idleGraceMs: 0 });
  let disposed = 0;
  const descriptors: ResourceDescriptor<{ index: number }>[] = Array.from({ length: resources }, (_, index) => ({
    id: `benchmark:core/${index}`,
    kind: "benchmark",
    load: () => ({ index }),
    bytes: () => RESOURCE_BYTES,
    dispose: () => {
      disposed++;
    },
  }));

  let checksum = 0;
  const expectedChecksum = (resources * (resources - 1)) / 2;
  const handles: ResourceHandle<{ index: number }>[] = [];
  let loadMs = 0;
  let cacheHitMs = 0;
  let releaseEvictMs = 0;
  let peakBytes = 0;
  try {
    const loadStart = performance.now();
    for (const descriptor of descriptors) handles.push(registry.acquire(descriptor));
    const values = await Promise.all(handles.map((handle) => handle.wait())) as { index: number }[];
    loadMs = performance.now() - loadStart;
    for (const value of values) checksum += value.index;
    peakBytes = registry.bytes;

    const hitStart = performance.now();
    for (const descriptor of descriptors) {
      const hit = registry.acquire(descriptor);
      checksum += (hit.currentValue as { index: number } | null)?.index ?? Number.NaN;
      hit.release();
    }
    cacheHitMs = performance.now() - hitStart;

    const releaseStart = performance.now();
    for (const handle of handles) handle.release();
    const evicted = registry.evictIdle();
    releaseEvictMs = performance.now() - releaseStart;
    const stats = registry.stats();
    return {
      resources,
      loads: stats.loads,
      deduped: stats.deduped,
      evictions: evicted,
      disposed,
      peakBytes,
      remainingEntries: stats.entries,
      remainingBytes: stats.bytes,
      checksum,
      expectedChecksum: expectedChecksum * 2,
      loadMs,
      cacheHitMs,
      releaseEvictMs,
    };
  } finally {
    registry.dispose();
  }
}

export async function runCoreBenchmark(options: CoreBenchmarkOptions = {}): Promise<CoreBenchmarkReport> {
  const math = runMathBenchmark(options.vectorIterations ?? 1_000_000, options.matrixIterations ?? 250_000);
  const scheduler = await runSchedulerBenchmark(options.schedulerTasks ?? 8192, options.schedulerSubscribers ?? 4096);
  const resources = await runResourceBenchmark(options.resources ?? 10_000);
  const results = [
    result("math Vec3 cross + normalize", math.vectorIterations, math.vectorMs),
    result("math Mat4 multiply", math.matrixIterations, math.matrixMs),
    result("scheduler inline dispatch", scheduler.tasks, scheduler.dispatchMs),
    result("scheduler deduplicated subscribers", scheduler.subscribers, scheduler.dedupMs),
    result("resources unique load + acquire", resources.resources, resources.loadMs),
    result("resources cached acquire + release", resources.resources, resources.cacheHitMs),
    result("resources handle release + LRU eviction", resources.resources, resources.releaseEvictMs),
  ];
  return { results, math, scheduler, resources };
}

/** Correctness, work-shape and generous catastrophe guards for the Phase 22.1 core matrix. */
export function assertCoreBenchmark(report: CoreBenchmarkReport): string[] {
  const { math, scheduler, resources } = report;
  for (const entry of report.results) {
    if (!(entry.count > 0) || !Number.isFinite(entry.durationMs) || !(entry.durationMs > 0) || !Number.isFinite(entry.opsPerSec)) {
      throw new Error(`core benchmark did not measure "${entry.name}" (${entry.count} operations in ${entry.durationMs} ms)`);
    }
  }
  if (!Number.isFinite(math.vectorChecksum) || !Number.isFinite(math.matrixChecksum) || Math.abs(math.vectorChecksum) < 1 || Math.abs(math.matrixChecksum) < 1) {
    throw new Error("the math kernels produced an invalid checksum — the benchmark did not execute useful work");
  }
  if (math.vectorMs >= 10_000 || math.matrixMs >= 10_000) {
    throw new Error(`a core math kernel exceeded the 10 s catastrophe bound (${math.vectorMs.toFixed(1)} / ${math.matrixMs.toFixed(1)} ms)`);
  }
  if (scheduler.failed !== 0 || scheduler.completed !== scheduler.tasks + 1) {
    throw new Error(`scheduler completed ${scheduler.completed}/${scheduler.tasks + 1} tasks with ${scheduler.failed} failure(s)`);
  }
  if (scheduler.dedupHits !== scheduler.subscribers - 1) {
    throw new Error(`scheduler fan-out recorded ${scheduler.dedupHits} dedup hits, expected ${scheduler.subscribers - 1}`);
  }
  if (scheduler.checksum !== scheduler.expectedChecksum) {
    throw new Error(`scheduler result checksum ${scheduler.checksum} != ${scheduler.expectedChecksum}`);
  }
  if (scheduler.dispatchMs >= 10_000 || scheduler.dedupMs >= 10_000) {
    throw new Error(`the scheduler exceeded the 10 s catastrophe bound (${scheduler.dispatchMs.toFixed(1)} / ${scheduler.dedupMs.toFixed(1)} ms)`);
  }
  if (
    resources.loads !== resources.resources ||
    resources.deduped !== resources.resources ||
    resources.evictions !== resources.resources ||
    resources.disposed !== resources.resources
  ) {
    throw new Error(
      `resource lifecycle mismatch: ${resources.loads} loads, ${resources.deduped} hits, ` +
        `${resources.evictions} evictions, ${resources.disposed} disposals for ${resources.resources} resources`,
    );
  }
  if (resources.peakBytes !== resources.resources * RESOURCE_BYTES || resources.remainingEntries !== 0 || resources.remainingBytes !== 0) {
    throw new Error(
      `resource accounting mismatch: peak ${resources.peakBytes} B, remaining ${resources.remainingEntries} entries / ${resources.remainingBytes} B`,
    );
  }
  if (resources.checksum !== resources.expectedChecksum) {
    throw new Error(`resource result checksum ${resources.checksum} != ${resources.expectedChecksum}`);
  }
  if (resources.loadMs >= 10_000 || resources.cacheHitMs >= 10_000 || resources.releaseEvictMs >= 10_000) {
    throw new Error(
      `resource management exceeded the 10 s catastrophe bound (${resources.loadMs.toFixed(1)} / ` +
        `${resources.cacheHitMs.toFixed(1)} / ${resources.releaseEvictMs.toFixed(1)} ms)`,
    );
  }

  return [
    `math: ${math.vectorIterations.toLocaleString()} vector kernels in ${math.vectorMs.toFixed(2)} ms; ` +
      `${math.matrixIterations.toLocaleString()} matrix multiplies in ${math.matrixMs.toFixed(2)} ms`,
    `scheduler: ${scheduler.tasks.toLocaleString()} unique tasks in ${scheduler.dispatchMs.toFixed(2)} ms; ` +
      `${scheduler.subscribers.toLocaleString()} subscribers shared one task (${scheduler.dedupHits.toLocaleString()} hits)`,
    `resources: ${resources.resources.toLocaleString()} loads / hits / evictions, ` +
      `${(resources.peakBytes / 1024).toFixed(0)} KiB peak, zero entries left`,
  ];
}
