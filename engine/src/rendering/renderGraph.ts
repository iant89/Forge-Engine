/**
 * `RenderGraph` — declarative frame assembly (ARCHITECTURE.md §5.2, docs/RENDERING.md §2).
 *
 * The renderer describes a frame as passes that *read* and *write* named textures; the graph turns
 * that into GPU work. Its job is memory planning and ordering, not synchronization (WebGPU infers
 * barriers), which is why the whole thing is a few hundred lines and not a scheduler:
 *
 *  1. **Validation** — every read of a transient must be preceded by a write (no read-before-write),
 *     a pass may not attach the same texture twice or read what it writes ("single writer per
 *     resource per pass"), and a transient's first use may not `load` (its contents are undefined,
 *     and after aliasing they are *somebody else's*). Violations throw a `UsageError` before any
 *     command is recorded, so a bad frame description costs nothing on the GPU.
 *  2. **Culling** — a pass whose outputs nobody consumes is dropped unless it writes an imported
 *     texture (the swapchain) or is flagged `sideEffect`. Dependencies are tracked per resource
 *     *version*: a `clear` write starts a new version, a `load` write or a read depends on the pass
 *     that produced the current one.
 *  3. **Aliasing** — transient textures with identical descriptors and disjoint live ranges share one
 *     physical `GPUTexture`. `stats.aliasedBytes` reports what that saved; a frame where it saves
 *     nothing is not a bug, it just has no two same-shaped intermediates that do not overlap.
 *  4. **Stable allocation** — physical textures come from a pool keyed by descriptor. Executing the
 *     same topology frame after frame creates nothing; a resize or a toggled pass creates the new
 *     shapes and retires the old ones after `retireAfterFrames` idle frames. `allocationEpoch` bumps
 *     whenever the pool changes so callers can drop bind groups that referenced retired textures.
 *  5. **One command buffer per execute**, each pass wrapped in a debug group with its name.
 *
 * Imported textures (the swapchain texture, editor targets) are never destroyed by the graph.
 * `dispose()` releases every pooled texture; the mock-GPU leak test asserts nothing survives it.
 */

import { UsageError } from "../core/errors.js";
import { textureSizeBytes } from "../gpu/formats.js";
import type { GraphicsDevice } from "../gpu/device.js";

declare const RENDER_GRAPH_HANDLE: unique symbol;
/** Opaque texture handle; only valid for the frame it was created in. */
export type RenderGraphHandle = number & { readonly [RENDER_GRAPH_HANDLE]: true };

export interface RenderGraphTextureDesc {
  width: number;
  height: number;
  format: GPUTextureFormat;
  /** `GPUTextureUsage` bits; `RENDER_ATTACHMENT` is required for anything attached to a pass. */
  usage: number;
  sampleCount?: number;
  mipLevelCount?: number;
  depthOrArrayLayers?: number;
}

export interface RenderGraphViewDesc {
  mipLevel?: number;
  arrayLayer?: number;
  arrayLayerCount?: number;
  dimension?: GPUTextureViewDimension;
  aspect?: GPUTextureAspect;
}

export interface RenderGraphColorAttachment {
  texture: RenderGraphHandle;
  /** Defaults to `"clear"`. */
  loadOp?: GPULoadOp;
  /** Defaults to `"store"`. */
  storeOp?: GPUStoreOp;
  clearValue?: readonly [number, number, number, number];
  view?: RenderGraphViewDesc;
}

export interface RenderGraphDepthAttachment {
  texture: RenderGraphHandle;
  /** Defaults to `"clear"`. */
  depthLoadOp?: GPULoadOp;
  /** Defaults to `"store"`. */
  depthStoreOp?: GPUStoreOp;
  depthClearValue?: number;
  /** A read-only depth attachment counts as a read, not a write. */
  depthReadOnly?: boolean;
  view?: RenderGraphViewDesc;
}

export interface RenderGraphPassContext {
  readonly encoder: GPUCommandEncoder;
  readonly passName: string;
  /** Begin the render pass described by the pass's attachments. The callback must `end()` it. */
  beginRenderPass(label?: string): GPURenderPassEncoder;
  texture(handle: RenderGraphHandle): GPUTexture;
  /** Views are cached per physical texture, so identical requests return the identical object. */
  view(handle: RenderGraphHandle, desc?: RenderGraphViewDesc): GPUTextureView;
  size(handle: RenderGraphHandle): { width: number; height: number };
  /** Format of the pass's colour attachment `index` (what a pipeline targeting it must use). */
  colorFormat(index: number): GPUTextureFormat;
}

export interface RenderGraphPassDesc {
  name: string;
  /** Textures sampled or otherwise read (not attachments). */
  reads?: readonly RenderGraphHandle[];
  color?: readonly RenderGraphColorAttachment[];
  depth?: RenderGraphDepthAttachment;
  /** Keep the pass even when nothing consumes its outputs (queries, readbacks, debug dumps). */
  sideEffect?: boolean;
  execute: (ctx: RenderGraphPassContext) => void;
}

export interface RenderGraphStats {
  /** Passes declared this frame. */
  passes: number;
  /** Passes dropped because nothing consumed their outputs. */
  culledPasses: number;
  /** Names of the passes that executed, in order. */
  executed: string[];
  transientTextures: number;
  /** Physical textures backing the transients (≤ transientTextures when aliasing kicked in). */
  physicalTextures: number;
  /** Bytes the frame's transients occupy after aliasing (what the pool has to hold for this frame). */
  transientBytes: number;
  /** Bytes the transients would have needed without aliasing minus what was allocated. */
  aliasedBytes: number;
  /** Bytes currently held by the pool (including idle textures not yet retired). */
  pooledBytes: number;
  /** Pool textures created / destroyed during this execute. */
  texturesCreated: number;
  texturesDestroyed: number;
  submits: number;
}

export interface RenderGraphOptions {
  /** Idle frames a pooled texture survives before it is destroyed (default 2). */
  retireAfterFrames?: number;
}

interface ResourceNode {
  name: string;
  desc: RenderGraphTextureDesc;
  key: string;
  bytes: number;
  imported: GPUTexture | null;
  /** Live-range in terms of executed pass order. */
  firstUse: number;
  lastUse: number;
  physical: number;
}

interface WriteRef {
  handle: RenderGraphHandle;
  loads: boolean;
  /** Subresource written: `WHOLE`, or "l<layer>/m<mip>" for a single-layer/mip attachment view. */
  sub: string;
}

const WHOLE = "*";

function subresourceOf(v: RenderGraphViewDesc | undefined): string {
  if (!v || (v.arrayLayer === undefined && v.mipLevel === undefined)) return WHOLE;
  return `l${v.arrayLayer ?? 0}/m${v.mipLevel ?? 0}`;
}

interface PassNode {
  desc: RenderGraphPassDesc;
  index: number;
  reads: RenderGraphHandle[];
  writes: WriteRef[];
  dependencies: Set<number>;
  live: boolean;
}

interface PooledTexture {
  key: string;
  texture: GPUTexture;
  bytes: number;
  views: Map<string, GPUTextureView>;
  idleFrames: number;
  usedThisFrame: boolean;
}

const NO_PASS = -1;

export class RenderGraph {
  readonly stats: RenderGraphStats = {
    passes: 0,
    culledPasses: 0,
    executed: [],
    transientTextures: 0,
    physicalTextures: 0,
    transientBytes: 0,
    aliasedBytes: 0,
    pooledBytes: 0,
    texturesCreated: 0,
    texturesDestroyed: 0,
    submits: 0,
  };
  /** Increments whenever a pooled texture is created or destroyed. */
  allocationEpoch = 0;

  private resources: ResourceNode[] = [];
  private passes: PassNode[] = [];
  private readonly pool = new Map<string, PooledTexture[]>();
  private readonly retireAfterFrames: number;
  private disposed = false;
  private building = false;

  constructor(
    readonly device: GraphicsDevice,
    options: RenderGraphOptions = {},
  ) {
    this.retireAfterFrames = Math.max(0, options.retireAfterFrames ?? 2);
  }

  /** Start describing a frame. Handles from a previous frame are invalid after this. */
  begin(): void {
    if (this.disposed) throw new UsageError("RenderGraph.begin: graph is disposed");
    this.resources = [];
    this.passes = [];
    this.building = true;
  }

  createTexture(name: string, desc: RenderGraphTextureDesc): RenderGraphHandle {
    this.assertBuilding("createTexture");
    if (!(desc.width >= 1) || !(desc.height >= 1)) throw new UsageError(`RenderGraph.createTexture("${name}"): size must be at least 1x1 (got ${desc.width}x${desc.height})`);
    if (!Number.isInteger(desc.width) || !Number.isInteger(desc.height)) throw new UsageError(`RenderGraph.createTexture("${name}"): size must be integral`);
    const normalized: RenderGraphTextureDesc = {
      width: desc.width,
      height: desc.height,
      format: desc.format,
      usage: desc.usage,
      sampleCount: desc.sampleCount ?? 1,
      mipLevelCount: desc.mipLevelCount ?? 1,
      depthOrArrayLayers: desc.depthOrArrayLayers ?? 1,
    };
    return this.push({
      name,
      desc: normalized,
      key: descKey(normalized),
      bytes: estimateBytes(normalized),
      imported: null,
      firstUse: NO_PASS,
      lastUse: NO_PASS,
      physical: -1,
    });
  }

  /** Register an externally owned texture (swapchain, editor target). Never destroyed by the graph. */
  importTexture(name: string, texture: GPUTexture): RenderGraphHandle {
    this.assertBuilding("importTexture");
    const desc: RenderGraphTextureDesc = {
      width: texture.width,
      height: texture.height,
      format: texture.format,
      usage: texture.usage,
      sampleCount: texture.sampleCount,
      mipLevelCount: texture.mipLevelCount,
      depthOrArrayLayers: texture.depthOrArrayLayers,
    };
    return this.push({ name, desc, key: descKey(desc), bytes: 0, imported: texture, firstUse: NO_PASS, lastUse: NO_PASS, physical: -1 });
  }

  addPass(desc: RenderGraphPassDesc): void {
    this.assertBuilding("addPass");
    const index = this.passes.length;
    const reads = [...(desc.reads ?? [])];
    const writes: WriteRef[] = [];
    const attached = new Set<number>();
    for (const c of desc.color ?? []) {
      this.resolve(c.texture, desc.name);
      if (attached.has(c.texture)) throw new UsageError(`RenderGraph pass "${desc.name}" attaches "${this.resources[c.texture]!.name}" twice`);
      attached.add(c.texture);
      writes.push({ handle: c.texture, loads: (c.loadOp ?? "clear") === "load", sub: subresourceOf(c.view) });
    }
    if (desc.depth) {
      const d = desc.depth;
      this.resolve(d.texture, desc.name);
      if (attached.has(d.texture)) throw new UsageError(`RenderGraph pass "${desc.name}" attaches "${this.resources[d.texture]!.name}" as both colour and depth`);
      attached.add(d.texture);
      if (d.depthReadOnly) reads.push(d.texture);
      else writes.push({ handle: d.texture, loads: (d.depthLoadOp ?? "clear") === "load", sub: subresourceOf(d.view) });
    }
    for (const r of reads) {
      this.resolve(r, desc.name);
      if (attached.has(r) && !(desc.depth?.depthReadOnly && desc.depth.texture === r)) {
        throw new UsageError(`RenderGraph pass "${desc.name}" both reads and writes "${this.resources[r]!.name}" (a pass may not sample its own attachment)`);
      }
    }
    this.passes.push({ desc, index, reads, writes, dependencies: new Set(), live: false });
  }

  /** Compile (validate, cull, alias, allocate) and record + submit the frame as one command buffer. */
  execute(): RenderGraphStats {
    this.assertBuilding("execute");
    this.building = false;
    const stats = this.stats;
    stats.passes = this.passes.length;
    stats.texturesCreated = 0;
    stats.texturesDestroyed = 0;
    stats.executed = [];

    this.resolveDependencies();
    const live = this.cull();
    stats.culledPasses = this.passes.length - live.length;
    this.computeLiveRanges(live);
    const physical = this.assignPhysical();
    this.allocate(physical);

    // Record.
    const device = this.device.device;
    const encoder = device.createCommandEncoder({ label: "forge.frame" });
    const viewCache = new Map<string, GPUTextureView>();
    for (const pass of live) {
      encoder.pushDebugGroup(pass.desc.name);
      const ctx = this.contextFor(pass, encoder, physical, viewCache);
      try {
        pass.desc.execute(ctx);
      } finally {
        encoder.popDebugGroup();
      }
      stats.executed.push(pass.desc.name);
    }
    device.queue.submit([encoder.finish()]);
    stats.submits++;
    this.retireIdle();
    return stats;
  }

  /** Destroy every pooled texture. Safe to call twice. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const list of this.pool.values()) {
      for (const p of list) {
        p.texture.destroy();
        this.stats.texturesDestroyed++;
        this.allocationEpoch++;
      }
    }
    this.pool.clear();
    this.stats.pooledBytes = 0;
    this.resources = [];
    this.passes = [];
  }

  /** Physical texture count currently pooled (idle ones included). */
  get pooledTextureCount(): number {
    let n = 0;
    for (const list of this.pool.values()) n += list.length;
    return n;
  }

  // ------------------------------------------------------------------ compile steps

  private resolveDependencies(): void {
    // Version tracking per *subresource*: the producer of the current contents of each (texture,
    // layer, mip). Passes that clear different layers of one texture (the shadow cascades) are
    // independent writers, and a reader of the whole texture depends on all of them.
    const producers = new Map<number, Map<string, number>>();
    const producersOf = (h: RenderGraphHandle): Map<string, number> => {
      let m = producers.get(h);
      if (!m) {
        m = new Map();
        producers.set(h, m);
      }
      return m;
    };
    for (const pass of this.passes) {
      for (const r of pass.reads) {
        const res = this.resources[r]!;
        const m = producers.get(r);
        if (!m || m.size === 0) {
          if (!res.imported) throw new UsageError(`RenderGraph pass "${pass.desc.name}" reads "${res.name}" before any pass has written it`);
          continue;
        }
        for (const p of m.values()) pass.dependencies.add(p);
      }
      for (const w of pass.writes) {
        const res = this.resources[w.handle]!;
        const m = producersOf(w.handle);
        // A `clear` write starts a fresh version: overwriting is not a data dependency (and
        // insertion order already keeps the previous writer ahead of us). A `load` write consumes
        // the current version exactly like a read does.
        if (!w.loads) continue;
        const p = m.get(w.sub) ?? (w.sub === WHOLE ? undefined : m.get(WHOLE));
        if (p === undefined) {
          if (!res.imported) throw new UsageError(`RenderGraph pass "${pass.desc.name}" loads "${res.name}" before any pass has written it (transient contents are undefined)`);
          continue;
        }
        pass.dependencies.add(p);
      }
      for (const w of pass.writes) {
        const m = producersOf(w.handle);
        if (w.sub === WHOLE) m.clear();
        m.set(w.sub, pass.index);
      }
    }
  }

  private cull(): PassNode[] {
    const stack: PassNode[] = [];
    for (const pass of this.passes) {
      const root = pass.desc.sideEffect === true || pass.writes.some((w) => this.resources[w.handle]!.imported !== null);
      if (root) {
        pass.live = true;
        stack.push(pass);
      }
    }
    while (stack.length > 0) {
      const pass = stack.pop()!;
      for (const dep of pass.dependencies) {
        const p = this.passes[dep]!;
        if (!p.live) {
          p.live = true;
          stack.push(p);
        }
      }
    }
    return this.passes.filter((p) => p.live);
  }

  private computeLiveRanges(live: PassNode[]): void {
    for (const res of this.resources) {
      res.firstUse = NO_PASS;
      res.lastUse = NO_PASS;
      res.physical = -1;
    }
    live.forEach((pass, order) => {
      const touch = (h: RenderGraphHandle) => {
        const res = this.resources[h]!;
        if (res.firstUse === NO_PASS) res.firstUse = order;
        res.lastUse = order;
      };
      for (const r of pass.reads) touch(r);
      for (const w of pass.writes) touch(w.handle);
    });
  }

  /** Greedy interval colouring: same-descriptor transients with disjoint live ranges share a slot. */
  private assignPhysical(): { key: string; desc: RenderGraphTextureDesc; lastUse: number; bytes: number; texture: PooledTexture | null }[] {
    const slots: { key: string; desc: RenderGraphTextureDesc; lastUse: number; bytes: number; texture: PooledTexture | null }[] = [];
    const transients = this.resources.filter((r) => !r.imported && r.firstUse !== NO_PASS).sort((a, b) => a.firstUse - b.firstUse || a.lastUse - b.lastUse);
    let requested = 0;
    for (const res of transients) {
      requested += res.bytes;
      let slot = -1;
      for (let i = 0; i < slots.length; i++) {
        const s = slots[i]!;
        if (s.key === res.key && s.lastUse < res.firstUse) {
          slot = i;
          break;
        }
      }
      if (slot < 0) {
        slot = slots.length;
        slots.push({ key: res.key, desc: res.desc, lastUse: res.lastUse, bytes: res.bytes, texture: null });
      } else {
        slots[slot]!.lastUse = res.lastUse;
      }
      res.physical = slot;
    }
    let allocated = 0;
    for (const s of slots) allocated += s.bytes;
    this.stats.transientTextures = transients.length;
    this.stats.physicalTextures = slots.length;
    this.stats.transientBytes = allocated;
    this.stats.aliasedBytes = requested - allocated;
    return slots;
  }

  private allocate(slots: { key: string; desc: RenderGraphTextureDesc; texture: PooledTexture | null }[]): void {
    for (const list of this.pool.values()) for (const p of list) p.usedThisFrame = false;
    const taken = new Map<string, number>();
    for (const slot of slots) {
      const n = taken.get(slot.key) ?? 0;
      taken.set(slot.key, n + 1);
      let list = this.pool.get(slot.key);
      if (!list) {
        list = [];
        this.pool.set(slot.key, list);
      }
      let pooled = list[n];
      if (!pooled) {
        const d = slot.desc;
        const texture = this.device.createTexture({
          label: `rg.${slot.key}#${n}`,
          size: { width: d.width, height: d.height, depthOrArrayLayers: d.depthOrArrayLayers ?? 1 },
          format: d.format,
          usage: d.usage,
          sampleCount: d.sampleCount ?? 1,
          mipLevelCount: d.mipLevelCount ?? 1,
        });
        pooled = { key: slot.key, texture, bytes: estimateBytes(d), views: new Map(), idleFrames: 0, usedThisFrame: true };
        list.push(pooled);
        this.stats.texturesCreated++;
        this.stats.pooledBytes += pooled.bytes;
        this.allocationEpoch++;
      }
      pooled.usedThisFrame = true;
      pooled.idleFrames = 0;
      slot.texture = pooled;
    }
  }

  private retireIdle(): void {
    for (const [key, list] of this.pool) {
      for (let i = list.length - 1; i >= 0; i--) {
        const p = list[i]!;
        if (p.usedThisFrame) continue;
        p.idleFrames++;
        if (p.idleFrames > this.retireAfterFrames) {
          p.texture.destroy();
          list.splice(i, 1);
          this.stats.texturesDestroyed++;
          this.stats.pooledBytes -= p.bytes;
          this.allocationEpoch++;
        }
      }
      if (list.length === 0) this.pool.delete(key);
    }
  }

  // ------------------------------------------------------------------ execution helpers

  private contextFor(
    pass: PassNode,
    encoder: GPUCommandEncoder,
    slots: { texture: PooledTexture | null }[],
    importedViews: Map<string, GPUTextureView>,
  ): RenderGraphPassContext {
    const resources = this.resources;
    const texture = (handle: RenderGraphHandle): GPUTexture => {
      const res = resources[handle];
      if (!res) throw new UsageError(`RenderGraph pass "${pass.desc.name}": unknown texture handle ${handle}`);
      if (res.imported) return res.imported;
      const slot = slots[res.physical];
      if (!slot?.texture) throw new UsageError(`RenderGraph pass "${pass.desc.name}": "${res.name}" is not used by any executed pass`);
      return slot.texture.texture;
    };
    const view = (handle: RenderGraphHandle, desc?: RenderGraphViewDesc): GPUTextureView => {
      const res = resources[handle]!;
      const key = viewKey(desc);
      if (res.imported) {
        const cacheKey = `${handle}|${key}`;
        let v = importedViews.get(cacheKey);
        if (!v) {
          v = res.imported.createView(viewDescriptor(res.desc, desc, `rg.${res.name}.view`));
          importedViews.set(cacheKey, v);
        }
        return v;
      }
      const pooled = slots[res.physical]?.texture;
      if (!pooled) throw new UsageError(`RenderGraph pass "${pass.desc.name}": "${res.name}" has no physical texture`);
      let v = pooled.views.get(key);
      if (!v) {
        v = pooled.texture.createView(viewDescriptor(res.desc, desc, `${pooled.texture.label}.${key}`));
        pooled.views.set(key, v);
      }
      return v;
    };
    const size = (handle: RenderGraphHandle): { width: number; height: number } => {
      const res = resources[handle]!;
      return { width: res.desc.width, height: res.desc.height };
    };
    const beginRenderPass = (label?: string): GPURenderPassEncoder => {
      const colorAttachments: GPURenderPassColorAttachment[] = (pass.desc.color ?? []).map((c) => ({
        view: view(c.texture, c.view),
        loadOp: c.loadOp ?? "clear",
        storeOp: c.storeOp ?? "store",
        clearValue: c.clearValue ? { r: c.clearValue[0], g: c.clearValue[1], b: c.clearValue[2], a: c.clearValue[3] } : { r: 0, g: 0, b: 0, a: 1 },
      }));
      const d = pass.desc.depth;
      const depthStencilAttachment: GPURenderPassDepthStencilAttachment | undefined = d
        ? d.depthReadOnly
          ? { view: view(d.texture, d.view), depthReadOnly: true }
          : {
              view: view(d.texture, d.view),
              depthLoadOp: d.depthLoadOp ?? "clear",
              depthStoreOp: d.depthStoreOp ?? "store",
              depthClearValue: d.depthClearValue ?? 1,
            }
        : undefined;
      return encoder.beginRenderPass({ label: label ?? pass.desc.name, colorAttachments, depthStencilAttachment });
    };
    const colorFormat = (index: number): GPUTextureFormat => {
      const c = pass.desc.color?.[index];
      if (!c) throw new UsageError(`RenderGraph pass "${pass.desc.name}" has no colour attachment ${index}`);
      return resources[c.texture]!.desc.format;
    };
    return { encoder, passName: pass.desc.name, beginRenderPass, texture, view, size, colorFormat };
  }

  private push(node: ResourceNode): RenderGraphHandle {
    this.resources.push(node);
    return (this.resources.length - 1) as RenderGraphHandle;
  }

  private resolve(handle: RenderGraphHandle, passName: string): ResourceNode {
    const res = this.resources[handle];
    if (!res) throw new UsageError(`RenderGraph pass "${passName}": texture handle ${handle} does not belong to this frame`);
    return res;
  }

  private assertBuilding(what: string): void {
    if (this.disposed) throw new UsageError(`RenderGraph.${what}: graph is disposed`);
    if (!this.building) throw new UsageError(`RenderGraph.${what}: call begin() first`);
  }
}

function descKey(d: RenderGraphTextureDesc): string {
  return `${d.width}x${d.height}x${d.depthOrArrayLayers ?? 1}:${d.format}:u${d.usage}:s${d.sampleCount ?? 1}:m${d.mipLevelCount ?? 1}`;
}

function estimateBytes(d: RenderGraphTextureDesc): number {
  return textureSizeBytes({ format: d.format, width: d.width, height: d.height, depthOrArrayLayers: d.depthOrArrayLayers ?? 1, mipLevelCount: d.mipLevelCount ?? 1 }) * (d.sampleCount ?? 1);
}

function viewKey(v?: RenderGraphViewDesc): string {
  if (!v) return "default";
  return `${v.dimension ?? "-"}:${v.mipLevel ?? 0}:${v.arrayLayer ?? 0}:${v.arrayLayerCount ?? "-"}:${v.aspect ?? "all"}`;
}

function viewDescriptor(tex: RenderGraphTextureDesc, v: RenderGraphViewDesc | undefined, label: string): GPUTextureViewDescriptor {
  const layers = tex.depthOrArrayLayers ?? 1;
  if (!v) {
    // Default view of a layered texture is a 2d-array in WebGPU; for a single layer it is 2d.
    return { label, dimension: layers > 1 ? "2d-array" : "2d" };
  }
  const desc: GPUTextureViewDescriptor = { label };
  if (v.dimension) desc.dimension = v.dimension;
  else desc.dimension = v.arrayLayerCount !== undefined && v.arrayLayerCount > 1 ? "2d-array" : v.arrayLayer !== undefined ? "2d" : layers > 1 ? "2d-array" : "2d";
  if (v.mipLevel !== undefined) {
    desc.baseMipLevel = v.mipLevel;
    desc.mipLevelCount = 1;
  }
  if (v.arrayLayer !== undefined) {
    desc.baseArrayLayer = v.arrayLayer;
    desc.arrayLayerCount = v.arrayLayerCount ?? 1;
  } else if (v.arrayLayerCount !== undefined) {
    desc.arrayLayerCount = v.arrayLayerCount;
  }
  if (v.aspect) desc.aspect = v.aspect;
  return desc;
}
