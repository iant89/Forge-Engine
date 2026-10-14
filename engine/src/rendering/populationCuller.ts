/**
 * The device half of `forge.populationCull` (Phase A of the GPU-placement plan, docs/RENDERING.md
 * §4g): the pipeline, the per-batch uniform arena, the population indirect draw
 * records, the counters and their lagged read-back. Owned by `Renderer`, created on first use.
 *
 * The renderer decides *which* batches take the path (population, instanced, in view, device culling
 * on, indirect draws on, pipeline ready) and owns each batch's buffers; this class only encodes.
 */
import { BufferUsage, ShaderStage, gpuSource } from "../gpu/constants.js";
import { StructAccessor, WriteBuffer } from "../gpu/bufferWriter.js";
import type { ShaderCache } from "../gpu/shaderCache.js";
import type { GraphicsDevice } from "../gpu/device.js";
import { DRAW_RECORD_BYTES, DRAW_RECORD_WORDS } from "./objectCulling.js";
import { ObjectCullUniforms, PopulationCullStatsBlock, PopulationCullUniforms } from "./uniforms.js";
import { POP_CULL_OCCLUSION, POPULATION_CULL_SHADER, POPULATION_CULL_WORKGROUP } from "./shaders/populationCull.js";
import type { RenderGraph, RenderGraphPassContext } from "./renderGraph.js";
import { cullPopulationInstancesOnCpu, emptyPopulationCullStats, type PopulationCullBatch, type PopulationCullStats } from "../population/cull.js";
import { registerMockComputeKernel } from "../testing/mockGpu.js";
import type { ObjectCullParams } from "./objectCulling.js";

/** Pipeline label the mock device keys its emulation on. */
export const POPULATION_CULL_PIPELINE_LABEL = "population.cull.pipeline";
const UNIFORM_SLOT = 256;
const STATS_BYTES = PopulationCullStatsBlock.byteSize("storage");
const STATS_WORD = {
  drawn: PopulationCullStatsBlock.offsetOf("drawn", "storage") >> 2,
  culledFrustum: PopulationCullStatsBlock.offsetOf("culledFrustum", "storage") >> 2,
  culledDistance: PopulationCullStatsBlock.offsetOf("culledDistance", "storage") >> 2,
  culledOccluded: PopulationCullStatsBlock.offsetOf("culledOccluded", "storage") >> 2,
  culledBatch: PopulationCullStatsBlock.offsetOf("culledBatch", "storage") >> 2,
};

/** One eligible batch this frame. */
export interface PopulationCullEntry {
  /** Group 1: the batch's source records (read-write) and its compacted buffer. */
  group: GPUBindGroup;
  count: number;
  camera: { x: number; y: number; z: number };
  lodDistance: number;
  localCenter: { x: number; y: number; z: number };
  localRadius: number;
  visibilityIndex: number;
  /** `POP_CULL_*` bits. */
  flags: number;
  maxDistance: number;
  /** The draw record's static words: index/vertex count and first index/vertex. */
  indexCount: number;
  first: number;
}

export class GpuPopulationCuller {
  private pipeline: GPUComputePipeline | null = null;
  private pipelineFailed = false;
  private frameLayout: GPUBindGroupLayout | null = null;
  private instanceLayout: GPUBindGroupLayout | null = null;
  private uniformBytes = new WriteBuffer(UNIFORM_SLOT * 64);
  private uniformAccessor = new StructAccessor(PopulationCullUniforms, this.uniformBytes, 0, "uniform");
  private uniformBuffer: GPUBuffer | null = null;
  private argsWords = new Uint32Array(DRAW_RECORD_WORDS * 64);
  private argsBufferRef: GPUBuffer | null = null;
  private statsBuffer: GPUBuffer | null = null;
  private readonly statsZero = new Uint32Array(STATS_BYTES >> 2);
  private readonly readbacks: (GPUBuffer | null)[] = [null, null];
  private readonly readbackBusy = [false, false];
  private readonly readbackFresh = [false, false];
  private readbackTurn = 1;
  private lastStats: PopulationCullStats = emptyPopulationCullStats();
  private readonly entries: PopulationCullEntry[] = [];
  private frameGroup: GPUBindGroup | null = null;
  private frameGroupKey: readonly unknown[] = [];
  private disposed = false;

  constructor(
    private readonly device: GraphicsDevice,
    private readonly shaders: ShaderCache,
  ) {}

  /** Counters of the last frame that came back (a frame or two late); zero until then. */
  get stats(): PopulationCullStats {
    return this.lastStats;
  }

  /** The population indirect records, one 32-byte slot per eligible batch, in `add` order. */
  get argsBuffer(): GPUBuffer | null {
    return this.argsBufferRef;
  }

  get batchCount(): number {
    return this.entries.length;
  }

  /** The compute pipeline, created on first need; `null` (and the per-batch fallback) if it failed. */
  ensurePipeline(): GPUComputePipeline | null {
    if (this.pipeline || this.pipelineFailed || this.disposed) return this.pipeline;
    try {
      const d = this.device.device;
      const module = this.shaders.get("population.cull.wgsl", POPULATION_CULL_SHADER);
      this.pipeline = d.createComputePipeline({
        label: POPULATION_CULL_PIPELINE_LABEL,
        layout: d.createPipelineLayout({ label: "population.cull.pipelayout", bindGroupLayouts: [this.ensureFrameLayout(), this.ensureInstanceLayout()] }),
        compute: { module, entryPoint: "populationCullMain" },
      });
    } catch (error) {
      this.pipelineFailed = true;
      this.device.recordError("population cull compute pipeline", error instanceof Error ? error.message : String(error));
    }
    return this.pipeline;
  }

  /** Group 1 for one batch: its source records and its compacted buffer, both whole. */
  createInstanceGroup(source: GPUBuffer, compacted: GPUBuffer): GPUBindGroup {
    return this.device.device.createBindGroup({
      label: "population.cull.instances",
      layout: this.ensureInstanceLayout(),
      entries: [
        { binding: 0, resource: { buffer: source } },
        { binding: 1, resource: { buffer: compacted } },
      ],
    });
  }

  /** Start a frame's batch list. */
  begin(): void {
    this.entries.length = 0;
  }

  /** Queue one batch; returns its slot in {@link argsBuffer}. */
  add(entry: PopulationCullEntry): number {
    this.entries.push(entry);
    return this.entries.length - 1;
  }

  /**
   * Stage and upload the frame's uniforms and draw records, and zero the counters. `occlude` adds
   * the HiZ test to every batch (the frame occludes and the caller's tier allows it).
   */
  upload(occlude: boolean): void {
    const n = this.entries.length;
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
    }
    if (this.argsWords.length < n * DRAW_RECORD_WORDS) this.argsWords = new Uint32Array(Math.max(n, 64) * 2 * DRAW_RECORD_WORDS);
    if (!this.argsBufferRef || this.argsBufferRef.size < this.argsWords.byteLength) {
      this.argsBufferRef?.destroy();
      this.argsBufferRef = d.createBuffer({ label: "population.cull.drawArgs", size: this.argsWords.byteLength, usage: BufferUsage.STORAGE | BufferUsage.INDIRECT | BufferUsage.COPY_DST });
      this.frameGroup = null;
    }
    this.statsBuffer ??= d.createBuffer({ label: "population.cull.stats", size: STATS_BYTES, usage: BufferUsage.STORAGE | BufferUsage.COPY_SRC | BufferUsage.COPY_DST });
    const a = this.uniformAccessor;
    const words = this.argsWords;
    for (let i = 0; i < n; i++) {
      const e = this.entries[i]!;
      a.relocate(i * UNIFORM_SLOT);
      a.setVec3("camera", e.camera.x, e.camera.y, e.camera.z);
      a.setF32("lodDistance", e.lodDistance);
      a.setVec3("localCenter", e.localCenter.x, e.localCenter.y, e.localCenter.z);
      a.setF32("localRadius", e.localRadius);
      a.setU32("count", e.count);
      a.setU32("argsWord", i * DRAW_RECORD_WORDS + 1);
      a.setU32("visibilityIndex", e.visibilityIndex);
      a.setU32("flags", e.flags | (occlude ? POP_CULL_OCCLUSION : 0));
      a.setF32("maxDistance", e.maxDistance);
      // (count, instanceCount = 0 — the pass appends — , first, baseVertex 0, firstInstance 0).
      const r = i * DRAW_RECORD_WORDS;
      words[r] = e.indexCount;
      words[r + 1] = 0;
      words[r + 2] = e.first;
      words.fill(0, r + 3, r + DRAW_RECORD_WORDS);
    }
    d.queue.writeBuffer(this.uniformBuffer, 0, gpuSource(this.uniformBytes.bytes.subarray(0, n * UNIFORM_SLOT)));
    d.queue.writeBuffer(this.argsBufferRef, 0, gpuSource(words.subarray(0, n * DRAW_RECORD_WORDS)));
    d.queue.writeBuffer(this.statsBuffer, 0, gpuSource(this.statsZero));
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
    for (const b of [this.uniformBuffer, this.argsBufferRef, this.statsBuffer, ...this.readbacks]) b?.destroy();
    this.uniformBuffer = null;
    this.argsBufferRef = null;
    this.statsBuffer = null;
    this.readbacks.fill(null);
    this.frameGroup = null;
    this.entries.length = 0;
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
      entries: [
        { binding: 0, visibility: ShaderStage.COMPUTE, buffer: { type: "storage" } },
        { binding: 1, visibility: ShaderStage.COMPUTE, buffer: { type: "storage" } },
      ],
    });
    return this.instanceLayout;
  }
}

// ------------------------------------------------------------------ mock execution (CPU twin)

const OCU = (name: string) => ObjectCullUniforms.offsetOf(name, "uniform") >> 2;
const PCU = (name: string) => PopulationCullUniforms.offsetOf(name, "uniform") >> 2;

/**
 * The mock device runs `cullPopulationInstancesOnCpu` for every `forge.populationCull` dispatch,
 * reading the same bindings the kernel reads. The mock has no depth pyramid, so the HiZ test is
 * skipped there (`hizLevels` treated as 0); the twin's occlusion path is covered by its own tests.
 */
registerMockComputeKernel(POPULATION_CULL_PIPELINE_LABEL, (dispatch) => {
  const cullBytes = dispatch.buffer(0, 0);
  const popBytes = dispatch.buffer(0, 1);
  const args = dispatch.buffer(0, 2);
  const statsBytes = dispatch.buffer(0, 3);
  const visibility = dispatch.buffer(0, 4);
  const source = dispatch.buffer(1, 0);
  const compacted = dispatch.buffer(1, 1);
  if (!cullBytes || !popBytes || !args || !statsBytes || !visibility || !source || !compacted) return;
  const cf = new Float32Array(cullBytes);
  const cu = new Uint32Array(cullBytes);
  const base = dispatch.dynamicOffset(0) >> 2;
  const pf = new Float32Array(popBytes);
  const pu = new Uint32Array(popBytes);
  const params: ObjectCullParams = {
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
  const at = (name: string, k = 0) => pf[base + PCU(name) + k]!;
  const count = Math.min(pu[base + PCU("count")]!, dispatch.workgroups * POPULATION_CULL_WORKGROUP);
  const batch: PopulationCullBatch = {
    camera: { x: at("camera"), y: at("camera", 1), z: at("camera", 2) },
    lodDistance: at("lodDistance"),
    localCenter: { x: at("localCenter"), y: at("localCenter", 1), z: at("localCenter", 2) },
    localRadius: at("localRadius"),
    count,
    flags: pu[base + PCU("flags")]!,
    maxDistance: at("maxDistance"),
  };
  const visible = new Uint32Array(visibility)[pu[base + PCU("visibilityIndex")]!] === 0;
  const stats = emptyPopulationCullStats();
  const drawn = cullPopulationInstancesOnCpu(new Float32Array(source), new Uint32Array(source), batch, visible, params, [], new Uint32Array(compacted), stats);
  new Uint32Array(args)[pu[base + PCU("argsWord")]!] += drawn;
  const sw = new Uint32Array(statsBytes);
  sw[STATS_WORD.drawn] += stats.drawn;
  sw[STATS_WORD.culledFrustum] += stats.culledFrustum;
  sw[STATS_WORD.culledDistance] += stats.culledDistance;
  sw[STATS_WORD.culledOccluded] += stats.culledOccluded;
  sw[STATS_WORD.culledBatch] += stats.culledBatch;
});
