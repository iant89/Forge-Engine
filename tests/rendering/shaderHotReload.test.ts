/**
 * @suite rendering:shaderHotReload
 * @group unit
 * @covers engine/src/gpu/device.ts
 * @covers engine/src/index.ts
 * @covers engine/src/rendering/pipeline.ts
 * @desc Pins shader hot reload behavior and regression guarantees
 */

export const suite = {
  name: "rendering:shaderHotReload",
  group: "unit",
  covers:   [
    "engine/src/gpu/device.ts",
    "engine/src/index.ts",
    "engine/src/rendering/pipeline.ts"
  ],
  desc: "Pins shader hot reload behavior and regression guarantees",
};
import assert from "node:assert/strict";
import { assertThrows, finish, group, test } from "selrun";
import { GraphicsDevice, PipelineFactory, type PipelineKeyOptions } from "@forge/engine";

group("Phase 15.4 — shader hot replacement", () => {
  test("validates overrides before invalidating pipelines and restores the built-in source", async () => {
    const device = await GraphicsDevice.create({ forceMock: true });
    const factory = new PipelineFactory(device);
    const base: PipelineKeyOptions = {
      technique: "standard",
      colorFormat: "rgba16float",
      depthFormat: "depth24plus",
      transparent: false,
      doubleSided: false,
      instanced: false,
    };
    const label = "standard.static.wgsl";
    const initial = factory.get(base);
    const desc = (initial.pipeline as unknown as { desc: GPURenderPipelineDescriptor }).desc;
    const source = (desc.vertex.module as unknown as { code: string }).code;
    const replacement = `${source}\n// validated runtime hot-reload`;

    assert.equal(factory.replaceShaderSource(label, replacement), true);
    const changed = factory.get(base);
    assert.notEqual(changed, initial);
    const changedDesc = (changed.pipeline as unknown as { desc: GPURenderPipelineDescriptor }).desc;
    assert.equal((changedDesc.vertex.module as unknown as { code: string }).code, replacement);
    assertThrows(() => factory.replaceShaderSource(label, "fn invalid("), /failed static validation/);
    assert.equal(factory.get(base), changed); // invalid text never invalidated the last good pipeline

    assert.equal(factory.clearShaderOverride(label), true);
    const restored = factory.get(base);
    assert.notEqual(restored, changed);
    assert.notEqual((restored.pipeline as unknown as { desc: GPURenderPipelineDescriptor }).desc.vertex.module, changedDesc.vertex.module);
    assert.equal(factory.clearShaderOverride(label), false);
    assert.deepEqual(device.mock.errors, []);

    factory.invalidate();
    await device.dispose();
  });
});

await finish();
