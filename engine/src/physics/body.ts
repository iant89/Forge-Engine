/**
 * `RigidBody` — dynamic, static, and kinematic rigid body simulation primitive.
 */

import { Vec3, type Vec3Ops } from "../math/vec.js";
import { Quat, Mat3 } from "../math/mat.js";
import { AABB } from "../math/geometry.js";
import { Shape, type MassProperties } from "./shapes.js";

export type BodyType = "dynamic" | "static" | "kinematic";

export interface RigidBodyOptions {
  type?: BodyType;
  shape: Shape;
  mass?: number;
  position?: Vec3Ops;
  rotation?: Quat;
  linearVelocity?: Vec3Ops;
  angularVelocity?: Vec3Ops;
  restitution?: number;
  friction?: number;
  linearDamping?: number;
  angularDamping?: number;
  gravityScale?: number;
}

export class RigidBody {
  id = 0;
  type: BodyType;
  shape: Shape;

  // Simulation state
  readonly position = new Vec3();
  readonly rotation = new Quat();
  readonly linearVelocity = new Vec3();
  readonly angularVelocity = new Vec3();

  // Accumulators
  readonly force = new Vec3();
  readonly torque = new Vec3();

  // Previous state for fixed-timestep render interpolation
  readonly prevPosition = new Vec3();
  readonly prevRotation = new Quat();

  // Render pose (interpolated by alpha)
  readonly renderPosition = new Vec3();
  readonly renderRotation = new Quat();

  // Mass & Inertia
  mass = 1.0;
  invMass = 1.0;
  readonly inertiaLocal = new Vec3(1, 1, 1);
  readonly invInertiaLocal = new Vec3(1, 1, 1);
  readonly invInertiaWorld = new Mat3();

  // Material coefficients
  restitution = 0.2; // Bounciness [0, 1]
  friction = 0.5; // Coulomb coefficient
  linearDamping = 0.01;
  angularDamping = 0.05;
  gravityScale = 1.0;

  readonly aabb = new AABB();
  isSleeping = false;
  sleepTime = 0;

  constructor(options: RigidBodyOptions) {
    this.type = options.type ?? "dynamic";
    this.shape = options.shape;

    if (options.position) this.position.copyFrom(options.position);
    if (options.rotation) this.rotation.copyFrom(options.rotation);
    if (options.linearVelocity) this.linearVelocity.copyFrom(options.linearVelocity);
    if (options.angularVelocity) this.angularVelocity.copyFrom(options.angularVelocity);

    this.prevPosition.copyFrom(this.position);
    this.prevRotation.copyFrom(this.rotation);
    this.renderPosition.copyFrom(this.position);
    this.renderRotation.copyFrom(this.rotation);

    if (options.restitution !== undefined) this.restitution = options.restitution;
    if (options.friction !== undefined) this.friction = options.friction;
    if (options.linearDamping !== undefined) this.linearDamping = options.linearDamping;
    if (options.angularDamping !== undefined) this.angularDamping = options.angularDamping;
    if (options.gravityScale !== undefined) this.gravityScale = options.gravityScale;

    this.setupMass(options.mass);
    this.updateInertiaWorld();
    this.updateAABB();
  }

  setupMass(customMass?: number): void {
    if (this.type === "static" || this.type === "kinematic") {
      this.mass = 0;
      this.invMass = 0;
      this.inertiaLocal.set(0, 0, 0);
      this.invInertiaLocal.set(0, 0, 0);
      return;
    }

    const props: MassProperties = this.shape.computeMass(1000);
    this.mass = customMass !== undefined ? Math.max(1e-4, customMass) : Math.max(1e-4, props.mass);
    this.invMass = 1.0 / this.mass;

    // Scale inertia proportionally if customMass was provided
    const scale = customMass !== undefined && props.mass > 0 ? customMass / props.mass : 1.0;
    this.inertiaLocal.set(props.inertia.x * scale, props.inertia.y * scale, props.inertia.z * scale);
    this.invInertiaLocal.set(
      this.inertiaLocal.x > 0 ? 1 / this.inertiaLocal.x : 0,
      this.inertiaLocal.y > 0 ? 1 / this.inertiaLocal.y : 0,
      this.inertiaLocal.z > 0 ? 1 / this.inertiaLocal.z : 0,
    );
  }

  updateInertiaWorld(): void {
    if (this.invMass === 0) {
      this.invInertiaWorld.m.fill(0);
      return;
    }
    // R * diag(invI) * R^T
    // Rotation matrix columns from quaternion
    const { x, y, z, w } = this.rotation;
    const x2 = x + x;
    const y2 = y + y;
    const z2 = z + z;
    const xx = x * x2;
    const xy = x * y2;
    const xz = x * z2;
    const yy = y * y2;
    const yz = y * z2;
    const zz = z * z2;
    const wx = w * x2;
    const wy = w * y2;
    const wz = w * z2;

    const r00 = 1 - (yy + zz);
    const r01 = xy - wz;
    const r02 = xz + wy;

    const r10 = xy + wz;
    const r11 = 1 - (xx + zz);
    const r12 = yz - wx;

    const r20 = xz - wy;
    const r21 = yz + wx;
    const r22 = 1 - (xx + yy);

    const ix = this.invInertiaLocal.x;
    const iy = this.invInertiaLocal.y;
    const iz = this.invInertiaLocal.z;

    const m = this.invInertiaWorld.m;
    m[0] = r00 * ix * r00 + r01 * iy * r01 + r02 * iz * r02;
    m[1] = r10 * ix * r00 + r11 * iy * r01 + r12 * iz * r02;
    m[2] = r20 * ix * r00 + r21 * iy * r01 + r22 * iz * r02;

    m[3] = r00 * ix * r10 + r01 * iy * r11 + r02 * iz * r12;
    m[4] = r10 * ix * r10 + r11 * iy * r11 + r12 * iz * r12;
    m[5] = r20 * ix * r10 + r21 * iy * r11 + r22 * iz * r12;

    m[6] = r00 * ix * r20 + r01 * iy * r21 + r02 * iz * r22;
    m[7] = r10 * ix * r20 + r11 * iy * r21 + r12 * iz * r22;
    m[8] = r20 * ix * r20 + r21 * iy * r21 + r22 * iz * r22;
  }

  updateAABB(): void {
    this.shape.computeAABB(this.position, this.rotation, this.aabb);
  }

  applyForce(f: Vec3Ops, worldPoint?: Vec3Ops): void {
    if (this.invMass === 0) return;
    this.force.x += f.x;
    this.force.y += f.y;
    this.force.z += f.z;

    if (worldPoint) {
      const rx = worldPoint.x - this.position.x;
      const ry = worldPoint.y - this.position.y;
      const rz = worldPoint.z - this.position.z;
      // torque += r x f
      this.torque.x += ry * f.z - rz * f.y;
      this.torque.y += rz * f.x - rx * f.z;
      this.torque.z += rx * f.y - ry * f.x;
    }
  }

  applyImpulse(impulse: Vec3Ops, worldPoint?: Vec3Ops): void {
    if (this.invMass === 0) return;
    this.linearVelocity.x += impulse.x * this.invMass;
    this.linearVelocity.y += impulse.y * this.invMass;
    this.linearVelocity.z += impulse.z * this.invMass;

    if (worldPoint) {
      const rx = worldPoint.x - this.position.x;
      const ry = worldPoint.y - this.position.y;
      const rz = worldPoint.z - this.position.z;
      // dTorque = r x impulse
      const tx = ry * impulse.z - rz * impulse.y;
      const ty = rz * impulse.x - rx * impulse.z;
      const tz = rx * impulse.y - ry * impulse.x;

      const m = this.invInertiaWorld.m;
      this.angularVelocity.x += m[0]! * tx + m[3]! * ty + m[6]! * tz;
      this.angularVelocity.y += m[1]! * tx + m[4]! * ty + m[7]! * tz;
      this.angularVelocity.z += m[2]! * tx + m[5]! * ty + m[8]! * tz;
    }
  }

  applyTorque(t: Vec3Ops): void {
    if (this.invMass === 0) return;
    this.torque.x += t.x;
    this.torque.y += t.y;
    this.torque.z += t.z;
  }

  integrateVelocity(dt: number, gravity: Vec3Ops): void {
    if (this.invMass === 0) return;

    // Linear velocity integration
    const ax = gravity.x * this.gravityScale + this.force.x * this.invMass;
    const ay = gravity.y * this.gravityScale + this.force.y * this.invMass;
    const az = gravity.z * this.gravityScale + this.force.z * this.invMass;

    this.linearVelocity.x += ax * dt;
    this.linearVelocity.y += ay * dt;
    this.linearVelocity.z += az * dt;

    // Angular velocity integration
    const m = this.invInertiaWorld.m;
    const tx = this.torque.x;
    const ty = this.torque.y;
    const tz = this.torque.z;

    this.angularVelocity.x += (m[0]! * tx + m[3]! * ty + m[6]! * tz) * dt;
    this.angularVelocity.y += (m[1]! * tx + m[4]! * ty + m[7]! * tz) * dt;
    this.angularVelocity.z += (m[2]! * tx + m[5]! * ty + m[8]! * tz) * dt;

    // Damping
    const linDamp = Math.max(0, 1.0 - this.linearDamping * dt);
    const angDamp = Math.max(0, 1.0 - this.angularDamping * dt);
    this.linearVelocity.scale(linDamp);
    this.angularVelocity.scale(angDamp);
  }

  integratePosition(dt: number): void {
    if (this.invMass === 0) return;

    this.prevPosition.copyFrom(this.position);
    this.prevRotation.copyFrom(this.rotation);

    // x += v * dt
    this.position.x += this.linearVelocity.x * dt;
    this.position.y += this.linearVelocity.y * dt;
    this.position.z += this.linearVelocity.z * dt;

    // q = integrate(q, w, dt)
    this.rotation.integrate(this.angularVelocity, dt, this.rotation);

    // Clear forces for next fixed step
    this.force.set(0, 0, 0);
    this.torque.set(0, 0, 0);

    this.updateInertiaWorld();
    this.updateAABB();
  }

  interpolate(alpha: number): void {
    if (this.invMass === 0) {
      this.renderPosition.copyFrom(this.position);
      this.renderRotation.copyFrom(this.rotation);
      return;
    }
    Vec3.lerpInto(this.prevPosition, this.position, alpha, this.renderPosition);
    Quat.slerpInto(this.prevRotation, this.rotation, alpha, this.renderRotation);
  }
}
