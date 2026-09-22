/**
 * ECS handle for a {@link Vehicle}. The component does not step the car — `VehicleSystem` does,
 * once per fixed step. Putting `vehicle.step` in a scene `update` as well double-integrates.
 */

import type { EntityId } from "../scene/entityId.js";
import { Component, registerComponent } from "../scene/components.js";
import { Vehicle, createVehicleConfig, type VehicleConfig } from "./vehicle.js";
import type { GroundQuery } from "./ground.js";

export class VehicleComponent extends Component {
  static readonly typeName = "Vehicle";
  readonly vehicle: Vehicle;
  /** Wheel visual entities, in the same order as `vehicle.wheels`. Optional. */
  wheelEntities: EntityId[] = [];
  ground: GroundQuery;

  constructor(vehicle: Vehicle = new Vehicle(createVehicleConfig()), ground?: GroundQuery) {
    super();
    this.vehicle = vehicle;
    this.ground = ground ?? { sample(_x, _z, out) { out.height = 0; out.nx = 0; out.ny = 1; out.nz = 0; } };
  }
}

registerComponent(VehicleComponent, { name: "Vehicle", allowMultiple: false });

export function createVehicleComponent(config?: VehicleConfig, ground?: GroundQuery): VehicleComponent {
  return new VehicleComponent(config ? new Vehicle(config) : new Vehicle(createVehicleConfig()), ground);
}
