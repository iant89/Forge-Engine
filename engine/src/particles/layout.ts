/**
 * Particle state layout. 64 bytes, 16 floats, 16-byte aligned so a `vec3+f32` WGSL struct and a
 * `Float32Array` describe the same memory.
 *
 * ```
 *  0 px  1 py  2 pz  3 life
 *  4 vx  5 vy  6 vz  7 maxLife
 *  8 cr  9 cg 10 cb 11 ca
 * 12 size 13 seed 14 age 15 flags
 * ```
 *
 * `flags` 1 = alive. `life` counts down; `age` counts up. Both integrators (CPU and the compute
 * shader) use semi-implicit Euler: velocity, then position, then life. After `n` steps of gravity
 * with `v0 = 0`, `vy = g·n·dt` and `y = y0 + g·dt²·n·(n+1)/2` — not `½ g t²`, which is the
 * continuous integral and does not match this discretisation.
 */

export const PARTICLE_FLOATS = 16;
export const PARTICLE_STRIDE = PARTICLE_FLOATS * 4;

export const P_X = 0;
export const P_Y = 1;
export const P_Z = 2;
export const P_LIFE = 3;
export const P_VX = 4;
export const P_VY = 5;
export const P_VZ = 6;
export const P_MAX_LIFE = 7;
export const P_R = 8;
export const P_G = 9;
export const P_B = 10;
export const P_A = 11;
export const P_SIZE = 12;
export const P_SEED = 13;
export const P_AGE = 14;
export const P_FLAGS = 15;

export const FLAG_ALIVE = 1;

export interface ParticleGravity {
  x: number;
  y: number;
  z: number;
}

/** Write a dead particle. Does not allocate. */
export function clearParticle(state: Float32Array, index: number): void {
  const o = index * PARTICLE_FLOATS;
  state.fill(0, o, o + PARTICLE_FLOATS);
}

export function isAlive(state: Float32Array, index: number): boolean {
  const o = index * PARTICLE_FLOATS;
  return state[o + P_FLAGS]! >= 0.5 && state[o + P_LIFE]! > 0;
}

/**
 * Semi-implicit Euler shared with `PARTICLE_SIM_SHADER`. Gravity is added to velocity, drag damps
 * velocity (`v *= max(0, 1 − drag·dt)`), then position integrates the new velocity, then life.
 * A particle whose life reaches 0 is flagged dead and left where it died.
 */
export function integrateParticle(state: Float32Array, index: number, dt: number, gravity: ParticleGravity, drag: number): void {
  const o = index * PARTICLE_FLOATS;
  if (state[o + P_FLAGS]! < 0.5 || state[o + P_LIFE]! <= 0) return;
  let vx = state[o + P_VX]! + gravity.x * dt;
  let vy = state[o + P_VY]! + gravity.y * dt;
  let vz = state[o + P_VZ]! + gravity.z * dt;
  if (drag > 0) {
    const damp = Math.max(0, 1 - drag * dt);
    vx *= damp;
    vy *= damp;
    vz *= damp;
  }
  state[o + P_VX] = vx;
  state[o + P_VY] = vy;
  state[o + P_VZ] = vz;
  state[o + P_X] = state[o + P_X]! + vx * dt;
  state[o + P_Y] = state[o + P_Y]! + vy * dt;
  state[o + P_Z] = state[o + P_Z]! + vz * dt;
  state[o + P_LIFE] = state[o + P_LIFE]! - dt;
  state[o + P_AGE] = state[o + P_AGE]! + dt;
  if (state[o + P_LIFE]! <= 0) {
    state[o + P_LIFE] = 0;
    state[o + P_FLAGS] = 0;
  }
}

/**
 * Closed form of {@link integrateParticle} under constant gravity, zero drag, `v0 = 0`.
 * `t = n·dt` is the elapsed time; the extra `+ dt` in the position term is the semi-implicit bias.
 */
export function analyticGravity(y0: number, gravityY: number, steps: number, dt: number): { y: number; vy: number } {
  const n = steps;
  const vy = gravityY * n * dt;
  const y = y0 + gravityY * dt * dt * n * (n + 1) * 0.5;
  return { y, vy };
}
