#!/usr/bin/env node
/**
 * check:replay-engines — Phase 19.5: the same input stream must produce identical state hashes on
 * every JavaScript engine.
 *
 * Runs tools/replay-verify.ts under Node (V8, the engine of Chrome and Edge) and under Bun
 * (JavaScriptCore, the engine of Safari and every iOS browser), and passes only if each engine
 *
 *   - reproduces the DMath vector digest pinned in examples/src/replay/dmathVectors.ts,
 *   - replays the committed vehicle-session recording to every checkpoint hash, re-runs it live to its
 *     final hash, and resumes a mid-session save to the same final hash, and
 *   - calls no implementation-approximated Math function while simulating,
 *
 * and both engines report the same hashes. Exits 0 on a pass, 1 on a failure, and 2 (NOT RUN) when
 * Bun is not installed — a Node-only pass proves nothing across engines, so it is not reported as one.
 *
 *   npm run check:replay-engines                     # both engines
 *   npm run check:replay-engines -- --write-fixture  # re-record the fixture under Node first
 */

import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join("tools", "replay-verify.ts");
const tsconfig = path.join("examples", "tsconfig.json");
const writeFixture = process.argv.includes("--write-fixture");

function run(label, command, args, env = {}) {
  const r = spawnSync(command, args, { cwd: root, encoding: "utf-8", env: { ...process.env, ...env }, maxBuffer: 1 << 26 });
  if (r.error) return { label, missing: r.error.code === "ENOENT", error: String(r.error.message) };
  const line = (r.stdout ?? "").split("\n").find((l) => l.startsWith("REPLAY_VERIFY "));
  // Bun 1.x prints a harmless "Internal error: directory mismatch" notice for --tsconfig-override.
  const stderr = (r.stderr ?? "")
    .split("\n")
    .filter((l) => l.trim() && !l.startsWith("Internal error: directory mismatch"))
    .join("\n");
  if (!line) return { label, error: `no result (exit ${r.status})\n${stderr || r.stdout}` };
  return { label, result: JSON.parse(line.slice("REPLAY_VERIFY ".length)), stderr };
}

function hasBun() {
  const r = spawnSync("bun", ["--version"], { encoding: "utf-8" });
  return !r.error && r.status === 0;
}

const runs = [];
const nodeArgs = ["tsx", script];
if (writeFixture) nodeArgs.push("--write-fixture");
runs.push(run("node", "npx", nodeArgs, { TSX_TSCONFIG_PATH: path.join(root, tsconfig) }));
const bun = hasBun();
if (bun) runs.push(run("bun", "bun", [`--tsconfig-override=${tsconfig}`, script]));

let failed = false;
for (const r of runs) {
  if (r.error) {
    failed = true;
    console.error(`  ${r.label}: ERROR ${r.error}`);
    continue;
  }
  const x = r.result;
  console.log(
    `  ${x.ok ? "PASS" : "FAIL"}  ${x.engine}\n` +
      `        DMath digest ${x.dmathDigest} (pinned ${x.dmathExpected})\n` +
      `        replay: ${x.frames} frames, ${x.checkpoints} checkpoint hashes, ${x.divergences.length} divergences; final ${x.expectedFinal}\n` +
      `        live re-run ${x.rerunFinal}, resumed from a mid-session save ${x.resumedFinal}\n` +
      `        engine-dependent Math calls while simulating: ${x.approximatedCalls}; ${(x.ms / 1000).toFixed(1)} s`,
  );
  if (x.divergences.length) console.log(`        first divergence: ${JSON.stringify(x.divergences[0])}`);
  if (!x.ok) failed = true;
}

const results = runs.filter((r) => r.result).map((r) => r.result);
if (results.length === 2) {
  const [a, b] = results;
  const same = a.dmathDigest === b.dmathDigest && a.rerunFinal === b.rerunFinal && a.resumedFinal === b.resumedFinal;
  if (!same) {
    failed = true;
    console.error("  FAIL  the engines disagree with each other");
  }
}

if (failed) {
  console.error("check:replay-engines FAILED");
  process.exit(1);
}
if (!bun) {
  console.error("check:replay-engines NOT RUN across engines — Bun (JavaScriptCore) is not installed; only Node ran (https://bun.sh)");
  process.exit(2);
}
console.log("check:replay-engines OK — V8 and JavaScriptCore replay the vehicle session to identical state hashes.");
