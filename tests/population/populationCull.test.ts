/**
 * @suite population:populationCull
 * @group unit
 * @covers engine/src/population/cull.ts
 * @covers engine/src/rendering/objectCulling.ts
 * @covers engine/src/rendering/pipeline.ts
 * @covers engine/src/rendering/populationCuller.ts
 * @covers engine/src/rendering/renderer.ts
 * @covers engine/src/rendering/shaders/populationCull.ts
 * @covers engine/src/rendering/shaders/populationLod.ts
 * @covers engine/src/rendering/shaders/standard.ts
 * @covers engine/src/testing/mockGpu.ts
 * @desc Per-instance population culling (Phase A + shadows/prepass): the CPU twins against brute force, the one-frame bit lag, the two-stage composition, shadow caster lists, the mock renderer path and its fallback
 */

export const suite = {
  name: "population:populationCull",
  group: "unit",
  covers: [
    "engine/src/population/cull.ts",
    "engine/src/rendering/objectCulling.ts",
    "engine/src/rendering/pipeline.ts",
    "engine/src/rendering/populationCuller.ts",
    "engine/src/rendering/renderer.ts",
    "engine/src/rendering/shaders/populationCull.ts",
    "engine/src/rendering/shaders/populationLod.ts",
    "engine/src/rendering/shaders/standard.ts",
    "engine/src/testing/mockGpu.ts"
  ],
  desc: "Per-instance population culling (Phase A + shadows/prepass): the CPU twins against brute force, the one-frame bit lag, the two-stage composition, shadow caster lists, the mock renderer path and its fallback",
};

import assert from "node:assert/strict";
import { assertContains, assertNotContains, finish, group, test } from "selrun";
import {
  AABB,
  CULL_FLAG_FRUSTUM,
  Camera,
  CullReason,
  GraphicsDevice,
  INSTANCE_FLAG_FAR,
  INSTANCE_RECORD_WORDS,
  Mat4,
  Material,
  POPULATION_CULL_SHADER,
  POP_CULL_DISTANCE,
  POP_CULL_LOD,
  POP_CULL_OCCLUSION,
  PopulationInstanceBlock,
  Renderer,
  Scene,
  SceneObject,
  Vec3,
  buildHizOnCpu,
  buildLodGeometry,
  cullPlanesFrom,
  cullPopulationInstancesOnCpu,
  cullSphereOnCpu,
  emptyPopulationCullStats,
  Geometry,
  Light,
  POPULATION_VIEW_CULL_SHADER,
  DEPTH_CULLED_VERTEX,
  cullPopulationViewsOnCpu,
  cullPopulationOcclusionOnCpu,
  sphereOutsidePlanes,
  hizLevelCount,
  populationCullingForTier,
  populationFadeScale,
  POPULATION_DISTANCE_SCALE_BY_TIER,
  POPULATION_FADE_WGSL,
  STANDARD_INSTANCED_VERTEX,
  STANDARD_LOD_INSTANCED_VERTEX,
  STANDARD_VERTEX,
  DEPTH_VERTEX,
  ObjectUniforms,
  ShadowPassUniforms,
  rockGeometrySource,
  unindexedLodWindow,
  validateWgsl,
  type ObjectCullParams,
  type PopulationCollector,
  type PopulationCullBatch,
  type PopulationSource,
  type PopulationSubmission,
} from "@forge/engine";

const NEAR = 0.5;
const FAR = 200;
const WIDTH = 64;
const HEIGHT = 64;
const EYE = new Vec3(0, 0, -10);

function frameParams(flags = CULL_FLAG_FRUSTUM, hizLevels = 0): ObjectCullParams {
  const view = new Mat4().setLookAt(EYE, new Vec3(0, 0, 0), new Vec3(0, 1, 0));
  const proj = new Mat4().setPerspective(Math.PI / 3, WIDTH / HEIGHT, NEAR, FAR);
  const viewProj = new Mat4().multiplyMatrices(proj, view);
  return { view: view.m, proj: proj.m, viewProj: viewProj.m, cameraPos: { x: EYE.x, y: EYE.y, z: EYE.z }, near: NEAR, far: FAR, width: WIDTH, height: HEIGHT, flags, hizLevels };
}

/** Deterministic LCG in [0, 1). */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** `InstanceData` records for uniformly scaled, unrotated instances; tint = index (an identity tag). */
function records(points: readonly { x: number; y: number; z: number; s: number }[]): { f: Float32Array; u: Uint32Array } {
  const f = new Float32Array(points.length * INSTANCE_RECORD_WORDS);
  const u = new Uint32Array(f.buffer);
  points.forEach((p, i) => {
    const b = i * INSTANCE_RECORD_WORDS;
    f[b] = p.s;
    f[b + 5] = p.s;
    f[b + 10] = p.s;
    f[b + 12] = p.x;
    f[b + 13] = p.y;
    f[b + 14] = p.z;
    f[b + 15] = 1;
    u[b + 16] = i;
  });
  return { f, u };
}

function batchOf(count: number, overrides: Partial<PopulationCullBatch> = {}): PopulationCullBatch {
  return { camera: { x: EYE.x, y: EYE.y, z: EYE.z }, lodDistance: 15, localCenter: { x: 0, y: 0, z: 0 }, localRadius: 0.5, count, flags: 0, maxDistance: 0, ...overrides };
}

const tagsOf = (compacted: Uint32Array, n: number) => new Set(Array.from({ length: n }, (_, k) => compacted[k * INSTANCE_RECORD_WORDS + 16]!));

group("Population cull - CPU twin", () => {
  test("keeps exactly the instances whose sphere intersects the frustum (brute force over 400 instances)", () => {
    const r = rng(7);
    const pts = Array.from({ length: 400 }, () => ({ x: (r() - 0.5) * 60, y: (r() - 0.5) * 30, z: -15 + r() * 60, s: 0.5 + r() }));
    const { f, u } = records(pts);
    const params = frameParams();
    const planes = cullPlanesFrom(params.viewProj);
    const compacted = new Uint32Array(f.length);
    const stats = emptyPopulationCullStats();
    const drawn = cullPopulationInstancesOnCpu(f, u, batchOf(pts.length), true, params, [], compacted, stats);
    const expected = new Set<number>();
    pts.forEach((p, i) => {
      const radius = 0.5 * p.s + 0.01;
      let inside = true;
      for (let row = 0; row < 6; row++) {
        const [nx, ny, nz, d] = [planes[row * 4]!, planes[row * 4 + 1]!, planes[row * 4 + 2]!, planes[row * 4 + 3]!];
        if ((nx * p.x + ny * p.y + nz * p.z + d) / Math.hypot(nx, ny, nz) < -radius) inside = false;
      }
      if (inside) expected.add(i);
    });
    assert.equal(drawn, expected.size);
    assert.deepEqual(tagsOf(compacted, drawn), expected);
    assert.equal(stats.tested, 400);
    assert.equal(stats.drawn + stats.culledFrustum, 400);
    assert.ok(stats.culledFrustum > 50 && stats.drawn > 50, `a meaningful split (${stats.drawn} drawn)`);
  });

  test("distance and LOD bits lag one frame, so the prepass and forge.main agree", () => {
    // Three instances on the view axis: near, past the LOD distance, past the distance limit.
    const pts = [
      { x: 0, y: 0, z: -5, s: 1 },
      { x: 0, y: 0, z: 10, s: 1 },
      { x: 0, y: 0, z: 40, s: 1 },
    ];
    const { f, u } = records(pts);
    const batch = batchOf(3, { flags: POP_CULL_LOD | POP_CULL_DISTANCE, lodDistance: 12, maxDistance: 30 });
    const compacted = new Uint32Array(f.length);
    // Frame 1: fresh records (flags 0) — everything drawn with the high window, bits written for next frame.
    let drawn = cullPopulationInstancesOnCpu(f, u, batch, true, frameParams(), [], compacted);
    assert.equal(drawn, 3);
    for (let k = 0; k < 3; k++) assert.equal(compacted[k * INSTANCE_RECORD_WORDS + 18], 0);
    assert.deepEqual([u[18], u[INSTANCE_RECORD_WORDS + 18], u[2 * INSTANCE_RECORD_WORDS + 18]], [0, 1, 1 | INSTANCE_FLAG_FAR]);
    // Frame 2: the far one is gone (distance), the middle one draws its low window.
    const stats = emptyPopulationCullStats();
    drawn = cullPopulationInstancesOnCpu(f, u, batch, true, frameParams(), [], compacted, stats);
    assert.equal(drawn, 2);
    assert.equal(stats.culledDistance, 1);
    const flagsByTag = new Map(Array.from({ length: drawn }, (_, k) => [compacted[k * INSTANCE_RECORD_WORDS + 16]!, compacted[k * INSTANCE_RECORD_WORDS + 18]!]));
    assert.deepEqual([...flagsByTag.entries()].sort(), [[0, 0], [1, 1]]);
  });

  test("a batch the object culler culled draws nothing but still updates its bits", () => {
    const { f, u } = records([{ x: 0, y: 0, z: 40, s: 1 }]);
    const stats = emptyPopulationCullStats();
    const drawn = cullPopulationInstancesOnCpu(f, u, batchOf(1, { flags: POP_CULL_DISTANCE, maxDistance: 10 }), false, frameParams(), [], null, stats);
    assert.equal(drawn, 0);
    assert.equal(stats.culledBatch, 1);
    assert.equal(u[18]! & INSTANCE_FLAG_FAR, INSTANCE_FLAG_FAR);
  });

  test("HiZ never culls a visible instance and culls most hidden ones (statistical, 600 instances)", () => {
    // A wall 5 m in front of the eye over the left half of the screen; open sky (depth 1) elsewhere.
    const wallDepth = 5;
    const wallNdc = (FAR - (NEAR * FAR) / wallDepth) / (FAR - NEAR);
    const depth = new Float32Array(WIDTH * HEIGHT).fill(1);
    for (let y = 0; y < HEIGHT; y++) for (let x = 0; x < WIDTH / 2; x++) depth[y * WIDTH + x] = wallNdc;
    const levels = hizLevelCount(WIDTH, HEIGHT);
    const hiz = buildHizOnCpu(depth, WIDTH, HEIGHT, NEAR, FAR, levels);
    const params = frameParams(CULL_FLAG_FRUSTUM, levels);
    const viewDepthOf = (ndc: number) => (NEAR * FAR) / Math.max(FAR - ndc * (FAR - NEAR), 1e-6);
    const r = rng(11);
    const pts = Array.from({ length: 600 }, () => ({ x: (r() - 0.5) * 20, y: (r() - 0.5) * 12, z: -2 + r() * 30, s: 0.3 + r() * 0.6 }));
    const { f, u } = records(pts);
    const compacted = new Uint32Array(f.length);
    const stats = emptyPopulationCullStats();
    const drawn = cullPopulationInstancesOnCpu(f, u, batchOf(pts.length, { flags: POP_CULL_OCCLUSION }), true, params, hiz, compacted, stats);
    const kept = tagsOf(compacted, drawn);
    const planes = cullPlanesFrom(params.viewProj);
    let hidden = 0;
    let falseCulls = 0;
    pts.forEach((p, i) => {
      const radius = 0.5 * p.s + 0.01;
      if (cullSphereOnCpu(p.x, p.y, p.z, radius, 0, CULL_FLAG_FRUSTUM, params, planes, []) !== CullReason.Visible) return;
      // Brute force: the sphere's view-space box projected to pixels; hidden iff every pixel is nearer.
      const view = params.view;
      const vx = view[0]! * p.x + view[4]! * p.y + view[8]! * p.z + view[12]!;
      const vy = view[1]! * p.x + view[5]! * p.y + view[9]! * p.z + view[13]!;
      const vz = view[2]! * p.x + view[6]! * p.y + view[10]! * p.z + view[14]!;
      const nearest = vz - radius;
      let isHidden = nearest > NEAR;
      if (isHidden) {
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (let c = 0; c < 8; c++) {
          const px = vx + (c & 1 ? radius : -radius), py = vy + (c & 2 ? radius : -radius), pz = vz + (c & 4 ? radius : -radius);
          const sx = (0.5 + (0.5 * params.proj[0]! * px) / pz) * WIDTH, sy = (0.5 - (0.5 * params.proj[5]! * py) / pz) * HEIGHT;
          x0 = Math.min(x0, sx); y0 = Math.min(y0, sy); x1 = Math.max(x1, sx); y1 = Math.max(y1, sy);
        }
        for (let y = Math.max(0, Math.floor(y0)); y <= Math.min(HEIGHT - 1, Math.floor(y1)) && isHidden; y++) {
          for (let x = Math.max(0, Math.floor(x0)); x <= Math.min(WIDTH - 1, Math.floor(x1)); x++) {
            if (viewDepthOf(depth[y * WIDTH + x]!) >= nearest) { isHidden = false; break; }
          }
        }
      }
      if (isHidden) hidden++;
      if (!isHidden && !kept.has(i)) falseCulls++;
    });
    assert.equal(falseCulls, 0, "an instance with any visible pixel was culled");
    assert.ok(hidden > 50, `fixture has hidden instances (${hidden})`);
    // Conservative margins (pad pixel, coarse level) keep some hidden ones; most must still go.
    assert.ok(stats.culledOccluded >= hidden * 0.5, `occluded ${stats.culledOccluded} of ${hidden} truly hidden`);
  });

  test("tiers: every tier culls per instance, the low tier skips HiZ", () => {
    assert.deepEqual(populationCullingForTier("low"), { populationCulling: true, populationOcclusion: false, populationShadowCulling: "cascades", populationDistanceScale: 0.75 });
    assert.deepEqual(populationCullingForTier("medium"), { populationCulling: true, populationOcclusion: true, populationShadowCulling: "all", populationDistanceScale: 1 });
    assert.deepEqual(populationCullingForTier("high"), { populationCulling: true, populationOcclusion: true, populationShadowCulling: "all", populationDistanceScale: 1.5 });
    assert.deepEqual(POPULATION_DISTANCE_SCALE_BY_TIER, { low: 0.75, medium: 1, high: 1.5 });
  });

  test("the kernels are valid WGSL and stay within 8 storage buffers per stage", () => {
    // Declared bindings; the shared group-1 layout adds the one binding each kernel does not read
    // (views: the HiZ-survivor list; cull: the caster indices), so the layouts are 6 and 7.
    for (const [shader, declared] of [[POPULATION_CULL_SHADER, 6], [POPULATION_VIEW_CULL_SHADER, 5]] as const) {
      assert.deepEqual(validateWgsl(shader), []);
      const storage = shader.match(/var<storage/g) ?? [];
      assert.equal(storage.length, declared);
      assert.ok(storage.length + 1 <= 8, `${storage.length + 1} storage bindings in the layout`);
      assertContains(shader, "@workgroup_size(64)");
    }
    assert.deepEqual(validateWgsl(DEPTH_CULLED_VERTEX), []);
    assert.equal((DEPTH_CULLED_VERTEX.match(/var<storage/g) ?? []).length, 2);
  });

  test("views + occlusion stages compose to the single-pass reference (frustum, distance, HiZ)", () => {
    const wallDepth = 5;
    const wallNdc = (FAR - (NEAR * FAR) / wallDepth) / (FAR - NEAR);
    const depth = new Float32Array(WIDTH * HEIGHT).fill(1);
    for (let y = 0; y < HEIGHT; y++) for (let x = 0; x < WIDTH / 2; x++) depth[y * WIDTH + x] = wallNdc;
    const levels = hizLevelCount(WIDTH, HEIGHT);
    const hiz = buildHizOnCpu(depth, WIDTH, HEIGHT, NEAR, FAR, levels);
    const params = frameParams(CULL_FLAG_FRUSTUM, levels);
    const r = rng(23);
    const pts = Array.from({ length: 500 }, () => ({ x: (r() - 0.5) * 40, y: (r() - 0.5) * 16, z: -4 + r() * 70, s: 0.3 + r() * 0.6 }));
    for (const occlude of [false, true]) {
      const batch = batchOf(pts.length, { flags: POP_CULL_DISTANCE | POP_CULL_LOD | (occlude ? POP_CULL_OCCLUSION : 0), maxDistance: 45, lodDistance: 20 });
      const ref = records(pts);
      const two = records(pts);
      const refOut = new Uint32Array(ref.f.length);
      const refStats = emptyPopulationCullStats();
      const list = new Uint32Array(two.f.length);
      const kept = new Uint32Array(two.f.length);
      const stats = emptyPopulationCullStats();
      for (let frame = 0; frame < 2; frame++) {
        refStats.tested = refStats.drawn = refStats.culledFrustum = refStats.culledDistance = refStats.culledOccluded = refStats.culledBatch = 0;
        Object.assign(stats, emptyPopulationCullStats());
        const refDrawn = cullPopulationInstancesOnCpu(ref.f, ref.u, batch, true, params, hiz, refOut, refStats);
        const listed = cullPopulationViewsOnCpu(two.f, two.u, batch, cullPlanesFrom(params.viewProj), [], list, null, 0, new Uint32Array(0), stats);
        const survivors = cullPopulationOcclusionOnCpu(two.f, two.u, batch, list, listed, true, params, hiz, kept, stats);
        const drawnOut = occlude ? kept : list;
        const drawn = occlude ? survivors : listed;
        assert.deepEqual(tagsOf(drawnOut, drawn), tagsOf(refOut, refDrawn), `frame ${frame} occlude ${occlude}: same drawn set`);
        assert.deepEqual(stats, { ...refStats, shadowTested: 0, shadowDrawn: 0 }, `frame ${frame} occlude ${occlude}: same counters`);
        // The bits the next frame reads are identical, and the list carries the previous bits.
        assert.deepEqual(Array.from(two.u.filter((_, k) => k % INSTANCE_RECORD_WORDS === 18)), Array.from(ref.u.filter((_, k) => k % INSTANCE_RECORD_WORDS === 18)));
        // forge.main never draws an instance the prepass list lacks (no hole).
        const listTags = tagsOf(list, listed);
        for (const t of tagsOf(drawnOut, drawn)) assert.ok(listTags.has(t));
      }
      if (occlude) assert.ok(stats.culledOccluded > 20, `HiZ dropped ${stats.culledOccluded}`);
    }
  });

  test("shadow casters: exactly the spheres inside each light frustum, including off-screen casters", () => {
    // A sun cascade looking straight down over a 40 m square, and the camera looking along +z.
    const lightView = new Mat4().setLookAt(new Vec3(0, 80, 20), new Vec3(0, 0, 20), new Vec3(0, 0, 1));
    const lightProj = new Mat4().setOrthographic(-20, 20, -20, 20, 1, 120);
    const cascade = new Mat4().multiplyMatrices(lightProj, lightView);
    // A second, smaller map (a spot-like perspective frustum) to exercise per-map ranges.
    const spotView = new Mat4().setLookAt(new Vec3(-10, 15, 10), new Vec3(-10, 0, 10), new Vec3(0, 0, 1));
    const spot = new Mat4().multiplyMatrices(new Mat4().setPerspective(Math.PI / 4, 1, 0.1, 40), spotView);
    const r = rng(31);
    const pts = Array.from({ length: 600 }, () => ({ x: (r() - 0.5) * 70, y: r() * 4, z: -15 + r() * 70, s: 0.4 + r() }));
    const { f, u } = records(pts);
    const stride = Math.ceil(pts.length / 64) * 64;
    const indices = new Uint32Array(stride * 2).fill(0xffffffff);
    const counts = new Uint32Array(2);
    const stats = emptyPopulationCullStats();
    const mainPlanes = cullPlanesFrom(frameParams().viewProj);
    const shadowPlanes = [cullPlanesFrom(cascade.m), cullPlanesFrom(spot.m)];
    cullPopulationViewsOnCpu(f, u, batchOf(pts.length), mainPlanes, shadowPlanes, null, indices, stride, counts, stats);
    let offscreenCasters = 0;
    for (let k = 0; k < 2; k++) {
      const expected = new Set<number>();
      pts.forEach((p, i) => {
        if (!sphereOutsidePlanes(shadowPlanes[k]!, p.x, p.y, p.z, 0.5 * p.s + 0.01)) expected.add(i);
      });
      const got = new Set(Array.from(indices.subarray(k * stride, k * stride + counts[k]!)));
      assert.equal(counts[k], expected.size);
      assert.deepEqual(got, expected, `map ${k}: exact caster set`);
      // Nothing written past the range (ranges never overlap).
      for (let j = k * stride + counts[k]!; j < (k + 1) * stride; j++) assert.equal(indices[j], 0xffffffff);
      for (const i of got) if (sphereOutsidePlanes(mainPlanes, pts[i]!.x, pts[i]!.y, pts[i]!.z, 0.5 * pts[i]!.s + 0.01)) offscreenCasters++;
    }
    assert.ok(offscreenCasters > 10, `off-screen casters kept for the shadow maps (${offscreenCasters})`);
    assert.equal(stats.shadowTested, 1200);
    assert.equal(stats.shadowDrawn, counts[0]! + counts[1]!);
    assert.ok(counts[0]! < 600 && counts[0]! > 50, `the cascade keeps a subset (${counts[0]})`);
  });
});

class StaticPopulation extends SceneObject implements PopulationSource {
  readonly name = "static-population";
  constructor(private readonly submission: PopulationSubmission) {
    super();
  }
  collectPopulations(collector: PopulationCollector): void {
    collector.addPopulationBatch(this.submission);
  }
}


group("Population distance fade (fe-31)", () => {
  test("the fade is 1 before its start, smoothstep to 0 at the end, and off when the end is 0", () => {
    assert.equal(populationFadeScale(10, 60, 80), 1);
    assert.equal(populationFadeScale(60, 60, 80), 1);
    assert.equal(populationFadeScale(70, 60, 80), 0.5);
    assert.equal(populationFadeScale(80, 60, 80), 0);
    assert.equal(populationFadeScale(500, 60, 80), 0);
    assert.equal(populationFadeScale(500, 0, 0), 1);
    let last = 1;
    for (let d = 60; d <= 80; d += 0.25) {
      const v = populationFadeScale(d, 60, 80);
      assert.ok(v <= last, `monotonic at ${d}`);
      last = v;
    }
    // The device copy is the same formula (pinned by text: the WGSL cannot run here).
    assertContains(POPULATION_FADE_WGSL, "if (fade.y <= 0.0)");
    assertContains(POPULATION_FADE_WGSL, "clamp((distance(pivot, camera) - fade.x) / max(fade.y - fade.x, 1e-3), 0.0, 1.0)");
    assertContains(POPULATION_FADE_WGSL, "return 1.0 - t * t * (3.0 - 2.0 * t);");
  });

  test("the cull distance is the fade end: an instance is culled exactly when its fade has reached 0", () => {
    const r = rng(31);
    const pts = Array.from({ length: 500 }, () => ({ x: (r() - 0.5) * 40, y: (r() - 0.5) * 10, z: r() * 120, s: 0.3 + r() * 2 }));
    const { f, u } = records(pts);
    const maxDistance = 70;
    const batch = batchOf(pts.length, { flags: POP_CULL_DISTANCE, maxDistance });
    cullPopulationOcclusionOnCpu(f, u, batch, new Uint32Array(f.length), 0, true, frameParams(), [], null);
    let far = 0;
    pts.forEach((p, i) => {
      const d = Math.hypot(p.x - EYE.x, p.y - EYE.y, p.z - EYE.z);
      const culled = (u[i * INSTANCE_RECORD_WORDS + 18]! & INSTANCE_FLAG_FAR) !== 0;
      // Pivot distance, independent of the instance's size (the fade scales about the pivot).
      assert.equal(culled, d > maxDistance, `instance ${i} at ${d.toFixed(2)} m`);
      if (culled) {
        far++;
        assert.equal(populationFadeScale(d, maxDistance * 0.75, maxDistance), 0, "culled only once fully shrunk");
      }
    });
    assert.ok(far > 50 && far < 450, `a meaningful split (${far} far)`);
  });

  test("an instance past the fade end casts nothing: the views pass leaves it out of every shadow list", () => {
    const pts = Array.from({ length: 8 }, (_, k) => ({ x: 0, y: 0, z: k * 2, s: 1 }));
    const { f, u } = records(pts);
    for (const k of [1, 4, 6]) u[k * INSTANCE_RECORD_WORDS + 18] = INSTANCE_FLAG_FAR;
    const batch = batchOf(8, { flags: POP_CULL_DISTANCE, maxDistance: 5 });
    // Six planes that accept everything (0·p + 1e6 ≥ 0): only the far bit can drop a caster.
    const everything = new Float32Array(24).map((_, i) => (i % 4 === 3 ? 1e6 : 0));
    const indices = new Uint32Array(64 * 2);
    const counts = new Uint32Array(2);
    const stats = emptyPopulationCullStats();
    cullPopulationViewsOnCpu(f, u, batch, everything, [everything, everything], null, indices, 64, counts, stats);
    assert.deepEqual([...counts], [5, 5]);
    for (const k of [0, 1]) assert.deepEqual([...indices.subarray(k * 64, k * 64 + 5)], [0, 2, 3, 5, 7]);
    assert.equal(stats.shadowTested, 10, "far instances are not even tested");
    assert.equal(stats.culledDistance, 3);
  });

  test("every population vertex entry shrinks by the fade; colour and prepass use the camera, shadows the main camera", () => {
    for (const [name, src, n] of [
      ["standard", STANDARD_VERTEX, 1],
      ["standard instanced", STANDARD_INSTANCED_VERTEX, 1],
      ["standard LOD", STANDARD_LOD_INSTANCED_VERTEX, 1],
    ] as const) {
      assert.equal(src.split("populationFadeScale(").length - 2, n, `${name}: one call besides the definition`);
      assertContains(src, "perFrame.cameraPosRender, objectData.distanceFade)");
      assertContains(src, "input.position * fade");
    }
    assert.equal(DEPTH_VERTEX.split("shadowPass.fadeCamera, objectData.distanceFade)").length - 1, 3, "shadow: plain, instanced, LOD");
    assert.equal(DEPTH_CULLED_VERTEX.split("shadowPass.fadeCamera, objectData.distanceFade)").length - 1, 2, "device-culled shadow: plain and LOD");
    for (const src of [DEPTH_VERTEX, DEPTH_CULLED_VERTEX]) assert.equal(validateWgsl(src).length, 0);
    assert.equal(ObjectUniforms.offsetOf("distanceFade"), 176);
    assert.equal(ShadowPassUniforms.offsetOf("fadeCamera"), 80);
  });
});

group("Population cull - renderer on the mock device", () => {
  async function fixture(options: { populationCulling?: boolean; populationDistanceScale?: number; populationFadeFraction?: number } = {}) {
    const device = await GraphicsDevice.create({ forceMock: true });
    device.resize(320, 180);
    const mock = device.mock;
    // objectCulling "gpu": the device culler runs (validated, not executed — its words stay "visible")
    // and the per-instance kernel runs through its twin.
    const renderer = new Renderer(device, { shadowMapSize: 256, objectCulling: "gpu", ...options });
    const scene = new Scene({ name: "population-cull" });
    const cameraEntity = scene.createTransformedEntity("camera", new Vec3(0, 2, -8));
    const camera = new Camera();
    camera.far = 300;
    scene.world.addComponent(cameraEntity.id, camera);
    cameraEntity.transform.lookAt(new Vec3(0, 0, 0));
    const lod = buildLodGeometry({
      hi: unindexedLodWindow(rockGeometrySource({ radius: 0.5, seed: 3, segments: 8 })),
      lo: unindexedLodWindow(rockGeometrySource({ radius: 0.5, seed: 3, segments: 4 })),
    });
    const geometry = Geometry.create(device, lod.source);
    const material = new Material({ label: "rock", color: 0x886655 });
    // A 20×20 grid of rocks from x −40..+36, z 0..76: much of it sits outside the 60° view.
    const block = new PopulationInstanceBlock(400);
    for (let k = 0; k < 400; k++) {
      block.positions[k * 3] = (k % 20) * 4 - 40;
      block.positions[k * 3 + 1] = 0;
      block.positions[k * 3 + 2] = Math.floor(k / 20) * 4;
      block.scales.fill(1, k * 3, k * 3 + 3);
      block.count = k + 1;
    }
    const submission: PopulationSubmission = {
      geometry,
      material,
      instances: block,
      bounds: new AABB(new Vec3(-41, -1, -1), new Vec3(37, 1, 77)),
      castShadow: false,
      maxDistance: 60,
      lod: { hiTriangles: lod.hiTriangles, lodDistance: 25 },
    };
    scene.add(new StaticPopulation(submission));
    return {
      mock,
      renderer,
      scene,
      async dispose() {
        renderer.dispose();
        material.dispose();
        geometry.dispose();
        scene.dispose();
        await device.dispose();
        assert.deepEqual(mock.outstanding.buffers, []);
      },
    };
  }

  test("one merged dispatch replaces the LOD pass and forge.main draws the compacted count", async () => {
    const f = await fixture();
    f.renderer.renderScene(f.scene);
    f.renderer.renderScene(f.scene);
    assert.deepEqual(f.mock.errors, []);
    assert.equal(f.renderer.stats.populationCullBatches, 1);
    assert.equal(f.renderer.stats.populationLodBatches, 0);
    assertContains(f.renderer.passNames, "forge.populationCull");
    assertNotContains(f.renderer.passNames, "forge.populationLod");
    const draws = f.mock.commandLog.filter((e) => e.type === "draw" && (e as { indirect?: boolean }).indirect && (e as { label?: string }).label === "forge.main") as unknown as { instanceCount: number }[];
    const popDraw = draws.at(-1);
    assert.ok(popDraw, "forge.main drew the batch indirectly");
    assert.ok(popDraw.instanceCount > 0 && popDraw.instanceCount < 400, `drawn ${popDraw.instanceCount} of 400`);
    // Readout: the counters come back through the same readback a device uses.
    for (let i = 0; i < 3; i++) {
      f.renderer.renderScene(f.scene);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    const s = f.renderer.stats;
    assert.equal(s.populationInstancesTested, 400);
    assert.ok(s.populationInstancesDrawn > 0 && s.populationInstancesDrawn < 400);
    assert.equal(s.populationInstancesDrawn + s.populationCulledFrustum + s.populationCulledDistance + s.populationCulledOccluded + s.populationCulledBatch, 400);
    assert.ok(s.populationCulledDistance > 0, "the 60 m limit drops the far rows");
    await f.dispose();
  });

  test("the tier distance scale moves the cull distance and the fade end together, on both paths (fe-31)", async () => {
    const culledAt = async (scale: number) => {
      const f = await fixture({ populationDistanceScale: scale });
      for (let i = 0; i < 4; i++) {
        f.renderer.renderScene(f.scene);
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      assert.deepEqual(f.mock.errors, []);
      const culled = f.renderer.stats.populationCulledDistance;
      const internals = f.renderer as unknown as { batchPool: { population: unknown; objectOffset: number; maxDistance: number }[] };
      const pop = internals.batchPool.find((b) => b.population)!;
      assert.equal(pop.maxDistance, 60 * scale);
      const objects = new Float32Array(([...f.mock.liveBuffers].find((b) => b.label === "draw.uniforms") as unknown as { data: ArrayBuffer }).data);
      const at = (pop.objectOffset + ObjectUniforms.offsetOf("distanceFade")) / 4;
      assert.deepEqual([...objects.subarray(at, at + 2)], [Math.fround(60 * scale * 0.75), Math.fround(60 * scale)], "fade (start, end) = the scaled limit");
      await f.dispose();
      return culled;
    };
    const low = await culledAt(0.75);
    const medium = await culledAt(1);
    const high = await culledAt(1.5);
    assert.ok(low > medium && medium > high, `distant culls ${low} > ${medium} > ${high}`);

    // The per-batch path fades too (the object uniform carries it); a fraction of 0 turns it off.
    const perBatch = await fixture({ populationCulling: false, populationFadeFraction: 0 });
    perBatch.renderer.renderScene(perBatch.scene);
    const internals = perBatch.renderer as unknown as { batchPool: { population: unknown; objectOffset: number }[] };
    const objects = new Float32Array(([...perBatch.mock.liveBuffers].find((b) => b.label === "draw.uniforms") as unknown as { data: ArrayBuffer }).data);
    const at = (internals.batchPool.find((b) => b.population)!.objectOffset + ObjectUniforms.offsetOf("distanceFade")) / 4;
    assert.deepEqual([...objects.subarray(at, at + 2)], [0, 0]);
    perBatch.renderer.populationFadeFraction = 0.5;
    perBatch.renderer.renderScene(perBatch.scene);
    const objects2 = new Float32Array(([...perBatch.mock.liveBuffers].find((b) => b.label === "draw.uniforms") as unknown as { data: ArrayBuffer }).data);
    const at2 = (internals.batchPool.find((b) => b.population)!.objectOffset + ObjectUniforms.offsetOf("distanceFade")) / 4;
    assert.deepEqual([...objects2.subarray(at2, at2 + 2)], [30, 60]);
    await perBatch.dispose();
  });

  test("populationCulling: false keeps the per-batch path (LOD pass, no cull pass)", async () => {
    const f = await fixture({ populationCulling: false });
    f.renderer.renderScene(f.scene);
    assert.deepEqual(f.mock.errors, []);
    assert.equal(f.renderer.stats.populationCullBatches, 0);
    assert.equal(f.renderer.stats.populationLodBatches, 1);
    assertContains(f.renderer.passNames, "forge.populationLod");
    assertNotContains(f.renderer.passNames, "forge.populationCull");
    await f.dispose();
  });

  test("switching off at runtime falls back without stale distance bits", async () => {
    const f = await fixture();
    for (let i = 0; i < 3; i++) f.renderer.renderScene(f.scene);
    f.renderer.populationCulling = false;
    f.renderer.renderScene(f.scene);
    assert.deepEqual(f.mock.errors, []);
    assertContains(f.renderer.passNames, "forge.populationLod");
    const src = [...f.mock.liveBuffers].find((b) => b.label === "population.instances") as unknown as { data: ArrayBuffer };
    const u = new Uint32Array(src.data);
    for (let k = 0; k < 400; k++) assert.equal(u[k * INSTANCE_RECORD_WORDS + 18]! & INSTANCE_FLAG_FAR, 0);
    await f.dispose();
  });
});

group("Population shadow cull - renderer on the mock device", () => {
  type DrawEntry = { type: string; label?: string; indirect?: boolean; instanceCount: number };
  const drawsIn = (log: readonly unknown[], prefix: string) => (log as DrawEntry[]).filter((e) => (e.type === "draw" || e.type === "drawIndexed") && (e.label ?? "").startsWith(prefix));

  async function shadowFixture(mode: "all" | "cascades" | "off") {
    return await (async () => {
      const device = await GraphicsDevice.create({ forceMock: true });
      device.resize(320, 180);
      const mock = device.mock;
      const renderer = new Renderer(device, { shadowMapSize: 256, objectCulling: "gpu", populationShadowCulling: mode });
      const scene = new Scene({ name: "population-shadow-cull" });
      scene.settings.shadow.cascades = 2;
      scene.settings.shadow.distance = 60;
      const cameraEntity = scene.createTransformedEntity("camera", new Vec3(0, 2, -8));
      const camera = new Camera();
      camera.far = 300;
      scene.world.addComponent(cameraEntity.id, camera);
      cameraEntity.transform.lookAt(new Vec3(0, 0, 0));
      const sunEntity = scene.createTransformedEntity("sun", new Vec3(30, 60, 0));
      const sun = sunEntity.add(new Light());
      sun.kind = "directional";
      sun.castShadow = true;
      sunEntity.transform.lookAt(new Vec3(0, 0, 20));
      const geometry = Geometry.create(device, rockGeometrySource({ radius: 0.5, seed: 3, segments: 6 }));
      const material = new Material({ label: "rock", color: 0x886655 });
      const block = new PopulationInstanceBlock(400);
      for (let k = 0; k < 400; k++) {
        block.positions[k * 3] = (k % 20) * 4 - 40;
        block.positions[k * 3 + 1] = 0;
        block.positions[k * 3 + 2] = Math.floor(k / 20) * 4;
        block.scales.fill(1, k * 3, k * 3 + 3);
        block.rotations[k] = k * 0.37;
        block.count = k + 1;
      }
      scene.add(new StaticPopulation({ geometry, material, instances: block, bounds: new AABB(new Vec3(-41, -1, -1), new Vec3(37, 1, 77)), castShadow: true, maxDistance: 0 }));
      return {
        mock,
        renderer,
        scene,
        async dispose() {
          renderer.dispose();
          material.dispose();
          geometry.dispose();
          scene.dispose();
          await device.dispose();
          assert.deepEqual(mock.outstanding.buffers, []);
        },
      };
    })();
  }

  test("device caster lists lose no caster: every dropped instance is provably outside its light frustum", async () => {
    const cpu = await shadowFixture("off");
    cpu.renderer.renderScene(cpu.scene);
    cpu.mock.commandLog.length = 0;
    cpu.renderer.renderScene(cpu.scene);
    assert.deepEqual(cpu.mock.errors, []);
    const cpuPerMap = [0, 1].map((c) => drawsIn(cpu.mock.commandLog, `forge.shadow.${c}`).reduce((n, d) => n + d.instanceCount, 0));
    assert.equal(cpu.renderer.stats.populationShadowDraws, 0);
    await cpu.dispose();

    const gpu = await shadowFixture("all");
    gpu.renderer.renderScene(gpu.scene);
    gpu.mock.commandLog.length = 0;
    gpu.renderer.renderScene(gpu.scene);
    assert.deepEqual(gpu.mock.errors, []);
    assertContains(gpu.renderer.passNames, "forge.populationCull.views");
    const names = gpu.renderer.passNames;
    assert.ok(names.indexOf("forge.populationCull.views") < names.indexOf("forge.shadow.0"), "views pass before the shadow passes");
    assert.ok(names.indexOf("forge.populationCull.views") < names.indexOf("forge.prepass"), "views pass before the prepass");
    assert.equal(gpu.renderer.stats.populationShadowDraws, 2, "one indirect draw per cascade");
    const casters = new Uint32Array(([...gpu.mock.liveBuffers].find((b) => b.label === "population.shadow.casters") as unknown as { data: ArrayBuffer }).data);
    const internals = gpu.renderer as unknown as { cascades: { viewProj: Mat4 }[] };
    const rock = rockGeometrySource({ radius: 0.5, seed: 3, segments: 6 });
    const stride = 448;
    for (const c of [0, 1]) {
      const draws = drawsIn(gpu.mock.commandLog, `forge.shadow.${c}`);
      assert.equal(draws.length, 1);
      assert.ok(draws[0]!.indirect, "drawn from the caster record");
      const n = draws[0]!.instanceCount;
      // Within a few of the CPU box assignment (sphere and box are each conservative in different corners).
      assert.ok(Math.abs(n - cpuPerMap[c]!) <= Math.max(4, cpuPerMap[c]! * 0.1), `cascade ${c}: ${n} device casters vs ${cpuPerMap[c]} CPU`);
      assert.ok(n > 0 && n <= 400 && (c > 0 || n < 400), `cascade ${c}: ${n} of 400 (the near cascade culls)`);
      const kept = new Set(Array.from(casters.subarray(c * stride, c * stride + n)));
      assert.equal(kept.size, n, "no duplicate casters");
      // Vertex-exact: an instance left out must have every vertex outside one plane of the map.
      const planes = cullPlanesFrom(internals.cascades[c]!.viewProj.m);
      for (let k = 0; k < 400; k++) {
        if (kept.has(k)) continue;
        const x0 = (k % 20) * 4 - 40, z0 = Math.floor(k / 20) * 4, yaw = k * 0.37;
        const cs = Math.cos(yaw), sn = Math.sin(yaw);
        let outside = false;
        for (let row = 0; row < 6 && !outside; row++) {
          const [nx, ny, nz, d] = [planes[row * 4]!, planes[row * 4 + 1]!, planes[row * 4 + 2]!, planes[row * 4 + 3]!];
          let all = true;
          for (let v = 0; v < rock.positions.length && all; v += 3) {
            const px = rock.positions[v]!, py = rock.positions[v + 1]!, pz = rock.positions[v + 2]!;
            // Both yaw conventions: the test only needs *one* plane to exclude both candidates.
            const wx1 = x0 + cs * px + sn * pz, wz1 = z0 - sn * px + cs * pz;
            const wx2 = x0 + cs * px - sn * pz, wz2 = z0 + sn * px + cs * pz;
            if (nx * wx1 + ny * py + nz * wz1 + d >= 0 || nx * wx2 + ny * py + nz * wz2 + d >= 0) all = false;
          }
          outside = all;
        }
        assert.ok(outside, `cascade ${c}: instance ${k} dropped but a vertex is inside a plane set`);
      }
    }
    // The prepass draws the main-view list; forge.main draws that list (the mock never occludes).
    const pre = drawsIn(gpu.mock.commandLog, "forge.prepass").filter((d) => d.indirect);
    const main = drawsIn(gpu.mock.commandLog, "forge.main").filter((d) => d.indirect);
    assert.equal(pre.length, 1);
    assert.equal(pre[0]!.instanceCount, main.at(-1)!.instanceCount);
    assert.ok(pre[0]!.instanceCount > 0 && pre[0]!.instanceCount < 400);
    for (let i = 0; i < 3; i++) {
      gpu.renderer.renderScene(gpu.scene);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    const s = gpu.renderer.stats;
    assert.equal(s.populationShadowInstancesTested, 800, "400 casters × 2 cascades");
    assert.ok(s.populationShadowInstancesDrawn > 0 && s.populationShadowInstancesDrawn < 800);
    await gpu.dispose();
  });

  test("the cascades-only mode (low tier) indexes only the cascades", async () => {
    const f = await shadowFixture("cascades");
    f.renderer.renderScene(f.scene);
    f.renderer.renderScene(f.scene);
    assert.deepEqual(f.mock.errors, []);
    assert.equal(f.renderer.stats.populationShadowDraws, 2);
    const casters = [...f.mock.liveBuffers].find((b) => b.label === "population.shadow.casters") as unknown as { size: number };
    // Two ranges of 400 → 448 slots (64-aligned) × 4 B.
    assert.equal(casters.size, 448 * 4 * 2);
    // fe-31: every shadow-pass record carries the main camera, so casters fade exactly like forge.main.
    const passes = new Float32Array(([...f.mock.liveBuffers].find((b) => b.label === "shadowpass.uniforms") as unknown as { data: ArrayBuffer }).data);
    for (const layer of [0, 1]) {
      const at = (layer * 256 + ShadowPassUniforms.offsetOf("fadeCamera")) / 4;
      assert.deepEqual([...passes.subarray(at, at + 3)], [0, 2, -8]);
    }
    await f.dispose();
  });
});

await finish();
