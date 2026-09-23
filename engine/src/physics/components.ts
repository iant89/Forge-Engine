/**
 * ECS Components for Physics Subsystem.
 */

import { Component, registerComponent } from "../scene/components.js";
import { RigidBody, type BodyType } from "./body.js";
import { Shape, SphereShape, BoxShape } from "./shapes.js";

export class RigidBodyComponent extends Component {
  body: RigidBody | null = null;
  bodyType: BodyType = "dynamic";
  mass = 1.0;
  restitution = 0.2;
  friction = 0.5;

  /**
   * Optional release hook installed by {@link PhysicsSystem} when it spawns `body`.
   * Invoked from {@link onDetach} so shared-world despawn removes the collider immediately
   * (and drops the body from PhysicsSystem spawned tracking).
   */
  onPhysicsDetach: (() => void) | null = null;

  override onDetach(): void {
    const hook = this.onPhysicsDetach;
    this.onPhysicsDetach = null;
    hook?.();
    this.body = null;
  }
}

export class ColliderComponent extends Component {
  shape: Shape = new SphereShape(0.5);

  setSphere(radius: number): this {
    this.shape = new SphereShape(radius);
    return this;
  }

  setBox(halfX: number, halfY: number, halfZ: number): this {
    this.shape = new BoxShape(halfX, halfY, halfZ);
    return this;
  }
}

registerComponent(RigidBodyComponent, { name: "RigidBodyComponent", allowMultiple: false });
registerComponent(ColliderComponent, { name: "ColliderComponent", allowMultiple: false });
