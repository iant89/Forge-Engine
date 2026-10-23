/**
 * @suite benchmarks:history
 * @group unit
 * @covers benchmarks/src/history.ts
 * @desc Phase 22.7 stable metric IDs, repeated-sample statistics, host matching, and stored history
 */

export const suite = {
  name: "benchmarks:history",
  group: "unit",
  covers: ["benchmarks/src/history.ts"],
  desc: "Phase 22.7 stable metric IDs, repeated-sample statistics, host matching, and stored history",
};

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  aggregateSamples,
  compareBenchmarkHistory,
  loadBenchmarkHistory,
  normalizeResults,
  writeBenchmarkHistory,
  type BenchmarkSample,
  type BenchmarkSnapshot,
  type HostMetadata,
} from "../../benchmarks/src/history.js";
import { finish, test } from "selrun";

const host: HostMetadata = {
  node: "v22.22.3",
  platform: "linux",
  arch: "x64",
  cpu: "Forge test CPU",
  logicalCpus: 2,
  totalMemoryBytes: 1024,
};

function sample(sampleIndex: number, durationMs: number, name = "world objects cull 1M"): BenchmarkSample {
  return {
    sampleIndex,
    startedAt: `2026-10-23T00:0${sampleIndex}:00.000Z`,
    elapsedMs: durationMs,
    results: normalizeResults([{ name, count: 1_000_000, durationMs, opsPerSec: 1_000_000_000 / durationMs }]),
    checks: { world: ["passed"] },
    passed: true,
  };
}

function snapshot(durations: readonly number[], name = "world objects cull 1M"): BenchmarkSnapshot {
  const samples = durations.map((durationMs, sampleIndex) => sample(sampleIndex, durationMs, name));
  return {
    schemaVersion: 2,
    metricSchemaVersion: 1,
    startedAt: samples[0]!.startedAt,
    elapsedMs: durations.reduce((sum, value) => sum + value, 0),
    sampleCount: samples.length,
    host,
    results: aggregateSamples(samples),
    checks: { world: ["passed"] },
    samples,
    passed: true,
    comparison: {
      status: "skipped",
      reason: "test fixture",
      hostKey: "",
      baselineSampleCount: 0,
      currentSampleCount: samples.length,
      metricCount: 1,
      regressions: [],
    },
  };
}

test("assigns stable IDs and aggregates repeated samples by median", () => {
  const samples = [sample(0, 100), sample(1, 104), sample(2, 101)];
  const aggregate = aggregateSamples(samples);
  assert.equal(aggregate[0]?.metricId, "forge.benchmark.world-objects-cull-1m");
  assert.equal(aggregate[0]?.durationMs, 101);
  assert.equal(aggregate[0]?.count, 1_000_000);
});

test("passes ordinary noise and rejects a statistically significant same-host slowdown", () => {
  const baseline = snapshot([100, 101, 99]);
  const history = { historySchemaVersion: 1, entries: [baseline] };
  const noise = compareBenchmarkHistory(snapshot([102, 100, 101]), history);
  assert.equal(noise.status, "passed");
  assert.equal(noise.regressions.length, 0);

  const slowdown = compareBenchmarkHistory(snapshot([130, 131, 129]), history);
  assert.equal(slowdown.status, "failed");
  assert.equal(slowdown.regressions.length, 1);
  assert.equal(slowdown.regressions[0]?.metricId, "forge.benchmark.world-objects-cull-1m");
  assert.ok((slowdown.regressions[0]?.zScore ?? 0) > 3);
});

test("skips unlike hosts, rejects metric-shape drift, and persists raw repeated history", () => {
  const current = snapshot([100, 101, 99]);
  const otherHost = { ...host, cpu: "Another CPU" };
  const unlike = compareBenchmarkHistory(current, { historySchemaVersion: 1, entries: [{ ...current, host: otherHost }] });
  assert.equal(unlike.status, "skipped");

  const drift = compareBenchmarkHistory(current, {
    historySchemaVersion: 1,
    entries: [snapshot([100, 101, 99], "renamed world objects cull 1M")],
  });
  assert.equal(drift.status, "incompatible");

  const root = mkdtempSync(join(tmpdir(), "forge-benchmark-history-"));
  try {
    const path = join(root, "history.json");
    writeBenchmarkHistory(path, current);
    const stored = loadBenchmarkHistory(path);
    assert.equal(stored.entries.length, 1);
    assert.equal(stored.entries[0]?.samples.length, 3);
    assert.equal(stored.entries[0]?.results[0]?.metricId, "forge.benchmark.world-objects-cull-1m");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

finish();
