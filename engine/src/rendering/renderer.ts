/**
 * `Renderer` — one frame in, one frame out.
 *
 * Frame structure (docs/RENDERING.md §1):
 *   1. camera resolution: pick the highest-priority enabled `Camera`, compose view/projection from
 *      its entity's world matrix, and publish them back onto the component (culling, audio and
 *      picking all read the same numbers — never a second copy).
 *   2. shadow fit: split the camera frustum for directional cascades, fit bounded perspective
 *      spot maps and six-face point cube maps (`rendering/shadows.ts`). Pure math; nothing
 *      GPU-side happens yet.
 *   3. batch assembly: Renderables grouped by (geometry, material pipeline key, transparency, caster
 *      flags), each batch writing its instance matrices into a per-frame arena. Draw cost is
 *      therefore `setBindGroup(dynamic offsets) + drawIndexed`, with no per-draw object creation.
 *      Off-screen shadow casters that still fall inside a cascade, spot or point frustum land in shadow-only batches.
 *   4. uniform upload: one `writeBuffer` each for the frame block, lights, shadow block, shadow-pass
 *      view-projections, sky block (when the sky is on), post parameters and the two draw arenas.
 *   5. frame description: the passes are declared on the `RenderGraph` — `forge.shadow.<n>` per
 *      cascade, `forge.shadow.spot.<n>` per spot map and `forge.shadow.point.<n>.<face>` per point
 *      cube face into a depth array, `forge.prepass` laying the opaque depth down, the half-resolution
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
import { PerFrameUniforms, LightBlock, ShadowUniforms, ShadowPassUniforms, ObjectUniforms, InstanceStruct, PostUniforms, SkyUniforms, CloudUniforms, WaterUniforms, SsaoUniforms, ClusterUniforms, ClusterLightBlock, ClusterGridBlock, MAX_LIGHTS_PER_FRAME, MAX_CASCADES, MAX_SPOT_SHADOWS, MAX_POINT_SHADOWS, POINT_SHADOW_FACES, MAX_SHADOW_LAYERS, MAX_CULLED_BATCHES } from "./uniforms.js";
import { ClusterGrid, CLUSTER_TILES_X, CLUSTER_TILES_Y, CLUSTER_SLICES, CLUSTER_INDEX_CAPACITY, MAX_CLUSTERED_LIGHTS, MAX_LIGHTS_PER_CLUSTER, type ClusterBuildResult, type ClusterLightSource, type ClusterRanges } from "./clusters.js";
import { GpuLightCuller } from "./lightCulling.js";
import {
  CULL_FLAG_DISTANCE,
  CULL_FLAG_FRUSTUM,
  CULL_FLAG_RECORDS,
  DRAW_RECORD_BYTES,
  DRAW_RECORD_WORDS,
  GpuObjectCuller,
  cullBatchesOnCpu,
  hizLevelCount,
} from "./objectCulling.js";
import type { ObjectCullParams } from "./objectCulling.js";
import { POST_BINDINGS, POST_FLAG_BLOOM, POST_FLAG_KARIS } from "./shaders/post.js";
import { SSAO_BINDINGS } from "./shaders/ssao.js";
import { RenderGraph, type GpuPassTime, type GpuTimingFrame, type RenderGraphHandle, type RenderGraphPassContext, type RenderGraphStats } from "./renderGraph.js";
import { computeCascades, computeSpotShadow, computePointShadow, createPointShadowFaces, type Cascade, type SpotShadowFit, type PointShadowFit } from "./shadows.js";
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
  /** Shared shadow-map resolution cap for every cascade and spot layer; the scene asks, the profile caps. */
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
  /**
   * Which half of the cluster grid build runs on the GPU (Phase 13.4). `"auto"` (the default) uses
   * the compute fill whenever the device can execute it — the range pass and the counting pass stay
   * on the CPU either way, because the fragment stage's list lengths and everything `stats` reports
   * about the grid have to be exact and immediate, and the counting pass is coverage-independent.
   * `"cpu"` forces the reference fill, which is what the mock device and the A/B in
   * `tools/browser-check.mjs` use; `"gpu"` forces the compute fill even on the mock (which records
   * and validates the pass without executing it).
   */
  lightCulling?: "auto" | "cpu" | "gpu";
  /**
   * Where the frame's batch visibility is decided (Phase 13.5, `rendering/objectCulling.ts`).
   * `"auto"` (the default) runs `forge.objects.cull` on the device and falls back to the CPU twin on
   * the mock device; `"cpu"` forces the twin, `"gpu"` the compute pass. Both paths write the same
   * visibility buffer the vertex stage of `forge.main` reads, so the switch changes no pixel — it
   * changes who does the arithmetic. The CPU twin has no depth buffer to test against, so batch
   * occlusion is a GPU-only test (see `occlusionCulling`).
   */
  objectCulling?: "auto" | "cpu" | "gpu";
  /**
   * `false` skips the HiZ occlusion stage of the object culler: batches are still tested against the
   * frustum and their distance limits, nothing is tested against the prepass depth. Needs the depth
   * prepass (the pyramid is built from its depth), a perspective camera (the test projects into the
   * depth buffer's pixels) and a render target the pyramid can shrink into.
   */
  occlusionCulling?: boolean;
  /**
   * Compile render-pipeline cache misses without waiting in the render loop. Defaults on for real
   * GPUs; mock frames stay synchronous unless explicitly enabled.
   */
  asyncPipelines?: boolean;
  /** Collect asynchronous GPU timestamp samples when the device supports timestamp-query. */
  gpuTimestamps?: boolean;
  /**
   * Submit `forge.main`'s draws through the culler's own indirect records (Phase 13.6), one per batch,
   * whose instance count the cull pass writes (0 for a culled batch). Default `true`.
   *
   * This is the other half of the cull: Phase 13.5 collapsed a culled batch's clip position, which
   * still paid the vertex stage for every instance of it, and only worked for the techniques whose
   * vertex entry point reads the visibility word. A zero-instance record is a draw the device skips
   * outright, whatever shades it. The frame uploads the records' static words (the batch's index
   * window, which only the CPU knows) and the pass overwrites the one word that is a decision.
   *
   * `false` keeps the direct path: same verdicts, same picture, `setBindGroup` + `drawIndexed` per
   * batch, and the visibility word doing the culling in the vertex stage. It exists to be A/B'd
   * against the records on a real device, which is how `check:browser` proves the two agree.
   */
  indirectDraws?: boolean;
  /** Maximum instanced draws before splitting into a second batch (driver-friendly cap). */
  maxInstancesPerBatch?: number;
}

export interface RenderStats {
  drawCalls: number;
  triangles: number;
  instances: number;
  batches: number;
  culled: number;
  /** Batches the object culler tested this frame (frustum/distance/HiZ), of `batches`. */
  cullTested: number;
  /** Batches it culled as outside the camera frustum (includes the off-screen-rectangle case). */
  cullFrustum: number;
  /** Batches it culled past their `Renderable.maxDistance` limit (or the batch's merged limit). */
  cullDistance: number;
  /** Batches it culled as occluded by the prepass depth (HiZ); always 0 on the CPU path. */
  cullOccluded: number;
  /** Batches the culler kept: the length of its compaction list, of `cullTested`. */
  cullVisible: number;
  /** Batches whose indirect draw record was zeroed; 0 when the frame submits direct draws. */
  cullRecordZeroed: number;
  /** `forge.main` draws submitted through the culler's indirect records this frame. */
  indirectDraws: number;
  /** Draw calls issued by all directional cascade, spot and point-cube shadow passes. */
  shadowsDrawn: number;
  /** Batch × shadow-map pairs with no assigned caster instances. */
  shadowsCulled: number;
  /** Caster instances submitted across shadow maps (one instance may contribute to multiple maps). */
  shadowInstancesDrawn: number;
  /** Caster-instance/map pairs omitted by per-object shadow-frustum assignment. */
  shadowInstancesCulled: number;
  /** Directional cascade maps active this frame. */
  shadowCascades: number;
  /** Spot-light shadow maps active this frame (maximum {@link MAX_SPOT_SHADOWS}). */
  spotShadowMaps: number;
  /** Point-light shadow cubes active this frame (maximum {@link MAX_POINT_SHADOWS}); each is six atlas layers. */
  pointShadowMaps: number;
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
  /**
   * Which rasteriser wrote this frame's cluster lists: `"none"` when clustering did not run, `"cpu"`
   * for `rendering/clusters.ts`'s fill, `"gpu"` for the compute fill in `rendering/lightCulling.ts`.
   */
  clusterFill: "none" | "cpu" | "gpu";
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
  /** Whether GPU timestamps were requested and the adapter supports them. */
  gpuTimingAvailable: boolean;
  /** Latest completed query sample: first timed pass start through last timed pass end, in milliseconds. */
  gpuFrameTimeMs: number;
  gpuRenderTimeMs: number;
  gpuComputeTimeMs: number;
  gpuPassTimes: readonly GpuPassTime[];
  gpuTimingSkippedFrames: number;
  gpuTimingDroppedPasses: number;
  /** Unique render-pipeline keys still compiling asynchronously. */
  pipelinesPending: number;
  /** Render pipelines whose async compilation failed; each failed key is latched until invalidation. */
  pipelineFailures: number;
}

/** Mask-bit base of the point lights' cube faces (cascades 0..3, spots 4..7, then six bits per point light). */
const POINT_MASK_BASE = MAX_CASCADES + MAX_SPOT_SHADOWS;

interface ShadowInstanceRange {
  /** First instance relative to this batch's dynamic storage-buffer offset. */
  firstInstance: number;
  instanceCount: number;
  /** Bits 0..MAX_CASCADES-1 are cascades, the next MAX_SPOT_SHADOWS bits spot slots, then six face bits per point light. */
  shadowMask: number;
}

interface SpotShadowState extends SpotShadowFit {
  readonly frustum: Frustum;
  readonly position: Vec3;
  light: Light | null;
}

interface PointShadowState extends PointShadowFit {
  /** One light-space frustum per cube face (conservative caster assignment). */
  readonly frustums: Frustum[];
  readonly position: Vec3;
  light: Light | null;
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
  /** This batch's index in the cull pass's arrays: its visibility word and its draw record. */
  cullIndex: number;
  /** `Renderable.maxDistance` union over the batch (0 = no limit); the culler's distance test. */
  maxDistance: number;
  /** Render-local union of the instances' bounds (object culling). */
  readonly bounds: AABB;
  /** Contiguous per-object ranges grouped by conservative cascade mask for shadow submissions. */
  readonly shadowRanges: ShadowInstanceRange[];
  /** Live prefix of `shadowRanges`; backing range objects are reused on subsequent frames. */
  shadowRangeCount: number;
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
const CLUSTER_COUNTS_FIELD = ClusterGridBlock.field("counts", "storage");
const CLUSTER_INDICES_FIELD = ClusterGridBlock.field("indices", "storage");

/** Sun direction when neither the sky settings nor a directional light provide one. */
const DEFAULT_SUN = new Vec3(0.3, 0.8, 0.5).normalize();

function clampConeCos(value: number, fallback: number): number {
  return Math.max(-1, Math.min(1, Number.isFinite(value) ? value : fallback));
}

/** Wider normalized spot cosine, kept in step with the interval uploaded to the shading shader. */
function spotOuterConeCos(light: Light): number {
  let innerCos = clampConeCos(light.innerCone, 0.85);
  let outerCos = clampConeCos(light.outerCone, 0.6);
  if (innerCos < outerCos) {
    const swap = innerCos;
    innerCos = outerCos;
    outerCos = swap;
  }
  if (innerCos - outerCos < 1e-5) outerCos = Math.max(-1, outerCos - 1e-4);
  return outerCos;
}
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
    cullTested: 0,
    cullFrustum: 0,
    cullDistance: 0,
    cullOccluded: 0,
    cullVisible: 0,
    cullRecordZeroed: 0,
    indirectDraws: 0,
    shadowsDrawn: 0,
    shadowsCulled: 0,
    shadowInstancesDrawn: 0,
    shadowInstancesCulled: 0,
    shadowCascades: 0,
    spotShadowMaps: 0,
    pointShadowMaps: 0,
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
    clusterFill: "none",
    passes: 0,
    culledPasses: 0,
    transientTextures: 0,
    physicalTextures: 0,
    transientBytes: 0,
    pooledBytes: 0,
    aliasedBytes: 0,
    texturesCreated: 0,
    gpuTimingAvailable: false,
    gpuFrameTimeMs: 0,
    gpuRenderTimeMs: 0,
    gpuComputeTimeMs: 0,
    gpuPassTimes: [],
    gpuTimingSkippedFrames: 0,
    gpuTimingDroppedPasses: 0,
    pipelinesPending: 0,
    pipelineFailures: 0,
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
  private readonly cascadeBytes = new WriteBuffer(MAX_SHADOW_LAYERS * UNIFORM_SLOT);
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
  /** This frame's prepared ranges, when clustering ran (`null` otherwise): the GPU fill's input. */
  private clusterRanges: ClusterRanges | null = null;
  /** Which half of the fill runs on the GPU; `auto` is resolved once, at construction. */
  private cullingMode: "cpu" | "gpu";
  private objectCullingMode: "cpu" | "gpu";
  /** HiZ occlusion inside the object culler: a per-frame decision, so flipping it is a data change. */
  private occlusionCullingEnabled: boolean;
  /** The device half of Phase 13.5; null until a frame needs it (and after `dispose`). */
  private objectCuller: GpuObjectCuller | null = null;
  /** One u32 per drawn batch: 0 = draw, `CullReason` otherwise. Bound as the draw group's binding 2. */
  private visibilityBuffer: GPUBuffer | null = null;
  private visibilityBytes = 0;
  private visibilityWords = new Uint32Array(0);
  /**
   * The frame's indirect draw records, one 32-byte slot per batch (Phase 13.6). The renderer owns the
   * staging words and the buffer: it is the half that knows each batch's index window, and the draw
   * loop is the half that binds them.
   */
  private indirectDrawsEnabled: boolean;
  private drawRecords: GPUBuffer | null = null;
  private drawRecordBytes = 0;
  private drawRecordWords = new Uint32Array(0);
  /**
   * The culler's compaction list: one slot per visible batch, at most `MAX_CULLED_BATCHES` of them, so
   * this one is fixed-size. The CPU twin fills the staging array when it decides the frame (the device
   * pass fills the buffer directly), which is what makes the list assertable on the mock.
   */
  private visibleList: { buffer: GPUBuffer; words: Uint32Array } | null = null;
  /** `ObjectBatchEntry` data: 8 floats per batch (`min.xyz`, distance limit, `max.xyz`, count). */
  private cullBounds = new Float32Array(0);
  /** True when this frame's cull pass gets a depth pyramid to test against. */
  private cullOcclusion = false;
  /** The compute fill's resources, created on the first frame that uses it. */
  private lightCuller: GpuLightCuller | null = null;
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
  /** OR of all per-object shadow-map assignments this frame; avoids an atlas when no map has casters. */
  private shadowCasterMask = 0;

  // Shadows.
  private readonly cascades: Cascade[] = [];
  private readonly cascadeFrustums: Frustum[] = [new Frustum(), new Frustum(), new Frustum(), new Frustum()];
  private readonly spotShadows: SpotShadowState[] = Array.from({ length: MAX_SPOT_SHADOWS }, () => ({
    viewProj: new Mat4(),
    fovY: 0,
    near: 0,
    far: 0,
    texelSize: 0,
    worldTexelScale: 0,
    frustum: new Frustum(),
    position: new Vec3(),
    light: null,
  }));
  private readonly spotShadowIndices = new Map<Light, number>();
  private readonly pointShadows: PointShadowState[] = Array.from({ length: MAX_POINT_SHADOWS }, () => ({
    faces: createPointShadowFaces(),
    frustums: Array.from({ length: POINT_SHADOW_FACES }, () => new Frustum()),
    near: 0,
    far: 0,
    texelSize: 0,
    worldTexelScale: 0,
    position: new Vec3(),
    light: null,
  }));
  private readonly pointShadowIndices = new Map<Light, number>();
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
    this.pipelines = new PipelineFactory(device, { asyncCompilation: options.asyncPipelines ?? !device.isMock });
    this.graph = new RenderGraph(device, { gpuTimestamps: options.gpuTimestamps ?? false });
    this.stats.gpuTimingAvailable = this.graph.stats.gpuTimingAvailable;
    // The mock device validates and records compute passes but cannot execute WGSL, so an
    // unqualified "auto" stays on the CPU there: the grid is a shader input, and a grid nothing
    // wrote is worse than a grid the CPU wrote.
    const mode = options.lightCulling ?? "auto";
    this.cullingMode = mode === "auto" ? (device.isMock ? "cpu" : "gpu") : mode;
    // Same reasoning for batch visibility: the mock validates the cull pass but cannot execute it,
    // and a visibility buffer the pass never wrote would draw the frame's culled batches as if the
    // culler had said no. `"auto"` therefore means the twin on a mock device.
    const objectMode = options.objectCulling ?? "auto";
    this.objectCullingMode = objectMode === "auto" ? (device.isMock ? "cpu" : "gpu") : objectMode;
    this.occlusionCullingEnabled = options.occlusionCulling !== false;
    this.indirectDrawsEnabled = options.indirectDraws !== false;
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

  /**
   * Which half of the cluster grid build runs on the GPU; `"auto"` resolves once against the device
   * (the mock cannot execute compute). Switching is safe at any point: both fills write the same
   * counts, the same lists in the same order, so a frame filled on the CPU and the next one filled
   * on the GPU describe the same grid.
   *
   * Switching to `"cpu"` releases the culler's device resources, and dropping the reference with them
   * is load-bearing: `GpuLightCuller.record` returns immediately once disposed, so a culler kept in
   * the field after its dispose would silently stop adding `forge.lights.assign` to the frame — the
   * grid would never be refilled, and the fragment stage would read whatever index blocks the last
   * upload happened to leave on the device (a grid that describes some *other* frame's lights). The
   * `??=` in `recordLightFill` is what makes a fresh culler after a round trip; it can only do that
   * if the disposed one is gone.
   */
  get lightCulling(): "cpu" | "gpu" {
    return this.cullingMode;
  }

  set lightCulling(mode: "auto" | "cpu" | "gpu") {
    const resolved = mode === "auto" ? (this.device.isMock ? "cpu" : "gpu") : mode;
    if (resolved === this.cullingMode) return;
    this.cullingMode = resolved;
    if (resolved === "cpu") {
      this.lightCuller?.dispose();
      this.lightCuller = null;
    }
    this.invalidate();
  }

  /**
   * Which side decides batch visibility (Phase 13.5). Public for the same reason `lightCulling` is:
   * the demo and the browser gate flip it to A/B the two paths, and the disposal trap below is what
   * makes the flip safe — `??=` in `prepareObjectCulling` only rebuilds if the disposed one is gone.
   */
  get objectCulling(): "cpu" | "gpu" {
    return this.objectCullingMode;
  }

  set objectCulling(mode: "auto" | "cpu" | "gpu") {
    const resolved = mode === "auto" ? (this.device.isMock ? "cpu" : "gpu") : mode;
    if (resolved === this.objectCullingMode) return;
    this.objectCullingMode = resolved;
    if (resolved === "cpu") {
      this.objectCuller?.dispose();
      this.objectCuller = null;
    }
    this.invalidate();
  }

  /**
   * The HiZ stage of the object culler. Public so the demo and the browser gate can A/B it: the
   * verdict is conservative by construction, so switching it off may only ever *add* draws, never
   * change a pixel (check:browser asserts exactly that).
   */
  get occlusionCulling(): boolean {
    return this.occlusionCullingEnabled;
  }

  set occlusionCulling(on: boolean) {
    if (on === this.occlusionCullingEnabled) return;
    this.occlusionCullingEnabled = on;
    this.invalidate();
  }

  /**
   * Whether `forge.main`'s draws go through the culler's indirect records (Phase 13.6). Public for the
   * same reason the culler switch is: it changes how the frame is submitted, not what it looks like, so
   * the only way to pin that claim is to A/B the two submissions (`check:browser` does).
   */
  get indirectDraws(): boolean {
    return this.indirectDrawsEnabled;
  }

  set indirectDraws(on: boolean) {
    if (on === this.indirectDrawsEnabled) return;
    this.indirectDrawsEnabled = on;
    this.invalidate();
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
    const spotShadowCount = shadowsWanted ? this.prepareSpotShadows(scene, lights, shadowSize) : 0;
    const pointShadowCount = shadowsWanted ? this.preparePointShadows(scene, lights, shadowSize) : 0;
    if (!shadowsWanted) {
      this.spotShadowIndices.clear();
      this.pointShadowIndices.clear();
    }
    if (sun) {
      computeCascades(
        { world: this.cameraWorld, fovY: camera.fovY, aspect, near: camera.near, orthographic: camera.orthographic, orthoHeight: camera.orthoHeight },
        { count: cascadeCount, shadowDistance, lambda: settings.shadow.splitLambda, mapSize: shadowSize, lightDirection: sun.direction },
        this.cascades,
      );
      for (let c = 0; c < cascadeCount; c++) this.cascadeFrustums[c]!.setFromViewProjection(this.cascades[c]!.viewProj);
    }

    // 3. Batches, and which of them lay down depth in the prepass.
    this.collectBatches(scene, camera, cascadeCount, spotShadowCount, pointShadowCount);
    const shadowBits = (1 << cascadeCount) - 1;
    const spotBits = ((1 << spotShadowCount) - 1) << MAX_CASCADES;
    const pointBits = ((1 << (POINT_SHADOW_FACES * pointShadowCount)) - 1) << POINT_MASK_BASE;
    const activeCascadeCount = (this.shadowCasterMask & shadowBits) !== 0 ? cascadeCount : 0;
    const activeSpotCount = (this.shadowCasterMask & spotBits) !== 0 ? spotShadowCount : 0;
    const activePointCount = (this.shadowCasterMask & pointBits) !== 0 ? pointShadowCount : 0;
    const shadowsActive = activeCascadeCount > 0 || activeSpotCount > 0 || activePointCount > 0;
    this.stats.batches = this.batchCount;
    this.stats.shadowCascades = activeCascadeCount;
    this.stats.spotShadowMaps = activeSpotCount;
    this.stats.pointShadowMaps = activePointCount;
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
    this.writePerFrame(scene, renderWidth, renderHeight, shadowsActive, activeCascadeCount, underwater, ssao, clustered);
    if (ssao) this.writeSsao(ssaoSettings, renderWidth, renderHeight);
    this.writeLights(scene, lights, activeCascadeCount > 0 ? sun : null, activeSpotCount, activePointCount, clustered);
    if (clustered) this.buildClusters(camera, renderWidth, renderHeight);
    this.writeShadowUniforms(scene, sun, activeCascadeCount, activeSpotCount, activePointCount, shadowSize, shadowDistance);
    const skyEnabled = settings.skyEnabled && this.options.sky !== false;
    const skySettings = skyEnabled ? this.resolveSky(scene, lights) : null;
    if (skySettings) this.writeSky(skySettings);
    else this.pendingSky = null;
    this.writeClouds(scene, skySettings, lights);
    this.writeWater(scene, skySettings, lights);
    for (let i = 0; i < this.batchCount; i++) {
      const b = this.batchPool[i]!;
      b.objectOffset = this.reserveObject(b.count > 1 ? IDENTITY : this.lastMatrixFor(b), b.count, i);
    }
    this.ensureArenas();
    this.uploadArenas();
    this.prepareObjectCulling(camera, renderWidth, renderHeight, prepass);

    // 5. Frame description + execution.
    this.buildFrame(scene, {
      hdr,
      renderWidth,
      renderHeight,
      cascadeCount: activeCascadeCount,
      spotShadowCount: activeSpotCount,
      pointShadowCount: activePointCount,
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
    frame: { hdr: boolean; renderWidth: number; renderHeight: number; cascadeCount: number; spotShadowCount: number; pointShadowCount: number; shadowSize: number; bloom: boolean; sky: boolean; underwater: boolean; prepass: boolean; ssao: boolean },
  ): void {
    const swapTexture = this.device.currentTexture;
    if (!swapTexture) throw new UsageError("renderer: no swapchain texture (was the canvas configured?)");
    const g = this.graph;
    g.begin();
    this.postSlots = 0;
    // The grid's lists, before anything reads them (`forge.main`'s fragment stage does, and the
    // shadow passes do not). Compute rides the graph as a side-effect pass: no attachments, no
    // transient resources, and never dead-culled.
    this.recordLightFill(g);
    const swapchain = g.importTexture("swapchain", swapTexture);
    const clear = this.clearColorFor(scene, frame.hdr);

    // One depth array: directional cascades occupy its prefix, followed by the active spot maps and
    // the point lights' cube faces (six layers each, face order +x -x +y -y +z -z).
    let shadowAtlas: RenderGraphHandle | null = null;
    const shadowLayerCount = frame.cascadeCount + frame.spotShadowCount + frame.pointShadowCount * POINT_SHADOW_FACES;
    if (shadowLayerCount > 0) {
      shadowAtlas = g.createTexture("shadow.maps", {
        width: frame.shadowSize,
        height: frame.shadowSize,
        format: SHADOW_FORMAT,
        usage: TextureUsage.RENDER_ATTACHMENT | TextureUsage.TEXTURE_BINDING,
        depthOrArrayLayers: shadowLayerCount,
      });
      const atlas = shadowAtlas;
      for (let c = 0; c < frame.cascadeCount; c++) {
        g.addPass({
          name: `forge.shadow.${c}`,
          depth: { texture: atlas, view: { arrayLayer: c }, depthClearValue: 1 },
          execute: (ctx) => this.executeShadowPass(ctx, c, 1 << c),
        });
      }
      for (let s = 0; s < frame.spotShadowCount; s++) {
        const layer = frame.cascadeCount + s;
        g.addPass({
          name: `forge.shadow.spot.${s}`,
          depth: { texture: atlas, view: { arrayLayer: layer }, depthClearValue: 1 },
          execute: (ctx) => this.executeShadowPass(ctx, layer, 1 << (MAX_CASCADES + s)),
        });
      }
      for (let p = 0; p < frame.pointShadowCount; p++) {
        for (let face = 0; face < POINT_SHADOW_FACES; face++) {
          const layer = frame.cascadeCount + frame.spotShadowCount + p * POINT_SHADOW_FACES + face;
          g.addPass({
            name: `forge.shadow.point.${p}.${face}`,
            depth: { texture: atlas, view: { arrayLayer: layer }, depthClearValue: 1 },
            execute: (ctx) => this.executeShadowPass(ctx, layer, 1 << (POINT_MASK_BASE + p * POINT_SHADOW_FACES + face)),
          });
        }
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
      usage: TextureUsage.RENDER_ATTACHMENT | (wantGpuParticles || frame.ssao || this.cullOcclusion ? TextureUsage.TEXTURE_BINDING : 0),
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

    // Object culling (`forge.objects.cull`, plus the HiZ pyramid when occlusion is on): the only
    // place in the frame that may declare it. Before the prepass the depth does not exist; after
    // `forge.main` the verdict would arrive a pass too late to be consumed. Between them the batch
    // visibility is written, read by `forge.main`'s vertex stage through group 1 binding 2, and
    // reported through the culler's counters.
    if (this.objectCullingMode === "gpu" && this.batchCount > 0) {
      this.objectCuller ??= new GpuObjectCuller(this.device, this.pipelines.shaders);
      this.objectCuller.record(g, sceneDepth, this.visibilityBuffer!, this.drawRecords!, this.ensureVisibleList().buffer);
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
      // A pass whose pipeline is still compiling writes neutral visibility (white), so the next
      // pass can safely sample it and startup frames never inherit undefined pooled texture contents.
      const neutralAo = [1, 1, 0, 0] as const;
      g.addPass({ name: "forge.ssao", reads: [sceneDepth], color: [{ texture: raw, clearValue: neutralAo }], execute: (ctx) => this.executeSsaoPass(ctx, "fsSsao", sceneDepth) });
      g.addPass({ name: "forge.ssao.blur.h", reads: [raw], color: [{ texture: blurred, clearValue: neutralAo }], execute: (ctx) => this.executeSsaoPass(ctx, "fsBlurH", raw) });
      g.addPass({ name: "forge.ssao.blur.v", reads: [blurred], color: [{ texture: result, clearValue: neutralAo }], execute: (ctx) => this.executeSsaoPass(ctx, "fsBlurV", blurred) });
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
      const profiler = this.currentFrameContext?.profiler;
      const profilerFrameIndex = profiler?.currentFrameIndex;
      this.applyGraphStats(g.execute((timing) => this.applyGpuTiming(timing, profiler, profilerFrameIndex)));
      this.pollObjectCulling();
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
    const profiler = this.currentFrameContext?.profiler;
    const profilerFrameIndex = profiler?.currentFrameIndex;
    this.applyGraphStats(g.execute((timing) => this.applyGpuTiming(timing, profiler, profilerFrameIndex)));
    this.pollObjectCulling();
  }

  private executeSkyPass(ctx: RenderGraphPassContext, colorFormat: GPUTextureFormat): void {
    const pass = ctx.beginRenderPass();
    const bundle = this.pipelines.getReady({ technique: "sky", colorFormat, depthFormat: this.device.depthFormat, transparent: false, doubleSided: true, instanced: false, writeDepth: false });
    if (!bundle) {
      // Keep the graph attachment intact (the main pass's color is loaded) while compilation runs.
      pass.end();
      return;
    }
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

  private applyGraphStats(stats: RenderGraphStats): void {
    this.stats.passes = stats.passes;
    this.stats.culledPasses = stats.culledPasses;
    this.stats.transientTextures = stats.transientTextures;
    this.stats.physicalTextures = stats.physicalTextures;
    this.stats.transientBytes = stats.transientBytes;
    this.stats.pooledBytes = stats.pooledBytes;
    this.stats.aliasedBytes = stats.aliasedBytes;
    this.stats.texturesCreated = stats.texturesCreated;
    this.stats.gpuTimingAvailable = stats.gpuTimingAvailable;
    this.stats.gpuFrameTimeMs = stats.gpuFrameTimeMs;
    this.stats.gpuRenderTimeMs = stats.gpuRenderTimeMs;
    this.stats.gpuComputeTimeMs = stats.gpuComputeTimeMs;
    this.stats.gpuPassTimes = stats.gpuPassTimes;
    this.stats.gpuTimingSkippedFrames = stats.gpuTimingSkippedFrames;
    this.stats.gpuTimingDroppedPasses = stats.gpuTimingDroppedPasses;
  }

  private applyGpuTiming(timing: GpuTimingFrame, profiler?: SystemContext["profiler"], profilerFrameIndex?: number): void {
    this.stats.gpuFrameTimeMs = timing.frameTimeMs;
    this.stats.gpuRenderTimeMs = timing.renderTimeMs;
    this.stats.gpuComputeTimeMs = timing.computeTimeMs;
    this.stats.gpuPassTimes = timing.passes;
    profiler?.reportGpuTimes(timing.passes, timing.frameTimeMs, profilerFrameIndex);
  }

  private finishFrame(): void {
    this.currentFrameContext = null;
    this.invalidated = false;
    const pipelineStats = this.pipelines.stats();
    this.stats.pipelinesPending = pipelineStats.pipelinesPending;
    this.stats.pipelineFailures = pipelineStats.failures;
    this.lastUploadCount++;
  }

  // ------------------------------------------------------------------ pass bodies

  private executeShadowPass(ctx: RenderGraphPassContext, shadowLayer: number, shadowBit: number): void {
    this.syncGraphEpoch();
    const pass = ctx.beginRenderPass();
    pass.setBindGroup(0, this.cascadeBindGroup!, [shadowLayer * UNIFORM_SLOT]);
    let lastInstanced = -1;
    let currentPipeline: GPURenderPipeline | null = null;
    for (let i = 0; i < this.batchCount; i++) {
      const b = this.batchPool[i]!;
      if (!b.castShadow || b.overlay || b.transparent) continue;
      if (!b.geometry.vertexBuffer) continue;
      let assignedInstances = 0;
      for (let rangeIndex = 0; rangeIndex < b.shadowRangeCount; rangeIndex++) {
        const range = b.shadowRanges[rangeIndex]!;
        if ((range.shadowMask & shadowBit) !== 0) assignedInstances += range.instanceCount;
      }
      if (assignedInstances === 0) {
        this.stats.shadowsCulled++;
        this.stats.shadowInstancesCulled += b.count;
        continue;
      }
      this.stats.shadowInstancesCulled += b.count - assignedInstances;
      const instanced = b.count > 1 ? 1 : 0;
      if (instanced !== lastInstanced) {
        lastInstanced = instanced;
        currentPipeline = this.pipelines.getReady({ technique: "depth", colorFormat: null, depthFormat: SHADOW_FORMAT, transparent: false, doubleSided: false, instanced: instanced === 1 })?.pipeline ?? null;
        if (currentPipeline) pass.setPipeline(currentPipeline);
      }
      if (!currentPipeline) continue;
      pass.setBindGroup(1, this.drawBindGroup!, [b.objectOffset, b.instanceOffset]);
      pass.setVertexBuffer(0, b.geometry.vertexBuffer);
      if (b.geometry.indexBuffer) pass.setIndexBuffer(b.geometry.indexBuffer, b.geometry.indexFormat!);
      for (let rangeIndex = 0; rangeIndex < b.shadowRangeCount; rangeIndex++) {
        const range = b.shadowRanges[rangeIndex]!;
        if ((range.shadowMask & shadowBit) === 0) continue;
        if (b.geometry.indexBuffer) {
          pass.drawIndexed(b.indexCount, range.instanceCount, b.indexStart, 0, range.firstInstance);
        } else {
          pass.draw(b.indexCount, range.instanceCount, 0, range.firstInstance);
        }
        this.stats.shadowsDrawn++;
        this.stats.shadowInstancesDrawn += range.instanceCount;
      }
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
    let currentPipeline: GPURenderPipeline | null = null;
    const list = this.prepassBatches;
    for (let i = 0; i < list.length; i++) {
      const b = list[i]!;
      const state = prepassState(b);
      if (state !== lastState) {
        lastState = state;
        currentPipeline = this.pipelines.getReady({ technique: "prepass", colorFormat: null, depthFormat, transparent: false, doubleSided: b.material.doubleSided, instanced: b.count > 1 })?.pipeline ?? null;
        if (currentPipeline) pass.setPipeline(currentPipeline);
      }
      if (!currentPipeline) continue;
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
    const pipeline = this.pipelines.getReady({ technique: "ssao", colorFormat: SSAO_FORMAT, depthFormat: null, transparent: false, doubleSided: true, instanced: false, fragmentEntry: entry });
    const pass = ctx.beginRenderPass();
    if (!pipeline) {
      // The graph attachment was cleared to neutral white; leave it that way until this variant is ready.
      pass.end();
      return;
    }
    const group = entry === "fsSsao" ? this.ensureSsaoGroup(ctx.view(source, { aspect: "depth-only" })) : this.ensureSsaoBlurGroup(ctx.view(source));
    pass.setPipeline(pipeline.pipeline);
    pass.setBindGroup(0, group);
    pass.draw(3);
    this.stats.drawCalls++;
    pass.end();
  }

  private executeMainPass(ctx: RenderGraphPassContext, colorFormat: GPUTextureFormat, shadowAtlas: RenderGraphHandle | null, ao: RenderGraphHandle | null): void {
    this.syncGraphEpoch();
    // The culler's records when the frame submits through them (Phase 13.6): the verdict is a word in
    // the record the device reads, so a culled batch's draw runs nothing at all.
    const records = this.indirectDrawsEnabled ? this.drawRecords : null;
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
      // An opaque batch whose prepass variant is still compiling must use a depth-writing forward
      // variant this frame; otherwise a missing prepass would leave later opaque geometry unoccluded.
      const prepassReady = b.prepass && this.pipelines.getReady({
        technique: "prepass",
        colorFormat: null,
        depthFormat: this.device.depthFormat,
        transparent: false,
        doubleSided: b.material.doubleSided,
        instanced: b.count > 1,
      }) !== null;
      const mainPipelineOptions = {
        technique: isWater ? "water" as const : b.material.technique === "unlit" ? "unlit" as const : "standard" as const,
        colorFormat,
        depthFormat: this.device.depthFormat,
        transparent: b.transparent,
        doubleSided: b.material.doubleSided,
        instanced: b.count > 1,
      };
      // Prepassed surfaces use a no-write forward variant once that pipeline is ready. If this
      // variant is still compiling, the depth-writing forward variant remains correct at equal depth
      // and avoids a one-frame hole when the prepass finishes first.
      let pipeline = this.pipelines.getReady({ ...mainPipelineOptions, writeDepth: !prepassReady });
      if (!pipeline && prepassReady) pipeline = this.pipelines.getReady({ ...mainPipelineOptions, writeDepth: true });
      if (!pipeline) continue;
      pass.setPipeline(pipeline.pipeline);
      pass.setBindGroup(1, this.drawBindGroup!, [b.objectOffset, b.instanceOffset]);
      pass.setBindGroup(2, isWater ? this.ensureWaterBindGroup() : this.ensureMaterialGroup(b.material));
      pass.setVertexBuffer(0, b.geometry.vertexBuffer!);
      if (b.geometry.indexBuffer) {
        pass.setIndexBuffer(b.geometry.indexBuffer, b.geometry.indexFormat!);
        if (records) {
          pass.drawIndexedIndirect(records, b.cullIndex * DRAW_RECORD_BYTES);
          this.stats.indirectDraws++;
        } else {
          pass.drawIndexed(b.indexCount, b.count, b.indexStart);
        }
      } else if (records) {
        pass.drawIndirect(records, b.cullIndex * DRAW_RECORD_BYTES);
        this.stats.indirectDraws++;
      } else {
        pass.draw(b.indexCount, b.count);
      }
      this.stats.drawCalls++;
      // Submitted, not executed: a culled batch still *issues* its draw here, with a record that says
      // zero instances (the device's own visible count is `stats.cullVisible`, one frame late).
      this.stats.triangles += (b.indexCount / 3) * Math.max(1, b.count);
      this.stats.instances += b.count;
    }
    if (this.debugLineCount > 0) this.drawDebugLines(pass, colorFormat);
    if (this.overlayLineCount > 0) this.drawOverlayLines(pass, colorFormat);
    pass.end();
  }

  private executePostPass(ctx: RenderGraphPassContext, entry: PostEntryPoint, slot: number, source: RenderGraphHandle, second: RenderGraphHandle, additive: boolean): void {
    this.syncGraphEpoch();
    const pipeline = this.pipelines.getReady({
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
    if (!pipeline) {
      // Keep this output deterministic (clear or retain its loaded destination) until compilation finishes.
      pass.end();
      return;
    }
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
    s.shadowInstancesDrawn = 0;
    s.shadowInstancesCulled = 0;
    s.shadowCascades = 0;
    s.spotShadowMaps = 0;
    s.pointShadowMaps = 0;
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
    s.indirectDraws = 0;
    s.ssao = false;
    s.clusteredLighting = false;
    s.lights = 0;
    s.clusteredLights = 0;
    s.clustersUsed = 0;
    s.clusterIndices = 0;
    s.maxLightsPerCluster = 0;
    s.lightsDropped = false;
    s.clusterFill = "none";
    s.passes = 0;
    s.culledPasses = 0;
    s.transientTextures = 0;
    s.physicalTextures = 0;
    s.aliasedBytes = 0;
    s.texturesCreated = 0;
    s.gpuTimingAvailable = this.graph.stats.gpuTimingAvailable;
    s.gpuFrameTimeMs = this.graph.stats.gpuFrameTimeMs;
    s.gpuRenderTimeMs = this.graph.stats.gpuRenderTimeMs;
    s.gpuComputeTimeMs = this.graph.stats.gpuComputeTimeMs;
    s.gpuPassTimes = this.graph.stats.gpuPassTimes;
    s.gpuTimingSkippedFrames = this.graph.stats.gpuTimingSkippedFrames;
    s.gpuTimingDroppedPasses = this.graph.stats.gpuTimingDroppedPasses;
    const pipelineStats = this.pipelines.stats();
    s.pipelinesPending = pipelineStats.pipelinesPending;
    s.pipelineFailures = pipelineStats.failures;
    this.instanceCount = 0;
    this.clusterBuild = null;
    this.clusterRanges = null;
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

  private writePerFrame(scene: Scene, renderWidth: number, renderHeight: number, shadowsActive: boolean, cascadeCount: number, underwater = false, ssao = false, clustered = false): void {
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
    a.setI32("cascadeCount", cascadeCount);
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
   * cluster grid references. Spot and point shadow indices are preserved in either destination, so
   * the shared light-contribution path samples the same map in clustered and unclustered frames.
   */
  private writeLights(scene: Scene, lights: Light[], caster: Light | null, spotShadowCount: number, pointShadowCount: number, clustered: boolean): void {
    const a = this.lightAccessor;
    let globals = 0;
    let locals = 0;
    let shadowedGlobals = 0;
    let truncated = false;
    for (const l of lights) {
      const pos = scene.world.worldPosition(l.entity, this.scratchVec);
      const spotIndex = this.spotShadowIndices.get(l);
      const spotShadowIndex = l.kind === "spot" && spotIndex !== undefined && spotIndex < spotShadowCount ? spotIndex : -1;
      const pointIndex = this.pointShadowIndices.get(l);
      const pointShadowIndex = l.kind === "point" && pointIndex !== undefined && pointIndex < pointShadowCount ? pointIndex : -1;
      if (l.kind === "directional" || !clustered) {
        if (globals >= MAX_LIGHTS_PER_FRAME) {
          truncated = true; // the uniform block is full: this light does not reach the shader at all
          continue;
        }
        const kind = l.kind === "directional" ? 0 : l.kind === "point" ? 1 : 2;
        // The shader tells spot and point slots apart by the light's kind, so the two families
        // number their slots independently from zero.
        const shadowIndex = l === caster ? 0 : spotShadowIndex >= 0 ? spotShadowIndex : pointShadowIndex;
        this.writeLightRecord(a.element("lights", globals) as StructAccessor, l, pos.x, pos.y, pos.z, kind, shadowIndex);
        if (shadowIndex >= 0) shadowedGlobals++;
        globals++;
      } else {
        if (locals >= MAX_CLUSTERED_LIGHTS) {
          truncated = true;
          continue;
        }
        // An assigned spot or point keeps its map slot even in the cluster block.
        this.writeLightRecord(this.clusterLightAccessor.element("lights", locals) as StructAccessor, l, pos.x, pos.y, pos.z, l.kind === "point" ? 1 : 2, spotShadowIndex >= 0 ? spotShadowIndex : pointShadowIndex);
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
        slot.outerCone = spotOuterConeCos(l);
        slot.intensity = l.intensity;
        // Rec.709 luma of the linear colour: the other half of the rank the grid evicts by.
        slot.colorLuma = 0.2126 * l.color.x + 0.7152 * l.color.y + 0.0722 * l.color.z;
        locals++;
      }
    }
    a.setI32("count", globals);
    a.setI32("shadowedCount", shadowedGlobals);
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
    let innerCos = clampConeCos(l.innerCone, 0.85);
    let outerCos = clampConeCos(l.outerCone, 0.6);
    if (innerCos < outerCos) {
      const swap = innerCos;
      innerCos = outerCos;
      outerCos = swap;
    }
    if (innerCos - outerCos < 1e-5) {
      innerCos = Math.min(1, innerCos + 1e-4);
      outerCos = Math.max(-1, outerCos - 1e-4);
    }
    e.setVec2("spotAngles", innerCos, outerCos);
    e.setI32("kind", kind);
    e.setI32("shadowIndex", shadowIndex);
  }

  /**
   * The quantisation the fragment stage looks its cluster up with. The GPU rasteriser
   * (`rendering/lightCulling.ts`) reads the same block, so both paths quantise identically by
   * construction: `sliceScale` comes from the range pass's own slice span, never from the camera's
   * far plane.
   */
  private writeClusterUniforms(build: ClusterBuildResult, locals: number, near: number, renderWidth: number, renderHeight: number): void {
    const a = this.clusterAccessor;
    a.setVec2("invExtent", 1 / Math.max(1, renderWidth), 1 / Math.max(1, renderHeight));
    a.setVec2("gridScale", CLUSTER_TILES_X, CLUSTER_TILES_Y);
    a.setF32("near", near);
    a.setF32("logNear", Math.log(near));
    a.setF32("sliceScale", CLUSTER_SLICES / Math.max(1e-6, Math.log(Math.max(build.far, near * 1.001) / near)));
    a.setF32("slices", CLUSTER_SLICES);
    a.setI32("lightCount", locals);
    a.setI32("stride", MAX_LIGHTS_PER_CLUSTER);
  }

  /**
   * Build and upload this frame's cluster grid (Phase 13.3, 13.4; docs/RENDERING.md §4b–4c).
   *
   * `writeLights` has already staged the local lights. The range pass and the counting pass always
   * run here — the counting pass is coverage-independent, and the counts are what the fragment stage
   * indexes its lists with *and* what the frame reports, so they have to be exact before anything is
   * drawn. The fill is the coverage-proportional half: `clusterGrid.rasterize` runs it on the CPU, or
   * `forge.lights.assign` (recorded in `buildFrame`) runs it on the GPU, in which case the light
   * indices are never uploaded at all.
   *
   * The slice span is the builder's own (the deepest live light, not the camera's far plane), so the
   * shader and the CPU cannot disagree about where a slice boundary falls.
   */
  private buildClusters(camera: Camera, renderWidth: number, renderHeight: number): void {
    const locals = this.clusterLightCount;
    const near = Math.max(1e-4, camera.near);
    const ranges = this.clusterGrid.prepare(
      this.clusterLightSources,
      { view: this.view, proj00: this.projection.m[0]!, proj11: this.projection.m[5]!, near, far: camera.far },
      locals,
    );
    const gpuFill = this.cullingMode === "gpu";
    const build = gpuFill ? this.clusterGrid.count(ranges) : this.clusterGrid.rasterize(ranges);
    this.clusterRanges = ranges;
    this.clusterBuild = build;
    this.writeClusterUniforms(build, locals, near, renderWidth, renderHeight);

    const q = this.device.device.queue;
    q.writeBuffer(this.clusterBuffer!, 0, gpuSource(this.clusterBytes.bytes.subarray(0, this.clusterBytes.byteLength)));
    // The light records are a fixed-stride array: upload the header plus the records that exist.
    q.writeBuffer(this.clusterLightBuffer!, 0, gpuSource(this.clusterLightBytes.bytes.subarray(0, CLUSTER_LIGHTS_FIELD.offset + locals * CLUSTER_LIGHTS_FIELD.stride!)));
    // Every cluster's list length can change (a cluster no light reaches now held a list last frame),
    // so all of `counts` goes every frame — the CPU's own counts, whichever rasteriser writes the
    // lists. Only the CPU fill uploads indices: the fixed-stride blocks mean only the prefix a light
    // can possibly have written — the highest cluster any live light touches — would need uploading
    // (a full 384 KB for a scene with three lamps), and the compute fill writes them on the device.
    q.writeBuffer(this.clusterGridBuffer!, CLUSTER_COUNTS_FIELD.offset, gpuSource(this.clusterGrid.counts));
    if (!gpuFill) {
      const entries = Math.min(CLUSTER_INDEX_CAPACITY, (build.maxCluster + 1) * MAX_LIGHTS_PER_CLUSTER);
      if (entries > 0) {
        q.writeBuffer(this.clusterGridBuffer!, CLUSTER_INDICES_FIELD.offset, gpuSource(this.clusterGrid.indices.subarray(0, entries)));
      }
    }

    const s = this.stats;
    s.clusteredLighting = true;
    s.clusteredLights = locals;
    s.clustersUsed = build.clustersUsed;
    s.clusterIndices = build.indexCount;
    s.maxLightsPerCluster = build.maxPerCluster;
    s.lightsDropped = s.lightsDropped || build.dropped;
    s.clusterFill = gpuFill ? "gpu" : "cpu";
  }

  /**
   * `forge.lights.assign`: the GPU fill (Phase 13.4). Recorded when the renderer owns that half *and*
   * this frame filled a grid — a setting, not the frame's contents (`clusterRanges` is null on a frame
   * that did not cluster), the way `forge.ssao` belongs to the frames that compute SSAO. The grid's
   * counts were staged by `buildClusters` just before, and the shader reads them from the same buffer.
   */
  private recordLightFill(graph: RenderGraph): void {
    if (this.cullingMode !== "gpu") return;
    const ranges = this.clusterRanges;
    if (!ranges) return;
    this.lightCuller ??= new GpuLightCuller(this.device, this.pipelines.shaders);
    this.lightCuller.record(graph, this.clusterGrid, ranges, this.clusterGridBuffer!, "forge.lights");
  }

  private writeShadowUniforms(scene: Scene, sun: Light | null, cascadeCount: number, spotShadowCount: number, pointShadowCount: number, size: number, shadowDistance: number): void {
    const a = this.shadowAccessor;
    const splits = [1e9, 1e9, 1e9, 1e9];
    const texels = [0, 0, 0, 0];
    const cascadeStride = a.arrayStride("cascadeViewProj");
    const cascadeBase = a.offsetOf("cascadeViewProj");
    for (let c = 0; c < MAX_CASCADES; c++) {
      const cascade = c < cascadeCount ? this.cascades[c]! : null;
      const m = cascade ? cascade.viewProj.m : IDENTITY;
      this.shadowBytes.f32.set(m, (cascadeBase + c * cascadeStride) >> 2);
      if (cascade) {
        splits[c] = cascade.far;
        texels[c] = cascade.texelWorld;
      }
      this.writeShadowPassUniform(c, m);
    }
    a.setVec4("cascadeSplits", splits[0]!, splits[1]!, splits[2]!, splits[3]!);
    a.setVec4("cascadeTexelWorld", texels[0]!, texels[1]!, texels[2]!, texels[3]!);

    const spotMatrixStride = a.arrayStride("spotViewProj");
    const spotMatrixBase = a.offsetOf("spotViewProj");
    const spotParamsStride = a.arrayStride("spotParams");
    const spotParamsBase = a.offsetOf("spotParams");
    for (let s = 0; s < MAX_SPOT_SHADOWS; s++) {
      const state = s < spotShadowCount ? this.spotShadows[s]! : null;
      const matrix = state ? state.viewProj.m : IDENTITY;
      this.shadowBytes.f32.set(matrix, (spotMatrixBase + s * spotMatrixStride) >> 2);
      const params = (spotParamsBase + s * spotParamsStride) >> 2;
      const light = state?.light ?? null;
      this.shadowBytes.f32[params] = state?.texelSize ?? 0;
      this.shadowBytes.f32[params + 1] = light?.shadowBias ?? 0;
      this.shadowBytes.f32[params + 2] = light?.shadowNormalBias ?? 0;
      this.shadowBytes.f32[params + 3] = state?.worldTexelScale ?? 0;
      if (state) this.writeShadowPassUniform(cascadeCount + s, matrix);
    }

    const pointMatrixStride = a.arrayStride("pointViewProj");
    const pointMatrixBase = a.offsetOf("pointViewProj");
    const pointParamsStride = a.arrayStride("pointParams");
    const pointParamsBase = a.offsetOf("pointParams");
    for (let p = 0; p < MAX_POINT_SHADOWS; p++) {
      const state = p < pointShadowCount ? this.pointShadows[p]! : null;
      for (let f = 0; f < POINT_SHADOW_FACES; f++) {
        const slot = p * POINT_SHADOW_FACES + f;
        const matrix = state ? state.faces[f]!.viewProj.m : IDENTITY;
        this.shadowBytes.f32.set(matrix, (pointMatrixBase + slot * pointMatrixStride) >> 2);
        if (state) this.writeShadowPassUniform(cascadeCount + spotShadowCount + slot, matrix);
      }
      const params = (pointParamsBase + p * pointParamsStride) >> 2;
      const light = state?.light ?? null;
      this.shadowBytes.f32[params] = state?.texelSize ?? 0;
      this.shadowBytes.f32[params + 1] = light?.shadowBias ?? 0;
      this.shadowBytes.f32[params + 2] = light?.shadowNormalBias ?? 0;
      this.shadowBytes.f32[params + 3] = state?.worldTexelScale ?? 0;
    }

    a.setI32("spotCount", spotShadowCount);
    a.setI32("pointCount", pointShadowCount);
    a.setF32("texelSize", 1 / size);
    a.setF32("depthBias", sun ? sun.shadowBias : 0.0008);
    a.setF32("normalBias", sun ? sun.shadowNormalBias : 0.6);
    a.setF32("fadeStart", shadowDistance * 0.85);
    a.setI32("enabled", cascadeCount > 0 || spotShadowCount > 0 || pointShadowCount > 0 ? 1 : 0);
    a.setI32("size", size);
    a.setI32("count", cascadeCount);
    a.setU32("flags", scene.settings.shadow.debugCascades ? 1 : 0);
    const q = this.device.device.queue;
    q.writeBuffer(this.shadowBuffer!, 0, gpuSource(this.shadowBytes.bytes.subarray(0, this.shadowBytes.byteLength)));
    const layerCount = cascadeCount + spotShadowCount + pointShadowCount * POINT_SHADOW_FACES;
    if (layerCount > 0) q.writeBuffer(this.cascadeBuffer!, 0, gpuSource(this.cascadeBytes.bytes.subarray(0, layerCount * UNIFORM_SLOT)));
  }

  /** Write one dynamic-offset depth-pass record in the shared directional/spot/point arena. */
  private writeShadowPassUniform(layer: number, matrix: Float32Array): void {
    this.cascadeAccessor.relocate(layer * UNIFORM_SLOT);
    this.cascadeAccessor.setMat4("viewProj", matrix);
    this.cascadeAccessor.setI32("layer", layer);
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

  private prepareSpotShadows(scene: Scene, lights: readonly Light[], mapSize: number): number {
    this.spotShadowIndices.clear();
    let count = 0;
    for (const light of lights) {
      if (light.kind !== "spot" || !light.castShadow || !light.affectScene || count >= MAX_SPOT_SHADOWS) continue;
      const state = this.spotShadows[count]!;
      state.light = null;
      scene.world.worldPosition(light.entity, state.position);
      if (!computeSpotShadow(state.position, light.direction, spotOuterConeCos(light), light.range, mapSize, state)) continue;
      state.frustum.setFromViewProjection(state.viewProj);
      state.light = light;
      this.spotShadowIndices.set(light, count);
      count++;
    }
    return count;
  }

  /**
   * Fit this frame's point-shadow cubes (the first {@link MAX_POINT_SHADOWS} valid shadow-casting
   * point lights in scene order). Every face shares the light's position and range, so the six
   * frustums together cover the whole influence sphere.
   */
  private preparePointShadows(scene: Scene, lights: readonly Light[], mapSize: number): number {
    this.pointShadowIndices.clear();
    let count = 0;
    for (const light of lights) {
      if (light.kind !== "point" || !light.castShadow || !light.affectScene || count >= MAX_POINT_SHADOWS) continue;
      const state = this.pointShadows[count]!;
      state.light = null;
      scene.world.worldPosition(light.entity, state.position);
      if (!computePointShadow(state.position, light.range, mapSize, state)) continue;
      for (let f = 0; f < POINT_SHADOW_FACES; f++) state.frustums[f]!.setFromViewProjection(state.faces[f]!.viewProj);
      state.light = light;
      this.pointShadowIndices.set(light, count);
      count++;
    }
    return count;
  }

  private collectBatches(scene: Scene, camera: Camera, cascadeCount: number, spotShadowCount: number, pointShadowCount: number): void {
    this.batchCount = 0;
    this.shadowCasterMask = 0;
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
      const caster = r.castShadow && !r.transparent && !r.overlay;
      // Assign this object independently to each cascade, spot or point-cube frustum it intersects.
      // Retaining the mask per instance prevents a merged colour batch from dragging unrelated
      // objects into a map.
      const shadowMask = caster ? this.shadowMaskFor(box, cascadeCount, spotShadowCount, pointShadowCount) : 0;
      let shadowOnly = false;
      if (!inView) {
        this.stats.culled++;
        // Off-screen casters still matter when any active directional or spot frustum contains them.
        if (!caster || shadowMask === 0) continue;
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
        const instanceIndex = existing.count;
        existing.count++;
        existing.bounds.union(box);
        this.addShadowRange(existing, instanceIndex, shadowMask);
        // A merged batch draws as one, so its limit has to be the most permissive of its members':
        // the CPU already decided each member belonged in the frame, and the device only gets to
        // drop the whole batch.
        existing.maxDistance = Math.max(existing.maxDistance, r.maxDistance);
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
      b.cullIndex = index;
      b.maxDistance = r.maxDistance;
      b.bounds.setFrom(box.min, box.max);
      b.shadowRangeCount = 0;
      this.addShadowRange(b, 0, shadowMask);
    }
  }

  /** Append/coalesce the per-object assignment without splitting the colour batch. */
  private addShadowRange(batch: Batch, instanceIndex: number, shadowMask: number): void {
    if (shadowMask === 0) return;
    this.shadowCasterMask |= shadowMask;
    const ranges = batch.shadowRanges;
    const last = ranges[batch.shadowRangeCount - 1];
    if (last && last.shadowMask === shadowMask && last.firstInstance + last.instanceCount === instanceIndex) {
      last.instanceCount++;
      return;
    }
    let range = ranges[batch.shadowRangeCount];
    if (!range) {
      range = { firstInstance: instanceIndex, instanceCount: 1, shadowMask };
      ranges.push(range);
    } else {
      range.firstInstance = instanceIndex;
      range.instanceCount = 1;
      range.shadowMask = shadowMask;
    }
    batch.shadowRangeCount++;
  }

  /** Conservative cascade, spot and point-face bits for every light-space frustum intersecting this renderable. */
  private shadowMaskFor(box: AABB, cascadeCount: number, spotShadowCount: number, pointShadowCount: number): number {
    let mask = 0;
    for (let c = 0; c < cascadeCount; c++) {
      if (this.cascadeFrustums[c]!.intersectsAABB(box)) mask |= 1 << c;
    }
    for (let s = 0; s < spotShadowCount; s++) {
      if (this.spotShadows[s]!.frustum.intersectsAABB(box)) mask |= 1 << (MAX_CASCADES + s);
    }
    for (let p = 0; p < pointShadowCount; p++) {
      const state = this.pointShadows[p]!;
      // Sphere pre-test: a caster outside the light's range cannot reach any of the six faces.
      if (!box.intersectsSphere(state.position, state.far)) continue;
      for (let f = 0; f < POINT_SHADOW_FACES; f++) {
        if (state.frustums[f]!.intersectsAABB(box)) mask |= 1 << (POINT_MASK_BASE + p * POINT_SHADOW_FACES + f);
      }
    }
    return mask;
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
        cullIndex: 0,
        maxDistance: 0,
        bounds: new AABB(),
        shadowRanges: [],
        shadowRangeCount: 0,
      };
      this.batchPool.push(b);
    }
    this.batchCount++;
    return b;
  }

  private reserveObject(matrix: Float32Array, instanceCount: number, visibilityIndex: number): number {
    const offset = this.objectArena.reserve(ObjectUniforms.byteSize("uniform"), 256);
    const a = this.objectAccessor;
    a.relocate(offset);
    a.setMat4("model", matrix);
    a.setU32("instanceCount", instanceCount);
    // Which word of the culler's visibility buffer this draw reads (the batch index: the cull pass
    // writes one word per batch in upload order).
    a.setU32("visibilityIndex", visibilityIndex);
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

  /**
   * Stage this frame's batch bounds, decide the frame's culling mode, and hand the device (or the
   * CPU twin) everything the cull pass needs. Runs after `collectBatches` — the batches are the
   * input — and before `buildFrame`, which declares the passes that consume the result.
   */
  private prepareObjectCulling(camera: Camera, width: number, height: number, prepass: boolean): void {
    const count = this.batchCount;
    this.ensureVisibilityCapacity(count);
    this.ensureRecordCapacity(count);
    if (this.cullBounds.length < count * 8) this.cullBounds = new Float32Array(Math.max(count * 8, 512));
    const bounds = this.cullBounds;
    // The records' static half — the batch's index window — is CPU knowledge the device does not have;
    // word 1 holds the batch's count as the pre-verdict default (a batch the pass never touches, because
    // it is past the cap or because the pass did not run, must draw). The bounds carry the same count
    // (`max.w`) so the pass can write it back for the batches it keeps.
    const records = this.indirectDrawsEnabled ? this.drawRecordWords : null;
    for (let i = 0; i < count; i++) {
      const b = this.batchPool[i]!;
      const base = i * 8;
      bounds[base] = b.bounds.min.x;
      bounds[base + 1] = b.bounds.min.y;
      bounds[base + 2] = b.bounds.min.z;
      bounds[base + 3] = b.maxDistance;
      bounds[base + 4] = b.bounds.max.x;
      bounds[base + 5] = b.bounds.max.y;
      bounds[base + 6] = b.bounds.max.z;
      bounds[base + 7] = b.count;
      if (!records) continue;
      const r = i * DRAW_RECORD_WORDS;
      records[r] = b.indexCount;
      records[r + 1] = b.count;
      records[r + 2] = b.geometry.indexBuffer ? b.indexStart : 0;
      records[r + 3] = 0;
      records[r + 4] = 0;
      records[r + 5] = 0;
      records[r + 6] = 0;
      records[r + 7] = 0;
    }
    // Occlusion needs three things at once: the device path, the option, and a depth buffer that
    // exists (the prepass) whose projection maps view z into the pixels the pyramid holds. The CPU
    // twin cannot do it at all — it has no depth — so `"cpu"` is frustum + distance only.
    this.cullOcclusion =
      this.objectCullingMode === "gpu" && this.occlusionCullingEnabled && prepass && !camera.orthographic && hizLevelCount(width, height) > 0;

    // Zero the words first: the CPU twin below only overwrites the batches it tests, and the device
    // pass only those inside its cap, so whatever is left has to mean "visible".
    const words = this.visibilityWords;
    words.fill(0, 0, count);
    if (this.objectCullingMode === "cpu") {
      const visible = records ? this.ensureVisibleList().words : null;
      const stats = cullBatchesOnCpu(bounds.subarray(0, count * 8), count, this.cpuCullParams(camera, width, height, records !== null), words, [], {
        records: records ?? undefined,
        visible: visible ?? undefined,
      });
      this.stats.cullTested = stats.tested;
      this.stats.cullFrustum = stats.culledFrustum;
      this.stats.cullDistance = stats.culledDistance;
      this.stats.cullOccluded = 0;
      this.stats.cullVisible = stats.visible;
      this.stats.cullRecordZeroed = stats.recordZeroed;
      if (visible) this.device.device.queue.writeBuffer(this.visibleList!.buffer, 0, gpuSource(visible.subarray(0, Math.max(count, 1))));
    }
    this.device.device.queue.writeBuffer(this.visibilityBuffer!, 0, gpuSource(words.subarray(0, count)));
    // Only the *decided* word goes up: the pass overwrites it per batch, and the upload is what the
    // batches past the cap (and a frame whose culler did not run) keep — visible, not stale.
    if (records) this.device.device.queue.writeBuffer(this.drawRecords!, 0, gpuSource(records.subarray(0, count * DRAW_RECORD_WORDS)));

    if (this.objectCullingMode === "cpu") return;
    this.objectCuller ??= new GpuObjectCuller(this.device, this.pipelines.shaders);
    this.objectCuller.prepare(bounds.subarray(0, count * 8), count, {
      view: this.view,
      projection: this.projection,
      viewProj: this.viewProj,
      cameraPos: camera.positionRender,
      near: camera.near,
      far: camera.far,
      width,
      height,
      occlude: this.cullOcclusion,
      records: records !== null,
    });
  }

  /**
   * The frame state the CPU twin reads, in the units the shader reads it. `hizLevels: 0` is what
   * says "no depth here": the twin has no prepass depth, so it runs the frustum and distance tests
   * and leaves occlusion to the device path.
   */
  private cpuCullParams(camera: Camera, width: number, height: number, records: boolean): ObjectCullParams {
    return {
      view: this.view.m,
      proj: this.projection.m,
      viewProj: this.viewProj.m,
      cameraPos: camera.positionRender,
      near: camera.near,
      far: camera.far,
      width,
      height,
      flags: CULL_FLAG_FRUSTUM | CULL_FLAG_DISTANCE | (records ? CULL_FLAG_RECORDS : 0),
      hizLevels: 0,
    };
  }

  /** Grow the visibility buffer (and drop the draw group that binds it) when the batch count does. */
  private ensureVisibilityCapacity(count: number): void {
    const bytes = Math.max(alignUp(Math.max(count, 1) * 4, 256), 256);
    if (bytes <= this.visibilityBytes) return;
    this.visibilityBuffer?.destroy();
    this.visibilityBuffer = this.device.device.createBuffer({
      label: "cull.visibility",
      size: bytes,
      usage: BufferUsage.STORAGE | BufferUsage.COPY_DST,
    });
    this.visibilityBytes = bytes;
    this.visibilityWords = new Uint32Array(bytes >> 2);
    this.drawBindGroup = null;
  }

  /**
   * The frame's indirect draw records: one 32-byte slot per batch, `STORAGE` (the pass writes the one
   * word that is a decision) plus `INDIRECT` (the draw loop reads the record back) and `COPY_DST` (the
   * upload). 256-aligned and grown in 256-byte steps the way the visibility buffer is; the cull group
   * binds it, so growing has to retire that group and the culler does that itself.
   */
  private ensureRecordCapacity(count: number): void {
    const bytes = Math.max(alignUp(Math.max(count, 1) * DRAW_RECORD_BYTES, 256), 256);
    if (bytes <= this.drawRecordBytes) return;
    this.drawRecords?.destroy();
    this.drawRecords = this.device.device.createBuffer({
      label: "cull.drawRecords",
      size: bytes,
      usage: BufferUsage.STORAGE | BufferUsage.INDIRECT | BufferUsage.COPY_DST,
    });
    this.drawRecordBytes = bytes;
    this.drawRecordWords = new Uint32Array(bytes >> 2);
  }

  /** The compaction list: fixed capacity (`MAX_CULLED_BATCHES` slots), so it is built once. */
  private ensureVisibleList(): { buffer: GPUBuffer; words: Uint32Array } {
    this.visibleList ??= {
      buffer: this.device.device.createBuffer({
        label: "cull.visibleBatches",
        size: MAX_CULLED_BATCHES * 4,
        usage: BufferUsage.STORAGE | BufferUsage.COPY_DST,
      }),
      words: new Uint32Array(MAX_CULLED_BATCHES),
    };
    return this.visibleList;
  }

  /** Map the culler's counters back and publish them; the device's numbers lag by a frame or two. */
  private pollObjectCulling(): void {
    if (this.objectCullingMode !== "gpu" || !this.objectCuller) return;
    this.objectCuller.poll();
    const stats = this.objectCuller.stats;
    this.stats.cullTested = stats.tested;
    this.stats.cullFrustum = stats.culledFrustum;
    this.stats.cullDistance = stats.culledDistance;
    this.stats.cullOccluded = stats.culledOccluded;
    this.stats.cullVisible = stats.visible;
    this.stats.cullRecordZeroed = stats.recordZeroed;
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
    // The culler caches the bind groups its pyramid passes bind (the sampled depth's view changes
    // with the pool).
    this.objectCuller?.invalidate();
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
    // The visibility buffer is bound by every draw group (binding 2) and written by the culler, so it
    // exists whatever the culling mode is; the zeroed words are what "no culler ran" means.
    this.ensureVisibilityCapacity(this.batchCount);
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
          // One u32 per batch: the object culler's verdict, which the vertex entry points of the
          // standard module turn into a clipped-out position for a culled batch. Always bound, and
          // always zeroed before the frame's draws — a frame nothing culled draws everything.
          { binding: 2, resource: { buffer: this.visibilityBuffer! } },
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
    const pipeline = this.pipelines.getReady({ technique: "debug", colorFormat, depthFormat: this.device.depthFormat, transparent: true, doubleSided: true, instanced: false });
    if (!pipeline) return;
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
    const pipeline = this.pipelines.getReady({ technique: "debug", colorFormat, depthFormat: this.device.depthFormat, transparent: true, doubleSided: true, instanced: false, noDepthTest: true });
    if (!pipeline) return;
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
    this.lightCuller?.dispose();
    this.lightCuller = null;
    this.objectCuller?.dispose();
    this.objectCuller = null;
    this.visibilityBuffer?.destroy();
    this.visibilityBuffer = null;
    this.drawRecords?.destroy();
    this.drawRecords = null;
    this.drawRecordBytes = 0;
    this.drawRecordWords = new Uint32Array(0);
    this.visibleList?.buffer.destroy();
    this.visibleList = null;
    this.visibilityBytes = 0;
    this.visibilityWords = new Uint32Array(0);
    for (const b of [this.frameBuffer, this.lightBuffer, this.clusterBuffer, this.clusterLightBuffer, this.clusterGridBuffer, this.shadowBuffer, this.cascadeBuffer, this.postBuffer, this.skyBuffer, this.cloudBuffer, this.waterBuffer, this.ssaoBuffer, this.objectBuffer, this.instanceBuffer, this.debugBuffer, this.overlayBuffer]) b?.destroy();
    this.frameBuffer = null;
    this.lightBuffer = null;
    this.clusterBuffer = null;
    this.clusterLightBuffer = null;
    this.clusterGridBuffer = null;
    this.spotShadowIndices.clear();
    for (const spot of this.spotShadows) spot.light = null;
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
