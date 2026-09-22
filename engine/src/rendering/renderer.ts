/**
 * `Renderer` — one frame in, one frame out.
 *
 * Frame structure (docs/RENDERING.md §1):
 *   1. camera resolution: pick the highest-priority enabled `Camera`, compose view/projection from
 *      its entity's world matrix, and publish them back onto the component (culling, audio and
 *      picking all read the same numbers — never a second copy).
 *   2. cascade fit: split the camera frustum along view depth and fit one light-space box per slice
 *      (`rendering/shadows.ts`). Pure math; nothing GPU-side happens yet.
 *   3. batch assembly: Renderables grouped by (geometry, material pipeline key, transparency, caster
 *      flags), each batch writing its instance matrices into a per-frame arena. Draw cost is
 *      therefore `setBindGroup(dynamic offsets) + drawIndexed`, with no per-draw object creation.
 *      Off-screen shadow casters that still fall inside a cascade land in shadow-only batches.
 *   4. uniform upload: one `writeBuffer` each for the frame block, lights, shadow block, cascade
 *      view-projections, post parameters and the two draw arenas.
 *   5. frame description: the passes are declared on the `RenderGraph` — `forge.shadow.<n>` per
 *      cascade into a depth array, `forge.main` into the HDR target (or the swapchain in LDR mode),
 *      the bloom chain, and `forge.tonemap` into the swapchain. The graph validates, culls, aliases,
 *      records everything into one command buffer and submits it.
 *
 * The renderer is deliberately *not* a scene owner: it reads through `Scene`'s public surface and
 * holds no entity references between frames, so a scene swap costs only the renderable list.
 */

import { BufferUsage, TextureUsage, gpuSource } from "../gpu/constants.js";
import { Double3 } from "../math/double3.js";
import { BufferBuilder, StructAccessor, WriteBuffer } from "../gpu/bufferWriter.js";
import { Mat4 } from "../math/mat.js";
import { Vec3 } from "../math/vec.js";
import { AABB, Frustum } from "../math/geometry.js";
import { alignUp } from "../math/scalar.js";
import { packColorRGBA } from "../math/color.js";
import { PipelineFactory, type PostEntryPoint } from "./pipeline.js";
import { PerFrameUniforms, LightBlock, ShadowUniforms, ShadowPassUniforms, ObjectUniforms, InstanceStruct, PostUniforms, MAX_LIGHTS_PER_FRAME, MAX_CASCADES } from "./uniforms.js";
import { POST_BINDINGS, POST_FLAG_BLOOM, POST_FLAG_KARIS } from "./shaders/post.js";
import { RenderGraph, type RenderGraphHandle, type RenderGraphPassContext } from "./renderGraph.js";
import { computeCascades, type Cascade } from "./shadows.js";
import { TextureDefaults } from "../resources/texture.js";
import { Geometry } from "./geometry.js";
import { Material } from "./material.js";
import { Camera, Light, Renderable } from "../scene/components/index.js";
import type { GraphicsDevice } from "../gpu/device.js";
import type { Scene } from "../scene/scene.js";
import type { SystemContext } from "../scene/systems.js";
import type { RenderFrameContext, SkyParams, PickResult } from "../scene/renderContext.js";
import { InternalError, UsageError } from "../core/errors.js";

export interface RendererOptions {
  /** Force an override clear colour (the editor's "show without sky" mode). */
  clearColor?: number | null;
  /** Shadow map resolution cap per cascade; the scene asks, the quality profile caps. */
  shadowMapSize?: number;
  /** Cascade count cap (1..4); the scene's `shadow.cascades` asks, this caps. */
  shadowCascades?: number;
  /** Master switches from the quality profile. `false` disables regardless of scene settings. */
  shadows?: boolean;
  bloom?: boolean;
  /** Maximum instanced draws before splitting into a second batch (driver-friendly cap). */
  maxInstancesPerBatch?: number;
}

export interface RenderStats {
  drawCalls: number;
  triangles: number;
  instances: number;
  batches: number;
  culled: number;
  /** Draw calls issued by the shadow passes (all cascades). */
  shadowsDrawn: number;
  /** Batch × cascade pairs skipped because the batch lay outside that cascade's box. */
  shadowsCulled: number;
  shadowCascades: number;
  debugLines: number;
  hdr: boolean;
  bloomMips: number;
  /** Render-graph outcome for the frame. */
  passes: number;
  culledPasses: number;
  transientTextures: number;
  physicalTextures: number;
  aliasedBytes: number;
  texturesCreated: number;
}

interface Batch {
  geometry: Geometry;
  material: Material;
  instanceOffset: number;
  count: number;
  transparent: boolean;
  overlay: boolean;
  castShadow: boolean;
  /** Off-screen caster: drawn by the shadow passes only. */
  shadowOnly: boolean;
  indexCount: number;
  indexStart: number;
  depthSort: number;
  objectOffset: number;
  /** Render-local union of the instances' bounds (per-cascade culling). */
  readonly bounds: AABB;
}

interface PostParams {
  srcWidth: number;
  srcHeight: number;
  outWidth: number;
  outHeight: number;
  threshold: number;
  knee: number;
  intensity: number;
  exposure: number;
  toneMapping: number;
  radius: number;
  flags: number;
}

const FORWARD_Z = new Vec3(0, 0, 1);
const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
const TONE_MAP_MODE: Record<string, number> = { none: 0, reinhard: 1, aces: 2, filmic: 3 };
const INSTANCE_STRIDE = 96;
/** Dynamic-offset stride for uniform records (`minUniformBufferOffsetAlignment` baseline). */
const UNIFORM_SLOT = 256;
const MAX_POST_PASSES = 24;
const MAX_BLOOM_MIPS = 6;
const HDR_FORMAT: GPUTextureFormat = "rgba16float";
const SHADOW_FORMAT: GPUTextureFormat = "depth24plus";

export class Renderer implements RenderFrameContext {
  readonly pipelines: PipelineFactory;
  readonly graph: RenderGraph;
  readonly defaults = new TextureDefaults();
  readonly stats: RenderStats = {
    drawCalls: 0,
    triangles: 0,
    instances: 0,
    batches: 0,
    culled: 0,
    shadowsDrawn: 0,
    shadowsCulled: 0,
    shadowCascades: 0,
    debugLines: 0,
    hdr: false,
    bloomMips: 0,
    passes: 0,
    culledPasses: 0,
    transientTextures: 0,
    physicalTextures: 0,
    aliasedBytes: 0,
    texturesCreated: 0,
  };
  instanceCount = 0;

  // CPU-side uniform staging.
  private readonly frameBytes = new WriteBuffer(PerFrameUniforms.byteSize("uniform"));
  private readonly frameAccessor = new StructAccessor(PerFrameUniforms, this.frameBytes, 0, "uniform");
  private readonly lightBytes = new WriteBuffer(LightBlock.byteSize("uniform"));
  private readonly lightAccessor = new StructAccessor(LightBlock, this.lightBytes, 0, "uniform");
  private readonly shadowBytes = new WriteBuffer(ShadowUniforms.byteSize("uniform"));
  private readonly shadowAccessor = new StructAccessor(ShadowUniforms, this.shadowBytes, 0, "uniform");
  private readonly cascadeBytes = new WriteBuffer(MAX_CASCADES * UNIFORM_SLOT);
  private readonly cascadeAccessor = new StructAccessor(ShadowPassUniforms, this.cascadeBytes, 0, "uniform");
  private readonly postBytes = new WriteBuffer(MAX_POST_PASSES * UNIFORM_SLOT);
  private readonly postAccessor = new StructAccessor(PostUniforms, this.postBytes, 0, "uniform");
  private postSlots = 0;

  // GPU buffers and bind groups.
  private frameBuffer: GPUBuffer | null = null;
  private lightBuffer: GPUBuffer | null = null;
  private shadowBuffer: GPUBuffer | null = null;
  private cascadeBuffer: GPUBuffer | null = null;
  private postBuffer: GPUBuffer | null = null;
  private frameBindGroup: GPUBindGroup | null = null;
  private frameBindGroupView: GPUTextureView | null = null;
  private cascadeBindGroup: GPUBindGroup | null = null;
  private objectArena = new BufferBuilder(64 * 1024);
  private instanceArena = new BufferBuilder(64 * 1024);
  private objectBuffer: GPUBuffer | null = null;
  private objectBufferCapacity = 0;
  private instanceBuffer: GPUBuffer | null = null;
  private instanceBufferCapacity = 0;
  private drawBindGroup: GPUBindGroup | null = null;
  private shadowFallback: GPUTexture | null = null;
  private shadowFallbackView: GPUTextureView | null = null;
  private readonly postGroups = new Map<string, GPUBindGroup>();
  private readonly viewIds = new WeakMap<GPUTextureView, number>();
  private viewSerial = 0;
  private graphEpoch = -1;
  private deviceLostUnsub: { dispose(): void } | null = null;

  // Batches (pooled: the same objects are reused every frame).
  private readonly batchPool: Batch[] = [];
  private batchCount = 0;
  private readonly sortedBatches: Batch[] = [];
  private readonly batchIndex = new Map<string, number>();
  private casterBatches = 0;

  // Shadows.
  private readonly cascades: Cascade[] = [];
  private readonly cascadeFrustums: Frustum[] = [new Frustum(), new Frustum(), new Frustum(), new Frustum()];
  private readonly lightList: Light[] = [];

  // Debug lines.
  private debugLines = new Float32Array(4096 * 4);
  private debugLineCount = 0;
  private debugBuffer: GPUBuffer | null = null;
  private debugBufferCapacity = 0;

  private invalidated = true;
  private lastUploadCount = 0;
  private readonly frustum = new Frustum();
  private readonly scratchBox = new AABB();
  private readonly scratchWorldBox = new AABB();
  private readonly scratchVec = new Vec3();
  private readonly scratchDir = new Vec3();
  private readonly scratchMat = new Mat4();
  private readonly scratchMatrix = new Float32Array(16);
  private readonly cameraWorld = new Mat4();
  private readonly view = new Mat4();
  private readonly projection = new Mat4();
  private readonly viewProj = new Mat4();
  private readonly invViewProj = new Mat4();
  private readonly lastCameraPos = new Vec3();
  private readonly lastCameraWorld = new Double3();
  private lost = false;
  private pendingSky: Partial<SkyParams> | null = null;
  private labelsSeen = new Set<string>();
  private currentFrameContext: SystemContext | null = null;

  constructor(
    readonly device: GraphicsDevice,
    readonly options: RendererOptions = {},
  ) {
    this.pipelines = new PipelineFactory(device);
    this.graph = new RenderGraph(device);
    this.deviceLostUnsub = device.onLost(() => {
      this.lost = true;
    });
  }

  get deviceLost(): boolean {
    return this.lost || this.device.lost;
  }

  get width(): number {
    return this.device.pixelWidth;
  }

  get height(): number {
    return this.device.pixelHeight;
  }

  /** Names of the passes the render graph executed last frame, in order. */
  get passNames(): readonly string[] {
    return this.graph.stats.executed;
  }

  /** Call after a canvas resize; frame-sized transients are re-planned by the graph next frame. */
  resize(width: number, height: number): void {
    this.device.resize(width, height);
    this.invalidate();
  }

  invalidate(): void {
    this.invalidated = true;
  }

  /** True when something asked for a redraw since the last frame (editor idle-loop support). */
  get needsRender(): boolean {
    return this.invalidated;
  }

  /** Frames actually rendered (not skipped) — asserted by the "idle loop does not render" test. */
  get framesRendered(): number {
    return this.lastUploadCount;
  }

  // ------------------------------------------------------------------ frame

  /**
   * Render one frame. `context` may be absent (the editor renders without a world tick); in that
   * case only `scene` state is used, which is what makes "render while paused" work.
   */
  renderScene(scene: Scene, context?: SystemContext): void {
    if (this.deviceLost) return;
    this.currentFrameContext = context ?? null;
    scene.world.updateTransforms([]);
    this.defaults.ensure(this.device);
    this.ensureBuffers();
    this.resetStats();

    const cameraHit = scene.findCamera();
    if (!cameraHit) {
      // Nothing to render, but still clear the frame: leaving the previous contents on screen is
      // how "black screen after the first scene" gets misdiagnosed as a pipeline bug.
      this.clearFrame(scene);
      this.finishFrame();
      return;
    }
    const camera = cameraHit.camera;
    const settings = scene.settings;

    // 1. Camera.
    scene.world.getWorldMatrix(cameraHit.entity.id as never, this.cameraWorld);
    // The stored matrix is render-local (relative to the coordinate-space origin), so inverting it
    // is exact for the frame's purposes — no double-precision term is involved here.
    this.view.copyFrom(this.cameraWorld);
    if (!this.view.invert()) {
      this.view.setIdentity();
      this.cameraWorld.setIdentity();
    }
    const aspect = camera.aspectOverride > 0 ? camera.aspectOverride : this.device.aspect;
    this.computeProjection(camera, aspect, this.projection);
    const positionRender = this.lastCameraPos.copyFrom(scene.world.worldPosition(cameraHit.entity.id, this.scratchVec));
    scene.coordinateSpace.toWorld(positionRender, this.lastCameraWorld);
    camera.writeMatrices(this.view, this.projection, positionRender);
    this.viewProj.multiplyMatrices(this.projection, this.view);
    this.frustum.setFromViewProjection(this.viewProj);

    // 2. Lights and cascades.
    const lights = scene.collectLights(this.lightList);
    // Directional lights first, so index 0 is the cascade caster.
    lights.sort((x, y) => (x.kind === "directional" ? 0 : 1) - (y.kind === "directional" ? 0 : 1));
    for (const l of lights) this.refreshLightDirection(scene, l);
    const shadowsWanted = settings.shadow.enabled && this.options.shadows !== false;
    const sun = shadowsWanted ? (lights.find((l) => l.kind === "directional" && l.castShadow) ?? null) : null;
    const cascadeCount = sun ? Math.max(1, Math.min(MAX_CASCADES, Math.floor(settings.shadow.cascades), this.options.shadowCascades ?? MAX_CASCADES)) : 0;
    const shadowSize = clampShadowSize(Math.min(settings.shadow.mapSize, this.options.shadowMapSize ?? settings.shadow.mapSize));
    const shadowDistance = Math.max(camera.near + 1e-3, Math.min(settings.shadow.distance, camera.far));
    if (sun) {
      computeCascades(
        { world: this.cameraWorld, fovY: camera.fovY, aspect, near: camera.near, orthographic: camera.orthographic, orthoHeight: camera.orthoHeight },
        { count: cascadeCount, shadowDistance, lambda: settings.shadow.splitLambda, mapSize: shadowSize, lightDirection: sun.direction },
        this.cascades,
      );
      for (let c = 0; c < cascadeCount; c++) this.cascadeFrustums[c]!.setFromViewProjection(this.cascades[c]!.viewProj);
    }

    // 3. Batches.
    this.collectBatches(scene, camera, cascadeCount);
    const shadowsActive = cascadeCount > 0 && this.casterBatches > 0;
    this.stats.batches = this.batchCount;
    this.stats.shadowCascades = shadowsActive ? cascadeCount : 0;

    // 4. Uniforms.
    const hdr = settings.hdr;
    const scale = Math.min(2, Math.max(0.25, settings.renderScale || 1));
    const renderWidth = hdr ? Math.max(1, Math.round(this.width * scale)) : this.width;
    const renderHeight = hdr ? Math.max(1, Math.round(this.height * scale)) : this.height;
    this.writePerFrame(scene, renderWidth, renderHeight, shadowsActive);
    this.writeLights(scene, lights, shadowsActive ? sun : null);
    this.writeShadowUniforms(scene, sun, shadowsActive ? cascadeCount : 0, shadowSize, shadowDistance);
    for (let i = 0; i < this.batchCount; i++) {
      const b = this.batchPool[i]!;
      b.objectOffset = this.reserveObject(b.count > 1 ? IDENTITY : this.lastMatrixFor(b), b.count);
    }
    this.ensureArenas();
    this.uploadArenas();

    // 5. Frame description + execution.
    this.buildFrame(scene, {
      hdr,
      renderWidth,
      renderHeight,
      cascadeCount: shadowsActive ? cascadeCount : 0,
      shadowSize,
      bloom: hdr && settings.postProcessing && settings.bloom.enabled && this.options.bloom !== false,
    });
    this.finishFrame();
  }

  /** Systems call this through `SystemContext.render`; it queues per-instance data. */
  writeInstanceData(index: number, matrix: Float32Array, color: number, emissive: number): void {
    const offset = this.instanceArena.reserve(INSTANCE_STRIDE, 256);
    const f32 = this.instanceArena.target.f32;
    const u32 = this.instanceArena.target.u32;
    const base = offset >> 2;
    for (let i = 0; i < 16; i++) f32[base + i] = matrix[i] ?? 0;
    u32[base + 16] = color >>> 0;
    f32[base + 17] = emissive;
    u32[base + 18] = 0;
    u32[base + 19] = 0;
    this.instanceCount = Math.max(this.instanceCount, index + 1);
  }

  addShadowCaster(): void {
    /* casters are discovered from Renderable.castShadow during batch collection */
  }

  setSkyOverride(params: Partial<SkyParams>): void {
    this.pendingSky = params;
    this.invalidate();
  }

  get skyOverride(): Partial<SkyParams> | null {
    return this.pendingSky;
  }

  // ------------------------------------------------------------------ frame description

  private buildFrame(scene: Scene, frame: { hdr: boolean; renderWidth: number; renderHeight: number; cascadeCount: number; shadowSize: number; bloom: boolean }): void {
    const swapTexture = this.device.currentTexture;
    if (!swapTexture) throw new UsageError("renderer: no swapchain texture (was the canvas configured?)");
    const g = this.graph;
    g.begin();
    this.postSlots = 0;
    const swapchain = g.importTexture("swapchain", swapTexture);
    const clear = this.clearColorFor(scene, frame.hdr);

    // Shadow cascades: one depth array, one pass per layer.
    let shadowAtlas: RenderGraphHandle | null = null;
    if (frame.cascadeCount > 0) {
      shadowAtlas = g.createTexture("shadow.cascades", {
        width: frame.shadowSize,
        height: frame.shadowSize,
        format: SHADOW_FORMAT,
        usage: TextureUsage.RENDER_ATTACHMENT | TextureUsage.TEXTURE_BINDING,
        depthOrArrayLayers: frame.cascadeCount,
      });
      const atlas = shadowAtlas;
      for (let c = 0; c < frame.cascadeCount; c++) {
        g.addPass({
          name: `forge.shadow.${c}`,
          depth: { texture: atlas, view: { arrayLayer: c }, depthClearValue: 1 },
          execute: (ctx) => this.executeShadowPass(ctx, c),
        });
      }
    }

    // Main colour pass: HDR transient or the swapchain directly.
    const sceneColor = frame.hdr
      ? g.createTexture("scene.hdr", { width: frame.renderWidth, height: frame.renderHeight, format: HDR_FORMAT, usage: TextureUsage.RENDER_ATTACHMENT | TextureUsage.TEXTURE_BINDING })
      : swapchain;
    const sceneDepth = g.createTexture("scene.depth", { width: frame.renderWidth, height: frame.renderHeight, format: this.device.depthFormat, usage: TextureUsage.RENDER_ATTACHMENT });
    const colorFormat = frame.hdr ? HDR_FORMAT : this.device.format;
    g.addPass({
      name: "forge.main",
      reads: shadowAtlas !== null ? [shadowAtlas] : [],
      color: [{ texture: sceneColor, clearValue: [clear[0], clear[1], clear[2], 1] }],
      depth: { texture: sceneDepth, depthStoreOp: "discard" },
      execute: (ctx) => this.executeMainPass(ctx, colorFormat, shadowAtlas),
    });
    this.stats.hdr = frame.hdr;
    if (!frame.hdr) {
      this.applyGraphStats(g.execute());
      return;
    }

    // Bloom: prefilter to half resolution, downsample chain, additive tent upsample back to mip 1.
    const settings = scene.settings;
    const exposure = settings.exposure;
    let bloomMip1: RenderGraphHandle | null = null;
    const mipCount = frame.bloom ? bloomMipCount(frame.renderWidth, frame.renderHeight) : 0;
    if (mipCount > 0) {
      const mips: RenderGraphHandle[] = [];
      const widths: number[] = [];
      const heights: number[] = [];
      for (let i = 1; i <= mipCount; i++) {
        const w = Math.max(1, frame.renderWidth >> i);
        const h = Math.max(1, frame.renderHeight >> i);
        widths.push(w);
        heights.push(h);
        mips.push(g.createTexture(`bloom.${i}`, { width: w, height: h, format: HDR_FORMAT, usage: TextureUsage.RENDER_ATTACHMENT | TextureUsage.TEXTURE_BINDING }));
      }
      const bloom = settings.bloom;
      const base: PostParams = { srcWidth: 0, srcHeight: 0, outWidth: 0, outHeight: 0, threshold: bloom.threshold, knee: bloom.softKnee, intensity: bloom.intensity, exposure, toneMapping: 0, radius: bloom.radius, flags: 0 };
      // Prefilter: scene.hdr → bloom.1
      {
        const slot = this.writePostSlot({ ...base, srcWidth: frame.renderWidth, srcHeight: frame.renderHeight, outWidth: widths[0]!, outHeight: heights[0]!, flags: POST_FLAG_KARIS });
        g.addPass({
          name: "forge.bloom.prefilter",
          reads: [sceneColor],
          color: [{ texture: mips[0]! }],
          execute: (ctx) => this.executePostPass(ctx, "fsPrefilter", slot, sceneColor, sceneColor, false),
        });
      }
      for (let i = 1; i < mipCount; i++) {
        const src = mips[i - 1]!;
        const dst = mips[i]!;
        const slot = this.writePostSlot({ ...base, srcWidth: widths[i - 1]!, srcHeight: heights[i - 1]!, outWidth: widths[i]!, outHeight: heights[i]! });
        g.addPass({
          name: `forge.bloom.down.${i + 1}`,
          reads: [src],
          color: [{ texture: dst }],
          execute: (ctx) => this.executePostPass(ctx, "fsDownsample", slot, src, src, false),
        });
      }
      for (let i = mipCount - 2; i >= 0; i--) {
        const src = mips[i + 1]!;
        const dst = mips[i]!;
        const slot = this.writePostSlot({ ...base, srcWidth: widths[i + 1]!, srcHeight: heights[i + 1]!, outWidth: widths[i]!, outHeight: heights[i]! });
        g.addPass({
          name: `forge.bloom.up.${i + 1}`,
          reads: [src],
          color: [{ texture: dst, loadOp: "load" }],
          execute: (ctx) => this.executePostPass(ctx, "fsUpsample", slot, src, src, true),
        });
      }
      bloomMip1 = mips[0]!;
    }
    this.stats.bloomMips = mipCount;

    // Tonemap resolve: exposure, bloom composite, tone curve, sRGB encode → swapchain.
    {
      const slot = this.writePostSlot({
        srcWidth: frame.renderWidth,
        srcHeight: frame.renderHeight,
        outWidth: this.width,
        outHeight: this.height,
        threshold: 0,
        knee: 0,
        intensity: settings.bloom.intensity,
        exposure,
        toneMapping: TONE_MAP_MODE[settings.toneMapping] ?? 2,
        radius: 1,
        flags: bloomMip1 !== null ? POST_FLAG_BLOOM : 0,
      });
      const second = bloomMip1 ?? sceneColor;
      g.addPass({
        name: "forge.tonemap",
        reads: bloomMip1 !== null ? [sceneColor, bloomMip1] : [sceneColor],
        color: [{ texture: swapchain }],
        execute: (ctx) => this.executePostPass(ctx, "fsTonemap", slot, sceneColor, second, false),
      });
    }
    this.device.device.queue.writeBuffer(this.postBuffer!, 0, gpuSource(this.postBytes.bytes.subarray(0, this.postSlots * UNIFORM_SLOT)));
    this.applyGraphStats(g.execute());
  }

  private applyGraphStats(stats: { passes: number; culledPasses: number; transientTextures: number; physicalTextures: number; aliasedBytes: number; texturesCreated: number }): void {
    this.stats.passes = stats.passes;
    this.stats.culledPasses = stats.culledPasses;
    this.stats.transientTextures = stats.transientTextures;
    this.stats.physicalTextures = stats.physicalTextures;
    this.stats.aliasedBytes = stats.aliasedBytes;
    this.stats.texturesCreated = stats.texturesCreated;
  }

  private finishFrame(): void {
    this.currentFrameContext = null;
    this.invalidated = false;
    this.lastUploadCount++;
  }

  // ------------------------------------------------------------------ pass bodies

  private executeShadowPass(ctx: RenderGraphPassContext, cascade: number): void {
    this.syncGraphEpoch();
    const pass = ctx.beginRenderPass();
    pass.setBindGroup(0, this.cascadeBindGroup!, [cascade * UNIFORM_SLOT]);
    const frustum = this.cascadeFrustums[cascade]!;
    let lastInstanced = -1;
    for (let i = 0; i < this.batchCount; i++) {
      const b = this.batchPool[i]!;
      if (!b.castShadow || b.overlay || b.transparent) continue;
      if (!b.geometry.vertexBuffer) continue;
      if (!frustum.intersectsAABB(b.bounds)) {
        this.stats.shadowsCulled++;
        continue;
      }
      const instanced = b.count > 1 ? 1 : 0;
      if (instanced !== lastInstanced) {
        lastInstanced = instanced;
        pass.setPipeline(this.pipelines.get({ technique: "depth", colorFormat: null, depthFormat: SHADOW_FORMAT, transparent: false, doubleSided: false, instanced: instanced === 1 }).pipeline);
      }
      pass.setBindGroup(1, this.drawBindGroup!, [b.objectOffset, b.instanceOffset]);
      pass.setVertexBuffer(0, b.geometry.vertexBuffer);
      if (b.geometry.indexBuffer) {
        pass.setIndexBuffer(b.geometry.indexBuffer, b.geometry.indexFormat!);
        pass.drawIndexed(b.indexCount, b.count, b.indexStart);
      } else {
        pass.draw(b.indexCount, b.count);
      }
      this.stats.shadowsDrawn++;
    }
    pass.end();
  }

  private executeMainPass(ctx: RenderGraphPassContext, colorFormat: GPUTextureFormat, shadowAtlas: RenderGraphHandle | null): void {
    this.syncGraphEpoch();
    const shadowView = shadowAtlas !== null ? ctx.view(shadowAtlas, { dimension: "2d-array" }) : this.ensureShadowFallback();
    const pass = ctx.beginRenderPass();
    pass.setBindGroup(0, this.ensureFrameBindGroup(shadowView));
    const sorted = this.sortedBatches;
    sorted.length = 0;
    for (let i = 0; i < this.batchCount; i++) {
      const b = this.batchPool[i]!;
      if (!b.shadowOnly) sorted.push(b);
    }
    sorted.sort((a, b) => (a.transparent === b.transparent ? a.depthSort - b.depthSort : a.transparent ? 1 : -1));
    for (const b of sorted) {
      const pipeline = this.pipelines.get({
        technique: b.material.technique === "unlit" ? "unlit" : "standard",
        colorFormat,
        depthFormat: this.device.depthFormat,
        transparent: b.transparent,
        doubleSided: b.material.doubleSided,
        instanced: b.count > 1,
      });
      pass.setPipeline(pipeline.pipeline);
      pass.setBindGroup(1, this.drawBindGroup!, [b.objectOffset, b.instanceOffset]);
      pass.setBindGroup(2, this.ensureMaterialGroup(b.material));
      pass.setVertexBuffer(0, b.geometry.vertexBuffer!);
      if (b.geometry.indexBuffer) {
        pass.setIndexBuffer(b.geometry.indexBuffer, b.geometry.indexFormat!);
        pass.drawIndexed(b.indexCount, b.count, b.indexStart);
      } else {
        pass.draw(b.indexCount, b.count);
      }
      this.stats.drawCalls++;
      this.stats.triangles += (b.indexCount / 3) * Math.max(1, b.count);
      this.stats.instances += b.count;
    }
    if (this.debugLineCount > 0) this.drawDebugLines(pass, colorFormat);
    pass.end();
  }

  private executePostPass(ctx: RenderGraphPassContext, entry: PostEntryPoint, slot: number, source: RenderGraphHandle, second: RenderGraphHandle, additive: boolean): void {
    this.syncGraphEpoch();
    const pipeline = this.pipelines.get({
      technique: "post",
      colorFormat: ctx.colorFormat(0),
      depthFormat: null,
      transparent: false,
      doubleSided: true,
      instanced: false,
      fragmentEntry: entry,
      additive,
    });
    const pass = ctx.beginRenderPass();
    pass.setPipeline(pipeline.pipeline);
    pass.setBindGroup(0, this.ensurePostGroup(ctx.view(source), ctx.view(second)), [slot * UNIFORM_SLOT]);
    pass.draw(3);
    this.stats.drawCalls++;
    pass.end();
  }

  // ------------------------------------------------------------------ internals

  private resetStats(): void {
    const s = this.stats;
    s.drawCalls = 0;
    s.triangles = 0;
    s.instances = 0;
    s.batches = 0;
    s.culled = 0;
    s.shadowsDrawn = 0;
    s.shadowsCulled = 0;
    s.shadowCascades = 0;
    s.debugLines = 0;
    s.hdr = false;
    s.bloomMips = 0;
    s.passes = 0;
    s.culledPasses = 0;
    s.transientTextures = 0;
    s.physicalTextures = 0;
    s.aliasedBytes = 0;
    s.texturesCreated = 0;
    this.instanceCount = 0;
  }

  private clearFrame(scene: Scene): void {
    const texture = this.device.currentTexture;
    if (texture === null) return;
    const device = this.device.device;
    const encoder = device.createCommandEncoder({ label: "forge.clear" });
    const c = this.clearColorFor(scene, false);
    const pass = encoder.beginRenderPass({
      label: "forge.clear",
      colorAttachments: [{ view: texture.createView(), clearValue: { r: c[0], g: c[1], b: c[2], a: 1 }, loadOp: "clear", storeOp: "store" }],
    });
    pass.end();
    device.queue.submit([encoder.finish()]);
  }

  /**
   * Clear colour in the colour target's space: linear for the HDR target (the tonemap pass
   * encodes), sRGB-encoded for the swapchain (its format is not an sRGB format, so the forward
   * shader encodes and the clear must match or the background renders two-tone).
   */
  private clearColorFor(scene: Scene, linear: boolean): [number, number, number] {
    const override = this.options.clearColor;
    if (typeof override === "number") {
      const q = (v: number) => Math.min(1, Math.max(0, v)) / 255;
      return [q((override >> 16) & 0xff), q((override >> 8) & 0xff), q(override & 0xff)];
    }
    const c = scene.settings.backgroundColor;
    if (linear) return [c.r, c.g, c.b];
    const enc = (v: number) => (v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(Math.max(v, 0), 1 / 2.4) - 0.055);
    return [enc(c.r), enc(c.g), enc(c.b)];
  }

  private computeProjection(camera: Camera, aspect: number, out: Mat4): Mat4 {
    if (camera.orthographic) {
      const halfH = camera.orthoHeight / 2;
      const halfW = halfH * aspect;
      out.setOrthographic(-halfW, halfW, -halfH, halfH, camera.near, camera.far);
    } else {
      out.setPerspective(camera.fovY, aspect, camera.near, camera.far);
    }
    return out;
  }

  private refreshLightDirection(scene: Scene, l: Light): void {
    if (!l.followRotation) return;
    // Direction = the entity's world +Z (same axis `Transform.lookAt` aims), read straight from
    // the composed world matrix so parented lights and scaled rigs behave.
    scene.world.getWorldMatrix(l.entity, this.scratchMat);
    this.scratchMat.transformDirection(FORWARD_Z, this.scratchDir);
    l.setDirectionFromForward(this.scratchDir);
  }

  private writePerFrame(scene: Scene, renderWidth: number, renderHeight: number, shadowsActive: boolean): void {
    const a = this.frameAccessor;
    const settings = scene.settings;
    a.setMat4("viewProj", this.viewProj.m);
    this.invViewProj.copyFrom(this.viewProj);
    if (!this.invViewProj.invert()) this.invViewProj.setIdentity(); // singular view (degenerate camera) → harmless fallback
    a.setMat4("invViewProj", this.invViewProj.m);
    a.setVec3("cameraPosRender", this.lastCameraPos.x, this.lastCameraPos.y, this.lastCameraPos.z);
    a.setF32("exposure", settings.exposure);
    const ctx = this.currentFrameContext;
    a.setVec4("time", ctx?.elapsed ?? 0, ctx?.dt ?? 0, ctx?.frame ?? 0, 0);
    const fog = settings.fog;
    a.setVec3("fogColor", fog.color.r, fog.color.g, fog.color.b);
    a.setF32("fogDensity", fog.mode === "none" ? 0 : fog.density);
    a.setVec2("fogRange", fog.start, fog.end);
    a.setVec2("renderExtent", renderWidth, renderHeight);
    a.setF32("shadowDistance", settings.shadow.distance);
    a.setF32("ambientIntensity", settings.ambientIntensity);
    a.setI32("lightCount", Math.min(this.lightList.length, MAX_LIGHTS_PER_FRAME));
    a.setI32("cascadeCount", shadowsActive ? this.cascades.length : 0);
    a.setVec3("ambientColor", settings.ambientColor.r, settings.ambientColor.g, settings.ambientColor.b);
    a.setF32("toneMapping", TONE_MAP_MODE[settings.toneMapping] ?? 2);
    const flags = (settings.skyEnabled ? 1 : 0) | (settings.hdr ? 2 : 0) | 4 | (shadowsActive ? 8 : 0);
    a.setU32("flags", flags);
    this.device.device.queue.writeBuffer(this.frameBuffer!, 0, gpuSource(this.frameBytes.bytes.subarray(0, this.frameBytes.byteLength)));
  }

  private writeLights(scene: Scene, lights: Light[], caster: Light | null): void {
    const a = this.lightAccessor;
    const count = Math.min(lights.length, MAX_LIGHTS_PER_FRAME);
    a.setI32("count", count);
    a.setI32("shadowedCount", caster ? 1 : 0);
    for (let i = 0; i < count; i++) {
      const l = lights[i]!;
      const e = a.element("lights", i) as StructAccessor;
      const pos = scene.world.worldPosition(l.entity, this.scratchVec);
      e.setVec4("positionRange", pos.x, pos.y, pos.z, l.kind === "directional" ? 0 : l.range);
      e.setVec4("directionIntensity", l.direction.x, l.direction.y, l.direction.z, l.intensity);
      e.setVec3("color", l.color.x, l.color.y, l.color.z);
      e.setVec2("spotAngles", l.innerCone, l.outerCone);
      e.setI32("kind", l.kind === "directional" ? 0 : l.kind === "point" ? 1 : 2);
      e.setI32("shadowIndex", l === caster ? 0 : -1);
    }
    this.device.device.queue.writeBuffer(this.lightBuffer!, 0, gpuSource(this.lightBytes.bytes.subarray(0, this.lightBytes.byteLength)));
  }

  private writeShadowUniforms(scene: Scene, sun: Light | null, cascadeCount: number, size: number, shadowDistance: number): void {
    const a = this.shadowAccessor;
    const splits = [1e9, 1e9, 1e9, 1e9];
    const texels = [0, 0, 0, 0];
    const stride = a.arrayStride("cascadeViewProj");
    const base = a.offsetOf("cascadeViewProj");
    for (let c = 0; c < MAX_CASCADES; c++) {
      const cascade = c < cascadeCount ? this.cascades[c]! : null;
      const m = cascade ? cascade.viewProj.m : IDENTITY;
      this.shadowBytes.f32.set(m, (base + c * stride) >> 2);
      if (cascade) {
        splits[c] = cascade.far;
        texels[c] = cascade.texelWorld;
      }
      // Per-cascade light view-projection for the depth passes (dynamic-offset arena).
      this.cascadeAccessor.relocate(c * UNIFORM_SLOT);
      this.cascadeAccessor.setMat4("viewProj", m);
      this.cascadeAccessor.setI32("cascade", c);
    }
    a.setVec4("cascadeSplits", splits[0]!, splits[1]!, splits[2]!, splits[3]!);
    a.setVec4("cascadeTexelWorld", texels[0]!, texels[1]!, texels[2]!, texels[3]!);
    a.setF32("texelSize", 1 / size);
    a.setF32("depthBias", sun ? sun.shadowBias : 0.0008);
    a.setF32("normalBias", sun ? sun.shadowNormalBias : 0.6);
    a.setF32("fadeStart", shadowDistance * 0.85);
    a.setI32("enabled", cascadeCount > 0 ? 1 : 0);
    a.setI32("size", size);
    a.setI32("count", cascadeCount);
    a.setU32("flags", scene.settings.shadow.debugCascades ? 1 : 0);
    const q = this.device.device.queue;
    q.writeBuffer(this.shadowBuffer!, 0, gpuSource(this.shadowBytes.bytes.subarray(0, this.shadowBytes.byteLength)));
    if (cascadeCount > 0) q.writeBuffer(this.cascadeBuffer!, 0, gpuSource(this.cascadeBytes.bytes.subarray(0, cascadeCount * UNIFORM_SLOT)));
  }

  private writePostSlot(p: PostParams): number {
    const slot = this.postSlots++;
    if (slot >= MAX_POST_PASSES) throw new InternalError(`renderer: more than ${MAX_POST_PASSES} post passes in one frame`);
    const a = this.postAccessor;
    a.relocate(slot * UNIFORM_SLOT);
    a.setVec2("texelSize", 1 / p.srcWidth, 1 / p.srcHeight);
    a.setVec2("outputSize", p.outWidth, p.outHeight);
    a.setF32("threshold", p.threshold);
    a.setF32("knee", p.knee);
    a.setF32("intensity", p.intensity);
    a.setF32("exposure", p.exposure);
    a.setF32("toneMapping", p.toneMapping);
    a.setF32("radius", p.radius);
    a.setU32("flags", p.flags);
    a.setU32("_pad", 0);
    return slot;
  }

  private collectBatches(scene: Scene, camera: Camera, cascadeCount: number): void {
    this.batchCount = 0;
    this.casterBatches = 0;
    this.batchIndex.clear();
    this.objectArena.reset();
    this.instanceArena.reset();
    const store = scene.world.store(Renderable);
    const camPos = camera.positionRender;
    const maxInstances = Math.max(1, this.options.maxInstancesPerBatch ?? 1024);
    for (let i = 0; i < store.count; i++) {
      const r = store.valueAt(i) as Renderable;
      if (!r.visible || !r.geometry || !r.material) continue;
      const transformSlot = scene.world.transformSlot(r.entity, true);
      const matrix = scene.world.transforms.worldView(transformSlot);
      // Frustum cull against the world-space AABB (local bounds transformed once, allocation-free).
      r.resolveBounds(this.scratchBox);
      this.scratchMat.m.set(matrix);
      this.scratchBox.transformByMatrix(this.scratchMat, this.scratchWorldBox);
      const box = this.scratchWorldBox;
      const inView = this.frustum.intersectsAABB(box) && (r.layer & camera.cullingMask) !== 0;
      r.isVisible = inView;
      const caster = cascadeCount > 0 && r.castShadow && !r.transparent && !r.overlay;
      let shadowOnly = false;
      if (!inView) {
        this.stats.culled++;
        // Off-screen casters still matter when a cascade box contains them.
        if (!caster || !this.intersectsAnyCascade(box, cascadeCount)) continue;
        shadowOnly = true;
      }
      const key = `${geometryIdentity(r.geometry)}|${r.material.pipelineKey}|${r.transparent ? "t" : "o"}|${r.overlay ? "ov" : "-"}|${caster ? "cs" : "-"}|${shadowOnly ? "so" : "-"}`;
      const instanceOffset = this.instanceArena.reserve(INSTANCE_STRIDE, 256);
      const base = instanceOffset >> 2;
      const f32 = this.instanceArena.target.f32;
      const u32 = this.instanceArena.target.u32;
      for (let k = 0; k < 16; k++) f32[base + k] = matrix[k] ?? 0;
      u32[base + 16] = r.tint || packColorRGBA(1, 1, 1, 1);
      f32[base + 17] = r.emissive;
      u32[base + 18] = 0;
      u32[base + 19] = 0;
      let index = this.batchIndex.get(key);
      const existing = index === undefined ? null : this.batchPool[index]!;
      // Instances must be contiguous to share one draw: the arena cursor is exactly one record
      // past the previous instance of this batch, which is why batches are emitted in one pass.
      if (existing && existing.instanceOffset + existing.count * INSTANCE_STRIDE === instanceOffset && existing.count < maxInstances) {
        existing.count++;
        existing.bounds.union(box);
        continue;
      }
      index = this.batchCount;
      this.batchIndex.set(key, index);
      const b = this.acquireBatch();
      b.geometry = r.geometry;
      b.material = r.material;
      b.instanceOffset = instanceOffset;
      b.count = 1;
      b.transparent = r.transparent;
      b.overlay = r.overlay;
      b.castShadow = caster;
      b.shadowOnly = shadowOnly;
      b.indexCount = r.geometry.indexCount > 0 ? r.geometry.indexCount : r.geometry.vertexCount;
      b.indexStart = 0;
      b.depthSort = -Vec3.distanceSqBetween(camPos, box.getCenter(this.scratchVec));
      b.objectOffset = 0;
      b.bounds.setFrom(box.min, box.max);
      if (caster) this.casterBatches++;
    }
  }

  private intersectsAnyCascade(box: AABB, cascadeCount: number): boolean {
    for (let c = 0; c < cascadeCount; c++) if (this.cascadeFrustums[c]!.intersectsAABB(box)) return true;
    return false;
  }

  private acquireBatch(): Batch {
    let b = this.batchPool[this.batchCount];
    if (!b) {
      b = {
        geometry: null as unknown as Geometry,
        material: null as unknown as Material,
        instanceOffset: 0,
        count: 0,
        transparent: false,
        overlay: false,
        castShadow: false,
        shadowOnly: false,
        indexCount: 0,
        indexStart: 0,
        depthSort: 0,
        objectOffset: 0,
        bounds: new AABB(),
      };
      this.batchPool.push(b);
    }
    this.batchCount++;
    return b;
  }

  private reserveObject(matrix: Float32Array, instanceCount: number): number {
    const offset = this.objectArena.reserve(ObjectUniforms.byteSize("uniform"), 256);
    const a = this.objectAccessor;
    a.relocate(offset);
    a.setMat4("model", matrix);
    a.setU32("instanceCount", instanceCount);
    return offset;
  }

  private readonly objectAccessor = new StructAccessor(ObjectUniforms, this.objectArena.target, 0, "uniform");

  /** Non-instanced draws read `objectData.model`; the batch's single matrix is stored there. */
  private lastMatrixFor(b: Batch): Float32Array {
    const base = b.instanceOffset >> 2;
    const f = this.instanceArena.target.f32;
    this.scratchMatrix.set(f.subarray(base, base + 16));
    return this.scratchMatrix;
  }

  private uploadArenas(): void {
    const objectBytes = this.objectArena.written();
    const instanceBytes = this.instanceArena.written();
    if (objectBytes.length > 0) this.device.device.queue.writeBuffer(this.objectBuffer!, 0, gpuSource(objectBytes));
    if (instanceBytes.length > 0) this.device.device.queue.writeBuffer(this.instanceBuffer!, 0, gpuSource(instanceBytes));
  }

  private ensureBuffers(): void {
    const d = this.device.device;
    this.frameBuffer ??= d.createBuffer({ label: "perframe.uniforms", size: this.frameBytes.byteLength, usage: BufferUsage.UNIFORM | BufferUsage.COPY_DST });
    this.lightBuffer ??= d.createBuffer({ label: "lights.uniforms", size: this.lightBytes.byteLength, usage: BufferUsage.UNIFORM | BufferUsage.COPY_DST });
    this.shadowBuffer ??= d.createBuffer({ label: "shadow.uniforms", size: this.shadowBytes.byteLength, usage: BufferUsage.UNIFORM | BufferUsage.COPY_DST });
    this.cascadeBuffer ??= d.createBuffer({ label: "shadowpass.uniforms", size: this.cascadeBytes.byteLength, usage: BufferUsage.UNIFORM | BufferUsage.COPY_DST });
    this.postBuffer ??= d.createBuffer({ label: "post.uniforms", size: this.postBytes.byteLength, usage: BufferUsage.UNIFORM | BufferUsage.COPY_DST });
    const { depthFrame } = this.pipelines.bindGroupLayouts;
    this.cascadeBindGroup ??= d.createBindGroup({
      label: "shadowpass.bindgroup",
      layout: depthFrame,
      entries: [{ binding: 0, resource: { buffer: this.cascadeBuffer, size: ShadowPassUniforms.byteSize("uniform") } }],
    });
    this.ensureArenas();
  }

  /** The frame bind group depends on which shadow atlas view is bound; rebuilt when that changes. */
  private ensureFrameBindGroup(shadowView: GPUTextureView): GPUBindGroup {
    if (this.frameBindGroup && this.frameBindGroupView === shadowView) return this.frameBindGroup;
    const { frame } = this.pipelines.bindGroupLayouts;
    this.frameBindGroup = this.device.device.createBindGroup({
      label: "perframe.bindgroup",
      layout: frame,
      entries: [
        { binding: 0, resource: { buffer: this.frameBuffer! } },
        { binding: 1, resource: { buffer: this.lightBuffer! } },
        { binding: 2, resource: { buffer: this.shadowBuffer! } },
        { binding: 3, resource: shadowView },
        { binding: 4, resource: this.device.sampler("shadow-pcf") },
      ],
    });
    this.frameBindGroupView = shadowView;
    return this.frameBindGroup;
  }

  /** Bound when shadows are off: the shader never samples it, but the layout still needs a depth array. */
  private ensureShadowFallback(): GPUTextureView {
    if (this.shadowFallbackView) return this.shadowFallbackView;
    this.shadowFallback = this.device.createTexture({
      label: "shadow.fallback",
      size: { width: 1, height: 1, depthOrArrayLayers: 1 },
      format: SHADOW_FORMAT,
      usage: TextureUsage.TEXTURE_BINDING,
    });
    this.shadowFallbackView = this.shadowFallback.createView({ label: "shadow.fallback.view", dimension: "2d-array" });
    return this.shadowFallbackView;
  }

  /** Drop bind groups that reference graph textures whenever the graph's pool changed. */
  private syncGraphEpoch(): void {
    if (this.graphEpoch === this.graph.allocationEpoch) return;
    this.graphEpoch = this.graph.allocationEpoch;
    this.postGroups.clear();
    this.frameBindGroup = null;
    this.frameBindGroupView = null;
  }

  private viewId(view: GPUTextureView): number {
    let id = this.viewIds.get(view);
    if (id === undefined) {
      id = ++this.viewSerial;
      this.viewIds.set(view, id);
    }
    return id;
  }

  private ensurePostGroup(source: GPUTextureView, second: GPUTextureView): GPUBindGroup {
    const key = `${this.viewId(source)}|${this.viewId(second)}`;
    let group = this.postGroups.get(key);
    if (group) return group;
    group = this.device.device.createBindGroup({
      label: `post.bindgroup.${key}`,
      layout: this.pipelines.bindGroupLayouts.post,
      entries: [
        { binding: POST_BINDINGS.uniforms.binding, resource: { buffer: this.postBuffer!, size: PostUniforms.byteSize("uniform") } },
        { binding: POST_BINDINGS.source.binding, resource: source },
        { binding: POST_BINDINGS.second.binding, resource: second },
        { binding: POST_BINDINGS.sampler.binding, resource: this.device.sampler("linear-clamp") },
      ],
    });
    this.postGroups.set(key, group);
    return group;
  }

  private ensureArenas(): void {
    const needObject = alignUp(Math.max(this.objectArena.target.byteLength, 64 * 1024), 256);
    const needInstance = alignUp(Math.max(this.instanceArena.target.byteLength, 64 * 1024), 256);
    let rebuilt = false;
    if (needObject > this.objectBufferCapacity) {
      this.objectBuffer?.destroy();
      this.objectBuffer = this.device.device.createBuffer({ label: "draw.uniforms", size: needObject, usage: BufferUsage.UNIFORM | BufferUsage.COPY_DST });
      this.objectBufferCapacity = needObject;
      rebuilt = true;
    }
    if (needInstance > this.instanceBufferCapacity) {
      this.instanceBuffer?.destroy();
      this.instanceBuffer = this.device.device.createBuffer({ label: "instances.storage", size: needInstance, usage: BufferUsage.STORAGE | BufferUsage.COPY_DST });
      this.instanceBufferCapacity = needInstance;
      rebuilt = true;
    }
    if (rebuilt || !this.drawBindGroup) {
      const { draw } = this.pipelines.bindGroupLayouts;
      this.drawBindGroup = this.device.device.createBindGroup({
        label: "draw.bindgroup",
        layout: draw,
        entries: [
          { binding: 0, resource: { buffer: this.objectBuffer!, size: ObjectUniforms.byteSize("uniform") } },
          { binding: 1, resource: { buffer: this.instanceBuffer!, size: InstanceStruct.byteSize("storage") } },
        ],
      });
    }
  }

  private materialGroupCache = new WeakMap<Material, { revision: number; group: GPUBindGroup }>();

  private ensureMaterialGroup(material: Material): GPUBindGroup {
    const { material: layout } = this.pipelines.bindGroupLayouts;
    const cached = this.materialGroupCache.get(material);
    if (cached && cached.revision === material.revision) return cached.group;
    material.ensureGpu(this.device, layout, {
      white: this.defaults.white,
      normal: this.defaults.normal,
      mr: this.defaults.mr,
      // Repeat (not clamp): materials address their maps as `uv * tiling + offset`, and terrain
      // (and any tiled surface) relies on integer tilings wrapping seamlessly at uv = 1. A clamp
      // sampler would smear the texture's last texel across every tile past the first.
      sampler: this.device.sampler("linear-repeat"),
    });
    const upload = material.takePendingUpload();
    if (upload) this.device.device.queue.writeBuffer(upload.buffer, 0, gpuSource(upload.bytes));
    const group = material.bindGroup!;
    this.materialGroupCache.set(material, { revision: material.revision, group });
    return group;
  }

  private drawDebugLines(pass: GPURenderPassEncoder, colorFormat: GPUTextureFormat): void {
    const bytesPerVertex = 16;
    const size = alignUp(this.debugLineCount * 2 * bytesPerVertex, 4);
    if (size > this.debugBufferCapacity || !this.debugBuffer) {
      this.debugBuffer?.destroy();
      this.debugBufferCapacity = Math.max(size, 4096);
      this.debugBuffer = this.device.device.createBuffer({ label: "debug.lines", size: this.debugBufferCapacity, usage: BufferUsage.VERTEX | BufferUsage.COPY_DST });
    }
    this.device.device.queue.writeBuffer(this.debugBuffer, 0, gpuSource(this.debugLines.subarray(0, (size / 4) | 0)));
    const pipeline = this.pipelines.get({ technique: "debug", colorFormat, depthFormat: this.device.depthFormat, transparent: true, doubleSided: true, instanced: false });
    pass.setPipeline(pipeline.pipeline);
    pass.setVertexBuffer(0, this.debugBuffer);
    pass.draw(this.debugLineCount * 2);
    this.stats.debugLines = this.debugLineCount;
    this.debugLineCount = 0;
  }

  // ------------------------------------------------------------------ debug API

  drawLine(a: Vec3, b: Vec3, color = 0xff00ff00): void {
    const need = (this.debugLineCount + 1) * 4;
    if (need > this.debugLines.length) {
      const next = new Float32Array(Math.max(need * 2, this.debugLines.length * 2));
      next.set(this.debugLines);
      this.debugLines = next;
    }
    const f = this.debugLines;
    const u = new Uint32Array(f.buffer, f.byteOffset, f.length);
    const o = this.debugLineCount * 4;
    f[o] = a.x;
    f[o + 1] = a.y;
    f[o + 2] = a.z;
    u[o + 3] = color >>> 0;
    f[o + 4] = b.x;
    f[o + 5] = b.y;
    f[o + 6] = b.z;
    u[o + 7] = color >>> 0;
    this.debugLineCount++;
  }

  drawAabb(box: AABB, color = 0xffffff00): void {
    const min = box.min;
    const max = box.max;
    const c = [
      new Vec3(min.x, min.y, min.z),
      new Vec3(max.x, min.y, min.z),
      new Vec3(max.x, min.y, max.z),
      new Vec3(min.x, min.y, max.z),
      new Vec3(min.x, max.y, min.z),
      new Vec3(max.x, max.y, min.z),
      new Vec3(max.x, max.y, max.z),
      new Vec3(min.x, max.y, max.z),
    ];
    const edges = [
      [0, 1],
      [1, 2],
      [2, 3],
      [3, 0],
      [4, 5],
      [5, 6],
      [6, 7],
      [7, 4],
      [0, 4],
      [1, 5],
      [2, 6],
      [3, 7],
    ];
    for (const [a, b] of edges) this.drawLine(c[a]!, c[b]!, color);
  }

  /** Wireframe circle triple (cheap, good enough for gizmos and trigger volumes). */
  drawSphere(center: Vec3, radius: number, color = 0x00ffff80): void {
    const segments = 16;
    const prev = new Vec3();
    for (let axis = 0; axis < 3; axis++) {
      let first = true;
      for (let i = 0; i <= segments; i++) {
        const t = (i / segments) * Math.PI * 2;
        const a = Math.cos(t) * radius;
        const b = Math.sin(t) * radius;
        const p = new Vec3(center.x, center.y, center.z);
        if (axis === 0) {
          p.y += a;
          p.z += b;
        } else if (axis === 1) {
          p.x += a;
          p.z += b;
        } else {
          p.x += a;
          p.y += b;
        }
        if (!first) this.drawLine(prev, p, color);
        prev.copyFrom(p);
        first = false;
      }
    }
  }

  drawGizmo(position: Vec3, size = 1): void {
    this.drawLine(position, new Vec3(position.x + size, position.y, position.z), 0xff0000ff);
    this.drawLine(position, new Vec3(position.x, position.y + size, position.z), 0xff00ff00);
    this.drawLine(position, new Vec3(position.x, position.y, position.z + size), 0xffff0000);
  }

  drawVector(origin: Vec3, dir: Vec3, scale = 1, color = 0xffffffff): void {
    const tip = new Vec3(origin.x + dir.x * scale, origin.y + dir.y * scale, origin.z + dir.z * scale);
    this.drawLine(origin, tip, color);
    const head = 0.1 * scale;
    const n = new Vec3(dir.x, dir.y, dir.z).normalize();
    const back = new Vec3(tip.x - n.x * head, tip.y - n.y * head, tip.z - n.z * head);
    const side = new Vec3(-n.y, n.x, 0).normalize().scale(head * 0.4);
    this.drawLine(back, new Vec3(back.x + side.x, back.y + side.y, back.z + side.z), color);
    this.drawLine(back, new Vec3(back.x - side.x, back.y - side.y, back.z - side.z), color);
  }

  drawLabel(position: Vec3, text: string): void {
    this.labelsSeen.add(`${position.x.toFixed(2)},${position.y.toFixed(2)},${position.z.toFixed(2)}:${text}`);
  }

  get debugLabels(): readonly string[] {
    return [...this.labelsSeen];
  }

  pickAt(_x: number, _y: number): PickResult | null {
    return null;
  }

  get cameraPositionRender(): Vec3 {
    return this.lastCameraPos;
  }

  get cameraPositionWorld(): Double3 {
    return this.lastCameraWorld;
  }

  /** Last frame's cascade fits (read-only; for debug overlays and tests). */
  get shadowCascades(): readonly Cascade[] {
    return this.cascades;
  }

  dispose(): void {
    this.deviceLostUnsub?.dispose();
    this.deviceLostUnsub = null;
    for (const b of [this.frameBuffer, this.lightBuffer, this.shadowBuffer, this.cascadeBuffer, this.postBuffer, this.objectBuffer, this.instanceBuffer, this.debugBuffer]) b?.destroy();
    this.frameBuffer = null;
    this.lightBuffer = null;
    this.shadowBuffer = null;
    this.cascadeBuffer = null;
    this.postBuffer = null;
    this.objectBuffer = null;
    this.instanceBuffer = null;
    this.debugBuffer = null;
    this.objectBufferCapacity = 0;
    this.instanceBufferCapacity = 0;
    this.shadowFallback?.destroy();
    this.shadowFallback = null;
    this.shadowFallbackView = null;
    this.frameBindGroup = null;
    this.frameBindGroupView = null;
    this.cascadeBindGroup = null;
    this.drawBindGroup = null;
    this.postGroups.clear();
    this.graph.dispose();
    this.pipelines.invalidate();
    this.defaults.dispose();
  }
}

/** Shadow map sizes are powers of two between 256 and 4096 (texel snapping assumes it). */
function clampShadowSize(requested: number): number {
  const v = Math.max(256, Math.min(4096, Number.isFinite(requested) ? requested : 1024));
  return Math.pow(2, Math.round(Math.log2(v)));
}

/** Half-res down to ~16px on the short side, capped at MAX_BLOOM_MIPS chain levels. */
function bloomMipCount(width: number, height: number): number {
  const shortSide = Math.min(width, height);
  let n = 0;
  while (n < MAX_BLOOM_MIPS && shortSide >> (n + 1) >= 16) n++;
  return n;
}

let geometrySerial = 0;
const geometrySerials = new WeakMap<object, number>();

function geometryIdentity(g: Geometry): number {
  let id = geometrySerials.get(g);
  if (id === undefined) {
    id = ++geometrySerial;
    geometrySerials.set(g, id);
  }
  return id;
}
