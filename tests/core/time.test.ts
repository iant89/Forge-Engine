/**
 * @suite core:time
 * @group unit
 * @covers engine/src/core/time.ts
 * @covers engine/src/index.ts
 * @desc Phase 27.1 runtime evidence for the second approved API batch: wall, manual and scripted time
 */

export const suite = {
  name: "core:time",
  group: "unit",
  covers: ["engine/src/core/time.ts", "engine/src/index.ts"],
  desc: "Phase 27.1 runtime evidence for the second approved API batch: wall, manual and scripted time",
};

import assert from "node:assert/strict";
import {
  Clock,
  ManualClock,
  RateLimiter,
  type ClockOptions,
  type ScriptedFrame,
  type TickResult,
} from "@forge/engine";
import { finish, group, test } from "selrun";

function close(actual: number, expected: number, epsilon = 1e-10): void {
  assert.ok(Math.abs(actual - expected) <= epsilon, `expected ${actual} to be within ${epsilon} of ${expected}`);
}

group("approved wall and fixed clock", () => {
  test("uses injected wall time for variable deltas, fixed steps, interpolation and counters", () => {
    let now = 4;
    const options: ClockOptions = {
      fixedDeltaTime: 0.1,
      maxDeltaTime: 0.25,
      catchUpLimit: 5,
      timeSource: () => now,
    };
    const clock = new Clock(options);
    assert.equal(clock.fixedDeltaTime, 0.1);
    assert.equal(clock.maxDeltaTime, 0.25);
    assert.equal(clock.catchUpLimit, 5);

    now = 4.05;
    const first: TickResult = clock.tick();
    assert.equal(first.fixedSteps, 0);
    close(first.alpha, 0.5);
    close(clock.deltaTime, 0.05);
    close(clock.unscaledDeltaTime, 0.05);
    close(clock.elapsedTime, 0.05);
    close(clock.wallElapsed, 0.05);
    assert.equal(clock.frameIndex, 1);
    assert.equal(clock.fixedStepIndex, 0);

    now = 4.11;
    const second = clock.tick();
    assert.equal(second.fixedSteps, 1);
    close(second.alpha, 0.1);
    close(clock.elapsedTime, 0.11);
    close(clock.fixedTime, 0.1);
    assert.equal(clock.fixedStepIndex, 1);
    assert.equal(clock.fixedStepCount, 1);
    close(clock.fps, 1 / clock.smoothedDelta);
  });

  test("clamps, scales and pauses deltas without pausing wall time", () => {
    const clock = new ManualClock({ fixedDeltaTime: 0.1, maxDeltaTime: 0.2 });
    clock.timeScale = 2;
    assert.equal(clock.timeScale, 2);
    assert.deepEqual(clock.advance(0.05), { fixedSteps: 1, alpha: 0 });
    close(clock.deltaTime, 0.1);
    close(clock.unscaledDeltaTime, 0.05);
    close(clock.elapsedTime, 0.1);

    clock.paused = true;
    assert.deepEqual(clock.advance(0.5), { fixedSteps: 0, alpha: 0 });
    assert.equal(clock.deltaTime, 0);
    close(clock.unscaledDeltaTime, 0.2);
    close(clock.elapsedTime, 0.1);
    close(clock.wallElapsed, 0.55);

    clock.timeScale = -3;
    assert.equal(clock.timeScale, 0);
    clock.paused = false;
    assert.deepEqual(clock.advance(0.1), { fixedSteps: 0, alpha: 0 });
    clock.timeScale = 500;
    assert.equal(clock.timeScale, 100);
  });

  test("ignores backward platform samples and keeps elapsed wall time monotonic", () => {
    let now = 10;
    const clock = new Clock({ fixedDeltaTime: 1, maxDeltaTime: 1, timeSource: () => now });

    now = 10.1;
    clock.tick();
    close(clock.deltaTime, 0.1);
    close(clock.wallElapsed, 0.1);

    now = 9;
    clock.tick();
    assert.equal(clock.deltaTime, 0);
    close(clock.wallElapsed, 0.1);

    now = 10.2;
    clock.tick();
    close(clock.deltaTime, 0.1);
    close(clock.elapsedTime, 0.2);
    close(clock.wallElapsed, 0.2);
  });

  test("bounds catch-up, counts complete dropped steps and preserves fractional interpolation", () => {
    const clock = new ManualClock({ fixedDeltaTime: 0.1, maxDeltaTime: 1, catchUpLimit: 2 });

    const withinLimit = clock.advance(0.25);
    assert.equal(withinLimit.fixedSteps, 2);
    close(withinLimit.alpha, 0.5);
    assert.equal(clock.droppedSteps, 0);
    assert.equal(clock.droppedTime, 0);

    const overloaded = clock.advance(0.5);
    assert.equal(overloaded.fixedSteps, 2);
    close(overloaded.alpha, 0.5);
    assert.equal(clock.droppedSteps, 3);
    close(clock.droppedTime, 0.3);
    close(clock.fixedTime, 0.4);
    assert.equal(clock.fixedStepIndex, 4);
    close(clock.elapsedTime, 0.75);

    const fractional = new ManualClock({ fixedDeltaTime: 0.1, maxDeltaTime: 1, catchUpLimit: 2 });
    const almostOneStep = fractional.advance(0.1 - 5e-11);
    assert.equal(almostOneStep.fixedSteps, 0);
    assert.ok(almostOneStep.alpha < 1 && almostOneStep.alpha > 0.999999);
    assert.equal(fractional.droppedSteps, 0);
    assert.equal(fractional.advance(5e-11).fixedSteps, 1);
    assert.equal(fractional.droppedSteps, 0);
  });
});

group("approved deterministic and scripted clock", () => {
  test("replays scripted frames verbatim before resuming synthetic wall time", () => {
    const frames: readonly ScriptedFrame[] = [
      { dt: 0.03, fixedSteps: 2, alpha: 0.75 },
      { dt: 0.04, fixedSteps: 0, alpha: 0 },
    ];
    const clock = new ManualClock({ fixedDeltaTime: 0.1, maxDeltaTime: 1 });
    clock.paused = true;
    clock.timeScale = 0;
    clock.scriptFrames(frames);
    assert.equal(clock.scriptedFramesRemaining, 2);

    assert.deepEqual(clock.advance(3), { fixedSteps: 2, alpha: 0.75 });
    assert.equal(clock.scriptedFramesRemaining, 1);
    close(clock.deltaTime, 0.03);
    close(clock.elapsedTime, 0.03);
    close(clock.fixedTime, 0.2);
    assert.equal(clock.fixedStepIndex, 2);
    close(clock.interpolationAlpha, 0.75);
    assert.equal(clock.wallElapsed, 3);

    assert.deepEqual(clock.tick(), { fixedSteps: 0, alpha: 0 });
    assert.equal(clock.scriptedFramesRemaining, 0);
    close(clock.elapsedTime, 0.07);
    assert.equal(clock.interpolationAlpha, 0);

    clock.paused = false;
    clock.timeScale = 1;
    const resumed = clock.advance(0.05);
    assert.equal(resumed.fixedSteps, 0);
    close(resumed.alpha, 0.5);
    close(clock.deltaTime, 0.05);
  });

  test("replaces or cancels pending schedules without introducing a resume jump", () => {
    const clock = new ManualClock({ fixedDeltaTime: 0.1, maxDeltaTime: 1 });
    clock.advance(0.2);
    clock.scriptFrames([
      { dt: 1, fixedSteps: 4, alpha: 0.5 },
      { dt: 1, fixedSteps: 4, alpha: 0.5 },
    ]);
    clock.scriptFrames([{ dt: 0.02, fixedSteps: 0, alpha: 0.25 }]);
    assert.equal(clock.scriptedFramesRemaining, 1);
    clock.cancelScriptedFrames();
    assert.equal(clock.scriptedFramesRemaining, 0);

    const resumed = clock.advance(0.05);
    assert.equal(resumed.fixedSteps, 0);
    close(resumed.alpha, 0.5);
    close(clock.deltaTime, 0.05);
  });

  test("supports interpolation synchronization, bounded fixed-delta changes and forced steps", () => {
    const clock = new ManualClock({ fixedDeltaTime: 0.1, maxDeltaTime: 1 });
    clock.advance(0.075);
    close(clock.interpolationAlpha, 0.75);
    close(clock.accumulatorFraction, 0.75);

    clock.setFixedDeltaTime(0.05);
    assert.equal(clock.fixedDeltaTime, 0.05);
    assert.equal(clock.interpolationAlpha, 1);
    clock.synchronizeInterpolation();
    assert.equal(clock.interpolationAlpha, 0);
    assert.equal(clock.accumulatorFraction, 0);

    clock.setFixedDeltaTime(0);
    assert.equal(clock.fixedDeltaTime, 1 / 1000);
    clock.setFixedDeltaTime(1);
    assert.equal(clock.fixedDeltaTime, 1 / 10);

    clock.advanceFixedSteps(3, 0.25);
    close(clock.fixedTime, 0.75);
    close(clock.elapsedTime, 0.825);
    assert.equal(clock.fixedStepIndex, 3);
    assert.equal(clock.fixedStepCount, 3);
  });

  test("reset clears timing, smoothing, drop and replay state while preserving configuration", () => {
    const clock = new ManualClock({ fixedDeltaTime: 0.1, maxDeltaTime: 1, catchUpLimit: 1 });
    clock.timeScale = 0.5;
    clock.advance(0.7);
    assert.ok(clock.droppedSteps > 0);
    clock.scriptFrames([
      { dt: 0.2, fixedSteps: 1, alpha: 0.5 },
      { dt: 0.2, fixedSteps: 1, alpha: 0.5 },
    ]);
    clock.advance(0.1);
    clock.paused = true;
    clock.reset();

    close(clock.manualTime, 0.8);
    assert.equal(clock.fixedDeltaTime, 0.1);
    assert.equal(clock.maxDeltaTime, 1);
    assert.equal(clock.catchUpLimit, 1);
    assert.equal(clock.timeScale, 0.5);
    assert.equal(clock.paused, true);
    assert.equal(clock.deltaTime, 0);
    assert.equal(clock.unscaledDeltaTime, 0);
    assert.equal(clock.elapsedTime, 0);
    assert.equal(clock.fixedTime, 0);
    assert.equal(clock.wallElapsed, 0);
    assert.equal(clock.frameIndex, 0);
    assert.equal(clock.fixedStepIndex, 0);
    assert.equal(clock.droppedSteps, 0);
    assert.equal(clock.droppedTime, 0);
    assert.equal(clock.scriptedFramesRemaining, 0);
    close(clock.smoothedDelta, 1 / 60);
    assert.equal(clock.interpolationAlpha, 0);
  });
});

group("approved rate limiter", () => {
  test("fires once per observed interval, skips missed intervals and resets to a supplied time", () => {
    const limiter = new RateLimiter(0.5);
    assert.equal(limiter.intervalSeconds, 0.5);
    assert.equal(limiter.check(0), true);
    assert.equal(limiter.check(0.49), false);
    assert.equal(limiter.check(0.5), true);
    assert.equal(limiter.check(5), true);
    assert.equal(limiter.check(5.1), false);

    limiter.reset(10);
    assert.equal(limiter.check(9.99), false);
    assert.equal(limiter.check(10), true);
    limiter.intervalSeconds = 0.25;
    assert.equal(limiter.check(10.24), false);
    assert.equal(limiter.check(10.5), true);
  });
});

await finish();
