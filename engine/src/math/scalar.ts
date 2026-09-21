/// <reference types="@webgpu/types" />
/**
 * Scalar / numeric helpers used across the engine.
 *
 * Everything here is pure and allocation-free. Deterministic random/hash helpers live in
 * `rng.ts`; trig-heavy noise lives in `noise.ts`.
 */

export const PI = Math.PI;
export const TAU = Math.PI * 2;
export const HALF_PI = Math.PI / 2;
export const DEG_TO_RAD = Math.PI / 180;
export const RAD_TO_DEG = 180 / Math.PI;
export const EPSILON = 1e-6;
/** Float32 machine epsilon: 2^-23 */
export const FLOAT32_EPSILON = 1.1920928955078125e-7;

export const GOLDEN_RATIO = 1.6180339887498949;
/** Angle increment (rad) that spreads samples over the unit circle without repeating. */
export const GOLDEN_ANGLE = 2.399963229728653;

export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

/** Clamp with NaN treated as `min` (defensive for user-authored scripts). */
export function clampSafe(value: number, min: number, max: number): number {
  if (!(value >= min)) return min;
  return value > max ? max : value;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Inverse lerp, returning 0 when `a == b` instead of ±Infinity. */
export function inverseLerp(a: number, b: number, value: number): number {
  const d = b - a;
  return d === 0 ? 0 : (value - a) / d;
}

export function remap(value: number, inMin: number, inMax: number, outMin: number, outMax: number): number {
  return lerp(outMin, outMax, inverseLerp(inMin, inMax, value));
}

/** Hermite smoothstep. */
export function smoothstep(edge0: number, edge1: number, x: number): number {
  if (edge0 === edge1) return x < edge0 ? 0 : 1;
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

/** Ken Perlin's smootherstep (C2 continuous at both ends). */
export function smootherstep(edge0: number, edge1: number, x: number): number {
  if (edge0 === edge1) return x < edge0 ? 0 : 1;
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * t * (t * (t * 6 - 15) + 10);
}

export function step(edge: number, x: number): number {
  return x < edge ? 0 : 1;
}

export function sign(v: number): number {
  return v > 0 ? 1 : v < 0 ? -1 : 0;
}

export function minOf(...values: number[]): number {
  let m = Infinity;
  for (let i = 0; i < values.length; i++) if (values[i]! < m) m = values[i]!;
  return m;
}

export function maxOf(...values: number[]): number {
  let m = -Infinity;
  for (let i = 0; i < values.length; i++) if (values[i]! > m) m = values[i]!;
  return m;
}

export function isPowerOfTwo(v: number): boolean {
  return Number.isInteger(v) && v > 0 && (v & (v - 1)) === 0;
}

export function nextPowerOfTwo(v: number): number {
  if (v <= 1) return 1;
  return 2 ** Math.ceil(Math.log2(v));
}

/** Round `value` up to a multiple of `alignment` (alignment must be a power of two). */
export function alignUp(value: number, alignment: number): number {
  return (value + alignment - 1) & ~(alignment - 1);
}

export function roundToMultiple(value: number, multiple: number): number {
  return Math.round(value / multiple) * multiple;
}

/** Frame-rate independent exponential smoothing factor for `damp`/`dampAngle`. */
export function dampFactor(smoothing: number, deltaTime: number): number {
  return 1 - Math.exp(-smoothing * deltaTime);
}

/** Move `current` toward `target` at most `maxDelta`. */
export function moveTowards(current: number, target: number, maxDelta: number): number {
  if (maxDelta <= 0) return target === current ? current : current + Math.sign(target - current) * 0;
  const d = target - current;
  if (Math.abs(d) <= maxDelta) return target;
  return current + Math.sign(d) * maxDelta;
}

/** Shortest signed angular difference in [-PI, PI]. */
export function shortestAngle(a: number): number {
  let x = a % TAU;
  if (x > PI) x -= TAU;
  else if (x < -PI) x += TAU;
  return x;
}

/** Interpolate angles along the shortest arc. */
export function lerpAngle(a: number, b: number, t: number): number {
  return a + shortestAngle(b - a) * t;
}

/** Exponential approach toward `target` that is stable at any frame rate. */
export function damp(current: number, target: number, smoothing: number, deltaTime: number): number {
  return lerp(current, target, dampFactor(smoothing, deltaTime));
}

/** Wrap into [0, period). */
export function wrap(value: number, period: number): number {
  const m = value % period;
  return m < 0 ? m + period : m;
}

/** Wrap into [-period/2, period/2). */
export function wrapSymmetric(value: number, period: number): number {
  return wrap(value + period * 0.5, period) - period * 0.5;
}

export function degToRad(deg: number): number {
  return deg * DEG_TO_RAD;
}

export function radToDeg(rad: number): number {
  return rad * RAD_TO_DEG;
}

export function lerpClamped(a: number, b: number, t: number): number {
  return a + (b - a) * clamp(t, 0, 1);
}

/** Smooth minimum/maximum (k = blending radius), used by SDF-ish terrain blending. */
export function smin(a: number, b: number, k: number): number {
  const h = clamp(0.5 + 0.5 * (b - a) / k, 0, 1);
  return lerp(b, a, h) - k * h * (1 - h);
}

export function smax(a: number, b: number, k: number): number {
  const h = clamp(0.5 + 0.5 * (a - b) / k, 0, 1);
  return lerp(b, a, h) + k * h * (1 - h);
}

export function toRadians(deg: number): number {
  return degToRad(deg);
}

/** Quantize a float to the nearest multiple (used for texel-snapping shadow cameras). */
export function snapTo(value: number, quantum: number): number {
  return Math.round(value / quantum) * quantum;
}

/** Deterministic float32 rounding — used to keep CPU and GPU geometry bit-comparable. */
export function f32(value: number): number {
  return Math.fround(value);
}

export function isFiniteNumber(value: number): boolean {
  return typeof value === "number" && Number.isFinite(value);
}

/** Linear → sRGB transfer (for UI/HUD colours authored in display space). */
export function linearToSRGB(c: number): number {
  return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

/** sRGB → linear. */
export function sRGBToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** Catmull–Rom interpolation over 4 samples (used by cubic keyframes and terrain sampling). */
export function cubicInterpolate(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const t2 = t * t;
  const t3 = t2 * t;
  return 0.5 * (
    (2 * p1) +
    (-p0 + p2) * t +
    (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 +
    (-p0 + 3 * p1 - 3 * p2 + p3) * t3
  );
}

/** Barycentric weights for a value inside [0,1]. */
export function barycentric(u: number, v: number): { a: number; b: number; c: number } {
  const a = 1 - u - v;
  return { a, b: u, c: v };
}

/**
 * sRGB (IEC 61966-2-1) transfer function → linear light. Input and output are 0..1.
 * The piecewise form matters: the linear segment keeps darks from crushing.
 */
export function srgbToLinear(value: number): number {
  return value <= 0.04045 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4);
}

/** Linear light → sRGB transfer function (inverse of `srgbToLinear`). */
export function linearToSrgb(value: number): number {
  return value <= 0.0031308 ? value * 12.92 : 1.055 * Math.pow(value, 1 / 2.4) - 0.055;
}

/**
 * Approximate gamma-2.2 encoding, used where the exact curve is not worth a pow() per texel
 * (particle tint tables, debug overlays). Within ~0.5/255 of the standard curve in 0..1.
 */
export function linearToGamma22(value: number): number {
  return Math.pow(value, 1 / 2.2);
}

export function gamma22ToLinear(value: number): number {
  return Math.pow(value, 2.2);
}
