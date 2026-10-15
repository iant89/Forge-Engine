/**
 * fe-38 "thaw" demo: a sunny spring afternoon after a snowfall.
 *
 * Snow lies on spheres, a crate, a tilted slab, a rock and a parked car over a dirt-and-grass yard.
 * The engine's {@link SnowMeltSystem} melts each cover from the real sun (the DayNightCycle's light,
 * the WeatherSystem's air temperature), the wet packs slide off the curved and tilted surfaces as
 * clumps, and the meltwater runs into the yard's hollows ({@link GroundMoistureField}) where the dirt
 * turns to glossy mud that then dries. Everything is engine state; this file only places objects and
 * draws the chunks.
 *
 * Keys: `R` new snowfall, `T` cycle the time scale (1 s = 10 min / 1 min / real time), `P` pause.
 */

import {
  Camera,
  DayNightCycle,
  Engine,
  GroundMoistureField,
  Light,
  Material,
  MoistureGroundMaps,
  Quat,
  Renderable,
  Scene,
  SnowCover,
  Transform,
  SnowMeltSystem,
  Vec3,
  WeatherSystem,
  createBox,
  createMoistureGround,
  createPlane,
  createRock,
  createSphere,
  setWorldSurfaceGripField,
  type SoilName,
} from "@forge/engine";
import type { DemoSceneHandle } from "./cubesScene.js";

export interface ThawSceneHandle extends DemoSceneHandle {
  melt: SnowMeltSystem;
  field: GroundMoistureField;
  weather: WeatherSystem;
  /** Re-load every cover (and a light ground dusting): a fresh snowfall. */
  resetSnow(): void;
  /** Simulated seconds per real second for melt and drying. */
  setTimeScale(scale: number): void;
  /** Step the simulation deterministically (real seconds; melt scaled by the time scale). */
  advance(realSeconds: number): void;
  thawState(): Record<string, unknown>;
}

const TIME_SCALES = [600, 60, 1];
const FIELD_SIZE = 48;
const BED_Y = -0.8;
const CHUNK_POOL = 160;

/** Gentle yard with two hollows (where meltwater collects) and a low bank. */
export function thawHeightAt(x: number, z: number): number {
  // The last 4 m of the patch bank down into the surrounding meadow plane (at BED_Y).
  const edge = FIELD_SIZE / 2 - Math.max(Math.abs(x), Math.abs(z));
  const skirt = Math.min(1, Math.max(0, edge / 4));
  return BED_Y + (yardHeight(x, z) - BED_Y) * skirt * skirt * (3 - 2 * skirt);
}

function yardHeight(x: number, z: number): number {
  return (
    0.18 * Math.sin(x * 0.27) * Math.cos(z * 0.21) -
    0.45 * Math.exp(-((x - 3) ** 2 + (z + 3.5) ** 2) / 10) -
    0.35 * Math.exp(-((x + 6) ** 2 + (z - 4) ** 2) / 7) +
    0.6 * Math.exp(-((x + 2) ** 2 + (z + 14) ** 2) / 40)
  );
}

function thawSoilAt(x: number, z: number): SoilName {
  if (Math.hypot(x - 12, z + 8) < 3.5) return "rock";
  return Math.hypot(x, z) < 13 ? "dirt" : "grass";
}

export function buildThawScene(engine: Engine): ThawSceneHandle {
  const scene = new Scene({ name: "thaw" });
  scene.settings.hdr = true;
  scene.settings.exposure = 1;
  scene.settings.toneMapping = "aces";
  scene.settings.bloom.enabled = true;
  scene.settings.bloom.threshold = 1.2;
  scene.settings.bloom.intensity = 0.04;
  scene.settings.shadow.enabled = true;
  scene.settings.shadow.cascades = 3;
  scene.settings.shadow.distance = 80;
  scene.settings.shadow.mapSize = 2048;
  scene.setFog("exp2", { density: 0.002 });
  scene.setSky({ quality: "medium", sunDiscIntensity: 100 });
  scene.setClouds({ coverage: 0.15, density: 0.7, height: 1800, scale: 0.0008, surfaceShadows: false });

  const cameraEntity = scene.createTransformedEntity("camera", new Vec3(14, 9, 16));
  const camera = new Camera();
  camera.fovY = Math.PI / 3;
  camera.near = 0.1;
  camera.far = 2000;
  scene.world.addComponent(cameraEntity.id, camera);
  cameraEntity.transform.lookAt(new Vec3(0, 1, 0));

  const sunEntity = scene.createTransformedEntity("sun", new Vec3(0, 50, 0));
  const sun = new Light();
  sun.kind = "directional";
  sun.castShadow = true;
  sun.shadowNormalBias = 0.8;
  scene.world.addComponent(sunEntity.id, sun);
  // Early afternoon in late March at 47° N: a strong but not summer sun.
  const cycle = new DayNightCycle({ name: "dayNight", latitude: 47, dayOfYear: 85, timeOfDay: 13, timeScale: 0, sun, sunIntensity: 4.2, ambientScale: 0.6, driveAmbient: true, driveFog: true, driveSky: true });
  scene.add(cycle);
  const weather = new WeatherSystem({
    name: "weather",
    initial: { cloudCoverage: 0.15, storm01: 0, precipitation01: 0, temperatureC: 7, humidity01: 0.55, windSpeed: 2 },
    target: { cloudCoverage: 0.15, storm01: 0, precipitation01: 0, temperatureC: 7, humidity01: 0.55, windSpeed: 2 },
  });
  // The ground's look comes from the moisture field, not the scene-wide 17.4 surface state.
  weather.driveSurface = false;
  scene.add(weather);

  // Ground: the moisture field's patch, its mesh and its live maps.
  const field = new GroundMoistureField({ originX: -FIELD_SIZE / 2, originZ: -FIELD_SIZE / 2, size: FIELD_SIZE, resolution: 96, heightAt: thawHeightAt, soilAt: thawSoilAt });
  const groundMaps = new MoistureGroundMaps(engine.gpu, field, "thaw.ground");
  const groundGeometry = createMoistureGround(engine.gpu, field, thawHeightAt, 96);
  const meadowGeometry = createPlane(engine.gpu, { width: 1600, depth: 1600 });
  const meadowMaterial = new Material({ label: "thaw.meadow", color: 0xdfe3e8, roughness: 0.75 });
  {
    const e = scene.createTransformedEntity("ground", new Vec3());
    const r = new Renderable();
    r.geometry = groundGeometry;
    r.material = groundMaps.material;
    r.castShadow = false;
    scene.world.addComponent(e.id, r);
  }
  {
    const e = scene.createTransformedEntity("meadow", new Vec3(0, BED_Y - 0.01, 0));
    const r = new Renderable();
    r.geometry = meadowGeometry;
    r.material = meadowMaterial;
    r.castShadow = false;
    scene.world.addComponent(e.id, r);
  }
  setWorldSurfaceGripField(scene.world, (x, z) => field.gripAt(x, z));

  const melt = new SnowMeltSystem({ field, weather, timeScale: TIME_SCALES[0], seed: 3801 });
  scene.add(melt);

  const meshes = {
    sphere: createSphere(engine.gpu, { radius: 1.1, widthSegments: 48, heightSegments: 32 }),
    small: createSphere(engine.gpu, { radius: 0.7, widthSegments: 40, heightSegments: 24 }),
    crate: createBox(engine.gpu, { width: 2.4, height: 1.2, depth: 2.4 }),
    slab: createBox(engine.gpu, { width: 3, height: 0.3, depth: 2.4 }),
    rock: createRock(engine.gpu, { radius: 1.3, segments: 18, roughness: 0.18 }),
    body: createBox(engine.gpu, { width: 4.2, height: 0.9, depth: 1.9 }),
    cabin: createBox(engine.gpu, { width: 2.2, height: 0.7, depth: 1.7 }),
    chunk: createSphere(engine.gpu, { radius: 1, widthSegments: 10, heightSegments: 7 }),
  };
  const materials: Material[] = [];
  const covers: { cover: SnowCover; depth: number; extent: number }[] = [];
  const mat = (label: string, color: number, roughness: number, metallic = 0): Material => {
    const m = new Material({ label, color, roughness, metallic });
    materials.push(m);
    return m;
  };
  const add = (name: string, x: number, z: number, lift: number, geometry: keyof typeof meshes, material: Material, snow?: { shape: ConstructorParameters<typeof SnowCover>[0]["shape"]; depth: number; extentDeg?: number; substrateAlbedo?: number }, rotation?: Quat): void => {
    const e = scene.createTransformedEntity(name, new Vec3(x, thawHeightAt(x, z) + lift, z));
    if (rotation) scene.world.getComponent(e.id, Transform)!.setRotation(rotation);
    const r = new Renderable();
    r.geometry = meshes[geometry];
    r.material = material;
    scene.world.addComponent(e.id, r);
    if (snow) {
      const cover = new SnowCover({ shape: snow.shape, depth: snow.depth, extentDeg: snow.extentDeg, substrateAlbedo: snow.substrateAlbedo, target: material });
      scene.world.addComponent(e.id, cover);
      covers.push({ cover, depth: snow.depth, extent: snow.extentDeg ?? 70 });
    }
  };
  add("sphere-red", -3, 1, 1.1, "sphere", mat("thaw.red", 0xb3362b, 0.45), { shape: { kind: "sphere", radius: 1.1 }, depth: 0.08, substrateAlbedo: 0.15 });
  add("sphere-white", 0.5, 4, 1.1, "sphere", mat("thaw.pale", 0xd8d4c8, 0.5), { shape: { kind: "sphere", radius: 1.1 }, depth: 0.08, substrateAlbedo: 0.6 });
  add("sphere-blue", 4.5, 1.5, 0.7, "small", mat("thaw.blue", 0x2f5a8c, 0.4), { shape: { kind: "sphere", radius: 0.7 }, depth: 0.07, substrateAlbedo: 0.15 });
  add("sphere-dark", -6, -3, 0.7, "small", mat("thaw.dark", 0x2a2a2a, 0.6), { shape: { kind: "sphere", radius: 0.7 }, depth: 0.07, substrateAlbedo: 0.05 });
  add("crate", 2, -6, 0.6, "crate", mat("thaw.crate", 0x8a6a42, 0.8), { shape: { kind: "box", halfX: 1.2, halfZ: 1.2, topY: 0.6 }, depth: 0.1, substrateAlbedo: 0.3 });
  const tilt = new Quat().setAxisAngle(new Vec3(0, 0, 1), (28 * Math.PI) / 180);
  add("slab", -8, 6, 1.2, "slab", mat("thaw.slab", 0x7d7f84, 0.6, 0.3), { shape: { kind: "box", halfX: 1.5, halfZ: 1.2, topY: 0.15 }, depth: 0.09, substrateAlbedo: 0.4 }, tilt);
  add("rock", 9, -2, 0.6, "rock", mat("thaw.rock", 0x5d5a55, 0.85), { shape: { kind: "sphere", radius: 1.3 }, depth: 0.08, substrateAlbedo: 0.2 });
  const paint = mat("thaw.car", 0x1d3b2a, 0.3, 0.6);
  add("car-body", 7, 7, 0.75, "body", paint);
  add("car-cabin", 6.8, 7, 1.55, "cabin", mat("thaw.cabin", 0x1d3b2a, 0.3, 0.6), { shape: { kind: "box", halfX: 1.1, halfZ: 0.85, topY: 0.35 }, depth: 0.08, substrateAlbedo: 0.1 });

  // Chunk pool: one entity per live clump, scaled to its size.
  const chunkMaterial = new Material({ label: "thaw.chunk", color: 0xe8ebef, roughness: 0.7 });
  materials.push(chunkMaterial);
  const pool: { renderable: Renderable; transform: Transform }[] = [];
  for (let i = 0; i < CHUNK_POOL; i++) {
    const e = scene.createTransformedEntity(`chunk-${i}`, new Vec3(0, -50, 0));
    const r = new Renderable();
    r.geometry = meshes.chunk;
    r.material = chunkMaterial;
    r.visible = false;
    scene.world.addComponent(e.id, r);
    pool.push({ renderable: r, transform: scene.world.getComponent(e.id, Transform)! });
  }

  const dustGround = (): void => {
    // A light dusting on the yard (2 cm), deeper drifts on the grass rim.
    for (let k = 0; k < field.snow.length; k++) {
      const i = k % field.resolution;
      const j = (k - i) / field.resolution;
      const x = field.originX + (i + 0.5) * field.cell;
      const z = field.originZ + (j + 0.5) * field.cell;
      field.snow[k] = Math.hypot(x, z) < 13 ? 0.02 : 0.05;
      field.water[k] = 0;
      field.moisture[k] = 0.25;
    }
  };
  // The meadow beyond the patch follows the patch's own grass rim (snowy → green as it melts).
  const syncMeadow = (): void => {
    const rim = field.snowAt(field.originX + 1, field.originZ + 1);
    const cover = Math.min(1, Math.max(0, (rim - 0.005) / 0.035));
    meadowMaterial.baseColor.set(0.12 + (0.78 - 0.12) * cover, 0.17 + (0.8 - 0.17) * cover, 0.06 + (0.84 - 0.06) * cover, 1);
    meadowMaterial.markChanged();
  };
  const resetSnow = (): void => {
    for (const c of covers) c.cover.reload(c.depth, c.extent);
    melt.chunks.length = 0;
    dustGround();
    groundMaps.upload();
    syncMeadow();
  };
  resetSnow();

  let scaleIndex = 0;
  let paused = false;
  let uploadClock = 0;
  const setTimeScale = (scale: number): void => {
    melt.timeScale = scale;
  };
  const syncChunks = (): void => {
    for (let i = 0; i < pool.length; i++) {
      const slot = pool[i]!;
      const chunk = melt.chunks[i];
      if (!chunk) {
        if (slot.renderable.visible) slot.renderable.visible = false;
        continue;
      }
      slot.renderable.visible = true;
      slot.transform.setPosition(chunk.position.x, chunk.position.y, chunk.position.z);
      slot.transform.setScale(chunk.size, chunk.size * 0.75, chunk.size);
    }
  };
  const onKey = (event: KeyboardEvent): void => {
    if (event.key === "r" || event.key === "R") resetSnow();
    else if (event.key === "t" || event.key === "T") {
      scaleIndex = (scaleIndex + 1) % TIME_SCALES.length;
      setTimeScale(TIME_SCALES[scaleIndex]!);
    } else if (event.key === "p" || event.key === "P") {
      paused = !paused;
      melt.enabled = !paused;
    }
  };
  window.addEventListener("keydown", onKey);

  const thawState = (): Record<string, unknown> => ({
    timeScale: melt.timeScale,
    simulatedSeconds: melt.simulatedSeconds,
    covers: covers.map((c) => ({ depth: c.cover.depth, wetness: c.cover.wetness, extentDeg: (c.cover.extent * 180) / Math.PI, shed: c.cover.shedVolume, sheetSlid: c.cover.sheetSlid, cornice: c.cover.corniceDropped })),
    chunks: melt.chunks.length,
    shedEvents: melt.shedEvents,
    released: melt.chunksReleased,
    landed: melt.chunksLanded,
    groundSnow: field.totalSnow(),
    groundWater: field.totalWater(),
    meanMud: field.meanMud(),
    hollowWater: field.waterAt(3, -3.5),
    hollowMud: field.mudAt(3, -3.5),
    hollowGrip: field.gripAt(3, -3.5),
    env: { ...melt.environment, sunDirection: { ...melt.environment.sunDirection } },
  });

  return {
    scene,
    cameraEntity,
    melt,
    field,
    weather,
    resetSnow,
    setTimeScale,
    advance(realSeconds: number): void {
      melt.advance(realSeconds);
      syncChunks();
      groundMaps.upload();
      syncMeadow();
    },
    thawState,
    controlsHint: "Drag to orbit · R new snowfall · T time scale (10 min/s, 1 min/s, real) · P pause",
    camera: { target: new Vec3(0, 1, 0), distance: 24, minDistance: 3, maxDistance: 120, azimuth: 0.75, elevation: 0.38, minElevation: 0.02, groundClearance: 0.5, groundHeight: (x: number, z: number) => thawHeightAt(x, z) },
    update(dt: number): void {
      syncChunks();
      uploadClock += dt;
      if (uploadClock >= 0.2) {
        uploadClock = 0;
        groundMaps.upload();
        syncMeadow();
      }
    },
    overlay(): string {
      const e = melt.environment;
      const s = covers.map((c) => `${(c.cover.depth * 100).toFixed(1)}`).join(" ");
      return (
        `thaw x${melt.timeScale}  t+${(melt.simulatedSeconds / 3600).toFixed(2)} h  sun ${e.sunIrradiance.toFixed(0)} W/m²  air ${e.airTemperatureC.toFixed(1)}°C\n` +
        `snow cm [${s}]  chunks ${melt.chunks.length} (shed ${melt.shedEvents})  ground snow ${field.totalSnow().toFixed(2)} m³  water ${field.totalWater().toFixed(3)} m³  mud ${(field.meanMud() * 100).toFixed(0)} %`
      );
    },
    dispose(): void {
      window.removeEventListener("keydown", onKey);
      setWorldSurfaceGripField(scene.world, undefined);
      groundMaps.dispose();
      groundGeometry.dispose();
      meadowGeometry.dispose();
      meadowMaterial.dispose();
      for (const m of Object.values(meshes)) m.dispose();
      for (const m of materials) m.dispose();
      scene.dispose();
    },
  };
}
