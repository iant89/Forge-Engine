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
 * - Phase 14 world population: six deterministic types scattered per streamed chunk (`PopulationWorld`
 *   over the engine's own presets — rocks, boulders, debris, scrub, dust decals and marker posts),
 *   drawn as instanced batches with no entity per instance and culled per chunk by the device object
 *   culler past each type's draw distance. Each chunk's instance records are uploaded once into a slot
 *   of the instance buffer rather than recomposed every frame, and every type's geometry is a LOD chain
 *   whose level the device selects per chunk inside the same pass that decides visibility.
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
  PopulationWorld,
  Scene,
  Vec3,
  TerrainWorld,
  createAtmosphere,
  createLodPrimitive,
  debrisGeometrySource,
  planeGeometrySource,
  populationPreset,
  propGeometrySource,
  rockGeometrySource,
  vegetationGeometrySource,
} from "@forge/engine";
import {
  createDustBlotchTexture,
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

  // Phase 14 — world population. Six types share the streamed disc, each one an engine *preset*
  // (`populationPreset`) wearing this scene's own geometry and material: rocks and boulders (the
  // ground cover), debris (chips collected on steeper ground), vegetation (dry scrub tufts), decals
  // (dust blotches) and props (sparse survey markers). Placement is a pure function of (seed, chunk,
  // type id) over the chunk's heightmap, so the same world always scatters the same rocks, and a
  // remesh re-anchors them to the new surface rather than re-scattering. No type creates an entity —
  // `stats.populationInstances` reports how many instances the frame drew while the entity count stays
  // at terrain chunks + lights + camera — and each type's `maxDistance` hands its chunk batches to the
  // device object culler. Each chunk's records go to the device once, into a slot of the instance
  // buffer keyed by (world, type, chunk), instead of being recomposed into the frame's arena.
  //
  // Every type's geometry is a LOD *chain* (Phase 14.4): one index buffer holding two or three levels
  // of the same shape, so the device picks the level per chunk by rewriting two words of the draw
  // record — no read-back, no second buffer. The switch distances sit inside each type's
  // `maxDistance`, so a type reaches its coarsest level before it stops drawing and the switch is never
  // the last thing you see of it.
  const rockMaterial = new Material({
    label: "mars-rock",
    color: Color.fromSrgbHex(0x9a6a4e),
    roughness: 0.96,
    metallic: 0.03,
  });
  // Scrub is a tuft of thin double-sided blades: single-sided would show the terrain through every
  // blade seen from behind, and a shadow map of them silhouettes as a solid blob, so the preset's
  // `castShadow: false` is the honest answer.
  const scrubMaterial = new Material({
    label: "mars-scrub",
    color: Color.fromSrgbHex(0x9c8a55),
    roughness: 1,
    metallic: 0,
    doubleSided: true,
  });
  // A decal is a flat quad whose *material* is the shape: transparent, with the blotch in the albedo
  // map's alpha. The renderer drops shadow casting for a transparent batch on its own, so a decal
  // never costs a shadow-map draw.
  const dustBlotch = gpu ? createDustBlotchTexture(gpu, 128) : null;
  const decalMaterial = new Material({
    label: "mars-dust-decal",
    color: 0xffffff,
    roughness: 1,
    metallic: 0,
    transparent: true,
    albedoMap: dustBlotch,
  });
  const markerMaterial = new Material({
    label: "mars-marker",
    color: Color.fromSrgbHex(0xc9c2b6),
    roughness: 0.45,
    metallic: 0.6,
  });
  const rockGeometry = gpu
    ? createLodPrimitive(gpu, {
        // `rockGeometrySource` clamps below four segments, so the levels are 8, 5 and 4 — 384, 150 and
        // 96 indices. Level 0 stays near the detail this scene drew before the chain existed.
        build: (level) => rockGeometrySource({ radius: 0.8, segments: [8, 5, 4][level]!, seed: 7, roughness: 0.34 }),
        levels: 3,
        distances: [140, 340],
      })
    : null;
  const boulderGeometry = gpu
    ? createLodPrimitive(gpu, {
        build: (level) => rockGeometrySource({ radius: 2.4, segments: [9, 6, 4][level]!, seed: 11, roughness: 0.3, flatten: 0.4 }),
        levels: 3,
        distances: [300, 620],
      })
    : null;
  const debrisGeometry = gpu
    ? createLodPrimitive(gpu, {
        build: (level) => debrisGeometrySource({ fragments: level === 0 ? 4 : 2, sides: level === 0 ? 5 : 3, radius: 0.5, seed: 23 }),
        levels: 2,
        distances: [90],
      })
    : null;
  const scrubGeometry = gpu
    ? createLodPrimitive(gpu, {
        build: (level) => vegetationGeometrySource({ blades: [9, 5, 3][level]!, segments: [3, 2, 1][level]!, height: 1, radius: 0.35, seed: 31 }),
        levels: 3,
        distances: [90, 220],
      })
    : null;
  // A decal's detail is in its alpha map, so its chain only sheds subdivisions: 4×4 near, 1×1 far.
  const decalGeometry = gpu
    ? createLodPrimitive(gpu, {
        build: (level) => planeGeometrySource({ width: 1, depth: 1, segmentsX: level === 0 ? 4 : 1, segmentsZ: level === 0 ? 4 : 1 }),
        levels: 2,
        distances: [140],
      })
    : null;
  const markerGeometry = gpu
    ? createLodPrimitive(gpu, {
        build: (level) => propGeometrySource({ radius: 0.22, height: 2.2, sides: [8, 5, 4][level]!, bevel: 0.16, roughness: 0.05, seed: 47 }),
        levels: 3,
        distances: [320, 760],
      })
    : null;
  const population = new PopulationWorld({
    terrain,
    types: [
      { ...populationPreset("rock"), geometry: rockGeometry, material: rockMaterial },
      { ...populationPreset("boulder"), geometry: boulderGeometry, material: rockMaterial },
      // The presets are engine defaults; this scene's chunk is 128 m and its disc is a kilometre, so
      // the four new types come in denser than the preset only where they can be seen: debris and
      // scrub are near-ground detail, and at the preset's own reach they would put instances in every
      // one of ~200 resident chunks for pixels no larger than a grain of sand.
      { ...populationPreset("debris", { densityGrid: 5, maxDistance: 170 }), geometry: debrisGeometry, material: rockMaterial },
      { ...populationPreset("vegetation", { densityGrid: 4, maxDistance: 260 }), geometry: scrubGeometry, material: scrubMaterial },
      // The preset lifts a decal 6 cm, which suits a mesh that follows the analytic surface. This
      // terrain's chords span 4 m over 55 m of relief, and a chord sags ~6 cm below the surface it
      // approximates — so the lift here has to clear the mesh's own error, not just the surface.
      { ...populationPreset("decal", { densityGrid: 2, maxDistance: 200, lift: 0.22 }), geometry: decalGeometry, material: decalMaterial },
      { ...populationPreset("prop", { maxDistance: 900 }), geometry: markerGeometry, material: markerMaterial },
    ],
  });
  scene.add(population);

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
      population.dispose();
      for (const geometry of [rockGeometry, boulderGeometry, debrisGeometry, scrubGeometry, decalGeometry, markerGeometry]) geometry?.dispose();
      rockMaterial.dispose();
      scrubMaterial.dispose();
      decalMaterial.dispose();
      markerMaterial.dispose();
      dustBlotch?.dispose();
      terrainMat.dispose();
      terrain.dispose();
      disposePbrTextureSet(marsMaps);
    },
  };
}
