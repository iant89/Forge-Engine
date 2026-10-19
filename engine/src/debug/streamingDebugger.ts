/** Read-only diagnostics for asset streaming, background tasks, and scene streaming owners (21.8). */

import type { AssetStreamer, StreamedLoadDebugRecord, StreamingStats } from "../resources/streaming.js";
import type { TaskDebugRecord, TaskScheduler, TaskStats } from "../core/tasks/scheduler.js";
import type { SceneObject } from "../scene/scene.js";

export interface StreamingDebugEngine {
  streamer: Pick<AssetStreamer, "stats" | "inspect">;
  tasks: Pick<TaskScheduler, "stats" | "inspect">;
  currentScene: { objects: readonly SceneObject[] } | null;
}

export interface StreamingObjectDebugInfo {
  name: string;
  enabled: boolean;
  stats: Record<string, number | string | boolean>;
  statsError: string | null;
}

export interface StreamingDebugSnapshot {
  assets: StreamingStats;
  assetLoads: StreamedLoadDebugRecord[];
  truncatedAssetLoads: boolean;
  tasks: TaskStats;
  taskRecords: TaskDebugRecord[];
  truncatedTasks: boolean;
  sceneObjectCount: number;
  streamingObjects: StreamingObjectDebugInfo[];
  truncatedObjects: boolean;
}

export interface StreamingDebugOptions {
  /** Case-insensitive substring filter over asset IDs/kinds, task name/key, and scene-object names. */
  filter?: string;
  /** Output cap for each detail list. Defaults to 128. */
  limit?: number;
}

/** Capture bounded asset/task queue details and stats from scene objects without mutating services. */
export function inspectStreaming(engine: StreamingDebugEngine, options: StreamingDebugOptions = {}): StreamingDebugSnapshot {
  const limit = Number.isFinite(options.limit) ? Math.max(0, Math.min(1024, Math.floor(options.limit!))) : 128;
  const needle = options.filter?.trim().toLowerCase() ?? "";
  const assetInventory = engine.streamer.inspect(Number.MAX_SAFE_INTEGER);
  const taskInventory = engine.tasks.inspect(Number.MAX_SAFE_INTEGER);
  const matchingAssets = assetInventory.filter((item) => !needle || item.id.toLowerCase().includes(needle) || item.kind.toLowerCase().includes(needle));
  const matchingTasks = taskInventory.filter((item) => !needle || item.name.toLowerCase().includes(needle) || item.key.toLowerCase().includes(needle));
  const assetLoads = matchingAssets.slice(0, limit);
  const taskRecords = matchingTasks.slice(0, limit);
  const allObjects = engine.currentScene?.objects ?? [];
  const matchingObjects = allObjects.filter((object) => !needle || object.name.toLowerCase().includes(needle));
  const statObjects = matchingObjects.filter((object) => typeof object.stats === "function");
  const streamingObjects = statObjects.slice(0, limit).map(inspectSceneObject);

  return {
    assets: { ...engine.streamer.stats() },
    assetLoads,
    truncatedAssetLoads: matchingAssets.length > assetLoads.length || assetInventory.length === 1024,
    tasks: { ...engine.tasks.stats },
    taskRecords,
    truncatedTasks: matchingTasks.length > taskRecords.length || taskInventory.length === 1024,
    sceneObjectCount: allObjects.length,
    streamingObjects,
    truncatedObjects: statObjects.length > streamingObjects.length,
  };
}

function inspectSceneObject(object: SceneObject): StreamingObjectDebugInfo {
  try {
    const result = object.stats?.() ?? {};
    const stats: Record<string, number | string | boolean> = {};
    for (const [key, value] of Object.entries(result).slice(0, 128)) {
      if (typeof value === "number" || typeof value === "string" || typeof value === "boolean") stats[key] = value;
    }
    return { name: object.name, enabled: object.enabled, stats, statsError: null };
  } catch (error) {
    return { name: object.name, enabled: object.enabled, stats: {}, statsError: error instanceof Error ? error.message : String(error) };
  }
}
