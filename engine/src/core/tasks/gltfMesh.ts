/**
 * Pure glTF 2.0 mesh decoding for the `asset.gltf.decode` worker task.
 *
 * This module has no DOM, renderer, fetch or GPU dependencies. It accepts a GLB buffer, or the JSON
 * document plus its resolved buffer data, and returns structured-cloneable typed arrays ready for
 * main-thread upload. Keeping the decoder in the task layer lets the same implementation run inline,
 * on `node:worker_threads`, and in a browser module worker.
 *
 * Scope: triangle primitives, core vertex attributes/accessors (including interleaving, normalization
 * and sparse overlays), node transforms, scene roots and material factors/references. Compressed
 * geometry extensions (Draco/meshopt), morph targets, skins and GPU instancing are rejected
 * explicitly; image decoding/material upload and animation import are outside this mesh-decoder slice.
 */

import { AssetError } from "../errors.js";
import type { TaskContext } from "./registry.js";

export const GLTF_MESH_DECODE_TASK = "asset.gltf.decode" as const;
const GLB_MAGIC = 0x46546c67;
const GLB_JSON_CHUNK = 0x4e4f534a;
const GLB_BIN_CHUNK = 0x004e4942;
const COMPONENT_BYTES: Record<number, number> = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
const COMPONENTS: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };

export interface GltfMeshDecodePayload {
  /** `glb` carries the complete GLB file; `gltf` carries the JSON text and external buffers by index. */
  format: "glb" | "gltf";
  glb?: ArrayBuffer;
  json?: string;
  /** Entries correspond to glTF `buffers[]`; data URIs are decoded by the worker and may be null here. */
  buffers?: (ArrayBuffer | null)[];
  source?: string;
}

export interface DecodedGltfPrimitive {
  /** glTF primitive mode; this decoder currently emits triangle lists only (4). */
  mode: 4;
  /** Vertex semantics (e.g. POSITION, NORMAL, TEXCOORD_0) as unpacked float arrays. */
  attributes: Record<string, Float32Array>;
  indices: Uint16Array | Uint32Array | null;
  materialIndex: number | null;
  vertexCount: number;
  /** [minX, minY, minZ, maxX, maxY, maxZ]. */
  bounds: Float32Array;
}

export interface DecodedGltfMesh {
  name: string;
  primitives: DecodedGltfPrimitive[];
}

export interface DecodedGltfNode {
  name: string;
  meshIndex: number | null;
  children: number[];
  translation: Float32Array | null;
  rotation: Float32Array | null;
  scale: Float32Array | null;
  matrix: Float32Array | null;
}

export interface DecodedGltfMaterial {
  name: string;
  alphaMode: "OPAQUE" | "MASK" | "BLEND";
  alphaCutoff: number;
  doubleSided: boolean;
  baseColorFactor: Float32Array;
  metallicFactor: number;
  roughnessFactor: number;
  baseColorTexture: number | null;
  metallicRoughnessTexture: number | null;
  normalTexture: number | null;
}

export interface DecodedGltfScene {
  name: string;
  nodes: number[];
}

/** Plain, transferable output; no GPU objects or class instances cross the worker boundary. */
export interface DecodedGltfAsset {
  version: "2.0";
  source: string;
  meshes: DecodedGltfMesh[];
  nodes: DecodedGltfNode[];
  scenes: DecodedGltfScene[];
  sceneIndex: number;
  materials: DecodedGltfMaterial[];
  primitiveCount: number;
  vertexCount: number;
  /** Bytes in all decoded vertex/index arrays. */
  decodedBytes: number;
}

interface GltfDocument {
  asset?: { version?: string; minVersion?: string };
  extensionsRequired?: string[];
  buffers?: { byteLength: number; uri?: string }[];
  bufferViews?: { buffer: number; byteOffset?: number; byteLength: number; byteStride?: number; extensions?: Record<string, unknown> }[];
  accessors?: {
    bufferView?: number;
    byteOffset?: number;
    componentType: number;
    count: number;
    type: string;
    normalized?: boolean;
    min?: number[];
    max?: number[];
    sparse?: {
      count: number;
      indices: { bufferView: number; byteOffset?: number; componentType: number };
      values: { bufferView: number; byteOffset?: number };
    };
  }[];
  meshes?: {
    name?: string;
    weights?: number[];
    primitives?: {
      attributes?: Record<string, number>;
      indices?: number;
      material?: number;
      mode?: number;
      targets?: Record<string, number>[];
      extensions?: Record<string, unknown>;
    }[];
  }[];
  nodes?: {
    name?: string;
    mesh?: number;
    skin?: number;
    weights?: number[];
    children?: number[];
    extensions?: Record<string, unknown>;
    translation?: number[];
    rotation?: number[];
    scale?: number[];
    matrix?: number[];
  }[];
  scenes?: { name?: string; nodes?: number[] }[];
  scene?: number;
  materials?: {
    name?: string;
    alphaMode?: string;
    alphaCutoff?: number;
    doubleSided?: boolean;
    pbrMetallicRoughness?: {
      baseColorFactor?: number[];
      metallicFactor?: number;
      roughnessFactor?: number;
      baseColorTexture?: { index: number };
      metallicRoughnessTexture?: { index: number };
    };
    normalTexture?: { index: number };
  }[];
}

interface ParsedContainer {
  json: string;
  binary: ArrayBuffer | null;
}

function fail(source: string, message: string, code = "E_ASSET_GLTF"): never {
  throw new AssetError(message, source, code);
}

function checkCancelled(ctx: TaskContext | undefined, source: string): void {
  if (ctx?.cancelled) fail(source, "glTF mesh decode cancelled", "E_ASSET_CANCELLED");
}

function parseGlb(buffer: ArrayBuffer, source: string): ParsedContainer {
  if (buffer.byteLength < 20) fail(source, "GLB is shorter than its header and JSON chunk", "E_ASSET_GLB");
  const view = new DataView(buffer);
  if (view.getUint32(0, true) !== GLB_MAGIC) fail(source, "not a GLB file (invalid magic)", "E_ASSET_GLB");
  const version = view.getUint32(4, true);
  if (version !== 2) fail(source, `unsupported GLB version ${version}; expected 2`, "E_ASSET_GLB");
  const declaredLength = view.getUint32(8, true);
  if (declaredLength !== buffer.byteLength) {
    fail(source, `GLB length field is ${declaredLength}, actual length is ${buffer.byteLength}`, "E_ASSET_GLB");
  }

  let offset = 12;
  let json: string | null = null;
  let binary: ArrayBuffer | null = null;
  while (offset < declaredLength) {
    if (offset + 8 > declaredLength) fail(source, "GLB has a truncated chunk header", "E_ASSET_GLB");
    const chunkLength = view.getUint32(offset, true);
    const chunkType = view.getUint32(offset + 4, true);
    const dataStart = offset + 8;
    const dataEnd = dataStart + chunkLength;
    if (chunkLength % 4 !== 0 || dataEnd > declaredLength) fail(source, "GLB chunk has an invalid length", "E_ASSET_GLB");
    if (chunkType === GLB_JSON_CHUNK) {
      if (json !== null || offset !== 12) fail(source, "GLB must start with exactly one JSON chunk", "E_ASSET_GLB");
      json = new TextDecoder().decode(new Uint8Array(buffer, dataStart, chunkLength)).replace(/[\u0000\u0020]+$/g, "");
    } else if (chunkType === GLB_BIN_CHUNK) {
      if (binary !== null) fail(source, "GLB contains more than one BIN chunk", "E_ASSET_GLB");
      binary = buffer.slice(dataStart, dataEnd);
    }
    offset = dataEnd;
  }
  if (json === null) fail(source, "GLB is missing its JSON chunk", "E_ASSET_GLB");
  return { json, binary };
}

function parseJson(json: string, source: string): GltfDocument {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    fail(source, `invalid glTF JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) fail(source, "glTF root must be a JSON object");
  const doc = parsed as GltfDocument;
  const version = doc.asset?.version;
  if (version !== "2.0") fail(source, `unsupported glTF asset version ${String(version ?? "<missing>")}; expected 2.0`);
  if (doc.asset?.minVersion && compareVersion(doc.asset.minVersion, "2.0") > 0) {
    fail(source, `glTF minVersion ${doc.asset.minVersion} is newer than 2.0`);
  }
  for (const extension of doc.extensionsRequired ?? []) {
    if (extension === "KHR_draco_mesh_compression" || extension === "EXT_meshopt_compression") {
      fail(source, `required geometry compression extension ${extension} is not supported`, "E_ASSET_GLTF_EXTENSION");
    }
  }
  if (!Array.isArray(doc.meshes)) fail(source, "glTF has no meshes array");
  return doc;
}

function compareVersion(a: string, b: string): number {
  const av = a.split(".").map((v) => Number(v));
  const bv = b.split(".").map((v) => Number(v));
  for (let i = 0; i < Math.max(av.length, bv.length); i++) {
    const d = (av[i] ?? 0) - (bv[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

function dataUriBytes(uri: string, source: string): ArrayBuffer {
  const comma = uri.indexOf(",");
  if (!uri.startsWith("data:") || comma < 5) fail(source, "invalid glTF buffer data URI");
  const metadata = uri.slice(5, comma);
  const data = uri.slice(comma + 1);
  if (/;base64(?:;|$)/i.test(metadata)) {
    try {
      const decoded = atob(data);
      const bytes = new Uint8Array(decoded.length);
      for (let i = 0; i < decoded.length; i++) bytes[i] = decoded.charCodeAt(i);
      return bytes.buffer;
    } catch (error) {
      fail(source, `invalid base64 glTF buffer URI: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const bytes: number[] = [];
  const encoder = new TextEncoder();
  for (let i = 0; i < data.length; ) {
    if (data[i] === "%") {
      if (i + 2 >= data.length || !/^[\da-f]{2}$/i.test(data.slice(i + 1, i + 3))) fail(source, "invalid percent-encoded glTF buffer URI");
      bytes.push(Number.parseInt(data.slice(i + 1, i + 3), 16));
      i += 3;
    } else {
      const codePoint = data.codePointAt(i)!;
      for (const byte of encoder.encode(String.fromCodePoint(codePoint))) bytes.push(byte);
      i += codePoint > 0xffff ? 2 : 1;
    }
  }
  return Uint8Array.from(bytes).buffer;
}

function resolveBuffers(doc: GltfDocument, supplied: (ArrayBuffer | null)[] | undefined, binary: ArrayBuffer | null, source: string): ArrayBuffer[] {
  const definitions = doc.buffers ?? [];
  const result = new Array<ArrayBuffer>(definitions.length);
  for (let i = 0; i < definitions.length; i++) {
    const definition = definitions[i]!;
    let data: ArrayBuffer | null = null;
    if (definition.uri?.startsWith("data:")) data = dataUriBytes(definition.uri, source);
    else if (definition.uri === undefined && i === 0 && binary) data = binary;
    else data = supplied?.[i] ?? null;
    if (!data) fail(source, `glTF buffer ${i} is external; provide its resolved bytes or use loadGltfMesh(url)`);
    if (!Number.isSafeInteger(definition.byteLength) || definition.byteLength < 0 || data.byteLength < definition.byteLength) {
      fail(source, `glTF buffer ${i} has ${data.byteLength} bytes; declared byteLength is ${definition.byteLength}`);
    }
    result[i] = data;
  }
  return result;
}

function indexAt(value: number, length: number, label: string, source: string): number {
  if (!Number.isInteger(value) || value < 0 || value >= length) fail(source, `${label} index ${value} is out of range`);
  return value;
}

function finiteArray(value: readonly number[] | undefined, length: number, label: string, source: string): Float32Array | null {
  if (value === undefined) return null;
  if (value.length !== length || value.some((v) => !Number.isFinite(v))) fail(source, `${label} must contain ${length} finite numbers`);
  return Float32Array.from(value);
}

function componentValue(view: DataView, offset: number, componentType: number): number {
  switch (componentType) {
    case 5120: return view.getInt8(offset);
    case 5121: return view.getUint8(offset);
    case 5122: return view.getInt16(offset, true);
    case 5123: return view.getUint16(offset, true);
    case 5125: return view.getUint32(offset, true);
    case 5126: return view.getFloat32(offset, true);
    default: return NaN;
  }
}

function normalizedValue(value: number, componentType: number): number {
  switch (componentType) {
    case 5120: return Math.max(value / 127, -1);
    case 5121: return value / 255;
    case 5122: return Math.max(value / 32767, -1);
    case 5123: return value / 65535;
    case 5125: return value / 4294967295;
    default: return value;
  }
}

interface AccessorData {
  values: Float32Array;
  count: number;
  components: number;
  componentType: number;
}

function readAccessor(doc: GltfDocument, buffers: ArrayBuffer[], accessorIndex: number, source: string, ctx?: TaskContext): AccessorData {
  const accessors = doc.accessors ?? [];
  const accessor = accessors[indexAt(accessorIndex, accessors.length, "accessor", source)]!;
  const componentBytes = COMPONENT_BYTES[accessor.componentType];
  const components = COMPONENTS[accessor.type];
  if (!componentBytes || !components) fail(source, `accessor ${accessorIndex} has unsupported type/component ${accessor.type}/${accessor.componentType}`);
  if (!Number.isSafeInteger(accessor.count) || accessor.count < 0) fail(source, `accessor ${accessorIndex} has invalid count ${accessor.count}`);
  if (accessor.normalized && accessor.componentType === 5126) fail(source, `accessor ${accessorIndex} cannot normalize float components`);
  const output = new Float32Array(accessor.count * components);
  const elementBytes = componentBytes * components;

  if (accessor.bufferView !== undefined) {
    const viewIndex = indexAt(accessor.bufferView, (doc.bufferViews ?? []).length, `accessor ${accessorIndex} bufferView`, source);
    const bufferView = doc.bufferViews![viewIndex]!;
    if (bufferView.extensions?.EXT_meshopt_compression) {
      fail(source, `bufferView ${viewIndex} uses unsupported EXT_meshopt_compression`, "E_ASSET_GLTF_EXTENSION");
    }
    const buffer = buffers[indexAt(bufferView.buffer, buffers.length, `bufferView ${viewIndex} buffer`, source)]!;
    const baseOffset = bufferView.byteOffset ?? 0;
    const accessorOffset = accessor.byteOffset ?? 0;
    const stride = bufferView.byteStride ?? elementBytes;
    if (!Number.isSafeInteger(baseOffset) || !Number.isSafeInteger(accessorOffset) || baseOffset < 0 || accessorOffset < 0 ||
        !Number.isSafeInteger(bufferView.byteLength) || bufferView.byteLength < 0) {
      fail(source, `accessor ${accessorIndex} has a negative or invalid offset/byteLength`);
    }
    if (!Number.isSafeInteger(stride) || stride < elementBytes || stride % componentBytes !== 0 ||
        (bufferView.byteStride !== undefined && stride > 252)) {
      fail(source, `bufferView ${viewIndex} has invalid byteStride ${stride} for accessor ${accessorIndex}`);
    }
    if ((baseOffset + accessorOffset) % componentBytes !== 0) fail(source, `accessor ${accessorIndex} is not aligned to ${componentBytes} bytes`);
    const endWithinView = accessor.count === 0 ? accessorOffset : accessorOffset + (accessor.count - 1) * stride + elementBytes;
    if (endWithinView > bufferView.byteLength || baseOffset + endWithinView > buffer.byteLength) {
      fail(source, `accessor ${accessorIndex} reads past bufferView ${viewIndex}`);
    }
    const data = new DataView(buffer);
    for (let element = 0; element < accessor.count; element++) {
      if ((element & 2047) === 0) checkCancelled(ctx, source);
      const elementOffset = baseOffset + accessorOffset + element * stride;
      for (let component = 0; component < components; component++) {
        const value = componentValue(data, elementOffset + component * componentBytes, accessor.componentType);
        if (!Number.isFinite(value)) fail(source, `accessor ${accessorIndex} contains a non-finite component`);
        output[element * components + component] = accessor.normalized ? normalizedValue(value, accessor.componentType) : value;
      }
    }
  } else if (!accessor.sparse && accessor.count > 0) {
    fail(source, `accessor ${accessorIndex} has neither a bufferView nor sparse values`);
  }

  if (accessor.sparse) {
    const sparse = accessor.sparse;
    if (!Number.isSafeInteger(sparse.count) || sparse.count < 1 || sparse.count > accessor.count) {
      fail(source, `accessor ${accessorIndex} has invalid sparse count ${sparse.count}`);
    }
    const sparseIndexBytes = COMPONENT_BYTES[sparse.indices.componentType];
    if (![5121, 5123, 5125].includes(sparse.indices.componentType) || !sparseIndexBytes) {
      fail(source, `accessor ${accessorIndex} sparse indices must use unsigned byte, short or int`);
    }
    const indexViewIndex = indexAt(sparse.indices.bufferView, (doc.bufferViews ?? []).length, "sparse indices bufferView", source);
    const valueViewIndex = indexAt(sparse.values.bufferView, (doc.bufferViews ?? []).length, "sparse values bufferView", source);
    const indexView = doc.bufferViews![indexViewIndex]!;
    const valueView = doc.bufferViews![valueViewIndex]!;
    const indexBuffer = buffers[indexAt(indexView.buffer, buffers.length, "sparse indices buffer", source)]!;
    const valueBuffer = buffers[indexAt(valueView.buffer, buffers.length, "sparse values buffer", source)]!;
    const indexViewOffset = indexView.byteOffset ?? 0;
    const valueViewOffset = valueView.byteOffset ?? 0;
    const indexStart = indexViewOffset + (sparse.indices.byteOffset ?? 0);
    const valueStart = valueViewOffset + (sparse.values.byteOffset ?? 0);
    if (!Number.isSafeInteger(indexViewOffset) || !Number.isSafeInteger(valueViewOffset) || !Number.isSafeInteger(indexStart) ||
        !Number.isSafeInteger(valueStart) || !Number.isSafeInteger(indexView.byteLength) || indexView.byteLength < 0 ||
        !Number.isSafeInteger(valueView.byteLength) || valueView.byteLength < 0 || indexStart < 0 || valueStart < 0 ||
        indexStart + sparse.count * sparseIndexBytes > indexViewOffset + indexView.byteLength ||
        valueStart + sparse.count * elementBytes > valueViewOffset + valueView.byteLength ||
        indexStart + sparse.count * sparseIndexBytes > indexBuffer.byteLength || valueStart + sparse.count * elementBytes > valueBuffer.byteLength) {
      fail(source, `accessor ${accessorIndex} sparse values exceed their bufferViews`);
    }
    const indexData = new DataView(indexBuffer);
    const valueData = new DataView(valueBuffer);
    let previous = -1;
    for (let i = 0; i < sparse.count; i++) {
      if ((i & 2047) === 0) checkCancelled(ctx, source);
      const destination = componentValue(indexData, indexStart + i * sparseIndexBytes, sparse.indices.componentType);
      if (!Number.isInteger(destination) || destination <= previous || destination >= accessor.count) {
        fail(source, `accessor ${accessorIndex} sparse indices must be increasing and in range`);
      }
      previous = destination;
      for (let component = 0; component < components; component++) {
        const value = componentValue(valueData, valueStart + (i * components + component) * componentBytes, accessor.componentType);
        if (!Number.isFinite(value)) fail(source, `accessor ${accessorIndex} sparse values contain a non-finite component`);
        output[destination * components + component] = accessor.normalized ? normalizedValue(value, accessor.componentType) : value;
      }
    }
  }
  return { values: output, count: accessor.count, components, componentType: accessor.componentType };
}

function readIndices(doc: GltfDocument, buffers: ArrayBuffer[], accessorIndex: number, vertexCount: number, source: string, ctx?: TaskContext): Uint16Array | Uint32Array {
  const accessors = doc.accessors ?? [];
  const accessor = accessors[indexAt(accessorIndex, accessors.length, "index accessor", source)]!;
  if (accessor.type !== "SCALAR" || accessor.normalized || ![5121, 5123, 5125].includes(accessor.componentType)) {
    fail(source, `index accessor ${accessorIndex} must be an unnormalized unsigned scalar`);
  }
  if (!Number.isSafeInteger(accessor.count) || accessor.count < 1) fail(source, `index accessor ${accessorIndex} has invalid count ${accessor.count}`);
  const componentBytes = COMPONENT_BYTES[accessor.componentType]!;
  const indices = new Uint32Array(accessor.count);
  if (accessor.bufferView !== undefined) {
    const viewIndex = indexAt(accessor.bufferView, (doc.bufferViews ?? []).length, `index accessor ${accessorIndex} bufferView`, source);
    const bufferView = doc.bufferViews![viewIndex]!;
    if (bufferView.byteStride !== undefined) fail(source, `index accessor ${accessorIndex} cannot use an interleaved bufferView`);
    const buffer = buffers[indexAt(bufferView.buffer, buffers.length, `bufferView ${viewIndex} buffer`, source)]!;
    const baseOffset = bufferView.byteOffset ?? 0;
    const accessorOffset = accessor.byteOffset ?? 0;
    const end = accessorOffset + accessor.count * componentBytes;
    if (!Number.isSafeInteger(baseOffset) || !Number.isSafeInteger(accessorOffset) || baseOffset < 0 || accessorOffset < 0 ||
        accessorOffset % componentBytes !== 0 || !Number.isSafeInteger(bufferView.byteLength) || bufferView.byteLength < 0 ||
        end > bufferView.byteLength || baseOffset + end > buffer.byteLength) {
      fail(source, `index accessor ${accessorIndex} reads past or is misaligned in bufferView ${viewIndex}`);
    }
    const data = new DataView(buffer);
    for (let i = 0; i < accessor.count; i++) {
      if ((i & 4095) === 0) checkCancelled(ctx, source);
      indices[i] = componentValue(data, baseOffset + accessorOffset + i * componentBytes, accessor.componentType);
    }
  } else if (!accessor.sparse) {
    fail(source, `index accessor ${accessorIndex} has neither a bufferView nor sparse values`);
  }
  if (accessor.sparse) {
    const sparse = accessor.sparse;
    if (!Number.isSafeInteger(sparse.count) || sparse.count < 1 || sparse.count > accessor.count ||
        ![5121, 5123, 5125].includes(sparse.indices.componentType)) {
      fail(source, `index accessor ${accessorIndex} has invalid sparse metadata`);
    }
    const sparseIndexBytes = COMPONENT_BYTES[sparse.indices.componentType]!;
    const indexViewIndex = indexAt(sparse.indices.bufferView, (doc.bufferViews ?? []).length, "sparse index bufferView", source);
    const valueViewIndex = indexAt(sparse.values.bufferView, (doc.bufferViews ?? []).length, "sparse value bufferView", source);
    const indexView = doc.bufferViews![indexViewIndex]!;
    const valueView = doc.bufferViews![valueViewIndex]!;
    const indexBuffer = buffers[indexAt(indexView.buffer, buffers.length, "sparse index buffer", source)]!;
    const valueBuffer = buffers[indexAt(valueView.buffer, buffers.length, "sparse value buffer", source)]!;
    const indexStart = (indexView.byteOffset ?? 0) + (sparse.indices.byteOffset ?? 0);
    const valueStart = (valueView.byteOffset ?? 0) + (sparse.values.byteOffset ?? 0);
    if (indexStart < 0 || valueStart < 0 || indexStart + sparse.count * sparseIndexBytes > (indexView.byteOffset ?? 0) + indexView.byteLength ||
        valueStart + sparse.count * componentBytes > (valueView.byteOffset ?? 0) + valueView.byteLength ||
        indexStart + sparse.count * sparseIndexBytes > indexBuffer.byteLength || valueStart + sparse.count * componentBytes > valueBuffer.byteLength) {
      fail(source, `index accessor ${accessorIndex} sparse values exceed their bufferViews`);
    }
    const indexData = new DataView(indexBuffer);
    const valueData = new DataView(valueBuffer);
    let previous = -1;
    for (let i = 0; i < sparse.count; i++) {
      if ((i & 4095) === 0) checkCancelled(ctx, source);
      const destination = componentValue(indexData, indexStart + i * sparseIndexBytes, sparse.indices.componentType);
      if (destination <= previous || destination >= accessor.count) fail(source, `index accessor ${accessorIndex} sparse indices are not increasing/in range`);
      previous = destination;
      indices[destination] = componentValue(valueData, valueStart + i * componentBytes, accessor.componentType);
    }
  }
  let max = 0;
  for (let i = 0; i < indices.length; i++) {
    const value = indices[i]!;
    if (value >= vertexCount) fail(source, `index accessor ${accessorIndex} has out-of-range index ${value} for ${vertexCount} vertices`);
    if (value > max) max = value;
  }
  return max <= 65535 ? Uint16Array.from(indices) : indices;
}

function readMaterials(doc: GltfDocument, source: string): DecodedGltfMaterial[] {
  return (doc.materials ?? []).map((material, index) => {
    const pbr = material.pbrMetallicRoughness ?? {};
    const alphaMode = material.alphaMode ?? "OPAQUE";
    if (alphaMode !== "OPAQUE" && alphaMode !== "MASK" && alphaMode !== "BLEND") fail(source, `material ${index} has unsupported alphaMode ${alphaMode}`);
    const factor = pbr.baseColorFactor ?? [1, 1, 1, 1];
    if (factor.length !== 4 || factor.some((v) => !Number.isFinite(v))) fail(source, `material ${index} has invalid baseColorFactor`);
    const metallicFactor = pbr.metallicFactor ?? 1;
    const roughnessFactor = pbr.roughnessFactor ?? 1;
    const alphaCutoff = material.alphaCutoff ?? 0.5;
    if (![metallicFactor, roughnessFactor, alphaCutoff].every(Number.isFinite)) fail(source, `material ${index} has non-finite PBR factors`);
    return {
      name: material.name ?? `material-${index}`,
      alphaMode,
      alphaCutoff,
      doubleSided: material.doubleSided ?? false,
      baseColorFactor: Float32Array.from(factor),
      metallicFactor,
      roughnessFactor,
      baseColorTexture: materialIndex(material.pbrMetallicRoughness?.baseColorTexture?.index, doc, source),
      metallicRoughnessTexture: materialIndex(material.pbrMetallicRoughness?.metallicRoughnessTexture?.index, doc, source),
      normalTexture: materialIndex(material.normalTexture?.index, doc, source),
    };
  });
}

function materialIndex(index: number | undefined, doc: GltfDocument, source: string): number | null {
  if (index === undefined) return null;
  const textures = (doc as GltfDocument & { textures?: unknown[] }).textures ?? [];
  return indexAt(index, textures.length, "material texture", source);
}

function readNodes(doc: GltfDocument, source: string): DecodedGltfNode[] {
  const raw = doc.nodes ?? [];
  const parentCounts = new Uint8Array(raw.length);
  const nodes = raw.map((node, index) => {
    if (node.skin !== undefined) fail(source, `node ${index} uses a skin, which is not supported by the static mesh decoder`, "E_ASSET_GLTF_EXTENSION");
    if (node.weights !== undefined) fail(source, `node ${index} uses morph weights, which are not supported by the static mesh decoder`, "E_ASSET_GLTF_EXTENSION");
    if (node.extensions?.EXT_mesh_gpu_instancing) fail(source, `node ${index} uses unsupported EXT_mesh_gpu_instancing`, "E_ASSET_GLTF_EXTENSION");
    const children = node.children ?? [];
    for (const child of children) {
      const childIndex = indexAt(child, raw.length, `node ${index} child`, source);
      parentCounts[childIndex]++;
      if (parentCounts[childIndex]! > 1) fail(source, `node ${childIndex} has more than one parent`);
    }
    if (node.matrix && (node.translation || node.rotation || node.scale)) fail(source, `node ${index} must use either matrix or TRS, not both`);
    const translation = finiteArray(node.translation, 3, `node ${index} translation`, source);
    const rotation = finiteArray(node.rotation, 4, `node ${index} rotation`, source);
    const scale = finiteArray(node.scale, 3, `node ${index} scale`, source);
    const matrix = finiteArray(node.matrix, 16, `node ${index} matrix`, source);
    return {
      name: node.name ?? `node-${index}`,
      meshIndex: node.mesh === undefined ? null : indexAt(node.mesh, (doc.meshes ?? []).length, `node ${index} mesh`, source),
      children: [...children],
      translation,
      rotation,
      scale,
      matrix,
    };
  });
  const color = new Uint8Array(raw.length);
  const visit = (index: number): void => {
    if (color[index] === 1) fail(source, `node graph contains a cycle at node ${index}`);
    if (color[index] === 2) return;
    color[index] = 1;
    for (const child of nodes[index]!.children) visit(child);
    color[index] = 2;
  };
  for (let i = 0; i < nodes.length; i++) visit(i);
  return nodes;
}

function resultTransferables(result: DecodedGltfAsset): Transferable[] {
  const buffers = new Set<ArrayBuffer>();
  const add = (view: ArrayBufferView | null): void => {
    if (view && view.buffer instanceof ArrayBuffer) buffers.add(view.buffer);
  };
  for (const mesh of result.meshes) {
    for (const primitive of mesh.primitives) {
      for (const attribute of Object.values(primitive.attributes)) add(attribute);
      add(primitive.indices);
      add(primitive.bounds);
    }
  }
  for (const node of result.nodes) {
    add(node.translation);
    add(node.rotation);
    add(node.scale);
    add(node.matrix);
  }
  for (const material of result.materials) add(material.baseColorFactor);
  return [...buffers];
}

/** Decode mesh data; intended to be invoked by the registered worker task or its inline twin. */
export function decodeGltfMeshTask(payload: GltfMeshDecodePayload, ctx?: TaskContext): DecodedGltfAsset {
  const source = payload.source ?? "<memory glTF>";
  let jsonText: string;
  let binary: ArrayBuffer | null = null;
  if (payload.format === "glb") {
    if (!(payload.glb instanceof ArrayBuffer)) fail(source, "GLB payload is missing its ArrayBuffer", "E_ASSET_GLB");
    const parsed = parseGlb(payload.glb, source);
    jsonText = parsed.json;
    binary = parsed.binary;
  } else if (payload.format === "gltf" && typeof payload.json === "string") {
    jsonText = payload.json;
  } else {
    fail(source, "glTF task payload must contain JSON text or a GLB ArrayBuffer");
  }
  checkCancelled(ctx, source);
  const doc = parseJson(jsonText!, source);
  const buffers = resolveBuffers(doc, payload.buffers, binary, source);
  const accessors = doc.accessors ?? [];
  let primitiveCount = 0;
  let vertexCount = 0;
  let decodedBytes = 0;
  const totalPrimitives = (doc.meshes ?? []).reduce((sum, entry) => sum + (entry.primitives?.length ?? 0), 0);

  const meshes: DecodedGltfMesh[] = (doc.meshes ?? []).map((mesh, meshIndex) => {
    if (!Array.isArray(mesh.primitives) || mesh.primitives.length === 0) fail(source, `mesh ${meshIndex} has no primitives`);
    if (mesh.weights !== undefined) fail(source, `mesh ${meshIndex} uses morph weights, which are not supported by the static mesh decoder`, "E_ASSET_GLTF_EXTENSION");
    const primitives = mesh.primitives.map((primitive, primitiveIndex): DecodedGltfPrimitive => {
      checkCancelled(ctx, source);
      if (primitive.targets?.length) fail(source, `mesh ${meshIndex} primitive ${primitiveIndex} has morph targets, which are not supported by the static mesh decoder`, "E_ASSET_GLTF_EXTENSION");
      const mode = primitive.mode ?? 4;
      if (mode !== 4) fail(source, `mesh ${meshIndex} primitive ${primitiveIndex} uses mode ${mode}; only triangle lists (4) are supported`, "E_ASSET_GLTF_PRIMITIVE");
      if (primitive.extensions?.KHR_draco_mesh_compression || primitive.extensions?.EXT_meshopt_compression) {
        const ext = primitive.extensions.KHR_draco_mesh_compression ? "KHR_draco_mesh_compression" : "EXT_meshopt_compression";
        fail(source, `mesh ${meshIndex} primitive ${primitiveIndex} uses unsupported ${ext}`, "E_ASSET_GLTF_EXTENSION");
      }
      const sourceAttributes = primitive.attributes;
      if (!sourceAttributes || typeof sourceAttributes !== "object" || !Number.isInteger(sourceAttributes.POSITION)) {
        fail(source, `mesh ${meshIndex} primitive ${primitiveIndex} is missing POSITION`);
      }
      if (Object.keys(sourceAttributes).some((semantic) => /^(JOINTS|WEIGHTS)_\d+$/.test(semantic))) {
        fail(source, `mesh ${meshIndex} primitive ${primitiveIndex} contains skinning attributes, which are not supported by the static mesh decoder`, "E_ASSET_GLTF_EXTENSION");
      }
      const attributes: Record<string, Float32Array> = {};
      let count = -1;
      for (const [semantic, accessorIndex] of Object.entries(sourceAttributes)) {
        if (!Number.isInteger(accessorIndex)) fail(source, `mesh ${meshIndex} primitive ${primitiveIndex} attribute ${semantic} has an invalid accessor`);
        const decoded = readAccessor(doc, buffers, accessorIndex, source, ctx);
        if (count < 0) count = decoded.count;
        else if (decoded.count !== count) fail(source, `mesh ${meshIndex} primitive ${primitiveIndex} attribute ${semantic} has ${decoded.count} vertices; expected ${count}`);
        if (semantic === "POSITION" && decoded.components !== 3) fail(source, `mesh ${meshIndex} primitive ${primitiveIndex} POSITION must be VEC3`);
        if (semantic === "NORMAL" && decoded.components !== 3) fail(source, `mesh ${meshIndex} primitive ${primitiveIndex} NORMAL must be VEC3`);
        if (semantic === "TANGENT" && decoded.components !== 4) fail(source, `mesh ${meshIndex} primitive ${primitiveIndex} TANGENT must be VEC4`);
        if (semantic.startsWith("TEXCOORD_") && decoded.components !== 2) fail(source, `mesh ${meshIndex} primitive ${primitiveIndex} ${semantic} must be VEC2`);
        attributes[semantic] = decoded.values;
      }
      const positions = attributes.POSITION!;
      if (count < 1) fail(source, `mesh ${meshIndex} primitive ${primitiveIndex} has no vertices`);
      if (accessors[sourceAttributes.POSITION!]!.componentType !== 5126) fail(source, `mesh ${meshIndex} primitive ${primitiveIndex} POSITION must use FLOAT components`);
      let indices: Uint16Array | Uint32Array | null = null;
      if (primitive.indices !== undefined) {
        indices = readIndices(doc, buffers, primitive.indices, count, source, ctx);
        if (indices.length === 0 || indices.length % 3 !== 0) fail(source, `mesh ${meshIndex} primitive ${primitiveIndex} index count must be a positive multiple of 3`);
      } else if (count % 3 !== 0) {
        fail(source, `mesh ${meshIndex} primitive ${primitiveIndex} vertex count must be a multiple of 3 when unindexed`);
      }
      const material = primitive.material === undefined ? null : indexAt(primitive.material, (doc.materials ?? []).length, "primitive material", source);
      const bounds = new Float32Array([Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]);
      for (let i = 0; i < count; i++) {
        if ((i & 4095) === 0) checkCancelled(ctx, source);
        const x = positions[i * 3]!;
        const y = positions[i * 3 + 1]!;
        const z = positions[i * 3 + 2]!;
        if (![x, y, z].every(Number.isFinite)) fail(source, `mesh ${meshIndex} primitive ${primitiveIndex} POSITION contains non-finite values`);
        bounds[0] = Math.min(bounds[0]!, x);
        bounds[1] = Math.min(bounds[1]!, y);
        bounds[2] = Math.min(bounds[2]!, z);
        bounds[3] = Math.max(bounds[3]!, x);
        bounds[4] = Math.max(bounds[4]!, y);
        bounds[5] = Math.max(bounds[5]!, z);
      }
      primitiveCount++;
      vertexCount += count;
      decodedBytes += positions.byteLength + (indices?.byteLength ?? 0) + Object.entries(attributes)
        .filter(([semantic]) => semantic !== "POSITION")
        .reduce((sum, [, values]) => sum + values.byteLength, 0) + bounds.byteLength;
      ctx?.progress(totalPrimitives > 0 ? primitiveCount / totalPrimitives : 1, { mesh: meshIndex, primitive: primitiveIndex });
      return { mode: 4, attributes, indices, materialIndex: material, vertexCount: count, bounds };
    });
    return { name: mesh.name ?? `mesh-${meshIndex}`, primitives };
  });

  const nodes = readNodes(doc, source);
  const scenes: DecodedGltfScene[] = (doc.scenes ?? []).map((scene, index) => ({
    name: scene.name ?? `scene-${index}`,
    nodes: (scene.nodes ?? []).map((node) => indexAt(node, nodes.length, `scene ${index} node`, source)),
  }));
  const sceneIndex = doc.scene ?? (scenes.length > 0 ? 0 : -1);
  if (sceneIndex >= 0) indexAt(sceneIndex, scenes.length, "active scene", source);
  const materials = readMaterials(doc, source);
  for (const mesh of meshes) {
    for (const primitive of mesh.primitives) {
      if (primitive.materialIndex !== null) indexAt(primitive.materialIndex, materials.length, "primitive material", source);
    }
  }
  checkCancelled(ctx, source);
  return { version: "2.0", source, meshes, nodes, scenes, sceneIndex, materials, primitiveCount, vertexCount, decodedBytes };
}

/** The result arrays are newly allocated and can be transferred without copying. */
export function transferablesForGltfMesh(result: unknown): Transferable[] {
  if (!result || typeof result !== "object") return [];
  try {
    return resultTransferables(result as DecodedGltfAsset);
  } catch {
    return [];
  }
}

/** Input buffers a caller may transfer to a worker when it owns them. */
export function transferablesForGltfMeshPayload(payload: GltfMeshDecodePayload): ArrayBuffer[] {
  const out = new Set<ArrayBuffer>();
  if (payload.glb) out.add(payload.glb);
  for (const buffer of payload.buffers ?? []) if (buffer) out.add(buffer);
  return [...out];
}

/** A cheap structural check the URL loader uses before deciding whether to parse JSON for buffers. */
export function isGlbBuffer(data: ArrayBuffer): boolean {
  return data.byteLength >= 4 && new DataView(data).getUint32(0, true) === GLB_MAGIC;
}
