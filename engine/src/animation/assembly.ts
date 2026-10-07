/**
 * Animation assembly — converts decoded glTF animation data into engine `AnimationClip` objects.
 *
 * This is the bridge between the worker-decoded animation data (`DecodedGltfAnimation` from
 * `gltfAnimation.ts`) and the engine's runtime clip format. It runs on the main thread after
 * the worker has returned the decoded data, because it produces `AnimationTrack` objects that
 * reference the decoded typed arrays (no copy needed — the arrays are already transferred).
 *
 * The assembly is intentionally separate from the decoder: the decoder runs in a worker with
 * no engine dependencies, while the assembly can use engine types.
 */

import type { DecodedGltfAnimation } from "../core/tasks/gltfAnimation.js";
import { type AnimationClip, type AnimationTrack, type Interpolation, createClip } from "./clip.js";

/**
 * Convert one decoded glTF animation into an `AnimationClip`.
 *
 * Each glTF channel becomes one `AnimationTrack`. The sampler's input/output arrays are
 * referenced directly (not copied) — they were already transferred from the worker.
 */
export function assembleClip(animation: DecodedGltfAnimation): AnimationClip {
  const tracks: AnimationTrack[] = [];

  for (const channel of animation.channels) {
    const sampler = animation.samplers[channel.samplerIndex];
    if (!sampler) continue; // defensive: decoder already validates

    tracks.push({
      nodeIndex: channel.targetNode,
      path: channel.targetPath,
      interpolation: sampler.interpolation as Interpolation,
      times: sampler.input,
      values: sampler.output,
    });
  }

  return createClip(animation.name, tracks);
}

/**
 * Convert all decoded glTF animations into engine clips.
 */
export function assembleClips(animations: DecodedGltfAnimation[]): AnimationClip[] {
  return animations.map(assembleClip);
}