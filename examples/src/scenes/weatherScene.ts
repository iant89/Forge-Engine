/**
 * Phase 8b: weather, clouds, water and lightning. A lake under a procedural cloud deck, driven by
 * a `WeatherSystem` (fog, turbidity and cloud cover follow the state), a `WaterSurface` lake with
 * Gerstner swells, and a `LightningSystem` that flashes the sky on stormy days. A `DayNightCycle`
 * runs the sun so the deck and the water track noon → dusk.
 *
 * Keys: `1..4` snap clear/overcast/rain/storm, `L` calls a strike, `U` raises the lake over the
 * camera (the underwater path), `[` / `]` scrub the clock, `T` pauses it. The `window.__forge`
 * hooks (`setWeather`, `triggerLightning`, `setUnderwater`, `weatherState`) do the same for the gate.
 */

import {
  AABB,
  Camera,
  DayNightCycle,
  type Engine,
  Geometry,
  Light,
  LightningSystem,
  Material,
  Renderable,
  Scene,
  Vec3,
  WaterSurface,
  WeatherSystem,
  type WeatherPresetName,
  createBox,
  createCylinder,
  createPlane,
  createSphere,
  waterGridSource,
} from "@forge/engine";
import type { DemoSceneHandle } from "./cubesScene.js";

export interface WeatherSceneHandle extends DemoSceneHandle {
  weather: WeatherSystem;
  water: WaterSurface;
  lightning: LightningSystem;
  cycle: DayNightCycle;
  setWeather(preset: WeatherPresetName): void;
  /** Pin the deck coverage (pauses the weather's cover drive; `setWeather` resumes it). */
  setCoverage(coverage: number): void;
  triggerLightning(): void;
  setUnderwater(on: boolean): void;
  setTimeOfDay(hours: number): void;
}

const PRESETS: WeatherPresetName[] = ["clear", "overcast", "rain", "storm"];

export function buildWeatherScene(engine: Engine): WeatherSceneHandle {
  const scene = new Scene({ name: "weather" });
  scene.settings.hdr = true;
  scene.settings.exposure = 1;
  scene.settings.toneMapping = "aces";
  scene.settings.bloom.enabled = true;
  scene.settings.bloom.threshold = 1;
  scene.settings.bloom.intensity = 0.05;
  scene.settings.shadow.enabled = true;
  scene.settings.shadow.cascades = 3;
  scene.settings.shadow.distance = 120;
  scene.settings.shadow.mapSize = 2048;
  scene.setFog("exp2", { density: 0.0016 });
  scene.setSky({ quality: "medium", sunDiscIntensity: 120 });
  scene.setClouds({ coverage: 0.8, density: 0.9, height: 1500, scale: 0.0008, silverLining: 0.8 });

  const meshes = {
    ground: createPlane(engine.gpu, { width: 2000, depth: 2000 }),
    sphere: createSphere(engine.gpu, { radius: 1.1, widthSegments: 40, heightSegments: 24 }),
    mast: createCylinder(engine.gpu, { radiusTop: 0.18, radiusBottom: 0.3, height: 14, radialSegments: 16 }),
    slab: createBox(engine.gpu, { width: 4, height: 0.5, depth: 4 }),
    cube: createBox(engine.gpu, { width: 1.6, height: 1.6, depth: 1.6 }),
  };
  const materials = {
    ground: new Material({ label: "weather.ground", color: 0x5a6b52, roughness: 0.95, metallic: 0 }),
    stone: new Material({ label: "weather.stone", color: 0xb9b2a4, roughness: 0.7, metallic: 0 }),
    white: new Material({ label: "weather.white", color: 0xf2f2f0, roughness: 0.35, metallic: 0 }),
    signal: new Material({ label: "weather.signal", color: 0xc23a2e, roughness: 0.45, metallic: 0 }),
  };

  const place = (name: string, position: Vec3, geometry: keyof typeof meshes, material: keyof typeof materials, castShadow = true): void => {
    const e = scene.createTransformedEntity(name, position);
    const r = new Renderable();
    r.geometry = meshes[geometry];
    r.material = materials[material];
    r.castShadow = castShadow;
    scene.world.addComponent(e.id, r);
  };

  // The shore sits 2 m above the lake: the slab plaza and the masts stay dry while the water
  // fills the basin around them.
  place("ground", new Vec3(0, 2, 0), "ground", "ground", false);
  place("slab", new Vec3(0, 2.25, 0), "slab", "stone", false);
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    place(`mast-${i}`, new Vec3(Math.cos(a) * 12, 9, Math.sin(a) * 12), "mast", "signal");
  }
  const ring = ["white", "signal", "white", "signal", "white", "signal"] as const;
  for (let i = 0; i < ring.length; i++) {
    const a = (i / ring.length) * Math.PI * 2;
    place(`buoy-${i}`, new Vec3(Math.cos(a) * 7, 2.6, Math.sin(a) * 7), "sphere", ring[i]);
  }

  const cameraEntity = scene.createTransformedEntity("camera", new Vec3(16, 8, -20));
  const camera = new Camera();
  camera.fovY = Math.PI / 3;
  camera.near = 0.1;
  camera.far = 2000;
  scene.world.addComponent(cameraEntity.id, camera);
  cameraEntity.transform.lookAt(new Vec3(0, 4, 0));

  const sunEntity = scene.createTransformedEntity("sun", new Vec3(0, 50, 0));
  const sun = new Light();
  sun.kind = "directional";
  sun.castShadow = true;
  sun.shadowNormalBias = 0.8;
  scene.world.addComponent(sunEntity.id, sun);

  const cycle = new DayNightCycle({
    name: "dayNight",
    latitude: 47,
    dayOfYear: 172,
    timeOfDay: 11,
    timeScale: 60,
    sun,
    sunIntensity: 4.2,
    ambientScale: 0.6,
    driveAmbient: true,
    driveFog: true,
    driveSky: true,
  });
  scene.add(cycle);

  const weather = new WeatherSystem({ name: "weather", seed: 20260621, initial: "overcast", target: "overcast" });
  scene.add(weather);

  // The lake: a static grid the water program displaces. The geometry + material belong to the
  // surface's renderable, so `scene.dispose()` (via `WaterSurface.onDetach`) frees them — the
  // handle's dispose() below must not touch them twice.
  const water = new WaterSurface({ name: "water", level: 0, size: 1200 });
  scene.add(water);
  const grid = waterGridSource(1200, 96, 1);
  water.renderable!.geometry = Geometry.create(engine.gpu, {
    positions: grid.positions,
    normals: grid.normals,
    uvs: grid.uvs,
    indices: grid.indices,
    bounds: new AABB(new Vec3(grid.boundsMin[0], grid.boundsMin[1], grid.boundsMin[2]), new Vec3(grid.boundsMax[0], grid.boundsMax[1], grid.boundsMax[2])),
    label: "weather.lake",
  });
  water.renderable!.material = new Material({ label: "weather.lake", technique: "water" });

  const lightning = new LightningSystem({ name: "lightning", weatherName: "weather", rate: 0.5, areaRadius: 300, cloudHeight: 1200 });
  scene.add(lightning);

  const setWeather = (preset: WeatherPresetName): void => {
    weather.driveClouds = true;
    weather.snapTo(preset);
    weather.setTarget(preset);
  };
  const setCoverage = (coverage: number): void => {
    // The weather would overwrite the coverage on its next update; hold the drive while pinned.
    weather.driveClouds = false;
    scene.setClouds({ coverage });
  };
  const setUnderwater = (on: boolean): void => {
    // Flood the camera instead of moving it: the orbit controller owns the eye, but the sea
    // level is ours. 30 m submerges the 8 m camera with margin for the swell.
    scene.setWater({ level: on ? 30 : 0 });
  };

  const onKey = (event: KeyboardEvent): void => {
    if (event.key >= "1" && event.key <= "4") setWeather(PRESETS[Number(event.key) - 1]!);
    else if (event.key === "l" || event.key === "L") lightning.trigger();
    else if (event.key === "u" || event.key === "U") setUnderwater(scene.settings.water.level < 1);
    else if (event.key === "[") cycle.setTime(cycle.timeOfDay - 1).apply();
    else if (event.key === "]") cycle.setTime(cycle.timeOfDay + 1).apply();
    else if (event.key === "t" || event.key === "T") cycle.timeScale = cycle.timeScale === 0 ? 60 : 0;
  };
  window.addEventListener("keydown", onKey);

  return {
    scene,
    cameraEntity,
    weather,
    water,
    lightning,
    cycle,
    controlsHint: "Drag to orbit · Scroll to zoom · 1-4 weather · L lightning · U dive · [ ] time · T pause",
    camera: {
      target: new Vec3(0, 4, 0),
      distance: 28,
      minDistance: 4,
      maxDistance: 200,
      azimuth: 2.5,
      elevation: 0.22,
      minElevation: -0.05,
      groundClearance: 0.6,
      groundHeight: () => 2,
    },
    update(): void {
      // Weather, water, lightning and the cycle all step from the engine's fixed clock.
    },
    overlay(): string {
      const s = weather.state;
      const c = scene.settings.clouds;
      return (
        `${cycle.clockText}  wind ${s.windSpeed.toFixed(1)} m/s ${(s.windDirection / Math.PI) * 180 < 180 ? "E" : "W"}  ` +
        `T ${s.temperatureC.toFixed(1)}°C  rain ${s.precipitation01.toFixed(2)}  storm ${s.storm01.toFixed(2)}\n` +
        `cover ${c.coverage.toFixed(2)}  deck wind (${c.windX.toFixed(1)}, ${c.windZ.toFixed(1)})  ` +
        `lake t+${scene.settings.water.time.toFixed(1)}s  strikes ${lightning.strikeCount}  flash ${lightning.flashTotal.toFixed(2)}`
      );
    },
    setWeather,
    setCoverage,
    triggerLightning(): void {
      lightning.trigger();
    },
    setUnderwater,
    setTimeOfDay(hours: number): void {
      cycle.setTime(hours).apply();
    },
    dispose(): void {
      window.removeEventListener("keydown", onKey);
      for (const m of Object.values(meshes)) m.dispose();
      for (const m of Object.values(materials)) m.dispose();
      scene.dispose();
    },
  };
}
