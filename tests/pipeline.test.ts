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
    expect(factory.stats()).toEqual({ pipelines: 1, pipelinesPending: 0, failures: 0, creates: 1, cacheHits: 1, layouts: 11 });
    expect(factory.keyOf(base)).toBe(a.key);
    factory.invalidate();
    await device.dispose();
  });

  it("queues one async compilation per key and exposes bundles only after they are ready", async () => {
    const device = await GraphicsDevice.create({ forceMock: true });
    const factory = new PipelineFactory(device, { asyncCompilation: true });
    expect(factory.getReady(base)).toBeNull();
    expect(factory.getReady({ ...base })).toBeNull();
    const pending = factory.getAsync(base);
    expect(factory.getAsync({ ...base })).toBe(pending);
    expect(factory.stats()).toMatchObject({ pipelines: 0, pipelinesPending: 1, failures: 0, creates: 0 });

    await factory.settle();
    const ready = factory.getReady(base);
    expect(ready).not.toBeNull();
    expect(factory.getReady({ ...base })).toBe(ready);
    expect(factory.stats()).toMatchObject({ pipelines: 1, pipelinesPending: 0, failures: 0, creates: 1, cacheHits: 2 });
    expect(device.mock.errors).toEqual([]);
    factory.invalidate();
    await device.dispose();
  });

  it("does not cache a compilation that completes after invalidation", async () => {
    const device = await GraphicsDevice.create({ forceMock: true });
    const raw = device.device as unknown as { createRenderPipelineAsync: (descriptor: GPURenderPipelineDescriptor) => Promise<GPURenderPipeline> };
    const compile = raw.createRenderPipelineAsync.bind(device.device);
    let captured: GPURenderPipelineDescriptor | null = null;
    let resolveCompile: ((pipeline: GPURenderPipeline) => void) | null = null;
    raw.createRenderPipelineAsync = (descriptor) => {
      captured = descriptor;
      return new Promise((resolve) => { resolveCompile = resolve; });
    };
    const factory = new PipelineFactory(device, { asyncCompilation: true });
    const pending = factory.getAsync(base);
    factory.invalidate();
    const stalePipeline = await compile(captured!);
    resolveCompile!(stalePipeline);
    await expect(pending).rejects.toThrow(/completed after its factory was invalidated/);
    expect(factory.stats()).toMatchObject({ pipelines: 0, pipelinesPending: 0, failures: 0 });
    expect((stalePipeline as GPURenderPipeline & { destroyed: boolean }).destroyed).toBe(true);
    expect(device.mock.errors).toEqual([]);
    await device.dispose();
  });

  it("latches async compilation failures until invalidation without leaving pending entries", async () => {
    const device = await GraphicsDevice.create({ forceMock: true });
    const raw = device.device as unknown as { createRenderPipelineAsync: (descriptor: GPURenderPipelineDescriptor) => Promise<GPURenderPipeline> };
    raw.createRenderPipelineAsync = async () => { throw new Error("forced pipeline compile failure"); };
    const factory = new PipelineFactory(device, { asyncCompilation: true });
    expect(factory.getReady(base)).toBeNull();
    await factory.settle();
    expect(factory.stats()).toMatchObject({ pipelines: 0, pipelinesPending: 0, failures: 1 });
    expect(factory.getReady(base)).toBeNull();
    await expect(factory.getAsync(base)).rejects.toThrow(/previously failed/);
    factory.invalidate();
    expect(factory.stats().failures).toBe(0);
    expect(device.mock.errors).toEqual([]);
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
      { ...base, technique: "sky", doubleSided: true, writeDepth: false },
      { ...base, technique: "sky", colorFormat: device.format, doubleSided: true, writeDepth: false },
      { ...base, writeDepth: false },
      { ...base, technique: "prepass", colorFormat: null },
      { ...base, technique: "prepass", colorFormat: null, instanced: true },
      { ...base, technique: "prepass", colorFormat: null, doubleSided: true },
      { ...base, technique: "ssao", colorFormat: "rg16float", depthFormat: null, doubleSided: true, fragmentEntry: "fsSsao" },
      { ...base, technique: "ssao", colorFormat: "rg16float", depthFormat: null, doubleSided: true, fragmentEntry: "fsBlurH" },
      { ...base, technique: "ssao", colorFormat: "rg16float", depthFormat: null, doubleSided: true, fragmentEntry: "fsBlurV" },
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

  it("the depth prepass compiles the standard module's own vertex entries: depth only, no bias", async () => {
    const device = await GraphicsDevice.create({ forceMock: true });
    const factory = new PipelineFactory(device);
    type Inspectable = { desc: GPURenderPipelineDescriptor };
    const desc = (options: PipelineKeyOptions) => (factory.get(options).pipeline as unknown as Inspectable).desc;
    const forward = desc(base);
    const forwardInstanced = desc({ ...base, instanced: true });
    const shadow = desc({ ...base, technique: "depth", colorFormat: null });
    const prepass = desc({ ...base, technique: "prepass", colorFormat: null });
    const prepassInstanced = desc({ ...base, technique: "prepass", colorFormat: null, instanced: true });
    // Same module, same entry point as the forward pass (+ @invariant position): the prepass depth is
    // bit-identical to what forge.main computes, so its less-equal test passes on exactly that value.
    expect(prepass.vertex.module).toBe(forward.vertex.module);
    expect(prepass.vertex.entryPoint).toBe(forward.vertex.entryPoint);
    expect(prepassInstanced.vertex.module).toBe(forwardInstanced.vertex.module);
    expect(prepassInstanced.vertex.entryPoint).toBe("vertexMainInstanced");
    // ...not the shadow program, which is a different shader with a polygon offset.
    expect(shadow.vertex.module).not.toBe(forward.vertex.module);
    expect(factory.shaders.stats().created).toBe(3); // standard, standard instanced, depth: the prepass compiled nothing
    expect(prepass.fragment).toBeUndefined();
    expect(prepass.depthStencil).toMatchObject({ format: "depth24plus", depthWriteEnabled: true, depthCompare: "less", depthBias: 0, depthBiasSlopeScale: 0 });
    expect(shadow.depthStencil!.depthBias).toBeGreaterThan(0);
    expect(prepass.primitive).toMatchObject({ cullMode: "back", frontFace: forward.primitive!.frontFace });
    expect(desc({ ...base, technique: "prepass", colorFormat: null, doubleSided: true }).primitive!.cullMode).toBe("none");
    // The forward pipeline over a prepassed surface: tests less-equal against it and writes nothing.
    expect(desc({ ...base, writeDepth: false }).depthStencil).toMatchObject({ depthWriteEnabled: false, depthCompare: "less-equal" });
    // SSAO: one module for the estimate and both blur directions, fullscreen, no depth attachment.
    const ssao = desc({ ...base, technique: "ssao", colorFormat: "rg16float", depthFormat: null, doubleSided: true, fragmentEntry: "fsSsao" });
    const blur = desc({ ...base, technique: "ssao", colorFormat: "rg16float", depthFormat: null, doubleSided: true, fragmentEntry: "fsBlurH" });
    expect(ssao.fragment!.module).toBe(blur.fragment!.module);
    expect(ssao.fragment!.entryPoint).toBe("fsSsao");
    expect(blur.fragment!.entryPoint).toBe("fsBlurH");
    expect(ssao.depthStencil).toBeUndefined();
    expect(ssao.vertex.buffers).toEqual([]);
    expect(ssao.layout).not.toBe(blur.layout); // the estimate binds depth, the blurs bind the AO texture
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
