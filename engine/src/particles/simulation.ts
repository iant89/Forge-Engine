/**
 * CPU particle simulation. This is the fallback and the reference: the GPU shader implements the
 * same gravity/drag/life step, and the modules here cover everything the shader does not (colour,
 * size). One `Float32Array` holds every particle — 100k particles are not 100k entities.
 */

import { integrateParticle, isAlive, PARTICLE_FLOATS, type ParticleGravity } from "./layout.js";
import { ParticleEmitter } from "./emitter.js";
import type { ParticleModule } from "./modules.js";
import { ParticleTrails } from "./trails.js";

export interface ParticleSimulationOptions {
  /** Hard cap. The state buffer is allocated once at this size. */
  capacity?: number;
  maxEmitsPerFrame?: number;
  gravity?: ParticleGravity;
  drag?: number;
  trailLength?: number;
  seed?: number;
}

export class ParticleSimulation {
  readonly capacity: number;
  readonly state: Float32Array;
  readonly gravity: ParticleGravity;
  drag: number;
  maxEmitsPerFrame: number;
  readonly emitter: ParticleEmitter;
  readonly modules: ParticleModule[] = [];
  readonly trails: ParticleTrails;
  alive = 0;
  emitted = 0;
  stepCount = 0;

  constructor(options: ParticleSimulationOptions = {}) {
    this.capacity = Math.max(1, options.capacity ?? 1024);
    this.state = new Float32Array(this.capacity * PARTICLE_FLOATS);
    this.gravity = options.gravity ?? { x: 0, y: -9.81, z: 0 };
    this.drag = options.drag ?? 0;
    this.maxEmitsPerFrame = options.maxEmitsPerFrame ?? 512;
    this.emitter = new ParticleEmitter({ seed: options.seed ?? 1 });
    this.trails = new ParticleTrails(this.capacity, options.trailLength ?? 8);
  }

  /** Integrate every alive particle. Does not emit. Used by the analytic gravity test. */
  integrateAll(dt: number): void {
    const g = this.gravity;
    for (let i = 0; i < this.capacity; i++) integrateParticle(this.state, i, dt, g, this.drag);
    this.recount();
  }

  /**
   * One frame: emit (budget-capped), integrate, run modules, record trails.
   * Modules run after integration so colour/size see the new age. Gravity/drag modules are not
   * required — those are in the integrator so the shader and the CPU cannot drift.
   */
  step(dt: number): void {
    if (!(dt > 0)) return;
    const born = this.emitter.emit(this.state, dt, this.maxEmitsPerFrame);
    this.emitted += born;
    this.integrateAll(dt);
    for (const mod of this.modules) {
      for (let i = 0; i < this.capacity; i++) {
        if (!isAlive(this.state, i)) continue;
        mod.apply(this.state, i, dt);
      }
    }
    this.trails.record(this.state);
    this.stepCount++;
  }

  recount(): void {
    let n = 0;
    for (let i = 0; i < this.capacity; i++) if (isAlive(this.state, i)) n++;
    this.alive = n;
  }
}
