/**
 * @suite rendering:pipeline
 * @group unit
 * @covers engine/src/gpu/device.ts
 * @covers engine/src/index.ts
 * @covers engine/src/rendering/pipeline.ts
 * @desc Pipeline cache (engine/src/rendering/pipeline.ts) over the mock device
 */

export const suite = {
  name: "rendering:pipeline",
  group: "unit",
  covers:   [
    "engine/src/gpu/device.ts",
    "engine/src/index.ts",
    "engine/src/rendering/pipeline.ts"
  ],
  desc: "Pipeline cache (engine/src/rendering/pipeline.ts) over the mock device",
};
/**
 * Pipeline cache (engine/src/rendering/pipeline.ts) over the mock device.
 *
 * What these prove: identical keys return the identical bundle without touching the device; every
 * axis of the key (technique, formats, blend, cull, instancing, entry point) produces a distinct
 * pipeline; every variant the renderer can ask for compiles under the mock's validation (layouts,
 * vertex buffers, attachment formats); invalidate() releases everything and rebuilds lazily.
 */

import assert from "node:assert/strict";
import { assertMatchObject, assertRejects, finish, group, test } from "selrun";
import { GraphicsDevice, PipelineFactory, type PipelineKeyOptions } from "@forge/engine";

const base: PipelineKeyOptions = { technique: "standard", colorFormat: "rgba16float", depthFormat: "depth24plus", transparent: false, doubleSided: false, instanced: false };

group("PipelineFactory cache", () => {
  test("returns the same bundle for the same key and counts hits", async () => {
    const device = await GraphicsDevice.create({ forceMock: true });
    const factory = new PipelineFactory(device);
    const a = factory.get(base);
    const b = factory.get({ ...base });
    assert.equal(b, a);
    assert.deepEqual(factory.stats(), { pipelines: 1, pipelinesPending: 0, failures: 0, creates: 1, cacheHits: 1, layouts: 16 });
    assert.equal(factory.keyOf(base), a.key);
    factory.invalidate();
    await device.dispose();
  });

  test("queues one async compilation per key and exposes bundles only after they are ready", async () => {
    const device = await GraphicsDevice.create({ forceMock: true });
    const factory = new PipelineFactory(device, { asyncCompilation: true });
    assert.equal(factory.getReady(base), null);
    assert.equal(factory.getReady({ ...base }), null);
    const pending = factory.getAsync(base);
    assert.equal(factory.getAsync({ ...base }), pending);
    assertMatchObject(factory.stats(), { pipelines: 0, pipelinesPending: 1, failures: 0, creates: 0 });

    await factory.settle();
    const ready = factory.getReady(base);
    assert.notEqual(ready, null);
    assert.equal(factory.getReady({ ...base }), ready);
    assertMatchObject(factory.stats(), { pipelines: 1, pipelinesPending: 0, failures: 0, creates: 1, cacheHits: 2 });
    assert.deepEqual(device.mock.errors, []);
    factory.invalidate();
    await device.dispose();
  });

  test("does not cache a compilation that completes after invalidation", async () => {
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
    await assertRejects(pending, /completed after its factory was invalidated/);
    assertMatchObject(factory.stats(), { pipelines: 0, pipelinesPending: 0, failures: 0 });
    assert.equal((stalePipeline as GPURenderPipeline & { destroyed: boolean }).destroyed, true);
    assert.deepEqual(device.mock.errors, []);
    await device.dispose();
  });

  test("latches async compilation failures until invalidation without leaving pending entries", async () => {
    const device = await GraphicsDevice.create({ forceMock: true });
    const raw = device.device as unknown as { createRenderPipelineAsync: (descriptor: GPURenderPipelineDescriptor) => Promise<GPURenderPipeline> };
    raw.createRenderPipelineAsync = async () => { throw new Error("forced pipeline compile failure"); };
    const factory = new PipelineFactory(device, { asyncCompilation: true });
    assert.equal(factory.getReady(base), null);
    await factory.settle();
    assertMatchObject(factory.stats(), { pipelines: 0, pipelinesPending: 0, failures: 1 });
    assert.equal(factory.getReady(base), null);
    await assertRejects(factory.getAsync(base), /previously failed/);
    factory.invalidate();
    assert.equal(factory.stats().failures, 0);
    assert.deepEqual(device.mock.errors, []);
    await device.dispose();
  });

  test("keys every axis that changes the GPU pipeline", async () => {
    const device = await GraphicsDevice.create({ forceMock: true });
    const factory = new PipelineFactory(device);
    const variants: PipelineKeyOptions[] = [
      base,
      { ...base, instanced: true },
      { ...base, instanced: true, lod: true },
      { ...base, transparent: true },
      { ...base, doubleSided: true },
      { ...base, colorFormat: device.format },
      { ...base, technique: "unlit" },
      { ...base, technique: "depth", colorFormat: null },
      { ...base, technique: "depth", colorFormat: null, instanced: true },
      { ...base, technique: "depth", colorFormat: null, instanced: true, lod: true },
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
      { ...base, technique: "prepass", colorFormat: null, instanced: true, lod: true },
      { ...base, technique: "prepass", colorFormat: null, doubleSided: true },
      // Phase 16.5: skinning is a pipeline variant of the colour, prepass and shadow programs.
      { ...base, skinned: true },
      { ...base, skinned: true, instanced: true },
      { ...base, skinned: true, transparent: true },
      { ...base, technique: "depth", colorFormat: null, skinned: true },
      { ...base, technique: "depth", colorFormat: null, skinned: true, instanced: true },
      { ...base, technique: "prepass", colorFormat: null, skinned: true },
      { ...base, technique: "ssao", colorFormat: "rg16float", depthFormat: null, doubleSided: true, fragmentEntry: "fsSsao" },
      { ...base, technique: "ssao", colorFormat: "rg16float", depthFormat: null, doubleSided: true, fragmentEntry: "fsBlurH" },
      { ...base, technique: "ssao", colorFormat: "rg16float", depthFormat: null, doubleSided: true, fragmentEntry: "fsBlurV" },
    ];
    const bundles = variants.map((v) => factory.get(v));
    assert.equal(new Set(bundles.map((b) => b.key)).size, variants.length);
    assert.equal(new Set(bundles.map((b) => b.pipeline)).size, variants.length);
    assert.equal(factory.stats().creates, variants.length);
    assert.equal(factory.stats().cacheHits, 0);
    // Asking again for all of them creates nothing.
    for (const v of variants) factory.get(v);
    assert.equal(factory.stats().creates, variants.length);
    assert.equal(factory.stats().cacheHits, variants.length);
    assert.deepEqual(device.mock.errors, []);
    factory.invalidate();
    await device.dispose();
  });

  test("the depth prepass compiles the standard module's own vertex entries: depth only, no bias", async () => {
    const device = await GraphicsDevice.create({ forceMock: true });
    const factory = new PipelineFactory(device);
    type Inspectable = { desc: GPURenderPipelineDescriptor };
    const desc = (options: PipelineKeyOptions) => (factory.get(options).pipeline as unknown as Inspectable).desc;
    const forward = desc(base);
    const forwardInstanced = desc({ ...base, instanced: true });
    const forwardInstancedLod = desc({ ...base, instanced: true, lod: true });
    const shadow = desc({ ...base, technique: "depth", colorFormat: null });
    const shadowLod = desc({ ...base, technique: "depth", colorFormat: null, instanced: true, lod: true });
    const prepass = desc({ ...base, technique: "prepass", colorFormat: null });
    const prepassInstanced = desc({ ...base, technique: "prepass", colorFormat: null, instanced: true });
    const prepassInstancedLod = desc({ ...base, technique: "prepass", colorFormat: null, instanced: true, lod: true });
    // Same module, same entry point as the forward pass (+ @invariant position): the prepass depth is
    // bit-identical to what forge.main computes, so its less-equal test passes on exactly that value.
    assert.equal(prepass.vertex.module, forward.vertex.module);
    assert.equal(prepass.vertex.entryPoint, forward.vertex.entryPoint);
    assert.equal(prepassInstanced.vertex.module, forwardInstanced.vertex.module);
    assert.equal(prepassInstanced.vertex.entryPoint, "vertexMainInstanced");
    // LOD forward + prepass use the same merged-buffer vertex module and entry point; shadow has
    // its own depth module but uses the matching LOD-aware entry.
    assert.equal(prepassInstancedLod.vertex.module, forwardInstancedLod.vertex.module);
    assert.equal(prepassInstancedLod.vertex.entryPoint, "vertexMainInstancedLod");
    assert.equal(shadowLod.vertex.entryPoint, "vertexMainInstancedLod");
    // ...not the shadow program, which is a different shader with a polygon offset.
    assert.notEqual(shadow.vertex.module, forward.vertex.module);
    assert.equal(factory.shaders.stats().created, 4); // standard static/instanced/LOD + depth: prepass compiles nothing
    assert.equal(prepass.fragment, undefined);
    assertMatchObject(prepass.depthStencil, { format: "depth24plus", depthWriteEnabled: true, depthCompare: "less", depthBias: 0, depthBiasSlopeScale: 0 });
    assert.ok((shadow.depthStencil?.depthBias ?? 0) > 0);
    assertMatchObject(prepass.primitive, { cullMode: "back", frontFace: forward.primitive!.frontFace });
    assert.equal(desc({ ...base, technique: "prepass", colorFormat: null, doubleSided: true }).primitive!.cullMode, "none");
    // The forward pipeline over a prepassed surface: tests less-equal against it and writes nothing.
    assertMatchObject(desc({ ...base, writeDepth: false }).depthStencil, { depthWriteEnabled: false, depthCompare: "less-equal" });
    // SSAO: one module for the estimate and both blur directions, fullscreen, no depth attachment.
    const ssao = desc({ ...base, technique: "ssao", colorFormat: "rg16float", depthFormat: null, doubleSided: true, fragmentEntry: "fsSsao" });
    const blur = desc({ ...base, technique: "ssao", colorFormat: "rg16float", depthFormat: null, doubleSided: true, fragmentEntry: "fsBlurH" });
    assert.equal(ssao.fragment!.module, blur.fragment!.module);
    assert.equal(ssao.fragment!.entryPoint, "fsSsao");
    assert.equal(blur.fragment!.entryPoint, "fsBlurH");
    assert.equal(ssao.depthStencil, undefined);
    assert.deepEqual(ssao.vertex.buffers, []);
    assert.notEqual(ssao.layout, blur.layout); // the estimate binds depth, the blurs bind the AO texture
    assert.deepEqual(device.mock.errors, []);
    factory.invalidate();
    await device.dispose();
  });

  test("shares one shader module between the vertex and fragment stages of a technique", async () => {
    const device = await GraphicsDevice.create({ forceMock: true });
    const factory = new PipelineFactory(device);
    factory.get({ ...base, technique: "post", depthFormat: null, fragmentEntry: "fsPrefilter" });
    factory.get({ ...base, technique: "post", depthFormat: null, fragmentEntry: "fsDownsample" });
    factory.get({ ...base, technique: "post", depthFormat: null, fragmentEntry: "fsUpsample", additive: true });
    factory.get({ ...base, technique: "post", depthFormat: null, fragmentEntry: "fsTonemap" });
    // Four post pipelines, one WGSL compile: the entry points live in a single module.
    assert.equal(factory.shaders.stats().created, 1);
    assert.equal(factory.shaders.stats().uniqueSources, 1);
    factory.get(base);
    factory.get({ ...base, transparent: true });
    assert.equal(factory.shaders.stats().created, 2);
    factory.invalidate();
    await device.dispose();
  });

  test("invalidate() drops the cache and the layouts, and the next get rebuilds them", async () => {
    const device = await GraphicsDevice.create({ forceMock: true });
    const factory = new PipelineFactory(device);
    const first = factory.get(base);
    const layouts = factory.bindGroupLayouts;
    factory.invalidate();
    assert.equal(factory.stats().pipelines, 0);
    const second = factory.get(base);
    assert.notEqual(second, first);
    assert.equal(second.key, first.key);
    assert.notEqual(factory.bindGroupLayouts.frame, layouts.frame);
    assert.equal(factory.stats().creates, 2);
    assert.deepEqual(device.mock.errors, []);
    factory.invalidate();
    await device.dispose();
  });
});

await finish();
