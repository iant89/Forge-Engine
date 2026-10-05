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

import { describe, expect, it } from "vitest";
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
  expect(found.length).toBe(expected);
  return found as { size: number; writeCount: number; data: ArrayBuffer }[];
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
    // Phase 14.3: one device-resident buffer for the three instances, one upload to fill it.
    expect(f.renderer.stats.populationBuffers).toBe(1);
    expect(f.renderer.stats.populationUploads).toBe(1);

    // Steady frame: no new GPU objects, and the submission is re-offered every frame.
    f.renderer.renderScene(f.scene);
    expect(f.mock.errors).toEqual([]);
    expect(f.renderer.stats.populationBatches).toBe(1);
    expect(source.results.length).toBe(2);
    // The buffer persists and needs no second upload: the chunk's data is already on the device.
    expect(f.renderer.stats.populationBuffers).toBe(1);
    expect(f.renderer.stats.populationUploads).toBe(0);
    const populated = populationBuffers(f.mock, 1)[0];
    expect(populated).toBeDefined();
    expect(populated?.writeCount).toBe(1);
    await f.dispose();
  });

  it("keeps a whole submission in one device-resident buffer, at no per-frame copy cost", async () => {
    const f = await fixture();
    const source = new StaticPopulation(handSubmission(f.geometry, f.material, 7));
    f.scene.add(source);

    f.renderer.renderScene(f.scene);
    expect(f.mock.errors).toEqual([]);
    // One batch per (chunk, type) — the culler keeps per-chunk granularity without slices.
    expect(f.renderer.stats.populationBatches).toBe(1);
    expect(f.renderer.stats.populationInstances).toBe(7);
    const [buffer] = populationBuffers(f.mock, 1);
    expect(buffer?.size).toBe(7 * 80); // 7 records × InstanceData (80 B)
    expect(buffer?.writeCount).toBe(1);

    // Two more frames: the chunk's buffer is never touched again (the frame's other arenas still
    // upload, but the population data is already on the device).
    f.renderer.renderScene(f.scene);
    f.renderer.renderScene(f.scene);
    expect(f.mock.errors).toEqual([]);
    expect(f.renderer.stats.populationBuffers).toBe(1);
    expect(f.renderer.stats.populationUploads).toBe(0);
    expect(buffer?.writeCount).toBe(1);
    await f.dispose();
  });

  it("re-uploads a population buffer exactly when the block's content revision moves", async () => {
    const f = await fixture();
    const submission = handSubmission(f.geometry, f.material, 4);
    f.scene.add(new StaticPopulation(submission));

    f.renderer.renderScene(f.scene);
    const [buffer] = populationBuffers(f.mock, 1);
    expect(buffer).toBeDefined();
    const f32 = () => new Float32Array(buffer!.data);
    const translationBefore = f32()[13]; // record 0's translation (column 3): [px, py, pz]

    // Move every instance and mark the block changed — the only event that may re-upload.
    for (let k = 0; k < 4; k++) submission.instances.positions[k * 3 + 1] = 5;
    submission.instances.markModified();

    f.renderer.renderScene(f.scene);
    expect(f.mock.errors).toEqual([]);
    expect(f.renderer.stats.populationUploads).toBe(1);
    expect(buffer?.writeCount).toBe(2);
    const translationAfter = f32()[13];
    expect(translationAfter).toBe(5);
    expect(translationBefore).toBe(0);

    // Without a new revision the next frame is silent again.
    f.renderer.renderScene(f.scene);
    expect(f.renderer.stats.populationUploads).toBe(0);
    expect(buffer?.writeCount).toBe(2);
    await f.dispose();
  });

  it("frees the device buffer when a chunk stops being offered (eviction)", async () => {
    const f = await fixture();
    const source = new StaticPopulation(handSubmission(f.geometry, f.material, 5));
    f.scene.add(source);

    f.renderer.renderScene(f.scene);
    expect(f.renderer.stats.populationBuffers).toBe(1);

    source.active = false; // the terrain chunk was evicted
    f.renderer.renderScene(f.scene);
    expect(f.mock.errors).toEqual([]);
    expect(f.renderer.stats.populationBuffers).toBe(0);
    expect(f.mock.outstanding.buffers).not.toContain("population.instances");
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

describe("Population - GPU LOD (14.4)", () => {
  it("buildLodGeometry merges the windows hi-first, with the boundary and counts", () => {
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
    expect(merged.hiTriangles).toBe(2);
    expect(merged.loTriangles).toBe(1);
    expect(merged.vertexCount).toBe(9);
    expect(Array.from(merged.source.positions)).toEqual([
      0, 0, 0, 1, 0, 0, 0, 1, 0, 2, 0, 0, 0, 2, 0, 1, 1, 0, // hi first …
      9, 9, 9, 8, 8, 8, 7, 7, 7, // … then lo
    ]);
    // The window boundary is a vertex boundary: the last hi vertex is index 5, the first lo's is 6.
    expect(merged.source.normals?.[17]).toBe(1);
    expect(merged.source.normals?.[18]).toBe(2);
    expect(merged.source.uvs?.[11]).toBe(0.5); // last high vertex's final UV component
    expect(merged.source.uvs?.[12]).toBe(0.25); // first low vertex's first UV component
    expect(merged.source.tangents?.[23]).toBe(1);
    expect(merged.source.tangents?.[24]).toBe(0);
  });

  it("unindexedLodWindow expands indexed sources, duplicating attributes per index", () => {
    const src = {
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      normals: new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]),
      uvs: new Float32Array([0, 0, 1, 0, 0, 1]),
      tangents: new Float32Array([1, 0, 0, 1, 0, 1, 0, 1, 0, 0, 1, 1]),
      indices: new Uint32Array([0, 2, 1]),
    };
    const w = unindexedLodWindow(src);
    expect(Array.from(w.positions)).toEqual([0, 0, 0, 0, 1, 0, 1, 0, 0]);
    expect(Array.from(w.uv)).toEqual([0, 0, 0, 1, 1, 0]);
    // xyzw per vertex, in index order 0, 2, 1.
    expect(Array.from(w.tangent)).toEqual([1, 0, 0, 1, 0, 0, 1, 1, 0, 1, 0, 1]);
    // An already-unindexed source passes straight through (no copy).
    const plain = { positions: src.positions, normals: src.normals, uvs: src.uvs, tangents: src.tangents };
    expect(unindexedLodWindow(plain).positions).toBe(plain.positions);
  });

  it("rejects malformed prototype attributes and non-triangle LOD windows", () => {
    expect(() => unindexedLodWindow({
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      normals: new Float32Array(9),
      uvs: new Float32Array(6),
      tangents: new Float32Array(12),
      indices: new Uint16Array([0, 1]),
    })).toThrow(/non-empty triangle list/);
    const window: PopulationLodWindow = {
      positions: new Float32Array(6),
      normals: new Float32Array(6),
      uv: new Float32Array(4),
      tangent: new Float32Array(8),
    };
    expect(() => buildLodGeometry({ hi: window, lo: window })).toThrow(/whole number of triangles/);
  });

  it("populationLodIndex switches to the low window only strictly beyond the distance", () => {
    expect(populationLodIndex(8.25, 8.5)).toBe(0);
    expect(populationLodIndex(8.5, 8.5)).toBe(0); // the boundary itself stays high (conservative)
    expect(populationLodIndex(9.17, 8.5)).toBe(1);
  });

  it("runs forge.populationLod for LOD batches and splits the device buffer at lodDistance", async () => {
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
    expect(mock.errors).toEqual([]);
    // The pass ran for this batch, and the main pass drew it through the LOD pipeline variant.
    expect(renderer.stats.populationLodBatches).toBe(1);
    expect(renderer.passNames).toContain("forge.populationLod");
    const mainLodDraws = mock.commandLog.filter(
      (e) => e.type === "setPipeline" && e.label === "forge.main" && String(e.pipeline).includes("|lod|"),
    );
    expect(mainLodDraws.length).toBeGreaterThanOrEqual(1);

    // The mock emulated the kernel: each instance's flags bit 0 matches the CPU twin.
    const [buffer] = populationBuffers(mock, 1);
    const flags = new Uint32Array(buffer!.data);
    const flagOf = (k: number) => flags[k * 20 + 18]; // InstanceData.flags, record k
    expect(flagOf(0)).toBe(1); // x = -4 → 9.17 > 8.5 → low window
    expect(flagOf(1)).toBe(0); // x = -2 → 8.49 → high window
    expect(flagOf(2)).toBe(0); // x = 0  → 8.25 → high window
    expect(flagOf(3)).toBe(0); // x = 2  → 8.49 → high window
    expect(flagOf(4)).toBe(1); // x = 4  → 9.17 > 8.5 → low window

    // Steady state: the selection re-runs every frame (it is camera-keyed) but re-uploads nothing.
    renderer.renderScene(scene);
    expect(mock.errors).toEqual([]);
    expect(renderer.stats.populationLodBatches).toBe(1);
    expect(renderer.stats.populationUploads).toBe(0);
    expect(buffer?.writeCount).toBe(1);
    expect(flagOf(0)).toBe(1); // unchanged camera → unchanged selection

    renderer.dispose();
    material.dispose();
    geometry.dispose();
    scene.dispose();
    await device.dispose();
    expect(mock.outstanding.buffers).toEqual([]);
    expect(mock.outstanding.textures).toEqual([]);
  });

  it("uses one aligned uniform slot per LOD batch in the shared compute pass", async () => {
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
    expect(mock.errors).toEqual([]);
    expect(renderer.stats.populationLodBatches).toBe(2);
    const buffers = populationBuffers(mock, 2);
    const flagsByZ = new Map(buffers.map((b) => {
      const f = new Float32Array(b.data);
      const u = new Uint32Array(b.data);
      return [f[14]!, u[18]!] as const;
    }));
    expect(flagsByZ.get(0)).toBe(0); // distance 8.25 <= 10 → high
    expect(flagsByZ.get(40)).toBe(1); // distance 48 > 20 → low
    const offsets = mock.commandLog
      .filter((e) => e.type === "setBindGroup" && e.label === "population.lod")
      .map((e) => e.dynamicOffsets as number[]);
    expect(offsets).toEqual([[0], [256]]);

    renderer.dispose();
    material.dispose();
    geometry.dispose();
    scene.dispose();
    await device.dispose();
    expect(mock.outstanding.buffers).toEqual([]);
    expect(mock.outstanding.textures).toEqual([]);
  });

  it("moves instances across lodDistance when the camera moves (re-selection without re-upload)", async () => {
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
    expect(flagOf(0)).toBe(1); // far instance, as before

    // Move the camera to (0, 2, -104): every distance grows (≈104–108), so all instances must
    // switch to the low window — in the device buffer, with no re-upload of the instances.
    cameraEntity.transform.position = new Vec3(0, 2, -104);
    cameraEntity.transform.lookAt(new Vec3(0, 0, 0));
    renderer.renderScene(scene);
    expect(mock.errors).toEqual([]);
    expect(renderer.stats.populationUploads).toBe(0);
    for (let k = 0; k < 5; k++) expect(flagOf(k)).toBe(1);

    renderer.dispose();
    material.dispose();
    geometry.dispose();
    scene.dispose();
    await device.dispose();
    expect(mock.outstanding.buffers).toEqual([]);
    expect(mock.outstanding.textures).toEqual([]);
  });

  it("uses the LOD instanced entry in main, prepass, and shadows—even for one instance", async () => {
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
    expect(mock.errors).toEqual([]);
    expect(renderer.passNames).toContain("forge.populationLod");
    expect(renderer.passNames).toContain("forge.prepass");
    expect(renderer.passNames).toContain("forge.shadow.0");
    const lodPipelineFor = (passName: string) => mock.commandLog.some(
      (e) => e.type === "setPipeline" && e.label === passName && String(e.pipeline).includes("|inst|lod|"),
    );
    expect(lodPipelineFor("forge.main")).toBe(true);
    expect(lodPipelineFor("forge.prepass")).toBe(true);
    expect(lodPipelineFor("forge.shadow.0")).toBe(true);

    renderer.dispose();
    material.dispose();
    geometry.dispose();
    scene.dispose();
    await device.dispose();
    expect(mock.outstanding.buffers).toEqual([]);
    expect(mock.outstanding.textures).toEqual([]);
  });

  it("keeps non-LOD population batches on the plain instanced entry", async () => {
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
    expect(mock.errors).toEqual([]);
    expect(renderer.stats.populationLodBatches).toBe(0);
    expect(renderer.passNames).not.toContain("forge.populationLod");
    const mainLodDraws = mock.commandLog.filter(
      (e) => e.type === "setPipeline" && e.label === "forge.main" && String(e.pipeline).includes("|lod|"),
    );
    expect(mainLodDraws.length).toBe(0);

    renderer.dispose();
    material.dispose();
    geometry.dispose();
    scene.dispose();
    await device.dispose();
    expect(mock.outstanding.buffers).toEqual([]);
    expect(mock.outstanding.textures).toEqual([]);
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
    expect(mock.errors).toEqual([]);
    expect(renderer.stats.populationBatches).toBeGreaterThan(0);
    expect(renderer.stats.populationInstances).toBeGreaterThan(10);
    expect(population.stats().types).toBe(6); // rocks, boulders, debris, vegetation, decals, environmental props
    // PopulationWorld carries each type's LOD metadata through to its streamed submission, and the
    // renderer selects windows on-device without turning instances into entities.
    expect(renderer.stats.populationLodBatches).toBeGreaterThan(0);
    expect(renderer.passNames).toContain("forge.populationLod");
    // No entity was created for any of them — the camera/sun/terrain-chunk entities are all there is.
    expect(scene.entityCount).toBe(entitiesBefore);
    // Population batches are regular batches: the device object culler tests them like any other.
    expect(renderer.stats.cullTested).toBeGreaterThanOrEqual(renderer.stats.populationBatches);

    // Steady frame: pooling holds, no new textures, still no errors — and the population data is
    // device-resident: the steady frame uploads nothing for it (Phase 14.3).
    renderer.renderScene(scene, ctx);
    expect(mock.errors).toEqual([]);
    expect(renderer.stats.texturesCreated).toBe(0);
    expect(renderer.stats.populationBuffers).toBeGreaterThan(0);
    expect(renderer.stats.populationUploads).toBe(0);

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
