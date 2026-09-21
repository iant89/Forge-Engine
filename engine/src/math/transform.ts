/**
 * Affine transform (position / rotation / scale) and its struct-of-arrays storage.
 *
 * The scene graph keeps transforms in flat typed arrays (`TransformStore`); `TRS` is the
 * object-facing view used by authoring code, the editor and the scripting API.
 *
 * Two invariants keep this fast and predictable:
 *  1. No allocation in the update path — results are written into caller-owned arrays, scratch
 *     objects are module-private.
 *  2. World composition is a single pass ordered by tree depth, so it is O(n) and never depends
 *     on insertion order or on "was this node visited before its parent" luck.
 *
 * Slot 0 is a reserved identity sentinel (never returned by `allocate`), which lets systems use
 * `0` as a null parent and skip bounds checks on the root case.
 */

import { Quat } from "./mat.js";
import { Vec3, type Vec3Ops } from "./vec.js";
import { clamp } from "./scalar.js";

export const LOCAL_STRIDE = 12; // pos(3) pad(1) quat(4) scale(3) pad(1)
export const WORLD_STRIDE = 16; // mat4, column-major

export interface TRSLike {
  readonly position: Vec3;
  readonly rotation: Quat;
  readonly scale: Vec3;
}

export class TRS implements TRSLike {
  readonly position = new Vec3();
  readonly rotation = new Quat();
  readonly scale = new Vec3(1, 1, 1);

  constructor(position?: Vec3Ops, rotation?: Quat, scale?: Vec3Ops) {
    if (position) this.position.copyFrom(position);
    if (rotation) this.rotation.copyFrom(rotation);
    if (scale) this.scale.copyFrom(scale);
  }

  static identity(): TRS {
    return new TRS();
  }

  clone(): TRS {
    return new TRS(this.position.clone(), this.rotation.clone(), this.scale.clone());
  }

  copyFrom(o: TRSLike): this {
    this.position.copyFrom(o.position);
    this.rotation.copyFrom(o.rotation);
    this.scale.copyFrom(o.scale);
    return this;
  }

  setPosition(x: number, y: number, z: number): this {
    this.position.set(x, y, z);
    return this;
  }

  setScale(s: number): this {
    this.scale.set(s, s, s);
    return this;
  }

  setRotationEuler(rx: number, ry: number, rz: number): this {
    this.rotation.setEulerComponents(rx, ry, rz);
    return this;
  }

  setAxisAngle(axis: Vec3Ops, radians: number): this {
    this.rotation.setAxisAngle(axis, radians);
    return this;
  }

  /** this = this ∘ other (apply `other` in this transform's local space). */
  append(other: TRSLike): this {
    const rotated = scratchA();
    this.rotation.rotateVector(other.position, rotated);
    this.position.x += rotated.x * this.scale.x;
    this.position.y += rotated.y * this.scale.y;
    this.position.z += rotated.z * this.scale.z;
    Quat.multiplyInto(this.rotation, other.rotation, this.rotation);
    this.scale.x *= other.scale.x;
    this.scale.y *= other.scale.y;
    this.scale.z *= other.scale.z;
    return this;
  }

  toTRS(out: TRS): TRS {
    return out.copyFrom(this);
  }

  get uniformScale(): number {
    return (this.scale.x + this.scale.y + this.scale.z) / 3;
  }

  isFiniteNumber(): boolean {
    return (
      Number.isFinite(this.position.x) &&
      Number.isFinite(this.position.y) &&
      Number.isFinite(this.position.z) &&
      Number.isFinite(this.scale.x) &&
      Number.isFinite(this.scale.y) &&
      Number.isFinite(this.scale.z) &&
      this.rotation.isFiniteNumber()
    );
  }

  /** Exponential smoothing toward a target (camera rigs, follow constraints). */
  dampToward(target: TRSLike, smoothing: number, dt: number): this {
    const t = clamp(1 - Math.exp(-smoothing * dt), 0, 1);
    this.position.lerp(target.position, t);
    Quat.nlerpInto(this.rotation, target.rotation, t, this.rotation);
    this.scale.lerp(target.scale, t);
    return this;
  }
}

let _a: Vec3 | null = null;
function scratchA(): Vec3 {
  return (_a ??= new Vec3());
}

/**
 * Flat storage for the transforms of a whole scene.
 *
 * - `local`  : per-slot TRS (see LOCAL_STRIDE)
 * - `world`  : per-slot world matrix, column-major, ready to upload to a GPU buffer
 * - `parent` : slot index of the parent, or 0 for none
 * - versions : `localVersion` bumped on write; `worldVersion` / `worldParentVersion` record what
 *   produced the current world matrix so unchanged subtrees are skipped.
 */
export class TransformStore {
  capacity: number;
  local: Float32Array;
  world: Float32Array;
  parent: Int32Array;
  localVersion: Int32Array;
  worldVersion: Int32Array;
  worldParentVersion: Int32Array;
  depth: Int32Array;
  /** slot → owning entity id (the scene fills this; used for reverse lookups and debugging). */
  owner: Int32Array;
  count = 0;
  /** Bumped every `updateWorld` — lets other systems cache "did anything move this frame". */
  epoch = 0;

  private bucketCounts: Int32Array = new Int32Array(32);
  private bucketStarts: Int32Array = new Int32Array(32);
  private sorted: Int32Array = new Int32Array(1024);
  private maxDepth = 0;
  private nextSlot = 1;
  private freeHead = 0;

  constructor(initialCapacity = 256) {
    this.capacity = Math.max(16, initialCapacity);
    this.local = new Float32Array(this.capacity * LOCAL_STRIDE);
    this.world = new Float32Array(this.capacity * WORLD_STRIDE);
    this.parent = new Int32Array(this.capacity);
    this.localVersion = new Int32Array(this.capacity);
    this.worldVersion = new Int32Array(this.capacity);
    this.worldParentVersion = new Int32Array(this.capacity);
    this.depth = new Int32Array(this.capacity);
    this.owner = new Int32Array(this.capacity).fill(-1);
    this.resetSlot(0); // identity sentinel
    for (let i = 0; i < WORLD_STRIDE; i++) this.world[i] = i % 5 === 0 ? 1 : 0;
  }

  private resetSlot(slot: number): void {
    const b = slot * LOCAL_STRIDE;
    const l = this.local;
    l[b] = 0;
    l[b + 1] = 0;
    l[b + 2] = 0;
    l[b + 3] = 0;
    l[b + 4] = 0;
    l[b + 5] = 0;
    l[b + 6] = 0;
    l[b + 7] = 1; // quat identity
    l[b + 8] = 1;
    l[b + 9] = 1;
    l[b + 10] = 1;
    l[b + 11] = 0;
    const w = slot * WORLD_STRIDE;
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 4; j++) this.world[w + i * 4 + j] = i === j ? 1 : 0;
    }
  }

  private grow(): void {
    const cap = this.capacity * 2;
    const copy = <T extends Float32Array | Int32Array>(src: T, stride: number, fill?: number): T => {
      const dst = new (src.constructor as new (len: number) => T)(cap * stride);
      if (fill !== undefined) dst.fill(fill);
      dst.set(src);
      return dst;
    };
    this.local = copy(this.local, LOCAL_STRIDE);
    this.world = copy(this.world, WORLD_STRIDE);
    this.parent = copy(this.parent, 1, 0);
    this.localVersion = copy(this.localVersion, 1);
    this.worldVersion = copy(this.worldVersion, 1);
    this.worldParentVersion = copy(this.worldParentVersion, 1);
    this.depth = copy(this.depth, 1);
    this.owner = copy(this.owner, 1, -1);
    this.capacity = cap;
  }

  allocate(parent = 0, owner = -1): number {
    if (this.freeHead === 0 && this.nextSlot >= this.capacity) this.grow();
    let slot: number;
    if (this.freeHead !== 0) {
      slot = this.freeHead;
      this.freeHead = this.parent[slot]!;
    } else {
      slot = this.nextSlot++;
    }
    this.resetSlot(slot);
    this.parent[slot] = parent;
    this.owner[slot] = owner;
    const depth = parent === 0 ? 0 : Math.min(this.depth[parent]! + 1, 31);
    this.depth[slot] = depth;
    if (depth > this.maxDepth) this.maxDepth = depth;
    this.localVersion[slot] = (this.localVersion[slot] ?? 0) + 1;
    this.worldVersion[slot] = -1;
    this.worldParentVersion[slot] = -1;
    this.count++;
    return slot;
  }

  /**
   * Release a slot. The caller must have already released or reparented children; the
   * `Scene`/`World` ECS does this during entity destruction.
   */
  release(slot: number): void {
    if (slot <= 0 || slot >= this.nextSlot) return;
    if (this.localVersion[slot] === 0) return; // already released
    this.localVersion[slot] = 0;
    this.worldVersion[slot] = -1;
    this.owner[slot] = -1;
    this.parent[slot] = this.freeHead;
    this.freeHead = slot;
    this.count--;
  }

  isAllocated(slot: number): boolean {
    return slot > 0 && slot < this.nextSlot && this.localVersion[slot]! > 0;
  }

  // ------------------------------------------------------------------ writes

  setLocalTRS(slot: number, position: Vec3Ops, rotation: Quat, scale: Vec3Ops): void {
    const b = slot * LOCAL_STRIDE;
    const l = this.local;
    l[b] = position.x;
    l[b + 1] = position.y;
    l[b + 2] = position.z;
    l[b + 4] = rotation.x;
    l[b + 5] = rotation.y;
    l[b + 6] = rotation.z;
    l[b + 7] = rotation.w;
    l[b + 8] = scale.x;
    l[b + 9] = scale.y;
    l[b + 10] = scale.z;
    this.markDirty(slot);
  }

  setPosition(slot: number, x: number, y: number, z: number): void {
    const b = slot * LOCAL_STRIDE;
    const l = this.local;
    if (l[b] === x && l[b + 1] === y && l[b + 2] === z) return;
    l[b] = x;
    l[b + 1] = y;
    l[b + 2] = z;
    this.markDirty(slot);
  }

  setRotation(slot: number, q: Quat): void {
    const b = slot * LOCAL_STRIDE;
    const l = this.local;
    l[b + 4] = q.x;
    l[b + 5] = q.y;
    l[b + 6] = q.z;
    l[b + 7] = q.w;
    this.markDirty(slot);
  }

  setScale(slot: number, x: number, y: number, z: number): void {
    const b = slot * LOCAL_STRIDE;
    const l = this.local;
    if (l[b + 8] === x && l[b + 9] === y && l[b + 10] === z) return;
    l[b + 8] = x;
    l[b + 9] = y;
    l[b + 10] = z;
    this.markDirty(slot);
  }

  /** Re-parent a slot (used by scene attach/detach + editor gizmos). */
  setParent(slot: number, newParent: number): void {
    if (slot <= 0 || this.parent[slot] === newParent) return;
    // Refuse cycles: walk up from newParent.
    let p = newParent;
    let guard = 0;
    while (p !== 0 && guard++ < 64) {
      if (p === slot) throw new Error(`TransformStore: cycle when parenting ${slot} under ${newParent}`);
      p = this.parent[p]!;
    }
    this.parent[slot] = newParent;
    const depth = newParent === 0 ? 0 : Math.min(this.depth[newParent]! + 1, 31);
    this.recomputeDepths(slot, depth);
    this.markDirty(slot);
  }

  private recomputeDepths(slot: number, depth: number): void {
    // Only the moved subtree needs revisiting; children are found by scanning because the
    // store keeps no child lists (a child list would need another array per slot — measured
    // slower for the shallow trees engines actually have, see ADR-005).
    this.depth[slot] = depth;
    this.markDirty(slot);
    for (let s = 1; s < this.nextSlot; s++) {
      if (s !== slot && this.parent[s] === slot) this.recomputeDepths(s, Math.min(depth + 1, 31));
    }
  }

  markDirty(slot: number): void {
    this.localVersion[slot] = (this.localVersion[slot] ?? 0) + 1;
    // Children are not eagerly marked: the depth-ordered pass compares worldVersion and
    // worldParentVersion, which is cheaper than a subtree walk for wide trees.
  }

  // ------------------------------------------------------------------ reads

  getPosition(slot: number, out: Vec3): Vec3 {
    const b = slot * LOCAL_STRIDE;
    out.x = this.local[b]!;
    out.y = this.local[b + 1]!;
    out.z = this.local[b + 2]!;
    return out;
  }

  getRotation(slot: number, out: Quat): Quat {
    const b = slot * LOCAL_STRIDE;
    const l = this.local;
    return out.set(l[b + 4]!, l[b + 5]!, l[b + 6]!, l[b + 7]!);
  }

  getScale(slot: number, out: Vec3): Vec3 {
    const b = slot * LOCAL_STRIDE;
    const l = this.local;
    return out.set(l[b + 8]!, l[b + 9]!, l[b + 10]!);
  }

  getWorldPosition(slot: number, out: Vec3): Vec3 {
    const w = slot * WORLD_STRIDE;
    out.x = this.world[w + 12]!;
    out.y = this.world[w + 13]!;
    out.z = this.world[w + 14]!;
    return out;
  }

  /** Float32Array view of a slot's world matrix, suitable for direct buffer upload. */
  worldView(slot: number): Float32Array {
    const w = slot * WORLD_STRIDE;
    return this.world.subarray(w, w + WORLD_STRIDE);
  }

  writeTRS(slot: number, out: TRS): TRS {
    const b = slot * LOCAL_STRIDE;
    const l = this.local;
    out.position.set(l[b]!, l[b + 1]!, l[b + 2]!);
    out.rotation.set(l[b + 4]!, l[b + 5]!, l[b + 6]!, l[b + 7]!);
    out.scale.set(l[b + 8]!, l[b + 9]!, l[b + 10]!);
    return out;
  }

  // ------------------------------------------------------------------ update

  /**
   * Recompute world matrices depth-first over all slots whose local data or parent world
   * matrix changed. `changedSlots` receives every slot whose world matrix was rewritten.
   *
   * With a static scene this is a version compare per slot (~2ns) and does no matrix math.
   */
  updateWorld(changedSlots: number[], force = false): void {
    // Nothing dirty and no force: skip the whole pass. Static scenes spend ~0 here, which is the
    // point of the version counters (the alternative is a full recompose every frame).
    if (!force && changedSlots.length === 0) return;
    this.epoch++;
    const maxDepth = this.maxDepth;
    if (this.bucketCounts.length <= maxDepth) {
      this.bucketCounts = new Int32Array(maxDepth + 2);
      this.bucketStarts = new Int32Array(maxDepth + 2);
    }
    const counts = this.bucketCounts;
    const starts = this.bucketStarts;
    counts.fill(0, 0, maxDepth + 1);
    for (let slot = 1; slot < this.nextSlot; slot++) {
      if (this.localVersion[slot]! > 0) counts[this.depth[slot]!] = (counts[this.depth[slot]!] ?? 0) + 1;
    }
    let acc = 0;
    for (let d = 0; d <= maxDepth; d++) {
      starts[d] = acc;
      acc += counts[d] ?? 0;
      counts[d] = 0;
    }
    if (this.sorted.length < acc) this.sorted = new Int32Array(Math.max(acc, 1024));
    const sorted = this.sorted;
    for (let slot = 1; slot < this.nextSlot; slot++) {
      if (this.localVersion[slot]! === 0) continue;
      const d = this.depth[slot]!;
      sorted[starts[d]! + (counts[d] ?? 0)] = slot;
      counts[d] = (counts[d] ?? 0) + 1;
    }

    for (let d = 0; d <= maxDepth; d++) {
      const start = starts[d]!;
      const end = start + (counts[d] ?? 0);
      for (let k = start; k < end; k++) {
        const slot = sorted[k]!;
        const parent = this.parent[slot]!;
        const pv = parent === 0 ? 0 : this.worldVersion[parent]!;
        const lv = this.localVersion[slot]!;
        const staleLocal = this.worldVersion[slot] !== lv;
        const staleParent = parent !== 0 && this.worldParentVersion[slot] !== pv;
        if (!force && !staleLocal && !staleParent) continue;

        const w = slot * WORLD_STRIDE;
        this.composeLocalToWorld(slot, w);
        if (parent !== 0) {
          multiplyInto(this.world, parent * WORLD_STRIDE, this.world, w, this.world, w);
        }
        this.worldVersion[slot] = lv;
        this.worldParentVersion[slot] = pv;
        changedSlots.push(slot);
      }
    }
  }

  private composeLocalToWorld(slot: number, w: number): void {
    const b = slot * LOCAL_STRIDE;
    const l = this.local;
    const px = l[b]!;
    const py = l[b + 1]!;
    const pz = l[b + 2]!;
    const qx = l[b + 4]!;
    const qy = l[b + 5]!;
    const qz = l[b + 6]!;
    const qw = l[b + 7]!;
    const sx = l[b + 8]!;
    const sy = l[b + 9]!;
    const sz = l[b + 10]!;
    const x2 = qx + qx;
    const y2 = qy + qy;
    const z2 = qz + qz;
    const xx = qx * x2;
    const xy = qx * y2;
    const xz = qx * z2;
    const yy = qy * y2;
    const yz = qy * z2;
    const zz = qz * z2;
    const wx = qw * x2;
    const wy = qw * y2;
    const wz = qw * z2;
    const m = this.world;
    m[w + 0] = (1 - (yy + zz)) * sx;
    m[w + 1] = (xy + wz) * sx;
    m[w + 2] = (xz - wy) * sx;
    m[w + 3] = 0;
    m[w + 4] = (xy - wz) * sy;
    m[w + 5] = (1 - (xx + zz)) * sy;
    m[w + 6] = (yz + wx) * sy;
    m[w + 7] = 0;
    m[w + 8] = (xz + wy) * sz;
    m[w + 9] = (yz - wx) * sz;
    m[w + 10] = (1 - (xx + yy)) * sz;
    m[w + 11] = 0;
    m[w + 12] = px;
    m[w + 13] = py;
    m[w + 14] = pz;
    m[w + 15] = 1;
  }

  /** Iterate every live slot in allocation order (used by serialization and stats). */
  forEach(fn: (slot: number) => void): void {
    for (let slot = 1; slot < this.nextSlot; slot++) if (this.localVersion[slot]! > 0) fn(slot);
  }

  get allocatedSlots(): number {
    return this.nextSlot;
  }
}

/** dst = a * b, all three living in `buffer` at the given float offsets. */
export function multiplyInto(buffer: Float32Array, aOffset: number, bSource: Float32Array, bOffset: number, dst: Float32Array, dstOffset: number): void {
  // When dst aliases `bSource` (the common self-multiply case) we must not read b after
  // writing dst, so the b column is cached before each write.
  for (let c = 0; c < 4; c++) {
    const b0 = bSource[bOffset + c * 4]!;
    const b1 = bSource[bOffset + c * 4 + 1]!;
    const b2 = bSource[bOffset + c * 4 + 2]!;
    const b3 = bSource[bOffset + c * 4 + 3]!;
    dst[dstOffset + c * 4] = buffer[aOffset]! * b0 + buffer[aOffset + 4]! * b1 + buffer[aOffset + 8]! * b2 + buffer[aOffset + 12]! * b3;
    dst[dstOffset + c * 4 + 1] = buffer[aOffset + 1]! * b0 + buffer[aOffset + 5]! * b1 + buffer[aOffset + 9]! * b2 + buffer[aOffset + 13]! * b3;
    dst[dstOffset + c * 4 + 2] = buffer[aOffset + 2]! * b0 + buffer[aOffset + 6]! * b1 + buffer[aOffset + 10]! * b2 + buffer[aOffset + 14]! * b3;
    dst[dstOffset + c * 4 + 3] = buffer[aOffset + 3]! * b0 + buffer[aOffset + 7]! * b1 + buffer[aOffset + 11]! * b2 + buffer[aOffset + 15]! * b3;
  }
}
