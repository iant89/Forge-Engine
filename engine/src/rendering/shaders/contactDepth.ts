/**
 * Full-resolution depth resolve used by screen-space contact shadows (Phase 13.9).
 *
 * A depth attachment cannot be sampled while the same render pass is writing depth. This tiny
 * resolve runs after the prepass and publishes the prepass depth as an ordinary r32float texture;
 * the forward pass can then ray-march it while its own depth attachment remains writable for
 * transparent/non-prepassed surfaces.
 */

export const CONTACT_DEPTH_SHADER = /* wgsl */ `
struct FullscreenOut {
  @builtin(position) pos: vec4<f32>,
}

@group(0) @binding(0) var depthTex: texture_depth_2d;

@vertex
fn vertexMain(@builtin(vertex_index) index: u32) -> FullscreenOut {
  var x = f32(index & 1u) * 4.0 - 1.0;
  var y = f32(index >> 1u) * 4.0 - 1.0;
  var out: FullscreenOut;
  out.pos = vec4<f32>(x, y, 0.0, 1.0);
  return out;
}

@fragment
fn fragmentMain(in: FullscreenOut) -> @location(0) f32 {
  return textureLoad(depthTex, vec2<i32>(in.pos.xy), 0);
}
`;
