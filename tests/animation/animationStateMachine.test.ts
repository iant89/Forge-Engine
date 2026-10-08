/**
 * @suite animation:animationStateMachine
 * @group unit
 * @covers engine/src/animation/clip.ts
 * @covers engine/src/animation/component.ts
 * @covers engine/src/animation/stateMachine.ts
 * @covers engine/src/index.ts
 * @desc Animation state machine tests (Phase 16.2)
 */

export const suite = {
  name: "animation:animationStateMachine",
  group: "unit",
  covers:   [
    "engine/src/animation/clip.ts",
    "engine/src/animation/component.ts",
    "engine/src/animation/stateMachine.ts",
    "engine/src/index.ts"
  ],
  desc: "Animation state machine tests (Phase 16.2)",
};
/**
 * Animation state machine tests (Phase 16.2).
 *
 * Coverage:
 *  - State management (add, remove, start, stop)
 *  - Transition evaluation (conditions, priority, wildcard source)
 *  - Crossfade blending (weight ramp, duration, easeInOut vs linear)
 *  - Interruptible transitions (interrupt mid-crossfade)
 *  - Forced transitions (transitionTo bypassing conditions)
 *  - Parameter passing and state queries
 *  - Edge cases (missing state, same state, zero duration)
 */

import assert from "node:assert/strict";
import { assertCloseTo, beforeEach, finish, group, test } from "selrun";
import {
  AnimationComponent,
  AnimationStateMachine,
  createClip,
  type AnimationTrack,
} from "@forge/engine";

// ──────────────────────── helpers ────────────────────────

function makeTrack(
  nodeIndex: number,
  path: "translation" | "rotation" | "scale",
  times: number[],
  values: number[],
): AnimationTrack {
  return {
    nodeIndex,
    path,
    interpolation: "LINEAR",
    times: Float32Array.from(times),
    values: Float32Array.from(values),
  };
}

function setupComponent(): AnimationComponent {
  const anim = new AnimationComponent();
  anim.nodeToEntity = [10];
  anim.addClip(createClip("idle", [makeTrack(0, "translation", [0, 1], [0, 0, 0, 0, 0, 0])]));
  anim.addClip(createClip("walk", [makeTrack(0, "translation", [0, 1], [0, 0, 0, 1, 0, 0])]));
  anim.addClip(createClip("run", [makeTrack(0, "translation", [0, 1], [0, 0, 0, 2, 0, 0])]));
  anim.addClip(createClip("jump", [makeTrack(0, "translation", [0, 1], [0, 0, 0, 0, 3, 0])]));
  return anim;
}

// ──────────────────────── state management ────────────────────────

group("AnimationStateMachine — state management", () => {
  let anim: AnimationComponent;
  let sm: AnimationStateMachine;

  beforeEach(() => {
    anim = setupComponent();
    sm = new AnimationStateMachine(anim);
    sm.addState("idle", { clip: "idle", looping: true });
    sm.addState("walk", { clip: "walk", looping: true });
    sm.addState("run", { clip: "run", looping: true });
    sm.addState("jump", { clip: "jump", looping: false });
  });

  test("starts in the specified initial state", () => {
    sm.start("idle");
    assert.equal(sm.currentStateName, "idle");
    assert.equal(anim.getPlayback("idle")!.playing, true);
    assert.equal(anim.getPlayback("idle")!.weight, 1);
  });

  test("stops all clips when stopping", () => {
    sm.start("idle");
    sm.stop();
    assert.equal(sm.currentStateName, null);
    assert.equal(anim.isPlaying, false);
  });

  test("removing the current state stops the machine", () => {
    sm.start("idle");
    sm.removeState("idle");
    assert.equal(sm.currentStateName, null);
  });

  test("start with a non-existent state is a no-op", () => {
    sm.start("nonexistent");
    assert.equal(sm.currentStateName, null);
  });

  test("sets looping and speed from state config", () => {
    const sm2 = new AnimationStateMachine(anim);
    sm2.addState("run", { clip: "run", looping: true, speed: 2 });
    sm2.start("run");
    const playback = anim.getPlayback("run");
    assert.equal(playback!.looping, true);
    assert.equal(playback!.speed, 2);
  });
});

// ──────────────────────── transitions ────────────────────────

group("AnimationStateMachine — transitions", () => {
  let anim: AnimationComponent;
  let sm: AnimationStateMachine;

  beforeEach(() => {
    anim = setupComponent();
    sm = new AnimationStateMachine(anim);
    sm.addState("idle", { clip: "idle", looping: true });
    sm.addState("walk", { clip: "walk", looping: true });
    sm.addState("run", { clip: "run", looping: true });
    sm.addTransition("idle", "walk", {
      condition: (p) => (p.speed as number) > 0.1,
      crossfadeDuration: 0.25,
    });
    sm.addTransition("walk", "idle", {
      condition: (p) => (p.speed as number) < 0.1,
      crossfadeDuration: 0.3,
    });
    sm.addTransition("walk", "run", {
      condition: (p) => (p.speed as number) > 0.8,
      crossfadeDuration: 0.2,
    });
    sm.start("idle");
  });

  test("fires transition when condition is met", () => {
    sm.update(0, { speed: 0.5 });
    // Crossfade should be in progress.
    assert.notEqual(sm.crossfadeState, null);
    assert.equal(sm.crossfadeState!.from, "idle");
    assert.equal(sm.crossfadeState!.to, "walk");
  });

  test("does not fire transition when condition is not met", () => {
    sm.update(0, { speed: 0.05 });
    assert.equal(sm.currentStateName, "idle");
    assert.equal(sm.crossfadeState, null);
  });

  test("completes crossfade after duration", () => {
    sm.update(0, { speed: 0.5 }); // fire transition (0.25s crossfade)
    assert.equal(sm.currentStateName, "idle"); // still in crossfade

    sm.update(0.15, { speed: 0.5 }); // advance
    assert.notEqual(sm.crossfadeState, null);

    sm.update(0.15, { speed: 0.5 }); // complete (0.3 > 0.25)
    assert.equal(sm.currentStateName, "walk");
    assert.equal(sm.crossfadeState, null);
    assert.equal(anim.getPlayback("walk")!.weight, 1);
    assert.equal(anim.getPlayback("idle")!.playing, false);
  });

  test("evaluates transitions in priority order", () => {
    const sm2 = new AnimationStateMachine(anim);
    sm2.addState("idle", { clip: "idle", looping: true });
    sm2.addState("walk", { clip: "walk", looping: true });
    sm2.addState("run", { clip: "run", looping: true });
    // Both idle→walk and idle→run would match, but run has higher priority.
    sm2.addTransition("idle", "walk", {
      condition: () => true,
      priority: 0,
      crossfadeDuration: 0.1,
    });
    sm2.addTransition("idle", "run", {
      condition: () => true,
      priority: 10,
      crossfadeDuration: 0.1,
    });
    sm2.start("idle");
    sm2.update(0, {});
    assert.equal(sm2.crossfadeState!.to, "run");
  });

  test("supports wildcard source state", () => {
    const sm2 = new AnimationStateMachine(anim);
    sm2.addState("idle", { clip: "idle", looping: true });
    sm2.addState("walk", { clip: "walk", looping: true });
    sm2.addState("jump", { clip: "jump", looping: false });
    sm2.addTransition("*", "jump", {
      condition: (p) => p.jump === true,
      crossfadeDuration: 0.1,
      interruptible: true,
    });
    sm2.start("idle");
    sm2.update(0, { jump: true });
    assert.equal(sm2.crossfadeState!.to, "jump");
  });

  test("non-interruptible transitions cannot fire during crossfade", () => {
    sm.update(0, { speed: 0.5 }); // start idle→walk crossfade
    assert.notEqual(sm.crossfadeState, null);

    // Try to fire walk→run (condition met: speed > 0.8)
    // But the crossfade is still in progress and this transition is not interruptible.
    sm.update(0, { speed: 0.9 });
    // Should still be transitioning from idle to walk, not from walk to run.
    assert.equal(sm.crossfadeState!.from, "idle");
    assert.equal(sm.crossfadeState!.to, "walk");
  });

  test("interruptible transitions can fire during crossfade", () => {
    const sm2 = new AnimationStateMachine(anim);
    sm2.addState("idle", { clip: "idle", looping: true });
    sm2.addState("walk", { clip: "walk", looping: true });
    sm2.addState("run", { clip: "run", looping: true });
    sm2.addTransition("idle", "walk", {
      condition: (p) => (p.speed as number) > 0.1,
      crossfadeDuration: 1.0, // long crossfade
    });
    sm2.addTransition("*", "run", {
      condition: (p) => (p.speed as number) > 0.8,
      crossfadeDuration: 0.5,
      interruptible: true,
    });
    sm2.start("idle");
    sm2.update(0, { speed: 0.5 }); // start idle→walk
    assert.equal(sm2.crossfadeState!.to, "walk");

    sm2.update(0.05, { speed: 0.9 }); // interrupt to run
    assert.notEqual(sm2.crossfadeState, null);
    assert.equal(sm2.crossfadeState!.to, "run");
    assert.equal(sm2.crossfadeState!.from, "walk"); // walk was the incoming
  });

  test("removes transitions matching from/to", () => {
    sm.removeTransition("idle", "walk");
    sm.update(0, { speed: 0.5 });
    assert.equal(sm.crossfadeState, null);
    assert.equal(sm.currentStateName, "idle");
  });
});

// ──────────────────────── forced transition ────────────────────────

group("AnimationStateMachine — forced transitions", () => {
  let anim: AnimationComponent;
  let sm: AnimationStateMachine;

  beforeEach(() => {
    anim = setupComponent();
    sm = new AnimationStateMachine(anim);
    sm.addState("idle", { clip: "idle", looping: true });
    sm.addState("walk", { clip: "walk", looping: true });
    sm.start("idle");
  });

  test("transitionTo forces a state change without condition", () => {
    sm.transitionTo("walk", 0.2);
    assert.notEqual(sm.crossfadeState, null);
    assert.equal(sm.crossfadeState!.to, "walk");
  });

  test("transitionTo is a no-op when already in target state", () => {
    sm.transitionTo("idle");
    assert.equal(sm.crossfadeState, null);
  });

  test("transitionTo is a no-op for non-existent state", () => {
    sm.transitionTo("nonexistent");
    assert.equal(sm.currentStateName, "idle");
  });

  test("transitionTo is a no-op when machine is stopped", () => {
    sm.stop();
    sm.transitionTo("walk");
    assert.equal(sm.currentStateName, null);
  });
});

// ──────────────────────── debug ────────────────────────

group("AnimationStateMachine — debug", () => {
  test("reports state counts and transition counts", () => {
    const anim = setupComponent();
    const sm = new AnimationStateMachine(anim);
    sm.addState("idle", { clip: "idle" });
    sm.addState("walk", { clip: "walk" });
    sm.addTransition("idle", "walk", { condition: () => true });
    const d = sm.debug();
    assert.equal(d.stateCount, 2);
    assert.equal(d.transitionCount, 1);
    assert.equal(d.currentState, null);
    assert.equal(d.crossfadeProgress, 0);
  });

  test("reports crossfade progress", () => {
    const anim = setupComponent();
    const sm = new AnimationStateMachine(anim);
    sm.addState("idle", { clip: "idle" });
    sm.addState("walk", { clip: "walk" });
    sm.addTransition("idle", "walk", { condition: () => true, crossfadeDuration: 1.0 });
    sm.start("idle");
    sm.update(0, {});
    assert.equal(sm.debug().crossfadeProgress, 0);
    sm.update(0.5, {});
    assertCloseTo(sm.debug().crossfadeProgress, 0.5, 2);
  });
});

// ──────────────────────── edge cases ────────────────────────

group("AnimationStateMachine — edge cases", () => {
  test("update is a no-op when machine is not started", () => {
    const anim = setupComponent();
    const sm = new AnimationStateMachine(anim);
    sm.addState("idle", { clip: "idle" });
    sm.update(0.1, { speed: 0 });
    assert.equal(sm.currentStateName, null);
  });

  test("crossfade with zero duration completes immediately", () => {
    const anim = setupComponent();
    const sm = new AnimationStateMachine(anim);
    sm.addState("idle", { clip: "idle" });
    sm.addState("walk", { clip: "walk" });
    sm.addTransition("idle", "walk", { condition: () => true, crossfadeDuration: 0 });
    sm.start("idle");
    sm.update(0.016, {}); // one frame
    assert.equal(sm.currentStateName, "walk");
    assert.equal(anim.getPlayback("walk")!.weight, 1);
  });

  test("params are stored for debug access", () => {
    const anim = setupComponent();
    const sm = new AnimationStateMachine(anim);
    sm.addState("idle", { clip: "idle" });
    sm.start("idle");
    sm.update(0.016, { speed: 42, jump: true });
    assert.equal(sm.params.speed, 42);
    assert.equal(sm.params.jump, true);
  });
});

await finish();
