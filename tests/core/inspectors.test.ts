/**
 * @suite core:inspectors
 * @group unit
 * @covers engine/src/debug/ecsInspector.ts
 * @covers engine/src/debug/renderGraphInspector.ts
 * @covers engine/src/debug/gpuResourceInspector.ts
 * @covers engine/src/rendering/renderGraph.ts
 * @covers engine/src/gpu/device.ts
 * @desc Phase 21 inspectors: ECS snapshot, render graph frame record, live GPU resource list
 */

export const suite = {
  name: "core:inspectors",
  group: "unit",
  covers:   [
    "engine/src/debug/ecsInspector.ts",
    "engine/src/debug/renderGraphInspector.ts",
    "engine/src/debug/gpuResourceInspector.ts",
    "engine/src/rendering/renderGraph.ts",
    "engine/src/gpu/device.ts"
  ],
  desc: "Phase 21 inspectors: ECS snapshot, render graph frame record, live GPU resource list",
};
import assert from "node:assert/strict";
import { finish, group, test } from "selrun";
import {
  BufferUsage,
  Component,
  EntityWorld,
  GraphicsDevice,
  Profiler,
  registerComponent,
  RenderGraph,
  formatGpuResources,
  formatRenderGraph,
  groupOfLabel,
  inspectEcs,
  inspectEntity,
  inspectGpuResources,
  inspectRenderGraph,
  summariseFields,
  type RenderGraphPassContext,
  type SystemContext,
} from "@forge/engine";

const RT = 0x10;
const TB = 0x04;
const touch = (ctx: RenderGraphPassContext) => ctx.beginRenderPass().end();
const colorDesc = (w: number, h: number) => ({ width: w, height: h, format: "rgba16float" as const, usage: RT | TB });

class Health extends Component {
  hp = 75;
  label = "crate";
  readonly velocity = { x: 1, y: 2, z: 3 };
  readonly samples = new Float32Array([1, 2]);
  readonly big = new Float32Array(64);
  readonly nested = { deep: { no: 1 } };
}
registerComponent(Health);

group("ecs", () => {
  test("lists systems in run order with profiler time, entities, components and fields", () => {
    const world = new EntityWorld();
    const profiler = new Profiler();
    world.registerSystem({ name: "physics", order: 300, enabled: true, update() {}, stats: () => ({ bodies: 2 }) });
    world.registerSystem({ name: "late", order: 900, enabled: false, update() {} });
    const ea = world.createEntity("crate-a");
    ea.add(new Health());
    const a = ea.id;
    const b = world.createEntity("lamp").id;
    world.setParent(b, a);
    world.systemByName("transforms")!.enabled = false;
    world.runSystems({ profiler } as unknown as SystemContext);

    const snap = inspectEcs(world, { profiler });
    const names = snap.systems.map((s) => s.name);
    assert.ok(names.indexOf("physics") < names.indexOf("late"));
    const physics = snap.systems.find((s) => s.name === "physics")!;
    assert.equal(physics.label, "physics:physics");
    assert.ok(physics.ms >= 0 && profiler.scopeStats("physics:physics") !== undefined);
    assert.deepEqual(physics.stats, { bodies: 2 });
    assert.equal(snap.systems.find((s) => s.name === "late")!.enabled, false);
    assert.equal(snap.entities, world.liveEntityCount);
    const lamp = snap.list.find((e) => e.name === "lamp")!;
    assert.equal(lamp.parent, a);

    assert.deepEqual(inspectEcs(world, { filter: "Health" }).list.map((e) => e.id), [a]);
    assert.deepEqual(inspectEcs(world, { filter: "LAMP" }).list.map((e) => e.id), [b]);
    const capped = inspectEcs(world, { limit: 1 });
    assert.equal(capped.list.length, 1);
    assert.equal(capped.truncated, true);

    const detail = inspectEntity(world, a)!;
    const health = detail.detail.find((c) => c.type === "Health")!;
    assert.deepEqual(health.fields, { hp: 75, label: "crate", velocity: [1, 2, 3], samples: [1, 2] });
    world.destroyEntity(b);
    assert.equal(inspectEntity(world, b), null);
    assert.deepEqual(summariseFields({ q: { x: 0, y: 0, z: 0, w: 1 }, p: [1, 2] }), { q: [0, 0, 0, 1], p: [1, 2] });
  });
});

group("render graph", () => {
  test("records passes, culled reasons, dependencies and alias slots of the last frame", async () => {
    const device = await GraphicsDevice.create({ forceMock: true });
    device.resize(64, 32);
    const graph = new RenderGraph(device);
    graph.begin();
    const swap = graph.importTexture("swapchain", device.currentTexture!);
    const hdr = graph.createTexture("hdr", colorDesc(64, 32));
    const unused = graph.createTexture("debugDump", colorDesc(16, 16));
    graph.addPass({ name: "forward", color: [{ texture: hdr }], execute: touch });
    graph.addPass({ name: "debug", color: [{ texture: unused }], execute: touch });
    graph.addPass({ name: "tonemap", reads: [hdr], color: [{ texture: swap }], execute: touch });
    graph.execute();

    const view = inspectRenderGraph(graph);
    assert.deepEqual(view.passes.map((p) => [p.name, p.live]), [["forward", true], ["debug", false], ["tonemap", true]]);
    assert.deepEqual(view.culled, ["debug"]);
    assert.equal(view.passes[1]!.reason, "nothing consumes its output");
    assert.equal(view.passes[0]!.reason, "feeds a live pass");
    assert.equal(view.passes[2]!.reason, "writes an imported target");
    assert.deepEqual(view.passes[2]!.reads, ["hdr"]);
    assert.deepEqual(view.passes[2]!.dependsOn, ["forward"]);
    const hdrRes = view.resources.find((r) => r.name === "hdr")!;
    assert.deepEqual([hdrRes.firstUse, hdrRes.lastUse, hdrRes.physical >= 0, hdrRes.bytes], [0, 1, true, 64 * 32 * 8]);
    assert.equal(view.resources.find((r) => r.name === "debugDump")!.physical, -1);
    assert.equal(view.resources.find((r) => r.name === "swapchain")!.imported, true);
    assert.equal(view.pool.length, 1);
    assert.equal(view.gpuFrameMs, null);
    assert.match(formatRenderGraph(view), /3 passes \(1 culled\)[\s\S]*○ debug/);
    graph.dispose();
    await device.dispose();
  });
});

group("gpu resources", () => {
  test("tracks every live buffer and texture by label until destroy", async () => {
    const device = await GraphicsDevice.create({ forceMock: true });
    const before = device.resourceList().length;
    const a = device.device.createBuffer({ label: "terrain.chunk.0_0", size: 4096, usage: BufferUsage.VERTEX });
    const b = device.device.createBuffer({ label: "terrain.chunk.1_0", size: 1024, usage: BufferUsage.VERTEX });
    const t = device.device.createTexture({ label: "forge.shadow.atlas", size: { width: 256, height: 256, depthOrArrayLayers: 2 }, format: "depth32float", usage: RT });
    const anon = device.device.createBuffer({ size: 16, usage: BufferUsage.UNIFORM });
    const view = inspectGpuResources(device);
    assert.equal(view.count, before + 4);
    const terrain = view.groups.find((g) => g.group === "terrain.chunk")!;
    assert.deepEqual([terrain.count, terrain.bytes, terrain.buffers, terrain.largest.label], [2, 5120, 2, "terrain.chunk.0_0"]);
    const shadow = view.groups.find((g) => g.group === "forge.shadow")!;
    assert.equal(shadow.bytes, 256 * 256 * 2 * 4);
    assert.equal(shadow.largest.layers, 2);
    assert.ok(view.groups.some((g) => g.group === "(unlabelled)"));
    assert.equal(view.largest[0]!.label, "forge.shadow.atlas");
    assert.match(formatGpuResources(view), /forge\.shadow/);
    a.destroy();
    t.destroy();
    const after = inspectGpuResources(device);
    assert.equal(after.count, before + 2);
    assert.ok(!after.groups.some((g) => g.group === "forge.shadow"));
    assert.equal(groupOfLabel("a.b.c", 1), "a");
    assert.equal(groupOfLabel(""), "(unlabelled)");
    b.destroy();
    anon.destroy();
    await device.dispose();
  });
});

finish();
