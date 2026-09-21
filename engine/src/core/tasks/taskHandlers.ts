/**
 * Built-in worker task handlers.
 *
 * Registered lazily by `TaskScheduler` (via `registerBuiltinTaskHandlers()`), so importing the
 * scheduler in a browser never pulls this code unless a task is actually submitted. Every handler
 * here must be **DOM-free and engine-free** — it also runs inside the worker, where `window` does
 * not exist and the module graph is limited to `math/` + `core/`.
 *
 * Payload/result contracts are declared next to each handler and mirrored by the tests in
 * tests/tasks.test.ts; that is the contract the worker protocol speaks.
 */

import { type TaskContext } from "./registry.js";
import { NoiseField, valueNoise2 } from "../../math/noise.js";
import { Rng, chunkSeed } from "../../math/rng.js";
import { alignUp } from "../../math/scalar.js";

// ---------------------------------------------------------------- heightfield

export interface HeightfieldTaskPayload {
  seed: number;
  /** Chunk coordinates (world units = size * resolution). */
  cx: number;
  cz: number;
  size: number;
  /** Grid points per edge (including the shared edge with the neighbour). */
  resolution: number;
  octaves?: number;
  amplitude?: number;
  frequency?: number;
  lacunarity?: number;
  gain?: number;
}

export interface HeightfieldTaskResult {
  cx: number;
  cz: number;
  resolution: number;
  size: number;
  /** Row-major height samples, `resolution * resolution` floats. */
  heights: Float32Array;
  min: number;
  max: number;
  /** Bytes, for progress reporting and the memory budget. */
  bytes: number;
}

/**
 * Generate one chunk's height grid. Deterministic in (seed, cx, cz): the seed is derived from the
 * *chunk coordinate*, never from a counter, so parallel and re-run generations agree exactly
 * (docs/TERRAIN.md#determinism).
 */
export function generateHeightfield(payload: HeightfieldTaskPayload, ctx?: TaskContext): HeightfieldTaskResult {
  const res = Math.max(2, Math.floor(payload.resolution));
  const size = payload.size;
  const step = size / (res - 1);
  const heights = new Float32Array(res * res);
  // Seed is derived from the chunk coordinate, so two runs (or main thread vs worker) agree exactly.
  const seed = chunkSeed(payload.cx, payload.cz, 0, payload.seed);
  const field = new NoiseField(seed, {
    octaves: payload.octaves ?? 4,
    lacunarity: payload.lacunarity ?? 2,
    gain: payload.gain ?? 0.5,
  });
  const frequency = payload.frequency ?? 1 / 256;
  const amplitude = payload.amplitude ?? 1;
  let min = Infinity;
  let max = -Infinity;
  const originX = payload.cx * size;
  const originZ = payload.cz * size;
  for (let j = 0; j < res; j++) {
    for (let i = 0; i < res; i++) {
      const x = originX + i * step;
      const z = originZ + j * step;
      const h = field.fbm(x * frequency, z * frequency) * amplitude;
      heights[j * res + i] = h;
      if (h < min) min = h;
      if (h > max) max = h;
    }
    ctx?.progress((j + 1) / res);
  }
  return { cx: payload.cx, cz: payload.cz, resolution: res, size, heights, min, max, bytes: heights.byteLength };
}

// ---------------------------------------------------------------- slope/normal bake

export interface SlopeFieldTaskPayload {
  heights: Float32Array;
  resolution: number;
  /** World size of the tile, used to convert height deltas into slopes. */
  size: number;
}

export interface SlopeFieldTaskResult {
  /** Packed per vertex: x = slope radians, y = normalised curvature, z = exposed flag, w = unused. */
  packed: Float32Array;
  averageSlope: number;
}

/**
 * Bake slope/curvature from a height grid. Terrain biome + scatter rules read this instead of
 * re-differencing the height field in the shader, which keeps biome queries O(1) on the CPU.
 */
export function bakeSlopeField(payload: SlopeFieldTaskPayload, ctx?: TaskContext): SlopeFieldTaskResult {
  const res = Math.max(2, Math.floor(payload.resolution));
  if (payload.heights.length < res * res) throw new Error(`bakeSlopeField: heights has ${payload.heights.length} entries, expected ≥ ${res * res}`);
  const cell = payload.size / (res - 1);
  const packed = new Float32Array(res * res * 4);
  let total = 0;
  const h = (i: number, j: number) => payload.heights[Math.min(res - 1, Math.max(0, j)) * res + Math.min(res - 1, Math.max(0, i))]!;
  for (let j = 0; j < res; j++) {
    for (let i = 0; i < res; i++) {
      const dx = (h(i + 1, j) - h(i - 1, j)) / (2 * cell);
      const dz = (h(i, j + 1) - h(i, j - 1)) / (2 * cell);
      const slope = Math.atan(Math.hypot(dx, dz));
      const curvature = (h(i + 1, j) + h(i - 1, j) + h(i, j + 1) + h(i, j - 1) - 4 * h(i, j)) / (cell * cell);
      const o = (j * res + i) * 4;
      packed[o] = slope;
      packed[o + 1] = Math.max(-1, Math.min(1, curvature * cell));
      // "Exposed": the surface faces upward strongly enough to collect soil/vegetation.
      packed[o + 2] = 1 / Math.hypot(1, dx, dz) > 0.72 ? 1 : 0;
      packed[o + 3] = 0;
      total += slope;
    }
    ctx?.progress((j + 1) / res);
  }
  return { packed, averageSlope: total / (res * res) };
}

// ---------------------------------------------------------------- point scatter

export interface ScatterTaskPayload {
  seed: number;
  cx: number;
  cz: number;
  size: number;
  count: number;
  /** Rejection test in world coordinates; the caller supplies it as a compact table. */
  heightfield?: Float32Array;
  resolution?: number;
  maxSlopeRadians?: number;
  minExposure?: number;
}

export interface ScatterTaskResult {
  /** x, y, z, scale, rotationY per point. */
  points: Float32Array;
  count: number;
  tested: number;
}

/** Poisson-ish rejection scatter over a height grid (deterministic; no RNG state leakage). */
export function scatterPoints(payload: ScatterTaskPayload): ScatterTaskResult {
  const count = Math.max(0, Math.floor(payload.count));
  const res = Math.max(2, Math.floor(payload.resolution ?? payload.heightfield?.length ? Math.sqrt(payload.heightfield?.length ?? 4) : 2));
  const heights = payload.heightfield ?? null;
  const rng = new Rng(chunkSeed(payload.cx, payload.cz, 17, payload.seed));
  const out = new Float32Array(count * 5);
  let written = 0;
  let tested = 0;
  const cellSize = heights && res > 1 ? payload.size / (res - 1) : 0;
  while (written < count && tested < count * 40) {
    tested++;
    const lx = rng.nextFloat() * payload.size;
    const lz = rng.nextFloat() * payload.size;
    let y = 0;
    if (heights && cellSize > 0) {
      const gi = lx / cellSize;
      const gj = lz / cellSize;
      const i0 = Math.floor(gi);
      const j0 = Math.floor(gj);
      const fx = gi - i0;
      const fz = gj - j0;
      const at = (i: number, j: number) => heights[Math.min(res - 1, Math.max(0, j)) * res + Math.min(res - 1, Math.max(0, i))] ?? 0;
      y = (at(i0, j0) * (1 - fx) + at(i0 + 1, j0) * fx) * (1 - fz) + (at(i0, j0 + 1) * (1 - fx) + at(i0 + 1, j0 + 1) * fx) * fz;
      const dx = (at(i0 + 1, j0) - at(i0, j0)) / cellSize;
      const dz = (at(i0, j0 + 1) - at(i0, j0)) / cellSize;
      const slope = Math.atan(Math.hypot(dx, dz));
      if (payload.maxSlopeRadians !== undefined && slope > payload.maxSlopeRadians) continue;
      if (payload.minExposure !== undefined) {
        const exposure = 1 / Math.hypot(1, dx, dz);
        if (exposure < payload.minExposure) continue;
      }
    }
    const o = written * 5;
    out[o] = payload.cx * payload.size + lx;
    out[o + 1] = y;
    out[o + 2] = payload.cz * payload.size + lz;
    out[o + 3] = 0.6 + rng.nextFloat() * 0.9;
    out[o + 4] = rng.nextFloat() * Math.PI * 2;
    written++;
  }
  return { points: out.subarray(0, written * 5), count: written, tested };
}

// ---------------------------------------------------------------- texture tiles

export interface NoiseTileTaskPayload {
  seed: number;
  size: number;
  octaves?: number;
  frequency?: number;
  /** 1 = one channel per texel (RGBA8 output), so a tile can feed an albedo or a height map. */
  channels?: 1 | 3 | 4;
}

export interface NoiseTileTaskResult {
  size: number;
  rgba: Uint8Array;
}

/** Generate an RGBA noise tile (procedural textures for the Mars/terrain demos: no asset files). */
export function generateNoiseTile(payload: NoiseTileTaskPayload, ctx?: TaskContext): NoiseTileTaskResult {
  const size = alignUp(Math.max(2, Math.floor(payload.size)), 2);
  const rgba = new Uint8Array(size * size * 4);
  const field = new NoiseField(payload.seed, { octaves: payload.octaves ?? 4 });
  const frequency = payload.frequency ?? 4 / size;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const n = payload.channels === 1 ? valueNoise2(x * 0.1, y * 0.1, payload.seed) : field.fbm(x * frequency, y * frequency);
      const v = Math.max(0, Math.min(255, Math.round((n * 0.5 + 0.5) * 255)));
      const o = (y * size + x) * 4;
      rgba[o] = v;
      rgba[o + 1] = payload.channels && payload.channels > 1 ? v : v;
      rgba[o + 2] = payload.channels && payload.channels > 2 ? v : v;
      rgba[o + 3] = 255;
    }
    ctx?.progress((y + 1) / size);
  }
  return { size, rgba };
}

export interface BuiltinHandlerTable {
  "terrain.heightfield": [HeightfieldTaskPayload, HeightfieldTaskResult];
  "terrain.slope": [SlopeFieldTaskPayload, SlopeFieldTaskResult];
  "terrain.scatter": [ScatterTaskPayload, ScatterTaskResult];
  "texture.noiseTile": [NoiseTileTaskPayload, NoiseTileTaskResult];
}

/**
 * Called by `registerBuiltinTaskHandlers()` (and by the worker bootstrap) with the registry's
 * `registerTaskHandler`. Kept as a single function so main thread and worker register the exact same
 * set from the exact same source.
 */
export function installTaskHandlers(register: <P, R>(name: string, fn: (payload: P, ctx: TaskContext) => R | Promise<R>) => void): void {
  register<HeightfieldTaskPayload, HeightfieldTaskResult>("terrain.heightfield", (p, ctx) => generateHeightfield(p, ctx));
  register<SlopeFieldTaskPayload, SlopeFieldTaskResult>("terrain.slope", (p, ctx) => bakeSlopeField(p, ctx));
  register<ScatterTaskPayload, ScatterTaskResult>("terrain.scatter", (p) => scatterPoints(p));
  register<NoiseTileTaskPayload, NoiseTileTaskResult>("texture.noiseTile", (p, ctx) => generateNoiseTile(p, ctx));
}

/** The task names this module provides (tests assert each is registered after warm-up). */
export const BUILTIN_TASK_NAMES = ["terrain.heightfield", "terrain.slope", "terrain.scatter", "texture.noiseTile"] as const;

/**
 * Buffers a result owns and can hand to the main thread without copying. The scheduler posts these
 * as transferables; taking ownership means the worker must not touch them afterwards, which is why
 * each handler returns fresh arrays rather than views into a reusable arena.
 */
export function transferablesFor(name: string, result: unknown): ArrayBuffer[] {
  switch (name) {
    case "terrain.heightfield":
      return [(result as HeightfieldTaskResult).heights.buffer as ArrayBuffer];
    case "terrain.slope":
      return [(result as SlopeFieldTaskResult).packed.buffer as ArrayBuffer];
    case "terrain.scatter":
      return [(result as ScatterTaskResult).points.buffer as ArrayBuffer];
    case "texture.noiseTile":
      return [(result as NoiseTileTaskResult).rgba.buffer as ArrayBuffer];
    default:
      return [];
  }
}
