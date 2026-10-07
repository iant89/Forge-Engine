/**
 * AnimationSystem — drives animation playback every frame (order 300).
 *
 * The system:
 *  1. Advances each playing clip's time by `dt` (respecting speed and looping).
 *  2. Samples each clip into a per-node TRS buffer.
 *  3. When multiple clips play, blends them by weight (normalised).
 *  4. Applies the sampled TRS to the joint entities' `Transform` components.
 *
 * Determinism: clip time advances are order-independent (they read `dt` once), sampling is a pure
 * function of (clip, time, buffer), and blend order follows the clip map's insertion order (stable
 * across runs because `Map` preserves insertion order in modern JS). No RNG is involved.
 *
 * The system reads `context.dt` (variable-rate, not fixed-step) because animation is a visual
 * interpolation that benefits from smooth per-frame updates rather than fixed-step snapping.
 */

import { System } from "../scene/systems.js";
import type { SystemContext } from "../scene/systems.js";
import { sampleClip, NODE_STRIDE, initIdentity } from "./sampler.js";
import { AnimationComponent } from "./component.js";
import { Transform } from "../scene/components/index.js";

/**
 * Global animation scratch buffer — shared across all entities to avoid per-entity allocation.
 * Sized for the max joint count across all animation components in the scene. The system resizes
 * it lazily when a component exceeds the current capacity.
 */
let scratchSampleA: Float32Array | null = null;
let scratchSampleB: Float32Array | null = null;

function ensureScratch(minNodes: number): void {
  const needed = minNodes * NODE_STRIDE;
  if (!scratchSampleA || scratchSampleA.length < needed) {
    scratchSampleA = new Float32Array(needed);
    scratchSampleB = new Float32Array(needed);
  }
}

export class AnimationSystem extends System {
  readonly name = "animation";
  override readonly order = 300;

  private query = -1 as unknown as ReturnType<import("../scene/world.js").EntityWorld["query"]>;
  private queryInitialized = false;

  private stats_clipsPlayed = 0;
  private stats_keysSampled = 0;

  update(context: SystemContext): void {
    const { world, dt } = context;
    this.stats_clipsPlayed = 0;
    this.stats_keysSampled = 0;

    // Lazy-initialise the query on first use.
    if (!this.queryInitialized) {
      this.query = world.query([AnimationComponent]);
      this.queryInitialized = true;
    }

    this.query.refresh();
    const entities = this.query.entities;
    if (entities.length === 0) return;

    for (let ei = 0; ei < entities.length; ei++) {
      const entityId = entities[ei]!;
      const anim = world.getComponent(entityId, AnimationComponent);
      if (!anim) continue;

      const playing = anim.getPlayingClips();
      if (playing.length === 0) continue;

      const jointCount = anim.jointCount;
      if (jointCount === 0) continue;

      ensureScratch(jointCount);
      const bufA = scratchSampleA!;
      const bufB = scratchSampleB!;

      // Advance time for all playing clips.
      for (const playback of playing) {
        playback.time += dt * playback.speed;
        if (playback.looping && playback.clip.duration > 0) {
          // Wrap into [0, duration).
          playback.time = ((playback.time % playback.clip.duration) + playback.clip.duration) % playback.clip.duration;
        } else {
          // Clamp to [0, duration]; stop if we've reached the end.
          if (playback.time >= playback.clip.duration) {
            playback.time = playback.clip.duration;
            playback.playing = false;
          }
          if (playback.time < 0) {
            playback.time = 0;
            playback.playing = false;
          }
        }
      }

      // Re-check after time advance — clips may have stopped.
      const stillPlaying = anim.getPlayingClips();
      if (stillPlaying.length === 0) continue;

      // Normalise weights.
      let totalWeight = 0;
      for (const playback of stillPlaying) totalWeight += playback.weight;
      const invWeight = totalWeight > 0 ? 1 / totalWeight : 0;

      // Sample the first clip into bufA.
      initIdentity(bufA, jointCount);
      const first = stillPlaying[0]!;
      sampleClip(first.clip, first.time, bufA);
      this.stats_clipsPlayed++;
      this.stats_keysSampled += first.clip.tracks.length;

      if (stillPlaying.length === 1) {
        // Single clip — apply directly.
        this.applyToTransforms(world, anim, bufA, first.weight * invWeight);
      } else {
        // Blend multiple clips: sample second into bufB, blend into bufA, repeat.
        let blended = bufA;
        let blendWeight = first.weight * invWeight;

        for (let i = 1; i < stillPlaying.length; i++) {
          const playback = stillPlaying[i]!;
          initIdentity(bufB, jointCount);
          sampleClip(playback.clip, playback.time, bufB);
          this.stats_clipsPlayed++;
          this.stats_keysSampled += playback.clip.tracks.length;

          const w = playback.weight * invWeight;
          blendTRS(blended, bufB, jointCount, w / (blendWeight + w));
          blendWeight += w;
        }

        this.applyToTransforms(world, anim, blended, 1);
      }
    }
  }

  /**
   * Apply sampled TRS data to the joint entities' Transform components.
   *
   * `weight` is the blend weight [0..1] — when < 1, the animation is blended with the
   * entity's existing local TRS (additive mixing for partial-body animation).
   */
  private applyToTransforms(
    world: import("../scene/world.js").EntityWorld,
    anim: AnimationComponent,
    trs: Float32Array,
    weight: number,
  ): void {
    const nodeToEntity = anim.nodeToEntity;
    for (let node = 0; node < nodeToEntity.length; node++) {
      const entityId = nodeToEntity[node]!;
      if (entityId < 0) continue; // unmapped node

      const transform = world.getComponent(entityId, Transform);
      if (!transform) continue;

      const off = node * NODE_STRIDE;
      const tx = trs[off]!, ty = trs[off + 1]!, tz = trs[off + 2]!;
      const rx = trs[off + 3]!, ry = trs[off + 4]!, rz = trs[off + 5]!, rw = trs[off + 6]!;
      const sx = trs[off + 7]!, sy = trs[off + 8]!, sz = trs[off + 9]!;

      if (weight >= 1) {
        // Full override.
        transform.position.set(tx, ty, tz);
        transform.rotation.set(rx, ry, rz, rw);
        transform.scale.set(sx, sy, sz);
      } else {
        // Blend with existing transform.
        const w = weight;
        const inv = 1 - w;
        transform.position.set(
          transform.position.x * inv + tx * w,
          transform.position.y * inv + ty * w,
          transform.position.z * inv + tz * w,
        );
        // Quaternion blend via NLERP (shortest arc).
        blendQuat(transform.rotation, rx, ry, rz, rw, w);
        transform.scale.set(
          transform.scale.x * inv + sx * w,
          transform.scale.y * inv + sy * w,
          transform.scale.z * inv + sz * w,
        );
      }
      transform.sync();
    }
  }

  override stats(): Record<string, number | string | boolean> {
    return {
      animationClipsPlayed: this.stats_clipsPlayed,
      animationKeysSampled: this.stats_keysSampled,
    };
  }

  override dispose(): void {
    scratchSampleA = null;
    scratchSampleB = null;
  }
}

/**
 * Blend two TRS buffers element-wise: `dst = dst * (1 - alpha) + src * alpha`.
 * Operates in-place on `dst` for position and scale; quaternion uses NLERP.
 */
function blendTRS(dst: Float32Array, src: Float32Array, nodeCount: number, alpha: number): void {
  const inv = 1 - alpha;
  for (let n = 0; n < nodeCount; n++) {
    const off = n * NODE_STRIDE;
    // Translation (lerp)
    dst[off + 0] = dst[off + 0]! * inv + src[off + 0]! * alpha;
    dst[off + 1] = dst[off + 1]! * inv + src[off + 1]! * alpha;
    dst[off + 2] = dst[off + 2]! * inv + src[off + 2]! * alpha;
    // Rotation (NLERP)
    blendQuatAt(dst, off + 3, src, off + 3, alpha);
    // Scale (lerp)
    dst[off + 7] = dst[off + 7]! * inv + src[off + 7]! * alpha;
    dst[off + 8] = dst[off + 8]! * inv + src[off + 8]! * alpha;
    dst[off + 9] = dst[off + 9]! * inv + src[off + 9]! * alpha;
  }
}

/** NLERP blend of a quaternion at `dstOff` with a source quaternion at `srcOff`. */
function blendQuatAt(
  dst: Float32Array, dstOff: number,
  src: Float32Array, srcOff: number,
  alpha: number,
): void {
  const dot = dst[dstOff]! * src[srcOff]! + dst[dstOff + 1]! * src[srcOff + 1]! +
              dst[dstOff + 2]! * src[srcOff + 2]! + dst[dstOff + 3]! * src[srcOff + 3]!;
  const sign = dot < 0 ? -1 : 1;
  const inv = 1 - alpha;
  const x = dst[dstOff]! * inv + sign * src[srcOff]! * alpha;
  const y = dst[dstOff + 1]! * inv + sign * src[srcOff + 1]! * alpha;
  const z = dst[dstOff + 2]! * inv + sign * src[srcOff + 2]! * alpha;
  const w = dst[dstOff + 3]! * inv + sign * src[srcOff + 3]! * alpha;
  const len = Math.sqrt(x * x + y * y + z * z + w * w);
  if (len < 1e-8) {
    dst[dstOff] = 0; dst[dstOff + 1] = 0; dst[dstOff + 2] = 0; dst[dstOff + 3] = 1;
    return;
  }
  const invLen = 1 / len;
  dst[dstOff] = x * invLen;
  dst[dstOff + 1] = y * invLen;
  dst[dstOff + 2] = z * invLen;
  dst[dstOff + 3] = w * invLen;
}

/** NLERP blend a Quat-like object with a source quaternion, in-place on the target. */
function blendQuat(
  target: { x: number; y: number; z: number; w: number; set(x: number, y: number, z: number, w: number): void },
  sx: number, sy: number, sz: number, sw: number,
  alpha: number,
): void {
  const dot = target.x * sx + target.y * sy + target.z * sz + target.w * sw;
  const sign = dot < 0 ? -1 : 1;
  const inv = 1 - alpha;
  const x = target.x * inv + sign * sx * alpha;
  const y = target.y * inv + sign * sy * alpha;
  const z = target.z * inv + sign * sz * alpha;
  const w = target.w * inv + sign * sw * alpha;
  const len = Math.sqrt(x * x + y * y + z * z + w * w);
  if (len < 1e-8) {
    target.set(0, 0, 0, 1);
    return;
  }
  const invLen = 1 / len;
  target.set(x * invLen, y * invLen, z * invLen, w * invLen);
}