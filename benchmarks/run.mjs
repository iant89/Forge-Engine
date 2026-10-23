#!/usr/bin/env node
/**
 * Forge Engine Benchmark Runner.
 *
 * Runs the Phase 22 benchmark matrix that exists today, enforces each workload's correctness/shape
 * guards, and can write a machine-readable snapshot for the Phase 22.7 history pipeline:
 *
 *   npm run bench -- --json /tmp/forge-bench.json
 */
import { writeFileSync } from "node:fs";
import { cpus, totalmem } from "node:os";
import process from "node:process";
import { assertCoreBenchmark, runCoreBenchmark } from "./src/core.bench.ts";
import { assertCullingBenchmark, runCullingBenchmark } from "./src/culling.bench.ts";
import { assertEcsBenchmark, runEcsBenchmark } from "./src/ecs.bench.ts";
import { assertLightBenchmark, runLightCullingBenchmark } from "./src/lights.bench.ts";
import { runParticleBenchmark } from "./src/particles.bench.ts";
import { assertRenderingBenchmark, runRenderingBenchmark } from "./src/rendering.bench.ts";
import { assertPhysicsBenchmark, runPhysicsBenchmark } from "./src/physics.bench.ts";
import { assertTerrainBenchmark, runTerrainBenchmark } from "./src/terrain.bench.ts";
import { assertUIBenchmark, runUIBenchmark } from "./src/ui.bench.ts";

function jsonOutputPath(argv) {
  const equals = argv.find((arg) => arg.startsWith("--json="));
  if (equals) return equals.slice("--json=".length);
  const at = argv.indexOf("--json");
  if (at < 0) return null;
  const value = argv[at + 1];
  if (!value || value.startsWith("--")) throw new Error("--json requires an output path");
  return value;
}

const jsonPath = jsonOutputPath(process.argv.slice(2));
const startedAt = new Date().toISOString();
const startedNs = process.hrtime.bigint();
const checks = {};

console.log("=== Forge Engine Benchmarks ===");
console.log("Running Phase 22.1 core math/scheduler/resource benchmarks...");
const core = await runCoreBenchmark();
checks.core = assertCoreBenchmark(core);

console.log("Running ECS 100k-entity benchmark...");
const results = runEcsBenchmark(100_000);
checks.ecs = assertEcsBenchmark(results);
results.push(...core.results);

console.log("Running 100k-particle integrator benchmark...");
const particles = runParticleBenchmark(100_000, 30);
results.push(...particles.results);
console.log("Running light-count stress benchmark (Phase 13.4)...");
const lights = runLightCullingBenchmark();
results.push(...lights.results);
console.log("Running object-culling benchmark (Phase 13.5)...");
const culling = runCullingBenchmark();
results.push(...culling.results);
console.log("Running Phase 22.2 rendering benchmark matrix...");
const rendering = await runRenderingBenchmark();
results.push(...rendering.results);
console.log("Running Phase 22.3 terrain benchmark matrix...");
const terrain = runTerrainBenchmark();
results.push(...terrain.results);
console.log("Running Phase 22.4 physics benchmark matrix...");
const physics = runPhysicsBenchmark();
results.push(...physics.results);
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
console.log("Phase 22.1 core:");
for (const note of checks.core) console.log(`  ${note}`);
console.log("ECS:");
for (const note of checks.ecs) console.log(`  ${note}`);
console.log(
  `particle analytic error ${particles.analyticError.toExponential(2)}  alive ${particles.alive}`,
);
checks.lights = assertLightBenchmark(lights);
console.log("Light culling (Phase 13.4):");
for (const note of checks.lights) console.log(`  ${note}`);
checks.culling = assertCullingBenchmark(culling);
console.log("Object culling (Phase 13.5):");
for (const note of checks.culling) console.log(`  ${note}`);
checks.rendering = assertRenderingBenchmark(rendering);
console.log("Rendering (Phase 22.2):");
for (const note of checks.rendering) console.log(`  ${note}`);
checks.terrain = assertTerrainBenchmark(terrain);
console.log("Terrain (Phase 22.3):");
for (const note of checks.terrain) console.log(`  ${note}`);
checks.physics = assertPhysicsBenchmark(physics);
console.log("Physics (Phase 22.4):");
for (const note of checks.physics) console.log(`  ${note}`);
console.log("UI framework:");
for (const note of uiBench.notes) console.log(`  ${note}`);
const uiFails = assertUIBenchmark(uiBench);
checks.ui = uiFails.length === 0 ? uiBench.notes : uiFails;
if (uiFails.length > 0) {
  for (const failure of uiFails) console.error(`UI benchmark: ${failure}`);
  process.exitCode = 1;
}
const integrate = particles.results[1];
if (!integrate || integrate.durationMs >= 1000) {
  console.error(`100k particle integrate exceeded 1s (${integrate?.durationMs.toFixed(1) ?? "missing"} ms)`);
  process.exitCode = 1;
}
if (!(particles.analyticError < 1e-3) || particles.alive !== 100_000) {
  console.error("100k particle benchmark diverged from the analytic gravity curve");
  process.exitCode = 1;
}
checks.particles = [
  `analytic error ${particles.analyticError.toExponential(2)}`,
  `${particles.alive.toLocaleString()} alive`,
  `integrate ${integrate?.durationMs.toFixed(2) ?? "missing"} ms`,
];

const elapsedMs = Number(process.hrtime.bigint() - startedNs) / 1e6;
if (jsonPath) {
  const cpu = cpus();
  const snapshot = {
    schemaVersion: 1,
    startedAt,
    elapsedMs,
    passed: process.exitCode !== 1,
    host: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      cpu: cpu[0]?.model ?? "unknown",
      logicalCpus: cpu.length,
      totalMemoryBytes: totalmem(),
    },
    results,
    checks,
  };
  const json = `${JSON.stringify(snapshot, null, 2)}\n`;
  writeFileSync(jsonPath, json, "utf8");
  console.log(`Machine-readable snapshot: ${jsonPath}`);
}

if (process.exitCode !== 1) console.log("Benchmark guards passed successfully.\n");
