/**
 * `UIAnimator` — time-based property animation for the UI.
 *
 * * **Delta time**, not frames: `update(dt)` advances by real seconds × `timeScale`; `paused` freezes
 *   every animation (a paused game menu can still animate if its manager keeps updating with a
 *   separate animator; the default one pauses with the UI).
 * * **Ownership**: every animation has an owner (usually an element). Disposing or detaching the owner
 *   cancels its animations (`cancelOwner`), so nothing animates a dead element.
 * * **Conflicts**: one animation per (owner, property). Starting another on the same property cancels
 *   the running one (its `onCancel` fires) and the new one starts from the current value — no fight,
 *   no jump.
 * * **Reduced motion**: with `reducedMotion` on, animations complete on their next update at their end
 *   value (callbacks still run in order) unless started with `essential: true` (progress indicators).
 * * **No per-frame allocation**: `update` walks one array and compacts it in place.
 */

import { UsageError } from "../../core/errors.js";
import { lerpColor, parseColor, type ColorInput } from "../core/color.js";
import type { Easing } from "../style/types.js";

export type EasingFn = (t: number) => number;

export const EASINGS: Readonly<Record<Easing, EasingFn>> = {
  linear: (t) => t,
  easeIn: (t) => t * t,
  easeOut: (t) => t * (2 - t),
  easeInOut: (t) => (t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t),
  easeInCubic: (t) => t * t * t,
  easeOutCubic: (t) => 1 - Math.pow(1 - t, 3),
  easeInOutCubic: (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  easeOutBack: (t) => {
    const c1 = 1.70158;
    const c3 = c1 + 1;
    return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
  },
  step: (t) => (t >= 1 ? 1 : 0),
};

export interface AnimationOptions {
  duration: number;
  delay?: number;
  easing?: Easing | EasingFn;
  /** Extra repetitions (`Infinity` loops forever). */
  repeat?: number;
  /** Alternate direction on each repetition. */
  yoyo?: boolean;
  /** Runs even with reduced motion (spinners, progress). */
  essential?: boolean;
  onUpdate?: (value: number) => void;
  onComplete?: () => void;
  onCancel?: () => void;
}

export type AnimationState = "pending" | "running" | "finished" | "cancelled";

export class AnimationHandle {
  state: AnimationState = "pending";
  /** @internal */ elapsed = 0;
  /** @internal */ iteration = 0;
  /** @internal */ reversed = false;
  private _done: Promise<AnimationState> | null = null;
  private _resolve: ((s: AnimationState) => void) | null = null;

  constructor(
    /** @internal */ readonly animator: UIAnimator,
    readonly owner: object,
    readonly property: string,
    /** @internal */ public from: number,
    /** @internal */ public to: number,
    /** @internal */ readonly apply: (v: number) => void,
    /** @internal */ readonly options: AnimationOptions,
    /** @internal */ readonly easing: EasingFn,
  ) {}

  get active(): boolean {
    return this.state === "pending" || this.state === "running";
  }

  /** Normalised progress 0..1 of the current iteration. */
  get progress(): number {
    const d = this.options.duration;
    return d <= 0 ? 1 : Math.max(0, Math.min(1, (this.elapsed - (this.options.delay ?? 0)) / d));
  }

  cancel(): void {
    this.animator._end(this, "cancelled");
  }

  /** Jump to the end value and complete now. */
  finish(): void {
    if (!this.active) return;
    this.apply(this.reversed ? this.from : this.to);
    this.animator._end(this, "finished");
  }

  /** Play back towards the start value from where it is now. */
  reverse(): void {
    if (!this.active) return;
    const d = this.options.duration;
    const delay = this.options.delay ?? 0;
    const p = this.progress;
    this.reversed = !this.reversed;
    this.elapsed = delay + (1 - p) * d;
  }

  /** Resolves with the final state (`finished` or `cancelled`). */
  get done(): Promise<AnimationState> {
    if (!this._done) {
      if (!this.active) this._done = Promise.resolve(this.state);
      else this._done = new Promise((r) => (this._resolve = r));
    }
    return this._done;
  }

  private _whenDone: ((s: AnimationState) => void)[] | null = null;

  /** Call `fn` synchronously when the animation finishes or is cancelled (immediately if it has). */
  whenDone(fn: (state: AnimationState) => void): void {
    if (!this.active) fn(this.state);
    else (this._whenDone ??= []).push(fn);
  }

  /** @internal */
  _settle(): void {
    this._resolve?.(this.state);
    this._resolve = null;
    const list = this._whenDone;
    this._whenDone = null;
    if (list) for (const fn of list) fn(this.state);
  }
}

/** A sequence or parallel group of animations. */
export class AnimationGroup {
  private cancelled = false;
  private current: AnimationHandle[] = [];
  state: AnimationState = "running";
  onComplete: (() => void) | null = null;

  /** @internal */ _track(h: AnimationHandle): void {
    this.current.push(h);
  }

  get active(): boolean {
    return this.state === "running";
  }

  cancel(): void {
    if (!this.active) return;
    this.cancelled = true;
    this.state = "cancelled";
    for (const h of this.current) h.cancel();
    this.current.length = 0;
  }

  /** @internal */ _complete(): void {
    if (this.cancelled || this.state !== "running") return;
    this.state = "finished";
    this.onComplete?.();
  }

  /** @internal */ get _cancelled(): boolean {
    return this.cancelled;
  }
}

export class UIAnimator {
  private readonly running: AnimationHandle[] = [];
  private readonly byKey = new Map<object, Map<string, AnimationHandle>>();
  timeScale = 1;
  paused = false;
  reducedMotion = false;
  /** Animations started since creation (diagnostics). */
  started = 0;

  /** Live (pending or running) animations; cancelled ones awaiting compaction are not counted. */
  get activeCount(): number {
    let n = 0;
    for (const h of this.running) if (h.active) n++;
    return n;
  }

  /** Animate a numeric value; `apply` writes it. The low-level primitive everything else uses. */
  tween(owner: object, property: string, from: number, to: number, apply: (v: number) => void, options: AnimationOptions): AnimationHandle {
    if (!(options.duration >= 0) || !Number.isFinite(options.duration)) throw new UsageError(`ui animation: duration must be a finite number >= 0 (got ${options.duration})`);
    if (options.delay !== undefined && !(options.delay >= 0)) throw new UsageError("ui animation: delay must be >= 0");
    const easing = typeof options.easing === "function" ? options.easing : EASINGS[options.easing ?? "easeOut"];
    if (!easing) throw new UsageError(`ui animation: unknown easing "${String(options.easing)}"`);
    let perOwner = this.byKey.get(owner);
    const existing = perOwner?.get(property);
    if (existing) existing.cancel();
    const h = new AnimationHandle(this, owner, property, from, to, apply, options, easing);
    if (!perOwner) {
      perOwner = new Map();
      this.byKey.set(owner, perOwner);
    }
    perOwner.set(property, h);
    this.running.push(h);
    this.started++;
    return h;
  }

  /**
   * Animate numeric properties of an object (`opacity`, `translateY`, `value`, `scrollY`…) from their
   * current values. Returns one handle per property.
   */
  animate<T extends object>(target: T, to: Partial<Record<keyof T & string, number>>, options: AnimationOptions): AnimationHandle[] {
    const handles: AnimationHandle[] = [];
    for (const key of Object.keys(to) as (keyof T & string)[]) {
      const end = to[key] as number;
      const start = (target as Record<string, unknown>)[key];
      if (typeof start !== "number") throw new UsageError(`ui animation: ${key} is not a numeric property of the target`);
      handles.push(this.tween(target, key, start, end, (v) => ((target as Record<string, unknown>)[key] = v), options));
    }
    return handles;
  }

  /** Animate a packed-colour property (sRGB channel interpolation). */
  animateColor<T extends object>(target: T, property: keyof T & string, to: ColorInput, options: AnimationOptions): AnimationHandle {
    const from = (target as Record<string, unknown>)[property];
    if (typeof from !== "number") throw new UsageError(`ui animation: ${property} is not a colour property`);
    const a = from >>> 0;
    const b = parseColor(to);
    return this.tween(target, property, 0, 1, (t) => ((target as Record<string, unknown>)[property] = lerpColor(a, b, t)), options);
  }

  /** Run steps one after another; each step starts an animation when the previous finished. */
  sequence(steps: readonly (() => AnimationHandle | AnimationHandle[])[]): AnimationGroup {
    const group = new AnimationGroup();
    const run = (i: number): void => {
      if (group._cancelled) return;
      if (i >= steps.length) {
        group._complete();
        return;
      }
      const started = steps[i]!();
      const list = Array.isArray(started) ? started : [started];
      for (const h of list) group._track(h);
      whenAll(list, (ok) => (ok ? run(i + 1) : group.cancel()));
    };
    run(0);
    return group;
  }

  /** Group already-started animations; completes when all finish. */
  parallel(handles: readonly AnimationHandle[]): AnimationGroup {
    const group = new AnimationGroup();
    for (const h of handles) group._track(h);
    whenAll(handles, (ok) => (ok ? group._complete() : group.cancel()));
    return group;
  }

  /** Cancel every animation owned by `owner`. */
  cancelOwner(owner: object): number {
    const perOwner = this.byKey.get(owner);
    if (!perOwner) return 0;
    let n = 0;
    for (const h of [...perOwner.values()]) {
      h.cancel();
      n++;
    }
    return n;
  }

  /** Running animation of `owner.property`, if any. */
  get(owner: object, property: string): AnimationHandle | undefined {
    return this.byKey.get(owner)?.get(property);
  }

  update(dt: number): void {
    if (this.paused || this.running.length === 0) return;
    const step = Math.max(0, dt) * this.timeScale;
    const list = this.running;
    // Iterate a stable prefix: animations started by callbacks this frame begin next frame.
    const count = list.length;
    for (let i = 0; i < count; i++) {
      const h = list[i]!;
      if (!h.active) continue;
      const o = h.options;
      if (this.reducedMotion && !o.essential) {
        h.apply(h.to);
        o.onUpdate?.(h.to);
        this._end(h, "finished");
        continue;
      }
      h.elapsed += step;
      const delay = o.delay ?? 0;
      if (h.elapsed < delay) continue;
      h.state = "running";
      const d = o.duration;
      let p = d <= 0 ? 1 : (h.elapsed - delay) / d;
      if (p >= 1) {
        const repeats = o.repeat ?? 0;
        if (h.iteration < repeats) {
          h.iteration++;
          h.elapsed = delay + (p - 1) * d;
          if (o.yoyo) h.reversed = !h.reversed;
          p = d <= 0 ? 1 : Math.min(1, (h.elapsed - delay) / d);
        } else p = 1;
      }
      const e = h.easing(Math.min(1, p));
      const v = h.reversed ? h.to + (h.from - h.to) * e : h.from + (h.to - h.from) * e;
      h.apply(v);
      o.onUpdate?.(v);
      if (p >= 1 && h.iteration >= (o.repeat ?? 0)) this._end(h, "finished");
    }
    // Compact in place.
    let w = 0;
    for (let i = 0; i < list.length; i++) {
      const h = list[i]!;
      if (h.active) list[w++] = h;
    }
    list.length = w;
  }

  /** @internal */
  _end(h: AnimationHandle, state: "finished" | "cancelled"): void {
    if (!h.active) return;
    h.state = state;
    const perOwner = this.byKey.get(h.owner);
    if (perOwner?.get(h.property) === h) {
      perOwner.delete(h.property);
      if (perOwner.size === 0) this.byKey.delete(h.owner);
    }
    try {
      if (state === "finished") h.options.onComplete?.();
      else h.options.onCancel?.();
    } finally {
      h._settle();
    }
  }

  /** Cancel everything (manager shutdown). */
  clear(): void {
    for (const h of [...this.running]) h.cancel();
    this.running.length = 0;
    this.byKey.clear();
  }
}

/** Call `fn(allFinished)` synchronously once every handle has settled. */
function whenAll(handles: readonly AnimationHandle[], fn: (allFinished: boolean) => void): void {
  let remaining = handles.length;
  let ok = true;
  if (remaining === 0) {
    fn(true);
    return;
  }
  for (const h of handles) {
    h.whenDone((s) => {
      if (s !== "finished") ok = false;
      if (--remaining === 0) fn(ok);
    });
  }
}
