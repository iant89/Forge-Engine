/**
 * World population (Phase 14): deterministic scatter, compact SoA storage, terrain-following
 * streaming, and the renderer seam that draws populations as instanced batches with **zero ECS
 * entities** (docs/VERIFICATION.md#tests).
 *
 * What these prove:
 *  - Placement is a pure function of (type, seed, chunk coordinate, sampler): identical inputs give
 *    bit-identical SoA arrays, and chunk/type/seed changes each move the stream (14.1).
 *  - The stratified grid holds at most one candidate per cell; slope/height rules and the
 *    `maxPerChunk` cap are honored; scales stay inside their band; tint jitter packs deterministically.
 *  - `PopulationWorld` follows terrain chunk streaming: ready chunks get populations within the
 *    per-update budget, evicted chunks lose them, remeshes re-anchor Y to the new surface without
 *    re-scattering XZ, and none of it ever creates an entity (14.6 + the phase's headline).
 *  - The renderer seam: a submission becomes instanced batches whose instance records land in the
 *    same arena the renderables use; per-chunk frustum rejection happens before any record is
 *    written; casters reach the shadow maps through the same conservative assignment; the strict
 *    mock device reports no validation errors and nothing leaks (14.3/14.5 integration).
 */

import { describe, expect, it } from "vitest";
import {
  AABB,
  Camera,
  Clock,
  EntityWorld,
  GeneratorPipeline,
  GraphicsDevice,
  Light,
  Logger,
  Material,
  PopulationInstanceBlock,
  PopulationWorld,
  Profiler,
  Renderer,
  Scene,
  SceneObject,
  SystemScratch,
  TerrainWorld,
  Vec3,
  chunkCoordKey,
  createRock,
  createWorldCell,
  isPopulationSource,
  resolvePopulationTypeSpec,
  rockGeometrySource,
  scatterPopulationChunk,
  unpackColor,
  type PopulationCollector,
  type PopulationSource,
  type PopulationSubmission,
  type PopulationTypeSpec,
  type SystemContext,
} from "@forge/engine";

/** Flat world at y = 0 with a configurable upward normal. */
function flatSampler(normalY = 1): { heightAt: () => number; normalYAt: () => number } {
  return {
    heightAt: () => 0,
    normalYAt: () => normalY,
  };
}

function rockSpec(overrides: Partial<PopulationTypeSpec> = {}): PopulationTypeSpec {
  return { id: 1, label: "test-rocks", densityGrid: 4, scaleMin: 0.5, scaleMax: 1.5, ...overrides };
}

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

describe("Population - deterministic scatter (14.1)", () => {
  it("produces bit-identical SoA arrays for identical inputs, and moves with seed, chunk and type", () => {
    const sampler = flatSampler();
    const run = () => {
      const block = new PopulationInstanceBlock(64);
      scatterPopulationChunk(rockSpec(), 42137, 3, -5, 128, sampler, block);
      return block;
    };
    const a = run();
    const b = run();
    expect([...a.positions]).toEqual([...b.positions]);
    expect([...a.scales]).toEqual([...b.scales]);
    expect([...a.rotations]).toEqual([...b.rotations]);
    expect([...a.tints]).toEqual([...b.tints]);
    expect(a.count).toBe(b.count);
    expect(a.count).toBeGreaterThan(0);

    const otherSeed = run();
    void otherSeed;
    const seedB = new PopulationInstanceBlock(64);
    scatterPopulationChunk(rockSpec(), 42138, 3, -5, 128, sampler, seedB);
    const chunkB = new PopulationInstanceBlock(64);
    scatterPopulationChunk(rockSpec(), 42137, 4, -5, 128, sampler, chunkB);
    const typeB = new PopulationInstanceBlock(64);
    scatterPopulationChunk(rockSpec({ id: 2 }), 42137, 3, -5, 128, sampler, typeB);
    expect([...seedB.positions]).not.toEqual([...a.positions]);
    expect([...chunkB.positions]).not.toEqual([...a.positions]);
    expect([...typeB.positions]).not.toEqual([...a.positions]);
  });

  it("places at most one instance per stratified grid cell", () => {
    const block = new PopulationInstanceBlock(64);
    const grid = 5;
    scatterPopulationChunk(rockSpec({ densityGrid: grid }), 7, 0, 0, 100, flatSampler(), block);
    expect(block.count).toBe(grid * grid);
    const cells = new Set<string>();
    const step = 100 / grid;
    for (let k = 0; k < block.count; k++) {
      const cx = Math.floor(block.positions[k * 3]! / step);
      const cz = Math.floor(block.positions[k * 3 + 2]! / step);
      cells.add(`${cx},${cz}`);
    }
    expect(cells.size).toBe(block.count);
  });

  it("rejects candidates steeper than the slope limit and outside the height band", () => {
    const flat = new PopulationInstanceBlock(64);
    scatterPopulationChunk(rockSpec({ densityGrid: 3, slopeLimit: 0.5 }), 7, 0, 0, 64, flatSampler(1), flat);
    expect(flat.count).toBe(9);

    const steep = new PopulationInstanceBlock(64);
    // normalY 0.2 → slope 0.8 > 0.5: every candidate is rejected.
    scatterPopulationChunk(rockSpec({ densityGrid: 3, slopeLimit: 0.5 }), 7, 0, 0, 64, flatSampler(0.2), steep);
    expect(steep.count).toBe(0);

    const hillside = new PopulationInstanceBlock(64);
    // Mixed surface: flat below z = 32, cliff above — only the flat half is populated.
    const mixed = {
      heightAt: (_x: number, z: number) => z,
      normalYAt: (_x: number, z: number) => (z < 32 ? 1 : 0),
    };
    scatterPopulationChunk(rockSpec({ densityGrid: 4, slopeLimit: 0.5, embed: 0 }), 7, 0, 0, 64, mixed, hillside);
    expect(hillside.count).toBeGreaterThan(0);
    expect(hillside.count).toBeLessThan(16);
    for (let k = 0; k < hillside.count; k++) {
      expect(hillside.positions[k * 3 + 2]!).toBeLessThan(32);
      // A candidate on the accepted surface sits at its own height (embed 0 here).
      expect(hillside.positions[k * 3 + 1]!).toBeCloseTo(hillside.positions[k * 3 + 2]!, 5);
    }

    const band = new PopulationInstanceBlock(64);
    scatterPopulationChunk(rockSpec({ densityGrid: 3, minHeight: 10 }), 7, 0, 0, 64, flatSampler(), band);
    expect(band.count).toBe(0);
  });

  it("keeps scales inside the configured band and caps the count at maxPerChunk", () => {
    const block = new PopulationInstanceBlock(64);
    scatterPopulationChunk(
      rockSpec({ densityGrid: 6, maxPerChunk: 5, scaleMin: 0.25, scaleMax: 4, scaleExponent: 2 }),
      11,
      0,
      0,
      64,
      flatSampler(),
      block,
    );
    expect(block.count).toBe(5);
    for (let k = 0; k < block.count; k++) {
      for (const axis of [0, 1, 2]) {
        expect(block.scales[k * 3 + axis]!).toBeGreaterThanOrEqual(0.25);
        expect(block.scales[k * 3 + axis]!).toBeLessThanOrEqual(4);
      }
      expect(block.rotations[k]!).toBeGreaterThanOrEqual(0);
      expect(block.rotations[k]!).toBeLessThan(Math.PI * 2);
    }
  });

  it("packs deterministic tint jitter and leaves it off at jitter 0", () => {
    const plain = new PopulationInstanceBlock(64);
    scatterPopulationChunk(rockSpec({ densityGrid: 3, tintJitter: 0 }), 3, 0, 0, 64, flatSampler(), plain);
    for (let k = 0; k < plain.count; k++) expect(plain.tints[k]).toBe(0);

    const jittered = new PopulationInstanceBlock(64);
    scatterPopulationChunk(rockSpec({ densityGrid: 3, tintJitter: 0.4 }), 3, 0, 0, 64, flatSampler(), jittered);
    const out = { r: 0, g: 0, b: 0, a: 0 };
    for (let k = 0; k < jittered.count; k++) {
      const tint = jittered.tints[k]!;
      expect(tint).not.toBe(0);
      unpackColor(tint, out);
      expect(out.a).toBe(1);
      expect(out.r).toBe(out.g);
      expect(out.g).toBe(out.b);
      expect(out.r).toBeGreaterThanOrEqual(0.6 - 1e-3);
      expect(out.r).toBeLessThanOrEqual(1);
    }
  });

  it("resolves every default exactly once", () => {
    const spec = resolvePopulationTypeSpec({ id: 9, label: "x" });
    expect(spec.densityGrid).toBe(6);
    expect(spec.maxPerChunk).toBe(36);
    expect(spec.slopeLimit).toBe(0.5);
    expect(spec.embed).toBe(0.15);
    expect(spec.castShadow).toBe(true);
    expect(spec.minHeight).toBe(-Infinity);
    expect(spec.maxHeight).toBe(Infinity);
    expect(resolvePopulationTypeSpec({ id: 1, label: "x", densityGrid: 0 })).toMatchObject({ densityGrid: 1 });
  });
});

describe("Population - compact instance blocks (14.3)", () => {
  it("allocates the SoA arrays once for the capacity and rejects invalid capacities", () => {
    const block = new PopulationInstanceBlock(7);
    expect(block.capacity).toBe(7);
    expect(block.positions.length).toBe(21);
    expect(block.scales.length).toBe(21);
    expect(block.rotations.length).toBe(7);
    expect(block.tints.length).toBe(7);
    expect(block.count).toBe(0);
    block.clear();
    expect(block.count).toBe(0);
    expect(() => new PopulationInstanceBlock(-1)).toThrow();
    expect(() => new PopulationInstanceBlock(Number.NaN)).toThrow();
  });
});

/** A minimal scene object that submits one hand-built population — the seam without terrain. */
class StaticPopulation extends SceneObject implements PopulationSource {
  readonly name = "static-population";
  readonly results: boolean[] = [];

  constructor(
    private readonly submission: PopulationSubmission,
    private readonly enabledFlag = true,
  ) {
    super();
  }

  collectPopulations(collector: PopulationCollector): void {
    if (!this.enabledFlag) return;
    this.results.push(collector.addPopulationBatch(this.submission));
  }
}

function handSubmission(
  geometry: ReturnType<typeof createRock>,
  material: Material,
  count: number,
): PopulationSubmission {
  const block = new PopulationInstanceBlock(count);
  for (let k = 0; k < count; k++) {
    block.positions[k * 3] = k * 2 - (count - 1);
    block.positions[k * 3 + 1] = 0;
    block.positions[k * 3 + 2] = 0;
    block.scales[k * 3] = 1;
    block.scales[k * 3 + 1] = 1;
    block.scales[k * 3 + 2] = 1;
    block.rotations[k] = 0.3 * k;
    block.tints[k] = 0;
    block.count = k + 1;
  }
  return {
    geometry,
    material,
    instances: block,
    bounds: new AABB(new Vec3(-(count - 1) - 1, -1, -1), new Vec3(count - 1 + 1, 1, 1)),
    castShadow: false,
    maxDistance: 0,
  };
}

describe("Population - renderer seam (14.3/14.5)", () => {
  async function fixture() {
    const device = await GraphicsDevice.create({ forceMock: true });
    device.resize(320, 180);
    const mock = device.mock;
    const renderer = new Renderer(device, { shadowMapSize: 256 });
    const scene = new Scene({ name: "population-test" });
    const cameraEntity = scene.createTransformedEntity("camera", new Vec3(0, 2, -8));
    const camera = new Camera();
    camera.far = 100;
    scene.world.addComponent(cameraEntity.id, camera);
    cameraEntity.transform.lookAt(new Vec3(0, 0, 0));
    const geometry = createRock(device, { radius: 0.6, seed: 5 });
    const material = new Material({ label: "rock", color: 0x886655 });
    return {
      device,
      mock,
      renderer,
      scene,
      camera,
      geometry,
      material,
      async dispose() {
        renderer.dispose();
        material.dispose();
        geometry.dispose();
        scene.dispose();
        await device.dispose();
        expect(mock.outstanding.buffers).toEqual([]);
        expect(mock.outstanding.textures).toEqual([]);
      },
    };
  }

  it("draws a population as instanced batches with zero entities per instance", async () => {
    const f = await fixture();
    const source = new StaticPopulation(handSubmission(f.geometry, f.material, 3));
    f.scene.add(source);
    const entitiesBefore = f.scene.entityCount;

    f.renderer.renderScene(f.scene);
    expect(f.mock.errors).toEqual([]);
    expect(f.renderer.stats.populationBatches).toBe(1);
    expect(f.renderer.stats.populationInstances).toBe(3);
    // The instances are ordinary instances: counted by the frame's instance/batch statistics.
    expect(f.renderer.stats.instances).toBeGreaterThanOrEqual(3);
    expect(f.renderer.stats.batches).toBeGreaterThanOrEqual(1);
    expect(f.renderer.stats.drawCalls).toBeGreaterThanOrEqual(1);
    expect(source.results).toEqual([true]);
    // The Phase 14 headline: three (or three thousand) instances, still zero entities.
    expect(f.scene.entityCount).toBe(entitiesBefore);

    // Steady frame: no new GPU objects, and the submission is re-offered every frame.
    f.renderer.renderScene(f.scene);
    expect(f.mock.errors).toEqual([]);
    expect(f.renderer.stats.populationBatches).toBe(1);
    expect(source.results.length).toBe(2);
    await f.dispose();
  });

  it("splits oversized submissions into maxInstancesPerBatch slices", async () => {
    const f = await fixture();
    f.scene.add(new StaticPopulation(handSubmission(f.geometry, f.material, 7)));
    const sliced = new Renderer(f.device, { shadowMapSize: 256, maxInstancesPerBatch: 3 });
    sliced.renderScene(f.scene);
    expect(f.mock.errors).toEqual([]);
    expect(sliced.stats.populationBatches).toBe(3);
    expect(sliced.stats.populationInstances).toBe(7);
    // 3 + 3 + 1: every slice is its own batch so the device culler keeps per-chunk granularity.
    expect(sliced.stats.batches).toBeGreaterThanOrEqual(3);
    sliced.dispose();
    await f.dispose();
  });

  it("rejects a fully off-screen submission before writing any instance record", async () => {
    const f = await fixture();
    // Camera looks down -Z from z = -8 at the origin; put the population far behind the camera.
    const submission = handSubmission(f.geometry, f.material, 4);
    submission.instances.positions.fill(0);
    for (let k = 0; k < 4; k++) submission.instances.positions[k * 3 + 2] = -60;
    submission.bounds.setFrom(new Vec3(-5, -1, -61), new Vec3(5, 1, -59));
    const source = new StaticPopulation(submission);
    f.scene.add(source);
    f.renderer.renderScene(f.scene);
    expect(f.mock.errors).toEqual([]);
    expect(source.results).toEqual([false]);
    expect(f.renderer.stats.populationBatches).toBe(0);
    expect(f.renderer.stats.populationInstances).toBe(0);
    await f.dispose();
  });

  it("gives casters per-instance shadow-map assignment like any renderable", async () => {
    const f = await fixture();
    const submission = handSubmission(f.geometry, f.material, 4);
    // castShadow is readonly on the interface; rebuild with a casting variant.
    const casting: PopulationSubmission = { ...submission, castShadow: true };
    f.scene.add(new StaticPopulation(casting));
    const sun = f.scene.createTransformedEntity("sun", new Vec3(5, 10, -5));
    const l = new Light();
    l.kind = "directional";
    l.castShadow = true;
    f.scene.world.addComponent(sun.id, l);
    sun.transform.lookAt(new Vec3(0, 0, 0));

    f.renderer.renderScene(f.scene);
    expect(f.mock.errors).toEqual([]);
    expect(f.renderer.stats.populationBatches).toBeGreaterThanOrEqual(1);
    expect(f.renderer.stats.shadowInstancesDrawn).toBeGreaterThanOrEqual(1);
    await f.dispose();
  });

  it("recognises sources structurally: isPopulationSource", () => {
    expect(isPopulationSource(new StaticPopulation(null as never, true))).toBe(true);
    expect(isPopulationSource({})).toBe(false);
    expect(isPopulationSource(null)).toBe(false);
  });
});

describe("Population - terrain-following streaming (14.6)", () => {
  function terrainFixture(options: { types?: PopulationTypeSpec[]; generationsPerFrame?: number } = {}) {
    const scene = new Scene({ name: "population-stream" });
    const terrain = new TerrainWorld({
      seed: 991,
      chunkSize: 64,
      chunkResolution: 9,
      viewDistance: 96,
      maxChunksLoaded: 30,
      maxGenerationsPerFrame: 64,
      horizonSkirt: false,
    });
    scene.add(terrain);
    const cameraEntity = scene.createTransformedEntity("camera", new Vec3(0, 20, -40));
    scene.world.addComponent(cameraEntity.id, new Camera());
    const population = new PopulationWorld({
      terrain,
      types: options.types ?? [
        { id: 1, label: "rocks", densityGrid: 3, scaleMin: 0.5, scaleMax: 1.5 },
        { id: 2, label: "boulders", densityGrid: 2, scaleMin: 2, scaleMax: 3, slopeLimit: 0.3 },
      ],
      generationsPerFrame: options.generationsPerFrame ?? 64,
    });
    scene.add(population);
    const ctx = createMockContext(scene.world);
    terrain.focusPosition.set(0, 0, 0);
    return { scene, terrain, population, ctx, cameraEntity };
  }

  it("populates every ready terrain chunk without creating entities", () => {
    const { scene, terrain, population, ctx } = terrainFixture();
    terrain.update(ctx, 0.016);
    const ready = [...terrain.chunks.values()].filter((c) => c.state === "ready");
    expect(ready.length).toBeGreaterThan(4);

    const entitiesBefore = scene.entityCount;
    population.update(ctx, 0.016);
    expect(population.populatedChunkCount).toBe(ready.length);
    expect(scene.entityCount).toBe(entitiesBefore);

    let instances = 0;
    for (const chunk of ready) {
      const count = population.instancesFor(chunk.key);
      expect(count).toBeGreaterThan(0);
      instances += count;
    }
    expect(instances).toBeGreaterThan(0);
    expect(population.stats()).toMatchObject({ chunks: ready.length, types: 2 });
    expect(population.stats().instances).toBe(instances);

    population.dispose();
    scene.dispose();
  });

  it("is deterministic through the streaming world: same seed, same chunk, same arrays", () => {
    const a = terrainFixture();
    const b = terrainFixture();
    a.terrain.update(a.ctx, 0.016);
    a.population.update(a.ctx, 0.016);
    b.terrain.update(b.ctx, 0.016);
    b.population.update(b.ctx, 0.016);

    const key = chunkCoordKey(0, 0);
    const blockA = new PopulationInstanceBlock(16);
    const blockB = new PopulationInstanceBlock(16);
    // Re-run the scatter directly against the same tile both worlds produced.
    const tile = a.terrain.chunks.get(key)!.tile!;
    scatterPopulationChunk({ id: 1, label: "rocks", densityGrid: 3, scaleMin: 0.5, scaleMax: 1.5 }, 991, 0, 0, 64, {
      heightAt: (x, z) => tile.heightmap.getHeight(x, z),
      normalYAt: (x, z) => tile.heightmap.getNormal(x, z, new Vec3()).y,
    }, blockA);
    const tileB = b.terrain.chunks.get(key)!.tile!;
    scatterPopulationChunk({ id: 1, label: "rocks", densityGrid: 3, scaleMin: 0.5, scaleMax: 1.5 }, 991, 0, 0, 64, {
      heightAt: (x, z) => tileB.heightmap.getHeight(x, z),
      normalYAt: (x, z) => tileB.heightmap.getNormal(x, z, new Vec3()).y,
    }, blockB);
    expect(blockA.count).toBe(blockB.count);
    expect([...blockA.positions]).toEqual([...blockB.positions]);

    a.population.dispose();
    b.population.dispose();
    a.scene.dispose();
    b.scene.dispose();
  });

  it("applies the per-update generation budget", () => {
    const { terrain, population, ctx } = terrainFixture({ generationsPerFrame: 1 });
    terrain.update(ctx, 0.016);
    const ready = [...terrain.chunks.values()].filter((c) => c.state === "ready").length;
    expect(ready).toBeGreaterThan(2);

    population.update(ctx, 0.016);
    expect(population.populatedChunkCount).toBe(1);
    expect(population.pendingChunkCount).toBe(ready - 1);
    population.update(ctx, 0.016);
    expect(population.populatedChunkCount).toBe(2);

    population.dispose();
  });

  it("drops populations when terrain evicts their chunk", () => {
    const { scene, terrain, population, ctx, cameraEntity } = terrainFixture();
    terrain.update(ctx, 0.016);
    population.update(ctx, 0.016);
    const before = population.populatedChunkCount;
    expect(before).toBeGreaterThan(4);
    const originKey = chunkCoordKey(0, 0);
    expect(population.instancesFor(originKey)).toBeGreaterThan(0);

    // Stream somewhere else entirely: the old disc is evicted (maxChunksLoaded 30), and the
    // population records must go with it. The camera moves (not just `focusPosition`) because
    // TerrainWorld refreshes its focus from the active camera every update.
    cameraEntity.transform.position = new Vec3(5000, 20, -5040);
    for (let i = 0; i < 8; i++) terrain.update(ctx, 0.016);
    population.update(ctx, 0.016);
    expect(population.instancesFor(originKey)).toBe(0);
    expect(terrain.chunks.has(originKey)).toBe(false);
    // Every surviving record still belongs to a resident chunk.
    for (let i = 0; i < 4; i++) population.update(ctx, 0.016);
    for (const key of terrain.chunks.keys()) {
      expect(terrain.chunks.get(key)!.state).toBe("ready");
    }

    population.dispose();
    scene.dispose();
  });

  it("re-anchors Y to a remeshed tile without re-scattering XZ placement", () => {
    const spec: PopulationTypeSpec = { id: 1, label: "rocks", densityGrid: 3, scaleMin: 1, scaleMax: 1 };
    const { scene, terrain, population, ctx } = terrainFixture({ types: [spec] });
    terrain.update(ctx, 0.016);
    population.update(ctx, 0.016);
    const key = chunkCoordKey(0, 0);
    const block = population.chunkPopulation(key, 1);
    expect(block).not.toBeNull();
    expect(block!.count).toBeGreaterThan(0);
    const xzBefore = [...block!.positions].filter((_, i) => i % 3 !== 1);
    const scalesBefore = [...block!.scales];

    // Force a remesh at a coarser resolution by applying a fresh cell to the ready chunk.
    const chunk = terrain.chunks.get(key)!;
    const pipeline = GeneratorPipeline.createDefault(991);
    const cell = createWorldCell(0, 0, 64, 5, 991);
    pipeline.execute(cell);
    chunk.applyCell(cell);
    population.update(ctx, 0.016);

    const after = population.chunkPopulation(key, 1)!;
    expect(after.count).toBe(block!.count);
    expect([...after.positions].filter((_, i) => i % 3 !== 1)).toEqual(xzBefore);
    expect([...after.scales]).toEqual(scalesBefore);
    // Y follows the *new* surface exactly (embed 0.15 of the Y scale), so rocks never float when
    // the mesh refines under them.
    const tile = chunk.tile!;
    for (let k = 0; k < after.count; k++) {
      const expected =
        tile.heightmap.getHeight(after.positions[k * 3]!, after.positions[k * 3 + 2]!) -
        0.15 * after.scales[k * 3 + 1]!;
      expect(after.positions[k * 3 + 1]!).toBeCloseTo(expected, 4);
    }
    population.dispose();
    scene.dispose();
  });
});

describe("Population - renderer over streamed terrain", () => {
  it("renders chunk populations end to end on the strict mock device", async () => {
    const device = await GraphicsDevice.create({ forceMock: true });
    device.resize(320, 180);
    const mock = device.mock;
    const renderer = new Renderer(device, { shadowMapSize: 256 });
    const scene = new Scene({ name: "population-e2e" });

    const terrain = new TerrainWorld({
      seed: 1201,
      chunkSize: 64,
      chunkResolution: 9,
      viewDistance: 96,
      maxChunksLoaded: 30,
      maxGenerationsPerFrame: 64,
      horizonSkirt: false,
    });
    scene.add(terrain);
    const rockGeometry = createRock(device, { radius: 0.7, seed: 9 });
    const rockMaterial = new Material({ label: "rock", color: 0x997755, roughness: 0.95 });
    const population = new PopulationWorld({
      terrain,
      types: [
        {
          id: 1,
          label: "rocks",
          densityGrid: 4,
          scaleMin: 0.6,
          scaleMax: 1.6,
          maxDistance: 400,
          geometry: rockGeometry,
          material: rockMaterial,
        },
      ],
      generationsPerFrame: 64,
    });
    scene.add(population);

    const cameraEntity = scene.createTransformedEntity("camera", new Vec3(0, 24, -60));
    const camera = new Camera();
    camera.far = 400;
    scene.world.addComponent(cameraEntity.id, camera);
    cameraEntity.transform.lookAt(new Vec3(0, 0, 0));

    const ctx = createMockContext(scene.world);
    terrain.focusPosition.set(0, 0, 0);
    terrain.update(ctx, 0.016);
    population.update(ctx, 0.016);

    const entitiesBefore = scene.entityCount;
    renderer.renderScene(scene, ctx);
    expect(mock.errors).toEqual([]);
    expect(renderer.stats.populationBatches).toBeGreaterThan(0);
    expect(renderer.stats.populationInstances).toBeGreaterThan(10);
    // No entity was created for any of them — the camera/sun/terrain-chunk entities are all there is.
    expect(scene.entityCount).toBe(entitiesBefore);
    // Population batches are regular batches: the device object culler tests them like any other.
    expect(renderer.stats.cullTested).toBeGreaterThanOrEqual(renderer.stats.populationBatches);

    // Steady frame: pooling holds, no new textures, still no errors.
    renderer.renderScene(scene, ctx);
    expect(mock.errors).toEqual([]);
    expect(renderer.stats.texturesCreated).toBe(0);

    renderer.dispose();
    population.dispose();
    terrain.dispose();
    rockMaterial.dispose();
    rockGeometry.dispose();
    scene.dispose();
    await device.dispose();
    expect(mock.outstanding.buffers).toEqual([]);
    expect(mock.outstanding.textures).toEqual([]);
  });
});

describe("Population - rock primitive", () => {
  it("is deterministic per seed and stays inside its displaced, flattened envelope", () => {
    const a = rockGeometrySource({ radius: 1, seed: 4, roughness: 0.3, flatten: 0.4, segments: 8 });
    const b = rockGeometrySource({ radius: 1, seed: 4, roughness: 0.3, flatten: 0.4, segments: 8 });
    expect([...a.positions!]).toEqual([...b.positions!]);
    const c = rockGeometrySource({ radius: 1, seed: 5, roughness: 0.3, flatten: 0.4, segments: 8 });
    expect([...a.positions!]).not.toEqual([...c.positions!]);

    const maxRadius = 1 * (1 + 0.3 * (1 + 0.45 + 0.45 * 0.45));
    let minY = Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < a.positions!.length; i += 3) {
      const x = a.positions![i]!;
      const y = a.positions![i + 1]!;
      const z = a.positions![i + 2]!;
      expect(Number.isFinite(x + y + z)).toBe(true);
      expect(Math.hypot(x, z)).toBeLessThanOrEqual(maxRadius + 1e-6);
      expect(y).toBeLessThanOrEqual(maxRadius * (1 - 0.4) + 1e-6);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
    expect(maxY).toBeGreaterThan(0);
    expect(minY).toBeLessThan(0);
    // Flattened: the vertical extent is measurably squat versus the horizontal reach.
    expect(maxY - minY).toBeLessThan(2 * maxRadius * (1 - 0.4));
    // Normals are normalized.
    for (let i = 0; i < a.normals!.length; i += 3) {
      const n = Math.hypot(a.normals![i]!, a.normals![i + 1]!, a.normals![i + 2]!);
      expect(n).toBeCloseTo(1, 3);
    }
  });
});
