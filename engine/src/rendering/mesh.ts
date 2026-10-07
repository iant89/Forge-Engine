/**
 * `Mesh`: a geometry plus draw ranges and an optional skin binding.
 *
 * The engine keeps `Mesh` separate from `Geometry` because the same geometry is frequently drawn
 * with different submesh/material splits (a glTF scene reuses one buffer across meshes), and because
 * skinning data belongs to the mesh, not the vertex buffer. `Renderable` references a `Geometry`
 * directly in the simple case; `Mesh` is what the asset pipeline produces.
 */

import { Geometry, type GeometrySource } from "./geometry.js";
import { AABB } from "../math/geometry.js";
import type { GraphicsDevice } from "../gpu/device.js";
import type { EntityId } from "../scene/entityId.js";

export interface Submesh {
  /** First index (or vertex when the geometry is unindexed). */
  start: number;
  count: number;
  /** Index into the `Material` array the renderer draws with. */
  materialIndex: number;
  name?: string;
}

export interface SkinBinding {
  /** Joint entities, in the order the GPU sees them (bone index = array index). */
  joints: EntityId[];
  /**
   * 16 floats per joint, column-major inverse bind matrices, in the *mesh's bind-pose local space*
   * (see `rendering/skinning.ts`): the skinned vertex stage places the result with the draw's own
   * model matrix, so a rig that hangs off the mesh's entity needs no extra bookkeeping. An importer
   * that only has a joint's bind-pose world matrix must fold the mesh node's bind transform in.
   */
  inverseBindMatrices: Float32Array;
  /** Skeleton root; when null the joints are direct children of the mesh's entity. */
  root: EntityId | null;
  /** Authoring names, resolved into `joints` against the scene by `bindJoints`. */
  jointNames?: string[];
}

/** A skin as authored: the joint names replace the entities until the scene resolves them. */
export interface SkinSource extends Omit<SkinBinding, "joints" | "root"> {
  jointNames?: string[];
  /** `JOINTS_0`: `SKIN_JOINTS_PER_VERTEX` joint indices per vertex, indexing `jointNames`. */
  joints?: Uint16Array | Uint32Array;
  /** `WEIGHTS_0`: `SKIN_JOINTS_PER_VERTEX` blend weights per vertex. */
  weights?: Float32Array;
}

export interface MeshSource extends GeometrySource {
  submeshes?: Submesh[];
  skin?: SkinSource;
}

export class Mesh {
  geometry: Geometry;
  submeshes: Submesh[];
  skin: SkinBinding | null = null;
  name: string;

  private constructor(geometry: Geometry, submeshes: Submesh[], name: string) {
    this.geometry = geometry;
    this.submeshes = submeshes;
    this.name = name;
  }

  static from(device: GraphicsDevice, src: MeshSource): Mesh {
    // The skin's per-vertex attributes are a geometry stream (a second vertex buffer slot), while
    // the joint list and the inverse bind matrices belong to the mesh — glTF splits them the same
    // way (`JOINTS_0`/`WEIGHTS_0` on the primitive, the joints and the IBMs on the skin).
    const skinning = src.skin?.joints && src.skin.weights
      ? { joints: src.skin.joints, weights: src.skin.weights }
      : null;
    const geometry = Geometry.create(device, skinning ? { ...src, skinning } : src);
    const count = geometry.indexCount > 0 ? geometry.indexCount : geometry.vertexCount;
    const submeshes = src.submeshes && src.submeshes.length > 0 ? src.submeshes : [{ start: 0, count, materialIndex: 0 }];
    for (const sm of submeshes) {
      if (sm.start < 0 || sm.start + sm.count > count) {
        throw new Error(`Mesh "${src.label ?? ""}": submesh range ${sm.start}+${sm.count} exceeds the index count ${count}`);
      }
    }
    const mesh = new Mesh(geometry, submeshes, src.label ?? "mesh");
    if (src.skin) {
      mesh.skin = {
        joints: [],
        inverseBindMatrices: src.skin.inverseBindMatrices,
        root: null,
        jointNames: src.skin.jointNames,
      };
    }
    return mesh;
  }

  get bounds(): AABB {
    return this.geometry.bounds;
  }

  get triangleCount(): number {
    return this.geometry.triangleCount;
  }

  get gpuBytes(): number {
    return this.geometry.gpuBytes + (this.skin ? this.skin.inverseBindMatrices.byteLength : 0);
  }

  /** Resolve joint names against a scene after loading (the asset pipeline defers this). */
  bindJoints(resolve: (name: string) => EntityId | null, root: EntityId | null): boolean {
    if (!this.skin) return false;
    const names = this.skin.jointNames;
    if (!names) return this.skin.joints.length > 0;
    const joints: EntityId[] = [];
    for (const n of names) {
      const id = resolve(n);
      if (id === null) return false;
      joints.push(id);
    }
    this.skin.joints = joints;
    this.skin.root = root;
    return true;
  }

  release(): void {
    this.geometry.release();
  }

  dispose(): void {
    this.release();
  }
}
