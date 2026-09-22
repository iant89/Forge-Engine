/**
 * Render graph over the mock WebGPU device (docs/VERIFICATION.md#tests).
 *
 * What these prove: a mis-described frame is rejected before any command is recorded; passes nobody
 * consumes are dropped; same-shaped transients with disjoint lifetimes share memory; a steady-state
 * frame allocates nothing; retired shapes are destroyed; one execute is one submit wrapped in named
 * debug groups; dispose leaks nothing. Every assertion here runs against the mock's own validation
 * (attachment formats, view dimensions, bind-group signatures), so the passes are real passes.
 */

import { describe, expect, it } from "vitest";
import { GraphicsDevice, RenderGraph, UsageError, type RenderGraphHandle, type RenderGraphPassContext } from "@forge/engine";

const RT = 0x10; // GPUTextureUsage.RENDER_ATTACHMENT
const TB = 0x04; // GPUTextureUsage.TEXTURE_BINDING

async function setup(width = 64, height = 32) {
  const device = await GraphicsDevice.create({ forceMock: true });
  device.resize(width, height);
  const mock = device.mock;
  const graph = new RenderGraph(device);
  return { device, mock, graph };
}

/** A pass body that opens and closes the described render pass (the mock validates the attachments). */
function touch(ctx: RenderGraphPassContext): void {
  ctx.beginRenderPass().end();
}

function colorDesc(width: number, height: number) {
  return { width, height, format: "rgba16float" as const, usage: RT | TB };
}

describe("RenderGraph validation", () => {
  it("rejects a read of a transient nothing has written", async () => {
    const { device, mock, graph } = await setup();
    graph.begin();
    const swap = graph.importTexture("swapchain", device.currentTexture!);
    const hdr = graph.createTexture("hdr", colorDesc(64, 32));
    graph.addPass({ name: "resolve", reads: [hdr], color: [{ texture: swap }], execute: touch });
    expect(() => graph.execute()).toThrow(/reads "hdr" before any pass has written it/);
    // A rejected frame is discarded: the next thing must be begin(), not a retry.
    expect(() => graph.execute()).toThrow(UsageError);
    expect(mock.commandLog.filter((e) => e.type === "submit")).toHaveLength(0);
    graph.dispose();
    await device.dispose();
  });

  it("rejects loading a transient's undefined contents", async () => {
    const { device, graph } = await setup();
    graph.begin();
    const swap = graph.importTexture("swapchain", device.currentTexture!);
    const hdr = graph.createTexture("hdr", colorDesc(64, 32));
    graph.addPass({ name: "accumulate", color: [{ texture: hdr, loadOp: "load" }], execute: touch });
    graph.addPass({ name: "resolve", reads: [hdr], color: [{ texture: swap }], execute: touch });
    expect(() => graph.execute()).toThrow(/loads "hdr" before any pass has written it/);
    graph.dispose();
    await device.dispose();
  });

  it("loading the swapchain is allowed (its contents are owned outside the graph)", async () => {
    const { device, mock, graph } = await setup();
    graph.begin();
    const swap = graph.importTexture("swapchain", device.currentTexture!);
    graph.addPass({ name: "overlay", color: [{ texture: swap, loadOp: "load" }], execute: touch });
    const stats = graph.execute();
    expect(stats.executed).toEqual(["overlay"]);
    expect(mock.errors).toEqual([]);
    graph.dispose();
    await device.dispose();
  });

  it("rejects a pass that attaches one texture twice or samples its own attachment", async () => {
    const { device, graph } = await setup();
    graph.begin();
    const a = graph.createTexture("a", colorDesc(64, 32));
    const depth = graph.createTexture("d", { width: 64, height: 32, format: "depth24plus", usage: RT });
    expect(() => graph.addPass({ name: "twice", color: [{ texture: a }, { texture: a }], execute: touch })).toThrow(/attaches "a" twice/);
    expect(() => graph.addPass({ name: "both", color: [{ texture: depth }], depth: { texture: depth }, execute: touch })).toThrow(/both colour and depth/);
    expect(() => graph.addPass({ name: "feedback", reads: [a], color: [{ texture: a }], execute: touch })).toThrow(/both reads and writes "a"/);
    graph.dispose();
    await device.dispose();
  });

  it("rejects handles from a previous frame and calls outside begin()", async () => {
    const { device, graph } = await setup();
    expect(() => graph.createTexture("x", colorDesc(8, 8))).toThrow(/call begin\(\) first/);
    graph.begin();
    const stale = graph.createTexture("stale", colorDesc(8, 8));
    graph.execute();
    graph.begin();
    expect(() => graph.addPass({ name: "p", color: [{ texture: stale }], execute: touch })).toThrow(/does not belong to this frame/);
    expect(() => graph.createTexture("bad", { width: 0, height: 8, format: "rgba8unorm", usage: RT })).toThrow(/at least 1x1/);
    graph.dispose();
    expect(() => graph.begin()).toThrow(/disposed/);
    await device.dispose();
  });
});

describe("RenderGraph culling and dependencies", () => {
  it("drops passes nobody consumes unless they write an imported texture or are flagged sideEffect", async () => {
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
    expect(ran).toEqual(["probe", "main", "resolve"]);
    expect(stats.executed).toEqual(["probe", "main", "resolve"]);
    expect(stats.passes).toBe(4);
    expect(stats.culledPasses).toBe(1);
    // The orphan never got a physical texture either.
    expect(stats.transientTextures).toBe(2);
    expect(stats.physicalTextures).toBe(2);
    expect(mock.errors).toEqual([]);
    graph.dispose();
    await device.dispose();
  });

  it("keeps every writer of a layered texture alive when a later pass reads the whole texture", async () => {
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
      expect(ctx.view(atlas, { dimension: "2d-array" })).toBe(ctx.view(atlas, { dimension: "2d-array" }));
      body(ctx);
    } });
    const stats = graph.execute();
    expect(ran).toEqual(["shadow.0", "shadow.1", "shadow.2", "main"]);
    expect(stats.culledPasses).toBe(0);
    expect(mock.errors).toEqual([]);
    graph.dispose();
    await device.dispose();
  });

  it("a load write depends on the previous writer, a clear write does not", async () => {
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
    expect(ran).toEqual(["down", "up", "resolve"]);

    graph.begin();
    const swap2 = graph.importTexture("swapchain", device.currentTexture!);
    const scratch = graph.createTexture("scratch", colorDesc(32, 16));
    ran.length = 0;
    graph.addPass({ name: "first", color: [{ texture: scratch }], execute: body });
    graph.addPass({ name: "second", color: [{ texture: scratch }], execute: body }); // clears: fresh version
    graph.addPass({ name: "resolve", reads: [scratch], color: [{ texture: swap2 }], execute: body });
    const stats = graph.execute();
    // "first" produced a version nobody read; only "second" feeds the resolve.
    expect(ran).toEqual(["second", "resolve"]);
    expect(stats.culledPasses).toBe(1);
    graph.dispose();
    await device.dispose();
  });
});

describe("RenderGraph memory planning", () => {
  it("aliases same-shaped transients with disjoint live ranges onto one physical texture", async () => {
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
    expect(stats.transientTextures).toBe(3);
    expect(stats.physicalTextures).toBe(2);
    expect(seen.get("a")).toBe(seen.get("b"));
    expect(seen.get("a")).not.toBe(seen.get("keep"));
    expect(stats.aliasedBytes).toBe(64 * 32 * 8);
    expect(stats.texturesCreated).toBe(2);
    expect(mock.errors).toEqual([]);
    graph.dispose();
    await device.dispose();
  });

  it("does not alias transients whose live ranges overlap or whose descriptors differ", async () => {
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
    expect(stats.physicalTextures).toBe(3);
    expect(stats.aliasedBytes).toBe(0);
    graph.dispose();
    await device.dispose();
  });

  it("re-executing the same topology allocates nothing and keeps texture identity", async () => {
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
    expect(first.texturesCreated).toBe(2);
    const epoch = graph.allocationEpoch;
    const createdBefore = device.gpuMemory.texturesCreated;
    for (let i = 0; i < 5; i++) {
      const s = frame((t) => textures.push(t));
      expect(s.texturesCreated).toBe(0);
      expect(s.texturesDestroyed).toBe(0);
    }
    expect(device.gpuMemory.texturesCreated).toBe(createdBefore);
    expect(graph.allocationEpoch).toBe(epoch);
    expect(new Set(textures).size).toBe(1);
    expect(mock.errors).toEqual([]);
    graph.dispose();
    await device.dispose();
  });

  it("retires shapes that stop being used after the idle grace period, and dispose releases the rest", async () => {
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
    expect(graph.pooledTextureCount).toBe(2);
    frame(false); // idle 1
    frame(false); // idle 2 (grace = 2 frames)
    expect(graph.pooledTextureCount).toBe(2);
    const s = frame(false); // idle 3 → destroyed
    expect(s.texturesDestroyed).toBe(1);
    expect(graph.pooledTextureCount).toBe(1);
    expect(mock.outstanding.textures.filter((t) => t.startsWith("rg."))).toHaveLength(1);
    // Flipping back creates the shape again (a new epoch, so cached bind groups know to drop it).
    const epoch = graph.allocationEpoch;
    expect(frame(true).texturesCreated).toBe(1);
    expect(graph.allocationEpoch).toBeGreaterThan(epoch);
    graph.dispose();
    expect(mock.outstanding.textures.filter((t) => t.startsWith("rg."))).toEqual([]);
    expect(graph.pooledTextureCount).toBe(0);
    expect(mock.errors).toEqual([]);
    await device.dispose();
  });
});

describe("RenderGraph recording", () => {
  it("records one command buffer per execute with a named debug group around each pass", async () => {
    const { device, mock, graph } = await setup();
    graph.begin();
    const swap = graph.importTexture("swapchain", device.currentTexture!);
    const hdr = graph.createTexture("hdr", colorDesc(64, 32));
    graph.addPass({ name: "forge.main", color: [{ texture: hdr }], execute: touch });
    graph.addPass({ name: "forge.tonemap", reads: [hdr], color: [{ texture: swap }], execute: touch });
    const submitsBefore = mock.submitCount;
    const logStart = mock.commandLog.length;
    graph.execute();
    expect(mock.submitCount).toBe(submitsBefore + 1);
    expect(mock.commandLog.slice(logStart).filter((e) => e.type === "submit")).toHaveLength(1);
    const groups = mock.commandLog.slice(logStart).filter((e) => e.type === "debugGroup") as { label?: string; push?: boolean; pop?: boolean }[];
    expect(groups.map((g) => (g.push ? `push:${g.label}` : "pop"))).toEqual(["push:forge.main", "pop", "push:forge.tonemap", "pop"]);
    expect(mock.passes.map((p) => p.label)).toEqual(["forge.main", "forge.tonemap"]);
    expect(mock.errors).toEqual([]);
    graph.dispose();
    await device.dispose();
  });

  it("gives passes attachment views in the shapes they declared", async () => {
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
      expect(ctx.colorFormat(0)).toBe(device.format);
      expect(() => ctx.colorFormat(1)).toThrow(UsageError);
      touch(ctx);
    } });
    graph.execute();
    expect(format).toBe("rgba16float");
    expect(size).toEqual({ width: 64, height: 32 });
    expect(mock.errors).toEqual([]);
    graph.dispose();
    await device.dispose();
  });
});

// Keep the handle type in the public surface honest: it is a branded number, not an object.
const _handleIsNumber: RenderGraphHandle extends number ? true : false = true;
void _handleIsNumber;
