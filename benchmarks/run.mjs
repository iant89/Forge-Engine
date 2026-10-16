#!/usr/bin/env node
/**
 * Forge Engine Benchmark Runner.
 *
 * Runs the Phase 3 100k-entity benchmarks and prints throughput / timing stats.
 */
import { assertCullingBenchmark, runCullingBenchmark } from "./src/culling.bench.ts";
import { runEcsBenchmark } from "./src/ecs.bench.ts";
import { assertLightBenchmark, runLightCullingBenchmark } from "./src/lights.bench.ts";
import { runParticleBenchmark } from "./src/particles.bench.ts";
import { assertUIBenchmark, runUIBenchmark } from "./src/ui.bench.ts";

console.log("=== Forge Engine Benchmarks ===");
console.log("Running ECS 100k-entity benchmark...");

const results = runEcsBenchmark(100_000);
console.log("Running 100k-particle integrator benchmark...");
const particles = runParticleBenchmark(100_000, 30);
results.push(...particles.results);
console.log("Running light-count stress benchmark (Phase 13.4)...");
const lights = runLightCullingBenchmark();
results.push(...lights.results);
console.log("Running object-culling benchmark (Phase 13.5)...");
const culling = runCullingBenchmark();
results.push(...culling.results);
console.log("Running UI framework benchmark...");
const uiBench = runUIBenchmark(1000);
results.push(...uiBench.results);

console.log("\nBenchmark Results:");
console.log("--------------------------------------------------------------------------------");
console.log(
  `| ${"Benchmark Name".padEnd(46)} | ${"Count".padStart(8)} | ${"Time (ms)".padStart(10)} | ${"Ops / sec".padStart(12)} |`,
);
console.log("--------------------------------------------------------------------------------");

for (const res of results) {
  console.log(
    `| ${res.name.padEnd(46)} | ${res.count.toString().padStart(8)} | ${res.durationMs.toFixed(2).padStart(10)} | ${res.opsPerSec.toLocaleString().padStart(12)} |`,
  );
}
console.log("--------------------------------------------------------------------------------");
console.log(
  `particle analytic error ${particles.analyticError.toExponential(2)}  alive ${particles.alive}`,
);
const lightNotes = assertLightBenchmark(lights);
console.log("Light culling (Phase 13.4):");
for (const note of lightNotes) console.log(`  ${note}`);
const cullNotes = assertCullingBenchmark(culling);
console.log("Object culling (Phase 13.5):");
for (const note of cullNotes) console.log(`  ${note}`);
console.log("UI framework:");
for (const note of uiBench.notes) console.log(`  ${note}`);
const uiFails = assertUIBenchmark(uiBench);
if (uiFails.length > 0) {
  for (const f of uiFails) console.error(`UI benchmark: ${f}`);
  process.exit(1);
}
const integrate = particles.results[1];
if (!integrate || integrate.durationMs >= 1000) {
  console.error(`100k particle integrate exceeded 1s (${integrate?.durationMs.toFixed(1) ?? "missing"} ms)`);
  process.exit(1);
}
if (!(particles.analyticError < 1e-3) || particles.alive !== 100_000) {
  console.error("100k particle benchmark diverged from the analytic gravity curve");
  process.exit(1);
}
console.log("ECS and particle benchmarks passed successfully.\n");
