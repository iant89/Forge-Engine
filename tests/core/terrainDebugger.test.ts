/**
 * @suite core:terrainDebugger
 * @group unit
 * @covers engine/src/debug/terrainDebugger.ts
 * @covers engine/src/index.ts
 * @covers engine/src/terrain/chunk.ts
 * @covers engine/src/terrain/world.ts
 * @desc Phase 21.6 — bounded terrain inspection and LOD-coloured chunk bounds
 */

export const suite = {
  name: "core:terrainDebugger",
  group: "unit",
  covers: ["engine/src/debug/terrainDebugger.ts", "engine/src/index.ts", "engine/src/terrain/chunk.ts", "engine/src/terrain/world.ts"],
  desc: "Phase 21.6 — bounded terrain inspection and LOD-coloured chunk bounds",
};

import assert from "node:assert/strict";
import { finish, group, test } from "selrun";
import { GeneratorPipeline, inspectTerrain, TerrainChunk, TerrainTile, TerrainWorld, terrainDebugLines } from "@forge/engine";

group("terrain debugger", () => {
  test("reports streaming state and detached, filtered chunk snapshots", () => {
    const world = new TerrainWorld({ chunkSize: 16, chunkResolution: 5, viewDistance: 48, horizonSkirt: false });
    const pending = new TerrainChunk(1, -2, 16, 5, 1);
    const ready = new TerrainChunk(2, -2, 16, 5, 2);
    ready.tile = new TerrainTile({ cx: 2, cz: -2, size: 16, resolution: 5, lod: 2 }, GeneratorPipeline.createDefault(9), 9);
    ready.state = "ready";
    ready.residentBytes = 2048;
    world.chunks.set(pending.key, pending);
    world.chunks.set(ready.key, ready);

    const snapshot = inspectTerrain(world);
    assert.deepEqual([snapshot.chunks, snapshot.ready, snapshot.pending, snapshot.generating], [2, 1, 1, 0]);
    assert.equal(snapshot.residentBytes, 2048);
    assert.equal(snapshot.byLod["2"], 1);
    assert.equal(snapshot.list[0]!.key, pending.key);
    assert.equal(snapshot.list[1]!.centerHeight !== null, true);
    assert.deepEqual(snapshot.list[0]!.bounds, [[16, -50, -32], [32, 50, -16]]);

    const limited = inspectTerrain(world, { filter: "2:-2", lod: 2, limit: 0 });
    assert.equal(limited.list.length, 0);
    assert.equal(limited.truncated, true);
    const lines = terrainDebugLines(world, { lod: 2 });
    assert.equal(lines.length, 12);
    assert.ok(lines.every((line) => line.chunkKey === ready.key && line.lod === 2 && line.color === 0xffffd040));
    ready.dispose();
    world.dispose();
  });

  test("bounds the returned boxes and distinguishes pending from ready chunks", () => {
    const world = new TerrainWorld({ chunkSize: 8, chunkResolution: 3, horizonSkirt: false });
    const chunk = new TerrainChunk(-1, 0, 8, 3, 0);
    world.chunks.set(chunk.key, chunk);
    const lines = terrainDebugLines(world, { limit: 1, pendingMinY: -3, pendingMaxY: 7 });
    assert.equal(lines.length, 12);
    assert.ok(lines.every((line) => line.color === 0xff707070));
    assert.deepEqual(lines[0]!.start, [-8, -3, 0]);
    assert.deepEqual(lines[0]!.end, [0, -3, 0]);
    assert.equal(inspectTerrain(world, { filter: "not-here" }).list.length, 0);
    world.dispose();
  });
});

finish();
