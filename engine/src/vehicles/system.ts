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
 * When {@link VehicleComponent.chassisBody} is set, do **not** snap the kinematic collider here.
 * FixedSystems are not interleaved: this system finishes all `fixedSteps` before PhysicsSystem
 * runs. Snapping the chassis to the end pose/ω each vehicle substep leaves hitch frames
 * (`fixedSteps>1`) contacting a parked body. PhysicsSystem drives `chassisBody` through the same
 * Transform pose-delta distribution used for RigidBodyComponent kinematics.
 */

import { Mat4, Quat } from "../math/mat.js";
import { Vec3 } from "../math/vec.js";
import { FixedSystem, type SystemContext } from "../scene/systems.js";
import { Transform } from "../scene/components/index.js";
import { VehicleComponent } from "./components.js";

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
      const normalLength = Math.hypot(wheel.nx, wheel.ny, wheel.nz);
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
      let forwardLength = Math.hypot(fx, fy, fz);
      if (forwardLength < 1e-6) {
        // Degenerate only when the chassis is aimed almost straight into the surface; choose a
        // stable tangent rather than letting the wheel quaternion collapse.
        const fallback = Math.abs(ny) < 0.9 ? Vec3.unitY : Vec3.unitZ;
        forwardDot = fallback.x * nx + fallback.y * ny + fallback.z * nz;
        fx = fallback.x - nx * forwardDot;
        fy = fallback.y - ny * forwardDot;
        fz = fallback.z - nz * forwardDot;
        forwardLength = Math.hypot(fx, fy, fz);
      }
      const invForwardLength = 1 / forwardLength;
      fx *= invForwardLength;
      fy *= invForwardLength;
      fz *= invForwardLength;

      const steer = wheel.steerAngle;
      if (steer !== 0) {
        const cos = Math.cos(steer);
        const sin = Math.sin(steer);
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
