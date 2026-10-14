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
 * fe-33 ocean: `water.shoreA/B/C` describe an analytic sloped seabed (`scene.settings.water.shore`).
 * The vertex stage scales every wave by `shoalFactor(depth)` (the CPU twin in
 * `environment/water.ts`), so waves steepen toward the break line and die in the surf; the fragment
 * stage colours the body by depth (shallow → deep over `colorDepth`), whitens breaking crests in
 * the surf zone, lays an animated swash-foam band at the waterline and feathers the opacity to the
 * sand. Choppiness is folded into each wave's Q on the CPU.
 *
 * What this is not: there is no screen-space reflection or refraction of the scene (no planar
 * pass, no depth sampling — the "refraction" is the fresnel-mixed body colour plus the reflected
 * sky gradient). The shore is analytic, not read from the terrain's depth. Both are documented in
 * `docs/KNOWN-ISSUES.md`.
 *
 * Bind groups reuse the standard program's frame (group 0) and draw (group 1) layouts and add
 * the water block as group 2. The vertex stage always reads the instance matrix
 * (`instance_index` is 0 for non-instanced draws), so one entry point covers both paths.
 */

import { PerFrameUniforms, SkyUniforms, CloudUniforms, InstanceStruct, WaterUniforms } from "../uniforms.js";
import { WGSL_AERIAL_PERSPECTIVE, WGSL_ATMOSPHERE_FUNCTIONS, WGSL_COLOR, WGSL_FOG } from "./common.js";
import { WGSL_ATMOSPHERE_COMMON, wgslMultiScatteringSampler } from "./multiScattering.js";
import { WGSL_CLOUD } from "./cloudLayer.js";
import { BINDINGS } from "./standard.js";

/** Group/binding map of the water program (frame + draw are shared with the standard program). */
export const WATER_BINDINGS = {
  perFrame: { group: 0, binding: 0 },
  instances: { group: 1, binding: 1 },
  water: { group: 2, binding: 0 },
} as const;

export const WATER_SHADER = /* wgsl */ `
${PerFrameUniforms.toWgsl("uniform")}
${SkyUniforms.toWgsl("uniform")}
${CloudUniforms.toWgsl("uniform")}

${InstanceStruct.toWgsl("storage")}

${WaterUniforms.toWgsl("uniform")}

@group(0) @binding(0) var<uniform> perFrame: PerFrameUniforms;
@group(0) @binding(${BINDINGS.sky.binding}) var<uniform> sky: SkyUniforms;
@group(0) @binding(${BINDINGS.cloud.binding}) var<uniform> cloud: CloudUniforms;
@group(1) @binding(1) var<storage, read> instances: array<InstanceData>;
@group(2) @binding(0) var<uniform> water: WaterUniforms;

const PI: f32 = 3.141592653589793;

${WGSL_COLOR}
${WGSL_FOG}
${WGSL_ATMOSPHERE_FUNCTIONS}
${WGSL_ATMOSPHERE_COMMON}
${wgslMultiScatteringSampler(BINDINGS.multiScattering.binding)}
${WGSL_AERIAL_PERSPECTIVE}
${WGSL_CLOUD}

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
  @location(4) baseXZ: vec2<f32>,
}

// Still-water depth over the analytic shore bed; a huge value when the shore is off.
fn shoreDepth(xz: vec2<f32>) -> f32 {
  if (water.shoreB.w < 0.5) {
    return 1.0e6;
  }
  let along = dot(xz, water.shoreA.xy) - water.shoreA.z;
  return water.shoreC.x - (water.shoreB.z + water.shoreA.w * along);
}

// Twin of shoalFactor() in environment/water.ts.
fn shoalFactor(depth: f32) -> f32 {
  if (depth <= 0.0) {
    return 0.0;
  }
  let b = max(1.0e-3, water.shoreB.y);
  if (depth >= 3.0 * b) {
    return 1.0;
  }
  if (depth >= b) {
    return 1.0 + 0.3 * (1.0 - (depth - b) / (2.0 * b));
  }
  let u = depth / b;
  return 1.3 * u * u * (3.0 - 2.0 * u);
}

// shoalFactor() with the depth-limited breaking cap (H ≤ 0.78·d), as on the CPU.
fn shoalLimited(depth: f32) -> f32 {
  var s = shoalFactor(depth);
  if (water.shoreC.z > 0.0) {
    s = min(s, 0.39 * max(depth, 0.0) / water.shoreC.z);
  }
  return s;
}

@vertex
fn vertexMain(input: WaterVertexInput, @builtin(instance_index) instanceIndex: u32) -> WaterVertexOutput {
  let inst = instances[instanceIndex];
  let model = mat4x4<f32>(inst.row0, inst.row1, inst.row2, inst.row3);
  let base = (model * vec4<f32>(input.position, 1.0)).xyz;
  // The bounded sampleGerstner sum (wavesB.y contains Q, normalised by the active count on CPU).
  var y = 0.0;
  var dx = 0.0;
  var dz = 0.0;
  var dxdx = 1.0;
  var dxdz = 0.0;
  var dzdx = 0.0;
  var dzdz = 1.0;
  var dydx = 0.0;
  var dydz = 0.0;
  var crestNum = 0.0;
  var crestDen = 0.0;
  let shoal = shoalLimited(shoreDepth(base.xz));
  for (var i = 0; i < 4; i++) {
    let a = water.wavesA[i];
    let b = water.wavesB[i];
    if (b.x <= 0.0) {
      continue;
    }
    let amp = b.x * shoal;
    let f = a.z * (a.x * base.x + a.y * base.z - a.w * water.time) + b.z;
    let s = sin(f);
    let c = cos(f);
    y += amp * s;
    dx += b.y * amp * a.x * c;
    dz += b.y * amp * a.y * c;
    let horizontalDerivative = b.y * amp * a.z * s;
    dxdx -= horizontalDerivative * a.x * a.x;
    dxdz -= horizontalDerivative * a.x * a.y;
    dzdx -= horizontalDerivative * a.x * a.y;
    dzdz -= horizontalDerivative * a.y * a.y;
    let slope = a.z * amp * c;
    dydx += a.x * slope;
    dydz += a.y * slope;
    crestNum += (0.5 + 0.5 * c) * b.x;
    crestDen += b.x;
  }
  let displaced = base + vec3<f32>(dx, y, dz);
  var out: WaterVertexOutput;
  out.worldPos = displaced;
  let tangentX = vec3<f32>(dxdx, dydx, dzdx);
  let tangentZ = vec3<f32>(dxdz, dydz, dzdz);
  out.normal = normalize(cross(tangentZ, tangentX));
  out.crest = select(0.0, crestNum / crestDen, crestDen > 0.0);
  out.clipPos = perFrame.viewProj * vec4<f32>(displaced, 1.0);
  out.viewDepth = out.clipPos.w;
  out.baseXZ = base.xz;
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
  // The deck's shadow's sampling footprint: a derivative, so it is taken before the branches below.
  let cloudFootprint = cloudSurfaceFootprint(in.worldPos);
  var N = normalize(in.normal);
  if (!frontFacing) {
    N = -N;
  }
  let V = normalize(perFrame.cameraPosRender - in.worldPos);
  let ndv = max(dot(N, V), 0.0);
  // Schlick fresnel with F0 = 0.02 (water): grazing rays mirror the sky, steep rays show the body.
  let fresnel = 0.02 + 0.98 * pow(1.0 - ndv, 5.0);
  // Depth colour: shallow (sand showing through) to deep over colorDepth; crests lift it a little.
  let depth = shoreDepth(in.baseXZ);
  let deepness = 1.0 - exp(-max(depth, 0.0) / water.shoreC.y);
  let depthBody = mix(water.shallowColor, water.deepColor, select(1.0, deepness, water.shoreB.w > 0.5));
  let body = mix(depthBody, water.shallowColor, clamp(in.crest * 0.5, 0.0, 1.0) * 0.6);
  let diffuse = body * (perFrame.ambientColor * perFrame.ambientIntensity + vec3<f32>(0.15));
  let R = reflect(-V, N);
  let sunDir = normalize(water.sunDirection);
  let rdotl = max(dot(R, sunDir), 0.0);
  // The deck's shadow reaches the water too (Phase 17.3): the glint is direct sun, so it is the
  // term a cloud takes away.
  let sunVisibility = cloudSunVisibility(in.worldPos, cloudFootprint);
  let glint = water.sunTint * water.sunGlint * sunVisibility * (pow(rdotl, 600.0) * 3.0 + pow(rdotl, 60.0) * 0.25);
  // The reflected sky: the horizon tint, lifted toward the zenith with the reflected elevation.
  let skyRef = mix(water.skyTint, max(water.skyZenith, water.skyTint * 0.55), clamp(R.y, 0.0, 1.0));
  var color = mix(diffuse, skyRef, clamp(fresnel * 0.9, 0.0, 1.0)) + glint;
  let breakup = waterNoise(in.worldPos.xz * 1.5 + water.time * 0.35) - 0.5;
  let foamMask = smoothstep(water.foamThreshold, 1.0, clamp(in.crest + breakup * 0.25, 0.0, 1.0));
  var foam = foamMask * 0.85;
  var alpha = water.opacity;
  if (water.shoreB.w > 0.5) {
    // Breaking crests across the surf zone, then the swash band hugging the waterline.
    let b = max(1.0e-3, water.shoreB.y);
    let fd = max(1.0e-3, water.shoreB.x);
    let surf = (1.0 - smoothstep(0.0, 1.0, (depth - b) / (0.5 * b))) * smoothstep(0.0, 1.0, depth / fd);
    let breaking = surf * clamp((in.crest - 0.6) * 2.5, 0.0, 1.0) * water.shoreC.w;
    let streak = waterNoise(in.worldPos.xz * vec2<f32>(0.6, 2.2) + vec2<f32>(water.time * 0.2, water.time * 0.9));
    let swash = (1.0 - smoothstep(0.0, 1.0, depth / fd)) * (0.55 + 0.45 * streak) * (0.35 + 0.65 * water.shoreC.w);
    foam = max(foam, max(breaking * (0.7 + 0.3 * streak), swash));
    // Feather into the sand instead of a hard intersection line.
    alpha = alpha * smoothstep(0.0, 0.12, depth + 0.02);
  }
  color += water.foamColor * clamp(foam, 0.0, 1.0) * (perFrame.ambientIntensity * 0.5 + 0.5);
  let fogT = fogTransmittance(length(in.worldPos - perFrame.cameraPosRender), perFrame.cameraPosRender.y, in.worldPos.y);
  color = mix(perFrame.fogColor, color, fogT);
  color = applyAerialPerspective(color, in.worldPos);
  if ((perFrame.flags & 2u) != 0u) {
    return vec4<f32>(color, alpha);
  }
  color = color * perFrame.exposure;
  color = tonemap(color, perFrame.toneMapping);
  color = linearToSrgb(color);
  return vec4<f32>(color, alpha);
}
`;
