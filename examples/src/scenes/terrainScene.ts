/**
 * Phase 4 Scene: Procedural Martian Landscape.
 *
 * Demonstrates:
 * - A procedural world of multi-octave fBm and mountain ridges, streamed in 128 m chunks.
 * - Impact craters with uplifted rims, excavated bowls, and central rebound peaks.
 * - Continuous bicubic elevation sampling that agrees with the drawn mesh, used as the camera's
 *   surface constraint (`camera.groundHeight`): the orbit camera glides over ridges instead of
 *   passing through them, and can zoom from 6 m to 1.1 km away (just past the streaming radius).
 * - The Phase 8a Martian sky (`MARS_ATMOSPHERE` through the `forge.sky` pass, sun taken from the
 *   directional light) and exp² dust haze whose colour is the model's own horizon radiance, so the
 *   loaded disc's edge fades into the sky instead of reading as a cliff.
 * - Dynamic chunk streaming with nearest-first generation inside a resident-chunk budget.
 * - Directional sun light casting cascaded shadow maps across the terrain contours.
 * - A full PBR texture set (albedo + tangent-space normal + metallic-roughness) tiled over the
 *   chunks — iron-oxide regolith with basalt patches and pebble grain, generated procedurally so
 *   the demo needs no external assets (`createMarsRegolithTextures`).
 *
 */
import {
  AtmosphereModel,
  Camera,
  Color,
  type Engine,
  Light,
  MARS_ATMOSPHERE,
  Material,
  Scene,
  Vec3,
  TerrainWorld,
  createAtmosphere,
} from "@forge/engine";
import {
  createMarsRegolithTextures,
  disposePbrTextureSet,
  type PbrTextureSet,
} from "../textures/procedural.js";
import type { DemoSceneHandle } from "./cubesScene.js";

export function buildTerrainScene(engine: Engine | null): DemoSceneHandle {
  const scene = new Scene({ name: "terrain-demo" });

  scene.settings.hdr = true;
  scene.settings.exposure = 1.1;
  scene.settings.toneMapping = "aces";
  scene.settings.bloom.enabled = true;
  scene.settings.bloom.threshold = 1.0;
  scene.settings.bloom.intensity = 0.05;

  // Martian sky: the dust-laden preset rendered by `forge.sky`; the sun direction comes from the
  // directional light below. Low quality (8×4 samples) — the terrain pass is the expensive one here.
  const marsAtmosphere = createAtmosphere({}, MARS_ATMOSPHERE);
  scene.setSky({ atmosphere: marsAtmosphere, quality: "low", sunIntensity: 20 });

  // Dust haze. exp² at this density leaves ~75 % of the terrain colour at 400 m and ~15 % at 1 km
  // (the streaming radius), so the disc's edge dissolves. The colour is the model's own horizon
  // radiance for this sun, which is what keeps the terrain/sky seam invisible.
  const sunDirection = new Vec3(200, 300, 200).normalize();
  const horizon = new AtmosphereModel(marsAtmosphere).horizonColor(sunDirection, 0, new Float64Array(3));
  scene.setFog("exp2", {
    density: 0.0014,
    color: new Color(horizon[0]!, horizon[1]!, horizon[2]!),
  });

  scene.settings.shadow.enabled = true;
  scene.settings.shadow.cascades = 3;
  scene.settings.shadow.mapSize = 2048;
  scene.settings.shadow.distance = 250;
  scene.settings.shadow.splitLambda = 0.7;

  // Terrain material: Martian basalt & iron oxide regolith. With a GPU available the maps carry
  // the surface detail and the factors are left at neutral (white tint, roughness = 1 so the MR
  // map is absolute); without one (unit tests build this scene against a null engine) the flat
  // colour stands in for the albedo.
  const gpu = engine?.gpu ?? null;
  let marsMaps: PbrTextureSet | null = null;
  if (gpu) {
    marsMaps = createMarsRegolithTextures(gpu, 512);
  }
  const terrainMat = new Material({
    label: "mars-regolith",
    color: marsMaps ? Color.fromSrgbHex(0xffffff) : Color.fromSrgbHex(0xc25127),
    roughness: marsMaps ? 1.0 : 0.88,
    metallic: 0.04,
    // 16 tiles × 128 m chunk = one 8 m repeat; integer tiling keeps chunk borders seamless
    // under the material's repeat sampler.
    tiling: marsMaps ? [16, 16] : undefined,
    albedoMap: marsMaps?.albedo ?? null,
    normalMap: marsMaps?.normal ?? null,
    metallicRoughnessMap: marsMaps?.metallicRoughness ?? null,
    normalScale: 1.6,
  });

  // Streaming budget: 128 m chunks at 33x33 (4 m cells) cost ~7 ms each to generate on a desktop
  // CPU, so the resident set and the per-frame budget are what decide whether the demo is smooth.
  // 220 chunks cover the full 1 km disc that `viewDistance` asks for; asking for more (the previous
  // 2048 m with a 120 chunk cap) selected ~900 chunks and never evicted them.
  const terrain = new TerrainWorld({
    seed: 42137,
    chunkSize: 128,
    chunkResolution: 33,
    viewDistance: 1024,
    maxLOD: 3,
    maxChunksLoaded: 220,
    maxGenerationsPerFrame: 2,
    // Warm-up burst: elevate generation + upload budgets so workers fill the opening disc in a
    // few frames. Without it the view is a two-chunk seed that drips in at uploadsPerFrame.
    warmUpChunks: 48,
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

  // Camera overlooking a crater valley. The controller (see `camera` below) owns the position from
  // here on: it clamps the eye and the orbit target to `groundClearance` above the terrain.
  const groundY = terrain.getHeightAt(0, 0);
  // Shared with OrbitControls: the live look-at so sky.seaLevel can track the pin target, not the eye.
  const orbitTarget = new Vec3(0, groundY, 0);
  // Pin sky seaLevel to the surface under the orbit look-at. With seaLevel left at 0 the atmosphere
  // treats the camera as tens of metres above a virtual planet ground while the mesh sits at
  // `groundY`; on tall iPhone FOVs that mismatch reads as a flat beige band under a phantom horizon
  // (fe-14). Pinning to the look-at (not eye XZ) keeps the band stable while the eye pumps over ridges.
  scene.settings.sky.seaLevel = groundY;
  const cameraEntity = scene.createTransformedEntity("camera", new Vec3(0, groundY + 25, 0));
  const camera = new Camera();
  camera.fovY = Math.PI / 3.2;
  // Standard (non-reversed) WebGPU depth packs precision near the camera. far/near of 12 km / 0.5 m
  // collapses grazing-angle heightfield depths into moiré on mobile 24-bit depth; minDistance is 6 m
  // so a 2 m near plane is safe and recovers ~4× depth resolution at the disc rim.
  camera.near = 2.0;
  camera.far = 2800; // past viewDistance (1 km) + fog; sky still draws at z=1
  scene.world.addComponent(cameraEntity.id, camera);

  return {
    scene,
    cameraEntity,
    camera: {
      target: orbitTarget,
      distance: 420,
      azimuth: 0.4,
      elevation: 0.34,
      // 6 m from a surface point up to 1.1 km away — the old fixed 2..50 m range was smaller than the
      // view distance, so the first wheel event yanked the camera to the ground. The cap stays near
      // `viewDistance` so the loaded disc's edge does not dominate the frame.
      minDistance: 6,
      maxDistance: 1100,
      groundClearance: 4,
      groundHeight: (x, z) => terrain.getHeightAt(x, z),
    },
    update: (_dt: number) => {
      // Keep sky observer height tied to the orbit look-at (shared Vec3 mutated by OrbitControls),
      // not the eye — otherwise ridges under the camera pump seaLevel every frame.
      scene.settings.sky.seaLevel = terrain.getHeightAt(orbitTarget.x, orbitTarget.z);
    },
    dispose: () => {
      terrainMat.dispose();
      terrain.dispose();
      disposePbrTextureSet(marsMaps);
    },
  };
}
