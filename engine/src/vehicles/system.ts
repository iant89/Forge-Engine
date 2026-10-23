/**
 * Fixed-step vehicle system. Order 110: after input (0–100), before physics (300) and transforms
 * (500), so a later system can read the pose this step and the transform pass publishes it.
 *
 * Writes the chassis transform and, when present, each wheel entity's world pose. Wheel centres
 * hang off chassis hardpoints along the body up-axis at the current suspension length
 * ({@link Vehicle.wheelCenterPosition}); their orientation follows the sampled contact normal and
 * the chassis heading projected onto that surface. Steering rotates that tangent heading, then
 * wheel spin rolls about the local axle. Airborne wheels use the chassis basis, so they continue to
 * ride with the suspension instead of sticking to a stale terrain contact over a crest.
 *
 * Kinematic {@link VehicleComponent.chassisBody} colliders are not snapped here. FixedSystems are
 * not interleaved: this system finishes all `fixedSteps` before PhysicsSystem runs, so kinematic
 * pose deltas are distributed there. A dynamic chassis takes the other path: this system queues one
 * linear/angular acceleration command per fixed step, and PhysicsSystem consumes the matching command
 * while it advances the shared rigid-body world. That keeps hitch frames deterministic without
 * running two independent chassis integrations.
 */

import { Mat4, Quat } from "../math/mat.js";
import { Vec3 } from "../math/vec.js";
import { FixedSystem, type SystemContext } from "../scene/systems.js";
import { Transform } from "../scene/components/index.js";
import { VehicleComponent } from "./components.js";
import { syncVehicleChassis } from "./chassis.js";
import { syncVehicleVelocityFromBody } from "./vehicle.js";
import { worldSurfaceGrip, worldSurfaceGripField } from "../scene/surfaceGrip.js";
import { DMath } from "../math/detmath.js";
import {
  prepareDynamicChassisFrame,
  syncDynamicChassisVehicle,
  writeDynamicChassisStep,
} from "./dynamicChassis.js";

export class VehicleSystem extends FixedSystem {
  readonly name = "vehicles";
  override readonly order = 110;
  override readonly before = ["transforms"];
  private readonly scratchRot = new Quat();
  private readonly scratchChassisRot = new Quat();
  private readonly scratchSpinRot = new Quat();
  private readonly scratchMatrix = new Mat4();
  private readonly scratchPos = new Vec3();
  private readonly scratchNormal = new Vec3();
  private readonly scratchForward = new Vec3();
  private readonly scratchBeforeOmega = new Vec3();
  private readonly scratchAfterOmega = new Vec3();
  private readonly scratchLinearAcceleration = new Vec3();
  private readonly scratchAngularAcceleration = new Vec3();

  override fixedStep(context: SystemContext, step: number): void {
    const dt = context.fixedDt;
    const world = context.world;
    const vehicles = world.store(VehicleComponent);
    const grip = worldSurfaceGrip(world);
    const field = worldSurfaceGripField(world);
    for (let i = 0; i < vehicles.count; i++) {
      const comp = vehicles.valueAt(i);
      const v = comp.vehicle;
      const chassis = comp.chassisBody;
      const dynamicChassis = chassis?.type === "dynamic" ? chassis : null;

      // The body has not advanced until PhysicsSystem runs later in the scheduler. Sync once at the
      // start of the frame, not once per hitch substep, or every VehicleSystem substep would restart
      // from the same rigid-body pose. A large vehicle→body delta is an explicit gameplay teleport
      // (spawn/reset/scene test), so preserve that authoring operation instead of snapping it back to
      // the previous solver pose; ordinary motion is body-authoritative.
      if (dynamicChassis && step === 0) {
        prepareDynamicChassisFrame(comp, context.fixedSteps, context.frame);
        const dx = v.position.x - dynamicChassis.position.x;
        const dy = v.position.y - dynamicChassis.position.y;
        const dz = v.position.z - dynamicChassis.position.z;
        v.writeRotation(this.scratchRot);
        const rotationAgreement = Math.min(1, Math.abs(dynamicChassis.rotation.dot(this.scratchRot)));
        const externallyTeleported =
          dx * dx + dy * dy + dz * dz > 1e-6 || 1 - rotationAgreement > 1e-6;
        if (externallyTeleported) {
          syncVehicleChassis(v, dynamicChassis);
          syncVehicleVelocityFromBody(v, dynamicChassis.linearVelocity);
        } else {
          syncDynamicChassisVehicle(v, dynamicChassis);
        }
      }

      if (field) {
        const p = v.position;
        v.surfaceGrip = (grip ?? 1) * field(p.x, p.z);
      } else if (grip !== undefined) v.surfaceGrip = grip;

      if (dynamicChassis) v.writeAngularVelocity(this.scratchBeforeOmega);
      const beforeVx = v.velocity.x;
      const beforeVy = v.velocity.y;
      const beforeVz = v.velocity.z;
      const beforeOmegaX = this.scratchBeforeOmega.x;
      const beforeOmegaY = this.scratchBeforeOmega.y;
      const beforeOmegaZ = this.scratchBeforeOmega.z;

      v.step(dt, comp.ground);

      if (dynamicChassis) {
        v.writeAngularVelocity(this.scratchAfterOmega);
        const invDt = dt > 1e-12 ? 1 / dt : 0;
        this.scratchLinearAcceleration.set(
          (v.velocity.x - beforeVx) * invDt,
          (v.velocity.y - beforeVy) * invDt,
          (v.velocity.z - beforeVz) * invDt,
        );
        this.scratchAngularAcceleration.set(
          (this.scratchAfterOmega.x - beforeOmegaX) * invDt,
          (this.scratchAfterOmega.y - beforeOmegaY) * invDt,
          (this.scratchAfterOmega.z - beforeOmegaZ) * invDt,
        );
        writeDynamicChassisStep(
          comp,
          step,
          context.frame,
          this.scratchLinearAcceleration,
          this.scratchAngularAcceleration,
        );
      }

      const id = world.idForSlot(vehicles.slotAt(i));
      const transform = world.getComponent(id, Transform);
      if (!transform) continue;
      transform.setPosition(v.position.x, v.position.y, v.position.z);
      v.writeRotation(this.scratchRot);
      transform.setRotation(this.scratchRot);
      this.writeWheels(comp, world);
    }
  }

  private writeWheels(comp: VehicleComponent, world: SystemContext["world"]): void {
    const v = comp.vehicle;
    v.writeRotation(this.scratchChassisRot);
    this.scratchChassisRot.rotateVector(Vec3.unitZ, this.scratchForward);
    const bodyFx = this.scratchForward.x;
    const bodyFy = this.scratchForward.y;
    const bodyFz = this.scratchForward.z;

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

      // Use the sampled terrain normal only while the ray has a live contact. Once airborne, the
      // wheel returns to the full chassis basis instead of following a stale contact normal.
      let nx: number;
      let ny: number;
      let nz: number;
      const normalLength = DMath.hypot(wheel.nx, wheel.ny, wheel.nz);
      if (wheel.inContact && Number.isFinite(normalLength) && normalLength > 1e-6 && wheel.ny > 0) {
        nx = wheel.nx / normalLength;
        ny = wheel.ny / normalLength;
        nz = wheel.nz / normalLength;
      } else {
        this.scratchChassisRot.rotateVector(Vec3.unitY, this.scratchNormal);
        nx = this.scratchNormal.x;
        ny = this.scratchNormal.y;
        nz = this.scratchNormal.z;
      }

      // Project the chassis forward onto the wheel's contact plane so the tire stays tangent to
      // the ground, then apply this wheel's Ackermann steering about that surface normal.
      let forwardDot = bodyFx * nx + bodyFy * ny + bodyFz * nz;
      let fx = bodyFx - nx * forwardDot;
      let fy = bodyFy - ny * forwardDot;
      let fz = bodyFz - nz * forwardDot;
      let forwardLength = DMath.hypot(fx, fy, fz);
      if (forwardLength < 1e-6) {
        // Degenerate only when the chassis is aimed almost straight into the surface; choose a
        // stable tangent rather than letting the wheel quaternion collapse.
        const fallback = Math.abs(ny) < 0.9 ? Vec3.unitY : Vec3.unitZ;
        forwardDot = fallback.x * nx + fallback.y * ny + fallback.z * nz;
        fx = fallback.x - nx * forwardDot;
        fy = fallback.y - ny * forwardDot;
        fz = fallback.z - nz * forwardDot;
        forwardLength = DMath.hypot(fx, fy, fz);
      }
      const invForwardLength = 1 / forwardLength;
      fx *= invForwardLength;
      fy *= invForwardLength;
      fz *= invForwardLength;

      const steer = wheel.steerAngle;
      if (steer !== 0) {
        const cos = DMath.cos(steer);
        const sin = DMath.sin(steer);
        const rightX = ny * fz - nz * fy;
        const rightY = nz * fx - nx * fz;
        const rightZ = nx * fy - ny * fx;
        const steeredFx = fx * cos + rightX * sin;
        const steeredFy = fy * cos + rightY * sin;
        const steeredFz = fz * cos + rightZ * sin;
        fx = steeredFx;
        fy = steeredFy;
        fz = steeredFz;
      }

      // Local X is the axle, local Y is the contact normal, and local Z is the steered direction.
      // Building an orthonormal basis keeps the imported tire square to a slope, even while the
      // chassis is pitching/rolling across uneven ground.
      const rx = ny * fz - nz * fy;
      const ry = nz * fx - nx * fz;
      const rz = nx * fy - ny * fx;
      this.scratchMatrix.setIdentity();
      this.scratchMatrix.setColumn(0, rx, ry, rz, 0);
      this.scratchMatrix.setColumn(1, nx, ny, nz, 0);
      this.scratchMatrix.setColumn(2, fx, fy, fz, 0);
      Quat.fromRotationMatrix(this.scratchMatrix, this.scratchRot);

      // Negate spin for left-side wheels (x < 0): their axle points in the opposite direction
      // from right-side wheels, so the same omega produces the opposite visual rotation.
      const visualSpin = wheel.x < 0 ? -wheel.spin : wheel.spin;
      this.scratchSpinRot.setEulerComponents(visualSpin, 0, 0);
      this.scratchRot.multiply(this.scratchSpinRot);
      if (wheel.bend !== 0) {
        // Bent wheel: lean the hub by the damage camber (about local forward) plus matching
        // toe (about local up), applied after spin so mangled wheels still roll crookedly.
        this.scratchSpinRot.setEulerComponents(0, wheel.bend * 0.6, wheel.bend);
        this.scratchRot.multiply(this.scratchSpinRot);
      }
      t.setRotation(this.scratchRot);
    }
  }
}
