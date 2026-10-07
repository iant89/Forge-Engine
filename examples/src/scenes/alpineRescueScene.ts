import {
  Camera,
  ColliderComponent,
  Color,
  DayNightCycle,
  Geometry,
  HeightfieldShape,
  Light,
  LightningSystem,
  Material,
  ParticleWorld,
  Quat,
  PhysicsSystem,
  PhysicsWorld,
  Renderable,
  RigidBodyComponent,
  Scene,
  TerrainWorld,
  Vec3,
  Vehicle,
  VehicleComponent,
  VehicleSystem,
  createVehicleConfig,
  WeatherSystem,
  type Engine,
  createBox,
  createCylinder,
  createRealisticTerrainMaterial,
  createRealisticTerrainPipeline,
  createTorus,
  createVehicleChassis,
  heightFunctionGround,
} from "@forge/engine";
import type { DemoSceneHandle } from "./cubesScene.js";
import { attachVehicleTouch } from "../controls/vehicleTouch.js";

const SEED = 7421;
const BASE_X = 256;
const DEPOT_X = BASE_X - 16;
const DEPOT_HUT_X = DEPOT_X - 14;
const BASE_Z = -188;
const ROUTE_X = 256;
const ROUTE_START_Z = -166;
const RELAY_SITES = [
  { name: "EAST RIDGE DISTRESS BEACON", callsign: "ECHO 01", x: 269, z: -92 },
  { name: "PINE NOTCH DISTRESS BEACON", callsign: "ECHO 02", x: 244, z: -4 },
  { name: "GLACIER GATE DISTRESS BEACON", callsign: "ECHO 03", x: 260, z: 96 },
] as const;
const ROUTE_MAIN_START_Z = ROUTE_START_Z - 13;
const ROUTE_END_Z = RELAY_SITES[2].z + 28;
const DEPOT_APPROACH_Z = BASE_Z + 8.5;
const ROUTE_MERGE_Z = ROUTE_START_Z + 12;
const DEPOT_APPROACH_X = DEPOT_X + 4.5;
const INTERACT_RADIUS = 11;
const ROAD_WIDTH = 5.2;

function mainRouteCenterX(z: number): number {
  const t = (z - ROUTE_MAIN_START_Z) / (ROUTE_END_Z - ROUTE_MAIN_START_Z);
  return ROUTE_X + Math.sin(t * Math.PI * 2.4) * 4.2 + Math.sin(t * 8.1) * 1.15;
}

function roadCenterX(z: number): number {
  if (z >= ROUTE_MERGE_Z) return mainRouteCenterX(z);
  const mergeX = mainRouteCenterX(ROUTE_MERGE_Z);
  const t = Math.max(0, Math.min(1, (z - DEPOT_APPROACH_Z) / (ROUTE_MERGE_Z - DEPOT_APPROACH_Z)));
  const eased = t * t * (3 - 2 * t);
  return DEPOT_APPROACH_X + (mergeX - DEPOT_APPROACH_X) * eased;
}

type WeatherPresetName = "clear" | "overcast" | "rain" | "storm";

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
  snowAlive: number;
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
}

export interface AlpineRescueSceneHandle extends DemoSceneHandle {
  interact(): boolean;
  setWeatherTarget(preset: WeatherPresetName): void;
  snapshot(): AlpineRescueSnapshot;
}

function seededNoise(index: number, salt: number): number {
  const value = Math.sin(index * 127.1 + salt * 311.7) * 43_758.5453;
  return value - Math.floor(value);
}

function roadGeometrySource(heightAt: (x: number, z: number) => number) {
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const samples = 320;
  const z0 = DEPOT_APPROACH_Z;
  const z1 = ROUTE_END_Z;

  for (let i = 0; i <= samples; i++) {
    const t = i / samples;
    const z = z0 + (z1 - z0) * t;
    const centerX = roadCenterX(z);
    const beforeZ = Math.max(z0, z - 0.5);
    const afterZ = Math.min(z1, z + 0.5);
    const beforeX = roadCenterX(beforeZ);
    const afterX = roadCenterX(afterZ);
    const dx = afterX - beforeX;
    const dz = afterZ - beforeZ;
    const length = Math.hypot(dx, dz) || 1;
    const sideX = dz / length;
    const sideZ = -dx / length;

    for (const side of [-1, 1]) {
      const x = centerX + sideX * ROAD_WIDTH * 0.5 * side;
      const sampleZ = z + sideZ * ROAD_WIDTH * 0.5 * side;
      const y = heightAt(x, sampleZ) + 0.22;
      positions.push(x, y, sampleZ);
      normals.push(0, 1, 0);
      uvs.push(side === -1 ? 0 : 1, t * 13);
    }

    if (i < samples) {
      const a = i * 2;
      const b = a + 1;
      const c = a + 2;
      const d = a + 3;
      indices.push(a, b, c, b, d, c);
    }
  }

  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    uvs: new Float32Array(uvs),
    indices: new Uint32Array(indices),
  };
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
): void {
  const collider = new ColliderComponent();
  collider.setBox(halfExtents.x, halfExtents.y, halfExtents.z);
  const body = new RigidBodyComponent();
  body.bodyType = options.mass === undefined ? "static" : "dynamic";
  body.mass = options.mass ?? 0;
  body.friction = options.friction ?? 0.72;
  body.restitution = options.restitution ?? 0.08;
  entity.add(collider);
  entity.add(body);
}

export function buildAlpineRescueScene(engine: Engine): AlpineRescueSceneHandle {
  const scene = new Scene({ name: "Alpine Search & Rescue: Whiteout Run" });
  const ownedGeometries: Geometry[] = [];
  const ownedMaterials: Material[] = [];
  const ownGeometry = <T extends Geometry>(geometry: T): T => {
    ownedGeometries.push(geometry);
    return geometry;
  };
  const ownMaterial = <T extends Material>(material: T): T => {
    ownedMaterials.push(material);
    return material;
  };

  const terrainPipeline = createRealisticTerrainPipeline({
    seed: SEED,
    continentalAmplitude: 80,
    mountainAmplitude: 160,
    hillAmplitude: 35,
    detailAmplitude: 5,
    warpAmount: 60,
    snowLine: 160,
    thermalIterations: 2,
    hydraulicIterations: 3,
    enableRivers: true,
    enableDetail: false,
    scatterCount: 10,
  });
  const terrainMaterial = createRealisticTerrainMaterial("alpine", {
    color: Color.fromSrgbHex(0xc5d0d3),
    roughness: 0.92,
    metallic: 0.01,
  });
  const terrain = new TerrainWorld({
    seed: SEED,
    viewDistance: 580,
    maxLOD: 3,
    chunkSize: 128,
    chunkResolution: 33,
    maxChunksLoaded: 78,
    maxGenerationsPerFrame: 2,
    warmUpChunks: 14,
    pipeline: terrainPipeline,
    material: terrainMaterial,
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
  if (terrainBody) terrainBody.friction = 0.96;

  const roadGeometry = ownGeometry(Geometry.create(engine.gpu, roadGeometrySource(heightAt)));
  const roadMaterial = ownMaterial(new Material({
    label: "whiteout-run packed snow trail",
    color: Color.fromSrgbHex(0x849398),
    roughness: 0.92,
    metallic: 0,
    doubleSided: true,
  }));
  addRenderable(scene, "Packed snow rescue trail", new Vec3(), roadGeometry, roadMaterial, false);

  const snowEdgeMaterial = ownMaterial(new Material({
    label: "snow trail edge",
    color: Color.fromSrgbHex(0xb8c8cd),
    roughness: 0.87,
  }));
  const trailStakeGeometry = ownGeometry(createBox(engine.gpu, { width: 0.14, height: 1.45, depth: 0.14 }));
  const trailCapGeometry = ownGeometry(createBox(engine.gpu, { width: 0.28, height: 0.14, depth: 0.2 }));
  const trailCapMaterial = ownMaterial(Material.emissive(0x4bd7c4, 1.3, { label: "trail marker teal" }));
  for (let i = 0; i < 15; i++) {
    const t = i / 14;
    const z = ROUTE_START_Z + 10 + (RELAY_SITES[2].z - ROUTE_START_Z - 6) * t;
    const x = mainRouteCenterX(z);
    for (const side of [-1, 1]) {
      const px = x + side * (ROAD_WIDTH * 0.55 + 0.8);
      const pz = z + Math.sin(t * Math.PI * 2.4 + 0.2) * 0.6;
      const py = heightAt(px, pz);
      const post = addRenderable(scene, `Trail marker ${i + 1} ${side < 0 ? "left" : "right"}`, new Vec3(px, py + 0.72, pz), trailStakeGeometry, snowEdgeMaterial);
      addChildRenderable(scene, post, `Trail marker glint ${i + 1}`, new Vec3(0, 0.53, 0), trailCapGeometry, trailCapMaterial, false);
    }
  }

  const groundMaterial = ownMaterial(new Material({ label: "rescue station timber", color: Color.fromSrgbHex(0x49565b), roughness: 0.86 }));
  const redMaterial = ownMaterial(new Material({ label: "rescue orange", color: Color.fromSrgbHex(0xe56d38), roughness: 0.55, metallic: 0.08 }));
  const darkMetalMaterial = ownMaterial(Material.metal(0x303a40, 0.42));
  const glassMaterial = ownMaterial(new Material({ label: "rescue vehicle glass", color: Color.fromSrgbHex(0x153440), metallic: 0.55, roughness: 0.18 }));
  const tireMaterial = ownMaterial(new Material({ label: "winter tire rubber", color: Color.fromSrgbHex(0x151b1e), roughness: 0.94 }));
  const bodyMaterial = ownMaterial(new Material({ label: "SAR vehicle enamel", color: Color.fromSrgbHex(0xff7048), emissive: Color.fromSrgbHex(0x571e11), emissiveStrength: 0.26, metallic: 0.12, roughness: 0.36 }));
  const beaconDimMaterial = ownMaterial(Material.emissive(0x29a9a8, 0.65, { label: "inactive beacon ring" }));
  const beaconActiveMaterial = ownMaterial(Material.emissive(0x68ffd9, 3.4, { label: "active beacon ring" }));
  const beaconDoneMaterial = ownMaterial(Material.emissive(0x94ee85, 1.5, { label: "completed beacon ring" }));
  const baseLightMaterial = ownMaterial(Material.emissive(0xf1d58a, 1.1, { label: "station lantern" }));
  const cargoMaterial = ownMaterial(new Material({ label: "medical supply case", color: Color.fromSrgbHex(0x309c86), metallic: 0.18, roughness: 0.42 }));
  const crateMaterial = ownMaterial(new Material({ label: "trail cargo crate", color: Color.fromSrgbHex(0x855b38), roughness: 0.83 }));
  const pineMaterial = ownMaterial(new Material({ label: "mountain pine", color: Color.fromSrgbHex(0x244638), roughness: 0.9 }));
  const pineDarkMaterial = ownMaterial(new Material({ label: "pine shadow", color: Color.fromSrgbHex(0x19352d), roughness: 0.92 }));
  const rockMaterial = ownMaterial(new Material({ label: "snow-scoured rock", color: Color.fromSrgbHex(0x667174), roughness: 0.97 }));
  const headlampMaterial = ownMaterial(Material.emissive(0xffe8b8, 1.8, { label: "rescue headlamp glass" }));
  const redFlasherMaterial = ownMaterial(Material.emissive(0xf04435, 2.8, { label: "red emergency light" }));
  const blueFlasherMaterial = ownMaterial(Material.emissive(0x47baff, 2.8, { label: "blue emergency light" }));

  const cubeGeometry = ownGeometry(createBox(engine.gpu, { width: 1, height: 1, depth: 1 }));
  const trunkGeometry = ownGeometry(createCylinder(engine.gpu, { radiusTop: 0.13, radiusBottom: 0.23, height: 2.2, radialSegments: 8 }));
  const pineLowerGeometry = ownGeometry(createCylinder(engine.gpu, { radiusTop: 0.04, radiusBottom: 1.35, height: 2.8, radialSegments: 8 }));
  const pineUpperGeometry = ownGeometry(createCylinder(engine.gpu, { radiusTop: 0.02, radiusBottom: 0.96, height: 2.35, radialSegments: 8 }));
  const beaconPoleGeometry = ownGeometry(createCylinder(engine.gpu, { radiusTop: 0.09, radiusBottom: 0.13, height: 3.4, radialSegments: 8 }));
  const beaconTopGeometry = ownGeometry(createBox(engine.gpu, { width: 0.58, height: 0.32, depth: 0.58 }));
  const beaconRingGeometry = ownGeometry(createTorus(engine.gpu, { radius: 2.4, tube: 0.1 }));
  const stationRoofGeometry = ownGeometry(createBox(engine.gpu, { width: 6.2, height: 0.42, depth: 5.2 }));
  const stationWallGeometry = ownGeometry(createBox(engine.gpu, { width: 5.7, height: 2.75, depth: 4.5 }));
  const shedDoorGeometry = ownGeometry(createBox(engine.gpu, { width: 1.6, height: 2.15, depth: 0.16 }));
  const headlampGeometry = ownGeometry(createBox(engine.gpu, { width: 0.3, height: 0.24, depth: 0.12 }));
  const flasherGeometry = ownGeometry(createBox(engine.gpu, { width: 0.36, height: 0.16, depth: 0.2 }));
  const wheelGeometry = ownGeometry(createBox(engine.gpu, { width: 0.34, height: 0.78, depth: 0.78 }));
  const bodyGeometry = ownGeometry(createBox(engine.gpu, { width: 1.96, height: 0.76, depth: 3.82 }));
  const cabinGeometry = ownGeometry(createBox(engine.gpu, { width: 1.63, height: 0.88, depth: 1.92 }));
  const bumperGeometry = ownGeometry(createBox(engine.gpu, { width: 2.08, height: 0.2, depth: 0.22 }));
  const roofGeometry = ownGeometry(createBox(engine.gpu, { width: 1.26, height: 0.15, depth: 0.66 }));

  // Weathered mountain rescue outpost: a warm, readable landmark at the routehead.
  const baseHeight = heightAt(DEPOT_HUT_X, BASE_Z);
  const depotGround = heightAt(DEPOT_X, BASE_Z);
  const base = scene.createTransformedEntity("Whiteout Run rescue depot", new Vec3(DEPOT_HUT_X, baseHeight, BASE_Z));
  const station = addRenderable(scene, "Rescue depot walls", new Vec3(0, 1.55, -0.55), stationWallGeometry, groundMaterial);
  base.addChild(station);
  const roof = addRenderable(scene, "Rescue depot roof", new Vec3(0, 3.1, -0.55), stationRoofGeometry, darkMetalMaterial);
  base.addChild(roof);
  const door = addRenderable(scene, "Rescue depot door", new Vec3(0, 1.12, 1.72), shedDoorGeometry, redMaterial);
  base.addChild(door);
  const signGeometry = ownGeometry(createBox(engine.gpu, { width: 3.2, height: 0.58, depth: 0.14 }));
  const sign = addRenderable(scene, "SAR DEPOT sign", new Vec3(0, 3.4, 1.84), signGeometry, beaconDoneMaterial, false);
  base.addChild(sign);
  for (const side of [-1, 1]) {
    const lantern = scene.createTransformedEntity(`Depot lantern ${side}`, new Vec3(side * 2.22, 2.72, 1.88));
    const lanternLight = new Light();
    lanternLight.kind = "point";
    lanternLight.setColor(1, 0.72, 0.43);
    lanternLight.intensity = 18;
    lanternLight.range = 19;
    lantern.add(lanternLight);
    base.addChild(lantern);
    const lanternBox = addRenderable(scene, `Depot lantern glow ${side}`, new Vec3(side * 2.22, 2.72, 1.94), headlampGeometry, baseLightMaterial, false);
    base.addChild(lanternBox);
  }
  // A low plinth makes the base beacon legible from the approach.
  const baseMarker = addRenderable(scene, "Rescue depot navigation ring", new Vec3(DEPOT_X, depotGround + 0.18, BASE_Z + 4), beaconRingGeometry, beaconDimMaterial, false);
  baseMarker.transform.scale = new Vec3(0.68, 0.68, 0.68);

  // Route and destination beacons.
  const beaconVisuals: BeaconVisual[] = [];
  for (let i = 0; i < RELAY_SITES.length; i++) {
    const site = RELAY_SITES[i]!;
    const y = heightAt(site.x, site.z);
    const root = scene.createTransformedEntity(`${site.callsign} beacon`, new Vec3(site.x, y, site.z));
    const pole = addRenderable(scene, `${site.callsign} transmitter mast`, new Vec3(0, 1.7, 0), beaconPoleGeometry, darkMetalMaterial);
    root.addChild(pole);
    const cap = addRenderable(scene, `${site.callsign} beacon housing`, new Vec3(0, 3.38, 0), beaconTopGeometry, redMaterial);
    root.addChild(cap);
    const halo = addRenderable(scene, `${site.callsign} activation ring`, new Vec3(0, 0.19, 0), beaconRingGeometry, beaconDimMaterial, false);
    halo.transform.scale = new Vec3(1.18, 1.18, 1.18);
    root.addChild(halo);
    const lightEntity = scene.createTransformedEntity(`${site.callsign} search light`, new Vec3(0, 3.8, 0));
    const beaconLight = new Light();
    beaconLight.kind = "point";
    beaconLight.setColor(0.32, 0.83, 0.72);
    beaconLight.intensity = 9;
    beaconLight.range = 42;
    lightEntity.add(beaconLight);
    root.addChild(lightEntity);
    beaconVisuals.push({ ring: halo.require(Renderable), light: beaconLight, active: false });
  }

  // The frozen spruce line and scattered granite make the winding service track read at speed.
  const rockGeometry = ownGeometry(createBox(engine.gpu, { width: 1.2, height: 0.84, depth: 1.1 }));
  for (let i = 0; i < 22; i++) {
    const side = i % 2 === 0 ? -1 : 1;
    const x = ROUTE_X + side * (28 + seededNoise(i, 2) * 66);
    const z = ROUTE_START_Z - 34 + seededNoise(i, 7) * 300;
    const y = heightAt(x, z);
    const tree = scene.createTransformedEntity(`Alpine spruce ${i + 1}`, new Vec3(x, y, z));
    const trunk = addRenderable(scene, `Spruce trunk ${i + 1}`, new Vec3(0, 1.12, 0), trunkGeometry, groundMaterial, false);
    tree.addChild(trunk);
    const lower = addRenderable(scene, `Spruce boughs lower ${i + 1}`, new Vec3(0, 2.05, 0), pineLowerGeometry, pineMaterial);
    lower.transform.scale = new Vec3(1, 1 + seededNoise(i, 9) * 0.32, 1);
    tree.addChild(lower);
    const upper = addRenderable(scene, `Spruce boughs upper ${i + 1}`, new Vec3(0, 3.05, 0), pineUpperGeometry, pineDarkMaterial);
    upper.transform.scale = new Vec3(1, 0.94 + seededNoise(i, 11) * 0.4, 1);
    tree.addChild(upper);
  }
  for (let i = 0; i < 16; i++) {
    const side = i % 2 === 0 ? -1 : 1;
    const z = ROUTE_START_Z + 14 + i * 15.2;
    const x = ROUTE_X + side * (6.7 + seededNoise(i, 15) * 4.8);
    const y = heightAt(x, z);
    const rock = addRenderable(scene, `Roadside boulder ${i + 1}`, new Vec3(x, y + 0.34, z), rockGeometry, rockMaterial);
    const scale = 0.62 + seededNoise(i, 19) * 0.9;
    rock.transform.scale = new Vec3(scale * 1.22, scale, scale * 0.94);
    rock.transform.rotation = new Quat().setAxisAngle(new Vec3(0, 1, 0), seededNoise(i, 21) * Math.PI * 2);
    makeBoxBody(rock, { x: scale * 0.73, y: scale * 0.42, z: scale * 0.52 });
  }

  // Establish a shared terrain world so cargo and route crates can bounce, tip, and collide with the truck.
  const physicsSystem = new PhysicsSystem({ world: physicsWorld });
  scene.world.registerSystem(new VehicleSystem());
  scene.world.registerSystem(physicsSystem);

  const vehicle = new Vehicle(createVehicleConfig({
    mass: 2380,
    wheelbase: 2.72,
    track: 1.67,
    wheelRadius: 0.42,
    cgHeight: 0.58,
    mu: 1.24,
    rollingResistance: 0.042,
    maxBrakeTorque: 5600,
    parkingBrakeTorque: 9400,
  }));
  vehicle.position.set(DEPOT_APPROACH_X, 0, DEPOT_APPROACH_Z);
  vehicle.placeOnGround(groundAt);
  vehicle.yaw = 0;
  vehicle.input.brake = 1;
  vehicle.input.handbrake = 1;
  let startupHold = true;
  let parked = false;

  const truckRoot = scene.createTransformedEntity("Alpine rescue 4x4", vehicle.position.clone());
  const vehicleBody = addRenderable(scene, "Rescue 4x4 body", new Vec3(0, 0.05, 0), bodyGeometry, bodyMaterial);
  truckRoot.addChild(vehicleBody);
  const cabin = addRenderable(scene, "Rescue 4x4 cab", new Vec3(0, 0.77, -0.25), cabinGeometry, glassMaterial);
  truckRoot.addChild(cabin);
  const roofRack = addRenderable(scene, "Rescue roof rack", new Vec3(0, 1.26, -0.2), roofGeometry, darkMetalMaterial);
  truckRoot.addChild(roofRack);
  for (const z of [-1.9, 1.85]) {
    const bumper = addRenderable(scene, `Rescue bumper ${z}`, new Vec3(0, -0.2, z), bumperGeometry, darkMetalMaterial);
    truckRoot.addChild(bumper);
  }
  const wheelEntities: ReturnType<Scene["createTransformedEntity"]>[] = [];
  for (let i = 0; i < vehicle.wheels.length; i++) {
    const wheel = addRenderable(scene, `Rescue wheel ${i + 1}`, new Vec3(vehicle.wheels[i]!.x, 0, vehicle.wheels[i]!.z), wheelGeometry, tireMaterial);
    wheelEntities.push(wheel);
    truckRoot.addChild(wheel);
  }
  for (const side of [-1, 1]) {
    const lamp = scene.createTransformedEntity(`Rescue headlamp ${side}`, new Vec3(side * 0.68, 0.19, 1.97));
    const lampMesh = addRenderable(scene, `Headlamp lens ${side}`, new Vec3(), headlampGeometry, headlampMaterial, false);
    lamp.addChild(lampMesh);
    const spot = new Light();
    spot.kind = "spot";
    spot.setColor(1, 0.84, 0.62);
    spot.intensity = 68;
    spot.range = 88;
    spot.innerCone = 0.88;
    spot.outerCone = 0.66;
    lamp.add(spot);
    truckRoot.addChild(lamp);
  }
  const beaconBar = addRenderable(scene, "Rescue light bar", new Vec3(0, 1.42, 0.18), roofGeometry, darkMetalMaterial, false);
  truckRoot.addChild(beaconBar);
  const redLamp = addRenderable(scene, "Rescue red flasher", new Vec3(-0.4, 1.52, 0.18), flasherGeometry, redFlasherMaterial, false);
  const blueLamp = addRenderable(scene, "Rescue blue flasher", new Vec3(0.4, 1.52, 0.18), flasherGeometry, blueFlasherMaterial, false);
  truckRoot.addChild(redLamp);
  truckRoot.addChild(blueLamp);
  const redFlasher = redLamp.require(Renderable);
  const blueFlasher = blueLamp.require(Renderable);
  let flashFrame = -1;

  const chassisBody = createVehicleChassis(vehicle, physicsWorld, {
    halfExtents: { x: 1.02, y: 0.43, z: 1.82 },
    friction: 0.92,
    restitution: 0.02,
  });
  const vehicleComponent = new VehicleComponent(vehicle, groundAt);
  vehicleComponent.wheelEntities = wheelEntities.map((entity) => entity.id);
  vehicleComponent.attachChassis(chassisBody, physicsWorld);
  truckRoot.add(vehicleComponent);

  // Objective cargo and physics-enabled tip hazards use the same body/collider integration as the truck.
  const supplyCrate = scene.createTransformedEntity(
    "Priority medical supply case",
    new Vec3(DEPOT_X + 3, heightAt(DEPOT_X + 3, BASE_Z + 2) + 0.53, BASE_Z + 2),
  );
  const cargoMesh = addRenderable(scene, "Priority medical supply case mesh", new Vec3(), cubeGeometry, cargoMaterial);
  cargoMesh.transform.scale = new Vec3(0.8, 0.72, 0.8);
  supplyCrate.addChild(cargoMesh);
  makeBoxBody(supplyCrate, { x: 0.42, y: 0.36, z: 0.42 }, { mass: 28, friction: 0.78, restitution: 0.06 });
  let dynamicPropCount = 1;
  for (let i = 0; i < 7; i++) {
    const z = ROUTE_START_Z + 24 + i * 31;
    const x = ROUTE_X + (i % 2 === 0 ? 1 : -1) * (2.9 + seededNoise(i, 27) * 2.0);
    const y = heightAt(x, z);
    const crate = scene.createTransformedEntity(`Physical trail supply crate ${i + 1}`, new Vec3(x, y + 0.48, z));
    const mesh = addRenderable(scene, `Trail supply crate ${i + 1} mesh`, new Vec3(), cubeGeometry, crateMaterial);
    mesh.transform.scale = new Vec3(0.94, 0.94, 0.94);
    crate.addChild(mesh);
    makeBoxBody(crate, { x: 0.47, y: 0.47, z: 0.47 }, { mass: 19 + (i % 3) * 4, friction: 0.74, restitution: 0.1 });
    dynamicPropCount++;
  }

  const sunEntity = scene.createTransformedEntity("Whiteout Run arctic sun", new Vec3(0, 0, 0));
  const sun = new Light();
  sun.kind = "directional";
  sun.setColor(0.72, 0.84, 1);
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
  scene.setSky({ quality: "medium", turbidity: 7.8, rayleigh: 1.35, mie: 0.78, exposure: 1.0, sunDiscIntensity: 110 });
  scene.setClouds({ coverage: 0.74, density: 0.78, height: 720, scale: 0.0011, silverLining: 0.72, albedo: Color.fromSrgbHex(0xd7e0e3) });
  scene.setAmbient(Color.fromSrgbHex(0x8198a0), 0.44);
  scene.settings.hdr = true;
  scene.settings.toneMapping = "aces";
  scene.settings.bloom.enabled = true;
  scene.settings.bloom.threshold = 1.12;
  scene.settings.bloom.intensity = 0.12;
  scene.settings.shadow.enabled = true;
  scene.settings.shadow.cascades = 3;
  scene.settings.shadow.distance = 520;
  scene.settings.shadow.mapSize = 2048;
  scene.settings.ssao.enabled = true;
  scene.setExposure(1.04);

  const weather = new WeatherSystem({
    initial: {
      windSpeed: 6,
      windDirection: 0.92,
      gust: 0.42,
      temperatureC: 4,
      humidity01: 0.82,
      precipitation01: 0.05,
      storm01: 0.04,
      cloudCoverage: 0.74,
    },
    target: "overcast",
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
    rainFogDensity: 0.0042,
    driveFog: true,
    driveClouds: true,
    driveSky: true,
  });
  scene.add(weather);

  const particleGeometry = ownGeometry(createBox(engine.gpu, { width: 0.045, height: 0.58, depth: 0.045 }));
  const snowMaterial = ownMaterial(Material.unlit({
    label: "whiteout snow streak",
    color: 0xc5d9e3,
    opacity: 0.62,
    transparent: true,
    doubleSided: true,
  }));
  const particleWorld = new ParticleWorld({
    name: "Whiteout Run snowfall",
    capacity: 900,
    maxEmitsPerFrame: 360,
    gravity: { x: 0, y: 0, z: 0 },
    drag: 0,
    seed: 0x51a7,
  });
  const snowEmitter = particleWorld.simulation.emitter;
  snowEmitter.rate = 0;
  snowEmitter.lifeMin = 2.2;
  snowEmitter.lifeMax = 3.1;
  snowEmitter.size = 0.9;
  snowEmitter.position = { x: vehicle.position.x, y: vehicle.position.y + 20, z: vehicle.position.z };
  snowEmitter.jitter = { x: 50, y: 20, z: 50 };
  snowEmitter.cone = { direction: { x: 0.25, y: -0.97, z: 0.12 }, angle: 0.16, speedMin: 7.5, speedMax: 12.5 };
  snowEmitter.color = { r: 0.86, g: 0.94, b: 1, a: 0.8 };
  const snowSpriteIds: number[] = [];
  for (let i = 0; i < particleWorld.simulation.capacity; i++) {
    const flake = scene.createTransformedEntity(`whiteout-snow-${i}`, new Vec3(0, -500, 0));
    const renderable = new Renderable();
    renderable.geometry = particleGeometry;
    renderable.material = snowMaterial;
    renderable.castShadow = false;
    renderable.receiveShadow = false;
    renderable.visible = false;
    scene.world.addComponent(flake.id, renderable);
    snowSpriteIds.push(flake.id);
  }
  particleWorld.spriteEntities = snowSpriteIds;
  scene.add(particleWorld);

  const lightning = new LightningSystem({
    name: "Whiteout Run lightning",
    seed: SEED + 400,
    rate: 0.14,
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
    target: new Vec3(vehicle.position.x, vehicle.position.y + 1.1, vehicle.position.z),
    distance: 14.5,
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
    return `ALPINE SAR  /  WHITEOUT RUN\n${current.title}\n${current.detail}\nRANGE  ${distance.toFixed(0)} m     BEACONS  ${relays}/3     MED KIT  ${cargo}\n${band}  ·  ${weather.state.windSpeed.toFixed(0)} m/s wind     ${speed} km/h\n${hint}`;
  };

  const uiRoot = typeof document !== "undefined" ? document.getElementById("vehicle-touch") : null;
  const touch = uiRoot ? attachVehicleTouch(uiRoot, { onParkToggle: () => { parked = !parked; touch?.setPark(parked); } }) : null;
  const interactButton = typeof document !== "undefined" ? document.getElementById("rescue-interact") as HTMLButtonElement | null : null;
  const weatherButton = typeof document !== "undefined" ? document.getElementById("rescue-weather") as HTMLButtonElement | null : null;
  const headlightButton = typeof document !== "undefined" ? document.getElementById("rescue-headlights") as HTMLButtonElement | null : null;
  const parkButton = typeof document !== "undefined" ? document.getElementById("rescue-park") as HTMLButtonElement | null : null;

  const updateUi = () => {
    if (interactButton) {
      interactButton.disabled = stage === "complete" || objectiveDistance() > INTERACT_RADIUS;
      interactButton.textContent = stage === "complete" ? "MISSION COMPLETE" : stage === "return" ? "RETURN TO DEPOT" : "INTERACT  ·  E";
    }
    if (weatherButton) weatherButton.textContent = weatherTarget === "storm" ? "CALM THE STORM" : "CALL STORM";
    if (headlightButton) headlightButton.textContent = headlightsOn ? "LIGHTS ON · F" : "LIGHTS OFF · F";
    if (parkButton) {
      parkButton.textContent = parked ? "RELEASE PARK · P" : "PARK · P";
      parkButton.classList.toggle("active", parked);
      parkButton.setAttribute("aria-pressed", String(parked));
    }
  };

  const setWeatherTarget = (preset: WeatherPresetName) => {
    weatherTarget = preset;
    weather.setTarget(preset);
    updateUi();
  };

  const interact = (): boolean => {
    if (stage === "complete" || objectiveDistance() > INTERACT_RADIUS) return false;
    if (stage === "load-kit") {
      supplyCrate.remove(RigidBodyComponent);
      supplyCrate.remove(ColliderComponent);
      supplyCrate.parent = null;
      supplyCrate.transform.position = new Vec3(0, 1.42, -0.14);
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
      const drop = new Vec3(RELAY_SITES[2]!.x + 3.7, heightAt(RELAY_SITES[2]!.x + 3.7, RELAY_SITES[2]!.z + 1) + 0.42, RELAY_SITES[2]!.z + 1);
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
    for (const entity of truckRoot.children) {
      const light = entity.get(Light);
      if (light?.kind === "spot") light.intensity = headlightsOn ? 68 : 0;
    }
    updateUi();
  };
  const onWeatherClick = () => {
    const next: WeatherPresetName = weatherTarget === "storm" ? "clear" : "storm";
    weather.snapTo(next);
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

  const onKeyDown = (event: KeyboardEvent) => {
    const key = event.code.toLowerCase();
    if (["arrowup", "arrowdown", "arrowleft", "arrowright", "space"].includes(key)) event.preventDefault();
    keys.add(key);
    if (!event.repeat && key === "keye") interact();
    if (!event.repeat && key === "keyp") onParkClick();
    if (!event.repeat && key === "keyf") toggleHeadlights();
    if (!event.repeat && key === "keyg") onWeatherClick();
  };
  const onKeyUp = (event: KeyboardEvent) => keys.delete(event.code.toLowerCase());
  const onBlur = () => keys.clear();
  if (typeof window !== "undefined") {
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
  }

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

    const flasher = Math.floor(elapsed / 0.24);
    if (flasher !== flashFrame) {
      flashFrame = flasher;
      redFlasher.material = flasher % 2 === 0 ? redFlasherMaterial : darkMetalMaterial;
      blueFlasher.material = flasher % 2 === 0 ? darkMetalMaterial : blueFlasherMaterial;
    }

    const precipitation = weather.state.precipitation01;
    snowEmitter.rate = 20 + precipitation * 1180;
    snowEmitter.cone.speedMin = 6.8 + precipitation * 3.4;
    snowEmitter.cone.speedMax = 11.4 + precipitation * 5.8;
    snowEmitter.jitter.x = 46 + precipitation * 26;
    snowEmitter.jitter.y = 18 + precipitation * 9;
    snowEmitter.jitter.z = 46 + precipitation * 26;
    const wind = weather.meanWind();
    const driftX = wind.x + 3.5 + Math.sin(elapsed * 0.13) * 1.8;
    const driftZ = wind.y + 1.4;
    const length = Math.hypot(driftX, 11, driftZ) || 1;
    snowEmitter.cone.direction.x = driftX / length;
    snowEmitter.cone.direction.y = -11 / length;
    snowEmitter.cone.direction.z = driftZ / length;
    snowEmitter.position.x = vehicle.position.x;
    snowEmitter.position.y = vehicle.position.y + 20;
    snowEmitter.position.z = vehicle.position.z;
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
    touch?.dispose();
    scene.dispose();
    physicsWorld.clear();
    for (const geometry of ownedGeometries) geometry.dispose();
    for (const material of ownedMaterials) material.dispose();
  };

  return {
    scene,
    cameraEntity,
    camera: cameraSetup,
    followTarget: () => ({ x: vehicle.position.x, y: vehicle.position.y + 0.9, z: vehicle.position.z }),
    controlsHint: "WASD / ARROWS drive · E interact · F headlights · G weather · P park · drag to orbit · touch controls on mobile",
    overlay: hud,
    update,
    dispose,
    interact,
    setWeatherTarget,
    snapshot: () => {
      const current = objective();
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
        snowAlive: particleWorld.simulation.alive,
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
      };
    },
  };
}
