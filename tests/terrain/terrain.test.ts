/**
 * @suite terrain:terrain
 * @group unit
 * @covers engine/src/core/log.ts
 * @covers engine/src/core/tasks/scheduler.ts
 * @covers engine/src/core/time.ts
 * @covers engine/src/debug/profiler.ts
 * @covers engine/src/index.ts
 * @covers engine/src/math/geometry.ts
 * @covers engine/src/math/vec.ts
 * @covers engine/src/scene/components/index.ts
 * @covers engine/src/scene/scene.ts
 * @covers engine/src/scene/systems.ts
 * @covers engine/src/scene/world.ts
 * @covers engine/src/terrain/budget.ts
 * @covers engine/src/terrain/cache.ts
 * @covers engine/src/terrain/chunk.ts
 * @covers engine/src/terrain/generators.ts
 * @covers engine/src/terrain/heightmap.ts
 * @covers engine/src/terrain/horizon.ts
 * @covers engine/src/terrain/lod.ts
 * @covers engine/src/terrain/material.ts
 * @covers engine/src/terrain/tasks.ts
 * @covers engine/src/terrain/world.ts
 * @desc Pins terrain behavior and regression guarantees
 */

export const suite = {
  name: "terrain:terrain",
  group: "unit",
  covers:   [
    "engine/src/core/log.ts",
    "engine/src/core/tasks/scheduler.ts",
    "engine/src/core/time.ts",
    "engine/src/debug/profiler.ts",
    "engine/src/index.ts",
    "engine/src/math/geometry.ts",
    "engine/src/math/vec.ts",
    "engine/src/scene/components/index.ts",
    "engine/src/scene/scene.ts",
    "engine/src/scene/systems.ts",
    "engine/src/scene/world.ts",
    "engine/src/terrain/budget.ts",
    "engine/src/terrain/cache.ts",
    "engine/src/terrain/chunk.ts",
    "engine/src/terrain/generators.ts",
    "engine/src/terrain/heightmap.ts",
    "engine/src/terrain/horizon.ts",
    "engine/src/terrain/lod.ts",
    "engine/src/terrain/material.ts",
    "engine/src/terrain/tasks.ts",
    "engine/src/terrain/world.ts"
  ],
  desc: "Pins terrain behavior and regression guarantees",
};
import assert from "node:assert/strict";
import { assertCloseTo, assertContains, finish, group, test } from "selrun";
import {
  Heightmap,
  HeightGenerator,
  CraterGenerator,
  GeneratorPipeline,
  TerrainTile,
  TerrainWorld,
  TerrainLOD,
  resolutionForLod,
  geomorphHeight,
  TerrainGenerationCache,
  terrainCacheKey,
  TERRAIN_GENERATOR_VERSION,
  terrainCellPayload,
  generateTerrainCell,
  installTerrainTaskHandlers,
  buildHorizonSkirt,
  LayeredTerrainMaterial,
  estimateTileBytes,
  terrainCellKey,
  TaskScheduler,
  Vec3,
  Ray,
  RayHit,
  Scene,
  Camera,
  Transform,
  EntityWorld,
  Clock,
  Logger,
  Profiler,
  SystemScratch,
  type SystemContext,
} from "@forge/engine";

function createMockContext(world: EntityWorld): SystemContext {
  return {
    world,
    clock: new Clock(),
    dt: 0.016,
    fixedDt: 0.016,
    fixedSteps: 1,
    alpha: 0,
    elapsed: 0,
    frame: 1,
    logger: new Logger(),
    profiler: new Profiler(),
    services: { get: () => undefined, engineConfig: {} },
    scratch: new SystemScratch(),
  };
}

group("Terrain - Procedural Generation & Determinism", () => {
  test("generates bit-for-bit identical heightmaps for the same seed and chunk coordinates", () => {
    const pipe = GeneratorPipeline.createDefault(42);
    const tile1 = new TerrainTile({ cx: 3, cz: -5, size: 128, resolution: 33 }, pipe, 42);
    const tile2 = new TerrainTile({ cx: 3, cz: -5, size: 128, resolution: 33 }, pipe, 42);

    assert.equal(tile1.cell.heights.length, tile2.cell.heights.length);
    for (let i = 0; i < tile1.cell.heights.length; i++) {
      assert.equal(tile1.cell.heights[i], tile2.cell.heights[i]);
    }

    // Different seed produces different heightfield
    const tileDiffSeed = new TerrainTile({ cx: 3, cz: -5, size: 128, resolution: 33 }, pipe, 9999);
    let differences = 0;
    for (let i = 0; i < tile1.cell.heights.length; i++) {
      if (tile1.cell.heights[i] !== tileDiffSeed.cell.heights[i]) {
        differences++;
      }
    }
    assert.ok(differences > tile1.cell.heights.length * 0.9);
  });

  test("ensures seamless elevation continuity across chunk boundaries", () => {
    const pipe = new GeneratorPipeline().addStage(new HeightGenerator());
    const res = 33;
    const size = 128;
    const tile00 = new TerrainTile({ cx: 0, cz: 0, size, resolution: res }, pipe, 100);
    const tile10 = new TerrainTile({ cx: 1, cz: 0, size, resolution: res }, pipe, 100);

    // Right edge of tile (0, 0) should equal left edge of tile (1, 0)
    for (let j = 0; j < res; j++) {
      const rightEdge00 = tile00.cell.heights[j * res + (res - 1)]!;
      const leftEdge10 = tile10.cell.heights[j * res + 0]!;
      assert.ok(Math.abs(rightEdge00 - leftEdge10) < 1e-4);
    }
  });

  test("crater generator creates depressions and uplifted rims", () => {
    const res = 33;
    const size = 128;
    const count = res * res;
    const heights = new Float32Array(count).fill(50); // flat ground at 50m

    const cell = {
      cx: 0,
      cz: 0,
      size,
      resolution: res,
      seed: 12345,
      heights,
      slopes: new Float32Array(count),
      biomes: new Float32Array(count * 4),
      scatters: [],
    };

    const craterGen = new CraterGenerator({ density: 1.0, minRadius: 25, maxRadius: 25 });
    craterGen.process(cell);

    let minH = Infinity;
    let maxH = -Infinity;
    for (const h of heights) {
      if (h < minH) minH = h;
      if (h > maxH) maxH = h;
    }

    // Should have excavated below 50m in the bowl
    assert.ok(minH < 50);
    // Should have uplifted above 50m along the rim
    assert.ok(maxH > 50);
  });

  test("scatter generator places props on acceptable slopes", () => {
    const pipe = GeneratorPipeline.createDefault(54321);
    const tile = new TerrainTile({ cx: 1, cz: 2, size: 256, resolution: 33 }, pipe, 54321);

    assert.ok(tile.cell.scatters.length > 0);
    for (const s of tile.cell.scatters) {
      // Must be within chunk bounds
      assert.ok(s.x >= 256);
      assert.ok(s.x <= 512);
      assert.ok(s.z >= 512);
      assert.ok(s.z <= 768);
      assert.ok(s.scale > 0);
    }
  });
});

group("Terrain - Heightmap and Continuous Sampling", () => {
  test("interpolates continuous elevations and normal vectors", () => {
    const res = 9;
    const size = 32;
    const heights = new Float32Array(res * res);
    // Create an inclined plane: h = 2 * x + 1 * z
    for (let j = 0; j < res; j++) {
      for (let i = 0; i < res; i++) {
        const x = (i / (res - 1)) * size;
        const z = (j / (res - 1)) * size;
        heights[j * res + i] = 2 * x + 1 * z;
      }
    }

    const hm = new Heightmap({ size, resolution: res, heights });

    // Exact grid sample check
    assertCloseTo(hm.getHeight(0, 0), 0, 2);
    assertCloseTo(hm.getHeight(size, 0), 2 * size, 2);
    assertCloseTo(hm.getHeight(0, size), 1 * size, 2);

    // Continuous midpoint sample
    const midH = hm.getHeight(size * 0.5, size * 0.5);
    assertCloseTo(midH, 2 * (size * 0.5) + 1 * (size * 0.5), 1);

    // Normal vector check: normal of plane z + 2x - y = 0 is (-2, 1, -1) normalized
    const normal = hm.getNormal(size * 0.5, size * 0.5);
    assertCloseTo(normal.length(), 1.0, 2);
    assert.ok(normal.y > 0);
  });

  test("raycasts against heightmap surface and returns exact intersection point", () => {
    const res = 17;
    const size = 64;
    const heights = new Float32Array(res * res).fill(10); // flat ground at y = 10
    const hm = new Heightmap({ size, resolution: res, heights });

    const ray = new Ray(new Vec3(32, 50, 32), new Vec3(0, -1, 0), 100);
    const hit = new RayHit();

    assert.equal(hm.raycast(ray, hit), true);
    assert.equal(hit.isValid, true);
    assertCloseTo(hit.point.x, 32, 2);
    assertCloseTo(hit.point.y, 10, 1);
    assertCloseTo(hit.point.z, 32, 2);
    assertCloseTo(hit.distance, 40, 1);

    // Ray shooting away from terrain
    const awayRay = new Ray(new Vec3(32, 50, 32), new Vec3(0, 1, 0), 100);
    const awayHit = new RayHit();
    assert.equal(hm.raycast(awayRay, awayHit), false);
  });
});

group("Terrain - LOD and Streaming Budget", () => {
  test("evaluates LOD level and geomorph alpha across distance bands", () => {
    const lod = new TerrainLOD({
      baseChunkSize: 100,
      maxLOD: 3,
      lodDistances: [200, 400, 800],
      transitionWidth: 0.2, // transition at [160, 200]
    });

    // Close: LOD 0, no geomorph
    const close = lod.evaluateDistance(50);
    assert.equal(close.lod, 0);
    assert.equal(close.alpha, 0);

    // In transition band [160, 200]
    const mid = lod.evaluateDistance(180);
    assert.equal(mid.lod, 0);
    assertCloseTo(mid.alpha, 0.5, 1);

    // Far: LOD 1
    const far = lod.evaluateDistance(250);
    assert.equal(far.lod, 1);
  });

  test("enforces max chunk memory budget through LRU eviction", () => {
    const world = new EntityWorld();
    const terrain = new TerrainWorld({
      chunkSize: 64,
      chunkResolution: 9,
      viewDistance: 80,
      maxChunksLoaded: 9,
      maxGenerationsPerFrame: 16,
    });

    const ctx = createMockContext(world);

    // Camera at origin
    terrain.focusPosition.set(0, 0, 0);
    terrain.update(ctx, 0.016);

    const initialLoaded = terrain.chunks.size;
    assert.ok(initialLoaded <= 9);

    // Move camera 5000 meters away
    terrain.focusPosition.set(5000, 0, 5000);
    terrain.update(ctx, 0.016);

    // Total chunks must still stay within maxChunksLoaded
    assert.ok(terrain.chunks.size <= 9);

    terrain.dispose();
    world.dispose();
  });

  test("warms up the opening view in one burst, then returns to the steady budget", () => {
    const world = new EntityWorld();
    const terrain = new TerrainWorld({
      chunkSize: 64,
      chunkResolution: 9,
      viewDistance: 80,
      maxChunksLoaded: 9,
      maxGenerationsPerFrame: 1,
      warmUpChunks: 7,
    });
    const ctx = createMockContext(world);
    // `TerrainWorld.update` no-ops until the object is attached to a scene (it needs the scene's
    // entity world to attach chunk entities), so add it the way a demo does. A camera entity both
    // registers the component stores the focus query needs and pins the focus at the origin.
    const scene = new Scene({ name: "warmup-test" });
    scene.add(terrain);
    const cameraEntity = world.createEntity("camera");
    cameraEntity.add(new Camera());
    cameraEntity.add(new Transform());
    terrain.focusPosition.set(0, 0, 0);

    terrain.update(ctx, 0.016);
    const readyFirst = [...terrain.chunks.values()].filter((c) => c.state === "ready").length;
    assert.ok(readyFirst >= 7);

    terrain.update(ctx, 0.016);
    const readySecond = [...terrain.chunks.values()].filter((c) => c.state === "ready").length;
    // The allowance is one-shot: after the first update only maxGenerationsPerFrame remains.
    assert.ok(readySecond - readyFirst <= 1);

    scene.dispose();
    world.dispose();
  });
});

group("Terrain - Phase 10 LOD meshes", () => {
  test("resolutionForLod nests odd grids 33→17→9→5→3", () => {
    assert.equal(resolutionForLod(33, 0), 33);
    assert.equal(resolutionForLod(33, 1), 17);
    assert.equal(resolutionForLod(33, 2), 9);
    assert.equal(resolutionForLod(33, 3), 5);
    assert.equal(resolutionForLod(33, 4), 3);
  });

  test("builds lower-resolution meshes from chunk.lod", () => {
    const pipe = GeneratorPipeline.createDefault(7);
    const lod0 = new TerrainTile({ cx: 0, cz: 0, size: 128, resolution: resolutionForLod(33, 0), lod: 0 }, pipe, 7);
    const lod2 = new TerrainTile({ cx: 0, cz: 0, size: 128, resolution: resolutionForLod(33, 2), lod: 2 }, pipe, 7);
    assert.equal(lod0.gridVertexCount, 33 * 33);
    assert.equal(lod2.gridVertexCount, 9 * 9);
    assert.ok(lod2.gridVertexCount < lod0.gridVertexCount);
  });

  test("applies geomorphing to vertex positions toward the coarser lattice", () => {
    const fine = geomorphHeight(new Float32Array([0, 10, 0, 10, 20, 10, 0, 10, 0]), 3, 1, 0, 0);
    const morph = geomorphHeight(new Float32Array([0, 10, 0, 10, 20, 10, 0, 10, 0]), 3, 1, 0, 1);
    // Index (1,0) sits between coarse parents (0,0)=0 and (2,0)=0 → morphs to 0.
    assert.equal(fine, 10);
    assert.equal(morph, 0);
    const half = geomorphHeight(new Float32Array([0, 10, 0, 10, 20, 10, 0, 10, 0]), 3, 1, 0, 0.5);
    assert.equal(half, 5);
  });

  test("streaming world generates LOD-dependent geometry complexity", () => {
    const world = new EntityWorld();
    const terrain = new TerrainWorld({
      chunkSize: 64,
      chunkResolution: 33,
      viewDistance: 400,
      maxChunksLoaded: 25,
      maxGenerationsPerFrame: 32,
      warmUpChunks: 25,
      horizonSkirt: false,
      syncGeneration: true,
      maxLOD: 4,
    });
    const ctx = createMockContext(world);
    const scene = new Scene({ name: "lod-mesh-test" });
    scene.add(terrain);
    const cameraEntity = world.createEntity("camera");
    cameraEntity.add(new Camera());
    const camT = cameraEntity.add(new Transform());
    camT.setPosition(0, 20, 0);
    terrain.focusPosition.set(0, 20, 0);

    terrain.update(ctx, 0.016);
    const ready = [...terrain.chunks.values()].filter((c) => c.state === "ready" && c.tile);
    assert.ok(ready.length > 0);
    const resolutions = new Set(ready.map((c) => c.tile!.resolution));
    // Near + far selections should produce more than one mesh density.
    assert.ok(resolutions.size > 1);
    assert.ok(Math.min(...resolutions) < 33);

    scene.dispose();
    world.dispose();
  });
});

group("Terrain - Phase 10 cache, priority, workers, horizon, materials", () => {
  test("caches generated cells by seed/chunk/version/settings/resolution", () => {
    const cache = new TerrainGenerationCache({ maxEntries: 8, maxBytes: 1 << 20 });
    const pipe = GeneratorPipeline.createDefault(99);
    const payload = terrainCellPayload(pipe, 99, 2, -1, 64, 9);
    const result = generateTerrainCell(payload);
    const key = terrainCacheKey({
      seed: 99,
      chunkX: 2,
      chunkZ: -1,
      generatorVersion: TERRAIN_GENERATOR_VERSION,
      generatorSettings: result.pipelineHash,
      resolution: 9,
    });
    cache.set(key, result);
    assert.equal(cache.get(key)?.heights, result.heights);
    assert.equal(cache.hits, 1);
    assert.equal(cache.get(key + "|missing"), undefined);
    assert.equal(cache.misses, 1);
  });

  test("schedules chunk generation through TaskScheduler and does not block the update call", async () => {
    installTerrainTaskHandlers();
    const scheduler = new TaskScheduler({ inline: true, workerCount: 0 });
    const world = new EntityWorld();
    const terrain = new TerrainWorld({
      chunkSize: 64,
      chunkResolution: 9,
      viewDistance: 80,
      maxChunksLoaded: 9,
      maxGenerationsPerFrame: 4,
      horizonSkirt: false,
      syncGeneration: false,
    });
    const services: SystemContext["services"] = {
      get: <T>(key: string) => (key === "tasks" ? (scheduler as unknown as T) : undefined),
      engineConfig: {},
    };
    const ctx: SystemContext = { ...createMockContext(world), services };
    const scene = new Scene({ name: "worker-stream-test" });
    scene.add(terrain);
    const cameraEntity = world.createEntity("camera");
    cameraEntity.add(new Camera());
    cameraEntity.add(new Transform());

    terrain.update(ctx, 0.016);
    assert.ok(terrain.streamingStats.scheduledThisFrame > 0);
    const generating = [...terrain.chunks.values()].filter((c) => c.state === "generating");
    assert.ok(generating.length > 0);

    await scheduler.drain();
    // Completions land in the next update's drain.
    terrain.update(ctx, 0.016);
    const ready = [...terrain.chunks.values()].filter((c) => c.state === "ready");
    assert.ok(ready.length > 0);

    scheduler.dispose();
    scene.dispose();
    world.dispose();
  });

  test("warm-up with scheduler fills the disc without dozens of uploadsPerFrame=4 frames", async () => {
    installTerrainTaskHandlers();
    const scheduler = new TaskScheduler({ inline: true, workerCount: 0 });
    const world = new EntityWorld();
    const warmUpChunks = 12;
    const uploadsPerFrame = 4;
    const terrain = new TerrainWorld({
      chunkSize: 64,
      chunkResolution: 9,
      viewDistance: 200,
      maxChunksLoaded: 16,
      generationsPerFrame: 2,
      uploadsPerFrame,
      warmUpChunks,
      horizonSkirt: false,
      syncGeneration: false,
    });
    const services: SystemContext["services"] = {
      get: <T>(key: string) => (key === "tasks" ? (scheduler as unknown as T) : undefined),
      engineConfig: {},
    };
    const ctx: SystemContext = { ...createMockContext(world), services };
    const scene = new Scene({ name: "warmup-upload-budget" });
    scene.add(terrain);
    const cameraEntity = world.createEntity("camera");
    cameraEntity.add(new Camera());
    cameraEntity.add(new Transform());
    terrain.focusPosition.set(0, 0, 0);

    // Frame 1: schedule the warm-up burst on the worker path (not sync).
    terrain.update(ctx, 0.016);
    assert.ok(terrain.streamingStats.scheduledThisFrame >= warmUpChunks);
    assert.equal([...terrain.chunks.values()].some((c) => c.state === "generating"), true);

    await scheduler.drain();

    // Decision B: elevated upload budget drains the warm-up disc in a few frames, not warmUp/4.
    const steadyFramesNeeded = Math.ceil(warmUpChunks / uploadsPerFrame); // 3 at these numbers
    let ready = 0;
    let frames = 0;
    const maxFrames = Math.max(2, Math.floor(steadyFramesNeeded / 2)); // must beat gradual fill
    while (frames < maxFrames && ready < warmUpChunks) {
      terrain.update(ctx, 0.016);
      frames++;
      ready = [...terrain.chunks.values()].filter((c) => c.state === "ready").length;
    }
    assert.ok(ready >= warmUpChunks);
    assert.ok(frames < steadyFramesNeeded);

    // After warm-up, steady upload budget returns.
    terrain.update(ctx, 0.016);
    assert.ok(terrain.streamingStats.uploadedThisFrame <= uploadsPerFrame);

    scheduler.dispose();
    scene.dispose();
    world.dispose();
  });

  test("cancels in-flight generation when a chunk leaves the visible set", async () => {
    installTerrainTaskHandlers();
    const scheduler = new TaskScheduler({ inline: true, workerCount: 0, maxConcurrent: 1 });
    const world = new EntityWorld();
    const terrain = new TerrainWorld({
      chunkSize: 64,
      chunkResolution: 17,
      viewDistance: 90,
      maxChunksLoaded: 9,
      maxGenerationsPerFrame: 8,
      horizonSkirt: false,
    });
    const services: SystemContext["services"] = {
      get: <T>(key: string) => (key === "tasks" ? (scheduler as unknown as T) : undefined),
      engineConfig: {},
    };
    const ctx: SystemContext = { ...createMockContext(world), services };
    const scene = new Scene({ name: "cancel-test" });
    scene.add(terrain);
    const cameraEntity = world.createEntity("camera");
    cameraEntity.add(new Camera());
    const camT = cameraEntity.add(new Transform());
    camT.setPosition(0, 0, 0);

    terrain.update(ctx, 0.016);
    assert.ok(terrain.streamingStats.scheduledThisFrame > 0);
    assert.equal([...terrain.chunks.values()].some((c) => c.state === "generating"), true);

    // Jump the camera far away before jobs settle — previous disc should cancel.
    camT.setPosition(5000, 0, 5000);
    terrain.update(ctx, 0.016);
    assert.ok(terrain.streamingStats.cancelledThisFrame > 0);

    await scheduler.drain().catch(() => undefined);
    scheduler.dispose();
    scene.dispose();
    world.dispose();
  });

  test("streams around a camera moved through entity.transform (storage-only writes)", () => {
    // OrbitControls poses the camera through the TransformHandle, which writes transform storage
    // but not the Transform component's mirror fields. The focus used to read the mirror, so on
    // the Mars showcase streaming stayed parked at the camera's authored start forever.
    const world = new EntityWorld();
    const terrain = new TerrainWorld({ chunkSize: 64, chunkResolution: 9, viewDistance: 90, horizonSkirt: false, syncGeneration: true });
    const scene = new Scene({ name: "focus-follow" });
    scene.add(terrain);
    const cameraEntity = world.createEntity("camera");
    cameraEntity.add(new Camera());
    cameraEntity.add(new Transform());
    const ctx = createMockContext(world);

    terrain.update(ctx, 0.016);
    assert.deepEqual(terrain.focusPosition.toArray(), [0, 0, 0]);

    cameraEntity.transform.position = new Vec3(700, 12, -300);
    terrain.update(ctx, 0.016);
    assert.deepEqual(terrain.focusPosition.toArray(), [700, 12, -300]);
    assert.equal([...terrain.chunks.values()].some((c) => c.cx === Math.floor(700 / 64) && c.cz === Math.floor(-300 / 64)), true);

    scene.dispose();
    world.dispose();
  });

  test("builds a horizon skirt geometry with no holes at the rim", () => {
    const source = buildHorizonSkirt({
      centerX: 0,
      centerZ: 0,
      innerRadius: 200,
      outerExtent: 100,
      sampleHeight: () => 10,
      ringSegments: 16,
      radialSegments: 1,
    });
    assert.ok(source.positions.length > 0);
    assert.equal(source.indices!.length, 16 * 6);
    // Outer ring is dropped below the rim.
    let minY = Infinity;
    for (let i = 0; i < source.positions.length; i += 3) {
      minY = Math.min(minY, source.positions[i + 1]!);
    }
    assert.ok(minY < 10);
  });

  test("respects generation and visible-chunk budgets while streaming", () => {
    const world = new EntityWorld();
    const terrain = new TerrainWorld({
      chunkSize: 64,
      chunkResolution: 9,
      viewDistance: 500,
      visibleChunks: 12,
      generationsPerFrame: 2,
      memoryBytes: 8 * 1024 * 1024,
      horizonSkirt: false,
      syncGeneration: true,
    });
    const ctx = createMockContext(world);
    const scene = new Scene({ name: "budget-test" });
    scene.add(terrain);
    const cameraEntity = world.createEntity("camera");
    cameraEntity.add(new Camera());
    cameraEntity.add(new Transform());

    terrain.update(ctx, 0.016);
    assert.ok(terrain.chunks.size <= 12);
    // Steady budget after warm-up (warmUpChunks default 0).
    const ready = [...terrain.chunks.values()].filter((c) => c.state === "ready").length;
    assert.ok(ready <= 2);

    scene.dispose();
    world.dispose();
  });

  test("blends layered materials by height, slope and biome weights", () => {
    const layered = new LayeredTerrainMaterial();
    const flatLow = layered.sample(10, 0.05, [0.7, 0.1, 0.2, 0]);
    const steepHigh = layered.sample(200, 1.0, [0.05, 0.8, 0.05, 0.1]);
    assert.ok(flatLow.color.g > 0);
    assert.ok(steepHigh.roughness > flatLow.roughness - 0.2);
    const mat = layered.toMaterial(10, 0.1);
    assert.ok(mat.roughness > 0);
    mat.dispose();
  });

  test("priority streaming prefers nearer, forward-facing chunks", () => {
    const world = new EntityWorld();
    const terrain = new TerrainWorld({
      chunkSize: 64,
      chunkResolution: 9,
      viewDistance: 200,
      maxChunksLoaded: 5,
      maxGenerationsPerFrame: 5,
      warmUpChunks: 5,
      horizonSkirt: false,
      syncGeneration: true,
    });
    const ctx = createMockContext(world);
    const scene = new Scene({ name: "priority-test" });
    scene.add(terrain);
    const cameraEntity = world.createEntity("camera");
    cameraEntity.add(new Camera());
    const camT = cameraEntity.add(new Transform());
    camT.setPosition(0, 10, 0);
    // Default forward is +Z.
    terrain.focusPosition.set(0, 10, 0);
    terrain.focusForward.set(0, 0, 1);

    terrain.update(ctx, 0.016);
    const ready = [...terrain.chunks.values()].filter((c) => c.state === "ready");
    assert.ok(ready.length > 0);
    // All ready chunks should be among the nearest to the focus.
    for (const chunk of ready) {
      const centerX = (chunk.cx + 0.5) * 64;
      const centerZ = (chunk.cz + 0.5) * 64;
      const dist = Math.hypot(centerX, centerZ);
      assert.ok(dist < 200);
    }

    scene.dispose();
    world.dispose();
  });
});

group("Terrain - adversarial auto-fix (geomorph/memory/LOD cancel)", () => {
  test("uses one morphed height grid for Heightmap queries and mesh positions/normals", () => {
    const res = 3;
    const heights = new Float32Array([0, 10, 0, 10, 20, 10, 0, 10, 0]);
    const cell = {
      cx: 0,
      cz: 0,
      size: 64,
      resolution: res,
      seed: 0,
      heights,
      slopes: new Float32Array(res * res),
      biomes: new Float32Array(res * res * 4),
      scatters: [] as [],
    };
    const alpha = 1;
    const tile = TerrainTile.fromCell({
      cx: 0,
      cz: 0,
      size: 64,
      lod: 0,
      geomorphAlpha: alpha,
      cell,
    });

    // Grid vertex Y must match heightmap (drawn surface === physics/camera height).
    const step = tile.size / (res - 1);
    for (let j = 0; j < res; j++) {
      for (let i = 0; i < res; i++) {
        const wx = i * step;
        const wz = j * step;
        const idx = j * res + i;
        const meshY = tile.geometrySource.positions[idx * 3 + 1]!;
        const hmY = tile.heightmap.sampleGrid(i, j);
        assertCloseTo(meshY, hmY, 5);
        assertCloseTo(tile.heightmap.getHeight(wx, wz), meshY, 4);
      }
    }

    // Normals from the same morphed surface.
    const mid = 1;
    const wx = mid * step;
    const wz = mid * step;
    const nOff = (mid * res + mid) * 3;
    const normals = tile.geometrySource.normals!;
    const meshN = {
      x: normals[nOff]!,
      y: normals[nOff + 1]!,
      z: normals[nOff + 2]!,
    };
    const hmN = tile.heightmap.getNormal(wx, wz);
    assertCloseTo(meshN.x, hmN.x, 5);
    assertCloseTo(meshN.y, hmN.y, 5);
    assertCloseTo(meshN.z, hmN.z, 5);

    // alpha=1 morphs odd sample (1,0) from 10 → 0 (coarse parents are 0).
    assertCloseTo(tile.heightmap.sampleGrid(1, 0), 0, 5);
    assert.equal(tile.cell.heights[1], 10);
  });

  test("stops starting generations when residentBytes alone meets the memory budget", () => {
    const world = new EntityWorld();
    // Tiny memory budget with plenty of visible-chunk headroom — the old AND never tripped.
    const terrain = new TerrainWorld({
      chunkSize: 64,
      chunkResolution: 17,
      viewDistance: 400,
      visibleChunks: 64,
      generationsPerFrame: 8,
      memoryBytes: estimateTileBytes(17) * 2, // ~2 resident tiles
      horizonSkirt: false,
      syncGeneration: true,
      warmUpChunks: 0,
    });
    const ctx = createMockContext(world);
    const scene = new Scene({ name: "memory-gate-test" });
    scene.add(terrain);
    const cameraEntity = world.createEntity("camera");
    cameraEntity.add(new Camera());
    cameraEntity.add(new Transform());

    // First frame may overshoot slightly (soft cap); subsequent frames must not keep climbing.
    for (let i = 0; i < 6; i++) terrain.update(ctx, 0.016);

    assert.ok(terrain.streamingStats.residentBytes > 0);
    assert.ok(terrain.streamingStats.residentBytes <= terrain.budgets.memoryBytes * 1.05);
    // With visibleChunks=64 headroom, a broken AND gate would keep filling toward dozens of chunks.
    const ready = [...terrain.chunks.values()].filter((c) => c.state === "ready").length;
    assert.ok(ready <= 4);

    scene.dispose();
    world.dispose();
  });

  test("cancels in-flight generation when desired resolution diverges and requeues pending", async () => {
    installTerrainTaskHandlers();
    const scheduler = new TaskScheduler({ inline: true, workerCount: 0, maxConcurrent: 1 });
    const world = new EntityWorld();
    const terrain = new TerrainWorld({
      chunkSize: 64,
      chunkResolution: 33,
      viewDistance: 120,
      maxChunksLoaded: 9,
      maxGenerationsPerFrame: 4,
      horizonSkirt: false,
      syncGeneration: false,
    });
    const services: SystemContext["services"] = {
      get: <T>(key: string) => (key === "tasks" ? (scheduler as unknown as T) : undefined),
      engineConfig: {},
    };
    const ctx: SystemContext = { ...createMockContext(world), services };
    const scene = new Scene({ name: "lod-cancel-test" });
    scene.add(terrain);
    const cameraEntity = world.createEntity("camera");
    cameraEntity.add(new Camera());
    const camT = cameraEntity.add(new Transform());
    camT.setPosition(0, 20, 0);
    terrain.focusPosition.set(0, 20, 0);

    terrain.update(ctx, 0.016);
    const generating = [...terrain.chunks.values()].filter((c) => c.state === "generating");
    assert.ok(generating.length > 0);
    const target = generating[0]!;
    const inFlightRes = target.resolution;
    const taskKeyBefore = target.taskKey;
    assert.ok(taskKeyBefore);

    // Force a divergent desired resolution while the task is still in flight.
    const newRes = inFlightRes === 33 ? 17 : 33;
    target.lod = inFlightRes === 33 ? 1 : 0;
    // Monkey-patch prioritize path: override chunk selection resolution via lod distances.
    // Move camera far enough that this chunk's LOD (and thus resolution) changes on next select,
    // OR directly simulate the update branch by calling update after stubbing resolutionForLod via
    // forcing the chunk to stay selected with a different resolution through focus jump.
    // Simpler: stub the chunk's desired resolution by temporarily replacing lod.evaluateDistance.
    const origEval = terrain.lod.evaluateDistance.bind(terrain.lod);
    terrain.lod.evaluateDistance = (distance: number) => {
      const base = origEval(distance);
      // Force LOD that yields newRes for every selection this frame.
      const lod = newRes === 17 ? 1 : 0;
      return { lod, alpha: base.alpha };
    };

    terrain.update(ctx, 0.016);

    // In-flight work at the old resolution must be cancelled and the chunk re-queued.
    assert.ok(terrain.streamingStats.cancelledThisFrame > 0);
    assert.equal(target.resolution, newRes);
    assert.equal(target.state === "pending" || target.state === "generating", true);
    // Submit identity includes resolution+epoch — resubmit must not reuse the cancelled key.
    if (target.state === "pending") {
      assert.equal(target.taskKey, null);
    } else {
      assert.ok(target.taskKey);
      assert.notEqual(target.taskKey, taskKeyBefore);
      assertContains(target.taskKey, `:${newRes}:`);
      assert.equal(target.resolution, newRes);
    }

    terrain.lod.evaluateDistance = origEval;
    await scheduler.drain().catch(() => undefined);
    scheduler.dispose();
    scene.dispose();
    world.dispose();
  });

  test("remeshes a ready tile when geomorph alpha drifts past the threshold", () => {
    const world = new EntityWorld();
    const terrain = new TerrainWorld({
      chunkSize: 64,
      chunkResolution: 9,
      viewDistance: 80,
      maxChunksLoaded: 4,
      maxGenerationsPerFrame: 4,
      warmUpChunks: 4,
      horizonSkirt: false,
      syncGeneration: true,
    });
    const ctx = createMockContext(world);
    const scene = new Scene({ name: "geomorph-remesh-test" });
    scene.add(terrain);
    const cameraEntity = world.createEntity("camera");
    cameraEntity.add(new Camera());
    const camT = cameraEntity.add(new Transform());
    camT.setPosition(0, 20, 0);
    terrain.focusPosition.set(0, 20, 0);

    terrain.update(ctx, 0.016);
    const ready = [...terrain.chunks.values()].filter((c) => c.state === "ready" && c.tile);
    assert.ok(ready.length > 0);
    const chunk = ready[0]!;
    const baked = chunk.tile!.geomorphAlpha;
    const cellRef = chunk.tile!.cell;

    // Force a large alpha delta on the next selection.
    const origEval = terrain.lod.evaluateDistance.bind(terrain.lod);
    terrain.lod.evaluateDistance = (distance: number) => {
      const base = origEval(distance);
      return { lod: base.lod, alpha: baked < 0.5 ? 1 : 0 };
    };
    terrain.update(ctx, 0.016);
    terrain.lod.evaluateDistance = origEval;

    assert.equal(chunk.state, "ready");
    assert.notEqual(chunk.tile, null);
    assert.ok(Math.abs(chunk.tile!.geomorphAlpha - baked) > 0.08);
    // Remesh reused the cell (no full regen) — same heights buffer identity.
    assert.equal(chunk.tile!.cell.heights, cellRef.heights);

    scene.dispose();
    world.dispose();
  });


  test("cancel then resubmit keeps replacement in-flight (unique submit identity)", async () => {
    installTerrainTaskHandlers();
    // maxConcurrent 1 so the first submit is running when we cancel; inline so cancel rejects sync.
    const scheduler = new TaskScheduler({ inline: true, workerCount: 0, maxConcurrent: 1 });
    const world = new EntityWorld();
    const terrain = new TerrainWorld({
      chunkSize: 64,
      chunkResolution: 33,
      viewDistance: 80,
      maxChunksLoaded: 4,
      maxGenerationsPerFrame: 2,
      generationsPerFrame: 2,
      horizonSkirt: false,
      syncGeneration: false,
      warmUpChunks: 0,
    });
    const services: SystemContext["services"] = {
      get: <T>(key: string) => (key === "tasks" ? (scheduler as unknown as T) : undefined),
      engineConfig: {},
    };
    const ctx: SystemContext = { ...createMockContext(world), services };
    const scene = new Scene({ name: "cancel-resubmit-identity" });
    scene.add(terrain);
    const cameraEntity = world.createEntity("camera");
    cameraEntity.add(new Camera());
    const camT = cameraEntity.add(new Transform());
    camT.setPosition(0, 20, 0);
    terrain.focusPosition.set(0, 20, 0);

    terrain.update(ctx, 0.016);
    const target = [...terrain.chunks.values()].find((c) => c.state === "generating");
    assert.ok(target);
    const keyBefore = target!.taskKey!;
    const epochBefore = target!.taskEpoch;
    assert.equal(keyBefore, terrainCellKey(target!.cx, target!.cz, target!.resolution, epochBefore));

    // Divergent resolution → cancel + same-frame resubmit under the generation budget.
    const newRes = target!.resolution === 33 ? 17 : 33;
    const origEval = terrain.lod.evaluateDistance.bind(terrain.lod);
    terrain.lod.evaluateDistance = (distance: number) => {
      const base = origEval(distance);
      return { lod: newRes === 17 ? 1 : 0, alpha: base.alpha };
    };
    terrain.update(ctx, 0.016);

    assert.ok(terrain.streamingStats.cancelledThisFrame > 0);
    // Flush cancelled rejection microtasks — the old bug cleared the *new* taskKey here.
    await Promise.resolve();
    await Promise.resolve();

    assert.notEqual(target!.taskKey, keyBefore);
    if (target!.state === "generating") {
      assert.ok(target!.taskKey);
      assert.ok(target!.taskEpoch > epochBefore);
      assert.equal(target!.taskKey, terrainCellKey(target!.cx, target!.cz, target!.resolution, target!.taskEpoch));
    }

    // Replacement must still be able to complete (mesh not dropped by cancelled catch).
    await scheduler.drain().catch(() => undefined);
    terrain.update(ctx, 0.016);
    // After drain + update, either ready or still generating/pending — but not stuck cleared.
    assertContains(["ready", "generating", "pending"], target!.state);
    if (target!.state === "ready") {
      assert.notEqual(target!.tile, null);
    }

    terrain.lod.evaluateDistance = origEval;
    scheduler.dispose();
    scene.dispose();
    world.dispose();
  });

  test("caps lodDistances at maxLOD so evaluateDistance cannot select above maxLOD", () => {
    const terrain = new TerrainWorld({
      chunkSize: 100,
      maxLOD: 3,
      horizonSkirt: false,
    });
    assert.equal(terrain.lod.lodDistances.length, 4); // indices 0..3
    assert.equal(terrain.lod.evaluateDistance(0).lod, 0);
    assert.equal(terrain.lod.evaluateDistance(1e9).lod, 3);
    // Even if bands were longer, clamp keeps lod <= maxLOD.
    terrain.lod.lodDistances.push(terrain.chunkSize * 48, terrain.chunkSize * 96);
    assert.ok(terrain.lod.evaluateDistance(terrain.chunkSize * 30).lod <= 3);
    terrain.dispose();
  });

  test("writes sync height-query generation into TerrainGenerationCache", () => {
    const terrain = new TerrainWorld({
      chunkSize: 64,
      chunkResolution: 9,
      horizonSkirt: false,
      syncGeneration: true,
    });
    const cacheKey = terrainCacheKey({
      seed: terrain.seed,
      chunkX: 0,
      chunkZ: 0,
      generatorVersion: TERRAIN_GENERATOR_VERSION,
      generatorSettings: terrain.pipelineHash,
      resolution: terrain.chunkResolution,
    });
    assert.equal(terrain.cache.get(cacheKey), undefined);
    const h = terrain.getHeightAt(10, 10);
    assert.equal(Number.isFinite(h), true);
    const cached = terrain.cache.get(cacheKey);
    assert.notEqual(cached, undefined);
    assert.equal(cached!.resolution, 9);
    // Second query should hit the generation cache (via sampledCells or cache).
    const hitsBefore = terrain.cache.hits;
    (terrain as unknown as { sampledCells: Map<string, unknown> }).sampledCells.clear();
    terrain.getHeightAt(12, 12);
    assert.ok(terrain.cache.hits > hitsBefore);
    terrain.dispose();
  });

  test("gates geomorph remeshes on uploadsPerFrame and defers the rest", () => {
    const world = new EntityWorld();
    const terrain = new TerrainWorld({
      chunkSize: 64,
      chunkResolution: 9,
      viewDistance: 200,
      maxChunksLoaded: 16,
      maxGenerationsPerFrame: 16,
      generationsPerFrame: 16,
      uploadsPerFrame: 1,
      warmUpChunks: 16,
      horizonSkirt: false,
      syncGeneration: true,
    });
    const ctx = createMockContext(world);
    const scene = new Scene({ name: "geomorph-upload-budget" });
    scene.add(terrain);
    const cameraEntity = world.createEntity("camera");
    cameraEntity.add(new Camera());
    const camT = cameraEntity.add(new Transform());
    camT.setPosition(0, 20, 0);
    terrain.focusPosition.set(0, 20, 0);

    terrain.update(ctx, 0.016);
    const ready = [...terrain.chunks.values()].filter((c) => c.state === "ready" && c.tile);
    assert.ok(ready.length > 2);

    // Snapshot baked alphas, then force every tile past the remesh epsilon.
    const baked = new Map(ready.map((c) => [c.key, c.tile!.geomorphAlpha]));
    const origEval = terrain.lod.evaluateDistance.bind(terrain.lod);
    terrain.lod.evaluateDistance = (distance: number) => {
      const base = origEval(distance);
      return { lod: base.lod, alpha: 1 };
    };

    terrain.update(ctx, 0.016);
    const remeshed = ready.filter((c) => c.tile && Math.abs(c.tile.geomorphAlpha - (baked.get(c.key) ?? 0)) > 0.08);
    assert.ok(remeshed.length <= terrain.budgets.uploadsPerFrame);
    assert.ok(terrain.streamingStats.uploadedThisFrame <= terrain.budgets.uploadsPerFrame);

    // A later frame should continue remeshing deferred chunks.
    terrain.update(ctx, 0.016);
    const remeshedTotal = ready.filter((c) => c.tile && Math.abs(c.tile.geomorphAlpha - (baked.get(c.key) ?? 0)) > 0.08);
    assert.ok(remeshedTotal.length >= remeshed.length);

    terrain.lod.evaluateDistance = origEval;
    scene.dispose();
    world.dispose();
  });

  test("memory gate counts in-flight worker reservations", async () => {
    installTerrainTaskHandlers();
    const scheduler = new TaskScheduler({ inline: true, workerCount: 0, maxConcurrent: 4 });
    const world = new EntityWorld();
    const tileBytes = estimateTileBytes(17);
    const terrain = new TerrainWorld({
      chunkSize: 64,
      chunkResolution: 17,
      viewDistance: 400,
      visibleChunks: 64,
      generationsPerFrame: 16,
      memoryBytes: tileBytes * 2,
      horizonSkirt: false,
      syncGeneration: false,
      warmUpChunks: 0,
    });
    const services: SystemContext["services"] = {
      get: <T>(key: string) => (key === "tasks" ? (scheduler as unknown as T) : undefined),
      engineConfig: {},
    };
    const ctx: SystemContext = { ...createMockContext(world), services };
    const scene = new Scene({ name: "memory-reserve-test" });
    scene.add(terrain);
    const cameraEntity = world.createEntity("camera");
    cameraEntity.add(new Camera());
    cameraEntity.add(new Transform());

    terrain.update(ctx, 0.016);
    const inFlight = [...terrain.chunks.values()].filter((c) => c.state === "generating").length;
    const ready = [...terrain.chunks.values()].filter((c) => c.state === "ready").length;
    // Without reservations, generationsPerFrame=16 would schedule far past a 2-tile memory budget.
    assert.ok(inFlight + ready <= 4);
    assert.ok(terrain.streamingStats.residentBytes <= terrain.budgets.memoryBytes * 1.05);

    await scheduler.drain().catch(() => undefined);
    scheduler.dispose();
    scene.dispose();
    world.dispose();
  });

  test("counts each chunk attach once toward uploadedThisFrame (single accounting point)", () => {
    const world = new EntityWorld();
    const terrain = new TerrainWorld({
      chunkSize: 64,
      chunkResolution: 9,
      viewDistance: 200,
      visibleChunks: 16,
      generationsPerFrame: 5,
      uploadsPerFrame: 16,
      warmUpChunks: 0,
      horizonSkirt: false,
      syncGeneration: true,
    });
    const ctx = createMockContext(world);
    const scene = new Scene({ name: "upload-count-once" });
    scene.add(terrain);
    const cameraEntity = world.createEntity("camera");
    cameraEntity.add(new Camera());
    cameraEntity.add(new Transform());

    terrain.update(ctx, 0.016);
    const attached = terrain.activeEntities.size;
    assert.ok(attached > 0);
    // attachChunkEntity is the sole incrementer — must match entity attaches, not 2x.
    assert.equal(terrain.streamingStats.uploadedThisFrame, attached);
    assert.ok(terrain.streamingStats.uploadedThisFrame <= terrain.budgets.generationsPerFrame);

    scene.dispose();
    world.dispose();
  });

  test("dispose cancels in-flight terrain tasks on the shared scheduler", async () => {
    installTerrainTaskHandlers();
    const scheduler = new TaskScheduler({ inline: true, workerCount: 0, maxConcurrent: 1 });
    const world = new EntityWorld();
    const terrain = new TerrainWorld({
      chunkSize: 64,
      chunkResolution: 17,
      viewDistance: 200,
      visibleChunks: 16,
      generationsPerFrame: 8,
      warmUpChunks: 0,
      horizonSkirt: false,
      syncGeneration: false,
    });
    const services: SystemContext["services"] = {
      get: <T>(key: string) => (key === "tasks" ? (scheduler as unknown as T) : undefined),
      engineConfig: {},
    };
    const ctx: SystemContext = { ...createMockContext(world), services };
    const scene = new Scene({ name: "dispose-cancel-inflight" });
    scene.add(terrain);
    const cameraEntity = world.createEntity("camera");
    cameraEntity.add(new Camera());
    cameraEntity.add(new Transform());

    terrain.update(ctx, 0.016);
    const inFlightKeys = [...terrain.chunks.values()]
      .filter((c) => c.state === "generating" && c.taskKey)
      .map((c) => c.taskKey!);
    assert.ok(inFlightKeys.length > 0);

    const cancelledBefore = scheduler.stats.cancelled;
    // Dispose while work is still queued/running — must cancel via lastScheduler.
    terrain.dispose();
    assert.equal(terrain.chunks.size, 0);
    assert.ok(scheduler.stats.cancelled >= cancelledBefore + inFlightKeys.length);
    for (const key of inFlightKeys) {
      assert.equal(scheduler.cancel(key), false); // already gone from the scheduler
    }

    await scheduler.drain().catch(() => undefined);
    scheduler.dispose();
    scene.dispose();
    world.dispose();
  });

  test("horizon skirt samples resident tiles only (no sync generation for missing cells)", () => {
    const world = new EntityWorld();
    const terrain = new TerrainWorld({
      chunkSize: 64,
      chunkResolution: 9,
      viewDistance: 90,
      maxChunksLoaded: 4,
      maxGenerationsPerFrame: 4,
      warmUpChunks: 4,
      horizonSkirt: true,
      syncGeneration: true,
    });
    const ctx = createMockContext(world);
    const scene = new Scene({ name: "horizon-resident-test" });
    scene.add(terrain);
    const cameraEntity = world.createEntity("camera");
    cameraEntity.add(new Camera());
    cameraEntity.add(new Transform());

    terrain.update(ctx, 0.016);
    // Force horizon rebuild by moving focus.
    terrain.focusPosition.set(30, 10, 30);
    terrain.update(ctx, 0.016);
    // Horizon rebuild must not fill the generation cache for missing rim cells.
    // (getHeightAt/sampledHeightmap would bump misses or populate sampledCells aggressively.)
    const sampledAfter = (terrain as unknown as { sampledCells: Map<string, unknown> }).sampledCells.size;
    // With resident-only sampling, sampledCells should stay empty (never used by horizon).
    assert.equal(sampledAfter, 0);

    scene.dispose();
    world.dispose();
  });

});

await finish();
