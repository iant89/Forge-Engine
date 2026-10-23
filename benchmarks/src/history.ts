import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { BenchmarkResult } from "./ecs.bench.ts";

/** Version of the current benchmark snapshot shape. */
export const SNAPSHOT_SCHEMA_VERSION = 2;
/** Version of the stable metric-id and comparison rules. */
export const METRIC_SCHEMA_VERSION = 1;
/** Version of the file that contains one or more stored benchmark runs. */
export const HISTORY_SCHEMA_VERSION = 1;
/** Keep a bounded local history so an explicit --record cannot grow the repository forever. */
export const MAX_HISTORY_ENTRIES = 12;
/** A smaller change is treated as stopwatch noise even when the samples are very steady. */
export const MIN_SIGNIFICANT_REGRESSION = 0.15;
/** Welch-style z-score required in addition to the minimum relative change. */
export const MIN_REGRESSION_Z_SCORE = 3;
const RELATIVE_NOISE_FLOOR = 0.01;
const ABSOLUTE_NOISE_FLOOR_MS = 0.001;

export interface HostMetadata {
  node: string;
  platform: string;
  arch: string;
  cpu: string;
  logicalCpus: number;
  totalMemoryBytes: number;
}

export interface SnapshotMetric extends BenchmarkResult {
  metricId: string;
}

export interface BenchmarkSample {
  sampleIndex: number;
  startedAt: string;
  elapsedMs: number;
  results: SnapshotMetric[];
  checks: Record<string, string[]>;
  passed: boolean;
}

export interface StoredBenchmarkRun {
  schemaVersion: number;
  metricSchemaVersion: number;
  startedAt: string;
  elapsedMs: number;
  sampleCount: number;
  host: HostMetadata;
  results: SnapshotMetric[];
  checks: Record<string, string[]>;
  samples: BenchmarkSample[];
  passed: boolean;
}

export interface RegressionFinding {
  metricId: string;
  name: string;
  count: number;
  baselineMedianMs: number;
  currentMedianMs: number;
  baselineStdDevMs: number;
  currentStdDevMs: number;
  relativeRegression: number;
  zScore: number;
}

export type ComparisonStatus = "passed" | "failed" | "skipped" | "incompatible" | "insufficient-history";

export interface BenchmarkComparison {
  status: ComparisonStatus;
  reason: string;
  hostKey: string;
  baselineStartedAt?: string;
  baselineSampleCount: number;
  currentSampleCount: number;
  metricCount: number;
  regressions: RegressionFinding[];
}

export interface BenchmarkSnapshot extends StoredBenchmarkRun {
  comparison: BenchmarkComparison;
}

export interface BenchmarkHistoryFile {
  historySchemaVersion: number;
  entries: StoredBenchmarkRun[];
}

export function stableMetricId(name: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/×/g, "-x-")
    .replace(/&/g, "-and-")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
  if (!slug) throw new Error(`benchmark metric name ${JSON.stringify(name)} cannot produce a stable id`);
  return `forge.benchmark.${slug}`;
}

export function normalizeResults(results: readonly BenchmarkResult[]): SnapshotMetric[] {
  const seen = new Set<string>();
  return results.map((result) => {
    const metricId = stableMetricId(result.name);
    if (seen.has(metricId)) throw new Error(`duplicate benchmark metric id ${metricId} (${result.name})`);
    seen.add(metricId);
    if (!Number.isFinite(result.count) || result.count < 0) {
      throw new Error(`benchmark metric ${metricId} has an invalid operation count`);
    }
    if (!Number.isFinite(result.durationMs) || result.durationMs < 0) {
      throw new Error(`benchmark metric ${metricId} has an invalid duration`);
    }
    if (!Number.isFinite(result.opsPerSec) || result.opsPerSec < 0) {
      throw new Error(`benchmark metric ${metricId} has an invalid throughput`);
    }
    return { ...result, metricId };
  });
}

function median(values: readonly number[]): number {
  const ordered = [...values].sort((a, b) => a - b);
  if (ordered.length === 0) return 0;
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 1 ? ordered[middle]! : (ordered[middle - 1]! + ordered[middle]!) / 2;
}

function mean(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function standardDeviation(values: readonly number[]): number {
  if (values.length < 2) return 0;
  const average = mean(values);
  const variance = values.reduce((sum, value) => sum + (value - average) ** 2, 0) / (values.length - 1);
  return Math.sqrt(Math.max(0, variance));
}

function copyMetric(result: SnapshotMetric): SnapshotMetric {
  return { ...result };
}

function metricIds(results: readonly SnapshotMetric[]): string[] {
  return results.map((result) => result.metricId);
}

function sameMetricManifest(left: readonly SnapshotMetric[], right: readonly SnapshotMetric[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((result, index) => result.metricId === right[index]?.metricId);
}

export function aggregateSamples(samples: readonly BenchmarkSample[]): SnapshotMetric[] {
  if (samples.length === 0) throw new Error("cannot aggregate an empty benchmark sample set");
  const first = samples[0]!.results;
  for (const sample of samples) {
    if (!sameMetricManifest(first, sample.results)) {
      throw new Error("benchmark samples do not share one stable metric manifest");
    }
  }
  return first.map((metric, index) => {
    const sampleMetrics = samples.map((sample) => sample.results[index]!);
    const counts = new Set(sampleMetrics.map((sampleMetric) => sampleMetric.count));
    if (counts.size !== 1) throw new Error(`benchmark metric ${metric.metricId} changed operation count between samples`);
    return {
      ...copyMetric(metric),
      durationMs: median(sampleMetrics.map((sampleMetric) => sampleMetric.durationMs)),
      opsPerSec: median(sampleMetrics.map((sampleMetric) => sampleMetric.opsPerSec)),
    };
  });
}

export function hostKey(host: HostMetadata): string {
  const nodeMajor = host.node.match(/^v(\d+)/)?.[1] ?? host.node;
  return [host.platform, host.arch, host.cpu, host.logicalCpus, host.totalMemoryBytes, `node${nodeMajor}`].join("|");
}

function storedRun(snapshot: BenchmarkSnapshot): StoredBenchmarkRun {
  return {
    schemaVersion: snapshot.schemaVersion,
    metricSchemaVersion: snapshot.metricSchemaVersion,
    startedAt: snapshot.startedAt,
    elapsedMs: snapshot.elapsedMs,
    sampleCount: snapshot.sampleCount,
    host: { ...snapshot.host },
    results: snapshot.results.map(copyMetric),
    checks: JSON.parse(JSON.stringify(snapshot.checks)) as Record<string, string[]>,
    samples: snapshot.samples.map((sample) => ({
      sampleIndex: sample.sampleIndex,
      startedAt: sample.startedAt,
      elapsedMs: sample.elapsedMs,
      results: sample.results.map(copyMetric),
      checks: JSON.parse(JSON.stringify(sample.checks)) as Record<string, string[]>,
      passed: sample.passed,
    })),
    passed: snapshot.passed,
  };
}

function recordFromUnknown(value: unknown): StoredBenchmarkRun {
  if (!value || typeof value !== "object") throw new Error("benchmark history entry must be an object");
  const raw = value as Record<string, unknown>;
  const rawResults = Array.isArray(raw.results) ? raw.results : [];
  const results = normalizeResults(
    rawResults.map((item) => {
      if (!item || typeof item !== "object") throw new Error("benchmark history contains an invalid metric");
      const metric = item as Partial<BenchmarkResult>;
      if (typeof metric.name !== "string" || typeof metric.count !== "number" || typeof metric.durationMs !== "number" || typeof metric.opsPerSec !== "number") {
        throw new Error("benchmark history metric is missing name, count, durationMs or opsPerSec");
      }
      return { name: metric.name, count: metric.count, durationMs: metric.durationMs, opsPerSec: metric.opsPerSec };
    }),
  );
  const rawSamples = Array.isArray(raw.samples) && raw.samples.length > 0 ? raw.samples : [{
    sampleIndex: 0,
    startedAt: typeof raw.startedAt === "string" ? raw.startedAt : "unknown",
    elapsedMs: typeof raw.elapsedMs === "number" ? raw.elapsedMs : 0,
    results,
    checks: raw.checks && typeof raw.checks === "object" ? raw.checks : {},
    passed: raw.passed !== false,
  }];
  const samples: BenchmarkSample[] = rawSamples.map((sample, sampleIndex) => {
    if (!sample || typeof sample !== "object") throw new Error("benchmark history contains an invalid sample");
    const sampleRecord = sample as Record<string, unknown>;
    const sampleResults = Array.isArray(sampleRecord.results) ? sampleRecord.results : rawResults;
    const normalized = normalizeResults(
      sampleResults.map((item) => {
        if (!item || typeof item !== "object") throw new Error("benchmark history contains an invalid sample metric");
        const metric = item as Partial<BenchmarkResult>;
        if (typeof metric.name !== "string" || typeof metric.count !== "number" || typeof metric.durationMs !== "number" || typeof metric.opsPerSec !== "number") {
          throw new Error("benchmark history sample metric is incomplete");
        }
        return { name: metric.name, count: metric.count, durationMs: metric.durationMs, opsPerSec: metric.opsPerSec };
      }),
    );
    return {
      sampleIndex: typeof sampleRecord.sampleIndex === "number" ? sampleRecord.sampleIndex : sampleIndex,
      startedAt: typeof sampleRecord.startedAt === "string" ? sampleRecord.startedAt : "unknown",
      elapsedMs: typeof sampleRecord.elapsedMs === "number" ? sampleRecord.elapsedMs : 0,
      results: normalized,
      checks: sampleRecord.checks && typeof sampleRecord.checks === "object" ? sampleRecord.checks as Record<string, string[]> : {},
      passed: sampleRecord.passed !== false,
    };
  });
  const aggregate = samples.length > 0 ? aggregateSamples(samples) : results;
  const host = raw.host && typeof raw.host === "object" ? raw.host as HostMetadata : {
    node: "unknown",
    platform: "unknown",
    arch: "unknown",
    cpu: "unknown",
    logicalCpus: 0,
    totalMemoryBytes: 0,
  };
  return {
    schemaVersion: typeof raw.schemaVersion === "number" ? raw.schemaVersion : 1,
    metricSchemaVersion: typeof raw.metricSchemaVersion === "number" ? raw.metricSchemaVersion : 1,
    startedAt: typeof raw.startedAt === "string" ? raw.startedAt : samples[0]?.startedAt ?? "unknown",
    elapsedMs: typeof raw.elapsedMs === "number" ? raw.elapsedMs : samples.reduce((sum, sample) => sum + sample.elapsedMs, 0),
    sampleCount: samples.length,
    host,
    results: aggregate,
    checks: raw.checks && typeof raw.checks === "object" ? raw.checks as Record<string, string[]> : {},
    samples,
    passed: raw.passed !== false && samples.every((sample) => sample.passed),
  };
}

export function loadBenchmarkHistory(filePath: string): BenchmarkHistoryFile {
  if (!existsSync(filePath)) return { historySchemaVersion: HISTORY_SCHEMA_VERSION, entries: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
  } catch (error) {
    throw new Error(`cannot parse benchmark history ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (parsed && typeof parsed === "object" && Array.isArray((parsed as Record<string, unknown>).entries)) {
    const raw = parsed as Record<string, unknown>;
    return {
      historySchemaVersion: typeof raw.historySchemaVersion === "number" ? raw.historySchemaVersion : HISTORY_SCHEMA_VERSION,
      entries: (raw.entries as unknown[]).map(recordFromUnknown),
    };
  }
  // A single snapshot is accepted as a convenient migration path from the schema-1 --json output.
  return { historySchemaVersion: HISTORY_SCHEMA_VERSION, entries: [recordFromUnknown(parsed)] };
}

export function writeBenchmarkHistory(filePath: string, snapshot: BenchmarkSnapshot): void {
  const existing = loadBenchmarkHistory(filePath);
  const entries = [...existing.entries, storedRun(snapshot)].slice(-MAX_HISTORY_ENTRIES);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify({ historySchemaVersion: HISTORY_SCHEMA_VERSION, entries }, null, 2)}\n`, "utf8");
}

function comparableEntry(current: BenchmarkSnapshot, history: BenchmarkHistoryFile): StoredBenchmarkRun | undefined {
  const currentHost = hostKey(current.host);
  const currentMetrics = current.results;
  return [...history.entries].reverse().find((entry) => (
    hostKey(entry.host) === currentHost &&
    entry.metricSchemaVersion === current.metricSchemaVersion &&
    sameMetricManifest(currentMetrics, entry.results)
  ));
}

function mismatchDescription(current: BenchmarkSnapshot, entry: StoredBenchmarkRun): string {
  const currentIds = new Set(metricIds(current.results));
  const previousIds = new Set(metricIds(entry.results));
  const missing = [...previousIds].filter((id) => !currentIds.has(id));
  const added = [...currentIds].filter((id) => !previousIds.has(id));
  if (missing.length || added.length) {
    return `metric manifest changed (${added.length} added, ${missing.length} removed); record a new baseline intentionally`;
  }
  return "metric order or operation shape changed; record a new baseline intentionally";
}

export function compareBenchmarkHistory(current: BenchmarkSnapshot, history: BenchmarkHistoryFile): BenchmarkComparison {
  const currentHost = hostKey(current.host);
  const sameHost = history.entries.filter((entry) => hostKey(entry.host) === currentHost);
  if (sameHost.length === 0) {
    return {
      status: history.entries.length === 0 ? "skipped" : "skipped",
      reason: history.entries.length === 0 ? "no stored benchmark history" : "no stored run from this comparable host",
      hostKey: currentHost,
      baselineSampleCount: 0,
      currentSampleCount: current.samples.length,
      metricCount: current.results.length,
      regressions: [],
    };
  }
  const baseline = comparableEntry(current, history);
  if (!baseline) {
    return {
      status: "incompatible",
      reason: mismatchDescription(current, sameHost.at(-1)!),
      hostKey: currentHost,
      baselineStartedAt: sameHost.at(-1)!.startedAt,
      baselineSampleCount: sameHost.at(-1)!.samples.length,
      currentSampleCount: current.samples.length,
      metricCount: current.results.length,
      regressions: [],
    };
  }
  if (baseline.samples.length < 2 || current.samples.length < 2) {
    return {
      status: "insufficient-history",
      reason: `comparison needs at least two samples on each side (baseline ${baseline.samples.length}, current ${current.samples.length})`,
      hostKey: currentHost,
      baselineStartedAt: baseline.startedAt,
      baselineSampleCount: baseline.samples.length,
      currentSampleCount: current.samples.length,
      metricCount: current.results.length,
      regressions: [],
    };
  }

  const regressions: RegressionFinding[] = [];
  for (const [index, currentMetric] of current.results.entries()) {
    const baselineMetric = baseline.results[index]!;
    if (baselineMetric.count !== currentMetric.count) {
      return {
        status: "incompatible",
        reason: `operation count changed for ${currentMetric.metricId}; record a new baseline intentionally`,
        hostKey: currentHost,
        baselineStartedAt: baseline.startedAt,
        baselineSampleCount: baseline.samples.length,
        currentSampleCount: current.samples.length,
        metricCount: current.results.length,
        regressions: [],
      };
    }
    const baselineSamples = baseline.samples.map((sample) => sample.results[index]!.durationMs);
    const currentSamples = current.samples.map((sample) => sample.results[index]!.durationMs);
    const baselineMedianMs = median(baselineSamples);
    const currentMedianMs = median(currentSamples);
    const baselineStdDevMs = standardDeviation(baselineSamples);
    const currentStdDevMs = standardDeviation(currentSamples);
    const relativeRegression = (currentMedianMs - baselineMedianMs) / Math.max(Math.abs(baselineMedianMs), ABSOLUTE_NOISE_FLOOR_MS);
    const standardError = Math.sqrt(
      (baselineStdDevMs ** 2) / baselineSamples.length +
      (currentStdDevMs ** 2) / currentSamples.length,
    );
    const noiseFloor = Math.max(
      Math.abs(baselineMedianMs) * RELATIVE_NOISE_FLOOR,
      Math.abs(currentMedianMs) * RELATIVE_NOISE_FLOOR,
      ABSOLUTE_NOISE_FLOOR_MS,
    );
    const zScore = (currentMedianMs - baselineMedianMs) / Math.max(standardError, noiseFloor);
    if (relativeRegression >= MIN_SIGNIFICANT_REGRESSION && zScore >= MIN_REGRESSION_Z_SCORE) {
      regressions.push({
        metricId: currentMetric.metricId,
        name: currentMetric.name,
        count: currentMetric.count,
        baselineMedianMs,
        currentMedianMs,
        baselineStdDevMs,
        currentStdDevMs,
        relativeRegression,
        zScore,
      });
    }
  }
  return {
    status: regressions.length > 0 ? "failed" : "passed",
    reason: regressions.length > 0 ? `${regressions.length} statistically significant timing regression(s)` : "all comparable timings remained within policy",
    hostKey: currentHost,
    baselineStartedAt: baseline.startedAt,
    baselineSampleCount: baseline.samples.length,
    currentSampleCount: current.samples.length,
    metricCount: current.results.length,
    regressions,
  };
}
