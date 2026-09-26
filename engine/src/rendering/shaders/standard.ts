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

const COMMON = /* wgsl */ `
struct VertexInput {
  @location(0) position: vec3<f32>,
  @location(1) normal: vec3<f32>,
  @location(2) uv: vec2<f32>,
  @location(3) tangent: vec4<f32>,
}

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

export const STANDARD_DEFINES = /* wgsl */ `
${STRUCTS}

${COMMON}

@group(0) @binding(0) var<uniform> perFrame: PerFrameUniforms;
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
 * Fragment stage without the defines block: the pipeline factory appends this to a vertex source
 * that already carries the declarations, so a module holds one copy of every struct.
 */
export const STANDARD_FRAGMENT_BODY = /* wgsl */ `
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
