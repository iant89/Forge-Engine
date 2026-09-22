/**
 * The worker-side half of the task protocol, factored out of `worker-entry.ts` so it can be
 * installed on any scope-like object.
 *
 * Why this is its own module:
 *  - `worker-entry.ts` is the *default* bootstrap (a browser module worker gets it for free from
 *    `TaskScheduler`'s `new URL("./worker-entry.js", import.meta.url)`), while a host that ships its
 *    own worker file needs exactly the same protocol implementation plus its own handlers. Installing
 *    the scope is what makes that possible without re-implementing the protocol.
 *  - The Node test suites drive the identical code over a `MessagePort`/`worker_threads` adapter, so
 *    "the worker received the task, ran it and delivered the result" is asserted against the shipping
 *    implementation rather than a re-implementation of it.
 *
 * Message protocol (see docs/VERIFICATION.md and `scheduler.ts`):
 *   main → worker : {type:'task', id, name, payload} | {type:'cancel', id}
 *   worker → main : {type:'ready'} | {type:'progress', id, value, detail}
 *                  | {type:'result', id, value} | {type:'error', id, error, inlineFallback}
 *
 * `inlineFallback: true` means "run this one on the main thread instead": the handler is not
 * installed in this worker, or it declared that it needs the main thread by throwing
 * `InlineOnlyError`. The scheduler re-runs it there; a plain failure is reported as a failure.
 */

import { InlineOnlyError } from "../errors.js";
import { hasTaskHandler, runTask, taskResultTransferables, type TaskContext } from "./registry.js";

export interface WorkerIncomingMessage {
  type: "task" | "cancel";
  id: number;
  name?: string;
  payload?: unknown;
}

/**
 * The slice of `DedicatedWorkerGlobalScope` the protocol needs. `self` in a browser worker,
 * `parentPort` wrapped by a host, or a `MessagePort` pair in tests.
 */
export interface WorkerScopeLike {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  addEventListener(type: "message", listener: (event: { data: WorkerIncomingMessage }) => void): void;
}

export interface WorkerScopeOptions {
  /**
   * Extra handlers to install in this worker (a host's own task names, or a subsystem's handler
   * package such as `installTerrainTaskHandlers`). Called once, before the first message is handled;
   * the returned promise delays the `ready` message, so a task submitted immediately after `spawn`
   * can never arrive before the handlers exist.
   */
  installHandlers?: () => void | Promise<void>;
  /** Called once the scope is ready (after `installHandlers` resolved). Used by tests. */
  onReady?: (info: { ready: true }) => void;
}

interface ScopeState {
  ready: boolean;
  pending: WorkerIncomingMessage[];
}

/**
 * Install the task protocol on `scope`. Idempotent per scope object: installing twice on the same
 * object replaces nothing and simply re-registers the listener (a host that installs the scope and
 * then imports `worker-entry.ts` would otherwise handle every message twice and post two results).
 */
const installed = new WeakSet<object>();

export function installWorkerScope(scope: WorkerScopeLike, options: WorkerScopeOptions = {}): void {
  if (installed.has(scope as unknown as object)) return;
  installed.add(scope as unknown as object);

  const cancelled = new Set<number>();
  const state: ScopeState = { ready: false, pending: [] };

  /** Handler installation is asynchronous (registry builtins are a lazy import), so early
   *  messages are queued rather than dropped with "no handler registered". */
  const ready = (async () => {
    const { registerBuiltinTaskHandlers } = await import("./registry.js");
    await registerBuiltinTaskHandlers();
    const extra = options.installHandlers?.();
    if (extra) await extra;
  })().then(
    () => {
      state.ready = true;
      for (const msg of state.pending.splice(0)) handle(msg);
      options.onReady?.({ ready: true });
    },
    () => {
      // No builtins in this build: a host may still have registered handlers directly.
      state.ready = true;
      for (const msg of state.pending.splice(0)) handle(msg);
      options.onReady?.({ ready: true });
    },
  );
  void ready;

  scope.addEventListener("message", (event) => {
    const msg = event.data;
    if (!msg || typeof msg !== "object") return;
    if (!state.ready) {
      state.pending.push(msg);
      return;
    }
    handle(msg);
  });

  function handle(msg: WorkerIncomingMessage): void {
    if (msg.type === "cancel") {
      cancelled.add(msg.id);
      return;
    }
    if (msg.type !== "task" || !msg.name) return;
    const id = msg.id;
    const name = msg.name;
    const ctx: TaskContext = {
      get cancelled() {
        return cancelled.has(id);
      },
      progress: (value, detail) => scope.postMessage({ type: "progress", id, value, detail }),
    };
    void (async () => {
      // A handler the worker does not have (the main thread's registry is the superset) is not a
      // failure: it means "run it on the main thread", which the scheduler honours.
      if (!hasTaskHandler(name)) {
        scope.postMessage({ type: "error", id, error: `no worker handler for "${name}"`, inlineFallback: true });
        return;
      }
      try {
        const value = await runTask(name, msg.payload, ctx);
        if (cancelled.has(id)) return;
        // Big results (terrain grids) are transferred, not copied — the handler returned fresh
        // arrays and must not touch them again, which `installTerrainTaskHandlers` documents.
        scope.postMessage({ type: "result", id, value }, taskResultTransferables(name, value));
      } catch (e) {
        if (cancelled.has(id)) return;
        scope.postMessage({
          type: "error",
          id,
          error: e instanceof Error ? e.message : String(e),
          inlineFallback: e instanceof InlineOnlyError,
        });
      } finally {
        cancelled.delete(id);
      }
    })();
  }
}
