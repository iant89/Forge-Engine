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
 * Phase 17.5 screen-space mode (`water.screenA.x` > 0, HDR, `settings.water.screenSpace`): the
 * renderer skips water in `forge.main`, copies the opaque scene + sky and its depth in
 * `forge.water.grab`, and draws the water afterwards in `forge.water`. The fragment stage then
 * refracts the scene below (refracted-ray probe with an in-front fallback), absorbs it with the
 * real water column (Beer–Lambert, `water.absorption`), foams where the column over geometry is
 * thin, softens the contact edge, and in "full" mode replaces the sky reflection with a
 * screen-space ray march where it finds the scene. Off-screen content still reflects only the sky
 * (`docs/KNOWN-ISSUES.md`). With the mode off the program is the fe-35 sky-fresnel water.
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
  /** Phase 17.5: the opaque scene + sky colour behind the water (HDR), copied by `forge.water.grab`. */
  grabColor: { group: 2, binding: 1 },
  /** Phase 17.5: the opaque scene's raw depth (r32float), copied by `forge.water.grab`. */
  grabDepth: { group: 2, binding: 2 },
  grabSampler: { group: 2, binding: 3 },
} as const;

/**
 * Phase 17.5 `forge.water.grab`: one fullscreen triangle that copies the opaque scene + sky colour
 * and its depth (raw, as r32float — depth24plus cannot be copied or sampled while it is the water
 * pass's own depth attachment) into the two textures the screen-space water samples.
 */
export const WATER_GRAB_SHADER = /* wgsl */ `
@group(0) @binding(0) var sceneColor: texture_2d<f32>;
@group(0) @binding(1) var sceneDepth: texture_depth_2d;

struct GrabOut {
  @location(0) color: vec4<f32>,
  @location(1) depth: vec4<f32>,
}

@vertex
fn vertexMain(@builtin(vertex_index) index: u32) -> @builtin(position) vec4<f32> {
  let uv = vec2<f32>(f32((index << 1u) & 2u), f32(index & 2u));
  return vec4<f32>(uv * 2.0 - 1.0, 0.0, 1.0);
}

@fragment
fn fragmentMain(@builtin(position) position: vec4<f32>) -> GrabOut {
  let p = vec2<i32>(position.xy);
  var out: GrabOut;
  out.color = vec4<f32>(textureLoad(sceneColor, p, 0).rgb, 1.0);
  out.depth = vec4<f32>(textureLoad(sceneDepth, p, 0), 0.0, 0.0, 1.0);
  return out;
}
`;

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
@group(2) @binding(1) var grabColor: texture_2d<f32>;
@group(2) @binding(2) var grabDepth: texture_2d<f32>;
@group(2) @binding(3) var grabSampler: sampler;

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

// Phase 17.5 screen-space helpers. Pixel coordinates are render-target pixels (renderExtent).
fn ssDepthAt(pix: vec2<f32>) -> f32 {
  let size = vec2<i32>(textureDimensions(grabDepth));
  let c = clamp(vec2<i32>(pix), vec2<i32>(0, 0), size - vec2<i32>(1, 1));
  return textureLoad(grabDepth, c, 0).r;
}
fn ssWorldAt(pix: vec2<f32>, depth: f32) -> vec3<f32> {
  let uv = pix / perFrame.renderExtent;
  let h = perFrame.invViewProj * vec4<f32>(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, depth, 1.0);
  return h.xyz / h.w;
}
// World → (uv, depth); w < 0 marks a point behind the camera.
fn ssProject(p: vec3<f32>) -> vec4<f32> {
  let c = perFrame.viewProj * vec4<f32>(p, 1.0);
  let w = max(c.w, 1.0e-5);
  return vec4<f32>(c.x / w * 0.5 + 0.5, 0.5 - c.y / w * 0.5, c.z / w, sign(c.w));
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
  out.viewDepth = select(out.clipPos.w, dot(displaced - perFrame.cameraPosRender, perFrame.cameraForwardRender.xyz), perFrame.cameraForwardRender.w > 0.5);
  out.baseXZ = base.xz;
  out.heightN = y / max(water.shoreC.z * max(shoal, 0.05), 0.01);
  return out;
}

fn waterHash(p: vec2<f32>) -> f32 {
  return latticeHash(p, 0x7a7eu); // WGSL_CLOUD's exact integer hash (the sine hash is not portable)
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

// Depth-prepass entry: the water vertex deformation is shared with the colour pass, while the
// fragment does no shading because the prepass has no colour attachment. Keeping this entry in the
// water module lets screen-space water establish the same early-Z surface before its grab pass.
@fragment
fn fragmentDepth() {
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
  var transmitted = diffuse;
  var reflection = skyRef;
  var alpha = water.opacity;
  var edgeFoam = 0.0;
  if (water.screenA.x > 0.5) {
    // Phase 17.5 screen-space water: the scene behind the surface was copied by forge.water.grab.
    let extent = perFrame.renderExtent;
    let px = in.clipPos.xy;
    let cam = perFrame.cameraPosRender;
    let rawD = ssDepthAt(px);
    let open = rawD >= 0.99999;
    let behind = ssWorldAt(px, rawD);
    let column0 = select(length(behind - in.worldPos), 1.0e4, open);
    // Refraction: follow the refracted ray (n = 1.33) a column's length and read the scene where it
    // lands. A probe that lands on something in front of the water (an object above it) would leak
    // that object into the water, so it falls back to the straight-through pixel.
    let Rt = refract(-V, N, 0.75);
    let probe = in.worldPos + Rt * clamp(column0, 0.0, 6.0) * water.screenA.y;
    let pr = ssProject(probe);
    var uvR = pr.xy;
    var rawR = ssDepthAt(uvR * extent);
    if (pr.w < 0.0 || any(uvR < vec2<f32>(0.0)) || any(uvR > vec2<f32>(1.0)) || rawR < in.clipPos.z) {
      uvR = px / extent;
      rawR = rawD;
    }
    let behindR = ssWorldAt(uvR * extent, rawR);
    let column = select(length(behindR - in.worldPos), 1.0e4, rawR >= 0.99999);
    // Depth-dependent absorption (Beer–Lambert along the view path through the water); what is
    // absorbed is replaced by the body's own in-scattered colour.
    let T = exp(-water.absorption.rgb * column);
    let under = textureSampleLevel(grabColor, grabSampler, uvR, 0.0).rgb;
    transmitted = under * T + diffuse * (vec3<f32>(1.0) - T);
    // Intersection foam: a thin water column over geometry (rocks, piers, hulls, the beach).
    let vertical = select(max(in.worldPos.y - behind.y, 0.0), 1.0e4, open);
    if (water.screenA.z > 0.0) {
      let lace = waterNoise(in.worldPos.xz * 2.4 + vec2<f32>(water.time * 0.3, -water.time * 0.21));
      edgeFoam = (1.0 - smoothstep(0.0, water.screenA.z, vertical)) * (0.45 + 0.55 * lace);
    }
    // Soft contact instead of a hard intersection line.
    alpha = smoothstep(0.0, 0.08, vertical);
    if (water.screenA.x > 1.5 && R.y > -0.05) {
      // Screen-space reflection: march the reflected ray in growing steps, stop where it passes
      // behind the depth buffer within a thickness tolerance, fade at the screen edges and with
      // march length. Anything it cannot find on screen stays the sky reflection.
      var t = 0.3;
      for (var i = 0; i < 40; i = i + 1) {
        t = t * 1.16 + 0.35;
        let p = in.worldPos + R * t;
        let q = ssProject(p);
        if (q.w < 0.0 || any(q.xy < vec2<f32>(0.0)) || any(q.xy > vec2<f32>(1.0))) {
          break;
        }
        let sd = ssDepthAt(q.xy * extent);
        if (sd < 0.99999 && q.z > sd) {
          let sp = ssWorldAt(q.xy * extent, sd);
          if (length(p - cam) - length(sp - cam) < max(0.75, t * 0.3)) {
            let edge = q.xy * 2.0 - 1.0;
            let fade = (1.0 - smoothstep(0.8, 1.0, max(abs(edge.x), abs(edge.y)))) * (1.0 - f32(i) / 40.0);
            let hit = textureSampleLevel(grabColor, grabSampler, q.xy, 0.0).rgb;
            reflection = mix(skyRef, hit, clamp(fade, 0.0, 1.0));
          }
          break;
        }
      }
    }
  }
  var color = mix(transmitted, reflection, clamp(fresnel * 0.9, 0.0, 1.0)) + glint;
  let breakup = waterNoise(in.worldPos.xz * 1.5 + water.time * 0.35) - 0.5;
  let foamMask = smoothstep(water.foamThreshold, 1.0, clamp(in.crest + breakup * 0.25, 0.0, 1.0));
  var foam = max(foamMask * 0.85, edgeFoam);
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
