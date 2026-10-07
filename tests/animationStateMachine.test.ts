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

import { describe, expect, it, beforeEach } from "vitest";
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

describe("AnimationStateMachine — state management", () => {
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

  it("starts in the specified initial state", () => {
    sm.start("idle");
    expect(sm.currentStateName).toBe("idle");
    expect(anim.getPlayback("idle")!.playing).toBe(true);
    expect(anim.getPlayback("idle")!.weight).toBe(1);
  });

  it("stops all clips when stopping", () => {
    sm.start("idle");
    sm.stop();
    expect(sm.currentStateName).toBeNull();
    expect(anim.isPlaying).toBe(false);
  });

  it("removing the current state stops the machine", () => {
    sm.start("idle");
    sm.removeState("idle");
    expect(sm.currentStateName).toBeNull();
  });

  it("start with a non-existent state is a no-op", () => {
    sm.start("nonexistent");
    expect(sm.currentStateName).toBeNull();
  });

  it("sets looping and speed from state config", () => {
    const sm2 = new AnimationStateMachine(anim);
    sm2.addState("run", { clip: "run", looping: true, speed: 2 });
    sm2.start("run");
    const playback = anim.getPlayback("run");
    expect(playback!.looping).toBe(true);
    expect(playback!.speed).toBe(2);
  });
});

// ──────────────────────── transitions ────────────────────────

describe("AnimationStateMachine — transitions", () => {
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

  it("fires transition when condition is met", () => {
    sm.update(0, { speed: 0.5 });
    // Crossfade should be in progress.
    expect(sm.crossfadeState).not.toBeNull();
    expect(sm.crossfadeState!.from).toBe("idle");
    expect(sm.crossfadeState!.to).toBe("walk");
  });

  it("does not fire transition when condition is not met", () => {
    sm.update(0, { speed: 0.05 });
    expect(sm.currentStateName).toBe("idle");
    expect(sm.crossfadeState).toBeNull();
  });

  it("completes crossfade after duration", () => {
    sm.update(0, { speed: 0.5 }); // fire transition (0.25s crossfade)
    expect(sm.currentStateName).toBe("idle"); // still in crossfade

    sm.update(0.15, { speed: 0.5 }); // advance
    expect(sm.crossfadeState).not.toBeNull();

    sm.update(0.15, { speed: 0.5 }); // complete (0.3 > 0.25)
    expect(sm.currentStateName).toBe("walk");
    expect(sm.crossfadeState).toBeNull();
    expect(anim.getPlayback("walk")!.weight).toBe(1);
    expect(anim.getPlayback("idle")!.playing).toBe(false);
  });

  it("evaluates transitions in priority order", () => {
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
    expect(sm2.crossfadeState!.to).toBe("run");
  });

  it("supports wildcard source state", () => {
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
    expect(sm2.crossfadeState!.to).toBe("jump");
  });

  it("non-interruptible transitions cannot fire during crossfade", () => {
    sm.update(0, { speed: 0.5 }); // start idle→walk crossfade
    expect(sm.crossfadeState).not.toBeNull();

    // Try to fire walk→run (condition met: speed > 0.8)
    // But the crossfade is still in progress and this transition is not interruptible.
    sm.update(0, { speed: 0.9 });
    // Should still be transitioning from idle to walk, not from walk to run.
    expect(sm.crossfadeState!.from).toBe("idle");
    expect(sm.crossfadeState!.to).toBe("walk");
  });

  it("interruptible transitions can fire during crossfade", () => {
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
    expect(sm2.crossfadeState!.to).toBe("walk");

    sm2.update(0.05, { speed: 0.9 }); // interrupt to run
    expect(sm2.crossfadeState).not.toBeNull();
    expect(sm2.crossfadeState!.to).toBe("run");
    expect(sm2.crossfadeState!.from).toBe("walk"); // walk was the incoming
  });

  it("removes transitions matching from/to", () => {
    sm.removeTransition("idle", "walk");
    sm.update(0, { speed: 0.5 });
    expect(sm.crossfadeState).toBeNull();
    expect(sm.currentStateName).toBe("idle");
  });
});

// ──────────────────────── forced transition ────────────────────────

describe("AnimationStateMachine — forced transitions", () => {
  let anim: AnimationComponent;
  let sm: AnimationStateMachine;

  beforeEach(() => {
    anim = setupComponent();
    sm = new AnimationStateMachine(anim);
    sm.addState("idle", { clip: "idle", looping: true });
    sm.addState("walk", { clip: "walk", looping: true });
    sm.start("idle");
  });

  it("transitionTo forces a state change without condition", () => {
    sm.transitionTo("walk", 0.2);
    expect(sm.crossfadeState).not.toBeNull();
    expect(sm.crossfadeState!.to).toBe("walk");
  });

  it("transitionTo is a no-op when already in target state", () => {
    sm.transitionTo("idle");
    expect(sm.crossfadeState).toBeNull();
  });

  it("transitionTo is a no-op for non-existent state", () => {
    sm.transitionTo("nonexistent");
    expect(sm.currentStateName).toBe("idle");
  });

  it("transitionTo is a no-op when machine is stopped", () => {
    sm.stop();
    sm.transitionTo("walk");
    expect(sm.currentStateName).toBeNull();
  });
});

// ──────────────────────── debug ────────────────────────

describe("AnimationStateMachine — debug", () => {
  it("reports state counts and transition counts", () => {
    const anim = setupComponent();
    const sm = new AnimationStateMachine(anim);
    sm.addState("idle", { clip: "idle" });
    sm.addState("walk", { clip: "walk" });
    sm.addTransition("idle", "walk", { condition: () => true });
    const d = sm.debug();
    expect(d.stateCount).toBe(2);
    expect(d.transitionCount).toBe(1);
    expect(d.currentState).toBeNull();
    expect(d.crossfadeProgress).toBe(0);
  });

  it("reports crossfade progress", () => {
    const anim = setupComponent();
    const sm = new AnimationStateMachine(anim);
    sm.addState("idle", { clip: "idle" });
    sm.addState("walk", { clip: "walk" });
    sm.addTransition("idle", "walk", { condition: () => true, crossfadeDuration: 1.0 });
    sm.start("idle");
    sm.update(0, {});
    expect(sm.debug().crossfadeProgress).toBe(0);
    sm.update(0.5, {});
    expect(sm.debug().crossfadeProgress).toBeCloseTo(0.5, 2);
  });
});

// ──────────────────────── edge cases ────────────────────────

describe("AnimationStateMachine — edge cases", () => {
  it("update is a no-op when machine is not started", () => {
    const anim = setupComponent();
    const sm = new AnimationStateMachine(anim);
    sm.addState("idle", { clip: "idle" });
    sm.update(0.1, { speed: 0 });
    expect(sm.currentStateName).toBeNull();
  });

  it("crossfade with zero duration completes immediately", () => {
    const anim = setupComponent();
    const sm = new AnimationStateMachine(anim);
    sm.addState("idle", { clip: "idle" });
    sm.addState("walk", { clip: "walk" });
    sm.addTransition("idle", "walk", { condition: () => true, crossfadeDuration: 0 });
    sm.start("idle");
    sm.update(0.016, {}); // one frame
    expect(sm.currentStateName).toBe("walk");
    expect(anim.getPlayback("walk")!.weight).toBe(1);
  });

  it("params are stored for debug access", () => {
    const anim = setupComponent();
    const sm = new AnimationStateMachine(anim);
    sm.addState("idle", { clip: "idle" });
    sm.start("idle");
    sm.update(0.016, { speed: 42, jump: true });
    expect(sm.params.speed).toBe(42);
    expect(sm.params.jump).toBe(true);
  });
});