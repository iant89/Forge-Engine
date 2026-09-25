#!/usr/bin/env node
/**
 * affected-tests.mjs — run only the vitest suites a change can reach (Phase 9 hardening).
 *
 * Reads the changed files from git, maps them to subsystems via `tools/test-subsystems.mjs`, expands
 * to every dependent subsystem, always adds the smoke floor, and runs exactly those suites. A change
 * to a foundation layer (core/math), to the build/test config, or to a file no subsystem owns falls
 * back to the full suite — selection never trades safety for speed silently; it says why in one line.
 *
 * Usage:
 *   node tools/affected-tests.mjs [options] [-- <extra vitest args>]
 *
 *   --base <ref>   Compare against this git ref (default: auto — origin/main, else main, else HEAD~1).
 *   --all          Force the full suite (the "opt-in full run"). Same as FORGE_TEST_ALL=1.
 *   --print        Print the selection and the command; do not run anything (alias: --dry-run).
 *   --json         Print the decision as JSON (implies --print).
 *   -- <args>      Everything after `--` is forwarded to vitest (e.g. `-- --reporter=dot`).
 *
 * Exit code is vitest's, or 0 for --print/--json.
 */

import { spawnSync } from "node:child_process";
import * as path from "node:path";
import {
  repoRoot,
  selectForChanges,
  allTestFiles,
  subsystems,
} from "./test-subsystems.mjs";

// --------------------------------------------------------------------------- args

const argv = process.argv.slice(2);
const opts = { base: null, all: false, print: false, json: false, vitest: [] };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--") {
    opts.vitest = argv.slice(i + 1);
    break;
  } else if (a === "--base") {
    opts.base = argv[++i] ?? null;
  } else if (a.startsWith("--base=")) {
    opts.base = a.slice("--base=".length);
  } else if (a === "--all") {
    opts.all = true;
  } else if (a === "--print" || a === "--dry-run") {
    opts.print = true;
  } else if (a === "--json") {
    opts.json = true;
    opts.print = true;
  } else {
    console.error(`affected-tests: unknown argument "${a}"`);
    process.exit(64);
  }
}
if (process.env.FORGE_TEST_ALL === "1") opts.all = true;

// --------------------------------------------------------------------------- git

function git(args) {
  const res = spawnSync("git", args, { cwd: repoRoot, encoding: "utf-8" });
  if (res.status !== 0) return null;
  return res.stdout.trim();
}

function refExists(ref) {
  return spawnSync("git", ["rev-parse", "--verify", "--quiet", ref], {
    cwd: repoRoot,
    encoding: "utf-8",
  }).status === 0;
}

/** Pick the ref to diff against: explicit flag, then env, then the usual mainline refs. */
function resolveBase() {
  const candidates = [
    opts.base,
    process.env.AFFECTED_BASE,
    "origin/main",
    "main",
    "origin/HEAD",
  ].filter(Boolean);
  for (const ref of candidates) if (refExists(ref)) return ref;
  if (refExists("HEAD~1")) return "HEAD~1";
  return null; // brand-new repo with a single commit and no mainline
}

/** Committed diff since the merge-base with `base`, plus uncommitted and untracked working changes. */
function changedFiles(base) {
  const files = new Set();
  const add = (out) => {
    if (out) for (const line of out.split("\n")) if (line.trim()) files.add(line.trim());
  };
  if (base) {
    // Two-dot vs three-dot: `A...B` diffs from the merge-base, which is what a PR review shows.
    add(git(["diff", "--name-only", `${base}...HEAD`]));
  }
  add(git(["diff", "--name-only", "HEAD"])); // staged + unstaged tracked changes
  add(git(["ls-files", "--others", "--exclude-standard"])); // new untracked files
  return [...files];
}

// --------------------------------------------------------------------------- decide

let decision;
let base = null;
if (opts.all) {
  decision = {
    full: true,
    reason: "--all (opt-in full run)",
    subsystems: Object.keys(subsystems),
    testFiles: allTestFiles(),
  };
} else {
  base = resolveBase();
  const files = changedFiles(base);
  decision = selectForChanges(files);
  decision._base = base ?? "(none)";
  decision._changed = files;
}

// --------------------------------------------------------------------------- report

const banner = decision.full ? "FULL RUN" : "AFFECTED RUN";
if (opts.json) {
  console.log(JSON.stringify(decision, null, 2));
} else {
  console.log(`\n  Forge test selection — ${banner}`);
  if (base !== null) console.log(`  base:      ${decision._base}`);
  if (decision._changed) console.log(`  changed:   ${decision._changed.length} file(s)`);
  console.log(`  reason:    ${decision.reason}`);
  if (!decision.full) console.log(`  subsystems: ${decision.subsystems.join(", ") || "(none)"}`);
  console.log(`  suites:    ${decision.testFiles.length}\n`);
  for (const t of decision.testFiles) console.log(`    - ${t}`);
  console.log("");
}

if (opts.print) process.exit(0);

// --------------------------------------------------------------------------- run

const vitestBin = path.join(repoRoot, "node_modules", ".bin", "vitest");
// A full run passes no positional filters, so vitest uses the config's `include` glob. An affected
// run passes exact file paths, which vitest treats as filename filters.
const vitestArgs = ["run", ...opts.vitest, ...(decision.full ? [] : decision.testFiles)];
const run = spawnSync(vitestBin, vitestArgs, { cwd: repoRoot, stdio: "inherit" });
process.exit(run.status ?? 1);
