/**
 * `Texture`: a GPU texture + its views, with ownership rules.
 *
 * Textures are the resource most likely to leak (they are big, and mip/array slices need extra
 * views), so this wrapper:
 *  - caches views by (dimension, format, baseMip, mipCount, layer, layerCount), because creating a
 *    `GPUTextureView` per draw is a real cost, and
 *  - tracks `release()` exactly once (double release is a no-op, use-after-release throws) so the
 *    leak counters in the mock device mean something.
 */

import { TextureUsage, gpuSource } from "../gpu/constants.js";
import { formatInfo, maxMipLevels, textureSizeBytes } from "../gpu/formats.js";
import { ResourceLifecycleError, UsageError } from "../core/errors.js";
import { linearToSrgb, srgbToLinear } from "../math/scalar.js";
import type { GraphicsDevice } from "../gpu/device.js";

export interface TextureDesc {
  width: number;
  height?: number;
  depthOrArrayLayers?: number;
  format: GPUTextureFormat;
  mipLevelCount?: number;
  sampleCount?: number;
  usage?: number;
  label?: string;
  dimension?: GPUTextureDimension;
  /** Read-back support (adds COPY_DST/COPY_SRC implicitly when requested). */
  copySrc?: boolean;
  copyDst?: boolean;
}

export interface TextureViewKey {
  dimension?: GPUTextureViewDimension;
  format?: GPUTextureFormat;
  baseMipLevel?: number;
  mipLevelCount?: number;
  baseArrayLayer?: number;
  arrayLayerCount?: number;
}

export class Texture {
  gpuTexture: GPUTexture | null;
  readonly desc: ResolvedTextureDesc;
  private readonly views = new Map<string, GPUTextureView>();
  private released = false;
  /** Set when the texture came from the resource registry, so refcounting owns disposal. */
  ownedByRegistry = false;

  private constructor(device: GraphicsDevice, desc: ResolvedTextureDesc, texture: GPUTexture | null) {
    this.desc = desc;
    this.gpuTexture = texture;
    void device;
  }

  static create(device: GraphicsDevice, desc: TextureDesc): Texture {
    if (desc.width <= 0) throw new UsageError(`Texture.create: width must be > 0 (got ${desc.width})`);
    const height = desc.height ?? 1;
    if (desc.dimension !== "1d" && height <= 0) throw new UsageError(`Texture.create: height must be > 0 (got ${height})`);
    const maxMips = desc.mipLevelCount ?? maxMipLevels(desc.width, height);
    if (maxMips < 1) throw new UsageError("Texture.create: mipLevelCount must be at least 1");
    if (desc.mipLevelCount !== undefined && desc.mipLevelCount > maxMips) {
      throw new UsageError(`Texture.create: ${desc.mipLevelCount} mips exceed the ${maxMips} allowed for ${desc.width}x${height}`);
    }
    let usage = desc.usage ?? 0;
    if (desc.copySrc) usage |= TextureUsage.COPY_SRC;
    if (desc.copyDst) usage |= TextureUsage.COPY_DST;
    if (usage === 0) usage = TextureUsage.TEXTURE_BINDING;
    const texture = device.createTexture({
      label: desc.label ?? "texture",
      size: [desc.width, height, desc.depthOrArrayLayers ?? 1] as unknown as GPUExtent3D,
      format: desc.format,
      mipLevelCount: maxMips,
      sampleCount: desc.sampleCount ?? 1,
      usage,
      dimension: desc.dimension ?? "2d",
    });
    return new Texture(
      device,
      {
        width: desc.width,
        height,
        depthOrArrayLayers: desc.depthOrArrayLayers ?? 1,
        format: desc.format,
        mipLevelCount: maxMips,
        sampleCount: desc.sampleCount ?? 1,
        usage,
        dimension: desc.dimension ?? "2d",
        label: desc.label ?? "texture",
      },
      texture,
    );
  }

  /** 8-bit RGBA texture from CPU pixels (procedural textures, editor thumbnails, LUTs). */
  static fromRgba8(
    device: GraphicsDevice,
    width: number,
    height: number,
    pixels: Uint8Array,
    options: { label?: string; srgb?: boolean; mipmaps?: boolean; normal?: boolean } = {},
  ): Texture {
    const expected = width * height * 4;
    if (pixels.length < expected) throw new UsageError(`fromRgba8: expected at least ${expected} bytes, got ${pixels.length}`);
    if (options.srgb && options.normal) {
      throw new UsageError("fromRgba8: a normal map cannot be sRGB (tangent vectors must average in linear XYZ)");
    }
    const format: GPUTextureFormat = options.srgb ? "rgba8unorm-srgb" : "rgba8unorm";
    const mips = options.mipmaps === false ? 1 : maxMipLevels(width, height);
    const texture = Texture.create(device, {
      width,
      height,
      format,
      mipLevelCount: mips,
      usage: TextureUsage.TEXTURE_BINDING | TextureUsage.COPY_DST | TextureUsage.COPY_SRC,
      label: options.label ?? "rgba8",
    });
    const filter: Rgba8MipFilter = options.normal ? "normal" : options.srgb ? "srgb" : "linear";
    texture.writeRgba8(device, pixels, mips, filter);
    return texture;
  }

  private writeRgba8(device: GraphicsDevice, pixels: Uint8Array, mips: number, filter: Rgba8MipFilter): void {
    let level = pixels.subarray(0, this.desc.width * this.desc.height * 4);
    let width = this.desc.width;
    let height = this.desc.height;
    for (let mip = 0; mip < mips; mip++) {
      const bytesPerRow = width * 4; // unaligned is legal for queue.writeTexture
      device.device.queue.writeTexture(
        { texture: this.gpuTexture!, mipLevel: mip, origin: [0, 0, 0] as unknown as GPUOrigin3D },
        gpuSource(level),
        { bytesPerRow, rowsPerImage: height },
        [width, height, 1] as unknown as GPUExtent3D,
      );
      if (mip + 1 >= mips) break;
      const nextW = Math.max(1, width >> 1);
      const nextH = Math.max(1, height >> 1);
      level = boxFilterRgba8(level, width, height, nextW, nextH, filter);
      width = nextW;
      height = nextH;
    }
  }

  get width(): number {
    return this.desc.width;
  }

  get height(): number {
    return this.desc.height;
  }

  get mipLevels(): number {
    return this.desc.mipLevelCount;
  }

  get format(): GPUTextureFormat {
    return this.desc.format;
  }

  get isDepth(): boolean {
    return formatInfo(this.desc.format).isDepth;
  }

  /** Bytes on the GPU including all mip levels. */
  get gpuBytes(): number {
    return textureSizeBytes({
      format: this.desc.format,
      width: this.desc.width,
      height: this.desc.height,
      mipLevelCount: this.desc.mipLevelCount,
      depthOrArrayLayers: this.desc.depthOrArrayLayers,
    });
  }

  get view(): GPUTextureView {
    return this.viewFor({});
  }

  viewFor(key: TextureViewKey): GPUTextureView {
    const cacheKey = `${key.dimension ?? "2d"}|${key.format ?? ""}|${key.baseMipLevel ?? 0}|${key.mipLevelCount ?? "all"}|${key.baseArrayLayer ?? 0}|${key.arrayLayerCount ?? "all"}`;
    const cached = this.views.get(cacheKey);
    if (cached) return cached;
    if (!this.gpuTexture) throw new ResourceLifecycleError(`Texture "${this.desc.label}" was released; its view cannot be created`);
    const view = this.gpuTexture.createView({
      dimension: key.dimension ?? (this.desc.depthOrArrayLayers > 1 ? "2d-array" : "2d"),
      format: key.format ?? this.desc.format,
      baseMipLevel: key.baseMipLevel ?? 0,
      mipLevelCount: key.mipLevelCount,
      baseArrayLayer: key.baseArrayLayer ?? 0,
      arrayLayerCount: key.arrayLayerCount,
      aspect: key.format?.includes("depth") ? "depth" : undefined,
    } as never);
    this.views.set(cacheKey, view);
    return view;
  }

  release(device?: GraphicsDevice): void {
    if (this.released) return;
    this.released = true;
    this.views.clear();
    this.gpuTexture?.destroy();
    this.gpuTexture = null;
    void device;
  }

  dispose(): void {
    this.release();
  }

  get releasedState(): boolean {
    return this.released;
  }

  /** @internal for tests: number of cached views (they must not grow unboundedly). */
  get viewCacheSize(): number {
    return this.views.size;
  }
}

export interface ResolvedTextureDesc {
  width: number;
  height: number;
  depthOrArrayLayers: number;
  format: GPUTextureFormat;
  mipLevelCount: number;
  sampleCount: number;
  usage: number;
  dimension: GPUTextureDimension;
  label: string;
}

/**
 * The 1×1 textures the renderer binds when a material has no map. Sharing them (instead of null
 * bindings) keeps one bind group layout for every material, which is what makes pipeline switching
 * cheap.
 */
export class TextureDefaults {
  white!: Texture;
  black!: Texture;
  /** Flat tangent-space normal (128,128,255). */
  normal!: Texture;
  /** Metallic=0 in B, roughness=0.5 in G. */
  mr!: Texture;
  private ready = false;

  ensure(device: GraphicsDevice): void {
    if (this.ready) return;
    this.white = Texture.fromRgba8(device, 1, 1, new Uint8Array([255, 255, 255, 255]), { label: "default.white", mipmaps: false });
    this.black = Texture.fromRgba8(device, 1, 1, new Uint8Array([0, 0, 0, 255]), { label: "default.black", mipmaps: false });
    this.normal = Texture.fromRgba8(device, 1, 1, new Uint8Array([128, 128, 255, 255]), { label: "default.normal", mipmaps: false });
    this.mr = Texture.fromRgba8(device, 1, 1, new Uint8Array([0, 128, 0, 255]), { label: "default.mr", mipmaps: false });
    this.ready = true;
  }

  dispose(): void {
    this.white?.release();
    this.black?.release();
    this.normal?.release();
    this.mr?.release();
    this.ready = false;
  }
}

/** How `boxFilterRgba8` averages a 2×2 block into the next mip texel. */
export type Rgba8MipFilter = "linear" | "srgb" | "normal";

/**
 * Box-filter one rgba8 mip into the next. Averages 2×2 blocks (with clamp on odd edges) so
 * `fromRgba8(..., { mipmaps: true })` uploads a full chain instead of leaving higher mips
 * undefined — undefined mips read as garbage on some GPUs and as black on others, and either
 * way a tiled terrain albedo/normal without mips sparkles into moiré at grazing angles.
 *
 * Filter modes:
 * - `linear` — average stored bytes (metallic-roughness, masks, generic rgba8unorm).
 * - `srgb` — decode to linear light, average, re-encode (albedo / baseColor).
 * - `normal` — unpack tangent-space XYZ, average, renormalize, pack (normal maps).
 */
export function boxFilterRgba8(
  src: Uint8Array,
  srcW: number,
  srcH: number,
  dstW: number,
  dstH: number,
  filter: Rgba8MipFilter = "linear",
): Uint8Array {
  const dst = new Uint8Array(dstW * dstH * 4);
  for (let y = 0; y < dstH; y++) {
    const y0 = Math.min(srcH - 1, y * 2);
    const y1 = Math.min(srcH - 1, y0 + 1);
    for (let x = 0; x < dstW; x++) {
      const x0 = Math.min(srcW - 1, x * 2);
      const x1 = Math.min(srcW - 1, x0 + 1);
      const i00 = (y0 * srcW + x0) * 4;
      const i10 = (y0 * srcW + x1) * 4;
      const i01 = (y1 * srcW + x0) * 4;
      const i11 = (y1 * srcW + x1) * 4;
      const o = (y * dstW + x) * 4;
      if (filter === "srgb") {
        for (let c = 0; c < 3; c++) {
          const lin =
            srgbToLinear(src[i00 + c]! / 255) +
            srgbToLinear(src[i10 + c]! / 255) +
            srgbToLinear(src[i01 + c]! / 255) +
            srgbToLinear(src[i11 + c]! / 255);
          dst[o + c] = Math.round(linearToSrgb(lin * 0.25) * 255);
        }
        dst[o + 3] = ((src[i00 + 3]! + src[i10 + 3]! + src[i01 + 3]! + src[i11 + 3]!) + 2) >> 2;
      } else if (filter === "normal") {
        let nx = 0;
        let ny = 0;
        let nz = 0;
        for (const i of [i00, i10, i01, i11]) {
          nx += src[i]! / 255 * 2 - 1;
          ny += src[i + 1]! / 255 * 2 - 1;
          nz += src[i + 2]! / 255 * 2 - 1;
        }
        nx *= 0.25;
        ny *= 0.25;
        nz *= 0.25;
        const len = Math.hypot(nx, ny, nz) || 1;
        dst[o] = Math.round(((nx / len) * 0.5 + 0.5) * 255);
        dst[o + 1] = Math.round(((ny / len) * 0.5 + 0.5) * 255);
        dst[o + 2] = Math.round(((nz / len) * 0.5 + 0.5) * 255);
        dst[o + 3] = ((src[i00 + 3]! + src[i10 + 3]! + src[i01 + 3]! + src[i11 + 3]!) + 2) >> 2;
      } else {
        for (let c = 0; c < 4; c++) {
          dst[o + c] = ((src[i00 + c]! + src[i10 + c]! + src[i01 + c]! + src[i11 + c]!) + 2) >> 2;
        }
      }
    }
  }
  return dst;
}
