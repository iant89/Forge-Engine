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
 * sky tint). The shore is analytic, not read from the terrain's depth. Both are documented in
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
  // fe-35: displacement / local wave amplitude (−1 trough … +1 crest) for crest/trough shading.
  @location(5) heightN: f32,
}

// Still-water depth over the analytic shore bed; a huge value when the shore is off.
fn shoreDepth(xz: vec2<f32>) -> f32 {
  if (water.shoreB.w < 0.5) {
    return 1.0e6;
  }
  // fe-34 curvy coast (shoreCurveOffset): shoreD = (k1, phase1, amp1, dot(origin, perp)),
  // shoreE = (k2, phase2, amp2, dropOff); perp = (−dirZ, dirX).
  let across = dot(xz, vec2<f32>(-water.shoreA.y, water.shoreA.x)) - water.shoreD.w;
  let curve = water.shoreD.z * sin(water.shoreD.x * across + water.shoreD.y) + water.shoreE.z * sin(water.shoreE.x * across + water.shoreE.y);
  let along = dot(xz, water.shoreA.xy) - water.shoreA.z - curve;
  let d = water.shoreC.x - (water.shoreB.z + water.shoreA.w * along);
  // fe-35 shelf drop-off (shoreDropOff on the CPU): shoreE.w = dropOff.
  return d + water.shoreE.w * max(0.0, d - 2.0 * water.shoreB.y);
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
  for (var i = 0; i < 8; i++) {
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
  out.heightN = y / max(water.shoreC.z * max(shoal, 0.05), 0.01);
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
  let sunDir0 = normalize(water.sunDirection);
  // Schlick fresnel with F0 = 0.02 (water): grazing rays mirror the sky, steep rays show the body.
  let fresnel = 0.02 + 0.98 * pow(1.0 - ndv, 5.0);
  // Depth colour: shallow (sand showing through) to deep over colorDepth; crests lift it a little.
  let depth = shoreDepth(in.baseXZ);
  let deepness = 1.0 - exp(-max(depth, 0.0) / water.shoreC.y);
  let depthBody = mix(water.shallowColor, water.deepColor, select(1.0, deepness, water.shoreB.w > 0.5));
  let body = mix(depthBody, water.shallowColor, clamp(in.crest * 0.5, 0.0, 1.0) * select(1.0, 0.6, water.shoreB.w > 0.5));
  // fe-35 relief shading. Under an overcast sky the fresnel-mixed sky and body are nearly the same
  // dark grey, so a displaced swell rendered as a flat sheet. Three cues bring the height back:
  // troughs darken and crests lift (height), slopes facing the sky/light are lit and lee faces fall
  // into shade (a wrapped lambert against a sky-weighted key), and thin crests glow green-blue as
  // light scatters through them (subsurface).
  // Scaled by the sea's absolute size so a calm sea's ripples do not shade like storm swells.
  let h = clamp(in.heightN, -1.0, 1.0) * clamp(water.shoreC.z / 2.0, 0.25, 1.0);
  let keyDir = normalize(vec3<f32>(sunDir0.x, max(sunDir0.y, 0.0) + 0.9, sunDir0.z));
  let wrapLit = clamp(dot(N, keyDir) * 0.6 + 0.4, 0.0, 1.0);
  let relief = mix(0.45, 1.25, smoothstep(-0.9, 0.9, h)) * mix(0.55, 1.15, wrapLit);
  let sss = water.shallowColor * 0.9 * smoothstep(0.35, 1.0, h) * pow(1.0 - ndv, 2.0);
  let diffuse = body * (perFrame.ambientColor * perFrame.ambientIntensity + vec3<f32>(0.15)) * relief + sss;
  let R = reflect(-V, N);
  let sunDir = normalize(water.sunDirection);
  let rdotl = max(dot(R, sunDir), 0.0);
  // The deck's shadow reaches the water too (Phase 17.3): the glint is direct sun, so it is the
  // term a cloud takes away.
  let sunVisibility = cloudSunVisibility(in.worldPos, cloudFootprint);
  let glint = water.sunTint * water.sunGlint * sunVisibility * (pow(rdotl, 600.0) * 3.0 + pow(rdotl, 60.0) * 0.25);
  // The reflected sky: the horizon tint, lifted toward the zenith with the reflected elevation.
  // fe-35: troughs see less sky (the neighbouring crests occlude it) — a cheap horizon occlusion.
  // Under a storm deck the sky light's horizon tint is nearly as dark as the water body, so the
  // fresnel mix (the main slope cue at grazing angles) had no contrast; the reflected horizon is at
  // least the haze the eye sees there (the fog colour).
  let horizonRef = max(water.skyTint, perFrame.fogColor * 1.15);
  let skyRef = horizonRef * (0.55 + 0.45 * clamp(R.y, 0.0, 1.0)) * mix(0.6, 1.1, smoothstep(-1.0, 1.0, h));
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
  // fe-35: foam sits on the relief too — lit on the faces toward the sky, grey in the lee and the
  // troughs — so a white surf zone still shows its breaking wave shapes.
  let foamShade = mix(0.35, 1.1, wrapLit) * mix(0.6, 1.1, smoothstep(-0.8, 0.8, h));
  color = mix(color, water.foamColor * foamShade, clamp(foam, 0.0, 1.0));
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
