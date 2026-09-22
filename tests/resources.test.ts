/**
 * Phase 9.2 — resource cache eviction, and Phase 9.3's `evictedBytes`.
 *
 * `ResourceRegistry` is the only owner of GPU-backed assets, so its failure modes are the expensive
 * ones: two copies of a texture, an eviction of a resource a frame is still reading, a handle that
 * returns a destroyed object, an eviction report that never fires. Each of those is a case below,
 * driven through the public API of the registry (nothing here reaches into `Entry`).
 */

import { describe, expect, it, vi } from "vitest";
import { ResourceHandle, ResourceLifecycleError, ResourceRegistry } from "@forge/engine";

interface CacheHarness {
  registry: ResourceRegistry;
  /** Values handed to `dispose()`, in order. */
  disposals: string[];
  /** Load count per id — "did this id reload?" */
  loadCount: Map<string, number>;
  /** Ids whose load must wait for the test to resolve them (slow-load cases). */
  deferred: Set<string>;
}

function makeRegistry(options: { maxBytes?: number; idleGraceMs?: number } = {}): CacheHarness {
  return {
    registry: new ResourceRegistry(options),
    disposals: [],
    loadCount: new Map(),
    deferred: new Set(),
  };
}

/**
 * Descriptor factory: a test "resource" is its id plus a byte size, and an id in `deferred` loads
 * asynchronously so a test can evict it while the load is still in flight.
 */
function descriptor(id: string, bytes: number, hooks: CacheHarness) {
  return {
    id,
    kind: "test",
    bytes: () => bytes,
    dispose: (value: unknown) => hooks.disposals.push(String(value)),
    load: async (): Promise<string> => {
      const attempt = (hooks.loadCount.get(id) ?? 0) + 1;
      hooks.loadCount.set(id, attempt);
      if (hooks.deferred.has(id)) await new Promise<void>((resolve) => setTimeout(resolve, 5));
      return `${id}#${attempt}`;
    },
  };
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 5));

describe("Phase 9.2 — resource cache", () => {
  it("loads an id once and shares the result between handles", async () => {
    const h = makeRegistry();
    const d = descriptor("texture:a", 100, h);
    const first = h.registry.acquire(d);
    const second = h.registry.acquire(d);
    expect(h.registry.stats().loads).toBe(1);
    expect(h.registry.stats().deduped).toBe(1);
    expect(await first.wait()).toBe("texture:a#1");
    expect(await second.wait()).toBe("texture:a#1");
    expect(first.refCount).toBe(2);
    expect(second.refCount).toBe(2);
  });

  it("keeps a resource alive until the last handle is released", async () => {
    const h = makeRegistry({ idleGraceMs: 0 });
    const d = descriptor("texture:b", 100, h);
    const a = h.registry.acquire(d);
    await a.wait();
    const b = h.registry.acquire(d);
    a.release();
    expect(h.registry.stateOf("texture:b")).toBe("ready");
    expect(h.disposals).toEqual([]);
    b.release();
    expect(h.registry.unreferencedCount).toBe(1);
    expect(h.registry.stateOf("texture:b")).toBe("ready"); // cached, not gone
    await flush();
    expect(h.registry.evictIdle(0)).toBe(1);
    expect(h.disposals).toEqual(["texture:b#1"]);
    expect(h.registry.stateOf("texture:b")).toBeNull();
  });

  it("never evicts a pinned or still-referenced resource, even over budget", async () => {
    const h = makeRegistry({ maxBytes: 150, idleGraceMs: 0 });
    const pinned = h.registry.acquire(descriptor("pinned", 100, h)).pin();
    await pinned.wait();
    const held = h.registry.acquire(descriptor("held", 100, h));
    await held.wait();
    const spare = h.registry.acquire(descriptor("spare", 100, h));
    await spare.wait();
    spare.release();

    expect(h.registry.bytes).toBe(300); // over the 150-byte budget
    // Over budget ignores the idle grace period, but never touches a pinned or in-use entry.
    const evicted = h.registry.evictIdle();
    expect(evicted).toBe(1);
    expect(h.registry.has("spare")).toBe(false);
    expect(h.registry.has("pinned")).toBe(true);
    expect(h.registry.has("held")).toBe(true);
    expect(h.disposals).toEqual(["spare#1"]);
    held.release();
  });

  it("evicts least-recently-used first and reports the bytes it freed", async () => {
    const h = makeRegistry({ idleGraceMs: 0 });
    const ids = ["lru:a", "lru:b", "lru:c"];
    for (const id of ids) {
      const handle = h.registry.acquire(descriptor(id, 40, h));
      await handle.wait();
      handle.release();
      await new Promise((r) => setTimeout(r, 2)); // distinct `lastUse` stamps
    }
    expect(h.registry.bytes).toBe(120);
    const before = h.registry.stats().evictedBytes;
    // Budget target of 40 bytes: two entries have to go, oldest first.
    expect(h.registry.evictIdle(40)).toBe(2);
    expect(h.disposals).toEqual(["lru:a#1", "lru:b#1"]);
    expect(h.registry.bytes).toBe(40);
    expect(h.registry.stats().evictedBytes).toBe(before + 80);
    expect(h.registry.evictedBytes).toBe(before + 80);
  });

  it("respects the idle grace period until a byte target forces the issue", async () => {
    const h = makeRegistry({ idleGraceMs: 1000 });
    const handle = h.registry.acquire(descriptor("graceful", 64, h));
    await handle.wait();
    handle.release();
    expect(h.registry.evictIdle()).toBe(0); // too fresh: the grace period protects it
    expect(h.registry.has("graceful")).toBe(true);
    expect(h.registry.evictIdle(64)).toBe(0); // already at the target
    expect(h.registry.evictIdle(32)).toBe(1); // a budget instruction ignores the grace period
    expect(h.disposals).toEqual(["graceful#1"]);
    expect(h.registry.evict("graceful")).toBe(false); // it is gone
    expect(h.registry.stateOf("graceful")).toBeNull();
  });

  it("evicts one id explicitly regardless of age", async () => {
    const h = makeRegistry({ idleGraceMs: 60000 });
    const handle = h.registry.acquire(descriptor("explicit", 16, h));
    await handle.wait();
    handle.release();
    expect(h.registry.evict("explicit")).toBe(true);
    expect(h.registry.evict("explicit")).toBe(false);
    expect(h.disposals).toEqual(["explicit#1"]);
  });

  it("re-acquires an evicted id from scratch, and the counters say so", async () => {
    const h = makeRegistry({ idleGraceMs: 0 });
    const d = descriptor("reload", 32, h);
    const first = h.registry.acquire(d);
    await first.wait();
    first.release();
    expect(h.registry.evictIdle()).toBe(1);
    const second = h.registry.acquire(d);
    expect(await second.wait()).toBe("reload#2"); // a fresh load, not the disposed value
    expect(h.registry.stats().loads).toBe(2);
    expect(h.disposals).toEqual(["reload#1"]);
    second.release();
  });

  it("makes a stale handle throw instead of returning a destroyed resource", async () => {
    const h = makeRegistry({ idleGraceMs: 0 });
    const handle: ResourceHandle<string> = h.registry.acquire(descriptor("stale", 16, h));
    expect(await handle.wait()).toBe("stale#1");
    handle.release();
    h.registry.evictIdle();
    expect(() => handle.value).toThrow(ResourceLifecycleError);
    expect(handle.releasedFlag).toBe(true);
    expect(h.registry.stateOf("stale")).toBeNull();

    // A handle that is still held while its entry is evicted also throws rather than handing back a
    // disposed GPU object.
    const live = h.registry.acquire(descriptor("evicted-under-me", 16, h));
    await live.wait();
    h.registry.evict("evicted-under-me");
    expect(() => live.value).toThrow(/released|not ready/);
    live.release();
    expect(h.disposals).toContain("evicted-under-me#1");
  });

  it("disposes a load that finishes after its entry was evicted (nothing is orphaned)", async () => {
    const h = makeRegistry({ idleGraceMs: 0 });
    h.deferred.add("slow");
    const handle = h.registry.acquire(descriptor("slow", 64, h));
    expect(h.registry.stateOf("slow")).toBe("loading");
    h.registry.evict("slow");
    await expect(handle.wait()).rejects.toThrow(ResourceLifecycleError);
    await flush(); // the load lands after the eviction
    expect(h.disposals).toEqual(["slow#1"]); // the orphaned value was disposed, not leaked
    expect(h.registry.bytes).toBe(0);
  });

  it("caches a failure, re-rejects it, and recovers on retry", async () => {
    const registry = new ResourceRegistry({ logger: null });
    let attempts = 0;
    const d = {
      id: "flaky",
      kind: "test",
      bytes: () => 8,
      load: async () => {
        attempts++;
        if (attempts === 1) throw new Error("network down");
        return "ok";
      },
    };
    const failed = registry.acquire<string>(d);
    await expect(failed.wait()).rejects.toThrow("network down");
    failed.release();
    expect(registry.stateOf("flaky")).toBe("failed");
    // A second acquire retries (a transient error must not be permanent).
    const retried = registry.acquire<string>(d);
    expect(await retried.wait()).toBe("ok");
    expect(attempts).toBe(2);
    retried.release();
    registry.dispose();
  });

  it("reloads through retry() and disposes the previous value exactly once", async () => {
    const h = makeRegistry();
    const d = descriptor("hot", 24, h);
    const handle = h.registry.acquire(d);
    await handle.wait();
    await h.registry.retry("hot");
    expect(h.disposals).toEqual(["hot#1"]);
    expect(h.registry.stats().loads).toBe(2);
    handle.release();
  });

  it("runs loaders for sub-resources through addDisposer", async () => {
    const h = makeRegistry({ idleGraceMs: 0 });
    const subDisposed: string[] = [];
    const handle = h.registry.acquire(descriptor("composite", 12, h));
    await handle.wait();
    expect(h.registry.addDisposer<string>("composite", (value) => subDisposed.push(value))).toBe(true);
    expect(h.registry.addDisposer("missing", () => {})).toBe(false);
    handle.release();
    h.registry.evictIdle();
    expect(subDisposed).toEqual(["composite#1"]);
  });

  it("settles every in-flight load and releases everything on dispose", async () => {
    const h = makeRegistry();
    h.deferred.add("one");
    h.deferred.add("two");
    h.registry.acquire(descriptor("one", 8, h));
    h.registry.acquire(descriptor("two", 8, h));
    const settled = vi.fn();
    void h.registry.settle().then(settled);
    await flush();
    expect(settled).toHaveBeenCalled();
    h.registry.dispose();
    expect(h.registry.size).toBe(0);
    expect(h.registry.bytes).toBe(0);
    expect(() => h.registry.acquire(descriptor("after-dispose", 8, h))).toThrow(ResourceLifecycleError);
  });

  it("validates descriptors instead of silently aliasing", () => {
    const registry = new ResourceRegistry();
    expect(() => registry.acquire({ id: "", kind: "test", load: () => 1 })).toThrow(/non-empty/);
    expect(() => registry.acquire({ id: "x", kind: "", load: () => 1 })).toThrow(/non-empty/);
    registry.dispose();
  });
});
