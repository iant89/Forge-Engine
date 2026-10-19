/**
 * Track grading for streamed terrain (fe-39): a level, graded road bed cut into a pipeline's cells.
 *
 * {@link TrackTerrain} carves a track into a height *function*, which suits a fixed ground mesh.
 * A {@link TerrainWorld} instead streams chunks that a {@link GeneratorPipeline} generates (inline
 * or on a worker), so a road has to be cut into the *cells*. {@link TrackGradingGenerator} is that
 * pipeline stage: along each {@link GradedCorridor} the surface becomes the corridor's bed
 * elevation, level across `halfWidth`, easing back into the natural ground over `blendWidth`.
 *
 * Why it is shaped this way:
 * - **Seamless by construction.** Every vertex is graded from its own world position and its own
 *   natural height only, so two chunks that share a border vertex agree on it (the road never
 *   cracks along a chunk edge) and every LOD resolution samples the same graded surface.
 * - **Describable.** The whole configuration is one canonical JSON {@link identity}, so the stage
 *   travels in a `TerrainPipelineSpec` to workers, into the cache key and into saved scenes (the
 *   same pattern as the Mars stage). Numbers are rounded to a millimetre so the identity is compact
 *   and the spec round-trips exactly.
 * - **The bed is designed, not discovered.** The stage cannot sample the natural terrain along the
 *   centreline (neighbouring chunks may not exist yet), so the caller designs the bed once —
 *   {@link designBedProfile} smooths and grade-limits natural centreline heights — and hands the
 *   result in. Place the stage after the stages that shape the height and before the ones that
 *   read it (slopes and biome weights come from the graded heights).
 *
 * Ribbons (`trackRibbonSource`) and props placed on the bed read the same `bed` array, so the road
 * mesh, the vehicle's ground query and the terrain mesh all agree inside the level core.
 */

import { UsageError } from "../core/errors.js";
import { clamp, smoothstep } from "../math/scalar.js";
import type { TerrainStage, WorldCell } from "./generators.js";

/** One graded road: a centreline polyline with a bed elevation at every sample. */
export interface GradedCorridor {
  /** Centreline samples, flattened `[x0, z0, x1, z1, …]` (at least two points). */
  points: readonly number[];
  /** Bed elevation at each centreline sample (`points.length / 2` values). */
  bed: readonly number[];
  /** Half-width (m) of the level bed: inside it the surface *is* the bed. */
  halfWidth: number;
  /** Width (m) of the smoothstep that eases the bed back into the natural ground. */
  blendWidth: number;
}

export interface TrackGradingOptions {
  corridors: readonly GradedCorridor[];
}

/** Millimetre precision keeps the identity compact and the spec round-trip exact. */
const PRECISION = 1000;
const IDENTITY_VERSION = 1;

function mm(value: number): number {
  return Math.round(value * PRECISION) / PRECISION;
}

interface CompiledCorridor {
  points: Float64Array;
  bed: Float64Array;
  halfWidth: number;
  blendWidth: number;
  reach: number;
  segments: number;
}

function compile(corridor: GradedCorridor, index: number): CompiledCorridor {
  const label = `track grading corridor ${index}`;
  const n = Math.floor(corridor.points.length / 2);
  if (corridor.points.length % 2 !== 0 || n < 2) throw new UsageError(`${label}: needs at least two centreline points as [x, z, …]`);
  if (corridor.bed.length !== n) throw new UsageError(`${label}: needs one bed elevation per centreline point (${n}), got ${corridor.bed.length}`);
  for (const v of corridor.points) if (!Number.isFinite(v)) throw new UsageError(`${label}: centreline points must be finite`);
  for (const v of corridor.bed) if (!Number.isFinite(v)) throw new UsageError(`${label}: bed elevations must be finite`);
  if (!(corridor.halfWidth >= 0) || !Number.isFinite(corridor.halfWidth)) throw new UsageError(`${label}: halfWidth must be a finite number ≥ 0`);
  if (!(corridor.blendWidth > 0) || !Number.isFinite(corridor.blendWidth)) throw new UsageError(`${label}: blendWidth must be a finite number > 0`);
  const halfWidth = mm(corridor.halfWidth);
  const blendWidth = Math.max(1 / PRECISION, mm(corridor.blendWidth));
  return {
    points: Float64Array.from(corridor.points, mm),
    bed: Float64Array.from(corridor.bed, mm),
    halfWidth,
    blendWidth,
    reach: halfWidth + blendWidth,
    segments: n - 1,
  };
}

/**
 * Grade one or more corridors into every cell that passes near them. Corridors apply in order:
 * a later corridor eases into whatever the earlier ones left, so put wide pads before the roads
 * that run through them.
 */
export class TrackGradingGenerator implements TerrainStage {
  readonly name = "track-grading";
  /** Canonical JSON of the complete configuration — what a worker rebuilds the stage from. */
  readonly identity: string;
  private readonly compiled: readonly CompiledCorridor[];

  constructor(options: TrackGradingOptions) {
    if (!options || !Array.isArray(options.corridors)) throw new UsageError("TrackGradingGenerator: corridors must be an array");
    this.compiled = options.corridors.map(compile);
    this.identity = JSON.stringify({
      version: IDENTITY_VERSION,
      corridors: this.compiled.map((c) => ({ points: Array.from(c.points), bed: Array.from(c.bed), halfWidth: c.halfWidth, blendWidth: c.blendWidth })),
    });
  }

  /** The corridors this stage grades, as stored (rounded to a millimetre). */
  get corridors(): GradedCorridor[] {
    return this.compiled.map((c) => ({ points: Array.from(c.points), bed: Array.from(c.bed), halfWidth: c.halfWidth, blendWidth: c.blendWidth }));
  }

  /** Rebuild from {@link identity}. Rejects malformed or non-canonical text rather than guessing. */
  static fromIdentity(identity: string): TrackGradingGenerator {
    let data: unknown;
    try {
      data = JSON.parse(identity) as unknown;
    } catch {
      throw new UsageError("track grading spec: identity must be configuration JSON");
    }
    const record = data as { version?: unknown; corridors?: unknown } | null;
    if (!record || typeof record !== "object" || record.version !== IDENTITY_VERSION || !Array.isArray(record.corridors)) {
      throw new UsageError("track grading spec: identity has a missing or unsupported version / corridor list");
    }
    const corridors = record.corridors.map((c: unknown, i: number): GradedCorridor => {
      const item = c as Partial<GradedCorridor> | null;
      if (!item || !Array.isArray(item.points) || !Array.isArray(item.bed) || typeof item.halfWidth !== "number" || typeof item.blendWidth !== "number") {
        throw new UsageError(`track grading spec: corridor ${i} has missing or invalid fields`);
      }
      return { points: item.points as number[], bed: item.bed as number[], halfWidth: item.halfWidth, blendWidth: item.blendWidth };
    });
    const stage = new TrackGradingGenerator({ corridors });
    if (stage.identity !== identity) throw new UsageError("track grading spec: identity is not in canonical form");
    return stage;
  }

  process(cell: WorldCell): void {
    const res = cell.resolution;
    const step = cell.size / (res - 1);
    const originX = cell.cx * cell.size;
    const originZ = cell.cz * cell.size;
    const maxX = originX + cell.size;
    const maxZ = originZ + cell.size;
    const near: number[] = [];
    for (const c of this.compiled) {
      const pts = c.points;
      const reach = c.reach;
      // Only the segments whose reach touches this cell take part in the per-vertex search.
      near.length = 0;
      for (let k = 0; k < c.segments; k++) {
        const ax = pts[2 * k]!, az = pts[2 * k + 1]!, bx = pts[2 * k + 2]!, bz = pts[2 * k + 3]!;
        if (Math.max(ax, bx) + reach < originX || Math.min(ax, bx) - reach > maxX) continue;
        if (Math.max(az, bz) + reach < originZ || Math.min(az, bz) - reach > maxZ) continue;
        near.push(k);
      }
      if (near.length === 0) continue;
      const reach2 = reach * reach;
      for (let j = 0; j < res; j++) {
        const z = originZ + j * step;
        for (let i = 0; i < res; i++) {
          const x = originX + i * step;
          let best = reach2;
          let bed = 0;
          let found = false;
          for (let n = 0; n < near.length; n++) {
            const k = near[n]!;
            const ax = pts[2 * k]!, az = pts[2 * k + 1]!;
            const ex = pts[2 * k + 2]! - ax, ez = pts[2 * k + 3]! - az;
            const len2 = ex * ex + ez * ez;
            const t = len2 > 1e-12 ? clamp(((x - ax) * ex + (z - az) * ez) / len2, 0, 1) : 0;
            const dx = x - (ax + ex * t), dz = z - (az + ez * t);
            const d2 = dx * dx + dz * dz;
            if (d2 < best) {
              best = d2;
              found = true;
              bed = c.bed[k]! + (c.bed[k + 1]! - c.bed[k]!) * t;
            }
          }
          if (!found) continue;
          const weight = 1 - smoothstep(c.halfWidth, reach, Math.sqrt(best));
          if (weight <= 0) continue;
          const idx = j * res + i;
          const h = cell.heights[idx]!;
          cell.heights[idx] = h + (bed - h) * weight;
        }
      }
    }
  }
}

export interface BedProfileOptions {
  /** Along-track window (m) of the double box filter that rounds crests and sags. Default 40. */
  smoothing?: number;
  /** Steepest allowed grade (rise over run). Default 0.12. */
  maxGrade?: number;
}

/**
 * Design a road bed from natural centreline heights sampled every `step` metres: a double box
 * filter so crests and sags are cut and filled rather than followed, then a symmetric grade limit
 * (the mean of the highest and lowest `maxGrade`-Lipschitz envelopes, which leaves any stretch that
 * already meets the limit untouched). Pure and deterministic; the result feeds
 * {@link GradedCorridor.bed}.
 */
export function designBedProfile(natural: ArrayLike<number>, step: number, options: BedProfileOptions = {}): Float64Array {
  const n = natural.length;
  if (n < 2) throw new UsageError("designBedProfile: needs at least two samples");
  if (!(step > 0) || !Number.isFinite(step)) throw new UsageError("designBedProfile: step must be a positive finite number");
  const smoothing = options.smoothing ?? 40;
  const maxGrade = options.maxGrade ?? 0.12;
  if (!(maxGrade > 0)) throw new UsageError("designBedProfile: maxGrade must be positive");
  const half = Math.max(1, Math.round(smoothing / 2 / step));
  let current = Float64Array.from(natural as ArrayLike<number>);
  for (let pass = 0; pass < 2; pass++) {
    const next = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      // Clamp (rather than wrap) at the ends of an open track and average only what exists.
      let sum = 0;
      let count = 0;
      for (let k = -half; k <= half; k++) {
        const at = i + k;
        if (at < 0 || at >= n) continue;
        sum += current[at]!;
        count++;
      }
      next[i] = sum / count;
    }
    current = next;
  }
  const limit = maxGrade * step;
  const upper = Float64Array.from(current);
  const lower = Float64Array.from(current);
  for (let i = 1; i < n; i++) {
    upper[i] = Math.min(upper[i]!, upper[i - 1]! + limit);
    lower[i] = Math.max(lower[i]!, lower[i - 1]! - limit);
  }
  for (let i = n - 2; i >= 0; i--) {
    upper[i] = Math.min(upper[i]!, upper[i + 1]! + limit);
    lower[i] = Math.max(lower[i]!, lower[i + 1]! - limit);
  }
  const bed = new Float64Array(n);
  for (let i = 0; i < n; i++) bed[i] = (upper[i]! + lower[i]!) * 0.5;
  return bed;
}
