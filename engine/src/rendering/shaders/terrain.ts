/** Four-channel splat surface sampling, sharing the standard PBR lighting/shadow/fog implementation. */
import { SplatUniforms } from "../uniforms.js";
import { createStandardFragmentBody } from "./standard.js";

/** Standard material bindings 0–4 remain intact; only terrain pipelines bind this extension. */
export const SPLAT_BINDINGS = { uniforms: 5, albedo: 6, normal: 7, mr: 8, weights: 9, sampler: 10 } as const;

const SURFACE = /* wgsl */ `
  // A grid sample lives at a texel CENTRE, not at uv=0/1. This mapping plus clamping makes
  // neighbours with matching edge weights meet without sampling the opposite side of the tile.
  let dims = vec2<f32>(textureDimensions(splatWeights));
  let maskUv = (clamp(in.uv, vec2<f32>(0.0), vec2<f32>(1.0)) * (dims - 1.0) + 0.5) / dims;
  let rawWeights = max(textureSampleLevel(splatWeights, splatSampler, maskUv, 0.0), vec4<f32>(0.0));
  let totalWeight = dot(rawWeights, vec4<f32>(1.0));
  let weights = select(vec4<f32>(0.25), rawWeights / max(totalWeight, 1e-6), totalWeight > 1e-6);
  var base = vec3<f32>(0.0);
  var tangentNormal = vec3<f32>(0.0);
  var metallic = 0.0;
  var roughness = 0.0;
  let macroPos = in.uv * splat.macroUv.xy + splat.macroUv.zw;
  let macroNoise = sin(macroPos.x * 2.0 * PI) * cos(macroPos.y * 2.0 * PI);
  // Fixed, uniform loop: never skip textureSample based on a per-fragment weight (derivatives).
  for (var layer = 0i; layer < 4i; layer = layer + 1i) {
    let uv = in.uv * splat.uvTransforms[layer].xy + splat.uvTransforms[layer].zw;
    let texel = textureSample(splatAlbedo, materialSampler, uv, layer);
    let mr = textureSample(splatMr, materialSampler, uv, layer);
    let normalTexel = textureSample(splatNormal, materialSampler, uv, layer).xyz * 2.0 - 1.0;
    let surface = splat.surfaces[layer];
    let normal = normalize(vec3<f32>(normalTexel.xy * surface.z, max(normalTexel.z, 1e-4)));
    let macroShade = 1.0 + macroNoise * surface.w;
    // Fine variation follows the actual albedo texels, rather than a second unrelated noise field.
    let microNoise = 1.0 - dot(texel.rgb, vec3<f32>(0.2126, 0.7152, 0.0722));
    let microShade = 1.0 - microNoise * splat.microDetails[layer];
    base = base + weights[layer] * splat.colors[layer].rgb * texel.rgb * macroShade * microShade;
    tangentNormal = tangentNormal + weights[layer] * normal;
    metallic = metallic + weights[layer] * surface.y * mr.b;
    roughness = roughness + weights[layer] * surface.x * mr.g;
  }
  let albedo = vec4<f32>(base * material.baseColorFactor.rgb, material.baseColorFactor.a);
  metallic = clamp(metallic * material.metallic, 0.0, 1.0);
  roughness = clamp(roughness * material.roughness, 0.045, 1.0);
  var N = normalize(in.normal);
  let V = normalize(perFrame.cameraPosRender - in.worldPos);
  if ((perFrame.flags & 4u) != 0u && dot(in.tangent.xyz, in.tangent.xyz) > 1e-8) {
    let T = normalize(in.tangent.xyz);
    let B = cross(N, T) * in.tangent.w;
    N = normalize(mat3x3<f32>(T, B, N) * normalize(tangentNormal));
  }
`;

export const TERRAIN_FRAGMENT_BODY = /* wgsl */ `
${SplatUniforms.toWgsl("uniform")}
@group(2) @binding(${SPLAT_BINDINGS.uniforms}) var<uniform> splat: SplatUniforms;
@group(2) @binding(${SPLAT_BINDINGS.albedo}) var splatAlbedo: texture_2d_array<f32>;
@group(2) @binding(${SPLAT_BINDINGS.normal}) var splatNormal: texture_2d_array<f32>;
@group(2) @binding(${SPLAT_BINDINGS.mr}) var splatMr: texture_2d_array<f32>;
@group(2) @binding(${SPLAT_BINDINGS.weights}) var splatWeights: texture_2d<f32>;
@group(2) @binding(${SPLAT_BINDINGS.sampler}) var splatSampler: sampler;
${createStandardFragmentBody(SURFACE)}
`;
