/**
 * Texture format knowledge: sizes, block shapes, capability queries.
 *
 * WebGPU gives the engine no way to ask "how big is this texel?" or "is this filterable?", so
 * the tables below are the single source of truth for memory budgeting, mipmap sizing, copy
 * padding and format selection. Keeping them here (rather than scattered through loaders) is what
 * lets `AssetManager` report exact GPU bytes per resource, which the memory budget depends on.
 */

import { CapabilityError } from "../core/errors.js";

export interface FormatInfo {
  format: GPUTextureFormat;
  /** Bytes per block (compressed) or per texel. */
  bytesPerBlock: number;
  blockWidth: number;
  blockHeight: number;
  channels: number;
  /** Float/signed formats need `float32-filterable`-style features to be sampleable. */
  sampleType: "float" | "unorm" | "snorm" | "uint" | "sint" | "depth" | "stencil";
  /** Filterable by a linear sampler without extra features. */
  filterable: boolean;
  /** Can be used as a render target color attachment. */
  renderable: boolean;
  /** sRGB-encoded variant, if one exists. */
  srgbAlias?: GPUTextureFormat;
  /** Number of mip levels for a w×h texture (1 means no mips). */
  /** Depth formats cannot be read as a texture with normal sampling rules in all browsers. */
  isDepth: boolean;
  isCompressed: boolean;
}

const F = (
  format: GPUTextureFormat,
  bytesPerBlock: number,
  channels: number,
  opts: Partial<Omit<FormatInfo, "format" | "bytesPerBlock" | "channels">> = {},
): FormatInfo => ({
  format,
  bytesPerBlock,
  blockWidth: opts.blockWidth ?? 1,
  blockHeight: opts.blockHeight ?? 1,
  channels,
  sampleType: opts.sampleType ?? "float",
  filterable: opts.filterable ?? false,
  renderable: opts.renderable ?? false,
  srgbAlias: opts.srgbAlias,
  isDepth: opts.isDepth ?? false,
  isCompressed: opts.isCompressed ?? false,
});

/** Explicit table: only formats the engine actually targets. Unknown formats are an error. */
const FORMATS: Record<string, FormatInfo> = {
  "r8unorm": F("r8unorm", 1, 1, { sampleType: "unorm", filterable: true, renderable: true }),
  "r8snorm": F("r8snorm", 1, 1, { sampleType: "snorm", filterable: true, renderable: true }),
  "r8uint": F("r8uint", 1, 1, { sampleType: "uint", renderable: true }),
  "r8sint": F("r8sint", 1, 1, { sampleType: "sint", renderable: true }),
  "r16uint": F("r16uint", 2, 1, { sampleType: "uint", renderable: true }),
  "r16sint": F("r16sint", 2, 1, { sampleType: "sint", renderable: true }),
  "r16float": F("r16float", 2, 1, { sampleType: "float", filterable: true, renderable: true }),
  "rg8unorm": F("rg8unorm", 2, 2, { sampleType: "unorm", filterable: true, renderable: true }),
  "rg8snorm": F("rg8snorm", 2, 2, { sampleType: "snorm", filterable: true, renderable: true }),
  "rg16float": F("rg16float", 4, 2, { sampleType: "float", filterable: true, renderable: true }),
  "r32uint": F("r32uint", 4, 1, { sampleType: "uint", renderable: true }),
  "r32sint": F("r32sint", 4, 1, { sampleType: "sint", renderable: true }),
  "r32float": F("r32float", 4, 1, { sampleType: "float", filterable: false, renderable: true }),
  "rg32float": F("rg32float", 8, 2, { sampleType: "float", filterable: false, renderable: true }),
  "rgba8unorm": F("rgba8unorm", 4, 4, { sampleType: "unorm", filterable: true, renderable: true, srgbAlias: "rgba8unorm-srgb" }),
  "rgba8unorm-srgb": F("rgba8unorm-srgb", 4, 4, { sampleType: "unorm", filterable: true, renderable: true }),
  "rgba8snorm": F("rgba8snorm", 4, 4, { sampleType: "snorm", filterable: true, renderable: true }),
  "rgba8uint": F("rgba8uint", 4, 4, { sampleType: "uint", renderable: true }),
  "rgba8sint": F("rgba8sint", 4, 4, { sampleType: "sint", renderable: true }),
  "bgra8unorm": F("bgra8unorm", 4, 4, { sampleType: "unorm", filterable: true, renderable: true }),
  "bgra8unorm-srgb": F("bgra8unorm-srgb", 4, 4, { sampleType: "unorm", filterable: true, renderable: true }),
  "rgb10a2unorm": F("rgb10a2unorm", 4, 4, { sampleType: "unorm", filterable: true, renderable: true }),
  "rg11b10ufloat": F("rg11b10ufloat", 4, 3, { sampleType: "float", filterable: true, renderable: true }),
  "rgba16float": F("rgba16float", 8, 4, { sampleType: "float", filterable: true, renderable: true }),
  "rgba32float": F("rgba32float", 16, 4, { sampleType: "float", filterable: false, renderable: true }),
  "depth16unorm": F("depth16unorm", 2, 1, { sampleType: "depth", isDepth: true, renderable: true }),
  "depth24plus": F("depth24plus", 4, 1, { sampleType: "depth", isDepth: true, renderable: true }),
  "depth24plus-stencil8": F("depth24plus-stencil8", 4, 1, { sampleType: "depth", isDepth: true, renderable: true }),
  "depth32float": F("depth32float", 4, 1, { sampleType: "depth", isDepth: true, renderable: true }),
  "depth32float-stencil8": F("depth32float-stencil8", 8, 1, { sampleType: "depth", isDepth: true, renderable: true }),
  // Compressed (block) formats. Sizes are per 4×4 block.
  "bc1-rgba-unorm": F("bc1-rgba-unorm", 8, 4, { blockWidth: 4, blockHeight: 4, sampleType: "unorm", filterable: true, isCompressed: true }),
  "bc1-rgba-unorm-srgb": F("bc1-rgba-unorm-srgb", 8, 4, { blockWidth: 4, blockHeight: 4, sampleType: "unorm", filterable: true, isCompressed: true }),
  "bc2-rgba-unorm": F("bc2-rgba-unorm", 16, 4, { blockWidth: 4, blockHeight: 4, sampleType: "unorm", filterable: true, isCompressed: true }),
  "bc3-rgba-unorm": F("bc3-rgba-unorm", 16, 4, { blockWidth: 4, blockHeight: 4, sampleType: "unorm", filterable: true, isCompressed: true }),
  "bc3-rgba-unorm-srgb": F("bc3-rgba-unorm-srgb", 16, 4, { blockWidth: 4, blockHeight: 4, sampleType: "unorm", filterable: true, isCompressed: true }),
  "bc4-r-unorm": F("bc4-r-unorm", 8, 1, { blockWidth: 4, blockHeight: 4, sampleType: "unorm", filterable: true, isCompressed: true }),
  "bc4-r-snorm": F("bc4-r-snorm", 8, 1, { blockWidth: 4, blockHeight: 4, sampleType: "snorm", filterable: true, isCompressed: true }),
  "bc5-rg-unorm": F("bc5-rg-unorm", 16, 2, { blockWidth: 4, blockHeight: 4, sampleType: "unorm", filterable: true, isCompressed: true }),
  "bc6h-rgb-ufloat": F("bc6h-rgb-ufloat", 16, 3, { blockWidth: 4, blockHeight: 4, sampleType: "float", filterable: true, isCompressed: true }),
  "bc7-rgba-unorm": F("bc7-rgba-unorm", 16, 4, { blockWidth: 4, blockHeight: 4, sampleType: "unorm", filterable: true, isCompressed: true }),
  "etc2-rgb8unorm": F("etc2-rgb8unorm", 8, 3, { blockWidth: 4, blockHeight: 4, sampleType: "unorm", filterable: true, isCompressed: true }),
  "etc2-rgb8unorm-srgb": F("etc2-rgb8unorm-srgb", 8, 3, { blockWidth: 4, blockHeight: 4, sampleType: "unorm", filterable: true, isCompressed: true }),
  "etc2-rgba8unorm": F("etc2-rgba8unorm", 16, 4, { blockWidth: 4, blockHeight: 4, sampleType: "unorm", filterable: true, isCompressed: true }),
  "etc2-rgba8unorm-srgb": F("etc2-rgba8unorm-srgb", 16, 4, { blockWidth: 4, blockHeight: 4, sampleType: "unorm", filterable: true, isCompressed: true }),
  "astc-4x4-unorm": F("astc-4x4-unorm", 16, 4, { blockWidth: 4, blockHeight: 4, sampleType: "unorm", filterable: true, isCompressed: true }),
  "astc-6x6-unorm": F("astc-6x6-unorm", 16, 4, { blockWidth: 6, blockHeight: 6, sampleType: "unorm", filterable: true, isCompressed: true }),
  "astc-8x8-unorm": F("astc-8x8-unorm", 16, 4, { blockWidth: 8, blockHeight: 8, sampleType: "unorm", filterable: true, isCompressed: true }),
};

export function formatInfo(format: GPUTextureFormat): FormatInfo {
  const info = FORMATS[format];
  if (!info) throw new CapabilityError(`Unknown texture format "${format}"`, { format });
  return info;
}

export function isKnownFormat(format: string): boolean {
  return format in FORMATS;
}

export function isCompressedFormat(format: GPUTextureFormat): boolean {
  return FORMATS[format]?.isCompressed === true;
}

export function isDepthFormat(format: GPUTextureFormat): boolean {
  return FORMATS[format]?.isDepth === true;
}

export function isFilterableFormat(format: GPUTextureFormat): boolean {
  return FORMATS[format]?.filterable === true;
}

/** `rg11b10float`/`rgba32float` etc. are the HDR candidates; only float formats qualify. */
export function isFloatFormat(format: GPUTextureFormat): boolean {
  return FORMATS[format]?.sampleType === "float";
}

/** Bytes in a single row of `width` texels (mip level relative), including nothing else. */
export function bytesPerRow(format: GPUTextureFormat, widthInTexels: number): number {
  const info = formatInfo(format);
  if (info.isCompressed) {
    const blocksX = Math.ceil(widthInTexels / info.blockWidth);
    return blocksX * info.bytesPerBlock;
  }
  return widthInTexels * info.bytesPerBlock;
}

/** Total bytes for a `width`×`height` single-slice subresource. */
export function subresourceBytes(format: GPUTextureFormat, width: number, height: number, depthOrArrayLayers = 1): number {
  const info = formatInfo(format);
  if (info.isCompressed) {
    const blocksX = Math.ceil(width / info.blockWidth);
    const blocksY = Math.ceil(height / info.blockHeight);
    return blocksX * blocksY * info.bytesPerBlock * depthOrArrayLayers;
  }
  return bytesPerRow(format, width) * height * depthOrArrayLayers;
}

/** Size of a texture including all mips — WebGPU's COPY_BYTES_PER_ROW_ALIGNMENT is handled by callers. */
export function textureSizeBytes(desc: {
  format: GPUTextureFormat;
  width: number;
  height: number;
  depthOrArrayLayers?: number;
  mipLevelCount?: number;
}): number {
  let total = 0;
  const mips = desc.mipLevelCount ?? 1;
  for (let m = 0; m < mips; m++) {
    const w = Math.max(1, desc.width >> m);
    const h = Math.max(1, desc.height >> m);
    total += subresourceBytes(desc.format, w, h, desc.depthOrArrayLayers ?? 1);
  }
  return total;
}

export function maxMipLevels(width: number, height: number = width): number {
  const m = Math.floor(Math.log2(Math.max(1, Math.max(width, height)))) + 1;
  return Math.max(1, m);
}

/** WebGPU requires bytesPerRow to be a multiple of 256 for external copies. */
export const COPY_BYTES_PER_ROW_ALIGNMENT = 256;

export function alignedBytesPerRow(rowBytes: number): number {
  return Math.ceil(rowBytes / COPY_BYTES_PER_ROW_ALIGNMENT) * COPY_BYTES_PER_ROW_ALIGNMENT;
}

/** Vertex-format element sizes for input-state computation (bytes). */
const VERTEX_FORMAT_SIZES: Record<string, number> = {
  float16x2: 4,
  float16x4: 8,
  float32x2: 8,
  float32x3: 12,
  float32x4: 16,
  sint8x4: 4,
  sint16x2: 4,
  sint16x4: 8,
  sint32x2: 8,
  sint32x3: 12,
  sint32x4: 16,
  uint8x2: 2,
  uint8x4: 4,
  uint16x2: 4,
  uint16x4: 8,
  uint32x2: 8,
  uint32x3: 12,
  uint32x4: 16,
  "unorm8x2": 2,
  "unorm8x4": 4,
  "snorm8x2": 2,
  "snorm8x4": 4,
  "unorm16x2": 4,
  "unorm16x4": 8,
  "snorm16x2": 4,
  "snorm16x4": 8,
  "float32": 4,
};

export function vertexFormatSize(format: string): number {
  const s = VERTEX_FORMAT_SIZES[format];
  if (s === undefined) throw new CapabilityError(`Unknown vertex format "${format}"`);
  return s;
}

/** Depth formats that are also usable as a sampled float texture (for SSAO/volumetrics). */
export const READABLE_DEPTH_FORMATS: readonly GPUTextureFormat[] = ["depth32float", "depth24plus"];

/**
 * Pick the best available HDR color format for the post-processing chain, given device support.
 * Falls back gracefully — this is the "graceful degradation" requirement in concrete form.
 */
export function pickHdrFormat(supported: (format: GPUTextureFormat) => boolean): { format: GPUTextureFormat; degraded: boolean } {
  const candidates: GPUTextureFormat[] = ["rgba16float", "rgb10a2unorm", "rgba8unorm"];
  for (const format of candidates) {
    if (supported(format)) return { format, degraded: format !== "rgba16float" };
  }
  return { format: "rgba8unorm", degraded: true };
}

/** Swapchain formats, in preference order, per platform convention. */
export function preferredSwapchainFormats(): GPUTextureFormat[] {
  const nav = (globalThis as unknown as { navigator?: { gpu?: { getPreferredCanvasFormat?: () => GPUTextureFormat } } }).navigator;
  const preferred = nav?.gpu?.getPreferredCanvasFormat?.();
  const list: GPUTextureFormat[] = preferred ? [preferred] : [];
  for (const f of ["bgra8unorm", "rgba8unorm", "rgba16float"] as GPUTextureFormat[]) {
    if (!list.includes(f)) list.push(f);
  }
  return list;
}
