/**
 * Script coroutines (Phase 18.3): generator functions that span frames or fixed steps.
 *
 * ```ts
 * this.startCoroutine(function* (ctx) {
 *   yield Wait.seconds(2);                  // two seconds of the coroutine's clock
 *   while (!door.open) yield;                // one tick at a time
 *   yield Wait.until(() => player.inside);   // re-checked every tick
 *   const flash = this.startCoroutine(blink);
 *   yield flash;                             // until that coroutine ends (any way)
 * });
 * ```
 *
 * - **Start.** The body runs immediately, up to its first `yield`, inside the caller's call. Each
 *   resume receives a fresh {@link ScriptContext} as the value of the `yield` expression.
 * - **Clocks.** `"render"` (default) advances once per frame at the start of the update phase, after
 *   due render timers and before onUpdate; `Wait.seconds` counts frame `dt`. `"sim"` advances once per
 *   fixed step, after due sim timers and before onFixedUpdate; `Wait.seconds` is converted to whole
 *   fixed steps when yielded (rounded up), so sim coroutines are deterministic like sim timers.
 *   Coroutines of one clock advance in start order.
 * - **Waits.** A bare `yield` resumes on the next tick. `Wait.seconds(s)`, `Wait.steps(n)` (sim),
 *   `Wait.frames(n)` (render), `Wait.until(pred)`, `Wait.while(pred)`, or a {@link CoroutineHandle}
 *   (resumes once that coroutine has finished, been cancelled or failed). Predicates run every tick.
 * - **Pause/resume.** `pause()` freezes the coroutine where it is: its wait stops counting and its
 *   predicate is not evaluated. `resume()` continues from the same point with the time left.
 * - **Cancellation.** `cancel()` stops it and runs its `finally` blocks (the generator's `return`).
 *   Coroutines are cancelled when their script is destroyed or faulted, or by `stopCoroutines()`.
 *   Cancelling the running coroutine from inside itself takes effect when it next yields.
 * - **Ownership and isolation.** A coroutine advances only while its script is active and enabled
 *   (waits do not count down otherwise). A throw inside the body or a predicate fails the coroutine
 *   and counts as its script's error (phase "coroutine"), with the step's structural changes rolled
 *   back like a hook's.
 */

import type { ScriptContext } from "./script.js";

export type CoroutineClock = "render" | "sim";
export type CoroutineState = "running" | "paused" | "done" | "cancelled" | "failed";

/** What a coroutine body may yield. */
export type CoroutineYield = void | undefined | WaitInstruction | CoroutineHandle;

export type CoroutineBody = (context: ScriptContext) => Generator<CoroutineYield, void, ScriptContext>;

export interface CoroutineOptions {
  /** Which clock advances it (default "render"). */
  clock?: CoroutineClock;
  /** Name used in errors. */
  name?: string;
}

export interface CoroutineHandle {
  readonly clock: CoroutineClock;
  readonly state: CoroutineState;
  /** True while running or paused. */
  readonly alive: boolean;
  readonly name: string;
  pause(): void;
  resume(): void;
  cancel(): void;
}

export type WaitInstruction =
  | { readonly kind: "seconds"; readonly seconds: number }
  | { readonly kind: "steps"; readonly steps: number }
  | { readonly kind: "frames"; readonly frames: number }
  | { readonly kind: "until"; readonly predicate: () => boolean }
  | { readonly kind: "while"; readonly predicate: () => boolean };

/** Wait instructions to `yield` from a coroutine. */
export const Wait = Object.freeze({
  /** Seconds of the coroutine's clock (sim: whole fixed steps, rounded up). */
  seconds: (seconds: number): WaitInstruction => ({ kind: "seconds", seconds }),
  /** Exact fixed steps (sim coroutines only). */
  steps: (steps: number): WaitInstruction => ({ kind: "steps", steps }),
  /** Exact frames (render coroutines only). */
  frames: (frames: number): WaitInstruction => ({ kind: "frames", frames }),
  /** Until `predicate()` is true; checked every tick, first on the next one. */
  until: (predicate: () => boolean): WaitInstruction => ({ kind: "until", predicate }),
  /** While `predicate()` is true; checked every tick, first on the next one. */
  while: (predicate: () => boolean): WaitInstruction => ({ kind: "while", predicate }),
});

/** @internal One running generator and its current wait. */
export class Coroutine implements CoroutineHandle {
  state: CoroutineState = "running";
  /** True while its body or predicate is executing (re-entrancy guard). */
  executing = false;
  cancelRequested = false;
  /** Current wait: remaining ticks/seconds, a predicate, or another coroutine. */
  waitKind: "tick" | "seconds" | "ticks" | "until" | "while" | "handle" = "tick";
  waitAmount = 0;
  waitPredicate: (() => boolean) | null = null;
  waitHandle: CoroutineHandle | null = null;

  constructor(
    readonly owner: object,
    readonly clock: CoroutineClock,
    readonly name: string,
    readonly generator: Generator<CoroutineYield, void, ScriptContext>,
    readonly seq: number,
    private readonly host: { _cancelCoroutine(c: Coroutine): void },
  ) {}

  get alive(): boolean {
    return this.state === "running" || this.state === "paused";
  }

  pause(): void {
    if (this.state === "running") this.state = "paused";
  }

  resume(): void {
    if (this.state === "paused") this.state = "running";
  }

  cancel(): void {
    if (!this.alive) return;
    if (this.executing) {
      this.cancelRequested = true;
      return;
    }
    this.host._cancelCoroutine(this);
  }
}
