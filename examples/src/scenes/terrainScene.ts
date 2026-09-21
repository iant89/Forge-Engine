/**
 * Phase 4 Scene: Procedural Martian Landscape.
 *
 * Demonstrates:
 * - 10 km+ visible procedural world with multi-octave fBm and mountain ridges.
 * - Impact craters with uplifted rims, excavated bowls, and central rebound peaks.
 * - Continuous bicubic elevation sampling for camera elevation and ground clamping.
 * - Dynamic quadtree chunk streaming and distance LOD.
 * - Directional sun light casting cascaded shadow maps across the terrain contours.
 */
import {
  Camera,
  Color,
  type Engine,
  Light,
  Material,
  Scene,
  Vec3,
  TerrainWorld,
} from "@forge/engine";
import type { DemoSceneHandle } from "./cubesScene.js";

export function buildTerrainScene(_engine: Engine): DemoSceneHandle {
  const scene = new Scene({ name: "terrain-demo" });
  scene.setBackgroundColor(Color.fromSrgbHex(0x1a0f0d));

  // Enable HDR, tone-mapping, and atmospheric fog
  scene.settings.hdr = true;
  scene.settings.exposure = 1.1;
  scene.settings.toneMapping = "aces";
  scene.settings.bloom.enabled = true;
  scene.settings.bloom.threshold = 1.0;
  scene.settings.bloom.intensity = 0.05;

  scene.setFog("exp2", {
    density: 0.0003,
    color: Color.fromSrgbHex(0xb56345),
  });

  scene.settings.shadow.enabled = true;
  scene.settings.shadow.cascades = 3;
  scene.settings.shadow.mapSize = 2048;
  scene.settings.shadow.distance = 250;
  scene.settings.shadow.splitLambda = 0.7;

  // Terrain material: Martian basalt & iron oxide regolith
  const terrainMat = new Material({
    label: "mars-regolith",
    color: Color.fromSrgbHex(0x9c482b),
    roughness: 0.88,
    metallic: 0.04,
  });

  const terrain = new TerrainWorld({
    seed: 42137,
    chunkSize: 128,
    chunkResolution: 33,
    viewDistance: 2048,
    maxLOD: 3,
    maxChunksLoaded: 120,
    maxGenerationsPerFrame: 8,
    material: terrainMat,
    heightOptions: {
      amplitude: 55,
      frequency: 1 / 384,
      octaves: 5,
      ridgeWeight: 0.4,
    },
  });
  scene.add(terrain);

  // Directional Sun Light
  const sunEntity = scene.createTransformedEntity("sun", new Vec3(200, 300, 200));
  const sun = new Light();
  sun.kind = "directional";
  sun.intensity = 4.2;
  sun.castShadow = true;
  sun.setColor(1.0, 0.92, 0.8);
  sun.shadowBias = 0.001;
  scene.world.addComponent(sunEntity.id, sun);
  sunEntity.transform.lookAt(new Vec3(0, 0, 0));

  // Ambient fill light (dust scattering)
  const ambientEntity = scene.createTransformedEntity("ambient-fill", new Vec3(-200, -300, -200));
  const ambient = new Light();
  ambient.kind = "directional";
  ambient.intensity = 0.8;
  ambient.castShadow = false;
  ambient.setColor(0.36, 0.20, 0.16);
  scene.world.addComponent(ambientEntity.id, ambient);
  ambientEntity.transform.lookAt(new Vec3(0, 0, 0));

  // Camera placed on high ridge overlooking crater valley
  const initialCamX = 0;
  const initialCamZ = 0;
  const groundY = terrain.getHeightAt(initialCamX, initialCamZ);
  const cameraEntity = scene.createTransformedEntity("camera", new Vec3(initialCamX, groundY + 25, initialCamZ));
  const camera = new Camera();
  camera.fovY = Math.PI / 3.2;
  camera.near = 0.5;
  camera.far = 12000; // 12 km far plane
  scene.world.addComponent(cameraEntity.id, camera);

  return {
    scene,
    cameraEntity,
    update: (_dt: number) => {
      // Keep camera above ground as it moves
      const camPos = cameraEntity.getPosition();
      const minAltitude = terrain.getHeightAt(camPos.x, camPos.z) + 4.0;
      if (camPos.y < minAltitude) {
        cameraEntity.setPosition(camPos.x, minAltitude, camPos.z);
      }
    },
    dispose: () => {
      terrainMat.dispose();
      terrain.dispose();
    },
  };
}
