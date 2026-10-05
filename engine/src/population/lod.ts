/**
 * Phase 14.4 — population LOD: the CPU side of the GPU-selected LOD (docs/POPULATION.md,
 * ROADMAP 14.4). The *selection* happens on the GPU (the `forge.populationLod` compute pass,
 * `rendering/shaders/populationLod.ts`); this module holds what the CPU must do around it:
 *
 * - `buildLodGeometry` — merge a prototype's hi/lo *windows* into the single unindexed buffer
 *   one LOD batch draws: the high window's triangles first, the low window's after, so a vertex
 *   belongs to the high window iff its triangle index (`vertexIndex / 3`) is below
 *   `hiTriangles`. Unindexed on purpose: indexed merging would also have to merge the index
 *   buffers, and per-vertex `vertexIndex` windowing needs no indices.
 * - `populationLodIndex` — the CPU twin of the shader's decision (distance → window bit). The
 *   mock renderer applies it in place of the dispatch and verifies it produced the GPU's result;
 *   tests compare both sides.
 */

/**
 * One LOD window: an unindexed triangle list in the population prototype's attribute layout
 * (position vec3, normal vec3, UV vec2, tangent vec4; 48-byte vertex stride). `PopulationType`
 * owners supply their hi/lo windows in this shape; `buildLodGeometry` merges them.
 */
export interface PopulationLodWindow {
  positions: Float32Array;
  normals: Float32Array;
  uv: Float32Array;
  /** xyzw, w = handedness (±1). */
  tangent: Float32Array;
}

/** A prototype's two LOD windows. Both are unindexed triangle lists, same attribute set. */
export interface PopulationLodSource {
  /** The near window: full detail. */
  hi: PopulationLodWindow;
  /** The far window: reduced detail. */
  lo: PopulationLodWindow;
}

/**
 * A prototype source in `GeometrySource` field order — what `rockGeometrySource` and friends
 * already produce. `indices` is optional: when absent the positions are already a triangle list.
 */
export interface PopulationLodWindowSource {
  positions: Float32Array;
  normals: Float32Array;
  uvs: Float32Array;
  tangents: Float32Array;
  indices?: Uint32Array | Uint16Array | null;
}

/**
 * Expand a prototype source into an unindexed triangle list (the window shape
 * `buildLodGeometry` wants). Attributes are *duplicated* per index — the unindexed vertex keeps
 * the indexed mesh's smoothed normal/tangent, so hi and lo read as the same surface at different
 * resolutions. The merged buffer stays unindexed on purpose: indexed merging would also have to
 * merge the index buffers, and the vertex stage's window test (`vertexIndex / 3`) needs none.
 */
export function unindexedLodWindow(src: PopulationLodWindowSource): PopulationLodWindow {
  const { positions, normals, uvs, tangents } = src;
  const sourceVertexCount = validateAttributes("source", positions, normals, uvs, tangents);
  const index = src.indices ?? null;
  if (index && (index.length === 0 || index.length % 3 !== 0)) {
    throw new RangeError("unindexedLodWindow: indices must contain a non-empty triangle list");
  }
  if (!index && positions.length % 9 !== 0) {
    throw new RangeError("unindexedLodWindow: unindexed positions must contain a non-empty triangle list");
  }
  const triCount = (index?.length ?? positions.length) / 3;
  const vertCount = triCount * 3;
  if (!index) {
    return { positions, normals, uv: uvs, tangent: tangents };
  }
  const outPositions = new Float32Array(vertCount * 3);
  const outNormals = new Float32Array(vertCount * 3);
  const outUv = new Float32Array(vertCount * 2);
  const outTangent = new Float32Array(vertCount * 4);
  for (let t = 0; t < triCount; t++) {
    for (let v = 0; v < 3; v++) {
      const i = index[t * 3 + v]!;
      if (i >= sourceVertexCount) throw new RangeError(`unindexedLodWindow: index ${i} exceeds ${sourceVertexCount} source vertices`);
      const o = (t * 3 + v) * 3;
      outPositions[o] = positions[i * 3]!;
      outPositions[o + 1] = positions[i * 3 + 1]!;
      outPositions[o + 2] = positions[i * 3 + 2]!;
      outNormals[o] = normals[i * 3]!;
      outNormals[o + 1] = normals[i * 3 + 1]!;
      outNormals[o + 2] = normals[i * 3 + 2]!;
      outUv[t * 6 + v * 2] = uvs[i * 2]!;
      outUv[t * 6 + v * 2 + 1] = uvs[i * 2 + 1]!;
      const o4 = (t * 3 + v) * 4;
      outTangent[o4] = tangents[i * 4]!;
      outTangent[o4 + 1] = tangents[i * 4 + 1]!;
      outTangent[o4 + 2] = tangents[i * 4 + 2]!;
      outTangent[o4 + 3] = tangents[i * 4 + 3]!;
    }
  }
  return { positions: outPositions, normals: outNormals, uv: outUv, tangent: outTangent };
}

/** The merged buffer plus the window boundary the vertex stage tests against. */
export interface PopulationLodGeometry {
  /**
   * Merged, UNINDEXED geometry source: hi's triangles first, then lo's. Pass it to
   * `Geometry.create` (which counts the triangles as `positions.length / 3` when unindexed).
   */
  source: {
    positions: Float32Array;
    normals: Float32Array;
    uvs: Float32Array;
    tangents: Float32Array;
    label?: string;
  };
  /** High window's triangle count: vertices `v` with `v / 3 < hiTriangles` are hi's. */
  hiTriangles: number;
  /** Low window's triangle count. */
  loTriangles: number;
  /** Total vertex count (3 × (hi + lo triangles)). */
  vertexCount: number;
}

function validateAttributes(label: string, positions: Float32Array, normals: Float32Array, uvs: Float32Array, tangents: Float32Array): number {
  if (positions.length === 0 || positions.length % 3 !== 0) {
    throw new RangeError(`${label}: positions must contain a non-empty list of vec3 vertices`);
  }
  const vertices = positions.length / 3;
  if (normals.length !== vertices * 3 || uvs.length !== vertices * 2 || tangents.length !== vertices * 4) {
    throw new RangeError(`${label}: expected normal/UV/tangent lengths ${vertices * 3}/${vertices * 2}/${vertices * 4} for ${vertices} vertices`);
  }
  return vertices;
}

function validateWindow(label: string, window: PopulationLodWindow): number {
  const vertices = validateAttributes(label, window.positions, window.normals, window.uv, window.tangent);
  if (vertices % 3 !== 0) throw new RangeError(`${label}: unindexed LOD windows must contain a whole number of triangles`);
  return vertices;
}

/**
 * Merge the two windows. Both windows must carry the same attribute set and be unindexed
 * triangle lists; no vertex count match is required between windows, which is what lets a
 * 12-triangle high-detail rock pair with a 6-triangle silhouette.
 */
export function buildLodGeometry({ hi, lo }: PopulationLodSource): PopulationLodGeometry {
  const hiVerts = validateWindow("high LOD window", hi);
  const loVerts = validateWindow("low LOD window", lo);
  const vertexCount = hiVerts + loVerts;

  const positions = new Float32Array(vertexCount * 3);
  positions.set(hi.positions, 0);
  positions.set(lo.positions, hiVerts * 3);

  const normals = new Float32Array(vertexCount * 3);
  normals.set(hi.normals, 0);
  normals.set(lo.normals, hiVerts * 3);

  const uvs = new Float32Array(vertexCount * 2);
  uvs.set(hi.uv, 0);
  uvs.set(lo.uv, hiVerts * 2);

  const tangents = new Float32Array(vertexCount * 4);
  tangents.set(hi.tangent, 0);
  tangents.set(lo.tangent, hiVerts * 4);

  return {
    source: { positions, normals, uvs, tangents, label: "population-lod" },
    hiTriangles: hiVerts / 3,
    loTriangles: loVerts / 3,
    vertexCount,
  };
}

/**
 * The window bit the GPU write sets: 0 = high (near), 1 = low (far). A *strict* `>` matches the
 * shader (`distance > lod.lodDistance`), so the boundary distance itself stays on the high
 * window — the conservative side of a pop.
 */
export function populationLodIndex(distance: number, lodDistance: number): number {
  return distance > lodDistance ? 1 : 0;
}
