/**
 * @suite core:streamingDebugger
 * @group unit
 * @covers engine/src/core/engine.ts
 * @covers engine/src/core/tasks/scheduler.ts
 * @covers engine/src/debug/streamingDebugger.ts
 * @covers engine/src/index.ts
 * @covers engine/src/resources/streaming.ts
 * @covers engine/src/scene/scene.ts
 * @covers engine/src/terrain/world.ts
 * @desc Phase 21.8 — bounded asset/task streaming inventory and scene-owner diagnostics
 */

export const suite = {
  name: "core:streamingDebugger",
  group: "unit",
  covers: [
    "engine/src/core/engine.ts",
    "engine/src/core/tasks/scheduler.ts",
    "engine/src/debug/streamingDebugger.ts",
    "engine/src/index.ts",
    "engine/src/resources/streaming.ts",
    "engine/src/scene/scene.ts",
    "engine/src/terrain/world.ts",
  ],
  desc: "Phase 21.8 — bounded asset/task streaming inventory and scene-owner diagnostics",
};

import assert from "node:assert/strict";
import { finish, group, test } from "selrun";
import {
  AssetStreamer,
  inspectStreaming,
  registerTaskHandler,
  ResourceRegistry,
  Scene,
  TaskScheduler,
  TerrainWorld,
  type ResourceDescriptor,
} from "@forge/engine";

group("streaming debugger", () => {
  test("combines asset queue, worker-pool tasks, and scene streaming-owner snapshots", async () => {
    let release!: () => void;
    registerTaskHandler("tests.streaming.debug", async (payload: { tag: string }) => {
      await new Promise<void>((resolve) => { release = resolve; });
      return payload.tag;
    });
    const tasks = new TaskScheduler({ inline: true, maxConcurrent: 1 });
    const running = tasks.submit({ name: "tests.streaming.debug", key: "terrain:running", payload: { tag: "ok" } });
    const queued = tasks.submit({ name: "tests.streaming.debug", key: "terrain:queued", payload: { tag: "later" } });
    assert.equal(typeof release, "function");

    const streamer = new AssetStreamer(new ResourceRegistry(), { maxConcurrent: 1, uploadBudgetBytes: 4096 });
    const descriptor: ResourceDescriptor<string> = {
      id: "terrain.heightmap",
      kind: "terrain",
      estimatedBytes: 128,
      load: async () => "heightmap",
      dispose: () => undefined,
    };
    const asset = streamer.request(descriptor);
    const scene = new Scene({ name: "streaming-debug" });
    scene.addObject(new TerrainWorld({ horizonSkirt: false }));

    const snapshot = inspectStreaming({ streamer, tasks, currentScene: scene }, { limit: 1 });
    assert.deepEqual([snapshot.assets.queued, snapshot.assets.inFlight], [1, 0]);
    assert.deepEqual([snapshot.assetLoads.length, snapshot.assetLoads[0]!.id, snapshot.assetLoads[0]!.estimatedBytes], [1, "terrain.heightmap", 128]);
    assert.deepEqual([snapshot.tasks.running, snapshot.tasks.queued], [1, 1]);
    assert.equal(snapshot.taskRecords.length, 1);
    assert.equal(snapshot.truncatedTasks, true);
    assert.equal(snapshot.sceneObjectCount, 1);
    assert.equal(snapshot.streamingObjects[0]!.name, "TerrainWorld");
    assert.deepEqual(snapshot.streamingObjects[0]!.stats.chunks, 0);

    const filtered = inspectStreaming({ streamer, tasks, currentScene: scene }, { filter: "terrain", limit: 10 });
    assert.equal(filtered.assetLoads.length, 1);
    assert.equal(filtered.taskRecords.length, 2);
    assert.equal(filtered.streamingObjects.length, 1);

    assert.equal(streamer.cancel(asset.id), true);
    assert.equal(tasks.cancel("terrain:queued"), true);
    release();
    assert.equal(await running, "ok");
    await assert.rejects(queued);
    streamer.dispose();
    tasks.dispose();
    scene.objects[0]?.dispose?.();
  });

  test("limits diagnostic detail and safely handles absent scenes", () => {
    const tasks = new TaskScheduler({ inline: true });
    const streamer = new AssetStreamer(new ResourceRegistry());
    const snapshot = inspectStreaming({ streamer, tasks, currentScene: null }, { limit: 0 });
    assert.equal(snapshot.sceneObjectCount, 0);
    assert.deepEqual(snapshot.streamingObjects, []);
    assert.deepEqual(snapshot.taskRecords, []);
    assert.equal(snapshot.truncatedTasks, false);
    streamer.dispose();
    tasks.dispose();
  });
});

finish();
