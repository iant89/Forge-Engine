/**
 * Bounded, prioritized background task scheduler with a synchronous fallback.
 *
 * Contract:
 *  - A task is `{ name, key, priority, payload }`; `name` selects a pure handler (see
 *    `registry.ts`) available on both sides, `key` is the dedupe/cancel identity.
 *  - `submit()` shares an existing pending promise when the key is already queued or running —
 *    terrain streaming relies on this (many chunks request the same neighbour data).
 *  - `cancelGroup(prefix)` drops queued work; running work cannot be preempted in JS, so it is
 *    *flagged* cancelled and its result is discarded, which is safe because handlers are pure.
 *  - When workers are unavailable (Node tests, blocked CSP, failed spawn) the *same* code path
 *    executes inline via microtask, so behaviour never diverges between environments.
 *  - `setOrderedResolution(true)` resolves completions in (priority, key) order instead of
 *    arrival order, which is what replays/CI need when a task's result is applied to shared
 *    state (default off, since it adds latency).
 */

import { EventTarget2, type Disposable } from "../events.js";
import { UsageError } from "../errors.js";
import { Logger, LogLevel } from "../log.js";
import { runTask, hasTaskHandler, registerBuiltinTaskHandlers, type TaskContext } from "./registry.js";

export const TaskPriority = {
  Critical: 0,
  High: 100,
  Normal: 200,
  Low: 400,
  Background: 800,
} as const;
export type TaskPriority = (typeof TaskPriority)[keyof typeof TaskPriority];

export interface TaskDescriptor<P = unknown> {
  name: string;
  payload: P;
  /** `group:rest` — the group prefix is used by `cancelGroup`. */
  key: string;
  priority?: number;
  /** Buffers transferred to the worker instead of copied. */
  transfer?: (ArrayBuffer | SharedArrayBuffer)[];
  /** Fail the task if it has not started within this many ms (stale streaming work). */
  queueTimeoutMs?: number;
}

export class TaskCancelledError extends Error {
  constructor(public readonly key: string) {
    super(`task cancelled: ${key}`);
    this.name = "TaskCancelledError";
  }
}

interface TaskRecord {
  id: number;
  name: string;
  key: string;
  priority: number;
  payload: unknown;
  transfer?: (ArrayBuffer | SharedArrayBuffer)[];
  queueTimeoutMs?: number;
  state: "queued" | "running" | "done" | "cancelled" | "failed";
  enqueuedAt: number;
  startedAt: number;
  entry: WorkerEntry | null;
  progress: ProgressChannel | null;
  /** Set when a running task is cancelled: handlers poll it, results are dropped. */
  cancelRequested: boolean;
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
  promise: Promise<unknown>;
}

class ProgressChannel {
  private listeners = new Set<(value: number, detail?: unknown) => void>();
  value = -1;

  add(fn: (value: number, detail?: unknown) => void): () => void {
    this.listeners.add(fn);
    if (this.value >= 0) fn(this.value);
    return () => this.listeners.delete(fn);
  }

  emit(value: number, detail?: unknown): void {
    this.value = value;
    for (const fn of this.listeners) fn(value, detail);
  }
}

interface WorkerEntry {
  worker: Worker;
  index: number;
  busy: boolean;
  currentId: number;
  dead: boolean;
}

export interface TaskSchedulerOptions {
  logger?: Logger;
  /** Worker thread count. 0 (or no Worker API) → inline execution. */
  workerCount?: number;
  /** Concurrent running tasks (defaults to workerCount*2, or 8 inline). */
  maxConcurrent?: number;
  maxQueue?: number;
  /** Never spawn workers even if available (tests). */
  inline?: boolean;
  workerUrl?: string | URL;
}

export interface TaskStats {
  queued: number;
  running: number;
  completed: number;
  cancelled: number;
  failed: number;
  workers: number;
  inline: boolean;
  queuedMs: number;
  workMs: number;
  lastTaskMs: number;
  dedupHits: number;
}

const now = (): number =>
  typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : Date.now();

export class TaskScheduler implements Disposable {
  readonly onStats = new EventTarget2<TaskStats>();

  private readonly logger: Logger;
  private readonly maxConcurrent: number;
  private readonly maxQueue: number;
  private readonly workers: WorkerEntry[] = [];
  private readonly queue: TaskRecord[] = [];
  private readonly byKey = new Map<string, TaskRecord>();
  private readonly byId = new Map<number, TaskRecord>();
  private nextId = 1;
  private running = 0;
  private disposed = false;
  private orderedResolution = false;
  private pendingResolve: { rec: TaskRecord; value: unknown }[] = [];
  private flushQueued = false;
  private readonly counters = { completed: 0, cancelled: 0, failed: 0, dedupHits: 0, queuedMs: 0, workMs: 0, lastTaskMs: 0 };

  constructor(options: TaskSchedulerOptions = {}) {
    this.logger = (options.logger ?? Logger.createRoot({ level: LogLevel.Info })).child("tasks");
    const workerCount = Math.max(0, options.workerCount ?? 0);
    this.maxConcurrent = options.maxConcurrent ?? (workerCount > 0 ? workerCount * 2 : 8);
    this.maxQueue = options.maxQueue ?? 4096;
    registerBuiltinTaskHandlers();
    if (!options.inline && workerCount > 0 && typeof Worker !== "undefined") this.spawnWorkers(workerCount, options.workerUrl);
    if (this.workers.length === 0 && workerCount > 0) {
      this.logger.info(`running ${workerCount} requested worker(s) inline (Worker API unavailable)`);
    }
  }

  get isInline(): boolean {
    return this.workers.length === 0;
  }

  setOrderedResolution(on: boolean): void {
    this.orderedResolution = on;
  }

  private spawnWorkers(count: number, url?: string | URL): void {
    const workerUrl = url ?? new URL("./worker-entry.js", import.meta.url).href;
    for (let i = 0; i < count; i++) {
      try {
        const worker = new Worker(workerUrl, { type: "module", name: `forge-task-${i}` });
        const entry: WorkerEntry = { worker, index: i, busy: false, currentId: -1, dead: false };
        worker.addEventListener("message", (e: MessageEvent) => this.onWorkerMessage(entry, e.data));
        worker.addEventListener("error", (e: ErrorEvent) => this.onWorkerError(entry, e));
        this.workers.push(entry);
      } catch (e) {
        this.logger.warn(`worker ${i} failed to start (${String(e)}); falling back to inline`);
        break;
      }
    }
  }

  private onWorkerError(entry: WorkerEntry, e: ErrorEvent): void {
    entry.dead = true;
    entry.busy = false;
    this.logger.error(`worker ${entry.index} crashed: ${e.message ?? "unknown"}`);
    const rec = entry.currentId >= 0 ? this.byId.get(entry.currentId) : undefined;
    if (rec && rec.state === "running") {
      rec.entry = null;
      this.runInline(rec); // retry once inline so a dead worker never wedges the stream
    }
    this.workers.splice(this.workers.indexOf(entry), 1);
    this.pump();
  }

  private onWorkerMessage(entry: WorkerEntry, msg: WorkerMessage): void {
    if (!msg || typeof msg !== "object") return;
    if (msg.type === "ready") {
      entry.dead = false;
      return;
    }
    const rec = this.byId.get(msg.id);
    if (!rec) return; // cancelled: result already discarded
    switch (msg.type) {
      case "progress":
        rec.progress?.emit(Number(msg.value ?? 0), msg.detail);
        return;
      case "result":
        rec.entry = null;
        entry.busy = false;
        entry.currentId = -1;
        this.complete(rec, msg.value);
        this.pump();
        return;
      case "error":
        rec.entry = null;
        entry.busy = false;
        entry.currentId = -1;
        if (hasTaskHandler(rec.name)) {
          this.complete(rec, msg.value); // worker may lack a lazily-registered handler → run inline
        } else {
          this.fail(rec, new Error(msg.error ?? "worker task failed"));
        }
        this.pump();
        return;
    }
  }

  /** Await all queued and running tasks (used by loading screens, tests and `engine.waitForIdle`). */
  async drain(timeoutMs = 60000): Promise<void> {
    if (this.pending === 0) return;
    const start = now();
    while (this.pending > 0) {
      if (now() - start > timeoutMs) {
        throw new UsageError(`TaskScheduler.drain() timed out with ${this.queue.length} queued / ${this.running} running`);
      }
      await sleep(2);
    }
  }

  get pending(): number {
    return this.queue.length + this.running;
  }

  get stats(): TaskStats {
    return {
      queued: this.queue.length,
      running: this.running,
      completed: this.counters.completed,
      cancelled: this.counters.cancelled,
      failed: this.counters.failed,
      workers: this.workers.length,
      inline: this.isInline,
      queuedMs: this.counters.queuedMs,
      workMs: this.counters.workMs,
      lastTaskMs: this.counters.lastTaskMs,
      dedupHits: this.counters.dedupHits,
    };
  }

  /**
   * `R` is the caller's declared result type; the descriptor itself cannot know it (the handler does),
   * so it is a parameter of `submit` rather than of `TaskDescriptor`.
   */
  submit<P, R>(descriptor: TaskDescriptor<P>): Promise<R> {
    if (this.disposed) return Promise.reject(new UsageError("TaskScheduler is disposed"));
    const existing = this.byKey.get(descriptor.key);
    if (existing && (existing.state === "queued" || existing.state === "running")) {
      this.counters.dedupHits++;
      return existing.promise as Promise<R>;
    }
    if (this.queue.length >= this.maxQueue) {
      throw new UsageError(
        `TaskScheduler queue overflow (${this.queue.length}/${this.maxQueue}). ` +
          `Streaming callers must cancel superseded work before submitting more.`,
      );
    }
    let resolve!: (v: unknown) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<unknown>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const rec: TaskRecord = {
      id: this.nextId++,
      name: descriptor.name,
      key: descriptor.key,
      priority: descriptor.priority ?? TaskPriority.Normal,
      payload: descriptor.payload,
      transfer: descriptor.transfer,
      queueTimeoutMs: descriptor.queueTimeoutMs,
      state: "queued",
      enqueuedAt: now(),
      startedAt: 0,
      entry: null,
      progress: null,
      cancelRequested: false,
      resolve,
      reject,
      promise,
    };
    // Priority insertion (queue is kept sorted; typical length is small and this avoids a sort).
    let i = this.queue.length;
    while (i > 0 && this.queue[i - 1]!.priority > rec.priority) i--;
    this.queue.splice(i, 0, rec);
    this.byKey.set(rec.key, rec);
    this.byId.set(rec.id, rec);
    if (rec.queueTimeoutMs && rec.queueTimeoutMs > 0) {
      const timer = setTimeout(() => {
        if (rec.state === "queued") this.cancel(rec.key, new TaskCancelledError(`${rec.key} (queue timeout)`));
      }, rec.queueTimeoutMs) as unknown as { unref?: () => void };
      // Node only: keep a pending timeout from holding the process open (the browser has no unref).
      timer.unref?.();
    }
    this.pump();
    return promise as Promise<R>;
  }

  has(key: string): boolean {
    const r = this.byKey.get(key);
    return !!r && (r.state === "queued" || r.state === "running");
  }

  /** Subscribe to a task's progress. Returns an unsubscribe function. */
  onProgress(key: string, fn: (value: number, detail?: unknown) => void): () => void {
    const rec = this.byKey.get(key);
    if (!rec) return () => {};
    if (!rec.progress) rec.progress = new ProgressChannel();
    return rec.progress.add(fn);
  }

  cancel(key: string, error: unknown = new TaskCancelledError(key)): boolean {
    const rec = this.byKey.get(key);
    if (!rec) return false;
    if (rec.state === "queued") {
      this.remove(rec);
      this.counters.cancelled++;
      rec.state = "cancelled";
      rec.reject(error);
      this.onStats.emit(this.stats);
      return true;
    }
    if (rec.state === "running") {
      // Cannot preempt; flag it so the result is dropped and tell the worker to stop early.
      rec.cancelRequested = true;
      rec.state = "cancelled";
      this.counters.cancelled++;
      this.byId.delete(rec.id);
      this.byKey.delete(rec.key);
      rec.entry?.worker.postMessage({ type: "cancel", id: rec.id });
      rec.reject(error);
      this.onStats.emit(this.stats);
      return true;
    }
    return false;
  }

  /** Cancel queued work whose key starts with `prefix`. Returns the number cancelled. */
  cancelGroup(prefix: string): number {
    let n = 0;
    for (const rec of [...this.queue]) {
      if (rec.key.startsWith(prefix) && rec.state === "queued") {
        this.cancel(rec.key);
        n++;
      }
    }
    for (const rec of this.byId.values()) {
      if (rec.state === "running" && rec.key.startsWith(prefix)) {
        this.cancel(rec.key);
        n++;
      }
    }
    return n;
  }

  private remove(rec: TaskRecord): void {
    const i = this.queue.indexOf(rec);
    if (i >= 0) this.queue.splice(i, 1);
    this.byKey.delete(rec.key);
    this.byId.delete(rec.id);
  }

  private pump(): void {
    if (this.disposed) return;
    while (this.queue.length > 0 && this.running < this.maxConcurrent) {
      const rec = this.queue[0]!;
      if (rec.state !== "queued") {
        this.queue.shift();
        continue;
      }
      let entry: WorkerEntry | null = null;
      for (const w of this.workers) {
        if (!w.busy && !w.dead) {
          entry = w;
          break;
        }
      }
      if (this.workers.length > 0 && !entry) return; // all busy: wait for a completion
      this.queue.shift();
      rec.state = "running";
      rec.startedAt = now();
      this.counters.queuedMs += rec.startedAt - rec.enqueuedAt;
      this.running++;
      if (!entry) {
        void this.runInline(rec);
      } else {
        entry.busy = true;
        entry.currentId = rec.id;
        rec.entry = entry;
        entry.worker.postMessage({ type: "task", id: rec.id, name: rec.name, payload: rec.payload }, rec.transfer ?? []);
      }
    }
  }

  private async runInline(rec: TaskRecord): Promise<void> {
    const ctx: TaskContext = {
      get cancelled() {
        return rec.cancelRequested;
      },
      progress: (v, detail) => rec.progress?.emit(v, detail),
    };
    try {
      const value = await runTask(rec.name, rec.payload, ctx);
      this.complete(rec, value);
    } catch (e) {
      this.fail(rec, e);
    } finally {
      this.pump();
    }
  }

  private complete(rec: TaskRecord, value: unknown): void {
    if (rec.state === "cancelled") return; // result discarded on purpose
    this.counters.workMs += now() - rec.startedAt;
    this.counters.lastTaskMs = now() - (rec.startedAt || rec.enqueuedAt);
    this.counters.completed++;
    this.finish(rec);
    if (this.orderedResolution) {
      this.pendingResolve.push({ rec, value });
      this.scheduleFlush();
    } else {
      rec.resolve(value);
    }
  }

  private fail(rec: TaskRecord, error: unknown): void {
    if (rec.state === "cancelled") return;
    this.counters.failed++;
    this.finish(rec);
    rec.reject(error);
  }

  private finish(rec: TaskRecord): void {
    rec.state = "done";
    this.running = Math.max(0, this.running - 1);
    this.byId.delete(rec.id);
    this.byKey.delete(rec.key);
    if (rec.entry) {
      rec.entry.busy = false;
      rec.entry.currentId = -1;
      rec.entry = null;
    }
    this.onStats.emit(this.stats);
  }

  private scheduleFlush(): void {
    if (this.flushQueued) return;
    this.flushQueued = true;
    queueMicrotask(() => {
      this.flushQueued = false;
      const batch = this.pendingResolve.splice(0, this.pendingResolve.length);
      batch.sort((a, b) => (a.rec.priority - b.rec.priority) || (a.rec.key < b.rec.key ? -1 : a.rec.key > b.rec.key ? 1 : 0));
      for (const { rec, value } of batch) rec.resolve(value);
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const rec of [...this.queue]) this.cancel(rec.key, new TaskCancelledError(`${rec.key} (scheduler disposed)`));
    for (const rec of this.byId.values()) this.cancel(rec.key, new TaskCancelledError(`${rec.key} (scheduler disposed)`));
    for (const w of this.workers) w.worker.terminate();
    this.workers.length = 0;
    this.byId.clear();
    this.byKey.clear();
    this.onStats.clear();
  }
}

interface WorkerMessage {
  type: "ready" | "task" | "result" | "error" | "progress" | "cancel";
  id: number;
  value?: unknown;
  error?: string;
  detail?: unknown;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
