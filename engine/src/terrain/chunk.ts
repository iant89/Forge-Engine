/**
 * `TerrainChunk` & `TerrainTile` — streamable terrain unit and GPU geometry generator.
 *
 * Implements:
 *  - Deterministic chunk geometry construction with outward CW winding
 *  - LOD-dependent grid resolution (Phase 10.1) with geomorphing in vertex Y
 *  - Edge skirts to completely eliminate cracks between chunks of differing LODs
 *  - AABB bounding box for frustum culling and raycast acceleration
 */

import { Heightmap } from "./heightmap.js";
import { GeneratorPipeline, createWorldCell, type WorldCell } from "./generators.js";
import { geomorphHeight } from "./lod.js";
import { Geometry, type GeometrySource } from "../rendering/geometry.js";
import { AABB } from "../math/geometry.js";
import { Vec3 } from "../math/vec.js";
import type { GraphicsDevice } from "../gpu/device.js";
import type { EntityId } from "../scene/entityId.js";

export function chunkKey(cx: number, cz: number, lod = 0): string {
  return `${cx}:${cz}:${lod}`;
}

/** Streaming identity ignores LOD so a chunk can remesh in place when LOD changes. */
export function chunkCoordKey(cx: number, cz: number): string {
  return `${cx}:${cz}`;
}

/**
 * Tangent for a heightfield vertex: UV.u increases along world +X, so project +X onto the
 * surface's tangent plane. `w = -1` makes `cross(N, T) * w` (the shader's bitangent) point along
 * +V = world +Z on a Y-up ground plane. Falls back to projecting +Z when N ≈ ±X (degenerate).
 */
function writeHeightfieldTangent(tangents: Float32Array, vertexIndex: number, n: Vec3): void {
  let tx = 1 - n.x * n.x;
  let ty = -n.x * n.y;
  let tz = -n.x * n.z;
  let len = Math.hypot(tx, ty, tz);
  if (len < 1e-5) {
    tx = -n.z * n.x;
    ty = -n.z * n.y;
    tz = 1 - n.z * n.z;
    len = Math.hypot(tx, ty, tz) || 1;
  }
  const o = vertexIndex * 4;
  tangents[o] = tx / len;
  tangents[o + 1] = ty / len;
  tangents[o + 2] = tz / len;
  tangents[o + 3] = -1;
}

/** Skirt side tangent: U still runs along the shared edge axis; pick the in-plane axis by facing. */
function writeSkirtTangent(tangents: Float32Array, vertexIndex: number, nx: number, nz: number): void {
  const o = vertexIndex * 4;
  if (nz !== 0) {
    tangents[o] = 1;
    tangents[o + 1] = 0;
    tangents[o + 2] = 0;
    tangents[o + 3] = nz > 0 ? -1 : 1;
  } else {
    tangents[o] = 0;
    tangents[o + 1] = 0;
    tangents[o + 2] = 1;
    tangents[o + 3] = nx > 0 ? -1 : 1;
  }
}


/** Build a height grid with geomorph baked in (alpha<=0 returns the source array). */
function buildMorphedHeights(heights: Float32Array, resolution: number, alpha: number): Float32Array {
  if (alpha <= 0) return heights;
  const out = new Float32Array(resolution * resolution);
  for (let j = 0; j < resolution; j++) {
    for (let i = 0; i < resolution; i++) {
      out[j * resolution + i] = geomorphHeight(heights, resolution, i, j, alpha);
    }
  }
  return out;
}

export interface TerrainTileOptions {
  cx: number;
  cz: number;
  size: number;
  resolution: number;
  lod?: number;
  skirtDepth?: number;
  /** Geomorph factor baked into vertex Y (0 = fine, 1 = fully coarse). */
  geomorphAlpha?: number;
  /** Pre-built cell (worker / cache path); skips pipeline.execute when provided. */
  cell?: WorldCell;
}

export class TerrainTile {
  readonly cx: number;
  readonly cz: number;
  readonly size: number;
  readonly resolution: number;
  readonly lod: number;
  readonly skirtDepth: number;
  readonly geomorphAlpha: number;

  readonly cell: WorldCell;
  readonly heightmap: Heightmap;
  readonly geometrySource: GeometrySource;
  readonly bounds: AABB;

  gpuGeometry: Geometry | null = null;

  constructor(options: TerrainTileOptions, pipeline?: GeneratorPipeline, seed = 0) {
    this.cx = options.cx;
    this.cz = options.cz;
    this.size = options.size;
    this.resolution = Math.max(2, Math.floor(options.resolution));
    this.lod = options.lod ?? 0;
    this.skirtDepth = options.skirtDepth ?? 8.0;
    this.geomorphAlpha = options.geomorphAlpha ?? 0;

    if (options.cell) {
      if (options.cell.resolution !== this.resolution) {
        throw new Error(
          `TerrainTile cell resolution ${options.cell.resolution} does not match options.resolution ${this.resolution}`,
        );
      }
      this.cell = options.cell;
    } else {
      if (!pipeline) throw new Error("TerrainTile requires a pipeline when no cell is provided");
      this.cell = createWorldCell(this.cx, this.cz, this.size, this.resolution, seed);
      pipeline.execute(this.cell);
    }

    // One surface for mesh Y, normals, and Heightmap queries (vehicles/camera).
    // When alpha>0, bake geomorph into the grid so physics matches the drawn LOD morph.
    const surfaceHeights = buildMorphedHeights(this.cell.heights, this.resolution, this.geomorphAlpha);
    this.heightmap = new Heightmap({
      originX: this.cx * this.size,
      originZ: this.cz * this.size,
      size: this.size,
      resolution: this.resolution,
      heights: surfaceHeights,
    });

    this.bounds = new AABB(
      new Vec3(this.heightmap.originX, this.heightmap.minHeight - this.skirtDepth, this.heightmap.originZ),
      new Vec3(this.heightmap.originX + this.size, this.heightmap.maxHeight, this.heightmap.originZ + this.size),
    );

    this.geometrySource = this.buildGeometrySource();
  }

  /** Build a tile from a worker/cache cell without re-running the pipeline. */
  static fromCell(
    options: Omit<TerrainTileOptions, "cell" | "resolution"> & { cell: WorldCell },
  ): TerrainTile {
    return new TerrainTile({
      ...options,
      resolution: options.cell.resolution,
      cell: options.cell,
    });
  }

  private buildGeometrySource(): GeometrySource {
    const res = this.resolution;
    const originX = this.cx * this.size;
    const originZ = this.cz * this.size;
    const step = this.size / (res - 1);

    const gridVertexCount = res * res;
    const skirtVertexCount = 4 * res;
    const totalVertexCount = gridVertexCount + skirtVertexCount;

    const positions = new Float32Array(totalVertexCount * 3);
    const normals = new Float32Array(totalVertexCount * 3);
    const uvs = new Float32Array(totalVertexCount * 2);
    const tangents = new Float32Array(totalVertexCount * 4);

    const norm = new Vec3();

    for (let j = 0; j < res; j++) {
      for (let i = 0; i < res; i++) {
        const idx = j * res + i;
        const wx = originX + i * step;
        const wz = originZ + j * step;
        // Heightmap already holds the morphed surface (or raw when alpha==0).
        const h = this.heightmap.heights[idx]!;

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

        writeHeightfieldTangent(tangents, idx, norm);
      }
    }

    let sIdx = gridVertexCount;

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
      writeSkirtTangent(tangents, sIdx, 0, -1);
    }

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
      writeSkirtTangent(tangents, sIdx, 0, 1);
    }

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
      writeSkirtTangent(tangents, sIdx, -1, 0);
    }

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
      writeSkirtTangent(tangents, sIdx, 1, 0);
    }

    const gridQuads = (res - 1) * (res - 1);
    const skirtQuads = 4 * (res - 1);
    const totalQuads = gridQuads + skirtQuads;
    const indices = new Uint32Array(totalQuads * 6);
    let iOff = 0;

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

    let skirtBase = gridVertexCount;

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
      tangents,
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

  /** Vertex count of the grid (skirts excluded) — used by LOD tests. */
  get gridVertexCount(): number {
    return this.resolution * this.resolution;
  }

  dispose(): void {
    if (this.gpuGeometry) {
      this.gpuGeometry.dispose();
      this.gpuGeometry = null;
    }
  }
}

export type ChunkState = "pending" | "generating" | "ready" | "disposed";

export class TerrainChunk {
  readonly key: string;
  readonly cx: number;
  readonly cz: number;
  readonly size: number;
  resolution: number;
  lod: number;
  geomorphAlpha = 0;

  state: ChunkState = "pending";
  tile: TerrainTile | null = null;
  entityId: EntityId | null = null;
  lastAccessed = 0;
  /** TaskScheduler key while a generation is in flight (Phase 10.5). */
  taskKey: string | null = null;
  /** Monotonic submit epoch; folded into taskKey so cancel/resubmit identities never collide. */
  taskEpoch = 0;
  /** Estimated resident bytes once ready (also reserved while a worker generation is in flight). */
  residentBytes = 0;
  /**
   * Skirt depth (metres) baked into this chunk's tile. Owned by the streaming world
   * (`TerrainWorldOptions.skirtDepth`) rather than passed per call, because a chunk can remesh at a
   * different LOD and must keep the same skirts across remeshes.
   */
  skirtDepth = 8.0;

  constructor(cx: number, cz: number, size: number, resolution: number, lod = 0) {
    this.key = chunkCoordKey(cx, cz);
    this.cx = cx;
    this.cz = cz;
    this.size = size;
    this.resolution = resolution;
    this.lod = lod;
    this.lastAccessed = performance.now();
  }

  generate(pipeline: GeneratorPipeline, seed: number, geomorphAlpha = this.geomorphAlpha): void {
    this.tile?.dispose();
    this.tile = new TerrainTile(
      {
        cx: this.cx,
        cz: this.cz,
        size: this.size,
        resolution: this.resolution,
        lod: this.lod,
        geomorphAlpha,
        skirtDepth: this.skirtDepth,
      },
      pipeline,
      seed,
    );
    this.geomorphAlpha = geomorphAlpha;
    this.state = "ready";
    this.taskKey = null;
  }

  applyCell(cell: WorldCell, geomorphAlpha = this.geomorphAlpha): void {
    this.tile?.dispose();
    this.resolution = cell.resolution;
    this.tile = TerrainTile.fromCell({
      cx: this.cx,
      cz: this.cz,
      size: this.size,
      lod: this.lod,
      geomorphAlpha,
      skirtDepth: this.skirtDepth,
      cell,
    });
    this.geomorphAlpha = geomorphAlpha;
    this.state = "ready";
    this.taskKey = null;
  }

  dispose(): void {
    this.state = "disposed";
    this.taskKey = null;
    if (this.tile) {
      this.tile.dispose();
      this.tile = null;
    }
  }
}
