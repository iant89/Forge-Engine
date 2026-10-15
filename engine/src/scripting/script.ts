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

/** Script hook names, in the order a script first meets them. */
export type ScriptPhase = "create" | "preUpdate" | "fixedUpdate" | "update" | "lateUpdate" | "destroy";

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

  onCreate?(context: ScriptContext): void;
  onPreUpdate?(context: ScriptContext): void;
  onFixedUpdate?(context: ScriptContext): void;
  onUpdate?(context: ScriptContext): void;
  onLateUpdate?(context: ScriptContext): void;
  onDestroy?(context: ScriptContext): void;

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

  /** Name used in errors and stats: the registered name, or the class name. */
  get scriptName(): string {
    return this._name ?? this.constructor.name;
  }
}

/** A script class with a no-argument constructor (what the name registry instantiates). */
export type ScriptConstructor<T extends Script = Script> = new () => T;
