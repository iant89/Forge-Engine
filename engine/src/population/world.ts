/**
 * `PopulationWorld` — world population streaming (Phase 14.6).
 *
 * Follows a `TerrainWorld`: every terrain chunk that becomes resident gets a deterministic
 * population per configured type (Phase 14.1 scatter into Phase 14.3 compact blocks), and every
 * evicted chunk's population goes with it. The world owns **no entities** — that is the phase's
 * defining constraint — and creates no GPU resources of its own; geometry and material belong to
 * the configured types (the demo creates and disposes them).
 *
 * Per-chunk work happens once, when the chunk first becomes ready, and on remesh only the Y
 * positions are re-anchored to the new heightmap (XZ placement, scale, rotation and tint stay —
 * re-scattering on LOD change would pop the whole chunk's rocks every remesh). The per-frame cost
 * of a populated chunk is one submission to the renderer; the renderer turns that into one instanced
 * batch with its own bounds, so the Phase 13.5 device culler can drop whole chunks.
 *
 * Determinism: placement is a pure function of `(type, seed, chunk coordinate)` and the surface
 * samples of the tile the chunk first became ready at — see KNOWN-ISSUES for the LOD-resolution
 * caveat that follows from "sample the tile that is actually drawn".
 */

import { SceneObject } from "../scene/scene.js";
import type { SystemContext } from "../scene/systems.js";
import { AABB } from "../math/geometry.js";
import { Mat4, composeYTRS } from "../math/mat.js";
import { Vec3 } from "../math/vec.js";
import type { Geometry } from "../rendering/geometry.js";
import type { Material } from "../rendering/material.js";
import type { TerrainWorld } from "../terrain/world.js";
import type { TerrainTile } from "../terrain/chunk.js";
import {
  resolvePopulationTypeSpec,
  scatterPopulationChunk,
  type PopulationSurfaceSampler,
  type PopulationTypeSpec,
  type ResolvedPopulationTypeSpec,
} from "./scatter.js";
import {
  settlePopulationBlockWithPhysics,
  type PopulationPhysicsSettlingOptions,
} from "./settle.js";
import {
  PopulationInstanceBlock,
  type PopulationCollector,
  type PopulationSource,
  type PopulationSubmission,
} from "../scene/population.js";

/** A population type spec paired with what draws it. Geometry/material are owned by the caller. */
export interface PopulationType extends PopulationTypeSpec {
  /** Shared by every instance of the type; `null`/omitted keeps the type CPU-only (headless tests). */
  geometry?: Geometry | null;
  /** Shared by every instance of the type; `null`/omitted keeps the type CPU-only. */
  material?: Material | null;
  /**
   * Phase 14.4: GPU-selected LOD. When `geometry` is a merged hi+lo buffer (population/lod.ts),
   * its high-window triangle count and the camera distance (metres) beyond which an instance
   * takes the low window. Omitted draws the geometry as a single detail level.
   */
  lod?: { hiTriangles: number; distance: number } | null;
}

export interface PopulationWorldOptions {
  /** The terrain whose chunk streaming the population follows. */
  terrain: TerrainWorld;
  /** Population types; ids must be unique within the world. */
  types: PopulationType[];
  /** World seed folded into every chunk's population stream. Defaults to the terrain's seed. */
  seed?: number;
  /**
   * Chunk populations built per update (default 4). Populating a chunk is one scatter pass per
   * type over the chunk's resident heightmap — bounded, but not free, so the initial disc fills
   * over a few dozen frames instead of one.
   */
  generationsPerFrame?: number;
  /**
   * When enabled (or options provided), applies physical settling (gravity, terrain slope contact,
   * static/kinetic friction, downslope rolling/sliding) to every spawned object when a chunk is populated,
   * ensuring all objects settle into stable equilibrium at world generation.
   */
  settlePhysics?: boolean | PopulationPhysicsSettlingOptions;
}

interface TypeRecord {
  readonly spec: ResolvedPopulationTypeSpec;
  readonly block: PopulationInstanceBlock;
  /** Present only when the type has both a geometry and a material; reused every frame. */
  readonly submission: PopulationSubmission | null;
}

interface ChunkRecord {
  readonly key: string;
  readonly cx: number;
  readonly cz: number;
  readonly types: readonly TypeRecord[];
  /** The tile the Y positions are anchored to; a remesh replaces it. */
  tileRef: TerrainTile | null;
}

/**
 * Adapts a resident terrain tile to the scatter's sampling interface. Bilinear sampling matches
 * the piecewise-linear rendered mesh facets exactly: bicubic overshoots the triangles on rough
 * terrain, which floats rocks above the visible ground and snaps them by meters when a chunk
 * remeshes at another LOD (which reads as rocks falling from the sky on streamed-in terrain).
 */
class HeightmapSampler implements PopulationSurfaceSampler {
  constructor(private readonly tile: TerrainTile) {}

  heightAt(worldX: number, worldZ: number): number {
    return this.tile.heightmap.getHeightBilinear(worldX, worldZ);
  }

  normalYAt(worldX: number, worldZ: number): number {
    return this.tile.heightmap.getNormal(worldX, worldZ, HeightmapSampler.normal).y;
  }

  private static readonly normal = new Vec3();
}

export class PopulationWorld extends SceneObject implements PopulationSource {
  readonly name = "population";
  readonly terrain: TerrainWorld;
  readonly seed: number;
  readonly types: readonly ResolvedPopulationTypeSpec[];
  readonly settlePhysics: boolean | PopulationPhysicsSettlingOptions;

  private readonly populated = new Map<string, ChunkRecord>();
  private readonly pending: string[] = [];
  /**
   * Y-settling rate (1/s) toward re-anchored targets. 8 converges 99% in ~0.6 s — fast enough that
   * a remeshed chunk's rocks never visibly float, slow enough that a meter-scale LOD height
   * correction reads as a glide instead of a fall.
   */
  private static readonly anchorSettleRate = 8;
  private readonly pendingSet = new Set<string>();
  private readonly generationsPerFrame: number;
  private readonly scratchMatrix = new Mat4();
  private readonly scratchWorldBox = new AABB();

  constructor(options: PopulationWorldOptions) {
    super();
    this.terrain = options.terrain;
    this.seed = options.seed ?? options.terrain.seed;
    this.generationsPerFrame = Math.max(0, Math.floor(options.generationsPerFrame ?? 4));
    this.settlePhysics = options.settlePhysics ?? false;
    const ids = new Set<number>();
    this.types = options.types.map((type) => {
      if (type.lod) {
        const { hiTriangles, distance } = type.lod;
        if (!Number.isInteger(hiTriangles) || hiTriangles <= 0) {
          throw new RangeError(`population type "${type.label}": lod.hiTriangles must be a positive integer`);
        }
        if (!Number.isFinite(distance) || distance < 0) {
          throw new RangeError(`population type "${type.label}": lod.distance must be a finite, non-negative number`);
        }
        if (type.material?.technique === "water") {
          throw new RangeError(`population type "${type.label}": GPU LOD is not supported by the water vertex entry`);
        }
        const geometry = type.geometry;
        if (geometry && (geometry.indexBuffer !== null || geometry.topology !== "triangle-list" || geometry.vertexCount % 3 !== 0 || hiTriangles >= geometry.vertexCount / 3)) {
          throw new RangeError(`population type "${type.label}": LOD geometry must be an unindexed triangle list with non-empty high and low windows`);
        }
      }
      const spec = resolvePopulationTypeSpec(type);
      if (ids.has(spec.id)) throw new Error(`population: duplicate type id ${spec.id} ("${spec.label}")`);
      ids.add(spec.id);
      return spec;
    });
    this.typeInputs = options.types;
  }

  private readonly typeInputs: readonly PopulationType[];

  // ------------------------------------------------------------------ streaming

  override update(_context: SystemContext, dt: number): void {
    this.diffChunks();
    this.processPending();
    this.reanchorRemeshed();
    this.settleAnchoredY(dt);
  }

  /** Enqueue newly ready terrain chunks; drop records for evicted ones. */
  private diffChunks(): void {
    for (const [key, chunk] of this.terrain.chunks) {
      if (this.populated.has(key) || this.pendingSet.has(key)) continue;
      if (chunk.state === "ready" && chunk.tile) {
        this.pending.push(key);
        this.pendingSet.add(key);
      }
    }
    if (this.populated.size > 0) {
      for (const key of this.populated.keys()) {
        if (!this.terrain.chunks.has(key)) {
          this.populated.delete(key);
        }
      }
    }
  }

  private processPending(): void {
    let budget = this.generationsPerFrame;
    while (budget > 0 && this.pending.length > 0) {
      const key = this.pending.shift()!;
      this.pendingSet.delete(key);
      const chunk = this.terrain.chunks.get(key);
      // The chunk may have been evicted (or is mid-regeneration) while queued; it re-enqueues
      // itself on a later frame if it becomes ready again.
      if (!chunk || chunk.state !== "ready" || !chunk.tile) continue;
      this.populateChunk(key, chunk.cx, chunk.cz, chunk.tile);
      budget--;
    }
  }

  /**
   * Re-anchor the Y *targets* of chunks whose tile was remeshed at another LOD. The rendered Y
   * damps toward the new surface in `settleAnchoredY` instead of snapping: on rough terrain a
   * coarse<->fine LOD swap moves the sampled surface by meters, and an instant snap reads as rocks
   * falling from the sky on newly streamed-in chunks. Uploads and bounds rebuilds happen in the
   * settling pass, only for blocks that actually moved.
   */
  private reanchorRemeshed(): void {
    for (const record of this.populated.values()) {
      const chunk = this.terrain.chunks.get(record.key);
      if (!chunk || chunk.state !== "ready" || !chunk.tile || chunk.tile === record.tileRef) continue;
      const sampler = new HeightmapSampler(chunk.tile);
      for (const type of record.types) {
        const block = type.block;
        if (block.count === 0) continue;
        for (let k = 0; k < block.count; k++) {
          block.targetY[k] =
            sampler.heightAt(block.positions[k * 3]!, block.positions[k * 3 + 2]!) - type.spec.embed * block.scales[k * 3 + 1]!;
        }
      }
      record.tileRef = chunk.tile;
    }
  }

  /**
   * Exponential Y settling toward the anchored targets (`PopulationInstanceBlock.targetY`).
   * Framerate-independent; converges to <2mm and snaps. Skips showcase-hidden instances (zero
   * Y scale), whose rendered Y is parked out of sight until write-back restores them.
   */
  private settleAnchoredY(dt: number): void {
    if (dt <= 0) return;
    const step = 1 - Math.exp(-PopulationWorld.anchorSettleRate * dt);
    for (const record of this.populated.values()) {
      for (const type of record.types) {
        const block = type.block;
        if (block.count === 0) continue;
        let moved = false;
        for (let k = 0; k < block.count; k++) {
          // Zero Y scale marks a showcase-hidden instance — its parked Y must not settle.
          if (block.scales[k * 3 + 1] === 0) continue;
          const target = block.targetY[k]!;
          const y = block.positions[k * 3 + 1]!;
          const delta = target - y;
          if (delta === 0) continue;
          block.positions[k * 3 + 1] = Math.abs(delta) < 0.002 ? target : y + delta * step;
          moved = true;
        }
        if (moved) {
          // The device-resident buffer (Phase 14.3) must re-upload: Y positions moved.
          block.markModified();
          if (type.submission) this.buildBounds(type, type.submission);
        }
      }
    }
  }

  private populateChunk(key: string, cx: number, cz: number, tile: TerrainTile): void {
    const sampler = new HeightmapSampler(tile);
    const chunkSize = this.terrain.chunkSize;
    const types: TypeRecord[] = this.types.map((spec, index) => {
      const input = this.typeInputs[index]!;
      const block = new PopulationInstanceBlock(spec.maxPerChunk);
      scatterPopulationChunk(spec, this.seed, cx, cz, chunkSize, sampler, block);
      if (this.settlePhysics) {
        const settleOpts = typeof this.settlePhysics === "object" ? this.settlePhysics : undefined;
        settlePopulationBlockWithPhysics(block, spec, sampler, settleOpts);
      }
      // Freshly scattered instances start exactly on their anchor: settling only ever kicks in
      // after a remesh re-anchor moves the targets.
      block.snapAllY();
      const geometry = input.geometry ?? null;
      const material = input.material ?? null;
      const submission: PopulationSubmission | null =
        geometry && material
          ? {
              geometry,
              material,
              instances: block,
              bounds: new AABB(),
              castShadow: spec.castShadow,
              maxDistance: spec.maxDistance,
              lod: input.lod ? { hiTriangles: input.lod.hiTriangles, lodDistance: input.lod.distance } : null,
            }
          : null;
      if (submission) this.buildBounds({ spec, block, submission }, submission);
      return { spec, block, submission };
    });
    this.populated.set(key, { key, cx, cz, types, tileRef: tile });
  }

  /** Union of the instances' transformed geometry bounds — the submission's conservative bounds. */
  private buildBounds(type: TypeRecord, submission: PopulationSubmission): void {
    const geometry = submission.geometry!;
    const local = geometry.bounds;
    const block = type.block;
    const m = this.scratchMatrix.m;
    const world = this.scratchWorldBox;
    let first = true;
    for (let k = 0; k < block.count; k++) {
      composeYTRS(
        block.positions[k * 3]!,
        block.positions[k * 3 + 1]!,
        block.positions[k * 3 + 2]!,
        block.scales[k * 3]!,
        block.scales[k * 3 + 1]!,
        block.scales[k * 3 + 2]!,
        block.rotations[k]!,
        m,
        0,
      );
      local.transformByMatrix(this.scratchMatrix, world);
      if (first) {
        submission.bounds.setFrom(world.min, world.max);
        first = false;
      } else {
        submission.bounds.union(world);
      }
    }
    if (first) submission.bounds.setFrom(Vec3.zero, Vec3.zero);
  }

  // ------------------------------------------------------------------ submission

  collectPopulations(collector: PopulationCollector): void {
    for (const record of this.populated.values()) {
      for (const type of record.types) {
        const submission = type.submission;
        if (!submission || type.block.count === 0) continue;
        collector.addPopulationBatch(submission);
      }
    }
  }

  // ------------------------------------------------------------------ introspection

  /** Instance count for one populated chunk (all types), or 0 when the chunk has no population. */
  instancesFor(key: string): number {
    const record = this.populated.get(key);
    if (!record) return 0;
    let total = 0;
    for (const type of record.types) total += type.block.count;
    return total;
  }

  /**
   * The live instance block of one (chunk, type), or `null`. Read-only by convention: mutating the
   * returned block desynchronises placement from what was scattered (tests use it to pin anchors).
   */
  chunkPopulation(key: string, typeId: number): PopulationInstanceBlock | null {
    const record = this.populated.get(key);
    if (!record) return null;
    for (const type of record.types) if (type.spec.id === typeId) return type.block;
    return null;
  }

  get populatedChunkCount(): number {
    return this.populated.size;
  }

  get pendingChunkCount(): number {
    return this.pending.length;
  }

  override stats(): Record<string, number | string | boolean> {
    let instances = 0;
    for (const record of this.populated.values()) {
      for (const type of record.types) instances += type.block.count;
    }
    return {
      chunks: this.populated.size,
      pending: this.pending.length,
      types: this.types.length,
      instances,
    };
  }

  override dispose(): void {
    this.populated.clear();
    this.pending.length = 0;
    this.pendingSet.clear();
  }
}
