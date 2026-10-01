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
}

/**
 * Identifies a world inside its residency keys. Two `PopulationWorld`s in one scene may both scatter
 * a type 1 into chunk (0,0), and their blocks are different data: the renderer's device-resident
 * slots are keyed by string, so the key has to carry the world.
 */
let worldSerial = 0;

interface TypeRecord {
  readonly spec: ResolvedPopulationTypeSpec;
  readonly block: PopulationInstanceBlock;
  /** Present only when the type has both a geometry and a material; reused every frame. */
  readonly submission: PopulationSubmission | null;
  /**
   * The block's data version, read through the submission's getter (Phase 14.3): a scatter and a
   * remesh re-anchor bump it, and the renderer re-uploads the device-resident records when it moves.
   */
  readonly state: { version: number };
}

interface ChunkRecord {
  readonly key: string;
  readonly cx: number;
  readonly cz: number;
  readonly types: readonly TypeRecord[];
  /** The tile the Y positions are anchored to; a remesh replaces it. */
  tileRef: TerrainTile | null;
}

/** Adapts a resident terrain tile to the scatter's sampling interface. */
class HeightmapSampler implements PopulationSurfaceSampler {
  constructor(private readonly tile: TerrainTile) {}

  heightAt(worldX: number, worldZ: number): number {
    return this.tile.heightmap.getHeight(worldX, worldZ);
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
  /** This world's half of every residency key it hands the renderer. */
  readonly uid: number;

  private readonly populated = new Map<string, ChunkRecord>();
  private readonly pending: string[] = [];
  private readonly pendingSet = new Set<string>();
  private readonly generationsPerFrame: number;
  private readonly scratchMatrix = new Mat4();
  private readonly scratchWorldBox = new AABB();

  constructor(options: PopulationWorldOptions) {
    super();
    this.uid = ++worldSerial;
    this.terrain = options.terrain;
    this.seed = options.seed ?? options.terrain.seed;
    this.generationsPerFrame = Math.max(0, Math.floor(options.generationsPerFrame ?? 4));
    const ids = new Set<number>();
    this.types = options.types.map((type) => {
      const spec = resolvePopulationTypeSpec(type);
      if (ids.has(spec.id)) throw new Error(`population: duplicate type id ${spec.id} ("${spec.label}")`);
      ids.add(spec.id);
      return spec;
    });
    this.typeInputs = options.types;
  }

  private readonly typeInputs: readonly PopulationType[];

  // ------------------------------------------------------------------ streaming

  override update(_context: SystemContext, _dt: number): void {
    this.diffChunks();
    this.processPending();
    this.reanchorRemeshed();
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

  /** Re-anchor Y positions (and bounds) of chunks whose tile was remeshed at another LOD. */
  private reanchorRemeshed(): void {
    for (const record of this.populated.values()) {
      const chunk = this.terrain.chunks.get(record.key);
      if (!chunk || chunk.state !== "ready" || !chunk.tile || chunk.tile === record.tileRef) continue;
      const sampler = new HeightmapSampler(chunk.tile);
      for (const type of record.types) {
        const spec = type.spec;
        const block = type.block;
        for (let k = 0; k < block.count; k++) {
          block.positions[k * 3 + 1] =
            sampler.heightAt(block.positions[k * 3]!, block.positions[k * 3 + 2]!) - spec.embed * block.scales[k * 3 + 1]! + spec.lift;
        }
        // The records the renderer uploaded describe the *old* Y: a new version is what tells it to
        // compose and upload them again (Phase 14.3's device-resident blocks).
        type.state.version++;
        if (type.submission) this.buildBounds(type, type.submission);
      }
      record.tileRef = chunk.tile;
    }
  }

  private populateChunk(key: string, cx: number, cz: number, tile: TerrainTile): void {
    const sampler = new HeightmapSampler(tile);
    const chunkSize = this.terrain.chunkSize;
    const types: TypeRecord[] = this.types.map((spec, index) => {
      const input = this.typeInputs[index]!;
      const block = new PopulationInstanceBlock(spec.maxPerChunk);
      scatterPopulationChunk(spec, this.seed, cx, cz, chunkSize, sampler, block);
      const geometry = input.geometry ?? null;
      const material = input.material ?? null;
      const state = { version: 1 };
      // One key per (world, type, chunk): the identity the renderer's device-resident slot is
      // allocated under, and dropped when this world stops offering it (the chunk streamed out).
      const residencyKey = `pop${this.uid}:${spec.id}:${cx},${cz}`;
      const submission: PopulationSubmission | null =
        geometry && material
          ? {
              geometry,
              material,
              instances: block,
              bounds: new AABB(),
              castShadow: spec.castShadow,
              maxDistance: spec.maxDistance,
              residencyKey,
              get residencyVersion(): number {
                return state.version;
              },
            }
          : null;
      if (submission) this.buildBounds({ spec, block, submission, state }, submission);
      return { spec, block, submission, state };
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
