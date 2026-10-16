/**
 * Phase 18 demo: Beacon Defense (`?scene=scripting`). The scene only places the static set (ground,
 * beacon, turret, camera, sun), installs a ScriptRuntime and attaches the scripts; every bit of
 * gameplay — waves, drones, shooting, damage, score, game over and restart — lives in
 * `examples/src/scripting/beaconDefense.ts`, written against the public API only.
 */
import {
  Camera,
  Color,
  type Engine,
  Light,
  Material,
  Renderable,
  Scene,
  ScriptComponent,
  ScriptRuntime,
  Vec3,
  createBox,
  createCylinder,
  createPlane,
  createSphere,
  type EntityId,
} from "@forge/engine";
import type { DemoSceneHandle } from "./cubesScene.js";
import { Beacon, DEFAULT_TUNING, DroneTag, Scoreboard, Turret, WaveDirector, type BeaconDefenseTuning } from "../scripting/beaconDefense.js";

export interface ScriptingSceneState {
  wave: number;
  score: number;
  kills: number;
  beaconHp: number;
  gameOver: boolean;
  games: number;
  drones: number;
  shots: number;
  killTicks: number[];
  scripts: ReturnType<ScriptRuntime["stats"]>;
  lastError: string | null;
}

export interface ScriptingSceneHandle extends DemoSceneHandle {
  runtime: ScriptRuntime;
  state(): ScriptingSceneState;
}

export function buildScriptingScene(engine: Engine, tuning: BeaconDefenseTuning = DEFAULT_TUNING): ScriptingSceneHandle {
  const scene = new Scene({ name: "scripting" });
  scene.setBackgroundColor(Color.fromSrgbHex(0x0b1018));
  scene.settings.shadow.enabled = true;

  const geometries = {
    ground: createPlane(engine.gpu, { width: 70, depth: 70 }),
    beacon: createCylinder(engine.gpu, { radiusTop: 0.8, radiusBottom: 1.1, height: 3, radialSegments: 24 }),
    pillar: createBox(engine.gpu, { width: 1, height: 1.6, depth: 1 }),
    turret: createBox(engine.gpu, { width: 1.4, height: 0.6, depth: 1.4 }),
    drone: createSphere(engine.gpu, { radius: 0.45, widthSegments: 18, heightSegments: 12 }),
  };
  const materials = {
    ground: new Material({ label: "scripting.ground", color: 0x3a4250, roughness: 0.95 }),
    beacon: new Material({ label: "scripting.beacon", color: 0x58c4dd, roughness: 0.3, metallic: 0.2, emissive: Color.fromSrgbHex(0x0e3a46) }),
    turret: new Material({ label: "scripting.turret", color: 0x9aa3ad, roughness: 0.5, metallic: 0.6 }),
    drone: new Material({ label: "scripting.drone", color: 0xd8613c, roughness: 0.4, metallic: 0.3 }),
  };
  const place = (name: string, at: Vec3, geometry: keyof typeof geometries, material: keyof typeof materials, castShadow = true): EntityId => {
    const e = scene.createTransformedEntity(name, at);
    const r = new Renderable();
    r.geometry = geometries[geometry];
    r.material = materials[material];
    r.castShadow = castShadow;
    scene.world.addComponent(e.id, r);
    return e.id;
  };

  place("ground", new Vec3(0, 0, 0), "ground", "ground", false);
  const beacon = place("beacon", new Vec3(0, 1.5, 0), "beacon", "beacon");
  place("turret-pillar", new Vec3(3, 0.8, 0), "pillar", "turret");
  const turret = place("turret", new Vec3(3, 1.9, 0), "turret", "turret");
  const director = scene.createEntity("director").id;
  const scoreboardEntity = scene.createEntity("scoreboard").id;

  // The whole game: scripts on four entities, wired by typed events.
  const runtime = ScriptRuntime.install(scene.world);
  const beaconScript = new Beacon(tuning);
  const turretScript = new Turret(tuning);
  const waves = new WaveDirector(beacon, { droneGeometry: geometries.drone, droneMaterial: materials.drone }, tuning);
  const scoreboard = new Scoreboard(5);
  scene.world.addComponent(beacon, new ScriptComponent(beaconScript));
  scene.world.addComponent(turret, new ScriptComponent(turretScript));
  scene.world.addComponent(director, new ScriptComponent(waves));
  scene.world.addComponent(scoreboardEntity, new ScriptComponent(scoreboard));

  const cameraEntity = scene.createTransformedEntity("camera", new Vec3(0, 22, -26));
  const camera = new Camera();
  camera.fovY = Math.PI / 3;
  camera.near = 0.1;
  camera.far = 300;
  scene.world.addComponent(cameraEntity.id, camera);
  cameraEntity.transform.lookAt(new Vec3(0, 0, 0));

  const sunEntity = scene.createTransformedEntity("sun", new Vec3(12, 24, -10));
  const sun = new Light();
  sun.intensity = 4;
  sun.castShadow = true;
  scene.world.addComponent(sunEntity.id, sun);
  sunEntity.transform.lookAt(new Vec3(0, 0, 0));

  const state = (): ScriptingSceneState => {
    const beaconNow = scene.world.getComponent(beacon, ScriptComponent)?.scripts[0] as Beacon | undefined;
    const turretNow = scene.world.getComponent(turret, ScriptComponent)?.scripts[0] as Turret | undefined;
    return {
      wave: scoreboard.wave,
      score: scoreboard.score,
      kills: scoreboard.kills,
      beaconHp: beaconNow?.hp ?? beaconScript.hp,
      gameOver: scoreboard.gameOver,
      games: scoreboard.games,
      drones: scene.world.store(DroneTag).count,
      shots: turretNow?.shots ?? 0,
      killTicks: [...scoreboard.killTicks],
      scripts: runtime.stats(),
      lastError: runtime.lastError ? `${runtime.lastError.script} ${runtime.lastError.phase}: ${runtime.lastError.message}` : null,
    };
  };

  return {
    scene,
    cameraEntity,
    runtime,
    state,
    update: () => {},
    camera: { target: new Vec3(0, 1, -6), distance: 38, minDistance: 8, maxDistance: 90, azimuth: Math.PI, elevation: 1.05 },
    controlsHint: "Drag to orbit · the game plays itself: waves of drones, a turret, a beacon — all scripts",
    overlay: () => {
      const s = state();
      return (
        `BEACON DEFENSE  wave ${s.wave}  score ${s.score}  kills ${s.kills}  beacon ${s.beaconHp}/${tuning.beaconHp}` +
        `${s.gameOver ? "  GAME OVER — restarting" : ""}\n` +
        `scripts ${s.scripts.scriptsActive} active · drones ${s.drones} · timers ${s.scripts.timersActive} · coroutines ${s.scripts.coroutinesActive} · events ${s.scripts.eventsDelivered}` +
        `${s.lastError ? `\nscript error: ${s.lastError}` : ""}`
      );
    },
    dispose: () => {
      runtime.dispose();
      scene.dispose();
      for (const g of Object.values(geometries)) g.dispose();
      for (const m of Object.values(materials)) m.dispose();
    },
  };
}
