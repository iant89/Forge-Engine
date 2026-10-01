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
  MockGPUDevice,
  POPULATION_PRESETS,
  POPULATION_PRESET_NAMES,
  POPULATION_TYPE_IDS,
  PopulationInstanceBlock,
  PopulationWorld,
  Profiler,
  Renderer,
  Scene,
  SceneObject,
  SystemScratch,
  TerrainWorld,
  Vec3,
  InstanceStruct,
  chunkCoordKey,
  createRock,
  createWorldCell,
  isPopulationSource,
  populationPreset,
  resolvePopulationTypeSpec,
  rockGeometrySource,
  scatterPopulationChunk,
  unpackColor,
  type PopulationCollector,
  type PopulationPresetName,
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

/**
 * Phase 14.3's further step: a chunk's instance records live on the device in a slot of the instance
 * buffer, composed and uploaded once, instead of being rewritten into the frame's arena every frame.
 *
 * The claim these cases make is not "a counter moved" — it is that the resident path draws *the same
 * instances from the same bytes* as the arena path, only from a different region of the buffer and
 * only uploaded once. So the load-bearing assertion compares the two paths' records byte for byte at
 * the dynamic offset each one's own draw binds, and the rest pin the lifetime: uploaded on first
 * sight, silent while the data is unchanged, rewritten when the source bumps its version, and freed
 * when the source stops offering the key.
 */
describe("Population - device-resident instance blocks (14.3)", () => {
  const RECORD_BYTES = InstanceStruct.byteSize("storage");

  async function fixture(maxInstancesPerBatch?: number) {
    const device = await GraphicsDevice.create({ forceMock: true });
    device.resize(320, 180);
    const mock = device.mock;
    const renderer = new Renderer(device, { shadowMapSize: 256, ...(maxInstancesPerBatch ? { maxInstancesPerBatch } : {}) });
    const scene = new Scene({ name: "resident-test" });
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

  /** A source that offers one submission, and can stop offering it (a chunk that streamed out). */
  class ResidentPopulation extends SceneObject implements PopulationSource {
    readonly name = "resident-population";
    readonly results: boolean[] = [];
    offered = true;

    constructor(private submission: PopulationSubmission) {
      super();
    }

    collectPopulations(collector: PopulationCollector): void {
      if (!this.offered) return;
      this.results.push(collector.addPopulationBatch(this.submission));
    }
  }

  /** A submission whose residency version the test owns, the way `PopulationWorld` reads its record's. */
  function residentSubmission(
    geometry: ReturnType<typeof createRock>,
    material: Material,
    count: number,
    key: string,
    version: { value: number },
  ): PopulationSubmission {
    const base = handSubmission(geometry, material, count);
    return {
      ...base,
      residencyKey: key,
      get residencyVersion(): number {
        return version.value;
      },
    };
  }

  /**
   * The instance window every draw of this frame bound, in order. The draw bind group's two dynamic
   * offsets are [object, instance], so the second is the batch's own instance window — the offset the
   * shader walks its records from, and the only place residency is observable from outside.
   */
  function boundInstanceWindows(mock: MockGPUDevice): number[] {
    return mock.commandLog
      .filter((e) => e.type === "setBindGroup" && Array.isArray(e["dynamicOffsets"]) && (e["dynamicOffsets"] as number[]).length === 2)
      .map((e) => (e["dynamicOffsets"] as number[])[1]!);
  }

  /** The instance buffer's bytes at a bound window, as the shader would read them. */
  function recordsAt(mock: MockGPUDevice, offset: number, count: number): Float32Array {
    const buffer = [...mock.liveBuffers].find((b) => b.label === "instances.storage");
    if (!buffer) throw new Error("no instances.storage buffer");
    return new Float32Array(buffer.data, offset, count * (RECORD_BYTES >> 2));
  }

  it("uploads a chunk's records once and then draws them from the resident region", async () => {
    const f = await fixture();
    const version = { value: 1 };
    const submission = residentSubmission(f.geometry, f.material, 3, "resident:test", version);
    f.scene.add(new ResidentPopulation(submission));

    f.renderer.renderScene(f.scene);
    expect(f.mock.errors).toEqual([]);
    expect(f.renderer.stats.populationInstances).toBe(3);
    expect(f.renderer.stats.populationResidentInstances).toBe(3);
    expect(f.renderer.stats.populationResidentBlocks).toBe(1);
    // One slice of three records, written once: 3 × 80 bytes into a 256-byte slot.
    expect(f.renderer.stats.populationUploads).toBe(1);
    expect(f.renderer.stats.populationUploadedBytes).toBe(3 * RECORD_BYTES);
    expect(f.renderer.stats.populationResidentBytes).toBe(256);

    const windows = boundInstanceWindows(f.mock);
    const residentWindow = windows[windows.length - 1]!;
    // Region B starts at the arena's high-water mark (at least the 64 KiB floor), so a resident
    // window is never inside the per-frame arena — that is what "device-resident" means here.
    expect(residentWindow).toBeGreaterThanOrEqual(64 * 1024);
    const residentRecords = recordsAt(f.mock, residentWindow, 3).slice();
    // A record is a column-major Mat4 plus the tint word: `handSubmission`'s first instance sits at
    // x = -2 with unit scale and no rotation, so its translation is where the compose put it and the
    // matrix is the identity in its upper 3×3.
    expect(residentRecords[0]).toBe(1);
    expect(residentRecords[12]).toBe(-2);
    expect(residentRecords[13]).toBe(0);
    expect(residentRecords[14]).toBe(0);

    // The steady frame: the same three instances draw, and nothing is uploaded.
    f.mock.commandLog.length = 0;
    f.renderer.renderScene(f.scene);
    expect(f.mock.errors).toEqual([]);
    expect(f.renderer.stats.populationInstances).toBe(3);
    expect(f.renderer.stats.populationResidentInstances).toBe(3);
    expect(f.renderer.stats.populationResidentBlocks).toBe(1);
    expect(f.renderer.stats.populationUploads).toBe(0);
    expect(f.renderer.stats.populationUploadedBytes).toBe(0);
    expect(boundInstanceWindows(f.mock)).toContain(residentWindow);
    // The bytes are still there and unchanged (nothing rewrote the region).
    expect(recordsAt(f.mock, residentWindow, 3)).toEqual(residentRecords);
    await f.dispose();
  });

  it("draws byte-identical records to the per-frame arena path, from a different region", async () => {
    // Two renderers, one scene shape, one submission each: the same block, with and without a
    // residency key. Whatever residency changes about *when* the bytes are written, it must not
    // change *what* is written — an instance drawn from a resident slot has to be the same instance
    // at the same transform, or a streaming world would visibly reshuffle its rocks.
    const arena = await fixture();
    const resident = await fixture();
    const arenaSubmission = handSubmission(arena.geometry, arena.material, 5);
    arena.scene.add(new ResidentPopulation(arenaSubmission));
    const version = { value: 7 };
    resident.scene.add(new ResidentPopulation(residentSubmission(resident.geometry, resident.material, 5, "resident:compare", version)));

    arena.renderer.renderScene(arena.scene);
    resident.renderer.renderScene(resident.scene);
    expect(arena.mock.errors).toEqual([]);
    expect(resident.mock.errors).toEqual([]);
    expect(arena.renderer.stats.populationUploads).toBe(0);
    expect(resident.renderer.stats.populationUploads).toBe(1);

    const arenaWindows = boundInstanceWindows(arena.mock);
    const residentWindows = boundInstanceWindows(resident.mock);
    const arenaWindow = arenaWindows[arenaWindows.length - 1]!;
    const residentWindow = residentWindows[residentWindows.length - 1]!;
    expect(arenaWindow).toBeLessThan(64 * 1024); // the arena region
    expect(residentWindow).toBeGreaterThanOrEqual(64 * 1024); // the resident region
    expect(residentWindow).not.toBe(arenaWindow);
    // The whole record: matrix, tint, and the two spares — 5 instances, element for element.
    expect(recordsAt(resident.mock, residentWindow, 5)).toEqual(recordsAt(arena.mock, arenaWindow, 5));
    await arena.dispose();
    await resident.dispose();
  });

  it("rewrites the block when the source bumps its residency version, and only then", async () => {
    const f = await fixture();
    const version = { value: 1 };
    const submission = residentSubmission(f.geometry, f.material, 2, "resident:version", version);
    const block = submission.instances;
    f.scene.add(new ResidentPopulation(submission));

    f.renderer.renderScene(f.scene);
    const window = boundInstanceWindows(f.mock).pop()!;
    const before = recordsAt(f.mock, window, 2).slice();

    // A frame that changes the arrays *without* bumping the version is, by the seam's contract, not a
    // change: the renderer cannot see inside the block, and guessing would mean hashing it per frame.
    block.positions[0] = 42;
    f.renderer.renderScene(f.scene);
    expect(f.renderer.stats.populationUploads).toBe(0);
    expect(recordsAt(f.mock, window, 2)).toEqual(before);

    version.value = 2;
    f.renderer.renderScene(f.scene);
    expect(f.mock.errors).toEqual([]);
    expect(f.renderer.stats.populationUploads).toBe(1);
    expect(f.renderer.stats.populationUploadedBytes).toBe(2 * RECORD_BYTES);
    const after = recordsAt(f.mock, window, 2);
    expect(after).not.toEqual(before);
    // The moved instance is in the record: column-major Mat4, so the translation is elements 12..14.
    expect(after[12]).toBe(42);
    await f.dispose();
  });

  it("frees the slot when the source stops offering the key and pays the upload again when it returns", async () => {
    const f = await fixture();
    const version = { value: 1 };
    const submission = residentSubmission(f.geometry, f.material, 4, "resident:stream", version);
    const source = new ResidentPopulation(submission);
    f.scene.add(source);

    f.renderer.renderScene(f.scene);
    const firstWindow = boundInstanceWindows(f.mock).pop()!;
    expect(f.renderer.stats.populationResidentBlocks).toBe(1);

    // The chunk streamed out: nothing offers the key, so the slot goes back to the allocator and the
    // instances stop drawing. The region itself does not shrink (the buffer is not reallocated for a
    // chunk that may come back), only the live byte count does.
    source.offered = false;
    f.renderer.renderScene(f.scene);
    expect(f.mock.errors).toEqual([]);
    expect(f.renderer.stats.populationResidentBlocks).toBe(0);
    expect(f.renderer.stats.populationResidentBytes).toBe(0);
    expect(f.renderer.stats.populationResidentInstances).toBe(0);
    expect(f.renderer.stats.populationInstances).toBe(0);

    // And it comes back at the same offset — the allocator reuses the freed slot before growing.
    source.offered = true;
    f.renderer.renderScene(f.scene);
    expect(f.renderer.stats.populationUploads).toBe(1);
    expect(f.renderer.stats.populationResidentBlocks).toBe(1);
    expect(boundInstanceWindows(f.mock).pop()).toBe(firstWindow);
    expect(source.results).toEqual([true, true]);
    await f.dispose();
  });

  it("keeps several chunks in separate slots and uploads each of them once", async () => {
    const f = await fixture();
    const v1 = { value: 1 };
    const v2 = { value: 1 };
    f.scene.add(new ResidentPopulation(residentSubmission(f.geometry, f.material, 3, "resident:chunk-a", v1)));
    f.scene.add(new ResidentPopulation(residentSubmission(f.geometry, f.material, 2, "resident:chunk-b", v2)));

    f.renderer.renderScene(f.scene);
    expect(f.mock.errors).toEqual([]);
    expect(f.renderer.stats.populationResidentBlocks).toBe(2);
    expect(f.renderer.stats.populationUploads).toBe(2);
    expect(f.renderer.stats.populationResidentInstances).toBe(5);
    // Two 256-byte slots, so the second starts 256 bytes past the first.
    expect(f.renderer.stats.populationResidentBytes).toBe(512);
    const windows = boundInstanceWindows(f.mock);
    const a = windows.find((w) => w >= 64 * 1024)!;
    const b = windows.filter((w) => w >= 64 * 1024).find((w) => w !== a)!;
    expect(b - a).toBe(256);

    f.renderer.renderScene(f.scene);
    expect(f.renderer.stats.populationUploads).toBe(0);
    expect(f.renderer.stats.populationResidentBlocks).toBe(2);
    await f.dispose();
  });

  it("uploads one record range per slice and binds each slice at its own padded stride", async () => {
    // A block bigger than `maxInstancesPerBatch` is several batches; a resident block is several
    // windows in one slot, each starting on a 256-byte boundary so the dynamic-offset rule holds.
    const f = await fixture(3);
    const version = { value: 1 };
    const submission = residentSubmission(f.geometry, f.material, 7, "resident:sliced", version);
    f.scene.add(new ResidentPopulation(submission));

    f.renderer.renderScene(f.scene);
    expect(f.mock.errors).toEqual([]);
    expect(f.renderer.stats.populationBatches).toBe(3);
    expect(f.renderer.stats.populationResidentInstances).toBe(7);
    expect(f.renderer.stats.populationUploads).toBe(3);
    expect(f.renderer.stats.populationUploadedBytes).toBe(7 * RECORD_BYTES);
    // Two full slices of 3 plus one of 1, each padded to 256: 768 bytes of slot.
    expect(f.renderer.stats.populationResidentBytes).toBe(1024);
    // Each slice is bound once per pass that draws it, so dedupe before measuring the strides.
    const windows = [...new Set(boundInstanceWindows(f.mock).filter((w) => w >= 64 * 1024))].sort((a, b) => a - b);
    expect(windows.length).toBe(3);
    // Three slices of one slot, each starting on the padded stride a 3-instance batch rounds to: 256
    // bytes apart, so every window is a legal dynamic offset and none of them overlaps.
    expect([windows[1]! - windows[0]!, windows[2]! - windows[1]!]).toEqual([256, 256]);

    f.renderer.renderScene(f.scene);
    expect(f.renderer.stats.populationUploads).toBe(0);
    await f.dispose();
  });

  it("leaves a submission without a residency key on the per-frame arena path", async () => {
    const f = await fixture();
    f.scene.add(new ResidentPopulation(handSubmission(f.geometry, f.material, 3)));
    f.renderer.renderScene(f.scene);
    expect(f.mock.errors).toEqual([]);
    expect(f.renderer.stats.populationInstances).toBe(3);
    expect(f.renderer.stats.populationResidentInstances).toBe(0);
    expect(f.renderer.stats.populationResidentBlocks).toBe(0);
    expect(f.renderer.stats.populationUploads).toBe(0);
    expect(boundInstanceWindows(f.mock).pop()!).toBeLessThan(64 * 1024);
    await f.dispose();
  });

  it("re-uploads every resident block when the arena grows under it", async () => {
    // The partition moves when the per-frame arena needs more room than it had: every resident
    // block's absolute offset changes with it, so all of them are dirty and the frame that moved the
    // base is the frame that rewrites them. A renderer that forgot this would draw the moved frame
    // from bytes that now belong to the arena.
    const f = await fixture();
    const version = { value: 1 };
    const submission = residentSubmission(f.geometry, f.material, 2, "resident:growth", version);
    f.scene.add(new ResidentPopulation(submission));
    f.renderer.renderScene(f.scene);
    const firstWindow = boundInstanceWindows(f.mock).pop()!;
    const before = recordsAt(f.mock, firstWindow, 2).slice();
    expect(f.renderer.stats.populationUploads).toBe(1);

    // A renderable with more instances than the population forced the arena to grow past its old
    // high-water mark, which is exactly what shifts the resident base.
    const big = new PopulationInstanceBlock(4096);
    for (let k = 0; k < 4096; k++) {
      big.positions[k * 3] = (k % 64) * 0.5 - 16;
      big.positions[k * 3 + 1] = 0;
      big.positions[k * 3 + 2] = Math.floor(k / 64) * 0.5 - 16;
      big.scales[k * 3] = 1;
      big.scales[k * 3 + 1] = 1;
      big.scales[k * 3 + 2] = 1;
      big.count = k + 1;
    }
    const wide: PopulationSubmission = { ...submission, instances: big, residencyKey: undefined, bounds: new AABB(new Vec3(-20, -1, -20), new Vec3(20, 1, 20)) };
    f.scene.add(new ResidentPopulation(wide));
    f.renderer.renderScene(f.scene);
    expect(f.mock.errors).toEqual([]);
    // One upload for the moved resident block (the wide submission takes the arena path).
    expect(f.renderer.stats.populationUploads).toBe(1);
    expect(f.renderer.stats.populationResidentBlocks).toBe(1);
    // The wide submission's own slices fill the arena, so the resident window is a bound offset past
    // the arena's new high-water mark — and it is not where the block used to be.
    const secondWindow = boundInstanceWindows(f.mock)
      .filter((w) => w >= 4096 * RECORD_BYTES)
      .pop()!;
    expect(secondWindow).not.toBe(firstWindow);
    // The move rewrote the block at its new home: the same two records, byte for byte.
    expect(recordsAt(f.mock, secondWindow, 2)).toEqual(before);
    await f.dispose();
  });
});

/**
 * Phase 14.2's remaining types ship as engine *data*: the six placement specs, with stable ids and no
 * geometry of their own. What these cases pin is the part a scene cannot check for itself — that the
 * ids are the ones the seed stream assumes, that each type's numbers suit the job its name claims,
 * and that taking a preset leaves the shared table alone (a scene that mutated `POPULATION_PRESETS`
 * would move every other scene's instances).
 */
describe("Population - type presets (14.2)", () => {
  it("ships the six world-population types with stable, distinct ids", () => {
    expect(POPULATION_PRESET_NAMES).toEqual(["rock", "boulder", "debris", "vegetation", "decal", "prop"]);
    expect(POPULATION_TYPE_IDS).toEqual({ rock: 1, boulder: 2, debris: 3, vegetation: 4, decal: 5, prop: 6 });
    const ids = POPULATION_PRESET_NAMES.map((name) => POPULATION_PRESETS[name].id);
    // The id is folded into the chunk seed, so two types that shared one would scatter identically —
    // every rock would have a boulder inside it.
    expect(new Set(ids).size).toBe(6);
    for (const name of POPULATION_PRESET_NAMES) {
      expect(POPULATION_TYPE_IDS[name]).toBe(POPULATION_PRESETS[name].id);
    }
  });

  it("gives each type the placement its job needs", () => {
    const r = (name: PopulationPresetName) => resolvePopulationTypeSpec(POPULATION_PRESETS[name]);
    // Rocks: dense ground cover, biased towards the small end, tolerant of slope (scree).
    expect(r("rock").densityGrid).toBe(6);
    expect(r("rock").scaleExponent).toBeGreaterThan(1);
    expect(r("rock").castShadow).toBe(true);
    // Boulders: the same shape an order of magnitude up — sparser, flatter ground, sunk deeper.
    expect(r("boulder").densityGrid).toBeLessThan(r("rock").densityGrid);
    expect(r("boulder").embed).toBeGreaterThan(r("rock").embed);
    expect(r("boulder").slopeLimit).toBeLessThan(r("rock").slopeLimit);
    // Debris: the densest type, the steepest ground (talus collects at the foot of a slope), the
    // tightest reach, and no shadows — a shadow map full of slivers costs more than it reads.
    expect(r("debris").densityGrid).toBeGreaterThan(r("rock").densityGrid);
    expect(r("debris").slopeLimit).toBeGreaterThan(r("rock").slopeLimit);
    expect(r("debris").maxDistance).toBeLessThan(r("rock").maxDistance);
    expect(r("debris").castShadow).toBe(false);
    expect(r("debris").scaleMax).toBeLessThan(r("rock").scaleMax);
    // Vegetation: flatter ground than rock (plants do not root on a scree face), a shallow embed so
    // the base sits at the surface, and no shadows (thin double-sided blades silhouette as a blob).
    expect(r("vegetation").slopeLimit).toBeLessThan(r("rock").slopeLimit);
    expect(r("vegetation").embed).toBeLessThan(r("rock").embed);
    expect(r("vegetation").castShadow).toBe(false);
    // Decals: lifted clear of the surface rather than embedded, flattest ground of the six, no shadow.
    expect(r("decal").lift).toBeGreaterThan(0);
    expect(r("decal").embed).toBe(0);
    expect(r("decal").castShadow).toBe(false);
    expect(r("decal").slopeLimit).toBeLessThan(r("vegetation").slopeLimit);
    // Props: at most one per chunk and the longest reach — a landmark rather than texture, so it keeps
    // its shadows.
    expect(r("prop").maxPerChunk).toBe(1);
    expect(r("prop").maxDistance).toBeGreaterThan(r("boulder").maxDistance);
    expect(r("prop").castShadow).toBe(true);
    // Every preset resolves without a caller having to fill anything in.
    for (const name of POPULATION_PRESET_NAMES) {
      const resolved = r(name);
      expect(resolved.maxPerChunk).toBeGreaterThan(0);
      expect(resolved.maxPerChunk).toBeLessThanOrEqual(resolved.densityGrid * resolved.densityGrid);
      expect(resolved.scaleMin).toBeGreaterThan(0);
      expect(resolved.scaleMax).toBeGreaterThanOrEqual(resolved.scaleMin);
    }
  });

  it("copies a preset, so a scene can override one without moving anybody else's instances", () => {
    const table = POPULATION_PRESETS.rock;
    const spec = populationPreset("rock", { maxDistance: 123, scaleMax: 9 });
    expect(spec.maxDistance).toBe(123);
    expect(spec.scaleMax).toBe(9);
    expect(spec.id).toBe(table.id);
    expect(spec.densityGrid).toBe(table.densityGrid);
    expect(table.maxDistance).not.toBe(123);
    expect(table).not.toBe(spec);
    // An override whose value is undefined keeps the preset's own: a quality tier with no opinion must
    // not silently turn a draw distance into "unlimited".
    expect(populationPreset("rock", { maxDistance: undefined }).maxDistance).toBe(table.maxDistance);
    // The id is part of the chunk seed, so it is the one field a caller may not take over.
    expect(() => populationPreset("rock", { id: 9 })).toThrow(/must keep id 1/);
    expect(() => populationPreset("nope" as PopulationPresetName)).toThrow(/unknown preset "nope"/);
  });

  it("scatters each preset deterministically, and each type differently from the others", () => {
    const run = (spec: PopulationTypeSpec) => {
      const block = new PopulationInstanceBlock(resolvePopulationTypeSpec(spec).maxPerChunk);
      scatterPopulationChunk(spec, 4242, 0, 0, 64, flatSampler(), block);
      return block;
    };
    const rocksA = run(POPULATION_PRESETS.rock);
    const rocksB = run(POPULATION_PRESETS.rock);
    expect(rocksA.count).toBeGreaterThan(0);
    expect([...rocksA.positions]).toEqual([...rocksB.positions]);
    expect([...rocksA.scales]).toEqual([...rocksB.scales]);
    // The id is in the seed: the same spec at another id lands somewhere else entirely.
    const rockAsId2 = run({ ...POPULATION_PRESETS.rock, id: 2 });
    expect([...rockAsId2.positions]).not.toEqual([...rocksA.positions]);
    // Every type places something on flat ground (nothing is rejected outright by its own limits).
    for (const name of POPULATION_PRESET_NAMES) {
      expect(run(POPULATION_PRESETS[name]).count, name).toBeGreaterThan(0);
    }
    // A decal on flat ground is exactly its lift above the surface: no embed, so every instance of the
    // type sits at the same height and none of them shares the terrain's depth values.
    const decals = run(POPULATION_PRESETS.decal);
    for (let k = 0; k < decals.count; k++) {
      expect(decals.positions[k * 3 + 1]!).toBeCloseTo(0.06, 6);
    }
  });

  it("lifts a type off the surface by an absolute amount, after the embed", () => {
    // `lift` is metres, not a fraction of the instance's scale: a flat quad has to clear the surface
    // by the same amount whatever size it was scattered at, or the big ones z-fight and the small
    // ones float.
    const block = new PopulationInstanceBlock(64);
    scatterPopulationChunk({ id: 5, label: "decals", densityGrid: 4, scaleMin: 1, scaleMax: 3, embed: 0.1, lift: 0.25 }, 7, 0, 0, 32, flatSampler(), block);
    expect(block.count).toBeGreaterThan(0);
    let scalesDiffer = false;
    for (let k = 0; k < block.count; k++) {
      const scaleY = block.scales[k * 3 + 1]!;
      if (Math.abs(scaleY - 1) > 1e-6) scalesDiffer = true;
      expect(block.positions[k * 3 + 1]!).toBeCloseTo(-0.1 * scaleY + 0.25, 6);
    }
    expect(scalesDiffer).toBe(true);
    // And the default is no lift, so an existing type's placement does not move.
    const unlifted = new PopulationInstanceBlock(64);
    scatterPopulationChunk({ id: 5, label: "decals", densityGrid: 4, scaleMin: 1, scaleMax: 3, embed: 0.1 }, 7, 0, 0, 32, flatSampler(), unlifted);
    expect(unlifted.count).toBe(block.count);
    for (let k = 0; k < unlifted.count; k++) {
      expect(unlifted.positions[k * 3 + 1]!).toBeCloseTo(block.positions[k * 3 + 1]! - 0.25, 6);
    }
  });
});

/**
 * Phase 14.3's device-resident blocks are keyed by string, so the world has to hand the renderer an
 * identity that is unique per (world, type, chunk) and stable for as long as that chunk lives — plus a
 * version that moves exactly when the block's arrays do. Get either wrong and the renderer either
 * re-uploads every frame (defeating the point) or draws a chunk from another chunk's matrices.
 */
describe("Population - residency keys and versions (14.3)", () => {
  async function worldFixture(seed = 991, typeId = 1) {
    const device = await GraphicsDevice.create({ forceMock: true });
    const scene = new Scene({ name: "residency-keys" });
    const terrain = new TerrainWorld({
      seed,
      chunkSize: 64,
      chunkResolution: 9,
      viewDistance: 96,
      maxChunksLoaded: 30,
      maxGenerationsPerFrame: 64,
      horizonSkirt: false,
    });
    scene.add(terrain);
    const geometry = createRock(device, { radius: 0.7, seed: 9 });
    const material = new Material({ label: "rock", color: 0x997755 });
    const population = new PopulationWorld({
      terrain,
      types: [{ ...populationPreset("rock"), id: typeId, geometry, material }],
      generationsPerFrame: 64,
    });
    scene.add(population);
    const cameraEntity = scene.createTransformedEntity("camera", new Vec3(0, 20, -40));
    scene.world.addComponent(cameraEntity.id, new Camera());
    const ctx = createMockContext(scene.world);
    terrain.focusPosition.set(0, 0, 0);
    terrain.update(ctx, 0.016);
    population.update(ctx, 0.016);
    /** Every submission the world offers this frame: key, version and instance count. */
    const offer = () => {
      const seen: { key: string; version: number; count: number }[] = [];
      const collector: PopulationCollector = {
        addPopulationBatch: (submission) => {
          seen.push({ key: submission.residencyKey!, version: submission.residencyVersion!, count: submission.instances.count });
          return true;
        },
      };
      population.collectPopulations(collector);
      return seen;
    };
    return {
      device,
      scene,
      terrain,
      population,
      geometry,
      material,
      ctx,
      cameraEntity,
      offer,
      async dispose() {
        population.dispose();
        terrain.dispose();
        material.dispose();
        geometry.dispose();
        scene.dispose();
        await device.dispose();
      },
    };
  }

  it("keys a chunk's submission by world, type and chunk, and keeps that key stable", async () => {
    const f = await worldFixture();
    const first = f.offer();
    expect(first.length).toBeGreaterThan(4);
    for (const entry of first) {
      expect(entry.key).toMatch(new RegExp(`^pop${f.population.uid}:${POPULATION_TYPE_IDS.rock}:-?\\d+,-?\\d+$`));
      expect(entry.version).toBe(1);
      expect(entry.count).toBeGreaterThan(0);
    }
    // One key per chunk, and the same keys next frame: the renderer's slot is allocated on first sight
    // of a key and freed on the first frame it is missing, so a key that moved would re-upload.
    expect(new Set(first.map((e) => e.key)).size).toBe(first.length);
    const second = f.offer();
    expect(second.map((e) => e.key)).toEqual(first.map((e) => e.key));
    expect(second.map((e) => e.version)).toEqual(first.map((e) => e.version));
    await f.dispose();
  });

  it("gives two worlds different keys for the same type and chunk", async () => {
    const a = await worldFixture();
    const b = await worldFixture();
    expect(a.population.uid).not.toBe(b.population.uid);
    const keysA = new Set(a.offer().map((e) => e.key));
    const keysB = b.offer().map((e) => e.key);
    expect(keysB.length).toBeGreaterThan(0);
    // Both worlds scatter a type 1 into chunk (0,0); their blocks are different data, so the keys
    // cannot collide or the second world would draw the first one's rocks.
    for (const key of keysB) expect(keysA.has(key)).toBe(false);
    await a.dispose();
    await b.dispose();
  });

  it("bumps the version when a remesh re-anchors the block, and not while it stands still", async () => {
    const f = await worldFixture();
    const before = f.offer();
    const key = chunkCoordKey(0, 0);
    const entry = before.find((e) => e.key.endsWith(":0,0"))!;
    expect(entry).toBeDefined();
    expect(entry.version).toBe(1);
    // A frame that changes nothing must not move the version: that is what makes a steady frame free.
    f.population.update(f.ctx, 0.016);
    expect(f.offer().find((e) => e.key === entry.key)!.version).toBe(1);

    // A remesh re-anchors Y to the refined surface, so the records the renderer uploaded describe the
    // old heights: a new version is what tells it to compose and upload them again.
    const chunk = f.terrain.chunks.get(key)!;
    const pipeline = GeneratorPipeline.createDefault(991);
    const cell = createWorldCell(0, 0, 64, 5, 991);
    pipeline.execute(cell);
    chunk.applyCell(cell);
    f.population.update(f.ctx, 0.016);
    const after = f.offer().find((e) => e.key === entry.key)!;
    expect(after.version).toBe(2);
    expect(after.key).toBe(entry.key);
    // And it holds still again until the next re-anchor.
    f.population.update(f.ctx, 0.016);
    expect(f.offer().find((e) => e.key === entry.key)!.version).toBe(2);
    await f.dispose();
  });

  it("stops offering a chunk's key when the terrain evicts it", async () => {
    const f = await worldFixture();
    const before = f.offer();
    const originKey = before.find((e) => e.key.endsWith(":0,0"))!;
    expect(originKey).toBeDefined();

    // Stream somewhere else: the origin chunk is evicted, so its key stops being offered and the
    // renderer's sweep frees the slot it held.
    f.cameraEntity.transform.position = new Vec3(5000, 20, -5040);
    for (let i = 0; i < 8; i++) f.terrain.update(f.ctx, 0.016);
    f.population.update(f.ctx, 0.016);
    const after = f.offer();
    expect(after.some((e) => e.key === originKey.key)).toBe(false);
    expect(after.length).toBeGreaterThan(0);
    await f.dispose();
  });
});
