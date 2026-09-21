/**
 * Sequential Impulse Constraint Solver with Warm Starting & Coulomb Friction.
 */

import { Vec3 } from "../math/vec.js";
import { ContactManifold } from "./collision.js";
import { RigidBody } from "./body.js";

export interface SolverOptions {
  velocityIterations?: number;
  positionIterations?: number;
  baumgarte?: number;
  penetrationSlop?: number;
  velocityRestThreshold?: number;
}

export class SequentialImpulseSolver {
  velocityIterations: number;
  positionIterations: number;
  baumgarte: number;
  penetrationSlop: number;
  velocityRestThreshold: number;

  constructor(options: SolverOptions = {}) {
    this.velocityIterations = options.velocityIterations ?? 8;
    this.positionIterations = options.positionIterations ?? 2;
    this.baumgarte = options.baumgarte ?? 0.2;
    this.penetrationSlop = options.penetrationSlop ?? 0.005; // 5mm slop
    this.velocityRestThreshold = options.velocityRestThreshold ?? 0.25; // 0.25 m/s rest cutoff
  }

  solve(manifolds: ContactManifold[], dt: number): void {
    if (manifolds.length === 0 || dt <= 0) return;

    // 1. Pre-step: compute effective masses, biases, and warm start
    for (const m of manifolds) {
      this.preStep(m, dt);
    }

    // 2. Velocity iterations: solve normal & friction constraints
    for (let iter = 0; iter < this.velocityIterations; iter++) {
      for (const m of manifolds) {
        this.solveVelocity(m);
      }
    }
  }

  private preStep(m: ContactManifold, dt: number): void {
    const bA = m.bodyA;
    const bB = m.bodyB;

    const wAx = bA.angularVelocity.x;
    const wAy = bA.angularVelocity.y;
    const wAz = bA.angularVelocity.z;

    const wBx = bB.angularVelocity.x;
    const wBy = bB.angularVelocity.y;
    const wBz = bB.angularVelocity.z;

    const impulseVec = new Vec3();

    for (const c of m.contacts) {
      // Relative velocity at contact point
      const vAx = bA.linearVelocity.x + (wAy * c.rA.z - wAz * c.rA.y);
      const vAy = bA.linearVelocity.y + (wAz * c.rA.x - wAx * c.rA.z);
      const vAz = bA.linearVelocity.z + (wAx * c.rA.y - wAy * c.rA.x);

      const vBx = bB.linearVelocity.x + (wBy * c.rB.z - wBz * c.rB.y);
      const vBy = bB.linearVelocity.y + (wBz * c.rB.x - wBx * c.rB.z);
      const vBz = bB.linearVelocity.z + (wBx * c.rB.y - wBy * c.rB.x);

      const dvx = vBx - vAx;
      const dvy = vBy - vAy;
      const dvz = vBz - vAz;

      // Effective normal mass
      c.normalMass = this.computeEffectiveMass(bA, bB, c.rA, c.rB, c.normal);
      // Effective tangent masses
      c.tangentMass1 = this.computeEffectiveMass(bA, bB, c.rA, c.rB, c.tangent1);
      c.tangentMass2 = this.computeEffectiveMass(bA, bB, c.rA, c.rB, c.tangent2);

      // Normal relative velocity
      const vn = dvx * c.normal.x + dvy * c.normal.y + dvz * c.normal.z;

      // Restitution: apply bounce only if closing velocity exceeds rest threshold
      let restitutionBias = 0;
      if (vn < -this.velocityRestThreshold) {
        restitutionBias = -m.restitution * vn;
      }

      // Baumgarte stabilization for penetration recovery
      const penetrationExcess = Math.max(0, c.penetration - this.penetrationSlop);
      const positionBias = (this.baumgarte / dt) * penetrationExcess;

      c.velocityBias = restitutionBias + positionBias;

      // Warm starting: apply fraction of previous impulse to accelerate convergence
      const Pn = c.normalImpulse;
      const Pt1 = c.tangentImpulse1;
      const Pt2 = c.tangentImpulse2;

      impulseVec.set(
        c.normal.x * Pn + c.tangent1.x * Pt1 + c.tangent2.x * Pt2,
        c.normal.y * Pn + c.tangent1.y * Pt1 + c.tangent2.y * Pt2,
        c.normal.z * Pn + c.tangent1.z * Pt1 + c.tangent2.z * Pt2,
      );

      bA.applyImpulse(
        { x: -impulseVec.x, y: -impulseVec.y, z: -impulseVec.z },
        c.point,
      );
      bB.applyImpulse(impulseVec, c.point);
    }
  }

  private solveVelocity(m: ContactManifold): void {
    const bA = m.bodyA;
    const bB = m.bodyB;

    const wAx = bA.angularVelocity.x;
    const wAy = bA.angularVelocity.y;
    const wAz = bA.angularVelocity.z;

    const wBx = bB.angularVelocity.x;
    const wBy = bB.angularVelocity.y;
    const wBz = bB.angularVelocity.z;

    for (const c of m.contacts) {
      // Relative velocity at contact
      const vAx = bA.linearVelocity.x + (wAy * c.rA.z - wAz * c.rA.y);
      const vAy = bA.linearVelocity.y + (wAz * c.rA.x - wAx * c.rA.z);
      const vAz = bA.linearVelocity.z + (wAx * c.rA.y - wAy * c.rA.x);

      const vBx = bB.linearVelocity.x + (wBy * c.rB.z - wBz * c.rB.y);
      const vBy = bB.linearVelocity.y + (wBz * c.rB.x - wBx * c.rB.z);
      const vBz = bB.linearVelocity.z + (wBx * c.rB.y - wBy * c.rB.x);

      const dvx = vBx - vAx;
      const dvy = vBy - vAy;
      const dvz = vBz - vAz;

      // 1. Friction solving (Coulomb cone: |Pt| <= mu * Pn)
      const maxFriction = m.friction * c.normalImpulse;

      // Tangent 1
      const vt1 = dvx * c.tangent1.x + dvy * c.tangent1.y + dvz * c.tangent1.z;
      const dPt1 = -vt1 * c.tangentMass1;
      const oldPt1 = c.tangentImpulse1;
      c.tangentImpulse1 = Math.max(-maxFriction, Math.min(maxFriction, oldPt1 + dPt1));
      const deltaPt1 = c.tangentImpulse1 - oldPt1;

      // Tangent 2
      const vt2 = dvx * c.tangent2.x + dvy * c.tangent2.y + dvz * c.tangent2.z;
      const dPt2 = -vt2 * c.tangentMass2;
      const oldPt2 = c.tangentImpulse2;
      c.tangentImpulse2 = Math.max(-maxFriction, Math.min(maxFriction, oldPt2 + dPt2));
      const deltaPt2 = c.tangentImpulse2 - oldPt2;

      // Apply friction impulse delta
      const fImpX = c.tangent1.x * deltaPt1 + c.tangent2.x * deltaPt2;
      const fImpY = c.tangent1.y * deltaPt1 + c.tangent2.y * deltaPt2;
      const fImpZ = c.tangent1.z * deltaPt1 + c.tangent2.z * deltaPt2;

      bA.applyImpulse({ x: -fImpX, y: -fImpY, z: -fImpZ }, c.point);
      bB.applyImpulse({ x: fImpX, y: fImpY, z: fImpZ }, c.point);

      // Re-read relative velocity along normal after friction
      const curVAx = bA.linearVelocity.x + (bA.angularVelocity.y * c.rA.z - bA.angularVelocity.z * c.rA.y);
      const curVAy = bA.linearVelocity.y + (bA.angularVelocity.z * c.rA.x - bA.angularVelocity.x * c.rA.z);
      const curVAz = bA.linearVelocity.z + (bA.angularVelocity.x * c.rA.y - bA.angularVelocity.y * c.rA.x);

      const curVBx = bB.linearVelocity.x + (bB.angularVelocity.y * c.rB.z - bB.angularVelocity.z * c.rB.y);
      const curVBy = bB.linearVelocity.y + (bB.angularVelocity.z * c.rB.x - bB.angularVelocity.x * c.rB.z);
      const curVBz = bB.linearVelocity.z + (bB.angularVelocity.x * c.rB.y - bB.angularVelocity.y * c.rB.x);

      const curDvx = curVBx - curVAx;
      const curDvy = curVBy - curVAy;
      const curDvz = curVBz - curVAz;

      const vn = curDvx * c.normal.x + curDvy * c.normal.y + curDvz * c.normal.z;

      // 2. Normal impulse solving
      const dPn = (-vn + c.velocityBias) * c.normalMass;
      const oldPn = c.normalImpulse;
      c.normalImpulse = Math.max(0, oldPn + dPn);
      const deltaPn = c.normalImpulse - oldPn;

      const nImpX = c.normal.x * deltaPn;
      const nImpY = c.normal.y * deltaPn;
      const nImpZ = c.normal.z * deltaPn;

      bA.applyImpulse({ x: -nImpX, y: -nImpY, z: -nImpZ }, c.point);
      bB.applyImpulse({ x: nImpX, y: nImpY, z: nImpZ }, c.point);
    }
  }

  private computeEffectiveMass(
    bA: RigidBody,
    bB: RigidBody,
    rA: Vec3,
    rB: Vec3,
    dir: Vec3,
  ): number {
    let k = bA.invMass + bB.invMass;

    // Body A angular contribution: (rA x dir)^T * invIA * (rA x dir)
    if (bA.invMass > 0) {
      const rx = rA.y * dir.z - rA.z * dir.y;
      const ry = rA.z * dir.x - rA.x * dir.z;
      const rz = rA.x * dir.y - rA.y * dir.x;

      const m = bA.invInertiaWorld.m;
      const ix = m[0]! * rx + m[3]! * ry + m[6]! * rz;
      const iy = m[1]! * rx + m[4]! * ry + m[7]! * rz;
      const iz = m[2]! * rx + m[5]! * ry + m[8]! * rz;

      k += rx * ix + ry * iy + rz * iz;
    }

    // Body B angular contribution: (rB x dir)^T * invIB * (rB x dir)
    if (bB.invMass > 0) {
      const rx = rB.y * dir.z - rB.z * dir.y;
      const ry = rB.z * dir.x - rB.x * dir.z;
      const rz = rB.x * dir.y - rB.y * dir.x;

      const m = bB.invInertiaWorld.m;
      const ix = m[0]! * rx + m[3]! * ry + m[6]! * rz;
      const iy = m[1]! * rx + m[4]! * ry + m[7]! * rz;
      const iz = m[2]! * rx + m[5]! * ry + m[8]! * rz;

      k += rx * ix + ry * iy + rz * iz;
    }

    return k > 0 ? 1.0 / k : 0;
  }
}
