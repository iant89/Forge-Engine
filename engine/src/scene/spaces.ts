/**
 * The engine's coordinate spaces, as types.
 *
 * Forge mixes precisions on purpose (Rule 9: large world coordinates are never casually converted to
 * float32), and every "the world jitters"/"the camera is 3 cm off" bug in a large-world engine is a
 * value that was silently in the wrong space. So the spaces are named, and the conversions between
 * them are the only place a coordinate changes representation:
 *
 * | Space                | Representation            | Meaning                                                    |
 * | -------------------- | ------------------------- | ---------------------------------------------------------- |
 * | `WorldPosition`      | `Double3` (float64)       | Absolute metres in the world. Authoritative: simulation, physics, streaming, save files. |
 * | `LocalPosition`      | `Vec3` (float32)          | Relative to a parent transform (an entity's local position, an instance offset inside a chunk). |
 * | `RenderPosition`     | `Vec3` (float32)          | World minus the render origin. What the GPU sees; small magnitudes, so float32 keeps sub-mm precision. |
 * | `ChunkCoordinate`    | `{ cx, cz }` (integers)   | Which chunk a position is in, for any chunked system (terrain, world population). |
 * | `TerrainCoordinate`  | `{ x, z }` (float64)      | An XZ position in world space where a height field is defined; becomes a `WorldPosition` once a height `y` is sampled. |
 *
 * The brands are compile-time only (`asWorldPosition(v)` is a no-op that returns the same object), so
 * this costs nothing at runtime and cannot drift from the values it describes. The conversions are
 * `out`-parameter functions for the same reason the rest of the math library is: they run per entity
 * per frame.
 *
 * See `docs/COORDINATES.md` for the rules that keep these spaces honest.
 */

import { Double3 } from "../math/double3.js";
import { Vec3 } from "../math/vec.js";

declare const spaceBrand: unique symbol;
type Brand<T, B extends string> = T & { readonly [spaceBrand]?: B };

/** Absolute world position in metres (float64). The only space that may hold 500 km. */
export type WorldPosition = Brand<Double3, "world">;
/** Position relative to a parent transform (float32). */
export type LocalPosition = Brand<Vec3, "local">;
/** World position minus the render origin, ready for the GPU (float32). */
export type RenderPosition = Brand<Vec3, "render">;
/** Integer chunk indices in a chunk grid. */
export interface ChunkCoordinate {
  readonly cx: number;
  readonly cz: number;
}
/** An XZ sample position in world space (float64); a `WorldPosition` once `y` is known. */
export interface TerrainCoordinate {
  readonly x: number;
  readonly z: number;
}

/** Reinterpret a `Double3` as a world position (no-op; the brand is compile-time only). */
export function asWorldPosition(value: Double3): WorldPosition {
  return value as WorldPosition;
}

/** Reinterpret a `Vec3` as a parent-local position (no-op). */
export function asLocalPosition(value: Vec3): LocalPosition {
  return value as LocalPosition;
}

/** Reinterpret a `Vec3` as a render-local position (no-op). */
export function asRenderPosition(value: Vec3): RenderPosition {
  return value as RenderPosition;
}

/** World → render-local. `out` may alias neither input. */
export function worldToRender(world: WorldPosition, origin: WorldPosition, out: Vec3): RenderPosition {
  out.x = world.x - origin.x;
  out.y = world.y - origin.y;
  out.z = world.z - origin.z;
  return out as RenderPosition;
}

/** Render-local → world. The inverse of `worldToRender`. */
export function renderToWorld(render: RenderPosition, origin: WorldPosition, out: Double3): WorldPosition {
  out.set(origin.x + render.x, origin.y + render.y, origin.z + render.z);
  return out as WorldPosition;
}

/**
 * World → render-local straight into a float32 array (the upload path). Uses
 * `Double3.writeRelativeFloat32`, which subtracts in float64 *before* narrowing, so the precision
 * loss is the small render-local magnitude rather than the huge world coordinate.
 */
export function writeRenderPosition(world: WorldPosition, origin: WorldPosition, out: Float32Array, offset = 0): void {
  world.writeRelativeFloat32(origin, out, offset);
}

/** Which chunk a world position falls in. Floors, so negative coordinates land in the right chunk. */
export function worldToChunk(position: WorldPosition | TerrainCoordinate, chunkSize: number): ChunkCoordinate {
  if (!(chunkSize > 0)) throw new RangeError(`chunkSize must be positive (got ${chunkSize})`);
  return { cx: Math.floor(position.x / chunkSize), cz: Math.floor(position.z / chunkSize) };
}

/** World-space origin of a chunk (its minimum corner). */
export function chunkOrigin(chunk: ChunkCoordinate, chunkSize: number, out: Double3): WorldPosition {
  out.set(chunk.cx * chunkSize, 0, chunk.cz * chunkSize);
  return out as WorldPosition;
}

/** Position inside its chunk, in metres from the chunk's minimum corner (always `[0, chunkSize)`). */
export function chunkLocalOffset(position: WorldPosition | TerrainCoordinate, chunkSize: number, out: Vec3): LocalPosition {
  const origin = worldToChunk(position, chunkSize);
  out.x = position.x - origin.cx * chunkSize;
  out.y = 0;
  out.z = position.z - origin.cz * chunkSize;
  return out as LocalPosition;
}

/** Stable key for a chunk, matching `terrain/chunk.ts#chunkKey` at LOD 0. */
export function chunkCoordinateKey(chunk: ChunkCoordinate, lod = 0): string {
  return `${chunk.cx}:${chunk.cz}:${lod}`;
}

/** World position → terrain sample coordinate (drops `y`; a height field is 2D). */
export function worldToTerrain(position: WorldPosition, out: { x: number; z: number }): TerrainCoordinate {
  out.x = position.x;
  out.z = position.z;
  return out as TerrainCoordinate;
}

/** Terrain sample coordinate + a sampled height → world position. */
export function terrainToWorld(coord: TerrainCoordinate, height: number, out: Double3): WorldPosition {
  out.set(coord.x, height, coord.z);
  return out as WorldPosition;
}

/** Horizontal distance between two world positions (the metric chunk selection is built on). */
export function horizontalDistance(a: WorldPosition | TerrainCoordinate, b: WorldPosition | TerrainCoordinate): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

/** 3D distance between two world positions. */
export function worldDistance(a: WorldPosition, b: WorldPosition): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

/**
 * The render origin every `RenderPosition` is relative to: a single float64 world position plus the
 * conversions around it. `CoordinateSpace` (the recentering implementation) exposes this through
 * `renderSpace`; a system that only needs "world ↔ what the GPU sees" can take one of these instead
 * of the whole scene object.
 */
export interface RenderSpace {
  /** World position of render-local (0, 0, 0). */
  readonly origin: WorldPosition;
}

/** Build a `RenderSpace` view over an origin (no copy: the origin is read live). */
export function renderSpaceOf(origin: Double3): RenderSpace {
  return { origin: origin as WorldPosition };
}
