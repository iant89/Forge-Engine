/**
 * Phase 15.3 — streaming: async, cancellable, prioritized asset loading with GPU upload
 * budgeting (`AssetStreamer` in front of `ResourceRegistry`).
 *
 * Everything is driven through the public API: queue/pump/cancel/settle against a registry with
 * controllable slow loads, plus one engine-wiring test proving `Engine.step` pumps the frame
 * streamer on the mock device.
 */

import { describe, expect, it } from "vitest";
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

describe("Phase 15.3 — scheduling & prioritization", () => {
  it("request() only queues — nothing loads until pump()", async () => {
    const h = makeHarness();
    const s = new AssetStreamer(h.registry, { maxConcurrent: 2 });
    const a = s.request(descriptor(h, "a"));
    const b = s.request(descriptor(h, "b"));
    expect(h.loadCount.size).toBe(0);
    expect(s.queued).toBe(2);
    expect(a.state).toBe("queued");
    expect(b.state).toBe("queued");
    expect(s.pump()).toBe(2);
    expect(s.queued).toBe(0);
    expect(s.inFlight).toBe(2);
    await Promise.all([a.promise, b.promise]);
    expect(a.state).toBe("ready");
    expect(b.state).toBe("ready");
  });

  it("enforces the concurrency cap and drains over successive pumps", async () => {
    const h = makeHarness();
    const s = new AssetStreamer(h.registry, { maxConcurrent: 2 });
    for (const id of ["a", "b", "c", "d", "e", "f"]) s.request(descriptor(h, id, { priority: 0 }));
    h.slowMs.set("a", 10);
    h.slowMs.set("b", 10);
    s.pump();
    expect(s.inFlight).toBe(2);
    expect(h.loadOrder).toEqual(["a", "b"]);
    await flush(20);
    expect(s.inFlight).toBe(0);
    s.pump();
    expect(h.loadOrder).toEqual(["a", "b", "c", "d"]);
    await flush(5);
    expect(s.stats().ready).toBe(4);
    expect(s.queued).toBe(2);
  });

  it("admits highest priority first, FIFO inside a priority", async () => {
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
    expect(h.loadOrder).toEqual(["high", "mid"]);
    await flush(20);
    s.pump();
    expect(h.loadOrder).toEqual(["high", "mid", "mid2", "low"]);
  });

  it("dedupes repeated requests for the same id (one load, same value)", async () => {
    const h = makeHarness();
    const s = new AssetStreamer(h.registry);
    const first = s.request(descriptor(h, "x"));
    const second = s.request(descriptor(h, "x"));
    s.pump();
    const [v1, v2] = await Promise.all([first.promise, second.promise]);
    expect(v1).toBe(v2);
    expect(h.loadCount.get("x")).toBe(1);
    expect(s.stats().ready).toBe(1);
  });

  it("fast-paths an id already ready in the registry (no queue, no budget charge)", async () => {
    const h = makeHarness();
    const s = new AssetStreamer(h.registry, { uploadBudgetBytes: 100 });
    const direct = h.registry.acquire(descriptor(h, "t"));
    await direct.wait();
    expect(s.queued).toBe(0);
    const load = s.request(descriptor(h, "t", { estimatedBytes: 100 }));
    expect(load.state).toBe("ready");
    expect(load.promise).resolves.toBe("t#1");
    expect(s.stats().inFlight).toBe(0);
    expect(s.stats().bytesAdmittedThisFrame).toBe(0);
  });
});

// ---------------------------------------------------------------- upload budget

describe("Phase 15.3 — GPU upload budgeting", () => {
  it("defers loads that do not fit the frame budget; newFrame() resets it", async () => {
    const h = makeHarness();
    const s = new AssetStreamer(h.registry, { uploadBudgetBytes: 250 });
    s.request(descriptor(h, "a", { estimatedBytes: 100 }));
    s.request(descriptor(h, "b", { estimatedBytes: 100 }));
    s.request(descriptor(h, "c", { estimatedBytes: 100 }));
    s.request(descriptor(h, "big", { estimatedBytes: 600, priority: 9 }));

    expect(s.pump()).toBe(2); // 200 of 250 used; "c" does not fit, "big" never does this frame
    expect(h.loadOrder).toEqual(["a", "b"]);
    expect(s.stats().bytesAdmittedThisFrame).toBe(200);
    expect(s.stats().budgetRemaining).toBe(50);
    expect(s.stats().deferredForBudget).toBeGreaterThan(0);

    await flush(5);
    s.newFrame(); // budget resets to 250
    expect(s.pump()).toBe(1); // "c" (100) fits; "big" (600) still doesn't
    expect(h.loadOrder).toEqual(["a", "b", "c"]);
    expect(s.stats().bytesAdmittedThisFrame).toBe(100);

    s.newFrame();
    s.uploadBudgetBytes = 1000; // runtime tune takes effect from this newFrame()
    s.newFrame();
    expect(s.pump()).toBe(1);
    expect(h.loadOrder).toEqual(["a", "b", "c", "big"]);
  });

  it("never starves the frame: a too-big item waits while smaller ones admit", async () => {
    const h = makeHarness();
    const s = new AssetStreamer(h.registry, { uploadBudgetBytes: 100 });
    s.request(descriptor(h, "huge", { estimatedBytes: 1000, priority: 99 }));
    s.request(descriptor(h, "small", { estimatedBytes: 50, priority: 1 }));
    expect(s.pump()).toBe(1);
    expect(h.loadOrder).toEqual(["small"]);
    expect(s.stats().deferredForBudget).toBeGreaterThan(0);
  });

  it("estimatedBytes 0 is not budget-gated and unlimited budget admits everything", async () => {
    const h = makeHarness();
    const s = new AssetStreamer(h.registry, { uploadBudgetBytes: 10 });
    s.request(descriptor(h, "a")); // no estimate
    s.request(descriptor(h, "b", { estimatedBytes: 1000 }));
    s.newFrame();
    expect(s.pump()).toBe(1); // only "a"
    await flush(5);
    s.uploadBudgetBytes = 0; // unlimited
    s.newFrame();
    expect(s.pump()).toBe(1); // "b" now
    await Promise.all([s.settle()]);
    expect(s.stats().ready).toBe(2);
  });
});

// ---------------------------------------------------------------- cancellation

describe("Phase 15.3 — cancellation", () => {
  it("cancels a queued load outright (it never runs)", async () => {
    const h = makeHarness();
    const s = new AssetStreamer(h.registry);
    const load = s.request(descriptor(h, "x"));
    expect(s.cancel("x")).toBe(true);
    expect(load.state).toBe("cancelled");
    await expect(load.promise).rejects.toThrow(/cancelled/);
    await flush(5);
    expect(h.loadCount.has("x")).toBe(false);
    expect(s.stats().cancelled).toBe(1);
    expect(s.cancel("x")).toBe(false); // settled
  });

  it("cancels an in-flight load: output disposed, entry retries on re-request", async () => {
    const h = makeHarness();
    const s = new AssetStreamer(h.registry);
    h.slowMs.set("slow", 15);
    const load = s.request(descriptor(h, "slow"));
    s.pump();
    expect(load.state).toBe("loading");
    expect(s.cancel("slow")).toBe(true);
    // The load finishes off the record; the registry disposes its output and fails the entry.
    await expect(load.promise).rejects.toThrow();
    expect(load.state).toBe("cancelled");
    await flush(25);
    expect(h.disposals).toContain("slow#1");
    expect(h.registry.stateOf("slow")).toBe("failed");

    // A fresh request goes through the queue (the re-load is a real upload) and succeeds.
    const again = s.request(descriptor(h, "slow"));
    expect(again.state).toBe("queued");
    s.pump();
    await again.promise;
    expect(h.loadCount.get("slow")).toBe(2);
  });

  it("dispose rejects queued loads and bars further requests", async () => {
    const h = makeHarness();
    const s = new AssetStreamer(h.registry);
    const load = s.request(descriptor(h, "x"));
    s.dispose();
    expect(load.state).toBe("cancelled");
    await expect(load.promise).rejects.toThrow(/disposed/);
    expect(() => s.request(descriptor(h, "y"))).toThrow(ResourceLifecycleError);
  });
});

// ---------------------------------------------------------------- lease & settle

describe("Phase 15.3 — leases, settle, stats", () => {
  it("holds a lease while in flight, releases it on settle (entry becomes evictable)", async () => {
    const h = makeHarness();
    h.slowMs.set("slow", 15);
    const s = new AssetStreamer(h.registry);
    const load = s.request(descriptor(h, "slow"));
    s.pump();
    expect(load.handle()).not.toBeNull();
    expect(h.registry.stateOf("slow")).toBe("loading");
    // The streamer's lease keeps the entry out of the unreferenced pool mid-load.
    expect(h.registry.unreferencedCount).toBe(0);
    await load.promise;
    expect(load.handle()).toBeNull();
    expect(h.registry.stateOf("slow")).toBe("ready");
    // Lease released: the entry is now eviction-eligible.
    expect(h.registry.unreferencedCount).toBe(1);
    expect(s.stats().inFlight).toBe(0);
  });

  it("settle() drains the queue and in-flight loads without an external pump", async () => {
    const h = makeHarness();
    const s = new AssetStreamer(h.registry, { maxConcurrent: 1 });
    const loads = ["a", "b", "c"].map((id) => s.request(descriptor(h, id)));
    await s.settle();
    expect(s.queued).toBe(0);
    expect(s.inFlight).toBe(0);
    expect(s.stats().ready).toBe(3);
    expect(loads.map((l) => l.state)).toEqual(["ready", "ready", "ready"]);
  });

  it("reports stats the engine HUD can show", async () => {
    const h = makeHarness();
    const s = new AssetStreamer(h.registry, { maxConcurrent: 1, uploadBudgetBytes: 40 });
    s.request(descriptor(h, "a", { estimatedBytes: 25 }));
    s.request(descriptor(h, "b", { estimatedBytes: 25 }));
    s.pump();
    const st = s.stats();
    expect(st.queued).toBe(1);
    expect(st.inFlight).toBe(1);
    expect(st.budgetBytes).toBe(40);
    expect(st.budgetRemaining).toBe(15);
    expect(st.bytesAdmittedThisFrame).toBe(25);
    await s.settle();
    expect(s.stats().ready).toBe(2);
  });
});

// ---------------------------------------------------------------- engine wiring

describe("Phase 15.3 — engine wiring", () => {
  it("Engine.step pumps the frame streamer; stats expose the streamer", async () => {
    const engine = await Engine.create({ forceMock: true, config: { headless: true } });
    try {
      expect(engine.streamer.registry).toBe(engine.resources);
      const d: ResourceDescriptor<string> = {
        id: "texture:stream-test",
        kind: "texture",
        load: async () => {
          await new Promise((r) => setTimeout(r, 2));
          return "value";
        },
      };
      const load = engine.streamer.request(d);
      expect(load.state).toBe("queued");
      engine.step(); // the frame pump admits it
      expect(load.state).toBe("loading");
      engine.step();
      const value = await load.promise;
      expect(value).toBe("value");
      expect(engine.stats().streaming.ready).toBe(1);
      expect(engine.stats().streaming.queued).toBe(0);
    } finally {
      await engine.dispose();
    }
  });
});
