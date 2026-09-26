/**
 * Reader + sampler for the generator's Stage A cache (`cache/global/face_<0-5>/*`).
 *
 * Stage A is the one part of the generator that genuinely has to be pre-computed: it *simulates*
 * thermal relaxation, a D8 flow-accumulation incision pass and a wind/dune pass on a low-resolution
 * grid per cube face (default 512x512), and writes the result as `erosionDelta = eroded - base`
 * next to the geology context (`hardness`, `material`, `flowAccum`) that the detail pass consumes.
 * Everything else in the generator is analytic and the engine can evaluate it per vertex (see
 * `stage.ts`), which is why the recommended integration ships ~30 MB of Stage A fields instead of a
 * multi-terabyte chunk cache.
 *
 * On-disk format (one file per field, one directory per face — verified against the generator's
 * `src/global/globalCache.ts`):
 *
 *   cache/global/face_3/meta.json          { "face": 3, "res": 512 }
 *   cache/global/face_3/baseElevation.f32   res*res float32 LE  (analytic base, before erosion)
 *   cache/global/face_3/erodedElevation.f32 res*res float32 LE  (after thermal + hydraulic + wind)
 *   cache/global/face_3/erosionDelta.f32    res*res float32 LE  (the field this port needs)
 *   cache/global/face_3/hardness.f32        res*res float32 LE
 *   cache/global/face_3/material.u8         res*res uint8
 *   cache/global/face_3/flowAccum.f32       res*res float32 LE
 *
 * This module is browser-first like the rest of the engine: it decodes bytes and never touches the
 * filesystem. `fetchMarsFaceFields` covers the served-asset case (copy `cache/global/` into the
 * demo's `public/`), and a Node tool can read the same files with `node:fs` and hand the buffers to
 * `marsFaceFieldsFromBuffers`.
 */

import { UsageError } from "../../core/errors.js";
import { MARS_FACE_COUNT, marsDirectionToFaceUV } from "./cubeSphere.js";
import type { MarsMaterial } from "./geology.js";

/** One cube face's Stage A fields. `baseElevation`/`erodedElevation` are optional debug views. */
export interface MarsFaceFields {
  face: number;
  res: number;
  erosionDelta: Float32Array;
  hardness: Float32Array;
  material: Uint8Array;
  flowAccum: Float32Array;
  baseElevation?: Float32Array;
  erodedElevation?: Float32Array;
}

/** Raw buffers as they appear on disk, for one face. */
export interface MarsFaceFieldBuffers {
  face: number;
  res: number;
  erosionDelta: ArrayBufferLike;
  hardness: ArrayBufferLike;
  flowAccum: ArrayBufferLike;
  material: ArrayBufferLike;
  baseElevation?: ArrayBufferLike;
  erodedElevation?: ArrayBufferLike;
}

/** The fields a chunk sample pulls out of Stage A. */
export interface MarsGlobalSample {
  erosionDelta: number;
  hardness: number;
  material: MarsMaterial;
  flowAccum: number;
}

/**
 * Largest allocatable/validated grid resolution. The default cache is 512; this only exists so a
 * corrupt or hostile `meta.json` cannot ask for a 400 GB allocation.
 */
const MAX_FACE_RES = 8192;

function f32FromBytes(bytes: ArrayBufferLike, count: number, what: string): Float32Array {
  if (bytes.byteLength < count * 4) {
    throw new UsageError(
      `Mars Stage A ${what}: expected ${count * 4} bytes for ${count} float32 values, got ${bytes.byteLength}`,
    );
  }
  // Whole buffers only (a `fetch().arrayBuffer()` or a `readFile()` result is always 0-offset, so
  // the float view is aligned). A caller holding a subarray should slice it first.
  return new Float32Array(bytes, 0, count);
}

function u8FromBytes(bytes: ArrayBufferLike, count: number, what: string): Uint8Array {
  if (bytes.byteLength < count) {
    throw new UsageError(`Mars Stage A ${what}: expected ${count} bytes, got ${bytes.byteLength}`);
  }
  return new Uint8Array(bytes, 0, count);
}

function assertRes(res: number, what: string): number {
  const value = Math.floor(res);
  if (!Number.isFinite(value) || value < 2 || value > MAX_FACE_RES) {
    throw new UsageError(`Mars Stage A ${what}: resolution ${res} is outside 2..${MAX_FACE_RES}`);
  }
  return value;
}

/** Build a face field set from raw file contents (the decoder both the browser and Node paths share). */
export function marsFaceFieldsFromBuffers(buffers: MarsFaceFieldBuffers): MarsFaceFields {
  const res = assertRes(buffers.res, `face ${buffers.face}`);
  const count = res * res;
  const fields: MarsFaceFields = {
    face: buffers.face,
    res,
    erosionDelta: f32FromBytes(buffers.erosionDelta, count, "erosionDelta"),
    hardness: f32FromBytes(buffers.hardness, count, "hardness"),
    material: u8FromBytes(buffers.material, count, "material"),
    flowAccum: f32FromBytes(buffers.flowAccum, count, "flowAccum"),
  };
  if (buffers.baseElevation) {
    fields.baseElevation = f32FromBytes(buffers.baseElevation, count, "baseElevation");
  }
  if (buffers.erodedElevation) {
    fields.erodedElevation = f32FromBytes(buffers.erodedElevation, count, "erodedElevation");
  }
  return fields;
}

/**
 * Load one face from a `cache/global/face_<n>/` directory exposed over HTTP (or any fetch-able
 * base URL). `baseUrl` must end with a slash, e.g. `/mars-cache/global/face_3/`.
 */
export async function fetchMarsFaceFields(
  baseUrl: string,
  face: number,
  fetchImpl: typeof fetch = fetch,
): Promise<MarsFaceFields> {
  const dir = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  const get = async (name: string): Promise<ArrayBuffer> => {
    const response = await fetchImpl(`${dir}${name}`);
    if (!response.ok) {
      throw new UsageError(`Mars Stage A: GET ${dir}${name} failed with ${response.status}`);
    }
    return response.arrayBuffer();
  };

  const metaResponse = await fetchImpl(`${dir}meta.json`);
  if (!metaResponse.ok) {
    throw new UsageError(`Mars Stage A: GET ${dir}meta.json failed with ${metaResponse.status}`);
  }
  const meta = (await metaResponse.json()) as { face?: number; res?: number };
  const resolvedFace = meta.face ?? face;
  const res = meta.res ?? 0;

  const [erosionDelta, hardness, flowAccum, material] = await Promise.all([
    get("erosionDelta.f32"),
    get("hardness.f32"),
    get("flowAccum.f32"),
    get("material.u8"),
  ]);
  return marsFaceFieldsFromBuffers({ face: resolvedFace, res, erosionDelta, hardness, flowAccum, material });
}

/**
 * The six faces the port samples from, with the generator's bilinear lookup.
 *
 * A face that has not been loaded is not an error: sampling returns neutral values (no erosion
 * correction, mid hardness, regolith) so terrain still builds. `missingFaces` tells a HUD or a tool
 * which parts of the planet are running without their simulated-erosion correction.
 */
export class MarsGlobalFieldSet {
  private readonly byFace: (MarsFaceFields | undefined)[];

  constructor(faces: readonly (MarsFaceFields | undefined)[] = []) {
    this.byFace = new Array<MarsFaceFields | undefined>(MARS_FACE_COUNT);
    for (const face of faces) {
      if (face) this.byFace[face.face] = face;
    }
  }

  /** Faces present, ascending. */
  get availableFaces(): number[] {
    const out: number[] = [];
    for (let i = 0; i < this.byFace.length; i++) if (this.byFace[i]) out.push(i);
    return out;
  }

  get missingFaces(): number[] {
    const out: number[] = [];
    for (let i = 0; i < this.byFace.length; i++) if (!this.byFace[i]) out.push(i);
    return out;
  }

  get complete(): boolean {
    return this.missingFaces.length === 0;
  }

  /** Bytes actually held (the three sampled fields plus material). */
  get bytes(): number {
    let total = 0;
    for (const face of this.byFace) {
      if (!face) continue;
      total += face.erosionDelta.byteLength + face.hardness.byteLength + face.flowAccum.byteLength + face.material.byteLength;
      if (face.baseElevation) total += face.baseElevation.byteLength;
      if (face.erodedElevation) total += face.erodedElevation.byteLength;
    }
    return total;
  }

  /** Grid resolution of a loaded face (all faces of one cache share it). */
  get res(): number {
    for (const face of this.byFace) if (face) return face.res;
    return 0;
  }

  has(face: number): boolean {
    return !!this.byFace[face];
  }

  /**
   * Bilinear sample of the fields at a unit direction.
   *
   * `erosionDelta`, `hardness` and `flowAccum` are interpolated; `material` is a discrete id and
   * takes the nearest cell (interpolating an enum would invent materials that do not exist).
   */
  sample(dirX: number, dirY: number, dirZ: number, out?: MarsGlobalSample): MarsGlobalSample {
    const { face, u, v } = marsDirectionToFaceUV({ x: dirX, y: dirY, z: dirZ });
    const f = this.byFace[face];
    if (!f) {
      const fallback = out ?? { erosionDelta: 0, hardness: 0.5, material: 0 as MarsMaterial, flowAccum: 0 };
      fallback.erosionDelta = 0;
      fallback.hardness = 0.5;
      fallback.material = 0 as MarsMaterial;
      fallback.flowAccum = 0;
      return fallback;
    }

    const res = f.res;
    const fx = ((u + 1) / 2) * (res - 1);
    const fy = ((v + 1) / 2) * (res - 1);
    const x0 = Math.max(0, Math.min(res - 2, Math.floor(fx)));
    const y0 = Math.max(0, Math.min(res - 2, Math.floor(fy)));
    const tx = fx - x0;
    const ty = fy - y0;
    const i00 = y0 * res + x0;
    const i10 = i00 + 1;
    const i01 = i00 + res;
    const i11 = i01 + 1;

    const bilerp = (arr: Float32Array): number => {
      const a = arr[i00]!;
      const b = arr[i10]!;
      const c = arr[i01]!;
      const d = arr[i11]!;
      return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
    };

    const nx = Math.round(fx);
    const ny = Math.round(fy);
    const materialIndex = Math.max(0, Math.min(res - 1, ny)) * res + Math.max(0, Math.min(res - 1, nx));

    const result = out ?? { erosionDelta: 0, hardness: 0.5, material: 0 as MarsMaterial, flowAccum: 0 };
    result.erosionDelta = bilerp(f.erosionDelta);
    result.hardness = bilerp(f.hardness);
    result.flowAccum = bilerp(f.flowAccum);
    result.material = f.material[materialIndex]! as MarsMaterial;
    return result;
  }
}

/** Convenience: the standalone sampling function `MarsGlobalFieldSet` wraps. */
export function sampleMarsGlobalFields(
  dirX: number,
  dirY: number,
  dirZ: number,
  faces: readonly (MarsFaceFields | undefined)[],
): MarsGlobalSample {
  return new MarsGlobalFieldSet(faces).sample(dirX, dirY, dirZ);
}
