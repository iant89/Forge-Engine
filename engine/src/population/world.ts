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
import { AABB, RayHit, type Ray } from "../math/geometry.js";
import { Mat4, composeYTRS } from "../math/mat.js";
import { Vec3 } from "../math/vec.js";
import type { Geometry } from "../rendering/geometry.js";
import type { Material } from "../rendering/material.js";
import type { TerrainWorld } from "../terrain/world.js";
import type { TerrainTile } from "../terrain/chunk.js";
import {
  GridPopulationSurfaceSampler,
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
import { TaskPriority, TaskCancelledError, type TaskScheduler } from "../core/tasks/scheduler.js";
import { describePipeline, type TerrainPipelineSpec } from "../terrain/pipelineSpec.js";
import {
  POPULATION_CHUNK_TASK,
  installPopulationTaskHandlers,
  type PopulationChunkTaskPayload,
  type PopulationChunkTaskResult,
} from "./tasks.js";

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
  /**
   * Remesh Y anchoring beyond this XZ distance (metres, chunk centre to the terrain focus, which
   * tracks the camera) snaps instantly instead of gliding at the 8/s settle rate. A
   * coarse↔fine LOD swap moves the sampled surface by metres, and a 0.6 s glide of that gap at
   * 300+ m reads as rocks falling from the sky on newly streamed-in terrain — while an instant
   * snap at that range is a sub-degree pop no one can see. Near chunks keep the glide so a
   * refinement underfoot never visibly teleports a rock. Default 120. `0` snaps everything,
   * `Infinity` restores the old always-glide behaviour.
   */
  settleSnapDistance?: number;
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
  /** Canonical surface data used for this chunk's placement acceptance. */
  readonly surfaceHeights: Float32Array;
  readonly surfaceResolution: number;
}

interface PendingPopulationTask {
  readonly taskKey: string;
  readonly scheduler: TaskScheduler;
}

interface PopulationCompletion {
  readonly key: string;
  readonly tile: TerrainTile;
  readonly result: PopulationChunkTaskResult;
}

/** Metadata for a hit returned by `PopulationWorld.raycast`. */
export interface PopulationRaycastInfo {
  readonly chunkKey: string;
  readonly typeId: number;
  readonly instanceIndex: number;
}

function populationRaycastTag(chunkKey: string, typeId: number, instanceIndex: number): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < chunkKey.length; i++) hash = Math.imul(hash ^ chunkKey.charCodeAt(i), 16777619);
  hash = Math.imul(hash ^ typeId, 16777619);
  hash = Math.imul(hash ^ instanceIndex, 16777619);
  return (hash >>> 0) || 1;
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
  private readonly pendingTasks = new Map<string, PendingPopulationTask>();
  private readonly completed: PopulationCompletion[] = [];
  /** Undefined means not attempted; null means the pipeline is intentionally inline-only. */
  private populationPipelineSpec: TerrainPipelineSpec | null | undefined;
  private populationTaskEpoch = 0;
  readonly generationStats = {
    scheduled: 0,
    inline: 0,
    completed: 0,
    cancelled: 0,
    failed: 0,
  };
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
  private readonly raycastMatrix = new Mat4();
  private readonly raycastWorldBox = new AABB();
  private readonly raycastRange = new Float32Array(2);
  private readonly raycastHit = new RayHit();
  private readonly raycastTags = new Map<number, PopulationRaycastInfo>();
  /** @see {@link PopulationWorldOptions.settleSnapDistance} */
  readonly settleSnapDistance: number;

  constructor(options: PopulationWorldOptions) {
    super();
    this.terrain = options.terrain;
    this.seed = options.seed ?? options.terrain.seed;
    this.generationsPerFrame = Math.max(0, Math.floor(options.generationsPerFrame ?? 4));
    this.settleSnapDistance = options.settleSnapDistance ?? 120;
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

  override update(context: SystemContext, dt: number): void {
    // Promise callbacks run after the previous frame; consume them before diffing terrain, otherwise
    // a completed task could be queued a second time for one microtask-sized window.
    this.drainCompletions();
    this.diffChunks();
    this.processPending(context);
    this.reanchorRemeshed();
    this.settleAnchoredY(dt);
  }

  /** Enqueue newly ready terrain chunks; drop records for evicted ones and cancel stale jobs. */
  private diffChunks(): void {
    for (const [key, pending] of this.pendingTasks) {
      if (this.terrain.chunks.has(key)) continue;
      pending.scheduler.cancel(pending.taskKey);
      this.pendingTasks.delete(key);
      this.pendingSet.delete(key);
      this.generationStats.cancelled++;
    }
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

  private pipelineSpec(): TerrainPipelineSpec | null {
    if (this.populationPipelineSpec !== undefined) return this.populationPipelineSpec;
    try {
      this.populationPipelineSpec = describePipeline(this.terrain.pipeline);
    } catch {
      // Custom stages and live Mars Stage A field caches are deliberately inline-only. The caller
      // still gets deterministic placement; only the worker optimization is unavailable.
      this.populationPipelineSpec = null;
    }
    return this.populationPipelineSpec;
  }

  private processPending(context: SystemContext): void {
    let budget = this.generationsPerFrame;
    const scheduler = context.services.get<TaskScheduler>("tasks");
    if (scheduler) installPopulationTaskHandlers();
    while (budget > 0 && this.pending.length > 0) {
      const key = this.pending.shift()!;
      const chunk = this.terrain.chunks.get(key);
      // The chunk may have been evicted (or is mid-regeneration) while queued; it re-enqueues
      // itself on a later frame if it becomes ready again.
      if (!chunk || chunk.state !== "ready" || !chunk.tile) {
        this.pendingSet.delete(key);
        continue;
      }
      if (scheduler && this.scheduleChunk(key, chunk.cx, chunk.cz, scheduler)) {
        budget--;
        continue;
      }
      this.populateChunk(key, chunk.cx, chunk.cz, chunk.tile);
      this.pendingSet.delete(key);
      this.generationStats.inline++;
      budget--;
    }
  }

  private scheduleChunk(key: string, cx: number, cz: number, scheduler: TaskScheduler): boolean {
    const pipeline = this.pipelineSpec();
    if (!pipeline) return false;
    const taskKey = `population.chunk:${cx},${cz}:${++this.populationTaskEpoch}`;
    const payload: PopulationChunkTaskPayload = {
      seed: this.seed,
      cx,
      cz,
      size: this.terrain.chunkSize,
      surfaceResolution: this.terrain.populationSurfaceResolution,
      pipeline,
      types: this.types.map((type) => ({ ...type })),
      settlePhysics: this.settlePhysics === true ? {} : this.settlePhysics || false,
    };
    try {
      const promise = scheduler.submit<PopulationChunkTaskPayload, PopulationChunkTaskResult>({
        name: POPULATION_CHUNK_TASK,
        key: taskKey,
        payload,
        priority: TaskPriority.Normal,
      });
      this.pendingTasks.set(key, { taskKey, scheduler });
      this.pendingSet.add(key);
      this.generationStats.scheduled++;
      promise
        .then((result) => {
          const current = this.pendingTasks.get(key);
          if (!current || current.taskKey !== taskKey) return;
          this.pendingTasks.delete(key);
          const chunk = this.terrain.chunks.get(key);
          if (!chunk || chunk.state !== "ready" || !chunk.tile) {
            this.pendingSet.delete(key);
            return;
          }
          this.completed.push({ key, tile: chunk.tile, result });
        })
        .catch((error: unknown) => {
          const current = this.pendingTasks.get(key);
          if (!current || current.taskKey !== taskKey) return;
          this.pendingTasks.delete(key);
          this.pendingSet.delete(key);
          if (error instanceof TaskCancelledError) {
            this.generationStats.cancelled++;
            return;
          }
          this.generationStats.failed++;
          const chunk = this.terrain.chunks.get(key);
          if (chunk?.state === "ready" && chunk.tile) {
            // A worker/CSP failure must not leave a streamed chunk without its population.
            this.populateChunk(key, chunk.cx, chunk.cz, chunk.tile);
            this.generationStats.inline++;
          }
        });
      return true;
    } catch {
      // Queue overflow or a scheduler that was disposed: direct generation is the safe fallback.
      return false;
    }
  }

  private drainCompletions(): void {
    while (this.completed.length > 0) {
      const completion = this.completed.shift()!;
      if (this.populated.has(completion.key)) continue;
      const chunk = this.terrain.chunks.get(completion.key);
      if (!chunk || chunk.state !== "ready" || !chunk.tile) {
        this.pendingSet.delete(completion.key);
        continue;
      }
      this.populateChunkFromResult(completion.key, chunk.cx, chunk.cz, completion.tile, completion.result);
      this.pendingSet.delete(completion.key);
      this.generationStats.completed++;
    }
  }

  /**
   * Re-anchor the Y of chunks whose tile was remeshed at another LOD. Near chunks only move the
   * *targets*: the rendered Y damps toward the new surface in `settleAnchoredY` instead of
   * snapping, so a refinement underfoot never visibly teleports a rock (uploads and bounds
   * rebuilds happen in the settling pass, only for blocks that actually moved). Far chunks (past
   * `settleSnapDistance`) snap the rendered Y outright: on rough terrain a coarse<->fine
   * LOD swap moves the sampled surface by meters, and a 0.6 s glide of that gap at 300+ m reads
   * as rocks falling from the sky on newly streamed-in chunks, while the snap itself is
   * sub-degree at that range. Hidden (zero-Y-scale) instances keep their parked Y either way.
   */
  private reanchorRemeshed(): void {
    const focus = this.terrain.focusPosition;
    const chunkSize = this.terrain.chunkSize;
    for (const record of this.populated.values()) {
      const chunk = this.terrain.chunks.get(record.key);
      if (!chunk || chunk.state !== "ready" || !chunk.tile || chunk.tile === record.tileRef) continue;
      const sampler = new HeightmapSampler(chunk.tile);
      // LOD selection measures camera distance to the chunk centre; the snap gate uses the same
      // point so a chunk and its rocks always agree about which side of a remesh boundary they sit.
      const centreX = (record.cx + 0.5) * chunkSize;
      const centreZ = (record.cz + 0.5) * chunkSize;
      const snap = Math.hypot(centreX - focus.x, centreZ - focus.z) > this.settleSnapDistance;
      for (const type of record.types) {
        const block = type.block;
        if (block.count === 0) continue;
        let snapped = false;
        for (let k = 0; k < block.count; k++) {
          const target =
            sampler.heightAt(block.positions[k * 3]!, block.positions[k * 3 + 2]!) - type.spec.embed * block.scales[k * 3 + 1]!;
          block.targetY[k] = target;
          if (snap && block.scales[k * 3 + 1] !== 0) {
            block.positions[k * 3 + 1] = target;
            snapped = true;
          }
        }
        if (snapped) {
          block.markModified();
          if (type.submission) this.buildBounds(type, type.submission);
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
    const surface = this.terrain.getPopulationSurface(cx, cz);
    const sampler = new GridPopulationSurfaceSampler({
      originX: surface.originX,
      originZ: surface.originZ,
      size: surface.size,
      resolution: surface.resolution,
      heights: surface.heights,
    });
    this.populateChunkWithSampler(key, cx, cz, tile, sampler, surface.heights, surface.resolution);
  }

  private populateChunkFromResult(
    key: string,
    cx: number,
    cz: number,
    tile: TerrainTile,
    result: PopulationChunkTaskResult,
  ): void {
    const sampler = new GridPopulationSurfaceSampler({
      originX: cx * this.terrain.chunkSize,
      originZ: cz * this.terrain.chunkSize,
      size: this.terrain.chunkSize,
      resolution: result.surfaceResolution,
      heights: result.surfaceHeights,
    });
    this.populateChunkWithSampler(key, cx, cz, tile, sampler, result.surfaceHeights, result.surfaceResolution, result);
  }

  private populateChunkWithSampler(
    key: string,
    cx: number,
    cz: number,
    tile: TerrainTile,
    sampler: PopulationSurfaceSampler,
    surfaceHeights: Float32Array,
    surfaceResolution: number,
    generated?: PopulationChunkTaskResult,
  ): void {
    const chunkSize = this.terrain.chunkSize;
    const entries = new Map((generated?.entries ?? []).map((entry) => [entry.typeId, entry]));
    const types: TypeRecord[] = this.types.map((spec, index) => {
      const input = this.typeInputs[index]!;
      const block = new PopulationInstanceBlock(spec.maxPerChunk);
      const entry = entries.get(spec.id);
      if (entry) {
        if (
          entry.count < 0 ||
          entry.count > block.capacity ||
          entry.positions.length < entry.count * 3 ||
          entry.scales.length < entry.count * 3 ||
          entry.rotations.length < entry.count ||
          entry.tints.length < entry.count
        ) {
          throw new Error(`population task returned an invalid ${spec.label} block for ${key}`);
        }
        block.positions.set(entry.positions.subarray(0, entry.count * 3));
        block.scales.set(entry.scales.subarray(0, entry.count * 3));
        block.rotations.set(entry.rotations.subarray(0, entry.count));
        block.tints.set(entry.tints.subarray(0, entry.count));
        block.count = entry.count;
        block.markModified();
      } else {
        scatterPopulationChunk(spec, this.seed, cx, cz, chunkSize, sampler, block);
        if (this.settlePhysics) {
          const settleOpts = typeof this.settlePhysics === "object" ? this.settlePhysics : undefined;
          settlePopulationBlockWithPhysics(block, spec, sampler, settleOpts);
        }
      }
      // Freshly scattered or worker-returned instances start exactly on their anchor: settling only
      // ever kicks in after a remesh re-anchor moves the targets.
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
    this.populated.set(key, {
      key,
      cx,
      cz,
      types,
      tileRef: tile,
      surfaceHeights,
      surfaceResolution,
    });
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

  // ------------------------------------------------------------------ picking

  /**
   * Raycast resident population geometry without creating ECS entities. The query uses the same
   * prototype geometry and per-instance YTRS matrices as the renderer, so non-uniformly scaled
   * rocks and decals return triangle-accurate points and normals. `RayHit.tag` is a stable hash for
   * the chunk/type/instance tuple; call `raycastInfo(tag)` immediately after the query to decode it.
   */
  override raycast(ray: Ray, hit: RayHit): boolean {
    hit.reset();
    this.raycastTags.clear();
    let found = false;
    let closest = ray.maxDistance;
    for (const record of this.populated.values()) {
      for (const type of record.types) {
        const geometry = type.submission?.geometry;
        if (!geometry) continue;
        const block = type.block;
        for (let index = 0; index < block.count; index++) {
          const p = index * 3;
          if (block.scales[p] === 0 || block.scales[p + 1] === 0 || block.scales[p + 2] === 0) continue;
          composeYTRS(
            block.positions[p]!,
            block.positions[p + 1]!,
            block.positions[p + 2]!,
            block.scales[p]!,
            block.scales[p + 1]!,
            block.scales[p + 2]!,
            block.rotations[index]!,
            this.raycastMatrix.m,
            0,
          );
          geometry.bounds.transformByMatrix(this.raycastMatrix, this.raycastWorldBox);
          this.raycastRange[0] = 0;
          this.raycastRange[1] = closest;
          if (!this.raycastWorldBox.intersectsRay(ray.origin, ray.invDirection, this.raycastRange)) continue;
          this.raycastHit.reset();
          if (!geometry.raycast(ray, this.raycastMatrix, this.raycastHit) || this.raycastHit.distance >= closest) continue;
          closest = this.raycastHit.distance;
          hit.copyFrom(this.raycastHit);
          const tag = populationRaycastTag(record.key, type.spec.id, index);
          hit.tag = tag;
          this.raycastTags.set(tag, { chunkKey: record.key, typeId: type.spec.id, instanceIndex: index });
          found = true;
        }
      }
    }
    return found;
  }

  /** Decode the most recent `RayHit.tag` produced by this population world. */
  raycastInfo(tag: number): PopulationRaycastInfo | null {
    return this.raycastTags.get(tag) ?? null;
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
      pending: this.pending.length + this.pendingTasks.size,
      types: this.types.length,
      instances,
      generationScheduled: this.generationStats.scheduled,
      generationInline: this.generationStats.inline,
      generationCompleted: this.generationStats.completed,
      generationCancelled: this.generationStats.cancelled,
      generationFailed: this.generationStats.failed,
    };
  }

  override dispose(): void {
    for (const pending of this.pendingTasks.values()) pending.scheduler.cancel(pending.taskKey);
    this.pendingTasks.clear();
    this.completed.length = 0;
    this.populated.clear();
    this.pending.length = 0;
    this.pendingSet.clear();
    this.raycastTags.clear();
  }
}
