/**
 * @suite terrain:marsTerrain
 * @group unit
 * @covers engine/src/core/errors.ts
 * @covers engine/src/core/log.ts
 * @covers engine/src/core/tasks/scheduler.ts
 * @covers engine/src/core/time.ts
 * @covers engine/src/debug/profiler.ts
 * @covers engine/src/index.ts
 * @covers engine/src/scene/components/index.ts
 * @covers engine/src/scene/scene.ts
 * @covers engine/src/scene/systems.ts
 * @covers engine/src/scene/world.ts
 * @covers engine/src/terrain/chunk.ts
 * @covers engine/src/terrain/generators.ts
 * @covers engine/src/terrain/mars/config.ts
 * @covers engine/src/terrain/mars/cubeSphere.ts
 * @covers engine/src/terrain/mars/geology.ts
 * @covers engine/src/terrain/mars/globalFields.ts
 * @covers engine/src/terrain/mars/stage.ts
 * @covers engine/src/terrain/pipelineSpec.ts
 * @covers engine/src/terrain/world.ts
 * @desc Pins mars terrain behavior and regression guarantees
 */

export const suite = {
  name: "terrain:marsTerrain",
  group: "unit",
  covers:   [
    "engine/src/core/errors.ts",
    "engine/src/core/log.ts",
    "engine/src/core/tasks/scheduler.ts",
    "engine/src/core/time.ts",
    "engine/src/debug/profiler.ts",
    "engine/src/index.ts",
    "engine/src/scene/components/index.ts",
    "engine/src/scene/scene.ts",
    "engine/src/scene/systems.ts",
    "engine/src/scene/world.ts",
    "engine/src/terrain/chunk.ts",
    "engine/src/terrain/generators.ts",
    "engine/src/terrain/mars/config.ts",
    "engine/src/terrain/mars/cubeSphere.ts",
    "engine/src/terrain/mars/geology.ts",
    "engine/src/terrain/mars/globalFields.ts",
    "engine/src/terrain/mars/stage.ts",
    "engine/src/terrain/pipelineSpec.ts",
    "engine/src/terrain/world.ts"
  ],
  desc: "Pins mars terrain behavior and regression guarantees",
};
import assert from "node:assert/strict";
import { assertCallCount, assertCloseTo, assertContains, assertNotCalled, assertNotCloseTo, assertRejects, assertThrows, finish, group, spyOn, test } from "selrun";
import {
  Camera,
  Clock,
  EntityWorld,
  GeneratorPipeline,
  InlineOnlyError,
  Logger,
  MARS_GEN_PARAMS,
  MARS_RADIUS_M,
  MARS_SITE_PRESETS,
  MARS_STAGE_A_DEFAULTS,
  MarsCraterScanner,
  MarsGlobalFieldSet,
  MarsMaterial,
  MarsSite,
  MarsTerrainStage,
  Profiler,
  Scene,
  SystemScratch,
  TaskScheduler,
  TerrainTile,
  TerrainWorld,
  Transform,
  adviseMarsTile,
  createMarsGenParams,
  createMarsPipeline,
  createPipelineFromSpec,
  createWorldCell,
  describePipeline,
  hashPipelineSpec,
  marsAngularDistanceMeters,
  marsDepthForChunkEdge,
  marsDepthForChunkEdgeAtMost,
  marsDirectionToFaceUV,
  marsFaceCentreChunkEdgeMeters,
  fetchMarsFaceFields,
  marsFaceFieldsFromBuffers,
  marsFaceUVToDirection,
  marsLatLonOfDirection,
  marsSampleAnalytic,
  marsSampleCraterDelta,
  marsSampleVolcanoDelta,
  marsSurfaceLayers,
  type MarsFaceFields,
  type SystemContext,
} from "@forge/engine";

import { createWorkerThreadPool } from "../support/workerThreads.js";

/**
 * Mars terrain port tests (see docs/MARS-TERRAIN.md).
 *
 * The properties that matter, in order:
 *  - the transcription is deterministic and *seamless* (the reason a stage exists at all),
 *  - the batched crater scan samples exactly the set the generator's per-vertex loop does,
 *  - the Stage A field reader/decoder matches the generator's documented file layout,
 *  - a Mars pipeline plugs into `TerrainWorld` with the sizing/skirt knobs a 300 m planet needs.
 *
 * Numerical agreement with the generator's own files is *not* asserted here (it needs a real
 * `cache/global/`); `tools/mars-port-check.mjs` is the gate for that.
 */

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

/** A synthetic Stage A cache: `erosionDelta` is a known ramp, so bilinear sampling is checkable. */
function fakeFields(res: number, rampDelta = true): MarsFaceFields[] {
  const count = res * res;
  const faces: MarsFaceFields[] = [];
  for (let face = 0; face < 6; face++) {
    const erosionDelta = new Float32Array(count);
    const hardness = new Float32Array(count);
    const flowAccum = new Float32Array(count);
    const material = new Uint8Array(count);
    for (let j = 0; j < res; j++) {
      for (let i = 0; i < res; i++) {
        const idx = j * res + i;
        erosionDelta[idx] = rampDelta ? i / (res - 1) : 0;
        hardness[idx] = j / (res - 1);
        flowAccum[idx] = idx;
        material[idx] = idx % 10;
      }
    }
    faces.push({ face, res, erosionDelta, hardness, material, flowAccum });
  }
  return faces;
}

group("Mars terrain - cube sphere mapping", () => {
  test("maps the six faces onto unit directions and back again", () => {
    for (let face = 0; face < 6; face++) {
      for (const u of [-1, -0.4, 0, 0.4, 1]) {
        for (const v of [-1, -0.4, 0, 0.4, 1]) {
          const dir = marsFaceUVToDirection(face, u, v);
          assertCloseTo(Math.hypot(dir.x, dir.y, dir.z), 1, 12);
          // The inverse is documented as approximate: it is a nearest-face lookup for the Stage A
          // grid, and at a face's own edges the warp genuinely ties with the neighbouring face.
          const back = marsDirectionToFaceUV(dir);
          if (u === 0 && v === 0) {
            // The face centre inverts exactly (that is the case the Stage A lookup relies on).
            assert.equal(back.face, face);
            assertCloseTo(back.u, 0, 12);
            assertCloseTo(back.v, 0, 12);
          } else if (Math.abs(u) < 0.3 && Math.abs(v) < 0.3) {
            assert.equal(back.face, face);
            // Approximate by design (upstream uses the naive cube inverse, not the inverse of the
            // spherify warp): within a tenth of a face coordinate, i.e. a Stage A cell at res 512.
            assert.ok(Math.abs(back.u - u) < 0.12);
            assert.ok(Math.abs(back.v - v) < 0.12);
          }
        }
      }
    }
  });

  test("reports the generator's chunk sizes, matching the documented depth table", () => {
    // The table in docs/MARS-TERRAIN.md: face-centre chunk edge per quadtree depth.
    assertCloseTo(marsFaceCentreChunkEdgeMeters(4, MARS_RADIUS_M) / 1000, 299.98, 1);
    assertCloseTo(marsFaceCentreChunkEdgeMeters(8, MARS_RADIUS_M) / 1000, 18.72, 1);
    assertCloseTo(marsFaceCentreChunkEdgeMeters(12, MARS_RADIUS_M) / 1000, 1.17, 1);
    assertCloseTo(marsFaceCentreChunkEdgeMeters(15, MARS_RADIUS_M) / 1000, 0.146, 2);
    // ... and that a "Forge-sized" chunk is not one of them. `nearest` is the cheapest pick; the
    // `AtMost` rule is the conservative one used for the sizing table in the docs.
    assert.equal(marsDepthForChunkEdge(299_984, MARS_RADIUS_M), 4);
    assert.equal(marsDepthForChunkEdge(256, MARS_RADIUS_M), 14);
    assert.equal(marsDepthForChunkEdgeAtMost(256, MARS_RADIUS_M), 15);
    assert.equal(marsDepthForChunkEdgeAtMost(128, MARS_RADIUS_M), 16);
    assert.equal(marsDepthForChunkEdgeAtMost(64, MARS_RADIUS_M), 17);
    assert.equal(marsDepthForChunkEdgeAtMost(1024, MARS_RADIUS_M), 13);
    // The depth-0 "face-centre chunk" is the whole face, not a NaN from a coordinate outside [-1, 1].
    assertCloseTo(marsFaceCentreChunkEdgeMeters(0, MARS_RADIUS_M) / 1e6, 5.32, 1);
  });

  test("round-trips lat/lon and measures great-circle distances", () => {
    const dir = marsFaceUVToDirection(4, 0.2, -0.3);
    const { latDeg, lonDeg } = marsLatLonOfDirection(dir);
    const back = new MarsSite({ latDeg, lonDeg }).up;
    assertCloseTo(back.x, dir.x, 6);
    assertCloseTo(back.y, dir.y, 6);
    assertCloseTo(back.z, dir.z, 6);
    // A quarter of the way round the planet is a quarter of the circumference.
    const equatorialA = marsFaceUVToDirection(4, 0, 0);
    const equatorialB = { x: equatorialA.x, y: equatorialA.y, z: equatorialA.z };
    const north = { x: 0, y: 1, z: 0 };
    assertCloseTo(marsAngularDistanceMeters(equatorialB, north, MARS_RADIUS_M), (Math.PI / 2) * MARS_RADIUS_M, 3);
  });
});

group("Mars terrain - analytic geology", () => {
  test("is deterministic in the direction and seed", () => {
    const dir = marsFaceUVToDirection(2, 0.31, 0.11);
    const a = marsSampleAnalytic(dir.x, dir.y, dir.z, MARS_GEN_PARAMS);
    const b = marsSampleAnalytic(dir.x, dir.y, dir.z, MARS_GEN_PARAMS);
    assert.deepEqual(a, b);
    // A different seed moves the terrain (craters, cones and the material patch all re-hash).
    const other = marsSampleAnalytic(dir.x, dir.y, dir.z, createMarsGenParams({ seed: 4242 }));
    assertNotCloseTo(other.elevation, a.elevation, 3);
  });

  test("puts the config's shield volcano where the config says, at the height it says", () => {
    const volcano = MARS_GEN_PARAMS.volcanoes[0]!;
    const unit = {
      x: volcano.center.x / MARS_RADIUS_M,
      y: volcano.center.y / MARS_RADIUS_M,
      z: volcano.center.z / MARS_RADIUS_M,
    };
    // The summit is `height - calderaDepth` plus a little flank noise: 21 km - 3 km = 18 km.
    const centre = { x: volcano.center.x, y: volcano.center.y, z: volcano.center.z };
    const summit = marsSampleVolcanoDelta(centre.x, centre.y, centre.z, MARS_GEN_PARAMS.volcanoes);
    assert.ok(summit > 17_500);
    assert.ok(summit < 18_500);
    // Far outside the influence radius (1.3x the base radius) the volcano contributes nothing.
    const far = { x: -centre.x, y: -centre.y, z: -centre.z };
    assert.equal(marsSampleVolcanoDelta(far.x, far.y, far.z, MARS_GEN_PARAMS.volcanoes), 0);
    // And the assembled surface is kilometres above the reference sphere up there.
    assert.ok(marsSampleAnalytic(unit.x, unit.y, unit.z, MARS_GEN_PARAMS).elevation > 10_000);
    // The site preset follows the config (not a hard-coded latitude).
    const preset = MARS_SITE_PRESETS.olympusMons!;
    const presetUp = new MarsSite(preset).up;
    const delta = Math.hypot(presetUp.x - unit.x, presetUp.y - unit.y, presetUp.z - unit.z);
    assert.ok(delta < 1e-9);
  });

  test("carves craters deep enough to classify as crater floor", () => {
    // Find a crater the generator's own hashing placed, by scanning a small region for a negative
    // delta, then check the material that goes with it.
    const seed = MARS_GEN_PARAMS.seed;
    let inside = 0;
    let floorMaterial = 0;
    let deepest = 0;
    for (let i = 0; i < 300; i++) {
      const dir = marsFaceUVToDirection(0, -0.2 + i * 0.0013, -0.2 + (i % 23) * 0.0007);
      const crater = marsSampleCraterDelta(dir.x * MARS_RADIUS_M, dir.y * MARS_RADIUS_M, dir.z * MARS_RADIUS_M, seed);
      deepest = Math.min(deepest, crater.delta);
      if (crater.inCrater) {
        inside++;
        if (marsSampleAnalytic(dir.x, dir.y, dir.z, MARS_GEN_PARAMS).material === MarsMaterial.CraterFloor) floorMaterial++;
      }
    }
    // Craters are the defining Mars feature: the scan must find bowls, deep ones, and classify them.
    assert.ok(inside > 0);
    assert.ok(floorMaterial > 0);
    assert.ok(deepest < -100);
  });

  test("samples exactly the same crater set per chunk as the direct per-vertex loop", () => {
    const scanner = new MarsCraterScanner(MARS_GEN_PARAMS.seed);
    const reference = (dir: { x: number; y: number; z: number }) =>
      marsSampleCraterDelta(dir.x * MARS_RADIUS_M, dir.y * MARS_RADIUS_M, dir.z * MARS_RADIUS_M, MARS_GEN_PARAMS.seed);
    let worst = 0;
    let inCraterMismatch = 0;
    for (let j = 0; j < 21; j++) {
      for (let i = 0; i < 21; i++) {
        const dir = marsFaceUVToDirection(3, 0.4 + i * 2e-4, -0.15 + j * 2e-4);
        const fast = scanner.deltaAt(dir.x * MARS_RADIUS_M, dir.y * MARS_RADIUS_M, dir.z * MARS_RADIUS_M);
        const slow = reference(dir);
        worst = Math.max(worst, Math.abs(fast.delta - slow.delta));
        if (fast.inCrater !== slow.inCrater) inCraterMismatch++;
      }
    }
    // Identical set; the only difference is the order the terms are summed in, which shows up in the
    // last bits of a value that is metres, not nanometres.
    assert.ok(worst < 1e-6);
    assert.equal(inCraterMismatch, 0);
  });
});

group("Mars terrain - Stage A field cache", () => {
  test("decodes the generator's on-disk layout and bilinearly samples it", () => {
    const res = 5;
    const buffers = {
      face: 4,
      res,
      erosionDelta: new Float32Array(res * res).map((_, i) => i).buffer,
      hardness: new Float32Array(res * res).fill(0.25).buffer,
      flowAccum: new Float32Array(res * res).fill(10).buffer,
      material: new Uint8Array(res * res).fill(MarsMaterial.VolcanicFlank).buffer,
    };
    const face = marsFaceFieldsFromBuffers(buffers);
    assert.equal(face.res, res);
    assert.equal(face.erosionDelta.length, res * res);
    assert.equal(face.material[7], MarsMaterial.VolcanicFlank);

    const set = new MarsGlobalFieldSet([face]);
    assert.deepEqual(set.availableFaces, [4]);
    assert.deepEqual(set.missingFaces, [0, 1, 2, 3, 5]);
    assert.equal(set.complete, false);

    // Face-centre (`u = v = 0` on PZ) is the middle of the grid: the exact centre of cell (2,2).
    const centre = set.sample(0, 0, 1);
    assert.equal(centre.erosionDelta, 2 * res + 2);
    assertCloseTo(centre.hardness, 0.25, 6);
    assert.equal(centre.material, MarsMaterial.VolcanicFlank);

    // Quarter of the way across samples the next columns bilinearly.
    const quarter = set.sample(0.5, 0, 1);
    assert.ok(quarter.erosionDelta > centre.erosionDelta);

    // A face with no fields loaded is neutral, not an error.
    const missing = new MarsGlobalFieldSet([]);
    const neutral = missing.sample(0, 1, 0);
    assert.equal(neutral.erosionDelta, 0);
    assert.equal(neutral.hardness, 0.5);
    assert.equal(missing.bytes, 0);
  });

  test("loads a face over HTTP the way the docs' recipe does", async () => {
    const res = 4;
    const count = res * res;
    const payloads = {
      "erosionDelta.f32": new Float32Array(count).fill(1.5).buffer,
      "hardness.f32": new Float32Array(count).fill(0.5).buffer,
      "flowAccum.f32": new Float32Array(count).fill(2).buffer,
      "material.u8": new Uint8Array(count).fill(MarsMaterial.Regolith).buffer,
    } as Record<string, ArrayBuffer>;
    const requested: string[] = [];
    const fakeFetch = (async (url: string) => {
      requested.push(url);
      if (url.endsWith("meta.json")) {
        return { ok: true, status: 200, json: async () => ({ face: 2, res }) } as unknown as Response;
      }
      const name = url.split("/").pop()!;
      const body = payloads[name];
      if (!body) return { ok: false, status: 404 } as unknown as Response;
      return { ok: true, status: 200, arrayBuffer: async () => body } as unknown as Response;
    }) as unknown as typeof fetch;

    const face = await fetchMarsFaceFields("https://example.test/mars/face_2", 2, fakeFetch);
    assert.equal(face.res, res);
    assert.equal(face.face, 2);
    assertCloseTo(face.erosionDelta[0], 1.5, 6);
    assertContains(requested, "https://example.test/mars/face_2/meta.json");
    assertContains(requested, "https://example.test/mars/face_2/erosionDelta.f32");

    const set = new MarsGlobalFieldSet([face]);
    assert.equal(set.has(2), true);
    assert.ok(set.bytes > 0);
    // (0, 1, 0) is on face PY, the one that was loaded.
    assertCloseTo(set.sample(0, 1, 0).erosionDelta, 1.5, 6);

    // A missing file must name the URL rather than decoding garbage.
    const missing = (async () => ({ ok: false, status: 404 }) as unknown as Response) as unknown as typeof fetch;
    await assertRejects(fetchMarsFaceFields("https://example.test/mars/face_2", 2, missing), /meta\.json/);
  });

  test("rejects buffers that cannot hold the grid the metadata claims", () => {
    assertThrows(() =>
      marsFaceFieldsFromBuffers({
        face: 0,
        res: 8,
        erosionDelta: new Float32Array(4).buffer,
        hardness: new Float32Array(64).buffer,
        flowAccum: new Float32Array(64).buffer,
        material: new Uint8Array(64).buffer,
      }), /erosionDelta/);
  });
});

group("Mars terrain - MarsTerrainStage", () => {
  test("fills a WorldCell with heights, slopes and splat weights", () => {
    const pipeline = createMarsPipeline({ site: { latDeg: 0, lonDeg: 0 } });
    const tile = new TerrainTile({ cx: 4, cz: -3, size: 128, resolution: 33 }, pipeline, MARS_GEN_PARAMS.seed);

    assert.equal(tile.cell.heights.length, 33 * 33);
    assert.equal(tile.cell.biomes.length, 33 * 33 * 4);
    for (let i = 0; i < tile.cell.heights.length; i++) {
      assert.equal(Number.isFinite(tile.cell.heights[i]!), true);
      assert.ok(tile.cell.slopes[i]! >= 0);
      const b = i * 4;
      const sum =
        tile.cell.biomes[b]! + tile.cell.biomes[b + 1]! + tile.cell.biomes[b + 2]! + tile.cell.biomes[b + 3]!;
      assertCloseTo(sum, 1, 6);
    }
    // Skirts/culling need real bounds, and a Mars patch has real relief.
    assert.ok(tile.heightmap.maxHeight > tile.heightmap.minHeight);
    assert.equal(tile.cell.scatters.length, 0);
  });

  test("is identical for a given chunk, and seamless across a chunk edge", () => {
    const pipeline = createMarsPipeline({ site: { latDeg: 12, lonDeg: -40 } });
    const a1 = new TerrainTile({ cx: 2, cz: 2, size: 256, resolution: 33 }, pipeline, MARS_GEN_PARAMS.seed);
    const a2 = new TerrainTile({ cx: 2, cz: 2, size: 256, resolution: 33 }, pipeline, MARS_GEN_PARAMS.seed);
    assert.deepEqual(Array.from(a1.cell.heights), Array.from(a2.cell.heights));

    // The east column of chunk (2,2) and the west column of chunk (3,2) are the same world line.
    const east = new TerrainTile({ cx: 3, cz: 2, size: 256, resolution: 33 }, pipeline, MARS_GEN_PARAMS.seed);
    let worst = 0;
    for (let j = 0; j < 33; j++) {
      const rightEdge = a1.cell.heights[j * 33 + 32]!;
      const leftEdge = east.cell.heights[j * 33]!;
      worst = Math.max(worst, Math.abs(rightEdge - leftEdge));
    }
    // Every vertex is evaluated from its absolute direction, so shared vertices agree exactly.
    assert.ok(worst < 1e-9);
  });

  test("applies the Stage A erosion correction when fields are supplied", () => {
    const fields = new MarsGlobalFieldSet(fakeFields(64, true));
    const withFields = createMarsPipeline({ site: { latDeg: 0, lonDeg: 0 }, globalFields: fields });
    const without = createMarsPipeline({ site: { latDeg: 0, lonDeg: 0 } });
    const a = new TerrainTile({ cx: 0, cz: 0, size: 256, resolution: 17 }, withFields, MARS_GEN_PARAMS.seed);
    const b = new TerrainTile({ cx: 0, cz: 0, size: 256, resolution: 17 }, without, MARS_GEN_PARAMS.seed);
    let differs = 0;
    for (let i = 0; i < a.cell.heights.length; i++) {
      if (Math.abs(a.cell.heights[i]! - b.cell.heights[i]!) > 1e-6) differs++;
    }
    assert.equal(differs, a.cell.heights.length);
    const stage = new MarsTerrainStage({ globalFields: fields });
    assert.equal(stage.hasErosionCorrection, true);
    assert.equal(new MarsTerrainStage({}).hasErosionCorrection, false);
  });

  test("subtracts the sphere's curvature so a tangent patch is a height field", () => {
    const site = new MarsSite({ latDeg: 0, lonDeg: 0 });
    const rising = 123.5;
    // 1 km out, the sphere has dropped 1 km^2 / (2R) = 0.1475 m below the tangent plane.
    const sag1km = site.planeHeight(0, 1000, 0, true) - 0;
    assertCloseTo(sag1km, -(1000 * 1000) / (2 * MARS_RADIUS_M), 4);
    assert.equal(site.planeHeight(rising, 2000, -1000, false), rising);
    const d = Math.hypot(2000, -1000);
    const expected = (MARS_RADIUS_M + rising) * Math.cos(d / MARS_RADIUS_M) - MARS_RADIUS_M;
    assertCloseTo(site.planeHeight(rising, 2000, -1000, true), expected, 9);
  });

  test("keeps its distance and heading conventions", () => {
    const site = new MarsSite({ latDeg: 10, lonDeg: 20 });
    // Local +Z is north (towards the planet's pole) before any heading.
    const north = site.latLonFor(0, 1000);
    assert.ok(north.latDeg > 10);
    // Local +X is east, i.e. +90 degrees of longitude at this latitude.
    const east = site.latLonFor(1000, 0);
    assert.ok(east.lonDeg > 20);
    assertCloseTo(east.latDeg, 10, 6);
    // 90 degrees of heading swaps the two.
    const turned = new MarsSite({ latDeg: 10, lonDeg: 20, headingDeg: 90 });
    const turnedEast = turned.latLonFor(1000, 0);
    assert.ok(turnedEast.latDeg > 10);
  });

  test("round-trips the complete analytic planet and site as structured-cloneable data", () => {
    const params = createMarsGenParams({
      seed: 541,
      radius: MARS_RADIUS_M * 0.98,
      dichotomy: { seed: 62, amplitude: 1700, axis: { x: 0.1, y: 0.9, z: -0.3 }, waviness: 0.7 },
      canyon: [{ a: { x: 0, y: 1, z: 0 }, b: { x: 1, y: 0.2, z: 0.1 }, width: 2, depth: 51 }],
      volcanoes: [{ center: { x: MARS_RADIUS_M, y: 0, z: 0 }, baseRadius: 400_000,
        height: 900, calderaRadius: 15_000, calderaDepth: 70, seed: 12 }],
    });
    for (const pipeline of [
      createMarsPipeline(),
      createMarsPipeline({ site: { latDeg: 0, lonDeg: 0 } }),
      createMarsPipeline({ params, site: { latDeg: 1, lonDeg: 2, headingDeg: 72, radiusM: MARS_RADIUS_M * 0.9 }, detail: false, curvatureCompensation: false }),
      createMarsPipeline({ params, site: { latDeg: -8, lonDeg: 12, headingDeg: -31, radiusM: MARS_RADIUS_M * 1.1 } }),
    ]) {
      const spec = structuredClone(describePipeline(pipeline));
      const rebuilt = createPipelineFromSpec(spec);
      assert.deepEqual(describePipeline(rebuilt), spec);
      const originalStage = pipeline.stages[0] as MarsTerrainStage;
      const restoredStage = rebuilt.stages[0] as MarsTerrainStage;
      assert.deepEqual(restoredStage.params, originalStage.params);
      assert.equal(restoredStage.site.radius, originalStage.site.radius);
      assert.equal(restoredStage.globalFields, null);
      // Reference the ORIGINAL live pipeline, not two calls to the same reconstruction code.
      const original = createWorldCell(-3, 4, 128, 17, originalStage.seed);
      const restored = createWorldCell(-3, 4, 128, 17, originalStage.seed);
      pipeline.execute(original);
      rebuilt.execute(restored);
      assert.deepEqual(restored.heights, original.heights);
      assert.deepEqual(restored.slopes, original.slopes);
      assert.deepEqual(restored.biomes, original.biomes);
      assert.equal(hashPipelineSpec(describePipeline(rebuilt)), hashPipelineSpec(spec));
    }
  });

  test("includes the site's own radius in the cache identity, not only the planet radius", () => {
    const make = (radiusM: number) => createMarsPipeline({ site: { latDeg: 1, lonDeg: 2, radiusM } });
    const a = describePipeline(make(MARS_RADIUS_M));
    const b = describePipeline(make(MARS_RADIUS_M * 0.9));
    assert.notEqual(hashPipelineSpec(a), hashPipelineSpec(b));
    assert.equal(hashPipelineSpec(describePipeline(make(MARS_RADIUS_M))), hashPipelineSpec(a));
    assert.equal((createPipelineFromSpec(b).stages[0] as MarsTerrainStage).site.radius, MARS_RADIUS_M * 0.9);
    const moved = describePipeline(createMarsPipeline({ site: { latDeg: 1, lonDeg: 3 } }));
    assert.notEqual(hashPipelineSpec(a), hashPipelineSpec(moved));
  });

  test("keeps live Stage A fields inline instead of reconstructing an uneroded planet", () => {
    for (const fields of [new MarsGlobalFieldSet(fakeFields(4)), new MarsGlobalFieldSet([])]) {
      const pipeline = createMarsPipeline({ globalFields: fields });
      const spec = structuredClone(describePipeline(pipeline));
      assert.equal(spec.stages[0]!.kind, "mars");
      assert.equal(spec.stages[0]!.options.seed, MARS_GEN_PARAMS.seed);
      assertThrows(() => createPipelineFromSpec(spec), InlineOnlyError);
    }
  });

  test("rejects incomplete, malformed or inconsistent serialized configurations", () => {
    const pipeline = createMarsPipeline({ site: { latDeg: 1, lonDeg: 2 }, paramsOverrides: { seed: 5 } });
    for (const identity of ["not JSON", "null", "{}", JSON.stringify({ seed: 5, radius: MARS_RADIUS_M })]) {
      const spec = describePipeline(pipeline);
      spec.stages[0]!.options.identity = identity;
      assertThrows(() => createPipelineFromSpec(spec), /mars terrain spec/);
    }
    const inconsistent = describePipeline(pipeline);
    inconsistent.stages[0]!.options.seed = 6;
    assertThrows(() => createPipelineFromSpec(inconsistent), /disagree/);
    const missingSiteRadius = describePipeline(pipeline);
    const identity = JSON.parse(String(missingSiteRadius.stages[0]!.options.identity));
    delete identity.site.radiusM;
    missingSiteRadius.stages[0]!.options.identity = JSON.stringify(identity);
    assertThrows(() => createPipelineFromSpec(missingSiteRadius), /missing or invalid/);
  });
});

group("Mars terrain - renderer integration", () => {
  test("falls back to the live cached-erosion stage exactly once when a worker cannot reconstruct it", async () => {
    const faces = fakeFields(4, false);
    for (const face of faces) face.erosionDelta.fill(7);
    const fields = new MarsGlobalFieldSet(faces);
    const options = { site: { latDeg: 0, lonDeg: 0 }, detail: false, curvatureCompensation: false };
    const pipeline = createMarsPipeline({ ...options, globalFields: fields });
    const stage = pipeline.stages[0] as MarsTerrainStage;
    const process = spyOn(stage, "process");
    const pool = await createWorkerThreadPool({ installEngineHandlers: false });
    const scheduler = new TaskScheduler({ workerCount: 1, createWorker: (i) => pool.createWorker(i) });
    const scene = new Scene({ name: "mars-cache-fallback" });
    const terrain = new TerrainWorld({
      pipeline, seed: stage.seed, chunkSize: 128, chunkResolution: 9,
      visibleChunks: 1, generationsPerFrame: 1, horizonSkirt: false,
    });
    scene.add(terrain);
    const camera = scene.createEntity("camera");
    camera.add(new Transform());
    camera.add(new Camera());
    const context: SystemContext = {
      ...createMockContext(scene.world),
      services: { get: <T>(key: string) => key === "tasks" ? scheduler as T : undefined, engineConfig: {} },
    };
    try {
      terrain.update(context, 1 / 60);
      assertNotCalled(process);
      await scheduler.drain();
      terrain.update(context, 1 / 60);
      assert.equal(scheduler.stats.inlineFallbacks, 1);
      assertCallCount(process, 1);
      const tile = [...terrain.chunks.values()][0]!.tile!;
      assert.ok(tile);
      const analytic = createWorldCell(tile.cx, tile.cz, tile.size, tile.resolution, stage.seed);
      createMarsPipeline(options).execute(analytic);
      for (let i = 0; i < analytic.heights.length; i++) {
        assertCloseTo(tile.cell.heights[i]! - analytic.heights[i]!, 7, 4);
      }
      // No field buffer was transferred away or replaced with an analytic-only fallback.
      for (const face of faces) assert.equal(face.erosionDelta.byteLength, 4 * 4 * 4);
    } finally {
      scene.dispose();
      scheduler.dispose();
      await pool.dispose();
    }
  });

  test("streams a Mars patch through TerrainWorld with deep skirts", () => {
    const world = new EntityWorld();
    const terrain = new TerrainWorld({
      seed: MARS_GEN_PARAMS.seed,
      chunkSize: 256,
      chunkResolution: 33,
      viewDistance: 512,
      maxLOD: 4,
      visibleChunks: 24,
      generationsPerFrame: 8,
      warmUpChunks: 9,
      horizonSkirt: false,
      skirtDepth: 64,
      syncGeneration: true,
      pipeline: createMarsPipeline({ site: { latDeg: 0, lonDeg: 0 } }),
    });
    const scene = new Scene({ name: "mars-stream-test" });
    scene.add(terrain);
    // A camera entity both registers the component stores the focus query needs and pins the focus.
    const cameraEntity = world.createEntity("camera");
    cameraEntity.add(new Camera());
    cameraEntity.add(new Transform());
    const ctx = createMockContext(world);

    assert.equal(terrain.skirtDepth, 64);
    terrain.update(ctx, 0.016);
    terrain.update(ctx, 0.016);

    const ready = [...terrain.chunks.values()].filter((c) => c.state === "ready");
    assert.ok(ready.length > 0);
    const ladder = new Set([33, 17, 9, 5, 3]);
    let sawLod0 = false;
    for (const chunk of ready) {
      assert.equal(chunk.tile?.skirtDepth, 64);
      assert.equal(chunk.tile?.size, 256);
      // LOD bands start at 1.5x chunkSize, so distant chunks remesh onto the geomorph ladder.
      assert.equal(ladder.has(chunk.tile!.resolution), true);
      if (chunk.tile!.resolution === 33) sawLod0 = true;
      // Skirts hang below the surface; the AABB must include them for culling to be correct.
      assert.ok(chunk.tile!.bounds.min.y < chunk.tile!.heightmap.minHeight);
    }
    assert.equal(sawLod0, true);

    scene.dispose();
    world.dispose();
  });

  test("advises the chunk sizes the detail band can survive", () => {
    const good = adviseMarsTile(128, 33);
    assert.equal(good.ok, true);
    assert.equal(good.detailLevel, "micro");
    assertCloseTo(good.vertexSpacing, 4, 6);
    assert.equal(good.lodLadderCompatible, true);

    // 256 m / 65 is 4 m spacing (micro); 2 m spacing (full) needs 128 m / 129 or 256 m / 129.
    assert.equal(adviseMarsTile(256, 65).detailLevel, "micro");
    assert.equal(adviseMarsTile(256, 129).detailLevel, "full");
    assert.equal(adviseMarsTile(256, 33).detailLevel, "meso");

    // The generator's own default output is unusable as a Forge tile, and must say so.
    const generatorSized = adviseMarsTile(299_984, 65);
    assert.equal(generatorSized.ok, false);
    assert.equal(generatorSized.detailLevel, "silhouette");
    assert.equal(generatorSized.nearestGeneratorDepth, 4);
    assert.match(generatorSized.notes.join(" "), /depth-4/);

    const offLadder = adviseMarsTile(128, 32);
    assert.equal(offLadder.lodLadderCompatible, false);
    assert.match(offLadder.notes.join(" "), /geomorph LOD ladder/);

    // Skirt advice scales with the chunk and is never below the engine default.
    assert.equal(adviseMarsTile(128, 33).recommendedSkirtDepth, 32);
    assert.equal(adviseMarsTile(2048, 33).recommendedSkirtDepth, 128);

    assertThrows(() => adviseMarsTile(0, 33), undefined);
    assertThrows(() => adviseMarsTile(128, 2), undefined);
  });

  test("offers Mars layers in the splat channel order the stage writes", () => {
    const layers = marsSurfaceLayers();
    assert.deepEqual(layers.map((l) => l.name), ["dust", "rock", "sand", "crust"]);
    assert.deepEqual(layers.map((l) => l.biomeChannel), [0, 1, 2, 3]);
    for (const layer of layers) {
      assert.ok(layer.roughness > 0.5);
      assert.equal(layer.color!.a, 1);
    }
  });

  test("records the generator's Stage A defaults alongside the ported world parameters", () => {
    assert.equal(MARS_RADIUS_M, 3_389_500);
    assert.equal(MARS_STAGE_A_DEFAULTS.res, 512);
    assert.equal(MARS_GEN_PARAMS.seed, 1337);
    assert.equal(MARS_GEN_PARAMS.dichotomy.amplitude, 4000);
    assertCloseTo(Math.hypot(MARS_GEN_PARAMS.dichotomy.axis.x, MARS_GEN_PARAMS.dichotomy.axis.y, MARS_GEN_PARAMS.dichotomy.axis.z), 1, 12);
    // A pipeline with a bare stage is still a valid generator pipeline.
    assert.equal(new GeneratorPipeline().addStage(new MarsTerrainStage()).stages.length, 1);
  });
});

await finish();
