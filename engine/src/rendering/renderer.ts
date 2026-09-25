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
 *      view-projections, sky block (when the sky is on), post parameters and the two draw arenas.
 *   5. frame description: the passes are declared on the `RenderGraph` — `forge.shadow.<n>` per
 *      cascade into a depth array, `forge.prepass` laying the opaque depth down, the half-resolution
 *      `forge.ssao` estimate + its two blur passes, `forge.main` into the HDR target (or the
 *      swapchain in LDR mode), `forge.sky` over the same target where the depth buffer is still
 *      clear, the bloom chain, and `forge.tonemap` into the swapchain. The graph validates, culls,
 *      aliases, records everything into one command buffer and submits it.
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
import { PipelineFactory, type PostEntryPoint, type SsaoEntryPoint } from "./pipeline.js";
import { PerFrameUniforms, LightBlock, ShadowUniforms, ShadowPassUniforms, ObjectUniforms, InstanceStruct, PostUniforms, SkyUniforms, CloudUniforms, WaterUniforms, SsaoUniforms, ClusterUniforms, ClusterLightBlock, ClusterGridBlock, MAX_LIGHTS_PER_FRAME, MAX_CASCADES } from "./uniforms.js";
import { ClusterGrid, CLUSTER_TILES_X, CLUSTER_TILES_Y, CLUSTER_SLICES, MAX_CLUSTERED_LIGHTS, type ClusterBuildResult, type ClusterLightSource } from "./clusters.js";
import { POST_BINDINGS, POST_FLAG_BLOOM, POST_FLAG_KARIS } from "./shaders/post.js";
import { SSAO_BINDINGS } from "./shaders/ssao.js";
import { RenderGraph, type RenderGraphHandle, type RenderGraphPassContext } from "./renderGraph.js";
import { computeCascades, type Cascade } from "./shadows.js";
import { EARTH_ATMOSPHERE, SKY_QUALITY_SAMPLES, type AtmosphereParams } from "../environment/atmosphere.js";
import { FOG_MODE_ID } from "../environment/fog.js";
import { SkyLightingCache } from "../environment/clouds.js";
import { isUnderwater } from "../environment/water.js";
import { findGpuParticleWorld } from "../particles/gpuWorld.js";
import { TextureDefaults } from "../resources/texture.js";
import { Geometry } from "./geometry.js";
import { Material } from "./material.js";
import { Camera, Light, Renderable } from "../scene/components/index.js";
import type { GraphicsDevice } from "../gpu/device.js";
import type { Scene, SceneSkySettings, SceneSsaoSettings, SkyQuality } from "../scene/scene.js";
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
  /** `false` skips the `forge.sky` pass even when `scene.settings.skyEnabled` is set. */
  sky?: boolean;
  /** Cap on the sky's ray-march tier; the scene's `sky.quality` asks, this caps. */
  skyQuality?: SkyQuality;
  /** `false` never runs `forge.prepass` (and therefore never SSAO), whatever the scene asks. */
  depthPrepass?: boolean;
  /** `false` never runs the SSAO passes, whatever `scene.settings.ssao.enabled` says. */
  ssao?: boolean;
  /**
   * `false` keeps the fixed uniform light list whatever `scene.settings.clusteredLighting` says:
   * every fragment walks the same ≤16 lights, and lights past that cap are dropped.
   */
  clusteredLighting?: boolean;
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
  /** Wireframe AABBs drawn by `debugBounds` last frame (one per visible Renderable). */
  debugBounds: number;
  hdr: boolean;
  bloomMips: number;
  /** True when the `forge.sky` pass ran this frame. */
  sky: boolean;
  /** View samples the sky pass marched with (after the quality cap); 0 when the pass did not run. */
  skySamples: number;
  /** True when the cloud deck shaded pixels this frame (sky ran, deck enabled, coverage > 0). */
  clouds: boolean;
  /** True when the camera is below the water's mean level (sky skipped, murk fog). */
  underwater: boolean;
  /** True when `forge.prepass` laid the opaque depth down before `forge.main` this frame. */
  depthPrepass: boolean;
  /** Draw calls issued by the depth prepass (not counted in `drawCalls`, like `shadowsDrawn`). */
  prepassDraws: number;
  /** True when the SSAO estimate + blur passes ran and the forward pass applied their result. */
  ssao: boolean;
  /**
   * True when local (point/spot) lights came from the cluster grid rather than the uniform light
   * list. Directional lights are global and stay in the uniform list either way.
   */
  clusteredLighting: boolean;
  /** Lights in the frame: global (uniform list) plus local (cluster grid, when clustering ran). */
  lights: number;
  /** Local lights written to the cluster grid; 0 when clustering did not run. */
  clusteredLights: number;
  /** Clusters holding at least one light, of `CLUSTER_COUNT`. */
  clustersUsed: number;
  /** Entries in the flat light-index list: the frame's total per-cluster light slots. */
  clusterIndices: number;
  /** The longest cluster list — what one fragment walks at worst. */
  maxLightsPerCluster: number;
  /** True when a light was dropped: a cluster over its cap, or more than `MAX_CLUSTERED_LIGHTS` locals. */
  lightsDropped: boolean;
  /** Render-graph outcome for the frame. */
  passes: number;
  culledPasses: number;
  transientTextures: number;
  physicalTextures: number;
  /** Bytes this frame's transient textures occupy after live-range aliasing. */
  transientBytes: number;
  /** Bytes resident in the graph's texture pool (idle textures included). */
  pooledBytes: number;
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
  /** Drawn by `forge.prepass`; `forge.main` then tests against that depth without writing it. */
  prepass: boolean;
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
/**
 * Bytes between instance records — the WGSL `InstanceData` array stride, *not* the arena spacing.
 * A batch's window is relocated with a dynamic offset (256-aligned by WebGPU), so only the first
 * record of a batch carries that alignment; the shader walks the rest at this stride.
 */
const INSTANCE_STRIDE = InstanceStruct.byteSize("storage");
/** Dynamic-offset stride for uniform records (`minUniformBufferOffsetAlignment` baseline). */
const UNIFORM_SLOT = 256;
const MAX_POST_PASSES = 24;
const MAX_BLOOM_MIPS = 6;
const HDR_FORMAT: GPUTextureFormat = "rgba16float";
const SHADOW_FORMAT: GPUTextureFormat = "depth24plus";
/** SSAO targets: visibility + the view depth the bilateral passes key on (f16 holds `SSAO_SKY_KEY`). */
const SSAO_FORMAT: GPUTextureFormat = "rg16float";
/** Bilateral blur: a tap whose view depth differs by more than 1/SSAO_SHARPNESS (relative) is dropped. */
const SSAO_SHARPNESS = 10;
/** f16 bit patterns for the 1×1 fallback AO texel: visibility 1.0, key ≈ `SSAO_SKY_KEY` (65 000 → 64 992). */
const HALF_ONE = 0x3c00;
const HALF_SKY_KEY = 0x7bef;
/**
 * Byte geometry of the two clustered-lighting storage buffers, taken from the generated layout so a
 * struct change cannot silently desynchronise the uploads (docs/RENDERING.md §4b).
 */
const CLUSTER_LIGHTS_FIELD = ClusterLightBlock.field("lights", "storage");
const CLUSTER_OFFSETS_FIELD = ClusterGridBlock.field("clusterOffsets", "storage");
const CLUSTER_INDICES_FIELD = ClusterGridBlock.field("indices", "storage");

/** Sun direction when neither the sky settings nor a directional light provide one. */
const DEFAULT_SUN = new Vec3(0.3, 0.8, 0.5).normalize();
/** `debugBounds` box colours (RGBA byte pack, 0xAARRGGBB): cyan in view, magenta frustum-culled. */
const DEBUG_BOUNDS_IN_VIEW = 0xff00ffff;
const DEBUG_BOUNDS_CULLED = 0xffff00ff;
const DEBUG_BOX_EDGES: ReadonlyArray<readonly [number, number]> = [
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
    debugBounds: 0,
    hdr: false,
    bloomMips: 0,
    sky: false,
    skySamples: 0,
    clouds: false,
    underwater: false,
    depthPrepass: false,
    prepassDraws: 0,
    ssao: false,
    clusteredLighting: false,
    lights: 0,
    clusteredLights: 0,
    clustersUsed: 0,
    clusterIndices: 0,
    maxLightsPerCluster: 0,
    lightsDropped: false,
    passes: 0,
    culledPasses: 0,
    transientTextures: 0,
    physicalTextures: 0,
    transientBytes: 0,
    pooledBytes: 0,
    aliasedBytes: 0,
    texturesCreated: 0,
  };
  instanceCount = 0;

  /**
   * Debug aid: draw the world-space AABB of every visible Renderable as a wireframe box, including
   * renderables the frustum culled this frame (magenta = culled, cyan = in view). Unlike meshes,
   * the boxes are drawn without a depth test, so they stay visible through terrain and haze —
   * the point is to show *where* geometry is supposed to be when nothing renders there.
   */
  debugBounds = false;

  /** Max instances one batch may share (`collectBatches` splits beyond it). */
  private get maxInstancesPerBatch(): number {
    return Math.max(1, this.options.maxInstancesPerBatch ?? 1024);
  }

  /** Bytes one instance window covers: the dynamic-offset binding size and the arena slack. */
  private get instanceWindowBytes(): number {
    return this.maxInstancesPerBatch * INSTANCE_STRIDE;
  }

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
  private readonly skyBytes = new WriteBuffer(SkyUniforms.byteSize("uniform"));
  private readonly skyAccessor = new StructAccessor(SkyUniforms, this.skyBytes, 0, "uniform");
  private readonly cloudBytes = new WriteBuffer(CloudUniforms.byteSize("uniform"));
  private readonly cloudAccessor = new StructAccessor(CloudUniforms, this.cloudBytes, 0, "uniform");
  private readonly waterBytes = new WriteBuffer(WaterUniforms.byteSize("uniform"));
  private readonly waterAccessor = new StructAccessor(WaterUniforms, this.waterBytes, 0, "uniform");
  private readonly ssaoBytes = new WriteBuffer(SsaoUniforms.byteSize("uniform"));
  private readonly ssaoAccessor = new StructAccessor(SsaoUniforms, this.ssaoBytes, 0, "uniform");
  // Clustered (Forward+) lighting. The grid is built on the CPU (`rendering/clusters.ts`) into typed
  // arrays that are uploaded verbatim, and the local lights are written into a storage block whose
  // records are the uniform `LightUniforms`' own — one layout, two bindings. Everything here is
  // staging: a frame allocates nothing, and the light records only grow when a scene adds lights.
  private readonly clusterBytes = new WriteBuffer(ClusterUniforms.byteSize("uniform"));
  private readonly clusterAccessor = new StructAccessor(ClusterUniforms, this.clusterBytes, 0, "uniform");
  private readonly clusterLightBytes = new WriteBuffer(ClusterLightBlock.byteSize("storage"));
  private readonly clusterLightAccessor = new StructAccessor(ClusterLightBlock, this.clusterLightBytes, 0, "storage");
  private readonly clusterGrid = new ClusterGrid();
  /** The local lights the grid is built from, filled in place every frame. */
  private readonly clusterLightSources: ClusterLightSource[] = [];
  /** What the last build did (drives the `cluster*` stats and the HUD's light line). */
  private clusterBuild: ClusterBuildResult | null = null;
  /** Shared sun/ambient/horizon tints for the cloud deck and the water surface. */
  private readonly skyLight = new SkyLightingCache();
  /** The frame's effective sky settings: `scene.settings.sky` with the per-frame override merged. */
  private readonly skyFrame: SceneSkySettings = {
    sunDirection: null,
    sunIntensity: 20,
    exposure: 1,
    turbidity: 2,
    rayleigh: 1,
    mie: 1,
    sunAngularRadius: 0.00465,
    sunDiscIntensity: 100,
    starBrightness: 1,
    nightEnabled: true,
    seaLevel: 0,
    quality: "medium",
    atmosphere: null,
  };
  private readonly skySunDirection = new Vec3();

  // GPU buffers and bind groups.
  private frameBuffer: GPUBuffer | null = null;
  private lightBuffer: GPUBuffer | null = null;
  // Clustered lighting: the quantisation block plus the two storage buffers the grid and its lights
  // live in. Fixed capacity (rendering/clusters.ts), created with the other frame buffers and bound
  // in every frame group whether or not clustering ran — a bind group layout has no optional slots.
  private clusterBuffer: GPUBuffer | null = null;
  private clusterLightBuffer: GPUBuffer | null = null;
  private clusterGridBuffer: GPUBuffer | null = null;
  /** Local lights staged for this frame's grid build (written by `writeLights`). */
  private clusterLightCount = 0;
  private shadowBuffer: GPUBuffer | null = null;
  private cascadeBuffer: GPUBuffer | null = null;
  private postBuffer: GPUBuffer | null = null;
  private skyBuffer: GPUBuffer | null = null;
  private skyBindGroup: GPUBindGroup | null = null;
  private cloudBuffer: GPUBuffer | null = null;
  private waterBuffer: GPUBuffer | null = null;
  private waterBindGroup: GPUBindGroup | null = null;
  private frameBindGroup: GPUBindGroup | null = null;
  private frameBindGroupView: GPUTextureView | null = null;
  private frameBindGroupAoView: GPUTextureView | null = null;
  private cascadeBindGroup: GPUBindGroup | null = null;
  private prepassBindGroup: GPUBindGroup | null = null;
  private ssaoBuffer: GPUBuffer | null = null;
  /** SSAO estimate group, keyed by the prepass depth view it samples. */
  private ssaoGroup: GPUBindGroup | null = null;
  private ssaoGroupView: GPUTextureView | null = null;
  /** SSAO blur groups, one per source view (the raw estimate, the horizontal pass). */
  private readonly ssaoBlurGroups = new Map<GPUTextureView, GPUBindGroup>();
  /** Bound as the AO map while SSAO is off (the shader skips it on the flag; the texel reads "unoccluded"). */
  private aoFallback: GPUTexture | null = null;
  private aoFallbackView: GPUTextureView | null = null;
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
  /** This frame's prepass draws, state-sorted then front-to-back (rebuilt in place every frame). */
  private readonly prepassBatches: Batch[] = [];
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
  // Depth-test-free overlay lines (the `debugBounds` boxes): separate buffer so the boxes can be
  // drawn through geometry while `drawLine`/`drawAabb` callers keep occlusion.
  private overlayLines = new Float32Array(4096 * 4);
  private overlayLineCount = 0;
  private overlayBoxCount = 0;
  private overlayBuffer: GPUBuffer | null = null;
  private overlayBufferCapacity = 0;

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
  private readonly invProjection = new Mat4();
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
    // Directional lights reach every pixel, so there is nothing to cull: they stay in the uniform
    // list, where the cascade caster's shadowIndex already lives. Clustering is for the local
    // (point/spot) lights, and it stays off when a scene has none, when the camera is orthographic
    // (its clip.w is not a view depth — the reason SSAO is perspective-only too), or when the
    // quality profile vetoes it.
    let globalCount = 0;
    for (const l of lights) if (l.kind === "directional") globalCount++;
    const clustered = settings.clusteredLighting && this.options.clusteredLighting !== false && !camera.orthographic && lights.length > globalCount;
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

    // 3. Batches, and which of them lay down depth in the prepass.
    this.collectBatches(scene, camera, cascadeCount);
    const shadowsActive = cascadeCount > 0 && this.casterBatches > 0;
    this.stats.batches = this.batchCount;
    this.stats.shadowCascades = shadowsActive ? cascadeCount : 0;
    const prepass = this.classifyPrepass(settings.depthPrepass && this.options.depthPrepass !== false) > 0;
    // SSAO keys its bilateral passes on clip.w, which only a perspective projection makes view depth.
    const ssaoSettings = settings.ssao;
    const ssao = prepass && ssaoSettings.enabled && this.options.ssao !== false && !camera.orthographic && ssaoSettings.radius > 0 && ssaoSettings.intensity > 0;

    // 4. Uniforms.
    const hdr = settings.hdr;
    const scale = Math.min(2, Math.max(0.25, settings.renderScale || 1));
    const renderWidth = hdr ? Math.max(1, Math.round(this.width * scale)) : this.width;
    const renderHeight = hdr ? Math.max(1, Math.round(this.height * scale)) : this.height;
    const underwater = isUnderwater(positionRender.y, settings.water);
    this.writePerFrame(scene, renderWidth, renderHeight, shadowsActive, underwater, ssao, clustered);
    if (ssao) this.writeSsao(ssaoSettings, renderWidth, renderHeight);
    this.writeLights(scene, lights, shadowsActive ? sun : null, clustered);
    if (clustered) this.buildClusters(camera, renderWidth, renderHeight);
    this.writeShadowUniforms(scene, sun, shadowsActive ? cascadeCount : 0, shadowSize, shadowDistance);
    const skyEnabled = settings.skyEnabled && this.options.sky !== false;
    const skySettings = skyEnabled ? this.resolveSky(scene, lights) : null;
    if (skySettings) this.writeSky(skySettings);
    else this.pendingSky = null;
    this.writeClouds(scene, skySettings, lights);
    this.writeWater(scene, skySettings, lights);
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
      sky: skyEnabled && !underwater,
      underwater,
      prepass,
      ssao,
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

  private buildFrame(
    scene: Scene,
    frame: { hdr: boolean; renderWidth: number; renderHeight: number; cascadeCount: number; shadowSize: number; bloom: boolean; sky: boolean; underwater: boolean; prepass: boolean; ssao: boolean },
  ): void {
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
    const gpuParticleWorld = findGpuParticleWorld(scene);
    if (gpuParticleWorld) gpuParticleWorld.attachDevice(this.device);
    // Depth TEXTURE_BINDING + store only while particles can/will run — not after a latched attach failure.
    const wantGpuParticles = Boolean(
      gpuParticleWorld &&
        !gpuParticleWorld.attachFailed &&
        (gpuParticleWorld.ready || gpuParticleWorld.initPending),
    );
    // Soft particles and SSAO sample the depth buffer; nothing else needs TEXTURE_BINDING on it.
    const sceneDepth = g.createTexture("scene.depth", {
      width: frame.renderWidth,
      height: frame.renderHeight,
      format: this.device.depthFormat,
      usage: TextureUsage.RENDER_ATTACHMENT | (wantGpuParticles || frame.ssao ? TextureUsage.TEXTURE_BINDING : 0),
    });
    const colorFormat = frame.hdr ? HDR_FORMAT : this.device.format;

    // Depth prepass: every opaque, non-cutout surface's depth, with no fragment stage at all. The
    // forward pass then loads it and shades each visible pixel once.
    if (frame.prepass) {
      g.addPass({
        name: "forge.prepass",
        depth: { texture: sceneDepth, depthClearValue: 1 },
        execute: (ctx) => this.executePrepass(ctx),
      });
    }

    // SSAO over the prepass depth at half resolution: estimate, then a separable bilateral blur.
    // The estimate's target is dead once the horizontal blur has read it, so the graph hands the
    // same physical texture to the vertical blur's output (live-range aliasing, `aliasedBytes`).
    let aoResult: RenderGraphHandle | null = null;
    if (frame.ssao) {
      const aoWidth = Math.max(1, frame.renderWidth >> 1);
      const aoHeight = Math.max(1, frame.renderHeight >> 1);
      const aoUsage = TextureUsage.RENDER_ATTACHMENT | TextureUsage.TEXTURE_BINDING;
      const raw = g.createTexture("ssao.raw", { width: aoWidth, height: aoHeight, format: SSAO_FORMAT, usage: aoUsage });
      const blurred = g.createTexture("ssao.blur", { width: aoWidth, height: aoHeight, format: SSAO_FORMAT, usage: aoUsage });
      const result = g.createTexture("ssao.result", { width: aoWidth, height: aoHeight, format: SSAO_FORMAT, usage: aoUsage });
      g.addPass({ name: "forge.ssao", reads: [sceneDepth], color: [{ texture: raw }], execute: (ctx) => this.executeSsaoPass(ctx, "fsSsao", sceneDepth) });
      g.addPass({ name: "forge.ssao.blur.h", reads: [raw], color: [{ texture: blurred }], execute: (ctx) => this.executeSsaoPass(ctx, "fsBlurH", raw) });
      g.addPass({ name: "forge.ssao.blur.v", reads: [blurred], color: [{ texture: result }], execute: (ctx) => this.executeSsaoPass(ctx, "fsBlurV", blurred) });
      aoResult = result;
    }

    const mainReads: RenderGraphHandle[] = [];
    if (shadowAtlas !== null) mainReads.push(shadowAtlas);
    if (aoResult !== null) mainReads.push(aoResult);
    g.addPass({
      name: "forge.main",
      reads: mainReads,
      color: [{ texture: sceneColor, clearValue: [clear[0], clear[1], clear[2], 1] }],
      // Loads the prepass depth when there is one. The sky pass depth-tests against this buffer
      // (and soft particles sample it), so it must survive the pass when either runs.
      depth: { texture: sceneDepth, depthLoadOp: frame.prepass ? "load" : "clear", depthStoreOp: frame.sky || wantGpuParticles ? "store" : "discard" },
      execute: (ctx) => this.executeMainPass(ctx, colorFormat, shadowAtlas, aoResult),
    });
    if (frame.sky) {
      // Sky: fullscreen triangle on the far plane into the same colour target; the depth buffer is
      // attached with an explicit load so only pixels the geometry left at depth 1 are shaded.
      // Deliberately NOT `depthReadOnly`: the spec's read-only attach implies "load", but that
      // implicit load is the one primitive the sandbox can never verify (no WebKit build), and on
      // iOS Safari it came back without the main pass's depth — the sky's fogged planet ground
      // then painted its flat beige disc over terrain and rover alike while every stat read fine.
      // The explicit load is the portable spelling; the sky pipeline still never writes depth.
      g.addPass({
        name: "forge.sky",
        color: [{ texture: sceneColor, loadOp: "load" }],
        depth: { texture: sceneDepth, depthLoadOp: "load", depthStoreOp: "store" },
        execute: (ctx) => this.executeSkyPass(ctx, colorFormat),
      });
    }

    // Phase 12 GPU particles: sim/sort/render/resolve against the authoritative storage buffer.
    if (gpuParticleWorld?.system?.ready) {
      const m = this.cameraWorld.m;
      const rl = Math.hypot(m[0]!, m[1]!, m[2]!) || 1;
      const ul = Math.hypot(m[4]!, m[5]!, m[6]!) || 1;
      gpuParticleWorld.prepareFrame({
        viewProj: this.viewProj,
        cameraPos: this.lastCameraPos,
        cameraRight: { x: m[0]! / rl, y: m[1]! / rl, z: m[2]! / rl },
        cameraUp: { x: m[4]! / ul, y: m[5]! / ul, z: m[6]! / ul },
      });
      gpuParticleWorld.enqueue(g, {
        color: sceneColor,
        depth: sceneDepth,
        colorFormat,
        depthFormat: this.device.depthFormat,
      });
    }

    this.stats.hdr = frame.hdr;
    this.stats.sky = frame.sky;
    this.stats.underwater = frame.underwater;
    this.stats.depthPrepass = frame.prepass;
    this.stats.ssao = frame.ssao;
    this.stats.clouds = frame.sky && scene.settings.clouds.enabled && scene.settings.clouds.coverage > 0.001;
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

  private executeSkyPass(ctx: RenderGraphPassContext, colorFormat: GPUTextureFormat): void {
    const pass = ctx.beginRenderPass();
    const bundle = this.pipelines.get({ technique: "sky", colorFormat, depthFormat: this.device.depthFormat, transparent: false, doubleSided: true, instanced: false, writeDepth: false });
    pass.setPipeline(bundle.pipeline);
    pass.setBindGroup(0, this.ensureSkyBindGroup());
    pass.draw(3, 1, 0, 0);
    pass.end();
    this.stats.drawCalls++;
    this.stats.triangles += 1;
  }

  private ensureSkyBindGroup(): GPUBindGroup {
    if (this.skyBindGroup) return this.skyBindGroup;
    const { sky } = this.pipelines.bindGroupLayouts;
    this.skyBindGroup = this.device.device.createBindGroup({
      label: "sky.bindgroup",
      layout: sky,
      entries: [
        { binding: 0, resource: { buffer: this.frameBuffer! } },
        { binding: 1, resource: { buffer: this.skyBuffer! } },
        { binding: 2, resource: { buffer: this.cloudBuffer! } },
      ],
    });
    return this.skyBindGroup;
  }

  /** Group 2 for the water program: the single water block, shared by all water draws. */
  private ensureWaterBindGroup(): GPUBindGroup {
    if (this.waterBindGroup) return this.waterBindGroup;
    const { water } = this.pipelines.bindGroupLayouts;
    this.waterBindGroup = this.device.device.createBindGroup({
      label: "water.bindgroup",
      layout: water,
      entries: [{ binding: 0, resource: { buffer: this.waterBuffer! } }],
    });
    return this.waterBindGroup;
  }

  private applyGraphStats(stats: {
    passes: number;
    culledPasses: number;
    transientTextures: number;
    physicalTextures: number;
    transientBytes: number;
    pooledBytes: number;
    aliasedBytes: number;
    texturesCreated: number;
  }): void {
    this.stats.passes = stats.passes;
    this.stats.culledPasses = stats.culledPasses;
    this.stats.transientTextures = stats.transientTextures;
    this.stats.physicalTextures = stats.physicalTextures;
    this.stats.transientBytes = stats.transientBytes;
    this.stats.pooledBytes = stats.pooledBytes;
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

  /**
   * `forge.prepass`: depth only, state-sorted then front to back. The pipelines are the standard
   * module's own vertex entry points with no fragment stage, so each depth written here is exactly
   * the one `forge.main` computes for the same draw (`@invariant` position, same module, same entry).
   */
  private executePrepass(ctx: RenderGraphPassContext): void {
    this.syncGraphEpoch();
    const pass = ctx.beginRenderPass();
    pass.setBindGroup(0, this.ensurePrepassBindGroup());
    const depthFormat = this.device.depthFormat;
    let lastState = -1;
    const list = this.prepassBatches;
    for (let i = 0; i < list.length; i++) {
      const b = list[i]!;
      const state = prepassState(b);
      if (state !== lastState) {
        lastState = state;
        pass.setPipeline(this.pipelines.get({ technique: "prepass", colorFormat: null, depthFormat, transparent: false, doubleSided: b.material.doubleSided, instanced: b.count > 1 }).pipeline);
      }
      pass.setBindGroup(1, this.drawBindGroup!, [b.objectOffset, b.instanceOffset]);
      pass.setVertexBuffer(0, b.geometry.vertexBuffer!);
      if (b.geometry.indexBuffer) {
        pass.setIndexBuffer(b.geometry.indexBuffer, b.geometry.indexFormat!);
        pass.drawIndexed(b.indexCount, b.count, b.indexStart);
      } else {
        pass.draw(b.indexCount, b.count);
      }
      this.stats.prepassDraws++;
    }
    pass.end();
  }

  /** One SSAO fullscreen pass: the estimate (samples the prepass depth) or one blur direction. */
  private executeSsaoPass(ctx: RenderGraphPassContext, entry: SsaoEntryPoint, source: RenderGraphHandle): void {
    this.syncGraphEpoch();
    const pipeline = this.pipelines.get({ technique: "ssao", colorFormat: SSAO_FORMAT, depthFormat: null, transparent: false, doubleSided: true, instanced: false, fragmentEntry: entry });
    const group = entry === "fsSsao" ? this.ensureSsaoGroup(ctx.view(source, { aspect: "depth-only" })) : this.ensureSsaoBlurGroup(ctx.view(source));
    const pass = ctx.beginRenderPass();
    pass.setPipeline(pipeline.pipeline);
    pass.setBindGroup(0, group);
    pass.draw(3);
    this.stats.drawCalls++;
    pass.end();
  }

  private executeMainPass(ctx: RenderGraphPassContext, colorFormat: GPUTextureFormat, shadowAtlas: RenderGraphHandle | null, ao: RenderGraphHandle | null): void {
    this.syncGraphEpoch();
    const shadowView = shadowAtlas !== null ? ctx.view(shadowAtlas, { dimension: "2d-array" }) : this.ensureShadowFallback();
    const aoView = ao !== null ? ctx.view(ao) : this.ensureAoFallback();
    const pass = ctx.beginRenderPass();
    pass.setBindGroup(0, this.ensureFrameBindGroup(shadowView, aoView));
    const sorted = this.sortedBatches;
    sorted.length = 0;
    for (let i = 0; i < this.batchCount; i++) {
      const b = this.batchPool[i]!;
      if (!b.shadowOnly) sorted.push(b);
    }
    sorted.sort((a, b) => (a.transparent === b.transparent ? a.depthSort - b.depthSort : a.transparent ? 1 : -1));
    for (const b of sorted) {
      const isWater = b.material.technique === "water";
      const pipeline = this.pipelines.get({
        technique: isWater ? "water" : b.material.technique === "unlit" ? "unlit" : "standard",
        colorFormat,
        depthFormat: this.device.depthFormat,
        transparent: b.transparent,
        doubleSided: b.material.doubleSided,
        instanced: b.count > 1,
        // Prepassed surfaces are already in the depth buffer: test `less-equal` against their own
        // depth and leave it alone. With writes off, early-Z survives the shader's `discard`.
        writeDepth: !b.prepass,
      });
      pass.setPipeline(pipeline.pipeline);
      pass.setBindGroup(1, this.drawBindGroup!, [b.objectOffset, b.instanceOffset]);
      pass.setBindGroup(2, isWater ? this.ensureWaterBindGroup() : this.ensureMaterialGroup(b.material));
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
    if (this.overlayLineCount > 0) this.drawOverlayLines(pass, colorFormat);
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
    s.debugBounds = 0;
    s.hdr = false;
    s.bloomMips = 0;
    s.sky = false;
    s.skySamples = 0;
    s.clouds = false;
    s.underwater = false;
    s.depthPrepass = false;
    s.prepassDraws = 0;
    s.ssao = false;
    s.clusteredLighting = false;
    s.lights = 0;
    s.clusteredLights = 0;
    s.clustersUsed = 0;
    s.clusterIndices = 0;
    s.maxLightsPerCluster = 0;
    s.lightsDropped = false;
    s.passes = 0;
    s.culledPasses = 0;
    s.transientTextures = 0;
    s.physicalTextures = 0;
    s.aliasedBytes = 0;
    s.texturesCreated = 0;
    this.instanceCount = 0;
    this.clusterBuild = null;
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

  private writePerFrame(scene: Scene, renderWidth: number, renderHeight: number, shadowsActive: boolean, underwater = false, ssao = false, clustered = false): void {
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
    // Underwater: murk replaces the fog colour, and the density is the worse of the configured
    // fog and the water's own murk — the scene's `fog` settings are never mutated.
    const murk = underwater && settings.water.enabled ? settings.water : null;
    const fogColor = murk ? murk.murkColor : fog.color;
    a.setVec3("fogColor", fogColor.r, fogColor.g, fogColor.b);
    a.setF32("fogDensity", murk ? Math.max(fog.mode === "none" ? 0 : fog.density, murk.murkDensity) : fog.mode === "none" ? 0 : fog.density);
    a.setVec2("fogRange", fog.start, fog.end);
    a.setVec2("renderExtent", renderWidth, renderHeight);
    a.setF32("shadowDistance", settings.shadow.distance);
    a.setF32("ambientIntensity", settings.ambientIntensity);
    a.setI32("lightCount", this.lightList.length);
    a.setI32("cascadeCount", shadowsActive ? this.cascades.length : 0);
    a.setVec3("ambientColor", settings.ambientColor.r, settings.ambientColor.g, settings.ambientColor.b);
    a.setF32("toneMapping", TONE_MAP_MODE[settings.toneMapping] ?? 2);
    const flags = (settings.skyEnabled ? 1 : 0) | (settings.hdr ? 2 : 0) | 4 | (shadowsActive ? 8 : 0) | (ssao ? 16 : 0) | (clustered ? 32 : 0);
    a.setU32("flags", flags);
    // With the scene fog off but the camera submerged, exp² carries the murk.
    const fogMode = murk && fog.mode === "none" ? "exp2" : fog.mode;
    a.setVec4("fogParams", FOG_MODE_ID[fogMode] ?? 0, fog.heightFalloff, fog.heightBase, 0);
    this.device.device.queue.writeBuffer(this.frameBuffer!, 0, gpuSource(this.frameBytes.bytes.subarray(0, this.frameBytes.byteLength)));
  }

  /** SSAO parameters for the frame: the inverse projection plus the settings, clamped to sane ranges. */
  private writeSsao(s: SceneSsaoSettings, renderWidth: number, renderHeight: number): void {
    this.invProjection.copyFrom(this.projection);
    if (!this.invProjection.invert()) this.invProjection.setIdentity();
    const a = this.ssaoAccessor;
    a.setMat4("invProj", this.invProjection.m);
    a.setF32("radius", s.radius);
    a.setF32("bias", Math.max(0, s.bias));
    a.setF32("intensity", s.intensity);
    // Pixels per metre at view depth 1: NDC y = m[5]·y/z, and NDC spans half the target height.
    a.setF32("projScale", 0.5 * renderHeight * this.projection.m[5]!);
    a.setVec2("depthSize", renderWidth, renderHeight);
    a.setVec2("aoSize", Math.max(1, renderWidth >> 1), Math.max(1, renderHeight >> 1));
    a.setU32("sampleCount", Math.max(1, Math.min(32, Math.round(Number.isFinite(s.samples) ? s.samples : 12))));
    a.setF32("sharpness", SSAO_SHARPNESS);
    // A close-up would otherwise spread 12 taps over hundreds of pixels (cache-hostile, undersampled).
    a.setF32("maxPixels", Math.max(16, renderHeight * 0.1));
    this.device.device.queue.writeBuffer(this.ssaoBuffer!, 0, gpuSource(this.ssaoBytes.bytes.subarray(0, this.ssaoBytes.byteLength)));
  }

  /**
   * Resolve the frame's sky: scene settings with the one-frame override merged on top, the sun
   * taken from (in order) the override, the settings, the first directional light, a default.
   * Returns the settings the pass will render with; the override is consumed here.
   */
  private resolveSky(scene: Scene, lights: readonly Light[]): SceneSkySettings {
    const out = this.skyFrame;
    const base = scene.settings.sky;
    const override = this.pendingSky;
    this.pendingSky = null;
    out.sunIntensity = pickSky(base, override, "sunIntensity");
    out.exposure = pickSky(base, override, "exposure");
    out.turbidity = pickSky(base, override, "turbidity");
    out.rayleigh = pickSky(base, override, "rayleigh");
    out.mie = pickSky(base, override, "mie");
    out.sunAngularRadius = pickSky(base, override, "sunAngularRadius");
    out.sunDiscIntensity = pickSky(base, override, "sunDiscIntensity");
    out.starBrightness = pickSky(base, override, "starBrightness");
    out.nightEnabled = pickSky(base, override, "nightEnabled");
    out.seaLevel = pickSky(base, override, "seaLevel");
    out.quality = pickSky(base, override, "quality");
    out.atmosphere = pickSky(base, override, "atmosphere");
    const dir = this.skySunDirection;
    const explicit = pickSky(base, override, "sunDirection");
    if (explicit) dir.copyFrom(explicit);
    else {
      let sun: Light | null = null;
      for (const l of lights) {
        if (l.kind === "directional") {
          sun = l;
          break;
        }
      }
      if (sun) dir.set(-sun.direction.x, -sun.direction.y, -sun.direction.z);
      else dir.copyFrom(DEFAULT_SUN);
    }
    if (dir.lengthSq() < 1e-12) dir.copyFrom(DEFAULT_SUN);
    dir.normalize();
    out.sunDirection = dir;
    return out;
  }

  private writeSky(sky: SceneSkySettings): void {
    const a = this.skyAccessor;
    const atmo: Readonly<AtmosphereParams> = sky.atmosphere ?? EARTH_ATMOSPHERE;
    const dir = sky.sunDirection!;
    const mieScale = sky.mie * (sky.turbidity / 2);
    const [viewSamples, lightSamples] = SKY_QUALITY_SAMPLES[capSkyQuality(sky.quality, this.options.skyQuality)];
    this.stats.skySamples = viewSamples;
    a.setVec3("sunDirection", dir.x, dir.y, dir.z);
    a.setF32("sunIntensity", sky.sunIntensity * sky.exposure);
    a.setVec3("rayleighScattering", atmo.rayleighScattering[0] * sky.rayleigh, atmo.rayleighScattering[1] * sky.rayleigh, atmo.rayleighScattering[2] * sky.rayleigh);
    a.setF32("rayleighScaleHeight", atmo.rayleighScaleHeight);
    a.setVec3("mieScattering", atmo.mieScattering[0] * mieScale, atmo.mieScattering[1] * mieScale, atmo.mieScattering[2] * mieScale);
    a.setF32("mieScaleHeight", atmo.mieScaleHeight);
    a.setVec3("mieExtinction", atmo.mieExtinction[0] * mieScale, atmo.mieExtinction[1] * mieScale, atmo.mieExtinction[2] * mieScale);
    a.setF32("mieAnisotropy", atmo.mieAnisotropy);
    a.setVec3("ozoneAbsorption", atmo.ozoneAbsorption[0], atmo.ozoneAbsorption[1], atmo.ozoneAbsorption[2]);
    a.setF32("ozoneCenter", atmo.ozoneCenter);
    a.setVec3("groundAlbedo", atmo.groundAlbedo[0], atmo.groundAlbedo[1], atmo.groundAlbedo[2]);
    a.setF32("ozoneWidth", atmo.ozoneWidth);
    a.setF32("planetRadius", atmo.planetRadius);
    a.setF32("atmosphereHeight", atmo.atmosphereHeight);
    a.setF32("observerHeight", Math.max(0, this.lastCameraPos.y - sky.seaLevel));
    a.setF32("sunAngularRadius", sky.sunAngularRadius);
    a.setF32("sunDiscIntensity", sky.sunDiscIntensity);
    a.setF32("starBrightness", sky.nightEnabled ? sky.starBrightness : 0);
    a.setI32("viewSamples", viewSamples);
    a.setI32("lightSamples", lightSamples);
    this.device.device.queue.writeBuffer(this.skyBuffer!, 0, gpuSource(this.skyBytes.bytes.subarray(0, this.skyBytes.byteLength)));
  }

  /**
   * The frame's sun for the systems that need one without a sky pass (cloud lighting when the
   * sky is off is skipped, but the water always shades): the sky override first, then the first
   * directional light, then the same default the sky uses.
   */
  private frameSunDirection(sky: SceneSkySettings | null, lights: readonly Light[], out: Vec3): Vec3 {
    if (sky?.sunDirection) return out.copyFrom(sky.sunDirection);
    for (const l of lights) {
      if (l.kind === "directional") return out.set(-l.direction.x, -l.direction.y, -l.direction.z).normalize();
    }
    return out.copyFrom(DEFAULT_SUN);
  }

  private writeClouds(scene: Scene, sky: SceneSkySettings | null, lights: readonly Light[]): void {
    const a = this.cloudAccessor;
    const clouds = scene.settings.clouds;
    // The lighting integrals run only when the deck can shade a pixel; otherwise the buffer
    // carries the art parameters with the previous tints (harmless — the shader early-outs).
    if (sky && clouds.enabled && clouds.coverage > 0.001) {
      const atmo = sky.atmosphere ?? EARTH_ATMOSPHERE;
      this.frameSunDirection(sky, lights, this.scratchDir);
      this.skyLight.update(this.scratchDir, atmo, Math.max(0, this.lastCameraPos.y - sky.seaLevel), sky.sunIntensity * sky.exposure);
    }
    a.setF32("coverage", clouds.coverage);
    a.setF32("density", clouds.density);
    a.setF32("height", clouds.height);
    a.setF32("thickness", 400);
    a.setF32("scale", clouds.scale);
    a.setF32("silverLining", clouds.silverLining);
    a.setF32("seed", clouds.seed);
    a.setF32("enabled", clouds.enabled ? 1 : 0);
    a.setVec3("sunTint", this.skyLight.sunTint[0]!, this.skyLight.sunTint[1]!, this.skyLight.sunTint[2]!);
    a.setVec3("ambientTint", this.skyLight.ambientTint[0]!, this.skyLight.ambientTint[1]!, this.skyLight.ambientTint[2]!);
    a.setVec3("cloudAlbedo", clouds.albedo.r, clouds.albedo.g, clouds.albedo.b);
    a.setVec2("wind", clouds.windX, clouds.windZ);
    this.device.device.queue.writeBuffer(this.cloudBuffer!, 0, gpuSource(this.cloudBytes.bytes.subarray(0, this.cloudBytes.byteLength)));
  }

  private writeWater(scene: Scene, sky: SceneSkySettings | null, lights: readonly Light[]): void {
    const a = this.waterAccessor;
    const water = scene.settings.water;
    const skySettings = scene.settings.sky;
    if (water.enabled) {
      const atmo = sky?.atmosphere ?? skySettings.atmosphere ?? EARTH_ATMOSPHERE;
      this.frameSunDirection(sky, lights, this.scratchDir);
      const sunIntensity = (sky?.sunIntensity ?? skySettings.sunIntensity) * (sky?.exposure ?? skySettings.exposure);
      this.skyLight.update(this.scratchDir, atmo, Math.max(0, this.lastCameraPos.y - skySettings.seaLevel), sunIntensity);
      this.frameSunDirection(sky, lights, this.scratchVec);
    } else {
      this.scratchVec.copyFrom(DEFAULT_SUN);
    }
    // Waves as the vertex shader consumes them: (dirX, dirZ, k, speed) + (amplitude, Q, phase, 0)
    // with Q = steepness/(k·A·4) — the same normalisation `sampleGerstner` uses over 4 waves.
    const baseA = a.offsetOf("wavesA");
    const baseB = a.offsetOf("wavesB");
    const strideA = a.arrayStride("wavesA");
    const strideB = a.arrayStride("wavesB");
    const f32 = this.waterBytes.f32;
    for (let i = 0; i < 4; i++) {
      const w = water.waves[i];
      const oA = (baseA + i * strideA) >> 2;
      const oB = (baseB + i * strideB) >> 2;
      if (!w || !(w.amplitude > 0) || !(w.wavelength > 0)) {
        f32[oA] = 0;
        f32[oA + 1] = 0;
        f32[oA + 2] = 0;
        f32[oA + 3] = 0;
        f32[oB] = 0;
        f32[oB + 1] = 0;
        f32[oB + 2] = 0;
        f32[oB + 3] = 0;
        continue;
      }
      const len = Math.hypot(w.directionX, w.directionZ) || 1;
      const k = (2 * Math.PI) / w.wavelength;
      f32[oA] = w.directionX / len;
      f32[oA + 1] = w.directionZ / len;
      f32[oA + 2] = k;
      f32[oA + 3] = w.speed;
      f32[oB] = w.amplitude;
      f32[oB + 1] = w.steepness / (k * w.amplitude * 4);
      f32[oB + 2] = w.phase;
      f32[oB + 3] = 0;
    }
    a.setVec3("deepColor", water.deepColor.r, water.deepColor.g, water.deepColor.b);
    a.setF32("time", water.time);
    a.setVec3("shallowColor", water.shallowColor.r, water.shallowColor.g, water.shallowColor.b);
    a.setF32("opacity", water.opacity);
    a.setVec3("foamColor", water.foamColor.r, water.foamColor.g, water.foamColor.b);
    a.setF32("foamThreshold", water.foamThreshold);
    a.setVec3("sunTint", this.skyLight.sunTint[0]!, this.skyLight.sunTint[1]!, this.skyLight.sunTint[2]!);
    a.setF32("sunGlint", water.sunGlint);
    a.setVec3("skyTint", this.skyLight.horizonTint[0]!, this.skyLight.horizonTint[1]!, this.skyLight.horizonTint[2]!);
    a.setVec3("sunDirection", this.scratchVec.x, this.scratchVec.y, this.scratchVec.z);
    this.device.device.queue.writeBuffer(this.waterBuffer!, 0, gpuSource(this.waterBytes.bytes.subarray(0, this.waterBytes.byteLength)));
  }

  /**
   * Write this frame's lights. Directional lights (and, with clustering off, every light) go into
   * the uniform `LightBlock`; with clustering on the local lights go into the storage block the
   * cluster grid references, and are staged for `buildClusters`. One record layout serves both, so
   * the two destinations cannot disagree about what a light is.
   */
  private writeLights(scene: Scene, lights: Light[], caster: Light | null, clustered: boolean): void {
    const a = this.lightAccessor;
    let globals = 0;
    let locals = 0;
    let truncated = false;
    for (const l of lights) {
      const pos = scene.world.worldPosition(l.entity, this.scratchVec);
      if (l.kind === "directional" || !clustered) {
        if (globals >= MAX_LIGHTS_PER_FRAME) {
          truncated = true; // the uniform block is full: this light does not reach the shader at all
          continue;
        }
        const kind = l.kind === "directional" ? 0 : l.kind === "point" ? 1 : 2;
        this.writeLightRecord(a.element("lights", globals) as StructAccessor, l, pos.x, pos.y, pos.z, kind, l === caster ? 0 : -1);
        globals++;
      } else {
        if (locals >= MAX_CLUSTERED_LIGHTS) {
          truncated = true;
          continue;
        }
        // Local lights never carry a shadow index: point/spot shadows are 13.9, and the cascade
        // caster is by construction the directional light that stayed in the uniform block.
        this.writeLightRecord(this.clusterLightAccessor.element("lights", locals) as StructAccessor, l, pos.x, pos.y, pos.z, l.kind === "point" ? 1 : 2, -1);
        const slot = this.clusterLightSources[locals] ?? { x: 0, y: 0, z: 0, range: 0, spot: false, dirX: 0, dirY: -1, dirZ: 0, outerCone: 0.5, intensity: 0, colorLuma: 0 };
        this.clusterLightSources[locals] = slot;
        slot.x = pos.x;
        slot.y = pos.y;
        slot.z = pos.z;
        slot.range = l.range;
        slot.spot = l.kind === "spot";
        slot.dirX = l.direction.x;
        slot.dirY = l.direction.y;
        slot.dirZ = l.direction.z;
        slot.outerCone = l.outerCone;
        slot.intensity = l.intensity;
        // Rec.709 luma of the linear colour: the other half of the rank the grid evicts by.
        slot.colorLuma = 0.2126 * l.color.x + 0.7152 * l.color.y + 0.0722 * l.color.z;
        locals++;
      }
    }
    a.setI32("count", globals);
    a.setI32("shadowedCount", caster ? 1 : 0);
    this.clusterLightAccessor.setI32("count", locals);
    this.clusterLightCount = locals;
    this.stats.lights = lights.length;
    this.stats.lightsDropped = truncated;
    this.device.device.queue.writeBuffer(this.lightBuffer!, 0, gpuSource(this.lightBytes.bytes.subarray(0, this.lightBytes.byteLength)));
  }

  /** One light record, written into either the uniform block or the cluster light block. */
  private writeLightRecord(e: StructAccessor, l: Light, x: number, y: number, z: number, kind: number, shadowIndex: number): void {
    e.setVec4("positionRange", x, y, z, kind === 0 ? 0 : l.range);
    e.setVec4("directionIntensity", l.direction.x, l.direction.y, l.direction.z, l.intensity);
    e.setVec3("color", l.color.x, l.color.y, l.color.z);
    e.setVec2("spotAngles", l.innerCone, l.outerCone);
    e.setI32("kind", kind);
    e.setI32("shadowIndex", shadowIndex);
  }

  /**
   * Build and upload this frame's cluster grid (Phase 13.3, docs/RENDERING.md §4b).
   *
   * `writeLights` has already staged the local lights; this hands them to the grid, uploads the two
   * arrays it wrote plus the quantisation the fragment stage must agree with, and reports the build.
   * The slice span is the builder's own (the deepest live light, not the camera's far plane), so the
   * shader and the CPU cannot disagree about where a slice boundary falls.
   */
  private buildClusters(camera: Camera, renderWidth: number, renderHeight: number): void {
    const locals = this.clusterLightCount;
    const near = Math.max(1e-4, camera.near);
    const build = this.clusterGrid.build(
      this.clusterLightSources,
      { view: this.view, proj00: this.projection.m[0]!, proj11: this.projection.m[5]!, near, far: camera.far },
      locals,
    );
    this.clusterBuild = build;
    const a = this.clusterAccessor;
    a.setVec2("invExtent", 1 / Math.max(1, renderWidth), 1 / Math.max(1, renderHeight));
    a.setVec2("gridScale", CLUSTER_TILES_X, CLUSTER_TILES_Y);
    a.setF32("near", near);
    a.setF32("logNear", Math.log(near));
    a.setF32("sliceScale", CLUSTER_SLICES / Math.max(1e-6, Math.log(Math.max(build.far, near * 1.001) / near)));
    a.setF32("slices", CLUSTER_SLICES);
    a.setI32("lightCount", locals);
    a.setI32("maxPerCluster", build.capPerCluster);

    const q = this.device.device.queue;
    q.writeBuffer(this.clusterBuffer!, 0, gpuSource(this.clusterBytes.bytes.subarray(0, this.clusterBytes.byteLength)));
    // The light records are a fixed-stride array: upload the header plus the records that exist.
    q.writeBuffer(this.clusterLightBuffer!, 0, gpuSource(this.clusterLightBytes.bytes.subarray(0, CLUSTER_LIGHTS_FIELD.offset + locals * CLUSTER_LIGHTS_FIELD.stride!)));
    // Every cluster's count can change, so the whole offset array goes; the index list only up to what
    // was written (a full 384 KB upload for a scene with three lamps would be pure waste).
    q.writeBuffer(this.clusterGridBuffer!, CLUSTER_OFFSETS_FIELD.offset, gpuSource(this.clusterGrid.clusterOffsets));
    if (build.indexCount > 0) {
      q.writeBuffer(this.clusterGridBuffer!, CLUSTER_INDICES_FIELD.offset, gpuSource(this.clusterGrid.indices.subarray(0, build.indexCount)));
    }

    const s = this.stats;
    s.clusteredLighting = true;
    s.clusteredLights = locals;
    s.clustersUsed = build.clustersUsed;
    s.clusterIndices = build.indexCount;
    s.maxLightsPerCluster = build.maxPerCluster;
    s.lightsDropped = s.lightsDropped || build.dropped;
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
    const maxInstances = this.maxInstancesPerBatch;
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
      // Debug bounds: record the would-be footprint of everything that *has* a renderable this
      // frame, culled or not — the boxes are what proves where the model is supposed to sit.
      if (this.debugBounds) this.queueOverlayAabb(box, inView ? DEBUG_BOUNDS_IN_VIEW : DEBUG_BOUNDS_CULLED);
      const caster = cascadeCount > 0 && r.castShadow && !r.transparent && !r.overlay;
      let shadowOnly = false;
      if (!inView) {
        this.stats.culled++;
        // Off-screen casters still matter when a cascade box contains them.
        if (!caster || !this.intersectsAnyCascade(box, cascadeCount)) continue;
        shadowOnly = true;
      }
      const key = `${geometryIdentity(r.geometry)}|${r.material.pipelineKey}|${r.transparent ? "t" : "o"}|${r.overlay ? "ov" : "-"}|${caster ? "cs" : "-"}|${shadowOnly ? "so" : "-"}`;
      // Merge only when this record lands exactly at the previous batch's end — instances must
      // be contiguous to share one draw, which is why batches are emitted in one pass. A new
      // batch starts 256-aligned (the WebGPU dynamic-offset rule for the window in setBindGroup);
      // continuation records sit at exactly +INSTANCE_STRIDE so the shader's
      // `array<InstanceData>` walk reads them. Reserving *every* record at 256 made
      // `offset + count * stride` never match, so each renderable became its own batch (the rain
      // field alone turned a 24-draw scene into 1245).
      const previousIndex = this.batchIndex.get(key);
      const previous = previousIndex === undefined ? null : this.batchPool[previousIndex]!;
      const canMerge =
        previous !== null &&
        previous.count < maxInstances &&
        previous.instanceOffset + previous.count * INSTANCE_STRIDE === this.instanceArena.usedBytes;
      const instanceOffset = canMerge ? this.instanceArena.reserve(INSTANCE_STRIDE, 1) : this.instanceArena.reserve(INSTANCE_STRIDE, 256);
      const base = instanceOffset >> 2;
      const f32 = this.instanceArena.target.f32;
      const u32 = this.instanceArena.target.u32;
      for (let k = 0; k < 16; k++) f32[base + k] = matrix[k] ?? 0;
      u32[base + 16] = r.tint || packColorRGBA(1, 1, 1, 1);
      f32[base + 17] = r.emissive;
      u32[base + 18] = 0;
      u32[base + 19] = 0;
      let index = previousIndex;
      const existing = previous;
      if (canMerge && existing) {
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

  /**
   * Flag the batches `forge.prepass` draws and collect them into `prepassBatches` (reused array,
   * no allocation in a steady frame). Returns how many there are; 0 means no prepass this frame.
   */
  private classifyPrepass(wanted: boolean): number {
    const list = this.prepassBatches;
    list.length = 0;
    for (let i = 0; i < this.batchCount; i++) {
      const b = this.batchPool[i]!;
      b.prepass = wanted && isPrepassEligible(b);
      if (b.prepass) list.push(b);
    }
    if (list.length > 1) list.sort(prepassOrder);
    return list.length;
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
        prepass: false,
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
    this.clusterBuffer ??= d.createBuffer({ label: "cluster.uniforms", size: this.clusterBytes.byteLength, usage: BufferUsage.UNIFORM | BufferUsage.COPY_DST });
    this.clusterLightBuffer ??= d.createBuffer({ label: "cluster.lights", size: this.clusterLightBytes.byteLength, usage: BufferUsage.STORAGE | BufferUsage.COPY_DST });
    this.clusterGridBuffer ??= d.createBuffer({ label: "cluster.grid", size: ClusterGridBlock.byteSize("storage"), usage: BufferUsage.STORAGE | BufferUsage.COPY_DST });
    this.shadowBuffer ??= d.createBuffer({ label: "shadow.uniforms", size: this.shadowBytes.byteLength, usage: BufferUsage.UNIFORM | BufferUsage.COPY_DST });
    this.cascadeBuffer ??= d.createBuffer({ label: "shadowpass.uniforms", size: this.cascadeBytes.byteLength, usage: BufferUsage.UNIFORM | BufferUsage.COPY_DST });
    this.postBuffer ??= d.createBuffer({ label: "post.uniforms", size: this.postBytes.byteLength, usage: BufferUsage.UNIFORM | BufferUsage.COPY_DST });
    this.skyBuffer ??= d.createBuffer({ label: "sky.uniforms", size: this.skyBytes.byteLength, usage: BufferUsage.UNIFORM | BufferUsage.COPY_DST });
    this.cloudBuffer ??= d.createBuffer({ label: "cloud.uniforms", size: this.cloudBytes.byteLength, usage: BufferUsage.UNIFORM | BufferUsage.COPY_DST });
    this.waterBuffer ??= d.createBuffer({ label: "water.uniforms", size: this.waterBytes.byteLength, usage: BufferUsage.UNIFORM | BufferUsage.COPY_DST });
    this.ssaoBuffer ??= d.createBuffer({ label: "ssao.uniforms", size: this.ssaoBytes.byteLength, usage: BufferUsage.UNIFORM | BufferUsage.COPY_DST });
    const { depthFrame } = this.pipelines.bindGroupLayouts;
    this.cascadeBindGroup ??= d.createBindGroup({
      label: "shadowpass.bindgroup",
      layout: depthFrame,
      entries: [{ binding: 0, resource: { buffer: this.cascadeBuffer, size: ShadowPassUniforms.byteSize("uniform") } }],
    });
    this.ensureArenas();
  }

  /** The frame bind group depends on which shadow atlas and AO views are bound; rebuilt when either changes. */
  private ensureFrameBindGroup(shadowView: GPUTextureView, aoView: GPUTextureView): GPUBindGroup {
    if (this.frameBindGroup && this.frameBindGroupView === shadowView && this.frameBindGroupAoView === aoView) return this.frameBindGroup;
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
        { binding: 5, resource: aoView },
        // Clustered lighting (perFrame.flags bit 5 says whether the shader reads them).
        { binding: 6, resource: { buffer: this.clusterBuffer! } },
        { binding: 7, resource: { buffer: this.clusterLightBuffer! } },
        { binding: 8, resource: { buffer: this.clusterGridBuffer! } },
      ],
    });
    this.frameBindGroupView = shadowView;
    this.frameBindGroupAoView = aoView;
    return this.frameBindGroup;
  }

  /** Group 0 of `forge.prepass`: only the per-frame block (the vertex stage's view-projection). */
  private ensurePrepassBindGroup(): GPUBindGroup {
    this.prepassBindGroup ??= this.device.device.createBindGroup({
      label: "prepass.bindgroup",
      layout: this.pipelines.bindGroupLayouts.prepassFrame,
      entries: [{ binding: 0, resource: { buffer: this.frameBuffer! } }],
    });
    return this.prepassBindGroup;
  }

  private ensureSsaoGroup(depthView: GPUTextureView): GPUBindGroup {
    if (this.ssaoGroup && this.ssaoGroupView === depthView) return this.ssaoGroup;
    this.ssaoGroup = this.device.device.createBindGroup({
      label: "ssao.bindgroup",
      layout: this.pipelines.bindGroupLayouts.ssao,
      entries: [
        { binding: SSAO_BINDINGS.uniforms.binding, resource: { buffer: this.ssaoBuffer! } },
        { binding: SSAO_BINDINGS.depth.binding, resource: depthView },
      ],
    });
    this.ssaoGroupView = depthView;
    return this.ssaoGroup;
  }

  private ensureSsaoBlurGroup(source: GPUTextureView): GPUBindGroup {
    let group = this.ssaoBlurGroups.get(source);
    if (group) return group;
    group = this.device.device.createBindGroup({
      label: "ssao.blur.bindgroup",
      layout: this.pipelines.bindGroupLayouts.ssaoBlur,
      entries: [
        { binding: SSAO_BINDINGS.uniforms.binding, resource: { buffer: this.ssaoBuffer! } },
        { binding: SSAO_BINDINGS.ao.binding, resource: source },
      ],
    });
    this.ssaoBlurGroups.set(source, group);
    return group;
  }

  /** Bound while SSAO is off: the forward shader skips it on the flag bit, and its texel reads "unoccluded". */
  private ensureAoFallback(): GPUTextureView {
    if (this.aoFallbackView) return this.aoFallbackView;
    this.aoFallback = this.device.createTexture({
      label: "ssao.fallback",
      size: { width: 1, height: 1, depthOrArrayLayers: 1 },
      format: SSAO_FORMAT,
      usage: TextureUsage.TEXTURE_BINDING | TextureUsage.COPY_DST,
    });
    this.device.device.queue.writeTexture(
      { texture: this.aoFallback },
      gpuSource(new Uint16Array([HALF_ONE, HALF_SKY_KEY])),
      { bytesPerRow: 4, rowsPerImage: 1 },
      { width: 1, height: 1, depthOrArrayLayers: 1 },
    );
    this.aoFallbackView = this.aoFallback.createView({ label: "ssao.fallback.view" });
    return this.aoFallbackView;
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
    this.frameBindGroupAoView = null;
    this.ssaoGroup = null;
    this.ssaoGroupView = null;
    this.ssaoBlurGroups.clear();
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
    // One full instance window of slack past the written region: every batch start `o` then
    // satisfies `o + instanceWindowBytes <= capacity`, which is exactly the WebGPU rule for a
    // dynamic-offset binding of that size (see the draw bind group above).
    const needInstance = alignUp(Math.max(this.instanceArena.usedBytes + this.instanceWindowBytes, 64 * 1024), 256);
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
          // The instance binding is a dynamic-offset window: the shader walks up to
          // `maxInstancesPerBatch` records past the offset, so the declared size is one full
          // window (not the struct's 80 bytes — that made instance 1+ an OOB read). WebGPU also
          // requires `dynamicOffset + size <= bufferSize`, which ensureArenas upholds by always
          // leaving one window of slack past the written region.
          { binding: 1, resource: { buffer: this.instanceBuffer!, size: this.instanceWindowBytes } },
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

  private readonly boundsCornerA = new Vec3();
  private readonly boundsCornerB = new Vec3();

  private queueOverlayLine(a: Vec3, b: Vec3, color: number): void {
    const need = (this.overlayLineCount + 1) * 4;
    if (need > this.overlayLines.length) {
      const next = new Float32Array(Math.max(need * 2, this.overlayLines.length * 2));
      next.set(this.overlayLines);
      this.overlayLines = next;
    }
    const f = this.overlayLines;
    const u = new Uint32Array(f.buffer, f.byteOffset, f.length);
    const o = this.overlayLineCount * 4;
    f[o] = a.x;
    f[o + 1] = a.y;
    f[o + 2] = a.z;
    u[o + 3] = color >>> 0;
    f[o + 4] = b.x;
    f[o + 5] = b.y;
    f[o + 6] = b.z;
    u[o + 7] = color >>> 0;
    this.overlayLineCount++;
  }

  private queueOverlayAabb(box: AABB, color: number): void {
    const min = box.min;
    const max = box.max;
    const a = this.boundsCornerA;
    const b = this.boundsCornerB;
    // Corner order matches DEBUG_BOX_EDGES (bottom ring 0-3, top ring 4-7).
    const cx = [min.x, max.x, max.x, min.x, min.x, max.x, max.x, min.x];
    const cy = [min.y, min.y, min.y, min.y, max.y, max.y, max.y, max.y];
    const cz = [min.z, min.z, max.z, max.z, min.z, min.z, max.z, max.z];
    for (const [i, j] of DEBUG_BOX_EDGES) {
      a.set(cx[i]!, cy[i]!, cz[i]!);
      b.set(cx[j]!, cy[j]!, cz[j]!);
      this.queueOverlayLine(a, b, color);
    }
    this.overlayBoxCount++;
  }

  /** Depth-test-free twin of `drawDebugLines` for the `debugBounds` boxes. */
  private drawOverlayLines(pass: GPURenderPassEncoder, colorFormat: GPUTextureFormat): void {
    const bytesPerVertex = 16;
    const size = alignUp(this.overlayLineCount * 2 * bytesPerVertex, 4);
    if (size > this.overlayBufferCapacity || !this.overlayBuffer) {
      this.overlayBuffer?.destroy();
      this.overlayBufferCapacity = Math.max(size, 4096);
      this.overlayBuffer = this.device.device.createBuffer({ label: "debug.bounds", size: this.overlayBufferCapacity, usage: BufferUsage.VERTEX | BufferUsage.COPY_DST });
    }
    this.device.device.queue.writeBuffer(this.overlayBuffer, 0, gpuSource(this.overlayLines.subarray(0, (size / 4) | 0)));
    // `noDepthTest` keeps the pass's depth attachment (a pipeline without depth state is invalid in
    // a pass that has one) but compares "always", so the boxes draw through terrain, haze and
    // meshes — they mark where geometry is, not where it happens to be visible.
    const pipeline = this.pipelines.get({ technique: "debug", colorFormat, depthFormat: this.device.depthFormat, transparent: true, doubleSided: true, instanced: false, noDepthTest: true });
    pass.setPipeline(pipeline.pipeline);
    pass.setVertexBuffer(0, this.overlayBuffer);
    pass.draw(this.overlayLineCount * 2);
    this.stats.debugBounds = this.overlayBoxCount;
    this.overlayLineCount = 0;
    this.overlayBoxCount = 0;
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

  /**
   * What the last cluster build did, or `null` when clustering did not run this frame. Richer than
   * the `stats` counters (it carries the slice span and the cap that was actually applied), for HUDs
   * and tests.
   */
  get clusterBuildInfo(): ClusterBuildResult | null {
    return this.clusterBuild;
  }

  dispose(): void {
    this.deviceLostUnsub?.dispose();
    this.deviceLostUnsub = null;
    for (const b of [this.frameBuffer, this.lightBuffer, this.clusterBuffer, this.clusterLightBuffer, this.clusterGridBuffer, this.shadowBuffer, this.cascadeBuffer, this.postBuffer, this.skyBuffer, this.cloudBuffer, this.waterBuffer, this.ssaoBuffer, this.objectBuffer, this.instanceBuffer, this.debugBuffer, this.overlayBuffer]) b?.destroy();
    this.frameBuffer = null;
    this.lightBuffer = null;
    this.clusterBuffer = null;
    this.clusterLightBuffer = null;
    this.clusterGridBuffer = null;
    this.shadowBuffer = null;
    this.cascadeBuffer = null;
    this.postBuffer = null;
    this.skyBuffer = null;
    this.cloudBuffer = null;
    this.waterBuffer = null;
    this.ssaoBuffer = null;
    this.skyBindGroup = null;
    this.waterBindGroup = null;
    this.prepassBindGroup = null;
    this.ssaoGroup = null;
    this.ssaoGroupView = null;
    this.ssaoBlurGroups.clear();
    this.aoFallback?.destroy();
    this.aoFallback = null;
    this.aoFallbackView = null;
    this.objectBuffer = null;
    this.instanceBuffer = null;
    this.debugBuffer = null;
    this.overlayBuffer = null;
    this.objectBufferCapacity = 0;
    this.instanceBufferCapacity = 0;
    this.shadowFallback?.destroy();
    this.shadowFallback = null;
    this.shadowFallbackView = null;
    this.frameBindGroup = null;
    this.frameBindGroupView = null;
    this.frameBindGroupAoView = null;
    this.cascadeBindGroup = null;
    this.drawBindGroup = null;
    this.postGroups.clear();
    this.graph.dispose();
    this.pipelines.invalidate();
    this.defaults.dispose();
  }
}

/**
 * Surfaces the depth prepass may lay down: opaque, depth-tested, drawn by the standard program, and
 * never discarding a fragment the prepass would keep (no cutout, full opacity). Everything else —
 * transparent and overlay draws, water, fading materials — is drawn by `forge.main` exactly as
 * without a prepass, depth writes included.
 */
function isPrepassEligible(b: Batch): boolean {
  const m = b.material;
  return !b.shadowOnly && !b.transparent && !b.overlay && b.geometry.vertexBuffer !== null && m.technique !== "water" && !m.transparent && !(m.alphaTest > 0) && m.opacity >= 0.999;
}

/** Prepass pipeline variant: instancing × culling (four pipelines at most). */
function prepassState(b: Batch): number {
  return (b.count > 1 ? 1 : 0) | (b.material.doubleSided ? 2 : 0);
}

/** Fewest pipeline switches first, then front to back (`depthSort` is −distance², so larger is nearer). */
function prepassOrder(a: Batch, b: Batch): number {
  return prepassState(a) - prepassState(b) || b.depthSort - a.depthSort;
}

/** One sky field: the per-frame override wins when it is set (`null` is a valid override value). */
function pickSky<K extends keyof SceneSkySettings>(base: SceneSkySettings, override: Partial<SceneSkySettings> | null, key: K): SceneSkySettings[K] {
  const v = override?.[key];
  return (v === undefined ? base[key] : v) as SceneSkySettings[K];
}

const SKY_TIER_RANK: Record<SkyQuality, number> = { low: 0, medium: 1, high: 2 };

/** The lower of the scene's requested sky tier and the quality profile's cap. */
function capSkyQuality(requested: SkyQuality, cap: SkyQuality | undefined): SkyQuality {
  const wanted = SKY_TIER_RANK[requested] === undefined ? "medium" : requested;
  if (!cap || SKY_TIER_RANK[cap] === undefined) return wanted;
  return SKY_TIER_RANK[cap] < SKY_TIER_RANK[wanted] ? cap : wanted;
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
