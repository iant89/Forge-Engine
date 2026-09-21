#!/usr/bin/env node
/**
 * Forge Engine Benchmark Runner.
 *
 * Runs the Phase 3 100k-entity benchmarks and prints throughput / timing stats.
 */
import { runEcsBenchmark } from "./src/ecs.bench.ts";

console.log("=== Forge Engine Benchmarks ===");
console.log("Running ECS 100k-entity benchmark...");

const results = runEcsBenchmark(100_000);

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
console.log("ECS benchmarks passed successfully.\n");
