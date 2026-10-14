/**
 * @suite population:populationCull
 * @group unit
 * @covers engine/src/population/cull.ts
 * @covers engine/src/rendering/objectCulling.ts
 * @covers engine/src/rendering/populationCuller.ts
 * @covers engine/src/rendering/renderer.ts
 * @covers engine/src/rendering/shaders/populationCull.ts
 * @covers engine/src/rendering/shaders/populationLod.ts
 * @covers engine/src/rendering/shaders/standard.ts
 * @covers engine/src/testing/mockGpu.ts
 * @desc Per-instance population culling (Phase A): the CPU twin against brute force, the one-frame bit lag, the mock renderer path and its fallback
 */

export const suite = {
  name: "population:populationCull",
  group: "unit",
  covers: [
    "engine/src/population/cull.ts",
    "engine/src/rendering/objectCulling.ts",
    "engine/src/rendering/populationCuller.ts",
    "engine/src/rendering/renderer.ts",
    "engine/src/rendering/shaders/populationCull.ts",
    "engine/src/rendering/shaders/populationLod.ts",
    "engine/src/rendering/shaders/standard.ts",
    "engine/src/testing/mockGpu.ts"
  ],
  desc: "Per-instance population culling (Phase A): the CPU twin against brute force, the one-frame bit lag, the mock renderer path and its fallback",
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
  hizLevelCount,
  populationCullingForTier,
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
    assert.deepEqual(populationCullingForTier("low"), { populationCulling: true, populationOcclusion: false });
    assert.deepEqual(populationCullingForTier("medium"), { populationCulling: true, populationOcclusion: true });
    assert.deepEqual(populationCullingForTier("high"), { populationCulling: true, populationOcclusion: true });
  });

  test("the kernel is valid WGSL and stays within 8 storage buffers per stage", () => {
    assert.deepEqual(validateWgsl(POPULATION_CULL_SHADER), []);
    const storage = POPULATION_CULL_SHADER.match(/var<storage/g) ?? [];
    assert.ok(storage.length <= 8, `${storage.length} storage bindings`);
    assert.equal(storage.length, 5);
    assertContains(POPULATION_CULL_SHADER, "@workgroup_size(64)");
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

group("Population cull - renderer on the mock device", () => {
  async function fixture(options: { populationCulling?: boolean } = {}) {
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

await finish();
