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
 * - Phase 14 world population: deterministic rocks, boulders, debris, rosette scrub, ground decals
 *   and mineral spires scattered per streamed chunk (`PopulationWorld`), drawn as instanced batches
 *   with no entity per instance, GPU-selected hi/lo LOD on the rock types, and per-chunk device culling.
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
  Geometry,
  type Engine,
  Light,
  MARS_ATMOSPHERE,
  Material,
  PopulationWorld,
  Scene,
  Vec3,
  TerrainWorld,
  boxGeometrySource,
  buildLodGeometry,
  coneGeometrySource,
  createAtmosphere,
  discGeometrySource,
  rockGeometrySource,
  rosetteGeometrySource,
  unindexedLodWindow,
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

  // Phase 14 — world population. Six deterministic types share the streamed disc: rocks and
  // boulders (hi/lo GPU LOD), fractured debris, rosette scrub, flat erosion decals, and low mineral
  // spires. Placement is a pure function of (seed, chunk, type) over the chunk's heightmap; remeshes
  // re-anchor to the new surface rather than re-scattering. None creates per-instance entities, and
  // the device object culler drops whole per-type chunk batches past each `maxDistance`.
  const rockMaterial = new Material({
    label: "mars-rock",
    color: Color.fromSrgbHex(0x9a6a4e),
    roughness: 0.96,
    metallic: 0.03,
  });
  // Phase 14.4: GPU-selected LOD. Each type's geometry is a *merged* hi+lo buffer (unindexed, the
  // high window's triangles first, then the low window's); the `forge.populationLod` dispatch
  // picks each instance's window from the camera, so near instances keep the fine facets and,
  // beyond `lodDistance`, the GPU switches them to the coarse silhouette with no per-frame copy.
  // The lo window is the same rock at fewer segments — same seed, so the same displacement field
  // on coarser facets, which keeps the silhouette honest at the switch distance.
  const rockLod = buildLodGeometry({
    hi: unindexedLodWindow(rockGeometrySource({ radius: 0.8, segments: 7, seed: 7, roughness: 0.34 })),
    lo: unindexedLodWindow(rockGeometrySource({ radius: 0.8, segments: 4, seed: 7, roughness: 0.34 })),
  });
  const boulderLod = buildLodGeometry({
    hi: unindexedLodWindow(rockGeometrySource({ radius: 2.4, segments: 8, seed: 11, roughness: 0.3, flatten: 0.4 })),
    lo: unindexedLodWindow(rockGeometrySource({ radius: 2.4, segments: 4, seed: 11, roughness: 0.3, flatten: 0.4 })),
  });
  const rockGeometry = gpu ? Geometry.create(gpu, rockLod.source) : null;
  const boulderGeometry = gpu ? Geometry.create(gpu, boulderLod.source) : null;

  // 14.2's remaining population types use small, deterministic prototype meshes. Debris is a flat
  // fractured slab; the rosette is a radial ribbon-leaf succulent; decals are thin +Y discs; the
  // environmental prop is a six-sided mineral spire with its base at the origin.
  const debrisGeometry = gpu ? Geometry.create(gpu, boxGeometrySource({ width: 0.9, height: 0.22, depth: 0.52 })) : null;
  const vegetationGeometry = gpu ? Geometry.create(gpu, rosetteGeometrySource({ leaves: 8, radius: 0.42, height: 0.6, leafWidth: 0.11 })) : null;
  const decalGeometry = gpu ? Geometry.create(gpu, discGeometrySource({ radiusX: 0.55, radiusZ: 0.34, segments: 12 })) : null;
  const spireSource = coneGeometrySource({ radius: 0.32, height: 0.95, radialSegments: 6 });
  for (let i = 1; i < spireSource.positions.length; i += 3) spireSource.positions[i] += 0.475;
  const spireGeometry = gpu ? Geometry.create(gpu, spireSource) : null;

  const debrisMaterial = new Material({ label: "mars-debris", color: Color.fromSrgbHex(0x71645a), roughness: 0.98, metallic: 0.02 });
  const vegetationMaterial = new Material({ label: "mars-rosette", color: Color.fromSrgbHex(0x617044), roughness: 0.88, metallic: 0.0 });
  const decalMaterial = new Material({ label: "mars-erosion-decals", color: Color.fromSrgbHex(0x704337), roughness: 1.0, transparent: true, opacity: 0.58, doubleSided: true });
  const spireMaterial = new Material({ label: "mars-mineral-spire", color: Color.fromSrgbHex(0x9b7860), roughness: 0.72, metallic: 0.12 });

  const population = new PopulationWorld({
    terrain,
    types: [
      {
        id: 1,
        label: "rocks",
        densityGrid: 6,
        scaleMin: 0.3,
        scaleMax: 1.7,
        scaleExponent: 1.7,
        slopeLimit: 0.55,
        tintJitter: 0.3,
        maxDistance: 550,
        geometry: rockGeometry,
        material: rockMaterial,
        lod: { hiTriangles: rockLod.hiTriangles, distance: 260 },
      },
      {
        id: 2,
        label: "boulders",
        densityGrid: 2,
        scaleMin: 0.6,
        scaleMax: 1.4,
        slopeLimit: 0.4,
        tintJitter: 0.25,
        embed: 0.25,
        maxDistance: 800,
        geometry: boulderGeometry,
        material: rockMaterial,
        // Larger prototypes stay high-detail longer: the switch distance tracks the type's scale.
        lod: { hiTriangles: boulderLod.hiTriangles, distance: 420 },
      },
      {
        id: 3,
        label: "debris",
        densityGrid: 2,
        scaleMin: 0.35,
        scaleMax: 1.2,
        scaleExponent: 1.6,
        slopeLimit: 0.68,
        tintJitter: 0.12,
        embed: 0.35,
        maxDistance: 320,
        geometry: debrisGeometry,
        material: debrisMaterial,
      },
      {
        id: 4,
        label: "rosette-scrub",
        densityGrid: 3,
        scaleMin: 0.45,
        scaleMax: 1.25,
        scaleExponent: 1.3,
        slopeLimit: 0.38,
        tintJitter: 0.1,
        embed: 0.05,
        maxDistance: 360,
        geometry: vegetationGeometry,
        material: vegetationMaterial,
      },
      {
        id: 5,
        label: "erosion-decals",
        densityGrid: 2,
        scaleMin: 0.7,
        scaleMax: 1.45,
        slopeLimit: 0.18,
        embed: -0.015,
        castShadow: false,
        maxDistance: 190,
        geometry: decalGeometry,
        material: decalMaterial,
      },
      {
        id: 6,
        label: "mineral-spires",
        densityGrid: 1,
        scaleMin: 0.7,
        scaleMax: 1.4,
        scaleExponent: 1.5,
        slopeLimit: 0.28,
        tintJitter: 0.08,
        embed: 0.06,
        maxDistance: 850,
        geometry: spireGeometry,
        material: spireMaterial,
      },
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
      rockGeometry?.dispose();
      boulderGeometry?.dispose();
      debrisGeometry?.dispose();
      vegetationGeometry?.dispose();
      decalGeometry?.dispose();
      spireGeometry?.dispose();
      rockMaterial.dispose();
      debrisMaterial.dispose();
      vegetationMaterial.dispose();
      decalMaterial.dispose();
      spireMaterial.dispose();
      terrainMat.dispose();
      terrain.dispose();
      disposePbrTextureSet(marsMaps);
    },
  };
}
