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
 * (24-byte stride, `GeometrySource` fields). `PopulationType` owners supply their hi/lo windows
 * in this shape; `buildLodGeometry` merges them.
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

/**
 * Merge the two windows. Both windows must carry the same attribute set and be unindexed
 * triangle lists; `hi` may have any (even) count — no vertex count match is required between
 * windows, which is what makes a 12-triangle rock and a 6-triangle silhouette pair up.
 */
export function buildLodGeometry({ hi, lo }: PopulationLodSource): PopulationLodGeometry {
  const hiVerts = hi.positions.length;
  const loVerts = lo.positions.length;
  const vertexCount = hiVerts + loVerts;

  const positions = new Float32Array(vertexCount);
  positions.set(hi.positions, 0);
  positions.set(lo.positions, hiVerts);

  const normals = new Float32Array(vertexCount);
  normals.set(hi.normals, 0);
  normals.set(lo.normals, hiVerts);

  const uvs = new Float32Array(vertexCount);
  uvs.set(hi.uv, 0);
  uvs.set(lo.uv, hiVerts);

  const tangents = new Float32Array(vertexCount);
  tangents.set(hi.tangent, 0);
  tangents.set(lo.tangent, hiVerts);

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
