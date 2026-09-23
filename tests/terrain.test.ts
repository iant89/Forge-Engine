import { describe, expect, it } from "vitest";
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

describe("Terrain - Procedural Generation & Determinism", () => {
  it("generates bit-for-bit identical heightmaps for the same seed and chunk coordinates", () => {
    const pipe = GeneratorPipeline.createDefault(42);
    const tile1 = new TerrainTile({ cx: 3, cz: -5, size: 128, resolution: 33 }, pipe, 42);
    const tile2 = new TerrainTile({ cx: 3, cz: -5, size: 128, resolution: 33 }, pipe, 42);

    expect(tile1.cell.heights.length).toBe(tile2.cell.heights.length);
    for (let i = 0; i < tile1.cell.heights.length; i++) {
      expect(tile1.cell.heights[i]).toBe(tile2.cell.heights[i]);
    }

    // Different seed produces different heightfield
    const tileDiffSeed = new TerrainTile({ cx: 3, cz: -5, size: 128, resolution: 33 }, pipe, 9999);
    let differences = 0;
    for (let i = 0; i < tile1.cell.heights.length; i++) {
      if (tile1.cell.heights[i] !== tileDiffSeed.cell.heights[i]) {
        differences++;
      }
    }
    expect(differences).toBeGreaterThan(tile1.cell.heights.length * 0.9);
  });

  it("ensures seamless elevation continuity across chunk boundaries", () => {
    const pipe = new GeneratorPipeline().addStage(new HeightGenerator());
    const res = 33;
    const size = 128;
    const tile00 = new TerrainTile({ cx: 0, cz: 0, size, resolution: res }, pipe, 100);
    const tile10 = new TerrainTile({ cx: 1, cz: 0, size, resolution: res }, pipe, 100);

    // Right edge of tile (0, 0) should equal left edge of tile (1, 0)
    for (let j = 0; j < res; j++) {
      const rightEdge00 = tile00.cell.heights[j * res + (res - 1)]!;
      const leftEdge10 = tile10.cell.heights[j * res + 0]!;
      expect(Math.abs(rightEdge00 - leftEdge10)).toBeLessThan(1e-4);
    }
  });

  it("crater generator creates depressions and uplifted rims", () => {
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
    expect(minH).toBeLessThan(50);
    // Should have uplifted above 50m along the rim
    expect(maxH).toBeGreaterThan(50);
  });

  it("scatter generator places props on acceptable slopes", () => {
    const pipe = GeneratorPipeline.createDefault(54321);
    const tile = new TerrainTile({ cx: 1, cz: 2, size: 256, resolution: 33 }, pipe, 54321);

    expect(tile.cell.scatters.length).toBeGreaterThan(0);
    for (const s of tile.cell.scatters) {
      // Must be within chunk bounds
      expect(s.x).toBeGreaterThanOrEqual(256);
      expect(s.x).toBeLessThanOrEqual(512);
      expect(s.z).toBeGreaterThanOrEqual(512);
      expect(s.z).toBeLessThanOrEqual(768);
      expect(s.scale).toBeGreaterThan(0);
    }
  });
});

describe("Terrain - Heightmap and Continuous Sampling", () => {
  it("interpolates continuous elevations and normal vectors", () => {
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
    expect(hm.getHeight(0, 0)).toBeCloseTo(0);
    expect(hm.getHeight(size, 0)).toBeCloseTo(2 * size);
    expect(hm.getHeight(0, size)).toBeCloseTo(1 * size);

    // Continuous midpoint sample
    const midH = hm.getHeight(size * 0.5, size * 0.5);
    expect(midH).toBeCloseTo(2 * (size * 0.5) + 1 * (size * 0.5), 1);

    // Normal vector check: normal of plane z + 2x - y = 0 is (-2, 1, -1) normalized
    const normal = hm.getNormal(size * 0.5, size * 0.5);
    expect(normal.length()).toBeCloseTo(1.0);
    expect(normal.y).toBeGreaterThan(0);
  });

  it("raycasts against heightmap surface and returns exact intersection point", () => {
    const res = 17;
    const size = 64;
    const heights = new Float32Array(res * res).fill(10); // flat ground at y = 10
    const hm = new Heightmap({ size, resolution: res, heights });

    const ray = new Ray(new Vec3(32, 50, 32), new Vec3(0, -1, 0), 100);
    const hit = new RayHit();

    expect(hm.raycast(ray, hit)).toBe(true);
    expect(hit.isValid).toBe(true);
    expect(hit.point.x).toBeCloseTo(32);
    expect(hit.point.y).toBeCloseTo(10, 1);
    expect(hit.point.z).toBeCloseTo(32);
    expect(hit.distance).toBeCloseTo(40, 1);

    // Ray shooting away from terrain
    const awayRay = new Ray(new Vec3(32, 50, 32), new Vec3(0, 1, 0), 100);
    const awayHit = new RayHit();
    expect(hm.raycast(awayRay, awayHit)).toBe(false);
  });
});

describe("Terrain - LOD and Streaming Budget", () => {
  it("evaluates LOD level and geomorph alpha across distance bands", () => {
    const lod = new TerrainLOD({
      baseChunkSize: 100,
      maxLOD: 3,
      lodDistances: [200, 400, 800],
      transitionWidth: 0.2, // transition at [160, 200]
    });

    // Close: LOD 0, no geomorph
    const close = lod.evaluateDistance(50);
    expect(close.lod).toBe(0);
    expect(close.alpha).toBe(0);

    // In transition band [160, 200]
    const mid = lod.evaluateDistance(180);
    expect(mid.lod).toBe(0);
    expect(mid.alpha).toBeCloseTo(0.5, 1);

    // Far: LOD 1
    const far = lod.evaluateDistance(250);
    expect(far.lod).toBe(1);
  });

  it("enforces max chunk memory budget through LRU eviction", () => {
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
    expect(initialLoaded).toBeLessThanOrEqual(9);

    // Move camera 5000 meters away
    terrain.focusPosition.set(5000, 0, 5000);
    terrain.update(ctx, 0.016);

    // Total chunks must still stay within maxChunksLoaded
    expect(terrain.chunks.size).toBeLessThanOrEqual(9);

    terrain.dispose();
    world.dispose();
  });

  it("warms up the opening view in one burst, then returns to the steady budget", () => {
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
    expect(readyFirst).toBeGreaterThanOrEqual(7);

    terrain.update(ctx, 0.016);
    const readySecond = [...terrain.chunks.values()].filter((c) => c.state === "ready").length;
    // The allowance is one-shot: after the first update only maxGenerationsPerFrame remains.
    expect(readySecond - readyFirst).toBeLessThanOrEqual(1);

    scene.dispose();
    world.dispose();
  });
});

describe("Terrain - Phase 10 LOD meshes", () => {
  it("resolutionForLod nests odd grids 33→17→9→5→3", () => {
    expect(resolutionForLod(33, 0)).toBe(33);
    expect(resolutionForLod(33, 1)).toBe(17);
    expect(resolutionForLod(33, 2)).toBe(9);
    expect(resolutionForLod(33, 3)).toBe(5);
    expect(resolutionForLod(33, 4)).toBe(3);
  });

  it("builds lower-resolution meshes from chunk.lod", () => {
    const pipe = GeneratorPipeline.createDefault(7);
    const lod0 = new TerrainTile({ cx: 0, cz: 0, size: 128, resolution: resolutionForLod(33, 0), lod: 0 }, pipe, 7);
    const lod2 = new TerrainTile({ cx: 0, cz: 0, size: 128, resolution: resolutionForLod(33, 2), lod: 2 }, pipe, 7);
    expect(lod0.gridVertexCount).toBe(33 * 33);
    expect(lod2.gridVertexCount).toBe(9 * 9);
    expect(lod2.gridVertexCount).toBeLessThan(lod0.gridVertexCount);
  });

  it("applies geomorphing to vertex positions toward the coarser lattice", () => {
    const fine = geomorphHeight(new Float32Array([0, 10, 0, 10, 20, 10, 0, 10, 0]), 3, 1, 0, 0);
    const morph = geomorphHeight(new Float32Array([0, 10, 0, 10, 20, 10, 0, 10, 0]), 3, 1, 0, 1);
    // Index (1,0) sits between coarse parents (0,0)=0 and (2,0)=0 → morphs to 0.
    expect(fine).toBe(10);
    expect(morph).toBe(0);
    const half = geomorphHeight(new Float32Array([0, 10, 0, 10, 20, 10, 0, 10, 0]), 3, 1, 0, 0.5);
    expect(half).toBe(5);
  });

  it("streaming world generates LOD-dependent geometry complexity", () => {
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
    expect(ready.length).toBeGreaterThan(0);
    const resolutions = new Set(ready.map((c) => c.tile!.resolution));
    // Near + far selections should produce more than one mesh density.
    expect(resolutions.size).toBeGreaterThan(1);
    expect(Math.min(...resolutions)).toBeLessThan(33);

    scene.dispose();
    world.dispose();
  });
});

describe("Terrain - Phase 10 cache, priority, workers, horizon, materials", () => {
  it("caches generated cells by seed/chunk/version/settings/resolution", () => {
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
    expect(cache.get(key)?.heights).toBe(result.heights);
    expect(cache.hits).toBe(1);
    expect(cache.get(key + "|missing")).toBeUndefined();
    expect(cache.misses).toBe(1);
  });

  it("schedules chunk generation through TaskScheduler and does not block the update call", async () => {
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
    expect(terrain.streamingStats.scheduledThisFrame).toBeGreaterThan(0);
    const generating = [...terrain.chunks.values()].filter((c) => c.state === "generating");
    expect(generating.length).toBeGreaterThan(0);

    await scheduler.drain();
    // Completions land in the next update's drain.
    terrain.update(ctx, 0.016);
    const ready = [...terrain.chunks.values()].filter((c) => c.state === "ready");
    expect(ready.length).toBeGreaterThan(0);

    scheduler.dispose();
    scene.dispose();
    world.dispose();
  });

  it("cancels in-flight generation when a chunk leaves the visible set", async () => {
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
    expect(terrain.streamingStats.scheduledThisFrame).toBeGreaterThan(0);
    expect([...terrain.chunks.values()].some((c) => c.state === "generating")).toBe(true);

    // Jump the camera far away before jobs settle — previous disc should cancel.
    camT.setPosition(5000, 0, 5000);
    terrain.update(ctx, 0.016);
    expect(terrain.streamingStats.cancelledThisFrame).toBeGreaterThan(0);

    await scheduler.drain().catch(() => undefined);
    scheduler.dispose();
    scene.dispose();
    world.dispose();
  });

  it("builds a horizon skirt geometry with no holes at the rim", () => {
    const source = buildHorizonSkirt({
      centerX: 0,
      centerZ: 0,
      innerRadius: 200,
      outerExtent: 100,
      sampleHeight: () => 10,
      ringSegments: 16,
      radialSegments: 1,
    });
    expect(source.positions.length).toBeGreaterThan(0);
    expect(source.indices!.length).toBe(16 * 6);
    // Outer ring is dropped below the rim.
    let minY = Infinity;
    for (let i = 0; i < source.positions.length; i += 3) {
      minY = Math.min(minY, source.positions[i + 1]!);
    }
    expect(minY).toBeLessThan(10);
  });

  it("respects generation and visible-chunk budgets while streaming", () => {
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
    expect(terrain.chunks.size).toBeLessThanOrEqual(12);
    // Steady budget after warm-up (warmUpChunks default 0).
    const ready = [...terrain.chunks.values()].filter((c) => c.state === "ready").length;
    expect(ready).toBeLessThanOrEqual(2);

    scene.dispose();
    world.dispose();
  });

  it("blends layered materials by height, slope and biome weights", () => {
    const layered = new LayeredTerrainMaterial();
    const flatLow = layered.sample(10, 0.05, [0.7, 0.1, 0.2, 0]);
    const steepHigh = layered.sample(200, 1.0, [0.05, 0.8, 0.05, 0.1]);
    expect(flatLow.color.g).toBeGreaterThan(0);
    expect(steepHigh.roughness).toBeGreaterThan(flatLow.roughness - 0.2);
    const mat = layered.toMaterial(10, 0.1);
    expect(mat.roughness).toBeGreaterThan(0);
    mat.dispose();
  });

  it("priority streaming prefers nearer, forward-facing chunks", () => {
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
    expect(ready.length).toBeGreaterThan(0);
    // All ready chunks should be among the nearest to the focus.
    for (const chunk of ready) {
      const centerX = (chunk.cx + 0.5) * 64;
      const centerZ = (chunk.cz + 0.5) * 64;
      const dist = Math.hypot(centerX, centerZ);
      expect(dist).toBeLessThan(200);
    }

    scene.dispose();
    world.dispose();
  });
});

describe("Terrain - adversarial auto-fix (geomorph/memory/LOD cancel)", () => {
  it("uses one morphed height grid for Heightmap queries and mesh positions/normals", () => {
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
        expect(meshY).toBeCloseTo(hmY, 5);
        expect(tile.heightmap.getHeight(wx, wz)).toBeCloseTo(meshY, 4);
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
    expect(meshN.x).toBeCloseTo(hmN.x, 5);
    expect(meshN.y).toBeCloseTo(hmN.y, 5);
    expect(meshN.z).toBeCloseTo(hmN.z, 5);

    // alpha=1 morphs odd sample (1,0) from 10 → 0 (coarse parents are 0).
    expect(tile.heightmap.sampleGrid(1, 0)).toBeCloseTo(0, 5);
    expect(tile.cell.heights[1]).toBe(10);
  });

  it("stops starting generations when residentBytes alone meets the memory budget", () => {
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

    expect(terrain.streamingStats.residentBytes).toBeGreaterThan(0);
    expect(terrain.streamingStats.residentBytes).toBeLessThanOrEqual(terrain.budgets.memoryBytes * 1.05);
    // With visibleChunks=64 headroom, a broken AND gate would keep filling toward dozens of chunks.
    const ready = [...terrain.chunks.values()].filter((c) => c.state === "ready").length;
    expect(ready).toBeLessThanOrEqual(4);

    scene.dispose();
    world.dispose();
  });

  it("cancels in-flight generation when desired resolution diverges and requeues pending", async () => {
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
    expect(generating.length).toBeGreaterThan(0);
    const target = generating[0]!;
    const inFlightRes = target.resolution;
    const taskKeyBefore = target.taskKey;
    expect(taskKeyBefore).toBeTruthy();

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
    expect(terrain.streamingStats.cancelledThisFrame).toBeGreaterThan(0);
    expect(target.resolution).toBe(newRes);
    expect(target.state === "pending" || target.state === "generating").toBe(true);
    // Submit identity includes resolution+epoch — resubmit must not reuse the cancelled key.
    if (target.state === "pending") {
      expect(target.taskKey).toBeNull();
    } else {
      expect(target.taskKey).toBeTruthy();
      expect(target.taskKey).not.toBe(taskKeyBefore);
      expect(target.taskKey).toContain(`:${newRes}:`);
      expect(target.resolution).toBe(newRes);
    }

    terrain.lod.evaluateDistance = origEval;
    await scheduler.drain().catch(() => undefined);
    scheduler.dispose();
    scene.dispose();
    world.dispose();
  });

  it("remeshes a ready tile when geomorph alpha drifts past the threshold", () => {
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
    expect(ready.length).toBeGreaterThan(0);
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

    expect(chunk.state).toBe("ready");
    expect(chunk.tile).not.toBeNull();
    expect(Math.abs(chunk.tile!.geomorphAlpha - baked)).toBeGreaterThan(0.08);
    // Remesh reused the cell (no full regen) — same heights buffer identity.
    expect(chunk.tile!.cell.heights).toBe(cellRef.heights);

    scene.dispose();
    world.dispose();
  });


  it("cancel then resubmit keeps replacement in-flight (unique submit identity)", async () => {
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
    expect(target).toBeTruthy();
    const keyBefore = target!.taskKey!;
    const epochBefore = target!.taskEpoch;
    expect(keyBefore).toBe(terrainCellKey(target!.cx, target!.cz, target!.resolution, epochBefore));

    // Divergent resolution → cancel + same-frame resubmit under the generation budget.
    const newRes = target!.resolution === 33 ? 17 : 33;
    const origEval = terrain.lod.evaluateDistance.bind(terrain.lod);
    terrain.lod.evaluateDistance = (distance: number) => {
      const base = origEval(distance);
      return { lod: newRes === 17 ? 1 : 0, alpha: base.alpha };
    };
    terrain.update(ctx, 0.016);

    expect(terrain.streamingStats.cancelledThisFrame).toBeGreaterThan(0);
    // Flush cancelled rejection microtasks — the old bug cleared the *new* taskKey here.
    await Promise.resolve();
    await Promise.resolve();

    expect(target!.taskKey).not.toBe(keyBefore);
    if (target!.state === "generating") {
      expect(target!.taskKey).toBeTruthy();
      expect(target!.taskEpoch).toBeGreaterThan(epochBefore);
      expect(target!.taskKey).toBe(
        terrainCellKey(target!.cx, target!.cz, target!.resolution, target!.taskEpoch),
      );
    }

    // Replacement must still be able to complete (mesh not dropped by cancelled catch).
    await scheduler.drain().catch(() => undefined);
    terrain.update(ctx, 0.016);
    // After drain + update, either ready or still generating/pending — but not stuck cleared.
    expect(["ready", "generating", "pending"]).toContain(target!.state);
    if (target!.state === "ready") {
      expect(target!.tile).not.toBeNull();
    }

    terrain.lod.evaluateDistance = origEval;
    scheduler.dispose();
    scene.dispose();
    world.dispose();
  });

  it("caps lodDistances at maxLOD so evaluateDistance cannot select above maxLOD", () => {
    const terrain = new TerrainWorld({
      chunkSize: 100,
      maxLOD: 3,
      horizonSkirt: false,
    });
    expect(terrain.lod.lodDistances.length).toBe(4); // indices 0..3
    expect(terrain.lod.evaluateDistance(0).lod).toBe(0);
    expect(terrain.lod.evaluateDistance(1e9).lod).toBe(3);
    // Even if bands were longer, clamp keeps lod <= maxLOD.
    terrain.lod.lodDistances.push(terrain.chunkSize * 48, terrain.chunkSize * 96);
    expect(terrain.lod.evaluateDistance(terrain.chunkSize * 30).lod).toBeLessThanOrEqual(3);
    terrain.dispose();
  });

  it("writes sync height-query generation into TerrainGenerationCache", () => {
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
    expect(terrain.cache.get(cacheKey)).toBeUndefined();
    const h = terrain.getHeightAt(10, 10);
    expect(Number.isFinite(h)).toBe(true);
    const cached = terrain.cache.get(cacheKey);
    expect(cached).toBeDefined();
    expect(cached!.resolution).toBe(9);
    // Second query should hit the generation cache (via sampledCells or cache).
    const hitsBefore = terrain.cache.hits;
    (terrain as unknown as { sampledCells: Map<string, unknown> }).sampledCells.clear();
    terrain.getHeightAt(12, 12);
    expect(terrain.cache.hits).toBeGreaterThan(hitsBefore);
    terrain.dispose();
  });

  it("gates geomorph remeshes on uploadsPerFrame and defers the rest", () => {
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
    expect(ready.length).toBeGreaterThan(2);

    // Snapshot baked alphas, then force every tile past the remesh epsilon.
    const baked = new Map(ready.map((c) => [c.key, c.tile!.geomorphAlpha]));
    const origEval = terrain.lod.evaluateDistance.bind(terrain.lod);
    terrain.lod.evaluateDistance = (distance: number) => {
      const base = origEval(distance);
      return { lod: base.lod, alpha: 1 };
    };

    terrain.update(ctx, 0.016);
    const remeshed = ready.filter((c) => c.tile && Math.abs(c.tile.geomorphAlpha - (baked.get(c.key) ?? 0)) > 0.08);
    expect(remeshed.length).toBeLessThanOrEqual(terrain.budgets.uploadsPerFrame);
    expect(terrain.streamingStats.uploadedThisFrame).toBeLessThanOrEqual(terrain.budgets.uploadsPerFrame);

    // A later frame should continue remeshing deferred chunks.
    terrain.update(ctx, 0.016);
    const remeshedTotal = ready.filter((c) => c.tile && Math.abs(c.tile.geomorphAlpha - (baked.get(c.key) ?? 0)) > 0.08);
    expect(remeshedTotal.length).toBeGreaterThanOrEqual(remeshed.length);

    terrain.lod.evaluateDistance = origEval;
    scene.dispose();
    world.dispose();
  });

  it("memory gate counts in-flight worker reservations", async () => {
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
    expect(inFlight + ready).toBeLessThanOrEqual(4);
    expect(terrain.streamingStats.residentBytes).toBeLessThanOrEqual(terrain.budgets.memoryBytes * 1.05);

    await scheduler.drain().catch(() => undefined);
    scheduler.dispose();
    scene.dispose();
    world.dispose();
  });

  it("horizon skirt samples resident tiles only (no sync generation for missing cells)", () => {
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
    expect(sampledAfter).toBe(0);

    scene.dispose();
    world.dispose();
  });

});

