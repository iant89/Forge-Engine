/**
 * Collision Shapes & Geometric Primitives for Physics.
 */

import { Vec3 } from "../math/vec.js";
import { Quat } from "../math/mat.js";
import { AABB } from "../math/geometry.js";
import { UsageError } from "../core/errors.js";

/**
 * Validates a shape dimension and clamps it to a minimum.
 *
 * The clamp is intentional (a degenerate body still needs volume), but it used to be the *only*
 * thing that happened: `new BoxShape(new Vec3(1, 1, 1))` — an easy mistake, since every other
 * engine API takes vectors — produced `Math.max(0.001, object)` = NaN half-extents, and NaN then
 * propagated quietly into AABBs, mass properties and solver impulses. Failing at the call site
 * costs nothing measurable (shapes are constructed once) and turns a distant, confusing failure
 * into a local one.
 */
function dimension(value: number, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new UsageError(
      `${name} must be a finite number, got ` +
        (typeof value === "object" ? "an object (pass its x/y/z components, not a Vec3)" : String(value)),
    );
  }
  return Math.max(0.001, value);
}

export type ShapeType = "sphere" | "box" | "capsule" | "cylinder" | "plane" | "heightfield";

export interface MassProperties {
  mass: number;
  inertia: Vec3;
}

export abstract class Shape {
  abstract readonly type: ShapeType;

  /** Compute world-space axis-aligned bounding box for this shape given pose. */
  abstract computeAABB(position: Vec3, rotation: Quat, out: AABB): void;

  /** Compute mass and diagonal inertia tensor given material density (kg/m^3). */
  abstract computeMass(density: number): MassProperties;
}

// ------------------------------------------------------------------ Sphere

export class SphereShape extends Shape {
  readonly type = "sphere" as const;
  radius: number;

  constructor(radius = 0.5) {
    super();
    this.radius = dimension(radius, "SphereShape.radius");
  }

  computeAABB(position: Vec3, _rotation: Quat, out: AABB): void {
    const r = this.radius;
    out.min.set(position.x - r, position.y - r, position.z - r);
    out.max.set(position.x + r, position.y + r, position.z + r);
  }

  computeMass(density = 1000): MassProperties {
    const r = this.radius;
    const vol = (4 / 3) * Math.PI * r * r * r;
    const mass = vol * density;
    const i = 0.4 * mass * r * r;
    return { mass, inertia: new Vec3(i, i, i) };
  }
}

// ------------------------------------------------------------------ Box

export class BoxShape extends Shape {
  readonly type = "box" as const;
  readonly halfExtents: Vec3;

  constructor(halfX = 0.5, halfY = 0.5, halfZ = 0.5) {
    super();
    this.halfExtents = new Vec3(
      dimension(halfX, "BoxShape.halfX"),
      dimension(halfY, "BoxShape.halfY"),
      dimension(halfZ, "BoxShape.halfZ"),
    );
  }

  computeAABB(position: Vec3, rotation: Quat, out: AABB): void {
    const hx = this.halfExtents.x;
    const hy = this.halfExtents.y;
    const hz = this.halfExtents.z;

    // Transform 3 half-axes by quaternion rotation
    const vX = new Vec3(hx, 0, 0);
    const vY = new Vec3(0, hy, 0);
    const vZ = new Vec3(0, 0, hz);

    rotation.rotateVector(vX, vX);
    rotation.rotateVector(vY, vY);
    rotation.rotateVector(vZ, vZ);

    const rx = Math.abs(vX.x) + Math.abs(vY.x) + Math.abs(vZ.x);
    const ry = Math.abs(vX.y) + Math.abs(vY.y) + Math.abs(vZ.y);
    const rz = Math.abs(vX.z) + Math.abs(vY.z) + Math.abs(vZ.z);

    out.min.set(position.x - rx, position.y - ry, position.z - rz);
    out.max.set(position.x + rx, position.y + ry, position.z + rz);
  }

  computeMass(density = 1000): MassProperties {
    const dx = this.halfExtents.x * 2;
    const dy = this.halfExtents.y * 2;
    const dz = this.halfExtents.z * 2;
    const mass = dx * dy * dz * density;
    const f = mass / 12;
    return {
      mass,
      inertia: new Vec3(
        f * (dy * dy + dz * dz),
        f * (dx * dx + dz * dz),
        f * (dx * dx + dy * dy),
      ),
    };
  }
}

// ------------------------------------------------------------------ Capsule

export class CapsuleShape extends Shape {
  readonly type = "capsule" as const;
  radius: number;
  halfHeight: number;

  constructor(radius = 0.5, halfHeight = 0.5) {
    super();
    this.radius = dimension(radius, "CapsuleShape.radius");
    this.halfHeight = dimension(halfHeight, "CapsuleShape.halfHeight");
  }

  computeAABB(position: Vec3, rotation: Quat, out: AABB): void {
    const r = this.radius;
    const h = this.halfHeight;
    const axisY = new Vec3(0, h, 0);
    rotation.rotateVector(axisY, axisY);

    const ex = Math.abs(axisY.x) + r;
    const ey = Math.abs(axisY.y) + r;
    const ez = Math.abs(axisY.z) + r;

    out.min.set(position.x - ex, position.y - ey, position.z - ez);
    out.max.set(position.x + ex, position.y + ey, position.z + ez);
  }

  computeMass(density = 1000): MassProperties {
    const r = this.radius;
    const h = this.halfHeight * 2;
    const cylVol = Math.PI * r * r * h;
    const capVol = (4 / 3) * Math.PI * r * r * r;
    const mass = (cylVol + capVol) * density;
    const iY = 0.5 * mass * r * r;
    const iXZ = (1 / 12) * mass * (3 * r * r + h * h);
    return { mass, inertia: new Vec3(iXZ, iY, iXZ) };
  }
}

// ------------------------------------------------------------------ Cylinder

export class CylinderShape extends Shape {
  readonly type = "cylinder" as const;
  radius: number;
  halfHeight: number;

  constructor(radius = 0.5, halfHeight = 0.5) {
    super();
    this.radius = dimension(radius, "CylinderShape.radius");
    this.halfHeight = dimension(halfHeight, "CylinderShape.halfHeight");
  }

  computeAABB(position: Vec3, rotation: Quat, out: AABB): void {
    const r = this.radius;
    const h = this.halfHeight;
    const axisY = new Vec3(0, h, 0);
    rotation.rotateVector(axisY, axisY);

    const ex = Math.abs(axisY.x) + r;
    const ey = Math.abs(axisY.y) + r;
    const ez = Math.abs(axisY.z) + r;

    out.min.set(position.x - ex, position.y - ey, position.z - ez);
    out.max.set(position.x + ex, position.y + ey, position.z + ez);
  }

  computeMass(density = 1000): MassProperties {
    const r = this.radius;
    const h = this.halfHeight * 2;
    const mass = Math.PI * r * r * h * density;
    const iY = 0.5 * mass * r * r;
    const iXZ = (1 / 12) * mass * (3 * r * r + h * h);
    return { mass, inertia: new Vec3(iXZ, iY, iXZ) };
  }
}

// ------------------------------------------------------------------ Infinite Plane

export class PlaneShape extends Shape {
  readonly type = "plane" as const;
  readonly normal = new Vec3(0, 1, 0);
  constant: number;

  constructor(normal?: Vec3, constant = 0) {
    super();
    if (normal) {
      this.normal.copyFrom(normal).normalize();
    }
    this.constant = constant;
  }

  computeAABB(_position: Vec3, _rotation: Quat, out: AABB): void {
    out.min.set(-1e6, -1e6, -1e6);
    out.max.set(1e6, 1e6, 1e6);
  }

  computeMass(): MassProperties {
    return { mass: 0, inertia: new Vec3(0, 0, 0) };
  }
}

// ------------------------------------------------------------------ Heightfield

export interface HeightfieldShapeOptions {
  sampleHeight: (x: number, z: number) => number;
  sampleNormal?: (x: number, z: number, out?: Vec3) => Vec3;
  bounds?: AABB;
}

export class HeightfieldShape extends Shape {
  readonly type = "heightfield" as const;
  readonly sampleHeight: (x: number, z: number) => number;
  readonly sampleNormal: (x: number, z: number, out?: Vec3) => Vec3;
  readonly bounds: AABB;

  constructor(options: HeightfieldShapeOptions) {
    super();
    this.sampleHeight = options.sampleHeight;
    this.sampleNormal =
      options.sampleNormal ??
      ((x, z, out = new Vec3()) => {
        const eps = 0.2;
        const hL = this.sampleHeight(x - eps, z);
        const hR = this.sampleHeight(x + eps, z);
        const hD = this.sampleHeight(x, z - eps);
        const hU = this.sampleHeight(x, z + eps);
        out.set(-(hR - hL) / (2 * eps), 1, -(hU - hD) / (2 * eps));
        return out.normalize();
      });
    this.bounds = options.bounds ?? new AABB(new Vec3(-1e4, -1000, -1e4), new Vec3(1e4, 2000, 1e4));
  }

  computeAABB(_position: Vec3, _rotation: Quat, out: AABB): void {
    out.min.copyFrom(this.bounds.min);
    out.max.copyFrom(this.bounds.max);
  }

  computeMass(): MassProperties {
    return { mass: 0, inertia: new Vec3(0, 0, 0) };
  }
}
