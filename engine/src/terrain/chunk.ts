/**
 * `TerrainChunk` & `TerrainTile` — streamable terrain unit and GPU geometry generator.
 *
 * Implements:
 *  - Deterministic chunk geometry construction with outward CW winding
 *  - Edge skirts to completely eliminate cracks between chunks of differing LODs
 *  - AABB bounding box for frustum culling and raycast acceleration
 */

import { Heightmap } from "./heightmap.js";
import { GeneratorPipeline, createWorldCell, type WorldCell } from "./generators.js";
import { Geometry, type GeometrySource } from "../rendering/geometry.js";
import { AABB } from "../math/geometry.js";
import { Vec3 } from "../math/vec.js";
import type { GraphicsDevice } from "../gpu/device.js";
import type { EntityId } from "../scene/entityId.js";

export function chunkKey(cx: number, cz: number, lod = 0): string {
  return `${cx}:${cz}:${lod}`;
}

export interface TerrainTileOptions {
  cx: number;
  cz: number;
  size: number;
  resolution: number;
  lod?: number;
  skirtDepth?: number;
}

export class TerrainTile {
  readonly cx: number;
  readonly cz: number;
  readonly size: number;
  readonly resolution: number;
  readonly lod: number;
  readonly skirtDepth: number;

  readonly cell: WorldCell;
  readonly heightmap: Heightmap;
  readonly geometrySource: GeometrySource;
  readonly bounds: AABB;

  gpuGeometry: Geometry | null = null;

  constructor(options: TerrainTileOptions, pipeline: GeneratorPipeline, seed: number) {
    this.cx = options.cx;
    this.cz = options.cz;
    this.size = options.size;
    this.resolution = Math.max(2, Math.floor(options.resolution));
    this.lod = options.lod ?? 0;
    this.skirtDepth = options.skirtDepth ?? 8.0;

    this.cell = createWorldCell(this.cx, this.cz, this.size, this.resolution, seed);

    // Execute generation pipeline
    pipeline.execute(this.cell);

    // Build heightmap for continuous sampling & physics
    this.heightmap = new Heightmap({
      originX: this.cx * this.size,
      originZ: this.cz * this.size,
      size: this.size,
      resolution: this.resolution,
      heights: this.cell.heights,
    });

    this.bounds = new AABB(
      new Vec3(this.heightmap.originX, this.heightmap.minHeight - this.skirtDepth, this.heightmap.originZ),
      new Vec3(this.heightmap.originX + this.size, this.heightmap.maxHeight, this.heightmap.originZ + this.size),
    );

    // Build mesh geometry source with skirts
    this.geometrySource = this.buildGeometrySource();
  }

  private buildGeometrySource(): GeometrySource {
    const res = this.resolution;
    const originX = this.cx * this.size;
    const originZ = this.cz * this.size;
    const step = this.size / (res - 1);

    const gridVertexCount = res * res;
    // Skirt: 4 borders * res vertices
    const skirtVertexCount = 4 * res;
    const totalVertexCount = gridVertexCount + skirtVertexCount;

    const positions = new Float32Array(totalVertexCount * 3);
    const normals = new Float32Array(totalVertexCount * 3);
    const uvs = new Float32Array(totalVertexCount * 2);

    const norm = new Vec3();

    // 1. Grid vertices
    for (let j = 0; j < res; j++) {
      for (let i = 0; i < res; i++) {
        const idx = j * res + i;
        const wx = originX + i * step;
        const wz = originZ + j * step;
        const h = this.cell.heights[idx]!;

        const pOff = idx * 3;
        positions[pOff] = wx;
        positions[pOff + 1] = h;
        positions[pOff + 2] = wz;

        this.heightmap.getNormal(wx, wz, norm);
        normals[pOff] = norm.x;
        normals[pOff + 1] = norm.y;
        normals[pOff + 2] = norm.z;

        const uvOff = idx * 2;
        uvs[uvOff] = i / (res - 1);
        uvs[uvOff + 1] = j / (res - 1);
      }
    }

    // 2. Skirt vertices (drop Y by skirtDepth)
    let sIdx = gridVertexCount;

    // Top edge (j = 0)
    for (let i = 0; i < res; i++, sIdx++) {
      const gIdx = i;
      positions[sIdx * 3] = positions[gIdx * 3]!;
      positions[sIdx * 3 + 1] = positions[gIdx * 3 + 1]! - this.skirtDepth;
      positions[sIdx * 3 + 2] = positions[gIdx * 3 + 2]!;
      normals[sIdx * 3] = 0;
      normals[sIdx * 3 + 1] = 0;
      normals[sIdx * 3 + 2] = -1;
      uvs[sIdx * 2] = uvs[gIdx * 2]!;
      uvs[sIdx * 2 + 1] = 0;
    }

    // Bottom edge (j = res - 1)
    for (let i = 0; i < res; i++, sIdx++) {
      const gIdx = (res - 1) * res + i;
      positions[sIdx * 3] = positions[gIdx * 3]!;
      positions[sIdx * 3 + 1] = positions[gIdx * 3 + 1]! - this.skirtDepth;
      positions[sIdx * 3 + 2] = positions[gIdx * 3 + 2]!;
      normals[sIdx * 3] = 0;
      normals[sIdx * 3 + 1] = 0;
      normals[sIdx * 3 + 2] = 1;
      uvs[sIdx * 2] = uvs[gIdx * 2]!;
      uvs[sIdx * 2 + 1] = 1;
    }

    // Left edge (i = 0)
    for (let j = 0; j < res; j++, sIdx++) {
      const gIdx = j * res;
      positions[sIdx * 3] = positions[gIdx * 3]!;
      positions[sIdx * 3 + 1] = positions[gIdx * 3 + 1]! - this.skirtDepth;
      positions[sIdx * 3 + 2] = positions[gIdx * 3 + 2]!;
      normals[sIdx * 3] = -1;
      normals[sIdx * 3 + 1] = 0;
      normals[sIdx * 3 + 2] = 0;
      uvs[sIdx * 2] = 0;
      uvs[sIdx * 2 + 1] = uvs[gIdx * 2 + 1]!;
    }

    // Right edge (i = res - 1)
    for (let j = 0; j < res; j++, sIdx++) {
      const gIdx = j * res + (res - 1);
      positions[sIdx * 3] = positions[gIdx * 3]!;
      positions[sIdx * 3 + 1] = positions[gIdx * 3 + 1]! - this.skirtDepth;
      positions[sIdx * 3 + 2] = positions[gIdx * 3 + 2]!;
      normals[sIdx * 3] = 1;
      normals[sIdx * 3 + 1] = 0;
      normals[sIdx * 3 + 2] = 0;
      uvs[sIdx * 2] = 1;
      uvs[sIdx * 2 + 1] = uvs[gIdx * 2 + 1]!;
    }

    // 3. Triangle indices with CW winding
    const gridQuads = (res - 1) * (res - 1);
    const skirtQuads = 4 * (res - 1);
    const totalQuads = gridQuads + skirtQuads;
    const indices = new Uint32Array(totalQuads * 6);
    let iOff = 0;

    // Grid triangles (CW winding: i00 -> i11 -> i10, i00 -> i01 -> i11)
    for (let j = 0; j < res - 1; j++) {
      for (let i = 0; i < res - 1; i++) {
        const i00 = j * res + i;
        const i10 = j * res + i + 1;
        const i01 = (j + 1) * res + i;
        const i11 = (j + 1) * res + i + 1;

        indices[iOff++] = i00;
        indices[iOff++] = i11;
        indices[iOff++] = i10;

        indices[iOff++] = i00;
        indices[iOff++] = i01;
        indices[iOff++] = i11;
      }
    }

    // Skirt triangles (CW winding outward facing)
    let skirtBase = gridVertexCount;

    // Top skirt (facing -Z)
    for (let i = 0; i < res - 1; i++) {
      const g0 = i;
      const g1 = i + 1;
      const s0 = skirtBase + i;
      const s1 = skirtBase + i + 1;

      indices[iOff++] = g0;
      indices[iOff++] = s1;
      indices[iOff++] = s0;

      indices[iOff++] = g0;
      indices[iOff++] = g1;
      indices[iOff++] = s1;
    }
    skirtBase += res;

    // Bottom skirt (facing +Z)
    for (let i = 0; i < res - 1; i++) {
      const g0 = (res - 1) * res + i;
      const g1 = (res - 1) * res + i + 1;
      const s0 = skirtBase + i;
      const s1 = skirtBase + i + 1;

      indices[iOff++] = g0;
      indices[iOff++] = s0;
      indices[iOff++] = s1;

      indices[iOff++] = g0;
      indices[iOff++] = s1;
      indices[iOff++] = g1;
    }
    skirtBase += res;

    // Left skirt (facing -X)
    for (let j = 0; j < res - 1; j++) {
      const g0 = j * res;
      const g1 = (j + 1) * res;
      const s0 = skirtBase + j;
      const s1 = skirtBase + j + 1;

      indices[iOff++] = g0;
      indices[iOff++] = s0;
      indices[iOff++] = s1;

      indices[iOff++] = g0;
      indices[iOff++] = s1;
      indices[iOff++] = g1;
    }
    skirtBase += res;

    // Right skirt (facing +X)
    for (let j = 0; j < res - 1; j++) {
      const g0 = j * res + (res - 1);
      const g1 = (j + 1) * res + (res - 1);
      const s0 = skirtBase + j;
      const s1 = skirtBase + j + 1;

      indices[iOff++] = g0;
      indices[iOff++] = s1;
      indices[iOff++] = s0;

      indices[iOff++] = g0;
      indices[iOff++] = g1;
      indices[iOff++] = s1;
    }

    return {
      positions,
      normals,
      uvs,
      indices,
      bounds: this.bounds,
      label: `terrain-chunk-${this.cx}-${this.cz}-lod${this.lod}`,
    };
  }

  uploadGpu(device: GraphicsDevice): Geometry {
    if (!this.gpuGeometry) {
      this.gpuGeometry = Geometry.create(device, this.geometrySource);
    }
    return this.gpuGeometry;
  }

  dispose(): void {
    if (this.gpuGeometry) {
      this.gpuGeometry.dispose();
      this.gpuGeometry = null;
    }
  }
}

export type ChunkState = "pending" | "ready" | "disposed";

export class TerrainChunk {
  readonly key: string;
  readonly cx: number;
  readonly cz: number;
  readonly size: number;
  readonly resolution: number;
  readonly lod: number;

  state: ChunkState = "pending";
  tile: TerrainTile | null = null;
  entityId: EntityId | null = null;
  lastAccessed = 0;

  constructor(cx: number, cz: number, size: number, resolution: number, lod = 0) {
    this.key = chunkKey(cx, cz, lod);
    this.cx = cx;
    this.cz = cz;
    this.size = size;
    this.resolution = resolution;
    this.lod = lod;
    this.lastAccessed = performance.now();
  }

  generate(pipeline: GeneratorPipeline, seed: number): void {
    this.tile = new TerrainTile(
      {
        cx: this.cx,
        cz: this.cz,
        size: this.size,
        resolution: this.resolution,
        lod: this.lod,
      },
      pipeline,
      seed,
    );
    this.state = "ready";
  }

  dispose(): void {
    this.state = "disposed";
    if (this.tile) {
      this.tile.dispose();
      this.tile = null;
    }
  }
}
