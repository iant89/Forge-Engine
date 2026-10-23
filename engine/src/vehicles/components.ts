/**
 * ECS handle for a {@link Vehicle}. The component does not step the car — `VehicleSystem` does,
 * once per fixed step. Putting `vehicle.step` in a scene `update` as well double-integrates.
 */

import type { EntityId } from "../scene/entityId.js";
import { Component, registerComponent } from "../scene/components.js";
import type { RigidBody } from "../physics/body.js";
import type { PhysicsWorld } from "../physics/world.js";
import { Vehicle, createVehicleConfig, type VehicleConfig } from "./vehicle.js";
import type { GroundQuery } from "./ground.js";

export class VehicleComponent extends Component {
  static readonly typeName = "Vehicle";
  readonly vehicle: Vehicle;
  /** Wheel visual entities, in the same order as `vehicle.wheels`. Optional. */
  wheelEntities: EntityId[] = [];
  ground: GroundQuery;
  /**
   * Optional chassis collider in the physics world (Phase 11.3 / 23.3).
   * Kinematic bodies use PhysicsSystem's Transform pose-delta path. Dynamic bodies are opt-in:
   * VehicleSystem queues the raycast wheel-model acceleration and PhysicsSystem advances this body,
   * then feeds its solved pose back to the Vehicle. Neither mode is snapped by VehicleSystem.
   *
   * Pair with {@link chassisWorld} so {@link onDetach} can `removeBody` immediately
   * (same pattern as RigidBodyComponent despawn on a shared world).
   */
  chassisBody: RigidBody | null = null;
  /**
   * Physics world that owns {@link chassisBody}. Required for detach teardown in the
   * shared-world recipe — without it, despawn would leave a ghost kinematic collider.
   */
  chassisWorld: PhysicsWorld | null = null;

  constructor(vehicle: Vehicle = new Vehicle(createVehicleConfig()), ground?: GroundQuery) {
    super();
    this.vehicle = vehicle;
    this.ground = ground ?? { sample(_x, _z, out) { out.height = 0; out.nx = 0; out.ny = 1; out.nz = 0; } };
  }

  /**
   * Shared-world recipe helper: assign the kinematic or dynamic chassis and record its world so
   * {@link onDetach} can remove it. If a prior chassis/world pair is set and differs,
   * removes the prior body from its world first (hot-swap / respawn — no ghost collider).
   */
  attachChassis(body: RigidBody, world: PhysicsWorld): void {
    const priorBody = this.chassisBody;
    const priorWorld = this.chassisWorld;
    if (priorBody && priorWorld && (priorBody !== body || priorWorld !== world)) {
      priorWorld.removeBody(priorBody);
    }
    this.chassisBody = body;
    this.chassisWorld = world;
  }

  /**
   * Remove the chassis from its physics world and clear handles.
   * Invoked on `destroyEntity` / `removeComponent(VehicleComponent)` so shared-world
   * despawn does not leave a ghost collider until PhysicsSystem.dispose().
   */
  override onDetach(): void {
    const body = this.chassisBody;
    const world = this.chassisWorld;
    this.chassisBody = null;
    this.chassisWorld = null;
    if (body && world) {
      world.removeBody(body);
    }
  }
}

registerComponent(VehicleComponent, {
  name: "Vehicle",
  allowMultiple: false,
  // Phase 19.3: the vehicle's mid-run state (Vehicle.snapshot). The chassis body, if any, is in the
  // physics world's snapshot; the ground query is the scene's.
  snapshot: (c) => (c as VehicleComponent).vehicle.snapshot(),
  restoreSnapshot: (c, state) => (c as VehicleComponent).vehicle.restoreSnapshot(state),
});

export function createVehicleComponent(config?: VehicleConfig, ground?: GroundQuery): VehicleComponent {
  return new VehicleComponent(config ? new Vehicle(config) : new Vehicle(createVehicleConfig()), ground);
}
