/**
 * Phase 16.1c: turn a decoded glTF asset's `images` / `textures` into engine `Texture`s.
 *
 * The worker decoder (`decodeGltfMesh`) only extracts image *bytes*; turning JPEG/PNG/WebP into
 * pixels needs the browser's image codecs, so it happens here, on the main thread, before
 * `instantiateGltfScene` (pass the result as `options.textures`).
 *
 * Colour space is per *use*, not per image: a texture referenced as `baseColorTexture` is uploaded
 * as `rgba8unorm-srgb` (the GPU linearises on sample), as `normalTexture` / `metallicRoughnessTexture`
 * as `rgba8unorm` (normals get the renormalising mip filter). A glTF texture used both ways yields two
 * GPU textures; each image is decoded only once.
 *
 * Scope: every map samples TEXCOORD_0 through the renderer's shared linear-repeat sampler (glTF's
 * default). Non-default sampler wrap/filter modes, KHR_texture_transform, emissive and occlusion maps
 * and compressed (KTX2/Basis) images are not applied; a failing image warns and leaves its map unbound.
 */

import type { GraphicsDevice } from "../gpu/device.js";
import { Texture } from "./texture.js";
import type { DecodedGltfAsset } from "../core/tasks/gltfMesh.js";

export type GltfTextureColorSpace = "srgb" | "linear";

/** Decode encoded image bytes to straight-alpha RGBA8 (row-major, top row first). */
export type GltfImageDecoder = (bytes: Uint8Array, mimeType: string) => Promise<{ width: number; height: number; pixels: Uint8Array }>;

export interface LoadGltfTexturesOptions {
  /** Override image decoding (tests, workers, custom codecs). Default: `createImageBitmap` + 2D canvas. */
  decodeImage?: GltfImageDecoder;
  /** Base URL that external image URIs resolve against (usually the .gltf URL). */
  baseUrl?: string | URL;
  fetcher?: (input: string | URL, init?: RequestInit) => Promise<Response>;
  /** Build mip chains (default true). */
  mipmaps?: boolean;
}

export interface GltfTextureSet {
  /** The GPU texture for glTF texture `index` in `colorSpace`, or null when it was not built / failed. */
  get(index: number | null, colorSpace: GltfTextureColorSpace): Texture | null;
  /** Every texture this set owns. */
  readonly textures: readonly Texture[];
  /** Release every texture (idempotent). Call after the instances using them are disposed. */
  dispose(): void;
}

/** Browser default: no premultiply and no colour-space conversion, so bytes reach the GPU as authored. */
export const defaultGltfImageDecoder: GltfImageDecoder = async (bytes, mimeType) => {
  if (typeof createImageBitmap !== "function" || typeof OffscreenCanvas === "undefined") {
    throw new Error("no image decoder available (needs createImageBitmap + OffscreenCanvas); pass options.decodeImage");
  }
  const blob = new Blob([bytes as BlobPart], mimeType ? { type: mimeType } : undefined);
  const bitmap = await createImageBitmap(blob, { premultiplyAlpha: "none", colorSpaceConversion: "none" });
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new Error("2D canvas context unavailable");
    ctx.drawImage(bitmap, 0, 0);
    const data = ctx.getImageData(0, 0, bitmap.width, bitmap.height).data;
    return { width: bitmap.width, height: bitmap.height, pixels: new Uint8Array(data.buffer, data.byteOffset, data.byteLength) };
  } finally {
    bitmap.close();
  }
};

/** Decode and upload every texture the asset's materials reference. Never rejects for a bad image. */
export async function loadGltfTextures(device: GraphicsDevice, asset: DecodedGltfAsset, options: LoadGltfTexturesOptions = {}): Promise<GltfTextureSet> {
  const decode = options.decodeImage ?? defaultGltfImageDecoder;
  const fetcher = options.fetcher ?? ((input: string | URL, init?: RequestInit) => fetch(input, init));
  const uses = new Map<number, Set<GltfTextureColorSpace | "normal">>();
  const use = (index: number | null, kind: GltfTextureColorSpace | "normal"): void => {
    if (index === null) return;
    let set = uses.get(index);
    if (!set) uses.set(index, (set = new Set()));
    set.add(kind);
  };
  for (const m of asset.materials) {
    use(m.baseColorTexture, "srgb");
    use(m.metallicRoughnessTexture, "linear");
    use(m.normalTexture, "normal");
  }

  const warn = (message: string): void => console.warn(`[gltf] ${asset.source}: ${message}`);
  const pixels = new Map<number, Promise<{ width: number; height: number; pixels: Uint8Array } | null>>();
  const imagePixels = (imageIndex: number) => {
    let p = pixels.get(imageIndex);
    if (!p) {
      const image = asset.images[imageIndex]!;
      p = (async () => {
        try {
          let bytes = image.bytes;
          let mimeType = image.mimeType;
          if (!bytes) {
            if (!image.uri) throw new Error("no bytes and no uri");
            const url = options.baseUrl !== undefined ? new URL(image.uri, options.baseUrl) : image.uri;
            const response = await fetcher(url);
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            bytes = new Uint8Array(await response.arrayBuffer());
            mimeType ||= response.headers.get("content-type") ?? "";
          }
          const decoded = await decode(bytes, mimeType);
          if (!Number.isInteger(decoded.width) || !Number.isInteger(decoded.height) || decoded.width < 1 || decoded.height < 1 || decoded.pixels.length < decoded.width * decoded.height * 4) {
            throw new Error(`decoder returned an invalid ${decoded.width}x${decoded.height} image`);
          }
          return decoded;
        } catch (error) {
          warn(`image ${imageIndex} (${image.name}) not loaded: ${error instanceof Error ? error.message : String(error)}`);
          return null;
        }
      })();
      pixels.set(imageIndex, p);
    }
    return p;
  };

  const built = new Map<string, Texture>();
  const owned: Texture[] = [];
  let disposed = false;
  try {
    await Promise.all([...uses].map(async ([index, kinds]) => {
      const texture = asset.textures[index];
      if (!texture || texture.source === null) {
        warn(`texture ${index} has no supported image source; map ignored`);
        return;
      }
      if (texture.sampler !== null) {
        const s = asset.samplers[texture.sampler]!;
        if (s.wrapS !== 10497 || s.wrapT !== 10497 || s.magFilter === 9728) {
          warn(`texture ${index} sampler ${texture.sampler} (wrap ${s.wrapS}/${s.wrapT}, mag ${s.magFilter}) is approximated with linear-repeat`);
        }
      }
      const image = await imagePixels(texture.source);
      if (!image) return;
      for (const kind of kinds) {
        const t = Texture.fromRgba8(device, image.width, image.height, image.pixels, {
          label: `${asset.source}.texture-${index}.${kind}`,
          srgb: kind === "srgb",
          normal: kind === "normal",
          mipmaps: options.mipmaps ?? true,
        });
        owned.push(t);
        built.set(`${index}:${kind === "srgb" ? "srgb" : "linear"}`, t);
      }
    }));
  } catch (error) {
    for (const t of owned) t.release(device);
    throw error;
  }
  return {
    textures: owned,
    get(index, colorSpace) {
      if (index === null || disposed) return null;
      return built.get(`${index}:${colorSpace}`) ?? null;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const t of owned) t.release(device);
      built.clear();
    },
  };
}
