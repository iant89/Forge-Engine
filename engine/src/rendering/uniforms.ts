/**
 * Uniform layouts shared by the CPU writes and the WGSL declarations.
 *
 * The shaders in `rendering/shaders/*.ts` embed `StructDef.toWgsl()` output directly, so the WGSL
 * declaration and the CPU writer cannot drift apart. `tools/wgsl-check.mjs` and `tests/wgsl.test.ts`
 * additionally fail the build when a definition is illegal in the uniform address space (an array
 * with a stride below 16 bytes, a struct member off a 16-byte boundary). That matters because
 * Chromium compiles such a struct anyway while WebKit rejects the module: the bug renders fine in
 * Chrome and is a black canvas on Safari. A *mismatched* layout is worse still — it renders
 * plausible garbage while validating cleanly — which is why nothing here is a hand-written number.
 *
 * Offsets and sizes are computed from the WGSL layout rules by `gpu/layout.ts`; padding is emitted
 * as `u32` scalars, never as arrays.
 */

import { StructDef, f32, i32, u32, vec2, vec3, vec4, mat4x4, arrayOf, ofStruct, type AddressSpace } from "../gpu/layout.js";

/** Max lights the per-frame block can carry (kept in sync with the WGSL array length). */
export const MAX_LIGHTS_PER_FRAME = 16;
export const MAX_CASCADES = 4;

/** Frame-wide state, bound as group 0 in every pass. */
export const PerFrameUniforms = new StructDef("PerFrameUniforms", [
  { name: "viewProj", type: mat4x4, comment: "column-major, z in [0,1]" },
  { name: "invViewProj", type: mat4x4 },
  { name: "cameraPosRender", type: vec3, comment: "relative to the coordinate-space origin" },
  { name: "exposure", type: f32 },
  { name: "time", type: vec4, comment: "(seconds, delta, frame index, pad)" },
  { name: "fogColor", type: vec3 },
  { name: "fogDensity", type: f32 },
  { name: "fogRange", type: vec2, comment: "linear fog near/far" },
  { name: "renderExtent", type: vec2 },
  { name: "shadowDistance", type: f32 },
  { name: "ambientIntensity", type: f32 },
  { name: "lightCount", type: i32 },
  { name: "cascadeCount", type: i32 },
  { name: "ambientColor", type: vec3 },
  { name: "toneMapping", type: f32, comment: "0 none, 1 reinhard, 2 aces, 3 filmic" },
  { name: "flags", type: u32, comment: "bit0 sky, bit1 post, bit2 hdr, bit3 shadows" },
]);

/** One light. Directional lights sort first; index 0 is the cascade caster. */
export const LightUniforms = new StructDef("LightUniforms", [
  { name: "positionRange", type: vec4, comment: "xyz render-local, w = range (0 for directional)" },
  { name: "directionIntensity", type: vec4, comment: "xyz travel direction, w = intensity" },
  { name: "color", type: vec3 },
  { name: "spotAngles", type: vec2, comment: "(cos inner, cos outer)" },
  { name: "kind", type: i32, comment: "0 directional, 1 point, 2 spot" },
  { name: "shadowIndex", type: i32, comment: "-1 when the light casts no shadow" },
  { name: "_pad", type: vec2 },
]);

/** Cascade matrices for the shadow pass and the depth pass that samples it. */
export const ShadowUniforms = new StructDef("ShadowUniforms", [
  { name: "cascadeViewProj", type: arrayOf(mat4x4, 4) },
  { name: "cascadeSplits", type: vec4 },
  { name: "texelSize", type: f32 },
  { name: "depthBias", type: f32 },
  { name: "normalBias", type: f32 },
  { name: "enabled", type: i32 },
  { name: "size", type: i32 },
  { name: "_pad", type: i32 },
]);

/**
 * Light block as actually bound (a bare `array<LightUniforms, N>` is not a valid uniform buffer
 * type: the array must be wrapped in a struct, and the count lives next to it).
 */
export const LightBlock = new StructDef("LightBlock", [
  { name: "count", type: i32 },
  { name: "shadowedCount", type: i32 },
  { name: "_pad", type: vec2 },
  { name: "lights", type: arrayOf(ofStruct(LightUniforms), MAX_LIGHTS_PER_FRAME) },
]);

/** Per-material state, bound as group 2. */
export const MaterialUniforms = new StructDef("MaterialUniforms", [
  { name: "baseColorFactor", type: vec4 },
  { name: "emissiveFactor", type: vec3 },
  { name: "emissiveStrength", type: f32 },
  { name: "metallic", type: f32 },
  { name: "roughness", type: f32 },
  { name: "opacity", type: f32 },
  { name: "tiling", type: vec2 },
  { name: "offset", type: vec2 },
  { name: "normalScale", type: f32 },
  { name: "flags", type: u32, comment: "bit0 albedoMap, bit1 normalMap, bit2 metallicRoughnessMap, bit3 doubleSided, bit4 unlit" },
  { name: "_pad0", type: u32 },
  { name: "_pad1", type: u32 },
]);

/** Per-object state, bound as group 1 (the world matrix the draw actually uses). */
export const ObjectUniforms = new StructDef("ObjectUniforms", [
  { name: "model", type: mat4x4 },
  { name: "modelView", type: mat4x4 },
  { name: "boundsMin", type: vec3 },
  { name: "boundsRadius", type: f32 },
  { name: "boundsMax", type: vec3 },
  { name: "instanceCount", type: u32 },
  { name: "instanceOffset", type: u32 },
  { name: "_pad", type: vec2 },
]);

/**
 * Instance stream element: a 4x4 matrix as four rows (a mat4x4 in a storage array would be
 * column-strided identically, and rows read better in the shader's `transpose`-free multiply) plus
 * per-instance tint/emissive/bone-batch fields. 96 bytes per instance.
 */
export const InstanceStruct = new StructDef("InstanceData", [
  { name: "row0", type: vec4 },
  { name: "row1", type: vec4 },
  { name: "row2", type: vec4 },
  { name: "row3", type: vec4 },
  { name: "tint", type: u32 },
  { name: "emissive", type: f32 },
  { name: "flags", type: u32 },
  { name: "materialIndex", type: u32 },
]);

/** Debug line vertex (position + packed RGBA8 colour). */
export const DebugVertexStruct = new StructDef("DebugVertex", [
  { name: "position", type: vec3 },
  { name: "color", type: u32 },
]);

export const RENDERING_STRUCTS = {
  PerFrameUniforms,
  LightBlock,
  LightUniforms,
  ShadowUniforms,
  MaterialUniforms,
  ObjectUniforms,
  InstanceStruct,
  DebugVertexStruct,
} as const;

export type RenderingStructName = keyof typeof RENDERING_STRUCTS;

/** Byte size in the given address space (the size a buffer allocation must satisfy). */
export function structSize(name: RenderingStructName, space: AddressSpace = "uniform"): number {
  return RENDERING_STRUCTS[name].byteSize(space);
}

/** Max lights the per-frame struct can carry (kept in sync with the WGSL array length). */

