/**
 * Animation clip: a named, time-bounded sequence of property tracks targeting scene nodes.
 *
 * A clip is a pure data container — no runtime state, no ECS dependency. Sampling lives in
 * `sampler.ts`; the animation system that drives playback lives in `system.ts`. Keeping the clip
 * immutable and the sampler stateless is what makes deterministic replay testable: the same clip
 * at the same time produces the same transforms, regardless of frame rate or playback order.
 *
 * Design follows glTF 2.0 `animation` semantics:
 *  - Each track targets one node and one property (`translation`, `rotation`, or `scale`).
 *  - Timestamps are monotonically increasing floats in seconds.
 *  - Values are tightly packed: 3 floats per key for translation/scale, 4 for rotation (xyzw).
 *  - Interpolation is per-track: `STEP`, `LINEAR`, or `CUBICSPLINE`.
 *
 * Morph target weights (`CHANNEL_WEIGHTS`) are intentionally excluded from this clip — they
 * require mesh-specific morph data that arrives later in Phase 16.1's follow-up work.
 */

/** The property a track animates. */
export type TrackPath = "translation" | "rotation" | "scale";

/** Interpolation between consecutive keys. */
export type Interpolation = "STEP" | "LINEAR" | "CUBICSPLINE";

/**
 * A single property channel targeting one node.
 *
 * `times` is a monotonically increasing `Float32Array` of timestamps (seconds).
 * `values` packs one sample per key:
 *  - translation / scale: 3 floats (x, y, z)
 *  - rotation: 4 floats (x, y, z, w) — quaternion, glTF order (xyzw)
 *  - CUBICSPLINE: 3× the components per key — [in-tangent, value, out-tangent]
 *
 * `nodeIndex` is the glTF node index (or scene-local entity id after assembly).
 */
export interface AnimationTrack {
  readonly nodeIndex: number;
  readonly path: TrackPath;
  readonly interpolation: Interpolation;
  readonly times: Float32Array;
  readonly values: Float32Array;
}

/**
 * A named animation clip composed of one or more tracks.
 *
 * `duration` is the maximum timestamp across all tracks (seconds). The clip does not own
 * playback state — that is the animation system's job.
 */
export interface AnimationClip {
  readonly name: string;
  readonly tracks: readonly AnimationTrack[];
  /** Clip duration in seconds — the max `times[times.length - 1]` across tracks. */
  readonly duration: number;
}

/** Number of output components per key for a given path (before tangents). */
export function componentsPerKey(path: TrackPath): number {
  return path === "rotation" ? 4 : 3;
}

/**
 * Build an `AnimationClip` from raw tracks, computing the duration automatically.
 *
 * Tracks with zero keys are silently dropped — they carry no information and would divide by
 * zero in the sampler.
 */
export function createClip(name: string, tracks: AnimationTrack[]): AnimationClip {
  const valid = tracks.filter((t) => t.times.length > 0);
  let duration = 0;
  for (const track of valid) {
    const last = track.times[track.times.length - 1]!;
    if (last > duration) duration = last;
  }
  return { name, tracks: valid, duration };
}

/**
 * Validate track invariants. Returns a list of problems (empty = healthy).
 *
 * Checks are intentionally strict: a bad track would produce NaN transforms that silently
 * corrupt the scene. It is cheaper to catch them at import time.
 */
export function validateTrack(track: AnimationTrack, source: string): string[] {
  const errors: string[] = [];
  const keys = track.times.length;
  if (keys === 0) {
    errors.push(`${source}: track has no keys`);
    return errors;
  }
  const c = componentsPerKey(track.path);
  const expectedValues = track.interpolation === "CUBICSPLINE" ? keys * 3 * c : keys * c;
  if (track.values.length !== expectedValues) {
    errors.push(`${source}: expected ${expectedValues} value components for ${keys} keys (${track.interpolation}, ${track.path}), got ${track.values.length}`);
  }
  for (let i = 1; i < keys; i++) {
    if (track.times[i]! < track.times[i - 1]!) {
      errors.push(`${source}: timestamps are not monotonically increasing at index ${i}`);
      break;
    }
  }
  if (track.path === "rotation") {
    const start = track.interpolation === "CUBICSPLINE" ? keys * 4 : 0;
    const end = track.interpolation === "CUBICSPLINE" ? keys * 8 : keys * 4;
    for (let i = start; i < end; i += 4) {
      const x = track.values[i]!, y = track.values[i + 1]!, z = track.values[i + 2]!, w = track.values[i + 3]!;
      const len = Math.sqrt(x * x + y * y + z * z + w * w);
      if (len < 1e-6) {
        errors.push(`${source}: rotation key at value offset ${i} is a zero quaternion`);
        break;
      }
    }
  }
  return errors;
}