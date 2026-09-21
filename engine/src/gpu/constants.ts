/**
 * WebGPU flag constants, re-declared.
 *
 * The engine must not reference the browser globals `GPUBufferUsage`, `GPUTextureUsage`,
 * `GPUShaderStage` and `GPUColorWriteMask` directly, for three reasons:
 *
 *  1. They do not exist in worker contexts before the API is touched, and do not exist at all in
 *     Node, which is where the engine's unit tests and asset tooling run.
 *  2. Their values are fixed by the spec, so re-declaring costs nothing and removes an
 *     environment dependency from every hot path that ORs them.
 *  3. The mock WebGPU implementation used by tests must agree bit-for-bit with the real one —
 *     both consume these constants, so a divergence becomes impossible.
 *
 * Values below are copied from the WebGPU spec's IDL (GPUBufferUsage, GPUTextureUsage,
 * GPUShaderStage, GPUColorWrite defaults). Do not "fix" them without checking the spec.
 */

export const BufferUsage = {
  MAP_READ: 0x0001,
  MAP_WRITE: 0x0002,
  COPY_SRC: 0x0004,
  COPY_DST: 0x0008,
  INDEX: 0x0010,
  VERTEX: 0x0020,
  UNIFORM: 0x0040,
  STORAGE: 0x0080,
  INDIRECT: 0x0100,
  QUERY_RESOLVE: 0x0200,
} as const;

export const TextureUsage = {
  COPY_SRC: 0x0001,
  COPY_DST: 0x0002,
  TEXTURE_BINDING: 0x0004,
  STORAGE_BINDING: 0x0008,
  RENDER_ATTACHMENT: 0x0010,
} as const;

export const ShaderStage = {
  NONE: 0x0,
  VERTEX: 0x1,
  FRAGMENT: 0x2,
  COMPUTE: 0x4,
} as const;

export const ColorWriteMask = {
  RED: 0x1,
  GREEN: 0x2,
  BLUE: 0x4,
  ALPHA: 0x8,
  ALL: 0xf,
  NONE: 0x0,
} as const;

/** WebGPU's copy alignment requirement for `bytesPerRow` in texture copies. */
export const COPY_BYTES_PER_ROW_ALIGNMENT = 256;
/** Minimum alignment for buffer offsets in `copyBufferToBuffer` / writeBuffer. */
export const COPY_BUFFER_ALIGNMENT = 4;
/** Uniform/storage dynamic offset alignment required by the spec (limits can only be larger). */
export const MIN_OFFSET_ALIGNMENT = 256;

export type BufferUsageFlags = number;
export type TextureUsageFlags = number;
export type ShaderStageFlags = number;

export function combineUsages(list: readonly (keyof typeof BufferUsage)[]): number {
  let u = 0;
  for (const k of list) u |= BufferUsage[k];
  return u;
}

export function combineTextureUsages(list: readonly (keyof typeof TextureUsage)[]): number {
  let u = 0;
  for (const k of list) u |= TextureUsage[k];
  return u;
}

export function combineStages(list: readonly (keyof typeof ShaderStage)[]): number {
  let s = 0;
  for (const k of list) s |= ShaderStage[k];
  return s;
}

export function describeBufferUsage(usage: number): string {
  const names: string[] = [];
  for (const [name, bit] of Object.entries(BufferUsage)) if ((usage & bit) !== 0) names.push(name);
  return names.length ? names.join("|") : "none";
}

export function describeTextureUsage(usage: number): string {
  const names: string[] = [];
  for (const [name, bit] of Object.entries(TextureUsage)) if ((usage & bit) !== 0) names.push(name);
  return names.length ? names.join("|") : "none";
}

/** Features the engine treats as optional, with what is lost when absent. */
export const OPTIONAL_FEATURES = {
  "timestamp-query": "per-pass GPU timing (profiler falls back to CPU scopes)",
  "texture-compression-bc": "BC compressed textures (falls back to RGBA8 textures, larger memory)",
  "texture-compression-etc2": "ETC2 textures",
  "texture-compression-astc": "ASTC textures",
  "depth-clip-control": "near-plane clipping control (needed for reverse-Z variants)",
  "float32-filterable": "linear filtering of r32float/rgba32float (affects HDR + data textures)",
  "indirect-first-instance": "indirect draw firstInstance (needed for GPU-driven culling offsets)",
  "shader-f16": "fp16 shading in post passes",
  subgroups: "GPU-side reductions/compaction (particle & cluster build quality)",
  "clip-distances": "manual clip planes (used by the terrain editor's region isolation)",
  "dual-source-blending": "single-pass OIT and custom blending",
} as const;

export type OptionalFeatureName = keyof typeof OPTIONAL_FEATURES;
/** Feature names the engine knows how to use when present (see `OPTIONAL_FEATURES`). */
export type FeatureKey = OptionalFeatureName;

export function describeFeature(name: string): string {
  return OPTIONAL_FEATURES[name as OptionalFeatureName] ?? "engine does not use this feature";
}

/** Third argument type of `GPUQueue.writeBuffer`/`writeTexture`, named once for the casts below. */
export type GpuBufferSource = Parameters<GPUQueue["writeBuffer"]>[2];

/**
 * Typed arrays in this engine are always created over a plain `ArrayBuffer`, but the DOM lib types
 * allow `ArrayBufferLike` (which includes `SharedArrayBuffer`) in `ArrayBufferView`. This is the one
 * place that widens them for the WebGPU call, so no other file needs a cast.
 */
export function gpuSource(view: ArrayBufferView): GpuBufferSource {
  return view as unknown as GpuBufferSource;
}
