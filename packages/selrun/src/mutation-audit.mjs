import { spawn } from "node:child_process";
import * as ts from "typescript";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildProjectGraph, selectWithImpact } from "./selection.mjs";
import { validateCatalog } from "./catalog.mjs";

const EXCLUDED_DIRS = new Set([
  ".git", "node_modules", ".arena", ".cache", ".next", ".nuxt", ".output",
  ".parcel-cache", ".pytest_cache", ".ruff_cache", ".svelte-kit", ".turbo",
  ".venv", ".vite", "build", "coverage", "dist", "out", "target",
]);

/**
 * Apply a strict, literal replacement mutation to a workspace copy.
 * Every patch must match exactly once unless `count` is explicitly supplied.
 */
export function applyMutation(root, mutation) {
  const file = normalizeMutationPath(mutation.file);
  const workspace = path.resolve(root);
  if (!fs.existsSync(workspace) || fs.lstatSync(workspace).isSymbolicLink()) throw new Error("mutation workspace must be a real directory");
  const absolute = path.resolve(workspace, file);
  const relative = path.relative(workspace, absolute);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`mutation path escapes workspace: ${mutation.file}`);
  let cursor = workspace;
  for (const segment of relative.split(path.sep)) {
    cursor = path.join(cursor, segment);
    if (!fs.existsSync(cursor)) throw new Error(`mutation target does not exist: ${file}`);
    if (fs.lstatSync(cursor).isSymbolicLink()) throw new Error(`mutation target traverses a symlink: ${file}`);
  }
  if (!fs.statSync(absolute).isFile()) throw new Error(`mutation target is not a file: ${file}`);
  if (!Array.isArray(mutation.replace) || mutation.replace.length === 0) throw new Error(`mutation ${mutation.name ?? file} needs a non-empty replace array`);

  let source = fs.readFileSync(absolute, "utf8");
  for (const [index, patch] of mutation.replace.entries()) {
    if (typeof patch.search !== "string" || !patch.search || typeof patch.replacement !== "string") {
      throw new Error(`mutation ${mutation.name ?? file} patch ${index + 1} needs non-empty search and string replacement`);
    }
    if (patch.search === patch.replacement) throw new Error(`mutation ${mutation.name ?? file} patch ${index + 1} is a no-op`);
    const count = source.split(patch.search).length - 1;
    const expected = patch.count ?? 1;
    if (count !== expected) {
      throw new Error(`mutation ${mutation.name ?? file} patch ${index + 1} expected ${expected} match(es), found ${count}`);
    }
    source = source.split(patch.search).join(patch.replacement);
  }
  fs.writeFileSync(absolute, source, "utf8");
  return { file, patchCount: mutation.replace.length };
}

/** Compare real mutant failures with the unmutated baseline and predicted suite set. */
export function compareMutationResults(baselineFailures, mutantFailures, selectedSuites) {
  const baseline = baselineFailures instanceof Set ? baselineFailures : new Set(baselineFailures);
  const mutant = mutantFailures instanceof Set ? mutantFailures : new Set(mutantFailures);
  const selected = selectedSuites instanceof Set ? selectedSuites : new Set(selectedSuites);
  const newlyFailing = [...mutant].filter((file) => !baseline.has(file));
  const caught = newlyFailing.filter((file) => selected.has(file));
  const falseNegatives = newlyFailing.filter((file) => !selected.has(file));
  const falsePositives = [...selected].filter((file) => !mutant.has(file));
  return { newlyFailing, caught, falseNegatives, falsePositives, survived: newlyFailing.length === 0 };
}

/** Create an isolated source copy, excluding Git metadata and installed dependencies. */
export function copyWorkspace(sourceRoot, destinationRoot) {
  const source = path.resolve(sourceRoot);
  fs.cpSync(source, destinationRoot, {
    recursive: true,
    dereference: false,
    filter(sourcePath) {
      const relative = path.relative(source, sourcePath);
      if (!relative || relative === ".") return true;
      const segments = relative.split(path.sep);
      return !segments.some((segment) => EXCLUDED_DIRS.has(segment));
    },
  });

  const sourceNodeModules = path.join(source, "node_modules");
  if (!fs.existsSync(sourceNodeModules)) throw new Error("mutation audit requires installed node_modules");
  fs.symlinkSync(sourceNodeModules, path.join(destinationRoot, "node_modules"), process.platform === "win32" ? "junction" : "dir");
}

const OPERATOR_REPLACEMENTS = {
  "comparison-boundary": new Map([["<", "<="], ["<=", "<"], [">", ">="], [">=", ">"]]),
  "comparison-swap": new Map([["<", ">"], [">", "<"], ["<=", ">="], [">=", "<="], ["===", "!=="], ["!==", "==="], ["==", "!="], ["!=", "=="]]),
  boolean: new Map([["true", "false"], ["false", "true"], ["&&", "||"], ["||", "&&"]]),
  arithmetic: new Map([["+", "-"], ["-", "+"], ["*", "/"], ["/", "*"], ["%", "*"]]),
};

/** Expand operator declarations into one deterministic mutant per eligible token. */
export function generateMutationCases(root, definitions, options = {}) {
  const maxMutants = validatePositiveInteger(options.maxMutants ?? 20, "maxMutants", 1_000);
  const mutations = [];
  let generatedCount = 0;
  let truncatedCount = 0;

  for (const definition of definitions) {
    const hasLiteralPatches = Array.isArray(definition.replace) && definition.replace.length > 0;
    const operators = definition.operators ?? [];
    if (!Array.isArray(operators)) throw new Error(`mutation ${definition.name ?? definition.file} operators must be an array`);
    if (hasLiteralPatches && operators.length > 0) throw new Error(`mutation ${definition.name ?? definition.file} must use replace or operators, not both`);
    if (hasLiteralPatches) {
      mutations.push(definition);
      continue;
    }
    if (operators.length === 0) throw new Error(`mutation ${definition.name ?? definition.file} needs replace patches or operator names`);
    for (const operator of operators) {
      if (!Object.hasOwn(OPERATOR_REPLACEMENTS, operator)) {
        throw new Error(`unknown mutation operator "${operator}"; supported: ${Object.keys(OPERATOR_REPLACEMENTS).join(", ")}`);
      }
    }

    const file = normalizeMutationPath(definition.file);
    const startLine = definition.startLine;
    const endLine = definition.endLine;
    if (startLine !== undefined) validatePositiveInteger(startLine, "startLine", Number.MAX_SAFE_INTEGER);
    if (endLine !== undefined) validatePositiveInteger(endLine, "endLine", Number.MAX_SAFE_INTEGER);
    if (startLine !== undefined && endLine !== undefined && endLine < startLine) throw new Error(`mutation ${definition.name ?? file} has endLine before startLine`);
    const absolute = path.resolve(root, file);
    if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) throw new Error(`mutation target does not exist: ${file}`);
    const source = fs.readFileSync(absolute, "utf8");
    const languageVariant = /\.tsx$/i.test(file) ? ts.LanguageVariant.JSX : ts.LanguageVariant.Standard;
    const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, languageVariant, source);
    const lineStarts = [0];
    for (const match of source.matchAll(/\n/g)) lineStarts.push(match.index + 1);
    let definitionCandidates = 0;
    let token = scanner.scan();
    while (token !== ts.SyntaxKind.EndOfFileToken) {
      const start = scanner.getTokenPos();
      const end = scanner.getTextPos();
      const tokenText = source.slice(start, end);
      const line = lineNumberAt(lineStarts, start);
      if ((startLine !== undefined && line < startLine) || (endLine !== undefined && line > endLine)) {
        token = scanner.scan();
        continue;
      }
      const applicable = operators
        .map((operator) => ({ operator, replacement: OPERATOR_REPLACEMENTS[operator].get(tokenText) }))
        .filter((candidate) => candidate.replacement !== undefined);
      for (const { operator, replacement } of applicable) {
        definitionCandidates++;
        if (generatedCount >= maxMutants) {
          truncatedCount++;
          continue;
        }
        const mutatedSource = `${source.slice(0, start)}${replacement}${source.slice(end)}`;
        mutations.push({
          name: `${definition.name ?? file} · ${operator} ${tokenText}→${replacement} at line ${line}`,
          file,
          replace: [{ search: source, replacement: mutatedSource }],
          generated: true,
        });
        generatedCount++;
      }
      token = scanner.scan();
    }
    if (definitionCandidates === 0) throw new Error(`mutation ${definition.name ?? file} produced no candidates for operators: ${operators.join(", ")}`);
  }
  return { mutations, generatedCount, truncatedCount };
}

/** Execute jobs in input order with a bounded number of concurrent workers. */
export async function runBounded(items, concurrency, handler) {
  const limit = validatePositiveInteger(concurrency, "concurrency", 64);
  const results = new Array(items.length);
  let nextIndex = 0;
  async function worker() {
    while (true) {
      const index = nextIndex++;
      if (index >= items.length) return;
      results[index] = await handler(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

/** Run catalog suites with bounded parallelism and return ordered results. */
export async function runSuiteSet(root, suiteFiles, options = {}) {
  const timeoutMs = options.timeoutMs ?? 120_000;
  const concurrency = options.concurrency ?? 2;
  validatePositiveInteger(timeoutMs, "timeoutMs", 3_600_000);
  let completed = 0;
  return runBounded(suiteFiles, concurrency, async (file) => {
    const result = await runOneSuite(root, file, timeoutMs);
    completed++;
    options.onProgress?.({ phase: options.phase ?? "suite set", completed, total: suiteFiles.length, file, result });
    return result;
  });
}

function runOneSuite(root, file, timeoutMs) {
  return new Promise((resolve) => {
    const startedAt = performance.now();
    const absolute = path.resolve(root, file);
    let stdout = "";
    let stderr = "";
    let spawnError = null;
    let timedOut = false;
    const child = spawn(process.execPath, ["--import", "tsx", absolute], {
      cwd: root,
      env: { ...process.env, TSX_TSCONFIG_PATH: path.join(root, "tests/tsconfig.json") },
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    const retainTail = (current, chunk) => `${current}${chunk}`.slice(-12_000);
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout = retainTail(stdout, chunk); });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr = retainTail(stderr, chunk); });
    child.on("error", (error) => { spawnError = error; });
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (process.platform === "win32") child.kill("SIGKILL");
        else process.kill(-child.pid, "SIGKILL");
      } catch { child.kill("SIGKILL"); }
    }, timeoutMs);
    child.on("close", (status) => {
      clearTimeout(timer);
      const durationMs = performance.now() - startedAt;
      const passed = status === 0 && !spawnError && !timedOut;
      resolve({
        file,
        passed,
        durationMs,
        status,
        timedOut,
        error: spawnError?.message ?? (timedOut ? `exceeded ${timeoutMs} ms timeout` : null),
        output: passed ? "" : `${stdout}${stderr}`.slice(-12_000),
      });
    });
  });
}

/**
 * Run true mutation analysis in a disposable workspace.
 * The unmutated full suite establishes the baseline; each mutant is then run
 * against the full suite to discover which suites actually detect it. Selector
 * misses are those newly failing suites absent from its affected selection.
 */
export async function auditMutations(root, definitions, options = {}) {
  const startedAt = performance.now();
  if (!Array.isArray(definitions) || definitions.length === 0) throw new Error("mutation audit needs at least one mutation");
  const expansion = generateMutationCases(root, definitions, { maxMutants: options.maxMutants });
  const mutations = expansion.mutations;
  if (mutations.length === 0) throw new Error("mutation operators generated no mutants from the configured source files");
  const catalog = validateCatalog(root);
  if (catalog.errors.length) throw new Error(`cannot audit mutations with an invalid suite catalog: ${catalog.errors.slice(0, 5).join("; ")}`);

  const suites = catalog.suites.map((suite) => ({ ...suite, covers: suite.covers ?? [] }));
  const graph = buildProjectGraph(root);
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "selrun-mutation-audit-"));
  const baseRoot = path.join(tempRoot, "baseline");

  try {
    fs.mkdirSync(baseRoot, { recursive: true });
    copyWorkspace(root, baseRoot);
    const suiteFiles = catalog.linkedSuites;
    const baselineResults = await runSuiteSet(baseRoot, suiteFiles, { ...options, phase: "baseline" });
    assertNoInfrastructureErrors(baselineResults, "baseline");
    const baselineFailures = new Set(baselineResults.filter((result) => !result.passed).map((result) => result.file));
    const scenarios = [];

    for (const mutation of mutations) {
      const name = mutation.name ?? mutation.file;
      const changedFile = normalizeMutationPath(mutation.file);
      const workspaceRoot = path.join(tempRoot, `mutant-${scenarios.length + 1}`);
      fs.mkdirSync(workspaceRoot, { recursive: true });
      copyWorkspace(baseRoot, workspaceRoot);
      const applied = applyMutation(workspaceRoot, mutation);
      const selection = selectWithImpact(suites, [changedFile], { root, graph });
      const selectedFiles = new Set(selection.suites.map((suite) => suite.file));
      const mutantResults = await runSuiteSet(workspaceRoot, suiteFiles, { ...options, phase: `mutant ${name}` });
      assertNoInfrastructureErrors(mutantResults, `mutant ${name}`);
      const mutantFailures = new Set(mutantResults.filter((result) => !result.passed).map((result) => result.file));
      const comparison = compareMutationResults(baselineFailures, mutantFailures, selectedFiles);
      const { newlyFailing, caught, falseNegatives, falsePositives } = comparison;
      scenarios.push({
        name,
        changedFile,
        patchCount: applied.patchCount,
        selectedCount: selectedFiles.size,
        baselineFailures: baselineFailures.size,
        newlyFailing,
        failureDetails: newlyFailing.map((file) => ({ file, summary: summarizeFailure(mutantResults.find((result) => result.file === file)?.output ?? "") })),
        caught,
        falseNegatives,
        falsePositives,
        survived: comparison.survived,
        caughtAll: newlyFailing.length > 0 && falseNegatives.length === 0,
        fullSuiteDurationMs: sumDuration(mutantResults),
        fullSuiteResults: mutantResults,
        selectionFallback: selection.fallback,
        fallbackReason: selection.assessment?.reason ?? null,
      });
    }

    const detectableMutants = scenarios.filter((scenario) => !scenario.survived);
    const caughtMutants = detectableMutants.filter((scenario) => scenario.caughtAll);
    const missedChecks = scenarios.reduce((sum, scenario) => sum + scenario.falseNegatives.length, 0);
    const selectedChecks = scenarios.reduce((sum, scenario) => sum + scenario.caught.length, 0);
    return {
      baselineFailures: [...baselineFailures],
      baselineDurationMs: sumDuration(baselineResults),
      scenarios,
      summary: {
        generatedMutants: expansion.generatedCount,
        truncatedMutants: expansion.truncatedCount,
        totalMutants: scenarios.length,
        detectableMutants: detectableMutants.length,
        caughtMutants: caughtMutants.length,
        survivedMutants: scenarios.length - detectableMutants.length,
        falseNegativeChecks: missedChecks,
        detectedChecks: selectedChecks,
        mutationRecall: detectableMutants.length === 0 ? null : caughtMutants.length / detectableMutants.length,
        totalDurationMs: performance.now() - startedAt,
      },
    };
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

function assertNoInfrastructureErrors(results, phase) {
  const failures = results.filter((result) => result.timedOut || result.error || result.status === null);
  if (failures.length > 0) {
    const details = failures.slice(0, 5).map((result) => `${result.file}: ${result.error ?? "process exited unexpectedly"}`).join("; ");
    throw new Error(`${phase} execution was inconclusive (${failures.length} suite process error(s)): ${details}`);
  }
}

function summarizeFailure(output) {
  const line = output.split(/\r?\n/).map((value) => value.trim()).find((value) => /AssertionError|TypeError|ReferenceError|Error:|✗/.test(value));
  return line ? line.slice(0, 240) : "Suite failed; see fullSuiteResults output for diagnostics.";
}

function sumDuration(results) {
  return results.reduce((sum, result) => sum + result.durationMs, 0);
}

export function formatMutationAudit(audit) {
  const duration = (value) => value < 1_000 ? `${value.toFixed(0)} ms` : `${(value / 1_000).toFixed(2)} s`;
  const lines = [
    "[SELRUN · MUTATION AUDIT]",
    "",
    "────────────────────────────────────────────────────────────",
    "",
    `\t[BASELINE] ${audit.baselineFailures.length} pre-existing failed suite(s) · ${duration(audit.baselineDurationMs)} total suite time`,
  ];
  for (const scenario of audit.scenarios) {
    const status = scenario.survived ? "SURVIVED" : scenario.caughtAll ? "CAUGHT" : "MISS";
    lines.push("", `\t[${status} · ${scenario.name}]`);
    lines.push(`\t\tChanged: ${scenario.changedFile}`);
    lines.push(`\t\tSelected suites: ${scenario.selectedCount}${scenario.selectionFallback ? " · full fallback" : ""}`);
    if (scenario.survived) {
      lines.push("\t\t! No new full-suite failure detected; this mutant does not measure selector recall. !");
    } else {
      lines.push(`\t\t✓ Detected by selected suites: ${scenario.caught.length}/${scenario.newlyFailing.length}`);
      const detailByFile = new Map((scenario.failureDetails ?? []).map((detail) => [detail.file, detail.summary]));
      for (const file of scenario.caught) {
        lines.push(`\t\t✓ ${file}`);
        const detail = detailByFile.get(file);
        if (detail) lines.push(`\t\t\t${detail}`);
      }
      for (const file of scenario.falseNegatives) {
        lines.push(`\t\t✗ MISSED ${file}`);
        const detail = detailByFile.get(file);
        if (detail) lines.push(`\t\t\t${detail}`);
      }
      lines.push(`\t\tExtra selected suites that passed: ${scenario.falsePositives.length}`);
    }
  }
  lines.push(
    "",
    "────────────────────────────────────────────────────────────",
    audit.summary.generatedMutants > 0 ? `Generated operator mutants  ${audit.summary.generatedMutants}${audit.summary.truncatedMutants ? ` · truncated ${audit.summary.truncatedMutants} by max-mutants` : ""}` : null,
    `Mutation recall  ${audit.summary.mutationRecall === null ? "N/A (no detectable mutants)" : `${(audit.summary.mutationRecall * 100).toFixed(1)}%`}`,
    `Mutants caught  ✓ ${audit.summary.caughtMutants}   ✗ missed ${audit.summary.detectableMutants - audit.summary.caughtMutants}   ◌ survived ${audit.summary.survivedMutants}`,
    `False-negative suite checks  ${audit.summary.falseNegativeChecks}`,
    `Duration  ${duration(audit.summary.totalDurationMs)}`,
  );
  return lines.join("\n");
}

export function readMutationFile(file) {
  const absolute = path.resolve(file);
  const parsed = JSON.parse(fs.readFileSync(absolute, "utf8"));
  if (!Array.isArray(parsed)) throw new Error("mutation file must contain a JSON array");
  return parsed;
}

function lineNumberAt(lineStarts, offset) {
  let low = 0;
  let high = lineStarts.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (lineStarts[middle] <= offset) low = middle + 1;
    else high = middle;
  }
  return low;
}

function validatePositiveInteger(value, label, maxValue) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maxValue) {
    throw new Error(`${label} must be an integer from 1 to ${maxValue}`);
  }
  return value;
}

function normalizeMutationPath(file) {
  if (typeof file !== "string" || !file.trim()) throw new Error("mutation.file must be a non-empty repository-relative path");
  const normalized = file.replaceAll("\\", "/");
  if (path.isAbsolute(normalized) || normalized.split("/").includes("..")) throw new Error(`invalid mutation path: ${file}`);
  return normalized;
}
