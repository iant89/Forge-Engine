/**
 * `UIGpuRenderer` — draws a `UIManager` with WebGPU as a render-graph overlay.
 *
 * ```ts
 * const ui = new UIManager({ width: canvas.width, height: canvas.height, devicePixelRatio: dpr });
 * const uiRenderer = new UIGpuRenderer(engine.gpu, ui);
 * const overlay = engine.renderer.addOverlay(uiRenderer);
 * // per frame, before engine.step(): ui.update(dt)
 * ```
 *
 * Per recorded frame: `ui.render()` (a cached draw list unless the UI is render-dirty), upload the
 * instance buffer only when the list was rebuilt, upload only the dirty rows of atlas pages whose
 * version changed, then one `forge.ui` pass that **loads** the swapchain and issues one instanced
 * draw per batch (a batch changes only when the bound texture changes). The pass creates no graph
 * transients, so a steady frame still allocates nothing.
 *
 * Ownership: every buffer, texture, sampler and bind group created here is destroyed by `dispose()`
 * (and textures of unregistered assets are destroyed when noticed). `gpu`-kind asset textures are the
 * application's and are never destroyed here.
 */

import { BufferUsage, ShaderStage, TextureUsage, gpuSource } from "../../gpu/constants.js";
import type { GraphicsDevice } from "../../gpu/device.js";
import { ShaderCache } from "../../gpu/shaderCache.js";
import type { RenderGraph, RenderGraphHandle, RenderGraphPassContext } from "../../rendering/renderGraph.js";
import type { RenderOverlay, RenderOverlayFrame } from "../../rendering/renderer.js";
import type { UIManager } from "../manager.js";
import type { UIDrawList } from "../render/drawList.js";
import { INSTANCE_BYTES } from "../render/drawList.js";
import type { UIAtlasPage } from "../text/font.js";
import type { UITextureSource } from "../render/assets.js";
import { UI_FRAME_STRUCT, UI_SHADER } from "./shader.js";

interface GpuTextureEntry {
  source: UITextureSource;
  texture: GPUTexture;
  view: GPUTextureView;
  bindGroup: GPUBindGroup;
  owned: boolean;
  /** Uploaded page version (pixels sources). */
  version: number;
}

export interface UIGpuStats {
  drawCalls: number;
  instances: number;
  instanceUploads: number;
  uploadedBytes: number;
  textures: number;
  pipelines: number;
  recordedFrames: number;
}

const LABEL = "forge.ui";

export class UIGpuRenderer implements RenderOverlay {
  readonly name = LABEL;
  private readonly shaders: ShaderCache;
  private readonly pipelines = new Map<GPUTextureFormat, GPURenderPipeline>();
  private readonly frameLayout: GPUBindGroupLayout;
  private readonly textureLayout: GPUBindGroupLayout;
  private readonly pipelineLayout: GPUPipelineLayout;
  private readonly uniform: GPUBuffer;
  private readonly frameBindGroup: GPUBindGroup;
  private readonly sampler: GPUSampler;
  private readonly white: GpuTextureEntry;
  private readonly textures = new Map<string, GpuTextureEntry>();
  private instanceBuffer: GPUBuffer | null = null;
  private instanceCapacity = 0;
  private uploadedListVersion = -1;
  private assetsVersion = -1;
  private readonly uniformData = new Float32Array(4);
  private disposed = false;
  readonly stats: UIGpuStats = { drawCalls: 0, instances: 0, instanceUploads: 0, uploadedBytes: 0, textures: 0, pipelines: 0, recordedFrames: 0 };
  /** Batch textures that had no GPU texture (reported once each). */
  private readonly reportedMissing = new Set<string>();
  /** Pixel pages seen at the last sync (needsRender polls their versions without allocating). */
  private pages: { page: UIAtlasPage; entry: GpuTextureEntry }[] = [];

  constructor(
    private readonly device: GraphicsDevice,
    readonly ui: UIManager,
  ) {
    const gpu = device.device;
    this.shaders = new ShaderCache(device);
    this.frameLayout = gpu.createBindGroupLayout({
      label: `${LABEL}.frame`,
      entries: [{ binding: 0, visibility: ShaderStage.VERTEX | ShaderStage.FRAGMENT, buffer: { type: "uniform" } }],
    });
    this.textureLayout = gpu.createBindGroupLayout({
      label: `${LABEL}.texture`,
      entries: [
        { binding: 0, visibility: ShaderStage.FRAGMENT, texture: { sampleType: "float", viewDimension: "2d" } },
        { binding: 1, visibility: ShaderStage.FRAGMENT, sampler: { type: "filtering" } },
      ],
    });
    this.pipelineLayout = gpu.createPipelineLayout({ label: LABEL, bindGroupLayouts: [this.frameLayout, this.textureLayout] });
    this.uniform = gpu.createBuffer({ label: `${LABEL}.frame`, size: UI_FRAME_STRUCT.size("uniform"), usage: BufferUsage.UNIFORM | BufferUsage.COPY_DST });
    this.frameBindGroup = gpu.createBindGroup({ label: `${LABEL}.frame`, layout: this.frameLayout, entries: [{ binding: 0, resource: { buffer: this.uniform } }] });
    this.sampler = gpu.createSampler({ label: LABEL, magFilter: "linear", minFilter: "linear", addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge" });
    const whiteTex = gpu.createTexture({ label: `${LABEL}.white`, size: [1, 1, 1], format: "rgba8unorm", usage: TextureUsage.TEXTURE_BINDING | TextureUsage.COPY_DST });
    gpu.queue.writeTexture({ texture: whiteTex }, gpuSource(new Uint8Array([255, 255, 255, 255])), { bytesPerRow: 4 }, [1, 1, 1]);
    const whiteView = whiteTex.createView();
    this.white = {
      source: { kind: "gpu", width: 1, height: 1, texture: whiteTex },
      texture: whiteTex,
      view: whiteView,
      bindGroup: this.makeTextureBindGroup(whiteView, "white"),
      owned: true,
      version: 1,
    };
  }

  private makeTextureBindGroup(view: GPUTextureView, name: string): GPUBindGroup {
    return this.device.device.createBindGroup({
      label: `${LABEL}.tex.${name}`,
      layout: this.textureLayout,
      entries: [
        { binding: 0, resource: view },
        { binding: 1, resource: this.sampler },
      ],
    });
  }

  private pipelineFor(format: GPUTextureFormat): GPURenderPipeline {
    let p = this.pipelines.get(format);
    if (p) return p;
    const module = this.shaders.get(LABEL, UI_SHADER);
    const attrs: GPUVertexAttribute[] = [];
    for (let i = 0; i < 9; i++) attrs.push({ shaderLocation: i, offset: i * 16, format: "float32x4" });
    p = this.device.device.createRenderPipeline({
      label: `${LABEL}.${format}`,
      layout: this.pipelineLayout,
      vertex: { module, entryPoint: "vsMain", buffers: [{ arrayStride: INSTANCE_BYTES, stepMode: "instance", attributes: attrs }] },
      fragment: {
        module,
        entryPoint: "fsMain",
        targets: [
          {
            format,
            blend: {
              color: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
              alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
            },
          },
        ],
      },
      primitive: { topology: "triangle-list", cullMode: "none" },
    });
    this.pipelines.set(format, p);
    this.stats.pipelines = this.pipelines.size;
    return p;
  }

  /** True when the UI has something new to draw (or an atlas page changed). */
  get needsRender(): boolean {
    if (this.disposed) return false;
    if (this.ui.needsRender || this.ui.drawListVersion !== this.uploadedListVersion || this.ui.assets.version !== this.assetsVersion) return true;
    for (const p of this.pages) if (p.page.version !== p.entry.version) return true;
    return false;
  }

  // ------------------------------------------------------------------ textures

  private syncTextures(): void {
    const assets = this.ui.assets;
    if (assets.version !== this.assetsVersion) {
      // Drop textures whose asset was unregistered or replaced by a different source.
      for (const [name, entry] of this.textures) {
        const src = assets.texture(name);
        if (src !== entry.source) {
          if (entry.owned) entry.texture.destroy();
          this.textures.delete(name);
        }
      }
      this.assetsVersion = assets.version;
    }
    for (const name of assets.textureNames()) {
      const src = assets.texture(name)!;
      let entry = this.textures.get(name);
      if (!entry) {
        entry = this.createTexture(name, src);
        this.textures.set(name, entry);
      }
      if (src.kind === "pixels" && entry.version !== src.page.version) this.uploadPage(entry, src.page);
    }
    this.pages = [];
    for (const e of this.textures.values()) if (e.source.kind === "pixels") this.pages.push({ page: e.source.page, entry: e });
    this.stats.textures = this.textures.size;
  }

  private createTexture(name: string, src: UITextureSource): GpuTextureEntry {
    const gpu = this.device.device;
    if (src.kind === "gpu") {
      const view = src.texture.createView();
      return { source: src, texture: src.texture, view, bindGroup: this.makeTextureBindGroup(view, name), owned: false, version: 1 };
    }
    const width = src.kind === "pixels" ? src.page.width : src.width;
    const height = src.kind === "pixels" ? src.page.height : src.height;
    const format: GPUTextureFormat = src.kind === "pixels" ? src.page.format : "rgba8unorm";
    const usage = TextureUsage.TEXTURE_BINDING | TextureUsage.COPY_DST | (src.kind === "image" ? TextureUsage.RENDER_ATTACHMENT : 0);
    const texture = this.device.createTexture({ label: `${LABEL}.${name}`, size: [width, height, 1], format, usage });
    const view = texture.createView();
    const entry: GpuTextureEntry = { source: src, texture, view, bindGroup: this.makeTextureBindGroup(view, name), owned: true, version: 0 };
    if (src.kind === "image") {
      const queue = gpu.queue as GPUQueue & { copyExternalImageToTexture?: GPUQueue["copyExternalImageToTexture"] };
      if (typeof queue.copyExternalImageToTexture === "function") {
        queue.copyExternalImageToTexture({ source: src.image as ImageBitmap }, { texture }, [width, height]);
      }
      entry.version = 1;
    }
    return entry;
  }

  private uploadPage(entry: GpuTextureEntry, page: UIAtlasPage): void {
    const bpp = page.format === "r8unorm" ? 1 : 4;
    const fresh = entry.version === 0;
    const y0 = fresh ? 0 : Math.max(0, page.dirtyY0);
    const y1 = fresh ? page.height : Math.min(page.height, page.dirtyY1);
    if (y1 > y0) {
      const bytesPerRow = page.width * bpp;
      const data = page.data.subarray(y0 * bytesPerRow, y1 * bytesPerRow);
      this.device.device.queue.writeTexture({ texture: entry.texture, origin: [0, y0, 0] }, gpuSource(data), { bytesPerRow, rowsPerImage: y1 - y0 }, [page.width, y1 - y0, 1]);
      this.stats.uploadedBytes += data.byteLength;
    }
    page.clearDirty();
    entry.version = page.version;
  }

  // ------------------------------------------------------------------ frame

  private uploadInstances(list: UIDrawList): void {
    if (list.version === this.uploadedListVersion) return;
    const bytes = list.count * INSTANCE_BYTES;
    if (bytes > this.instanceCapacity || !this.instanceBuffer) {
      this.instanceBuffer?.destroy();
      this.instanceCapacity = Math.max(bytes, INSTANCE_BYTES * 256, this.instanceCapacity * 2);
      this.instanceBuffer = this.device.device.createBuffer({ label: `${LABEL}.instances`, size: this.instanceCapacity, usage: BufferUsage.VERTEX | BufferUsage.COPY_DST });
    }
    if (bytes > 0) {
      this.device.device.queue.writeBuffer(this.instanceBuffer, 0, gpuSource(list.data.subarray(0, list.count * (INSTANCE_BYTES / 4))));
      this.stats.uploadedBytes += bytes;
      this.stats.instanceUploads++;
    }
    this.uploadedListVersion = list.version;
  }

  record(graph: RenderGraph, target: RenderGraphHandle, frame: RenderOverlayFrame): void {
    if (this.disposed) return;
    const vp = this.ui.viewport;
    if (vp.physicalWidth !== frame.width || vp.physicalHeight !== frame.height) {
      // The swapchain was resized without telling the UI: follow it (same device pixel ratio) so
      // what is drawn and what is hit-tested keep using one scale.
      this.ui.setViewport(frame.width, frame.height, vp.devicePixelRatio);
      this.ui.update(0);
    }
    const list = this.ui.render();
    this.syncTextures();
    this.uploadInstances(list);
    this.stats.instances = list.count;
    this.stats.recordedFrames++;
    if (list.count === 0) {
      this.stats.drawCalls = 0;
      return;
    }
    const u = this.uniformData;
    u[0] = frame.width;
    u[1] = frame.height;
    u[2] = vp.scale;
    u[3] = this.ui.time;
    this.device.device.queue.writeBuffer(this.uniform, 0, gpuSource(u));
    graph.addPass({
      name: LABEL,
      color: [{ texture: target, loadOp: "load" }],
      execute: (ctx) => this.execute(ctx, list),
    });
  }

  private execute(ctx: RenderGraphPassContext, list: UIDrawList): void {
    const pass = ctx.beginRenderPass(LABEL);
    pass.setPipeline(this.pipelineFor(ctx.colorFormat(0)));
    pass.setBindGroup(0, this.frameBindGroup);
    pass.setVertexBuffer(0, this.instanceBuffer!);
    let draws = 0;
    for (const b of list.batches) {
      let entry = this.white;
      if (b.texture !== null) {
        const t = this.textures.get(b.texture);
        if (t) entry = t;
        else if (!this.reportedMissing.has(b.texture)) {
          this.reportedMissing.add(b.texture);
          this.ui.diagnostic("warn", `ui gpu: texture "${b.texture}" has no GPU upload (drawn untextured)`);
        }
      }
      pass.setBindGroup(1, entry.bindGroup);
      pass.draw(6, b.count, 0, b.first);
      draws++;
    }
    pass.end();
    this.stats.drawCalls = draws;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const e of this.textures.values()) if (e.owned) e.texture.destroy();
    this.textures.clear();
    this.white.texture.destroy();
    this.instanceBuffer?.destroy();
    this.instanceBuffer = null;
    this.uniform.destroy();
  }
}
