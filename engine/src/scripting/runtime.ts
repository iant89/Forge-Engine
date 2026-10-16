/**
 * ScriptRuntime — runs {@link Script} hooks, timers, coroutines and event handlers for one world
 * (Phases 18.1–18.4) and isolates their failures (Phase 18.5). Every phase starts by creating
 * pending scripts and delivering events posted since the previous phase.
 *
 * `ScriptRuntime.install(world)` registers four systems, one per hook band (see scene/systems.ts):
 *
 *   scripts.pre     order   0   onCreate (pending scripts) · onPreUpdate
 *   scripts.fixed   order 100   per fixed step: tick++, due "sim" timers, "sim" coroutines,
 *                               onFixedUpdate — before "vehicles" and "physics"
 *   scripts.update  order 200   due "render" timers, "render" coroutines, then onUpdate
 *   scripts.late    order 450   onLateUpdate, before "transforms"
 *
 * Every phase first creates scripts that are still pending, so a script attached mid-frame starts
 * at the next phase rather than waiting a whole frame. Within a phase scripts run in creation order.
 * Like every FixedSystem, `scripts.fixed` runs all of the frame's fixed steps before the next fixed
 * system runs its own (the engine does not interleave fixed systems per step).
 *
 * Error isolation — what a throwing hook cannot do:
 *  - corrupt the ECS: each hook runs in its own deferred-structure scope; when it throws, the
 *    add/remove/destroy calls it queued are discarded and entities it created are destroyed, so a
 *    hook's structural changes land all-or-nothing. (Plain field writes made before the throw stay —
 *    compute first, then commit.)
 *  - stop anything else: the error is caught here, other scripts in the phase still run, and the
 *    system band never sees it, so physics, rendering and every other system run as usual.
 *  - touch the clock: scripts get copies of the clock's numbers, never the Clock itself, and the
 *    copies are refreshed before every hook call.
 * The error is recorded (`errors`, `lastError`, `onError`, the `scripts` logger) and, after
 * `faultAfter` errors (default 1), the script is faulted: no further per-frame hooks, onDestroy
 * still runs. A throwing onCreate always faults. JavaScript cannot interrupt a hook that never
 * returns; an infinite loop in a script still hangs the frame.
 */

import { System, FixedSystem, type ISystem, type SystemContext } from "../scene/systems.js";
import type { Entity, EntityWorld } from "../scene/world.js";
import type { EntityId } from "../scene/entityId.js";
import type { Disposable } from "../core/events.js";
import { Logger } from "../core/log.js";
import { UsageError } from "../core/errors.js";
import { ScriptComponent, _bindScriptRuntime, _scriptBinderOf, type ScriptBinder } from "./component.js";
import type { Script, ScriptConstructor, ScriptContext, ScriptHost, ScriptPhase, ScriptTime } from "./script.js";
import { EventRouter, channelOf, type EventListenOptions, type EventSendOptions, type EventSubscription, type EventType, type HostEventHandler, type ScriptEventHandler, type ScriptEvents } from "./events.js";
import { Coroutine, type CoroutineBody, type CoroutineHandle, type CoroutineOptions, type CoroutineYield, type WaitInstruction } from "./coroutines.js";
import { Timer, TimerQueue, type TimerCallback, type TimerHandle, type TimerOptions } from "./timers.js";

export interface ScriptRuntimeOptions {
  /** Errors a script may throw before it is faulted. Default 1; 0 = never fault (still recorded). */
  faultAfter?: number;
  /** How many recent errors `errors` keeps. Default 32. */
  errorHistory?: number;
  /** Logger for script errors. Default: the frame's logger, scoped `scripts`. */
  logger?: Logger;
  /** Called for every recorded error (after the script's state is updated). */
  onError?: (error: ScriptErrorRecord) => void;
  /** Deepest nested event `emit` allowed (Phase 18.4). Default 16. */
  maxEventDepth?: number;
}

export interface ScriptErrorRecord {
  readonly script: string;
  readonly entity: EntityId;
  readonly phase: ScriptPhase;
  readonly message: string;
  readonly error: unknown;
  readonly frame: number;
  /** True when this error faulted the script. */
  readonly faulted: boolean;
}

/** Result of {@link ScriptRuntime.reload}. */
export interface ScriptReloadReport {
  /** Live scripts swapped to the new class. */
  replaced: number;
  /** Scripts whose new instance could not be constructed (the old one keeps running). */
  failed: number;
}

export interface ScriptRuntimeStats {
  /** Scripts attached and not yet destroyed (pending + active + faulted). */
  scriptsLive: number;
  scriptsActive: number;
  scriptsPending: number;
  scriptsFaulted: number;
  /** Cumulative counters. */
  scriptsCreated: number;
  scriptsDestroyed: number;
  scriptErrors: number;
  /** Failing hooks whose structural changes were discarded. */
  scriptRollbacks: number;
  scriptHookCalls: number;
  /** Scripts replaced by hot reload (Phase 18.7, cumulative). */
  scriptsReloaded: number;
  /** Timers scheduled and not yet finished or cancelled (Phase 18.2). */
  timersActive: number;
  /** Timer callbacks run (cumulative). */
  timersFired: number;
  /** Coroutines running or paused (Phase 18.3). */
  coroutinesActive: number;
  /** Cumulative coroutine outcomes. */
  coroutinesCompleted: number;
  coroutinesCancelled: number;
  coroutinesFailed: number;
  /** Event deliveries attempted (Phase 18.4, cumulative) and events waiting in the post queue. */
  eventsDelivered: number;
  eventsQueued: number;
}

type HookName = "onPreUpdate" | "onFixedUpdate" | "onUpdate" | "onLateUpdate";
type Hook = (context: ScriptContext) => void;

const HOOK_OF: Record<"preUpdate" | "fixedUpdate" | "update" | "lateUpdate", HookName> = {
  preUpdate: "onPreUpdate",
  fixedUpdate: "onFixedUpdate",
  update: "onUpdate",
  lateUpdate: "onLateUpdate",
};

const runtimes = new WeakMap<EntityWorld, ScriptRuntime>();

export class ScriptRuntime implements ScriptBinder, ScriptHost {
  /** Install a runtime on `world` (one per world) and adopt any ScriptComponents already there. */
  static install(world: EntityWorld, options: ScriptRuntimeOptions = {}): ScriptRuntime {
    if (runtimes.has(world) || _scriptBinderOf(world)) throw new UsageError("ScriptRuntime: this world already has a script runtime");
    const runtime = new ScriptRuntime(world, options);
    runtimes.set(world, runtime);
    _bindScriptRuntime(world, runtime);
    for (const component of world.store(ScriptComponent).liveValues()) {
      if (!component._binder) runtime._adopt(component);
    }
    return runtime;
  }

  /** The runtime installed on `world`, if any. */
  static of(world: EntityWorld): ScriptRuntime | undefined {
    return runtimes.get(world);
  }

  readonly world: EntityWorld;
  /** The four phase systems, in band order. */
  readonly systems: readonly ISystem[];
  /** Most recent errors, oldest first (capped by `errorHistory`). */
  readonly errors: ScriptErrorRecord[] = [];

  private readonly faultAfter: number;
  private readonly errorHistory: number;
  private readonly onError: ((error: ScriptErrorRecord) => void) | undefined;
  private logger: Logger | null;
  /** Used until a frame has supplied its logger (e.g. onDestroy on an immediate dispose). */
  private fallbackLogger: Logger | null = null;
  private readonly registry = new Map<string, ScriptConstructor>();
  /** Scripts in creation order, with their owning component at the same index. */
  private readonly live: Script[] = [];
  private readonly owners: ScriptComponent[] = [];
  private compactPending = false;
  /** Entities created while a hook runs (a stack: nested hooks push above their caller's mark). */
  private readonly createdStack: EntityId[] = [];
  private hookDepth = 0;
  private readonly subscriptions: Disposable[] = [];
  private readonly registrations: Disposable[] = [];
  private disposed = false;
  private readonly frameTime = { dt: 0, fixedDt: 0, elapsed: 0, frame: 0, alpha: 0, fixedStep: 0, tick: 0 };
  private readonly time: { -readonly [K in keyof ScriptTime]: ScriptTime[K] } = { dt: 0, fixedDt: 0, elapsed: 0, frame: 0, alpha: 0, fixedStep: 0, tick: 0 };
  /** Fixed steps run since install — the "sim" timer clock. */
  private fixedTick = 0;
  /** Accumulated frame seconds since install — the "render" timer clock. */
  private renderTime = 0;
  /** Latest fixed step length seen (converts "sim" timer seconds to steps). */
  private lastFixedDt = 1 / 60;
  private readonly simTimers = new TimerQueue();
  private readonly renderTimers = new TimerQueue();
  private timerSeq = 0;
  private readonly heldTimers: Timer[] = [];
  private readonly cancelTimer = (t: Timer): void => this.dropTimer(t);
  /** Coroutines per clock, in start order (dead ones are compacted after each pass). */
  private readonly simCoroutines: Coroutine[] = [];
  private readonly renderCoroutines: Coroutine[] = [];
  private coroutineSeq = 0;
  private readonly router: EventRouter;
  /** Typed events for host code (Phase 18.4); scripts use `Script.on/emit/post`. */
  readonly events: ScriptEvents;
  private readonly context: { entity: Entity; world: EntityWorld; time: ScriptTime; logger: Logger };
  private readonly counters: ScriptRuntimeStats = {
    scriptsLive: 0,
    scriptsActive: 0,
    scriptsPending: 0,
    scriptsFaulted: 0,
    scriptsCreated: 0,
    scriptsDestroyed: 0,
    scriptErrors: 0,
    scriptRollbacks: 0,
    scriptHookCalls: 0,
    scriptsReloaded: 0,
    timersActive: 0,
    timersFired: 0,
    coroutinesActive: 0,
    coroutinesCompleted: 0,
    coroutinesCancelled: 0,
    coroutinesFailed: 0,
    eventsDelivered: 0,
    eventsQueued: 0,
  };

  private constructor(world: EntityWorld, options: ScriptRuntimeOptions) {
    this.world = world;
    this.faultAfter = Math.max(0, Math.floor(options.faultAfter ?? 1));
    this.errorHistory = Math.max(1, Math.floor(options.errorHistory ?? 32));
    this.onError = options.onError;
    this.logger = options.logger ?? null;
    this.router = new EventRouter((sub, payload) => this.deliverEvent(sub, payload), Math.max(1, Math.floor(options.maxEventDepth ?? 16)));
    const router = this.router;
    this.events = {
      on: <T>(type: EventType<T>, handler: HostEventHandler<T>, opts?: EventListenOptions) =>
        router.subscribe(type as EventType<unknown>, channelOf(opts?.entity), null, handler as (p: unknown) => void, !!opts?.once),
      emit: <T>(type: EventType<T>, payload: T, opts?: EventSendOptions) => router.emit(type as EventType<unknown>, payload, channelOf(opts?.to)),
      post: <T>(type: EventType<T>, payload: T, opts?: EventSendOptions) => router.post(type as EventType<unknown>, payload, channelOf(opts?.to)),
      listenerCount: (type, opts) => router.count(type, channelOf(opts?.entity)),
    };
    this.context = { entity: null as unknown as Entity, world, time: this.time, logger: null as unknown as Logger };
    const systems: ISystem[] = [
      new ScriptPhaseSystem(this, "scripts.pre", 0, "preUpdate", undefined),
      new ScriptFixedPhaseSystem(this),
      new ScriptPhaseSystem(this, "scripts.update", 200, "update", undefined),
      new ScriptPhaseSystem(this, "scripts.late", 450, "lateUpdate", ["transforms"]),
    ];
    this.systems = systems;
    for (const s of systems) this.registrations.push(world.registerSystem(s));
    this.subscriptions.push(
      world.events.entityCreated.on((id) => {
        if (this.hookDepth > 0) this.createdStack.push(id);
      }),
      // Before any component is detached: onDestroy still sees the entity's other components.
      world.events.entityDestroyed.on((id) => {
        const component = world.getComponent(id, ScriptComponent);
        if (component && component._binder === this) this._release(component);
        // After the entity's own scripts said goodbye: its event channel goes with it.
        this.router.dropChannel(id);
      }),
    );
  }

  // ------------------------------------------------------------------ registry

  /** Register a script class under a name, for `new ScriptComponent("Name")`. */
  define(name: string, ctor: ScriptConstructor): void {
    if (this.registry.has(name)) throw new UsageError(`ScriptRuntime: script "${name}" is already defined`);
    this.registry.set(name, ctor);
  }

  isDefined(name: string): boolean {
    return this.registry.has(name);
  }

  /**
   * Hot reload (Phase 18.7, development): make `name` resolve to `ctor` from now on and swap every
   * live script created under that name — or as an instance of the class previously defined for it —
   * for a new instance of `ctor`, in place (same entity, same component slot, same execution order).
   *
   * Per script: construct the new instance first (if the constructor throws, the old script is left
   * running and the error recorded); cancel the old one's timers, coroutines and event listeners
   * (their closures belong to the old code) and call its `onUnload`; copy its own data fields
   * (enumerable, not functions, not `_`-prefixed internals — so `enabled` carries over) onto the new
   * instance; then, if the old one had been created, run the new one's `onReload(ctx, previous)`, or
   * its `onCreate` when it has no `onReload`. A script not yet created stays pending and gets its
   * onCreate as usual. Faulted scripts are replaced too — a hot fix revives them. Hooks run under the
   * usual isolation; a throw there faults the new instance.
   */
  reload(name: string, ctor: ScriptConstructor): ScriptReloadReport {
    if (this.disposed) throw new UsageError("ScriptRuntime: disposed");
    if (typeof ctor !== "function") throw new UsageError(`reload("${name}"): not a script class`);
    const previous = this.registry.get(name);
    this.registry.set(name, ctor);
    if (this.compactPending) this.compact();
    const report: ScriptReloadReport = { replaced: 0, failed: 0 };
    for (let i = 0; i < this.live.length; i++) {
      const old = this.live[i]!;
      if (old._state === "destroyed") continue;
      if (old._name !== name && !(previous && old.constructor === previous)) continue;
      let next: Script;
      try {
        next = new ctor();
      } catch (e) {
        this.record(name, old._entity?.id ?? (0 as EntityId), "reload", e, false);
        report.failed++;
        continue;
      }
      const component = this.owners[i]!;
      const started = old._started;
      this._cancelTimers(old);
      this._stopCoroutines(old);
      this.unsubscribeAll(old);
      if (started && old._state === "active" && old.onUnload && old._entity) this.invoke(old, "reload", old.onUnload);
      for (const key of Object.keys(old)) {
        if (key.startsWith("_")) continue;
        const value = (old as unknown as Record<string, unknown>)[key];
        if (typeof value === "function") continue;
        (next as unknown as Record<string, unknown>)[key] = value;
      }
      next._name = name;
      next._entity = old._entity;
      next._host = this;
      next._component = component;
      old._state = "destroyed";
      old._entity = null;
      this.live[i] = next;
      const slot = component._scripts.indexOf(old);
      if (slot >= 0) component._scripts[slot] = next;
      this.counters.scriptsReloaded++;
      report.replaced++;
      if (started) {
        next._started = true;
        const hook: Hook | undefined = next.onReload ? (c) => next.onReload!(c, old) : next.onCreate;
        if (!hook) next._state = "active";
        else if (this.invoke(next, "reload", hook) && next._state === "pending") next._state = "active";
      }
    }
    return report;
  }

  // ------------------------------------------------------------------ queries

  get lastError(): ScriptErrorRecord | null {
    return this.errors[this.errors.length - 1] ?? null;
  }

  /** Scripts not yet destroyed, in creation (= execution) order. */
  scripts(): Script[] {
    return this.live.filter((s) => s._state !== "destroyed");
  }

  stats(): ScriptRuntimeStats {
    let active = 0, pending = 0, faulted = 0;
    for (const s of this.live) {
      if (s._state === "active") active++;
      else if (s._state === "pending") pending++;
      else if (s._state === "faulted") faulted++;
    }
    const c = this.counters;
    c.scriptsActive = active;
    c.scriptsPending = pending;
    c.scriptsFaulted = faulted;
    c.scriptsLive = active + pending + faulted;
    c.timersActive = this.simTimers.size + this.renderTimers.size;
    let alive = 0;
    for (const co of this.simCoroutines) if (co.alive) alive++;
    for (const co of this.renderCoroutines) if (co.alive) alive++;
    c.coroutinesActive = alive;
    c.eventsDelivered = this.router.delivered;
    c.eventsQueued = this.router.queued;
    return { ...c };
  }

  // ------------------------------------------------------------------ binder (ScriptComponent)

  /** @internal */
  _adopt(component: ScriptComponent): void {
    if (this.disposed) return;
    component._binder = this;
    const pending = component._pending;
    component._pending = [];
    for (const s of pending) this._adoptScript(component, s);
  }

  /** @internal */
  _adoptScript(component: ScriptComponent, given: Script | string): Script | null {
    const entity = this.world.facade(component.entity);
    if (!entity) return null;
    let script: Script;
    if (typeof given === "string") {
      const ctor = this.registry.get(given);
      if (!ctor) {
        this.record(given, entity.id, "create", new UsageError(`unknown script "${given}" (define it with ScriptRuntime.define)`), false);
        return null;
      }
      script = new ctor();
      script._name = given;
    } else {
      script = given;
      if (script._state !== "pending" || script._entity) {
        this.record(script.scriptName, entity.id, "create", new UsageError("a Script instance can be attached once"), false);
        return null;
      }
    }
    script._entity = entity;
    script._host = this;
    script._component = component;
    component._scripts.push(script);
    this.live.push(script);
    this.owners.push(component);
    return script;
  }

  /** @internal */
  _destroyScript(script: Script): void {
    if (script._state === "destroyed") return;
    script._state = "destroyed";
    this.compactPending = true;
    this.counters.scriptsDestroyed++;
    this._cancelTimers(script);
    this._stopCoroutines(script);
    this.unsubscribeAll(script);
    if (script._started && script.onDestroy && script._entity) this.invoke(script, "destroy", script.onDestroy);
    script._entity = null;
  }

  /** @internal */
  _release(component: ScriptComponent): void {
    if (component._binder !== this) return;
    component._binder = null;
    const scripts = component._scripts.splice(0, component._scripts.length);
    for (const s of scripts) this._destroyScript(s);
    component._pending = [];
  }

  // ------------------------------------------------------------------ phases

  /** @internal Run one phase (called by the phase systems). */
  _run(phase: "preUpdate" | "fixedUpdate" | "update" | "lateUpdate", context: SystemContext, fixedStep: number): void {
    if (this.disposed) return;
    this.capture(context, phase, fixedStep);
    if (this.compactPending) this.compact();
    this.createPending();
    // Posted events arrive first, at a defined point of every phase.
    this.router.flush();
    if (phase === "fixedUpdate") {
      this.fixedTick++;
      this.frameTime.tick = this.fixedTick;
      this.fireDue(this.simTimers, this.fixedTick, "sim");
      this.tickCoroutines(this.simCoroutines, 0);
    } else if (phase === "update") {
      this.renderTime += context.dt;
      this.fireDue(this.renderTimers, this.renderTime, "render");
      this.tickCoroutines(this.renderCoroutines, context.dt);
    }
    const hookName = HOOK_OF[phase];
    const n = this.live.length;
    for (let i = 0; i < n; i++) {
      const script = this.live[i]!;
      if (script._state !== "active" || !script.enabled || !this.owners[i]!.enabled) continue;
      const hook = script[hookName];
      if (hook) this.invoke(script, phase, hook);
    }
    // scripts.fixed runs every fixed step of the frame inside one system update, and the scheduler
    // defers a system's adds/removes/destroys until it returns. Apply them at the end of each step,
    // so step k+1 sees step k's changes whether the frame ran one step or five (determinism).
    if (phase === "fixedUpdate") this.world._applyQueuedStructural();
  }

  private capture(context: SystemContext, phase: ScriptPhase, fixedStep: number): void {
    const t = this.frameTime;
    t.fixedDt = context.fixedDt;
    t.dt = phase === "fixedUpdate" ? context.fixedDt : context.dt;
    t.elapsed = context.elapsed;
    t.frame = context.frame;
    t.alpha = context.alpha;
    t.fixedStep = phase === "fixedUpdate" ? fixedStep : 0;
    t.tick = this.fixedTick;
    if (context.fixedDt > 0) this.lastFixedDt = context.fixedDt;
    this.logger ??= context.logger.child("scripts");
  }

  private createPending(): void {
    const n = this.live.length;
    for (let i = 0; i < n; i++) {
      const script = this.live[i]!;
      if (script._state !== "pending" || !script.enabled || !this.owners[i]!.enabled) continue;
      script._started = true;
      if (!script.onCreate) {
        script._state = "active";
        this.counters.scriptsCreated++;
        continue;
      }
      // Active only if onCreate returns; a throw faults it (see record()).
      if (this.invoke(script, "create", script.onCreate) && script._state === "pending") {
        script._state = "active";
        this.counters.scriptsCreated++;
      }
    }
  }

  /** Drop destroyed scripts, keeping creation order. Only between hooks, never mid-iteration. */
  private compact(): void {
    let w = 0;
    for (let r = 0; r < this.live.length; r++) {
      const s = this.live[r]!;
      if (s._state === "destroyed") continue;
      this.live[w] = s;
      this.owners[w] = this.owners[r]!;
      w++;
    }
    this.live.length = w;
    this.owners.length = w;
    this.compactPending = false;
  }

  /** Refresh the shared context for `script`: time copies, entity, world, logger. */
  private prepareContext(script: Script): ScriptContext {
    const ft = this.frameTime, t = this.time;
    t.dt = ft.dt;
    t.fixedDt = ft.fixedDt;
    t.elapsed = ft.elapsed;
    t.frame = ft.frame;
    t.alpha = ft.alpha;
    t.fixedStep = ft.fixedStep;
    t.tick = ft.tick;
    const ctx = this.context;
    ctx.entity = script._entity!;
    ctx.world = this.world;
    ctx.time = t;
    ctx.logger = this.logger ?? (this.fallbackLogger ??= new Logger({ scope: "scripts" }));
    return ctx;
  }

  /** Call one hook inside its own structural scope. Returns false when it threw. */
  private invoke(script: Script, phase: ScriptPhase, hook: Hook): boolean {
    const world = this.world;
    // The context object is shared: a nested call (an event handler run inside an emit, a coroutine
    // started from a hook) points it at its own entity, so put the caller's back afterwards.
    const outerEntity = this.context.entity;
    const ctx = this.prepareContext(script);
    const mark = world._beginStructuralScope();
    const createdMark = this.createdStack.length;
    this.hookDepth++;
    this.counters.scriptHookCalls++;
    let failed = false;
    let error: unknown;
    try {
      hook.call(script, ctx);
    } catch (e) {
      failed = true;
      error = e;
    }
    this.context.entity = outerEntity;
    this.hookDepth--;
    world._endStructuralScope(mark, !failed);
    if (!failed) {
      this.createdStack.length = createdMark;
      return true;
    }
    const created = this.createdStack.splice(createdMark);
    for (let i = created.length - 1; i >= 0; i--) world.destroyEntity(created[i]!);
    this.counters.scriptRollbacks++;
    const entity = script._entity?.id ?? (0 as EntityId);
    script._errors++;
    let faulted = false;
    if (script._state !== "destroyed" && script._state !== "faulted" && (phase === "create" || phase === "reload" || (this.faultAfter > 0 && script._errors >= this.faultAfter))) {
      script._state = "faulted";
      faulted = true;
      this._cancelTimers(script);
      this._stopCoroutines(script);
      this.unsubscribeAll(script);
    }
    this.record(script.scriptName, entity, phase, error, faulted);
    return false;
  }

  private record(script: string, entity: EntityId, phase: ScriptPhase, error: unknown, faulted: boolean): void {
    const message = error instanceof Error ? error.message : String(error);
    const rec: ScriptErrorRecord = { script, entity, phase, message, error, frame: this.frameTime.frame, faulted };
    this.counters.scriptErrors++;
    this.errors.push(rec);
    if (this.errors.length > this.errorHistory) this.errors.splice(0, this.errors.length - this.errorHistory);
    (this.logger ?? this.fallbackLogger)?.error(`script ${script} ${phase} threw${faulted ? " (faulted)" : ""}: ${message}`, { entity, phase });
    if (this.onError) {
      try {
        this.onError(rec);
      } catch {
        // An error handler must not become a second failure path.
      }
    }
  }

  // ------------------------------------------------------------------ timers (18.2)

  /** @internal */
  _schedule(script: Script, seconds: number, callback: TimerCallback, repeat: boolean, options: TimerOptions | undefined): TimerHandle {
    if (this.disposed || script._host !== this) throw new UsageError(`${script.scriptName}: this runtime does not own the script`);
    if (script._state === "destroyed" || script._state === "faulted") {
      throw new UsageError(`${script.scriptName}: cannot schedule a timer on a ${script._state} script`);
    }
    const clock = options?.clock ?? "sim";
    let interval: number;
    let due: number;
    if (clock === "sim") {
      const steps = options?.steps !== undefined ? Math.floor(options.steps) : Math.ceil(seconds / this.lastFixedDt - 1e-9);
      if (!(steps >= (repeat ? 1 : 0)) || !Number.isFinite(steps)) throw new UsageError(`timer: invalid duration (${options?.steps ?? seconds})`);
      const n = Math.max(1, steps);
      interval = repeat ? n : 0;
      due = this.fixedTick + n;
    } else {
      if (options?.steps !== undefined) throw new UsageError('timer: "steps" applies to the "sim" clock only');
      if (!(seconds >= 0) || !Number.isFinite(seconds) || (repeat && seconds <= 0)) throw new UsageError(`timer: invalid duration (${seconds})`);
      interval = repeat ? seconds : 0;
      due = this.renderTime + seconds;
    }
    const timer = new Timer(script, clock, due, interval, callback, this.timerSeq++, this.cancelTimer);
    (clock === "sim" ? this.simTimers : this.renderTimers).push(timer);
    (script._timers as Timer[]).push(timer);
    return timer;
  }

  /** @internal */
  _cancelTimers(script: Script): void {
    const timers = script._timers as Timer[];
    while (timers.length > 0) timers[timers.length - 1]!.cancel();
  }

  /** Remove a cancelled or finished timer from its queue and its script. */
  private dropTimer(t: Timer): void {
    t.cancelled = true;
    (t.clock === "sim" ? this.simTimers : this.renderTimers).remove(t);
    const list = (t.owner as Script)._timers as Timer[];
    const i = list.indexOf(t);
    if (i >= 0) list.splice(i, 1);
  }

  /** Fire every timer due at `now`, in (due, creation) order; hold those whose script cannot run. */
  private fireDue(queue: TimerQueue, now: number, clock: "sim" | "render"): void {
    const held = this.heldTimers;
    // Timers scheduled by the callbacks fired here wait for the next pass (an after(0) chain must
    // not spin inside one phase).
    const seqLimit = this.timerSeq;
    for (let top = queue.peek(); top && top.due <= now; top = queue.peek()) {
      queue.pop();
      const script = top.owner as Script;
      if (top.seq >= seqLimit || script._state !== "active" || !script.enabled || !script._component?.enabled) {
        held.push(top);
        continue;
      }
      if (top.interval > 0) {
        if (clock === "sim") {
          do top.due += top.interval;
          while (top.due <= now);
        } else {
          top.due += top.interval;
          if (top.due <= now) top.due = now + top.interval;
        }
        queue.push(top);
      } else {
        this.dropTimer(top);
      }
      top.fires++;
      this.counters.timersFired++;
      const t = top;
      this.invoke(script, "timer", (ctx) => t.callback(ctx, t));
    }
    for (const t of held) if (!t.cancelled) queue.push(t);
    held.length = 0;
  }

  // ------------------------------------------------------------------ coroutines (18.3)

  /** @internal */
  _startCoroutine(script: Script, body: CoroutineBody, options: CoroutineOptions | undefined): CoroutineHandle {
    if (this.disposed || script._host !== this) throw new UsageError(`${script.scriptName}: this runtime does not own the script`);
    if (script._state === "destroyed" || script._state === "faulted") {
      throw new UsageError(`${script.scriptName}: cannot start a coroutine on a ${script._state} script`);
    }
    const clock = options?.clock ?? "render";
    if (clock !== "render" && clock !== "sim") throw new UsageError(`coroutine: unknown clock "${String(clock)}"`);
    const outerEntity = this.context.entity;
    try {
      const ctx = this.prepareContext(script);
      const generator = body.call(script, ctx);
      if (!generator || typeof (generator as Generator).next !== "function") {
        throw new UsageError(`${script.scriptName}: startCoroutine needs a generator function (function* ...)`);
      }
      const co = new Coroutine(script, clock, options?.name ?? (body.name || "coroutine"), generator, this.coroutineSeq++, this);
      (clock === "sim" ? this.simCoroutines : this.renderCoroutines).push(co);
      script._coroutines.push(co);
      // The body runs now, up to its first yield.
      this.stepCoroutine(co, false);
      return co;
    } finally {
      this.context.entity = outerEntity;
    }
  }

  /** @internal */
  _stopCoroutines(script: Script): void {
    const list = script._coroutines as Coroutine[];
    for (const co of [...list]) co.cancel();
  }

  /** @internal Cancel: mark it, then let the generator run its finally blocks. */
  _cancelCoroutine(co: Coroutine): void {
    if (!co.alive) return;
    co.state = "cancelled";
    this.counters.coroutinesCancelled++;
    this.forgetCoroutine(co);
    const script = co.owner as Script;
    this.invoke(script, "coroutine", () => {
      co.executing = true;
      try {
        // A finally that yields suspends the generator again; keep returning until it is closed.
        for (let i = 0; i < 16 && !co.generator.return(undefined).done; i++);
      } finally {
        co.executing = false;
      }
    });
  }

  /** Advance one clock's coroutines by one tick (`dt` seconds for render, one step for sim). */
  private tickCoroutines(list: Coroutine[], dt: number): void {
    const n = list.length;
    let dead = 0;
    for (let i = 0; i < n; i++) {
      const co = list[i]!;
      if (!co.alive) {
        dead++;
        continue;
      }
      if (co.state !== "running") continue;
      const script = co.owner as Script;
      if (script._state !== "active" || !script.enabled || !script._component?.enabled) continue;
      let ready = false;
      let check = false;
      switch (co.waitKind) {
        case "tick":
          ready = true;
          break;
        case "seconds":
          co.waitAmount -= dt;
          ready = co.waitAmount <= 1e-9;
          break;
        case "ticks":
          co.waitAmount -= 1;
          ready = co.waitAmount <= 0;
          break;
        case "until":
        case "while":
          check = true;
          break;
        case "handle":
          ready = !co.waitHandle!.alive;
          break;
      }
      if (ready || check) this.stepCoroutine(co, check);
      if (!co.alive) dead++;
    }
    if (dead > 0) {
      let w = 0;
      for (let r = 0; r < list.length; r++) if (list[r]!.alive) list[w++] = list[r]!;
      list.length = w;
    }
  }

  /** Run one step of a coroutine (optionally gated by its predicate) under hook isolation. */
  private stepCoroutine(co: Coroutine, checkPredicate: boolean): void {
    const script = co.owner as Script;
    const ok = this.invoke(script, "coroutine", (ctx) => {
      co.executing = true;
      try {
        if (checkPredicate) {
          const value = !!co.waitPredicate!();
          if ((co.waitKind === "until") !== value) return;
        }
        const r = co.generator.next(ctx);
        if (r.done) {
          if (co.alive) {
            co.state = "done";
            this.counters.coroutinesCompleted++;
            this.forgetCoroutine(co);
          }
          return;
        }
        this.setWait(co, r.value);
      } catch (e) {
        // Mark it failed before the error reaches invoke(): if the throw faults the script, the
        // fault cancels the script's other coroutines, not this one a second time.
        if (co.alive) {
          co.state = "failed";
          this.counters.coroutinesFailed++;
          this.forgetCoroutine(co);
        }
        throw e;
      } finally {
        co.executing = false;
      }
    });
    if (!ok) {
      // A throw from a predicate or a bad yield leaves the generator suspended: close it so its
      // finally blocks run (after a throw from the body it is already closed and this is a no-op).
      this.invoke(script, "coroutine", () => {
        co.generator.return(undefined);
      });
      return;
    }
    if (co.cancelRequested && co.alive) {
      co.cancelRequested = false;
      this._cancelCoroutine(co);
    }
  }

  private setWait(co: Coroutine, value: CoroutineYield): void {
    co.waitPredicate = null;
    co.waitHandle = null;
    if (value === undefined || value === null) {
      co.waitKind = "tick";
      return;
    }
    if (value instanceof Coroutine) {
      co.waitKind = "handle";
      co.waitHandle = value;
      return;
    }
    const w = value as WaitInstruction;
    switch (w.kind) {
      case "seconds": {
        if (!(w.seconds >= 0) || !Number.isFinite(w.seconds)) throw new UsageError(`Wait.seconds: invalid duration (${w.seconds})`);
        if (co.clock === "sim") {
          co.waitKind = "ticks";
          co.waitAmount = Math.max(1, Math.ceil(w.seconds / this.lastFixedDt - 1e-9));
        } else {
          co.waitKind = "seconds";
          co.waitAmount = w.seconds;
        }
        return;
      }
      case "steps":
      case "frames": {
        const n = w.kind === "steps" ? w.steps : w.frames;
        if ((w.kind === "steps") !== (co.clock === "sim")) throw new UsageError(`Wait.${w.kind} is for ${w.kind === "steps" ? "sim" : "render"} coroutines`);
        if (!(n >= 1) || !Number.isFinite(n)) throw new UsageError(`Wait.${w.kind}: invalid count (${n})`);
        co.waitKind = "ticks";
        co.waitAmount = Math.floor(n);
        return;
      }
      case "until":
      case "while":
        if (typeof w.predicate !== "function") throw new UsageError(`Wait.${w.kind} needs a function`);
        co.waitKind = w.kind;
        co.waitPredicate = w.predicate;
        return;
      default:
        throw new UsageError(`coroutine yielded something that is not a wait: ${String(value)}`);
    }
  }

  private forgetCoroutine(co: Coroutine): void {
    const list = (co.owner as Script)._coroutines as Coroutine[];
    const i = list.indexOf(co);
    if (i >= 0) list.splice(i, 1);
  }

  // ------------------------------------------------------------------ events (18.4)

  /** @internal */
  _subscribe(script: Script, type: EventType<unknown>, handler: ScriptEventHandler<unknown>, options: EventListenOptions | undefined): Disposable {
    if (this.disposed || script._host !== this) throw new UsageError(`${script.scriptName}: this runtime does not own the script`);
    if (script._state === "destroyed" || script._state === "faulted") {
      throw new UsageError(`${script.scriptName}: cannot subscribe on a ${script._state} script`);
    }
    if (!type || typeof type.id !== "number") throw new UsageError("on(): not an event type (use defineEvent)");
    const sub = this.router.subscribe(type, channelOf(options?.entity), script, handler, !!options?.once);
    const subs = script._subscriptions as EventSubscription[];
    // Once-listeners and disposed handles leave dead entries; prune before the list can grow.
    if (subs.length >= 16) {
      let w = 0;
      for (let r = 0; r < subs.length; r++) if (subs[r]!.alive) subs[w++] = subs[r]!;
      subs.length = w;
    }
    subs.push(sub);
    return sub;
  }

  /** @internal */
  _send(script: Script, type: EventType<unknown>, payload: unknown, options: EventSendOptions | undefined, queued: boolean): void {
    if (this.disposed || script._host !== this) throw new UsageError(`${script.scriptName}: this runtime does not own the script`);
    if (!type || typeof type.id !== "number") throw new UsageError("emit(): not an event type (use defineEvent)");
    const channel = channelOf(options?.to);
    if (queued) this.router.post(type, payload, channel);
    else this.router.emit(type, payload, channel);
  }

  private deliverEvent(sub: EventSubscription, payload: unknown): void {
    const owner = sub.owner as Script | null;
    if (!owner) {
      try {
        (sub.handler as (p: unknown) => void)(payload);
      } catch (e) {
        this.record("host", sub.channel, "event", e, false);
      }
      return;
    }
    if (owner._state !== "active" || !owner.enabled || !owner._component?.enabled) return;
    this.invoke(owner, "event", (ctx) => sub.handler(payload, ctx));
  }

  private unsubscribeAll(script: Script): void {
    const subs = script._subscriptions;
    while (subs.length > 0) subs.pop()!.dispose();
  }

  // ------------------------------------------------------------------ lifecycle

  /** Destroy every script (onDestroy runs), unregister the systems and detach from the world. */
  dispose(): void {
    if (this.disposed) return;
    for (const component of [...new Set(this.owners)]) this._release(component);
    this.disposed = true;
    this.live.length = 0;
    this.owners.length = 0;
    this.simTimers.clear();
    this.renderTimers.clear();
    this.simCoroutines.length = 0;
    this.renderCoroutines.length = 0;
    this.router.clear();
    for (const d of this.registrations.splice(0)) d.dispose();
    for (const d of this.subscriptions.splice(0)) d.dispose();
    _bindScriptRuntime(this.world, null);
    runtimes.delete(this.world);
  }
}

class ScriptPhaseSystem extends System {
  override readonly order: number;
  override readonly before: readonly string[] | undefined = undefined;

  constructor(
    private readonly runtime: ScriptRuntime,
    readonly name: string,
    order: number,
    private readonly phase: "preUpdate" | "update" | "lateUpdate",
    before: readonly string[] | undefined,
  ) {
    super();
    this.order = order;
    this.before = before;
  }

  update(context: SystemContext): void {
    this.runtime._run(this.phase, context, 0);
  }

  override stats(): Record<string, number> {
    return this.phase === "preUpdate" ? (this.runtime.stats() as unknown as Record<string, number>) : {};
  }
}

class ScriptFixedPhaseSystem extends FixedSystem {
  readonly name = "scripts.fixed";
  override readonly order = 100;
  override readonly before = ["vehicles", "physics"];

  constructor(private readonly runtime: ScriptRuntime) {
    super();
  }

  fixedStep(context: SystemContext, stepIndex: number): void {
    this.runtime._run("fixedUpdate", context, stepIndex);
  }
}
