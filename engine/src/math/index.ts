/**
 * Math barrel. Everything here is allocation-free-by-construction, dependency-free and shared by the
 * main thread and workers (no DOM, no `performance` except behind an injected clock).
 */

export {
  clamp,
  clampSafe,
  lerp,
  lerpClamped,
  inverseLerp,
  remap,
  smoothstep,
  smootherstep,
  step,
  sign,
  minOf,
  maxOf,
  isPowerOfTwo,
  nextPowerOfTwo,
  alignUp,
  roundToMultiple,
  dampFactor,
  moveTowards,
  shortestAngle,
  lerpAngle,
  damp,
  wrap,
  wrapSymmetric,
  degToRad,
  radToDeg,
  toRadians,
  snapTo,
  f32,
  smin,
  smax,
  srgbToLinear,
  linearToSrgb,
  linearToGamma22,
  gamma22ToLinear,
} from "./scalar.js";
export { Vec2, Vec3, Vec4, type Vec2Like, type Vec3Like, type Vec3Ops, scratch3 } from "./vec.js";
export { Mat3, Mat4, Quat } from "./mat.js";
export { TRS, TransformStore, LOCAL_STRIDE, WORLD_STRIDE, multiplyInto, type TRSLike } from "./transform.js";
export { AABB, BoundingSphere, Plane, Ray, RayHit, Frustum, OBB, type PlaneTest, type PlaneLike } from "./geometry.js";
export {
  MeshBvh,
  raycastTriangles,
  hashBvhData,
  type MeshBvhBuildOptions,
  type MeshBvhData,
} from "./bvh.js";
export { Double3, encodeFloat64ToPair, decodePairToFloat64, packChunkKey, unpackChunkKey } from "./double3.js";
export { Color, packColorRGBA, unpackColor, colorFromTemperature } from "./color.js";
export { Rng, mix32, combine32, seedStream, hash1i, hash2i, hash3i, hash2iFloat, hash3iFloat, chunkSeed } from "./rng.js";
export {
  valueNoise2,
  perlin2,
  perlin3,
  simplex2,
  fbm2,
  fbm3,
  ridged2,
  billow2,
  cellular2,
  warpNoise2,
  NoiseField,
  type FbmOptions,
} from "./noise.js";
