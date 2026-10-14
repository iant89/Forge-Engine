/**
 * Per-INSTANCE population culling, merged with the 14.4 LOD selection (docs/RENDERING.md §4g).
 * Placement is unchanged (CPU deterministic scatter); only *which* of a chunk's instances each pass
 * draws is decided here. Two dispatches per eligible batch per frame, one invocation per instance:
 *
 * **`forge.populationCull.views`** (`POPULATION_VIEW_CULL_SHADER`, before the shadow passes and the
 * prepass; reads only matrices, no depth):
 *
 *  - **Main view.** The record's *previous* bits decide distance (bit 1) and the camera frustum the
 *    rest; survivors are appended (`atomicAdd` on the batch's record A instance count) and copied with
 *    their previous bits into the batch's compacted buffer. `forge.prepass` draws exactly that list,
 *    and so does `forge.main` on a frame that does not occlude — one list, so the two always agree.
 *  - **Shadow maps.** For every bit in the batch's `shadowMask` the instance sphere is tested against
 *    that map's light frustum (the cascade, spot or point-face view-projection the shadow pass renders
 *    with — the cascade fit already backs the light eye off toward the sun, so an off-screen caster
 *    whose shadow falls into view is inside it). Survivors append their *index* (4 B, not an 80 B
 *    copy) to the map's range of the batch's shared shadow index buffer; the shadow pass draws that
 *    range indirectly through `DEPTH_CULLED_VERTEX`. Distance (bit 1) is ignored, as before: a far
 *    instance still casts.
 *
 * **`forge.populationCull`** (`POPULATION_CULL_SHADER`, after `forge.objects.cull`, so after the
 * prepass and the HiZ pyramid):
 *
 *  1. **LOD select + distance verdict, for the next frame.** It computes bit 0 (LOD window) and bit 1
 *     (past the batch's distance limit) from this frame's camera and writes both into the *source*
 *     record. Every depth reader (shadows, prepass) has already run this frame; they read the bits on
 *     the next one. That one-frame lag is what keeps the prepass and `forge.main` on the same bits.
 *  2. **HiZ, when the frame occludes.** Each entry of the main-view list is tested against this
 *     frame's pyramid (and skipped if the object culler culled the whole batch); survivors append to
 *     record B and a second compacted buffer, which `forge.main` draws. B is a subset of the list the
 *     prepass drew with identical bits, so no pixel loses its shading (an omitted instance is hidden
 *     behind depth that *is* shaded).
 *
 * Every tested instance lands in exactly one main-view counter: frustum/distance in the views pass,
 * batch/occluded/drawn in this one when the frame occludes (drawn in the views pass when it does not).
 *
 * Storage buffers per compute stage: views pass 6 (args, stats, source, list, occluded list, shadow
 * indices), cull pass 7 (+ visibility). WebGPU's guaranteed minimum is 8. Workgroup 64.
 *
 * CPU twins: `population/cull.ts` (`cullPopulationViewsOnCpu`, `cullPopulationOcclusionOnCpu`, and
 * the composed reference `cullPopulationInstancesOnCpu`); the mock device runs them in place of these
 * kernels.
 */
import { InstanceStruct, ObjectCullUniforms, PopulationCullStatsBlock, PopulationCullUniforms, PopulationViewUniforms } from "../uniforms.js";
import { CULL_FLAG_OCCLUSION, CULL_SLOP, CULL_SPHERE_WGSL } from "../objectCulling.js";

/** `PopulationCullUniforms.flags`: the batch is an LOD batch (bit 0 of the record is selected). */
export const POP_CULL_LOD = 1;
/** `PopulationCullUniforms.flags`: the batch has a distance limit (`maxDistance` > 0). */
export const POP_CULL_DISTANCE = 2;
/** `PopulationCullUniforms.flags`: the HiZ test runs this frame (the frame occludes and the tier allows it). */
export const POP_CULL_OCCLUSION = 4;
/** Instance-record `flags` bit 1: past the batch's distance limit as of the last cull. */
export const INSTANCE_FLAG_FAR = 2;
/** Invocations per workgroup: one instance each. */
export const POPULATION_CULL_WORKGROUP = 64;
/** Shadow index ranges are padded to this many slots so each range starts on a 256-byte offset. */
export const POPULATION_SHADOW_INDEX_ALIGN = 64;

const SHARED_SPHERE_WGSL = /* wgsl */ `
fn instanceModel(inst: InstanceData) -> mat4x4<f32> {
  return mat4x4<f32>(inst.row0, inst.row1, inst.row2, inst.row3);
}

fn instanceRadius(inst: InstanceData) -> f32 {
  let scale = max(length(inst.row0.xyz), max(length(inst.row1.xyz), length(inst.row2.xyz)));
  return pop.localRadius * scale + POP_SLOP;
}
`;

export const POPULATION_VIEW_CULL_SHADER = /* wgsl */ `
${PopulationViewUniforms.toWgsl("uniform")}
${PopulationCullUniforms.toWgsl("uniform")}
${PopulationCullStatsBlock.toWgsl("storage")}
${InstanceStruct.toWgsl("storage")}

@group(0) @binding(0) var<uniform> views: PopulationViewUniforms;
@group(0) @binding(1) var<uniform> pop: PopulationCullUniforms;
@group(0) @binding(2) var<storage, read_write> drawArgs: array<atomic<u32>>;
@group(0) @binding(3) var<storage, read_write> popCounts: PopulationCullStatsBlock;
@group(1) @binding(0) var<storage, read_write> instances: array<InstanceData>;
@group(1) @binding(1) var<storage, read_write> visibleInstances: array<InstanceData>;
@group(1) @binding(3) var<storage, read_write> shadowIndices: array<u32>;

const POP_CULL_OCCLUSION: u32 = ${POP_CULL_OCCLUSION}u;
const INSTANCE_FLAG_FAR: u32 = ${INSTANCE_FLAG_FAR}u;
const POP_SLOP: f32 = ${CULL_SLOP};
${SHARED_SPHERE_WGSL}

// Row-combination planes of a clip space with z in [0,1] (as Frustum.extractStandard), unnormalized;
// the test scales the radius by the row length instead.
fn outsideFrustum(m: mat4x4<f32>, c: vec3<f32>, r: f32) -> bool {
  let r0 = vec4<f32>(m[0][0], m[1][0], m[2][0], m[3][0]);
  let r1 = vec4<f32>(m[0][1], m[1][1], m[2][1], m[3][1]);
  let r2 = vec4<f32>(m[0][2], m[1][2], m[2][2], m[3][2]);
  let r3 = vec4<f32>(m[0][3], m[1][3], m[2][3], m[3][3]);
  let p = vec4<f32>(c, 1.0);
  var planes = array<vec4<f32>, 6>(r2, r3 - r2, r0 + r3, r3 - r0, r1 + r3, r3 - r1);
  for (var k = 0u; k < 6u; k = k + 1u) {
    let pl = planes[k];
    if (dot(pl, p) < -length(pl.xyz) * r) {
      return true;
    }
  }
  return false;
}

@workgroup_size(${POPULATION_CULL_WORKGROUP}) @compute
fn populationViewCullMain(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= pop.count) {
    return;
  }
  let inst = instances[i];
  let center = (instanceModel(inst) * vec4<f32>(pop.localCenter, 1.0)).xyz;
  let radius = instanceRadius(inst);

  // Main view: previous distance bit, then the camera frustum.
  if ((inst.flags & INSTANCE_FLAG_FAR) != 0u) {
    atomicAdd(&popCounts.culledDistance, 1u);
  } else if (outsideFrustum(views.main, center, radius)) {
    atomicAdd(&popCounts.culledFrustum, 1u);
  } else {
    let slot = atomicAdd(&drawArgs[pop.argsWord], 1u);
    if (slot < pop.count) {
      visibleInstances[slot] = inst;
    }
    if ((pop.flags & POP_CULL_OCCLUSION) == 0u) {
      atomicAdd(&popCounts.drawn, 1u);
    }
  }

  // Shadow maps: one index range per bit of the batch's mask, in bit order.
  var mask = pop.shadowMask;
  var local = 0u;
  loop {
    if (mask == 0u) {
      break;
    }
    let bit = firstTrailingBit(mask);
    mask = mask & (mask - 1u);
    atomicAdd(&popCounts.shadowTested, 1u);
    if (!outsideFrustum(views.shadow[bit], center, radius)) {
      let slot = atomicAdd(&drawArgs[pop.shadowArgsWord + local * 8u], 1u);
      if (slot < pop.count) {
        shadowIndices[local * pop.indexStride + slot] = i;
      }
      atomicAdd(&popCounts.shadowDrawn, 1u);
    }
    local = local + 1u;
  }
}
`;

export const POPULATION_CULL_SHADER = /* wgsl */ `
${ObjectCullUniforms.toWgsl("uniform")}
${PopulationCullUniforms.toWgsl("uniform")}
${PopulationCullStatsBlock.toWgsl("storage")}
${InstanceStruct.toWgsl("storage")}

@group(0) @binding(0) var<uniform> cull: ObjectCullUniforms;
@group(0) @binding(1) var<uniform> pop: PopulationCullUniforms;
@group(0) @binding(2) var<storage, read_write> drawArgs: array<atomic<u32>>;
@group(0) @binding(3) var<storage, read_write> popCounts: PopulationCullStatsBlock;
@group(0) @binding(4) var<storage, read> visibility: array<u32>;
@group(0) @binding(5) var hiz: texture_2d<f32>;
@group(1) @binding(0) var<storage, read_write> instances: array<InstanceData>;
@group(1) @binding(1) var<storage, read_write> visibleInstances: array<InstanceData>;
@group(1) @binding(2) var<storage, read_write> occludedSurvivors: array<InstanceData>;

const POP_CULL_LOD: u32 = ${POP_CULL_LOD}u;
const POP_CULL_DISTANCE: u32 = ${POP_CULL_DISTANCE}u;
const POP_CULL_OCCLUSION: u32 = ${POP_CULL_OCCLUSION}u;
const INSTANCE_FLAG_FAR: u32 = ${INSTANCE_FLAG_FAR}u;
${CULL_SPHERE_WGSL}
const POP_SLOP: f32 = CULL_SLOP;
${SHARED_SPHERE_WGSL}

@workgroup_size(${POPULATION_CULL_WORKGROUP}) @compute
fn populationCullMain(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= pop.count) {
    return;
  }

  // (1) Next frame's bits, from this frame's camera, into the source record.
  let src = instances[i];
  let previous = src.flags;
  var next = previous & 0xFFFFFFFCu;
  if ((pop.flags & POP_CULL_LOD) != 0u && length(src.row3.xyz - pop.camera) > pop.lodDistance) {
    next = next | 1u;
  }
  if ((pop.flags & POP_CULL_DISTANCE) != 0u) {
    let c = (instanceModel(src) * vec4<f32>(pop.localCenter, 1.0)).xyz;
    if (distance(c, pop.camera) - instanceRadius(src) > pop.maxDistance) {
      next = next | INSTANCE_FLAG_FAR;
    }
  }
  if (next != previous) {
    instances[i].flags = next;
  }

  // (2) HiZ over the main-view list (only on frames that occlude; otherwise forge.main draws that list).
  if ((pop.flags & POP_CULL_OCCLUSION) == 0u) {
    return;
  }
  let listed = min(atomicLoad(&drawArgs[pop.argsWord]), pop.count);
  if (i >= listed) {
    return;
  }
  let inst = visibleInstances[i];
  if (visibility[pop.visibilityIndex] != 0u) {
    atomicAdd(&popCounts.culledBatch, 1u);
    return;
  }
  let center = (instanceModel(inst) * vec4<f32>(pop.localCenter, 1.0)).xyz;
  if (cullSphere(center, instanceRadius(inst), 0.0, ${CULL_FLAG_OCCLUSION}u) == REASON_OCCLUDED) {
    atomicAdd(&popCounts.culledOccluded, 1u);
    return;
  }
  let slot = atomicAdd(&drawArgs[pop.argsWordOccluded], 1u);
  if (slot < pop.count) {
    occludedSurvivors[slot] = inst;
  }
  atomicAdd(&popCounts.drawn, 1u);
}
`;
