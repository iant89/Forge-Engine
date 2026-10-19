/**
 * Read-only terrain streaming diagnostics and chunk-bound wireframes (Phase 21.6).
 * The plain-data API is useful to panels/console tools; line segments can be fed to
 * `Renderer.drawLine` without coupling the terrain package to rendering.
 */

import type { EntityId } from "../scene/entityId.js";
import type { TerrainWorld } from "../terrain/world.js";
import type { TerrainChunk } from "../terrain/chunk.js";

export type TerrainChunkState = "pending" | "generating" | "ready" | "disposed";

export interface TerrainChunkDebugInfo {
  key: string;
  cx: number;
  cz: number;
  state: TerrainChunkState;
  lod: number;
  resolution: number;
  geomorphAlpha: number;
  size: number;
  residentBytes: number;
  entityId: EntityId | null;
  bounds: [[number, number, number], [number, number, number]];
  centerHeight: number | null;
}

export interface TerrainDebugSnapshot {
  chunks: number;
  ready: number;
  pending: number;
  generating: number;
  residentBytes: number;
  byLod: Record<string, number>;
  focus: [number, number, number];
  focusForward: [number, number, number];
  viewDistance: number;
  budgets: { memoryBytes: number; generationsPerFrame: number; uploadsPerFrame: number; visibleChunks: number };
  streaming: { generatedThisFrame: number; uploadedThisFrame: number; cancelledThisFrame: number; scheduledThisFrame: number; inlineThisFrame: number; cacheHits: number; cacheMisses: number; residentBytes: number };
  list: TerrainChunkDebugInfo[];
  truncated: boolean;
}

export interface TerrainDebugOptions {
  /** Case-insensitive substring match against chunk keys. */
  filter?: string;
  /** Restrict the chunk list and wireframe output to one LOD. */
  lod?: number;
  /** Maximum chunk records/boxes to emit; defaults to 256. */
  limit?: number;
  /** Vertical extent used for pending chunks without generated height bounds. */
  pendingMinY?: number;
  pendingMaxY?: number;
}

export interface TerrainDebugLine {
  chunkKey: string;
  lod: number;
  start: [number, number, number];
  end: [number, number, number];
  color: number;
}

const BOX_EDGES: ReadonlyArray<readonly [number, number]> = [
  [0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7],
];

const LOD_COLORS = [0xff40e0ff, 0xff40ff80, 0xffffd040, 0xffff8040, 0xffd060ff, 0xffa0a0a0] as const;
const PENDING_COLOR = 0xff707070;

export function inspectTerrain(world: TerrainWorld, options: TerrainDebugOptions = {}): TerrainDebugSnapshot {
  const requestedLimit = options.limit ?? 256;
  const limit = Number.isFinite(requestedLimit) ? Math.max(0, Math.floor(requestedLimit)) : 256;
  const needle = options.filter?.trim().toLowerCase() ?? "";
  const byLod: Record<string, number> = {};
  let ready = 0;
  let pending = 0;
  let generating = 0;
  let residentBytes = 0;
  const matching: TerrainChunk[] = [];

  for (const chunk of world.chunks.values()) {
    byLod[String(chunk.lod)] = (byLod[String(chunk.lod)] ?? 0) + 1;
    residentBytes += chunk.residentBytes;
    if (chunk.state === "ready") ready++;
    else if (chunk.state === "generating") generating++;
    else if (chunk.state === "pending") pending++;
    if (options.lod !== undefined && chunk.lod !== options.lod) continue;
    if (needle && !chunk.key.toLowerCase().includes(needle)) continue;
    matching.push(chunk);
  }

  const list = matching.slice(0, limit).map((chunk) => describeChunk(chunk, options));
  const streaming = world.streamingStats;
  return {
    chunks: world.chunks.size,
    ready,
    pending,
    generating,
    residentBytes,
    byLod,
    focus: [world.focusPosition.x, world.focusPosition.y, world.focusPosition.z],
    focusForward: [world.focusForward.x, world.focusForward.y, world.focusForward.z],
    viewDistance: world.viewDistance,
    budgets: { ...world.budgets },
    streaming: {
      generatedThisFrame: streaming.generatedThisFrame,
      uploadedThisFrame: streaming.uploadedThisFrame,
      cancelledThisFrame: streaming.cancelledThisFrame,
      scheduledThisFrame: streaming.scheduledThisFrame,
      inlineThisFrame: streaming.inlineThisFrame,
      cacheHits: streaming.cacheHits,
      cacheMisses: streaming.cacheMisses,
      residentBytes: streaming.residentBytes,
    },
    list,
    truncated: matching.length > list.length,
  };
}

/** Generate LOD-coloured resident/pending chunk boxes for a debug-line renderer. */
export function terrainDebugLines(world: TerrainWorld, options: TerrainDebugOptions = {}): TerrainDebugLine[] {
  const snapshot = inspectTerrain(world, options);
  const out: TerrainDebugLine[] = [];
  for (const chunk of snapshot.list) {
    const [[minX, minY, minZ], [maxX, maxY, maxZ]] = chunk.bounds;
    const corners: [number, number, number][] = [
      [minX, minY, minZ], [maxX, minY, minZ], [maxX, minY, maxZ], [minX, minY, maxZ],
      [minX, maxY, minZ], [maxX, maxY, minZ], [maxX, maxY, maxZ], [minX, maxY, maxZ],
    ];
    const color = chunk.state === "ready" ? LOD_COLORS[Math.max(0, Math.min(chunk.lod, LOD_COLORS.length - 1))]! : PENDING_COLOR;
    for (const [a, b] of BOX_EDGES) out.push({ chunkKey: chunk.key, lod: chunk.lod, start: [...corners[a]!] as [number, number, number], end: [...corners[b]!] as [number, number, number], color });
  }
  return out;
}

/** Stream line segments to a Renderer-compatible callback. */
export function drawTerrainDebug(
  world: TerrainWorld,
  drawLine: (start: { x: number; y: number; z: number }, end: { x: number; y: number; z: number }, color: number) => void,
  options: TerrainDebugOptions = {},
): number {
  const lines = terrainDebugLines(world, options);
  for (const line of lines) drawLine(
    { x: line.start[0], y: line.start[1], z: line.start[2] },
    { x: line.end[0], y: line.end[1], z: line.end[2] },
    line.color,
  );
  return lines.length;
}

function describeChunk(chunk: TerrainChunk, options: TerrainDebugOptions): TerrainChunkDebugInfo {
  const tile = chunk.tile;
  const bounds = tile
    ? tile.bounds
    : {
        min: { x: chunk.cx * chunk.size, y: options.pendingMinY ?? -50, z: chunk.cz * chunk.size },
        max: { x: (chunk.cx + 1) * chunk.size, y: options.pendingMaxY ?? 50, z: (chunk.cz + 1) * chunk.size },
      };
  const centerHeight = tile ? tile.heightmap.getHeightBilinear((chunk.cx + 0.5) * chunk.size, (chunk.cz + 0.5) * chunk.size) : null;
  return {
    key: chunk.key,
    cx: chunk.cx,
    cz: chunk.cz,
    state: chunk.state,
    lod: chunk.lod,
    resolution: chunk.resolution,
    geomorphAlpha: chunk.geomorphAlpha,
    size: chunk.size,
    residentBytes: chunk.residentBytes,
    entityId: chunk.entityId,
    bounds: [[bounds.min.x, bounds.min.y, bounds.min.z], [bounds.max.x, bounds.max.y, bounds.max.z]],
    centerHeight,
  };
}
