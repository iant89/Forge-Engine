/**
 * Double-buffered asset replacement (Phase 15.4).
 *
 * A reload is deliberately not `ResourceRegistry.retry()`: retry is useful for a failed load, but
 * it replaces a ready value in place before the new bytes have loaded. This coordinator stages a
 * fresh value through `AssetStreamer` under a private temporary id, validates it, and commits it
 * synchronously into the existing registry entry. The optional `swap` callback repoints live
 * consumers (renderables/material maps/etc.) while the old GPU object is still valid; only then is
 * the previous value disposed. A failed or cancelled stage leaves the active resource untouched.
 */

import { ResourceLifecycleError, UsageError } from "../core/errors.js";
import { ResourceRegistry, type DetachedResource, type ResourceDescriptor } from "./registry.js";
import { AssetStreamer, type StreamedLoad } from "./streaming.js";

/** Default reload priority: user-visible edits should outrank background prefetches. */
export const HOT_RELOAD_PRIORITY = 1_000_000;

export interface HotReloadOptions<T> {
  /** Overrides the default high priority; the streamer still applies concurrency and byte budgets. */
  priority?: number;
  /**
   * Synchronously repoint every live consumer from `previous` to `replacement`. Runs before the
   * registry value changes and before `previous` is disposed. Must not yield or retain a frame-local
   * view into the old resource.
   */
  swap?: (previous: T, replacement: T) => void;
}

export interface HotReloadResult<T> {
  id: string;
  value: T;
  oldBytes: number;
  newBytes: number;
  /** Loaded transitive dependents whose old values may need reloading/rebinding. */
  dependents: string[];
  oldHash?: string;
  newHash?: string;
}

interface PendingReload<T> {
  signature: string | undefined;
  stageId: string | null;
  stream: StreamedLoad<T> | null;
  cancelled: boolean;
  promise: Promise<HotReloadResult<T>>;
}

export class AssetHotReloader {
  private readonly pending = new Map<string, PendingReload<unknown>>();
  private nextStage = 1;
  private disposed = false;

  constructor(
    readonly registry: ResourceRegistry,
    readonly streamer: AssetStreamer,
  ) {
    if (streamer.registry !== registry) throw new UsageError("AssetHotReloader and AssetStreamer must use the same ResourceRegistry");
  }

  /**
   * Stage and atomically replace one ready resource. If the same id/hash is already reloading, the
   * in-flight promise is shared. A different content hash is serialized after the current edit so
   * an older network response can never win over a newer edit.
   */
  reload<T>(descriptor: ResourceDescriptor<T>, options: HotReloadOptions<T> = {}): Promise<HotReloadResult<T>> {
    if (this.disposed) return Promise.reject(new ResourceLifecycleError("AssetHotReloader was disposed"));
    if (!descriptor.id || !descriptor.kind) return Promise.reject(new UsageError("hot reload requires a non-empty id and kind"));
    const current = this.pending.get(descriptor.id) as PendingReload<T> | undefined;
    if (current) {
      if (current.signature === descriptor.contentHash) return current.promise;
      return current.promise.catch(() => undefined).then(() => this.reload(descriptor, options));
    }

    let pending!: PendingReload<T>;
    const promise = Promise.resolve()
      .then(() => this.perform(descriptor, options, pending))
      .finally(() => {
        if (this.pending.get(descriptor.id) === pending) this.pending.delete(descriptor.id);
      });
    pending = {
      signature: descriptor.contentHash,
      stageId: null,
      stream: null,
      cancelled: false,
      promise,
    };
    this.pending.set(descriptor.id, pending as PendingReload<unknown>);
    // A reload nobody awaits must not surface as an unhandled rejection; the returned promise
    // remains rejecting for its owner.
    promise.catch(() => undefined);
    return promise;
  }

  /** Cancel a queued or in-flight replacement. The currently live value remains usable. */
  cancel(id: string): boolean {
    const pending = this.pending.get(id);
    if (!pending || pending.cancelled) return false;
    pending.cancelled = true;
    if (!pending.stream) return true;
    return pending.stream.cancel();
  }

  /** Active reload count, for an editor's progress/status panel. */
  get inFlight(): number {
    return this.pending.size;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const id of this.pending.keys()) this.cancel(id);
  }

  private async perform<T>(descriptor: ResourceDescriptor<T>, options: HotReloadOptions<T>, pending: PendingReload<T>): Promise<HotReloadResult<T>> {
    if (this.disposed || pending.cancelled) throw new ResourceLifecycleError(`hot reload "${descriptor.id}" was cancelled`);
    const previousDescriptor = this.registry.descriptorOf<T>(descriptor.id);
    const live = this.registry.retain<T>(descriptor.id);
    if (!live || !previousDescriptor) throw new UsageError(`cannot hot reload "${descriptor.id}": it is not currently ready`);

    const stageId = `__forge_reload__:${this.nextStage++}:${descriptor.id}`;
    pending.stageId = stageId;
    const stageDescriptor: ResourceDescriptor<T> = {
      ...descriptor,
      id: stageId,
      // Graph edges are committed against the real id by `registry.replace`, not the staging key.
      dependencies: undefined,
      contentHash: undefined,
      priority: options.priority ?? HOT_RELOAD_PRIORITY,
      load: descriptor.load,
    };
    let stream: StreamedLoad<T>;
    try {
      stream = this.streamer.request(stageDescriptor);
    } catch (error) {
      live.release();
      throw error;
    }
    pending.stream = stream;
    if (pending.cancelled || this.disposed) stream.cancel();

    let detached: DetachedResource<T> | null = null;
    try {
      await stream.promise;
      if (pending.cancelled || this.disposed) throw new ResourceLifecycleError(`hot reload "${descriptor.id}" was cancelled`);
      detached = this.registry.detach<T>(stageId);
      if (!detached) throw new ResourceLifecycleError(`hot reload "${descriptor.id}" finished without a transferable staged value`);
      const previous = live.value;
      const oldBytes = previousDescriptor.bytes ? Math.max(0, previousDescriptor.bytes(previous)) : 0;
      const newBytes = detached.bytes;
      const value = this.registry.replace(descriptor.id, descriptor, detached, live, options.swap);
      return {
        id: descriptor.id,
        value,
        oldBytes,
        newBytes,
        dependents: this.registry.dependentsOf(descriptor.id),
        oldHash: previousDescriptor.contentHash,
        newHash: descriptor.contentHash,
      };
    } catch (error) {
      if (detached?.active) detached.dispose();
      this.registry.evict(stageId);
      throw error;
    } finally {
      live.release();
      pending.stream = null;
    }
  }
}
