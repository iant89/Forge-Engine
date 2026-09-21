/**
 * Worker bootstrap.
 *
 * Deliberately tiny: it owns no state other than the map of in-flight tasks, and it must never
 * import anything DOM-dependent. Handlers register themselves via `registerBuiltinTaskHandlers`
 * (which pulls in `taskHandlers.ts`, which in turn imports only pure modules).
 *
 * Message protocol (see docs/ARCHITECTURE.md#threading-model):
 *   main → worker : {type:'task', id, name, payload} | {type:'cancel', id}
 *   worker → main : {type:'ready'} | {type:'progress', id, value, detail}
 *                  | {type:'result', id, value} | {type:'error', id, error, value?}
 *
 * `error` carries `value` when a handler opted into "worker unsupported, retry inline" by
 * throwing `InlineOnlyError` (used by handlers that legitimately need the main thread).
 */

import { registerBuiltinTaskHandlers, runTask, type TaskContext } from "./registry.js";

interface IncomingMessage {
  type: "task" | "cancel";
  id: number;
  name?: string;
  payload?: unknown;
}

interface WorkerScopeLike {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  addEventListener(type: "message", listener: (e: MessageEvent<IncomingMessage>) => void): void;
}

const scope = self as unknown as WorkerScopeLike;
const cancelled = new Set<number>();

/**
 * Builtin handlers arrive asynchronously (the registry's lazy import), so messages that show up
 * before they land are queued instead of failing with "no handler". This is the whole reason the
 * worker can be constructed in the same tick the first task is submitted.
 */
let ready = false;
const pending: IncomingMessage[] = [];

registerBuiltinTaskHandlers().then(
  () => {
    ready = true;
    for (const msg of pending.splice(0)) handle(msg);
  },
  () => {
    ready = true; // no builtins in this build: handlers registered by the page still work
    for (const msg of pending.splice(0)) handle(msg);
  },
);

scope.addEventListener("message", (event) => {
  const msg = event.data;
  if (!msg || typeof msg !== "object") return;
  if (!ready) {
    pending.push(msg);
    return;
  }
  handle(msg);
});

function handle(msg: IncomingMessage): void {
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
    try {
      const value = await runTask(name, msg.payload, ctx);
      if (cancelled.has(id)) return;
      scope.postMessage({ type: "result", id, value });
    } catch (e) {
      if (cancelled.has(id)) return;
      const err = e as Error & { inlineFallback?: boolean };
      scope.postMessage({ type: "error", id, message: err.message ?? String(e), inlineFallback: err.inlineFallback === true });
    }
  })();
}


scope.postMessage({ type: "ready" });
