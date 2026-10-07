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
 */

import { BufferUsage, gpuSource } from "../gpu/constants.js";
import { AABB, Frustum, Ray, RayHit } from "../math/geometry.js";
import { Mat4 } from "../math/mat.js";
import { MeshBvh } from "../math/bvh.js";
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

/** Joints that can influence one vertex (glTF 2.0's `JOINTS_0`/`WEIGHTS_0` set). */
export const SKIN_JOINTS_PER_VERTEX = 4;

/**
 * Skinning vertex stream: `SKIN_JOINTS_PER_VERTEX` joint indices then weights per vertex.
 *
 * It is a *second* vertex buffer slot rather than four more floats in the fixed 48-byte record,
 * for three reasons: a mesh without a skin keeps paying 48 bytes per vertex (most of them do),
 * skinning data is optional per draw (`Mesh.skin`), and the depth/shadow pipelines can then share
 * one `VERTEX_LAYOUT` while the skinned entries add theirs. Indices are `u32` here (they are
 * `u16` in `SkinningVertexData`, which is the asset-side form) because `uint32x4` needs no
 * zero-extension rule to reason about and the cost is 8 bytes per vertex.
 */
export const SKIN_VERTEX_STRIDE = 32;

export const SKIN_VERTEX_ATTRIBUTES = [
  { name: "joints", shaderLocation: 4, format: "uint32x4" as GPUVertexFormat, offset: 0 },
  { name: "weights", shaderLocation: 5, format: "float32x4" as GPUVertexFormat, offset: 16 },
];

export const SKIN_VERTEX_LAYOUT: GPUVertexBufferLayout = {
  arrayStride: SKIN_VERTEX_STRIDE,
  attributes: SKIN_VERTEX_ATTRIBUTES.map((a) => ({ format: a.format, offset: a.offset, shaderLocation: a.shaderLocation })),
};

/** Per-vertex skinning attributes, as the asset pipeline hands them to `Geometry`. */
export interface SkinVertexStream {
  /** `SKIN_JOINTS_PER_VERTEX` joint indices per vertex, indexing the skin's joint list. */
  joints: Uint16Array | Uint32Array;
  /** `SKIN_JOINTS_PER_VERTEX` blend weights per vertex; they are expected to sum to 1. */
  weights: Float32Array;
}

export interface GeometrySource {
  positions: Float32Array;
  normals?: Float32Array | null;
  uvs?: Float32Array | null;
  /** xyzw, w = handedness (±1). */
  tangents?: Float32Array | null;
  /** Optional per-vertex skin attributes; they upload as `SKIN_VERTEX_LAYOUT` (slot 1). */
  skinning?: SkinVertexStream | null;
  indices?: Uint32Array | Uint16Array | null;
  /** Explicit bounds; computed from positions when absent. */
  bounds?: AABB | null;
  label?: string;
}

export class Geometry {
  vertexBuffer: GPUBuffer | null = null;
  indexBuffer: GPUBuffer | null = null;
  /** `SKIN_VERTEX_LAYOUT` stream (slot 1); null for an unskinned geometry. */
  skinBuffer: GPUBuffer | null = null;
  indexCount = 0;
  vertexCount = 0;
  indexFormat: GPUIndexFormat | null = null;
  bounds = new AABB();
  topology: GPUPrimitiveTopology = "triangle-list";
  released = false;

  private spatialIndex: MeshBvh | null | undefined;
  private readonly localRay = new Ray();
  private readonly localRayHit = new RayHit();
  private readonly inverseWorld = new Mat4();
  private readonly localOrigin = new Vec3();
  private readonly localDirection = new Vec3();
  private readonly worldPoint = new Vec3();
  private readonly worldNormal = new Vec3();

  private constructor(
    readonly device: GraphicsDevice,
    readonly source: GeometrySource,
  ) {}

  /**
   * Build GPU buffers from source attribute arrays. Missing normals default to +Z; missing UVs and
   * tangents are zero-filled so the fixed vertex layout always has a complete record.
   */
  static create(device: GraphicsDevice, src: GeometrySource): Geometry {
    const count = Math.floor(src.positions.length / 3);
    if (count === 0) throw new UsageError("Geometry.create: positions array is empty");
    const g = new Geometry(device, src);
    g.vertexCount = count;
    const interleaved = interleaveVertices(src, count);
    g.bounds = src.bounds ? src.bounds.clone() : computeBounds(src.positions);
    try {
      g.uploadVertices(interleaved);
      if (src.skinning) g.uploadSkinning(src.skinning);
      if (src.indices && src.indices.length > 0) g.uploadIndices(src.indices);
      return g;
    } catch (error) {
      g.release();
      throw error;
    }
  }

  /** True when this geometry carries a skin vertex stream (a skinned pipeline can draw it). */
  get skinned(): boolean {
    return this.skinBuffer !== null;
  }

  private uploadVertices(data: Float32Array): void {
    const size = Math.max(4, data.byteLength);
    const buffer = this.device.createBuffer({
      label: `geometry.vertex.${this.source.label ?? ""}`,
      size,
      usage: BufferUsage.VERTEX | BufferUsage.COPY_DST,
      mappedAtCreation: false,
    });
    try {
      writeRaw(this.device, buffer, data);
      this.vertexBuffer = buffer;
    } catch (error) {
      buffer.destroy();
      throw error;
    }
  }

  private createIndexResource(
    indices: Uint32Array | Uint16Array,
    label = this.source.label,
  ): { buffer: GPUBuffer; count: number; format: GPUIndexFormat } {
    const format: GPUIndexFormat = indices instanceof Uint16Array ? "uint16" : "uint32";
    const bytes = new Uint8Array(indices.buffer.slice(indices.byteOffset, indices.byteOffset + indices.byteLength));
    const padded = Math.ceil(bytes.byteLength / 4) * 4;
    const buffer = this.device.createBuffer({
      label: `geometry.index.${label ?? ""}`,
      size: Math.max(4, padded),
      usage: BufferUsage.INDEX | BufferUsage.COPY_DST,
    });
    try {
      writeRaw(this.device, buffer, bytes);
      return { buffer, count: indices.length, format };
    } catch (error) {
      buffer.destroy();
      throw error;
    }
  }

  private uploadIndices(indices: Uint32Array | Uint16Array): void {
    const next = this.createIndexResource(indices);
    this.indexBuffer = next.buffer;
    this.indexCount = next.count;
    this.indexFormat = next.format;
  }

  /**
   * Upload (or replace) the per-vertex skinning attributes. The stream is indexed by the same
   * vertex order as `positions`, so a mismatched length is an authoring error, not something to
   * pad: the skinned vertex stage would read another vertex's joints.
   */
  uploadSkinning(data: SkinVertexStream): void {
    const expected = this.vertexCount * SKIN_JOINTS_PER_VERTEX;
    if (data.joints.length !== expected || data.weights.length !== expected) {
      throw new UsageError(
        `Geometry.uploadSkinning: expected ${expected} joint indices and ${expected} weights for ${this.vertexCount} vertices, got ${data.joints.length} and ${data.weights.length}`,
      );
    }
    const size = Math.max(4, this.vertexCount * SKIN_VERTEX_STRIDE);
    const buffer = this.device.createBuffer({
      label: `geometry.skin.${this.source.label ?? ""}`,
      size,
      usage: BufferUsage.VERTEX | BufferUsage.COPY_DST,
    });
    try {
      const interleaved = interleaveSkinVertices(data, this.vertexCount);
      writeRaw(this.device, buffer, interleaved);
    } catch (error) {
      buffer.destroy();
      throw error;
    }
    this.skinBuffer?.destroy();
    this.skinBuffer = buffer;
    this.source.skinning = data;
  }

  /** Drop the skin vertex stream (the geometry becomes drawable only by unskinned pipelines). */
  clearSkinning(): void {
    this.skinBuffer?.destroy();
    this.skinBuffer = null;
    this.source.skinning = null;
  }

  get triangleCount(): number {
    if (this.indexCount > 0) return Math.floor(this.indexCount / 3);
    return Math.floor(this.vertexCount / 3);
  }

  /**
   * Lazily build the CPU spatial index used for picking and mesh-frustum queries. Source arrays are
   * retained by Geometry, so the cache is invalidated by `updateFrom`; callers should replace data
   * through that method rather than mutating a source array behind the GPU's back.
   */
  getMeshBvh(): MeshBvh | null {
    if (this.spatialIndex !== undefined) return this.spatialIndex;
    const triangles = this.triangleCount;
    if (triangles < 1) {
      this.spatialIndex = null;
      return null;
    }
    const usedIndexCount = triangles * 3;
    const sourceIndices = this.source.indices;
    let indices: Uint32Array;
    if (sourceIndices && sourceIndices.length > 0) {
      const used = sourceIndices.subarray(0, usedIndexCount);
      indices = used instanceof Uint32Array ? used : Uint32Array.from(used);
    } else {
      indices = new Uint32Array(usedIndexCount);
      for (let i = 0; i < usedIndexCount; i++) indices[i] = i;
    }
    this.spatialIndex = MeshBvh.build(this.source.positions, indices);
    return this.spatialIndex;
  }

  /**
   * Conservative mesh-aware frustum test. The ordinary world AABB remains the fast first test;
   * this hierarchical refinement avoids retaining sparse, large meshes whose overall bound overlaps
   * the camera while all triangle leaves lie outside it. Tiny meshes keep the cheaper AABB path.
   */
  intersectsFrustum(frustum: Frustum, localToWorld: Mat4): boolean {
    if (this.triangleCount < 16) return true;
    return this.getMeshBvh()?.intersectsFrustum(frustum, localToWorld) ?? true;
  }

  /**
   * Raycast actual triangles in world space using the local-space BVH. `localToWorld` may include
   * non-uniform or negative scale; distance and normals are converted back to the world ray.
   */
  raycast(ray: Ray, localToWorld: Mat4, out: RayHit): boolean {
    out.reset();
    const bvh = this.getMeshBvh();
    if (!bvh) return false;
    const inverse = this.inverseWorld.copyFrom(localToWorld);
    if (!inverse.invert()) return false;
    inverse.transformPoint(ray.origin, this.localOrigin);
    inverse.transformDirection(ray.direction, this.localDirection);
    const localDirectionScale = Math.hypot(this.localDirection.x, this.localDirection.y, this.localDirection.z);
    if (!(localDirectionScale > 1e-12) || !Number.isFinite(localDirectionScale)) return false;
    this.localRay.setFrom(this.localOrigin, this.localDirection, ray.maxDistance * localDirectionScale);
    if (!bvh.raycast(this.localRay, this.localRayHit)) return false;

    localToWorld.transformPoint(this.localRayHit.point, this.worldPoint);
    const dx = this.worldPoint.x - ray.origin.x;
    const dy = this.worldPoint.y - ray.origin.y;
    const dz = this.worldPoint.z - ray.origin.z;
    const distance = dx * ray.direction.x + dy * ray.direction.y + dz * ray.direction.z;
    if (distance < 0 || distance > ray.maxDistance) return false;

    // Normals transform by inverse transpose; a reflection also flips the original winding.
    inverse.transpose().transformDirection(this.localRayHit.normal, this.worldNormal).normalize();
    if (localToWorld.determinant() < 0) this.worldNormal.negate();
    out.distance = distance;
    out.point.copyFrom(this.worldPoint);
    out.normal.copyFrom(this.worldNormal);
    out.index = this.localRayHit.index;
    out.isValid = true;
    return true;
  }

  /** Bytes held on the GPU by this geometry (used by the memory budget + the leak tests). */
  get gpuBytes(): number {
    return this.vertexCount * VERTEX_STRIDE
      + (this.skinBuffer ? this.vertexCount * SKIN_VERTEX_STRIDE : 0)
      + (this.indexCount * (this.indexFormat === "uint16" ? 2 : 4));
  }

  /** Replace geometry streams, reusing vertex storage when its size is unchanged. */
  updateFrom(src: GeometrySource): void {
    const count = Math.floor(src.positions.length / 3);
    const sameVertexCount = count === this.vertexCount;
    const rebuild = this.released || !this.vertexBuffer || !sameVertexCount;
    const has = (key: keyof GeometrySource): boolean => Object.prototype.hasOwnProperty.call(src, key);
    const nextSource: GeometrySource = {
      ...this.source,
      ...src,
      normals: has("normals") ? src.normals ?? null : sameVertexCount ? this.source.normals ?? null : null,
      uvs: has("uvs") ? src.uvs ?? null : sameVertexCount ? this.source.uvs ?? null : null,
      tangents: has("tangents") ? src.tangents ?? null : sameVertexCount ? this.source.tangents ?? null : null,
      skinning: has("skinning") ? src.skinning ?? null : sameVertexCount ? this.source.skinning ?? null : null,
      indices: has("indices") ? src.indices ?? null : sameVertexCount ? this.source.indices ?? null : null,
      bounds: src.bounds ?? null,
      label: src.label ?? this.source.label,
    };

    if (rebuild) {
      const next = Geometry.create(this.device, nextSource);
      this.release();
      this.vertexBuffer = next.vertexBuffer;
      this.indexBuffer = next.indexBuffer;
      this.skinBuffer = next.skinBuffer;
      this.vertexCount = next.vertexCount;
      this.indexCount = next.indexCount;
      this.indexFormat = next.indexFormat;
      this.bounds.setFrom(next.bounds.min, next.bounds.max);
      this.released = false;
      next.vertexBuffer = null;
      next.indexBuffer = null;
      next.skinBuffer = null;
      next.released = true;
    } else {
      const indicesChanged = has("indices");
      if (has("skinning")) {
        if (nextSource.skinning) this.uploadSkinning(nextSource.skinning);
        else this.clearSkinning();
      }
      const interleaved = interleaveVertices(nextSource, count);
      const replacement = indicesChanged && nextSource.indices && nextSource.indices.length > 0
        ? this.createIndexResource(nextSource.indices, nextSource.label)
        : null;
      try {
        writeRaw(this.device, this.vertexBuffer!, interleaved);
      } catch (error) {
        replacement?.buffer.destroy();
        throw error;
      }
      if (indicesChanged) {
        const previous = this.indexBuffer;
        this.indexBuffer = replacement?.buffer ?? null;
        this.indexCount = replacement?.count ?? 0;
        this.indexFormat = replacement?.format ?? null;
        previous?.destroy();
      }
      Object.assign(this.source, nextSource);
      const bounds = nextSource.bounds ? nextSource.bounds : computeBounds(nextSource.positions);
      this.bounds.setFrom(bounds.min, bounds.max);
    }
    Object.assign(this.source, nextSource);
    this.spatialIndex = undefined;
  }

  release(): void {
    if (this.released) return;
    this.released = true;
    this.vertexBuffer?.destroy();
    this.indexBuffer?.destroy();
    this.skinBuffer?.destroy();
    this.vertexBuffer = null;
    this.indexBuffer = null;
    this.skinBuffer = null;
    this.spatialIndex = undefined;
  }

  dispose(): void {
    this.release();
  }

  stats(): Record<string, number | string | boolean> {
    return { vertices: this.vertexCount, indices: this.indexCount, bytes: this.gpuBytes, skinned: this.skinned };
  }
}

/**
 * Pack the skin attributes into one `SKIN_VERTEX_STRIDE`-byte record per vertex: four `u32` joint
 * indices then four `f32` weights, both views over the same buffer so there is no second copy.
 */
function interleaveSkinVertices(src: SkinVertexStream, count: number): Uint8Array {
  const buffer = new ArrayBuffer(count * SKIN_VERTEX_STRIDE);
  const u32 = new Uint32Array(buffer);
  const f32 = new Float32Array(buffer);
  const joints = src.joints;
  const weights = src.weights;
  for (let i = 0; i < count; i++) {
    const base = (i * SKIN_VERTEX_STRIDE) >> 2;
    const at = i * SKIN_JOINTS_PER_VERTEX;
    for (let j = 0; j < SKIN_JOINTS_PER_VERTEX; j++) {
      u32[base + j] = joints[at + j] ?? 0;
      f32[base + SKIN_JOINTS_PER_VERTEX + j] = weights[at + j] ?? 0;
    }
  }
  return new Uint8Array(buffer);
}

function interleaveVertices(src: GeometrySource, count: number): Float32Array {
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
      // Default +Z normals keep lighting defined for geometries authored without them.
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
  return interleaved;
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
