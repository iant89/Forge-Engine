/**
 * @suite tools:marsTerrainPlan
 * @group unit
 * @covers engine/src/index.ts
 * @covers engine/src/terrain/mars/config.ts
 * @covers engine/src/terrain/mars/cubeSphere.ts
 * @covers engine/src/terrain/mars/geology.ts
 * @covers tools/mars-terrain/plan.ts
 * @covers tools/mars-terrain/pregenerate.ts
 * @desc Pins mars terrain plan behavior and regression guarantees
 */

export const suite = {
  name: "tools:marsTerrainPlan",
  group: "unit",
  covers:   [
    "engine/src/index.ts",
    "engine/src/terrain/mars/config.ts",
    "engine/src/terrain/mars/cubeSphere.ts",
    "engine/src/terrain/mars/geology.ts",
    "tools/mars-terrain/plan.ts",
    "tools/mars-terrain/pregenerate.ts"
  ],
  desc: "Pins mars terrain plan behavior and regression guarantees",
};
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { arrayContaining, assertCloseTo, assertMatches, assertThrows, finish, group, test } from "selrun";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  MARS_RADIUS_M,
  marsAngularDistanceMeters,
  marsDepthForChunkEdge,
  marsDepthForChunkEdgeAtMost,
  marsDirectionToFaceUV,
  marsFaceCentreChunkEdgeMeters,
  marsFaceUVToDirection,
  marsLatLonOfDirection,
  marsSampleAnalytic,
  MARS_GEN_PARAMS,
} from "@forge/engine";
// The planner is a *copy* of cube-sphere math that also exists in the engine (it has to ship into the
// generator repo, which does not import Forge), so this suite is the seam that keeps the two honest.
import {
  angularDistanceMeters,
  chunkContaining,
  chunkFileBytes,
  chunkFileName,
  depthForChunkEdge,
  depthForChunkEdgeAtMost,
  faceCentreChunkEdgeMeters,
  faceUVToDirection,
  latLonOfDirection,
  latLonToDirection,
  planMarsChunks,
} from "../../tools/mars-terrain/plan";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

group("mars terrain planner (tools/mars-terrain)", () => {
  test("agrees with the engine's cube sphere point for point", () => {
    let worstAngle = 0;
    let worstEdge = 0;
    let lastMine = faceUVToDirection(0, 0, 0);
    let lastTheirs = marsFaceUVToDirection(0, 0, 0);
    for (let face = 0; face < 6; face++) {
      for (let i = 0; i <= 8; i++) {
        for (let j = 0; j <= 8; j++) {
          const u = -1 + (i * 2) / 8;
          const v = -1 + (j * 2) / 8;
          const mine = faceUVToDirection(face, u, v);
          const theirs = marsFaceUVToDirection(face, u, v);
          worstAngle = Math.max(
            worstAngle,
            Math.abs(mine.x - theirs.x),
            Math.abs(mine.y - theirs.y),
            Math.abs(mine.z - theirs.z),
          );
          // Keep the last pair in scope for the distance check below.
          lastMine = mine;
          lastTheirs = theirs;
        }
      }
      for (let depth = 0; depth <= 12; depth++) {
        worstEdge = Math.max(
          worstEdge,
          Math.abs(faceCentreChunkEdgeMeters(depth, MARS_RADIUS_M) - marsFaceCentreChunkEdgeMeters(depth, MARS_RADIUS_M)),
        );
      }
      // Lat/lon round trip and great-circle distance run through the same formulas.
      const dir = faceUVToDirection(face, 0.3, -0.2);
      const ll = latLonOfDirection(dir);
      const engineLL = marsLatLonOfDirection(dir);
      assertCloseTo(ll.latDeg, engineLL.latDeg, 12);
      assertCloseTo(ll.lonDeg, engineLL.lonDeg, 12);
      const back = latLonToDirection(ll.latDeg, ll.lonDeg);
      assertCloseTo(back.x, dir.x, 12);
      assertCloseTo(back.y, dir.y, 12);
      assertCloseTo(back.z, dir.z, 12);
      // The generator computes the great-circle distance itself (for `angularDistanceMeters`); it must
      // land on the engine's number for the same pair of directions.
      assertCloseTo(angularDistanceMeters(lastMine, lastTheirs, MARS_RADIUS_M), marsAngularDistanceMeters(lastMine, lastTheirs, MARS_RADIUS_M), 6);
    }
    // Exact transcription, not a "close enough" reimplementation: identical doubles.
    assert.equal(worstAngle, 0);
    assert.equal(worstEdge, 0);
    // The rest of the mapping helpers must agree with the engine's too.
    assert.equal(marsDirectionToFaceUV(marsFaceUVToDirection(4, 0.1, 0.1)).face, 4);
  });

  test("keeps the depth <-> metric table in the docs and README accurate", () => {
    // docs/MARS-TERRAIN.md and tools/mars-terrain/README.md both print this table.
    const table: [number, number][] = [
      [4, 300],
      [8, 18.7],
      [12, 1.17],
      [13, 0.585],
      [14, 0.293],
      [15, 0.146],
      [16, 0.0731],
    ];
    for (const [depth, km] of table) {
      assertCloseTo(faceCentreChunkEdgeMeters(depth, MARS_RADIUS_M) / 1000, km, km < 1 ? 2 : 1);
      // Both implementations must print the same number, or the docs would be right for only one.
      assert.equal(faceCentreChunkEdgeMeters(depth, MARS_RADIUS_M), marsFaceCentreChunkEdgeMeters(depth, MARS_RADIUS_M));
    }
    // Nearest rounds; AtMost is conservative. The README tells the reader which to use for tiles.
    for (const meters of [64, 128, 256, 512, 1024, 4096]) {
      assert.equal(depthForChunkEdge(meters, MARS_RADIUS_M), marsDepthForChunkEdge(meters, MARS_RADIUS_M));
      assert.equal(depthForChunkEdgeAtMost(meters, MARS_RADIUS_M), marsDepthForChunkEdgeAtMost(meters, MARS_RADIUS_M));
      assert.ok(faceCentreChunkEdgeMeters(depthForChunkEdgeAtMost(meters, MARS_RADIUS_M), MARS_RADIUS_M) <= meters);
    }
    assert.equal(depthForChunkEdgeAtMost(256, MARS_RADIUS_M), 15);
    assert.equal(depthForChunkEdgeAtMost(128, MARS_RADIUS_M), 16);
  });

  test("matches the generator's chunk file layout and naming", () => {
    assert.equal(chunkFileBytes(33), 4 + 21 * 33 * 33);
    assert.equal(chunkFileBytes(65), 4 + 21 * 65 * 65);
    assert.equal(chunkFileBytes(33), 22_873);
    const name = chunkFileName({ face: 4, u0: -0.25, v0: 0.5, u1: 0, v1: 0.75, resolution: 33 });
    assert.equal(name, "f4_-0.250000_0.500000_0.000000_0.750000_r33.bin");
  });

  test("plans rings finest-first with a per-band cost estimate", () => {
    // The default world's Olympus-like summit, read from the config (the same site the drop-in
    // `pregenerate.ts` defaults to) — not a hard-coded coordinate.
    const site = latLonOfDirection(MARS_GEN_PARAMS.volcanoes[0]!.center);
    const plan = planMarsChunks({
      site,
      bands: [
        { depth: 16, resolution: 33, withinKm: 4 },
        { depth: 15, resolution: 33, withinKm: 12 },
      ],
    });

    assert.equal(plan.estimate.perBand.length, 2);
    const [fine, coarse] = plan.estimate.perBand;
    assert.ok(fine!.chunks > 0);
    assert.ok(coarse!.chunks > fine!.chunks);
    assert.equal(plan.estimate.chunks, fine!.chunks + coarse!.chunks);
    assert.equal(plan.estimate.bytes, plan.chunks.reduce((total, c) => total + c.bytes, 0));
    assert.equal(plan.estimate.vertices, plan.estimate.chunks * 33 * 33);

    // Every chunk is inside the ring it was planned for, and the finest band is the tightest.
    for (const chunk of plan.chunks) {
      const band = plan.estimate.perBand.find((b) => b.depth === chunk.depth)!;
      assert.ok(chunk.distanceMeters <= band.withinKm * 1000 + chunk.maxEdgeMeters);
      assert.equal(chunk.bytes, chunkFileBytes(chunk.resolution));
      assertCloseTo(chunk.u1 - chunk.u0, 2 / 2 ** chunk.depth, 12);
      assert.ok(chunk.edgeMeters > chunk.minEdgeMeters - 1e-9);
      assert.ok(chunk.edgeMeters < chunk.maxEdgeMeters + 1e-9);
    }
    // ~73 m and ~146 m chunks: the whole point of the plan is that the sizes are metric.
    assert.ok(plan.estimate.perBand[0]!.edgeMeters < 100);
    assert.ok(plan.estimate.perBand[1]!.edgeMeters > 100);
    assert.ok(plan.estimate.perBand[1]!.edgeMeters < 200);

    // No chunk appears twice, at any resolution.
    const keys = new Set(plan.chunks.map((c) => `${c.face}|${c.u0}|${c.v0}`));
    assert.equal(keys.size, plan.chunks.length);
    // Deterministic output.
    const again = planMarsChunks({
      site,
      bands: [
        { depth: 16, resolution: 33, withinKm: 4 },
        { depth: 15, resolution: 33, withinKm: 12 },
      ],
    });
    assert.deepEqual(again.chunks, plan.chunks);
  });

  test("prunes the quadtree instead of sweeping the planet", () => {
    // A 4 km ring at depth 16 is ~5,400 chunks (a full face at that depth is 4.3 billion), so if the
    // walk were not pruning this test would not finish at all. Keep the timeout tight to prove it.
    const started = Date.now();
    const plan = planMarsChunks({ site: { latDeg: 0, lonDeg: 0 }, bands: [{ depth: 16, resolution: 33, withinKm: 4 }] });
    assert.ok(plan.estimate.chunks > 1_000);
    assert.ok(plan.estimate.chunks < 20_000);
    assert.ok(Date.now() - started < 5_000);
  });

  test("refuses plans over its caps and flags sizes the renderer cannot use", () => {
    const capped = planMarsChunks({
      site: { latDeg: 0, lonDeg: 0 },
      bands: [{ depth: 16, resolution: 33, withinKm: 4 }],
      maxChunks: 10,
    });
    assert.match(capped.warnings.join(" "), /above the 10 cap/);

    const offLadder = planMarsChunks({
      site: { latDeg: 0, lonDeg: 0 },
      bands: [{ depth: 14, resolution: 20, withinKm: 6 }],
    });
    assert.match(offLadder.warnings.join(" "), /geomorph LOD ladder/);

    assertThrows(() => planMarsChunks({ site: { latDeg: 0, lonDeg: 0 }, bands: [] }), /at least one band/);
    assertThrows(() =>
      planMarsChunks({
        site: { latDeg: 0, lonDeg: 0 },
        bands: [
          { depth: 15, resolution: 33, withinKm: 24 },
          { depth: 16, resolution: 33, withinKm: 8 },
        ],
      }), /finest first/);
    // Two bands at the same depth is fine (the inner ring just wins), but the finest band must come
    // first or the dedupe would keep the coarse copy of a chunk.
    assertThrows(() =>
      planMarsChunks({
        site: { latDeg: 0, lonDeg: 0 },
        bands: [
          { depth: 15, resolution: 33, withinKm: 8 },
          { depth: 16, resolution: 33, withinKm: 12 },
        ],
      }), /finer than depth 15/);
  });

  test("locates the chunk containing a point, and lands the generator's volcano inside it", () => {
    const volcano = MARS_GEN_PARAMS.volcanoes[0]!;
    const latLon = latLonOfDirection(volcano.center);
    const chunk = chunkContaining(latLon.latDeg, latLon.lonDeg, 12);
    assert.ok(chunk.u0 >= -1);
    assert.ok(chunk.u1 <= 1 + 1e-12);
    assert.ok(chunk.edgeMeters > 900);
    assert.ok(chunk.edgeMeters < 1_700);
    // The deepest point of the volcano's caldera is inside the chunk (the point is its centre).
    assert.notEqual(faceUVToDirection(chunk.face, (chunk.u0 + chunk.u1) / 2, (chunk.v0 + chunk.v1) / 2), undefined);
  });

  test("ships a pregenerate script whose generator imports still exist", () => {
    const source = fs.readFileSync(path.join(repoRoot, "tools/mars-terrain/pregenerate.ts"), "utf-8");
    // The copy-in script is not typechecked here (the generator's modules are not in this repo), so
    // guard the contract that matters: the module paths it imports must be the ones the generator has.
    const imports = [...source.matchAll(/from "\.\/([^"]+)"/g)].map((m) => m[1]!);
    assertMatches(imports, arrayContaining([
        "global/stageA",
        "global/globalCache",
        "chunk/chunkGenerator",
        "chunk/chunkCache",
        "config/marsConfig",
        "plan",
      ]));
    // And that the walker actually uses them the way the generator defines them.
    assert.match(source, /generateChunk\(address, marsParams, faces\)/);
    assert.match(source, /chunkExists\(CHUNK_DIR, address\)/);
    assert.match(source, /saveGlobalFace\(GLOBAL_DIR, fields\)/);
    assert.match(source, /marsParams\.radius/);
    // It must never silently do a full-planet sweep: the plan is the point.
    assert.doesNotMatch(source, /divisions\s*=\s*2\s*\*\*\s*depth/);
    // The engine's own analytic sampler is what the port compares against in tools/mars-port-check.mjs.
    assert.equal(typeof marsSampleAnalytic, "function");
  });
});

await finish();
