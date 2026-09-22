/**
 * Mesh BVH — the spatial index Phase 9.1 asks to be able to build off the main thread.
 *
 * It lives in `math/` because it is pure geometry over plain arrays with no dependencies: the
 * renderer can use it for culling, physics for raycasts and queries, and the worker can build one
 * because it only needs `math/` (see `core/tasks/taskHandlers.ts` → `geometry.bvh`).
 *
 * Design notes, in order of what a reader will wonder about:
 *
 *  - **Deterministic.** The split axis is the longest axis of the node's *centroid* bounds; the split
 *    position is the median of a stable sort that breaks ties by triangle index. Same arrays in,
 *    byte-identical node arrays and hash out — on the main thread or in a worker. That is what makes
 *    `geometry.bvh` testable as a pure function of its payload.
 *  - **Flat arrays.** The result is four typed arrays (`nodeBounds`, `nodeLeftFirst`, `nodeTriCount`,
 *    `triOrder`), which is what a worker can transfer and what a GPU-side traversal would want. No
 *    object graph, no per-node allocation to hold alive.
 *  - **Median split, not SAH.** A median split needs no per-primitive sort keys and gives a balanced
 *    tree with an O(n log n) build; SAH would build a better tree at several times the cost. The
 *    roadmap's target is "generation can run off-thread", and this is the version that can also run
 *    in a browser worker fast enough to be worth doing.
 *  - **The reference traversal lives here too.** `raycastTriangles()` is the brute-force query the
 *    BVH must agree with, so a test can assert *parity* rather than a hand-written expected value.
 */

import { AABB, Frustum, Ray, RayHit } from "./geometry.js";
import type { Vec3Ops } from "./vec.js";

export interface MeshBvhBuildOptions {
  /** Triangles per leaf, clamped to >= 1. Default 8. */
  leafSize?: number;
  /** Hard depth cap, clamped to >= 0. Default 24. */
  maxDepth?: number;
}

/** The transferable payload of a built BVH (what `geometry.bvh` returns). */
export interface MeshBvhData {
  /** 6 floats per node: minX, minY, minZ, maxX, maxY, maxZ. */
  nodeBounds: Float32Array;
  /** Internal node: index of its left child (right is `left + 1`). Leaf: first index in `triOrder`. */
  nodeLeftFirst: Int32Array;
  /** 0 for internal nodes, triangle count for leaves. */
  nodeTriCount: Int32Array;
  /** Triangle indices, grouped by leaf. */
  triOrder: Uint32Array;
  nodeCount: number;
  leafCount: number;
  maxDepth: number;
  triangleCount: number;
  /** FNV-1a over the node and order arrays — the determinism fingerprint. */
  hash: number;
  bounds: AABB;
}

const EPSILON = 1e-9;

/** FNV-1a over the integer and float bit patterns of a built BVH. */
export function hashBvhData(
  nodeBounds: Float32Array,
  nodeLeftFirst: Int32Array,
  nodeTriCount: Int32Array,
  triOrder: Uint32Array,
): number {
  let h = 0x811c9dc5;
  const mixInt = (value: number): void => {
    h = Math.imul(h ^ (value & 0xffff), 16777619);
    h = Math.imul(h ^ ((value >>> 16) & 0xffff), 16777619);
  };
  const mixFloats = (data: Float32Array): void => {
    const view = new Int32Array(data.buffer, data.byteOffset, data.length);
    for (let i = 0; i < view.length; i++) mixInt(view[i]!);
  };
  mixFloats(nodeBounds);
  for (let i = 0; i < nodeLeftFirst.length; i++) mixInt(nodeLeftFirst[i]!);
  for (let i = 0; i < nodeTriCount.length; i++) mixInt(nodeTriCount[i]!);
  for (let i = 0; i < triOrder.length; i++) mixInt(triOrder[i]!);
  return h >>> 0;
}

export class MeshBvh {
  readonly nodeBounds: Float32Array;
  readonly nodeLeftFirst: Int32Array;
  readonly nodeTriCount: Int32Array;
  readonly triOrder: Uint32Array;
  readonly nodeCount: number;
  readonly leafCount: number;
  readonly maxDepth: number;
  readonly triangleCount: number;
  readonly hash: number;
  readonly bounds: AABB;
  readonly leafSize: number;

  private readonly scratchT: Float32Array;
  private readonly stack: Int32Array;
  /** The geometry the index was built over. Kept by reference; it must stay unchanged. */
  private readonly positions: Float32Array;
  private readonly indices: Uint32Array;

  private constructor(data: MeshBvhData, positions: Float32Array, indices: Uint32Array, leafSize: number) {
    this.positions = positions;
    this.indices = indices;
    this.nodeBounds = data.nodeBounds;
    this.nodeLeftFirst = data.nodeLeftFirst;
    this.nodeTriCount = data.nodeTriCount;
    this.triOrder = data.triOrder;
    this.nodeCount = data.nodeCount;
    this.leafCount = data.leafCount;
    this.maxDepth = data.maxDepth;
    this.triangleCount = data.triangleCount;
    this.hash = data.hash;
    this.bounds = data.bounds;
    this.leafSize = leafSize;
    this.scratchT = new Float32Array(6);
    this.stack = new Int32Array(64);
  }

  // ------------------------------------------------------------------ build

  /**
   * Build a BVH over `indices` (triples into `positions`). Both arrays are kept by reference and
   * must stay unchanged — the index is only valid for the geometry it was built from.
   */
  static build(
    positions: ArrayLike<number>,
    indices: ArrayLike<number>,
    options: MeshBvhBuildOptions = {},
  ): MeshBvh {
    const pos = positions instanceof Float32Array ? positions : Float32Array.from(positions);
    const idx = indices instanceof Uint32Array ? indices : Uint32Array.from(indices);
    const triangleCount = Math.floor(idx.length / 3);
    const leafSize = Math.max(1, Math.floor(options.leafSize ?? 8));
    const maxDepthLimit = Math.max(0, Math.floor(options.maxDepth ?? 24));

    // Per-triangle bounds and centroids (the only per-primitive data the split needs).
    const triBounds = new Float32Array(triangleCount * 6);
    const triCentroid = new Float32Array(triangleCount * 3);
    for (let t = 0; t < triangleCount; t++) {
      const a = idx[t * 3]! * 3;
      const b = idx[t * 3 + 1]! * 3;
      const c = idx[t * 3 + 2]! * 3;
      for (let axis = 0; axis < 3; axis++) {
        const va = pos[a + axis] ?? 0;
        const vb = pos[b + axis] ?? 0;
        const vc = pos[c + axis] ?? 0;
        const lo = Math.min(va, vb, vc);
        const hi = Math.max(va, vb, vc);
        triBounds[t * 6 + axis] = lo;
        triBounds[t * 6 + 3 + axis] = hi;
        triCentroid[t * 3 + axis] = (lo + hi) * 0.5;
      }
    }

    const order = new Uint32Array(triangleCount);
    for (let t = 0; t < triangleCount; t++) order[t] = t;

    const nodeBounds: number[] = [];
    const nodeLeftFirst: number[] = [];
    const nodeTriCount: number[] = [];
    const allocNode = (): number => {
      const node = nodeTriCount.length;
      nodeBounds.push(0, 0, 0, 0, 0, 0);
      nodeLeftFirst.push(-1);
      nodeTriCount.push(0);
      return node;
    };
    let maxDepthReached = 0;

    const writeNodeBounds = (node: number, start: number, end: number): void => {
      let minX = Infinity;
      let minY = Infinity;
      let minZ = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      let maxZ = -Infinity;
      for (let i = start; i < end; i++) {
        const t = order[i]!;
        if (triBounds[t * 6]! < minX) minX = triBounds[t * 6]!;
        if (triBounds[t * 6 + 1]! < minY) minY = triBounds[t * 6 + 1]!;
        if (triBounds[t * 6 + 2]! < minZ) minZ = triBounds[t * 6 + 2]!;
        if (triBounds[t * 6 + 3]! > maxX) maxX = triBounds[t * 6 + 3]!;
        if (triBounds[t * 6 + 4]! > maxY) maxY = triBounds[t * 6 + 4]!;
        if (triBounds[t * 6 + 5]! > maxZ) maxZ = triBounds[t * 6 + 5]!;
      }
      nodeBounds[node * 6] = minX;
      nodeBounds[node * 6 + 1] = minY;
      nodeBounds[node * 6 + 2] = minZ;
      nodeBounds[node * 6 + 3] = maxX;
      nodeBounds[node * 6 + 4] = maxY;
      nodeBounds[node * 6 + 5] = maxZ;
    };

    const buildRange = (node: number, start: number, end: number, depth: number): void => {
      writeNodeBounds(node, start, end);
      if (depth > maxDepthReached) maxDepthReached = depth;
      const count = end - start;
      if (count <= 1) {
        // A single triangle is a leaf at any depth: splitting it would add a node that culls nothing.
        nodeLeftFirst[node] = start;
        nodeTriCount[node] = count;
        return;
      }

      // Split axis: longest centroid extent. A zero extent means the triangles are co-located; keep
      // them as one leaf rather than recursing forever.
      let minC = [Infinity, Infinity, Infinity];
      let maxC = [-Infinity, -Infinity, -Infinity];
      for (let i = start; i < end; i++) {
        const t = order[i]!;
        for (let axis = 0; axis < 3; axis++) {
          const c = triCentroid[t * 3 + axis]!;
          if (c < minC[axis]!) minC[axis] = c;
          if (c > maxC[axis]!) maxC[axis] = c;
        }
      }
      const extents = [maxC[0]! - minC[0]!, maxC[1]! - minC[1]!, maxC[2]! - minC[2]!];
      const axis = extents[0]! >= extents[1]! && extents[0]! >= extents[2]! ? 0 : extents[1]! >= extents[2]! ? 1 : 2;
      const canSplit = count > leafSize && depth < maxDepthLimit && extents[axis]! > 0;
      if (!canSplit) {
        nodeLeftFirst[node] = start;
        nodeTriCount[node] = count;
        return;
      }

      // Median split of the range, ordered by centroid on the split axis and then by triangle index.
      const axisOffset = axis;
      const slice = order.subarray(start, end);
      slice.sort((a, b) => {
        const ca = triCentroid[a * 3 + axisOffset]!;
        const cb = triCentroid[b * 3 + axisOffset]!;
        if (ca !== cb) return ca < cb ? -1 : 1;
        return a - b;
      });
      const mid = start + (count >> 1);
      const left = allocNode();
      const right = allocNode();
      nodeLeftFirst[node] = left;
      nodeTriCount[node] = 0;
      buildRange(left, start, mid, depth + 1);
      buildRange(right, mid, end, depth + 1);
    };

    if (triangleCount > 0) {
      allocNode();
      buildRange(0, 0, triangleCount, 0);
    }

    const bounds = new AABB();
    if (triangleCount > 0) {
      bounds.setFrom(
        { x: nodeBounds[0]!, y: nodeBounds[1]!, z: nodeBounds[2]! },
        { x: nodeBounds[3]!, y: nodeBounds[4]!, z: nodeBounds[5]! },
      );
    }

    const data: MeshBvhData = {
      nodeBounds: Float32Array.from(nodeBounds),
      nodeLeftFirst: Int32Array.from(nodeLeftFirst),
      nodeTriCount: Int32Array.from(nodeTriCount),
      triOrder: order,
      nodeCount: nodeTriCount.length,
      leafCount: nodeTriCount.reduce((sum, n) => sum + (n > 0 ? 1 : 0), 0),
      maxDepth: maxDepthReached,
      triangleCount,
      hash: 0,
      bounds,
    };
    data.hash = hashBvhData(data.nodeBounds, data.nodeLeftFirst, data.nodeTriCount, data.triOrder);
    return new MeshBvh(data, pos, idx, leafSize);
  }

  /** Rebuild a `MeshBvh` from transferred arrays plus the geometry they index. */
  static fromData(data: MeshBvhData, positions: ArrayLike<number>, indices: ArrayLike<number>, leafSize = 8): MeshBvh {
    const pos = positions instanceof Float32Array ? positions : Float32Array.from(positions);
    const idx = indices instanceof Uint32Array ? indices : Uint32Array.from(indices);
    return new MeshBvh(data, pos, idx, Math.max(1, leafSize));
  }

  /** The transferable half of this index (geometry stays behind). */
  data(): MeshBvhData {
    return {
      nodeBounds: this.nodeBounds,
      nodeLeftFirst: this.nodeLeftFirst,
      nodeTriCount: this.nodeTriCount,
      triOrder: this.triOrder,
      nodeCount: this.nodeCount,
      leafCount: this.leafCount,
      maxDepth: this.maxDepth,
      triangleCount: this.triangleCount,
      hash: this.hash,
      bounds: this.bounds,
    };
  }

  private triangleBounds(t: number, out: Float32Array): Float32Array {
    const pos = this.positions;
    const idx = this.indices;
    const a = idx[t * 3]! * 3;
    const b = idx[t * 3 + 1]! * 3;
    const c = idx[t * 3 + 2]! * 3;
    for (let axis = 0; axis < 3; axis++) {
      const va = pos[a + axis] ?? 0;
      const vb = pos[b + axis] ?? 0;
      const vc = pos[c + axis] ?? 0;
      out[axis] = Math.min(va, vb, vc);
      out[axis + 3] = Math.max(va, vb, vc);
    }
    return out;
  }

  /** Slab test against a node's stored bounds. `tMin`/`tMax` are the ray's remaining interval. */
  private nodeIntersectsRay(node: number, origin: Vec3Ops, invDir: Vec3Ops, maxDistance: number): boolean {
    const b = this.nodeBounds;
    let tmin = 0;
    let tmax = maxDistance;
    for (let axis = 0; axis < 3; axis++) {
      const o = axis === 0 ? origin.x : axis === 1 ? origin.y : origin.z;
      const inv = axis === 0 ? invDir.x : axis === 1 ? invDir.y : invDir.z;
      const lo = b[node * 6 + axis]!;
      const hi = b[node * 6 + 3 + axis]!;
      if (Math.abs(inv) < EPSILON) {
        if (o < lo || o > hi) return false;
        continue;
      }
      let t1 = (lo - o) * inv;
      let t2 = (hi - o) * inv;
      if (t1 > t2) {
        const tmp = t1;
        t1 = t2;
        t2 = tmp;
      }
      if (t1 > tmin) tmin = t1;
      if (t2 < tmax) tmax = t2;
      if (tmin > tmax) return false;
    }
    return true;
  }

  /**
   * Nearest triangle hit. Writes `out` (distance, point, normal, index) and returns true on a hit.
   * Ties are broken toward the lower triangle index, so the result does not depend on traversal
   * order — two BVHs over the same geometry agree.
   */
  raycast(ray: Ray, out: RayHit): boolean {
    out.reset();
    if (this.nodeCount === 0 || this.triangleCount === 0) return false;

    let bestT = ray.maxDistance;
    let bestTri = -1;
    const triBounds = this.scratchT;
    const stack = this.stack;
    let top = 0;
    stack[top++] = 0;

    while (top > 0) {
      const node = stack[--top]!;
      if (!this.nodeIntersectsRay(node, ray.origin, ray.invDirection, bestT)) continue;
      const count = this.nodeTriCount[node]!;
      if (count > 0) {
        const first = this.nodeLeftFirst[node]!;
        for (let i = 0; i < count; i++) {
          const t = this.triOrder[first + i]!;
          this.triangleBounds(t, triBounds);
          // Triangle-level reject against the current best hit.
          let inside = true;
          for (let axis = 0; axis < 3 && inside; axis++) {
            const o = axis === 0 ? ray.origin.x : axis === 1 ? ray.origin.y : ray.origin.z;
            const inv = axis === 0 ? ray.invDirection.x : axis === 1 ? ray.invDirection.y : ray.invDirection.z;
            if (Math.abs(inv) >= EPSILON) {
              const t1 = (triBounds[axis]! - o) * inv;
              const t2 = (triBounds[axis + 3]! - o) * inv;
              const lo = Math.min(t1, t2);
              if (lo > bestT) inside = false;
            } else if (o < triBounds[axis]! || o > triBounds[axis + 3]!) {
              inside = false;
            }
          }
          if (!inside) continue;
          const hit = intersectTriangle(this.positions, this.indices, t, ray);
          if (!hit) continue;
          const better =
            hit.t < bestT - 1e-9 || (Math.abs(hit.t - bestT) <= 1e-9 && (bestTri === -1 || t < bestTri));
          if (better) {
            bestT = hit.t;
            bestTri = t;
          }
        }
      } else if (this.nodeLeftFirst[node]! >= 0) {
        stack[top++] = this.nodeLeftFirst[node]!;
        stack[top++] = this.nodeLeftFirst[node]! + 1;
      }
    }

    if (bestTri < 0) return false;
    out.distance = bestT;
    out.index = bestTri;
    out.isValid = true;
    out.point.set(
      ray.origin.x + ray.direction.x * bestT,
      ray.origin.y + ray.direction.y * bestT,
      ray.origin.z + ray.direction.z * bestT,
    );
    writeTriangleNormal(this.positions, this.indices, bestTri, out);
    return true;
  }

  /**
   * Append the triangles whose bounds intersect `frustum` to `out`. This is a *candidate* list: a
   * triangle's bounds can intersect the frustum while the triangle itself does not.
   */
  queryFrustum(frustum: Frustum, out: number[]): number {
    const start = out.length;
    if (this.nodeCount === 0) return 0;
    const box = new AABB();
    const stack = this.stack;
    let top = 0;
    stack[top++] = 0;
    while (top > 0) {
      const node = stack[--top]!;
      readNodeBounds(this.nodeBounds, node, box);
      if (!frustum.intersectsAABB(box)) continue;
      const count = this.nodeTriCount[node]!;
      if (count > 0) {
        for (let i = 0; i < count; i++) out.push(this.triOrder[this.nodeLeftFirst[node]! + i]!);
      } else {
        stack[top++] = this.nodeLeftFirst[node]!;
        stack[top++] = this.nodeLeftFirst[node]! + 1;
      }
    }
    return out.length - start;
  }

  /** Triangles visited by a point-proximity query (kept for callers that need candidates). */
  queryBounds(box: AABB, out: number[]): number {
    const start = out.length;
    if (this.nodeCount === 0) return 0;
    const nodeBox = new AABB();
    const triBox = new Float32Array(6);
    const stack = this.stack;
    let top = 0;
    stack[top++] = 0;
    while (top > 0) {
      const node = stack[--top]!;
      readNodeBounds(this.nodeBounds, node, nodeBox);
      if (!nodeBox.intersectsAABB(box)) continue;
      const count = this.nodeTriCount[node]!;
      if (count > 0) {
        for (let i = 0; i < count; i++) {
          const t = this.triOrder[this.nodeLeftFirst[node]! + i]!;
          this.triangleBounds(t, triBox);
          if (
            triBox[0]! <= box.max.x &&
            triBox[3]! >= box.min.x &&
            triBox[1]! <= box.max.y &&
            triBox[4]! >= box.min.y &&
            triBox[2]! <= box.max.z &&
            triBox[5]! >= box.min.z
          ) {
            out.push(t);
          }
        }
      } else {
        stack[top++] = this.nodeLeftFirst[node]!;
        stack[top++] = this.nodeLeftFirst[node]! + 1;
      }
    }
    return out.length - start;
  }
}

// -------------------------------------------------------------------- helpers

function readNodeBounds(bounds: Float32Array, node: number, out: AABB): AABB {
  out.min.set(bounds[node * 6]!, bounds[node * 6 + 1]!, bounds[node * 6 + 2]!);
  out.max.set(bounds[node * 6 + 3]!, bounds[node * 6 + 4]!, bounds[node * 6 + 5]!);
  return out;
}

/** Möller–Trumbore, two-sided (matches the reference traversal). */
function intersectTriangle(
  positions: Float32Array,
  indices: Uint32Array,
  t: number,
  ray: Ray,
): { t: number; u: number; v: number } | null {
  const i0 = indices[t * 3]! * 3;
  const i1 = indices[t * 3 + 1]! * 3;
  const i2 = indices[t * 3 + 2]! * 3;
  const ax = positions[i0]!;
  const ay = positions[i0 + 1]!;
  const az = positions[i0 + 2]!;
  const e1x = positions[i1]! - ax;
  const e1y = positions[i1 + 1]! - ay;
  const e1z = positions[i1 + 2]! - az;
  const e2x = positions[i2]! - ax;
  const e2y = positions[i2 + 1]! - ay;
  const e2z = positions[i2 + 2]! - az;
  const pvx = ray.direction.y * e2z - ray.direction.z * e2y;
  const pvy = ray.direction.z * e2x - ray.direction.x * e2z;
  const pvz = ray.direction.x * e2y - ray.direction.y * e2x;
  const det = e1x * pvx + e1y * pvy + e1z * pvz;
  if (Math.abs(det) < 1e-12) return null;
  const invDet = 1 / det;
  const tvx = ray.origin.x - ax;
  const tvy = ray.origin.y - ay;
  const tvz = ray.origin.z - az;
  const u = (tvx * pvx + tvy * pvy + tvz * pvz) * invDet;
  if (u < 0 || u > 1) return null;
  const qvx = tvy * e1z - tvz * e1y;
  const qvy = tvz * e1x - tvx * e1z;
  const qvz = tvx * e1y - tvy * e1x;
  const v = (ray.direction.x * qvx + ray.direction.y * qvy + ray.direction.z * qvz) * invDet;
  if (v < 0 || u + v > 1) return null;
  const distance = (e2x * qvx + e2y * qvy + e2z * qvz) * invDet;
  if (distance <= 1e-9) return null;
  return { t: distance, u, v };
}

function writeTriangleNormal(
  positions: Float32Array,
  indices: Uint32Array,
  t: number,
  out: RayHit,
): void {
  const i0 = indices[t * 3]! * 3;
  const i1 = indices[t * 3 + 1]! * 3;
  const i2 = indices[t * 3 + 2]! * 3;
  const ax = positions[i0]!;
  const ay = positions[i0 + 1]!;
  const az = positions[i0 + 2]!;
  const e1x = positions[i1]! - ax;
  const e1y = positions[i1 + 1]! - ay;
  const e1z = positions[i1 + 2]! - az;
  const e2x = positions[i2]! - ax;
  const e2y = positions[i2 + 1]! - ay;
  const e2z = positions[i2 + 2]! - az;
  let nx = e1y * e2z - e1z * e2y;
  let ny = e1z * e2x - e1x * e2z;
  let nz = e1x * e2y - e1y * e2x;
  const length = Math.hypot(nx, ny, nz);
  if (length > EPSILON) {
    nx /= length;
    ny /= length;
    nz /= length;
  } else {
    nx = 0;
    ny = 1;
    nz = 0;
  }
  out.normal.set(nx, ny, nz);
}

/**
 * The brute-force query the BVH must agree with: nearest hit over every triangle, no acceleration
 * structure. Used by callers that need a reference, and by `tests/bvh.test.ts` to assert parity.
 */
export function raycastTriangles(
  positions: ArrayLike<number>,
  indices: ArrayLike<number>,
  ray: Ray,
  out: RayHit,
): boolean {
  out.reset();
  const pos = positions instanceof Float32Array ? positions : Float32Array.from(positions);
  const idx = indices instanceof Uint32Array ? indices : Uint32Array.from(indices);
  const triangleCount = Math.floor(idx.length / 3);
  let bestT = ray.maxDistance;
  let bestTri = -1;
  for (let t = 0; t < triangleCount; t++) {
    const hit = intersectTriangle(pos, idx, t, ray);
    if (!hit) continue;
    if (hit.t < bestT - 1e-9 || (Math.abs(hit.t - bestT) <= 1e-9 && (bestTri === -1 || t < bestTri))) {
      bestT = hit.t;
      bestTri = t;
    }
  }
  if (bestTri < 0) return false;
  out.distance = bestT;
  out.index = bestTri;
  out.isValid = true;
  out.point.set(
    ray.origin.x + ray.direction.x * bestT,
    ray.origin.y + ray.direction.y * bestT,
    ray.origin.z + ray.direction.z * bestT,
  );
  writeTriangleNormal(pos, idx, bestTri, out);
  return true;
}
