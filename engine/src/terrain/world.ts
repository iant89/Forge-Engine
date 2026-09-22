/**
 * `TerrainWorld` — chunk manager, procedural streaming, LOD, and height query engine.
 *
 * Implements:
 *  - Procedural streaming centred on the camera / focus position
 *  - Guaranteed continuous height & normal sampling anywhere in the world, matching the drawn mesh
 *  - Nearest-first generation and LRU eviction bounded by `maxChunksLoaded`, so the resident set and
 *    the per-frame generation cost stay inside the configured budget
 *  - Seamless integration with `Scene` and `EntityWorld`
 *
 * `viewDistance` is advisory: the selection is capped at `maxChunksLoaded` chunks by distance from
 * the focus, so a budget smaller than the view distance shows a smaller loaded radius instead of
 * growing without bound.
 */

import { SceneObject, type Scene } from "../scene/scene.js";
import { type SystemContext } from "../scene/systems.js";
import { TerrainChunk, chunkKey } from "./chunk.js";
import { Heightmap } from "./heightmap.js";
import { TerrainLOD, type LODSelection } from "./lod.js";
import { GeneratorPipeline, HeightGenerator, createWorldCell, type HeightGeneratorOptions } from "./generators.js";
import { Material } from "../rendering/material.js";
import { Transform, Renderable, Camera } from "../scene/components/index.js";
import { Vec3 } from "../math/vec.js";
import { clamp } from "../math/scalar.js";
import { Color } from "../math/color.js";
import { Ray, RayHit } from "../math/geometry.js";
import type { EntityId } from "../scene/entityId.js";
import type { GraphicsDevice } from "../gpu/device.js";

export interface TerrainWorldOptions {
  seed?: number;
  chunkSize?: number;
  chunkResolution?: number;
  viewDistance?: number;
  maxLOD?: number;
  maxChunksLoaded?: number;
  maxGenerationsPerFrame?: number;
  pipeline?: GeneratorPipeline;
  heightOptions?: HeightGeneratorOptions;
  material?: Material;
}

/** How many non-resident cells `sampledHeightmap` keeps cached. */
const SAMPLED_CELL_CACHE_SIZE = 12;

export class TerrainWorld extends SceneObject {
  readonly name = "TerrainWorld";

  readonly seed: number;
  readonly chunkSize: number;
  readonly chunkResolution: number;
  readonly viewDistance: number;
  readonly maxLOD: number;
  readonly maxChunksLoaded: number;
  readonly maxGenerationsPerFrame: number;

  readonly pipeline: GeneratorPipeline;
  readonly heightGenerator: HeightGenerator;
  readonly lod: TerrainLOD;

  readonly chunks = new Map<string, TerrainChunk>();
  readonly activeEntities = new Map<string, EntityId>();

  readonly focusPosition = new Vec3();
  material: Material | null = null;

  /**
   * Heightmaps for chunks that are not resident, so an elevation query outside the resident set
   * still answers with the surface that would be drawn there (see `sampledHeightmap`). LRU-capped:
   * a query far away costs one cell generation and is then cached.
   */
  private readonly sampledCells = new Map<string, Heightmap>();

  constructor(options: TerrainWorldOptions = {}) {
    super();
    this.seed = options.seed ?? 1234;
    this.chunkSize = options.chunkSize ?? 256;
    this.chunkResolution = options.chunkResolution ?? 33;
    this.viewDistance = options.viewDistance ?? 1024;
    this.maxLOD = options.maxLOD ?? 3;
    this.maxChunksLoaded = options.maxChunksLoaded ?? 64;
    this.maxGenerationsPerFrame = options.maxGenerationsPerFrame ?? 4;

    this.heightGenerator = new HeightGenerator(options.heightOptions);
    this.pipeline = options.pipeline ?? GeneratorPipeline.createDefault(this.seed, options.heightOptions);

    const lodDistances = [
      this.chunkSize * 1.5,
      this.chunkSize * 3.0,
      this.chunkSize * 6.0,
      this.chunkSize * 12.0,
    ];
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

    // 1. Determine focus position from active camera in scene
    const camQuery = context.world.query([Camera, Transform]);
    camQuery.refresh();
    if (camQuery.count > 0) {
      const camId = camQuery.entity(0);
      const camTransform = context.world.getComponent(camId, Transform);
      if (camTransform) {
        this.focusPosition.copyFrom(camTransform.position);
      }
    }

    // 2. Select chunks in view, nearest first, and stop at the memory budget.
    //
    //    The budget is what keeps the "view distance" honest: the candidate set grows with the square
    //    of the view distance (2048 m over 128 m chunks selects ~900 chunks), and eviction can never
    //    drop a *selected* chunk, so without a cap the resident set grew without bound — every frame
    //    spending its generation budget on chunks that were queued in scan order rather than in the
    //    order the camera needed them, including the chunk directly under the camera.
    const selections = this.lod.selectVisibleChunks(this.focusPosition, this.viewDistance);
    const focus = this.focusPosition;
    selections.sort((a, b) => {
      const ax = clamp(focus.x, a.bounds.min.x, a.bounds.max.x) - focus.x;
      const az = clamp(focus.z, a.bounds.min.z, a.bounds.max.z) - focus.z;
      const bx = clamp(focus.x, b.bounds.min.x, b.bounds.max.x) - focus.x;
      const bz = clamp(focus.z, b.bounds.min.z, b.bounds.max.z) - focus.z;
      return ax * ax + az * az - (bx * bx + bz * bz);
    });

    const budget = Math.min(this.maxChunksLoaded, selections.length);
    const visibleKeys = new Set<string>();
    const needed: LODSelection[] = [];
    for (let i = 0; i < budget; i++) {
      const sel = selections[i]!;
      const key = chunkKey(sel.cx, sel.cz, 0); // Level 0 resolution for main geometry
      visibleKeys.add(key);
      needed.push(sel);

      let chunk = this.chunks.get(key);
      if (!chunk) {
        chunk = new TerrainChunk(sel.cx, sel.cz, this.chunkSize, this.chunkResolution, sel.lod);
        this.chunks.set(key, chunk);
      }
      chunk.lastAccessed = performance.now();
    }

    // 3. Process budgeted generations — the nearest pending chunk is always the next one generated.
    let generatedThisFrame = 0;
    for (const sel of needed) {
      if (generatedThisFrame >= this.maxGenerationsPerFrame) break;
      const chunk = this.chunks.get(chunkKey(sel.cx, sel.cz, 0));
      if (chunk && chunk.state === "pending") {
        chunk.generate(this.pipeline, this.seed);
        this.attachChunkEntity(chunk, context);
        generatedThisFrame++;
      }
    }

    // 4. Memory budget / eviction: evict furthest unneeded chunks
    if (this.chunks.size > this.maxChunksLoaded) {
      const sortedByAccess = Array.from(this.chunks.entries())
        .filter(([k]) => !visibleKeys.has(k))
        .sort((a, b) => a[1].lastAccessed - b[1].lastAccessed);

      while (this.chunks.size > this.maxChunksLoaded && sortedByAccess.length > 0) {
        const [k, c] = sortedByAccess.shift()!;
        this.detachChunkEntity(k, context);
        c.dispose();
        this.chunks.delete(k);
      }
    }
  }

  private attachChunkEntity(chunk: TerrainChunk, _context: SystemContext): void {
    if (!this.scene || !chunk.tile) return;

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

    chunk.entityId = entity.id;
    this.activeEntities.set(chunk.key, entity.id);
  }

  private detachChunkEntity(key: string, context: SystemContext): void {
    const entId = this.activeEntities.get(key);
    if (entId !== undefined) {
      context.world.destroyEntity(entId);
      this.activeEntities.delete(key);
    }
  }

  /**
   * Continuous elevation query at world coordinates (worldX, worldZ).
   *
   * Samples the resident chunk's bicubic heightmap when there is one; otherwise runs the generation
   * pipeline for the chunk that contains the point (cached, see `sampledHeightmap`). Either way the
   * answer is the surface the meshes are built from, so a caller that stands a camera or a physics
   * body on it lands on what is drawn — the pipeline's crater and erosion stages used to be skipped
   * by this query, which put the answer up to ~20 m away from the mesh in a crater.
   */
  getHeightAt(worldX: number, worldZ: number): number {
    return this.surfaceAt(worldX, worldZ).getHeight(worldX, worldZ);
  }

  /**
   * Continuous surface normal query at world coordinates (worldX, worldZ).
   */
  getNormalAt(worldX: number, worldZ: number, out = new Vec3()): Vec3 {
    return this.surfaceAt(worldX, worldZ).getNormal(worldX, worldZ, out);
  }

  /** Resident chunk heightmap when there is one, otherwise the generated-on-demand cell. */
  private surfaceAt(worldX: number, worldZ: number): Heightmap {
    const key = chunkKey(Math.floor(worldX / this.chunkSize), Math.floor(worldZ / this.chunkSize), 0);
    return this.chunks.get(key)?.tile?.heightmap ?? this.sampledHeightmap(worldX, worldZ);
  }

  /**
   * Heightmap of the chunk containing `worldX/worldZ`, generated on demand with the same pipeline and
   * grid resolution the mesh uses. Cells are cached (LRU) because this costs a cell generation; a
   * streaming chunk replaces them as soon as it is resident.
   */
  private sampledHeightmap(worldX: number, worldZ: number): Heightmap {
    const cx = Math.floor(worldX / this.chunkSize);
    const cz = Math.floor(worldZ / this.chunkSize);
    const key = chunkKey(cx, cz, 0);

    const cached = this.sampledCells.get(key);
    if (cached) {
      // Re-insert to mark it as the most recently used entry.
      this.sampledCells.delete(key);
      this.sampledCells.set(key, cached);
      return cached;
    }

    const cell = createWorldCell(cx, cz, this.chunkSize, this.chunkResolution, this.seed);
    this.pipeline.execute(cell);
    const map = new Heightmap({
      originX: cx * this.chunkSize,
      originZ: cz * this.chunkSize,
      size: this.chunkSize,
      resolution: this.chunkResolution,
      heights: cell.heights,
    });
    this.sampledCells.set(key, map);
    if (this.sampledCells.size > SAMPLED_CELL_CACHE_SIZE) {
      const oldest = this.sampledCells.keys().next().value;
      if (oldest !== undefined) this.sampledCells.delete(oldest);
    }
    return map;
  }

  /**
   * Surface slope angle in radians [0, pi/2].
   */
  getSlopeAt(worldX: number, worldZ: number): number {
    const norm = this.getNormalAt(worldX, worldZ);
    return Math.acos(Math.max(-1, Math.min(1, norm.y)));
  }

  /**
   * Raycast against loaded terrain chunks.
   */
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

  override dispose(): void {
    for (const chunk of this.chunks.values()) {
      chunk.dispose();
    }
    this.chunks.clear();
    this.activeEntities.clear();
    this.sampledCells.clear();
    if (this.material) {
      this.material.dispose();
      this.material = null;
    }
  }
}
