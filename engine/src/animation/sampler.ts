/**
 * Animation clip sampler — evaluates an `AnimationClip` at a given time.
 *
 * The sampler is a pure function: `(clip, time, output[]) → void`. It writes TRS values into a
 * caller-owned output array (one 10-float slot per node: tx ty tz rx ry rz rw sx sy sz) so that
 * the animation system can apply them to transforms without allocating per-frame objects.
 *
 * Interpolation:
 *  - `STEP`: value snaps to the key at or before `t`.
 *  - `LINEAR`: translation/scale linearly interpolate; rotation uses normalized SLERP (with a
 *    fallback to NLERP when the dot product is near ±1, which avoids the atan2 singularity).
 *  - `CUBICSPLINE`: cubic Hermite spline using the in-tangent of the next key and the out-tangent
 *    of the previous key, per glTF 2.0 spec §Appendix C.
 *
 * Determinism: the sampler reads the same typed arrays and applies the same arithmetic in the
 * same order every time — no RNG, no global state, no branch that depends on frame count.
 *
 * Wrap mode is the caller's responsibility (the animation system applies loop/modulo before
 * calling). Out-of-range `t` is clamped to [0, duration].
 */

import {
  type AnimationClip,
  type AnimationTrack,
  type TrackPath,
  componentsPerKey,
} from "./clip.js";

/**
 * Per-node output slot: 10 floats — translation(3), rotation(4), scale(3), packed xyzw.
 *
 * The layout matches what `Transform` needs: set position from [0..2], rotation from [3..6],
 * scale from [7..9].
 */
export const NODE_STRIDE = 10;

/** Number of scratch floats the sampler needs (enough for one CUBICSPLINE key = 3×4 = 12). */

/**
 * Sample all tracks in `clip` at time `t`, writing TRS values into `output`.
 *
 * `output` must have at least `(maxNodeIndex + 1) * NODE_STRIDE` elements. Un-targeted nodes
 * retain whatever was in the array before the call (the caller typically initialises them to
 * identity: position 0,0,0; rotation 0,0,0,1; scale 1,1,1).
 *
 * `t` is clamped to [0, clip.duration].
 */
export function sampleClip(
  clip: AnimationClip,
  t: number,
  output: Float32Array,
): void {
  const clampedT = t < 0 ? 0 : t > clip.duration ? clip.duration : t;
  for (const track of clip.tracks) {
    sampleTrack(track, clampedT, output);
  }
}

/**
 * Initialise `output` to identity TRS for `nodeCount` nodes.
 */
export function initIdentity(output: Float32Array, nodeCount: number): void {
  for (let i = 0; i < nodeCount; i++) {
    const off = i * NODE_STRIDE;
    output[off + 0] = 0; output[off + 1] = 0; output[off + 2] = 0; // translation
    output[off + 3] = 0; output[off + 4] = 0; output[off + 5] = 0; output[off + 6] = 1; // rotation (identity quat)
    output[off + 7] = 1; output[off + 8] = 1; output[off + 9] = 1; // scale
  }
}

// ──────────────────────── internal ────────────────────────

function sampleTrack(track: AnimationTrack, t: number, output: Float32Array): void {
  const times = track.times;
  const keys = times.length;
  if (keys === 0) return;

  const c = componentsPerKey(track.path);
  const outOffset = track.nodeIndex * NODE_STRIDE + pathOffset(track.path);

  // Single key: just copy the value (or the middle sample for CUBICSPLINE).
  if (keys === 1) {
    const src = track.interpolation === "CUBICSPLINE" ? c : 0; // CUBICSPLINE: skip in-tangent
    for (let i = 0; i < c; i++) output[outOffset + i] = track.values[src + i]!;
    if (track.path === "rotation") normalizeQuat(output, outOffset);
    return;
  }

  // Find the interval: binary search for the key at or before `t`.
  let lo = 0;
  let hi = keys - 1;

  // Before the first key: snap to the first value.
  if (t <= times[0]!) {
    readValue(track, 0, c, output, outOffset);
    if (track.path === "rotation") normalizeQuat(output, outOffset);
    return;
  }

  while (lo < hi - 1) {
    const mid = (lo + hi) >>> 1;
    if (times[mid]! <= t) lo = mid;
    else hi = mid;
  }

  const t0 = times[lo]!;
  const t1 = times[hi]!;

  // Exact hit or at the last key: snap.
  if (t1 === t0 || t >= t1) {
    readValue(track, hi, c, output, outOffset);
    if (track.path === "rotation") normalizeQuat(output, outOffset);
    return;
  }

  const alpha = (t - t0) / (t1 - t0);

  switch (track.interpolation) {
    case "STEP":
      readValue(track, lo, c, output, outOffset);
      break;
    case "LINEAR":
      interpolateLinear(track, lo, hi, alpha, c, output, outOffset);
      break;
    case "CUBICSPLINE":
      interpolateCubic(track, lo, hi, alpha, c, output, outOffset);
      break;
  }
  if (track.path === "rotation") normalizeQuat(output, outOffset);
}

function pathOffset(path: TrackPath): number {
  switch (path) {
    case "translation": return 0;
    case "rotation": return 3;
    case "scale": return 7;
  }
}

/**
 * Read the value component for a given key index, accounting for CUBICSPLINE layout.
 * For CUBICSPLINE, reads the middle sample (the actual value, between in- and out-tangent).
 */
function readValue(
  track: AnimationTrack,
  key: number,
  c: number,
  out: Float32Array,
  outOffset: number,
): void {
  let src: number;
  if (track.interpolation === "CUBICSPLINE") {
    // Layout: [in0, val0, out0, in1, val1, out1, ...] — value is the middle of each triple
    src = key * 3 * c + c; // skip in-tangent
  } else {
    src = key * c;
  }
  for (let i = 0; i < c; i++) out[outOffset + i] = track.values[src + i]!;
}

function interpolateLinear(
  track: AnimationTrack,
  lo: number,
  hi: number,
  alpha: number,
  c: number,
  out: Float32Array,
  outOffset: number,
): void {
  const srcLo = lo * c;
  const srcHi = hi * c;

  if (track.path === "rotation") {
    // SLERP with NLERP fallback
    slerpQuat(track.values, srcLo, track.values, srcHi, alpha, out, outOffset);
  } else {
    for (let i = 0; i < c; i++) {
      out[outOffset + i] = track.values[srcLo + i]! + alpha * (track.values[srcHi + i]! - track.values[srcLo + i]!);
    }
  }
}

function interpolateCubic(
  track: AnimationTrack,
  lo: number,
  hi: number,
  alpha: number,
  c: number,
  out: Float32Array,
  outOffset: number,
): void {
  // glTF CUBICSPLINE: each key has [in-tangent, value, out-tangent] (3 × c floats).
  // Hermite: p(t) = (2α³ − 3α² + 1)·p0 + (α³ − 2α² + α)·m0 + (−2α³ + 3α²)·p1 + (α³ − α²)·m1
  //   where m0 = out-tangent(lo) · Δt, m1 = in-tangent(hi) · Δt
  const dt = track.times[hi]! - track.times[lo]!;
  const a2 = alpha * alpha;
  const a3 = a2 * alpha;
  const h00 = 2 * a3 - 3 * a2 + 1;
  const h10 = a3 - 2 * a2 + alpha;
  const h01 = -2 * a3 + 3 * a2;
  const h11 = a3 - a2;

  const loOut = lo * 3 * c + 2 * c; // out-tangent of lo
  const hiIn = hi * 3 * c;          // in-tangent of hi
  const loVal = lo * 3 * c + c;     // value of lo
  const hiVal = hi * 3 * c + c;     // value of hi

  if (track.path === "rotation") {
    // For quaternion splines, use the Hermite result and normalize (standard glTF approach).
    for (let i = 0; i < c; i++) {
      const p0 = track.values[loVal + i]!;
      const p1 = track.values[hiVal + i]!;
      const m0 = track.values[loOut + i]! * dt;
      const m1 = track.values[hiIn + i]! * dt;
      out[outOffset + i] = h00 * p0 + h10 * m0 + h01 * p1 + h11 * m1;
    }
    // Don't re-normalize here — the caller's normalizeQuat handles it after the switch.
  } else {
    for (let i = 0; i < c; i++) {
      const p0 = track.values[loVal + i]!;
      const p1 = track.values[hiVal + i]!;
      const m0 = track.values[loOut + i]! * dt;
      const m1 = track.values[hiIn + i]! * dt;
      out[outOffset + i] = h00 * p0 + h10 * m0 + h01 * p1 + h11 * m1;
    }
  }
}

/**
 * Normalized SLERP between two quaternions, with NLERP fallback when the arc is small.
 *
 * Input quaternions are xyzw (glTF convention). The output is normalized.
 */
function slerpQuat(
  a: Float32Array, aOff: number,
  b: Float32Array, bOff: number,
  t: number,
  out: Float32Array, outOff: number,
): void {
  let dot = a[aOff]! * b[bOff]! + a[aOff + 1]! * b[bOff + 1]! + a[aOff + 2]! * b[bOff + 2]! + a[aOff + 3]! * b[bOff + 3]!;

  // Ensure the shortest arc: if dot < 0, negate B.
  let bSign = 1;
  if (dot < 0) {
    dot = -dot;
    bSign = -1;
  }

  // Fall back to NLERP when the quaternions are nearly parallel (avoid sin(≈0) / ≈0).
  if (dot > 0.9995) {
    for (let i = 0; i < 4; i++) {
      out[outOff + i] = a[aOff + i]! + t * (bSign * b[bOff + i]! - a[aOff + i]!);
    }
    normalizeQuat(out, outOff);
    return;
  }

  const theta = Math.acos(Math.min(dot, 1));
  const sinTheta = Math.sin(theta);
  const wA = Math.sin((1 - t) * theta) / sinTheta;
  const wB = Math.sin(t * theta) / sinTheta * bSign;

  for (let i = 0; i < 4; i++) {
    out[outOff + i] = wA * a[aOff + i]! + wB * b[bOff + i]!;
  }
  normalizeQuat(out, outOff);
}

/** In-place quaternion normalization. */
function normalizeQuat(q: Float32Array, off: number): void {
  const x = q[off]!, y = q[off + 1]!, z = q[off + 2]!, w = q[off + 3]!;
  const len = Math.sqrt(x * x + y * y + z * z + w * w);
  if (len < 1e-8) {
    // Degenerate — reset to identity.
    q[off] = 0; q[off + 1] = 0; q[off + 2] = 0; q[off + 3] = 1;
    return;
  }
  const inv = 1 / len;
  q[off] = x * inv;
  q[off + 1] = y * inv;
  q[off + 2] = z * inv;
  q[off + 3] = w * inv;
}