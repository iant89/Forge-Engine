/**
 * @suite rendering:renderGraph
 * @group unit
 * @covers engine/src/core/errors.ts
 * @covers engine/src/gpu/device.ts
 * @covers engine/src/index.ts
 * @covers engine/src/rendering/renderGraph.ts
 * @desc Render graph over the mock WebGPU device (docs/VERIFICATION.md#tests)
 */

export const suite = {
  name: "rendering:renderGraph",
  group: "unit",
  covers:   [
    "engine/src/core/errors.ts",
    "engine/src/gpu/device.ts",
    "engine/src/index.ts",
    "engine/src/rendering/renderGraph.ts"
  ],
  desc: "Render graph over the mock WebGPU device (docs/VERIFICATION.md#tests)",
};
/**
 * Render graph over the mock WebGPU device (docs/VERIFICATION.md#tests).
 *
 * What these prove: a mis-described frame is rejected before any command is recorded; passes nobody
 * consumes are dropped; same-shaped transients with disjoint lifetimes share memory; a steady-state
 * frame allocates nothing; retired shapes are destroyed; one execute is one submit wrapped in named
 * debug groups; dispose leaks nothing. Every assertion here runs against the mock's own validation
 * (attachment formats, view dimensions, bind-group signatures), so the passes are real passes.
 */

import assert from "node:assert/strict";
import { assertThrows, finish, group, test } from "selrun";
import { GraphicsDevice, RenderGraph, UsageError, type RenderGraphHandle, type RenderGraphOptions, type RenderGraphPassContext } from "@forge/engine";

const RT = 0x10; // GPUTextureUsage.RENDER_ATTACHMENT
const TB = 0x04; // GPUTextureUsage.TEXTURE_BINDING

async function setup(width = 64, height = 32, graphOptions: RenderGraphOptions = {}) {
  const device = await GraphicsDevice.create({ forceMock: true });
  device.resize(width, height);
  const mock = device.mock;
  const graph = new RenderGraph(device, graphOptions);
  return { device, mock, graph };
}

/** A pass body that opens and closes the described render pass (the mock validates the attachments). */
function touch(ctx: RenderGraphPassContext): void {
  ctx.beginRenderPass().end();
}

function colorDesc(width: number, height: number) {
  return { width, height, format: "rgba16float" as const, usage: RT | TB };
}

group("RenderGraph validation", () => {
  test("rejects a read of a transient nothing has written", async () => {
    const { device, mock, graph } = await setup();
    graph.begin();
    const swap = graph.importTexture("swapchain", device.currentTexture!);
    const hdr = graph.createTexture("hdr", colorDesc(64, 32));
    graph.addPass({ name: "resolve", reads: [hdr], color: [{ texture: swap }], execute: touch });
    assertThrows(() => graph.execute(), /reads "hdr" before any pass has written it/);
    // A rejected frame is discarded: the next thing must be begin(), not a retry.
    assertThrows(() => graph.execute(), UsageError);
    assert.equal((mock.commandLog.filter((e) => e.type === "submit")).length, 0);
    graph.dispose();
    await device.dispose();
  });

  test("rejects loading a transient's undefined contents", async () => {
    const { device, graph } = await setup();
    graph.begin();
    const swap = graph.importTexture("swapchain", device.currentTexture!);
    const hdr = graph.createTexture("hdr", colorDesc(64, 32));
    graph.addPass({ name: "accumulate", color: [{ texture: hdr, loadOp: "load" }], execute: touch });
    graph.addPass({ name: "resolve", reads: [hdr], color: [{ texture: swap }], execute: touch });
    assertThrows(() => graph.execute(), /loads "hdr" before any pass has written it/);
    graph.dispose();
    await device.dispose();
  });

  test("loading the swapchain is allowed (its contents are owned outside the graph)", async () => {
    const { device, mock, graph } = await setup();
    graph.begin();
    const swap = graph.importTexture("swapchain", device.currentTexture!);
    graph.addPass({ name: "overlay", color: [{ texture: swap, loadOp: "load" }], execute: touch });
    const stats = graph.execute();
    assert.deepEqual(stats.executed, ["overlay"]);
    assert.deepEqual(mock.errors, []);
    graph.dispose();
    await device.dispose();
  });

  test("rejects a pass that attaches one texture twice or samples its own attachment", async () => {
    const { device, graph } = await setup();
    graph.begin();
    const a = graph.createTexture("a", colorDesc(64, 32));
    const depth = graph.createTexture("d", { width: 64, height: 32, format: "depth24plus", usage: RT });
    assertThrows(() => graph.addPass({ name: "twice", color: [{ texture: a }, { texture: a }], execute: touch }), /attaches "a" twice/);
    assertThrows(() => graph.addPass({ name: "both", color: [{ texture: depth }], depth: { texture: depth }, execute: touch }), /both colour and depth/);
    assertThrows(() => graph.addPass({ name: "feedback", reads: [a], color: [{ texture: a }], execute: touch }), /both reads and writes "a"/);
    graph.dispose();
    await device.dispose();
  });

  test("rejects handles from a previous frame and calls outside begin()", async () => {
    const { device, graph } = await setup();
    assertThrows(() => graph.createTexture("x", colorDesc(8, 8)), /call begin\(\) first/);
    graph.begin();
    const stale = graph.createTexture("stale", colorDesc(8, 8));
    graph.execute();
    graph.begin();
    assertThrows(() => graph.addPass({ name: "p", color: [{ texture: stale }], execute: touch }), /does not belong to this frame/);
    assertThrows(() => graph.createTexture("bad", { width: 0, height: 8, format: "rgba8unorm", usage: RT }), /at least 1x1/);
    graph.dispose();
    assertThrows(() => graph.begin(), /disposed/);
    await device.dispose();
  });
});

group("RenderGraph culling and dependencies", () => {
  test("drops passes nobody consumes unless they write an imported texture or are flagged sideEffect", async () => {
    const { device, mock, graph } = await setup();
    const ran: string[] = [];
    const body = (ctx: RenderGraphPassContext) => {
      ran.push(ctx.passName);
      touch(ctx);
    };
    graph.begin();
    const swap = graph.importTexture("swapchain", device.currentTexture!);
    const orphan = graph.createTexture("orphan", colorDesc(64, 32));
    const probe = graph.createTexture("probe", colorDesc(16, 16));
    const hdr = graph.createTexture("hdr", colorDesc(64, 32));
    graph.addPass({ name: "orphan", color: [{ texture: orphan }], execute: body });
    graph.addPass({ name: "probe", color: [{ texture: probe }], sideEffect: true, execute: body });
    graph.addPass({ name: "main", color: [{ texture: hdr }], execute: body });
    graph.addPass({ name: "resolve", reads: [hdr], color: [{ texture: swap }], execute: body });
    const stats = graph.execute();
    assert.deepEqual(ran, ["probe", "main", "resolve"]);
    assert.deepEqual(stats.executed, ["probe", "main", "resolve"]);
    assert.equal(stats.passes, 4);
    assert.equal(stats.culledPasses, 1);
    // The orphan never got a physical texture either.
    assert.equal(stats.transientTextures, 2);
    assert.equal(stats.physicalTextures, 2);
    assert.deepEqual(mock.errors, []);
    graph.dispose();
    await device.dispose();
  });

  test("keeps every writer of a layered texture alive when a later pass reads the whole texture", async () => {
    const { device, mock, graph } = await setup();
    const ran: string[] = [];
    const body = (ctx: RenderGraphPassContext) => {
      ran.push(ctx.passName);
      touch(ctx);
    };
    graph.begin();
    const swap = graph.importTexture("swapchain", device.currentTexture!);
    const atlas = graph.createTexture("atlas", { width: 32, height: 32, format: "depth24plus", usage: RT | TB, depthOrArrayLayers: 3 });
    for (let layer = 0; layer < 3; layer++) {
      graph.addPass({ name: `shadow.${layer}`, depth: { texture: atlas, view: { arrayLayer: layer } }, execute: body });
    }
    graph.addPass({ name: "main", reads: [atlas], color: [{ texture: swap }], execute: (ctx) => {
      // A 2d-array view of the whole atlas is what the forward shader binds.
      assert.equal(ctx.view(atlas, { dimension: "2d-array" }), ctx.view(atlas, { dimension: "2d-array" }));
      body(ctx);
    } });
    const stats = graph.execute();
    assert.deepEqual(ran, ["shadow.0", "shadow.1", "shadow.2", "main"]);
    assert.equal(stats.culledPasses, 0);
    assert.deepEqual(mock.errors, []);
    graph.dispose();
    await device.dispose();
  });

  test("a load write depends on the previous writer, a clear write does not", async () => {
    const { device, graph } = await setup();
    const ran: string[] = [];
    const body = (ctx: RenderGraphPassContext) => {
      ran.push(ctx.passName);
      touch(ctx);
    };
    graph.begin();
    const swap = graph.importTexture("swapchain", device.currentTexture!);
    const mip = graph.createTexture("mip", colorDesc(32, 16));
    graph.addPass({ name: "down", color: [{ texture: mip }], execute: body });
    graph.addPass({ name: "up", color: [{ texture: mip, loadOp: "load" }], execute: body });
    graph.addPass({ name: "resolve", reads: [mip], color: [{ texture: swap }], execute: body });
    graph.execute();
    assert.deepEqual(ran, ["down", "up", "resolve"]);

    graph.begin();
    const swap2 = graph.importTexture("swapchain", device.currentTexture!);
    const scratch = graph.createTexture("scratch", colorDesc(32, 16));
    ran.length = 0;
    graph.addPass({ name: "first", color: [{ texture: scratch }], execute: body });
    graph.addPass({ name: "second", color: [{ texture: scratch }], execute: body }); // clears: fresh version
    graph.addPass({ name: "resolve", reads: [scratch], color: [{ texture: swap2 }], execute: body });
    const stats = graph.execute();
    // "first" produced a version nobody read; only "second" feeds the resolve.
    assert.deepEqual(ran, ["second", "resolve"]);
    assert.equal(stats.culledPasses, 1);
    graph.dispose();
    await device.dispose();
  });
});

group("RenderGraph memory planning", () => {
  test("aliases same-shaped transients with disjoint live ranges onto one physical texture", async () => {
    const { device, mock, graph } = await setup();
    const seen = new Map<string, GPUTexture>();
    graph.begin();
    const swap = graph.importTexture("swapchain", device.currentTexture!);
    const a = graph.createTexture("a", colorDesc(64, 32));
    const b = graph.createTexture("b", colorDesc(64, 32));
    const keep = graph.createTexture("keep", colorDesc(64, 32));
    graph.addPass({ name: "writeA", color: [{ texture: a }], execute: (ctx) => { seen.set("a", ctx.texture(a)); touch(ctx); } });
    graph.addPass({ name: "writeKeep", reads: [a], color: [{ texture: keep }], execute: (ctx) => { seen.set("keep", ctx.texture(keep)); touch(ctx); } });
    graph.addPass({ name: "writeB", color: [{ texture: b }], execute: (ctx) => { seen.set("b", ctx.texture(b)); touch(ctx); } });
    graph.addPass({ name: "resolve", reads: [b, keep], color: [{ texture: swap }], execute: touch });
    const stats = graph.execute();
    assert.equal(stats.transientTextures, 3);
    assert.equal(stats.physicalTextures, 2);
    assert.equal(seen.get("a"), seen.get("b"));
    assert.notEqual(seen.get("a"), seen.get("keep"));
    assert.equal(stats.aliasedBytes, 64 * 32 * 8);
    assert.equal(stats.texturesCreated, 2);
    assert.deepEqual(mock.errors, []);
    graph.dispose();
    await device.dispose();
  });

  test("does not alias transients whose live ranges overlap or whose descriptors differ", async () => {
    const { device, graph } = await setup();
    graph.begin();
    const swap = graph.importTexture("swapchain", device.currentTexture!);
    const a = graph.createTexture("a", colorDesc(64, 32));
    const b = graph.createTexture("b", colorDesc(64, 32));
    const c = graph.createTexture("c", colorDesc(32, 32));
    graph.addPass({ name: "writeA", color: [{ texture: a }], execute: touch });
    graph.addPass({ name: "writeB", reads: [a], color: [{ texture: b }], execute: touch }); // a still live here
    graph.addPass({ name: "writeC", reads: [b], color: [{ texture: c }], execute: touch });
    graph.addPass({ name: "resolve", reads: [c], color: [{ texture: swap }], execute: touch });
    const stats = graph.execute();
    assert.equal(stats.physicalTextures, 3);
    assert.equal(stats.aliasedBytes, 0);
    graph.dispose();
    await device.dispose();
  });

  test("re-executing the same topology allocates nothing and keeps texture identity", async () => {
    const { device, mock, graph } = await setup();
    const frame = (record: (t: GPUTexture) => void) => {
      graph.begin();
      const swap = graph.importTexture("swapchain", device.currentTexture!);
      const hdr = graph.createTexture("hdr", colorDesc(64, 32));
      const depth = graph.createTexture("depth", { width: 64, height: 32, format: "depth24plus", usage: RT });
      graph.addPass({ name: "main", color: [{ texture: hdr }], depth: { texture: depth }, execute: (ctx) => { record(ctx.texture(hdr)); touch(ctx); } });
      graph.addPass({ name: "resolve", reads: [hdr], color: [{ texture: swap }], execute: touch });
      return graph.execute();
    };
    const textures: GPUTexture[] = [];
    const first = frame((t) => textures.push(t));
    assert.equal(first.texturesCreated, 2);
    const epoch = graph.allocationEpoch;
    const createdBefore = device.gpuMemory.texturesCreated;
    for (let i = 0; i < 5; i++) {
      const s = frame((t) => textures.push(t));
      assert.equal(s.texturesCreated, 0);
      assert.equal(s.texturesDestroyed, 0);
    }
    assert.equal(device.gpuMemory.texturesCreated, createdBefore);
    assert.equal(graph.allocationEpoch, epoch);
    assert.equal(new Set(textures).size, 1);
    assert.deepEqual(mock.errors, []);
    graph.dispose();
    await device.dispose();
  });

  test("retires shapes that stop being used after the idle grace period, and dispose releases the rest", async () => {
    const { device, mock, graph } = await setup();
    const frame = (withBloom: boolean) => {
      graph.begin();
      const swap = graph.importTexture("swapchain", device.currentTexture!);
      const hdr = graph.createTexture("hdr", colorDesc(64, 32));
      graph.addPass({ name: "main", color: [{ texture: hdr }], execute: touch });
      let src = hdr;
      if (withBloom) {
        const half = graph.createTexture("bloom", colorDesc(32, 16));
        graph.addPass({ name: "bloom", reads: [hdr], color: [{ texture: half }], execute: touch });
        src = half;
      }
      graph.addPass({ name: "resolve", reads: [src, hdr], color: [{ texture: swap }], execute: touch });
      return graph.execute();
    };
    frame(true);
    assert.equal(graph.pooledTextureCount, 2);
    frame(false); // idle 1
    frame(false); // idle 2 (grace = 2 frames)
    assert.equal(graph.pooledTextureCount, 2);
    const s = frame(false); // idle 3 → destroyed
    assert.equal(s.texturesDestroyed, 1);
    assert.equal(graph.pooledTextureCount, 1);
    assert.equal((mock.outstanding.textures.filter((t) => t.startsWith("rg."))).length, 1);
    // Flipping back creates the shape again (a new epoch, so cached bind groups know to drop it).
    const epoch = graph.allocationEpoch;
    assert.equal(frame(true).texturesCreated, 1);
    assert.ok(graph.allocationEpoch > epoch);
    graph.dispose();
    assert.deepEqual(mock.outstanding.textures.filter((t) => t.startsWith("rg.")), []);
    assert.equal(graph.pooledTextureCount, 0);
    assert.deepEqual(mock.errors, []);
    await device.dispose();
  });
});

group("RenderGraph recording", () => {
  test("records one command buffer per execute with a named debug group around each pass", async () => {
    const { device, mock, graph } = await setup();
    graph.begin();
    const swap = graph.importTexture("swapchain", device.currentTexture!);
    const hdr = graph.createTexture("hdr", colorDesc(64, 32));
    graph.addPass({ name: "forge.main", color: [{ texture: hdr }], execute: touch });
    graph.addPass({ name: "forge.tonemap", reads: [hdr], color: [{ texture: swap }], execute: touch });
    const submitsBefore = mock.submitCount;
    const logStart = mock.commandLog.length;
    graph.execute();
    assert.equal(mock.submitCount, submitsBefore + 1);
    assert.equal((mock.commandLog.slice(logStart).filter((e) => e.type === "submit")).length, 1);
    const groups = mock.commandLog.slice(logStart).filter((e) => e.type === "debugGroup") as { label?: string; push?: boolean; pop?: boolean }[];
    assert.deepEqual(groups.map((g) => (g.push ? `push:${g.label}` : "pop")), ["push:forge.main", "pop", "push:forge.tonemap", "pop"]);
    assert.deepEqual(mock.passes.map((p) => p.label), ["forge.main", "forge.tonemap"]);
    assert.deepEqual(mock.errors, []);
    graph.dispose();
    await device.dispose();
  });

  test("keeps rendering when timestamp-query is not supported", async () => {
    const device = await GraphicsDevice.create({ forceMock: true });
    device.resize(64, 32);
    (device.caps as { timestampQuery: boolean }).timestampQuery = false;
    const mock = device.mock;
    const graph = new RenderGraph(device, { gpuTimestamps: true });
    graph.begin();
    const swap = graph.importTexture("swapchain", device.currentTexture!);
    graph.addPass({ name: "present", color: [{ texture: swap }], execute: touch });
    const stats = graph.execute();
    assert.equal(stats.gpuTimingAvailable, false);
    assert.deepEqual(mock.outstanding.buffers.filter((label) => label.startsWith("forge.timestamps")), []);
    assert.deepEqual(mock.errors, []);
    graph.dispose();
    await device.dispose();
  });

  test("reads asynchronous render and compute pass timestamps without blocking execute", async () => {
    const { device, mock, graph } = await setup(64, 32, { gpuTimestamps: true });
    let completed: { frameIndex: number; frameTimeMs: number; renderTimeMs: number; computeTimeMs: number; passes: readonly { name: string; kind: string; ms: number }[] } | null = null;
    graph.begin();
    const swap = graph.importTexture("swapchain", device.currentTexture!);
    graph.addPass({ name: "forge.main", color: [{ texture: swap }], execute: (ctx) => ctx.beginRenderPass().end() });
    graph.addPass({ name: "objects.cull", sideEffect: true, execute: (ctx) => ctx.beginComputePass("objects.cull").end() });
    const stats = graph.execute((timing) => { completed = timing; });

    assert.equal(stats.gpuTimingAvailable, true);
    assert.equal(completed, null); // mapAsync resolves after execute has returned
    assert.equal(mock.commandLog.some((entry) => entry.type === "resolveQueries"), true);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    assert.notEqual(completed, null);
    assert.ok(completed!.frameTimeMs > 0);
    assert.ok(completed!.renderTimeMs > 0);
    assert.ok(completed!.computeTimeMs > 0);
    assert.deepEqual(completed!.passes.map((pass) => [pass.name, pass.kind]), [
      ["forge.main", "render"],
      ["objects.cull", "compute"],
    ]);
    assert.equal((graph.stats.gpuPassTimes).length, 2);
    assert.equal(graph.stats.gpuFrameTimeMs, completed!.frameTimeMs);
    assert.deepEqual(mock.errors, []);
    graph.dispose();
    await device.dispose();
  });

  test("gives passes attachment views in the shapes they declared", async () => {
    const { device, mock, graph } = await setup();
    let format: GPUTextureFormat | null = null;
    let size: { width: number; height: number } | null = null;
    graph.begin();
    const swap = graph.importTexture("swapchain", device.currentTexture!);
    const atlas = graph.createTexture("atlas", { width: 16, height: 16, format: "depth24plus", usage: RT | TB, depthOrArrayLayers: 2 });
    const hdr = graph.createTexture("hdr", colorDesc(64, 32));
    graph.addPass({ name: "shadow", depth: { texture: atlas, view: { arrayLayer: 1 } }, execute: touch });
    graph.addPass({ name: "main", reads: [atlas], color: [{ texture: hdr }], execute: (ctx) => {
      format = ctx.colorFormat(0);
      size = ctx.size(hdr);
      touch(ctx);
    } });
    graph.addPass({ name: "resolve", reads: [hdr], color: [{ texture: swap }], execute: (ctx) => {
      assert.equal(ctx.colorFormat(0), device.format);
      assertThrows(() => ctx.colorFormat(1), UsageError);
      touch(ctx);
    } });
    graph.execute();
    assert.equal(format, "rgba16float");
    assert.deepEqual(size, { width: 64, height: 32 });
    assert.deepEqual(mock.errors, []);
    graph.dispose();
    await device.dispose();
  });
});

// Keep the handle type in the public surface honest: it is a branded number, not an object.
const _handleIsNumber: RenderGraphHandle extends number ? true : false = true;
void _handleIsNumber;

await finish();
