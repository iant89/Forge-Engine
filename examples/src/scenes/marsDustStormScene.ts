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
  Camera,
  Color,
  type Engine,
  type Entity,
  Geometry,
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
  DRIFT_LIFT,
  WaypointArrowState,
  beamPulse,
  waypointArrowEnabled,
  ARROW_IN_MARGIN,
  ARROW_OUT_MARGIN,
  buildArrowMesh,
  buildDrapedRing,
  buildGuidePath,
  guidePathEnabled,
  waypointInView,
  type StripMesh,
  DRIFT_VERTEX_COUNT,
  driftFootprintGrowth,
  devilFunnelHeight,
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
  DEVIL_SWARM_COLOR,
  DEVIL_SWARM_ROCK,
  DEVIL_COARSE_FRACTION,
  DEVIL_COARSE_SCALE,
  DEVIL_SIZE_VARIATION,
  type DevilParticleLook,
  DEVIL_DUST_GRAVITY,
  DEVIL_DUST_DRAG,
  settleDriftMound,
  type DriftMoundMesh,
  type DustDevil,
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
  devils: { x: number; z: number; coreRadius: number; swirl: number; slot: number; state: string; opacity: number; life: number }[];
  piles: { depth: number; maxDepth: number }[];
  x: number;
  z: number;
  speed: number;
}

export interface MarsDustStormHandle extends DemoSceneHandle {
  stormState(): MarsDustStormState;
  /** Restart the run from the spawn (R key). */
  restart(): void;
  /** Switch EASY/HARD (toolbar + touch toggle) and restart the run under the new rules. */
  setDifficulty(difficulty: StormDifficulty): void;
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

export function buildMarsDustStormScene(engine: Engine, options: MarsDustStormOptions = {}): MarsDustStormHandle {
  const loadModel = options.loadGlb ?? loadGlb;
  let difficulty: StormDifficulty = options.difficulty ?? "easy";
  let rules = STORM_DIFFICULTY[difficulty];
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
      props.push({ x, z, radius, pile: accumulation.addPile(x, z, radius), drift: makeDrift(`storm-pile-${i}`, x, z) });
    }
  }

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
      const active = i === course.index && course.state !== "won";
      const next = i === course.index + 1;
      record.beam.visible = active || next;
      record.beam.material = active ? beamActive : beamNext;
      record.ring.visible = active;
    }
  };
  refreshBeams();

  // ---------------------------------------------------------------- guidance (fe-18): easy path + off-screen arrow

  const guideMaterial = track(new Material({
    label: "storm-guide-path",
    technique: "emissive",
    color: Color.fromSrgbHex(0x9fe8ff),
    emissive: Color.fromSrgbHex(0x9fe8ff),
    emissiveStrength: 1.1,
    opacity: 0.22,
    transparent: true,
    doubleSided: true,
    fogExempt: true,
  }));
  let guideMesh: (StripMesh & { baseY: number }) | undefined = buildGuidePath(SPAWN_X, SPAWN_Z, first.x, first.z, groundHeight);
  const guideGeometry = track(Geometry.create(gpu, { label: "storm-guide-path", positions: guideMesh.positions, normals: guideMesh.normals, uvs: guideMesh.uvs, indices: guideMesh.indices }));
  const guideEntity = addRenderable("storm-guide-path", new Vec3(SPAWN_X, guideMesh.baseY, SPAWN_Z), guideGeometry, guideMaterial, false);
  const guideRenderable = guideEntity.get(Renderable)!;
  let guideTimer = 0;
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
  const FORWARD = new Vec3(0, 0, -1);
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
  interface FunnelRecord {
    shadow: DriftRecord;
    shadowMaterial: Material;
  }
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
    });
  }
  /** Sun direction projected on the ground (the shadow falls away from it). */
  const sunAway = { x: -200 / Math.hypot(200, 200), z: -200 / Math.hypot(200, 200) };
  const sunTan = Math.hypot(200, 200) / 300;

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
  // EASY/HARD toggles: toolbar pair and the touch pad's single switch. Each restarts the run.
  const btnEasy = document.getElementById("btn-storm-easy");
  const btnHard = document.getElementById("btn-storm-hard");
  const touchDifficulty = document.getElementById("storm-difficulty");
  const syncDifficultyUi = (): void => {
    const hard = difficulty === "hard";
    btnEasy?.classList.toggle("active", !hard);
    btnEasy?.setAttribute("aria-pressed", String(!hard));
    btnHard?.classList.toggle("active", hard);
    btnHard?.setAttribute("aria-pressed", String(hard));
    if (touchDifficulty) {
      touchDifficulty.classList.toggle("active", hard);
      touchDifficulty.setAttribute("aria-pressed", String(hard));
      const letter = touchDifficulty.querySelector(".veh-letter");
      const caption = touchDifficulty.querySelector(".veh-caption");
      if (letter) letter.textContent = hard ? "H" : "E";
      if (caption) caption.textContent = hard ? "HARD" : "EASY";
    }
  };
  const onEasy = (): void => setDifficulty("easy");
  const onHard = (): void => setDifficulty("hard");
  const onToggleDifficulty = (event: Event): void => {
    event.preventDefault();
    setDifficulty(difficulty === "hard" ? "easy" : "hard");
  };
  btnEasy?.addEventListener("click", onEasy);
  btnHard?.addEventListener("click", onHard);
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
  const force: DevilRoverForce = { ax: 0, az: 0, yawAccel: 0, lift: 0, rollAccel: 0 };
  const windward = { x: 0, z: 0 };
  const moundPos = new Vec3();
  const fogColor = new Color(DUST_R, DUST_G, DUST_B);

  /** Reposition upright, facing the active beam. `clearDust` also empties the rover's pile. */
  const placeRover = (x: number, z: number, clearDust = true): void => {
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
    placeRover(p.x, p.z);
    lastEvent = `${reason} · BACK TO ${course.lastReached < 0 ? "START" : `BEACON ${course.lastReached + 1}`}`;
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
   * pile and the rover's piles, the course, and the rover itself. R and the EASY/HARD toggle use it.
   */
  function restart(): void {
    time = 0;
    intensity = storm.intensity(0);
    wind.x = 0;
    wind.z = 0;
    devils.reset();
    devilEmitFrame = 0;
    accumulation.reset();
    course.reset();
    stuck = false;
    placeRover(SPAWN_X, SPAWN_Z);
    startupBrake = true;
    lastEvent = "";
    applyAtmosphere();
    stepPiles(0); // re-pose the (now empty) mounds
    refreshBeams();
    arrowState.reset();
    guideTimer = 0;
    stepGuidance(0);
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
    // Storm sheet: a wind-driven slab upwind of the camera.
    emitter.rate = quality.sheetRate * (0.25 + 0.75 * intensity);
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
      const gy = groundHeight(d.x, d.z);
      // red-frontier column/skirt alternation (fe-21): the frame counter only picks the emit shape.
      const look = devilParticleLook(d, time, devilEmitFrame, devilLooks[i]);
      const e = sys.emitter;
      // Scale with the life envelope so a consumed or dying devil's column thins out, never pops.
      e.rate = devilEmitRate(quality.devilRate, look, devilEnvelope(d), d.age < DEVIL_BURST_TIME);
      e.position.x = d.x;
      e.position.y = gy + 0.3;
      e.position.z = d.z;
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
      m.attractorPos.x = d.x;
      m.attractorPos.y = gy + 0.3;
      m.attractorPos.z = d.z;
      m.attractorStrength = 0;
      // fe-21: the swarm is the devil, so its grains carry the darker lifted soil tone (not the pale
      // sunlit sheet colour; colorAlt still blends toward rock) and are not stretched into streaks.
      // Per-devil opacity variety (fe-19) now rides on the swarm's own alpha.
      setRgba(e.color, DEVIL_SWARM_COLOR, DEVIL_SWARM_COLOR.a * d.opacity);
      setRgba(m.colorFrom, DEVIL_SWARM_COLOR, DEVIL_SWARM_COLOR.a * d.opacity);
      setRgba(m.colorTo, DEVIL_SWARM_COLOR, 0);
      setRgba(m.colorAlt, DEVIL_SWARM_ROCK, 1);
      sys.stretch = 0.15;
      m.axisPull = look.axisPull;
      const lean = (m.axisLean ??= { x: 0, y: 1, z: 0 });
      lean.x = look.leanX;
      lean.y = look.axisHeight;
      lean.z = look.leanZ;
      // Modules act on every live particle of the system, so they stay fixed across the column/skirt
      // frame alternation (a blend of red-frontier's column 0/0.4 and skirt 1.2/1.6 gravity/drag).
      m.gravity.y = DEVIL_DUST_GRAVITY;
      m.drag = DEVIL_DUST_DRAG;
      m.swirlStrength = look.swirl;
      m.sizeStart = look.sizeStart;
      m.sizeEnd = look.sizeEnd;
      m.sizeVariation = DEVIL_SIZE_VARIATION;
      m.coarseFraction = DEVIL_COARSE_FRACTION;
      m.coarseScale = DEVIL_COARSE_SCALE;
      // fe-21d: the storm wind drags the base cloud downwind, much harder in gusts.
      devilBaseWind(wind.x, wind.z, intensity, (m.groundWind ??= { x: 0, z: 0 }));
      m.groundWindHeight = DEVIL_BASE_CLOUD.windHeight;
    }
    devilEmitFrame++;
    stepFunnels();
  };

  let devilEmitFrame = 0;
  const stepFunnels = (): void => {
    for (let i = 0; i < funnels.length; i++) {
      const f = funnels[i]!;
      const d: DustDevil | undefined = devils.bySlot(i);
      const env = d ? devilEnvelope(d) : 0;
      if (!d || env <= 0.01) {
        f.shadow.renderable.visible = false;
        continue;
      }
      const height = devilFunnelHeight(d.coreRadius) * devilVortexLife(d).growth;
      // Ground shadow: a thin draped ellipse stretched away from the sun.
      const len = Math.min(height * sunTan, 60) * 0.5;
      setOpacity(f.shadowMaterial, 0.32 * env * (0.5 + 0.5 * stormLightFactors(1, intensity, 0.12, 0.3).sun));
      updateDrift(f.shadow, d.x + sunAway.x * len, d.z + sunAway.z * len, 0.001, len, d.coreRadius * 0.6, Math.atan2(sunAway.z, sunAway.x), true);
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
        placeRover(vehicle.position.x, vehicle.position.z, false);
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
    stepGuidance(dt);
  };

  /** Easy-mode draped path (rebuilt ~5×/s) and the easy-mode off-screen beam arrow. */
  function stepGuidance(dt: number): void {
    const target = course.active;
    const vx = vehicle.position.x;
    const vz = vehicle.position.z;
    guideRenderable.visible = guidePathEnabled(difficulty, !!target);
    guideTimer -= dt;
    if (guideRenderable.visible && target && guideTimer <= 0) {
      guideTimer = 0.2;
      guideMesh = buildGuidePath(vx, vz, target.x, target.z, groundHeight, guideMesh);
      guideGeometry.updateFrom({ positions: guideMesh.positions, normals: guideMesh.normals, uvs: guideMesh.uvs, indices: guideMesh.indices });
      guideEntity.transform.position = moundPos.set(vx, guideMesh.baseY, vz);
    }
    stepBeamPulse();
    if (!target || !waypointArrowEnabled(difficulty)) {
      arrowState.reset();
      arrowRenderable.visible = false;
      return;
    }
    const eye = cameraEntity.transform.position;
    cameraEntity.transform.rotation.rotateVector(FORWARD, camForward);
    // Aim at the beam a few metres up (the ring + lower beam are what the player looks for).
    const tp = { x: target.x, y: groundHeight(target.x, target.z) + 6, z: target.z };
    const aspect = camera.aspectOverride > 0 ? camera.aspectOverride : (typeof window !== "undefined" && window.innerHeight > 0 ? window.innerWidth / window.innerHeight : 16 / 9);
    const inner = waypointInView(eye, camForward, tp, camera.fovY, aspect, ARROW_IN_MARGIN);
    const outer = waypointInView(eye, camForward, tp, camera.fovY, aspect, ARROW_OUT_MARGIN);
    arrowRenderable.visible = arrowState.step(dt, inner, outer, waypointArrowEnabled(difficulty));
    if (!arrowRenderable.visible) return;
    const heading = Math.atan2(target.z - vz, target.x - vx);
    arrowEntity.transform.position = moundPos.set(vx, vehicle.position.y + 3.6 + 0.15 * Math.sin(time * 3), vz);
    // Local +X points along the arrow; a Y rotation by −heading maps +X onto (cos h, 0, sin h).
    arrowEntity.transform.rotation = arrowRot.setAxisAngle(UP_AXIS, -heading);
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
    elapsed: course.elapsed,
    penalty: course.penalty,
    resets: course.resets,
    devils: devils.devils.map((d) => ({ x: d.x, z: d.z, coreRadius: d.coreRadius, swirl: d.swirl, slot: d.slot, state: d.state, opacity: d.opacity, life: d.life })),
    piles: accumulation.piles.map((p) => ({ depth: p.depth, maxDepth: p.maxDepth })),
    x: vehicle.position.x,
    z: vehicle.position.z,
    speed: Math.hypot(vehicle.velocity.x, vehicle.velocity.z),
  });

  return {
    scene,
    cameraEntity,
    controlsHint: "WASD / arrows drive · Space handbrake · R restart · EASY/HARD toggle restarts · reach the light beams in order · keep moving or the dust buries you",
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
      // Read the live state directly: the HUD runs every frame and must not allocate snapshots.
      const x = vehicle.position.x;
      const z = vehicle.position.z;
      const burial = accumulation.burial;
      const penalty = course.penalty > 0 ? ` (+${course.penalty}s)` : "";
      const lines = [
        `storm ${storm.phase(time).toUpperCase()} ${Math.round(intensity * 100)}% · wind ${Math.hypot(wind.x, wind.z).toFixed(0)} m/s · devils ${devils.devils.length} · ${difficulty} · ${qualityTier}`,
        course.state === "won"
          ? `STORM SURVIVED · ${formatTime(course.total)}${penalty}`
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
    update,
    dispose(): void {
      disposed = true;
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      touch.dispose();
      btnEasy?.removeEventListener("click", onEasy);
      btnHard?.removeEventListener("click", onHard);
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
