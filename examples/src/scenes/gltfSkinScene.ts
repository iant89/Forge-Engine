/**
 * Phase 16.1f scene: an imported, skinned and animated glTF drawn through the GPU skinning path.
 *
 * `examples/assets/SimpleSkin.gltf` (Khronos sample, CC0 — see `examples/assets/SimpleSkin.README.md`)
 * is fetched, decoded by `decodeGltfMesh` (geometry, the skin, JOINTS_0/WEIGHTS_0 and the animation),
 * then `instantiateGltfScene` builds its node hierarchy, binds the skin to the joint entities with the
 * file's inverse bind matrices and attaches its clip. Nothing in this file knows the asset's layout:
 * an `AnimationSystem` on the world plays the clip, and the renderer's skinned path does the bending.
 *
 * The strip is flat (1 × 2 m in the XY plane), so it is drawn double-sided and lit from the front.
 * `window.__forge.setGltfSkinTime(t)` freezes the clip at `t` seconds for the browser gate.
 */

import {
  AnimationSystem,
  Camera,
  Color,
  type Engine,
  Light,
  Material,
  Renderable,
  Scene,
  Vec3,
  createPlane,
  decodeGltfMesh,
  instantiateGltfScene,
  type GltfSceneInstance,
} from "@forge/engine";
import type { DemoSceneHandle } from "./cubesScene.js";

const ASSET_URL = new URL("../../assets/SimpleSkin.gltf", import.meta.url).href;
const CLIP = "animation-0";

export interface GltfSkinState {
  loaded: boolean;
  error: string | null;
  joints: number;
  clipTime: number;
  clipDuration: number;
  skinnedBatches: number;
  skinJoints: number;
  skinFallbacks: number;
}

export interface GltfSkinSceneHandle extends DemoSceneHandle {
  gltfSkinState: () => GltfSkinState;
  /** Freeze the clip at `t` seconds (deterministic pose for a pixel A/B). */
  setGltfSkinTime: (t: number) => void;
}

export function buildGltfSkinScene(engine: Engine): GltfSkinSceneHandle {
  const scene = new Scene({ name: "gltf-skin" });
  scene.setBackgroundColor(Color.fromSrgbHex(0x0b0f17));
  scene.settings.hdr = true;
  scene.settings.exposure = 1.1;
  scene.world.registerSystem(new AnimationSystem());

  const groundMesh = createPlane(engine.gpu, { width: 20, depth: 20 });
  const ground = scene.createTransformedEntity("ground", new Vec3(0, 0, 0));
  const groundRenderable = new Renderable();
  groundRenderable.geometry = groundMesh;
  groundRenderable.material = new Material({ label: "ground", color: 0x4d5562, roughness: 0.95 });
  groundRenderable.castShadow = false;
  scene.world.addComponent(ground.id, groundRenderable);

  const cameraEntity = scene.createTransformedEntity("camera", new Vec3(0.4, 1.4, 4.2));
  const camera = new Camera();
  camera.fovY = Math.PI / 3;
  camera.near = 0.05;
  camera.far = 100;
  scene.world.addComponent(cameraEntity.id, camera);
  cameraEntity.transform.lookAt(new Vec3(-0.3, 1.1, 0));

  const sunEntity = scene.createTransformedEntity("sun", new Vec3(2, 6, 6));
  const sun = new Light();
  sun.intensity = 5;
  scene.world.addComponent(sunEntity.id, sun);
  sunEntity.transform.lookAt(new Vec3(0, 1, 0));

  let instance: GltfSceneInstance | null = null;
  let error: string | null = null;
  let disposed = false;
  let frozenAt: number | null = null;

  const material = new Material({ label: "simple-skin", color: 0xd8873a, roughness: 0.45, metallic: 0.1, doubleSided: true });
  void (async () => {
    try {
      const response = await fetch(ASSET_URL);
      if (!response.ok) throw new Error(`${ASSET_URL}: HTTP ${response.status}`);
      const asset = await decodeGltfMesh(await response.text(), { source: "SimpleSkin.gltf" });
      if (disposed) return;
      instance = instantiateGltfScene(engine.gpu, scene, asset, { name: "SimpleSkin", material: () => material });
      const animation = instance.animation;
      if (animation) {
        animation.setLooping(CLIP, true);
        animation.play(CLIP);
        if (frozenAt !== null) {
          animation.setTime(CLIP, frozenAt);
          animation.setSpeed(CLIP, 0);
        }
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      console.error("gltf-skin scene: load failed", e);
    }
  })();

  const state = (): GltfSkinState => {
    const render = engine.stats().render;
    const playback = instance?.animation?.getPlayback(CLIP);
    return {
      loaded: instance !== null,
      error,
      joints: instance?.meshes[0]?.skin?.joints.length ?? 0,
      clipTime: playback?.time ?? 0,
      clipDuration: playback?.clip.duration ?? 0,
      skinnedBatches: render.skinnedBatches,
      skinJoints: render.skinJoints,
      skinFallbacks: render.skinFallbacks,
    };
  };

  return {
    scene,
    cameraEntity,
    update: () => {},
    dispose: () => {
      disposed = true;
      instance?.dispose();
      groundMesh.dispose();
      scene.dispose();
    },
    gltfSkinState: state,
    setGltfSkinTime: (t: number) => {
      frozenAt = t;
      const animation = instance?.animation;
      if (!animation) return;
      animation.play(CLIP);
      animation.setTime(CLIP, t);
      animation.setSpeed(CLIP, 0);
    },
    overlay: () => {
      const s = state();
      if (s.error) return `glTF skin: LOAD FAILED (${s.error})`;
      if (!s.loaded) return "glTF skin: loading SimpleSkin.gltf…";
      return `glTF skin (SimpleSkin, CC0) · ${s.joints} joints · clip ${s.clipTime.toFixed(2)}/${s.clipDuration.toFixed(1)} s · ` +
        `${s.skinnedBatches} skinned batch${s.skinFallbacks > 0 ? ` · ${s.skinFallbacks} FALLBACK` : ""}`;
    },
    camera: {
      target: new Vec3(-0.3, 1.1, 0),
      distance: 4.2,
      azimuth: 0.1,
      elevation: 0.1,
      groundHeight: () => 0,
      groundClearance: 0.3,
    },
  };
}
