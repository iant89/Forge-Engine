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

import { describe, expect, it } from "vitest";
import type { RenderGraphHandle } from "@forge/engine";
import {
  BufferUsage,
  CULL_FLAG_DISTANCE,
  CULL_FLAG_FRUSTUM,
  CULL_FLAG_OCCLUSION,
  CULL_FLAG_LOD,
  CULL_FLAG_RECORDS,
  CULL_STATS_BYTES,
  CULL_WORKGROUP,
  DRAW_RECORD_BYTES,
  DRAW_RECORD_FIRST_INDEX,
  DRAW_RECORD_INDEX_COUNT,
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
  LOD_TABLE_BYTES,
  MAX_CULLED_BATCHES,
  Mat4,
  OBJECT_CULL_SHADER,
  ObjectBatchBlock,
  ObjectBatchEntry,
  ObjectCullStatsBlock,
  ObjectCullUniforms,
  ObjectLodLevel,
  ObjectLodSet,
  ObjectLodSetBlock,
  LOD_SET_NONE,
  PipelineFactory,
  RenderGraph,
  TextureUsage,
  Vec3,
  buildHizOnCpu,
  cullBatchesOnCpu,
  cullPlanesFrom,
  hizLevelCount,
  hizLevelSize,
  lodDistanceF32,
  markCertainDistanceCulls,
  selectLodLevel,
  validateWgsl,
  type ObjectCullOutputs,
  type ObjectCullParams,
  type ObjectLodSetCpu,
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

describe("cullPlanesFrom", () => {
  it("derives the same six planes as Frustum, in the same order and facing inward", () => {
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
      expect(nx / l, `plane ${i} normal x`).toBeCloseTo(frustum.planes[i * 4]!, 5);
      expect(ny / l, `plane ${i} normal y`).toBeCloseTo(frustum.planes[i * 4 + 1]!, 5);
      expect(nz / l, `plane ${i} normal z`).toBeCloseTo(frustum.planes[i * 4 + 2]!, 5);
      expect(d / l, `plane ${i} offset`).toBeCloseTo(frustum.planes[i * 4 + 3]!, 5);
    }
    // Inward-facing, both ways round: a point down the camera's axis is inside, a point behind the
    // camera is outside the near plane. This is what the OpenGL pair (z+w / w-z) gets backwards on a
    // z-in-[0,1] projection.
    expect(frustum.containsPoint(new Vec3(0, 0, -5))).toBe(true); // 5 m in front of the eye
    expect(frustum.containsPoint(new Vec3(0, 0, 5))).toBe(true); // 15 m in front
    expect(frustum.containsPoint(new Vec3(0, 0, -12))).toBe(false); // 2 m behind it
  });
});

describe("cullBatchesOnCpu", () => {
  it("culls what the frustum cannot see, and only that", () => {
    const params = frameParams();
    const boxes = [
      { c: new Vec3(0, 0, 0), r: 1 }, // dead ahead
      { c: new Vec3(0, 0, -12), r: 1 }, // behind the camera (view-space z < 0)
      { c: new Vec3(0, 400, 0), r: 1 }, // far above the frustum
      { c: new Vec3(0, 0, 200), r: 0.01 }, // past the far plane
    ];
    const words = new Uint32Array(boxes.length);
    const stats = cullBatchesOnCpu(boundsOf(boxes), boxes.length, params, words);
    expect(stats.tested).toBe(4);
    expect(words[0]).toBe(CullReason.Visible);
    expect(words[1]).toBe(CullReason.Frustum);
    expect(words[2]).toBe(CullReason.Frustum);
    expect(words[3]).toBe(CullReason.Frustum);
    expect(stats.culledFrustum).toBe(3);
    expect(stats.culledDistance).toBe(0);
    expect(stats.culledOccluded).toBe(0);
  });

  it("never culls a box with a point inside the frustum (the sweep)", () => {
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
        expect(words[i], `box ${i} at ${box.c.x},${box.c.y},${box.c.z}`).toBe(CullReason.Visible);
      }
    });
    // The sweep has to actually exercise both sides of the test, or the assertion above is vacuous.
    expect(keptWithPointInside).toBeGreaterThan(20);
    expect(words.some((w) => w === CullReason.Frustum)).toBe(true);
  });

  it("applies each batch's own distance limit, once the sphere reaches it", () => {
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
    expect([...words].map((w) => w === CullReason.Visible)).toEqual([true, true, true, false, true]);
    expect(stats.culledDistance).toBe(1);
    expect(stats.culledFrustum).toBe(0);

    // ... and a limit that is not in the frame's flags is not applied: the flag is what says "some
    // batch in this frame wants the test", and a frame with none must not spend the work.
    const words2 = new Uint32Array(boxes.length);
    cullBatchesOnCpu(boundsOf(boxes), boxes.length, { ...params, flags: CULL_FLAG_FRUSTUM }, words2);
    expect([...words2].every((w) => w === CullReason.Visible)).toBe(true);
  });

  it("leaves batches past the cap alone, and writes a word for every batch it tests", () => {
    const params = frameParams();
    const count = MAX_CULLED_BATCHES + 3;
    const boxes = Array.from({ length: count }, () => ({ c: new Vec3(0, 400, 0), r: 1 })); // all above
    const words = new Uint32Array(count); // zeroes, the way the renderer resets it
    const stats = cullBatchesOnCpu(boundsOf(boxes), count, params, words);
    expect(stats.tested).toBe(MAX_CULLED_BATCHES);
    expect(stats.culledFrustum).toBe(MAX_CULLED_BATCHES);
    // Past the cap nothing is tested, and the reset value is "draw": an untested batch is never
    // wrongly culled, it is just not eligible for the saving.
    for (let i = MAX_CULLED_BATCHES; i < count; i++) expect(words[i]).toBe(CullReason.Visible);
  });
});

  it("hands the frame the records and the compaction list the pass would write", () => {
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
    expect(stats.tested).toBe(3);
    expect(stats.culledFrustum).toBe(1);
    expect(stats.culledDistance).toBe(1);
    expect(stats.visible).toBe(1);
    expect(stats.recordZeroed).toBe(2);
    // Word 1 of each slot is the instance count the draw would run with: the batch's own, or zero for
    // a batch the tests dropped. The other words belong to the CPU (the batch's index window).
    expect(records[0 * DRAW_RECORD_WORDS + DRAW_RECORD_INSTANCES]).toBe(3);
    expect(records[1 * DRAW_RECORD_WORDS + DRAW_RECORD_INSTANCES]).toBe(0);
    expect(records[2 * DRAW_RECORD_WORDS + DRAW_RECORD_INSTANCES]).toBe(0);
    // The list holds the survivors, one slot each, in test order, and nothing past the count.
    expect([...visibleList.slice(0, stats.visible)]).toEqual([0]);
    expect(visibleList[stats.visible]).toBe(0);
    // The identity the browser gate asserts on a device: the visible count is what the three culls
    // left, and the zeroed records are exactly the batches they dropped.
    expect(stats.visible).toBe(stats.tested - stats.culledFrustum - stats.culledDistance - stats.culledOccluded);
    expect(stats.recordZeroed).toBe(stats.culledFrustum + stats.culledDistance + stats.culledOccluded);
  });

  it("leaves the records and the list alone without the records flag", () => {
    // `CULL_FLAG_RECORDS` is the caller's switch: a frame that submits direct draws has no use for a
    // record, and the twin has to write exactly what the pass writes — nothing.
    const boxes = [{ c: new Vec3(0, 0, -12), r: 1, count: 4 }];
    const records = new Uint32Array(DRAW_RECORD_WORDS).fill(0xdeadbeef);
    const visibleList = new Uint32Array(MAX_CULLED_BATCHES).fill(0xdeadbeef);
    const stats = cullBatchesOnCpu(boundsOf(boxes), 1, frameParams(), new Uint32Array(1), [], { records, visible: visibleList });
    expect(stats.culledFrustum).toBe(1);
    expect(stats.recordZeroed).toBe(0);
    expect([...records]).toEqual(new Array(DRAW_RECORD_WORDS).fill(0xdeadbeef));
    expect(visibleList[0]).toBe(0xdeadbeef);
  });

  it("keeps one slot per batch and one slot per visible batch when the cap is passed", () => {
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
    expect(stats.tested).toBe(MAX_CULLED_BATCHES);
    expect(stats.visible).toBe(MAX_CULLED_BATCHES);
    expect(visibleList[MAX_CULLED_BATCHES - 1]).toBe(MAX_CULLED_BATCHES - 1);
    // The three batches past the cap: not in the list, and their record untouched — the renderer
    // pre-fills every slot with the batch's count, so "untested" stays "draw", never "whatever was
    // left there" (and the twin writes exactly the slots the pass writes).
    expect([...visibleList]).not.toContain(MAX_CULLED_BATCHES);
    for (let i = stats.tested; i < boxes.length; i++) {
      expect(records[i * DRAW_RECORD_WORDS + DRAW_RECORD_INSTANCES]).toBe(0xa5);
    }
    expect(records[DRAW_RECORD_INSTANCES]).toBe(2);
    // The record's slot stride is the constant the renderer indexes with: 8 words, 16-aligned.
    expect(DRAW_RECORD_BYTES).toBe(32);
    expect(DRAW_RECORD_BYTES % 16).toBe(0);
    expect(DRAW_RECORD_INSTANCES).toBe(1);
  });

describe("the HiZ occlusion test", () => {
  const params = (overrides: Partial<ObjectCullParams> = {}) => {
    const base = frameParams({ flags: CULL_FLAG_FRUSTUM | CULL_FLAG_OCCLUSION, ...overrides });
    return base;
  };

  it("reduces the depth image 2x2 into view-space metres, level by level", () => {
    const depth = new Float32Array([0.5, 0.5, 0.5, 0.5]);
    const levels = buildHizOnCpu(depth, 2, 2, 1, 100);
    expect(levels).toHaveLength(hizLevelCount(2, 2));
    const metres = (ndc: number) => (1 * 100) / (100 - ndc * (100 - 1));
    // Level 0 is the 2x2 max of the *metres*, not of the NDC values (a max of NDC is the same order
    // here, but the values are what the shader compares against view-space z).
    expect(levels[0]!.data[0]).toBeCloseTo(metres(0.5), 5);
    expect(levels[0]!.width).toBe(1);
    expect(levels[0]!.height).toBe(1);
    // A pixel nothing wrote reads as NDC 1.0, which inverts to `far`: no occluder.
    expect(levels[0]!.data[0]!).toBeLessThan(100);
    const unwritten = buildHizOnCpu(new Float32Array(4).fill(1), 2, 2, 1, 100);
    expect(unwritten[0]!.data[0]).toBeCloseTo(100, 3);
    // Size chain: level k is the depth target shifted by k+1, floored at one texel.
    expect(hizLevelSize(1024, 768, 0)).toEqual({ width: 512, height: 384 });
    expect(hizLevelSize(1024, 768, HIZ_LEVELS - 1)).toEqual({ width: 64, height: 48 });
    expect(hizLevelCount(1024, 768)).toBe(HIZ_LEVELS);
    expect(hizLevelSize(1, 1, 0)).toEqual({ width: 1, height: 1 });
    expect(hizLevelCount(2, 2)).toBe(1);
  });

  it("culls what is behind the depth and keeps what is not", () => {
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
    expect(words[0], "behind the wall").toBe(CullReason.Occluded);
    expect(words[1], "over the open half").toBe(CullReason.Visible);
    expect(words[2], "in front of the wall").toBe(CullReason.Visible);
    expect(words[3], "straddling the edge").toBe(CullReason.Visible);
    expect(stats.culledOccluded).toBe(1);
  });

  it("reads the depth at the pixels the batch is over, not the mirrored rows", () => {
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
    expect(words[0], "over the far half").toBe(CullReason.Visible);
    expect(words[1], "behind the floor").toBe(CullReason.Occluded);
    expect(stats.culledOccluded).toBe(1);
  });

  it("only calls a batch occluded when its whole footprint is behind the depth", () => {
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
    expect([...words].some((w) => w === CullReason.Occluded)).toBe(true);
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
          expect(level0.data[ty * level0.width + tx]!, `texel ${tx},${ty} of box ${i}`).toBeLessThan(nearest - 0.001);
        }
      }
    });
  });

  it("skips the occlusion test entirely when the frame is not given a pyramid", () => {
    const depth = depthImage(64, 64, 32, 0.2);
    const hiz = buildHizOnCpu(depth, 64, 64, 1, 100);
    const p = params({ width: 64, height: 64, near: 1, far: 100, hizLevels: 0 });
    const boxes = [{ c: new Vec3(-2, 0, 20), r: 0.3 }];
    const words = new Uint32Array(1);
    const stats = cullBatchesOnCpu(boundsOf(boxes), 1, p, words, hiz);
    expect(words[0]).toBe(CullReason.Visible);
    expect(stats.culledOccluded).toBe(0);
  });
});

describe("OBJECT_CULL_SHADER", () => {
  it("is generated from the constants and the structs the CPU writer uses", () => {
    for (const text of [
      `const CULL_WORKGROUP: u32 = ${CULL_WORKGROUP}u;`,
      `const MAX_CULLED_BATCHES: u32 = ${MAX_CULLED_BATCHES}u;`,
      `const CULL_FLAG_FRUSTUM: u32 = ${CULL_FLAG_FRUSTUM}u;`,
      `const CULL_FLAG_DISTANCE: u32 = ${CULL_FLAG_DISTANCE}u;`,
      `const CULL_FLAG_OCCLUSION: u32 = ${CULL_FLAG_OCCLUSION}u;`,
      `const CULL_FLAG_RECORDS: u32 = ${CULL_FLAG_RECORDS}u;`,
      `const CULL_FLAG_LOD: u32 = ${CULL_FLAG_LOD}u;`,
      `const RECORD_WORDS: u32 = ${DRAW_RECORD_WORDS}u;`,
      `const RECORD_INSTANCES: u32 = ${DRAW_RECORD_INSTANCES}u;`,
      `const RECORD_INDEX_COUNT: u32 = ${DRAW_RECORD_INDEX_COUNT}u;`,
      `const RECORD_FIRST_INDEX: u32 = ${DRAW_RECORD_FIRST_INDEX}u;`,
      `const REASON_FRUSTUM: u32 = ${CullReason.Frustum}u;`,
      "fn outsidePlane(p: vec4<f32>, center: vec3<f32>, radius: f32) -> bool {",
      "fn planeAt(row: u32) -> vec4<f32> {",
      // `chain`, never `set`: WGSL reserves the word, Dawn refuses the shader, and the host mock —
      // which does not parse WGSL — would happily have drawn it. tools/wgsl-check.mjs now flags it.
      "fn selectLod(chain: ObjectLodSet, d: f32) -> u32 {",
      // The distance is the batch's *own* sphere centre and radius (the box is centre+extent, and the
      // LOD test must see the same number the frustum test does, or a batch can be drawn at a level
      // the CPU mirror did not pick).
      "fn cullReasonOf(box: ObjectBatchEntry, center: vec3<f32>, radius: f32) -> u32 {",
      "let level = selectLod(chain, distance(center, cull.cameraPos));",
      "@group(0) @binding(7) var<storage, read> batchLods: array<u32>;",
      "@group(0) @binding(8) var<storage, read> lodSets: ObjectLodSetBlock;",
      "@workgroup_size(CULL_WORKGROUP) @compute fn csCull(",
    ]) {
      expect(OBJECT_CULL_SHADER, text).toContain(text);
    }
    // The structs are embedded, not transcribed: a hand-written copy is how the two languages drift.
    expect(OBJECT_CULL_SHADER).toContain(ObjectCullUniforms.toWgsl("uniform"));
    expect(OBJECT_CULL_SHADER).toContain(ObjectBatchEntry.toWgsl("storage"));
    expect(OBJECT_CULL_SHADER).toContain(ObjectBatchBlock.toWgsl("storage"));
    expect(OBJECT_CULL_SHADER).toContain(ObjectCullStatsBlock.toWgsl("storage"));
    // The LOD table is embedded too, and its size is what the host buffer is allocated from: a
    // struct the device and the CPU disagree about is a table of distances read as indices.
    expect(OBJECT_CULL_SHADER).toContain(ObjectLodLevel.toWgsl("storage"));
    expect(OBJECT_CULL_SHADER).toContain(ObjectLodSet.toWgsl("storage"));
    expect(OBJECT_CULL_SHADER).toContain(ObjectLodSetBlock.toWgsl("storage"));
    // One invocation per batch, one dispatch, and the word is written on every path (a verdict, not a
    // leftover): the tests agree with the twin about which batches survive, and the pass writes the
    // word, the counters, the compaction slot and the record from that single verdict.
    expect(OBJECT_CULL_SHADER.match(/@compute/g)).toHaveLength(1);
    expect(OBJECT_CULL_SHADER).toContain("visibility[index] = reason;");
    expect(OBJECT_CULL_SHADER).toContain("let kept = reason == REASON_VISIBLE;");
    expect(OBJECT_CULL_SHADER).toContain("atomicAdd(&counts.tested, 1u);");
    expect(OBJECT_CULL_SHADER).toContain("let slot = atomicAdd(&counts.visible, 1u);");
    expect(OBJECT_CULL_SHADER).toContain("visibleBatches[slot] = index;");
    // The record's instance count is the batch's own (the bounds' `max.w`) or zero — the two writes a
    // draw command can carry, from the same verdict that wrote the word.
    expect(OBJECT_CULL_SHADER).toContain("drawRecords[word + RECORD_INSTANCES] = u32(box.max.w);");
    expect(OBJECT_CULL_SHADER).toContain("drawRecords[word + RECORD_INSTANCES] = 0u;");
    expect(OBJECT_CULL_SHADER).toContain("atomicAdd(&counts.recordZeroed, 1u);");
    // Phase 14.4: the level is two more words of the same record, written only for a kept batch whose
    // set id is inside the live table. A culled batch never reaches them (its count is already 0), and
    // an unregistered chain leaves the window the CPU uploaded — level 0, the finest.
    expect(OBJECT_CULL_SHADER).toContain("if ((cull.flags & CULL_FLAG_LOD) != 0u) {");
    expect(OBJECT_CULL_SHADER).toContain("let setId = batchLods[index];");
    expect(OBJECT_CULL_SHADER).toContain("if (setId < cull.lodSetCount) {");
    expect(OBJECT_CULL_SHADER).toContain("drawRecords[word + RECORD_INDEX_COUNT] = chain.lods[level].indexCount;");
    expect(OBJECT_CULL_SHADER).toContain("drawRecords[word + RECORD_FIRST_INDEX] = chain.lods[level].firstIndex;");
    expect(OBJECT_CULL_SHADER).toContain("atomicAdd(&counts.lodReduced, 1u);");
    // The counter block grew with the seventh atomic; a host that allocated the old 24 bytes would
    // write `lodReduced` past the end of its own buffer.
    // The pass's buffer is the *storage* size (a uniform-sized copy would round to 32 and leave four
    // dead bytes between the counters and whatever follows).
    expect(ObjectCullStatsBlock.byteSize("storage")).toBe(CULL_STATS_BYTES);
    expect(CULL_STATS_BYTES).toBe(28);
    // The pixel row is the negated NDC y (texel row 0 is the top): the mirrored rect is not a
    // one-texel error, it is a rect over the other half of the screen.
    expect(OBJECT_CULL_SHADER).toContain("(0.5 - ndc.y * 0.5) * cull.extent.y");
    expect(OBJECT_CULL_SHADER.match(/atomicAdd\(&counts\./g)).toHaveLength(7);
    expect(validateWgsl(OBJECT_CULL_SHADER)).toEqual([]);
    for (const shader of [HIZ_DEPTH_SHADER, HIZ_REDUCE_SHADER]) {
      expect(shader).toContain(`const HIZ_WORKGROUP: u32 = ${HIZ_WORKGROUP}u;`);
      expect(validateWgsl(shader)).toEqual([]);
    }
    expect(HIZ_DEPTH_SHADER).toContain(ObjectCullUniforms.toWgsl("uniform"));
    // A depth texture has no sampled variant: its load takes the mip level explicitly (Tint rejects
    // the two-argument form, so this is the difference between a shader and a black frame).
    expect(HIZ_DEPTH_SHADER).toContain("textureLoad(depthSource, vec2<i32>(i32(p.x), i32(p.y)), 0)");
    // The reduction only needs the depth it reads and the level it writes.
    expect(HIZ_REDUCE_SHADER).not.toContain("ObjectCullUniforms");
    expect(HIZ_REDUCE_SHADER).toContain("textureStore(dest, vec2<i32>(i32(gid.x), i32(gid.y)), vec4<f32>(far, 0.0, 0.0, 0.0));");
    expect(HIZ_DEPTH_SHADER.match(/@compute/g)).toHaveLength(1);
    expect(HIZ_REDUCE_SHADER.match(/@compute/g)).toHaveLength(1);
  });
});

/** A culler, its three frame-level buffers and a mock device, wired but not yet recorded. */
async function cullerSetup(batchCount = 3) {
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

describe("GpuObjectCuller", () => {


  it("writes the frame block the shader reads, and one bounds entry per batch", async () => {
    const { device, mock, visibility, records, visible, culler, prepare } = await cullerSetup(3);
    prepare(false);
    const block = [...mock.liveBuffers].find((b) => b.label === "objects.cull.uniforms")!;
    expect(block).toBeDefined();
    expect(block.size).toBe(ObjectCullUniforms.byteSize("uniform"));
    const u32 = new Uint32Array(block.data);
    expect(u32[ObjectCullUniforms.offsetOf("batchCount", "uniform") >> 2]).toBe(3);
    // Batch 1 asked for a distance limit, so the flag that says "some batch wants the test" is set.
    expect(u32[ObjectCullUniforms.offsetOf("flags", "uniform") >> 2]! & CULL_FLAG_DISTANCE).toBe(CULL_FLAG_DISTANCE);
    expect(u32[ObjectCullUniforms.offsetOf("flags", "uniform") >> 2]! & CULL_FLAG_OCCLUSION).toBe(0);
    // The matrices travel verbatim: the planes the shader extracts must be the frame's own.
    const f32 = new Float32Array(block.data);
    const viewSlot = ObjectCullUniforms.offsetOf("view", "uniform") >> 2;
    for (let i = 0; i < 16; i++) expect(f32[viewSlot + i]).toBeCloseTo(new Mat4(frameParams().view as never).m[i]!, 6);
    expect(f32[(ObjectCullUniforms.offsetOf("extent", "uniform") >> 2) + 1]).toBe(64);
    // The bounds buffer holds the batches' boxes and their limits, in draw order (batch i's word is
    // `visibility[i]`).
    const bounds = [...mock.liveBuffers].find((b) => b.label === "objects.bounds")!;
    const boundsF32 = new Float32Array(bounds.data);
    expect(boundsF32[0]).toBeCloseTo(-1, 5); // batch 0: centre (0,0,-5), r = 1
    expect(boundsF32[3]).toBe(0); // no distance limit
    expect(boundsF32[11]).toBe(2); // batch 1 carries its limit in the entry
    culler.dispose();
    visibility.destroy();
    records.destroy();
    visible.destroy();
    await device.dispose();
  });

  it("records one pass, one whole-workgroup dispatch, and a copy of the counters", async () => {
    const { device, mock, graph, visibility, records, visible, culler, prepare, record } = await cullerSetup(3);
    prepare(false);
    graph.begin();
    const depth = graph.createTexture("scene.depth", { width: 64, height: 64, format: "depth24plus", usage: TextureUsage.RENDER_ATTACHMENT | TextureUsage.TEXTURE_BINDING });
    record(depth);
    expect(graph.execute().executed).toEqual(["forge.objects.cull"]);
    expect(mock.errors).toEqual([]);
    const dispatch = mock.commandLog.find((e) => e.type === "dispatch");
    expect(dispatch).toMatchObject({ label: "objects.cull", x: Math.ceil(3 / CULL_WORKGROUP), y: 1, z: 1 });
    // The counters come back through a copy in the same command buffer, never a mid-frame stall.
    const copy = mock.commandLog.find((e) => e.type === "copyB2B");
    expect(copy).toMatchObject({ size: CULL_STATS_BYTES });
    culler.dispose();
    visibility.destroy();
    records.destroy();
    visible.destroy();
    await device.dispose();
  });

  it("builds the pyramid and records its passes only when the frame has depth to test against", async () => {
    const { device, mock, graph, visibility, records, visible, culler, prepare, record } = await cullerSetup(2);
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
    expect(executed).toEqual(["test.prepass", "forge.hiz.0", "forge.hiz.1", "forge.hiz.2", "forge.hiz.3", "forge.objects.cull"]);
    expect(mock.errors).toEqual([]);
    // Level 0 is the depth target reduced 2x2, so it dispatches over half the extent; each reduction
    // halves again, and the cull pass covers the batch count.
    const dispatches = mock.commandLog.filter((e) => e.type === "dispatch");
    expect(dispatches.map((e) => e.x)).toEqual([
      Math.ceil(32 / HIZ_WORKGROUP),
      Math.ceil(16 / HIZ_WORKGROUP),
      Math.ceil(8 / HIZ_WORKGROUP),
      Math.ceil(4 / HIZ_WORKGROUP),
      Math.ceil(2 / CULL_WORKGROUP),
    ]);
    const block = [...mock.liveBuffers].find((b) => b.label === "objects.cull.uniforms")!;
    expect(new Uint32Array(block.data)[ObjectCullUniforms.offsetOf("hizLevels", "uniform") >> 2]).toBe(4);
    expect(new Uint32Array(block.data)[ObjectCullUniforms.offsetOf("flags", "uniform") >> 2]! & CULL_FLAG_OCCLUSION).toBe(CULL_FLAG_OCCLUSION);
    culler.dispose();
    visibility.destroy();
    records.destroy();
    visible.destroy();
    await device.dispose();
  });

  it("stops building the pyramid on the next frame the renderer does not occlude", async () => {
    // The pyramid texture stays allocated between frames (it is the size of the target, not of the
    // frame), so the level count has to be per-frame state: a frame the renderer did not ask to
    // occlude has no prepass depth, and declaring a pass that reads it is the graph refusing the frame.
    const { device, mock, graph, visibility, records, visible, culler, prepare, record } = await cullerSetup(2);
    prepare(true);
    graph.begin();
    const first = graph.createTexture("scene.depth", { width: 64, height: 64, format: "depth24plus", usage: TextureUsage.RENDER_ATTACHMENT | TextureUsage.TEXTURE_BINDING });
    graph.addPass({ name: "test.prepass", depth: { texture: first, depthClearValue: 1 }, execute: (ctx) => void ctx.beginRenderPass().end() });
    record(first);
    expect(graph.execute().executed).toEqual(["test.prepass", "forge.hiz.0", "forge.hiz.1", "forge.hiz.2", "forge.hiz.3", "forge.objects.cull"]);

    prepare(false);
    graph.begin();
    const second = graph.createTexture("scene.depth", { width: 64, height: 64, format: "depth24plus", usage: TextureUsage.RENDER_ATTACHMENT | TextureUsage.TEXTURE_BINDING });
    record(second);
    const executed = graph.execute().executed;
    expect(executed).toEqual(["forge.objects.cull"]);
    const block = [...mock.liveBuffers].find((b) => b.label === "objects.cull.uniforms")!;
    expect(new Uint32Array(block.data)[ObjectCullUniforms.offsetOf("hizLevels", "uniform") >> 2]).toBe(0);
    expect(mock.errors).toEqual([]);
    culler.dispose();
    visibility.destroy();
    records.destroy();
    visible.destroy();
    await device.dispose();
  });

  it("reports nothing and records nothing after dispose", async () => {
    const { device, mock, graph, visibility, records, visible, culler, prepare, record } = await cullerSetup(1);
    prepare(false);
    culler.dispose();
    graph.begin();
    const depth = graph.createTexture("scene.depth", { width: 64, height: 64, format: "depth24plus", usage: TextureUsage.RENDER_ATTACHMENT | TextureUsage.TEXTURE_BINDING });
    record(depth);
    expect(graph.execute().executed).toEqual([]);
    culler.poll();
    expect(culler.stats).toEqual({ tested: 0, culledFrustum: 0, culledDistance: 0, culledOccluded: 0, visible: 0, recordZeroed: 0, lodReduced: 0 });
    culler.dispose();
    visibility.destroy();
    records.destroy();
    visible.destroy();
    await device.dispose();
    expect(mock.errors).toEqual([]);
  });
});

/**
 * Phase 14.4 — device-selected object LOD.
 *
 * The claim is that the *level* is decided where the visibility verdict is decided: one invocation per
 * batch, from the batch's own distance, writing two more words of the indirect record the draw already
 * reads. What could go wrong, and what these cases pin:
 *
 *  - the selection rule itself (the last level whose threshold the distance reached, never out of
 *    range, and the same rule in WGSL and in the CPU twin — `selectLodLevel` is the twin's);
 *  - a batch with no chain, or a set index past the live table, keeping the window the CPU uploaded
 *    (level 0: untested is never wrongly reduced);
 *  - a culled batch never getting a window (its instance count is already 0, and writing a level for
 *    it would be a decision about a draw that does not happen);
 *  - the table's bytes: one set index per batch per frame, the table itself rewritten only when its
 *    revision moves, and the counters' seventh word read back from the offset the struct says.
 */
describe("Object LOD selection (14.4)", () => {
  /** A rock's chain: 480 → 120 → 30 indices, switching at 40 m and 120 m. */
  const CHAIN: ObjectLodSetCpu = {
    levels: [
      { firstIndex: 0, indexCount: 480, minDistance: 0 },
      { firstIndex: 480, indexCount: 120, minDistance: 40 },
      { firstIndex: 600, indexCount: 30, minDistance: 120 },
    ],
  };

  /** A records array pre-filled the way the renderer fills it: every chained batch at level 0. */
  function levelZeroRecords(batches: number): Uint32Array {
    const records = new Uint32Array(batches * DRAW_RECORD_WORDS);
    for (let i = 0; i < batches; i++) {
      const word = i * DRAW_RECORD_WORDS;
      records[word + DRAW_RECORD_INDEX_COUNT] = CHAIN.levels[0]!.indexCount;
      records[word + DRAW_RECORD_FIRST_INDEX] = CHAIN.levels[0]!.firstIndex;
      records[word + DRAW_RECORD_INSTANCES] = 1;
    }
    return records;
  }

  it("selects the last level whose threshold the distance has reached", () => {
    expect(selectLodLevel(CHAIN.levels, 0)).toBe(0);
    expect(selectLodLevel(CHAIN.levels, 39.999)).toBe(0);
    // The threshold itself takes the coarser level: `>=`, matching the WGSL, so the two arms cannot
    // disagree about a batch sitting exactly on the boundary.
    expect(selectLodLevel(CHAIN.levels, 40)).toBe(1);
    expect(selectLodLevel(CHAIN.levels, 119.5)).toBe(1);
    expect(selectLodLevel(CHAIN.levels, 120)).toBe(2);
    expect(selectLodLevel(CHAIN.levels, 1e6)).toBe(2);
  });

  it("measures the level distance the way the device does, so a batch on a threshold cannot disagree", () => {
    // 800 m is a level threshold and 799.99997 m is inside one f32 ulp of it (ulp(800) = 6.1e-5 m),
    // so the f64 distance says "nearer" while the device's f32 distance says "reached". The host
    // paths have to say what the device says: `forge.main` reads the record the pass wrote while the
    // prepass and the shadow maps read the mirror, and a coarser main-pass surface under a finer
    // prepass depth is rejected by `depthCompare: "less-equal"` — holes, not a cosmetic drift.
    const chain = {
      levels: [
        { minDistance: 0, firstIndex: 0, indexCount: 96 },
        { minDistance: 800, firstIndex: 96, indexCount: 24 },
      ],
    };
    const f64 = Math.hypot(799.99997, 0, 0);
    expect(f64 < 800).toBe(true);
    expect(selectLodLevel(chain.levels, f64)).toBe(0);
    const device = lodDistanceF32(0, 0, 0, 0, 0, 0, 799.99997, 0, 0);
    expect(device).toBe(800);
    expect(selectLodLevel(chain.levels, device)).toBe(1);

    // The centre is the bounds entry's, halved in f32 like the WGSL does, and where f32 is exact the
    // emulation is just the distance.
    expect(lodDistanceF32(-1, -2, -3, 1, 2, 3, 3, 0, 4)).toBe(5);
    expect(lodDistanceF32(0, 0, 0, 2, 0, 0, 1, 0, 0)).toBe(0);
    // A batch far from every threshold is unaffected: the rounding only matters at the boundary.
    expect(selectLodLevel(CHAIN.levels, lodDistanceF32(0, 0, 0, 0, 0, 0, 500, 0, 0))).toBe(selectLodLevel(CHAIN.levels, 500));
    // A single-level chain, an empty one, and a batch behind the eye: level 0, never out of range.
    expect(selectLodLevel([{ minDistance: 0 }], 500)).toBe(0);
    expect(selectLodLevel([], 500)).toBe(0);
    expect(selectLodLevel(CHAIN.levels, -5)).toBe(0);
  });

  it("writes the selected level's window into the record the draw reads", () => {
    // Three batches on the view axis, 5 m / 45 m / 135 m from the eye at z = -10 (which looks
    // towards +Z): one per level of the chain.
    const boxes = [
      { c: new Vec3(0, 0, -5), r: 0.5, count: 3 },
      { c: new Vec3(0, 0, 35), r: 0.5, count: 3 },
      { c: new Vec3(0, 0, 125), r: 0.5, count: 3 },
    ];
    const records = levelZeroRecords(3);
    const params = frameParams({
      flags: CULL_FLAG_FRUSTUM | CULL_FLAG_DISTANCE | CULL_FLAG_RECORDS | CULL_FLAG_LOD,
      lods: { sets: [CHAIN], batchSets: new Uint32Array([0, 0, 0]) },
    });
    const stats = cullBatchesOnCpu(boundsOf(boxes), 3, params, new Uint32Array(3), [], { records });
    expect(stats.visible).toBe(3);
    // Two of the three drew a coarser level than the CPU's default: that is the frame's LOD saving,
    // and it is counted so a scene can report it (and so a table nobody reduces is visible as such).
    expect(stats.lodReduced).toBe(2);
    expect(records[DRAW_RECORD_INDEX_COUNT]).toBe(480);
    expect(records[DRAW_RECORD_FIRST_INDEX]).toBe(0);
    expect(records[DRAW_RECORD_WORDS + DRAW_RECORD_INDEX_COUNT]).toBe(120);
    expect(records[DRAW_RECORD_WORDS + DRAW_RECORD_FIRST_INDEX]).toBe(480);
    expect(records[2 * DRAW_RECORD_WORDS + DRAW_RECORD_INDEX_COUNT]).toBe(30);
    expect(records[2 * DRAW_RECORD_WORDS + DRAW_RECORD_FIRST_INDEX]).toBe(600);
    // The instance count is untouched by the level: a draw's instance and index windows are separate.
    expect(records[DRAW_RECORD_WORDS + DRAW_RECORD_INSTANCES]).toBe(3);
  });

  it("keeps the uploaded window for a batch with no chain, or a set index past the table", () => {
    const boxes = [
      { c: new Vec3(0, 0, 125), r: 0.5, count: 2 },
      { c: new Vec3(0, 0, 125), r: 0.5, count: 2 },
    ];
    const records = levelZeroRecords(2);
    const params = frameParams({
      flags: CULL_FLAG_FRUSTUM | CULL_FLAG_DISTANCE | CULL_FLAG_RECORDS | CULL_FLAG_LOD,
      // LOD_SET_NONE is "this geometry has no chain"; 7 is a set index the table does not hold (a
      // chain that arrived past MAX_LOD_SETS). Both must draw the finest level rather than read a
      // neighbouring set's windows — the device guards with `setId < cull.lodSetCount`, this mirrors it.
      lods: { sets: [CHAIN], batchSets: new Uint32Array([LOD_SET_NONE, 7]) },
    });
    const stats = cullBatchesOnCpu(boundsOf(boxes), 2, params, new Uint32Array(2), [], { records });
    expect(stats.visible).toBe(2);
    expect(stats.lodReduced).toBe(0);
    for (const i of [0, 1]) {
      expect(records[i * DRAW_RECORD_WORDS + DRAW_RECORD_INDEX_COUNT]).toBe(480);
      expect(records[i * DRAW_RECORD_WORDS + DRAW_RECORD_FIRST_INDEX]).toBe(0);
    }
  });

  it("ignores a table the frame did not ask for", () => {
    // No CULL_FLAG_LOD: the twin must not read `params.lods` at all, so a stale table from a previous
    // frame cannot change this frame's windows.
    const boxes = [{ c: new Vec3(0, 0, 125), r: 0.5, count: 2 }];
    const records = levelZeroRecords(1);
    const params = frameParams({
      flags: CULL_FLAG_FRUSTUM | CULL_FLAG_DISTANCE | CULL_FLAG_RECORDS,
      lods: { sets: [CHAIN], batchSets: new Uint32Array([0]) },
    });
    const stats = cullBatchesOnCpu(boundsOf(boxes), 1, params, new Uint32Array(1), [], { records });
    expect(stats.visible).toBe(1);
    expect(stats.lodReduced).toBe(0);
    expect(records[DRAW_RECORD_INDEX_COUNT]).toBe(480);
  });

  it("leaves a culled batch's window alone and zeroes only its instance count", () => {
    // Behind the eye (which sits at z = -10 and looks towards +Z), so the frustum test drops it. The pass writes the level only in the kept branch:
    // a culled draw runs no invocation, and a window written for it would be a decision about nothing.
    const boxes = [{ c: new Vec3(0, 0, -20), r: 0.5, count: 4 }];
    const records = levelZeroRecords(1);
    const params = frameParams({
      flags: CULL_FLAG_FRUSTUM | CULL_FLAG_DISTANCE | CULL_FLAG_RECORDS | CULL_FLAG_LOD,
      lods: { sets: [CHAIN], batchSets: new Uint32Array([0]) },
    });
    const stats = cullBatchesOnCpu(boundsOf(boxes), 1, params, new Uint32Array(1), [], { records });
    expect(stats.culledFrustum).toBe(1);
    expect(stats.visible).toBe(0);
    expect(stats.recordZeroed).toBe(1);
    expect(stats.lodReduced).toBe(0);
    expect(records[DRAW_RECORD_INSTANCES]).toBe(0);
    expect(records[DRAW_RECORD_INDEX_COUNT]).toBe(480);
    expect(records[DRAW_RECORD_FIRST_INDEX]).toBe(0);
  });

  it("stages one set index per batch and rewrites the table only when its revision moves", async () => {
    const { device, mock, visibility, records, visible, culler, boxes } = await cullerSetup(3);
    const frame = (revision: number, batchSets: Uint32Array) => {
      const p = frameParams();
      culler.prepare(boundsOf(boxes), 3, {
        view: new Mat4(p.view as never),
        projection: new Mat4(p.proj as never),
        viewProj: new Mat4(p.viewProj as never),
        cameraPos: { x: EYE.x, y: EYE.y, z: EYE.z },
        near: NEAR,
        far: FAR,
        width: 64,
        height: 64,
        occlude: false,
        records: true,
        lods: { batchSets, sets: [CHAIN], revision },
      });
    };
    const tableWrites = () => mock.commandLog.filter((e) => e.type === "writeBuffer" && e["buffer"] === "objects.lodSets").length;
    const indexWrites = () => mock.commandLog.filter((e) => e.type === "writeBuffer" && e["buffer"] === "objects.batchLods").length;

    frame(1, new Uint32Array([0, LOD_SET_NONE, 0]));
    expect(mock.errors).toEqual([]);
    // The per-frame cost of device LOD: one u32 per batch, and the flag that tells the pass to read it.
    const batchLods = [...mock.liveBuffers].find((b) => b.label === "objects.batchLods")!;
    expect(batchLods).toBeDefined();
    expect(new Uint32Array(batchLods.data, 0, 3)).toEqual(new Uint32Array([0, LOD_SET_NONE, 0]));
    const block = [...mock.liveBuffers].find((b) => b.label === "objects.cull.uniforms")!;
    const uniforms = new Uint32Array(block.data);
    expect(uniforms[ObjectCullUniforms.offsetOf("flags", "uniform") >> 2]! & CULL_FLAG_LOD).toBe(CULL_FLAG_LOD);
    expect(uniforms[ObjectCullUniforms.offsetOf("lodSetCount", "uniform") >> 2]).toBe(1);

    // The table's bytes, read at the offsets the generated layout reports: this is the check that
    // would catch a host writing a distance into an index word.
    const table = [...mock.liveBuffers].find((b) => b.label === "objects.lodSets")!;
    expect(table.size).toBe(LOD_TABLE_BYTES);
    const words = new Uint32Array(table.data);
    const floats = new Float32Array(table.data);
    expect(words[ObjectLodSetBlock.offsetOf("count", "storage") >> 2]).toBe(1);
    const setStride = ObjectLodSet.size("storage");
    const levelStride = ObjectLodLevel.size("storage");
    const setsAt = ObjectLodSetBlock.field("sets", "storage").offset;
    const lodsAt = ObjectLodSet.field("lods", "storage").offset;
    expect(words[(setsAt + ObjectLodSet.field("levels", "storage").offset) >> 2]).toBe(3);
    for (let i = 0; i < 3; i++) {
      const at = setsAt + lodsAt + i * levelStride;
      expect(words[(at + ObjectLodLevel.field("firstIndex", "storage").offset) >> 2]).toBe(CHAIN.levels[i]!.firstIndex);
      expect(words[(at + ObjectLodLevel.field("indexCount", "storage").offset) >> 2]).toBe(CHAIN.levels[i]!.indexCount);
      expect(floats[(at + ObjectLodLevel.field("minDistance", "storage").offset) >> 2]).toBeCloseTo(CHAIN.levels[i]!.minDistance, 6);
    }
    // Set 1 is not live: its slot stays zeroed rather than holding the previous frame's chain.
    expect(words[(setsAt + setStride + ObjectLodSet.field("levels", "storage").offset) >> 2]).toBe(0);
    expect(tableWrites()).toBe(1);
    expect(indexWrites()).toBe(1);

    // A steady frame: the indices go up again (they are per-frame), the table does not (it is static).
    frame(1, new Uint32Array([0, 0, 0]));
    expect(tableWrites()).toBe(1);
    expect(indexWrites()).toBe(2);
    expect(new Uint32Array(batchLods.data, 0, 3)).toEqual(new Uint32Array([0, 0, 0]));

    // A new chained geometry arrived: the revision moved, so the table is rewritten once.
    frame(2, new Uint32Array([0, 1, 0]));
    expect(tableWrites()).toBe(2);
    expect(uniforms[ObjectCullUniforms.offsetOf("lodSetCount", "uniform") >> 2]).toBe(1);
    culler.dispose();
    visibility.destroy();
    records.destroy();
    visible.destroy();
    await device.dispose();
    expect(mock.outstanding.buffers).toEqual([]);
  });

  it("does not set the LOD flag or allocate a table for a frame with no chains", async () => {
    const { device, mock, visibility, records, visible, culler, prepare } = await cullerSetup(2);
    prepare(false, true);
    const block = [...mock.liveBuffers].find((b) => b.label === "objects.cull.uniforms")!;
    expect(new Uint32Array(block.data)[ObjectCullUniforms.offsetOf("flags", "uniform") >> 2]! & CULL_FLAG_LOD).toBe(0);
    expect(new Uint32Array(block.data)[ObjectCullUniforms.offsetOf("lodSetCount", "uniform") >> 2]).toBe(0);
    // No table, no per-batch indices: a scene without LOD chains pays nothing for the feature, and
    // the pass still binds something at 7/8 (a zeroed fallback) so the bind group layout holds.
    expect([...mock.liveBuffers].some((b) => b.label === "objects.lodSets")).toBe(false);
    expect([...mock.liveBuffers].some((b) => b.label === "objects.batchLods")).toBe(false);
    culler.dispose();
    visibility.destroy();
    records.destroy();
    visible.destroy();
    await device.dispose();
    expect(mock.outstanding.buffers).toEqual([]);
  });

  it("reads the seventh counter back from the offset the struct reports", async () => {
    // The mock executes no WGSL, so the counters are written by hand here: what this pins is the
    // read-back, i.e. that `lodReduced` is word 6 of a 28-byte block and `consume` looks there. A
    // struct that grew a word without the host following would report another counter's value.
    const { device, mock, graph, visibility, records, visible, culler, prepare, record } = await cullerSetup(2);
    prepare(false, true);
    const stats = [...mock.liveBuffers].find((b) => b.label === "objects.cull.stats")!;
    expect(stats.size).toBe(CULL_STATS_BYTES);
    const words = new Uint32Array(stats.data);
    words.fill(0);
    words[ObjectCullStatsBlock.offsetOf("tested", "storage") >> 2] = 2;
    words[ObjectCullStatsBlock.offsetOf("visible", "storage") >> 2] = 2;
    words[ObjectCullStatsBlock.offsetOf("lodReduced", "storage") >> 2] = 1;
    expect(ObjectCullStatsBlock.offsetOf("lodReduced", "storage")).toBe(24);
    graph.begin();
    const depth = graph.createTexture("scene.depth", { width: 64, height: 64, format: "depth24plus", usage: TextureUsage.RENDER_ATTACHMENT | TextureUsage.TEXTURE_BINDING });
    record(depth);
    graph.execute();
    culler.poll();
    // The read-back is a mapped promise, so the counters land a microtask later than the poll.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(culler.stats).toEqual({ tested: 2, culledFrustum: 0, culledDistance: 0, culledOccluded: 0, visible: 2, recordZeroed: 0, lodReduced: 1 });
    culler.dispose();
    visibility.destroy();
    records.destroy();
    visible.destroy();
    await device.dispose();
  });

  it("drops a read-back whose map was in flight when dispose landed", async () => {
    // `poll` maps a buffer and consumes it a microtask later, and a scene that ends between the two
    // disposes the pair. Mapping a destroyed buffer is a validation error, which a real device reports
    // as an uncaptured error at teardown — noise for a frame's counters nobody will ever read.
    const { device, mock, graph, visibility, records, visible, culler, prepare, record } = await cullerSetup(1);
    prepare(false, true);
    graph.begin();
    const depth = graph.createTexture("scene.depth", { width: 64, height: 64, format: "depth24plus", usage: TextureUsage.RENDER_ATTACHMENT | TextureUsage.TEXTURE_BINDING });
    record(depth);
    graph.execute();
    culler.poll();
    culler.dispose();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mock.errors).toEqual([]);
    visibility.destroy();
    records.destroy();
    visible.destroy();
    await device.dispose();
  });
});

describe("markCertainDistanceCulls (the verdicts the passes before forge.objects.cull need)", () => {
  // The fixture camera is 10 m from the origin and the test is `away - radius > limit`, where the
  // radius is the box's half diagonal plus CULL_SLOP: for a 0.5 m box that is 0.876 m, so its surface
  // sits 9.1239746 m away. The limits below straddle that number, and the middle one lands inside the
  // host's margin — the pass rejects it and the host deliberately leaves it alone.
  const radius = 0.5;

  it("marks only what the pass certainly rejects, and reports how many", () => {
    const boxes = [
      { c: new Vec3(0, 0, 0), r: radius, limit: 20 }, // 9.124 < 20: kept by both
      { c: new Vec3(0, 0, 0), r: radius, limit: 9.13 }, // just past the surface: kept by both
      { c: new Vec3(0, 0, 0), r: radius, limit: 9.12 }, // the pass rejects it; inside the margin, so the pass decides
      { c: new Vec3(0, 0, 0), r: radius, limit: 9 }, // 9.124 > 9 + margin: certain
      { c: new Vec3(0, 0, 0), r: radius }, // no limit: nothing to decide
    ];
    const bounds = boundsOf(boxes);
    const words = new Uint32Array(boxes.length);
    const marked = markCertainDistanceCulls(bounds, boxes.length, EYE.x, EYE.y, EYE.z, words);
    expect(marked).toBe(1);
    expect([...words]).toEqual([0, 0, 0, CullReason.Distance, 0]);

    // The twin — and so the pass, which runs the same rule — rejects the last two of the three that
    // have a limit at all. The host's marks have to be a subset of that, never a superset.
    const twin = new Uint32Array(boxes.length);
    cullBatchesOnCpu(bounds, boxes.length, frameParams(), twin);
    expect([...twin]).toEqual([0, 0, CullReason.Distance, CullReason.Distance, 0]);
    expect(10 - (Math.hypot(radius, radius, radius) + 0.01)).toBeCloseTo(9.1239746, 6);
  });

  it("never marks a batch the twin keeps, over a sweep of limits, distances and box sizes", () => {
    // This is the whole safety argument: a batch the host marks is skipped by the prepass and the
    // shadow maps, so marking one the pass keeps would leave it shading without prepass depth — the
    // hole this exists to prevent, one level down. The margin is what makes the implication hold
    // across f32 rounding, and a sweep is what makes that claim mean something.
    let marked = 0;
    let keptByTwin = 0;
    for (let step = 0; step < 600; step++) {
      const z = (step % 40) * 2; // 0..78 m ahead of the camera
      const r = 0.25 + (step % 7) * 1.5; // 0.25..9.25 m boxes
      const limit = 1 + ((step * 7) % 120) * 0.5; // 1..60 m, deliberately landing on boundaries
      const boxes = [{ c: new Vec3(0, 0, z), r, limit }];
      const bounds = boundsOf(boxes);
      const words = new Uint32Array(1);
      markCertainDistanceCulls(bounds, 1, EYE.x, EYE.y, EYE.z, words);
      const twin = new Uint32Array(1);
      cullBatchesOnCpu(bounds, 1, frameParams(), twin);
      if (twin[0] === CullReason.Visible) keptByTwin++;
      if (words[0] !== 0) {
        marked++;
        expect(twin[0]).toBe(CullReason.Distance);
        expect(words[0]).toBe(CullReason.Distance);
      }
    }
    // Both sides of the sweep have to be populated, or the implication above is vacuous.
    expect(marked).toBeGreaterThan(50);
    expect(keptByTwin).toBeGreaterThan(50);
  });

  it("leaves batches past the cap alone: the pass never tests them, so its word is the last word", () => {
    const count = MAX_CULLED_BATCHES + 3;
    const boxes = Array.from({ length: count }, (_, i) => ({ c: new Vec3(0, 0, 5000 + i), r: 1, limit: 10 }));
    const words = new Uint32Array(count);
    const marked = markCertainDistanceCulls(boundsOf(boxes), count, EYE.x, EYE.y, EYE.z, words);
    expect(marked).toBe(MAX_CULLED_BATCHES);
    expect([...words.subarray(MAX_CULLED_BATCHES)]).toEqual([0, 0, 0]);
  });
});
