/**
 * Deterministic population scatter (Phase 14.1).
 *
 * Placement is a pure function of `(type, seed, chunk coordinate, sampler)`: the same inputs always
 * produce the same instance array, bit for bit, in any process and any evaluation order — the same
 * contract `engine/src/terrain/generators.ts` holds for terrain cells, reached the same way (a
 * `chunkSeed`-derived `Rng` stream). The sampler is the terrain surface the chunk sits on; it is
 * queried, never trusted to persist, so a worker and the main thread cannot disagree.
 *
 * The distribution is a *stratified jittered grid*: `densityGrid × densityGrid` candidate cells per
 * chunk, one candidate drawn per cell, each rejected independently by the type's placement rules
 * (slope, height band). Compared with plain uniform sampling this keeps rocks off each other's
 * laps without a Poisson pass, keeps the per-chunk candidate count exactly `densityGrid²` (bounded
 * by construction, so `maxPerChunk` is a cap, not a hope), and makes coverage even enough that a
 * chunk's population reads as "ground cover" rather than "clumps and holes" from the air.
 *
 * Determinism discipline: every candidate draws the same seven RNG values (jitter x/z, three scale
 * components, rotation, tint) *before* any rule can reject it, so the stream position of candidate
 * N never depends on which candidates before it were accepted.
 */

import { Rng, chunkSeed } from "../math/rng.js";
import { packColorRGBA } from "../math/color.js";
import type { PopulationInstanceBlock } from "../scene/population.js";

/** Seed-stream level base for population chunks; `+ typeId` keeps two types on one chunk uncorrelated. */
export const POPULATION_CHUNK_LEVEL = 700;

/** How the scatter samples the surface a chunk's population sits on. Implemented over a resident heightmap. */
export interface PopulationSurfaceSampler {
  /** Surface height at world (x, z) — the same surface the drawn mesh interpolates. */
  heightAt(worldX: number, worldZ: number): number;
  /** Upward component of the surface normal at world (x, z), in [-1, 1] (1 = flat). */
  normalYAt(worldX: number, worldZ: number): number;
}

/**
 * Placement rules and appearance parameters for one population type (Phase 14.2 types are built
 * from this: rocks and boulders ship in the terrain demo; vegetation/debris/decals/props remain
 * roadmap work). Pure data — the geometry/material pairing lives on `PopulationType` in `world.ts`.
 */
export interface PopulationTypeSpec {
  /** Stable type identity folded into the chunk seed. Two types must not share an id. */
  readonly id: number;
  readonly label: string;
  /** Candidate cells per chunk side; `densityGrid²` candidates per chunk. Default 6 (36). */
  readonly densityGrid?: number;
  /** Hard instance cap per chunk (default `densityGrid²`). */
  readonly maxPerChunk?: number;
  /** Minimum per-axis scale. Default 1. */
  readonly scaleMin?: number;
  /** Maximum per-axis scale. Default 1. */
  readonly scaleMax?: number;
  /**
   * Exponent applied to the scale uniform (default 1, uniform). > 1 biases toward `scaleMin` —
   * many pebbles, occasional slab.
   */
  readonly scaleExponent?: number;
  /**
   * Reject candidates steeper than this slope, measured as `1 - normal.y` (0 = flat ground only,
   * 1 = overhangs). Default 0.5 (~34°) — loose enough for scree, tight enough that rocks do not
   * float on cliff faces.
   */
  readonly slopeLimit?: number;
  /** Reject candidates below this world height (optional). */
  readonly minHeight?: number;
  /** Reject candidates above this world height (optional). */
  readonly maxHeight?: number;
  /**
   * Fraction of deterministic per-instance brightness variation, 0..1 (default 0). 0.25 reads as
   * weathered rock under one material; the tint multiplies the material colour in the shader.
   */
  readonly tintJitter?: number;
  /**
   * Surface offset as a fraction of Y scale (default 0.15): positive sinks into the ground,
   * negative lifts above it. A rock planted exactly at surface height intersects at one point;
   * slightly embedded reads as settled, while a shallow decal may use a small negative value to
   * clear z-fighting on a nearly flat patch.
   */
  readonly embed?: number;
  /** Whether instances of this type cast shadows. Default true. */
  readonly castShadow?: boolean;
  /** Draw distance limit for the type's batches, metres (0 = unlimited). */
  readonly maxDistance?: number;
}

export interface ResolvedPopulationTypeSpec {
  id: number;
  label: string;
  densityGrid: number;
  maxPerChunk: number;
  scaleMin: number;
  scaleMax: number;
  scaleExponent: number;
  slopeLimit: number;
  minHeight: number;
  maxHeight: number;
  tintJitter: number;
  embed: number;
  castShadow: boolean;
  maxDistance: number;
}

/** Fill in every `PopulationTypeSpec` default once; the scatter loop reads only resolved specs. */
export function resolvePopulationTypeSpec(spec: PopulationTypeSpec): ResolvedPopulationTypeSpec {
  const densityGrid = Math.max(1, Math.floor(spec.densityGrid ?? 6));
  return {
    id: spec.id | 0,
    label: spec.label,
    densityGrid,
    maxPerChunk: Math.max(0, Math.min(Math.floor(spec.maxPerChunk ?? densityGrid * densityGrid), densityGrid * densityGrid)),
    scaleMin: spec.scaleMin ?? 1,
    scaleMax: spec.scaleMax ?? 1,
    scaleExponent: spec.scaleExponent ?? 1,
    slopeLimit: spec.slopeLimit ?? 0.5,
    minHeight: spec.minHeight ?? -Infinity,
    maxHeight: spec.maxHeight ?? Infinity,
    tintJitter: spec.tintJitter ?? 0,
    embed: spec.embed ?? 0.15,
    castShadow: spec.castShadow ?? true,
    maxDistance: spec.maxDistance ?? 0,
  };
}

/**
 * Scatter one (type, chunk) population into `out` (cleared first). Returns the instance count.
 *
 * Pure with respect to `(spec, seed, cx, cz, chunkSize, sampler)`: two calls with equal inputs
 * write equal arrays, and no global state is touched, so it is as safe on a worker thread as on
 * the main one (the terrain cell generators hold the same contract).
 */
export function scatterPopulationChunk(
  spec: PopulationTypeSpec,
  seed: number,
  cx: number,
  cz: number,
  chunkSize: number,
  sampler: PopulationSurfaceSampler,
  out: PopulationInstanceBlock,
): number {
  const r = resolvePopulationTypeSpec(spec);
  out.clear();
  if (r.maxPerChunk <= 0 || chunkSize <= 0) {
    out.markModified();
    return 0;
  }
  // Type identity is part of the stream: two types over one chunk share neither candidates nor scale.
  const rng = new Rng(chunkSeed(cx, cz, POPULATION_CHUNK_LEVEL + r.id, seed | 0));
  const grid = r.densityGrid;
  const step = chunkSize / grid;
  const originX = cx * chunkSize;
  const originZ = cz * chunkSize;

  for (let j = 0; j < grid; j++) {
    for (let i = 0; i < grid; i++) {
      // Seven draws per candidate, in this order, before any rejection can short-circuit.
      const jitterX = rng.nextFloat();
      const jitterZ = rng.nextFloat();
      const su = Math.pow(rng.nextFloat(), r.scaleExponent);
      const sv = Math.pow(rng.nextFloat(), r.scaleExponent);
      const sw = Math.pow(rng.nextFloat(), r.scaleExponent);
      const rotation = rng.nextFloat() * Math.PI * 2;
      const tintRoll = rng.nextFloat();

      if (out.count >= r.maxPerChunk) {
        out.markModified();
        return out.count;
      }

      const x = originX + (i + jitterX) * step;
      const z = originZ + (j + jitterZ) * step;
      const y = sampler.heightAt(x, z);
      if (y < r.minHeight || y > r.maxHeight) continue;
      if (1 - sampler.normalYAt(x, z) > r.slopeLimit) continue;

      const sx = r.scaleMin + (r.scaleMax - r.scaleMin) * su;
      const sy = r.scaleMin + (r.scaleMax - r.scaleMin) * sv;
      const sz = r.scaleMin + (r.scaleMax - r.scaleMin) * sw;
      const k = out.count;
      out.positions[k * 3] = x;
      out.positions[k * 3 + 1] = y - r.embed * sy;
      out.positions[k * 3 + 2] = z;
      out.scales[k * 3] = sx;
      out.scales[k * 3 + 1] = sy;
      out.scales[k * 3 + 2] = sz;
      out.rotations[k] = rotation;
      out.tints[k] =
        r.tintJitter > 0
          ? packColorRGBA(1 - r.tintJitter * tintRoll, 1 - r.tintJitter * tintRoll, 1 - r.tintJitter * tintRoll, 1)
          : 0;
      out.count = k + 1;
    }
  }
  out.markModified();
  return out.count;
}
