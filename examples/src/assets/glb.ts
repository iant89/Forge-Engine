/**
 * Minimal glTF 2.0 `.glb` loader for the showcase demo's one static model (the NASA Perseverance
 * rover, converted offline by `scripts/convert-perseverance.mjs` into a plain, non-Draco GLB).
 *
 * Scope, deliberately small: static triangle meshes with POSITION / NORMAL / TEXCOORD_0, the core
 * PBR material block (base-colour + metallic-roughness factors, base-colour / normal /
 * metallic-roughness textures), WebP / PNG / JPEG images decoded through `createImageBitmap`, and
 * node translation. No animation, skinning, cameras or lights — the engine has no asset pipeline
 * yet (see docs/KNOWN-ISSUES.md); this is demo-side plumbing on the public `@forge/engine` API.
 *
 * Conventions the converter guarantees and this loader relies on:
 * - body primitives are already baked to model-root space (identity node transforms),
 * - `wheel_*` root nodes translate to their hub centre and their child meshes are hub-centred,
 * - +Z is the rover's nose, +Y up, metres — the vehicle convention.
 */

import {
  Color,
  Geometry,
  type GeometrySource,
  type GraphicsDevice,
  Material,
  Texture,
  computeNormalsAndTangents,
} from "@forge/engine";

interface GltfAccessor {
  bufferView?: number;
  byteOffset?: number;
  componentType: number;
  count: number;
  type: string;
  min?: number[];
  max?: number[];
}
interface GltfBufferView {
  buffer: number;
  byteOffset?: number;
  byteLength: number;
  byteStride?: number;
}
interface GltfPrimitive {
  attributes: Record<string, number>;
  indices?: number;
  material?: number;
  mode?: number;
}
interface GltfMesh {
  name?: string;
  primitives: GltfPrimitive[];
}
interface GltfMaterial {
  name?: string;
  doubleSided?: boolean;
  alphaMode?: string;
  pbrMetallicRoughness?: {
    baseColorFactor?: number[];
    metallicFactor?: number;
    roughnessFactor?: number;
    baseColorTexture?: { index: number };
    metallicRoughnessTexture?: { index: number };
  };
  normalTexture?: { index: number };
}
interface GltfImage {
  mimeType?: string;
  bufferView: number;
  name?: string;
}
interface GltfJson {
  buffers: { byteLength: number }[];
  bufferViews: GltfBufferView[];
  accessors: GltfAccessor[];
  meshes: GltfMesh[];
  materials?: GltfMaterial[];
  textures?: { source: number }[];
  images?: GltfImage[];
  nodes?: { name?: string; mesh?: number; translation?: number[]; children?: number[] }[];
  scenes?: { nodes?: number[] }[];
  scene?: number;
}

/** One renderable slice: geometry + material, both owned by the `LoadedGlb`. */
export interface GlbPart {
  name: string;
  geometry: Geometry;
  material: Material;
}

/** A wheel group: hub-centred parts plus the hub position the converter recorded on the root. */
export interface GlbWheel {
  name: string;
  hub: [number, number, number];
  parts: GlbPart[];
}

export interface LoadedGlb {
  /** Body meshes in model-root space (converter baked all node transforms). */
  body: GlbPart[];
  /** The six wheels, hub-centred, keyed by `wheel_FL` … `wheel_RR`. */
  wheels: GlbWheel[];
  dispose(): void;
}

const COMPONENT_BYTES: Record<number, number> = { 5126: 4, 5123: 2, 5125: 4, 5121: 1, 5122: 2 };
const TYPE_COMPONENTS: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };

function parseGlb(buffer: ArrayBuffer): { json: GltfJson; bin: Uint8Array } {
  const view = new DataView(buffer);
  if (view.getUint32(0, true) !== 0x46546c67) throw new Error("not a GLB file (magic)");
  let offset = 12;
  let json: GltfJson | null = null;
  let bin: Uint8Array | null = null;
  while (offset < buffer.byteLength) {
    const length = view.getUint32(offset, true);
    const type = view.getUint32(offset + 4, true);
    if (type === 0x4e4f534a) json = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, offset + 8, length)));
    else if (type === 0x004e4942) bin = new Uint8Array(buffer, offset + 8, length);
    offset += 8 + length + ((4 - (length % 4)) % 4);
  }
  if (!json || !bin) throw new Error("GLB missing JSON or BIN chunk");
  return { json, bin };
}

function readAccessor(json: GltfJson, bin: Uint8Array, index: number): Float32Array | Uint32Array {
  const acc = json.accessors[index];
  if (acc.bufferView === undefined) throw new Error(`accessor ${index} has no bufferView (sparse/draco data is not supported)`);
  const bv = json.bufferViews[acc.bufferView];
  const components = TYPE_COMPONENTS[acc.type] ?? 1;
  const elementBytes = COMPONENT_BYTES[acc.componentType]! * components;
  const stride = bv.byteStride ?? elementBytes;
  const start = (bv.byteOffset ?? 0) + (acc.byteOffset ?? 0);
  const out =
    acc.componentType === 5126
      ? new Float32Array(acc.count * components)
      : acc.componentType === 5125 || acc.componentType === 5123
        ? new Uint32Array(acc.count * components)
        : null;
  if (!out) throw new Error(`accessor ${index}: unsupported componentType ${acc.componentType}`);
  const data = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);
  for (let e = 0; e < acc.count; e++) {
    const at = start + e * stride;
    for (let c = 0; c < components; c++) {
      const o = at + c * COMPONENT_BYTES[acc.componentType]!;
      const dst = e * components + c;
      if (acc.componentType === 5126) out[dst] = data.getFloat32(o, true);
      else if (acc.componentType === 5125) out[dst] = data.getUint32(o, true);
      else if (acc.componentType === 5123) out[dst] = data.getUint16(o, true);
      else throw new Error(`accessor ${index}: unsupported componentType ${acc.componentType}`);
    }
  }
  return out;
}

async function imageBytesToTexture(
  device: GraphicsDevice,
  pixelsPromise: Promise<{ width: number; height: number; pixels: Uint8Array } | null>,
  label: string,
  srgb: boolean,
): Promise<Texture | null> {
  const decoded = await pixelsPromise;
  if (!decoded) return null;
  return Texture.fromRgba8(device, decoded.width, decoded.height, decoded.pixels, { label, srgb, mipmaps: false });
}

/**
 * Fetch and build a `LoadedGlb`. Rejects on any structural error; image decode failures fall back
 * to the material's factor colour instead of failing the whole model.
 */
export async function loadGlb(device: GraphicsDevice, url: string): Promise<LoadedGlb> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`loadGlb: GET ${url} → ${response.status}`);
  const { json, bin } = parseGlb(await response.arrayBuffer());

  const parts: GlbPart[] = [];
  const wheels = new Map<string, GlbWheel>();
  const geometries: Geometry[] = [];
  const materials: Material[] = [];
  const textures: Texture[] = [];

  // Embedded images: every decode starts up front so the `createImageBitmap` webp work overlaps,
  // then each one takes its CPU readback on ONE reused 2d canvas. (Fresh OffscreenCanvas contexts
  // cost ~200 ms apiece in the software rasteriser this gate runs on — 38 of them was 23 s.)
  let readbackCanvas: OffscreenCanvas | null = null;
  let readbackCtx: OffscreenCanvasRenderingContext2D | null = null;
  const imagePixels = new Map<number, Promise<{ width: number; height: number; pixels: Uint8Array } | null>>();
  const decodeImage = (sourceIndex: number): Promise<{ width: number; height: number; pixels: Uint8Array } | null> => {
    const cached = imagePixels.get(sourceIndex);
    if (cached) return cached;
    const image = json.images?.[sourceIndex];
    if (!image || image.bufferView === undefined) return Promise.resolve(null);
    const bv = json.bufferViews[image.bufferView]!;
    const bytes = bin.subarray(bv.byteOffset ?? 0, (bv.byteOffset ?? 0) + bv.byteLength);
    const promise = (async () => {
      try {
        // Blob copies the bytes out of the shared GLB ArrayBuffer before the async decode.
        const bitmap = await createImageBitmap(new Blob([bytes.slice()], { type: image.mimeType ?? "image/png" }));
        const { width, height } = bitmap;
        if (!readbackCanvas) {
          readbackCanvas =
            typeof OffscreenCanvas !== "undefined"
              ? new OffscreenCanvas(width, height)
              : (document.createElement("canvas") as unknown as OffscreenCanvas);
          readbackCtx = readbackCanvas.getContext("2d", { willReadFrequently: true }) as OffscreenCanvasRenderingContext2D | null;
        } else if (readbackCanvas.width < width || readbackCanvas.height < height) {
          readbackCanvas.width = Math.max(readbackCanvas.width, width);
          readbackCanvas.height = Math.max(readbackCanvas.height, height);
          readbackCtx = readbackCanvas.getContext("2d", { willReadFrequently: true }) as OffscreenCanvasRenderingContext2D | null;
        }
        if (!readbackCtx || !readbackCanvas) throw new Error("OffscreenCanvas 2d context unavailable");
        readbackCtx.clearRect(0, 0, readbackCanvas.width, readbackCanvas.height);
        readbackCtx.drawImage(bitmap, 0, 0);
        const imageData = readbackCtx.getImageData(0, 0, width, height);
        bitmap.close();
        return { width, height, pixels: new Uint8Array(imageData.data) };
      } catch (error) {
        console.warn(`loadGlb: image "${image.name ?? sourceIndex}" failed, using factors`, error);
        return null;
      }
    })();
    imagePixels.set(sourceIndex, promise);
    return promise;
  };
  for (let i = 0; i < (json.images?.length ?? 0); i++) decodeImage(i);

  // GPU textures per (image, colourspace); shared by every material that references them.
  const textureCache = new Map<string, Promise<Texture | null>>();
  const textureFor = (textureIndex: number, srgb: boolean, label: string): Promise<Texture | null> => {
    const texture = json.textures?.[textureIndex];
    if (!texture) return Promise.resolve(null);
    const key = `${texture.source}:${srgb}`;
    const cached = textureCache.get(key);
    if (cached) return cached;
    const promise = imageBytesToTexture(device, decodeImage(texture.source), label, srgb)
      .then((t) => {
        if (t) textures.push(t);
        return t;
      })
      .catch((error: unknown) => {
        console.warn(`loadGlb: texture ${key} upload failed, using factors`, error);
        return null;
      });
    textureCache.set(key, promise);
    return promise;
  };

  // Materials → engine `Material`. Factors are linear in glTF, matching `Color`'s components.
  const materialCache = new Map<number, Promise<Material>>();
  const materialFor = (index: number): Promise<Material> => {
    const cached = materialCache.get(index);
    if (cached) return cached;
    const src = json.materials?.[index];
    if (!src) {
      const fallback = new Material({ label: `glb.material_${index}`, roughness: 0.7, metallic: 0.1 });
      materials.push(fallback);
      return Promise.resolve(fallback);
    }
    const pbr = src.pbrMetallicRoughness ?? {};
    const material = new Material({
      label: `glb.${src.name ?? index}`,
      roughness: pbr.roughnessFactor ?? 1,
      metallic: pbr.metallicFactor ?? 1,
      doubleSided: src.doubleSided ?? false,
      transparent: src.alphaMode === "BLEND",
    });
    const base = pbr.baseColorFactor ?? [1, 1, 1, 1];
    material.setColor(new Color(base[0] ?? 1, base[1] ?? 1, base[2] ?? 1, base[3] ?? 1));
    materials.push(material);
    const promise = (async () => {
      if (pbr.baseColorTexture) {
        material.albedoMap = await textureFor(pbr.baseColorTexture.index, true, `${material.label}.albedo`);
      }
      if (src.normalTexture) {
        material.normalMap = await textureFor(src.normalTexture.index, false, `${material.label}.normal`);
      }
      if (pbr.metallicRoughnessTexture) {
        material.metallicRoughnessMap = await textureFor(pbr.metallicRoughnessTexture.index, false, `${material.label}.mr`);
      }
      return material;
    })();
    materialCache.set(index, promise);
    return promise;
  };

  const buildPrimitive = async (prim: GltfPrimitive, name: string): Promise<GlbPart> => {
    const positionsRaw = readAccessor(json, bin, prim.attributes.POSITION!);
    if (!(positionsRaw instanceof Float32Array)) throw new Error(`${name}: POSITION is not float`);
    const normalsRaw = readAccessor(json, bin, prim.attributes.NORMAL!);
    const uvsRaw = prim.attributes.TEXCOORD_0 !== undefined ? readAccessor(json, bin, prim.attributes.TEXCOORD_0) : null;
    const indicesRaw = prim.indices !== undefined ? readAccessor(json, bin, prim.indices) : null;

    const positions = positionsRaw;
    const normals = normalsRaw instanceof Float32Array ? normalsRaw : new Float32Array(positions.length);
    const uvs = uvsRaw instanceof Float32Array ? uvsRaw : new Float32Array((positions.length / 3) * 2);
    const indices =
      indicesRaw instanceof Uint32Array
        ? indicesRaw
        : Uint32Array.from({ length: positions.length / 3 }, (_, i) => i);

    const material = await materialFor(prim.material ?? 0);
    const source: GeometrySource = {
      positions,
      normals,
      uvs,
      indices,
      label: name,
    };
    // Normal-mapped materials need tangents for the shader's TBN; the source GLB has none, so
    // derive them from the UV layout (albedo-only materials skip the extra buffer).
    if (material.normalMap) {
      const { tangents } = computeNormalsAndTangents(positions, indices, uvs);
      source.tangents = tangents;
    }
    const geometry = Geometry.create(device, source);
    geometries.push(geometry);
    return { name, geometry, material };
  };

  const nodes = json.nodes ?? [];
  const sceneRoots = json.scenes?.[json.scene ?? 0]?.nodes ?? nodes.map((_, i) => i);
  /** Walk the scene graph: wheel roots are transform-only nodes with mesh children beneath them. */
  const visit = async (index: number, wheel: GlbWheel | null): Promise<void> => {
    const node = nodes[index];
    if (!node) return;
    const isWheelRoot = node.name !== undefined && /^wheel_[FMR][LR]$/.test(node.name);
    let effectiveWheel = wheel;
    if (isWheelRoot && node.name) {
      const created: GlbWheel = {
        name: node.name,
        hub: [node.translation?.[0] ?? 0, node.translation?.[1] ?? 0, node.translation?.[2] ?? 0],
        parts: [],
      };
      wheels.set(node.name, created);
      effectiveWheel = created;
    }
    if (node.mesh !== undefined) {
      const mesh = json.meshes[node.mesh]!;
      for (const prim of mesh.primitives) {
        if (prim.mode !== undefined && prim.mode !== 4) continue;
        const name = effectiveWheel
          ? `${effectiveWheel.name}.${mesh.name ?? "part"}`
          : (mesh.name ?? `mesh_${node.mesh}`);
        const part = await buildPrimitive(prim, name);
        if (effectiveWheel) effectiveWheel.parts.push(part);
        else parts.push(part);
      }
    }
    for (const child of node.children ?? []) await visit(child, effectiveWheel);
  };
  for (const rootIndex of sceneRoots) await visit(rootIndex, null);

  const body = parts;
  return {
    body,
    wheels: [...wheels.values()].sort((a, b) => a.name.localeCompare(b.name)),
    dispose(): void {
      for (const g of geometries) g.dispose();
      for (const m of materials) m.dispose();
      for (const t of textures) t.dispose();
      geometries.length = 0;
      materials.length = 0;
      textures.length = 0;
      parts.length = 0;
      wheels.clear();
    },
  };
}
