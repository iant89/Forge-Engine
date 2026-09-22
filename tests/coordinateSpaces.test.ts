/**
 * Phase 9.4 — the coordinate-space API.
 *
 * The claims worth testing here are numerical, not structural: that a 500 km world position survives
 * the trip to render-local float32 with sub-millimetre error (and that *storing* it in float32
 * instead would not), that chunk coordinates floor correctly including negative world coordinates,
 * and that the formal helpers agree with the `CoordinateSpace` that actually recenters the scene.
 */

import { describe, expect, it } from "vitest";
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

describe("Phase 9.4 — coordinate spaces", () => {
  it("round-trips world ↔ render-local exactly in float64", () => {
    const origin = asWorldPosition(new Double3(512_000.25, 1_200.5, -88_312.75));
    const world = asWorldPosition(new Double3(512_137.625, 1_202.25, -88_264.5));
    const render = worldToRender(world, origin, new Vec3());
    expect(render.x).toBeCloseTo(137.375, 9);
    expect(render.y).toBeCloseTo(1.75, 9);
    expect(render.z).toBeCloseTo(48.25, 9);
    const back = renderToWorld(render, origin, new Double3());
    expect(back.x).toBeCloseTo(world.x, 9);
    expect(back.y).toBeCloseTo(world.y, 9);
    expect(back.z).toBeCloseTo(world.z, 9);
  });

  it("keeps render-local float32 accurate where an absolute float32 world position is not", () => {
    // 500 km out: a float32 world coordinate is quantised to ~3 cm, so objects jitter by centimetres.
    const world = asWorldPosition(new Double3(500_000.123, 0, 500_000.456));
    const asFloat32WorldX = Math.fround(world.x);
    const absoluteError = Math.abs(asFloat32WorldX - world.x);
    expect(absoluteError).toBeGreaterThan(1e-3); // ~0.03 m: visible jitter

    // Render-relative, the same point keeps sub-millimetre precision.
    const origin = asWorldPosition(new Double3(500_000, 0, 500_000));
    const packed = new Float32Array(3);
    writeRenderPosition(world, origin, packed);
    expect(packed[0]).toBeCloseTo(0.123, 4);
    expect(packed[2]).toBeCloseTo(0.456, 4);
    const relativeError = Math.max(Math.abs(packed[0]! - 0.123), Math.abs(packed[2]! - 0.456));
    expect(relativeError).toBeLessThan(1e-3);
  });

  it("floors chunk coordinates, including across the world origin", () => {
    const size = 256;
    const positive = asWorldPosition(new Double3(300, 0, 513));
    expect(worldToChunk(positive, size)).toEqual({ cx: 1, cz: 2 });

    const negative = asWorldPosition(new Double3(-0.1, 0, -513));
    expect(worldToChunk(negative, size)).toEqual({ cx: -1, cz: -3 });

    const onBoundary = asWorldPosition(new Double3(512, 0, -512));
    expect(worldToChunk(onBoundary, size)).toEqual({ cx: 2, cz: -2 });

    expect(() => worldToChunk(positive, 0)).toThrow(RangeError);
  });

  it("reports a chunk's origin and the offset inside it", () => {
    const size = 128;
    const chunk = { cx: -3, cz: 2 };
    const origin = chunkOrigin(chunk, size, new Double3());
    expect(origin.x).toBe(-384);
    expect(origin.z).toBe(256);
    const position = asWorldPosition(new Double3(-380.5, 12, 300.25));
    expect(worldToChunk(position, size)).toEqual(chunk);
    const offset = chunkLocalOffset(position, size, new Vec3());
    expect(offset.x).toBeCloseTo(3.5, 9);
    expect(offset.z).toBeCloseTo(44.25, 9);
    expect(offset.x).toBeGreaterThanOrEqual(0);
    expect(offset.x).toBeLessThan(size);
    expect(chunkCoordinateKey(chunk)).toBe("-3:2:0");
    expect(chunkCoordinateKey(chunk, 2)).toBe("-3:2:2");
  });

  it("converts between terrain sample coordinates and world positions", () => {
    const world = asWorldPosition(new Double3(-812.5, 341.25, 96.5));
    const coord = worldToTerrain(world, { x: 0, z: 0 });
    expect(coord).toEqual({ x: -812.5, z: 96.5 });
    const back = terrainToWorld(coord, 341.25, new Double3());
    expect(worldDistance(back, world)).toBeLessThan(1e-9);
    // Terrain coordinates are 2D: distances between them are horizontal by definition.
    const other = worldToTerrain(asWorldPosition(new Double3(-800, 0, 100.5)), { x: 0, z: 0 });
    expect(horizontalDistance(coord, other)).toBeCloseTo(Math.hypot(12.5, 4), 9);
  });

  it("agrees with CoordinateSpace, the object that actually recenters the scene", () => {
    const space = new CoordinateSpace({ recenterDistance: 1000, snapTo: 100 });
    const camera = new Double3(12_345.6, 40, -7_000.2);
    expect(space.maybeRecenter(camera)).toBe(true);
    expect(space.applyPending()).not.toBeNull();

    const world = asWorldPosition(new Double3(12_400, 43, -6_950));
    const viaClass = space.renderPositionOf(world, new Vec3()).clone();
    const viaFunctions = worldToRender(world, space.worldOrigin, new Vec3());
    expect(viaClass.x).toBeCloseTo(viaFunctions.x, 9);
    expect(viaClass.z).toBeCloseTo(viaFunctions.z, 9);

    const back = space.worldPositionOf(viaClass, new Double3());
    expect(worldDistance(back, world)).toBeLessThan(1e-9);
    expect(space.chunkOf(world, 256)).toEqual(worldToChunk(world, 256));
    expect(space.renderSpace.origin.x).toBe(space.origin.x);
    expect(space.snapshot().recenters).toBe(1);
  });

  it("keeps a render space's origin live rather than copied", () => {
    const space = new CoordinateSpace({ recenterDistance: 100 });
    const view = space.renderSpace;
    expect(view.origin.x).toBe(0);
    space.requestRecenterTo(new Double3(500, 0, 500));
    space.applyPending();
    expect(view.origin.x).toBe(500); // the view reads the origin, it did not snapshot it
  });
});
