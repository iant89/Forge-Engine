/**
 * One JavaScript engine's half of the Phase 19.5 cross-engine check. Run by `npm run
 * check:replay-engines` under Node (V8, through tsx) and under Bun (JavaScriptCore, Safari's engine);
 * it prints one `REPLAY_VERIFY {json}` line, and the orchestrator (tools/replay-engines.mjs) compares
 * the engines with each other and with the committed fixture.
 *
 *   - the DMath vector digest (examples/src/replay/dmathVectors.ts);
 *   - the committed recording of the verification session (examples/src/replay/vehicle-session.replay.json)
 *     verified three ways by `verifyRecording`: playback, a live re-run on its schedule, and a save
 *     part-way resumed in a fresh build;
 *   - how many implementation-approximated `Math` functions the simulation called while doing so (0).
 *
 * `--write-fixture` records the session on this engine and rewrites the fixture first. Only do that
 * when the session or the simulation changed on purpose: the fixture is the contract every engine
 * replays.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { APPROXIMATED_MATH_FUNCTIONS, validateReplay } from "@forge/engine";
import { DMATH_VECTOR_DIGEST, dmathVectorDigest } from "../examples/src/replay/dmathVectors.js";
import { recordVerificationSession, verifyRecording, VERIFY_FRAMES } from "../examples/src/replay/verificationSession.js";

const FIXTURE = new URL("../examples/src/replay/vehicle-session.replay.json", import.meta.url);

function engineName(): string {
  const g = globalThis as { Bun?: { version: string }; process?: { versions?: Record<string, string> } };
  if (g.Bun) return `JavaScriptCore (Bun ${g.Bun.version})`;
  const v = g.process?.versions;
  return v?.["v8"] ? `V8 ${v["v8"]} (Node ${v["node"]})` : "unknown";
}

if (process.argv.includes("--write-fixture")) {
  const { recording } = recordVerificationSession(VERIFY_FRAMES);
  writeFileSync(FIXTURE, `${JSON.stringify(recording)}\n`);
}

// Count calls to the engine-dependent Math functions while the simulation runs.
let approximatedCalls = 0;
const originals = new Map<string, unknown>();
const math = Math as unknown as Record<string, (...a: number[]) => number>;
for (const name of APPROXIMATED_MATH_FUNCTIONS) {
  const original = math[name]!;
  originals.set(name, original);
  math[name] = (...a: number[]) => {
    approximatedCalls++;
    return original.apply(Math, a);
  };
}

const started = performance.now();
const recording = validateReplay(JSON.parse(readFileSync(FIXTURE, "utf8")));
const report = verifyRecording(recording);
const ms = Math.round(performance.now() - started);
for (const [name, original] of originals) math[name] = original as (...a: number[]) => number;

const vectors = dmathVectorDigest();
const result = {
  engine: engineName(),
  ok: report.ok && approximatedCalls === 0 && vectors.digest === DMATH_VECTOR_DIGEST,
  dmathDigest: vectors.digest,
  dmathExpected: DMATH_VECTOR_DIGEST,
  frames: recording.frames.length,
  checkpoints: report.playback.checkpointsCompared,
  divergences: report.playback.divergences.slice(0, 3),
  expectedFinal: report.expectedFinal,
  rerunFinal: report.rerunFinal,
  resumedFinal: report.resumedFinal,
  approximatedCalls,
  ms,
};
console.log(`REPLAY_VERIFY ${JSON.stringify(result)}`);
process.exitCode = result.ok ? 0 : 1;
