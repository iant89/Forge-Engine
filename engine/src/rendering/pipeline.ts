/**
 * Pipeline + bind-group-layout factory.
 *
 * The whole renderer draws with three bind groups and a small, cacheable pipeline set:
 *
 *   group 0  per-frame  : PerFrameUniforms, LightBlock, ShadowUniforms, shadow map, comparison sampler
 *   group 1  per-draw   : ObjectUniforms (dynamic offset), instance stream (dynamic offset)
 *   group 2  per-material: MaterialUniforms, albedo/normal/MR maps, sampler
 *
 * Group 1 uses *dynamic offsets* into two per-frame arena buffers, so a draw call costs
 * `setBindGroup(index, shared, [offset])` instead of a bind-group creation. That is the difference
 * between "10k draws is slow" and "10k draws is possible", and it is why the arena is aligned to 256.
 *
 * Pipelines are keyed on exactly the state that changes them (technique, maps present, blend/cull,
 * depth format, MSAA, instancing). Adding a colour variation must not create a pipeline — if it
 * ever does, the key is wrong and `test('pipeline cache does not explode')` will catch it.
 */

import { ShaderStage } from "../gpu/constants.js";
import { ObjectUniforms, InstanceStruct, MaterialUniforms, PerFrameUniforms, LightBlock, ShadowUniforms } from "./uniforms.js";
import { VERTEX_LAYOUT, VERTEX_STRIDE } from "./geometry.js";
import { STANDARD_VERTEX, STANDARD_INSTANCED_VERTEX, STANDARD_FRAGMENT_BODY, DEPTH_VERTEX, DEBUG_SHADER, BLIT_SHADER, BINDINGS } from "./shaders/standard.js";
import { ShaderCache } from "../gpu/shaderCache.js";
import { InternalError } from "../core/errors.js";
import type { GraphicsDevice } from "../gpu/device.js";

export interface PipelineKeyOptions {
  technique: "standard" | "unlit" | "emissive" | "depth" | "debug" | "blit";
  colorFormat: GPUTextureFormat | null;
  depthFormat: GPUTextureFormat | null;
  transparent: boolean;
  doubleSided: boolean;
  instanced: boolean;
  sampleCount?: number;
  writeDepth?: boolean;
}

export interface RenderPipelineBundle {
  pipeline: GPURenderPipeline;
  key: string;
  topology: GPUPrimitiveTopology;
}

export class PipelineFactory {
  readonly shaders: ShaderCache;
  private readonly pipelines = new Map<string, RenderPipelineBundle>();
  private frameLayout: GPUBindGroupLayout | null = null;
  private depthFrameLayout: GPUBindGroupLayout | null = null;
  private drawLayout: GPUBindGroupLayout | null = null;
  private materialLayout: GPUBindGroupLayout | null = null;
  private layout: GPUPipelineLayout | null = null;
  private depthOnlyLayout: GPUPipelineLayout | null = null;
  private debugLayout: GPUPipelineLayout | null = null;
  private blitLayout: GPUPipelineLayout | null = null;
  private creates = 0;
  private hits = 0;

  constructor(readonly device: GraphicsDevice) {
    this.shaders = new ShaderCache(device);
  }

  /** @internal */ get bindGroupLayouts(): { frame: GPUBindGroupLayout; depthFrame: GPUBindGroupLayout; draw: GPUBindGroupLayout; material: GPUBindGroupLayout } {
    this.ensureLayouts();
    return { frame: this.frameLayout!, depthFrame: this.depthFrameLayout!, draw: this.drawLayout!, material: this.materialLayout! };
  }

  private ensureLayouts(): void {
    if (this.frameLayout) return;
    const d = this.device.device;
    this.depthFrameLayout = d.createBindGroupLayout({
      entries: [
        { binding: BINDINGS.perFrame.binding, visibility: ShaderStage.VERTEX, buffer: { type: "uniform", hasDynamicOffset: false, minBindingSize: PerFrameUniforms.byteSize("uniform") } },
      ],
    });
    this.frameLayout = d.createBindGroupLayout({
      entries: [
        { binding: BINDINGS.perFrame.binding, visibility: ShaderStage.VERTEX | ShaderStage.FRAGMENT, buffer: { type: "uniform", hasDynamicOffset: false, minBindingSize: PerFrameUniforms.byteSize("uniform") } },
        { binding: BINDINGS.lights.binding, visibility: ShaderStage.FRAGMENT, buffer: { type: "uniform", minBindingSize: LightBlock.byteSize("uniform") } },
        { binding: BINDINGS.shadow.binding, visibility: ShaderStage.FRAGMENT, buffer: { type: "uniform", minBindingSize: ShadowUniforms.byteSize("uniform") } },
        { binding: BINDINGS.shadowMap.binding, visibility: ShaderStage.FRAGMENT, texture: { sampleType: "depth", viewDimension: "2d", multisampled: false } },
        { binding: BINDINGS.shadowSampler.binding, visibility: ShaderStage.FRAGMENT, sampler: { type: "comparison" } },
      ],
    });
    this.drawLayout = d.createBindGroupLayout({
      entries: [
        { binding: BINDINGS.object.binding, visibility: ShaderStage.VERTEX | ShaderStage.FRAGMENT, buffer: { type: "uniform", hasDynamicOffset: true, minBindingSize: ObjectUniforms.byteSize("uniform") } },
        {
          binding: BINDINGS.instances.binding,
          visibility: ShaderStage.VERTEX,
          buffer: { type: "read-only-storage", hasDynamicOffset: true, minBindingSize: InstanceStruct.byteSize("storage") },
        },
      ],
    });
    this.materialLayout = d.createBindGroupLayout({
      entries: [
        { binding: BINDINGS.material.binding, visibility: ShaderStage.FRAGMENT, buffer: { type: "uniform", minBindingSize: MaterialUniforms.byteSize("uniform") } },
        { binding: BINDINGS.albedoMap.binding, visibility: ShaderStage.FRAGMENT, texture: { sampleType: "float", viewDimension: "2d", multisampled: false } },
        { binding: BINDINGS.normalMap.binding, visibility: ShaderStage.FRAGMENT, texture: { sampleType: "float", viewDimension: "2d", multisampled: false } },
        { binding: BINDINGS.mrMap.binding, visibility: ShaderStage.FRAGMENT, texture: { sampleType: "float", viewDimension: "2d", multisampled: false } },
        { binding: BINDINGS.sampler.binding, visibility: ShaderStage.FRAGMENT, sampler: { type: "filtering" } },
      ],
    });
    this.layout = d.createPipelineLayout({ bindGroupLayouts: [this.frameLayout, this.drawLayout, this.materialLayout] });
    // The depth pass has no material group and cannot bind the shadow map (which is the pass target),
    // so it uses depthFrameLayout containing only the per-frame uniform buffer.
    this.depthOnlyLayout = d.createPipelineLayout({ bindGroupLayouts: [this.depthFrameLayout, this.drawLayout] });
    this.debugLayout = d.createPipelineLayout({ bindGroupLayouts: [this.frameLayout] });
    this.blitLayout = d.createPipelineLayout({ bindGroupLayouts: [d.createBindGroupLayout({ entries: [{ binding: 0, visibility: ShaderStage.FRAGMENT, buffer: { type: "uniform", minBindingSize: PerFrameUniforms.byteSize("uniform") } }, { binding: 1, visibility: ShaderStage.FRAGMENT, texture: { sampleType: "float", viewDimension: "2d" } }, { binding: 2, visibility: ShaderStage.FRAGMENT, sampler: { type: "filtering" } }] })] });
  }

  private moduleFor(key: PipelineKeyOptions): { vertex: GPUShaderModule; fragment: GPUShaderModule; vertexEntry: string; fragmentEntry: string; blit?: boolean; debug?: boolean } {
    switch (key.technique) {
      case "depth":
        return { vertex: this.shaders.get("depth.wgsl", DEPTH_VERTEX), fragment: this.shaders.get("depth.wgsl", DEPTH_VERTEX), vertexEntry: key.instanced ? "vertexMainInstanced" : "vertexMain", fragmentEntry: "fragmentMain" };
      case "debug":
        return { vertex: this.shaders.get("debug.wgsl", DEBUG_SHADER), fragment: this.shaders.get("debug.wgsl", DEBUG_SHADER), vertexEntry: "vertexMain", fragmentEntry: "fragmentMain", debug: true };
      case "blit":
        return { vertex: this.shaders.get("blit.wgsl", BLIT_SHADER), fragment: this.shaders.get("blit.wgsl", BLIT_SHADER), vertexEntry: "vertexMain", fragmentEntry: "fragmentMain", blit: true };
      default: {
        // One module for both stages: drivers accept multiple entry points per module, and one
        // compile instead of two is measurably faster on scene load. The fragment stage's defines are
        // already embedded in the vertex source, so the fragment body is appended without them.
        const vertexSource = key.instanced ? STANDARD_INSTANCED_VERTEX : STANDARD_VERTEX;
        const module = this.shaders.get(`standard.${key.instanced ? "instanced" : "static"}.wgsl`, `${vertexSource}\n${STANDARD_FRAGMENT_BODY}`);
        return { vertex: module, fragment: module, vertexEntry: key.instanced ? "vertexMainInstanced" : "vertexMain", fragmentEntry: "fragmentMain" };
      }
    }
  }

  keyOf(options: PipelineKeyOptions): string {
    return [
      options.technique,
      options.colorFormat ?? "none",
      options.depthFormat ?? "none",
      options.transparent ? "blend" : "opaque",
      options.doubleSided ? "two" : "one",
      options.instanced ? "inst" : "static",
      options.sampleCount ?? 1,
      options.writeDepth === false ? "nodepthwrite" : "depthwrite",
    ].join("|");
  }

  get(options: PipelineKeyOptions): RenderPipelineBundle {
    const key = this.keyOf(options);
    const cached = this.pipelines.get(key);
    if (cached) {
      this.hits++;
      return cached;
    }
    this.ensureLayouts();
    const bundle = this.create(options, key);
    this.pipelines.set(key, bundle);
    this.creates++;
    return bundle;
  }

  private create(options: PipelineKeyOptions, key: string): RenderPipelineBundle {
    const { vertex, fragment, vertexEntry, fragmentEntry, debug, blit } = this.moduleFor(options);
    const sampleCount = options.sampleCount ?? 1;
    const isDepthOnly = options.technique === "depth";
    const pipelineDesc: GPURenderPipelineDescriptor = {
      label: `pipeline.${key}`,
      layout: debug ? this.debugLayout! : blit ? this.blitLayout! : isDepthOnly ? this.depthOnlyLayout! : this.layout!,
      vertex: {
        module: vertex,
        entryPoint: vertexEntry,
        buffers: blit || options.technique === "blit" ? [] : debug ? [debugVertexBuffer()] : [VERTEX_LAYOUT],
      },
      fragment: isDepthOnly
        ? undefined
        : {
            module: fragment,
            entryPoint: fragmentEntry,
            targets: options.colorFormat
              ? [
                  {
                    format: options.colorFormat,
                    blend: options.transparent
                      ? {
                          color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha", operation: "add" },
                          alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
                        }
                      : undefined,
                    writeMask: 0xf,
                  },
                ]
              : [],
          },
      primitive: {
        topology: debug ? "line-list" : "triangle-list",
        frontFace: "ccw",
        cullMode: options.doubleSided ? "none" : "back",
      },
      depthStencil: options.depthFormat
        ? {
            format: options.depthFormat,
            depthWriteEnabled: options.writeDepth !== false,
            // The depth pass uses a bias + "less" so caster triangles cannot win the tie against
            // themselves; the colour pass uses "less-equal" so coplanar decals behave.
            depthCompare: isDepthOnly ? "less" : "less-equal",
            // Polygon offset keeps shadow casters from self-acne; slope-scaled so grazing angles
            // bias more than facing ones. Both live in GPUDepthStencilState.
            depthBias: isDepthOnly ? 2 : 0,
            depthBiasSlopeScale: isDepthOnly ? 1.5 : 0,
            depthBiasClamp: 0,
          }
        : undefined,
      multisample: { count: sampleCount },
    };
    let pipeline: GPURenderPipeline;
    try {
      pipeline = this.device.device.createRenderPipeline(pipelineDesc);
    } catch (e) {
      throw new InternalError(`failed to create render pipeline "${key}": ${e instanceof Error ? e.message : String(e)}`, { cause: e });
    }
    return { pipeline, key, topology: debug ? "line-list" : "triangle-list" };
  }

  /** Re-create every pipeline after a device loss (modules and layouts are dead with the old one). */
  invalidate(): void {
    this.pipelines.clear();
    this.frameLayout = null;
    this.depthFrameLayout = null;
    this.drawLayout = null;
    this.materialLayout = null;
    this.layout = null;
    this.depthOnlyLayout = null;
    this.debugLayout = null;
    this.blitLayout = null;
    this.shaders.clear();
  }

  stats(): { pipelines: number; creates: number; cacheHits: number; layouts: number } {
    return { pipelines: this.pipelines.size, creates: this.creates, cacheHits: this.hits, layouts: 5 };
  }
}

function debugVertexBuffer(): GPUVertexBufferLayout {
  return {
    arrayStride: 16,
    attributes: [
      { shaderLocation: 0, offset: 0, format: "float32x3" },
      { shaderLocation: 1, offset: 12, format: "uint32" },
    ],
  };
}

export { VERTEX_STRIDE };
