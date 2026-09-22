/**
 * Rate-based emitter. Emission is a deterministic `Rng` stream, capped by the simulation budget
 * (`maxParticles` and `maxEmitsPerFrame`). Dead slots are recycled; nothing here allocates an entity.
 */

import { Rng } from "../math/rng.js";
import {
  FLAG_ALIVE,
  P_A,
  P_AGE,
  P_B,
  P_FLAGS,
  P_G,
  P_LIFE,
  P_MAX_LIFE,
  P_R,
  P_SEED,
  P_SIZE,
  P_VX,
  P_VY,
  P_VZ,
  P_X,
  P_Y,
  P_Z,
  PARTICLE_FLOATS,
  isAlive,
} from "./layout.js";
import { sampleCone, type ConeEmission } from "./modules.js";

export interface EmitterOptions {
  rate?: number;
  /** Particles per second. Fractional leftover carries to the next step. */
  lifeMin?: number;
  lifeMax?: number;
  size?: number;
  position?: { x: number; y: number; z: number };
  cone?: ConeEmission;
  color?: { r: number; g: number; b: number; a: number };
  seed?: number;
}

export class ParticleEmitter {
  rate: number;
  lifeMin: number;
  lifeMax: number;
  size: number;
  position = { x: 0, y: 0, z: 0 };
  cone: ConeEmission;
  color = { r: 1, g: 0.75, b: 0.3, a: 1 };
  readonly rng: Rng;
  private accumulator = 0;
  private readonly scratch = { x: 0, y: 0, z: 0 };

  constructor(options: EmitterOptions = {}) {
    this.rate = options.rate ?? 40;
    this.lifeMin = options.lifeMin ?? 1.2;
    this.lifeMax = options.lifeMax ?? 2.4;
    this.size = options.size ?? 0.18;
    if (options.position) {
      this.position.x = options.position.x;
      this.position.y = options.position.y;
      this.position.z = options.position.z;
    }
    this.cone = options.cone ?? {
      direction: { x: 0, y: 1, z: 0 },
      angle: 0.18,
      speedMin: 5,
      speedMax: 8,
    };
    if (options.color) this.color = { ...options.color };
    this.rng = new Rng(options.seed ?? 1);
  }

  /**
   * Spawn up to `budget` particles into dead slots. Returns how many were actually born.
   * `budget` is the caller's per-frame cap; the buffer length is the hard cap.
   */
  emit(state: Float32Array, dt: number, budget: number): number {
    const capacity = state.length / PARTICLE_FLOATS;
    this.accumulator += Math.max(0, this.rate) * dt;
    let want = Math.floor(this.accumulator);
    if (want > budget) want = budget;
    this.accumulator -= want;
    if (want <= 0) return 0;
    let spawned = 0;
    for (let i = 0; i < capacity && spawned < want; i++) {
      if (isAlive(state, i)) continue;
      this.write(state, i);
      spawned++;
    }
    return spawned;
  }

  private write(state: Float32Array, index: number): void {
    const o = index * PARTICLE_FLOATS;
    const life = this.lifeMin + (this.lifeMax - this.lifeMin) * this.rng.nextFloat();
    sampleCone(this.cone, this.rng, this.scratch);
    state[o + P_X] = this.position.x;
    state[o + P_Y] = this.position.y;
    state[o + P_Z] = this.position.z;
    state[o + P_LIFE] = life;
    state[o + P_VX] = this.scratch.x;
    state[o + P_VY] = this.scratch.y;
    state[o + P_VZ] = this.scratch.z;
    state[o + P_MAX_LIFE] = life;
    state[o + P_R] = this.color.r;
    state[o + P_G] = this.color.g;
    state[o + P_B] = this.color.b;
    state[o + P_A] = this.color.a;
    state[o + P_SIZE] = this.size;
    state[o + P_SEED] = this.rng.nextFloat();
    state[o + P_AGE] = 0;
    state[o + P_FLAGS] = FLAG_ALIVE;
  }
}
