/**
 * Script — the unit of gameplay behaviour (Phase 18.1).
 *
 * Subclass `Script`, implement the hooks you need, and attach instances to an entity through a
 * {@link ScriptComponent}. A {@link ScriptRuntime} installed on the world calls the hooks:
 *
 *   onCreate        once, before any other hook of this script, at the first script phase after the
 *                   script is attached *and* enabled
 *   onPreUpdate     every frame, band 0 (before the simulation)
 *   onFixedUpdate   once per fixed step, band 100 (before vehicles/physics integrate that step)
 *   onUpdate        every frame, band 200 (variable rate, after the simulation)
 *   onLateUpdate    every frame, band 450 (after animation and world systems, before transforms)
 *   onDestroy       once, when the script, its component or its entity goes away (the entity and
 *                   its other components are still readable), or when the runtime is disposed
 *
 * Contracts the runtime keeps (pinned by tests/scripting/scriptLifecycle.test.ts):
 *  - Hooks run in a deterministic order: creation order of the scripts, the same every frame.
 *  - A script that never ran onCreate gets no onDestroy; one whose onCreate started does, so it can
 *    release whatever it acquired before it threw.
 *  - `enabled = false` skips the per-frame hooks (and defers onCreate); it never skips onDestroy.
 *  - Error isolation (Phase 18.5): a throwing hook is caught, recorded and the script is faulted
 *    (no further per-frame hooks). Structural changes it queued are discarded and entities it
 *    created are destroyed; other scripts, other systems and the clock are untouched.
 *
 * The {@link ScriptContext} handed to a hook is reused between calls — read from it during the call,
 * do not keep it. It deliberately carries no GPU device, render context or solver internals
 * (Phase 18.6): scripts act on the world through entities and components.
 */

import type { Entity, EntityWorld } from "../scene/world.js";
import type { EntityId } from "../scene/entityId.js";
import type { Logger } from "../core/log.js";
import { UsageError } from "../core/errors.js";
import type { TimerCallback, TimerHandle, TimerOptions } from "./timers.js";
import type { CoroutineBody, CoroutineHandle, CoroutineOptions } from "./coroutines.js";
import type { EventListenOptions, EventSendOptions, EventType, ScriptEventHandler } from "./events.js";
import type { Disposable } from "../core/events.js";

/** Script hook names, in the order a script first meets them. */
/**
 * `timer` is a timer callback (18.2), `coroutine` a coroutine step (18.3), `event` an event
 * handler (18.4) and `reload` a hot-reload hook or constructor (18.7); all are isolated and counted
 * like hooks.
 */
export type ScriptPhase = "create" | "preUpdate" | "fixedUpdate" | "update" | "lateUpdate" | "timer" | "coroutine" | "event" | "reload" | "destroy";

/**
 * Where a script is in its life:
 *  - `pending`   attached, onCreate not yet run (waiting for the next phase, or for `enabled`)
 *  - `active`    onCreate succeeded; per-frame hooks run while `enabled`
 *  - `faulted`   a hook threw (see the runtime's `faultAfter`); only onDestroy will still run
 *  - `destroyed` gone; nothing runs again
 */
export type ScriptState = "pending" | "active" | "faulted" | "destroyed";

/** Time as a script sees it: copies of the clock's values, refreshed before every hook call. */
export interface ScriptTime {
  /** Seconds this hook covers: the frame delta, or `fixedDt` inside onFixedUpdate. */
  readonly dt: number;
  readonly fixedDt: number;
  /** Simulation seconds since the clock started. */
  readonly elapsed: number;
  readonly frame: number;
  /** [0,1) interpolation factor between fixed states (render-facing hooks). */
  readonly alpha: number;
  /** Index of this fixed step within the frame (onFixedUpdate only; 0 elsewhere). */
  readonly fixedStep: number;
  /**
   * Fixed steps the runtime has run since it was installed — the deterministic clock "sim" timers
   * count on. Inside onFixedUpdate it is the current step's number (the first step is 1).
   */
  readonly tick: number;
}

/** @internal What the runtime provides to a script: timers (18.2) and coroutines (18.3). */
export interface ScriptHost {
  _schedule(script: Script, seconds: number, callback: TimerCallback, repeat: boolean, options: TimerOptions | undefined): TimerHandle;
  _cancelTimers(script: Script): void;
  _startCoroutine(script: Script, body: CoroutineBody, options: CoroutineOptions | undefined): CoroutineHandle;
  _stopCoroutines(script: Script): void;
  _subscribe(script: Script, type: EventType<unknown>, handler: ScriptEventHandler<unknown>, options: EventListenOptions | undefined): Disposable;
  _send(script: Script, type: EventType<unknown>, payload: unknown, options: EventSendOptions | undefined, queued: boolean): void;
}

export interface ScriptContext {
  /** The entity the script is attached to. */
  readonly entity: Entity;
  readonly world: EntityWorld;
  readonly time: ScriptTime;
  /** The runtime's `scripts` logger. */
  readonly logger: Logger;
}

export abstract class Script {
  /** Per-frame hooks run only while true. Toggle freely; onCreate waits for the first `true`. */
  enabled = true;

  /** @internal */ _state: ScriptState = "pending";
  /** @internal Set when onCreate starts (decides whether onDestroy runs). */
  _started = false;
  /** @internal Errors this script has thrown. */
  _errors = 0;
  /** @internal */ _entity: Entity | null = null;
  /** @internal Registered name when created by name, else the class name. */
  _name: string | null = null;
  /** @internal The adopting runtime (timers go through it). */
  _host: ScriptHost | null = null;
  /** @internal The owning component's enable flag lives here. */
  _component: { enabled: boolean } | null = null;
  /** @internal Live timers this script owns. */
  readonly _timers: TimerHandle[] = [];
  /** @internal Running or paused coroutines this script owns. */
  readonly _coroutines: CoroutineHandle[] = [];
  /** @internal Event subscriptions this script owns. */
  readonly _subscriptions: Disposable[] = [];

  onCreate?(context: ScriptContext): void;
  onPreUpdate?(context: ScriptContext): void;
  onFixedUpdate?(context: ScriptContext): void;
  onUpdate?(context: ScriptContext): void;
  onLateUpdate?(context: ScriptContext): void;
  onDestroy?(context: ScriptContext): void;
  /**
   * Hot reload (Phase 18.7): called on the *old* instance just before it is replaced, after its
   * timers, coroutines and event listeners were cancelled. Not called for scripts never created.
   */
  onUnload?(context: ScriptContext): void;
  /**
   * Hot reload (Phase 18.7): called on the *new* instance in place of onCreate, with the instance it
   * replaces (its data fields are already copied over). Re-register timers, coroutines and event
   * listeners here. Without it the new instance's onCreate runs instead.
   */
  onReload?(context: ScriptContext, previous: Script): void;

  get state(): ScriptState {
    return this._state;
  }

  /** The entity this script is attached to (null before attach and after destroy). */
  get entity(): Entity | null {
    return this._entity;
  }

  get entityId(): EntityId | null {
    return this._entity?.id ?? null;
  }

  /** Errors thrown by this script's hooks so far. */
  get errorCount(): number {
    return this._errors;
  }

  /**
   * Run `callback` once after `seconds` (Phase 18.2). Default clock "sim": counted in fixed steps,
   * deterministic; `{ clock: "render" }` counts frame seconds; `{ steps }` gives exact fixed steps.
   * Available once the script is attached to a world with a runtime.
   */
  after(seconds: number, callback: TimerCallback, options?: TimerOptions): TimerHandle {
    return this.host()._schedule(this, seconds, callback, false, options);
  }

  /** Run `callback` every `seconds` (or every `steps` fixed steps) until cancelled. */
  every(seconds: number, callback: TimerCallback, options?: TimerOptions): TimerHandle {
    return this.host()._schedule(this, seconds, callback, true, options);
  }

  /** Cancel every timer this script owns. */
  cancelTimers(): void {
    this._host?._cancelTimers(this);
  }

  /** This script's live timers. */
  get timers(): readonly TimerHandle[] {
    return this._timers;
  }

  /**
   * Start a coroutine (Phase 18.3): `body` is a generator function, called with `this` bound to the
   * script. It runs now up to its first `yield`, then advances on its clock (default "render";
   * `{ clock: "sim" }` for fixed steps). See `scripting/coroutines.ts` for what it may yield.
   */
  startCoroutine(body: CoroutineBody, options?: CoroutineOptions): CoroutineHandle {
    return this.host()._startCoroutine(this, body, options);
  }

  /** Cancel every coroutine this script owns (their `finally` blocks run). */
  stopCoroutines(): void {
    this._host?._stopCoroutines(this);
  }

  /** This script's running or paused coroutines. */
  get coroutines(): readonly CoroutineHandle[] {
    return this._coroutines;
  }

  /**
   * Listen for a typed event (Phase 18.4) on the world channel, or on an entity's with
   * `{ entity }`. The handler runs with hook isolation while this script is active and enabled, and
   * is removed when the script is destroyed or faulted (or when the returned handle is disposed).
   */
  on<T>(type: EventType<T>, handler: ScriptEventHandler<T>, options?: EventListenOptions): Disposable {
    return this.host()._subscribe(this, type as EventType<unknown>, handler as ScriptEventHandler<unknown>, options);
  }

  /** Deliver an event now (world channel, or `{ to: entity }`). */
  emit<T>(type: EventType<T>, payload: T, options?: EventSendOptions): void {
    this.host()._send(this, type as EventType<unknown>, payload, options, false);
  }

  /** Queue an event for the start of the next script phase. */
  post<T>(type: EventType<T>, payload: T, options?: EventSendOptions): void {
    this.host()._send(this, type as EventType<unknown>, payload, options, true);
  }

  private host(): ScriptHost {
    if (!this._host) throw new UsageError(`${this.scriptName}: timers, coroutines and events need the script attached to a world with a ScriptRuntime`);
    return this._host;
  }

  /** Name used in errors and stats: the registered name, or the class name. */
  get scriptName(): string {
    return this._name ?? this.constructor.name;
  }
}

/** A script class with a no-argument constructor (what the name registry instantiates). */
export type ScriptConstructor<T extends Script = Script> = new () => T;
