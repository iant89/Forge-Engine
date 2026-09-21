/**
 * 100k-Entity Transform & Visibility Benchmark.
 *
 * Exercises:
 *  - Entity allocation & component attachment at 100k scale
 *  - Hierarchical world transform composition over 100k entities
 *  - Frustum culling and visibility queries over 100k entities
 */
import {
  EntityWorld,
  Transform,
  Renderable,
  Camera,
  Frustum,
  Mat4,
  Vec3,
  AABB,
} from "@forge/engine";

export interface BenchmarkResult {
  name: string;
  count: number;
  durationMs: number;
  opsPerSec: number;
}

export function runEcsBenchmark(entityCount = 100_000): BenchmarkResult[] {
  const world = new EntityWorld({ initialCapacity: entityCount + 1000 });
  const results: BenchmarkResult[] = [];

  // 1. Setup 100k entities with Transform and Renderable
  const t0 = performance.now();
  const gridSize = Math.ceil(Math.cbrt(entityCount));
  const spacing = 2.0;

  let created = 0;
  for (let x = 0; x < gridSize && created < entityCount; x++) {
    for (let y = 0; y < gridSize && created < entityCount; y++) {
      for (let z = 0; z < gridSize && created < entityCount; z++) {
        const e = world.createEntity(`e_${created}`);
        const t = e.add(new Transform());
        t.setPosition(x * spacing, y * spacing, z * spacing);
        const r = e.add(new Renderable());
        r.boundsOverride = new AABB(new Vec3(-0.5, -0.5, -0.5), new Vec3(0.5, 0.5, 0.5));
        created++;
      }
    }
  }
  const setupTime = performance.now() - t0;
  results.push({
    name: "100k entity creation + component attach",
    count: entityCount,
    durationMs: setupTime,
    opsPerSec: Math.round((entityCount / setupTime) * 1000),
  });

  // 2. Transform Update (all 100k dirty)
  const changedSlots: number[] = [];
  const t1 = performance.now();
  const updatedCount = world.updateTransforms(changedSlots, true);
  const transformTime = performance.now() - t1;
  results.push({
    name: "100k transform update (world matrix composition)",
    count: updatedCount,
    durationMs: transformTime,
    opsPerSec: Math.round((updatedCount / transformTime) * 1000),
  });

  // 3. Frustum Culling on 100k Entities
  const camera = new Camera();
  camera.fovY = Math.PI / 3;
  camera.near = 0.1;
  camera.far = 200;
  const view = new Mat4().setLookAt(new Vec3(0, 0, -20), new Vec3(gridSize, gridSize, gridSize), new Vec3(0, 1, 0));
  const proj = new Mat4().setPerspective(camera.fovY, 16 / 9, camera.near, camera.far);
  camera.writeMatrices(view, proj, new Vec3(0, 0, -20));

  const frustum = new Frustum().setFromViewProjection(camera.viewProjection);

  const t2 = performance.now();
  const query = world.query([Renderable]);
  query.refresh();

  const box = new AABB();
  const worldBox = new AABB();
  const mat = new Mat4();
  let visibleCount = 0;

  for (let i = 0; i < query.count; i++) {
    const id = query.entity(i);
    const r = query.value(0, i) as Renderable;
    r.resolveBounds(box);
    world.getWorldMatrix(id, mat);
    box.transformByMatrix(mat, worldBox);
    if (frustum.intersectsAABB(worldBox)) {
      r.isVisible = true;
      visibleCount++;
    } else {
      r.isVisible = false;
    }
  }
  const cullTime = performance.now() - t2;
  results.push({
    name: "100k entity frustum culling & bounds query",
    count: query.count,
    durationMs: cullTime,
    opsPerSec: Math.round((query.count / cullTime) * 1000),
  });

  world.dispose();
  return results;
}
