/**
 * Phase 8a: sky and day/night. A plain ground plane, a ring of spheres and a tall gnomon under a
 * `DayNightCycle` that runs a June day at 47°N in about six real minutes. Everything you see change
 * is driven by the cycle: the sun's direction and colour (from the atmosphere's transmittance),
 * the ambient (from the sky's hemispherical radiance), the fog colour (from the horizon), and the
 * sky pass itself (sun disc, scattered light, stars after dusk).
 *
 * Controls: the on-screen panel (`examples/index.html`, bound by `controls/skyTouch.ts`) is the
 * interface — `-1h` / `+1h` scrub the clock, `Pause` stops/starts it, `Mars` swaps the Earth preset
 * for Mars (dust: butterscotch day sky) and back. The panel is shown on every device; the keys
 * (`[` / `]`, `T`, `M`) remain as shortcuts on the very same actions. `window.__forge.setTimeOfDay(h)`
 * does the same for the gate.
 */

import {
  Camera,
  Color,
  DayNightCycle,
  EARTH_ATMOSPHERE,
  type Engine,
  Light,
  MARS_ATMOSPHERE,
  Material,
  Renderable,
  Scene,
  Vec3,
  createAtmosphere,
  createBox,
  createCylinder,
  createPlane,
  createSphere,
} from "@forge/engine";
import { attachSkyTouch } from "../controls/skyTouch.js";
import type { DemoSceneHandle } from "./cubesScene.js";

export interface SkySceneHandle extends DemoSceneHandle {
  cycle: DayNightCycle;
  setTimeOfDay(hours: number): void;
  setPlanet(planet: "earth" | "mars"): void;
  /** The planet the panel/key currently has active (the browser gate reads it after a tap). */
  planetState(): "earth" | "mars";
}

/** 1 real second = 4 simulated minutes, and the rate `Pause`/`T` restores when the clock resumes. */
const TIME_SCALE = 240;

export function buildSkyScene(engine: Engine): SkySceneHandle {
  const scene = new Scene({ name: "sky" });
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
  // Height fog: the ground plane is opaque fog by its 1 km edge (where the sky pass's own planet
  // ground takes over, fogged the same way) and the sky fills with it toward the horizon; the cycle
  // keeps its colour equal to the sky just above the horizon.
  scene.setFog("height", { density: 0.003, heightFalloff: 0.08, heightBase: 0 });
  scene.setSky({ quality: "medium", sunDiscIntensity: 120 });

  const meshes = {
    ground: createPlane(engine.gpu, { width: 2000, depth: 2000 }),
    sphere: createSphere(engine.gpu, { radius: 1.1, widthSegments: 40, heightSegments: 24 }),
    gnomon: createCylinder(engine.gpu, { radiusTop: 0.25, radiusBottom: 0.4, height: 9, radialSegments: 24 }),
    slab: createBox(engine.gpu, { width: 4, height: 0.5, depth: 4 }),
    cube: createBox(engine.gpu, { width: 1.6, height: 1.6, depth: 1.6 }),
  };
  const materials = {
    ground: new Material({ label: "sky.ground", color: 0x6b7a5a, roughness: 0.95, metallic: 0 }),
    stone: new Material({ label: "sky.stone", color: 0xb9b2a4, roughness: 0.7, metallic: 0 }),
    white: new Material({ label: "sky.white", color: 0xf2f2f0, roughness: 0.35, metallic: 0 }),
    copper: new Material({ label: "sky.copper", color: 0xc27a3a, roughness: 0.3, metallic: 0.9 }),
    blue: new Material({ label: "sky.blue", color: 0x2f5da8, roughness: 0.45, metallic: 0 }),
    black: new Material({ label: "sky.black", color: 0x1a1a1c, roughness: 0.25, metallic: 0.1 }),
  };

  const place = (name: string, position: Vec3, geometry: keyof typeof meshes, material: keyof typeof materials, castShadow = true): void => {
    const e = scene.createTransformedEntity(name, position);
    const r = new Renderable();
    r.geometry = meshes[geometry];
    r.material = materials[material];
    r.castShadow = castShadow;
    scene.world.addComponent(e.id, r);
  };

  place("ground", new Vec3(0, 0, 0), "ground", "ground", false);
  place("slab", new Vec3(0, 0.25, 0), "slab", "stone", false);
  place("gnomon", new Vec3(0, 5, 0), "gnomon", "stone");
  const ring: (keyof typeof materials)[] = ["white", "copper", "blue", "black", "white", "copper", "blue", "black"];
  for (let i = 0; i < ring.length; i++) {
    const a = (i / ring.length) * Math.PI * 2;
    place(`sphere-${i}`, new Vec3(Math.cos(a) * 7, 1.1, Math.sin(a) * 7), "sphere", ring[i]!);
  }
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + 0.3;
    place(`cube-${i}`, new Vec3(Math.cos(a) * 16, 0.8, Math.sin(a) * 16), "cube", i % 2 ? "stone" : "black");
  }

  const cameraEntity = scene.createTransformedEntity("camera", new Vec3(14, 6, -18));
  const camera = new Camera();
  camera.fovY = Math.PI / 3;
  camera.near = 0.1;
  camera.far = 900;
  scene.world.addComponent(cameraEntity.id, camera);
  cameraEntity.transform.lookAt(new Vec3(0, 3, 0));

  const sunEntity = scene.createTransformedEntity("sun", new Vec3(0, 50, 0));
  const sun = new Light();
  sun.kind = "directional";
  sun.castShadow = true;
  sun.shadowNormalBias = 0.8;
  scene.world.addComponent(sunEntity.id, sun);

  // 47°N (Zürich-ish), June 21, starting mid-morning; 1 real second = 4 simulated minutes.
  const cycle = new DayNightCycle({
    name: "dayNight",
    latitude: 47,
    dayOfYear: 172,
    timeOfDay: 9.5,
    timeScale: TIME_SCALE,
    sun,
    // Light units are not sky units: the single-scattering sky is ~3× darker than a real one, so the
    // sky renders at `sky.sunIntensity` 20 while the light gets 4.2 — that ratio reproduces the real
    // sky-to-sun irradiance split (~15-20 %) once the sky's estimate is scaled down here.
    sunIntensity: 4.2,
    ambientScale: 0.6,
    driveAmbient: true,
    driveFog: true,
    driveSky: true,
  });
  scene.add(cycle);

  let planet: "earth" | "mars" = "earth";
  const setPlanet = (next: "earth" | "mars"): void => {
    planet = next;
    // The sky pass and the cycle (light colour, ambient, fog) must agree on the planet.
    const preset = next === "mars" ? MARS_ATMOSPHERE : EARTH_ATMOSPHERE;
    scene.setSky({ atmosphere: next === "mars" ? createAtmosphere({}, MARS_ATMOSPHERE) : null });
    cycle.setAtmosphere(preset).apply();
    materials.ground.setColor(Color.fromSrgbHex(next === "mars" ? 0x9a5a3a : 0x6b7a5a));
  };

  // One action per shortcut, shared by the on-screen panel and the keys. The panel is the
  // interface (shown on every device); the keys stay as shortcuts on the very same path, so the
  // two inputs cannot drift. `panelState` is what the panel paints — the panel repaints itself
  // after every press, and `update()` below re-syncs it for changes that came from anywhere else.
  const scrubHours = (hours: number): void => {
    cycle.setTime(cycle.timeOfDay + hours).apply();
  };
  const togglePause = (): boolean => {
    cycle.timeScale = cycle.timeScale === 0 ? TIME_SCALE : 0;
    return cycle.timeScale === 0;
  };
  const togglePlanet = (): "earth" | "mars" => {
    setPlanet(planet === "earth" ? "mars" : "earth");
    return planet;
  };
  const panelState = (): { planet: "earth" | "mars"; paused: boolean } => ({
    planet,
    paused: cycle.timeScale === 0,
  });

  const onKey = (event: KeyboardEvent): void => {
    if (event.key === "[") scrubHours(-1);
    else if (event.key === "]") scrubHours(1);
    else if (event.key === "t" || event.key === "T") togglePause();
    else if (event.key === "m" || event.key === "M") togglePlanet();
  };
  window.addEventListener("keydown", onKey);

  // The panel is wired whether or not its markup exists; visibility is CSS on `body.scene-sky`.
  const touch = attachSkyTouch(document.getElementById("sky-touch"), {
    scrubHours,
    togglePause,
    togglePlanet,
    currentState: panelState,
  });

  return {
    scene,
    cameraEntity,
    cycle,
    controlsHint: "Drag to orbit · Scroll to zoom · Use the on-screen clock & planet buttons",
    camera: {
      target: new Vec3(0, 3, 0),
      distance: 26,
      minDistance: 4,
      maxDistance: 160,
      azimuth: 2.5,
      elevation: 0.18,
      minElevation: -0.05,
      groundClearance: 0.6,
      groundHeight: () => 0,
    },
    update(): void {
      // The cycle is stepped by Scene.update from the engine's fixed steps; the only per-frame
      // work here is keeping the panel's pressed markers level with the scene's own state (a key
      // or `window.__forge` call changes it without going through the panel).
      touch.sync(panelState());
    },
    overlay(): string {
      const a = scene.settings.ambientColor;
      const f = scene.settings.fog.color;
      return (
        `${planet}  ${cycle.clockText}  day ${Math.floor(cycle.dayOfYear)}  lat ${cycle.latitude}°  ×${cycle.timeScale}\n` +
        `sun el ${cycle.elevationDeg.toFixed(1)}°  az ${cycle.azimuthDeg.toFixed(1)}°  light ${cycle.sunLightIntensity.toFixed(2)}  ` +
        `rgb(${cycle.sunColor.r.toFixed(2)} ${cycle.sunColor.g.toFixed(2)} ${cycle.sunColor.b.toFixed(2)})\n` +
        `ambient (${a.r.toFixed(3)} ${a.g.toFixed(3)} ${a.b.toFixed(3)})  fog (${f.r.toFixed(3)} ${f.g.toFixed(3)} ${f.b.toFixed(3)})`
      );
    },
    setTimeOfDay(hours: number): void {
      cycle.setTime(hours).apply();
    },
    setPlanet,
    planetState: () => planet,
    dispose(): void {
      window.removeEventListener("keydown", onKey);
      touch.dispose();
      for (const m of Object.values(meshes)) m.dispose();
      for (const m of Object.values(materials)) m.dispose();
      scene.dispose();
    },
  };
}
