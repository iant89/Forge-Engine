/**
 * @suite resources:assetPipeline
 * @group unit
 * @covers engine/src/core/log.ts
 * @covers engine/src/index.ts
 * @covers engine/src/resources/assetGraph.ts
 * @covers engine/src/resources/assetId.ts
 * @covers engine/src/resources/registry.ts
 * @desc Phase 15.1 / 15.2 — stable asset ids, content hashes, and the dependency graph
 */

export const suite = {
  name: "resources:assetPipeline",
  group: "unit",
  covers:   [
    "engine/src/core/log.ts",
    "engine/src/index.ts",
    "engine/src/resources/assetGraph.ts",
    "engine/src/resources/assetId.ts",
    "engine/src/resources/registry.ts"
  ],
  desc: "Phase 15.1 / 15.2 — stable asset ids, content hashes, and the dependency graph",
};
/**
 * Phase 15.1 / 15.2 — stable asset ids, content hashes, and the dependency graph.
 *
 * Everything is driven through the public API (`AssetId`, `hashContent`, `AssetGraph`,
 * `ResourceRegistry`): id construction/parsing, hash vectors, edge/cycle registration,
 * eviction safety through a loaded dependent, the eviction cascade, content-hash re-acquire
 * invalidation, `invalidate()` propagation and edge lifecycle.
 */

import assert from "node:assert/strict";
import { assertContains, assertThrows, finish, group, test } from "selrun";
import { AssetGraph, AssetId, Logger, LogLevel, ResourceRegistry, hashContent, type LogSink } from "@forge/engine";

// ---------------------------------------------------------------- AssetId (15.1)

group("Phase 15.1 — AssetId", () => {
  test("builds and parses path-addressed ids", () => {
    const id = AssetId.forPath("texture", "assets/rocks.png");
    assert.equal(id, "texture:assets/rocks.png");
    assert.deepEqual(AssetId.parse(id), { kind: "texture", address: "path", path: "assets/rocks.png" });

    const chunk = AssetId.forPath("chunk", "3,-1,2");
    assert.deepEqual(AssetId.parse(chunk), { kind: "chunk", address: "path", path: "3,-1,2" });
  });

  test("builds and parses content-addressed ids, normalizing the hash", () => {
    const hash = "9".repeat(64);
    const bare = AssetId.forContent("texture", hash.toUpperCase());
    assert.equal(bare, `texture:c/${hash}`);
    assert.deepEqual(AssetId.parse(bare), { kind: "texture", address: "content", hash, name: undefined });

    const named = AssetId.forContent("mesh", hash, "hero.gltf");
    assert.deepEqual(AssetId.parse(named), { kind: "mesh", address: "content", hash, name: "hero.gltf" });
  });

  test("rejects malformed ids at construction", () => {
    assertThrows(() => AssetId.forPath("9bad", "x"), undefined);
    assertThrows(() => AssetId.forPath("ok", ""), undefined);
    assertThrows(() => AssetId.forContent("ok", "deadbeef"), undefined);
    assertThrows(() => AssetId.forContent("ok", "G".repeat(64)), undefined);
    assertThrows(() => AssetId.forContent("ok", "0".repeat(64), ""), undefined);
  });

  test("parse returns null (never throws) for non-canonical and broken ids", () => {
    assert.equal(AssetId.parse(""), null);
    assert.equal(AssetId.parse("no-colon"), null); // legacy bare id
    assert.equal(AssetId.parse(":x"), null); // empty kind
    assert.equal(AssetId.parse("9bad:kind"), null); // kind must start with a letter
    assert.equal(AssetId.parse("kind:"), null); // empty address
    assert.equal(AssetId.parse("tex:c/deadbeef"), null); // hash too short
    assert.equal(AssetId.parse(`tex:c/${"z".repeat(64)}`), null); // non-hex hash
    assert.equal(AssetId.parse(`tex:c/${"0".repeat(64)}~`), null); // empty name
  });

  test("isValid/kindOf/display behave for canonical and legacy ids", () => {
    const hash = "9f86d081" + "a".repeat(56);
    const content = AssetId.forContent("texture", hash, "rocks.png");
    assert.equal(AssetId.isValid(content), true);
    assert.equal(AssetId.kindOf(content), "texture");
    assert.equal(AssetId.display(content), "texture:9f86d081…~rocks.png");
    assert.equal(AssetId.display("legacy-bare-id"), "legacy-bare-id");
    assert.equal(AssetId.isValid("legacy-bare-id"), false);
    assert.equal(AssetId.kindOf("legacy-bare-id"), null);
  });
});

// ---------------------------------------------------------------- hashContent (15.1)

group("Phase 15.1 — hashContent", () => {
  test("matches the SHA-256 test vectors", async () => {
    const enc = new TextEncoder();
    assert.equal(await hashContent(enc.encode("")), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    assert.equal(await hashContent(enc.encode("abc")), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  test("is deterministic, content-sensitive, and respects byteOffset", async () => {
    const a = new Uint8Array([1, 2, 3]);
    const b = new Uint8Array([1, 2, 3]);
    const c = new Uint8Array([1, 2, 4]);
    assert.equal(await hashContent(a), await hashContent(b));
    assert.notEqual(await hashContent(a), await hashContent(c));

    const big = new Uint8Array(1024).fill(7);
    const view = big.subarray(10, 20);
    assert.equal(await hashContent(view), await hashContent(new Uint8Array([7, 7, 7, 7, 7, 7, 7, 7, 7, 7])));
  });
});

// ---------------------------------------------------------------- AssetGraph (15.2)

group("Phase 15.2 — AssetGraph", () => {
  test("stores edges in both directions, sorted for queries", () => {
    const g = new AssetGraph();
    g.link("vehicle", "mesh");
    g.link("vehicle", "texture");
    g.link("vehicle", "material");
    assert.deepEqual(g.dependenciesOf("vehicle"), ["material", "mesh", "texture"]);
    assert.deepEqual(g.dependentsOf("mesh"), ["vehicle"]);
    assert.deepEqual(g.stats(), { nodes: 4, edges: 3 });
  });

  test("walks transitive deps and dependents (diamond)", () => {
    const g = new AssetGraph();
    g.link("scene", "mesh-a");
    g.link("scene", "mesh-b");
    g.link("mesh-a", "material");
    g.link("mesh-b", "material");
    g.link("material", "texture");
    assert.deepEqual(g.transitive("scene", "deps"), ["material", "mesh-a", "mesh-b", "texture"]);
    assert.deepEqual(g.transitive("texture", "dependents"), ["material", "mesh-a", "mesh-b", "scene"]);
    assert.deepEqual(g.transitive("leaf", "deps"), []);
  });

  test("rejects self-dependencies and cycles with a readable path", () => {
    const g = new AssetGraph();
    assertThrows(() => g.link("a", "a"), /depends on itself/);
    g.link("a", "b");
    assertThrows(() => g.link("b", "a"), /dependency cycle/);
    g.link("x", "y");
    g.link("y", "z");
    assert.equal(g.wouldCycle("z", "x"), "z → x → y → z");
    // No edge was added by the check:
    assert.deepEqual(g.dependenciesOf("z"), []);
    assert.equal(g.wouldCycle("z", "w"), null);
  });

  test("unlink removes both directions and is idempotent", () => {
    const g = new AssetGraph();
    g.link("a", "b");
    g.unlink("a");
    assert.deepEqual(g.dependenciesOf("a"), []);
    assert.deepEqual(g.dependentsOf("b"), []);
    assert.equal(g.edgeCount, 0);
    g.unlink("a"); // no throw
    assert.equal(g.edgeCount, 0);
  });

  test("re-linking replaces rather than accumulates (registry retry semantics)", () => {
    const g = new AssetGraph();
    g.link("a", "b");
    g.unlink("a");
    g.link("a", "c");
    assert.deepEqual(g.dependenciesOf("a"), ["c"]);
    assert.deepEqual(g.dependentsOf("b"), []);
    assert.equal(g.edgeCount, 1);
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

group("Phase 15.2 — registry dependency graph", () => {
  test("registers edges from dependencies(value) when a load lands", async () => {
    const h = makeHarness();
    h.depLists.set("material:m", ["texture:t"]);
    h.registry.acquire(descriptor(h, "texture:t")).release();
    h.registry.acquire(descriptor(h, "material:m")).release();
    await flush();
    assert.deepEqual(h.registry.dependenciesOf("material:m"), ["texture:t"]);
    assert.deepEqual(h.registry.dependentsOf("texture:t"), ["material:m"]);
    assert.deepEqual(h.registry.subgraph("material:m", "deps"), ["texture:t"]);
    assert.equal(h.registry.stats().edges, 1);
  });

  test("rejects the edge that closes a cycle, with a logged error (resource still loads)", async () => {
    const h = makeHarness();
    h.depLists.set("a", ["b"]);
    h.depLists.set("b", ["a"]);
    const ha = h.registry.acquire(descriptor(h, "a"));
    const hb = h.registry.acquire(descriptor(h, "b"));
    await flush();
    assert.equal(ha.ready, true);
    assert.equal(hb.ready, true);
    // The first load to land registers its edge (no cycle exists yet); the second one would
    // close the cycle and is the one that gets rejected. So at most one edge survives, and
    // nothing ever depends on "a" (whose edge, if present, points at "b").
    assert.ok(h.registry.stats().edges <= 1);
    assert.deepEqual(h.registry.dependentsOf("a"), []);
    assert.equal(h.logErrors.some((m) => m.includes("dependency cycle")), true);
  });

  test("logs and survives a dependencies() callback that throws", async () => {
    const h = makeHarness();
    h.depLists.set("boom", []);
    const original = descriptor(h, "boom");
    const bad = { ...original, dependencies: () => {
      throw new Error("broken manifest");
    } };
    const handle = h.registry.acquire(bad);
    await flush();
    assert.equal(handle.ready, true);
    assert.equal(h.registry.stats().edges, 0);
    assert.equal(h.logErrors.some((m) => m.includes("dependencies() threw")), true);
  });

  test("blocks eviction of a dependency while a dependent is loaded", async () => {
    const h = makeHarness({ idleGraceMs: 0 });
    h.depLists.set("material:m", ["texture:t"]);
    h.registry.acquire(descriptor(h, "texture:t", 50)).release();
    const m = h.registry.acquire(descriptor(h, "material:m", 50)); // live handle → non-evictable
    await flush();
    // The texture is unreferenced and idle, but the loaded material embeds it. Nothing may evict.
    assert.equal(h.registry.evictIdle(), 0);
    assert.equal(h.registry.has("texture:t"), true);
    assert.equal(h.registry.has("material:m"), true);
    // Once the material is released the whole chain leaves in a single cascading call.
    m.release();
    assert.equal(h.registry.evictIdle(), 2);
    assert.equal(h.registry.has("texture:t"), false);
    assert.equal(h.registry.has("material:m"), false);
  });

  test("evicts a whole dependency chain in one call under a byte target", async () => {
    const h = makeHarness({ idleGraceMs: 60_000 }); // fresh entries survive grace eviction
    h.depLists.set("gltf:g", ["material:m"]);
    h.depLists.set("material:m", ["texture:t"]);
    h.registry.acquire(descriptor(h, "texture:t", 100)).release();
    h.registry.acquire(descriptor(h, "material:m", 100)).release();
    h.registry.acquire(descriptor(h, "gltf:g", 100)).release();
    await flush();
    assert.equal(h.registry.stats().bytes, 300);
    // No target: everything is within the grace window, so nothing is freed.
    assert.equal(h.registry.evictIdle(), 0);
    assert.equal(h.registry.stats().entries, 3);
    // A byte target ignores the grace period and cascades top-down through the chain.
    assert.equal(h.registry.evictIdle(50), 3);
    assert.equal(h.registry.stats().entries, 0);
    assert.equal(h.registry.stats().edges, 0);
  });

  test("a pinned dependent keeps the whole chain alive", async () => {
    const h = makeHarness({ idleGraceMs: 0 });
    h.depLists.set("gltf:g", ["material:m"]);
    h.depLists.set("material:m", ["texture:t"]);
    h.registry.acquire(descriptor(h, "texture:t")).release();
    h.registry.acquire(descriptor(h, "material:m")).release();
    h.registry.acquire(descriptor(h, "gltf:g")).pin();
    await flush();
    assert.equal(h.registry.evictIdle(), 0);
    assert.equal(h.registry.has("texture:t"), true);
  });

  test("retry re-registers edges from the new value", async () => {
    const h = makeHarness();
    h.depLists.set("material:m", ["texture:t"]);
    const handle = h.registry.acquire(descriptor(h, "material:m"));
    const texture = h.registry.acquire(descriptor(h, "texture:t"));
    await flush();
    h.depLists.set("material:m", ["texture:other"]);
    await h.registry.retry("material:m");
    await flush();
    assert.deepEqual(h.registry.dependenciesOf("material:m"), ["texture:other"]);
    assert.deepEqual(h.registry.dependentsOf("texture:t"), []);
    assert.equal(h.registry.stats().edges, 1);
    handle.release();
    texture.release();
  });

  test("invalidate releases the entry and reports the loaded transitive dependents", async () => {
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
    assert.deepEqual(reloadList, ["gltf:g"]);
    assert.deepEqual(seen, ["material:m"]);
    assert.equal(h.registry.has("material:m"), false);
    assert.equal(h.registry.has("texture:t"), true); // dependency survives its dependent
    assert.equal(h.registry.has("gltf:g"), true);
    g.release();
  });

  test("invalidate of an unknown id still emits and returns nothing", async () => {
    const h = makeHarness();
    const seen: string[] = [];
    h.registry.events.invalidated.on((e) => seen.push(e.id));
    assert.deepEqual(h.registry.invalidate("nope"), []);
    assert.deepEqual(seen, ["nope"]);
  });

  test("eviction and dispose clear the graph edges", async () => {
    const h = makeHarness();
    h.depLists.set("material:m", ["texture:t"]);
    h.registry.acquire(descriptor(h, "texture:t")).release();
    h.registry.acquire(descriptor(h, "material:m")).release();
    await flush();
    assert.equal(h.registry.stats().edges, 1);
    assert.equal(h.registry.evict("material:m"), true);
    assert.equal(h.registry.stats().edges, 0);
    assert.deepEqual(h.registry.dependentsOf("texture:t"), []);
    h.registry.dispose();
    assert.equal(h.registry.stats().edges, 0);
  });
});

// ---------------------------------------------------------------- content addressing (15.1 + registry)

group("Phase 15.1 — content-hash invalidation", () => {
  test("re-loads on a hash mismatch and names the loaded dependents", async () => {
    const h = makeHarness();
    h.depLists.set("material:m", ["texture:rocks"]);
    h.contentHashes.set("texture:rocks", H1);
    const first = h.registry.acquire(descriptor(h, "texture:rocks"));
    await flush();
    assert.equal(first.value, "texture:rocks#1");
    h.registry.acquire(descriptor(h, "material:m")).release();
    await flush();

    const events: { id: string; oldHash: string; newHash: string; dependents: string[] }[] = [];
    h.registry.events.contentChanged.on((e) => events.push(e));
    h.contentHashes.set("texture:rocks", H2);
    const second = h.registry.acquire(descriptor(h, "texture:rocks"));
    await flush();
    assert.equal(second.value, "texture:rocks#2");
    assert.equal(h.loadCount.get("texture:rocks"), 2);
    assertContains(h.disposals, "texture:rocks#1");
    assert.deepEqual(events, [{ id: "texture:rocks", oldHash: H1, newHash: H2, dependents: ["material:m"] }]);
    // The material is NOT auto-reloaded — it is the editor's job (15.4) to act on the list.
    assert.equal(h.loadCount.get("material:m"), 1);
  });

  test("treats an unchanged hash as a plain dedupe (no reload, no event)", async () => {
    const h = makeHarness();
    h.contentHashes.set("texture:rocks", H1);
    h.registry.acquire(descriptor(h, "texture:rocks"));
    await flush();
    const events: unknown[] = [];
    h.registry.events.contentChanged.on((e) => events.push(e));
    const second = h.registry.acquire(descriptor(h, "texture:rocks"));
    await flush();
    assert.equal(second.value, "texture:rocks#1");
    assert.equal(h.loadCount.get("texture:rocks"), 1);
    assert.deepEqual(events, []);
  });

  test("does not compare hashes when the descriptor has none (legacy behavior)", async () => {
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
    assert.equal(h.loadCount.get("texture:rocks"), 1);
  });

  test("registry.info exposes parsed AssetId metadata (null for legacy ids)", async () => {
    const h = makeHarness();
    const id = AssetId.forContent("texture", H1, "rocks.png");
    h.registry.acquire({
      id,
      kind: "texture",
      load: () => "v",
    });
    await flush();
    assert.deepEqual(h.registry.info(id), { kind: "texture", address: "content", hash: H1, name: "rocks.png" });
    assert.equal(h.registry.info("legacy-bare"), null);
  });
});

await finish();
