/**
 * Phase 1 Scene: Spinning cubes over a ground plane.
 */
import {
  Camera,
  Color,
  type Engine,
  Light,
  Material,
  Quat,
  Renderable,
  Scene,
  Vec3,
  createBox,
  createPlane,
} from "@forge/engine";
import type { OrbitCameraSetup } from "../controls/orbitControls.js";

export interface DemoSceneHandle {
  scene: Scene;
  cameraEntity: ReturnType<Scene["createTransformedEntity"]>;
  update: (dt: number) => void;
  dispose?: () => void;
  /**
   * How the orbit camera should behave in this scene: where it starts, how far it may zoom, and
   * (terrain) the surface it must stay above. Scenes that leave it out keep the controller defaults.
   */
  camera?: OrbitCameraSetup;
  /** Replaces the bottom control hint while this scene is active. */
  controlsHint?: string;
  /** Extra HUD lines under the engine stats. */
  overlay?: () => string;
  /** World point the orbit target should track each frame (the vehicle playground follows the chassis). */
  followTarget?: () => { x: number; y: number; z: number };
  /** `parkingBrake` is 0/1; the vehicle playground drives it from the PARK toggle / `P`. */
  vehicleState?: () => {
    speed: number;
    rpm: number;
    gear: number;
    x: number;
    y: number;
    z: number;
    parkingBrake?: number;
  };
  /**
   * GPU fountain accounting only. `emitted` is the cumulative spawn counter (CPU-side);
   * there is no concurrent live-count readback. Prefer `ready` + `emitted` over any fake alive.
   */
  particleState?: () => { capacity: number; emitted: number; ready: boolean };
  /** Browser verification hook for scenes with local spotlights. */
  setSpotShadows?: (enabled: boolean) => void;
  /** Browser verification hook for scenes with shadow-casting point lights. */
  setPointShadows?: (enabled: boolean) => void;
  /** Optional promise that settles when the scene's async GPU init finishes. */
  ready?: Promise<void>;
}

export function buildCubesScene(engine: Engine): DemoSceneHandle {
  const scene = new Scene({ name: "cubes" });
  scene.setBackgroundColor(Color.fromSrgbHex(0x070b12));

  const ground = scene.createTransformedEntity("ground", new Vec3(0, 0, 0));
  const groundMesh = createPlane(engine.gpu, { width: 48, depth: 48 });
  const groundRenderable = new Renderable();
  groundRenderable.geometry = groundMesh;
  groundRenderable.material = new Material({ label: "ground", color: 0x5b6470, roughness: 0.9 });
  groundRenderable.castShadow = false;
  scene.world.addComponent(ground.id, groundRenderable);

  const boxMesh = createBox(engine.gpu, { width: 1.2, height: 1.2, depth: 1.2 });
  const palette = [0xc2703d, 0x9aa5b1, 0x4d7c8f, 0x8f4d6b, 0x6b8f4d, 0xd9b382];
  const spinners: { id: number; axis: Vec3; rate: number }[] = [];

  for (let i = 0; i < palette.length; i++) {
    const entity = scene.createTransformedEntity(`cube-${i}`, new Vec3((i - 2.5) * 2.1, 0.9, Math.sin(i) * 1.5));
    const renderable = new Renderable();
    renderable.geometry = boxMesh;
    renderable.material = new Material({ label: `cube-${i}`, color: palette[i]!, roughness: 0.3 + i * 0.09, metallic: 0.2 });
    scene.world.addComponent(entity.id, renderable);
    spinners.push({ id: entity.id, axis: new Vec3(0.3, 1, 0.15).normalize(), rate: 0.35 + i * 0.13 });
  }

  const cameraEntity = scene.createTransformedEntity("camera", new Vec3(0, 3.4, -9.5));
  const camera = new Camera();
  camera.fovY = Math.PI / 3;
  camera.near = 0.1;
  camera.far = 200;
  scene.world.addComponent(cameraEntity.id, camera);
  cameraEntity.transform.lookAt(new Vec3(0, 0.8, 0));

  const sunEntity = scene.createTransformedEntity("sun", new Vec3(7, 13, -7));
  const sun = new Light();
  sun.intensity = 5;
  scene.world.addComponent(sunEntity.id, sun);
  sunEntity.transform.lookAt(new Vec3(0, 0, 0));

  const update = (dt: number): void => {
    for (const s of spinners) {
      const t = scene.world.facade(s.id)?.transform;
      if (!t) continue;
      const delta = Quat.fromAxisAngle(s.axis, s.rate * dt);
      t.rotation = delta.multiply(t.rotation).normalize();
    }
  };

  const dispose = (): void => {
    boxMesh.dispose();
    groundMesh.dispose();
    scene.dispose();
  };

  return {
    scene,
    cameraEntity,
    update,
    dispose,
    camera: {
      target: new Vec3(0, 0.8, 0),
      distance: 10.5,
      azimuth: 0,
      elevation: 0.28,
      // The ground plane is all there is to collide with, but orbiting below it is still "under the
      // map", so the same surface constraint the terrain scene uses applies here.
      groundHeight: () => 0,
      groundClearance: 0.5,
    },
  };
}
