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
  /** 16 floats per joint, column-major inverse bind matrices. */
  inverseBindMatrices: Float32Array;
  /** Skeleton root; when null the joints are direct children of the mesh's entity. */
  root: EntityId | null;
}

export interface MeshSource extends GeometrySource {
  submeshes?: Submesh[];
  skin?: Omit<SkinBinding, "joints" | "root"> & { jointNames?: string[] };
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
    const geometry = Geometry.create(device, src);
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
      };
      geometry.skinned = true;
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
    const names = (this.skin as { jointNames?: string[] }).jointNames;
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
