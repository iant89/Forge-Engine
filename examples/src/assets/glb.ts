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
 * - the `arm` root and its nested `arm_shoulder` > `arm_elbow` > `arm_wrist` > `arm_turret`
 *   joints translate to their pivot relative to the parent joint (the root in model space), carry
 *   `extras.axis`, and hold pivot-relative parts — the loader returns them as {@link GlbArm},
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
  nodes?: {
    name?: string;
    mesh?: number;
    translation?: number[];
    children?: number[];
    extras?: { joint?: unknown; axis?: unknown };
  }[];
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

/**
 * The Remote Sensing Mast assembly: hinge-relative parts (stowed-flat pose as modelled) plus the
 * hinge position the converter recorded on the `mast` root. The scene parents the parts under a
 * pivot entity at the hinge and rotates it to raise/lower the mast.
 *
 * Parts are split into three articulation groups matching the real Perseverance joints:
 * - **lowerParts**: base bracket + lower arm (rotate with the deployment hinge)
 * - **upperParts**: upper arm + joint cylinder (rotate around the azimuth joint)
 * - **headParts**: camera head + NavCams + Mastcam-Z + SuperCam + microphones (tilt at the elevation joint)
 *
 * `joint` is the azimuth pivot position (hinge-relative); `headPivot` is the elevation pivot
 * position (also hinge-relative). Both are computed from vertex centroids during loading so they
 * work with both the current flat-part GLB and any future hierarchical output.
 */
export interface GlbMast {
  pivot: [number, number, number];
  /** All parts (backward compat — equals `[...lowerParts, ...upperParts, ...headParts]`). */
  parts: GlbPart[];
  /** Azimuth joint position in hinge-relative coords (upper mast rotation pivot). */
  joint: [number, number, number];
  /** Elevation joint position in hinge-relative coords (head tilt pivot). */
  headPivot: [number, number, number];
  /** Lower mast arm + base bracket parts. */
  lowerParts: GlbPart[];
  /** Upper mast arm + joint cylinder parts. */
  upperParts: GlbPart[];
  /** Camera head + instruments parts. */
  headParts: GlbPart[];
}

/** One joint of the robotic arm chain: a pivot, its rotation axis, and the link it carries. */
export interface GlbArmJoint {
  /** Node name: `arm`, `arm_shoulder`, `arm_elbow`, `arm_wrist` or `arm_turret`. */
  name: string;
  /** Joint role from `extras.joint`: azimuth, shoulder, elbow, wrist or turret. */
  joint: string;
  /** Pivot relative to the parent joint's pivot (the first joint's is in model space). */
  offset: [number, number, number];
  /** Unit rotation axis in the joint's own frame — the model frame while everything is stowed. */
  axis: [number, number, number];
  /** The link's parts, vertices relative to this pivot. */
  parts: GlbPart[];
}

/**
 * The robotic arm as the converter ships it — folded, the NASA model's pose — as a chain of
 * nested joints, root (azimuth, on the mount ring) to tip (the instrument turret). Parent one pivot
 * entity per joint under the previous one at `offset` and rotate each about its `axis`.
 */
export interface GlbArm {
  joints: GlbArmJoint[];
}

/** Arm joint node names in chain order; a GLB with an `arm` root must match exactly. */
export const GLB_ARM_JOINT_NODES = ["arm", "arm_shoulder", "arm_elbow", "arm_wrist", "arm_turret"] as const;

export interface LoadedGlb {
  /** Body meshes in model-root space (converter baked all node transforms). */
  body: GlbPart[];
  /** The six wheels, hub-centred, keyed by `wheel_FL` … `wheel_RR`. */
  wheels: GlbWheel[];
  /** The RSM assembly, or null when the GLB predates the mast split. */
  mast: GlbMast | null;
  /** The robotic arm chain, or null when the GLB predates the arm split. */
  arm: GlbArm | null;
  dispose(): void;
}

/** Loading-screen progress: which phase the loader is in and how far the fetch got. */
export interface GlbLoadProgress {
  phase: "fetch" | "parse" | "build" | "done";
  receivedBytes: number;
  /** From the response's Content-Length when the server sends one; null otherwise. */
  totalBytes: number | null;
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
export async function loadGlb(
  device: GraphicsDevice,
  url: string,
  onProgress?: (progress: GlbLoadProgress) => void,
): Promise<LoadedGlb> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`loadGlb: GET ${url} → ${response.status}`);
  const contentLength = Number(response.headers.get("content-length"));
  const totalBytes = Number.isFinite(contentLength) && contentLength > 0 ? contentLength : null;
  let received = 0;
  const report = (phase: GlbLoadProgress["phase"]): void => onProgress?.({ phase, receivedBytes: received, totalBytes });
  // Stream the body (the GLB is several MB) so a loading screen can show real fetch progress;
  // fall back to the one-shot read where the response has no readable body.
  let buffer: ArrayBuffer;
  if (response.body) {
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      chunks.push(value);
      received += value.length;
      report("fetch");
    }
    buffer = new Uint8Array(received).buffer;
    let at = 0;
    for (const chunk of chunks) {
      new Uint8Array(buffer, at, chunk.length).set(chunk);
      at += chunk.length;
    }
  } else {
    buffer = await response.arrayBuffer();
    received = buffer.byteLength;
    report("fetch");
  }
  report("parse");
  const { json, bin } = parseGlb(buffer);
  report("build");

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
      // `setMaps` clears the bind group and bumps revision — assigning the fields directly would
      // leave a stale group bound if `ensureGpu` had already run (Safari WebGPU is especially
      // unforgiving about sampling a 1×1 white default after the real albedo was swapped in).
      const albedo = pbr.baseColorTexture
        ? await textureFor(pbr.baseColorTexture.index, true, `${material.label}.albedo`)
        : undefined;
      const normal = src.normalTexture
        ? await textureFor(src.normalTexture.index, false, `${material.label}.normal`)
        : undefined;
      const metallicRoughness = pbr.metallicRoughnessTexture
        ? await textureFor(pbr.metallicRoughnessTexture.index, false, `${material.label}.mr`)
        : undefined;
      if (albedo !== undefined || normal !== undefined || metallicRoughness !== undefined) {
        material.setMaps({ albedo, normal, metallicRoughness });
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
    // Loud failure for corrupt index data: the converter once emitted per-wheel slices with
    // global (non-rebased) indices, and every wheel but wheel_FL rendered nothing with no error.
    if (indices.length > 0) {
      let maxIndex = 0;
      for (let i = 0; i < indices.length; i++) if (indices[i]! > maxIndex) maxIndex = indices[i]!;
      const vertCount = positions.length / 3;
      if (maxIndex >= vertCount) {
        console.warn(`loadGlb: ${name} has out-of-range indices (max ${maxIndex} for ${vertCount} verts); it will not render correctly`);
      }
    }

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
  // Assigned inside `visit` (a closure). The `as` keeps TypeScript from narrowing these to their
  // `null` initialiser in this scope — it does not see closure assignments — which made every
  // post-walk `if (mast)` block type as `never` and failed the typecheck.
  let mast = null as GlbMast | null;
  let arm = null as GlbArm | null;
  /** Build an arm joint from its node, validating the converter's `extras.axis`. */
  const armJointFrom = (node: NonNullable<GltfJson["nodes"]>[number], name: string): GlbArmJoint => {
    const axis = node.extras?.axis;
    if (!Array.isArray(axis) || axis.length !== 3 || !axis.every((v) => typeof v === "number" && Number.isFinite(v))) {
      throw new Error(`loadGlb: arm joint ${name} has no valid extras.axis`);
    }
    const [ax, ay, az] = axis as [number, number, number];
    const len = Math.hypot(ax, ay, az);
    if (!(len > 1e-6)) throw new Error(`loadGlb: arm joint ${name} has a zero-length axis`);
    return {
      name,
      joint: typeof node.extras?.joint === "string" ? node.extras.joint : name,
      offset: [node.translation?.[0] ?? 0, node.translation?.[1] ?? 0, node.translation?.[2] ?? 0],
      axis: [ax / len, ay / len, az / len],
      parts: [],
    };
  };
  /** Mast sub-group parts and centroid accumulators for joint position computation. */
  const mastLowerParts: GlbPart[] = [];
  const mastUpperParts: GlbPart[] = [];
  const mastHeadParts: GlbPart[] = [];
  // Centroid accumulators: sum of positions and vertex count per group.
  const mastAcc = {
    lower: { sx: 0, sy: 0, sz: 0, n: 0 },
    upper: { sx: 0, sy: 0, sz: 0, n: 0 },
    head:  { sx: 0, sy: 0, sz: 0, n: 0 },
  };
  // Track the boundary vertices between groups for precise joint computation.
  // lowerFarthest: vertex in the lower group farthest from the hinge (along the stowed mast).
  // upperNearest: vertex in the upper group nearest to the hinge.
  let mastLowerFarthestZ = Infinity; // most negative Z (farthest from hinge in stowed position)
  let mastLowerFarthest: [number, number, number] = [0, 0, 0];
  let mastUpperNearestZ = -Infinity; // least negative Z (nearest to hinge)
  let mastUpperNearest: [number, number, number] = [0, 0, 0];
  let mastHeadNearestZ = -Infinity; // boundary between upper and head
  let mastHeadNearest: [number, number, number] = [0, 0, 0];
  let mastUpperFarthestZ = Infinity;
  let mastUpperFarthest: [number, number, number] = [0, 0, 0];

  /** Classify a mast mesh into lower/upper/head by its name prefix. */
  function classifyMastMesh(meshName: string): "lower" | "upper" | "head" {
    if (/^mast_bottom/.test(meshName)) return "lower";
    if (meshName === "mast_Cylinder_transparent") return "lower";
    if (/^mast_top/.test(meshName)) return "upper";
    if (/^mast_Cylinder\.002/.test(meshName)) return "upper";
    return "head";
  }

  /**
   * Walk the scene graph: wheel/mast/arm roots are transform-only nodes with mesh children beneath.
   * `armJoint` is the innermost arm joint above `index` (its link owns any meshes found here).
   */
  const visit = async (index: number, wheel: GlbWheel | null, inMast: boolean, armJoint: GlbArmJoint | null): Promise<void> => {
    const node = nodes[index];
    if (!node) return;
    let effectiveArm = armJoint;
    if (node.name === "arm" && !armJoint) {
      if (arm) throw new Error("loadGlb: more than one arm root");
      effectiveArm = armJointFrom(node, node.name);
      arm = { joints: [effectiveArm] };
    } else if (armJoint && arm && node.name !== undefined && (GLB_ARM_JOINT_NODES as readonly string[]).includes(node.name)) {
      const chain: GlbArmJoint[] = arm.joints;
      // Each joint must hang directly off the previous one, or it would not ride along with it.
      if (chain[chain.length - 1] !== armJoint) throw new Error(`loadGlb: arm joint ${node.name} is not nested under ${chain[chain.length - 1]?.name}`);
      effectiveArm = armJointFrom(node, node.name);
      chain.push(effectiveArm);
    }
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
    let effectiveMast = inMast;
    if (node.name === "mast") {
      mast = {
        pivot: [node.translation?.[0] ?? 0, node.translation?.[1] ?? 0, node.translation?.[2] ?? 0],
        parts: [],
        joint: [0, 0, 0],
        headPivot: [0, 0, 0],
        lowerParts: [],
        upperParts: [],
        headParts: [],
      };
      effectiveMast = true;
    }
    // Sub-group nodes record their joint (hinge-relative) in `extras.joint` — older converter
    // output used `translation`. Seed from it; the vertex-boundary pass below still refines both
    // joints whenever the neighbouring groups have geometry (always, for the shipped asset).
    if (effectiveMast && mast && (node.name === "mast_upper" || node.name === "mast_head")) {
      const extra = node.extras?.joint;
      const src = Array.isArray(extra) && extra.length === 3 ? (extra as number[]) : node.translation;
      if (src) {
        const joint: [number, number, number] = [src[0] ?? 0, src[1] ?? 0, src[2] ?? 0];
        if (node.name === "mast_upper") mast.joint = joint;
        else mast.headPivot = joint;
      }
    }
    if (node.mesh !== undefined) {
      const mesh = json.meshes[node.mesh]!;
      for (const prim of mesh.primitives) {
        if (prim.mode !== undefined && prim.mode !== 4) continue;
        const name = effectiveWheel
          ? `${effectiveWheel.name}.${mesh.name ?? "part"}`
          : effectiveMast
            ? `mast.${mesh.name ?? "part"}`
            : effectiveArm
              ? `arm.${mesh.name ?? "part"}`
              : (mesh.name ?? `mesh_${node.mesh}`);
        const part = await buildPrimitive(prim, name);
        if (effectiveWheel) effectiveWheel.parts.push(part);
        else if (effectiveArm) effectiveArm.parts.push(part);
        else if (effectiveMast && mast) {
          mast.parts.push(part);
          // Classify and accumulate centroid data for joint position computation.
          const group = classifyMastMesh(mesh.name ?? name);
          const acc = mastAcc[group];
          if (group === "lower") mastLowerParts.push(part);
          else if (group === "upper") mastUpperParts.push(part);
          else mastHeadParts.push(part);
          // Read position accessor for centroid and boundary tracking.
          const posIdx = prim.attributes.POSITION;
          if (posIdx !== undefined) {
            const positions = readAccessor(json, bin, posIdx);
            const count = positions.length / 3;
            for (let v = 0; v < count; v++) {
              const px = positions[v * 3]!;
              const py = positions[v * 3 + 1]!;
              const pz = positions[v * 3 + 2]!;
              acc.sx += px; acc.sy += py; acc.sz += pz; acc.n++;
              // Track boundary vertices between groups along the mast axis (Z in stowed frame).
              if (group === "lower" && pz < mastLowerFarthestZ) {
                mastLowerFarthestZ = pz;
                mastLowerFarthest = [px, py, pz];
              }
              if (group === "upper") {
                if (pz > mastUpperNearestZ) { mastUpperNearestZ = pz; mastUpperNearest = [px, py, pz]; }
                if (pz < mastUpperFarthestZ) { mastUpperFarthestZ = pz; mastUpperFarthest = [px, py, pz]; }
              }
              if (group === "head" && pz > mastHeadNearestZ) {
                mastHeadNearestZ = pz;
                mastHeadNearest = [px, py, pz];
              }
            }
          }
        }
        else parts.push(part);
      }
    }
    for (const child of node.children ?? []) await visit(child, effectiveWheel, effectiveMast, effectiveArm);
  };
  for (const rootIndex of sceneRoots) await visit(rootIndex, null, false, null);
  // A partial chain would articulate wrongly (or leave links floating): fail loudly instead.
  const armChain = arm?.joints.map((j) => j.name);
  if (armChain && armChain.join(">") !== GLB_ARM_JOINT_NODES.join(">")) {
    throw new Error(`loadGlb: arm chain is ${armChain.join(" > ")}, expected ${GLB_ARM_JOINT_NODES.join(" > ")}`);
  }

  // Compute joint positions from vertex boundary data.
  // Azimuth joint: boundary between lower and upper mast groups.
  // Elevation joint: boundary between upper mast and head groups.
  if (mast) {
    if (mastAcc.lower.n > 0 && mastAcc.upper.n > 0) {
      mast.joint = [
        (mastLowerFarthest[0] + mastUpperNearest[0]) * 0.5,
        (mastLowerFarthest[1] + mastUpperNearest[1]) * 0.5,
        (mastLowerFarthest[2] + mastUpperNearest[2]) * 0.5,
      ];
    }
    if (mastAcc.upper.n > 0 && mastAcc.head.n > 0) {
      mast.headPivot = [
        (mastUpperFarthest[0] + mastHeadNearest[0]) * 0.5,
        (mastUpperFarthest[1] + mastHeadNearest[1]) * 0.5,
        (mastUpperFarthest[2] + mastHeadNearest[2]) * 0.5,
      ];
    }
    mast.lowerParts = mastLowerParts;
    mast.upperParts = mastUpperParts;
    mast.headParts = mastHeadParts;
  }

  const body = parts;
  report("done");
  return {
    body,
    wheels: [...wheels.values()].sort((a, b) => a.name.localeCompare(b.name)),
    mast,
    arm,
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
