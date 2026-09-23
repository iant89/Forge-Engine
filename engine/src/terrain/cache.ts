/**
 * Deterministic terrain generation cache (Phase 10.3).
 *
 * Key components match the roadmap: seed / chunkX / chunkZ / generatorVersion / generatorSettings
 * (pipeline hash), plus the grid resolution so LOD meshes don't collide with full-res cells.
 */

import type { TerrainCellTaskResult } from "./tasks.js";

export const TERRAIN_GENERATOR_VERSION = 1;

export interface TerrainCacheKeyParts {
  seed: number;
  chunkX: number;
  chunkZ: number;
  generatorVersion: number;
  /** `hashPipelineSpec` of the generator settings. */
  generatorSettings: number;
  resolution: number;
}

export function terrainCacheKey(parts: TerrainCacheKeyParts): string {
  return `${parts.seed}|${parts.chunkX}|${parts.chunkZ}|${parts.generatorVersion}|${parts.generatorSettings}|${parts.resolution}`;
}

export interface TerrainCacheEntry {
  key: string;
  result: TerrainCellTaskResult;
  bytes: number;
  lastAccessed: number;
}

export interface TerrainGenerationCacheOptions {
  /** Soft byte budget for retained cells (heights+slopes+biomes). */
  maxBytes?: number;
  /** Hard entry count cap (guards against tiny cells exhausting only the count). */
  maxEntries?: number;
}

/**
 * LRU cache of generated terrain cells. Pure data — the streaming path and the height-query path
 * share it so a just-evicted chunk does not re-run the pipeline on the next elevation sample.
 */
export class TerrainGenerationCache {
  readonly maxBytes: number;
  readonly maxEntries: number;
  private readonly entries = new Map<string, TerrainCacheEntry>();
  private totalBytes = 0;
  hits = 0;
  misses = 0;

  constructor(options: TerrainGenerationCacheOptions = {}) {
    this.maxBytes = options.maxBytes ?? 64 * 1024 * 1024;
    this.maxEntries = options.maxEntries ?? 256;
  }

  get size(): number {
    return this.entries.size;
  }

  get bytes(): number {
    return this.totalBytes;
  }

  get(key: string): TerrainCellTaskResult | undefined {
    const entry = this.entries.get(key);
    if (!entry) {
      this.misses++;
      return undefined;
    }
    this.hits++;
    entry.lastAccessed = performance.now();
    // Re-insert for Map insertion-order LRU.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.result;
  }

  set(key: string, result: TerrainCellTaskResult): void {
    const bytes = result.bytes;
    const existing = this.entries.get(key);
    if (existing) {
      this.totalBytes -= existing.bytes;
      this.entries.delete(key);
    }
    this.entries.set(key, { key, result, bytes, lastAccessed: performance.now() });
    this.totalBytes += bytes;
    this.evict();
  }

  has(key: string): boolean {
    return this.entries.has(key);
  }

  clear(): void {
    this.entries.clear();
    this.totalBytes = 0;
  }

  private evict(): void {
    while (
      (this.totalBytes > this.maxBytes || this.entries.size > this.maxEntries) &&
      this.entries.size > 0
    ) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      const entry = this.entries.get(oldest)!;
      this.totalBytes -= entry.bytes;
      this.entries.delete(oldest);
    }
  }
}
