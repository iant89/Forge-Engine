/**
 * `Heightmap` — dense 2D elevation grid with continuous bicubic and bilinear sampling.
 *
 * Guaranteed properties:
 * - Continuous $C^1$ height and normal sampling via bicubic Catmull-Rom interpolation,
 *   so physics bodies and vehicle tires never experience impulse spikes crossing cell lines.
 * - Exact correspondence with `TerrainChunk` geometry.
 * - Fast grid-marching raycast for collision queries and line-of-sight.
 */

import { Vec3 } from "../math/vec.js";
import { AABB, Ray, RayHit } from "../math/geometry.js";
import { clamp } from "../math/scalar.js";

/** 1D Catmull-Rom cubic spline interpolation across 4 points. */
function cubicHermite(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const t2 = t * t;
  const t3 = t2 * t;
  return (
    0.5 *
    (2 * p1 +
      (-p0 + p2) * t +
      (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 +
      (-p0 + 3 * p1 - 3 * p2 + p3) * t3)
  );
}

export interface HeightmapOptions {
  originX?: number;
  originZ?: number;
  size: number;
  resolution: number;
  heights?: Float32Array;
}

export class Heightmap {
  readonly originX: number;
  readonly originZ: number;
  readonly size: number;
  readonly resolution: number;
  readonly heights: Float32Array;
  readonly cellSize: number;
  readonly bounds: AABB;

  minHeight = Infinity;
  maxHeight = -Infinity;

  constructor(options: HeightmapOptions) {
    this.originX = options.originX ?? 0;
    this.originZ = options.originZ ?? 0;
    this.size = options.size;
    this.resolution = Math.max(2, Math.floor(options.resolution));
    this.cellSize = this.size / (this.resolution - 1);

    const count = this.resolution * this.resolution;
    if (options.heights) {
      if (options.heights.length < count) {
        throw new Error(`Heightmap: heights array length ${options.heights.length} < required ${count}`);
      }
      this.heights = options.heights;
    } else {
      this.heights = new Float32Array(count);
    }

    this.computeExtents();
    this.bounds = new AABB(
      new Vec3(this.originX, this.minHeight - 1.0, this.originZ),
      new Vec3(this.originX + this.size, this.maxHeight + 1.0, this.originZ + this.size),
    );
  }

  computeExtents(): void {
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < this.heights.length; i++) {
      const h = this.heights[i]!;
      if (h < min) min = h;
      if (h > max) max = h;
    }
    if (min === Infinity) {
      min = 0;
      max = 0;
    }
    this.minHeight = min;
    this.maxHeight = max;
    if (this.bounds) {
      this.bounds.min.set(this.originX, this.minHeight - 1.0, this.originZ);
      this.bounds.max.set(this.originX + this.size, this.maxHeight + 1.0, this.originZ + this.size);
    }
  }

  /** Direct grid sample by integer coordinates (clamped to boundaries). */
  sampleGrid(i: number, j: number): number {
    const ci = Math.max(0, Math.min(this.resolution - 1, i));
    const cj = Math.max(0, Math.min(this.resolution - 1, j));
    return this.heights[cj * this.resolution + ci]!;
  }

  /** Continuous bicubic Catmull-Rom elevation query. */
  getHeight(worldX: number, worldZ: number): number {
    const lx = (worldX - this.originX) / this.cellSize;
    const lz = (worldZ - this.originZ) / this.cellSize;

    const i = Math.floor(lx);
    const j = Math.floor(lz);
    const fx = lx - i;
    const fz = lz - j;

    // 4 rows of 4 samples along X
    const row0 = cubicHermite(
      this.sampleGrid(i - 1, j - 1),
      this.sampleGrid(i, j - 1),
      this.sampleGrid(i + 1, j - 1),
      this.sampleGrid(i + 2, j - 1),
      fx,
    );
    const row1 = cubicHermite(
      this.sampleGrid(i - 1, j),
      this.sampleGrid(i, j),
      this.sampleGrid(i + 1, j),
      this.sampleGrid(i + 2, j),
      fx,
    );
    const row2 = cubicHermite(
      this.sampleGrid(i - 1, j + 1),
      this.sampleGrid(i, j + 1),
      this.sampleGrid(i + 1, j + 1),
      this.sampleGrid(i + 2, j + 1),
      fx,
    );
    const row3 = cubicHermite(
      this.sampleGrid(i - 1, j + 2),
      this.sampleGrid(i, j + 2),
      this.sampleGrid(i + 1, j + 2),
      this.sampleGrid(i + 2, j + 2),
      fx,
    );

    return cubicHermite(row0, row1, row2, row3, fz);
  }

  /** Fast bilinear elevation query. */
  getHeightBilinear(worldX: number, worldZ: number): number {
    const lx = clamp((worldX - this.originX) / this.cellSize, 0, this.resolution - 1);
    const lz = clamp((worldZ - this.originZ) / this.cellSize, 0, this.resolution - 1);

    const i = Math.floor(lx);
    const j = Math.floor(lz);
    const fx = lx - i;
    const fz = lz - j;

    const h00 = this.sampleGrid(i, j);
    const h10 = this.sampleGrid(i + 1, j);
    const h01 = this.sampleGrid(i, j + 1);
    const h11 = this.sampleGrid(i + 1, j + 1);

    const top = h00 * (1 - fx) + h10 * fx;
    const bot = h01 * (1 - fx) + h11 * fx;
    return top * (1 - fz) + bot * fz;
  }

  /**
   * Surface normal computed via central finite difference from continuous bicubic elevation.
   */
  getNormal(worldX: number, worldZ: number, out = new Vec3()): Vec3 {
    const eps = Math.max(0.01, this.cellSize * 0.25);
    const hL = this.getHeight(worldX - eps, worldZ);
    const hR = this.getHeight(worldX + eps, worldZ);
    const hD = this.getHeight(worldX, worldZ - eps);
    const hU = this.getHeight(worldX, worldZ + eps);

    const dx = (hR - hL) / (2 * eps);
    const dz = (hU - hD) / (2 * eps);

    out.set(-dx, 1, -dz);
    return out.normalize();
  }

  /** Slope angle in radians relative to horizontal plane [0, pi/2]. */
  getSlope(worldX: number, worldZ: number): number {
    const eps = Math.max(0.01, this.cellSize * 0.25);
    const hL = this.getHeight(worldX - eps, worldZ);
    const hR = this.getHeight(worldX + eps, worldZ);
    const hD = this.getHeight(worldX, worldZ - eps);
    const hU = this.getHeight(worldX, worldZ + eps);

    const dx = (hR - hL) / (2 * eps);
    const dz = (hU - hD) / (2 * eps);
    return Math.atan(Math.hypot(dx, dz));
  }

  /**
   * Raycast against the heightmap surface using grid interval marching.
   */
  raycast(ray: Ray, hit: RayHit): boolean {
    const boxHit = new RayHit();
    if (!ray.intersectsAABB(this.bounds, boxHit) && !this.bounds.containsPoint(ray.origin)) {
      return false;
    }

    const tRange = new Float32Array([0, Math.min(ray.maxDistance, 1e6)]);
    if (!this.bounds.intersectsRay(ray.origin, ray.invDirection, tRange)) {
      if (!this.bounds.containsPoint(ray.origin)) return false;
      tRange[0] = 0;
      tRange[1] = Math.min(ray.maxDistance, this.size * 2);
    }
    const tStart = Math.max(0, tRange[0]!);
    const tEnd = Math.min(ray.maxDistance, tRange[1]!);
    if (tStart >= tEnd) return false;

    // March ray through grid cells in steps proportional to cell size
    const step = Math.max(0.1, this.cellSize * 0.5);
    let prevT = tStart;
    let prevX = ray.origin.x + ray.direction.x * prevT;
    let prevY = ray.origin.y + ray.direction.y * prevT;
    let prevZ = ray.origin.z + ray.direction.z * prevT;
    let prevDiff = prevY - this.getHeightBilinear(prevX, prevZ);

    for (let t = tStart + step; t <= tEnd + step; t += step) {
      const curT = Math.min(t, tEnd);
      const curX = ray.origin.x + ray.direction.x * curT;
      const curY = ray.origin.y + ray.direction.y * curT;
      const curZ = ray.origin.z + ray.direction.z * curT;
      const curHeight = this.getHeightBilinear(curX, curZ);
      const curDiff = curY - curHeight;

      if (prevDiff >= 0 && curDiff <= 0) {
        // Zero crossing detected between prevT and curT: refine with binary search
        let lo = prevT;
        let hi = curT;
        for (let iter = 0; iter < 8; iter++) {
          const mid = (lo + hi) * 0.5;
          const mx = ray.origin.x + ray.direction.x * mid;
          const my = ray.origin.y + ray.direction.y * mid;
          const mz = ray.origin.z + ray.direction.z * mid;
          if (my - this.getHeightBilinear(mx, mz) > 0) {
            lo = mid;
          } else {
            hi = mid;
          }
        }
        const hitT = (lo + hi) * 0.5;
        if (hitT < ray.maxDistance && (!hit.isValid || hitT < hit.distance)) {
          hit.distance = hitT;
          hit.point.set(
            ray.origin.x + ray.direction.x * hitT,
            ray.origin.y + ray.direction.y * hitT,
            ray.origin.z + ray.direction.z * hitT,
          );
          this.getNormal(hit.point.x, hit.point.z, hit.normal);
          hit.isValid = true;
          return true;
        }
      }

      prevT = curT;
      prevX = curX;
      prevY = curY;
      prevZ = curZ;
      prevDiff = curDiff;
    }

    return false;
  }
}
