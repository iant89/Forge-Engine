/**
 * `TerrainWorld` — chunk manager, procedural streaming, LOD, and height query engine.
 *
 * Implements:
 *  - Infinite procedural streaming centered around the camera / focus position
 *  - Guaranteed continuous height & normal sampling anywhere in the world
 *  - Budgeted chunk generation with LRU memory eviction
 *  - Seamless integration with `Scene` and `EntityWorld`
 */

import { SceneObject, type Scene } from "../scene/scene.js";
import { type SystemContext } from "../scene/systems.js";
import { TerrainChunk, chunkKey } from "./chunk.js";
import { TerrainLOD } from "./lod.js";
import { GeneratorPipeline, HeightGenerator, type HeightGeneratorOptions } from "./generators.js";
import { Material } from "../rendering/material.js";
import { Transform, Renderable, Camera } from "../scene/components/index.js";
import { Vec3 } from "../math/vec.js";
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
  private pendingQueue: { cx: number; cz: number; lod: number }[] = [];

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

    // 2. Select chunks in view
    const selections = this.lod.selectVisibleChunks(this.focusPosition, this.viewDistance);
    const visibleKeys = new Set<string>();

    for (const sel of selections) {
      const key = chunkKey(sel.cx, sel.cz, 0); // Level 0 resolution for main geometry
      visibleKeys.add(key);

      let chunk = this.chunks.get(key);
      if (!chunk) {
        chunk = new TerrainChunk(sel.cx, sel.cz, this.chunkSize, this.chunkResolution, sel.lod);
        this.chunks.set(key, chunk);
        this.pendingQueue.push({ cx: sel.cx, cz: sel.cz, lod: sel.lod });
      }
      chunk.lastAccessed = performance.now();
    }

    // 3. Process budgeted generations
    let generatedThisFrame = 0;
    while (this.pendingQueue.length > 0 && generatedThisFrame < this.maxGenerationsPerFrame) {
      const next = this.pendingQueue.shift()!;
      const key = chunkKey(next.cx, next.cz, 0);
      const chunk = this.chunks.get(key);
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
   * If the corresponding chunk is loaded, samples its bicubic heightmap.
   * If outside loaded chunks, evaluates the pure deterministic generator function.
   */
  getHeightAt(worldX: number, worldZ: number): number {
    const cx = Math.floor(worldX / this.chunkSize);
    const cz = Math.floor(worldZ / this.chunkSize);
    const key = chunkKey(cx, cz, 0);
    const chunk = this.chunks.get(key);

    if (chunk?.tile) {
      return chunk.tile.heightmap.getHeight(worldX, worldZ);
    }
    return this.heightGenerator.sampleHeight(worldX, worldZ, this.seed);
  }

  /**
   * Continuous surface normal query at world coordinates (worldX, worldZ).
   */
  getNormalAt(worldX: number, worldZ: number, out = new Vec3()): Vec3 {
    const cx = Math.floor(worldX / this.chunkSize);
    const cz = Math.floor(worldZ / this.chunkSize);
    const key = chunkKey(cx, cz, 0);
    const chunk = this.chunks.get(key);

    if (chunk?.tile) {
      return chunk.tile.heightmap.getNormal(worldX, worldZ, out);
    }

    // Finite difference on pure generator function
    const eps = 1.0;
    const hL = this.heightGenerator.sampleHeight(worldX - eps, worldZ, this.seed);
    const hR = this.heightGenerator.sampleHeight(worldX + eps, worldZ, this.seed);
    const hD = this.heightGenerator.sampleHeight(worldX, worldZ - eps, this.seed);
    const hU = this.heightGenerator.sampleHeight(worldX, worldZ + eps, this.seed);

    const dx = (hR - hL) / (2 * eps);
    const dz = (hU - hD) / (2 * eps);

    out.set(-dx, 1, -dz);
    return out.normalize();
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
    this.pendingQueue.length = 0;
    if (this.material) {
      this.material.dispose();
      this.material = null;
    }
  }
}
