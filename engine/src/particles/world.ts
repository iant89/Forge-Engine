/**
 * Scene-object owner for a particle simulation. Use this when the fountain is a subsystem rather
 * than a component on an entity (the same split terrain uses). `update` is the only stepper —
 * the demo's own rAF must not call `simulation.step` as well.
 */

import { SceneObject } from "../scene/scene.js";
import type { SystemContext } from "../scene/systems.js";
import { Renderable, Transform } from "../scene/components/index.js";
import { ParticleSimulation, type ParticleSimulationOptions } from "./simulation.js";
import { isAlive, P_SIZE, P_X, P_Y, P_Z, PARTICLE_FLOATS } from "./layout.js";
import type { EntityId } from "../scene/entityId.js";

export class ParticleWorld extends SceneObject {
  readonly name: string;
  readonly simulation: ParticleSimulation;
  /** Sprite entities posed from the first N alive particles. Created by the caller (needs a mesh). */
  spriteEntities: EntityId[] = [];

  constructor(options: ParticleSimulationOptions & { name?: string } = {}) {
    super();
    this.name = options.name ?? "particles";
    this.simulation = new ParticleSimulation(options);
  }

  override update(_context: SystemContext, dt: number): void {
    if (!(dt > 0)) return;
    this.simulation.step(dt);
    const scene = this.scene;
    if (!scene || this.spriteEntities.length === 0) return;
    const state = this.simulation.state;
    const alive: number[] = [];
    const capacity = state.length / PARTICLE_FLOATS;
    for (let i = 0; i < capacity && alive.length < this.spriteEntities.length; i++) {
      if (isAlive(state, i)) alive.push(i);
    }
    for (let s = 0; s < this.spriteEntities.length; s++) {
      const id = this.spriteEntities[s];
      if (id === undefined || !scene.world.exists(id)) continue;
      const transform = scene.world.getComponent(id, Transform);
      const renderable = scene.world.getComponent(id, Renderable);
      const slot = alive[s];
      if (slot === undefined) {
        if (renderable) renderable.visible = false;
        continue;
      }
      const o = slot * PARTICLE_FLOATS;
      transform?.setPosition(state[o + P_X]!, state[o + P_Y]!, state[o + P_Z]!);
      const size = state[o + P_SIZE]!;
      if (size > 0) transform?.setScale(size, size, size);
      if (renderable) renderable.visible = true;
    }
  }

  override stats(): Record<string, number | string | boolean> {
    return {
      alive: this.simulation.alive,
      capacity: this.simulation.capacity,
      emitted: this.simulation.emitted,
      steps: this.simulation.stepCount,
    };
  }
}
