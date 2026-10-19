#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { readLinkedSuites, validateCatalog } from "./catalog.mjs";
import { collectBaseChanges, collectWorkingChanges, selectSuitesForChanges, selectWithImpact, assessChangeConfidence, buildProjectGraph } from "./selection.mjs";
import * as fs from "node:fs";
import { SMOKE_FLOOR } from "./subsystems.mjs";
import { auditScenarios } from "./impact.mjs";
import { auditMutations, formatMutationAudit, readMutationFile } from "./mutation-audit.mjs";
import { runSuitesConcurrent } from "./concurrent-runner.mjs";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const args = process.argv.slice(2);
const command = args.shift() ?? "run";

function usage() {
  console.log(`selrun — manifest-driven TypeScript suite runner

Commands:
  selrun run --all [--jobs N]       Run every linked suite in isolated processes (bounded parallelism; default 2)
  selrun run --all --jobs 1         Run every linked suite sequentially
  selrun serial [tests/full.test.ts] Run linked suites in order, one process each
  selrun affected [--base REF]     Run suites selected by the normalized Git change set (fail-safe)
  selrun affected --print          Print an affected selection without running it
  selrun affected --explain        Print selection with evidence breakdown
  selrun check                     Validate links, manifests, unique names, and covers
  selrun audit                    Compare selected scope for the current change set
  selrun audit --scenarios FILE    Check injected-regression scenarios
  selrun audit --mutations FILE    Apply real source mutations in a disposable copy and compare against the full suite

Run options:
  --jobs N                        Run at most N suites concurrently (default 2; max 16)

Mutation audit options:
  --max-mutants N                 Cap generated operator mutants (default 20)
  --timeout-ms N                  Per-suite timeout in milliseconds (default 120000)

Options:
  --print                         Print an affected selection without running it
  --explain                       Show transitive, subsystem, smoke, and fallback evidence
  --json                          Output selection as JSON
  --base REF                      Compare base...HEAD only; ignores working-tree changes
`);
}

function checkCatalog() {
  const result = validateCatalog(packageRoot);
  if (result.errors.length > 0) {
    console.error(`selrun: check failed — ${result.errors.length} problem${result.errors.length === 1 ? "" : "s"}`);
    for (const error of result.errors) console.error(`  - ${error}`);
    return null;
  }
  return result;
}

function runFile(file) {
  const absolute = path.resolve(packageRoot, file);
  const result = spawnSync(process.execPath, ["--import", "tsx", absolute], {
    cwd: packageRoot,
    stdio: "inherit",
    env: { ...process.env, TSX_TSCONFIG_PATH: path.join(packageRoot, "tests/tsconfig.json") },
  });
  if (result.error) {
    console.error(`selrun: could not start ${file}: ${result.error.message}`);
    return 1;
  }
  return result.status ?? 1;
}

function formatDuration(milliseconds) {
  return milliseconds < 1_000 ? `${milliseconds.toFixed(0)} ms` : `${(milliseconds / 1_000).toFixed(2)} s`;
}

function runSuites(files) {
  const startedAt = performance.now();
  let failed = 0;
  console.log(`\nSelrun · running ${files.length} suite${files.length === 1 ? "" : "s"} (isolated processes)`);
  console.log("────────────────────────────────────────────────────────────");
  for (let index = 0; index < files.length; index++) {
    const file = files[index];
    console.log(`\n[${index + 1}/${files.length}] ${file}`);
    const suiteStartedAt = performance.now();
    const status = runFile(file);
    const duration = formatDuration(performance.now() - suiteStartedAt);
    if (status !== 0) {
      failed++;
      console.log(`  ✗ SUITE FAILED  ${duration}`);
    } else {
      console.log(`  ✓ SUITE PASSED  ${duration}`);
    }
  }
  const totalDuration = formatDuration(performance.now() - startedAt);
  console.log("\n────────────────────────────────────────────────────────────");
  console.log(`Suite summary  ✓ ${files.length - failed} passed   ✗ ${failed} failed`);
  console.log(`Total duration ${totalDuration}`);
  return failed === 0 ? 0 : 1;
}

function parseBase(options) {
  let base = null;
  for (let index = 0; index < options.length; index++) {
    if (options[index] === "--base") {
      base = options[index + 1];
      if (!base) throw new Error("--base requires a Git ref");
      index++;
    } else if (options[index].startsWith("--base=")) {
      base = options[index].slice("--base=".length);
    } else if (options[index] === "--scenarios" || options[index] === "--mutations" || options[index] === "--jobs" || options[index] === "--max-mutants" || options[index] === "--timeout-ms") {
      if (!options[index + 1]) throw new Error(`${options[index]} requires a value`);
      index++;
    } else if (["--print", "--json", "--explain", "--verbose"].includes(options[index])) {
      // known flags, ignore
    } else if (options[index].startsWith("--")) {
      // Allow other flags to pass
      continue;
    } else {
      throw new Error(`unknown option: ${options[index]}`);
    }
  }
  return base;
}

function parsePositiveOption(options, flag, defaultValue, maxValue) {
  const inline = options.find((option) => option.startsWith(`${flag}=`));
  const index = options.indexOf(flag);
  const raw = inline ? inline.slice(flag.length + 1) : index >= 0 ? options[index + 1] : null;
  if (raw === null || raw === undefined) return defaultValue;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > maxValue) {
    throw new Error(`${flag} must be an integer from 1 to ${maxValue}`);
  }
  return value;
}

function printAffected(suites, changes, selection, base, json, explain) {
  const selectedPaths = new Set(selection.suites.map((suite) => suite.file));
  const ordered = suites.filter((suite) => selectedPaths.has(suite.file));
  if (json) {
    console.log(JSON.stringify({
      base,
      changedPaths: selection.changedPaths,
      assessment: selection.assessment,
      fallback: selection.fallback,
      impactedSubsystems: selection.impactedSubsystems,
      transitiveDependents: selection.transitiveDependents,
      evidenceCounts: selection.evidenceCounts,
      smokeAdded: selection.smokeAdded?.map((s) => s.file),
      suites: ordered.map((suite) => ({
        file: suite.file,
        name: suite.name,
        reason: selection.reasons.get(suite.file),
      })),
    }, null, 2));
    return ordered;
  }
  const sourceLabel = base ? `BASE ${base}...HEAD` : "WORKING TREE";
  const line = "────────────────────────────────────────────────────────────";
  console.log(`\n[SELRUN · AFFECTED ANALYSIS]`);
  console.log(`\n${line}`);

  console.log(`\n\t[CHANGE SET · ${sourceLabel}]`);
  console.log(`\t\t${changes.length} changed path${changes.length === 1 ? "" : "s"}`);
  for (const file of changes) console.log(`\t\t• ${file}`);

  console.log(`\n\t[IMPACT ASSESSMENT]`);
  if (selection.fallback) {
    console.log(`\t\t! FULL SUITE FALLBACK: ${selection.assessment?.reason ?? "impact could not be resolved confidently"} !`);
  } else if (selection.assessment?.reason) {
    console.log(`\t\tScope: ${selection.assessment.scope} — ${selection.assessment.reason}`);
  } else {
    console.log(`\t\tScope: ${selection.assessment?.scope ?? "affected"} — selection evidence resolved`);
  }
  if (selection.impactedSubsystems?.length) {
    console.log(`\t\tSubsystems: ${selection.impactedSubsystems.join(", ")}`);
  }

  if (explain && selection.transitiveDependents?.length) {
    console.log(`\n\t[TRANSITIVE DEPENDENCIES · ${selection.transitiveDependents.length} FILES]`);
    for (const dependent of selection.transitiveDependents.slice(0, 10)) console.log(`\t\t• ${dependent}`);
    if (selection.transitiveDependents.length > 10) {
      console.log(`\t\t… and ${selection.transitiveDependents.length - 10} more`);
    }
  }

  if (selection.evidenceCounts) {
    console.log(`\n\t[SELECTION EVIDENCE]`);
    for (const [kind, count] of Object.entries(selection.evidenceCounts)) {
      if (count > 0) console.log(`\t\t${kind}: ${count}`);
    }
  }

  console.log(`\n\t[SELECTED SUITES · ${ordered.length}${selection.fallback ? " · FULL FALLBACK" : ""}]`);
  let lastArea = "";
  for (const suite of ordered) {
    const area = suite.file.split("/")[1]?.toLocaleUpperCase() ?? "OTHER";
    if (area !== lastArea) {
      console.log(`\n\t\t[${area}]`);
      lastArea = area;
    }
    const reason = selection.reasons.get(suite.file);
    const detail = reason?.claim ? ` · claim ${reason.claim}`
      : reason?.via ? ` · via ${reason.via}`
      : reason?.subsystem ? ` · subsystem ${reason.subsystem}`
      : reason?.reason ? ` · ${reason.reason}` : "";
    console.log(`\t\t→ ${suite.name} — ${suite.file} (${reason?.kind ?? "selected"}: ${reason?.path ?? "impact"}${detail})`);
  }

  const browserRelevant = selection.impactedSubsystems?.some((subsystem) =>
    ["rendering", "scene", "environment", "terrain", "vehicles", "gpu"].includes(subsystem),
  );
  if (browserRelevant) {
    console.log(`\n\t[ADDITIONAL COVERAGE]`);
    console.log(`\t\t! Consider npm run check:browser for real-WebGPU coverage; browser checks run separately. !`);
  }
  if (selection.smokeAdded?.length) {
    console.log(`\n\t[SMOKE FLOOR]`);
    console.log(`\t\t✓ ${SMOKE_FLOOR.length} mandatory suites included (${selection.smokeAdded.length} added to this selection)`);
  }

  console.log(`\n${line}`);
  return ordered;
}

async function runAudit(catalog, options) {
  if (options.mutations) {
    const mutationFile = path.resolve(packageRoot, options.mutations);
    const mutations = readMutationFile(mutationFile);
    console.log(`selrun: full-suite mutation audit in disposable workspaces · concurrency ${options.jobs ?? 2}`);
    const audit = await auditMutations(packageRoot, mutations, {
      concurrency: options.jobs,
      maxMutants: options.maxMutants,
      timeoutMs: options.timeoutMs,
      onProgress: ({ phase, completed, total }) => {
        if (completed === total || completed % 10 === 0) console.log(`  ${phase}: ${completed}/${total} suites`);
      },
    });
    console.log(formatMutationAudit(audit));
    return audit.summary.falseNegativeChecks > 0 || audit.summary.survivedMutants > 0 ? 1 : 0;
  }
  if (options.scenarios) {
    const scenarioFile = path.resolve(packageRoot, options.scenarios);
    const scenarios = JSON.parse(fs.readFileSync(scenarioFile, "utf8"));
    if (!Array.isArray(scenarios)) throw new Error("--scenarios file must contain a JSON array");
    const suites = catalog.suites.map((suite) => ({ ...suite, covers: suite.covers ?? [] }));
    const audit = auditScenarios(suites, scenarios, packageRoot);
    console.log(`selrun audit: injected regression scenarios`);
    console.log(`  scenarios: ${audit.caught}/${audit.total} caught; false-negative scenarios: ${audit.missed}`);
    for (const scenario of audit.results) {
      const label = scenario.caught ? "CAUGHT" : "MISS";
      console.log(`  - ${label} ${scenario.name} (${scenario.selectedCount} selected${scenario.fallback ? ", full fallback" : ""})`);
      if (scenario.missed.length) console.error(`      missed: ${scenario.missed.join(", ")}`);
    }
    return audit.missed === 0 ? 0 : 1;
  }

  // Compare the selector against the current change set. This reports conservative
  // expansion only; it does not claim actual regression-detection accuracy.
  const changes = options.base ? collectBaseChanges(options.base, packageRoot) : collectWorkingChanges(packageRoot);
  const legacy = selectSuitesForChanges(catalog.suites, changes, packageRoot);
  const graph = buildProjectGraph(packageRoot);
  const safe = selectWithImpact(catalog.suites, changes, { root: packageRoot, graph });

  console.log(`selrun audit: selection coverage comparison`);
  console.log(`  note: without full-suite or injected-regression outcomes, this is not measured accuracy; run audit --scenarios FILE to measure injected-regression false negatives`);
  console.log(`  catalog: ${catalog.stats.suitesLinked} suites, ${catalog.stats.coverageClaims} coverage claims`);
  console.log(`  changes: ${changes.length} files`);
  console.log(`  legacy selected: ${legacy.suites.length}`);
  console.log(`  safe selected: ${safe.suites.length} (fallback=${safe.fallback})`);
  console.log(`  smoke floor: ${SMOKE_FLOOR.length}`);

  const legacyFiles = new Set(legacy.suites.map((suite) => suite.file));
  const safeFiles = new Set(safe.suites.map((suite) => suite.file));

  // Show the conservative expansion relative to the direct-only selector.
  const missedByLegacy = [...safeFiles].filter((file) => !legacyFiles.has(file));
  const extraBySafe = missedByLegacy.length;

  console.log(`  additional suites selected by safe selector: ${extraBySafe} (conservative expansion, not verified false negatives)`);
  if (missedByLegacy.length > 0) {
    for (const f of missedByLegacy.slice(0, 10)) console.log(`    + ${f} (${safe.reasons.get(f)?.kind})`);
    if (missedByLegacy.length > 10) console.log(`    ... and ${missedByLegacy.length - 10} more`);
  }

  // Show evidence breakdown
  if (safe.evidenceCounts) {
    console.log(`  safe evidence: ${JSON.stringify(safe.evidenceCounts)}`);
  }
  if (safe.assessment?.reason) console.log(`  assessment: ${safe.assessment.reason}`);

  // For CI, we can also check that smoke floor is present
  const smokeMissing = SMOKE_FLOOR.filter(f => !safeFiles.has(f));
  if (smokeMissing.length > 0) {
    console.error(`  ERROR: smoke floor missing: ${smokeMissing.join(", ")}`);
    return 1;
  }
  console.log(`  smoke floor: OK (${SMOKE_FLOOR.length} suites present)`);

  // Report fallback behavior: if fallback triggered, it's conservative (good) — but we want to know why
  if (safe.fallback) {
    console.log(`  fallback triggered: ${safe.assessment.reason} — running full suite is correct (conservative)`);
  }

  console.log(`\n  key metric: false negatives must be measured against real full-suite or injected-regression outcomes.`);
  console.log(`    current run: outcome data not supplied; no false-negative or false-positive rate is claimed.`);

  return 0;
}

try {
  if (command === "help" || command === "--help" || command === "-h") {
    usage();
  } else if (command === "check") {
    const result = checkCatalog();
    if (!result) process.exitCode = 1;
    else {
      console.log(`selrun: check OK — ${result.stats.suitesLinked} linked suites, ${result.stats.coverageClaims} explicit coverage claims`);
      // Also report smoke floor and subsystem health
      console.log(`selrun: smoke floor — ${SMOKE_FLOOR.length} suites`);
      console.log(`selrun: subsystems — ${Object.keys((await import("./subsystems.mjs")).SUBSYSTEMS).length} defined`);
    }
  } else if (command === "audit") {
    const catalog = checkCatalog();
    if (!catalog) process.exitCode = 1;
    else {
      const base = parseBase(args);
      const scenarioIndex = args.findIndex((arg) => arg === "--scenarios");
      const mutationIndex = args.findIndex((arg) => arg === "--mutations");
      if (scenarioIndex >= 0 && mutationIndex >= 0) throw new Error("choose either --scenarios or --mutations");
      const scenarios = scenarioIndex >= 0 ? args[scenarioIndex + 1] : null;
      const mutations = mutationIndex >= 0 ? args[mutationIndex + 1] : null;
      if (scenarioIndex >= 0 && !scenarios) throw new Error("--scenarios requires a JSON file path");
      if (mutationIndex >= 0 && !mutations) throw new Error("--mutations requires a JSON file path");
      process.exitCode = await runAudit(catalog, {
        base,
        scenarios,
        mutations,
        jobs: parsePositiveOption(args, "--jobs", undefined, 16),
        maxMutants: parsePositiveOption(args, "--max-mutants", undefined, 1_000),
        timeoutMs: parsePositiveOption(args, "--timeout-ms", undefined, 3_600_000),
      });
    }
  } else if (command === "serial") {
    const file = args[0] ?? "tests/full.test.ts";
    if (file !== "tests/full.test.ts") throw new Error("serial mode runs only the ordered tests/full.test.ts suite list");
    if (!checkCatalog()) process.exitCode = 1;
    else {
      const { links } = readLinkedSuites(packageRoot);
      process.exitCode = runSuites(links.map((link) => link.file));
    }
  } else if (command === "run") {
    const jobsFlags = args.filter((argument) => argument === "--jobs" || argument.startsWith("--jobs="));
    if (jobsFlags.length > 1) throw new Error("specify --jobs only once");
    const remaining = args.filter((argument, index) =>
      argument !== "--jobs" && !argument.startsWith("--jobs=") && !(index > 0 && args[index - 1] === "--jobs"),
    );
    if (remaining.length !== 1 || remaining[0] !== "--all") {
      throw new Error("run accepts --all and optional --jobs N; use affected for selective execution");
    }
    const jobs = parsePositiveOption(args, "--jobs", 2, 16);
    const catalog = checkCatalog();
    if (!catalog) process.exitCode = 1;
    else {
      const { links } = readLinkedSuites(packageRoot);
      process.exitCode = await runSuitesConcurrent(links.map((link) => link.file), { concurrency: jobs, root: packageRoot });
    }
  } else if (command === "affected") {
    const base = parseBase(args);
    const printOnly = args.includes("--print");
    const json = args.includes("--json");
    const explain = args.includes("--explain");
    const catalog = checkCatalog();
    if (!catalog) {
      // Coverage metadata is not trustworthy, so do not attempt affected selection.
      // If the ordered suite manifest itself is still parseable, run every linked suite.
      const linked = readLinkedSuites(packageRoot);
      const fallbackFiles = linked.links
        .filter((link) => link.file && link.importPath && link.file === link.importPath && fs.existsSync(path.resolve(packageRoot, link.file)))
        .map((link) => link.file);
      const linksAreComplete = fallbackFiles.length > 0 &&
        fallbackFiles.length === linked.links.length &&
        new Set(fallbackFiles).size === fallbackFiles.length &&
        linked.reportCounts.length === 1 && linked.reportCounts[0] === fallbackFiles.length;
      if (linked.parseErrors.length > 0 || !linksAreComplete) {
        console.error("selrun: cannot resolve the full-suite manifest; affected run aborted safely");
        process.exitCode = 1;
      } else if (printOnly) {
        console.log(`selrun: catalog/coverage validation failed; full-suite fallback would run ${fallbackFiles.length} linked suites`);
        process.exitCode = 1;
      } else {
        console.error("selrun: catalog/coverage validation failed; falling back to every linked suite");
        process.exitCode = runSuites(fallbackFiles);
      }
    } else {
      const changed = base ? collectBaseChanges(base, packageRoot) : collectWorkingChanges(packageRoot);
      let graph;
      let selection;
      try {
        graph = buildProjectGraph(packageRoot);
        selection = selectWithImpact(catalog.suites, changed, { root: packageRoot, graph });
      } catch (error) {
        // A graph or selector failure is uncertain impact evidence, so fail closed.
        const message = error instanceof Error ? error.message : String(error);
        console.error(`selrun: impact analysis failed (${message}); falling back to full suite`);
        selection = {
          changedPaths: changed,
          suites: catalog.suites,
          reasons: new Map(catalog.suites.map((suite) => [suite.file, { kind: "fallback", path: changed[0] ?? "unknown", reason: message }])),
          assessment: { fallback: true, reason: `impact analysis failed: ${message}`, scope: "full" },
          fallback: true,
          smokeAdded: [],
          transitiveDependents: [],
          impactedSubsystems: [],
          evidenceCounts: { fallback: catalog.suites.length },
        };
      }
      const ordered = printAffected(catalog.suites, changed, selection, base, json, explain);
      if (!printOnly) process.exitCode = runSuites(ordered.map((suite) => suite.file));
    }
  } else {
    usage();
    throw new Error(`unknown command: ${command}`);
  }
} catch (error) {
  console.error(`selrun: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 64;
}
