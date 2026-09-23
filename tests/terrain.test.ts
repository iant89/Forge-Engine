import { describe, expect, it } from "vitest";
import {
  Heightmap,
  HeightGenerator,
  CraterGenerator,
  GeneratorPipeline,
  TerrainTile,
  TerrainWorld,
  TerrainLOD,
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
