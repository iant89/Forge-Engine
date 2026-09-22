/**
 * The water program (Phase 8b), drawn for `Renderable`s whose material uses the `water`
 * technique inside `forge.main` (transparent bucket, back-to-front with the other transparents).
 *
 * The vertex stage evaluates the Gerstner sum from `WaterUniforms` — the same waves, with `k`
 * and `Q` precomputed on the CPU, that `environment/water.ts` samples — so the rendered surface
 * and gameplay queries agree. The fragment stage shades the surface from the 8a sky: the horizon
 * colour (`skyTint`) is what the fresnel reflection mixes toward, `sunTint` drives a two-lobe sun
 * glint, whitecap foam breaks over the crests, and `WGSL_FOG` submerges the distance exactly like
 * any other surface.
 *
 * What this is not: there is no screen-space reflection or refraction of the scene (no planar
 * pass, no depth sampling — the "refraction" is the fresnel-mixed body colour plus the reflected
 * sky tint), and no shore foam (there is no depth texture to read the shoreline from). Both are
 * documented in `docs/KNOWN-ISSUES.md`.
 *
 * Bind groups reuse the standard program's frame (group 0) and draw (group 1) layouts and add
 * the water block as group 2. The vertex stage always reads the instance matrix
 * (`instance_index` is 0 for non-instanced draws), so one entry point covers both paths.
 */

import { PerFrameUniforms, InstanceStruct, WaterUniforms } from "../uniforms.js";
import { WGSL_COLOR, WGSL_FOG } from "./common.js";

/** Group/binding map of the water program (frame + draw are shared with the standard program). */
export const WATER_BINDINGS = {
  perFrame: { group: 0, binding: 0 },
  instances: { group: 1, binding: 1 },
  water: { group: 2, binding: 0 },
} as const;

export const WATER_SHADER = /* wgsl */ `
${PerFrameUniforms.toWgsl("uniform")}

${InstanceStruct.toWgsl("storage")}

${WaterUniforms.toWgsl("uniform")}

@group(0) @binding(0) var<uniform> perFrame: PerFrameUniforms;
@group(1) @binding(1) var<storage, read> instances: array<InstanceData>;
@group(2) @binding(0) var<uniform> water: WaterUniforms;

${WGSL_COLOR}
${WGSL_FOG}

struct WaterVertexInput {
  @location(0) position: vec3<f32>,
  @location(1) normal: vec3<f32>,
  @location(2) uv: vec2<f32>,
  @location(3) tangent: vec4<f32>,
}

struct WaterVertexOutput {
  @builtin(position) clipPos: vec4<f32>,
  @location(0) worldPos: vec3<f32>,
  @location(1) normal: vec3<f32>,
  @location(2) crest: f32,
  @location(3) viewDepth: f32,
}

@vertex
fn vertexMain(input: WaterVertexInput, @builtin(instance_index) instanceIndex: u32) -> WaterVertexOutput {
  let inst = instances[instanceIndex];
  let model = mat4x4<f32>(inst.row0, inst.row1, inst.row2, inst.row3);
  let base = (model * vec4<f32>(input.position, 1.0)).xyz;
  // The sampleGerstner sum with N = 4 (wavesB.y is Q = steepness/(k·A·4), precomputed per frame).
  var y = 0.0;
  var dx = 0.0;
  var dz = 0.0;
  var dydx = 0.0;
  var dydz = 0.0;
  var crestNum = 0.0;
  var crestDen = 0.0;
  for (var i = 0; i < 4; i++) {
    let a = water.wavesA[i];
    let b = water.wavesB[i];
    if (b.x <= 0.0) {
      continue;
    }
    let f = a.z * (a.x * base.x + a.y * base.z - a.w * water.time) + b.z;
    let s = sin(f);
    let c = cos(f);
    y += b.x * s;
    dx += b.y * b.x * a.x * c;
    dz += b.y * b.x * a.y * c;
    let slope = a.z * b.x * c;
    dydx += a.x * slope;
    dydz += a.y * slope;
    crestNum += (0.5 + 0.5 * c) * b.x;
    crestDen += b.x;
  }
  let displaced = base + vec3<f32>(dx, y, dz);
  var out: WaterVertexOutput;
  out.worldPos = displaced;
  out.normal = normalize(vec3<f32>(-dydx, 1.0, -dydz));
  out.crest = select(0.0, crestNum / crestDen, crestDen > 0.0);
  out.clipPos = perFrame.viewProj * vec4<f32>(displaced, 1.0);
  out.viewDepth = out.clipPos.w;
  return out;
}

fn waterHash(p: vec2<f32>) -> f32 {
  return fract(sin(dot(p, vec2<f32>(127.1, 311.7))) * 43758.5453123);
}

// One octave of value noise: breaks the foam edge so whitecaps read as patches, not contours.
fn waterNoise(p: vec2<f32>) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  let a = waterHash(i);
  let b = waterHash(i + vec2<f32>(1.0, 0.0));
  let c = waterHash(i + vec2<f32>(0.0, 1.0));
  let d = waterHash(i + vec2<f32>(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

@fragment
fn fragmentMain(in: WaterVertexOutput, @builtin(front_facing) frontFacing: bool) -> @location(0) vec4<f32> {
  var N = normalize(in.normal);
  if (!frontFacing) {
    N = -N;
  }
  let V = normalize(perFrame.cameraPosRender - in.worldPos);
  let ndv = max(dot(N, V), 0.0);
  // Schlick fresnel with F0 = 0.02 (water): grazing rays mirror the sky, steep rays show the body.
  let fresnel = 0.02 + 0.98 * pow(1.0 - ndv, 5.0);
  let body = mix(water.deepColor, water.shallowColor, clamp(in.crest * 0.5, 0.0, 1.0));
  let diffuse = body * (perFrame.ambientColor * perFrame.ambientIntensity + vec3<f32>(0.15));
  let R = reflect(-V, N);
  let sunDir = normalize(water.sunDirection);
  let rdotl = max(dot(R, sunDir), 0.0);
  let glint = water.sunTint * water.sunGlint * (pow(rdotl, 600.0) * 3.0 + pow(rdotl, 60.0) * 0.25);
  // The reflected sky: the horizon tint, lifted toward the zenith with the reflected elevation.
  let skyRef = water.skyTint * (0.55 + 0.45 * clamp(R.y, 0.0, 1.0));
  var color = mix(diffuse, skyRef, clamp(fresnel * 0.9, 0.0, 1.0)) + glint;
  let breakup = waterNoise(in.worldPos.xz * 1.5 + water.time * 0.35) - 0.5;
  let foamMask = smoothstep(water.foamThreshold, 1.0, clamp(in.crest + breakup * 0.25, 0.0, 1.0));
  color += water.foamColor * foamMask * 0.85;
  let fogT = fogTransmittance(length(in.worldPos - perFrame.cameraPosRender), perFrame.cameraPosRender.y, in.worldPos.y);
  color = mix(perFrame.fogColor, color, fogT);
  if ((perFrame.flags & 2u) != 0u) {
    return vec4<f32>(color, water.opacity);
  }
  color = color * perFrame.exposure;
  color = tonemap(color, perFrame.toneMapping);
  color = linearToSrgb(color);
  return vec4<f32>(color, water.opacity);
}
`;
