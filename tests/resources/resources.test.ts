/**
 * @suite resources:resources
 * @group unit
 * @covers engine/src/core/errors.ts
 * @covers engine/src/index.ts
 * @covers engine/src/resources/registry.ts
 * @desc Phase 9.2 — resource cache eviction, and Phase 9.3's evictedBytes
 */

export const suite = {
  name: "resources:resources",
  group: "unit",
  covers:   [
    "engine/src/core/errors.ts",
    "engine/src/index.ts",
    "engine/src/resources/registry.ts"
  ],
  desc: "Phase 9.2 — resource cache eviction, and Phase 9.3's evictedBytes",
};
/**
 * Phase 9.2 — resource cache eviction, and Phase 9.3's `evictedBytes`.
 *
 * `ResourceRegistry` is the only owner of GPU-backed assets, so its failure modes are the expensive
 * ones: two copies of a texture, an eviction of a resource a frame is still reading, a handle that
 * returns a destroyed object, an eviction report that never fires. Each of those is a case below,
 * driven through the public API of the registry (nothing here reaches into `Entry`).
 */

import assert from "node:assert/strict";
import { assertCalled, assertContains, assertRejects, assertThrows, finish, group, spyFunction, test } from "selrun";
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

group("Phase 9.2 — resource cache", () => {
  test("loads an id once and shares the result between handles", async () => {
    const h = makeRegistry();
    const d = descriptor("texture:a", 100, h);
    const first = h.registry.acquire(d);
    const second = h.registry.acquire(d);
    assert.equal(h.registry.stats().loads, 1);
    assert.equal(h.registry.stats().deduped, 1);
    assert.equal(await first.wait(), "texture:a#1");
    assert.equal(await second.wait(), "texture:a#1");
    assert.equal(first.refCount, 2);
    assert.equal(second.refCount, 2);
  });

  test("keeps a resource alive until the last handle is released", async () => {
    const h = makeRegistry({ idleGraceMs: 0 });
    const d = descriptor("texture:b", 100, h);
    const a = h.registry.acquire(d);
    await a.wait();
    const b = h.registry.acquire(d);
    a.release();
    assert.equal(h.registry.stateOf("texture:b"), "ready");
    assert.deepEqual(h.disposals, []);
    b.release();
    assert.equal(h.registry.unreferencedCount, 1);
    assert.equal(h.registry.stateOf("texture:b"), "ready"); // cached, not gone
    await flush();
    assert.equal(h.registry.evictIdle(0), 1);
    assert.deepEqual(h.disposals, ["texture:b#1"]);
    assert.equal(h.registry.stateOf("texture:b"), null);
  });

  test("never evicts a pinned or still-referenced resource, even over budget", async () => {
    const h = makeRegistry({ maxBytes: 150, idleGraceMs: 0 });
    const pinned = h.registry.acquire(descriptor("pinned", 100, h)).pin();
    await pinned.wait();
    const held = h.registry.acquire(descriptor("held", 100, h));
    await held.wait();
    const spare = h.registry.acquire(descriptor("spare", 100, h));
    await spare.wait();
    spare.release();

    assert.equal(h.registry.bytes, 300); // over the 150-byte budget
    // Over budget ignores the idle grace period, but never touches a pinned or in-use entry.
    const evicted = h.registry.evictIdle();
    assert.equal(evicted, 1);
    assert.equal(h.registry.has("spare"), false);
    assert.equal(h.registry.has("pinned"), true);
    assert.equal(h.registry.has("held"), true);
    assert.deepEqual(h.disposals, ["spare#1"]);
    held.release();
  });

  test("evicts least-recently-used first and reports the bytes it freed", async () => {
    const h = makeRegistry({ idleGraceMs: 0 });
    const ids = ["lru:a", "lru:b", "lru:c"];
    for (const id of ids) {
      const handle = h.registry.acquire(descriptor(id, 40, h));
      await handle.wait();
      handle.release();
      await new Promise((r) => setTimeout(r, 2)); // distinct `lastUse` stamps
    }
    assert.equal(h.registry.bytes, 120);
    const before = h.registry.stats().evictedBytes;
    // Budget target of 40 bytes: two entries have to go, oldest first.
    assert.equal(h.registry.evictIdle(40), 2);
    assert.deepEqual(h.disposals, ["lru:a#1", "lru:b#1"]);
    assert.equal(h.registry.bytes, 40);
    assert.equal(h.registry.stats().evictedBytes, before + 80);
    assert.equal(h.registry.evictedBytes, before + 80);
  });

  test("respects the idle grace period until a byte target forces the issue", async () => {
    const h = makeRegistry({ idleGraceMs: 1000 });
    const handle = h.registry.acquire(descriptor("graceful", 64, h));
    await handle.wait();
    handle.release();
    assert.equal(h.registry.evictIdle(), 0); // too fresh: the grace period protects it
    assert.equal(h.registry.has("graceful"), true);
    assert.equal(h.registry.evictIdle(64), 0); // already at the target
    assert.equal(h.registry.evictIdle(32), 1); // a budget instruction ignores the grace period
    assert.deepEqual(h.disposals, ["graceful#1"]);
    assert.equal(h.registry.evict("graceful"), false); // it is gone
    assert.equal(h.registry.stateOf("graceful"), null);
  });

  test("evicts one id explicitly regardless of age", async () => {
    const h = makeRegistry({ idleGraceMs: 60000 });
    const handle = h.registry.acquire(descriptor("explicit", 16, h));
    await handle.wait();
    handle.release();
    assert.equal(h.registry.evict("explicit"), true);
    assert.equal(h.registry.evict("explicit"), false);
    assert.deepEqual(h.disposals, ["explicit#1"]);
  });

  test("re-acquires an evicted id from scratch, and the counters say so", async () => {
    const h = makeRegistry({ idleGraceMs: 0 });
    const d = descriptor("reload", 32, h);
    const first = h.registry.acquire(d);
    await first.wait();
    first.release();
    assert.equal(h.registry.evictIdle(), 1);
    const second = h.registry.acquire(d);
    assert.equal(await second.wait(), "reload#2"); // a fresh load, not the disposed value
    assert.equal(h.registry.stats().loads, 2);
    assert.deepEqual(h.disposals, ["reload#1"]);
    second.release();
  });

  test("makes a stale handle throw instead of returning a destroyed resource", async () => {
    const h = makeRegistry({ idleGraceMs: 0 });
    const handle: ResourceHandle<string> = h.registry.acquire(descriptor("stale", 16, h));
    assert.equal(await handle.wait(), "stale#1");
    handle.release();
    h.registry.evictIdle();
    assertThrows(() => handle.value, ResourceLifecycleError);
    assert.equal(handle.releasedFlag, true);
    assert.equal(h.registry.stateOf("stale"), null);

    // A handle that is still held while its entry is evicted also throws rather than handing back a
    // disposed GPU object.
    const live = h.registry.acquire(descriptor("evicted-under-me", 16, h));
    await live.wait();
    h.registry.evict("evicted-under-me");
    assertThrows(() => live.value, /released|not ready/);
    live.release();
    assertContains(h.disposals, "evicted-under-me#1");
  });

  test("disposes a load that finishes after its entry was evicted (nothing is orphaned)", async () => {
    const h = makeRegistry({ idleGraceMs: 0 });
    h.deferred.add("slow");
    const handle = h.registry.acquire(descriptor("slow", 64, h));
    assert.equal(h.registry.stateOf("slow"), "loading");
    h.registry.evict("slow");
    await assertRejects(handle.wait(), ResourceLifecycleError);
    await flush(); // the load lands after the eviction
    assert.deepEqual(h.disposals, ["slow#1"]); // the orphaned value was disposed, not leaked
    assert.equal(h.registry.bytes, 0);
  });

  test("caches a failure, re-rejects it, and recovers on retry", async () => {
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
    await assertRejects(failed.wait(), "network down");
    failed.release();
    assert.equal(registry.stateOf("flaky"), "failed");
    // A second acquire retries (a transient error must not be permanent).
    const retried = registry.acquire<string>(d);
    assert.equal(await retried.wait(), "ok");
    assert.equal(attempts, 2);
    retried.release();
    registry.dispose();
  });

  test("reloads through retry() and disposes the previous value exactly once", async () => {
    const h = makeRegistry();
    const d = descriptor("hot", 24, h);
    const handle = h.registry.acquire(d);
    await handle.wait();
    await h.registry.retry("hot");
    assert.deepEqual(h.disposals, ["hot#1"]);
    assert.equal(h.registry.stats().loads, 2);
    handle.release();
  });

  test("runs loaders for sub-resources through addDisposer", async () => {
    const h = makeRegistry({ idleGraceMs: 0 });
    const subDisposed: string[] = [];
    const handle = h.registry.acquire(descriptor("composite", 12, h));
    await handle.wait();
    assert.equal(h.registry.addDisposer<string>("composite", (value) => subDisposed.push(value)), true);
    assert.equal(h.registry.addDisposer("missing", () => {}), false);
    handle.release();
    h.registry.evictIdle();
    assert.deepEqual(subDisposed, ["composite#1"]);
  });

  test("settles every in-flight load and releases everything on dispose", async () => {
    const h = makeRegistry();
    h.deferred.add("one");
    h.deferred.add("two");
    h.registry.acquire(descriptor("one", 8, h));
    h.registry.acquire(descriptor("two", 8, h));
    const settled = spyFunction();
    void h.registry.settle().then(settled);
    await flush();
    assertCalled(settled);
    h.registry.dispose();
    assert.equal(h.registry.size, 0);
    assert.equal(h.registry.bytes, 0);
    assertThrows(() => h.registry.acquire(descriptor("after-dispose", 8, h)), ResourceLifecycleError);
  });

  test("validates descriptors instead of silently aliasing", () => {
    const registry = new ResourceRegistry();
    assertThrows(() => registry.acquire({ id: "", kind: "test", load: () => 1 }), /non-empty/);
    assertThrows(() => registry.acquire({ id: "x", kind: "", load: () => 1 }), /non-empty/);
    registry.dispose();
  });
});

await finish();
