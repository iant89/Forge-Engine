#!/usr/bin/env node
/**
 * Forge Engine Benchmark Runner.
 *
 * Runs the Phase 22 benchmark matrix, repeats it for same-host statistics, enforces every
 * workload's correctness/shape guard, and compares the result with the checked-in Phase 22.7
 * history when the host is comparable.
 *
 *   npm run bench
 *   npm run bench -- --samples 3 --json /tmp/forge-bench.json
 *   npm run bench -- --record benchmarks/history/benchmark-history.json
 */
import { cpus, totalmem } from "node:os";
import process from "node:process";
import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertCoreBenchmark, runCoreBenchmark } from "./src/core.bench.ts";
import { assertCullingBenchmark, runCullingBenchmark } from "./src/culling.bench.ts";
import { assertEcsBenchmark, runEcsBenchmark } from "./src/ecs.bench.ts";
import { assertLightBenchmark, runLightCullingBenchmark } from "./src/lights.bench.ts";
import { assertParticleBenchmark, runParticleBenchmark } from "./src/particles.bench.ts";
import { assertWorldBenchmark, runWorldBenchmark } from "./src/world.bench.ts";
import { assertRenderingBenchmark, runRenderingBenchmark } from "./src/rendering.bench.ts";
import { assertPhysicsBenchmark, runPhysicsBenchmark } from "./src/physics.bench.ts";
import { assertTerrainBenchmark, runTerrainBenchmark } from "./src/terrain.bench.ts";
import { assertUIBenchmark, runUIBenchmark } from "./src/ui.bench.ts";
import {
  SNAPSHOT_SCHEMA_VERSION,
  METRIC_SCHEMA_VERSION,
  aggregateSamples,
  compareBenchmarkHistory,
  loadBenchmarkHistory,
  normalizeResults,
  writeBenchmarkHistory,
} from "./src/history.ts";

const benchmarkRoot = dirname(fileURLToPath(import.meta.url));
const defaultHistoryPath = resolve(benchmarkRoot, "history/benchmark-history.json");

function valueAfter(argv, name) {
  const equals = argv.find((arg) => arg.startsWith(`${name}=`));
  if (equals) return equals.slice(name.length + 1);
  const at = argv.indexOf(name);
  if (at < 0) return null;
  const value = argv[at + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

function parseOptions(argv) {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log([
      "Usage: npm run bench -- [options]",
      "",
      "  --samples N       independent full-matrix samples (default: 3, max: 9)",
      "  --json PATH       write the schema-versioned current snapshot",
      "  --history PATH    compare with a stored history file (default: benchmarks/history/benchmark-history.json)",
      "  --no-history      skip the stored-history comparison",
      "  --record PATH     append the passing current run to a stored history file",
    ].join("\n"));
    process.exit(0);
  }
  const samplesText = valueAfter(argv, "--samples");
  const samples = samplesText === null ? 3 : Number(samplesText);
  if (!Number.isInteger(samples) || samples < 1 || samples > 9) {
    throw new Error(`--samples must be an integer from 1 through 9 (received ${samplesText})`);
  }
  const json = valueAfter(argv, "--json");
  const historyText = valueAfter(argv, "--history");
  const recordText = valueAfter(argv, "--record");
  return {
    samples,
    jsonPath: json === null ? null : resolve(process.cwd(), json),
    historyPath: argv.includes("--no-history") ? null : resolve(process.cwd(), historyText ?? defaultHistoryPath),
    recordPath: recordText === null ? null : resolve(process.cwd(), recordText),
  };
}

function hostMetadata() {
  const cpu = cpus();
  return {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    cpu: cpu[0]?.model ?? "unknown",
    logicalCpus: cpu.length,
    totalMemoryBytes: totalmem(),
  };
}

function printResults(results) {
  console.log("\nBenchmark Results (median across samples):");
  console.log("--------------------------------------------------------------------------------");
  console.log(
    `| ${"Benchmark Name".padEnd(46)} | ${"Count".padStart(8)} | ${"Time (ms)".padStart(10)} | ${"Ops / sec".padStart(12)} |`,
  );
  console.log("--------------------------------------------------------------------------------");
  for (const result of results) {
    console.log(
      `| ${result.name.padEnd(46)} | ${result.count.toString().padStart(8)} | ${result.durationMs.toFixed(2).padStart(10)} | ${result.opsPerSec.toLocaleString().padStart(12)} |`,
    );
  }
  console.log("--------------------------------------------------------------------------------");
}

function printComparison(comparison) {
  const label = comparison.status.toUpperCase();
  console.log(`Regression comparison: ${label} — ${comparison.reason}`);
  if (comparison.baselineStartedAt) {
    console.log(
      `  baseline: ${comparison.baselineStartedAt}, ${comparison.baselineSampleCount} samples; current: ${comparison.currentSampleCount} samples; ${comparison.metricCount} metrics`,
    );
  }
  for (const regression of comparison.regressions) {
    console.error(
      `  REGRESSION ${regression.metricId}: ${regression.baselineMedianMs.toFixed(3)} ms → ${regression.currentMedianMs.toFixed(3)} ms ` +
        `(${(regression.relativeRegression * 100).toFixed(1)}%, z=${regression.zScore.toFixed(2)})`,
    );
  }
}

async function runBenchmarkSample(sampleIndex, sampleCount) {
  const startedAt = new Date().toISOString();
  const startedNs = process.hrtime.bigint();
  const checks = {};
  const results = [];
  console.log(`\n=== Forge Engine Benchmark Sample ${sampleIndex + 1}/${sampleCount} ===`);

  console.log("Running Phase 22.1 core math/scheduler/resource benchmarks...");
  const core = await runCoreBenchmark();
  checks.core = assertCoreBenchmark(core);

  console.log("Running ECS 100k-entity benchmark...");
  const ecs = runEcsBenchmark(100_000);
  checks.ecs = assertEcsBenchmark(ecs);
  results.push(...ecs, ...core.results);

  console.log("Running Phase 22.5 particle benchmark matrix (CPU and mock GPU)...");
  const particles = await runParticleBenchmark();
  results.push(...particles.results);

  console.log("Running Phase 22.6 world-scale object benchmark matrix...");
  const world = runWorldBenchmark();
  results.push(...world.results);

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

  checks.particles = assertParticleBenchmark(particles);
  checks.world = assertWorldBenchmark(world);
  checks.lights = assertLightBenchmark(lights);
  checks.culling = assertCullingBenchmark(culling);
  checks.rendering = assertRenderingBenchmark(rendering);
  checks.terrain = assertTerrainBenchmark(terrain);
  checks.physics = assertPhysicsBenchmark(physics);
  const uiFails = assertUIBenchmark(uiBench);
  checks.ui = uiFails.length === 0 ? uiBench.notes : uiFails;
  for (const failure of uiFails) console.error(`UI benchmark: ${failure}`);

  return {
    sampleIndex,
    startedAt,
    elapsedMs: Number(process.hrtime.bigint() - startedNs) / 1e6,
    results: normalizeResults(results),
    checks,
    passed: uiFails.length === 0,
  };
}

const options = parseOptions(process.argv.slice(2));
const startedAt = new Date().toISOString();
const startedNs = process.hrtime.bigint();
const samples = [];
for (let sampleIndex = 0; sampleIndex < options.samples; sampleIndex++) {
  samples.push(await runBenchmarkSample(sampleIndex, options.samples));
}

const aggregateResults = aggregateSamples(samples);
const lastSample = samples.at(-1);
if (!lastSample) throw new Error("benchmark runner produced no samples");
const samplePass = samples.every((sample) => sample.passed);
const snapshotBase = {
  schemaVersion: SNAPSHOT_SCHEMA_VERSION,
  metricSchemaVersion: METRIC_SCHEMA_VERSION,
  startedAt,
  elapsedMs: Number(process.hrtime.bigint() - startedNs) / 1e6,
  sampleCount: samples.length,
  host: hostMetadata(),
  results: aggregateResults,
  checks: lastSample.checks,
  samples,
  passed: samplePass,
  comparison: {
    status: "skipped",
    reason: "comparison not evaluated",
    hostKey: "",
    baselineSampleCount: 0,
    currentSampleCount: samples.length,
    metricCount: aggregateResults.length,
    regressions: [],
  },
};
const history = options.historyPath === null
  ? { historySchemaVersion: 1, entries: [] }
  : loadBenchmarkHistory(options.historyPath);
const comparison = compareBenchmarkHistory(snapshotBase, history);
const passed = samplePass && comparison.status !== "failed" && comparison.status !== "incompatible";
const snapshot = { ...snapshotBase, passed, comparison };

printResults(aggregateResults);
console.log("Phase 22.1/22.5/22.6 and legacy matrix checks:");
for (const [name, notes] of Object.entries(lastSample.checks)) {
  console.log(`  ${name}:`);
  for (const note of notes) console.log(`    ${note}`);
}
printComparison(comparison);

if (options.recordPath !== null) {
  if (!samplePass) throw new Error("refusing to record a benchmark run whose correctness guards failed");
  writeBenchmarkHistory(options.recordPath, snapshot);
  console.log(`Benchmark history recorded: ${options.recordPath}`);
}
if (options.jsonPath !== null) {
  writeFileSync(options.jsonPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  console.log(`Machine-readable snapshot: ${options.jsonPath}`);
}

if (!passed) {
  process.exitCode = 1;
} else {
  console.log("Benchmark guards and comparable-history policy passed successfully.\n");
}
