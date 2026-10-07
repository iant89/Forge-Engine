/**
 * Animation state machine — manages named states, transitions, and crossfade blending.
 *
 * The state machine is a high-level controller that sits on top of `AnimationComponent`. It does
 * not sample clips or apply transforms — that is the system's job. Instead it:
 *
 *  1. Defines named states, each backed by a clip (with looping/speed).
 *  2. Defines transitions between states with conditions and crossfade durations.
 *  3. Each frame, evaluates parameter-driven conditions and fires transitions.
 *  4. Manages crossfade: starts the new clip, ramps weights over the transition duration.
 *
 * Determinism: transition evaluation reads parameters in insertion order (Map order, stable in
 * modern JS); crossfade time advances by `dt` only. No RNG.
 *
 * Usage:
 * ```ts
 * const sm = new AnimationStateMachine(animComponent);
 * sm.addState("idle", { clip: idleClip, looping: true });
 * sm.addState("walk", { clip: walkClip, looping: true });
 * sm.addTransition("idle", "walk", { condition: (p) => p.speed > 0.1, crossfadeDuration: 0.25 });
 * sm.addTransition("walk", "idle", { condition: (p) => p.speed < 0.1, crossfadeDuration: 0.3 });
 * sm.start("idle");
 * // Each frame:
 * sm.update(dt, { speed: currentSpeed });
 * ```
 */

import type { AnimationComponent } from "./component.js";

/** Parameters dictionary — keys are string names, values are numbers, booleans or strings. */
export type AnimationParams = Record<string, number | boolean | string>;

/** Condition function that evaluates against the current parameters. */
export type TransitionCondition = (params: AnimationParams) => boolean;

/** Configuration for a state in the state machine. */
export interface AnimationStateConfig {
  /** The clip name (must exist on the AnimationComponent). */
  clip: string;
  /** Whether the clip loops (default: false). */
  looping?: boolean;
  /** Playback speed multiplier (default: 1). */
  speed?: number;
}

/** Configuration for a transition between two states. */
export interface TransitionConfig {
  /** Condition function — when this returns true and the source state is active, the transition fires. */
  condition: TransitionCondition;
  /** Crossfade duration in seconds (default: 0.25). */
  crossfadeDuration?: number;
  /** Whether this transition can interrupt an in-progress crossfade (default: false). */
  interruptible?: boolean;
  /** Priority — higher-priority transitions are evaluated first; ties use insertion order (default: 0). */
  priority?: number;
  /** Fixed blend curve: if true, the crossfade uses a linear ramp; if false (default), ease-in-out. */
  linear?: boolean;
}

/** Internal transition entry with resolved defaults. */
interface Transition {
  from: string;
  to: string;
  condition: TransitionCondition;
  crossfadeDuration: number;
  interruptible: boolean;
  priority: number;
  linear: boolean;
}

/** Internal state entry. */
interface StateEntry {
  config: AnimationStateConfig;
  /** The clip name resolved to the component's clip map. */
  clipName: string;
}

/** Crossfade state when a transition is in progress. */
interface CrossfadeState {
  /** The state we're transitioning from. */
  from: string;
  /** The state we're transitioning to. */
  to: string;
  /** Elapsed crossfade time. */
  elapsed: number;
  /** Total crossfade duration. */
  duration: number;
  /** Whether to use linear blend curve. */
  linear: boolean;
}

/**
 * Animation state machine.
 *
 * Owns a reference to an `AnimationComponent` and drives its clip playback / blend weights.
 * The state machine is updated once per frame (typically by the animation system or a gameplay
 * script).
 */
export class AnimationStateMachine {
  private readonly component: AnimationComponent;
  private states = new Map<string, StateEntry>();
  private transitions: Transition[] = [];
  private currentState: string | null = null;
  private crossfade: CrossfadeState | null = null;
  private _currentParams: AnimationParams = {};

  /** Read-only access to current state for debugging / HUD. */
  get currentStateName(): string | null { return this.currentState; }

  /** Read-only access to crossfade state for debugging. */
  get crossfadeState(): Readonly<CrossfadeState> | null { return this.crossfade; }

  /** The current parameters (last update's). */
  get params(): Readonly<AnimationParams> { return this._currentParams; }

  constructor(component: AnimationComponent) {
    this.component = component;
  }

  /**
   * Add a named state backed by a clip.
   *
   * The clip must already be added to the AnimationComponent. If it isn't, this is a no-op
   * (the transition will never fire because the clip won't play).
   */
  addState(name: string, config: AnimationStateConfig): void {
    this.states.set(name, { config, clipName: config.clip });
    // Ensure the clip exists on the component with the right looping/speed defaults.
    const playback = this.component.getPlayback(config.clip);
    if (playback) {
      playback.looping = config.looping ?? false;
      playback.speed = config.speed ?? 1;
    }
  }

  /** Remove a state. If it's the current state, the machine stops. */
  removeState(name: string): void {
    this.states.delete(name);
    if (this.currentState === name) {
      this.stop();
    }
    // Remove transitions involving this state.
    this.transitions = this.transitions.filter((t) => t.from !== name && t.to !== name);
  }

  /**
   * Add a transition between two states.
   *
   * Transitions are evaluated in priority order (highest first), then insertion order.
   * The first transition whose condition returns true fires.
   */
  addTransition(from: string, to: string, config: TransitionConfig): void {
    const transition: Transition = {
      from,
      to,
      condition: config.condition,
      crossfadeDuration: config.crossfadeDuration ?? 0.25,
      interruptible: config.interruptible ?? false,
      priority: config.priority ?? 0,
      linear: config.linear ?? false,
    };
    // Insert in sorted order (highest priority first, preserving insertion order for ties).
    let inserted = false;
    for (let i = 0; i < this.transitions.length; i++) {
      if (transition.priority > this.transitions[i]!.priority) {
        this.transitions.splice(i, 0, transition);
        inserted = true;
        break;
      }
    }
    if (!inserted) this.transitions.push(transition);
  }

  /**
   * Remove all transitions matching the given from/to pair.
   * Pass `undefined` for either to match any value (wildcard).
   */
  removeTransition(from?: string, to?: string): void {
    this.transitions = this.transitions.filter((t) => {
      if (from !== undefined && t.from !== from) return true;
      if (to !== undefined && t.to !== to) return true;
      return false;
    });
  }

  /**
   * Start the state machine in a given state.
   *
   * Resets all clip playback and begins playing the initial state's clip at full weight.
   */
  start(initialState: string): void {
    const state = this.states.get(initialState);
    if (!state) return;

    this.component.stopAll();
    this.currentState = initialState;
    this.crossfade = null;

    const playback = this.component.getPlayback(state.clipName);
    if (playback) {
      playback.weight = 1;
      playback.looping = state.config.looping ?? false;
      playback.speed = state.config.speed ?? 1;
      this.component.play(state.clipName);
    }
  }

  /** Stop the state machine — stops all clips and clears state. */
  stop(): void {
    this.component.stopAll();
    this.currentState = null;
    this.crossfade = null;
  }

  /**
   * Update the state machine: evaluate transitions and advance crossfade.
   *
   * Call this once per frame with the frame's `dt` and current gameplay parameters.
   */
  update(dt: number, params: AnimationParams): void {
    this._currentParams = params;

    if (!this.currentState) return;

    // Evaluate transitions.
    this.evaluateTransitions(params);

    // Advance crossfade.
    if (this.crossfade) {
      this.advanceCrossfade(dt);
    }
  }

  /**
   * Force a transition to a target state, bypassing the condition check.
   *
   * Useful for gameplay events that need immediate state changes (e.g., "death" on hit).
   */
  transitionTo(targetState: string, crossfadeDuration = 0.25, linear = false): void {
    if (!this.currentState || this.currentState === targetState) return;
    if (!this.states.has(targetState)) return;

    this.beginCrossfade(targetState, crossfadeDuration, linear);
  }

  /** Get a snapshot of the state machine for debugging / HUD. */
  debug(): {
    currentState: string | null;
    crossfadeFrom: string | null;
    crossfadeTo: string | null;
    crossfadeProgress: number;
    stateCount: number;
    transitionCount: number;
  } {
    return {
      currentState: this.currentState,
      crossfadeFrom: this.crossfade?.from ?? null,
      crossfadeTo: this.crossfade?.to ?? null,
      crossfadeProgress: this.crossfade ? Math.min(this.crossfade.elapsed / this.crossfade.duration, 1) : 0,
      stateCount: this.states.size,
      transitionCount: this.transitions.length,
    };
  }

  // ──────────────────────── internals ────────────────────────

  private evaluateTransitions(params: AnimationParams): void {
    for (const transition of this.transitions) {
      // Check if the transition applies to the current state (or is a wildcard).
      if (transition.from !== "*" && transition.from !== this.currentState) continue;

      // If a crossfade is in progress, only interruptible transitions can fire.
      if (this.crossfade && !transition.interruptible) continue;

      // Evaluate the condition.
      if (!transition.condition(params)) continue;

      // Fire the transition.
      this.beginCrossfade(
        transition.to,
        transition.crossfadeDuration,
        transition.linear,
      );
      break; // First matching transition wins.
    }
  }

  private beginCrossfade(targetState: string, duration: number, linear: boolean): void {
    if (!this.currentState) return;
    const target = this.states.get(targetState);
    if (!target) return;

    const outgoingState = this.currentState;

    // If there's an existing crossfade, the outgoing state is whatever was incoming.
    const actualOutgoing = this.crossfade ? this.crossfade.to : outgoingState;

    // Set up the crossfade.
    this.crossfade = {
      from: actualOutgoing,
      to: targetState,
      elapsed: 0,
      duration: Math.max(duration, 0.001), // avoid division by zero
      linear,
    };

    // Start the incoming clip.
    const incomingPlayback = this.component.getPlayback(target.clipName);
    if (incomingPlayback) {
      incomingPlayback.weight = 0;
      incomingPlayback.looping = target.config.looping ?? false;
      incomingPlayback.speed = target.config.speed ?? 1;
      incomingPlayback.time = 0;
      this.component.play(target.clipName);
    }
  }

  private advanceCrossfade(dt: number): void {
    const cf = this.crossfade!;
    cf.elapsed += dt;
    const t = Math.min(cf.elapsed / cf.duration, 1);

    // Compute blend factor (linear or ease-in-out).
    const alpha = cf.linear ? t : easeInOut(t);

    // Set weights on the two clips.
    const fromState = this.states.get(cf.from);
    const toState = this.states.get(cf.to);

    if (fromState) {
      const playback = this.component.getPlayback(fromState.clipName);
      if (playback) playback.weight = 1 - alpha;
    }
    if (toState) {
      const playback = this.component.getPlayback(toState.clipName);
      if (playback) playback.weight = alpha;
    }

    // Crossfade complete.
    if (t >= 1) {
      // Stop the outgoing clip.
      if (fromState) {
        this.component.stop(fromState.clipName);
      }
      // Ensure incoming clip is at full weight.
      if (toState) {
        const playback = this.component.getPlayback(toState.clipName);
        if (playback) playback.weight = 1;
      }
      this.currentState = cf.to;
      this.crossfade = null;
    }
  }
}

/**
 * Ease-in-out curve: slow at the start and end, fast in the middle.
 * `t` ∈ [0, 1] → [0, 1]. Standard smoothstep.
 */
function easeInOut(t: number): number {
  return t * t * (3 - 2 * t);
}