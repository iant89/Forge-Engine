/**
 * `PhysicsSystem` — ECS bridge synchronizing Entity Transforms with PhysicsWorld.
 *
 * Runs in band 300 (physics), before band 500 (transforms).
 *
 * By default constructs and owns a {@link PhysicsWorld} (single-owner). Pass `world` or
 * `backend` to adopt an existing world so Vehicle demos / {@link ForgeJSPhysics} and ECS
 * share one simulation. Without sharing, registering both creates two independent worlds.
 */

import { FixedSystem, type SystemContext } from "../scene/systems.js";
import { Transform } from "../scene/components/index.js";
import { Quat } from "../math/mat.js";
import { Vec3 } from "../math/vec.js";
import { RigidBodyComponent, ColliderComponent } from "./components.js";
import { PhysicsWorld, type PhysicsWorldOptions } from "./world.js";
import { RigidBody } from "./body.js";
import type { PhysicsBackend } from "./backend.js";

/**
 * Options for {@link PhysicsSystem}.
 *
 * Omit `world`/`backend` to create and own a new {@link PhysicsWorld} (default / single-owner).
 * Pass either to adopt a shared world (e.g. the one behind a {@link ForgeJSPhysics} used by vehicles).
 */
export interface PhysicsSystemOptions extends PhysicsWorldOptions {
  /** Adopt this world instead of constructing a new one. */
  world?: PhysicsWorld;
  /**
   * Adopt `backend.world` when it is a JS backend. Ignored if `world` is also set.
   * WASM backends have no world yet — falls back to creating a new owned world.
   */
  backend?: PhysicsBackend;
}

/** Per-body kinematic plan for distributing a frame's Transform delta across fixedSteps. */
interface KinematicPlan {
  sx: number;
  sy: number;
  sz: number;
  srx: number;
  sry: number;
  srz: number;
  srw: number;
  ex: number;
  ey: number;
  ez: number;
  erx: number;
  ery: number;
  erz: number;
  erw: number;
}

export class PhysicsSystem extends FixedSystem {
  readonly name = "physics";
  override readonly order = 300;
  override readonly before = ["transforms"];

  readonly world: PhysicsWorld;
  /** True when this system constructed the world; false when it adopted one. */
  readonly ownsWorld: boolean;
  private readonly scratchDeltaQ = new Quat();
  private readonly scratchInvQ = new Quat();
  private readonly scratchStartQ = new Quat();
  private readonly scratchEndQ = new Quat();
  private readonly scratchTargetQ = new Quat();
  private readonly scratchStartP = new Vec3();
  private readonly scratchEndP = new Vec3();
  private readonly scratchTargetP = new Vec3();
  /** Frame kinematic plans keyed by body id — built once per update, consumed per substep. */
  private readonly kinematicPlans = new Map<number, KinematicPlan>();

  constructor(options: PhysicsSystemOptions = {}) {
    super();
    const adopted = options.world ?? options.backend?.world ?? null;
    if (adopted) {
      this.world = adopted;
      this.ownsWorld = false;
    } else {
      this.world = new PhysicsWorld(options);
      this.ownsWorld = true;
    }
  }

  override fixedStep(context: SystemContext, stepIndex: number): void {
    const fixedDt = context.fixedDt;
    const fixedSteps = Math.max(1, context.fixedSteps | 0);
    const q = context.world.query([RigidBodyComponent, Transform]);
    q.refresh();

    // Ensure physics bodies exist and match components
    for (let i = 0; i < q.count; i++) {
      const id = q.entity(i);
      const rbComp = q.value(0, i) as RigidBodyComponent;
      const transform = q.value(1, i) as Transform;

      if (!rbComp.body) {
        const colComp = context.world.getComponent(id, ColliderComponent) as ColliderComponent | undefined;
        const shape = colComp?.shape;
        if (!shape) continue;

        const body = new RigidBody({
          type: rbComp.bodyType,
          shape,
          mass: rbComp.mass,
          position: transform.position,
          rotation: transform.rotation,
          restitution: rbComp.restitution,
          friction: rbComp.friction,
        });

        this.world.addBody(body);
        rbComp.body = body;
      }
    }

    // Push kinematic / static poses from ECS into the solver so driven colliders (vehicle chassis)
    // participate this substep. Derive velocities from the pose delta so props see spin/sweep even
    // when syncVehicleChassis is not used; if the pose did not change (already synced), keep the
    // existing linear/angular velocities.
    //
    // When context.fixedSteps > 1, other FixedSystems (e.g. VehicleSystem) have already advanced
    // Transform through all substeps before this system runs. Distribute the full frame delta
    // across our substeps so velocities are per-fixedDt, not ~fixedSteps too high.
    const frameDt = fixedDt * fixedSteps;
    const invFrameDt = frameDt > 1e-12 ? 1 / frameDt : 0;

    for (let i = 0; i < q.count; i++) {
      const rbComp = q.value(0, i) as RigidBodyComponent;
      const transform = q.value(1, i) as Transform;
      if (rbComp.body && rbComp.bodyType !== "dynamic") {
        const body = rbComp.body;

        // Capture start/end once on the first substep (or when a body appears mid-frame).
        let plan = this.kinematicPlans.get(body.id);
        if (!plan) {
          const dx0 = transform.position.x - body.position.x;
          const dy0 = transform.position.y - body.position.y;
          const dz0 = transform.position.z - body.position.z;
          const poseMoved = dx0 * dx0 + dy0 * dy0 + dz0 * dz0 > 1e-20;
          const dr0 =
            Math.abs(transform.rotation.x - body.rotation.x) +
            Math.abs(transform.rotation.y - body.rotation.y) +
            Math.abs(transform.rotation.z - body.rotation.z) +
            Math.abs(transform.rotation.w - body.rotation.w);
          const rotMoved = dr0 > 1e-10;
          if (poseMoved || rotMoved) {
            plan = {
              sx: body.position.x,
              sy: body.position.y,
              sz: body.position.z,
              srx: body.rotation.x,
              sry: body.rotation.y,
              srz: body.rotation.z,
              srw: body.rotation.w,
              ex: transform.position.x,
              ey: transform.position.y,
              ez: transform.position.z,
              erx: transform.rotation.x,
              ery: transform.rotation.y,
              erz: transform.rotation.z,
              erw: transform.rotation.w,
            };
            this.kinematicPlans.set(body.id, plan);
          }
        }

        if (plan) {
          const t = (stepIndex + 1) / fixedSteps;
          this.scratchStartP.set(plan.sx, plan.sy, plan.sz);
          this.scratchEndP.set(plan.ex, plan.ey, plan.ez);
          Vec3.lerpInto(this.scratchStartP, this.scratchEndP, t, this.scratchTargetP);

          this.scratchStartQ.set(plan.srx, plan.sry, plan.srz, plan.srw);
          this.scratchEndQ.set(plan.erx, plan.ery, plan.erz, plan.erw);
          Quat.slerpInto(this.scratchStartQ, this.scratchEndQ, t, this.scratchTargetQ);

          // Constant velocity across substeps = full frame delta / frame time.
          body.linearVelocity.set(
            (plan.ex - plan.sx) * invFrameDt,
            (plan.ey - plan.sy) * invFrameDt,
            (plan.ez - plan.sz) * invFrameDt,
          );
          this.scratchInvQ.copyFrom(this.scratchStartQ).conjugate();
          this.scratchDeltaQ.copyFrom(this.scratchEndQ).multiply(this.scratchInvQ);
          if (this.scratchDeltaQ.w < 0) {
            this.scratchDeltaQ.x = -this.scratchDeltaQ.x;
            this.scratchDeltaQ.y = -this.scratchDeltaQ.y;
            this.scratchDeltaQ.z = -this.scratchDeltaQ.z;
            this.scratchDeltaQ.w = -this.scratchDeltaQ.w;
          }
          const qw = Math.min(1, Math.max(-1, this.scratchDeltaQ.w));
          const sinHalf = Math.sqrt(Math.max(0, 1 - qw * qw));
          if (sinHalf > 1e-8) {
            const angle = 2 * Math.acos(qw);
            const s = (angle * invFrameDt) / sinHalf;
            body.angularVelocity.set(
              this.scratchDeltaQ.x * s,
              this.scratchDeltaQ.y * s,
              this.scratchDeltaQ.z * s,
            );
          } else {
            body.angularVelocity.set(
              this.scratchDeltaQ.x * 2 * invFrameDt,
              this.scratchDeltaQ.y * 2 * invFrameDt,
              this.scratchDeltaQ.z * 2 * invFrameDt,
            );
          }

          body.prevPosition.copyFrom(body.position);
          body.prevRotation.copyFrom(body.rotation);
          body.position.copyFrom(this.scratchTargetP);
          body.rotation.copyFrom(this.scratchTargetQ);
          body.updateAABB();
        } else {
          // Already synced (e.g. syncVehicleChassis) — keep existing velocities, refresh pose.
          body.prevPosition.copyFrom(body.position);
          body.prevRotation.copyFrom(body.rotation);
          body.position.copyFrom(transform.position);
          body.rotation.copyFrom(transform.rotation);
          body.updateAABB();
        }
      }
    }

    // ECS owns the fixed clock. One deterministic solver step matching context.fixedDt —
    // never the variable-dt accumulator (which can run 0/N steps on an adopted/shared world).
    this.world.stepOnce(fixedDt);
  }

  override update(context: SystemContext): void {
    // FixedSystem.update is overridden so we can sync dynamic render poses after the substeps.
    this.kinematicPlans.clear();
    for (let i = 0; i < context.fixedSteps; i++) {
      this.fixedStep(context, i);
      this.stepsExecuted++;
    }
    this.kinematicPlans.clear();

    const q = context.world.query([RigidBodyComponent, Transform]);
    q.refresh();

    // Synchronize interpolated render poses to ECS Transforms
    for (let i = 0; i < q.count; i++) {
      const rbComp = q.value(0, i) as RigidBodyComponent;
      const transform = q.value(1, i) as Transform;

      if (rbComp.body && rbComp.bodyType === "dynamic") {
        transform.position.copyFrom(rbComp.body.renderPosition);
        transform.rotation.copyFrom(rbComp.body.renderRotation);
      }
    }
  }

  override dispose(): void {
    // Only clear when we own the world — shared worlds are managed by the adopter/owner.
    if (this.ownsWorld) {
      this.world.clear();
    }
  }
}
