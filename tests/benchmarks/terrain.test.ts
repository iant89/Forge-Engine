/**
 * @suite benchmarks:terrain
 * @group unit
 * @covers benchmarks/src/terrain.bench.ts
 * @desc Phase 22.3 terrain benchmark matrix shape, determinism, budgets, and mesh accounting
 */

export const suite = {
  name: "benchmarks:terrain",
  group: "unit",
  covers: ["benchmarks/src/terrain.bench.ts"],
  desc: "Phase 22.3 terrain benchmark matrix shape, determinism, budgets, and mesh accounting",
};

import assert from "node:assert/strict";
import { assertTerrainBenchmark, runTerrainBenchmark } from "../../benchmarks/src/terrain.bench.js";
import { finish, test } from "selrun";

test("covers generation, erosion, LOD, streaming, and mesh generation", () => {
  const report = runTerrainBenchmark({
    generationResolutions: [9, 17],
    erosionResolution: 33,
    meshResolutions: [9, 17],
    runs: 1,
    streamingVisibleChunks: 6,
  });
  const notes = assertTerrainBenchmark(report);
  assert.ok(report.results.length >= 9);
  assert.equal(report.generation.timings.every((timing) => timing.deterministic), true);
  assert.ok(report.streaming.cacheHits > 0);
  assert.equal(report.mesh.timings.at(-1)?.vertices, 17 * 17 + 4 * 17);
  assert.ok(notes.some((note) => note.startsWith("LOD:")));
});

finish();
