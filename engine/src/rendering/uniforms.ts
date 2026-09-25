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
import { CLUSTER_COUNT, CLUSTER_INDEX_CAPACITY, MAX_CLUSTERED_LIGHTS } from "./clusters.js";

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
  { name: "lightCount", type: i32, comment: "lights in the frame, global and local; the uniform LightBlock's own count bounds the shader's loop" },
  { name: "cascadeCount", type: i32 },
  { name: "ambientColor", type: vec3 },
  { name: "toneMapping", type: f32, comment: "0 none, 1 reinhard, 2 aces, 3 filmic" },
  { name: "flags", type: u32, comment: "bit0 sky, bit1 HDR output (post chain tone-maps), bit2 normal maps, bit3 shadows, bit4 SSAO bound" },
  { name: "fogParams", type: vec4, comment: "(mode: 0 none 1 linear 2 exp2 3 height, height falloff, height base, pad)" },
]);

/**
 * The analytic sky (`shaders/sky.ts`), bound as group 0 binding 1 of the `forge.sky` pass. Every
 * physical constant the shader marches with is delivered here from `environment/atmosphere.ts` so
 * the CPU reference model and the GPU never disagree on a coefficient. Lengths in metres,
 * coefficients in 1/m, radiance in scene units.
 */
export const SkyUniforms = new StructDef("SkyUniforms", [
  { name: "sunDirection", type: vec3, comment: "unit vector toward the sun, render axes" },
  { name: "sunIntensity", type: f32, comment: "top-of-atmosphere irradiance × sky exposure" },
  { name: "rayleighScattering", type: vec3 },
  { name: "rayleighScaleHeight", type: f32 },
  { name: "mieScattering", type: vec3 },
  { name: "mieScaleHeight", type: f32 },
  { name: "mieExtinction", type: vec3 },
  { name: "mieAnisotropy", type: f32 },
  { name: "ozoneAbsorption", type: vec3 },
  { name: "ozoneCenter", type: f32 },
  { name: "groundAlbedo", type: vec3 },
  { name: "ozoneWidth", type: f32 },
  { name: "planetRadius", type: f32 },
  { name: "atmosphereHeight", type: f32 },
  { name: "observerHeight", type: f32, comment: "camera altitude above sea level" },
  { name: "sunAngularRadius", type: f32 },
  { name: "sunDiscIntensity", type: f32, comment: "disc radiance relative to sunIntensity × transmittance" },
  { name: "starBrightness", type: f32, comment: "0 disables the star field" },
  { name: "viewSamples", type: i32 },
  { name: "lightSamples", type: i32 },
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

/**
 * Cascaded shadow state for the directional caster. `cascadeViewProj[c]` maps render-local space
 * into cascade `c` of the shadow atlas (a `texture_depth_2d_array`, layer = cascade); the fragment
 * stage picks the cascade by view depth against `cascadeSplits` (see `rendering/shadows.ts`).
 */
export const ShadowUniforms = new StructDef("ShadowUniforms", [
  { name: "cascadeViewProj", type: arrayOf(mat4x4, MAX_CASCADES) },
  { name: "cascadeSplits", type: vec4, comment: "far view-depth of each cascade; unused entries are +large" },
  { name: "cascadeTexelWorld", type: vec4, comment: "render-local size of one shadow texel per cascade (normal-offset bias)" },
  { name: "texelSize", type: f32, comment: "1 / map size" },
  { name: "depthBias", type: f32, comment: "constant bias in NDC depth units" },
  { name: "normalBias", type: f32, comment: "normal offset in texels" },
  { name: "fadeStart", type: f32, comment: "view depth where shadows start fading to unshadowed" },
  { name: "enabled", type: i32 },
  { name: "size", type: i32 },
  { name: "count", type: i32, comment: "cascades in use (1..MAX_CASCADES)" },
  { name: "flags", type: u32, comment: "bit0 tint fragments by cascade (debug)" },
]);

/**
 * Group 0 of the shadow (depth-only) passes: the light view-projection of one cascade. One record
 * per cascade lives in a small dynamic-offset arena, so all cascades share a single bind group.
 */
export const ShadowPassUniforms = new StructDef("ShadowPassUniforms", [
  { name: "viewProj", type: mat4x4, comment: "render-local -> cascade clip space" },
  { name: "cascade", type: i32 },
  { name: "_pad0", type: i32 },
  { name: "_pad1", type: i32 },
  { name: "_pad2", type: i32 },
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
 * per-instance tint/emissive/flags/material fields. 80 bytes per instance — the renderer's
 * arena records use this as their stride (see INSTANCE_STRIDE in renderer.ts).
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

/**
 * Post-process pass parameters (bloom prefilter/downsample/upsample and the tonemap resolve). One
 * record per pass invocation lives in a dynamic-offset arena, so the whole HDR chain shares one
 * buffer and one bind group layout.
 */
export const PostUniforms = new StructDef("PostUniforms", [
  { name: "texelSize", type: vec2, comment: "1 / source size" },
  { name: "outputSize", type: vec2 },
  { name: "threshold", type: f32, comment: "bloom prefilter threshold (after exposure)" },
  { name: "knee", type: f32, comment: "soft-knee width as a fraction of threshold" },
  { name: "intensity", type: f32, comment: "bloom strength at composite" },
  { name: "exposure", type: f32 },
  { name: "toneMapping", type: f32, comment: "0 none, 1 reinhard, 2 aces, 3 filmic" },
  { name: "radius", type: f32, comment: "upsample tent radius in source texels" },
  { name: "flags", type: u32, comment: "bit0 composite bloom, bit1 Karis average, bit2 skip tonemap (debug)" },
  { name: "_pad", type: u32 },
]);

/**
 * Screen-space ambient occlusion (`shaders/ssao.ts`), bound as group 0 binding 0 of the
 * `forge.ssao` pass and both blur passes. The estimator reconstructs view-space positions from the
 * depth prepass through `invProj`, so it needs no normal buffer and no G-buffer. Lengths in metres.
 */
export const SsaoUniforms = new StructDef("SsaoUniforms", [
  { name: "invProj", type: mat4x4, comment: "clip -> view (column-major): view-space position from depth" },
  { name: "radius", type: f32, comment: "world-space sampling radius" },
  { name: "bias", type: f32, comment: "ignore occluders closer than this to the tangent plane" },
  { name: "intensity", type: f32 },
  { name: "projScale", type: f32, comment: "depth-texture pixels per metre at view depth 1 (perspective only)" },
  { name: "depthSize", type: vec2, comment: "depth prepass extent in pixels" },
  { name: "aoSize", type: vec2, comment: "AO target extent in pixels (half resolution)" },
  { name: "sampleCount", type: u32 },
  { name: "sharpness", type: f32, comment: "bilateral blur: relative depth difference that zeroes a tap is 1/sharpness" },
  { name: "maxPixels", type: f32, comment: "screen-space radius clamp (texture-cache friendliness)" },
  { name: "_pad", type: u32 },
]);

/** Debug line vertex (position + packed RGBA8 colour). */
export const DebugVertexStruct = new StructDef("DebugVertex", [
  { name: "position", type: vec3 },
  { name: "color", type: u32 },
]);

/**
 * The cloud deck (`environment/clouds.ts`), bound as group 0 binding 2 of the `forge.sky` pass.
 * Art parameters come from `scene.settings.clouds`; the lighting (`sunTint`, `ambientTint`) is
 * derived per frame from the 8a atmosphere by `SkyLightingCache`, so the deck tracks the
 * day/night cycle. The shader advects the coverage field by `wind × perFrame.time`.
 */
export const CloudUniforms = new StructDef("CloudUniforms", [
  { name: "coverage", type: f32 },
  { name: "density", type: f32 },
  { name: "height", type: f32, comment: "deck altitude above sea level, metres" },
  { name: "thickness", type: f32, comment: "reserved (vertical extent for a future volumetric pass)" },
  { name: "scale", type: f32, comment: "world metres per noise unit" },
  { name: "silverLining", type: f32 },
  { name: "seed", type: f32 },
  { name: "enabled", type: f32, comment: "0 disables the layer (the shader early-outs)" },
  { name: "sunTint", type: vec3, comment: "direct sun: transmittance × sunIntensity (linear RGB)" },
  { name: "_pad0", type: f32 },
  { name: "ambientTint", type: vec3, comment: "diffuse sky light (linear RGB)" },
  { name: "_pad1", type: f32 },
  { name: "cloudAlbedo", type: vec3 },
  { name: "_pad2", type: f32 },
  { name: "wind", type: vec2, comment: "mean wind m/s (+x east, +y north→+z); advects the deck" },
  { name: "_pad3", type: vec2 },
]);

/**
 * The water surface (`environment/water.ts`), bound as group 2 of the `water` technique (which
 * reuses the frame + draw groups of the standard program). The four waves are the scene's
 * `water.waves` with `k = 2π/λ` and `Q = steepness/(k·A·4)` precomputed, so the vertex shader
 * evaluates exactly the `sampleGerstner` sum. `skyTint` is the atmosphere's horizon colour — the
 * reflection/refraction approximation samples it, not the scene.
 */
export const WaterUniforms = new StructDef("WaterUniforms", [
  { name: "wavesA", type: arrayOf(vec4, 4), comment: "(dirX, dirZ, k, speed) × 4" },
  { name: "wavesB", type: arrayOf(vec4, 4), comment: "(amplitude, q, phase, 0) × 4" },
  { name: "deepColor", type: vec3 },
  { name: "time", type: f32, comment: "simulated water time, seconds" },
  { name: "shallowColor", type: vec3 },
  { name: "opacity", type: f32 },
  { name: "foamColor", type: vec3 },
  { name: "foamThreshold", type: f32 },
  { name: "sunTint", type: vec3, comment: "direct sun: transmittance × sunIntensity (linear RGB)" },
  { name: "sunGlint", type: f32 },
  { name: "skyTint", type: vec3, comment: "horizon colour the surface reflects (linear RGB)" },
  { name: "_pad0", type: f32 },
  { name: "sunDirection", type: vec3, comment: "unit vector toward the sun, render axes" },
  { name: "_pad1", type: f32 },
]);

/**
 * Clustered (Forward+) light lookup, bound as group 0 binding 6 of every pass that uses the frame
 * group. The grid (`ClusterGridBlock`) and the lights it references (`ClusterLightBlock`) are storage
 * buffers; this block carries only the numbers the fragment stage quantises its own position with,
 * and they are the *same* numbers `rendering/clusters.ts` quantised the lights with on the CPU. A
 * disagreement between the two is a light that silently stops reaching a surface at a cluster
 * boundary, which is why the grid's slice span comes from here rather than being recomputed.
 */
export const ClusterUniforms = new StructDef("ClusterUniforms", [
  { name: "invExtent", type: vec2, comment: "1 / renderExtent: fragment pixel → tile-space uv" },
  { name: "gridScale", type: vec2, comment: "(CLUSTER_TILES_X, CLUSTER_TILES_Y)" },
  { name: "near", type: f32, comment: "view depth the slices start at; clamps the fragment's log" },
  { name: "logNear", type: f32 },
  { name: "sliceScale", type: f32, comment: "CLUSTER_SLICES / ln(far / near)" },
  { name: "slices", type: f32 },
  { name: "lightCount", type: i32, comment: "valid records in ClusterLightBlock.lights" },
  { name: "stride", type: i32, comment: "MAX_LIGHTS_PER_CLUSTER: slots per cluster block in ClusterGridBlock.indices" },
  { name: "_pad", type: vec2 },
]);

/**
 * The local (point/spot) lights a cluster grid references, bound as group 0 binding 7
 * (`var<storage, read>`). The record layout is the uniform `LightUniforms`' own, so one writer fills
 * either buffer; the array is a *fixed* capacity because WGSL has no runtime-sized array a
 * `StructDef` can describe, and a length that changed per frame would mean a shader module that
 * changed per frame.
 */
export const ClusterLightBlock = new StructDef("ClusterLightBlock", [
  { name: "count", type: i32, comment: "valid records in `lights`; the shader never reads past it" },
  { name: "_pad0", type: i32 },
  { name: "_pad1", type: i32 },
  { name: "_pad2", type: i32 },
  { name: "lights", type: arrayOf(ofStruct(LightUniforms), MAX_CLUSTERED_LIGHTS) },
]);

/**
 * The grid itself, bound as group 0 binding 8 (`var<storage, read>`): one u32 per cluster — how many
 * of its block's slots are valid — followed by the light-index blocks themselves, `stride`
 * (i.e. `MAX_LIGHTS_PER_CLUSTER`) slots per cluster. Cluster `c`'s list is
 * `indices[c × stride … c × stride + counts[c])`, so the fragment stage needs no offset table and
 * the cap is the stride: a cluster can never lose a light to a buffer running out. Both arrays are
 * written verbatim by `rendering/clusters.ts` (or by the compute rasteriser in
 * `rendering/lightCulling.ts`); cluster `c` is `(slice × CLUSTER_TILES_Y + tileY) × CLUSTER_TILES_X + tileX`.
 */
export const ClusterGridBlock = new StructDef("ClusterGridBlock", [
  { name: "counts", type: arrayOf(u32, CLUSTER_COUNT), comment: "per cluster: valid entries in its block of `indices`" },
  { name: "indices", type: arrayOf(u32, CLUSTER_INDEX_CAPACITY), comment: "cluster-major light-index blocks, `stride` slots each" },
]);

/**
 * One packed light range — the field layout `ClusterGrid.packRanges` writes and the assignment
 * shader (`rendering/lightCulling.ts`) decodes. `key` carries the tile and slice bounds the CPU range
 * pass prepared (`RANGE_KEY_BITS` in `rendering/clusters.ts` is the bit layout) and bit 24 is the
 * live flag; `influence` is the rank the fill evicts by when a cluster's list is full.
 */
export const ClusterRangeEntry = new StructDef("ClusterRangeEntry", [
  { name: "key", type: u32, comment: "packed tile/slice bounds; the live bit (24) is 0 for a light that reaches no cluster" },
  { name: "influence", type: f32, comment: "intensity × colour luma" },
]);

/**
 * The frame's prepared ranges, bound as group 0 binding 0 of the assignment pass
 * (`var<storage, read>`): one entry per local light, in light order — the order the fill appends in,
 * which is what keeps the fragment stage's accumulation order the CPU path's own.
 *
 * The light count travels with the entries so the shader needs no uniform of its own: a frame that
 * did not cluster uploads `count = 0`, and the dispatch is then a no-op rather than a rebuild from
 * whatever keys the previous clustered frame left behind.
 */
export const ClusterRangeBlock = new StructDef("ClusterRangeBlock", [
  { name: "count", type: u32, comment: "valid entries; 0 when clustering did not run this frame" },
  { name: "entries", type: arrayOf(ofStruct(ClusterRangeEntry), MAX_CLUSTERED_LIGHTS), comment: "one per local light, in light order" },
]);

export const RENDERING_STRUCTS = {
  PerFrameUniforms,
  LightBlock,
  LightUniforms,
  ShadowUniforms,
  ShadowPassUniforms,
  MaterialUniforms,
  ObjectUniforms,
  InstanceStruct,
  DebugVertexStruct,
  PostUniforms,
  SsaoUniforms,
  SkyUniforms,
  CloudUniforms,
  WaterUniforms,
  ClusterUniforms,
} as const;

/**
 * Structs that are only ever bound as `var<storage, read>`. Kept out of `RENDERING_STRUCTS` because
 * that registry is checked *as if uniform* (`tools/wgsl-check.mjs`), and a plain `array<u32, N>` has
 * a 4-byte stride — illegal in the uniform address space, exactly what a storage buffer is for.
 * `check:wgsl` validates these in the storage space instead.
 */
export const RENDERING_STORAGE_STRUCTS = {
  ClusterLightBlock,
  ClusterGridBlock,
  ClusterRangeEntry,
  ClusterRangeBlock,
} as const;

export type RenderingStructName = keyof typeof RENDERING_STRUCTS;

export type RenderingStorageStructName = keyof typeof RENDERING_STORAGE_STRUCTS;

/** Byte size in the given address space (the size a buffer allocation must satisfy). */
export function structSize(name: RenderingStructName, space: AddressSpace = "uniform"): number {
  return RENDERING_STRUCTS[name].byteSize(space);
}

