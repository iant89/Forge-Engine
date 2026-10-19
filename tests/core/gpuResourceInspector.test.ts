/**
 * @suite core:gpuResourceInspector
 * @group unit
 * @covers engine/src/debug/gpuResourceInspector.ts
 * @covers engine/src/gpu/device.ts
 * @covers engine/src/index.ts
 * @desc Phase 21.4 — live labelled GPU buffer/texture inspection and resource churn
 */

export const suite = {
  name: "core:gpuResourceInspector",
  group: "unit",
  covers: ["engine/src/debug/gpuResourceInspector.ts", "engine/src/gpu/device.ts", "engine/src/index.ts"],
  desc: "Phase 21.4 — live labelled GPU buffer/texture inspection and resource churn",
};

import assert from "node:assert/strict";
import { finish, group, test } from "selrun";
import { BufferUsage, GraphicsDevice, TextureUsage, formatGpuResources, groupOfLabel, inspectGpuResources } from "@forge/engine";

group("GPU resource inspector", () => {
  test("lists live allocations by label, counts bytes and churn, and removes destroyed resources", async () => {
    const device = await GraphicsDevice.create({ forceMock: true });
    const initial = inspectGpuResources(device);

    device.beginFrame();
    const terrainA = device.device.createBuffer({ label: "terrain.chunk.0_0", size: 4096, usage: BufferUsage.VERTEX });
    const terrainB = device.device.createBuffer({ label: "terrain.chunk.1_0", size: 1024, usage: BufferUsage.VERTEX });
    const shadow = device.device.createTexture({
      label: "forge.shadow.atlas",
      size: { width: 256, height: 256, depthOrArrayLayers: 2 },
      format: "depth32float",
      usage: TextureUsage.RENDER_ATTACHMENT,
    });
    const anonymous = device.device.createBuffer({ size: 16, usage: BufferUsage.UNIFORM });

    const view = inspectGpuResources(device);
    assert.equal(view.count, initial.count + 4);
    assert.equal(view.totalBytes, initial.totalBytes + 4096 + 1024 + 16 + 256 * 256 * 2 * 4);
    const terrain = view.groups.find((entry) => entry.group === "terrain.chunk")!;
    assert.deepEqual([terrain.count, terrain.bytes, terrain.buffers, terrain.largest.label], [2, 5120, 2, "terrain.chunk.0_0"]);
    const shadows = view.groups.find((entry) => entry.group === "forge.shadow")!;
    assert.equal(shadows.bytes, 256 * 256 * 2 * 4);
    assert.equal(shadows.largest.layers, 2);
    assert.ok(view.groups.some((entry) => entry.group === "(unlabelled)"));
    assert.equal(view.largest[0]!.label, "forge.shadow.atlas");
    assert.equal(view.recent.length, 4);
    assert.match(formatGpuResources(view), /forge\.shadow/);

    const savedSnapshot = view.largest[0]!;
    shadow.destroy();
    shadow.destroy(); // WebGPU destroy is idempotent; it must not underflow memory counters.
    terrainA.destroy();
    const afterDestroy = inspectGpuResources(device);
    assert.equal(afterDestroy.count, initial.count + 2);
    assert.equal(afterDestroy.totalBytes, initial.totalBytes + 1024 + 16);
    assert.equal(device.gpuMemory.textureCount, initial.groups.reduce((count, group) => count + group.textures, 0));
    assert.equal(device.gpuMemory.textureBytes, initial.textureBytes);
    assert.equal(device.gpuMemory.bufferBytes, initial.bufferBytes + 1024 + 16);
    assert.equal(savedSnapshot.label, "forge.shadow.atlas", "returned records are detached snapshots");
    assert.ok(!afterDestroy.groups.some((entry) => entry.group === "forge.shadow"));

    device.beginFrame();
    assert.equal(inspectGpuResources(device).recent.length, 0);
    assert.equal(groupOfLabel("a.b.c", 1), "a");
    assert.equal(groupOfLabel("a/b:c.d", 2), "a.b");
    assert.equal(groupOfLabel(""), "(unlabelled)");

    terrainB.destroy();
    anonymous.destroy();
    await device.dispose();
  });
});

finish();
