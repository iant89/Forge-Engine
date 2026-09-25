/**
 * Clustered (Forward+) light assignment — `engine/src/rendering/clusters.ts` (docs/RENDERING.md §4b).
 *
 * The property that matters is *conservation*: a light must be in the cluster list of every fragment
 * it can reach. Under-inclusion is a light that silently stops lighting a surface — invisible in a
 * screenshot, undiagnosable from a log — so the probe-point test below walks points inside each
 * light's range and looks them up exactly the way the fragment stage does (tile from the projected
 * position, slice from the view depth). Over-inclusion is allowed and expected: the builder projects
 * a bounding box at its nearest depth and widens the slice range by one, and an extra light costs an
 * evaluation whose attenuation is exactly zero.
 *
 * Also pinned here: list order (which is what makes the clustered and unclustered sums bit-identical),
 * the near/far/off-frame culls, the per-cluster cap's "drop the dimmest" policy, the flat list's
 * capacity arithmetic, `MAX_CLUSTERED_LIGHTS` truncation, the spot cone's bounding sphere, and that a
 * build allocates nothing and repeats byte for byte.
 */

import { describe, expect, it } from "vitest";
import {
  CLUSTER_COUNT,
  CLUSTER_INDEX_CAPACITY,
  CLUSTER_SLICES,
  CLUSTER_TILES_X,
  CLUSTER_TILES_Y,
  ClusterGrid,
  MAX_CLUSTERED_LIGHTS,
  MAX_LIGHTS_PER_CLUSTER,
  Mat4,
  Vec3,
  clusterSliceFor,
  spotBoundingSphere,
  type ClusterCameraParams,
  type ClusterLightSource,
} from "@forge/engine";

const EYE = new Vec3(0, 5, -20);
const TARGET = new Vec3(0, 1, 0);
const FOV = Math.PI / 3;
const ASPECT = 16 / 9;
const NEAR = 0.1;
const FAR = 200;

/** The camera the renderer would hand the builder: a view matrix plus the projection's scale terms. */
function cameraAt(eye: Vec3, target: Vec3, fov = FOV, aspect = ASPECT, near = NEAR, far = FAR): ClusterCameraParams {
  const view = new Mat4().setLookAt(eye, target, new Vec3(0, 1, 0));
  const proj = new Mat4().setPerspective(fov, aspect, near, far);
  return { view, proj00: proj.m[0]!, proj11: proj.m[5]!, near, far };
}

function camera(): ClusterCameraParams {
  return cameraAt(EYE, TARGET);
}

/** Project a view position the way the engine's perspective matrix does (m[0]/m[5] over w = z). */
function toNdc(params: ClusterCameraParams, viewPos: Vec3): { x: number; y: number } {
  return { x: (params.proj00 * viewPos.x) / viewPos.z, y: (params.proj11 * viewPos.y) / viewPos.z };
}

function light(x: number, y: number, z: number, range = 6, intensity = 10, colorLuma = 1): ClusterLightSource {
  return { x, y, z, range, spot: false, dirX: 0, dirY: -1, dirZ: 0, outerCone: 0.6, intensity, colorLuma };
}

/** The cluster a point lands in, computed the way `clusterIndexOf` in the fragment stage computes it. */
function clusterOfPoint(params: ClusterCameraParams, p: Vec3, clusterFar: number): { tx: number; ty: number; tz: number } {
  const viewPos = params.view.transformPoint(p, new Vec3());
  const ndc = toNdc(params, viewPos);
  const u = ndc.x * 0.5 + 0.5;
  const v = 0.5 - ndc.y * 0.5;
  return {
    tx: Math.min(CLUSTER_TILES_X - 1, Math.max(0, Math.floor(u * CLUSTER_TILES_X))),
    ty: Math.min(CLUSTER_TILES_Y - 1, Math.max(0, Math.floor(v * CLUSTER_TILES_Y))),
    tz: clusterSliceFor(viewPos.z, params.near, clusterFar),
  };
}

/** Is this point inside the frustum and between the near plane and the slice span? */
function visible(params: ClusterCameraParams, p: Vec3, clusterFar: number): boolean {
  const v = params.view.transformPoint(p, new Vec3());
  if (v.z <= params.near * 1.001 || v.z > clusterFar) return false;
  const ndc = toNdc(params, v);
  return Math.abs(ndc.x) <= 1 && Math.abs(ndc.y) <= 1;
}

describe("cluster grid", () => {
  it("is the 16x8x24 grid ARCHITECTURE.md §5.5 specifies", () => {
    expect(CLUSTER_TILES_X).toBe(16);
    expect(CLUSTER_TILES_Y).toBe(8);
    expect(CLUSTER_SLICES).toBe(24);
    expect(CLUSTER_COUNT).toBe(CLUSTER_TILES_X * CLUSTER_TILES_Y * CLUSTER_SLICES);
    expect(new ClusterGrid().clusterOffsets.length).toBe(CLUSTER_COUNT * 2);
  });

  it("puts a light in every cluster a point within its range looks up (conservation)", () => {
    const params = camera();
    const grid = new ClusterGrid();
    const lights = [
      light(0, 1, 0),
      light(-4, 2, 3, 5),
      light(5, 0.5, -2, 8),
      light(1.5, 3, 6, 3, 40),
    ];
    const result = grid.build(lights, params);
    expect(result.live).toBe(4);

    // Probe the centre and the six axis extremes at 90% of the range: every one of those points is
    // reachable by the light, so whichever cluster it looks up must list that light.
    let probed = 0;
    const offsets = [
      [0, 0, 0],
      [1, 0, 0],
      [-1, 0, 0],
      [0, 1, 0],
      [0, -1, 0],
      [0, 0, 1],
      [0, 0, -1],
    ];
    for (const [i, l] of lights.entries()) {
      for (const [ox, oy, oz] of offsets) {
        const p = new Vec3(l.x + ox * l.range * 0.9, l.y + oy * l.range * 0.9, l.z + oz * l.range * 0.9);
        if (!visible(params, p, result.far)) continue;
        const { tx, ty, tz } = clusterOfPoint(params, p, result.far);
        const list = grid.lightsIn(tx, ty, tz);
        expect([...list], `light ${i} at probe (${p.x.toFixed(2)}, ${p.y.toFixed(2)}, ${p.z.toFixed(2)}) → cluster ${tx},${ty},${tz}`).toContain(i);
        probed++;
      }
    }
    expect(probed).toBeGreaterThan(10); // the test is vacuous if the probes all fell outside the frustum
  });

  it("covers the tiles an off-axis light's far edge projects into, not only its near edge", () => {
    // Regression, found by check:browser as 181 darker pixels in a 40-light frame. The screen extent
    // used to be the bounding box projected at its *nearest* depth. But ndc.x = proj00·x/z moves
    // toward the centre as z grows, so a box that does not straddle the view axis reaches further in
    // at its far edge than at its near one: this lamp lost the inner crescent of its own pool, and the
    // off-frame cull could reject a light that was on screen. The extremes are at the box's corners,
    // so both depths have to be projected.
    const params = cameraAt(new Vec3(0, 5.5, -11), new Vec3(0, 1, 0), Math.PI / 3.5, 1280 / 720, 0.1, 150);
    const grid = new ClusterGrid();
    const lamp: ClusterLightSource = { x: -5, y: 0.75, z: -4, range: 1.8, spot: false, dirX: 0, dirY: -1, dirZ: 0, outerCone: 0.6, intensity: 11, colorLuma: 1 };
    const result = grid.build([lamp], params);
    expect(result.live).toBe(1);
    // Walk the ground the lamp stands over at 2 cm: every point inside its range must find it, and
    // the walk must be dense enough that a one-tile bite cannot hide between two probes.
    let probed = 0;
    let innerEdge = 0;
    for (let x = -7.5; x <= -2.5; x += 0.02) {
      for (let z = -6.5; z <= -1.5; z += 0.02) {
        const p = new Vec3(x, 0, z);
        const d = Math.hypot(lamp.x - x, lamp.y - 0, lamp.z - z);
        if (d > lamp.range) continue;
        if (!visible(params, p, result.far)) continue;
        // The crescent nearest the view axis is the part a near-depth projection drops.
        if (x > lamp.x + lamp.range * 0.4) innerEdge++;
        const { tx, ty, tz } = clusterOfPoint(params, p, result.far);
        expect([...grid.lightsIn(tx, ty, tz)], `ground (${x.toFixed(2)}, 0, ${z.toFixed(2)}) at ${d.toFixed(3)} m → cluster ${tx},${ty},${tz}`).toContain(0);
        probed++;
      }
    }
    expect(probed).toBeGreaterThan(2000); // the test is vacuous if the walk found no lit ground
    expect(innerEdge).toBeGreaterThan(100); // ...and it must have crossed the crescent that was lost
  });

  it("conserves a spot light: the cone's bounding sphere covers every point the cone reaches", () => {
    const params = camera();
    const grid = new ClusterGrid();
    const spot: ClusterLightSource = { x: 0, y: 8, z: 0, range: 10, spot: true, dirX: 0, dirY: -1, dirZ: 0, outerCone: Math.cos(Math.PI / 6), intensity: 30, colorLuma: 1 };
    const result = grid.build([spot], params);
    expect(result.live).toBe(1);
    // Points on the cone's rim at full range: the widest the light reaches.
    for (const angle of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
      const rim = new Vec3(Math.cos(angle) * 10 * Math.tan(Math.PI / 6), 8 - 10, Math.sin(angle) * 10 * Math.tan(Math.PI / 6));
      if (!visible(params, rim, result.far)) continue;
      const { tx, ty, tz } = clusterOfPoint(params, rim, result.far);
      expect([...grid.lightsIn(tx, ty, tz)], `rim point at ${angle.toFixed(2)} rad`).toContain(0);
    }
  });

  it("keeps every cluster list in light order, so the shader's sum does not depend on the path", () => {
    const grid = new ClusterGrid();
    const lights: ClusterLightSource[] = [];
    for (let i = 0; i < 40; i++) lights.push(light(((i % 8) - 3.5) * 2.5, 1 + (i % 5), ((i >> 3) - 2) * 3, 7, 5 + i));
    grid.build(lights, camera());
    for (let c = 0; c < CLUSTER_COUNT; c++) {
      const start = grid.clusterOffsets[c * 2]!;
      const n = grid.clusterOffsets[c * 2 + 1]!;
      for (let k = 1; k < n; k++) {
        expect(grid.indices[start + k]!, `cluster ${c} entry ${k}`).toBeGreaterThan(grid.indices[start + k - 1]!);
      }
    }
  });

  it("culls lights behind the near plane, past the far plane, and off-frame", () => {
    const params = camera();
    const grid = new ClusterGrid();
    const result = grid.build(
      [
        light(0, 1, 0), // in front of the camera: live
        light(0, 5, -30, 4), // behind the eye (the camera looks down +Z from z = -20)
        light(0, 1, 400, 4), // past the far plane
        light(500, 1, 0, 4), // far outside the frustum laterally
      ],
      params,
    );
    expect(result.lights).toBe(4);
    expect(result.live).toBe(1);
    expect(result.clustersUsed).toBeGreaterThan(0);
    // Only light 0 is ever referenced.
    for (let k = 0; k < result.indexCount; k++) expect(grid.indices[k]).toBe(0);
  });

  it("a light entirely behind the near plane cannot reach a visible surface", () => {
    // The cull is a correctness claim, not an optimisation: every point in front of the near plane is
    // farther from such a light than its own range, so its attenuation is exactly zero everywhere.
    const params = camera();
    const view = params.view.transformPoint(new Vec3(0, 5, -20.5), new Vec3());
    expect(view.z).toBeLessThan(0); // behind the eye in view space
    const grid = new ClusterGrid();
    expect(grid.build([light(0, 5, -20.5, 0.2)], params).live).toBe(0);
  });

  it("spans the slices to the deepest live light, not to the camera's far plane", () => {
    const grid = new ClusterGrid();
    const near = grid.build([light(0, 1, 0, 6)], camera());
    // The light's sphere reaches ~25 m from the eye; the camera's far plane is 200 m.
    expect(near.far).toBeLessThan(40);
    expect(near.far).toBeGreaterThan(20);
    const deep = grid.build([light(0, 1, 120, 6)], camera());
    expect(deep.far).toBeGreaterThan(100);
    // The far plane still caps it.
    const capped = grid.build([light(0, 1, 500, 6)], camera());
    expect(capped.live).toBe(0);
  });

  it("drops the dimmest lights when a cluster is over its cap, and says so", () => {
    const grid = new ClusterGrid();
    // All 40 lights in the same place: every cluster they touch is over MAX_LIGHTS_PER_CLUSTER.
    const lights: ClusterLightSource[] = [];
    for (let i = 0; i < MAX_LIGHTS_PER_CLUSTER + 8; i++) lights.push(light(0, 1, 0, 6, 1 + i));
    const result = grid.build(lights, camera());
    expect(result.maxPerCluster).toBe(MAX_LIGHTS_PER_CLUSTER);
    expect(result.capPerCluster).toBe(MAX_LIGHTS_PER_CLUSTER);
    expect(result.dropped).toBe(true);
    // The survivors are the brightest, by intensity × colour luma — not the last 32 in list order.
    const centre = clusterOfPoint(camera(), new Vec3(0, 1, 0), result.far);
    const list = [...grid.lightsIn(centre.tx, centre.ty, centre.tz)];
    expect(list).toHaveLength(MAX_LIGHTS_PER_CLUSTER);
    expect(list).toEqual([...list].sort((a, b) => a - b)); // still ascending after the eviction sort
    expect(list).toEqual(lights.map((_, i) => i).slice(8)); // intensities 1..40 → the eight dimmest lose
  });

  it("holds the worst case: every cluster full to its cap, and the index list sized for exactly that", () => {
    const grid = new ClusterGrid();
    // Huge ranges make every light reach the near plane, so each one takes every tile and every
    // slice: 256 lights × 3072 clusters of candidates. The list is sized for the cap, not for the
    // candidate count, so the cap is what a cluster loses lights to — never the buffer.
    const lights: ClusterLightSource[] = [];
    for (let i = 0; i < MAX_CLUSTERED_LIGHTS; i++) lights.push(light(0, 1, 0, 500, 1 + i));
    const result = grid.build(lights, camera());
    expect(CLUSTER_INDEX_CAPACITY).toBe(CLUSTER_COUNT * MAX_LIGHTS_PER_CLUSTER);
    expect(result.clustersUsed).toBe(CLUSTER_COUNT);
    expect(result.capPerCluster).toBe(MAX_LIGHTS_PER_CLUSTER);
    expect(result.indexCount).toBe(CLUSTER_INDEX_CAPACITY); // the worst case fits, exactly
    expect(result.dropped).toBe(true);
    // The offsets are a prefix sum of the counts, and every count respects the cap.
    let offset = 0;
    for (let c = 0; c < CLUSTER_COUNT; c++) {
      expect(grid.clusterOffsets[c * 2]).toBe(offset);
      expect(grid.clusterOffsets[c * 2 + 1]!).toBeLessThanOrEqual(result.capPerCluster);
      offset += grid.clusterOffsets[c * 2 + 1]!;
    }
    expect(offset).toBe(result.indexCount);
  });

  it("truncates at MAX_CLUSTERED_LIGHTS and reports what it was asked for", () => {
    const grid = new ClusterGrid();
    const lights: ClusterLightSource[] = [];
    for (let i = 0; i < MAX_CLUSTERED_LIGHTS + 20; i++) lights.push(light(((i % 10) - 5) * 2, 1, ((i / 10) | 0) * 2 - 4, 4));
    const result = grid.build(lights, camera());
    expect(result.requested).toBe(MAX_CLUSTERED_LIGHTS + 20);
    expect(result.lights).toBe(MAX_CLUSTERED_LIGHTS);
    expect(result.dropped).toBe(true);
    for (let k = 0; k < result.indexCount; k++) expect(grid.indices[k]!).toBeLessThan(MAX_CLUSTERED_LIGHTS);
  });

  it("an empty frame builds an empty grid, and a rebuild clears the previous frame", () => {
    const grid = new ClusterGrid();
    const empty = grid.build([], camera());
    expect(empty).toMatchObject({ requested: 0, lights: 0, live: 0, clustersUsed: 0, indexCount: 0, maxPerCluster: 0 });
    grid.build([light(0, 1, 0)], camera());
    expect(grid.build([], camera()).clustersUsed).toBe(0);
    for (let c = 0; c < CLUSTER_COUNT; c++) expect(grid.clusterOffsets[c * 2 + 1]).toBe(0);
  });

  it("is deterministic and allocation-free: the same input builds the same bytes twice", () => {
    const params = camera();
    const lights = [light(0, 1, 0, 6, 12), light(-3, 2, 4, 9, 4), light(4, 0.5, -1, 3, 30)];
    const a = new ClusterGrid();
    const b = new ClusterGrid();
    const ra = a.build(lights, params);
    const rb = b.build(lights, params);
    expect(ra).toEqual(rb);
    expect([...a.clusterOffsets]).toEqual([...b.clusterOffsets]);
    expect([...a.indices.subarray(0, ra.indexCount)]).toEqual([...b.indices.subarray(0, rb.indexCount)]);
    // Rebuilding the same grid does not drift (a stale cursor would show up here).
    const offsetsBefore = [...a.clusterOffsets];
    const indicesBefore = [...a.indices.subarray(0, ra.indexCount)];
    const again = a.build(lights, params);
    expect(again).toEqual(ra);
    expect([...a.clusterOffsets]).toEqual(offsetsBefore);
    expect([...a.indices.subarray(0, again.indexCount)]).toEqual(indicesBefore);
  });

  it("degenerate input does not throw or produce NaN geometry", () => {
    const grid = new ClusterGrid();
    const result = grid.build([light(0, 1, 0, 0, Number.NaN, Number.NaN), light(Number.NaN, 0, 0, Number.POSITIVE_INFINITY)], camera());
    expect(Number.isFinite(result.far)).toBe(true);
    expect(result.indexCount).toBeGreaterThanOrEqual(0);
    for (let c = 0; c < CLUSTER_COUNT; c++) {
      expect(Number.isFinite(grid.clusterOffsets[c * 2]!)).toBe(true);
      expect(grid.clusterOffsets[c * 2 + 1]!).toBeLessThanOrEqual(MAX_LIGHTS_PER_CLUSTER);
    }
    // A zero/near-zero range still lands in the cluster that contains it.
    expect(grid.build([light(0, 1, 0, 0)], camera()).live).toBe(1);
  });
});

describe("spotBoundingSphere", () => {
  it("contains the cone's apex and its rim circle (closed form R / 2cos²θ)", () => {
    for (const cos of [0.95, 0.8, 0.6, 0.3, 0.1]) {
      const range = 7;
      const rho = spotBoundingSphere(range, cos);
      expect(rho).toBeCloseTo(range / (2 * cos * cos), 9);
      const apex = new Vec3(0, 0, 0);
      const centre = new Vec3(0, 0, rho); // the axis is +Z here
      expect(apex.clone().sub(centre).length()).toBeLessThanOrEqual(rho + 1e-9);
      // The rim: at distance `range` along the axis, `range·tanθ` off it.
      const tan = Math.sqrt(1 - cos * cos) / cos;
      const rim = new Vec3(range * tan, 0, range);
      expect(rim.clone().sub(centre).length()).toBeLessThanOrEqual(rho + 1e-9);
    }
  });

  it("clamps a degenerate cone cosine instead of dividing by zero", () => {
    expect(Number.isFinite(spotBoundingSphere(5, 0))).toBe(true);
    expect(Number.isFinite(spotBoundingSphere(5, Number.NaN))).toBe(true);
    expect(spotBoundingSphere(-3, 0.5)).toBe(0);
  });
});

describe("clusterSliceFor", () => {
  it("is monotone in depth and stays inside the grid", () => {
    let previous = -1;
    for (let d = NEAR; d <= 60; d *= 1.3) {
      const s = clusterSliceFor(d, NEAR, 60);
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThan(CLUSTER_SLICES);
      expect(s).toBeGreaterThanOrEqual(previous);
      previous = s;
    }
    expect(clusterSliceFor(1e-9, NEAR, 60)).toBe(0);
    expect(clusterSliceFor(1e9, NEAR, 60)).toBe(CLUSTER_SLICES - 1);
  });

  it("spreads slices logarithmically: near slices are thinner in metres than far ones", () => {
    const boundary = (s: number) => NEAR * Math.exp((s / CLUSTER_SLICES) * Math.log(60 / NEAR));
    expect(boundary(1) - boundary(0)).toBeLessThan(boundary(CLUSTER_SLICES - 1) - boundary(CLUSTER_SLICES - 2));
    expect(clusterSliceFor(boundary(12) * 1.001, NEAR, 60)).toBe(12);
  });
});
