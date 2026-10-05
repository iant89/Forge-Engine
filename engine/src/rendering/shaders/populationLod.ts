/**
 * Phase 14.4 — per-instance GPU LOD selection for population (docs/POPULATION.md, ROADMAP 14.4).
 *
 * The companion of the `forge.populationLod` render-graph pass. One dispatch per population
 * submission; each of the buffer's instances picks its LOD window from the camera: within
 * `lod.lodDistance` (euclidean, instance origin to `lod.camera`) it keeps the high window,
 * beyond it the low window. The verdict is one bit in the record's `flags` slot — bit 0,
 * 0 = high/near, 1 = low/far — which the LOD vertex entries in `shaders/standard.ts` test
 * against the vertex's window to clip out the unselected half of the merged buffer.
 *
 * The buffer is *shared by the shadow and colour passes* (that is the point of 14.3/14.4): the
 * selection is keyed on the camera's position, not the shadow light's, so a caster's shadow can
 * be one LOD coarser or finer than its colour — conservative either way, invisible in practice
 * because the two passes run the same frame with the same camera.
 *
 * Reads the instance rows already (14.3), writes nothing new: the bit lives in the 24 bytes of
 * per-record headroom the population layout always carried, so no extra memory traffic.
 */
import { InstanceStruct, PopulationLodUniforms } from "../uniforms.js";

export const POPULATION_LOD_SHADER = /* wgsl */ `
${PopulationLodUniforms.toWgsl("uniform")}
${InstanceStruct.toWgsl("storage")}

@group(0) @binding(0) var<uniform> lod: PopulationLodUniforms;
@group(0) @binding(1) var<storage, read_write> instances: array<InstanceData>;

@workgroup_size(64) @compute
fn populationLodMain(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= lod.count) {
    return;
  }
  var inst = instances[i];
  // Instance origin: row 3 is the homogeneous translation column of the model matrix.
  let pos = vec3<f32>(inst.row3.x, inst.row3.y, inst.row3.z);
  let distance = length(pos - lod.camera);
  var lodBit: u32 = 0u;
  if (distance > lod.lodDistance) {
    lodBit = 1u;
  }
  // Preserve any other flags (none today); set the LOD bit in slot 0.
  inst.flags = (inst.flags & 0xFFFFFFFEu) | lodBit;
  instances[i] = inst;
}
`;
