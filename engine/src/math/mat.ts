/**
 * Quaternion, Mat3 and Mat4.
 *
 * `Mat4` stores a 16-element `Float32Array` in **column-major** order so it can be uploaded to
 * a WebGPU uniform buffer with no conversion or extra copy:
 *
 * ```
 * m = | 0  4  8  12 |     column c starts at index c*4
 *     | 1  5  9  13 |
 *     | 2  6  10 14 |
 *     | 3  7  11 15 |
 * ```
 *
 * Transforms use the left-handed convention: `p' = S*R*T*p` in matrix form, i.e. scale, then
 * rotate, then translate. All projection helpers produce WebGPU clip space
 * (x,y ∈ [-1,1], z ∈ [0,1]).
 */

import type { Vec3Ops } from "./vec.js";
import { Vec3 } from "./vec.js";
import { EPSILON, PI, clamp } from "./scalar.js";

export class Quat {
  constructor(public x = 0, public y = 0, public z = 0, public w = 1) {}

  static readonly identity = Object.freeze(new Quat(0, 0, 0, 1));

  clone(): Quat {
    return new Quat(this.x, this.y, this.z, this.w);
  }

  set(x: number, y: number, z: number, w: number): this {
    this.x = x;
    this.y = y;
    this.z = z;
    this.w = w;
    return this;
  }

  copyFrom(q: Quat): this {
    this.x = q.x;
    this.y = q.y;
    this.z = q.z;
    this.w = q.w;
    return this;
  }

  setIdentity(): this {
    return this.set(0, 0, 0, 1);
  }

  /** `axis` must be unit length. */
  setAxisAngle(axis: Vec3Ops, angleRad: number): this {
    const h = angleRad * 0.5;
    const s = Math.sin(h);
    this.x = axis.x * s;
    this.y = axis.y * s;
    this.z = axis.z * s;
    this.w = Math.cos(h);
    return this;
  }

  static fromAxisAngle(axis: Vec3Ops, angleRad: number): Quat {
    return new Quat().setAxisAngle(axis, angleRad);
  }

  /** Order XYZ (intrinsic): applied as R = Rx * Ry * Rz, matching `Mat4.makeRotationEuler`. */
  setEuler(radians: Vec3Ops): this {
    return this.setEulerComponents(radians.x, radians.y, radians.z);
  }

  setEulerComponents(rx: number, ry: number, rz: number): this {
    const c1 = Math.cos(rx / 2);
    const c2 = Math.cos(ry / 2);
    const c3 = Math.cos(rz / 2);
    const s1 = Math.sin(rx / 2);
    const s2 = Math.sin(ry / 2);
    const s3 = Math.sin(rz / 2);
    this.x = s1 * c2 * c3 + c1 * s2 * s3;
    this.y = c1 * s2 * c3 - s1 * c2 * s3;
    this.z = c1 * c2 * s3 - s1 * s2 * c3;
    this.w = c1 * c2 * c3 + s1 * s2 * s3;
    return this;
  }

  toEuler(out: Vec3): Vec3 {
    const { x, y, z, w } = this;
    const sinrCosp = 2 * (w * x + y * z);
    const cosrCosp = 1 - 2 * (x * x + y * y);
    out.x = Math.atan2(sinrCosp, cosrCosp);
    let sinp = 2 * (w * y - z * x);
    sinp = clamp(sinp, -1, 1);
    out.y = Math.asin(sinp);
    const sinyCosp = 2 * (w * z + x * y);
    const cosyCosp = 1 - 2 * (y * y + z * z);
    out.z = Math.atan2(sinyCosp, cosyCosp);
    return out;
  }

  /** Quaternion that rotates the unit +Y axis onto `dir` (assumed unit length). */
  fromUnitVectorY(dir: Vec3Ops): this {
    const r = dir.y + 1;
    if (r < 1e-6) {
      // 180° flip about any axis perpendicular to Y.
      this.set(1, 0, 0, 0);
      return this;
    }
    const s = 0.5 / r;
    this.set(-dir.z * s, 0, dir.x * s, 0.5);
    return this.normalize();
  }

  lengthSq(): number {
    return this.x * this.x + this.y * this.y + this.z * this.z + this.w * this.w;
  }

  length(): number {
    return Math.sqrt(this.lengthSq());
  }

  normalize(): this {
    const l = this.length();
    if (l > EPSILON) {
      const inv = 1 / l;
      this.x *= inv;
      this.y *= inv;
      this.z *= inv;
      this.w *= inv;
    } else {
      this.setIdentity();
    }
    return this;
  }

  conjugate(): this {
    this.x = -this.x;
    this.y = -this.y;
    this.z = -this.z;
    return this;
  }

  /** Inverse of a unit quaternion == conjugate; divides by |q|² for the general case. */
  invert(): this {
    const l = this.lengthSq();
    this.conjugate();
    if (l > EPSILON) {
      const inv = 1 / l;
      this.x *= inv;
      this.y *= inv;
      this.z *= inv;
      this.w *= inv;
    }
    return this;
  }

  /** this = this * b  (apply `b` first in the local sense: standard `q * r` composition). */
  multiply(b: Quat): this {
    const { x, y, z, w } = this;
    this.x = w * b.x + x * b.w + y * b.z - z * b.y;
    this.y = w * b.y - x * b.z + y * b.w + z * b.x;
    this.z = w * b.z + x * b.y - y * b.x + z * b.w;
    this.w = w * b.w - x * b.x - y * b.y - z * b.z;
    return this;
  }

  premultiply(b: Quat): this {
    const { x, y, z, w } = b;
    const ax = this.x;
    const ay = this.y;
    const az = this.z;
    const aw = this.w;
    this.x = ax * w + aw * x + ay * z - az * y;
    this.y = ay * w + aw * y + az * x - ax * z;
    this.z = az * w + aw * z + ax * y - ay * x;
    this.w = aw * w - ax * x - ay * y - az * z;
    return this;
  }

  rotateVector(v: Vec3Ops, out: Vec3): Vec3 {
    // t = 2 * (q.xyz × v); out = v + q.w*t + q.xyz × t   (2-cross form, cheaper & stable)
    const qx = this.x;
    const qy = this.y;
    const qz = this.z;
    const qw = this.w;
    const tx = 2 * (qy * v.z - qz * v.y);
    const ty = 2 * (qz * v.x - qx * v.z);
    const tz = 2 * (qx * v.y - qy * v.x);
    out.x = v.x + qw * tx + (qy * tz - qz * ty);
    out.y = v.y + qw * ty + (qz * tx - qx * tz);
    out.z = v.z + qw * tz + (qx * ty - qy * tx);
    return out;
  }

  /** Rotate a vector by the inverse rotation (cheap because q is unit in practice). */
  rotateVectorInverse(v: Vec3Ops, out: Vec3): Vec3 {
    const inv = scratchQ();
    inv.copyFrom(this).conjugate();
    return inv.rotateVector(v, out);
  }

  dot(b: Quat): number {
    return this.x * b.x + this.y * b.y + this.z * b.z + this.w * b.w;
  }

  slerp(b: Quat, t: number): this {
    Quat.slerpInto(this, b, t, this);
    return this;
  }

  nlerp(b: Quat, t: number): this {
    Quat.nlerpInto(this, b, t, this);
    return this;
  }

  isFiniteNumber(): boolean {
    return Number.isFinite(this.x) && Number.isFinite(this.y) && Number.isFinite(this.z) && Number.isFinite(this.w);
  }

  equals(q: Quat, epsilon = 1e-6): boolean {
    // q and -q are the same rotation.
    const d = Math.abs(this.dot(q));
    return d > 1 - epsilon;
  }

  static multiplyInto(a: Quat, b: Quat, out: Quat): void {
    out.set(
      a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
      a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
      a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
      a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
    );
  }

  /** Shortest-arc normalized lerp. Preserves unit length; near-linear, allocation-free. */
  static nlerpInto(a: Quat, b: Quat, t: number, out: Quat): void {
    let bx = b.x;
    let by = b.y;
    let bz = b.z;
    let bw = b.w;
    if (a.dot(b) < 0) {
      bx = -bx;
      by = -by;
      bz = -bz;
      bw = -bw;
    }
    out.x = a.x + (bx - a.x) * t;
    out.y = a.y + (by - a.y) * t;
    out.z = a.z + (bz - a.z) * t;
    out.w = a.w + (bw - a.w) * t;
    const l = Math.sqrt(out.x * out.x + out.y * out.y + out.z * out.z + out.w * out.w);
    if (l > EPSILON) {
      const inv = 1 / l;
      out.x *= inv;
      out.y *= inv;
      out.z *= inv;
      out.w *= inv;
    } else {
      out.copyFrom(a);
    }
  }

  /**
   * Spherical linear interpolation with hemisphere fixup, falling back to nlerp for
   * tiny angles (where sin(theta) → 0 makes the closed form numerically unstable).
   */
  static slerpInto(a: Quat, b: Quat, t: number, out: Quat): void {
    let cosHalf = a.dot(b);
    let bx = b.x;
    let by = b.y;
    let bz = b.z;
    let bw = b.w;
    if (cosHalf < 0) {
      cosHalf = -cosHalf;
      bx = -bx;
      by = -by;
      bz = -bz;
      bw = -bw;
    }
    if (cosHalf >= 1 - 1e-6) {
      Quat.nlerpInto(a, { x: bx, y: by, z: bz, w: bw } as Quat, t, out);
      return;
    }
    const halfTheta = Math.acos(clamp(cosHalf, -1, 1));
    const sinHalf = Math.sqrt(1 - cosHalf * cosHalf);
    const ratioA = Math.sin((1 - t) * halfTheta) / sinHalf;
    const ratioB = Math.sin(t * halfTheta) / sinHalf;
    out.set(
      a.x * ratioA + bx * ratioB,
      a.y * ratioA + by * ratioB,
      a.z * ratioA + bz * ratioB,
      a.w * ratioA + bw * ratioB,
    );
  }

  /** Integrate angular velocity (rad/s, world space) — used by rigid-body spin. */
  integrate(angVel: Vec3Ops, dt: number, out: Quat): void {
    const hx = angVel.x * dt * 0.5;
    const hy = angVel.y * dt * 0.5;
    const hz = angVel.z * dt * 0.5;
    const { x, y, z, w } = this;
    out.x = x + (hx * w + hy * z - hz * y);
    out.y = y + (hy * w + hz * x - hx * z);
    out.z = z + (hz * w + hx * y - hy * x);
    out.w = w - (hx * x + hy * y + hz * z);
    out.normalize();
  }

  static fromRotationMatrix(m: Mat4, out: Quat): Quat {
    const trace = m.m[0] + m.m[5] + m.m[10];
    if (trace > 0) {
      const s = 0.5 / Math.sqrt(trace + 1);
      out.w = 0.25 / s;
      out.x = (m.m[6] - m.m[9]) * s;
      out.y = (m.m[8] - m.m[2]) * s;
      out.z = (m.m[1] - m.m[4]) * s;
    } else if (m.m[0] > m.m[5] && m.m[0] > m.m[10]) {
      const s = 2 * Math.sqrt(1 + m.m[0]! - m.m[5]! - m.m[10]!);
      out.w = (m.m[6]! - m.m[9]!) / s;
      out.x = 0.25 * s;
      out.y = (m.m[1]! + m.m[4]!) / s;
      out.z = (m.m[2]! + m.m[8]!) / s;
    } else if (m.m[5] > m.m[10]) {
      const s = 2 * Math.sqrt(1 + m.m[5]! - m.m[0]! - m.m[10]!);
      out.w = (m.m[8]! - m.m[2]!) / s;
      out.x = (m.m[1]! + m.m[4]!) / s;
      out.y = 0.25 * s;
      out.z = (m.m[6]! + m.m[9]!) / s;
    } else {
      const s = 2 * Math.sqrt(1 + m.m[10]! - m.m[0]! - m.m[5]!);
      out.w = (m.m[4]! - m.m[1]!) / s;
      out.x = (m.m[2]! + m.m[8]!) / s;
      out.y = (m.m[6]! + m.m[9]!) / s;
      out.z = 0.25 * s;
    }
    return out;
  }
}

let _q0: Quat | null = null;
function scratchQ(): Quat {
  if (!_q0) _q0 = new Quat();
  return _q0;
}

/** 3×3 matrix, column-major, used for normal matrices and inertia tensors. */
export class Mat3 {
  readonly m: Float32Array;

  constructor(values?: ArrayLike<number>) {
    this.m = values ? Float32Array.from(values) : new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);
  }

  setIdentity(): this {
    const m = this.m;
    m[0] = 1;
    m[1] = 0;
    m[2] = 0;
    m[3] = 0;
    m[4] = 1;
    m[5] = 0;
    m[6] = 0;
    m[7] = 0;
    m[8] = 1;
    return this;
  }

  transpose(): this {
    const m = this.m;
    const a = m[1]!;
    const b = m[2]!;
    const c = m[5]!;
    m[1] = m[3]!;
    m[2] = m[6]!;
    m[5] = m[7]!;
    m[3] = a;
    m[6] = b;
    m[7] = c;
    return this;
  }

  determinant(): number {
    const m = this.m;
    return (
      m[0]! * (m[4]! * m[8]! - m[5]! * m[7]!) -
      m[3]! * (m[1]! * m[8]! - m[2]! * m[7]!) +
      m[6]! * (m[1]! * m[5]! - m[2]! * m[4]!)
    );
  }

  /** Inverse of a general 3×3 (used by anisotropic filtering and tangent spaces). */
  invert(): this {
    const m = this.m;
    const det = this.determinant();
    if (Math.abs(det) < EPSILON) return this.setIdentity();
    const inv = 1 / det;
    const n0 = (m[4]! * m[8]! - m[5]! * m[7]!) * inv;
    const n1 = (m[2]! * m[7]! - m[1]! * m[8]!) * inv;
    const n2 = (m[1]! * m[5]! - m[2]! * m[4]!) * inv;
    const n3 = (m[5]! * m[6]! - m[3]! * m[8]!) * inv;
    const n4 = (m[0]! * m[8]! - m[2]! * m[6]!) * inv;
    const n5 = (m[2]! * m[3]! - m[0]! * m[5]!) * inv;
    const n6 = (m[3]! * m[7]! - m[4]! * m[6]!) * inv;
    const n7 = (m[1]! * m[6]! - m[0]! * m[7]!) * inv;
    const n8 = (m[0]! * m[4]! - m[1]! * m[3]!) * inv;
    m[0] = n0;
    m[1] = n1;
    m[2] = n2;
    m[3] = n3;
    m[4] = n4;
    m[5] = n5;
    m[6] = n6;
    m[7] = n7;
    m[8] = n8;
    return this;
  }

  /** Extract the upper-left 3×3 of `m`, invert and transpose → normal matrix. */
  setNormalMatrix(model: Mat4): this {
    const s = model.m;
    // Copy upper 3x3 (column-major 4x4 -> column-major 3x3)
    this.m[0] = s[0]!;
    this.m[1] = s[1]!;
    this.m[2] = s[2]!;
    this.m[3] = s[4]!;
    this.m[4] = s[5]!;
    this.m[5] = s[6]!;
    this.m[6] = s[8]!;
    this.m[7] = s[9]!;
    this.m[8] = s[10]!;
    return this.invert().transpose();
  }

  transformVector(v: Vec3Ops, out: Vec3): Vec3 {
    const m = this.m;
    out.x = m[0]! * v.x + m[3]! * v.y + m[6]! * v.z;
    out.y = m[1]! * v.x + m[4]! * v.y + m[7]! * v.z;
    out.z = m[2]! * v.x + m[5]! * v.y + m[8]! * v.z;
    return out;
  }
}

export class Mat4 {
  readonly m: Float32Array;

  constructor(values?: ArrayLike<number>) {
    this.m = values ? Float32Array.from(values) : new Float32Array(16);
    if (!values) this.setIdentity();
  }

  static identity(): Mat4 {
    return new Mat4();
  }

  copyFrom(o: Mat4): this {
    this.m.set(o.m);
    return this;
  }

  clone(): Mat4 {
    return new Mat4(this.m);
  }

  setIdentity(): this {
    const m = this.m;
    m.fill(0);
    m[0] = 1;
    m[5] = 1;
    m[10] = 1;
    m[15] = 1;
    return this;
  }

  isIdentity(eps = 1e-6): boolean {
    const m = this.m;
    for (let i = 0; i < 16; i++) {
      const expected = i % 5 === 0 ? 1 : 0;
      if (Math.abs(m[i]! - expected) > eps) return false;
    }
    return true;
  }

  elements(): Float32Array {
    return this.m;
  }

  /** Raw view suitable for `queue.writeBuffer`. */
  get buffer(): Float32Array {
    return this.m;
  }

  get(x: number, y: number): number {
    return this.m[y + x * 4]!;
  }

  setColumn(c: number, x: number, y: number, z: number, w: number): this {
    const i = c * 4;
    this.m[i] = x;
    this.m[i + 1] = y;
    this.m[i + 2] = z;
    this.m[i + 3] = w;
    return this;
  }

  // ---------------------------------------------------------------- composition

  /** this = a * b (b applied first). */
  multiplyMatrices(a: Mat4, b: Mat4): this {
    const out = this.m;
    const am = a.m;
    const bm = b.m;
    for (let c = 0; c < 4; c++) {
      const b0 = bm[c * 4]!;
      const b1 = bm[c * 4 + 1]!;
      const b2 = bm[c * 4 + 2]!;
      const b3 = bm[c * 4 + 3]!;
      out[c * 4] = am[0]! * b0 + am[4]! * b1 + am[8]! * b2 + am[12]! * b3;
      out[c * 4 + 1] = am[1]! * b0 + am[5]! * b1 + am[9]! * b2 + am[13]! * b3;
      out[c * 4 + 2] = am[2]! * b0 + am[6]! * b1 + am[10]! * b2 + am[14]! * b3;
      out[c * 4 + 3] = am[3]! * b0 + am[7]! * b1 + am[11]! * b2 + am[15]! * b3;
    }
    return this;
  }

  multiply(b: Mat4): this {
    return this.multiplyMatrices(this, b);
  }

  translate(v: Vec3Ops): this {
    const m = this.m;
    m[12] += v.x;
    m[13] += v.y;
    m[14] += v.z;
    return this;
  }

  scale(s: Vec3Ops): this {
    const m = this.m;
    for (let r = 0; r < 4; r++) {
      m[r] *= s.x;
      m[4 + r] *= s.y;
      m[8 + r] *= s.z;
    }
    return this;
  }

  rotateByQuaternion(q: Quat): this {
    const rm = scratchMat();
    rm.setRotationQuaternion(q);
    return this.multiplyMatrices(this, rm);
  }

  setTranslation(v: Vec3Ops): this {
    this.m[12] = v.x;
    this.m[13] = v.y;
    this.m[14] = v.z;
    return this;
  }

  getTranslation(out: Vec3): Vec3 {
    out.x = this.m[12]!;
    out.y = this.m[13]!;
    out.z = this.m[14]!;
    return out;
  }

  // ---------------------------------------------------------------- factories

  setCompose(position: Vec3Ops, rotation: Quat, scale: Vec3Ops): this {
    const m = this.m;
    const { x, y, z, w } = rotation;
    const x2 = x + x;
    const y2 = y + y;
    const z2 = z + z;
    const xx = x * x2;
    const xy = x * y2;
    const xz = x * z2;
    const yy = y * y2;
    const yz = y * z2;
    const zz = z * z2;
    const wx = w * x2;
    const wy = w * y2;
    const wz = w * z2;
    const sx = scale.x;
    const sy = scale.y;
    const sz = scale.z;
    m[0] = (1 - (yy + zz)) * sx;
    m[1] = (xy + wz) * sx;
    m[2] = (xz - wy) * sx;
    m[3] = 0;
    m[4] = (xy - wz) * sy;
    m[5] = (1 - (xx + zz)) * sy;
    m[6] = (yz + wx) * sy;
    m[7] = 0;
    m[8] = (xz + wy) * sz;
    m[9] = (yz - wx) * sz;
    m[10] = (1 - (xx + yy)) * sz;
    m[11] = 0;
    m[12] = position.x;
    m[13] = position.y;
    m[14] = position.z;
    m[15] = 1;
    return this;
  }

  static compose(position: Vec3Ops, rotation: Quat, scale: Vec3Ops): Mat4 {
    return new Mat4().setCompose(position, rotation, scale);
  }

  setRotationQuaternion(q: Quat): this {
    this.setCompose(Vec3.zero, q, Vec3.one);
    return this;
  }

  setLookAt(eye: Vec3Ops, target: Vec3Ops, up: Vec3Ops): this {
    const zAxis = scratchVec();
    zAxis.copyFrom(target).sub(eye);
    if (zAxis.lengthSq() < EPSILON) zAxis.set(0, 0, 1);
    zAxis.normalize();
    const xAxis = scratchVecB();
    Vec3.crossInto(up, zAxis, xAxis);
    if (xAxis.lengthSq() < EPSILON) {
      // up parallel to forward: perturb
      xAxis.set(zAxis.z, 0, -zAxis.x);
      Vec3.crossInto(up, zAxis, xAxis);
    }
    xAxis.normalize();
    const yAxis = scratchVecC();
    Vec3.crossInto(zAxis, xAxis, yAxis);
    const m = this.m;
    m[0] = xAxis.x;
    m[1] = xAxis.y;
    m[2] = xAxis.z;
    m[3] = 0;
    m[4] = yAxis.x;
    m[5] = yAxis.y;
    m[6] = yAxis.z;
    m[7] = 0;
    m[8] = zAxis.x;
    m[9] = zAxis.y;
    m[10] = zAxis.z;
    m[11] = 0;
    m[12] = eye.x;
    m[13] = eye.y;
    m[14] = eye.z;
    m[15] = 1;
    return this;
  }

  /**
   * Projection for this engine's view space: right-handed XY, **+Z forward** (what `setLookAt`
   * produces), with WebGPU's depth range [0, 1].
   *
   * clipW = z (so `m[11] = 1`), and the divide maps z=near -> 0, z=far -> 1. The two conventions are
   * coupled: a matrix that assumes -Z forward or [-1,1] depth behind a +Z-forward view space renders
   * the scene inside-out and puts every shadow at the wrong depth, which is why this one is unit
   * tested against both endpoints.
   */
  setPerspective(fovYRad: number, aspect: number, near: number, far: number): this {
    const m = this.m;
    m.fill(0);
    const f = 1 / Math.tan(clamp(fovYRad, 1e-4, PI - 1e-4) / 2);
    const span = Math.max(far - near, 1e-6);
    m[0] = f / aspect;
    m[5] = f;
    m[10] = far / span;
    m[11] = 1;
    m[14] = -(far * near) / span;
    m[15] = 0;
    return this;
  }

  setOrthographic(left: number, right: number, bottom: number, top: number, near: number, far: number): this {
    const m = this.m;
    m.fill(0);
    const lr = 1 / (left - right);
    const bt = 1 / (bottom - top);
    // Depth into WebGPU's [0,1] range for the engine's +Z-forward view space (see setPerspective):
    // z=near -> 0, z=far -> 1, with no perspective divide (m[11] stays 0, m[15] = 1).
    const zf = 1 / Math.max(far - near, 1e-6);
    m[0] = -2 * lr;
    m[5] = -2 * bt;
    m[10] = zf;
    m[12] = (left + right) * lr;
    m[13] = (top + bottom) * bt;
    m[14] = -near * zf;
    m[15] = 1;
    return this;
  }

  /** Window-space (pixel) matrix for 2D UI: origin top-left, +Y down. */
  setOrthoPixelSpace(width: number, height: number, near = 0, far = 1): this {
    return this.setOrthographic(0, Math.max(width, 1e-6), Math.max(height, 1e-6), 0, near, far);
  }

  // ---------------------------------------------------------------- queries

  determinant(): number {
    const e = this.m;
    const a00 = e[0]!;
    const a01 = e[1]!;
    const a02 = e[2]!;
    const a03 = e[3]!;
    const a10 = e[4]!;
    const a11 = e[5]!;
    const a12 = e[6]!;
    const a13 = e[7]!;
    const a20 = e[8]!;
    const a21 = e[9]!;
    const a22 = e[10]!;
    const a23 = e[11]!;
    const a30 = e[12]!;
    const a31 = e[13]!;
    const a32 = e[14]!;
    const a33 = e[15]!;
    const b00 = a00 * a11 - a01 * a10;
    const b01 = a00 * a12 - a02 * a10;
    const b02 = a00 * a13 - a03 * a10;
    const b03 = a01 * a12 - a02 * a11;
    const b04 = a01 * a13 - a03 * a11;
    const b05 = a02 * a13 - a03 * a12;
    const b06 = a20 * a31 - a21 * a30;
    const b07 = a20 * a32 - a22 * a30;
    const b08 = a20 * a33 - a23 * a30;
    const b09 = a21 * a32 - a22 * a31;
    const b10 = a21 * a33 - a23 * a31;
    const b11 = a22 * a33 - a23 * a32;
    return b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  }

  /** Invert in place; returns false and leaves the matrix unchanged when singular. */
  invert(): boolean {
    const m = this.m;
    const a00 = m[0]!;
    const a01 = m[1]!;
    const a02 = m[2]!;
    const a03 = m[3]!;
    const a10 = m[4]!;
    const a11 = m[5]!;
    const a12 = m[6]!;
    const a13 = m[7]!;
    const a20 = m[8]!;
    const a21 = m[9]!;
    const a22 = m[10]!;
    const a23 = m[11]!;
    const a30 = m[12]!;
    const a31 = m[13]!;
    const a32 = m[14]!;
    const a33 = m[15]!;
    const b00 = a00 * a11 - a01 * a10;
    const b01 = a00 * a12 - a02 * a10;
    const b02 = a00 * a13 - a03 * a10;
    const b03 = a01 * a12 - a02 * a11;
    const b04 = a01 * a13 - a03 * a11;
    const b05 = a02 * a13 - a03 * a12;
    const b06 = a20 * a31 - a21 * a30;
    const b07 = a20 * a32 - a22 * a30;
    const b08 = a20 * a33 - a23 * a30;
    const b09 = a21 * a32 - a22 * a31;
    const b10 = a21 * a33 - a23 * a31;
    const b11 = a22 * a33 - a23 * a32;
    let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
    if (Math.abs(det) < 1e-12) return false;
    det = 1 / det;
    m[0] = (a11 * b11 - a12 * b10 + a13 * b09) * det;
    m[1] = (a02 * b10 - a01 * b11 - a03 * b09) * det;
    m[2] = (a31 * b05 - a32 * b04 + a33 * b03) * det;
    m[3] = (a22 * b04 - a21 * b05 - a23 * b03) * det;
    m[4] = (a12 * b08 - a10 * b11 - a13 * b07) * det;
    m[5] = (a00 * b11 - a02 * b08 + a03 * b07) * det;
    m[6] = (a32 * b02 - a30 * b05 - a33 * b01) * det;
    m[7] = (a20 * b05 - a22 * b02 + a23 * b01) * det;
    m[8] = (a10 * b10 - a11 * b08 + a13 * b06) * det;
    m[9] = (a01 * b08 - a00 * b10 - a03 * b06) * det;
    m[10] = (a30 * b04 - a31 * b02 + a33 * b00) * det;
    m[11] = (a21 * b02 - a20 * b04 - a23 * b00) * det;
    m[12] = (a11 * b07 - a10 * b09 - a12 * b06) * det;
    m[13] = (a00 * b09 - a01 * b07 + a02 * b06) * det;
    m[14] = (a31 * b01 - a30 * b03 - a32 * b00) * det;
    m[15] = (a20 * b03 - a21 * b01 + a22 * b00) * det;
    return true;
  }

  /**
   * Decompose into translation/rotation/scale.
   *
   * Returns false for degenerate (zero-determinant) matrices — the caller should then keep
   * the previous transform rather than propagate NaN. Handles negative scale by folding the
   * sign into X, which is what the animation/skinning path expects.
   */
  decompose(pos: Vec3, rot: Quat, scl: Vec3): boolean {
    const m = this.m;
    let sx = Math.hypot(m[0]!, m[1]!, m[2]!);
    const sy = Math.hypot(m[4]!, m[5]!, m[6]!);
    const sz = Math.hypot(m[8]!, m[9]!, m[10]!);
    if (this.determinant() < 0) sx = -sx;
    if (sx < 1e-8 || sy < 1e-8 || sz < 1e-8) return false;
    pos.x = m[12]!;
    pos.y = m[13]!;
    pos.z = m[14]!;
    scl.x = sx;
    scl.y = sy;
    scl.z = sz;
    const inv = scratchMat();
    inv.copyFrom(this);
    inv.m[0] /= sx;
    inv.m[1] /= sx;
    inv.m[2] /= sx;
    inv.m[4] /= sy;
    inv.m[5] /= sy;
    inv.m[6] /= sy;
    inv.m[8] /= sz;
    inv.m[9] /= sz;
    inv.m[10] /= sz;
    Quat.fromRotationMatrix(inv, rot);
    return true;
  }

  transformPoint(v: Vec3Ops, out: Vec3): Vec3 {
    const m = this.m;
    const w = m[3]! * v.x + m[7]! * v.y + m[11]! * v.z + m[15]!;
    const iw = Math.abs(w) < EPSILON ? 1 : 1 / w;
    out.x = (m[0]! * v.x + m[4]! * v.y + m[8]! * v.z + m[12]!) * iw;
    out.y = (m[1]! * v.x + m[5]! * v.y + m[9]! * v.z + m[13]!) * iw;
    out.z = (m[2]! * v.x + m[6]! * v.y + m[10]! * v.z + m[14]!) * iw;
    return out;
  }

  /** Direction/matrix transform without translation (w = 0 row). */
  transformDirection(v: Vec3Ops, out: Vec3): Vec3 {
    const m = this.m;
    out.x = m[0]! * v.x + m[4]! * v.y + m[8]! * v.z;
    out.y = m[1]! * v.x + m[5]! * v.y + m[9]! * v.z;
    out.z = m[2]! * v.x + m[6]! * v.y + m[10]! * v.z;
    return out;
  }

  /** Transform a homogeneous (x,y,z,w) tuple — used by frustum plane extraction & clipping. */
  transformVec4(x: number, y: number, z: number, w: number, out: Float32Array, offset = 0): void {
    const m = this.m;
    out[offset] = m[0]! * x + m[4]! * y + m[8]! * z + m[12]! * w;
    out[offset + 1] = m[1]! * x + m[5]! * y + m[9]! * z + m[13]! * w;
    out[offset + 2] = m[2]! * x + m[6]! * y + m[10]! * z + m[14]! * w;
    out[offset + 3] = m[3]! * x + m[7]! * y + m[11]! * z + m[15]! * w;
  }

  transpose(): this {
    const m = this.m;
    let t: number;
    t = m[1]!;
    m[1] = m[4]!;
    m[4] = t;
    t = m[2]!;
    m[2] = m[8]!;
    m[8] = t;
    t = m[3]!;
    m[3] = m[12]!;
    m[12] = t;
    t = m[6]!;
    m[6] = m[9]!;
    m[9] = t;
    t = m[7]!;
    m[7] = m[13]!;
    m[13] = t;
    t = m[11]!;
    m[11] = m[14]!;
    m[14] = t;
    return this;
  }
}

// Module-local scratch objects (never exposed publicly).
let _sv: Vec3 | null = null;
let _svB: Vec3 | null = null;
let _svC: Vec3 | null = null;
let _sm: Mat4 | null = null;
function scratchVec(): Vec3 {
  return (_sv ??= new Vec3());
}
function scratchVecB(): Vec3 {
  return (_svB ??= new Vec3());
}
function scratchVecC(): Vec3 {
  return (_svC ??= new Vec3());
}
function scratchMat(): Mat4 {
  return (_sm ??= new Mat4());
}
