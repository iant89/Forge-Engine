/**
 * Double-precision 3D coordinates for large-world positions.
 *
 * Why not a "float double-single" (emulated) encoding? Because JS numbers *are* IEEE-754
 * doubles, so `x: number` already has 52-bit mantissas; the cost is only in the *storage*
 * (3 doubles instead of 3 floats) and in keeping the value away from the GPU, which cannot
 * consume float64 uniforms. Forge therefore splits concerns:
 *
 *  - `Double3` (this file) is used for authoring, streaming keys, physics positions and
 *    anything that must survive 10^6+ metre worlds.
 *  - Rendering happens in `Single3` = float32 offsets relative to a per-frame `renderOrigin`
 *    (`world/coordinateSpace.ts`). This keeps GPU math cheap and precise near the camera.
 *
 * `toRelativeFloat32(origin)` performs the subtraction in double precision and only then
 * rounds to float — the difference matters: `1e7 + 0.5 - 1e7` is exactly 0.5 when computed in
 * doubles, but 0 if you round first. That is the core of the anti-jitter design.
 */

import type { Vec3Ops } from "./vec.js";

export class Double3 {
  constructor(public x = 0, public y = 0, public z = 0) {}

  static of(x = 0, y = 0, z = 0): Double3 {
    return new Double3(x, y, z);
  }

  clone(): Double3 {
    return new Double3(this.x, this.y, this.z);
  }

  set(x: number, y: number, z: number): this {
    this.x = x;
    this.y = y;
    this.z = z;
    return this;
  }

  setZero(): this {
    this.x = this.y = this.z = 0;
    return this;
  }

  copyFrom(v: Double3 | Vec3Ops): this {
    this.x = v.x;
    this.y = v.y;
    this.z = v.z;
    return this;
  }

  add(v: Double3 | Vec3Ops): this {
    this.x += v.x;
    this.y += v.y;
    this.z += v.z;
    return this;
  }

  sub(v: Double3 | Vec3Ops): this {
    this.x -= v.x;
    this.y -= v.y;
    this.z -= v.z;
    return this;
  }

  scale(s: number): this {
    this.x *= s;
    this.y *= s;
    this.z *= s;
    return this;
  }

  length(): number {
    return Math.hypot(this.x, this.y, this.z);
  }

  distanceTo(v: Double3 | Vec3Ops): number {
    return Math.hypot(this.x - v.x, this.y - v.y, this.z - v.z);
  }

  distanceSquared(v: Double3 | Vec3Ops): number {
    const dx = this.x - v.x;
    const dy = this.y - v.y;
    const dz = this.z - v.z;
    return dx * dx + dy * dy + dz * dz;
  }

  dot(v: Double3 | Vec3Ops): number {
    return this.x * v.x + this.y * v.y + this.z * v.z;
  }

  lerp(v: Double3, t: number): this {
    this.x += (v.x - this.x) * t;
    this.y += (v.y - this.y) * t;
    this.z += (v.z - this.z) * t;
    return this;
  }

  isFiniteNumber(): boolean {
    return Number.isFinite(this.x) && Number.isFinite(this.y) && Number.isFinite(this.z);
  }

  /**
   * Subtract `origin` in double precision and store the result as float32 into `out`
   * (a Float32Array with capacity ≥ 3). This is the single conversion point between world
   * space and render space.
   */
  writeRelativeFloat32(origin: Double3, out: Float32Array, offset = 0): void {
    out[offset] = this.x - origin.x;
    out[offset + 1] = this.y - origin.y;
    out[offset + 2] = this.z - origin.z;
  }

  toFloat32Array(out: Float32Array = new Float32Array(3)): Float32Array {
    out[0] = this.x;
    out[1] = this.y;
    out[2] = this.z;
    return out;
  }

  toArray(): [number, number, number] {
    return [this.x, this.y, this.z];
  }

  toString(precision = 3): string {
    return `(${this.x.toFixed(precision)}, ${this.y.toFixed(precision)}, ${this.z.toFixed(precision)})`;
  }
}

/**
 * Two-float ( Dekker / "float64-as-float32-pair") representation, used when a value must be
 * *stored* compactly (e.g. in a Float32Array streaming payload or a shared typed array) yet
 * still recover more than 24 bits of precision.
 *
 * `hi` holds the rounded value; `lo` holds the residual: `value === hi + lo` to ~48 bits.
 */
export function encodeFloat64ToPair(value: number, out: Float32Array, offset: number): void {
  const hi = Math.fround(value);
  const lo = Math.fround(value - hi);
  out[offset] = hi;
  out[offset + 1] = lo;
}

export function decodePairToFloat64(src: Float32Array, offset: number): number {
  return src[offset]! + src[offset + 1]!;
}

/**
 * Encode a signed 64-bit-ish chunk coordinate pair into a single JS number key.
 * Worlds are bounded by `|chunk| < 2^17` per axis at level 0 (with `chunkSize=512` this is a
 * 67 million-metre span, comfortably beyond any browser-float32-renderable world).
 */
export function packChunkKey(cx: number, cz: number, level: number): number {
  const kx = (cx + 131072) & 0x3ffff;
  const kz = (cz + 131072) & 0x3ffff;
  return (kx * 0x40000 + kz) * 32 + (level & 31);
}

export function unpackChunkKey(key: number): { cx: number; cz: number; level: number } {
  const level = key % 32;
  const rest = Math.floor(key / 32);
  const kz = rest % 0x40000;
  const kx = Math.floor(rest / 0x40000);
  return { cx: kx - 131072, cz: kz - 131072, level };
}
