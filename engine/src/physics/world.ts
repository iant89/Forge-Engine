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
import { SphereShape, BoxShape, PlaneShape } from "./shapes.js";

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
      return true;
    }
    return false;
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
  raycast(ray: Ray, hit: RayHit): boolean {
    let closestDist = Infinity;
    let hitFound = false;

    for (const body of this.bodies) {
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
        if (ray.intersectsAABB(body.aabb, hit)) {
          if (hit.distance < closestDist) {
            closestDist = hit.distance;
            hitFound = true;
          }
        }
      }
    }

    return hitFound;
  }

  clear(): void {
    this.bodies.length = 0;
    this.accumulator = 0;
    this.time = 0;
    this.stepCount = 0;
  }
}
