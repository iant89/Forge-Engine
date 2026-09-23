/**
 * Quadtree Terrain LOD & Geomorphing.
 *
 * Implements:
 *  - Distance-based quadtree LOD selection
 *  - Continuous geomorph factor $\alpha \in [0, 1]$ across LOD transition bands
 *  - Frustum culling of quadtree nodes
 */

import { Vec3 } from "../math/vec.js";
import { AABB, Frustum } from "../math/geometry.js";
import { clamp } from "../math/scalar.js";

export interface LODSelection {
  cx: number;
  cz: number;
  lod: number;
  size: number;
  geomorphAlpha: number;
  bounds: AABB;
}

export interface TerrainLODConfig {
  baseChunkSize: number;
  maxLOD: number;
  lodDistances: number[];
  transitionWidth?: number;
}

export class TerrainLOD {
  readonly baseChunkSize: number;
  readonly maxLOD: number;
  readonly lodDistances: number[];
  readonly transitionWidth: number;

  constructor(config: TerrainLODConfig) {
    this.baseChunkSize = config.baseChunkSize;
    this.maxLOD = config.maxLOD;
    this.lodDistances = [...config.lodDistances];
    this.transitionWidth = config.transitionWidth ?? 0.2; // 20% transition band
  }

  /**
   * Determine LOD level and geomorph factor $\alpha$ for a chunk given distance from camera.
   */
  evaluateDistance(distance: number): { lod: number; alpha: number } {
    for (let l = 0; l < this.lodDistances.length; l++) {
      const dLimit = this.lodDistances[l]!;
      if (distance < dLimit) {
        const dStart = dLimit * (1.0 - this.transitionWidth);
        const alpha = distance > dStart ? clamp((distance - dStart) / (dLimit - dStart), 0, 1) : 0;
        // Clamp so extra distance bands past maxLOD cannot select an unsupported level.
        return { lod: Math.min(l, this.maxLOD), alpha };
      }
    }
    return { lod: this.maxLOD, alpha: 0 };
  }

  /**
   * Select active chunks around camera position within maximum view distance.
   */
  selectVisibleChunks(
    cameraPos: Vec3,
    viewDistance: number,
    frustum?: Frustum,
  ): LODSelection[] {
    const selections: LODSelection[] = [];
    const minChunkRadius = Math.ceil(viewDistance / this.baseChunkSize);

    const camChunkX = Math.floor(cameraPos.x / this.baseChunkSize);
    const camChunkZ = Math.floor(cameraPos.z / this.baseChunkSize);

    const chunkBounds = new AABB();

    for (let dx = -minChunkRadius; dx <= minChunkRadius; dx++) {
      for (let dz = -minChunkRadius; dz <= minChunkRadius; dz++) {
        const cx = camChunkX + dx;
        const cz = camChunkZ + dz;

        const originX = cx * this.baseChunkSize;
        const originZ = cz * this.baseChunkSize;
        const centerX = originX + this.baseChunkSize * 0.5;
        const centerZ = originZ + this.baseChunkSize * 0.5;

        const dist = Math.hypot(cameraPos.x - centerX, cameraPos.z - centerZ);
        if (dist > viewDistance + this.baseChunkSize) continue;

        // Bounding box approximation (assuming height range [-200, 500])
        chunkBounds.min.set(originX, -200, originZ);
        chunkBounds.max.set(originX + this.baseChunkSize, 500, originZ + this.baseChunkSize);

        if (frustum && !frustum.intersectsAABB(chunkBounds)) {
          continue;
        }

        const { lod, alpha } = this.evaluateDistance(dist);
        selections.push({
          cx,
          cz,
          lod,
          size: this.baseChunkSize,
          geomorphAlpha: alpha,
          bounds: new AABB(chunkBounds.min, chunkBounds.max),
        });
      }
    }

    return selections;
  }
}

/**
 * Grid resolution for a LOD level. Nested odd grids so every coarser vertex sits on a finer one:
 *   LOD0 = base (e.g. 33), LOD1 = 17, LOD2 = 9, LOD3 = 5, LOD4 = 3.
 */
export function resolutionForLod(baseResolution: number, lod: number): number {
  const base = Math.max(3, Math.floor(baseResolution));
  const level = Math.max(0, Math.floor(lod));
  return Math.max(3, Math.floor((base - 1) / (1 << level)) + 1);
}

/**
 * Morph a fine-grid height toward the next-coarser nested sample. Vertices that already sit on the
 * coarser lattice are unchanged; odd-index vertices slide toward the bilinear of their coarse parents.
 * `alpha = 0` → fine mesh, `alpha = 1` → fully morphing to the coarser LOD.
 */
export function geomorphHeight(heights: Float32Array, resolution: number, i: number, j: number, alpha: number): number {
  const fine = heights[j * resolution + i]!;
  if (alpha <= 0) return fine;
  const i0 = i & ~1;
  const j0 = j & ~1;
  const i1 = Math.min(i0 + 2, resolution - 1);
  const j1 = Math.min(j0 + 2, resolution - 1);
  if (i0 === i && j0 === j) return fine;
  const fx = i1 === i0 ? 0 : (i - i0) / (i1 - i0);
  const fz = j1 === j0 ? 0 : (j - j0) / (j1 - j0);
  const h00 = heights[j0 * resolution + i0]!;
  const h10 = heights[j0 * resolution + i1]!;
  const h01 = heights[j1 * resolution + i0]!;
  const h11 = heights[j1 * resolution + i1]!;
  const coarse = h00 * (1 - fx) * (1 - fz) + h10 * fx * (1 - fz) + h01 * (1 - fx) * fz + h11 * fx * fz;
  const t = alpha > 1 ? 1 : alpha;
  return fine + (coarse - fine) * t;
}
