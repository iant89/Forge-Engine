/**
 * Screen-space ambient occlusion over the depth prepass (Phase 13.1).
 *
 * Estimator: normal-oriented hemisphere obscurance over a screen-space spiral (the sampling of
 * "Scalable Ambient Obscurance", McGuire, Mara, Luebke — HPG 2012). Each pixel takes a spiral of
 * taps around itself, rebuilds every tap's view-space position from the prepass depth, and
 * accumulates how far above its tangent plane the tap sits — the cosine `(v·n − bias) / |v|`, less a
 * small angle bias — weighted by a gentle `1 − v·v / r²` falloff. (SAO's own `(r² − v·v)³ / (v·v)`
 * weighting all but ignores occluders beyond half the radius: the first real-GPU run of this pass
 * darkened the PBR fixture by 0.04 %.) Nothing but depth is needed: the surface normal is rebuilt
 * from the neighbouring depth texels, picking per axis the neighbour on the same surface (the
 * smaller depth step) so silhouettes do not smear a normal across a gap, and it is oriented toward
 * the camera so the result never depends on the projection's handedness or on the screen's y
 * direction.
 *
 * The estimate runs at half resolution with a per-pixel spiral rotation (interleaved gradient
 * noise, Jimenez 2014); a separable depth-aware Gaussian (`fsBlurH` then `fsBlurV`) removes the
 * noise without bleeding across depth edges. The forward shader then upsamples with a 2×2 bilateral
 * fetch against its own view depth and applies the result to the ambient term only — direct light
 * already has shadow maps.
 *
 * Output (`rg16float`): r = visibility in [0, 1] (1 = unoccluded), g = the texel's view depth — the
 * bilateral key the blur and the forward pass compare against. Pixels without geometry carry
 * `SKY_KEY` (stored as 64 992 — f16 rounding — so it is tested against half its value), which no
 * surface depth ever matches.
 *
 * Bindings (group 0): 0 `SsaoUniforms`; 1 the prepass depth (used by `fsSsao` only); 2 the AO texture
 * being blurred (used by the blur entries only). The two sets have their own bind group layouts;
 * one module holds all three entry points.
 */

import { SsaoUniforms } from "../uniforms.js";
import { WGSL_FULLSCREEN_VERTEX } from "./common.js";

export const SSAO_BINDINGS = {
  uniforms: { group: 0, binding: 0 },
  depth: { group: 0, binding: 1 },
  ao: { group: 0, binding: 2 },
} as const;

/** View depth written for pixels the prepass left at the far plane (fits in an f16: max 65504). */
export const SSAO_SKY_KEY = 65000;

export type SsaoEntryPoint = "fsSsao" | "fsBlurH" | "fsBlurV";

export const SSAO_SHADER = /* wgsl */ `
${SsaoUniforms.toWgsl("uniform")}

${WGSL_FULLSCREEN_VERTEX}

@group(0) @binding(0) var<uniform> ssao: SsaoUniforms;
@group(0) @binding(1) var depthTex: texture_depth_2d;
@group(0) @binding(2) var aoTex: texture_2d<f32>;

const SKY_KEY: f32 = ${SSAO_SKY_KEY.toFixed(1)};
const TWO_PI: f32 = 6.283185307179586;
// Spiral turns: coprime with the usual sample counts so taps do not line up on one ray.
const SPIRAL_TURNS: f32 = 7.0;
const MAX_SAMPLES: u32 = 32u;
const BLUR_RADIUS: i32 = 4;
const BLUR_SIGMA: f32 = 2.5;
// Taps less than ~6° above the tangent plane do not count: depth quantisation tilts rebuilt normals
// by about that much on distant ground, and max(0, ·) would otherwise turn that noise into a grey veil.
const ANGLE_BIAS: f32 = 0.1;

fn clampToDepth(p: vec2<i32>) -> vec2<i32> {
  return clamp(p, vec2<i32>(0, 0), vec2<i32>(ssao.depthSize) - vec2<i32>(1, 1));
}

// View-space position of depth texel p (at the texel centre) given its stored depth.
fn viewPosition(p: vec2<i32>, depth: f32) -> vec3<f32> {
  let uv = (vec2<f32>(p) + vec2<f32>(0.5, 0.5)) / ssao.depthSize;
  let clip = vec4<f32>(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, depth, 1.0);
  let v = ssao.invProj * clip;
  return v.xyz / v.w;
}

fn viewPositionAt(p: vec2<i32>) -> vec3<f32> {
  let q = clampToDepth(p);
  return viewPosition(q, textureLoad(depthTex, q, 0));
}

fn reconstructNormal(p: vec2<i32>, c: vec3<f32>) -> vec3<f32> {
  let l = viewPositionAt(p + vec2<i32>(-1, 0));
  let r = viewPositionAt(p + vec2<i32>(1, 0));
  let u = viewPositionAt(p + vec2<i32>(0, -1));
  let d = viewPositionAt(p + vec2<i32>(0, 1));
  var dx = r - c;
  if (abs(c.z - l.z) < abs(r.z - c.z)) {
    dx = c - l;
  }
  var dy = d - c;
  if (abs(c.z - u.z) < abs(d.z - c.z)) {
    dy = c - u;
  }
  let n = cross(dx, dy);
  let len2 = dot(n, n);
  if (len2 < 1e-30) {
    return -normalize(c);
  }
  var nn = n * inverseSqrt(len2);
  // The camera is the view-space origin: a visible surface faces it.
  if (dot(nn, c) > 0.0) {
    nn = -nn;
  }
  return nn;
}

fn interleavedGradientNoise(p: vec2<f32>) -> f32 {
  return fract(52.9829189 * fract(dot(p, vec2<f32>(0.06711056, 0.00583715))));
}

@fragment
fn fsSsao(in: FullscreenOut) -> @location(0) vec4<f32> {
  // The depth texel under this AO texel (each AO texel covers a 2×2 depth block).
  let scale = ssao.depthSize / ssao.aoSize;
  let p = clampToDepth(vec2<i32>(floor(in.pos.xy * scale)));
  let depth = textureLoad(depthTex, p, 0);
  if (depth >= 1.0) {
    return vec4<f32>(1.0, SKY_KEY, 0.0, 1.0);
  }
  let c = viewPosition(p, depth);
  let n = reconstructNormal(p, c);
  let radius = ssao.radius;
  let r2 = radius * radius;
  var screenRadius = ssao.projScale * radius / max(c.z, 1e-4);
  if (screenRadius < 1.0) {
    // The whole kernel fits inside one pixel: nothing resolvable can occlude.
    return vec4<f32>(1.0, c.z, 0.0, 1.0);
  }
  screenRadius = min(screenRadius, ssao.maxPixels);
  let count = clamp(ssao.sampleCount, 1u, MAX_SAMPLES);
  let spin = interleavedGradientNoise(in.pos.xy) * TWO_PI;
  var sum = 0.0;
  for (var i = 0u; i < count; i = i + 1u) {
    let alpha = (f32(i) + 0.5) / f32(count);
    let angle = alpha * SPIRAL_TURNS * TWO_PI + spin;
    let offset = vec2<f32>(cos(angle), sin(angle)) * (alpha * screenRadius);
    let q = clampToDepth(p + vec2<i32>(round(offset)));
    let v = viewPosition(q, textureLoad(depthTex, q, 0)) - c;
    let vv = dot(v, v);
    let vn = dot(v, n);
    let falloff = max(1.0 - vv / r2, 0.0);
    sum = sum + falloff * max((vn - ssao.bias) * inverseSqrt(vv + 1e-4) - ANGLE_BIAS, 0.0);
  }
  // Each term is a cosine × falloff in [0, 1]. At most half of an open neighbourhood can rise above
  // the tangent plane, hence 2 / N: the base of a wall comes out near 0.65, a deep crease near 0.
  let occlusion = 2.0 * ssao.intensity * sum / f32(count);
  return vec4<f32>(clamp(1.0 - occlusion, 0.0, 1.0), c.z, 0.0, 1.0);
}

// Separable depth-aware Gaussian at AO resolution: taps on another surface (relative depth
// difference above 1 / sharpness) get zero weight, so occlusion never bleeds across a silhouette.
fn bilateralBlur(pixel: vec2<i32>, dir: vec2<i32>) -> vec4<f32> {
  let last = vec2<i32>(ssao.aoSize) - vec2<i32>(1, 1);
  let centre = textureLoad(aoTex, pixel, 0);
  let key = centre.g;
  if (key >= 0.5 * SKY_KEY) {
    return vec4<f32>(1.0, key, 0.0, 1.0);
  }
  var sum = centre.r;
  var total = 1.0;
  for (var r = 1; r <= BLUR_RADIUS; r = r + 1) {
    let gauss = exp(-f32(r * r) / (2.0 * BLUR_SIGMA * BLUR_SIGMA));
    for (var s = -1; s <= 1; s = s + 2) {
      let q = clamp(pixel + dir * (r * s), vec2<i32>(0, 0), last);
      let tap = textureLoad(aoTex, q, 0);
      let w = gauss * max(0.0, 1.0 - ssao.sharpness * abs(tap.g - key) / max(key, 1e-3));
      sum = sum + tap.r * w;
      total = total + w;
    }
  }
  return vec4<f32>(sum / total, key, 0.0, 1.0);
}

@fragment
fn fsBlurH(in: FullscreenOut) -> @location(0) vec4<f32> {
  return bilateralBlur(vec2<i32>(in.pos.xy), vec2<i32>(1, 0));
}

@fragment
fn fsBlurV(in: FullscreenOut) -> @location(0) vec4<f32> {
  return bilateralBlur(vec2<i32>(in.pos.xy), vec2<i32>(0, 1));
}
`;
