/**
 * glTF 2.0 / GLB mesh import preparation (Phase 9.1).
 *
 * Network fetches stay on the caller's thread, but JSON/accessor decoding and unpacking run through
 * the engine task scheduler when one is supplied. The worker returns plain metadata and transferable
 * typed arrays; GPU resources are deliberately created later on the main thread. `loadGltfMesh`
 * resolves external `.gltf` buffer URIs before dispatch, while `decodeGltfMesh` also accepts a
 * self-contained JSON document or a GLB byte buffer directly.
 *
 * Triangle primitives, interleaved/sparse accessors, normalized integer attributes, node transforms,
 * scene roots and core PBR material factors are preserved. Draco/meshopt-compressed geometry and
 * image/animation/skin decoding are explicit follow-up work rather than silently producing empty
 * geometry.
 */

import { AssetError, UsageError } from "../core/errors.js";
import { TaskPriority, type TaskScheduler } from "../core/tasks/scheduler.js";
import { builtinTaskHandlersReady } from "../core/tasks/registry.js";
import {
  decodeGltfMeshTask,
  GLTF_MESH_DECODE_TASK,
  isGlbBuffer,
  transferablesForGltfMeshPayload,
  type DecodedGltfAsset,
  type GltfMeshDecodePayload,
} from "../core/tasks/gltfMesh.js";

export type {
  DecodedGltfAsset,
  DecodedGltfMaterial,
  DecodedGltfMesh,
  DecodedGltfNode,
  DecodedGltfPrimitive,
  DecodedGltfScene,
  GltfMeshDecodePayload,
} from "../core/tasks/gltfMesh.js";

export interface GltfMeshDocumentInput {
  /** Serialized glTF 2.0 JSON. External buffer data is supplied in the same order as `buffers[]`. */
  json: string;
  buffers?: readonly (ArrayBuffer | null)[];
}

export type GltfMeshInput = ArrayBuffer | ArrayBufferView | string | GltfMeshDocumentInput;

export interface DecodeGltfMeshOptions {
  /** When provided, `asset.gltf.decode` runs on its worker pool; absent schedulers run inline. */
  scheduler?: TaskScheduler;
  /** Stable task identity for deduplication/cancellation. Defaults to a unique key per decode. */
  key?: string;
  priority?: number;
  source?: string;
  /** Transfer input buffers to the worker instead of copying them. This detaches owned buffers. */
  transferInput?: boolean;
  /** Cancels queued work and cooperatively stops a running decode when the signal fires. */
  signal?: AbortSignal;
  /** External buffers by glTF buffer index (data URIs remain decoded inside the worker). */
  buffers?: readonly (ArrayBuffer | null)[];
}

export interface LoadGltfMeshOptions extends Omit<DecodeGltfMeshOptions, "buffers"> {
  /** Test/host seam for authenticated or instrumented fetch implementations. */
  fetcher?: (input: string | URL, init?: RequestInit) => Promise<Response>;
}

let nextDecodeKey = 1;

function sourceName(input: GltfMeshInput, source?: string): string {
  if (source) return source;
  if (typeof input === "string") return "<memory glTF>";
  if (input && typeof input === "object" && "json" in input) return "<memory glTF>";
  return "<memory glTF/GLB>";
}

function byteViewToBuffer(input: ArrayBuffer | ArrayBufferView): ArrayBuffer {
  if (input instanceof ArrayBuffer) return input;
  const bytes = new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  return bytes.slice().buffer;
}

function makePayload(input: GltfMeshInput, options: DecodeGltfMeshOptions): GltfMeshDecodePayload {
  const source = sourceName(input, options.source);
  if (typeof input === "string") {
    return { format: "gltf", json: input, buffers: [...(options.buffers ?? [])], source };
  }
  if (input && typeof input === "object" && "json" in input) {
    if (typeof input.json !== "string") throw new UsageError("decodeGltfMesh: document.json must be serialized glTF JSON");
    return { format: "gltf", json: input.json, buffers: [...(input.buffers ?? options.buffers ?? [])], source };
  }
  const bytes = byteViewToBuffer(input as ArrayBuffer | ArrayBufferView);
  if (isGlbBuffer(bytes)) return { format: "glb", glb: bytes, buffers: [...(options.buffers ?? [])], source };
  let json: string;
  try {
    json = new TextDecoder().decode(bytes);
  } catch (error) {
    throw new AssetError(`unable to decode glTF JSON bytes: ${String(error)}`, source);
  }
  return { format: "gltf", json, buffers: [...(options.buffers ?? [])], source };
}

/** Decode mesh primitives to transferable arrays; pass `scheduler` to run parsing on its worker pool. */
export async function decodeGltfMesh(input: GltfMeshInput, options: DecodeGltfMeshOptions = {}): Promise<DecodedGltfAsset> {
  const payload = makePayload(input, options);
  if (!options.scheduler) return decodeGltfMeshTask(payload);
  if (options.signal?.aborted) throw new AssetError("glTF mesh decode cancelled before submission", payload.source ?? "<memory glTF>", "E_ASSET_CANCELLED");
  await builtinTaskHandlersReady();
  const key = options.key ?? `asset.gltf.decode:${nextDecodeKey++}`;
  const transfer = options.transferInput ? transferablesForGltfMeshPayload(payload) : [];
  const promise = options.scheduler.submit<GltfMeshDecodePayload, DecodedGltfAsset>({
    name: GLTF_MESH_DECODE_TASK,
    key,
    priority: options.priority ?? TaskPriority.Normal,
    payload,
    ...(transfer.length > 0 ? { transfer } : {}),
  });
  const onAbort = () => options.scheduler!.cancel(key, new AssetError("glTF mesh decode cancelled", payload.source ?? "<memory glTF>", "E_ASSET_CANCELLED"));
  options.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    return await promise;
  } finally {
    options.signal?.removeEventListener("abort", onAbort);
  }
}

/** Fetch a `.gltf` JSON document or `.glb`, resolve sidecar buffers, then decode on the scheduler. */
export async function loadGltfMesh(url: string | URL, options: LoadGltfMeshOptions = {}): Promise<DecodedGltfAsset> {
  const source = String(url);
  const fetcher = options.fetcher ?? fetch;
  let response: Response;
  try {
    response = await fetcher(url, options.signal ? { signal: options.signal } : undefined);
  } catch (error) {
    throw new AssetError(`failed to fetch glTF (${error instanceof Error ? error.message : String(error)})`, source);
  }
  if (!response.ok) throw new AssetError(`failed to fetch glTF (${response.status} ${response.statusText})`, source);
  const data = await response.arrayBuffer();
  if (isGlbBuffer(data)) {
    return decodeGltfMesh(data, { ...options, source, transferInput: options.transferInput ?? true });
  }

  let json: string;
  let document: { buffers?: { uri?: string; byteLength?: number }[] };
  try {
    json = new TextDecoder().decode(data);
    document = JSON.parse(json) as typeof document;
  } catch (error) {
    throw new AssetError(`invalid glTF JSON: ${error instanceof Error ? error.message : String(error)}`, source);
  }
  if (!document || typeof document !== "object" || Array.isArray(document)) throw new AssetError("glTF JSON root must be an object", source);
  const base = response.url || source;
  const externalBuffers = await Promise.all((document.buffers ?? []).map(async (buffer, index) => {
    if (typeof buffer.uri !== "string") throw new AssetError(`glTF buffer ${index} has no URI in a JSON .gltf file`, source);
    if (buffer.uri.startsWith("data:")) return null;
    let bufferResponse: Response;
    try {
      bufferResponse = await fetcher(new URL(buffer.uri, base), options.signal ? { signal: options.signal } : undefined);
    } catch (error) {
      throw new AssetError(`failed to fetch glTF buffer ${index}: ${error instanceof Error ? error.message : String(error)}`, source);
    }
    if (!bufferResponse.ok) throw new AssetError(`failed to fetch glTF buffer ${index} (${bufferResponse.status})`, source);
    const bytes = await bufferResponse.arrayBuffer();
    if (typeof buffer.byteLength === "number" && bytes.byteLength < buffer.byteLength) {
      throw new AssetError(`glTF buffer ${index} has ${bytes.byteLength} bytes; expected ${buffer.byteLength}`, source);
    }
    return bytes;
  }));
  return decodeGltfMesh({ json, buffers: externalBuffers }, { ...options, source, transferInput: options.transferInput ?? true });
}
