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
 * - Particles: the renderer draws one GPU particle system per scene, so the camera-centred storm
 *   sheet and the devil columns share it: emission alternates between the sheet slab and the devils
 *   frame by frame, and the engine's tangential `swirlStrength` spins dust around the nearest devil.
 * - Beams: tall emissive cylinders with a fog-exempt material, so they read through any density.
 *   The active beam is bright, the next one dim, reached beams switch off.
 * - Quality (D6): `reduced` (iOS Safari, 30 fps target) or `full` (desktop WebGPU) tier.
 *
 * Controls: WASD / arrows + the on-screen stick drive, Space handbrake, R restarts the run.
 */

import {
  Camera,
  Color,
  type Engine,
  type Entity,
  type Geometry,
  GpuParticleWorld,
  Light,
  Material,
  Quat,
  Renderable,
  Rng,
  Scene,
  Vec3,
  VehicleComponent,
  VehicleSystem,
  createCylinder,
  createRock,
  createSphere,
  createTorus,
  heightFunctionGround,
  stormLightFactors,
} from "@forge/engine";
import type { DemoSceneHandle } from "./cubesScene.js";
import { attachVehicleTouch } from "../controls/vehicleTouch.js";
import { loadGlb, type LoadedGlb } from "../assets/glb.js";
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
  LULL_INTENSITY,
  STORM_DIFFICULTY,
  STORM_QUALITY_TIERS,
  STORM_SEED,
  StormCourse,
  StormField,
  devilRoverForce,
  isRoverFlipped,
  pileWindwardPoint,
  stormCheckpointLayout,
  type DevilRoverForce,
  type StormDifficulty,
  type StormPhase,
  type StormQualityTier,
} from "./dustStorm.js";

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
  elapsed: number;
  penalty: number;
  resets: number;
  devils: { x: number; z: number; coreRadius: number; swirl: number }[];
  piles: { depth: number; maxDepth: number }[];
  x: number;
  z: number;
  speed: number;
}

export interface MarsDustStormHandle extends DemoSceneHandle {
  stormState(): MarsDustStormState;
  /** Restart the run from the spawn (R key). */
  restart(): void;
}

export interface MarsDustStormOptions {
  loadGlb?: typeof loadGlb;
  difficulty?: StormDifficulty;
  quality?: StormQualityTier;
}

/** Same surveyed spawn as the Mars Showcase (all six wheels planted on the seed-1337 surface). */
const SPAWN_X = -164;
const SPAWN_Z = 4;
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
const UP = new Vec3(0, 1, 0);

export function buildMarsDustStormScene(engine: Engine, options: MarsDustStormOptions = {}): MarsDustStormHandle {
  const loadModel = options.loadGlb ?? loadGlb;
  const difficulty: StormDifficulty = options.difficulty ?? "easy";
  const rules = STORM_DIFFICULTY[difficulty];
  const qualityTier: StormQualityTier = options.quality ?? "full";
  const quality = STORM_QUALITY_TIERS[qualityTier];
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
  scene.settings.shadow.mapSize = quality.shadowMapSize;
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
      attachStaticRoverModel(scene, chassis, wheelRoots, MARS_ROVER_WHEELS.map((w) => w.name), glb, bodyOffsetY);
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
  const course = new StormCourse(stormCheckpointLayout(SPAWN_X, SPAWN_Z), SPAWN_X, SPAWN_Z);
  // Face the first beam at the start.
  const first = course.checkpoints[0]!;
  vehicle.yaw = Math.atan2(first.x - SPAWN_X, first.z - SPAWN_Z);
  vehicle.placeOnGround(ground);

  // ---------------------------------------------------------------- boulders + their dust piles

  const dustMaterial = track(new Material({ label: "storm-dust-pile", color: Color.fromSrgbHex(0xc08050), roughness: 1, metallic: 0 }));
  const rockMaterial = track(new Material({ label: "storm-boulder", color: Color.fromSrgbHex(0x7a5040), roughness: 0.95, metallic: 0.02 }));
  const boulderGeometry = track(createRock(gpu, { radius: 1, segments: 10, seed: 11, roughness: 0.36, flatten: 0.3 }));
  // A unit dome: the bottom half sits under the ground, so scaling Y raises a mound.
  const moundGeometry = track(createSphere(gpu, { radius: 1, widthSegments: 16, heightSegments: 8 }));

  interface PropRecord {
    x: number;
    z: number;
    radius: number;
    pile: ReturnType<DustAccumulation["addPile"]>;
    mound: Entity;
    moundRenderable: Renderable;
  }
  const props: PropRecord[] = [];
  {
    const rng = new Rng(STORM_SEED + 31);
    const anchors = [{ x: SPAWN_X, z: SPAWN_Z }, ...course.checkpoints];
    for (let i = 0; i < BOULDER_COUNT; i++) {
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
      const y = groundHeight(x, z);
      const boulder = addRenderable(`storm-boulder-${i}`, new Vec3(x, y + radius * 0.35, z), boulderGeometry, rockMaterial);
      boulder.transform.scale = new Vec3(radius, radius, radius);
      const mound = addRenderable(`storm-pile-${i}`, new Vec3(x, y, z), moundGeometry, dustMaterial, false);
      const moundRenderable = mound.get(Renderable)!;
      moundRenderable.visible = false;
      props.push({ x, z, radius, pile: accumulation.addPile(x, z, radius), mound, moundRenderable });
    }
  }

  // The rover's own piles: one on the windward face, one skirt around the wheels.
  const roverWindMound = addRenderable("storm-rover-pile-windward", new Vec3(SPAWN_X, groundY, SPAWN_Z), moundGeometry, dustMaterial, false);
  const roverSkirtMound = addRenderable("storm-rover-pile-skirt", new Vec3(SPAWN_X, groundY, SPAWN_Z), moundGeometry, dustMaterial, false);
  const roverWindRenderable = roverWindMound.get(Renderable)!;
  const roverSkirtRenderable = roverSkirtMound.get(Renderable)!;
  roverWindRenderable.visible = false;
  roverSkirtRenderable.visible = false;

  // ---------------------------------------------------------------- beams

  const beamGeometry = track(createCylinder(gpu, { radiusTop: 1.4, radiusBottom: 1.4, height: BEAM_HEIGHT, radialSegments: 24, capped: false }));
  const ringGeometry = track(createTorus(gpu, { radius: 6, tube: 0.25 }));
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
  }));
  interface BeamRecord {
    beam: Renderable;
    ring: Renderable;
  }
  const beams: BeamRecord[] = course.checkpoints.map((cp, i) => {
    const y = groundHeight(cp.x, cp.z);
    const beamEntity = addRenderable(`storm-beam-${i}`, new Vec3(cp.x, y + BEAM_HEIGHT / 2 - 1, cp.z), beamGeometry, beamNext, false);
    const ringEntity = addRenderable(`storm-beam-ring-${i}`, new Vec3(cp.x, y + 0.3, cp.z), ringGeometry, ringActive, false);
    return { beam: beamEntity.get(Renderable)!, ring: ringEntity.get(Renderable)! };
  });
  const refreshBeams = (): void => {
    for (let i = 0; i < beams.length; i++) {
      const record = beams[i]!;
      const active = i === course.index && course.state !== "won";
      const next = i === course.index + 1;
      record.beam.visible = active || next;
      record.beam.material = active ? beamActive : beamNext;
      record.ring.visible = active;
    }
  };
  refreshBeams();

  // ---------------------------------------------------------------- particles (one GPU system)

  const dust = new GpuParticleWorld({
    name: "storm dust",
    capacity: quality.particleCapacity,
    maxEmitsPerFrame: 4096,
    seed: 0x5d0,
    softParticles: true,
    softScale: 18,
    stretch: 0.8,
    cullDistance: 140,
    emitter: {
      rate: 0,
      lifeMin: 2.2,
      lifeMax: 3.6,
      size: 0.08,
      position: { x: SPAWN_X, y: groundY + 8, z: SPAWN_Z },
      jitter: { x: 60, y: 9, z: 60 },
      coneDir: { x: 1, y: 0, z: 0 },
      coneAngle: 0.25,
      speedMin: 10,
      speedMax: 18,
      color: { r: 0.78, g: 0.48, b: 0.28, a: 0.3 },
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
      colorFrom: { r: 0.78, g: 0.48, b: 0.28, a: 0.3 },
      colorTo: { r: 0.62, g: 0.36, b: 0.2, a: 0 },
      sizeStart: 0.06,
      sizeEnd: 0.14,
      sizeVariation: 0.5,
      rotationSpeed: 0.4,
    },
  });
  scene.add(dust);
  let emitFrame = 0;

  // ---------------------------------------------------------------- input

  const keys = new Set<string>();
  const onKeyDown = (event: KeyboardEvent): void => {
    keys.add(event.code);
    if (event.code === "Space" || event.code.startsWith("Arrow")) event.preventDefault();
    if (event.code === "KeyR" && !event.repeat) restart();
  };
  const onKeyUp = (event: KeyboardEvent): void => {
    keys.delete(event.code);
  };
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
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
  const force: DevilRoverForce = { ax: 0, az: 0, yawAccel: 0, lift: 0, rollAccel: 0 };
  const windward = { x: 0, z: 0 };
  const moundPos = new Vec3();
  const moundScale = new Vec3();
  const moundRot = new Quat();
  const fogColor = new Color(DUST_R, DUST_G, DUST_B);

  const placeRover = (x: number, z: number): void => {
    vehicle.position.x = x;
    vehicle.position.z = z;
    vehicle.velocity.set(0, 0, 0);
    vehicle.yawRate = 0;
    vehicle.pitch = 0;
    vehicle.roll = 0;
    vehicle.pitchRate = 0;
    vehicle.rollRate = 0;
    for (const wheel of vehicle.wheels) wheel.omega = 0;
    const target = course.active;
    if (target) vehicle.yaw = Math.atan2(target.x - x, target.z - z);
    vehicle.placeOnGround(ground);
    accumulation.resetRover();
    stuck = false;
    flippedFor = 0;
  };

  /** Hard-mode rule: back to the last reached beam (or the spawn). */
  const sendBack = (reason: string): void => {
    const p = course.respawnPoint();
    course.resets++;
    placeRover(p.x, p.z);
    lastEvent = `${reason} · BACK TO ${course.lastReached < 0 ? "START" : `BEACON ${course.lastReached + 1}`}`;
  };

  function restart(): void {
    course.index = 0;
    course.elapsed = 0;
    course.penalty = 0;
    course.resets = 0;
    course.state = "driving";
    placeRover(SPAWN_X, SPAWN_Z);
    startupBrake = true;
    lastEvent = "";
    refreshBeams();
  }

  const applyAtmosphere = (): void => {
    const light = stormLightFactors(1, intensity, 0.12, 0.3);
    sun.intensity = 4.2 * light.sun;
    // Lull intensity maps to the lull fog exactly; gusts close it down to a few rover lengths.
    const gust = Math.max(0, Math.min(1, (intensity - LULL_INTENSITY) / (1 - LULL_INTENSITY)));
    fogDensity = FOG_LULL + (FOG_GUST - FOG_LULL) * gust;
    const level = 0.35 + 0.65 * light.ambient;
    fogColor.r = DUST_R * level;
    fogColor.g = DUST_G * level;
    fogColor.b = DUST_B * level;
    scene.setFog("exp2", { density: fogDensity, color: fogColor });
    scene.setBackgroundColor(fogColor);
    scene.setAmbient(ambientColor, 0.25 + 0.25 * light.ambient);
  };
  applyAtmosphere();

  const stepParticles = (): void => {
    const system = dust.system;
    if (!system) return;
    const eye = cameraEntity.transform.position;
    const emitter = system.emitter;
    const modules = system.modules;
    const windLen = Math.hypot(wind.x, wind.z) || 1;
    // Swirl and inflow around the devil nearest the camera: the one the player can see.
    let nearest = devils.devils[0] ?? null;
    let nearestD = Infinity;
    for (const d of devils.devils) {
      const dd = Math.hypot(d.x - eye.x, d.z - eye.z);
      if (dd < nearestD) {
        nearestD = dd;
        nearest = d;
      }
    }
    if (nearest) {
      modules.attractorPos.x = nearest.x;
      modules.attractorPos.y = groundHeight(nearest.x, nearest.z) + 10;
      modules.attractorPos.z = nearest.z;
      modules.attractorStrength = 6;
      modules.swirlStrength = Math.sign(nearest.swirl) * 140;
    } else {
      modules.attractorStrength = 0;
      modules.swirlStrength = 0;
    }
    // Alternate the shared emitter: even frames feed the storm sheet, odd frames one devil column.
    const devilCount = devils.devils.length;
    const sheetFrame = devilCount === 0 || emitFrame % 2 === 0;
    if (sheetFrame) {
      emitter.rate = quality.sheetRate * (0.25 + 0.75 * intensity) * (devilCount === 0 ? 1 : 2);
      emitter.position.x = eye.x - (wind.x / windLen) * 25;
      emitter.position.y = groundHeight(eye.x, eye.z) + 7;
      emitter.position.z = eye.z - (wind.z / windLen) * 25;
      emitter.jitter.x = 60;
      emitter.jitter.y = 8;
      emitter.jitter.z = 60;
      emitter.coneDir.x = wind.x / windLen;
      emitter.coneDir.y = -0.05;
      emitter.coneDir.z = wind.z / windLen;
      emitter.coneAngle = 0.25;
      emitter.speedMin = windLen * 0.6;
      emitter.speedMax = windLen * 1.05;
    } else {
      const d = devils.devils[(emitFrame >> 1) % devilCount]!;
      emitter.rate = quality.devilRate * 2 * devilCount;
      emitter.position.x = d.x;
      emitter.position.y = groundHeight(d.x, d.z) + 1;
      emitter.position.z = d.z;
      emitter.jitter.x = d.coreRadius;
      emitter.jitter.y = 1;
      emitter.jitter.z = d.coreRadius;
      emitter.coneDir.x = 0;
      emitter.coneDir.y = 1;
      emitter.coneDir.z = 0;
      emitter.coneAngle = 0.5;
      emitter.speedMin = 5;
      emitter.speedMax = 11;
    }
    emitFrame++;
  };

  const updateMound = (entity: Entity, renderable: Renderable, x: number, z: number, sx: number, sy: number, sz: number, yaw: number): void => {
    renderable.visible = sy > 0.02;
    if (!renderable.visible) return;
    entity.transform.position = moundPos.set(x, groundHeight(x, z), z);
    entity.transform.scale = moundScale.set(Math.max(0.01, sx), sy, Math.max(0.01, sz));
    entity.transform.rotation = moundRot.setAxisAngle(UP, yaw);
  };

  const stepPiles = (dt: number): void => {
    accumulation.stepPiles(dt, intensity);
    const yaw = Math.atan2(wind.x, wind.z);
    for (const prop of props) {
      pileWindwardPoint(prop.pile, wind.x, wind.z, windward);
      const d = prop.pile.depth;
      updateMound(prop.mound, prop.moundRenderable, windward.x, windward.z, prop.radius * 1.3, d, prop.radius * 0.9, yaw);
    }
    // Rover mounds: windward bank plus a skirt that climbs the wheels as burial grows.
    const b = accumulation.burial;
    const len = Math.hypot(wind.x, wind.z) || 1;
    const rx = vehicle.position.x - (wind.x / len) * 1.5;
    const rz = vehicle.position.z - (wind.z / len) * 1.5;
    updateMound(roverWindMound, roverWindRenderable, rx, rz, 2.4 * Math.sqrt(b), 1.1 * b, 1.4 * Math.sqrt(b), yaw);
    updateMound(roverSkirtMound, roverSkirtRenderable, vehicle.position.x, vehicle.position.z, 1.9, 0.75 * b, 2.1, vehicle.yaw);
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
    if (dt <= 0) return;
    time += dt;
    intensity = storm.intensity(time);
    storm.wind(time, wind);
    applyAtmosphere();
    scene.settings.sky.seaLevel = groundHeight(vehicle.position.x, vehicle.position.z);

    // Devils: step, then push / yaw / lift / roll the rover.
    devils.step(dt, intensity, wind.x, wind.z, vehicle.position.x, vehicle.position.z);
    const clearance = vehicle.position.y - groundHeight(vehicle.position.x, vehicle.position.z);
    for (const devil of devils.devils) {
      devilRoverForce(devil, vehicle.position.x, vehicle.position.z, force);
      if (force.ax === 0 && force.az === 0 && force.yawAccel === 0) continue;
      vehicle.velocity.x += force.ax * dt;
      vehicle.velocity.z += force.az * dt;
      vehicle.yawRate += force.yawAccel * dt;
      if (force.lift > 0 && clearance < 4) {
        vehicle.velocity.y += force.lift * dt;
        vehicle.rollRate += force.rollAccel * dt;
      }
    }

    // Input → vehicle, under the stuck / won rules.
    readMarsDriveInput(keys, touch.sample(), drive);
    if (drive.throttle > 0.01) startupBrake = false;
    const speed = Math.hypot(vehicle.velocity.x, vehicle.velocity.z);
    // The run (clock and burial) starts with the first throttle, not while the model loads.
    const running = !startupBrake && course.state !== "won";
    if (running) accumulation.stepRover(dt, intensity, speed, drive.throttle, stuck);
    const flipped = isRoverFlipped(vehicle.roll, vehicle.pitch);
    if (!stuck && accumulation.burial >= BURIAL_STUCK && course.state !== "won") {
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
    if (flippedFor >= FLIP_GRACE && course.state !== "won") {
      if (rules.onFlip === "reset") {
        sendBack("FLIPPED");
      } else {
        course.penalty += rules.timePenalty;
        placeRover(vehicle.position.x, vehicle.position.z);
        lastEvent = `FLIPPED · RIGHTED · +${rules.timePenalty}s`;
      }
    }
    vehicle.input.throttle = stuck ? 0 : drive.throttle;
    vehicle.input.brake = Math.max(drive.brake, startupBrake || stuck ? 1 : 0);
    vehicle.input.steer = drive.steer;
    vehicle.input.handbrake = drive.handbrake || startupBrake || stuck ? 1 : 0;

    collideProps();
    if (running && course.step(dt, vehicle.position.x, vehicle.position.z)) {
      lastEvent = course.state === "won" ? "STORM SURVIVED" : `BEACON ${course.index} REACHED`;
      refreshBeams();
    }
    stepPiles(dt);
    stepParticles();
  };

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
    elapsed: course.elapsed,
    penalty: course.penalty,
    resets: course.resets,
    devils: devils.devils.map((d) => ({ x: d.x, z: d.z, coreRadius: d.coreRadius, swirl: d.swirl })),
    piles: accumulation.piles.map((p) => ({ depth: p.depth, maxDepth: p.maxDepth })),
    x: vehicle.position.x,
    z: vehicle.position.z,
    speed: Math.hypot(vehicle.velocity.x, vehicle.velocity.z),
  });

  return {
    scene,
    cameraEntity,
    controlsHint: "WASD / arrows drive · Space handbrake · R restart · reach the light beams in order · keep moving or the dust buries you · ?difficulty=hard",
    camera: marsChaseCamera(new Vec3(SPAWN_X, chaseLookY, SPAWN_Z), groundHeight, 60),
    followTarget: marsChaseFollow(vehicle),
    vehicleState: () => ({
      speed: Math.hypot(vehicle.velocity.x, vehicle.velocity.z),
      rpm: vehicle.rpm,
      gear: 1,
      x: vehicle.position.x,
      y: vehicle.position.y,
      z: vehicle.position.z,
    }),
    overlay: () => {
      const s = stormState();
      const lines = [
        `storm ${s.phase.toUpperCase()} ${Math.round(s.intensity * 100)}% · wind ${s.windSpeed.toFixed(0)} m/s · devils ${s.devils.length} · ${difficulty} · ${qualityTier}`,
        s.won
          ? `STORM SURVIVED · ${formatTime(course.total)}${s.penalty > 0 ? ` (incl. +${s.penalty}s)` : ""}`
          : `beacon ${s.checkpoint + 1}/${s.checkpointCount} ${bearingArrow(s.bearing)} ${s.distanceToBeam.toFixed(0)} m · time ${formatTime(course.total)}${s.penalty > 0 ? ` (+${s.penalty}s)` : ""}`,
        `burial ${Math.round(s.burial * 100)}%${s.stuck ? " · STUCK — pump throttle" : s.burial > 0.3 ? " · keep moving!" : ""}${s.resets > 0 ? ` · resets ${s.resets}` : ""}`,
      ];
      if (!modelLoaded) lines.push(modelError ? `rover model failed: ${modelError}` : "rover model loading…");
      if (lastEvent) lines.push(lastEvent);
      return lines.join("\n");
    },
    stormState,
    restart,
    update,
    dispose(): void {
      disposed = true;
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      touch.dispose();
      keys.clear();
      loaded?.dispose();
      loaded = null;
      scene.dispose(); // tile materials/masks before the shared arrays they reference
      for (const resource of disposables) resource.dispose();
      terrainBundle.dispose();
    },
  };
}
