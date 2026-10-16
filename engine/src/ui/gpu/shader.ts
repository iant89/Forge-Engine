/**
 * The UI shader: one instanced quad per draw-list instance, shaded by a per-instance `kind`.
 *
 * Coordinates: instances arrive in UI logical units; the vertex stage multiplies by `frame.scale`
 * (devicePixelRatio × uiScale) so every distance in the fragment stage is in physical pixels and
 * anti-aliasing is a one-pixel ramp at any scale.
 *
 * Kinds (`PrimitiveKind`): 0 rounded box (per-corner radius, border, vertical/horizontal gradient),
 * 1 soft shadow, 2 image (tinted, optional rounded clip), 3 SDF glyph (smoothstep over `fwidth`,
 * `p0` = synthetic-bold bias), 4 coverage glyph, 5 ring arc (clockwise from 12 o'clock). Each instance
 * carries its own clip rectangle; fragments outside it are discarded, which is why clipping never
 * splits a batch.
 *
 * Output is premultiplied alpha, blended `one, one-minus-src-alpha`, in display-referred sRGB values
 * (the swapchain is not an sRGB format and the scene has already been encoded; docs/UI.md §1.4).
 *
 * Derivative rule (`validateWgsl`): the texture sample and `fwidth` are the fragment entry point's
 * first statements — Tint rejects them after the clip `discard` or the kind branches.
 */

import { StructDef, f32, vec2 } from "../../gpu/layout.js";

/** Per-frame uniform (group 0, binding 0). Generated WGSL keeps the uniform layout WebKit-safe. */
export const UI_FRAME_STRUCT = new StructDef("UiFrame", [
  { name: "viewport", type: vec2 },
  { name: "scale", type: f32 },
  { name: "time", type: f32 },
]);

export const UI_SHADER = /* wgsl */ `
${UI_FRAME_STRUCT.toWgsl("uniform")}

@group(0) @binding(0) var<uniform> frame: UiFrame;
@group(1) @binding(0) var uiTexture: texture_2d<f32>;
@group(1) @binding(1) var uiSampler: sampler;

struct InstanceIn {
  @location(0) rect: vec4f,
  @location(1) uvRect: vec4f,
  @location(2) color0: vec4f,
  @location(3) color1: vec4f,
  @location(4) borderColor: vec4f,
  @location(5) radii: vec4f,
  @location(6) clip: vec4f,
  @location(7) params: vec4f,
  @location(8) params2: vec4f,
};

struct VsOut {
  @builtin(position) position: vec4f,
  @location(0) local: vec2f,
  @location(1) uv: vec2f,
  @location(2) corner: vec2f,
  @location(3) @interpolate(flat) halfSize: vec2f,
  @location(4) @interpolate(flat) color0: vec4f,
  @location(5) @interpolate(flat) color1: vec4f,
  @location(6) @interpolate(flat) borderColor: vec4f,
  @location(7) @interpolate(flat) radii: vec4f,
  @location(8) @interpolate(flat) clip: vec4f,
  @location(9) @interpolate(flat) params: vec4f,
  @location(10) @interpolate(flat) params2: vec4f,
};

@vertex
fn vsMain(@builtin(vertex_index) vi: u32, inst: InstanceIn) -> VsOut {
  // Two triangles: corners (0,0) (1,0) (0,1) (0,1) (1,0) (1,1), packed as bit masks.
  let corner = vec2f(f32((0x32u >> vi) & 1u), f32((0x2Cu >> vi) & 1u));
  let s = frame.scale;
  let posPx = (inst.rect.xy + corner * inst.rect.zw) * s;
  var out: VsOut;
  out.position = vec4f(posPx.x / frame.viewport.x * 2.0 - 1.0, 1.0 - posPx.y / frame.viewport.y * 2.0, 0.0, 1.0);
  out.halfSize = inst.rect.zw * s * 0.5;
  out.local = (corner - vec2f(0.5)) * inst.rect.zw * s;
  out.uv = mix(inst.uvRect.xy, inst.uvRect.zw, corner);
  out.corner = corner;
  out.color0 = inst.color0;
  out.color1 = inst.color1;
  out.borderColor = inst.borderColor;
  out.radii = inst.radii * s;
  out.clip = inst.clip * s;
  // borderWidth and blur are lengths (scaled); kind, bias and angles are not.
  out.params = vec4f(inst.params.x * s, inst.params.y, select(inst.params.z, inst.params.z * s, inst.params.y == 1.0), inst.params.w);
  out.params2 = vec4f(inst.params2.x * s, inst.params2.yzw);
  return out;
}

fn sdRoundBox(p: vec2f, halfSize: vec2f, radii: vec4f) -> f32 {
  // radii: top-left, top-right, bottom-right, bottom-left; +y is down.
  let r = select(select(radii.x, radii.y, p.x > 0.0), select(radii.w, radii.z, p.x > 0.0), p.y > 0.0);
  let q = abs(p) - halfSize + vec2f(r);
  return min(max(q.x, q.y), 0.0) + length(max(q, vec2f(0.0))) - r;
}

fn premul(c: vec4f, coverage: f32) -> vec4f {
  return vec4f(c.rgb * c.a, c.a) * coverage;
}

const TAU: f32 = 6.28318530718;

@fragment
fn fsMain(in: VsOut) -> @location(0) vec4f {
  let tex = textureSample(uiTexture, uiSampler, in.uv);
  let fw = max(fwidth(tex.r), 1e-4);
  let px = in.position.xy;
  if (px.x < in.clip.x || px.y < in.clip.y || px.x >= in.clip.z || px.y >= in.clip.w) {
    discard;
  }
  let kind = i32(in.params.y + 0.5);
  let hasRadius = max(max(in.radii.x, in.radii.y), max(in.radii.z, in.radii.w)) > 0.0;
  if (kind == 0) {
    let d = sdRoundBox(in.local, in.halfSize, in.radii);
    let bw = in.params.x;
    let outer = clamp(0.5 - d, 0.0, 1.0);
    let inner = clamp(0.5 - (d + bw), 0.0, 1.0);
    let t = select(select(0.0, in.corner.x, in.params.w > 1.5), in.corner.y, in.params.w > 0.5 && in.params.w < 1.5);
    let fill = mix(in.color0, in.color1, t);
    return premul(fill, inner) + premul(in.borderColor, max(outer - inner, 0.0));
  }
  if (kind == 1) {
    let blur = max(in.params.z, 0.5);
    let d = sdRoundBox(in.local, max(in.halfSize - vec2f(blur), vec2f(0.0)), in.radii);
    return premul(in.color0, 1.0 - smoothstep(-blur, blur, d));
  }
  if (kind == 2) {
    var cov = 1.0;
    if (hasRadius) {
      cov = clamp(0.5 - sdRoundBox(in.local, in.halfSize, in.radii), 0.0, 1.0);
    }
    let c = tex * in.color0;
    return vec4f(c.rgb * c.a, c.a) * cov;
  }
  if (kind == 3) {
    let edge = 0.5 - in.params.z;
    let w = fw * 0.75;
    return premul(in.color0, smoothstep(edge - w, edge + w, tex.r));
  }
  if (kind == 4) {
    return premul(in.color0, tex.r);
  }
  // kind 5: ring arc
  let r = length(in.local);
  let outerR = min(in.halfSize.x, in.halfSize.y);
  let innerR = outerR - in.params2.x;
  let ring = clamp(outerR - r + 0.5, 0.0, 1.0) * clamp(r - innerR + 0.5, 0.0, 1.0);
  var ang = atan2(in.local.x, -in.local.y);
  if (ang < 0.0) {
    ang = ang + TAU;
  }
  let start = in.params.z;
  let span = in.params.w - in.params.z;
  var cov = 1.0;
  if (span < TAU - 1e-4) {
    let rel = ang - start - floor((ang - start) / TAU) * TAU;
    if (rel <= span) {
      cov = clamp(min(rel, span - rel) * r + 0.5, 0.0, 1.0);
    } else {
      cov = clamp(0.5 - min(rel - span, TAU - rel) * r, 0.0, 1.0);
    }
  }
  return premul(in.color0, ring * cov);
}
`;
