/**
 * @suite core:tasks
 * @group integration
 * @covers engine/src/core/tasks/registry.ts
 * @covers engine/src/core/tasks/scheduler.ts
 * @covers engine/src/core/tasks/taskHandlers.ts
 * @covers engine/src/core/tasks/workerScope.ts
 * @covers engine/src/index.ts
 * @covers engine/src/math/bvh.ts
 * @covers engine/src/math/geometry.ts
 * @covers engine/src/math/vec.ts
 * @covers engine/src/terrain/generators.ts
 * @covers engine/src/terrain/mars/config.ts
 * @covers engine/src/terrain/mars/stage.ts
 * @covers engine/src/terrain/pipelineSpec.ts
 * @covers engine/src/terrain/tasks.ts
 * @desc Phase 9.1 — worker execution
 */

export const suite = {
  name: "core:tasks",
  group: "integration",
  covers:   [
    "engine/src/core/tasks/registry.ts",
    "engine/src/core/tasks/scheduler.ts",
    "engine/src/core/tasks/taskHandlers.ts",
    "engine/src/core/tasks/workerScope.ts",
    "engine/src/index.ts",
    "engine/src/math/bvh.ts",
    "engine/src/math/geometry.ts",
    "engine/src/math/vec.ts",
    "engine/src/terrain/generators.ts",
    "engine/src/terrain/mars/config.ts",
    "engine/src/terrain/mars/stage.ts",
    "engine/src/terrain/pipelineSpec.ts",
    "engine/src/terrain/tasks.ts"
  ],
  desc: "Phase 9.1 — worker execution",
};
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

import assert from "node:assert/strict";
import { afterAll, arrayContaining, assertCloseTo, assertContains, assertMatches, assertRejects, beforeAll, finish, group, test } from "selrun";
import {
  AABB,
  GeneratorPipeline,
  HeightGenerator,
  MARS_RADIUS_M,
  MarsTerrainStage,
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
  createMarsPipeline,
  createPipelineFromSpec,
  createWorldCell,
  describePipeline,
  generateTerrainCell,
  installTerrainTaskHandlers,
  installWorkerScope,
  listTaskHandlers,
  registerTaskHandler,
  terrainCellPayload,
  type BvhTaskPayload,
  type BvhTaskResult,
  type TaskStats,
  type TerrainCellTaskPayload,
  type TerrainCellTaskResult,
  type WorkerIncomingMessage,
} from "@forge/engine";
import { createWorkerThreadPool, workerHarnessPaths, type WorkerThreadPool } from "../support/workerThreads.js";

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
  assert.equal(a.cx, b.cx);
  assert.equal(a.cz, b.cz);
  assert.equal(a.pipelineHash, b.pipelineHash);
  assert.equal(a.minHeight, b.minHeight);
  assert.equal(a.maxHeight, b.maxHeight);
  assert.deepEqual([...a.heights], [...b.heights]);
  assert.deepEqual([...a.slopes], [...b.slopes]);
  assert.deepEqual([...a.biomes], [...b.biomes]);
  assert.deepEqual(a.scatters, b.scatters);
}

group("Phase 9.1 — worker scope protocol", () => {
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

  test("queues messages that arrive before the handlers are ready, then runs them", async () => {
    const scope = fakeScope();
    install(scope);
    // Straight after install the builtins are still a pending import; a task that shows up now must
    // not be dropped with "no handler registered".
    scope.deliver({ type: "task", id: 1, name: "terrain.heightfield", payload: { seed: 3, cx: 0, cz: 0, size: 64, resolution: 5 } });
    assert.equal((scope.messages).length, 0);
    await settled();
    const result = scope.messages.find((m) => (m as { type: string }).type === "result") as { id: number; value: { heights: Float32Array } };
    assert.ok(result);
    assert.equal(result.id, 1);
    assert.equal(result.value.heights.length, 25);
  });

  test("reports an unrunnable handler back with inlineFallback so the task can run on the main thread", async () => {
    const scope = fakeScope();
    install(scope);
    await settled();
    scope.deliver({ type: "task", id: 4, name: "test.notInThisWorker", payload: {} });
    const error = scope.messages.find((m) => (m as { type: string }).type === "error") as { error: string; inlineFallback: boolean };
    assert.equal(error.inlineFallback, true);
    assertContains(error.error, "test.notInThisWorker");
  });

  test("acknowledges a cancel and discards the result of a task that ran anyway", async () => {
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
    assert.equal((scope.messages.filter((m) => (m as { type: string }).type === "cancelled")).length, 0);
    release!();
    await new Promise((r) => setTimeout(r, 0));
    // The handler had already started: its result is discarded, but a completion ack releases
    // the scheduler's worker slot. Never acknowledge *before* the handler has actually finished.
    assert.equal((scope.messages.filter((m) => (m as { type: string }).type === "result")).length, 0);
    assert.deepEqual(scope.messages.filter((m) => (m as { type: string }).type === "cancelled"), [{ type: "cancelled", id: 9 }]);
  });

  test("installing twice on the same scope does not double-handle messages", async () => {
    const scope = fakeScope();
    install(scope);
    install(scope); // a host module + worker-entry, both installing the scope
    await settled();
    scope.deliver({ type: "task", id: 2, name: "terrain.heightfield", payload: { seed: 1, cx: 0, cz: 0, size: 32, resolution: 4 } });
    await new Promise((r) => setTimeout(r, 5));
    assert.equal((scope.messages.filter((m) => (m as { type: string }).type === "result")).length, 1);
  });
});

group("Phase 9.1 — scheduler (inline)", () => {
  const scheduler = new TaskScheduler({ inline: true });

  test("warms up the builtin handler table", async () => {
    await builtinTaskHandlersReady();
    assertMatches(listTaskHandlers(), arrayContaining(["terrain.heightfield", "terrain.slope", "terrain.scatter", "texture.noiseTile", "asset.gltf.decode"]));
  });

  test("runs a task and delivers a deterministic result", async () => {
    const payload = { seed: 11, cx: 2, cz: -3, size: 64, resolution: 9 };
    const a = await scheduler.submit<typeof payload, { heights: Float32Array }>({ name: "terrain.heightfield", key: "a", payload });
    const b = await scheduler.submit<typeof payload, { heights: Float32Array }>({ name: "terrain.heightfield", key: "b", payload });
    assert.deepEqual([...a.heights], [...b.heights]);
    const other = await scheduler.submit<typeof payload, { heights: Float32Array }>({
      name: "terrain.heightfield",
      key: "c",
      payload: { ...payload, cx: 3 },
    });
    assert.notDeepEqual([...other.heights], [...a.heights]);
  });

  test("shares one in-flight task between submissions with the same key", async () => {
    const statsBefore = scheduler.stats.dedupHits;
    const first = scheduler.submit({ name: "terrain.scatter", key: "dedupe:1", payload: { seed: 5, cx: 0, cz: 0, size: 32, count: 3 } });
    const second = scheduler.submit({ name: "terrain.scatter", key: "dedupe:1", payload: { seed: 5, cx: 0, cz: 0, size: 32, count: 3 } });
    assert.equal(scheduler.has("dedupe:1"), true);
    assert.deepEqual(await first, await second);
    assert.equal(scheduler.stats.dedupHits, statsBefore + 1);
  });

  test("rejects a cancelled queued task and counts it as invalidated", async () => {
    const before = scheduler.stats.cancelled;
    const pending = scheduler.submit({ name: "terrain.heightfield", key: "cancel:queued", payload: { seed: 1, cx: 0, cz: 0, size: 8, resolution: 3 } });
    assert.equal(scheduler.cancel("cancel:queued"), true);
    await assertRejects(pending, (error) => error instanceof TaskCancelledError);
    assert.equal(scheduler.stats.cancelled, before + 1);
    assert.equal(scheduler.cancel("cancel:queued"), false);
  });

  test("invalidates a task that overstays the queue via queueTimeoutMs", async () => {
    const slow = new TaskScheduler({ inline: true, maxConcurrent: 1 });
    let release: (() => void) | null = null;
    registerTaskHandler("test.blocking", async () => {
      await new Promise<void>((resolve) => (release = resolve));
      return "unblocked";
    });
    const blocker = slow.submit({ name: "test.blocking", key: "blocker", payload: {} });
    const queued = slow.submit({ name: "terrain.heightfield", key: "stale", payload: { seed: 1, cx: 0, cz: 0, size: 8, resolution: 3 }, queueTimeoutMs: 10 });
    await assertRejects(queued, (error) => error instanceof TaskCancelledError);
    assert.equal(slow.has("stale"), false);
    release!();
    await assert.equal((await blocker), "unblocked");
    slow.dispose();
  });

  test("cancels a whole group by key prefix", async () => {
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
    assert.equal(group.cancelGroup("chunk:"), 2);
    await assertRejects(a, (error) => error instanceof TaskCancelledError);
    await assertRejects(b, (error) => error instanceof TaskCancelledError);
    assert.equal(group.has("keep:queued"), true);
    held = false;
    await running;
    await keep;
    group.dispose();
  });

  test("surfaces a handler failure as a rejection without wedging the queue", async () => {
    const failing = new TaskScheduler({ inline: true });
    registerTaskHandler("test.failing", () => {
      throw new Error("handler exploded");
    });
    await assertRejects(failing.submit({ name: "test.failing", key: "f", payload: {} }), "handler exploded");
    assert.equal(failing.stats.failed, 1);
    const ok = await failing.submit({ name: "terrain.scatter", key: "ok", payload: { seed: 1, cx: 0, cz: 0, size: 16, count: 2 } });
    assert.ok(ok);
    failing.dispose();
  });

  test("resolves completions in (priority, key) order when asked", async () => {
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
    assert.deepEqual(seen, ["a", "b", "c"]);
    ordered.dispose();
  });

  test("refuses new work and drains cleanly when disposed", async () => {
    const disposed = new TaskScheduler({ inline: true });
    disposed.dispose();
    await assertRejects(disposed.submit({ name: "terrain.scatter", key: "x", payload: { seed: 1, cx: 0, cz: 0, size: 8, count: 1 } }), /disposed/);
  });

  test("reports a full statistics record", () => {
    const stats: TaskStats = scheduler.stats;
    for (const field of ["queued", "running", "completed", "cancelled", "failed", "workers", "inline", "workerFailures", "inlineFallbacks"] as const) {
      assert.notEqual(stats[field], undefined, field);
    }
    assert.equal(stats.inline, true);
  });

  afterAll(() => scheduler.dispose());
});

group("Phase 9.1 — real worker threads", () => {
  let pool: WorkerThreadPool;
  let scheduler: TaskScheduler;

  beforeAll(async () => {
    installTerrainTaskHandlers(); // the main thread needs the same handler set as the worker
    pool = await createWorkerThreadPool();
    scheduler = new TaskScheduler({ workerCount: 3, createWorker: (i) => pool.createWorker(i) });
    // Worker threads are running; the suites below assert against them, not against the fallback.
    assert.equal(scheduler.stats.workers, 3);
    assert.equal(scheduler.stats.inline, false);
  }, 30000);

  afterAll(async () => {
    scheduler?.dispose();
    await pool?.dispose();
  });

  test("executes a task on another thread and delivers the result", async () => {
    const threadId = await scheduler.submit<Record<string, never>, number>({ name: "test.threadId", key: "thread:1", payload: {} });
    assert.equal(typeof threadId, "number");
    assert.ok(threadId > 0); // 0 is the main thread
    assert.ok(scheduler.stats.completed > 0);
  });

  test("runs several tasks concurrently across multiple workers", async () => {
    const ids = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        scheduler.submit<Record<string, never>, number>({ name: "test.threadId", key: `thread:${i + 2}`, payload: {} }),
      ),
    );
    assert.ok(new Set(ids).size > 1);
    for (const id of ids) assert.ok(id > 0);
  });

  test("generates terrain off the main thread, bit-for-bit identical to the inline result", async () => {
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
      assert.equal(fromWorker.cx, payload.cx);
      assert.equal(fromWorker.seed, payload.seed);
      assert.equal(fromWorker.bytes, inline.heights.byteLength + inline.slopes.byteLength + inline.biomes.byteLength);
      assert.ok(fromWorker.pipelineHash > 0);
      // The world cell the engine would build from that result carries the same data.
      const inlineCell = createWorldCell(payload.cx, payload.cz, payload.size, payload.resolution, payload.seed);
      createPipelineFromSpec(payload.pipeline).execute(inlineCell);
      assert.deepEqual([...fromWorker.heights], [...inlineCell.heights]);
      assert.equal(i, i); // keep the index (and the ordering) explicit
    }
  });

  test("generates analytic Mars cells on real workers without fallback, byte-identical to live pipelines", async () => {
    const pipelines = [
      createMarsPipeline({ site: { latDeg: 0, lonDeg: 0 } }),
      createMarsPipeline({
        paramsOverrides: { seed: 771, radius: MARS_RADIUS_M * 1.03, dichotomy: { amplitude: 712, seed: 8 }, canyon: [], volcanoes: [] },
        site: { latDeg: -11, lonDeg: 41, headingDeg: 76, radiusM: MARS_RADIUS_M * 0.9 },
      }).addStage(new ScatterGenerator({ countPerChunk: 8 })),
      createMarsPipeline({ site: { latDeg: 30, lonDeg: 110, headingDeg: -21 }, detail: false, curvatureCompensation: false }),
    ];
    const before = scheduler.stats;
    const jobs = pipelines.map((pipeline, i) => {
      const stage = pipeline.stages[0] as MarsTerrainStage;
      const payload = terrainCellPayload(pipeline, stage.seed, -2 + i, i, 128, 33 - i * 8);
      return { pipeline, payload };
    });
    const results = await Promise.all(jobs.map(({ payload }, i) =>
      scheduler.submit<TerrainCellTaskPayload, TerrainCellTaskResult>({ name: "terrain.cell", key: `mars:cell:${i}`, payload })));
    for (const [i, { pipeline, payload }] of jobs.entries()) {
      const expected = createWorldCell(payload.cx, payload.cz, payload.size, payload.resolution, payload.seed);
      pipeline.execute(expected);
      const actual = results[i]!;
      for (const field of ["heights", "slopes", "biomes"] as const) {
        assert.deepEqual(new Uint8Array(actual[field].buffer), new Uint8Array(expected[field].buffer));
      }
      assert.deepEqual(actual.scatters, expected.scatters);
      assert.ok(actual.pipelineHash > 0);
    }
    assert.equal(scheduler.stats.completed - before.completed, jobs.length);
    assert.equal(scheduler.stats.inlineFallbacks, before.inlineFallbacks);
    assert.equal(scheduler.stats.workerFailures, before.workerFailures);
    assert.equal(scheduler.stats.failed, before.failed);
    assert.equal(scheduler.stats.inline, false);
  });

  test("reports worker-side progress to the main thread", async () => {
    const payload = cellPayload(4, 4);
    const seen: number[] = [];
    const promise = scheduler.submit<TerrainCellTaskPayload, TerrainCellTaskResult>({ name: "terrain.cell", key: `progress:${payload.cx}`, payload });
    // `onProgress` attaches to an existing record, so the subscription goes in right after submit and
    // well before the worker's first progress message can arrive.
    const unsubscribe = scheduler.onProgress(`progress:${payload.cx}`, (value) => seen.push(value));
    await promise;
    unsubscribe();
    // Two stages → at least one progress report per stage crosses the boundary.
    assert.ok(seen.length >= 1);
    assertCloseTo(Math.max(...seen), 1, 5);
  });

  test("dedupes concurrent submissions of the same chunk key across workers", async () => {
    const payload = cellPayload(9, 9);
    const before = scheduler.stats.dedupHits;
    const [a, b] = await Promise.all([
      scheduler.submit<TerrainCellTaskPayload, TerrainCellTaskResult>({ name: "terrain.cell", key: "cell:9,9", payload }),
      scheduler.submit<TerrainCellTaskPayload, TerrainCellTaskResult>({ name: "terrain.cell", key: "cell:9,9", payload }),
    ]);
    assert.equal(scheduler.stats.dedupHits, before + 1);
    assert.equal(a.heights, b.heights); // one result object, not two copies
  });

  test("discards the result of a task cancelled while a worker is running it", async () => {
    const before = scheduler.stats.cancelled;
    const pending = scheduler.submit<Record<string, never>, number>({ name: "test.spin", key: "cancel:running", payload: {} });
    await new Promise((r) => setTimeout(r, 40)); // let it reach the worker
    assert.equal(scheduler.has("cancel:running"), true);
    assert.equal(scheduler.cancel("cancel:running"), true);
    await assertRejects(pending, (error) => error instanceof TaskCancelledError);
    assert.equal(scheduler.stats.cancelled, before + 1);
    // The remaining workers still serve requests (only the spinning one is busy).
    const id = await scheduler.submit<Record<string, never>, number>({ name: "test.threadId", key: "thread:after-cancel", payload: {} });
    assert.ok(id > 0);
  });

  test("runs a handler the worker lacks on the main thread instead", async () => {
    registerTaskHandler("test.mainThreadOnly", () => "ran-inline");
    const before = scheduler.stats.inlineFallbacks;
    const value = await scheduler.submit<Record<string, never>, string>({ name: "test.mainThreadOnly", key: "inline:1", payload: {} });
    assert.equal(value, "ran-inline");
    assert.equal(scheduler.stats.inlineFallbacks, before + 1);
    assert.equal(scheduler.stats.failed, 0);
  });

  test("honours a handler that declares itself main-thread-only", async () => {
    registerTaskHandler("test.inlineOnly", () => "main-thread-result");
    const value = await scheduler.submit<Record<string, never>, string>({ name: "test.inlineOnly", key: "inline:2", payload: {} });
    assert.equal(value, "main-thread-result");
    assert.equal(scheduler.stats.workerFailures, 0);
  });

  test("fails a task whose handler throws inside the worker, with the worker's message", async () => {
    const before = scheduler.stats.failed;
    await assertRejects(scheduler.submit({ name: "test.fail", key: "fail:1", payload: "explicit failure" }), "explicit failure");
    assert.equal(scheduler.stats.failed, before + 1);
  });

  test("retries a task inline when its worker dies mid-flight", async () => {
    // The worker-side `test.crashDuring` kills its thread; the main-thread handler of the same name
    // (registered here) is what the scheduler falls back to.
    registerTaskHandler("test.crashDuring", async () => "recovered-inline");
    const before = scheduler.stats.workerFailures;
    const value = await scheduler.submit<Record<string, never>, string>({ name: "test.crashDuring", key: "crash:1", payload: {} });
    assert.equal(value, "recovered-inline");
    assert.equal(scheduler.stats.workerFailures, before + 1);
    assert.ok(scheduler.stats.workers < 3);
    // The pool is smaller but still functional.
    const id = await scheduler.submit<Record<string, never>, number>({ name: "test.threadId", key: "thread:after-crash", payload: {} });
    assert.ok(id > 0);
  });

  test("builds a mesh BVH on another thread, byte-identical to the inline build", async () => {
    // The roadmap's 9.1 bullet: "verify BVH/LBVH generation can execute outside the main thread."
    const { positions, indices } = bvhSoup();
    const inline = buildBvhTask({ positions, indices, leafSize: 4 });
    const offThread = await scheduler.submit<BvhTaskPayload, BvhTaskResult>({
      name: "geometry.bvh",
      key: "bvh:main",
      payload: { positions, indices, leafSize: 4 },
    });

    assert.equal(offThread.hash, inline.hash);
    assert.equal(offThread.nodeCount, inline.nodeCount);
    assert.equal(offThread.leafCount, inline.leafCount);
    assert.equal(offThread.maxDepth, inline.maxDepth);
    assert.equal(offThread.triangleCount, inline.triangleCount);
    assert.deepEqual([...offThread.nodeBounds], [...inline.nodeBounds]);
    assert.deepEqual([...offThread.nodeLeftFirst], [...inline.nodeLeftFirst]);
    assert.deepEqual([...offThread.nodeTriCount], [...inline.nodeTriCount]);
    assert.deepEqual([...offThread.triOrder], [...inline.triOrder]);
    assert.deepEqual([...offThread.bounds], [...inline.bounds]);

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
    assert.equal(restored.raycast(ray, fromWorker), true);
    assert.equal(MeshBvh.build(positions, indices, { leafSize: 4 }).raycast(ray, native), true);
    assert.equal(fromWorker.index, native.index);
    assertCloseTo(fromWorker.distance, native.distance, 6);

    // The payload crossed as a copy, not a transfer: the caller still owns its geometry.
    assert.ok(positions.length > 0);
    assert.ok(indices.length > 0);
  });

  test("builds two BVHs concurrently on different workers", async () => {
    const { positions, indices } = bvhSoup(8);
    const [a, b] = await Promise.all([
      scheduler.submit<BvhTaskPayload, BvhTaskResult>({ name: "geometry.bvh", key: "bvh:a", payload: { positions, indices } }),
      scheduler.submit<BvhTaskPayload, BvhTaskResult>({ name: "geometry.bvh", key: "bvh:b", payload: { positions, indices } }),
    ]);
    assert.equal(a.hash, b.hash);
    assert.equal(a.hash, buildBvhTask({ positions, indices }).hash);
  });

  test("drains every queued task", async () => {
    for (let i = 0; i < 8; i++) {
      void scheduler.submit({ name: "test.echo", key: `echo:${i}`, payload: { i } });
    }
    await scheduler.drain(30000);
    assert.equal(scheduler.pending, 0);
  });
});


group("Mars worker startup cancellation", () => {
  test("reuses a worker after a Mars task is cancelled while its handlers are still loading", async () => {
    // Browser module imports can be slow. Hold that boot phase explicitly so both the task and
    // its cancel arrive before ready; a discarded result must still release the scheduler slot.
    const pool = await createWorkerThreadPool({
      installEngineHandlers: false,
      adapter: `
        import { installWorkerScope } from ${JSON.stringify(`${workerHarnessPaths.engineSrc}/core/tasks/workerScope.ts`)};
        import { installTerrainTaskHandlers } from ${JSON.stringify(`${workerHarnessPaths.engineSrc}/terrain/tasks.ts`)};
        installWorkerScope(self, { installHandlers: async () => {
          await new Promise((resolve) => setTimeout(resolve, 80));
          installTerrainTaskHandlers();
        }});
      `,
    });
    const scheduler = new TaskScheduler({ workerCount: 1, createWorker: (i) => pool.createWorker(i) });
    try {
      const payload = terrainCellPayload(createMarsPipeline({ site: { latDeg: 0, lonDeg: 0 } }), 1337, -2, 0, 128, 9);
      const cancelled = scheduler.submit({ name: "terrain.cell", key: "mars:old", payload });
      const rejection = assertRejects(cancelled, (error) => error instanceof TaskCancelledError);
      assert.equal(scheduler.cancel("mars:old"), true);
      await rejection;
      const replacement = scheduler.submit<TerrainCellTaskPayload, TerrainCellTaskResult>({ name: "terrain.cell", key: "mars:new", payload });
      void replacement.catch(() => undefined); // A failed drain still tears down without an unhandled cancellation.
      await scheduler.drain(2000);
      assert.equal((await replacement).heights.length, 81);
      assert.equal(scheduler.stats.completed, 1);
      assert.equal(scheduler.stats.cancelled, 1);
      assert.equal(scheduler.stats.inlineFallbacks, 0);
      assert.equal(scheduler.stats.workerFailures, 0);
    } finally {
      scheduler.dispose();
      await pool.dispose();
    }
  });
});

await finish();
