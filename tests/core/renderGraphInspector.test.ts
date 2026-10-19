/**
 * @suite core:renderGraphInspector
 * @group unit
 * @covers engine/src/debug/renderGraphInspector.ts
 * @covers engine/src/rendering/renderGraph.ts
 * @covers engine/src/index.ts
 * @desc Phase 21.3 — render graph snapshot, culling, dependencies and aliasing
 */

export const suite = {
  name: "core:renderGraphInspector",
  group: "unit",
  covers: ["engine/src/debug/renderGraphInspector.ts", "engine/src/rendering/renderGraph.ts", "engine/src/index.ts"],
  desc: "Phase 21.3 — render graph snapshot, culling, dependencies and aliasing",
};

import assert from "node:assert/strict";
import { finish, group, test } from "selrun";
import { GraphicsDevice, RenderGraph, TextureUsage, UsageError, formatRenderGraph, inspectRenderGraph, type RenderGraphPassContext } from "@forge/engine";

const renderTarget = TextureUsage.RENDER_ATTACHMENT | TextureUsage.TEXTURE_BINDING;
const color = (width: number, height: number) => ({ width, height, format: "rgba16float" as const, usage: renderTarget });
const draw = (context: RenderGraphPassContext): void => { context.beginRenderPass().end(); };

group("render graph inspector", () => {
  test("reports last-frame pass liveness, reasons, dependencies, alias slots and pool bytes", async () => {
    const device = await GraphicsDevice.create({ forceMock: true });
    device.resize(64, 32);
    const graph = new RenderGraph(device);
    assert.throws(() => graph.inspect(), UsageError);

    graph.begin();
    const swapchain = graph.importTexture("swapchain", device.currentTexture!);
    const hdr = graph.createTexture("hdr", color(64, 32));
    const unused = graph.createTexture("debugDump", color(16, 16));
    graph.addPass({ name: "forward", color: [{ texture: hdr }], execute: draw });
    graph.addPass({ name: "debug", color: [{ texture: unused }], execute: draw });
    graph.addPass({ name: "tonemap", reads: [hdr], color: [{ texture: swapchain }], execute: draw });
    graph.execute();

    const view = inspectRenderGraph(graph);
    assert.deepEqual(view.passes.map((pass) => [pass.name, pass.live]), [["forward", true], ["debug", false], ["tonemap", true]]);
    assert.deepEqual(view.culled, ["debug"]);
    assert.equal(view.passes[0]!.reason, "feeds a live pass");
    assert.equal(view.passes[1]!.reason, "nothing consumes its output");
    assert.equal(view.passes[2]!.reason, "writes an imported target");
    assert.deepEqual(view.passes[2]!.reads, ["hdr"]);
    assert.deepEqual(view.passes[2]!.dependsOn, ["forward"]);
    assert.deepEqual(view.passes[0]!.writes, ["hdr"]);

    const hdrResource = view.resources.find((resource) => resource.name === "hdr")!;
    assert.deepEqual([hdrResource.firstUse, hdrResource.lastUse, hdrResource.physical >= 0, hdrResource.bytes], [0, 1, true, 64 * 32 * 8]);
    assert.equal(view.resources.find((resource) => resource.name === "debugDump")!.physical, -1);
    assert.equal(view.resources.find((resource) => resource.name === "swapchain")!.imported, true);
    assert.equal(view.pool.length, 1);
    assert.equal(view.pooledBytes, hdrResource.bytes);
    assert.equal(view.gpuFrameMs, null);
    assert.match(formatRenderGraph(view), /3 passes \(1 culled\)[\s\S]*○ debug/);

    graph.begin();
    assert.throws(() => graph.inspect(), UsageError, "a new frame invalidates the prior inspection snapshot");
    graph.dispose();
    await device.dispose();
  });
});

finish();
