/**
 * The device half of per-instance population culling (docs/RENDERING.md §4g): the two pipelines
 * (`forge.populationCull.views` before the depth passes, `forge.populationCull` after the object
 * culler), the per-batch uniform arena, the view matrices, the population indirect draw records, the
 * counters and their lagged read-back. Owned by `Renderer`, created on first use.
 *
 * The renderer decides *which* batches take the path and owns each batch's buffers; this class only
 * encodes. Each batch owns a contiguous run of draw records: A (the main-view list: prepass, and
 * forge.main on a frame that does not occlude), B (the HiZ survivors: forge.main on a frame that
 * occludes), then one per bit of its `shadowMask`, in bit order.
 */
import { BufferUsage, ShaderStage, gpuSource } from "../gpu/constants.js";
import { StructAccessor, WriteBuffer } from "../gpu/bufferWriter.js";
import type { ShaderCache } from "../gpu/shaderCache.js";
import type { GraphicsDevice } from "../gpu/device.js";
import { DRAW_RECORD_BYTES, DRAW_RECORD_WORDS } from "./objectCulling.js";
import { InstanceStruct, MAX_SHADOW_LAYERS, ObjectCullUniforms, PopulationCullStatsBlock, PopulationCullUniforms, PopulationViewUniforms } from "./uniforms.js";
import { POP_CULL_OCCLUSION, POPULATION_CULL_SHADER, POPULATION_CULL_WORKGROUP, POPULATION_VIEW_CULL_SHADER } from "./shaders/populationCull.js";
import type { RenderGraph, RenderGraphPassContext } from "./renderGraph.js";
import {
  cullPopulationOcclusionOnCpu,
  cullPopulationViewsOnCpu,
  emptyPopulationCullStats,
  type PopulationCullBatch,
  type PopulationCullStats,
} from "../population/cull.js";
import { registerMockComputeKernel } from "../testing/mockGpu.js";
import { cullPlanesFrom, type ObjectCullParams } from "./objectCulling.js";

/** Pipeline labels the mock device keys its emulation on. */
export const POPULATION_CULL_PIPELINE_LABEL = "population.cull.pipeline";
export const POPULATION_VIEW_CULL_PIPELINE_LABEL = "population.cull.views.pipeline";
const UNIFORM_SLOT = 256;
const STATS_BYTES = PopulationCullStatsBlock.byteSize("storage");
const VIEW_BYTES = PopulationViewUniforms.byteSize("uniform");
const VIEW_SHADOW_WORD = PopulationViewUniforms.offsetOf("shadow", "uniform") >> 2;
const STATS_WORD = {
  drawn: PopulationCullStatsBlock.offsetOf("drawn", "storage") >> 2,
  culledFrustum: PopulationCullStatsBlock.offsetOf("culledFrustum", "storage") >> 2,
  culledDistance: PopulationCullStatsBlock.offsetOf("culledDistance", "storage") >> 2,
  culledOccluded: PopulationCullStatsBlock.offsetOf("culledOccluded", "storage") >> 2,
  culledBatch: PopulationCullStatsBlock.offsetOf("culledBatch", "storage") >> 2,
  shadowTested: PopulationCullStatsBlock.offsetOf("shadowTested", "storage") >> 2,
  shadowDrawn: PopulationCullStatsBlock.offsetOf("shadowDrawn", "storage") >> 2,
};

/** Draw records per batch before its shadow records: A (main-view list) and B (HiZ survivors). */
export const POPULATION_MAIN_RECORDS = 2;

/** Number of set bits. */
export function popcount32(v: number): number {
  v = v - ((v >>> 1) & 0x55555555);
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
  return (((v + (v >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

/** One eligible batch this frame. */
export interface PopulationCullEntry {
  /** Group 1 of both kernels: source, main-view list, HiZ-survivor list, shadow caster indices. */
  group: GPUBindGroup;
  count: number;
  camera: { x: number; y: number; z: number };
  lodDistance: number;
  localCenter: { x: number; y: number; z: number };
  localRadius: number;
  visibilityIndex: number;
  /** `POP_CULL_*` bits (the renderer never sets `POP_CULL_OCCLUSION`; `upload` does). */
  flags: number;
  maxDistance: number;
  /** Shadow-map bits whose casters this batch culls on the device (renderer mask layout). */
  shadowMask: number;
  /** u32 slots per shadow index range (`count` rounded up to `POPULATION_SHADOW_INDEX_ALIGN`). */
  indexStride: number;
  /** The draw record's static words: index/vertex count and first index/vertex. */
  indexCount: number;
  first: number;
}

export class GpuPopulationCuller {
  private pipeline: GPUComputePipeline | null = null;
  private viewPipeline: GPUComputePipeline | null = null;
  private pipelineFailed = false;
  private frameLayout: GPUBindGroupLayout | null = null;
  private viewFrameLayout: GPUBindGroupLayout | null = null;
  private instanceLayout: GPUBindGroupLayout | null = null;
  private uniformBytes = new WriteBuffer(UNIFORM_SLOT * 64);
  private uniformAccessor = new StructAccessor(PopulationCullUniforms, this.uniformBytes, 0, "uniform");
  private uniformBuffer: GPUBuffer | null = null;
  private readonly viewWords = new Float32Array(VIEW_BYTES >> 2);
  private viewBuffer: GPUBuffer | null = null;
  private argsWords = new Uint32Array(DRAW_RECORD_WORDS * 64);
  private argsBufferRef: GPUBuffer | null = null;
  private statsBuffer: GPUBuffer | null = null;
  private placeholder: GPUBuffer | null = null;
  private readonly statsZero = new Uint32Array(STATS_BYTES >> 2);
  private readonly readbacks: (GPUBuffer | null)[] = [null, null];
  private readonly readbackBusy = [false, false];
  private readonly readbackFresh = [false, false];
  private readbackTurn = 1;
  private lastStats: PopulationCullStats = emptyPopulationCullStats();
  private readonly entries: PopulationCullEntry[] = [];
  private readonly bases: number[] = [];
  private recordCount = 0;
  private occluding = false;
  private frameGroup: GPUBindGroup | null = null;
  private frameGroupKey: readonly unknown[] = [];
  private viewGroup: GPUBindGroup | null = null;
  private viewGroupKey: readonly unknown[] = [];
  private disposed = false;

  constructor(
    private readonly device: GraphicsDevice,
    private readonly shaders: ShaderCache,
  ) {}

  /** Counters of the last frame that came back (a frame or two late); zero until then. */
  get stats(): PopulationCullStats {
    return this.lastStats;
  }

  /** The population indirect records (see the class comment for the per-batch layout). */
  get argsBuffer(): GPUBuffer | null {
    return this.argsBufferRef;
  }

  get batchCount(): number {
    return this.entries.length;
  }

  /** Whether this frame's forge.main draws record B (the HiZ survivors) rather than A. */
  get occludesThisFrame(): boolean {
    return this.occluding;
  }

  /** Byte offset of the record `forge.main` draws for the batch whose base record is `base`. */
  mainRecordOffset(base: number): number {
    return (base + (this.occluding ? 1 : 0)) * DRAW_RECORD_BYTES;
  }

  /** Byte offset of record A (the main-view list the prepass draws). */
  listRecordOffset(base: number): number {
    return base * DRAW_RECORD_BYTES;
  }

  /** Byte offset of the record of the batch's `local`-th shadow map (bit order of its mask). */
  shadowRecordOffset(base: number, local: number): number {
    return (base + POPULATION_MAIN_RECORDS + local) * DRAW_RECORD_BYTES;
  }

  /** Both compute pipelines, created on first need; `null` (and the per-batch fallback) if either failed. */
  ensurePipeline(): GPUComputePipeline | null {
    if (this.pipeline || this.pipelineFailed || this.disposed) return this.pipeline;
    try {
      const d = this.device.device;
      const module = this.shaders.get("population.cull.wgsl", POPULATION_CULL_SHADER);
      const views = this.shaders.get("population.cull.views.wgsl", POPULATION_VIEW_CULL_SHADER);
      const viewPipeline = d.createComputePipeline({
        label: POPULATION_VIEW_CULL_PIPELINE_LABEL,
        layout: d.createPipelineLayout({ label: "population.cull.views.pipelayout", bindGroupLayouts: [this.ensureViewFrameLayout(), this.ensureInstanceLayout()] }),
        compute: { module: views, entryPoint: "populationViewCullMain" },
      });
      const pipeline = d.createComputePipeline({
        label: POPULATION_CULL_PIPELINE_LABEL,
        layout: d.createPipelineLayout({ label: "population.cull.pipelayout", bindGroupLayouts: [this.ensureFrameLayout(), this.ensureInstanceLayout()] }),
        compute: { module, entryPoint: "populationCullMain" },
      });
      this.viewPipeline = viewPipeline;
      this.pipeline = pipeline;
    } catch (error) {
      this.pipelineFailed = true;
      this.device.recordError("population cull compute pipeline", error instanceof Error ? error.message : String(error));
    }
    return this.pipeline;
  }

  /**
   * Group 1 for one batch: its source records, its main-view list, its HiZ-survivor list (`null`
   * binds a shared 80-byte placeholder: the batch never occludes) and its shadow caster indices.
   */
  createInstanceGroup(source: GPUBuffer, compacted: GPUBuffer, occluded: GPUBuffer | null, casterIndices: GPUBuffer): GPUBindGroup {
    this.placeholder ??= this.device.device.createBuffer({ label: "population.cull.placeholder", size: InstanceStruct.byteSize("storage"), usage: BufferUsage.STORAGE });
    return this.device.device.createBindGroup({
      label: "population.cull.instances",
      layout: this.ensureInstanceLayout(),
      entries: [
        { binding: 0, resource: { buffer: source } },
        { binding: 1, resource: { buffer: compacted } },
        { binding: 2, resource: { buffer: occluded ?? this.placeholder } },
        { binding: 3, resource: { buffer: casterIndices } },
      ],
    });
  }

  /** Start a frame's batch list. */
  begin(): void {
    this.entries.length = 0;
    this.bases.length = 0;
    this.recordCount = 0;
  }

  /** Queue one batch; returns its base draw record (A; B is base + 1, shadows from base + 2). */
  add(entry: PopulationCullEntry): number {
    const base = this.recordCount;
    this.entries.push(entry);
    this.bases.push(base);
    this.recordCount += POPULATION_MAIN_RECORDS + popcount32(entry.shadowMask);
    return base;
  }

  /**
   * The matrices `forge.populationCull.views` tests against: the camera's view-projection, and the
   * view-projection of every shadow map by mask bit (`null` = not active this frame).
   */
  setViews(main: Float32Array, shadow: (bit: number) => Float32Array | null): void {
    this.viewWords.set(main.subarray(0, 16), 0);
    for (let bit = 0; bit < MAX_SHADOW_LAYERS; bit++) {
      const m = shadow(bit);
      if (m) this.viewWords.set(m.subarray(0, 16), VIEW_SHADOW_WORD + bit * 16);
      else this.viewWords.fill(0, VIEW_SHADOW_WORD + bit * 16, VIEW_SHADOW_WORD + bit * 16 + 16);
    }
  }

  /**
   * Stage and upload the frame's uniforms, views and draw records, and zero the counters. `occlude`
   * runs the HiZ stage this frame (the frame occludes and the caller's tier allows it); forge.main
   * then draws record B instead of A.
   */
  upload(occlude: boolean): void {
    const n = this.entries.length;
    this.occluding = occlude;
    if (n === 0 || this.disposed) return;
    const d = this.device.device;
    if (this.uniformBytes.byteLength < n * UNIFORM_SLOT) {
      this.uniformBytes = new WriteBuffer(Math.max(n, 64) * 2 * UNIFORM_SLOT);
      this.uniformAccessor = new StructAccessor(PopulationCullUniforms, this.uniformBytes, 0, "uniform");
    }
    if (!this.uniformBuffer || this.uniformBuffer.size < this.uniformBytes.byteLength) {
      this.uniformBuffer?.destroy();
      this.uniformBuffer = d.createBuffer({ label: "population.cull.uniforms", size: this.uniformBytes.byteLength, usage: BufferUsage.UNIFORM | BufferUsage.COPY_DST });
      this.frameGroup = null;
      this.viewGroup = null;
    }
    const records = this.recordCount;
    if (this.argsWords.length < records * DRAW_RECORD_WORDS) this.argsWords = new Uint32Array(Math.max(records, 64) * 2 * DRAW_RECORD_WORDS);
    if (!this.argsBufferRef || this.argsBufferRef.size < this.argsWords.byteLength) {
      this.argsBufferRef?.destroy();
      this.argsBufferRef = d.createBuffer({ label: "population.cull.drawArgs", size: this.argsWords.byteLength, usage: BufferUsage.STORAGE | BufferUsage.INDIRECT | BufferUsage.COPY_DST });
      this.frameGroup = null;
      this.viewGroup = null;
    }
    this.statsBuffer ??= d.createBuffer({ label: "population.cull.stats", size: STATS_BYTES, usage: BufferUsage.STORAGE | BufferUsage.COPY_SRC | BufferUsage.COPY_DST });
    this.viewBuffer ??= d.createBuffer({ label: "population.cull.views", size: VIEW_BYTES, usage: BufferUsage.UNIFORM | BufferUsage.COPY_DST });
    const a = this.uniformAccessor;
    const words = this.argsWords;
    for (let i = 0; i < n; i++) {
      const e = this.entries[i]!;
      const base = this.bases[i]!;
      a.relocate(i * UNIFORM_SLOT);
      a.setVec3("camera", e.camera.x, e.camera.y, e.camera.z);
      a.setF32("lodDistance", e.lodDistance);
      a.setVec3("localCenter", e.localCenter.x, e.localCenter.y, e.localCenter.z);
      a.setF32("localRadius", e.localRadius);
      a.setU32("count", e.count);
      a.setU32("argsWord", base * DRAW_RECORD_WORDS + 1);
      a.setU32("visibilityIndex", e.visibilityIndex);
      a.setU32("flags", e.flags | (occlude ? POP_CULL_OCCLUSION : 0));
      a.setF32("maxDistance", e.maxDistance);
      a.setU32("argsWordOccluded", (base + 1) * DRAW_RECORD_WORDS + 1);
      a.setU32("shadowMask", e.shadowMask >>> 0);
      a.setU32("shadowArgsWord", (base + POPULATION_MAIN_RECORDS) * DRAW_RECORD_WORDS + 1);
      a.setU32("indexStride", e.indexStride);
      // Every record of the batch: (count, instanceCount = 0 — the passes append — , first, 0, 0).
      const own = POPULATION_MAIN_RECORDS + popcount32(e.shadowMask);
      for (let k = 0; k < own; k++) {
        const r = (base + k) * DRAW_RECORD_WORDS;
        words[r] = e.indexCount;
        words[r + 1] = 0;
        words[r + 2] = e.first;
        words.fill(0, r + 3, r + DRAW_RECORD_WORDS);
      }
    }
    d.queue.writeBuffer(this.uniformBuffer, 0, gpuSource(this.uniformBytes.bytes.subarray(0, n * UNIFORM_SLOT)));
    d.queue.writeBuffer(this.argsBufferRef, 0, gpuSource(words.subarray(0, records * DRAW_RECORD_WORDS)));
    d.queue.writeBuffer(this.viewBuffer, 0, gpuSource(this.viewWords));
    d.queue.writeBuffer(this.statsBuffer, 0, gpuSource(this.statsZero));
  }

  /**
   * Add `forge.populationCull.views` to the frame: after the uploads, before the first shadow pass
   * and the prepass (which draw its lists). Returns whether it was recorded.
   */
  recordViews(graph: RenderGraph): boolean {
    if (this.disposed || this.entries.length === 0 || !this.viewPipeline || !this.argsBufferRef) return false;
    graph.addPass({ name: "forge.populationCull.views", sideEffect: true, execute: (ctx) => this.encodeViews(ctx) });
    return true;
  }

  /**
   * Add `forge.populationCull` to the frame, after `forge.objects.cull` (whose `visibility` words and
   * HiZ pyramid it reads) and before `forge.main` (which draws its records).
   */
  record(graph: RenderGraph, frame: { uniforms: GPUBuffer; hiz: GPUTextureView }, visibility: GPUBuffer): void {
    if (this.disposed || this.entries.length === 0 || !this.pipeline) return;
    const readback = this.pickReadback();
    graph.addPass({ name: "forge.populationCull", sideEffect: true, execute: (ctx) => this.encode(ctx, frame, visibility, readback) });
  }

  /** Map the counters back; call once per frame. */
  poll(): void {
    if (this.disposed) return;
    const index = this.readbackTurn;
    const buffer = this.readbacks[index];
    if (!buffer || !this.readbackFresh[index] || this.readbackBusy[index]) return;
    this.readbackFresh[index] = false;
    this.readbackBusy[index] = true;
    buffer
      .mapAsync(BufferUsage.MAP_READ)
      .then(() => {
        // Disposed while the map was in flight: the buffer is gone, and so is anyone reading stats.
        if (this.disposed) return;
        const w = new Uint32Array(buffer.getMappedRange(0, STATS_BYTES), 0, STATS_BYTES >> 2);
        // Every tested instance lands in exactly one bucket, so "in" is the sum (no extra atomic).
        const drawn = w[STATS_WORD.drawn]!;
        const f = w[STATS_WORD.culledFrustum]!, dd = w[STATS_WORD.culledDistance]!, o = w[STATS_WORD.culledOccluded]!, cb = w[STATS_WORD.culledBatch]!;
        this.lastStats = {
          tested: drawn + f + dd + o + cb,
          drawn,
          culledFrustum: f,
          culledDistance: dd,
          culledOccluded: o,
          culledBatch: cb,
          shadowTested: w[STATS_WORD.shadowTested]!,
          shadowDrawn: w[STATS_WORD.shadowDrawn]!,
        };
        buffer.unmap();
        this.readbackBusy[index] = false;
      })
      .catch(() => {
        this.readbackBusy[index] = false;
      });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const b of [this.uniformBuffer, this.argsBufferRef, this.statsBuffer, this.viewBuffer, this.placeholder, ...this.readbacks]) b?.destroy();
    this.uniformBuffer = null;
    this.argsBufferRef = null;
    this.statsBuffer = null;
    this.viewBuffer = null;
    this.placeholder = null;
    this.readbacks.fill(null);
    this.frameGroup = null;
    this.viewGroup = null;
    this.entries.length = 0;
  }

  private encodeViews(ctx: RenderGraphPassContext): void {
    const pass = ctx.beginComputePass("population.cull.views");
    pass.setPipeline(this.viewPipeline!);
    const key = [this.viewBuffer, this.uniformBuffer, this.argsBufferRef, this.statsBuffer];
    if (!this.viewGroup || key.some((k, i) => k !== this.viewGroupKey[i])) {
      this.viewGroup = this.device.device.createBindGroup({
        label: "population.cull.views.frame",
        layout: this.ensureViewFrameLayout(),
        entries: [
          { binding: 0, resource: { buffer: this.viewBuffer! } },
          { binding: 1, resource: { buffer: this.uniformBuffer!, size: PopulationCullUniforms.byteSize("uniform") } },
          { binding: 2, resource: { buffer: this.argsBufferRef! } },
          { binding: 3, resource: { buffer: this.statsBuffer! } },
        ],
      });
      this.viewGroupKey = key;
    }
    for (let i = 0; i < this.entries.length; i++) {
      const e = this.entries[i]!;
      pass.setBindGroup(0, this.viewGroup, [i * UNIFORM_SLOT]);
      pass.setBindGroup(1, e.group);
      pass.dispatchWorkgroups(Math.ceil(e.count / POPULATION_CULL_WORKGROUP));
    }
    pass.end();
  }

  private encode(ctx: RenderGraphPassContext, frame: { uniforms: GPUBuffer; hiz: GPUTextureView }, visibility: GPUBuffer, readback: GPUBuffer | null): void {
    const pass = ctx.beginComputePass("population.cull");
    const pipeline = this.pipeline!;
    pass.setPipeline(pipeline);
    const key = [frame.uniforms, frame.hiz, visibility, this.uniformBuffer, this.argsBufferRef, this.statsBuffer];
    if (!this.frameGroup || key.some((k, i) => k !== this.frameGroupKey[i])) {
      this.frameGroup = this.device.device.createBindGroup({
        label: "population.cull.frame",
        layout: this.ensureFrameLayout(),
        entries: [
          { binding: 0, resource: { buffer: frame.uniforms } },
          { binding: 1, resource: { buffer: this.uniformBuffer!, size: PopulationCullUniforms.byteSize("uniform") } },
          { binding: 2, resource: { buffer: this.argsBufferRef! } },
          { binding: 3, resource: { buffer: this.statsBuffer! } },
          { binding: 4, resource: { buffer: visibility } },
          { binding: 5, resource: frame.hiz },
        ],
      });
      this.frameGroupKey = key;
    }
    for (let i = 0; i < this.entries.length; i++) {
      const e = this.entries[i]!;
      pass.setBindGroup(0, this.frameGroup, [i * UNIFORM_SLOT]);
      pass.setBindGroup(1, e.group);
      pass.dispatchWorkgroups(Math.ceil(e.count / POPULATION_CULL_WORKGROUP));
    }
    pass.end();
    if (readback) ctx.encoder.copyBufferToBuffer(this.statsBuffer!, 0, readback, 0, STATS_BYTES);
  }

  private pickReadback(): GPUBuffer | null {
    this.readbackTurn = this.readbackTurn === 0 ? 1 : 0;
    const index = this.readbackTurn;
    if (this.readbackBusy[index]) return null;
    this.readbacks[index] ??= this.device.device.createBuffer({ label: `population.cull.stats.${index}`, size: STATS_BYTES, usage: BufferUsage.MAP_READ | BufferUsage.COPY_DST });
    this.readbackFresh[index] = true;
    return this.readbacks[index]!;
  }

  private ensureViewFrameLayout(): GPUBindGroupLayout {
    this.viewFrameLayout ??= this.device.device.createBindGroupLayout({
      label: "population.cull.views.frame.layout",
      entries: [
        { binding: 0, visibility: ShaderStage.COMPUTE, buffer: { type: "uniform", minBindingSize: VIEW_BYTES } },
        { binding: 1, visibility: ShaderStage.COMPUTE, buffer: { type: "uniform", hasDynamicOffset: true, minBindingSize: PopulationCullUniforms.byteSize("uniform") } },
        { binding: 2, visibility: ShaderStage.COMPUTE, buffer: { type: "storage", minBindingSize: DRAW_RECORD_BYTES } },
        { binding: 3, visibility: ShaderStage.COMPUTE, buffer: { type: "storage", minBindingSize: STATS_BYTES } },
      ],
    });
    return this.viewFrameLayout;
  }

  private ensureFrameLayout(): GPUBindGroupLayout {
    this.frameLayout ??= this.device.device.createBindGroupLayout({
      label: "population.cull.frame.layout",
      entries: [
        { binding: 0, visibility: ShaderStage.COMPUTE, buffer: { type: "uniform", minBindingSize: ObjectCullUniforms.byteSize("uniform") } },
        { binding: 1, visibility: ShaderStage.COMPUTE, buffer: { type: "uniform", hasDynamicOffset: true, minBindingSize: PopulationCullUniforms.byteSize("uniform") } },
        { binding: 2, visibility: ShaderStage.COMPUTE, buffer: { type: "storage", minBindingSize: DRAW_RECORD_BYTES } },
        { binding: 3, visibility: ShaderStage.COMPUTE, buffer: { type: "storage", minBindingSize: STATS_BYTES } },
        { binding: 4, visibility: ShaderStage.COMPUTE, buffer: { type: "read-only-storage", minBindingSize: 4 } },
        { binding: 5, visibility: ShaderStage.COMPUTE, texture: { sampleType: "unfilterable-float", viewDimension: "2d", multisampled: false } },
      ],
    });
    return this.frameLayout;
  }

  private ensureInstanceLayout(): GPUBindGroupLayout {
    this.instanceLayout ??= this.device.device.createBindGroupLayout({
      label: "population.cull.instances.layout",
      entries: [0, 1, 2, 3].map((binding) => ({ binding, visibility: ShaderStage.COMPUTE, buffer: { type: "storage" as const } })),
    });
    return this.instanceLayout;
  }
}

// ------------------------------------------------------------------ mock execution (CPU twin)

const OCU = (name: string) => ObjectCullUniforms.offsetOf(name, "uniform") >> 2;
const PCU = (name: string) => PopulationCullUniforms.offsetOf(name, "uniform") >> 2;

function mockCullParams(cullBytes: ArrayBuffer | null): ObjectCullParams {
  const cf = cullBytes ? new Float32Array(cullBytes) : new Float32Array(ObjectCullUniforms.byteSize("uniform") >> 2);
  const cu = new Uint32Array(cf.buffer);
  return {
    view: cf.slice(OCU("view"), OCU("view") + 16),
    proj: cf.slice(OCU("proj"), OCU("proj") + 16),
    viewProj: cf.slice(OCU("viewProj"), OCU("viewProj") + 16),
    cameraPos: { x: cf[OCU("cameraPos")]!, y: cf[OCU("cameraPos") + 1]!, z: cf[OCU("cameraPos") + 2]! },
    near: cf[OCU("near")]!,
    far: cf[OCU("far")]!,
    width: cf[OCU("extent")]!,
    height: cf[OCU("extent") + 1]!,
    flags: cu[OCU("flags")]!,
    hizLevels: 0,
  };
}

function mockBatch(popBytes: ArrayBuffer, base: number, workgroups: number): { batch: PopulationCullBatch; pu: Uint32Array } {
  const pf = new Float32Array(popBytes);
  const pu = new Uint32Array(popBytes);
  const at = (name: string, k = 0) => pf[base + PCU(name) + k]!;
  const batch: PopulationCullBatch = {
    camera: { x: at("camera"), y: at("camera", 1), z: at("camera", 2) },
    lodDistance: at("lodDistance"),
    localCenter: { x: at("localCenter"), y: at("localCenter", 1), z: at("localCenter", 2) },
    localRadius: at("localRadius"),
    count: Math.min(pu[base + PCU("count")]!, workgroups * POPULATION_CULL_WORKGROUP),
    flags: pu[base + PCU("flags")]!,
    maxDistance: at("maxDistance"),
  };
  return { batch, pu };
}

function addMockStats(statsBytes: ArrayBuffer, stats: PopulationCullStats): void {
  const sw = new Uint32Array(statsBytes);
  sw[STATS_WORD.drawn] += stats.drawn;
  sw[STATS_WORD.culledFrustum] += stats.culledFrustum;
  sw[STATS_WORD.culledDistance] += stats.culledDistance;
  sw[STATS_WORD.culledOccluded] += stats.culledOccluded;
  sw[STATS_WORD.culledBatch] += stats.culledBatch;
  sw[STATS_WORD.shadowTested] += stats.shadowTested;
  sw[STATS_WORD.shadowDrawn] += stats.shadowDrawn;
}

/**
 * The mock device runs the CPU twins for both dispatches, reading the same bindings the kernels
 * read. The mock has no depth pyramid, so the HiZ stage there only drops batch-culled entries
 * (`hizLevels` treated as 0); the twins' occlusion path is covered by their own tests.
 */
registerMockComputeKernel(POPULATION_VIEW_CULL_PIPELINE_LABEL, (dispatch) => {
  const viewBytes = dispatch.buffer(0, 0);
  const popBytes = dispatch.buffer(0, 1);
  const args = dispatch.buffer(0, 2);
  const statsBytes = dispatch.buffer(0, 3);
  const source = dispatch.buffer(1, 0);
  const compacted = dispatch.buffer(1, 1);
  const indices = dispatch.buffer(1, 3);
  if (!viewBytes || !popBytes || !args || !statsBytes || !source || !compacted || !indices) return;
  const base = dispatch.dynamicOffset(0) >> 2;
  const { batch, pu } = mockBatch(popBytes, base, dispatch.workgroups);
  const vf = new Float32Array(viewBytes);
  const mask = pu[base + PCU("shadowMask")]!;
  const shadowPlanes: Float32Array[] = [];
  for (let m = mask; m !== 0; m &= m - 1) {
    const bit = 31 - Math.clz32(m & -m);
    shadowPlanes.push(cullPlanesFrom(vf.subarray(VIEW_SHADOW_WORD + bit * 16, VIEW_SHADOW_WORD + bit * 16 + 16)));
  }
  const stats = emptyPopulationCullStats();
  const argsU32 = new Uint32Array(args);
  const shadowCounts = new Uint32Array(shadowPlanes.length);
  const listed = cullPopulationViewsOnCpu(new Float32Array(source), new Uint32Array(source), batch, cullPlanesFrom(vf.subarray(0, 16)), shadowPlanes, new Uint32Array(compacted), new Uint32Array(indices), pu[base + PCU("indexStride")]!, shadowCounts, stats);
  argsU32[pu[base + PCU("argsWord")]!] += listed;
  const shadowWord = pu[base + PCU("shadowArgsWord")]!;
  for (let k = 0; k < shadowCounts.length; k++) argsU32[shadowWord + k * DRAW_RECORD_WORDS] += shadowCounts[k]!;
  addMockStats(statsBytes, stats);
});

registerMockComputeKernel(POPULATION_CULL_PIPELINE_LABEL, (dispatch) => {
  const cullBytes = dispatch.buffer(0, 0);
  const popBytes = dispatch.buffer(0, 1);
  const args = dispatch.buffer(0, 2);
  const statsBytes = dispatch.buffer(0, 3);
  const visibility = dispatch.buffer(0, 4);
  const source = dispatch.buffer(1, 0);
  const compacted = dispatch.buffer(1, 1);
  const occluded = dispatch.buffer(1, 2);
  if (!cullBytes || !popBytes || !args || !statsBytes || !visibility || !source || !compacted || !occluded) return;
  const base = dispatch.dynamicOffset(0) >> 2;
  const { batch, pu } = mockBatch(popBytes, base, dispatch.workgroups);
  const argsU32 = new Uint32Array(args);
  const listed = Math.min(argsU32[pu[base + PCU("argsWord")]!]!, batch.count);
  const visible = new Uint32Array(visibility)[pu[base + PCU("visibilityIndex")]!] === 0;
  const stats = emptyPopulationCullStats();
  const kept = cullPopulationOcclusionOnCpu(new Float32Array(source), new Uint32Array(source), batch, new Uint32Array(compacted), listed, visible, mockCullParams(cullBytes), [], new Uint32Array(occluded), stats);
  argsU32[pu[base + PCU("argsWordOccluded")]!] += kept;
  addMockStats(statsBytes, stats);
});
