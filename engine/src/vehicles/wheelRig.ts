/**
 * Wheel assembly rig — the vehicle layer's mechanical joint binding (Phase 16.6).
 *
 * `createVehicleWheelRig` turns a {@link Vehicle}'s per-wheel state into joints on a
 * {@link MechanicalRig}, and `VehicleWheelSource` keeps those joints' channels fed from wheel
 * telemetry every frame. Together they are the *visual* half of a wheel: the physics still owns
 * where the hub is, how fast the tyre turns and how far the suspension is compressed, and the rig
 * reproduces that on an entity hierarchy so a wheel can be geometry (a tyre, a rim, cleats) hanging
 * off a steering knuckle and an axle rather than one world-space box.
 *
 * Joint layout expected by the demo (`mounts[i]` names the entities):
 *
 *   chassis
 *    ├─ hub carrier   (travel)  prismatic +Y   ← `compression`; authored at full droop
 *    │   └─ knuckle   (steer)   revolute  +Y   ← `steerAngle` (already Ackermann per wheel)
 *    │       └─ axle  (spin)    revolute  +X   ← `spin`, sign-flipped on the left
 *    ├─ arm           (arm)     aim at the hub carrier (telescoping when `armStretch`)
 *    └─ shock         (shock)   aim at the hub carrier, always telescoping
 *
 * Channel names are `${prefix}${index}.steer|spin|travel` (prefix defaults to `"wheel"`); a joint is
 * added only for the mounts a scene provides, so a fixed rear axle simply omits `steer`.
 *
 * What this deliberately does **not** do: orient the wheel to the terrain contact normal. The rig
 * hangs the assembly off the chassis (what a car's suspension does); `VehicleSystem`'s world-space
 * wheel pose remains the path that follows the sampled normal per wheel, and that is what the Mars
 * rover's six legs use. Slew defaults are chosen the same way: `steerSlew` adds the actuator lag the
 * physics steering does not model, while spin and travel follow telemetry exactly (the spring/damper
 * already is the filter — a second one would lag real bumps).
 */

import { Vec3 } from "../math/vec.js";
import type { EntityId } from "../scene/entityId.js";
import type { MechanicalChannelSource, MechanicalRig } from "../animation/index.js";
import type { Vehicle } from "./vehicle.js";

/** Entities a scene builds for one wheel, in the layout the doc comment draws. */
export interface WheelRigMounts {
  /** Hub carrier the suspension travel moves (prismatic along the hub's local +Y). */
  travel?: EntityId;
  /** Steering knuckle (revolute about the hub's local +Y). */
  steer?: EntityId;
  /** Spinning axle (revolute about the hub's local +X). */
  spin?: EntityId;
  /** Trailing arm / link aimed at the hub carrier. */
  arm?: EntityId;
  /** Damper aimed at the hub carrier (always telescoping). */
  shock?: EntityId;
}

export interface WheelRigOptions {
  /** Channel prefix. Default `"wheel"`. */
  channelPrefix?: string;
  /** Steering slew in rad/s; 0 follows telemetry exactly. Default 6. */
  steerSlew?: number;
  /** Suspension slew in m/s; 0 (default) follows telemetry exactly. */
  travelSlew?: number;
  /** Stretch `arm` links to the hub instead of stopping at their authored length. Default true. */
  armStretch?: boolean;
}

/** `wheel3.spin` — the channel a mount's joint reads. */
export function wheelChannelName(prefix: string, index: number, kind: "steer" | "spin" | "travel"): string {
  return `${prefix}${index}.${kind}`;
}

/**
 * Chassis-local position of a wheel's hub at full droop — where a `travel` hub carrier must be
 * authored so the prismatic joint's base pose is the uncompressed end of its travel.
 * Mirrors `Vehicle.wheelCenterPosition` at `compression = 0`.
 */
export function wheelHubRestPosition(vehicle: Vehicle, index: number, out: Vec3): Vec3 {
  const wheel = vehicle.wheels[index];
  if (!wheel) return out.set(0, 0, 0);
  return out.set(wheel.x, -vehicle.config.suspensionRest, wheel.z);
}

/**
 * Add one wheel's joints to `rig`. Joints are added in solve order (travel before the links that
 * aim at it), so the arm and shock see the hub pose from the same frame; call this with the machine
 * in its rest pose, because each joint captures its base transform from the entity as it stands.
 */
export function createVehicleWheelRig(
  rig: MechanicalRig,
  vehicle: Vehicle,
  mounts: readonly WheelRigMounts[],
  options: WheelRigOptions = {},
): void {
  const prefix = options.channelPrefix ?? "wheel";
  const steerSlew = options.steerSlew ?? 6;
  const travelSlew = options.travelSlew ?? 0;
  const armStretch = options.armStretch ?? true;
  for (let i = 0; i < mounts.length; i++) {
    const mount = mounts[i]!;
    const wheel = vehicle.wheels[i];
    if (!wheel) continue;
    // Hub carrier first: the aim joints below read its pose in the same pass.
    if (mount.travel !== undefined) {
      rig.addJoint({
        entity: mount.travel,
        kind: "prismatic",
        axis: { x: 0, y: 1, z: 0 },
        channel: wheelChannelName(prefix, i, "travel"),
        slew: travelSlew,
      });
    }
    if (mount.steer !== undefined) {
      rig.addJoint({
        entity: mount.steer,
        kind: "revolute",
        axis: { x: 0, y: 1, z: 0 },
        channel: wheelChannelName(prefix, i, "steer"),
        slew: steerSlew,
      });
    }
    if (mount.spin !== undefined) {
      // Left-side wheels' axles point the other way: negate so the same ω rolls both sides forward
      // (matches `VehicleSystem`'s world-space wheel pose).
      rig.addJoint({
        entity: mount.spin,
        kind: "revolute",
        axis: { x: 1, y: 0, z: 0 },
        channel: wheelChannelName(prefix, i, "spin"),
        ratio: wheel.x < 0 ? -1 : 1,
      });
    }
    if (mount.arm !== undefined) {
      rig.addJoint({
        entity: mount.arm,
        kind: "aim",
        axis: { x: 1, y: 0, z: 0 },
        target: mount.travel ?? mount.steer ?? mount.spin ?? mount.arm,
        stretch: armStretch,
      });
    }
    if (mount.shock !== undefined) {
      rig.addJoint({
        entity: mount.shock,
        kind: "aim",
        axis: { x: 1, y: 0, z: 0 },
        target: mount.travel ?? mount.steer ?? mount.spin ?? mount.shock,
        stretch: true,
      });
    }
  }
}

/**
 * Writes wheel telemetry into a rig's channels: `steer` is the wheel's own Ackermann angle (no
 * re-derivation — the solver already decided it), `spin` the odometer the tire integrated, `travel`
 * the compression the spring produced.
 */
export class VehicleWheelSource implements MechanicalChannelSource {
  private readonly vehicle: Vehicle;
  private readonly prefix: string;

  constructor(vehicle: Vehicle, options: WheelRigOptions = {}) {
    this.vehicle = vehicle;
    this.prefix = options.channelPrefix ?? "wheel";
  }

  writeChannels(rig: MechanicalRig): void {
    const wheels = this.vehicle.wheels;
    for (let i = 0; i < wheels.length; i++) {
      const wheel = wheels[i]!;
      rig.setChannel(wheelChannelName(this.prefix, i, "steer"), wheel.steerAngle);
      rig.setChannel(wheelChannelName(this.prefix, i, "spin"), wheel.spin);
      rig.setChannel(wheelChannelName(this.prefix, i, "travel"), wheel.compression);
    }
  }
}
