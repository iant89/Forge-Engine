/**
 * CPU particle modules (Phase 12 reference path). Each one mutates a slice of the state buffer
 * and nothing else. GPU full-sim is authoritative for the live particle path; these classes remain
 * as the analytic/reference and CPU fallback implementation. Do not remove them without an
 * explicit keep-or-remove decision (Velocity/Attractor/RotationOverLife included).
 */

import { clamp, lerp } from "../math/scalar.js";
import { Rng } from "../math/rng.js";
import { P_A, P_AGE, P_B, P_FLAGS, P_G, P_LIFE, P_MAX_LIFE, P_R, P_SEED, P_SIZE, P_VX, P_VY, P_VZ, P_X, P_Y, P_Z, PARTICLE_FLOATS } from "./layout.js";

export interface ParticleModule {
  readonly name: string;
  apply(state: Float32Array, index: number, dt: number): void;
}

export class GravityModule implements ParticleModule {
  readonly name = "gravity";
  constructor(
    public x = 0,
    public y = -9.81,
    public z = 0,
  ) {}
  apply(state: Float32Array, index: number, dt: number): void {
    const o = index * PARTICLE_FLOATS;
    if (state[o + P_FLAGS]! < 0.5) return;
    state[o + P_VX] = state[o + P_VX]! + this.x * dt;
    state[o + P_VY] = state[o + P_VY]! + this.y * dt;
    state[o + P_VZ] = state[o + P_VZ]! + this.z * dt;
  }
}

export class DragModule implements ParticleModule {
  readonly name = "drag";
  constructor(public drag = 0.4) {}
  apply(state: Float32Array, index: number, dt: number): void {
    const o = index * PARTICLE_FLOATS;
    if (state[o + P_FLAGS]! < 0.5 || this.drag <= 0) return;
    const damp = Math.max(0, 1 - this.drag * dt);
    state[o + P_VX] = state[o + P_VX]! * damp;
    state[o + P_VY] = state[o + P_VY]! * damp;
    state[o + P_VZ] = state[o + P_VZ]! * damp;
  }
}

export interface ColorStop {
  r: number;
  g: number;
  b: number;
  a: number;
}

export class ColorOverLifeModule implements ParticleModule {
  readonly name = "color-over-life";
  constructor(
    public from: ColorStop = { r: 1, g: 0.7, b: 0.2, a: 1 },
    public to: ColorStop = { r: 0.4, g: 0.05, b: 0.02, a: 0 },
  ) {}
  apply(state: Float32Array, index: number, _dt: number): void {
    const o = index * PARTICLE_FLOATS;
    if (state[o + P_FLAGS]! < 0.5) return;
    const maxLife = state[o + P_MAX_LIFE]!;
    const t = maxLife > 1e-6 ? clamp(state[o + P_AGE]! / maxLife, 0, 1) : 1;
    state[o + P_R] = lerp(this.from.r, this.to.r, t);
    state[o + P_G] = lerp(this.from.g, this.to.g, t);
    state[o + P_B] = lerp(this.from.b, this.to.b, t);
    state[o + P_A] = lerp(this.from.a, this.to.a, t);
    void state[o + P_LIFE];
  }
}

export class SizeOverLifeModule implements ParticleModule {
  readonly name = "size-over-life";
  constructor(
    public start = 0.25,
    public end = 0.02,
  ) {}
  apply(state: Float32Array, index: number, _dt: number): void {
    const o = index * PARTICLE_FLOATS;
    if (state[o + P_FLAGS]! < 0.5) return;
    const maxLife = state[o + P_MAX_LIFE]!;
    const t = maxLife > 1e-6 ? clamp(state[o + P_AGE]! / maxLife, 0, 1) : 1;
    state[o + P_SIZE] = lerp(this.start, this.end, t);
  }
}

export interface ConeEmission {
  /** Axis the cone opens along. Does not need to be unit length; it is normalised at emit time. */
  direction: { x: number; y: number; z: number };
  /** Half-angle of the cone (radians). 0 is a ray. */
  angle: number;
  speedMin: number;
  speedMax: number;
}

/** Deterministic direction inside a cone. `rng` is the emitter's stream — never `Math.random`. */
export function sampleCone(cone: ConeEmission, rng: Rng, out: { x: number; y: number; z: number }): void {
  const len = Math.hypot(cone.direction.x, cone.direction.y, cone.direction.z) || 1;
  const dx = cone.direction.x / len;
  const dy = cone.direction.y / len;
  const dz = cone.direction.z / len;
  // Build a tangent basis. Pick the smaller axis so the cross product isn't degenerate.
  const ax = Math.abs(dy) < 0.9 ? 0 : 1;
  const ay = Math.abs(dy) < 0.9 ? 1 : 0;
  const az = 0;
  let tx = ay * dz - az * dy;
  let ty = az * dx - ax * dz;
  let tz = ax * dy - ay * dx;
  const tlen = Math.hypot(tx, ty, tz) || 1;
  tx /= tlen;
  ty /= tlen;
  tz /= tlen;
  const bx = dy * tz - dz * ty;
  const by = dz * tx - dx * tz;
  const bz = dx * ty - dy * tx;
  const u = rng.nextFloat();
  const v = rng.nextFloat();
  const theta = cone.angle * Math.sqrt(u);
  const phi = v * Math.PI * 2;
  const st = Math.sin(theta);
  const ct = Math.cos(theta);
  const cp = Math.cos(phi);
  const sp = Math.sin(phi);
  const speed = cone.speedMin + (cone.speedMax - cone.speedMin) * rng.nextFloat();
  out.x = (dx * ct + tx * st * cp + bx * st * sp) * speed;
  out.y = (dy * ct + ty * st * cp + by * st * sp) * speed;
  out.z = (dz * ct + tz * st * cp + bz * st * sp) * speed;
}

/** Constant velocity boost (wind / local force). Applied before gravity in the GPU full sim. */
export class VelocityModule implements ParticleModule {
  readonly name = "velocity";
  constructor(
    public x = 0,
    public y = 0,
    public z = 0,
  ) {}
  apply(state: Float32Array, index: number, dt: number): void {
    const o = index * PARTICLE_FLOATS;
    if (state[o + P_FLAGS]! < 0.5) return;
    state[o + P_VX] = state[o + P_VX]! + this.x * dt;
    state[o + P_VY] = state[o + P_VY]! + this.y * dt;
    state[o + P_VZ] = state[o + P_VZ]! + this.z * dt;
  }
}

/** Soft point attractor (inverse-square). Mirrors the GPU full-sim attractor term. */
export class AttractorModule implements ParticleModule {
  readonly name = "attractor";
  constructor(
    public x = 0,
    public y = 0,
    public z = 0,
    public strength = 0,
  ) {}
  apply(state: Float32Array, index: number, dt: number): void {
    const o = index * PARTICLE_FLOATS;
    if (state[o + P_FLAGS]! < 0.5 || this.strength === 0) return;
    const dx = this.x - state[o + P_X]!;
    const dy = this.y - state[o + P_Y]!;
    const dz = this.z - state[o + P_Z]!;
    const distSq = Math.max(dx * dx + dy * dy + dz * dz, 0.25);
    const s = (this.strength * dt) / distSq;
    state[o + P_VX] = state[o + P_VX]! + dx * s;
    state[o + P_VY] = state[o + P_VY]! + dy * s;
    state[o + P_VZ] = state[o + P_VZ]! + dz * s;
  }
}

/** Rotation-over-life: advances `P_SEED` as a phase, matching the GPU full sim. */
export class RotationOverLifeModule implements ParticleModule {
  readonly name = "rotation-over-life";
  constructor(public speed = 0.6) {}
  apply(state: Float32Array, index: number, dt: number): void {
    const o = index * PARTICLE_FLOATS;
    if (state[o + P_FLAGS]! < 0.5) return;
    const maxLife = state[o + P_MAX_LIFE]!;
    const t = maxLife > 1e-6 ? clamp(state[o + P_AGE]! / maxLife, 0, 1) : 1;
    const phase = state[o + P_SEED]! + this.speed * dt * (0.1 + t);
    state[o + P_SEED] = phase - Math.floor(phase);
  }
}
