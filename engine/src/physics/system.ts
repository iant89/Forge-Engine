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

export class PhysicsSystem extends FixedSystem {
  readonly name = "physics";
  override readonly order = 300;
  override readonly before = ["transforms"];

  readonly world: PhysicsWorld;
  /** True when this system constructed the world; false when it adopted one. */
  readonly ownsWorld: boolean;
  private readonly scratchDeltaQ = new Quat();
  private readonly scratchInvQ = new Quat();

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

  override fixedStep(context: SystemContext, _stepIndex: number): void {
    const fixedDt = context.fixedDt;
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
    const invDt = fixedDt > 1e-12 ? 1 / fixedDt : 0;
    for (let i = 0; i < q.count; i++) {
      const rbComp = q.value(0, i) as RigidBodyComponent;
      const transform = q.value(1, i) as Transform;
      if (rbComp.body && rbComp.bodyType !== "dynamic") {
        const body = rbComp.body;
        const dx = transform.position.x - body.position.x;
        const dy = transform.position.y - body.position.y;
        const dz = transform.position.z - body.position.z;
        const poseMoved = dx * dx + dy * dy + dz * dz > 1e-20;
        const dr =
          Math.abs(transform.rotation.x - body.rotation.x) +
          Math.abs(transform.rotation.y - body.rotation.y) +
          Math.abs(transform.rotation.z - body.rotation.z) +
          Math.abs(transform.rotation.w - body.rotation.w);
        const rotMoved = dr > 1e-10;
        if (poseMoved || rotMoved) {
          body.linearVelocity.set(dx * invDt, dy * invDt, dz * invDt);
          // q_delta = q_new * q_old^{-1} → ω from angle/axis over fixedDt.
          this.scratchInvQ.copyFrom(body.rotation).conjugate();
          this.scratchDeltaQ.copyFrom(transform.rotation).multiply(this.scratchInvQ);
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
            const s = (angle * invDt) / sinHalf;
            body.angularVelocity.set(
              this.scratchDeltaQ.x * s,
              this.scratchDeltaQ.y * s,
              this.scratchDeltaQ.z * s,
            );
          } else {
            body.angularVelocity.set(
              this.scratchDeltaQ.x * 2 * invDt,
              this.scratchDeltaQ.y * 2 * invDt,
              this.scratchDeltaQ.z * 2 * invDt,
            );
          }
        }
        body.prevPosition.copyFrom(body.position);
        body.prevRotation.copyFrom(body.rotation);
        body.position.copyFrom(transform.position);
        body.rotation.copyFrom(transform.rotation);
        body.updateAABB();
      }
    }

    this.world.step(fixedDt);
  }

  override update(context: SystemContext): void {
    // FixedSystem.update is overridden so we can sync dynamic render poses after the substeps.
    for (let i = 0; i < context.fixedSteps; i++) {
      this.fixedStep(context, i);
      this.stepsExecuted++;
    }

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
