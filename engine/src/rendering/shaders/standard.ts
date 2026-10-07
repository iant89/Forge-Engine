/**
 * The standard (PBR) shader, as embedded WGSL source.
 *
 * Two rules make this file trustworthy:
 *  1. **Uniform structs are generated from `rendering/uniforms.ts`.** The WGSL and the CPU writer
 *     therefore cannot drift — there is literally one definition. (Hand-written shaders such as the
 *     terrain chunk program are checked separately by `tools/wgsl-check.mjs`.)
 *  2. **Everything optional is a runtime branch on a flag, not a shader permutation.** Permutation
 *     explosion is what makes shader-compile hitches in browser engines; the branches here are
 *     uniform-derived, so they are coherent per draw and free on every GPU we target.
 *
 * Conventions (docs/RENDERING.md §5): +Y up, camera looks down local +Z (left-handed view
 * space), NDC z in [0,1], positions in render-local float32, linear colour throughout. The sRGB
 * encode happens either here (LDR path, `perFrame.flags` bit 1 clear) or in the post chain's
 * tonemap pass (HDR path, bit 1 set) — never both.
 *
 * The clip-space position is `@invariant`. The depth prepass (`forge.prepass`) runs these same
 * vertex entry points in a depth-only pipeline, and the forward pass then depth-tests `less-equal`
 * against that buffer without writing it; WGSL's invariance guarantee (same data + same control
 * flow ⇒ bit-identical position, across pipelines) is what lets the second pass hit every depth the
 * first one wrote instead of losing pixels to a one-ulp disagreement.
 */

import { PerFrameUniforms, LightUniforms, LightBlock, ShadowUniforms, ShadowPassUniforms, MaterialUniforms, ObjectUniforms, InstanceStruct, ClusterUniforms, ClusterLightBlock, ClusterGridBlock, POINT_SHADOW_FACES } from "../uniforms.js";
import { WGSL_COLOR, WGSL_FOG } from "./common.js";

/** Group/binding map, exported so the pipeline and the shaders cannot disagree. */
export const BINDINGS = {
  perFrame: { group: 0, binding: 0 },
  lights: { group: 0, binding: 1 },
  shadow: { group: 0, binding: 2 },
  shadowMap: { group: 0, binding: 3 },
  shadowSampler: { group: 0, binding: 4 },
  /** Half-resolution SSAO result (`rg16float`: visibility, view depth); a 1×1 "unoccluded" texel when off. */
  ssao: { group: 0, binding: 5 },
  /** Clustered-light quantisation (`ClusterUniforms`); read only while `perFrame.flags` bit 5 is set. */
  clusters: { group: 0, binding: 6 },
  /** Local (point/spot) light records the clusters reference (`ClusterLightBlock`, storage). */
  clusterLights: { group: 0, binding: 7 },
  /** The cluster grid: two u32 per cluster, then the flat light-index list (`ClusterGridBlock`, storage). */
  clusterGrid: { group: 0, binding: 8 },
  object: { group: 1, binding: 0 },
  instances: { group: 1, binding: 1 },
  /** Batch visibility words the object culler wrote (`rendering/objectCulling.ts`): 0 = draw. */
  visibility: { group: 1, binding: 2 },
  material: { group: 2, binding: 0 },
  albedoMap: { group: 2, binding: 1 },
  normalMap: { group: 2, binding: 2 },
  mrMap: { group: 2, binding: 3 },
  sampler: { group: 2, binding: 4 },
} as const;

/**
 * Group 3: the skinning palette, bound (with a dynamic offset) only by pipelines whose vertices
 * are skinned. `rendering/skinning.ts` owns the arena it points into; the layout lives in
 * `PipelineFactory` so a non-skinned pipeline never declares a group it cannot bind.
 */
export const SKIN_BINDINGS = {
  /** `array<mat4x4<f32>>`, one entry per joint of this draw's skin, starting at the dynamic offset. */
  palette: { group: 3, binding: 0 },
} as const;

const STRUCTS = [
  PerFrameUniforms.toWgsl("uniform"),
  LightUniforms.toWgsl("uniform"),
  LightBlock.toWgsl("uniform"),
  // Clustered (Forward+) lighting: the quantisation block is a uniform, the grid and the lights it
  // references are storage (a 32k-entry `array<u32>` has a 4-byte stride, which the uniform address
  // space forbids). `LightUniforms` has the same layout in both spaces, so it is declared once and
  // the uniform `LightBlock` and the storage `ClusterLightBlock` share it.
  ClusterUniforms.toWgsl("uniform"),
  ClusterLightBlock.toWgsl("storage"),
  ClusterGridBlock.toWgsl("storage"),
  ShadowUniforms.toWgsl("uniform"),
  MaterialUniforms.toWgsl("uniform"),
  ObjectUniforms.toWgsl("uniform"),
  InstanceStruct.toWgsl("storage"),
].join("\n\n");

/**
 * Vertex inputs of the unskinned entries: exactly the fixed 48-byte layout (`rendering/geometry.ts`).
 * A module's input struct *is* its entry point's vertex interface, so a skinned module cannot reuse
 * this one — WebGPU requires every declared location to be provided by the pipeline's vertex state,
 * and requiring an unskinned draw to bind a skin buffer it does not have would be wrong.
 */
const VERTEX_INPUT_STANDARD = /* wgsl */ `
struct VertexInput {
  @location(0) position: vec3<f32>,
  @location(1) normal: vec3<f32>,
  @location(2) uv: vec2<f32>,
  @location(3) tangent: vec4<f32>,
}
`;

/**
 * Vertex inputs of the skinned entries: the 48-byte record plus the second vertex buffer slot
 * (`SKIN_VERTEX_LAYOUT`: `uint32x4` joint indices at location 4, `float32x4` weights at location 5).
 */
const VERTEX_INPUT_SKINNED = /* wgsl */ `
struct VertexInput {
  @location(0) position: vec3<f32>,
  @location(1) normal: vec3<f32>,
  @location(2) uv: vec2<f32>,
  @location(3) tangent: vec4<f32>,
  @location(4) joints: vec4<u32>,
  @location(5) weights: vec4<f32>,
}
`;

const COMMON_TAIL = /* wgsl */ `
struct VertexOutput {
  @builtin(position) @invariant clipPos: vec4<f32>,
  @location(0) worldPos: vec3<f32>,
  @location(1) normal: vec3<f32>,
  @location(2) uv: vec2<f32>,
  @location(3) tangent: vec4<f32>,
  @location(4) viewDepth: f32,
  @location(5) tint: vec4<f32>,
}

const PI: f32 = 3.141592653589793;

fn distributionGGX(n: vec3<f32>, h: vec3<f32>, roughness: f32) -> f32 {
  let a = roughness * roughness;
  let a2 = a * a;
  let nh = max(dot(n, h), 0.0);
  let d = (nh * nh * (a2 - 1.0) + 1.0);
  return a2 / (PI * d * d);
}

fn geometrySmith(n: vec3<f32>, v: vec3<f32>, l: vec3<f32>, roughness: f32) -> f32 {
  let a = roughness * roughness;
  let nv = max(dot(n, v), 0.0);
  let nl = max(dot(n, l), 0.0);
  let gv = nv / (nv * (1.0 - a) + a);
  let gl = nl / (nl * (1.0 - a) + a);
  return 0.25 * gv * gl;
}

fn fresnelSchlick(u: f32, f0: vec3<f32>) -> vec3<f32> {
  return f0 + (1.0 - f0) * pow(1.0 - u, 5.0);
}

${WGSL_COLOR}
${WGSL_FOG}

fn unpackTint(packed: u32) -> vec4<f32> {
  let a = f32((packed >> 24u) & 0xffu) / 255.0;
  let r = f32((packed >> 16u) & 0xffu) / 255.0;
  let g = f32((packed >> 8u) & 0xffu) / 255.0;
  let b = f32(packed & 0xffu) / 255.0;
  return vec4<f32>(r, g, b, a);
}
`;

/** The shared half of both standard modules: structs and helpers that do not touch the inputs. */
const COMMON = `${VERTEX_INPUT_STANDARD}\n${COMMON_TAIL}`;
const SKINNED_COMMON = `${VERTEX_INPUT_SKINNED}\n${COMMON_TAIL}`;

const SHADOW_HELPERS = /* wgsl */ `
// Cascade whose slice contains this view depth (0-based); 'count' when past the last split.
fn shadowCascadeFor(viewDepth: f32) -> i32 {
  let splits = uniforms_shadow.cascadeSplits;
  var c = 0i;
  if (viewDepth > splits.x) { c = 1i; }
  if (viewDepth > splits.y) { c = 2i; }
  if (viewDepth > splits.z) { c = 3i; }
  if (viewDepth > splits.w) { c = 4i; }
  return c;
}

fn cascadeTexelWorld(cascade: i32) -> f32 {
  let t = uniforms_shadow.cascadeTexelWorld;
  if (cascade == 0i) { return t.x; }
  if (cascade == 1i) { return t.y; }
  if (cascade == 2i) { return t.z; }
  return t.w;
}

// Coverage in [0,1] (1 = fully lit) from one cascade with 3x3 PCF over a comparison sampler. The
// receiver is pushed along its normal by 'normalBias' shadow texels first (normal-offset shadows),
// which removes acne on low-poly surfaces without the peter-panning a large constant bias causes.
fn shadowCascadeCoverage(point: vec3<f32>, normal: vec3<f32>, cascade: i32) -> f32 {
  let offset = normal * (cascadeTexelWorld(cascade) * uniforms_shadow.normalBias);
  var sc = uniforms_shadow.cascadeViewProj[cascade] * vec4<f32>(point + offset, 1.0);
  sc = sc / sc.w;
  let uv = sc.xy * vec2<f32>(0.5, -0.5) + vec2<f32>(0.5, 0.5);
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0 || sc.z > 1.0 || sc.z < 0.0) {
    return 1.0;
  }
  let depth = sc.z - uniforms_shadow.depthBias;
  var lit = 0.0;
  let texel = uniforms_shadow.texelSize;
  // textureSampleCompareLevel returns coverage in [0,1] per tap (bilinear PCF when the sampler
  // filters), so the taps average instead of majority-voting.
  for (var y = -1; y <= 1; y = y + 1) {
    for (var x = -1; x <= 1; x = x + 1) {
      let o = vec2<f32>(f32(x), f32(y)) * texel;
      lit = lit + textureSampleCompareLevel(shadowMap, shadowSampler, uv + o, cascade, depth);
    }
  }
  return lit / 9.0;
}

// Spot coverage uses that light's perspective transform and a texel-scaled normal offset. The map
// lives after the directional cascade prefix; the index is the slot among spot lights only.
fn spotShadowAttenuation(point: vec3<f32>, normal: vec3<f32>, shadowIndex: i32) -> f32 {
  if (shadowIndex < 0i || shadowIndex >= uniforms_shadow.spotCount) {
    return 1.0;
  }
  let params = uniforms_shadow.spotParams[shadowIndex];
  var sc = uniforms_shadow.spotViewProj[shadowIndex] * vec4<f32>(point, 1.0);
  if (sc.w <= 1e-5) {
    return 1.0;
  }
  let worldTexel = sc.w * params.w;
  let normalOffset = normal * (worldTexel * params.z);
  sc = uniforms_shadow.spotViewProj[shadowIndex] * vec4<f32>(point + normalOffset, 1.0);
  if (sc.w <= 1e-5) {
    return 1.0;
  }
  sc = sc / sc.w;
  let uv = sc.xy * vec2<f32>(0.5, -0.5) + vec2<f32>(0.5, 0.5);
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0 || sc.z > 1.0 || sc.z < 0.0) {
    return 1.0;
  }
  let layer = uniforms_shadow.count + shadowIndex;
  let depth = sc.z - params.y;
  var lit = 0.0;
  for (var y = -1; y <= 1; y = y + 1) {
    for (var x = -1; x <= 1; x = x + 1) {
      let o = vec2<f32>(f32(x), f32(y)) * params.x;
      lit = lit + textureSampleCompareLevel(shadowMap, shadowSampler, uv + o, layer, depth);
    }
  }
  return lit / 9.0;
}

// Cube face whose axis dominates this direction (face order +x -x +y -y +z -z, matching the
// renderer's layer order). Ties resolve to the earlier face — the CPU's frustum assignment is
// conservative either way, so both candidate faces hold the caster.
fn pointShadowFaceIndex(dir: vec3<f32>) -> i32 {
  let a = abs(dir);
  if (a.x >= a.y && a.x >= a.z) {
    if (dir.x > 0.0) { return 0i; }
    return 1i;
  }
  if (a.y >= a.z) {
    if (dir.y > 0.0) { return 2i; }
    return 3i;
  }
  if (dir.z > 0.0) { return 4i; }
  return 5i;
}

// Point coverage: pick the cube face by the dominant axis of the light->receiver direction,
// project through that face's perspective matrix and PCF-sample the shared atlas layer. WebGPU has
// no comparison sampling for depth cubes, so the face is chosen explicitly here; PCF taps that
// cross a face edge fall back to lit (a slight seam at grazing angles, documented).
fn pointShadowAttenuation(point: vec3<f32>, normal: vec3<f32>, lightPos: vec3<f32>, range: f32, shadowIndex: i32) -> f32 {
  if (shadowIndex < 0i || shadowIndex >= uniforms_shadow.pointCount) {
    return 1.0;
  }
  let params = uniforms_shadow.pointParams[shadowIndex];
  let toPoint = point - lightPos;
  let dist = length(toPoint);
  if (dist >= range || dist <= 1e-5) {
    return 1.0;
  }
  let face = pointShadowFaceIndex(toPoint / dist);
  let faceIndex = shadowIndex * ${POINT_SHADOW_FACES}i + face;
  var sc = uniforms_shadow.pointViewProj[faceIndex] * vec4<f32>(point, 1.0);
  if (sc.w <= 1e-5) {
    return 1.0;
  }
  let worldTexel = sc.w * params.w;
  let normalOffset = normal * (worldTexel * params.z);
  sc = uniforms_shadow.pointViewProj[faceIndex] * vec4<f32>(point + normalOffset, 1.0);
  if (sc.w <= 1e-5) {
    return 1.0;
  }
  sc = sc / sc.w;
  let uv = sc.xy * vec2<f32>(0.5, -0.5) + vec2<f32>(0.5, 0.5);
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0 || sc.z > 1.0 || sc.z < 0.0) {
    return 1.0;
  }
  let layer = uniforms_shadow.count + uniforms_shadow.spotCount + faceIndex;
  let depth = sc.z - params.y;
  var lit = 0.0;
  for (var y = -1; y <= 1; y = y + 1) {
    for (var x = -1; x <= 1; x = x + 1) {
      let o = vec2<f32>(f32(x), f32(y)) * params.x;
      lit = lit + textureSampleCompareLevel(shadowMap, shadowSampler, uv + o, layer, depth);
    }
  }
  return lit / 9.0;
}

// Shadow factor for the directional caster: picks the cascade by view depth, blends across the
// last 15% of a cascade so the resolution step is not a visible line, and fades out entirely at
// the shadow distance.
fn shadowAttenuation(point: vec3<f32>, normal: vec3<f32>, viewDepth: f32) -> f32 {
  if (uniforms_shadow.enabled == 0i) {
    return 1.0;
  }
  let count = uniforms_shadow.count;
  let c = shadowCascadeFor(viewDepth);
  if (c >= count) {
    return 1.0;
  }
  var lit = shadowCascadeCoverage(point, normal, c);
  let splits = uniforms_shadow.cascadeSplits;
  var far = splits.x;
  if (c == 1i) { far = splits.y; }
  if (c == 2i) { far = splits.z; }
  if (c == 3i) { far = splits.w; }
  let blendStart = far * 0.85;
  if (viewDepth > blendStart && c + 1i < count) {
    let t = (viewDepth - blendStart) / max(far - blendStart, 1e-4);
    lit = mix(lit, shadowCascadeCoverage(point, normal, c + 1i), clamp(t, 0.0, 1.0));
  }
  let fadeStart = uniforms_shadow.fadeStart;
  let fadeEnd = perFrame.shadowDistance;
  let fade = clamp((viewDepth - fadeStart) / max(fadeEnd - fadeStart, 1e-4), 0.0, 1.0);
  return mix(lit, 1.0, fade);
}

fn cascadeDebugTint(viewDepth: f32) -> vec3<f32> {
  let c = shadowCascadeFor(viewDepth);
  if (c == 0i) { return vec3<f32>(1.0, 0.55, 0.55); }
  if (c == 1i) { return vec3<f32>(0.55, 1.0, 0.55); }
  if (c == 2i) { return vec3<f32>(0.55, 0.55, 1.0); }
  if (c == 3i) { return vec3<f32>(1.0, 1.0, 0.55); }
  return vec3<f32>(1.0);
}
`;

/**
 * Group/binding declarations plus the helpers that read them — identical for the unskinned and the
 * skinned module, except for the palette the skinned one adds at group 3.
 */
const STANDARD_BINDINGS = /* wgsl */ `@group(0) @binding(0) var<uniform> perFrame: PerFrameUniforms;
@group(0) @binding(1) var<uniform> lights: LightBlock;
@group(0) @binding(2) var<uniform> uniforms_shadow: ShadowUniforms;
@group(0) @binding(3) var shadowMap: texture_depth_2d_array;
@group(0) @binding(4) var shadowSampler: sampler_comparison;
@group(0) @binding(5) var aoMap: texture_2d<f32>;
@group(0) @binding(6) var<uniform> clusters: ClusterUniforms;
@group(0) @binding(7) var<storage, read> clusterLights: ClusterLightBlock;
@group(0) @binding(8) var<storage, read> clusterGrid: ClusterGridBlock;
@group(1) @binding(0) var<uniform> objectData: ObjectUniforms;
@group(1) @binding(1) var<storage, read> instances: array<InstanceData>;
// The object culler's verdict for this draw's batch (0 = draw, see rendering/objectCulling.ts). Only
// the colour pass reads it: the prepass and the shadow passes run before the cull pass exists, and
// the depth they lay down is the very thing the culler tests against.
@group(1) @binding(2) var<storage, read> batchVisibility: array<u32>;

// A draw cannot express "zero instances", so a batch the culler rejected still issues its draw and
// the vertex stage throws it away: the clip position goes below the near plane (WebGPU's clip rule
// is 0 <= z <= w), where every primitive it belongs to is clipped before rasterisation. The vertex
// work is spent either way — what is saved is the rasteriser and the fragment stage, and, for the
// batches that pass, the pixels a nearer surface already covers (see 13.6 for removing the draw).
fn cullBatch(clip: vec4<f32>) -> vec4<f32> {
  if (batchVisibility[objectData.visibilityIndex] != 0u) {
    return vec4<f32>(0.0, 0.0, -1.0, 1.0);
  }
  return clip;
}
@group(2) @binding(0) var<uniform> material: MaterialUniforms;
@group(2) @binding(1) var albedoMap: texture_2d<f32>;
@group(2) @binding(2) var normalMap: texture_2d<f32>;
@group(2) @binding(3) var mrMap: texture_2d<f32>;
@group(2) @binding(4) var materialSampler: sampler;

const FLAGS_ALBEDO: u32 = 1u;
const FLAGS_NORMAL: u32 = 2u;
const FLAGS_MR: u32 = 4u;
const FLAGS_DOUBLE_SIDED: u32 = 8u;
const FLAGS_UNLIT: u32 = 16u;
const FLAGS_INSTANCED: u32 = 1u;
// perFrame.flags bit 5: local lights come from the cluster grid, not from the uniform light list.
const FLAGS_CLUSTERED: u32 = 32u;
`;

/**
 * The joint palette, as the skinned entries see it: one `mat4x4<f32>` per joint of this draw's
 * skin, the binding's dynamic offset moved to the batch's slot by the renderer, so index 0 is the
 * first joint. `input.joints` indexes it directly (indices are validated to be in range by the
 * asset pipeline; WebGPU's out-of-bounds rules make a stray index read zero rather than fault).
 *
 * The weights are normalised here rather than trusted: `validateSkinningData` checks the sum at
 * import, and the divide is what keeps a badly authored vertex from shrinking to the origin.
 */
const STANDARD_SKIN_HELPERS = /* wgsl */ `
@group(3) @binding(0) var<storage, read> jointPalette: array<mat4x4<f32>>;

fn skinMatrix(input: VertexInput) -> mat4x4<f32> {
  let w = input.weights;
  let j = input.joints;
  let total = w.x + w.y + w.z + w.w;
  let inv = select(1.0, 1.0 / total, total > 1e-6);
  let blended = w.x * jointPalette[j.x] + w.y * jointPalette[j.y] + w.z * jointPalette[j.z] + w.w * jointPalette[j.w];
  return blended * inv;
}
`;

export const STANDARD_DEFINES = /* wgsl */ `
${STRUCTS}

${COMMON}

${STANDARD_BINDINGS}
`;

/** Declarations of a module whose vertex stage skins (see `STANDARD_SKIN_HELPERS`). */
const STANDARD_SKINNED_DEFINES = `
${STRUCTS}

${SKINNED_COMMON}

${STANDARD_BINDINGS}

${STANDARD_SKIN_HELPERS}
`;

/** Vertex stage for the colour pass (non-instanced path). */
export const STANDARD_VERTEX = /* wgsl */ `
${STANDARD_DEFINES}

@vertex
fn vertexMain(input: VertexInput) -> VertexOutput {
  var out: VertexOutput;
  let model = objectData.model;
  let world = model * vec4<f32>(input.position, 1.0);
  out.clipPos = perFrame.viewProj * world;
  out.worldPos = world.xyz;
  out.normal = normalize((model * vec4<f32>(input.normal, 0.0)).xyz);
  out.uv = input.uv;
  out.tangent = input.tangent;
  out.viewDepth = out.clipPos.w;
  out.tint = vec4<f32>(1.0);
  out.clipPos = cullBatch(out.clipPos);
  return out;
}
`;

/**
 * The instanced variant is a separate entry point rather than a branch: WebGPU has no
 * `gl_InstanceIndex`-equivalent in the vertex input struct, so `@builtin(instance_index)` has to be
 * an explicit parameter, which in turn changes the signature.
 */
export const STANDARD_INSTANCED_VERTEX = /* wgsl */ `
${STANDARD_DEFINES}

@vertex
fn vertexMainInstanced(input: VertexInput, @builtin(instance_index) instanceIndex: u32) -> VertexOutput {
  var out: VertexOutput;
  let inst = instances[instanceIndex];
  let model = mat4x4<f32>(inst.row0, inst.row1, inst.row2, inst.row3);
  var world = model * vec4<f32>(input.position, 1.0);
  out.clipPos = perFrame.viewProj * world;
  out.worldPos = world.xyz;
  out.normal = normalize((model * vec4<f32>(input.normal, 0.0)).xyz);
  out.uv = input.uv;
  out.tangent = input.tangent;
  out.viewDepth = out.clipPos.w;
  out.tint = unpackTint(inst.tint);
  out.clipPos = cullBatch(out.clipPos);
  return out;
}
`;

/**
 * Skinned variants of the colour-pass entries: same maths as their unskinned twins, with the
 * vertex's position and normal pushed through the joint palette first (`skinMatrix`).
 *
 * The palette is mesh-local by construction (see `rendering/skinning.ts`), so `objectData.model`
 * stays the draw's own matrix on both paths — a skinned mesh is placed exactly like an unskinned
 * one, and the depth prepass, which compiles *these* entry points, writes the same depth the
 * forward pass tests against. The normal uses the palette's rotation/scale block (translation is
 * dropped by the `w = 0` term); a joint chain that shears would want the inverse transpose, which
 * no glTF asset needs and which would cost a per-vertex 3×3 inverse.
 */
export const STANDARD_SKINNED_VERTEX = /* wgsl */ `
${STANDARD_SKINNED_DEFINES}

@vertex
fn vertexMainSkinned(input: VertexInput) -> VertexOutput {
  var out: VertexOutput;
  let model = objectData.model;
  let skin = skinMatrix(input);
  let world = model * (skin * vec4<f32>(input.position, 1.0));
  out.clipPos = perFrame.viewProj * world;
  out.worldPos = world.xyz;
  out.normal = normalize((model * (skin * vec4<f32>(input.normal, 0.0))).xyz);
  out.uv = input.uv;
  out.tangent = input.tangent;
  out.viewDepth = out.clipPos.w;
  out.tint = vec4<f32>(1.0);
  out.clipPos = cullBatch(out.clipPos);
  return out;
}
`;

/** Skinned variant of the instanced colour entry: the batch's skin drives every instance. */
export const STANDARD_SKINNED_INSTANCED_VERTEX = /* wgsl */ `
${STANDARD_SKINNED_DEFINES}

@vertex
fn vertexMainInstancedSkinned(input: VertexInput, @builtin(instance_index) instanceIndex: u32) -> VertexOutput {
  var out: VertexOutput;
  let inst = instances[instanceIndex];
  let model = mat4x4<f32>(inst.row0, inst.row1, inst.row2, inst.row3);
  let skin = skinMatrix(input);
  let world = model * (skin * vec4<f32>(input.position, 1.0));
  out.clipPos = perFrame.viewProj * world;
  out.worldPos = world.xyz;
  out.normal = normalize((model * (skin * vec4<f32>(input.normal, 0.0))).xyz);
  out.uv = input.uv;
  out.tangent = input.tangent;
  out.viewDepth = out.clipPos.w;
  out.tint = unpackTint(inst.tint);
  out.clipPos = cullBatch(out.clipPos);
  return out;
}
`;

/**
 * Phase 14.4: the LOD variant of the instanced entry. The batch's geometry is the merged
 * population-LOD buffer — the high window's triangles first, then the low window's, each *expanded*
 * (unindexed: three vertices per triangle, so vertex `v / 3` is a triangle index). The
 * `forge.populationLod` compute pass writes a per-instance bit into the record's `flags` slot
 * (0 = near → high, 1 = far → low); this entry clips out the window the instance did not select,
 * so only the selected LOD is rasterized. The unselected window costs vertex ALU only.
 *
 * `objectData.hiTriangles` is the high window's triangle count: a vertex belongs to the high
 * window iff its triangle index is below it (the low window's triangles continue from there).
 */
export const STANDARD_LOD_INSTANCED_VERTEX = /* wgsl */ `
${STANDARD_DEFINES}

@vertex
fn vertexMainInstancedLod(input: VertexInput, @builtin(instance_index) instanceIndex: u32, @builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
  var out: VertexOutput;
  let inst = instances[instanceIndex];
  let model = mat4x4<f32>(inst.row0, inst.row1, inst.row2, inst.row3);
  var world = model * vec4<f32>(input.position, 1.0);
  var clip = perFrame.viewProj * world;
  let inHi = vertexIndex / 3u < objectData.hiTriangles;
  let wantHi = (inst.flags & 1u) == 0u;
  if (inHi != wantHi) {
    // Same clip-out as the culler's verdict: below the near plane, clipped before rasterisation.
    clip = vec4<f32>(0.0, 0.0, 2.0, 1.0);
  }
  out.clipPos = clip;
  out.worldPos = world.xyz;
  out.normal = normalize((model * vec4<f32>(input.normal, 0.0)).xyz);
  out.uv = input.uv;
  out.tangent = input.tangent;
  out.viewDepth = out.clipPos.w;
  out.tint = unpackTint(inst.tint);
  out.clipPos = cullBatch(out.clipPos);
  return out;
}
`;

/**
 * Fragment stage without the defines block: the pipeline factory appends this to a vertex source
 * that already carries the declarations, so a module holds one copy of every struct.
 */
const STANDARD_SURFACE_SETUP = /* wgsl */ `
  let albedo = materialAlbedo(in.uv);
  var N = normalize(in.normal);
  let V = normalize(perFrame.cameraPosRender - in.worldPos);
  if ((perFrame.flags & 4u) != 0u) {
    // Normal map (tangent space) when available; the TBN is built from the interpolated tangent.
    if ((material.flags & FLAGS_NORMAL) != 0u) {
      let sampled = textureSample(normalMap, materialSampler, in.uv * material.tiling + material.offset).xyz * 2.0 - 1.0;
      let T = normalize(in.tangent.xyz);
      let B = cross(N, T) * in.tangent.w;
      let tbn = mat3x3<f32>(T, B, N);
      N = normalize(tbn * (sampled * vec3<f32>(material.normalScale, material.normalScale, 1.0)));
    }
  }
  var metallic = material.metallic;
  var roughness = material.roughness;
  if ((material.flags & FLAGS_MR) != 0u) {
    let mr = textureSample(mrMap, materialSampler, in.uv * material.tiling + material.offset);
    metallic = metallic * mr.b;
    roughness = roughness * mr.g;
  }
  roughness = clamp(roughness, 0.045, 1.0);
`;

/** Shared lighting/shadows/fog/output; other surface techniques replace only PBR input sampling. */
export function createStandardFragmentBody(surfaceSetup = STANDARD_SURFACE_SETUP): string {
  return /* wgsl */ `
${SHADOW_HELPERS}

// SSAO visibility for this fragment: a 2×2 bilateral fetch from the half-resolution AO target.
// Each texel carries the view depth it was computed at; texels from another surface (a silhouette
// behind the fragment, or the opaque scene behind a transparent/non-prepassed surface) get no
// weight, and a fragment no texel agrees with is left unoccluded. Loads, not samples, so it is legal
// in non-uniform control flow.
fn ambientOcclusion(fragCoord: vec2<f32>, viewDepth: f32) -> f32 {
  if ((perFrame.flags & 16u) == 0u) {
    return 1.0;
  }
  let size = vec2<i32>(textureDimensions(aoMap));
  let st = fragCoord * (vec2<f32>(size) / perFrame.renderExtent) - vec2<f32>(0.5, 0.5);
  let base = floor(st);
  let f = st - base;
  let origin = vec2<i32>(base);
  let last = size - vec2<i32>(1, 1);
  var sum = 0.0;
  var total = 0.0;
  for (var j = 0; j < 2; j = j + 1) {
    for (var i = 0; i < 2; i = i + 1) {
      let tap = textureLoad(aoMap, clamp(origin + vec2<i32>(i, j), vec2<i32>(0, 0), last), 0);
      let bilinear = select(1.0 - f.x, f.x, i == 1) * select(1.0 - f.y, f.y, j == 1);
      let agree = max(0.0, 1.0 - 20.0 * abs(tap.g - viewDepth) / max(viewDepth, 1e-3));
      let w = bilinear * agree;
      sum = sum + tap.r * w;
      total = total + w;
    }
  }
  if (total < 1e-4) {
    return 1.0;
  }
  return sum / total;
}

// ------------------------------------------------------- clustered (Forward+) lighting (13.3)

// The cluster this fragment falls in: tile from its framebuffer position, slice from its view depth.
// Both quantisations are the CPU builder's own (rendering/clusters.ts), which widens every light's
// slice range by one and pads its tile extent, so a float32/float64 disagreement at a boundary can
// only ever add a light whose contribution is exactly zero — never drop one that matters.
fn clusterIndexOf(fragCoord: vec2<f32>, viewDepth: f32) -> i32 {
  let uv = fragCoord * clusters.invExtent;
  let tiles = vec2<i32>(clusters.gridScale);
  let tx = clamp(i32(uv.x * clusters.gridScale.x), 0i, tiles.x - 1i);
  let ty = clamp(i32(uv.y * clusters.gridScale.y), 0i, tiles.y - 1i);
  let d = max(viewDepth, clusters.near);
  let tz = clamp(i32((log(d) - clusters.logNear) * clusters.sliceScale), 0i, i32(clusters.slices) - 1i);
  return (tz * tiles.y + ty) * tiles.x + tx;
}

// Everything one light evaluation needs that is not the light itself.
struct SurfaceShading {
  worldPos: vec3<f32>,
  normal: vec3<f32>,
  view: vec3<f32>,
  viewDepth: f32,
  albedo: vec3<f32>,
  f0: vec3<f32>,
  metallic: f32,
  roughness: f32,
}

// One light's contribution to one surface. The uniform light list and the cluster lists both
// accumulate through this single function, so a frame is bit-identical whichever path supplied the
// light — that is what turns "clustering on vs off" into a pixel comparison instead of a judgement
// call, and it is why the body is not allowed to grow a second copy.
fn lightContribution(L: LightUniforms, s: SurfaceShading) -> vec3<f32> {
  let N = s.normal;
  let V = s.view;
  var lightDir: vec3<f32>;
  var attenuation = 1.0;
  if (L.kind == 0i) {
    lightDir = -normalize(L.directionIntensity.xyz);
  } else {
    let toLight = L.positionRange.xyz - s.worldPos;
    let dist = max(length(toLight), 1e-4);
    lightDir = toLight / dist;
    let range = max(L.positionRange.w, 1e-4);
    attenuation = clamp(1.0 - pow(dist / range, 4.0), 0.0, 1.0);
    attenuation = attenuation * attenuation / (dist * dist + 1.0);
    if (L.kind == 2i) {
      let spotDir = normalize(-L.directionIntensity.xyz);
      let sc = dot(lightDir, spotDir);
      attenuation = attenuation * smoothstep(L.spotAngles.y, L.spotAngles.x, sc);
    }
  }
  var power = L.directionIntensity.w * attenuation;
  if (L.shadowIndex >= 0i) {
    if (L.kind == 0i) {
      power = power * shadowAttenuation(s.worldPos, N, s.viewDepth);
    } else if (L.kind == 1i) {
      power = power * pointShadowAttenuation(s.worldPos, N, L.positionRange.xyz, L.positionRange.w, L.shadowIndex);
    } else if (L.kind == 2i) {
      power = power * spotShadowAttenuation(s.worldPos, N, L.shadowIndex);
    }
  }
  let H = normalize(V + lightDir);
  let nl = max(dot(N, lightDir), 0.0);
  let nv = max(dot(N, V), 0.0);
  let D = distributionGGX(N, H, s.roughness);
  let G = geometrySmith(N, V, lightDir, s.roughness);
  let F = fresnelSchlick(max(dot(H, V), 0.0), s.f0);
  let specular = (D * G * F) / max(4.0 * nv * nl, 1e-4);
  let kD = (1.0 - F) * (1.0 - s.metallic);
  return (kD * s.albedo / PI + specular) * L.color * power * nl;
}

fn materialAlbedo(uv: vec2<f32>) -> vec4<f32> {
  var base = material.baseColorFactor;
  if ((material.flags & FLAGS_ALBEDO) != 0u) {
    base = base * textureSample(albedoMap, materialSampler, uv * material.tiling + material.offset);
  }
  return base;
}

@fragment
fn fragmentMain(in: VertexOutput) -> @location(0) vec4<f32> {
${surfaceSetup}

  var color = vec3<f32>(0.0);
  if ((material.flags & FLAGS_UNLIT) != 0u) {
    color = albedo.rgb;
  } else {
    let F0 = mix(vec3<f32>(0.04), albedo.rgb, metallic);
    let surface = SurfaceShading(in.worldPos, N, V, in.viewDepth, albedo.rgb, F0, metallic, roughness);
    // Global lights: the uniform list. With clustering on this holds the directional lights only
    // (they reach every pixel, so there is nothing to cull); with it off it holds everything the
    // fixed 16-entry list can carry, exactly as before.
    for (var i = 0i; i < lights.count; i = i + 1i) {
      color = color + lightContribution(lights.lights[i], surface);
    }
    if ((perFrame.flags & FLAGS_CLUSTERED) != 0u) {
      // Local lights from this fragment's cluster alone. The list is in light order — the CPU
      // builder preserves it, evictions included — so the accumulation order, and therefore the
      // floating-point sum, is the unclustered path's own.
      // Each cluster owns clusters.stride consecutive slots (MAX_LIGHTS_PER_CLUSTER), so the lookup
      // is one count load plus its own block — no offset table to chase first.
      let c = clusterIndexOf(in.clipPos.xy, in.viewDepth);
      let entries = i32(clusterGrid.counts[c]);
      let base = c * clusters.stride;
      let limit = clusterLights.count;
      for (var k = 0i; k < entries; k = k + 1i) {
        let index = i32(clusterGrid.indices[base + k]);
        // A stale or corrupt index must cost a light, not read another one's record.
        if (index >= 0i && index < limit) {
          color = color + lightContribution(clusterLights.lights[index], surface);
        }
      }
    }
    let ambient = perFrame.ambientColor * perFrame.ambientIntensity * albedo.rgb;
    let irradiance = ambient * (1.0 - F0) * ambientOcclusion(in.clipPos.xy, in.viewDepth);
    color = color + irradiance;
  }
  // Emission is radiance the surface adds on its own; it is not modulated by the albedo (a dark
  // base colour with a bright emissive factor is exactly how a glowing core is authored).
  color = color + material.emissiveFactor * material.emissiveStrength;
  color = color * in.tint.rgb;
  if ((uniforms_shadow.flags & 1u) != 0u) {
    color = color * cascadeDebugTint(in.viewDepth);
  }
  let alpha = albedo.a * material.opacity * in.tint.a;
  if (material.opacity < 0.999 && alpha < 0.004) {
    discard;
  }
  // Fog: blend toward the fog colour by the transmittance of the air between camera and surface.
  // Scene-referred (before exposure/tone mapping) so the HDR and LDR paths agree; the sky pass is
  // not fogged, so fogColor should match the horizon (DayNightCycle keeps them in step).
  let fogT = fogTransmittance(length(in.worldPos - perFrame.cameraPosRender), perFrame.cameraPosRender.y, in.worldPos.y);
  color = mix(perFrame.fogColor, color, fogT);
  if ((perFrame.flags & 2u) != 0u) {
    // HDR path: the target is a float texture and the post chain applies exposure, bloom, the tone
    // curve and the sRGB encode. Output scene-referred linear radiance untouched.
    return vec4<f32>(color, alpha);
  }
  // LDR path straight into the (non-sRGB) swapchain: same operators as the post chain, in-shader.
  color = color * perFrame.exposure;
  color = tonemap(color, perFrame.toneMapping);
  color = linearToSrgb(color);
  return vec4<f32>(color, alpha);
}
`;

}

export const STANDARD_FRAGMENT_BODY = createStandardFragmentBody();

/** @deprecated kept so external demos keep compiling; use `STANDARD_FRAGMENT_BODY`. */
export const STANDARD_FRAGMENT = STANDARD_DEFINES + STANDARD_FRAGMENT_BODY;

/** Depth-only program for the shadow pass: no colour targets, so the fragment stage is empty. */
export const DEPTH_VERTEX = /* wgsl */ `
${ShadowPassUniforms.toWgsl("uniform")}
${ObjectUniforms.toWgsl("uniform")}
${InstanceStruct.toWgsl("storage")}

// Group 0 is the per-shadow-layer block, not the camera's per-frame block: its matrix is the
// directional cascade or spotlight projection fit in rendering/shadows.ts.
@group(0) @binding(0) var<uniform> shadowPass: ShadowPassUniforms;
@group(1) @binding(0) var<uniform> objectData: ObjectUniforms;
@group(1) @binding(1) var<storage, read> instances: array<InstanceData>;

struct In {
  @location(0) position: vec3<f32>,
}

struct Out {
  @builtin(position) clip: vec4<f32>,
}

@vertex
fn vertexMain(input: In) -> Out {
  var out: Out;
  out.clip = shadowPass.viewProj * objectData.model * vec4<f32>(input.position, 1.0);
  return out;
}

@vertex
fn vertexMainInstanced(input: In, @builtin(instance_index) instanceIndex: u32) -> Out {
  var out: Out;
  let i = instances[instanceIndex];
  let model = mat4x4<f32>(i.row0, i.row1, i.row2, i.row3);
  out.clip = shadowPass.viewProj * model * vec4<f32>(input.position, 1.0);
  return out;
}

// Phase 14.4: the shadow pass draws population casters through the same merged LOD buffer, so it
// honours the same per-instance window bit. The LOD selection is keyed on the *camera* distance
// (the compute pass's uniform), which for a shadow caster is conservative, not exact.
@vertex
fn vertexMainInstancedLod(input: In, @builtin(instance_index) instanceIndex: u32, @builtin(vertex_index) vertexIndex: u32) -> Out {
  var out: Out;
  let i = instances[instanceIndex];
  let model = mat4x4<f32>(i.row0, i.row1, i.row2, i.row3);
  var clip = shadowPass.viewProj * model * vec4<f32>(input.position, 1.0);
  let inHi = vertexIndex / 3u < objectData.hiTriangles;
  let wantHi = (i.flags & 1u) == 0u;
  if (inHi != wantHi) {
    clip = vec4<f32>(0.0, 0.0, 2.0, 1.0);
  }
  out.clip = clip;
  return out;
}

@fragment
fn fragmentMain() {}
`;

/**
 * Skinned depth-only program for the shadow pass (`forge.shadow.*`). Separate from `DEPTH_VERTEX`
 * rather than a permutation of it because the vertex inputs differ (locations 4/5 and the palette
 * binding), and mirroring the unskinned program's structure keeps the two readable side by side:
 * the same `ShadowPassUniforms`/`ObjectUniforms` groups 0 and 1, plus the palette at group 3.
 *
 * The entry points are the colour pass's skinned maths with the colour output dropped, so a
 * skinned caster's shadow lands exactly where its lit pixels are.
 */
export const DEPTH_SKINNED_VERTEX = /* wgsl */ `
${ShadowPassUniforms.toWgsl("uniform")}
${ObjectUniforms.toWgsl("uniform")}
${InstanceStruct.toWgsl("storage")}

// Group 0 is the per-shadow-layer block, not the camera's per-frame block: its matrix is the
// directional cascade or spotlight projection fit in rendering/shadows.ts.
@group(0) @binding(0) var<uniform> shadowPass: ShadowPassUniforms;
@group(1) @binding(0) var<uniform> objectData: ObjectUniforms;
@group(1) @binding(1) var<storage, read> instances: array<InstanceData>;
@group(3) @binding(0) var<storage, read> jointPalette: array<mat4x4<f32>>;

struct In {
  @location(0) position: vec3<f32>,
  @location(4) joints: vec4<u32>,
  @location(5) weights: vec4<f32>,
}

struct Out {
  @builtin(position) clip: vec4<f32>,
}

fn skinMatrix(input: In) -> mat4x4<f32> {
  let w = input.weights;
  let j = input.joints;
  let total = w.x + w.y + w.z + w.w;
  let inv = select(1.0, 1.0 / total, total > 1e-6);
  let blended = w.x * jointPalette[j.x] + w.y * jointPalette[j.y] + w.z * jointPalette[j.z] + w.w * jointPalette[j.w];
  return blended * inv;
}

@vertex
fn vertexMainSkinned(input: In) -> Out {
  var out: Out;
  let skinned = skinMatrix(input) * vec4<f32>(input.position, 1.0);
  out.clip = shadowPass.viewProj * objectData.model * skinned;
  return out;
}

@vertex
fn vertexMainInstancedSkinned(input: In, @builtin(instance_index) instanceIndex: u32) -> Out {
  var out: Out;
  let i = instances[instanceIndex];
  let model = mat4x4<f32>(i.row0, i.row1, i.row2, i.row3);
  let skinned = skinMatrix(input) * vec4<f32>(input.position, 1.0);
  out.clip = shadowPass.viewProj * model * skinned;
  return out;
}

@fragment
fn fragmentMain() {}
`;

/** Debug overlay: coloured line list in render-local space (no lighting, no depth bias). */
export const DEBUG_SHADER = /* wgsl */ `
${PerFrameUniforms.toWgsl("uniform")}
${InstanceStruct.toWgsl("storage")}

struct DebugVertex {
  @location(0) position: vec3<f32>,
  @location(1) color: u32,
}

struct DebugOut {
  @builtin(position) clip: vec4<f32>,
  @location(0) color: vec4<f32>,
}

@group(0) @binding(0) var<uniform> perFrame: PerFrameUniforms;

fn unpackDebugColor(packed: u32) -> vec4<f32> {
  let a = f32((packed >> 24u) & 0xffu) / 255.0;
  let r = f32((packed >> 16u) & 0xffu) / 255.0;
  let g = f32((packed >> 8u) & 0xffu) / 255.0;
  let b = f32(packed & 0xffu) / 255.0;
  return vec4<f32>(r, g, b, a);
}

@vertex
fn vertexMain(input: DebugVertex) -> DebugOut {
  var out: DebugOut;
  out.clip = perFrame.viewProj * vec4<f32>(input.position, 1.0);
  out.color = unpackDebugColor(input.color);
  return out;
}

@fragment
fn fragmentMain(in: DebugOut) -> @location(0) vec4<f32> {
  return in.color;
}
`;

/** Fullscreen blit + optional post chain input (also used for the resolve/tonemap pass). */
export const BLIT_SHADER = /* wgsl */ `
${PerFrameUniforms.toWgsl("uniform")}

struct VsOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) uv: vec2<f32>,
}

@group(0) @binding(0) var<uniform> perFrame: PerFrameUniforms;
@group(0) @binding(1) var src: texture_2d<f32>;
@group(0) @binding(2) var srcSampler: sampler;

@vertex
fn vertexMain(@builtin(vertex_index) index: u32) -> VsOut {
  // Single triangle covering the viewport: cheaper than a quad (no degenerate half).
  var x = f32(index & 1u) * 4.0 - 1.0;
  var y = f32(index >> 1u) * 4.0 - 1.0;
  var out: VsOut;
  out.pos = vec4<f32>(x, y, 0.0, 1.0);
  out.uv = vec2<f32>(x, -y) * 0.5 + vec2<f32>(0.5, 0.5);
  return out;
}

@fragment
fn fragmentMain(in: VsOut) -> @location(0) vec4<f32> {
  return textureSample(src, srcSampler, in.uv);
}
`;

/** @internal used by tests that assert the generated struct text is actually embedded. */
export const STANDARD_STRUCT_SOURCE = STRUCTS;
