/**
 * Fixed-step vehicle system. Order 110: after input (0–100), before physics (300) and transforms
 * (500), so a later system can read the pose this step and the transform pass publishes it.
 *
 * Writes the chassis transform and, when present, each wheel entity's world pose. Wheel meshes are
 * boxes in the playground (a cylinder's axis is +Y; a box needs no extra basis). Spin is a roll
 * about the axle, composed as yaw (chassis + steer) then a local X rotation — applied as an euler
 * (spin, yaw, 0) which is close enough for a debug wheel and exact for the chassis.
 *
 * Wheel centres hang off the chassis hardpoints along the body up-axis at the current suspension
 * length ({@link Vehicle.wheelCenterPosition}) — a child of the suspension, never of the terrain.
 * Anchoring them to the ray contact instead made a wheel stick to the ground over a crest while
 * the chassis flew on, then teleport back the moment the ray released ("wheels fly off the rover
 * and snap back").
 *
 * When {@link VehicleComponent.chassisBody} is set, do **not** snap the kinematic collider here.
 * FixedSystems are not interleaved: this system finishes all `fixedSteps` before PhysicsSystem
 * runs. Snapping the chassis to the end pose/ω each vehicle substep leaves hitch frames
 * (`fixedSteps>1`) contacting a parked body. PhysicsSystem drives `chassisBody` through the same
 * Transform pose-delta distribution used for RigidBodyComponent kinematics.
 */

import { Quat } from "../math/mat.js";
import { Vec3 } from "../math/vec.js";
import { FixedSystem, type SystemContext } from "../scene/systems.js";
import { Transform } from "../scene/components/index.js";
import { VehicleComponent } from "./components.js";

export class VehicleSystem extends FixedSystem {
  readonly name = "vehicles";
  override readonly order = 110;
  override readonly before = ["transforms"];
  private readonly scratchRot = new Quat();
  private readonly scratchPos = new Vec3();

  override fixedStep(context: SystemContext, _step: number): void {
    const dt = context.fixedDt;
    const world = context.world;
    const vehicles = world.store(VehicleComponent);
    for (let i = 0; i < vehicles.count; i++) {
      const comp = vehicles.valueAt(i);
      comp.vehicle.step(dt, comp.ground);
      const id = world.idForSlot(vehicles.slotAt(i));
      const transform = world.getComponent(id, Transform);
      if (!transform) continue;
      const v = comp.vehicle;
      transform.setPosition(v.position.x, v.position.y, v.position.z);
      v.writeRotation(this.scratchRot);
      transform.setRotation(this.scratchRot);
      this.writeWheels(comp, world);
    }
  }

  private writeWheels(comp: VehicleComponent, world: SystemContext["world"]): void {
    const v = comp.vehicle;
    for (let w = 0; w < comp.wheelEntities.length; w++) {
      const id = comp.wheelEntities[w];
      if (id === undefined || !world.exists(id)) continue;
      const wheel = v.wheels[w];
      if (!wheel) continue;
      const t = world.getComponent(id, Transform);
      if (!t) continue;
      // Wheel centre hangs off the suspension hardpoint along the body up-axis — a child of the
      // suspension, never of the terrain contact (see Vehicle.wheelCenterPosition).
      const pos = v.wheelCenterPosition(wheel, this.scratchPos);
      t.setPosition(pos.x, pos.y, pos.z);
      // Negate spin for left-side wheels (x < 0): their axle points in the opposite direction
      // from right-side wheels, so the same omega produces the opposite visual rotation.
      const visualSpin = wheel.x < 0 ? -wheel.spin : wheel.spin;
      this.scratchRot.setEulerComponents(visualSpin, v.yaw + wheel.steerAngle, 0);
      t.setRotation(this.scratchRot);
    }
  }
}
