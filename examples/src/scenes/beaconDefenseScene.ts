/**
 * Beacon Defense (`?scene=beacon`) — the full game demo.
 *
 * Twelve waves of four drone types close on a beacon in a night arena. A turret fights on its own; the
 * player aims it with the pointer, fires a manual cannon, spends credits on six upgrades between waves
 * and triggers three abilities with cooldowns. Clear wave 12 to win, lose when the beacon's integrity
 * reaches zero, and the run restarts itself (or immediately, with `R`).
 *
 * The split is deliberate and follows the Phase 18 exit criterion it grew out of:
 *
 *  - **Gameplay** is scripts against the public API (`examples/src/scripting/beaconDefenseGame.ts`) on
 *    the fixed-step clock, so it is deterministic and testable without a GPU, a canvas or a browser.
 *  - **This file is the stage**: the arena and its models (built with the demo's `meshKit`), the lights
 *    and the HDR/bloom look, CPU particle bursts and shot tracers for feedback, the engine-UI HUD
 *    (`examples/src/ui/beaconHud.ts`) drawn by the WebGPU UI pass, procedural sound
 *    (`examples/src/audio/beaconSounds.ts`), and the pointer/keyboard input that becomes events on the
 *    script runtime's host channel.
 *
 * The two halves only ever talk through typed events: the scene posts `PlayerAim`, `PlayerFire`,
 * `BuyUpgrade`, `UseAbility`, `CallWave` and `GameRestart`, and listens for `ShotFired`, `DroneDown`,
 * `BeaconDamaged`, `WaveStarted`, `GameOver` and friends to make noise, sparks and toasts. Nothing here
 * decides a rule, and nothing in the game module knows a pixel exists.
 */

import {
  AudioSystem,
  Camera,
  Color,
  Geometry,
  Light,
  Material,
  Mat4,
  ParticleSimulation,
  Renderable,
  Scene,
  ScriptComponent,
  ScriptRuntime,
  Transform,
  UIGpuRenderer,
  UIManager,
  Vec3,
  attachDomInput,
  boxGeometrySource,
  cylinderGeometrySource,
  isAlive,
  packColorRGBA,
  sphereGeometrySource,
  torusGeometrySource,
  P_A,
  P_AGE,
  P_B,
  P_G,
  P_MAX_LIFE,
  P_R,
  P_SIZE,
  P_X,
  P_Y,
  P_Z,
  PARTICLE_FLOATS,
  type DomInputHandle,
  type Engine,
  type EntityId,
  type GeometrySource,
  type ScriptRuntimeStats,
  type WorldCamera,
  type WorldPoint,
} from "@forge/engine";
import type { DemoSceneHandle } from "./cubesScene.js";
import { IDENTITY, MeshBuilder, boxAt, chain, compose, rotateX, rotateY, roundedBoxSource, scaleBy, translate, tubeBetween } from "./meshKit.js";
import {
  ABILITIES,
  ABILITY_BY_ID,
  AbilityUsed,
  Beacon,
  BeaconDamaged,
  BeaconRepaired,
  BeaconTag,
  BuyUpgrade,
  CallWave,
  DEFAULT_GAME_TUNING,
  DRONE_SPECS,
  DroneDown,
  DroneLeaked,
  DroneTag,
  FINAL_WAVE,
  GameOver,
  GameRestart,
  GameState,
  GameWon,
  PlayerAim,
  PlayerFire,
  PurchaseRefused,
  ShotFired,
  Turret,
  TurretTag,
  UPGRADES,
  UPGRADE_BY_ID,
  UpgradeBought,
  UseAbility,
  WaveCleared,
  WaveDirector,
  WaveStarted,
  waveSpec,
  type AbilityId,
  type BeaconGameTuning,
  type DroneKind,
  type ShotSource,
  type UpgradeId,
} from "../scripting/beaconDefenseGame.js";
import { buildBeaconHud, stepsToSeconds, type BeaconHud, type BeaconHudSnapshot } from "../ui/beaconHud.js";
import { BeaconSoundscape, type BeaconSound } from "../audio/beaconSounds.js";

// -------------------------------------------------------------------------------------- constants

/** The arena's playable disc; drones spawn on this ring and fly in. */
export const ARENA_RADIUS = 34;
/** Height drones fly at, and the plane the pointer aims onto. */
export const FLIGHT_HEIGHT = 1.35;
/** Where the turret stands, offset from the beacon it defends. */
export const TURRET_AT = { x: 4.4, z: 4.4 } as const;
/** Sprite pool for particle bursts, and the tracer pool. */
export const SPARK_POOL = 320;
export const TRACER_POOL = 28;

export type BeaconCameraMode = "arena" | "turret" | "top";

const CAMERA_MODES: readonly BeaconCameraMode[] = ["arena", "turret", "top"];

const SPARK_COLORS: Readonly<Record<DroneKind, [number, number, number]>> = {
  scout: [1, 0.62, 0.24],
  splitter: [0.72, 0.55, 1],
  bruiser: [1, 0.36, 0.3],
  bomber: [1, 0.85, 0.3],
};

// ======================================================================================= models
//
// Every model is one merged source (one material, one draw), built from the demo's mesh kit. They are
// exported so a test can assert what the arena is made of without a GPU.

function rotor(builder: MeshBuilder, x: number, z: number, radius: number, y = 0.06): void {
  builder.add(cylinderGeometrySource({ radiusTop: radius, radiusBottom: radius, height: 0.035, radialSegments: 12 }), translate(x, y, z));
  builder.add(cylinderGeometrySource({ radiusTop: 0.035, radiusBottom: 0.045, height: 0.1, radialSegments: 8 }), translate(x, y - 0.05, z));
}

/** Four rotor arms at 45°, the light drone's silhouette. */
function quadRotorFrame(builder: MeshBuilder, arm: number, rotorRadius: number): void {
  for (let i = 0; i < 4; i++) {
    const a = Math.PI / 4 + (i * Math.PI) / 2;
    const x = Math.cos(a) * arm;
    const z = Math.sin(a) * arm;
    boxAt(builder, 0.07, 0.045, arm * 1.5, x * 0.5, 0, z * 0.5, rotateY(-a));
    rotor(builder, x, z, rotorRadius);
  }
}

/** Scout: a small hex hull with a nose cone and four rotors. Fast, fragile, numerous. */
export function scoutDroneSource(): GeometrySource {
  const b = new MeshBuilder();
  b.add(cylinderGeometrySource({ radiusTop: 0.3, radiusBottom: 0.34, height: 0.17, radialSegments: 6 }), IDENTITY);
  b.add(sphereGeometrySource({ radius: 0.17, widthSegments: 12, heightSegments: 8 }), translate(0, 0.11, 0));
  b.add(cylinderGeometrySource({ radiusTop: 0.02, radiusBottom: 0.13, height: 0.3, radialSegments: 10 }), compose(rotateX(Math.PI / 2), translate(0, -0.02, 0.3)));
  quadRotorFrame(b, 0.44, 0.19);
  return b.build("beacon.drone.scout");
}

/** Splitter: two half-shells around a core — it reads as something that comes apart. */
export function splitterDroneSource(): GeometrySource {
  const b = new MeshBuilder();
  b.add(roundedBoxSource({ width: 0.34, height: 0.26, depth: 0.78, radius: 0.09, segments: 3 }), translate(-0.26, 0, 0));
  b.add(roundedBoxSource({ width: 0.34, height: 0.26, depth: 0.78, radius: 0.09, segments: 3 }), translate(0.26, 0, 0));
  boxAt(b, 0.16, 0.14, 0.62, 0, 0, 0);
  b.add(sphereGeometrySource({ radius: 0.15, widthSegments: 12, heightSegments: 8 }), translate(0, 0.02, 0.05));
  quadRotorFrame(b, 0.5, 0.2);
  return b.build("beacon.drone.splitter");
}

/** Bruiser: an armoured hull with side plates, a ram nose and six rotors. */
export function bruiserDroneSource(): GeometrySource {
  const b = new MeshBuilder();
  b.add(roundedBoxSource({ width: 1.05, height: 0.4, depth: 1.4, radius: 0.12, segments: 3 }), IDENTITY);
  boxAt(b, 0.14, 0.3, 1.05, -0.6, 0.02, 0);
  boxAt(b, 0.14, 0.3, 1.05, 0.6, 0.02, 0);
  boxAt(b, 0.5, 0.16, 0.4, 0, 0.27, -0.3);
  b.add(cylinderGeometrySource({ radiusTop: 0.05, radiusBottom: 0.28, height: 0.55, radialSegments: 12 }), compose(rotateX(Math.PI / 2), translate(0, -0.03, 0.92)));
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    rotor(b, Math.cos(a) * 0.78, Math.sin(a) * 0.78, 0.24, 0.24);
    boxAt(b, 0.08, 0.06, 0.42, Math.cos(a) * 0.58, 0.16, Math.sin(a) * 0.58, rotateY(-a));
  }
  return b.build("beacon.drone.bruiser");
}

/** Bomber: a fat teardrop with fins and a payload bulge underneath. */
export function bomberDroneSource(): GeometrySource {
  const b = new MeshBuilder();
  b.add(sphereGeometrySource({ radius: 0.46, widthSegments: 16, heightSegments: 12 }), chain(scaleBy(1, 0.82, 1.55), IDENTITY));
  b.add(cylinderGeometrySource({ radiusTop: 0.03, radiusBottom: 0.3, height: 0.6, radialSegments: 14 }), compose(rotateX(Math.PI / 2), translate(0, 0.02, 0.85)));
  boxAt(b, 0.06, 0.4, 0.42, -0.44, 0.1, -0.25);
  boxAt(b, 0.06, 0.4, 0.42, 0.44, 0.1, -0.25);
  boxAt(b, 0.06, 0.44, 0.4, 0, 0.42, -0.35);
  b.add(sphereGeometrySource({ radius: 0.25, widthSegments: 14, heightSegments: 10 }), translate(0, -0.34, 0.05));
  quadRotorFrame(b, 0.56, 0.22);
  return b.build("beacon.drone.bomber");
}

/** The drone meshes, by kind: what the wave director hands each spawn. */
export function droneSources(): Readonly<Record<DroneKind, GeometrySource>> {
  return {
    scout: scoutDroneSource(),
    splitter: splitterDroneSource(),
    bruiser: bruiserDroneSource(),
    bomber: bomberDroneSource(),
  };
}

/** The beacon's structure: a drum base, three lattice legs, a cap and an antenna. */
export function beaconTowerSource(): GeometrySource {
  const b = new MeshBuilder();
  b.add(cylinderGeometrySource({ radiusTop: 2.35, radiusBottom: 2.7, height: 0.5, radialSegments: 30 }), translate(0, 0.25, 0));
  b.add(cylinderGeometrySource({ radiusTop: 2.05, radiusBottom: 2.35, height: 0.22, radialSegments: 30 }), translate(0, 0.6, 0));
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2 + 0.4;
    const leg = tubeBetween([Math.cos(a) * 1.85, 0.6, Math.sin(a) * 1.85], [Math.cos(a) * 0.62, 3.5, Math.sin(a) * 0.62], 0.1, 8);
    b.add(leg.source, leg.transform);
    const brace = tubeBetween([Math.cos(a) * 1.3, 1.9, Math.sin(a) * 1.3], [Math.cos(a + 2.1) * 1.3, 1.9, Math.sin(a + 2.1) * 1.3], 0.055, 6);
    b.add(brace.source, brace.transform);
  }
  b.add(cylinderGeometrySource({ radiusTop: 0.1, radiusBottom: 0.78, height: 0.8, radialSegments: 18 }), translate(0, 3.95, 0));
  b.add(cylinderGeometrySource({ radiusTop: 0.04, radiusBottom: 0.055, height: 2.3, radialSegments: 8 }), translate(0, 5.5, 0));
  b.add(roundedBoxSource({ width: 1.5, height: 0.34, depth: 1.5, radius: 0.08, segments: 2 }), translate(0, 0.95, 0));
  return b.build("beacon.tower");
}

/** The beacon's light: the column, two rings and the tip that flash when it is hit. */
export function beaconCoreSource(): GeometrySource {
  const b = new MeshBuilder();
  b.add(cylinderGeometrySource({ radiusTop: 0.5, radiusBottom: 0.66, height: 2.5, radialSegments: 20 }), translate(0, 2.3, 0));
  b.add(torusGeometrySource({ radius: 0.92, tube: 0.075, radialSegments: 44, tubularSegments: 8 }), translate(0, 2.9, 0));
  b.add(torusGeometrySource({ radius: 0.78, tube: 0.06, radialSegments: 40, tubularSegments: 8 }), translate(0, 1.7, 0));
  b.add(sphereGeometrySource({ radius: 0.2, widthSegments: 14, heightSegments: 10 }), translate(0, 6.7, 0));
  return b.build("beacon.core");
}

/** The turret's fixed pedestal. */
export function turretBaseSource(): GeometrySource {
  const b = new MeshBuilder();
  b.add(cylinderGeometrySource({ radiusTop: 1.15, radiusBottom: 1.4, height: 0.42, radialSegments: 24 }), translate(0, 0.21, 0));
  b.add(roundedBoxSource({ width: 1.5, height: 0.7, depth: 1.5, radius: 0.12, segments: 3 }), translate(0, 0.72, 0));
  b.add(cylinderGeometrySource({ radiusTop: 0.62, radiusBottom: 0.7, height: 0.34, radialSegments: 20 }), translate(0, 1.2, 0));
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    boxAt(b, 0.16, 0.5, 0.16, Math.cos(a) * 1.15, 0.3, Math.sin(a) * 1.15);
  }
  return b.build("beacon.turret.base");
}

/** The turret's yawing head: the barrel lies along local +Z, which is the engine's forward. */
export function turretHeadSource(): GeometrySource {
  const b = new MeshBuilder();
  b.add(roundedBoxSource({ width: 1.15, height: 0.62, depth: 1.3, radius: 0.13, segments: 3 }), IDENTITY);
  const barrel = tubeBetween([0, 0.06, 0.5], [0, 0.06, 2.35], 0.13, 12);
  b.add(barrel.source, barrel.transform);
  b.add(cylinderGeometrySource({ radiusTop: 0.19, radiusBottom: 0.19, height: 0.14, radialSegments: 14 }), compose(rotateX(Math.PI / 2), translate(0, 0.06, 2.3)));
  boxAt(b, 0.26, 0.42, 0.7, -0.66, 0.05, -0.1);
  boxAt(b, 0.26, 0.42, 0.7, 0.66, 0.05, -0.1);
  b.add(sphereGeometrySource({ radius: 0.16, widthSegments: 12, heightSegments: 8 }), translate(0, 0.4, -0.35));
  const antenna = tubeBetween([0.5, 0.3, -0.5], [0.62, 1.15, -0.62], 0.028, 6);
  b.add(antenna.source, antenna.transform);
  return b.build("beacon.turret.head");
}

/** A rim pylon: a column with a lamp head, repeated around the arena. */
export function pylonSource(): GeometrySource {
  const b = new MeshBuilder();
  b.add(cylinderGeometrySource({ radiusTop: 0.26, radiusBottom: 0.42, height: 3.4, radialSegments: 12 }), translate(0, 1.7, 0));
  b.add(roundedBoxSource({ width: 0.7, height: 0.5, depth: 0.7, radius: 0.1, segments: 2 }), translate(0, 3.6, 0));
  b.add(cylinderGeometrySource({ radiusTop: 0.5, radiusBottom: 0.62, height: 0.24, radialSegments: 14 }), translate(0, 0.12, 0));
  return b.build("beacon.pylon");
}

/** The pylon's lamp, drawn in the emissive material so bloom picks it up. */
export function pylonLampSource(): GeometrySource {
  const b = new MeshBuilder();
  b.add(sphereGeometrySource({ radius: 0.2, widthSegments: 12, heightSegments: 8 }), translate(0, 3.62, 0));
  return b.build("beacon.pylon.lamp");
}

/** Supply crates scattered inside the arena: cover, shadow-catchers, and a sense of scale. */
export function crateSource(): GeometrySource {
  const b = new MeshBuilder();
  b.add(roundedBoxSource({ width: 1.5, height: 1.1, depth: 1.5, radius: 0.09, segments: 2 }), translate(0, 0.55, 0));
  boxAt(b, 1.62, 0.12, 0.2, 0, 0.42, 0);
  boxAt(b, 1.62, 0.12, 0.2, 0, 0.86, 0);
  boxAt(b, 0.2, 1.16, 1.62, 0, 0.58, 0);
  return b.build("beacon.crate");
}

// ====================================================================================== snapshot

export interface BeaconSnapshot {
  wave: number;
  finalWave: number;
  phase: "combat" | "intermission" | "gameover" | "won";
  intermissionLeft: number;
  score: number;
  credits: number;
  kills: number;
  leaks: number;
  drones: number;
  waveDrones: number;
  waveKills: number;
  beaconHp: number;
  beaconMaxHp: number;
  gameOver: boolean;
  won: boolean;
  games: number;
  paused: boolean;
  soundOn: boolean;
  cameraMode: BeaconCameraMode;
  /** The player's aim point on the flight plane, and whether the pointer is driving the barrel. */
  aim: { x: number; z: number; player: boolean };
  turret: {
    damage: number;
    cannonDamage: number;
    aiInterval: number;
    manualInterval: number;
    range: number;
    targets: number;
    shots: number;
    manualShots: number;
    hits: number;
    yaw: number;
  };
  upgrades: Record<UpgradeId, number>;
  upgradeCosts: Record<UpgradeId, number | null>;
  abilities: Record<AbilityId, { cooldownSteps: number; cooldownSeconds: number; ready: boolean; cost: number; active: boolean }>;
  empActive: boolean;
  overchargeActive: boolean;
  fx: { sparks: number; emitted: number; tracers: number; capacity: number };
  hud: { widgets: number; elements: number; toasts: number };
  scripts: ScriptRuntimeStats;
  lastError: string | null;
  killTicks: number[];
  banner: string | null;
}

export interface BeaconDefenseHandle extends DemoSceneHandle {
  readonly runtime: ScriptRuntime;
  readonly ui: UIManager;
  readonly hud: BeaconHud;
  readonly game: GameState;
  state(): BeaconSnapshot;
  /** Aim the cannon at a world point on the flight plane (what the pointer does). */
  aimAt(x: number, z: number): void;
  /** Fire the manual cannon (the game's own cooldown decides whether a shot leaves). */
  fire(): void;
  useAbility(id: AbilityId): void;
  buyUpgrade(id: UpgradeId): void;
  callWave(): void;
  restart(): void;
  setPaused(paused: boolean): void;
  setCameraMode(mode: BeaconCameraMode): void;
  cycleCamera(): BeaconCameraMode;
  /** Sound is opt-in and needs a gesture in a browser; a test can inject a mock context. */
  setSound(on: boolean): boolean;
}

export interface BeaconDefenseOptions {
  /** The demo's canvas: pointer aim/fire and the UI's DOM input adapter. Omit in Node. */
  canvas?: HTMLCanvasElement | null;
  tuning?: BeaconGameTuning;
  /** Start with sound on (it still waits for the first gesture in a browser). */
  sound?: boolean;
  /** Supplies the audio context; defaults to the browser's, and to nothing on Node. */
  createAudioContext?: () => AudioContext | null;
  /** `"low" | "medium" | "high"`: shadow map size, spark pool and sprite counts. */
  deviceTier?: "low" | "medium" | "high";
  /** Start paused (screenshots, tests). */
  paused?: boolean;
}

type Fx =
  | { kind: "burst"; x: number; y: number; z: number; r: number; g: number; b: number; count: number; speed: number; life: number; size: number; spread: number }
  | { kind: "tracer"; x: number; y: number; z: number; dirX: number; dirZ: number; reach: number; source: ShotSource }
  | { kind: "sound"; name: BeaconSound; x?: number; y?: number; z?: number; rate?: number; volume?: number }
  | { kind: "shake"; amount: number }
  | { kind: "toast"; message: string; tone: "info" | "success" | "warning" | "error" }
  | { kind: "banner"; title: string; text: string; seconds: number };

const tierValue = <T>(tier: "low" | "medium" | "high", values: { low: T; medium: T; high: T }): T => values[tier];

// ========================================================================================= scene

export function buildBeaconDefenseScene(engine: Engine, options: BeaconDefenseOptions = {}): BeaconDefenseHandle {
  const tuning = options.tuning ?? DEFAULT_GAME_TUNING;
  const tier = options.deviceTier ?? "high";
  const canvas = options.canvas ?? null;

  const scene = new Scene({ name: "beacon-defense" });
  scene.setBackgroundColor(Color.fromSrgbHex(0x060a12));
  scene.settings.hdr = true;
  scene.settings.postProcessing = true;
  scene.settings.exposure = 1.05;
  scene.settings.toneMapping = "aces";
  scene.settings.bloom.enabled = true;
  scene.settings.bloom.threshold = 0.78;
  scene.settings.bloom.softKnee = 0.5;
  scene.settings.bloom.intensity = 0.72;
  scene.settings.shadow.enabled = true;
  scene.settings.shadow.cascades = tierValue(tier, { low: 1, medium: 2, high: 3 });
  scene.settings.shadow.mapSize = tierValue(tier, { low: 1024, medium: 1536, high: 2048 });
  scene.settings.shadow.distance = 90;
  scene.settings.ambientColor = Color.fromSrgbHex(0x223047);
  scene.settings.ambientIntensity = 0.55;
  scene.settings.fog.mode = "exp2";
  scene.settings.fog.color = Color.fromSrgbHex(0x0a1424);
  scene.settings.fog.density = 0.0075;

  // --------------------------------------------------------------------- geometries and materials
  const geometries: Geometry[] = [];
  const materials: Material[] = [];
  const geo = (src: GeometrySource): Geometry => {
    const g = Geometry.create(engine.gpu, src);
    geometries.push(g);
    return g;
  };
  const mat = (m: Material): Material => {
    materials.push(m);
    return m;
  };

  const droneGeometry: Readonly<Record<DroneKind, Geometry>> = {
    scout: geo(scoutDroneSource()),
    splitter: geo(splitterDroneSource()),
    bruiser: geo(bruiserDroneSource()),
    bomber: geo(bomberDroneSource()),
  };
  const droneMaterial: Readonly<Record<DroneKind, Material>> = {
    scout: mat(new Material({ label: "beacon.drone.scout", color: 0xd9663a, roughness: 0.42, metallic: 0.45, emissive: Color.fromSrgbHex(0x3a1408), emissiveStrength: 1.5 })),
    splitter: mat(new Material({ label: "beacon.drone.splitter", color: 0x8f74e8, roughness: 0.38, metallic: 0.5, emissive: Color.fromSrgbHex(0x241a4d), emissiveStrength: 1.6 })),
    bruiser: mat(new Material({ label: "beacon.drone.bruiser", color: 0x9c3b32, roughness: 0.55, metallic: 0.62, emissive: Color.fromSrgbHex(0x33100c), emissiveStrength: 1.2 })),
    bomber: mat(new Material({ label: "beacon.drone.bomber", color: 0xd9a520, roughness: 0.45, metallic: 0.55, emissive: Color.fromSrgbHex(0x3d2c05), emissiveStrength: 1.4 })),
  };

  const groundGeo = geo(cylinderGeometrySource({ radiusTop: ARENA_RADIUS + 2.5, radiusBottom: ARENA_RADIUS + 3.2, height: 1.0, radialSegments: tierValue(tier, { low: 40, medium: 56, high: 72 }) }));
  const outerGeo = geo(boxGeometrySource({ width: 320, height: 0.4, depth: 320 }));
  const rimGeo = geo(torusGeometrySource({ radius: ARENA_RADIUS, tube: 0.32, radialSegments: tierValue(tier, { low: 72, medium: 108, high: 144 }), tubularSegments: 8 }));
  const spawnRingGeo = geo(torusGeometrySource({ radius: ARENA_RADIUS, tube: 0.09, radialSegments: tierValue(tier, { low: 72, medium: 108, high: 144 }), tubularSegments: 6 }));
  const rangeRingGeo = geo(torusGeometrySource({ radius: tuning.aiRange, tube: 0.055, radialSegments: 96, tubularSegments: 6 }));
  const reticleGeo = geo(torusGeometrySource({ radius: 1.15, tube: 0.055, radialSegments: 32, tubularSegments: 6 }));
  const towerGeo = geo(beaconTowerSource());
  const coreGeo = geo(beaconCoreSource());
  const turretBaseGeo = geo(turretBaseSource());
  const turretHeadGeo = geo(turretHeadSource());
  const pylonGeo = geo(pylonSource());
  const lampGeo = geo(pylonLampSource());
  const crateGeo = geo(crateSource());
  const sparkGeo = geo(boxGeometrySource({ width: 1, height: 1, depth: 1 }));
  const tracerGeo = geo(boxGeometrySource({ width: 0.075, height: 0.075, depth: 1 }));

  const groundMat = mat(new Material({ label: "beacon.ground", color: 0x2b3444, roughness: 0.94, metallic: 0.06 }));
  const outerMat = mat(new Material({ label: "beacon.outer", color: 0x121a26, roughness: 1, metallic: 0 }));
  const rimMat = mat(new Material({ label: "beacon.rim", color: 0x39465a, roughness: 0.7, metallic: 0.35, emissive: Color.fromSrgbHex(0x0d3b4a), emissiveStrength: 1.1 }));
  const spawnRingMat = mat(new Material({ label: "beacon.spawnring", color: 0x0a0f16, roughness: 0.6, emissive: Color.fromSrgbHex(0xff5a2a), emissiveStrength: 2.6, transparent: true, opacity: 0.85, depthWrite: false, fogExempt: true }));
  const rangeRingMat = mat(new Material({ label: "beacon.rangering", color: 0x0a0f16, roughness: 0.6, emissive: Color.fromSrgbHex(0x39d5f0), emissiveStrength: 1.5, transparent: true, opacity: 0.5, depthWrite: false, fogExempt: true }));
  const reticleMat = mat(new Material({ label: "beacon.reticle", color: 0x0a0f16, roughness: 0.5, emissive: Color.fromSrgbHex(0xffc24a), emissiveStrength: 3.2, transparent: true, opacity: 0.9, depthWrite: false, fogExempt: true }));
  const steelMat = mat(new Material({ label: "beacon.steel", color: 0x8d97a5, roughness: 0.46, metallic: 0.72 }));
  const darkSteelMat = mat(new Material({ label: "beacon.darksteel", color: 0x3b4451, roughness: 0.62, metallic: 0.6 }));
  const coreMat = mat(new Material({ label: "beacon.core", color: 0x0d2a33, roughness: 0.25, metallic: 0.2, emissive: Color.fromSrgbHex(0x53e0ff), emissiveStrength: 3.4, fogExempt: true }));
  const lampMat = mat(new Material({ label: "beacon.lamp", color: 0x14100c, roughness: 0.4, emissive: Color.fromSrgbHex(0xffb457), emissiveStrength: 3.0, fogExempt: true }));
  const crateMat = mat(new Material({ label: "beacon.crate", color: 0x6b5637, roughness: 0.85, metallic: 0.12 }));
  const sparkMat = mat(new Material({ label: "beacon.spark", color: 0x000000, roughness: 1, emissive: Color.fromSrgbHex(0xffffff), emissiveStrength: 2.6, transparent: true, opacity: 1, depthWrite: false, fogExempt: true }));
  const tracerMat = mat(new Material({ label: "beacon.tracer", color: 0x000000, roughness: 1, emissive: Color.fromSrgbHex(0xffffff), emissiveStrength: 3.4, transparent: true, opacity: 1, depthWrite: false, fogExempt: true }));

  // ----------------------------------------------------------------------------------- the arena
  const place = (name: string, at: [number, number, number], geometry: Geometry, material: Material, castShadow: boolean, receiveShadow = true): EntityId => {
    const e = scene.createTransformedEntity(name, new Vec3(at[0], at[1], at[2]));
    const r = new Renderable();
    r.geometry = geometry;
    r.material = material;
    r.castShadow = castShadow;
    r.receiveShadow = receiveShadow;
    scene.world.addComponent(e.id, r);
    return e.id;
  };

  place("arena-floor", [0, -0.5, 0], groundGeo, groundMat, false);
  place("arena-outer", [0, -1.2, 0], outerGeo, outerMat, false);
  place("arena-rim", [0, 0.22, 0], rimGeo, rimMat, true);
  place("arena-spawn-ring", [0, 0.06, 0], spawnRingGeo, spawnRingMat, false, false);
  const rangeRing = place("turret-range-ring", [TURRET_AT.x, 0.08, TURRET_AT.z], rangeRingGeo, rangeRingMat, false, false);
  const reticle = place("aim-reticle", [0, FLIGHT_HEIGHT, 0], reticleGeo, reticleMat, false, false);
  scene.world.getComponent(reticle, Renderable)!.visible = false;

  // The beacon: the structure is static set dressing; the core is the entity the game damages.
  place("beacon-tower", [0, 0, 0], towerGeo, steelMat, true);
  const beacon = scene.createTransformedEntity("beacon", new Vec3(0, 0, 0));
  const beaconRenderable = new Renderable();
  beaconRenderable.geometry = coreGeo;
  beaconRenderable.material = coreMat;
  beaconRenderable.castShadow = true;
  scene.world.addComponent(beacon.id, beaconRenderable);
  scene.world.addComponent(beacon.id, new BeaconTag());

  place("turret-base", [TURRET_AT.x, 0, TURRET_AT.z], turretBaseGeo, darkSteelMat, true);
  const turret = scene.createTransformedEntity("turret", new Vec3(TURRET_AT.x, 1.55, TURRET_AT.z));
  const turretRenderable = new Renderable();
  turretRenderable.geometry = turretHeadGeo;
  turretRenderable.material = steelMat;
  turretRenderable.castShadow = true;
  scene.world.addComponent(turret.id, turretRenderable);
  scene.world.addComponent(turret.id, new TurretTag());

  // Rim pylons with lamps, and crates inside the arena: deterministic, so the set is reproducible.
  const PYLONS = 10;
  for (let i = 0; i < PYLONS; i++) {
    const a = (i / PYLONS) * Math.PI * 2 + 0.18;
    const x = Math.cos(a) * (ARENA_RADIUS + 1.4);
    const z = Math.sin(a) * (ARENA_RADIUS + 1.4);
    place(`pylon-${i}`, [x, 0, z], pylonGeo, darkSteelMat, true);
    place(`pylon-lamp-${i}`, [x, 0, z], lampGeo, lampMat, false, false);
  }
  const CRATES = 14;
  for (let i = 0; i < CRATES; i++) {
    // A phyllotaxis scatter that keeps the middle of the arena clear for the fight.
    const a = i * 2.399963;
    const r = 9 + 17 * Math.sqrt((i + 0.5) / CRATES);
    const id = place(`crate-${i}`, [Math.cos(a) * r, 0, Math.sin(a) * r], crateGeo, crateMat, true);
    const scale = 0.75 + ((i * 37) % 5) * 0.11;
    const transform = scene.world.getComponent(id, Transform)!;
    transform.setScale(scale, scale, scale);
    transform.setRotationEuler(0, a * 1.7, 0);
  }

  // -------------------------------------------------------------------------------------- lights
  const cameraEntity = scene.createTransformedEntity("camera", new Vec3(0, 36, -44));
  const camera = new Camera();
  camera.fovY = (60 * Math.PI) / 180;
  camera.near = 0.2;
  camera.far = 420;
  scene.world.addComponent(cameraEntity.id, camera);
  cameraEntity.transform.lookAt(new Vec3(0, 0, 0));

  const moon = scene.createTransformedEntity("moon", new Vec3(-26, 40, -22));
  const moonLight = new Light();
  moonLight.kind = "directional";
  moonLight.intensity = 1.5;
  moonLight.setColor(0.62, 0.74, 1.0);
  moonLight.castShadow = true;
  moonLight.shadowMapSize = tierValue(tier, { low: 1024, medium: 1536, high: 2048 });
  moonLight.cascades = scene.settings.shadow.cascades;
  scene.world.addComponent(moon.id, moonLight);
  moon.transform.lookAt(new Vec3(0, 0, 0));

  const beaconLamp = scene.createTransformedEntity("beacon-lamp", new Vec3(0, 3.2, 0));
  const beaconLight = new Light();
  beaconLight.kind = "point";
  beaconLight.intensity = 26;
  beaconLight.range = 30;
  beaconLight.setColor(0.36, 0.86, 1.0);
  beaconLight.castShadow = false;
  scene.world.addComponent(beaconLamp.id, beaconLight);

  const turretLamp = scene.createTransformedEntity("turret-lamp", new Vec3(TURRET_AT.x, 2.6, TURRET_AT.z));
  const turretLight = new Light();
  turretLight.kind = "point";
  turretLight.intensity = 9;
  turretLight.range = 14;
  turretLight.setColor(1.0, 0.72, 0.36);
  turretLight.castShadow = false;
  scene.world.addComponent(turretLamp.id, turretLight);

  // ===================================================================================== gameplay
  const runtime = ScriptRuntime.install(scene.world);
  const game = new GameState(tuning);
  game.beacon = beacon.id;
  const beaconScript = new Beacon(tuning);
  const turretScript = new Turret(game, tuning);
  const director = new WaveDirector(
    beacon.id,
    game,
    {
      drones: {
        scout: { geometry: droneGeometry.scout, material: droneMaterial.scout },
        splitter: { geometry: droneGeometry.splitter, material: droneMaterial.splitter },
        bruiser: { geometry: droneGeometry.bruiser, material: droneMaterial.bruiser },
        bomber: { geometry: droneGeometry.bomber, material: droneMaterial.bomber },
      },
    },
    tuning,
  );
  const directorEntity = scene.createEntity("wave-director").id;
  scene.world.addComponent(beacon.id, new ScriptComponent(beaconScript));
  scene.world.addComponent(turret.id, new ScriptComponent(turretScript));
  scene.world.addComponent(directorEntity, new ScriptComponent(director));
  const gameEntity = scene.createEntity("game-rules").id;
  scene.world.addComponent(gameEntity, new ScriptComponent(game));

  // --------------------------------------------------------------------------------------- effects
  const sim = new ParticleSimulation({
    capacity: tierValue(tier, { low: 900, medium: 1800, high: 2600 }),
    gravity: { x: 0, y: -6.4, z: 0 },
    drag: 1.15,
    seed: 21,
    maxEmitsPerFrame: 640,
  });
  // Bursts only. `ParticleSimulation` builds its emitter with a default rate of 40/s and offers no
  // option for it, so the rate is pinned here: an ambient stream would leak sparks no game event
  // asked for (ambient motes are the GPU particle world's job, not this sim's).
  sim.emitter.rate = 0;
  let burstsEmitted = 0;
  sim.claimOwner(scene, "beaconDefense.fx");
  const sparkPool = tierValue(tier, { low: 140, medium: 240, high: SPARK_POOL });
  const sparks: EntityId[] = [];
  for (let i = 0; i < sparkPool; i++) {
    const e = scene.createTransformedEntity(`fx-spark-${i}`, new Vec3(0, -80, 0));
    const r = new Renderable();
    r.geometry = sparkGeo;
    r.material = sparkMat;
    r.castShadow = false;
    r.receiveShadow = false;
    r.visible = false;
    r.transparent = true;
    r.order = 3;
    scene.world.addComponent(e.id, r);
    sparks.push(e.id);
  }

  interface Tracer {
    x: number;
    y: number;
    z: number;
    dirX: number;
    dirZ: number;
    reach: number;
    age: number;
    life: number;
    source: ShotSource;
  }
  const tracers: Tracer[] = [];
  const tracerPool: EntityId[] = [];
  for (let i = 0; i < TRACER_POOL; i++) {
    const e = scene.createTransformedEntity(`fx-tracer-${i}`, new Vec3(0, -80, 0));
    const r = new Renderable();
    r.geometry = tracerGeo;
    r.material = tracerMat;
    r.castShadow = false;
    r.receiveShadow = false;
    r.visible = false;
    r.transparent = true;
    r.order = 3;
    scene.world.addComponent(e.id, r);
    tracerPool.push(e.id);
  }

  const fx: Fx[] = [];
  const push = (item: Fx): void => {
    // A bounded queue: a volley must not be able to grow it without limit.
    if (fx.length < 256) fx.push(item);
  };
  const sound = (name: BeaconSound, at?: { x: number; y: number; z: number }, rate?: number, volume?: number): void => {
    push({ kind: "sound", name, x: at?.x, y: at?.y, z: at?.z, rate, volume });
  };
  const burst = (x: number, y: number, z: number, color: readonly [number, number, number], count: number, speed: number, life: number, size: number, spread = 0.3): void => {
    push({ kind: "burst", x, y, z, r: color[0], g: color[1], b: color[2], count, speed, life, size, spread });
  };

  // ------------------------------------------------------------------ game events → presentation
  let waveKillsBase = 0;
  let waveDrones = waveSpec(1).drones;
  let bannerTitle: string | null = null;
  let bannerText = "";
  let bannerFor = 0;
  const listeners: Array<{ dispose(): void }> = [];

  listeners.push(
    runtime.events.on(ShotFired, (e) => {
      const muzzleY = TURRET_AT.x === e.x ? 1.75 : e.y + 0.2;
      push({ kind: "tracer", x: e.x, y: muzzleY, z: e.z, dirX: e.dirX, dirZ: e.dirZ, reach: e.reach, source: e.source });
      burst(e.x + e.dirX * 1.6, muzzleY, e.z + e.dirZ * 1.6, e.source === "ai" ? [0.55, 0.9, 1] : [1, 0.78, 0.35], e.source === "ai" ? 5 : 9, 7, 0.16, 0.12, 0.5);
      sound(e.source === "ai" ? "shot" : "cannon", { x: e.x, y: muzzleY, z: e.z }, 0.94 + ((e.tick % 7) - 3) * 0.02);
      if (e.source === "player") push({ kind: "shake", amount: 0.16 });
    }),
  );
  listeners.push(
    runtime.events.on(DroneDown, (e) => {
      const color = SPARK_COLORS[e.kind];
      const heavy = e.kind === "bruiser" || e.kind === "bomber";
      burst(e.x, e.y, e.z, color, heavy ? 46 : 26, heavy ? 11 : 8, heavy ? 0.85 : 0.55, heavy ? 0.34 : 0.24, 0.45);
      burst(e.x, e.y, e.z, [1, 0.95, 0.8], heavy ? 14 : 8, heavy ? 6 : 4.5, 0.3, 0.18, 0.6);
      sound(heavy ? "explodeBig" : "explodeSmall", { x: e.x, y: e.y, z: e.z }, 0.92 + ((e.tick % 5) - 2) * 0.03);
      if (heavy) push({ kind: "shake", amount: 0.3 });
    }),
  );
  listeners.push(
    runtime.events.on(DroneLeaked, (e) => {
      burst(e.x, e.y, e.z, [1, 0.35, 0.2], 22, 9, 0.5, 0.28, 0.5);
    }),
  );
  listeners.push(
    runtime.events.on(BeaconDamaged, (e) => {
      burst(0, 2.6, 0, [1, 0.28, 0.2], 34, 10, 0.6, 0.3, 0.5);
      sound("beaconHit", { x: 0, y: 2.6, z: 0 });
      push({ kind: "shake", amount: 0.75 });
      if (e.hp > 0 && e.hp <= e.maxHp * 0.25) {
        push({ kind: "banner", title: "INTEGRITY CRITICAL", text: `${Math.round(e.hp)} / ${Math.round(e.maxHp)} — repair or fall back`, seconds: 2.4 });
      }
    }),
  );
  listeners.push(
    runtime.events.on(BeaconRepaired, (e) => {
      burst(0, 2.8, 0, [0.55, 1, 0.72], 26, 5.5, 0.7, 0.24, 0.6);
      sound("repair", { x: 0, y: 2.8, z: 0 });
      push({ kind: "toast", message: `Beacon repaired +${Math.round(e.amount)} integrity`, tone: "success" });
    }),
  );
  listeners.push(
    runtime.events.on(WaveStarted, (e) => {
      waveKillsBase = game.kills;
      waveDrones = e.drones;
      push({ kind: "banner", title: `WAVE ${e.wave} INCOMING`, text: `${e.drones} drones · armour ×${e.hpScale.toFixed(2)}`, seconds: 2.6 });
      sound("waveStart");
    }),
  );
  listeners.push(
    runtime.events.on(WaveCleared, (e) => {
      push({ kind: "banner", title: `WAVE ${e.wave} CLEARED`, text: `+${e.bonus} credits — upgrade before the next wave`, seconds: 3.2 });
      push({ kind: "toast", message: `Wave ${e.wave} cleared · +${e.bonus}¢`, tone: "success" });
      sound("waveClear");
    }),
  );
  listeners.push(
    runtime.events.on(GameOver, (e) => {
      push({ kind: "banner", title: "BEACON LOST", text: `wave ${e.wave} · score ${e.score} · ${e.kills} kills`, seconds: 6 });
      push({ kind: "shake", amount: 1.4 });
      burst(0, 2.4, 0, [1, 0.4, 0.15], 90, 14, 1.3, 0.45, 0.7);
      sound("gameOver");
    }),
  );
  listeners.push(
    runtime.events.on(GameWon, (e) => {
      push({ kind: "banner", title: "BEACON HELD", text: `all ${FINAL_WAVE} waves down · score ${e.score}`, seconds: 8 });
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2;
        burst(Math.cos(a) * 7, 3.4, Math.sin(a) * 7, [0.45, 0.95, 1], 40, 9, 1.2, 0.32, 0.6);
      }
      sound("victory");
    }),
  );
  listeners.push(
    runtime.events.on(UpgradeBought, (e) => {
      const def = UPGRADE_BY_ID[e.id];
      push({ kind: "toast", message: `${def.name} → level ${e.level} (−${e.cost}¢)`, tone: "success" });
      sound("purchase");
      burst(TURRET_AT.x, 2.1, TURRET_AT.z, [0.6, 1, 0.85], 16, 5, 0.5, 0.2, 0.5);
      if (e.id === "range") syncRangeRing();
    }),
  );
  listeners.push(
    runtime.events.on(PurchaseRefused, (e) => {
      const reason = e.reason === "credits" ? "not enough credits" : e.reason === "cooldown" ? "still cooling down" : e.reason === "maxLevel" ? "already at max level" : "the run is over";
      push({ kind: "toast", message: `${e.id}: ${reason}`, tone: "warning" });
      sound("refuse");
    }),
  );
  listeners.push(
    runtime.events.on(GameRestart, () => {
      waveKillsBase = 0;
      waveDrones = waveSpec(1).drones;
      tracers.length = 0;
      syncRangeRing();
    }),
  );
  listeners.push(
    runtime.events.on(AbilityUsed, (e) => {
      if (e.id === "emp") {
        // The pulse reads as a ring of cold sparks sweeping out from the beacon.
        for (let i = 0; i < 10; i++) {
          const a = (i / 10) * Math.PI * 2;
          burst(Math.cos(a) * 9, 1.6, Math.sin(a) * 9, [0.45, 0.8, 1], 16, 12, 0.6, 0.26, 0.5);
        }
        sound("emp");
        push({ kind: "shake", amount: 0.35 });
        push({ kind: "toast", message: "EMP pulse — every drone slowed", tone: "info" });
      } else if (e.id === "overcharge") {
        burst(TURRET_AT.x, 2.2, TURRET_AT.z, [1, 0.85, 0.3], 34, 8, 0.7, 0.3, 0.5);
        sound("overcharge");
        push({ kind: "toast", message: "Overcharge — 2.5× damage, twice the rate", tone: "info" });
      } else {
        // The repair's own event carries the numbers; the sound and sparks belong to the ability.
        sound("repair");
      }
    }),
  );

  const syncRangeRing = (): void => {
    const transform = scene.world.getComponent(rangeRing, Transform);
    if (!transform) return;
    const k = game.aiRange() / tuning.aiRange;
    transform.setScale(k, 1, k);
  };
  syncRangeRing();

  // ========================================================================================== UI
  const dpr = Math.min(2, (globalThis as { devicePixelRatio?: number }).devicePixelRatio || 1);
  const ui = new UIManager({
    width: canvas?.width || 1280,
    height: canvas?.height || 720,
    devicePixelRatio: dpr,
  });
  const worldCamera: WorldCamera & { viewProj: Float32Array; position: WorldPoint } = { viewProj: new Float32Array(16), position: { x: 0, y: 0, z: 0 } };
  const beaconPoint: WorldPoint = { x: 0, y: 7.2, z: 0 };

  // -------------------------------------------------------------------------------------- input
  let pendingAim: { x: number; z: number } | null = null;
  let aimPlayer = false;
  let firing = false;
  let fireQueued = false;
  let cameraMode: BeaconCameraMode = "arena";
  let paused = options.paused ?? false;
  let shake = 0;
  let manualShotsSeen = 0;

  const command = {
    aimAt: (x: number, z: number): void => {
      pendingAim = { x, z };
      aimPlayer = true;
    },
    fire: (): void => {
      fireQueued = true;
      firing = true;
    },
  };

  const hud: BeaconHud = buildBeaconHud(ui, {
    ability: (id) => runtime.events.post(UseAbility, { id }),
    upgrade: (id) => runtime.events.post(BuyUpgrade, { id }),
    callWave: () => runtime.events.post(CallWave, undefined),
    restart: () => runtime.events.post(GameRestart, undefined),
    pause: () => setPaused(!paused),
  }, {
    camera: () => worldCamera,
    beacon: () => beaconPoint,
  });

  const uiRenderer = new UIGpuRenderer(engine.gpu, ui);
  const uiOverlay = engine.renderer ? engine.renderer.addOverlay(uiRenderer) : null;
  const input: DomInputHandle | null = canvas ? attachDomInput(canvas, ui.router, ui.viewport, { exclusive: false }) : null;

  // Pointer aim and fire. Registered before the UI's adapter so a drag over the arena is seen by both;
  // a pointer over a widget is the UI's (`ui.hitTest`) and never fires the cannon.
  const domListeners: Array<[EventTarget, string, EventListener]> = [];
  const on = (target: EventTarget | null | undefined, type: string, fn: (event: Event) => void): void => {
    if (!target) return;
    const listener = fn as EventListener;
    target.addEventListener(type, listener);
    domListeners.push([target, type, listener]);
  };
  const invVp = new Mat4();
  const v4a = new Float32Array(4);
  const v4b = new Float32Array(4);

  /** Unproject a pointer position onto the flight plane. `null` when the UI owns the pointer. */
  const aimFromPointer = (clientX: number, clientY: number): { x: number; z: number } | null => {
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const w = Math.max(1, rect.width);
    const h = Math.max(1, rect.height);
    const sx = (canvas.width || w) / w;
    const sy = (canvas.height || h) / h;
    const logicalX = ((clientX - rect.left) * sx) / ui.viewport.scale;
    const logicalY = ((clientY - rect.top) * sy) / ui.viewport.scale;
    if (ui.hitTest(logicalX, logicalY)) return null;
    const ndcX = ((clientX - rect.left) / w) * 2 - 1;
    const ndcY = 1 - ((clientY - rect.top) / h) * 2;
    invVp.copyFrom(camera.viewProjection);
    if (!invVp.invert()) return null;
    invVp.transformVec4(ndcX, ndcY, 0, 1, v4a);
    invVp.transformVec4(ndcX, ndcY, 1, 1, v4b);
    if (Math.abs(v4a[3]!) < 1e-6 || Math.abs(v4b[3]!) < 1e-6) return null;
    const p0 = { x: v4a[0]! / v4a[3]!, y: v4a[1]! / v4a[3]!, z: v4a[2]! / v4a[3]! };
    const p1 = { x: v4b[0]! / v4b[3]!, y: v4b[1]! / v4b[3]!, z: v4b[2]! / v4b[3]! };
    const dy = p1.y - p0.y;
    if (Math.abs(dy) < 1e-6) return null;
    const t = (FLIGHT_HEIGHT - p0.y) / dy;
    if (t <= 0 || t > 1e6) return null;
    return { x: p0.x + (p1.x - p0.x) * t, z: p0.z + (p1.z - p0.z) * t };
  };

  on(canvas, "pointermove", (event) => {
    const e = event as PointerEvent;
    const aim = aimFromPointer(e.clientX, e.clientY);
    if (!aim) return;
    command.aimAt(aim.x, aim.z);
  });
  on(canvas, "pointerdown", (event) => {
    const e = event as PointerEvent;
    if (e.pointerType === "mouse" && e.button !== 0) return;
    const aim = aimFromPointer(e.clientX, e.clientY);
    if (!aim) return;
    e.preventDefault();
    command.aimAt(aim.x, aim.z);
    firing = true;
    fireQueued = true;
    unlockAudio();
  });
  const stopFiring = (): void => {
    firing = false;
  };
  on(canvas, "pointerup", stopFiring);
  on(canvas, "pointercancel", stopFiring);
  on(canvas, "pointerleave", stopFiring);

  const ABILITY_KEYS: Readonly<Record<string, AbilityId>> = { Digit1: "emp", Digit2: "overcharge", Digit3: "repair" };
  const UPGRADE_KEYS: Readonly<Record<string, UpgradeId>> = {};
  UPGRADES.forEach((u, i) => {
    (UPGRADE_KEYS as Record<string, UpgradeId>)[`Digit${i + 4}`] = u.id;
  });

  const onKeyDown = (event: Event): void => {
    const e = event as KeyboardEvent;
    const code = e.code;
    if (code === "Space") {
      e.preventDefault();
      firing = true;
      fireQueued = true;
      unlockAudio();
      return;
    }
    const ability = ABILITY_KEYS[code];
    if (ability) {
      e.preventDefault();
      runtime.events.post(UseAbility, { id: ability });
      unlockAudio();
      return;
    }
    const upgrade = UPGRADE_KEYS[code];
    if (upgrade) {
      e.preventDefault();
      runtime.events.post(BuyUpgrade, { id: upgrade });
      unlockAudio();
      return;
    }
    switch (code) {
      case "KeyC":
        cycleCamera();
        break;
      case "KeyP":
      case "Escape":
        setPaused(!paused);
        break;
      case "KeyR":
        restart();
        break;
      case "KeyM":
        setSound(!soundOn);
        break;
      case "Enter":
      case "NumpadEnter":
        runtime.events.post(CallWave, undefined);
        break;
      default:
        return;
    }
    unlockAudio();
  };
  const onKeyUp = (event: Event): void => {
    if ((event as KeyboardEvent).code === "Space") firing = false;
  };
  const win = (globalThis as { window?: EventTarget }).window;
  on(win, "keydown", onKeyDown);
  on(win, "keyup", onKeyUp);

  // --------------------------------------------------------------------------------------- audio
  let audio: { mixer: AudioSystem; context: AudioContext; owned: boolean } | null = null;
  let soundscape: BeaconSoundscape | null = null;
  let soundOn = false;

  const defaultAudioContext = (): AudioContext | null => {
    const Ctor =
      (globalThis as { AudioContext?: typeof AudioContext }).AudioContext ??
      (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    try {
      return new Ctor();
    } catch {
      return null;
    }
  };

  const setSound = (on: boolean): boolean => {
    if (on && !audio) {
      const context = options.createAudioContext ? options.createAudioContext() : defaultAudioContext();
      if (!context) return false;
      const owned = !options.createAudioContext;
      const mixer = new AudioSystem({ context, maxVoices: 18, masterVolume: 0.9 });
      audio = { mixer, context, owned };
      soundscape = new BeaconSoundscape(mixer, context, { volume: 0.85 });
    }
    soundOn = on && audio !== null;
    if (audio) {
      // Never chain behaviour behind these: a headless context can leave resume() pending.
      try {
        void (soundOn ? audio.context.resume() : audio.context.suspend())?.catch?.(() => {});
      } catch {
        /* a context that refuses to change state simply stays as it is */
      }
    }
    return soundOn;
  };
  /** Browsers need a gesture: the first pointer or key press turns sound on if it was asked for. */
  let wantedSound = options.sound ?? false;
  const unlockAudio = (): void => {
    if (!wantedSound || soundOn) return;
    setSound(true);
  };

  // ---------------------------------------------------------------------------------- presentation
  const burstAt = (item: Extract<Fx, { kind: "burst" }>): void => {
    const emitter = sim.emitter;
    emitter.position.x = item.x;
    emitter.position.y = item.y;
    emitter.position.z = item.z;
    emitter.jitter.x = item.spread;
    emitter.jitter.y = item.spread;
    emitter.jitter.z = item.spread;
    emitter.cone.direction.x = 0;
    emitter.cone.direction.y = 1;
    emitter.cone.direction.z = 0;
    // A full sphere: `sampleCone` with a half-angle of π covers every direction.
    emitter.cone.angle = Math.PI;
    emitter.cone.speedMin = item.speed * 0.35;
    emitter.cone.speedMax = item.speed;
    emitter.lifeMin = item.life * 0.55;
    emitter.lifeMax = item.life;
    emitter.size = item.size;
    emitter.color.r = item.r;
    emitter.color.g = item.g;
    emitter.color.b = item.b;
    emitter.color.a = 1;
    // `emit` accumulates `rate * dt`: one sixtieth of a second at `count * 60` spawns exactly `count`.
    // Emitting straight at the emitter (rather than through `sim.step`) is what makes a burst exact;
    // the sim's own counter only tracks its rate-driven stream, so the scene keeps its own tally.
    emitter.rate = item.count * 60;
    burstsEmitted += emitter.emit(sim.state, 1 / 60, item.count);
    emitter.rate = 0;
  };

  const addTracer = (item: Extract<Fx, { kind: "tracer" }>): void => {
    if (tracers.length >= TRACER_POOL) tracers.shift();
    tracers.push({ x: item.x, y: item.y, z: item.z, dirX: item.dirX, dirZ: item.dirZ, reach: item.reach, age: 0, life: item.source === "player" ? 0.11 : 0.08, source: item.source });
  };

  const eye = new Vec3();
  const target = new Vec3();
  let shakePhase = 0;
  const sparkTransforms: Array<{ transform: Transform; renderable: Renderable }> = [];
  for (const id of sparks) {
    const transform = scene.world.getComponent(id, Transform)!;
    const renderable = scene.world.getComponent(id, Renderable)!;
    sparkTransforms.push({ transform, renderable });
  }
  const tracerTransforms: Array<{ transform: Transform; renderable: Renderable }> = [];
  for (const id of tracerPool) {
    tracerTransforms.push({ transform: scene.world.getComponent(id, Transform)!, renderable: scene.world.getComponent(id, Renderable)! });
  }

  const poseSparks = (): void => {
    const state = sim.state;
    const capacity = state.length / PARTICLE_FLOATS;
    let used = 0;
    for (let i = 0; i < capacity && used < sparkTransforms.length; i++) {
      if (!isAlive(state, i)) continue;
      const o = i * PARTICLE_FLOATS;
      const age = state[o + P_AGE]!;
      const maxLife = Math.max(1e-6, state[o + P_MAX_LIFE]!);
      const t = Math.min(1, age / maxLife);
      const sprite = sparkTransforms[used++]!;
      sprite.transform.setPosition(state[o + P_X]!, state[o + P_Y]!, state[o + P_Z]!);
      const size = Math.max(0.01, state[o + P_SIZE]! * (1 - 0.55 * t));
      sprite.transform.setScale(size, size, size);
      const alpha = Math.max(0, 1 - t * t) * state[o + P_A]!;
      sprite.renderable.tint = packColorRGBA(state[o + P_R]!, state[o + P_G]!, state[o + P_B]!, alpha);
      sprite.renderable.visible = alpha > 0.01;
    }
    for (let s = used; s < sparkTransforms.length; s++) {
      const sprite = sparkTransforms[s]!;
      if (sprite.renderable.visible) sprite.renderable.visible = false;
    }
  };

  const poseTracers = (): void => {
    for (let i = 0; i < tracerTransforms.length; i++) {
      const slot = tracerTransforms[i]!;
      const tracer = tracers[i];
      if (!tracer || tracer.age >= tracer.life) {
        if (slot.renderable.visible) slot.renderable.visible = false;
        continue;
      }
      const k = 1 - tracer.age / tracer.life;
      const length = Math.max(0.4, tracer.reach);
      const endX = tracer.x + tracer.dirX * length;
      const endZ = tracer.z + tracer.dirZ * length;
      slot.transform.setPosition(tracer.x + tracer.dirX * length * 0.5, tracer.y, tracer.z + tracer.dirZ * length * 0.5);
      slot.transform.lookAt(target.set(endX, tracer.y, endZ));
      slot.transform.setScale(1, 1, length);
      const color = tracer.source === "player" ? [1, 0.78, 0.34] : [0.55, 0.92, 1];
      slot.renderable.tint = packColorRGBA(color[0]!, color[1]!, color[2]!, Math.max(0, k));
      slot.renderable.visible = k > 0.02;
    }
  };

  const hudSnapshot = (): BeaconHudSnapshot => {
    const tick = game.tick;
    const beaconTag = scene.world.getComponent(beacon.id, BeaconTag);
    const hp = beaconTag ? beaconTag.hp : beaconScript.hp;
    const maxHp = beaconTag ? beaconTag.maxHp : beaconScript.maxHp;
    const drones = scene.world.store(DroneTag);
    const markers: BeaconHudSnapshot["markers"] = [];
    let threat: BeaconHudSnapshot["threat"] = null;
    let threatDistance = Infinity;
    for (let i = 0; i < drones.count; i++) {
      const tag = drones.valueAt(i);
      const p = scene.world.getComponent(tag.entity, Transform)!.position;
      markers.push({ x: p.x, z: p.z, kind: tag.kind, slowed: tag.slowed === 1 });
      const d = Math.hypot(p.x, p.z);
      if (d < threatDistance) {
        threatDistance = d;
        threat = { name: DRONE_SPECS[tag.kind].label, hp: tag.hp, maxHp: tag.maxHp, level: Math.max(1, game.wave) };
      }
    }
    const intermission = game.intermissionUntil >= 0 && !game.finished;
    return {
      wave: Math.max(1, game.wave),
      finalWave: FINAL_WAVE,
      phase: game.gameOver ? "gameover" : game.won ? "won" : intermission ? "intermission" : "combat",
      intermissionLeft: intermission ? Math.max(0, (game.intermissionUntil - tick) / 60) : 0,
      score: game.score,
      credits: game.credits,
      kills: game.kills,
      leaks: game.leaks,
      drones: drones.count,
      waveDrones,
      waveKills: Math.max(0, game.kills - waveKillsBase),
      beaconHp: hp,
      beaconMaxHp: maxHp,
      turret: {
        damage: game.turretDamage(tick),
        cannonDamage: game.cannonDamage(tick),
        aiInterval: game.aiFireSteps(tick) / 60,
        manualInterval: game.manualFireSteps() / 60,
        range: game.manualRange(),
        targets: game.targets(),
        shots: turretScript.shots,
        manualShots: turretScript.manualShots,
        hits: turretScript.hits,
      },
      upgrades: UPGRADES.map((u) => {
        const level = game.upgrades[u.id];
        const cost = game.costOf(u.id);
        return { id: u.id, name: u.name, level, maxLevel: u.maxLevel, cost, affordable: cost !== null && game.credits >= cost && !game.finished, hotkey: u.hotkey };
      }),
      abilities: ABILITIES.map((a) => {
        const left = game.cooldowns[a.id];
        const active = (a.id === "emp" && game.empActive(tick)) || (a.id === "overcharge" && game.overchargeActive(tick));
        return {
          id: a.id,
          name: a.name,
          icon: a.icon,
          hotkey: a.hotkey,
          cost: a.cost,
          cooldownLeft: stepsToSeconds(left),
          cooldownTotal: stepsToSeconds(a.cooldownSteps),
          affordable: left === 0 && game.credits >= a.cost && !game.finished,
          active,
        };
      }),
      markers,
      arenaRadius: ARENA_RADIUS + 3,
      threat,
      banner: bannerTitle ? { title: bannerTitle, text: bannerText } : null,
      end: game.finished ? { won: game.won, wave: Math.max(1, game.wave), score: game.score, kills: game.kills, leaks: game.leaks, games: game.games } : null,
      hint: paused
        ? { key: "P", action: "Resume" }
        : manualShotsSeen === 0
          ? { key: "Space", action: "Fire the cannon · drag to aim" }
          : null,
      paused,
    };
  };

  const setPaused = (on: boolean): void => {
    paused = on;
    // Freezing the engine's clock stops the fixed steps, which is where all gameplay lives.
    if (engine.clock) engine.clock.paused = on;
  };

  const restart = (): void => {
    runtime.events.post(GameRestart, undefined);
  };

  const setCameraMode = (mode: BeaconCameraMode): void => {
    cameraMode = mode;
  };
  const cycleCamera = (): BeaconCameraMode => {
    const next = CAMERA_MODES[(CAMERA_MODES.indexOf(cameraMode) + 1) % CAMERA_MODES.length]!;
    cameraMode = next;
    return next;
  };

  const cameraOverride = (): { eye: [number, number, number]; target: [number, number, number] } => {
    const shakeX = shake > 0.001 ? (Math.sin(shakePhase * 3.1) * shake) : 0;
    const shakeY = shake > 0.001 ? (Math.cos(shakePhase * 2.3) * shake) : 0;
    if (cameraMode === "turret") {
      const yaw = scene.world.getComponent(turret.id, TurretTag)?.yaw ?? 0;
      const fx = Math.sin(yaw);
      const fz = Math.cos(yaw);
      eye.set(TURRET_AT.x - fx * 4.2 + shakeX, 3.1 + shakeY, TURRET_AT.z - fz * 4.2);
      target.set(TURRET_AT.x + fx * 14, FLIGHT_HEIGHT + 0.4, TURRET_AT.z + fz * 14);
    } else if (cameraMode === "top") {
      eye.set(shakeX, 62 + shakeY, 0.01);
      target.set(0, 0, 0);
    } else {
      eye.set(shakeX, 36 + shakeY, -44);
      target.set(0, 1.2, 2);
    }
    return { eye: [eye.x, eye.y, eye.z], target: [target.x, target.y, target.z] };
  };

  const update = (dt: number): void => {
    // Input first, so a shot asked for this frame leaves on the next fixed step.
    if (pendingAim) {
      runtime.events.post(PlayerAim, pendingAim);
      pendingAim = null;
    }
    if (fireQueued || firing) {
      fireQueued = false;
      runtime.events.post(PlayerFire, undefined);
    }

    const step = paused ? 0 : Math.min(0.05, Math.max(0, dt));
    if (step > 0) {
      for (let i = 0; i < fx.length; i++) {
        const item = fx[i]!;
        switch (item.kind) {
          case "burst":
            burstAt(item);
            break;
          case "tracer":
            addTracer(item);
            break;
          case "sound":
            if (soundOn && soundscape) {
              soundscape.play(item.name, {
                at: item.x !== undefined ? { x: item.x, y: item.y ?? 0, z: item.z ?? 0 } : undefined,
                rate: item.rate,
                volume: item.volume,
              });
            }
            break;
          case "shake":
            shake = Math.min(1.6, shake + item.amount);
            break;
          case "toast":
            hud.toast(item.message, item.tone);
            break;
          case "banner":
            bannerTitle = item.title;
            bannerText = item.text;
            bannerFor = item.seconds;
            break;
        }
      }
      fx.length = 0;
      sim.step(step);
      for (const tracer of tracers) tracer.age += step;
      while (tracers.length > 0 && tracers[0]!.age >= tracers[0]!.life) tracers.shift();
      shake = Math.max(0, shake - step * 2.6);
      shakePhase += step * 42;
      if (bannerFor > 0) {
        bannerFor -= step;
        if (bannerFor <= 0) bannerTitle = null;
      }
      manualShotsSeen = turretScript.manualShots;
    }
    poseSparks();
    poseTracers();

    // The reticle follows the player's aim while the player is driving the barrel.
    const reticleRenderable = scene.world.getComponent(reticle, Renderable)!;
    const aiming = aimPlayer && !game.finished;
    reticleRenderable.visible = aiming;
    if (aiming) {
      const yaw = scene.world.getComponent(turret.id, TurretTag)?.yaw ?? 0;
      const distance = Math.hypot(turretScript.aimX - TURRET_AT.x, turretScript.aimZ - TURRET_AT.z);
      const reticleTransform = scene.world.getComponent(reticle, Transform)!;
      reticleTransform.setPosition(TURRET_AT.x + Math.sin(yaw) * distance, FLIGHT_HEIGHT, TURRET_AT.z + Math.cos(yaw) * distance);
      const pulse = 1 + 0.06 * Math.sin(shakePhase * 0.4);
      reticleTransform.setScale(pulse, 1, pulse);
    }

    // The world-space label projects with the camera the renderer used last frame.
    worldCamera.position.x = camera.positionRender.x;
    worldCamera.position.y = camera.positionRender.y;
    worldCamera.position.z = camera.positionRender.z;
    worldCamera.viewProj.set(camera.viewProjection.m);

    hud.update(hudSnapshot());
    if (canvas && (canvas.width !== ui.viewport.physicalWidth || canvas.height !== ui.viewport.physicalHeight)) {
      ui.setViewport(canvas.width, canvas.height, dpr);
    }
    input?.pollGamepads();
    ui.update(step);
    if (soundOn && soundscape) {
      const pose = cameraOverride();
      const fx0 = pose.target[0] - pose.eye[0];
      const fy0 = pose.target[1] - pose.eye[1];
      const fz0 = pose.target[2] - pose.eye[2];
      const len = Math.hypot(fx0, fy0, fz0) || 1;
      soundscape.setListener({ x: pose.eye[0], y: pose.eye[1], z: pose.eye[2] }, { x: fx0 / len, y: fy0 / len, z: fz0 / len });
    }
  };

  const state = (): BeaconSnapshot => {
    const snapshot = hudSnapshot();
    const tag = scene.world.getComponent(turret.id, TurretTag);
    return {
      wave: snapshot.wave,
      finalWave: snapshot.finalWave,
      phase: snapshot.phase,
      intermissionLeft: snapshot.intermissionLeft,
      score: snapshot.score,
      credits: snapshot.credits,
      kills: snapshot.kills,
      leaks: snapshot.leaks,
      drones: snapshot.drones,
      waveDrones: snapshot.waveDrones,
      waveKills: snapshot.waveKills,
      beaconHp: snapshot.beaconHp,
      beaconMaxHp: snapshot.beaconMaxHp,
      gameOver: game.gameOver,
      won: game.won,
      games: game.games,
      paused,
      soundOn,
      cameraMode,
      aim: { x: turretScript.aimX, z: turretScript.aimZ, player: aimPlayer },
      turret: { ...snapshot.turret, yaw: tag?.yaw ?? 0 },
      upgrades: { ...game.upgrades },
      upgradeCosts: {
        damage: game.costOf("damage"),
        rate: game.costOf("rate"),
        range: game.costOf("range"),
        multishot: game.costOf("multishot"),
        shield: game.costOf("shield"),
        cooling: game.costOf("cooling"),
      },
      abilities: {
        emp: abilityState("emp"),
        overcharge: abilityState("overcharge"),
        repair: abilityState("repair"),
      },
      empActive: game.empActive(game.tick),
      overchargeActive: game.overchargeActive(game.tick),
      fx: { sparks: sim.alive, emitted: burstsEmitted + sim.emitted, tracers: tracers.length, capacity: sim.capacity },
      hud: { widgets: hud.widgets, elements: ui.lastFrame.elements, toasts: ui.openOverlayElements.length },
      scripts: runtime.stats(),
      lastError: runtime.lastError ? `${runtime.lastError.script} ${runtime.lastError.phase}: ${runtime.lastError.message}` : null,
      killTicks: [...game.killTicks],
      banner: bannerTitle,
    };
  };

  const abilityState = (id: AbilityId): { cooldownSteps: number; cooldownSeconds: number; ready: boolean; cost: number; active: boolean } => {
    const left = game.cooldowns[id];
    const def = ABILITY_BY_ID[id];
    return {
      cooldownSteps: left,
      cooldownSeconds: stepsToSeconds(left),
      ready: left === 0,
      cost: def.cost,
      active: (id === "emp" && game.empActive(game.tick)) || (id === "overcharge" && game.overchargeActive(game.tick)),
    };
  };

  if (options.sound) wantedSound = true;
  if (paused) setPaused(true);

  return {
    scene,
    cameraEntity,
    runtime,
    ui,
    hud,
    game,
    update,
    state,
    aimAt: command.aimAt,
    fire: command.fire,
    useAbility: (id) => runtime.events.post(UseAbility, { id }),
    buyUpgrade: (id) => runtime.events.post(BuyUpgrade, { id }),
    callWave: () => runtime.events.post(CallWave, undefined),
    restart,
    setPaused,
    setCameraMode,
    cycleCamera,
    setSound,
    camera: { keyboard: false, distance: 58, minDistance: 12, maxDistance: 120, target: new Vec3(0, 1, 0) },
    cameraOverride,
    controlsHint:
      "Drag to aim · Space / click fires the cannon · 1-3 abilities · 4-9 upgrades · Enter calls the next wave · C camera · P pause · R restart · M sound",
    overlay: () => {
      const s = state();
      return (
        `BEACON DEFENSE  wave ${s.wave}/${s.finalWave}  ${s.phase}  score ${s.score}  credits ${s.credits}  kills ${s.kills}  leaks ${s.leaks}\n` +
        `beacon ${Math.round(s.beaconHp)}/${Math.round(s.beaconMaxHp)}  drones ${s.drones}  turret ${s.turret.damage.toFixed(1)} dmg / ${s.turret.aiInterval.toFixed(2)} s  cannon ${s.turret.cannonDamage.toFixed(1)} dmg / ${s.turret.manualInterval.toFixed(2)} s  hits ${s.turret.hits}/${s.turret.shots}\n` +
        `sparks ${s.fx.sparks} alive (${s.fx.emitted} emitted)  tracers ${s.fx.tracers}  ui ${s.hud.elements} el / ${s.hud.widgets} widgets  scripts ${s.scripts.scriptsActive} active · ${s.scripts.eventsDelivered} events` +
        `${s.lastError ? `\nscript error: ${s.lastError}` : ""}`
      );
    },
    dispose: () => {
      for (const listener of listeners.splice(0)) listener.dispose();
      for (const [target, type, listener] of domListeners.splice(0)) target.removeEventListener(type, listener);
      if (paused && engine.clock) engine.clock.paused = false;
      input?.dispose();
      hud.dispose();
      uiOverlay?.dispose();
      uiRenderer.dispose();
      ui.dispose();
      soundscape?.dispose();
      if (audio) {
        if (audio.owned) void audio.mixer.dispose().catch(() => {});
        audio = null;
      }
      runtime.dispose();
      scene.dispose();
      for (const g of geometries.splice(0)) g.dispose();
      for (const m of materials.splice(0)) m.dispose();
    },
  };
}
