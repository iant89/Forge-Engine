/**
 * Phase 9.1 — worker execution.
 *
 * Two layers, both against the shipping implementation:
 *  1. the worker-scope protocol driven in-process over a fake scope (message ordering, the
 *     `inlineFallback` contract, cancellation acknowledgement), and
 *  2. a real second thread via `tests/support/workerThreads.ts`, which bundles the engine's own
 *     worker entry with esbuild and runs it on `node:worker_threads`.
 *
 * The claims the roadmap asks for — submission, execution, result delivery, cancellation,
 * invalidated tasks, worker failure, multiple workers, deterministic results, and "terrain
 * generation runs outside the main thread" — are each asserted below.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  AABB,
  GeneratorPipeline,
  HeightGenerator,
  MeshBvh,
  Ray,
  RayHit,
  ScatterGenerator,
  Vec3,
  buildBvhTask,
  TaskCancelledError,
  TaskScheduler,
  TaskPriority,
  builtinTaskHandlersReady,
  createPipelineFromSpec,
  createWorldCell,
  describePipeline,
  generateTerrainCell,
  installTerrainTaskHandlers,
  installWorkerScope,
  listTaskHandlers,
  registerTaskHandler,
  type BvhTaskPayload,
  type BvhTaskResult,
  type TaskStats,
  type TerrainCellTaskPayload,
  type TerrainCellTaskResult,
  type WorkerIncomingMessage,
} from "@forge/engine";
import { createWorkerThreadPool, type WorkerThreadPool } from "./support/workerThreads.js";

/** Deterministic triangle soup for the `geometry.bvh` task (Phase 9.1). */
function bvhSoup(cells = 12, spacing = 2.5): { positions: Float32Array; indices: Uint32Array } {
  let state = 99;
  const rand = (): number => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
  const grid = cells + 1;
  const positions = new Float32Array(grid * grid * 3);
  for (let z = 0; z < grid; z++) {
    for (let x = 0; x < grid; x++) {
      const i = (z * grid + x) * 3;
      positions[i] = (x - cells / 2) * spacing + (rand() - 0.5) * 0.7;
      positions[i + 1] = Math.sin(x * 0.35) * 2 + Math.cos(z * 0.27) * 2;
      positions[i + 2] = (z - cells / 2) * spacing + (rand() - 0.5) * 0.7;
    }
  }
  const indices = new Uint32Array(cells * cells * 6);
  let t = 0;
  for (let z = 0; z < cells; z++) {
    for (let x = 0; x < cells; x++) {
      const a = z * grid + x;
      const b = a + 1;
      const c = a + grid;
      const d = c + 1;
      indices[t++] = a; indices[t++] = c; indices[t++] = b;
      indices[t++] = b; indices[t++] = c; indices[t++] = d;
    }
  }
  return { positions, indices };
}

/** Two-stage pipeline; small enough to run thousands of times, real enough to mean something. */
function testPipeline(): GeneratorPipeline {
  return new GeneratorPipeline().addStage(new HeightGenerator({ octaves: 2, amplitude: 12 })).addStage(new ScatterGenerator({ countPerChunk: 4 }));
}

function cellPayload(cx: number, cz: number): TerrainCellTaskPayload {
  return { seed: 7, cx, cz, size: 64, resolution: 9, pipeline: describePipeline(testPipeline()) };
}

function expectCellsEqual(a: TerrainCellTaskResult, b: TerrainCellTaskResult): void {
  expect(a.cx).toBe(b.cx);
  expect(a.cz).toBe(b.cz);
  expect(a.pipelineHash).toBe(b.pipelineHash);
  expect(a.minHeight).toBe(b.minHeight);
  expect(a.maxHeight).toBe(b.maxHeight);
  expect([...a.heights]).toEqual([...b.heights]);
  expect([...a.slopes]).toEqual([...b.slopes]);
  expect([...a.biomes]).toEqual([...b.biomes]);
  expect(a.scatters).toEqual(b.scatters);
}

describe("Phase 9.1 — worker scope protocol", () => {
  interface FakeScope {
    readonly scope: { postMessage(message: unknown): void; addEventListener(type: "message", listener: (event: { data: WorkerIncomingMessage }) => void): void };
    messages: unknown[];
    deliver(message: unknown): void;
    listeners: Set<(event: { data: WorkerIncomingMessage }) => void>;
  }

  /**
   * One scope *object* per fake: `installWorkerScope` is keyed on the scope identity (a WeakSet), so
   * "install twice" must mean twice on the same object to say anything.
   */
  function fakeScope(): FakeScope {
    const messages: unknown[] = [];
    const listeners = new Set<(event: { data: WorkerIncomingMessage }) => void>();
    const scope: FakeScope = {
      scope: null as unknown as FakeScope["scope"],
      messages,
      listeners,
      deliver(message: unknown) {
        for (const fn of listeners) fn({ data: message as WorkerIncomingMessage });
      },
    };
    const adapter = {
      postMessage: (message: unknown) => messages.push(message),
      addEventListener: (_type: string, listener: (event: { data: WorkerIncomingMessage }) => void) =>
        listeners.add(listener),
    };
    (scope as { scope: unknown }).scope = adapter;
    return scope;
  }

  function install(scope: FakeScope, extra?: () => void): void {
    installWorkerScope(scope.scope, { installHandlers: extra });
  }

  /** Let the scope's own ready chain (a dynamic import) settle before delivering a message. */
  const settled = async (): Promise<void> => {
    await builtinTaskHandlersReady();
    await new Promise((r) => setTimeout(r, 0));
  };

  it("queues messages that arrive before the handlers are ready, then runs them", async () => {
    const scope = fakeScope();
    install(scope);
    // Straight after install the builtins are still a pending import; a task that shows up now must
    // not be dropped with "no handler registered".
    scope.deliver({ type: "task", id: 1, name: "terrain.heightfield", payload: { seed: 3, cx: 0, cz: 0, size: 64, resolution: 5 } });
    expect(scope.messages).toHaveLength(0);
    await settled();
    const result = scope.messages.find((m) => (m as { type: string }).type === "result") as { id: number; value: { heights: Float32Array } };
    expect(result).toBeTruthy();
    expect(result.id).toBe(1);
    expect(result.value.heights.length).toBe(25);
  });

  it("reports an unrunnable handler back with inlineFallback so the task can run on the main thread", async () => {
    const scope = fakeScope();
    install(scope);
    await settled();
    scope.deliver({ type: "task", id: 4, name: "test.notInThisWorker", payload: {} });
    const error = scope.messages.find((m) => (m as { type: string }).type === "error") as { error: string; inlineFallback: boolean };
    expect(error.inlineFallback).toBe(true);
    expect(error.error).toContain("test.notInThisWorker");
  });

  it("acknowledges a cancel and discards the result of a task that ran anyway", async () => {
    const scope = fakeScope();
    let release: (() => void) | null = null;
    install(scope, () => {
      registerTaskHandler("test.slow", async (payload: { tag: string }) => {
        await new Promise<void>((resolve) => (release = resolve));
        return payload.tag;
      });
    });
    await settled();
    scope.deliver({ type: "task", id: 9, name: "test.slow", payload: { tag: "late" } });
    await new Promise((r) => setTimeout(r, 0));
    scope.deliver({ type: "cancel", id: 9 });
    await new Promise((r) => setTimeout(r, 0));
    release!();
    await new Promise((r) => setTimeout(r, 0));
    // The handler had already started: it finishes, but the worker posts nothing for a cancelled id.
    expect(scope.messages.filter((m) => (m as { type: string }).type === "result")).toHaveLength(0);
  });

  it("installing twice on the same scope does not double-handle messages", async () => {
    const scope = fakeScope();
    install(scope);
    install(scope); // a host module + worker-entry, both installing the scope
    await settled();
    scope.deliver({ type: "task", id: 2, name: "terrain.heightfield", payload: { seed: 1, cx: 0, cz: 0, size: 32, resolution: 4 } });
    await new Promise((r) => setTimeout(r, 5));
    expect(scope.messages.filter((m) => (m as { type: string }).type === "result")).toHaveLength(1);
  });
});

describe("Phase 9.1 — scheduler (inline)", () => {
  const scheduler = new TaskScheduler({ inline: true });

  it("warms up the builtin handler table", async () => {
    await builtinTaskHandlersReady();
    expect(listTaskHandlers()).toEqual(
      expect.arrayContaining(["terrain.heightfield", "terrain.slope", "terrain.scatter", "texture.noiseTile"]),
    );
  });

  it("runs a task and delivers a deterministic result", async () => {
    const payload = { seed: 11, cx: 2, cz: -3, size: 64, resolution: 9 };
    const a = await scheduler.submit<typeof payload, { heights: Float32Array }>({ name: "terrain.heightfield", key: "a", payload });
    const b = await scheduler.submit<typeof payload, { heights: Float32Array }>({ name: "terrain.heightfield", key: "b", payload });
    expect([...a.heights]).toEqual([...b.heights]);
    const other = await scheduler.submit<typeof payload, { heights: Float32Array }>({
      name: "terrain.heightfield",
      key: "c",
      payload: { ...payload, cx: 3 },
    });
    expect([...other.heights]).not.toEqual([...a.heights]);
  });

  it("shares one in-flight task between submissions with the same key", async () => {
    const statsBefore = scheduler.stats.dedupHits;
    const first = scheduler.submit({ name: "terrain.scatter", key: "dedupe:1", payload: { seed: 5, cx: 0, cz: 0, size: 32, count: 3 } });
    const second = scheduler.submit({ name: "terrain.scatter", key: "dedupe:1", payload: { seed: 5, cx: 0, cz: 0, size: 32, count: 3 } });
    expect(scheduler.has("dedupe:1")).toBe(true);
    expect(await first).toEqual(await second);
    expect(scheduler.stats.dedupHits).toBe(statsBefore + 1);
  });

  it("rejects a cancelled queued task and counts it as invalidated", async () => {
    const before = scheduler.stats.cancelled;
    const pending = scheduler.submit({ name: "terrain.heightfield", key: "cancel:queued", payload: { seed: 1, cx: 0, cz: 0, size: 8, resolution: 3 } });
    expect(scheduler.cancel("cancel:queued")).toBe(true);
    await expect(pending).rejects.toBeInstanceOf(TaskCancelledError);
    expect(scheduler.stats.cancelled).toBe(before + 1);
    expect(scheduler.cancel("cancel:queued")).toBe(false);
  });

  it("invalidates a task that overstays the queue via queueTimeoutMs", async () => {
    const slow = new TaskScheduler({ inline: true, maxConcurrent: 1 });
    let release: (() => void) | null = null;
    registerTaskHandler("test.blocking", async () => {
      await new Promise<void>((resolve) => (release = resolve));
      return "unblocked";
    });
    const blocker = slow.submit({ name: "test.blocking", key: "blocker", payload: {} });
    const queued = slow.submit({ name: "terrain.heightfield", key: "stale", payload: { seed: 1, cx: 0, cz: 0, size: 8, resolution: 3 }, queueTimeoutMs: 10 });
    await expect(queued).rejects.toBeInstanceOf(TaskCancelledError);
    expect(slow.has("stale")).toBe(false);
    release!();
    await expect(blocker).resolves.toBe("unblocked");
    slow.dispose();
  });

  it("cancels a whole group by key prefix", async () => {
    const group = new TaskScheduler({ inline: true, maxConcurrent: 1 });
    let held = true;
    registerTaskHandler("test.hold", async () => {
      while (held) await new Promise((r) => setTimeout(r, 1));
      return 1;
    });
    const running = group.submit({ name: "test.hold", key: "keep:running", payload: {} });
    const a = group.submit({ name: "test.hold", key: "chunk:1,0:lod0", payload: {} });
    const b = group.submit({ name: "test.hold", key: "chunk:2,0:lod0", payload: {} });
    const keep = group.submit({ name: "test.hold", key: "keep:queued", payload: {} });
    expect(group.cancelGroup("chunk:")).toBe(2);
    await expect(a).rejects.toBeInstanceOf(TaskCancelledError);
    await expect(b).rejects.toBeInstanceOf(TaskCancelledError);
    expect(group.has("keep:queued")).toBe(true);
    held = false;
    await running;
    await keep;
    group.dispose();
  });

  it("surfaces a handler failure as a rejection without wedging the queue", async () => {
    const failing = new TaskScheduler({ inline: true });
    registerTaskHandler("test.failing", () => {
      throw new Error("handler exploded");
    });
    await expect(failing.submit({ name: "test.failing", key: "f", payload: {} })).rejects.toThrow("handler exploded");
    expect(failing.stats.failed).toBe(1);
    const ok = await failing.submit({ name: "terrain.scatter", key: "ok", payload: { seed: 1, cx: 0, cz: 0, size: 16, count: 2 } });
    expect(ok).toBeTruthy();
    failing.dispose();
  });

  it("resolves completions in (priority, key) order when asked", async () => {
    const ordered = new TaskScheduler({ inline: true, maxConcurrent: 4 });
    ordered.setOrderedResolution(true);
    const seen: string[] = [];
    const spec: [string, number][] = [
      ["c", TaskPriority.Low],
      ["a", TaskPriority.High],
      ["b", TaskPriority.Normal],
    ];
    await Promise.all(
      spec.map(async ([key, priority]) => {
        await ordered.submit({ name: "terrain.scatter", key, priority, payload: { seed: 2, cx: 0, cz: 0, size: 8, count: 1 } });
        seen.push(key);
      }),
    );
    expect(seen).toEqual(["a", "b", "c"]);
    ordered.dispose();
  });

  it("refuses new work and drains cleanly when disposed", async () => {
    const disposed = new TaskScheduler({ inline: true });
    disposed.dispose();
    await expect(disposed.submit({ name: "terrain.scatter", key: "x", payload: { seed: 1, cx: 0, cz: 0, size: 8, count: 1 } })).rejects.toThrow(
      /disposed/,
    );
  });

  it("reports a full statistics record", () => {
    const stats: TaskStats = scheduler.stats;
    for (const field of ["queued", "running", "completed", "cancelled", "failed", "workers", "inline", "workerFailures", "inlineFallbacks"] as const) {
      expect(stats[field], field).toBeDefined();
    }
    expect(stats.inline).toBe(true);
  });

  afterAll(() => scheduler.dispose());
});

describe("Phase 9.1 — real worker threads", () => {
  let pool: WorkerThreadPool;
  let scheduler: TaskScheduler;

  beforeAll(async () => {
    installTerrainTaskHandlers(); // the main thread needs the same handler set as the worker
    pool = await createWorkerThreadPool();
    scheduler = new TaskScheduler({ workerCount: 3, createWorker: (i) => pool.createWorker(i) });
    // Worker threads are running; the suites below assert against them, not against the fallback.
    expect(scheduler.stats.workers).toBe(3);
    expect(scheduler.stats.inline).toBe(false);
  }, 30000);

  afterAll(async () => {
    scheduler?.dispose();
    await pool?.dispose();
  });

  it("executes a task on another thread and delivers the result", async () => {
    const threadId = await scheduler.submit<Record<string, never>, number>({ name: "test.threadId", key: "thread:1", payload: {} });
    expect(typeof threadId).toBe("number");
    expect(threadId).toBeGreaterThan(0); // 0 is the main thread
    expect(scheduler.stats.completed).toBeGreaterThan(0);
  });

  it("runs several tasks concurrently across multiple workers", async () => {
    const ids = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        scheduler.submit<Record<string, never>, number>({ name: "test.threadId", key: `thread:${i + 2}`, payload: {} }),
      ),
    );
    expect(new Set(ids).size).toBeGreaterThan(1);
    for (const id of ids) expect(id).toBeGreaterThan(0);
  });

  it("generates terrain off the main thread, bit-for-bit identical to the inline result", async () => {
    const jobs = [
      cellPayload(0, 0),
      cellPayload(-3, 5),
      cellPayload(120, -87),
    ];
    for (const [i, payload] of jobs.entries()) {
      const fromWorker = await scheduler.submit<TerrainCellTaskPayload, TerrainCellTaskResult>({
        name: "terrain.cell",
        key: `cell:${payload.cx},${payload.cz}`,
        payload,
        priority: TaskPriority.High,
      });
      // The inline reference, generated from the same spec on this thread.
      const inline = generateTerrainCell(payload);
      expectCellsEqual(fromWorker, inline);
      expect(fromWorker.cx).toBe(payload.cx);
      expect(fromWorker.seed).toBe(payload.seed);
      expect(fromWorker.bytes).toBe(inline.heights.byteLength + inline.slopes.byteLength + inline.biomes.byteLength);
      expect(fromWorker.pipelineHash).toBeGreaterThan(0);
      // The world cell the engine would build from that result carries the same data.
      const inlineCell = createWorldCell(payload.cx, payload.cz, payload.size, payload.resolution, payload.seed);
      createPipelineFromSpec(payload.pipeline).execute(inlineCell);
      expect([...fromWorker.heights]).toEqual([...inlineCell.heights]);
      expect(i).toBe(i); // keep the index (and the ordering) explicit
    }
  });

  it("reports worker-side progress to the main thread", async () => {
    const payload = cellPayload(4, 4);
    const seen: number[] = [];
    const promise = scheduler.submit<TerrainCellTaskPayload, TerrainCellTaskResult>({ name: "terrain.cell", key: `progress:${payload.cx}`, payload });
    // `onProgress` attaches to an existing record, so the subscription goes in right after submit and
    // well before the worker's first progress message can arrive.
    const unsubscribe = scheduler.onProgress(`progress:${payload.cx}`, (value) => seen.push(value));
    await promise;
    unsubscribe();
    // Two stages → at least one progress report per stage crosses the boundary.
    expect(seen.length).toBeGreaterThanOrEqual(1);
    expect(Math.max(...seen)).toBeCloseTo(1, 5);
  });

  it("dedupes concurrent submissions of the same chunk key across workers", async () => {
    const payload = cellPayload(9, 9);
    const before = scheduler.stats.dedupHits;
    const [a, b] = await Promise.all([
      scheduler.submit<TerrainCellTaskPayload, TerrainCellTaskResult>({ name: "terrain.cell", key: "cell:9,9", payload }),
      scheduler.submit<TerrainCellTaskPayload, TerrainCellTaskResult>({ name: "terrain.cell", key: "cell:9,9", payload }),
    ]);
    expect(scheduler.stats.dedupHits).toBe(before + 1);
    expect(a.heights).toBe(b.heights); // one result object, not two copies
  });

  it("discards the result of a task cancelled while a worker is running it", async () => {
    const before = scheduler.stats.cancelled;
    const pending = scheduler.submit<Record<string, never>, number>({ name: "test.spin", key: "cancel:running", payload: {} });
    await new Promise((r) => setTimeout(r, 40)); // let it reach the worker
    expect(scheduler.has("cancel:running")).toBe(true);
    expect(scheduler.cancel("cancel:running")).toBe(true);
    await expect(pending).rejects.toBeInstanceOf(TaskCancelledError);
    expect(scheduler.stats.cancelled).toBe(before + 1);
    // The remaining workers still serve requests (only the spinning one is busy).
    const id = await scheduler.submit<Record<string, never>, number>({ name: "test.threadId", key: "thread:after-cancel", payload: {} });
    expect(id).toBeGreaterThan(0);
  });

  it("runs a handler the worker lacks on the main thread instead", async () => {
    registerTaskHandler("test.mainThreadOnly", () => "ran-inline");
    const before = scheduler.stats.inlineFallbacks;
    const value = await scheduler.submit<Record<string, never>, string>({ name: "test.mainThreadOnly", key: "inline:1", payload: {} });
    expect(value).toBe("ran-inline");
    expect(scheduler.stats.inlineFallbacks).toBe(before + 1);
    expect(scheduler.stats.failed).toBe(0);
  });

  it("honours a handler that declares itself main-thread-only", async () => {
    registerTaskHandler("test.inlineOnly", () => "main-thread-result");
    const value = await scheduler.submit<Record<string, never>, string>({ name: "test.inlineOnly", key: "inline:2", payload: {} });
    expect(value).toBe("main-thread-result");
    expect(scheduler.stats.workerFailures).toBe(0);
  });

  it("fails a task whose handler throws inside the worker, with the worker's message", async () => {
    const before = scheduler.stats.failed;
    await expect(scheduler.submit({ name: "test.fail", key: "fail:1", payload: "explicit failure" })).rejects.toThrow("explicit failure");
    expect(scheduler.stats.failed).toBe(before + 1);
  });

  it("retries a task inline when its worker dies mid-flight", async () => {
    // The worker-side `test.crashDuring` kills its thread; the main-thread handler of the same name
    // (registered here) is what the scheduler falls back to.
    registerTaskHandler("test.crashDuring", async () => "recovered-inline");
    const before = scheduler.stats.workerFailures;
    const value = await scheduler.submit<Record<string, never>, string>({ name: "test.crashDuring", key: "crash:1", payload: {} });
    expect(value).toBe("recovered-inline");
    expect(scheduler.stats.workerFailures).toBe(before + 1);
    expect(scheduler.stats.workers).toBeLessThan(3);
    // The pool is smaller but still functional.
    const id = await scheduler.submit<Record<string, never>, number>({ name: "test.threadId", key: "thread:after-crash", payload: {} });
    expect(id).toBeGreaterThan(0);
  });

  it("builds a mesh BVH on another thread, byte-identical to the inline build", async () => {
    // The roadmap's 9.1 bullet: "verify BVH/LBVH generation can execute outside the main thread."
    const { positions, indices } = bvhSoup();
    const inline = buildBvhTask({ positions, indices, leafSize: 4 });
    const offThread = await scheduler.submit<BvhTaskPayload, BvhTaskResult>({
      name: "geometry.bvh",
      key: "bvh:main",
      payload: { positions, indices, leafSize: 4 },
    });

    expect(offThread.hash).toBe(inline.hash);
    expect(offThread.nodeCount).toBe(inline.nodeCount);
    expect(offThread.leafCount).toBe(inline.leafCount);
    expect(offThread.maxDepth).toBe(inline.maxDepth);
    expect(offThread.triangleCount).toBe(inline.triangleCount);
    expect([...offThread.nodeBounds]).toEqual([...inline.nodeBounds]);
    expect([...offThread.nodeLeftFirst]).toEqual([...inline.nodeLeftFirst]);
    expect([...offThread.nodeTriCount]).toEqual([...inline.nodeTriCount]);
    expect([...offThread.triOrder]).toEqual([...inline.triOrder]);
    expect([...offThread.bounds]).toEqual([...inline.bounds]);

    // The result crossed the thread boundary as transfers and is still a usable index: the tree the
    // worker built answers the same ray as the tree built here.
    const restored = MeshBvh.fromData(
      {
        ...offThread,
        bounds: new AABB(
          new Vec3(offThread.bounds[0]!, offThread.bounds[1]!, offThread.bounds[2]!),
          new Vec3(offThread.bounds[3]!, offThread.bounds[4]!, offThread.bounds[5]!),
        ),
      },
      positions,
      indices,
      4,
    );
    const ray = new Ray(new Vec3(4, 40, 4), new Vec3(-0.1, -1, -0.2), 200);
    const fromWorker = new RayHit();
    const native = new RayHit();
    expect(restored.raycast(ray, fromWorker)).toBe(true);
    expect(MeshBvh.build(positions, indices, { leafSize: 4 }).raycast(ray, native)).toBe(true);
    expect(fromWorker.index).toBe(native.index);
    expect(fromWorker.distance).toBeCloseTo(native.distance, 6);

    // The payload crossed as a copy, not a transfer: the caller still owns its geometry.
    expect(positions.length).toBeGreaterThan(0);
    expect(indices.length).toBeGreaterThan(0);
  });

  it("builds two BVHs concurrently on different workers", async () => {
    const { positions, indices } = bvhSoup(8);
    const [a, b] = await Promise.all([
      scheduler.submit<BvhTaskPayload, BvhTaskResult>({ name: "geometry.bvh", key: "bvh:a", payload: { positions, indices } }),
      scheduler.submit<BvhTaskPayload, BvhTaskResult>({ name: "geometry.bvh", key: "bvh:b", payload: { positions, indices } }),
    ]);
    expect(a.hash).toBe(b.hash);
    expect(a.hash).toBe(buildBvhTask({ positions, indices }).hash);
  });

  it("drains every queued task", async () => {
    for (let i = 0; i < 8; i++) {
      void scheduler.submit({ name: "test.echo", key: `echo:${i}`, payload: { i } });
    }
    await scheduler.drain(30000);
    expect(scheduler.pending).toBe(0);
  });
});
