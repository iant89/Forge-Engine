/**
 * Post-process shader for the HDR path: bloom (prefilter → downsample chain → additive upsample) and
 * the tonemap resolve that writes the swapchain. One module, one bind group layout, four fragment
 * entry points — the pipeline factory keys on the entry point.
 *
 * Bloom follows Jimenez, "Next Generation Post Processing in Call of Duty: Advanced Warfare"
 * (SIGGRAPH 2014): a 13-tap downsample that is stable under motion, a Karis average on the first
 * mip so a single hot pixel cannot flash the whole screen, a soft-knee threshold, and a 3×3 tent
 * upsample accumulated back up the chain with additive blending. The chain works on linear
 * scene-referred colour *after exposure*, so a threshold of 1.0 means "brighter than display white".
 *
 * The tonemap entry applies exposure, adds bloom, tone-maps and sRGB-encodes with exactly the same
 * functions the forward shader uses in LDR mode (`shaders/common.ts`), so toggling HDR does not
 * change the look of a scene without highlights.
 *
 * Bindings (group 0): 0 `PostUniforms` (dynamic offset), 1 source texture, 2 second texture (bloom
 * at composite; bound to the source otherwise), 3 linear clamp sampler, 4 resolved prepass depth,
 * and 5 `PerFrameUniforms` for view-depth reconstruction in the optional final haze.
 */

import { PerFrameUniforms, PostUniforms } from "../uniforms.js";
import { WGSL_COLOR, WGSL_FULLSCREEN_VERTEX } from "./common.js";

export const POST_BINDINGS = {
  uniforms: { group: 0, binding: 0 },
  source: { group: 0, binding: 1 },
  second: { group: 0, binding: 2 },
  sampler: { group: 0, binding: 3 },
  depth: { group: 0, binding: 4 },
  perFrame: { group: 0, binding: 5 },
} as const;

export const POST_FLAG_BLOOM = 1;
export const POST_FLAG_KARIS = 2;
export const POST_FLAG_NO_TONEMAP = 4;
export const POST_FLAG_PASSTHROUGH = 8;
/** The tonemap resolve reads the prepass depth for the opt-in far-field haze. */
export const POST_FLAG_DEPTH_HAZE = 16;

export const POST_SHADER = /* wgsl */ `
${PostUniforms.toWgsl("uniform")}
${PerFrameUniforms.toWgsl("uniform")}

${WGSL_COLOR}

${WGSL_FULLSCREEN_VERTEX}

@group(0) @binding(0) var<uniform> post: PostUniforms;
@group(0) @binding(1) var srcTex: texture_2d<f32>;
@group(0) @binding(2) var secondTex: texture_2d<f32>;
@group(0) @binding(3) var linearSampler: sampler;
@group(0) @binding(4) var depthTex: texture_2d<f32>;
@group(0) @binding(5) var<uniform> perFrame: PerFrameUniforms;

const FLAG_BLOOM: u32 = 1u;
const FLAG_KARIS: u32 = 2u;
const FLAG_NO_TONEMAP: u32 = 4u;
const FLAG_DEPTH_HAZE: u32 = 16u;

// fe-17: a non-finite texel in the HDR chain would reach every bloom mip and the tonemap and turn
// the frame black around it, so it reads as zero here. Exponent bits, not x != x (WebKit fast math).
fn postFinite(x: f32) -> bool {
  return (bitcast<u32>(x) & 0x7f800000u) != 0x7f800000u;
}
fn sampleSrc(uv: vec2<f32>) -> vec3<f32> {
  let c = textureSampleLevel(srcTex, linearSampler, uv, 0.0).rgb;
  return select(vec3<f32>(0.0), max(c, vec3<f32>(0.0)), postFinite(c.x) && postFinite(c.y) && postFinite(c.z));
}

// Weight that pulls fireflies down when averaging a 2x2 quad (Karis 2013).
fn karisWeight(c: vec3<f32>) -> f32 {
  return 1.0 / (1.0 + luminance(c));
}

fn quadAverage(a: vec3<f32>, b: vec3<f32>, c: vec3<f32>, d: vec3<f32>, karis: bool) -> vec3<f32> {
  if (!karis) {
    return (a + b + c + d) * 0.25;
  }
  let wa = karisWeight(a);
  let wb = karisWeight(b);
  let wc = karisWeight(c);
  let wd = karisWeight(d);
  return (a * wa + b * wb + c * wc + d * wd) / max(wa + wb + wc + wd, 1e-4);
}

// 13-tap downsample: four overlapping 2x2 quads at half-texel offsets (weight 0.5 total) plus the
// 3x3 grid at whole-texel offsets (weight 0.5 total). Partial-quad weighting makes it stable under
// sub-pixel motion, which a plain bilinear 2x2 is not.
fn downsample13(uv: vec2<f32>, texel: vec2<f32>, karis: bool) -> vec3<f32> {
  let a = sampleSrc(uv + texel * vec2<f32>(-2.0, -2.0));
  let b = sampleSrc(uv + texel * vec2<f32>(0.0, -2.0));
  let c = sampleSrc(uv + texel * vec2<f32>(2.0, -2.0));
  let d = sampleSrc(uv + texel * vec2<f32>(-2.0, 0.0));
  let e = sampleSrc(uv);
  let f = sampleSrc(uv + texel * vec2<f32>(2.0, 0.0));
  let g = sampleSrc(uv + texel * vec2<f32>(-2.0, 2.0));
  let h = sampleSrc(uv + texel * vec2<f32>(0.0, 2.0));
  let i = sampleSrc(uv + texel * vec2<f32>(2.0, 2.0));
  let j = sampleSrc(uv + texel * vec2<f32>(-1.0, -1.0));
  let k = sampleSrc(uv + texel * vec2<f32>(1.0, -1.0));
  let l = sampleSrc(uv + texel * vec2<f32>(-1.0, 1.0));
  let m = sampleSrc(uv + texel * vec2<f32>(1.0, 1.0));
  var color = quadAverage(j, k, l, m, karis) * 0.5;
  color = color + quadAverage(a, b, d, e, karis) * 0.125;
  color = color + quadAverage(b, c, e, f, karis) * 0.125;
  color = color + quadAverage(d, e, g, h, karis) * 0.125;
  color = color + quadAverage(e, f, h, i, karis) * 0.125;
  return color;
}

// Soft-knee threshold: zero below (threshold - knee), the full excess above threshold, and a
// quadratic blend in between so the bloom does not pop on as a surface brightens.
fn softThreshold(c: vec3<f32>, threshold: f32, knee: f32) -> vec3<f32> {
  let br = max(max(c.r, c.g), c.b);
  let k = max(threshold * knee, 1e-4);
  var soft = clamp(br - threshold + k, 0.0, 2.0 * k);
  soft = soft * soft / (4.0 * k);
  let contribution = max(soft, br - threshold) / max(br, 1e-4);
  return c * contribution;
}

@fragment
fn fsPrefilter(in: FullscreenOut) -> @location(0) vec4<f32> {
  let karis = (post.flags & FLAG_KARIS) != 0u;
  let c = downsample13(in.uv, post.texelSize, karis) * post.exposure;
  return vec4<f32>(softThreshold(c, post.threshold, post.knee), 1.0);
}

@fragment
fn fsDownsample(in: FullscreenOut) -> @location(0) vec4<f32> {
  return vec4<f32>(downsample13(in.uv, post.texelSize, false), 1.0);
}

// 3x3 tent filter; the pipeline blends this additively onto the finer mip, so the result at mip N
// is D(N) + tent(U(N+1)) all the way up the chain.
@fragment
fn fsUpsample(in: FullscreenOut) -> @location(0) vec4<f32> {
  let t = post.texelSize * post.radius;
  var c = sampleSrc(in.uv + vec2<f32>(-t.x, -t.y));
  c = c + sampleSrc(in.uv + vec2<f32>(0.0, -t.y)) * 2.0;
  c = c + sampleSrc(in.uv + vec2<f32>(t.x, -t.y));
  c = c + sampleSrc(in.uv + vec2<f32>(-t.x, 0.0)) * 2.0;
  c = c + sampleSrc(in.uv) * 4.0;
  c = c + sampleSrc(in.uv + vec2<f32>(t.x, 0.0)) * 2.0;
  c = c + sampleSrc(in.uv + vec2<f32>(-t.x, t.y));
  c = c + sampleSrc(in.uv + vec2<f32>(0.0, t.y)) * 2.0;
  c = c + sampleSrc(in.uv + vec2<f32>(t.x, t.y));
  return vec4<f32>(c / 16.0, 1.0);
}

// Phase 13.1: the final resolve may apply a deliberately opt-in, low-frequency haze using the
// same opaque depth the transparent pass sees. Reconstructing view depth (rather than comparing
// nonlinear NDC values) keeps the range meaningful for both perspective and orthographic cameras.
fn postViewDepth(uv: vec2<f32>, depth: f32) -> f32 {
  let clip = vec4<f32>(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, depth, 1.0);
  let worldH = perFrame.invViewProj * clip;
  let world = worldH.xyz / max(abs(worldH.w), 1e-6);
  return max(dot(world - perFrame.cameraPosRender, perFrame.cameraForwardRender.xyz), 0.0);
}

fn postDepthHaze(uv: vec2<f32>) -> f32 {
  if ((post.flags & FLAG_DEPTH_HAZE) == 0u) {
    return 0.0;
  }
  let size = vec2<i32>(textureDimensions(depthTex));
  let p = clamp(vec2<i32>(uv * vec2<f32>(size)), vec2<i32>(0, 0), size - vec2<i32>(1, 1));
  let viewDepth = postViewDepth(uv, textureLoad(depthTex, p, 0).r);
  let start = post.depthRange.x;
  let end = max(post.depthRange.y, start + 1.0);
  return smoothstep(start, end, viewDepth) * clamp(post.depthStrength, 0.0, 1.0);
}

@fragment
fn fsTonemap(in: FullscreenOut) -> @location(0) vec4<f32> {
  var color = sampleSrc(in.uv) * post.exposure;
  let haze = postDepthHaze(in.uv);
  color = mix(color, post.depthColor * post.exposure, haze);
  if ((post.flags & FLAG_BLOOM) != 0u) {
    color = color + textureSampleLevel(secondTex, linearSampler, in.uv, 0.0).rgb * post.intensity;
  }
  if ((post.flags & FLAG_NO_TONEMAP) == 0u) {
    color = tonemap(color, post.toneMapping);
  }
  return vec4<f32>(linearToSrgb(color), 1.0);
}
`;
