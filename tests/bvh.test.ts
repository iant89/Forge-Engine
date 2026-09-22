import { describe, expect, it } from "vitest";
import {
  AABB,
  Frustum,
  Mat4,
  MeshBvh,
  Ray,
  RayHit,
  Vec3,
  buildBvhTask,
  raycastTriangles,
  type BvhTaskResult,
} from "@forge/engine";

/**
 * Phase 9.1 — the mesh BVH.
 *
 * The roadmap's bullet is "verify BVH/LBVH generation can execute outside the main thread". An
 * algorithm is only worth moving off-thread if it is (a) correct, (b) deterministic, and (c) cheap
 * enough to be worth the round trip; and the *transfer* path has to survive structured clone with
 * typed arrays. This suite pins all four: parity with a brute-force traversal, byte-identical
 * rebuilds, node/leaf bookkeeping, and the `geometry.bvh` task payload/result round trip through
 * `buildBvhTask` (the same function the worker runs — see tests/tasks.test.ts for the real thread).
 */

/** Deterministic triangle soup: a jittered grid of quads split into triangles. */
function buildSoup(cells = 24, spacing = 2.5, seed = 7): { positions: Float32Array; indices: Uint32Array } {
  let state = seed >>> 0;
  const rand = (): number => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
  const grid = cells + 1;
  const positions = new Float32Array(grid * grid * 3);
  for (let z = 0; z < grid; z++) {
    for (let x = 0; x < grid; x++) {
      const i = (z * grid + x) * 3;
      positions[i] = (x - cells / 2) * spacing + (rand() - 0.5) * 0.8;
      positions[i + 1] = Math.sin(x * 0.4) * 1.5 + Math.cos(z * 0.3) * 1.5 + (rand() - 0.5) * 0.6;
      positions[i + 2] = (z - cells / 2) * spacing + (rand() - 0.5) * 0.8;
    }
  }
  const indices = new Uint32Array(cells * cells * 6);
  let t = 0;
  for (let z = 0; z < cells; z++) {
    for (let x = 0; x < cells; x++) {
      const a = z * grid + x;
      const b = a + 1;
      const c = a + grid;
      const d = c + 1;
      indices[t++] = a;
      indices[t++] = c;
      indices[t++] = b;
      indices[t++] = b;
      indices[t++] = c;
      indices[t++] = d;
    }
  }
  return { positions, indices };
}

describe("Phase 9.1 — mesh BVH", () => {
  it("builds a balanced tree that accounts for every triangle exactly once", () => {
    const { positions, indices } = buildSoup(8);
    const bvh = MeshBvh.build(positions, indices, { leafSize: 4 });

    expect(bvh.triangleCount).toBe(indices.length / 3);
    expect(bvh.nodeCount).toBeGreaterThan(0);
    expect(bvh.leafCount).toBeGreaterThan(1);
    expect(bvh.triOrder.length).toBe(bvh.triangleCount);
    expect(new Set(bvh.triOrder).size).toBe(bvh.triangleCount); // a permutation, not a sample
    // Every leaf holds at most leafSize triangles; every internal node has two children.
    for (let node = 0; node < bvh.nodeCount; node++) {
      const count = bvh.nodeTriCount[node]!;
      if (count > 0) {
        expect(count).toBeLessThanOrEqual(4);
      } else {
        const left = bvh.nodeLeftFirst[node]!;
        expect(left).toBeGreaterThan(0);
        expect(left + 1).toBeLessThan(bvh.nodeCount);
      }
    }
    // The root bounds contain every vertex.
    const bounds = bvh.bounds;
    const vertex = new Vec3();
    for (let i = 0; i < positions.length; i += 3) {
      vertex.set(positions[i]!, positions[i + 1]!, positions[i + 2]!);
      expect(vertex.x).toBeGreaterThanOrEqual(bounds.min.x);
      expect(vertex.x).toBeLessThanOrEqual(bounds.max.x);
      expect(vertex.y).toBeGreaterThanOrEqual(bounds.min.y);
      expect(vertex.y).toBeLessThanOrEqual(bounds.max.y);
      expect(vertex.z).toBeGreaterThanOrEqual(bounds.min.z);
      expect(vertex.z).toBeLessThanOrEqual(bounds.max.z);
    }
    // A shallower cap still produces a valid tree.
    const capped = MeshBvh.build(positions, indices, { leafSize: 1, maxDepth: 2 });
    expect(capped.maxDepth).toBeLessThanOrEqual(2);
    expect(new Set(capped.triOrder).size).toBe(capped.triangleCount);
  });

  it("answers raycasts exactly like the brute-force traversal", () => {
    const { positions, indices } = buildSoup(16);
    const bvh = MeshBvh.build(positions, indices);
    const ray = new Ray();
    const fast = new RayHit();
    const slow = new RayHit();
    let hits = 0;
    let misses = 0;

    // 400 rays from deterministic origins/directions, including axis-aligned and grazing cases.
    let state = 12345;
    const rand = (): number => {
      state = (Math.imul(state, 22695477) + 1) >>> 0;
      return state / 0x100000000;
    };
    for (let i = 0; i < 400; i++) {
      const origin = new Vec3((rand() - 0.5) * 60, 12 + rand() * 20, (rand() - 0.5) * 60);
      const direction = new Vec3((rand() - 0.5) * 0.4, -1, (rand() - 0.5) * 0.4);
      ray.setFrom(origin, direction, 200);
      const hitFast = bvh.raycast(ray, fast);
      const hitSlow = raycastTriangles(positions, indices, ray, slow);
      expect(hitFast, `ray ${i} hit/miss disagreement`).toBe(hitSlow);
      if (!hitFast) {
        misses++;
        continue;
      }
      hits++;
      expect(fast.index).toBe(slow.index);
      expect(fast.distance).toBeCloseTo(slow.distance, 5);
      expect(fast.point.x).toBeCloseTo(slow.point.x, 4);
      expect(fast.normal.y).toBeGreaterThan(0); // the soup faces up; rays come from above
    }
    expect(hits).toBeGreaterThan(120); // the rays must actually be interesting
    expect(misses).toBeGreaterThan(0);
  });

  it("is deterministic: the same geometry rebuilds byte-identically", () => {
    const { positions, indices } = buildSoup(10);
    const a = MeshBvh.build(positions, indices);
    const b = MeshBvh.build(positions, indices);
    expect(b.hash).toBe(a.hash);
    expect(Array.from(b.triOrder)).toEqual(Array.from(a.triOrder));
    expect(Array.from(b.nodeBounds)).toEqual(Array.from(a.nodeBounds));
    expect(b.nodeCount).toBe(a.nodeCount);
    expect(b.maxDepth).toBe(a.maxDepth);

    // Different leaf size is a different tree, and the hash says so.
    const c = MeshBvh.build(positions, indices, { leafSize: 2 });
    expect(c.hash).not.toBe(a.hash);
  });

  it("survives the task payload round trip, including structured-clone semantics", () => {
    const { positions, indices } = buildSoup(6);
    const result: BvhTaskResult = buildBvhTask({ positions, indices, leafSize: 4 });
    expect(result.hash).toBe(MeshBvh.build(positions, indices, { leafSize: 4 }).hash);
    expect(result.nodeBounds).toBeInstanceOf(Float32Array);
    expect(result.triOrder).toBeInstanceOf(Uint32Array);
    expect(result.bounds).toHaveLength(6);

    // What the worker posts is a structuredClone of the result (its buffers are transferred).
    const cloned = structuredClone({
      nodeBounds: result.nodeBounds,
      nodeLeftFirst: result.nodeLeftFirst,
      nodeTriCount: result.nodeTriCount,
      triOrder: result.triOrder,
      nodeCount: result.nodeCount,
      leafCount: result.leafCount,
      maxDepth: result.maxDepth,
      triangleCount: result.triangleCount,
      hash: result.hash,
      bounds: result.bounds,
    }) as BvhTaskResult;
    const restored = MeshBvh.fromData(
      { ...cloned, bounds: new AABB(new Vec3(cloned.bounds[0], cloned.bounds[1], cloned.bounds[2]), new Vec3(cloned.bounds[3], cloned.bounds[4], cloned.bounds[5])) },
      positions,
      indices,
    );
    // The restored tree answers like the original — the arrays are all a BVH needs.
    const ray = new Ray(new Vec3(0, 30, 0), new Vec3(0.1, -1, 0.05), 100);
    const fromWorker = new RayHit();
    const native = new RayHit();
    expect(restored.raycast(ray, fromWorker)).toBe(true);
    expect(MeshBvh.build(positions, indices, { leafSize: 4 }).raycast(ray, native)).toBe(true);
    expect(fromWorker.index).toBe(native.index);
    expect(fromWorker.distance).toBeCloseTo(native.distance, 6);
  });

  it("handles degenerate input without throwing", () => {
    const empty = MeshBvh.build(new Float32Array(0), new Uint32Array(0));
    expect(empty.nodeCount).toBe(0);
    expect(empty.triangleCount).toBe(0);
    expect(empty.raycast(new Ray(new Vec3(0, 0, 0), new Vec3(0, -1, 0), 10), new RayHit())).toBe(false);

    // One triangle, and a "triangle" whose three vertices coincide (no area, no hit, no NaN).
    const single = MeshBvh.build(new Float32Array([0, 0, 0, 1, 0, 0, 0, 0, 1]), new Uint32Array([0, 1, 2]));
    expect(single.nodeCount).toBe(1);
    expect(single.maxDepth).toBe(0);
    const degenerate = MeshBvh.build(new Float32Array([1, 1, 1, 1, 1, 1, 1, 1, 1]), new Uint32Array([0, 1, 2]));
    expect(degenerate.hash).toBeGreaterThan(0);
    expect(degenerate.raycast(new Ray(new Vec3(1, 5, 1), new Vec3(0, -1, 0), 10), new RayHit())).toBe(false);

    // Every triangle co-located (zero centroid extent) must not recurse forever.
    const coincident = MeshBvh.build(
      new Float32Array([0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 1, 1, 0, 1, 0, 1, 0.5]),
      new Uint32Array([0, 1, 2, 3, 4, 5]),
      { leafSize: 1 },
    );
    expect(coincident.leafCount).toBeGreaterThan(0);
    expect(new Set(coincident.triOrder).size).toBe(2);
  });

  it("queries bounds and frustums as candidate sets that match brute force", () => {
    const { positions, indices } = buildSoup(12);
    const bvh = MeshBvh.build(positions, indices);

    // A box around part of the grid: the BVH's candidates must be a superset of the true hits.
    const box = new AABB(new Vec3(-8, -10, -8), new Vec3(2, 10, 2));
    const candidates: number[] = [];
    bvh.queryBounds(box, candidates);
    expect(candidates.length).toBeGreaterThan(0);
    expect(new Set(candidates).size).toBe(candidates.length);

    // A narrow frustum aimed at one corner of the soup, so culling has something to do.
    const viewProj = new Mat4()
      .setPerspective(Math.PI / 9, 1, 1, 120)
      .multiply(new Mat4().setLookAt(new Vec3(24, 22, 24), new Vec3(-8, 1, -8), new Vec3(0, 1, 0)));
    const frustum = new Frustum().setFromViewProjection(viewProj);
    const visible: number[] = [];
    const count = bvh.queryFrustum(frustum, visible);
    expect(count).toBe(visible.length);
    expect(count).toBeGreaterThan(0);
    expect(count).toBeLessThan(bvh.triangleCount); // the frustum must actually cull something
    for (const triangle of visible) expect(triangle).toBeLessThan(bvh.triangleCount);

    // Parity: the BVH candidates must be a superset of the triangles whose own AABB intersects the
    // frustum (a triangle's bounds can intersect while the triangle does not — that is why this is a
    // candidate list, not a visibility test).
    const candidate = new Set(visible);
    const trueSet = new Set<number>();
    const triBox = new AABB();
    for (let t = 0; t < bvh.triangleCount; t++) {
      const a = indices[t * 3]! * 3;
      const b = indices[t * 3 + 1]! * 3;
      const c = indices[t * 3 + 2]! * 3;
      triBox.clear();
      triBox.expandByPoint(new Vec3(positions[a]!, positions[a + 1]!, positions[a + 2]!));
      triBox.expandByPoint(new Vec3(positions[b]!, positions[b + 1]!, positions[b + 2]!));
      triBox.expandByPoint(new Vec3(positions[c]!, positions[c + 1]!, positions[c + 2]!));
      if (frustum.intersectsAABB(triBox)) trueSet.add(t);
    }
    expect(trueSet.size).toBeGreaterThan(0);
    for (const triangle of trueSet) {
      expect(candidate.has(triangle), `triangle ${triangle} intersects the frustum but the BVH missed it`).toBe(true);
    }
  });
});
