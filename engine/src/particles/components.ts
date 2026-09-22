/**
 * ECS handle for a {@link ParticleSimulation}. The component does not step itself —
 * {@link ParticleSystem} does, once per frame. A {@link ParticleWorld} scene object is the other
 * owner; don't attach both to the same simulation or it will integrate twice.
 */

import { Component, registerComponent } from "../scene/components.js";
import type { EntityId } from "../scene/entityId.js";
import { ParticleSimulation, type ParticleSimulationOptions } from "./simulation.js";

export class ParticleComponent extends Component {
  static readonly typeName = "Particles";
  readonly simulation: ParticleSimulation;
  /** Optional sprite entities the system poses from the first N alive particles. */
  spriteEntities: EntityId[] = [];

  constructor(simulation: ParticleSimulation = new ParticleSimulation()) {
    super();
    this.simulation = simulation;
  }
}

registerComponent(ParticleComponent, {
  name: "Particles",
  allowMultiple: false,
});

export function createParticleComponent(options?: ParticleSimulationOptions): ParticleComponent {
  return new ParticleComponent(new ParticleSimulation(options));
}
