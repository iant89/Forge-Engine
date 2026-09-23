/**
 * Ground queries backed by the physics backend / heightfield collider (Phase 11.5).
 *
 * Visual terrain, terrain collision, and vehicle contact must share one sampler. These helpers
 * wrap {@link PhysicsBackend.sampleGround} and downward physics raycasts so the vehicle no longer
 * needs a parallel heightfield-only path.
 */

import { Ray, RayHit } from "../math/geometry.js";
import { Vec3 } from "../math/vec.js";
import type { PhysicsBackend } from "../physics/backend.js";
import type { RigidBody } from "../physics/body.js";
import type { GroundQuery } from "./ground.js";

/**
 * Sample the backend's registered heightfield. Falls back to a flat plane at y=0 if none is set.
 */
export function physicsGroundQuery(backend: PhysicsBackend, fallbackHeight = 0): GroundQuery {
  return {
    sample(x, z, out) {
      if (!backend.sampleGround(x, z, out)) {
        out.height = fallbackHeight;
        out.nx = 0;
        out.ny = 1;
        out.nz = 0;
      }
    },
  };
}

export interface PhysicsRaycastGroundOptions {
  /** Max ray length (also used as half-length origin height). Default 64. */
  maxDistance?: number;
  /** Skip the vehicle chassis (or any other body) so wheel rays cannot self-hit. */
  excludeBody?: RigidBody | null;
  /**
   * Skip kinematic bodies. Defaults to true so a kinematic chassis cannot register as ground.
   */
  skipKinematic?: boolean;
}

const rayOrigin = new Vec3();
const ray = new Ray(rayOrigin, { x: 0, y: -1, z: 0 }, 64);
const hit = new RayHit();

/**
 * Wheel contact via a downward physics raycast (Phase 11.5).
 * Uses the backend raycast so heightfield and other colliders participate.
 * By default skips kinematic bodies and can exclude a specific chassis body.
 */
export function physicsRaycastGroundQuery(
  backend: PhysicsBackend,
  maxDistanceOrOptions: number | PhysicsRaycastGroundOptions = 64,
): GroundQuery {
  const options: PhysicsRaycastGroundOptions =
    typeof maxDistanceOrOptions === "number"
      ? { maxDistance: maxDistanceOrOptions }
      : maxDistanceOrOptions;
  const maxDistance = options.maxDistance ?? 64;
  const skipKinematic = options.skipKinematic !== false;
  const excludeBody = options.excludeBody ?? null;
  return {
    sample(x, z, out) {
      ray.setFrom({ x, y: maxDistance * 0.5, z }, { x: 0, y: -1, z: 0 }, maxDistance);
      hit.reset();
      const filter = {
        skipKinematic,
        excludeBodies: excludeBody ? [excludeBody] : null,
      };
      if (backend.raycast(ray, hit, filter) && hit.isValid) {
        out.height = hit.point.y;
        out.nx = hit.normal.x;
        out.ny = hit.normal.y;
        out.nz = hit.normal.z;
        return;
      }
      // Fall back to heightfield sample when the ray misses (e.g. origin already underground).
      if (!backend.sampleGround(x, z, out)) {
        out.height = 0;
        out.nx = 0;
        out.ny = 1;
        out.nz = 0;
      }
    },
  };
}

/** Validate the Phase 11.6 invariant at a point: visual == collision == vehicle contact. */
export function assertTerrainAgreement(
  visualHeight: number,
  collisionHeight: number,
  vehicleHeight: number,
  epsilon = 1e-4,
): boolean {
  return (
    Math.abs(visualHeight - collisionHeight) <= epsilon &&
    Math.abs(visualHeight - vehicleHeight) <= epsilon
  );
}
