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
    return g;
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
    return { vertices: this.vertexCount, indices: this.indexCount, bytes: this.gpuBytes, skinned: this.skinned };
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
