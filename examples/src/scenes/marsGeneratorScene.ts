/**
 * Phase 10.9 inspector: the **ported Mars generator** at any site on its own planet.
 *
 * `?scene=mars-showcase` (the landing-page default) drives the rover on one surveyed patch of the
 * port's planet — `MARS_SHOWCASE_SITE`, 0°N 0°E, chosen because that traverse keeps six wheels
 * planted. This scene is the complement: the same `MarsTerrainStage`, no rover, and the site comes
 * from the URL, so the port's planet can be inspected anywhere.
 *
 * - `?scene=mars-generator` — `MARS_SITE_PRESETS.olympusMons` (the 21 km shield volcano the ported
 *   generator's own CLI defaults to), the advised demo sizing from `adviseMarsTile` (128 m tiles at
 *   33², the `micro` band, 32 m skirts), and worker-backed cell generation like the showcase.
 * - `?marssite=vallesRift` — a preset key from `MARS_SITE_PRESETS`.
 * - `?marssite=0,0` — any `lat,lon` pair in degrees. This one matters: the port's geology assigns
 *   material per *region*, so a 640 m window of most sites answers with a single dominant splat
 *   channel (the volcano summit bakes one colour for kilometres). The 0°N 0°E crater field is one of
 *   the few places where the dust/rock/sand/crust weights actually mix inside one window, which is
 *   what makes it the honest place to look at the four-layer material. `window.__forge
 *   .marsGeneratorState()` reports what is loaded.
 *
 * The four layers go to the GPU through `TerrainWorld { layeredMaterial }`: one `SplatMaterial` per
 * resident tile, a per-tile RGBA8 weight mask built from the stage's own splat, sharing the four
 * albedo/normal/metallic-roughness arrays this scene creates once. The repo ships no Stage A erosion
 * cache, so the surface is the port's analytic one (`hasErosionCorrection === false`) and the HUD
 * says so.
 */
import {
  AtmosphereModel,
  Camera,
  Color,
  type Engine,
  LayeredTerrainMaterial,
  Light,
  MARS_ATMOSPHERE,
  MARS_SITE_PRESETS,
  type MarsSitePreset,
  Scene,
  TerrainWorld,
  Vec3,
  adviseMarsTile,
  createAtmosphere,
  createMarsPipeline,
  marsSurfaceLayers,
} from "@forge/engine";
import { createMarsSurfaceTextures } from "../textures/procedural.js";
import type { DemoSceneHandle } from "./cubesScene.js";

/** Static facts about the ported stage this scene streams, for the HUD, `__forge` and the gate. */
export interface MarsGeneratorState {
  site: string;
  latDeg: number;
  lonDeg: number;
  detailLevel: string;
  vertexSpacing: number;
  chunkSize: number;
  skirtDepth: number;
  generation: "workers" | "inline";
  materialMode: "layered" | "single";
  readyChunks: number;
  splatTiles: number;
  layers: string[];
  stageSeed: number | null;
  hasErosionCorrection: boolean;
}

export interface MarsGeneratorSceneHandle extends DemoSceneHandle {
  marsGeneratorState: () => MarsGeneratorState;
}

export interface MarsGeneratorSceneOptions {
  /**
   * Key into `MARS_SITE_PRESETS` (`olympusMons`, `vallesRift`) or a `"lat,lon"` pair in degrees
   * (e.g. `"0,0"`); the volcano is the default.
   */
  site?: string;
}

/** Parse `"lat,lon"` (degrees) into a Mars site; null when the string is not a coordinate pair. */
export function parseMarsSiteParam(value: string): { latDeg: number; lonDeg: number } | null {
  const match = /^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/.exec(value.trim());
  if (!match) return null;
  const latDeg = Number(match[1]);
  const lonDeg = Number(match[2]);
  if (!Number.isFinite(latDeg) || !Number.isFinite(lonDeg)) return null;
  if (Math.abs(latDeg) > 90 || Math.abs(lonDeg) > 180) return null;
  return { latDeg, lonDeg };
}

/** The demo's tile sizing, chosen from `adviseMarsTile` (docs/MARS-TERRAIN.md §3). */
export const MARS_GENERATOR_TILE = { chunkSize: 128, resolution: 33 } as const;

/**
 * Scene-authored sRGB tints, the same four the Mars Showcase uses (ferric dust, dark basalt, pale
 * sand, weathered crust): the shared helper's colours are approximate albedos meant to be tweaked
 * per scene, and matching the showcase keeps one planet looking like one planet.
 */
const SURFACE_TINTS = [0xc9784f, 0x5c5046, 0xd1a06b, 0x9a6549] as const;

export function buildMarsGeneratorScene(
  engine: Engine | null,
  options: MarsGeneratorSceneOptions = {},
): MarsGeneratorSceneHandle {
  const scene = new Scene({ name: "mars-generator" });

  scene.settings.hdr = true;
  scene.settings.exposure = 0.95;
  scene.settings.toneMapping = "aces";
  scene.settings.bloom.enabled = true;
  scene.settings.bloom.threshold = 1.1;
  scene.settings.bloom.intensity = 0.04;

  // Mars sky and haze: the showcase's recipe (same atmosphere, same horizon-derived fog colour), at
  // low quality because this scene is about the terrain rather than the horizon's banding.
  const marsAtmosphere = createAtmosphere({}, MARS_ATMOSPHERE);
  scene.setSky({ atmosphere: marsAtmosphere, quality: "low", sunIntensity: 20 });
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

  // The ported surface at the advised demo sizing. `skirtDepth` is not the engine's flat-earth
  // default (8 m) but what `adviseMarsTile` asks for at this tile size: hundreds of metres of relief
  // need real skirts or neighbouring LODs show daylight between them.
  const tile = MARS_GENERATOR_TILE;
  const advice = adviseMarsTile(tile.chunkSize, tile.resolution);
  if (!advice.ok) {
    throw new Error(`Mars generator demo tiles are outside the advised band: ${advice.notes.join(" ")}`);
  }
  const requested = options.site ?? "olympusMons";
  const coordinates = parseMarsSiteParam(requested);
  const site: MarsSitePreset = coordinates
    ? {
        name: `lat ${coordinates.latDeg} lon ${coordinates.lonDeg}`,
        description: "arbitrary point on the ported planet",
        ...coordinates,
        headingDeg: 0,
      }
    : (MARS_SITE_PRESETS[requested] ?? MARS_SITE_PRESETS.olympusMons!);

  // One set of four-slice PBR arrays for the whole scene (borrowed by every tile material); a null
  // engine (unit tests) lets the helper generate its shared 1×1 fallback arrays instead.
  const maps = engine?.gpu ? createMarsSurfaceTextures(engine.gpu, 256) : undefined;
  const layeredMat = new LayeredTerrainMaterial({
    label: "mars-generator-layers",
    layers: marsSurfaceLayers().map((layer, i) => ({ ...layer, color: Color.fromSrgbHex(SURFACE_TINTS[i]!) })),
    maps,
  });
  // The horizon apron (and the reversible fallback) draws with the representative single material.
  const apronMat = layeredMat.toMaterial();

  // Streaming: the same budgets shape as the showcase — worker-backed generation (the stage
  // round-trips to a worker from its serialized configuration: no Stage A buffers are needed),
  // bounded uploads so a frame stays a frame, and a warm-up that fills the opening disc.
  const terrain = new TerrainWorld({
    seed: 1337,
    chunkSize: tile.chunkSize,
    chunkResolution: tile.resolution,
    viewDistance: 1024,
    maxLOD: 3,
    visibleChunks: 220,
    generationsPerFrame: 1,
    uploadsPerFrame: 2,
    warmUpChunks: 9,
    skirtDepth: advice.recommendedSkirtDepth,
    syncGeneration: false,
    pipeline: createMarsPipeline({ site }),
    material: apronMat,
    layeredMaterial: layeredMat,
  });
  scene.add(terrain);

  const stage = terrain.pipeline.stages[0] as { hasErosionCorrection?: boolean; seed?: number };
  const generation = (): "workers" | "inline" =>
    !terrain.syncGeneration && engine?.tasks && !engine.tasks.isInline ? "workers" : "inline";

  // Martian sun and dust fill, the same rig the Martian terrain demo and the showcase use.
  const sunEntity = scene.createTransformedEntity("sun", new Vec3(200, 300, 200));
  const sun = new Light();
  sun.kind = "directional";
  sun.intensity = 3.6;
  sun.castShadow = true;
  sun.setColor(1.0, 0.92, 0.8);
  sun.shadowBias = 0.001;
  scene.world.addComponent(sunEntity.id, sun);
  sunEntity.transform.lookAt(new Vec3(0, 0, 0));

  const ambientEntity = scene.createTransformedEntity("ambient-fill", new Vec3(-200, -300, -200));
  const ambient = new Light();
  ambient.kind = "directional";
  ambient.intensity = 0.55;
  ambient.castShadow = false;
  ambient.setColor(0.36, 0.2, 0.16);
  scene.world.addComponent(ambientEntity.id, ambient);
  ambientEntity.transform.lookAt(new Vec3(0, 0, 0));

  // Camera over the site. The orbit controller owns the eye from here on: it clamps both the eye and
  // the look-at to `groundClearance` above the *ported* surface (`terrain.getHeightAt`), the same
  // heightfield the meshes are built from.
  const groundY = terrain.getHeightAt(0, 0);
  const orbitTarget = new Vec3(0, groundY, 0);
  // Pin sky seaLevel to the surface under the look-at so the atmosphere's observer height tracks the
  // terrain the camera is actually over (a mismatch reads as a flat band under a phantom horizon).
  scene.settings.sky.seaLevel = groundY;
  const cameraEntity = scene.createTransformedEntity("camera", new Vec3(0, groundY + 25, 0));
  const camera = new Camera();
  camera.fovY = Math.PI / 3.2;
  camera.near = 2.0;
  camera.far = 2800; // past viewDistance (1 km) + fog; the sky still draws at z = 1
  scene.world.addComponent(cameraEntity.id, camera);

  const state = (): MarsGeneratorState => {
    const ready = [...terrain.chunks.values()].filter((chunk) => chunk.state === "ready" && chunk.tile);
    return {
      site: site.name,
      latDeg: site.latDeg,
      lonDeg: site.lonDeg,
      detailLevel: advice.detailLevel,
      vertexSpacing: advice.vertexSpacing,
      chunkSize: tile.chunkSize,
      skirtDepth: advice.recommendedSkirtDepth,
      generation: generation(),
      materialMode: terrain.layeredMaterialsEnabled ? "layered" : "single",
      readyChunks: ready.length,
      splatTiles: ready.filter((chunk) => chunk.tile?.gpuMaterial).length,
      layers: layeredMat.layers.map((layer) => layer.name),
      stageSeed: stage.seed ?? null,
      hasErosionCorrection: stage.hasErosionCorrection === true,
    };
  };

  return {
    scene,
    cameraEntity,
    camera: {
      target: orbitTarget,
      distance: 420,
      azimuth: 0.4,
      elevation: 0.34,
      minDistance: 6,
      maxDistance: 1100,
      groundClearance: 4,
      groundHeight: (x, z) => terrain.getHeightAt(x, z),
    },
    /** The port's own facts, shown in the HUD so the demo says what it is rendering. */
    overlay: () => {
      const s = state();
      return (
        `mars generator: ${s.site} (${s.latDeg}°, ${s.lonDeg}°) · seed ${s.stageSeed} · ` +
        `${s.chunkSize} m @ ${tile.resolution}^2 (${s.detailLevel} band, ${s.vertexSpacing.toFixed(1)} m spacing) · ` +
        `skirts ${s.skirtDepth} m · ${s.generation} · ${s.materialMode} (${s.splatTiles} splat tiles) · ` +
        `${s.hasErosionCorrection ? "erosion cache" : "analytic only (no erosion cache)"}`
      );
    },
    /** Inspector state (`?marssite=…`), exposed to the HUD, `window.__forge` and the browser gate. */
    marsGeneratorState: state,
    update: (_dt: number) => {
      scene.settings.sky.seaLevel = terrain.getHeightAt(orbitTarget.x, orbitTarget.z);
    },
    dispose: () => {
      // The terrain world disposes every per-tile mask/material; the helper releases only the
      // fallback arrays it created, and the shared texture arrays are ours to release.
      terrain.dispose();
      layeredMat.dispose();
      apronMat.dispose();
      maps?.albedo.dispose();
      maps?.normal.dispose();
      maps?.metallicRoughness.dispose();
    },
  };
}
