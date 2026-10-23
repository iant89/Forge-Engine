/**
 * @suite benchmarks:physics
 * @group unit
 * @covers benchmarks/src/physics.bench.ts
 * @desc Phase 22.4 physics benchmark matrix shape, determinism, contact coverage, queries, and vehicles
 */

export const suite = {
  name: "benchmarks:physics",
  group: "unit",
  covers: ["benchmarks/src/physics.bench.ts"],
  desc: "Phase 22.4 physics benchmark matrix shape, determinism, contact coverage, queries, and vehicles",
};

import assert from "node:assert/strict";
import { assertPhysicsBenchmark, runPhysicsBenchmark } from "../../benchmarks/src/physics.bench.js";
import { finish, test } from "selrun";

test("covers broadphase, supported narrowphase pairs, solver, queries, and vehicle determinism", () => {
  const report = runPhysicsBenchmark({
    broadphaseCounts: [16, 64],
    narrowphasePairs: 32,
    solverBodies: 8,
    stabilityBodies: 8,
    stabilitySteps: 20,
    queryBodies: 16,
    queryRays: 32,
    heightfieldQueries: 64,
    vehicleCounts: [2, 4],
    vehicleSteps: 12,
    runs: 1,
  });
  const notes = assertPhysicsBenchmark(report);
  assert.equal(report.narrowphase.timings.length, 7);
  assert.ok(report.broadphase.timings.every((timing) => timing.overlapPairs > 0));
  assert.equal(report.queries.raycasts.hits, 32);
  assert.ok(report.queries.heightfield.maxHeight > report.queries.heightfield.minHeight);
  assert.ok(report.vehicles.timings.every((timing) => timing.deterministic));
  assert.ok(notes.some((note) => note.startsWith("solver:")));
  assert.ok(notes.some((note) => note.startsWith("vehicles:")));
});

finish();
