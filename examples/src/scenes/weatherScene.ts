/**
 * Phase 8b: weather, clouds, water and lightning. A lake under a procedural cloud deck, driven by
 * a `WeatherSystem` (fog, turbidity and cloud cover follow the state), a `WaterSurface` lake with
 * Gerstner swells, and a `LightningSystem` that flashes the sky on stormy days. A `DayNightCycle`
 * runs the sun so the deck and the water track noon → dusk.
 *
 * Controls: the buttons along the bottom of the page are the interface, shown on every device —
 * the panel in `examples/index.html` is bound by `controls/weatherTouch.ts` to the scene's actions
 * (presets, a strike, the flooded camera, the clock, pause). The keys stay as shortcuts on those
 * very same callbacks: `1..4` snap clear/overcast/rain/storm, `L` calls a strike, `U` raises the
 * lake over the camera (the underwater path), `[` / `]` scrub the clock, `T` pauses it. The
 * `window.__forge` hooks (`setWeather`, `triggerLightning`, `setUnderwater`, `weatherState`) do the
 * same for the gate.
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
  ParticleWorld,
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
import { attachWeatherTouch } from "../controls/weatherTouch.js";
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
  /** Alive rain-streak particles (the browser gate asserts rain is actually visible). */
  rainDrops(): number;
}

const PRESETS: WeatherPresetName[] = ["clear", "overcast", "rain", "storm"];

/** 1 real second = 1 simulated minute, and the rate `T` restores when the clock resumes. */
const TIME_SCALE = 60;

/** Rain streaks: capacity and the drops/s a full `precipitation01` asks for. */
const RAIN_SPRITES = 2400;
const RAIN_RATE = 1600;

/**
 * Camera-following rain. A `ParticleWorld` of thin unlit streaks whose emitter rides ~16 m above
 * the camera each frame: rate follows `weather.state.precipitation01` (0 when clear or while the
 * lake floods the camera), the spawn cone slants down `weather.meanWind()`, and drops fall at
 * terminal velocity with no gravity term — the streak is the motion, not an acceleration curve.
 */
class RainField extends ParticleWorld {
  constructor(
    private readonly weather: WeatherSystem,
    private readonly isUnderwater: () => boolean,
  ) {
    super({ name: "rain", capacity: RAIN_SPRITES, gravity: { x: 0, y: 0, z: 0 }, drag: 0, seed: 41 });
    const emitter = this.simulation.emitter;
    emitter.rate = 0;
    emitter.lifeMin = 1.5;
    emitter.lifeMax = 2.3;
    emitter.size = 1;
    // 56×8×56 m slab of air over the lake, y 12–20: drops fall ~11 m/s × ~1.9 s ≈ 21 m, so they
    // die right at the surface — in frame from every orbit angle (a camera-centered spawn put
    // the volume above/behind the frustum; instances stayed at scene-object count).
    emitter.jitter = { x: 56, y: 8, z: 56 };
    emitter.cone = { direction: { x: 0, y: -1, z: 0 }, angle: 0.05, speedMin: 9, speedMax: 13 };
    emitter.color = { r: 1, g: 1, b: 1, a: 1 };
  }

  override update(context: Parameters<NonNullable<ParticleWorld["update"]>>[0], dt: number): void {
    const emitter = this.simulation.emitter;
    // The spawn volume is fixed over the lake (the orbit always looks at it); each particle is
    // jittered inside it by the emitter, so a whole batch born in one slow frame still fills
    // the slab instead of clumping at a single point.
    emitter.position.x = 0;
    emitter.position.y = 16;
    emitter.position.z = 0;
    const precipitation = this.weather.state.precipitation01;
    emitter.rate = this.isUnderwater() ? 0 : precipitation * RAIN_RATE;
    // Horizontal wind (m/s) against the ~11 m/s fall: unit cone direction, speedMin/Max on top.
    const wind = this.weather.meanWind();
    const len = Math.hypot(wind.x, 11, wind.y) || 1;
    emitter.cone.direction.x = wind.x / len;
    emitter.cone.direction.y = -11 / len;
    emitter.cone.direction.z = wind.y / len;
    super.update(context, dt);
  }
}

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
    timeScale: TIME_SCALE,
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

  // Rain: thin unlit streaks posed by the ParticleWorld only (no ParticleSystem on this scene).
  // The RainField SceneObject drives rate/wind/spawn from the live weather each frame, including
  // while the browser gate has the demo's own rAF frozen — the engine loop still steps it.
  const isUnderwater = (): boolean => scene.settings.water.level >= 1;
  const rain = new RainField(weather, isUnderwater);
  scene.add(rain);
  const rainMesh = createBox(engine.gpu, { width: 0.058, height: 0.6, depth: 0.058 });
  const rainMaterial = Material.unlit({
    label: "weather.rain-streak",
    // Slate, not white: the storm fog reads bright, so the streaks have to sit *under* it in
    // luminance to stay visible (pale blue-white vanished into the haze).
    color: 0x5c7186,
    opacity: 0.9,
    transparent: true,
  });
  const rainIds: number[] = [];
  for (let i = 0; i < RAIN_SPRITES; i++) {
    const drop = scene.createTransformedEntity(`rain-${i}`, new Vec3(0, -500, 0));
    const streak = new Renderable();
    streak.geometry = rainMesh;
    streak.material = rainMaterial;
    streak.castShadow = false;
    streak.receiveShadow = false;
    streak.visible = false;
    scene.world.addComponent(drop.id, streak);
    rainIds.push(drop.id);
  }
  rain.spriteEntities = rainIds;

  // One action per shortcut, shared by the on-screen panel (the interface) and the keys (kept as
  // shortcuts). `preset` tracks the last requested one (the weather itself only knows where it is
  // drifting), so the panel can mark the pressed button without waiting for the drift to arrive.
  let preset: WeatherPresetName = "overcast";
  const setWeather = (name: WeatherPresetName): void => {
    preset = name;
    weather.driveClouds = true;
    weather.snapTo(name);
    weather.setTarget(name);
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
  const toggleUnderwater = (): boolean => {
    setUnderwater(!isUnderwater());
    return isUnderwater();
  };
  const scrubHours = (hours: number): void => {
    cycle.setTime(cycle.timeOfDay + hours).apply();
  };
  const togglePause = (): boolean => {
    cycle.timeScale = cycle.timeScale === 0 ? TIME_SCALE : 0;
    return cycle.timeScale === 0;
  };

  const panelState = (): { preset: WeatherPresetName; underwater: boolean; paused: boolean } => ({
    preset,
    underwater: isUnderwater(),
    paused: cycle.timeScale === 0,
  });

  const onKey = (event: KeyboardEvent): void => {
    if (event.key >= "1" && event.key <= "4") setWeather(PRESETS[Number(event.key) - 1]!);
    else if (event.key === "l" || event.key === "L") lightning.trigger();
    else if (event.key === "u" || event.key === "U") setUnderwater(!isUnderwater());
    else if (event.key === "[") scrubHours(-1);
    else if (event.key === "]") scrubHours(1);
    else if (event.key === "t" || event.key === "T") togglePause();
  };
  window.addEventListener("keydown", onKey);

  // The panel is the interface for this scene on every device (CSS shows it whenever the scene is
  // up, see examples/index.html); the keys above are shortcuts onto these same callbacks.
  const touch = attachWeatherTouch(document.getElementById("weather-touch"), {
    setWeather,
    triggerLightning: () => lightning.trigger(),
    toggleUnderwater,
    scrubHours,
    togglePause,
    currentState: panelState,
  });

  return {
    scene,
    cameraEntity,
    weather,
    water,
    lightning,
    cycle,
    controlsHint: "Drag to orbit · Scroll to zoom · Use the on-screen weather buttons",
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
      // Weather, water, lightning and the cycle all step from the engine's fixed clock. The touch
      // panel is only painted — the keyboard and `window.__forge` change the same state without
      // going through it — and a frame whose state did not move writes nothing.
      touch.sync(panelState());
    },
    overlay(): string {
      const s = weather.state;
      const c = scene.settings.clouds;
      return (
        `${cycle.clockText}  wind ${s.windSpeed.toFixed(1)} m/s ${(s.windDirection / Math.PI) * 180 < 180 ? "E" : "W"}  ` +
        `T ${s.temperatureC.toFixed(1)}°C  rain ${s.precipitation01.toFixed(2)}  drops ${rain.simulation.alive}  storm ${s.storm01.toFixed(2)}\n` +
        `cover ${c.coverage.toFixed(2)}  deck wind (${c.windX.toFixed(1)}, ${c.windZ.toFixed(1)})  ` +
        `lake t+${scene.settings.water.time.toFixed(1)}s  strikes ${lightning.strikeCount}  flash ${lightning.flashTotal.toFixed(2)}`
      );
    },
    rainDrops: () => rain.simulation.alive,
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
      touch.dispose();
      for (const m of Object.values(meshes)) m.dispose();
      for (const m of Object.values(materials)) m.dispose();
      rainMesh.dispose();
      rainMaterial.dispose();
      scene.dispose();
    },
  };
}
