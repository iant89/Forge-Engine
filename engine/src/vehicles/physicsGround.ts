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
import type { HeightfieldShape } from "../physics/shapes.js";
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

/**
 * Build a GroundQuery directly from a HeightfieldShape (same object registered on the physics world).
 */
export function heightfieldGroundQuery(shape: HeightfieldShape): GroundQuery {
  const normal = new Vec3();
  return {
    sample(x, z, out) {
      out.height = shape.sampleHeight(x, z);
      const n = shape.sampleNormal(x, z, normal);
      out.nx = n.x;
      out.ny = n.y;
      out.nz = n.z;
    },
  };
}

const rayOrigin = new Vec3();
const ray = new Ray(rayOrigin, { x: 0, y: -1, z: 0 }, 64);
const hit = new RayHit();

/**
 * Wheel contact via a downward physics raycast (Phase 11.5).
 * Uses the backend raycast so heightfield and other colliders participate.
 */
export function physicsRaycastGroundQuery(backend: PhysicsBackend, maxDistance = 64): GroundQuery {
  return {
    sample(x, z, out) {
      ray.setFrom({ x, y: maxDistance * 0.5, z }, { x: 0, y: -1, z: 0 }, maxDistance);
      hit.reset();
      if (backend.raycast(ray, hit) && hit.isValid) {
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
