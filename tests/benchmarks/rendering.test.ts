/**
 * @suite benchmarks:rendering
 * @group unit
 * @covers benchmarks/src/rendering.bench.ts
 * @desc Phase 22.2 rendering benchmark matrix shape and resource guards
 */

export const suite = {
  name: "benchmarks:rendering",
  group: "unit",
  covers: ["benchmarks/src/rendering.bench.ts"],
  desc: "Phase 22.2 rendering benchmark matrix shape and resource guards",
};

import assert from "node:assert/strict";
import { assertRenderingBenchmark, runRenderingBenchmark } from "../../benchmarks/src/rendering.bench.js";
import { finish, test } from "selrun";

test("covers draw submission, graph aliasing, shadow fitting, and GPU memory accounting", async () => {
  const report = await runRenderingBenchmark({
    drawCounts: [4, 8],
    graphPasses: [3, 5],
    shadowIterations: 8,
    memoryIterations: 3,
    twinRuns: 2,
  });
  const notes = assertRenderingBenchmark(report);
  assert.ok(report.results.length >= 8);
  assert.ok(notes.some((note) => note.startsWith("draw submission:")));
  assert.equal(report.draw.timings.at(-1)?.drawCalls, 8);
  assert.equal(report.graph.timings.at(-1)?.culledPasses, 1);
  assert.equal(report.memory.remainingResources, 0);
});

finish();
