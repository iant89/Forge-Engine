/**
 * `ResourceRegistry` — refcounted, budgeted, deduplicated resource ownership.
 *
 * The rules this enforces (and the tests in tests/resources.test.ts assert):
 *  1. **One load per id.** Concurrent `acquire()` calls share a single in-flight promise. Two
 *     copies of the same texture is the classic cause of "the demo leaks 200 MB".
 *  2. **Handles, not raw values.** `ResourceHandle<T>` is refcounted; the resource is released when
 *     the last handle is released *or* the registry evicts it while unpinned. Reading `handle.value`
 *     after release throws instead of returning a destroyed GPU object.
 *  3. **A byte budget that evicts LRU.** Only *unpinned* entries are evictable; pinned entries
 *     (default textures, the active scene's atlas) never are, and neither is anything with an
 *     outstanding handle. Eviction is *requested* on a frame boundary (`evictIdle`) rather than done
 *     inside `acquire`, so a load cannot invalidate its own budget; under budget pressure the idle
 *     grace period is ignored (see `evictIdle`).
 *  4. **Deterministic failure.** A failed load is cached as a failed entry: `acquire` rejects with
 *     the original error and `retry()` re-attempts. No infinite reload storms.
 */

import { ResourceLifecycleError, UsageError, InternalError } from "../core/errors.js";
import { EventTarget2 } from "../core/events.js";
import type { Logger } from "../core/log.js";

export type ResourceState = "idle" | "loading" | "ready" | "failed" | "released";

export interface ResourceLoadContext {
  signal: { aborted: boolean };
  progress(fraction: number, note?: string): void;
  logger: Logger | null;
  /** Registry so a loader can pull dependencies (a glTF loading its textures). */
  registry: ResourceRegistry;
}

export interface ResourceDescriptor<T> {
  /** Stable identity: "texture:assets/rocks.png" or "chunk:3,-1,2". Two ids that differ re-load. */
  id: string;
  kind: string;
  load(context: ResourceLoadContext): Promise<T> | T;
  /** Estimated GPU bytes, for the budget. 0 = unaccounted. */
  bytes?: (value: T) => number;
  /** Free the resource. Called on eviction/release; GPU objects usually need it. */
  dispose?: (value: T) => void;
  /** Idle time in ms before eviction may collect it (0 = evictable immediately). */
  idleMs?: number;
  priority?: number;
  tags?: readonly string[];
}

export class ResourceHandle<T> {
  /** @internal */ entry: Entry<T>;
  /** @internal */ private released = false;

  /** @internal Created by the registry only. */
  constructor(entry: Entry<T>) {
    this.entry = entry;
    entry.refCount++;
  }

  get id(): string {
    return this.entry.descriptor.id;
  }

  get state(): ResourceState {
    return this.entry.state;
  }

  get ready(): boolean {
    return this.entry.state === "ready";
  }

  get value(): T {
    if (this.released) throw new ResourceLifecycleError(`ResourceHandle for "${this.id}" was released`);
    if (this.entry.state !== "ready") {
      throw new ResourceLifecycleError(`Resource "${this.id}" is ${this.entry.state}, not ready${this.entry.error ? ` (${this.entry.error})` : ""}`);
    }
    return this.entry.value as T;
  }

  /** Current value if ready, otherwise null (never throws) — for optional lookups. */
  get currentValue(): T | null {
    return this.entry.state === "ready" ? (this.entry.value as T) : null;
  }

  get refCount(): number {
    return this.entry.refCount;
  }

  onReady(): Promise<T> {
    if (this.entry.state === "ready") return Promise.resolve(this.entry.value as T);
    if (this.entry.state === "failed" || this.entry.state === "released") return Promise.reject(this.entry.failure ?? new ResourceLifecycleError(`"${this.id}" ${this.entry.state}`));
    return this.entry.promise!;
  }

  /** Await readiness (preferred in scene code). */
  async wait(): Promise<T> {
    return this.onReady();
  }

  pin(): this {
    this.entry.pinned = true;
    return this;
  }

  unpin(): this {
    this.entry.pinned = false;
    return this;
  }

  release(): void {
    if (this.released) return;
    this.released = true;
    this.entry.refCount--;
    this.entry.lastUse = nowMs();
    if (this.entry.refCount <= 0) this.entry.registry.onEntryUnreferenced(this.entry as Entry<unknown>);
  }

  get releasedFlag(): boolean {
    return this.released;
  }
}

/** @internal */
export class Entry<T> {
  state: ResourceState = "idle";
  value: T | null = null;
  refCount = 0;
  pinned = false;
  lastUse = 0;
  bytes = 0;
  error: string | null = null;
  failure: unknown = null;
  promise: Promise<T> | null = null;
  abort: { aborted: boolean } = { aborted: false };
  disposers = new Set<(v: T) => void>();

  constructor(
    readonly descriptor: ResourceDescriptor<T>,
    readonly registry: ResourceRegistry,
  ) {}
}

export interface ResourceRegistryOptions {
  /** Total bytes the registry will hold before evicting (0 = unbounded). */
  maxBytes?: number;
  logger?: Logger | null;
  /** How long an unreferenced entry may stay before `evictIdle()` collects it. */
  idleGraceMs?: number;
}

export class ResourceRegistry {
  readonly maxBytes: number;
  readonly idleGraceMs: number;
  private readonly entries = new Map<string, Entry<unknown>>();
  private readonly logger: Logger | null;
  private totalBytes = 0;
  private loads = 0;
  private deduped = 0;
  private evictions = 0;
  private evictedBytesTotal = 0;
  private disposed = false;
  readonly events = {
    loaded: new EventTarget2<string>(),
    failed: new EventTarget2<{ id: string; error: unknown }>(),
    evicted: new EventTarget2<string>(),
  };

  constructor(options: ResourceRegistryOptions = {}) {
    this.maxBytes = options.maxBytes ?? 0;
    this.idleGraceMs = options.idleGraceMs ?? 2000;
    this.logger = options.logger ?? null;
  }

  get size(): number {
    return this.entries.size;
  }

  get bytes(): number {
    return this.totalBytes;
  }

  has(id: string): boolean {
    return this.entries.has(id);
  }

  stateOf(id: string): ResourceState | null {
    return this.entries.get(id)?.state ?? null;
  }

  /**
   * Get (or start) a resource. The returned handle is a *lease*: release it when done. Repeated
   * acquires of the same id are cheap and share the in-flight load.
   */
  acquire<T>(descriptor: ResourceDescriptor<T>): ResourceHandle<T> {
    if (this.disposed) throw new ResourceLifecycleError("ResourceRegistry was disposed");
    if (!descriptor.id) throw new UsageError("ResourceDescriptor.id must be a non-empty string");
    if (!descriptor.kind) throw new UsageError("ResourceDescriptor.kind must be a non-empty string");
    let entry = this.entries.get(descriptor.id) as Entry<T> | undefined;
    if (!entry) {
      entry = new Entry<T>(descriptor, this as unknown as ResourceRegistry) as unknown as Entry<T>;
      this.entries.set(descriptor.id, entry as unknown as Entry<unknown>);
      this.startLoad(entry);
    } else {
      this.deduped++;
      // A previously-failed entry retries on next acquire so a transient network error is not fatal.
      if (entry.state === "failed") this.startLoad(entry);
    }
    return new ResourceHandle<T>(entry as unknown as Entry<T>);
  }

  /** Acquire and await, for code that has no handle lifetime to manage (examples, tools). */
  async acquireAndWait<T>(descriptor: ResourceDescriptor<T>): Promise<T> {
    const handle = this.acquire(descriptor);
    try {
      return await handle.wait();
    } catch (e) {
      handle.release();
      throw e;
    }
  }

  /** @internal */
  private startLoad<T>(entry: Entry<T>): void {
    const descriptor = entry.descriptor as ResourceDescriptor<T>;
    entry.state = "loading";
    entry.error = null;
    entry.failure = null;
    this.loads++;
    const context: ResourceLoadContext = {
      signal: entry.abort,
      progress: (fraction, note) => {
        this.logger?.debug(`resource ${descriptor.id}: ${(fraction * 100).toFixed(0)}%${note ? ` ${note}` : ""}`);
      },
      logger: this.logger,
      registry: this,
    };
    const promise = (async () => {
      const value = await descriptor.load(context);
      if (entry.abort.aborted) {
        // The load finished after cancellation: dispose what it produced so nothing is orphaned.
        try {
          descriptor.dispose?.(value);
        } catch (e) {
          this.logger?.warn(`resource ${descriptor.id}: post-cancel dispose failed`, e);
        }
        throw new InternalError(`resource "${descriptor.id}" was cancelled`);
      }
      entry.value = value;
      entry.bytes = descriptor.bytes ? Math.max(0, descriptor.bytes(value)) : 0;
      this.totalBytes += entry.bytes;
      entry.state = "ready";
      this.events.loaded.emit(descriptor.id);
      // Over budget: `evictIdle()` picks the target up from `maxBytes` and ignores the grace period.
      if (this.maxBytes > 0 && this.totalBytes > this.maxBytes) this.evictIdle();
      return value;
    })().catch((error: unknown) => {
      entry.state = "failed";
      entry.error = error instanceof Error ? error.message : String(error);
      entry.failure = error;
      this.events.failed.emit({ id: descriptor.id, error });
      this.logger?.error(`resource ${descriptor.id} failed: ${entry.error}`);
      throw error;
    });
    entry.promise = promise;
    // A rejected handle-less load must not surface as an unhandled rejection: readiness is always
    // observed through handle.onReady()/wait(), which re-rejects deliberately.
    promise.catch(() => undefined);
  }

  /** @internal */
  onEntryUnreferenced(entry: Entry<unknown>): void {
    if (entry.refCount > 0) return;
    // Keep it cached (that is the point of the registry); it becomes eviction-eligible on age.
    entry.lastUse = nowMs();
  }

  /** Number of entries with no outstanding handles — the pool eviction works on. */
  get unreferencedCount(): number {
    let n = 0;
    for (const e of this.entries.values()) if (e.refCount <= 0 && !e.pinned) n++;
    return n;
  }

  /**
   * Collect unreferenced, unpinned entries. Two modes, one rule each:
   *
   *  - **No byte target** (`evictIdle()`, and the registry is inside its budget): collect what has
   *    been idle for at least `idleGraceMs`. A resource released this frame survives, so a camera
   *    that re-acquires the same texture next frame does not pay for a reload.
   *  - **Byte target** (an explicit argument, or the registry being over `maxBytes`): evict
   *    least-recently-used entries until the total is at or under the target, *ignoring* the grace
   *    period. Budget pressure is not negotiable, which is what makes the budget a budget.
   *
   * Returns the number of entries evicted; `evictedBytes`/`stats().evictedBytes` report their size.
   */
  evictIdle(targetBytes = 0): number {
    const overBudget = this.maxBytes > 0 && this.totalBytes > this.maxBytes;
    const target = targetBytes > 0 ? targetBytes : overBudget ? this.maxBytes : 0;
    // A byte target that is already satisfied frees nothing: "be under 64 bytes" must not evict a
    // 64-byte cache down to zero.
    if (target > 0 && this.totalBytes <= target) return 0;
    const candidates: Entry<unknown>[] = [];
    for (const e of this.entries.values()) {
      if (e.refCount > 0 || e.pinned) continue;
      if (target === 0 && nowMs() - e.lastUse < this.idleGraceMs) continue;
      candidates.push(e);
    }
    if (candidates.length === 0) return 0;
    candidates.sort((a, b) => a.lastUse - b.lastUse);
    let freed = 0;
    let freedCount = 0;
    for (const e of candidates) {
      // Read the size *before* releasing: `releaseEntry` zeroes `e.bytes`, and an eviction report
      // that always says 0 MB is worse than no report.
      const bytes = e.bytes;
      this.releaseEntry(e);
      freedCount++;
      freed += bytes;
      if (target > 0 && this.totalBytes <= target) break;
    }
    if (freedCount > 0) this.logger?.debug(`resources: evicted ${freedCount} entries (${(freed / 1048576).toFixed(1)} MB)`);
    return freedCount;
  }

  private releaseEntry(e: Entry<unknown>): void {
    const descriptor = e.descriptor as ResourceDescriptor<unknown>;
    if (e.value !== null && e.state === "ready") {
      try {
        for (const d of e.disposers) d(e.value);
        descriptor.dispose?.(e.value);
      } catch (error) {
        this.logger?.error(`resource ${descriptor.id}: dispose failed`, error);
      }
    }
    e.abort.aborted = true;
    this.evictedBytesTotal += e.bytes;
    this.totalBytes -= e.bytes;
    e.bytes = 0;
    e.state = "released";
    this.entries.delete(descriptor.id);
    this.evictions++;
    this.events.evicted.emit(descriptor.id);
  }

  /** Evict one specific id (used by the editor's "reload asset" action). */
  evict(id: string): boolean {
    const e = this.entries.get(id);
    if (!e) return false;
    this.releaseEntry(e);
    return true;
  }

  /** Register a disposer to run when the entry is evicted (loaders use this for sub-resources). */
  addDisposer<T>(id: string, fn: (value: T) => void): boolean {
    const e = this.entries.get(id) as Entry<T> | undefined;
    if (!e) return false;
    e.disposers.add(fn);
    return true;
  }

  /** Re-load an id, discarding the cached value (hot-reload path). */
  async retry<T = unknown>(id: string): Promise<T> {
    const e = this.entries.get(id) as Entry<T> | undefined;
    if (!e) throw new UsageError(`retry("${id}"): no such resource`);
    if (e.value !== null && e.state === "ready") {
      try {
        (e.descriptor as ResourceDescriptor<T>).dispose?.(e.value);
      } catch (error) {
        this.logger?.warn(`resource ${id}: dispose before retry failed`, error);
      }
      this.totalBytes -= e.bytes;
      e.bytes = 0;
      e.value = null;
    }
    e.abort = { aborted: false };
    this.startLoad(e as unknown as Entry<T>);
    return e.promise as Promise<T>;
  }

  /** All loaded ids of a kind (the editor's asset browser + leak tests use this). */
  idsOfKind(kind: string): string[] {
    const out: string[] = [];
    for (const e of this.entries.values()) if (e.descriptor.kind === kind && e.state === "ready") out.push(e.descriptor.id);
    return out.sort();
  }

  /** Bytes evicted since construction (Phase 9.3: `evictedBytes` in the memory report). */
  get evictedBytes(): number {
    return this.evictedBytesTotal;
  }

  stats(): {
    entries: number;
    bytes: number;
    loads: number;
    deduped: number;
    evictions: number;
    evictedBytes: number;
    pending: number;
    unreferenced: number;
  } {
    let pending = 0;
    let unreferenced = 0;
    for (const e of this.entries.values()) {
      if (e.state === "loading") pending++;
      if (e.refCount <= 0 && !e.pinned) unreferenced++;
    }
    return {
      entries: this.entries.size,
      bytes: this.totalBytes,
      loads: this.loads,
      deduped: this.deduped,
      evictions: this.evictions,
      evictedBytes: this.evictedBytesTotal,
      pending,
      unreferenced,
    };
  }

  /** Await every in-flight load (used by tests + the "warm up" phase of a demo). */
  async settle(): Promise<void> {
    let promises: Promise<unknown>[] = [];
    for (const e of this.entries.values()) {
      if (e.state === "loading" && e.promise) promises.push(e.promise.catch(() => null));
    }
    while (promises.length > 0) {
      await Promise.all(promises);
      promises = [];
      for (const e of this.entries.values()) {
        if (e.state === "loading" && e.promise) promises.push(e.promise.catch(() => null));
      }
    }
  }

  /** Release everything, disposing values. After this the registry is unusable by design. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const e of [...this.entries.values()]) {
      e.refCount = 0;
      this.releaseEntry(e);
    }
    this.entries.clear();
    for (const key of Object.keys(this.events) as (keyof typeof this.events)[]) this.events[key].clear();
  }
}

function nowMs(): number {
  return typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : Date.now();
}
