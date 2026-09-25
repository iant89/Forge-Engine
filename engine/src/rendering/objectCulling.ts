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
import { MAX_CULLED_BATCHES, ObjectBatchBlock, ObjectBatchEntry, ObjectCullStatsBlock, ObjectCullUniforms } from "./uniforms.js";
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

@group(0) @binding(0) var<uniform> cull: ObjectCullUniforms;
@group(0) @binding(1) var<storage, read> batchBounds: ObjectBatchBlock;
@group(0) @binding(2) var<storage, read_write> visibility: array<u32>;
@group(0) @binding(3) var<storage, read_write> counts: ObjectCullStatsBlock;
@group(0) @binding(4) var hiz: texture_2d<f32>;
// The frame's indirect draw records (Phase 13.6), bound whether or not this frame writes them.
@group(0) @binding(5) var<storage, read_write> drawRecords: array<u32>;
// The compaction list: one slot per visible batch, filled at counts.visible's cursor.
@group(0) @binding(6) var<storage, read_write> visibleBatches: array<u32>;

const CULL_WORKGROUP: u32 = ${CULL_WORKGROUP}u;
const MAX_CULLED_BATCHES: u32 = ${MAX_CULLED_BATCHES}u;
const CULL_FLAG_FRUSTUM: u32 = ${CULL_FLAG_FRUSTUM}u;
const CULL_FLAG_DISTANCE: u32 = ${CULL_FLAG_DISTANCE}u;
const CULL_FLAG_OCCLUSION: u32 = ${CULL_FLAG_OCCLUSION}u;
const CULL_FLAG_RECORDS: u32 = ${CULL_FLAG_RECORDS}u;
const RECORD_WORDS: u32 = ${DRAW_RECORD_WORDS}u;
const RECORD_INSTANCES: u32 = ${DRAW_RECORD_INSTANCES}u;
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

// The three tests, as one verdict. Every branch that returns REASON_VISIBLE is a case the tests
// could not *prove* invisible — a conservative answer, never a wrong one.
fn cullReasonOf(box: ObjectBatchEntry) -> u32 {
  let center = (box.min.xyz + box.max.xyz) * 0.5;
  let radius = length(box.max.xyz - center) + CULL_SLOP;

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
  let reason = cullReasonOf(box);
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
    let word = index * RECORD_WORDS + RECORD_INSTANCES;
    if (kept) {
      drawRecords[word] = u32(box.max.w);
    } else {
      drawRecords[word] = 0u;
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
  const stats: ObjectCullStats = { tested: 0, culledFrustum: 0, culledDistance: 0, culledOccluded: 0, visible: 0, recordZeroed: 0 };
  const planes = cullPlanesFrom(params.viewProj);
  const total = Math.min(batchCount, MAX_CULLED_BATCHES);
  const view = params.view;
  const proj = params.proj;
  const occlusion = (params.flags & CULL_FLAG_OCCLUSION) !== 0 && params.hizLevels > 0 && hiz.length > 0;
  const records = (params.flags & CULL_FLAG_RECORDS) !== 0 ? out.records : undefined;
  const visibleList = out.visible;
  for (let index = 0; index < total; index++) {
    stats.tested++;
    visibility[index] = CullReason.Visible;
    const base = index * 8;
    const cx = (bounds[base]! + bounds[base + 4]!) * 0.5;
    const cy = (bounds[base + 1]! + bounds[base + 5]!) * 0.5;
    const cz = (bounds[base + 2]! + bounds[base + 6]!) * 0.5;
    const radius = Math.hypot(bounds[base + 4]! - cx, bounds[base + 5]! - cy, bounds[base + 6]! - cz) + CULL_SLOP;

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
      const away = Math.hypot(cx - params.cameraPos.x, cy - params.cameraPos.y, cz - params.cameraPos.z);
      if (away - radius > limit) {
        visibility[index] = CullReason.Distance;
        stats.culledDistance++;
        skipRecord(records, index, stats);
        continue;
      }
    }

    if (!occlusion) {
      keepRecord(records, visibleList, index, bounds[base + 7] ?? 0, stats);
      continue;
    }
    const vx = view[0]! * cx + view[4]! * cy + view[8]! * cz + view[12]!;
    const vy = view[1]! * cx + view[5]! * cy + view[9]! * cz + view[13]!;
    const vz = view[2]! * cx + view[6]! * cy + view[10]! * cz + view[14]!;
    const nearest = vz - radius;
    if (nearest <= params.near) {
      keepRecord(records, visibleList, index, bounds[base + 7] ?? 0, stats);
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
    keepRecord(records, visibleList, index, bounds[base + 7] ?? 0, stats);
  }
  return stats;
}

/** A batch that stays visible: its compaction slot, and its record's instance count. */
function keepRecord(
  records: Uint32Array | undefined,
  visibleList: Uint32Array | undefined,
  index: number,
  instances: number,
  stats: ObjectCullStats,
): void {
  stats.visible++;
  if (visibleList && stats.visible <= visibleList.length) visibleList[stats.visible - 1] = index;
  if (records) records[index * DRAW_RECORD_WORDS + DRAW_RECORD_INSTANCES] = instances;
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
  private readonly readbacks: (GPUBuffer | null)[] = [null, null];
  private readonly readbackBusy = [false, false];
  private readonly readbackFresh = [false, false];
  private readbackTurn = 1;
  private lastStats: ObjectCullStats = { tested: 0, culledFrustum: 0, culledDistance: 0, culledOccluded: 0, visible: 0, recordZeroed: 0 };

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
      CULL_FLAG_FRUSTUM | (distance ? CULL_FLAG_DISTANCE : 0) | (occlusion ? CULL_FLAG_OCCLUSION : 0) | (frame.records ? CULL_FLAG_RECORDS : 0),
    );
    a.setU32("hizLevels", this.hizLevelsFrame);
    this.ensureStaticBuffers();
    d.queue.writeBuffer(this.cullBufferRef!, 0, gpuSource(this.cullBytes.bytes));
    // The counters are `atomicAdd`ed by the pass, so they are zeroed here: a workgroup cannot
    // reliably zero a buffer other workgroups are adding to.
    this.statsBytes.u32.fill(0);
    d.queue.writeBuffer(this.statsBuffer!, 0, gpuSource(this.statsBytes.bytes));
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
  }

  private consume(index: number, buffer: GPUBuffer): void {
    const words = new Uint32Array(buffer.getMappedRange(0, CULL_STATS_BYTES), 0, CULL_STATS_BYTES >> 2);
    this.lastStats = {
      tested: words[STATS_WORD.tested]!,
      culledFrustum: words[STATS_WORD.culledFrustum]!,
      culledDistance: words[STATS_WORD.culledDistance]!,
      culledOccluded: words[STATS_WORD.culledOccluded]!,
      visible: words[STATS_WORD.visible]!,
      recordZeroed: words[STATS_WORD.recordZeroed]!,
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
    const pass = ctx.encoder.beginComputePass({ label: "hiz.depth" });
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
    const pass = ctx.encoder.beginComputePass({ label: key });
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
    // Three of the entries are renderer-owned buffers that grow (or are re-created) with the frame:
    // the group is cached against all three, so a growth retires it instead of binding a stale one.
    if (!group || this.groupVisibility !== visibility || this.groupRecords !== records || this.groupVisible !== visible) {
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
        ],
      });
      this.groups.set("objects.cull", group);
      this.groupVisibility = visibility;
      this.groupRecords = records;
      this.groupVisible = visible;
    }
    const pass = ctx.encoder.beginComputePass({ label: "objects.cull" });
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
];
