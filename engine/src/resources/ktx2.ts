/**
 * KTX2 / Basis Universal texture loading (Phase 15.6).
 *
 * Basis Universal is transcoded at load time to a format this WebGPU device actually supports:
 * BC7, ASTC 4x4, ETC2 RGBA, then uncompressed RGBA8 as the universal fallback. HDR Basis content
 * uses BC6H when available and otherwise RGBA16F. The KTX2 mip chain, array layers and cube faces
 * are uploaded directly; compressed data is never expanded on the CPU unless the adapter requires
 * the RGBA fallback.
 */

import {
  BasisTextureFormat,
  BasisUniversal,
  TranscoderTextureFormat,
  type KTX2Transcoder as BasisKtx2Transcoder,
  type TranscodeResult,
} from "@h00w/basis-universal-transcoder";
import { AssetError, CapabilityError, UsageError } from "../core/errors.js";
import { TextureUsage } from "../gpu/constants.js";
import { formatInfo, maxMipLevels } from "../gpu/formats.js";
import type { GraphicsDevice } from "../gpu/device.js";
import { Texture } from "./texture.js";

const KTX2_IDENTIFIER = new Uint8Array([0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a]);

export type Ktx2Target = "auto" | "bc7" | "astc" | "etc2" | "rgba8";
export type Ktx2ColorSpace = "auto" | "linear" | "srgb";

export interface Ktx2TextureOptions {
  label?: string;
  /** Explicitly override the KTX2 DFD transfer function (e.g. force normal maps to linear). */
  colorSpace?: Ktx2ColorSpace;
  /** `auto` selects the best supported compressed format and falls back to RGBA8. */
  target?: Ktx2Target;
  /**
   * Test/tool seam for a custom Basis transcoder build. Production defaults to the bundled
   * `@h00w/basis-universal-transcoder` WASM module.
   */
  transcoderFactory?: () => BasisKtx2Transcoder | Promise<BasisKtx2Transcoder>;
  /** Used in AssetError messages; no network request is performed by this module. */
  source?: string;
}

export interface Ktx2TargetChoice {
  transcoderFormat: TranscoderTextureFormat;
  gpuFormat: GPUTextureFormat;
  compressed: boolean;
  hdr: boolean;
  family: Exclude<Ktx2Target, "auto"> | "rgba16f";
}

/** Create/load the singleton WASM transcoder lazily (non-KTX2 projects pay no decode startup cost). */
let basisInstance: Promise<BasisUniversal> | null = null;
function getBasisUniversal(): Promise<BasisUniversal> {
  if (!basisInstance) {
    // Keep the bundler-specific `?url` import lazy: Node-side engine tools can import the public
    // barrel without asking Node's ESM resolver to load a Vite asset query.
    const attempt = import("./basisWasmUrl.js").then(({ default: wasmUrl }) => BasisUniversal.getInstance(async (imports) => {
      const response = await fetch(wasmUrl);
      if (!response.ok) throw new AssetError(`failed to fetch Basis transcoder WASM (${response.status})`, wasmUrl);
      const bytes = await response.arrayBuffer();
      return WebAssembly.instantiate(bytes, imports);
    }));
    basisInstance = attempt.catch((error: unknown) => {
      basisInstance = null;
      throw error;
    });
  }
  return basisInstance;
}

async function defaultTranscoderFactory(): Promise<BasisKtx2Transcoder> {
  return (await getBasisUniversal()).createKTX2Transcoder();
}

/**
 * Transcode one KTX2 texture and upload each mip/layer/face to a WebGPU texture. Supports 2D,
 * 2D-array and cube/cube-array data. 3D volume KTX2 is rejected clearly (the bundled C API does
 * not expose its depth slices through the current JS binding).
 */
export async function loadKtx2Texture(device: GraphicsDevice, input: ArrayBuffer | ArrayBufferView, options: Ktx2TextureOptions = {}): Promise<Texture> {
  const bytes = asBytes(input);
  const source = options.source ?? options.label ?? "<memory KTX2>";
  if (!hasKtx2Identifier(bytes)) throw new AssetError("not a KTX2 file (invalid identifier)", source, "E_ASSET_KTX2");
  const srgb = options.colorSpace === "auto" || options.colorSpace === undefined
    ? detectKtx2Srgb(bytes) === true
    : options.colorSpace === "srgb";
  let transcoder: BasisKtx2Transcoder | null = null;
  let texture: Texture | null = null;
  try {
    transcoder = await (options.transcoderFactory ?? defaultTranscoderFactory)();
    if (!transcoder.init(bytes)) throw new AssetError("Basis Universal could not parse the KTX2 payload", source, "E_ASSET_KTX2");

    // The header views WASM memory; snapshot every field before any call that can grow that heap.
    const header = transcoder.getHeader();
    const width = header.width;
    const height = header.height;
    const depth = header.depth;
    const layers = Math.max(1, header.layers);
    const faces = header.faces;
    const levels = header.levels;
    if (depth !== 0) throw new AssetError("3D/volume KTX2 textures are not supported by this transcoder binding", source, "E_ASSET_KTX2_VOLUME");
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
      throw new AssetError(`KTX2 has invalid dimensions ${width}x${height}`, source, "E_ASSET_KTX2");
    }
    if (width > device.limits.maxTextureDimension2D || height > device.limits.maxTextureDimension2D) {
      throw new AssetError(`KTX2 dimensions ${width}x${height} exceed the device limit ${device.limits.maxTextureDimension2D}`, source, "E_ASSET_TEXTURE_LIMIT");
    }
    if (!Number.isInteger(layers) || layers < 1 || !Number.isInteger(faces) || (faces !== 1 && faces !== 6)) {
      throw new AssetError(`KTX2 has unsupported layer/face counts (${layers} layers, ${faces} faces)`, source, "E_ASSET_KTX2");
    }
    const arrayLayers = layers * faces;
    const maxArrayLayers = Number((device.device.limits as GPUSupportedLimits).maxTextureArrayLayers ?? 256);
    if (arrayLayers > maxArrayLayers) throw new AssetError(`KTX2 needs ${arrayLayers} array layers, device limit is ${maxArrayLayers}`, source, "E_ASSET_TEXTURE_LIMIT");
    if (!Number.isInteger(levels) || levels < 1 || levels > maxMipLevels(width, height)) {
      throw new AssetError(`KTX2 has invalid mip count ${levels} for ${width}x${height}`, source, "E_ASSET_KTX2");
    }
    if (!transcoder.startTranscoding()) throw new AssetError("Basis Universal rejected KTX2 transcoding", source, "E_ASSET_KTX2_TRANSCODE");

    const basisFormat = transcoder.getBasisTextureFormat();
    const isHdr = basisFormat === BasisTextureFormat.cUASTC_HDR_4x4 ||
      basisFormat === BasisTextureFormat.cASTC_HDR_6x6 ||
      basisFormat === BasisTextureFormat.cASTC_HDR_6x6_INTERMEDIATE;
    const requestedTarget = options.target ?? "auto";
    let target = chooseKtx2Target(device, srgb && !isHdr, isHdr, requestedTarget);
    const targetInfo = formatInfo(target.gpuFormat);
    if (target.compressed && (width % targetInfo.blockWidth !== 0 || height % targetInfo.blockHeight !== 0)) {
      if (requestedTarget !== "auto") {
        throw new CapabilityError(`KTX2 dimensions ${width}x${height} are not aligned to the ${targetInfo.blockWidth}x${targetInfo.blockHeight} block size required by "${target.gpuFormat}"`);
      }
      // WebGPU requires compressed base-level texture dimensions to align to whole blocks. The
      // uncompressed target preserves arbitrary KTX2 dimensions without padding the logical image.
      target = chooseKtx2Target(device, srgb && !isHdr, isHdr, "rgba8");
    }
    const label = options.label ?? source;
    texture = Texture.create(device, {
      width,
      height,
      depthOrArrayLayers: arrayLayers,
      format: target.gpuFormat,
      mipLevelCount: levels,
      usage: TextureUsage.TEXTURE_BINDING | TextureUsage.COPY_DST,
      label,
      dimension: "2d",
    });

    for (let level = 0; level < levels; level++) {
      const expectedWidth = Math.max(1, width >> level);
      const expectedHeight = Math.max(1, height >> level);
      for (let layer = 0; layer < layers; layer++) {
        for (let face = 0; face < faces; face++) {
          const result: TranscodeResult | null = transcoder.transcodeImageLevel({
            format: target.transcoderFormat,
            level,
            layer,
            face,
          });
          if (!result) throw new AssetError(`Basis transcode failed at mip ${level}, layer ${layer}, face ${face}`, source, "E_ASSET_KTX2_TRANSCODE");
          if (result.width !== expectedWidth || result.height !== expectedHeight) {
            throw new AssetError(`Basis returned ${result.width}x${result.height} for mip ${level}; expected ${expectedWidth}x${expectedHeight}`, source, "E_ASSET_KTX2_TRANSCODE");
          }
          // The next WASM call can invalidate this view. Copy before it and upload immediately.
          const levelBytes = result.data.slice();
          texture.writeMipData(device, level, layer * faces + face, levelBytes);
        }
      }
    }
    const complete = texture;
    texture = null;
    return complete;
  } catch (error) {
    texture?.release();
    if (error instanceof AssetError || error instanceof CapabilityError || error instanceof UsageError) throw error;
    throw new AssetError(`KTX2 load failed: ${error instanceof Error ? error.message : String(error)}`, source, "E_ASSET_KTX2");
  } finally {
    transcoder?.dispose();
  }
}

/** Choose the highest-quality WebGPU target supported by the current adapter. */
export function chooseKtx2Target(device: GraphicsDevice, srgb: boolean, hdr: boolean, requested: Ktx2Target = "auto"): Ktx2TargetChoice {
  const pick = (family: Ktx2TargetChoice["family"]): Ktx2TargetChoice => {
    if (hdr) {
      if (family === "bc7" && device.caps.textureCompressionBc) {
        return { family, hdr: true, compressed: true, transcoderFormat: TranscoderTextureFormat.cTFBC6H, gpuFormat: "bc6h-rgb-ufloat" };
      }
      if (family === "rgba16f") {
        return { family, hdr: true, compressed: false, transcoderFormat: TranscoderTextureFormat.cTFRGBA_HALF, gpuFormat: "rgba16float" };
      }
      throw new CapabilityError(`KTX2 HDR target "${family}" is not supported by this device`);
    }
    if (family === "bc7" && device.caps.textureCompressionBc) {
      return { family, hdr: false, compressed: true, transcoderFormat: TranscoderTextureFormat.cTFBC7_RGBA, gpuFormat: srgb ? "bc7-rgba-unorm-srgb" : "bc7-rgba-unorm" };
    }
    if (family === "astc" && device.caps.textureCompressionAstc) {
      return { family, hdr: false, compressed: true, transcoderFormat: TranscoderTextureFormat.cTFASTC_4x4_RGBA, gpuFormat: srgb ? "astc-4x4-unorm-srgb" : "astc-4x4-unorm" };
    }
    if (family === "etc2" && device.caps.textureCompressionEtc2) {
      return { family, hdr: false, compressed: true, transcoderFormat: TranscoderTextureFormat.cTFETC2_RGBA, gpuFormat: srgb ? "etc2-rgba8unorm-srgb" : "etc2-rgba8unorm" };
    }
    if (family === "rgba8") {
      return { family, hdr: false, compressed: false, transcoderFormat: TranscoderTextureFormat.cTFRGBA32, gpuFormat: srgb ? "rgba8unorm-srgb" : "rgba8unorm" };
    }
    throw new CapabilityError(`KTX2 target "${family}" is not supported by this device`);
  };

  if (hdr) {
    if (requested !== "auto" && requested !== "bc7" && requested !== "rgba8") {
      throw new CapabilityError(`KTX2 HDR content cannot use the requested LDR target "${requested}"`);
    }
    if ((requested === "auto" || requested === "bc7") && device.caps.textureCompressionBc) return pick("bc7");
    return pick("rgba16f");
  }
  if (requested !== "auto") return pick(requested);
  if (device.caps.textureCompressionBc) return pick("bc7");
  if (device.caps.textureCompressionAstc) return pick("astc");
  if (device.caps.textureCompressionEtc2) return pick("etc2");
  return pick("rgba8");
}

/** Detect the KTX2 DFD transfer function (1 = linear, 2 = sRGB). Null means absent/unknown. */
export function detectKtx2Srgb(input: ArrayBuffer | ArrayBufferView): boolean | null {
  const bytes = asBytes(input);
  if (!hasKtx2Identifier(bytes) || bytes.byteLength < 68) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const dfdOffset = view.getUint32(48, true);
  const dfdLength = view.getUint32(52, true);
  if (dfdOffset < 80 || dfdLength < 16 || dfdOffset + dfdLength > bytes.byteLength) return null;
  // DFD: totalSize (4), vendor/type/version/blockSize (8), colorModel + primaries + transfer + flags.
  const blockSize = view.getUint16(dfdOffset + 10, true);
  if (blockSize < 16 || blockSize > dfdLength - 4) return null;
  const transfer = view.getUint8(dfdOffset + 14);
  if (transfer === 1) return false;
  if (transfer === 2) return true;
  return null;
}

/** Whether a byte view begins with the 12-byte KTX2 identifier. */
export function hasKtx2Identifier(input: ArrayBuffer | ArrayBufferView): boolean {
  const bytes = asBytes(input);
  if (bytes.byteLength < KTX2_IDENTIFIER.length) return false;
  for (let i = 0; i < KTX2_IDENTIFIER.length; i++) if (bytes[i] !== KTX2_IDENTIFIER[i]) return false;
  return true;
}

function asBytes(input: ArrayBuffer | ArrayBufferView): Uint8Array {
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
}
