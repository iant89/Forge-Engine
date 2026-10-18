/**
 * The replay-verify page's worker: runs the Phase 19.5 checks off the main thread (they take seconds on
 * a phone) and posts one result. The same checks as tools/replay-verify.ts, in a browser's engine.
 */

import { APPROXIMATED_MATH_FUNCTIONS, validateReplay } from "@forge/engine";
import { DMATH_VECTOR_DIGEST, dmathVectorDigest } from "./dmathVectors.js";
import { verifyRecording } from "./verificationSession.js";
import fixture from "./vehicle-session.replay.json";

export interface VerifyPageResult {
  ok: boolean;
  dmathDigest: string;
  dmathExpected: string;
  frames: number;
  checkpoints: number;
  divergences: unknown[];
  expectedFinal: string;
  rerunFinal: string;
  resumedFinal: string;
  approximatedCalls: number;
  ms: number;
  error?: string;
}

function run(): VerifyPageResult {
  const math = Math as unknown as Record<string, (...a: number[]) => number>;
  const saved = new Map<string, (...a: number[]) => number>();
  let approximatedCalls = 0;
  for (const name of APPROXIMATED_MATH_FUNCTIONS) {
    const original = math[name]!;
    saved.set(name, original);
    math[name] = (...a: number[]) => {
      approximatedCalls++;
      return original.apply(Math, a);
    };
  }
  const started = performance.now();
  const recording = validateReplay(fixture);
  let report;
  try {
    report = verifyRecording(recording);
  } finally {
    for (const [name, original] of saved) math[name] = original;
  }
  const ms = Math.round(performance.now() - started);
  const vectors = dmathVectorDigest();
  return {
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
}

self.onmessage = () => {
  try {
    self.postMessage(run());
  } catch (e) {
    self.postMessage({ ok: false, error: e instanceof Error ? `${e.message}\n${e.stack ?? ""}` : String(e) });
  }
};
