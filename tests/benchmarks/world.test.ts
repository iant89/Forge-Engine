/**
 * @suite benchmarks:world
 * @group unit
 * @covers benchmarks/src/world.bench.ts
 * @desc Phase 22.6 world-scale object matrix shape, visibility, determinism, and teardown
 */

export const suite = {
  name: "benchmarks:world",
  group: "unit",
  covers: ["benchmarks/src/world.bench.ts"],
  desc: "Phase 22.6 world-scale object matrix shape, visibility, determinism, and teardown",
};

import assert from "node:assert/strict";
import { assertWorldBenchmark, DEFAULT_WORLD_CAPACITIES, runWorldBenchmark } from "../../benchmarks/src/world.bench.js";
import { finish, test } from "selrun";

test("covers 10K and 100K world objects with transform/cull work and clean teardown", () => {
  assert.deepEqual(DEFAULT_WORLD_CAPACITIES, [10_000, 100_000, 500_000, 1_000_000]);
  const report = runWorldBenchmark({ capacities: [10_000, 100_000], runs: 1 });
  const notes = assertWorldBenchmark(report, [10_000, 100_000]);
  assert.equal(report.timings.length, 2);
  assert.ok(report.timings.every((timing) => timing.visible > 0 && timing.culled > 0));
  assert.ok(report.timings.every((timing) => timing.deterministic && timing.disposed));
  assert.equal(report.timings.at(-1)?.disposedLiveEntities, 0);
  assert.equal(report.timings.at(-1)?.disposedComponents, 0);
  assert.equal(notes.length, 3);
});

finish();
