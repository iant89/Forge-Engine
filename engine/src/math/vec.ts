/**
 * 2D/3D/4D vector types.
 *
 * Conventions:
 * - Left-handed, +Y up, row-major matrices with column vectors (`v' = M * v` where the basis
 *   vectors are stored in `m[0..2]`, `m[4..6]`, `m[8..10]`). This matches WebGPU WGSL's
 *   `mat4x4` memory layout, so a `Mat4`'s backing `Float32Array` can be uploaded unchanged.
 * - Every operation has an allocation-free `*Into` form. The instance form returns `this` for
 *   chaining and is reserved for authoring/tool code; hot systems (ECS, physics) call the
 *   static `Into` forms with pre-allocated scratch.
 * - Zero allocations per frame is a hard rule for simulation code (see PERFORMANCE.md).
 */

import { clamp, EPSILON } from "./scalar.js";

export interface Vec2Like {
  x: number;
  y: number;
}

export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

export class Vec2 {
  constructor(public x = 0, public y = 0) {}

  static of(x = 0, y = 0): Vec2 {
    return new Vec2(x, y);
  }

  clone(): Vec2 {
    return new Vec2(this.x, this.y);
  }

  set(x: number, y: number): this {
    this.x = x;
    this.y = y;
    return this;
  }

  copyFrom(v: Vec2Like): this {
    this.x = v.x;
    this.y = v.y;
    return this;
  }

  add(v: Vec2Like): this {
    this.x += v.x;
    this.y += v.y;
    return this;
  }

  sub(v: Vec2Like): this {
    this.x -= v.x;
    this.y -= v.y;
    return this;
  }

  scale(s: number): this {
    this.x *= s;
    this.y *= s;
    return this;
  }

  lengthSq(): number {
    return this.x * this.x + this.y * this.y;
  }

  length(): number {
    return Math.sqrt(this.lengthSq());
  }

  normalize(): this {
    const l = this.length();
    if (l > EPSILON) {
      this.x /= l;
      this.y /= l;
    }
    return this;
  }

  dot(v: Vec2Like): number {
    return this.x * v.x + this.y * v.y;
  }

  /** Z component of the 3D cross product (2D pseudo-cross / signed area ×2). */
  cross(v: Vec2Like): number {
    return this.x * v.y - this.y * v.x;
  }

  distanceTo(v: Vec2Like): number {
    const dx = this.x - v.x;
    const dy = this.y - v.y;
    return Math.sqrt(dx * dx + dy * dy);
  }

  equals(v: Vec2Like, epsilon = 0): boolean {
    return Math.abs(this.x - v.x) <= epsilon && Math.abs(this.y - v.y) <= epsilon;
  }

  toArray(): [number, number] {
    return [this.x, this.y];
  }
}

export interface Vec3Ops {
  x: number;
  y: number;
  z: number;
}

export class Vec3 {
  constructor(public x = 0, public y = 0, public z = 0) {}

  static readonly zero = Object.freeze(new Vec3(0, 0, 0));
  static readonly one = Object.freeze(new Vec3(1, 1, 1));
  static readonly unitX = Object.freeze(new Vec3(1, 0, 0));
  static readonly unitY = Object.freeze(new Vec3(0, 1, 0));
  static readonly unitZ = Object.freeze(new Vec3(0, 0, 1));
  static readonly up = Vec3.unitY;

  static of(x = 0, y = 0, z = 0): Vec3 {
    return new Vec3(x, y, z);
  }

  clone(): Vec3 {
    return new Vec3(this.x, this.y, this.z);
  }

  set(x: number, y: number, z: number): this {
    this.x = x;
    this.y = y;
    this.z = z;
    return this;
  }

  setScalar(s: number): this {
    this.x = this.y = this.z = s;
    return this;
  }

  copyFrom(v: Vec3Ops): this {
    this.x = v.x;
    this.y = v.y;
    this.z = v.z;
    return this;
  }

  add(v: Vec3Ops): this {
    this.x += v.x;
    this.y += v.y;
    this.z += v.z;
    return this;
  }

  addScaled(v: Vec3Ops, s: number): this {
    this.x += v.x * s;
    this.y += v.y * s;
    this.z += v.z * s;
    return this;
  }

  sub(v: Vec3Ops): this {
    this.x -= v.x;
    this.y -= v.y;
    this.z -= v.z;
    return this;
  }

  mul(v: Vec3Ops): this {
    this.x *= v.x;
    this.y *= v.y;
    this.z *= v.z;
    return this;
  }

  scale(s: number): this {
    this.x *= s;
    this.y *= s;
    this.z *= s;
    return this;
  }

  negate(): this {
    this.x = -this.x;
    this.y = -this.y;
    this.z = -this.z;
    return this;
  }

  lengthSq(): number {
    return this.x * this.x + this.y * this.y + this.z * this.z;
  }

  length(): number {
    return Math.sqrt(this.lengthSq());
  }

  distanceTo(v: Vec3Ops): number {
    return Math.sqrt(Vec3.distanceSqBetween(this, v));
  }

  normalize(): this {
    const l = this.length();
    if (l > EPSILON) {
      const inv = 1 / l;
      this.x *= inv;
      this.y *= inv;
      this.z *= inv;
    }
    return this;
  }

  dot(v: Vec3Ops): number {
    return this.x * v.x + this.y * v.y + this.z * v.z;
  }

  cross(v: Vec3Ops): this {
    const { x, y, z } = this;
    this.x = y * v.z - z * v.y;
    this.y = z * v.x - x * v.z;
    this.z = x * v.y - y * v.x;
    return this;
  }

  lerp(v: Vec3Ops, t: number): this {
    this.x += (v.x - this.x) * t;
    this.y += (v.y - this.y) * t;
    this.z += (v.z - this.z) * t;
    return this;
  }

  min(v: Vec3Ops): this {
    this.x = Math.min(this.x, v.x);
    this.y = Math.min(this.y, v.y);
    this.z = Math.min(this.z, v.z);
    return this;
  }

  max(v: Vec3Ops): this {
    this.x = Math.max(this.x, v.x);
    this.y = Math.max(this.y, v.y);
    this.z = Math.max(this.z, v.z);
    return this;
  }

  clamp(min: Vec3Ops, max: Vec3Ops): this {
    this.x = clamp(this.x, min.x, max.x);
    this.y = clamp(this.y, min.y, max.y);
    this.z = clamp(this.z, min.z, max.z);
    return this;
  }

  /** Reflect the vector about a plane with the given unit normal ( incident - 2(n·i)n ). */
  reflect(normal: Vec3Ops): this {
    const d = 2 * this.dot(normal);
    this.x -= d * normal.x;
    this.y -= d * normal.y;
    this.z -= d * normal.z;
    return this;
  }

  /** Project this vector onto `dir` (assumed unit length). */
  projectOnUnit(dir: Vec3Ops): this {
    const d = this.dot(dir);
    this.x = dir.x * d;
    this.y = dir.y * d;
    this.z = dir.z * d;
    return this;
  }

  equals(v: Vec3Ops, epsilon = 0): boolean {
    return (
      Math.abs(this.x - v.x) <= epsilon && Math.abs(this.y - v.y) <= epsilon && Math.abs(this.z - v.z) <= epsilon
    );
  }

  isFinite(): boolean {
    return Number.isFinite(this.x) && Number.isFinite(this.y) && Number.isFinite(this.z);
  }

  toArray(): [number, number, number] {
    return [this.x, this.y, this.z];
  }

  toString(): string {
    return `(${this.x.toFixed(3)}, ${this.y.toFixed(3)}, ${this.z.toFixed(3)})`;
  }

  // ---- static, allocation-free forms (out-parameter style) ----

  static addInto(a: Vec3Ops, b: Vec3Ops, out: Vec3Ops): void {
    out.x = a.x + b.x;
    out.y = a.y + b.y;
    out.z = a.z + b.z;
  }

  static subInto(a: Vec3Ops, b: Vec3Ops, out: Vec3Ops): void {
    out.x = a.x - b.x;
    out.y = a.y - b.y;
    out.z = a.z - b.z;
  }

  static scaleInto(a: Vec3Ops, s: number, out: Vec3Ops): void {
    out.x = a.x * s;
    out.y = a.y * s;
    out.z = a.z * s;
  }

  static lerpInto(a: Vec3Ops, b: Vec3Ops, t: number, out: Vec3Ops): void {
    out.x = a.x + (b.x - a.x) * t;
    out.y = a.y + (b.y - a.y) * t;
    out.z = a.z + (b.z - a.z) * t;
  }

  static crossInto(a: Vec3Ops, b: Vec3Ops, out: Vec3Ops): void {
    out.x = a.y * b.z - a.z * b.y;
    out.y = a.z * b.x - a.x * b.z;
    out.z = a.x * b.y - a.y * b.x;
  }

  static distanceSqBetween(a: Vec3Ops, b: Vec3Ops): number {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    const dz = a.z - b.z;
    return dx * dx + dy * dy + dz * dz;
  }

  static dotInto(a: Vec3Ops, b: Vec3Ops): number {
    return a.x * b.x + a.y * b.y + a.z * b.z;
  }

  static normalizeInto(a: Vec3Ops, out: Vec3Ops): void {
    const l = Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z);
    if (l > EPSILON) {
      out.x = a.x / l;
      out.y = a.y / l;
      out.z = a.z / l;
    } else {
      out.x = 0;
      out.y = 0;
      out.z = 0;
    }
  }

  static zeroInto(out: Vec3Ops): void {
    out.x = 0;
    out.y = 0;
    out.z = 0;
  }

  /**
   * Build an orthonormal basis from a single (possibly degenerate) direction.
   * Used by cameras, particle trails, and tangent-frame lighting. Matches the
   * "Frigen" branchless algorithm (Duff et al., SIGGRAPH 2017).
   */
  static orthonormalBasisInto(dir: Vec3Ops, outX: Vec3Ops, outY: Vec3Ops, outZ: Vec3Ops): void {
    const sign = dir.z < 0 ? 1 : -1;
    const c = 1 / (sign + dir.z);
    const d = dir.x * dir.y * c;
    outX.x = 1.0 + sign * dir.x * dir.x * c;
    outX.y = sign * d;
    outX.z = -sign * dir.x;
    outY.x = d;
    outY.y = sign + dir.y * dir.y * c;
    outY.z = -dir.y;
    outZ.x = dir.x;
    outZ.y = dir.y;
    outZ.z = dir.z;
  }

  /** Unsigned angle (radians) between two non-zero vectors. */
  static angleBetween(a: Vec3Ops, b: Vec3Ops): number {
    const d = Vec3.dotInto(a, b) / (Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z) * Math.sqrt(b.x * b.x + b.y * b.y + b.z * b.z) + 1e-12);
    return Math.acos(clamp(d, -1, 1));
  }
}

export class Vec4 {
  constructor(public x = 0, public y = 0, public z = 0, public w = 0) {}

  clone(): Vec4 {
    return new Vec4(this.x, this.y, this.z, this.w);
  }

  set(x: number, y: number, z: number, w: number): this {
    this.x = x;
    this.y = y;
    this.z = z;
    this.w = w;
    return this;
  }

  toArray(): [number, number, number, number] {
    return [this.x, this.y, this.z, this.w];
  }
}

/** Scratch vectors for internal use. Never return a scratch object from a public API. */
export const scratch3 = Object.freeze({
  a: new Vec3(),
  b: new Vec3(),
  c: new Vec3(),
  d: new Vec3(),
});
