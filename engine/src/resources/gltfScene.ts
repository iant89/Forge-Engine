/**
 * Phase 16.1f: turn a decoded glTF asset (`decodeGltfMesh`) into live scene entities.
 *
 * One entity per node of the asset's active scene, parented exactly as the glTF node graph, with the
 * node's local TRS (a `matrix` is decomposed). Mesh nodes get a `Renderable` per primitive (the first
 * on the node's own entity, any others on child entities). A skinned node's mesh carries the decoded
 * JOINTS_0/WEIGHTS_0 stream and its skin binds to the *joint entities* with the decoded inverse bind
 * matrices, so the existing Phase 16.5 GPU path draws it unchanged: the renderer forms
 * `inverse(meshWorld) × jointWorld × IBM` and the vertex stage multiplies `meshWorld` back in, which is
 * exactly glTF's rule that a skinned mesh node's own transform does not move its vertices.
 *
 * Animations become `AnimationClip`s on one `AnimationComponent` on the instance root. Its
 * `nodeToEntity` maps glTF node indices to the entities, and its `restPose` is the nodes' authored TRS,
 * so a clip that animates only some channels leaves the others as authored. The caller registers an
 * `AnimationSystem` on the world and plays a clip; nothing here starts playback.
 *
 * Scope: materials are built from factors (base colour, metallic, roughness, double-sided,
 * alpha BLEND → transparent) plus, when `options.textures` (from `loadGltfTextures`, Phase 16.1c) is
 * given, the baseColor / emissive (sRGB), metallicRoughness / normal / occlusion maps with their per-texture samplers, emissive factors, per-map UV-set selection and alpha MASK cutoff; skinned primitives cull against posed bounds the renderer derives
 * from the skin's per-joint boxes (`SkinBinding.jointBounds`); morph targets are CPU-applied and weight
 * animation channels update their geometry, and EXT_mesh_gpu_instancing nodes are expanded into
 * transform children. Cameras and lights are not imported. Missing normals/tangents are generated.
 */

import { UsageError } from "../core/errors.js";
import { Mat4, Quat } from "../math/mat.js";
import { Vec3 } from "../math/vec.js";
import { Color } from "../math/color.js";
import type { GraphicsDevice } from "../gpu/device.js";
import { Mesh } from "../rendering/mesh.js";
import { Material } from "../rendering/material.js";
import { computeNormalsAndTangents } from "../rendering/geometry.js";
import { Renderable, Transform } from "../scene/components/index.js";
import type { Entity } from "../scene/world.js";
import type { Scene } from "../scene/scene.js";
import { AnimationComponent } from "../animation/component.js";
import { assembleClips } from "../animation/assembly.js";
import type { AnimationClip } from "../animation/clip.js";
import { NODE_STRIDE } from "../animation/sampler.js";
import type { GltfTextureSet } from "./gltfTextures.js";
import type { DecodedGltfAsset, DecodedGltfMaterial, DecodedGltfNode, DecodedGltfPrimitive } from "../core/tasks/gltfMesh.js";

export interface InstantiateGltfSceneOptions {
  /** Name of the instance root entity (default: the asset source). */
  name?: string;
  /** Parent for the instance root (default: none). */
  parent?: Entity | null;
  /** Scene index to instantiate (default: the asset's active scene, else scene 0, else every root node). */
  sceneIndex?: number;
  /** Override material construction (receives the glTF material, or null for the default material). */
  material?: (material: DecodedGltfMaterial | null, index: number | null) => Material;
  /**
   * Phase 16.1c: textures from `loadGltfTextures`, bound by the default material builder. The set
   * stays caller-owned: `dispose()` on the instance does not release it.
   */
  textures?: GltfTextureSet;
}

export interface GltfSceneInstance {
  /** The entity every top-level node hangs under. */
  root: Entity;
  /** Entity per glTF node index; null for nodes outside the instantiated scene. */
  nodes: (Entity | null)[];
  meshes: Mesh[];
  /** The clips' playback state (null when the asset has no animations). Lives on `root`. */
  animation: AnimationComponent | null;
  clips: AnimationClip[];
  /** Release the GPU meshes and destroy the entities this call created. */
  dispose(): void;
}

function localTrs(node: DecodedGltfNode, position: Vec3, rotation: Quat, scale: Vec3): void {
  position.set(0, 0, 0);
  rotation.set(0, 0, 0, 1);
  scale.set(1, 1, 1);
  if (node.matrix) {
    if (!new Mat4(node.matrix).decompose(position, rotation, scale)) {
      throw new UsageError(`glTF node "${node.name}" has a degenerate matrix`);
    }
    return;
  }
  if (node.translation) position.set(node.translation[0]!, node.translation[1]!, node.translation[2]!);
  if (node.rotation) rotation.set(node.rotation[0]!, node.rotation[1]!, node.rotation[2]!, node.rotation[3]!);
  if (node.scale) scale.set(node.scale[0]!, node.scale[1]!, node.scale[2]!);
}

function defaultMaterial(material: DecodedGltfMaterial | null, index: number | null, textures?: GltfTextureSet): Material {
  if (!material) return new Material({ label: "gltf.default", color: new Color(0.8, 0.8, 0.8, 1), roughness: 0.6, doubleSided: true });
  const f = material.baseColorFactor;
  const e = material.emissiveFactor;
  const m = new Material({
    label: material.name || `gltf.material-${index}`,
    color: new Color(f[0]!, f[1]!, f[2]!, 1),
    opacity: f[3]!,
    transparent: material.alphaMode === "BLEND",
    metallic: material.metallicFactor,
    roughness: material.roughnessFactor,
    doubleSided: material.doubleSided,
    albedoMap: textures?.get(material.baseColorTexture, "srgb") ?? null,
    metallicRoughnessMap: textures?.get(material.metallicRoughnessTexture, "linear") ?? null,
    normalMap: textures?.get(material.normalTexture, "linear") ?? null,
    normalScale: material.normalScale ?? 1,
    // Phase 16.1c: emissive (factor × map), occlusion (ambient only), per-map samplers.
    emissive: new Color(e[0]!, e[1]!, e[2]!, 1),
    emissiveStrength: e[0]! > 0 || e[1]! > 0 || e[2]! > 0 ? 1 : 0,
    emissiveMap: textures?.get(material.emissiveTexture, "srgb") ?? null,
    occlusionMap: textures?.get(material.occlusionTexture, "linear") ?? null,
    occlusionStrength: material.occlusionStrength,
    uvSets: {
      albedo: material.baseColorTexCoord === 1 ? 1 : 0,
      normal: material.normalTexCoord === 1 ? 1 : 0,
      metallicRoughness: material.metallicRoughnessTexCoord === 1 ? 1 : 0,
      emissive: material.emissiveTexCoord === 1 ? 1 : 0,
      occlusion: material.occlusionTexCoord === 1 ? 1 : 0,
    },
    samplers: textures ? {
      albedo: textures.sampler(material.baseColorTexture),
      normal: textures.sampler(material.normalTexture),
      metallicRoughness: textures.sampler(material.metallicRoughnessTexture),
      emissive: textures.sampler(material.emissiveTexture),
      occlusion: textures.sampler(material.occlusionTexture),
    } : undefined,
  });
  // alpha MASK: discard below the cutoff, drawn opaque (glTF ignores alpha otherwise).
  if (material.alphaMode === "MASK") m.alphaTest = material.alphaCutoff;
  return m;
}

/** Expand glTF's VEC3 morph tangent delta into the renderer's xyzw tangent stream, preserving w. */
function morphTangentDelta(values: Float32Array | undefined, vertexCount: number): Float32Array | null {
  if (!values) return null;
  const expanded = new Float32Array(vertexCount * 4);
  for (let vertex = 0; vertex < vertexCount; vertex++) {
    expanded[vertex * 4] = values[vertex * 3] ?? 0;
    expanded[vertex * 4 + 1] = values[vertex * 3 + 1] ?? 0;
    expanded[vertex * 4 + 2] = values[vertex * 3 + 2] ?? 0;
  }
  return expanded;
}

function primitiveMesh(device: GraphicsDevice, primitive: DecodedGltfPrimitive, label: string, skinned: boolean, inverseBindMatrices: Float32Array | null): Mesh {
  const positions = primitive.attributes.POSITION!;
  const vertexCount = primitive.vertexCount;
  let indices = primitive.indices;
  if (!indices) {
    indices = new Uint32Array(vertexCount);
    for (let i = 0; i < vertexCount; i++) indices[i] = i;
  }
  const uvs = primitive.attributes.TEXCOORD_0 ?? new Float32Array(vertexCount * 2);
  const uvs1 = primitive.attributes.TEXCOORD_1 ?? null;
  let normals = primitive.attributes.NORMAL ?? null;
  let tangents = primitive.attributes.TANGENT ?? null;
  if (!normals || !tangents) {
    const generated = computeNormalsAndTangents(positions, indices, uvs);
    normals ??= generated.normals;
    tangents ??= generated.tangents;
  }
  return Mesh.from(device, {
    label,
    positions,
    normals,
    uvs,
    uvs1,
    tangents,
    indices,
    morphTargets: primitive.morphTargets.map((target) => ({
      positions: target.attributes.POSITION ?? null,
      normals: target.attributes.NORMAL ?? null,
      tangents: morphTangentDelta(target.attributes.TANGENT, vertexCount),
    })),
    skin: skinned && primitive.skin && inverseBindMatrices
      ? { inverseBindMatrices, joints: primitive.skin.joints, weights: primitive.skin.weights }
      : undefined,
  });
}

/** Instantiate `asset` into `scene`. See the module comment for what is and is not imported. */
export function instantiateGltfScene(device: GraphicsDevice, scene: Scene, asset: DecodedGltfAsset, options: InstantiateGltfSceneOptions = {}): GltfSceneInstance {
  const created: Entity[] = [];
  const meshes: Mesh[] = [];
  const makeEntity = (name: string, parent: Entity | null): Entity => {
    const entity = scene.createEntity(name);
    entity.add(new Transform());
    if (parent) entity.parent = parent;
    created.push(entity);
    return entity;
  };
  try {
    const root = makeEntity(options.name ?? asset.source, options.parent ?? null);
    const sceneIndex = options.sceneIndex ?? (asset.sceneIndex >= 0 ? asset.sceneIndex : asset.scenes.length > 0 ? 0 : -1);
    let roots: number[];
    if (sceneIndex >= 0) {
      const sceneDef = asset.scenes[sceneIndex];
      if (!sceneDef) throw new UsageError(`glTF scene ${sceneIndex} does not exist in ${asset.source}`);
      roots = sceneDef.nodes;
    } else {
      const isChild = new Set(asset.nodes.flatMap((n) => n.children));
      roots = asset.nodes.map((_, i) => i).filter((i) => !isChild.has(i));
    }

    const nodes: (Entity | null)[] = asset.nodes.map(() => null);
    const restPose = new Float32Array(Math.max(1, asset.nodes.length) * NODE_STRIDE);
    const position = new Vec3();
    const rotation = new Quat();
    const scale = new Vec3();
    const visit = (index: number, parent: Entity): void => {
      if (nodes[index]) throw new UsageError(`glTF node ${index} is reachable twice in ${asset.source}`);
      const node = asset.nodes[index]!;
      const entity = makeEntity(node.name, parent);
      localTrs(node, position, rotation, scale);
      const transform = entity.require(Transform);
      transform.position.copyFrom(position);
      transform.rotation.copyFrom(rotation);
      transform.scale.copyFrom(scale);
      transform.sync();
      const off = index * NODE_STRIDE;
      restPose.set([position.x, position.y, position.z, rotation.x, rotation.y, rotation.z, rotation.w, scale.x, scale.y, scale.z], off);
      nodes[index] = entity;
      for (const child of node.children) visit(child, entity);
    };
    for (const index of roots) visit(index, root);
    for (let i = 0; i < asset.nodes.length; i++) {
      if (!nodes[i]) restPose.set([0, 0, 0, 0, 0, 0, 1, 1, 1, 1], i * NODE_STRIDE);
    }

    const materialFor = options.material ?? ((m: DecodedGltfMaterial | null, i: number | null) => defaultMaterial(m, i, options.textures));
    const materialCache = new Map<number | null, Material>();
    const morphBindings: { nodeIndex: number; geometry: import("../rendering/geometry.js").Geometry; defaults: Float32Array }[] = [];
    const addRenderable = (target: Entity, gpuMesh: Mesh, material: Material): void => {
      const renderable = new Renderable();
      renderable.geometry = gpuMesh.geometry;
      renderable.material = material;
      renderable.skin = gpuMesh.skin;
      target.add(renderable);
    };
    const setInstanceTransform = (target: Entity, instancing: NonNullable<DecodedGltfNode["instancing"]>, instanceIndex: number): void => {
      const transform = target.require(Transform);
      const t = instancing.translations;
      transform.position.set(t[instanceIndex * 3]!, t[instanceIndex * 3 + 1]!, t[instanceIndex * 3 + 2]!);
      if (instancing.rotations) {
        const r = instancing.rotations;
        transform.rotation.set(r[instanceIndex * 4]!, r[instanceIndex * 4 + 1]!, r[instanceIndex * 4 + 2]!, r[instanceIndex * 4 + 3]!);
      }
      if (instancing.scales) {
        const sc = instancing.scales;
        transform.scale.set(sc[instanceIndex * 3]!, sc[instanceIndex * 3 + 1]!, sc[instanceIndex * 3 + 2]!);
      }
      transform.sync();
    };
    asset.nodes.forEach((node, index) => {
      const entity = nodes[index];
      if (!entity || node.meshIndex === null) return;
      const mesh = asset.meshes[node.meshIndex]!;
      const skin = node.skinIndex === null ? null : asset.skins[node.skinIndex]!;
      if (skin) {
        const missing = skin.joints.find((joint) => !nodes[joint]);
        if (missing !== undefined) throw new UsageError(`glTF skin ${node.skinIndex} joint node ${missing} is not in the instantiated scene`);
      }
      mesh.primitives.forEach((primitive, primitiveIndex) => {
        const gpuMesh = primitiveMesh(device, primitive, `${mesh.name}.${primitiveIndex}`, skin !== null, skin?.inverseBindMatrices ?? null);
        meshes.push(gpuMesh);
        if (skin && gpuMesh.skin) {
          gpuMesh.skin.joints = skin.joints.map((joint) => nodes[joint]!.id);
          gpuMesh.skin.root = skin.skeleton !== null ? nodes[skin.skeleton]?.id ?? null : null;
        }
        const weights = node.weights ?? mesh.weights ?? new Float32Array(primitive.morphTargets.length);
        if (primitive.morphTargets.length > 0) {
          gpuMesh.geometry.applyMorphWeights(weights);
          morphBindings.push({ nodeIndex: index, geometry: gpuMesh.geometry, defaults: Float32Array.from(weights) });
        }
        let material = materialCache.get(primitive.materialIndex);
        if (!material) {
          material = materialFor(primitive.materialIndex === null ? null : asset.materials[primitive.materialIndex]!, primitive.materialIndex);
          materialCache.set(primitive.materialIndex, material);
        }
        const instancing = node.instancing;
        if (!instancing) {
          const target = primitiveIndex === 0 ? entity : makeEntity(`${node.name}.primitive-${primitiveIndex}`, entity);
          addRenderable(target, gpuMesh, material);
          return;
        }
        for (let instanceIndex = 0; instanceIndex < instancing.count; instanceIndex++) {
          const target = makeEntity(`${node.name}.instance-${instanceIndex}${primitiveIndex === 0 ? "" : `.primitive-${primitiveIndex}`}`, entity);
          setInstanceTransform(target, instancing, instanceIndex);
          addRenderable(target, gpuMesh, material);
        }
      });
    });

    let animation: AnimationComponent | null = null;
    const clips = assembleClips(asset.animations ?? []);
    if (clips.length > 0) {
      animation = new AnimationComponent();
      animation.nodeToEntity = nodes.map((entity) => (entity ? entity.id : -1));
      animation.restPose = restPose;
      for (const binding of morphBindings) {
        animation.bindMorphTarget(binding.nodeIndex, binding.defaults, (weights) => binding.geometry.applyMorphWeights(weights));
      }
      for (const clip of clips) animation.addClip(clip);
      root.add(animation);
    }

    let disposed = false;
    return {
      root,
      nodes,
      meshes,
      animation,
      clips,
      dispose: () => {
        if (disposed) return;
        disposed = true;
        for (const mesh of meshes) mesh.dispose();
        for (const entity of created.reverse()) if (entity.isValid) scene.destroyEntity(entity);
      },
    };
  } catch (error) {
    for (const mesh of meshes) mesh.dispose();
    for (const entity of created.reverse()) if (entity.isValid) scene.destroyEntity(entity);
    throw error;
  }
}
