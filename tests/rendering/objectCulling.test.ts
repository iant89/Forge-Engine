/**
 * @suite rendering:objectCulling
 * @group unit
 * @covers engine/src/gpu/constants.ts
 * @covers engine/src/gpu/device.ts
 * @covers engine/src/gpu/shaderCache.ts
 * @covers engine/src/index.ts
 * @covers engine/src/math/geometry.ts
 * @covers engine/src/math/mat.ts
 * @covers engine/src/math/vec.ts
 * @covers engine/src/rendering/objectCulling.ts
 * @covers engine/src/rendering/pipeline.ts
 * @covers engine/src/rendering/renderGraph.ts
 * @covers engine/src/rendering/uniforms.ts
 * @desc GPU object culling — engine/src/rendering/objectCulling.ts (Phase 13.5, docs/RENDERING.md §4d)
 */

export const suite = {
  name: "rendering:objectCulling",
  group: "unit",
  covers:   [
    "engine/src/gpu/constants.ts",
    "engine/src/gpu/device.ts",
    "engine/src/gpu/shaderCache.ts",
    "engine/src/index.ts",
    "engine/src/math/geometry.ts",
    "engine/src/math/mat.ts",
    "engine/src/math/vec.ts",
    "engine/src/rendering/objectCulling.ts",
    "engine/src/rendering/pipeline.ts",
    "engine/src/rendering/renderGraph.ts",
    "engine/src/rendering/uniforms.ts"
  ],
  desc: "GPU object culling — engine/src/rendering/objectCulling.ts (Phase 13.5, docs/RENDERING.md §4d)",
};
/**
 * GPU object culling — `engine/src/rendering/objectCulling.ts` (Phase 13.5, docs/RENDERING.md §4d).
 *
 * A culler that is merely fast is a culler that silently stops drawing things, so what is pinned here
 * is *conservatism* and *agreement*, not "it runs":
 *
 * - `cullPlanesFrom` against `Frustum.setFromViewProjection`: the shader extracts its own planes from
 *   the view-projection, and a plane the two derivations disagreed about is geometry that stops being
 *   drawn in one path and not the other.
 * - `cullBatchesOnCpu` (the shader's twin) against a per-point walk of the box interior: a box with
 *   *any* point inside the frustum must survive, over a deterministic sweep — the one property that
 *   separates "culls" from "culls too much".
 * - The HiZ test against the depth image it was handed: a batch it calls occluded must have no texel
 *   in its own footprint that could be in front of it, and the pixel row it reads must be the row the
 *   batch is actually over (NDC +y is up, texel row 0 is the top).
 * - The recorded pass: the block the shader reads carries the frame's matrices, the batch's distance
 *   limit travels in the bounds entry, the dispatch covers the batch count in whole workgroups, and
 *   the counters come back through a map-read copy rather than a stall.
 *
 * The real shader is compiled and run by `npm run check:browser` (the only gate that can: the mock
 * device records compute passes without executing them) and its structs are checked by
 * `tools/wgsl-check.mjs`.
 */

import assert from "node:assert/strict";
import { assertCloseTo, assertContains, assertMatchObject, assertNotContains, finish, group, test } from "selrun";
import type { RenderGraphHandle } from "@forge/engine";
import {
  BufferUsage,
  CULL_FLAG_DISTANCE,
  CULL_FLAG_FRUSTUM,
  CULL_FLAG_OCCLUSION,
  CULL_FLAG_RECORDS,
  CULL_STATS_BYTES,
  CULL_WORKGROUP,
  DRAW_RECORD_BYTES,
  DRAW_RECORD_INSTANCES,
  DRAW_RECORD_WORDS,
  CullReason,
  Frustum,
  GpuObjectCuller,
  GraphicsDevice,
  HIZ_DEPTH_SHADER,
  HIZ_LEVELS,
  HIZ_REDUCE_SHADER,
  HIZ_WORKGROUP,
  MAX_CULLED_BATCHES,
  Mat4,
  OBJECT_CULL_SHADER,
  ObjectBatchBlock,
  ObjectBatchEntry,
  ObjectCullStatsBlock,
  ObjectCullUniforms,
  PipelineFactory,
  RenderGraph,
  TextureUsage,
  Vec3,
  buildHizOnCpu,
  cullBatchesOnCpu,
  cullPlanesFrom,
  hizLevelCount,
  hizLevelSize,
  validateWgsl,
  type ObjectCullOutputs,
  type ObjectCullParams,
} from "@forge/engine";

const NEAR = 0.5;
const FAR = 200;
const WIDTH = 64;
const HEIGHT = 36;
const FOV = Math.PI / 3;

const EYE = new Vec3(0, 0, -10);
const TARGET = new Vec3(0, 0, 0);

function frameParams(overrides: Partial<ObjectCullParams> = {}): ObjectCullParams {
  const view = new Mat4().setLookAt(EYE, TARGET, new Vec3(0, 1, 0));
  const proj = new Mat4().setPerspective(FOV, WIDTH / HEIGHT, NEAR, FAR);
  const viewProj = new Mat4().multiplyMatrices(proj, view);
  return {
    view: view.m,
    proj: proj.m,
    viewProj: viewProj.m,
    cameraPos: { x: EYE.x, y: EYE.y, z: EYE.z },
    near: NEAR,
    far: FAR,
    width: WIDTH,
    height: HEIGHT,
    flags: CULL_FLAG_FRUSTUM | CULL_FLAG_DISTANCE,
    hizLevels: 0,
    ...overrides,
  };
}

/** A bounds array (`ObjectBatchEntry`: min.xyz, distance limit, max.xyz, count) from box centres. */
function boundsOf(boxes: readonly { c: Vec3; r: number; limit?: number; count?: number }[]): Float32Array {
  const out = new Float32Array(boxes.length * 8);
  boxes.forEach((b, i) => {
    const base = i * 8;
    out[base] = b.c.x - b.r;
    out[base + 1] = b.c.y - b.r;
    out[base + 2] = b.c.z - b.r;
    out[base + 3] = b.limit ?? 0;
    out[base + 4] = b.c.x + b.r;
    out[base + 5] = b.c.y + b.r;
    out[base + 6] = b.c.z + b.r;
    out[base + 7] = b.count ?? 1;
  });
  return out;
}

/** A depth image (NDC in [0,1], row-major) with a near wall over `wallColumns` columns. */
function depthImage(width: number, height: number, wallColumns: number, wallNdc: number): Float32Array {
  const depth = new Float32Array(width * height).fill(1);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < wallColumns; x++) depth[y * width + x] = wallNdc;
  }
  return depth;
}

/** A depth image with a near floor over the *bottom* rows: the Y-asymmetric case. */
function depthFloor(width: number, height: number, nearNdc: number): Float32Array {
  const depth = new Float32Array(width * height).fill(1);
  for (let y = Math.floor(height / 2); y < height; y++) {
    for (let x = 0; x < width; x++) depth[y * width + x] = nearNdc;
  }
  return depth;
}

group("cullPlanesFrom", () => {
  test("derives the same six planes as Frustum, in the same order and facing inward", () => {
    const params = frameParams();
    const planes = cullPlanesFrom(params.viewProj);
    const frustum = new Frustum().setFromViewProjection(new Mat4(params.viewProj as never));
    // The shader keeps its planes unnormalized (the sphere test scales by the row length); the
    // comparison normalizes both, which is the only difference between them.
    for (let i = 0; i < 6; i++) {
      const nx = planes[i * 4]!;
      const ny = planes[i * 4 + 1]!;
      const nz = planes[i * 4 + 2]!;
      const d = planes[i * 4 + 3]!;
      const l = Math.hypot(nx, ny, nz) || 1;
      assertCloseTo(nx / l, frustum.planes[i * 4]!, 5, `plane ${i} normal x`);
      assertCloseTo(ny / l, frustum.planes[i * 4 + 1]!, 5, `plane ${i} normal y`);
      assertCloseTo(nz / l, frustum.planes[i * 4 + 2]!, 5, `plane ${i} normal z`);
      assertCloseTo(d / l, frustum.planes[i * 4 + 3]!, 5, `plane ${i} offset`);
    }
    // Inward-facing, both ways round: a point down the camera's axis is inside, a point behind the
    // camera is outside the near plane. This is what the OpenGL pair (z+w / w-z) gets backwards on a
    // z-in-[0,1] projection.
    assert.equal(frustum.containsPoint(new Vec3(0, 0, -5)), true); // 5 m in front of the eye
    assert.equal(frustum.containsPoint(new Vec3(0, 0, 5)), true); // 15 m in front
    assert.equal(frustum.containsPoint(new Vec3(0, 0, -12)), false); // 2 m behind it
  });
});

group("cullBatchesOnCpu", () => {
  test("culls what the frustum cannot see, and only that", () => {
    const params = frameParams();
    const boxes = [
      { c: new Vec3(0, 0, 0), r: 1 }, // dead ahead
      { c: new Vec3(0, 0, -12), r: 1 }, // behind the camera (view-space z < 0)
      { c: new Vec3(0, 400, 0), r: 1 }, // far above the frustum
      { c: new Vec3(0, 0, 200), r: 0.01 }, // past the far plane
    ];
    const words = new Uint32Array(boxes.length);
    const stats = cullBatchesOnCpu(boundsOf(boxes), boxes.length, params, words);
    assert.equal(stats.tested, 4);
    assert.equal(words[0], CullReason.Visible);
    assert.equal(words[1], CullReason.Frustum);
    assert.equal(words[2], CullReason.Frustum);
    assert.equal(words[3], CullReason.Frustum);
    assert.equal(stats.culledFrustum, 3);
    assert.equal(stats.culledDistance, 0);
    assert.equal(stats.culledOccluded, 0);
  });

  test("never culls a box with a point inside the frustum (the sweep)", () => {
    // The property that matters: the sphere test may keep boxes that are outside, but it must never
    // drop one that is inside. A single point of the box's interior inside the frustum is enough to
    // make the batch visible on screen, so the culler has to keep it.
    const params = frameParams();
    const boxes: { c: Vec3; r: number }[] = [];
    for (let z = -4; z <= 4; z++) {
      for (let y = -3; y <= 3; y++) {
        for (let x = -3; x <= 3; x++) boxes.push({ c: new Vec3(x * 2.5, y * 2.5, z * 5), r: 0.75 + (x + y + z) * 0.05 });
      }
    }
    const words = new Uint32Array(boxes.length);
    cullBatchesOnCpu(boundsOf(boxes), boxes.length, params, words);
    const frustum = new Frustum().setFromViewProjection(new Mat4(params.viewProj as never));
    const point = new Vec3();
    let keptWithPointInside = 0;
    boxes.forEach((box, i) => {
      let inside = false;
      for (let sx = -1; sx <= 1 && !inside; sx++) {
        for (let sy = -1; sy <= 1 && !inside; sy++) {
          for (let sz = -1; sz <= 1 && !inside; sz++) {
            point.set(box.c.x + sx * box.r, box.c.y + sy * box.r, box.c.z + sz * box.r);
            if (frustum.containsPoint(point)) inside = true;
          }
        }
      }
      if (inside) {
        keptWithPointInside++;
        assert.equal(words[i], CullReason.Visible, `box ${i} at ${box.c.x},${box.c.y},${box.c.z}`);
      }
    });
    // The sweep has to actually exercise both sides of the test, or the assertion above is vacuous.
    assert.ok(keptWithPointInside > 20);
    assert.equal(words.some((w) => w === CullReason.Frustum), true);
  });

  test("applies each batch's own distance limit, once the sphere reaches it", () => {
    // 10 m ahead of a camera 10 m from the origin: distance 10, radius 0.5.
    const params = frameParams();
    const boxes = [
      { c: new Vec3(0, 0, 0), r: 0.5, limit: 20 }, // 10 < 20 - 0.5: kept
      { c: new Vec3(0, 0, 0), r: 0.5, limit: 11 }, // 10 < 11 - 0.5: kept (the limit is to the surface)
      { c: new Vec3(0, 0, 0), r: 0.5, limit: 10.4 }, // 10 - 0.5 = 9.5 < 10.4 - 0.5: kept
      { c: new Vec3(0, 0, 0), r: 0.5, limit: 9 }, // 10 - 0.5 = 9.5 > 9: culled
      { c: new Vec3(0, 0, 0), r: 0.5 }, // no limit: kept
    ];
    const words = new Uint32Array(boxes.length);
    const stats = cullBatchesOnCpu(boundsOf(boxes), boxes.length, params, words);
    assert.deepEqual([...words].map((w) => w === CullReason.Visible), [true, true, true, false, true]);
    assert.equal(stats.culledDistance, 1);
    assert.equal(stats.culledFrustum, 0);

    // ... and a limit that is not in the frame's flags is not applied: the flag is what says "some
    // batch in this frame wants the test", and a frame with none must not spend the work.
    const words2 = new Uint32Array(boxes.length);
    cullBatchesOnCpu(boundsOf(boxes), boxes.length, { ...params, flags: CULL_FLAG_FRUSTUM }, words2);
    assert.equal([...words2].every((w) => w === CullReason.Visible), true);
  });

  test("leaves batches past the cap alone, and writes a word for every batch it tests", () => {
    const params = frameParams();
    const count = MAX_CULLED_BATCHES + 3;
    const boxes = Array.from({ length: count }, () => ({ c: new Vec3(0, 400, 0), r: 1 })); // all above
    const words = new Uint32Array(count); // zeroes, the way the renderer resets it
    const stats = cullBatchesOnCpu(boundsOf(boxes), count, params, words);
    assert.equal(stats.tested, MAX_CULLED_BATCHES);
    assert.equal(stats.culledFrustum, MAX_CULLED_BATCHES);
    // Past the cap nothing is tested, and the reset value is "draw": an untested batch is never
    // wrongly culled, it is just not eligible for the saving.
    for (let i = MAX_CULLED_BATCHES; i < count; i++) assert.equal(words[i], CullReason.Visible);
  });
});

  test("hands the frame the records and the compaction list the pass would write", () => {
    const params = frameParams({ flags: CULL_FLAG_FRUSTUM | CULL_FLAG_DISTANCE | CULL_FLAG_RECORDS });
    const boxes = [
      { c: new Vec3(0, 0, 0), r: 1, count: 3 }, // dead ahead, three instances
      { c: new Vec3(0, 0, -12), r: 1, count: 2 }, // behind the camera
      { c: new Vec3(0, 0, -2), r: 1, count: 5, limit: 0.5 }, // 8 m out, allowed 0.5 m
    ];
    const words = new Uint32Array(3);
    const outputs: ObjectCullOutputs = { records: new Uint32Array(3 * DRAW_RECORD_WORDS), visible: new Uint32Array(MAX_CULLED_BATCHES) };
    const records = outputs.records!;
    const visibleList = outputs.visible!;
    const stats = cullBatchesOnCpu(boundsOf(boxes), 3, params, words, [], outputs);
    assert.equal(stats.tested, 3);
    assert.equal(stats.culledFrustum, 1);
    assert.equal(stats.culledDistance, 1);
    assert.equal(stats.visible, 1);
    assert.equal(stats.recordZeroed, 2);
    // Word 1 of each slot is the instance count the draw would run with: the batch's own, or zero for
    // a batch the tests dropped. The other words belong to the CPU (the batch's index window).
    assert.equal(records[0 * DRAW_RECORD_WORDS + DRAW_RECORD_INSTANCES], 3);
    assert.equal(records[1 * DRAW_RECORD_WORDS + DRAW_RECORD_INSTANCES], 0);
    assert.equal(records[2 * DRAW_RECORD_WORDS + DRAW_RECORD_INSTANCES], 0);
    // The list holds the survivors, one slot each, in test order, and nothing past the count.
    assert.deepEqual([...visibleList.slice(0, stats.visible)], [0]);
    assert.equal(visibleList[stats.visible], 0);
    // The identity the browser gate asserts on a device: the visible count is what the three culls
    // left, and the zeroed records are exactly the batches they dropped.
    assert.equal(stats.visible, stats.tested - stats.culledFrustum - stats.culledDistance - stats.culledOccluded);
    assert.equal(stats.recordZeroed, stats.culledFrustum + stats.culledDistance + stats.culledOccluded);
  });

  test("leaves the records and the list alone without the records flag", () => {
    // `CULL_FLAG_RECORDS` is the caller's switch: a frame that submits direct draws has no use for a
    // record, and the twin has to write exactly what the pass writes — nothing.
    const boxes = [{ c: new Vec3(0, 0, -12), r: 1, count: 4 }];
    const records = new Uint32Array(DRAW_RECORD_WORDS).fill(0xdeadbeef);
    const visibleList = new Uint32Array(MAX_CULLED_BATCHES).fill(0xdeadbeef);
    const stats = cullBatchesOnCpu(boundsOf(boxes), 1, frameParams(), new Uint32Array(1), [], { records, visible: visibleList });
    assert.equal(stats.culledFrustum, 1);
    assert.equal(stats.recordZeroed, 0);
    assert.deepEqual([...records], new Array(DRAW_RECORD_WORDS).fill(0xdeadbeef));
    assert.equal(visibleList[0], 0xdeadbeef);
  });

  test("keeps one slot per batch and one slot per visible batch when the cap is passed", () => {
    // A frame past `MAX_CULLED_BATCHES` leaves the extra batches untested — and visible — so they take
    // list slots and their records keep the count the CPU uploaded. Nothing is written past the cap.
    const boxes = Array.from({ length: MAX_CULLED_BATCHES + 3 }, (_, i) => ({ c: new Vec3(0, 0, -1 - i * 0.001), r: 0.5, count: 2 }));
    // Sentinel-filled: what a caller uploaded is what an untested slot must still say afterwards.
    const records = new Uint32Array((MAX_CULLED_BATCHES + 3) * DRAW_RECORD_WORDS).fill(0xa5);
    const visibleList = new Uint32Array(MAX_CULLED_BATCHES);
    const stats = cullBatchesOnCpu(boundsOf(boxes), boxes.length, frameParams({ flags: CULL_FLAG_RECORDS }), new Uint32Array(boxes.length), [], {
      records,
      visible: visibleList,
    });
    assert.equal(stats.tested, MAX_CULLED_BATCHES);
    assert.equal(stats.visible, MAX_CULLED_BATCHES);
    assert.equal(visibleList[MAX_CULLED_BATCHES - 1], MAX_CULLED_BATCHES - 1);
    // The three batches past the cap: not in the list, and their record untouched — the renderer
    // pre-fills every slot with the batch's count, so "untested" stays "draw", never "whatever was
    // left there" (and the twin writes exactly the slots the pass writes).
    assertNotContains([...visibleList], MAX_CULLED_BATCHES);
    for (let i = stats.tested; i < boxes.length; i++) {
      assert.equal(records[i * DRAW_RECORD_WORDS + DRAW_RECORD_INSTANCES], 0xa5);
    }
    assert.equal(records[DRAW_RECORD_INSTANCES], 2);
    // The record's slot stride is the constant the renderer indexes with: 8 words, 16-aligned.
    assert.equal(DRAW_RECORD_BYTES, 32);
    assert.equal(DRAW_RECORD_BYTES % 16, 0);
    assert.equal(DRAW_RECORD_INSTANCES, 1);
  });

group("the HiZ occlusion test", () => {
  const params = (overrides: Partial<ObjectCullParams> = {}) => {
    const base = frameParams({ flags: CULL_FLAG_FRUSTUM | CULL_FLAG_OCCLUSION, ...overrides });
    return base;
  };

  test("reduces the depth image 2x2 into view-space metres, level by level", () => {
    const depth = new Float32Array([0.5, 0.5, 0.5, 0.5]);
    const levels = buildHizOnCpu(depth, 2, 2, 1, 100);
    assert.equal((levels).length, hizLevelCount(2, 2));
    const metres = (ndc: number) => (1 * 100) / (100 - ndc * (100 - 1));
    // Level 0 is the 2x2 max of the *metres*, not of the NDC values (a max of NDC is the same order
    // here, but the values are what the shader compares against view-space z).
    assertCloseTo(levels[0]!.data[0], metres(0.5), 5);
    assert.equal(levels[0]!.width, 1);
    assert.equal(levels[0]!.height, 1);
    // A pixel nothing wrote reads as NDC 1.0, which inverts to `far`: no occluder.
    assert.ok(levels[0]!.data[0]! < 100);
    const unwritten = buildHizOnCpu(new Float32Array(4).fill(1), 2, 2, 1, 100);
    assertCloseTo(unwritten[0]!.data[0], 100, 3);
    // Size chain: level k is the depth target shifted by k+1, floored at one texel.
    assert.deepEqual(hizLevelSize(1024, 768, 0), { width: 512, height: 384 });
    assert.deepEqual(hizLevelSize(1024, 768, HIZ_LEVELS - 1), { width: 64, height: 48 });
    assert.equal(hizLevelCount(1024, 768), HIZ_LEVELS);
    assert.deepEqual(hizLevelSize(1, 1, 0), { width: 1, height: 1 });
    assert.equal(hizLevelCount(2, 2), 1);
  });

  test("culls what is behind the depth and keeps what is not", () => {
    // A near wall over the left half of the screen (NDC 0.2 ≈ 1.25 m at near 1 / far 100). The
    // camera sits at z = -10 looking toward +z, so a 30 m-away box projects well inside its half.
    const depth = depthImage(64, 64, 32, 0.2);
    const hiz = buildHizOnCpu(depth, 64, 64, 1, 100);
    const p = params({ width: 64, height: 64, near: 1, far: 100, hizLevels: hiz.length });
    const boxes = [
      { c: new Vec3(-2, 0, 20), r: 0.3 }, // 30 m away, behind the wall
      { c: new Vec3(2, 0, 20), r: 0.3 }, // 30 m away, over the open half
      { c: new Vec3(-2, 0, -8.5), r: 0.2 }, // in front of the wall
      { c: new Vec3(0, 0, 20), r: 0.3 }, // straddling the wall's edge column
    ];
    const words = new Uint32Array(boxes.length);
    const stats = cullBatchesOnCpu(boundsOf(boxes), boxes.length, p, words, hiz);
    assert.equal(words[0], CullReason.Occluded, "behind the wall");
    assert.equal(words[1], CullReason.Visible, "over the open half");
    assert.equal(words[2], CullReason.Visible, "in front of the wall");
    assert.equal(words[3], CullReason.Visible, "straddling the edge");
    assert.equal(stats.culledOccluded, 1);
  });

  test("reads the depth at the pixels the batch is over, not the mirrored rows", () => {
    // NDC +y points up the screen while texel row 0 is the top of the image, so a row index taken
    // straight from the NDC y tests the mirrored half of the screen — for anything floating over
    // nearer ground, that half is filled with a *nearer* surface than the batch's own footprint, and
    // the batch is reported occluded and stops being drawn. The floor here covers the bottom half of
    // the image; the box in the top half is 30 m out, so nothing covers it.
    const depth = depthFloor(64, 64, 0.2);
    const hiz = buildHizOnCpu(depth, 64, 64, 1, 100);
    const p = params({ width: 64, height: 64, near: 1, far: 100, hizLevels: hiz.length });
    const boxes = [
      { c: new Vec3(0, 6, 20), r: 0.3 }, // high in the frame: over the empty top half
      { c: new Vec3(0, -6, 20), r: 0.3 }, // low in the frame: the near floor is in front of it
    ];
    const words = new Uint32Array(boxes.length);
    const stats = cullBatchesOnCpu(boundsOf(boxes), boxes.length, p, words, hiz);
    assert.equal(words[0], CullReason.Visible, "over the far half");
    assert.equal(words[1], CullReason.Occluded, "behind the floor");
    assert.equal(stats.culledOccluded, 1);
  });

  test("only calls a batch occluded when its whole footprint is behind the depth", () => {
    // The safety property the margins exist for: for every batch the culler occluded, every depth
    // texel its padded footprint covers must be nearer than the batch's own nearest point — so the
    // decision cannot hide a pixel that would have been in front. Sweeps a deterministic grid of
    // boxes over a wall-and-gap depth image; the footprint is recomputed here from the projection,
    // independently of the code under test.
    const depth = depthImage(64, 64, 32, 0.2);
    const level0 = buildHizOnCpu(depth, 64, 64, 1, 100)[0]!;
    const p = params({ width: 64, height: 64, near: 1, far: 100, hizLevels: buildHizOnCpu(depth, 64, 64, 1, 100).length });
    const boxes: { c: Vec3; r: number }[] = [];
    for (let i = 0; i < 120; i++) {
      const a = i * 0.7;
      boxes.push({ c: new Vec3(Math.cos(a) * 0.9, Math.sin(a * 1.3) * 0.5, 2 + (i % 40) * 1.5), r: 0.1 + (i % 5) * 0.15 });
    }
    const words = new Uint32Array(boxes.length);
    cullBatchesOnCpu(boundsOf(boxes), boxes.length, p, words, level0 ? buildHizOnCpu(depth, 64, 64, 1, 100) : []);
    assert.equal([...words].some((w) => w === CullReason.Occluded), true);
    const view = p.view;
    const proj = p.proj;
    boxes.forEach((box, i) => {
      if (words[i] !== CullReason.Occluded) return;
      // The projected footprint of the sphere's view-space box, plus the pad the culler adds.
      const vx = view[0]! * box.c.x + view[4]! * box.c.y + view[8]! * box.c.z + view[12]!;
      const vy = view[1]! * box.c.x + view[5]! * box.c.y + view[9]! * box.c.z + view[13]!;
      const vz = view[2]! * box.c.x + view[6]! * box.c.y + view[10]! * box.c.z + view[14]!;
      const radius = box.r + 0.01; // CULL_SLOP
      const nearest = vz - radius;
      let loX = Infinity;
      let loY = Infinity;
      let hiX = -Infinity;
      let hiY = -Infinity;
      for (let corner = 0; corner < 8; corner++) {
        const px = vx + ((corner & 1) !== 0 ? radius : -radius);
        const py = vy + ((corner & 2) !== 0 ? radius : -radius);
        const pz = vz + ((corner & 4) !== 0 ? radius : -radius);
        const sx = ((proj[0]! * px) / pz) * 0.5 * 64 + 0.5 * 64;
        const sy = (0.5 - ((proj[5]! * py) / pz) * 0.5) * 64; // texel row 0 is the top
        loX = Math.min(loX, sx);
        loY = Math.min(loY, sy);
        hiX = Math.max(hiX, sx);
        hiY = Math.max(hiY, sy);
      }
      if (loX - 1 < 0 || loY - 1 < 0 || hiX + 1 > 64 || hiY + 1 > 64) return; // the culler clamps; skip those
      // Level 0 holds 2x2 block maxima: every block whose pixels overlap the padded rectangle has to
      // be nearer than the batch's nearest point, or a real occluder was ignored.
      for (let ty = Math.floor((loY - 1) / 2); ty <= Math.floor((hiY + 1) / 2); ty++) {
        for (let tx = Math.floor((loX - 1) / 2); tx <= Math.floor((hiX + 1) / 2); tx++) {
          assert.ok(level0.data[ty * level0.width + tx]! < nearest - 0.001, `texel ${tx},${ty} of box ${i}`);
        }
      }
    });
  });

  test("skips the occlusion test entirely when the frame is not given a pyramid", () => {
    const depth = depthImage(64, 64, 32, 0.2);
    const hiz = buildHizOnCpu(depth, 64, 64, 1, 100);
    const p = params({ width: 64, height: 64, near: 1, far: 100, hizLevels: 0 });
    const boxes = [{ c: new Vec3(-2, 0, 20), r: 0.3 }];
    const words = new Uint32Array(1);
    const stats = cullBatchesOnCpu(boundsOf(boxes), 1, p, words, hiz);
    assert.equal(words[0], CullReason.Visible);
    assert.equal(stats.culledOccluded, 0);
  });
});

group("OBJECT_CULL_SHADER", () => {
  test("is generated from the constants and the structs the CPU writer uses", () => {
    for (const text of [
      `const CULL_WORKGROUP: u32 = ${CULL_WORKGROUP}u;`,
      `const MAX_CULLED_BATCHES: u32 = ${MAX_CULLED_BATCHES}u;`,
      `const CULL_FLAG_FRUSTUM: u32 = ${CULL_FLAG_FRUSTUM}u;`,
      `const CULL_FLAG_DISTANCE: u32 = ${CULL_FLAG_DISTANCE}u;`,
      `const CULL_FLAG_OCCLUSION: u32 = ${CULL_FLAG_OCCLUSION}u;`,
      `const CULL_FLAG_RECORDS: u32 = ${CULL_FLAG_RECORDS}u;`,
      `const RECORD_WORDS: u32 = ${DRAW_RECORD_WORDS}u;`,
      `const RECORD_INSTANCES: u32 = ${DRAW_RECORD_INSTANCES}u;`,
      `const REASON_FRUSTUM: u32 = ${CullReason.Frustum}u;`,
      "fn outsidePlane(p: vec4<f32>, center: vec3<f32>, radius: f32) -> bool {",
      "fn planeAt(row: u32) -> vec4<f32> {",
      "fn cullReasonOf(box: ObjectBatchEntry) -> u32 {",
      "@workgroup_size(CULL_WORKGROUP) @compute fn csCull(",
    ]) {
      assertContains(OBJECT_CULL_SHADER, text, text);
    }
    // The structs are embedded, not transcribed: a hand-written copy is how the two languages drift.
    assertContains(OBJECT_CULL_SHADER, ObjectCullUniforms.toWgsl("uniform"));
    assertContains(OBJECT_CULL_SHADER, ObjectBatchEntry.toWgsl("storage"));
    assertContains(OBJECT_CULL_SHADER, ObjectBatchBlock.toWgsl("storage"));
    assertContains(OBJECT_CULL_SHADER, ObjectCullStatsBlock.toWgsl("storage"));
    // One invocation per batch, one dispatch, and the word is written on every path (a verdict, not a
    // leftover): the tests agree with the twin about which batches survive, and the pass writes the
    // word, the counters, the compaction slot and the record from that single verdict.
    assert.equal((OBJECT_CULL_SHADER.match(/@compute/g) ?? []).length, 1);
    assertContains(OBJECT_CULL_SHADER, "visibility[index] = reason;");
    assertContains(OBJECT_CULL_SHADER, "let kept = reason == REASON_VISIBLE;");
    assertContains(OBJECT_CULL_SHADER, "atomicAdd(&counts.tested, 1u);");
    assertContains(OBJECT_CULL_SHADER, "let slot = atomicAdd(&counts.visible, 1u);");
    assertContains(OBJECT_CULL_SHADER, "visibleBatches[slot] = index;");
    // The record's instance count is the batch's own (the bounds' `max.w`) or zero — the two writes a
    // draw command can carry, from the same verdict that wrote the word.
    assertContains(OBJECT_CULL_SHADER, "drawRecords[word] = u32(box.max.w);");
    assertContains(OBJECT_CULL_SHADER, "drawRecords[word] = 0u;");
    assertContains(OBJECT_CULL_SHADER, "atomicAdd(&counts.recordZeroed, 1u);");
    // The pixel row is the negated NDC y (texel row 0 is the top): the mirrored rect is not a
    // one-texel error, it is a rect over the other half of the screen.
    assertContains(OBJECT_CULL_SHADER, "(0.5 - ndc.y * 0.5) * cull.extent.y");
    assert.equal((OBJECT_CULL_SHADER.match(/atomicAdd\(&counts\./g) ?? []).length, 6);
    assert.deepEqual(validateWgsl(OBJECT_CULL_SHADER), []);
    for (const shader of [HIZ_DEPTH_SHADER, HIZ_REDUCE_SHADER]) {
      assertContains(shader, `const HIZ_WORKGROUP: u32 = ${HIZ_WORKGROUP}u;`);
      assert.deepEqual(validateWgsl(shader), []);
    }
    assertContains(HIZ_DEPTH_SHADER, ObjectCullUniforms.toWgsl("uniform"));
    // A depth texture has no sampled variant: its load takes the mip level explicitly (Tint rejects
    // the two-argument form, so this is the difference between a shader and a black frame).
    assertContains(HIZ_DEPTH_SHADER, "textureLoad(depthSource, vec2<i32>(i32(p.x), i32(p.y)), 0)");
    // The reduction only needs the depth it reads and the level it writes.
    assertNotContains(HIZ_REDUCE_SHADER, "ObjectCullUniforms");
    assertContains(HIZ_REDUCE_SHADER, "textureStore(dest, vec2<i32>(i32(gid.x), i32(gid.y)), vec4<f32>(far, 0.0, 0.0, 0.0));");
    assert.equal((HIZ_DEPTH_SHADER.match(/@compute/g) ?? []).length, 1);
    assert.equal((HIZ_REDUCE_SHADER.match(/@compute/g) ?? []).length, 1);
  });
});

group("GpuObjectCuller", () => {
  async function setup(batchCount = 3) {
    const device = await GraphicsDevice.create({ forceMock: true });
    const mock = device.mock;
    const graph = new RenderGraph(device);
    const visibility = device.device.createBuffer({
      label: "cull.visibility",
      size: MAX_CULLED_BATCHES * 4,
      usage: BufferUsage.STORAGE | BufferUsage.COPY_DST,
    });
    // The frame-level products (Phase 13.6): the records the draw loop reads, and the compaction list.
    const records = device.device.createBuffer({
      label: "cull.drawRecords",
      size: batchCount * DRAW_RECORD_BYTES,
      usage: BufferUsage.STORAGE | BufferUsage.INDIRECT | BufferUsage.COPY_DST,
    });
    const visible = device.device.createBuffer({
      label: "cull.visibleBatches",
      size: MAX_CULLED_BATCHES * 4,
      usage: BufferUsage.STORAGE | BufferUsage.COPY_DST,
    });
    const culler = new GpuObjectCuller(device, new PipelineFactory(device).shaders);
    const boxes = Array.from({ length: batchCount }, (_, i) => ({ c: new Vec3(0, 0, -5 - i), r: 1, limit: i === 1 ? 2 : 0 }));
    const params = frameParams();
    const view = new Mat4(params.view as never);
    const projection = new Mat4(params.proj as never);
    const viewProj = new Mat4(params.viewProj as never);
    const prepare = (occlude: boolean, writeRecords = false) =>
      culler.prepare(boundsOf(boxes), batchCount, {
        view,
        projection,
        viewProj,
        cameraPos: { x: EYE.x, y: EYE.y, z: EYE.z },
        near: NEAR,
        far: FAR,
        width: 64,
        height: 64,
        occlude,
        records: writeRecords,
      });
    const record = (depth: RenderGraphHandle) => culler.record(graph, depth, visibility, records, visible);
    return { device, mock, graph, visibility, records, visible, culler, boxes, prepare, record };
  }

  test("writes the frame block the shader reads, and one bounds entry per batch", async () => {
    const { device, mock, visibility, records, visible, culler, prepare } = await setup(3);
    prepare(false);
    const block = [...mock.liveBuffers].find((b) => b.label === "objects.cull.uniforms")!;
    assert.notEqual(block, undefined);
    assert.equal(block.size, ObjectCullUniforms.byteSize("uniform"));
    const u32 = new Uint32Array(block.data);
    assert.equal(u32[ObjectCullUniforms.offsetOf("batchCount", "uniform") >> 2], 3);
    // Batch 1 asked for a distance limit, so the flag that says "some batch wants the test" is set.
    assert.equal(u32[ObjectCullUniforms.offsetOf("flags", "uniform") >> 2]! & CULL_FLAG_DISTANCE, CULL_FLAG_DISTANCE);
    assert.equal(u32[ObjectCullUniforms.offsetOf("flags", "uniform") >> 2]! & CULL_FLAG_OCCLUSION, 0);
    // The matrices travel verbatim: the planes the shader extracts must be the frame's own.
    const f32 = new Float32Array(block.data);
    const viewSlot = ObjectCullUniforms.offsetOf("view", "uniform") >> 2;
    for (let i = 0; i < 16; i++) assertCloseTo(f32[viewSlot + i], new Mat4(frameParams().view as never).m[i]!, 6);
    assert.equal(f32[(ObjectCullUniforms.offsetOf("extent", "uniform") >> 2) + 1], 64);
    // The bounds buffer holds the batches' boxes and their limits, in draw order (batch i's word is
    // `visibility[i]`).
    const bounds = [...mock.liveBuffers].find((b) => b.label === "objects.bounds")!;
    const boundsF32 = new Float32Array(bounds.data);
    assertCloseTo(boundsF32[0], -1, 5); // batch 0: centre (0,0,-5), r = 1
    assert.equal(boundsF32[3], 0); // no distance limit
    assert.equal(boundsF32[11], 2); // batch 1 carries its limit in the entry
    culler.dispose();
    visibility.destroy();
    records.destroy();
    visible.destroy();
    await device.dispose();
  });

  test("records one pass, one whole-workgroup dispatch, and a copy of the counters", async () => {
    const { device, mock, graph, visibility, records, visible, culler, prepare, record } = await setup(3);
    prepare(false);
    graph.begin();
    const depth = graph.createTexture("scene.depth", { width: 64, height: 64, format: "depth24plus", usage: TextureUsage.RENDER_ATTACHMENT | TextureUsage.TEXTURE_BINDING });
    record(depth);
    assert.deepEqual(graph.execute().executed, ["forge.objects.cull"]);
    assert.deepEqual(mock.errors, []);
    const dispatch = mock.commandLog.find((e) => e.type === "dispatch");
    assertMatchObject(dispatch, { label: "objects.cull", x: Math.ceil(3 / CULL_WORKGROUP), y: 1, z: 1 });
    // The counters come back through a copy in the same command buffer, never a mid-frame stall.
    const copy = mock.commandLog.find((e) => e.type === "copyB2B");
    assertMatchObject(copy, { size: CULL_STATS_BYTES });
    culler.dispose();
    visibility.destroy();
    records.destroy();
    visible.destroy();
    await device.dispose();
  });

  test("builds the pyramid and records its passes only when the frame has depth to test against", async () => {
    const { device, mock, graph, visibility, records, visible, culler, prepare, record } = await setup(2);
    prepare(true);
    graph.begin();
    const depth = graph.createTexture("scene.depth", { width: 64, height: 64, format: "depth24plus", usage: TextureUsage.RENDER_ATTACHMENT | TextureUsage.TEXTURE_BINDING });
    // The prepass, in miniature: something has to have written the depth the pyramid reduces.
    graph.addPass({
      name: "test.prepass",
      depth: { texture: depth, depthClearValue: 1 },
      execute: (ctx) => {
        const pass = ctx.beginRenderPass();
        pass.end();
      },
    });
    record(depth);
    const executed = graph.execute().executed;
    assert.deepEqual(executed, ["test.prepass", "forge.hiz.0", "forge.hiz.1", "forge.hiz.2", "forge.hiz.3", "forge.objects.cull"]);
    assert.deepEqual(mock.errors, []);
    // Level 0 is the depth target reduced 2x2, so it dispatches over half the extent; each reduction
    // halves again, and the cull pass covers the batch count.
    const dispatches = mock.commandLog.filter((e) => e.type === "dispatch");
    assert.deepEqual(dispatches.map((e) => e.x), [
      Math.ceil(32 / HIZ_WORKGROUP),
      Math.ceil(16 / HIZ_WORKGROUP),
      Math.ceil(8 / HIZ_WORKGROUP),
      Math.ceil(4 / HIZ_WORKGROUP),
      Math.ceil(2 / CULL_WORKGROUP),
    ]);
    const block = [...mock.liveBuffers].find((b) => b.label === "objects.cull.uniforms")!;
    assert.equal(new Uint32Array(block.data)[ObjectCullUniforms.offsetOf("hizLevels", "uniform") >> 2], 4);
    assert.equal(new Uint32Array(block.data)[ObjectCullUniforms.offsetOf("flags", "uniform") >> 2]! & CULL_FLAG_OCCLUSION, CULL_FLAG_OCCLUSION);
    culler.dispose();
    visibility.destroy();
    records.destroy();
    visible.destroy();
    await device.dispose();
  });

  test("stops building the pyramid on the next frame the renderer does not occlude", async () => {
    // The pyramid texture stays allocated between frames (it is the size of the target, not of the
    // frame), so the level count has to be per-frame state: a frame the renderer did not ask to
    // occlude has no prepass depth, and declaring a pass that reads it is the graph refusing the frame.
    const { device, mock, graph, visibility, records, visible, culler, prepare, record } = await setup(2);
    prepare(true);
    graph.begin();
    const first = graph.createTexture("scene.depth", { width: 64, height: 64, format: "depth24plus", usage: TextureUsage.RENDER_ATTACHMENT | TextureUsage.TEXTURE_BINDING });
    graph.addPass({ name: "test.prepass", depth: { texture: first, depthClearValue: 1 }, execute: (ctx) => void ctx.beginRenderPass().end() });
    record(first);
    assert.deepEqual(graph.execute().executed, ["test.prepass", "forge.hiz.0", "forge.hiz.1", "forge.hiz.2", "forge.hiz.3", "forge.objects.cull"]);

    prepare(false);
    graph.begin();
    const second = graph.createTexture("scene.depth", { width: 64, height: 64, format: "depth24plus", usage: TextureUsage.RENDER_ATTACHMENT | TextureUsage.TEXTURE_BINDING });
    record(second);
    const executed = graph.execute().executed;
    assert.deepEqual(executed, ["forge.objects.cull"]);
    const block = [...mock.liveBuffers].find((b) => b.label === "objects.cull.uniforms")!;
    assert.equal(new Uint32Array(block.data)[ObjectCullUniforms.offsetOf("hizLevels", "uniform") >> 2], 0);
    assert.deepEqual(mock.errors, []);
    culler.dispose();
    visibility.destroy();
    records.destroy();
    visible.destroy();
    await device.dispose();
  });

  test("reports nothing and records nothing after dispose", async () => {
    const { device, mock, graph, visibility, records, visible, culler, prepare, record } = await setup(1);
    prepare(false);
    culler.dispose();
    graph.begin();
    const depth = graph.createTexture("scene.depth", { width: 64, height: 64, format: "depth24plus", usage: TextureUsage.RENDER_ATTACHMENT | TextureUsage.TEXTURE_BINDING });
    record(depth);
    assert.deepEqual(graph.execute().executed, []);
    culler.poll();
    assert.deepEqual(culler.stats, { tested: 0, culledFrustum: 0, culledDistance: 0, culledOccluded: 0, visible: 0, recordZeroed: 0 });
    culler.dispose();
    visibility.destroy();
    records.destroy();
    visible.destroy();
    await device.dispose();
    assert.deepEqual(mock.errors, []);
  });
});

await finish();
