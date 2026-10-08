#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { readLinkedSuites, validateCatalog } from "./catalog.mjs";
import { collectBaseChanges, collectWorkingChanges, selectSuitesForChanges } from "./selection.mjs";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const args = process.argv.slice(2);
const command = args.shift() ?? "run";

function usage() {
  console.log(`selrun — manifest-driven TypeScript suite runner

Commands:
  selrun run --all                 Run every linked suite, each in a separate process
  selrun serial [tests/full.test.ts] Run linked suites in order, one process each
  selrun affected [--base REF]     Run suites selected by the normalized Git change set
  selrun check                    Validate links, manifests, unique names, and covers

Options:
  --print                         Print an affected selection without running it
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

function runSuites(files) {
  let failed = 0;
  console.log(`selrun: running ${files.length} suite${files.length === 1 ? "" : "s"}, one process per suite`);
  for (let index = 0; index < files.length; index++) {
    const file = files[index];
    console.log(`\n[${index + 1}/${files.length}] ${file}`);
    const status = runFile(file);
    if (status !== 0) failed++;
  }
  console.log(`\nselrun: ${files.length} suites complete; ${failed} suite${failed === 1 ? "" : "s"} failed`);
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
    } else if (options[index] !== "--print" && options[index] !== "--json") {
      throw new Error(`unknown option: ${options[index]}`);
    }
  }
  return base;
}

function printAffected(suites, changes, selection, base, json) {
  const selectedPaths = new Set(selection.suites.map((suite) => suite.file));
  const ordered = suites.filter((suite) => selectedPaths.has(suite.file));
  if (json) {
    console.log(JSON.stringify({
      base,
      changedPaths: selection.changedPaths,
      suites: ordered.map((suite) => ({
        file: suite.file,
        name: suite.name,
        reason: selection.reasons.get(suite.file),
      })),
    }, null, 2));
    return ordered;
  }
  console.log(`selrun: ${base ? `base ${base}...HEAD` : "working-tree change set"}`);
  console.log(`  changed paths: ${changes.length}`);
  for (const file of changes) console.log(`    - ${file}`);
  console.log(`  selected suites: ${ordered.length}`);
  for (const suite of ordered) {
    const reason = selection.reasons.get(suite.file);
    console.log(`    - ${suite.file} (${reason?.kind}: ${reason?.path})`);
  }
  return ordered;
}

try {
  if (command === "help" || command === "--help" || command === "-h") {
    usage();
  } else if (command === "check") {
    const result = checkCatalog();
    if (!result) process.exitCode = 1;
    else console.log(`selrun: check OK — ${result.stats.suitesLinked} linked suites, ${result.stats.coverageClaims} explicit coverage claims`);
  } else if (command === "serial") {
    const file = args[0] ?? "tests/full.test.ts";
    if (file !== "tests/full.test.ts") throw new Error("serial mode runs only the ordered tests/full.test.ts suite list");
    if (!checkCatalog()) process.exitCode = 1;
    else {
      const { links } = readLinkedSuites(packageRoot);
      process.exitCode = runSuites(links.map((link) => link.file));
    }
  } else if (command === "run") {
    if (!args.every((argument) => argument === "--all")) throw new Error("run accepts only --all; use affected for selective execution");
    const catalog = checkCatalog();
    if (!catalog) process.exitCode = 1;
    else {
      const { links } = readLinkedSuites(packageRoot);
      process.exitCode = runSuites(links.map((link) => link.file));
    }
  } else if (command === "affected") {
    const base = parseBase(args);
    const printOnly = args.includes("--print");
    const json = args.includes("--json");
    const catalog = checkCatalog();
    if (!catalog) {
      process.exitCode = 1;
    } else {
      const changed = base ? collectBaseChanges(base, packageRoot) : collectWorkingChanges(packageRoot);
      const selection = selectSuitesForChanges(catalog.suites, changed, packageRoot);
      const ordered = printAffected(catalog.suites, changed, selection, base, json);
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
