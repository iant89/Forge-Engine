/**
 * Internal coupling between the raycast vehicle model and an optional dynamic chassis body.
 *
 * Fixed ECS systems are not interleaved: VehicleSystem produces one command per vehicle substep,
 * then PhysicsSystem consumes that command while it runs the matching PhysicsWorld substep. Keeping
 * the queue here prevents a hitch frame from accumulating all of its forces into the first rigid
 * body step.
 */

import { clamp } from "../math/scalar.js";
import { DMath } from "../math/detmath.js";
import { Vec3 } from "../math/vec.js";
import type { RigidBody } from "../physics/body.js";
import type { VehicleComponent } from "./components.js";
import { syncVehicleVelocityFromBody, type Vehicle } from "./vehicle.js";

interface DynamicChassisCommand {
  readonly linearAcceleration: Vec3;
  readonly angularAcceleration: Vec3;
}

interface DynamicChassisBuffer {
  frame: number;
  count: number;
  readonly commands: DynamicChassisCommand[];
}

const buffers = new WeakMap<VehicleComponent, DynamicChassisBuffer>();

const scratchForward = new Vec3();
const scratchRight = new Vec3();
const scratchLocalOmega = new Vec3();
const scratchLocalAngularTorque = new Vec3();
const scratchWorldAngularTorque = new Vec3();
const scratchForce = new Vec3();

function commandBuffer(component: VehicleComponent): DynamicChassisBuffer {
  let buffer = buffers.get(component);
  if (!buffer) {
    buffer = { frame: -1, count: 0, commands: [] };
    buffers.set(component, buffer);
  }
  return buffer;
}

/** Begin the fixed-frame command buffer for one VehicleComponent. */
export function prepareDynamicChassisFrame(component: VehicleComponent, fixedSteps: number, frame: number): void {
  const buffer = commandBuffer(component);
  const count = Math.max(0, fixedSteps | 0);
  while (buffer.commands.length < count) {
    buffer.commands.push({ linearAcceleration: new Vec3(), angularAcceleration: new Vec3() });
  }
  buffer.frame = frame;
  buffer.count = count;
  for (let i = 0; i < count; i++) {
    buffer.commands[i]!.linearAcceleration.set(0, 0, 0);
    buffer.commands[i]!.angularAcceleration.set(0, 0, 0);
  }
}

/** Record the raycast model's requested acceleration for one matching physics substep. */
export function writeDynamicChassisStep(
  component: VehicleComponent,
  step: number,
  frame: number,
  linearAcceleration: Vec3,
  angularAcceleration: Vec3,
): void {
  const buffer = commandBuffer(component);
  if (buffer.frame !== frame || step < 0 || step >= buffer.count) return;
  const command = buffer.commands[step]!;
  command.linearAcceleration.copyFrom(linearAcceleration);
  command.angularAcceleration.copyFrom(angularAcceleration);
}

/** Read a command only when it belongs to the current ECS frame. */
function dynamicChassisStep(
  component: VehicleComponent,
  step: number,
  frame: number,
): DynamicChassisCommand | null {
  const buffer = buffers.get(component);
  if (!buffer || buffer.frame !== frame || step < 0 || step >= buffer.count) return null;
  return buffer.commands[step] ?? null;
}

/**
 * Copy the authoritative dynamic-body pose back into the raycast model. The raycast integrator
 * remains responsible for wheel spin, suspension and tire state; the body owns chassis pose after
 * the solver has applied contacts and CCD.
 */
export function syncDynamicChassisVehicle(vehicle: Vehicle, body: RigidBody): void {
  vehicle.position.copyFrom(body.position);
  syncVehicleVelocityFromBody(vehicle, body.linearVelocity);

  // Vehicle.writeRotation is yaw, then local pitch, then local roll. Recover those same angles from
  // the body's orthonormal basis rather than relying on Quat.toEuler's XYZ convention.
  body.rotation.rotateVector(Vec3.unitZ, scratchForward);
  body.rotation.rotateVector(Vec3.unitX, scratchRight);
  const horizontal = DMath.hypot(scratchForward.x, scratchForward.z);
  const yaw = horizontal > 1e-8 ? DMath.atan2(scratchForward.x, scratchForward.z) : vehicle.yaw;
  const pitch = DMath.asin(clamp(scratchForward.y, -1, 1));
  const cy = DMath.cos(yaw);
  const sy = DMath.sin(yaw);
  const cp = DMath.cos(pitch);
  const sp = DMath.sin(pitch);
  // Basis before roll: right0=(cos(yaw),0,-sin(yaw)), up0=(-sin(yaw)sin(pitch),cos(pitch),-cos(yaw)sin(pitch)).
  const right0x = cy;
  const right0y = 0;
  const right0z = -sy;
  const up0x = -sy * sp;
  const up0y = cp;
  const up0z = -cy * sp;
  const rightDotUp = scratchRight.x * up0x + scratchRight.y * up0y + scratchRight.z * up0z;
  const rightDotRight = scratchRight.x * right0x + scratchRight.y * right0y + scratchRight.z * right0z;

  vehicle.yaw = yaw;
  vehicle.pitch = pitch;
  vehicle.roll = DMath.atan2(rightDotUp, rightDotRight);

  // writeAngularVelocity maps local body ω as (-pitchRate, yawRate, rollRate). Reading local ω
  // makes contact-induced spin feed the next raycast step without inventing a world-axis mapping.
  body.rotation.rotateVectorInverse(body.angularVelocity, scratchLocalOmega);
  vehicle.pitchRate = -scratchLocalOmega.x;
  vehicle.yawRate = scratchLocalOmega.y;
  vehicle.rollRate = scratchLocalOmega.z;
}

/**
 * Apply one queued vehicle acceleration to a dynamic body. Vehicle gravity is already part of the
 * raycast model's requested acceleration, so subtract the body's world gravity contribution before
 * accumulating the force; this also permits an Earth-gravity world to host a Mars-tuned vehicle.
 */
export function applyDynamicChassisStep(
  component: VehicleComponent,
  body: RigidBody,
  gravity: Vec3,
  step: number,
  frame: number,
): void {
  const command = dynamicChassisStep(component, step, frame);
  if (!command) return;

  const acceleration = command.linearAcceleration;
  scratchForce.set(
    (acceleration.x - gravity.x * body.gravityScale) * body.mass,
    (acceleration.y - gravity.y * body.gravityScale) * body.mass,
    (acceleration.z - gravity.z * body.gravityScale) * body.mass,
  );
  body.applyForce(scratchForce);

  // τ = R · I_local · Rᵀ · α. The body already maintains its current orientation and local inertia;
  // use the allocation-free quaternion basis helpers rather than inverting the world tensor.
  body.rotation.rotateVectorInverse(command.angularAcceleration, scratchLocalOmega);
  scratchLocalAngularTorque.set(
    scratchLocalOmega.x * body.inertiaLocal.x,
    scratchLocalOmega.y * body.inertiaLocal.y,
    scratchLocalOmega.z * body.inertiaLocal.z,
  );
  body.rotation.rotateVector(scratchLocalAngularTorque, scratchWorldAngularTorque);
  body.applyTorque(scratchWorldAngularTorque);
}
