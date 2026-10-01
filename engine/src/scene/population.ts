/**
 * The population seam (Phase 14): dense instanced world content without ECS entities.
 *
 * A *population* is a large set of static, scattered instances (rocks, boulders, debris) that share
 * one geometry and one material. The defining constraint of Phase 14 is that none of them becomes an
 * entity: a `Renderable` per rock would pay the transform update, the component-store walk and one
 * batch-collection record per rock, and the scene graph would hold tens of thousands of objects
 * whose only per-frame work is "still here, still static".
 *
 * Instead the seam has three parts, deliberately split so that no layer imports a sibling:
 *
 *  - `PopulationInstanceBlock` — the compact storage (Phase 14.3): structure-of-arrays typed arrays
 *    holding position, non-uniform scale, Y rotation and packed tint per instance. No per-instance
 *    object exists anywhere.
 *  - `PopulationSource` — what a `SceneObject` implements to hand its populated chunks to the
 *    renderer once per frame. `PopulationWorld` (world population streaming) is the implementation
 *    the engine ships; anything that can fill a block can be one.
 *  - `PopulationCollector` — what the renderer implements. It receives one `PopulationSubmission`
 *    per (chunk, type) — a submission is one potential instanced batch — and does everything the
 *    `Renderable` path does: frustum test, per-instance records, conservative shadow-map assignment,
 *    and a batch with its own bounds so the device object culler (Phase 13.5) can drop whole chunks.
 *    A submission that carries a `residencyKey` has its records composed **once** into a slot of the
 *    renderer's instance buffer instead of once per frame into the frame's arena (Phase 14.3's
 *    device-resident step); the key is the slot's identity and the version says when to rewrite it.
 *
 * `Geometry`/`Material` appear here as *types only*: this module lives in `scene` beside
 * `SceneObject` (a population source is a scene-object capability, like `raycast`), so the renderer
 * consumes the seam through its existing scene dependency and no engine layer gains a sibling
 * import. Only the renderer (via `PopulationCollector`) and the population world (which owns the
 * objects) ever touch instances of them.
 */

import type { AABB } from "../math/geometry.js";
import type { Geometry } from "../rendering/geometry.js";
import type { Material } from "../rendering/material.js";

/** Fixed per-instance footprint of the SoA arrays: 3+3+1 floats plus one u32. */
export const POPULATION_INSTANCE_FLOATS = 7;

/**
 * Compact structure-of-arrays instance storage (Phase 14.3).
 *
 * All arrays are allocated once for `capacity` instances and never reallocated; `count` selects the
 * live prefix. Scales are non-uniform (rocks are squashed), rotation is yaw-only — the exact shape
 * `composeYTRS` turns into a matrix without a quaternion round trip.
 */
export class PopulationInstanceBlock {
  /** World-space positions, stride 3. */
  readonly positions: Float32Array;
  /** Non-uniform scales, stride 3. */
  readonly scales: Float32Array;
  /** Y rotation in radians, stride 1. */
  readonly rotations: Float32Array;
  /** Packed 0xAARRGGBB tint per instance; 0 means "no tint" (white), as on `Renderable.tint`. */
  readonly tints: Uint32Array;
  readonly capacity: number;
  /** Live instance count — always ≤ capacity. */
  count = 0;

  constructor(capacity: number) {
    if (capacity < 0 || !Number.isFinite(capacity)) throw new Error(`population: invalid capacity ${capacity}`);
    this.capacity = Math.floor(capacity);
    this.positions = new Float32Array(this.capacity * 3);
    this.scales = new Float32Array(this.capacity * 3);
    this.rotations = new Float32Array(this.capacity);
    this.tints = new Uint32Array(this.capacity);
  }

  clear(): void {
    this.count = 0;
  }
}

/**
 * One (chunk, type) population offered to the renderer: everything one instanced batch needs.
 *
 * A submission object is owned by its source and reused across frames — the renderer reads it
 * synchronously inside `collectPopulations` and keeps no reference — so a steady frame performs no
 * allocation on this path.
 */
export interface PopulationSubmission {
  /** Geometry shared by every instance; `null` submissions are ignored (headless tests). */
  readonly geometry: Geometry | null;
  /** Material shared by every instance; `null` submissions are ignored. */
  readonly material: Material | null;
  /** The instance data; `instances.count` is the live instance count. */
  readonly instances: PopulationInstanceBlock;
  /** Conservative world-space union of the instances' transformed bounds (frustum/culler input). */
  readonly bounds: AABB;
  /** Whether these instances cast shadows (batch `castShadow` + per-instance map assignment). */
  readonly castShadow: boolean;
  /** Draw distance in metres (0 = unlimited); the device culler drops the batch past it. */
  readonly maxDistance: number;
  /**
   * Stable identity of this submission's instance data, for device-resident storage (Phase 14.3's
   * further step). Submissions that share a key share one uploaded block, so a key must name one
   * (chunk, type) for as long as that chunk lives — `"${worldUid}:${typeId}:${cx},${cz}"` is the
   * shape `PopulationWorld` uses. The renderer allocates a slot the first time it sees a key, writes
   * the records once, and frees the slot on the first frame the key is *not* offered (a chunk that
   * streamed out, a source that was disabled or removed). Omitted, and the records are composed into
   * the frame's instance arena every frame the way a `Renderable`'s are.
   */
  readonly residencyKey?: string;
  /**
   * The source's own version of `instances`: bump it whenever the arrays change (a re-scatter, or a
   * remesh re-anchoring Y) and the renderer composes and uploads the block again. A version that
   * never moves is what makes a steady frame cost nothing; one that moves every frame is a
   * per-frame upload with extra bookkeeping, so only bump it when the data really changed.
   */
  readonly residencyVersion?: number;
}

/**
 * Implemented by the renderer: receives population submissions during batch collection. Returning
 * `false` means the submission was rejected before any instance record was written (fully outside
 * the camera and every shadow frustum); the source may use that to skip work, never to mutate data.
 */
export interface PopulationCollector {
  addPopulationBatch(submission: PopulationSubmission): boolean;
}

/**
 * Implemented by `SceneObject`s that own population data. Called once per frame by the renderer
 * after the `Renderable` walk, in scene-object registration order; sources must not allocate or
 * modify scene state here.
 */
export interface PopulationSource {
  collectPopulations(collector: PopulationCollector): void;
}

/** Structural test for "this scene object is a population source" (no `instanceof`, no import). */
export function isPopulationSource(object: unknown): object is PopulationSource {
  return (
    typeof object === "object" &&
    object !== null &&
    typeof (object as PopulationSource).collectPopulations === "function"
  );
}
