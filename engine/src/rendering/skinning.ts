/**
 * GPU skinning: the joint palette, the per-frame arena that uploads it, and the contract the
 * skinned vertex entry points read.
 *
 * A skinned vertex is placed by `objectData.model × Σ wᵢ · palette[i] · position`, where each
 * palette matrix is
 *
 *     palette[i] = inverse(meshWorld) × jointWorld[i] × inverseBindMatrix[i]
 *
 * The `inverse(meshWorld)` term is what makes the result *mesh-local*: the vertex stage keeps
 * applying the draw's own model matrix (so a skinned mesh behaves like any other `Renderable` —
 * move the entity that draws it and the rig follows, instanced skinned draws still work, and the
 * depth prepass and the colour pass agree because they run the same arithmetic). A joint that is a
 * descendant of the mesh's own entity therefore needs nothing special; a rig rooted elsewhere just
 * has its bind pose expressed in the mesh's local space, which is the contract
 * `SkinBinding.inverseBindMatrices` documents.
 *
 * `animation/skinning.ts` computes the *world-space* `jointWorld × inverseBindMatrix` for the
 * asset/animation layer. The renderer deliberately does not import that module (ARCHITECTURE.md §2
 * puts `rendering` below the animation subsystem), and the renderer's variant differs anyway: it
 * takes a pull callback instead of a `Map` (no per-frame map churn), it cancels the mesh transform,
 * and it never allocates — a rig with 200 joints is 200 multiplies into a pre-reserved slot.
 *
 * Upload shape: one storage buffer holds every skinned batch's palette for the frame, one slot per
 * batch, each slot aligned to `PALETTE_SLOT_ALIGN` (the dynamic-offset alignment WebGPU requires)
 * and `windowBytes` wide (the largest palette this frame). The shader binds it at group 3 with a
 * dynamic offset, so `jointPalette[0]` is this draw's first joint.
 */

import { alignUp } from "../math/scalar.js";
import { Mat4 } from "../math/mat.js";
import { BufferBuilder } from "../gpu/bufferWriter.js";
import { BufferUsage, gpuSource } from "../gpu/constants.js";
import type { GraphicsDevice } from "../gpu/device.js";
import type { EntityId } from "../scene/entityId.js";

/** Bytes per joint in the palette: one column-major `mat4x4<f32>`. */
export const JOINT_PALETTE_BYTES = 64;

/**
 * Alignment of one batch's palette inside the arena. WebGPU requires a dynamic offset to be a
 * multiple of `minStorageBufferOffsetAlignment` (256 in the spec's default limits) and the mock
 * device enforces the same number, so slots are aligned once here rather than at every draw.
 */
export const PALETTE_SLOT_ALIGN = 256;

/** Resolves a joint entity to its world matrix (column-major, 16 floats), or null when it has none. */
export type WorldMatrixLookup = (entity: EntityId) => Float32Array | null;

// Module-level scratch matrices: the palette loop must not allocate per joint per frame, and it
// never yields, so a single set of temporaries cannot be re-entered.
const SCRATCH_WORLD = new Mat4();
const SCRATCH_IBM = new Mat4();
const SCRATCH_PRODUCT = new Mat4();
const SCRATCH_MESH_INVERSE = new Mat4();
const SCRATCH_RELATIVE = new Mat4();

/** Copy 16 floats out of a flat matrix array without materialising a view. */
function copyMatrix(at: number, source: Float32Array, out: Mat4): void {
  const m = out.m;
  for (let i = 0; i < 16; i++) m[i] = source[at + i] ?? 0;
}

/** Write an identity matrix into `output` at float offset `at`. */
function writeIdentity(output: Float32Array, at: number): void {
  output.fill(0, at, at + 16);
  output[at] = 1;
  output[at + 5] = 1;
  output[at + 10] = 1;
  output[at + 15] = 1;
}

/**
 * Fill `output` with this mesh's joint palette.
 *
 * @param jointEntities       The skin's joints, in the order the GPU's vertex attributes index them.
 * @param inverseBindMatrices 16 floats per joint, in the mesh's bind-pose local space.
 * @param worldMatrixOf       World matrix for a joint entity (null = no transform: identity, so a
 *                            joint the scene dropped cannot explode the mesh).
 * @param output              Destination: `jointEntities.length × 16` floats, written in place.
 * @param meshWorldInverse    `inverse(meshWorld)` when the palette must be mesh-local (what the
 *                            renderer passes); `null` keeps the palette in world space.
 * @returns The number of joints written (0 when the inputs are degenerate).
 */
export function fillJointPalette(
  jointEntities: readonly EntityId[],
  inverseBindMatrices: Float32Array,
  worldMatrixOf: WorldMatrixLookup,
  output: Float32Array,
  meshWorldInverse: Float32Array | null = null,
): number {
  const jointCount = jointEntities.length;
  if (jointCount === 0) return 0;
  if (output.length < jointCount * 16) return 0;
  if (meshWorldInverse !== null) copyMatrix(0, meshWorldInverse, SCRATCH_MESH_INVERSE);

  for (let i = 0; i < jointCount; i++) {
    const at = i * 16;
    // Truncated inverse-bind data is treated like a missing joint: identity, not NaN.
    if (at + 16 > inverseBindMatrices.length) {
      writeIdentity(output, at);
      continue;
    }
    const world = worldMatrixOf(jointEntities[i]!);
    if (!world) {
      writeIdentity(output, at);
      continue;
    }
    copyMatrix(0, world, SCRATCH_WORLD);
    copyMatrix(at, inverseBindMatrices, SCRATCH_IBM);
    SCRATCH_PRODUCT.multiplyMatrices(SCRATCH_WORLD, SCRATCH_IBM);
    if (meshWorldInverse !== null) {
      SCRATCH_RELATIVE.multiplyMatrices(SCRATCH_MESH_INVERSE, SCRATCH_PRODUCT);
      output.set(SCRATCH_RELATIVE.m, at);
    } else {
      output.set(SCRATCH_PRODUCT.m, at);
    }
  }
  return jointCount;
}

/**
 * A frame's worth of joint palettes in one storage buffer.
 *
 * Usage per frame: `begin()`, one `reserve(jointCount)` + `fillJointPalette(...)` per skinned batch
 * (in the order the batches are drawn), then `flush()` once — the upload is a single
 * `writeBuffer`, and a frame with no skinned batches touches the device not at all.
 *
 * The device buffer is sized `usedBytes + windowBytes` so that every slot's dynamic offset still
 * leaves a whole `windowBytes` window inside the buffer, which is exactly the WebGPU rule for a
 * dynamic-offset binding of that size.
 */
export class JointPaletteArena {
  /** CPU staging buffer; the palettes are written here and uploaded in one call. */
  private readonly builder = new BufferBuilder(16 * 1024);
  private capacityBytes = 0;
  private window = 0;
  private maxJointCount = 0;
  private uploadCount = 0;
  private jointTotal = 0;

  buffer: GPUBuffer | null = null;

  constructor(
    readonly device: GraphicsDevice,
    readonly label = "skin.palettes",
  ) {}

  /** Palette stride for the frame in progress, in bytes (0 until the first skinned batch). */
  get windowBytes(): number {
    return this.window;
  }

  /** Largest palette this frame, in joints. */
  get maxJoints(): number {
    return this.maxJointCount;
  }

  get usedBytes(): number {
    return this.builder.usedBytes;
  }

  /** `writeBuffer` calls this arena has issued (one per frame with skinned batches). */
  get uploads(): number {
    return this.uploadCount;
  }

  /** Joint matrices uploaded since the arena was created (joints summed over every batch). */
  get jointsUploaded(): number {
    return this.jointTotal;
  }

  /** Reset the frame cursor. The device buffer and its contents stay where they are. */
  begin(): void {
    this.builder.reset();
    this.window = 0;
    this.maxJointCount = 0;
  }

  /**
   * Reserve a slot for `jointCount` joints and return its byte offset. Slots are
   * `PALETTE_SLOT_ALIGN`-aligned, so the returned offset is a legal dynamic offset. The slot is
   * `windowBytes` wide once the frame's largest palette is known; with dynamic offsets the binding
   * window is the same for every draw, and a smaller palette simply does not reach the end of it.
   */
  reserve(jointCount: number): number {
    if (jointCount > this.maxJointCount) {
      this.maxJointCount = jointCount;
      this.window = alignUp(jointCount * JOINT_PALETTE_BYTES, PALETTE_SLOT_ALIGN);
    }
    this.jointTotal += jointCount;
    return this.builder.reserve(Math.max(1, jointCount) * JOINT_PALETTE_BYTES, PALETTE_SLOT_ALIGN);
  }

  /**
   * Float view of a reserved slot, to be handed straight to `fillJointPalette`. Transient: it is
   * valid until the next `reserve` (a growth moves the staging buffer), which is why the renderer
   * fills each slot as it reserves it.
   */
  paletteView(offset: number, jointCount: number): Float32Array {
    const start = offset >> 2;
    return this.builder.target.f32.subarray(start, start + Math.max(1, jointCount) * 16);
  }

  /** Upload this frame's palettes, growing the device buffer when the frame outgrew it. */
  flush(): void {
    const bytes = this.builder.written();
    if (bytes.length === 0) return;
    const need = alignUp(bytes.length + this.window, PALETTE_SLOT_ALIGN);
    if (need > this.capacityBytes || !this.buffer) {
      this.buffer?.destroy();
      this.buffer = this.device.device.createBuffer({
        label: this.label,
        size: Math.max(need, 16 * 1024),
        usage: BufferUsage.STORAGE | BufferUsage.COPY_DST,
      });
      this.capacityBytes = this.buffer.size;
    }
    this.device.device.queue.writeBuffer(this.buffer, 0, gpuSource(bytes));
    this.uploadCount++;
  }

  release(): void {
    this.buffer?.destroy();
    this.buffer = null;
    this.capacityBytes = 0;
    this.window = 0;
    this.maxJointCount = 0;
    this.builder.reset();
  }

  dispose(): void {
    this.release();
  }

  stats(): Record<string, number | boolean> {
    return {
      skinPaletteUploads: this.uploadCount,
      skinJointsUploaded: this.jointTotal,
      skinPaletteBytes: this.usedBytes,
      skinPaletteWindow: this.window,
    };
  }
}

/**
 * Per-joint bind boxes for posed culling bounds: for each joint, the AABB of `IBM[j] × p` over every
 * vertex with a non-zero weight on that joint (6 floats per joint: min xyz, max xyz; a joint that
 * influences nothing stays empty, +∞/−∞). Computed once per mesh.
 *
 * Why this bounds the posed mesh: a skinned vertex is `Σ wᵢ · jointWorldᵢ · IBMᵢ · p` with `wᵢ ≥ 0`
 * summing to 1 (the shader normalises), and each term `jointWorldᵢ · IBMᵢ · p` lies inside joint
 * `i`'s box carried by `jointWorldᵢ`. A convex combination of points in those boxes lies in their
 * convex hull, hence in the AABB of their union — whatever the skeleton does, including translating
 * far from the bind pose.
 */
export function computeJointBounds(
  positions: Float32Array,
  joints: Uint16Array | Uint32Array,
  weights: Float32Array,
  inverseBindMatrices: Float32Array,
  jointCount: number,
): Float32Array {
  const out = new Float32Array(jointCount * 6);
  for (let j = 0; j < jointCount; j++) {
    out.fill(Infinity, j * 6, j * 6 + 3);
    out.fill(-Infinity, j * 6 + 3, j * 6 + 6);
  }
  const vertexCount = Math.min(positions.length / 3, joints.length / 4, weights.length / 4);
  for (let v = 0; v < vertexCount; v++) {
    const x = positions[v * 3]!, y = positions[v * 3 + 1]!, z = positions[v * 3 + 2]!;
    for (let k = 0; k < 4; k++) {
      if (!(weights[v * 4 + k]! > 0)) continue;
      const j = joints[v * 4 + k]!;
      if (j >= jointCount || (j + 1) * 16 > inverseBindMatrices.length) continue;
      const m = j * 16;
      const o = j * 6;
      for (let r = 0; r < 3; r++) {
        const value = inverseBindMatrices[m + r]! * x + inverseBindMatrices[m + 4 + r]! * y + inverseBindMatrices[m + 8 + r]! * z + inverseBindMatrices[m + 12 + r]!;
        if (value < out[o + r]!) out[o + r] = value;
        if (value > out[o + 3 + r]!) out[o + 3 + r] = value;
      }
    }
  }
  return out;
}

/**
 * This frame's world-space bounds of a skinned mesh: the union of each joint's bind box
 * (`computeJointBounds`) carried by that joint's live world matrix. Allocation-free; 3 × 3 abs
 * products per joint. Returns false (and leaves `out` cleared) when no joint has a box or a world
 * matrix, so the caller can fall back to the static bounds.
 */
export function posedSkinBounds(
  jointBounds: Float32Array,
  jointEntities: readonly EntityId[],
  worldMatrixOf: WorldMatrixLookup,
  out: { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } },
): boolean {
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  const count = Math.min(jointEntities.length, jointBounds.length / 6);
  for (let j = 0; j < count; j++) {
    const o = j * 6;
    const bx0 = jointBounds[o]!, by0 = jointBounds[o + 1]!, bz0 = jointBounds[o + 2]!;
    const bx1 = jointBounds[o + 3]!, by1 = jointBounds[o + 4]!, bz1 = jointBounds[o + 5]!;
    if (!(bx0 <= bx1)) continue;
    const m = worldMatrixOf(jointEntities[j]!);
    if (!m) continue;
    const cx = (bx0 + bx1) / 2, cy = (by0 + by1) / 2, cz = (bz0 + bz1) / 2;
    const ex = (bx1 - bx0) / 2, ey = (by1 - by0) / 2, ez = (bz1 - bz0) / 2;
    const wx = m[0]! * cx + m[4]! * cy + m[8]! * cz + m[12]!;
    const wy = m[1]! * cx + m[5]! * cy + m[9]! * cz + m[13]!;
    const wz = m[2]! * cx + m[6]! * cy + m[10]! * cz + m[14]!;
    const rx = Math.abs(m[0]!) * ex + Math.abs(m[4]!) * ey + Math.abs(m[8]!) * ez;
    const ry = Math.abs(m[1]!) * ex + Math.abs(m[5]!) * ey + Math.abs(m[9]!) * ez;
    const rz = Math.abs(m[2]!) * ex + Math.abs(m[6]!) * ey + Math.abs(m[10]!) * ez;
    if (wx - rx < minX) minX = wx - rx;
    if (wy - ry < minY) minY = wy - ry;
    if (wz - rz < minZ) minZ = wz - rz;
    if (wx + rx > maxX) maxX = wx + rx;
    if (wy + ry > maxY) maxY = wy + ry;
    if (wz + rz > maxZ) maxZ = wz + rz;
  }
  out.min.x = minX; out.min.y = minY; out.min.z = minZ;
  out.max.x = maxX; out.max.y = maxY; out.max.z = maxZ;
  return minX <= maxX;
}
