/**
 * Phase 16.5 Scene: a GPU-skinned arm.
 *
 * Four boxes are welded into one mesh, and every vertex is bound rigidly to one of four joints that
 * hang in a chain under the mesh's own entity. Nothing here touches a vertex after it is uploaded:
 * the renderer collects the joints' world matrices each frame, uploads one joint palette
 * (`rendering/skinning.ts`) and the skinned vertex entry deforms the mesh on the GPU, so an arm that
 * fails to bend is a broken palette, palette binding or vertex layout — not a demo trick. The slow
 * yaw of the rig is deliberately *not* part of the joint angles: the palette is mesh-local, so the
 * arm must turn and bend at the same time.
 *
 * `window.__forge.setSkinPose(t)` freezes the idle wave on a deterministic pose. The browser gate
 * screenshots two of them: a nearly straight arm, and the coiled pose only the GPU can produce from
 * the same vertices.
 */

import {
  Camera,
  Color,
  type Engine,
  Light,
  Material,
  Mesh,
  Quat,
  Renderable,
  Scene,
  SKIN_JOINTS_PER_VERTEX,
  Vec3,
  boxGeometrySource,
  createPlane,
} from "@forge/engine";
import type { DemoSceneHandle } from "./cubesScene.js";

/** Segments (and joints) in the arm. */
const SEGMENTS = 4;
/** Spacing between two joints, along the arm's local +X. */
const SEGMENT_SPACING = 0.95;
/** Box dimensions of one segment (slightly shorter than the spacing, so the chain reads as links). */
const SEGMENT_LENGTH = 0.85;
const SEGMENT_THICKNESS = 0.3;
/** Peak joint angle of the idle wave, radians. */
const WAVE_AMPLITUDE = 0.6;
/** Joints bend about the arm's mesh-local +Z (so the chain undulates in the XY plane). */
const BEND_AXIS = new Vec3(0, 0, 1);

export interface SkinningSceneHandle extends DemoSceneHandle {
  /** Skinned-pipeline facts for the HUD and the browser gate. */
  skinningState: () => {
    joints: number;
    skinnedBatches: number;
    skinJoints: number;
    skinFallbacks: number;
    pose: number;
  };
  /** Freeze the idle wave on the pose at `t` (deterministic, so a gate can A/B two of them). */
  setSkinPose: (t: number) => void;
}

export function buildSkinningScene(engine: Engine): SkinningSceneHandle {
  const scene = new Scene({ name: "skinning" });
  scene.setBackgroundColor(Color.fromSrgbHex(0x090b12));
  scene.settings.hdr = true;
  scene.settings.exposure = 1.1;

  // ---------------------------------------------------------------- ground
  const groundMesh = createPlane(engine.gpu, { width: 40, depth: 40 });
  const ground = scene.createTransformedEntity("ground", new Vec3(0, 0, 0));
  const groundRenderable = new Renderable();
  groundRenderable.geometry = groundMesh;
  groundRenderable.material = new Material({ label: "ground", color: 0x59616e, roughness: 0.95 });
  groundRenderable.castShadow = false;
  scene.world.addComponent(ground.id, groundRenderable);

  // ---------------------------------------------------------------- geometry
  // One box per segment, welded into a single geometry. Positions are mesh-local: segment `i` starts
  // at joint `i` and runs along +X, and its vertices are bound rigidly to that joint — the simplest
  // weight set the vertex stage has to blend, and one where a wrong palette is obvious (the links
  // detach from each other instead of chaining).
  const sources = Array.from({ length: SEGMENTS }, () =>
    boxGeometrySource({ width: SEGMENT_LENGTH, height: SEGMENT_THICKNESS, depth: SEGMENT_THICKNESS }),
  );
  let vertexCount = 0;
  let indexCount = 0;
  for (const s of sources) {
    vertexCount += s.positions.length / 3;
    indexCount += s.indices ? s.indices.length : 0;
  }
  const positions = new Float32Array(vertexCount * 3);
  const normals = new Float32Array(vertexCount * 3);
  const uvs = new Float32Array(vertexCount * 2);
  const tangents = new Float32Array(vertexCount * 4);
  const indices = new Uint32Array(indexCount);
  const joints = new Uint16Array(vertexCount * SKIN_JOINTS_PER_VERTEX);
  const weights = new Float32Array(vertexCount * SKIN_JOINTS_PER_VERTEX);
  let vertexBase = 0;
  let indexBase = 0;
  for (let segment = 0; segment < SEGMENTS; segment++) {
    const src = sources[segment]!;
    const count = src.positions.length / 3;
    const xOffset = segment * SEGMENT_SPACING;
    for (let v = 0; v < count; v++) {
      const at = vertexBase + v;
      positions[at * 3] = (src.positions[v * 3] ?? 0) + xOffset;
      positions[at * 3 + 1] = src.positions[v * 3 + 1] ?? 0;
      positions[at * 3 + 2] = src.positions[v * 3 + 2] ?? 0;
      normals[at * 3] = src.normals?.[v * 3] ?? 0;
      normals[at * 3 + 1] = src.normals?.[v * 3 + 1] ?? 1;
      normals[at * 3 + 2] = src.normals?.[v * 3 + 2] ?? 0;
      uvs[at * 2] = src.uvs?.[v * 2] ?? 0;
      uvs[at * 2 + 1] = src.uvs?.[v * 2 + 1] ?? 0;
      tangents[at * 4] = src.tangents?.[v * 4] ?? 1;
      tangents[at * 4 + 1] = src.tangents?.[v * 4 + 1] ?? 0;
      tangents[at * 4 + 2] = src.tangents?.[v * 4 + 2] ?? 0;
      tangents[at * 4 + 3] = src.tangents?.[v * 4 + 3] ?? 1;
      // Rigid binding: joint `segment` with weight 1. The other three slots stay explicit zeros
      // because the shader blends all four and normalises — an unwritten slot would read as joint 0
      // at weight 0.
      joints[at * SKIN_JOINTS_PER_VERTEX] = segment;
      weights[at * SKIN_JOINTS_PER_VERTEX] = 1;
    }
    const srcIndices = src.indices ?? new Uint32Array(0);
    for (let k = 0; k < srcIndices.length; k++) indices[indexBase + k] = srcIndices[k]! + vertexBase;
    vertexBase += count;
    indexBase += srcIndices.length;
  }

  // ---------------------------------------------------------------- rig
  const arm = scene.createTransformedEntity("arm", new Vec3(0, 1.4, 0));
  const joints_ = [] as ReturnType<Scene["createTransformedEntity"]>[];
  const inverseBindMatrices = new Float32Array(SEGMENTS * 16);
  for (let i = 0; i < SEGMENTS; i++) {
    // Joint `i` sits at the start of segment `i` in bind pose, so its inverse bind matrix is the
    // translation back to that joint's own space in the mesh's local frame.
    const x = i * SEGMENT_SPACING;
    const ibm = inverseBindMatrices.subarray(i * 16, (i + 1) * 16);
    ibm[0] = 1;
    ibm[5] = 1;
    ibm[10] = 1;
    ibm[15] = 1;
    ibm[12] = -x;
    const joint = scene.createTransformedEntity(`joint-${i}`, new Vec3(i === 0 ? 0 : SEGMENT_SPACING, 0, 0));
    joint.parent = i === 0 ? arm : joints_[i - 1]!;
    joints_.push(joint);
  }

  const armMesh = Mesh.from(engine.gpu, {
    label: "skinning.arm",
    positions,
    normals,
    uvs,
    tangents,
    indices,
    skin: {
      jointNames: joints_.map((_, i) => `joint-${i}`),
      inverseBindMatrices,
      joints,
      weights,
    },
  });
  // The demo created the joints itself, so the names resolve without a scene lookup.
  armMesh.skin!.joints = joints_.map((j) => j.id);
  armMesh.skin!.root = arm.id;
  const armRenderable = new Renderable();
  armRenderable.geometry = armMesh.geometry;
  armRenderable.material = new Material({ label: "arm", color: 0xd08a3e, roughness: 0.35, metallic: 0.35 });
  armRenderable.skin = armMesh.skin;
  scene.world.addComponent(arm.id, armRenderable);

  // ---------------------------------------------------------------- camera + light
  const cameraEntity = scene.createTransformedEntity("camera", new Vec3(-1.8, 3.2, -7.4));
  const camera = new Camera();
  camera.fovY = Math.PI / 3;
  camera.near = 0.1;
  camera.far = 200;
  scene.world.addComponent(cameraEntity.id, camera);
  cameraEntity.transform.lookAt(new Vec3(1.6, 1.3, 0));

  const sunEntity = scene.createTransformedEntity("sun", new Vec3(5, 11, -6));
  const sun = new Light();
  sun.intensity = 5;
  scene.world.addComponent(sunEntity.id, sun);
  sunEntity.transform.lookAt(new Vec3(0, 0, 0));

  // ---------------------------------------------------------------- pose
  // One scratch quaternion: the joints are written every frame, and the pose is a pure function of
  // `poseTime` so two gate screenshots of the same time are the same pose.
  const scratch = new Quat();
  let poseTime = 0;
  let frozen = false;

  const applyPose = (t: number): void => {
    for (let i = 0; i < joints_.length; i++) {
      // A travelling wave down the chain: each joint lags the one before it, which reads as a
      // flexible arm rather than a single hinge.
      scratch.setAxisAngle(BEND_AXIS, WAVE_AMPLITUDE * Math.sin(t * 1.7 - i * 0.75));
      joints_[i]!.transform.rotation = scratch;
    }
    scratch.setAxisAngle(new Vec3(0, 1, 0), 0.2);
    arm.transform.rotation = scratch;
  };
  applyPose(0);

  const update = (dt: number): void => {
    if (!frozen) poseTime += dt;
    applyPose(poseTime);
  };

  const dispose = (): void => {
    armMesh.dispose();
    groundMesh.dispose();
    scene.dispose();
  };

  return {
    scene,
    cameraEntity,
    update,
    dispose,
    skinningState: () => {
      const render = engine.stats().render;
      return {
        joints: joints_.length,
        skinnedBatches: render.skinnedBatches,
        skinJoints: render.skinJoints,
        skinFallbacks: render.skinFallbacks,
        pose: poseTime,
      };
    },
    setSkinPose: (t: number) => {
      frozen = true;
      poseTime = t;
      applyPose(t);
    },
    overlay: () => {
      const render = engine.stats().render;
      return `skinning ${joints_.length} joints · ${render.skinnedBatches} skinned batch · ` +
        `${render.skinJoints} joints/frame${render.skinFallbacks > 0 ? ` · ${render.skinFallbacks} FALLBACK` : ""}`;
    },
    camera: {
      target: new Vec3(1.6, 1.3, 0),
      distance: 8.2,
      azimuth: 0.22,
      elevation: 0.24,
      groundHeight: () => 0,
      groundClearance: 0.5,
    },
  };
}
