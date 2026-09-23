/**
 * Worker bootstrap — the file `TaskScheduler` spawns by default.
 *
 * Deliberately tiny: it is the *composition root of the worker thread* (the counterpart of
 * `core/engine.ts` on the main thread), so it may assemble handler packages from other subsystems;
 * the protocol itself lives in `workerScope.ts` and knows nothing about subsystems. It must never
 * import anything DOM-dependent — `window` and `document` do not exist here.
 *
 * Terrain cell generation (Phase 10.2) is installed here via dynamic import so the default worker
 * runs the streaming path off the main thread without a static `core → terrain` edge (architecture
 * boundaries still hold for the rest of `core/`). Hosts that need additional handlers still pass
 * `TaskSchedulerOptions.workerUrl` with their own `installWorkerScope(self, { installHandlers })`.
 */

import { installWorkerScope } from "./workerScope.js";

installWorkerScope(self as unknown as Parameters<typeof installWorkerScope>[0], {
  installHandlers: async () => {
    const { installTerrainTaskHandlers } = await import("../../terrain/tasks.js");
    installTerrainTaskHandlers();
  },
});
