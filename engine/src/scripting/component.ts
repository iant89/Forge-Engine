/**
 * ScriptComponent — attaches {@link Script}s to an entity (Phase 18.1).
 *
 * One component holds any number of scripts (an entity usually has several behaviours, and the
 * world stores one component per type per entity). Scripts are given as instances or as names
 * registered with `ScriptRuntime.define`; a name is resolved when the world's runtime first sees
 * the component, so `new ScriptComponent("RoverController")` works before the class is defined
 * (and is the seam 18.7 hot reload swaps classes through).
 *
 * The component only holds state. The {@link ScriptRuntime} installed on the same world adopts it
 * on attach, runs the hooks and destroys its scripts on detach.
 */

import { Component, registerComponent, type WorldLike } from "../scene/components.js";
import type { Script, ScriptConstructor } from "./script.js";

/** What a runtime exposes to components; implemented by `ScriptRuntime`. */
export interface ScriptBinder {
  _adopt(component: ScriptComponent): void;
  _adoptScript(component: ScriptComponent, script: Script | string): Script | null;
  _destroyScript(script: Script): void;
  _release(component: ScriptComponent): void;
}

const binders = new WeakMap<object, ScriptBinder>();

/** @internal Runtime registration (one runtime per world). */
export function _bindScriptRuntime(world: object, binder: ScriptBinder | null): void {
  if (binder) binders.set(world, binder);
  else binders.delete(world);
}

/** @internal */
export function _scriptBinderOf(world: object): ScriptBinder | undefined {
  return binders.get(world);
}

export class ScriptComponent extends Component {
  static readonly typeName = "Script";
  /** @internal Live scripts, in the order they were added. */
  readonly _scripts: Script[] = [];
  /** @internal Names/instances given before a runtime saw this component. */
  _pending: Array<Script | string> = [];
  /** @internal The runtime that adopted this component. */
  _binder: ScriptBinder | null = null;

  constructor(...scripts: Array<Script | string>) {
    super();
    this._pending.push(...scripts);
  }

  /** Scripts attached so far (names resolve when a runtime adopts the component). */
  get scripts(): readonly Script[] {
    return this._scripts;
  }

  /**
   * Attach another script (instance or registered name). Returns the instance once a runtime has
   * adopted the component, or null while it is still waiting for one (or the name is unknown — the
   * runtime records that as a script error).
   */
  add(script: Script | string): Script | null {
    if (this._binder) return this._binder._adoptScript(this, script);
    this._pending.push(script);
    return typeof script === "string" ? null : script;
  }

  /** Detach one script; it receives onDestroy if it was created. */
  remove(script: Script): boolean {
    const i = this._scripts.indexOf(script);
    if (i >= 0) {
      this._scripts.splice(i, 1);
      this._binder?._destroyScript(script);
      return true;
    }
    const p = this._pending.indexOf(script);
    if (p >= 0) {
      this._pending.splice(p, 1);
      return true;
    }
    return false;
  }

  /** First attached script of a class. */
  get<T extends Script>(ctor: ScriptConstructor<T> | (abstract new () => T)): T | undefined {
    for (const s of this._scripts) if (s instanceof ctor) return s as T;
    return undefined;
  }

  override onAttach(world: WorldLike): void {
    _scriptBinderOf(world)?._adopt(this);
  }

  override onDetach(): void {
    this._binder?._release(this);
  }
}

registerComponent(ScriptComponent as never, {
  name: "Script",
  allowMultiple: false,
  editorGroup: "Gameplay",
});
