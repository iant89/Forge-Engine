/**
 * `Renderer` — one frame in, one frame out.
 *
 * Frame structure (docs/RENDERING.md#frame):
 *   1. camera resolution: pick the highest-priority enabled `Camera`, compose view/projection from
 *      its entity's world matrix, and publish them back onto the component (culling, audio and
 *      picking all read the same numbers — never a second copy).
 *   2. per-frame uniform upload: one `writeBuffer` for the frame block, one for lights.
 *   3. batch assembly: Renderables grouped by (geometry, material pipeline key, transparency), each
 *      batch writing its instance matrices into a per-frame arena. Draw cost is therefore
 *      `setBindGroup(dynamic offsets) + drawIndexed`, with no per-draw object creation.
 *   4. depth pass (shadow map) for the directional caster, when enabled.
 *   5. colour pass, opaque then transparent.
 *   6. debug overlay, drawn into the same target after the scene.
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
import { PipelineFactory } from "./pipeline.js";
import { PerFrameUniforms, LightBlock, ShadowUniforms, ObjectUniforms, InstanceStruct, MAX_LIGHTS_PER_FRAME, MAX_CASCADES } from "./uniforms.js";
import { TextureDefaults } from "../resources/texture.js";
import { Geometry } from "./geometry.js";
import { Material } from "./material.js";
import { Camera, Light, Renderable } from "../scene/components/index.js";
import type { GraphicsDevice } from "../gpu/device.js";
import type { Scene } from "../scene/scene.js";
import type { SystemContext } from "../scene/systems.js";
import type { RenderFrameContext, SkyParams, PickResult } from "../scene/renderContext.js";
import { UsageError } from "../core/errors.js";

export interface RendererOptions {
  /** Force an override clear colour (the editor's "show without sky" mode). */
  clearColor?: number | null;
  /** Shadow map resolution; the scene's per-light setting wins when larger. */
  shadowMapSize?: number;
  /** Maximum instanced draws before splitting into a second batch (driver-friendly cap). */
  maxInstancesPerBatch?: number;
}

export interface RenderStats {
  drawCalls: number;
  triangles: number;
  instances: number;
  batches: number;
  culled: number;
  shadowsDrawn: number;
  debugLines: number;
}

interface Batch {
  geometry: Geometry;
  material: Material;
  instanceOffset: number;
  count: number;
  transparent: boolean;
  overlay: boolean;
  indexCount: number;
  indexStart: number;
  depthSort: number;
  objectOffset: number;
}

const ZERO_MATRIX = new Float32Array(16);
{
  const z = ZERO_MATRIX;
  z[0] = 1;
  z[5] = 1;
  z[10] = 1;
  z[15] = 1;
}

export class Renderer implements RenderFrameContext {
  readonly pipelines: PipelineFactory;
  readonly defaults = new TextureDefaults();
  stats: RenderStats = { drawCalls: 0, triangles: 0, instances: 0, batches: 0, culled: 0, shadowsDrawn: 0, debugLines: 0 };
  instanceCount = 0;

  private readonly frameBytes = new WriteBuffer(PerFrameUniforms.byteSize("uniform"));
  private readonly frameAccessor = new StructAccessor(PerFrameUniforms, this.frameBytes, 0, "uniform");
  private readonly lightBytes = new WriteBuffer(LightBlock.byteSize("uniform"));
  private readonly lightAccessor = new StructAccessor(LightBlock, this.lightBytes, 0, "uniform");
  private readonly shadowBytes = new WriteBuffer(ShadowUniforms.byteSize("uniform"));
  private readonly shadowAccessor = new StructAccessor(ShadowUniforms, this.shadowBytes, 0, "uniform");
  private frameBuffer: GPUBuffer | null = null;
  private lightBuffer: GPUBuffer | null = null;
  private shadowBuffer: GPUBuffer | null = null;
  private frameBindGroup: GPUBindGroup | null = null;
  private depthFrameBindGroup: GPUBindGroup | null = null;
  private objectArena = new BufferBuilder(64 * 1024);
  private instanceArena = new BufferBuilder(64 * 1024);
  private objectBuffer: GPUBuffer | null = null;
  private objectBufferCapacity = 0;
  private instanceBuffer: GPUBuffer | null = null;
  private instanceBufferCapacity = 0;
  private drawBindGroup: GPUBindGroup | null = null;
  private depthTexture: GPUTexture | null = null;
  private depthView: GPUTextureView | null = null;
  private depthWidth = 0;
  private depthHeight = 0;
  private shadowTexture: GPUTexture | null = null;
  private shadowView: GPUTextureView | null = null;
  private shadowSize = 0;
  private deviceLostUnsub: { dispose(): void } | null = null;
  private readonly batches: Batch[] = [];
  private readonly batchIndex = new Map<string, number>();
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
  private readonly scratchMat = new Mat4();
  private lost = false;
  private pendingSky: Partial<SkyParams> | null = null;
  private labelsSeen = new Set<string>();
  private currentFrameContext: SystemContext | null = null;

  constructor(readonly device: GraphicsDevice, readonly options: RendererOptions = {}) {
    this.pipelines = new PipelineFactory(device);
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

  /** Call after a canvas resize; re-creates the depth target. */
  resize(width: number, height: number): void {
    this.device.resize(width, height);
    this.depthTexture?.destroy();
    this.depthTexture = null;
    this.depthView = null;
    this.depthWidth = 0;
    this.depthHeight = 0;
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
    const device = this.device.device;
    this.defaults.ensure(this.device);
    this.ensureBuffers();

    const cameraHit = scene.findCamera();
    if (!cameraHit) {
      // Nothing to render, but still clear the frame: leaving the previous contents on screen is
      // how "black screen after the first scene" gets misdiagnosed as a pipeline bug.
      this.clearFrame(scene, null);
      return;
    }
    const camera = cameraHit.camera;
    const view = this.computeCameraView(scene, cameraHit.entity.id);
    const projection = this.computeProjection(camera);
    const positionRender = this.lastCameraPos.copyFrom(scene.world.worldPosition(cameraHit.entity.id, this.scratchVec));
    scene.coordinateSpace.toWorld(positionRender, this.lastCameraWorld);
    camera.writeMatrices(view, projection, positionRender);
    this.frustum.setFromViewProjection(new Mat4().multiplyMatrices(projection, view));

    this.writePerFrame(scene, camera, view, projection, positionRender);
    const lightCount = this.writeLights(scene, view);
    const shadowViewMatrices = this.settings(scene).shadow.enabled && lightCount > 0 ? this.writeShadowUniforms(scene) : null;

    // Batches.
    this.batches.length = 0;
    this.batchIndex.clear();
    this.objectArena.reset();
    this.instanceArena.reset();
    this.stats = { drawCalls: 0, triangles: 0, instances: 0, batches: 0, culled: 0, shadowsDrawn: 0, debugLines: 0 };
    this.instanceCount = 0;
    this.collectBatches(scene, camera);
    this.stats.batches = this.batches.length;
    if (this.batches.length === 0 && this.debugLineCount === 0 && !shadowViewMatrices) {
      this.clearFrame(scene, camera);
      return;
    }

    for (const b of this.batches) {
      b.objectOffset = this.reserveObject(b.count > 1 ? ZERO_MATRIX : this.lastMatrixFor(b), b.count);
    }
    this.ensureArenas();
    this.uploadArenas();

    // Shadow pass.
    if (shadowViewMatrices) {
      const shadowPipeline = this.pipelines.get({
        technique: "depth",
        colorFormat: null,
        depthFormat: "depth24plus",
        transparent: false,
        doubleSided: false,
        instanced: false,
      });
      const encoder = device.createCommandEncoder({ label: "forge.shadow" });
      const pass = encoder.beginRenderPass({
        label: "forge.shadow",
        colorAttachments: [],
        depthStencilAttachment: {
          view: this.ensureShadowMap(Math.max(this.options.shadowMapSize ?? 1024, 256)),
          depthClearValue: 1,
          depthLoadOp: "clear",
          depthStoreOp: "store",
        },
      });
      pass.setPipeline(shadowPipeline.pipeline);
      pass.setBindGroup(0, this.depthFrameBindGroup!);
      let drawn = 0;
      for (const b of this.batches) {
        if (b.overlay || b.transparent) continue;
        if (!b.geometry.indexBuffer && !b.geometry.vertexBuffer) continue;
        pass.setBindGroup(1, this.drawBindGroup!, [b.objectOffset, 0]);
        pass.setVertexBuffer(0, b.geometry.vertexBuffer!);
        if (b.geometry.indexBuffer) {
          pass.setIndexBuffer(b.geometry.indexBuffer, b.geometry.indexFormat!);
          pass.drawIndexed(b.geometry.indexCount);
        } else {
          pass.draw(b.geometry.vertexCount);
        }
        drawn++;
      }
      pass.end();
      device.queue.submit([encoder.finish()]);
      this.stats.shadowsDrawn = drawn;
    }

    // Colour pass.
    const swapChainTexture = this.device.currentTexture;
    if (!swapChainTexture) throw new UsageError("renderer: no swapchain texture (was the canvas configured?)");
    const colorView = swapChainTexture.createView();
    const encoder = device.createCommandEncoder({ label: "forge.main" });
    const clearColor = this.clearColorFor(scene);
    const pass = encoder.beginRenderPass({
      label: "forge.main",
      colorAttachments: [
        {
          view: colorView,
          clearValue: { r: clearColor[0], g: clearColor[1], b: clearColor[2], a: 1 },
          loadOp: "clear",
          storeOp: "store",
        },
      ],
      depthStencilAttachment: {
        view: this.ensureDepthTarget(),
        depthClearValue: 1,
        depthLoadOp: "clear",
        depthStoreOp: "discard",
      },
    });
    pass.setBindGroup(0, this.frameBindGroup!);
    let lastKey = "";
    const sorted = this.batches.slice().sort((a, b) => (a.transparent === b.transparent ? a.depthSort - b.depthSort : a.transparent ? 1 : -1));
    for (const b of sorted) {
      const key = b.material.pipelineKey;
      const pipeline = this.pipelines.get({
        technique: b.material.technique === "unlit" ? "unlit" : "standard",
        colorFormat: this.device.format,
        depthFormat: this.device.depthFormat,
        transparent: b.transparent,
        doubleSided: b.material.doubleSided,
        instanced: b.count > 1,
      });
      if (key !== lastKey) {
        lastKey = key;
        this.stats.drawCalls++;
      } else {
        this.stats.drawCalls++;
      }
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
      this.stats.triangles += (b.indexCount / 3) * Math.max(1, b.count);
      this.stats.instances += b.count;
    }
    if (this.debugLineCount > 0) this.drawDebugLines(pass);
    pass.end();
    device.queue.submit([encoder.finish()]);
    this.currentFrameContext = null;
    this.invalidated = false;
    this.lastUploadCount++;
  }

  /** Systems call this through `SystemContext.render`; it queues per-instance data. */
  writeInstanceData(index: number, matrix: Float32Array, color: number, emissive: number): void {
    const offset = this.instanceArena.reserve(96, 256);
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
    /* phase 2: per-light shadow atlas slots */
  }

  setSkyOverride(params: Partial<SkyParams>): void {
    this.pendingSky = params;
    this.invalidate();
  }

  get skyOverride(): Partial<SkyParams> | null {
    return this.pendingSky;
  }

  // ------------------------------------------------------------------ internals

  private settings(scene: Scene): { shadow: { enabled: boolean; cascades: number; mapSize: number; distance: number }; [k: string]: unknown } {
    return scene.settings as never;
  }

  private clearFrame(scene: Scene, _camera: Camera | null): void {
    const texture = this.device.currentTexture;
    if (texture === null) return;
    const device = this.device.device;
    const encoder = device.createCommandEncoder({ label: "forge.clear" });
    const c = this.clearColorFor(scene);
    const pass = encoder.beginRenderPass({
      colorAttachments: [{ view: texture.createView(), clearValue: { r: c[0], g: c[1], b: c[2], a: 1 }, loadOp: "clear", storeOp: "store" }],
    });
    pass.end();
    device.queue.submit([encoder.finish()]);
  }

  /** Clear colour in the swapchain's space: the swapchain format is not sRGB, so encode here. */
  /** Clear colour as the swapchain expects it (0..1 floats, encoded when the pass does the encode). */
  private clearColorFor(scene: Scene): [number, number, number] {
    const override = this.options.clearColor;
    if (typeof override === "number") {
      const q = (v: number) => Math.min(1, Math.max(0, v)) / 255;
      return [q((override >> 16) & 0xff), q((override >> 8) & 0xff), q(override & 0xff)];
    }
    return this.linearClearColor(scene);
  }

  private linearClearColor(scene: Scene): [number, number, number] {
    const c = scene.settings.backgroundColor;
    const srgb = (v: number) => Math.min(1, Math.max(0, v));
    // The fragment stage already outputs sRGB-encoded values when the encode pass is off, so the
    // clear colour must be encoded the same way to avoid a two-tone background.
    const enc = (v: number) => (v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(Math.max(v, 0), 1 / 2.4) - 0.055);
    void srgb;
    if (scene.settings.hdr) return [c.r, c.g, c.b];
    return [enc(c.r), enc(c.g), enc(c.b)];
  }

  private computeCameraView(scene: Scene, entityId: number): Mat4 {
    const world = scene.world.getWorldMatrix(entityId as never, this.scratchMat);
    // The stored matrix is render-local (relative to the coordinate-space origin), so inverting it
    // is exact for the frame's purposes — no double-precision term is involved here.
    if (!world.invert()) world.setIdentity();
    return world;
  }

  private computeProjection(camera: Camera): Mat4 {
    const p = new Mat4();
    const aspect = camera.aspect;
    if (camera.orthographic) {
      const halfH = camera.orthoHeight / 2;
      const halfW = halfH * aspect;
      p.setOrthographic(-halfW, halfW, -halfH, halfH, camera.near, camera.far);
    } else {
      p.setPerspective(camera.fovY, aspect, camera.near, camera.far);
    }
    return p;
  }

  private writePerFrame(scene: Scene, camera: Camera, view: Mat4, projection: Mat4, positionRender: Vec3): void {
    const a = this.frameAccessor;
    const vp = new Mat4().multiplyMatrices(projection, view);
    writeMatrix(a, "viewProj", vp.m);
    const inv = vp.clone();
    if (!inv.invert()) inv.setIdentity(); // singular view (degenerate camera) → harmless fallback
    writeMatrix(a, "invViewProj", inv.m);
    writeVec3(a, "cameraPosRender", positionRender.x, positionRender.y, positionRender.z);
    a.setF32("exposure", scene.settings.exposure);
    const ctx = this.currentFrameContext;
    writeVec4(a, "time", ctx?.elapsed ?? 0, ctx?.dt ?? 0, ctx?.frame ?? 0, 0);
    const fog = scene.settings.fog;
    writeVec3(a, "fogColor", fog.color.r, fog.color.g, fog.color.b);
    a.setF32("fogDensity", fog.mode === "none" ? 0 : fog.density);
    writeVec2(a, "fogRange", fog.start, fog.end);
    writeVec2(a, "renderExtent", this.width, this.height);
    a.setF32("shadowDistance", scene.settings.shadow.distance);
    a.setF32("ambientIntensity", scene.settings.ambientIntensity);
    writeVec3(a, "ambientColor", scene.settings.ambientColor.r, scene.settings.ambientColor.g, scene.settings.ambientColor.b);
    a.setF32("toneMapping", TONE_MAP_MODE[scene.settings.toneMapping] ?? 2);
    const flags = (scene.settings.skyEnabled ? 1 : 0) | (scene.settings.hdr ? 2 : 0) | (scene.settings.shadow.enabled ? 8 : 0);
    a.setU32("flags", flags);
    this.device.device.queue.writeBuffer(this.frameBuffer!, 0, gpuSource(this.frameBytes.bytes.subarray(0, this.frameBytes.byteLength)));
    void camera;
  }

  private writeLights(scene: Scene, view: Mat4): number {
    const lights = scene.collectLights();
    const a = this.lightAccessor;
    const count = Math.min(lights.length, MAX_LIGHTS_PER_FRAME);
    a.setI32("count", count);
    let shadowed = 0;
    // Directional lights first, so index 0 is the cascade caster.
    lights.sort((x, y) => (x.kind === "directional" ? 0 : 1) - (y.kind === "directional" ? 0 : 1));
    for (let i = 0; i < count; i++) {
      const l = lights[i]!;
      const e = a.element("lights", i) as StructAccessor;
      const pos = scene.world.worldPosition(l.entity, this.scratchVec);
      writeVec4(e, "positionRange", pos.x, pos.y, pos.z, l.kind === "directional" ? 0 : l.range);
      writeVec4(e, "directionIntensity", l.direction.x, l.direction.y, l.direction.z, l.intensity);
      writeVec3(e, "color", l.color.x, l.color.y, l.color.z);
      writeVec2(e, "spotAngles", l.innerCone, l.outerCone);
      e.setI32("kind", l.kind === "directional" ? 0 : l.kind === "point" ? 1 : 2);
      const casts = l.castShadow && scene.settings.shadow.enabled && l.kind === "directional" && i === 0;
      e.setI32("shadowIndex", casts ? 0 : -1);
      if (casts) shadowed++;
    }
    void view;
    this.device.device.queue.writeBuffer(this.lightBuffer!, 0, gpuSource(this.lightBytes.bytes.subarray(0, this.lightBytes.byteLength)));
    return count;
  }

  private writeShadowUniforms(scene: Scene): Mat4[] {
    const a = this.shadowAccessor;
    const size = Math.max(256, this.options.shadowMapSize ?? 1024);
    const mats: Mat4[] = [];
    const cascades = Math.min(MAX_CASCADES, Math.max(1, scene.settings.shadow.cascades));
    for (let c = 0; c < cascades; c++) {
      // Uniform-splitting scheme: cheap, monotone, and good enough for the outdoor ranges we target.
      const far = scene.settings.shadow.distance * Math.pow((c + 1) / cascades, 1.6);
      const near = Math.max(0.5, far * 0.05);
      const light = this.directionalLight(scene);
      // The box spans [-near, far] behind the eye so casters above the light are not dropped.
      const proj = new Mat4().setOrthographic(-far, far, -far, far, -near, far * 2);
      const dir = light ? light.direction : new Vec3(0, -1, 0);
      const center = this.currentFrameContext?.render?.cameraPositionWorld ?? null;
      const eye = new Vec3(
        (center ? center.x : 0) + dir.x * -far,
        (center ? center.y : 0) + dir.y * -far,
        (center ? center.z : 0) + dir.z * -far,
      );
      const view = new Mat4().setLookAt(eye, center ? new Vec3(center.x, center.y, center.z) : new Vec3(), new Vec3(0, 1, 0));
      const m = new Mat4().multiplyMatrices(proj, view);
      mats.push(m);
      // `cascadeViewProj` is a uniform array of mat4x4: stride 64, so row c starts at offset + 64c.
      const slot = a.struct.field("cascadeViewProj", "uniform");
      const base = (a.offsetBytes + slot.offset + c * slot.stride! * 0) >> 2;
      const strideFloats = (slot.stride ?? 64) >> 2;
      for (let i = 0; i < 16; i++) this.shadowBytes.f32[base + c * strideFloats + i] = m.m[i] ?? 0;
    }
    const splits = a.struct.field("cascadeSplits", "uniform");
    const splitBase = (a.offsetBytes + splits.offset) >> 2;
    for (let c = 0; c < 4; c++) {
      this.shadowBytes.f32[splitBase + c] = c < cascades ? scene.settings.shadow.distance * Math.pow((c + 1) / cascades, 1.6) : 1e9;
    }
    a.setF32("texelSize", 1 / size);
    const light = this.directionalLight(scene);
    a.setF32("depthBias", light ? light.shadowBias : 0.0008);
    a.setF32("normalBias", light ? light.shadowNormalBias : 0.6);
    a.setI32("enabled", 1);
    a.setI32("size", size);
    this.device.device.queue.writeBuffer(this.shadowBuffer!, 0, gpuSource(this.shadowBytes.bytes.subarray(0, this.shadowBytes.byteLength)));
    return mats;
  }

  private directionalLight(scene: Scene): Light | null {
    for (const l of scene.collectLights()) if (l.kind === "directional" && l.castShadow) return l;
    return null;
  }

  private collectBatches(scene: Scene, camera: Camera): void {
    const store = scene.world.store(Renderable);
    const camPos = camera.positionRender;
    for (let i = 0; i < store.count; i++) {
      const r = store.valueAt(i) as Renderable;
      if (!r.visible || !r.geometry || !r.material) continue;
      const entityId = r.entity;
      const transformSlot = scene.world.transformSlot(entityId, true);
      const matrix = scene.world.transforms.worldView(transformSlot);
      // Frustum cull against the world-space AABB (local bounds transformed once, allocation-free).
      r.resolveBounds(this.scratchBox);
      const worldMatrix = new Mat4(matrix as ArrayLike<number>);
      this.scratchBox.transformByMatrix(worldMatrix, this.scratchWorldBox);
      const visible = this.frustum.intersectsAABB(this.scratchWorldBox);
      r.isVisible = visible;
      if (!visible) {
        this.stats.culled++;
        continue;
      }
      if ((r.layer & camera.cullingMask) === 0) continue;
      const geometryKey = `${geometryIdentity(r.geometry)}|${r.material.pipelineKey}|${r.transparent ? "t" : "o"}${r.overlay ? "|ov" : ""}`;
      let index = this.batchIndex.get(geometryKey);
      const instanceOffset = this.instanceArena.reserve(96, 256);
      const base = instanceOffset >> 2;
      const f32 = this.instanceArena.target.f32;
      const u32 = this.instanceArena.target.u32;
      for (let k = 0; k < 16; k++) f32[base + k] = matrix[k] ?? 0;
      u32[base + 16] = r.tint || packColorRGBA(1, 1, 1, 1);
      f32[base + 17] = r.emissive;
      u32[base + 18] = 0;
      u32[base + 19] = 0;
      if (index === undefined) {
        index = this.batches.length;
        this.batchIndex.set(geometryKey, index);
        this.batches.push({
          geometry: r.geometry,
          material: r.material,
          instanceOffset,
          count: 1,
          transparent: r.transparent,
          overlay: r.overlay,
          indexCount: r.geometry.indexCount > 0 ? r.geometry.indexCount : r.geometry.vertexCount,
          indexStart: 0,
          depthSort: -Vec3.distanceSqBetween(camPos, this.scratchWorldBox.getCenter(this.scratchVec)),
          objectOffset: 0,
        });
      } else {
        // Instances must be contiguous to share one draw: the arena cursor is exactly one record
        // past the previous instance of this batch, which is why batches are emitted in one pass.
        const b = this.batches[index]!;
        if (b.instanceOffset + b.count * 96 === instanceOffset) b.count++;
        else {
          index = this.batches.length;
          this.batchIndex.set(geometryKey, index);
          this.batches.push({
            geometry: r.geometry,
            material: r.material,
            instanceOffset,
            count: 1,
            transparent: r.transparent,
            overlay: r.overlay,
            indexCount: r.geometry.indexCount > 0 ? r.geometry.indexCount : r.geometry.vertexCount,
            indexStart: 0,
            depthSort: -Vec3.distanceSqBetween(camPos, this.scratchWorldBox.getCenter(this.scratchVec)),
            objectOffset: 0,
          });
        }
      }
      this.stats.drawCalls++;
    }
  }

  private reserveObject(matrix: Float32Array, instanceCount: number): number {
    const offset = this.objectArena.reserve(ObjectUniforms.byteSize("uniform"), 256);
    const a = new StructAccessor(ObjectUniforms, this.objectArena.target, offset, "uniform");
    writeMatrix(a, "model", matrix);
    a.setU32("instanceCount", instanceCount);
    return offset;
  }

  /** Non-instanced draws read `objectData.model`; the batch's single matrix is stored there. */
  private lastMatrixFor(b: Batch): Float32Array {
    const base = b.instanceOffset >> 2;
    const f = this.instanceArena.target.f32;
    this.scratchMatrix.set(f.subarray(base, base + 16));
    return this.scratchMatrix;
  }

  private readonly scratchMatrix = new Float32Array(16);

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
    const { frame, depthFrame } = this.pipelines.bindGroupLayouts;
    this.depthFrameBindGroup ??= d.createBindGroup({
      label: "depthframe.bindgroup",
      layout: depthFrame,
      entries: [{ binding: 0, resource: { buffer: this.frameBuffer } }],
    });
    this.frameBindGroup ??= d.createBindGroup({
      label: "perframe.bindgroup",
      layout: frame,
      entries: [
        { binding: 0, resource: { buffer: this.frameBuffer } },
        { binding: 1, resource: { buffer: this.lightBuffer } },
        { binding: 2, resource: { buffer: this.shadowBuffer } },
        { binding: 3, resource: this.ensureShadowMap(this.options.shadowMapSize ?? 1024) },
        { binding: 4, resource: this.device.sampler("shadow") },
      ],
    });
    this.ensureArenas();
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

  private ensureDepthTarget(): GPUTextureView {
    const w = this.width;
    const h = this.height;
    if (this.depthView && this.depthWidth === w && this.depthHeight === h) return this.depthView;
    this.depthTexture?.destroy();
    this.depthTexture = this.device.createTexture({
      label: "scene.depth",
      size: [w, h, 1] as unknown as GPUExtent3D,
      format: this.device.depthFormat,
      usage: TextureUsage.RENDER_ATTACHMENT,
    });
    this.depthView = this.depthTexture.createView();
    this.depthWidth = w;
    this.depthHeight = h;
    return this.depthView;
  }

  private ensureShadowMap(size: number): GPUTextureView {
    if (this.shadowView && this.shadowSize === size) return this.shadowView;
    this.shadowTexture?.destroy();
    this.shadowTexture = this.device.createTexture({
      label: "shadow.depth",
      size: [size, size, 1] as unknown as GPUExtent3D,
      format: "depth24plus",
      usage: TextureUsage.RENDER_ATTACHMENT | TextureUsage.TEXTURE_BINDING,
    });
    this.shadowView = this.shadowTexture.createView({ format: "depth24plus", dimension: "2d" } as never);
    this.shadowSize = size;
    return this.shadowView;
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
      sampler: this.device.sampler("linear-clamp"),
    });
    const upload = material.takePendingUpload();
    if (upload) this.device.device.queue.writeBuffer(upload.buffer, 0, gpuSource(upload.bytes));
    const group = material.bindGroup!;
    this.materialGroupCache.set(material, { revision: material.revision, group });
    return group;
  }

  private drawDebugLines(pass: GPURenderPassEncoder): void {
    const bytesPerVertex = 16;
    const size = alignUp(this.debugLineCount * 2 * bytesPerVertex, 4);
    if (size > this.debugBufferCapacity || !this.debugBuffer) {
      this.debugBuffer?.destroy();
      this.debugBufferCapacity = Math.max(size, 4096);
      this.debugBuffer = this.device.device.createBuffer({ label: "debug.lines", size: this.debugBufferCapacity, usage: BufferUsage.VERTEX | BufferUsage.COPY_DST });
    }
    this.device.device.queue.writeBuffer(this.debugBuffer, 0, gpuSource(this.debugLines.subarray(0, (size / 4) | 0)));
    const pipeline = this.pipelines.get({ technique: "debug", colorFormat: this.device.format, depthFormat: this.device.depthFormat, transparent: true, doubleSided: true, instanced: false });
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

  private readonly lastCameraPos = new Vec3();
  private readonly lastCameraWorld = new Double3();

  get cameraPositionWorld(): Double3 {
    return this.lastCameraWorld;
  }

  dispose(): void {
    this.deviceLostUnsub?.dispose();
    this.deviceLostUnsub = null;
    for (const b of [this.frameBuffer, this.lightBuffer, this.shadowBuffer, this.objectBuffer, this.instanceBuffer, this.debugBuffer]) b?.destroy();
    this.frameBuffer = null;
    this.lightBuffer = null;
    this.shadowBuffer = null;
    this.objectBuffer = null;
    this.instanceBuffer = null;
    this.debugBuffer = null;
    this.depthTexture?.destroy();
    this.shadowTexture?.destroy();
    this.depthTexture = null;
    this.shadowTexture = null;
    this.depthView = null;
    this.shadowView = null;
    this.frameBindGroup = null;
    this.depthFrameBindGroup = null;
    this.drawBindGroup = null;
    this.pipelines.invalidate();
    this.defaults.dispose();
  }
}

const TONE_MAP_MODE: Record<string, number> = { none: 0, reinhard: 1, aces: 2, filmic: 3 };

function writeMatrix(a: StructAccessor, name: string, m: Float32Array): void {
  const start = (a.offsetBytes + a.offsetOf(name)) >> 2;
  const target = a.target.f32;
  for (let i = 0; i < 16; i++) target[start + i] = m[i] ?? 0;
}

function writeVec3(a: StructAccessor, name: string, x: number, y: number, z: number): void {
  const start = (a.offsetBytes + a.offsetOf(name)) >> 2;
  const t = a.target.f32;
  t[start] = x;
  t[start + 1] = y;
  t[start + 2] = z;
}

function writeVec2(a: StructAccessor, name: string, x: number, y: number): void {
  const start = (a.offsetBytes + a.offsetOf(name)) >> 2;
  const t = a.target.f32;
  t[start] = x;
  t[start + 1] = y;
}

function writeVec4(a: StructAccessor, name: string, x: number, y: number, z: number, w: number): void {
  const f = a.struct.field(name, "uniform");
  const start = (a.offsetBytes + f.offset) >> 2;
  const target = a.target.f32;
  target[start] = x;
  target[start + 1] = y;
  target[start + 2] = z;
  target[start + 3] = w;
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
