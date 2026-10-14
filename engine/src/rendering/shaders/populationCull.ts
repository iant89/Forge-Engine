/**
 * Phase A of the GPU-placement plan — per-INSTANCE population culling, merged with the 14.4 LOD
 * selection (docs/RENDERING.md §4g). Placement is unchanged (CPU deterministic
 * scatter); only *which* of a chunk's instances `forge.main` draws is decided here.
 *
 * `forge.populationCull` runs once per frame after `forge.objects.cull` (so after the prepass and the
 * HiZ pyramid), one dispatch per eligible batch, one invocation per instance. Each invocation:
 *
 *  1. **LOD select + distance verdict, for the next frame's depth readers.** It computes the LOD bit
 *     (bit 0, as `forge.populationLod` does) and a "past the batch's distance limit" bit (bit 1) from
 *     this frame's camera and writes both into the *source* record. The shadow passes and the prepass
 *     already ran this frame; they read the bits on the next one.
 *  2. **Cull with this frame's depth.** The record's *previous* bits (the ones the prepass just drew
 *     with) decide distance and LOD, and the shared sphere tests (`CULL_SPHERE_WGSL`: frustum + HiZ
 *     against this frame's pyramid) decide the rest. Using the bits the prepass used is what keeps the
 *     prepass and `forge.main` drawing the same LOD window and the same set of near instances — the
 *     colour pass is `less-equal` against prepass depth, so a mismatch would be a hole.
 *  3. **Atomic append.** A surviving instance takes a slot with `atomicAdd` on its batch's indirect
 *     record instance count (the particle system's append-to-indirect pattern) and is copied, with its
 *     previous bits, into the batch's compacted buffer. `forge.main` draws that buffer with
 *     `drawIndirect`/`drawIndexedIndirect`; `firstInstance` stays 0 (one compacted buffer per batch),
 *     so `indirect-first-instance` is not needed.
 *
 * The cost of (1) is a one-frame lag on LOD switches and distance pop-out, invisible at the distances
 * involved. Storage buffers in the compute stage: source, compacted, draw args, stats, visibility = 5
 * (WebGPU's guaranteed minimum is 8). Workgroup 64 (iOS Safari: 256 max invocations).
 *
 * The CPU twin is `population/cull.ts` `cullPopulationInstancesOnCpu`; the mock device runs it in
 * place of this kernel.
 */
import { InstanceStruct, ObjectCullUniforms, PopulationCullStatsBlock, PopulationCullUniforms } from "../uniforms.js";
import { CULL_FLAG_FRUSTUM, CULL_FLAG_OCCLUSION, CULL_SPHERE_WGSL } from "../objectCulling.js";

/** `PopulationCullUniforms.flags`: the batch is an LOD batch (bit 0 of the record is selected). */
export const POP_CULL_LOD = 1;
/** `PopulationCullUniforms.flags`: the batch has a distance limit (`maxDistance` > 0). */
export const POP_CULL_DISTANCE = 2;
/** `PopulationCullUniforms.flags`: the HiZ test may run (the frame occludes and the tier allows it). */
export const POP_CULL_OCCLUSION = 4;
/** Instance-record `flags` bit 1: past the batch's distance limit as of the last cull. */
export const INSTANCE_FLAG_FAR = 2;
/** Invocations per workgroup: one instance each. */
export const POPULATION_CULL_WORKGROUP = 64;

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

const POP_CULL_LOD: u32 = ${POP_CULL_LOD}u;
const POP_CULL_DISTANCE: u32 = ${POP_CULL_DISTANCE}u;
const POP_CULL_OCCLUSION: u32 = ${POP_CULL_OCCLUSION}u;
const INSTANCE_FLAG_FAR: u32 = ${INSTANCE_FLAG_FAR}u;
${CULL_SPHERE_WGSL}

@workgroup_size(${POPULATION_CULL_WORKGROUP}) @compute
fn populationCullMain(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= pop.count) {
    return;
  }
  var inst = instances[i];
  let previous = inst.flags;
  let model = mat4x4<f32>(inst.row0, inst.row1, inst.row2, inst.row3);
  let center = (model * vec4<f32>(pop.localCenter, 1.0)).xyz;
  let scale = max(length(inst.row0.xyz), max(length(inst.row1.xyz), length(inst.row2.xyz)));
  let radius = pop.localRadius * scale + CULL_SLOP;

  // (1) Next frame's bits, from this frame's camera.
  var next = previous & 0xFFFFFFFCu;
  if ((pop.flags & POP_CULL_LOD) != 0u && length(inst.row3.xyz - pop.camera) > pop.lodDistance) {
    next = next | 1u;
  }
  if ((pop.flags & POP_CULL_DISTANCE) != 0u && distance(center, pop.camera) - radius > pop.maxDistance) {
    next = next | INSTANCE_FLAG_FAR;
  }
  if (next != previous) {
    instances[i].flags = next;
  }

  // (2) This frame's verdict, with the bits the prepass drew with.
  if (visibility[pop.visibilityIndex] != 0u) {
    atomicAdd(&popCounts.culledBatch, 1u);
    return;
  }
  if ((previous & INSTANCE_FLAG_FAR) != 0u) {
    atomicAdd(&popCounts.culledDistance, 1u);
    return;
  }
  var tests = ${CULL_FLAG_FRUSTUM}u;
  if ((pop.flags & POP_CULL_OCCLUSION) != 0u) {
    tests = tests | ${CULL_FLAG_OCCLUSION}u;
  }
  let reason = cullSphere(center, radius, 0.0, tests);
  if (reason == REASON_FRUSTUM) {
    atomicAdd(&popCounts.culledFrustum, 1u);
    return;
  }
  if (reason == REASON_OCCLUDED) {
    atomicAdd(&popCounts.culledOccluded, 1u);
    return;
  }

  // (3) Append into the batch's compacted buffer; the slot is the indirect record's instance count.
  let slot = atomicAdd(&drawArgs[pop.argsWord], 1u);
  if (slot < pop.count) {
    visibleInstances[slot] = inst;
  }
  atomicAdd(&popCounts.drawn, 1u);
}
`;
