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

import { PerFrameUniforms, LightUniforms, LightBlock, ShadowUniforms, ShadowPassUniforms, MaterialUniforms, ObjectUniforms, InstanceStruct } from "../uniforms.js";
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
  object: { group: 1, binding: 0 },
  instances: { group: 1, binding: 1 },
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
@group(1) @binding(0) var<uniform> objectData: ObjectUniforms;
@group(1) @binding(1) var<storage, read> instances: array<InstanceData>;
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
    for (var i = 0i; i < lights.count; i = i + 1i) {
      let L = lights.lights[i];
      var lightDir: vec3<f32>;
      var attenuation = 1.0;
      if (L.kind == 0i) {
        lightDir = -normalize(L.directionIntensity.xyz);
      } else {
        let toLight = L.positionRange.xyz - in.worldPos;
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
        // Only the directional caster has a shadow map (cascaded); point/spot shadows are deferred.
        power = power * shadowAttenuation(in.worldPos, N, in.viewDepth);
      }
      let H = normalize(V + lightDir);
      let nl = max(dot(N, lightDir), 0.0);
      let nv = max(dot(N, V), 0.0);
      let D = distributionGGX(N, H, roughness);
      let G = geometrySmith(N, V, lightDir, roughness);
      let F = fresnelSchlick(max(dot(H, V), 0.0), F0);
      let specular = (D * G * F) / max(4.0 * nv * nl, 1e-4);
      let kD = (1.0 - F) * (1.0 - metallic);
      color = color + (kD * albedo.rgb / PI + specular) * L.color * power * nl;
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

// Group 0 is the *cascade* block, not the camera's per-frame block: the shadow pass renders from
// the light, so its view-projection comes from the cascade fit (rendering/shadows.ts).
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
