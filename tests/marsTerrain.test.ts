import { describe, expect, it } from "vitest";
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
  TerrainTile,
  TerrainWorld,
  Transform,
  adviseMarsTile,
  createMarsGenParams,
  createMarsPipeline,
  createPipelineFromSpec,
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

describe("Mars terrain - cube sphere mapping", () => {
  it("maps the six faces onto unit directions and back again", () => {
    for (let face = 0; face < 6; face++) {
      for (const u of [-1, -0.4, 0, 0.4, 1]) {
        for (const v of [-1, -0.4, 0, 0.4, 1]) {
          const dir = marsFaceUVToDirection(face, u, v);
          expect(Math.hypot(dir.x, dir.y, dir.z)).toBeCloseTo(1, 12);
          // The inverse is documented as approximate: it is a nearest-face lookup for the Stage A
          // grid, and at a face's own edges the warp genuinely ties with the neighbouring face.
          const back = marsDirectionToFaceUV(dir);
          if (u === 0 && v === 0) {
            // The face centre inverts exactly (that is the case the Stage A lookup relies on).
            expect(back.face).toBe(face);
            expect(back.u).toBeCloseTo(0, 12);
            expect(back.v).toBeCloseTo(0, 12);
          } else if (Math.abs(u) < 0.3 && Math.abs(v) < 0.3) {
            expect(back.face).toBe(face);
            // Approximate by design (upstream uses the naive cube inverse, not the inverse of the
            // spherify warp): within a tenth of a face coordinate, i.e. a Stage A cell at res 512.
            expect(Math.abs(back.u - u)).toBeLessThan(0.12);
            expect(Math.abs(back.v - v)).toBeLessThan(0.12);
          }
        }
      }
    }
  });

  it("reports the generator's chunk sizes, matching the documented depth table", () => {
    // The table in docs/MARS-TERRAIN.md: face-centre chunk edge per quadtree depth.
    expect(marsFaceCentreChunkEdgeMeters(4, MARS_RADIUS_M) / 1000).toBeCloseTo(299.98, 1);
    expect(marsFaceCentreChunkEdgeMeters(8, MARS_RADIUS_M) / 1000).toBeCloseTo(18.72, 1);
    expect(marsFaceCentreChunkEdgeMeters(12, MARS_RADIUS_M) / 1000).toBeCloseTo(1.17, 1);
    expect(marsFaceCentreChunkEdgeMeters(15, MARS_RADIUS_M) / 1000).toBeCloseTo(0.146, 2);
    // ... and that a "Forge-sized" chunk is not one of them. `nearest` is the cheapest pick; the
    // `AtMost` rule is the conservative one used for the sizing table in the docs.
    expect(marsDepthForChunkEdge(299_984, MARS_RADIUS_M)).toBe(4);
    expect(marsDepthForChunkEdge(256, MARS_RADIUS_M)).toBe(14);
    expect(marsDepthForChunkEdgeAtMost(256, MARS_RADIUS_M)).toBe(15);
    expect(marsDepthForChunkEdgeAtMost(128, MARS_RADIUS_M)).toBe(16);
    expect(marsDepthForChunkEdgeAtMost(64, MARS_RADIUS_M)).toBe(17);
    expect(marsDepthForChunkEdgeAtMost(1024, MARS_RADIUS_M)).toBe(13);
    // The depth-0 "face-centre chunk" is the whole face, not a NaN from a coordinate outside [-1, 1].
    expect(marsFaceCentreChunkEdgeMeters(0, MARS_RADIUS_M) / 1e6).toBeCloseTo(5.32, 1);
  });

  it("round-trips lat/lon and measures great-circle distances", () => {
    const dir = marsFaceUVToDirection(4, 0.2, -0.3);
    const { latDeg, lonDeg } = marsLatLonOfDirection(dir);
    const back = new MarsSite({ latDeg, lonDeg }).up;
    expect(back.x).toBeCloseTo(dir.x, 6);
    expect(back.y).toBeCloseTo(dir.y, 6);
    expect(back.z).toBeCloseTo(dir.z, 6);
    // A quarter of the way round the planet is a quarter of the circumference.
    const equatorialA = marsFaceUVToDirection(4, 0, 0);
    const equatorialB = { x: equatorialA.x, y: equatorialA.y, z: equatorialA.z };
    const north = { x: 0, y: 1, z: 0 };
    expect(marsAngularDistanceMeters(equatorialB, north, MARS_RADIUS_M)).toBeCloseTo((Math.PI / 2) * MARS_RADIUS_M, 3);
  });
});

describe("Mars terrain - analytic geology", () => {
  it("is deterministic in the direction and seed", () => {
    const dir = marsFaceUVToDirection(2, 0.31, 0.11);
    const a = marsSampleAnalytic(dir.x, dir.y, dir.z, MARS_GEN_PARAMS);
    const b = marsSampleAnalytic(dir.x, dir.y, dir.z, MARS_GEN_PARAMS);
    expect(a).toEqual(b);
    // A different seed moves the terrain (craters, cones and the material patch all re-hash).
    const other = marsSampleAnalytic(dir.x, dir.y, dir.z, createMarsGenParams({ seed: 4242 }));
    expect(other.elevation).not.toBeCloseTo(a.elevation, 3);
  });

  it("puts the config's shield volcano where the config says, at the height it says", () => {
    const volcano = MARS_GEN_PARAMS.volcanoes[0]!;
    const unit = {
      x: volcano.center.x / MARS_RADIUS_M,
      y: volcano.center.y / MARS_RADIUS_M,
      z: volcano.center.z / MARS_RADIUS_M,
    };
    // The summit is `height - calderaDepth` plus a little flank noise: 21 km - 3 km = 18 km.
    const centre = { x: volcano.center.x, y: volcano.center.y, z: volcano.center.z };
    const summit = marsSampleVolcanoDelta(centre.x, centre.y, centre.z, MARS_GEN_PARAMS.volcanoes);
    expect(summit).toBeGreaterThan(17_500);
    expect(summit).toBeLessThan(18_500);
    // Far outside the influence radius (1.3x the base radius) the volcano contributes nothing.
    const far = { x: -centre.x, y: -centre.y, z: -centre.z };
    expect(marsSampleVolcanoDelta(far.x, far.y, far.z, MARS_GEN_PARAMS.volcanoes)).toBe(0);
    // And the assembled surface is kilometres above the reference sphere up there.
    expect(marsSampleAnalytic(unit.x, unit.y, unit.z, MARS_GEN_PARAMS).elevation).toBeGreaterThan(10_000);
    // The site preset follows the config (not a hard-coded latitude).
    const preset = MARS_SITE_PRESETS.olympusMons!;
    const presetUp = new MarsSite(preset).up;
    const delta = Math.hypot(presetUp.x - unit.x, presetUp.y - unit.y, presetUp.z - unit.z);
    expect(delta).toBeLessThan(1e-9);
  });

  it("carves craters deep enough to classify as crater floor", () => {
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
    expect(inside).toBeGreaterThan(0);
    expect(floorMaterial).toBeGreaterThan(0);
    expect(deepest).toBeLessThan(-100);
  });

  it("samples exactly the same crater set per chunk as the direct per-vertex loop", () => {
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
    expect(worst).toBeLessThan(1e-6);
    expect(inCraterMismatch).toBe(0);
  });
});

describe("Mars terrain - Stage A field cache", () => {
  it("decodes the generator's on-disk layout and bilinearly samples it", () => {
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
    expect(face.res).toBe(res);
    expect(face.erosionDelta.length).toBe(res * res);
    expect(face.material[7]).toBe(MarsMaterial.VolcanicFlank);

    const set = new MarsGlobalFieldSet([face]);
    expect(set.availableFaces).toEqual([4]);
    expect(set.missingFaces).toEqual([0, 1, 2, 3, 5]);
    expect(set.complete).toBe(false);

    // Face-centre (`u = v = 0` on PZ) is the middle of the grid: the exact centre of cell (2,2).
    const centre = set.sample(0, 0, 1);
    expect(centre.erosionDelta).toBe(2 * res + 2);
    expect(centre.hardness).toBeCloseTo(0.25, 6);
    expect(centre.material).toBe(MarsMaterial.VolcanicFlank);

    // Quarter of the way across samples the next columns bilinearly.
    const quarter = set.sample(0.5, 0, 1);
    expect(quarter.erosionDelta).toBeGreaterThan(centre.erosionDelta);

    // A face with no fields loaded is neutral, not an error.
    const missing = new MarsGlobalFieldSet([]);
    const neutral = missing.sample(0, 1, 0);
    expect(neutral.erosionDelta).toBe(0);
    expect(neutral.hardness).toBe(0.5);
    expect(missing.bytes).toBe(0);
  });

  it("loads a face over HTTP the way the docs' recipe does", async () => {
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
    expect(face.res).toBe(res);
    expect(face.face).toBe(2);
    expect(face.erosionDelta[0]).toBeCloseTo(1.5, 6);
    expect(requested).toContain("https://example.test/mars/face_2/meta.json");
    expect(requested).toContain("https://example.test/mars/face_2/erosionDelta.f32");

    const set = new MarsGlobalFieldSet([face]);
    expect(set.has(2)).toBe(true);
    expect(set.bytes).toBeGreaterThan(0);
    // (0, 1, 0) is on face PY, the one that was loaded.
    expect(set.sample(0, 1, 0).erosionDelta).toBeCloseTo(1.5, 6);

    // A missing file must name the URL rather than decoding garbage.
    const missing = (async () => ({ ok: false, status: 404 }) as unknown as Response) as unknown as typeof fetch;
    await expect(fetchMarsFaceFields("https://example.test/mars/face_2", 2, missing)).rejects.toThrow(/meta\.json/);
  });

  it("rejects buffers that cannot hold the grid the metadata claims", () => {
    expect(() =>
      marsFaceFieldsFromBuffers({
        face: 0,
        res: 8,
        erosionDelta: new Float32Array(4).buffer,
        hardness: new Float32Array(64).buffer,
        flowAccum: new Float32Array(64).buffer,
        material: new Uint8Array(64).buffer,
      }),
    ).toThrow(/erosionDelta/);
  });
});

describe("Mars terrain - MarsTerrainStage", () => {
  it("fills a WorldCell with heights, slopes and splat weights", () => {
    const pipeline = createMarsPipeline({ site: { latDeg: 0, lonDeg: 0 } });
    const tile = new TerrainTile({ cx: 4, cz: -3, size: 128, resolution: 33 }, pipeline, MARS_GEN_PARAMS.seed);

    expect(tile.cell.heights.length).toBe(33 * 33);
    expect(tile.cell.biomes.length).toBe(33 * 33 * 4);
    for (let i = 0; i < tile.cell.heights.length; i++) {
      expect(Number.isFinite(tile.cell.heights[i]!)).toBe(true);
      expect(tile.cell.slopes[i]!).toBeGreaterThanOrEqual(0);
      const b = i * 4;
      const sum =
        tile.cell.biomes[b]! + tile.cell.biomes[b + 1]! + tile.cell.biomes[b + 2]! + tile.cell.biomes[b + 3]!;
      expect(sum).toBeCloseTo(1, 6);
    }
    // Skirts/culling need real bounds, and a Mars patch has real relief.
    expect(tile.heightmap.maxHeight).toBeGreaterThan(tile.heightmap.minHeight);
    expect(tile.cell.scatters.length).toBe(0);
  });

  it("is identical for a given chunk, and seamless across a chunk edge", () => {
    const pipeline = createMarsPipeline({ site: { latDeg: 12, lonDeg: -40 } });
    const a1 = new TerrainTile({ cx: 2, cz: 2, size: 256, resolution: 33 }, pipeline, MARS_GEN_PARAMS.seed);
    const a2 = new TerrainTile({ cx: 2, cz: 2, size: 256, resolution: 33 }, pipeline, MARS_GEN_PARAMS.seed);
    expect(Array.from(a1.cell.heights)).toEqual(Array.from(a2.cell.heights));

    // The east column of chunk (2,2) and the west column of chunk (3,2) are the same world line.
    const east = new TerrainTile({ cx: 3, cz: 2, size: 256, resolution: 33 }, pipeline, MARS_GEN_PARAMS.seed);
    let worst = 0;
    for (let j = 0; j < 33; j++) {
      const rightEdge = a1.cell.heights[j * 33 + 32]!;
      const leftEdge = east.cell.heights[j * 33]!;
      worst = Math.max(worst, Math.abs(rightEdge - leftEdge));
    }
    // Every vertex is evaluated from its absolute direction, so shared vertices agree exactly.
    expect(worst).toBeLessThan(1e-9);
  });

  it("applies the Stage A erosion correction when fields are supplied", () => {
    const fields = new MarsGlobalFieldSet(fakeFields(64, true));
    const withFields = createMarsPipeline({ site: { latDeg: 0, lonDeg: 0 }, globalFields: fields });
    const without = createMarsPipeline({ site: { latDeg: 0, lonDeg: 0 } });
    const a = new TerrainTile({ cx: 0, cz: 0, size: 256, resolution: 17 }, withFields, MARS_GEN_PARAMS.seed);
    const b = new TerrainTile({ cx: 0, cz: 0, size: 256, resolution: 17 }, without, MARS_GEN_PARAMS.seed);
    let differs = 0;
    for (let i = 0; i < a.cell.heights.length; i++) {
      if (Math.abs(a.cell.heights[i]! - b.cell.heights[i]!) > 1e-6) differs++;
    }
    expect(differs).toBe(a.cell.heights.length);
    const stage = new MarsTerrainStage({ globalFields: fields });
    expect(stage.hasErosionCorrection).toBe(true);
    expect(new MarsTerrainStage({}).hasErosionCorrection).toBe(false);
  });

  it("subtracts the sphere's curvature so a tangent patch is a height field", () => {
    const site = new MarsSite({ latDeg: 0, lonDeg: 0 });
    const rising = 123.5;
    // 1 km out, the sphere has dropped 1 km^2 / (2R) = 0.1475 m below the tangent plane.
    const sag1km = site.planeHeight(0, 1000, 0, true) - 0;
    expect(sag1km).toBeCloseTo(-(1000 * 1000) / (2 * MARS_RADIUS_M), 4);
    expect(site.planeHeight(rising, 2000, -1000, false)).toBe(rising);
    const d = Math.hypot(2000, -1000);
    const expected = (MARS_RADIUS_M + rising) * Math.cos(d / MARS_RADIUS_M) - MARS_RADIUS_M;
    expect(site.planeHeight(rising, 2000, -1000, true)).toBeCloseTo(expected, 9);
  });

  it("keeps its distance and heading conventions", () => {
    const site = new MarsSite({ latDeg: 10, lonDeg: 20 });
    // Local +Z is north (towards the planet's pole) before any heading.
    const north = site.latLonFor(0, 1000);
    expect(north.latDeg).toBeGreaterThan(10);
    // Local +X is east, i.e. +90 degrees of longitude at this latitude.
    const east = site.latLonFor(1000, 0);
    expect(east.lonDeg).toBeGreaterThan(20);
    expect(east.latDeg).toBeCloseTo(10, 6);
    // 90 degrees of heading swaps the two.
    const turned = new MarsSite({ latDeg: 10, lonDeg: 20, headingDeg: 90 });
    const turnedEast = turned.latLonFor(1000, 0);
    expect(turnedEast.latDeg).toBeGreaterThan(10);
  });

  it("describes itself for the pipeline cache key but refuses to be rebuilt in a worker", () => {
    const pipeline = createMarsPipeline({ site: { latDeg: 1, lonDeg: 2 }, paramsOverrides: { seed: 5 } });
    const spec = describePipeline(pipeline);
    expect(spec.stages.length).toBe(1);
    expect(spec.stages[0]!.kind).toBe("mars");
    expect(spec.stages[0]!.options.seed).toBe(5);
    expect(typeof spec.stages[0]!.options.identity).toBe("string");
    expect(() => createPipelineFromSpec(spec)).toThrow(InlineOnlyError);

    const same = createMarsPipeline({ site: { latDeg: 1, lonDeg: 2 }, paramsOverrides: { seed: 5 } });
    expect(hashPipelineSpec(describePipeline(same))).toBe(hashPipelineSpec(spec));
    const moved = createMarsPipeline({ site: { latDeg: 1, lonDeg: 3 }, paramsOverrides: { seed: 5 } });
    expect(hashPipelineSpec(describePipeline(moved))).not.toBe(hashPipelineSpec(spec));
  });
});

describe("Mars terrain - renderer integration", () => {
  it("streams a Mars patch through TerrainWorld with deep skirts", () => {
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

    expect(terrain.skirtDepth).toBe(64);
    terrain.update(ctx, 0.016);
    terrain.update(ctx, 0.016);

    const ready = [...terrain.chunks.values()].filter((c) => c.state === "ready");
    expect(ready.length).toBeGreaterThan(0);
    const ladder = new Set([33, 17, 9, 5, 3]);
    let sawLod0 = false;
    for (const chunk of ready) {
      expect(chunk.tile?.skirtDepth).toBe(64);
      expect(chunk.tile?.size).toBe(256);
      // LOD bands start at 1.5x chunkSize, so distant chunks remesh onto the geomorph ladder.
      expect(ladder.has(chunk.tile!.resolution)).toBe(true);
      if (chunk.tile!.resolution === 33) sawLod0 = true;
      // Skirts hang below the surface; the AABB must include them for culling to be correct.
      expect(chunk.tile!.bounds.min.y).toBeLessThan(chunk.tile!.heightmap.minHeight);
    }
    expect(sawLod0).toBe(true);

    scene.dispose();
    world.dispose();
  });

  it("advises the chunk sizes the detail band can survive", () => {
    const good = adviseMarsTile(128, 33);
    expect(good.ok).toBe(true);
    expect(good.detailLevel).toBe("micro");
    expect(good.vertexSpacing).toBeCloseTo(4, 6);
    expect(good.lodLadderCompatible).toBe(true);

    // 256 m / 65 is 4 m spacing (micro); 2 m spacing (full) needs 128 m / 129 or 256 m / 129.
    expect(adviseMarsTile(256, 65).detailLevel).toBe("micro");
    expect(adviseMarsTile(256, 129).detailLevel).toBe("full");
    expect(adviseMarsTile(256, 33).detailLevel).toBe("meso");

    // The generator's own default output is unusable as a Forge tile, and must say so.
    const generatorSized = adviseMarsTile(299_984, 65);
    expect(generatorSized.ok).toBe(false);
    expect(generatorSized.detailLevel).toBe("silhouette");
    expect(generatorSized.nearestGeneratorDepth).toBe(4);
    expect(generatorSized.notes.join(" ")).toMatch(/depth-4/);

    const offLadder = adviseMarsTile(128, 32);
    expect(offLadder.lodLadderCompatible).toBe(false);
    expect(offLadder.notes.join(" ")).toMatch(/geomorph LOD ladder/);

    // Skirt advice scales with the chunk and is never below the engine default.
    expect(adviseMarsTile(128, 33).recommendedSkirtDepth).toBe(32);
    expect(adviseMarsTile(2048, 33).recommendedSkirtDepth).toBe(128);

    expect(() => adviseMarsTile(0, 33)).toThrow();
    expect(() => adviseMarsTile(128, 2)).toThrow();
  });

  it("offers Mars layers in the splat channel order the stage writes", () => {
    const layers = marsSurfaceLayers();
    expect(layers.map((l) => l.name)).toEqual(["dust", "rock", "sand", "crust"]);
    expect(layers.map((l) => l.biomeChannel)).toEqual([0, 1, 2, 3]);
    for (const layer of layers) {
      expect(layer.roughness).toBeGreaterThan(0.5);
      expect(layer.color!.a).toBe(1);
    }
  });

  it("records the generator's Stage A defaults alongside the ported world parameters", () => {
    expect(MARS_RADIUS_M).toBe(3_389_500);
    expect(MARS_STAGE_A_DEFAULTS.res).toBe(512);
    expect(MARS_GEN_PARAMS.seed).toBe(1337);
    expect(MARS_GEN_PARAMS.dichotomy.amplitude).toBe(4000);
    expect(Math.hypot(MARS_GEN_PARAMS.dichotomy.axis.x, MARS_GEN_PARAMS.dichotomy.axis.y, MARS_GEN_PARAMS.dichotomy.axis.z)).toBeCloseTo(1, 12);
    // A pipeline with a bare stage is still a valid generator pipeline.
    expect(new GeneratorPipeline().addStage(new MarsTerrainStage()).stages.length).toBe(1);
  });
});
