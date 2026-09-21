/**
 * Bounding volumes, rays, planes and frusta.
 *
 * These are the primitives behind culling, picking, physics queries and the debug layer.
 * Everything here is allocation-free with `*Into` variants for hot paths.
 */

import { Mat4 } from "./mat.js";
import { Vec3, type Vec3Ops } from "./vec.js";
import { EPSILON } from "./scalar.js";

export class AABB {
  readonly min: Vec3 = new Vec3(Infinity, Infinity, Infinity);
  readonly max: Vec3 = new Vec3(-Infinity, -Infinity, -Infinity);

  constructor(min?: Vec3Ops, max?: Vec3Ops) {
    if (min) this.min.copyFrom(min);
    if (max) this.max.copyFrom(max);
  }

  static empty(): AABB {
    return new AABB();
  }

  get isEmpty(): boolean {
    return this.min.x > this.max.x;
  }

  setFrom(min: Vec3Ops, max: Vec3Ops): this {
    this.min.copyFrom(min);
    this.max.copyFrom(max);
    return this;
  }

  clear(): this {
    this.min.set(Infinity, Infinity, Infinity);
    this.max.set(-Infinity, -Infinity, -Infinity);
    return this;
  }

  expandByPoint(p: Vec3Ops): this {
    const { min, max } = this;
    min.x = Math.min(min.x, p.x);
    min.y = Math.min(min.y, p.y);
    min.z = Math.min(min.z, p.z);
    max.x = Math.max(max.x, p.x);
    max.y = Math.max(max.y, p.y);
    max.z = Math.max(max.z, p.z);
    return this;
  }

  union(other: AABB): this {
    return this.expandByPoint(other.min).expandByPoint(other.max);
  }

  getCenter(out: Vec3): Vec3 {
    return out.set((this.min.x + this.max.x) / 2, (this.min.y + this.max.y) / 2, (this.min.z + this.max.z) / 2);
  }

  getExtent(out: Vec3): Vec3 {
    return out.set((this.max.x - this.min.x) / 2, (this.max.y - this.min.y) / 2, (this.max.z - this.min.z) / 2);
  }

  getSize(out: Vec3): Vec3 {
    return out.set(this.max.x - this.min.x, this.max.y - this.min.y, this.max.z - this.min.z);
  }

  surfaceArea(): number {
    const s = this.getSize(scratch);
    return 2 * (s.x * s.y + s.y * s.z + s.z * s.x);
  }

  volume(): number {
    const s = this.getSize(scratch);
    return s.x * s.y * s.z;
  }

  containsPoint(p: Vec3Ops): boolean {
    return (
      p.x >= this.min.x && p.x <= this.max.x && p.y >= this.min.y && p.y <= this.max.y && p.z >= this.min.z && p.z <= this.max.z
    );
  }

  intersectsAABB(b: AABB): boolean {
    const a = this;
    return (
      a.min.x <= b.max.x && a.max.x >= b.min.x &&
      a.min.y <= b.max.y && a.max.y >= b.min.y &&
      a.min.z <= b.max.z && a.max.z >= b.min.z
    );
  }

  intersectsSphere(center: Vec3Ops, radius: number): boolean {
    const c = scratch;
    c.set(
      Math.max(this.min.x, Math.min(center.x, this.max.x)),
      Math.max(this.min.y, Math.min(center.y, this.max.y)),
      Math.max(this.min.z, Math.min(center.z, this.max.z)),
    );
    return Vec3.distanceSqBetween(c, center) <= radius * radius;
  }

  /**
   * Slab test. Returns false on miss; otherwise writes `[tEnter, tExit]` into `tMinMax`.
   * Allocation-free (no temporaries) because it is called from the culling and physics hot
   * loops; the axis/sign of entry is also returned via `hitAxis`/`hitSign` when provided.
   */
  intersectsRay(origin: Vec3Ops, invDir: Vec3Ops, tMinMax: Float32Array, hit?: RayHit): boolean {
    // `tMinMax` is an in/out range: callers pass the distance window they care about (a suspension
    // raycast only wants 0..2 m) and get back the actual slab overlap. Ignoring the incoming bounds is
    // the kind of thing that silently makes every "max distance" argument a no-op.
    let tmin = Math.max(tMinMax[0] ?? 0, -Infinity);
    let tmax = Math.min(tMinMax[1] ?? Infinity, Infinity);
    if (!(tmax > tmin)) return false;
    let axis = -1;
    let sign = 1;
    for (let i = 0; i < 3; i++) {
      const o = i === 0 ? origin.x : i === 1 ? origin.y : origin.z;
      const d = i === 0 ? invDir.x : i === 1 ? invDir.y : invDir.z;
      const lo = i === 0 ? this.min.x : i === 1 ? this.min.y : this.min.z;
      const hi = i === 0 ? this.max.x : i === 1 ? this.max.y : this.max.z;
      let t1 = (lo - o) * d;
      let t2 = (hi - o) * d;
      let s = -1;
      if (t1 > t2) {
        const t = t1;
        t1 = t2;
        t2 = t;
        s = 1;
      }
      if (t1 > tmin) {
        tmin = t1;
        axis = i;
        sign = s;
      }
      if (t2 < tmax) tmax = t2;
      if (tmin > tmax) return false;
    }
    if (tmax < tmin) return false;
    tMinMax[0] = tmin;
    tMinMax[1] = tmax;
    if (hit && tmin >= 0) {
      hit.normal.set(axis === 0 ? sign : 0, axis === 1 ? sign : 0, axis === 2 ? sign : 0);
    }
    return true;
  }

  /**
   * Transform an AABB by an affine matrix and return the enclosing AABB.
   * Standard "transform the 3 basis extents" approach — no per-corner loop, allocation-free.
   */
  transformByMatrix(m: Mat4, out: AABB): AABB {
    const center = this.getCenter(scratch);
    const extent = this.getExtent(scratchB);
    const me = m.m;
    // Uses three module scratch vectors; safe because AABBs are never transformed inside
    // another AABB transform (asserted by the geometry tests).
    const nc = scratchC.set(
      me[0]! * center.x + me[4]! * center.y + me[8]! * center.z + me[12]!,
      me[1]! * center.x + me[5]! * center.y + me[9]! * center.z + me[13]!,
      me[2]! * center.x + me[6]! * center.y + me[10]! * center.z + me[14]!,
    );
    const ne = scratch.set(
      Math.abs(me[0]!) * extent.x + Math.abs(me[4]!) * extent.y + Math.abs(me[8]!) * extent.z,
      Math.abs(me[1]!) * extent.x + Math.abs(me[5]!) * extent.y + Math.abs(me[9]!) * extent.z,
      Math.abs(me[2]!) * extent.x + Math.abs(me[6]!) * extent.y + Math.abs(me[10]!) * extent.z,
    );
    return out.setFrom(
      scratchB.set(nc.x - ne.x, nc.y - ne.y, nc.z - ne.z),
      scratchD.set(nc.x + ne.x, nc.y + ne.y, nc.z + ne.z),
    );
  }

  clone(): AABB {
    return new AABB(this.min.clone(), this.max.clone());
  }
}

// Module scratch pool for geometry helpers. Functions that use these never call each other
// with overlapping lifetimes; the AABB/sphere tests document the constraint.
const scratch = new Vec3();
const scratchB = new Vec3();
const scratchC = new Vec3();
const scratchD = new Vec3();

/** Bounding sphere: conservative, cheap to test, used for hierarchical culling. */
export class BoundingSphere {
  readonly center = new Vec3();
  radius = 0;

  constructor(center?: Vec3Ops, radius = 0) {
    if (center) this.center.copyFrom(center);
    this.radius = radius;
  }

  setFrom(center: Vec3Ops, radius: number): this {
    this.center.copyFrom(center);
    this.radius = radius;
    return this;
  }

  containsPoint(p: Vec3Ops): boolean {
    return Vec3.distanceSqBetween(this.center, p) <= this.radius * this.radius;
  }

  distanceToPlaneSigned(p: PlaneLike, point: Vec3 = scratch): number {
    point.copyFrom(this.center);
    return p.distanceToPoint(point) + this.radius;
  }

  intersectsSphere(s: BoundingSphere): boolean {
    const r = this.radius + s.radius;
    return Vec3.distanceSqBetween(this.center, s.center) <= r * r;
  }

  unionWith(aabb: AABB): this {
    aabb.getCenter(this.center);
    this.radius = Vec3.distanceSqBetween(this.center, aabb.max);
    this.radius = Math.sqrt(this.radius);
    return this;
  }
}

export interface PlaneLike {
  readonly nx: number;
  readonly ny: number;
  readonly nz: number;
  readonly d: number;
  distanceToPoint(p: Vec3Ops): number;
}

/** Plane in normalized normal form: dot(n, p) + d = 0. */
export class Plane implements PlaneLike {
  nx = 0;
  ny = 1;
  nz = 0;
  d = 0;

  constructor(nx = 0, ny = 1, nz = 0, d = 0) {
    const l = Math.hypot(nx, ny, nz);
    if (l > EPSILON) {
      this.nx = nx / l;
      this.ny = ny / l;
      this.nz = nz / l;
      this.d = d / l;
    }
  }

  static fromNormalAndPoint(normal: Vec3Ops, point: Vec3Ops): Plane {
    const p = new Plane(normal.x, normal.y, normal.z, 0);
    p.d = -(p.nx * point.x + p.ny * point.y + p.nz * point.z);
    return p;
  }

  static from3Points(a: Vec3Ops, b: Vec3Ops, c: Vec3Ops): Plane {
    const ab = scratch.set(b.x - a.x, b.y - a.y, b.z - a.z);
    const ac = scratchB.set(c.x - a.x, c.y - a.y, c.z - a.z);
    const nx = ab.y * ac.z - ab.z * ac.y;
    const ny = ab.z * ac.x - ab.x * ac.z;
    const nz = ab.x * ac.y - ab.y * ac.x;
    return new Plane(nx, ny, nz, -(nx * a.x + ny * a.y + nz * a.z));
  }

  distanceToPoint(p: Vec3Ops): number {
    return this.nx * p.x + this.ny * p.y + this.nz * p.z + this.d;
  }

  projectPoint(p: Vec3Ops, out: Vec3): Vec3 {
    const d = this.distanceToPoint(p);
    return out.set(p.x - this.nx * d, p.y - this.ny * d, p.z - this.nz * d);
  }

  normalize(): this {
    const l = Math.hypot(this.nx, this.ny, this.nz);
    if (l > EPSILON) {
      this.nx /= l;
      this.ny /= l;
      this.nz /= l;
      this.d /= l;
    }
    return this;
  }

  /** Signed closest distance; positive means the point is on the side the normal faces. */
  distanceToSphere(center: Vec3Ops, radius: number): number {
    return this.distanceToPoint(center) + radius;
  }
}

/** Ray with cached inverse direction for slab tests. */
export class Ray {
  readonly origin = new Vec3();
  readonly direction = new Vec3(0, 0, 1);
  readonly invDirection = new Vec3(1, 1, 1);
  /** Maximum distance the ray is considered (Infinity by default). */
  maxDistance = Infinity;

  constructor(origin?: Vec3Ops, direction?: Vec3Ops, maxDistance = Infinity) {
    if (origin) this.origin.copyFrom(origin);
    if (direction) this.setDirection(direction.x, direction.y, direction.z);
    this.maxDistance = maxDistance;
  }

  setFrom(origin: Vec3Ops, direction: Vec3Ops, maxDistance = Infinity): this {
    this.origin.copyFrom(origin);
    this.setDirection(direction.x, direction.y, direction.z);
    this.maxDistance = maxDistance;
    return this;
  }

  setDirection(x: number, y: number, z: number): this {
    const l = Math.hypot(x, y, z);
    const inv = l > EPSILON ? 1 / l : 0;
    this.direction.x = x * inv;
    this.direction.y = y * inv;
    this.direction.z = z * inv;
    const eps = 1e-12;
    this.invDirection.x = 1 / (this.direction.x + Math.sign(this.direction.x || 1) * eps);
    this.invDirection.y = 1 / (this.direction.y + Math.sign(this.direction.y || 1) * eps);
    this.invDirection.z = 1 / (this.direction.z + Math.sign(this.direction.z || 1) * eps);
    return this;
  }

  at(t: number, out: Vec3): Vec3 {
    return out.set(
      this.origin.x + this.direction.x * t,
      this.origin.y + this.direction.y * t,
      this.origin.z + this.direction.z * t,
    );
  }

  /**
   * Slab test against an AABB. Writes distance/point/normal into `hit`.
   * The hit normal is only meaningful when the ray starts outside the box; for a ray
   * originating inside, the normal is left at whatever the far-plane exit produced, which
   * callers (physics queries) treat as "no surface" via `hit.distance < 0`.
   */
  intersectsAABB(box: AABB, hit: RayHit): boolean {
    const t = hitT;
    t[0] = 0;
    t[1] = this.maxDistance;
    if (!box.intersectsRay(this.origin, this.invDirection, t, hit)) return false;
    let best = t[0]!;
    let inside = false;
    if (best < 0) {
      best = t[1]!;
      inside = true;
    }
    if (best < 0 || best > this.maxDistance) return false;
    hit.distance = best;
    hit.inside = inside;
    this.at(best, hit.point);
    return true;
  }

  /** Returns t or -1. */
  intersectsSphere(center: Vec3Ops, radius: number): number {
    const ox = this.origin.x - center.x;
    const oy = this.origin.y - center.y;
    const oz = this.origin.z - center.z;
    const b = ox * this.direction.x + oy * this.direction.y + oz * this.direction.z;
    const c = ox * ox + oy * oy + oz * oz - radius * radius;
    const disc = b * b - c;
    if (disc < 0) return -1;
    const s = Math.sqrt(disc);
    let t = -b - s;
    if (t < 0) t = -b + s;
    return t >= 0 && t <= this.maxDistance ? t : -1;
  }

  intersectsPlane(plane: PlaneLike, hit: RayHit): boolean {
    const denom = plane.nx * this.direction.x + plane.ny * this.direction.y + plane.nz * this.direction.z;
    if (Math.abs(denom) < 1e-8) return false;
    const t = -(plane.nx * this.origin.x + plane.ny * this.origin.y + plane.nz * this.origin.z + plane.d) / denom;
    if (t < 0 || t > this.maxDistance) return false;
    hit.distance = t;
    this.at(t, hit.point);
    hit.normal.set(plane.nx, plane.ny, plane.nz);
    return true;
  }

  /**
   * Möller–Trumbore triangle intersection. `cullBackface` rejects triangles facing away from
   * the ray (based on winding in this left-handed convention).
   */
  intersectsTriangle(
    a: Vec3Ops,
    b: Vec3Ops,
    c: Vec3Ops,
    hit: RayHit,
    cullBackface = false,
  ): boolean {
    const e1x = b.x - a.x;
    const e1y = b.y - a.y;
    const e1z = b.z - a.z;
    const e2x = c.x - a.x;
    const e2y = c.y - a.y;
    const e2z = c.z - a.z;
    const px = this.direction.y * e2z - this.direction.z * e2y;
    const py = this.direction.z * e2x - this.direction.x * e2z;
    const pz = this.direction.x * e2y - this.direction.y * e2x;
    const det = e1x * px + e1y * py + e1z * pz;
    if (cullBackface ? det < EPSILON : Math.abs(det) < EPSILON) return false;
    const invDet = 1 / det;
    const tx = this.origin.x - a.x;
    const ty = this.origin.y - a.y;
    const tz = this.origin.z - a.z;
    const u = (tx * px + ty * py + tz * pz) * invDet;
    if (u < -1e-6 || u > 1.000001) return false;
    const qx = ty * e1z - tz * e1y;
    const qy = tz * e1x - tx * e1z;
    const qz = tx * e1y - ty * e1x;
    const v = (this.direction.x * qx + this.direction.y * qy + this.direction.z * qz) * invDet;
    if (v < -1e-6 || u + v > 1.000001) return false;
    const t = (e2x * qx + e2y * qy + e2z * qz) * invDet;
    if (t < 0 || t > this.maxDistance) return false;
    hit.distance = t;
    this.at(t, hit.point);
    hit.normal.set(e1y * e2z - e1z * e2y, e1z * e2x - e1x * e2z, e1x * e2y - e1y * e2x).normalize();
    return true;
  }
}

const hitT = new Float32Array(2);

/** Result of a ray/shape cast. Reused by the query APIs to avoid per-hit allocation. */
export class RayHit {
  distance = 0;
  readonly point = new Vec3();
  readonly normal = new Vec3();
  /** Opaque user tag, e.g. an entity id or chunk key. */
  tag = -1;
  /** Sub-object index (triangle index / shape index). */
  index = -1;
  isValid = false;
  /** True when the ray origin was inside the volume (no front-facing surface). */
  inside = false;

  reset(): this {
    this.distance = 0;
    this.tag = -1;
    this.index = -1;
    this.isValid = false;
    this.inside = false;
    this.point.set(0, 0, 0);
    this.normal.set(0, 1, 0);
    return this;
  }

  copyFrom(other: RayHit): this {
    this.distance = other.distance;
    this.point.copyFrom(other.point);
    this.normal.copyFrom(other.normal);
    this.tag = other.tag;
    this.index = other.index;
    this.isValid = other.isValid;
    this.inside = other.inside;
    return this;
  }
}

/** Result of a bounds-vs-frustum classification. */
export const PlaneTest = {
  /** Fully outside. */
  Outside: 0,
  /** Partially inside — needs a per-triangle or per-child test. */
  Crossing: 1,
  /** Fully inside — no further test needed for descendants. */
  Inside: 2,
} as const;
export type PlaneTest = (typeof PlaneTest)[keyof typeof PlaneTest];

/**
 * Frustum built from a view-projection matrix using the classic Gribb–Hartmann plane
 * extraction. Planes face *inward*, so `distanceToPoint > 0` means "inside".
 */
export class Frustum {
  /** 6 planes × (nx,ny,nz,d): near, far, left, right, bottom, top. */
  readonly planes = new Float32Array(24);

  setFromViewProjection(vp: Mat4): this {
    this.extractStandard(vp.m);
    return this;
  }

  private extractStandard(m: Float32Array): void {
    const p = this.planes;
    const rows = [
      [m[0]!, m[4]!, m[8]!, m[12]!],
      [m[1]!, m[5]!, m[9]!, m[13]!],
      [m[2]!, m[6]!, m[10]!, m[14]!],
      [m[3]!, m[7]!, m[11]!, m[15]!],
    ];
    const write = (i: number, v: number[]) => {
      const l = Math.hypot(v[0]!, v[1]!, v[2]!) || 1;
      p[i * 4] = v[0]! / l;
      p[i * 4 + 1] = v[1]! / l;
      p[i * 4 + 2] = v[2]! / l;
      p[i * 4 + 3] = v[3]! / l;
    };
    const add = (a: number[], b: number[]) => [a[0]! + b[0]!, a[1]! + b[1]!, a[2]! + b[2]!, a[3]! + b[3]!];
    const sub = (a: number[], b: number[]) => [a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!, a[3]! - b[3]!];
    // WebGPU NDC z ∈ [0,1] with clipW = z (see Mat4.setPerspective): the near plane is clipZ = 0 and
    // the far plane is clipZ = clipW. Using the OpenGL pair (z+w / w-z) here culls everything just
    // in front of the camera and keeps everything behind it, which is a very confusing way to have an
    // empty frame.
    write(0, [rows[2]![0]!, rows[2]![1]!, rows[2]![2]!, rows[2]![3]!]); // z >= 0
    write(1, sub(rows[3]!, rows[2]!)); // w - z >= 0
    write(2, add(rows[0]!, rows[3]!));
    write(3, sub(rows[3]!, rows[0]!));
    write(4, add(rows[1]!, rows[3]!));
    write(5, sub(rows[3]!, rows[1]!));
  }

  plane(i: number): { nx: number; ny: number; nz: number; d: number; distanceToPoint: (p: Vec3Ops) => number } {
    const p = this.planes;
    const o = {
      nx: p[i * 4]!,
      ny: p[i * 4 + 1]!,
      nz: p[i * 4 + 2]!,
      d: p[i * 4 + 3]!,
      distanceToPoint(v: Vec3Ops) {
        return this.nx * v.x + this.ny * v.y + this.nz * v.z + this.d;
      },
    };
    return o;
  }

  /** Point containment (a tiny epsilon so points exactly on a plane count as inside). */
  containsPoint(v: Vec3Ops, epsilon = 1e-4): boolean {
    const p = this.planes;
    for (let i = 0; i < 6; i++) {
      if (p[i * 4]! * v.x + p[i * 4 + 1]! * v.y + p[i * 4 + 2]! * v.z + p[i * 4 + 3]! < -epsilon) return false;
    }
    return true;
  }

  /** Conservative sphere test. Returns true when the sphere is at least partly inside. */
  intersectsSphere(center: Vec3Ops, radius: number): boolean {
    const p = this.planes;
    for (let i = 0; i < 6; i++) {
      const dist = p[i * 4]! * center.x + p[i * 4 + 1]! * center.y + p[i * 4 + 2]! * center.z + p[i * 4 + 3]!;
      if (dist < -radius) return false;
    }
    return true;
  }

  /** 0 = outside, 1 = crossing, 2 = fully inside. */
  classifyAABB(box: AABB): PlaneTest {
    const p = this.planes;
    let allInside = true;
    for (let i = 0; i < 6; i++) {
      const nx = p[i * 4]!;
      const ny = p[i * 4 + 1]!;
      const nz = p[i * 4 + 2]!;
      const d = p[i * 4 + 3]!;
      // Positive vertex of the box w.r.t. this plane.
      const px = nx > 0 ? box.max.x : box.min.x;
      const py = ny > 0 ? box.max.y : box.min.y;
      const pz = nz > 0 ? box.max.z : box.min.z;
      const nx2 = nx > 0 ? box.min.x : box.max.x;
      const ny2 = ny > 0 ? box.min.y : box.max.y;
      const nz2 = nz > 0 ? box.min.z : box.max.z;
      if (nx * px + ny * py + nz * pz + d < 0) return PlaneTest.Outside;
      const negative = nx * nx2 + ny * ny2 + nz * nz2 + d < 0;
      if (negative) allInside = false;
    }
    return allInside ? PlaneTest.Inside : PlaneTest.Crossing;
  }

  intersectsAABB(box: AABB): boolean {
    return this.classifyAABB(box) !== PlaneTest.Outside;
  }
}

/** OBB: used for debug drawing, physics box shapes and better fitting than AABB for rotated props. */
export class OBB {
  readonly center = new Vec3();
  readonly halfExtent = new Vec3(0.5, 0.5, 0.5);
  /** Column-major 3x3 rotation. */
  readonly axes = new Float32Array(9);

  setFromMat4AndExtent(m: Mat4, halfExtent: Vec3Ops): this {
    this.center.set(m.m[12]!, m.m[13]!, m.m[14]!);
    this.halfExtent.copyFrom(halfExtent);
    const a = this.axes;
    const me = m.m;
    for (let c = 0; c < 3; c++) {
      const x = me[c * 4]!;
      const y = me[c * 4 + 1]!;
      const z = me[c * 4 + 2]!;
      const l = Math.hypot(x, y, z) || 1;
      a[c * 3] = x / l;
      a[c * 3 + 1] = y / l;
      a[c * 3 + 2] = z / l;
    }
    return this;
  }

  /** Projected-radius test against the frustum planes (conservative, no SAT needed). */
  intersectsFrustum(frustum: Frustum): boolean {
    const p = frustum.planes;
    const a = this.axes;
    const c = this.center;
    const h = this.halfExtent;
    for (let i = 0; i < 6; i++) {
      const nx = p[i * 4]!;
      const ny = p[i * 4 + 1]!;
      const nz = p[i * 4 + 2]!;
      const r =
        Math.abs(nx * a[0]! + ny * a[3]! + nz * a[6]!) * h.x +
        Math.abs(nx * a[1]! + ny * a[4]! + nz * a[7]!) * h.y +
        Math.abs(nx * a[2]! + ny * a[5]! + nz * a[8]!) * h.z;
      const dist = nx * c.x + ny * c.y + nz * c.z + p[i * 4 + 3]!;
      if (dist < -r) return false;
    }
    return true;
  }

  /** Conservative test against an axis-aligned box by re-deriving an enclosing AABB. */
  toAABB(out: AABB): AABB {
    const a = this.axes;
    const h = this.halfExtent;
    const c = this.center;
    const ex = Math.abs(a[0]!) * h.x + Math.abs(a[3]!) * h.y + Math.abs(a[6]!) * h.z;
    const ey = Math.abs(a[1]!) * h.x + Math.abs(a[4]!) * h.y + Math.abs(a[7]!) * h.z;
    const ez = Math.abs(a[2]!) * h.x + Math.abs(a[5]!) * h.y + Math.abs(a[8]!) * h.z;
    return out.setFrom(scratchC.set(c.x - ex, c.y - ey, c.z - ez), scratchD.set(c.x + ex, c.y + ey, c.z + ez));
  }
}
