/**
 * Pipeline cache (engine/src/rendering/pipeline.ts) over the mock device.
 *
 * What these prove: identical keys return the identical bundle without touching the device; every
 * axis of the key (technique, formats, blend, cull, instancing, entry point) produces a distinct
 * pipeline; every variant the renderer can ask for compiles under the mock's validation (layouts,
 * vertex buffers, attachment formats); invalidate() releases everything and rebuilds lazily.
 */

import { describe, expect, it } from "vitest";
import { GraphicsDevice, PipelineFactory, type PipelineKeyOptions } from "@forge/engine";

const base: PipelineKeyOptions = { technique: "standard", colorFormat: "rgba16float", depthFormat: "depth24plus", transparent: false, doubleSided: false, instanced: false };

describe("PipelineFactory cache", () => {
  it("returns the same bundle for the same key and counts hits", async () => {
    const device = await GraphicsDevice.create({ forceMock: true });
    const factory = new PipelineFactory(device);
    const a = factory.get(base);
    const b = factory.get({ ...base });
    expect(b).toBe(a);
    expect(factory.stats()).toEqual({ pipelines: 1, creates: 1, cacheHits: 1, layouts: 6 });
    expect(factory.keyOf(base)).toBe(a.key);
    factory.invalidate();
    await device.dispose();
  });

  it("keys every axis that changes the GPU pipeline", async () => {
    const device = await GraphicsDevice.create({ forceMock: true });
    const factory = new PipelineFactory(device);
    const variants: PipelineKeyOptions[] = [
      base,
      { ...base, instanced: true },
      { ...base, transparent: true },
      { ...base, doubleSided: true },
      { ...base, colorFormat: device.format },
      { ...base, technique: "unlit" },
      { ...base, technique: "depth", colorFormat: null },
      { ...base, technique: "depth", colorFormat: null, instanced: true },
      { ...base, technique: "debug", transparent: true, doubleSided: true },
      { ...base, technique: "post", depthFormat: null, doubleSided: true, fragmentEntry: "fsPrefilter" },
      { ...base, technique: "post", depthFormat: null, doubleSided: true, fragmentEntry: "fsDownsample" },
      { ...base, technique: "post", depthFormat: null, doubleSided: true, fragmentEntry: "fsUpsample", additive: true },
      { ...base, technique: "post", colorFormat: device.format, depthFormat: null, doubleSided: true, fragmentEntry: "fsTonemap" },
    ];
    const bundles = variants.map((v) => factory.get(v));
    expect(new Set(bundles.map((b) => b.key)).size).toBe(variants.length);
    expect(new Set(bundles.map((b) => b.pipeline)).size).toBe(variants.length);
    expect(factory.stats().creates).toBe(variants.length);
    expect(factory.stats().cacheHits).toBe(0);
    // Asking again for all of them creates nothing.
    for (const v of variants) factory.get(v);
    expect(factory.stats().creates).toBe(variants.length);
    expect(factory.stats().cacheHits).toBe(variants.length);
    expect(device.mock.errors).toEqual([]);
    factory.invalidate();
    await device.dispose();
  });

  it("shares one shader module between the vertex and fragment stages of a technique", async () => {
    const device = await GraphicsDevice.create({ forceMock: true });
    const factory = new PipelineFactory(device);
    factory.get({ ...base, technique: "post", depthFormat: null, fragmentEntry: "fsPrefilter" });
    factory.get({ ...base, technique: "post", depthFormat: null, fragmentEntry: "fsDownsample" });
    factory.get({ ...base, technique: "post", depthFormat: null, fragmentEntry: "fsUpsample", additive: true });
    factory.get({ ...base, technique: "post", depthFormat: null, fragmentEntry: "fsTonemap" });
    // Four post pipelines, one WGSL compile: the entry points live in a single module.
    expect(factory.shaders.stats().created).toBe(1);
    expect(factory.shaders.stats().uniqueSources).toBe(1);
    factory.get(base);
    factory.get({ ...base, transparent: true });
    expect(factory.shaders.stats().created).toBe(2);
    factory.invalidate();
    await device.dispose();
  });

  it("invalidate() drops the cache and the layouts, and the next get rebuilds them", async () => {
    const device = await GraphicsDevice.create({ forceMock: true });
    const factory = new PipelineFactory(device);
    const first = factory.get(base);
    const layouts = factory.bindGroupLayouts;
    factory.invalidate();
    expect(factory.stats().pipelines).toBe(0);
    const second = factory.get(base);
    expect(second).not.toBe(first);
    expect(second.key).toBe(first.key);
    expect(factory.bindGroupLayouts.frame).not.toBe(layouts.frame);
    expect(factory.stats().creates).toBe(2);
    expect(device.mock.errors).toEqual([]);
    factory.invalidate();
    await device.dispose();
  });
});
