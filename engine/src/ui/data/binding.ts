/**
 * Data binding — optional, lightweight reactive state for the UI.
 *
 * * `Observable<T>`: a value with change notification (`===` / `Object.is` equality, so setting the
 *   same value notifies nobody).
 * * `computed(deps, fn)`: a derived observable, recomputed when any dependency changes.
 * * `ObservableStore`: a keyed bag of observables (`store.set("health", 75)`) for game-state objects.
 * * `batch(fn)`: defer notifications until `fn` returns; each observable notifies once with its final
 *   value — a tick that changes health, shield and ammo restyles each bound widget once.
 * * `Binder.bind(target, "prop", source)`: one-way (source → target) or two-way (also target → source
 *   on the target's `change` event). Re-entrancy guards stop A→B→A loops; converters run both ways;
 *   a converter that throws is reported, not swallowed, and leaves the target unchanged.
 *
 * None of this is required: widgets are plain objects with setters, and conventional event-driven
 * code (`bar.value = hp`) works the same way.
 */

import { UsageError } from "../../core/errors.js";
import type { Disposable } from "../../core/events.js";
import type { UIElement } from "../core/element.js";
import type { UICustomEvent } from "../input/events.js";

type Listener<T> = (value: T, previous: T) => void;

let batchDepth = 0;
const pending = new Set<Observable<unknown>>();

/** Run `fn` with notifications deferred to the end of the outermost batch. */
export function batch<R>(fn: () => R): R {
  batchDepth++;
  try {
    return fn();
  } finally {
    batchDepth--;
    if (batchDepth === 0) flushPending();
  }
}

function flushPending(): void {
  // Notifying can queue more (computed values); loop until quiet, bounded against cycles.
  for (let round = 0; pending.size > 0; round++) {
    if (round > 100) {
      pending.clear();
      throw new UsageError("ui binding: notifications did not settle after 100 rounds (a dependency cycle?)");
    }
    const list = [...pending];
    pending.clear();
    for (const o of list) o._notify();
  }
}

export class Observable<T> {
  private _value: T;
  private _notified: T;
  private listeners: Listener<T>[] = [];
  /** Number of notifications delivered (tests/diagnostics). */
  notifications = 0;

  constructor(initial: T) {
    this._value = initial;
    this._notified = initial;
  }

  get value(): T {
    return this._value;
  }

  set value(v: T) {
    if (Object.is(v, this._value)) return;
    this._value = v;
    if (batchDepth > 0) pending.add(this as Observable<unknown>);
    else this._notify();
  }

  /** Read without implying a dependency (same as `value`; kept for intent at call sites). */
  peek(): T {
    return this._value;
  }

  subscribe(fn: Listener<T>): Disposable {
    this.listeners = [...this.listeners, fn];
    return {
      dispose: () => {
        this.listeners = this.listeners.filter((l) => l !== fn);
      },
    };
  }

  get subscriberCount(): number {
    return this.listeners.length;
  }

  /** @internal */
  _notify(): void {
    const prev = this._notified;
    const cur = this._value;
    if (Object.is(prev, cur)) return;
    this._notified = cur;
    this.notifications++;
    for (const l of this.listeners) l(cur, prev);
  }
}

/** Anything that can notify (an `Observable` of any value type). */
export interface Subscribable {
  subscribe(fn: () => void): Disposable;
}

/** A read-only observable derived from others. Dispose it to unsubscribe from its sources. */
export class Computed<T> extends Observable<T> implements Disposable {
  private readonly subs: Disposable[];

  constructor(deps: readonly Subscribable[], private readonly fn: () => T) {
    super(fn());
    this.subs = deps.map((d) => d.subscribe(() => this.recompute()));
  }

  private recompute(): void {
    super.value = this.fn();
  }

  override get value(): T {
    return super.value;
  }

  override set value(_v: T) {
    throw new UsageError("ui binding: a computed value is read-only");
  }

  dispose(): void {
    for (const s of this.subs) s.dispose();
    this.subs.length = 0;
  }
}

export function observable<T>(initial: T): Observable<T> {
  return new Observable(initial);
}

export function computed<T>(deps: readonly Subscribable[], fn: () => T): Computed<T> {
  return new Computed(deps, fn);
}

/** A keyed set of observables over a plain object shape. */
export class ObservableStore<S extends Record<string, unknown>> {
  private readonly fields = new Map<keyof S, Observable<unknown>>();

  constructor(initial: S) {
    // Each field is an Observable<S[k]>; the map erases the per-key type and `field()` restores it.
    for (const k of Object.keys(initial) as (keyof S)[]) this.fields.set(k, new Observable(initial[k]) as unknown as Observable<unknown>);
  }

  field<K extends keyof S>(key: K): Observable<S[K]> {
    const f = this.fields.get(key);
    if (!f) throw new UsageError(`ui binding: store has no field "${String(key)}" (fields: ${[...this.fields.keys()].map(String).join(", ")})`);
    return f as Observable<S[K]>;
  }

  get<K extends keyof S>(key: K): S[K] {
    return this.field(key).value;
  }

  /** Untyped field access by name (binding sources, declarative definitions). */
  observable(key: string): Observable<unknown> {
    return this.field(key as keyof S) as Observable<unknown>;
  }

  set<K extends keyof S>(key: K, value: S[K]): void {
    this.field(key).value = value;
  }

  /** Set several fields with one notification each. */
  update(values: Partial<S>): void {
    batch(() => {
      for (const k of Object.keys(values) as (keyof S)[]) this.set(k, values[k] as S[keyof S]);
    });
  }

  on<K extends keyof S>(key: K, fn: (value: S[K], previous: S[K]) => void): Disposable {
    return this.field(key).subscribe(fn);
  }

  has(key: string): boolean {
    return this.fields.has(key);
  }

  snapshot(): S {
    const out: Record<string, unknown> = {};
    for (const [k, f] of this.fields) out[k as string] = f.value;
    return out as S;
  }
}

/** Anything with named observable fields (`ObservableStore` of any shape). */
export interface FieldSource {
  observable(key: string): Observable<unknown>;
  has(key: string): boolean;
}

export type BindingSource<T> = Observable<T> | readonly [FieldSource, string];

export interface BindingOptions<S, T> {
  mode?: "one-way" | "two-way";
  /** Source value → target value. */
  convert?: (value: S) => T;
  /** Target value → source value (two-way). */
  convertBack?: (value: T) => S;
}

export class Binding implements Disposable {
  active = true;
  /** Errors thrown by converters/targets, newest last (bounded). */
  readonly errors: string[] = [];
  constructor(private readonly release: () => void) {}
  dispose(): void {
    if (!this.active) return;
    this.active = false;
    this.release();
  }
}

/**
 * Connects observables to object properties. Element targets own their bindings: disposing the
 * element disposes them.
 */
export class Binder {
  private live = 0;
  onError: (message: string) => void = (m) => {
    if (typeof console !== "undefined") console.error(`[forge.ui] ${m}`);
  };

  get activeBindings(): number {
    return this.live;
  }

  bind<S, T>(target: object, property: string, source: BindingSource<S>, options: BindingOptions<S, T> = {}): Binding {
    if (!(property in target)) throw new UsageError(`ui binding: target has no property "${property}"`);
    const obs = (Array.isArray(source) ? (source as readonly [FieldSource, string])[0].observable((source as readonly [FieldSource, string])[1]) : source) as Observable<S>;
    const mode = options.mode ?? "one-way";
    const convert = options.convert ?? ((v: S) => v as unknown as T);
    const convertBack = options.convertBack ?? ((v: T) => v as unknown as S);
    let updating = false;
    const subs: Disposable[] = [];
    const binding = new Binding(() => {
      for (const s of subs) s.dispose();
      this.live--;
    });
    const fail = (what: string, e: unknown): void => {
      const msg = `ui binding ${property}: ${what} threw: ${e instanceof Error ? e.message : String(e)}`;
      binding.errors.push(msg);
      if (binding.errors.length > 16) binding.errors.shift();
      this.onError(msg);
    };
    const push = (v: S): void => {
      if (updating) return;
      updating = true;
      try {
        (target as Record<string, unknown>)[property] = convert(v);
      } catch (e) {
        fail("source → target", e);
      } finally {
        updating = false;
      }
    };
    push(obs.value);
    subs.push(obs.subscribe((v) => push(v)));
    if (mode === "two-way") {
      const el = target as Partial<UIElement>;
      if (typeof el.on !== "function") throw new UsageError("ui binding: two-way bindings need a UI element target (it reports edits with `change` events)");
      subs.push(
        el.on("change", (e: UICustomEvent<{ property: string; value: unknown }>) => {
          if (updating || e.target !== target || e.detail?.property !== property) return;
          updating = true;
          try {
            obs.value = convertBack(e.detail.value as T);
          } catch (err) {
            fail("target → source", err);
          } finally {
            updating = false;
          }
        }),
      );
    }
    this.live++;
    if (typeof (target as Partial<UIElement>).own === "function") (target as UIElement).own(binding);
    return binding;
  }
}
