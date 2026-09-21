/**
 * Time keeping and the fixed/variable timestep split.
 *
 * `Clock` produces *two* clocks (see docs/PHYSICS.md#timestep):
 *  - a **variable** clock driving presentation, cameras, UI and scripts (`deltaTime`)
 *  - a **fixed** clock driving simulation (`fixedDeltaTime`, integral counts)
 *
 * The fixed clock is derived from the accumulated wall time, not from frame count, so the
 * simulation is frame-rate independent; the count of fixed steps executed is what makes replays
 * and tests reproducible. `catchUpLimit` bounds a death spiral when the tab stalls (e.g. a long
 * GC or an editor breakpoint) — extra time is discarded and reported as `droppedSteps`.
 */

import { clamp } from "../math/scalar.js";

export interface TickResult {
  /** number of fixed steps to execute this frame */
  fixedSteps: number;
  /** interpolation factor for rendering between the last two fixed states, in [0, 1] */
  alpha: number;
}

export interface ClockOptions {
  fixedDeltaTime?: number;
  maxDeltaTime?: number;
  catchUpLimit?: number;
  /** Use a synthetic clock (tests, replays, deterministic headless runs). */
  timeSource?: () => number;
}

export class Clock {
  /** Seconds between simulation steps. */
  fixedDeltaTime: number;
  /** Values above this are clamped (tab switch, breakpoints). */
  maxDeltaTime: number;
  /** Max fixed steps executed per frame; the rest of the accumulated time is dropped. */
  catchUpLimit: number;

  private readonly timeSource: () => number;
  private lastTime: number;
  private accumulator = 0;

  private _deltaTime = 0;
  private _unscaledDeltaTime = 0;
  private _elapsedTime = 0;
  private _fixedTime = 0;
  private _frameIndex = 0;
  private _fixedStepIndex = 0;
  private _timeScale = 1;
  private _paused = false;
  private _droppedSteps = 0;
  private _droppedTime = 0;
  private _smoothedDelta = 1 / 60;
  private _startWallTime: number;
  /** Real seconds elapsed regardless of pausing/scaling — used by the profiler's frame graph. */
  private _wallClockElapsed = 0;

  constructor(options: ClockOptions = {}) {
    this.fixedDeltaTime = options.fixedDeltaTime ?? 1 / 60;
    this.maxDeltaTime = options.maxDeltaTime ?? 0.25;
    this.catchUpLimit = options.catchUpLimit ?? 5;
    this.timeSource = options.timeSource ?? defaultTimeSource;
    this.lastTime = this.timeSource();
    this._startWallTime = this.lastTime;
  }

  /** Simulation seconds since engine start (paused time does not advance). */
  get elapsedTime(): number {
    return this._elapsedTime;
  }

  /** Seconds advanced by the fixed simulation clock (always a multiple of fixedDeltaTime). */
  get fixedTime(): number {
    return this._fixedTime;
  }

  /** Wall-clock seconds since construction (never paused or scaled). */
  get wallElapsed(): number {
    return this._wallClockElapsed;
  }

  /** Delta for the current frame, already scaled and clamped. */
  get deltaTime(): number {
    return this._deltaTime;
  }

  /** Delta before `timeScale`, for editor UI and slow-motion tooling. */
  get unscaledDeltaTime(): number {
    return this._unscaledDeltaTime;
  }

  /** Exponentially smoothed delta — better than raw delta for readouts and damping. */
  get smoothedDelta(): number {
    return this._smoothedDelta;
  }

  get fps(): number {
    return this._smoothedDelta > 1e-6 ? 1 / this._smoothedDelta : 0;
  }

  get frameIndex(): number {
    return this._frameIndex;
  }

  get fixedStepIndex(): number {
    return this._fixedStepIndex;
  }

  get timeScale(): number {
    return this._timeScale;
  }

  set timeScale(v: number) {
    this._timeScale = clamp(v, 0, 100);
  }

  get paused(): boolean {
    return this._paused;
  }

  set paused(v: boolean) {
    this._paused = v;
  }

  get fixedStepCount(): number {
    return this._fixedStepIndex;
  }

  /** Fixed steps discarded due to `catchUpLimit` — non-zero means the machine can't keep up. */
  get droppedSteps(): number {
    return this._droppedSteps;
  }

  get droppedTime(): number {
    return this._droppedTime;
  }

  /**
   * Advance the clock. Called exactly once per presented frame by `Application`.
   */
  tick(): TickResult {
    const now = this.timeSource();
    let raw = now - this.lastTime;
    this.lastTime = now;
    if (!(raw >= 0)) raw = 0; // clock went backwards (rare: some browsers' performance.now)
    const clamped = Math.min(raw, this.maxDeltaTime);
    this._wallClockElapsed = now - this._startWallTime;
    this._unscaledDeltaTime = clamped;
    this._deltaTime = this._paused ? 0 : clamped * this._timeScale;
    this._smoothedDelta = this._smoothedDelta * 0.9 + clamped * 0.1;
    this._frameIndex++;
    if (!this._paused) this._elapsedTime += this._deltaTime;

    let steps = 0;
    let alpha = 0;
    if (!this._paused && this._timeScale > 0) {
      // Scale the accumulator by timeScale so slow-motion also slows simulation smoothly.
      this.accumulator += this._deltaTime;
      const fixed = this.fixedDeltaTime;
      let dropped = 0;
      while (this.accumulator >= fixed) {
        this.accumulator -= fixed;
        this._fixedTime += fixed;
        this._fixedStepIndex++;
        steps++;
        if (steps >= this.catchUpLimit) {
          dropped = this.accumulator;
          this.accumulator = 0;
          break;
        }
      }
      if (dropped > 0) {
        this._droppedSteps++;
        this._droppedTime += dropped;
      }
      alpha = clamp(this.accumulator / fixed, 0, 1);
    }
    return { fixedSteps: steps, alpha };
  }

  /** Force an exact number of fixed steps (replay, tests, deterministic offline capture). */
  advanceFixedSteps(count: number, dt = this.fixedDeltaTime): void {
    for (let i = 0; i < count; i++) {
      this._fixedTime += dt;
      this._elapsedTime += dt;
      this._fixedStepIndex++;
    }
  }

  /** Snap the accumulator so the next frame renders exactly at the current fixed state. */
  synchronizeInterpolation(): void {
    this.accumulator = 0;
  }

  reset(): void {
    this.lastTime = this.timeSource();
    this._startWallTime = this.lastTime;
    this.accumulator = 0;
    this._elapsedTime = 0;
    this._fixedTime = 0;
    this._frameIndex = 0;
    this._fixedStepIndex = 0;
    this._droppedSteps = 0;
    this._droppedTime = 0;
    this._wallClockElapsed = 0;
  }

  get interpolationAlpha(): number {
    return clamp(this.accumulator / this.fixedDeltaTime, 0, 1);
  }

  get accumulatorFraction(): number {
    return clamp(this.accumulator / this.fixedDeltaTime, 0, 1);
  }

  setFixedDeltaTime(dt: number): void {
    this.fixedDeltaTime = clamp(dt, 1 / 1000, 1 / 10);
    this.accumulator = clamp(this.accumulator, 0, this.fixedDeltaTime);
  }
}

function defaultTimeSource(): number {
  if (typeof performance !== "undefined" && typeof performance.now === "function") return performance.now() / 1000;
  return Date.now() / 1000;
}

/** Test/replay clock: advances only when told to, with no wall-clock coupling. */
export class ManualClock extends Clock {
  private t = 0;

  constructor(options: ClockOptions = {}) {
    super({ ...options, timeSource: () => (this as ManualClock).t });
  }

  /** Advance synthetic time by `seconds` and return the tick result. */
  advance(seconds: number): TickResult {
    this.t += seconds;
    return this.tick();
  }

  get manualTime(): number {
    return this.t;
  }
}

/**
 * Interval helper: fires a callback on a fixed cadence driven by the engine clock (not
 * setTimeout), so behaviour is identical under time scaling and in tests.
 */
export class RateLimiter {
  private next = 0;

  constructor(public intervalSeconds: number) {}

  /** True exactly once per interval, based on `now`. */
  check(now: number): boolean {
    if (now < this.next) return false;
    // Skip missed intervals rather than bursting.
    this.next = now + this.intervalSeconds;
    return true;
  }

  reset(now: number): void {
    this.next = now;
  }
}
