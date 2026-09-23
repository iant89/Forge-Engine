/**
 * `PhysicsSystem` — ECS bridge synchronizing Entity Transforms with PhysicsWorld.
 *
 * Runs in band 300 (physics), before band 500 (transforms).
 */

import { FixedSystem, type SystemContext } from "../scene/systems.js";
import { Transform } from "../scene/components/index.js";
import { RigidBodyComponent, ColliderComponent } from "./components.js";
import { PhysicsWorld, type PhysicsWorldOptions } from "./world.js";
import { RigidBody } from "./body.js";

export class PhysicsSystem extends FixedSystem {
  readonly name = "physics";
  override readonly order = 300;
  override readonly before = ["transforms"];

  readonly world: PhysicsWorld;

  constructor(options: PhysicsWorldOptions = {}) {
    super();
    this.world = new PhysicsWorld(options);
  }

  override fixedStep(context: SystemContext, fixedDt: number): void {
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
    // participate this substep.
    for (let i = 0; i < q.count; i++) {
      const rbComp = q.value(0, i) as RigidBodyComponent;
      const transform = q.value(1, i) as Transform;
      if (rbComp.body && rbComp.bodyType !== "dynamic") {
        rbComp.body.position.copyFrom(transform.position);
        rbComp.body.rotation.copyFrom(transform.rotation);
        rbComp.body.updateAABB();
      }
    }

    this.world.step(fixedDt);
  }

  override update(context: SystemContext): void {
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
    this.world.clear();
  }
}
