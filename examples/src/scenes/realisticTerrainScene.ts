/**
 * Realistic Terrain Scene — Earth-like alpine / mountainous landscape.
 *
 * Demonstrates the new realistic terrain generator:
 * - Continental-scale base with domain warping for organic mountain chains
 * - Ridged multifractal peaks with sharp alpine spires
 * - Thermal weathering (talus stabilization) + hydraulic erosion (water flow)
 * - River valley carving via flow accumulation
 * - Detail noise re-injection for rocky surface roughness
 * - Climate-based biome splatting (grass, rock, sand/scree, snow)
 * - Realistic scatter (vegetation, rocks) based on biome and slope
 *
 * Presets: alpine, rolling-hills, mountainous, canyon, archipelago
 */

import {
  Camera,
  Color,
  type Engine,
  Light,
  Scene,
  Vec3,
  TerrainWorld,
  createRealisticPipelinePreset,
  createRealisticTerrainMaterial,
  type RealisticPreset,
} from "@forge/engine";
import type { DemoSceneHandle } from "./cubesScene.js";

export interface RealisticTerrainSceneOptions {
  preset?: RealisticPreset;
  seed?: number;
}

export function buildRealisticTerrainScene(
  _engine: Engine,
  options: RealisticTerrainSceneOptions = {},
): DemoSceneHandle {
  const preset = options.preset ?? "alpine";
  const seed = options.seed ?? 1337;

  const scene = new Scene({ name: `realistic-terrain-${preset}` });
  scene.setBackgroundColor(Color.fromSrgbHex(0x87ceeb)); // sky blue

  // HDR + atmosphere
  scene.settings.hdr = true;
  scene.settings.exposure = 1.0;
  scene.settings.toneMapping = "aces";
  scene.settings.bloom.enabled = true;
  scene.settings.bloom.threshold = 1.0;
  scene.settings.bloom.intensity = 0.04;

  scene.setFog("exp2", {
    density: 0.00025,
    color: Color.fromSrgbHex(0xa0c4e8),
  });

  scene.settings.shadow.enabled = true;
  scene.settings.shadow.cascades = 3;
  scene.settings.shadow.mapSize = 2048;
  scene.settings.shadow.distance = 400;
  scene.settings.shadow.splitLambda = 0.75;

  // Realistic terrain material: earthy, with PBR tuned for natural lighting
  // The splat weights from ClimateBiomeGenerator will drive texture blending
  // in a future shader; for now we use a single material that approximates
  // mixed terrain (grass + rock)
  const terrainMat = createRealisticTerrainMaterial(preset);

  // Create realistic pipeline from preset
  const pipeline = createRealisticPipelinePreset(preset, seed);

  const terrain = new TerrainWorld({
    seed,
    chunkSize: 128,
    chunkResolution: 33,
    viewDistance: 1024,
    maxLOD: 3,
    maxChunksLoaded: 220,
    maxGenerationsPerFrame: 2,
    warmUpChunks: 48,
    pipeline,
    material: terrainMat,
  });
  scene.add(terrain);

  // Sun light — more natural daylight than Martian scene
  const sunEntity = scene.createTransformedEntity("sun", new Vec3(300, 500, 200));
  const sun = new Light();
  sun.kind = "directional";
  sun.intensity = 3.5;
  sun.castShadow = true;
  sun.setColor(1.0, 0.97, 0.88); // warm daylight
  sun.shadowBias = 0.0008;
  scene.world.addComponent(sunEntity.id, sun);
  sunEntity.transform.lookAt(new Vec3(0, 0, 0));

  // Sky fill / ambient — blue sky scattering
  const skyFillEntity = scene.createTransformedEntity("sky-fill", new Vec3(-200, 300, -300));
  const skyFill = new Light();
  skyFill.kind = "directional";
  skyFill.intensity = 0.9;
  skyFill.castShadow = false;
  skyFill.setColor(0.35, 0.55, 0.85);
  scene.world.addComponent(skyFillEntity.id, skyFill);
  skyFillEntity.transform.lookAt(new Vec3(0, 0, 0));

  // Camera — start over a valley with good view of mountains
  const groundY = terrain.getHeightAt(0, 0);
  // Shared with OrbitControls so seaLevel tracks the look-at, not eye XZ over ridges (fe-14).
  const orbitTarget = new Vec3(0, groundY, 0);
  scene.settings.sky.seaLevel = groundY;
  const cameraEntity = scene.createTransformedEntity("camera", new Vec3(0, groundY + 30, 0));
  const camera = new Camera();
  camera.fovY = Math.PI / 3.0;
  // Same depth-ratio discipline as the Martian TERRAIN demo (fe-14): keep far/near modest so
  // grazing orbits do not dissolve into moiré on mobile depth buffers.
  camera.near = 2.0;
  camera.far = 3200;
  scene.world.addComponent(cameraEntity.id, camera);

  return {
    scene,
    cameraEntity,
    camera: {
      target: orbitTarget,
      distance: 500,
      azimuth: 0.6,
      elevation: 0.38,
      minDistance: 8,
      maxDistance: 1200,
      groundClearance: 5,
      groundHeight: (x, z) => terrain.getHeightAt(x, z),
    },
    update: (_dt: number) => {
      scene.settings.sky.seaLevel = terrain.getHeightAt(orbitTarget.x, orbitTarget.z);
    },
    dispose: () => {
      terrainMat.dispose();
      terrain.dispose();
    },
  };
}
