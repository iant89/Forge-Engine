/**
 * 3D value/gradient noise for the Mars terrain port — transcribed from the dev-time generator
 * `mars-terrain-gen` (`src/noise/hash.ts`, `src/noise/gradient3.ts`).
 *
 * **Do not "improve" the arithmetic in this file.** Two properties of the transcription are load
 * bearing and neither is the engine's own `math/noise.ts`:
 *
 *  1. The integer hash mixes with plain `number` arithmetic, so the products wrap through IEEE
 *     doubles (values above 2^53 lose low bits) before `|0`/`>>>` coerce them back to 32-bit. That
 *     rounding is part of the generator's output; `hash3i` from `math/rng.ts` is a *different*
 *     function and would move every crater.
 *  2. The generator's Stage A file (`erosionDelta = eroded - analytic base`) is only meaningful if
 *     the port's analytic base is the same terrain the correction was measured against. A one-bit
 *     difference in the hash moves craters by kilometres, so the correction would then be applied to
 *     the wrong relief.
 *
 * `tools/mars-port-check.mjs` proves the transcription against real Stage A output (the
 * `baseElevation.f32` file inside each `cache/global/face_<n>` directory).
 */

/** Deterministic integer hash of a 3D lattice cell + seed, in [0, 1). */
export function hash3(x: number, y: number, z: number, seed: number): number {
  let h = (x | 0) * 374761393 + (y | 0) * 668265263 + (z | 0) * 2147483647 + (seed | 0) * 3266489917;
  h = (h ^ (h >>> 13)) * 1274126177;
  h = h ^ (h >>> 16);
  return ((h >>> 0) % 1_000_000) / 1_000_000;
}

/** `hash3` mapped to [-1, 1). */
export function hash3s(x: number, y: number, z: number, seed: number): number {
  return hash3(x, y, z, seed) * 2 - 1;
}

/** Perlin's quintic fade. */
function fade(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * 12 fixed gradient directions (cube-edge midpoints), flat triples in the generator's order.
 * A flat array rather than tuples purely so the lookup stays allocation-free; the order — and so
 * which gradient a hash selects — is unchanged.
 */
const GRADS = [
  1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1, 0,
  1, 0, 1, -1, 0, 1, 0, 1, -1, 0, -1, -1,
  0, 1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1,
];

const GRAD_COUNT = 12;

function gradIndex(ix: number, iy: number, iz: number, seed: number): number {
  return Math.floor(hash3(ix, iy, iz, seed) * GRAD_COUNT) % GRAD_COUNT;
}

/** 3D Perlin-style gradient noise, roughly [-1, 1]. */
export function marsPerlin3(x: number, y: number, z: number, seed: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const z0 = Math.floor(z);
  const x1 = x0 + 1;
  const y1 = y0 + 1;
  const z1 = z0 + 1;
  const sx = x - x0;
  const sy = y - y0;
  const sz = z - z0;

  const dotGrad = (ix: number, iy: number, iz: number): number => {
    const g = gradIndex(ix, iy, iz, seed) * 3;
    return GRADS[g]! * (x - ix) + GRADS[g + 1]! * (y - iy) + GRADS[g + 2]! * (z - iz);
  };

  const n000 = dotGrad(x0, y0, z0);
  const n100 = dotGrad(x1, y0, z0);
  const n010 = dotGrad(x0, y1, z0);
  const n110 = dotGrad(x1, y1, z0);
  const n001 = dotGrad(x0, y0, z1);
  const n101 = dotGrad(x1, y0, z1);
  const n011 = dotGrad(x0, y1, z1);
  const n111 = dotGrad(x1, y1, z1);

  const u = fade(sx);
  const v = fade(sy);
  const w = fade(sz);

  const nx00 = lerp(n000, n100, u);
  const nx10 = lerp(n010, n110, u);
  const nx01 = lerp(n001, n101, u);
  const nx11 = lerp(n011, n111, u);
  const nxy0 = lerp(nx00, nx10, v);
  const nxy1 = lerp(nx01, nx11, v);
  return lerp(nxy0, nxy1, w);
}

export interface MarsFbm3Options {
  octaves: number;
  lacunarity: number;
  gain: number;
  frequency: number;
  seed: number;
}

/** Fractal sum of `marsPerlin3`, normalised by the amplitude sum so the result stays ~[-1, 1]. */
export function marsFbm3(x: number, y: number, z: number, opts: MarsFbm3Options): number {
  let freq = opts.frequency;
  let amp = 1;
  let sum = 0;
  let norm = 0;
  for (let o = 0; o < opts.octaves; o++) {
    sum += marsPerlin3(x * freq, y * freq, z * freq, opts.seed + o * 101) * amp;
    norm += amp;
    freq *= opts.lacunarity;
    amp *= opts.gain;
  }
  return sum / norm;
}

/** Ridged multifractal (folds noise around zero), in [0, 1]. Used for meso/micro erosion texture. */
export function marsRidged3(x: number, y: number, z: number, opts: MarsFbm3Options): number {
  let freq = opts.frequency;
  let amp = 1;
  let sum = 0;
  let norm = 0;
  for (let o = 0; o < opts.octaves; o++) {
    const n = 1 - Math.abs(marsPerlin3(x * freq, y * freq, z * freq, opts.seed + o * 131));
    sum += n * n * amp;
    norm += amp;
    freq *= opts.lacunarity;
    amp *= opts.gain;
  }
  return sum / norm;
}

/** Low-frequency domain warp, so mountain chains and the dichotomy boundary do not read as axis-aligned. */
export function marsDomainWarp3(
  x: number,
  y: number,
  z: number,
  seed: number,
  strength: number,
  freq: number,
): [number, number, number] {
  const wx = marsFbm3(x, y, z, { octaves: 4, lacunarity: 2.0, gain: 0.5, frequency: freq, seed: seed + 7 });
  const wy = marsFbm3(x + 31.7, y - 17.3, z + 11.1, {
    octaves: 4,
    lacunarity: 2.0,
    gain: 0.5,
    frequency: freq,
    seed: seed + 13,
  });
  const wz = marsFbm3(x - 9.4, y + 5.2, z - 21.6, {
    octaves: 4,
    lacunarity: 2.0,
    gain: 0.5,
    frequency: freq,
    seed: seed + 19,
  });
  return [x + wx * strength, y + wy * strength, z + wz * strength];
}
