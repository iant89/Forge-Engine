/**
 * A strict WebGPU test double.
 *
 * Why this exists: no headless browser with WebGPU is available in the development container, yet
 * almost everything that can break in a WebGPU renderer breaks *before* rasterization — invalid
 * descriptors, bind-group/layout mismatches, wrong vertex strides, attachment format mismatches,
 * unaligned buffer offsets, destroyed resources still referenced, and GPU resources that are never
 * released. This mock checks all of those, so the engine's GPU-facing code is covered by ordinary
 * unit tests instead of being untested glue. See docs/TESTING.md for the split between this and
 * the real-browser test suite (`npm run test:gpu`).
 *
 * It implements, with validation:
 *  - adapter/device/queue, canvas context (swapchain-sized textures), error scopes, device loss
 *  - buffers: size/usage rules, mapping states, `mappedAtCreation`, getMappedRange alignment
 *  - textures: dimension/mip/sample/format/usage rules + CPU-backed texel storage so clears and
 *    copies move real bytes (tests can assert which pass wrote which texture)
 *  - bind group layouts & groups: binding presence, visibility, buffer type/usage/size,
 *    uniform vs storage offset alignment (256), `minBindingSize`
 *  - pipelines: vertex buffer stride/attribute bounds, shader location uniqueness, fragment target
 *    count, depth format validity, sample count consistency
 *  - passes: attachment format match against the pipeline, load/store ops, viewport/scissor,
 *    draw-after-pipeline, vertex buffer coverage, index range, dynamic-offset counts
 *  - encoder copies: buffer/texture usage bits, bytesPerRow 256-alignment, bounds
 *  - `resolveQuerySet` (usage + alignment), timestamp emulation (monotonic fake clocks)
 *  - memory accounting + create/destroy counters → leak assertions
 *
 * It does NOT rasterize or execute WGSL (no pixel results, no shader semantics). Shader sources are
 * still checked structurally (entry points, balanced braces) and their uniform/storage layouts are
 * verified against the TS layout definitions by `tools/wgsl-check.mjs`.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { BufferUsage, TextureUsage, ShaderStage, COPY_BYTES_PER_ROW_ALIGNMENT, MIN_OFFSET_ALIGNMENT } from "../gpu/constants.js";
import { formatInfo, isKnownFormat } from "../gpu/formats.js";

export interface MockGpuOptions {
  /** Throw synchronously on the first validation error, so failures point at the offending call. */
  strict?: boolean;
  features?: Iterable<string>;
  limits?: Partial<Record<string, number>>;
  /** Mock enforces this like a budget (an OOM error rather than a real driver failure). */
  maxMemoryBytes?: number;
  /** Simulate device loss after N submissions (recovery-path tests). */
  loseAfterSubmissions?: number;
  preferredCanvasFormat?: GPUTextureFormat;
  /** Record every command into `device.commandLog` (default true). */
  recordCommands?: boolean;
  /** Reject creation of formats the mock does not model (default true). */
  checkFormats?: boolean;
}

export type MockResourceKind =
  | "buffer"
  | "texture"
  | "view"
  | "sampler"
  | "bindGroupLayout"
  | "pipelineLayout"
  | "bindGroup"
  | "shaderModule"
  | "renderPipeline"
  | "computePipeline"
  | "querySet";

export interface MockMemoryStats {
  liveBuffers: number;
  bufferBytes: number;
  liveTextures: number;
  textureBytes: number;
  liveViews: number;
  liveBindGroups: number;
  livePipelines: number;
  totalBytes: number;
  created: Partial<Record<MockResourceKind, number>>;
  destroyed: Partial<Record<MockResourceKind, number>>;
}

export interface MockPassRecord {
  label: string;
  kind: "render" | "compute";
  drawCalls: number;
  triangles: number;
  instances: number;
  colorTargets: string[];
  depthTarget: string | null;
  /** Depth store op of a render pass (`"read-only"` when the attachment was bound read-only). */
  depthStoreOp: "store" | "discard" | "read-only" | null;
  dispatches: number;
}

export interface CommandLogEntry {
  type:
    | "renderPass"
    | "computePass"
    | "passEnd"
    | "draw"
    | "drawIndexed"
    | "dispatch"
    | "setPipeline"
    | "setBindGroup"
    | "setVertexBuffer"
    | "setIndexBuffer"
    | "copyB2B"
    | "copyB2T"
    | "copyT2B"
    | "copyT2T"
    | "resolveQueries"
    | "debugGroup"
    | "submit"
    | "writeBuffer"
    | "writeTexture";
  label?: string;
  [key: string]: unknown;
}

const DEFAULT_LIMITS: Record<string, number> = {
  maxTextureDimension1D: 8192,
  maxTextureDimension2D: 8192,
  maxTextureDimension3D: 2048,
  maxTextureArrayLayers: 256,
  maxBindGroups: 4,
  maxBindingsPerBindGroup: 1000,
  maxDynamicUniformBuffersPerPipelineLayout: 8,
  maxDynamicStorageBuffersPerPipelineLayout: 4,
  maxSampledTexturesPerShaderStage: 16,
  maxSamplersPerShaderStage: 16,
  maxStorageBuffersPerShaderStage: 8,
  maxUniformBuffersPerShaderStage: 90,
  maxUniformBufferBindingSize: 65536,
  maxStorageBufferBindingSize: 134217728,
  minUniformBufferOffsetAlignment: 256,
  minStorageBufferOffsetAlignment: 256,
  maxVertexBuffers: 8,
  maxBufferSize: 268435456,
  maxVertexAttributes: 16,
  maxVertexBufferArrayStride: 2048,
  maxInterStageShaderComponents: 60,
  maxInterStageShaderVariables: 16,
  maxColorAttachments: 8,
  maxColorBytesPerSample: 4 * 4,
  maxComputeWorkgroupStorageSize: 16384,
  maxComputeInvocationsPerWorkgroup: 256,
  maxComputeWorkgroupSizeX: 256,
  maxComputeWorkgroupSizeY: 256,
  maxComputeWorkgroupSizeZ: 64,
  maxComputeWorkgroupsPerDimension: 65535,
  maxTimestampQueries: 8,
};

const DEFAULT_FEATURES = [
  "depth-clip-control",
  "timestamp-query",
  "indirect-first-instance",
  "texture-compression-bc",
  "texture-compression-etc2",
  "texture-compression-astc",
  "float32-filterable",
  "shader-f16",
  "subgroups",
  "clip-distances",
  "dual-source-blending",
];

const DEPTH_FORMATS = new Set(["depth16unorm", "depth24plus", "depth24plus-stencil8", "depth32float", "depth32float-stencil8"]);
const STENCIL_FORMATS = new Set(["depth24plus-stencil8", "depth32float-stencil8", "stencil8"]);
const COLOR_WRITEABLE = new Set([
  "r8unorm",
  "r8snorm",
  "r8uint",
  "r8sint",
  "r16uint",
  "r16sint",
  "r16float",
  "rg8unorm",
  "rg8snorm",
  "rg8uint",
  "rg8sint",
  "rg16uint",
  "rg16sint",
  "rg16float",
  "r32uint",
  "r32sint",
  "r32float",
  "rg32uint",
  "rg32sint",
  "rg32float",
  "rgba8unorm",
  "rgba8unorm-srgb",
  "rgba8snorm",
  "rgba8uint",
  "rgba8sint",
  "bgra8unorm",
  "bgra8unorm-srgb",
  "rgb10a2unorm",
  "rg11b10float",
  "rgba16float",
  "rgba32float",
]);

/** Bytes per texel for the subset the engine uses (mock storage is dense). */
export function mockBytesPerTexel(format: string | undefined): number {
  if (format === undefined) return 4;
  if (isKnownFormat(format)) {
    const info = formatInfo(format as GPUTextureFormat);
    if (info.isCompressed) return 0; // modeled as opaque blocks
    return Math.max(1, info.bytesPerBlock);
  }
  switch (format) {
    case "r8unorm":
    case "r8snorm":
    case "r8uint":
    case "r8sint":
      return 1;
    case "rg8unorm":
    case "r16float":
    case "r16uint":
    case "r16sint":
    case "depth24plus":
      return 2;
    case "rgba8unorm":
    case "rgba8unorm-srgb":
    case "bgra8unorm":
    case "rgba16float":
    case "r32float":
    case "depth32float":
      return 4;
    case "rgba32float":
    case "rg32float":
      return 8;
    default:
      return 4;
  }
}

type ErrorKind = "validation" | "out-of-memory" | "internal";

interface MockError extends GPUError {
  kind: ErrorKind;
}

function kindOf(e: GPUError): ErrorKind {
  return (e as MockError).kind ?? "validation";
}

class ErrorStack {
  scopes: { filter: string; errors: MockError[] }[] = [];
  unhandled: MockError[] = [];

  push(filter: string): void {
    this.scopes.push({ filter, errors: [] });
  }

  pop(): GPUError | null {
    const scope = this.scopes.pop();
    if (!scope) return null;
    if (scope.errors.length > 0) return scope.errors[0]!;
    const i = this.unhandled.findIndex((e) => scope.filter === "all" || kindOf(e) === scope.filter);
    if (i >= 0) return this.unhandled.splice(i, 1)[0] ?? null;
    return null;
  }

  report(error: MockError): void {
    for (const scope of this.scopes) {
      if (scope.filter === "all" || scope.filter === error.kind) {
        scope.errors.push(error);
        return;
      }
    }
    this.unhandled.push(error);
  }

  clear(): void {
    this.scopes.length = 0;
    this.unhandled.length = 0;
  }
}

function formatMipSize(width: number, height: number, mip: number): { w: number; h: number } {
  return { w: Math.max(1, width >> mip), h: Math.max(1, height >> mip) };
}

function maxMips(width: number, height: number): number {
  return Math.floor(Math.log2(Math.max(1, width, height))) + 1;
}

export class MockGPUBuffer {
  destroyed = false;
  mapState: "unmapped" | "pending" | "mapped" = "unmapped";
  size: number;
  usage: number;
  label: string;
  /** Backing store: real data, so writeBuffer/getMappedRange round-trip in tests. */
  data: ArrayBuffer;
  /** Debug: which queue writes touched this buffer last, and how much. */
  lastWriteBytes = 0;
  writeCount = 0;
  /** How many times a compute pass wrote this buffer (used by particle-state tests). */
  computeTouchCount = 0;

  constructor(
    readonly mockDevice: MockGPUDevice,
    desc: GPUBufferDescriptor,
  ) {
    this.label = desc.label ?? "";
    this.size = desc.size;
    this.usage = desc.usage;
    const d = mockDevice;
    if (desc.size === 0) d.reportError("createBuffer: size must be > 0");
    if (desc.size % 4 !== 0) d.reportError(`createBuffer: size ${desc.size} is not a multiple of 4`);
    if (desc.size > (d.limitsDict.maxBufferSize ?? Infinity)) d.reportError(`createBuffer: size exceeds maxBufferSize`);
    if (desc.usage === 0) d.reportError("createBuffer: usage must be non-zero");
    const unknown = desc.usage & ~(0x3ff | 0x8 | 0x10);
    if (unknown !== 0) d.reportError(`createBuffer: unknown usage bits 0x${unknown.toString(16)}`);
    if ((desc.usage & BufferUsage.MAP_READ) !== 0 && (desc.usage & ~(BufferUsage.MAP_READ | BufferUsage.COPY_DST)) !== 0) {
      d.reportError("createBuffer: MAP_READ may only combine with COPY_DST");
    }
    if ((desc.usage & BufferUsage.MAP_WRITE) !== 0 && (desc.usage & ~(BufferUsage.MAP_WRITE | BufferUsage.COPY_SRC)) !== 0) {
      d.reportError("createBuffer: MAP_WRITE may only combine with COPY_SRC");
    }
    if ((desc.usage & (BufferUsage.MAP_READ | BufferUsage.MAP_WRITE)) !== 0 && (desc.usage & BufferUsage.COPY_SRC) !== 0 && (desc.usage & BufferUsage.MAP_WRITE) === 0) {
      // legal: MAP_READ|COPY_SRC is not, and we already flagged MAP_READ combos above
    }
    this.data = new ArrayBuffer(desc.size);
    if (desc.mappedAtCreation) this.mapState = "mapped";
    d.trackCreate("buffer", this);
  }

  get isMappable(): boolean {
    return (this.usage & (BufferUsage.MAP_READ | BufferUsage.MAP_WRITE)) !== 0;
  }

  getMappedRange(start = 0, size?: number): ArrayBuffer {
    const d = this.mockDevice;
    if (this.destroyed) d.reportError("getMappedRange: buffer destroyed");
    if (this.mapState !== "mapped") d.reportError("getMappedRange: buffer is not mapped");
    const end = start + (size ?? this.size - start);
    if (start % 8 !== 0) d.reportError(`getMappedRange: offset ${start} must be a multiple of 8`);
    if (size !== undefined && size % 4 !== 0) d.reportError("getMappedRange: size must be a multiple of 4");
    if (end > this.size) d.reportError("getMappedRange: range exceeds buffer size");
    return this.data.slice(start, Math.min(end, this.size));
  }

  /** Mock-specific: view the live backing store (tests assert uploaded bytes). */
  float32View(): Float32Array {
    return new Float32Array(this.data);
  }

  uint32View(): Uint32Array {
    return new Uint32Array(this.data);
  }

  async mapAsync(mode: number, offset = 0, size?: number): Promise<void> {
    if ((mode & BufferUsage.MAP_READ) !== 0 && (this.usage & BufferUsage.MAP_READ) === 0) {
      throw new Error("mapAsync: buffer lacks MAP_READ usage");
    }
    if ((mode & BufferUsage.MAP_WRITE) !== 0 && (this.usage & BufferUsage.MAP_WRITE) === 0) {
      throw new Error("mapAsync: buffer lacks MAP_WRITE usage");
    }
    if (offset % 8 !== 0) throw new Error("mapAsync: offset must be a multiple of 8");
    if (size !== undefined && size % 4 !== 0) throw new Error("mapAsync: size must be a multiple of 4");
    this.mapState = "mapped";
  }

  unmap(): void {
    if (this.destroyed) this.mockDevice.reportError("unmap: buffer destroyed");
    this.mapState = "unmapped";
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.mapState = "unmapped";
    this.data = new ArrayBuffer(0);
    this.mockDevice.trackDestroy("buffer", this);
  }
}

export class MockGPUTextureView {
  constructor(
    readonly texture: MockGPUTexture,
    readonly desc: GPUTextureViewDescriptor,
    readonly device: MockGPUDevice,
  ) {
    device.trackCreate("view", this);
    if (texture.destroyed) device.reportError("createView: texture is destroyed");
    const fmt = desc.format ?? texture.format;
    if (fmt !== texture.format) {
      const a = texture.format.replace(/-srgb$/, "");
      const b = fmt.replace(/-srgb$/, "");
      if (a !== b) device.reportError(`createView: format ${fmt} incompatible with texture format ${texture.format}`);
    }
    const baseMip = desc.baseMipLevel ?? 0;
    const mipCount = desc.mipLevelCount ?? texture.mipLevelCount - baseMip;
    if (baseMip + mipCount > texture.mipLevelCount) {
      device.reportError(`createView: mip range [${baseMip}, ${baseMip + mipCount}) exceeds ${texture.mipLevelCount}`);
    }
    const baseLayer = desc.baseArrayLayer ?? 0;
    const layerCount = desc.arrayLayerCount ?? texture.depthOrArrayLayers - baseLayer;
    if (baseLayer + layerCount > texture.depthOrArrayLayers) device.reportError("createView: layer range exceeds texture");
    const dim = desc.dimension ?? "2d";
    // A 2d-array view of a single-layer 2d texture is valid WebGPU (arrayLayerCount 1); only the
    // texture dimension matters. A one-cascade shadow atlas relies on this.
    if (dim === "2d-array" && texture.dimension !== "2d") device.reportError("createView: 2d-array view of a non-2d texture");
    if ((dim === "cube" || dim === "cube-array") && layerCount % 6 !== 0) device.reportError("createView: cube views need a multiple of 6 layers");
    if (dim === "3d" && texture.dimension !== "3d") device.reportError("createView: 3d view of a non-3d texture");
    texture.viewCount++;
  }

  get label(): string {
    return this.desc.label ?? this.texture.label;
  }

  destroy(): void {
    if ((this as { _destroyed?: boolean })._destroyed) return;
    (this as { _destroyed?: boolean })._destroyed = true;
    this.texture.viewCount--;
    this.device.trackDestroy("view", this);
  }
}

export class MockGPUTexture {
  destroyed = false;
  width: number;
  height: number;
  depthOrArrayLayers: number;
  format: GPUTextureFormat;
  usage: number;
  mipLevelCount: number;
  sampleCount: number;
  dimension: GPUTextureDimension;
  label: string;
  storage: Uint8Array;
  viewCount = 0;
  /** Label of the pass/copy that most recently wrote this texture (ordering assertions). */
  lastWrittenBy = "";
  clearCount = 0;

  constructor(
    readonly mockDevice: MockGPUDevice,
    desc: GPUTextureDescriptor,
  ) {
    this.label = desc.label ?? "";
    this.format = desc.format;
    this.dimension = desc.dimension ?? "2d";
    this.sampleCount = desc.sampleCount ?? 1;
    this.usage = desc.usage;
    const size = extentXYZ(desc.size);
    this.width = size.width;
    this.height = size.height;
    this.depthOrArrayLayers = size.depthOrArrayLayers;
    this.mipLevelCount = desc.mipLevelCount ?? 1;
    const d = mockDevice;
    const limits = d.limitsDict;
    const maxDim = this.dimension === "1d" ? limits.maxTextureDimension1D : this.dimension === "3d" ? limits.maxTextureDimension3D : limits.maxTextureDimension2D;
    if (this.width === 0 || this.width > (maxDim ?? 8192)) d.reportError(`createTexture: width ${this.width} out of range`);
    if (this.dimension !== "1d" && (this.height === 0 || this.height > (maxDim ?? 8192))) d.reportError(`createTexture: height ${this.height} out of range`);
    if (this.depthOrArrayLayers > (limits.maxTextureArrayLayers ?? 256)) d.reportError("createTexture: too many array layers");
    if (this.depthOrArrayLayers > 1 && this.dimension === "3d") d.reportError("createTexture: 3d textures use depth, not array layers");
    if (this.mipLevelCount < 1) d.reportError("createTexture: mipLevelCount must be >= 1");
    if (this.mipLevelCount > maxMips(this.width, this.height)) {
      d.reportError(`createTexture: ${this.mipLevelCount} mips exceed ${maxMips(this.width, this.height)} for ${this.width}x${this.height}`);
    }
    if (this.sampleCount !== 1 && this.sampleCount !== 4) d.reportError("createTexture: sampleCount must be 1 or 4");
    if (this.sampleCount > 1 && this.mipLevelCount > 1) d.reportError("createTexture: multisampled textures must have a single mip level");
    if (this.dimension === "1d" && this.mipLevelCount > 1) d.reportError("createTexture: 1d textures must have mipLevelCount 1");
    if (d.options.checkFormats !== false && !isKnownFormat(this.format)) d.reportError(`createTexture: unknown format "${this.format}"`);
    const isDepth = DEPTH_FORMATS.has(this.format);
    if ((this.usage & TextureUsage.RENDER_ATTACHMENT) !== 0) {
      if (isDepth && (this.usage & TextureUsage.TEXTURE_BINDING) !== 0 && !STENCIL_FORMATS.has(this.format) && this.format !== "depth32float" && this.format !== "depth24plus") {
        d.reportError(`createTexture: ${this.format} cannot be both a render attachment and bound as a texture`);
      }
      if (!isDepth && !COLOR_WRITEABLE.has(this.format)) d.reportError(`createTexture: ${this.format} is not a colour-writable format`);
    }
    if ((this.usage & TextureUsage.STORAGE_BINDING) !== 0) {
      const info = isKnownFormat(this.format) ? formatInfo(this.format) : null;
      if (info?.isCompressed) d.reportError("createTexture: compressed formats cannot be storage-bound");
    }
    if ((this.usage & (TextureUsage.TEXTURE_BINDING | TextureUsage.STORAGE_BINDING)) !== 0 && DEPTH_FORMATS.has(this.format) && !isMultisampled(this.sampleCount)) {
      // depth textures may be sampled; fine
    }
    const bytes = textureStorageBytes(this.width, this.height, this.depthOrArrayLayers, this.mipLevelCount, this.format, this.sampleCount);
    this.storage = new Uint8Array(bytes);
    d.trackCreate("texture", this);
    d.addMemory(bytes);
  }

  createView(desc?: GPUTextureViewDescriptor): MockGPUTextureView {
    if (this.destroyed) this.mockDevice.reportError("createView: texture destroyed");
    return new MockGPUTextureView(this, desc ?? {}, this.mockDevice);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.mockDevice.addMemory(-this.storage.length);
    this.storage = new Uint8Array(0);
    this.mockDevice.trackDestroy("texture", this);
  }

  /** Mock helper: read a mip/layer as a Uint8Array view (no copy). */
  texelBytes(mip = 0, layer = 0): Uint8Array {
    const { offset, bytes } = mipRange(this, mip, layer);
    return this.storage.subarray(offset, offset + bytes);
  }

  asFloats(mip = 0, layer = 0): Float32Array {
    const { offset, bytes } = mipRange(this, mip, layer);
    const out = new Float32Array(bytes / 4);
    for (let i = 0; i < out.length; i++) {
      const view = new DataView(this.storage.buffer, this.storage.byteOffset + offset + i * 4, 4);
      out[i] = this.format.includes("float") ? view.getFloat32(0, true) : view.getUint8(0) / 255;
    }
    return out;
  }
}

function isMultisampled(samples: number): boolean {
  return samples > 1;
}

function textureStorageBytes(w: number, h: number, layers: number, mips: number, format: string | undefined, samples: number): number {
  const bpp = Math.max(1, mockBytesPerTexel(format));
  let total = 0;
  for (let m = 0; m < mips; m++) {
    const { w: mw, h: mh } = formatMipSize(w, h, m);
    total += mw * mh * bpp * layers * samples;
  }
  return total;
}

function mipRange(t: { width: number; height: number; format: string | undefined }, mip: number, layer: number, layers = 1): { offset: number; bytes: number } {
  const bpp = Math.max(1, mockBytesPerTexel(t.format));
  let offset = 0;
  for (let m = 0; m < mip; m++) {
    const { w, h } = formatMipSize(t.width, t.height, m);
    offset += w * h * bpp * layers;
  }
  const { w, h } = formatMipSize(t.width, t.height, mip);
  return { offset: offset + layer * w * h * bpp, bytes: w * h * bpp };
}

export class MockGPUBindGroupLayout {
  destroyed = false;
  readonly label: string;
  entries: GPUBindGroupLayoutEntry[];
  constructor(
    readonly device: MockGPUDevice,
    readonly desc: GPUBindGroupLayoutDescriptor,
  ) {
    this.entries = [...desc.entries];
    this.label = desc.label ?? "";
    device.trackCreate("bindGroupLayout", this);
    const seen = new Set<number>();
    for (const e of desc.entries) {
      if (seen.has(e.binding)) device.reportError(`createBindGroupLayout: duplicate binding ${e.binding}`);
      seen.add(e.binding);
      if (e.binding >= 64) device.reportError(`createBindGroupLayout: binding ${e.binding} too large`);
      if (!e.visibility) device.reportError(`createBindGroupLayout: binding ${e.binding} has empty visibility`);
      if (e.visibility & ~(ShaderStage.VERTEX | ShaderStage.FRAGMENT | ShaderStage.COMPUTE)) {
        device.reportError(`createBindGroupLayout: binding ${e.binding} has unknown visibility bits`);
      }
      const kinds = [e.buffer, e.sampler, e.texture, e.storageTexture].filter(Boolean).length;
      if (kinds !== 1) device.reportError(`createBindGroupLayout: binding ${e.binding} must declare exactly one resource type`);
      if (e.buffer) {
        if (e.buffer.hasDynamicOffset && e.buffer.type !== "uniform" && e.buffer.type !== "storage" && e.buffer.type !== "read-only-storage") {
          device.reportError(`createBindGroupLayout: binding ${e.binding} dynamic offsets only for uniform/storage`);
        }
        if (e.buffer.minBindingSize !== undefined && e.buffer.minBindingSize > (e.buffer.type === "uniform" ? device.limitsDict.maxUniformBufferBindingSize! : device.limitsDict.maxStorageBufferBindingSize!)) {
          device.reportError(`createBindGroupLayout: binding ${e.binding} minBindingSize exceeds the limit for its type`);
        }
        if (e.visibility & (ShaderStage.VERTEX | ShaderStage.FRAGMENT) && e.buffer.type?.includes("storage")) {
          // storage in vertex stage is allowed
        }
      }
      if (e.texture?.sampleType === "depth" && e.texture.multisampled) {
        device.reportError(`createBindGroupLayout: binding ${e.binding} depth textures cannot be multisampled`);
      }
      if (e.texture?.viewDimension === "cube-array" && !e.texture) device.reportError("internal");
      if (e.storageTexture) {
        if (!COLOR_WRITEABLE.has(e.storageTexture.format ?? "")) device.reportError(`createBindGroupLayout: binding ${e.binding} storage format ${e.storageTexture.format} unsupported`);
        if (!["write", "read-write", "read"].includes(e.storageTexture.access ?? "write")) device.reportError("createBindGroupLayout: bad storageTexture access");
      }

    }
    const counts = { buffer: 0, sampler: 0, texture: 0, storageTexture: 0 };
    for (const e of desc.entries) {
      if (e.buffer) counts.buffer++;
      if (e.sampler) counts.sampler++;
      if (e.texture) counts.texture++;
      if (e.storageTexture) counts.storageTexture++;
    }
    if (counts.sampler > (device.limitsDict.maxSamplersPerShaderStage ?? 16)) device.reportError("createBindGroupLayout: too many samplers per stage");
    if (counts.texture + counts.storageTexture > (device.limitsDict.maxSampledTexturesPerShaderStage ?? 16)) {
      device.reportError("createBindGroupLayout: too many textures per stage");
    }
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.device.trackDestroy("bindGroupLayout", this);
  }

  /** Signature used by the pipeline/pass compatibility checks. */
  signature(): string {
    return this.entries
      .slice()
      .sort((a, b) => a.binding - b.binding)
      .map((e) => `${e.binding}:${e.buffer ? `b:${e.buffer.type}${e.buffer.hasDynamicOffset ? ":d" : ""}` : e.sampler ? "s" : e.texture ? "t" : "st"}:${e.visibility}`)
      .join("|");
  }
}

export class MockGPUPipelineLayout {
  destroyed = false;
  readonly label: string;
  layouts: (MockGPUBindGroupLayout | null)[];
  constructor(
    readonly device: MockGPUDevice,
    readonly desc: GPUPipelineLayoutDescriptor,
  ) {
    this.label = desc.label ?? "";
    this.layouts = [...desc.bindGroupLayouts].map((l) => l as unknown as MockGPUBindGroupLayout | null);
    device.trackCreate("pipelineLayout", this);
    if (this.layouts.length > (device.limitsDict.maxBindGroups ?? 4)) {
      device.reportError(`createPipelineLayout: ${this.layouts.length} bind groups exceeds maxBindGroups`);
    }
    for (const l of this.layouts) {
      if (l && l.device !== device) device.reportError("createPipelineLayout: layout from another device");
    }
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.device.trackDestroy("pipelineLayout", this);
  }
}

export class MockGPUBindGroup {
  destroyed = false;
  readonly bindings: Map<number, { resource: unknown; entry: GPUBindGroupLayoutEntry }>;
  constructor(
    readonly device: MockGPUDevice,
    readonly desc: GPUBindGroupDescriptor,
  ) {
    device.trackCreate("bindGroup", this);
    const layout = desc.layout as unknown as MockGPUBindGroupLayout;
    if (!layout || layout.destroyed) {
      device.reportError("createBindGroup: layout is missing or destroyed");
      this.bindings = new Map();
      return;
    }
    const expected = new Map<number, GPUBindGroupLayoutEntry>();
    for (const e of layout.entries) expected.set(e.binding, e);
    const present = new Set<number>();
    this.bindings = new Map();
    for (const entry of desc.entries) {
      if (present.has(entry.binding)) device.reportError(`createBindGroup: duplicate binding ${entry.binding}`);
      present.add(entry.binding);
      const exp = expected.get(entry.binding);
      if (!exp) {
        device.reportError(`createBindGroup: binding ${entry.binding} not declared in layout`);
        continue;
      }
      this.bindings.set(entry.binding, { resource: entry.resource, entry: exp });
      const res = entry.resource as {
        buffer?: MockGPUBuffer;
        offset?: number;
        size?: number;
        sampler?: MockGPUSampler;
        texture?: MockGPUTextureView;
      };
      if (exp.buffer) {
        const buf = res.buffer;
        if (!buf) {
          device.reportError(`createBindGroup: binding ${entry.binding} expected a buffer`);
          continue;
        }
        if (buf.destroyed) device.reportError(`createBindGroup: binding ${entry.binding} uses a destroyed buffer`);
        const offset = res.offset ?? 0;
        const size = res.size ?? Math.max(0, buf.size - offset);
        const isUniform = exp.buffer.type === "uniform";
        const needUsage = isUniform ? BufferUsage.UNIFORM : BufferUsage.STORAGE;
        if ((buf.usage & needUsage) === 0) {
          device.reportError(`createBindGroup: binding ${entry.binding} buffer lacks ${isUniform ? "UNIFORM" : "STORAGE"} usage`);
        }
        const align = isUniform ? (device.limitsDict.minUniformBufferOffsetAlignment ?? MIN_OFFSET_ALIGNMENT) : (device.limitsDict.minStorageBufferOffsetAlignment ?? MIN_OFFSET_ALIGNMENT);
        if (offset % align !== 0) device.reportError(`createBindGroup: binding ${entry.binding} offset ${offset} is not a multiple of ${align}`);
        if (isUniform && size > (device.limitsDict.maxUniformBufferBindingSize ?? 65536)) {
          device.reportError(`createBindGroup: uniform binding ${size} bytes exceeds maxUniformBufferBindingSize`);
        }
        if (!isUniform && size > (device.limitsDict.maxStorageBufferBindingSize ?? 134217728)) {
          device.reportError(`createBindGroup: storage binding ${size} bytes exceeds maxStorageBufferBindingSize`);
        }
        if (exp.buffer.minBindingSize !== undefined && size < exp.buffer.minBindingSize) {
          device.reportError(`createBindGroup: binding ${entry.binding} provides ${size} bytes, layout requires ${exp.buffer.minBindingSize}`);
        }
        if (!isUniform && size % 4 !== 0) device.reportError(`createBindGroup: storage binding size ${size} must be a multiple of 4`);
        if (offset + size > buf.size) device.reportError(`createBindGroup: binding ${entry.binding} range exceeds buffer size ${buf.size}`);
        if (!exp.buffer.hasDynamicOffset && res.size !== undefined && res.offset !== undefined && res.offset !== 0 && !exp.buffer.type) {
          // nothing
        }
      }
      if (exp.sampler) {
        const s = (res instanceof MockGPUSampler ? res : (res as { sampler?: MockGPUSampler }).sampler) as MockGPUSampler | undefined;
        if (!s) device.reportError(`createBindGroup: binding ${entry.binding} expected a sampler`);
        else if ((s as { destroyed?: boolean }).destroyed) device.reportError(`createBindGroup: binding ${entry.binding} uses a destroyed sampler`);
      }
      if (exp.texture || exp.storageTexture) {
        const view = (res instanceof MockGPUTextureView ? res : (res as { texture?: MockGPUTextureView }).texture) as MockGPUTextureView | undefined;
        if (!view) {
          device.reportError(`createBindGroup: binding ${entry.binding} expected a texture view`);
          continue;
        }
        const tex = view.texture;
        if (tex.destroyed) device.reportError(`createBindGroup: binding ${entry.binding} uses a destroyed texture`);
        if (exp.texture) {
          if (exp.texture.multisampled && tex.sampleCount === 1) device.reportError(`createBindGroup: binding ${entry.binding} expects a multisampled view`);
          if (!exp.texture.multisampled && tex.sampleCount > 1) device.reportError(`createBindGroup: binding ${entry.binding} must not bind a multisampled view`);
          const want = exp.texture.viewDimension;
          const got = view.desc.dimension ?? (tex.depthOrArrayLayers > 1 ? "2d-array" : "2d");
          if (want && want !== got) device.reportError(`createBindGroup: binding ${entry.binding} view dimension ${got} != layout ${want}`);
          if (exp.texture.sampleType === "float" && tex.format.includes("unorm") === false && tex.format.includes("sint")) {
            device.reportError(`createBindGroup: binding ${entry.binding} sampleType float vs integer texture ${tex.format}`);
          }
        }
        if (exp.storageTexture) {
          if ((tex.usage & TextureUsage.STORAGE_BINDING) === 0) device.reportError(`createBindGroup: binding ${entry.binding} texture lacks STORAGE_BINDING`);
          if (exp.storageTexture.format !== tex.format) device.reportError(`createBindGroup: storage texture format ${tex.format} != layout ${exp.storageTexture.format}`);
          const allowed = (exp.storageTexture as { viewFormats?: Iterable<GPUTextureFormat> }).viewFormats
          ? [...((exp.storageTexture as { viewFormats?: Iterable<GPUTextureFormat> }).viewFormats ?? [])]
          : undefined;
          if (allowed && allowed.length > 0 && !allowed.includes(tex.format) && tex.format !== exp.storageTexture.format) {
            if (!allowed.some((f) => f.replace(/-srgb$/, "") === tex.format.replace(/-srgb$/, ""))) {
              device.reportError(`createBindGroup: storage texture format ${tex.format} not in viewFormats`);
            }
          }
        }
      }
    }
    for (const exp of expected.values()) {
      if (!present.has(exp.binding)) device.reportError(`createBindGroup: layout binding ${exp.binding} missing from the group`);
    }
  }

  /** The layout signature this group was built against (checked at setBindGroup time). */
  get layoutSignature(): string {
    const layout = this.desc.layout as unknown as MockGPUBindGroupLayout;
    return layout?.signature() ?? "";
  }

  /** Bound resource objects, for graph/lifetime tests. */
  boundBuffers(): MockGPUBuffer[] {
    const out: MockGPUBuffer[] = [];
    for (const { resource } of this.bindings.values()) {
      const b = (resource as { buffer?: MockGPUBuffer }).buffer;
      if (b) out.push(b);
    }
    return out;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.device.trackDestroy("bindGroup", this);
  }
}

export class MockGPUSampler {
  destroyed = false;
  constructor(
    readonly device: MockGPUDevice,
    readonly desc: GPUSamplerDescriptor,
  ) {
    device.trackCreate("sampler", this);
    const min = desc.lodMinClamp ?? 0;
    const max = desc.lodMaxClamp ?? 32;
    if (min > max) device.reportError(`createSampler: lodMinClamp ${min} > lodMaxClamp ${max}`);
    if (max < 0) device.reportError("createSampler: negative lodMaxClamp");
    const aniso = desc.maxAnisotropy ?? 1;
    if (aniso < 1 || (aniso & (aniso - 1)) !== 0) device.reportError(`createSampler: maxAnisotropy ${aniso} must be a power of two`);
    if (aniso > 16) device.reportError("createSampler: maxAnisotropy > 16 unsupported");
    if (aniso > 1 && (desc.minFilter === "nearest" || desc.magFilter === "nearest")) {
      device.reportError("createSampler: anisotropy requires linear min/mag filters");
    }
    for (const mode of [desc.addressModeU, desc.addressModeV, desc.addressModeW]) {
      if ((mode as string | undefined) === "clamp-to-border") device.reportError("createSampler: clamp-to-border is not available in WebGPU");
    }
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.device.trackDestroy("sampler", this);
  }
}

export class MockGPUShaderModule {
  destroyed = false;
  code: string;
  entryPoints: Set<string>;
  constructor(
    readonly device: MockGPUDevice,
    desc: GPUShaderModuleDescriptor,
  ) {
    this.code = desc.code ?? "";
    this.entryPoints = extractEntryPoints(this.code);
    device.trackCreate("shaderModule", this);
    if (this.code.length === 0) device.reportError("createShaderModule: empty source");
    const unbalanced = balanceCheck(this.code);
    if (unbalanced) device.reportError(`createShaderModule: ${unbalanced}`);
  }

  get info(): { entryPoints: string[]; length: number } {
    return { entryPoints: [...this.entryPoints].sort(), length: this.code.length };
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.device.trackDestroy("shaderModule", this);
  }
}

function extractEntryPoints(code: string): Set<string> {
  const out = new Set<string>();
  const re = /@(vertex|fragment|compute)\b[\s\S]{0,240}?\bfn\s+([A-Za-z_][A-Za-z0-9_]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code))) out.add(m[2]!);
  return out;
}

function balanceCheck(code: string): string | null {
  const stripped = code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  const close: Record<string, string> = { ")": "(", "]": "[", "}": "{" };
  const stack: string[] = [];
  for (let i = 0; i < stripped.length; i++) {
    const ch = stripped[i]!;
    if (ch === "(" || ch === "[" || ch === "{") stack.push(ch);
    else if (ch in close) {
      if (stack.pop() !== close[ch]) return `unbalanced brackets at offset ${i}`;
    }
  }
  return stack.length ? "unclosed brackets" : null;
}

export class MockGPURenderPipeline {
  destroyed = false;
  readonly label: string;
  layout: MockGPUPipelineLayout | null;
  vertexBuffers: GPUVertexBufferLayout[];
  colorTargets: GPUColorTargetState[];
  depthFormat: GPUTextureFormat | undefined;
  depthWriteEnabled: boolean;
  depthCompare: string;
  sampleCount: number;
  topology: GPUPrimitiveTopology;
  cullMode: string;
  frontFace: string;
  indexFormat: GPUIndexFormat | null;
  readonly signature: string;

  constructor(
    readonly device: MockGPUDevice,
    readonly desc: GPURenderPipelineDescriptor,
  ) {
    device.trackCreate("renderPipeline", this);
    this.label = desc.label ?? "";
    this.layout = desc.layout === "auto" ? null : (desc.layout as unknown as MockGPUPipelineLayout);
    if (this.layout?.destroyed) device.reportError("createRenderPipeline: destroyed pipeline layout");
    this.vertexBuffers = [...(desc.vertex.buffers ?? [])] as GPUVertexBufferLayout[];
    this.colorTargets = [...(desc.fragment?.targets ?? [])] as GPUColorTargetState[];
    this.depthFormat = desc.depthStencil?.format;
    this.depthWriteEnabled = desc.depthStencil?.depthWriteEnabled ?? false;
    this.depthCompare = desc.depthStencil?.depthCompare ?? "less";
    this.sampleCount = desc.multisample?.count ?? 1;
    this.topology = desc.primitive?.topology ?? "triangle-list";
    this.cullMode = desc.primitive?.cullMode ?? "back";
    this.frontFace = desc.primitive?.frontFace ?? "ccw";
    this.indexFormat = (desc.primitive?.stripIndexFormat as GPUIndexFormat) ?? null;
    if (this.layout === null && desc.layout !== "auto") device.reportError("createRenderPipeline: layout must be 'auto' or a pipeline layout");
    if (desc.fragment && this.colorTargets.length === 0 && !desc.depthStencil) device.reportError("createRenderPipeline: fragment state requires at least one color target");
    if (!desc.fragment && !desc.depthStencil) device.reportError("createRenderPipeline: pipeline must have fragment targets or depthStencil");
    if (this.colorTargets.length > (device.limitsDict.maxColorAttachments ?? 8)) device.reportError("createRenderPipeline: too many color targets");
    let locations = 0;
    const seenLoc = new Set<number>();
    for (const b of this.vertexBuffers) {
      if (!b) continue;
      if (b.arrayStride > (device.limitsDict.maxVertexBufferArrayStride ?? 2048)) device.reportError(`createRenderPipeline: arrayStride ${b.arrayStride} exceeds limit`);
      if (b.arrayStride % 4 !== 0) device.reportError(`createRenderPipeline: arrayStride ${b.arrayStride} must be a multiple of 4`);
      for (const a of [...(b.attributes ?? [])]) {
        const size = vertexFormatBytes(a.format);
        if (a.offset % (size >= 8 ? 8 : 4) !== 0 && size < 8) device.reportError(`createRenderPipeline: attribute offset ${a.offset} misaligned for ${a.format}`);
        if (a.offset + size > b.arrayStride) device.reportError(`createRenderPipeline: attribute ${a.format}@${a.offset} runs past arrayStride ${b.arrayStride}`);
        if (a.shaderLocation >= 16) device.reportError(`createRenderPipeline: shaderLocation ${a.shaderLocation} >= maxVertexAttributes`);
        if (seenLoc.has(a.shaderLocation)) device.reportError(`createRenderPipeline: duplicate vertex shaderLocation ${a.shaderLocation}`);
        seenLoc.add(a.shaderLocation);
        locations++;
      }
      if (b.stepMode && !["vertex", "instance"].includes(b.stepMode)) device.reportError("createRenderPipeline: bad stepMode");
    }
    if (locations > (device.limitsDict.maxVertexAttributes ?? 16)) device.reportError("createRenderPipeline: too many vertex attributes");
    if (this.vertexBuffers.length > (device.limitsDict.maxVertexBuffers ?? 8)) device.reportError("createRenderPipeline: too many vertex buffers");
    if (this.depthFormat && !DEPTH_FORMATS.has(this.depthFormat)) device.reportError(`createRenderPipeline: ${this.depthFormat} is not a depth/stencil format`);
    if (this.depthWriteEnabled && this.depthFormat && STENCIL_FORMATS.has(this.depthFormat) === false && DEPTH_FORMATS.has(this.depthFormat) === false) {
      device.reportError("createRenderPipeline: depth writes need a depth format");
    }
    for (const t of this.colorTargets) {
      if (!COLOR_WRITEABLE.has(t.format ?? "")) device.reportError(`createRenderPipeline: colour target format ${t.format} is not colour-writable`);
      if (t.blend) {
        const valid = new Set(["add", "subtract", "reverse-subtract", "min", "max"]);
        if (!valid.has(t.blend.color.operation ?? "add")) device.reportError(`createRenderPipeline: bad blend color operation ${t.blend.color.operation}`);
        if (!valid.has(t.blend.alpha.operation ?? "add")) device.reportError("createRenderPipeline: bad blend alpha operation");
      }
    }
    if (!["triangle-list", "triangle-strip", "line-list", "line-strip", "point-list"].includes(this.topology as string)) {
      device.reportError(`createRenderPipeline: bad topology ${this.topology}`);
    }
    if (this.topology === "triangle-strip" && this.indexFormat === "uint16") {
      // legal
    }
    const vertexModule = desc.vertex.module as unknown as MockGPUShaderModule;
    if (vertexModule && desc.vertex.entryPoint && !vertexModule.entryPoints.has(desc.vertex.entryPoint)) {
      device.reportError(`createRenderPipeline: vertex entry point "${desc.vertex.entryPoint}" not found in shader module`);
    }
    if (desc.fragment) {
      const fm = desc.fragment.module as unknown as MockGPUShaderModule;
      if (fm && desc.fragment.entryPoint && !fm.entryPoints.has(desc.fragment.entryPoint)) {
        device.reportError(`createRenderPipeline: fragment entry point "${desc.fragment.entryPoint}" not found in shader module`);
      }
      if (fm && fm !== vertexModule && fm.device !== vertexModule.device) device.reportError("createRenderPipeline: shader modules from different devices");
    }
    if (this.layout) {
      for (const l of this.layout.layouts) if (l && l.destroyed) device.reportError("createRenderPipeline: pipeline layout references a destroyed bind group layout");
    }
    this.signature = `${this.colorTargets.map((t) => t.format).join(",")}|${this.depthFormat ?? "-"}|${this.sampleCount}|${this.topology}`;
  }

  getBindGroupLayout(index: number): MockGPUBindGroupLayout {
    if (this.layout === null) {
      this.device.reportError("getBindGroupLayout on an 'auto' pipeline layout is not modeled by the mock");
      return null as unknown as MockGPUBindGroupLayout;
    }
    const l = this.layout.layouts[index];
    if (!l) this.device.reportError(`getBindGroupLayout(${index}) is out of range for this pipeline layout`);
    return l as MockGPUBindGroupLayout;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.device.trackDestroy("renderPipeline", this);
  }
}

export class MockGPUComputePipeline {
  destroyed = false;
  readonly label: string;
  layout: MockGPUPipelineLayout | null;
  constructor(
    readonly device: MockGPUDevice,
    readonly desc: GPUComputePipelineDescriptor,
  ) {
    device.trackCreate("computePipeline", this);
    this.label = desc.label ?? "";
    this.layout = desc.layout === "auto" ? null : (desc.layout as unknown as MockGPUPipelineLayout);
    const module = desc.compute.module as unknown as MockGPUShaderModule;
    if (module && desc.compute.entryPoint && !module.entryPoints.has(desc.compute.entryPoint)) {
      device.reportError(`createComputePipeline: entry point "${desc.compute.entryPoint}" not found in shader module`);
    }
    if (module && module.destroyed) device.reportError("createComputePipeline: destroyed shader module");
  }

  getBindGroupLayout(index: number): MockGPUBindGroupLayout {
    const l = this.layout?.layouts[index];
    if (!l) this.device.reportError(`compute getBindGroupLayout(${index}) out of range`);
    return l as MockGPUBindGroupLayout;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.device.trackDestroy("computePipeline", this);
  }
}

export class MockGPUQuerySet {
  destroyed = false;
  readonly type: GPUQueryType;
  readonly count: number;
  results: Float64Array;
  /** Timestamp values assigned in submission order (ns, monotonic). */
  nextTimestampNs = 1000;
  written = false;

  constructor(
    readonly device: MockGPUDevice,
    desc: GPUQuerySetDescriptor,
  ) {
    device.trackCreate("querySet", this);
    this.type = desc.type;
    this.count = desc.count;
    this.results = new Float64Array(desc.count);
    if (desc.count === 0) device.reportError("createQuerySet: count must be > 0");
    if (desc.count > (device.limitsDict.maxTimestampQueries ?? 8) * 64) device.reportError("createQuerySet: count exceeds practical limit");
    if (desc.type === "timestamp" && !device.features.has("timestamp-query")) {
      device.reportError("createQuerySet: 'timestamp-query' feature required");
    }
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.device.trackDestroy("querySet", this);
  }
}

export class MockGPUCommandEncoder {
  finished = false;
  readonly label: string;
  /** Passes recorded in submission order; used by graph-order tests. */
  readonly passLabels: string[] = [];

  constructor(
    readonly device: MockGPUDevice,
    desc: GPUCommandEncoderDescriptor = {},
  ) {
    this.label = desc.label ?? "";
  }

  private check(op: string): boolean {
    if (this.finished) {
      this.device.reportError(`${op}: command encoder is already finished`);
      return false;
    }
    if (this.device.lost) {
      this.device.reportError(`${op}: device is lost`);
      return false;
    }
    return true;
  }

  beginRenderPass(desc: GPURenderPassDescriptor): MockGPURenderPassEncoder {
    const ok = this.check("beginRenderPass");
    const pass = new MockGPURenderPassEncoder(this, desc, ok);
    if (ok) this.passLabels.push(desc.label ?? "(render pass)");
    return pass;
  }

  beginComputePass(desc: GPUComputePassDescriptor = {}): MockGPUComputePassEncoder {
    const ok = this.check("beginComputePass");
    const pass = new MockGPUComputePassEncoder(this, desc, ok);
    if (ok) this.passLabels.push(desc.label ?? "(compute pass)");
    return pass;
  }

  copyBufferToBuffer(source: MockGPUBuffer, sourceOffset: number, destination: MockGPUBuffer, destinationOffset: number, size: number): void {
    if (!this.check("copyBufferToBuffer")) return;
    if (!(source instanceof MockGPUBuffer) || !(destination instanceof MockGPUBuffer)) {
      this.device.reportError("copyBufferToBuffer: buffers must come from this device");
      return;
    }
    if (source.destroyed || destination.destroyed) this.device.reportError("copyBufferToBuffer: destroyed buffer");
    if ((source.usage & BufferUsage.COPY_SRC) === 0) this.device.reportError("copyBufferToBuffer: source lacks COPY_SRC");
    if ((destination.usage & BufferUsage.COPY_DST) === 0) this.device.reportError("copyBufferToBuffer: destination lacks COPY_DST");
    if (sourceOffset % 4 !== 0 || destinationOffset % 4 !== 0 || size % 4 !== 0) this.device.reportError("copyBufferToBuffer: offsets and size must be multiples of 4");
    if (size < 0) this.device.reportError("copyBufferToBuffer: negative size");
    if (sourceOffset + size > source.size) this.device.reportError(`copyBufferToBuffer: source range ${sourceOffset}+${size} exceeds ${source.size}`);
    if (destinationOffset + size > destination.size) this.device.reportError("copyBufferToBuffer: destination range out of bounds");
    if (source === destination && rangesOverlap(sourceOffset, destinationOffset, size)) {
      this.device.reportError("copyBufferToBuffer: source and destination ranges must not overlap");
    }
    new Uint8Array(destination.data, destinationOffset, size).set(new Uint8Array(source.data, sourceOffset, size));
    this.device.record({ type: "copyB2B", size, source: source.label, destination: destination.label });
  }

  copyBufferToTexture(source: GPUImageCopyBuffer, destination: GPUImageCopyTexture, copySize: GPUExtent3D): void {
    if (!this.check("copyBufferToTexture")) return;
    const tex = destination.texture as unknown as MockGPUTexture;
    if (!(tex instanceof MockGPUTexture)) {
      this.device.reportError("copyBufferToTexture: destination.texture must be a GPUTexture (not a view)");
      return;
    }
    const buf = source.buffer as unknown as MockGPUBuffer;
    if ((buf.usage & BufferUsage.COPY_SRC) === 0) this.device.reportError("copyBufferToTexture: source buffer lacks COPY_SRC");
    if ((tex.usage & TextureUsage.COPY_DST) === 0) this.device.reportError(`copyBufferToTexture: texture "${tex.label}" lacks COPY_DST`);
    const dims = normalizeExtent(copySize);
    const bpp = Math.max(1, mockBytesPerTexel(tex.format));
    const bytesPerRow = source.bytesPerRow ?? 0;
    if (bytesPerRow % COPY_BYTES_PER_ROW_ALIGNMENT !== 0) {
      this.device.reportError(`copyBufferToTexture: bytesPerRow ${bytesPerRow} must be a multiple of ${COPY_BYTES_PER_ROW_ALIGNMENT}`);
    }
    if (bytesPerRow < dims.width * bpp) this.device.reportError(`copyBufferToTexture: bytesPerRow ${bytesPerRow} < row bytes ${dims.width * bpp}`);
    const offset = source.offset ?? 0;
    if (offset % 4 !== 0) this.device.reportError("copyBufferToTexture: buffer offset must be a multiple of 4");
    const rowsPerImage = source.rowsPerImage ?? dims.height;
    const needed = offset + bytesPerRow * (dims.height + (dims.depthOrArrayLayers - 1) * rowsPerImage);
    if (needed > buf.size) this.device.reportError(`copyBufferToTexture: buffer needs ${needed} bytes, has ${buf.size}`);
    const mip = destination.mipLevel ?? 0;
    const { w: mw, h: mh } = formatMipSize(tex.width, tex.height, mip);
    const origin = originXYZ(destination.origin);
    if (origin.x + dims.width > mw || origin.y + dims.height > mh) {
      this.device.reportError(`copyBufferToTexture: copy [${origin.x},${dims.width}]x[${origin.y},${dims.height}] exceeds mip ${mip} (${mw}x${mh})`);
    }
    const src = new Uint8Array(buf.data);
    for (let layer = 0; layer < dims.depthOrArrayLayers; layer++) {
      const dstBase = mipRange(tex, mip, origin.z + layer).offset;
      for (let y = 0; y < dims.height; y++) {
        for (let x = 0; x < dims.width; x++) {
          const si = offset + layer * rowsPerImage * bytesPerRow + y * bytesPerRow + x * bpp;
          const di = dstBase + ((origin.y + y) * mw + origin.x + x) * bpp;
          if (di + bpp > tex.storage.length) continue;
          for (let b = 0; b < bpp; b++) tex.storage[di + b] = src[si + b] ?? 0;
        }
      }
    }
    tex.lastWrittenBy = this.label || "copyBufferToTexture";
    this.device.record({ type: "copyB2T", texture: tex.label, width: dims.width, height: dims.height, bytesPerRow });
  }

  copyTextureToBuffer(source: GPUImageCopyTexture, destination: GPUImageCopyBuffer, copySize: GPUExtent3D): void {
    if (!this.check("copyTextureToBuffer")) return;
    const tex = source.texture as unknown as MockGPUTexture;
    if (!(tex instanceof MockGPUTexture)) {
      this.device.reportError("copyTextureToBuffer: source.texture must be a GPUTexture (not a view)");
      return;
    }
    const buf = destination.buffer as unknown as MockGPUBuffer;
    if ((tex.usage & TextureUsage.COPY_SRC) === 0) this.device.reportError(`copyTextureToBuffer: texture "${tex.label}" lacks COPY_SRC`);
    if ((buf.usage & BufferUsage.COPY_DST) === 0) this.device.reportError("copyTextureToBuffer: buffer lacks COPY_DST");
    if (DEPTH_FORMATS.has(tex.format)) this.device.reportError("copyTextureToBuffer: depth formats are not copyable");
    const dims = normalizeExtent(copySize);
    const bpp = Math.max(1, mockBytesPerTexel(tex.format));
    const bytesPerRow = destination.bytesPerRow ?? 0;
    if (bytesPerRow % COPY_BYTES_PER_ROW_ALIGNMENT !== 0) this.device.reportError(`copyTextureToBuffer: bytesPerRow ${bytesPerRow} must be a multiple of ${COPY_BYTES_PER_ROW_ALIGNMENT}`);
    if (bytesPerRow < dims.width * bpp) this.device.reportError("copyTextureToBuffer: bytesPerRow smaller than source row");
    const offset = destination.offset ?? 0;
    if (offset % COPY_BYTES_PER_ROW_ALIGNMENT !== 0) this.device.reportError("copyTextureToBuffer: buffer offset must be a multiple of 256");
    if (offset + bytesPerRow * dims.height > buf.size) this.device.reportError("copyTextureToBuffer: destination buffer too small");
    const mip = source.mipLevel ?? 0;
    const { w: mw } = formatMipSize(tex.width, tex.height, mip);

    const srcBase = mipRange(tex, mip, originXYZ(source.origin).z).offset;
    const dst = new Uint8Array(buf.data);
    for (let y = 0; y < dims.height; y++) {
      for (let x = 0; x < dims.width; x++) {
        const so = originXYZ(source.origin);
        const si = srcBase + ((so.y + y) * mw + so.x + x) * bpp;
        const di = offset + y * bytesPerRow + x * bpp;
        if (si + bpp > tex.storage.length) continue;
        for (let b = 0; b < bpp; b++) dst[di + b] = tex.storage[si + b] ?? 0;
      }
    }
    this.device.record({ type: "copyT2B", texture: tex.label, width: dims.width, height: dims.height });
  }

  copyTextureToTexture(source: GPUImageCopyTexture, destination: GPUImageCopyTexture, copySize: GPUExtent3D): void {
    if (!this.check("copyTextureToTexture")) return;
    const s = source.texture as unknown as MockGPUTexture;
    const d = destination.texture as unknown as MockGPUTexture;
    if (!(s instanceof MockGPUTexture) || !(d instanceof MockGPUTexture)) {
      this.device.reportError("copyTextureToTexture: both sides must be textures");
      return;
    }
    if ((s.usage & TextureUsage.COPY_SRC) === 0) this.device.reportError("copyTextureToTexture: source lacks COPY_SRC");
    if ((d.usage & TextureUsage.COPY_DST) === 0) this.device.reportError("copyTextureToTexture: destination lacks COPY_DST");
    const sInfo = isKnownFormat(s.format) ? formatInfo(s.format) : null;
    const dInfo = isKnownFormat(d.format) ? formatInfo(d.format) : null;
    if (sInfo && dInfo && (sInfo.channels !== dInfo.channels || sInfo.isCompressed !== dInfo.isCompressed)) {
      deviceMismatch(this.device, s.format, d.format);
    }
    const dims = normalizeExtent(copySize);
    const mip = source.mipLevel ?? 0;
    const { w: sw, h: sh } = formatMipSize(s.width, s.height, mip);
    const oo = originXYZ(source.origin);
    if (oo.x + dims.width > sw || oo.y + dims.height > sh) {
      this.device.reportError("copyTextureToTexture: source region out of bounds");
    }
    this.device.record({ type: "copyT2T", width: dims.width, height: dims.height });
  }

  clearBuffer(buffer: MockGPUBuffer, offset = 0, size?: number): void {
    if (!this.check("clearBuffer")) return;
    if (buffer.destroyed) this.device.reportError("clearBuffer: buffer destroyed");
    if ((buffer.usage & BufferUsage.COPY_DST) === 0 && (buffer.usage & (BufferUsage.VERTEX | BufferUsage.INDEX | BufferUsage.UNIFORM | BufferUsage.STORAGE)) === 0) {
      this.device.reportError("clearBuffer: buffer must be clearable (COPY_DST or a binding usage)");
    }
    if (offset % 4 !== 0) this.device.reportError("clearBuffer: offset must be a multiple of 4");
    const bytes = size ?? buffer.size - offset;
    if (bytes % 4 !== 0) this.device.reportError("clearBuffer: size must be a multiple of 4");
    if (offset + bytes > buffer.size) this.device.reportError("clearBuffer: range exceeds buffer size");
    new Uint8Array(buffer.data, offset, bytes).fill(0);
  }

  resolveQuerySet(querySet: MockGPUQuerySet, startQuery: number, queryCount: number, destination: MockGPUBuffer, destinationOffset: number): void {
    if (!this.check("resolveQuerySet")) return;
    if ((destination.usage & BufferUsage.QUERY_RESOLVE) === 0) this.device.reportError("resolveQuerySet: destination lacks QUERY_RESOLVE usage");
    if (destinationOffset % 256 !== 0) this.device.reportError("resolveQuerySet: destination offset must be a multiple of 256");
    if (startQuery + queryCount > querySet.count) this.device.reportError("resolveQuerySet: range exceeds query set count");
    if (destinationOffset + queryCount * 8 > destination.size) this.device.reportError("resolveQuerySet: destination buffer too small");
    const out = new Float64Array(destination.data, destinationOffset, queryCount);
    for (let i = 0; i < queryCount; i++) out[i] = querySet.results[startQuery + i] ?? 0;
    querySet.written = true;
    this.device.record({ type: "resolveQueries", count: queryCount, querySet: querySet.type });
  }

  insertDebugMarker(label: string): void {
    this.device.record({ type: "debugGroup", label });
  }

  pushDebugGroup(label: string): void {
    this.device.record({ type: "debugGroup", label, push: true });
  }

  popDebugGroup(): void {
    this.device.record({ type: "debugGroup", pop: true });
  }

  finish(desc: GPUCommandBufferDescriptor = {}): MockGPUCommandBuffer {
    if (this.finished) this.device.reportError("finish: encoder already finished");
    this.finished = true;
    return { label: desc.label ?? this.label, encoder: this };
  }
}

function deviceMismatch(device: MockGPUDevice, a: string, b: string): void {
  device.reportError(`copyTextureToTexture: incompatible formats ${a} -> ${b}`);
}

function rangesOverlap(a: number, b: number, size: number): boolean {
  return a < b + size && b < a + size;
}

/** WebGPU accepts extents/origins as either a dict or an iterable; normalize once. */
function extentXYZ(value: GPUExtent3D | undefined): { width: number; height: number; depthOrArrayLayers: number } {
  if (value === undefined) return { width: 1, height: 1, depthOrArrayLayers: 1 };
  if (!isIterableDict(value)) {
    const it = [...(value as Iterable<number>)];
    return { width: it[0] ?? 1, height: it[1] ?? 1, depthOrArrayLayers: it[2] ?? 1 };
  }
  const d = value as GPUExtent3DDict;
  return { width: d.width, height: d.height ?? 1, depthOrArrayLayers: d.depthOrArrayLayers ?? 1 };
}

function originXYZ(value: GPUOrigin3D | undefined): { x: number; y: number; z: number } {
  if (value === undefined) return { x: 0, y: 0, z: 0 };
  if (!isIterableDict(value)) {
    const it = [...(value as Iterable<number>)];
    return { x: it[0] ?? 0, y: it[1] ?? 0, z: it[2] ?? 0 };
  }
  const d = value as GPUOrigin3DDict;
  return { x: d.x ?? 0, y: d.y ?? 0, z: d.z ?? 0 };
}

function isIterableDict(v: object): boolean {
  return typeof v === "object" && !(Symbol.iterator in v);
}

function normalizeExtent(copySize: GPUExtent3D): { width: number; height: number; depthOrArrayLayers: number } {
  return extentXYZ(copySize as GPUExtent3D);
}

function vertexFormatBytes(format: string): number {
  switch (format) {
    case "float32x2":
    case "uint32x2":
    case "sint32x2":
      return 8;
    case "float32x3":
    case "uint32x3":
    case "sint32x3":
      return 12;
    case "float32x4":
    case "uint32x4":
    case "sint32x4":
      return 16;
    case "float16x2":
    case "unorm16x2":
    case "snorm16x2":
    case "uint16x2":
    case "sint16x2":
      return 4;
    case "float16x4":
    case "unorm16x4":
    case "snorm16x4":
    case "uint16x4":
    case "sint16x4":
      return 8;
    case "unorm8x2":
    case "snorm8x2":
    case "uint8x2":
    case "sint8x2":
      return 2;
    case "unorm8x4":
    case "snorm8x4":
    case "uint8x4":
    case "sint8x4":
      return 4;
    default:
      return 4;
  }
}

class MockPassBase {
  protected ended = false;
  constructor(protected readonly encoder: MockGPUCommandEncoder) {}

  protected err(message: string): void {
    this.encoder.device.reportError(`[${this.encoder.label}] ${message}`);
  }
}

export class MockGPURenderPassEncoder extends MockPassBase {
  private pipeline: MockGPURenderPipeline | null = null;
  private bindGroups = new Map<number, MockGPUBindGroup>();
  private vertexBuffers = new Map<number, { buffer: MockGPUBuffer; offset: number; size: number }>();
  private indexBuffer: { buffer: MockGPUBuffer; format: GPUIndexFormat; offset: number; count: number } | null = null;
  private viewport = { x: 0, y: 0, w: 1, h: 1 };
  private scissorSet = false;
  private dynamicDepth = false;
  drawCalls = 0;
  triangles = 0;
  instances = 0;
  readonly colorTextures: MockGPUTexture[];
  readonly depthTexture: MockGPUTexture | null;
  readonly label: string;

  constructor(
    encoder: MockGPUCommandEncoder,
    readonly desc: GPURenderPassDescriptor,
    private readonly valid: boolean,
  ) {
    super(encoder);
    this.label = desc.label ?? "(render pass)";
    this.colorTextures = [...desc.colorAttachments]
      .map((a) => (a?.view as unknown as MockGPUTextureView | undefined)?.texture)
      .filter((t): t is MockGPUTexture => !!t);
    this.depthTexture = (desc.depthStencilAttachment?.view as unknown as MockGPUTextureView | undefined)?.texture ?? null;
    if (!this.valid) return;
    encoder.device.record({
      type: "renderPass",
      label: this.label,
      colors: this.colorTextures.map((t) => t.label),
      depth: this.depthTexture?.label ?? null,
    });
    this.validateAttachments();
  }

  private validateAttachments(): void {
    const device = this.encoder.device;
    const attachments = [...this.desc.colorAttachments];
    if (attachments.length === 0 && !this.desc.depthStencilAttachment) {
      device.reportError(`render pass "${this.label}": no attachments (nothing can be rendered)`);
    }
    let sampleCount: number | null = null;
    attachments.forEach((a, i) => {
      if (!a) {
        device.reportError(`render pass "${this.label}": color attachment ${i} is null`);
        return;
      }
      const tex = (a.view as unknown as MockGPUTextureView | undefined)?.texture;
      if (!tex) {
        device.reportError(`render pass "${this.label}": color attachment ${i} has no view`);
        return;
      }
      if (tex.destroyed) device.reportError(`render pass "${this.label}": color attachment ${i} is a destroyed texture`);
      if ((tex.usage & TextureUsage.RENDER_ATTACHMENT) === 0) {
        device.reportError(`render pass "${this.label}": color attachment ${i} texture "${tex.label}" lacks RENDER_ATTACHMENT usage`);
      }
      if (sampleCount === null) sampleCount = tex.sampleCount;
      else if (tex.sampleCount !== sampleCount) device.reportError(`render pass "${this.label}": color attachments have differing sample counts`);
      if (a.resolveTarget) {
        const rt = (a.resolveTarget as unknown as { texture?: MockGPUTexture }).texture;
        if (tex.sampleCount === 1) device.reportError(`render pass "${this.label}": resolveTarget requires a multisampled attachment`);
        if (rt && rt.format !== tex.format) device.reportError(`render pass "${this.label}": resolveTarget format ${rt.format} != attachment ${tex.format}`);
        if (rt && (rt.usage & TextureUsage.RENDER_ATTACHMENT) === 0) device.reportError("render pass: resolveTarget lacks RENDER_ATTACHMENT usage");
      }
      if (a.loadOp === "clear" && a.clearValue !== undefined) {
        const values = typeof (a.clearValue as GPUColorDict).r === "number" ? [(a.clearValue as GPUColorDict).r!, (a.clearValue as GPUColorDict).g!, (a.clearValue as GPUColorDict).b!, (a.clearValue as GPUColorDict).a!] : (a.clearValue as number[]);
        for (const v of values) {
          if (!Number.isFinite(v)) device.reportError(`render pass "${this.label}": clearValue contains ${v}`);
        }
        device.clearTexture(tex, values, i);
      }
      tex.lastWrittenBy = this.label;
    });
    const dsa = this.desc.depthStencilAttachment;
    if (dsa) {
      const tex = (dsa.view as unknown as MockGPUTextureView)?.texture;
      if (!tex) this.encoder.device.reportError(`render pass "${this.label}": depth attachment has no view`);
      else {
        if ((tex.usage & TextureUsage.RENDER_ATTACHMENT) === 0) {
          this.encoder.device.reportError(`render pass "${this.label}": depth texture "${tex.label}" lacks RENDER_ATTACHMENT usage`);
        }
        if (!DEPTH_FORMATS.has(tex.format)) this.encoder.device.reportError(`render pass "${this.label}": "${tex.label}" format ${tex.format} is not a depth format`);
        if (dsa.depthReadOnly) {
          // Spec: a read-only depth aspect must not carry load/store ops (GPURenderPassDepthStencilAttachment validation).
          if (dsa.depthLoadOp !== undefined || dsa.depthStoreOp !== undefined) {
            this.encoder.device.reportError(`render pass "${this.label}": depthReadOnly attachment must not set depthLoadOp/depthStoreOp`);
          }
        } else {
          if (dsa.depthLoadOp === undefined) this.encoder.device.reportError(`render pass "${this.label}": depth attachment needs depthLoadOp`);
          if (dsa.depthStoreOp === undefined) this.encoder.device.reportError(`render pass "${this.label}": depth attachment needs depthStoreOp`);
        }
        if (dsa.depthLoadOp === "clear" && dsa.depthClearValue !== undefined) {
          if (dsa.depthClearValue < 0 || dsa.depthClearValue > 1) this.encoder.device.reportError(`render pass "${this.label}": depthClearValue ${dsa.depthClearValue} outside [0,1]`);
        }
        if ((dsa.stencilLoadOp !== undefined) !== (dsa.stencilStoreOp !== undefined)) {
          this.encoder.device.reportError(`render pass "${this.label}": stencilLoadOp and stencilStoreOp must both be present or both absent`);
        }
        if (dsa.stencilLoadOp !== undefined && !STENCIL_FORMATS.has(tex.format)) {
          this.encoder.device.reportError(`render pass "${this.label}": stencil ops need a stencil-capable format, got ${tex.format}`);
        }
        if (!dsa.depthReadOnly) tex.lastWrittenBy = this.label;
      }
    }
    if (this.desc.occlusionQuerySet) {
      const qs = this.desc.occlusionQuerySet as unknown as MockGPUQuerySet;
      if (qs.type !== "occlusion") this.encoder.device.reportError("render pass: occlusionQuerySet must have type 'occlusion'");
      for (const q of this.desc.occlusionQuerySet ? (this.desc as unknown as { occlusionQuerySetEntries?: { queryIndex: number }[] }).occlusionQuerySetEntries ?? [] : []) {
        if (q.queryIndex >= qs.count) this.encoder.device.reportError("render pass: occlusion query index out of range");
      }
    }
    const tw = this.desc.timestampWrites as unknown as { begin?: { queryIndex?: number }; end?: { queryIndex?: number } } | undefined;
    if (tw) {
      for (const side of [tw.begin, tw.end]) {
        if (side && side.queryIndex === undefined) this.encoder.device.reportError("render pass: timestampWrite missing queryIndex");
      }
    }
    // Viewport defaults to the attachment extent.
    const first = this.colorTextures[0] ?? this.depthTexture;
    if (first) this.viewport = { x: 0, y: 0, w: first.width, h: first.height };
    void sampleCount;
  }

  setPipeline(pipeline: MockGPURenderPipeline): void {
    if (this.ended) return this.err("setPipeline after end()");
    if (!(pipeline instanceof MockGPURenderPipeline)) return this.err("setPipeline: pipeline not from this device");
    if (pipeline.destroyed) return this.err("setPipeline: pipeline destroyed");
    for (let i = 0; i < this.colorTextures.length; i++) {
      const fmt = pipeline.colorTargets[i]?.format;
      const tex = this.colorTextures[i];
      if (!fmt) {
        this.err(`pipeline has no color target ${i} but the pass attaches one (${tex.label})`);
        continue;
      }
      if (fmt !== tex.format) this.err(`pipeline color target ${i} format ${fmt} != attachment ${tex.format} ("${tex.label}")`);
    }
    // Extra pipeline targets beyond the pass attachments are allowed only if not written.
    if (pipeline.depthFormat) {
      if (!this.depthTexture) this.err(`pipeline expects depth attachment ${pipeline.depthFormat} but the pass has none`);
      else if (pipeline.depthFormat !== this.depthTexture.format) this.err(`pipeline depth format ${pipeline.depthFormat} != attachment ${this.depthTexture.format}`);
    }
    if (pipeline.depthWriteEnabled && this.depthTexture) {
      if ((this.desc.depthStencilAttachment?.depthReadOnly ?? false) === true) this.err("pipeline writes depth but the pass marks it read-only");
    }
    const attachmentSamples = this.colorTextures[0]?.sampleCount ?? 1;
    if (pipeline.sampleCount !== attachmentSamples) {
      this.err(`pipeline sampleCount ${pipeline.sampleCount} != attachment sampleCount ${attachmentSamples}`);
    }
    if (pipeline.indexFormat === null && this.indexBuffer) {
      // pipelines may draw indexed without declaring indexFormat; ok
    } else if (pipeline.indexFormat && this.indexBuffer && pipeline.indexFormat !== this.indexBuffer.format) {
      this.err(`pipeline indexFormat ${pipeline.indexFormat} != bound index buffer format ${this.indexBuffer.format}`);
    }
    this.pipeline = pipeline;
    this.encoder.device.record({ type: "setPipeline", label: this.label, pipeline: pipeline.label || "(anonymous)" });
  }

  setBindGroup(index: number, group: MockGPUBindGroup | null, dynamicOffsets?: Iterable<number> | Uint32Array): void {
    if (this.ended) return this.err("setBindGroup after end()");
    const maxGroups = this.encoder.device.limitsDict.maxBindGroups ?? 4;
    if (index >= maxGroups) return this.err(`setBindGroup index ${index} >= maxBindGroups ${maxGroups}`);
    if (group === null) {
      this.bindGroups.delete(index);
      return;
    }
    if (!(group instanceof MockGPUBindGroup)) return this.err("setBindGroup: bind group not from this device");
    if (group.destroyed) return this.err(`setBindGroup(${index}): bind group destroyed`);
    const layout = this.pipeline?.layout ?? null;
    if (layout) {
      const expected = layout.layouts[index];
      if (!expected) this.err(`setBindGroup(${index}): pipeline layout has no group ${index}`);
      else if (expected.signature() !== group.layoutSignature) {
        this.err(`setBindGroup(${index}): bind group layout does not match the pipeline layout`);
      }
    }
    const dyn = countIterable(dynamicOffsets);
    if (layout) {
      const required = countDynamic(layout.layouts[index]?.entries ?? []);
      if (required !== dyn.count) {
        this.err(`setBindGroup(${index}): layout declares ${required} dynamic offsets but ${dyn.count} were provided`);
      }
      if (dyn.values) {
        const minAlign = this.encoder.device.limitsDict.minUniformBufferOffsetAlignment ?? MIN_OFFSET_ALIGNMENT;
        for (const off of dyn.values) {
          if (off % minAlign !== 0) this.err(`setBindGroup(${index}): dynamic offset ${off} is not a multiple of ${minAlign}`);
        }
      }
    }
    this.bindGroups.set(index, group);
    this.encoder.device.record({ type: "setBindGroup", label: this.label, index, dynamicOffsets: dyn.values ? Array.from(dyn.values) : [] });
  }

  setVertexBuffer(slot: number, buffer: MockGPUBuffer | null, offset = 0, size?: number): void {
    if (this.ended) return this.err("setVertexBuffer after end()");
    if (buffer === null) {
      this.vertexBuffers.delete(slot);
      return;
    }
    const maxSlots = this.encoder.device.limitsDict.maxVertexBuffers ?? 8;
    if (slot >= maxSlots) return this.err(`setVertexBuffer slot ${slot} >= maxVertexBuffers`);
    if (buffer.destroyed) return this.err("setVertexBuffer: buffer destroyed");
    if ((buffer.usage & BufferUsage.VERTEX) === 0) this.err(`setVertexBuffer(${slot}): buffer "${buffer.label}" lacks VERTEX usage`);
    if (offset % 4 !== 0) this.err(`setVertexBuffer: offset ${offset} must be a multiple of 4`);
    const byteSize = size ?? Math.max(0, buffer.size - offset);
    if (byteSize % 4 !== 0) this.err(`setVertexBuffer: size ${byteSize} must be a multiple of 4`);
    if (offset + byteSize > buffer.size) this.err(`setVertexBuffer: [${offset}, ${offset + byteSize}) exceeds buffer size ${buffer.size}`);
    this.vertexBuffers.set(slot, { buffer, offset, size: byteSize });
    this.encoder.device.record({ type: "setVertexBuffer", label: this.label, slot, offset, size: byteSize });
  }

  setIndexBuffer(buffer: MockGPUBuffer | null, format: GPUIndexFormat, offset = 0, size?: number): void {
    if (this.ended) return this.err("setIndexBuffer after end()");
    if (buffer === null) {
      this.indexBuffer = null;
      return;
    }
    if (buffer.destroyed) return this.err("setIndexBuffer: buffer destroyed");
    if ((buffer.usage & BufferUsage.INDEX) === 0) this.err("setIndexBuffer: buffer lacks INDEX usage");
    const align = format === "uint32" ? 4 : 2;
    if (offset % align !== 0) this.err(`setIndexBuffer: offset ${offset} must be a multiple of ${align} for ${format}`);
    const byteSize = size ?? Math.max(0, buffer.size - offset);
    if (byteSize % align !== 0) this.err(`setIndexBuffer: size ${byteSize} must be a multiple of ${align}`);
    if (offset + byteSize > buffer.size) this.err("setIndexBuffer: range exceeds buffer size");
    this.indexBuffer = { buffer, format, offset, count: byteSize / align };
    this.encoder.device.record({ type: "setIndexBuffer", label: this.label, format, offset, size: byteSize });
  }

  setViewport(x: number, y: number, w: number, h: number, minDepth = 0, maxDepth = 1): void {
    if (this.ended) return this.err("setViewport after end()");
    if (!(w > 0) || !(h > 0)) this.err(`setViewport: extent ${w}x${h} must be positive`);
    if (!Number.isFinite(minDepth) || !Number.isFinite(maxDepth) || minDepth > maxDepth) this.err("setViewport: invalid depth range");
    if (maxDepth > 1 || minDepth < 0) this.err("setViewport: depth must be within [0,1]");
    this.viewport = { x, y, w, h };
    this.dynamicDepth = minDepth !== 0 || maxDepth !== 1;
  }

  setScissorRect(x: number, y: number, w: number, h: number): void {
    if (this.ended) return this.err("setScissorRect after end()");
    if (!Number.isInteger(x) || !Number.isInteger(y) || !Number.isInteger(w) || !Number.isInteger(h)) {
      this.err("setScissorRect: values must be integers");
    }
    if (w < 0 || h < 0) this.err("setScissorRect: negative extent");
    this.scissorSet = true;
  }

  setBlendConstant(): void {}
  setStencilReference(reference: number): void {
    if (!Number.isInteger(reference) || reference < 0 || reference > 255) this.err(`setStencilReference: ${reference} is not a u8`);
  }

  executeBundles(): void {
    this.err("executeBundles: render bundles are not implemented by the mock (the engine does not use bundles)");
  }

  draw(vertexCount: number, instanceCount = 1, firstVertex = 0, firstInstance = 0): void {
    if (!this.beginDraw()) return;
    if (!Number.isInteger(vertexCount) || vertexCount < 1) this.err(`draw: vertexCount ${vertexCount} must be a positive integer`);
    if (!Number.isInteger(instanceCount) || instanceCount < 1) this.err(`draw: instanceCount ${instanceCount} must be a positive integer`);
    if (this.pipeline?.indexFormat) this.err("draw() on a pipeline that declares an indexFormat");
    this.checkVertexCoverage(vertexCount, instanceCount, firstVertex);
    this.countDraw(vertexCount, instanceCount);
    this.encoder.device.record({ type: "draw", label: this.label, vertexCount, instanceCount, firstVertex, firstInstance });
  }

  drawIndexed(indexCount: number, instanceCount = 1, firstIndex = 0, baseVertex = 0, firstInstance = 0): void {
    if (!this.beginDraw()) return;
    if (!Number.isInteger(indexCount) || indexCount < 1) this.err(`drawIndexed: indexCount ${indexCount} invalid`);
    if (!this.indexBuffer) this.err("drawIndexed: no index buffer bound");
    else {
      if (firstIndex + indexCount > this.indexBuffer.count) {
        this.err(`drawIndexed: [${firstIndex}, ${firstIndex + indexCount}) exceeds ${this.indexBuffer.count} indices in the bound range`);
      }
    }
    let maxIndex = 0;
    if (this.indexBuffer) {
      const ib = this.indexBuffer;
      const view = ib.format === "uint32"
        ? new Uint32Array(ib.buffer.data, ib.offset)
        : new Uint16Array(ib.buffer.data, ib.offset);
      const end = Math.min(firstIndex + indexCount, view.length);
      for (let i = firstIndex; i < end; i++) {
        const val = view[i]!;
        if (val > maxIndex) maxIndex = val;
      }
    }
    this.checkVertexCoverage(maxIndex + 1, instanceCount, 0, baseVertex);
    this.countDraw(indexCount, instanceCount);
    this.encoder.device.record({ type: "drawIndexed", label: this.label, indexCount, instanceCount, firstIndex, baseVertex, firstInstance });
  }

  drawIndirect(buffer: MockGPUBuffer, offset = 0): void {
    if (!this.beginDraw()) return;
    if ((buffer.usage & BufferUsage.INDIRECT) === 0) this.err("drawIndirect: buffer lacks INDIRECT usage");
    if (offset % 16 !== 0) this.err(`drawIndirect: offset ${offset} must be a multiple of 16`);
    if (offset + 16 > buffer.size) this.err("drawIndirect: buffer too small for a 4×u32 record");
    this.encoder.device.record({ type: "draw", label: this.label, indirect: true, offset });
  }

  drawIndexedIndirect(buffer: MockGPUBuffer, offset = 0): void {
    if (!this.beginDraw()) return;
    if ((buffer.usage & BufferUsage.INDIRECT) === 0) this.err("drawIndexedIndirect: buffer lacks INDIRECT usage");
    if (offset % 16 !== 0) this.err("drawIndexedIndirect: offset must be a multiple of 16");
    if (!this.indexBuffer) this.err("drawIndexedIndirect: no index buffer bound");
    this.encoder.device.record({ type: "drawIndexed", label: this.label, indirect: true, offset });
  }

  private beginDraw(): boolean {
    // Viewport bounds: an out-of-range viewport is a validation error on real devices and a common
    // "why is my offscreen pass empty" cause, so the mock reports it at draw time.
    const target = this.colorTextures[0] ?? this.depthTexture;
    if (target) {
      const v = this.viewport;
      if (v.x < 0 || v.y < 0 || v.w <= 0 || v.h <= 0 || v.x + v.w > target.width || v.y + v.h > target.height) {
        this.err(`viewport (${v.x},${v.y} ${v.w}x${v.h}) is outside the ${target.width}x${target.height} attachment`);
      }
    }
    if (this.ended) {
      this.err("draw after end()");
      return false;
    }
    if (!this.pipeline) {
      this.err("draw without a bound pipeline");
      return false;
    }
    if (this.pipeline.destroyed) {
      this.err("draw with a destroyed pipeline");
      return false;
    }
    return true;
  }

  private checkVertexCoverage(count: number, _instances: number, first: number, baseVertex = 0): void {
    const p = this.pipeline;
    if (!p) return;
    for (let slot = 0; slot < p.vertexBuffers.length; slot++) {
      const layout = p.vertexBuffers[slot];
      const attrs = layout ? [...(layout.attributes ?? [])] : [];
      if (!layout || attrs.length === 0) continue;
      const bound = this.vertexBuffers.get(slot);
      if (!bound) {
        this.err(`draw: pipeline expects vertex buffer slot ${slot} (stride ${layout.arrayStride}) but none is bound`);
        return;
      }
      const stride = layout.arrayStride;
      if (stride === 0) continue;
      const needed = count * stride;
      if (first * stride + needed > bound.size) {
        this.err(`draw: slot ${slot} needs ${first * stride + needed} bytes from offset ${bound.offset}, bound size is ${bound.size}`);
      }
      void baseVertex;
    }
  }

  private countDraw(count: number, instances: number): void {
    this.drawCalls++;
    this.instances += instances;
    const device = this.encoder.device;
    device.drawCalls++;
    device.verticesDrawn += count * instances;
    const perInstance = this.pipeline?.topology === "triangle-strip" ? Math.max(0, count - 2) : Math.floor(count / 3);
    this.triangles += perInstance * instances;
    device.trianglesDrawn += perInstance * instances;
  }

  end(): void {
    if (this.ended) {
      this.err("end() called twice on the same render pass");
      return;
    }
    this.ended = true;
    if (!this.valid) return;
    const device = this.encoder.device;
    device.passes.push({
      label: this.label,
      kind: "render",
      drawCalls: this.drawCalls,
      triangles: this.triangles,
      instances: this.instances,
      colorTargets: this.colorTextures.map((t) => t.label),
      depthTarget: this.depthTexture?.label ?? null,
      depthStoreOp: this.depthTexture ? (this.desc.depthStencilAttachment?.depthReadOnly ? "read-only" : (this.desc.depthStencilAttachment?.depthStoreOp ?? null)) : null,
      dispatches: 0,
    });
    this.passesForTesting.push(this);
    if (this.drawCalls === 0) device.noteEmptyPass(this.label, "render");
    device.record({ type: "passEnd", label: this.label });
    void this.scissorSet;
    void this.dynamicDepth;
  }

  /** Exposed for tests that inspect a finished pass. */
  readonly passesForTesting: MockGPURenderPassEncoder[] = [];
  get state(): { pipeline: string | null; bindGroups: number[]; vertexBuffers: number[] } {
    return {
      pipeline: this.pipeline?.label ?? null,
      bindGroups: [...this.bindGroups.keys()],
      vertexBuffers: [...this.vertexBuffers.keys()],
    };
  }
}

export class MockGPUComputePassEncoder {
  private pipeline: MockGPUComputePipeline | null = null;
  private bindGroups = new Map<number, MockGPUBindGroup>();
  private ended = false;
  dispatches = 0;
  readonly label: string;

  constructor(
    private readonly encoder: MockGPUCommandEncoder,
    readonly desc: GPUComputePassDescriptor,
    private readonly valid: boolean,
  ) {
    this.label = desc.label ?? "(compute pass)";
    if (this.valid) encoder.device.record({ type: "computePass", label: this.label });
  }

  private err(message: string): void {
    this.encoder.device.reportError(`[compute pass "${this.label}"] ${message}`);
  }

  setPipeline(pipeline: MockGPUComputePipeline): void {
    if (this.ended) return this.err("setPipeline after end()");
    if (!(pipeline instanceof MockGPUComputePipeline)) return this.err("setPipeline: not a compute pipeline from this device");
    if (pipeline.destroyed) return this.err("setPipeline: destroyed pipeline");
    this.pipeline = pipeline;
    this.encoder.device.record({ type: "setPipeline", label: this.label, pipeline: pipeline.label || "(anonymous)" });
  }

  setBindGroup(index: number, group: MockGPUBindGroup | null, dynamicOffsets?: Iterable<number> | Uint32Array): void {
    if (this.ended) return this.err("setBindGroup after end()");
    if (index >= (this.encoder.device.limitsDict.maxBindGroups ?? 4)) return this.err(`setBindGroup index ${index} >= maxBindGroups`);
    if (group === null) {
      this.bindGroups.delete(index);
      return;
    }
    if (!(group instanceof MockGPUBindGroup)) return this.err("setBindGroup: bind group from another device");
    if (group.destroyed) return this.err(`setBindGroup(${index}): bind group destroyed`);
    const layout = this.pipeline?.layout ?? null;
    if (layout) {
      const expected = layout.layouts[index];
      if (!expected) this.err(`setBindGroup(${index}): pipeline layout has no group at ${index}`);
      else if (expected.signature() !== group.layoutSignature) this.err(`setBindGroup(${index}): bind group layout mismatch`);
      const required = countDynamic(expected?.entries ?? []);
      const dyn = countIterable(dynamicOffsets);
      if (required !== dyn.count) this.err(`setBindGroup(${index}): expected ${required} dynamic offsets, got ${dyn.count}`);
    }
    this.bindGroups.set(index, group);
    this.encoder.device.record({ type: "setBindGroup", label: this.label, index });
  }

  dispatchWorkgroups(x: number, y = 1, z = 1): void {
    if (this.ended) return this.err("dispatchWorkgroups after end()");
    if (!this.pipeline) return this.err("dispatchWorkgroups without a bound pipeline");
    const limits = this.encoder.device.limitsDict;
    if (!Number.isInteger(x) || x < 1) this.err(`dispatchWorkgroups: x=${x} must be a positive integer`);
    if (x > (limits.maxComputeWorkgroupsPerDimension ?? 65535)) this.err(`dispatchWorkgroups: x=${x} exceeds maxComputeWorkgroupsPerDimension`);
    for (const [name, v] of [["y", y], ["z", z]] as const) {
      if (!Number.isInteger(v) || v < 1) this.err(`dispatchWorkgroups: ${name}=${v} must be a positive integer`);
      if (v > (limits.maxComputeWorkgroupsPerDimension ?? 65535)) this.err(`dispatchWorkgroups: ${name} exceeds limit`);
    }
    this.dispatches++;
    const device = this.encoder.device;
    device.dispatches++;
    device.dispatchWorkgroups += x * y * z;
    for (const g of this.bindGroups.values()) {
      for (const { resource } of g.bindings.values()) {
        const r = resource as { buffer?: MockGPUBuffer; texture?: MockGPUTextureView };
        if (r.buffer) r.buffer.computeTouchCount++;
        if (r.texture) r.texture.texture.lastWrittenBy = this.label;
      }
    }
    this.encoder.device.record({ type: "dispatch", label: this.label, x, y, z });
  }

  dispatchWorkgroupsIndirect(buffer: MockGPUBuffer, offset = 0): void {
    if (this.ended) return this.err("dispatchWorkgroupsIndirect after end()");
    if (!this.pipeline) return this.err("dispatchWorkgroupsIndirect without a bound pipeline");
    if ((buffer.usage & BufferUsage.INDIRECT) === 0) this.err("dispatchWorkgroupsIndirect: buffer lacks INDIRECT usage");
    if (offset % 16 !== 0) this.err("dispatchWorkgroupsIndirect: offset must be a multiple of 16");
    if (offset + 12 > buffer.size) this.err("dispatchWorkgroupsIndirect: buffer too small");
    this.dispatches++;
    this.encoder.device.dispatches++;
    this.encoder.device.record({ type: "dispatch", label: this.label, indirect: true, offset });
  }

  end(): void {
    if (this.ended) {
      this.err("end() called twice");
      return;
    }
    this.ended = true;
    if (!this.valid) return;
    const device = this.encoder.device;
    device.passes.push({
      label: this.label,
      kind: "compute",
      drawCalls: 0,
      triangles: 0,
      instances: 0,
      colorTargets: [],
      depthTarget: null,
      depthStoreOp: null,
      dispatches: this.dispatches,
    });
    if (this.dispatches === 0) device.noteEmptyPass(this.label, "compute");
    device.record({ type: "passEnd", label: this.label });
  }
}

export interface MockGPUCommandBuffer {
  readonly label: string;
  readonly encoder: MockGPUCommandEncoder;
}

export class MockGPUQueue {
  label = "mock-queue";
  writeBufferCalls = 0;
  writeTextureCalls = 0;
  submitCount = 0;
  bytesUploaded = 0;
  workDoneCallbacks = 0;

  constructor(readonly device: MockGPUDevice) {}

  writeBuffer(buffer: MockGPUBuffer, bufferOffset: number, data: AllowSharedBufferSource, dataOffset = 0, size?: number): void {
    const device = this.device;
    if (!(buffer instanceof MockGPUBuffer)) {
      device.reportError("writeBuffer: buffer not from this device");
      return;
    }
    if (buffer.destroyed) device.reportError(`writeBuffer: buffer "${buffer.label}" is destroyed`);
    if (buffer.mapState === "mapped") device.reportError("writeBuffer: buffer has a mapped range");
    if ((buffer.usage & BufferUsage.COPY_DST) === 0) {
      device.reportError(`writeBuffer: buffer "${buffer.label}" lacks COPY_DST usage`);
    }
    if (bufferOffset % 4 !== 0) device.reportError(`writeBuffer: bufferOffset ${bufferOffset} must be a multiple of 4`);
    const src = asUint8(data);
    const writeSize = size ?? Math.max(0, src.byteLength - dataOffset);
    if (writeSize < 0) device.reportError("writeBuffer: negative size");
    if (dataOffset + writeSize > src.byteLength) {
      device.reportError(`writeBuffer: reads [${dataOffset}, ${dataOffset + writeSize}) but the source is ${src.byteLength} bytes`);
    }
    if (bufferOffset + writeSize > buffer.size) {
      device.reportError(`writeBuffer: writes [${bufferOffset}, ${bufferOffset + writeSize}) into a ${buffer.size}-byte buffer`);
    }
    if (device.lost) device.reportError("writeBuffer: device lost");
    new Uint8Array(buffer.data, bufferOffset, writeSize).set(src.subarray(dataOffset, dataOffset + writeSize));
    buffer.writeCount++;
    buffer.lastWriteBytes = writeSize;
    this.writeBufferCalls++;
    this.bytesUploaded += writeSize;
    device.record({ type: "writeBuffer", buffer: buffer.label, offset: bufferOffset, size: writeSize });
  }

  writeTexture(destination: GPUImageCopyTextureTagged | GPUImageCopyTexture, data: AllowSharedBufferSource, dataLayout: GPUImageDataLayout, copySize: GPUExtent3D): void {
    const device = this.device;
    const tex = (destination as GPUImageCopyTexture).texture as unknown as MockGPUTexture;
    if (!(tex instanceof MockGPUTexture)) {
      device.reportError("writeTexture: destination.texture must be a GPUTexture");
      return;
    }
    if (tex.destroyed) device.reportError("writeTexture: texture destroyed");
    if ((tex.usage & TextureUsage.COPY_DST) === 0) device.reportError(`writeTexture: texture "${tex.label}" lacks COPY_DST`);
    const dims = normalizeExtent(copySize);
    if (dims.width === 0 || dims.height === 0) device.reportError("writeTexture: zero-extent copy");
    const offset = dataLayout.offset ?? 0;
    if (offset % 4 !== 0) device.reportError("writeTexture: offset must be a multiple of 4");
    const bpp = Math.max(1, mockBytesPerTexel(tex.format));
    const bytesPerRow = dataLayout.bytesPerRow ?? dims.width * bpp;
    if (dims.height > 1 && bytesPerRow < dims.width * bpp) device.reportError(`writeTexture: bytesPerRow ${bytesPerRow} < row bytes ${dims.width * bpp}`);
    const src = asUint8(data);
    const rowsPerImage = dataLayout.rowsPerImage ?? dims.height;
    const needed = offset + bytesPerRow * (dims.height + (dims.depthOrArrayLayers - 1) * rowsPerImage);
    if (needed > src.byteLength) device.reportError(`writeTexture: data has ${src.byteLength} bytes, copy needs ${needed}`);
    const mip = (destination as GPUImageCopyTexture).mipLevel ?? 0;
    if (mip >= tex.mipLevelCount) device.reportError(`writeTexture: mip ${mip} >= mipLevelCount ${tex.mipLevelCount}`);
    const origin = originXYZ((destination as GPUImageCopyTexture).origin);
    const { w: mw, h: mh } = formatMipSize(tex.width, tex.height, mip);
    if (origin.x + dims.width > mw || origin.y + dims.height > mh) {
      device.reportError(`writeTexture: copy exceeds mip ${mip} extent ${mw}x${mh}`);
    }
    for (let layer = 0; layer < Math.max(1, dims.depthOrArrayLayers); layer++) {
      const dstBase = mipRange(tex, mip, origin.z + layer).offset;
      for (let y = 0; y < dims.height; y++) {
        for (let x = 0; x < dims.width; x++) {
          const si = offset + layer * rowsPerImage * bytesPerRow + y * bytesPerRow + x * bpp;
          const di = dstBase + ((origin.y + y) * mw + origin.x + x) * bpp;
          if (di + bpp > tex.storage.length || si + bpp > src.length) continue;
          for (let b = 0; b < bpp; b++) tex.storage[di + b] = src[si + b] ?? 0;
        }
      }
    }
    tex.lastWrittenBy = "writeTexture";
    this.writeTextureCalls++;
    device.record({ type: "writeTexture", texture: tex.label, width: dims.width, height: dims.height });
  }

  copyExternalImageToTexture(source: GPUCopyExternalImageSourceInfo, destination: GPUCopyExternalImageDestInfo, copySize: GPUExtent3D): void {
    const device = this.device;
    // Real WebGPU reads from an ImageBitmap/canvas; the mock accepts anything with a data view so
    // engine code paths (which prefer writeTexture) can still be exercised.
    const src = (source as unknown as { source: { data?: Uint8Array; width?: number; height?: number } }).source;
    if (!src || !src.data) {
      device.reportError("copyExternalImageToTexture: mock needs { source: { data, width, height } } — use writeTexture for real content");
      return;
    }
    this.writeTexture(
      { texture: destination.texture as unknown as GPUTexture, mipLevel: destination.mipLevel, origin: destination.origin } as GPUImageCopyTexture,
      src.data,
      { bytesPerRow: (src.width ?? 1) * 4 },
      copySize,
    );
  }

  submit(commandBuffers: readonly MockGPUCommandBuffer[]): void {
    const device = this.device;
    this.submitCount++;
    device.submitCount++;
    if (device.lost) {
      device.reportError("submit: device lost");
      return;
    }
    for (const cb of commandBuffers) {
      if (!cb || typeof cb !== "object" || !(cb as MockGPUCommandBuffer).encoder) {
        device.reportError("submit: not a mock command buffer");
        continue;
      }
      if (!cb.encoder.finished) device.reportError("submit: command encoder was never finished");
      const passCount = cb.encoder.passLabels.length;
      device.submittedPassLabels.push(...cb.encoder.passLabels);
      if (passCount === 0) device.noteEmptySubmission();
      device.commandBufferCount++;
    }
    device.record({ type: "submit", commandBuffers: commandBuffers.length });
    if (device.options.loseAfterSubmissions !== undefined && device.submitCount >= device.options.loseAfterSubmissions) {
      void device.lose("mock: simulated device loss");
    }
  }

  async onSubmittedWorkDone(): Promise<undefined> {
    this.workDoneCallbacks++;
    return undefined;
  }
}

function asUint8(data: AllowSharedBufferSource): Uint8Array {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return new Uint8Array(0);
}

function countIterable(values: Iterable<number> | Uint32Array | undefined): { count: number; values: Iterable<number> | Uint32Array | null } {
  if (!values) return { count: 0, values: null };
  if (values instanceof Uint32Array) return { count: values.length, values };
  let n = 0;
  for (const _ of values) n++;
  return { count: n, values };
}

function countDynamic(entries: GPUBindGroupLayoutEntry[]): number {
  let n = 0;
  for (const e of entries) if (e.buffer?.hasDynamicOffset) n++;
  return n;
}

export class MockGPUDevice {
  readonly label = "mock-device";
  readonly features: ReadonlySet<string>;
  readonly queue: MockGPUQueue;
  readonly limits: GPUSupportedLimits;
  readonly limitsDict: Record<string, number | undefined>;
  readonly adapterInfo: { vendor: string; architecture: string; device: string; description: string };
  readonly options: MockGpuOptions;
  readonly commandLog: CommandLogEntry[] = [];
  readonly passes: MockPassRecord[] = [];
  readonly errors: string[] = [];
  readonly warnings: string[] = [];
  readonly emptyPasses: { label: string; kind: string }[] = [];
  readonly liveBuffers = new Set<MockGPUBuffer>();
  readonly liveTextures = new Set<MockGPUTexture>();
  readonly created: Partial<Record<MockResourceKind, number>> = {};
  readonly destroyed: Partial<Record<MockResourceKind, number>> = {};
  lost = false;
  lostReason = "";
  lostPromise: Promise<LostInfo>;
  onuncapturederror: ((event: { error: GPUError }) => void) | null = null;
  onlost: ((info: LostInfo) => void) | null = null;
  drawCalls = 0;
  trianglesDrawn = 0;
  verticesDrawn = 0;
  dispatches = 0;
  dispatchWorkgroups = 0;
  submitCount = 0;
  commandBufferCount = 0;
  emptySubmissions = 0;
  pipelinesDestroyed = 0;
  readonly submittedPassLabels: string[] = [];
  lastShaderSource = "";
  shaderModulesCreated = 0;
  private errorStack = new ErrorStack();
  private errorListeners: ((e: GPUError) => void)[] = [];
  private textureBytes = 0;
  private resolveLost!: (v: LostInfo) => void;
  readonly throwOnError: boolean;
  readonly commandLogEnabled: boolean;

  constructor(options: MockGpuOptions = {}) {
    this.options = options;
    this.throwOnError = options.strict ?? false;
    this.commandLogEnabled = options.recordCommands ?? true;
    this.features = new Set<string>(options.features ?? DEFAULT_FEATURES);
    this.limitsDict = { ...DEFAULT_LIMITS, ...(options.limits ?? {}) } as Record<string, number | undefined>;
    this.limits = this.limitsDict as unknown as GPUSupportedLimits;
    this.queue = new MockGPUQueue(this);
    this.adapterInfo = { vendor: "forge", architecture: "mock", device: "mock", description: "Forge mock WebGPU device" };
    this.lostPromise = new Promise((r) => {
      this.resolveLost = r;
    });
  }

  /** Capability table consumed by `GraphicsDevice` (mirrors the real feature names). */
  get capabilities(): Record<string, boolean> {
    const f = this.features;
    return {
      timestampQuery: f.has("timestamp-query"),
      depthClipControl: f.has("depth-clip-control"),
      textureCompressionBC: f.has("texture-compression-bc"),
      textureCompressionBCSliced3D: f.has("texture-compression-bc-sliced-3d"),
      textureCompressionETC2: f.has("texture-compression-etc2"),
      textureCompressionASTC: f.has("texture-compression-astc"),
      float32Filterable: f.has("float32-filterable"),
      indirectFirstInstance: f.has("indirect-first-instance"),
      shaderF16: f.has("shader-f16"),
      subgroups: f.has("subgroups"),
      clipDistances: f.has("clip-distances"),
      dualSourceBlending: f.has("dual-source-blending"),
    };
  }

  /** Feature names the engine understands, filtered by availability. */
  get engineFeatures(): string[] {
    return Object.keys(this.capabilities).filter((k) => this.capabilities[k]);
  }

  createBuffer(desc: GPUBufferDescriptor): MockGPUBuffer {
    const b = new MockGPUBuffer(this, desc);
    this.liveBuffers.add(b);
    return b;
  }

  createTexture(desc: GPUTextureDescriptor): MockGPUTexture {
    const t = new MockGPUTexture(this, desc);
    this.liveTextures.add(t);
    return t;
  }

  createSampler(desc: GPUSamplerDescriptor = {}): MockGPUSampler {
    return new MockGPUSampler(this, desc);
  }

  createBindGroupLayout(desc: GPUBindGroupLayoutDescriptor): MockGPUBindGroupLayout {
    return new MockGPUBindGroupLayout(this, desc);
  }

  createPipelineLayout(desc: GPUPipelineLayoutDescriptor): MockGPUPipelineLayout {
    return new MockGPUPipelineLayout(this, desc);
  }

  createBindGroup(desc: GPUBindGroupDescriptor): MockGPUBindGroup {
    return new MockGPUBindGroup(this, desc);
  }

  createShaderModule(desc: GPUShaderModuleDescriptor): MockGPUShaderModule {
    this.shaderModulesCreated++;
    this.lastShaderSource = desc.code ?? "";
    return new MockGPUShaderModule(this, desc);
  }

  createRenderPipeline(desc: GPURenderPipelineDescriptor): MockGPURenderPipeline {
    return new MockGPURenderPipeline(this, desc);
  }

  async createRenderPipelineAsync(desc: GPURenderPipelineDescriptor): Promise<MockGPURenderPipeline> {
    // One microtask of latency so async pipeline paths are actually exercised as async.
    await Promise.resolve();
    return new MockGPURenderPipeline(this, desc);
  }

  createComputePipeline(desc: GPUComputePipelineDescriptor): MockGPUComputePipeline {
    return new MockGPUComputePipeline(this, desc);
  }

  async createComputePipelineAsync(desc: GPUComputePipelineDescriptor): Promise<MockGPUComputePipeline> {
    await Promise.resolve();
    return new MockGPUComputePipeline(this, desc);
  }

  createQuerySet(desc: GPUQuerySetDescriptor): MockGPUQuerySet {
    return new MockGPUQuerySet(this, desc);
  }

  pushErrorScope(filter: GPUErrorFilter): void {
    this.errorStack.push(filter);
  }

  async popErrorScope(): Promise<GPUError | null> {
    return this.errorStack.pop();
  }

  addEventListener(type: string, listener: (e: unknown) => void): void {
    if (type === "uncapturederror") this.errorListeners.push(listener as (e: GPUError) => void);
  }

  removeEventListener(type: string, listener: (e: unknown) => void): void {
    if (type === "uncapturederror") {
      const i = this.errorListeners.indexOf(listener as (e: GPUError) => void);
      if (i >= 0) this.errorListeners.splice(i, 1);
    }
  }

  reportError(message: string): void {
    this.errors.push(message);
    const error: MockError = { message, kind: "validation" };
    this.errorStack.report(error);
    if (this.errorStack.unhandled.length > 0) {
      for (const l of this.errorListeners) l(error);
      this.onuncapturederror?.({ error });
    }
    if (this.throwOnError) throw new Error(`WebGPU validation error: ${message}`);
  }

  warn(message: string): void {
    this.warnings.push(message);
  }

  noteEmptyPass(label: string, kind: string): void {
    this.emptyPasses.push({ label, kind });
  }

  noteEmptySubmission(): void {
    this.emptySubmissions++;
  }

  record(entry: CommandLogEntry): void {
    if (this.commandLogEnabled) this.commandLog.push(entry);
  }

  addMemory(bytes: number): void {
    this.textureBytes += bytes;
    const budget = this.options.maxMemoryBytes;
    if (budget !== undefined && this.textureBytes > budget) {
      this.reportError(`out of memory: ${this.textureBytes} texture bytes exceed the ${budget} byte budget`);
    }
  }

  liveViews = 0;

  trackCreate(kind: MockResourceKind, obj: object): void {
    void obj;
    this.created[kind] = (this.created[kind] ?? 0) + 1;
    if (kind === "view") this.liveViews++;
  }

  trackDestroy(kind: MockResourceKind, obj: object): void {
    this.destroyed[kind] = (this.destroyed[kind] ?? 0) + 1;
    if (kind === "texture") this.liveTextures.delete(obj as MockGPUTexture);
    if (kind === "buffer") this.liveBuffers.delete(obj as MockGPUBuffer);
    if (kind === "renderPipeline" || kind === "computePipeline") this.pipelinesDestroyed++;
    if (kind === "view") this.liveViews = Math.max(0, this.liveViews - 1);
  }

  get memoryStats(): MockMemoryStats {
    let bufferBytes = 0;
    for (const b of this.liveBuffers) bufferBytes += b.size;
    return {
      liveBuffers: this.liveBuffers.size,
      bufferBytes,
      liveTextures: this.liveTextures.size,
      textureBytes: this.textureBytes,
      liveViews: this.liveViews,
      liveBindGroups: (this.created.bindGroup ?? 0) - (this.destroyed.bindGroup ?? 0),
      livePipelines: (this.created.renderPipeline ?? 0) + (this.created.computePipeline ?? 0) - (this.destroyed.renderPipeline ?? 0) - (this.destroyed.computePipeline ?? 0),
      totalBytes: bufferBytes + this.textureBytes,
      created: { ...this.created },
      destroyed: { ...this.destroyed },
    };
  }

  /** Names of live resources — the payload of a leak failure. */
  get outstanding(): { buffers: string[]; textures: string[] } {
    return {
      buffers: [...this.liveBuffers].map((b) => b.label || "(unnamed)"),
      textures: [...this.liveTextures].map((t) => t.label || "(unnamed)"),
    };
  }

  get validationErrors(): string[] {
    return [...new Set(this.errors)];
  }

  hasValidationErrors(): boolean {
    return this.errors.length > 0;
  }

  clearErrors(): void {
    this.errors.length = 0;
    this.warnings.length = 0;
    this.errorStack.clear();
  }

  /** Emulate a clear: writes the colour into the texture's CPU storage. */
  clearTexture(tex: MockGPUTexture, rgba: readonly number[], _attachment: number): void {
    const bpp = Math.max(1, mockBytesPerTexel(tex.format));
    const isFloat = tex.format.includes("float");
    for (let m = 0; m < tex.mipLevelCount; m++) {
      for (let layer = 0; layer < tex.depthOrArrayLayers; layer++) {
        const { w, h } = formatMipSize(tex.width, tex.height, m);
        const base = mipRange(tex, m, layer).offset;
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
            const o = base + (y * w + x) * bpp;
            if (o + bpp > tex.storage.length) continue;
            if (isFloat) {
              const view = new DataView(tex.storage.buffer, tex.storage.byteOffset + o, Math.min(16, bpp));
              const comps = Math.min(4, Math.floor(bpp / 4));
              for (let c = 0; c < comps; c++) view.setFloat32(c * 4, rgba[c] ?? 0, true);
            } else {
              for (let c = 0; c < Math.min(4, bpp); c++) tex.storage[o + c] = Math.round(clamp01(rgba[c] ?? (c === 3 ? 1 : 0)) * 255);
            }
          }
        }
      }
    }
    tex.clearCount++;
  }

  readTextureBytes(tex: MockGPUTexture, mip = 0, layer = 0): Uint8Array {
    const { offset, bytes } = mipRange(tex, mip, layer);
    return tex.storage.slice(offset, offset + bytes);
  }

  /** Average colour of a texture (float format aware) — used by "did this pass draw anything". */
  averageColor(tex: MockGPUTexture, mip = 0): { r: number; g: number; b: number; a: number } {
    const { w, h } = formatMipSize(tex.width, tex.height, mip);
    const bpp = Math.max(1, mockBytesPerTexel(tex.format));
    const { offset } = mipRange(tex, mip, 0);
    const isFloat = tex.format.includes("float");
    let r = 0;
    let g = 0;
    let b = 0;
    let a = 0;
    const n = Math.max(1, w * h);
    for (let i = 0; i < n; i++) {
      const o = offset + i * bpp;
      if (o + bpp > tex.storage.length) break;
      if (isFloat) {
        const view = new DataView(tex.storage.buffer, tex.storage.byteOffset + o, 16);
        r += view.getFloat32(0, true);
        g += view.getFloat32(4, true);
        b += view.getFloat32(8, true);
        a += view.getFloat32(12, true);
      } else {
        r += tex.storage[o]! / 255;
        g += (tex.storage[o + 1] ?? 0) / 255;
        b += (tex.storage[o + 2] ?? 0) / 255;
        a += (tex.storage[o + 3] ?? 255) / 255;
      }
    }
    return { r: r / n, g: g / n, b: b / n, a: a / n };
  }

  async lose(reason = "mock: device lost"): Promise<void> {
    if (this.lost) return;
    this.lost = true;
    this.lostReason = reason;
    this.resolveLost({ reason: "uncaptured-error", message: reason });
    this.onlost?.({ reason: "uncaptured-error", message: reason });
  }

  destroy(): void {
    for (const b of [...this.liveBuffers]) b.destroy();
    for (const t of [...this.liveTextures]) t.destroy();
    void this.lose("destroyed");
  }

  /** Tests call this right after a frame: fails loudly on any validation error. */
  assertClean(): void {
    if (this.errors.length === 0) return;
    const unique = [...new Set(this.errors)];
    throw new Error(`mock device reported ${unique.length} validation error(s):\n  - ${unique.slice(0, 40).join("\n  - ")}`);
  }

  createCommandEncoder(desc?: GPUCommandEncoderDescriptor): MockGPUCommandEncoder {
    return new MockGPUCommandEncoder(this, desc);
  }
}

interface LostInfo {
  reason: "destroyed" | "uncaptured-error" | "unknown";
  message: string;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export class MockGPUAdapter {
  readonly features: ReadonlySet<string>;
  readonly limits: GPUSupportedLimits;
  readonly limitsDict: Record<string, number | undefined>;
  readonly isFallbackAdapter: boolean;
  readonly info: { vendor: string; architecture: string; description: string; device: string };
  device: MockGPUDevice | null = null;

  constructor(readonly options: MockGpuOptions = {}) {
    this.features = new Set<string>(options.features ?? DEFAULT_FEATURES);
    this.limitsDict = { ...DEFAULT_LIMITS, ...(options.limits ?? {}) } as Record<string, number | undefined>;
    this.limits = this.limitsDict as unknown as GPUSupportedLimits;
    this.isFallbackAdapter = false;
    this.info = { vendor: "forge", architecture: "mock", description: "Forge mock adapter", device: "mock" };
  }

  /** The device handed out by this adapter (null until requested). Mirrors the one-device rule. */
  get requestedDevice(): MockGPUDevice | null {
    return this.device;
  }

  async requestDevice(desc?: GPUDeviceDescriptor): Promise<MockGPUDevice> {
    for (const f of desc?.requiredFeatures ?? []) {
      if (!this.features.has(f)) throw new Error(`requestDevice: unsupported required feature "${f}"`);
    }
    const requested = desc?.requiredLimits as Record<string, number> | undefined;
    if (requested) {
      for (const [k, v] of Object.entries(requested)) {
        const avail = this.limitsDict[k];
        if (avail !== undefined && v > avail) throw new Error(`requestDevice: limit ${k}=${v} exceeds adapter limit ${avail}`);
      }
    }
    const device = new MockGPUDevice({ ...this.options, features: new Set([...this.features]) as never } as MockGpuOptions);
    if (desc?.requiredFeatures) {
      (device as { features: ReadonlySet<string> }).features = new Set<string>(desc.requiredFeatures);
    }
    this.device = device;
    return device;
  }

  async requestAdapterInfo(): Promise<GPUAdapterInfo> {
    return { ...this.info, os: "linux", subgroupMinSize: 4, subgroupMaxSize: 32 } as unknown as GPUAdapterInfo;
  }
}

export interface MockCanvasContext {
  configure(cfg: { device: MockGPUDevice; format: GPUTextureFormat; alphaMode?: string; usage?: number; viewFormats?: GPUTextureFormat[] }): void;
  getCurrentTexture(): MockGPUTexture;
  getCurrentTextureView(): MockGPUTextureView;
  canvas: { width: number; height: number };
  unconfigure(): void;
  onlyConfigureCalls: number;
}

/**
 * Build a mock navigator/adapter/device trio. The returned context behaves like a swapchain:
 * `getCurrentTexture()` returns a texture sized to the canvas, recreated on resize, and it is
 * tracked so leaks are visible.
 */
export function createMockGpu(options: MockGpuOptions = {}): {
  adapter: MockGPUAdapter;
  device: MockGPUDevice;
  context: MockCanvasContext;
  canvas: { width: number; height: number };
} {
  const adapter = new MockGPUAdapter(options);
  let device: MockGPUDevice | null = null;
  let format = options.preferredCanvasFormat ?? "bgra8unorm";
  let swapchain: MockGPUTexture | null = null;
  const canvas = { width: 1280, height: 720 };
  let onlyConfigureCalls = 0;
  const context: MockCanvasContext = {
    canvas,
    get onlyConfigureCalls() {
      return onlyConfigureCalls;
    },
    configure(cfg) {
      device = cfg.device as MockGPUDevice;
      format = cfg.format;
      swapchain = null;
      onlyConfigureCalls++;
    },
    unconfigure() {
      swapchain?.destroy();
      swapchain = null;
    },
    getCurrentTexture() {
      if (!device) throw new Error("getCurrentTexture() before configure()");
      if (swapchain && !swapchain.destroyed && swapchain.width === canvas.width && swapchain.height === canvas.height) return swapchain;
      swapchain?.destroy();
      swapchain = device.createTexture({
        label: "swapchain",
        size: { width: Math.max(1, canvas.width), height: Math.max(1, canvas.height) },
        format,
        usage: TextureUsage.RENDER_ATTACHMENT | TextureUsage.COPY_SRC,
      });
      return swapchain;
    },
    getCurrentTextureView() {
      return context.getCurrentTexture().createView({ label: "swapchain-view" });
    },
  };
  // The device must exist *before* anything asks for it: the engine's mock path
  // (`GraphicsDevice.create({ forceMock: true })`) reads `mock.device` synchronously, and returning a
  // null placeholder there produced a confusing "cannot read properties of null" instead of a frame.
  const mockDevice = new MockGPUDevice({ ...options, features: new Set([...adapter.features]) as never } as MockGpuOptions);
  device = mockDevice;
  adapter.device = mockDevice;
  const gpu = {
    adapter,
    device,
    context,
    canvas,
    get canvasFormat(): GPUTextureFormat {
      return format;
    },
    setCanvasFormat(f: GPUTextureFormat): void {
      format = f;
    },
    /** Present one frame (the swapchain texture is what `getCurrentTexture()` hands out). */
    submitFrame(): number {
      mockDevice.submitCount++;
      return mockDevice.submitCount;
    },
    get submittedFrames(): number {
      return mockDevice.submitCount;
    },
    get errors(): string[] {
      return mockDevice.errors;
    },
    get outstanding(): { buffers: string[]; textures: string[] } {
      return mockDevice.outstanding;
    },
    get leakedCount(): number {
      const o = mockDevice.outstanding;
      return o.buffers.length + o.textures.length;
    },
    stats(): Record<string, number> {
      const o = mockDevice.outstanding;
      return {
        submittedFrames: mockDevice.submitCount,
        liveBuffers: o.buffers.length,
        liveTextures: o.textures.length,
        validationErrors: mockDevice.errors.length,
        passes: mockDevice.submittedPassLabels.length,
      };
    },
  };
  return gpu;
}


/** Assertion helper used across GPU tests. */
export function assertNoValidationErrors(device: MockGPUDevice, context = "device"): void {
  if (device.errors.length === 0) return;
  const unique = [...new Set(device.errors)];
  throw new Error(`${context}: ${unique.length} WebGPU validation error(s):\n  - ${unique.slice(0, 50).join("\n  - ")}`);
}
