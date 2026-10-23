/**
 * Vehicle chassis as an optional rigid body in the physics world (Phase 11.3 / 23.3).
 *
 * The default remains a kinematic bridge for existing recipes: the raycast vehicle owns its chassis
 * pose and props can collide with it. `type: "dynamic"` is the opt-in coupling used by the Mars
 * showcase; VehicleSystem exports the wheel-model acceleration and PhysicsSystem advances the body,
 * so solver contacts and CCD can push the chassis without a second independent chassis integrator.
 */

import { Quat } from "../math/mat.js";
import { RigidBody } from "../physics/body.js";
import { BoxShape } from "../physics/shapes.js";
import type { PhysicsBackend } from "../physics/backend.js";
import type { PhysicsWorld } from "../physics/world.js";
import type { Vehicle } from "./vehicle.js";

export interface VehicleChassisOptions {
  /** Kinematic by default; dynamic routes wheel-model acceleration through PhysicsSystem. */
  type?: "kinematic" | "dynamic";
  /** Half-extents of the chassis box. Defaults from vehicle wheelbase/track/cg height. */
  halfExtents?: { x: number; y: number; z: number };
  /** Dynamic-body mass. Defaults to the raycast vehicle mass; ignored for kinematic bodies. */
  mass?: number;
  friction?: number;
  restitution?: number;
  /** Optional rigid-body gravity scale; dynamic coupling subtracts this contribution exactly. */
  gravityScale?: number;
  /** Optional damping overrides. Dynamic vehicle bodies default to zero because Vehicle owns damping. */
  linearDamping?: number;
  angularDamping?: number;
}

/**
 * Attach a kinematic or dynamic chassis collider for `vehicle` to `backend` (or a raw PhysicsWorld).
 */
export function createVehicleChassis(
  vehicle: Vehicle,
  target: PhysicsBackend | PhysicsWorld,
  options: VehicleChassisOptions = {},
): RigidBody {
  const c = vehicle.config;
  const type = options.type ?? "kinematic";
  const half = options.halfExtents ?? {
    x: c.track * 0.45,
    y: Math.max(0.25, c.cgHeight * 0.7),
    z: c.wheelbase * 0.45,
  };
  const body = new RigidBody({
    type,
    shape: new BoxShape(half.x, half.y, half.z),
    mass: type === "dynamic" ? options.mass ?? c.mass : options.mass,
    position: vehicle.position,
    friction: options.friction ?? 0.6,
    restitution: options.restitution ?? 0.05,
    gravityScale: options.gravityScale,
    linearDamping: options.linearDamping ?? (type === "dynamic" ? 0 : undefined),
    angularDamping: options.angularDamping ?? (type === "dynamic" ? 0 : undefined),
  });
  syncVehicleChassis(vehicle, body);
  if ("addBody" in target) {
    target.addBody(body);
  }
  return body;
}

const scratchRot = new Quat();

/** Copy the vehicle's simulated pose onto a chassis collider (for creation/manual non-ECS loops). */
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
