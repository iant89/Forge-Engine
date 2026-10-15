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
 *
 * fe-34 (realism pass): a winding coast with dune rows, beach houses and palms behind the dunes;
 * the sea draws back (wind set-down + a scripted low tide) then the surge floods the beach; billowy
 * low storm clouds with fast scud; lightning (engine `LightningSystem`) whose rate follows the
 * storm, with bolts to sea and land and flashes lighting the deck; waterspouts offshore while the
 * storm is still at sea (engine `WaterspoutSystem` + `WaterspoutVisual`, seeded); wind-blown spray,
 * spindrift, sand, debris and mist (engine `WindBlownField`); gusts that whip the palms and buffet
 * the camera (`windBuffet`); and an original WebAudio soundscape (`StormSoundscape`, opt-in button).
 */

import {
  shoreCurveOffset,
  AABB,
  Camera,
  CycloneSystem,
  DayNightCycle,
  type DeviceTier,
  type Engine,
  Geometry,
  Light,
  LightningBoltVisual,
  LightningSystem,
  Material,
  PrecipitationField,
  StormSoundscape,
  WaterspoutSystem,
  WaterspoutVisual,
  WindBlownField,
  type WindBlownMaterial,
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
  waterspoutSpawnRate,
  windBuffet,
} from "@forge/engine";
import { BeachHouses, houseSites } from "./hurricaneHouses.js";
import type { DemoSceneHandle } from "./cubesScene.js";
import { PalmGrove, palmSites } from "./hurricanePalms.js";
import {
  HURRICANE_BEATS,
  HURRICANE_COAST,
  HURRICANE_OBSERVER,
  HURRICANE_SEED,
  HURRICANE_TIME_COMPRESSION,
  createHurricaneTrack,
  hurricaneLandfallTime,
  hurricaneTide,
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
  /** fe-34 */
  seaLevel: number;
  setup: number;
  tide: number;
  gust: number;
  gustSpeed: number;
  windFrom: string;
  strikes: number;
  flash: number;
  waterspouts: number;
  waterspoutsSpawned: number;
  houses: number;
  palms: number;
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
  /** fe-34 debug hooks (screenshots / checks). */
  forceWaterspout(): boolean;
  forceStrike(hold?: boolean): boolean;
  /** Freeze lightning + waterspouts (the frozen flash/bolt stays on screen). */
  holdEffects(hold: boolean): void;
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
  scene.setClouds({
    coverage: 0.3,
    density: 0.7,
    height: 1400,
    thickness: 700,
    scale: 0.0016,
    silverLining: 0.8,
    billow: 0.5,
    layers: tierValue(tier, { low: 2, medium: 3, high: 4 }),
  });

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
  addMesh("beach-near", coastalTerrainSource(HURRICANE_COAST, 0, -70, 420, 300, Math.round(420 / near), Math.round(300 / near)));
  addMesh("beach-far", coastalTerrainSource(HURRICANE_COAST, 0, -300, 2400, 1400, tierValue(tier, { low: 160, medium: 220, high: 300 }), tierValue(tier, { low: 90, medium: 120, high: 160 })), -0.3);

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
    // v2: the rain bands are already dark, billowing storm cloud, not white overcast.
    darknessGain: 6,
    seaLevel: 0,
    // fe-34 realism: offshore winds draw the sea back (set-down), onshore winds pile it up.
    coast: { onshoreX: 0, onshoreZ: -1, coefficient: 4e-4, limit: 1.2 },
    gustiness: 0.85,
    // v2: gusts follow the storm clock and the scene seed, so seek(t) == playing to t.
    gustSeed: HURRICANE_SEED + 1,
    ceiling: { clear: 1400, storm: 520 },
    scud: 3,
    billow: { clear: 0.5, storm: 0.95 },
    runup: { base: 0.7, perMetre: 0.45 },
  });
  scene.add(cyclone);
  const setTide = (): void => {
    cyclone.tideOffset = hurricaneTide(cyclone.time);
  };
  setTide();
  // Gust factor on the storm's wind field (palms, spray and rain all feel the same squalls).
  const gustFactor = (): number => (cyclone.observed.wind.speed > 0.01 ? cyclone.observed.gustSpeed / cyclone.observed.wind.speed : 1);

  // Palms on the back beach, swaying in the storm's own wind field.
  const windScratch = { x: 0, z: 0, speed: 0 };
  // fe-34: houses behind the dunes; palms behind the dunes, around the houses and a few on the
  // back beach.
  const houses = new BeachHouses({ name: "houses", gpu: engine.gpu, sites: houseSites(HURRICANE_COAST, tierValue(tier, { low: 5, medium: 7, high: 9 }), 520, 122) });
  scene.add(houses);
  const sites = [
    ...palmSites(HURRICANE_COAST, tierValue(tier, { low: 6, medium: 9, high: 12 }), 300, 118, 170, 9),
    ...palmSites(HURRICANE_COAST, tierValue(tier, { low: 4, medium: 6, high: 8 }), 260, 40, 62, 21),
  ];
  const palms = new PalmGrove({
    name: "palms",
    gpu: engine.gpu,
    sites,
    trunkSegments: tierValue(tier, { low: 4, medium: 5, high: 6 }),
    fronds: tierValue(tier, { low: 7, medium: 8, high: 10 }),
    wind: (x, z, out) => {
      cycloneWindAt(cyclone.state, x, z, fieldOptions, windScratch);
      const g = gustFactor();
      out.x = windScratch.x * g;
      out.z = windScratch.z * g;
    },
  });
  scene.add(palms);

  // Rain (engine): intensity and slant from the storm at the viewer.
  const rain = new PrecipitationField({
    name: "rain",
    capacity: tierValue(tier, { low: 6144, medium: 12288, high: 20480 }),
    maxRate: tierValue(tier, { low: 4200, medium: 7500, high: 12000 }),
    follow: () => cameraEntity.transform.position,
    // Driven rain: squalls (gusts) dump harder and slant it further.
    drive: () => {
      const o = cyclone.observed;
      const g = gustFactor();
      return { intensity: Math.min(1, o.rain * (0.8 + 0.5 * o.gust)), windX: o.wind.x * g, windZ: o.wind.z * g };
    },
    seed: 33,
  });
  scene.add(rain);

  // fe-34: wind made visible — spray off the surf, spindrift streaming off crests, blowing sand,
  // shredded leaves and mist streaks (engine WindBlownField presets; the demo picks where/when).
  const seaLevel = (): number => scene.settings.water.level;
  const VIEW_TARGET = new Vec3(80, 3, -10);
  const camPos = (): { x: number; y: number; z: number } => cameraEntity.transform.position;
  // fe-34 v2: a sea point in the default view — `dist` metres along the view, `side` metres to the
  // sea side of it, pushed out past the surf so strikes and spouts land where the camera looks.
  const viewSeaPoint = (dist: number, side: number): { x: number; z: number } => {
    const c = camPos();
    let fx = VIEW_TARGET.x - c.x;
    let fz = VIEW_TARGET.z - c.z;
    const l = Math.hypot(fx, fz) || 1;
    fx /= l;
    fz /= l;
    let rx = -fz;
    let rz = fx;
    if (rz < 0) {
      rx = -rx;
      rz = -rz;
    }
    const x = c.x + fx * dist + rx * side;
    let z = c.z + fz * dist + rz * side;
    // Offshore is +Z here; keep at least 250 m seaward of the (curvy) waterline.
    const minZ = -shoreCurveOffset(HURRICANE_COAST, x) + 250;
    if (z < minZ) z = minZ;
    return { x, z };
  };
  const windDrive = (from: number, span: number, scale = 1) => (): { intensity: number; windX: number; windZ: number } => {
    const o = cyclone.observed;
    const g = gustFactor();
    return { intensity: Math.max(0, Math.min(1, ((o.gustSpeed - from) / span) * scale)), windX: o.wind.x * g, windZ: o.wind.z * g };
  };
  const blown = (material: WindBlownMaterial, opts: { follow: () => { x: number; y: number; z: number }; baseY: () => number; from: number; span: number; capacity: number; rate: number; radius: number; seed: number; scale?: () => number }): WindBlownField => {
    const drive = windDrive(opts.from, opts.span);
    const field = new WindBlownField({
      name: `wind-${material}`,
      material,
      capacity: opts.capacity,
      maxRate: opts.rate,
      follow: opts.follow,
      baseY: opts.baseY,
      radius: opts.radius,
      seed: opts.seed,
      drive: () => {
        const d = drive();
        d.intensity *= opts.scale?.() ?? 1;
        return d;
      },
    });
    scene.add(field);
    return field;
  };
  const fx = tierValue(tier, { low: 0.4, medium: 0.7, high: 1 });
  // The surf zone in front of the viewer (follows the moving waterline).
  const surfPoint = (): { x: number; y: number; z: number } => ({ x: camPos().x, y: seaLevel(), z: 7 - seaLevel() / 0.06 });
  const windFields = [
    blown("spray", { follow: surfPoint, baseY: seaLevel, from: 14, span: 35, capacity: Math.round(4096 * fx), rate: 1600 * fx, radius: 70, seed: 81 }),
    blown("spindrift", { follow: () => ({ x: camPos().x, y: 0, z: 260 }), baseY: seaLevel, from: 22, span: 35, capacity: Math.round(4096 * fx), rate: 1400 * fx, radius: 220, seed: 82 }),
    blown("sand", {
      follow: camPos,
      baseY: () => groundHeight(camPos().x, camPos().z),
      from: 10,
      span: 30,
      capacity: Math.round(4096 * fx),
      rate: 2400 * fx,
      radius: 35,
      seed: 83,
      // Wet sand does not blow: off once the surge covers the beach under the viewer.
      scale: () => (seaLevel() > groundHeight(camPos().x, camPos().z) - 0.2 ? 0 : 1 - 0.7 * cyclone.observed.rain),
    }),
    blown("debris", { follow: () => ({ x: camPos().x, y: 0, z: camPos().z - 60 }), baseY: () => groundHeight(camPos().x, camPos().z - 60) + 3, from: 28, span: 30, capacity: Math.round(1024 * fx), rate: 240 * fx, radius: 90, seed: 84 }),
    blown("mist", { follow: () => ({ x: camPos().x, y: 0, z: camPos().z + 120 }), baseY: seaLevel, from: 24, span: 40, capacity: Math.round(1024 * fx), rate: 220 * fx, radius: 120, seed: 85, scale: () => 0.4 + 0.6 * cyclone.observed.rain }),
  ];

  // fe-34: lightning (engine) — strike rate follows the storm's convection at the viewer; bolts
  // land on the sea or the beach under them, intra-cloud flashes light the deck.
  const surfaceAt = (x: number, z: number): number => Math.max(seaLevel(), groundHeight(x, z));
  const convection = (): number => {
    const o = cyclone.observed;
    if (o.phase === "eye" || o.phase === "clear") return 0;
    return Math.min(1, Math.pow(Math.max(o.rain, 0.6 * o.storm), 1.4));
  };
  let sound: StormSoundscape | null = null;
  let strikeCycle = 0;
  // v2: strikes biased into the default view (2/3) so the storm's lightning is actually seen.
  const lightning = new LightningSystem({
    name: "lightning",
    seed: HURRICANE_SEED,
    rate: 0.55,
    storm: convection,
    // Strikes cluster in the convection toward the storm; v2: two of every three are placed in the
    // default view (offshore, ahead of the beach) so the bolts are seen, the rest stormward.
    center: () => {
      if (strikeCycle++ % 3 !== 2) return viewSeaPoint(1300, 200);
      const s = cyclone.state;
      const dx = s.x - HURRICANE_OBSERVER.x;
      const dz = s.z - HURRICANE_OBSERVER.z;
      const d = Math.hypot(dx, dz) || 1;
      const k = Math.min(1800, d * 0.5);
      return { x: HURRICANE_OBSERVER.x + (dx / d) * k, z: HURRICANE_OBSERVER.z + (dz / d) * k };
    },
    areaRadius: 650,
    cloudHeight: 650,
    surfaceAt,
    branches: tierValue(tier, { low: 2, medium: 3, high: 4 }),
    cloudFlashFraction: 0.45,
    subdivisions: tierValue(tier, { low: 5, medium: 6, high: 6 }),
    roughness: 0.42,
    flashLightIntensity: 450,
    skyFlashExposure: 0.7,
    boltColor: 0xf4f6ffff,
    boltWidth: 16,
    onStrike: (strike) => {
      const c = camPos();
      sound?.thunder(Math.hypot(strike.position.x - c.x, strike.position.z - c.z), strike.energy);
    },
  });
  scene.add(lightning);
  // v2: bolts as real emissive geometry, a few pixels wide at any distance, with a glow sheath.
  scene.add(
    new LightningBoltVisual({
      name: "lightning-visual",
      gpu: engine.gpu,
      lightning,
      viewer: camPos,
      corePixels: tierValue(tier, { low: 4, medium: 5, high: 6 }),
      glowPixels: tierValue(tier, { low: 12, medium: 16, high: 18 }),
      maxSegments: tierValue(tier, { low: 256, medium: 384, high: 512 }),
    }),
  );

  // fe-34: waterspouts (engine) — only while the storm is still well offshore and the wind is up;
  // the chance scales with the wind. Seeded, so a seeded run spawns the same spouts.
  const SPOUT_WINDOW = { start: 18, end: 72 } as const;
  const spouts = new WaterspoutSystem({
    name: "waterspouts",
    seed: HURRICANE_SEED + 3940,
    spawnRate: () => {
      const t = cyclone.time;
      if (t < SPOUT_WINDOW.start || t > SPOUT_WINDOW.end || cyclone.paused) return 0;
      return waterspoutSpawnRate(cyclone.observed.wind.speed, { threshold: 10, full: 30, perSecond: 0.06 });
    },
    // v2: where the camera looks — offshore, ahead of the beach view (seeded, so still deterministic).
    area: () => {
      const p = viewSeaPoint(1300, 300);
      return { x: p.x, z: p.z, radius: 380 };
    },
    wind: () => cyclone.observed.wind,
    drift: 0.25,
    baseRadius: 14,
    topRadius: 110,
    maxActive: tierValue(tier, { low: 1, medium: 2, high: 2 }),
  });
  scene.add(spouts);
  const spoutVisual = new WaterspoutVisual({
    name: "waterspout-visual",
    gpu: engine.gpu,
    spouts,
    seaLevel,
    cloudBase: () => scene.settings.clouds.height - scene.settings.clouds.thickness * 0.5,
    segments: tierValue(tier, { low: 10, medium: 14, high: 18 }),
    // v2: a dark, dense condensation funnel that reads against the grey sky.
    color: 0x7a828b,
    opacity: 0.88,
    // Readable through the rain-band haze from the beach (the storm fog would erase it at 1 km).
    fogExempt: true,
    sprayCapacity: tierValue(tier, { low: 1024, medium: 2048, high: 3072 }),
  });
  scene.add(spoutVisual);

  // Camera buffeting: the controller orbits a target that the gusts shove about.
  // The viewer stands high on the back beach looking up the coast: sea and surf on the right,
  // the curving beach, dunes, houses and palms on the left — the surge visibly floods toward them.
  const BASE_TARGET = VIEW_TARGET;
  const buffet = { x: 0, y: 0, z: 0, roll: 0, pitch: 0 };
  const compass = (x: number, z: number): string => {
    // Direction the wind blows FROM (+x east, −z north here: land is −Z/north of the beach).
    const from = Math.atan2(-x, z);
    const names = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
    const i = Math.round(((from + Math.PI * 2) % (Math.PI * 2)) / (Math.PI / 4)) % 8;
    return names[i]!;
  };

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
    setTide();
  };
  // Sound is opt-in (browsers start audio only from a gesture).
  const soundButton = document.createElement("button");
  soundButton.type = "button";
  soundButton.textContent = "🔊 Sound";
  soundButton.style.cssText = "margin:8px 0 0 8px;padding:6px 12px;border:0;border-radius:6px;background:#31475c;color:#eef4f8;font-weight:700;cursor:pointer";
  replayButton.after(soundButton);
  const toggleSound = (): void => {
    if (sound) {
      void sound.context.close();
      sound.dispose();
      sound = null;
      soundButton.textContent = "🔊 Sound";
      return;
    }
    const Ctx = (window as unknown as { AudioContext?: typeof AudioContext }).AudioContext;
    if (!Ctx) return;
    sound = new StormSoundscape(new Ctx());
    soundButton.textContent = "🔇 Mute";
  };
  soundButton.addEventListener("click", toggleSound);
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
      seaLevel: scene.settings.water.level,
      setup: o.setup,
      tide: cyclone.tideOffset,
      gust: o.gust,
      gustSpeed: o.gustSpeed,
      windFrom: compass(o.wind.x, o.wind.z),
      strikes: lightning.strikeCount,
      flash: lightning.flashTotal,
      waterspouts: spouts.spouts.length,
      waterspoutsSpawned: spouts.spawned,
      houses: houses.count,
      palms: palms.count,
      landfall: cyclone.time >= landfallTime,
      finished: cyclone.finished,
      tier,
    };
  };

  return {
    scene,
    cameraEntity,
    controlsHint: "Drag to look around · Scroll to zoom · Replay in the storm panel",
    followTarget: () => ({ x: BASE_TARGET.x + buffet.x * 6, y: BASE_TARGET.y + buffet.y * 6, z: BASE_TARGET.z + buffet.z * 3 }),
    camera: {
      target: BASE_TARGET.clone(),
      distance: 120,
      minDistance: 8,
      maxDistance: 320,
      azimuth: 1.05,
      elevation: 0.09,
      minElevation: -0.08,
      maxElevation: 1.2,
      groundClearance: 1.7,
      groundHeight,
    },
    update(_dt: number): void {
      const o = cyclone.observed;
      setTide();
      windBuffet(cyclone.time, o.gustSpeed, o.gust, 1, buffet);
      sound?.set({ windSpeed: o.gustSpeed, gust: o.gust, rain: o.rain, surf: Math.min(1, (cyclone.ocean?.significantHeight ?? 0) / 5) });
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
      const text = `${s.label}|${Math.round(u.mph)}|${Math.round(l.mph)}|${phase}${landfall}|${Math.round(s.distanceKm)}|${s.windFrom}|${Math.round(s.gustSpeed)}|${s.seaLevel.toFixed(1)}`;
      if (text !== lastHud) {
        lastHud = text;
        hudLabel.textContent = s.label;
        hudWind.textContent = `Max sustained ${Math.round(u.mph)} mph (${Math.round(u.kmh)} km/h)`;
        hudLocal.textContent = `Beach wind ${Math.round(l.mph)} mph from ${s.windFrom}, gusts ${Math.round(windUnits(s.gustSpeed).mph)} · eye ${Math.round(s.distanceKm)} km · sea ${s.seaLevel >= 0 ? "+" : ""}${s.seaLevel.toFixed(1)} m`;
        hudPhase.textContent = phase + landfall;
      }
      hudBar.style.width = `${Math.round((s.time / s.duration) * 100)}%`;
      replayButton.textContent = s.finished ? "↻ Replay storm" : "↻ Replay";
    },
    overlay(): string {
      const s = state();
      return `hurricane t ${s.time.toFixed(1)}/${s.duration}s  ${s.phase}  cat ${s.category}  local ${s.localWind.toFixed(1)} m/s (gust ${s.gustSpeed.toFixed(0)}) from ${s.windFrom}  rain ${s.rain.toFixed(2)}  Hs ${s.waveHeight.toFixed(2)} m  sea ${s.seaLevel.toFixed(2)} m  strikes ${s.strikes}  spouts ${s.waterspouts}  drops ≈${rain.aliveEstimate}  wind fx ${windFields.map((f) => Math.round(f.rate)).join("/")}  tier ${tier}`;
    },
    hurricaneState: state,
    seek(time: number): void {
      cyclone.seek(time);
      setTide();
    },
    forceWaterspout(): boolean {
      // Close enough to frame from the beach: ~600 m out, a little up the coast.
      const sp = spouts.spawn(viewSeaPoint(1150, 260), 40);
      sp.age = sp.life * 0.4;
      return true;
    },
    forceStrike(hold = false): boolean {
      const p = viewSeaPoint(1400, 120);
      const c = lightning.trigger(new Vec3(p.x, 0, p.z), 1.5);
      if (hold) {
        c.age = 0.02;
        lightning.paused = true;
      }
      return true;
    },
    holdEffects(hold: boolean): void {
      lightning.paused = hold;
      spouts.paused = hold;
    },
    replay,
    setPaused(paused: boolean): void {
      cyclone.paused = paused;
    },
    dispose(): void {
      replayButton.removeEventListener("click", replay);
      soundButton.removeEventListener("click", toggleSound);
      if (sound) {
        void sound.context.close();
        sound.dispose();
        sound = null;
      }
      hud.remove();
      scene.dispose();
      for (const o of owned) o.dispose();
    },
  };
}

export { HURRICANE_BEATS };
