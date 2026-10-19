/**
 * @suite examples:alpineRoute
 * @group unit
 * @covers engine/src/index.ts
 * @covers engine/src/terrain/trackGrading.ts
 * @covers examples/src/scenes/alpineRoute.ts
 * @covers examples/src/scenes/alpineTerrain.ts
 * @desc Pins the Alpine rescue road design (graded bed, grade limit, ribbon), the graded streamed terrain, and the winter splat weights
 */

export const suite = {
  name: "examples:alpineRoute",
  group: "unit",
  covers: [
    "engine/src/index.ts",
    "engine/src/terrain/trackGrading.ts",
    "examples/src/scenes/alpineRoute.ts",
    "examples/src/scenes/alpineTerrain.ts",
  ],
  desc: "Pins the Alpine rescue road design (graded bed, grade limit, ribbon), the graded streamed terrain, and the winter splat weights",
};
import assert from "node:assert/strict";
import { assertCloseTo, finish, group, test } from "selrun";
import { createWorldCell, TrackGradingGenerator, type WorldCell } from "@forge/engine";
import {
  BASE_Z,
  DEPOT_APPROACH_X,
  DEPOT_APPROACH_Z,
  DEPOT_HUT_X,
  DEPOT_X,
  RELAY_SITES,
  ROAD_START_Z,
  ROUTE_END_Z,
  designAlpineRoute,
  mainRouteCenterX,
  roadCenterX,
  roadRibbonSource,
} from "../../examples/src/scenes/alpineRoute.js";
import {
  alpineGroundWeights,
  alpineNaturalHeight,
  alpineWeightsAt,
  createAlpineLayers,
  createAlpinePipeline,
  createGradedHeight,
} from "../../examples/src/scenes/alpineTerrain.js";
import { ALPINE_LAYER_ORDER } from "../../examples/src/textures/alpine.js";

const SEED = 7421;
const natural = alpineNaturalHeight();
const route = designAlpineRoute(natural);
const pipeline = createAlpinePipeline(route.corridors);

/** Graded cells on demand, the way a streaming world builds them. */
const cells = new Map<string, WorldCell>();
function cell(cx: number, cz: number, res = 33): WorldCell {
  const key = `${cx},${cz},${res}`;
  let c = cells.get(key);
  if (!c) {
    c = createWorldCell(cx, cz, 128, res, SEED);
    pipeline.execute(c);
    cells.set(key, c);
  }
  return c;
}
/** Bilinear height from graded cells (the mesh surface at LOD 0). */
function gradedAt(x: number, z: number): number {
  const cx = Math.floor(x / 128), cz = Math.floor(z / 128);
  const c = cell(cx, cz);
  const u = ((x - cx * 128) / 128) * 32, v = ((z - cz * 128) / 128) * 32;
  const i = Math.min(31, Math.floor(u)), j = Math.min(31, Math.floor(v));
  const fx = u - i, fz = v - j;
  const h = c.heights;
  return h[j * 33 + i]! * (1 - fx) * (1 - fz) + h[j * 33 + i + 1]! * fx * (1 - fz) + h[(j + 1) * 33 + i]! * (1 - fx) * fz + h[(j + 1) * 33 + i + 1]! * fx * fz;
}

group("Alpine road — layout and design", () => {
  test("the road centre line is continuous from the depot spur into the winding main route", () => {
    assert.equal(roadCenterX(DEPOT_APPROACH_Z), DEPOT_APPROACH_X);
    assert.equal(roadCenterX(ROAD_START_Z), DEPOT_APPROACH_X, "the spur runs straight under the pad");
    let prev = roadCenterX(ROAD_START_Z);
    for (let z = ROAD_START_Z; z <= ROUTE_END_Z; z += 1) {
      const x = roadCenterX(z);
      assert.ok(Math.abs(x - prev) < 1.3, `no jumps at z=${z}`);
      prev = x;
    }
    assertCloseTo(roadCenterX(0), mainRouteCenterX(0), 12);
  });

  test("the route is a sensible length with the beacons beside it and the spawn on it", () => {
    assert.ok(route.length > 300 && route.length < 340, `length ${route.length}`);
    for (const site of RELAY_SITES) {
      const p = route.project(site.x, site.z);
      assert.ok(Number.isFinite(p.distance) && p.distance < 16, `${site.callsign} is ${p.distance.toFixed(1)} m from the road`);
    }
    const spawn = route.project(DEPOT_APPROACH_X, DEPOT_APPROACH_Z);
    assert.ok(spawn.distance < 0.5, "the truck spawns on the road");
    assert.ok(spawn.s > 5 && spawn.s < 20, `spawn at s=${spawn.s.toFixed(1)}`);
    assert.equal(route.project(0, 0).distance, Infinity, "far from the road there is no projection");
  });

  test("the designed bed never exceeds the grade limit and stays close to the hillside on average", () => {
    let steepest = 0;
    let deviation = 0;
    for (let i = 1; i < route.bed.length; i++) steepest = Math.max(steepest, Math.abs(route.bed[i]! - route.bed[i - 1]!) / route.spline.step);
    for (let i = 0; i < route.bed.length; i++) deviation += Math.abs(route.bed[i]! - natural(route.spline.px[i]!, route.spline.pz[i]!));
    assert.ok(steepest <= 0.1 + 1e-6, `steepest grade ${(steepest * 100).toFixed(1)} %`);
    assert.ok(deviation / route.bed.length < 2.2, `mean cut/fill ${(deviation / route.bed.length).toFixed(2)} m`);
  });

  test("describes a depot pad first and the road second, meeting at one elevation", () => {
    assert.equal(route.corridors.length, 2);
    const [pad, road] = route.corridors;
    assert.ok(pad!.halfWidth > road!.halfWidth, "the pad is the wide one");
    assertCloseTo(pad!.bed[0]!, route.bed[0]!, 3);
    assertCloseTo(pad!.bed[1]!, pad!.bed[0]!, 6);
    // The hut, the lanterns, the supply case and the spawn all stand inside the pad's level core.
    for (const [x, z] of [[DEPOT_HUT_X, BASE_Z], [DEPOT_X + 3, BASE_Z + 2], [DEPOT_APPROACH_X, DEPOT_APPROACH_Z]] as const) {
      const d = Math.abs(z - (BASE_Z + 1));
      assert.ok(d <= pad!.halfWidth, `(${x}, ${z}) is within the pad`);
    }
  });
});

group("Alpine road — graded terrain", () => {
  test("the road is level across its width and gentle along it where the hillside is neither", () => {
    let worstCross = 0;
    let worstGrade = 0;
    let naturalCross = 0;
    for (let s = 12; s < route.length - 6; s += 3) {
      const c = route.spline.sampleAt(s, { x: 0, z: 0, tx: 0, tz: 1 });
      const rx = c.tz, rz = -c.tx;
      const cross = (gradedAt(c.x + rx * 2.5, c.z + rz * 2.5) - gradedAt(c.x - rx * 2.5, c.z - rz * 2.5)) / 5;
      const grade = (gradedAt(c.x + c.tx * 2, c.z + c.tz * 2) - gradedAt(c.x - c.tx * 2, c.z - c.tz * 2)) / 4;
      worstCross = Math.max(worstCross, Math.abs(cross));
      worstGrade = Math.max(worstGrade, Math.abs(grade));
      naturalCross = Math.max(naturalCross, Math.abs((natural(c.x + rx * 2.5, c.z + rz * 2.5) - natural(c.x - rx * 2.5, c.z - rz * 2.5)) / 5));
    }
    assert.ok(worstCross < 0.04, `cross-slope ${(worstCross * 100).toFixed(1)} %`);
    assert.ok(worstGrade < 0.12, `grade ${(worstGrade * 100).toFixed(1)} %`);
    assert.ok(naturalCross > 0.25, `the raw hillside leans up to ${(naturalCross * 100).toFixed(0)} % across the route`);
  });

  test("the surface under the centre line is the designed bed (what the ribbon sits on)", () => {
    for (let s = 8; s < route.length - 4; s += 11) {
      const c = route.spline.sampleAt(s, { x: 0, z: 0, tx: 0, tz: 1 });
      assertCloseTo(gradedAt(c.x, c.z), route.bedAt(s), 1, `s=${s.toFixed(0)}`);
    }
  });

  test("chunks share their borders exactly (the route runs along a chunk edge) and all LODs agree", () => {
    for (const cz of [-2, -1, 0]) {
      const left = cell(1, cz), right = cell(2, cz);
      for (let j = 0; j < 33; j++) assert.equal(left.heights[j * 33 + 32], right.heights[j * 33], `x border row ${j} of chunk ${cz}`);
    }
    for (const cx of [1, 2]) {
      const south = cell(cx, -2), north = cell(cx, -1);
      for (let i = 0; i < 33; i++) assert.equal(south.heights[32 * 33 + i], north.heights[i], `z border column ${i} of chunk ${cx}`);
    }
    const fine = cell(2, -1), coarse = cell(2, -1, 9);
    for (let j = 0; j < 9; j++) for (let i = 0; i < 9; i++) assertCloseTo(coarse.heights[j * 9 + i]!, fine.heights[j * 4 * 33 + i * 4]!, 3);
  });

  test("the graded-height helper is the pipeline's own arithmetic (so props stand on the real surface)", () => {
    const graded = createGradedHeight(route.corridors);
    const c = cell(2, -1);
    for (const [i, j] of [[0, 0], [8, 16], [16, 16], [24, 3], [32, 30], [5, 28]] as const) {
      assertCloseTo(graded(256 + i * 4, -128 + j * 4), c.heights[j * 33 + i]!, 2);
    }
    assert.ok(pipeline.stages.some((stage) => stage instanceof TrackGradingGenerator));
  });

  test("grading the pad levels the yard under the hut and the spawn", () => {
    const level = route.bed[0]!;
    for (const [x, z] of [[DEPOT_HUT_X, BASE_Z], [DEPOT_X, BASE_Z + 4], [DEPOT_X + 3, BASE_Z + 2]] as const) {
      assert.ok(Math.abs(gradedAt(x, z) - level) < 0.6, `(${x}, ${z}) is ${gradedAt(x, z).toFixed(2)} vs the pad level ${level.toFixed(2)}`);
    }
  });
});

group("Alpine road — ribbon", () => {
  const ribbon = roadRibbonSource(route, { halfSpan: 3.4, across: 9, alongStep: 1.5, lift: 0.035 });

  test("is a well-formed strip: indexed, unit normals and tangents, UVs across 0..1 and along in repeats", () => {
    const vertices = ribbon.positions.length / 3;
    assert.equal(ribbon.normals!.length, vertices * 3);
    assert.equal(ribbon.tangents!.length, vertices * 4);
    assert.equal(ribbon.uvs!.length, vertices * 2);
    assert.ok(ribbon.indices!.length % 3 === 0);
    for (const index of ribbon.indices!) assert.ok(index < vertices);
    let minU = 1, maxU = 0;
    for (let i = 0; i < vertices; i++) {
      minU = Math.min(minU, ribbon.uvs![i * 2]!);
      maxU = Math.max(maxU, ribbon.uvs![i * 2]!);
      assertCloseTo(Math.hypot(ribbon.normals![i * 3]!, ribbon.normals![i * 3 + 1]!, ribbon.normals![i * 3 + 2]!), 1, 5);
    }
    assert.equal(minU, 0);
    assert.equal(maxU, 1);
    assertCloseTo(ribbon.uvs![ribbon.uvs!.length - 1]!, route.length / 8, 3, "v is metres along / the repeat length");
  });

  test("every triangle faces up (inverted winding would cull the road from above)", () => {
    const p = ribbon.positions, idx = ribbon.indices!;
    for (let t = 0; t < idx.length; t += 3) {
      const a = idx[t]! * 3, b = idx[t + 1]! * 3, c = idx[t + 2]! * 3;
      const e1 = [p[b]! - p[a]!, p[b + 1]! - p[a + 1]!, p[b + 2]! - p[a + 2]!];
      const e2 = [p[c]! - p[a]!, p[c + 1]! - p[a + 1]!, p[c + 2]! - p[a + 2]!];
      const ny = e1[2]! * e2[0]! - e1[0]! * e2[2]!;
      assert.ok(ny > 0, `triangle ${t / 3} faces up`);
    }
  });

  test("hugs the graded bed: centre row at bed + lift, level across, spanning ±3.4 m", () => {
    const rows = ribbon.positions.length / 3 / 9;
    for (const r of [0, Math.floor(rows / 3), Math.floor(rows / 2), rows - 1]) {
      const centre = (r * 9 + 4) * 3;
      const s = (r / (rows - 1)) * route.length;
      assertCloseTo(ribbon.positions[centre + 1]!, route.bedAt(s) + 0.035, 3, `row ${r}`);
      const left = (r * 9) * 3, right = (r * 9 + 8) * 3;
      assertCloseTo(ribbon.positions[left + 1]!, ribbon.positions[right + 1]!, 6, "level across");
      const width = Math.hypot(ribbon.positions[right]! - ribbon.positions[left]!, ribbon.positions[right + 2]! - ribbon.positions[left + 2]!);
      assertCloseTo(width, 6.8, 2, "ribbon width");
    }
  });

  test("a partial ribbon covers only the requested stretch", () => {
    const part = roadRibbonSource(route, { from: 40, to: 80, alongStep: 2 });
    assertCloseTo(part.uvs![1]!, 40 / 8, 3);
    assertCloseTo(part.uvs![part.uvs!.length - 1]!, 80 / 8, 3);
  });
});

group("Alpine ground — winter splat weights", () => {
  const w = new Float32Array(4);
  const dominant = (slope: number, curvature = 0, patch = 0, fine = 0): number => {
    alpineWeightsAt(slope, curvature, patch, fine, w);
    return w.indexOf(Math.max(...w));
  };

  test("gentle ground is snow, steep faces are rock, the slopes between are scree", () => {
    assert.equal(dominant(0.05), 0, "flat → snow");
    assert.equal(dominant(0.2), 0, "gentle → snow");
    assert.equal(dominant(1.0), 1, "steep → rock");
    assert.equal(dominant(0.52, 0, 0, 0.8), 2, "mid slope → scree");
  });

  test("wind-scoured convex ground shows tundra through the snow; hollows keep it", () => {
    alpineWeightsAt(0.1, 0, 0, 0, w);
    const sheltered = w[3]! / (w[0]! + w[1]! + w[2]! + w[3]!);
    alpineWeightsAt(0.1, -0.3, 0.6, 0, w);
    const scoured = w[3]! / (w[0]! + w[1]! + w[2]! + w[3]!);
    alpineWeightsAt(0.1, 0.3, -0.6, 0, w);
    const hollow = w[3]! / (w[0]! + w[1]! + w[2]! + w[3]!);
    assert.ok(scoured > sheltered + 0.15, `scoured ${scoured.toFixed(2)} vs sheltered ${sheltered.toFixed(2)}`);
    assert.ok(hollow < sheltered + 1e-9, "hollows lose no snow");
  });

  test("a streamed cell yields one normalised RGBA texel per vertex, deterministically", () => {
    const c = cell(2, -1);
    const a = alpineGroundWeights(c);
    const b = alpineGroundWeights(c);
    assert.equal(a.length, 33 * 33 * 4);
    assert.deepEqual(Array.from(a), Array.from(b));
    for (let i = 0; i < 33 * 33; i++) {
      const sum = a[i * 4]! + a[i * 4 + 1]! + a[i * 4 + 2]! + a[i * 4 + 3]!;
      assert.ok(Math.abs(sum - 255) <= 2, `texel ${i} sums to ${sum}`);
    }
  });

  test("the graded bench reads as snow and the cut faces beside it as rock/scree", () => {
    // Weights at the road centre (flat bench) versus the steepest vertex within its corridor.
    const c = cell(2, -1);
    const weights = alpineGroundWeights(c);
    let flatSnow = 0, flatCount = 0, steepRock = 0, steepCount = 0;
    for (let i = 0; i < 33 * 33; i++) {
      const slope = c.slopes[i]!;
      if (slope < 0.1) { flatSnow += weights[i * 4]!; flatCount++; }
      if (slope > 0.7) { steepRock += weights[i * 4 + 1]! + weights[i * 4 + 2]!; steepCount++; }
    }
    assert.ok(flatCount > 0 && flatSnow / flatCount > 150, `flat ground is snow (${(flatSnow / Math.max(1, flatCount)).toFixed(0)}/255)`);
    if (steepCount > 0) assert.ok(steepRock / steepCount > 150, `steep ground is rock/scree (${(steepRock / steepCount).toFixed(0)}/255)`);
  });

  test("layer colours hit their target albedo from the measured texture means", () => {
    const flat = ALPINE_LAYER_ORDER.map(() => [0.5, 0.5, 0.5] as const);
    const layers = createAlpineLayers(flat);
    assert.equal(layers.length, 4);
    assert.deepEqual(layers.map((layer) => layer.name), [...ALPINE_LAYER_ORDER]);
    // A darker texture mean raises the layer colour (clamped) so the product stays on target.
    const dark = createAlpineLayers(ALPINE_LAYER_ORDER.map(() => [0.25, 0.25, 0.25] as const));
    assert.ok(dark[1]!.color.r > layers[1]!.color.r, "rock colour rises as its texture mean falls");
    for (const layer of layers) assert.ok(layer.color.r > 0 && layer.color.r <= 1.6 && layer.roughness > 0.8);
  });
});

await finish();
