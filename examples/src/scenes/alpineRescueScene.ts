/**
 * Alpine Search & Rescue: Whiteout Run (`?scene=alpine-rescue`).
 *
 * A mountain-rescue 4×4 carries a medical kit up a service track, lights three distress beacons and
 * comes home as a snowstorm closes in. The ground, road, truck and weather are all engine systems
 * doing what they were built for:
 *
 * - **Terrain**: a streamed `TerrainWorld` whose pipeline grades the road and depot pad into every
 *   chunk (`TrackGradingGenerator`), drawn with the four-layer PBR splat material (snow, rock,
 *   scree, tundra) weighted by slope, curvature and noise (`alpineTerrain.ts`).
 * - **Snow**: the engine's weather snow cover settles on every up-facing surface — ground, boulders,
 *   boughs, the truck's roof — and drives tyre grip, so the route gets slippery as it buries.
 *   (This replaces a translucent overlay mesh that z-fought the terrain.)
 * - **Vehicle**: the engine raycast 4×4 on a lofted wagon body with lathe-turned winter tyres. The
 *   wheel entities are roots posed by `VehicleSystem` in world space — never children of the chassis.
 * - **World**: procedural spruce forest, boulders, wheel tracks in the snow, a depot and beacon towers.
 *
 * The mission (load the kit, light ECHO 01/02, deliver at ECHO 03, return) and every snapshot / DOM
 * hook are unchanged.
 */

import {
  AudioSystem,
  Camera,
  ColliderComponent,
  Color,
  DayNightCycle,
  EnvironmentSoundscape,
  Geometry,
  GpuParticleWorld,
  HeightfieldShape,
  ImpactSoundAnalyzer,
  ImpactSoundscape,
  Light,
  LightningSystem,
  Material,
  PhysicsSystem,
  PhysicsWorld,
  Quat,
  Renderable,
  RigidBodyComponent,
  Scene,
  TerrainWorld,
  Texture,
  TireTrackLayer,
  Vec3,
  Vehicle,
  VehicleAudio,
  VehicleComponent,
  VehicleSystem,
  VegetationField,
  WeatherSystem,
  ambienceSoundInput,
  barkPixels,
  boxGeometrySource,
  createBox,
  createCylinder,
  createTorus,
  createVehicleChassis,
  createVehicleConfig,
  cylinderGeometrySource,
  fbm2,
  generateTree,
  hash2i,
  heightFunctionGround,
  rockGeometrySource,
  setAudioListener,
  setWorldSurfaceGripField,
  smoothstep,
  sphereGeometrySource,
  tierValue,
  type DeviceTier,
  type Engine,
  type GeometrySource,
  type ImpactMaterial,
  type RigidBody,
  type TreeSpecies,
  type VegetationModel,
  type WeatherState,
} from "@forge/engine";
import type { DemoSceneHandle } from "./cubesScene.js";
import { attachVehicleTouch } from "../controls/vehicleTouch.js";
import { ALPINE_SNOWPACK_INITIAL_DEPTH_M, ALPINE_SNOWPACK_MAX_DEPTH_M, advanceAlpineSnowpack, alpineSnowCover01, alpineSnowShade01 } from "./alpineSnowpack.js";
import {
  ALPINE_SEED,
  BASE_Z,
  DEPOT_APPROACH_X,
  DEPOT_APPROACH_Z,
  DEPOT_HUT_X,
  DEPOT_X,
  INTERACT_RADIUS,
  RELAY_SITES,
  ROAD_START_Z,
  ROUTE_END_Z,
  ROUTE_X,
  designAlpineRoute,
  roadRibbonSource,
  type RouteProjection,
} from "./alpineRoute.js";
import { AlpineTerrainMaterial, alpineNaturalHeight, createAlpinePipeline, createGradedHeight } from "./alpineTerrain.js";
import { buildRescueTruckSources } from "./alpineRescueVehicle.js";
import { MeshBuilder, chain, prismSource, roundedBoxSource, rotateX, rotateZ, translate, tubeBetween } from "./meshKit.js";
import {
  createAlpineSurfaceTextures,
  createHiVisStripeTextures,
  createSnowRoadTextures,
  createTyreTreadTextures,
  disposeMaterialTextureSet,
  disposeSplatTextureSet,
  spruceBoughPixels,
  type MaterialTextureSet,
} from "../textures/alpine.js";

export type WeatherPresetName = "clear" | "overcast" | "rain" | "storm";

/**
 * The demo's four weather states. The engine's built-in presets are mid-latitude (overcast 14 °C,
 * storm 12 °C), which would melt the snow and make "snow" fall as rain; these hold the air below
 * freezing so the engine's own surface model (snow lies, grip drops) is physically consistent.
 * `rain` is the snow-squall step between overcast and the storm.
 */
export const ALPINE_WEATHER: Readonly<Record<WeatherPresetName, Readonly<Partial<WeatherState>>>> = Object.freeze({
  clear: Object.freeze({ windSpeed: 3, windDirection: 0.9, gust: 0.2, temperatureC: -3, humidity01: 0.45, precipitation01: 0, storm01: 0, cloudCoverage: 0.3 }),
  overcast: Object.freeze({ windSpeed: 6, windDirection: 0.92, gust: 0.42, temperatureC: -5, humidity01: 0.82, precipitation01: 0.05, storm01: 0.04, cloudCoverage: 0.74 }),
  rain: Object.freeze({ windSpeed: 10, windDirection: 1.1, gust: 0.65, temperatureC: -7, humidity01: 0.93, precipitation01: 0.55, storm01: 0.3, cloudCoverage: 0.95 }),
  storm: Object.freeze({ windSpeed: 16, windDirection: 1.45, gust: 1, temperatureC: -10, humidity01: 1, precipitation01: 1, storm01: 1, cloudCoverage: 1 }),
});

type RescueStage = "load-kit" | "relay-1" | "relay-2" | "deliver-kit" | "return" | "complete";

interface RescueObjective {
  stage: RescueStage;
  title: string;
  detail: string;
  x: number;
  z: number;
}

interface BeaconVisual {
  ring: Renderable;
  light: Light;
  active: boolean;
}

export interface AlpineRescueSnapshot {
  mission: string;
  stage: RescueStage;
  objective: string;
  objectiveDistance: number;
  beaconsActivated: number;
  cargoLoaded: boolean;
  cargoDelivered: boolean;
  returnToBase: boolean;
  complete: boolean;
  weatherTarget: WeatherPresetName;
  weatherIntensity: number;
  /** Estimated active billboard count (the GPU particle buffer is not read back to the CPU). */
  snowAlive: number;
  /** Cumulative particles emitted by the GPU simulation. */
  snowEmitted: number;
  /** Current deposited snow depth on the route surface. */
  snowpackDepthM: number;
  /** The engine weather snow cover (0 bare … 1 buried) the renderer and the tyre-grip factor read. */
  snowCover: number;
  temperatureC: number;
  /** Surface-grip multiplier currently applied to the truck's tyres (weather × road/off-road). */
  grip: number;
  speedKph: number;
  headlightsOn: boolean;
  parked: boolean;
  dynamicProps: number;
  routeLength: number;
  positionX: number;
  positionY: number;
  positionZ: number;
  physicsBodies: number;
  physicsSteps: number;
  /** Instanced spruce in the forest field and resident wheel-track tiles. */
  trees: number;
  trackTiles: number;
  /** Phase 20.7/20.8 audio (opt-in: M / SOUND). */
  sound: { enabled: boolean; running: boolean; engineHz: number; impacts: number; impactsDropped: number; scrapes: number; voices: number };
}

export interface AlpineRescueOptions {
  /** Quality tier (forest density, texture sizes, shadows, effects). Default `"high"`. */
  deviceTier?: DeviceTier;
}

export interface AlpineRescueSceneHandle extends DemoSceneHandle {
  interact(): boolean;
  setWeatherTarget(preset: WeatherPresetName): void;
  /** Gate/screenshot hook: put the truck on the road at arc length `s` (+ lateral offset), at rest. */
  placeTruck(s: number, lateral?: number): void;
  /** Gate/screenshot hook: set the deposited snow depth (m), updating the engine's snow cover now. */
  setSnowpackDepth(depthM: number): void;
  snapshot(): AlpineRescueSnapshot;
}

function seededNoise(index: number, salt: number): number {
  const value = Math.sin(index * 127.1 + salt * 311.7) * 43_758.5453;
  return value - Math.floor(value);
}

function addRenderable(
  scene: Scene,
  name: string,
  position: Vec3,
  geometry: Geometry,
  material: Material,
  castShadow = true,
): ReturnType<Scene["createTransformedEntity"]> {
  const entity = scene.createTransformedEntity(name, position);
  const renderable = new Renderable();
  renderable.geometry = geometry;
  renderable.material = material;
  renderable.castShadow = castShadow;
  scene.world.addComponent(entity.id, renderable);
  return entity;
}

function addChildRenderable(
  scene: Scene,
  parent: ReturnType<Scene["createTransformedEntity"]>,
  name: string,
  localPosition: Vec3,
  geometry: Geometry,
  material: Material,
  castShadow = true,
): ReturnType<Scene["createTransformedEntity"]> {
  const entity = addRenderable(scene, name, localPosition, geometry, material, castShadow);
  parent.addChild(entity);
  return entity;
}

function makeBoxBody(
  entity: ReturnType<Scene["createTransformedEntity"]>,
  halfExtents: { x: number; y: number; z: number },
  options: { mass?: number; friction?: number; restitution?: number } = {},
): RigidBodyComponent {
  const collider = new ColliderComponent();
  collider.setBox(halfExtents.x, halfExtents.y, halfExtents.z);
  const body = new RigidBodyComponent();
  body.bodyType = options.mass === undefined ? "static" : "dynamic";
  body.mass = options.mass ?? 0;
  body.friction = options.friction ?? 0.72;
  body.restitution = options.restitution ?? 0.08;
  entity.add(collider);
  entity.add(body);
  return body;
}

/** Uniform [0, 1) from integer coordinates: the deterministic dice behind placement. */
function dice(x: number, z: number, salt: number): number {
  return hash2i(x * 7919 + salt, z, ALPINE_SEED) / 4294967296;
}

export function buildAlpineRescueScene(engine: Engine, options: AlpineRescueOptions = {}): AlpineRescueSceneHandle {
  const tier: DeviceTier = options.deviceTier ?? "high";
  const scene = new Scene({ name: "Alpine Search & Rescue: Whiteout Run" });
  const ownedGeometries: Geometry[] = [];
  const ownedMaterials: Material[] = [];
  const ownedTextures: Array<{ dispose(): void }> = [];
  const ownGeometry = <T extends Geometry>(geometry: T): T => {
    ownedGeometries.push(geometry);
    return geometry;
  };
  const ownMaterial = <T extends Material>(material: T): T => {
    ownedMaterials.push(material);
    return material;
  };
  const geo = (source: GeometrySource): Geometry => ownGeometry(Geometry.create(engine.gpu, source));
  const tex = (width: number, height: number, pixels: Uint8Array, label: string, srgb = true): Texture => {
    const texture = Texture.fromRgba8(engine.gpu, width, height, pixels, { label, srgb, mipmaps: true });
    ownedTextures.push(texture);
    return texture;
  };
  const withMaps = (material: Material, set: MaterialTextureSet): Material => {
    material.setMaps({ albedo: set.albedo, normal: set.normal, metallicRoughness: set.metallicRoughness });
    return material;
  };

  // ------------------------------------------------------------------ road + terrain
  const route = designAlpineRoute(alpineNaturalHeight());
  const gradedHeight = createGradedHeight(route.corridors);
  const surfaceTextures = createAlpineSurfaceTextures(engine.gpu, tierValue(tier, { low: 128, medium: 256, high: 256 }));
  ownedTextures.push({ dispose: () => disposeSplatTextureSet(surfaceTextures.maps) });
  const groundMaterial = new AlpineTerrainMaterial(surfaceTextures.maps, surfaceTextures.meanLinear);
  // The apron beyond the streamed tiles is one flat, snowy colour.
  const horizonMaterial = ownMaterial(new Material({ label: "alpine horizon snow", color: Color.fromSrgbHex(0xc9d4da), roughness: 0.95, metallic: 0 }));
  const terrain = new TerrainWorld({
    seed: ALPINE_SEED,
    viewDistance: tierValue(tier, { low: 420, medium: 520, high: 600 }),
    maxLOD: 3,
    chunkSize: 128,
    chunkResolution: 33,
    maxChunksLoaded: 78,
    maxGenerationsPerFrame: 2,
    warmUpChunks: 14,
    pipeline: createAlpinePipeline(route.corridors),
    layeredMaterial: groundMaterial,
    material: horizonMaterial,
  });
  scene.add(terrain);

  const heightAt = (x: number, z: number) => terrain.getHeightAt(x, z);
  const groundAt = heightFunctionGround(heightAt);
  const terrainPhysics = new HeightfieldShape({
    sampleHeight: heightAt,
    sampleNormal: (x, z, out) => terrain.getNormalAt(x, z, out),
  });
  const physicsWorld = new PhysicsWorld({ gravity: new Vec3(0, -9.81, 0), fixedDt: 1 / 60, maxSubsteps: 8 });
  const terrainBody = physicsWorld.setHeightfield(terrainPhysics);
  // Crates and boulders slide on snow far more readily than on dry ground.
  if (terrainBody) terrainBody.friction = 0.62;

  // The plough-packed trail: a ribbon on the graded bed, lit and normal-mapped (ruts, banks, grit).
  const roadTextures = createSnowRoadTextures(engine.gpu, {
    halfSpan: 3.4,
    roadHalfWidth: 2.7,
    rutOffset: 0.85,
    rutWidth: 0.34,
    metersAlong: 8,
    width: tierValue(tier, { low: 128, medium: 256, high: 256 }),
    height: tierValue(tier, { low: 256, medium: 512, high: 512 }),
  });
  ownedTextures.push({ dispose: () => disposeMaterialTextureSet(roadTextures) });
  const roadMaterial = withMaps(ownMaterial(new Material({ label: "alpine packed-snow trail", color: 0xffffff, roughness: 1, metallic: 0 })), roadTextures);
  const roadGeometry = geo(
    roadRibbonSource(route, {
      halfSpan: 3.4,
      across: tierValue(tier, { low: 7, medium: 9, high: 11 }),
      alongStep: tierValue(tier, { low: 2.5, medium: 1.5, high: 1.0 }),
      lift: 0.035,
      uvMetersAlong: 8,
    }),
  );
  addRenderable(scene, "Packed snow rescue trail", new Vec3(), roadGeometry, roadMaterial, false);

  // Marker stakes along both edges: fibreglass poles with reflective teal caps (they carry the
  // route through a whiteout).
  const stakeMaterial = ownMaterial(new Material({ label: "trail stake", color: Color.fromSrgbHex(0xd9a441), roughness: 0.6, metallic: 0 }));
  const trailStakeGeometry = ownGeometry(createBox(engine.gpu, { width: 0.07, height: 1.7, depth: 0.07 }));
  const trailCapGeometry = ownGeometry(createBox(engine.gpu, { width: 0.18, height: 0.22, depth: 0.1 }));
  const trailCapMaterial = ownMaterial(Material.emissive(0x4bd7c4, 1.3, { label: "trail marker teal" }));
  const stakeCount = Math.floor((route.length - 36) / 20);
  for (let i = 0; i < stakeCount; i++) {
    const pose = route.poseAt(18 + i * 20);
    for (const side of [-1, 1]) {
      // Right of travel is (cos yaw, -sin yaw) for heading `yaw` (0 = +Z, +X positive).
      const px = pose.x + Math.cos(pose.yaw) * side * 4.1;
      const pz = pose.z - Math.sin(pose.yaw) * side * 4.1;
      const py = heightAt(px, pz);
      const post = addRenderable(scene, `Trail marker ${i + 1} ${side < 0 ? "left" : "right"}`, new Vec3(px, py + 0.8, pz), trailStakeGeometry, stakeMaterial);
      addChildRenderable(scene, post, `Trail marker glint ${i + 1}`, new Vec3(0, 0.78, 0), trailCapGeometry, trailCapMaterial, false);
    }
  }

  // ------------------------------------------------------------------ materials
  const timberMaterial = ownMaterial(new Material({ label: "rescue station timber", color: Color.fromSrgbHex(0x86705a), roughness: 0.88 }));
  const roofMetalMaterial = ownMaterial(new Material({ label: "rescue station roof", color: Color.fromSrgbHex(0x3e484d), roughness: 0.5, metallic: 0.6 }));
  const redMaterial = ownMaterial(new Material({ label: "rescue red", color: Color.fromSrgbHex(0xc43c24), roughness: 0.5, metallic: 0.08 }));
  const darkMetalMaterial = ownMaterial(Material.metal(0x303a40, 0.42));
  const beaconDimMaterial = ownMaterial(Material.emissive(0x29a9a8, 0.65, { label: "inactive beacon ring" }));
  const beaconActiveMaterial = ownMaterial(Material.emissive(0x68ffd9, 3.4, { label: "active beacon ring" }));
  const beaconDoneMaterial = ownMaterial(Material.emissive(0x94ee85, 1.5, { label: "completed beacon ring" }));
  const warmWindowMaterial = ownMaterial(Material.emissive(0xffc772, 1.4, { label: "depot window glow" }));
  const baseLightMaterial = ownMaterial(Material.emissive(0xf1d58a, 1.1, { label: "station lantern" }));
  const cargoMaterial = ownMaterial(new Material({ label: "medical supply case", color: Color.fromSrgbHex(0x2f9c86), emissive: Color.fromSrgbHex(0x1c6d5f), emissiveStrength: 0.22, metallic: 0.12, roughness: 0.45 }));
  const caseTrimMaterial = ownMaterial(new Material({ label: "case trim", color: Color.fromSrgbHex(0x1b2a2c), roughness: 0.6, metallic: 0.3 }));
  const crossMaterial = ownMaterial(new Material({ label: "case cross", color: Color.fromSrgbHex(0xf4f4f1), emissive: Color.fromSrgbHex(0xffffff), emissiveStrength: 0.35, roughness: 0.5 }));
  const crateMaterial = ownMaterial(new Material({ label: "trail cargo crate", color: Color.fromSrgbHex(0x9b6e44), roughness: 0.85 }));
  const crateFrameMaterial = ownMaterial(new Material({ label: "crate frame", color: Color.fromSrgbHex(0x4e3a29), roughness: 0.9 }));
  const drumMaterial = ownMaterial(new Material({ label: "fuel drum", color: Color.fromSrgbHex(0x2d5f8a), roughness: 0.5, metallic: 0.5 }));
  const rockMaterials = [0x6b7073, 0x585d61, 0x7d7f7c].map((hex, i) => ownMaterial(new Material({ label: `granite ${i}`, color: Color.fromSrgbHex(hex), roughness: 0.96, metallic: 0 })));

  // ------------------------------------------------------------------ depot
  // A timber outpost on the graded pad: gabled steel roof, warm windows, radio mast, fuel drums.
  const baseHeight = heightAt(DEPOT_HUT_X, BASE_Z);
  const depotGround = heightAt(DEPOT_X, BASE_Z);
  const base = scene.createTransformedEntity("Whiteout Run rescue depot", new Vec3(DEPOT_HUT_X, baseHeight, BASE_Z));
  const hutWalls = new MeshBuilder();
  hutWalls.add(roundedBoxSource({ width: 5.7, height: 2.75, depth: 4.5, radius: 0.05, segments: 2 }), translate(0, 1.3, -0.55));
  for (const z of [-2.8, 1.7]) for (const x of [-2.9, 2.9]) hutWalls.add(roundedBoxSource({ width: 0.2, height: 2.85, depth: 0.2, radius: 0.03, segments: 2 }), translate(x, 1.33, z + (z > 0 ? 0.0 : 0.0)));
  hutWalls.add(prismSource(5.7, 1.2, 4.5), translate(0, 2.68, -0.55));
  addChildRenderable(scene, base, "Rescue depot walls", new Vec3(), geo(hutWalls.build("depot-walls")), timberMaterial);
  const roofBuilder = new MeshBuilder();
  const slope = Math.atan2(1.2, 2.25 + 0.35);
  const panelLength = Math.hypot(1.2, 2.25 + 0.35) + 0.08;
  for (const side of [-1, 1]) {
    // Each panel pivots at the ridge and falls toward its eave, overhanging the wall by 0.35 m.
    roofBuilder.add(
      boxGeometrySource({ width: 6.3, height: 0.14, depth: panelLength }),
      chain(translate(0, 0, side * panelLength * 0.5), rotateX(-side * slope), translate(0, 2.68 + 1.2 + 0.05, -0.55)),
    );
  }
  roofBuilder.add(roundedBoxSource({ width: 6.34, height: 0.12, depth: 0.28, radius: 0.04, segments: 2 }), translate(0, 2.68 + 1.2 + 0.1, -0.55));
  addChildRenderable(scene, base, "Rescue depot roof", new Vec3(), geo(roofBuilder.build("depot-roof")), roofMetalMaterial);
  addChildRenderable(scene, base, "Rescue depot door", new Vec3(0, 1.08, 1.72), geo(boxGeometrySource({ width: 1.5, height: 2.1, depth: 0.14 })), redMaterial);
  const windows = new MeshBuilder();
  for (const x of [-1.9, 1.9]) windows.add(boxGeometrySource({ width: 0.9, height: 0.7, depth: 0.08 }), translate(x, 1.5, 1.72));
  windows.add(boxGeometrySource({ width: 0.08, height: 0.7, depth: 0.9 }), translate(2.88, 1.5, -0.6));
  windows.add(boxGeometrySource({ width: 0.08, height: 0.7, depth: 0.9 }), translate(-2.88, 1.5, -0.6));
  addChildRenderable(scene, base, "Rescue depot windows", new Vec3(), geo(windows.build("depot-windows")), warmWindowMaterial, false);
  addChildRenderable(scene, base, "SAR DEPOT sign", new Vec3(0, 2.95, 1.84), geo(boxGeometrySource({ width: 3.2, height: 0.5, depth: 0.12 })), beaconDoneMaterial, false);
  for (const side of [-1, 1]) {
    const lantern = scene.createTransformedEntity(`Depot lantern ${side}`, new Vec3(side * 2.22, 2.6, 1.9));
    const lanternLight = new Light();
    lanternLight.kind = "point";
    lanternLight.setColor(1, 0.72, 0.43);
    lanternLight.intensity = 18;
    lanternLight.range = 19;
    lantern.add(lanternLight);
    base.addChild(lantern);
    addChildRenderable(scene, base, `Depot lantern glow ${side}`, new Vec3(side * 2.22, 2.6, 1.96), geo(roundedBoxSource({ width: 0.26, height: 0.3, depth: 0.14, radius: 0.04, segments: 2 })), baseLightMaterial, false);
  }
  // Radio mast with a red aviation lamp, fuel drums and a stack of crates beside the hut.
  const mast = new MeshBuilder();
  const mastTube = tubeBetween([3.4, 0, -2.4], [3.4, 6.4, -2.4], 0.07, 8);
  mast.add(mastTube.source, mastTube.transform);
  for (const [dx, dz] of [[-1, -1], [1, -1], [0, 1]] as const) {
    const stay = tubeBetween([3.4 + dx * 1.7, 0, -2.4 + dz * 1.7], [3.4, 5.2, -2.4], 0.012, 5);
    mast.add(stay.source, stay.transform);
  }
  addChildRenderable(scene, base, "Depot radio mast", new Vec3(), geo(mast.build("depot-mast")), darkMetalMaterial);
  addChildRenderable(scene, base, "Depot mast lamp", new Vec3(3.4, 6.5, -2.4), geo(sphereGeometrySource({ radius: 0.11, widthSegments: 10, heightSegments: 6 })), beaconActiveMaterial, false);
  const drums = new MeshBuilder();
  for (const [x, z] of [[-3.7, 1.4], [-3.7, 0.5], [-3.7, -0.4]] as const) drums.add(cylinderGeometrySource({ radiusTop: 0.29, radiusBottom: 0.29, height: 0.9, radialSegments: 14, capped: true }), translate(x, 0.45, z));
  addChildRenderable(scene, base, "Depot fuel drums", new Vec3(), geo(drums.build("depot-drums")), drumMaterial);
  // A low plinth makes the base beacon legible from the approach.
  const beaconRingGeometry = ownGeometry(createTorus(engine.gpu, { radius: 2.4, tube: 0.1 }));
  const baseMarker = addRenderable(scene, "Rescue depot navigation ring", new Vec3(DEPOT_X, depotGround + 0.18, BASE_Z + 4), beaconRingGeometry, beaconDimMaterial, false);
  baseMarker.transform.scale = new Vec3(0.68, 0.68, 0.68);

  // ------------------------------------------------------------------ relay beacons
  const tower = new MeshBuilder();
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2 + 0.4;
    const leg = tubeBetween([Math.cos(a) * 0.95, 0, Math.sin(a) * 0.95], [Math.cos(a) * 0.1, 2.5, Math.sin(a) * 0.1], 0.04, 6);
    tower.add(leg.source, leg.transform);
  }
  const towerMast = tubeBetween([0, 0, 0], [0, 3.5, 0], 0.075, 8);
  tower.add(towerMast.source, towerMast.transform);
  tower.add(cylinderGeometrySource({ radiusTop: 0.5, radiusBottom: 0.55, height: 0.08, radialSegments: 14, capped: true }), translate(0, 0.04, 0));
  tower.add(sphereGeometrySource({ radius: 0.34, widthSegments: 14, heightSegments: 6, thetaLength: 1.1 }), chain(rotateZ(Math.PI / 2 - 0.25), translate(0.18, 2.95, 0)));
  const towerGeometry = geo(tower.build("beacon-tower"));
  const housing = new MeshBuilder();
  housing.add(roundedBoxSource({ width: 0.62, height: 0.4, depth: 0.5, radius: 0.06, segments: 3 }), translate(0, 2.3, 0));
  housing.add(roundedBoxSource({ width: 0.3, height: 0.14, depth: 0.3, radius: 0.04, segments: 2 }), translate(0, 3.58, 0));
  const housingGeometry = geo(housing.build("beacon-housing"));
  const beaconLampGeometry = ownGeometry(createCylinder(engine.gpu, { radiusTop: 0.13, radiusBottom: 0.13, height: 0.2, radialSegments: 12 }));
  const beaconVisuals: BeaconVisual[] = [];
  for (let i = 0; i < RELAY_SITES.length; i++) {
    const site = RELAY_SITES[i]!;
    const y = heightAt(site.x, site.z);
    const root = scene.createTransformedEntity(`${site.callsign} beacon`, new Vec3(site.x, y, site.z));
    addChildRenderable(scene, root, `${site.callsign} transmitter mast`, new Vec3(), towerGeometry, darkMetalMaterial);
    addChildRenderable(scene, root, `${site.callsign} beacon housing`, new Vec3(), housingGeometry, redMaterial);
    addChildRenderable(scene, root, `${site.callsign} beacon lamp`, new Vec3(0, 3.78, 0), beaconLampGeometry, beaconActiveMaterial, false);
    const halo = addRenderable(scene, `${site.callsign} activation ring`, new Vec3(0, 0.19, 0), beaconRingGeometry, beaconDimMaterial, false);
    halo.transform.scale = new Vec3(1.18, 1.18, 1.18);
    root.addChild(halo);
    const lightEntity = scene.createTransformedEntity(`${site.callsign} search light`, new Vec3(0, 3.95, 0));
    const beaconLight = new Light();
    beaconLight.kind = "point";
    beaconLight.setColor(0.32, 0.83, 0.72);
    beaconLight.intensity = 9;
    beaconLight.range = 42;
    lightEntity.add(beaconLight);
    root.addChild(lightEntity);
    beaconVisuals.push({ ring: halo.require(Renderable), light: beaconLight, active: false });
  }

  // Phase 20.8: what each physics body sounds like when it hits something (bodies spawn later, so
  // the components are kept and resolved when sound starts).
  const soundBodies: Array<[RigidBodyComponent, ImpactMaterial]> = [];

  // ------------------------------------------------------------------ boulders
  // Four granite shapes shared by every boulder, so hundreds of rocks are a handful of draws.
  const rockShapes = [0, 1, 2, 3].map((seed) => geo(rockGeometrySource({ radius: 0.5, segments: 12, roughness: 0.34, flatten: 0.2 + seed * 0.05, seed: 11 + seed * 37 })));
  // Roadside boulders carry static bodies so the truck and the crates can hit them.
  for (let i = 0; i < 16; i++) {
    const side = i % 2 === 0 ? -1 : 1;
    const s = 24 + i * ((route.length - 60) / 16);
    const pose = route.poseAt(s);
    const lateral = side * (7.2 + seededNoise(i, 15) * 4.6);
    const x = pose.x + Math.cos(pose.yaw) * lateral;
    const z = pose.z - Math.sin(pose.yaw) * lateral;
    const scale = 0.95 + seededNoise(i, 19) * 1.35;
    const rock = addRenderable(scene, `Roadside boulder ${i + 1}`, new Vec3(x, heightAt(x, z) + scale * 0.18, z), rockShapes[i % rockShapes.length]!, rockMaterials[i % rockMaterials.length]!);
    rock.transform.scale = new Vec3(scale * 1.25, scale, scale * 0.95);
    rock.transform.rotation = new Quat().setAxisAngle(new Vec3(0, 1, 0), seededNoise(i, 21) * Math.PI * 2);
    soundBodies.push([makeBoxBody(rock, { x: scale * 0.56, y: scale * 0.33, z: scale * 0.42 }), "rock"]);
  }
  // Scatter: the same shapes strewn down the slopes, thicker where the ground is steep.
  let looseRocks = 0;
  {
    const CELL = 17;
    const rockCount = tierValue(tier, { low: 0.35, medium: 0.7, high: 1 });
    for (let gz = Math.floor((ROAD_START_Z - 60) / CELL); gz < Math.ceil((ROUTE_END_Z + 80) / CELL); gz++) {
      for (let gx = Math.floor((ROUTE_X - 200) / CELL); gx < Math.ceil((ROUTE_X + 200) / CELL); gx++) {
        const x = (gx + 0.15 + 0.7 * dice(gx, gz, 1)) * CELL;
        const z = (gz + 0.15 + 0.7 * dice(gx, gz, 2)) * CELL;
        const pr = route.project(x, z);
        if (Number.isFinite(pr.distance) && pr.distance < 9) continue;
        const y = gradedHeight(x, z);
        const gradeX = (gradedHeight(x + 2, z) - gradedHeight(x - 2, z)) / 4;
        const gradeZ = (gradedHeight(x, z + 2) - gradedHeight(x, z - 2)) / 4;
        const steepness = Math.atan(Math.hypot(gradeX, gradeZ));
        if (dice(gx, gz, 3) > (0.1 + 0.8 * smoothstep(0.25, 0.7, steepness)) * rockCount) continue;
        const scale = 0.5 + dice(gx, gz, 4) * dice(gx, gz, 5) * 3.2;
        const rock = addRenderable(scene, `Scree boulder ${looseRocks + 1}`, new Vec3(x, y + scale * 0.12, z), rockShapes[Math.floor(dice(gx, gz, 6) * 4)]!, rockMaterials[Math.floor(dice(gx, gz, 7) * 3)]!);
        rock.transform.scale = new Vec3(scale * (1 + dice(gx, gz, 8) * 0.5), scale * (0.7 + dice(gx, gz, 9) * 0.5), scale);
        rock.transform.rotation = new Quat().setAxisAngle(new Vec3(0, 1, 0), dice(gx, gz, 10) * Math.PI * 2);
        looseRocks++;
      }
    }
  }

  // ------------------------------------------------------------------ cargo and crates
  const caseBody = new MeshBuilder();
  caseBody.add(roundedBoxSource({ width: 0.8, height: 0.48, depth: 0.54, radius: 0.05, segments: 3 }));
  const caseBodyGeometry = geo(caseBody.build("case-body"));
  const caseTrim = new MeshBuilder();
  caseTrim.add(boxGeometrySource({ width: 0.82, height: 0.03, depth: 0.56 }), translate(0, 0.02, 0));
  for (const x of [-0.26, 0.26]) caseTrim.add(roundedBoxSource({ width: 0.09, height: 0.1, depth: 0.58, radius: 0.015, segments: 2 }), translate(x, 0.12, 0));
  caseTrim.add(roundedBoxSource({ width: 0.3, height: 0.045, depth: 0.06, radius: 0.02, segments: 2 }), translate(0, 0.28, 0));
  const caseTrimGeometry = geo(caseTrim.build("case-trim"));
  const caseCross = new MeshBuilder();
  for (const [w, d] of [[0.32, 0.09], [0.09, 0.32]] as const) caseCross.add(boxGeometrySource({ width: w, height: 0.012, depth: d }), translate(0, 0.243, 0));
  for (const s of [-1, 1]) for (const [w, h] of [[0.2, 0.06], [0.06, 0.2]] as const) caseCross.add(boxGeometrySource({ width: w, height: h, depth: 0.012 }), translate(0, 0.0, s * 0.272));
  const caseCrossGeometry = geo(caseCross.build("case-cross"));

  const supplyCrate = scene.createTransformedEntity(
    "Priority medical supply case",
    new Vec3(DEPOT_X + 3, heightAt(DEPOT_X + 3, BASE_Z + 2) + 0.27, BASE_Z + 2),
  );
  addChildRenderable(scene, supplyCrate, "Priority medical supply case mesh", new Vec3(), caseBodyGeometry, cargoMaterial);
  addChildRenderable(scene, supplyCrate, "Medical case trim", new Vec3(), caseTrimGeometry, caseTrimMaterial, false);
  addChildRenderable(scene, supplyCrate, "Medical case cross", new Vec3(), caseCrossGeometry, crossMaterial, false);
  soundBodies.push([makeBoxBody(supplyCrate, { x: 0.4, y: 0.24, z: 0.27 }, { mass: 28, friction: 0.78, restitution: 0.06 }), "plastic"]);
  let dynamicPropCount = 1;

  const crateBody = new MeshBuilder();
  crateBody.add(roundedBoxSource({ width: 0.94, height: 0.94, depth: 0.94, radius: 0.025, segments: 2 }));
  const crateBodyGeometry = geo(crateBody.build("crate-body"));
  const crateFrame = new MeshBuilder();
  for (const x of [-0.46, 0.46]) for (const z of [-0.46, 0.46]) crateFrame.add(boxGeometrySource({ width: 0.1, height: 0.98, depth: 0.1 }), translate(x, 0, z));
  for (const y of [-0.34, 0.34]) {
    crateFrame.add(boxGeometrySource({ width: 0.98, height: 0.08, depth: 0.98 }), translate(0, y, 0));
  }
  const crateFrameGeometry = geo(crateFrame.build("crate-frame"));
  for (let i = 0; i < 7; i++) {
    const pose = route.poseAt(30 + i * 36);
    // Alternate sides of the centre line, partly on the running surface: a few are real obstacles.
    const lateral = (i % 2 === 0 ? 1 : -1) * (2.3 + seededNoise(i, 27) * 2.2);
    const x = pose.x + Math.cos(pose.yaw) * lateral;
    const z = pose.z - Math.sin(pose.yaw) * lateral;
    const crate = scene.createTransformedEntity(`Physical trail supply crate ${i + 1}`, new Vec3(x, heightAt(x, z) + 0.5, z));
    crate.transform.rotation = new Quat().setAxisAngle(new Vec3(0, 1, 0), seededNoise(i, 29) * Math.PI);
    addChildRenderable(scene, crate, `Trail supply crate ${i + 1} mesh`, new Vec3(), crateBodyGeometry, crateMaterial);
    addChildRenderable(scene, crate, `Trail supply crate ${i + 1} frame`, new Vec3(), crateFrameGeometry, crateFrameMaterial);
    soundBodies.push([makeBoxBody(crate, { x: 0.47, y: 0.47, z: 0.47 }, { mass: 19 + (i % 3) * 4, friction: 0.74, restitution: 0.1 }), "wood"]);
    dynamicPropCount++;
  }

  // ------------------------------------------------------------------ vehicle
  // Establish a shared terrain world so cargo and route crates can bounce, tip, and collide with the truck.
  const physicsSystem = new PhysicsSystem({ world: physicsWorld });
  scene.world.registerSystem(new VehicleSystem());
  scene.world.registerSystem(physicsSystem);

  const vehicle = new Vehicle(
    createVehicleConfig({
      mass: 2380,
      wheelbase: 2.72,
      track: 1.67,
      wheelRadius: 0.42,
      cgHeight: 0.58,
      // Peak friction on a dry surface; the weather grip factor (snow cover) and the road/off-road
      // grip field below scale it — about 0.5 on the packed road in a full storm, 0.9 at the start.
      mu: 1.45,
      rollingResistance: 0.042,
      maxBrakeTorque: 5600,
      parkingBrakeTorque: 9400,
      layout: "awd",
    }),
  );
  const spawnProjection = route.project(DEPOT_APPROACH_X, DEPOT_APPROACH_Z);
  vehicle.position.set(DEPOT_APPROACH_X, 0, DEPOT_APPROACH_Z);
  vehicle.yaw = route.poseAt(spawnProjection.s).yaw;
  vehicle.placeOnGround(groundAt);
  vehicle.input.brake = 1;
  vehicle.input.handbrake = 1;
  let startupHold = true;
  let parked = false;

  const staticCompression = (vehicle.config.mass * vehicle.config.gravity) / (vehicle.wheels.length * vehicle.config.springRate);
  const truck = buildRescueTruckSources({
    wheelbase: vehicle.config.wheelbase,
    track: vehicle.config.track,
    wheelRadius: vehicle.config.wheelRadius,
    hubDrop: vehicle.config.suspensionRest - staticCompression,
    cgToFront: vehicle.config.cgToFront,
  });

  const truckTextures: MaterialTextureSet[] = [];
  const tyreSpan = tyreTreadSpan(truck.dims.wheelRadius, truck.dims.wheelWidth);
  const tyreTextures = createTyreTreadTextures(engine.gpu, { treadFrom: tyreSpan[0], treadTo: tyreSpan[1] });
  const stripeTextures = createHiVisStripeTextures(engine.gpu);
  truckTextures.push(tyreTextures, stripeTextures);
  ownedTextures.push({ dispose: () => truckTextures.forEach((set) => disposeMaterialTextureSet(set)) });
  const paintMaterial = ownMaterial(new Material({ label: "SAR vehicle enamel", color: Color.fromSrgbHex(0xf2641f), metallic: 0.08, roughness: 0.42 }));
  const roofMaterial = ownMaterial(new Material({ label: "SAR vehicle roof", color: Color.fromSrgbHex(0xe9eceb), metallic: 0.1, roughness: 0.42 }));
  const glassMaterial = ownMaterial(new Material({ label: "rescue vehicle glass", color: Color.fromSrgbHex(0x0d171c), metallic: 0.4, roughness: 0.07 }));
  const trimMaterial = ownMaterial(new Material({ label: "vehicle trim", color: Color.fromSrgbHex(0x16181a), roughness: 0.72, metallic: 0.05 }));
  const steelMaterial = ownMaterial(new Material({ label: "vehicle steel", color: Color.fromSrgbHex(0x8a9298), roughness: 0.4, metallic: 0.85 }));
  const underbodyMaterial = ownMaterial(new Material({ label: "vehicle underbody", color: Color.fromSrgbHex(0x0e0f10), roughness: 0.95 }));
  const headlampMaterial = ownMaterial(Material.emissive(0xfff1d0, 1.8, { label: "rescue headlamp glass" }));
  const tailLampMaterial = ownMaterial(Material.emissive(0xff2a18, 0.9, { label: "tail lamp" }));
  const amberMaterial = ownMaterial(Material.emissive(0xffa020, 0.9, { label: "indicator lamp" }));
  const reverseMaterial = ownMaterial(new Material({ label: "reverse lamp", color: Color.fromSrgbHex(0xe8e8e8), emissive: Color.fromSrgbHex(0xffffff), emissiveStrength: 0, roughness: 0.3 }));
  const lightBarMaterial = ownMaterial(new Material({ label: "light bar housing", color: Color.fromSrgbHex(0x1a1c1e), roughness: 0.5, metallic: 0.3 }));
  const stripeMaterial = withMaps(ownMaterial(new Material({ label: "hi-vis stripe", color: 0xffffff, roughness: 1, metallic: 0, tiling: [1.5, 1] })), stripeTextures);
  const tyreMaterial = withMaps(ownMaterial(new Material({ label: "winter tyre", color: 0xffffff, roughness: 1, metallic: 0 })), tyreTextures);
  const rimDiscMaterial = ownMaterial(new Material({ label: "wheel dish", color: Color.fromSrgbHex(0x2b2e33), roughness: 0.5, metallic: 0.6 }));
  const rimSpokeMaterial = ownMaterial(new Material({ label: "wheel spokes", color: Color.fromSrgbHex(0xaeb4ba), roughness: 0.32, metallic: 0.9 }));
  const hubMaterial = ownMaterial(new Material({ label: "wheel hub", color: Color.fromSrgbHex(0x9aa0a6), roughness: 0.35, metallic: 0.9 }));
  const redFlasherMaterial = ownMaterial(Material.emissive(0xf04435, 2.8, { label: "red emergency light" }));
  const blueFlasherMaterial = ownMaterial(Material.emissive(0x47baff, 2.8, { label: "blue emergency light" }));

  const truckRoot = scene.createTransformedEntity("Alpine rescue 4x4", vehicle.position.clone());
  const part = (name: string, source: GeometrySource, material: Material, castShadow = true) =>
    addChildRenderable(scene, truckRoot, name, new Vec3(), geo(source), material, castShadow);
  part("Rescue 4x4 paint", truck.body.paint, paintMaterial);
  part("Rescue 4x4 roof", truck.body.roof, roofMaterial);
  part("Rescue 4x4 glass", truck.body.glass, glassMaterial, false);
  part("Rescue 4x4 trim", truck.body.trim, trimMaterial);
  part("Rescue 4x4 steel", truck.body.steel, steelMaterial);
  part("Rescue 4x4 underbody", truck.body.underbody, underbodyMaterial, false);
  part("Rescue headlamp lenses", truck.body.headlamps, headlampMaterial, false);
  part("Rescue tail lamps", truck.body.tailLamps, tailLampMaterial, false);
  part("Rescue indicators", truck.body.amber, amberMaterial, false);
  part("Rescue reverse lamps", truck.body.reverse, reverseMaterial, false);
  part("Rescue hi-vis stripe", truck.body.stripe, stripeMaterial, false);
  part("Rescue light bar", truck.body.lightBar, lightBarMaterial, false);
  const redLamp = addChildRenderable(scene, truckRoot, "Rescue red flasher", new Vec3(...truck.flashers.redAt), geo(truck.flashers.red), redFlasherMaterial, false);
  const blueLamp = addChildRenderable(scene, truckRoot, "Rescue blue flasher", new Vec3(...truck.flashers.blueAt), geo(truck.flashers.blue), blueFlasherMaterial, false);
  const redFlasher = redLamp.require(Renderable);
  const blueFlasher = blueLamp.require(Renderable);
  // The flashers throw coloured light on the snow, alternating with the lenses.
  const flasherLights: Light[] = [];
  for (const [at, rgb] of [[truck.flashers.redAt, [1, 0.22, 0.16]], [truck.flashers.blueAt, [0.2, 0.5, 1]]] as const) {
    const entity = scene.createTransformedEntity("Rescue flasher light", new Vec3(at[0], at[1] + 0.25, at[2]));
    const light = new Light();
    light.kind = "point";
    light.setColor(rgb[0], rgb[1], rgb[2]);
    light.intensity = 0;
    light.range = 15;
    entity.add(light);
    truckRoot.addChild(entity);
    flasherLights.push(light);
  }
  let flashFrame = -1;

  // Two spot headlamps, one at each lens.
  const headlightSpots: Light[] = [];
  for (const at of truck.dims.headlamps) {
    const lamp = scene.createTransformedEntity("Rescue headlamp", new Vec3(at[0], at[1], at[2] + 0.04));
    const spot = new Light();
    spot.kind = "spot";
    spot.setColor(1, 0.84, 0.62);
    spot.intensity = 68;
    spot.range = 88;
    spot.innerCone = 0.88;
    spot.outerCone = 0.66;
    lamp.add(spot);
    truckRoot.addChild(lamp);
    headlightSpots.push(spot);
  }

  // The spare wheel on the tailgate (same shared wheel meshes, turned to face aft).
  const wheelParts: Array<[string, GeometrySource, Material]> = [
    ["tyre", truck.wheel.tyre, tyreMaterial],
    ["rim", truck.wheel.rimDisc, rimDiscMaterial],
    ["spokes", truck.wheel.rimSpokes, rimSpokeMaterial],
    ["hub", truck.wheel.hub, hubMaterial],
  ];
  const wheelGeometries = wheelParts.map(([, source]) => geo(source));
  const spareRoot = scene.createTransformedEntity("Rescue spare wheel", new Vec3(...truck.spare.position));
  spareRoot.transform.rotation = new Quat().setAxisAngle(new Vec3(0, 1, 0), truck.spare.yaw);
  truckRoot.addChild(spareRoot);
  wheelParts.forEach(([name, , material], k) => addChildRenderable(scene, spareRoot, `Spare ${name}`, new Vec3(), wheelGeometries[k]!, material));

  // The four wheels: root entities that `VehicleSystem` poses in world space each step (a wheel
  // parented to the chassis would be offset by the chassis's own pose). Left-hand wheels turn their
  // meshes 180° so the rim face is always outboard.
  const wheelEntities: Array<ReturnType<Scene["createTransformedEntity"]>> = [];
  for (let i = 0; i < vehicle.wheels.length; i++) {
    const wheel = scene.createTransformedEntity(`Rescue wheel ${i + 1}`, vehicle.position.clone());
    wheelParts.forEach(([name, , material], k) => {
      const child = addChildRenderable(scene, wheel, `Rescue wheel ${i + 1} ${name}`, new Vec3(), wheelGeometries[k]!, material);
      if (vehicle.wheels[i]!.x < 0) child.transform.rotation = new Quat().setAxisAngle(new Vec3(0, 1, 0), Math.PI);
    });
    wheelEntities.push(wheel);
  }

  const chassisBody = createVehicleChassis(vehicle, physicsWorld, {
    halfExtents: { x: 1.02, y: 0.43, z: 2.1 },
    friction: 0.92,
    restitution: 0.02,
  });
  const vehicleComponent = new VehicleComponent(vehicle, groundAt);
  vehicleComponent.wheelEntities = wheelEntities.map((entity) => entity.id);
  vehicleComponent.attachChassis(chassisBody, physicsWorld);
  truckRoot.add(vehicleComponent);

  // Packed road grips better than the drifted snow beside it; the weather factor scales both.
  const gripProbe: RouteProjection = { s: 0, lateral: Infinity, distance: Infinity };
  setWorldSurfaceGripField(scene.world, (x, z) => {
    route.project(x, z, gripProbe);
    const onRoad = 1 - smoothstep(2.9, 4.6, Math.abs(gripProbe.lateral));
    return 0.8 + 0.32 * onRoad;
  });

  // Wheel tracks: every grounded tyre presses a persistent, darker trail into the snow.
  const trackLayer = new TireTrackLayer(engine.gpu, {
    heightAt,
    tileSize: 28,
    tileResolution: tierValue(tier, { low: 128, medium: 192, high: 256 }),
    maxTiles: tierValue(tier, { low: 10, medium: 18, high: 28 }),
    lift: 0.075,
  });
  trackLayer.followVehicle(vehicle, () => "snow", 0.3);
  scene.add(trackLayer);

  // ------------------------------------------------------------------ forest
  // Procedural spruce: engine trees (`generateTree`) with a needle-bough card, drawn as instanced,
  // LOD-switched, wind-swayed vegetation that holds snow on its boughs.
  const boughTexture = tex(128, 128, spruceBoughPixels(128, 17), "alpine.spruce-bough");
  const barkTexture = tex(64, 64, barkPixels(64, "furrowed", 5), "alpine.spruce-bark");
  const needleMaterial = ownMaterial(new Material({ label: "alpine spruce needles", color: 0xffffff, roughness: 0.9, metallic: 0, doubleSided: true, albedoMap: boughTexture }));
  needleMaterial.alphaTest = 0.5;
  const barkMaterial = ownMaterial(new Material({ label: "alpine spruce bark", color: Color.fromSrgbHex(0x8a7560), roughness: 0.95, metallic: 0, albedoMap: barkTexture }));
  const spruce: TreeSpecies = {
    name: "spruce",
    height: [12, 19],
    shape: "conical",
    trunkRadius: 0.02,
    clearBole: 0.1,
    children: [10, 4, 3],
    branchAngle: [1.38, 1.1, 0.9],
    lengthRatio: [0.5, 0.55, 0.5],
    gravitropism: -0.12,
    leafSize: 1.15,
    leavesPerBranch: tierValue(tier, { low: 6, medium: 7, high: 8 }),
    wander: 0.05,
  };
  const youngSpruce: TreeSpecies = { ...spruce, name: "young spruce", height: [5, 8.5], leafSize: 0.7, leavesPerBranch: tierValue(tier, { low: 4, medium: 5, high: 6 }), children: [8, 4, 3] };
  const treeModels: VegetationModel[] = [];
  const variants = tierValue(tier, { low: 2, medium: 3, high: 3 });
  for (const [si, species] of [spruce, youngSpruce].entries()) {
    for (let v = 0; v < variants; v++) {
      const seed = 4100 + si * 900 + v * 77;
      const hi = generateTree(species, seed, "hi");
      const lo = generateTree(species, seed, "lo");
      treeModels.push({
        parts: [
          { hi: geo(hi.wood), lo: geo(lo.wood), material: barkMaterial, castShadow: true },
          { hi: geo(hi.leaves), lo: geo(lo.leaves), material: needleMaterial, castShadow: true },
        ],
        lodDistance: tierValue(tier, { low: 45, medium: 70, high: 95 }),
        maxDistance: tierValue(tier, { low: 190, medium: 290, high: 400 }),
        sway: { maxBend: 0.1, halfBendWind: 30, frequency: 0.28 },
        swayDistance: tierValue(tier, { low: 30, medium: 55, high: 80 }),
      });
    }
  }
  let windNow = { x: 0, z: 0 };
  const vegetation = new VegetationField({
    name: "alpine-vegetation",
    models: treeModels,
    viewer: () => cameraEntity.transform.position,
    wind: () => windNow,
  });
  const treeTints = [0x3c604a, 0x446a50, 0x365843, 0x4d7357, 0x3f6550].map((c) => (0xff000000 | c) >>> 0);
  {
    const CELL = 10;
    const density = tierValue(tier, { low: 0.4, medium: 0.7, high: 1 });
    const keepClear = [
      ...RELAY_SITES.map((site) => ({ x: site.x, z: site.z, r: 11 })),
      { x: DEPOT_X - 6, z: BASE_Z, r: 26 },
    ];
    for (let gz = Math.floor((ROAD_START_Z - 70) / CELL); gz < Math.ceil((ROUTE_END_Z + 90) / CELL); gz++) {
      for (let gx = Math.floor((ROUTE_X - 230) / CELL); gx < Math.ceil((ROUTE_X + 230) / CELL); gx++) {
        const x = (gx + 0.15 + 0.7 * dice(gx, gz, 21)) * CELL;
        const z = (gz + 0.15 + 0.7 * dice(gx, gz, 22)) * CELL;
        const pr = route.project(x, z);
        const distance = Number.isFinite(pr.distance) ? pr.distance : 99;
        if (distance < 10.5) continue;
        if (keepClear.some((k) => Math.hypot(x - k.x, z - k.z) < k.r)) continue;
        // Stands and meadows: a slow noise decides where the forest is thick; the road verge is thin.
        const stand = fbm2(x / 90, z / 90, 0x7b3d, { octaves: 3 }) * 0.5 + 0.5;
        const verge = smoothstep(10.5, 34, distance);
        const p = (0.1 + 0.7 * smoothstep(0.36, 0.62, stand)) * (0.3 + 0.7 * verge) * density;
        if (dice(gx, gz, 23) > p) continue;
        const y = gradedHeight(x, z);
        if (y > 90) continue;
        const gradeX = (gradedHeight(x + 2, z) - gradedHeight(x - 2, z)) / 4;
        const gradeZ = (gradedHeight(x, z + 2) - gradedHeight(x, z - 2)) / 4;
        if (Math.hypot(gradeX, gradeZ) > 0.95) continue;
        const kind = dice(gx, gz, 24) < 0.28 ? 1 : 0;
        const model = kind * variants + (Math.floor(dice(gx, gz, 25) * 997) % variants);
        vegetation.add(model, x, y, z, dice(gx, gz, 26) * Math.PI * 2, 0.8 + dice(gx, gz, 27) * 0.5, treeTints[Math.floor(dice(gx, gz, 28) * treeTints.length)]!);
      }
    }
  }
  scene.add(vegetation);

  // ------------------------------------------------------------------ sky, light, weather
  const sunEntity = scene.createTransformedEntity("Whiteout Run arctic sun", new Vec3(0, 0, 0));
  const sun = new Light();
  sun.kind = "directional";
  sun.intensity = 4.2;
  sun.castShadow = true;
  sunEntity.add(sun);
  const dayNight = new DayNightCycle({
    latitude: 47.8,
    dayOfYear: 286,
    timeOfDay: 13.8,
    timeScale: 0.02,
    sun,
    sunIntensity: 4.2,
    ambientScale: 1.0,
  });
  scene.add(dayNight);

  scene.setFog("exp2", { density: 0.00038, color: Color.fromSrgbHex(0x89999e), start: 18, end: 740 });
  scene.setSky({ quality: tier === "low" ? "low" : "medium", turbidity: 7.8, rayleigh: 1.35, mie: 0.78, exposure: 1.0, sunDiscIntensity: 110 });
  scene.setClouds({ coverage: 0.74, density: 0.78, height: 720, scale: 0.0011, silverLining: 0.72, albedo: Color.fromSrgbHex(0xd7e0e3) });
  scene.setAmbient(Color.fromSrgbHex(0x8198a0), 0.44);
  scene.settings.hdr = true;
  scene.settings.toneMapping = "aces";
  scene.settings.bloom.enabled = tier !== "low";
  scene.settings.bloom.threshold = 1.12;
  scene.settings.bloom.intensity = 0.12;
  scene.settings.shadow.enabled = true;
  scene.settings.shadow.cascades = tierValue(tier, { low: 2, medium: 3, high: 3 });
  scene.settings.shadow.distance = tierValue(tier, { low: 220, medium: 420, high: 520 });
  scene.settings.shadow.mapSize = tierValue(tier, { low: 1024, medium: 2048, high: 2048 });
  scene.settings.ssao.enabled = tier !== "low";
  scene.setExposure(1.04);

  const initialPackM = ALPINE_SNOWPACK_INITIAL_DEPTH_M;
  const weather = new WeatherSystem({
    // The demo opens under broken cloud that thickens toward overcast ("CLOUDING OVER"): the low sun
    // still models the snow and throws shadows for the first minutes.
    initial: { ...ALPINE_WEATHER.overcast, cloudCoverage: 0.5, humidity01: 0.7 },
    target: ALPINE_WEATHER.overcast,
    tau: {
      windSpeed: 24,
      windDirection: 38,
      gust: 22,
      temperatureC: 180,
      humidity01: 80,
      precipitation01: 23,
      storm01: 32,
      cloudCoverage: 48,
    },
    // The scene owns the pack depth: the cover drives tyre grip and audio, and the renderer is
    // given a remapped shade (see `alpineSnowShade01`), so the engine must not overwrite it.
    initialSurface: { snow: alpineSnowCover01(initialPackM) },
    driveSurface: false,
    rainFogDensity: 0.0042,
    driveFog: true,
    driveClouds: true,
    driveSky: true,
  });
  scene.add(weather);
  scene.settings.surface.snow = alpineSnowShade01(alpineSnowCover01(initialPackM));
  vegetation.setSurface(0, alpineSnowShade01(alpineSnowCover01(initialPackM)));
  let snowpackDepthM = initialPackM;
  let appliedShade = alpineSnowShade01(alpineSnowCover01(initialPackM));

  // GPU camera-facing flakes vary in size, drift with the wind, and flutter instead of falling as
  // identical high-speed rods. The soft, mostly unstretched billboards read as swirling snow.
  const snowfall = new GpuParticleWorld({
    name: "Whiteout Run snowfall",
    capacity: 18_000,
    maxEmitsPerFrame: 1024,
    seed: 0x51a7,
    softParticles: true,
    softScale: 28,
    stretch: 0.08,
    cullDistance: 120,
    emitter: {
      rate: 0,
      lifeMin: 9,
      lifeMax: 15,
      size: 0.06,
      position: { x: vehicle.position.x, y: vehicle.position.y + 22, z: vehicle.position.z },
      jitter: { x: 58, y: 24, z: 58 },
      coneDir: { x: 0, y: -1, z: 0 },
      coneAngle: 0.38,
      speedMin: 0.2,
      speedMax: 1.4,
      color: { r: 0.86, g: 0.94, b: 1, a: 0.82 },
    },
    modules: {
      gravity: { x: 0, y: -1.4, z: 0 },
      drag: 1.1,
      turbulence: 1.3,
      noiseScale: 0.1,
      velocityBoost: { x: 0, y: 0, z: 0 },
      colorFrom: { r: 0.86, g: 0.94, b: 1, a: 0.82 },
      colorTo: { r: 0.86, g: 0.94, b: 1, a: 0.02 },
      sizeStart: 0.07,
      sizeEnd: 0.042,
      sizeVariation: 0.56,
      rotationSpeed: 0.18,
    },
  });
  scene.add(snowfall);

  // Thundersnow is rare: the strike rate is `rate × storm intensity`, so only the full storm flashes.
  const lightning = new LightningSystem({
    name: "Whiteout Run lightning",
    seed: ALPINE_SEED + 400,
    rate: 0.035,
    areaRadius: 440,
    cloudHeight: 600,
    groundY: 7,
    subdivisions: 5,
    roughness: 0.42,
  });
  scene.add(lightning);

  const cameraEntity = scene.createTransformedEntity("Rescue pursuit camera", new Vec3(vehicle.position.x + 6.2, vehicle.position.y + 3.7, vehicle.position.z - 12.7));
  const camera = new Camera();
  camera.fovY = (66 * Math.PI) / 180;
  camera.near = 0.15;
  camera.far = 2200;
  scene.world.addComponent(cameraEntity.id, camera);
  cameraEntity.transform.lookAt(new Vec3(vehicle.position.x, vehicle.position.y + 1, vehicle.position.z));
  const cameraSetup = {
    target: new Vec3(vehicle.position.x, vehicle.position.y + 1.3, vehicle.position.z),
    distance: 11.5,
    azimuth: 0.44,
    elevation: 0.25,
    minDistance: 5,
    maxDistance: 70,
    minElevation: -0.1,
    maxElevation: 1.1,
    groundClearance: 1.35,
    groundHeight: (x: number, z: number) => heightAt(x, z) + 0.25,
    keyboard: false,
  };

  // ------------------------------------------------------------------ mission state
  let stage: RescueStage = "load-kit";
  let cargoLoaded = false;
  let cargoDelivered = false;
  let headlightsOn = true;
  let weatherTarget: WeatherPresetName = "overcast";
  let elapsed = 0;
  let disposed = false;
  const keys = new Set<string>();

  const objective = (): RescueObjective => {
    if (stage === "load-kit") return { stage, title: "LOAD THE MEDICAL KIT", detail: "Collect the green supply case at the depot.", x: supplyCrate.getPosition().x, z: supplyCrate.getPosition().z };
    if (stage === "relay-1") return { stage, title: `ACTIVATE ${RELAY_SITES[0]!.callsign}`, detail: `${RELAY_SITES[0]!.name} · ${RELAY_SITES[0]!.x} / ${RELAY_SITES[0]!.z}`, x: RELAY_SITES[0]!.x, z: RELAY_SITES[0]!.z };
    if (stage === "relay-2") return { stage, title: `ACTIVATE ${RELAY_SITES[1]!.callsign}`, detail: `${RELAY_SITES[1]!.name} · ${RELAY_SITES[1]!.x} / ${RELAY_SITES[1]!.z}`, x: RELAY_SITES[1]!.x, z: RELAY_SITES[1]!.z };
    if (stage === "deliver-kit") return { stage, title: `DELIVER KIT TO ${RELAY_SITES[2]!.callsign}`, detail: `${RELAY_SITES[2]!.name} · unload the case at the beacon.`, x: RELAY_SITES[2]!.x, z: RELAY_SITES[2]!.z };
    if (stage === "return") return { stage, title: "RETURN TO THE RESCUE DEPOT", detail: "Get the crew home before the pass disappears.", x: DEPOT_X, z: BASE_Z };
    return { stage, title: "MISSION COMPLETE", detail: "The relays are online and the supplies are through.", x: DEPOT_X, z: BASE_Z };
  };

  const objectiveDistance = () => {
    const target = objective();
    return Math.hypot(vehicle.position.x - target.x, vehicle.position.z - target.z);
  };

  const hud = () => {
    const current = objective();
    const distance = objectiveDistance();
    const relays = beaconVisuals.filter((beacon) => beacon.active).length;
    const cargo = cargoDelivered ? "DELIVERED" : cargoLoaded ? "ON ROOF" : "AT DEPOT";
    const speed = Math.round(Math.abs(vehicle.speed) * 3.6);
    const band = weather.state.precipitation01 > 0.48 ? "WHITEOUT" : weather.state.precipitation01 > 0.2 ? "SNOW SQUALL" : "CLOUDING OVER";
    const hint = stage === "complete" ? "F · cycle headlights   P · park" : distance <= INTERACT_RADIUS ? "E / TAP · INTERACT" : "WASD / ARROWS · DRIVE   E / TAP · INTERACT";
    const temperature = `${weather.state.temperatureC.toFixed(0)} °C`;
    return `ALPINE SAR  /  WHITEOUT RUN\n${current.title}\n${current.detail}\nRANGE  ${distance.toFixed(0)} m     BEACONS  ${relays}/3     MED KIT  ${cargo}\n${band}  ·  ${weather.state.windSpeed.toFixed(0)} m/s wind  ·  ${temperature}     SNOWPACK ${snowpackDepthM.toFixed(2)} m     ${speed} km/h\n${hint}`;
  };

  const uiRoot = typeof document !== "undefined" ? document.getElementById("vehicle-touch") : null;
  const touch = uiRoot ? attachVehicleTouch(uiRoot, { onParkToggle: () => { parked = !parked; touch?.setPark(parked); } }) : null;
  const interactButton = typeof document !== "undefined" ? document.getElementById("rescue-interact") as HTMLButtonElement | null : null;
  const weatherButton = typeof document !== "undefined" ? document.getElementById("rescue-weather") as HTMLButtonElement | null : null;
  const headlightButton = typeof document !== "undefined" ? document.getElementById("rescue-headlights") as HTMLButtonElement | null : null;
  const parkButton = typeof document !== "undefined" ? document.getElementById("rescue-park") as HTMLButtonElement | null : null;
  const soundButton = typeof document !== "undefined" ? document.getElementById("rescue-sound") as HTMLButtonElement | null : null;

  // Phase 20.7 + 20.8 audio, opt-in from a gesture (autoplay policy): the truck's engine, tyres and
  // suspension, and every physics contact — crates, boulders, the case and the truck on snow.
  // The truck and every contact on the sfx bus, the mountain's ambience (wind, the whiteout, snow
  // damping, birds by day) on the ambient bus, the valley's reverb on sfx (Phase 20.4-20.8).
  let sound: { mixer: AudioSystem; context: AudioContext; truck: VehicleAudio; analyzer: ImpactSoundAnalyzer; impacts: ImpactSoundscape; ambience: EnvironmentSoundscape } | null = null;
  let soundOn = false;
  const materialOf = (body: RigidBody): ImpactMaterial | undefined => {
    if (body === chassisBody) return "metal";
    if (body === terrainBody) return "snow";
    for (const [component, material] of soundBodies) if (component.body === body) return material;
    return undefined;
  };
  const setSound = (on: boolean): void => {
    if (on && !sound) {
      const Ctor = globalThis.AudioContext ?? (globalThis as typeof globalThis & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;
      const mixer = new AudioSystem({ context: new Ctor() });
      const context = mixer.context;
      const sfx = mixer.bus("sfx").input;
      const ambience = new EnvironmentSoundscape(context, mixer.bus("ambient").input, { volume: 0.5 });
      mixer.bus("sfx").add(ambience.reverb);
      sound = {
        mixer,
        context,
        truck: new VehicleAudio(vehicle, context, sfx, { surfaceAt: () => "snow", volume: 0.45, cylinders: 6 }),
        analyzer: new ImpactSoundAnalyzer(physicsWorld, { materialOf }),
        impacts: new ImpactSoundscape(context, sfx, { volume: 0.8 }),
        ambience,
      };
    }
    soundOn = on;
    // Never chain behaviour behind these promises: headless autoplay can leave resume() pending.
    if (sound) void (on ? sound.context.resume() : sound.context.suspend()).catch(() => {});
    updateUi();
  };
  const onSoundClick = () => setSound(!soundOn);

  const updateUi = () => {
    if (interactButton) {
      interactButton.disabled = stage === "complete" || objectiveDistance() > INTERACT_RADIUS;
      interactButton.textContent = stage === "complete" ? "MISSION COMPLETE" : stage === "return" ? "RETURN TO DEPOT" : "INTERACT  ·  E";
    }
    if (weatherButton) weatherButton.textContent = weatherTarget === "storm" ? "CALM THE STORM" : "CALL STORM";
    if (headlightButton) headlightButton.textContent = headlightsOn ? "LIGHTS ON · F" : "LIGHTS OFF · F";
    if (soundButton) {
      soundButton.textContent = soundOn ? "SOUND ON · M" : "SOUND · M";
      soundButton.setAttribute("aria-pressed", String(soundOn));
      soundButton.classList.toggle("active", soundOn);
    }
    if (parkButton) {
      parkButton.textContent = parked ? "RELEASE PARK · P" : "PARK · P";
      parkButton.classList.toggle("active", parked);
      parkButton.setAttribute("aria-pressed", String(parked));
    }
  };

  const setWeatherTarget = (preset: WeatherPresetName) => {
    weatherTarget = preset;
    weather.setTarget(ALPINE_WEATHER[preset]);
    updateUi();
  };

  /** Where the loaded case rides: on the roof rack, base resting on the rails. */
  const cargoRest = new Vec3(truck.dims.cargo[0], truck.dims.cargo[1] + 0.26, truck.dims.cargo[2]);

  const interact = (): boolean => {
    if (stage === "complete" || objectiveDistance() > INTERACT_RADIUS) return false;
    if (stage === "load-kit") {
      supplyCrate.remove(RigidBodyComponent);
      supplyCrate.remove(ColliderComponent);
      supplyCrate.parent = null;
      supplyCrate.transform.position = cargoRest.clone();
      supplyCrate.transform.rotation = new Quat();
      truckRoot.addChild(supplyCrate);
      cargoLoaded = true;
      stage = "relay-1";
    } else if (stage === "relay-1") {
      beaconVisuals[0]!.active = true;
      beaconVisuals[0]!.ring.material = beaconDoneMaterial;
      beaconVisuals[0]!.light.intensity = 20;
      stage = "relay-2";
      setWeatherTarget("storm");
    } else if (stage === "relay-2") {
      beaconVisuals[1]!.active = true;
      beaconVisuals[1]!.ring.material = beaconDoneMaterial;
      beaconVisuals[1]!.light.intensity = 20;
      stage = "deliver-kit";
    } else if (stage === "deliver-kit") {
      beaconVisuals[2]!.active = true;
      beaconVisuals[2]!.ring.material = beaconActiveMaterial;
      beaconVisuals[2]!.light.intensity = 29;
      const drop = new Vec3(RELAY_SITES[2]!.x + 3.7, heightAt(RELAY_SITES[2]!.x + 3.7, RELAY_SITES[2]!.z + 1) + 0.27, RELAY_SITES[2]!.z + 1);
      supplyCrate.parent = null;
      supplyCrate.transform.position = drop;
      supplyCrate.transform.rotation = new Quat().setAxisAngle(new Vec3(0, 1, 0), vehicle.yaw);
      cargoLoaded = false;
      cargoDelivered = true;
      stage = "return";
    } else if (stage === "return") {
      stage = "complete";
      parked = true;
      vehicle.input.brake = 1;
      vehicle.input.handbrake = 1;
      for (const beacon of beaconVisuals) {
        beacon.active = true;
        beacon.ring.material = beaconDoneMaterial;
        beacon.light.intensity = 15;
      }
    }
    updateUi();
    return true;
  };

  const toggleHeadlights = () => {
    headlightsOn = !headlightsOn;
    for (const spot of headlightSpots) spot.intensity = headlightsOn ? 68 : 0;
    headlampMaterial.emissiveStrength = headlightsOn ? 1.8 : 0.05;
    headlampMaterial.markChanged();
    updateUi();
  };
  const onWeatherClick = () => {
    const next: WeatherPresetName = weatherTarget === "storm" ? "clear" : "storm";
    weather.snapTo(ALPINE_WEATHER[next]);
    setWeatherTarget(next);
  };
  const onHeadlightsClick = () => toggleHeadlights();
  const onParkClick = () => {
    parked = !parked;
    touch?.setPark(parked);
    updateUi();
  };
  interactButton?.addEventListener("click", interact);
  weatherButton?.addEventListener("click", onWeatherClick);
  headlightButton?.addEventListener("click", onHeadlightsClick);
  parkButton?.addEventListener("click", onParkClick);
  soundButton?.addEventListener("click", onSoundClick);

  const onKeyDown = (event: KeyboardEvent) => {
    const key = event.code.toLowerCase();
    if (["arrowup", "arrowdown", "arrowleft", "arrowright", "space"].includes(key)) event.preventDefault();
    keys.add(key);
    if (!event.repeat && key === "keye") interact();
    if (!event.repeat && key === "keyp") onParkClick();
    if (!event.repeat && key === "keyf") toggleHeadlights();
    if (!event.repeat && key === "keyg") onWeatherClick();
    if (!event.repeat && key === "keym") onSoundClick();
  };
  const onKeyUp = (event: KeyboardEvent) => keys.delete(event.code.toLowerCase());
  const onBlur = () => keys.clear();
  if (typeof window !== "undefined") {
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
  }

  const placeTruck = (s: number, lateral = 0): void => {
    const pose = route.poseAt(Math.max(0, Math.min(route.length, s)));
    vehicle.position.set(pose.x + Math.cos(pose.yaw) * lateral, 0, pose.z - Math.sin(pose.yaw) * lateral);
    vehicle.yaw = pose.yaw;
    vehicle.velocity.set(0, 0, 0);
    vehicle.yawRate = 0;
    vehicle.placeOnGround(groundAt);
    vehicle.input.brake = 1;
    vehicle.input.handbrake = 1;
    startupHold = true;
  };

  const setSnowpackDepth = (depthM: number): void => {
    snowpackDepthM = Math.max(0, Math.min(ALPINE_SNOWPACK_MAX_DEPTH_M, Number.isFinite(depthM) ? depthM : 0));
    const cover = alpineSnowCover01(snowpackDepthM);
    weather.surface.snow = cover;
    appliedShade = alpineSnowShade01(cover);
    scene.settings.surface.snow = appliedShade;
    vegetation.setSurface(0, appliedShade);
  };

  const update = (dt: number) => {
    elapsed += dt;
    const sample = touch?.sample() ?? null;
    const forward = Number(keys.has("keyw") || keys.has("arrowup")) - Number(keys.has("keys") || keys.has("arrowdown"));
    const lateral = Number(keys.has("keyd") || keys.has("arrowright")) - Number(keys.has("keya") || keys.has("arrowleft"));
    const touchForward = sample?.throttle ?? 0;
    const touchSteer = sample?.steer ?? 0;
    const throttle = Math.max(0, forward, touchForward);
    const brake = Math.max(0, -forward, sample?.brake ?? 0);
    const steer = Math.abs(touchSteer) > Math.abs(lateral) ? touchSteer : lateral;
    if (throttle > 0.03 || Math.abs(steer) > 0.03) startupHold = false;
    if (throttle > 0.03) parked = false;
    vehicle.input.throttle = startupHold || parked ? 0 : throttle;
    vehicle.input.brake = parked ? 1 : Math.max(brake, startupHold ? 1 : 0);
    vehicle.input.handbrake = parked ? 1 : keys.has("space") ? 1 : 0;
    vehicle.input.parkingBrake = parked ? 1 : 0;
    vehicle.input.steer = parked ? 0 : steer;
    touch?.setPark(parked);
    if (sound && soundOn && sound.context.state === "running") {
      sound.truck.update(dt);
      sound.impacts.play(sound.analyzer.update().events);
      sound.impacts.setScrapes(sound.analyzer.scrapes);
      // The pursuit camera looks at the truck: hear from the camera, facing it.
      const eye = cameraEntity.transform.position;
      const fx = vehicle.position.x - eye.x, fy = vehicle.position.y - eye.y, fz = vehicle.position.z - eye.z;
      const len = Math.hypot(fx, fy, fz) || 1;
      setAudioListener(sound.context, eye, { x: fx / len, y: fy / len, z: fz / len }, Vec3.up);
      sound.ambience.update(
        ambienceSoundInput(weather.state, weather.surface, { sunElevationDeg: dayNight.elevationDeg, listenerYaw: Math.atan2(fx, fz), reflectivity: 0.45 }),
        dt,
      );
    } else if (sound) {
      // Keep the frame's contacts from piling up while the context is not running.
      sound.analyzer.update();
    }

    // Emergency lights: lenses and the snow around the truck alternate red / blue.
    const flasher = Math.floor(elapsed / 0.24);
    if (flasher !== flashFrame) {
      flashFrame = flasher;
      const redOn = flasher % 2 === 0;
      redFlasher.material = redOn ? redFlasherMaterial : darkMetalMaterial;
      blueFlasher.material = redOn ? darkMetalMaterial : blueFlasherMaterial;
      flasherLights[0]!.intensity = redOn ? 16 : 0;
      flasherLights[1]!.intensity = redOn ? 0 : 16;
    }
    // Brake and reverse lamps follow the pedals.
    const braking = vehicle.input.brake > 0.1 && !startupHold;
    const tailStrength = braking || parked ? 3.6 : 0.9;
    if (tailLampMaterial.emissiveStrength !== tailStrength) {
      tailLampMaterial.emissiveStrength = tailStrength;
      tailLampMaterial.markChanged();
    }
    const reversing = vehicle.gear < 0 || (vehicle.speed < -0.3 && forward < 0);
    const reverseStrength = reversing ? 2.4 : 0;
    if (reverseMaterial.emissiveStrength !== reverseStrength) {
      reverseMaterial.emissiveStrength = reverseStrength;
      reverseMaterial.markChanged();
    }

    const precipitation = weather.state.precipitation01;
    const wind = weather.meanWind();
    windNow = { x: wind.x, z: wind.y };
    const snowSystem = snowfall.system;
    if (snowSystem) {
      const emitter = snowSystem.emitter;
      emitter.rate = precipitation * 1800;
      emitter.jitter.x = 52 + precipitation * 20;
      emitter.jitter.y = 22 + precipitation * 8;
      emitter.jitter.z = 52 + precipitation * 20;
      emitter.position.x = vehicle.position.x;
      emitter.position.y = vehicle.position.y + 22;
      emitter.position.z = vehicle.position.z;
      snowSystem.modules.velocityBoost.x = wind.x * 0.11;
      snowSystem.modules.velocityBoost.z = wind.y * 0.11;
      snowSystem.modules.turbulence = 1.1 + weather.state.gust * 0.9;
    }

    // The pack deepens in snowfall. The engine's snow shader settles the remapped shade on every
    // up-facing surface; the raw cover feeds the tyre-grip factor, so the truck gets slipperier as it buries.
    snowpackDepthM = advanceAlpineSnowpack(snowpackDepthM, precipitation, dt);
    const cover = alpineSnowCover01(snowpackDepthM);
    weather.surface.snow = cover;
    const shade = alpineSnowShade01(cover);
    scene.settings.surface.snow = shade;
    if (Math.abs(shade - appliedShade) >= 0.004) {
      vegetation.setSurface(0, shade);
      appliedShade = shade;
    }
    updateUi();
  };

  updateUi();
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    if (typeof window !== "undefined") {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
    }
    interactButton?.removeEventListener("click", interact);
    weatherButton?.removeEventListener("click", onWeatherClick);
    headlightButton?.removeEventListener("click", onHeadlightsClick);
    parkButton?.removeEventListener("click", onParkClick);
    soundButton?.removeEventListener("click", onSoundClick);
    if (sound) {
      sound.truck.dispose();
      sound.impacts.dispose();
      sound.analyzer.dispose();
      sound.ambience.dispose();
      void sound.mixer.dispose().catch(() => {});
      sound = null;
    }
    soundOn = false;
    if (soundButton) {
      soundButton.textContent = "SOUND · M";
      soundButton.setAttribute("aria-pressed", "false");
      soundButton.classList.remove("active");
    }
    touch?.dispose();
    setWorldSurfaceGripField(scene.world, undefined);
    scene.dispose();
    physicsWorld.clear();
    for (const geometry of ownedGeometries) geometry.dispose();
    for (const material of ownedMaterials) material.dispose();
    for (const texture of ownedTextures) texture.dispose();
  };

  return {
    scene,
    cameraEntity,
    camera: cameraSetup,
    followTarget: () => ({ x: vehicle.position.x, y: vehicle.position.y + 0.9, z: vehicle.position.z }),
    controlsHint: "WASD / ARROWS drive · E interact · F headlights · G weather · P park · M sound · drag to orbit · touch controls on mobile",
    overlay: hud,
    update,
    dispose,
    interact,
    setWeatherTarget,
    placeTruck,
    setSnowpackDepth,
    snapshot: () => {
      const current = objective();
      const system = snowfall.system;
      const meanSnowLife = system ? (system.emitter.lifeMin + system.emitter.lifeMax) * 0.5 : 0;
      const snowAlive = system?.ready && system.emitter.rate > 0
        ? Math.min(system.capacity, system.emitted, Math.ceil(system.emitter.rate * meanSnowLife))
        : 0;
      return {
        mission: "Alpine Search & Rescue: Whiteout Run",
        stage,
        objective: current.title,
        objectiveDistance: objectiveDistance(),
        beaconsActivated: beaconVisuals.filter((beacon) => beacon.active).length,
        cargoLoaded,
        cargoDelivered,
        returnToBase: stage === "return" || stage === "complete",
        complete: stage === "complete",
        weatherTarget,
        weatherIntensity: weather.state.precipitation01,
        snowAlive,
        snowEmitted: system?.emitted ?? 0,
        snowpackDepthM,
        snowCover: alpineSnowCover01(snowpackDepthM),
        temperatureC: weather.state.temperatureC,
        grip: vehicle.surfaceGrip,
        speedKph: Math.abs(vehicle.speed) * 3.6,
        headlightsOn,
        parked,
        dynamicProps: dynamicPropCount,
        routeLength: Math.hypot(RELAY_SITES[2]!.x - DEPOT_X, RELAY_SITES[2]!.z - BASE_Z),
        positionX: vehicle.position.x,
        positionY: vehicle.position.y,
        positionZ: vehicle.position.z,
        physicsBodies: physicsWorld.bodies.length,
        physicsSteps: physicsWorld.stepCount,
        trees: vegetation.count,
        trackTiles: trackLayer.tileCount,
        sound: {
          enabled: soundOn,
          running: sound?.context.state === "running",
          engineHz: sound?.truck.levels.engineFrequency ?? 0,
          impacts: sound?.analyzer.events.length ?? 0,
          impactsDropped: sound?.analyzer.dropped ?? 0,
          scrapes: sound?.analyzer.scrapes.length ?? 0,
          voices: sound?.impacts.activeVoices ?? 0,
        },
      };
    },
  };
}

/**
 * Where the flat tread starts and ends along the tyre profile's arc length (0..1), so the tread
 * texture lands on the tread and the sidewall stays smooth. Mirrors `tyreProfile` in the vehicle.
 */
function tyreTreadSpan(wheelRadius: number, wheelWidth: number): [number, number] {
  const k = wheelRadius / 0.42;
  const h = wheelWidth / 2 / 0.15;
  const pts: Array<[number, number]> = [
    [0.265, -0.115], [0.3, -0.138], [0.35, -0.15], [0.395, -0.146], [0.412, -0.128], [0.42, -0.095],
    [0.42, 0.095], [0.412, 0.128], [0.395, 0.146], [0.35, 0.15], [0.3, 0.138], [0.265, 0.115],
  ];
  const arc: number[] = [0];
  for (let i = 1; i < pts.length; i++) arc.push(arc[i - 1]! + Math.hypot((pts[i]![0] - pts[i - 1]![0]) * k, (pts[i]![1] - pts[i - 1]![1]) * h));
  const total = arc[arc.length - 1]!;
  return [arc[5]! / total, arc[6]! / total];
}

