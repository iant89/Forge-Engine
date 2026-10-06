import { describe, expect, it } from "vitest";
import { GraphicsDevice, PipelineFactory, type PipelineKeyOptions } from "@forge/engine";

describe("Phase 15.4 — shader hot replacement", () => {
  it("validates overrides before invalidating pipelines and restores the built-in source", async () => {
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

    expect(factory.replaceShaderSource(label, replacement)).toBe(true);
    const changed = factory.get(base);
    expect(changed).not.toBe(initial);
    const changedDesc = (changed.pipeline as unknown as { desc: GPURenderPipelineDescriptor }).desc;
    expect((changedDesc.vertex.module as unknown as { code: string }).code).toBe(replacement);
    expect(() => factory.replaceShaderSource(label, "fn invalid(")).toThrow(/failed static validation/);
    expect(factory.get(base)).toBe(changed); // invalid text never invalidated the last good pipeline

    expect(factory.clearShaderOverride(label)).toBe(true);
    const restored = factory.get(base);
    expect(restored).not.toBe(changed);
    expect((restored.pipeline as unknown as { desc: GPURenderPipelineDescriptor }).desc.vertex.module)
      .not.toBe(changedDesc.vertex.module);
    expect(factory.clearShaderOverride(label)).toBe(false);
    expect(device.mock.errors).toEqual([]);

    factory.invalidate();
    await device.dispose();
  });
});
