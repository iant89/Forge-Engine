/**
 * `TerrainWorld` — chunk manager, procedural streaming, LOD, and height query engine.
 *
 * Phase 10 turns this into a scalable streaming system:
 *  - Real LOD meshes (`resolutionForLod`) with geomorphing
 *  - Worker generation through `TaskScheduler` when available
 *  - Deterministic generation cache
 *  - Priority queue (distance, facing, screen importance, LOD)
 *  - Cancellation of irrelevant in-flight work
 *  - Horizon skirt so the loaded disc has no visible cliff
 *  - Memory / generation / upload / visible-chunk budgets
 */

import { SceneObject, type Scene } from "../scene/scene.js";
import { type SystemContext } from "../scene/systems.js";
import { TerrainChunk, chunkCoordKey } from "./chunk.js";
import { Heightmap } from "./heightmap.js";
import { TerrainLOD, resolutionForLod, type LODSelection } from "./lod.js";
import { GeneratorPipeline, HeightGenerator, createWorldCell, type HeightGeneratorOptions } from "./generators.js";
import { Material } from "../rendering/material.js";
import { Geometry } from "../rendering/geometry.js";
import { Transform, Renderable, Camera } from "../scene/components/index.js";
import { Vec3 } from "../math/vec.js";
import { clamp } from "../math/scalar.js";
import { Color } from "../math/color.js";
import { Ray, RayHit } from "../math/geometry.js";
import type { EntityId } from "../scene/entityId.js";
import type { GraphicsDevice } from "../gpu/device.js";
import { TaskPriority, TaskCancelledError, type TaskScheduler } from "../core/tasks/scheduler.js";
import {
  cellFromResult,
  terrainCellKey,
  terrainCellPayload,
  type TerrainCellTaskPayload,
  type TerrainCellTaskResult,
  installTerrainTaskHandlers,
} from "./tasks.js";
import { describePipeline, hashPipelineSpec } from "./pipelineSpec.js";
import {
  TERRAIN_GENERATOR_VERSION,
  TerrainGenerationCache,
  terrainCacheKey,
} from "./cache.js";
import { estimateTileBytes, resolveTerrainBudgets, type TerrainBudgets, type TerrainBudgetOptions } from "./budget.js";
import { buildHorizonSkirt } from "./horizon.js";

export interface TerrainWorldOptions extends TerrainBudgetOptions {
  seed?: number;
  chunkSize?: number;
  chunkResolution?: number;
  viewDistance?: number;
  maxLOD?: number;
  /**
   * Opening-disc warm-up: the first update may start this many generations above the steady
   * generation budget, and upload budget stays elevated until those tiles are resident (or the
   * warm-up work queue drains). Keeps the async worker path real while filling the disc in a
   * few frames instead of dripping in at `uploadsPerFrame`.
   */
  warmUpChunks?: number;
  pipeline?: GeneratorPipeline;
  heightOptions?: HeightGeneratorOptions;
  material?: Material;
  /** When false, skip horizon skirt creation (tests that only care about chunks). Default true. */
  horizonSkirt?: boolean;
  /** Outer apron extent past the loaded radius (metres). */
  horizonExtent?: number;
  /**
   * Skirt depth (metres) for every tile: the apron of geometry hanging below a chunk's edge that
   * hides the height difference between neighbouring LODs. The default (8 m) suits gentle terrain at
   * the demo's 128 m chunks; mountainous terrain (or larger chunks, where the coarsest LOD samples
   * every chunkSize/2 metres) needs deeper skirts, e.g. `adviseMarsTile(...).recommendedSkirtDepth`.
   */
  skirtDepth?: number;
  /** Optional external cache (tests). */
  cache?: TerrainGenerationCache;
  /** Force synchronous generation even when a scheduler is present (tests). */
  syncGeneration?: boolean;
}

interface StreamingRequest {
  sel: LODSelection;
  priority: number;
  resolution: number;
}

interface CompletedGeneration {
  key: string;
  result: TerrainCellTaskResult;
  geomorphAlpha: number;
  lod: number;
  resolution: number;
}

const SAMPLED_CELL_CACHE_SIZE = 12;

/** Remesh when baked geomorph alpha drifts beyond this (avoids LOD seam cracks). */
const GEOMORPH_REMESH_EPSILON = 0.08;

export class TerrainWorld extends SceneObject {
  readonly name = "TerrainWorld";

  readonly seed: number;
  readonly chunkSize: number;
  readonly chunkResolution: number;
  readonly viewDistance: number;
  readonly maxLOD: number;
  readonly budgets: TerrainBudgets;
  /** @deprecated Prefer `budgets.visibleChunks`. */
  readonly maxChunksLoaded: number;
  /** @deprecated Prefer `budgets.generationsPerFrame`. */
  readonly maxGenerationsPerFrame: number;
  readonly warmUpChunks: number;
  /** One-shot: elevated generation budget spent on the first update. */
  private warmUpGenerationDone = false;
  /** Elevated upload budget until the warm-up disc is resident (or warm-up work is gone). */
  private warmUpUploadsActive = false;
  /** Per-frame upload cap (steady or warm-up elevated); set at the start of `update`. */
  private frameUploadBudget = 0;
  readonly horizonEnabled: boolean;
  readonly horizonExtent: number;
  readonly skirtDepth: number;
  readonly syncGeneration: boolean;

  readonly pipeline: GeneratorPipeline;
  readonly heightGenerator: HeightGenerator;
  readonly lod: TerrainLOD;
  readonly cache: TerrainGenerationCache;
  readonly pipelineHash: number;

  readonly chunks = new Map<string, TerrainChunk>();
  readonly activeEntities = new Map<string, EntityId>();

  readonly focusPosition = new Vec3();
  readonly focusForward = new Vec3(0, 0, 1);
  material: Material | null = null;

  private readonly sampledCells = new Map<string, Heightmap>();
  private readonly completed: CompletedGeneration[] = [];
  private horizonEntityId: EntityId | null = null;
  private horizonGeometry: Geometry | null = null;
  private horizonCenterX = Number.NaN;
  private horizonCenterZ = Number.NaN;
  private horizonRadius = 0;
  private handlersInstalled = false;
  /** Last TaskScheduler seen in update — used by dispose to cancel in-flight work. */
  private lastScheduler: TaskScheduler | undefined;

  /** Stats exposed for tests / HUD. */
  readonly streamingStats = {
    generatedThisFrame: 0,
    uploadedThisFrame: 0,
    cancelledThisFrame: 0,
    cacheHits: 0,
    cacheMisses: 0,
    scheduledThisFrame: 0,
    inlineThisFrame: 0,
    residentBytes: 0,
  };

  constructor(options: TerrainWorldOptions = {}) {
    super();
    this.seed = options.seed ?? 1234;
    this.chunkSize = options.chunkSize ?? 256;
    this.chunkResolution = options.chunkResolution ?? 33;
    this.viewDistance = options.viewDistance ?? 1024;
    this.maxLOD = options.maxLOD ?? 4;
    this.budgets = resolveTerrainBudgets(options);
    this.maxChunksLoaded = this.budgets.visibleChunks;
    this.maxGenerationsPerFrame = this.budgets.generationsPerFrame;
    this.warmUpChunks = options.warmUpChunks ?? 0;
    this.warmUpUploadsActive = this.warmUpChunks > 0;
    this.horizonEnabled = options.horizonSkirt !== false;
    this.horizonExtent = options.horizonExtent ?? this.chunkSize * 2;
    this.skirtDepth = options.skirtDepth ?? 8.0;
    this.syncGeneration = options.syncGeneration ?? false;

    this.heightGenerator = new HeightGenerator(options.heightOptions);
    this.pipeline = options.pipeline ?? GeneratorPipeline.createDefault(this.seed, options.heightOptions);
    this.pipelineHash = hashPipelineSpec(describePipeline(this.pipeline));
    this.cache =
      options.cache ??
      new TerrainGenerationCache({
        maxBytes: Math.max(8 * 1024 * 1024, Math.floor(this.budgets.memoryBytes * 0.35)),
      });

    // Cap bands at maxLOD+1 so evaluateDistance cannot return a level above maxLOD.
    const lodDistances = [
      this.chunkSize * 1.5,
      this.chunkSize * 3.0,
      this.chunkSize * 6.0,
      this.chunkSize * 12.0,
      this.chunkSize * 24.0,
    ].slice(0, this.maxLOD + 1);
    this.lod = new TerrainLOD({
      baseChunkSize: this.chunkSize,
      maxLOD: this.maxLOD,
      lodDistances,
    });

    if (options.material) {
      this.material = options.material;
    }
  }

  override onAttach(scene: Scene): void {
    super.onAttach?.(scene);
    if (!this.material) {
      this.material = new Material({
        label: "terrain-default-mat",
        color: new Color(0.68, 0.44, 0.32, 1.0),
        roughness: 0.88,
        metallic: 0.05,
        doubleSided: false,
      });
    }
  }

  override onDetach(scene: Scene): void {
    this.dispose();
    super.onDetach?.(scene);
  }

  override update(context: SystemContext, _dt: number): void {
    if (!this.enabled || !this.scene) return;

    this.streamingStats.generatedThisFrame = 0;
    this.streamingStats.uploadedThisFrame = 0;
    this.streamingStats.cancelledThisFrame = 0;
    this.streamingStats.scheduledThisFrame = 0;
    this.streamingStats.inlineThisFrame = 0;

    this.frameUploadBudget = this.warmUpUploadsActive
      ? Math.max(this.budgets.uploadsPerFrame, this.warmUpChunks)
      : this.budgets.uploadsPerFrame;

    const scheduler = this.schedulerOf(context);
    if (scheduler) this.lastScheduler = scheduler;

    // 1. Focus + facing from the active camera.
    const camQuery = context.world.query([Camera, Transform]);
    camQuery.refresh();
    if (camQuery.count > 0) {
      const camId = camQuery.entity(0);
      const camTransform = context.world.getComponent(camId, Transform);
      if (camTransform) {
        // Position from transform storage, not the component's mirror fields: controls move
        // cameras through `entity.transform` (TransformHandle), which writes storage only, so
        // `camTransform.position` stayed at the authored start and streaming never followed the
        // camera. Both write paths update the stored local position, so it is always current.
        context.world.transforms.getPosition(camTransform.transformSlot, this.focusPosition);
        camTransform.forward(this.focusForward);
      }
    }

    // 2. Drain completed worker results into ready tiles (upload-budgeted).
    this.drainCompletions(context);

    // 3. Select + prioritise.
    const selections = this.lod.selectVisibleChunks(this.focusPosition, this.viewDistance);
    const requests = this.prioritize(selections);
    const budget = Math.min(this.budgets.visibleChunks, requests.length);
    const visibleKeys = new Set<string>();
    const needed: StreamingRequest[] = [];
    for (let i = 0; i < budget; i++) {
      const req = requests[i]!;
      const key = chunkCoordKey(req.sel.cx, req.sel.cz);
      visibleKeys.add(key);
      needed.push(req);

      let chunk = this.chunks.get(key);
      const resolution = req.resolution;
      if (!chunk) {
        chunk = new TerrainChunk(req.sel.cx, req.sel.cz, this.chunkSize, resolution, req.sel.lod);
        chunk.skirtDepth = this.skirtDepth;
        this.chunks.set(key, chunk);
      }
      chunk.lastAccessed = performance.now();
      chunk.geomorphAlpha = req.sel.geomorphAlpha;

      // LOD change that alters mesh density → remesh (resolution is the density signal).
      if (chunk.state === "ready" && chunk.resolution !== resolution) {
        this.detachChunkEntity(key, context);
        this.streamingStats.residentBytes -= chunk.residentBytes;
        chunk.tile?.dispose();
        chunk.tile = null;
        chunk.resolution = resolution;
        chunk.lod = req.sel.lod;
        chunk.state = "pending";
        chunk.residentBytes = 0;
      } else if (
        chunk.state === "ready" &&
        chunk.tile &&
        Math.abs(req.sel.geomorphAlpha - chunk.tile.geomorphAlpha) > GEOMORPH_REMESH_EPSILON
      ) {
        // Geomorph bake drifted — remesh from the resident cell (no regen) so seams stay closed.
        // Share the upload budget with drainCompletions; defer remainder to later frames.
        if (this.streamingStats.uploadedThisFrame < this.frameUploadBudget) {
          const cell = chunk.tile.cell;
          this.detachChunkEntity(key, context);
          chunk.lod = req.sel.lod;
          chunk.resolution = resolution;
          chunk.applyCell(cell, req.sel.geomorphAlpha);
          chunk.residentBytes = estimateTileBytes(chunk.resolution);
          this.attachChunkEntity(chunk, context);
        }
      } else if (chunk.state === "generating") {
        chunk.lod = req.sel.lod;
        // In-flight task keeps its submitted resolution; cancel and re-queue if density diverged.
        if (chunk.resolution !== resolution) {
          if (scheduler && chunk.taskKey) {
            scheduler.cancel(chunk.taskKey);
            this.streamingStats.cancelledThisFrame++;
          }
          this.releaseReservedBytes(chunk);
          chunk.taskKey = null;
          chunk.resolution = resolution;
          chunk.state = "pending";
        }
      } else {
        chunk.lod = req.sel.lod;
        chunk.resolution = resolution;
      }
    }

    // 4. Cancel work for chunks that left the visible set (Phase 10.5).
    if (scheduler) {
      for (const [key, chunk] of this.chunks) {
        if (visibleKeys.has(key)) continue;
        if (chunk.state === "generating" && chunk.taskKey) {
          scheduler.cancel(chunk.taskKey);
          this.releaseReservedBytes(chunk);
          chunk.taskKey = null;
          chunk.state = "pending";
          this.streamingStats.cancelledThisFrame++;
        }
      }
    }

    // 5. Budgeted generation — nearest/highest priority first.
    // Warm-up generation is one-shot; upload elevation may continue across a few frames while
    // worker completions drain (Decision B).
    let started = 0;
    const frameBudget = this.warmUpGenerationDone
      ? this.budgets.generationsPerFrame
      : Math.max(this.budgets.generationsPerFrame, this.warmUpChunks);
    this.warmUpGenerationDone = true;

    for (const req of needed) {
      if (started >= frameBudget) break;
      // Memory alone gates new work; visible-chunk count is already applied when building `needed`.
      if (this.streamingStats.residentBytes >= this.budgets.memoryBytes) {
        break;
      }
      const key = chunkCoordKey(req.sel.cx, req.sel.cz);
      const chunk = this.chunks.get(key);
      if (!chunk || chunk.state !== "pending") continue;

      if (this.beginGeneration(chunk, req, context, scheduler)) {
        started++;
      }
    }

    // 6. Evict furthest unneeded chunks under visible + memory budgets.
    this.evict(visibleKeys, context);

    // 7. Horizon skirt around the loaded disc.
    if (this.horizonEnabled) {
      this.updateHorizonSkirt(context, visibleKeys);
    }

    this.maybeFinishWarmUpUploads();

    this.streamingStats.cacheHits = this.cache.hits;
    this.streamingStats.cacheMisses = this.cache.misses;
    this.recomputeResidentBytes();
  }

  private schedulerOf(context: SystemContext): TaskScheduler | undefined {
    return context.services.get<TaskScheduler>("tasks");
  }

  private prioritize(selections: LODSelection[]): StreamingRequest[] {
    const focus = this.focusPosition;
    const forward = this.focusForward;
    const fwdLen = Math.hypot(forward.x, forward.z) || 1;
    const fx = forward.x / fwdLen;
    const fz = forward.z / fwdLen;

    const requests: StreamingRequest[] = selections.map((sel) => {
      const cx = clamp(focus.x, sel.bounds.min.x, sel.bounds.max.x);
      const cz = clamp(focus.z, sel.bounds.min.z, sel.bounds.max.z);
      const dx = cx - focus.x;
      const dz = cz - focus.z;
      const dist = Math.hypot(dx, dz);
      const dirX = dist > 1e-4 ? dx / dist : 0;
      const dirZ = dist > 1e-4 ? dz / dist : 0;
      const facing = dirX * fx + dirZ * fz; // 1 = dead ahead, -1 = behind
      const screenImportance = 1 / (1 + dist * dist / (this.chunkSize * this.chunkSize));
      // Lower score = earlier: distance dominates, then prefer in-front / on-screen, then lower LOD.
      const priority =
        dist -
        facing * this.chunkSize * 0.75 -
        screenImportance * this.chunkSize * 1.5 +
        sel.lod * this.chunkSize * 0.15;
      return {
        sel,
        priority,
        resolution: resolutionForLod(this.chunkResolution, sel.lod),
      };
    });

    requests.sort((a, b) => a.priority - b.priority);
    return requests;
  }

  private beginGeneration(
    chunk: TerrainChunk,
    req: StreamingRequest,
    context: SystemContext,
    scheduler: TaskScheduler | undefined,
  ): boolean {
    const cacheKey = terrainCacheKey({
      seed: this.seed,
      chunkX: chunk.cx,
      chunkZ: chunk.cz,
      generatorVersion: TERRAIN_GENERATOR_VERSION,
      generatorSettings: this.pipelineHash,
      resolution: req.resolution,
    });
    const cached = this.cache.get(cacheKey);
    if (cached) {
      chunk.applyCell(cellFromResult(cached), req.sel.geomorphAlpha);
      chunk.lod = req.sel.lod;
      chunk.residentBytes = estimateTileBytes(chunk.resolution);
      this.streamingStats.residentBytes += chunk.residentBytes;
      this.attachChunkEntity(chunk, context);
      this.streamingStats.generatedThisFrame++;
      this.streamingStats.inlineThisFrame++;
      return true;
    }

    const useWorker = !!scheduler && !this.syncGeneration;
    if (!useWorker) {
      chunk.resolution = req.resolution;
      chunk.lod = req.sel.lod;
      chunk.generate(this.pipeline, this.seed, req.sel.geomorphAlpha);
      this.cacheGenerated(chunk);
      chunk.residentBytes = estimateTileBytes(chunk.resolution);
      this.streamingStats.residentBytes += chunk.residentBytes;
      this.attachChunkEntity(chunk, context);
      this.streamingStats.generatedThisFrame++;
      this.streamingStats.inlineThisFrame++;
      return true;
    }

    if (!this.handlersInstalled) {
      installTerrainTaskHandlers();
      this.handlersInstalled = true;
    }

    const payload = terrainCellPayload(
      this.pipeline,
      this.seed,
      chunk.cx,
      chunk.cz,
      this.chunkSize,
      req.resolution,
    );
    // Unique submit identity: resolution + per-chunk epoch so cancel→resubmit never reuses the
    // scheduler key string. Cancelled catch / then handlers only touch bookkeeping for *this* key.
    chunk.taskEpoch += 1;
    const taskKey = terrainCellKey(chunk.cx, chunk.cz, req.resolution, chunk.taskEpoch);
    chunk.state = "generating";
    chunk.taskKey = taskKey;
    chunk.resolution = req.resolution;
    chunk.lod = req.sel.lod;
    chunk.geomorphAlpha = req.sel.geomorphAlpha;
    // Reserve estimated bytes so the memory gate accounts for in-flight worker generations.
    const reserved = estimateTileBytes(req.resolution);
    chunk.residentBytes = reserved;
    this.streamingStats.residentBytes += reserved;

    const priority = Math.max(
      TaskPriority.Critical,
      Math.min(TaskPriority.Background, TaskPriority.High + Math.floor(req.priority / this.chunkSize) * 10),
    );

    const promise = scheduler!.submit<TerrainCellTaskPayload, TerrainCellTaskResult>({
      name: "terrain.cell",
      key: taskKey,
      payload,
      priority,
    });

    promise
      .then((result) => {
        if (chunk.state === "disposed" || chunk.taskKey !== taskKey) return;
        this.completed.push({
          key: chunk.key,
          result,
          geomorphAlpha: chunk.geomorphAlpha,
          lod: chunk.lod,
          resolution: req.resolution,
        });
      })
      .catch((err) => {
        if (err instanceof TaskCancelledError) {
          // Only clear bookkeeping for *this* submit identity — a replacement may already be in flight.
          if (chunk.taskKey === taskKey) {
            this.releaseReservedBytes(chunk);
            chunk.taskKey = null;
            if (chunk.state === "generating") chunk.state = "pending";
          }
          return;
        }
        // Fall back to inline so a worker failure does not leave a hole.
        if (chunk.state === "generating" && chunk.taskKey === taskKey) {
          chunk.generate(this.pipeline, this.seed, chunk.geomorphAlpha);
          this.cacheGenerated(chunk);
          // Reservation already counted; keep estimate (recomputeResidentBytes reconciles).
          chunk.residentBytes = estimateTileBytes(chunk.resolution);
          this.completed.push({
            key: chunk.key,
            result: this.resultFromChunk(chunk),
            geomorphAlpha: chunk.geomorphAlpha,
            lod: chunk.lod,
            resolution: chunk.resolution,
          });
        }
      });

    this.streamingStats.scheduledThisFrame++;
    return true;
  }

  private resultFromChunk(chunk: TerrainChunk): TerrainCellTaskResult {
    const cell = chunk.tile!.cell;
    return {
      cx: cell.cx,
      cz: cell.cz,
      seed: cell.seed,
      size: cell.size,
      resolution: cell.resolution,
      heights: cell.heights,
      slopes: cell.slopes,
      biomes: cell.biomes,
      scatters: cell.scatters,
      minHeight: chunk.tile!.heightmap.minHeight,
      maxHeight: chunk.tile!.heightmap.maxHeight,
      bytes: cell.heights.byteLength + cell.slopes.byteLength + cell.biomes.byteLength,
      pipelineHash: this.pipelineHash,
    };
  }

  private cacheGenerated(chunk: TerrainChunk): void {
    if (!chunk.tile) return;
    const key = terrainCacheKey({
      seed: this.seed,
      chunkX: chunk.cx,
      chunkZ: chunk.cz,
      generatorVersion: TERRAIN_GENERATOR_VERSION,
      generatorSettings: this.pipelineHash,
      resolution: chunk.resolution,
    });
    this.cache.set(key, this.resultFromChunk(chunk));
  }

  private maybeFinishWarmUpUploads(): void {
    if (!this.warmUpUploadsActive) return;
    let ready = 0;
    let generating = 0;
    for (const chunk of this.chunks.values()) {
      if (chunk.state === "ready") ready++;
      else if (chunk.state === "generating") generating++;
    }
    if (ready >= this.warmUpChunks) {
      this.warmUpUploadsActive = false;
      return;
    }
    // Generation burst already spent and nothing left to drain — stop elevating even if short.
    if (this.warmUpGenerationDone && generating === 0 && this.completed.length === 0) {
      this.warmUpUploadsActive = false;
    }
  }

  private drainCompletions(context: SystemContext): void {
    let uploads = 0;
    while (this.completed.length > 0 && uploads < this.frameUploadBudget) {
      const item = this.completed.shift()!;
      const chunk = this.chunks.get(item.key);
      if (!chunk || chunk.state === "disposed") continue;
      // Already applied inline on error path.
      if (chunk.state === "ready" && chunk.tile) {
        if (!this.activeEntities.has(chunk.key)) {
          this.attachChunkEntity(chunk, context);
          uploads++;
        }
        continue;
      }
      const cacheKey = terrainCacheKey({
        seed: this.seed,
        chunkX: chunk.cx,
        chunkZ: chunk.cz,
        generatorVersion: TERRAIN_GENERATOR_VERSION,
        generatorSettings: this.pipelineHash,
        resolution: item.resolution,
      });
      this.cache.set(cacheKey, item.result);
      chunk.lod = item.lod;
      chunk.applyCell(cellFromResult(item.result), item.geomorphAlpha);
      chunk.residentBytes = estimateTileBytes(chunk.resolution);
      this.attachChunkEntity(chunk, context);
      uploads++;
      this.streamingStats.generatedThisFrame++;
    }
  }

  private evict(visibleKeys: Set<string>, context: SystemContext): void {
    const overCount = this.chunks.size > this.budgets.visibleChunks;
    const overMemory = this.streamingStats.residentBytes > this.budgets.memoryBytes;
    if (!overCount && !overMemory) return;

    const sortedByAccess = Array.from(this.chunks.entries())
      .filter(([k]) => !visibleKeys.has(k))
      .sort((a, b) => a[1].lastAccessed - b[1].lastAccessed);

    while (
      sortedByAccess.length > 0 &&
      (this.chunks.size > this.budgets.visibleChunks || this.streamingStats.residentBytes > this.budgets.memoryBytes)
    ) {
      const [k, c] = sortedByAccess.shift()!;
      this.detachChunkEntity(k, context);
      this.streamingStats.residentBytes -= c.residentBytes;
      c.dispose();
      this.chunks.delete(k);
    }
  }

  private releaseReservedBytes(chunk: TerrainChunk): void {
    if (chunk.residentBytes <= 0) return;
    this.streamingStats.residentBytes = Math.max(0, this.streamingStats.residentBytes - chunk.residentBytes);
    chunk.residentBytes = 0;
  }

  private recomputeResidentBytes(): void {
    let total = 0;
    for (const chunk of this.chunks.values()) total += chunk.residentBytes;
    this.streamingStats.residentBytes = total;
  }

  private updateHorizonSkirt(context: SystemContext, visibleKeys: Set<string>): void {
    if (visibleKeys.size === 0) {
      this.destroyHorizon(context);
      return;
    }

    // Approximate loaded radius from the furthest selected chunk centre.
    let maxDist = 0;
    for (const key of visibleKeys) {
      const chunk = this.chunks.get(key);
      if (!chunk) continue;
      const centerX = (chunk.cx + 0.5) * this.chunkSize;
      const centerZ = (chunk.cz + 0.5) * this.chunkSize;
      const dist = Math.hypot(centerX - this.focusPosition.x, centerZ - this.focusPosition.z);
      if (dist > maxDist) maxDist = dist;
    }
    const radius = maxDist + this.chunkSize * 0.5;
    const cx = this.focusPosition.x;
    const cz = this.focusPosition.z;

    const moved =
      !Number.isFinite(this.horizonCenterX) ||
      Math.hypot(cx - this.horizonCenterX, cz - this.horizonCenterZ) > this.chunkSize * 0.5 ||
      Math.abs(radius - this.horizonRadius) > this.chunkSize * 0.25;
    if (!moved && this.horizonEntityId !== null) return;

    this.horizonCenterX = cx;
    this.horizonCenterZ = cz;
    this.horizonRadius = radius;

    const source = buildHorizonSkirt({
      centerX: cx,
      centerZ: cz,
      innerRadius: radius,
      outerExtent: this.horizonExtent,
      // Resident tiles only — never sync-generate missing cells during skirt rebuild (rim hitch).
      sampleHeight: (x, z) => this.residentHeightAt(x, z),
      dropDepth: Math.max(40, this.chunkSize * 0.5),
      ringSegments: 48,
    });

    this.destroyHorizon(context);

    const engine = this.scene?.engine as { gpu?: GraphicsDevice } | null;
    const device = engine?.gpu;
    const entity = this.scene!.createEntity("terrain_horizon_skirt");
    entity.add(new Transform());
    const r = entity.add(new Renderable());
    r.boundsOverride = source.bounds ?? null;
    r.castShadow = false;
    r.receiveShadow = true;
    if (device) {
      this.horizonGeometry = Geometry.create(device, source);
      r.geometry = this.horizonGeometry;
      r.material = this.material;
    }
    this.horizonEntityId = entity.id;
  }

  private destroyHorizon(context: SystemContext): void {
    if (this.horizonEntityId !== null) {
      context.world.destroyEntity(this.horizonEntityId);
      this.horizonEntityId = null;
    }
    if (this.horizonGeometry) {
      this.horizonGeometry.dispose();
      this.horizonGeometry = null;
    }
  }

  private attachChunkEntity(chunk: TerrainChunk, context: SystemContext): void {
    if (!this.scene || !chunk.tile) return;

    // Replace prior entity if remeshing.
    if (this.activeEntities.has(chunk.key)) {
      this.detachChunkEntity(chunk.key, context);
    }

    const engine = this.scene.engine as { gpu?: GraphicsDevice } | null;
    const device = engine?.gpu;

    const entity = this.scene.createEntity(`terrain_${chunk.cx}_${chunk.cz}`);
    const t = entity.add(new Transform());
    t.setPosition(0, 0, 0);

    const r = entity.add(new Renderable());
    r.boundsOverride = chunk.tile.bounds;
    r.castShadow = true;
    r.receiveShadow = true;

    if (device) {
      r.geometry = chunk.tile.uploadGpu(device);
      if (!this.material) {
        this.material = new Material({
          label: "terrain-mat",
          color: new Color(0.68, 0.44, 0.32, 1.0),
          roughness: 0.88,
          metallic: 0.05,
        });
      }
      r.material = this.material;
    }

    // Single upload accounting point for remesh gating / drainCompletions (device or headless).
    this.streamingStats.uploadedThisFrame++;
    chunk.entityId = entity.id;
    this.activeEntities.set(chunk.key, entity.id);
  }

  private detachChunkEntity(key: string, context: SystemContext): void {
    const entId = this.activeEntities.get(key);
    if (entId !== undefined) {
      context.world.destroyEntity(entId);
      this.activeEntities.delete(key);
    }
    const chunk = this.chunks.get(key);
    if (chunk) chunk.entityId = null;
  }


  /**
   * Height from a resident ready tile only. Falls back to a cheap approx (focus Y) so horizon
   * rebuild never triggers synchronous cell generation for missing chunks.
   */
  private residentHeightAt(worldX: number, worldZ: number): number {
    const key = chunkCoordKey(Math.floor(worldX / this.chunkSize), Math.floor(worldZ / this.chunkSize));
    const hm = this.chunks.get(key)?.tile?.heightmap;
    if (hm) return hm.getHeight(worldX, worldZ);
    return this.focusPosition.y;
  }

  getHeightAt(worldX: number, worldZ: number): number {
    return this.surfaceAt(worldX, worldZ).getHeight(worldX, worldZ);
  }

  getNormalAt(worldX: number, worldZ: number, out = new Vec3()): Vec3 {
    return this.surfaceAt(worldX, worldZ).getNormal(worldX, worldZ, out);
  }

  private surfaceAt(worldX: number, worldZ: number): Heightmap {
    const key = chunkCoordKey(Math.floor(worldX / this.chunkSize), Math.floor(worldZ / this.chunkSize));
    return this.chunks.get(key)?.tile?.heightmap ?? this.sampledHeightmap(worldX, worldZ);
  }

  private sampledHeightmap(worldX: number, worldZ: number): Heightmap {
    const cx = Math.floor(worldX / this.chunkSize);
    const cz = Math.floor(worldZ / this.chunkSize);
    const key = chunkCoordKey(cx, cz);

    const cached = this.sampledCells.get(key);
    if (cached) {
      this.sampledCells.delete(key);
      this.sampledCells.set(key, cached);
      return cached;
    }

    // Prefer the generation cache at full resolution so queries match LOD0 meshes.
    const cacheKey = terrainCacheKey({
      seed: this.seed,
      chunkX: cx,
      chunkZ: cz,
      generatorVersion: TERRAIN_GENERATOR_VERSION,
      generatorSettings: this.pipelineHash,
      resolution: this.chunkResolution,
    });
    const cachedCell = this.cache.get(cacheKey);
    let heights: Float32Array;
    if (cachedCell) {
      heights = cachedCell.heights;
    } else {
      const cell = createWorldCell(cx, cz, this.chunkSize, this.chunkResolution, this.seed);
      this.pipeline.execute(cell);
      heights = cell.heights;
      // Same key as streaming — avoid regenerating this cell when the tile later streams in.
      let minHeight = Infinity;
      let maxHeight = -Infinity;
      for (let i = 0; i < cell.heights.length; i++) {
        const h = cell.heights[i]!;
        if (h < minHeight) minHeight = h;
        if (h > maxHeight) maxHeight = h;
      }
      this.cache.set(cacheKey, {
        cx,
        cz,
        seed: this.seed,
        size: this.chunkSize,
        resolution: this.chunkResolution,
        heights: cell.heights,
        slopes: cell.slopes,
        biomes: cell.biomes,
        scatters: cell.scatters,
        minHeight: Number.isFinite(minHeight) ? minHeight : 0,
        maxHeight: Number.isFinite(maxHeight) ? maxHeight : 0,
        bytes: cell.heights.byteLength + cell.slopes.byteLength + cell.biomes.byteLength,
        pipelineHash: this.pipelineHash,
      });
    }
    const map = new Heightmap({
      originX: cx * this.chunkSize,
      originZ: cz * this.chunkSize,
      size: this.chunkSize,
      resolution: this.chunkResolution,
      heights,
    });
    this.sampledCells.set(key, map);
    if (this.sampledCells.size > SAMPLED_CELL_CACHE_SIZE) {
      const oldest = this.sampledCells.keys().next().value;
      if (oldest !== undefined) this.sampledCells.delete(oldest);
    }
    return map;
  }

  getSlopeAt(worldX: number, worldZ: number): number {
    const norm = this.getNormalAt(worldX, worldZ);
    return Math.acos(Math.max(-1, Math.min(1, norm.y)));
  }

  override raycast(ray: Ray, hit: RayHit): boolean {
    let closestDist = Infinity;
    let hitFound = false;
    const tempHit = new RayHit();

    for (const chunk of this.chunks.values()) {
      if (chunk.tile && chunk.tile.bounds.intersectsRay(ray.origin, ray.invDirection, new Float32Array([0, ray.maxDistance]))) {
        tempHit.reset();
        if (chunk.tile.heightmap.raycast(ray, tempHit)) {
          if (tempHit.distance < closestDist) {
            closestDist = tempHit.distance;
            hit.distance = tempHit.distance;
            hit.point.copyFrom(tempHit.point);
            hit.normal.copyFrom(tempHit.normal);
            hit.isValid = true;
            hitFound = true;
          }
        }
      }
    }

    return hitFound;
  }

  override stats(): Record<string, string | number | boolean> {
    return {
      chunks: this.chunks.size,
      residentBytes: this.streamingStats.residentBytes,
      generatedThisFrame: this.streamingStats.generatedThisFrame,
      scheduledThisFrame: this.streamingStats.scheduledThisFrame,
      cancelledThisFrame: this.streamingStats.cancelledThisFrame,
      cacheHits: this.streamingStats.cacheHits,
      cacheMisses: this.streamingStats.cacheMisses,
    };
  }

  override dispose(): void {
    const scheduler = this.lastScheduler;
    for (const chunk of this.chunks.values()) {
      if (scheduler && chunk.taskKey) {
        scheduler.cancel(chunk.taskKey);
      }
      chunk.dispose();
    }
    this.chunks.clear();
    this.activeEntities.clear();
    this.sampledCells.clear();
    this.completed.length = 0;
    this.lastScheduler = undefined;
    if (this.horizonGeometry) {
      this.horizonGeometry.dispose();
      this.horizonGeometry = null;
    }
    this.horizonEntityId = null;
    if (this.material) {
      this.material.dispose();
      this.material = null;
    }
  }
}
