/**
 * Phase 7 fountain. `ParticleWorld.update` is the only stepper (it emits, integrates, and poses
 * the sprite entities). Do not also register `ParticleSystem` on this scene — that would step the
 * same simulation a second time.
 *
 * Sprites are a few hundred unlit boxes. The 100k case is a buffer benchmark, not a draw. Color and
 * size modules write the particle buffer; the shared material does not read per-particle color.
 */

import {
  Camera,
  Color,
  ColorOverLifeModule,
  type Engine,
  Light,
  Material,
  ParticleWorld,
  Renderable,
  Scene,
  SizeOverLifeModule,
  Vec3,
  createBox,
  createPlane,
} from "@forge/engine";
import type { DemoSceneHandle } from "./cubesScene.js";

const SPRITES = 200;

export function buildParticleScene(engine: Engine): DemoSceneHandle {
  const scene = new Scene({ name: "particles" });
  scene.setBackgroundColor(Color.fromSrgbHex(0x07060a));
  scene.settings.hdr = true;
  scene.settings.exposure = 1.15;
  scene.settings.bloom.enabled = true;
  scene.settings.bloom.threshold = 0.85;
  scene.settings.bloom.intensity = 0.55;
  scene.settings.shadow.enabled = false;

  const fountain = new ParticleWorld({
    name: "particles",
    capacity: SPRITES,
    gravity: { x: 0, y: -9.81, z: 0 },
    drag: 0.4,
    seed: 7,
    trailLength: 8,
  });
  fountain.simulation.emitter.rate = 80;
  fountain.simulation.emitter.lifeMin = 1.4;
  fountain.simulation.emitter.lifeMax = 2.2;
  fountain.simulation.emitter.size = 0.22;
  fountain.simulation.emitter.position.y = 0.35;
  fountain.simulation.emitter.cone.direction = { x: 0, y: 1, z: 0 };
  fountain.simulation.emitter.cone.angle = 0.32;
  fountain.simulation.emitter.cone.speedMin = 5;
  fountain.simulation.emitter.cone.speedMax = 8;
  fountain.simulation.modules.push(
    new ColorOverLifeModule({ r: 1, g: 0.78, b: 0.28, a: 1 }, { r: 0.75, g: 0.1, b: 0.04, a: 0 }),
    new SizeOverLifeModule(0.28, 0.04),
  );
  scene.add(fountain);

  const sparkMesh = createBox(engine.gpu, { width: 1, height: 1, depth: 1 });
  const sparkMaterial = Material.unlit({ color: 0xff7722, label: "spark" });
  const spriteIds: number[] = [];
  for (let i = 0; i < SPRITES; i++) {
    const spark = scene.createTransformedEntity(`spark-${i}`, new Vec3(0, -8, 0));
    const renderable = new Renderable();
    renderable.geometry = sparkMesh;
    renderable.material = sparkMaterial;
    renderable.castShadow = false;
    renderable.receiveShadow = false;
    renderable.visible = false;
    scene.world.addComponent(spark.id, renderable);
    spriteIds.push(spark.id);
  }
  fountain.spriteEntities = spriteIds;

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
      // ParticleWorld is stepped by Scene.update. Stepping here would emit and integrate twice.
    },
    overlay(): string {
      const sim = fountain.simulation;
      return `particles ${sim.alive} / ${sim.capacity}  emitted ${sim.emitted}  sprites ${fountain.spriteEntities.length}`;
    },
    particleState: () => ({
      alive: fountain.simulation.alive,
      capacity: fountain.simulation.capacity,
      emitted: fountain.simulation.emitted,
    }),
    dispose(): void {
      sparkMesh.dispose();
      groundMesh.dispose();
      pedestalMesh.dispose();
      scene.dispose();
    },
  };
}
