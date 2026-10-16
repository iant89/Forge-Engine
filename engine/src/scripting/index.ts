/**
 * Scripting subsystem (Phase 18): gameplay scripts attached to entities, run by a per-world runtime
 * in the frame's hook bands, with failures isolated from the rest of the engine. See
 * docs/SCRIPTING.md.
 */

export { Script, type ScriptConstructor, type ScriptContext, type ScriptPhase, type ScriptState, type ScriptTime } from "./script.js";
export { ScriptComponent } from "./component.js";
export { type TimerCallback, type TimerClock, type TimerHandle, type TimerOptions } from "./timers.js";
export { Wait, type CoroutineBody, type CoroutineClock, type CoroutineHandle, type CoroutineOptions, type CoroutineState, type CoroutineYield, type WaitInstruction } from "./coroutines.js";
export { ScriptRuntime, type ScriptErrorRecord, type ScriptReloadReport, type ScriptRuntimeOptions, type ScriptRuntimeStats } from "./runtime.js";
export { defineEvent, type EventListenOptions, type EventPayload, type EventSendOptions, type EventType, type HostEventHandler, type ScriptEventHandler, type ScriptEvents } from "./events.js";
