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
        return { lod: l, alpha };
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
