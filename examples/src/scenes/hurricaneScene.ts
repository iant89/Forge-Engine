/**
 * Hurricane landfall (fe-33, `?scene=hurricane`): a beach at ground level watching a hurricane
 * form offshore, intensify to Category 5 and come ashore over the viewer — eyewall, calm eye with
 * open sky overhead, back eyewall — in about two minutes.
 *
 * This file is scripting only: the storm track lives in `hurricane.ts`, and every simulated or
 * generated system is the engine's — `CycloneSystem` (wind/rain/cloud field, sea state, surge,
 * light), the ocean (`WaterSurface` + `oceanGridSource` + the shore settings), `coastalHeightAt` /
 * `coastalTerrainSource` (beach + dunes), the demo's own palms (`hurricanePalms.ts`, posed by the engine's `windSway` hook) and `PrecipitationField` (rain).
 * The scene wires them together, owns the camera and draws the HUD (category, wind, phase and a
 * replay button). `?tier=low|medium|high` forces the device tier.
 */

import {
  AABB,
  Camera,
  CycloneSystem,
  DayNightCycle,
  type DeviceTier,
  type Engine,
  Geometry,
  Light,
  Material,
  PrecipitationField,
  Renderable,
  Scene,
  Vec3,
  WaterSurface,
  coastalHeightAt,
  coastalShoreSettings,
  coastalTerrainSource,
  cycloneWindAt,
  oceanGridSource,
  oceanQualityForTier,
  saffirSimpsonLabel,
  tierValue,
} from "@forge/engine";
import type { DemoSceneHandle } from "./cubesScene.js";
import { PalmGrove, palmSites } from "./hurricanePalms.js";
import {
  HURRICANE_BEATS,
  HURRICANE_COAST,
  HURRICANE_OBSERVER,
  HURRICANE_TIME_COMPRESSION,
  createHurricaneTrack,
  hurricaneLandfallTime,
  windUnits,
} from "./hurricane.js";

export interface HurricaneSceneOptions {
  deviceTier?: DeviceTier;
}

export interface HurricaneState {
  time: number;
  duration: number;
  phase: string;
  category: number;
  label: string;
  maxWind: number;
  localWind: number;
  rain: number;
  cover: number;
  distanceKm: number;
  waveHeight: number;
  surge: number;
  palmBend: number;
  landfall: boolean;
  finished: boolean;
  tier: DeviceTier;
}

export interface HurricaneSceneHandle extends DemoSceneHandle {
  hurricaneState(): HurricaneState;
  /** Jump the storm clock (seconds) — screenshots / browser checks. */
  seek(time: number): void;
  replay(): void;
  setPaused(paused: boolean): void;
}

const PHASE_TEXT: Record<string, string> = {
  clear: "Offshore — calm before the storm",
  "outer-bands": "Outer bands arriving",
  rainbands: "Spiral rainbands",
  eyewall: "EYEWALL",
  eye: "In the eye — calm, clear sky above",
};

export function buildHurricaneScene(engine: Engine, options: HurricaneSceneOptions = {}): HurricaneSceneHandle {
  const tier: DeviceTier = options.deviceTier ?? "high";
  const quality = oceanQualityForTier(tier);
  const scene = new Scene({ name: "hurricane" });
  scene.settings.hdr = true;
  scene.settings.exposure = 1;
  scene.settings.toneMapping = "aces";
  scene.settings.bloom.enabled = tier !== "low";
  scene.settings.bloom.threshold = 1;
  scene.settings.bloom.intensity = 0.04;
  scene.settings.shadow.enabled = true;
  scene.settings.shadow.cascades = tierValue(tier, { low: 2, medium: 3, high: 3 });
  scene.settings.shadow.distance = 140;
  scene.settings.shadow.mapSize = tierValue(tier, { low: 1024, medium: 2048, high: 2048 });
  scene.setFog("exp2", { density: 0.0006 });
  scene.setSky({ quality: tier === "low" ? "low" : "medium", sunDiscIntensity: 120 });
  scene.setClouds({ coverage: 0.3, density: 0.7, height: 1400, scale: 0.0007, silverLining: 0.8, layers: tierValue(tier, { low: 1, medium: 2, high: 3 }) });

  const owned: { dispose(): void }[] = [];
  const sand = new Material({ label: "hurricane.sand", color: 0xd9c49b, roughness: 0.95, metallic: 0 });
  owned.push(sand);
  const addMesh = (name: string, src: ReturnType<typeof coastalTerrainSource>, yOffset = 0): void => {
    if (yOffset !== 0) for (let i = 1; i < src.positions.length; i += 3) src.positions[i] = src.positions[i]! + yOffset;
    const geometry = Geometry.create(engine.gpu, {
      positions: src.positions,
      normals: src.normals,
      uvs: src.uvs,
      indices: src.indices,
      bounds: new AABB(new Vec3(src.boundsMin[0], src.boundsMin[1] + yOffset, src.boundsMin[2]), new Vec3(src.boundsMax[0], src.boundsMax[1] + yOffset, src.boundsMax[2])),
      label: `hurricane.${name}`,
    });
    owned.push(geometry);
    const e = scene.createTransformedEntity(name, new Vec3(0, 0, 0));
    const r = new Renderable();
    r.geometry = geometry;
    r.material = sand;
    r.castShadow = false;
    scene.world.addComponent(e.id, r);
  };
  // Dense near patch around the viewer, coarse far patch tucked 0.3 m under it.
  const near = tierValue(tier, { low: 2.5, medium: 2, high: 1.5 });
  addMesh("beach-near", coastalTerrainSource(HURRICANE_COAST, 0, -40, 360, 240, Math.round(360 / near), Math.round(240 / near)));
  addMesh("beach-far", coastalTerrainSource(HURRICANE_COAST, 0, -300, 2400, 1400, tierValue(tier, { low: 120, medium: 160, high: 220 }), tierValue(tier, { low: 70, medium: 90, high: 120 })), -0.3);

  // The ocean: shore settings come from the same coast parameters as the sand.
  const water = new WaterSurface({ name: "ocean", level: 0, size: 3000 });
  scene.add(water);
  scene.setWater({ shore: coastalShoreSettings(HURRICANE_COAST, { foamDepth: 0.7, breakDepth: 2.2, colorDepth: 9 }) });
  scene.settings.water.deepColor.set(0.012, 0.075, 0.1);
  scene.settings.water.shallowColor.set(0.08, 0.3, 0.28);
  scene.settings.water.opacity = 0.95;
  const grid = oceanGridSource(3000, quality.gridSegments, 4, 0, 60, 2.4);
  water.renderable!.geometry = Geometry.create(engine.gpu, {
    positions: grid.positions,
    normals: grid.normals,
    uvs: grid.uvs,
    indices: grid.indices,
    bounds: new AABB(new Vec3(grid.boundsMin[0], grid.boundsMin[1], grid.boundsMin[2]), new Vec3(grid.boundsMax[0], grid.boundsMax[1], grid.boundsMax[2])),
    label: "hurricane.ocean",
  });
  water.renderable!.material = new Material({ label: "hurricane.ocean", technique: "water" });

  // Camera: standing on the berm, looking out to sea.
  const groundHeight = (x: number, z: number): number => coastalHeightAt(HURRICANE_COAST, x, z);
  const cameraEntity = scene.createTransformedEntity("camera", new Vec3(0, 4, HURRICANE_OBSERVER.z));
  const camera = new Camera();
  camera.fovY = Math.PI / 3;
  camera.near = 0.1;
  camera.far = 6000;
  scene.world.addComponent(cameraEntity.id, camera);

  const sunEntity = scene.createTransformedEntity("sun", new Vec3(0, 50, 0));
  const sun = new Light();
  sun.kind = "directional";
  sun.castShadow = true;
  sun.shadowNormalBias = 0.8;
  scene.world.addComponent(sunEntity.id, sun);
  const SUN_INTENSITY = 4.2;
  const AMBIENT = 0.6;
  const cycle = new DayNightCycle({
    name: "dayNight",
    latitude: 26,
    dayOfYear: 245,
    timeOfDay: 15.5,
    timeScale: 0,
    sun,
    sunIntensity: SUN_INTENSITY,
    ambientScale: AMBIENT,
    driveAmbient: true,
    driveFog: false,
    driveSky: true,
  });
  scene.add(cycle);

  // The storm (engine): scripted track, evaluated at the viewer.
  const track = createHurricaneTrack();
  const landfallTime = hurricaneLandfallTime(track);
  const fieldOptions = { timeCompression: HURRICANE_TIME_COMPRESSION, hemisphere: 1 };
  const cyclone = new CycloneSystem({
    name: "hurricane",
    track,
    observer: () => HURRICANE_OBSERVER,
    ...fieldOptions,
    maxWaveHeight: tierValue(tier, { low: 4, medium: 4.5, high: 5 }),
    waveCount: quality.waveCount,
    fogClear: 0.0005,
    // v2: thinner storm fog so the swell field reads out to ~0.5 km from the beach.
    fogStorm: 0.0045,
    eyeHole: { scale: 0.5 },
    stormCloudAlbedo: 0.05,
    seaLevel: 0,
  });
  scene.add(cyclone);

  // Palms on the back beach, swaying in the storm's own wind field.
  const windScratch = { x: 0, z: 0, speed: 0 };
  const sites = palmSites(HURRICANE_COAST, tierValue(tier, { low: 10, medium: 16, high: 22 }), 220, 14, 46, 9);
  const palms = new PalmGrove({
    name: "palms",
    gpu: engine.gpu,
    sites,
    trunkSegments: tierValue(tier, { low: 4, medium: 5, high: 6 }),
    fronds: tierValue(tier, { low: 7, medium: 8, high: 10 }),
    wind: (x, z, out) => {
      cycloneWindAt(cyclone.state, x, z, fieldOptions, windScratch);
      out.x = windScratch.x;
      out.z = windScratch.z;
    },
  });
  scene.add(palms);

  // Rain (engine): intensity and slant from the storm at the viewer.
  const rain = new PrecipitationField({
    name: "rain",
    capacity: tierValue(tier, { low: 4096, medium: 8192, high: 12288 }),
    maxRate: tierValue(tier, { low: 2500, medium: 4200, high: 6300 }),
    follow: () => cameraEntity.transform.position,
    drive: () => ({ intensity: cyclone.observed.rain, windX: cyclone.observed.wind.x, windZ: cyclone.observed.wind.z }),
    seed: 33,
  });
  scene.add(rain);

  // ---------------------------------------------------------------- HUD
  const hud = document.createElement("div");
  hud.id = "hurricane-hud";
  hud.style.cssText =
    "position:fixed;top:64px;right:12px;z-index:20;min-width:230px;padding:10px 14px;border-radius:10px;" +
    "background:rgba(10,16,24,0.72);color:#eef4f8;font:13px/1.35 system-ui,sans-serif;pointer-events:auto;";
  hud.innerHTML =
    '<div data-k="label" style="font-weight:700;font-size:17px"></div>' +
    '<div data-k="wind"></div><div data-k="local"></div><div data-k="phase" style="margin-top:4px;font-weight:600"></div>' +
    '<div style="margin-top:6px;height:4px;background:rgba(255,255,255,0.18);border-radius:2px"><div data-k="bar" style="height:4px;width:0;background:#ffb347;border-radius:2px"></div></div>' +
    '<button type="button" data-k="replay" style="margin-top:8px;padding:6px 12px;border:0;border-radius:6px;background:#ffb347;color:#1a1a1a;font-weight:700;cursor:pointer">↻ Replay</button>';
  document.body.appendChild(hud);
  const q = (k: string): HTMLElement => hud.querySelector(`[data-k="${k}"]`) as HTMLElement;
  const hudLabel = q("label");
  const hudWind = q("wind");
  const hudLocal = q("local");
  const hudPhase = q("phase");
  const hudBar = q("bar");
  const replayButton = q("replay") as HTMLButtonElement;
  const replay = (): void => {
    cyclone.seek(0);
    cyclone.paused = false;
  };
  replayButton.addEventListener("click", replay);
  let lastHud = "";

  const state = (): HurricaneState => {
    const o = cyclone.observed;
    return {
      time: cyclone.time,
      duration: track.duration,
      phase: o.phase,
      category: o.category,
      label: saffirSimpsonLabel(cyclone.state.maxWind),
      maxWind: cyclone.state.maxWind,
      localWind: o.wind.speed,
      rain: o.rain,
      cover: o.cover,
      distanceKm: o.distance / 1000,
      waveHeight: cyclone.ocean?.significantHeight ?? 0,
      surge: o.surge,
      palmBend: palms.meanBend,
      landfall: cyclone.time >= landfallTime,
      finished: cyclone.finished,
      tier,
    };
  };

  return {
    scene,
    cameraEntity,
    controlsHint: "Drag to look around · Scroll to zoom · Replay in the storm panel",
    camera: {
      target: new Vec3(0, 3.4, 25),
      distance: 75,
      minDistance: 8,
      maxDistance: 160,
      azimuth: 0,
      elevation: 0.1,
      minElevation: -0.08,
      maxElevation: 1.2,
      groundClearance: 1.7,
      groundHeight,
    },
    update(): void {
      const o = cyclone.observed;
      cycle.sunIntensity = SUN_INTENSITY * o.sunFactor * (1 - 0.7 * o.darkness);
      cycle.ambientScale = AMBIENT * o.ambientFactor * (1 - 0.55 * o.darkness);
      cycle.apply();
      // Near-black storm grey under the eyewall.
      scene.setSky({ exposure: 1 - 0.97 * o.darkness });
      scene.setExposure(1 - 0.6 * o.darkness);
      const s = state();
      const u = windUnits(s.maxWind);
      const l = windUnits(s.localWind);
      const phase = s.time < 3 ? "Storm forming far offshore" : s.finished ? "Storm moving inland" : PHASE_TEXT[s.phase] ?? s.phase;
      const landfall = s.landfall && !s.finished && s.phase !== "eye" ? " · LANDFALL" : "";
      const text = `${s.label}|${Math.round(u.mph)}|${Math.round(l.mph)}|${phase}${landfall}|${Math.round(s.distanceKm)}`;
      if (text !== lastHud) {
        lastHud = text;
        hudLabel.textContent = s.label;
        hudWind.textContent = `Max sustained ${Math.round(u.mph)} mph (${Math.round(u.kmh)} km/h)`;
        hudLocal.textContent = `Wind on the beach ${Math.round(l.mph)} mph · eye ${Math.round(s.distanceKm)} km`;
        hudPhase.textContent = phase + landfall;
      }
      hudBar.style.width = `${Math.round((s.time / s.duration) * 100)}%`;
      replayButton.textContent = s.finished ? "↻ Replay storm" : "↻ Replay";
    },
    overlay(): string {
      const s = state();
      return `hurricane t ${s.time.toFixed(1)}/${s.duration}s  ${s.phase}  cat ${s.category}  local ${s.localWind.toFixed(1)} m/s  rain ${s.rain.toFixed(2)}  Hs ${s.waveHeight.toFixed(2)} m  surge ${s.surge.toFixed(2)} m  drops ≈${rain.aliveEstimate}  tier ${tier}`;
    },
    hurricaneState: state,
    seek(time: number): void {
      cyclone.seek(time);
    },
    replay,
    setPaused(paused: boolean): void {
      cyclone.paused = paused;
    },
    dispose(): void {
      replayButton.removeEventListener("click", replay);
      hud.remove();
      scene.dispose();
      for (const o of owned) o.dispose();
    },
  };
}

export { HURRICANE_BEATS };
