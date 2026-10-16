/**
 * Scripting subsystem (Phase 18): gameplay scripts attached to entities, run by a per-world runtime
 * in the frame's hook bands, with failures isolated from the rest of the engine. See
 * docs/SCRIPTING.md.
 */

export { Script, type ScriptConstructor, type ScriptContext, type ScriptPhase, type ScriptState, type ScriptTime } from "./script.js";
export { ScriptComponent } from "./component.js";
export { ScriptRuntime, type ScriptErrorRecord, type ScriptRuntimeOptions, type ScriptRuntimeStats } from "./runtime.js";
