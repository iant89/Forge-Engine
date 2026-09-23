/**
 * `PhysicsWorld` — rigid body dynamics simulation world.
 *
 * Implements:
 *  - Fixed timestep simulation with substepping and interpolation
 *  - Deterministic broadphase and narrowphase contact generation
 *  - Bit-for-bit trajectory reproducibility across varying display frame rates
 */

import { Vec3, type Vec3Ops } from "../math/vec.js";
import { Ray, RayHit } from "../math/geometry.js";
import { RigidBody } from "./body.js";
import { ContactManifold, collideBodies } from "./collision.js";
import { SequentialImpulseSolver, type SolverOptions } from "./solver.js";
import { SphereShape, BoxShape, PlaneShape, HeightfieldShape } from "./shapes.js";

export interface RaycastFilter {
  /** Skip these rigid bodies (e.g. the casting vehicle chassis). */
  excludeBodies?: ReadonlyArray<RigidBody> | null;
  /** Skip kinematic bodies (default false on world; ground helpers may enable). */
  skipKinematic?: boolean;
  /** Skip static bodies. */
  skipStatic?: boolean;
}

export interface PhysicsWorldOptions {
  gravity?: Vec3Ops;
  fixedDt?: number;
  maxSubsteps?: number;
  solverOptions?: SolverOptions;
}

export class PhysicsWorld {
  readonly bodies: RigidBody[] = [];
  private nextBodyId = 1;

  readonly gravity = new Vec3(0, -9.81, 0);
  readonly fixedDt: number;
  readonly maxSubsteps: number;
  readonly solver: SequentialImpulseSolver;

  /** Authoritative terrain collider, when registered via setHeightfield. */
  private heightfieldBody: RigidBody | null = null;
  private heightfieldShape: HeightfieldShape | null = null;

  accumulator = 0;
  time = 0;
  stepCount = 0;

  constructor(options: PhysicsWorldOptions = {}) {
    if (options.gravity) this.gravity.copyFrom(options.gravity);
    this.fixedDt = options.fixedDt ?? 1 / 60;
    this.maxSubsteps = options.maxSubsteps ?? 8;
    this.solver = new SequentialImpulseSolver(options.solverOptions);
  }

  addBody(body: RigidBody): RigidBody {
    if (body.id === 0) {
      body.id = this.nextBodyId++;
    }
    if (!this.bodies.includes(body)) {
      this.bodies.push(body);
      body.updateAABB();
    }
    return body;
  }

  removeBody(body: RigidBody): boolean {
    const idx = this.bodies.indexOf(body);
    if (idx >= 0) {
      this.bodies.splice(idx, 1);
      if (body === this.heightfieldBody) {
        this.heightfieldBody = null;
        this.heightfieldShape = null;
      }
      return true;
    }
    return false;
  }

  /**
   * Register a static heightfield collider that uses the same sampleHeight/sampleNormal
   * as visual terrain and vehicle ground queries (Phase 11.2).
   */
  setHeightfield(shape: HeightfieldShape | null): RigidBody | null {
    if (this.heightfieldBody) {
      this.removeBody(this.heightfieldBody);
    }
    if (!shape) return null;
    const body = new RigidBody({
      type: "static",
      shape,
      position: { x: 0, y: 0, z: 0 },
    });
    this.addBody(body);
    this.heightfieldBody = body;
    this.heightfieldShape = shape;
    return body;
  }

  getHeightfield(): HeightfieldShape | null {
    return this.heightfieldShape;
  }

  /** Height from the registered heightfield, or null. */
  queryHeight(x: number, z: number): number | null {
    return this.heightfieldShape ? this.heightfieldShape.sampleHeight(x, z) : null;
  }

  /**
   * Advance simulation by variable frame time `dt`.
   * Executes zero or more fixed steps deterministically and computes render interpolation.
   */
  step(dt: number): number {
    const clampedDt = Math.min(0.2, Math.max(0, dt));
    this.accumulator += clampedDt;

    let substeps = 0;
    while (this.accumulator >= this.fixedDt && substeps < this.maxSubsteps) {
      this.fixedStep(this.fixedDt);
      this.accumulator -= this.fixedDt;
      substeps++;
    }

    // If accumulator exceeds maxSubsteps * fixedDt (e.g. background tab), clamp to prevent spiral of death
    if (this.accumulator > this.fixedDt * 2) {
      this.accumulator = 0;
    }

    const alpha = this.accumulator / this.fixedDt;
    for (const body of this.bodies) {
      body.interpolate(alpha);
    }

    return substeps;
  }

  /**
   * Run exact integer number of fixed steps without interpolation.
   * Guaranteed deterministic across platforms and framerates.
   */
  stepDeterministic(fixedSteps: number): void {
    for (let i = 0; i < fixedSteps; i++) {
      this.fixedStep(this.fixedDt);
    }
  }

  private fixedStep(dt: number): void {
    const n = this.bodies.length;

    // 1. Integrate external forces & gravity to velocities
    for (let i = 0; i < n; i++) {
      this.bodies[i]!.integrateVelocity(dt, this.gravity);
    }

    // 2. Broadphase & Narrowphase: generate contact manifolds
    const manifolds: ContactManifold[] = [];

    // Deterministic pair ordering by (bodyA.id < bodyB.id)
    for (let i = 0; i < n; i++) {
      const bA = this.bodies[i]!;
      for (let j = i + 1; j < n; j++) {
        const bB = this.bodies[j]!;

        // Skip static-static or kinematic-static pairs
        if (bA.invMass === 0 && bB.invMass === 0) continue;

        // AABB overlap test
        if (!bA.aabb.intersectsAABB(bB.aabb)) continue;

        const manifold = collideBodies(bA, bB);
        if (manifold && manifold.contacts.length > 0) {
          manifolds.push(manifold);
        }
      }
    }

    // 3. Solve velocity & position constraints
    this.solver.solve(manifolds, dt);

    // 4. Integrate velocities to positions and update AABBs
    for (let i = 0; i < n; i++) {
      this.bodies[i]!.integratePosition(dt);
    }

    this.time += dt;
    this.stepCount++;
  }

  /**
   * Raycast against physics colliders in the world.
   */
  raycast(ray: Ray, hit: RayHit, filter?: RaycastFilter): boolean {
    let closestDist = Infinity;
    let hitFound = false;
    const scratchHit = PhysicsWorld.rayScratch;
    const exclude = filter?.excludeBodies;

    for (const body of this.bodies) {
      if (filter?.skipKinematic && body.type === "kinematic") continue;
      if (filter?.skipStatic && body.type === "static") continue;
      if (exclude && exclude.length > 0 && exclude.includes(body)) continue;
      const shape = body.shape;
      if (shape instanceof SphereShape) {
        const t = ray.intersectsSphere(body.position, shape.radius);
        if (t >= 0 && t < ray.maxDistance && t < closestDist) {
          closestDist = t;
          hit.distance = t;
          ray.at(t, hit.point);
          hit.normal.set(
            (hit.point.x - body.position.x) / shape.radius,
            (hit.point.y - body.position.y) / shape.radius,
            (hit.point.z - body.position.z) / shape.radius,
          ).normalize();
          hit.isValid = true;
          hitFound = true;
        }
      } else if (shape instanceof PlaneShape) {
        const denom = ray.direction.dot(shape.normal);
        if (Math.abs(denom) > 1e-6) {
          const t = -(ray.origin.dot(shape.normal) + shape.constant) / denom;
          if (t >= 0 && t < ray.maxDistance && t < closestDist) {
            closestDist = t;
            hit.distance = t;
            ray.at(t, hit.point);
            hit.normal.copyFrom(shape.normal);
            hit.isValid = true;
            hitFound = true;
          }
        }
      } else if (shape instanceof BoxShape) {
        if (ray.intersectsAABB(body.aabb, scratchHit) && scratchHit.distance < closestDist) {
          closestDist = scratchHit.distance;
          hit.distance = scratchHit.distance;
          hit.point.copyFrom(scratchHit.point);
          hit.normal.copyFrom(scratchHit.normal);
          hit.isValid = true;
          hitFound = true;
        }
      } else if (shape instanceof HeightfieldShape) {
        if (raycastHeightfield(ray, shape, scratchHit) && scratchHit.distance < closestDist) {
          closestDist = scratchHit.distance;
          hit.distance = scratchHit.distance;
          hit.point.copyFrom(scratchHit.point);
          hit.normal.copyFrom(scratchHit.normal);
          hit.isValid = true;
          hitFound = true;
        }
      }
    }

    return hitFound;
  }

  clear(): void {
    this.bodies.length = 0;
    this.heightfieldBody = null;
    this.heightfieldShape = null;
    this.accumulator = 0;
    this.time = 0;
    this.stepCount = 0;
  }

  private static readonly rayScratch = new RayHit();
}

/**
 * March a ray against a heightfield sampler. Preferential for downward wheel rays;
 * also works for general directions via uniform steps along the ray.
 */
export function raycastHeightfield(ray: Ray, hf: HeightfieldShape, hit: RayHit, steps = 48): boolean {
  const maxT = Math.min(ray.maxDistance, 500);
  if (!(maxT > 0)) return false;
  const dt = maxT / steps;
  let prevAbove = true;
  let prevT = 0;
  for (let i = 0; i <= steps; i++) {
    const t = i * dt;
    const x = ray.origin.x + ray.direction.x * t;
    const y = ray.origin.y + ray.direction.y * t;
    const z = ray.origin.z + ray.direction.z * t;
    const h = hf.sampleHeight(x, z);
    const above = y > h;
    if (i > 0 && prevAbove && !above) {
      // Bisect the crossing for a tighter hit.
      let lo = prevT;
      let hi = t;
      for (let k = 0; k < 8; k++) {
        const mid = (lo + hi) * 0.5;
        const mx = ray.origin.x + ray.direction.x * mid;
        const my = ray.origin.y + ray.direction.y * mid;
        const mz = ray.origin.z + ray.direction.z * mid;
        if (my > hf.sampleHeight(mx, mz)) lo = mid;
        else hi = mid;
      }
      const hitT = hi;
      if (hitT < 0 || hitT > maxT) return false;
      hit.distance = hitT;
      ray.at(hitT, hit.point);
      const n = hf.sampleNormal(hit.point.x, hit.point.z);
      hit.normal.copyFrom(n);
      hit.isValid = true;
      return true;
    }
    // Start already below surface: report t=0 contact.
    if (i === 0 && !above) {
      hit.distance = 0;
      hit.point.set(ray.origin.x, h, ray.origin.z);
      const n = hf.sampleNormal(ray.origin.x, ray.origin.z);
      hit.normal.copyFrom(n);
      hit.isValid = true;
      return true;
    }
    prevAbove = above;
    prevT = t;
  }
  return false;
}
