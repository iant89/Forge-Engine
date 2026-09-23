/**
 * Vehicle chassis as a kinematic rigid body in the physics world (Phase 11.3).
 *
 * The raycast vehicle still owns linear/angular integration for driving feel; the chassis body
 * participates in the Phase 5 collision world so props and other dynamics can bounce off the car.
 */

import { Quat } from "../math/mat.js";
import { RigidBody } from "../physics/body.js";
import { BoxShape } from "../physics/shapes.js";
import type { PhysicsBackend } from "../physics/backend.js";
import type { PhysicsWorld } from "../physics/world.js";
import type { Vehicle } from "./vehicle.js";

export interface VehicleChassisOptions {
  /** Half-extents of the chassis box. Defaults from vehicle wheelbase/track/cg height. */
  halfExtents?: { x: number; y: number; z: number };
  friction?: number;
  restitution?: number;
}

/**
 * Attach a kinematic chassis collider for `vehicle` to `backend` (or a raw PhysicsWorld).
 */
export function createVehicleChassis(
  vehicle: Vehicle,
  target: PhysicsBackend | PhysicsWorld,
  options: VehicleChassisOptions = {},
): RigidBody {
  const c = vehicle.config;
  const half = options.halfExtents ?? {
    x: c.track * 0.45,
    y: Math.max(0.25, c.cgHeight * 0.7),
    z: c.wheelbase * 0.45,
  };
  const body = new RigidBody({
    type: "kinematic",
    shape: new BoxShape(half.x, half.y, half.z),
    position: vehicle.position,
    friction: options.friction ?? 0.6,
    restitution: options.restitution ?? 0.05,
  });
  syncVehicleChassis(vehicle, body);
  if ("addBody" in target) {
    target.addBody(body);
  }
  return body;
}

const scratchRot = new Quat();

/** Copy the vehicle's simulated pose onto the kinematic chassis collider. */
export function syncVehicleChassis(vehicle: Vehicle, body: RigidBody): void {
  body.position.copyFrom(vehicle.position);
  vehicle.writeRotation(scratchRot);
  body.rotation.copyFrom(scratchRot);
  body.linearVelocity.copyFrom(vehicle.velocity);
  // pitch/yaw/roll rates are body-axis Euler rates — map to world ω for contact spin.
  vehicle.writeAngularVelocity(body.angularVelocity);
  body.prevPosition.copyFrom(body.position);
  body.prevRotation.copyFrom(body.rotation);
  body.updateAABB();
  body.updateInertiaWorld();
}
