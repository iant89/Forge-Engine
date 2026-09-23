/**
 * Terrain streaming budgets (Phase 10.7).
 *
 * Replaces the arbitrary `maxChunksLoaded`-only model with four independent budgets the world
 * spends each frame. `maxChunksLoaded` remains as a synonym for the visible-chunk budget so
 * existing scenes keep compiling.
 */

export interface TerrainBudgets {
  /** Soft cap on resident chunk GPU+CPU geometry bytes. */
  memoryBytes: number;
  /** Max cell generations that may *start* this frame (worker submit or inline). */
  generationsPerFrame: number;
  /** Max GPU uploads (Geometry.create) this frame. */
  uploadsPerFrame: number;
  /** Max chunks kept resident because they are currently selected. */
  visibleChunks: number;
}

export interface TerrainBudgetOptions {
  memoryBytes?: number;
  generationsPerFrame?: number;
  uploadsPerFrame?: number;
  visibleChunks?: number;
  /** Back-compat alias for `visibleChunks`. */
  maxChunksLoaded?: number;
  /** Back-compat alias for `generationsPerFrame`. */
  maxGenerationsPerFrame?: number;
}

export const DEFAULT_TERRAIN_BUDGETS: TerrainBudgets = {
  memoryBytes: 96 * 1024 * 1024,
  generationsPerFrame: 4,
  uploadsPerFrame: 4,
  visibleChunks: 64,
};

export function resolveTerrainBudgets(options: TerrainBudgetOptions = {}): TerrainBudgets {
  return {
    memoryBytes: options.memoryBytes ?? DEFAULT_TERRAIN_BUDGETS.memoryBytes,
    generationsPerFrame:
      options.generationsPerFrame ?? options.maxGenerationsPerFrame ?? DEFAULT_TERRAIN_BUDGETS.generationsPerFrame,
    uploadsPerFrame: options.uploadsPerFrame ?? DEFAULT_TERRAIN_BUDGETS.uploadsPerFrame,
    visibleChunks: options.visibleChunks ?? options.maxChunksLoaded ?? DEFAULT_TERRAIN_BUDGETS.visibleChunks,
  };
}

/** Rough CPU-side byte cost of a resident tile (grids + mesh source). */
export function estimateTileBytes(resolution: number): number {
  const verts = resolution * resolution + 4 * resolution; // grid + skirts
  const indexCount = ((resolution - 1) * (resolution - 1) + 4 * (resolution - 1)) * 6;
  // heights+slopes+biomes grids + positions/normals/uvs/tangents + indices
  const grids = resolution * resolution * (4 + 4 + 16);
  const mesh = verts * (12 + 12 + 8 + 16) + indexCount * 4;
  return grids + mesh;
}
