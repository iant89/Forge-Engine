/**
 * Amazon River demo: a navigable launch, the authored floodplain, jungle banks and river landmarks.
 *
 * This is intentionally a scene-side integration of two pure demo modules rather than an engine
 * subsystem. `amazonRiver.ts` is the single height field for the terrain, soundings, camera and
 * grounding; `amazonBoatSim.ts` floats the launch on the same Gerstner waves the water shader draws.
 * The only moving world objects besides the boat are the channel buoys, which sample that shared
 * surface every scene update.
 *
 * Controls: W / ↑ throttle, A / D or ← / → steer, F / N / R select ahead / neutral / astern,
 * Q / E trim the outboard leg, and drag / scroll to orbit and zoom. On touch layouts the vehicle
 * stick and gear pad are reused, with the brake slot replaced by leg-trim buttons.
 */

import {
  Camera,
  Color,
  DayNightCycle,
  Geometry,
  Light,
  Material,
  Renderable,
  Scene,
  SceneObject,
  Texture,
  Transform,
  Vec3,
  WaterSurface,
  computeNormalsAndTangents,
  coneGeometrySource,
  createBox,
  createCylinder,
  createWaterSample,
  cylinderGeometrySource,
  sphereGeometrySource,
  type Engine,
  type Entity,
  type GeometrySource,
  type SystemContext,
  type WaterSample,
} from "@forge/engine";
import { attachVehicleTouch, type VehicleGearPosition } from "../controls/vehicleTouch.js";
import type { DemoSceneHandle } from "./cubesScene.js";
import {
  AMAZON_WATER_LEVEL,
  RIVER_JOURNEY_METRES,
  buildRiverRibbon,
  createAmazonRiver,
  findBankSite,
  riverJitter,
  type AmazonJourneyMark,
  type AmazonRiver,
  createRiverPose,
  type RiverPose,
} from "./amazonRiver.js";
import {
  applyBoatPose,
  createBoatConfig,
  createBoatInput,
  createBoatState,
  resetBoat,
  riverChop,
  stepBoat,
  waterSurfaceHeight,
  type BoatEnvironment,
  type BoatInput,
  type BoatState,
  BOAT_LOA,
  hullHalfWidth,
  hullProfileAt,
} from "./amazonBoatSim.js";

const CAMERA_START_STATION = 92;
const TREE_STATION_STEP = 42;
const TREE_GROUP_LENGTH = 350;
const RIBBON_SPAN = 1250;
const BOAT_START_SPEED_SHIFT_LIMIT = 2.2;

interface MeshAccumulator {
  positions: number[];
  normals: number[];
  uvs: number[];
  indices: number[];
}

interface MeshTransform {
  x: number;
  y: number;
  z: number;
  sx: number;
  sy: number;
  sz: number;
  yaw: number;
}

interface TreeBatch {
  trunks: MeshAccumulator;
  foliage: MeshAccumulator;
  brightFoliage: MeshAccumulator;
  trees: number;
}

interface FloatingMarker {
  entity: Entity;
  x: number;
  z: number;
}

interface RiverDestination {
  mark: AmazonJourneyMark;
  site: { x: number; z: number; y: number; heading: number; distance: number };
}

export interface AmazonRiverSnapshot {
  scene: "amazon-river";
  boatTime: number;
  positionX: number;
  positionY: number;
  positionZ: number;
  heading: number;
  speedWater: number;
  speedGround: number;
  speedKph: number;
  rpm: number;
  gear: "F" | "N" | "R";
  throttle: number;
  helm: number;
  trim: number;
  draft: number;
  depth: number;
  freeboard: number;
  grounded: boolean;
  progress: number;
  station: number;
  destination: string | null;
  destinationDistance: number | null;
  destinations: number;
  channelBuoys: number;
  trees: number;
  oxbows: number;
  riverLength: number;
}

export interface AmazonRiverSceneHandle extends DemoSceneHandle {
  snapshot(): AmazonRiverSnapshot;
  setGear(position: VehicleGearPosition): boolean;
  setTrim(trim: number): void;
  /** Deterministic control hook for the browser smoke and devtools; `null` returns to pilot input. */
  setInput(input: Partial<BoatInput> | null): void;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function createAccumulator(): MeshAccumulator {
  return { positions: [], normals: [], uvs: [], indices: [] };
}

/** Append a primitive into a static mesh batch, baking its scale, yaw and translation into vertices. */
function appendSource(target: MeshAccumulator, source: GeometrySource, transform: MeshTransform): void {
  const vertexCount = Math.floor(source.positions.length / 3);
  const base = target.positions.length / 3;
  const c = Math.cos(transform.yaw);
  const s = Math.sin(transform.yaw);
  for (let i = 0; i < vertexCount; i++) {
    const o = i * 3;
    const px = source.positions[o] ?? 0;
    const py = source.positions[o + 1] ?? 0;
    const pz = source.positions[o + 2] ?? 0;
    const sx = px * transform.sx;
    const sy = py * transform.sy;
    const sz = pz * transform.sz;
    target.positions.push(transform.x + c * sx + s * sz, transform.y + sy, transform.z - s * sx + c * sz);

    const nx = (source.normals?.[o] ?? 0) / transform.sx;
    const ny = (source.normals?.[o + 1] ?? 1) / transform.sy;
    const nz = (source.normals?.[o + 2] ?? 0) / transform.sz;
    const worldNx = c * nx + s * nz;
    const worldNy = ny;
    const worldNz = -s * nx + c * nz;
    const normalLength = Math.hypot(worldNx, worldNy, worldNz) || 1;
    target.normals.push(worldNx / normalLength, worldNy / normalLength, worldNz / normalLength);
    target.uvs.push(source.uvs?.[i * 2] ?? 0, source.uvs?.[i * 2 + 1] ?? 0);
  }
  if (source.indices) {
    for (const index of source.indices) target.indices.push(base + index);
  } else {
    for (let i = 0; i < vertexCount; i++) target.indices.push(base + i);
  }
}

function sourceFromAccumulator(mesh: MeshAccumulator, label: string): GeometrySource {
  return {
    positions: new Float32Array(mesh.positions),
    normals: new Float32Array(mesh.normals),
    uvs: new Float32Array(mesh.uvs),
    indices: new Uint32Array(mesh.indices),
    label,
  };
}

/** Loft a closed launch shell directly from the hull profile used by the hydrostatic solver. */
function launchHullSource(): GeometrySource {
  const longitudinalSteps = 36;
  const sectionSteps = 7;
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  for (let i = 0; i <= longitudinalSteps; i++) {
    const t = i / longitudinalSteps;
    const profile = hullProfileAt(t);
    const chine = profile.chineY;
    const midWidth = hullHalfWidth(t, chine * 0.55);
    const chineWidth = hullHalfWidth(t, chine);
    const section: Array<[number, number]> = [
      [0, profile.keelY],
      [-midWidth, profile.keelY + chine * 0.55],
      [-chineWidth, profile.keelY + chine],
      [-profile.halfBeam, profile.deckY],
      [profile.halfBeam, profile.deckY],
      [chineWidth, profile.keelY + chine],
      [midWidth, profile.keelY + chine * 0.55],
    ];
    const z = (t - 0.5) * BOAT_LOA;
    for (let j = 0; j < sectionSteps; j++) {
      const point = section[j]!;
      positions.push(point[0], point[1], z);
      uvs.push(j / (sectionSteps - 1), t);
    }
  }
  for (let i = 0; i < longitudinalSteps; i++) {
    for (let j = 0; j < sectionSteps; j++) {
      const next = (j + 1) % sectionSteps;
      const a = i * sectionSteps + j;
      const b = (i + 1) * sectionSteps + j;
      const c = i * sectionSteps + next;
      const d = (i + 1) * sectionSteps + next;
      // Rows travel bow-ward (+Z); the section loops around the shell and deck.
      indices.push(a, b, c, b, d, c);
    }
  }
  const capIndices = (row: number, bow: boolean): void => {
    const center = positions.length / 3;
    const z = (row === 0 ? -0.5 : 0.5) * BOAT_LOA;
    positions.push(0, 0.52, z);
    uvs.push(0.5, row);
    for (let j = 0; j < sectionSteps; j++) {
      const next = (j + 1) % sectionSteps;
      if (bow) indices.push(center, row * sectionSteps + next, row * sectionSteps + j);
      else indices.push(center, row * sectionSteps + j, row * sectionSteps + next);
    }
  };
  capIndices(0, false);
  capIndices(longitudinalSteps, true);
  const positionArray = new Float32Array(positions);
  const uvArray = new Float32Array(uvs);
  const indexArray = new Uint32Array(indices);
  const { normals, tangents } = computeNormalsAndTangents(positionArray, indexArray, uvArray);
  return { positions: positionArray, normals, uvs: uvArray, tangents, indices: indexArray, label: "amazon.launch.hull" };
}

/** One low-poly palm-thatched dwelling roof, centred at its base. */
function thatchRoofSource(): GeometrySource {
  const source = coneGeometrySource({ radius: 1, height: 1, radialSegments: 5 });
  return { ...source, label: "amazon.thatch.roof" };
}

/** Ellipse fan for one oxbow; a single shared geometry is scaled and rotated for all four lakes. */
function lakeSurfaceSource(segments = 64): GeometrySource {
  const positions = new Float32Array((segments + 2) * 3);
  const normals = new Float32Array((segments + 2) * 3);
  const uvs = new Float32Array((segments + 2) * 2);
  positions[0] = 0;
  positions[1] = 0;
  positions[2] = 0;
  normals[1] = 1;
  uvs[0] = 0.5;
  uvs[1] = 0.5;
  for (let i = 0; i <= segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    const o = (i + 1) * 3;
    const x = Math.cos(a);
    const z = Math.sin(a);
    positions[o] = x;
    positions[o + 1] = 0;
    positions[o + 2] = z;
    normals[o + 1] = 1;
    uvs[(i + 1) * 2] = 0.5 + 0.5 * x;
    uvs[(i + 1) * 2 + 1] = 0.5 + 0.5 * z;
  }
  const indices = new Uint32Array(segments * 3);
  for (let i = 0; i < segments; i++) {
    const o = i * 3;
    indices[o] = 0;
    indices[o + 1] = i + 2;
    indices[o + 2] = i + 1;
  }
  return { positions, normals, uvs, indices, label: "amazon.oxbow.water" };
}

/** Paired tapering wake lanes that flare aft of the transom. */
function launchWakeSource(): GeometrySource {
  const positions = new Float32Array([
    -0.28, 0, 0, -0.68, 0, -3.4, -3.6, 0, -15.5,
    -0.28, 0, 0, -3.6, 0, -15.5, -1.45, 0, -10.2,
    0.28, 0, 0, 3.6, 0, -15.5, 0.68, 0, -3.4,
    0.28, 0, 0, 1.45, 0, -10.2, 3.6, 0, -15.5,
  ]);
  const normals = new Float32Array(positions.length);
  for (let i = 1; i < normals.length; i += 3) normals[i] = 1;
  const uvs = new Float32Array((positions.length / 3) * 2);
  const indices = new Uint32Array(12);
  for (let i = 0; i < 12; i++) indices[i] = i;
  return { positions, normals, uvs, indices, label: "amazon.launch.wake" };
}

/** Tileable soil palette keyed to the ribbon UV's height-from-water coordinate. */
function createFloodplainTexture(engine: Engine): Texture {
  const size = 256;
  const rgba = new Uint8Array(size * size * 4);
  const stops: Array<{ v: number; color: [number, number, number] }> = [
    { v: 0, color: [48, 54, 38] },
    { v: 0.32, color: [61, 64, 42] },
    { v: 0.42, color: [103, 83, 55] },
    { v: 0.48, color: [76, 103, 57] },
    { v: 0.64, color: [54, 92, 50] },
    { v: 0.86, color: [43, 77, 43] },
    { v: 1, color: [39, 70, 41] },
  ];
  for (let y = 0; y < size; y++) {
    const v = y / (size - 1);
    let lo = stops[0]!;
    let hi = stops[stops.length - 1]!;
    for (let i = 1; i < stops.length; i++) {
      if (v <= stops[i]!.v) {
        lo = stops[i - 1]!;
        hi = stops[i]!;
        break;
      }
    }
    const t = hi.v > lo.v ? (v - lo.v) / (hi.v - lo.v) : 0;
    for (let x = 0; x < size; x++) {
      const u = x / size;
      // Integer-period sine bands meet at the texture edge, avoiding a visible repeat seam.
      const broad = Math.sin((u * 7.0 + v * 3.0) * Math.PI * 2 + 0.7) * 0.5;
      const grain = Math.sin((u * 29.0 - v * 17.0) * Math.PI * 2 + 1.4) * 0.5;
      const mottling = Math.sin((u * 61.0 + v * 47.0) * Math.PI * 2 + 2.3) * 0.5;
      const shade = 1 + broad * 0.085 + grain * 0.042 + mottling * 0.018;
      const o = (y * size + x) * 4;
      for (let channel = 0; channel < 3; channel++) {
        const base = lo.color[channel]! * (1 - t) + hi.color[channel]! * t;
        rgba[o + channel] = Math.round(clamp(base * shade, 0, 255));
      }
      rgba[o + 3] = 255;
    }
  }
  return Texture.fromRgba8(engine.gpu, size, size, rgba, {
    label: "amazon.floodplain.albedo",
    srgb: true,
    mipmaps: true,
  });
}

function meshRenderable(
  scene: Scene,
  name: string,
  position: Vec3,
  geometry: Geometry,
  material: Material,
  options: { castShadow?: boolean; receiveShadow?: boolean; transparent?: boolean } = {},
): Entity {
  const entity = scene.createTransformedEntity(name, position);
  const renderable = new Renderable();
  renderable.geometry = geometry;
  renderable.material = material;
  renderable.castShadow = options.castShadow ?? true;
  renderable.receiveShadow = options.receiveShadow ?? true;
  renderable.transparent = options.transparent ?? false;
  entity.add(renderable);
  return entity;
}

function childRenderable(
  scene: Scene,
  parent: Entity,
  name: string,
  localPosition: Vec3,
  geometry: Geometry,
  material: Material,
  options: { castShadow?: boolean; receiveShadow?: boolean; transparent?: boolean } = {},
): Entity {
  const child = meshRenderable(scene, name, localPosition, geometry, material, options);
  parent.addChild(child);
  return child;
}

function appendRibbonGeometry(
  engine: Engine,
  ribbon: ReturnType<typeof buildRiverRibbon>,
  label: string,
  water = false,
): Geometry {
  const positions = ribbon.positions;
  if (water) {
    // WaterSurface places its entity at the mean stage; retain small branch/lake seam lifts locally.
    for (let i = 1; i < positions.length; i += 3) positions[i] -= AMAZON_WATER_LEVEL;
  }
  return Geometry.create(engine.gpu, {
    positions,
    normals: ribbon.normals,
    uvs: ribbon.uvs,
    indices: ribbon.indices,
    label,
  });
}

function buildForest(engine: Engine, scene: Scene, river: AmazonRiver, owned: Geometry[], materials: {
  trunk: Material;
  leaf: Material;
  brightLeaf: Material;
}): number {
  const trunkSource = cylinderGeometrySource({ radiusTop: 0.68, radiusBottom: 1, height: 1, radialSegments: 7, heightSegments: 2 });
  const crownSource = sphereGeometrySource({ radius: 1, widthSegments: 9, heightSegments: 6 });
  const groups = new Map<number, TreeBatch>();
  const pose = createRiverPose();
  const normal = new Vec3();
  let treeCount = 0;

  for (let s = 84; s < river.length - 30; s += TREE_STATION_STEP) {
    river.main.poseAt(s, pose);
    const groupIndex = Math.floor(s / TREE_GROUP_LENGTH);
    let batch = groups.get(groupIndex);
    if (!batch) {
      batch = { trunks: createAccumulator(), foliage: createAccumulator(), brightFoliage: createAccumulator(), trees: 0 };
      groups.set(groupIndex, batch);
    }
    for (const side of [-1, 1]) {
      for (let row = 0; row < 3; row++) {
        const stationJitter = (riverJitter(s, side * 17 + row, 0x4a6a) - 0.5) * 22;
        const lateralJitter = riverJitter(s + row * 3, side, 0x73a9);
        const station = s + stationJitter;
        river.main.poseAt(station, pose);
        const q = 1.18 + row * 0.29 + lateralJitter * 0.16;
        const lateral = side * pose.halfWidth * q;
        const x = pose.x + pose.leftX * lateral;
        const z = pose.z + pose.leftZ * lateral;
        const y = river.elevationAt(x, z);
        if (y < AMAZON_WATER_LEVEL + 0.45) continue;
        river.normalAt(x, z, normal);
        if (normal.y < 0.73) continue;

        const seed = riverJitter(station, side * 31 + row, 0x30ee);
        const height = 12 + seed * 10;
        const crownRadius = 4.4 + riverJitter(station, row + 23, 0xcea1) * 3.5;
        const yaw = riverJitter(station, side + row * 7, 0x63a2) * Math.PI * 2;
        const xScale = 0.28 + seed * 0.18;
        appendSource(batch.trunks, trunkSource, {
          x, y: y + height * 0.46, z,
          sx: xScale, sy: height * 0.92, sz: xScale,
          yaw,
        });
        const canopy = seed > 0.68 ? batch.brightFoliage : batch.foliage;
        appendSource(canopy, crownSource, {
          x, y: y + height, z,
          sx: crownRadius, sy: crownRadius * 0.72, sz: crownRadius * 0.88,
          yaw,
        });
        appendSource(canopy, crownSource, {
          x: x + Math.cos(yaw) * crownRadius * 0.38,
          y: y + height - crownRadius * 0.12,
          z: z - Math.sin(yaw) * crownRadius * 0.38,
          sx: crownRadius * 0.72, sy: crownRadius * 0.62, sz: crownRadius * 0.7,
          yaw: yaw + 0.8,
        });
        appendSource(canopy, crownSource, {
          x: x - Math.cos(yaw) * crownRadius * 0.4,
          y: y + height - crownRadius * 0.08,
          z: z + Math.sin(yaw) * crownRadius * 0.4,
          sx: crownRadius * 0.66, sy: crownRadius * 0.58, sz: crownRadius * 0.72,
          yaw: yaw - 0.7,
        });
        batch.trees++;
        treeCount++;
      }
    }
  }

  for (const [index, batch] of groups) {
    if (batch.trees === 0) continue;
    const x = 0;
    const y = 0;
    const z = 0;
    const trunk = Geometry.create(engine.gpu, sourceFromAccumulator(batch.trunks, `amazon.forest.${index}.trunks`));
    const foliage = Geometry.create(engine.gpu, sourceFromAccumulator(batch.foliage, `amazon.forest.${index}.canopy`));
    owned.push(trunk, foliage);
    const trunkEntity = meshRenderable(scene, `floodplain trees ${index} trunks`, new Vec3(x, y, z), trunk, materials.trunk, { castShadow: true, receiveShadow: false });
    trunkEntity.get(Renderable)!.maxDistance = 1250;
    const foliageEntity = meshRenderable(scene, `floodplain trees ${index} canopy`, new Vec3(x, y, z), foliage, materials.leaf, { castShadow: true, receiveShadow: false });
    foliageEntity.get(Renderable)!.maxDistance = 1250;
    if (batch.brightFoliage.positions.length > 0) {
      const bright = Geometry.create(engine.gpu, sourceFromAccumulator(batch.brightFoliage, `amazon.forest.${index}.sunlit-canopy`));
      owned.push(bright);
      const brightEntity = meshRenderable(scene, `floodplain trees ${index} sunlit canopy`, new Vec3(x, y, z), bright, materials.brightLeaf, { castShadow: true, receiveShadow: false });
      brightEntity.get(Renderable)!.maxDistance = 1250;
    }
  }
  return treeCount;
}

function positionOnBank(pose: RiverPose, lateral: number, along = 0): { x: number; z: number } {
  return {
    x: pose.x + pose.leftX * lateral + pose.forwardX * along,
    z: pose.z + pose.leftZ * lateral + pose.forwardZ * along,
  };
}

function gearLetter(gear: number): "F" | "N" | "R" {
  return gear > 0 ? "F" : gear < 0 ? "R" : "N";
}

function makeWaterMaterial(): Material {
  return new Material({ label: "Amazon silty green water", technique: "water", transparent: true, doubleSided: true });
}

class AmazonBoatRuntime extends SceneObject {
  readonly name = "amazonRiverBoatRuntime";
  private readonly waterSample: WaterSample = createWaterSample();

  constructor(
    private readonly worldScene: Scene,
    private readonly config: ReturnType<typeof createBoatConfig>,
    private readonly state: BoatState,
    private readonly input: BoatInput,
    private readonly environment: BoatEnvironment,
    private readonly boatTransform: Transform,
    private readonly wakeTransform: Transform,
    private readonly wakeRenderable: Renderable,
    private readonly markers: readonly FloatingMarker[],
  ) {
    super();
  }

  override update(_context: SystemContext, dt: number): void {
    // WaterSurface updates first in the scene-object list. Sampling its clock keeps CPU buoyancy and
    // the water vertex shader on the same phase even when the engine drops fixed steps under load.
    this.environment.time = this.worldScene.settings.water.time;
    stepBoat(this.state, this.config, this.input, this.environment, dt);
    applyBoatPose(this.boatTransform, this.state);

    for (const marker of this.markers) {
      const y = waterSurfaceHeight(this.environment, marker.x, marker.z, this.waterSample);
      marker.entity.setPosition(marker.x, y + 0.44, marker.z);
    }

    this.wakeRenderable.visible = this.state.wake > 0.18;
    this.wakeTransform.setScale(0.35 + this.state.wake * 1.05, 1, 0.35 + this.state.wake * 1.25);
  }
}

export function buildAmazonRiverScene(engine: Engine): AmazonRiverSceneHandle {
  const scene = new Scene({ name: "Amazon River: Upriver Run" });
  scene.settings.hdr = true;
  scene.settings.exposure = 1.05;
  scene.settings.toneMapping = "aces";
  scene.settings.bloom.enabled = true;
  scene.settings.bloom.threshold = 1.15;
  scene.settings.bloom.intensity = 0.035;
  scene.settings.shadow.enabled = true;
  scene.settings.shadow.cascades = 3;
  scene.settings.shadow.mapSize = 2048;
  scene.settings.shadow.distance = 280;
  scene.settings.ssao.enabled = true;
  scene.setFog("exp2", { density: 0.00058, color: Color.fromSrgbHex(0x83958a) });
  scene.setSky({ quality: "low", sunDiscIntensity: 100, seaLevel: AMAZON_WATER_LEVEL });
  scene.setClouds({ coverage: 0.42, density: 0.76, height: 1750, scale: 0.00072, windX: 2.4, windZ: 0.6, silverLining: 0.45 });

  const river = createAmazonRiver();
  const boatConfig = createBoatConfig();
  const boatState = createBoatState();
  const boatInput = createBoatInput();
  const waves = riverChop(0.42, 0.38, 1);
  const environment: BoatEnvironment = {
    level: AMAZON_WATER_LEVEL,
    waves,
    time: 0,
    bedElevation: river.elevationAt,
    currentAt: river.currentAt,
  };

  const ownedGeometries: Geometry[] = [];
  const ownedMaterials: Material[] = [];
  const ownedTextures: Texture[] = [];
  const ownGeometry = <T extends Geometry>(geometry: T): T => {
    ownedGeometries.push(geometry);
    return geometry;
  };
  const ownMaterial = <T extends Material>(material: T): T => {
    ownedMaterials.push(material);
    return material;
  };

  const floodplainTexture = createFloodplainTexture(engine);
  ownedTextures.push(floodplainTexture);
  const groundMaterial = ownMaterial(new Material({
    label: "Amazon floodplain · silty levees and deep jungle floor",
    color: Color.fromSrgbHex(0xffffff),
    roughness: 0.96,
    metallic: 0,
    albedoMap: floodplainTexture,
    tiling: [5.5, 0.94],
    doubleSided: true,
  }));
  const mainRibbon = buildRiverRibbon(river, "main", {
    stationStep: 12,
    span: RIBBON_SPAN,
    uvAlongMeters: 260,
    uvHeightRange: 6.5,
  });
  const terrainGeometry = ownGeometry(appendRibbonGeometry(engine, mainRibbon, "amazon.floodplain.terrain"));
  const terrainEntity = meshRenderable(scene, "Shared Amazon floodplain height field", new Vec3(), terrainGeometry, groundMaterial, { castShadow: false, receiveShadow: true });
  terrainEntity.get(Renderable)!.maxDistance = 2600;

  const trunkMaterial = ownMaterial(new Material({ label: "rainforest trunks", color: Color.fromSrgbHex(0x503b28), roughness: 0.92 }));
  const leafMaterial = ownMaterial(new Material({ label: "rainforest canopy", color: Color.fromSrgbHex(0x244b34), roughness: 0.9, doubleSided: true }));
  const brightLeafMaterial = ownMaterial(new Material({ label: "rainforest sunlit canopy", color: Color.fromSrgbHex(0x477447), roughness: 0.88, doubleSided: true }));
  const treeCount = buildForest(engine, scene, river, ownedGeometries, {
    trunk: trunkMaterial,
    leaf: leafMaterial,
    brightLeaf: brightLeafMaterial,
  });

  const sunEntity = scene.createTransformedEntity("equatorial sun", new Vec3(65, 120, -35));
  const sun = new Light();
  sun.kind = "directional";
  sun.intensity = 4.25;
  sun.castShadow = true;
  sun.cascades = 3;
  sun.shadowNormalBias = 0.75;
  sun.setColor(1, 0.96, 0.84);
  scene.world.addComponent(sunEntity.id, sun);
  sunEntity.transform.lookAt(new Vec3(0, 0, 0));
  const dayNight = new DayNightCycle({
    name: "amazonDayNight",
    latitude: -3.1,
    longitude: -60,
    timeZone: -4,
    dayOfYear: 67,
    timeOfDay: 10.2,
    timeScale: 120,
    sun,
    sunIntensity: 4.3,
    ambientScale: 0.76,
    driveAmbient: true,
    driveFog: true,
    driveSky: true,
  });
  scene.add(dayNight);

  const waterSurface = new WaterSurface({ name: "amazonWater", level: AMAZON_WATER_LEVEL, size: 7000 });
  scene.add(waterSurface);
  scene.setWater({
    level: AMAZON_WATER_LEVEL,
    size: 7000,
    deepColor: Color.fromSrgbHex(0x174746),
    shallowColor: Color.fromSrgbHex(0x698c6b),
    foamColor: Color.fromSrgbHex(0xd8e4c5),
    murkColor: Color.fromSrgbHex(0x183d36),
    murkDensity: 0.075,
    opacity: 0.94,
    sunGlint: 0.72,
    foamThreshold: 0.84,
    waves,
  });
  const waterMaterial = makeWaterMaterial();
  const mainWaterRibbon = buildRiverRibbon(river, "main", {
    stationStep: 8,
    span: 300,
    flat: true,
    uvAlongMeters: 220,
  });
  const primaryWaterGeometry = appendRibbonGeometry(engine, mainWaterRibbon, "amazon.water.main", true);
  waterSurface.renderable!.geometry = primaryWaterGeometry;
  waterSurface.renderable!.material = waterMaterial;

  // The main sheet already covers the tributary mouth. Starting this second ribbon before it leaves
  // that sheet keeps the igarapé visually connected; the centimetre lift avoids a coplanar seam.
  const tributaryWater = buildRiverRibbon(river, "tributary", {
    stationStep: 8,
    from: -125,
    span: 125,
    flat: true,
    yOffset: 0.012,
    uvAlongMeters: 150,
  });
  const tributaryWaterGeometry = ownGeometry(appendRibbonGeometry(engine, tributaryWater, "amazon.water.igarape", true));
  const tributaryWaterEntity = meshRenderable(scene, "Igarapé do Meio water", new Vec3(0, AMAZON_WATER_LEVEL, 0), tributaryWaterGeometry, waterMaterial, { castShadow: false, receiveShadow: false, transparent: true });
  tributaryWaterEntity.get(Renderable)!.doubleSided = true;

  const oxbowGeometry = ownGeometry(Geometry.create(engine.gpu, lakeSurfaceSource()));
  for (const lake of river.oxbows) {
    const lakeEntity = meshRenderable(scene, lake.name, new Vec3(lake.x, AMAZON_WATER_LEVEL + 0.006, lake.z), oxbowGeometry, waterMaterial, { castShadow: false, receiveShadow: false, transparent: true });
    lakeEntity.get(Renderable)!.doubleSided = true;
    lakeEntity.require(Transform).setRotationEuler(0, lake.rotation, 0);
    lakeEntity.require(Transform).setScale(lake.radiusX, 1, lake.radiusZ);
  }
  const whiteHull = ownMaterial(new Material({ label: "launch hull · river green enamel", color: Color.fromSrgbHex(0x284b48), metallic: 0.14, roughness: 0.36 }));
  const deckMaterial = ownMaterial(new Material({ label: "launch deck · pale timber", color: Color.fromSrgbHex(0xc6a875), roughness: 0.73 }));
  const cabinMaterial = ownMaterial(new Material({ label: "launch cabin · ivory paint", color: Color.fromSrgbHex(0xd9d0b5), roughness: 0.5 }));
  const glassMaterial = ownMaterial(new Material({ label: "launch windscreen", color: Color.fromSrgbHex(0x31595c), metallic: 0.22, roughness: 0.24, opacity: 0.82, transparent: true, doubleSided: true }));
  const engineMaterial = ownMaterial(new Material({ label: "outboard housings", color: Color.fromSrgbHex(0x292f2f), metallic: 0.55, roughness: 0.4 }));
  const hullGeometry = ownGeometry(Geometry.create(engine.gpu, launchHullSource()));
  const boatPose = river.main.poseAt(CAMERA_START_STATION);
  const spawn = river.thalwegAt(CAMERA_START_STATION, new Vec3());
  resetBoat(boatState, boatConfig, environment, spawn.x, spawn.z, boatPose.heading);
  boatInput.gear = 0;
  boatInput.trim = -1;
  const boatEntity = scene.createTransformedEntity("Ponta Aripuanã river launch", new Vec3(boatState.x, boatState.y, boatState.z));
  const boatTransform = boatEntity.require(Transform);
  const hullRenderable = new Renderable();
  hullRenderable.geometry = hullGeometry;
  hullRenderable.material = whiteHull;
  hullRenderable.castShadow = true;
  hullRenderable.receiveShadow = true;
  boatEntity.add(hullRenderable);
  applyBoatPose(boatTransform, boatState);

  const cabinGeometry = ownGeometry(createBox(engine.gpu, { width: 1.82, height: 0.82, depth: 1.95 }));
  const windscreenGeometry = ownGeometry(createBox(engine.gpu, { width: 1.62, height: 0.54, depth: 0.09 }));
  const seatGeometry = ownGeometry(createBox(engine.gpu, { width: 1.75, height: 0.18, depth: 0.44 }));
  const engineGeometry = ownGeometry(createCylinder(engine.gpu, { radiusTop: 0.19, radiusBottom: 0.28, height: 0.92, radialSegments: 10 }));
  const cabin = childRenderable(scene, boatEntity, "launch cabin", new Vec3(0, 1.34, 0.72), cabinGeometry, cabinMaterial);
  cabin.require(Transform).setScale(1, 0.82, 1);
  const windscreen = childRenderable(scene, boatEntity, "launch windscreen", new Vec3(0, 1.92, 1.42), windscreenGeometry, glassMaterial, { castShadow: false, receiveShadow: false, transparent: true });
  windscreen.require(Transform).setRotationEuler(-0.13, 0, 0);
  const aftSeat = childRenderable(scene, boatEntity, "aft bench", new Vec3(0, 0.95, -1.0), seatGeometry, deckMaterial);
  aftSeat.require(Transform).setScale(1, 1, 1);
  childRenderable(scene, boatEntity, "forward bench", new Vec3(0, 0.93, 2.38), seatGeometry, deckMaterial);
  childRenderable(scene, boatEntity, "port outboard", new Vec3(0.38, -0.12, -4.45), engineGeometry, engineMaterial);
  childRenderable(scene, boatEntity, "starboard outboard", new Vec3(-0.38, -0.12, -4.45), engineGeometry, engineMaterial);

  const wakeGeometry = ownGeometry(Geometry.create(engine.gpu, launchWakeSource()));
  const wakeMaterial = ownMaterial(new Material({ label: "launch wake foam", color: Color.fromSrgbHex(0xa8c5bc), roughness: 0.65, opacity: 0.35, transparent: true, doubleSided: true }));
  const wakeEntity = childRenderable(scene, boatEntity, "launch wake", new Vec3(0, boatConfig.draft + 0.012, -4.7), wakeGeometry, wakeMaterial, { castShadow: false, receiveShadow: false, transparent: true });
  const wakeTransform = wakeEntity.require(Transform);
  const wakeRenderable = wakeEntity.require(Renderable);
  wakeRenderable.visible = false;

  const buoyBodyGeometry = ownGeometry(createCylinder(engine.gpu, { radiusTop: 0.22, radiusBottom: 0.32, height: 0.78, radialSegments: 12, heightSegments: 2 }));
  const buoyCapGeometry = ownGeometry(Geometry.create(engine.gpu, coneGeometrySource({ radius: 0.34, height: 0.48, radialSegments: 8 })));
  const buoyBodyMaterial = ownMaterial(new Material({ label: "channel buoy · ivory", color: Color.fromSrgbHex(0xe6ddc5), roughness: 0.5 }));
  const redBuoyMaterial = ownMaterial(new Material({ label: "channel buoy · port red", color: Color.fromSrgbHex(0xd44f35), roughness: 0.47, emissive: Color.fromSrgbHex(0x260800), emissiveStrength: 0.12 }));
  const greenBuoyMaterial = ownMaterial(new Material({ label: "channel buoy · starboard green", color: Color.fromSrgbHex(0x3d9a69), roughness: 0.47, emissive: Color.fromSrgbHex(0x051a0b), emissiveStrength: 0.12 }));
  const floatingMarkers: FloatingMarker[] = [];
  for (const mark of river.marks) {
    if (mark.kind !== "buoy-port" && mark.kind !== "buoy-starboard") continue;
    const pose = river.main.poseAt(mark.s);
    const x = pose.x + pose.leftX * mark.lateral;
    const z = pose.z + pose.leftZ * mark.lateral;
    const surfaceY = waterSurfaceHeight(environment, x, z);
    const buoy = meshRenderable(scene, mark.name, new Vec3(x, surfaceY + 0.39, z), buoyBodyGeometry, buoyBodyMaterial, { castShadow: true, receiveShadow: false });
    const cap = childRenderable(scene, buoy, `${mark.name} colour`, new Vec3(0, 0.55, 0), buoyCapGeometry, mark.kind === "buoy-port" ? redBuoyMaterial : greenBuoyMaterial, { castShadow: true, receiveShadow: false });
    cap.require(Transform).setScale(0.75, 0.86, 0.75);
    floatingMarkers.push({ entity: buoy, x, z });
  }

  const dockGeometry = ownGeometry(createBox(engine.gpu, { width: 13.5, height: 0.26, depth: 3.2 }));
  const hutBodyGeometry = ownGeometry(createBox(engine.gpu, { width: 2.55, height: 1.58, depth: 2.15 }));
  const roofGeometry = ownGeometry(Geometry.create(engine.gpu, thatchRoofSource()));
  const postGeometry = ownGeometry(createCylinder(engine.gpu, { radiusTop: 0.11, radiusBottom: 0.14, height: 2.1, radialSegments: 7 }));
  const flagGeometry = ownGeometry(createBox(engine.gpu, { width: 0.9, height: 0.52, depth: 0.07 }));
  const dockMaterial = ownMaterial(new Material({ label: "Amazon landing timber", color: Color.fromSrgbHex(0x76563b), roughness: 0.87 }));
  const hutMaterial = ownMaterial(new Material({ label: "Amazon river village walls", color: Color.fromSrgbHex(0xa8865b), roughness: 0.88 }));
  const roofMaterial = ownMaterial(new Material({ label: "palm thatch", color: Color.fromSrgbHex(0x9b6d3f), roughness: 0.94 }));
  const postMaterial = ownMaterial(new Material({ label: "dock piles", color: Color.fromSrgbHex(0x4b3929), roughness: 0.9 }));
  const flagMaterial = ownMaterial(new Material({ label: "journey flags", color: Color.fromSrgbHex(0xf0bd52), emissive: Color.fromSrgbHex(0x6e3610), emissiveStrength: 0.45, roughness: 0.46 }));
  const destinations = buildDestinations(scene, river, {
    dockGeometry,
    hutBodyGeometry,
    roofGeometry,
    postGeometry,
    flagGeometry,
    dockMaterial,
    hutMaterial,
    roofMaterial,
    postMaterial,
    flagMaterial,
  });

  addOxbowReeds(engine, scene, river, ownedGeometries, ownedMaterials);
  const cameraEntity = scene.createTransformedEntity("camera", new Vec3(boatState.x, boatState.y + 7, boatState.z - 32));
  const camera = new Camera();
  camera.fovY = Math.PI / 3.15;
  camera.near = 0.15;
  camera.far = 3200;
  scene.world.addComponent(cameraEntity.id, camera);
  cameraEntity.transform.lookAt(new Vec3(boatState.x, boatState.y + 1.35, boatState.z));

  const runtime = new AmazonBoatRuntime(
    scene,
    boatConfig,
    boatState,
    boatInput,
    environment,
    boatTransform,
    wakeTransform,
    wakeRenderable,
    floatingMarkers,
  );
  scene.add(runtime);

  let selectedGear = 0;
  let trimTarget = -1;
  let scriptedInput: Partial<BoatInput> | null = null;
  const keys = new Set<string>();
  let touch = attachVehicleTouch(document.getElementById("vehicle-touch"), {
    onGearSelect: (position) => selectGear(position),
  });
  touch.setGear("N");

  const selectGear = (position: VehicleGearPosition): boolean => {
    const next = position === "F" ? 1 : position === "R" ? -1 : 0;
    if (next !== 0 && next !== selectedGear && boatState.speedGround > BOAT_START_SPEED_SHIFT_LIMIT) return false;
    selectedGear = next;
    boatInput.gear = selectedGear;
    touch.setGear(position);
    return true;
  };
  const setTrim = (trim: number): void => {
    trimTarget = clamp(trim, -1, 1);
    boatInput.trim = trimTarget;
  };
  const trimDownButton = document.getElementById("amazon-trim-down");
  const trimUpButton = document.getElementById("amazon-trim-up");
  const onTrimDown = (): void => setTrim(trimTarget - 0.25);
  const onTrimUp = (): void => setTrim(trimTarget + 0.25);
  trimDownButton?.addEventListener("click", onTrimDown);
  trimUpButton?.addEventListener("click", onTrimUp);

  const onKeyDown = (event: KeyboardEvent): void => {
    keys.add(event.code);
    if (event.repeat) return;
    if (event.code === "KeyF") selectGear("F");
    else if (event.code === "KeyN" || event.code === "Space") selectGear("N");
    else if (event.code === "KeyR") selectGear("R");
    if (event.code.startsWith("Arrow") || event.code === "Space") event.preventDefault();
  };
  const onKeyUp = (event: KeyboardEvent): void => {
    keys.delete(event.code);
  };
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);

  const cameraTarget = new Vec3(boatState.x, boatState.y + 1.35, boatState.z);
  const current = { x: 0, z: 0 };
  const pilotUpdate = (dt: number): void => {
    if (scriptedInput) {
      boatInput.throttle = clamp(scriptedInput.throttle ?? 0, 0, 1);
      boatInput.steer = clamp(scriptedInput.steer ?? 0, -1, 1);
      boatInput.gear = clamp(scriptedInput.gear ?? selectedGear, -1, 1);
      boatInput.trim = clamp(scriptedInput.trim ?? trimTarget, -1, 1);
      return;
    }
    const pad = touch.sample();
    if (keys.has("KeyQ")) setTrim(trimTarget - 0.72 * dt);
    if (keys.has("KeyE")) setTrim(trimTarget + 0.72 * dt);
    const left = keys.has("KeyA") || keys.has("ArrowLeft") ? 1 : 0;
    const right = keys.has("KeyD") || keys.has("ArrowRight") ? 1 : 0;
    const throttleKey = keys.has("KeyW") || keys.has("ArrowUp") ? 1 : 0;
    const neutralKey = keys.has("KeyS") || keys.has("ArrowDown") || pad.brake > 0.25;
    boatInput.throttle = Math.max(throttleKey, pad.throttle);
    boatInput.steer = clamp(left - right - pad.steer, -1, 1);
    boatInput.gear = neutralKey ? 0 : selectedGear;
    boatInput.trim = trimTarget;
    touch.setGear(gearLetter(selectedGear));
  };

  const snapshot = (): AmazonRiverSnapshot => {
    const probe = river.main.probe(boatState.x, boatState.z);
    const destination = destinations.find((item) => item.mark.s > probe.s + 24);
    river.currentAt(boatState.x, boatState.z, current);
    const depth = Math.max(0, river.depthAt(boatState.x, boatState.z));
    return {
      scene: "amazon-river",
      boatTime: boatState.time,
      positionX: boatState.x,
      positionY: boatState.y,
      positionZ: boatState.z,
      heading: boatState.heading,
      speedWater: boatState.speedWater,
      speedGround: boatState.speedGround,
      speedKph: boatState.speedGround * 3.6,
      rpm: boatState.rpm,
      gear: gearLetter(boatInput.gear),
      throttle: boatInput.throttle,
      helm: boatState.helm,
      trim: boatState.legTrim,
      draft: boatState.draft,
      depth,
      freeboard: boatState.freeboard,
      grounded: boatState.grounded,
      progress: clamp(probe.s / river.length, 0, 1),
      station: probe.s,
      destination: destination?.mark.name ?? null,
      destinationDistance: destination ? Math.max(0, destination.mark.s - probe.s) : null,
      destinations: destinations.length,
      channelBuoys: floatingMarkers.length,
      trees: treeCount,
      oxbows: river.oxbows.length,
      riverLength: RIVER_JOURNEY_METRES,
    };
  };

  return {
    scene,
    cameraEntity,
    controlsHint: "W / ↑ throttle · A / D steer · F / N / R gear · Q / E leg trim · drag to orbit · scroll to zoom",
    camera: {
      target: cameraTarget,
      distance: 110,
      minDistance: 22,
      maxDistance: 260,
      azimuth: 0.22,
      elevation: 0.48,
      minElevation: 0.04,
      maxElevation: 1.22,
      groundHeight: river.elevationAt,
      groundClearance: 3.8,
      keyboard: false,
    },
    followTarget: () => ({ x: boatState.x, y: boatState.y + 1.35, z: boatState.z }),
    update(dt: number): void {
      pilotUpdate(dt);
    },
    overlay(): string {
      const view = snapshot();
      const next = view.destination ? `${view.destination.toUpperCase()} · ${(view.destinationDistance! / 1000).toFixed(2)} km` : "OPEN RIVER AHEAD";
      const ahead = boatInput.gear > 0 ? "AHEAD" : boatInput.gear < 0 ? "ASTERN" : "NEUTRAL";
      const depthStatus = view.grounded ? "BAR CONTACT · BACK OFF" : view.depth < view.draft + 0.18 ? "SHALLOW WATER" : "THALWEG CLEAR";
      const trimPercent = Math.round(boatState.legTrim * 100);
      const progress = Math.round(view.progress * 100);
      return (
        `AMAZON RIVER  ·  UPRIVER RUN  ·  ${progress}%\n` +
        `${ahead}  ${view.speedKph.toFixed(1)} km/h  ·  ${view.speedWater.toFixed(1)} m/s through water  ·  ${view.rpm.toFixed(0)} rpm\n` +
        `NEXT  ${next}\n` +
        `${depthStatus}  ·  depth ${view.depth.toFixed(1)} m  ·  draft ${view.draft.toFixed(2)} m  ·  leg trim ${trimPercent}%\n` +
        `FLOW  ${Math.hypot(current.x, current.z).toFixed(1)} m/s  ·  ${view.channelBuoys} channel marks  ·  ${view.trees} jungle trees`
      );
    },
    snapshot,
    setGear: selectGear,
    setTrim,
    setInput(next: Partial<BoatInput> | null): void {
      scriptedInput = next ? { ...next } : null;
    },
    dispose(): void {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      trimDownButton?.removeEventListener("click", onTrimDown);
      trimUpButton?.removeEventListener("click", onTrimUp);
      touch.dispose();
      keys.clear();
      scriptedInput = null;
      // WaterSurface owns and releases its primary river sheet/material during scene.dispose().
      for (const geometry of ownedGeometries) geometry.dispose();
      for (const material of ownedMaterials) material.dispose();
      for (const texture of ownedTextures) texture.dispose();
      scene.dispose();
    },
  };
}

function buildDestinations(
  scene: Scene,
  river: AmazonRiver,
  assets: {
    dockGeometry: Geometry;
    hutBodyGeometry: Geometry;
    roofGeometry: Geometry;
    postGeometry: Geometry;
    flagGeometry: Geometry;
    dockMaterial: Material;
    hutMaterial: Material;
    roofMaterial: Material;
    postMaterial: Material;
    flagMaterial: Material;
  },
): RiverDestination[] {
  const marks = river.marks
    .filter((mark) => mark.kind !== "buoy-port" && mark.kind !== "buoy-starboard")
    .slice()
    .sort((a, b) => a.s - b.s);
  const destinations: RiverDestination[] = [];
  const pose = createRiverPose();
  for (let index = 0; index < marks.length; index++) {
    const mark = marks[index]!;
    river.main.poseAt(mark.s, pose);
    const preferredSide = mark.lateral === 0 ? (index % 2 === 0 ? 1 : -1) : Math.sign(mark.lateral);
    let siteSide = preferredSide;
    let site = findBankSite(river, mark.s, siteSide, 0.48, 0.24);
    if (!site) {
      siteSide = -preferredSide;
      site = findBankSite(river, mark.s, siteSide, 0.48, 0.24);
    }
    // A cut bank or oxbow shore can have no safe building pad. Skipping that prop is correct; forcing
    // one into a cliff was the old placeholder's only way of making a five-stop journey look complete.
    if (!site) continue;
    destinations.push({ mark, site });

    const side = siteSide;
    const dockLateral = side * (pose.halfWidth + 4.8);
    const dockAt = positionOnBank(pose, dockLateral);
    const dock = meshRenderable(scene, `${mark.name} landing`, new Vec3(dockAt.x, AMAZON_WATER_LEVEL + 0.18, dockAt.z), assets.dockGeometry, assets.dockMaterial);
    dock.require(Transform).setRotationEuler(0, site.heading, 0);
    for (const x of [-5.7, 5.7]) {
      for (const z of [-1.18, 1.18]) {
        childRenderable(scene, dock, `${mark.name} dock pile`, new Vec3(x, -0.78, z), assets.postGeometry, assets.postMaterial, { castShadow: true, receiveShadow: false });
      }
    }

    const hutCount = mark.kind === "village" ? 3 : 1;
    for (let hutIndex = 0; hutIndex < hutCount; hutIndex++) {
      const along = (hutIndex - (hutCount - 1) * 0.5) * 8.5 + (mark.kind === "village" ? 4 : 10);
      const bankward = side * (mark.kind === "village" ? 5.5 : 7.5);
      const point = positionOnBank(pose, side * site.distance + bankward, along);
      const ground = river.elevationAt(point.x, point.z);
      const hut = scene.createTransformedEntity(`${mark.name} hut ${hutIndex + 1}`, new Vec3(point.x, ground + 0.02, point.z));
      const transform = hut.require(Transform);
      transform.setRotationEuler(0, site.heading + (hutIndex - 1) * 0.16, 0);
      childRenderable(scene, hut, "timber dwelling", new Vec3(0, 0.82, 0), assets.hutBodyGeometry, assets.hutMaterial);
      const roof = childRenderable(scene, hut, "palm thatch roof", new Vec3(0, 1.9, 0), assets.roofGeometry, assets.roofMaterial);
      roof.require(Transform).setScale(1.75, 1.35, 1.62);
    }

    const flagPole = meshRenderable(scene, `${mark.name} river signpost`, new Vec3(site.x, site.y + 1.7, site.z), assets.postGeometry, assets.postMaterial, { castShadow: true, receiveShadow: false });
    flagPole.require(Transform).setScale(0.55, 1.75, 0.55);
    childRenderable(scene, flagPole, "gold journey pennant", new Vec3(0.45, 0.55, 0), assets.flagGeometry, assets.flagMaterial, { castShadow: false, receiveShadow: false });
  }
  return destinations;
}

function addOxbowReeds(engine: Engine, scene: Scene, river: AmazonRiver, ownedGeometries: Geometry[], ownedMaterials: Material[]): number {
  const reedSource = coneGeometrySource({ radius: 0.08, height: 1, radialSegments: 5 });
  const reedMesh = createAccumulator();
  let count = 0;
  for (let lakeIndex = 0; lakeIndex < river.oxbows.length; lakeIndex++) {
    const lake = river.oxbows[lakeIndex]!;
    for (let i = 0; i < 30; i++) {
      const angle = (i / 30) * Math.PI * 2 + riverJitter(lakeIndex, i, 0x0b0a) * 0.3;
      const radius = 1.04 + riverJitter(i, lakeIndex, 0xa871) * 0.24;
      const lx = Math.cos(angle) * lake.radiusX * radius;
      const lz = Math.sin(angle) * lake.radiusZ * radius;
      const c = Math.cos(lake.rotation);
      const s = Math.sin(lake.rotation);
      const x = lake.x + lx * c - lz * s;
      const z = lake.z + lx * s + lz * c;
      const y = river.elevationAt(x, z);
      if (y < AMAZON_WATER_LEVEL + 0.16) continue;
      const height = 1.6 + riverJitter(i, lakeIndex, 0x6e3) * 1.2;
      appendSource(reedMesh, reedSource, {
        x, y: y + height * 0.5, z,
        sx: 0.75 + riverJitter(lakeIndex, i, 0x554) * 0.55,
        sy: height,
        sz: 0.75 + riverJitter(i, lakeIndex, 0x233) * 0.55,
        yaw: angle,
      });
      count++;
    }
  }
  if (count > 0) {
    const geometry = Geometry.create(engine.gpu, sourceFromAccumulator(reedMesh, "amazon.oxbow.reeds"));
    const material = new Material({ label: "oxbow reeds", color: Color.fromSrgbHex(0x6c7d42), roughness: 0.95, doubleSided: true });
    ownedGeometries.push(geometry);
    ownedMaterials.push(material);
    meshRenderable(scene, "Oxbow reeds", new Vec3(), geometry, material, { castShadow: true, receiveShadow: false });
  }
  return river.oxbows.length;
}
