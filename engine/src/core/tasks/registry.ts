/**
 * Task handler registry — the contract between the main thread and worker threads.
 *
 * Handlers must be **pure functions of their payload**: no DOM, no engine state, no wall clock,
 * no `Math.random`, no iteration over externally-supplied objects whose order can vary. That is
 * what allows the same work to run inline or on N workers with bit-identical results, which is
 * what makes deterministic streaming worlds possible.
 *
 * Payloads and results are structured-cloneable (`ArrayBuffer`s, typed arrays, plain objects);
 * transfer lists make the big ones zero-copy.
 */

import { UsageError } from "../errors.js";
import type { Logger } from "../log.js";

/**
 * A handler that cannot run on a worker thread re-throws this (or throws it directly) and the task is
 * re-run inline. Re-exported here so a handler imports one module, not two.
 */
export { InlineOnlyError } from "../errors.js";

export interface TaskContext {
  /** Cooperative cancellation. Long-running handlers must poll this between chunks. */
  readonly cancelled: boolean;
  /** Report progress in [0,1]. Cheap; main thread fans it out to `onProgress` listeners. */
  progress(value: number, detail?: unknown): void;
  logger?: Logger;
}

export type TaskHandler<P = unknown, R = unknown> = (payload: P, ctx: TaskContext) => R | Promise<R>;

const handlers = new Map<string, TaskHandler<unknown, unknown>>();
/** Result → transferables, so a worker posts big grids without a structured-clone copy. */
const resultTransfers = new Map<string, (result: unknown) => Transferable[]>();
let builtinsRegistered = false;

/**
 * Declare which buffers a task's result owns and can hand over. The worker scope applies it when
 * posting a result; the main thread uses nothing here today (it receives) but keeps the table so a
 * host worker and the engine agree on one description.
 */
export function registerTaskResultTransfer(name: string, fn: (result: unknown) => Transferable[]): void {
  resultTransfers.set(name, fn);
}

export function taskResultTransferables(name: string, result: unknown): Transferable[] {
  const fn = resultTransfers.get(name);
  if (!fn) return [];
  try {
    return fn(result);
  } catch {
    return [];
  }
}

export function hasTaskResultTransfer(name: string): boolean {
  return resultTransfers.has(name);
}

export function registerTaskHandler<P, R>(name: string, fn: TaskHandler<P, R>): void {
  if (handlers.has(name)) {
    // Re-registering with a different implementation would silently change worker behaviour.
    throw new UsageError(`Task handler "${name}" is already registered`);
  }
  handlers.set(name, fn as TaskHandler<unknown, unknown>);
}

let builtinsPromise: Promise<void> | null = null;

/**
 * Idempotent registration of the handlers shipped with the engine (called by `Engine` and by the
 * worker bootstrap).
 *
 * The import is asynchronous on purpose — the registry must stay dependency-free because the worker
 * imports it *before* anything else exists — so callers that submit a builtin task straight away must
 * await the returned promise (or `builtinTaskHandlersReady()`), which is what `TaskScheduler` does.
 */
export function registerBuiltinTaskHandlers(): Promise<void> {
  if (!builtinsPromise) {
    builtinsPromise = import("./taskHandlers.js").then(
      (m: { installTaskHandlers?: (register: typeof registerTaskHandler) => void }) => {
        m.installTaskHandlers?.(registerTaskHandler);
        builtinsRegistered = true;
      },
      () => {
        /* module missing in a stripped build: handlers simply are not available */
      },
    );
  }
  return builtinsPromise;
}

/** Resolves once builtin handlers are registered (or immediately if the module was absent). */
export function builtinTaskHandlersReady(): Promise<void> {
  return builtinsPromise ?? Promise.resolve();
}

/** True when registration finished (used by tests that assert the worker path is warm). */
export function builtinTaskHandlersInstalled(): boolean {
  return builtinsRegistered;
}

export function hasTaskHandler(name: string): boolean {
  return handlers.has(name);
}

export function getTaskHandler(name: string): TaskHandler<unknown, unknown> | undefined {
  return handlers.get(name);
}

export function listTaskHandlers(): string[] {
  return [...handlers.keys()].sort();
}

/** Used by both the inline fallback and the worker bootstrap. */
export async function runTask(name: string, payload: unknown, ctx: TaskContext): Promise<unknown> {
  const fn = handlers.get(name);
  if (!fn) throw new UsageError(`No task handler registered for "${name}"`);
  return await fn(payload, ctx);
}

/** Test hook: wipe all handlers. */
export function clearTaskHandlers(): void {
  handlers.clear();
  builtinsRegistered = false;
}
