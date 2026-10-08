/**
 * @suite scene:coordinateSpaces
 * @group unit
 * @covers engine/src/index.ts
 * @covers engine/src/math/double3.ts
 * @covers engine/src/math/vec.ts
 * @covers engine/src/scene/coordinateSpace.ts
 * @covers engine/src/scene/spaces.ts
 * @desc Phase 9.4 — the coordinate-space API
 */

export const suite = {
  name: "scene:coordinateSpaces",
  group: "unit",
  covers:   [
    "engine/src/index.ts",
    "engine/src/math/double3.ts",
    "engine/src/math/vec.ts",
    "engine/src/scene/coordinateSpace.ts",
    "engine/src/scene/spaces.ts"
  ],
  desc: "Phase 9.4 — the coordinate-space API",
};
/**
 * Phase 9.4 — the coordinate-space API.
 *
 * The claims worth testing here are numerical, not structural: that a 500 km world position survives
 * the trip to render-local float32 with sub-millimetre error (and that *storing* it in float32
 * instead would not), that chunk coordinates floor correctly including negative world coordinates,
 * and that the formal helpers agree with the `CoordinateSpace` that actually recenters the scene.
 */

import assert from "node:assert/strict";
import { assertCloseTo, assertThrows, finish, group, test } from "selrun";
import {
  CoordinateSpace,
  Double3,
  Vec3,
  asWorldPosition,
  chunkCoordinateKey,
  chunkLocalOffset,
  chunkOrigin,
  horizontalDistance,
  renderToWorld,
  terrainToWorld,
  worldDistance,
  worldToChunk,
  worldToRender,
  worldToTerrain,
  writeRenderPosition,
} from "@forge/engine";

group("Phase 9.4 — coordinate spaces", () => {
  test("round-trips world ↔ render-local exactly in float64", () => {
    const origin = asWorldPosition(new Double3(512_000.25, 1_200.5, -88_312.75));
    const world = asWorldPosition(new Double3(512_137.625, 1_202.25, -88_264.5));
    const render = worldToRender(world, origin, new Vec3());
    assertCloseTo(render.x, 137.375, 9);
    assertCloseTo(render.y, 1.75, 9);
    assertCloseTo(render.z, 48.25, 9);
    const back = renderToWorld(render, origin, new Double3());
    assertCloseTo(back.x, world.x, 9);
    assertCloseTo(back.y, world.y, 9);
    assertCloseTo(back.z, world.z, 9);
  });

  test("keeps render-local float32 accurate where an absolute float32 world position is not", () => {
    // 500 km out: a float32 world coordinate is quantised to ~3 cm, so objects jitter by centimetres.
    const world = asWorldPosition(new Double3(500_000.123, 0, 500_000.456));
    const asFloat32WorldX = Math.fround(world.x);
    const absoluteError = Math.abs(asFloat32WorldX - world.x);
    assert.ok(absoluteError > 1e-3); // ~0.03 m: visible jitter

    // Render-relative, the same point keeps sub-millimetre precision.
    const origin = asWorldPosition(new Double3(500_000, 0, 500_000));
    const packed = new Float32Array(3);
    writeRenderPosition(world, origin, packed);
    assertCloseTo(packed[0], 0.123, 4);
    assertCloseTo(packed[2], 0.456, 4);
    const relativeError = Math.max(Math.abs(packed[0]! - 0.123), Math.abs(packed[2]! - 0.456));
    assert.ok(relativeError < 1e-3);
  });

  test("floors chunk coordinates, including across the world origin", () => {
    const size = 256;
    const positive = asWorldPosition(new Double3(300, 0, 513));
    assert.deepEqual(worldToChunk(positive, size), { cx: 1, cz: 2 });

    const negative = asWorldPosition(new Double3(-0.1, 0, -513));
    assert.deepEqual(worldToChunk(negative, size), { cx: -1, cz: -3 });

    const onBoundary = asWorldPosition(new Double3(512, 0, -512));
    assert.deepEqual(worldToChunk(onBoundary, size), { cx: 2, cz: -2 });

    assertThrows(() => worldToChunk(positive, 0), RangeError);
  });

  test("reports a chunk's origin and the offset inside it", () => {
    const size = 128;
    const chunk = { cx: -3, cz: 2 };
    const origin = chunkOrigin(chunk, size, new Double3());
    assert.equal(origin.x, -384);
    assert.equal(origin.z, 256);
    const position = asWorldPosition(new Double3(-380.5, 12, 300.25));
    assert.deepEqual(worldToChunk(position, size), chunk);
    const offset = chunkLocalOffset(position, size, new Vec3());
    assertCloseTo(offset.x, 3.5, 9);
    assertCloseTo(offset.z, 44.25, 9);
    assert.ok(offset.x >= 0);
    assert.ok(offset.x < size);
    assert.equal(chunkCoordinateKey(chunk), "-3:2:0");
    assert.equal(chunkCoordinateKey(chunk, 2), "-3:2:2");
  });

  test("converts between terrain sample coordinates and world positions", () => {
    const world = asWorldPosition(new Double3(-812.5, 341.25, 96.5));
    const coord = worldToTerrain(world, { x: 0, z: 0 });
    assert.deepEqual(coord, { x: -812.5, z: 96.5 });
    const back = terrainToWorld(coord, 341.25, new Double3());
    assert.ok(worldDistance(back, world) < 1e-9);
    // Terrain coordinates are 2D: distances between them are horizontal by definition.
    const other = worldToTerrain(asWorldPosition(new Double3(-800, 0, 100.5)), { x: 0, z: 0 });
    assertCloseTo(horizontalDistance(coord, other), Math.hypot(12.5, 4), 9);
  });

  test("agrees with CoordinateSpace, the object that actually recenters the scene", () => {
    const space = new CoordinateSpace({ recenterDistance: 1000, snapTo: 100 });
    const camera = new Double3(12_345.6, 40, -7_000.2);
    assert.equal(space.maybeRecenter(camera), true);
    assert.notEqual(space.applyPending(), null);

    const world = asWorldPosition(new Double3(12_400, 43, -6_950));
    const viaClass = space.renderPositionOf(world, new Vec3()).clone();
    const viaFunctions = worldToRender(world, space.worldOrigin, new Vec3());
    assertCloseTo(viaClass.x, viaFunctions.x, 9);
    assertCloseTo(viaClass.z, viaFunctions.z, 9);

    const back = space.worldPositionOf(viaClass, new Double3());
    assert.ok(worldDistance(back, world) < 1e-9);
    assert.deepEqual(space.chunkOf(world, 256), worldToChunk(world, 256));
    assert.equal(space.renderSpace.origin.x, space.origin.x);
    assert.equal(space.snapshot().recenters, 1);
  });

  test("keeps a render space's origin live rather than copied", () => {
    const space = new CoordinateSpace({ recenterDistance: 100 });
    const view = space.renderSpace;
    assert.equal(view.origin.x, 0);
    space.requestRecenterTo(new Double3(500, 0, 500));
    space.applyPending();
    assert.equal(view.origin.x, 500); // the view reads the origin, it did not snapshot it
  });
});

await finish();
