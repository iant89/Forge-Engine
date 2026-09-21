/**
 * Deterministic pseudo-random number generation.
 *
 * Two families are provided:
 *
 * 1. `Rng` — a stream generator (PCG-ish via splitmix64 on BigInt-free 32-bit ops). Use it
 *    for anything that consumes numbers in sequence (scatter placement, jitter).
 * 2. `hash2i` / `hash3i` — *positional* hashes. Given integer lattice coordinates they return
 *    a stable value independent of how many other hashes were evaluated. Noise, chunk
 *    generation and worker-parallel scatter all depend on this property: with a stream RNG,
 *    results would change when workers finish in a different order.
 *
 * Both are 32-bit and reproducible in JS and in a future WASM build. Never use
 * `Math.random()` inside a deterministic subsystem (enforced by tests/architecture.test.ts).
 */

import { TAU } from "./scalar.js";

/**
 * Mix a 32-bit unsigned integer to a well-scrambled 32-bit unsigned integer (splitmix32 finalizer,
 * with a constant bias added first).
 *
 * The bias is not decoration: the raw finalizer has `mix32(0) === 0`, and `hash1i(0, seed=0)` /
 * `chunkSeed(0, 0, 0, 0)` — the chunk at the world origin — hit exactly that fixed point, which
 * made the first chunk's noise tile suspiciously flat. `mix32(0)` must be a normal-looking value.
 */
export function mix32(x: number): number {
  let h = (x + 0x9e3779b9) | 0;
  h = Math.imul(h ^ (h >>> 16), 0x21f0aaad);
  h = Math.imul(h ^ (h >>> 15), 0x735a2d97);
  h = (h ^ (h >>> 15)) >>> 0;
  return h;
}

/** Combine two 32-bit values into a well-mixed 32-bit value (order matters). */
export function combine32(a: number, b: number): number {
  return mix32((a ^ Math.imul(b + 0x9e3779b9, 0x85ebca6b)) >>> 0);
}

/** Seed a stream from an arbitrary integer. */
export function seedStream(seed: number): number {
  return mix32((seed | 0) ^ 0x9e3779b9) >>> 0;
}

/**
 * Fixed-size, re-seedable, allocation-free random stream.
 *
 * `nextU32` is a xorshift32 step; `nextFloat` consumes the *upper* bits, which xorshift
 * produces with better statistical quality than the low bits.
 */
export class Rng {
  private state: number;
  private readonly initial: number;

  constructor(seed = 0x1234abcd) {
    this.initial = (seed | 0) === 0 ? 0x9e3779b9 : seed | 0;
    this.state = this.initial;
  }

  /** Reset to the construction seed so a sequence can be replayed. */
  reset(): void {
    this.state = this.initial;
  }

  /** Re-seed to a derived state, e.g. per-chunk: `rng.seedWith(chunkKey)`. */
  reseed(seed: number): void {
    this.state = seedStream(seed);
  }

  get seed(): number {
    return this.initial;
  }

  nextU32(): number {
    let x = this.state | 0;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.state = x | 0;
    return x >>> 0;
  }

  /** Uniform float in [0, 1). */
  nextFloat(): number {
    return this.nextU32() / 4294967296;
  }

  /** Uniform float in [-1, 1). */
  nextSignedFloat(): number {
    return this.nextFloat() * 2 - 1;
  }

  nextRange(min: number, max: number): number {
    return min + (max - min) * this.nextFloat();
  }

  /** Uniform integer in [min, max] inclusive. */
  nextInt(min: number, max: number): number {
    if (max < min) [min, max] = [max, min];
    return min + Math.floor(this.nextFloat() * (max - min + 1));
  }

  nextBool(chance = 0.5): boolean {
    return this.nextFloat() < chance;
  }

  /** Standard normal via Box–Muller (cached half, as is conventional). */
  private hasSpare = false;
  private spare = 0;
  nextGaussian(): number {
    if (this.hasSpare) {
      this.hasSpare = false;
      return this.spare;
    }
    let u = 0;
    let v = 0;
    let s = 0;
    do {
      u = this.nextFloat() * 2 - 1;
      v = this.nextFloat() * 2 - 1;
      s = u * u + v * v;
    } while (s >= 1 || s === 0);
    const mul = Math.sqrt((-2 * Math.log(s)) / s);
    this.spare = v * mul;
    this.hasSpare = true;
    return u * mul;
  }

  /** Unit vector on the sphere. */
  nextUnitSphere(out: { x: number; y: number; z: number }): void {
    const z = this.nextFloat() * 2 - 1;
    const a = this.nextFloat() * TAU;
    const r = Math.sqrt(Math.max(0, 1 - z * z));
    out.x = r * Math.cos(a);
    out.y = r * Math.sin(a);
    out.z = z;
  }

  /** Snapshot/restore for replayable simulation forks. */
  save(): number {
    return this.state;
  }

  restore(state: number): void {
    this.state = state | 0;
  }
}

/**
 * Deterministic hash of 1/2/3 integer coordinates plus a seed → uint32.
 * These must stay in sync with the WGSL versions in `shaders/noiseChunk.ts`.
 */
export function hash1i(x: number, seed: number): number {
  return mix32((Math.imul(x | 0, 0x27d4eb2d) ^ seed) >>> 0);
}

export function hash2i(x: number, y: number, seed: number): number {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ seed;
  return mix32(h >>> 0);
}

export function hash3i(x: number, y: number, z: number, seed: number): number {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x9e3779b1) ^ Math.imul(z | 0, 0x85ebca77) ^ seed;
  return mix32(h >>> 0);
}

export function hash2iFloat(x: number, y: number, seed: number): number {
  return hash2i(x, y, seed) / 4294967296;
}

export function hash3iFloat(x: number, y: number, z: number, seed: number): number {
  return hash3i(x, y, z, seed) / 4294967296;
}

/**
 * Hash a (chunk coordinate, level, seed) triple into a stable stream seed.
 * Used so per-chunk generation can run in any order and still produce the same world.
 */
export function chunkSeed(cx: number, cz: number, level: number, seed: number): number {
  const a = combine32(cx | 0, seed | 0);
  const b = combine32(cz | 0, (seed | 0) ^ 0x51f3a3ed);
  const c = combine32(a, b ^ Math.imul(level | 0, 0x9e3779b9));
  return seedStream(c);
}
