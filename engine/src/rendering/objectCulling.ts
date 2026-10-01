/**
 * GPU object culling — Phase 13.5 (docs/RENDERING.md §4d).
 *
 * `Renderer.collectBatches` frustum-culls every renderable on the CPU before it becomes a batch:
 * that test decides what enters the frame (an instance the camera cannot see never gets an instance
 * record), so the batches the device receives are already rectangularly visible. It cannot decide two
 * things, and those are what this module is for:
 *
 *  - **Occlusion.** An object can be inside the frustum and still have every one of its pixels behind
 *    nearer geometry — terrain, a wall, another object. Only the frame's own depth buffer knows that,
 *    and it exists on the device half-way through the frame: `forge.prepass` lays it down before
 *    `forge.main` shades anything, which is why roadmap 13.1 lists culling as a consumer of that
 *    depth and 13.5 builds it here.
 *  - **Distance.** `Renderable.maxDistance` is a *draw* rule, not an upload rule, and the one
 *    implementation of it lives here, where the per-batch bounds already are.
 *
 * Both are per *batch*, the unit the renderer already sorts, cascade-culls and draws with.
 *
 * ## Three tests, one compute pass
 *
 * `forge.objects.cull` runs one invocation per batch, after `forge.prepass` and before `forge.main`:
 *
 *  1. **Frustum.** The six planes are extracted from `ObjectCullUniforms.viewProj` inside the shader
 *     with the same rows `Frustum.setFromViewProjection` uses (its private `extractStandard`), and a
 *     one is culled. For the batches the CPU uploaded this is a *guard*, not a saving — their boxes
 *     are in view by construction — but it is what makes the occlusion test well defined (a batch
 *     outside the frustum has no rectangle), and it is also the only place that notices a sphere
 *     which misses the screen entirely: the CPU tests the box, the device tests the sphere, and a
 *     sphere that contains an on-screen box cannot happen, but a sphere whose *rectangle* is off
 *     screen is exactly the case where both agree the batch cannot be drawn.
 *  2. **Distance.** Distance from the camera to the sphere, minus its radius, against the batch's own
 *     limit (0 = no limit). Only batches that set one are tested — `flags` bit 1 says whether any
 *     batch in the frame does.
 *  3. **Occlusion (HiZ).** `forge.hiz.<level>` builds a depth pyramid — a 2×2 max-reduction chain,
 *     in view-space *metres* — from the prepass depth. A batch is culled when, for every pyramid
 *     texel its projected rectangle touches, that texel's *farthest* depth is still nearer than the
 *     batch's nearest point.
 *
 * Conservative in every direction that matters: the sphere contains the box, the rectangle is the
 * projection of the sphere's own view-space box (projected corner by corner — a projective map takes
 * lines to lines, so the corner images bound the image, the same argument `clusters.ts` makes), the
 * rectangle is rounded *outward* to whole texels of a level chosen so it spans a couple of them, and
 * every comparison carries a margin (a centimetre on the sphere, a pixel on the rectangle, a
 * millimetre on the depth). The failure to fear is a batch that silently stops being drawn;
 * over-culling the *other* way would just be a visible bug.
 *
 *  - **Level of detail (Phase 14.4).** A batch whose geometry carries a LOD chain
 *    (`Geometry.lods`: several detail levels concatenated into one index buffer, each an index
 *    window plus the distance it starts at) has its *draw window* decided here too. The pass writes
 *    the record's `indexCount` and `firstIndex` from the level the batch's own distance selects, so
 *    the detail level is a device decision with no read-back, no second buffer and no per-batch CPU
 *    work — the same verdict, the same invocation, two more words. {@link selectLodLevel} is the
 *    rule and the WGSL `selectLod` transcribes it; the renderer runs it on the CPU as well, because
 *    the passes that draw *before* this one (the depth prepass, the shadow maps) cannot read a
 *    record this pass has not written yet and must agree with it exactly — a prepass at level 0
 *    under a main pass at level 2 rejects the coarse surface's farther fragments and punches holes
 *    in it. Selection is per *batch*: a population chunk whose near edge is close draws every one
 *    of its instances at the finer level.
 *
 * ## Consuming the verdict without a read-back
 *
 * The word lands in a storage buffer bound as group 1 binding 2 of the draw group, and the standard
 * shader's vertex entry points *select* a clipped-out position for a culled batch — so the device
 * saves the rasterisation and the fragment work, with no indirect draw, no `mapAsync` and no stall,
 * and one code path serves instanced and non-instanced draws alike. A culled batch still costs its
 * draw call and its vertex invocations; removing those is 13.6's visible-object compaction, which
 * consumes exactly this buffer.
 *
 * The *statistics* are the one thing that has to come back. A device-side count is not knowable on
 * the CPU without a stall or a lag; the pass `atomicAdd`s four counters, the frame copies them into
 * a map-read buffer, and the renderer reports them a frame or two later (documented at the stats,
 * not hidden here). The CPU fill's numbers are exact and immediate, like the cluster fill's.
 *
 * ## Why the pyramid is not a render-graph transient
 *
 * Its levels are written through *storage* texture views and read through sampled ones; the graph
 * tracks attachments and `reads`, and neither describes that, so the pyramid is owned here (like the
 * renderer's fallback textures) and bound directly by the passes that touch it. It is recreated when
 * the render target's size changes and destroyed by {@link GpuObjectCuller.dispose}.
 *
 * The whole geometry — the plane extraction, the pyramid, the three tests — exists on the CPU too as
 * `cullBatchesOnCpu`, the shader's twin: the `RendererOptions.objectCulling: "cpu"` fallback the mock
 * device and the browser gate's A/B run, and the reference `tests/objectCulling.test.ts` pins against
 * a brute-force per-pixel occlusion check of the real depth image.
 */

import { BufferUsage, ShaderStage, TextureUsage, gpuSource } from "../gpu/constants.js";
import { StructAccessor, WriteBuffer } from "../gpu/bufferWriter.js";
import type { ShaderCache } from "../gpu/shaderCache.js";
import type { GraphicsDevice } from "../gpu/device.js";
import { Mat4 } from "../math/mat.js";
import {
  MAX_BATCH_LODS,
  MAX_CULLED_BATCHES,
  MAX_LOD_SETS,
  ObjectBatchBlock,
  ObjectBatchEntry,
  ObjectCullStatsBlock,
  ObjectCullUniforms,
  ObjectLodLevel,
  ObjectLodSet,
  ObjectLodSetBlock,
} from "./uniforms.js";
import type { RenderGraph, RenderGraphHandle, RenderGraphPassContext } from "./renderGraph.js";

/** Invocations per workgroup of `forge.objects.cull`: one batch each. */
export const CULL_WORKGROUP = 64;
/** Edge of the reduction workgroups that build the depth pyramid (one texel each). */
export const HIZ_WORKGROUP = 8;
/**
 * Levels in the depth pyramid. Level 0 is the depth target reduced 2×2, level `k` 2^(k+1)×2^(k+1),
 * so the whole chain costs a third of the depth buffer's pixels and the finest occlusion decision is
 * made on 2-pixel texels. A target too small for four levels gets fewer.
 */
export const HIZ_LEVELS = 4;
/** Metres added to a box's circumsphere, so a plane or depth comparison on the boundary keeps it. */
const CULL_SLOP = 0.01;
/** Pixels added to a projected rectangle before it is rounded out to whole pyramid texels. */
const CULL_PAD_PIXELS = 1;
/** Metres by which a pyramid texel must beat a batch's nearest point for the texel to count. */
const CULL_EPSILON = 0.001;

/** What a batch's `visibility` word says. `Visible` is 0, which is also what a reset buffer holds. */
export const CullReason = {
  Visible: 0,
  Frustum: 1,
  Distance: 2,
  Occluded: 3,
} as const;
export type CullReason = (typeof CullReason)[keyof typeof CullReason];

/** `ObjectCullUniforms.flags` bits — which of the three tests run this frame. */
export const CULL_FLAG_FRUSTUM = 1;
export const CULL_FLAG_DISTANCE = 2;
export const CULL_FLAG_OCCLUSION = 4;
/**
 * Write the frame's indirect draw records (Phase 13.6). Off when the renderer submits direct draws,
 * where the same verdicts reach the shader through the visibility words instead and nothing reads a
 * record: the pass then neither touches the buffer nor counts `recordZeroed`.
 */
export const CULL_FLAG_RECORDS = 8;
/**
 * Select each batch's LOD level on the device (Phase 14.4). Implies {@link CULL_FLAG_RECORDS}: the
 * level *is* the record's index window, so a frame that submits direct draws has its levels chosen
 * by {@link selectLodLevel} on the CPU instead and this flag stays off.
 */
export const CULL_FLAG_LOD = 16;

/**
 * One indirect draw record: `(count, instanceCount, first, baseVertex, firstInstance)`, the layout
 * `drawIndexedIndirect` reads, in words. `drawIndirect`'s record is the same shape — `(vertexCount,
 * instanceCount, firstVertex, firstInstance)` — so **word 1 is the instance count in both**, which is
 * the only field the culler decides; the batch's index window (words 0 and 2) is CPU knowledge and is
 * uploaded once per frame. Records sit one per 32-byte slot so every offset stays 16-aligned and the
 * pass can address a slot as 8 consecutive `u32`s.
 */
export const DRAW_RECORD_WORDS = 8;
export const DRAW_RECORD_BYTES = DRAW_RECORD_WORDS * 4;
/** Word the pass owns: the instance count the draw runs with, 0 for a culled batch. */
export const DRAW_RECORD_INSTANCES = 1;
/**
 * Words the pass also owns for a batch with a LOD chain (Phase 14.4): the index window of the level
 * its distance selected. The CPU still writes both — level 0's window — so a batch the pass never
 * reaches (past {@link MAX_CULLED_BATCHES}, or a frame with no LOD flag) draws its finest level.
 */
export const DRAW_RECORD_INDEX_COUNT = 0;
export const DRAW_RECORD_FIRST_INDEX = 2;

/**
 * The per-batch set index that means "this geometry has no LOD chain": the pass leaves the record's
 * CPU window alone. It is `MAX_LOD_SETS`-proof by construction — no live set index can reach it.
 */
export const LOD_SET_NONE = 0xffffffff;

/** Byte geometry of the device LOD table, taken from the generated layout so a struct change cannot silently desynchronise the upload. */
const LOD_SETS_FIELD = ObjectLodSetBlock.field("sets", "storage");
const LOD_SET_LEVELS_FIELD = ObjectLodSet.field("levels", "storage");
const LOD_SET_LODS_FIELD = ObjectLodSet.field("lods", "storage");
const LOD_LEVEL_FIRST_INDEX_FIELD = ObjectLodLevel.field("firstIndex", "storage");
const LOD_LEVEL_INDEX_COUNT_FIELD = ObjectLodLevel.field("indexCount", "storage");
const LOD_LEVEL_MIN_DISTANCE_FIELD = ObjectLodLevel.field("minDistance", "storage");
/** Bytes of the whole table: the buffer is created at this size once, whatever is live in it. */
export const LOD_TABLE_BYTES = ObjectLodSetBlock.byteSize("storage");

/** Bytes of `ObjectCullStatsBlock`: both the device buffer and the map-read copy are this big. */
export const CULL_STATS_BYTES = ObjectCullStatsBlock.byteSize("storage");

/** Word index of each counter in the mapped stats block, from the generated layout. */
const STATS_WORD = {
  tested: ObjectCullStatsBlock.offsetOf("tested", "storage") >> 2,
  culledFrustum: ObjectCullStatsBlock.offsetOf("culledFrustum", "storage") >> 2,
  culledDistance: ObjectCullStatsBlock.offsetOf("culledDistance", "storage") >> 2,
  culledOccluded: ObjectCullStatsBlock.offsetOf("culledOccluded", "storage") >> 2,
  visible: ObjectCullStatsBlock.offsetOf("visible", "storage") >> 2,
  recordZeroed: ObjectCullStatsBlock.offsetOf("recordZeroed", "storage") >> 2,
  lodReduced: ObjectCullStatsBlock.offsetOf("lodReduced", "storage") >> 2,
} as const;

/**
 * `forge.hiz.0` — the depth target reduced 2×2 into the pyramid's level 0, converted to view-space
 * metres as it goes (the conversion is monotone in the stored NDC depth, so a max over the metres is
 * a max over the depths).
 */
export const HIZ_DEPTH_SHADER = /* wgsl */ `
${ObjectCullUniforms.toWgsl("uniform")}

@group(0) @binding(0) var<uniform> cull: ObjectCullUniforms;
@group(0) @binding(1) var depthSource: texture_depth_2d;
@group(0) @binding(2) var dest: texture_storage_2d<r32float, write>;

const HIZ_WORKGROUP: u32 = ${HIZ_WORKGROUP}u;

// The inverse of Mat4.setPerspective's depth (clipZ = (far*z - far*near)/(far-near), clipW = z, so
// ndc = far*(z-near)/((far-near)*z) inverts to this). ndc 1.0 — a pixel nothing wrote — maps to
// "far", which occludes nothing.
fn viewDepthOf(ndc: f32) -> f32 {
  return (cull.near * cull.far) / max(cull.far - ndc * (cull.far - cull.near), 1e-6);
}

@workgroup_size(HIZ_WORKGROUP, HIZ_WORKGROUP) @compute fn csHizDepth(@builtin(global_invocation_id) gid: vec3<u32>) {
  let size = textureDimensions(dest);
  if (gid.x >= size.x || gid.y >= size.y) {
    return;
  }
  let source = textureDimensions(depthSource);
  let last = vec2<u32>(max(source.x, 1u) - 1u, max(source.y, 1u) - 1u);
  var far = 0.0;
  for (var y = 0u; y < 2u; y = y + 1u) {
    for (var x = 0u; x < 2u; x = x + 1u) {
      let p = min(gid.xy * 2u + vec2<u32>(x, y), last);
      // A depth texture has no sampled variant: the load takes the mip level explicitly (0 — the
      // view binds one level). Chromium accepts the two-argument form, WebKit/Tint reject the module.
      far = max(far, viewDepthOf(textureLoad(depthSource, vec2<i32>(i32(p.x), i32(p.y)), 0)));
    }
  }
  textureStore(dest, vec2<i32>(i32(gid.x), i32(gid.y)), vec4<f32>(far, 0.0, 0.0, 0.0));
}
`;

/**
 * `forge.hiz.<n>` for n ≥ 1 — one level from the one below: a plain 2×2 max over the metres the
 * previous level holds. `source` is a single-mip view of that level, so the shader's level 0 *is* it.
 */
export const HIZ_REDUCE_SHADER = /* wgsl */ `
@group(0) @binding(0) var source: texture_2d<f32>;
@group(0) @binding(1) var dest: texture_storage_2d<r32float, write>;

const HIZ_WORKGROUP: u32 = ${HIZ_WORKGROUP}u;

@workgroup_size(HIZ_WORKGROUP, HIZ_WORKGROUP) @compute fn csHizReduce(@builtin(global_invocation_id) gid: vec3<u32>) {
  let size = textureDimensions(dest);
  if (gid.x >= size.x || gid.y >= size.y) {
    return;
  }
  let sourceSize = textureDimensions(source);
  let last = vec2<u32>(max(sourceSize.x, 1u) - 1u, max(sourceSize.y, 1u) - 1u);
  var far = 0.0;
  for (var y = 0u; y < 2u; y = y + 1u) {
    for (var x = 0u; x < 2u; x = x + 1u) {
      let p = min(gid.xy * 2u + vec2<u32>(x, y), last);
      far = max(far, textureLoad(source, vec2<i32>(i32(p.x), i32(p.y)), 0).r);
    }
  }
  textureStore(dest, vec2<i32>(i32(gid.x), i32(gid.y)), vec4<f32>(far, 0.0, 0.0, 0.0));
}
`;

/**
 * `forge.objects.cull` — one invocation per batch, three tests, one word written. The WGSL is the
 * algorithm `cullBatchesOnCpu` restates in TypeScript; `tests/objectCulling.test.ts` pins their
 * agreement on the decisions the margins make unambiguous, and pins the conservatism of both against
 * a per-pixel scan of the depth image they were given.
 */
export const OBJECT_CULL_SHADER = /* wgsl */ `
${ObjectCullUniforms.toWgsl("uniform")}
${ObjectBatchEntry.toWgsl("storage")}
${ObjectBatchBlock.toWgsl("storage")}
${ObjectCullStatsBlock.toWgsl("storage")}
${ObjectLodLevel.toWgsl("storage")}
${ObjectLodSet.toWgsl("storage")}
${ObjectLodSetBlock.toWgsl("storage")}

@group(0) @binding(0) var<uniform> cull: ObjectCullUniforms;
@group(0) @binding(1) var<storage, read> batchBounds: ObjectBatchBlock;
@group(0) @binding(2) var<storage, read_write> visibility: array<u32>;
@group(0) @binding(3) var<storage, read_write> counts: ObjectCullStatsBlock;
@group(0) @binding(4) var hiz: texture_2d<f32>;
// The frame's indirect draw records (Phase 13.6), bound whether or not this frame writes them.
@group(0) @binding(5) var<storage, read_write> drawRecords: array<u32>;
// The compaction list: one slot per visible batch, filled at counts.visible's cursor.
@group(0) @binding(6) var<storage, read_write> visibleBatches: array<u32>;
// Phase 14.4: one LOD set index per batch (LOD_SET_NONE when its geometry has no chain), and the
// static table those indices address — uploaded once per distinct geometry, not once per frame.
@group(0) @binding(7) var<storage, read> batchLods: array<u32>;
@group(0) @binding(8) var<storage, read> lodSets: ObjectLodSetBlock;

const CULL_WORKGROUP: u32 = ${CULL_WORKGROUP}u;
const MAX_CULLED_BATCHES: u32 = ${MAX_CULLED_BATCHES}u;
const CULL_FLAG_FRUSTUM: u32 = ${CULL_FLAG_FRUSTUM}u;
const CULL_FLAG_DISTANCE: u32 = ${CULL_FLAG_DISTANCE}u;
const CULL_FLAG_OCCLUSION: u32 = ${CULL_FLAG_OCCLUSION}u;
const CULL_FLAG_RECORDS: u32 = ${CULL_FLAG_RECORDS}u;
const CULL_FLAG_LOD: u32 = ${CULL_FLAG_LOD}u;
const RECORD_WORDS: u32 = ${DRAW_RECORD_WORDS}u;
const RECORD_INSTANCES: u32 = ${DRAW_RECORD_INSTANCES}u;
const RECORD_INDEX_COUNT: u32 = ${DRAW_RECORD_INDEX_COUNT}u;
const RECORD_FIRST_INDEX: u32 = ${DRAW_RECORD_FIRST_INDEX}u;
const CULL_SLOP: f32 = ${CULL_SLOP};
const CULL_PAD_PIXELS: f32 = ${CULL_PAD_PIXELS}.0;
const CULL_EPSILON: f32 = ${CULL_EPSILON};
const REASON_VISIBLE: u32 = ${CullReason.Visible}u;
const REASON_FRUSTUM: u32 = ${CullReason.Frustum}u;
const REASON_DISTANCE: u32 = ${CullReason.Distance}u;
const REASON_OCCLUDED: u32 = ${CullReason.Occluded}u;

// The six frustum planes (near, far, left, right, bottom, top) as Frustum.extractStandard builds
// them: rows of the view-projection, inward-facing, for a clip space with z in [0,1] and clipW = z.
// Left unnormalized — outsidePlane below scales by the row's length, which is the normalization.
fn planeAt(row: u32) -> vec4<f32> {
  let m = cull.viewProj;
  if (row == 0u) {
    return vec4<f32>(m[0][2], m[1][2], m[2][2], m[3][2]);
  }
  if (row == 1u) {
    return vec4<f32>(m[0][3] - m[0][2], m[1][3] - m[1][2], m[2][3] - m[2][2], m[3][3] - m[3][2]);
  }
  if (row == 2u) {
    return vec4<f32>(m[0][0] + m[0][3], m[1][0] + m[1][3], m[2][0] + m[2][3], m[3][0] + m[3][3]);
  }
  if (row == 3u) {
    return vec4<f32>(m[0][3] - m[0][0], m[1][3] - m[1][0], m[2][3] - m[2][0], m[3][3] - m[3][0]);
  }
  if (row == 4u) {
    return vec4<f32>(m[0][1] + m[0][3], m[1][1] + m[1][3], m[2][1] + m[2][3], m[3][1] + m[3][3]);
  }
  return vec4<f32>(m[0][3] - m[0][1], m[1][3] - m[1][1], m[2][3] - m[2][1], m[3][3] - m[3][1]);
}

// Outside a plane means the centre is further than the radius on the far side. Both sides carry the
// row's length, so the plane needs no normalize.
fn outsidePlane(p: vec4<f32>, center: vec3<f32>, radius: f32) -> bool {
  return dot(p.xyz, center) + p.w < -length(p.xyz) * radius;
}

// Phase 14.4: the level a distance selects — the last one whose minDistance it has reached, so an
// ascending chain needs no search. The TypeScript selectLodLevel is this function; the two are
// pinned against each other by tests/objectCulling.test.ts and by the renderer's own CPU mirror
// (the prepass and the shadow maps must draw the level this pass will pick, or the depth they lay
// down disagrees with the surface the main pass shades).
// The parameter is "chain" and never "set": WGSL reserves that word, Tint rejects the module at parse
// time, and the host mock (which does not parse WGSL at all) would have drawn it happily. The word is
// in WGSL_RESERVED_WORDS now, so ShaderCache.get refuses it before a device ever sees it.
fn selectLod(chain: ObjectLodSet, d: f32) -> u32 {
  var level = 0u;
  for (var i = 1u; i < chain.levels; i = i + 1u) {
    if (d >= chain.lods[i].minDistance) {
      level = i;
    }
  }
  return level;
}

// The three tests, as one verdict. Every branch that returns REASON_VISIBLE is a case the tests
// could not *prove* invisible — a conservative answer, never a wrong one. The sphere is built by the
// caller: the LOD selection measures from the same centre the tests do.
fn cullReasonOf(box: ObjectBatchEntry, center: vec3<f32>, radius: f32) -> u32 {
  if ((cull.flags & CULL_FLAG_FRUSTUM) != 0u) {
    var outside = false;
    for (var row = 0u; row < 6u; row = row + 1u) {
      if (outsidePlane(planeAt(row), center, radius)) {
        outside = true;
      }
    }
    if (outside) {
      return REASON_FRUSTUM;
    }
  }

  if ((cull.flags & CULL_FLAG_DISTANCE) != 0u) {
    if (box.min.w > 0.0) {
      if (distance(center, cull.cameraPos) - radius > box.min.w) {
        return REASON_DISTANCE;
      }
    }
  }

  if ((cull.flags & CULL_FLAG_OCCLUSION) == 0u || cull.hizLevels == 0u) {
    return REASON_VISIBLE;
  }
  let viewCenter = (cull.view * vec4<f32>(center, 1.0)).xyz;
  let nearest = viewCenter.z - radius;
  if (nearest <= cull.near) {
    // The sphere straddles the near plane, so no screen rectangle bounds it: nothing is proved.
    return REASON_VISIBLE;
  }

  // The rectangle: the eight corners of the sphere's view-space box, projected. A projective map
  // sends lines to lines, so the image of the box is the convex hull of its corner images — and the
  // sphere is inside the box.
  var lo = vec2<f32>(1e30, 1e30);
  var hi = vec2<f32>(-1e30, -1e30);
  for (var corner = 0u; corner < 8u; corner = corner + 1u) {
    let offset = vec3<f32>(
      select(-radius, radius, (corner & 1u) != 0u),
      select(-radius, radius, (corner & 2u) != 0u),
      select(-radius, radius, (corner & 4u) != 0u),
    );
    let p = viewCenter + offset;
    let ndc = vec2<f32>(cull.proj[0][0] * p.x / p.z, cull.proj[1][1] * p.y / p.z);
    // NDC +y points up the screen and texel row 0 is the top of the image, so the pixel row is the
    // negated y. Sign errors here do not miss a rect by one texel — they test the *mirrored* half of
    // the screen, which happily reports "occluded" for anything floating over near ground.
    let pixel = vec2<f32>((ndc.x * 0.5 + 0.5) * cull.extent.x, (0.5 - ndc.y * 0.5) * cull.extent.y);
    lo = min(lo, pixel);
    hi = max(hi, pixel);
  }
  let rectMin = lo - vec2<f32>(CULL_PAD_PIXELS, CULL_PAD_PIXELS);
  let rectMax = hi + vec2<f32>(CULL_PAD_PIXELS, CULL_PAD_PIXELS);
  if (rectMax.x < 0.0 || rectMax.y < 0.0 || rectMin.x > cull.extent.x || rectMin.y > cull.extent.y) {
    // The rectangle (which contains the batch's projection) misses the screen entirely.
    return REASON_FRUSTUM;
  }

  // The finest level whose texels are a couple of pixels across at most: level L's texel covers
  // 2^(L+1) pixels of the depth target, so a rectangle of span s takes L = ceil(log2(s)) - 2.
  let span = max(rectMax.x - rectMin.x, rectMax.y - rectMin.y);
  var level = 0i;
  if (span > 4.0) {
    level = i32(ceil(log2(span))) - 2;
  }
  level = clamp(level, 0, i32(cull.hizLevels) - 1);
  let texels = 1u << (u32(level) + 1u);
  let levelExtent = vec2<u32>(
    max(1u, u32(cull.extent.x) >> (u32(level) + 1u)),
    max(1u, u32(cull.extent.y) >> (u32(level) + 1u)),
  );
  let lastTexel = levelExtent - vec2<u32>(1u, 1u);
  let firstSpan = min(vec2<u32>(u32(max(rectMin.x, 0.0)), u32(max(rectMin.y, 0.0))) / texels, lastTexel);
  let lastSpan = min(vec2<u32>(u32(max(rectMax.x, 0.0)), u32(max(rectMax.y, 0.0))) / texels, lastTexel);
  let bound = nearest - CULL_EPSILON;
  for (var ty = firstSpan.y; ty <= lastSpan.y; ty = ty + 1u) {
    for (var tx = firstSpan.x; tx <= lastSpan.x; tx = tx + 1u) {
      if (textureLoad(hiz, vec2<i32>(i32(tx), i32(ty)), level).r >= bound) {
        return REASON_VISIBLE;
      }
    }
  }
  return REASON_OCCLUDED;
}

// One invocation per batch decides everything the frame needs to know about it, and this is the only
// place any of it is written: the visibility word, the three cull counters, the batch's slot in the
// compaction list, and the batch's indirect draw record. Keeping one write site is what makes the
// word and the record provably agree — they are the same verdict, written twice for two consumers
// (the vertex stage's clip test and, in Phase 13.6, the draw command itself).
@workgroup_size(CULL_WORKGROUP) @compute fn csCull(@builtin(global_invocation_id) gid: vec3<u32>) {
  let index = gid.x;
  let total = min(cull.batchCount, MAX_CULLED_BATCHES);
  if (index >= total) {
    return;
  }
  atomicAdd(&counts.tested, 1u);

  let box = batchBounds.bounds[index];
  let center = (box.min.xyz + box.max.xyz) * 0.5;
  let radius = length(box.max.xyz - center) + CULL_SLOP;
  let reason = cullReasonOf(box, center, radius);
  // Stays 0 (visible) unless a test proves otherwise: the CPU resets the whole buffer every frame, so
  // an early return here is always "draw it", never "whatever the last frame said".
  visibility[index] = reason;

  let kept = reason == REASON_VISIBLE;
  if (kept) {
    // Compaction: the slot this batch takes in the frame's visible list. The cursor is the list's
    // length *and* the visible count, and the slots are filled in completion order — the list is a
    // set, so a consumer that needs draw order sorts it (the CPU twin writes the same list in test
    // order, which is why the two arms can be compared as sets).
    let slot = atomicAdd(&counts.visible, 1u);
    if (slot < MAX_CULLED_BATCHES) {
      visibleBatches[slot] = index;
    }
  } else if (reason == REASON_FRUSTUM) {
    atomicAdd(&counts.culledFrustum, 1u);
  } else if (reason == REASON_DISTANCE) {
    atomicAdd(&counts.culledDistance, 1u);
  } else {
    atomicAdd(&counts.culledOccluded, 1u);
  }

  if ((cull.flags & CULL_FLAG_RECORDS) != 0u) {
    // The draw command, decided on the device: a *direct* draw cannot express "zero instances", which
    // is why Phase 13.5 collapsed a culled batch's clip position instead and paid its vertex shader;
    // an indirect record can, so a culled batch's draw runs no invocation at all — whoever shades it.
    // Untested batches (past MAX_CULLED_BATCHES) keep the count the CPU uploaded: visible.
    let word = index * RECORD_WORDS;
    if (kept) {
      drawRecords[word + RECORD_INSTANCES] = u32(box.max.w);
      // Phase 14.4 — the level is two more words of the same record: the draw that runs is the one
      // this batch's own distance asked for, with no CPU decision and no read-back. A batch whose
      // geometry has no chain (LOD_SET_NONE, or a set index past the live table) keeps the window
      // the CPU uploaded, which is level 0 — the finest, and the safe answer to "don't know".
      if ((cull.flags & CULL_FLAG_LOD) != 0u) {
        let setId = batchLods[index];
        if (setId < cull.lodSetCount) {
          let chain = lodSets.sets[setId];
          let level = selectLod(chain, distance(center, cull.cameraPos));
          drawRecords[word + RECORD_INDEX_COUNT] = chain.lods[level].indexCount;
          drawRecords[word + RECORD_FIRST_INDEX] = chain.lods[level].firstIndex;
          if (level > 0u) {
            atomicAdd(&counts.lodReduced, 1u);
          }
        }
      }
    } else {
      drawRecords[word + RECORD_INSTANCES] = 0u;
      atomicAdd(&counts.recordZeroed, 1u);
    }
  }
}
`;


// ------------------------------------------------------------------ the tests, in TypeScript

/** What the three tests did to one frame's batches. */
export interface ObjectCullStats {
  tested: number;
  culledFrustum: number;
  culledDistance: number;
  culledOccluded: number;
  /** Batches that stayed visible: the compaction list's length. */
  visible: number;
  /** Batches whose indirect draw record was zeroed; 0 when the frame submits direct draws. */
  recordZeroed: number;
  /** Visible batches the pass dropped to a coarser LOD level (Phase 14.4); 0 when no chain exists. */
  lodReduced: number;
}

/** One chain level as the CPU reads it: the draw window it selects and the distance it starts at. */
export interface ObjectLodLevelCpu {
  firstIndex: number;
  indexCount: number;
  minDistance: number;
}

/** One geometry's chain, in CPU form. `Geometry.lods` satisfies this shape as it stands. */
export interface ObjectLodSetCpu {
  levels: readonly ObjectLodLevelCpu[];
}

/**
 * The frame's LOD inputs (Phase 14.4): the static table, one set per distinct chained geometry, and
 * one set index per batch. {@link LOD_SET_NONE} marks a batch whose geometry has no chain, so the
 * selection leaves its CPU-uploaded window (level 0) alone.
 */
export interface ObjectLodTable {
  sets: readonly ObjectLodSetCpu[];
  /** One index per batch, in batch order; entries past the batch count are never read. */
  batchSets: ArrayLike<number>;
}

/**
 * The LOD a distance selects: the last level whose `minDistance` it has reached. `levels[0]`'s
 * threshold is 0 by construction (`Geometry.concatenateLods` rejects a chain that is not ascending),
 * so the answer is 0 for anything nearer than the first threshold and the coarsest level past the
 * last. This is the rule the WGSL `selectLod` transcribes, and the one the renderer's CPU mirror
 * runs for the passes that draw before the device gets to decide (prepass, shadow maps).
 */
export function selectLodLevel(levels: ArrayLike<{ readonly minDistance: number }>, distance: number): number {
  let level = 0;
  for (let i = 1; i < levels.length; i++) {
    if (distance >= (levels[i]?.minDistance ?? 0)) level = i;
  }
  return level;
}

/**
 * The distance a LOD threshold measures, in the device's own arithmetic (Phase 14.4).
 *
 * `selectLod` compares `distance(center, cull.cameraPos)` with `minDistance`: an f32 centre built
 * from the f32 bounds entry, an f32 camera position out of the uniform block, and f32 differences,
 * products and square root. The two host paths that must agree with it — the renderer's mirror, which
 * decides what the prepass and the shadow maps draw, and {@link cullBatchesOnCpu}, which decides what
 * a cpu-culling frame draws — measure in f64 by default, and a level threshold has no slop to absorb
 * the difference: at 800 m one f32 ulp is 6.1e-5 m, so a batch inside that gap of a `minDistance`
 * gets one level on the host and another on the device.
 *
 * That is not cosmetic drift. `forge.main` reads the device's choice while the prepass reads the
 * mirror's, and with `depthCompare: "less-equal"` a coarser main-pass surface has its farther
 * fragments rejected by the finer prepass depth — the geometry gets holes. So both host paths round
 * exactly where the device rounds. Tint may still contract `dot` into an fma and leave one ulp; the
 * cull verdicts absorb that with `CULL_SLOP`, and this is as close as the two languages get.
 *
 * Arguments are the bounds entry's min and max corners and the camera position, in that order, so
 * neither caller has to allocate a centre.
 */
export function lodDistanceF32(
  minX: number,
  minY: number,
  minZ: number,
  maxX: number,
  maxY: number,
  maxZ: number,
  cameraX: number,
  cameraY: number,
  cameraZ: number,
): number {
  const cx = Math.fround((Math.fround(minX) + Math.fround(maxX)) * 0.5);
  const cy = Math.fround((Math.fround(minY) + Math.fround(maxY)) * 0.5);
  const cz = Math.fround((Math.fround(minZ) + Math.fround(maxZ)) * 0.5);
  const dx = Math.fround(cx - Math.fround(cameraX));
  const dy = Math.fround(cy - Math.fround(cameraY));
  const dz = Math.fround(cz - Math.fround(cameraZ));
  const xx = Math.fround(dx * dx);
  const yy = Math.fround(dy * dy);
  const zz = Math.fround(dz * dz);
  return Math.fround(Math.sqrt(Math.fround(Math.fround(xx + yy) + zz)));
}

/**
 * How far past its own limit a batch has to be before {@link markCertainDistanceCulls} says so. The
 * host and the device measure the same distance in the same f32 arithmetic, but Tint may contract the
 * shader's `dot` into an fma and leave one ulp, and the limit itself is an f32 in the bounds entry:
 * a centimetre plus a few parts in a million is wider than either, and narrower than any scene's
 * level of detail.
 */
const DISTANCE_VERDICT_MARGIN = 1e-2;

/**
 * Write the distance verdicts the host can reach *before* the device pass runs, and return how many
 * batches it marked.
 *
 * `forge.objects.cull` runs after the shadow maps and the depth prepass, because the occlusion test
 * reads the pyramid the prepass depth is reduced into. Until it runs, the visibility words those two
 * read are whatever the host uploaded, and a host that uploaded zeros — "visible" — makes both of
 * them draw every batch in the frame, including the ones the pass is about to reject. That is not
 * only wasted rasterisation: a rejected batch that wrote prepass depth still rejects the sky there,
 * and `forge.main` never shades it, so the pixel keeps the clear colour. Over the terrain demo that
 * was 418 dark specks along the horizon (measured by `tools/browser-check.mjs`, which A/Bs the device
 * culler against the twin pixel for pixel) — distant rocks past their `maxDistance`, silhouetted
 * against the sky.
 *
 * So the host states the one verdict it needs no frustum and no pyramid for: this batch is certainly
 * past its own distance limit. "Certainly" is {@link DISTANCE_VERDICT_MARGIN} beyond it, which is why
 * this is a floor and not a twin of the pass — a batch inside the margin is left visible and the pass
 * decides it, exactly as before. Batches at or past {@link MAX_CULLED_BATCHES} are left alone too: the
 * pass never tests them, so a word written here would be the last word, and an untested batch has to
 * stay visible.
 *
 * @param bounds - the frame's bounds entries, 8 words each (see {@link ObjectBatchEntry}).
 * @param batchCount - batches in the frame; entries past the cap are not marked.
 * @param visibility - the frame's visibility words, one per batch, `CullReason.Visible` on entry.
 */
export function markCertainDistanceCulls(
  bounds: ArrayLike<number>,
  batchCount: number,
  cameraX: number,
  cameraY: number,
  cameraZ: number,
  visibility: Uint32Array,
): number {
  const total = Math.min(batchCount, MAX_CULLED_BATCHES);
  let marked = 0;
  for (let index = 0; index < total; index++) {
    const base = index * 8;
    const limit = bounds[base + 3] ?? 0;
    if (!(limit > 0)) continue;
    const minX = bounds[base]!;
    const minY = bounds[base + 1]!;
    const minZ = bounds[base + 2]!;
    const maxX = bounds[base + 4]!;
    const maxY = bounds[base + 5]!;
    const maxZ = bounds[base + 6]!;
    const away = lodDistanceF32(minX, minY, minZ, maxX, maxY, maxZ, cameraX, cameraY, cameraZ);
    // The pass's own radius: half the box diagonal plus CULL_SLOP, so a batch is kept while its
    // sphere still reaches the limit. Measured in f64 over the same f32 corners — the margin below is
    // orders of magnitude wider than the difference that makes.
    const cx = (minX + maxX) * 0.5;
    const cy = (minY + maxY) * 0.5;
    const cz = (minZ + maxZ) * 0.5;
    const radius = Math.hypot(maxX - cx, maxY - cy, maxZ - cz) + CULL_SLOP;
    if (away - radius > limit + DISTANCE_VERDICT_MARGIN + 1e-5 * Math.max(limit, away)) {
      visibility[index] = CullReason.Distance;
      marked++;
    }
  }
  return marked;
}

/**
 * The two things the culler produces for the *frame* rather than for a batch (Phase 13.6): the
 * indirect draw records and the compaction list. Both are `Uint32Array` staging the caller uploads;
 * the device writes the same two buffers from its own pass. Optional, so the tests that only care
 * about the verdicts stay as they were.
 */
export interface ObjectCullOutputs {
  /** `bounds.length / 2` 8-word record slots (see {@link DRAW_RECORD_WORDS}). */
  records?: Uint32Array;
  /** `MAX_CULLED_BATCHES` slots, filled in test order: the CPU arm's compaction list. */
  visible?: Uint32Array;
}

/** Everything the three tests read, in the units the shader reads them (metres, pixels). */
export interface ObjectCullParams {
  /** Render-local → view space, column-major. */
  view: Float32Array;
  /** View → clip, column-major; `proj[0]`/`proj[5]` are the projection scales the rectangle uses. */
  proj: Float32Array;
  /** Render-local → clip, column-major — the matrix the frustum planes come from. */
  viewProj: Float32Array;
  cameraPos: { x: number; y: number; z: number };
  near: number;
  far: number;
  /** Depth target extent in pixels. */
  width: number;
  height: number;
  /** Which tests run: `CULL_FLAG_*` bits. */
  flags: number;
  /** Levels of the pyramid the occlusion test may read; 0 skips it. */
  hizLevels: number;
  /**
   * The frame's LOD table (Phase 14.4). Read only when `flags` carries {@link CULL_FLAG_LOD}, which
   * the caller sets only when it also asked for records: without an indirect record there is no
   * window for the pass to write, and the renderer selects levels on the CPU instead.
   */
  lods?: ObjectLodTable | null;
}

/** One level of a CPU-built pyramid: `data` is width × height view depths in metres. */
export interface HizLevel {
  data: Float32Array;
  width: number;
  height: number;
}

/**
 * The six frustum planes `Frustum.setFromViewProjection` builds, in the shader's own order (near, far,
 * left, right, bottom, top) and left unnormalized the way the shader leaves them.
 * `tests/objectCulling.test.ts` pins this against `Frustum.setFromViewProjection`.
 */
export function cullPlanesFrom(viewProj: Float32Array, out = new Float32Array(24)): Float32Array {
  const m = viewProj;
  const rows: readonly (readonly number[])[] = [
    [m[0]!, m[4]!, m[8]!, m[12]!],
    [m[1]!, m[5]!, m[9]!, m[13]!],
    [m[2]!, m[6]!, m[10]!, m[14]!],
    [m[3]!, m[7]!, m[11]!, m[15]!],
  ];
  const add = (a: readonly number[], b: readonly number[]) => [a[0]! + b[0]!, a[1]! + b[1]!, a[2]! + b[2]!, a[3]! + b[3]!];
  const sub = (a: readonly number[], b: readonly number[]) => [a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!, a[3]! - b[3]!];
  const write = (i: number, v: readonly number[]) => {
    out[i * 4] = v[0]!;
    out[i * 4 + 1] = v[1]!;
    out[i * 4 + 2] = v[2]!;
    out[i * 4 + 3] = v[3]!;
  };
  write(0, rows[2]!); // z >= 0
  write(1, sub(rows[3]!, rows[2]!)); // w - z >= 0
  write(2, add(rows[0]!, rows[3]!));
  write(3, sub(rows[3]!, rows[0]!));
  write(4, add(rows[1]!, rows[3]!));
  write(5, sub(rows[3]!, rows[1]!));
  return out;
}

/** Dimensions of pyramid level `level` for a depth target of `width` × `height`. */
export function hizLevelSize(width: number, height: number, level: number): { width: number; height: number } {
  const shift = level + 1;
  return { width: Math.max(1, width >> shift), height: Math.max(1, height >> shift) };
}

/** Levels a `width` × `height` depth target can build, capped at {@link HIZ_LEVELS}. */
export function hizLevelCount(width: number, height: number): number {
  const base = hizLevelSize(width, height, 0);
  const maxBySize = Math.floor(Math.log2(Math.max(base.width, base.height))) + 1;
  return Math.max(0, Math.min(HIZ_LEVELS, maxBySize));
}

/**
 * The pyramid build passes, on the CPU: a depth image (NDC in [0,1], row-major from the top-left, the
 * order `textureLoad` reads it in) becomes the same metres pyramid. Used by the tests, which need a
 * pyramid to hand the culler; nothing in the frame calls it.
 */
export function buildHizOnCpu(
  depth: Float32Array,
  width: number,
  height: number,
  near: number,
  far: number,
  levels = hizLevelCount(width, height),
): HizLevel[] {
  const viewDepthOf = (ndc: number) => (near * far) / Math.max(far - ndc * (far - near), 1e-6);
  const out: HizLevel[] = [];
  let sourceWidth = width;
  let sourceHeight = height;
  let sourceAt = (x: number, y: number) => viewDepthOf(depth[y * width + x] ?? 1);
  for (let level = 0; level < levels; level++) {
    const size = hizLevelSize(width, height, level);
    const data = new Float32Array(size.width * size.height);
    for (let y = 0; y < size.height; y++) {
      for (let x = 0; x < size.width; x++) {
        let far = 0;
        for (let dy = 0; dy < 2; dy++) {
          for (let dx = 0; dx < 2; dx++) {
            const sx = Math.min(x * 2 + dx, Math.max(sourceWidth - 1, 0));
            const sy = Math.min(y * 2 + dy, Math.max(sourceHeight - 1, 0));
            far = Math.max(far, sourceAt(sx, sy));
          }
        }
        data[y * size.width + x] = far;
      }
    }
    out.push({ data, width: size.width, height: size.height });
    const previous = data;
    const previousWidth = size.width;
    sourceAt = (x: number, y: number) => previous[y * previousWidth + x] ?? 0;
    sourceWidth = size.width;
    sourceHeight = size.height;
  }
  return out;
}

/**
 * The cull pass, in TypeScript — the same three tests, in the same order, with the same margins, and
 * the executable specification the WGSL in {@link OBJECT_CULL_SHADER} transcribes. It is what the mock
 * device runs: a mock records and validates compute passes but executes no WGSL, so without a twin a
 * frame on the mock would be drawn with whatever the last buffer held.
 *
 * `bounds` holds 8 floats per batch (`min.xyz`, the batch's distance limit, `max.xyz`, and the count),
 * the layout the renderer uploads and `ObjectBatchEntry` describes; `visibility` is written for every
 * tested batch (so a re-used buffer cannot keep an old word). `hiz` is a pyramid {@link buildHizOnCpu}
 * built — the CPU has no depth of its own, which is why `RendererOptions.objectCulling: "cpu"` runs
 * the first two tests only. `out` is where the two frame-level products go (Phase 13.6): the indirect
 * records' instance counts and the compaction list, in test order.
 */
export function cullBatchesOnCpu(
  bounds: Float32Array,
  batchCount: number,
  params: ObjectCullParams,
  visibility: Uint32Array,
  hiz: readonly HizLevel[] = [],
  out: ObjectCullOutputs = {},
): ObjectCullStats {
  const stats: ObjectCullStats = { tested: 0, culledFrustum: 0, culledDistance: 0, culledOccluded: 0, visible: 0, recordZeroed: 0, lodReduced: 0 };
  const planes = cullPlanesFrom(params.viewProj);
  const total = Math.min(batchCount, MAX_CULLED_BATCHES);
  const view = params.view;
  const proj = params.proj;
  const occlusion = (params.flags & CULL_FLAG_OCCLUSION) !== 0 && params.hizLevels > 0 && hiz.length > 0;
  const records = (params.flags & CULL_FLAG_RECORDS) !== 0 ? out.records : undefined;
  const visibleList = out.visible;
  // Phase 14.4: the twin writes the same two extra record words the device writes, from the same
  // rule, so the mock arm and the real arm draw the same level at the same distance.
  const lodTable = (params.flags & CULL_FLAG_LOD) !== 0 && records ? params.lods ?? null : null;
  for (let index = 0; index < total; index++) {
    stats.tested++;
    visibility[index] = CullReason.Visible;
    const base = index * 8;
    const cx = (bounds[base]! + bounds[base + 4]!) * 0.5;
    const cy = (bounds[base + 1]! + bounds[base + 5]!) * 0.5;
    const cz = (bounds[base + 2]! + bounds[base + 6]!) * 0.5;
    const radius = Math.hypot(bounds[base + 4]! - cx, bounds[base + 5]! - cy, bounds[base + 6]! - cz) + CULL_SLOP;
    // The level distance is measured the way the device measures it (f32 bounds, f32 camera, f32
    // root): a threshold has no slop, so an f64 distance here would hand a batch on a threshold a
    // different level than `selectLod` gives it. See lodDistanceF32. The distance verdict below uses
    // the same number for the same reason.
    const awayF32 = lodDistanceF32(
      bounds[base]!,
      bounds[base + 1]!,
      bounds[base + 2]!,
      bounds[base + 4]!,
      bounds[base + 5]!,
      bounds[base + 6]!,
      params.cameraPos.x,
      params.cameraPos.y,
      params.cameraPos.z,
    );
    const lod = lodWindowFor(lodTable, index, awayF32);

    if ((params.flags & CULL_FLAG_FRUSTUM) !== 0) {
      let outside = false;
      for (let row = 0; row < 6; row++) {
        const nx = planes[row * 4]!;
        const ny = planes[row * 4 + 1]!;
        const nz = planes[row * 4 + 2]!;
        const d = planes[row * 4 + 3]!;
        if (nx * cx + ny * cy + nz * cz + d < -Math.hypot(nx, ny, nz) * radius) outside = true;
      }
      if (outside) {
        visibility[index] = CullReason.Frustum;
        stats.culledFrustum++;
        skipRecord(records, index, stats);
        continue;
      }
    }

    const limit = bounds[base + 3] ?? 0;
    if ((params.flags & CULL_FLAG_DISTANCE) !== 0 && limit > 0) {
      // The same measurement the device makes (`distance(center, cull.cameraPos)` in f32) and the same
      // one the level selection above uses: `away - radius > limit` has no slop of its own, so an f64
      // distance here would keep a batch the pass rejects — or reject one it keeps — whenever a batch
      // sits within an ulp of its limit.
      const away = awayF32;
      if (away - radius > limit) {
        visibility[index] = CullReason.Distance;
        stats.culledDistance++;
        skipRecord(records, index, stats);
        continue;
      }
    }

    if (!occlusion) {
      keepRecord(records, visibleList, index, bounds[base + 7] ?? 0, lod, stats);
      continue;
    }
    const vx = view[0]! * cx + view[4]! * cy + view[8]! * cz + view[12]!;
    const vy = view[1]! * cx + view[5]! * cy + view[9]! * cz + view[13]!;
    const vz = view[2]! * cx + view[6]! * cy + view[10]! * cz + view[14]!;
    const nearest = vz - radius;
    if (nearest <= params.near) {
      keepRecord(records, visibleList, index, bounds[base + 7] ?? 0, lod, stats);
      continue;
    }

    let loX = Infinity;
    let loY = Infinity;
    let hiX = -Infinity;
    let hiY = -Infinity;
    for (let corner = 0; corner < 8; corner++) {
      const px = vx + ((corner & 1) !== 0 ? radius : -radius);
      const py = vy + ((corner & 2) !== 0 ? radius : -radius);
      const pz = vz + ((corner & 4) !== 0 ? radius : -radius);
      const sx = (0.5 + (0.5 * proj[0]! * px) / pz) * params.width;
      // Texel row 0 is the top of the image: NDC +y points up, the row index does not.
      const sy = (0.5 - (0.5 * proj[5]! * py) / pz) * params.height;
      loX = Math.min(loX, sx);
      loY = Math.min(loY, sy);
      hiX = Math.max(hiX, sx);
      hiY = Math.max(hiY, sy);
    }
    const rectMinX = loX - CULL_PAD_PIXELS;
    const rectMinY = loY - CULL_PAD_PIXELS;
    const rectMaxX = hiX + CULL_PAD_PIXELS;
    const rectMaxY = hiY + CULL_PAD_PIXELS;
    if (rectMaxX < 0 || rectMaxY < 0 || rectMinX > params.width || rectMinY > params.height) {
      visibility[index] = CullReason.Frustum;
      stats.culledFrustum++;
      skipRecord(records, index, stats);
      continue;
    }

    const span = Math.max(rectMaxX - rectMinX, rectMaxY - rectMinY);
    let level = 0;
    if (span > 4) level = Math.ceil(Math.log2(span)) - 2;
    level = Math.max(0, Math.min(level, params.hizLevels - 1, hiz.length - 1));
    const texels = 1 << (level + 1);
    const levelHiz = hiz[level]!;
    const lastX = Math.max(levelHiz.width - 1, 0);
    const lastY = Math.max(levelHiz.height - 1, 0);
    const firstX = Math.min(Math.floor(Math.max(rectMinX, 0) / texels), lastX);
    const firstY = Math.min(Math.floor(Math.max(rectMinY, 0) / texels), lastY);
    const endX = Math.min(Math.floor(Math.max(rectMaxX, 0) / texels), lastX);
    const endY = Math.min(Math.floor(Math.max(rectMaxY, 0) / texels), lastY);
    const bound = nearest - CULL_EPSILON;
    let occluded = true;
    for (let ty = firstY; ty <= endY; ty++) {
      for (let tx = firstX; tx <= endX; tx++) {
        if ((levelHiz.data[ty * levelHiz.width + tx] ?? 0) >= bound) occluded = false;
      }
    }
    if (occluded) {
      visibility[index] = CullReason.Occluded;
      stats.culledOccluded++;
      skipRecord(records, index, stats);
      continue;
    }
    keepRecord(records, visibleList, index, bounds[base + 7] ?? 0, lod, stats);
  }
  return stats;
}

/**
 * The record window one batch's distance selects (Phase 14.4), or `null` when the batch has no LOD
 * chain — then the CPU-uploaded window (level 0) stands, exactly as on the device. The distance is
 * measured to the batch bounds' centre, the same centre the frustum and occlusion tests use.
 */
function lodWindowFor(table: ObjectLodTable | null, index: number, distance: number): ObjectLodLevelCpu | null {
  if (!table) return null;
  const setId = table.batchSets[index] ?? LOD_SET_NONE;
  if (setId >= table.sets.length) return null;
  const set = table.sets[setId]!;
  const level = selectLodLevel(set.levels, distance);
  return set.levels[level] ?? null;
}

/** A batch that stays visible: its compaction slot, its record's instance count, and its LOD window. */
function keepRecord(
  records: Uint32Array | undefined,
  visibleList: Uint32Array | undefined,
  index: number,
  instances: number,
  lod: ObjectLodLevelCpu | null,
  stats: ObjectCullStats,
): void {
  stats.visible++;
  if (visibleList && stats.visible <= visibleList.length) visibleList[stats.visible - 1] = index;
  if (!records) return;
  const word = index * DRAW_RECORD_WORDS;
  records[word + DRAW_RECORD_INSTANCES] = instances;
  if (!lod) return;
  records[word + DRAW_RECORD_INDEX_COUNT] = lod.indexCount;
  records[word + DRAW_RECORD_FIRST_INDEX] = lod.firstIndex;
  if (lod.minDistance > 0) stats.lodReduced++;
}

/** A culled batch: its record's instance count goes to zero, and the pass counts that. */
function skipRecord(records: Uint32Array | undefined, index: number, stats: ObjectCullStats): void {
  if (!records) return;
  records[index * DRAW_RECORD_WORDS + DRAW_RECORD_INSTANCES] = 0;
  stats.recordZeroed++;
}

// ------------------------------------------------------------------ the device side

/** One frame's inputs to the device path (the renderer has all of them already). */
export interface ObjectCullFrame {
  view: Mat4;
  projection: Mat4;
  viewProj: Mat4;
  cameraPos: { x: number; y: number; z: number };
  near: number;
  far: number;
  /** Depth target extent in pixels (the render scale, not the swapchain). */
  width: number;
  height: number;
  /** Run the HiZ test; the caller decides (perspective camera, pyramid buildable at this size). */
  occlude: boolean;
  /** Write the frame's indirect draw records (`CULL_FLAG_RECORDS`); the caller owns that switch. */
  records: boolean;
  /**
   * Select each batch's LOD level on the device (Phase 14.4). Ignored unless `records` is on: the
   * level *is* two words of the record. `revision` lets the static table stay put between frames —
   * only the per-batch indices are re-uploaded every frame.
   */
  lods?: ObjectLodFrame | null;
}

/** The frame's LOD inputs, in the shape the device path needs them. */
export interface ObjectLodFrame {
  /** One set index per batch ({@link LOD_SET_NONE} for a batch without a chain); at least `batchCount` long. */
  batchSets: Uint32Array;
  /** The static table: one set per distinct chained geometry, in set-index order. */
  sets: readonly ObjectLodSetCpu[];
  /** Bumped whenever `sets` changes; the table's bytes are rewritten only then. */
  revision: number;
}

/**
 * The device half of Phase 13.5: the pyramid passes, `forge.objects.cull`, the buffers they read, and
 * the one-frame-lagged read-back of their counters. Owned by `Renderer`, created on first use,
 * released by {@link dispose}.
 *
 * The renderer keeps what it already owns — the batch bounds (it builds the batches) and the
 * visibility buffer (the draw group binds it) — and passes both in; this class owns the pipelines,
 * the pyramid, the cull block and the stats path.
 */
export class GpuObjectCuller {
  private readonly cullBytes = new WriteBuffer(ObjectCullUniforms.byteSize("uniform"));
  private readonly cullAccessor = new StructAccessor(ObjectCullUniforms, this.cullBytes, 0, "uniform");
  private readonly boundsBytes = new WriteBuffer(ObjectBatchBlock.byteSize("storage"));
  private readonly statsBytes = new WriteBuffer(CULL_STATS_BYTES);

  private cullBufferRef: GPUBuffer | null = null;
  private boundsBuffer: GPUBuffer | null = null;
  private statsBuffer: GPUBuffer | null = null;
  /** Phase 14.4: one set index per batch (grows with the batch count) and the static chain table. */
  private batchLodBuffer: GPUBuffer | null = null;
  private batchLodCapacity = 0;
  private lodTableBuffer: GPUBuffer | null = null;
  private readonly lodTableBytes = new WriteBuffer(LOD_TABLE_BYTES);
  /** The revision the table buffer currently holds; -1 forces the first upload. */
  private lodTableRevision = -1;
  private readonly readbacks: (GPUBuffer | null)[] = [null, null];
  private readonly readbackBusy = [false, false];
  private readonly readbackFresh = [false, false];
  private readbackTurn = 1;
  private lastStats: ObjectCullStats = { tested: 0, culledFrustum: 0, culledDistance: 0, culledOccluded: 0, visible: 0, recordZeroed: 0, lodReduced: 0 };

  private hiz: GPUTexture | null = null;
  /** Levels of the pyramid *this* frame tests against: 0 unless `prepare` decided to occlude. */
  private hizLevelsFrame = 0;
  private hizWidth = 0;
  private hizHeight = 0;
  private hizLevels = 0;
  private readonly hizViews: (GPUTextureView | undefined)[] = [];
  private fallback: GPUTexture | null = null;
  private depthGroups = new Map<GPUTextureView, GPUBindGroup>();
  private groupVisibility: GPUBuffer | null = null;
  private groupRecords: GPUBuffer | null = null;
  private groupVisible: GPUBuffer | null = null;
  private groupBatchLods: GPUBuffer | null = null;
  private groupLodTable: GPUBuffer | null = null;

  private batchCount = 0;
  private readonly pipelines = new Map<string, GPUComputePipeline>();
  private readonly groups = new Map<string, GPUBindGroup>();
  private disposed = false;

  constructor(
    private readonly device: GraphicsDevice,
    private readonly shaders: ShaderCache,
  ) {}

  /** The counters the last read-back frame reported: zero until a frame has come back. */
  get stats(): ObjectCullStats {
    return this.lastStats;
  }

  /**
   * Stage and upload the frame's batch bounds (8 floats per batch: `min.xyz`, the batch's distance
   * limit, `max.xyz`, pad), zero the counters and write the cull block. Called before the graph is
   * built, so the passes and the buffers agree about how many batches exist.
   */
  prepare(bounds: Float32Array, batchCount: number, frame: ObjectCullFrame): void {
    if (this.disposed) return;
    const d = this.device.device;
    const total = Math.min(batchCount, MAX_CULLED_BATCHES);
    this.batchCount = total;
    if (!this.boundsBuffer) {
      this.boundsBuffer = d.createBuffer({
        label: "objects.bounds",
        size: this.boundsBytes.byteLength,
        usage: BufferUsage.STORAGE | BufferUsage.COPY_DST,
      });
    }
    if (total > 0) {
      this.boundsBytes.f32.set(bounds.subarray(0, total * 8));
      d.queue.writeBuffer(this.boundsBuffer, 0, gpuSource(this.boundsBytes.bytes.subarray(0, total * 8 * 4)));
    }

    // Whether this frame occludes at all: the pyramid texture stays allocated between frames, but a
    // frame the renderer did not ask to occlude must neither read the depth nor report levels — the
    // depth it would read is produced by a prepass that frame may not have run.
    const occlusion = frame.occlude && this.ensurePyramid(frame.width, frame.height) > 0;
    this.hizLevelsFrame = occlusion ? this.hizLevels : 0;
    let distance = false;
    for (let i = 0; i < total; i++) if (bounds[i * 8 + 3]! > 0) distance = true;
    // Phase 14.4: the device selects levels only where it can write them — into a record. The table
    // is static per geometry (rewritten when its revision moves), the per-batch indices are not.
    const lods = frame.records && total > 0 ? frame.lods ?? null : null;
    const lodSets = lods && lods.sets.length > 0 && lods.sets.length <= MAX_LOD_SETS ? lods.sets.length : 0;
    if (lodSets > 0) this.uploadLods(lods!, total, lodSets);
    const a = this.cullAccessor;
    a.setMat4("view", frame.view.m);
    a.setMat4("proj", frame.projection.m);
    a.setMat4("viewProj", frame.viewProj.m);
    a.setVec3("cameraPos", frame.cameraPos.x, frame.cameraPos.y, frame.cameraPos.z);
    a.setF32("near", frame.near);
    a.setF32("far", frame.far);
    a.setVec2("extent", frame.width, frame.height);
    a.setU32("batchCount", total);
    a.setU32(
      "flags",
      CULL_FLAG_FRUSTUM |
        (distance ? CULL_FLAG_DISTANCE : 0) |
        (occlusion ? CULL_FLAG_OCCLUSION : 0) |
        (frame.records ? CULL_FLAG_RECORDS : 0) |
        (lodSets > 0 ? CULL_FLAG_LOD : 0),
    );
    a.setU32("hizLevels", this.hizLevelsFrame);
    a.setU32("lodSetCount", lodSets);
    this.ensureStaticBuffers();
    d.queue.writeBuffer(this.cullBufferRef!, 0, gpuSource(this.cullBytes.bytes));
    // The counters are `atomicAdd`ed by the pass, so they are zeroed here: a workgroup cannot
    // reliably zero a buffer other workgroups are adding to.
    this.statsBytes.u32.fill(0);
    d.queue.writeBuffer(this.statsBuffer!, 0, gpuSource(this.statsBytes.bytes));
  }

  /**
   * Stage the frame's per-batch LOD set indices, and the static chain table when its revision moved
   * (Phase 14.4). The indices are one `u32` per batch — the whole per-frame cost of device LOD
   * selection — while the table's bytes are rewritten only when a new chained geometry arrives.
   */
  private uploadLods(lods: ObjectLodFrame, total: number, setCount: number): void {
    const d = this.device.device;
    if (!this.batchLodBuffer || this.batchLodCapacity < total) {
      this.batchLodBuffer?.destroy();
      this.batchLodCapacity = Math.max(total, 256);
      this.batchLodBuffer = d.createBuffer({
        label: "objects.batchLods",
        size: this.batchLodCapacity * 4,
        usage: BufferUsage.STORAGE | BufferUsage.COPY_DST,
      });
    }
    d.queue.writeBuffer(this.batchLodBuffer, 0, gpuSource(lods.batchSets.subarray(0, total)));

    if (!this.lodTableBuffer) {
      this.lodTableBuffer = d.createBuffer({ label: "objects.lodSets", size: LOD_TABLE_BYTES, usage: BufferUsage.STORAGE | BufferUsage.COPY_DST });
      this.lodTableRevision = -1;
    }
    if (this.lodTableRevision === lods.revision) return;
    const words = this.lodTableBytes.u32;
    const floats = this.lodTableBytes.f32;
    words.fill(0);
    words[ObjectLodSetBlock.offsetOf("count", "storage") >> 2] = setCount;
    const setStride = ObjectLodSet.size("storage");
    const levelStride = ObjectLodLevel.size("storage");
    for (let s = 0; s < setCount; s++) {
      const set = lods.sets[s]!;
      const at = LOD_SETS_FIELD.offset + s * setStride;
      const levels = Math.min(set.levels.length, MAX_BATCH_LODS);
      words[(at + LOD_SET_LEVELS_FIELD.offset) >> 2] = levels;
      for (let i = 0; i < levels; i++) {
        const level = set.levels[i]!;
        const levelAt = at + LOD_SET_LODS_FIELD.offset + i * levelStride;
        words[(levelAt + LOD_LEVEL_FIRST_INDEX_FIELD.offset) >> 2] = level.firstIndex;
        words[(levelAt + LOD_LEVEL_INDEX_COUNT_FIELD.offset) >> 2] = level.indexCount;
        floats[(levelAt + LOD_LEVEL_MIN_DISTANCE_FIELD.offset) >> 2] = level.minDistance;
      }
    }
    d.queue.writeBuffer(this.lodTableBuffer, 0, gpuSource(this.lodTableBytes.bytes));
    this.lodTableRevision = lods.revision;
  }

  /**
   * Add the pyramid passes and `forge.objects.cull` to the frame. `depth` is the depth target
   * `forge.prepass` has just written; `visibility` is the buffer the draw group also binds, and
   * `records`/`visible` are the frame's indirect draw records and its compaction list (Phase 13.6),
   * both renderer-owned the way the visibility words are. The read-back copy is encoded in the same
   * pass, so it lands after the dispatch that filled it.
   */
  record(graph: RenderGraph, depth: RenderGraphHandle, visibility: GPUBuffer, records: GPUBuffer, visible: GPUBuffer): void {
    if (this.disposed || this.batchCount === 0) return;
    const levels = this.batchCount > 0 ? this.hizLevelsFrame : 0;
    if (levels > 0) {
      graph.addPass({
        name: "forge.hiz.0",
        reads: [depth],
        sideEffect: true,
        execute: (ctx) => this.encodeHizDepth(ctx, depth),
      });
      for (let level = 1; level < levels; level++) {
        graph.addPass({
          name: `forge.hiz.${level}`,
          sideEffect: true,
          execute: (ctx) => this.encodeHizReduce(ctx, level),
        });
      }
    }
    const readback = this.pickReadback();
    graph.addPass({
      name: "forge.objects.cull",
      sideEffect: true,
      execute: (ctx) => this.encodeCull(ctx, visibility, records, visible, readback),
    });
  }

  /** Map this frame's counters back. Call once per frame, after the graph has executed. */
  poll(): void {
    if (this.disposed) return;
    const index = this.readbackTurn;
    const buffer = this.readbacks[index];
    if (!buffer || !this.readbackFresh[index] || this.readbackBusy[index]) return;
    this.readbackFresh[index] = false;
    this.readbackBusy[index] = true;
    buffer
      .mapAsync(BufferUsage.MAP_READ)
      .then(() => this.consume(index, buffer))
      .catch(() => {
        // A device lost mid-map is the device's story to tell, not a culling failure.
        this.readbackBusy[index] = false;
      });
  }

  /** Drop bind groups that reference graph-owned views (a pool change retires them). */
  invalidate(): void {
    this.groups.clear();
    this.depthGroups = new Map();
    this.groupVisibility = null;
    this.groupRecords = null;
    this.groupVisible = null;
    this.groupBatchLods = null;
    this.groupLodTable = null;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cullBufferRef?.destroy();
    this.cullBufferRef = null;
    this.boundsBuffer?.destroy();
    this.boundsBuffer = null;
    this.statsBuffer?.destroy();
    this.statsBuffer = null;
    this.batchLodBuffer?.destroy();
    this.batchLodBuffer = null;
    this.batchLodCapacity = 0;
    this.lodTableBuffer?.destroy();
    this.lodTableBuffer = null;
    this.lodTableRevision = -1;
    for (let i = 0; i < this.readbacks.length; i++) {
      this.readbacks[i]?.destroy();
      this.readbacks[i] = null;
      this.readbackBusy[i] = false;
      this.readbackFresh[i] = false;
    }
    this.hiz?.destroy();
    this.hiz = null;
    this.fallback?.destroy();
    this.fallback = null;
    this.hizLevels = 0;
    this.hizLevelsFrame = 0;
    this.hizViews.length = 0;
    this.pipelines.clear();
    this.groups.clear();
    this.depthGroups.clear();
    this.groupVisibility = null;
    this.groupRecords = null;
    this.groupVisible = null;
    this.groupBatchLods = null;
    this.groupLodTable = null;
  }

  private consume(index: number, buffer: GPUBuffer): void {
    // `dispose` destroys the readback pair, and a map that was already in flight still resolves
    // afterwards: mapping a destroyed buffer is a validation error, which a real device reports as an
    // uncaptured error at teardown. The counters it held belonged to a frame nobody will read.
    if (this.disposed) return;
    const words = new Uint32Array(buffer.getMappedRange(0, CULL_STATS_BYTES), 0, CULL_STATS_BYTES >> 2);
    this.lastStats = {
      tested: words[STATS_WORD.tested]!,
      culledFrustum: words[STATS_WORD.culledFrustum]!,
      culledDistance: words[STATS_WORD.culledDistance]!,
      culledOccluded: words[STATS_WORD.culledOccluded]!,
      visible: words[STATS_WORD.visible]!,
      recordZeroed: words[STATS_WORD.recordZeroed]!,
      lodReduced: words[STATS_WORD.lodReduced]!,
    };
    buffer.unmap();
    this.readbackBusy[index] = false;
  }

  /** The map-read buffer this frame's copy goes into, or null while both are still in flight. */
  private pickReadback(): GPUBuffer | null {
    this.readbackTurn = this.readbackTurn === 0 ? 1 : 0;
    const index = this.readbackTurn;
    if (this.readbackBusy[index]) return null;
    this.readbacks[index] ??= this.device.device.createBuffer({
      label: `objects.cull.stats.${index}`,
      size: CULL_STATS_BYTES,
      usage: BufferUsage.MAP_READ | BufferUsage.COPY_DST,
    });
    this.readbackFresh[index] = true;
    return this.readbacks[index]!;
  }

  private ensureStaticBuffers(): void {
    const d = this.device.device;
    this.cullBufferRef ??= d.createBuffer({
      label: "objects.cull.uniforms",
      size: this.cullBytes.byteLength,
      usage: BufferUsage.UNIFORM | BufferUsage.COPY_DST,
    });
    this.statsBuffer ??= d.createBuffer({
      label: "objects.cull.stats",
      size: CULL_STATS_BYTES,
      usage: BufferUsage.STORAGE | BufferUsage.COPY_SRC | BufferUsage.COPY_DST,
    });
  }

  /**
   * The depth pyramid, recreated when the render target's size changes (a resize, not a frame).
   * `r32float` because these values are compared, not sampled: a half-float would round a texel's
   * depth toward the camera about half the time, which is the direction that culls something visible.
   */
  private ensurePyramid(width: number, height: number): number {
    const levels = hizLevelCount(width, height);
    if (this.hiz && this.hizWidth === width && this.hizHeight === height && this.hizLevels === levels) return levels;
    this.hiz?.destroy();
    this.hiz = null;
    this.hizViews.fill(undefined);
    this.groups.clear();
    this.hizLevels = levels;
    if (levels === 0) return 0;
    const base = hizLevelSize(width, height, 0);
    this.hiz = this.device.createTexture({
      label: "objects.hiz",
      size: { width: base.width, height: base.height, depthOrArrayLayers: 1 },
      format: "r32float",
      mipLevelCount: levels,
      usage: TextureUsage.STORAGE_BINDING | TextureUsage.TEXTURE_BINDING,
    });
    this.hizWidth = width;
    this.hizHeight = height;
    return levels;
  }

  private hizView(level: number, count = 1): GPUTextureView {
    const key = level * 8 + count;
    let view = this.hizViews[key];
    if (!view) {
      view = this.hiz!.createView({ label: `objects.hiz.mip${level}`, baseMipLevel: level, mipLevelCount: count });
      this.hizViews[key] = view;
    }
    return view;
  }

  /**
   * Bound as the pyramid when no levels exist (a target too small to reduce, or occlusion off): the
   * shader never loads it — `hizLevels` is 0 — but a bind group layout has no optional slots and the
   * texture has to outlive the group.
   */
  private fallbackView(): GPUTextureView {
    this.fallback ??= this.device.createTexture({
      label: "objects.hiz.fallback",
      size: { width: 1, height: 1, depthOrArrayLayers: 1 },
      format: "r32float",
      usage: TextureUsage.TEXTURE_BINDING,
    });
    return this.fallback.createView();
  }

  /**
   * The two LOD bindings (Phase 14.4), created on first use and zeroed: a frame whose batches have
   * no chains binds them anyway (a bind group layout has no optional slots) and never reads them —
   * `cull.lodSetCount` is 0, so the selection branch does not run.
   */
  private ensureLodBuffers(): GPUBuffer {
    const d = this.device.device;
    if (!this.batchLodBuffer) {
      this.batchLodCapacity = Math.max(this.batchCount, 256);
      this.batchLodBuffer = d.createBuffer({
        label: "objects.batchLods",
        size: this.batchLodCapacity * 4,
        usage: BufferUsage.STORAGE | BufferUsage.COPY_DST,
      });
      // Zero reads as set 0, so an inactive frame must also say "no sets": `lodSetCount` does.
      d.queue.writeBuffer(this.batchLodBuffer, 0, gpuSource(new Uint32Array(this.batchLodCapacity)));
    }
    if (!this.lodTableBuffer) {
      this.lodTableBuffer = d.createBuffer({ label: "objects.lodSets", size: LOD_TABLE_BYTES, usage: BufferUsage.STORAGE | BufferUsage.COPY_DST });
      this.lodTableRevision = -1;
      d.queue.writeBuffer(this.lodTableBuffer, 0, gpuSource(new Uint32Array(LOD_TABLE_BYTES >> 2)));
    }
    return this.batchLodBuffer;
  }

  private computePipeline(name: string, source: string, entryPoint: string, entries: GPUBindGroupLayoutEntry[]): GPUComputePipeline {
    let pipeline = this.pipelines.get(name);
    if (pipeline) return pipeline;
    const d = this.device.device;
    pipeline = d.createComputePipeline({
      label: name,
      layout: d.createPipelineLayout({
        label: name,
        bindGroupLayouts: [d.createBindGroupLayout({ label: name, entries })],
      }),
      compute: { module: this.shaders.get(name, source), entryPoint },
    });
    this.pipelines.set(name, pipeline);
    return pipeline;
  }

  private encodeHizDepth(ctx: RenderGraphPassContext, depth: RenderGraphHandle): void {
    const pipeline = this.computePipeline("hiz.depth", HIZ_DEPTH_SHADER, "csHizDepth", HIZ_DEPTH_ENTRIES);
    // The depth is a graph texture, so its view changes with the pool: the group is cached against
    // the view it was built from and dropped when the pool hands out a different one.
    const depthView = ctx.view(depth);
    let group = this.depthGroups.get(depthView);
    if (!group) {
      group = this.device.device.createBindGroup({
        label: "hiz.depth",
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this.cullBufferRef! } },
          { binding: 1, resource: depthView },
          { binding: 2, resource: this.hizView(0) },
        ],
      });
      this.depthGroups = new Map([[depthView, group]]);
    }
    const size = hizLevelSize(this.hizWidth, this.hizHeight, 0);
    const pass = ctx.beginComputePass("hiz.depth");
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, group);
    pass.dispatchWorkgroups(Math.ceil(size.width / HIZ_WORKGROUP), Math.ceil(size.height / HIZ_WORKGROUP));
    pass.end();
  }

  private encodeHizReduce(ctx: RenderGraphPassContext, level: number): void {
    const pipeline = this.computePipeline("hiz.reduce", HIZ_REDUCE_SHADER, "csHizReduce", HIZ_REDUCE_ENTRIES);
    const key = `hiz.reduce.${level}`;
    let group = this.groups.get(key);
    if (!group) {
      group = this.device.device.createBindGroup({
        label: key,
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: this.hizView(level - 1) },
          { binding: 1, resource: this.hizView(level) },
        ],
      });
      this.groups.set(key, group);
    }
    const size = hizLevelSize(this.hizWidth, this.hizHeight, level);
    const pass = ctx.beginComputePass(key);
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, group);
    pass.dispatchWorkgroups(Math.ceil(size.width / HIZ_WORKGROUP), Math.ceil(size.height / HIZ_WORKGROUP));
    pass.end();
  }

  private encodeCull(
    ctx: RenderGraphPassContext,
    visibility: GPUBuffer,
    records: GPUBuffer,
    visible: GPUBuffer,
    readback: GPUBuffer | null,
  ): void {
    const pipeline = this.computePipeline("objects.cull", OBJECT_CULL_SHADER, "csCull", CULL_ENTRIES);
    let group = this.groups.get("objects.cull");
    // Three of the entries are renderer-owned buffers that grow (or are re-created) with the frame,
    // and two more are this class's own LOD buffers (Phase 14.4), created on first use and grown
    // with the batch count: the group is cached against all five, so a growth retires it instead of
    // binding a stale one.
    const batchLods = this.ensureLodBuffers();
    if (
      !group ||
      this.groupVisibility !== visibility ||
      this.groupRecords !== records ||
      this.groupVisible !== visible ||
      this.groupBatchLods !== batchLods ||
      this.groupLodTable !== this.lodTableBuffer
    ) {
      group = this.device.device.createBindGroup({
        label: "objects.cull",
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this.cullBufferRef! } },
          { binding: 1, resource: { buffer: this.boundsBuffer! } },
          { binding: 2, resource: { buffer: visibility } },
          { binding: 3, resource: { buffer: this.statsBuffer! } },
          { binding: 4, resource: this.hiz ? this.hizView(0, this.hizLevels) : this.fallbackView() },
          { binding: 5, resource: { buffer: records } },
          { binding: 6, resource: { buffer: visible } },
          { binding: 7, resource: { buffer: batchLods } },
          { binding: 8, resource: { buffer: this.lodTableBuffer! } },
        ],
      });
      this.groups.set("objects.cull", group);
      this.groupVisibility = visibility;
      this.groupRecords = records;
      this.groupVisible = visible;
      this.groupBatchLods = batchLods;
      this.groupLodTable = this.lodTableBuffer;
    }
    const pass = ctx.beginComputePass("objects.cull");
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, group);
    pass.dispatchWorkgroups(Math.ceil(this.batchCount / CULL_WORKGROUP));
    pass.end();
    // Encoded in the same pass, so the copy lands after the dispatch that filled the counters.
    if (readback) ctx.encoder.copyBufferToBuffer(this.statsBuffer!, 0, readback, 0, CULL_STATS_BYTES);
  }
}

const HIZ_DEPTH_ENTRIES: GPUBindGroupLayoutEntry[] = [
  { binding: 0, visibility: ShaderStage.COMPUTE, buffer: { type: "uniform", minBindingSize: ObjectCullUniforms.byteSize("uniform") } },
  { binding: 1, visibility: ShaderStage.COMPUTE, texture: { sampleType: "depth", viewDimension: "2d", multisampled: false } },
  { binding: 2, visibility: ShaderStage.COMPUTE, storageTexture: { access: "write-only", format: "r32float", viewDimension: "2d" } },
];

const HIZ_REDUCE_ENTRIES: GPUBindGroupLayoutEntry[] = [
  { binding: 0, visibility: ShaderStage.COMPUTE, texture: { sampleType: "unfilterable-float", viewDimension: "2d", multisampled: false } },
  { binding: 1, visibility: ShaderStage.COMPUTE, storageTexture: { access: "write-only", format: "r32float", viewDimension: "2d" } },
];

const CULL_ENTRIES: GPUBindGroupLayoutEntry[] = [
  { binding: 0, visibility: ShaderStage.COMPUTE, buffer: { type: "uniform", minBindingSize: ObjectCullUniforms.byteSize("uniform") } },
  { binding: 1, visibility: ShaderStage.COMPUTE, buffer: { type: "read-only-storage", minBindingSize: ObjectBatchBlock.byteSize("storage") } },
  { binding: 2, visibility: ShaderStage.COMPUTE, buffer: { type: "storage", minBindingSize: 4 } },
  { binding: 3, visibility: ShaderStage.COMPUTE, buffer: { type: "storage", minBindingSize: CULL_STATS_BYTES } },
  { binding: 4, visibility: ShaderStage.COMPUTE, texture: { sampleType: "unfilterable-float", viewDimension: "2d", multisampled: false } },
  // The two frame-level products (Phase 13.6): the draw records the renderer submits and the
  // compaction list it keeps. Both are plain `u32` arrays written at an index the pass derives.
  { binding: 5, visibility: ShaderStage.COMPUTE, buffer: { type: "storage", minBindingSize: DRAW_RECORD_BYTES } },
  { binding: 6, visibility: ShaderStage.COMPUTE, buffer: { type: "storage", minBindingSize: MAX_CULLED_BATCHES * 4 } },
  // Phase 14.4: one LOD set index per batch, and the static chain table it addresses. Both are
  // read-only, and both are bound whether or not this frame has a chain — `cull.lodSetCount` is what
  // says the table is empty, so the selection branch never runs on a frame that has nothing to pick.
  { binding: 7, visibility: ShaderStage.COMPUTE, buffer: { type: "read-only-storage", minBindingSize: 4 } },
  { binding: 8, visibility: ShaderStage.COMPUTE, buffer: { type: "read-only-storage", minBindingSize: LOD_TABLE_BYTES } },
];
