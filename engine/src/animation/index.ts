/**
 * Animation subsystem — clips, sampling, playback, state machines, blend trees, and skeleton
 * integration.
 *
 * Architecture:
 *  - `clip.ts`: pure data types for animation clips and tracks (no runtime state).
 *  - `sampler.ts`: stateless clip evaluation — `sampleClip(clip, time, output)` produces TRS
 *    per node. Deterministic: same inputs always produce the same output.
 *  - `component.ts`: per-entity playback state (clip references, time cursor, blend weights).
 *  - `system.ts`: `AnimationSystem` (order 300) drives playback, blends clips, and applies
 *    sampled TRS to joint entities' `Transform` components.
 *  - `stateMachine.ts`: `AnimationStateMachine` manages named states, parameter-driven
 *    transitions, and crossfade blending on top of the component.
 *  - `blendTree.ts`: `BlendTree1D` / `BlendTree2D` compute continuous blend weights from
 *    gameplay parameters for directional locomotion and similar use cases.
 *  - `assembly.ts`: converts worker-decoded glTF animation data into engine clips.
 *
 * The animation subsystem depends on `scene` (Transform, EntityWorld) and `math` (Vec3, Quat)
 * only. It never imports `rendering`, `physics`, `terrain`, or any other sibling.
 */

export type { AnimationClip, AnimationTrack, TrackPath, Interpolation } from "./clip.js";
export { createClip, componentsPerKey, validateTrack } from "./clip.js";

export { sampleClip, initIdentity, NODE_STRIDE } from "./sampler.js";

export { AnimationComponent } from "./component.js";
export type { ClipPlayback } from "./component.js";

export { AnimationSystem } from "./system.js";

export { AnimationStateMachine } from "./stateMachine.js";
export type {
  AnimationParams,
  TransitionCondition,
  AnimationStateConfig,
  TransitionConfig,
} from "./stateMachine.js";

export { BlendTree1D, BlendTree2D } from "./blendTree.js";
export type { BlendTreeClip, BlendResult } from "./blendTree.js";

export { assembleClip, assembleClips } from "./assembly.js";