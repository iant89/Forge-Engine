/**
 * Mars Dust Storm Survival (fe-16): drive the Perseverance build through the worst storm the
 * demo can render, reaching sky-light beams in sequence before the dust buries you.
 *
 * - Rover, streamed terrain, chase framing and drive input come from `marsShared.ts` (D7), so the
 *   rover handles exactly like the Mars Showcase. The heightfield is never edited (D1).
 * - The storm is the deterministic model in `dustStorm.ts`: gust cycles with lulls (D8) drive
 *   fog density/colour, the dust-sky background, sun and ambient light, particle rates and how
 *   fast dust piles up. Course and devils use a fixed seed (D4).
 * - Dust piles (D1/D2): mound meshes lean on the windward face of every boulder and grow with the
 *   storm; the rover's own mounds grow while it stays put. At `BURIAL_STUCK` the difficulty decides
 *   (D3): easy holds the rover until throttle pumping digs it free and adds a time penalty, hard
 *   sends it back to the last reached beam. Devils that leave it on its side follow the same rule.
 * - Dust devils (D5) push, yaw, lift and can flip the rover through `devilRoverForce`.
 * - Particles: the camera-centred storm sheet is one GPU particle system and every dust devil slot
 *   owns another (the renderer simulates and draws all of them), each with its own attractor and
 *   tangential `swirlStrength` centred on its devil, so every column visibly spins.
 * - Beams: tall emissive cylinders with a fog-exempt material, so they read through any density.
 *   The active beam is bright, the next one dim, reached beams switch off.
 * - Quality (D6): `reduced` (iOS Safari, 30 fps target) or `full` (desktop WebGPU) tier.
 *
 * Controls: WASD / arrows + the on-screen stick drive, Space handbrake, R restarts the run.
 */

import {
  AtmosphereModel,
  Camera,
  Color,
  MARS_ATMOSPHERE,
  Mat4,
  type Engine,
  type Entity,
  Geometry,
  GpuParticleWorld,
  Light,
  Material,
  Texture,
  Quat,
  Renderable,
  Rng,
  Scene,
  Vec3,
  VehicleComponent,
  VehicleSystem,
  createAtmosphere,
  createCylinder,
  createSphere,
  createRock,
  heightFunctionGround,
  stormLightFactors,
  AdaptiveDeviceQuality,
  readDeviceCapabilityHints,
  type DeviceCapabilityHints,
  type DeviceTier,
} from "@forge/engine";
import type { DemoSceneHandle } from "./cubesScene.js";
import { attachVehicleTouch } from "../controls/vehicleTouch.js";
import { DiscoJingle } from "../audio/discoJingle.js";
import { loadGlb, type GlbPart, type LoadedGlb } from "../assets/glb.js";
import { STAGE_LIGHT_COUNT, STAGE_TRUSS_HEIGHT, SUSPENSION_PIVOTS, armPieceForWheel, stageLightAim, stageLightColor, splitSuspension, suspensionArmPose, type SuspensionArmPiece } from "./roverDance.js";
import {
  MARS_CHASE_LOOK_OFFSET_Y,
  MARS_ROVER_WHEELS,
  attachStaticRoverModel,
  createMarsRoverVehicle,
  createMarsTerrain,
  marsChaseCamera,
  marsChaseFollow,
  readMarsDriveInput,
} from "./marsShared.js";
import {
  BURIAL_FREE,
  BURIAL_STUCK,
  DustAccumulation,
  DustDevilField,
  DRIFT_LIFT,
  WaypointArrowState,
  beamPulse,
  waypointArrowEnabled,
  ARROW_IN_MARGIN,
  ARROW_OUT_MARGIN,
  buildArrowMesh,
  buildDrapedRing,
  guidePathEnabled,
  DRIFT_VERTEX_COUNT,
  driftFootprintGrowth,
  devilFunnelHeight,
  buildFunnelCard,
  devilCardPixels,
  devilCardOpacity,
  devilShellFade,
  CARD_VERTEX_COUNT,
  DEVIL_CORE_OPACITY,
  DEVIL_CORE_CARD_WIDTH,
  type FunnelMesh,
  STORM_DUST_PALETTE,
  STORM_SHEET_LOOK,
  buildDriftMoundMesh,
  devilEnvelope,
  devilParticleLook,
  devilEmitRate,
  devilBaseWind,
  DEVIL_BASE_CLOUD,
  devilVortexLife,
  DEVIL_BURST_TIME,
  type DevilParticleLook,
  DEVIL_DUST_GRAVITY,
  DEVIL_DUST_DRAG,
  settleDriftMound,
  type DriftMoundMesh,
  type DustDevil,
  LULL_INTENSITY,
  STORM_DIFFICULTY,
  STORM_DIFFICULTIES,
  STORM_QUALITY_TIERS,
  STORM_SEED,
  StormCourse,
  StormField,
  devilRoverForceAt,
  stormWindAccel,
  BlownAwayTracker,
  StormRunStats,
  stormRunSummary,
  ROVER_SIDE_Q,
  DEVIL_INFLOW_FRACTION,
  DEVIL_LIFT_DAMPING,
  RESPAWN_INVULNERABLE,
  devilTerrainTint,
  DEVIL_SIZE_RANGE,
  DevilPebbles,
  PEBBLE_POOL,
  devilWander,
  isRoverFlipped,
  pileWindwardPoint,
  stormCheckpointLayout,
  waypointsAllVisible,
  type DevilRoverForce,
  type StormDifficulty,
  type StormPhase,
  type StormQualityTier,
} from "./dustStorm.js";
import {
  GUIDE_RIBBON_MAX,
  GUIDE_DOT_COUNT,
  GUIDE_DOT_FLOAT,
  GUIDE_DOT_RADIUS,
  GUIDE_DOT_SPACING,
  guideDotWave,
  sampleRouteEvenly,
  smoothRoute,
  GUIDE_RIBBON_START,
  autoDriveDirection,
  clearSkyProgress,
  courseReachable,
  findRoute,
  polylineLength,
  randomStormCourse,
  randomStormStart,
  targetOnScreen,
  ymcaDance,
  type YmcaArm,
  type YmcaPhase,
  type RouteObstacle,
  type RoutePoint,
  type YmcaLetter,
} from "./dustStormRoute.js";

export interface MarsDustStormState {
  modelLoaded: boolean;
  modelError: string | null;
  difficulty: StormDifficulty;
  quality: StormQualityTier;
  time: number;
  intensity: number;
  phase: StormPhase;
  windSpeed: number;
  fogDensity: number;
  checkpoint: number;
  checkpointCount: number;
  distanceToBeam: number;
  bearing: number;
  burial: number;
  stuck: boolean;
  flipped: boolean;
  won: boolean;
  /** fe-29: run lost on hard (reason, e.g. "BLOWN AWAY"). */
  lost: boolean;
  lostReason: string | null;
  /** fe-29: last safe grounded spot, blown-away respawns, invulnerability left (s), clearance (m). */
  safe: { x: number; y: number; z: number; yaw: number };
  blownAway: number;
  invulnerable: number;
  clearance: number;
  windLift: number;
  /** fe-29: end-of-run summary dialog shown (loss, or completion after the finale) and the run stats. */
  summaryVisible: boolean;
  stats: { distance: number; maxHeight: number; topSpeed: number; maxWind: number; timesLifted: number; respawns: number };
  /** fe-29: hidden wind force multiplier in effect (STORM_STRENGTH; tests only, never shown). */
  stormStrength: number;
  /** fe-28: seed of this load's random course (`?seed=` pins it). */
  courseSeed: number;
  /** fe-28 finale: phase (null before the win), stage-light envelope/sweep, jingle status. */
  dancePhase: YmcaPhase | null;
  stageLights: number;
  stageSweep: number;
  jingle: { unlocked: boolean; muted: boolean; started: boolean };
  /** fe-28: randomized start (10–20 % farther from beam 1 than the surveyed spawn). */
  start: { x: number; z: number; stretch: number; fallback: boolean };
  /** fe-28: beam positions of this load's course. */
  checkpoints: { x: number; z: number }[];
  /** fe-28: 0 = storm, 1 = clear Mars day (ramps after the last beam). */
  clearSky: number;
  /** fe-28: YMCA finale letter being formed (null while rising / between choruses / not won). */
  dance: YmcaLetter | null;
  dancing: boolean;
  /** fe-28: off-screen waypoint arrow currently shown. */
  arrowVisible: boolean;
  /** fe-28: drive direction picked by the gas/brake pedals (no gear selector). */
  gear: 1 | -1;
  /** fe-28: corner points of the current guide route (rover → beam). */
  guideRoute: { x: number; z: number }[];
  /** fe-29: guide dots shown and the index of the brightest (wave crest; −1 = none). */
  guideDots: { dots: number; crest: number };
  elapsed: number;
  penalty: number;
  resets: number;
  devils: { x: number; z: number; coreRadius: number; swirl: number; slot: number; state: string; opacity: number; life: number }[];
  piles: { depth: number; maxDepth: number }[];
  x: number;
  z: number;
  /** Chassis heading (radians, 0 = +Z). */
  yaw: number;
  speed: number;
}

export interface MarsDustStormHandle extends DemoSceneHandle {
  stormState(): MarsDustStormState;
  /** Restart the run from the spawn (R key). */
  restart(): void;
  /** Switch difficulty (toolbar buttons + touch cycle) and restart the run under the new rules. */
  setDifficulty(difficulty: StormDifficulty): void;
  /** Place the rover upright at (x, z) facing the active beam (browser checks). */
  teleport(x: number, z: number): boolean;
  /** fe-29: the end-of-run summary (title + rows) for the current run. */
  summary(): { title: string; rows: [string, string][] };
  /** fe-29 test / screenshot hook: simulate a wind throw (see the blown-away rule). */
  debugBlow(dx: number, dz: number, up?: number): void;
  /** Skip the finale clock ahead (browser screenshot checks on slow software GPUs); no-op unless dancing. */
  advanceFinale(seconds: number): void;
  /** fe-28: the adaptive device-quality tracker (tier, reasons, frame-time monitor). */
  readonly deviceQuality: AdaptiveDeviceQuality;
}

export interface MarsDustStormOptions {
  loadGlb?: typeof loadGlb;
  difficulty?: StormDifficulty;
  quality?: StormQualityTier;
  /** fe-28: random course seed; omit for a fresh random course every load (`?seed=` in main.ts). */
  courseSeed?: number;
  /** fe-28: force the starting device tier (`?tier=`); omit to classify the device. */
  deviceTier?: DeviceTier;
  /** fe-28: capability hints (tests); omit to read navigator + the WebGPU adapter. */
  deviceHints?: DeviceCapabilityHints;
  /** fe-28: let the frame-time monitor adapt the tier at runtime (default true; tests pin it). */
  adaptiveQuality?: boolean;
  /** fe-28: start with the finale jingle muted (`?mute=1`). */
  muted?: boolean;
}

/** Same surveyed spawn as the Mars Showcase (all six wheels planted on the seed-1337 surface). */
const BASE_SPAWN_X = -164;
const BASE_SPAWN_Z = 4;
/** fe-28 device tier knobs: guide re-route interval (s), dust emission scale, startup shadow map. */
export const STORM_TIER_ROUTE_INTERVAL: Readonly<Record<DeviceTier, number>> = { high: 0.5, medium: 1, low: 1.5 };
export const STORM_TIER_PARTICLES: Readonly<Record<DeviceTier, number>> = { high: 1, medium: 0.7, low: 0.45 };
export const STORM_TIER_SHADOW_MAP: Readonly<Record<DeviceTier, number>> = { high: 4096, medium: 2048, low: 1024 };
const STORM_SITE = { name: "Equatorial plain", latDeg: 0, lonDeg: 0, headingDeg: 0 } as const;
const ROVER_RADIUS = 1.6;
const BOULDER_COUNT = 36;
const BEAM_HEIGHT = 420;
/** Fog density (exp²) in a lull and at the gust peak: roughly 150 m and 35 m of visibility. */
const FOG_LULL = 0.009;
const FOG_GUST = 0.045;
/** Linear dust colour at full daylight; light level scales it. */
const DUST_R = 0.5;
const DUST_G = 0.26;
const DUST_B = 0.12;
/** Seconds on its side/roof before the difficulty rule fires. */
const FLIP_GRACE = 1.5;
/** Clear-sky finale haze: light enough to read as a clear day, dense enough to hide the streamed terrain edge (~500 m). */
const FOG_CLEAR = 0.0035;
const SUN_DIRECTION = new Vec3(200, 300, 200).normalize();
/** Keep boulders this far from a beam or the spawn (the reach radius + rover length). */
const BOULDER_KEEP_OUT = 12;
/** Heights (m above the ground) sampled on a beam for the arrow's "beam is on screen" test. */
const BEAM_VIEW_SAMPLES = [0.5, 6, 40, 120] as const;

export function buildMarsDustStormScene(engine: Engine, options: MarsDustStormOptions = {}): MarsDustStormHandle {
  const loadModel = options.loadGlb ?? loadGlb;
  let difficulty: StormDifficulty = options.difficulty ?? "easy";
  let rules = STORM_DIFFICULTY[difficulty];
  const qualityTier: StormQualityTier = options.quality ?? "full";
  const quality = STORM_QUALITY_TIERS[qualityTier];
  // fe-28: device tier (cores / memory / adapter limits / mobile UA) + a frame-time monitor.
  const deviceHints = options.deviceHints ?? readDeviceCapabilityHints(undefined, engine.gpu.adapter as unknown as Parameters<typeof readDeviceCapabilityHints>[1]);
  const device = new AdaptiveDeviceQuality(deviceHints, options.deviceTier ? { initialTier: options.deviceTier } : {});
  if (device.initial.reasons.length > 0) console.info(`mars dust storm: device tier ${device.tier} (${device.initial.reasons.join(", ")})`);
  const adaptive = options.adaptiveQuality ?? true;
  let lastFrameAt = 0;
  const particleScale = (): number => device.value(STORM_TIER_PARTICLES);
  const gpu = engine.gpu;
  const scene = new Scene({ name: "mars-dust-storm" });

  scene.settings.hdr = true;
  scene.settings.exposure = 1.25;
  scene.settings.toneMapping = "aces";
  scene.settings.bloom.enabled = true;
  scene.settings.bloom.threshold = 1.0;
  scene.settings.bloom.intensity = 0.12;
  scene.settings.shadow.enabled = true;
  scene.settings.shadow.cascades = quality.shadowCascades;
  scene.settings.shadow.mapSize = Math.min(quality.shadowMapSize, device.value(STORM_TIER_SHADOW_MAP));
  scene.settings.shadow.distance = 120;
  // The storm hides the sky: the background is the dust itself, re-tinted every frame.
  scene.setBackgroundColor(new Color(DUST_R, DUST_G, DUST_B));
  scene.setFog("exp2", { density: FOG_LULL, color: new Color(DUST_R, DUST_G, DUST_B) });

  const terrainBundle = createMarsTerrain(gpu, {
    site: STORM_SITE,
    label: "storm-mars-layers",
    viewDistance: 512,
    visibleChunks: 90,
  });
  const { terrain } = terrainBundle;
  scene.add(terrain);
  const groundHeight = (x: number, z: number): number => terrain.getHeightAt(x, z);
  const ground = heightFunctionGround(groundHeight);
  // fe-28: a random course every load, each beam reachable from the previous (route-checked),
  // and a random start 10–20 % farther from the first beam than the surveyed spawn.
  const courseSeed = (options.courseSeed ?? Math.floor(Math.random() * 0xffffffff)) >>> 0;
  const generated = randomStormCourse(courseSeed, BASE_SPAWN_X, BASE_SPAWN_Z, groundHeight, { fallback: stormCheckpointLayout(BASE_SPAWN_X, BASE_SPAWN_Z) });
  if (generated.fallback) console.warn(`mars dust storm: no reachable random course for seed ${courseSeed}; using the surveyed layout`);
  const start = randomStormStart(courseSeed, BASE_SPAWN_X, BASE_SPAWN_Z, generated.checkpoints, groundHeight);
  if (start.fallback) console.warn(`mars dust storm: no random start validated for seed ${courseSeed}; using the surveyed spawn`);
  const SPAWN_X = start.x;
  const SPAWN_Z = start.z;
  const groundY = groundHeight(SPAWN_X, SPAWN_Z);
  terrain.focusPosition.set(SPAWN_X, groundY, SPAWN_Z);

  const disposables: { dispose(): void }[] = [];
  const track = <T extends { dispose(): void }>(resource: T): T => {
    disposables.push(resource);
    return resource;
  };
  const addRenderable = (name: string, position: Vec3, geometry: Geometry, material: Material, shadows = true): Entity => {
    const entity = scene.createTransformedEntity(name, position);
    const renderable = new Renderable();
    renderable.geometry = geometry;
    renderable.material = material;
    renderable.castShadow = shadows;
    renderable.receiveShadow = shadows;
    // The draw bucket (blend pipeline, back-to-front, no depth write) is chosen per Renderable;
    // without this a transparent material is drawn opaque (fe-18: the "solid pipe" devils).
    renderable.transparent = material.transparent;
    scene.world.addComponent(entity.id, renderable);
    return entity;
  };

  // ---------------------------------------------------------------- lights

  const sunEntity = scene.createTransformedEntity("sun", new Vec3(200, 300, 200));
  const sun = new Light();
  sun.kind = "directional";
  sun.intensity = 4.2;
  sun.castShadow = true;
  sun.setColor(1.0, 0.86, 0.68);
  sun.shadowBias = 0.001;
  scene.world.addComponent(sunEntity.id, sun);
  sunEntity.transform.lookAt(new Vec3(0, 0, 0));
  const ambientColor = new Color(0.62, 0.36, 0.2);
  scene.setAmbient(ambientColor, 0.35);

  // ---------------------------------------------------------------- rover

  const vehicle = createMarsRoverVehicle(ground, SPAWN_X, SPAWN_Z);
  let startupBrake = true;
  vehicle.input.brake = 1;
  vehicle.input.handbrake = 1;
  const bodyOffsetY = groundY - vehicle.position.y;
  // fe-29: chassis height above the terrain at rest; clearance is measured from it.
  const rideHeight = vehicle.position.y - groundHeight(vehicle.position.x, vehicle.position.z);
  scene.world.registerSystem(new VehicleSystem());
  const chassis = scene.createTransformedEntity("rover-chassis", new Vec3(vehicle.position.x, vehicle.position.y, vehicle.position.z));
  const wheelRoots: Entity[] = [];
  const wheelIds: number[] = [];
  for (const spec of MARS_ROVER_WHEELS) {
    const wheel = scene.createTransformedEntity(`rover-${spec.name}`, new Vec3(vehicle.position.x, vehicle.position.y, vehicle.position.z));
    wheelRoots.push(wheel);
    wheelIds.push(wheel.id);
  }
  const component = new VehicleComponent(vehicle, ground);
  component.wheelEntities = wheelIds;
  chassis.add(component);

  let modelLoaded = false;
  /** fe-28 dance rig: split suspension arms (chassis children) and robotic-arm joints. */
  const suspensionEntities = new Map<SuspensionArmPiece, Entity>();
  const armJoints: { entity: Entity; role: string; axis: Vec3; rot: Quat }[] = [];
  let modelError: string | null = null;
  let loaded: LoadedGlb | null = null;
  let disposed = false;
  loadModel(gpu, new URL("../../assets/Perseverance.glb", import.meta.url).href)
    .then((glb) => {
      if (disposed) {
        glb.dispose();
        return;
      }
      loaded = glb;
      modelLoaded = true;
      // fe-28: split the rocker/bogie arms out of the merged body so they dance with the wheels.
      const body: GlbPart[] = [];
      const armParts = new Map<SuspensionArmPiece, GlbPart[]>();
      for (const part of glb.body) {
        const pieces = splitSuspension(part.geometry.source);
        if (pieces.size === 1 && pieces.has("body")) {
          body.push(part);
          continue;
        }
        for (const [piece, src] of pieces) {
          const split = { name: `${part.name}-${piece}`, geometry: track(Geometry.create(gpu, src)), material: part.material };
          if (piece === "body") body.push(split);
          else {
            const list = armParts.get(piece) ?? [];
            list.push(split);
            armParts.set(piece, list);
          }
        }
      }
      attachStaticRoverModel(scene, chassis, wheelRoots, MARS_ROVER_WHEELS.map((w) => w.name), { ...glb, body }, bodyOffsetY);
      for (const [piece, parts] of armParts) {
        const rest = new Vec3(0, bodyOffsetY, 0);
        const pivot = scene.createTransformedEntity(`rover-susp-${piece}`, rest);
        chassis.addChild(pivot);
        pivot.transform.position = rest;
        for (const part of parts) {
          const child = scene.createTransformedEntity(`rover-body-${part.name}`, new Vec3());
          pivot.addChild(child);
          const renderable = new Renderable();
          renderable.geometry = part.geometry;
          renderable.material = part.material;
          renderable.castShadow = true;
          renderable.receiveShadow = true;
          scene.world.addComponent(child.id, renderable);
        }
        suspensionEntities.set(piece, pivot);
      }
      // fe-28: the robotic arm joins the dance (rotate each joint about its own axis).
      for (const joint of glb.arm?.joints ?? []) {
        const id = scene.world.findByName(`rover-${joint.name}`)[0];
        const entity = id === undefined ? null : scene.world.facade(id);
        if (entity) armJoints.push({ entity, role: joint.joint, axis: new Vec3(joint.axis[0], joint.axis[1], joint.axis[2]), rot: new Quat() });
      }
    })
    .catch((error: unknown) => {
      modelError = error instanceof Error ? error.message : String(error);
      console.error("mars dust storm: rover model failed to load; rover remains invisible", error);
    });

  // ---------------------------------------------------------------- camera

  const cameraEntity = scene.createTransformedEntity("camera", new Vec3(SPAWN_X - 8, groundY + 5, SPAWN_Z - 10));
  const camera = new Camera();
  camera.fovY = Math.PI / 3;
  camera.near = 0.35;
  camera.far = 2000;
  scene.world.addComponent(cameraEntity.id, camera);
  const chaseLookY = vehicle.position.y + MARS_CHASE_LOOK_OFFSET_Y;

  // ---------------------------------------------------------------- storm model

  const storm = new StormField(STORM_SEED);
  const devils = new DustDevilField(quality.devils);
  const accumulation = new DustAccumulation();
  const course = new StormCourse(generated.checkpoints, SPAWN_X, SPAWN_Z);
  // Face the first beam at the start.
  const first = course.checkpoints[0]!;
  vehicle.yaw = Math.atan2(first.x - SPAWN_X, first.z - SPAWN_Z);
  vehicle.placeOnGround(ground);

  // ---------------------------------------------------------------- boulders + their dust piles

  const dustMaterial = track(new Material({ label: "storm-dust-pile", color: Color.fromSrgbHex(0xc08050), roughness: 1, metallic: 0, doubleSided: true }));
  const rockMaterial = track(new Material({ label: "storm-boulder", color: Color.fromSrgbHex(0x7a5040), roughness: 0.95, metallic: 0.02 }));
  const boulderGeometry = track(createRock(gpu, { radius: 1, segments: 10, seed: 11, roughness: 0.36, flatten: 0.3 }));
  /**
   * fe-18: every pile owns a small draped mesh (centre + rings + sunken skirt) rebuilt only when its
   * shape changes. Vertices sample the heightfield so the pile hugs slopes with no void under its
   * edge, and the angle-of-repose settle stretches it downhill instead of overhanging.
   */
  interface DriftRecord {
    entity: Entity;
    renderable: Renderable;
    geometry: Geometry;
    mesh: DriftMoundMesh | undefined;
    lastX: number;
    lastZ: number;
    lastH: number;
    lastHeading: number;
  }
  const emptyDrift = (label: string): Geometry => track(Geometry.create(gpu, {
    label,
    positions: new Float32Array(DRIFT_VERTEX_COUNT * 3),
    normals: new Float32Array(DRIFT_VERTEX_COUNT * 3).fill(0).map((_, i) => (i % 3 === 1 ? 1 : 0)),
    uvs: new Float32Array(DRIFT_VERTEX_COUNT * 2),
    indices: buildDriftMoundMesh({ x: 0, z: 0, height: 0, along: 1, across: 1, heading: 0, slope: 0, downhill: 0 }, () => 0).indices,
  }));
  const makeDrift = (name: string, x: number, z: number, material: Material = dustMaterial, shadows = false): DriftRecord => {
    const geometry = emptyDrift(name);
    const entity = addRenderable(name, new Vec3(x, groundHeight(x, z), z), geometry, material, shadows);
    const renderable = entity.get(Renderable)!;
    renderable.visible = false;
    return { entity, renderable, geometry, mesh: undefined, lastX: NaN, lastZ: NaN, lastH: NaN, lastHeading: NaN };
  };

  interface PropRecord {
    x: number;
    z: number;
    radius: number;
    pile: ReturnType<DustAccumulation["addPile"]>;
    drift: DriftRecord;
  }
  const props: PropRecord[] = [];
  const obstacles: RouteObstacle[] = [];
  {
    const rng = new Rng((STORM_SEED + 31) ^ courseSeed);
    const anchors = [{ x: SPAWN_X, z: SPAWN_Z }, ...course.checkpoints];
    const spots: RouteObstacle[] = [];
    for (let i = 0; spots.length < BOULDER_COUNT && i < BOULDER_COUNT * 3; i++) {
      // Scatter along the course legs, never on a beam or the spawn.
      const leg = i % (anchors.length - 1);
      const a = anchors[leg]!;
      const b = anchors[leg + 1]!;
      const t = rng.nextRange(0.15, 0.85);
      const side = rng.nextSignedFloat() * 22;
      const lx = b.x - a.x;
      const lz = b.z - a.z;
      const len = Math.hypot(lx, lz) || 1;
      const x = a.x + lx * t + (-lz / len) * side;
      const z = a.z + lz * t + (lx / len) * side;
      const radius = rng.nextRange(0.9, 2.2);
      // Never on a beam ring or the spawn (random legs can be short or bend back near a beam).
      if (anchors.some((a) => Math.hypot(a.x - x, a.z - z) < BOULDER_KEEP_OUT + radius)) continue;
      spots.push({ x, z, radius });
    }
    // Boulders must not wall off a leg: drop the last ones until every beam is reachable again.
    while (spots.length > 0 && !courseReachable(SPAWN_X, SPAWN_Z, course.checkpoints, groundHeight, spots)) spots.pop();
    for (let i = 0; i < spots.length; i++) {
      const { x, z, radius } = spots[i]!;
      const y = groundHeight(x, z);
      const boulder = addRenderable(`storm-boulder-${i}`, new Vec3(x, y + radius * 0.35, z), boulderGeometry, rockMaterial);
      boulder.transform.scale = new Vec3(radius, radius, radius);
      props.push({ x, z, radius, pile: accumulation.addPile(x, z, radius), drift: makeDrift(`storm-pile-${i}`, x, z) });
      obstacles.push({ x, z, radius });
    }
  }

  // fe-22f: small pebbles devils can lift (the boulders above are far too big). One shared tiny
  // rock mesh; desktop 20 / iOS 8 small draws, no shadows.
  const pebbles = new DevilPebbles(PEBBLE_POOL[qualityTier === "reduced" ? "reduced" : "full"]);
  pebbles.scatter(SPAWN_X, SPAWN_Z, groundHeight);
  const pebbleGeometry = track(createRock(gpu, { radius: 1, segments: 6, seed: 23, roughness: 0.4, flatten: 0.2 }));
  const pebbleEntities = pebbles.pebbles.map((p, i) => addRenderable(`storm-pebble-${i}`, new Vec3(p.x, p.y, p.z), pebbleGeometry, rockMaterial, false));
  const pebbleBase = { x: 0, z: 0 };
  const pebbleBaseAt = (d: DustDevil): { x: number; z: number } => {
    devilWander(d, time, pebbleBase);
    pebbleBase.x += d.x;
    pebbleBase.z += d.z;
    return pebbleBase;
  };
  const stepPebbles = (dt: number): void => {
    pebbles.step(dt, devils.devils, pebbleBaseAt, groundHeight, vehicle.position.x, vehicle.position.z);
    for (let i = 0; i < pebbleEntities.length; i++) {
      const p = pebbles.pebbles[i]!;
      const ent = pebbleEntities[i]!;
      ent.transform.position = moundPos.set(p.x, p.y, p.z);
      ent.transform.scale = pebbleScale.set(p.radius, p.radius * 0.8, p.radius);
      ent.transform.rotation = pebbleRot.setAxisAngle(UP_AXIS, p.spin);
    }
  };
  const pebbleScale = new Vec3();
  const pebbleRot = new Quat();

  // The rover's own piles: one on the windward face, one skirt around the wheels.
  const roverWindDrift = makeDrift("storm-rover-pile-windward", SPAWN_X, SPAWN_Z);
  const roverSkirtDrift = makeDrift("storm-rover-pile-skirt", SPAWN_X, SPAWN_Z);

  // ---------------------------------------------------------------- beams

  const beamGeometry = track(createCylinder(gpu, { radiusTop: 1.4, radiusBottom: 1.4, height: BEAM_HEIGHT, radialSegments: 24, capped: false }));
  const beamActive = track(new Material({
    label: "storm-beam-active",
    technique: "emissive",
    color: Color.fromSrgbHex(0x9fe8ff),
    emissive: Color.fromSrgbHex(0x9fe8ff),
    emissiveStrength: 9,
    opacity: 0.6,
    transparent: true,
    doubleSided: true,
    fogExempt: true,
  }));
  const beamNext = track(beamActive.clone({ label: "storm-beam-next", emissiveStrength: 1.6, opacity: 0.22 }));
  const ringActive = track(new Material({
    label: "storm-beam-ring",
    technique: "emissive",
    color: Color.fromSrgbHex(0x9fe8ff),
    emissive: Color.fromSrgbHex(0x9fe8ff),
    emissiveStrength: 6,
    fogExempt: true,
    doubleSided: true,
  }));
  interface BeamRecord {
    beamEntity: Entity;
    beam: Renderable;
    ring: Renderable;
  }
  const beams: BeamRecord[] = course.checkpoints.map((cp, i) => {
    const y = groundHeight(cp.x, cp.z);
    const beamEntity = addRenderable(`storm-beam-${i}`, new Vec3(cp.x, y + BEAM_HEIGHT / 2 - 1, cp.z), beamGeometry, beamNext, false);
    // fe-18: the base ring is draped onto the terrain (flush on hills, never half-buried).
    const ring = buildDrapedRing(cp.x, cp.z, 6, 0.55, groundHeight);
    const ringGeometry = track(Geometry.create(gpu, { label: `storm-beam-ring-${i}`, positions: ring.positions, normals: ring.normals, uvs: ring.uvs, indices: ring.indices }));
    const ringEntity = addRenderable(`storm-beam-ring-${i}`, new Vec3(cp.x, ring.baseY, cp.z), ringGeometry, ringActive, false);
    return { beamEntity, beam: beamEntity.get(Renderable)!, ring: ringEntity.get(Renderable)! };
  });
  const refreshBeams = (): void => {
    for (let i = 0; i < beams.length; i++) {
      const record = beams[i]!;
      const active = i === course.index && course.state === "driving";
      // fe-29: only the current beacon shows, except on Easy where every beacon still ahead does.
      const ahead = i > course.index && course.state === "driving" && waypointsAllVisible(difficulty);
      record.beam.visible = active || ahead;
      record.beam.material = active ? beamActive : beamNext;
      record.ring.visible = active;
    }
  };
  refreshBeams();

  // ---------------------------------------------------------------- guidance (fe-18): easy path + off-screen arrow

  // fe-29: the path is a string of small glowing white spheres, evenly spaced along a smoothed,
  // obstacle-aware route and floating just above the ground. One shared sphere geometry with two
  // materials (dim / crest), so the renderer draws them as two instanced batches. A brightness and
  // scale wave runs from the rover to the beam.
  const dotGeometry = track(createSphere(gpu, { radius: 1, widthSegments: 10, heightSegments: 6 }));
  const dotDim = track(new Material({
    label: "storm-guide-dot",
    technique: "emissive",
    color: new Color(1, 1, 1),
    emissive: new Color(1, 1, 1),
    emissiveStrength: 1.6,
    opacity: 0.55,
    transparent: true,
    fogExempt: true,
    depthWrite: false,
  }));
  const dotBright = track(dotDim.clone({ label: "storm-guide-dot-crest", emissiveStrength: 7, opacity: 1 }));
  const routeTo = (x: number, z: number, target: { x: number; z: number }): RoutePoint[] => {
    const raw = findRoute(x, z, target.x, target.z, groundHeight, obstacles) ?? [{ x, z }, { x: target.x, z: target.z }];
    return smoothRoute(raw, groundHeight, obstacles);
  };
  let guideRoute: RoutePoint[] = routeTo(SPAWN_X, SPAWN_Z, first);
  const dots: { entity: Entity; renderable: Renderable }[] = [];
  for (let i = 0; i < GUIDE_DOT_COUNT; i++) {
    const entity = addRenderable(`storm-guide-dot-${i}`, new Vec3(SPAWN_X, groundY, SPAWN_Z), dotGeometry, dotDim, false);
    entity.transform.scale = new Vec3(GUIDE_DOT_RADIUS, GUIDE_DOT_RADIUS, GUIDE_DOT_RADIUS);
    const renderable = entity.get(Renderable)!;
    renderable.visible = false;
    dots.push({ entity, renderable });
  }
  // Same as a restart's first stepGuidance(0), so the fresh state matches a restarted one.
  let dotPoints: RoutePoint[] = sampleRouteEvenly(guideRoute, GUIDE_DOT_SPACING, GUIDE_DOT_COUNT, GUIDE_RIBBON_START);
  const dotScale = new Vec3();
  const pulseState = { dots: guidePathEnabled(difficulty, true) ? dotPoints.length : 0, crest: -1 };
  let guideVisible = false;
  let guideTimer = 0;
  let routeTimer = 0;
  let routeTarget = -1;
  const arrowMesh = buildArrowMesh();
  const arrowGeometry = track(Geometry.create(gpu, { label: "storm-waypoint-arrow", positions: arrowMesh.positions, normals: arrowMesh.normals, uvs: arrowMesh.uvs, indices: arrowMesh.indices }));
  const arrowMaterial = track(ringActive.clone({ label: "storm-waypoint-arrow", emissiveStrength: 7, doubleSided: true }));
  const arrowEntity = addRenderable("storm-waypoint-arrow", new Vec3(SPAWN_X, groundY + 4, SPAWN_Z), arrowGeometry, arrowMaterial, false);
  const arrowRenderable = arrowEntity.get(Renderable)!;
  arrowRenderable.visible = false;
  const arrowState = new WaypointArrowState();
  // Beam pulse: the active beam throbs (emissive + radius) and a bright band climbs it into the sky.
  const pulse = beamPulse(0);
  const pulseBandMaterial = track(beamActive.clone({ label: "storm-beam-pulse", emissiveStrength: 14, opacity: 0 }));
  const pulseBandGeometry = track(createCylinder(gpu, { radiusTop: 1.9, radiusBottom: 1.9, height: 24, radialSegments: 24, capped: false }));
  const pulseBand = addRenderable("storm-pulse-band", new Vec3(SPAWN_X, groundY, SPAWN_Z), pulseBandGeometry, pulseBandMaterial, false);
  const pulseBandRenderable = pulseBand.get(Renderable)!;
  pulseBandRenderable.visible = false;
  const beamScale = new Vec3(1, 1, 1);
  const stepBeamPulse = (): void => {
    beamPulse(time, pulse);
    const glow = 9 * pulse.glow;
    if (Math.abs(beamActive.emissiveStrength - glow) > 0.2) {
      beamActive.emissiveStrength = glow;
      beamActive.markChanged(); // uniforms upload only on markChanged()
    }
    const cp = course.active;
    const rec = cp ? beams[course.index] : undefined;
    for (let i = 0; i < beams.length; i++) beams[i]!.beamEntity.transform.scale = beamScale.set(i === course.index ? pulse.width : 1, 1, i === course.index ? pulse.width : 1);
    pulseBandRenderable.visible = !!cp && !!rec && pulse.bandOpacity > 0.01;
    if (!cp || !pulseBandRenderable.visible) return;
    setOpacity(pulseBandMaterial, pulse.bandOpacity);
    pulseBand.transform.position = moundPos.set(cp.x, groundHeight(cp.x, cp.z) + 12 + pulse.band * BEAM_HEIGHT, cp.z);
  };
  const arrowRot = new Quat();
  const camForward = new Vec3();
  const camLook = new Vec3();
  const camView = new Mat4();
  const camProj = new Mat4();
  const camViewProj = new Mat4();
  const UP_AXIS = new Vec3(0, 1, 0);

  // ---------------------------------------------------------------- particles (sheet + one system per devil)

  const dustColor = { r: 0.78, g: 0.48, b: 0.28, a: STORM_SHEET_LOOK.alpha };
  const makeDust = (name: string, capacity: number, seed: number, maxEmits: number, colorVariation: number): GpuParticleWorld => {
    const world = new GpuParticleWorld({
      name,
      capacity,
      maxEmitsPerFrame: maxEmits,
      seed,
      softParticles: true,
      softScale: 18,
      stretch: 0.8,
      cullDistance: 140,
      emitter: {
        rate: 0,
        lifeMin: 2.2,
        lifeMax: 3.6,
        size: STORM_SHEET_LOOK.size,
        position: { x: SPAWN_X, y: groundY + 8, z: SPAWN_Z },
        jitter: { x: 60, y: 9, z: 60 },
        coneDir: { x: 1, y: 0, z: 0 },
        coneAngle: 0.25,
        speedMin: 10,
        speedMax: 18,
        color: { ...dustColor },
      },
      modules: {
        gravity: { x: 0, y: -0.6, z: 0 },
        drag: 0.05,
        turbulence: 4,
        noiseScale: 0.08,
        attractorPos: { x: SPAWN_X, y: groundY + 6, z: SPAWN_Z },
        attractorStrength: 0,
        swirlStrength: 0,
        velocityBoost: { x: 0, y: 0, z: 0 },
        colorFrom: { ...dustColor },
        colorTo: { r: 0.62, g: 0.36, b: 0.2, a: 0 },
        colorAlt: { ...STORM_DUST_PALETTE.rock },
        colorVariation: colorVariation,
        sizeStart: STORM_SHEET_LOOK.sizeStart,
        sizeEnd: STORM_SHEET_LOOK.sizeEnd,
        sizeVariation: STORM_SHEET_LOOK.sizeVariation,
        rotationSpeed: 0.4,
      },
    });
    scene.add(world);
    return world;
  };
  const dust = makeDust("storm dust", quality.sheetCapacity, 0x5d0, 4096, STORM_DUST_PALETTE.sheetVariation);
  /** One GPU system per devil slot; slot i follows `devils.devils[i]` and idles when that slot is empty. */
  const devilDust: GpuParticleWorld[] = [];
  /** Per-slot reusable emitter looks (no per-frame allocation, fe-21b). */
  const devilLooks: DevilParticleLook[] = [];
  /** Per-slot terrain tint (fe-22f), reused every frame. */
  const devilTints = Array.from({ length: quality.devils }, () => devilTerrainTint(0));
  const setRgba = (dst: { r: number; g: number; b: number; a: number }, src: { r: number; g: number; b: number }, a: number): void => {
    dst.r = src.r;
    dst.g = src.g;
    dst.b = src.b;
    dst.a = a;
  };
  for (let i = 0; i < quality.devils; i++) {
    devilLooks.push(devilParticleLook({ id: 0, coreRadius: 1, swirl: 1 }));
    devilDust.push(makeDust(`devil dust ${i}`, quality.devilCapacity, 0xd0 + i, 1024, STORM_DUST_PALETTE.devilVariation));
  }

  // ---------------------------------------------------------------- devil ground shadows (fe-21)

  /**
   * fe-21 captain redirect: a dust devil IS its swirling particle swarm (see `devilParticleLook`);
   * the fe-18 funnel cards and skirt shell are gone. Each slot keeps only a cheap draped ground
   * shadow, which anchors the column to the terrain.
   */
  interface CoreCard { entity: Entity; renderable: Renderable; geometry: Geometry; mesh: FunnelMesh | undefined; material: Material; uploaded?: boolean }
  interface FunnelRecord {
    shadow: DriftRecord;
    shadowMaterial: Material;
    /** fe-22: the old (fe-18/fe-19) devil, restored as a core inside the swirl: dense + wispy cards. */
    core: CoreCard;
    outer: CoreCard;
  }
  // fe-22: old-devil core cards. No particles (so no particle budget); two thin camera-facing quad
  // strips per devil, 26 triangles each, transparent and shadowless.
  const cardTexture = track(Texture.fromRgba8(gpu, 64, 128, devilCardPixels(), { label: "storm-devil-card", srgb: true, mipmaps: true }));
  const makeCoreCard = (name: string, hex: number): CoreCard => {
    const geometry = track(Geometry.create(gpu, {
      label: name,
      positions: new Float32Array(CARD_VERTEX_COUNT * 3),
      normals: new Float32Array(CARD_VERTEX_COUNT * 3),
      uvs: new Float32Array(CARD_VERTEX_COUNT * 2),
      indices: buildFunnelCard({ id: 0, coreRadius: 1, swirl: 1, x: 0, z: 0 }, 1, 1, 0, 1, 0, 0).indices,
    }));
    // Unlit + fog-exempt like the swirl grains around it: lit and fogged, the cards washed out to
    // pale flat bands in gusts (fe-22 shots). No depth write: a transparent card's whole quad wrote
    // depth and hid every swirl grain behind it (the pale hard-edged band).
    const material = track(new Material({ label: name, color: Color.fromSrgbHex(hex), roughness: 1, metallic: 0, opacity: 0, transparent: true, doubleSided: true, technique: "unlit", fogExempt: true, depthWrite: false }));
    material.albedoMap = cardTexture;
    material.markChanged();
    const entity = addRenderable(name, new Vec3(SPAWN_X, groundY, SPAWN_Z), geometry, material, false);
    const renderable = entity.get(Renderable)!;
    renderable.visible = false;
    return { entity, renderable, geometry, mesh: undefined, material };
  };
  /** Material uniforms upload only after markChanged() (which also rebuilds the bind group), so skip
   * changes too small to see. */
  const setOpacity = (material: Material, value: number): void => {
    if (Math.abs(material.opacity - value) < 0.015) return;
    material.opacity = value;
    material.markChanged();
  };
  const funnels: FunnelRecord[] = [];
  for (let i = 0; i < quality.devils; i++) {
    const shadowMaterial = track(new Material({ label: `storm-devil-shadow-${i}`, color: Color.fromSrgbHex(0x1a0c06), roughness: 1, metallic: 0, opacity: 0, transparent: true }));
    funnels.push({
      shadow: makeDrift(`storm-devil-shadow-${i}`, SPAWN_X, SPAWN_Z, shadowMaterial),
      shadowMaterial,
      core: makeCoreCard(`storm-devil-core-${i}`, 0x24140c),
      outer: makeCoreCard(`storm-devil-shell-${i}`, 0x5a3a28),
    });
  }
  /** Sun direction projected on the ground (the shadow falls away from it). */
  const sunAway = { x: -200 / Math.hypot(200, 200), z: -200 / Math.hypot(200, 200) };
  const sunTan = Math.hypot(200, 200) / 300;

  // ---------------------------------------------------------------- input

  const keys = new Set<string>();
  // fe-28 finale jingle: unlocked by the first key/pointer gesture (autoplay rules), M mutes.
  const jingle = new DiscoJingle({ muted: options.muted ?? false });
  const unlockAudio = (): void => jingle.unlock();
  window.addEventListener("pointerdown", unlockAudio);
  window.addEventListener("pointerup", unlockAudio);
  const onKeyDown = (event: KeyboardEvent): void => {
    jingle.unlock();
    if (event.code === "KeyM" && !event.repeat) jingle.muted = !jingle.muted;
    keys.add(event.code);
    if (event.code === "Space" || event.code.startsWith("Arrow")) event.preventDefault();
    if (event.code === "KeyR" && !event.repeat) restart();
  };
  const onKeyUp = (event: KeyboardEvent): void => {
    keys.delete(event.code);
  };
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
  // fe-29: four difficulty buttons in the toolbar and a touch pad that cycles them. Each restarts the run.
  const diffButtons = STORM_DIFFICULTIES.map((d) => ({ d, el: document.getElementById(`btn-storm-${d}`), on: (): void => setDifficulty(d) }));
  const touchDifficulty = document.getElementById("storm-difficulty");
  const syncDifficultyUi = (): void => {
    for (const { d, el } of diffButtons) {
      el?.classList.toggle("active", d === difficulty);
      el?.setAttribute("aria-pressed", String(d === difficulty));
    }
    if (touchDifficulty) {
      const strict = STORM_DIFFICULTY[difficulty].onBlownAway === "lose";
      touchDifficulty.classList.toggle("active", strict);
      touchDifficulty.setAttribute("aria-pressed", String(strict));
      const letter = touchDifficulty.querySelector(".veh-letter");
      const caption = touchDifficulty.querySelector(".veh-caption");
      if (letter) letter.textContent = difficulty[0]!.toUpperCase();
      if (caption) caption.textContent = difficulty.toUpperCase();
    }
  };
  const onToggleDifficulty = (event: Event): void => {
    event.preventDefault();
    setDifficulty(STORM_DIFFICULTIES[(STORM_DIFFICULTIES.indexOf(difficulty) + 1) % STORM_DIFFICULTIES.length]!);
  };
  for (const { el, on } of diffButtons) el?.addEventListener("click", on);
  touchDifficulty?.addEventListener("click", onToggleDifficulty);
  syncDifficultyUi(); // the URL's ?difficulty is the initial value
  const touch = attachVehicleTouch(document.getElementById("vehicle-touch"));
  const drive = readMarsDriveInput(keys, { steer: 0, throttle: 0, brake: 0 });

  // ---------------------------------------------------------------- run state

  let time = 0;
  let intensity = storm.intensity(0);
  let fogDensity = FOG_LULL;
  const wind = { x: 0, z: 0 };
  let stuck = false;
  let flippedFor = 0;
  let lastEvent = "";
  /** fe-28: storm → clear day blend and the YMCA finale clock (both start at the last beam). */
  let clearSky = 0;
  let wonAt = -1;
  let dancing = false;
  let danceLetter: YmcaLetter | null = null;
  const force: DevilRoverForce = { ax: 0, az: 0, yawAccel: 0, lift: 0, rollAccel: 0 };
  // fe-29: the wind pushes by force / mass, so read the rover's mass from its config.
  const roverMass = vehicle.config.mass;
  // Hidden wind force multiplier of the current difficulty (STORM_STRENGTH).
  const stormStrength = (): number => rules.stormStrength;
  const gustAccel = { x: 0, z: 0 };
  const stats = new StormRunStats();
  let summaryShown = false;
  // End-of-run dialog (loss, or completion once the finale ends). Built lazily; no-op without a DOM.
  let summaryEl: HTMLDivElement | null = null;
  const summaryInput = () => ({
    result: (course.state === "lost" ? "lost" : "completed") as "lost" | "completed",
    reason: course.lostReason,
    difficulty,
    time: course.total,
    reached: Math.min(course.index, course.checkpoints.length),
    total: course.checkpoints.length,
    seed: courseSeed,
    stats,
  });
  const hideSummary = (): void => {
    if (summaryEl) summaryEl.style.display = "none";
  };
  const showSummary = (): void => {
    summaryShown = true;
    if (typeof document === "undefined" || typeof document.createElement !== "function" || !document.body) return;
    const { title, rows } = stormRunSummary(summaryInput());
    if (!summaryEl) {
      summaryEl = document.createElement("div");
      summaryEl.id = "storm-summary";
      summaryEl.setAttribute("role", "dialog");
      summaryEl.setAttribute("aria-modal", "true");
      summaryEl.style.cssText =
        "position:fixed;inset:0;display:flex;align-items:center;justify-content:center;z-index:60;background:rgb(0 0 0 / 0.35);padding:12px;box-sizing:border-box;font:12px/1.4 system-ui,-apple-system,sans-serif;color:#e2e8f0";
      document.body.appendChild(summaryEl);
    }
    const lost = course.state === "lost";
    const accent = lost ? "#fca5a5" : "#86efac";
    summaryEl.innerHTML = `<div class="panel" style="width:min(360px,100%);max-height:calc(100% - 24px);overflow:auto;padding:14px 16px;gap:10px">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:8px">
        <div class="panel-title">Run summary</div>
        <button type="button" data-act="close" aria-label="Close" style="background:none;border:0;color:#94a3b8;font-size:18px;line-height:1;cursor:pointer;padding:4px 6px">×</button>
      </div>
      <div style="font-size:18px;font-weight:700;color:${accent}">${title}</div>
      <table style="width:100%;border-collapse:collapse">${rows
        .slice(1)
        .map(([k, v]) => `<tr><td style="color:#94a3b8;padding:3px 0">${k}</td><td style="text-align:right;padding:3px 0;font-variant-numeric:tabular-nums">${v}</td></tr>`)
        .join("")}</table>
      <div class="btn-group" style="display:flex;gap:8px;flex-wrap:wrap">
        <button type="button" data-act="new" style="flex:1;min-height:40px">Play again</button>
        <button type="button" data-act="retry" style="flex:1;min-height:40px">Retry same course</button>
      </div>
    </div>`;
    summaryEl.style.display = "flex";
    summaryEl.onclick = (e: Event): void => {
      const act = (e.target as HTMLElement | null)?.closest?.("[data-act]")?.getAttribute("data-act");
      if (act === "close") hideSummary();
      else if (act === "retry") restart();
      else if (act === "new") {
        // A new random course: reload without ?seed, keeping the difficulty.
        const url = new URL(window.location.href);
        url.searchParams.delete("seed");
        url.searchParams.set("difficulty", difficulty);
        window.location.assign(url.toString());
      }
    };
  };
  const blown = new BlownAwayTracker();
  blown.reset(vehicle.position.x, vehicle.position.y, vehicle.position.z, vehicle.yaw);
  let blownAwayCount = 0;
  let invulnerable = 0;
  let windLift = 0;
  let lastClearance = 0;
  // Brief black fade over the canvas on a blown-away respawn (no-op without a DOM).
  let fadeEl: HTMLDivElement | null = null;
  try {
    if (typeof document !== "undefined" && typeof document.createElement === "function" && document.body) {
      fadeEl = document.createElement("div");
      fadeEl.style.cssText = "position:fixed;inset:0;background:#000;opacity:0;pointer-events:none;transition:opacity 0.35s;z-index:50";
      document.body.appendChild(fadeEl);
    }
  } catch {
    fadeEl = null;
  }
  let fadeTimer: ReturnType<typeof setTimeout> | null = null;
  const flashFade = (): void => {
    if (!fadeEl) return;
    fadeEl.style.opacity = "1";
    if (fadeTimer) clearTimeout(fadeTimer);
    fadeTimer = setTimeout(() => {
      if (fadeEl) fadeEl.style.opacity = "0";
    }, 380);
  };
  const windward = { x: 0, z: 0 };
  const moundPos = new Vec3();
  const fogColor = new Color(DUST_R, DUST_G, DUST_B);

  /** Reposition upright, facing the active beam. `clearDust` also empties the rover's pile. */
  const placeRover = (x: number, z: number, clearDust = true, yaw?: number): void => {
    vehicle.position.x = x;
    vehicle.position.z = z;
    vehicle.velocity.set(0, 0, 0);
    vehicle.yawRate = 0;
    vehicle.pitch = 0;
    vehicle.roll = 0;
    vehicle.pitchRate = 0;
    vehicle.rollRate = 0;
    for (const wheel of vehicle.wheels) wheel.omega = 0;
    vehicle.selectGear(1, Infinity);
    const target = course.active;
    if (yaw !== undefined) vehicle.yaw = yaw;
    else if (target) vehicle.yaw = Math.atan2(target.x - x, target.z - z);
    vehicle.placeOnGround(ground);
    // Any reposition is a fresh safe spot for the blown-away rule.
    blown.reset(vehicle.position.x, vehicle.position.y, vehicle.position.z, vehicle.yaw);
    stats.reposition();
    if (clearDust) {
      accumulation.resetRover();
      stuck = false;
    }
    flippedFor = 0;
  };

  /** Hard-mode rule: back to the last reached beam (or the spawn). */
  const sendBack = (reason: string): void => {
    const p = course.respawnPoint();
    course.resets++;
    stats.respawns++;
    placeRover(p.x, p.z);
    lastEvent = `${reason} · BACK TO ${course.lastReached < 0 ? "START" : `BEACON ${course.lastReached + 1}`}`;
  };

  /** fe-29: thrown too far by the wind — respawn at the last safe spot (easy) or lose (hard). */
  const onBlownAway = (): void => {
    blownAwayCount++;
    if (rules.onBlownAway === "lose") {
      course.lose("BLOWN AWAY");
      refreshBeams();
      lastEvent = "BLOWN AWAY · RUN LOST · R TO RETRY";
      showSummary();
      return;
    }
    const s = { ...blown.safe };
    placeRover(s.x, s.z, false, s.yaw);
    invulnerable = RESPAWN_INVULNERABLE;
    stats.respawns++;
    flashFade();
    lastEvent = "BLOWN AWAY · BACK TO LAST SAFE SPOT";
  };

  function setDifficulty(next: StormDifficulty): void {
    difficulty = next;
    rules = STORM_DIFFICULTY[next];
    syncDifficultyUi();
    restart();
    lastEvent = `${next.toUpperCase()} · RUN RESTARTED`;
  }

  /**
   * Reset EVERYTHING to the fresh-build state so each restart replays identically under the fixed
   * seed: storm clock (gust phase), wind, dust devils (spawn stream back to its seed), every boulder
   * pile and the rover's piles, the course, and the rover itself. R and the difficulty buttons use it.
   */
  function restart(): void {
    stopDance();
    jingle.stop();
    jingleStarted = false;
    clearSky = 0;
    wonAt = -1;
    skyOn = false;
    time = 0;
    intensity = storm.intensity(0);
    wind.x = 0;
    wind.z = 0;
    devils.reset();
    devilEmitFrame = 0;
    accumulation.reset();
    course.reset();
    stuck = false;
    invulnerable = 0;
    windLift = 0;
    lastClearance = 0;
    blownAwayCount = 0;
    stats.reset();
    summaryShown = false;
    hideSummary();
    if (fadeEl) fadeEl.style.opacity = "0";
    placeRover(SPAWN_X, SPAWN_Z);
    startupBrake = true;
    lastEvent = "";
    applyAtmosphere();
    stepPiles(0); // re-pose the (now empty) mounds
    refreshBeams();
    arrowState.reset();
    guideTimer = 0;
    // Fresh route from the spawn even when hard mode hides it, so a restart is the fresh state.
    guideRoute = routeTo(SPAWN_X, SPAWN_Z, first);
    routeTimer = device.value(STORM_TIER_ROUTE_INTERVAL);
    routeTarget = course.index;
    stepGuidance(0);
  }

  // fe-28 finale: after the last beam the storm lifts into a clear Mars day (the showcase's sky).
  const marsAtmosphere = createAtmosphere({}, MARS_ATMOSPHERE);
  const clearHorizon = new AtmosphereModel(marsAtmosphere).horizonColor(SUN_DIRECTION, 0, new Float64Array(3));
  let skyOn = false;
  const applyAtmosphere = (): void => {
    const light = stormLightFactors(1, intensity, 0.12, 0.3);
    const c = clearSky;
    sun.intensity = 4.2 * (light.sun + (1 - light.sun) * c);
    // Lull intensity maps to the lull fog exactly; gusts close it down to a few rover lengths.
    const gust = Math.max(0, Math.min(1, (intensity - LULL_INTENSITY) / (1 - LULL_INTENSITY)));
    const stormFog = FOG_LULL + (FOG_GUST - FOG_LULL) * gust;
    // Exponential blend so visibility opens up steadily instead of all at the end.
    fogDensity = c <= 0 ? stormFog : stormFog * Math.pow(FOG_CLEAR / stormFog, c);
    const level = 0.35 + 0.65 * light.ambient;
    fogColor.r = DUST_R * level + (clearHorizon[0]! - DUST_R * level) * c;
    fogColor.g = DUST_G * level + (clearHorizon[1]! - DUST_G * level) * c;
    fogColor.b = DUST_B * level + (clearHorizon[2]! - DUST_B * level) * c;
    scene.setFog("exp2", { density: fogDensity, color: fogColor });
    // The analytic sky takes over once the haze is mostly gone; until then the dust is the backdrop.
    if (c > 0.6) {
      if (!skyOn) {
        scene.setSky({ atmosphere: marsAtmosphere, quality: "medium", sunIntensity: 20, sunDirection: SUN_DIRECTION });
        skyOn = true;
      }
    } else {
      skyOn = false;
      scene.setBackgroundColor(fogColor);
    }
    scene.setAmbient(ambientColor, 0.25 + 0.25 * light.ambient + 0.15 * c);
  };
  applyAtmosphere();

  const stepParticles = (): void => {
    const system = dust.system;
    if (!system) return;
    const eye = cameraEntity.transform.position;
    const emitter = system.emitter;
    const modules = system.modules;
    const windLen = Math.hypot(wind.x, wind.z) || 1;
    // Storm sheet: a wind-driven slab upwind of the camera.
    emitter.rate = quality.sheetRate * particleScale() * (0.25 + 0.75 * intensity) * (1 - clearSky);
    emitter.position.x = eye.x - (wind.x / windLen) * 25;
    emitter.position.y = groundHeight(eye.x, eye.z) + 7;
    emitter.position.z = eye.z - (wind.z / windLen) * 25;
    emitter.coneDir.x = wind.x / windLen;
    emitter.coneDir.y = -0.05;
    emitter.coneDir.z = wind.z / windLen;
    emitter.speedMin = windLen * 0.6;
    emitter.speedMax = windLen * 1.05;
    modules.attractorStrength = 0;
    modules.swirlStrength = 0;
    // Every devil owns a system: a column rising from its core, pulled in and spun around it.
    for (let i = 0; i < devilDust.length; i++) {
      const sys = devilDust[i]!.system;
      if (!sys) continue;
      const d = devils.bySlot(i);
      if (!d) {
        sys.emitter.rate = 0;
        sys.modules.attractorStrength = 0;
        sys.modules.swirlStrength = 0;
        // Empty slot: drop the axis spring too, so leftover grains drift free instead of
        // snapping toward a stale axis (fe-21 review).
        sys.modules.axisPull = 0;
        sys.modules.groundWindHeight = 0;
        continue;
      }
      // red-frontier column/skirt alternation (fe-21): the frame counter only picks the emit shape.
      const look = devilParticleLook(d, time, devilEmitFrame, devilLooks[i]);
      const e = sys.emitter;
      // Scale with the life envelope so a consumed or dying devil's column thins out, never pops.
      e.rate = particleScale() * devilEmitRate(quality.devilRate, look, devilEnvelope(d), d.age < DEVIL_BURST_TIME) * (1 - clearSky);
      // fe-22d: the whole devil (grains, base cloud, cards, shadow) dances on the wandering base.
      const bx = d.x + look.curve.baseX;
      const bz = d.z + look.curve.baseZ;
      const gy = groundHeight(bx, bz);
      e.position.x = bx;
      e.position.y = gy + 0.3;
      e.position.z = bz;
      e.jitter.x = 0;
      e.jitter.y = 0;
      e.jitter.z = 0;
      // Shared by reference with the per-slot look (no per-frame allocation); read at uniform write.
      e.vortex = look.vortex;
      e.speedMin = look.speedMin;
      e.speedMax = look.speedMax;
      e.lifeMin = look.lifeMin;
      e.lifeMax = look.lifeMax;
      const m = sys.modules;
      m.attractorPos.x = bx;
      m.attractorPos.y = gy + 0.3;
      m.attractorPos.z = bz;
      m.attractorStrength = 0;
      // fe-21: the swarm is the devil, so its grains carry the darker lifted soil tone (not the pale
      // sunlit sheet colour; colorAlt still blends toward rock) and are not stretched into streaks.
      // Per-devil opacity variety (fe-19) now rides on the swarm's own alpha.
      // fe-22f: dust takes the colour of the ground under the devil's base (slope bands as the
      // Mars surface layers), darkened as lifted dust; the cards share it (stepFunnels).
      const tint = devilTerrainTint(terrain.getSlopeAt(bx, bz), devilTints[i]);
      setRgba(e.color, tint.color, d.opacity);
      setRgba(m.colorFrom, tint.color, d.opacity);
      setRgba(m.colorTo, tint.color, 0);
      setRgba(m.colorAlt, tint.alt, 1);
      // fe-21f: no velocity stretch (aligning to swirl velocity foreshortened grains into flat chips)
      // and the opt-in soft round sprite, so close grains read as dust puffs.
      sys.stretch = 0;
      sys.softSprite = true;
      m.axisPull = look.axisPull;
      const lean = (m.axisLean ??= { x: 0, y: 1, z: 0 });
      lean.x = look.leanX;
      lean.y = look.axisHeight;
      lean.z = look.leanZ;
      const curve = (m.axisCurve ??= { bendX: 0, bendZ: 0, snakeX: 0, snakeZ: 0, bulge: 0, kinkX: 0, kinkZ: 0 });
      curve.bendX = look.curve.bendX;
      curve.bendZ = look.curve.bendZ;
      curve.snakeX = look.curve.snakeX;
      curve.snakeZ = look.curve.snakeZ;
      curve.bulge = look.springBulge;
      curve.kinkX = look.curve.kinkX;
      curve.kinkZ = look.curve.kinkZ;
      // Modules act on every live particle of the system, so they stay fixed across the column/skirt
      // frame alternation (a blend of red-frontier's column 0/0.4 and skirt 1.2/1.6 gravity/drag).
      m.gravity.y = DEVIL_DUST_GRAVITY;
      m.drag = DEVIL_DUST_DRAG;
      m.swirlStrength = look.swirl;
      m.sizeStart = look.sizeStart;
      m.sizeEnd = look.sizeEnd;
      // fe-22f: fully random continuous grain sizes (log spread) instead of the coarse/fine split.
      m.sizeVariation = 0;
      m.coarseFraction = 0;
      m.coarseScale = 1;
      m.sizeRange = DEVIL_SIZE_RANGE;
      // fe-21d: the storm wind drags the base cloud downwind, much harder in gusts.
      devilBaseWind(wind.x, wind.z, intensity, (m.groundWind ??= { x: 0, z: 0 }));
      m.groundWindHeight = DEVIL_BASE_CLOUD.windHeight;
    }
    devilEmitFrame++;
    stepFunnels();
  };

  let devilEmitFrame = 0;
  let funnelFrame = 0;
  const stepFunnels = (): void => {
    funnelFrame++;
    // Reduced (iOS) tier re-shapes the core cards on alternate frames only: half the vertex uploads.
    const rebuild = qualityTier !== "reduced" || funnelFrame % 2 === 0;
    const eye = cameraEntity.transform.position;
    for (let i = 0; i < funnels.length; i++) {
      const f = funnels[i]!;
      const d: DustDevil | undefined = devils.bySlot(i);
      const env = d ? devilEnvelope(d) : 0;
      if (!d || env <= 0.01) {
        f.shadow.renderable.visible = false;
        f.core.renderable.visible = false;
        f.outer.renderable.visible = false;
        continue;
      }
      const vl = devilVortexLife(d);
      const height = devilFunnelHeight(d.coreRadius) * vl.growth;
      // fe-22: old-devil core, same axis/sway as the swirl, thinning with it as the devil dies.
      const dc = devilLooks[i]!.curve;
      const cx = d.x + dc.baseX;
      const cz = d.z + dc.baseZ;
      const gyCore = groundHeight(cx, cz);
      const fade = devilShellFade(Math.hypot(eye.x - d.x, eye.z - d.z));
      const cards: [CoreCard, number, number, number][] = [
        [f.core, DEVIL_CORE_CARD_WIDTH.core, DEVIL_CORE_OPACITY.core, 0.45],
        [f.outer, DEVIL_CORE_CARD_WIDTH.outer, DEVIL_CORE_OPACITY.outer, 0.3],
      ];
      for (const [rec, wScale, opacity, scroll] of cards) {
        rec.renderable.visible = fade > 0.01;
        if (!rec.renderable.visible) continue;
        if (rebuild || !rec.mesh) rec.mesh = buildFunnelCard(d, height, wScale * vl.radiusScale, time, eye.x, eye.z, time * scroll + d.id * 0.37, rec.mesh, dc);
        if (rebuild || !rec.uploaded) {
          rec.geometry.updateFrom({ positions: rec.mesh.positions, normals: rec.mesh.normals, uvs: rec.mesh.uvs, indices: rec.mesh.indices });
          rec.uploaded = true;
        }
        rec.entity.transform.position = moundPos.set(cx, gyCore - 0.2, cz);
        setOpacity(rec.material, devilCardOpacity(opacity, d, fade, intensity) * (1 - clearSky));
        // fe-22f: terrain tint (the grey card texture carries only shading); upload only on change.
        const tc = devilTints[i]!.color;
        const shade = rec === f.core ? 0.8 : 1.1;
        const mc = rec.material.baseColor;
        if (Math.abs(mc.r - tc.r * shade) + Math.abs(mc.g - tc.g * shade) + Math.abs(mc.b - tc.b * shade) > 0.004) {
          mc.r = tc.r * shade; mc.g = tc.g * shade; mc.b = tc.b * shade;
          rec.material.markChanged();
        }
      }
      // Ground shadow: a thin draped ellipse stretched away from the sun.
      const len = Math.min(height * sunTan, 60) * 0.5;
      setOpacity(f.shadowMaterial, 0.32 * env * (0.5 + 0.5 * stormLightFactors(1, intensity, 0.12, 0.3).sun) * (1 - clearSky));
      updateDrift(f.shadow, cx + sunAway.x * len, cz + sunAway.z * len, 0.001, len, d.coreRadius * 0.6, Math.atan2(sunAway.z, sunAway.x), true);
    }
  };

  /**
   * Settle and drape one pile. Rebuilds the mesh only when the pile grew, the wind turned or the
   * anchor moved enough to matter (rover piles move with the rover), so idle piles cost nothing.
   */
  const updateDrift = (rec: DriftRecord, x: number, z: number, height: number, along: number, across: number, heading: number, decal = false): void => {
    const minHeight = decal ? 0 : 0.02;
    rec.renderable.visible = height > minHeight;
    if (!rec.renderable.visible) return;
    let dh = heading - rec.lastHeading;
    while (dh > Math.PI) dh -= Math.PI * 2;
    while (dh < -Math.PI) dh += Math.PI * 2;
    const changed = !(Math.abs(height - rec.lastH) < 0.01 && Math.abs(dh) < 0.035 && Math.hypot(x - rec.lastX, z - rec.lastZ) < 0.05);
    if (!changed) return;
    rec.lastX = x;
    rec.lastZ = z;
    rec.lastH = height;
    rec.lastHeading = heading;
    // Piles grow their footprint with depth; the devil-shadow decal keeps its full ellipse.
    const grow = decal ? 1 : driftFootprintGrowth(height, along, across);
    const shape = settleDriftMound({ x, z, height, along: along * grow, across: across * grow, heading }, groundHeight);
    rec.mesh = buildDriftMoundMesh(shape, groundHeight, rec.mesh, decal ? 0.06 : Math.min(DRIFT_LIFT, 0.5 * height));
    rec.geometry.updateFrom({ positions: rec.mesh.positions, normals: rec.mesh.normals, uvs: rec.mesh.uvs, indices: rec.mesh.indices });
    rec.entity.transform.position = moundPos.set(x, rec.mesh.baseY, z);
  };

  const stepPiles = (dt: number): void => {
    accumulation.stepPiles(dt, intensity);
    // Heading of the wind (0 = +X, toward +Z): the pile's long axis runs along it.
    const heading = Math.atan2(wind.z, wind.x);
    for (const prop of props) {
      pileWindwardPoint(prop.pile, wind.x, wind.z, windward);
      const d = prop.pile.depth;
      updateDrift(prop.drift, windward.x, windward.z, d, prop.radius * 0.9, prop.radius * 1.3, heading);
    }
    // Rover piles: windward bank plus a skirt that climbs the wheels as burial grows.
    const b = accumulation.burial;
    const len = Math.hypot(wind.x, wind.z) || 1;
    const rx = vehicle.position.x - (wind.x / len) * 1.5;
    const rz = vehicle.position.z - (wind.z / len) * 1.5;
    updateDrift(roverWindDrift, rx, rz, 1.1 * b, 1.4 * Math.sqrt(b), 2.4 * Math.sqrt(b), heading);
    // Vehicle yaw 0 faces +Z, so its forward heading is atan2(cos yaw, sin yaw).
    updateDrift(roverSkirtDrift, vehicle.position.x, vehicle.position.z, 0.75 * b, 2.1, 1.9, Math.atan2(Math.cos(vehicle.yaw), Math.sin(vehicle.yaw)));
  };

  const collideProps = (): void => {
    for (const prop of props) {
      const dx = vehicle.position.x - prop.x;
      const dz = vehicle.position.z - prop.z;
      const min = prop.radius * 0.85 + ROVER_RADIUS;
      const dist = Math.hypot(dx, dz);
      if (dist >= min || dist < 1e-6) continue;
      const nx = dx / dist;
      const nz = dz / dist;
      vehicle.position.x = prop.x + nx * min;
      vehicle.position.z = prop.z + nz * min;
      const vn = vehicle.velocity.x * nx + vehicle.velocity.z * nz;
      if (vn < 0) {
        vehicle.velocity.x -= vn * nx;
        vehicle.velocity.z -= vn * nz;
      }
    }
  };

  const update = (dt: number): void => {
    // Wall-clock frame time (not the clamped sim dt) drives the adaptive tier.
    const now = performance.now();
    if (adaptive && modelLoaded && lastFrameAt > 0) device.sample(now - lastFrameAt);
    lastFrameAt = now;
    if (dt <= 0) return;
    time += dt;
    if (wonAt >= 0) clearSky = clearSkyProgress(time - wonAt);
    intensity = storm.intensity(time) * (1 - clearSky);
    storm.wind(time, wind);
    applyAtmosphere();
    scene.settings.sky.seaLevel = groundHeight(vehicle.position.x, vehicle.position.z);

    // Devils: step, then push / yaw / lift / roll the rover.
    devils.step(dt, intensity, wind.x, wind.z, vehicle.position.x, vehicle.position.z);
    stepPebbles(dt);
    // fe-29: clearance of the chassis above its equilibrium ride height (≈ 0 when parked).
    const clearance = Math.max(0, vehicle.position.y - groundHeight(vehicle.position.x, vehicle.position.z) - rideHeight);
    lastClearance = clearance;
    invulnerable = Math.max(0, invulnerable - dt);
    windLift = 0;
    let windPush = 0;
    const windOn = invulnerable <= 0 && course.state === "driving";
    for (const devil of devils.devils) {
      if (!windOn) break;
      // fe-22e: push from the visible, wandered base. fe-29: force / mass, lift fades aloft.
      devilRoverForceAt(devil, time, vehicle.position.x, vehicle.position.z, force, roverMass, clearance, stormStrength());
      if (force.ax === 0 && force.az === 0 && force.yawAccel === 0) continue;
      vehicle.velocity.x += force.ax * dt;
      vehicle.velocity.z += force.az * dt;
      vehicle.yawRate += force.yawAccel * dt;
      windPush = Math.max(windPush, Math.hypot(force.ax, force.az));
      if (force.lift > 0) {
        windLift += force.lift;
        vehicle.velocity.y += force.lift * dt;
        vehicle.rollRate += force.rollAccel * dt;
      }
    }
    // Air drag on a climbing rover: caps the climb so it hovers where lift meets gravity.
    if (windLift > 0 && vehicle.velocity.y > 0) vehicle.velocity.y -= DEVIL_LIFT_DAMPING * vehicle.velocity.y * dt;
    // Storm gust push, by force / mass from the wind relative to the rover. A rover standing still
    // on its wheels is held by static friction (≈0.25 m/s² of gust vs μ·g ≈ 3 m/s² of grip).
    const heldStill = Math.hypot(vehicle.velocity.x, vehicle.velocity.z) < 0.5 && vehicle.wheels.every((w) => w.inContact);
    if (windOn && !startupBrake && !heldStill && !stuck) {
      stormWindAccel(wind.x, wind.z, vehicle.velocity.x, vehicle.velocity.z, roverMass, gustAccel, stormStrength());
      vehicle.velocity.x += gustAccel.x * dt;
      vehicle.velocity.z += gustAccel.z * dt;
    }
    if (course.state === "driving" && !startupBrake) {
      // Devil wind at the rover, recovered from its drag push (a = q·k·v²·√(1+inflow²) / m).
      const devilWind = Math.sqrt((windPush * roverMass) / (ROVER_SIDE_Q * stormStrength() * Math.hypot(1, DEVIL_INFLOW_FRACTION)));
      stats.step({
        x: vehicle.position.x,
        z: vehicle.position.z,
        clearance,
        speed: Math.hypot(vehicle.velocity.x, vehicle.velocity.z),
        wind: Math.max(Math.hypot(wind.x, wind.z), devilWind),
        lifted: windLift > 0,
      });
      let grounded = 0;
      for (const w of vehicle.wheels) if (w.inContact) grounded++;
      const thrown = blown.step(dt, {
        x: vehicle.position.x,
        y: vehicle.position.y,
        z: vehicle.position.z,
        yaw: vehicle.yaw,
        grounded,
        wheels: vehicle.wheels.length,
        flipped: isRoverFlipped(vehicle.roll, vehicle.pitch),
        windLift,
        windPush,
      });
      if (thrown) onBlownAway();
    }

    // Input → vehicle, under the stuck / won rules.
    readMarsDriveInput(keys, touch.sample(), drive);
    // fe-28: no gear selector — gas drives forward, brake slows and then backs up.
    const forwardSpeed = vehicle.velocity.x * Math.sin(vehicle.yaw) + vehicle.velocity.z * Math.cos(vehicle.yaw);
    const pedals = autoDriveDirection(vehicle.gear, drive.throttle, drive.brake, forwardSpeed);
    if (pedals.gear !== (vehicle.gear < 0 ? -1 : 1)) vehicle.selectGear(pedals.gear, Infinity);
    drive.throttle = pedals.throttle;
    drive.brake = pedals.brake;
    if (drive.throttle > 0.01) startupBrake = false;
    const speed = Math.hypot(vehicle.velocity.x, vehicle.velocity.z);
    // The run (clock and burial) starts with the first throttle, not while the model loads.
    const running = !startupBrake && course.state === "driving";
    if (running) accumulation.stepRover(dt, intensity, speed, drive.throttle, stuck);
    const flipped = isRoverFlipped(vehicle.roll, vehicle.pitch);
    if (!stuck && accumulation.burial >= BURIAL_STUCK && course.state === "driving") {
      if (rules.onStuck === "reset") {
        sendBack("BURIED");
      } else {
        stuck = true;
        course.penalty += rules.timePenalty;
        lastEvent = `STUCK · +${rules.timePenalty}s · PUMP THROTTLE TO ROCK FREE`;
      }
    } else if (stuck && accumulation.burial <= BURIAL_FREE) {
      stuck = false;
      lastEvent = "ROCKED FREE";
    }
    flippedFor = flipped ? flippedFor + dt : 0;
    if (flippedFor >= FLIP_GRACE && course.state === "driving") {
      if (rules.onFlip === "reset") {
        sendBack("FLIPPED");
      } else {
        course.penalty += rules.timePenalty;
        placeRover(vehicle.position.x, vehicle.position.z, false);
        lastEvent = `FLIPPED · RIGHTED · +${rules.timePenalty}s`;
      }
    }
    const lost = course.state === "lost";
    vehicle.input.throttle = stuck || lost ? 0 : drive.throttle;
    vehicle.input.brake = Math.max(drive.brake, startupBrake || stuck || lost ? 1 : 0);
    vehicle.input.steer = lost ? 0 : drive.steer;
    vehicle.input.handbrake = drive.handbrake || startupBrake || stuck || lost ? 1 : 0;

    collideProps();
    if (running && course.step(dt, vehicle.position.x, vehicle.position.z)) {
      lastEvent = course.state === "won" ? "STORM SURVIVED" : `BEACON ${course.index} REACHED`;
      refreshBeams();
      if (course.state === "won") {
        wonAt = time;
        startDance();
        jingleStarted = jingle.play();
      }
    }
    if (dancing) stepDance(dt);
    stepPiles(dt);
    stepParticles();
    stepGuidance(dt);
  };

  /**
   * Easy/Advanced guidance: glowing dots along a smoothed obstacle-aware route (re-routed ~2×/s,
   * re-sampled ~5×/s) with a wave running to the beam, and the off-screen beam arrow.
   */
  function stepGuidance(dt: number): void {
    const target = course.active;
    const vx = vehicle.position.x;
    const vz = vehicle.position.z;
    guideVisible = guidePathEnabled(difficulty, !!target);
    guideTimer -= dt;
    routeTimer -= dt;
    if (guideVisible && target && (routeTimer <= 0 || routeTarget !== course.index)) {
      routeTimer = device.value(STORM_TIER_ROUTE_INTERVAL);
      routeTarget = course.index;
      guideRoute = routeTo(vx, vz, target);
      guideTimer = 0;
    }
    if (guideVisible && target && guideTimer <= 0) {
      guideTimer = 0.2;
      // Between re-routes the first corner follows the rover so the dots never trail behind it.
      guideRoute[0] = { x: vx, z: vz };
      dotPoints = sampleRouteEvenly(guideRoute, GUIDE_DOT_SPACING, GUIDE_DOT_COUNT, GUIDE_RIBBON_START);
    }
    const len = Math.min(polylineLength(guideRoute), GUIDE_RIBBON_MAX);
    pulseState.dots = 0;
    pulseState.crest = -1;
    let best = 0;
    for (let i = 0; i < dots.length; i++) {
      const dot = dots[i]!;
      const pt = guideVisible ? dotPoints[i] : undefined;
      dot.renderable.visible = !!pt;
      if (!pt) continue;
      pulseState.dots++;
      const sArc = GUIDE_RIBBON_START + i * GUIDE_DOT_SPACING;
      const glow = guideDotWave(time, sArc, len);
      if (glow > best) {
        best = glow;
        pulseState.crest = i;
      }
      dot.renderable.material = glow > 0.35 ? dotBright : dotDim;
      const r = GUIDE_DOT_RADIUS * (1 + 0.8 * glow);
      dot.entity.transform.scale = dotScale.set(r, r, r);
      dot.entity.transform.position = moundPos.set(pt.x, groundHeight(pt.x, pt.z) + GUIDE_DOT_FLOAT + r, pt.z);
    }
    stepBeamPulse();
    if (!target || !waypointArrowEnabled(difficulty)) {
      arrowState.reset();
      arrowRenderable.visible = false;
      return;
    }
    // fe-28: a real frustum test. The fe-18 test used local −Z as the camera's look axis, but the
    // camera looks along its local +Z (`Transform.forward`), so the arrow hid only when the camera
    // faced away from the beam.
    const eye = cameraEntity.transform.position;
    cameraEntity.transform.rotation.rotateVector(Vec3.unitZ, camForward);
    camLook.set(eye.x + camForward.x, eye.y + camForward.y, eye.z + camForward.z);
    camView.setLookAt(eye, camLook, UP_AXIS);
    const aspect = camera.aspectOverride > 0 ? camera.aspectOverride : (typeof window !== "undefined" && window.innerHeight > 0 ? window.innerWidth / window.innerHeight : 16 / 9);
    camProj.setPerspective(camera.fovY, aspect, camera.near, camera.far);
    camViewProj.multiplyMatrices(camProj, camView);
    // The beam counts as in view when any of its ring, lower column or upper column is on screen.
    const gy = groundHeight(target.x, target.z);
    let inner = false;
    let outer = false;
    for (const up of BEAM_VIEW_SAMPLES) {
      inner ||= targetOnScreen(camViewProj.m, target.x, gy + up, target.z, ARROW_IN_MARGIN);
      outer ||= targetOnScreen(camViewProj.m, target.x, gy + up, target.z, ARROW_OUT_MARGIN);
    }
    arrowRenderable.visible = arrowState.step(dt, inner, outer, waypointArrowEnabled(difficulty));
    if (!arrowRenderable.visible) return;
    const heading = Math.atan2(target.z - vz, target.x - vx);
    arrowEntity.transform.position = moundPos.set(vx, vehicle.position.y + 3.6 + 0.15 * Math.sin(time * 3), vz);
    // Local +X points along the arrow; a Y rotation by −heading maps +X onto (cos h, 0, sin h).
    arrowEntity.transform.rotation = arrowRot.setAxisAngle(UP_AXIS, -heading);
  }

  // ---------------------------------------------------------------- fe-28 finale: YMCA on the rear wheels

  /** Chassis-local rest hub of every wheel (captured when the dance starts). */
  const restHubs = MARS_ROVER_WHEELS.map(() => new Vec3());
  const dancePivot = new Vec3();
  const danceYaw = new Quat();
  const dancePitch = new Quat();
  const danceRot = new Quat();
  const danceInv = new Quat();
  const danceSpin = new Quat();
  const danceWheelRot = new Quat();
  const danceTmp = new Vec3();
  const danceOut = new Vec3();
  const danceWheelPos = new Vec3();
  const RIGHT_AXIS = new Vec3(1, 0, 0);
  let danceSpinAngle = 0;
  let dancePhase: YmcaPhase | null = null;
  /** Stage-light envelope 0..1 and sweep −1..1 (fe-28). */
  let danceLights = 0;
  let danceSweep = 0;
  const armRestPos = new Vec3();
  const armPivot = new Vec3();
  const armTarget = new Vec3();
  const armOffset = new Vec3();
  const armPos = new Vec3();
  const armRot = new Quat();
  let jingleStarted = false;
  function startDance(): void {
    if (dancing) return;
    vehicle.writeRotation(danceRot);
    danceInv.copyFrom(danceRot).invert();
    const center = new Vec3();
    for (let i = 0; i < vehicle.wheels.length && i < restHubs.length; i++) {
      vehicle.wheelCenterPosition(vehicle.wheels[i]!, center);
      danceTmp.set(center.x - vehicle.position.x, center.y - vehicle.position.y, center.z - vehicle.position.z);
      danceInv.rotateVector(danceTmp, restHubs[i]!);
    }
    // Pivot on the rear axle (wheels 4 and 5), where the rover stands.
    const rl = restHubs[4]!;
    const rr = restHubs[5]!;
    danceTmp.set((rl.x + rr.x) / 2, (rl.y + rr.y) / 2, (rl.z + rr.z) / 2);
    danceRot.rotateVector(danceTmp, danceOut);
    dancePivot.set(vehicle.position.x + danceOut.x, vehicle.position.y + danceOut.y, vehicle.position.z + danceOut.z);
    // Freeze the physics: the system would otherwise overwrite the posed transforms every step.
    vehicle.velocity.set(0, 0, 0);
    scene.world.removeComponent(chassis.id, VehicleComponent);
    dancing = true;
    danceSpinAngle = 0;
  }
  function resetDanceRig(): void {
    for (const e of suspensionEntities.values()) {
      e.transform.position = armRestPos.set(0, bodyOffsetY, 0);
      e.transform.rotation = Quat.identity;
    }
    for (const j of armJoints) j.entity.transform.rotation = Quat.identity;
  }
  /** End the finale (clip over, or a restart): stow the rig and hand the rover back to physics. */
  function stopDance(): void {
    danceLetter = null;
    dancePhase = null;
    danceLights = 0;
    if (!dancing) return;
    dancing = false;
    resetDanceRig();
    stepStageLights(0, 0);
    chassis.add(component);
  }
  function stepDance(dt: number): void {
    const t = time - wonAt;
    const f = ymcaDance(t);
    if (f.phase === "done") {
      // The clip is over and the rover is back on its wheels: physics takes over again.
      stopDance();
      dancePhase = "done";
      if (!summaryShown) showSummary();
      return;
    }
    dancePhase = f.phase;
    danceLights = f.lights;
    danceSweep = f.sweep;
    stepStageLights(f.lights, f.sweep);
    danceLetter = f.letter;
    danceSpinAngle += f.spin * dt;
    danceYaw.setAxisAngle(UP_AXIS, vehicle.yaw);
    // Nose up = negative rotation about the chassis +X (maps +Z toward +Y).
    dancePitch.setAxisAngle(RIGHT_AXIS, -f.pitch);
    danceRot.copyFrom(danceYaw).multiply(dancePitch);
    // Chassis origin = pivot (+ bounce) − R · rearAxleLocal.
    const rl = restHubs[4]!;
    const rr = restHubs[5]!;
    danceTmp.set((rl.x + rr.x) / 2, (rl.y + rr.y) / 2, (rl.z + rr.z) / 2);
    danceRot.rotateVector(danceTmp, danceOut);
    chassis.transform.position = moundPos.set(dancePivot.x - danceOut.x, dancePivot.y + f.bounce - danceOut.y, dancePivot.z - danceOut.z);
    chassis.transform.rotation = danceRot;
    const cp = chassis.transform.position;
    for (let i = 0; i < wheelRoots.length; i++) {
      const hub = restHubs[i]!;
      const d = f.wheels[i]!;
      danceTmp.set(hub.x + d.x, hub.y + d.y, hub.z + d.z);
      // The wheel's suspension arm swings (and reaches) with it.
      const piece = armPieceForWheel(i, hub.x);
      const armEntity = piece ? suspensionEntities.get(piece) : undefined;
      if (piece && armEntity) {
        const [px, py, pz] = SUSPENSION_PIVOTS[piece];
        armPivot.set(px, py + bodyOffsetY, pz);
        armOffset.set(0, bodyOffsetY, 0);
        suspensionArmPose(armPivot, hub, armTarget.copyFrom(danceTmp), armOffset, armPos, armRot);
        armEntity.transform.position = armPos;
        armEntity.transform.rotation = armRot;
      }
      danceRot.rotateVector(danceTmp, danceOut);
      wheelRoots[i]!.transform.position = danceWheelPos.set(cp.x + danceOut.x, cp.y + danceOut.y, cp.z + danceOut.z);
      // Upper wheels wave (spin) on the break; the feet stay still.
      danceSpin.setAxisAngle(RIGHT_AXIS, i < 4 ? danceSpinAngle * (i % 2 === 0 ? 1 : -1) : 0);
      danceWheelRot.copyFrom(danceRot).multiply(danceSpin);
      wheelRoots[i]!.transform.rotation = danceWheelRot;
    }
    for (const j of armJoints) {
      const angle = j.role in f.arm ? f.arm[j.role as keyof YmcaArm] : 0;
      j.entity.transform.rotation = j.rot.setAxisAngle(j.axis, angle);
    }
  }

  // ---------------------------------------------------------------- stage lights (fe-28 finale)

  /** Rainbow spot lights on a truss over the dance: an unlit beam cone + a real spot light each. */
  const stageConeGeometry = track(createCylinder(gpu, { radiusTop: 0.12, radiusBottom: 1.5, height: STAGE_TRUSS_HEIGHT + 2, radialSegments: 20, capped: false }));
  const stageLights = Array.from({ length: STAGE_LIGHT_COUNT }, (_, i) => {
    const material = track(new Material({
      label: `storm-stage-beam-${i}`,
      technique: "unlit",
      color: new Color(1, 1, 1),
      opacity: 0,
      transparent: true,
      doubleSided: true,
      fogExempt: true,
      depthWrite: false,
    }));
    const head = scene.createTransformedEntity(`storm-stage-light-${i}`, new Vec3(SPAWN_X, groundY, SPAWN_Z));
    const cone = addRenderable(`storm-stage-beam-${i}`, new Vec3(0, -(STAGE_TRUSS_HEIGHT + 2) / 2, 0), stageConeGeometry, material, false);
    head.addChild(cone);
    cone.transform.position = new Vec3(0, -(STAGE_TRUSS_HEIGHT + 2) / 2, 0);
    const renderable = scene.world.getComponent(cone.id, Renderable)!;
    renderable.visible = false;
    const light = new Light();
    light.kind = "spot";
    light.castShadow = false;
    light.range = 40;
    light.intensity = 0;
    light.innerCone = Math.cos((10 * Math.PI) / 180);
    light.outerCone = Math.cos((16 * Math.PI) / 180);
    light.affectScene = false;
    scene.world.addComponent(head.id, light);
    return { head, material, renderable, light, rot: new Quat(), colour: { r: 1, g: 1, b: 1 } };
  });
  const stageAim = new Vec3();
  const stageHead = new Vec3();
  /** Place, colour and fade the rig around the dancer (envelope 0 hides it entirely). */
  function stepStageLights(envelope: number, sweep: number): void {
    const on = envelope > 0.001;
    const fx = Math.sin(vehicle.yaw);
    const fz = Math.cos(vehicle.yaw);
    const rx = fz;
    const rz = -fx;
    const gy = groundHeight(dancePivot.x, dancePivot.z);
    for (let i = 0; i < stageLights.length; i++) {
      const rec = stageLights[i]!;
      rec.renderable.visible = on;
      rec.light.affectScene = on;
      rec.light.intensity = on ? 40 * envelope : 0;
      setOpacity(rec.material, on ? 0.1 * envelope : 0);
      if (!on) continue;
      const { head, spot } = stageLightAim(i, sweep);
      stageHead.set(dancePivot.x + rx * head.x + fx * head.z, gy + head.y, dancePivot.z + rz * head.x + fz * head.z);
      stageAim.set(dancePivot.x + rx * spot.x + fx * spot.z - stageHead.x, gy + spot.y - stageHead.y, dancePivot.z + rz * spot.x + fz * spot.z - stageHead.z);
      const len = Math.hypot(stageAim.x, stageAim.y, stageAim.z) || 1;
      // Spot lights shine along −Y: turn +Y onto the reverse of the aim.
      stageAim.set(-stageAim.x / len, -stageAim.y / len, -stageAim.z / len);
      rec.head.transform.position = stageHead;
      rec.head.transform.rotation = rec.rot.fromUnitVectorY(stageAim);
      const c = stageLightColor(i, time, rec.colour);
      rec.light.setColor(c.r, c.g, c.b);
      rec.material.baseColor.set(c.r, c.g, c.b);
      rec.material.markChanged();
    }
  }

  const formatTime = (s: number): string => {
    const m = Math.floor(s / 60);
    const r = Math.floor(s % 60);
    return `${m}:${r.toString().padStart(2, "0")}`;
  };
  const bearingArrow = (a: number): string => {
    const arrows = ["↑", "↗", "→", "↘", "↓", "↙", "←", "↖"];
    // Vehicle yaw grows toward +X from +Z, so a positive bearing is to the rover's right.
    const idx = ((Math.round(a / (Math.PI / 4)) % 8) + 8) % 8;
    return arrows[idx]!;
  };

  const stormState = (): MarsDustStormState => ({
    modelLoaded,
    modelError,
    difficulty,
    quality: qualityTier,
    time,
    intensity,
    phase: storm.phase(time),
    windSpeed: Math.hypot(wind.x, wind.z),
    fogDensity,
    checkpoint: course.index,
    checkpointCount: course.checkpoints.length,
    distanceToBeam: course.distance(vehicle.position.x, vehicle.position.z),
    bearing: course.bearing(vehicle.position.x, vehicle.position.z, vehicle.yaw),
    burial: accumulation.burial,
    stuck,
    flipped: isRoverFlipped(vehicle.roll, vehicle.pitch),
    won: course.state === "won",
    lost: course.state === "lost",
    lostReason: course.lostReason,
    safe: { ...blown.safe },
    blownAway: blownAwayCount,
    invulnerable,
    clearance: lastClearance,
    windLift,
    stormStrength: stormStrength(),
    summaryVisible: summaryShown,
    stats: { distance: stats.distance, maxHeight: stats.maxHeight, topSpeed: stats.topSpeed, maxWind: stats.maxWind, timesLifted: stats.timesLifted, respawns: stats.respawns },
    courseSeed,
    dancePhase,
    stageLights: danceLights,
    stageSweep: danceLights > 0 ? danceSweep : 0,
    jingle: { unlocked: jingle.unlocked, muted: jingle.muted, started: jingleStarted },
    start: { x: start.x, z: start.z, stretch: start.stretch, fallback: start.fallback },
    checkpoints: course.checkpoints.map((c) => ({ x: c.x, z: c.z })),
    clearSky,
    dance: danceLetter,
    dancing,
    arrowVisible: arrowRenderable.visible,
    gear: vehicle.gear < 0 ? -1 : 1,
    guideRoute: guideRoute.map((p) => ({ x: p.x, z: p.z })),
    guideDots: { ...pulseState },
    elapsed: course.elapsed,
    penalty: course.penalty,
    resets: course.resets,
    devils: devils.devils.map((d) => ({ x: d.x, z: d.z, coreRadius: d.coreRadius, swirl: d.swirl, slot: d.slot, state: d.state, opacity: d.opacity, life: d.life })),
    piles: accumulation.piles.map((p) => ({ depth: p.depth, maxDepth: p.maxDepth })),
    x: vehicle.position.x,
    z: vehicle.position.z,
    yaw: vehicle.yaw,
    speed: Math.hypot(vehicle.velocity.x, vehicle.velocity.z),
  });

  return {
    scene,
    cameraEntity,
    controlsHint: "WASD / arrows drive (S / brake backs up once stopped) · Space handbrake · R restart · difficulty (Easy/Advanced/Expert/Unreal) restarts · thrown by a dust devil: respawn (Easy/Advanced) or lose (Expert/Unreal) · reach the light beams in order · keep moving or the dust buries you",
    camera: marsChaseCamera(new Vec3(SPAWN_X, chaseLookY, SPAWN_Z), groundHeight, 60),
    followTarget: marsChaseFollow(vehicle),
    vehicleState: () => ({
      speed: Math.hypot(vehicle.velocity.x, vehicle.velocity.z),
      rpm: vehicle.rpm,
      gear: vehicle.gear,
      x: vehicle.position.x,
      y: vehicle.position.y,
      z: vehicle.position.z,
    }),
    overlay: () => {
      // Read the live state directly: the HUD runs every frame and must not allocate snapshots.
      const x = vehicle.position.x;
      const z = vehicle.position.z;
      const burial = accumulation.burial;
      const penalty = course.penalty > 0 ? ` (+${course.penalty}s)` : "";
      const lines = [
        `storm ${storm.phase(time).toUpperCase()} ${Math.round(intensity * 100)}% · wind ${Math.hypot(wind.x, wind.z).toFixed(0)} m/s · devils ${devils.devils.length} · ${difficulty} · ${qualityTier}`,
        course.state === "lost"
          ? `RUN LOST · ${course.lostReason ?? ""} · press R to retry`
          : course.state === "won"
          ? `STORM SURVIVED · ${formatTime(course.total)}${penalty}${danceLetter ? ` · ${danceLetter}!` : ""}${dancing && jingleStarted ? " · M mutes" : ""}`
          : `beacon ${course.index + 1}/${course.checkpoints.length} ${bearingArrow(course.bearing(x, z, vehicle.yaw))} ${course.distance(x, z).toFixed(0)} m · time ${formatTime(course.total)}${penalty}`,
        `burial ${Math.round(burial * 100)}%${stuck ? " · STUCK — pump throttle" : burial > 0.3 ? " · keep moving!" : ""}${course.resets > 0 ? ` · resets ${course.resets}` : ""}`,
      ];
      if (!modelLoaded) lines.push(modelError ? `rover model failed: ${modelError}` : "rover model loading…");
      if (lastEvent) lines.push(lastEvent);
      return lines.join("\n");
    },
    stormState,
    restart,
    setDifficulty,
    deviceQuality: device,
    advanceFinale: (seconds: number): void => {
      if (dancing && seconds > 0) wonAt -= seconds;
    },
    /** Test / screenshot hook: a wind throw — lift the rover `up` m and carry it (dx, dz) mid-episode. */
    summary: () => stormRunSummary(summaryInput()),
    debugBlow: (dx: number, dz: number, up = 6): void => {
      startupBrake = false;
      blown.episode = true;
      vehicle.position.x += dx;
      vehicle.position.z += dz;
      vehicle.position.y += up;
    },
    teleport: (x: number, z: number): boolean => {
      if (dancing || !Number.isFinite(x) || !Number.isFinite(z)) return false;
      startupBrake = false;
      placeRover(x, z, false);
      return true;
    },
    update,
    dispose(): void {
      disposed = true;
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("pointerdown", unlockAudio);
      window.removeEventListener("pointerup", unlockAudio);
      jingle.dispose();
      if (fadeTimer) clearTimeout(fadeTimer);
      fadeEl?.remove();
      summaryEl?.remove();
      summaryEl = null;
      fadeEl = null;
      window.removeEventListener("keyup", onKeyUp);
      touch.dispose();
      for (const { el, on } of diffButtons) el?.removeEventListener("click", on);
      touchDifficulty?.removeEventListener("click", onToggleDifficulty);
      keys.clear();
      loaded?.dispose();
      loaded = null;
      scene.dispose(); // tile materials/masks before the shared arrays they reference
      for (const resource of disposables) resource.dispose();
      terrainBundle.dispose();
    },
  };
}
