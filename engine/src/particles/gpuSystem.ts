/**
 * GPU-authoritative particle system (Phase 12).
 *
 * One storage buffer holds every particle. Simulation, emission, culling, billboard drawing and
 * (when {@link GpuParticleSystemOptions.ribbons} is set) trail-history ribbon drawing all
 * run as compute/render passes against that buffer — 100k particles never become 100k ECS entities.
 * The CPU path ({@link ParticleSimulation}) remains the reference; this class is the GPU authority
 * when a device is available.
 */

import { BufferUsage, ShaderStage, TextureUsage, gpuSource } from "../gpu/constants.js";
import type { GraphicsDevice } from "../gpu/device.js";
import type { RenderGraph, RenderGraphHandle, RenderGraphPassContext } from "../rendering/renderGraph.js";
import { PARTICLE_FLOATS, PARTICLE_STRIDE } from "./layout.js";
import {
  PARTICLE_CULL_SHADER,
  PARTICLE_EMIT_SHADER,
  PARTICLE_FULL_SIM_SHADER,
  PARTICLE_RENDER_SHADER,
  PARTICLE_RESOLVE_SHADER,
  PARTICLE_RIBBON_RECORD_BYTES,
  PARTICLE_RIBBON_SHADER,
  PARTICLE_RIBBON_VERTS,
  PARTICLE_WORKGROUP,
} from "./shader.js";

export interface GpuParticleEmitterConfig {
  rate: number;
  lifeMin: number;
  lifeMax: number;
  size: number;
  position: { x: number; y: number; z: number };
  jitter: { x: number; y: number; z: number };
  coneDir: { x: number; y: number; z: number };
  coneAngle: number;
  speedMin: number;
  speedMax: number;
  color: { r: number; g: number; b: number; a: number };
}

export interface GpuParticleModulesConfig {
  gravity: { x: number; y: number; z: number };
  drag: number;
  turbulence: number;
  noiseScale: number;
  attractorPos: { x: number; y: number; z: number };
  attractorStrength: number;
  velocityBoost: { x: number; y: number; z: number };
  colorFrom: { r: number; g: number; b: number; a: number };
  colorTo: { r: number; g: number; b: number; a: number };
  sizeStart: number;
  sizeEnd: number;
  /** Stable random multiplier in the range `1 ± sizeVariation`, derived from each particle's life. */
  sizeVariation: number;
  rotationSpeed: number;
}

export interface GpuParticleSystemOptions {
  capacity: number;
  seed?: number;
  /** Max particles spawned per frame (GPU emit budget). */
  maxEmitsPerFrame?: number;
  softParticles?: boolean;
  /** 0 = camera-facing billboard; >0 stretches along velocity. */
  stretch?: number;
  /** Distance cull radius (world units). */
  cullDistance?: number;
  softScale?: number;
  /**
   * Draw camera-facing ribbon strips from the 4-sample trail history (12.4/12.7). Off by default:
   * the strips are real geometry and change pixels; scenes opt in.
   */
  ribbons?: boolean;
  /** Ribbon width in units of the particle's current size. */
  ribbonSizeScale?: number;
  /** Width multiplier at the faded tail end of a strip (0 = point, 1 = no taper). */
  ribbonTailWidth?: number;
  emitter?: Partial<GpuParticleEmitterConfig>;
  modules?: Partial<GpuParticleModulesConfig>;
}

export interface GpuParticleFrameInput {
  /** Duration of one simulation substep. */
  dt: number;
  /** Fixed simulation substeps accumulated for this rendered frame. Defaults to one. */
  simulationSteps?: number;
  viewProj: Float32Array | number[];
  cameraPos: { x: number; y: number; z: number };
  cameraRight: { x: number; y: number; z: number };
  cameraUp: { x: number; y: number; z: number };
}

const EMIT_UNIFORM_BYTES = 96;
const SIM_UNIFORM_BYTES = 128;
const CULL_UNIFORM_BYTES = 96;
const RENDER_UNIFORM_BYTES = 128;
const RIBBON_UNIFORM_BYTES = 128;
/** Two 4-word records: billboard draw (words 0-3) and ribbon draw (words 4-7). */
const INDIRECT_BYTES = 32;

function defaultEmitter(partial: Partial<GpuParticleEmitterConfig> = {}): GpuParticleEmitterConfig {
  return {
    rate: partial.rate ?? 2000,
    lifeMin: partial.lifeMin ?? 1.2,
    lifeMax: partial.lifeMax ?? 2.4,
    size: partial.size ?? 0.18,
    position: partial.position ?? { x: 0, y: 0.35, z: 0 },
    jitter: partial.jitter ?? { x: 0.15, y: 0.05, z: 0.15 },
    coneDir: partial.coneDir ?? { x: 0, y: 1, z: 0 },
    coneAngle: partial.coneAngle ?? 0.32,
    speedMin: partial.speedMin ?? 5,
    speedMax: partial.speedMax ?? 9,
    color: partial.color ?? { r: 1, g: 0.78, b: 0.28, a: 1 },
  };
}

function defaultModules(partial: Partial<GpuParticleModulesConfig> = {}): GpuParticleModulesConfig {
  return {
    gravity: partial.gravity ?? { x: 0, y: -9.81, z: 0 },
    drag: partial.drag ?? 0.35,
    turbulence: partial.turbulence ?? 1.5,
    noiseScale: partial.noiseScale ?? 0.35,
    attractorPos: partial.attractorPos ?? { x: 0, y: 2, z: 0 },
    attractorStrength: partial.attractorStrength ?? 0,
    velocityBoost: partial.velocityBoost ?? { x: 0, y: 0, z: 0 },
    colorFrom: partial.colorFrom ?? { r: 1, g: 0.78, b: 0.28, a: 1 },
    colorTo: partial.colorTo ?? { r: 0.75, g: 0.1, b: 0.04, a: 0 },
    sizeStart: partial.sizeStart ?? 0.28,
    sizeEnd: partial.sizeEnd ?? 0.04,
    sizeVariation: partial.sizeVariation ?? 0,
    rotationSpeed: partial.rotationSpeed ?? 0.6,
  };
}

/**
 * Authoritative GPU particle buffer + emit/sim/cull/render/resolve pipelines.
 * Create once per device; enqueue into the render graph every frame.
 *
 * The `particle.render` pass submits through the *same* compacted visible list twice when
 * {@link GpuParticleSystemOptions.ribbons} is set: the ribbon pipeline (trail-history strips,
 * 12.4/12.7) draws first and the billboard pipeline caps it. Both reads are vertex pulls against
 * the storage buffers; there is no per-particle geometry, mesh, or entity anywhere.
 */
export class GpuParticleSystem {
  readonly capacity: number;
  readonly seed: number;
  readonly maxEmitsPerFrame: number;
  softParticles: boolean;
  stretch: number;
  cullDistance: number;
  softScale: number;
  /** Draw trail-history ribbons in `particle.render` (12.4/12.7). Toggles take effect next frame. */
  ribbons: boolean;
  ribbonSizeScale: number;
  ribbonTailWidth: number;
  /** Ribbon draws issued by the most recent {@link prepare}+graph-executed frame (mock arm). */
  lastRibbonDrawn = false;
  emitter: GpuParticleEmitterConfig;
  modules: GpuParticleModulesConfig;

  /** True once GPU resources exist. */
  ready = false;
  /** Cumulative spawn count (CPU accounting; GPU is authoritative for state). */
  emitted = 0;
  /** Fixed simulation substeps encoded so far. */
  stepCount = 0;
  /** Substeps requested by the most recent prepare. */
  lastSimulationSteps = 1;
  /** Last encode's emit budget (for overlays / tests). */
  lastEmitBudget = 0;
  /** Pass names enqueued on the most recent {@link enqueue} call. */
  lastEnqueuedPasses: string[] = [];

  private readonly device: GPUDevice;
  private particleBuffer: GPUBuffer | null = null;
  private trailBuffer: GPUBuffer | null = null;
  private visibleBuffer: GPUBuffer | null = null;
  private indirectBuffer: GPUBuffer | null = null;
  private emitUniform: GPUBuffer | null = null;
  private simUniform: GPUBuffer | null = null;
  private cullUniform: GPUBuffer | null = null;
  private renderUniform: GPUBuffer | null = null;

  private emitPipeline: GPUComputePipeline | null = null;
  private simPipeline: GPUComputePipeline | null = null;
  private cullPipeline: GPUComputePipeline | null = null;
  private resolvePipeline: GPUComputePipeline | null = null;
  private renderPipeline: GPURenderPipeline | null = null;
  private renderPipelineFormat: GPUTextureFormat | null = null;
  private renderDepthFormat: GPUTextureFormat | null = null;
  /** Render WGSL module, created + latched in init (same assertShader path as compute). */
  private renderModule: GPUShaderModule | null = null;

  /** Ribbon draw (12.4/12.7): pipeline, module, uniform and bind group, all latched in init. */
  private ribbonPipeline: GPURenderPipeline | null = null;
  private ribbonPipelineFormat: GPUTextureFormat | null = null;
  private ribbonDepthFormat: GPUTextureFormat | null = null;
  private ribbonModule: GPUShaderModule | null = null;
  private ribbonUniform: GPUBuffer | null = null;

  private emitLayout: GPUBindGroupLayout | null = null;
  private simLayout: GPUBindGroupLayout | null = null;
  private cullLayout: GPUBindGroupLayout | null = null;
  private resolveLayout: GPUBindGroupLayout | null = null;
  private renderLayout: GPUBindGroupLayout | null = null;
  private ribbonLayout: GPUBindGroupLayout | null = null;

  /** Cached bind groups — recreated on dispose/re-init or when bound resources change. */
  private emitBindGroup: GPUBindGroup | null = null;
  private simBindGroup: GPUBindGroup | null = null;
  private cullBindGroup: GPUBindGroup | null = null;
  private resolveBindGroup: GPUBindGroup | null = null;
  private renderBindGroup: GPUBindGroup | null = null;
  private ribbonBindGroup: GPUBindGroup | null = null;
  /** Physical depth texture last bound into {@link renderBindGroup} (soft-particle sample). */
  private renderBindDepth: GPUTexture | null = null;
  /** Depth texture last bound into {@link ribbonBindGroup}; same rebuild rule. */
  private ribbonBindDepth: GPUTexture | null = null;

  private writeHead = 0;
  private emitAccumulator = 0;
  private time = 0;
  private disposed = false;
  /** True when running on the headless mock (no WGSL execution). */
  private readonly isMock: boolean;

  constructor(gpu: GraphicsDevice | GPUDevice, options: GpuParticleSystemOptions) {
    const asGd = gpu as GraphicsDevice;
    if (asGd && typeof asGd === "object" && "isMock" in asGd && asGd.device) {
      this.device = asGd.device;
      this.isMock = Boolean(asGd.isMock);
    } else {
      this.device = gpu as GPUDevice;
      this.isMock = typeof (this.device as { record?: unknown }).record === "function";
    }
    this.capacity = Math.max(PARTICLE_WORKGROUP, options.capacity | 0);
    this.seed = (options.seed ?? 7) >>> 0;
    this.maxEmitsPerFrame = Math.max(1, options.maxEmitsPerFrame ?? 4096);
    this.softParticles = options.softParticles !== false;
    this.stretch = options.stretch ?? 0;
    this.cullDistance = options.cullDistance ?? 80;
    this.softScale = options.softScale ?? 40;
    this.ribbons = options.ribbons === true;
    this.ribbonSizeScale = options.ribbonSizeScale ?? 0.7;
    this.ribbonTailWidth = options.ribbonTailWidth ?? 0.25;
    this.emitter = defaultEmitter(options.emitter);
    this.modules = defaultModules(options.modules);
  }

  /** Allocate buffers and compile pipelines. Safe to call more than once. Awaits shader validation before ready. */
  async init(): Promise<void> {
    if (this.ready || this.disposed) return;
    const d = this.device;
    const storageBytes = this.capacity * PARTICLE_STRIDE;
    const trailBytes = this.capacity * 4 * 16;

    this.particleBuffer = d.createBuffer({
      label: "gpuParticles.state",
      size: storageBytes,
      usage: BufferUsage.STORAGE | BufferUsage.COPY_SRC | BufferUsage.COPY_DST,
    });
    this.trailBuffer = d.createBuffer({
      label: "gpuParticles.trails",
      size: trailBytes,
      usage: BufferUsage.STORAGE | BufferUsage.COPY_DST,
    });
    this.visibleBuffer = d.createBuffer({
      label: "gpuParticles.visible",
      size: this.capacity * 4,
      usage: BufferUsage.STORAGE | BufferUsage.COPY_DST,
    });
    this.indirectBuffer = d.createBuffer({
      label: "gpuParticles.indirect",
      size: INDIRECT_BYTES,
      usage: BufferUsage.STORAGE | BufferUsage.INDIRECT | BufferUsage.COPY_DST,
    });
    this.emitUniform = d.createBuffer({
      label: "gpuParticles.emitParams",
      size: EMIT_UNIFORM_BYTES,
      usage: BufferUsage.UNIFORM | BufferUsage.COPY_DST,
    });
    this.simUniform = d.createBuffer({
      label: "gpuParticles.simParams",
      size: SIM_UNIFORM_BYTES,
      usage: BufferUsage.UNIFORM | BufferUsage.COPY_DST,
    });
    this.cullUniform = d.createBuffer({
      label: "gpuParticles.cullParams",
      size: CULL_UNIFORM_BYTES,
      usage: BufferUsage.UNIFORM | BufferUsage.COPY_DST,
    });
    this.renderUniform = d.createBuffer({
      label: "gpuParticles.renderParams",
      size: RENDER_UNIFORM_BYTES,
      usage: BufferUsage.UNIFORM | BufferUsage.COPY_DST,
    });
    this.ribbonUniform = d.createBuffer({
      label: "gpuParticles.ribbonParams",
      size: RIBBON_UNIFORM_BYTES,
      usage: BufferUsage.UNIFORM | BufferUsage.COPY_DST,
    });

    // Clear particle + trail storage.
    // Real GPU: visible starts as 0xFFFFFFFF (culled sentinel); cull compact fills [0,V) and drawIndirect uses V.
    // Mock: sequential visible[i]=i + instanceCount=capacity (WGSL cull does not run).
    d.queue.writeBuffer(this.particleBuffer, 0, gpuSource(new Float32Array(this.capacity * PARTICLE_FLOATS)));
    d.queue.writeBuffer(this.trailBuffer, 0, gpuSource(new Float32Array(this.capacity * 4 * 4)));
    if (this.isMock) {
      const sequential = new Uint32Array(this.capacity);
      for (let i = 0; i < this.capacity; i++) sequential[i] = i;
      d.queue.writeBuffer(this.visibleBuffer, 0, gpuSource(sequential));
      d.queue.writeBuffer(
        this.indirectBuffer,
        0,
        gpuSource(
          new Uint32Array([
            6,
            this.capacity,
            0,
            0,
            PARTICLE_RIBBON_VERTS,
            this.ribbons ? this.capacity : 0,
            0,
            0,
          ]),
        ),
      );
    } else {
      const sentinels = new Uint32Array(this.capacity);
      sentinels.fill(0xffffffff);
      d.queue.writeBuffer(this.visibleBuffer, 0, gpuSource(sentinels));
      // Words 1 and 5 (the instance counts) are reset by `prepare` every frame; these seeds are
      // the backstop that makes a frame-before-prepare draw harmless.
      d.queue.writeBuffer(
        this.indirectBuffer,
        0,
        gpuSource(new Uint32Array([6, 0, 0, 0, PARTICLE_RIBBON_VERTS, 0, 0, 0])),
      );
    }

    this.emitLayout = d.createBindGroupLayout({
      label: "gpuParticles.emit",
      entries: [
        { binding: 0, visibility: ShaderStage.COMPUTE, buffer: { type: "uniform" } },
        { binding: 1, visibility: ShaderStage.COMPUTE, buffer: { type: "storage" } },
        // The ring of a reused slot is reset at spawn so a new particle never draws the previous
        // occupant's trail — that binding is part of the emit contract, not ribbon-only state.
        { binding: 2, visibility: ShaderStage.COMPUTE, buffer: { type: "storage" } },
      ],
    });
    this.simLayout = d.createBindGroupLayout({
      label: "gpuParticles.sim",
      entries: [
        { binding: 0, visibility: ShaderStage.COMPUTE, buffer: { type: "uniform" } },
        { binding: 1, visibility: ShaderStage.COMPUTE, buffer: { type: "storage" } },
        { binding: 2, visibility: ShaderStage.COMPUTE, buffer: { type: "storage" } },
      ],
    });
    this.cullLayout = d.createBindGroupLayout({
      label: "gpuParticles.cull",
      entries: [
        { binding: 0, visibility: ShaderStage.COMPUTE, buffer: { type: "uniform" } },
        { binding: 1, visibility: ShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
        { binding: 2, visibility: ShaderStage.COMPUTE, buffer: { type: "storage" } },
        { binding: 3, visibility: ShaderStage.COMPUTE, buffer: { type: "storage" } },
      ],
    });
    this.resolveLayout = d.createBindGroupLayout({
      label: "gpuParticles.resolve",
      entries: [{ binding: 0, visibility: ShaderStage.COMPUTE, buffer: { type: "storage" } }],
    });
    this.renderLayout = d.createBindGroupLayout({
      label: "gpuParticles.render",
      entries: [
        { binding: 0, visibility: ShaderStage.VERTEX | ShaderStage.FRAGMENT, buffer: { type: "uniform" } },
        { binding: 1, visibility: ShaderStage.VERTEX, buffer: { type: "read-only-storage" } },
        { binding: 2, visibility: ShaderStage.VERTEX, buffer: { type: "read-only-storage" } },
        { binding: 3, visibility: ShaderStage.FRAGMENT, texture: { sampleType: "depth", viewDimension: "2d" } },
      ],
    });
    this.ribbonLayout = d.createBindGroupLayout({
      label: "gpuParticles.ribbon",
      entries: [
        { binding: 0, visibility: ShaderStage.VERTEX | ShaderStage.FRAGMENT, buffer: { type: "uniform" } },
        { binding: 1, visibility: ShaderStage.VERTEX, buffer: { type: "read-only-storage" } },
        { binding: 2, visibility: ShaderStage.VERTEX, buffer: { type: "read-only-storage" } },
        { binding: 3, visibility: ShaderStage.VERTEX, buffer: { type: "read-only-storage" } },
        { binding: 4, visibility: ShaderStage.FRAGMENT, texture: { sampleType: "depth", viewDimension: "2d" } },
      ],
    });

    const emitMod = d.createShaderModule({ label: "gpuParticles.emit", code: PARTICLE_EMIT_SHADER });
    const simMod = d.createShaderModule({ label: "gpuParticles.fullSim", code: PARTICLE_FULL_SIM_SHADER });
    const cullMod = d.createShaderModule({ label: "gpuParticles.cull", code: PARTICLE_CULL_SHADER });
    const resolveMod = d.createShaderModule({ label: "gpuParticles.resolve", code: PARTICLE_RESOLVE_SHADER });
    const renderMod = d.createShaderModule({ label: "gpuParticles.render", code: PARTICLE_RENDER_SHADER });
    const ribbonMod = d.createShaderModule({ label: "gpuParticles.ribbon", code: PARTICLE_RIBBON_SHADER });
    await Promise.all([
      this.assertShader(emitMod),
      this.assertShader(simMod),
      this.assertShader(cullMod),
      this.assertShader(resolveMod),
      this.assertShader(renderMod),
      this.assertShader(ribbonMod),
    ]);
    // dispose() may have run while we awaited shader validation — do not create pipelines or latch ready.
    if (this.disposed) return;
    this.renderModule = renderMod;
    this.ribbonModule = ribbonMod;

    this.emitPipeline = d.createComputePipeline({
      label: "gpuParticles.emit",
      layout: d.createPipelineLayout({ bindGroupLayouts: [this.emitLayout] }),
      compute: { module: emitMod, entryPoint: "csEmit" },
    });
    this.simPipeline = d.createComputePipeline({
      label: "gpuParticles.sim",
      layout: d.createPipelineLayout({ bindGroupLayouts: [this.simLayout] }),
      compute: { module: simMod, entryPoint: "csSim" },
    });
    this.cullPipeline = d.createComputePipeline({
      label: "gpuParticles.cull",
      layout: d.createPipelineLayout({ bindGroupLayouts: [this.cullLayout] }),
      compute: { module: cullMod, entryPoint: "csCull" },
    });
    this.resolvePipeline = d.createComputePipeline({
      label: "gpuParticles.resolve",
      layout: d.createPipelineLayout({ bindGroupLayouts: [this.resolveLayout] }),
      compute: { module: resolveMod, entryPoint: "csResolve" },
    });

    if (this.disposed) return;
    this.ready = true;
  }

  private async assertShader(module: GPUShaderModule): Promise<void> {
    const compilable = module as unknown as { getCompilationInfo?: () => Promise<{ messages: { type: string; message: string }[] }> };
    if (typeof compilable.getCompilationInfo !== "function") return;
    const info = await compilable.getCompilationInfo();
    const errors = info.messages.filter((m) => m.type === "error");
    if (errors.length > 0) {
      throw new Error(`gpu particle shader failed: ${errors.map((m) => m.message).join("; ")}`);
    }
  }

  private ensureRenderPipeline(colorFormat: GPUTextureFormat, depthFormat: GPUTextureFormat): GPURenderPipeline {
    if (this.renderPipeline && this.renderPipelineFormat === colorFormat && this.renderDepthFormat === depthFormat) {
      return this.renderPipeline;
    }
    const d = this.device;
    const mod = this.renderModule;
    if (!mod) {
      throw new Error("gpuParticles.render module missing; call init() before enqueue");
    }
    this.renderPipeline = d.createRenderPipeline({
      label: "gpuParticles.render",
      layout: d.createPipelineLayout({ bindGroupLayouts: [this.renderLayout!] }),
      vertex: { module: mod, entryPoint: "vsMain", buffers: [] },
      fragment: {
        module: mod,
        entryPoint: "fsMain",
        targets: [
          {
            format: colorFormat,
            blend: {
              color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha", operation: "add" },
              alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
            },
            writeMask: 0xf,
          },
        ],
      },
      primitive: { topology: "triangle-list", cullMode: "none", frontFace: "cw" },
      depthStencil: {
        format: depthFormat,
        depthWriteEnabled: false,
        depthCompare: "less-equal",
      },
    });
    this.renderPipelineFormat = colorFormat;
    this.renderDepthFormat = depthFormat;
    return this.renderPipeline;
  }

  /** Ribbon pipeline: same color/depth contract as the billboards, different vertex program. */
  private ensureRibbonPipeline(colorFormat: GPUTextureFormat, depthFormat: GPUTextureFormat): GPURenderPipeline {
    if (this.ribbonPipeline && this.ribbonPipelineFormat === colorFormat && this.ribbonDepthFormat === depthFormat) {
      return this.ribbonPipeline;
    }
    const d = this.device;
    const mod = this.ribbonModule;
    if (!mod) {
      throw new Error("gpuParticles.ribbon module missing; call init() before enqueue");
    }
    this.ribbonPipeline = d.createRenderPipeline({
      label: "gpuParticles.ribbon",
      layout: d.createPipelineLayout({ bindGroupLayouts: [this.ribbonLayout!] }),
      vertex: { module: mod, entryPoint: "vsRibbon", buffers: [] },
      fragment: {
        module: mod,
        entryPoint: "fsRibbon",
        targets: [
          {
            format: colorFormat,
            blend: {
              color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha", operation: "add" },
              alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
            },
            writeMask: 0xf,
          },
        ],
      },
      // Double-sided on purpose: the strip's winding follows the camera/segment geometry, and a
      // camera-facing construction makes back-face rejection meaningless (and flip-prone).
      primitive: { topology: "triangle-list", cullMode: "none" },
      depthStencil: {
        format: depthFormat,
        depthWriteEnabled: false,
        depthCompare: "less-equal",
      },
    });
    this.ribbonPipelineFormat = colorFormat;
    this.ribbonDepthFormat = depthFormat;
    return this.ribbonPipeline;
  }

  /** Toggle trail ribbons. Takes effect on the next {@link prepare}; no pipeline rebuild needed. */
  setRibbons(enabled: boolean): void {
    this.ribbons = enabled;
  }

  /** Advance CPU emit accumulator and write all uniforms for this frame. */
  prepare(frame: GpuParticleFrameInput): void {
    if (!this.ready || this.disposed) return;
    const dt = Math.max(0, frame.dt);
    const simulationSteps = Math.max(0, Math.floor(frame.simulationSteps ?? 1));
    const elapsed = dt * simulationSteps;
    this.lastSimulationSteps = simulationSteps;
    this.time += elapsed;
    this.emitAccumulator += Math.max(0, this.emitter.rate) * elapsed;
    let budget = Math.floor(this.emitAccumulator);
    if (budget > this.maxEmitsPerFrame) budget = this.maxEmitsPerFrame;
    if (budget > this.capacity) budget = this.capacity;
    this.emitAccumulator -= budget;
    this.lastEmitBudget = budget;
    const emitBase = this.emitted >>> 0;
    this.emitted += budget;
    this.writeEmitUniforms(budget, emitBase);
    this.writeSimUniforms(dt);
    this.writeCullUniforms(frame);
    this.writeRenderUniforms(frame);
    this.writeRibbonUniforms(frame);
    // Reset indirect instanceCount before cull; keep vertexCount=6. Do not rewrite visible[] —
    // cull compact owns [0,V); drawIndirect uses the compacted count (mock keeps capacity).
    // The ribbon record (words 4-7) counts survivors through the same pass, so its seeded count
    // is reset with the same rule; when ribbons are off the second draw is never issued at all.
    if (this.isMock) {
      this.device.queue.writeBuffer(
        this.indirectBuffer!,
        0,
        gpuSource(
          new Uint32Array([
            6,
            this.capacity,
            0,
            0,
            PARTICLE_RIBBON_VERTS,
            this.ribbons ? this.capacity : 0,
            0,
            0,
          ]),
        ),
      );
    } else {
      this.device.queue.writeBuffer(
        this.indirectBuffer!,
        0,
        gpuSource(new Uint32Array([6, 0, 0, 0, PARTICLE_RIBBON_VERTS, 0, 0, 0])),
      );
    }
  }

  private writeEmitUniforms(budget: number, emitBase: number): void {
    const buf = new ArrayBuffer(EMIT_UNIFORM_BYTES);
    const f = new Float32Array(buf);
    const u = new Uint32Array(buf);
    const e = this.emitter;
    f[0] = e.position.x;
    f[1] = e.position.y;
    f[2] = e.position.z;
    f[3] = e.size;
    f[4] = e.coneDir.x;
    f[5] = e.coneDir.y;
    f[6] = e.coneDir.z;
    f[7] = e.coneAngle;
    f[8] = e.color.r;
    f[9] = e.color.g;
    f[10] = e.color.b;
    f[11] = e.color.a;
    f[12] = e.jitter.x;
    f[13] = e.jitter.y;
    f[14] = e.jitter.z;
    f[15] = e.lifeMin;
    f[16] = e.speedMin;
    f[17] = e.speedMax;
    f[18] = e.lifeMax;
    u[19] = this.seed;
    u[20] = this.writeHead >>> 0;
    u[21] = budget >>> 0;
    u[22] = this.capacity >>> 0;
    u[23] = emitBase >>> 0;
    this.device.queue.writeBuffer(this.emitUniform!, 0, gpuSource(new Uint8Array(buf)));
    this.writeHead = (this.writeHead + budget) % this.capacity;
  }

  private writeSimUniforms(dt: number): void {
    const buf = new ArrayBuffer(SIM_UNIFORM_BYTES);
    const f = new Float32Array(buf);
    const u = new Uint32Array(buf);
    const m = this.modules;
    f[0] = dt;
    f[1] = m.drag;
    f[2] = this.time;
    u[3] = this.capacity;
    f[4] = m.gravity.x;
    f[5] = m.gravity.y;
    f[6] = m.gravity.z;
    f[7] = m.turbulence;
    f[8] = m.attractorPos.x;
    f[9] = m.attractorPos.y;
    f[10] = m.attractorPos.z;
    f[11] = m.attractorStrength;
    f[12] = m.colorFrom.r;
    f[13] = m.colorFrom.g;
    f[14] = m.colorFrom.b;
    f[15] = m.colorFrom.a;
    f[16] = m.colorTo.r;
    f[17] = m.colorTo.g;
    f[18] = m.colorTo.b;
    f[19] = m.colorTo.a;
    f[20] = m.sizeStart;
    f[21] = m.sizeEnd;
    f[22] = m.noiseScale;
    f[23] = m.rotationSpeed;
    f[24] = m.velocityBoost.x;
    f[25] = m.velocityBoost.y;
    f[26] = m.velocityBoost.z;
    u[27] = this.seed;
    f[28] = Math.max(0, Math.min(1, m.sizeVariation));
    this.device.queue.writeBuffer(this.simUniform!, 0, gpuSource(new Uint8Array(buf)));
  }

  private writeCullUniforms(frame: GpuParticleFrameInput): void {
    const buf = new ArrayBuffer(CULL_UNIFORM_BYTES);
    const f = new Float32Array(buf);
    const u = new Uint32Array(buf);
    f.set(frame.viewProj as ArrayLike<number>, 0);
    f[16] = frame.cameraPos.x;
    f[17] = frame.cameraPos.y;
    f[18] = frame.cameraPos.z;
    u[19] = this.capacity;
    f[20] = this.cullDistance;
    // Bit 0: the ribbon draw is active, so the cull pass counts survivors into indirect word 5 as
    // well. A ribbon draw of a list the culler never filled would be a read of stale indices.
    u[21] = this.ribbons ? 1 : 0;
    this.device.queue.writeBuffer(this.cullUniform!, 0, gpuSource(new Uint8Array(buf)));
  }

  private writeRenderUniforms(frame: GpuParticleFrameInput): void {
    const buf = new ArrayBuffer(RENDER_UNIFORM_BYTES);
    const f = new Float32Array(buf);
    const u = new Uint32Array(buf);
    f.set(frame.viewProj as ArrayLike<number>, 0);
    f[16] = frame.cameraPos.x;
    f[17] = frame.cameraPos.y;
    f[18] = frame.cameraPos.z;
    f[19] = this.softScale;
    f[20] = frame.cameraRight.x;
    f[21] = frame.cameraRight.y;
    f[22] = frame.cameraRight.z;
    f[23] = this.stretch;
    f[24] = frame.cameraUp.x;
    f[25] = frame.cameraUp.y;
    f[26] = frame.cameraUp.z;
    u[27] = this.softParticles ? 1 : 0;
    f[28] = 1;
    f[29] = 1;
    f[30] = 1;
    f[31] = 1;
    this.device.queue.writeBuffer(this.renderUniform!, 0, gpuSource(new Uint8Array(buf)));
  }

  /**
   * Ribbon uniforms share the frame's camera basis but are their own 128-byte block — writing them
   * next to the billboard ones is what keeps the two stages' sizes/tapers independent.
   */
  private writeRibbonUniforms(frame: GpuParticleFrameInput): void {
    const buf = new ArrayBuffer(RIBBON_UNIFORM_BYTES);
    const f = new Float32Array(buf);
    const u = new Uint32Array(buf);
    f.set(frame.viewProj as ArrayLike<number>, 0);
    f[16] = frame.cameraPos.x;
    f[17] = frame.cameraPos.y;
    f[18] = frame.cameraPos.z;
    f[19] = this.softScale;
    f[20] = frame.cameraRight.x;
    f[21] = frame.cameraRight.y;
    f[22] = frame.cameraRight.z;
    f[23] = this.ribbonSizeScale;
    f[24] = this.ribbonTailWidth;
    u[25] = this.softParticles ? 1 : 0;
    f[28] = 1;
    f[29] = 1;
    f[30] = 1;
    f[31] = 1;
    this.device.queue.writeBuffer(this.ribbonUniform!, 0, gpuSource(new Uint8Array(buf)));
  }

  /**
   * Enqueue `particle.sim` → `particle.sort` → `particle.render` → `particle.resolve` into the
   * active render graph. `particle.sort` is the frustum/distance compact (HiZ deferred).
   */
  enqueue(
    graph: RenderGraph,
    opts: {
      color: RenderGraphHandle;
      depth: RenderGraphHandle;
      colorFormat: GPUTextureFormat;
      depthFormat: GPUTextureFormat;
    },
  ): void {
    if (!this.ready || this.disposed) return;
    const passes = this.lastSimulationSteps > 0
      ? ["particle.sim", "particle.sort", "particle.render", "particle.resolve"]
      : ["particle.sort", "particle.render", "particle.resolve"];
    this.lastEnqueuedPasses = passes;

    if (this.lastSimulationSteps > 0) {
      graph.addPass({
        name: "particle.sim",
        sideEffect: true,
        execute: (ctx) => this.encodeSim(ctx),
      });
    }
    graph.addPass({
      name: "particle.sort",
      sideEffect: true,
      execute: (ctx) => this.encodeCull(ctx),
    });
    graph.addPass({
      name: "particle.render",
      reads: [opts.depth],
      color: [{ texture: opts.color, loadOp: "load" }],
      // Read-only on purpose: this pass SAMPLES the scene depth (soft-particle fade), which WebGPU
      // only allows while the attachment is read-only. The spec's implicit "load" for read-only
      // depth is the same primitive the sky pass stopped relying on (WebKit lost the main pass's
      // depth through it on iOS); here a wrong load only fades soft particles, never paints over
      // the scene, so the read-only attach stays.
      depth: { texture: opts.depth, depthReadOnly: true },
      execute: (ctx) => this.encodeRender(ctx, opts.colorFormat, opts.depthFormat, opts.depth),
    });
    graph.addPass({
      name: "particle.resolve",
      sideEffect: true,
      execute: (ctx) => this.encodeResolve(ctx),
    });
    this.stepCount += this.lastSimulationSteps;
  }

  private ensureEmitBindGroup(): GPUBindGroup {
    if (!this.emitBindGroup) {
      this.emitBindGroup = this.device.createBindGroup({
        layout: this.emitLayout!,
        entries: [
          { binding: 0, resource: { buffer: this.emitUniform! } },
          { binding: 1, resource: { buffer: this.particleBuffer! } },
          { binding: 2, resource: { buffer: this.trailBuffer! } },
        ],
      });
    }
    return this.emitBindGroup;
  }

  private ensureSimBindGroup(): GPUBindGroup {
    if (!this.simBindGroup) {
      this.simBindGroup = this.device.createBindGroup({
        layout: this.simLayout!,
        entries: [
          { binding: 0, resource: { buffer: this.simUniform! } },
          { binding: 1, resource: { buffer: this.particleBuffer! } },
          { binding: 2, resource: { buffer: this.trailBuffer! } },
        ],
      });
    }
    return this.simBindGroup;
  }

  private ensureCullBindGroup(): GPUBindGroup {
    if (!this.cullBindGroup) {
      this.cullBindGroup = this.device.createBindGroup({
        layout: this.cullLayout!,
        entries: [
          { binding: 0, resource: { buffer: this.cullUniform! } },
          { binding: 1, resource: { buffer: this.particleBuffer! } },
          { binding: 2, resource: { buffer: this.visibleBuffer! } },
          { binding: 3, resource: { buffer: this.indirectBuffer! } },
        ],
      });
    }
    return this.cullBindGroup;
  }

  private ensureResolveBindGroup(): GPUBindGroup {
    if (!this.resolveBindGroup) {
      this.resolveBindGroup = this.device.createBindGroup({
        layout: this.resolveLayout!,
        entries: [{ binding: 0, resource: { buffer: this.indirectBuffer! } }],
      });
    }
    return this.resolveBindGroup;
  }

  /** Recreate when the soft-particle depth texture changes (graph pool epoch / resize). */
  private ensureRenderBindGroup(depthTex: GPUTexture): GPUBindGroup {
    if (!this.renderBindGroup || this.renderBindDepth !== depthTex) {
      this.renderBindDepth = depthTex;
      this.renderBindGroup = this.device.createBindGroup({
        layout: this.renderLayout!,
        entries: [
          { binding: 0, resource: { buffer: this.renderUniform! } },
          { binding: 1, resource: { buffer: this.particleBuffer! } },
          { binding: 2, resource: { buffer: this.visibleBuffer! } },
          { binding: 3, resource: depthTex.createView({ aspect: "depth-only" }) },
        ],
      });
    }
    return this.renderBindGroup;
  }

  /** Same rebuild rule as {@link ensureRenderBindGroup}: the view belongs to the pooled texture. */
  private ensureRibbonBindGroup(depthTex: GPUTexture): GPUBindGroup {
    if (!this.ribbonBindGroup || this.ribbonBindDepth !== depthTex) {
      this.ribbonBindDepth = depthTex;
      this.ribbonBindGroup = this.device.createBindGroup({
        layout: this.ribbonLayout!,
        entries: [
          { binding: 0, resource: { buffer: this.ribbonUniform! } },
          { binding: 1, resource: { buffer: this.particleBuffer! } },
          { binding: 2, resource: { buffer: this.visibleBuffer! } },
          { binding: 3, resource: { buffer: this.trailBuffer! } },
          { binding: 4, resource: depthTex.createView({ aspect: "depth-only" }) },
        ],
      });
    }
    return this.ribbonBindGroup;
  }

  private clearBindGroups(): void {
    this.emitBindGroup = null;
    this.simBindGroup = null;
    this.cullBindGroup = null;
    this.resolveBindGroup = null;
    this.renderBindGroup = null;
    this.ribbonBindGroup = null;
    this.renderBindDepth = null;
    this.ribbonBindDepth = null;
  }

  private encodeSim(ctx: RenderGraphPassContext): void {
    const emitGroup = this.ensureEmitBindGroup();
    const simGroup = this.ensureSimBindGroup();
    const pass = ctx.beginComputePass("particle.sim");
    if (this.lastEmitBudget > 0) {
      pass.setPipeline(this.emitPipeline!);
      pass.setBindGroup(0, emitGroup);
      pass.dispatchWorkgroups(Math.ceil(this.lastEmitBudget / PARTICLE_WORKGROUP));
    }
    pass.setPipeline(this.simPipeline!);
    pass.setBindGroup(0, simGroup);
    for (let step = 0; step < this.lastSimulationSteps; step++) {
      pass.dispatchWorkgroups(Math.ceil(this.capacity / PARTICLE_WORKGROUP));
    }
    pass.end();
  }

  private encodeCull(ctx: RenderGraphPassContext): void {
    const group = this.ensureCullBindGroup();
    const pass = ctx.beginComputePass("particle.sort");
    pass.setPipeline(this.cullPipeline!);
    pass.setBindGroup(0, group);
    pass.dispatchWorkgroups(Math.ceil(this.capacity / PARTICLE_WORKGROUP));
    pass.end();
  }

  private encodeRender(
    ctx: RenderGraphPassContext,
    colorFormat: GPUTextureFormat,
    depthFormat: GPUTextureFormat,
    depthHandle: RenderGraphHandle,
  ): void {
    const pipeline = this.ensureRenderPipeline(colorFormat, depthFormat);
    const depthTex = ctx.texture(depthHandle);
    const pass = ctx.beginRenderPass("particle.render");
    // Ribbons first: in an alpha-blended pass the draw order is the compositor, and the strips
    // read as trails *under* the sparks that cap them. The billboards keep the same depth rules
    // either way — both pipelines read the prepass/main depth without writing it.
    this.lastRibbonDrawn = false;
    if (this.ribbons) {
      const ribbonPipeline = this.ensureRibbonPipeline(colorFormat, depthFormat);
      pass.setPipeline(ribbonPipeline);
      pass.setBindGroup(0, this.ensureRibbonBindGroup(depthTex));
      pass.drawIndirect(this.indirectBuffer!, PARTICLE_RIBBON_RECORD_BYTES);
      this.lastRibbonDrawn = true;
    }
    const group = this.ensureRenderBindGroup(depthTex);
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, group);
    // Compacted instance count from cull (or capacity on the mock). 0xFFFFFFFF visible slots are degenerate.
    pass.drawIndirect(this.indirectBuffer!, 0);
    pass.end();
  }

  private encodeResolve(ctx: RenderGraphPassContext): void {
    const group = this.ensureResolveBindGroup();
    const pass = ctx.beginComputePass("particle.resolve");
    pass.setPipeline(this.resolvePipeline!);
    pass.setBindGroup(0, group);
    pass.dispatchWorkgroups(1);
    pass.end();
  }

  /** ECS entity count required by this system — always zero. */
  entityCount(): number {
    return 0;
  }

  /** Storage buffer byte size (authoritative GPU particle memory). */
  storageBytes(): number {
    return this.capacity * PARTICLE_STRIDE;
  }

  stats(): Record<string, number | string | boolean> {
    return {
      capacity: this.capacity,
      emitted: this.emitted,
      steps: this.stepCount,
      lastEmitBudget: this.lastEmitBudget,
      entities: 0,
      storageBytes: this.storageBytes(),
      soft: this.softParticles,
      stretch: this.stretch,
      ready: this.ready,
      // Ribbons draw inside `particle.render`; the record's vertex count is the geometry size,
      // and `ribbonDrawn` reports whether the most recent encoded frame issued the draw.
      ribbons: this.ribbons,
      ribbonVerts: PARTICLE_RIBBON_VERTS,
      ribbonDrawn: this.lastRibbonDrawn,
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.ready = false;
    for (const b of [
      this.particleBuffer,
      this.trailBuffer,
      this.visibleBuffer,
      this.indirectBuffer,
      this.emitUniform,
      this.simUniform,
      this.cullUniform,
      this.renderUniform,
      this.ribbonUniform,
    ]) {
      try {
        b?.destroy();
      } catch {
        /* already destroyed */
      }
    }
    this.particleBuffer = null;
    this.trailBuffer = null;
    this.visibleBuffer = null;
    this.indirectBuffer = null;
    this.emitUniform = null;
    this.simUniform = null;
    this.cullUniform = null;
    this.renderUniform = null;
    this.ribbonUniform = null;
    this.emitPipeline = null;
    this.simPipeline = null;
    this.cullPipeline = null;
    this.resolvePipeline = null;
    this.renderPipeline = null;
    this.renderPipelineFormat = null;
    this.renderDepthFormat = null;
    this.renderModule = null;
    this.ribbonPipeline = null;
    this.ribbonPipelineFormat = null;
    this.ribbonDepthFormat = null;
    this.ribbonModule = null;
    this.emitLayout = null;
    this.simLayout = null;
    this.cullLayout = null;
    this.resolveLayout = null;
    this.renderLayout = null;
    this.ribbonLayout = null;
    this.clearBindGroups();
    this.lastEnqueuedPasses = [];
  }
}

/** Minimum usage bits the scene depth target needs when soft particles sample it. */
export const GPU_PARTICLE_DEPTH_USAGE = TextureUsage.RENDER_ATTACHMENT | TextureUsage.TEXTURE_BINDING;
