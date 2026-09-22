/**
 * WGSL snippets shared by more than one shader module.
 *
 * The forward shader (LDR path) and the post-process shader (HDR path) must tone-map and encode
 * identically, or toggling `scene.settings.hdr` would change the look of a scene. Keeping one copy
 * of each function is what guarantees that. Everything here is plain WGSL text with no bindings, so
 * it can be pasted into any module; `check:wgsl` validates every module that embeds it.
 */

/** `linearToSrgb`, `luminance` and the tone-mapping operators (`mode`: 0 none, 1 reinhard, 2 aces, 3 filmic). */
export const WGSL_COLOR = /* wgsl */ `
fn linearToSrgb(c: vec3<f32>) -> vec3<f32> {
  let lo = c * 12.92;
  let hi = 1.055 * pow(max(c, vec3<f32>(0.0)), vec3<f32>(1.0 / 2.4)) - 0.055;
  return select(hi, lo, c <= vec3<f32>(0.0031308));
}

fn luminance(c: vec3<f32>) -> f32 {
  return dot(c, vec3<f32>(0.2126, 0.7152, 0.0722));
}

fn tonemapAces(c: vec3<f32>) -> vec3<f32> {
  // ACES filmic (Narkowicz fit) — the engine default: keeps highlight roll-off smooth.
  let a = 2.51;
  let b = 0.03;
  let cc = 2.43;
  let d = 0.59;
  let e = 0.14;
  return clamp((c * (a * c + b)) / (c * (cc * c + d) + e), vec3<f32>(0.0), vec3<f32>(1.0));
}

fn tonemapFilmic(c: vec3<f32>) -> vec3<f32> {
  // Hable "Uncharted 2" curve, normalised to white = 11.2.
  let x = max(c, vec3<f32>(0.0));
  let A = 0.15;
  let B = 0.50;
  let C = 0.10;
  let D = 0.20;
  let E = 0.02;
  let F = 0.30;
  let W = 11.2;
  let curve = ((x * (A * x + C * B) + D * E) / (x * (A * x + B) + D * F)) - E / F;
  let white = ((W * (A * W + C * B) + D * E) / (W * (A * W + B) + D * F)) - E / F;
  return clamp(curve / white, vec3<f32>(0.0), vec3<f32>(1.0));
}

fn tonemap(c: vec3<f32>, mode: f32) -> vec3<f32> {
  if (mode < 0.5) {
    return clamp(c, vec3<f32>(0.0), vec3<f32>(1.0));
  }
  if (mode < 1.5) {
    // Reinhard (luminance-preserving variant).
    let l = luminance(c);
    return c / (1.0 + l);
  }
  if (mode < 2.5) {
    return tonemapAces(c);
  }
  return tonemapFilmic(c);
}
`;

/**
 * Fog transmittance — the fraction of a surface's colour that survives the air between it and the
 * camera. Expects the `PerFrameUniforms` fields `fogParams` (mode, height falloff, height base),
 * `fogDensity` and `fogRange`. Keep in step with `environment/fog.ts`, which is the same formula on
 * the CPU and what the tests check against a brute-force integral.
 */
export const WGSL_FOG = /* wgsl */ `
fn fogTransmittance(distance: f32, cameraY: f32, surfaceY: f32) -> f32 {
  let mode = perFrame.fogParams.x;
  if (mode < 0.5) {
    return 1.0;
  }
  if (mode < 1.5) {
    let start = perFrame.fogRange.x;
    let end = perFrame.fogRange.y;
    if (end <= start) {
      return select(0.0, 1.0, distance < end);
    }
    return clamp((end - distance) / (end - start), 0.0, 1.0);
  }
  if (mode < 2.5) {
    let x = distance * perFrame.fogDensity;
    return exp(-x * x);
  }
  // Height fog: density * exp(-falloff * (y - base)) integrated along the camera->surface segment.
  let falloff = perFrame.fogParams.y;
  let base = perFrame.fogParams.z;
  let dy = surfaceY - cameraY;
  let startDensity = perFrame.fogDensity * exp(-falloff * (cameraY - base));
  let k = falloff * dy;
  var factor = 1.0 - 0.5 * k;
  if (abs(k) > 1e-4) {
    factor = (1.0 - exp(-k)) / k;
  }
  return exp(-startDensity * factor * distance);
}
`;

/**
 * Fullscreen-triangle vertex stage: three vertices, no vertex buffer. `uv` has (0,0) at the top-left
 * of the target, matching texture space, so a fragment can sample the source at `in.uv` directly.
 */
export const WGSL_FULLSCREEN_VERTEX = /* wgsl */ `
struct FullscreenOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) uv: vec2<f32>,
}

@vertex
fn vertexMain(@builtin(vertex_index) index: u32) -> FullscreenOut {
  // One triangle covering the viewport: cheaper than a quad (no shared-edge overdraw).
  let x = f32(index & 1u) * 4.0 - 1.0;
  let y = f32(index >> 1u) * 4.0 - 1.0;
  var out: FullscreenOut;
  out.pos = vec4<f32>(x, y, 0.0, 1.0);
  out.uv = vec2<f32>(x, -y) * 0.5 + vec2<f32>(0.5, 0.5);
  return out;
}
`;
