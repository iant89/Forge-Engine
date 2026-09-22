/**
 * Worker bootstrap — the file `TaskScheduler` spawns by default.
 *
 * Deliberately tiny: it is the *composition root of the worker thread* (the counterpart of
 * `core/engine.ts` on the main thread), so it may assemble handler packages from other subsystems;
 * the protocol itself lives in `workerScope.ts` and knows nothing about subsystems. It must never
 * import anything DOM-dependent — `window` and `document` do not exist here.
 *
 * A host that needs extra task handlers in the worker (its own, or a subsystem package such as
 * `installTerrainTaskHandlers`) writes its own module worker that calls `installWorkerScope(self, {
 * installHandlers })` and passes it through `TaskSchedulerOptions.workerUrl`.
 */

import { installWorkerScope } from "./workerScope.js";

installWorkerScope(self as unknown as Parameters<typeof installWorkerScope>[0]);
