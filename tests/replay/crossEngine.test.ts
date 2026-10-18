/**
 * @suite replay:crossEngine
 * @group integration
 * @covers examples/src/replay/verificationSession.ts
 * @covers examples/src/replay/vehicle-session.replay.json
 * @covers engine/src/math/detmath.ts
 * @covers engine/src/core/snapshot.ts
 * @covers engine/src/scene/snapshot.ts
 * @covers engine/src/replay/session.ts
 * @covers engine/src/replay/hash.ts
 * @covers engine/src/vehicles/*.ts
 * @covers engine/src/physics/*.ts
 * @covers engine/src/environment/atmosphere.ts
 * @covers engine/src/environment/dayNight.ts
 * @covers engine/src/environment/lightning.ts
 * @covers engine/src/environment/moistureField.ts
 * @covers engine/src/environment/snowMelt.ts
 * @covers engine/src/environment/solar.ts
 * @covers engine/src/environment/surfaceWeather.ts
 * @covers engine/src/environment/weather.ts
 * @covers engine/src/math/mat.ts
 * @covers engine/src/math/rng.ts
 * @covers engine/src/math/vec.ts
 * @covers engine/src/terrain/track.ts
 * @covers engine/src/terrain/trackWeather.ts
 * @desc Phase 19.5 exit criterion: a complete vehicle session (track terrain, weather-driven ground, rain, storm with lightning, snow, day/night, a physics chassis hitting crates, a reverse manoeuvre) is recorded, saved mid-run and replayed to the committed recording's every state hash, re-recording it reproduces the fixture exactly, and the simulation calls no engine-dependent Math function — the same fixture check:replay-engines replays under JavaScriptCore
 */

export const suite = {
  name: "replay:crossEngine",
  group: "integration",
  covers: [
    "examples/src/replay/verificationSession.ts",
    "examples/src/replay/vehicle-session.replay.json",
    "engine/src/math/detmath.ts",
    "engine/src/core/snapshot.ts",
    "engine/src/scene/snapshot.ts",
    "engine/src/replay/session.ts",
    "engine/src/replay/hash.ts",
    "engine/src/vehicles/*.ts",
    "engine/src/physics/*.ts",
    "engine/src/environment/atmosphere.ts",
    "engine/src/environment/dayNight.ts",
    "engine/src/environment/lightning.ts",
    "engine/src/environment/moistureField.ts",
    "engine/src/environment/snowMelt.ts",
    "engine/src/environment/solar.ts",
    "engine/src/environment/surfaceWeather.ts",
    "engine/src/environment/weather.ts",
    "engine/src/math/mat.ts",
    "engine/src/math/rng.ts",
    "engine/src/math/vec.ts",
    "engine/src/terrain/track.ts",
    "engine/src/terrain/trackWeather.ts",
  ],
  desc: "Phase 19.5 exit criterion: a complete vehicle session (track terrain, weather-driven ground, rain, storm with lightning, snow, day/night, a physics chassis hitting crates, a reverse manoeuvre) is recorded, saved mid-run and replayed to the committed recording's every state hash, re-recording it reproduces the fixture exactly, and the simulation calls no engine-dependent Math function — the same fixture check:replay-engines replays under JavaScriptCore",
};

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { finish, group, test } from "selrun";
import { APPROXIMATED_MATH_FUNCTIONS, LightningSystem, validateReplay, type ReplayRecording } from "@forge/engine";
import { VERIFY_FRAMES, VERIFY_RESUME_FRAME, recordVerificationSession, verifyRecording } from "../../examples/src/replay/verificationSession.js";

const FIXTURE = validateReplay(JSON.parse(readFileSync(new URL("../../examples/src/replay/vehicle-session.replay.json", import.meta.url), "utf8")));

/** Run `body` counting calls to the Math functions ECMAScript leaves implementation-approximated. */
function countingApproximatedMath<T>(body: () => T): { value: T; calls: Record<string, number> } {
  const math = Math as unknown as Record<string, (...a: number[]) => number>;
  const saved = new Map<string, (...a: number[]) => number>();
  const calls: Record<string, number> = {};
  for (const name of APPROXIMATED_MATH_FUNCTIONS) {
    const original = math[name]!;
    saved.set(name, original);
    math[name] = (...a: number[]) => {
      calls[name] = (calls[name] ?? 0) + 1;
      return original.apply(Math, a);
    };
  }
  try {
    return { value: body(), calls };
  } finally {
    for (const [name, original] of saved) math[name] = original;
  }
}

let recorded: ReturnType<typeof recordVerificationSession> | null = null;
let recordCalls: Record<string, number> = {};
function record(): ReturnType<typeof recordVerificationSession> {
  if (!recorded) {
    const r = countingApproximatedMath(() => recordVerificationSession(VERIFY_FRAMES));
    recorded = r.value;
    recordCalls = r.calls;
  }
  return recorded;
}

group("the session", () => {
  test("is a complete vehicle session: it drives, reverses, hits crates and runs rain, a storm with lightning and snow", () => {
    const { session } = record();
    const v = session.vehicle;
    assert.ok(v.distance > 150, `drove ${v.distance.toFixed(0)} m`);
    assert.equal(session.driver.manoeuvre, "done", "the stop / reverse / drive-on manoeuvre completed");
    assert.ok(v.config.transmission.shiftCount >= 2, "it shifted into reverse and back");
    const lightning = session.scene.object("lightning") as LightningSystem;
    assert.ok(lightning.strikeCount > 3, `${lightning.strikeCount} strikes in the storm`);
    assert.ok(session.weather.state.temperatureC < 0 && session.weather.surface.snow > 0, "it ends in snow");
    assert.ok(session.weather.surface.wetness > 0.2, "the rain wetted the surface");
    const moved = session.crates.map((c, k) => Math.abs(c.body!.position.x - session.crateStarts[k]!.x) + Math.abs(c.body!.position.z - session.crateStarts[k]!.z));
    assert.ok(moved.filter((d) => d > 1).length >= 2, `the car knocked crates aside (moved ${moved.map((d) => d.toFixed(1)).join(", ")} m)`);
    assert.ok(FIXTURE.frames.some((f) => f[1] === 0) && FIXTURE.frames.some((f) => f[1] >= 2), "the frame schedule mixes empty and multi-step frames");
  });

  test("makes no call to an engine-dependent Math function, so its state is a pure function of its input on every engine", () => {
    record();
    assert.deepEqual(recordCalls, {}, "building, settling and recording the session");
    const { calls } = countingApproximatedMath(() => verifyRecording(FIXTURE));
    assert.deepEqual(calls, {}, "playback, re-run and resume");
  });
});

group("the committed recording (the cross-engine contract)", () => {
  test("re-recording the session reproduces the fixture exactly: schedule, input and every checkpoint hash", () => {
    const { recording } = record();
    const fresh = JSON.parse(JSON.stringify(recording)) as ReplayRecording;
    assert.deepEqual(fresh.frames, FIXTURE.frames);
    assert.deepEqual(fresh.initial, FIXTURE.initial);
    assert.deepEqual(fresh.checkpoints, FIXTURE.checkpoints);
    assert.deepEqual(fresh.final, FIXTURE.final, "regenerate with `npm run check:replay-engines -- --write-fixture` only for a deliberate simulation change");
    assert.equal(FIXTURE.frames.length, VERIFY_FRAMES);
    assert.equal(FIXTURE.checkpoints.length, VERIFY_FRAMES / 60, "a checkpoint every 60 frames");
  });

  test("replays to every checkpoint, re-runs live to the final hash, and a save part-way resumes to it (19.1–19.4 together)", () => {
    const report = verifyRecording(FIXTURE);
    assert.deepEqual(report.playback.divergences, []);
    assert.ok(report.playback.ok && report.playback.finished);
    assert.equal(report.playback.framesPlayed, VERIFY_FRAMES);
    assert.equal(report.playback.checkpointsCompared, FIXTURE.checkpoints.length + 1);
    assert.equal(report.rerunFinal, FIXTURE.final.hash);
    assert.equal(report.resumedFinal, FIXTURE.final.hash, `resumed from frame ${VERIFY_RESUME_FRAME}`);
    assert.ok(report.ok);
  });

  test("a tampered input in the recording is caught at the next checkpoint", () => {
    const tampered = JSON.parse(JSON.stringify(FIXTURE)) as ReplayRecording;
    const at = tampered.frames.findIndex((f, i) => i > 300 && f.length === 4);
    const change = (tampered.frames[at] as [number, number, number, number[][]])[3][0]!;
    change[2] = change[2]! + 0.05; // brake
    const report = verifyRecording(tampered);
    assert.equal(report.ok, false);
    const first = report.playback.divergences[0]!;
    assert.equal(first.kind, "checkpoint");
    assert.equal(first.frame, FIXTURE.checkpoints.find((c) => c.frame >= at)!.frame);
    assert.ok(first.parts.includes("vehicles"), first.parts.join(","));
  });
});

await finish();
