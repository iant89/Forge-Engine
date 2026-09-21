/**
 * Deterministic, seedable noise — the backbone of procedural terrain, weather and particles.
 *
 * Design notes:
 * - All functions are **positional** (value = f(coords, seed)), never stream-based, so worker
 *   parallelism cannot change results.
 * - Integer lattice hashing reuses `rng.ts` helpers, which are the same integer mixing used by
 *   the WGSL implementations in `rendering/shaders/noiseChunk.ts`. CPU sampling (terrain
 *   collision, gameplay scatter) and GPU shading (vertex displacement, cloud detail) are
 *   *the same function* within float32 tolerance; that is what allows terrain to be refined on
 *   the GPU without changing collision.
 * - Gradients use 8/12 direction tables rather than 16 (cheap, no visible anisotropy on
 *   terrain scales).
 */

import { hash2i, hash3i, mix32 } from "./rng.js";
import { clamp, lerp, smoothstep } from "./scalar.js";

const GRAD2X = [1, -1, 1, -1, 1, -1, 0, 0];
const GRAD2Y = [1, 1, -1, -1, 0, 0, 1, -1];
const GRAD3 = [
  1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1, 0,
  1, 0, 1, -1, 0, 1, 0, 1, -1, 0, -1, -1,
];

function grad2(hash: number, x: number, y: number): number {
  const i = hash & 7;
  return GRAD2X[i]! * x + GRAD2Y[i]! * y;
}

function grad3(hash: number, x: number, y: number, z: number): number {
  const i = (hash % 8) * 3;
  return GRAD3[i]! * x + GRAD3[i + 1]! * y + GRAD3[i + 2]! * z;
}

/** 2D value noise in [-1, 1]. Cheap, blocky at high frequencies; good for large scales. */
export function valueNoise2(x: number, y: number, seed: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const a = hash2i(xi, yi, seed) / 2147483647.5 - 1;
  const b = hash2i(xi + 1, yi, seed) / 2147483647.5 - 1;
  const c = hash2i(xi, yi + 1, seed) / 2147483647.5 - 1;
  const d = hash2i(xi + 1, yi + 1, seed) / 2147483647.5 - 1;
  return lerp(lerp(a, b, u), lerp(c, d, u), v);
}

/** 2D gradient (Perlin-style) noise, range ~[-1, 1]. */
export function perlin2(x: number, y: number, seed: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = smoothstep(0, 1, xf);
  const v = smoothstep(0, 1, yf);
  const h00 = hash2i(xi, yi, seed);
  const h10 = hash2i(xi + 1, yi, seed);
  const h01 = hash2i(xi, yi + 1, seed);
  const h11 = hash2i(xi + 1, yi + 1, seed);
  const n00 = grad2(h00, xf, yf);
  const n10 = grad2(h10, xf - 1, yf);
  const n01 = grad2(h01, xf, yf - 1);
  const n11 = grad2(h11, xf - 1, yf - 1);
  // 1.414 scales the classic 2D result to approximately [-1, 1].
  return lerp(lerp(n00, n10, u), lerp(n01, n11, u), v) * 1.4142135623730951;
}

/** 3D gradient noise, range ~[-1, 1]. Used for erosion, clouds and turbulence. */
export function perlin3(x: number, y: number, z: number, seed: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const zi = Math.floor(z);
  const xf = x - xi;
  const yf = y - yi;
  const zf = z - zi;
  const u = smoothstep(0, 1, xf);
  const v = smoothstep(0, 1, yf);
  const w = smoothstep(0, 1, zf);
  const n = (ix: number, iy: number, iz: number, gx: number, gy: number, gz: number): number =>
    grad3(hash3i(ix, iy, iz, seed), gx, gy, gz);
  const x00 = lerp(n(xi, yi, zi, xf, yf, zf), n(xi + 1, yi, zi, xf - 1, yf, zf), u);
  const x10 = lerp(n(xi, yi + 1, zi, xf, yf - 1, zf), n(xi + 1, yi + 1, zi, xf - 1, yf - 1, zf), u);
  const x01 = lerp(n(xi, yi, zi + 1, xf, yf, zf - 1), n(xi + 1, yi, zi + 1, xf - 1, yf, zf - 1), u);
  const x11 = lerp(
    n(xi, yi + 1, zi + 1, xf, yf - 1, zf - 1),
    n(xi + 1, yi + 1, zi + 1, xf - 1, yf - 1, zf - 1),
    u,
  );
  return lerp(lerp(x00, x10, v), lerp(x01, x11, v), w) * 1.1547005383792515;
}

/**
 * Simplex-ish 2D noise (Gustavson triangle lattice). 3 corners instead of 4 → fewer hash
 * lookups, and less directional bias at the frequencies used for terrain detail.
 */
export function simplex2(x: number, y: number, seed: number): number {
  const F2 = 0.3660254037844386; // (sqrt(3)-1)/2
  const G2 = 0.21132486540518713; // (3-sqrt(3))/6
  const s = (x + y) * F2;
  const i = Math.floor(x + s);
  const j = Math.floor(y + s);
  const t = (i + j) * G2;
  const x0 = x - (i - t);
  const y0 = y - (j - t);
  const i1 = x0 > y0 ? 1 : 0;
  const j1 = x0 > y0 ? 0 : 1;
  const x1 = x0 - i1 + G2;
  const y1 = y0 - j1 + G2;
  const x2 = x0 - 1 + 2 * G2;
  const y2 = y0 - 1 + 2 * G2;
  let n = 0;
  let t0 = 0.5 - x0 * x0 - y0 * y0;
  if (t0 > 0) {
    t0 *= t0;
    n += t0 * t0 * grad2(hash2i(i, j, seed), x0, y0);
  }
  let t1 = 0.5 - x1 * x1 - y1 * y1;
  if (t1 > 0) {
    t1 *= t1;
    n += t1 * t1 * grad2(hash2i(i + i1, j + j1, seed), x1, y1);
  }
  let t2 = 0.5 - x2 * x2 - y2 * y2;
  if (t2 > 0) {
    t2 *= t2;
    n += t2 * t2 * grad2(hash2i(i + 1, j + 1, seed), x2, y2);
  }
  return clamp(n * 35.0, -1, 1);
}

export interface FbmOptions {
  octaves?: number;
  lacunarity?: number;
  gain?: number;
  /** Weight applied to octave i (before renormalization): 1 → fbm, i → fBm with pink bias. */
  weights?: (i: number) => number;
}

/** Fractional Brownian motion. Returns approximately [-1, 1] after normalization. */
export function fbm2(x: number, y: number, seed: number, options: FbmOptions = {}): number {
  const octaves = options.octaves ?? 5;
  const lacunarity = options.lacunarity ?? 2.03;
  const gain = options.gain ?? 0.5;
  let amp = 1;
  let freq = 1;
  let sum = 0;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    const w = options.weights ? options.weights(i) : 1;
    sum += perlin2(x * freq, y * freq, (seed + i * 0x9e3779b9) | 0) * amp * w;
    norm += amp * w;
    amp *= gain;
    freq *= lacunarity;
  }
  return norm > 0 ? sum / norm : 0;
}

export function fbm3(x: number, y: number, z: number, seed: number, options: FbmOptions = {}): number {
  const octaves = options.octaves ?? 4;
  const lacunarity = options.lacunarity ?? 2.03;
  const gain = options.gain ?? 0.5;
  let amp = 1;
  let freq = 1;
  let sum = 0;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += perlin3(x * freq, y * freq, z * freq, (seed + i * 0x9e3779b9) | 0) * amp;
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return norm > 0 ? sum / norm : 0;
}

/** Ridged multifractal — mountain crests, fault ridges. Output [0, 1]. */
export function ridged2(x: number, y: number, seed: number, options: FbmOptions = {}): number {
  const octaves = options.octaves ?? 5;
  let amp = 1;
  let freq = 1;
  let sum = 0;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    const n = perlin2(x * freq, y * freq, (seed + i * 0x9e3779b9) | 0);
    const r = 1 - Math.abs(n);
    sum += r * r * amp;
    norm += amp;
    amp *= options.gain ?? 0.5;
    freq *= options.lacunarity ?? 2.03;
  }
  return norm > 0 ? sum / norm : 0;
}

/** Billowy/cloud noise: |noise| folded, output [0, 1]. */
export function billow2(x: number, y: number, seed: number, options: FbmOptions = {}): number {
  const octaves = options.octaves ?? 4;
  let amp = 0.5;
  let freq = 1;
  let sum = 0;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    const n = perlin2(x * freq, y * freq, (seed + i * 0x9e3779b9) | 0);
    sum += Math.abs(n) * amp;
    norm += amp;
    amp *= 0.5;
    freq *= 2.03;
  }
  return norm > 0 ? 1 - sum / norm : 1;
}

/**
 * Cellular / Woronoi distance (F1) and edge distance (F2-F1) in 2D.
 * Used for crater floors, cracked regolith masks and rock-field placement.
 */
export function cellular2(
  x: number,
  y: number,
  seed: number,
  out?: { f1?: number; f2?: number; cellId?: number },
): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  let f1 = Infinity;
  let f2 = Infinity;
  let bestCell = 0;
  for (let oy = -1; oy <= 1; oy++) {
    for (let ox = -1; ox <= 1; ox++) {
      const cx = xi + ox;
      const cy = yi + oy;
      const h = hash2i(cx, cy, seed);
      const px = cx + (h & 0xffff) / 65535;
      const py = cy + ((h >>> 16) & 0xffff) / 65535;
      const dx = px - x;
      const dy = py - y;
      const d = dx * dx + dy * dy;
      if (d < f1) {
        f2 = f1;
        f1 = d;
        bestCell = mix32(h ^ (cx * 0x1f1f1f1f)) ^ cy;
      } else if (d < f2) {
        f2 = d;
      }
    }
  }
  f1 = Math.sqrt(f1);
  f2 = Math.sqrt(f2);
  if (out) {
    out.f1 = f1;
    out.f2 = f2;
    out.cellId = bestCell | 0;
  }
  return f1;
}

/** Domain-warped noise: `n(x + w(y), y + w(x))` — produces organic, eroded-looking flow. */
export function warpNoise2(
  x: number,
  y: number,
  seed: number,
  amount = 1.5,
  scale = 1,
  sample: (x: number, y: number, seed: number) => number = fbm2Default,
): number {
  const wx = perlin2(x * scale + 5.2, y * scale + 1.3, seed ^ 0x5bd1e995);
  const wy = perlin2(x * scale - 1.7, y * scale + 9.2, seed ^ 0x27d4eb2f);
  return sample(x + amount * wx, y + amount * wy, seed);
}

function fbm2Default(x: number, y: number, seed: number): number {
  return fbm2(x, y, seed, { octaves: 4 });
}

/**
 * A seeded noise field: bundles a seed and octave configuration so subsystems can pass around
 * one value instead of `(seed, octaves, lacunarity, ...)`.
 */
export class NoiseField {
  readonly seed: number;
  readonly octaves: number;
  readonly lacunarity: number;
  readonly gain: number;

  constructor(seed = 0, options: { octaves?: number; lacunarity?: number; gain?: number } = {}) {
    this.seed = seed | 0;
    this.octaves = options.octaves ?? 5;
    this.lacunarity = options.lacunarity ?? 2.03;
    this.gain = options.gain ?? 0.5;
  }

  private sub(seedOffset: number): number {
    return (this.seed + seedOffset * 0x9e3779b9) | 0;
  }

  fbm(x: number, y: number, seedOffset = 0): number {
    return fbm2(x, y, this.sub(seedOffset), {
      octaves: this.octaves,
      lacunarity: this.lacunarity,
      gain: this.gain,
    });
  }

  fbm3(x: number, y: number, z: number, seedOffset = 0): number {
    return fbm3(x, y, z, this.sub(seedOffset), {
      octaves: this.octaves,
      lacunarity: this.lacunarity,
      gain: this.gain,
    });
  }

  ridged(x: number, y: number, seedOffset = 0): number {
    return ridged2(x, y, this.sub(seedOffset), { octaves: this.octaves, gain: this.gain, lacunarity: this.lacunarity });
  }

  billow(x: number, y: number, seedOffset = 0): number {
    return billow2(x, y, this.sub(seedOffset), { octaves: this.octaves });
  }

  simplex(x: number, y: number, seedOffset = 0): number {
    return simplex2(x, y, this.sub(seedOffset));
  }

  value(x: number, y: number, seedOffset = 0): number {
    return valueNoise2(x, y, this.sub(seedOffset));
  }

  cellular(x: number, y: number, seedOffset = 0, out?: { f1?: number; f2?: number; cellId?: number }): number {
    return cellular2(x, y, this.sub(seedOffset), out);
  }

  warp(x: number, y: number, amount = 1.5, scale = 1, seedOffset = 0): number {
    return warpNoise2(x, y, this.sub(seedOffset), amount, scale);
  }

  derivative2(x: number, y: number, seedOffset = 0, epsilon = 1e-3): { dx: number; dy: number } {
    const h = epsilon;
    const f0 = this.fbm(x, y, seedOffset);
    return {
      dx: (this.fbm(x + h, y, seedOffset) - f0) / h,
      dy: (this.fbm(x, y + h, seedOffset) - f0) / h,
    };
  }
}
