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
 * Conventions (docs/RENDERING.md#conventions): right-handed, +Y up, camera looks down local +Z,
 * NDC z in [0,1], positions in render-local float32, linear colour, sRGB only at output.
 */

import { PerFrameUniforms, LightUniforms, LightBlock, ShadowUniforms, MaterialUniforms, ObjectUniforms, InstanceStruct } from "../uniforms.js";

/** Group/binding map, exported so the pipeline and the shaders cannot disagree. */
export const BINDINGS = {
  perFrame: { group: 0, binding: 0 },
  lights: { group: 0, binding: 1 },
  shadow: { group: 0, binding: 2 },
  shadowMap: { group: 0, binding: 3 },
  shadowSampler: { group: 0, binding: 4 },
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
  @builtin(position) clipPos: vec4<f32>,
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

fn linearToSrgb(c: vec3<f32>) -> vec3<f32> {
  let lo = c * 12.92;
  let hi = 1.055 * pow(max(c, vec3<f32>(0.0)), vec3<f32>(1.0 / 2.4)) - 0.055;
  return select(hi, lo, c <= vec3<f32>(0.0031308));
}

fn tonemap(c: vec3<f32>, mode: f32) -> vec3<f32> {
  if (mode < 0.5) {
    return c;
  }
  if (mode < 1.5) {
    // Reinhard (luminance-preserving variant).
    let l = dot(c, vec3<f32>(0.2126, 0.7152, 0.0722));
    return c / (1.0 + l);
  }
  if (mode < 2.5) {
    // ACES filmic (Narkowicz fit) — the engine default: keeps highlights rolloff smooth.
    let a = 2.51;
    let b = 0.03;
    let cc = 2.43;
    let d = 0.59;
    let e = 0.14;
    return clamp((c * (a * c + b)) / (c * (cc * c + d) + e), vec3<f32>(0.0), vec3<f32>(1.0));
  }
  // Filmic (Hable-ish) approximation.
  let x = max(c, vec3<f32>(0.0));
  return clamp(((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14)) - vec3<f32>(0.0), vec3<f32>(0.0), vec3<f32>(1.0));
}

fn unpackTint(packed: u32) -> vec4<f32> {
  let a = f32((packed >> 24u) & 0xffu) / 255.0;
  let r = f32((packed >> 16u) & 0xffu) / 255.0;
  let g = f32((packed >> 8u) & 0xffu) / 255.0;
  let b = f32(packed & 0xffu) / 255.0;
  return vec4<f32>(r, g, b, a);
}
`;

const SHADOW_HELPERS = /* wgsl */ `
fn shadowAttenuation(point: vec3<f32>, cascade: i32) -> f32 {
  if (uniforms_shadow.enabled == 0i || cascade < 0i) {
    return 1.0;
  }
  let proj = uniforms_shadow.cascadeViewProj[cascade];
  var sc = proj * vec4<f32>(point, 1.0);
  sc = sc / sc.w;
  let uv = sc.xy * vec2<f32>(0.5, 0.5) + vec2<f32>(0.5, 0.5);
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0 || sc.z > 1.0) {
    return 1.0;
  }
  let depth = sc.z - uniforms_shadow.depthBias;
  var lit = 0.0;
  let texel = uniforms_shadow.texelSize;
  // 3x3 PCF. textureSampleCompareLevel already returns coverage in [0,1] for a depth texture
  // bound with a comparison sampler, so the taps average instead of majority-voting.
  for (var y = -1; y <= 1; y = y + 1) {
    for (var x = -1; x <= 1; x = x + 1) {
      let o = vec2<f32>(f32(x), f32(y)) * texel;
      lit = lit + textureSampleCompareLevel(shadowMap, shadowSampler, uv + o, depth);
    }
  }
  return lit / 9.0;
}
`;

export const STANDARD_DEFINES = /* wgsl */ `
${STRUCTS}

${COMMON}

@group(0) @binding(0) var<uniform> perFrame: PerFrameUniforms;
@group(0) @binding(1) var<uniform> lights: LightBlock;
@group(0) @binding(2) var<uniform> uniforms_shadow: ShadowUniforms;
@group(0) @binding(3) var shadowMap: texture_depth_2d;
@group(0) @binding(4) var shadowSampler: sampler_comparison;
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
        // Only the directional caster reaches here in phase 1; point shadows land with phase 2.
        let lit = shadowAttenuation(in.worldPos, L.shadowIndex);
        power = power * mix(1.0, lit, 0.85);
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
    let irradiance = ambient * (1.0 - F0);
    color = color + irradiance;
  }
  color = color + material.emissiveFactor * material.emissiveStrength * albedo.rgb;
  color = color * in.tint.rgb;
  color = color * perFrame.exposure;
  color = tonemap(color, perFrame.toneMapping);
  if ((perFrame.flags & 2u) == 0u) {
    // No separate encode pass: encode here so the swapchain (non-sRGB format) shows correct colour.
    color = linearToSrgb(color);
  }
  let alpha = albedo.a * material.opacity * in.tint.a;
  if (material.opacity < 0.999 && alpha < 0.004) {
    discard;
  }
  return vec4<f32>(color, alpha);
}
`;

/** @deprecated kept so external demos keep compiling; use `STANDARD_FRAGMENT_BODY`. */
export const STANDARD_FRAGMENT = STANDARD_DEFINES + STANDARD_FRAGMENT_BODY;

/** Depth-only program for the shadow pass: no colour targets, so the fragment stage is empty. */
export const DEPTH_VERTEX = /* wgsl */ `
${PerFrameUniforms.toWgsl("uniform")}
${ObjectUniforms.toWgsl("uniform")}
${InstanceStruct.toWgsl("storage")}

@group(0) @binding(0) var<uniform> perFrame: PerFrameUniforms;
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
  out.clip = perFrame.viewProj * objectData.model * vec4<f32>(input.position, 1.0);
  return out;
}

@vertex
fn vertexMainInstanced(input: In, @builtin(instance_index) instanceIndex: u32) -> Out {
  var out: Out;
  let i = instances[instanceIndex];
  let model = mat4x4<f32>(i.row0, i.row1, i.row2, i.row3);
  out.clip = perFrame.viewProj * model * vec4<f32>(input.position, 1.0);
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
