/**
 * Phase 15.1 / 15.2 — stable asset ids, content hashes, and the dependency graph.
 *
 * Everything is driven through the public API (`AssetId`, `hashContent`, `AssetGraph`,
 * `ResourceRegistry`): id construction/parsing, hash vectors, edge/cycle registration,
 * eviction safety through a loaded dependent, the eviction cascade, content-hash re-acquire
 * invalidation, `invalidate()` propagation and edge lifecycle.
 */

import { describe, expect, it } from "vitest";
import { AssetGraph, AssetId, Logger, LogLevel, ResourceRegistry, hashContent, type LogSink } from "@forge/engine";

// ---------------------------------------------------------------- AssetId (15.1)

describe("Phase 15.1 — AssetId", () => {
  it("builds and parses path-addressed ids", () => {
    const id = AssetId.forPath("texture", "assets/rocks.png");
    expect(id).toBe("texture:assets/rocks.png");
    expect(AssetId.parse(id)).toEqual({ kind: "texture", address: "path", path: "assets/rocks.png" });

    const chunk = AssetId.forPath("chunk", "3,-1,2");
    expect(AssetId.parse(chunk)).toEqual({ kind: "chunk", address: "path", path: "3,-1,2" });
  });

  it("builds and parses content-addressed ids, normalizing the hash", () => {
    const hash = "9".repeat(64);
    const bare = AssetId.forContent("texture", hash.toUpperCase());
    expect(bare).toBe(`texture:c/${hash}`);
    expect(AssetId.parse(bare)).toEqual({ kind: "texture", address: "content", hash, name: undefined });

    const named = AssetId.forContent("mesh", hash, "hero.gltf");
    expect(AssetId.parse(named)).toEqual({ kind: "mesh", address: "content", hash, name: "hero.gltf" });
  });

  it("rejects malformed ids at construction", () => {
    expect(() => AssetId.forPath("9bad", "x")).toThrow();
    expect(() => AssetId.forPath("ok", "")).toThrow();
    expect(() => AssetId.forContent("ok", "deadbeef")).toThrow();
    expect(() => AssetId.forContent("ok", "G".repeat(64))).toThrow();
    expect(() => AssetId.forContent("ok", "0".repeat(64), "")).toThrow();
  });

  it("parse returns null (never throws) for non-canonical and broken ids", () => {
    expect(AssetId.parse("")).toBeNull();
    expect(AssetId.parse("no-colon")).toBeNull(); // legacy bare id
    expect(AssetId.parse(":x")).toBeNull(); // empty kind
    expect(AssetId.parse("9bad:kind")).toBeNull(); // kind must start with a letter
    expect(AssetId.parse("kind:")).toBeNull(); // empty address
    expect(AssetId.parse("tex:c/deadbeef")).toBeNull(); // hash too short
    expect(AssetId.parse(`tex:c/${"z".repeat(64)}`)).toBeNull(); // non-hex hash
    expect(AssetId.parse(`tex:c/${"0".repeat(64)}~`)).toBeNull(); // empty name
  });

  it("isValid/kindOf/display behave for canonical and legacy ids", () => {
    const hash = "9f86d081" + "a".repeat(56);
    const content = AssetId.forContent("texture", hash, "rocks.png");
    expect(AssetId.isValid(content)).toBe(true);
    expect(AssetId.kindOf(content)).toBe("texture");
    expect(AssetId.display(content)).toBe("texture:9f86d081…~rocks.png");
    expect(AssetId.display("legacy-bare-id")).toBe("legacy-bare-id");
    expect(AssetId.isValid("legacy-bare-id")).toBe(false);
    expect(AssetId.kindOf("legacy-bare-id")).toBeNull();
  });
});

// ---------------------------------------------------------------- hashContent (15.1)

describe("Phase 15.1 — hashContent", () => {
  it("matches the SHA-256 test vectors", async () => {
    const enc = new TextEncoder();
    expect(await hashContent(enc.encode(""))).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(await hashContent(enc.encode("abc"))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("is deterministic, content-sensitive, and respects byteOffset", async () => {
    const a = new Uint8Array([1, 2, 3]);
    const b = new Uint8Array([1, 2, 3]);
    const c = new Uint8Array([1, 2, 4]);
    expect(await hashContent(a)).toBe(await hashContent(b));
    expect(await hashContent(a)).not.toBe(await hashContent(c));

    const big = new Uint8Array(1024).fill(7);
    const view = big.subarray(10, 20);
    expect(await hashContent(view)).toBe(await hashContent(new Uint8Array([7, 7, 7, 7, 7, 7, 7, 7, 7, 7])));
  });
});

// ---------------------------------------------------------------- AssetGraph (15.2)

describe("Phase 15.2 — AssetGraph", () => {
  it("stores edges in both directions, sorted for queries", () => {
    const g = new AssetGraph();
    g.link("vehicle", "mesh");
    g.link("vehicle", "texture");
    g.link("vehicle", "material");
    expect(g.dependenciesOf("vehicle")).toEqual(["material", "mesh", "texture"]);
    expect(g.dependentsOf("mesh")).toEqual(["vehicle"]);
    expect(g.stats()).toEqual({ nodes: 4, edges: 3 });
  });

  it("walks transitive deps and dependents (diamond)", () => {
    const g = new AssetGraph();
    g.link("scene", "mesh-a");
    g.link("scene", "mesh-b");
    g.link("mesh-a", "material");
    g.link("mesh-b", "material");
    g.link("material", "texture");
    expect(g.transitive("scene", "deps")).toEqual(["material", "mesh-a", "mesh-b", "texture"]);
    expect(g.transitive("texture", "dependents")).toEqual(["material", "mesh-a", "mesh-b", "scene"]);
    expect(g.transitive("leaf", "deps")).toEqual([]);
  });

  it("rejects self-dependencies and cycles with a readable path", () => {
    const g = new AssetGraph();
    expect(() => g.link("a", "a")).toThrow(/depends on itself/);
    g.link("a", "b");
    expect(() => g.link("b", "a")).toThrow(/dependency cycle/);
    g.link("x", "y");
    g.link("y", "z");
    expect(g.wouldCycle("z", "x")).toBe("z → x → y → z");
    // No edge was added by the check:
    expect(g.dependenciesOf("z")).toEqual([]);
    expect(g.wouldCycle("z", "w")).toBeNull();
  });

  it("unlink removes both directions and is idempotent", () => {
    const g = new AssetGraph();
    g.link("a", "b");
    g.unlink("a");
    expect(g.dependenciesOf("a")).toEqual([]);
    expect(g.dependentsOf("b")).toEqual([]);
    expect(g.edgeCount).toBe(0);
    g.unlink("a"); // no throw
    expect(g.edgeCount).toBe(0);
  });

  it("re-linking replaces rather than accumulates (registry retry semantics)", () => {
    const g = new AssetGraph();
    g.link("a", "b");
    g.unlink("a");
    g.link("a", "c");
    expect(g.dependenciesOf("a")).toEqual(["c"]);
    expect(g.dependentsOf("b")).toEqual([]);
    expect(g.edgeCount).toBe(1);
  });
});

// ---------------------------------------------------------------- registry integration

interface GraphHarness {
  registry: ResourceRegistry;
  loadCount: Map<string, number>;
  disposals: string[];
  /** Mutable per-id dependency lists (so a test can change them before `retry`). */
  depLists: Map<string, string[]>;
  contentHashes: Map<string, string>;
  logger: Logger;
  logErrors: string[];
}

function makeHarness(options: { maxBytes?: number; idleGraceMs?: number } = {}): GraphHarness {
  const logErrors: string[] = [];
  const sink: LogSink = { write: (r) => void (r.level === LogLevel.Error ? logErrors.push(r.message) : undefined) };
  const logger = new Logger({ sinks: [sink], level: LogLevel.Debug });
  return {
    registry: new ResourceRegistry({ ...options, logger }),
    loadCount: new Map(),
    disposals: [],
    depLists: new Map(),
    contentHashes: new Map(),
    logger,
    logErrors,
  };
}

function descriptor(h: GraphHarness, id: string, bytes = 100): Parameters<ResourceRegistry["acquire"]>[0] {
  return {
    id,
    kind: "test",
    bytes: () => bytes,
    dispose: (value: unknown) => h.disposals.push(String(value)),
    contentHash: h.contentHashes.get(id),
    dependencies: () => h.depLists.get(id) ?? [],
    load: async (): Promise<string> => {
      const attempt = (h.loadCount.get(id) ?? 0) + 1;
      h.loadCount.set(id, attempt);
      return `${id}#${attempt}`;
    },
  };
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 5));
const H1 = "1".repeat(64);
const H2 = "2".repeat(64);

describe("Phase 15.2 — registry dependency graph", () => {
  it("registers edges from dependencies(value) when a load lands", async () => {
    const h = makeHarness();
    h.depLists.set("material:m", ["texture:t"]);
    h.registry.acquire(descriptor(h, "texture:t")).release();
    h.registry.acquire(descriptor(h, "material:m")).release();
    await flush();
    expect(h.registry.dependenciesOf("material:m")).toEqual(["texture:t"]);
    expect(h.registry.dependentsOf("texture:t")).toEqual(["material:m"]);
    expect(h.registry.subgraph("material:m", "deps")).toEqual(["texture:t"]);
    expect(h.registry.stats().edges).toBe(1);
  });

  it("rejects the edge that closes a cycle, with a logged error (resource still loads)", async () => {
    const h = makeHarness();
    h.depLists.set("a", ["b"]);
    h.depLists.set("b", ["a"]);
    const ha = h.registry.acquire(descriptor(h, "a"));
    const hb = h.registry.acquire(descriptor(h, "b"));
    await flush();
    expect(ha.ready).toBe(true);
    expect(hb.ready).toBe(true);
    // The first load to land registers its edge (no cycle exists yet); the second one would
    // close the cycle and is the one that gets rejected. So at most one edge survives, and
    // nothing ever depends on "a" (whose edge, if present, points at "b").
    expect(h.registry.stats().edges).toBeLessThanOrEqual(1);
    expect(h.registry.dependentsOf("a")).toEqual([]);
    expect(h.logErrors.some((m) => m.includes("dependency cycle"))).toBe(true);
  });

  it("logs and survives a dependencies() callback that throws", async () => {
    const h = makeHarness();
    h.depLists.set("boom", []);
    const original = descriptor(h, "boom");
    const bad = { ...original, dependencies: () => {
      throw new Error("broken manifest");
    } };
    const handle = h.registry.acquire(bad);
    await flush();
    expect(handle.ready).toBe(true);
    expect(h.registry.stats().edges).toBe(0);
    expect(h.logErrors.some((m) => m.includes("dependencies() threw"))).toBe(true);
  });

  it("blocks eviction of a dependency while a dependent is loaded", async () => {
    const h = makeHarness({ idleGraceMs: 0 });
    h.depLists.set("material:m", ["texture:t"]);
    h.registry.acquire(descriptor(h, "texture:t", 50)).release();
    const m = h.registry.acquire(descriptor(h, "material:m", 50)); // live handle → non-evictable
    await flush();
    // The texture is unreferenced and idle, but the loaded material embeds it. Nothing may evict.
    expect(h.registry.evictIdle()).toBe(0);
    expect(h.registry.has("texture:t")).toBe(true);
    expect(h.registry.has("material:m")).toBe(true);
    // Once the material is released the whole chain leaves in a single cascading call.
    m.release();
    expect(h.registry.evictIdle()).toBe(2);
    expect(h.registry.has("texture:t")).toBe(false);
    expect(h.registry.has("material:m")).toBe(false);
  });

  it("evicts a whole dependency chain in one call under a byte target", async () => {
    const h = makeHarness({ idleGraceMs: 60_000 }); // fresh entries survive grace eviction
    h.depLists.set("gltf:g", ["material:m"]);
    h.depLists.set("material:m", ["texture:t"]);
    h.registry.acquire(descriptor(h, "texture:t", 100)).release();
    h.registry.acquire(descriptor(h, "material:m", 100)).release();
    h.registry.acquire(descriptor(h, "gltf:g", 100)).release();
    await flush();
    expect(h.registry.stats().bytes).toBe(300);
    // No target: everything is within the grace window, so nothing is freed.
    expect(h.registry.evictIdle()).toBe(0);
    expect(h.registry.stats().entries).toBe(3);
    // A byte target ignores the grace period and cascades top-down through the chain.
    expect(h.registry.evictIdle(50)).toBe(3);
    expect(h.registry.stats().entries).toBe(0);
    expect(h.registry.stats().edges).toBe(0);
  });

  it("a pinned dependent keeps the whole chain alive", async () => {
    const h = makeHarness({ idleGraceMs: 0 });
    h.depLists.set("gltf:g", ["material:m"]);
    h.depLists.set("material:m", ["texture:t"]);
    h.registry.acquire(descriptor(h, "texture:t")).release();
    h.registry.acquire(descriptor(h, "material:m")).release();
    h.registry.acquire(descriptor(h, "gltf:g")).pin();
    await flush();
    expect(h.registry.evictIdle()).toBe(0);
    expect(h.registry.has("texture:t")).toBe(true);
  });

  it("retry re-registers edges from the new value", async () => {
    const h = makeHarness();
    h.depLists.set("material:m", ["texture:t"]);
    const handle = h.registry.acquire(descriptor(h, "material:m"));
    const texture = h.registry.acquire(descriptor(h, "texture:t"));
    await flush();
    h.depLists.set("material:m", ["texture:other"]);
    await h.registry.retry("material:m");
    await flush();
    expect(h.registry.dependenciesOf("material:m")).toEqual(["texture:other"]);
    expect(h.registry.dependentsOf("texture:t")).toEqual([]);
    expect(h.registry.stats().edges).toBe(1);
    handle.release();
    texture.release();
  });

  it("invalidate releases the entry and reports the loaded transitive dependents", async () => {
    const h = makeHarness();
    h.depLists.set("gltf:g", ["material:m"]);
    h.depLists.set("material:m", ["texture:t"]);
    h.registry.acquire(descriptor(h, "texture:t")).release();
    h.registry.acquire(descriptor(h, "material:m")).release();
    const g = h.registry.acquire(descriptor(h, "gltf:g"));
    await flush();
    const seen: string[] = [];
    h.registry.events.invalidated.on((e) => seen.push(e.id));
    const reloadList = h.registry.invalidate("material:m");
    expect(reloadList).toEqual(["gltf:g"]);
    expect(seen).toEqual(["material:m"]);
    expect(h.registry.has("material:m")).toBe(false);
    expect(h.registry.has("texture:t")).toBe(true); // dependency survives its dependent
    expect(h.registry.has("gltf:g")).toBe(true);
    g.release();
  });

  it("invalidate of an unknown id still emits and returns nothing", async () => {
    const h = makeHarness();
    const seen: string[] = [];
    h.registry.events.invalidated.on((e) => seen.push(e.id));
    expect(h.registry.invalidate("nope")).toEqual([]);
    expect(seen).toEqual(["nope"]);
  });

  it("eviction and dispose clear the graph edges", async () => {
    const h = makeHarness();
    h.depLists.set("material:m", ["texture:t"]);
    h.registry.acquire(descriptor(h, "texture:t")).release();
    h.registry.acquire(descriptor(h, "material:m")).release();
    await flush();
    expect(h.registry.stats().edges).toBe(1);
    expect(h.registry.evict("material:m")).toBe(true);
    expect(h.registry.stats().edges).toBe(0);
    expect(h.registry.dependentsOf("texture:t")).toEqual([]);
    h.registry.dispose();
    expect(h.registry.stats().edges).toBe(0);
  });
});

// ---------------------------------------------------------------- content addressing (15.1 + registry)

describe("Phase 15.1 — content-hash invalidation", () => {
  it("re-loads on a hash mismatch and names the loaded dependents", async () => {
    const h = makeHarness();
    h.depLists.set("material:m", ["texture:rocks"]);
    h.contentHashes.set("texture:rocks", H1);
    const first = h.registry.acquire(descriptor(h, "texture:rocks"));
    await flush();
    expect(first.value).toBe("texture:rocks#1");
    h.registry.acquire(descriptor(h, "material:m")).release();
    await flush();

    const events: { id: string; oldHash: string; newHash: string; dependents: string[] }[] = [];
    h.registry.events.contentChanged.on((e) => events.push(e));
    h.contentHashes.set("texture:rocks", H2);
    const second = h.registry.acquire(descriptor(h, "texture:rocks"));
    await flush();
    expect(second.value).toBe("texture:rocks#2");
    expect(h.loadCount.get("texture:rocks")).toBe(2);
    expect(h.disposals).toContain("texture:rocks#1");
    expect(events).toEqual([{ id: "texture:rocks", oldHash: H1, newHash: H2, dependents: ["material:m"] }]);
    // The material is NOT auto-reloaded — it is the editor's job (15.4) to act on the list.
    expect(h.loadCount.get("material:m")).toBe(1);
  });

  it("treats an unchanged hash as a plain dedupe (no reload, no event)", async () => {
    const h = makeHarness();
    h.contentHashes.set("texture:rocks", H1);
    h.registry.acquire(descriptor(h, "texture:rocks"));
    await flush();
    const events: unknown[] = [];
    h.registry.events.contentChanged.on((e) => events.push(e));
    const second = h.registry.acquire(descriptor(h, "texture:rocks"));
    await flush();
    expect(second.value).toBe("texture:rocks#1");
    expect(h.loadCount.get("texture:rocks")).toBe(1);
    expect(events).toEqual([]);
  });

  it("does not compare hashes when the descriptor has none (legacy behavior)", async () => {
    const h = makeHarness();
    h.registry.acquire(descriptor(h, "texture:rocks"));
    await flush();
    // A descriptor without contentHash re-acquires as a plain dedupe, whatever its bytes were.
    const noHash = {
      id: "texture:rocks",
      kind: "test",
      load: async (): Promise<string> => "never",
    };
    h.registry.acquire(noHash);
    await flush();
    expect(h.loadCount.get("texture:rocks")).toBe(1);
  });

  it("registry.info exposes parsed AssetId metadata (null for legacy ids)", async () => {
    const h = makeHarness();
    const id = AssetId.forContent("texture", H1, "rocks.png");
    h.registry.acquire({
      id,
      kind: "texture",
      load: () => "v",
    });
    await flush();
    expect(h.registry.info(id)).toEqual({ kind: "texture", address: "content", hash: H1, name: "rocks.png" });
    expect(h.registry.info("legacy-bare")).toBeNull();
  });
});
