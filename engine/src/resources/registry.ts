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
 *  5. **Content-hash invalidation (Phase 15.1).** A descriptor may carry the SHA-256 of its bytes
 *     (`contentHash`). Re-acquiring the same id with a *different* hash means the file changed
 *     under a stable path id: the cached entry is released and re-loaded, and `contentChanged`
 *     names the transitive dependents that now hold stale values.
 *  6. **Dependency graph safety (Phase 15.2).** A descriptor may declare its dependencies
 *     (`dependencies(value)`); the edges are registered when the load lands. A loaded dependent
 *     blocks eviction of its dependencies, `invalidate()` reports who must reload when an asset
 *     changes, and cycles are rejected at registration time (`AssetGraph.link`). The graph is
 *     metadata + safety, not a load scheduler: loaders pull their own deps through
 *     `context.registry`, and load orchestration is Phase 15.3.
 *  7. **Cancellation (Phase 15.3).** `cancelLoad(id)` sets the in-flight entry's abort flag:
 *     when the load finishes after that, its produced value is disposed and the entry fails
 *     with a cancellation error. `AssetStreamer` classifies the rejection as `cancelled`; a
 *     later `acquire` retries like any failed entry.
 */

import { ResourceLifecycleError, UsageError, InternalError } from "../core/errors.js";
import { EventTarget2 } from "../core/events.js";
import type { Logger } from "../core/log.js";
import { AssetGraph } from "./assetGraph.js";
import { AssetId, type AssetIdInfo } from "./assetId.js";
import { AssetValidationError, type AssetDiagnostic } from "./validation.js";

export type ResourceState = "idle" | "loading" | "ready" | "failed" | "released";

export interface ResourceLoadContext {
  signal: { aborted: boolean };
  progress(fraction: number, note?: string): void;
  logger: Logger | null;
  /** Registry so a loader can pull dependencies (a glTF loading its textures). */
  registry: ResourceRegistry;
}

export interface ResourceDescriptor<T> {
  /**
   * Stable identity: "texture:assets/rocks.png" or "chunk:3,-1,2". Two ids that differ re-load.
   * Canonical ids follow the `AssetId` form (`kind:…`); bare legacy ids stay legal but carry no
   * metadata.
   */
  id: string;
  kind: string;
  load(context: ResourceLoadContext): Promise<T> | T;
  /** Estimated GPU bytes, for the budget. 0 = unaccounted. */
  bytes?: (value: T) => number;
  /**
   * Phase 15.3: estimated GPU bytes this load will upload, known *before* the load.
   * `AssetStreamer` charges this against the per-frame upload budget at admission time.
   * Unlike `bytes(value)` (accounted *after* the load, for the eviction budget), this must be
   * a conservative pre-estimate — a texture's full mip-chain size, say. 0/undefined = not
   * budgeted (always admitted when the concurrency cap allows).
   */
  estimatedBytes?: number;
  /** Free the resource. Called on eviction/release; GPU objects usually need it. */
  dispose?: (value: T) => void;
  /** Idle time in ms before eviction may collect it (0 = evictable immediately). */
  idleMs?: number;
  priority?: number;
  tags?: readonly string[];
  /**
   * Phase 15.1: SHA-256 hex of the resource's bytes (see `hashContent`), when the loader knows
   * it. Must describe the *content at `id`*, not the load attempt. Re-acquiring `id` with a
   * different hash releases the cached value and re-loads, emitting `contentChanged` with the
   * transitive dependents that now hold stale values.
   */
  contentHash?: string;
  /**
   * Phase 15.2: the ids this resource depends on, reported once the value exists (a glTF only
   * knows its textures after parsing). Used for eviction safety, `invalidate()` propagation and
   * graph queries — not for scheduling: the loader still pulls its own deps through
   * `context.registry`. Edges that would close a cycle are rejected with a logged error.
   */
  dependencies?: (value: T) => readonly string[];
  /**
   * Phase 15.5: validate decoded output before it becomes visible to consumers. Warnings are
   * logged; any error diagnostic rejects the load and disposes the output.
   */
  validate?: (value: T) => readonly AssetDiagnostic[];
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
    descriptor: ResourceDescriptor<T>,
    readonly registry: ResourceRegistry,
  ) {
    this.descriptor = descriptor;
  }

  descriptor: ResourceDescriptor<T>;
}

/**
 * A ready resource whose registry entry has been detached without disposing its value. This is
 * used only for double-buffered hot reload: the new value is staged first, then adopted into the
 * existing entry after all live references have been switched.
 */
export class DetachedResource<T> {
  private owned = true;

  constructor(
    /** @internal Registry which detached this value; prevents cross-registry adoption. */
    readonly owner: ResourceRegistry,
    readonly descriptor: ResourceDescriptor<T>,
    readonly value: T,
    readonly bytes: number,
    /** @internal Disposers captured from the detached entry and adopted with its value. */
    readonly disposers: Set<(value: T) => void>,
    private readonly disposeDetached: () => void,
  ) {}

  get active(): boolean {
    return this.owned;
  }

  /** @internal Transfer ownership into a live registry entry. */
  adopt(): void {
    if (!this.owned) throw new ResourceLifecycleError(`Detached resource "${this.descriptor.id}" is no longer owned`);
    this.owned = false;
  }

  /** Dispose a staged value that was rejected or cancelled before adoption. */
  dispose(): void {
    if (!this.owned) return;
    this.owned = false;
    this.disposeDetached();
  }
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
  private readonly graph = new AssetGraph();
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
    /** Phase 15.1: same id, different `contentHash` on re-acquire — the value was replaced. */
    contentChanged: new EventTarget2<{ id: string; oldHash: string; newHash: string; dependents: string[] }>(),
    /** Phase 15.2: an asset was invalidated/evicted; `dependents` is the transitive reload list. */
    invalidated: new EventTarget2<{ id: string; dependents: string[]; reason: string }>(),
    /** Phase 15.4: a staged replacement was committed without exposing a disposed old value. */
    reloaded: new EventTarget2<{ id: string; kind: string; oldHash?: string; newHash?: string; dependents: string[] }>(),
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
    // Phase 15.1: the same path id now carries different bytes — the cached value is stale by
    // definition. Release it, announce which loaded dependents hold it, and load fresh. Handles
    // still pointing at the old entry are stale too (`.value` throws; re-acquire for the new
    // bytes). An in-flight load is left alone: swapping a descriptor mid-load is a Phase 15.3
    // concern.
    const existing = this.entries.get(descriptor.id) as Entry<unknown> | undefined;
    if (
      existing !== undefined &&
      existing.state === "ready" &&
      descriptor.contentHash !== undefined &&
      existing.descriptor.contentHash !== undefined &&
      descriptor.contentHash !== existing.descriptor.contentHash
    ) {
      const dependents = this.graph.transitive(descriptor.id, "dependents");
      this.releaseEntry(existing);
      this.events.contentChanged.emit({
        id: descriptor.id,
        oldHash: existing.descriptor.contentHash,
        newHash: descriptor.contentHash,
        dependents,
      });
    }
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

  /**
   * Phase 15.3: abort an in-flight load. The load still runs to completion, but its output is
   * disposed and the entry fails with a cancellation error; the next `acquire` retries (the
   * standard failed-entry behavior). Returns false when the id is not currently loading.
   */
  cancelLoad(id: string): boolean {
    const e = this.entries.get(id);
    if (!e || e.state !== "loading") return false;
    e.abort.aborted = true;
    return true;
  }

  /** @internal */
  private startLoad<T>(entry: Entry<T>): void {
    const descriptor = entry.descriptor as ResourceDescriptor<T>;
    // Every attempt gets a fresh abort signal: a previously-cancelled attempt (`cancelLoad`)
    // must not taint the retry this call is starting — the post-completion check below would
    // otherwise discard a perfectly good re-load as "cancelled".
    entry.abort = { aborted: false };
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
      let valueOwned = true;
      try {
        if (entry.abort.aborted) throw new InternalError(`resource "${descriptor.id}" was cancelled`);
        if (descriptor.validate) {
          const diagnostics = descriptor.validate(value) ?? [];
          for (const diagnostic of diagnostics) {
            if (diagnostic.severity === "warning") this.logger?.warn(`resource ${descriptor.id}: ${diagnostic.code}: ${diagnostic.message}`);
          }
          if (diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
            throw new AssetValidationError(descriptor.id, diagnostics);
          }
        }
        entry.value = value;
        entry.bytes = descriptor.bytes ? Math.max(0, descriptor.bytes(value)) : 0;
        this.totalBytes += entry.bytes;
        this.registerDependencies(entry, value);
        entry.state = "ready";
        valueOwned = false;
        this.events.loaded.emit(descriptor.id);
        // Over budget: `evictIdle()` picks the target up from `maxBytes` and ignores the grace period.
        if (this.maxBytes > 0 && this.totalBytes > this.maxBytes) this.evictIdle();
        return value;
      } catch (error) {
        if (valueOwned) this.disposeValue(descriptor, value, entry.disposers, `resource ${descriptor.id}: rejected output dispose failed`);
        throw error;
      }
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

  /**
   * @internal Phase 15.2: record (or re-record, after `retry`) the edges a loaded value declares.
   * A callback that throws or an edge that would close a cycle logs an error and registers no
   * edges — metadata failure must never break the resource itself.
   */
  private registerDependencies<T>(entry: Entry<T>, value: T): void {
    const descriptor = entry.descriptor as ResourceDescriptor<T>;
    if (descriptor.dependencies === undefined) return;
    let declared: readonly string[];
    try {
      declared = descriptor.dependencies(value) ?? [];
    } catch (error) {
      this.logger?.error(`resource ${descriptor.id}: dependencies() threw; no edges registered`, error);
      return;
    }
    const deps = [...new Set(declared)].filter((d) => typeof d === "string" && d.length > 0 && d !== descriptor.id);
    let cycle: string | null = null;
    for (const d of deps) {
      cycle = this.graph.wouldCycle(descriptor.id, d);
      if (cycle !== null) break;
    }
    if (cycle !== null) {
      this.logger?.error(`resource ${descriptor.id}: dependency cycle (${cycle}); no edges registered`);
      return;
    }
    // Retry path: replace, don't accumulate, stale edges.
    this.graph.unlink(descriptor.id);
    for (const d of deps) this.graph.link(descriptor.id, d);
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
   *  **Dependency safety (Phase 15.2):** an entry with a *loaded* dependent is never a candidate —
   *  the dependent's value may embed it without holding a registry handle (a material keeps its
   *  textures). Evicting the dependent in the same call unblocks its dependencies, so the scan
   *  cascades until a pass frees nothing: a whole dependency chain leaves in one `evictIdle`.
   *
   * Returns the number of entries evicted; `evictedBytes`/`stats().evictedBytes` report their size.
   */
  evictIdle(targetBytes = 0): number {
    const overBudget = this.maxBytes > 0 && this.totalBytes > this.maxBytes;
    const target = targetBytes > 0 ? targetBytes : overBudget ? this.maxBytes : 0;
    // A byte target that is already satisfied frees nothing: "be under 64 bytes" must not evict a
    // 64-byte cache down to zero.
    if (target > 0 && this.totalBytes <= target) return 0;
    let freed = 0;
    let freedCount = 0;
    // Each pass evicts at least one entry (or the loop stops), so ≤ entries.size passes. The
    // bound is captured up front: evicting shrinks `entries.size`, and a live bound would end
    // the loop one pass too early on exactly-sized chains.
    const maxPasses = this.entries.size;
    for (let pass = 0; pass <= maxPasses; pass++) {
      const candidates: Entry<unknown>[] = [];
      for (const e of this.entries.values()) {
        if (e.refCount > 0 || e.pinned) continue;
        if (this.hasLoadedDependents(e.descriptor.id)) continue;
        if (target === 0 && nowMs() - e.lastUse < this.idleGraceMs) continue;
        candidates.push(e);
      }
      if (candidates.length === 0) break;
      candidates.sort((a, b) => a.lastUse - b.lastUse);
      let progress = false;
      for (const e of candidates) {
        // Read the size *before* releasing: `releaseEntry` zeroes `e.bytes`, and an eviction
        // report that always says 0 MB is worse than no report.
        const bytes = e.bytes;
        this.releaseEntry(e);
        freedCount++;
        freed += bytes;
        progress = true;
        if (target > 0 && this.totalBytes <= target) break;
      }
      if (!progress || (target > 0 && this.totalBytes <= target)) break;
    }
    if (freedCount > 0) this.logger?.debug(`resources: evicted ${freedCount} entries (${(freed / 1048576).toFixed(1)} MB)`);
    return freedCount;
  }

  /** Phase 15.2: `id` may not be evicted while any dependent is still loaded (see `evictIdle`). */
  private hasLoadedDependents(id: string): boolean {
    return this.graph.dependentsOf(id).some((dependent) => this.entries.has(dependent));
  }

  private releaseEntry(e: Entry<unknown>): void {
    const descriptor = e.descriptor as ResourceDescriptor<unknown>;
    if (e.value !== null && e.state === "ready") {
      this.disposeValue(descriptor, e.value, e.disposers, `resource ${descriptor.id}: dispose failed`);
    }
    e.disposers.clear();
    e.value = null;
    e.abort.aborted = true;
    this.evictedBytesTotal += e.bytes;
    this.totalBytes -= e.bytes;
    e.bytes = 0;
    e.state = "released";
    this.entries.delete(descriptor.id);
    this.graph.unlink(descriptor.id);
    this.evictions++;
    this.events.evicted.emit(descriptor.id);
  }

  private disposeValue<T>(
    descriptor: ResourceDescriptor<T>,
    value: T,
    disposers: Iterable<(value: T) => void>,
    message: string,
  ): void {
    for (const disposer of disposers) {
      try {
        disposer(value);
      } catch (error) {
        this.logger?.error(message, error);
      }
    }
    try {
      descriptor.dispose?.(value);
    } catch (error) {
      this.logger?.error(message, error);
    }
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

  /**
   * Retain an already-ready entry without invoking `acquire`'s content-hash invalidation path.
   * Hot reload uses this lease to keep the previous value alive while a replacement is staged.
   */
  retain<T = unknown>(id: string): ResourceHandle<T> | null {
    const entry = this.entries.get(id) as Entry<T> | undefined;
    if (!entry || entry.state !== "ready") return null;
    return new ResourceHandle<T>(entry);
  }

  /**
   * Remove a ready, unreferenced entry from the registry but transfer (rather than dispose) its
   * value. Used for a staged hot-reload result after the streamer's lease has been released.
   */
  detach<T = unknown>(id: string): DetachedResource<T> | null {
    const entry = this.entries.get(id) as Entry<T> | undefined;
    if (!entry || entry.state !== "ready" || entry.value === null) return null;
    if (entry.refCount > 0) throw new ResourceLifecycleError(`cannot detach "${id}" while ${entry.refCount} handle(s) still reference it`);
    const value = entry.value;
    const descriptor = entry.descriptor;
    const bytes = entry.bytes;
    const disposers = entry.disposers;
    const detached = new DetachedResource<T>(
      this,
      descriptor,
      value,
      bytes,
      disposers,
      () => this.disposeValue(descriptor, value, disposers, `resource ${id}: detached dispose failed`),
    );
    entry.value = null;
    entry.bytes = 0;
    entry.state = "released";
    entry.abort.aborted = true;
    entry.disposers = new Set();
    this.totalBytes -= bytes;
    this.entries.delete(id);
    this.graph.unlink(id);
    return detached;
  }

  /**
   * Atomically adopt a staged value into an existing ready entry. `swap` runs synchronously while
   * the old value is still valid; once it returns, every registry handle observes the replacement
   * before the old value is disposed. If `swap` throws, the old entry remains untouched and the
   * caller still owns (and must dispose) `next`.
   */
  replace<T>(
    id: string,
    descriptor: ResourceDescriptor<T>,
    next: DetachedResource<T>,
    expected: ResourceHandle<T>,
    swap?: (previous: T, replacement: T) => void,
  ): T {
    if (descriptor.id !== id) throw new UsageError(`replace("${id}"): descriptor id must match`);
    if (next.owner !== this || !next.active) throw new ResourceLifecycleError(`replace("${id}"): replacement is not an active transfer from this registry`);
    if (expected.releasedFlag) throw new ResourceLifecycleError(`replace("${id}"): expected handle was released`);
    const entry = this.entries.get(id) as Entry<T> | undefined;
    if (!entry || entry !== expected.entry || entry.state !== "ready" || entry.value === null) {
      throw new ResourceLifecycleError(`replace("${id}"): the live resource changed while the replacement was loading`);
    }

    const previous = entry.value;
    const previousDescriptor = entry.descriptor;
    const previousBytes = entry.bytes;
    const previousDisposers = entry.disposers;
    const dependents = this.graph.transitive(id, "dependents").filter((dependent) => this.entries.has(dependent));
    const nextBytes = descriptor.bytes ? Math.max(0, descriptor.bytes(next.value)) : 0;
    // User binding swaps are required to be synchronous: JS cannot render a frame between this
    // callback and the registry commit/disposal below.
    swap?.(previous, next.value);

    next.adopt();
    entry.descriptor = descriptor;
    entry.value = next.value;
    entry.bytes = nextBytes;
    entry.disposers = next.disposers;
    entry.error = null;
    entry.failure = null;
    entry.state = "ready";
    entry.lastUse = nowMs();
    this.totalBytes += nextBytes - previousBytes;
    this.graph.unlink(id);
    this.registerDependencies(entry, next.value);

    this.disposeValue(previousDescriptor, previous, previousDisposers, `resource ${id}: previous value dispose failed`);
    previousDisposers.clear();
    if (previousDescriptor.contentHash !== undefined && descriptor.contentHash !== undefined && previousDescriptor.contentHash !== descriptor.contentHash) {
      this.events.contentChanged.emit({ id, oldHash: previousDescriptor.contentHash, newHash: descriptor.contentHash, dependents });
    }
    this.events.reloaded.emit({ id, kind: descriptor.kind, oldHash: previousDescriptor.contentHash, newHash: descriptor.contentHash, dependents });
    if (this.maxBytes > 0 && this.totalBytes > this.maxBytes) this.evictIdle();
    return next.value;
  }

  /** Re-load an id, discarding the cached value (legacy non-atomic retry path). */
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
    // Phase 15.2: drop the edges the old value declared; the re-load registers its own (a reload
    // whose load fails must not leave the stale graph behind). startLoad gives the attempt a
    // fresh abort signal.
    this.graph.unlink(id);
    this.startLoad(e as unknown as Entry<T>);
    return e.promise as Promise<T>;
  }

  /**
   * Phase 15.2: invalidate an asset — release it if loaded and report, transitively, every
   * loaded asset that depends on it (the reload list for the editor's hot-reload action, the
   * Phase 15.4 hook). Always emits `invalidated`, even for an id that is not currently loaded.
   */
  invalidate(id: string, reason = "invalidated"): string[] {
    const dependents = this.graph.transitive(id, "dependents").filter((d) => this.entries.has(d));
    const entry = this.entries.get(id);
    if (entry) this.releaseEntry(entry);
    this.events.invalidated.emit({ id, dependents, reason });
    return dependents;
  }

  /** Phase 15.2: the ids `id` directly depends on (sorted). */
  dependenciesOf(id: string): string[] {
    return this.graph.dependenciesOf(id);
  }

  /** Phase 15.2: the ids that directly depend on `id` (sorted). */
  dependentsOf(id: string): string[] {
    return this.graph.dependentsOf(id);
  }

  /**
   * Phase 15.2: the transitive subgraph around `id` — `"deps"` walks down to the leaves (what
   * this asset needs), `"dependents"` walks up to the roots (who needs this asset).
   */
  subgraph(id: string, direction: "deps" | "dependents"): string[] {
    return this.graph.transitive(id, direction);
  }

  /** Parsed `AssetId` metadata for a registry id, or null for legacy bare ids. */
  info(id: string): AssetIdInfo | null {
    return AssetId.parse(id);
  }

  /** All loaded ids of a kind (the editor's asset browser + leak tests use this). */
  idsOfKind(kind: string): string[] {
    const out: string[] = [];
    for (const e of this.entries.values()) if (e.descriptor.kind === kind && e.state === "ready") out.push(e.descriptor.id);
    return out.sort();
  }

  /** The descriptor for an entry (editor inspection / hot-reload version reporting), or null. */
  descriptorOf<T = unknown>(id: string): ResourceDescriptor<T> | null {
    return (this.entries.get(id)?.descriptor as ResourceDescriptor<T> | undefined) ?? null;
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
    /** Phase 15.2: live dependency-graph edges. */
    edges: number;
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
      edges: this.graph.edgeCount,
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
    this.graph.clear();
    for (const key of Object.keys(this.events) as (keyof typeof this.events)[]) this.events[key].clear();
  }
}

function nowMs(): number {
  return typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : Date.now();
}
