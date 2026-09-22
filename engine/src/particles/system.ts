/**
 * Particle system, band 400 (world). Variable rate: particles are a presentation effect, and the
 * analytic check calls {@link ParticleSimulation.step} directly with a fixed dt. One step per
 * frame, not once per physics substep — a 5× catch-up must not quintuple a fountain.
 *
 * Sprite entities, when the component lists them, are posed from the first alive particles and
 * hidden otherwise. The renderer recomputes world matrices after systems, so a write here is
 * visible the same frame.
 */

import { System, type SystemContext } from "../scene/systems.js";
import { Renderable, Transform } from "../scene/components/index.js";
import { ParticleComponent } from "./components.js";
import { isAlive, P_X, P_Y, P_Z, P_SIZE, PARTICLE_FLOATS } from "./layout.js";

export class ParticleSystem extends System {
  readonly name = "particles";
  override readonly order = 400;
  override readonly before = ["transforms"];

  override update(context: SystemContext): void {
    const dt = context.dt;
    if (!(dt > 0)) return;
    const world = context.world;
    const store = world.store(ParticleComponent);
    for (let i = 0; i < store.count; i++) {
      const comp = store.valueAt(i);
      if (!comp.enabled) continue;
      comp.simulation.step(dt);
      this.writeSprites(comp, world);
    }
  }

  private writeSprites(comp: ParticleComponent, world: SystemContext["world"]): void {
    if (comp.spriteEntities.length === 0) return;
    const state = comp.simulation.state;
    const alive: number[] = [];
    const capacity = state.length / PARTICLE_FLOATS;
    for (let i = 0; i < capacity && alive.length < comp.spriteEntities.length; i++) {
      if (isAlive(state, i)) alive.push(i);
    }
    for (let s = 0; s < comp.spriteEntities.length; s++) {
      const id = comp.spriteEntities[s];
      if (id === undefined || !world.exists(id)) continue;
      const transform = world.getComponent(id, Transform);
      const renderable = world.getComponent(id, Renderable);
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
}
