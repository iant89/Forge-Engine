/**
 * Throwaway probe: how much CPU time does `ClusterGrid.build` cost per frame, by light count?
 * Not part of the tree — deleted before the commit.
 */
import { ClusterGrid, Mat4, Vec3, CLUSTER_COUNT, type ClusterCameraParams, type ClusterLightSource } from "@forge/engine";

const view = new Mat4().setLookAt(new Vec3(0, 5, -20), new Vec3(0, 1, 0), new Vec3(0, 1, 0));
const proj = new Mat4().setPerspective(Math.PI / 3, 16 / 9, 0.1, 200);
const params: ClusterCameraParams = { view, proj00: proj.m[0]!, proj11: proj.m[5]!, near: 0.1, far: 200 };

function makeLights(n: number, range: number): ClusterLightSource[] {
  const out: ClusterLightSource[] = [];
  for (let i = 0; i < n; i++) {
    // Deterministic scatter over a slab in front of the camera.
    const a = (i * 2.399963) % (Math.PI * 2);
    const r = 3 + ((i * 7) % 40);
    out.push({
      x: Math.cos(a) * r,
      y: 0.75 + ((i * 13) % 30) * 0.1,
      z: 5 + ((i * 11) % 90),
      range,
      spot: i % 3 === 0,
      dirX: 0,
      dirY: -1,
      dirZ: 0,
      outerCone: 0.4,
      intensity: 1 + (i % 5),
      colorLuma: 1,
    });
  }
  return out;
}

const grid = new ClusterGrid();
const cameras = params;
const cases: Array<[number, number]> = [
  [3, 8],
  [16, 8],
  [40, 1.8],
  [40, 8],
  [128, 8],
  [256, 8],
  [256, 30],
];

console.log("lights range   ms/build  clustersUsed indices maxPerCluster dropped");
for (const [n, range] of cases) {
  const lights = makeLights(n, range);
  // warm up
  for (let i = 0; i < 50; i++) grid.build(lights, cameras);
  const iters = 200;
  const t0 = performance.now();
  let r = grid.build(lights, cameras);
  for (let i = 1; i < iters; i++) r = grid.build(lights, cameras);
  const ms = (performance.now() - t0) / iters;
  console.log(
    `${String(n).padStart(6)} ${String(range).padStart(5)}  ${ms.toFixed(3).padStart(8)}  ${String(r.clustersUsed).padStart(11)} ${String(r.indexCount).padStart(7)} ${String(r.maxPerCluster).padStart(13)} ${String(r.dropped).padStart(7)}  (of ${CLUSTER_COUNT} clusters, mem: 1000 frames of indices = ${(r.indexCount * 4 / 1024).toFixed(1)} KB)`,
  );
}
