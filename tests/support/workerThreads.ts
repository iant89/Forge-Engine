/**
 * Real worker threads for the Node test suites.
 *
 * The engine's task scheduler spawns browser module workers (`new Worker(url, { type: "module" })`).
 * Node has no global `Worker`, and vitest runs TypeScript straight from source, so a test cannot
 * just point the scheduler at `worker-entry.ts`. This harness closes that gap honestly:
 *
 *  1. a small adapter module is *generated* into a temp directory,
 *  2. esbuild bundles it — with the real `workerScope.ts`/`registry.ts`/handler packages and any
 *     test handlers — into one ESM file,
 *  3. `node:worker_threads` runs that bundle on a genuine second thread, wrapped in a class that
 *     presents the browser `Worker` surface the scheduler expects.
 *
 * So the suites assert against the shipping protocol implementation, running on another thread, with
 * real structured cloning and real transferables. The only thing this does not exercise is the
 * browser's own module-worker loading, which `npm run check:browser` covers on a real adapter.
 *
 * The harness is only used by tests; nothing in the engine imports it.
 */

import { build } from "esbuild";
import { Worker as NodeWorker } from "node:worker_threads";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { TaskWorkerLike, WorkerMessage } from "@forge/engine";

const ENGINE_SRC = path.resolve(fileURLToPath(new URL("../../engine/src", import.meta.url)));
const here = path.dirname(fileURLToPath(import.meta.url));

export interface WorkerThreadPool {
  /** One `TaskWorkerLike` per worker, matching a browser `Worker` closely enough for the scheduler. */
  createWorker(index: number): TaskWorkerLike;
  /** Workers created so far (the pool increments it on every `createWorker`). */
  spawned: number;
  /** Bundled worker module path (for diagnostics in a failure message). */
  readonly bundlePath: string;
  dispose(): Promise<void>;
}

export interface WorkerPoolOptions {
  /**
   * Extra adapter source appended before the bundle is built. It runs inside the worker and can
   * register test handlers; the engine's `workerScope` is installed by the generated prelude.
   */
  adapter?: string;
  /** Handlers from the engine to install in the worker. */
  installEngineHandlers?: boolean;
}

/**
 * Bundle a worker module and return a factory for `TaskSchedulerOptions.createWorker`.
 *
 * The generated prelude installs `globalThis.self` (what a browser worker provides and
 * `worker-entry.ts` reads) on top of `parentPort`, then imports the engine's own worker entry, so the
 * code under test is the same file the browser loads.
 */
export async function createWorkerThreadPool(options: WorkerPoolOptions = {}): Promise<WorkerThreadPool> {
  const dir = mkdtempSync(path.join(tmpdir(), "forge-worker-"));
  const entry = path.join(dir, "worker-entry.mjs");
  const prelude = `
import { parentPort } from "node:worker_threads";
globalThis.self = {
  postMessage: (message, transfer) => parentPort.postMessage(message, transfer ?? []),
  addEventListener: (type, listener) => {
    if (type === "message") parentPort.on("message", (data) => listener({ data }));
  },
};
`;
  const handlers = options.installEngineHandlers === false
    ? ""
    : `
import { InlineOnlyError, registerTaskHandler } from ${JSON.stringify(path.join(ENGINE_SRC, "core/tasks/registry.ts"))};
import { TaskCancelledError } from ${JSON.stringify(path.join(ENGINE_SRC, "core/tasks/scheduler.ts"))};
import { installTerrainTaskHandlers } from ${JSON.stringify(path.join(ENGINE_SRC, "terrain/tasks.ts"))};
import { threadId } from "node:worker_threads";

// Test-only handlers, registered exactly the way a host registers its own task names.
registerTaskHandler("test.threadId", () => threadId);
registerTaskHandler("test.echo", (payload) => payload);
registerTaskHandler("test.fail", (payload) => { throw new Error(String(payload ?? "boom")); });
registerTaskHandler("test.spin", () => new Promise(() => { /* never settles; only terminate() ends it */ }));
registerTaskHandler("test.cancelAware", async (payload, ctx) => {
  if (ctx.cancelled) throw new TaskCancelledError("test.cancelAware");
  return payload;
});
// Declares that it cannot run here: the scheduler must re-run it on the main thread.
registerTaskHandler("test.inlineOnly", () => { throw new InlineOnlyError("test.inlineOnly needs the main thread"); });
// Kills this thread while the task is in flight (an uncaught exception in a worker is a crash).
registerTaskHandler("test.crashDuring", () => {
  setTimeout(() => { throw new Error("worker crashed mid-task"); }, 5);
  return new Promise(() => { /* never settles: the thread is gone */ });
});
installTerrainTaskHandlers(registerTaskHandler);
`;
  writeFileSync(
    entry,
    `${prelude}${handlers}${options.adapter ?? ""}\nawait import(${JSON.stringify(path.join(ENGINE_SRC, "core/tasks/worker-entry.ts"))});\n`,
    "utf8",
  );
  const bundlePath = path.join(dir, "worker-bundle.mjs");
  await build({
    entryPoints: [entry],
    outfile: bundlePath,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node20",
    logLevel: "silent",
    // `worker-entry.ts` resolves its own module graph; keep the bundle self-contained.
    external: [],
  });

  const workers = new Set<NodeWorkerAdapter>();
  const pool: WorkerThreadPool = {
    spawned: 0,
    bundlePath,
    createWorker: () => {
      const adapter = new NodeWorkerAdapter(bundlePath, () => {
        pool.spawned++;
      });
      workers.add(adapter);
      return adapter;
    },
    dispose: async () => {
      for (const w of workers) await w.terminateAsync();
      workers.clear();
      rmSync(dir, { recursive: true, force: true });
    },
  };
  return pool;
}

/**
 * `node:worker_threads` speaks `on("message")`; the scheduler's `TaskWorkerLike` seam speaks
 * `addEventListener`. This adapter is also what proves the seam is *sufficient*: nothing in the
 * scheduler reaches for a browser-only member.
 */
class NodeWorkerAdapter implements TaskWorkerLike {
  private readonly worker: NodeWorker;
  private readonly messageListeners = new Set<(event: { data: WorkerMessage }) => void>();
  private readonly errorListeners = new Set<(event: { message?: string }) => void>();
  private terminated = false;

  constructor(bundlePath: string, onReady: () => void) {
    this.worker = new NodeWorker(new URL(`file://${bundlePath}`), { name: "forge-test-worker" });
    onReady();
    this.worker.on("message", (data: WorkerMessage) => {
      for (const fn of this.messageListeners) fn({ data });
    });
    this.worker.on("error", (error: Error) => {
      for (const fn of this.errorListeners) fn({ message: error.message });
    });
  }

  postMessage(message: unknown, transfer?: Transferable[]): void {
    this.worker.postMessage(message, transfer as never);
  }

  addEventListener(type: "message", listener: (event: { data: WorkerMessage }) => void): void;
  addEventListener(type: "error", listener: (event: { message?: string }) => void): void;
  addEventListener(type: "message" | "error", listener: ((event: { data: WorkerMessage }) => void) | ((event: { message?: string }) => void)): void {
    if (type === "message") this.messageListeners.add(listener as (event: { data: WorkerMessage }) => void);
    else this.errorListeners.add(listener as (event: { message?: string }) => void);
  }

  terminate(): void {
    void this.terminateAsync();
  }

  /** Simulate a thread crash the way the scheduler sees it (an `error` event, no result). */
  emitError(message: string): void {
    for (const fn of this.errorListeners) fn({ message });
  }

  async terminateAsync(): Promise<void> {
    if (this.terminated) return;
    this.terminated = true;
    await this.worker.terminate();
  }
}

/** Handy for a suite that needs to know the source roots it bundled. */
export const workerHarnessPaths = { engineSrc: ENGINE_SRC, supportDir: here };
