/**
 * Phase 12 GPU fountain. `GpuParticleWorld` owns a storage buffer; the renderer runs
 * particle.sim / particle.sort / particle.render / particle.resolve. No per-particle ECS
 * sprites — capacity can be 100k without 100k entities.
 *
 * The Phase 7 CPU `ParticleWorld` path remains available for reference tests; this demo is the
 * GPU-authoritative scene the exit criteria require.
 */

import {
  Camera,
  Color,
  type Engine,
  GpuParticleWorld,
  Light,
  Material,
  Renderable,
  Scene,
  Vec3,
  createBox,
  createPlane,
} from "@forge/engine";
import type { DemoSceneHandle } from "./cubesScene.js";

/** Demo capacity — large enough to prove the no-ECS invariant without starving low-end GPUs. */
const CAPACITY = 100_000;

export function buildParticleScene(engine: Engine): DemoSceneHandle {
  const scene = new Scene({ name: "particles" });
  scene.setBackgroundColor(Color.fromSrgbHex(0x07060a));
  scene.settings.hdr = true;
  scene.settings.exposure = 1.15;
  scene.settings.bloom.enabled = true;
  scene.settings.bloom.threshold = 0.85;
  scene.settings.bloom.intensity = 0.55;
  scene.settings.shadow.enabled = false;

  const fountain = new GpuParticleWorld({
    name: "gpu-particles",
    capacity: CAPACITY,
    seed: 7,
    maxEmitsPerFrame: 2048,
    softParticles: true,
    stretch: 0.35,
    cullDistance: 60,
    emitter: {
      rate: 6000,
      lifeMin: 1.2,
      lifeMax: 2.2,
      size: 0.22,
      position: { x: 0, y: 0.35, z: 0 },
      jitter: { x: 0.2, y: 0.05, z: 0.2 },
      coneDir: { x: 0, y: 1, z: 0 },
      coneAngle: 0.32,
      speedMin: 5,
      speedMax: 9,
      color: { r: 1, g: 0.78, b: 0.28, a: 1 },
    },
    modules: {
      gravity: { x: 0, y: -9.81, z: 0 },
      drag: 0.4,
      turbulence: 2.2,
      noiseScale: 0.4,
      sizeStart: 0.28,
      sizeEnd: 0.04,
      colorFrom: { r: 1, g: 0.78, b: 0.28, a: 1 },
      colorTo: { r: 0.75, g: 0.1, b: 0.04, a: 0 },
      rotationSpeed: 0.8,
    },
  });
  // Awaitable so callers / browser-check can wait for init instead of racing settle frames.
  const deviceReady = fountain.attachDevice(engine.gpu);
  scene.add(fountain);

  const groundMesh = createPlane(engine.gpu, { width: 24, depth: 24 });
  const ground = scene.createTransformedEntity("ground", new Vec3(0, 0, 0));
  const groundRenderable = new Renderable();
  groundRenderable.geometry = groundMesh;
  groundRenderable.material = new Material({ label: "pad", color: 0x1e293b, roughness: 0.9, metallic: 0 });
  groundRenderable.castShadow = false;
  scene.world.addComponent(ground.id, groundRenderable);

  const pedestalMesh = createBox(engine.gpu, { width: 0.6, height: 0.35, depth: 0.6 });
  const pedestal = scene.createTransformedEntity("pedestal", new Vec3(0, 0.175, 0));
  const pedestalRenderable = new Renderable();
  pedestalRenderable.geometry = pedestalMesh;
  pedestalRenderable.material = new Material({ label: "pedestal", color: 0x334155, roughness: 0.55, metallic: 0.2 });
  pedestalRenderable.castShadow = false;
  scene.world.addComponent(pedestal.id, pedestalRenderable);

  const cameraEntity = scene.createTransformedEntity("camera", new Vec3(5, 3.2, 7));
  const camera = new Camera();
  camera.fovY = Math.PI / 3;
  camera.near = 0.05;
  camera.far = 80;
  scene.world.addComponent(cameraEntity.id, camera);
  cameraEntity.transform.lookAt(new Vec3(0, 1.4, 0));

  const sunEntity = scene.createTransformedEntity("sun", new Vec3(4, 8, 3));
  const sun = new Light();
  sun.kind = "directional";
  sun.intensity = 3;
  sun.castShadow = false;
  sun.setColor(0.85, 0.88, 1);
  scene.world.addComponent(sunEntity.id, sun);
  sunEntity.transform.lookAt(new Vec3(0, 0, 0));

  return {
    scene,
    cameraEntity,
    controlsHint: "Drag to orbit · Right-drag or arrows to pan · Scroll to zoom",
    camera: {
      target: new Vec3(0, 1.4, 0),
      distance: 9,
      minDistance: 3,
      maxDistance: 28,
      azimuth: 0.6,
      elevation: 0.32,
    },
    update(): void {
      // GpuParticleWorld is stepped by the renderer's particle.sim pass.
    },
    overlay(): string {
      const s = fountain.system;
      if (!s) return "gpu particles (initialising)";
      return `gpu particles capacity ${s.capacity}  emitted ${s.emitted}  entities ${s.entityCount()}  lastEmit ${s.lastEmitBudget}`;
    },
    /** Resolves when GpuParticleSystem.init finishes (or fails/latches). */
    ready: deviceReady,
    particleState: () => {
      const s = fountain.system;
      return {
        capacity: s?.capacity ?? CAPACITY,
        emitted: s?.emitted ?? 0,
        ready: Boolean(s?.ready),
      };
    },
    dispose(): void {
      groundMesh.dispose();
      pedestalMesh.dispose();
      scene.dispose();
    },
  };
}
