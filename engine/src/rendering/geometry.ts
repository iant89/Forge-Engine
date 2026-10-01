/**
 * `Geometry`: GPU vertex/index buffers plus the CPU-side arrays they were built from.
 *
 * The engine keeps the source arrays alive (`positions`/`normals`/…) because half the subsystems
 * need them: culling wants bounds, physics wants triangles, LOD generation wants to decimate, the
 * editor wants to show a wireframe without a second upload. The cost is RAM we already spent; the
 * benefit is that no subsystem has to read back from the GPU (which is slow or impossible).
 *
 * Vertex layout is fixed (48 bytes, see `VERTEX_STRIDE`) so every pipeline can share one
 * `GPUVertexBufferLayout` and so the debug/depth programs can read a subset by ignoring attributes.
 *
 * A geometry may also carry a **LOD chain** (Phase 14.4): several detail levels of the same shape
 * concatenated into that one vertex/index buffer, described by `lods` (an index window + a distance
 * per level). Concatenation is what makes the level switchable *inside a draw command* — the device
 * culler rewrites the indirect record's index window, so the level is chosen on the GPU with no
 * read-back and no second buffer to rebind. `drawStart`/`drawCount` are the window every existing
 * path (shadow, prepass, direct draw, single-level geometry) uses: level 0.
 */

import { BufferUsage, gpuSource } from "../gpu/constants.js";
import { AABB } from "../math/geometry.js";
import { Vec3 } from "../math/vec.js";
import { UsageError } from "../core/errors.js";
import type { GraphicsDevice } from "../gpu/device.js";

export const VERTEX_STRIDE = 48;

export const VERTEX_ATTRIBUTES = [
  { name: "position", shaderLocation: 0, format: "float32x3" as GPUVertexFormat, offset: 0 },
  { name: "normal", shaderLocation: 1, format: "float32x3" as GPUVertexFormat, offset: 12 },
  { name: "uv", shaderLocation: 2, format: "float32x2" as GPUVertexFormat, offset: 24 },
  { name: "tangent", shaderLocation: 3, format: "float32x4" as GPUVertexFormat, offset: 32 },
];

export const VERTEX_LAYOUT: GPUVertexBufferLayout = {
  arrayStride: VERTEX_STRIDE,
  attributes: VERTEX_ATTRIBUTES.map((a) => ({ format: a.format, offset: a.offset, shaderLocation: a.shaderLocation })),
};

export interface GeometrySource {
  positions: Float32Array;
  normals?: Float32Array | null;
  uvs?: Float32Array | null;
  /** xyzw, w = handedness (±1). */
  tangents?: Float32Array | null;
  indices?: Uint32Array | Uint16Array | null;
  /** Explicit bounds; computed from positions when absent. */
  bounds?: AABB | null;
  label?: string;
}

/**
 * One level of a geometry's LOD chain (Phase 14.4): a draw window into the geometry's *own* index
 * buffer, plus the camera distance from which that window is the one to draw.
 *
 * Every level of a chain lives in the same vertex and index buffer — that is what lets one draw
 * switch levels by changing its index window (`firstIndex`/`indexCount`) instead of rebinding
 * buffers, and therefore what lets the device culler pick the level inside the indirect record it
 * already writes (`rendering/objectCulling.ts`). Indices are global (already offset by the level's
 * vertex base), so `baseVertex` stays 0 and the record's word 3 is unused.
 */
export interface GeometryLodLevel {
  /** First index of this level's window. */
  readonly indexStart: number;
  /** Indices this level draws (a multiple of three). */
  readonly indexCount: number;
  /** Vertices this level occupies — reporting only; the window is index-addressed. */
  readonly vertexCount: number;
  /**
   * Camera distance in metres at which this level takes over from the one before it. Level 0's is
   * always 0; the rest ascend, so "the last level whose `minDistance` is ≤ d" is the selection.
   */
  readonly minDistance: number;
}

/** The chain {@link Geometry.createLodChain} uploads, computed before any GPU object exists. */
export interface GeometryLodSource {
  /** The concatenated source: every level's vertices, then every level's indices. */
  readonly source: GeometrySource;
  /** One window per level, nearest first. */
  readonly lods: readonly GeometryLodLevel[];
}

/** Levels one chain may hold — the device culler's table is built for this many. */
export const MAX_GEOMETRY_LODS = 4;

export class Geometry {
  vertexBuffer: GPUBuffer | null = null;
  indexBuffer: GPUBuffer | null = null;
  indexCount = 0;
  vertexCount = 0;
  indexFormat: GPUIndexFormat | null = null;
  bounds = new AABB();
  topology: GPUPrimitiveTopology = "triangle-list";
  released = false;
  /** Set by `Mesh`/materials when the geometry is used by a skinning pipeline. */
  skinned = false;
  /**
   * LOD chain, nearest first; `null` for a single-level geometry (the overwhelming majority). When
   * present, `indexCount`/`vertexCount` describe the *whole* buffer (all levels) and every draw
   * must go through a window: {@link drawStart}/{@link drawCount} for level 0, or the window of the
   * level the frame selected.
   */
  lods: readonly GeometryLodLevel[] | null = null;
  /** First index of the geometry's primary draw window: level 0's when a chain exists, else 0. */
  drawStart = 0;
  /** Index count of the primary draw window (`vertexCount` for an unindexed geometry). */
  drawCount = 0;

  private constructor(
    readonly device: GraphicsDevice,
    readonly source: GeometrySource,
  ) {}

  /**
   * Build GPU buffers from interleaved-ready source arrays. `normals`/`uvs`/`tangents` are optional:
   * missing channels are zero-filled so the fixed layout still holds (a debug/silhouette geometry
   * then simply ignores them).
   */
  static create(device: GraphicsDevice, src: GeometrySource): Geometry {
    const count = Math.floor(src.positions.length / 3);
    if (count === 0) throw new UsageError("Geometry.create: positions array is empty");
    const g = new Geometry(device, src);
    g.vertexCount = count;
    const interleaved = new Float32Array(count * 12);
    const positions = src.positions;
    const normals = src.normals ?? null;
    const uvs = src.uvs ?? null;
    const tangents = src.tangents ?? null;
    for (let i = 0; i < count; i++) {
      const o = i * 12;
      interleaved[o] = positions[i * 3]!;
      interleaved[o + 1] = positions[i * 3 + 1]!;
      interleaved[o + 2] = positions[i * 3 + 2]!;
      if (normals) {
        interleaved[o + 3] = normals[i * 3]!;
        interleaved[o + 4] = normals[i * 3 + 1]!;
        interleaved[o + 5] = normals[i * 3 + 2]!;
      } else {
        interleaved[o + 5] = 1;
      }
      if (uvs) {
        interleaved[o + 6] = uvs[i * 2]!;
        interleaved[o + 7] = uvs[i * 2 + 1]!;
      }
      if (tangents) {
        interleaved[o + 8] = tangents[i * 4]!;
        interleaved[o + 9] = tangents[i * 4 + 1]!;
        interleaved[o + 10] = tangents[i * 4 + 2]!;
        interleaved[o + 11] = tangents[i * 4 + 3]!;
      }
    }
    if (!normals) {
      // Default +Z normals keep lighting defined for geometries authored without them.
      for (let i = 0; i < count; i++) interleaved[i * 12 + 5] = 1;
    }
    g.bounds = src.bounds ? src.bounds.clone() : computeBounds(positions);
    g.uploadVertices(interleaved);
    if (src.indices && src.indices.length > 0) g.uploadIndices(src.indices);
    g.drawStart = 0;
    g.drawCount = g.indexCount > 0 ? g.indexCount : g.vertexCount;
    return g;
  }

  /**
   * Concatenate LOD sources into one uploadable source plus the chain's windows (Phase 14.4).
   *
   * Pure: no device, no allocation beyond the arrays it returns, and the same inputs always give
   * the same bytes — so a chain can be built in a worker or in a test and compared level by level.
   * Indices become global (each level's are offset by its vertex base), which keeps `baseVertex` at
   * 0 for every window; the index buffer is therefore always `Uint32Array`, whatever the levels
   * were authored as. Bounds are the union of the levels' own, so culling stays conservative when
   * a coarse level's silhouette is not exactly the fine one's.
   */
  static concatenateLods(levels: readonly GeometrySource[], distances: readonly number[]): GeometryLodSource {
    if (levels.length < 2) throw new UsageError("Geometry.concatenateLods: a chain needs at least two levels");
    if (levels.length > MAX_GEOMETRY_LODS) throw new UsageError(`Geometry.concatenateLods: ${levels.length} levels exceeds MAX_GEOMETRY_LODS (${MAX_GEOMETRY_LODS})`);
    if (distances.length !== levels.length - 1) {
      throw new UsageError(`Geometry.concatenateLods: ${levels.length} levels need ${levels.length - 1} distances, got ${distances.length}`);
    }
    let vertexTotal = 0;
    let indexTotal = 0;
    for (let i = 0; i < levels.length; i++) {
      const level = levels[i]!;
      const verts = Math.floor(level.positions.length / 3);
      if (verts === 0) throw new UsageError(`Geometry.concatenateLods: level ${i} has no positions`);
      if (!level.indices || level.indices.length === 0) {
        throw new UsageError(`Geometry.concatenateLods: level ${i} is unindexed — a LOD window is an index range`);
      }
      if (level.indices.length % 3 !== 0) throw new UsageError(`Geometry.concatenateLods: level ${i} has ${level.indices.length} indices (not a multiple of 3)`);
      for (let k = 0; k < level.indices.length; k++) {
        if (level.indices[k]! >= verts) throw new UsageError(`Geometry.concatenateLods: level ${i} index ${level.indices[k]} exceeds its ${verts} vertices`);
      }
      if (i > 0) {
        const d = distances[i - 1]!;
        if (!Number.isFinite(d) || d <= 0) throw new UsageError(`Geometry.concatenateLods: distance ${i} must be a positive number of metres, got ${d}`);
        if (d <= (distances[i - 2] ?? 0)) throw new UsageError(`Geometry.concatenateLods: distances must ascend (${d} follows ${distances[i - 2]})`);
      }
      vertexTotal += verts;
      indexTotal += level.indices.length;
    }

    const positions = new Float32Array(vertexTotal * 3);
    const normals = new Float32Array(vertexTotal * 3);
    const uvs = new Float32Array(vertexTotal * 2);
    const tangents = new Float32Array(vertexTotal * 4);
    const indices = new Uint32Array(indexTotal);
    const lods: GeometryLodLevel[] = [];
    const bounds = new AABB();
    let vertexBase = 0;
    let indexBase = 0;
    for (let i = 0; i < levels.length; i++) {
      const level = levels[i]!;
      const verts = Math.floor(level.positions.length / 3);
      positions.set(level.positions.subarray(0, verts * 3), vertexBase * 3);
      // A level may author fewer channels than another; missing ones get the same defaults
      // `Geometry.create` would have written (+Y normal, zero uv, +x tangent with w = 1).
      if (level.normals) normals.set(level.normals.subarray(0, verts * 3), vertexBase * 3);
      for (let v = 0; v < verts; v++) {
        const o = (vertexBase + v) * 3;
        if (!level.normals) normals[o + 2] = 1;
        if (level.tangents) tangents.set(level.tangents.subarray(v * 4, v * 4 + 4), (vertexBase + v) * 4);
        else {
          // A level authored without tangents gets the fallback the shaders can normalize: +x with
          // a defined handedness. (Zero would leave a normal-mapped material with a degenerate TBN.)
          const t = (vertexBase + v) * 4;
          tangents[t] = 1;
          tangents[t + 3] = 1;
        }
      }
      if (level.uvs) uvs.set(level.uvs.subarray(0, verts * 2), vertexBase * 2);
      const levelIndices = level.indices!;
      for (let k = 0; k < levelIndices.length; k++) indices[indexBase + k] = levelIndices[k]! + vertexBase;
      const levelBounds = level.bounds ? level.bounds : computeBounds(level.positions);
      if (i === 0) bounds.setFrom(levelBounds.min, levelBounds.max);
      else bounds.union(levelBounds);
      lods.push({
        indexStart: indexBase,
        indexCount: levelIndices.length,
        vertexCount: verts,
        minDistance: i === 0 ? 0 : distances[i - 1]!,
      });
      vertexBase += verts;
      indexBase += levelIndices.length;
    }
    return {
      source: { positions, normals, uvs, tangents, indices, bounds, label: `${levels[0]!.label ?? "lod"}+${levels.length}lods` },
      lods,
    };
  }

  /**
   * Upload a LOD chain as one geometry (Phase 14.4). The returned geometry draws level 0 through
   * {@link drawStart}/{@link drawCount} exactly like any other, and `lods` is what the renderer
   * registers with the device culler so the *device* picks the window per frame.
   */
  static createLodChain(device: GraphicsDevice, levels: readonly GeometrySource[], distances: readonly number[]): Geometry {
    const chain = Geometry.concatenateLods(levels, distances);
    const g = Geometry.create(device, chain.source);
    g.lods = chain.lods;
    const first = chain.lods[0]!;
    g.drawStart = first.indexStart;
    g.drawCount = first.indexCount;
    return g;
  }

  /** The draw window of one chain level (level 0 for a single-level geometry). */
  lodWindow(level: number): { indexStart: number; indexCount: number } {
    const lods = this.lods;
    if (!lods) return { indexStart: this.drawStart, indexCount: this.drawCount };
    const clamped = Math.max(0, Math.min(lods.length - 1, Math.floor(level)));
    return { indexStart: lods[clamped]!.indexStart, indexCount: lods[clamped]!.indexCount };
  }

  private uploadVertices(data: Float32Array): void {
    const size = Math.max(4, data.byteLength);
    const buffer = this.device.createBuffer({
      label: `geometry.vertex.${this.source.label ?? ""}`,
      size,
      usage: BufferUsage.VERTEX | BufferUsage.COPY_DST,
      mappedAtCreation: false,
    });
    writeRaw(this.device, buffer, data);
    this.vertexBuffer = buffer;
  }

  private uploadIndices(indices: Uint32Array | Uint16Array): void {
    if (indices instanceof Uint16Array) {
      this.indexFormat = "uint16";
      this.indexCount = indices.length;
    } else {
      this.indexFormat = "uint32";
      this.indexCount = indices.length;
    }
    const bytes = new Uint8Array(indices.buffer.slice(indices.byteOffset, indices.byteOffset + indices.byteLength));
    const padded = Math.ceil(bytes.byteLength / 4) * 4;
    const buffer = this.device.createBuffer({
      label: `geometry.index.${this.source.label ?? ""}`,
      size: Math.max(4, padded),
      usage: BufferUsage.INDEX | BufferUsage.COPY_DST,
    });
    writeRaw(this.device, buffer, bytes);
    this.indexBuffer = buffer;
  }

  get triangleCount(): number {
    if (this.indexCount > 0) return Math.floor(this.indexCount / 3);
    return Math.floor(this.vertexCount / 3);
  }

  /** Bytes held on the GPU by this geometry (used by the memory budget + the leak tests). */
  get gpuBytes(): number {
    return this.vertexCount * VERTEX_STRIDE + (this.indexCount * (this.indexFormat === "uint16" ? 2 : 4));
  }

  /** Replace the position/normal data in place (terrain chunk updates reuse the same buffer). */
  updateFrom(src: GeometrySource): void {
    if (src.positions.length / 3 !== this.vertexCount) {
      this.release();
      const next = Geometry.create(this.device, src);
      this.vertexBuffer = next.vertexBuffer;
      this.indexBuffer = next.indexBuffer;
      this.vertexCount = next.vertexCount;
      this.indexCount = next.indexCount;
      this.indexFormat = next.indexFormat;
      this.drawStart = next.drawStart;
      this.drawCount = next.drawCount;
      // The replacement is a single-level source: a stale chain would point windows into a buffer
      // whose layout nothing remembers, so it goes with the old vertex data.
      this.lods = null;
    } else {
      writeRaw(this.device, this.vertexBuffer!, src.positions);
    }
    Object.assign(this.source, src);
    this.bounds.setFrom(src.bounds?.min ?? this.bounds.min, src.bounds?.max ?? this.bounds.max);
  }

  release(): void {
    if (this.released) return;
    this.released = true;
    this.vertexBuffer?.destroy();
    this.indexBuffer?.destroy();
    this.vertexBuffer = null;
    this.indexBuffer = null;
  }

  dispose(): void {
    this.release();
  }

  stats(): Record<string, number | string | boolean> {
    return {
      vertices: this.vertexCount,
      indices: this.indexCount,
      bytes: this.gpuBytes,
      skinned: this.skinned,
      lods: this.lods ? this.lods.length : 0,
      drawCount: this.drawCount,
    };
  }
}

/**
 * `queue.writeBuffer` wants an `ArrayBufferView` over a plain `ArrayBuffer`; typed arrays in this
 * codebase are always built that way (never on a SharedArrayBuffer), so the cast is a type-level
 * widening, not a lie.
 */
function writeRaw(device: GraphicsDevice, buffer: GPUBuffer, data: ArrayBufferView): void {
  device.device.queue.writeBuffer(buffer, 0, gpuSource(data));
}

function computeBounds(positions: Float32Array): AABB {
  const min = new Vec3(Infinity, Infinity, Infinity);
  const max = new Vec3(-Infinity, -Infinity, -Infinity);
  const count = Math.floor(positions.length / 3);
  for (let i = 0; i < count; i++) {
    const x = positions[i * 3]!;
    const y = positions[i * 3 + 1]!;
    const z = positions[i * 3 + 2]!;
    if (x < min.x) min.x = x;
    if (y < min.y) min.y = y;
    if (z < min.z) min.z = z;
    if (x > max.x) max.x = x;
    if (y > max.y) max.y = y;
    if (z > max.z) max.z = z;
  }
  if (!Number.isFinite(min.x)) return new AABB();
  return new AABB(min, max);
}

/** Compute face normals + tangents for a flat source (used by procedurally generated geometry). */
export function computeNormalsAndTangents(positions: Float32Array, indices: Uint32Array | Uint16Array, uvs: Float32Array): { normals: Float32Array; tangents: Float32Array } {
  const normals = new Float32Array(positions.length);
  const tangents = new Float32Array((positions.length / 3) * 4);
  for (let i = 0; i + 2 < indices.length; i += 3) {
    const i0 = indices[i]!;
    const i1 = indices[i + 1]!;
    const i2 = indices[i + 2]!;
    const ax = positions[i0 * 3]!, ay = positions[i0 * 3 + 1]!, az = positions[i0 * 3 + 2]!;
    const e1x = positions[i1 * 3]! - ax, e1y = positions[i1 * 3 + 1]! - ay, e1z = positions[i1 * 3 + 2]! - az;
    const e2x = positions[i2 * 3]! - ax, e2y = positions[i2 * 3 + 1]! - ay, e2z = positions[i2 * 3 + 2]! - az;
    const nx = e1y * e2z - e1z * e2y;
    const ny = e1z * e2x - e1x * e2z;
    const nz = e1x * e2y - e1y * e2x;
    for (const vi of [i0, i1, i2]) {
      normals[vi * 3] += nx;
      normals[vi * 3 + 1] += ny;
      normals[vi * 3 + 2] += nz;
    }
    // Tangent from UV deltas (Mikkelsen-lite; enough for the engine's tangent-space normal maps).
    const duv1x = uvs[i1 * 2]! - uvs[i0 * 2]!, duv1y = uvs[i1 * 2 + 1]! - uvs[i0 * 2 + 1]!;
    const duv2x = uvs[i2 * 2]! - uvs[i0 * 2]!, duv2y = uvs[i2 * 2 + 1]! - uvs[i0 * 2 + 1]!;
    const denom = duv1x * duv2y - duv2x * duv1y;
    const f = Math.abs(denom) < 1e-8 ? 0 : 1 / denom;
    const tx = f * (duv2y * e1x - duv1y * e2x);
    const ty = f * (duv2y * e1y - duv1y * e2y);
    const tz = f * (duv2y * e1z - duv1y * e2z);
    for (const vi of [i0, i1, i2]) {
      tangents[vi * 4] += tx;
      tangents[vi * 4 + 1] += ty;
      tangents[vi * 4 + 2] += tz;
      tangents[vi * 4 + 3] = 1;
    }
  }
  for (let i = 0; i < normals.length; i += 3) {
    const l = Math.hypot(normals[i]!, normals[i + 1]!, normals[i + 2]!) || 1;
    normals[i] = normals[i]! / l;
    normals[i + 1] = normals[i + 1]! / l;
    normals[i + 2] = normals[i + 2]! / l;
  }
  for (let i = 0; i < tangents.length; i += 4) {
    const l = Math.hypot(tangents[i]!, tangents[i + 1]!, tangents[i + 2]!) || 1;
    tangents[i] = tangents[i]! / l;
    tangents[i + 1] = tangents[i + 1]! / l;
    tangents[i + 2] = tangents[i + 2]! / l;
    if (tangents[i + 3] === 0) tangents[i + 3] = 1;
  }
  return { normals, tangents };
}
