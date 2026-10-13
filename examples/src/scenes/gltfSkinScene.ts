/**
 * Phase 16.1f scene: an imported, skinned and animated glTF drawn through the GPU skinning path.
 *
 * `examples/assets/SimpleSkin.gltf` (Khronos sample, CC0 — see `examples/assets/SimpleSkin.README.md`)
 * is fetched, decoded by `decodeGltfMesh` (geometry, the skin, JOINTS_0/WEIGHTS_0 and the animation),
 * then `instantiateGltfScene` builds its node hierarchy, binds the skin to the joint entities with the
 * file's inverse bind matrices and attaches its clip. Nothing in this file knows the asset's layout:
 * an `AnimationSystem` on the world plays the clip, and the renderer's skinned path does the bending.
 *
 * `?model=cesium` loads `examples/assets/CesiumMan.glb` instead (Khronos sample, CC-BY-4.0 — see
 * `examples/assets/CesiumMan.README.md`): 19 joints, a 2 s walk cycle, drawn with its embedded JPEG
 * base-colour texture (Phase 16.1c, `loadGltfTextures`). `?model=perseverance` loads the repo's static
 * `Perseverance.glb` (WebP colour and normal maps) the same way. `setGltfSkinMaterialFeature("albedo", false)`
 * unbinds the albedo maps so the browser gate can prove the texture changes pixels. `?model=features` loads the
 * generated `MaterialFeatures.gltf` (CC0): emissive, occlusion, alpha MASK and a clamp/nearest sampler,
 * each toggled by `setGltfSkinMaterialFeature` for the gate's per-feature A/B.
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
  loadGltfTextures,
  type GltfTextureSet,
  type Texture,
  type GltfSceneInstance,
} from "@forge/engine";
import type { DemoSceneHandle } from "./cubesScene.js";

const CLIP = "animation-0";

interface SkinModel {
  id: "simple" | "cesium" | "perseverance" | "features";
  label: string;
  file: string;
  url: string;
  binary: boolean;
  cameraPosition: Vec3;
  target: Vec3;
  distance: number;
}

const MODELS: Record<SkinModel["id"], SkinModel> = {
  simple: {
    id: "simple", label: "SimpleSkin, CC0", file: "SimpleSkin.gltf", binary: false,
    url: new URL("../../assets/SimpleSkin.gltf", import.meta.url).href,
    cameraPosition: new Vec3(0.4, 1.4, 4.2), target: new Vec3(-0.3, 1.1, 0), distance: 4.2,
  },
  cesium: {
    id: "cesium", label: "CesiumMan, CC-BY-4.0 Cesium", file: "CesiumMan.glb", binary: true,
    url: new URL("../../assets/CesiumMan.glb", import.meta.url).href,
    cameraPosition: new Vec3(1.6, 1.2, 2.4), target: new Vec3(0, 0.75, 0), distance: 2.9,
  },
  // Phase 16.1c: static (unskinned) textured check for the repo's rover model.
  perseverance: {
    id: "perseverance", label: "Perseverance", file: "Perseverance.glb", binary: true,
    url: new URL("../../assets/Perseverance.glb", import.meta.url).href,
    cameraPosition: new Vec3(3.2, 2.2, 4.2), target: new Vec3(0, 1, 0), distance: 5.6,
  },
  // Phase 16.1c: generated CC0 quads, one per material feature (emissive, occlusion, MASK, sampler).
  features: {
    id: "features", label: "MaterialFeatures, CC0", file: "MaterialFeatures.gltf", binary: false,
    url: new URL("../../assets/MaterialFeatures.gltf", import.meta.url).href,
    cameraPosition: new Vec3(0, 0.9, 5.2), target: new Vec3(0, 0.8, 0), distance: 5.2,
  },
};

/** Material features the browser gate toggles one at a time (Phase 16.1c). */
export type GltfMaterialFeature = "albedo" | "emissive" | "occlusion" | "mask" | "sampler";

/** `?model=cesium` picks CesiumMan, `?model=perseverance` the rover; anything else (or no query) is SimpleSkin. */
export function selectSkinModel(search: string): SkinModel {
  const id = new URLSearchParams(search).get("model");
  return id === "cesium" || id === "perseverance" || id === "features" ? MODELS[id] : MODELS.simple;
}

export interface GltfSkinState {
  loaded: boolean;
  error: string | null;
  model: string;
  joints: number;
  clipTime: number;
  clipDuration: number;
  skinnedBatches: number;
  skinJoints: number;
  skinFallbacks: number;
  /** Phase 16.1c: GPU textures loaded / materials with a bound albedo map (and whether maps are on). */
  textures: number;
  texturedMaterials: number;
  texturesEnabled: boolean;
}

export interface GltfSkinSceneHandle extends DemoSceneHandle {
  gltfSkinState: () => GltfSkinState;
  /** Freeze the clip at `t` seconds (deterministic pose for a pixel A/B). */
  setGltfSkinTime: (t: number) => void;
  /** Turn one imported material feature off (false) or back on, for a per-feature pixel A/B. */
  setGltfSkinMaterialFeature: (feature: GltfMaterialFeature, on: boolean) => void;
}

export function buildGltfSkinScene(engine: Engine, search = typeof location === "undefined" ? "" : location.search): GltfSkinSceneHandle {
  const model = selectSkinModel(search);
  const scene = new Scene({ name: "gltf-skin" });
  scene.setBackgroundColor(Color.fromSrgbHex(0x0b0f17));
  scene.settings.hdr = true;
  scene.settings.exposure = 1.1;
  scene.world.registerSystem(new AnimationSystem());
  // Occlusion maps only darken the ambient term; lift it so the features quad reads on screen.
  if (model.id === "features") scene.settings.ambientIntensity = 3;

  const groundMesh = createPlane(engine.gpu, { width: 20, depth: 20 });
  const ground = scene.createTransformedEntity("ground", new Vec3(0, 0, 0));
  const groundRenderable = new Renderable();
  groundRenderable.geometry = groundMesh;
  groundRenderable.material = new Material({ label: "ground", color: 0x4d5562, roughness: 0.95 });
  groundRenderable.castShadow = false;
  scene.world.addComponent(ground.id, groundRenderable);

  const cameraEntity = scene.createTransformedEntity("camera", model.cameraPosition);
  const camera = new Camera();
  camera.fovY = Math.PI / 3;
  camera.near = 0.05;
  camera.far = 100;
  scene.world.addComponent(cameraEntity.id, camera);
  cameraEntity.transform.lookAt(model.target);

  const sunEntity = scene.createTransformedEntity("sun", new Vec3(2, 6, 6));
  const sun = new Light();
  sun.intensity = 5;
  scene.world.addComponent(sunEntity.id, sun);
  sunEntity.transform.lookAt(new Vec3(0, 1, 0));

  let instance: GltfSceneInstance | null = null;
  let error: string | null = null;
  let disposed = false;
  let frozenAt: number | null = null;
  let textures: GltfTextureSet | null = null;
  let texturesEnabled = true;
  const albedo = new Map<Material, Texture>();
  type Snapshot = { emissive: Texture | null; occlusion: Texture | null; alphaTest: number; samplers: Material["samplers"] };
  const imported = new Map<Material, Snapshot>();

  const material = new Material({ label: "simple-skin", color: 0xd8873a, roughness: 0.45, metallic: 0.1, doubleSided: true });
  void (async () => {
    try {
      const response = await fetch(model.url);
      if (!response.ok) throw new Error(`${model.url}: HTTP ${response.status}`);
      const body = model.binary ? await response.arrayBuffer() : await response.text();
      const asset = await decodeGltfMesh(body, { source: model.file });
      if (disposed) return;
      // SimpleSkin has no material, so it gets a demo one; the others keep their own, textured (16.1c).
      if (model.id !== "simple") {
        const set = await loadGltfTextures(engine.gpu, asset);
        if (disposed) {
          set.dispose();
          return;
        }
        textures = set;
      }
      instance = instantiateGltfScene(engine.gpu, scene, asset, model.id === "simple"
        ? { name: model.file, material: () => material }
        : { name: model.file, textures: textures! });
      // Every renderable, not just node entities: a node's second+ primitives live on child entities.
      const renderables = scene.world.query([Renderable]);
      renderables.refresh();
      for (const id of renderables.entities) {
        const m = scene.world.getComponent(id, Renderable)?.material;
        if (m?.albedoMap) albedo.set(m, m.albedoMap);
        if (m) imported.set(m, { emissive: m.emissiveMap, occlusion: m.occlusionMap, alphaTest: m.alphaTest, samplers: { ...m.samplers } });
      }
      scene.world.releaseQuery(renderables);
      if (!texturesEnabled) for (const m of albedo.keys()) m.setMaps({ albedo: null });
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
      model: model.id,
      joints: instance?.meshes[0]?.skin?.joints.length ?? 0,
      clipTime: playback?.time ?? 0,
      clipDuration: playback?.clip.duration ?? 0,
      skinnedBatches: render.skinnedBatches,
      skinJoints: render.skinJoints,
      skinFallbacks: render.skinFallbacks,
      textures: textures?.textures.length ?? 0,
      texturedMaterials: albedo.size,
      texturesEnabled,
    };
  };

  return {
    scene,
    cameraEntity,
    update: () => {},
    dispose: () => {
      disposed = true;
      instance?.dispose();
      textures?.dispose();
      groundMesh.dispose();
      scene.dispose();
    },
    gltfSkinState: state,
    setGltfSkinMaterialFeature: (feature: GltfMaterialFeature, on: boolean) => {
      if (feature === "albedo") {
        texturesEnabled = on;
        for (const [m, t] of albedo) m.setMaps({ albedo: on ? t : null });
        return;
      }
      for (const [m, s] of imported) {
        if (feature === "emissive") m.setMaps({ emissive: on ? s.emissive : null });
        else if (feature === "occlusion") m.setMaps({ occlusion: on ? s.occlusion : null });
        else if (feature === "mask") {
          m.alphaTest = on ? s.alphaTest : 0;
          m.markChanged();
        } else m.setSamplers(on ? s.samplers : { albedo: null, normal: null, metallicRoughness: null, emissive: null, occlusion: null });
      }
    },
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
      if (!s.loaded) return `glTF skin: loading ${model.file}…`;
      return `glTF skin (${model.label}) · ${s.joints} joints · clip ${s.clipTime.toFixed(2)}/${s.clipDuration.toFixed(1)} s · ` +
        `${s.skinnedBatches} skinned batch${s.skinFallbacks > 0 ? ` · ${s.skinFallbacks} FALLBACK` : ""}`;
    },
    camera: {
      target: model.target.clone(),
      distance: model.distance,
      azimuth: 0.1,
      elevation: 0.1,
      groundHeight: () => 0,
      groundClearance: 0.3,
    },
  };
}
