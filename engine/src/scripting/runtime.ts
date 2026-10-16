/**
 * ScriptRuntime — runs {@link Script} hooks for one world (Phase 18.1) and isolates their failures
 * (Phase 18.5).
 *
 * `ScriptRuntime.install(world)` registers four systems, one per hook band (see scene/systems.ts):
 *
 *   scripts.pre     order   0   onCreate (pending scripts) · onPreUpdate
 *   scripts.fixed   order 100   onFixedUpdate once per fixed step, before "vehicles" and "physics"
 *   scripts.update  order 200   onUpdate
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
import type { Script, ScriptConstructor, ScriptContext, ScriptPhase, ScriptTime } from "./script.js";

export interface ScriptRuntimeOptions {
  /** Errors a script may throw before it is faulted. Default 1; 0 = never fault (still recorded). */
  faultAfter?: number;
  /** How many recent errors `errors` keeps. Default 32. */
  errorHistory?: number;
  /** Logger for script errors. Default: the frame's logger, scoped `scripts`. */
  logger?: Logger;
  /** Called for every recorded error (after the script's state is updated). */
  onError?: (error: ScriptErrorRecord) => void;
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

export class ScriptRuntime implements ScriptBinder {
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
  private readonly frameTime = { dt: 0, fixedDt: 0, elapsed: 0, frame: 0, alpha: 0, fixedStep: 0 };
  private readonly time: { -readonly [K in keyof ScriptTime]: ScriptTime[K] } = { dt: 0, fixedDt: 0, elapsed: 0, frame: 0, alpha: 0, fixedStep: 0 };
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
  };

  private constructor(world: EntityWorld, options: ScriptRuntimeOptions) {
    this.world = world;
    this.faultAfter = Math.max(0, Math.floor(options.faultAfter ?? 1));
    this.errorHistory = Math.max(1, Math.floor(options.errorHistory ?? 32));
    this.onError = options.onError;
    this.logger = options.logger ?? null;
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
    const hookName = HOOK_OF[phase];
    const n = this.live.length;
    for (let i = 0; i < n; i++) {
      const script = this.live[i]!;
      if (script._state !== "active" || !script.enabled || !this.owners[i]!.enabled) continue;
      const hook = script[hookName];
      if (hook) this.invoke(script, phase, hook);
    }
  }

  private capture(context: SystemContext, phase: ScriptPhase, fixedStep: number): void {
    const t = this.frameTime;
    t.fixedDt = context.fixedDt;
    t.dt = phase === "fixedUpdate" ? context.fixedDt : context.dt;
    t.elapsed = context.elapsed;
    t.frame = context.frame;
    t.alpha = context.alpha;
    t.fixedStep = phase === "fixedUpdate" ? fixedStep : 0;
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

  /** Call one hook inside its own structural scope. Returns false when it threw. */
  private invoke(script: Script, phase: ScriptPhase, hook: Hook): boolean {
    const world = this.world;
    const ft = this.frameTime, t = this.time;
    t.dt = ft.dt;
    t.fixedDt = ft.fixedDt;
    t.elapsed = ft.elapsed;
    t.frame = ft.frame;
    t.alpha = ft.alpha;
    t.fixedStep = ft.fixedStep;
    const ctx = this.context;
    ctx.entity = script._entity!;
    ctx.world = world;
    ctx.time = t;
    ctx.logger = this.logger ?? (this.fallbackLogger ??= new Logger({ scope: "scripts" }));
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
    if (script._state !== "destroyed" && script._state !== "faulted" && (phase === "create" || (this.faultAfter > 0 && script._errors >= this.faultAfter))) {
      script._state = "faulted";
      faulted = true;
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

  // ------------------------------------------------------------------ lifecycle

  /** Destroy every script (onDestroy runs), unregister the systems and detach from the world. */
  dispose(): void {
    if (this.disposed) return;
    for (const component of [...new Set(this.owners)]) this._release(component);
    this.disposed = true;
    this.live.length = 0;
    this.owners.length = 0;
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
