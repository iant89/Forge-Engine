/**
 * @suite population:population
 * @group unit
 * @covers engine/src/core/log.ts
 * @covers engine/src/core/time.ts
 * @covers engine/src/debug/profiler.ts
 * @covers engine/src/gpu/device.ts
 * @covers engine/src/index.ts
 * @covers engine/src/math/color.ts
 * @covers engine/src/math/geometry.ts
 * @covers engine/src/math/vec.ts
 * @covers engine/src/population/lod.ts
 * @covers engine/src/population/scatter.ts
 * @covers engine/src/population/settle.ts
 * @covers engine/src/population/world.ts
 * @covers engine/src/rendering/geometry.ts
 * @covers engine/src/rendering/material.ts
 * @covers engine/src/rendering/primitives.ts
 * @covers engine/src/rendering/renderer.ts
 * @covers engine/src/scene/components/index.ts
 * @covers engine/src/scene/population.ts
 * @covers engine/src/scene/scene.ts
 * @covers engine/src/scene/systems.ts
 * @covers engine/src/scene/world.ts
 * @covers engine/src/terrain/chunk.ts
 * @covers engine/src/terrain/generators.ts
 * @covers engine/src/terrain/world.ts
 * @desc World population (Phase 14): deterministic scatter, compact SoA storage, terrain-following
 */

export const suite = {
  name: "population:population",
  group: "unit",
  covers:   [
    "engine/src/core/log.ts",
    "engine/src/core/time.ts",
    "engine/src/debug/profiler.ts",
    "engine/src/gpu/device.ts",
    "engine/src/index.ts",
    "engine/src/math/color.ts",
    "engine/src/math/geometry.ts",
    "engine/src/math/vec.ts",
    "engine/src/population/lod.ts",
    "engine/src/population/scatter.ts",
    "engine/src/population/settle.ts",
    "engine/src/population/world.ts",
    "engine/src/rendering/geometry.ts",
    "engine/src/rendering/material.ts",
    "engine/src/rendering/primitives.ts",
    "engine/src/rendering/renderer.ts",
    "engine/src/scene/components/index.ts",
    "engine/src/scene/population.ts",
    "engine/src/scene/scene.ts",
    "engine/src/scene/systems.ts",
    "engine/src/scene/world.ts",
    "engine/src/terrain/chunk.ts",
    "engine/src/terrain/generators.ts",
    "engine/src/terrain/world.ts"
  ],
  desc: "World population (Phase 14): deterministic scatter, compact SoA storage, terrain-following",
};
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
 *  - The renderer seam: a submission becomes one instanced batch per (chunk, type), and its
 *    instances live in a **device-resident buffer** (Phase 14.3) — one `writeBuffer` per content
 *    revision, zero per-frame copies, the buffer freed when the chunk stops being offered.
 *    Per-chunk frustum rejection happens before any batch is emitted; casters reach the shadow
 *    maps through the same conservative assignment; the strict mock device reports no validation
 *    errors and nothing leaks (14.3/14.5 integration).
 */

import assert from "node:assert/strict";
import { assertCloseTo, assertContains, assertMatchObject, assertNotContains, assertThrows, finish, group, test } from "selrun";
import {
  AABB,
  Camera,
  Clock,
  EntityWorld,
  Geometry,
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
  boxGeometrySource,
  buildLodGeometry,
  chunkCoordKey,
  coneGeometrySource,
  createRock,
  discGeometrySource,
  createWorldCell,
  isPopulationSource,
  populationLodIndex,
  resolvePopulationTypeSpec,
  rockGeometrySource,
  rosetteGeometrySource,
  scatterPopulationChunk,
  settlePopulationBlockWithPhysics,
  unpackColor,
  unindexedLodWindow,
  type PopulationCollector,
  type PopulationLodWindow,
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

group("Population - deterministic scatter (14.1)", () => {
  test("produces bit-identical SoA arrays for identical inputs, and moves with seed, chunk and type", () => {
    const sampler = flatSampler();
    const run = () => {
      const block = new PopulationInstanceBlock(64);
      scatterPopulationChunk(rockSpec(), 42137, 3, -5, 128, sampler, block);
      return block;
    };
    const a = run();
    const b = run();
    assert.deepEqual([...a.positions], [...b.positions]);
    assert.deepEqual([...a.scales], [...b.scales]);
    assert.deepEqual([...a.rotations], [...b.rotations]);
    assert.deepEqual([...a.tints], [...b.tints]);
    assert.equal(a.count, b.count);
    assert.ok(a.count > 0);

    const otherSeed = run();
    void otherSeed;
    const seedB = new PopulationInstanceBlock(64);
    scatterPopulationChunk(rockSpec(), 42138, 3, -5, 128, sampler, seedB);
    const chunkB = new PopulationInstanceBlock(64);
    scatterPopulationChunk(rockSpec(), 42137, 4, -5, 128, sampler, chunkB);
    const typeB = new PopulationInstanceBlock(64);
    scatterPopulationChunk(rockSpec({ id: 2 }), 42137, 3, -5, 128, sampler, typeB);
    assert.notDeepEqual([...seedB.positions], [...a.positions]);
    assert.notDeepEqual([...chunkB.positions], [...a.positions]);
    assert.notDeepEqual([...typeB.positions], [...a.positions]);
  });

  test("places at most one instance per stratified grid cell", () => {
    const block = new PopulationInstanceBlock(64);
    const grid = 5;
    scatterPopulationChunk(rockSpec({ densityGrid: grid }), 7, 0, 0, 100, flatSampler(), block);
    assert.equal(block.count, grid * grid);
    const cells = new Set<string>();
    const step = 100 / grid;
    for (let k = 0; k < block.count; k++) {
      const cx = Math.floor(block.positions[k * 3]! / step);
      const cz = Math.floor(block.positions[k * 3 + 2]! / step);
      cells.add(`${cx},${cz}`);
    }
    assert.equal(cells.size, block.count);
  });

  test("rejects candidates steeper than the slope limit and outside the height band", () => {
    const flat = new PopulationInstanceBlock(64);
    scatterPopulationChunk(rockSpec({ densityGrid: 3, slopeLimit: 0.5 }), 7, 0, 0, 64, flatSampler(1), flat);
    assert.equal(flat.count, 9);

    const steep = new PopulationInstanceBlock(64);
    // normalY 0.2 → slope 0.8 > 0.5: every candidate is rejected.
    scatterPopulationChunk(rockSpec({ densityGrid: 3, slopeLimit: 0.5 }), 7, 0, 0, 64, flatSampler(0.2), steep);
    assert.equal(steep.count, 0);

    const hillside = new PopulationInstanceBlock(64);
    // Mixed surface: flat below z = 32, cliff above — only the flat half is populated.
    const mixed = {
      heightAt: (_x: number, z: number) => z,
      normalYAt: (_x: number, z: number) => (z < 32 ? 1 : 0),
    };
    scatterPopulationChunk(rockSpec({ densityGrid: 4, slopeLimit: 0.5, embed: 0 }), 7, 0, 0, 64, mixed, hillside);
    assert.ok(hillside.count > 0);
    assert.ok(hillside.count < 16);
    for (let k = 0; k < hillside.count; k++) {
      assert.ok(hillside.positions[k * 3 + 2]! < 32);
      // A candidate on the accepted surface sits at its own height (embed 0 here).
      assertCloseTo(hillside.positions[k * 3 + 1]!, hillside.positions[k * 3 + 2]!, 5);
    }

    const band = new PopulationInstanceBlock(64);
    scatterPopulationChunk(rockSpec({ densityGrid: 3, minHeight: 10 }), 7, 0, 0, 64, flatSampler(), band);
    assert.equal(band.count, 0);
  });

  test("keeps scales inside the configured band and caps the count at maxPerChunk", () => {
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
    assert.equal(block.count, 5);
    for (let k = 0; k < block.count; k++) {
      for (const axis of [0, 1, 2]) {
        assert.ok(block.scales[k * 3 + axis]! >= 0.25);
        assert.ok(block.scales[k * 3 + axis]! <= 4);
      }
      assert.ok(block.rotations[k]! >= 0);
      assert.ok(block.rotations[k]! < Math.PI * 2);
    }
  });

  test("packs deterministic tint jitter and leaves it off at jitter 0", () => {
    const plain = new PopulationInstanceBlock(64);
    scatterPopulationChunk(rockSpec({ densityGrid: 3, tintJitter: 0 }), 3, 0, 0, 64, flatSampler(), plain);
    for (let k = 0; k < plain.count; k++) assert.equal(plain.tints[k], 0);

    const jittered = new PopulationInstanceBlock(64);
    scatterPopulationChunk(rockSpec({ densityGrid: 3, tintJitter: 0.4 }), 3, 0, 0, 64, flatSampler(), jittered);
    const out = { r: 0, g: 0, b: 0, a: 0 };
    for (let k = 0; k < jittered.count; k++) {
      const tint = jittered.tints[k]!;
      assert.notEqual(tint, 0);
      unpackColor(tint, out);
      assert.equal(out.a, 1);
      assert.equal(out.r, out.g);
      assert.equal(out.g, out.b);
      assert.ok(out.r >= 0.6 - 1e-3);
      assert.ok(out.r <= 1);
    }
  });

  test("resolves every default exactly once", () => {
    const spec = resolvePopulationTypeSpec({ id: 9, label: "x" });
    assert.equal(spec.densityGrid, 6);
    assert.equal(spec.maxPerChunk, 36);
    assert.equal(spec.slopeLimit, 0.5);
    assert.equal(spec.embed, 0.15);
    assert.equal(spec.castShadow, true);
    assert.equal(spec.minHeight, -Infinity);
    assert.equal(spec.maxHeight, Infinity);
    assertMatchObject(resolvePopulationTypeSpec({ id: 1, label: "x", densityGrid: 0 }), { densityGrid: 1 });
  });
});

group("Population - compact instance blocks (14.3)", () => {
  test("allocates the SoA arrays once for the capacity and rejects invalid capacities", () => {
    const block = new PopulationInstanceBlock(7);
    assert.equal(block.capacity, 7);
    assert.equal(block.positions.length, 21);
    assert.equal(block.scales.length, 21);
    assert.equal(block.rotations.length, 7);
    assert.equal(block.tints.length, 7);
    assert.equal(block.count, 0);
    block.clear();
    assert.equal(block.count, 0);
    assertThrows(() => new PopulationInstanceBlock(-1), undefined);
    assertThrows(() => new PopulationInstanceBlock(Number.NaN), undefined);
  });
});

/** A minimal scene object that submits one hand-built population — the seam without terrain. */
class StaticPopulation extends SceneObject implements PopulationSource {
  readonly name = "static-population";
  readonly results: boolean[] = [];
  /** Flipped to false to simulate the chunk being evicted (the source stops offering it). */
  active = true;

  constructor(
    private readonly submission: PopulationSubmission,
    enabledFlag = true,
  ) {
    super();
    this.active = enabledFlag;
  }

  collectPopulations(collector: PopulationCollector): void {
    if (!this.active) return;
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

/** The live "population.instances" buffers on the mock (it keeps real bytes, so content is checkable). */
function populationBuffers(mock: GraphicsDevice["mock"], expected: number): { size: number; writeCount: number; data: ArrayBuffer }[] {
  const found = [...mock.liveBuffers].filter((b) => b.label === "population.instances");
  assert.equal(found.length, expected);
  return found as { size: number; writeCount: number; data: ArrayBuffer }[];
}

group("Population - renderer seam (14.3/14.5)", () => {
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
        assert.deepEqual(mock.outstanding.buffers, []);
        assert.deepEqual(mock.outstanding.textures, []);
      },
    };
  }

  test("draws a population as instanced batches with zero entities per instance", async () => {
    const f = await fixture();
    const source = new StaticPopulation(handSubmission(f.geometry, f.material, 3));
    f.scene.add(source);
    const entitiesBefore = f.scene.entityCount;

    f.renderer.renderScene(f.scene);
    assert.deepEqual(f.mock.errors, []);
    assert.equal(f.renderer.stats.populationBatches, 1);
    assert.equal(f.renderer.stats.populationInstances, 3);
    // The instances are ordinary instances: counted by the frame's instance/batch statistics.
    assert.ok(f.renderer.stats.instances >= 3);
    assert.ok(f.renderer.stats.batches >= 1);
    assert.ok(f.renderer.stats.drawCalls >= 1);
    assert.deepEqual(source.results, [true]);
    // The Phase 14 headline: three (or three thousand) instances, still zero entities.
    assert.equal(f.scene.entityCount, entitiesBefore);
    // Phase 14.3: one device-resident buffer for the three instances, one upload to fill it.
    assert.equal(f.renderer.stats.populationBuffers, 1);
    assert.equal(f.renderer.stats.populationUploads, 1);

    // Steady frame: no new GPU objects, and the submission is re-offered every frame.
    f.renderer.renderScene(f.scene);
    assert.deepEqual(f.mock.errors, []);
    assert.equal(f.renderer.stats.populationBatches, 1);
    assert.equal(source.results.length, 2);
    // The buffer persists and needs no second upload: the chunk's data is already on the device.
    assert.equal(f.renderer.stats.populationBuffers, 1);
    assert.equal(f.renderer.stats.populationUploads, 0);
    const populated = populationBuffers(f.mock, 1)[0];
    assert.notEqual(populated, undefined);
    assert.equal(populated?.writeCount, 1);
    await f.dispose();
  });

  test("keeps a whole submission in one device-resident buffer, at no per-frame copy cost", async () => {
    const f = await fixture();
    const source = new StaticPopulation(handSubmission(f.geometry, f.material, 7));
    f.scene.add(source);

    f.renderer.renderScene(f.scene);
    assert.deepEqual(f.mock.errors, []);
    // One batch per (chunk, type) — the culler keeps per-chunk granularity without slices.
    assert.equal(f.renderer.stats.populationBatches, 1);
    assert.equal(f.renderer.stats.populationInstances, 7);
    const [buffer] = populationBuffers(f.mock, 1);
    assert.equal(buffer?.size, 7 * 80); // 7 records × InstanceData (80 B)
    assert.equal(buffer?.writeCount, 1);

    // Two more frames: the chunk's buffer is never touched again (the frame's other arenas still
    // upload, but the population data is already on the device).
    f.renderer.renderScene(f.scene);
    f.renderer.renderScene(f.scene);
    assert.deepEqual(f.mock.errors, []);
    assert.equal(f.renderer.stats.populationBuffers, 1);
    assert.equal(f.renderer.stats.populationUploads, 0);
    assert.equal(buffer?.writeCount, 1);
    await f.dispose();
  });

  test("re-uploads a population buffer exactly when the block's content revision moves", async () => {
    const f = await fixture();
    const submission = handSubmission(f.geometry, f.material, 4);
    f.scene.add(new StaticPopulation(submission));

    f.renderer.renderScene(f.scene);
    const [buffer] = populationBuffers(f.mock, 1);
    assert.notEqual(buffer, undefined);
    const f32 = () => new Float32Array(buffer!.data);
    const translationBefore = f32()[13]; // record 0's translation (column 3): [px, py, pz]

    // Move every instance and mark the block changed — the only event that may re-upload.
    for (let k = 0; k < 4; k++) submission.instances.positions[k * 3 + 1] = 5;
    submission.instances.markModified();

    f.renderer.renderScene(f.scene);
    assert.deepEqual(f.mock.errors, []);
    assert.equal(f.renderer.stats.populationUploads, 1);
    assert.equal(buffer?.writeCount, 2);
    const translationAfter = f32()[13];
    assert.equal(translationAfter, 5);
    assert.equal(translationBefore, 0);

    // Without a new revision the next frame is silent again.
    f.renderer.renderScene(f.scene);
    assert.equal(f.renderer.stats.populationUploads, 0);
    assert.equal(buffer?.writeCount, 2);
    await f.dispose();
  });

  test("frees the device buffer when a chunk stops being offered (eviction)", async () => {
    const f = await fixture();
    const source = new StaticPopulation(handSubmission(f.geometry, f.material, 5));
    f.scene.add(source);

    f.renderer.renderScene(f.scene);
    assert.equal(f.renderer.stats.populationBuffers, 1);

    source.active = false; // the terrain chunk was evicted
    f.renderer.renderScene(f.scene);
    assert.deepEqual(f.mock.errors, []);
    assert.equal(f.renderer.stats.populationBuffers, 0);
    assertNotContains(f.mock.outstanding.buffers, "population.instances");
    await f.dispose();
  });

  test("rejects a fully off-screen submission before writing any instance record", async () => {
    const f = await fixture();
    // Camera looks down -Z from z = -8 at the origin; put the population far behind the camera.
    const submission = handSubmission(f.geometry, f.material, 4);
    submission.instances.positions.fill(0);
    for (let k = 0; k < 4; k++) submission.instances.positions[k * 3 + 2] = -60;
    submission.bounds.setFrom(new Vec3(-5, -1, -61), new Vec3(5, 1, -59));
    const source = new StaticPopulation(submission);
    f.scene.add(source);
    f.renderer.renderScene(f.scene);
    assert.deepEqual(f.mock.errors, []);
    assert.deepEqual(source.results, [false]);
    assert.equal(f.renderer.stats.populationBatches, 0);
    assert.equal(f.renderer.stats.populationInstances, 0);
    await f.dispose();
  });

  test("gives casters per-instance shadow-map assignment like any renderable", async () => {
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
    assert.deepEqual(f.mock.errors, []);
    assert.ok(f.renderer.stats.populationBatches >= 1);
    assert.ok(f.renderer.stats.shadowInstancesDrawn >= 1);
    await f.dispose();
  });

  test("recognises sources structurally: isPopulationSource", () => {
    assert.equal(isPopulationSource(new StaticPopulation(null as never, true)), true);
    assert.equal(isPopulationSource({}), false);
    assert.equal(isPopulationSource(null), false);
  });
});

group("Population - GPU LOD (14.4)", () => {
  test("buildLodGeometry merges the windows hi-first, with the boundary and counts", () => {
    const hi: PopulationLodWindow = {
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 2, 0, 0, 0, 2, 0, 1, 1, 0]), // 2 triangles
      normals: new Float32Array(18).fill(1),
      uv: new Float32Array(12).fill(0.5),
      tangent: new Float32Array(24).fill(1),
    };
    const lo: PopulationLodWindow = {
      positions: new Float32Array([9, 9, 9, 8, 8, 8, 7, 7, 7]), // 1 triangle
      normals: new Float32Array(9).fill(2),
      uv: new Float32Array(6).fill(0.25),
      tangent: new Float32Array(12).fill(0),
    };
    const merged = buildLodGeometry({ hi, lo });
    assert.equal(merged.hiTriangles, 2);
    assert.equal(merged.loTriangles, 1);
    assert.equal(merged.vertexCount, 9);
    assert.deepEqual(Array.from(merged.source.positions), [
      0, 0, 0, 1, 0, 0, 0, 1, 0, 2, 0, 0, 0, 2, 0, 1, 1, 0, // hi first …
      9, 9, 9, 8, 8, 8, 7, 7, 7, // … then lo
    ]);
    // The window boundary is a vertex boundary: the last hi vertex is index 5, the first lo's is 6.
    assert.equal(merged.source.normals?.[17], 1);
    assert.equal(merged.source.normals?.[18], 2);
    assert.equal(merged.source.uvs?.[11], 0.5); // last high vertex's final UV component
    assert.equal(merged.source.uvs?.[12], 0.25); // first low vertex's first UV component
    assert.equal(merged.source.tangents?.[23], 1);
    assert.equal(merged.source.tangents?.[24], 0);
  });

  test("unindexedLodWindow expands indexed sources, duplicating attributes per index", () => {
    const src = {
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      normals: new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]),
      uvs: new Float32Array([0, 0, 1, 0, 0, 1]),
      tangents: new Float32Array([1, 0, 0, 1, 0, 1, 0, 1, 0, 0, 1, 1]),
      indices: new Uint32Array([0, 2, 1]),
    };
    const w = unindexedLodWindow(src);
    assert.deepEqual(Array.from(w.positions), [0, 0, 0, 0, 1, 0, 1, 0, 0]);
    assert.deepEqual(Array.from(w.uv), [0, 0, 0, 1, 1, 0]);
    // xyzw per vertex, in index order 0, 2, 1.
    assert.deepEqual(Array.from(w.tangent), [1, 0, 0, 1, 0, 0, 1, 1, 0, 1, 0, 1]);
    // An already-unindexed source passes straight through (no copy).
    const plain = { positions: src.positions, normals: src.normals, uvs: src.uvs, tangents: src.tangents };
    assert.equal(unindexedLodWindow(plain).positions, plain.positions);
  });

  test("rejects malformed prototype attributes and non-triangle LOD windows", () => {
    assertThrows(() => unindexedLodWindow({
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      normals: new Float32Array(9),
      uvs: new Float32Array(6),
      tangents: new Float32Array(12),
      indices: new Uint16Array([0, 1]),
    }), /non-empty triangle list/);
    const window: PopulationLodWindow = {
      positions: new Float32Array(6),
      normals: new Float32Array(6),
      uv: new Float32Array(4),
      tangent: new Float32Array(8),
    };
    assertThrows(() => buildLodGeometry({ hi: window, lo: window }), /whole number of triangles/);
  });

  test("populationLodIndex switches to the low window only strictly beyond the distance", () => {
    assert.equal(populationLodIndex(8.25, 8.5), 0);
    assert.equal(populationLodIndex(8.5, 8.5), 0); // the boundary itself stays high (conservative)
    assert.equal(populationLodIndex(9.17, 8.5), 1);
  });

  test("runs forge.populationLod for LOD batches and splits the device buffer at lodDistance", async () => {
    const device = await GraphicsDevice.create({ forceMock: true });
    device.resize(320, 180);
    const mock = device.mock;
    const renderer = new Renderer(device, { shadowMapSize: 256 });
    const scene = new Scene({ name: "population-lod-test" });
    const cameraEntity = scene.createTransformedEntity("camera", new Vec3(0, 2, -8));
    const camera = new Camera();
    camera.far = 100;
    scene.world.addComponent(cameraEntity.id, camera);
    cameraEntity.transform.lookAt(new Vec3(0, 0, 0));
    // One merged prototype: the same rock twice (hi + lo), so the window boundary is hi's vertex count.
    const src = rockGeometrySource({ radius: 0.6, seed: 5, segments: 4 });
    const merged = buildLodGeometry({ hi: unindexedLodWindow(src), lo: unindexedLodWindow(src) });
    const geometry = Geometry.create(device, merged.source);
    const material = new Material({ label: "rock", color: 0x886655 });

    // Five instances at x = -4, -2, 0, 2, 4 (y = 0, z = 0). From the camera at (0, 2, -8) their
    // distances are 9.17, 8.49, 8.25, 8.49, 9.17 — lodDistance 8.5 splits them lo/hi/hi/hi/lo.
    const submission: PopulationSubmission = {
      ...handSubmission(geometry, material, 5),
      lod: { hiTriangles: merged.hiTriangles, lodDistance: 8.5 },
    };
    const source = new StaticPopulation(submission);
    scene.add(source);

    renderer.renderScene(scene);
    assert.deepEqual(mock.errors, []);
    // The pass ran for this batch, and the main pass drew it through the LOD pipeline variant.
    assert.equal(renderer.stats.populationLodBatches, 1);
    assertContains(renderer.passNames, "forge.populationLod");
    const mainLodDraws = mock.commandLog.filter(
      (e) => e.type === "setPipeline" && e.label === "forge.main" && String(e.pipeline).includes("|lod|"),
    );
    assert.ok(mainLodDraws.length >= 1);

    // The mock emulated the kernel: each instance's flags bit 0 matches the CPU twin.
    const [buffer] = populationBuffers(mock, 1);
    const flags = new Uint32Array(buffer!.data);
    const flagOf = (k: number) => flags[k * 20 + 18]; // InstanceData.flags, record k
    assert.equal(flagOf(0), 1); // x = -4 → 9.17 > 8.5 → low window
    assert.equal(flagOf(1), 0); // x = -2 → 8.49 → high window
    assert.equal(flagOf(2), 0); // x = 0  → 8.25 → high window
    assert.equal(flagOf(3), 0); // x = 2  → 8.49 → high window
    assert.equal(flagOf(4), 1); // x = 4  → 9.17 > 8.5 → low window

    // Steady state: the selection re-runs every frame (it is camera-keyed) but re-uploads nothing.
    renderer.renderScene(scene);
    assert.deepEqual(mock.errors, []);
    assert.equal(renderer.stats.populationLodBatches, 1);
    assert.equal(renderer.stats.populationUploads, 0);
    assert.equal(buffer?.writeCount, 1);
    assert.equal(flagOf(0), 1); // unchanged camera → unchanged selection

    renderer.dispose();
    material.dispose();
    geometry.dispose();
    scene.dispose();
    await device.dispose();
    assert.deepEqual(mock.outstanding.buffers, []);
    assert.deepEqual(mock.outstanding.textures, []);
  });

  test("uses one aligned uniform slot per LOD batch in the shared compute pass", async () => {
    const device = await GraphicsDevice.create({ forceMock: true });
    device.resize(320, 180);
    const mock = device.mock;
    const renderer = new Renderer(device, { shadowMapSize: 256 });
    const scene = new Scene({ name: "population-lod-slots-test" });
    const cameraEntity = scene.createTransformedEntity("camera", new Vec3(0, 2, -8));
    const camera = new Camera();
    camera.far = 100;
    scene.world.addComponent(cameraEntity.id, camera);
    cameraEntity.transform.lookAt(new Vec3(0, 0, 0));
    const src = rockGeometrySource({ radius: 0.6, seed: 5, segments: 4 });
    const merged = buildLodGeometry({ hi: unindexedLodWindow(src), lo: unindexedLodWindow(src) });
    const geometry = Geometry.create(device, merged.source);
    const material = new Material({ label: "rock", color: 0x886655 });
    const near = { ...handSubmission(geometry, material, 1), lod: { hiTriangles: merged.hiTriangles, lodDistance: 10 } };
    const far = { ...handSubmission(geometry, material, 1), lod: { hiTriangles: merged.hiTriangles, lodDistance: 20 } };
    far.instances.positions[2] = 40;
    far.bounds.setFrom(new Vec3(-1, -1, 39), new Vec3(1, 1, 41));
    scene.add(new StaticPopulation(near));
    scene.add(new StaticPopulation(far));

    renderer.renderScene(scene);
    assert.deepEqual(mock.errors, []);
    assert.equal(renderer.stats.populationLodBatches, 2);
    const buffers = populationBuffers(mock, 2);
    const flagsByZ = new Map(buffers.map((b) => {
      const f = new Float32Array(b.data);
      const u = new Uint32Array(b.data);
      return [f[14]!, u[18]!] as const;
    }));
    assert.equal(flagsByZ.get(0), 0); // distance 8.25 <= 10 → high
    assert.equal(flagsByZ.get(40), 1); // distance 48 > 20 → low
    const offsets = mock.commandLog
      .filter((e) => e.type === "setBindGroup" && e.label === "population.lod")
      .map((e) => e.dynamicOffsets as number[]);
    assert.deepEqual(offsets, [[0], [256]]);

    renderer.dispose();
    material.dispose();
    geometry.dispose();
    scene.dispose();
    await device.dispose();
    assert.deepEqual(mock.outstanding.buffers, []);
    assert.deepEqual(mock.outstanding.textures, []);
  });

  test("moves instances across lodDistance when the camera moves (re-selection without re-upload)", async () => {
    const device = await GraphicsDevice.create({ forceMock: true });
    device.resize(320, 180);
    const mock = device.mock;
    const renderer = new Renderer(device, { shadowMapSize: 256 });
    const scene = new Scene({ name: "population-lod-move-test" });
    const cameraEntity = scene.createTransformedEntity("camera", new Vec3(0, 2, -8));
    const camera = new Camera();
    camera.far = 1000; // The move below places the camera ~104 m away; keep the chunk in the frustum.
    scene.world.addComponent(cameraEntity.id, camera);
    cameraEntity.transform.lookAt(new Vec3(0, 0, 0));
    const src = rockGeometrySource({ radius: 0.6, seed: 5, segments: 4 });
    const merged = buildLodGeometry({ hi: unindexedLodWindow(src), lo: unindexedLodWindow(src) });
    const geometry = Geometry.create(device, merged.source);
    const material = new Material({ label: "rock", color: 0x886655 });
    const submission: PopulationSubmission = {
      ...handSubmission(geometry, material, 5),
      lod: { hiTriangles: merged.hiTriangles, lodDistance: 8.5 },
    };
    scene.add(new StaticPopulation(submission));

    renderer.renderScene(scene);
    const [buffer] = populationBuffers(mock, 1);
    const flags = new Uint32Array(buffer!.data);
    const flagOf = (k: number) => flags[k * 20 + 18];
    assert.equal(flagOf(0), 1); // far instance, as before

    // Move the camera to (0, 2, -104): every distance grows (≈104–108), so all instances must
    // switch to the low window — in the device buffer, with no re-upload of the instances.
    cameraEntity.transform.position = new Vec3(0, 2, -104);
    cameraEntity.transform.lookAt(new Vec3(0, 0, 0));
    renderer.renderScene(scene);
    assert.deepEqual(mock.errors, []);
    assert.equal(renderer.stats.populationUploads, 0);
    for (let k = 0; k < 5; k++) assert.equal(flagOf(k), 1);

    renderer.dispose();
    material.dispose();
    geometry.dispose();
    scene.dispose();
    await device.dispose();
    assert.deepEqual(mock.outstanding.buffers, []);
    assert.deepEqual(mock.outstanding.textures, []);
  });

  test("uses the LOD instanced entry in main, prepass, and shadows—even for one instance", async () => {
    const device = await GraphicsDevice.create({ forceMock: true });
    device.resize(320, 180);
    const mock = device.mock;
    const renderer = new Renderer(device, { shadowMapSize: 256 });
    const scene = new Scene({ name: "population-lod-passes-test" });
    scene.settings.depthPrepass = true;
    scene.settings.shadow.enabled = true;
    scene.settings.shadow.cascades = 1;
    const cameraEntity = scene.createTransformedEntity("camera", new Vec3(0, 2, -8));
    const camera = new Camera();
    camera.far = 100;
    scene.world.addComponent(cameraEntity.id, camera);
    cameraEntity.transform.lookAt(new Vec3(0, 0, 0));
    const sunEntity = scene.createTransformedEntity("sun", new Vec3(5, 10, -5));
    const sun = new Light();
    sun.kind = "directional";
    sun.castShadow = true;
    scene.world.addComponent(sunEntity.id, sun);
    sunEntity.transform.lookAt(new Vec3(0, 0, 0));
    const src = rockGeometrySource({ radius: 0.6, seed: 5, segments: 4 });
    const merged = buildLodGeometry({ hi: unindexedLodWindow(src), lo: unindexedLodWindow(src) });
    const geometry = Geometry.create(device, merged.source);
    const material = new Material({ label: "rock", color: 0x886655 });
    const submission: PopulationSubmission = {
      ...handSubmission(geometry, material, 1),
      castShadow: true,
      lod: { hiTriangles: merged.hiTriangles, lodDistance: 20 },
    };
    scene.add(new StaticPopulation(submission));

    renderer.renderScene(scene);
    assert.deepEqual(mock.errors, []);
    assertContains(renderer.passNames, "forge.populationLod");
    assertContains(renderer.passNames, "forge.prepass");
    assertContains(renderer.passNames, "forge.shadow.0");
    const lodPipelineFor = (passName: string) => mock.commandLog.some(
      (e) => e.type === "setPipeline" && e.label === passName && String(e.pipeline).includes("|inst|lod|"),
    );
    assert.equal(lodPipelineFor("forge.main"), true);
    assert.equal(lodPipelineFor("forge.prepass"), true);
    assert.equal(lodPipelineFor("forge.shadow.0"), true);

    renderer.dispose();
    material.dispose();
    geometry.dispose();
    scene.dispose();
    await device.dispose();
    assert.deepEqual(mock.outstanding.buffers, []);
    assert.deepEqual(mock.outstanding.textures, []);
  });

  test("keeps non-LOD population batches on the plain instanced entry", async () => {
    const device = await GraphicsDevice.create({ forceMock: true });
    device.resize(320, 180);
    const mock = device.mock;
    const renderer = new Renderer(device, { shadowMapSize: 256 });
    const scene = new Scene({ name: "population-lod-off-test" });
    const cameraEntity = scene.createTransformedEntity("camera", new Vec3(0, 2, -8));
    const camera = new Camera();
    camera.far = 100;
    scene.world.addComponent(cameraEntity.id, camera);
    cameraEntity.transform.lookAt(new Vec3(0, 0, 0));
    const geometry = createRock(device, { radius: 0.6, seed: 5 });
    const material = new Material({ label: "rock", color: 0x886655 });
    scene.add(new StaticPopulation(handSubmission(geometry, material, 3)));

    renderer.renderScene(scene);
    assert.deepEqual(mock.errors, []);
    assert.equal(renderer.stats.populationLodBatches, 0);
    assertNotContains(renderer.passNames, "forge.populationLod");
    const mainLodDraws = mock.commandLog.filter(
      (e) => e.type === "setPipeline" && e.label === "forge.main" && String(e.pipeline).includes("|lod|"),
    );
    assert.equal(mainLodDraws.length, 0);

    renderer.dispose();
    material.dispose();
    geometry.dispose();
    scene.dispose();
    await device.dispose();
    assert.deepEqual(mock.outstanding.buffers, []);
    assert.deepEqual(mock.outstanding.textures, []);
  });
});

group("Population - terrain-following streaming (14.6)", () => {
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

  test("populates every ready terrain chunk without creating entities", () => {
    const { scene, terrain, population, ctx } = terrainFixture();
    terrain.update(ctx, 0.016);
    const ready = [...terrain.chunks.values()].filter((c) => c.state === "ready");
    assert.ok(ready.length > 4);

    const entitiesBefore = scene.entityCount;
    population.update(ctx, 0.016);
    assert.equal(population.populatedChunkCount, ready.length);
    assert.equal(scene.entityCount, entitiesBefore);

    let instances = 0;
    for (const chunk of ready) {
      const count = population.instancesFor(chunk.key);
      assert.ok(count > 0);
      instances += count;
    }
    assert.ok(instances > 0);
    assertMatchObject(population.stats(), { chunks: ready.length, types: 2 });
    assert.equal(population.stats().instances, instances);

    population.dispose();
    scene.dispose();
  });

  test("is deterministic through the streaming world: same seed, same chunk, same arrays", () => {
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
    assert.equal(blockA.count, blockB.count);
    assert.deepEqual([...blockA.positions], [...blockB.positions]);

    a.population.dispose();
    b.population.dispose();
    a.scene.dispose();
    b.scene.dispose();
  });

  test("applies the per-update generation budget", () => {
    const { terrain, population, ctx } = terrainFixture({ generationsPerFrame: 1 });
    terrain.update(ctx, 0.016);
    const ready = [...terrain.chunks.values()].filter((c) => c.state === "ready").length;
    assert.ok(ready > 2);

    population.update(ctx, 0.016);
    assert.equal(population.populatedChunkCount, 1);
    assert.equal(population.pendingChunkCount, ready - 1);
    population.update(ctx, 0.016);
    assert.equal(population.populatedChunkCount, 2);

    population.dispose();
  });

  test("drops populations when terrain evicts their chunk", () => {
    const { scene, terrain, population, ctx, cameraEntity } = terrainFixture();
    terrain.update(ctx, 0.016);
    population.update(ctx, 0.016);
    const before = population.populatedChunkCount;
    assert.ok(before > 4);
    const originKey = chunkCoordKey(0, 0);
    assert.ok(population.instancesFor(originKey) > 0);

    // Stream somewhere else entirely: the old disc is evicted (maxChunksLoaded 30), and the
    // population records must go with it. The camera moves (not just `focusPosition`) because
    // TerrainWorld refreshes its focus from the active camera every update.
    cameraEntity.transform.position = new Vec3(5000, 20, -5040);
    for (let i = 0; i < 8; i++) terrain.update(ctx, 0.016);
    population.update(ctx, 0.016);
    assert.equal(population.instancesFor(originKey), 0);
    assert.equal(terrain.chunks.has(originKey), false);
    // Every surviving record still belongs to a resident chunk.
    for (let i = 0; i < 4; i++) population.update(ctx, 0.016);
    for (const key of terrain.chunks.keys()) {
      assert.equal(terrain.chunks.get(key)!.state, "ready");
    }

    population.dispose();
    scene.dispose();
  });

  test("re-anchors Y to a remeshed tile without re-scattering XZ placement", () => {
    const spec: PopulationTypeSpec = { id: 1, label: "rocks", densityGrid: 3, scaleMin: 1, scaleMax: 1 };
    const { scene, terrain, population, ctx } = terrainFixture({ types: [spec] });
    terrain.update(ctx, 0.016);
    population.update(ctx, 0.016);
    const key = chunkCoordKey(0, 0);
    const block = population.chunkPopulation(key, 1);
    assert.notEqual(block, null);
    assert.ok(block!.count > 0);
    const xzBefore = [...block!.positions].filter((_, i) => i % 3 !== 1);
    const yBeforeRemesh = [...block!.positions].filter((_, i) => i % 3 === 1);
    const scalesBefore = [...block!.scales];

    // Force a remesh at a coarser resolution by applying a fresh cell to the ready chunk.
    const chunk = terrain.chunks.get(key)!;
    const pipeline = GeneratorPipeline.createDefault(991);
    const cell = createWorldCell(0, 0, 64, 5, 991);
    pipeline.execute(cell);
    chunk.applyCell(cell);
    population.update(ctx, 0.016);

    const after = population.chunkPopulation(key, 1)!;
    assert.equal(after.count, block!.count);
    assert.deepEqual([...after.positions].filter((_, i) => i % 3 !== 1), xzBefore);
    assert.deepEqual([...after.scales], scalesBefore);
    // The anchor targets follow the *new* surface exactly (bilinear, matching the mesh facets;
    // embed 0.15 of the Y scale), so rocks never float when the mesh refines under them — and
    // the rendered Y glides toward the targets instead of snapping (no falling rocks).
    const tile = chunk.tile!;
    const expectedY: number[] = [];
    for (let k = 0; k < after.count; k++) {
      const expected =
        tile.heightmap.getHeightBilinear(after.positions[k * 3]!, after.positions[k * 3 + 2]!) -
        0.15 * after.scales[k * 3 + 1]!;
      expectedY.push(expected);
      assertCloseTo(after.targetY[k]!, expected, 4);
    }
    // After a single update the rendered Y has moved only partway (one 8/s settling step moves
    // ~12% of the gap), unless the gap was already within the 2 mm snap threshold.
    const step = 1 - Math.exp(-8 * 0.016);
    for (let k = 0; k < after.count; k++) {
      const gap = Math.abs(expectedY[k]! - yBeforeRemesh[k]!);
      const moved = Math.abs(after.positions[k * 3 + 1]! - yBeforeRemesh[k]!);
      if (gap < 0.002) {
        assertCloseTo(after.positions[k * 3 + 1]!, expectedY[k]!, 6);
      } else {
        assertCloseTo(moved, gap * step, 4);
      }
    }
    // Pump frames until the rendered Y converges onto the new anchors (rate 8/s settles
    // millimeter-close in well under two simulated seconds).
    for (let i = 0; i < 120; i++) population.update(ctx, 0.016);
    for (let k = 0; k < after.count; k++) {
      assertCloseTo(after.positions[k * 3 + 1]!, expectedY[k]!, 3);
    }
    population.dispose();
    scene.dispose();
  });

  test("snaps far re-anchors instantly instead of gliding rocks down from the sky", () => {
    // The near glide is pinned above; this is its complement. A coarse↔fine LOD swap moves the
    // sampled surface by metres, and gliding that gap at 300+ m reads as rocks falling on newly
    // streamed-in terrain — so chunks past `settleSnapDistance` (120 m) snap outright.
    const spec: PopulationTypeSpec = { id: 1, label: "rocks", densityGrid: 3, scaleMin: 1, scaleMax: 1 };
    const { scene, terrain, population, ctx } = terrainFixture({ types: [spec] });
    terrain.update(ctx, 0.016);
    population.update(ctx, 0.016);
    const far = [...terrain.chunks.values()].find((chunk) => {
      if (chunk.state !== "ready" || !population.chunkPopulation(chunk.key, 1)) return false;
      const dx = (chunk.cx + 0.5) * terrain.chunkSize - terrain.focusPosition.x;
      const dz = (chunk.cz + 0.5) * terrain.chunkSize - terrain.focusPosition.z;
      return Math.hypot(dx, dz) > population.settleSnapDistance;
    });
    assert.notEqual(far, undefined, "a populated chunk beyond the snap gate");
    const key = far!.key;
    const block = population.chunkPopulation(key, 1)!;
    assert.ok(block.count > 0);
    const yBefore = [...block.positions].filter((_, i) => i % 3 === 1);

    // Refine at full resolution — the production path this gate serves (a far chunk sharpening
    // as the camera nears it; far fixture chunks sit at coarse LOD already, so coarsening them
    // would move nothing and the test could not tell snap from glide).
    const pipeline = GeneratorPipeline.createDefault(991);
    const cell = createWorldCell(far!.cx, far!.cz, 64, 9, 991);
    pipeline.execute(cell);
    far!.applyCell(cell);
    population.update(ctx, 0.016);

    // The remesh must actually move the surface, or snap-vs-glide is indistinguishable (the
    // settling pass snaps sub-2 mm gaps on its own).
    const gaps = yBefore.map((y, k) => Math.abs(block.targetY[k]! - y!));
    assert.ok(Math.max(...gaps) > 0.01);
    // One update lands every rendered Y exactly on its new anchor — no glide frames.
    for (let k = 0; k < block.count; k++) {
      assert.equal(block.positions[k * 3 + 1]!, block.targetY[k]!);
    }
    population.dispose();
    scene.dispose();
  });

  test("syncs anchors on scatter and parks showcase-hidden instances out of Y settling", () => {
    const spec: PopulationTypeSpec = { id: 1, label: "rocks", densityGrid: 3, scaleMin: 1, scaleMax: 1 };
    const { scene, terrain, population, ctx } = terrainFixture({ types: [spec] });
    terrain.update(ctx, 0.016);
    population.update(ctx, 0.016);
    const key = chunkCoordKey(0, 0);
    const block = population.chunkPopulation(key, 1)!;
    assert.ok(block.count > 1);
    // Fresh scatter starts exactly on its anchors — settling only kicks in after a remesh.
    for (let k = 0; k < block.count; k++) {
      assert.equal(block.targetY[k]!, block.positions[k * 3 + 1]!);
    }

    // Hide instance 0 the way the showcase write-back does: zeroed scales, Y parked deep.
    const restoredScales = [block.scales[0]!, block.scales[1]!, block.scales[2]!];
    const parkedY = -500;
    block.scales[0] = 0;
    block.scales[1] = 0;
    block.scales[2] = 0;
    block.positions[1] = parkedY;

    // Force a remesh, then pump frames: visible instances glide onto the new surface while the
    // hidden one stays parked (a settling pass must never un-hide a broken rock).
    const chunk = terrain.chunks.get(key)!;
    const pipeline = GeneratorPipeline.createDefault(991);
    const cell = createWorldCell(0, 0, 64, 5, 991);
    pipeline.execute(cell);
    chunk.applyCell(cell);
    for (let i = 0; i < 120; i++) population.update(ctx, 0.016);
    assert.equal(block.positions[1]!, parkedY);
    for (let k = 1; k < block.count; k++) {
      assertCloseTo(block.positions[k * 3 + 1]!, block.targetY[k]!, 3);
    }

    // Restore through snapY (authoritative move): rendered Y and anchor agree again and the
    // instance tracks the surface like any other.
    block.scales[0] = restoredScales[0]!;
    block.scales[1] = restoredScales[1]!;
    block.scales[2] = restoredScales[2]!;
    const tile = chunk.tile!;
    const surfaceY =
      tile.heightmap.getHeightBilinear(block.positions[0]!, block.positions[2]!) - 0.15 * restoredScales[1]!;
    block.snapY(0, surfaceY);
    for (let i = 0; i < 10; i++) population.update(ctx, 0.016);
    assertCloseTo(block.positions[1]!, surfaceY, 4);
    assertCloseTo(block.targetY[0]!, surfaceY, 4);
    population.dispose();
    scene.dispose();
  });
});

group("Population - renderer over streamed terrain", () => {
  test("renders chunk populations end to end on the strict mock device", async () => {
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
    const rockLod = buildLodGeometry({
      hi: unindexedLodWindow(rockGeometrySource({ radius: 0.7, seed: 9, segments: 8 })),
      lo: unindexedLodWindow(rockGeometrySource({ radius: 0.7, seed: 9, segments: 4 })),
    });
    const rockGeometry = Geometry.create(device, rockLod.source);
    const boulderLod = buildLodGeometry({
      hi: unindexedLodWindow(rockGeometrySource({ radius: 1.8, seed: 10, segments: 7, flatten: 0.35 })),
      lo: unindexedLodWindow(rockGeometrySource({ radius: 1.8, seed: 10, segments: 4, flatten: 0.35 })),
    });
    const boulderGeometry = Geometry.create(device, boulderLod.source);
    const debrisGeometry = Geometry.create(device, boxGeometrySource({ width: 0.9, height: 0.2, depth: 0.55 }));
    const vegetationGeometry = Geometry.create(device, rosetteGeometrySource({ leaves: 7, radius: 0.4, height: 0.6 }));
    const decalGeometry = Geometry.create(device, discGeometrySource({ radiusX: 0.5, radiusZ: 0.3, segments: 10 }));
    const spireSource = coneGeometrySource({ radius: 0.28, height: 0.8, radialSegments: 6 });
    for (let i = 1; i < spireSource.positions.length; i += 3) spireSource.positions[i] += 0.4;
    const spireGeometry = Geometry.create(device, spireSource);
    const rockMaterial = new Material({ label: "rock", color: 0x997755, roughness: 0.95 });
    const debrisMaterial = new Material({ label: "debris", color: 0x71645a, roughness: 0.98 });
    const vegetationMaterial = new Material({ label: "rosette", color: 0x617044, roughness: 0.88 });
    const decalMaterial = new Material({ label: "decal", color: 0x704337, roughness: 1, transparent: true, opacity: 0.6, doubleSided: true });
    const spireMaterial = new Material({ label: "spire", color: 0x9b7860, roughness: 0.72, metallic: 0.12 });
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
          lod: { hiTriangles: rockLod.hiTriangles, distance: 180 },
        },
        {
          id: 2,
          label: "boulders",
          densityGrid: 2,
          scaleMin: 0.65,
          scaleMax: 1.3,
          maxDistance: 400,
          geometry: boulderGeometry,
          material: rockMaterial,
          lod: { hiTriangles: boulderLod.hiTriangles, distance: 240 },
        },
        { id: 3, label: "debris", densityGrid: 2, scaleMin: 0.4, scaleMax: 1.2, embed: 0.03, maxDistance: 300, geometry: debrisGeometry, material: debrisMaterial },
        { id: 4, label: "rosette-scrub", densityGrid: 2, scaleMin: 0.5, scaleMax: 1.2, embed: 0.05, maxDistance: 300, geometry: vegetationGeometry, material: vegetationMaterial },
        { id: 5, label: "erosion-decals", densityGrid: 2, scaleMin: 0.7, scaleMax: 1.4, slopeLimit: 0.18, embed: -0.015, castShadow: false, maxDistance: 180, geometry: decalGeometry, material: decalMaterial },
        { id: 6, label: "mineral-spires", densityGrid: 1, scaleMin: 0.7, scaleMax: 1.3, embed: 0.06, maxDistance: 400, geometry: spireGeometry, material: spireMaterial },
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
    assert.deepEqual(mock.errors, []);
    assert.ok(renderer.stats.populationBatches > 0);
    assert.ok(renderer.stats.populationInstances > 10);
    assert.equal(population.stats().types, 6); // rocks, boulders, debris, vegetation, decals, environmental props
    // PopulationWorld carries each type's LOD metadata through to its streamed submission, and the
    // renderer selects windows on-device without turning instances into entities.
    assert.ok(renderer.stats.populationLodBatches > 0);
    assertContains(renderer.passNames, "forge.populationLod");
    // No entity was created for any of them — the camera/sun/terrain-chunk entities are all there is.
    assert.equal(scene.entityCount, entitiesBefore);
    // Population batches are regular batches: the device object culler tests them like any other.
    assert.ok(renderer.stats.cullTested >= renderer.stats.populationBatches);

    // Steady frame: pooling holds, no new textures, still no errors — and the population data is
    // device-resident: the steady frame uploads nothing for it (Phase 14.3).
    renderer.renderScene(scene, ctx);
    assert.deepEqual(mock.errors, []);
    assert.equal(renderer.stats.texturesCreated, 0);
    assert.ok(renderer.stats.populationBuffers > 0);
    assert.equal(renderer.stats.populationUploads, 0);

    renderer.dispose();
    population.dispose();
    terrain.dispose();
    rockMaterial.dispose();
    debrisMaterial.dispose();
    vegetationMaterial.dispose();
    decalMaterial.dispose();
    spireMaterial.dispose();
    rockGeometry.dispose();
    boulderGeometry.dispose();
    debrisGeometry.dispose();
    vegetationGeometry.dispose();
    decalGeometry.dispose();
    spireGeometry.dispose();
    scene.dispose();
    await device.dispose();
    assert.deepEqual(mock.outstanding.buffers, []);
    assert.deepEqual(mock.outstanding.textures, []);
  });
});

group("Population - rock primitive", () => {
  test("is deterministic per seed and stays inside its displaced, flattened envelope", () => {
    const a = rockGeometrySource({ radius: 1, seed: 4, roughness: 0.3, flatten: 0.4, segments: 8 });
    const b = rockGeometrySource({ radius: 1, seed: 4, roughness: 0.3, flatten: 0.4, segments: 8 });
    assert.deepEqual([...a.positions!], [...b.positions!]);
    const c = rockGeometrySource({ radius: 1, seed: 5, roughness: 0.3, flatten: 0.4, segments: 8 });
    assert.notDeepEqual([...a.positions!], [...c.positions!]);

    const maxRadius = 1 * (1 + 0.3 * (1 + 0.45 + 0.45 * 0.45));
    let minY = Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < a.positions!.length; i += 3) {
      const x = a.positions![i]!;
      const y = a.positions![i + 1]!;
      const z = a.positions![i + 2]!;
      assert.equal(Number.isFinite(x + y + z), true);
      assert.ok(Math.hypot(x, z) <= maxRadius + 1e-6);
      assert.ok(y <= maxRadius * (1 - 0.4) + 1e-6);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
    assert.ok(maxY > 0);
    assert.ok(minY < 0);
    // Flattened: the vertical extent is measurably squat versus the horizontal reach.
    assert.ok(maxY - minY < 2 * maxRadius * (1 - 0.4));
    // Normals are normalized.
    for (let i = 0; i < a.normals!.length; i += 3) {
      const n = Math.hypot(a.normals![i]!, a.normals![i + 1]!, a.normals![i + 2]!);
      assertCloseTo(n, 1, 3);
    }
  });

  group("Physics-based population settling (Phase 14 / 15.5)", () => {
    test("leaves objects on gentle slopes at rest in static equilibrium", () => {
      const block = new PopulationInstanceBlock(4);
      // Place one rock at (0, 0, 0)
      block.positions[0] = 0;
      block.positions[1] = 0;
      block.positions[2] = 0;
      block.scales[0] = 1;
      block.scales[1] = 1;
      block.scales[2] = 1;
      block.rotations[0] = 0;
      block.count = 1;

      // Gentle slope: tan(theta) = 0.15 (slope < round rock friction 0.60)
      const sampler = {
        heightAt: (x: number) => 0.15 * x,
        normalYAt: () => Math.cos(Math.atan(0.15)),
      };
      const spec = resolvePopulationTypeSpec(rockSpec({ embed: 0 }));

      const settled = settlePopulationBlockWithPhysics(block, spec, sampler, { gravity: 3.72, maxSteps: 60 });
      assert.equal(settled, 1);
      // In static equilibrium, gravity is balanced by static friction: object stays in place
      assertCloseTo(block.positions[0], 0, 3);
      assertCloseTo(block.positions[2], 0, 3);
      assertCloseTo(block.positions[1], 0, 3);
    });

    test("rolls or slides objects on steep slopes downhill into stable ground", () => {
      const block = new PopulationInstanceBlock(4);
      // Place one round rock at x = 5 on a steep slope (tan=1.2, exceeding friction 0.6) with valley at x <= 0
      block.positions[0] = 5;
      block.positions[1] = 6;
      block.positions[2] = 0;
      block.scales[0] = 1;
      block.scales[1] = 1;
      block.scales[2] = 1;
      block.rotations[0] = 0;
      block.count = 1;

      // Steep hillside descending to a flat valley at x <= 0
      const sampler = {
        heightAt: (x: number) => Math.max(0, 1.2 * x),
        normalYAt: (x: number) => (x > 0 ? 1 / Math.hypot(1.2, 1) : 1),
      };
      const spec = resolvePopulationTypeSpec(rockSpec({ embed: 0 }));

      settlePopulationBlockWithPhysics(block, spec, sampler, { gravity: 3.72, maxSteps: 180 });

      // Object should have rolled downhill towards negative x into the valley
      assert.ok(block.positions[0] < 1.0);
      // Height should follow the terrain valley surface
      assertCloseTo(block.positions[1], sampler.heightAt(block.positions[0]!), 2);
      // Rotation should have accumulated from rolling downhill
      assert.ok(block.rotations[0] > 0.5);
    });
  });
});

await finish();
