/**
 * @suite resources:streaming
 * @group unit
 * @covers engine/src/core/engine.ts
 * @covers engine/src/core/errors.ts
 * @covers engine/src/index.ts
 * @covers engine/src/resources/registry.ts
 * @covers engine/src/resources/streaming.ts
 * @desc Phase 15.3 — streaming: async, cancellable, prioritized asset loading with GPU upload
 */

export const suite = {
  name: "resources:streaming",
  group: "unit",
  covers:   [
    "engine/src/core/engine.ts",
    "engine/src/core/errors.ts",
    "engine/src/index.ts",
    "engine/src/resources/registry.ts",
    "engine/src/resources/streaming.ts"
  ],
  desc: "Phase 15.3 — streaming: async, cancellable, prioritized asset loading with GPU upload",
};
/**
 * Phase 15.3 — streaming: async, cancellable, prioritized asset loading with GPU upload
 * budgeting (`AssetStreamer` in front of `ResourceRegistry`).
 *
 * Everything is driven through the public API: queue/pump/cancel/settle against a registry with
 * controllable slow loads, plus one engine-wiring test proving `Engine.step` pumps the frame
 * streamer on the mock device.
 */

import assert from "node:assert/strict";
import { assertContains, assertRejects, assertThrows, finish, group, test } from "selrun";
import { AssetStreamer, Engine, ResourceRegistry, ResourceLifecycleError, type ResourceDescriptor } from "@forge/engine";

const flush = (ms = 5): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface Harness {
  registry: ResourceRegistry;
  loadCount: Map<string, number>;
  disposals: string[];
  loadOrder: string[];
  /** Ids whose load waits this long before resolving (ms). */
  slowMs: Map<string, number>;
  values: Map<string, string>;
}

function makeHarness(): Harness {
  return {
    registry: new ResourceRegistry(),
    loadCount: new Map(),
    disposals: [],
    loadOrder: [],
    slowMs: new Map(),
    values: new Map(),
  };
}

function descriptor(h: Harness, id: string, opts: { priority?: number; estimatedBytes?: number } = {}): ResourceDescriptor<string> {
  return {
    id,
    kind: "test",
    priority: opts.priority,
    estimatedBytes: opts.estimatedBytes,
    bytes: () => 100,
    dispose: (value: unknown) => h.disposals.push(String(value)),
    load: async (): Promise<string> => {
      const attempt = (h.loadCount.get(id) ?? 0) + 1;
      h.loadCount.set(id, attempt);
      h.loadOrder.push(id);
      const slow = h.slowMs.get(id) ?? 0;
      if (slow > 0) await new Promise((r) => setTimeout(r, slow));
      const value = `${id}#${attempt}`;
      h.values.set(id, value);
      return value;
    },
  };
}

// ---------------------------------------------------------------- scheduling

group("Phase 15.3 — scheduling & prioritization", () => {
  test("request() only queues — nothing loads until pump()", async () => {
    const h = makeHarness();
    const s = new AssetStreamer(h.registry, { maxConcurrent: 2 });
    const a = s.request(descriptor(h, "a"));
    const b = s.request(descriptor(h, "b"));
    assert.equal(h.loadCount.size, 0);
    assert.equal(s.queued, 2);
    assert.equal(a.state, "queued");
    assert.equal(b.state, "queued");
    assert.equal(s.pump(), 2);
    assert.equal(s.queued, 0);
    assert.equal(s.inFlight, 2);
    await Promise.all([a.promise, b.promise]);
    assert.equal(a.state, "ready");
    assert.equal(b.state, "ready");
  });

  test("enforces the concurrency cap and drains over successive pumps", async () => {
    const h = makeHarness();
    const s = new AssetStreamer(h.registry, { maxConcurrent: 2 });
    for (const id of ["a", "b", "c", "d", "e", "f"]) s.request(descriptor(h, id, { priority: 0 }));
    h.slowMs.set("a", 10);
    h.slowMs.set("b", 10);
    s.pump();
    assert.equal(s.inFlight, 2);
    assert.deepEqual(h.loadOrder, ["a", "b"]);
    await flush(20);
    assert.equal(s.inFlight, 0);
    s.pump();
    assert.deepEqual(h.loadOrder, ["a", "b", "c", "d"]);
    await flush(5);
    assert.equal(s.stats().ready, 4);
    assert.equal(s.queued, 2);
  });

  test("admits highest priority first, FIFO inside a priority", async () => {
    const h = makeHarness();
    const s = new AssetStreamer(h.registry, { maxConcurrent: 2 });
    h.slowMs.set("low", 10);
    h.slowMs.set("high", 10);
    s.request(descriptor(h, "low", { priority: 0 }));
    s.request(descriptor(h, "mid", { priority: 5 }));
    s.request(descriptor(h, "high", { priority: 9 }));
    s.request(descriptor(h, "mid2", { priority: 5 }));
    s.pump();
    // "high" (9) first; then the FIFO winner of the two priority-5 loads.
    assert.deepEqual(h.loadOrder, ["high", "mid"]);
    await flush(20);
    s.pump();
    assert.deepEqual(h.loadOrder, ["high", "mid", "mid2", "low"]);
  });

  test("dedupes repeated requests for the same id (one load, same value)", async () => {
    const h = makeHarness();
    const s = new AssetStreamer(h.registry);
    const first = s.request(descriptor(h, "x"));
    const second = s.request(descriptor(h, "x"));
    s.pump();
    const [v1, v2] = await Promise.all([first.promise, second.promise]);
    assert.equal(v1, v2);
    assert.equal(h.loadCount.get("x"), 1);
    assert.equal(s.stats().ready, 1);
  });

  test("fast-paths an id already ready in the registry (no queue, no budget charge)", async () => {
    const h = makeHarness();
    const s = new AssetStreamer(h.registry, { uploadBudgetBytes: 100 });
    const direct = h.registry.acquire(descriptor(h, "t"));
    await direct.wait();
    assert.equal(s.queued, 0);
    const load = s.request(descriptor(h, "t", { estimatedBytes: 100 }));
    assert.equal(load.state, "ready");
    assert.equal((await load.promise), "t#1");
    assert.equal(s.stats().inFlight, 0);
    assert.equal(s.stats().bytesAdmittedThisFrame, 0);
  });
});

// ---------------------------------------------------------------- upload budget

group("Phase 15.3 — GPU upload budgeting", () => {
  test("defers loads that do not fit the frame budget; newFrame() resets it", async () => {
    const h = makeHarness();
    const s = new AssetStreamer(h.registry, { uploadBudgetBytes: 250 });
    s.request(descriptor(h, "a", { estimatedBytes: 100 }));
    s.request(descriptor(h, "b", { estimatedBytes: 100 }));
    s.request(descriptor(h, "c", { estimatedBytes: 100 }));
    s.request(descriptor(h, "big", { estimatedBytes: 600, priority: 9 }));

    assert.equal(s.pump(), 2); // 200 of 250 used; "c" does not fit, "big" never does this frame
    assert.deepEqual(h.loadOrder, ["a", "b"]);
    assert.equal(s.stats().bytesAdmittedThisFrame, 200);
    assert.equal(s.stats().budgetRemaining, 50);
    assert.ok(s.stats().deferredForBudget > 0);

    await flush(5);
    s.newFrame(); // budget resets to 250
    assert.equal(s.pump(), 1); // "c" (100) fits; "big" (600) still doesn't
    assert.deepEqual(h.loadOrder, ["a", "b", "c"]);
    assert.equal(s.stats().bytesAdmittedThisFrame, 100);

    s.newFrame();
    s.uploadBudgetBytes = 1000; // runtime tune takes effect from this newFrame()
    s.newFrame();
    assert.equal(s.pump(), 1);
    assert.deepEqual(h.loadOrder, ["a", "b", "c", "big"]);
  });

  test("never starves the frame: a too-big item waits while smaller ones admit", async () => {
    const h = makeHarness();
    const s = new AssetStreamer(h.registry, { uploadBudgetBytes: 100 });
    s.request(descriptor(h, "huge", { estimatedBytes: 1000, priority: 99 }));
    s.request(descriptor(h, "small", { estimatedBytes: 50, priority: 1 }));
    assert.equal(s.pump(), 1);
    assert.deepEqual(h.loadOrder, ["small"]);
    assert.ok(s.stats().deferredForBudget > 0);
  });

  test("estimatedBytes 0 is not budget-gated and unlimited budget admits everything", async () => {
    const h = makeHarness();
    const s = new AssetStreamer(h.registry, { uploadBudgetBytes: 10 });
    s.request(descriptor(h, "a")); // no estimate
    s.request(descriptor(h, "b", { estimatedBytes: 1000 }));
    s.newFrame();
    assert.equal(s.pump(), 1); // only "a"
    await flush(5);
    s.uploadBudgetBytes = 0; // unlimited
    s.newFrame();
    assert.equal(s.pump(), 1); // "b" now
    await Promise.all([s.settle()]);
    assert.equal(s.stats().ready, 2);
  });
});

// ---------------------------------------------------------------- cancellation

group("Phase 15.3 — cancellation", () => {
  test("cancels a queued load outright (it never runs)", async () => {
    const h = makeHarness();
    const s = new AssetStreamer(h.registry);
    const load = s.request(descriptor(h, "x"));
    assert.equal(s.cancel("x"), true);
    assert.equal(load.state, "cancelled");
    await assertRejects(load.promise, /cancelled/);
    await flush(5);
    assert.equal(h.loadCount.has("x"), false);
    assert.equal(s.stats().cancelled, 1);
    assert.equal(s.cancel("x"), false); // settled
  });

  test("cancels an in-flight load: output disposed, entry retries on re-request", async () => {
    const h = makeHarness();
    const s = new AssetStreamer(h.registry);
    h.slowMs.set("slow", 15);
    const load = s.request(descriptor(h, "slow"));
    s.pump();
    assert.equal(load.state, "loading");
    assert.equal(s.cancel("slow"), true);
    // The load finishes off the record; the registry disposes its output and fails the entry.
    await assertRejects(load.promise, undefined);
    assert.equal(load.state, "cancelled");
    await flush(25);
    assertContains(h.disposals, "slow#1");
    assert.equal(h.registry.stateOf("slow"), "failed");

    // A fresh request goes through the queue (the re-load is a real upload) and succeeds.
    const again = s.request(descriptor(h, "slow"));
    assert.equal(again.state, "queued");
    s.pump();
    await again.promise;
    assert.equal(h.loadCount.get("slow"), 2);
  });

  test("dispose rejects queued loads and bars further requests", async () => {
    const h = makeHarness();
    const s = new AssetStreamer(h.registry);
    const load = s.request(descriptor(h, "x"));
    s.dispose();
    assert.equal(load.state, "cancelled");
    await assertRejects(load.promise, /disposed/);
    assertThrows(() => s.request(descriptor(h, "y")), ResourceLifecycleError);
  });
});

// ---------------------------------------------------------------- lease & settle

group("Phase 15.3 — leases, settle, stats", () => {
  test("holds a lease while in flight, releases it on settle (entry becomes evictable)", async () => {
    const h = makeHarness();
    h.slowMs.set("slow", 15);
    const s = new AssetStreamer(h.registry);
    const load = s.request(descriptor(h, "slow"));
    s.pump();
    assert.notEqual(load.handle(), null);
    assert.equal(h.registry.stateOf("slow"), "loading");
    // The streamer's lease keeps the entry out of the unreferenced pool mid-load.
    assert.equal(h.registry.unreferencedCount, 0);
    await load.promise;
    assert.equal(load.handle(), null);
    assert.equal(h.registry.stateOf("slow"), "ready");
    // Lease released: the entry is now eviction-eligible.
    assert.equal(h.registry.unreferencedCount, 1);
    assert.equal(s.stats().inFlight, 0);
  });

  test("settle() drains the queue and in-flight loads without an external pump", async () => {
    const h = makeHarness();
    const s = new AssetStreamer(h.registry, { maxConcurrent: 1 });
    const loads = ["a", "b", "c"].map((id) => s.request(descriptor(h, id)));
    await s.settle();
    assert.equal(s.queued, 0);
    assert.equal(s.inFlight, 0);
    assert.equal(s.stats().ready, 3);
    assert.deepEqual(loads.map((l) => l.state), ["ready", "ready", "ready"]);
  });

  test("reports stats the engine HUD can show", async () => {
    const h = makeHarness();
    const s = new AssetStreamer(h.registry, { maxConcurrent: 1, uploadBudgetBytes: 40 });
    s.request(descriptor(h, "a", { estimatedBytes: 25 }));
    s.request(descriptor(h, "b", { estimatedBytes: 25 }));
    s.pump();
    const st = s.stats();
    assert.equal(st.queued, 1);
    assert.equal(st.inFlight, 1);
    assert.equal(st.budgetBytes, 40);
    assert.equal(st.budgetRemaining, 15);
    assert.equal(st.bytesAdmittedThisFrame, 25);
    await s.settle();
    assert.equal(s.stats().ready, 2);
  });
});

// ---------------------------------------------------------------- engine wiring

group("Phase 15.3 — engine wiring", () => {
  test("Engine.step pumps the frame streamer; stats expose the streamer", async () => {
    const engine = await Engine.create({ forceMock: true, config: { headless: true } });
    try {
      assert.equal(engine.streamer.registry, engine.resources);
      const d: ResourceDescriptor<string> = {
        id: "texture:stream-test",
        kind: "texture",
        load: async () => {
          await new Promise((r) => setTimeout(r, 2));
          return "value";
        },
      };
      const load = engine.streamer.request(d);
      assert.equal(load.state, "queued");
      engine.step(); // the frame pump admits it
      assert.equal(load.state, "loading");
      engine.step();
      const value = await load.promise;
      assert.equal(value, "value");
      assert.equal(engine.stats().streaming.ready, 1);
      assert.equal(engine.stats().streaming.queued, 0);
    } finally {
      await engine.dispose();
    }
  });
});

await finish();
