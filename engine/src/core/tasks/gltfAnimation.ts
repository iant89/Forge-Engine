/**
 * glTF 2.0 animation decoding — extracts `animations[]` from a parsed glTF document.
 *
 * This module runs in the same worker context as the mesh decoder (no DOM, no GPU, no fetch).
 * It reads animation accessor data from the same resolved buffer pool and returns plain,
 * structured-cloneable typed arrays that cross the worker boundary without copying.
 *
 * The decoder is additive: the mesh decoder already produces `DecodedGltfAsset`, and the caller
 * merges `DecodedGltfAnimation[]` onto it after calling `decodeGltfAnimations`. This avoids
 * changing the existing mesh-decode task contract while animations are new.
 *
 * Supports: STEP, LINEAR, CUBICSPLINE interpolation; translation, rotation, scale channels.
 * Excluded: morph target weights (CHANNEL_WEIGHTS) — they require mesh morph data that is
 * not yet decoded by the static mesh path.
 */

import { AssetError } from "../errors.js";

const COMPONENT_BYTES: Record<number, number> = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
const COMPONENTS: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };

// ──────────────────────── public types ────────────────────────

export interface DecodedAnimationChannel {
  /** Index into the scene's node array (the target node). */
  targetNode: number;
  /** The animated property. */
  targetPath: "translation" | "rotation" | "scale";
  /** Index into the animation's sampler array. */
  samplerIndex: number;
}

export interface DecodedAnimationSampler {
  /** Monotonically increasing timestamps, one per key (Float32Array). */
  input: Float32Array;
  /** Packed output values (3 floats/key for translation/scale, 4 for rotation; ×3 for CUBICSPLINE). */
  output: Float32Array;
  interpolation: "STEP" | "LINEAR" | "CUBICSPLINE";
}

export interface DecodedGltfAnimation {
  name: string;
  channels: DecodedAnimationChannel[];
  samplers: DecodedAnimationSampler[];
  /** Clip duration in seconds — max timestamp across all samplers. */
  duration: number;
}

// ──────────────────────── decoder ────────────────────────

interface GltfAnimationDef {
  name?: string;
  channels?: {
    sampler: number;
    target: { node: number; path: string };
  }[];
  samplers?: {
    input: number;
    output: number;
    interpolation?: string;
  }[];
}

interface GltfDocumentWithAnimations {
  animations?: GltfAnimationDef[];
  nodes?: unknown[];
  accessors?: {
    bufferView?: number;
    byteOffset?: number;
    componentType: number;
    count: number;
    type: string;
    normalized?: boolean;
    min?: number[];
    max?: number[];
    sparse?: unknown;
  }[];
  bufferViews?: {
    buffer: number;
    byteOffset?: number;
    byteLength: number;
    byteStride?: number;
  }[];
}

function fail(source: string, message: string, code = "E_ASSET_GLTF_ANIM"): never {
  throw new AssetError(message, source, code);
}

function indexAt(value: number, length: number, label: string, source: string): number {
  if (!Number.isSafeInteger(value) || value < 0 || value >= length) fail(source, `${label} index ${value} is out of range`);
  return value;
}

/**
 * Read an accessor's data as a Float32Array. Re-implements the accessor reader for the worker
 * context; identical to the mesh decoder's `readAccessor` but returns raw float data only
 * (no sparse overlay re-implemented — animation accessors are dense in practice).
 */
function readAccessorFloat32(
  doc: GltfDocumentWithAnimations,
  buffers: ArrayBuffer[],
  accessorIndex: number,
  source: string,
): Float32Array {
  const accessors = doc.accessors ?? [];
  const accessor = accessors[indexAt(accessorIndex, accessors.length, "animation accessor", source)]!;
  const componentBytes = COMPONENT_BYTES[accessor.componentType];
  const components = COMPONENTS[accessor.type];
  if (!componentBytes || !components) fail(source, `animation accessor ${accessorIndex} has unsupported type ${accessor.type}/${accessor.componentType}`);
  if (accessor.sparse) fail(source, `animation accessor ${accessorIndex} uses sparse storage, which is not supported for animation data`);
  if (!Number.isSafeInteger(accessor.count) || accessor.count < 1) fail(source, `animation accessor ${accessorIndex} has invalid count ${accessor.count}`);

  const output = new Float32Array(accessor.count * components);
  const elementBytes = componentBytes * components;

  if (accessor.bufferView !== undefined) {
    const views = doc.bufferViews ?? [];
    const viewIndex = indexAt(accessor.bufferView, views.length, `animation accessor ${accessorIndex} bufferView`, source);
    const bufferView = views[viewIndex]!;
    const buffer = buffers[indexAt(bufferView.buffer, buffers.length, `bufferView ${viewIndex} buffer`, source)]!;
    const baseOffset = bufferView.byteOffset ?? 0;
    const accessorOffset = accessor.byteOffset ?? 0;
    const stride = bufferView.byteStride ?? elementBytes;

    if ((baseOffset + accessorOffset) % componentBytes !== 0) fail(source, `animation accessor ${accessorIndex} is not aligned to ${componentBytes} bytes`);
    const endWithinView = accessor.count === 0 ? accessorOffset : accessorOffset + (accessor.count - 1) * stride + elementBytes;
    if (endWithinView > bufferView.byteLength || baseOffset + endWithinView > buffer.byteLength) {
      fail(source, `animation accessor ${accessorIndex} reads past bufferView ${viewIndex}`);
    }

    const data = new DataView(buffer);
    for (let element = 0; element < accessor.count; element++) {
      const elementOffset = baseOffset + accessorOffset + element * stride;
      for (let component = 0; component < components; component++) {
        const off = elementOffset + component * componentBytes;
        let value: number;
        switch (accessor.componentType) {
          case 5120: value = data.getInt8(off); if (accessor.normalized) value = Math.max(value / 127, -1); break;
          case 5121: value = data.getUint8(off); if (accessor.normalized) value = value / 255; break;
          case 5122: value = data.getInt16(off, true); if (accessor.normalized) value = Math.max(value / 32767, -1); break;
          case 5123: value = data.getUint16(off, true); if (accessor.normalized) value = value / 65535; break;
          case 5125: value = data.getUint32(off, true); break;
          case 5126: value = data.getFloat32(off, true); break;
          default: fail(source, `animation accessor ${accessorIndex} has unsupported componentType ${accessor.componentType}`);
        }
        output[element * components + component] = value;
      }
    }
  } else {
    fail(source, `animation accessor ${accessorIndex} has no bufferView`);
  }
  return output;
}

/**
 * Decode all `animations[]` from a glTF document that has already been parsed and whose buffers
 * have been resolved.
 *
 * Returns an empty array when the document has no animations — this is not an error.
 *
 * @param doc - The parsed glTF JSON document (same object the mesh decoder uses).
 * @param buffers - Resolved buffer data (same array the mesh decoder uses).
 * @param nodeCount - Number of nodes in the document, for bounds checking.
 * @param source - Asset source name for error messages.
 */
export function decodeGltfAnimations(
  doc: GltfDocumentWithAnimations,
  buffers: ArrayBuffer[],
  nodeCount: number,
  source: string,
): DecodedGltfAnimation[] {
  const raw = doc.animations;
  if (!raw || raw.length === 0) return [];

  const result: DecodedGltfAnimation[] = [];

  for (let animIndex = 0; animIndex < raw.length; animIndex++) {
    const anim = raw[animIndex]!;
    const name = anim.name ?? `animation-${animIndex}`;

    // ── samplers ──
    const rawSamplers = anim.samplers ?? [];
    if (rawSamplers.length === 0) {
      // Empty animation — skip silently (glTF allows it).
      continue;
    }

    const samplers: DecodedAnimationSampler[] = [];
    let duration = 0;

    for (let si = 0; si < rawSamplers.length; si++) {
      const sampler = rawSamplers[si]!;
      const interp = sampler.interpolation ?? "LINEAR";
      if (interp !== "STEP" && interp !== "LINEAR" && interp !== "CUBICSPLINE") {
        fail(source, `animation ${animIndex} sampler ${si} has unsupported interpolation ${interp}`);
      }

      const input = readAccessorFloat32(doc, buffers, sampler.input, source);
      const output = readAccessorFloat32(doc, buffers, sampler.output, source);

      // Validate: input must be monotonically increasing timestamps.
      for (let k = 1; k < input.length; k++) {
        if (input[k]! < input[k - 1]!) {
          fail(source, `animation ${animIndex} sampler ${si} timestamps are not monotonically increasing at index ${k}`);
        }
      }

      const lastT = input.length > 0 ? input[input.length - 1]! : 0;
      if (lastT > duration) duration = lastT;

      samplers.push({ input, output, interpolation: interp as "STEP" | "LINEAR" | "CUBICSPLINE" });
    }

    // ── channels ──
    const rawChannels = anim.channels ?? [];
    const channels: DecodedAnimationChannel[] = [];

    for (let ci = 0; ci < rawChannels.length; ci++) {
      const channel = rawChannels[ci]!;
      if (!channel.target) fail(source, `animation ${animIndex} channel ${ci} has no target`);

      const targetNode = channel.target.node;
      if (!Number.isSafeInteger(targetNode) || targetNode < 0 || targetNode >= nodeCount) {
        fail(source, `animation ${animIndex} channel ${ci} targets invalid node ${targetNode}`);
      }

      const path = channel.target.path;
      if (path !== "translation" && path !== "rotation" && path !== "scale") {
        // Morph target weights — silently skip for now.
        if (path === "weights") continue;
        fail(source, `animation ${animIndex} channel ${ci} has unsupported target path ${path}`);
      }

      indexAt(channel.sampler, samplers.length, `animation ${animIndex} channel ${ci} sampler`, source);

      channels.push({
        targetNode,
        targetPath: path as "translation" | "rotation" | "scale",
        samplerIndex: channel.sampler,
      });
    }

    // Skip animations with no usable channels (all-morph, etc.).
    if (channels.length === 0) continue;

    result.push({ name, channels, samplers, duration });
  }

  return result;
}

/**
 * Transferable buffers for decoded animation data (typed array ArrayBuffers).
 */
export function transferablesForAnimations(anims: DecodedGltfAnimation[]): Transferable[] {
  const buffers = new Set<ArrayBuffer>();
  for (const anim of anims) {
    for (const sampler of anim.samplers) {
      if (sampler.input.buffer instanceof ArrayBuffer) buffers.add(sampler.input.buffer);
      if (sampler.output.buffer instanceof ArrayBuffer) buffers.add(sampler.output.buffer);
    }
  }
  return [...buffers];
}