/**
 * `AssetStreamer` — priority-scheduled, cancellable, budgeted asset loading (Phase 15.3).
 *
 * The registry (Phase 1/9) loads on `acquire` — whoever calls first, loads first, and every load
 * starts the moment it is requested. That is the wrong shape for a large scene: forty textures
 * requested by forty systems on one frame all hit the GPU in the same frame, and a background
 * pre-fetch competes with the texture a visible object needs right now. The streamer is the
 * scheduler in front of the registry:
 *
 *  - **Async, incremental.** `request()` only *queues*; loads start when `pump()` admits them,
 *    one call per frame (`Engine.step` does this for `engine.streamer`). Nothing blocks the
 *    simulation loop — a frame admits what it can and the rest waits in the queue.
 *  - **Prioritization.** The queue is drained highest `descriptor.priority` first (FIFO ties).
 *    A high-priority texture a visible object needs jumps over queued background pre-fetches.
 *  - **Cancellation.** `cancel(id)` drops a queued load outright; an in-flight load is aborted
 *    through `registry.cancelLoad` — it finishes off the record, its output is disposed, the
 *    entry fails with a cancellation error, and the streamer classifies it as `cancelled`.
 *  - **GPU upload budgeting.** Each frame carries `uploadBudgetBytes` of estimated upload.
 *    Admitting a load charges its `descriptor.estimatedBytes` (a conservative pre-load estimate,
 *    unlike `bytes(value)`, which is accounted *after* the load); `newFrame()` resets the
 *    budget. Items that do not fit stay queued for the next frame — a 16 MB pre-fetch never
 *    starves the frame, and small high-priority items still make it.
 *
 * Relationship to the rest of the pipeline: the streamer owns *scheduling* only. Dedup,
 * refcounting, eviction, byte budgeting and the dependency graph stay in the registry (15.1/15.2);
 * the streamer holds one handle per in-flight load (which is also why an in-flight entry is
 * eviction-safe) and releases it when the load settles — callers that want a lease take their
 * own, which the registry dedups for free.
 *
 * Settled loads are kept in the streamer (id → load) so repeated `request`s dedupe: a second
 * request for a ready id resolves immediately without touching the queue.
 */

import { ResourceLifecycleError, UsageError } from "../core/errors.js";
import type { Logger } from "../core/log.js";
import { ResourceHandle, ResourceRegistry, type ResourceDescriptor } from "./registry.js";

export interface StreamerOptions {
  /** Max concurrent in-flight loads admitted by the streamer (default 4). */
  maxConcurrent?: number;
  /**
   * Per-frame GPU upload budget in bytes (0 = unlimited). An admitted load charges its
   * `descriptor.estimatedBytes` against it; `newFrame()` resets it. Changing the value at
   * runtime takes effect from the next `newFrame()`.
   */
  uploadBudgetBytes?: number;
  logger?: Logger | null;
}

export type StreamingState = "queued" | "loading" | "ready" | "failed" | "cancelled";

export interface StreamedLoad<T> {
  readonly id: string;
  readonly priority: number;
  state: StreamingState;
  /** Resolves with the loaded value; rejects on failure or cancellation. */
  readonly promise: Promise<T>;
  /** Cancel when queued or in-flight; settled loads return false. */
  cancel(): boolean;
  /** The streamer's lease on the entry, non-null while the load is in flight. */
  handle(): ResourceHandle<T> | null;
}

export interface StreamingStats {
  queued: number;
  inFlight: number;
  ready: number;
  failed: number;
  cancelled: number;
  budgetBytes: number;
  budgetRemaining: number;
  bytesAdmittedThisFrame: number;
  /** Cumulative: queued items pump skipped because the frame budget was exhausted. */
  deferredForBudget: number;
}

interface PendingLoad<T> {
  descriptor: ResourceDescriptor<T>;
  priority: number;
  /** Insertion order — the FIFO tiebreak inside a priority. */
  seq: number;
  state: StreamingState;
  handle: ResourceHandle<T> | null;
  cancelledByUser: boolean;
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

export class AssetStreamer {
  readonly registry: ResourceRegistry;
  /** Tune at runtime (e.g. on a quality change); the budget part applies from the next `newFrame()`. */
  maxConcurrent: number;
  uploadBudgetBytes: number;
  private readonly logger: Logger | null;
  private readonly queue: PendingLoad<unknown>[] = [];
  private readonly loads = new Map<string, PendingLoad<unknown>>();
  private seq = 0;
  private budgetRemaining: number;
  private bytesAdmittedThisFrame = 0;
  private deferredForBudget = 0;
  private readyCount = 0;
  private failedCount = 0;
  private cancelledCount = 0;
  private disposed = false;

  constructor(registry: ResourceRegistry, options: StreamerOptions = {}) {
    this.registry = registry;
    this.maxConcurrent = options.maxConcurrent ?? 4;
    this.uploadBudgetBytes = Math.max(0, options.uploadBudgetBytes ?? 0);
    this.budgetRemaining = this.uploadBudgetBytes;
    this.logger = options.logger ?? null;
  }

  get queued(): number {
    return this.queue.length;
  }

  /** Loads admitted and not yet settled (the concurrency cap applies to this). */
  get inFlight(): number {
    let n = 0;
    for (const load of this.loads.values()) if (load.state === "loading") n++;
    return n;
  }

  /**
   * Queue a load. Returns immediately — the load starts on a later `pump()` (or now, if the id
   * is already known to the registry as loading/ready, in which case no new upload is implied
   * and nothing is charged or counted against the cap).
   */
  request<T>(descriptor: ResourceDescriptor<T>): StreamedLoad<T> {
    if (this.disposed) throw new ResourceLifecycleError("AssetStreamer was disposed");
    if (!descriptor.id) throw new UsageError("ResourceDescriptor.id must be a non-empty string");
    if (!descriptor.kind) throw new UsageError("ResourceDescriptor.kind must be a non-empty string");

    const existing = this.loads.get(descriptor.id) as PendingLoad<T> | undefined;
    // A terminal failed/cancelled load is re-requestable — the registry retries failed entries
    // on acquire, and that re-load is a real upload, so it goes through the queue below.
    if (existing && existing.state !== "failed" && existing.state !== "cancelled") return this.view(existing);

    const state = this.registry.stateOf(descriptor.id);
    const load = this.createPending(descriptor);
    // Already in flight or ready in the registry (direct acquire, or a settled streamer request):
    // attach to it. A failed entry is deliberately NOT fast-pathed — its re-load is a real
    // upload and goes through the queue like everything else.
    if (state === "ready" || state === "loading") this.admit(load, false);
    else this.queue.push(load as PendingLoad<unknown>);
    return this.view(load);
  }

  /**
   * Start the highest-priority queued loads that fit the concurrency cap and the frame's upload
   * budget. Call once per frame — `Engine.step` does this for `engine.streamer`. Returns the
   * number of loads admitted.
   */
  pump(): number {
    if (this.disposed) return 0;
    let admitted = 0;
    for (;;) {
      if (this.inFlight >= this.maxConcurrent || this.queue.length === 0) break;
      let pick = -1;
      let skipped = 0;
      for (let i = 0; i < this.queue.length; i++) {
        const load = this.queue[i];
        if (this.uploadBudgetBytes > 0) {
          const est = Math.max(0, load.descriptor.estimatedBytes ?? 0);
          // est === 0 is not budgetable and always fits.
          if (est > this.budgetRemaining) {
            skipped++;
            continue;
          }
        }
        if (pick === -1 || this.better(load, this.queue[pick])) pick = i;
      }
      if (pick === -1) {
        if (skipped > 0) this.deferredForBudget += skipped;
        break;
      }
      this.admit(this.queue.splice(pick, 1)[0] as PendingLoad<unknown>, true);
      admitted++;
    }
    return admitted;
  }

  /** Begin a new frame: reset the upload budget and this frame's admitted-byte counter. */
  newFrame(): void {
    this.budgetRemaining = this.uploadBudgetBytes;
    this.bytesAdmittedThisFrame = 0;
  }

  /** Cancel a queued or in-flight load. Returns true when a cancellation was initiated. */
  cancel(id: string): boolean {
    const load = this.loads.get(id) as PendingLoad<unknown> | undefined;
    if (!load || (load.state !== "queued" && load.state !== "loading")) return false;
    load.cancelledByUser = true;
    if (load.state === "queued") {
      const i = this.queue.indexOf(load);
      if (i >= 0) this.queue.splice(i, 1);
      this.settleLoad(load, "cancelled");
      load.reject(new ResourceLifecycleError(`streamed load "${id}" was cancelled`));
      return true;
    }
    // In flight: the registry aborts it; the load still runs to completion, disposes its output
    // and fails the entry with a cancellation error, which we classify as "cancelled" below.
    return this.registry.cancelLoad(id);
  }

  /**
   * Wait until the queue is empty and every admitted load has settled. Each iteration simulates
   * a frame (`newFrame()` + `pump()`), so a queue that does not fit one frame's budget still
   * drains. Assumes the underlying loads settle — a hanging load hangs this.
   */
  async settle(): Promise<void> {
    while (this.queue.length > 0 || this.inFlight > 0) {
      this.newFrame();
      this.pump();
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  stats(): StreamingStats {
    return {
      queued: this.queue.length,
      inFlight: this.inFlight,
      ready: this.readyCount,
      failed: this.failedCount,
      cancelled: this.cancelledCount,
      budgetBytes: this.uploadBudgetBytes,
      budgetRemaining: Math.max(0, this.budgetRemaining),
      bytesAdmittedThisFrame: this.bytesAdmittedThisFrame,
      deferredForBudget: this.deferredForBudget,
    };
  }

  /** Drop queued loads (rejected as cancelled) and forget the load table; in-flight loads are
   * finished by the registry's own disposal. After this the streamer is unusable. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const load of this.queue) {
      this.settleLoad(load, "cancelled");
      load.reject(new ResourceLifecycleError("AssetStreamer was disposed"));
    }
    this.queue.length = 0;
    this.loads.clear();
  }

  // ---------------------------------------------------------------- internals

  private createPending<T>(descriptor: ResourceDescriptor<T>): PendingLoad<T> {
    const load: PendingLoad<T> = {
      descriptor,
      priority: descriptor.priority ?? 0,
      seq: this.seq++,
      state: "queued",
      handle: null,
      cancelledByUser: false,
      promise: null as unknown as Promise<T>,
      resolve: () => undefined,
      reject: () => undefined,
    };
    load.promise = new Promise<T>((resolve, reject) => {
      load.resolve = resolve;
      load.reject = reject;
    });
    // Readiness is observed through `promise`/`state`; a request nobody awaits must not surface
    // as an unhandled rejection.
    load.promise.catch(() => undefined);
    this.loads.set(descriptor.id, load as PendingLoad<unknown>);
    return load;
  }

  private admit<T>(load: PendingLoad<T>, chargeBudget: boolean): void {
    load.state = "loading";
    load.handle = this.registry.acquire(load.descriptor);
    if (chargeBudget && this.uploadBudgetBytes > 0) {
      const est = Math.max(0, load.descriptor.estimatedBytes ?? 0);
      this.budgetRemaining -= est;
      this.bytesAdmittedThisFrame += est;
    }
    const readiness = load.handle.wait();
    // Entry already ready (fast path): settle *synchronously* so the caller observes
    // state === "ready" without waiting a microtask, and the lease is released before the
    // caller's continuation runs.
    if (load.handle.ready) this.finishLoad(load, "ready", load.handle.value, null);
    readiness.then(
      (value) => this.finishLoad(load, "ready", value, null),
      (error: unknown) =>
        this.finishLoad(load, load.cancelledByUser ? "cancelled" : "failed", null, error),
    );
  }

  /**
   * Settle a load exactly once: state → stats → release the streamer's lease → resolve/reject.
   * The release must happen before the promise settles — a microtask-later release (a separate
   * `.finally`) would run after the caller's `await` continuation, and `handle()` would still
   * be non-null there.
   */
  private finishLoad<T>(load: PendingLoad<T>, state: "ready" | "failed" | "cancelled", value: T | null, error: unknown): void {
    if (load.state !== "loading") return; // already settled (fast path, cancel, or dispose)
    this.settleLoad(load, state);
    load.handle?.release();
    load.handle = null;
    if (state === "ready") load.resolve(value as T);
    else load.reject(error ?? new ResourceLifecycleError(`streamed load "${load.descriptor.id}" was ${state}`));
  }

  private settleLoad<T>(load: PendingLoad<T>, state: "ready" | "failed" | "cancelled"): void {
    if (load.state === "ready" || load.state === "failed" || load.state === "cancelled") return;
    load.state = state;
    if (state === "ready") this.readyCount++;
    else if (state === "failed") this.failedCount++;
    else this.cancelledCount++;
    if (state !== "ready") {
      this.logger?.debug(`stream ${load.descriptor.id}: ${state}`);
    }
  }

  /** Higher priority first; FIFO (seq) inside a priority. */
  private better(a: PendingLoad<unknown>, b: PendingLoad<unknown>): boolean {
    return a.priority > b.priority || (a.priority === b.priority && a.seq < b.seq);
  }

  private view<T>(load: PendingLoad<T>): StreamedLoad<T> {
    return {
      id: load.descriptor.id,
      priority: load.priority,
      get state() {
        return load.state;
      },
      promise: load.promise,
      cancel: () => this.cancel(load.descriptor.id),
      handle: () => load.handle,
    };
  }
}
