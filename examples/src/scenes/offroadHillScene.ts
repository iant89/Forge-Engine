/**
 * fe-37 Off-road hillside course (`?scene=offroad`): a narrow gravel-and-dirt track winding up and
 * back down a forested autumn hillside, with grassy berms on both sides, modelled on Ian's two
 * reference photos.
 *
 * Engine systems used (reusable, documented in docs/TERRAIN-TRACKS.md):
 * - `TrackSpline` + `TrackTerrain`: the loop is carved into the hillside height function with a
 *   crowned bed, tyre ruts, shoulders and berms. The same `heightAt` feeds the vehicle ground query
 *   and the meshes, so the berms are real terrain the wheels climb and the chassis rolls off.
 * - `trackRibbonSource` / `trackTerrainGridSource` for the road, berm and ground meshes;
 *   `createGravelRoadTextures` / `createGrassBermTextures` for the surfaces;
 *   `scatterAlongTrack` + `litterQuadsSource` for leaf litter and the forest placements.
 * - The engine `Vehicle` / `VehicleSystem` (raycast car), stepped once by the system.
 *
 * Scene-specific (this file): the hillside shape, the loop's control points, the tree and vehicle
 * props, the start/finish gate and lap timer, and the chase / in-cab / orbit camera.
 */

import {
  Camera,
  Color,
  DayNightCycle,
  Geometry,
  Light,
  Material,
  Quat,
  Renderable,
  Scene,
  TrackSpline,
  TrackLapTimer,
  TrackTerrain,
  Vec3,
  Vehicle,
  VehicleComponent,
  VehicleSystem,
  createBox,
  createCylinder,
  createGrassBermTextures,
  createGravelRoadTextures,
  createVehicleConfig,
  cylinderGeometrySource,
  disposeTrackSurface,
  fbm2,
  heightFunctionGround,
  litterQuadsSource,
  scatterAlongTrack,
  tierValue,
  trackRibbonSource,
  trackTerrainGridSource,
  type DeviceTier,
  type Engine,
  type Entity,
  type GeometrySource,
  type TrackPlacement,
  type TrackProjection,
  MoistureOverlayMaps,
  PrecipitationField,
  TRACK_GROUND_CONDITIONS,
  Texture,
  TrackWeatherGround,
  TireTrackLayer,
  VegetationField,
  WeatherSystem,
  barkPixels,
  createMeltEnvironment,
  generateTree,
  generateBush,
  grassBladePixels,
  grassPatchSource,
  leafCardPixels,
  sampleMeltEnvironment,
  setWorldSurfaceGripField,
  triangleCount,
  weatherPrecipitationDrive,
  withFieldUvs,
  type LeafShape,
  type TreeSpecies,
  type VegetationModel,
  type WeatherState,
} from "@forge/engine";
import { suppressTouchChrome } from "../controls/vehicleTouch.js";
import { attachPedal, attachSteeringWheel } from "../controls/touchWheel.js";
import type { DemoSceneHandle } from "./cubesScene.js";
import { attachVehicleTouch } from "../controls/vehicleTouch.js";

/** Loop control points: up the west side, switchback at the top, down the east side. */
const COURSE: ReadonlyArray<{ x: number; z: number }> = [
  { x: -12, z: -150 }, { x: -34, z: -118 }, { x: -44, z: -80 }, { x: -28, z: -42 }, { x: -44, z: -2 },
  { x: -30, z: 38 }, { x: -50, z: 78 }, { x: -36, z: 118 }, { x: -46, z: 158 }, { x: -28, z: 198 },
  { x: 0, z: 228 }, { x: 34, z: 226 }, { x: 56, z: 196 }, { x: 42, z: 156 }, { x: 62, z: 116 },
  { x: 46, z: 76 }, { x: 66, z: 36 }, { x: 50, z: -4 }, { x: 64, z: -44 }, { x: 46, z: -84 },
  { x: 40, z: -124 }, { x: 18, z: -156 },
];

const ROAD_HALF_WIDTH = 2.2;
const SHOULDER = 0.45;
const BERM_WIDTH = 2.6;
const BERM_HEIGHT = 0.8;
const UV_ALONG = 8;
/** Arc length of the start/finish line; the car spawns a little before it. */
const START_S = 18;
const SPAWN_BACK = 10;

export type OffroadCameraMode = "chase" | "cab" | "orbit" | "free";

export interface OffroadSceneOptions {
  deviceTier?: DeviceTier;
  /** Starting weather (the menu and keys 1–5 change it live). */
  weather?: OffroadWeather;
}

export interface OffroadSnapshot {
  lap: number;
  lapTime: number;
  lastLap: number | null;
  bestLap: number | null;
  running: boolean;
  progress: number;
  trackLength: number;
  lateral: number;
  speedKph: number;
  cameraMode: OffroadCameraMode;
  x: number;
  y: number;
  z: number;
  trees: number;
  leaves: number;
  grass: number;
  trackTiles: number;
  surface: { wetness: number; puddles: number; snow: number };
  weather: OffroadWeather;
  /** Grip multiplier under the car. */
  grip: number;
  overlayCoverage: number;
  vegetation: { hidden: number; hi: number; lo: number; swaying: number };
  treeTriangles: { hi: number; lo: number };
}

export interface OffroadSceneHandle extends DemoSceneHandle {
  setCameraMode(mode: OffroadCameraMode): void;
  /** Gate hook: put the car at arc length `s` (+ lateral offset) facing along the track, at rest. */
  placeAt(s: number, lateral?: number, yawOffset?: number): void;
  snapshot(): OffroadSnapshot;
  setWeather(name: OffroadWeather): void;
  /** Gate/screenshot hook: fixed camera at `eye` looking at `target` (mode "free"). */
  lookAt(eye: [number, number, number], target: [number, number, number]): void;
  /** World point (x, ground y, z) at arc length `s`, lateral offset. */
  trackPoint(s: number, lateral: number): [number, number, number];
  /** Gate hook: grip at a lateral offset from the centreline at arc length `s`. */
  gripAt(s: number, lateral: number): number;
}

/** The demo's weather menu: an engine weather state plus the track ground condition that goes with it. */
export const OFFROAD_WEATHER = {
  clear: { label: "Clear sun", ground: "dry", state: { cloudCoverage: 0.12, storm01: 0, precipitation01: 0, temperatureC: 16, humidity01: 0.45, windSpeed: 3, windDirection: Math.PI / 4, gust: 0.25 } },
  overcast: { label: "Overcast", ground: "damp", state: { cloudCoverage: 0.85, storm01: 0.05, precipitation01: 0, temperatureC: 11, humidity01: 0.8, windSpeed: 6, windDirection: Math.PI / 3, gust: 0.4 } },
  rain: { label: "Rain", ground: "wet", state: { cloudCoverage: 0.97, storm01: 0.25, precipitation01: 0.75, temperatureC: 10, humidity01: 0.97, windSpeed: 8, windDirection: Math.PI / 2, gust: 0.6 } },
  snow: { label: "Snow", ground: "snow", state: { cloudCoverage: 0.95, storm01: 0.1, precipitation01: 0.55, temperatureC: -4, humidity01: 0.9, windSpeed: 4, windDirection: Math.PI / 3, gust: 0.35 } },
  mud: { label: "After the storm", ground: "muddy", state: { cloudCoverage: 0.55, storm01: 0, precipitation01: 0, temperatureC: 12, humidity01: 0.88, windSpeed: 5, windDirection: Math.PI / 2, gust: 0.4 } },
} as const satisfies Record<string, { label: string; ground: keyof typeof TRACK_GROUND_CONDITIONS; state: Partial<WeatherState> }>;
export type OffroadWeather = keyof typeof OFFROAD_WEATHER;
export const OFFROAD_WEATHER_NAMES = Object.keys(OFFROAD_WEATHER) as OffroadWeather[];

/** The hillside before the track is cut: climbs to the north and falls away to the east, with knolls. */
function hillside(x: number, z: number): number {
  const climb = 0.085 * z + 0.04 * x;
  const knolls = 7 * fbm2(x / 70, z / 70, 3707, { octaves: 3 });
  const ridges = 2.2 * Math.sin(z / 23 + Math.sin(x / 41) * 1.3);
  return climb + knolls + ridges;
}

function fmtTime(t: number | null): string {
  if (t === null) return "--:--.--";
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s.toFixed(2).padStart(5, "0")}`;
}

export function buildOffroadHillScene(engine: Engine, options: OffroadSceneOptions = {}): OffroadSceneHandle {
  const tier: DeviceTier = options.deviceTier ?? "high";
  const scene = new Scene({ name: "offroad-hill" });
  scene.settings.hdr = true;
  scene.settings.exposure = 1.0;
  scene.settings.bloom.enabled = tier !== "low";
  scene.settings.shadow.enabled = true;
  scene.settings.shadow.distance = tierValue(tier, { low: 60, medium: 90, high: 120 });
  scene.settings.shadow.cascades = tierValue(tier, { low: 2, medium: 3, high: 4 });
  scene.settings.shadow.mapSize = tierValue(tier, { low: 1024, medium: 2048, high: 2048 });
  scene.setSky({ quality: tier === "low" ? "low" : "medium" });

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
  const add = (name: string, geometry: Geometry, material: Material, castShadow = false, receiveShadow = true): Entity => {
    const e = scene.createTransformedEntity(name, new Vec3());
    const r = new Renderable();
    r.geometry = geometry;
    r.material = material;
    r.castShadow = castShadow;
    r.receiveShadow = receiveShadow;
    scene.world.addComponent(e.id, r);
    return e;
  };

  // ------------------------------------------------------------------ track + terrain
  const spline = new TrackSpline(COURSE, { closed: true, step: 0.5 });
  const track = new TrackTerrain(hillside, spline, {
    roadHalfWidth: ROAD_HALF_WIDTH,
    shoulder: SHOULDER,
    bermWidth: BERM_WIDTH,
    bermHeight: BERM_HEIGHT,
    blendWidth: 7,
    bedSmoothing: 34,
    rutDepth: 0.06,
    rutOffset: 0.8,
    rutWidth: 0.32,
    seed: 37,
  });
  const heightAt = (x: number, z: number): number => track.heightAt(x, z);
  const ground = heightFunctionGround(heightAt, 0.2);

  const gridSeg = tierValue(tier, { low: 150, medium: 220, high: 300 });
  const floorTex = createGrassBermTextures(engine.gpu, { baseColor: 0x6b5232, mulch: 0, meters: 4, seed: 5, size: tierValue(tier, { low: 64, medium: 128, high: 128 }) });
  const forestFloor = mat(new Material({ label: "offroad.forest-floor", color: 0xb0a090, roughness: 0.97, metallic: 0 }));
  forestFloor.setMaps({ albedo: floorTex.albedo, normal: floorTex.normal, metallicRoughness: floorTex.metallicRoughness });
  add("ground", geo(trackTerrainGridSource(track, 10, 40, 480, gridSeg, { label: "offroad.ground", corridorSink: 0.6, sinkTo: track.bermOuterEdge + 2.2 })), forestFloor, false);
  // Horizon skirt: the same hillside, coarse, sunk so it never pokes through the near grid.
  const far = trackTerrainGridSource(track, 10, 40, 2400, 120, { label: "offroad.far" });
  for (let k = 1; k < far.positions.length; k += 3) far.positions[k] = far.positions[k]! - 2.5;
  add("ground-far", geo(far), mat(new Material({ label: "offroad.far-hills", color: 0x6b5a2e, roughness: 1, metallic: 0 })), false);

  const roadTex = createGravelRoadTextures(engine.gpu, {
    halfSpan: ROAD_HALF_WIDTH + SHOULDER,
    roadHalfWidth: ROAD_HALF_WIDTH,
    rutOffset: 0.8,
    rutWidth: 0.32,
    metersAlong: UV_ALONG,
    baseColor: 0xc2ad8c,
    width: tierValue(tier, { low: 128, medium: 256, high: 256 }),
    height: tierValue(tier, { low: 256, medium: 512, high: 512 }),
  });
  const bermTex = createGrassBermTextures(engine.gpu, { baseColor: 0x84c34a, mulch: 0.3, size: tierValue(tier, { low: 128, medium: 256, high: 256 }) });
  const roadMat = mat(new Material({ label: "offroad.gravel-road", color: 0xffffff, roughness: 1, metallic: 0 }));
  roadMat.setMaps({ albedo: roadTex.albedo, normal: roadTex.normal, metallicRoughness: roadTex.metallicRoughness });
  const bermMat = mat(new Material({ label: "offroad.hydroseed-berm", color: 0xffffff, roughness: 1, metallic: 0 }));
  bermMat.setMaps({ albedo: bermTex.albedo, normal: bermTex.normal, metallicRoughness: bermTex.metallicRoughness });

  const span = ROAD_HALF_WIDTH + SHOULDER;
  const along = tierValue(tier, { low: 1.5, medium: 1, high: 0.75 });
  add("road", geo(trackRibbonSource(track, { from: -span, to: span, across: tierValue(tier, { low: 13, medium: 19, high: 25 }), alongStep: along, lift: 0.025, uvMetersAlong: UV_ALONG, label: "offroad.road" })), roadMat, false);
  const bermOuter = track.bermOuterEdge + 2.2;
  const bermAcross = tierValue(tier, { low: 8, medium: 12, high: 16 });
  for (const side of [-1, 1] as const) {
    add(
      `berm-${side < 0 ? "left" : "right"}`,
      geo(trackRibbonSource(track, { from: side * (span - 0.05), to: side * bermOuter, across: bermAcross, alongStep: along, lift: 0.03, uvMetersAlong: 4, label: "offroad.berm" })),
      bermMat,
      false,
    );
  }

  // ------------------------------------------------------------------ leaf litter
  const leafScale = tierValue(tier, { low: 0.35, medium: 0.7, high: 1 });
  const litter = scatterAlongTrack(track, {
    seed: 91,
    lateralMin: 0,
    lateralMax: track.bermOuterEdge + 4,
    density: 2.2 * leafScale,
    // Wind and traffic sweep the crown; leaves pile at the edges and in the shoulder.
    weight: (d) => (d < ROAD_HALF_WIDTH ? 0.12 + 0.5 * (d / ROAD_HALF_WIDTH) ** 2 : d < span + 0.2 ? 1 : 0.35),
    scaleMin: 0.7,
    scaleMax: 1.5,
    palettes: 5,
  });
  const leafColors = [0xc6721c, 0xa5401a, 0xd8a12e, 0x7a4a22, 0x93311a];
  for (let p = 0; p < leafColors.length; p++) {
    const subset = litter.filter((l) => l.palette === p);
    if (subset.length === 0) continue;
    add(`leaves-${p}`, geo(litterQuadsSource(track, subset, { size: 0.11, label: `offroad.leaves-${p}` })), mat(new Material({ label: `offroad.leaf-${p}`, color: leafColors[p]!, roughness: 0.85, metallic: 0, doubleSided: true })), false);
  }

  // ------------------------------------------------------------------ forest (engine procedural trees)
  // Species and placement are the demo's; the generator, LOD, instancing and sway are the engine's.
  const density = tierValue(tier, { low: 0.4, medium: 0.7, high: 1 });
  const near = scatterAlongTrack(track, { seed: 7, lateralMin: track.bermOuterEdge + 3, lateralMax: 40, density: 0.03 * density, scaleMin: 0.8, scaleMax: 1.25, palettes: 4 });
  const back = scatterAlongTrack(track, { seed: 8, lateralMin: 40, lateralMax: 120, density: 0.006 * density, scaleMin: 1, scaleMax: 1.5, palettes: 4 });
  const brush = scatterAlongTrack(track, { seed: 9, lateralMin: track.bermOuterEdge + 0.8, lateralMax: track.bermOuterEdge + 6, density: 0.1 * density, scaleMin: 0.7, scaleMax: 1.8, palettes: 3 });
  // Ohio-valley autumn mix from the photos: sugar maple (orange/red), oaks (russet), birch and
  // tulip poplar (yellow/gold). Palette entries are per-instance tints over white leaf cards.
  const species: Array<{ spec: TreeSpecies; leaf: LeafShape; bark: "furrowed" | "birch"; barkColor: number; tints: number[] }> = [
    { spec: { name: "maple", height: [9, 15], shape: "round", children: [7, 4, 3], leafSize: 0.75, leavesPerBranch: 6, gravitropism: 0.12 }, leaf: "maple", bark: "furrowed", barkColor: 0x6a6058, tints: [0xe0641c, 0xc8341a, 0xe89a2a, 0xd65a20] },
    { spec: { name: "oak", height: [10, 16], shape: "round", children: [6, 4, 3], branchAngle: [1.15, 0.85, 0.7], lengthRatio: [0.5, 0.55, 0.5], leafSize: 0.7, leavesPerBranch: 6, gravitropism: 0.02, wander: 0.3 }, leaf: "oval", bark: "furrowed", barkColor: 0x564a40, tints: [0x9a5a24, 0x7f4a1e, 0xa8782c, 0x6f7a2a] },
    { spec: { name: "birch", height: [8, 13], shape: "columnar", trunkRadius: 0.016, children: [8, 3, 3], branchAngle: [0.8, 0.7, 0.6], lengthRatio: [0.32, 0.6, 0.5], leafSize: 0.55, leavesPerBranch: 6, gravitropism: -0.15, clearBole: 0.3 }, leaf: "birch", bark: "birch", barkColor: 0xe8e4dc, tints: [0xf0c63a, 0xe6b42c, 0xd8c84a, 0xf2d25a] },
    { spec: { name: "poplar", height: [14, 20], shape: "conical", trunkRadius: 0.018, clearBole: 0.45, children: [8, 3, 3], branchAngle: [0.85, 0.7, 0.6], lengthRatio: [0.36, 0.55, 0.5], leafSize: 0.7, leavesPerBranch: 6, gravitropism: 0.25 }, leaf: "oval", bark: "furrowed", barkColor: 0x777068, tints: [0xd8c23a, 0xc0b43a, 0xe6c840, 0x9aa83a] },
  ];
  const textures: Texture[] = [];
  const tex = (w: number, h: number, px: Uint8Array, label: string, srgb = true): Texture => {
    const t = Texture.fromRgba8(engine.gpu, w, h, px, { label, srgb, mipmaps: true });
    textures.push(t);
    return t;
  };
  const leafTexSize = tierValue(tier, { low: 64, medium: 128, high: 128 });
  const leafMats = new Map<LeafShape, Material>();
  const barkMats = new Map<string, Material>();
  const variants = tierValue(tier, { low: 2, medium: 3, high: 3 });
  const models: VegetationModel[] = [];
  const modelOf: number[][] = [];
  const treeTris = { hi: 0, lo: 0 };
  species.forEach((sp, si) => {
    let leafMat = leafMats.get(sp.leaf);
    if (!leafMat) {
      leafMat = mat(new Material({ label: `offroad.leaves-${sp.leaf}`, color: 0xffffff, roughness: 0.8, metallic: 0, doubleSided: true, albedoMap: tex(leafTexSize, leafTexSize, leafCardPixels(leafTexSize, sp.leaf, 11 + si), `offroad.leaf-${sp.leaf}`) }));
      leafMat.alphaTest = 0.5;
      leafMats.set(sp.leaf, leafMat);
    }
    const barkKey = `${sp.bark}-${sp.barkColor}`;
    let barkMat = barkMats.get(barkKey);
    if (!barkMat) {
      barkMat = mat(new Material({ label: `offroad.bark-${sp.spec.name}`, color: sp.barkColor, roughness: 0.95, metallic: 0, albedoMap: tex(64, 64, barkPixels(64, sp.bark, 5 + si), `offroad.bark-${sp.spec.name}`) }));
      barkMats.set(barkKey, barkMat);
    }
    modelOf[si] = [];
    for (let v = 0; v < variants; v++) {
      const seed = 1000 * (si + 1) + v * 77;
      const hiTree = generateTree(sp.spec, seed, "hi");
      const loTree = generateTree(sp.spec, seed, "lo");
      treeTris.hi = Math.max(treeTris.hi, triangleCount(hiTree.wood) + triangleCount(hiTree.leaves));
      treeTris.lo = Math.max(treeTris.lo, triangleCount(loTree.wood) + triangleCount(loTree.leaves));
      modelOf[si]!.push(models.length);
      models.push({
        parts: [
          { hi: geo(hiTree.wood), lo: geo(loTree.wood), material: barkMat, castShadow: true },
          { hi: geo(hiTree.leaves), lo: geo(loTree.leaves), material: leafMat, castShadow: true },
        ],
        lodDistance: tierValue(tier, { low: 22, medium: 35, high: 50 }),
        maxDistance: 0,
        sway: { maxBend: 0.22, halfBendWind: 30, frequency: 0.3 },
        swayDistance: tierValue(tier, { low: 30, medium: 50, high: 70 }),
      });
    }
  });

  // ------------------------------------------------------------------ grass (engine procedural blades)
  const grassTex = tex(8, 64, grassBladePixels(8, 64), "offroad.grass-blade");
  const grassMat = mat(new Material({ label: "offroad.grass", color: 0xffffff, roughness: 0.85, metallic: 0, doubleSided: true, albedoMap: grassTex }));
  const grassModels: number[] = [];
  const grassVariants = 4;
  for (let v = 0; v < grassVariants; v++) {
    const opts = { size: 1.3, blades: tierValue(tier, { low: 45, medium: 70, high: 100 }), height: [0.16, 0.42] as [number, number], width: 0.022, seed: 300 + v, sink: 0.06 };
    grassModels.push(models.length);
    models.push({
      parts: [{ hi: geo(grassPatchSource(opts, "hi")), lo: geo(grassPatchSource(opts, "lo")), material: grassMat, castShadow: false }],
      lodDistance: tierValue(tier, { low: 8, medium: 12, high: 16 }),
      maxDistance: tierValue(tier, { low: 20, medium: 30, high: 42 }),
      // Grass bends far more readily than a tree and rocks faster.
      sway: { maxBend: 0.7, halfBendWind: 9, frequency: 0.9 },
      swayDistance: tierValue(tier, { low: 10, medium: 16, high: 24 }),
    });
  }
  // Understory shrubs (engine multi-stem bushes): spicebush/dogwood greens going gold and red.
  const bushModels: number[] = [];
  const bushLeaf = leafMats.get("oval")!;
  const bushBark = barkMats.values().next().value!;
  for (let v = 0; v < tierValue(tier, { low: 2, medium: 3, high: 4 }); v++) {
    const spec = { name: "shrub", height: [1.2, 2.4] as [number, number], stems: 4 + v, spread: 0.5, leafSize: 0.42, leavesPerBranch: 9 };
    const hiB = generateBush(spec, 500 + v, "hi");
    const loB = generateBush(spec, 500 + v, "lo");
    bushModels.push(models.length);
    models.push({
      parts: [
        { hi: geo(hiB.wood), lo: geo(loB.wood), material: bushBark, castShadow: false },
        { hi: geo(hiB.leaves), lo: geo(loB.leaves), material: bushLeaf, castShadow: true },
      ],
      lodDistance: tierValue(tier, { low: 14, medium: 22, high: 30 }),
      maxDistance: tierValue(tier, { low: 60, medium: 90, high: 130 }),
      sway: { maxBend: 0.3, halfBendWind: 15, frequency: 0.6 },
      swayDistance: tierValue(tier, { low: 15, medium: 25, high: 35 }),
    });
  }
  let windNow = { x: 0, z: 0 };
  const vegetation = new VegetationField({
    name: "offroad-vegetation",
    models,
    viewer: () => cameraEntity.transform.position,
    wind: () => windNow,
  });
  const treeTint = (c: number): number => (0xff000000 | c) >>> 0;
  const placeTree = (t: TrackPlacement): void => {
    const si = Math.floor(t.random * 997) % species.length;
    const list = modelOf[si]!;
    const model = list[t.palette % list.length]!;
    const tints = species[si]!.tints;
    vegetation.add(model, t.x, t.y, t.z, t.yaw, t.scale, treeTint(tints[Math.floor(t.random * 7919) % tints.length]!));
  };
  for (const t of near) placeTree(t);
  for (const t of back) placeTree(t);
  const grassSpots = scatterAlongTrack(track, {
    seed: 41,
    lateralMin: span + 0.15,
    lateralMax: track.bermOuterEdge + 3,
    density: tierValue(tier, { low: 0.12, medium: 0.2, high: 0.3 }),
    scaleMin: 0.8,
    scaleMax: 1.25,
    palettes: 4,
  });
  // Hydroseeded berm grass (photos): mostly green, some straw where it has gone over.
  const grassTints = [0x7fae3c, 0x93b84a, 0x6c9a34, 0xb8b060];
  const nrm = { x: 0, y: 1, z: 0 };
  for (const g of grassSpots) {
    track.normalAt(g.x, g.z, nrm);
    vegetation.add(grassModels[g.palette % grassModels.length]!, g.x, g.y, g.z, g.yaw, g.scale, treeTint(grassTints[Math.floor(g.random * 31) % grassTints.length]!), nrm);
  }
  const bushTints = [0x5f8a2c, 0x7a9a30, 0xb89a2a, 0xa8481e, 0x6e7f28];
  const understory = scatterAlongTrack(track, { seed: 19, lateralMin: track.bermOuterEdge + 6, lateralMax: 38, density: 0.025 * density, scaleMin: 0.8, scaleMax: 1.4, palettes: 5 });
  for (const b of [...brush, ...understory]) {
    vegetation.add(bushModels[Math.floor(b.random * 991) % bushModels.length]!, b.x, b.y - 0.05, b.z, b.yaw, b.scale, treeTint(bushTints[Math.floor(b.random * 7717) % bushTints.length]!));
  }
  scene.add(vegetation);

  // ------------------------------------------------------------------ start / finish gate
  const gate = track.poseAt(START_S);
  const postGeo = geo(cylinderGeometrySource({ radiusTop: 0.12, radiusBottom: 0.14, height: 4, radialSegments: 8 }));
  const bannerGeo = createBox(engine.gpu, { width: 2 * span + 2.6, height: 0.7, depth: 0.08 });
  geometries.push(bannerGeo);
  const postMat = mat(new Material({ label: "offroad.gate-post", color: 0x3a3a3a, roughness: 0.6, metallic: 0.4 }));
  const bannerMat = mat(new Material({ label: "offroad.gate-banner", color: 0xf2f2f2, roughness: 0.6, metallic: 0, emissive: Color.fromSrgbHex(0x101010) }));
  const stripeGeo = createBox(engine.gpu, { width: 2 * ROAD_HALF_WIDTH, height: 0.02, depth: 0.5 });
  geometries.push(stripeGeo);
  const stripeMat = mat(new Material({ label: "offroad.start-line", color: 0xe8e8e8, roughness: 0.7, metallic: 0 }));
  const gateRot = new Quat().setEulerComponents(0, gate.yaw, 0);
  for (const side of [-1, 1]) {
    const lat = side * (span + 1.2);
    const px = gate.x + Math.cos(gate.yaw) * lat;
    const pz = gate.z - Math.sin(gate.yaw) * lat;
    const e = add(`gate-post-${side}`, postGeo, postMat, true);
    e.transform.position = new Vec3(px, heightAt(px, pz) + 2, pz);
  }
  const banner = add("gate-banner", bannerGeo, bannerMat, true);
  banner.transform.position = new Vec3(gate.x, gate.y + 3.7, gate.z);
  banner.transform.rotation = gateRot.clone();
  const stripe = add("start-line", stripeGeo, stripeMat, false);
  stripe.transform.position = new Vec3(gate.x, gate.y + 0.07, gate.z);
  stripe.transform.rotation = gateRot.clone();

  // ------------------------------------------------------------------ vehicle (engine raycast car)
  scene.world.registerSystem(new VehicleSystem());
  const vehicle = new Vehicle(createVehicleConfig({
    mass: 1250,
    wheelbase: 2.35,
    track: 1.45,
    wheelRadius: 0.36,
    cgHeight: 0.55,
    mu: 1.0,
    rollingResistance: 0.03,
    maxBrakeTorque: 3200,
  }));
  vehicle.config.suspensionRest = 0.36;
  vehicle.config.suspensionTravel = 0.22;
  const placeAt = (s: number, lateral = 0, yawOffset = 0): void => {
    const c = spline.sampleAt(s, { x: 0, z: 0, tx: 0, tz: 1 });
    vehicle.position.set(c.x + c.tz * lateral, 0, c.z - c.tx * lateral);
    vehicle.yaw = Math.atan2(c.tx, c.tz) + yawOffset;
    vehicle.velocity.set(0, 0, 0);
    vehicle.yawRate = 0;
    vehicle.placeOnGround(ground);
  };
  placeAt(START_S - SPAWN_BACK);

  const bodyMat = mat(new Material({ label: "offroad.utv-paint", color: 0x2f5d3a, roughness: 0.45, metallic: 0.2 }));
  const darkMat = mat(new Material({ label: "offroad.utv-trim", color: 0x1c1d1f, roughness: 0.7, metallic: 0.1 }));
  const glassMat = mat(new Material({ label: "offroad.utv-glass", color: 0x22323a, roughness: 0.15, metallic: 0.5 }));
  const tyreMat = mat(new Material({ label: "offroad.tyre", color: 0x1b1b1b, roughness: 0.95, metallic: 0 }));
  const rimMat = mat(new Material({ label: "offroad.rim", color: 0x8d8f91, roughness: 0.4, metallic: 0.8 }));
  const chassis = scene.createTransformedEntity("utv", vehicle.position.clone());
  const part = (name: string, w: number, h: number, d: number, at: Vec3, m: Material, shadow = true): Entity => {
    const g = createBox(engine.gpu, { width: w, height: h, depth: d });
    geometries.push(g);
    const e = scene.createTransformedEntity(name, at);
    chassis.addChild(e);
    e.transform.position = at;
    const r = new Renderable();
    r.geometry = g;
    r.material = m;
    r.castShadow = shadow;
    scene.world.addComponent(e.id, r);
    return e;
  };
  part("utv-tub", 1.5, 0.42, 3.1, new Vec3(0, 0.05, 0), bodyMat);
  part("utv-hood", 1.42, 0.3, 0.95, new Vec3(0, 0.38, 1.05), bodyMat);
  part("utv-bed", 1.5, 0.34, 0.9, new Vec3(0, 0.42, -1.1), darkMat);
  // Cab: roof, pillars, dash and the dark visor band the in-cab view looks under (photo 2).
  part("utv-roof", 1.5, 0.07, 1.45, new Vec3(0, 1.72, 0.0), darkMat);
  part("utv-visor", 1.4, 0.22, 0.5, new Vec3(0, 1.58, 0.5), darkMat, false);
  for (const sx of [-0.72, 0.72]) {
    for (const sz of [0.68, -0.68]) part(`utv-pillar-${sx}-${sz}`, 0.04, 1.35, 0.06, new Vec3(sx, 1.05, sz), darkMat);
  }
  part("utv-dash", 1.4, 0.2, 0.32, new Vec3(0, 0.72, 0.62), darkMat, false);
  part("utv-windscreen-frame", 1.42, 0.05, 0.05, new Vec3(0, 0.84, 0.7), glassMat, false);
  part("utv-seat", 1.2, 0.5, 0.45, new Vec3(0, 0.52, -0.35), darkMat);
  const chassisComp = new VehicleComponent(vehicle, ground);
  const tyreGeo = createCylinder(engine.gpu, { radiusTop: 0.36, radiusBottom: 0.36, height: 0.28, radialSegments: 18, capped: true });
  const rimGeo = createCylinder(engine.gpu, { radiusTop: 0.2, radiusBottom: 0.2, height: 0.3, radialSegments: 10, capped: true });
  geometries.push(tyreGeo, rimGeo);
  const lay = new Quat().setAxisAngle(new Vec3(0, 0, 1), -Math.PI / 2);
  const wheelIds: number[] = [];
  for (let i = 0; i < vehicle.wheels.length; i++) {
    const w = scene.createTransformedEntity(`utv-wheel-${i}`, vehicle.position.clone());
    for (const [g, m] of [[tyreGeo, tyreMat], [rimGeo, rimMat]] as const) {
      const e = scene.createTransformedEntity(`utv-wheel-${i}-${m.label}`, new Vec3());
      w.addChild(e);
      e.transform.position = new Vec3();
      e.transform.rotation = lay.clone();
      const r = new Renderable();
      r.geometry = g;
      r.material = m;
      r.castShadow = true;
      scene.world.addComponent(e.id, r);
    }
    wheelIds.push(w.id);
  }
  chassisComp.wheelEntities = wheelIds;
  // Persistent tyre tracks (engine): the demo only says what the ground is under each tyre.
  const tracks = new TireTrackLayer(engine.gpu, { heightAt, tileResolution: tierValue(tier, { low: 128, medium: 192, high: 256 }), maxTiles: tierValue(tier, { low: 12, medium: 20, high: 32 }) });
  const trackSample = { s: 0, lateral: 0, road: 0, rut: 0, berm: 0 };
  tracks.followVehicle(vehicle, (x, z) => {
    if (weather.surface.snow > 0.3 || trackGround.field.snow[trackGround.field.indexAt(x, z)]! > 0.02) return "snow";
    if (trackGround.field.mudAt(x, z) > 0.3) return "mud";
    track.surfaceAt(x, z, trackSample);
    return trackSample.berm > 0.5 || !Number.isFinite(trackSample.lateral) || Math.abs(trackSample.lateral) > track.bermOuterEdge ? "grass" : "gravel";
  });
  scene.add(tracks);
  chassis.add(chassisComp);

  // ------------------------------------------------------------------ sun + sky
  const sunEntity = scene.createTransformedEntity("sun", new Vec3(0, 80, 0));
  const sun = new Light();
  sun.kind = "directional";
  sun.castShadow = true;
  sun.cascades = scene.settings.shadow.cascades;
  scene.world.addComponent(sunEntity.id, sun);
  // Mid-October early afternoon, 39°N (Ohio valley hills): bright, fairly low autumn sun.
  const cycle = new DayNightCycle({
    name: "dayNight",
    latitude: 39,
    dayOfYear: 289,
    timeOfDay: 14.2,
    timeScale: 0,
    sun,
    sunIntensity: 5.2,
    ambientScale: 0.7,
    driveAmbient: true,
    driveFog: true,
    driveSky: true,
  });
  scene.add(cycle);
  cycle.apply();

  // ------------------------------------------------------------------ weather (engine systems; the menu is the demo's)
  const weather = new WeatherSystem({ name: "weather", seed: 3710, initial: OFFROAD_WEATHER.clear.state, target: OFFROAD_WEATHER.clear.state });
  // Grip comes from the track ground below (per surface, with the field's mud); don't count 17.4 twice.
  weather.driveVehicles = false;
  scene.add(weather);
  const trackGround = new TrackWeatherGround(track, { resolution: tierValue(tier, { low: 64, medium: 96, high: 128 }), timeScale: 30 });
  trackGround.surface = weather.surface;
  const overlay = new MoistureOverlayMaps(engine.gpu, trackGround.field, "offroad.ground-overlay", 0.78);
  // Overlay meshes: the road and berm ribbons again, lifted, with UVs onto the field's patch.
  const overlayAlong = tierValue(tier, { low: 2, medium: 1.5, high: 1 });
  const overlayIds: Entity[] = [];
  overlayIds.push(add("overlay-road", geo(withFieldUvs(trackRibbonSource(track, { from: -span, to: span, across: 9, alongStep: overlayAlong, lift: 0.025, uvMetersAlong: UV_ALONG }), trackGround.field, 0.03, "offroad.overlay-road")), overlay.material, false));
  for (const side of [-1, 1] as const) {
    overlayIds.push(add(`overlay-berm-${side}`, geo(withFieldUvs(trackRibbonSource(track, { from: side * (span - 0.05), to: side * bermOuter, across: 8, alongStep: overlayAlong, lift: 0.03, uvMetersAlong: 4 }), trackGround.field, 0.035, "offroad.overlay-berm")), overlay.material, false));
  }
  // Alpha-blended after the opaques (the renderable's flag picks the blend path).
  for (const e of overlayIds) scene.world.getComponent(e.id, Renderable)!.transparent = true;
  setWorldSurfaceGripField(scene.world, (x, z) => trackGround.gripAt(x, z));
  const precipitation = new PrecipitationField({
    name: "offroad-precipitation",
    capacity: tierValue(tier, { low: 3072, medium: 8192, high: 12288 }),
    maxRate: tierValue(tier, { low: 2000, medium: 4200, high: 6500 }),
    follow: () => cameraEntity.transform.position,
    drive: () => weatherPrecipitationDrive(weather.state),
    seed: 371,
  });
  scene.add(precipitation);
  const meltEnv = createMeltEnvironment();
  let weatherName: OffroadWeather = "clear";
  const setWeather = (name: OffroadWeather): void => {
    weatherName = name;
    const preset = OFFROAD_WEATHER[name];
    weather.snapTo(preset.state);
    weather.setTarget(preset.state);
    const c = TRACK_GROUND_CONDITIONS[preset.ground];
    weather.surface.wetness = c.surface.wetness;
    weather.surface.puddles = c.surface.puddles;
    weather.surface.snow = c.surface.snow;
    trackGround.applyCondition(c);
    overlay.upload();
    vegetation.setSurface(c.surface.wetness, c.surface.snow);
    weatherMenu.select(name);
  };

  // ------------------------------------------------------------------ camera
  const cameraEntity = scene.createTransformedEntity("camera", new Vec3(vehicle.position.x, vehicle.position.y + 3, vehicle.position.z - 7));
  const camera = new Camera();
  camera.fovY = (62 * Math.PI) / 180;
  camera.near = 0.08;
  camera.far = 1600;
  scene.world.addComponent(cameraEntity.id, camera);

  let cameraMode: OffroadCameraMode = "chase";
  const chaseEye = new Vec3(vehicle.position.x, vehicle.position.y + 3, vehicle.position.z - 7);
  const chaseLook = new Vec3(vehicle.position.x, vehicle.position.y + 1, vehicle.position.z);
  let chaseYaw = vehicle.yaw;
  // Screenshot/gate hook: a fixed free camera (`lookAt`), not reachable from the UI.
  const freeEye = new Vec3();
  const freeTarget = new Vec3();
  const rot = new Quat();
  const tmp = new Vec3();
  const tmp2 = new Vec3();

  // ------------------------------------------------------------------ input
  const keys = new Set<string>();
  let parkingBrake = false;
  let touch: ReturnType<typeof attachVehicleTouch>;
  const cycleCamera = (): void => {
    cameraMode = cameraMode === "chase" ? "cab" : cameraMode === "cab" ? "orbit" : "chase";
  };
  // Touch / click buttons (iOS Safari: pointer events + touch-action:none + no callout; the
  // engine-agnostic chrome suppression is shared with the vehicle pad).
  const domListeners: Array<[EventTarget, string, EventListener]> = [];
  const on = (el: EventTarget | null, type: string, fn: EventListener, opts?: AddEventListenerOptions): void => {
    if (!el) return;
    el.addEventListener(type, fn, opts);
    domListeners.push([el, type, fn]);
  };
  const tap = (id: string, fn: () => void): void => {
    const el = document.getElementById(id);
    for (const [t, type, f] of suppressTouchChrome(el)) domListeners.push([t, type, f]);
    // The chrome suppression cancels touchstart, which also cancels the synthetic click on iOS,
    // so taps act on pointerup; click stays for keyboard/AT activation (deduped after a tap).
    let lastTap = -1e9;
    on(el, "pointerup", (event) => {
      event.preventDefault();
      lastTap = performance.now();
      fn();
    });
    on(el, "click", (event) => {
      event.preventDefault();
      if (performance.now() - lastTap < 600) return;
      fn();
    });
  };
  tap("offroad-cam", () => cycleCamera());
  tap("offroad-reset", () => resetToTrack());
  // Handbrake is held, not toggled: pointerdown → on, up/cancel/lost capture (anywhere) → off.
  let handbrakeHeld = false;
  let handbrakePointer: number | null = null;
  const hbButton = document.getElementById("offroad-hb");
  for (const [t, type, f] of suppressTouchChrome(hbButton)) domListeners.push([t, type, f]);
  const hbOff = (event: Event): void => {
    const e = event as PointerEvent;
    if (handbrakePointer !== null && e.pointerId !== undefined && e.pointerId !== handbrakePointer) return;
    handbrakePointer = null;
    handbrakeHeld = false;
    hbButton?.classList.remove("pressed");
  };
  on(hbButton, "pointerdown", (event) => {
    const e = event as PointerEvent;
    if (e.pointerType === "mouse" && e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    handbrakePointer = e.pointerId;
    try {
      hbButton?.setPointerCapture(e.pointerId);
    } catch {
      /* already released */
    }
    handbrakeHeld = true;
    hbButton?.classList.add("pressed");
  });
  on(hbButton, "pointerup", hbOff);
  on(hbButton, "pointercancel", hbOff);
  on(hbButton, "lostpointercapture", hbOff);
  on(window, "pointerup", hbOff);
  on(window, "blur", hbOff);
  // Steering wheel + pedals (shared controls; the layout is this demo's CSS).
  const wheel = attachSteeringWheel(document.getElementById("offroad-wheel"), { rim: document.getElementById("offroad-wheel-rim") });
  const gasPedal = attachPedal(document.getElementById("offroad-gas"));
  const brakePedal = attachPedal(document.getElementById("offroad-brake"));
  // Weather menu: a toggle button opening five big choices (also keys 1–5).
  const menuRoot = document.getElementById("offroad-weather-menu");
  const menuButton = document.getElementById("offroad-weather");
  const setMenuOpen = (open: boolean): void => {
    menuRoot?.classList.toggle("open", open);
    menuButton?.setAttribute("aria-expanded", String(open));
  };
  tap("offroad-weather", () => setMenuOpen(!menuRoot?.classList.contains("open")));
  for (const name of OFFROAD_WEATHER_NAMES) {
    tap(`offroad-weather-${name}`, () => {
      setWeather(name);
      setMenuOpen(false);
    });
  }
  const weatherLabel = document.getElementById("offroad-weather-label");
  const weatherMenu = {
    select(name: OffroadWeather): void {
      for (const n of OFFROAD_WEATHER_NAMES) document.getElementById(`offroad-weather-${n}`)?.setAttribute("aria-pressed", String(n === name));
      if (weatherLabel) weatherLabel.textContent = OFFROAD_WEATHER[name].label.toUpperCase();
    },
  };
  const onKeyDown = (event: KeyboardEvent): void => {
    keys.add(event.code);
    if (event.code === "KeyC" && !event.repeat) cycleCamera();
    if (event.code === "KeyP" && !event.repeat) {
      parkingBrake = !parkingBrake;
      touch.setPark(parkingBrake);
    }
    if (event.code === "KeyR" && !event.repeat) {
      const reverse = vehicle.gear >= 0;
      if (vehicle.selectDriveDirection(reverse)) touch.setGear(reverse ? "R" : "F");
    }
    if (event.code === "KeyT" && !event.repeat) resetToTrack();
    const digit = /^Digit([1-5])$/.exec(event.code);
    if (digit && !event.repeat) setWeather(OFFROAD_WEATHER_NAMES[Number(digit[1]) - 1]!);
    if (event.code === "Space" || event.code.startsWith("Arrow")) event.preventDefault();
  };
  const onKeyUp = (event: KeyboardEvent): void => {
    keys.delete(event.code);
  };
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
  touch = attachVehicleTouch(document.getElementById("vehicle-touch"), {
    onGearSelect: (position) => vehicle.selectGear(position === "F" ? 1 : position === "R" ? -1 : 0),
    onParkToggle: () => {
      parkingBrake = !parkingBrake;
      touch.setPark(parkingBrake);
    },
  });
  touch.setGear("F");

  // ------------------------------------------------------------------ lap timer
  const proj: TrackProjection = { s: 0, lateral: 0, dist: Infinity, index: -1 };
  const L = spline.length;
  const timer = new TrackLapTimer(spline, { startS: START_S });
  const resetToTrack = (): void => {
    spline.project(vehicle.position.x, vehicle.position.z, proj);
    placeAt(Number.isFinite(proj.dist) ? proj.s : START_S - SPAWN_BACK);
    timer.resync();
  };

  const handle: OffroadSceneHandle = {
    scene,
    cameraEntity,
    controlsHint: "WASD / arrows drive · Space handbrake · R forward/reverse · C camera · T back on track · 1–5 weather (sun, overcast, rain, snow, mud)",
    camera: {
      target: new Vec3(vehicle.position.x, vehicle.position.y + 1, vehicle.position.z),
      distance: 10,
      minDistance: 3,
      maxDistance: 80,
      azimuth: vehicle.yaw + Math.PI,
      elevation: 0.3,
      groundHeight: heightAt,
      groundClearance: 1.2,
      keyboard: false,
    },
    followTarget: () => ({ x: vehicle.position.x, y: vehicle.position.y + 1, z: vehicle.position.z }),
    cameraOverride: () => {
      if (cameraMode === "orbit") return null;
      if (cameraMode === "free") return { eye: [freeEye.x, freeEye.y, freeEye.z], target: [freeTarget.x, freeTarget.y, freeTarget.z] };
      vehicle.writeRotation(rot);
      if (cameraMode === "cab") {
        // Driver's eye: left seat, under the visor, looking along the chassis.
        rot.rotateVector(tmp.set(-0.22, 1.25, -0.05), tmp);
        rot.rotateVector(tmp2.set(0, -0.12, 10), tmp2);
        const ex = vehicle.position.x + tmp.x, ey = vehicle.position.y + tmp.y, ez = vehicle.position.z + tmp.z;
        return { eye: [ex, ey, ez], target: [ex + tmp2.x, ey + tmp2.y, ez + tmp2.z] };
      }
      return { eye: [chaseEye.x, chaseEye.y, chaseEye.z], target: [chaseLook.x, chaseLook.y, chaseLook.z] };
    },
    update(dt: number): void {
      const pad = touch.sample();
      const keyThrottle = keys.has("KeyW") || keys.has("ArrowUp") ? 1 : 0;
      const keyBrake = keys.has("KeyS") || keys.has("ArrowDown") ? 1 : 0;
      const keySteer = (keys.has("KeyD") || keys.has("ArrowRight") ? 1 : 0) - (keys.has("KeyA") || keys.has("ArrowLeft") ? 1 : 0);
      vehicle.input.throttle = Math.max(keyThrottle, pad.throttle, gasPedal.value());
      vehicle.input.brake = Math.max(keyBrake, pad.brake, brakePedal.value());
      vehicle.input.steer = Math.max(-1, Math.min(1, keySteer + pad.steer + wheel.value()));
      vehicle.input.handbrake = keys.has("Space") || handbrakeHeld ? 1 : 0;
      vehicle.input.parkingBrake = parkingBrake ? 1 : 0;
      timer.update(vehicle.position.x, vehicle.position.z, dt);

      // Weather: wind for the plants and rain, the ground field (mud, pooling, melt) and its overlay.
      const drive = weatherPrecipitationDrive(weather.state);
      windNow = { x: drive.windX, z: drive.windZ };
      sampleMeltEnvironment(scene, weather, meltEnv);
      if (trackGround.update(dt, meltEnv)) {
        overlay.upload();
        vegetation.setSurface(weather.surface.wetness, weather.surface.snow);
      }

      // Chase camera: trails behind along a smoothed heading, held above the berms and terrain.
      const k = 1 - Math.exp(-dt * 4);
      let dy = vehicle.yaw - chaseYaw;
      dy = Math.atan2(Math.sin(dy), Math.cos(dy));
      chaseYaw += dy * (1 - Math.exp(-dt * 3));
      const dist = 6.8;
      const tx = vehicle.position.x - Math.sin(chaseYaw) * dist;
      const tz = vehicle.position.z - Math.cos(chaseYaw) * dist;
      const ty = Math.max(vehicle.position.y + 2.6, heightAt(tx, tz) + 1.6);
      chaseEye.x += (tx - chaseEye.x) * k;
      chaseEye.y += (ty - chaseEye.y) * k;
      chaseEye.z += (tz - chaseEye.z) * k;
      chaseLook.set(vehicle.position.x + Math.sin(chaseYaw) * 3, vehicle.position.y + 1.1, vehicle.position.z + Math.cos(chaseYaw) * 3);
    },
    overlay(): string {
      const { lap, running, lapTime, lastLap, bestLap, progress } = timer.state;
      return (
        `OFF-ROAD HILL  lap ${Math.max(1, lap)}  ${running ? fmtTime(lapTime) : "drive through the gate to start"}\n` +
        `last ${fmtTime(lastLap)}  best ${fmtTime(bestLap)}  progress ${(progress * 100).toFixed(0)}%\n` +
        `speed ${(vehicle.speed * 3.6).toFixed(0)} km/h  gear ${vehicle.gear === 0 ? "N" : vehicle.gear < 0 ? "R" : vehicle.gear}  camera ${cameraMode}\n` +
        `weather ${OFFROAD_WEATHER[weatherName].label}  grip ${(trackGround.gripAt(vehicle.position.x, vehicle.position.z) * 100).toFixed(0)}%`
      );
    },
    vehicleState: () => ({
      speed: vehicle.speed,
      rpm: vehicle.rpm,
      gear: vehicle.gear,
      x: vehicle.position.x,
      y: vehicle.position.y,
      z: vehicle.position.z,
      parkingBrake: parkingBrake ? 1 : 0,
    }),
    setCameraMode(mode: OffroadCameraMode): void {
      cameraMode = mode;
      if (mode === "chase") {
        chaseYaw = vehicle.yaw;
        chaseEye.set(vehicle.position.x - Math.sin(chaseYaw) * 6.8, vehicle.position.y + 2.6, vehicle.position.z - Math.cos(chaseYaw) * 6.8);
        chaseLook.set(vehicle.position.x + Math.sin(chaseYaw) * 3, vehicle.position.y + 1.1, vehicle.position.z + Math.cos(chaseYaw) * 3);
      }
    },
    setWeather,
    lookAt(eye: [number, number, number], target: [number, number, number]): void {
      freeEye.set(eye[0], eye[1], eye[2]);
      freeTarget.set(target[0], target[1], target[2]);
      cameraMode = "free";
    },
    trackPoint(s: number, lateral: number): [number, number, number] {
      const c = spline.sampleAt(s, { x: 0, z: 0, tx: 0, tz: 1 });
      const x = c.x + c.tz * lateral, z = c.z - c.tx * lateral;
      return [x, heightAt(x, z), z];
    },
    gripAt(s: number, lateral: number): number {
      const c = spline.sampleAt(s, { x: 0, z: 0, tx: 0, tz: 1 });
      return trackGround.gripAt(c.x + c.tz * lateral, c.z - c.tx * lateral);
    },
    placeAt(s: number, lat = 0, yawOffset = 0): void {
      placeAt(s, lat, yawOffset);
      timer.resync();
      handle.setCameraMode(cameraMode);
    },
    snapshot(): OffroadSnapshot {
      const { lap, lapTime, lastLap, bestLap, running, progress, lateral } = timer.state;
      return {
        lap, lapTime, lastLap, bestLap, running, progress, trackLength: L, lateral,
        speedKph: vehicle.speed * 3.6, cameraMode,
        x: vehicle.position.x, y: vehicle.position.y, z: vehicle.position.z,
        trees: near.length + back.length, leaves: litter.length,
        grass: grassSpots.length,
        trackTiles: tracks.tileCount,
        surface: { ...weather.surface },
        weather: weatherName,
        grip: trackGround.gripAt(vehicle.position.x, vehicle.position.z),
        overlayCoverage: overlay.meanCoverage(),
        vegetation: vegetation.stats_,
        treeTriangles: treeTris,
      };
    },
    dispose(): void {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      for (const [t, type, f] of domListeners) t.removeEventListener(type, f);
      wheel.dispose();
      gasPedal.dispose();
      brakePedal.dispose();
      menuRoot?.classList.remove("open");
      setWorldSurfaceGripField(scene.world, undefined);
      overlay.dispose();
      for (const t of textures) t.dispose();
      touch.dispose();
      keys.clear();
      disposeTrackSurface(roadTex);
      disposeTrackSurface(bermTex);
      disposeTrackSurface(floorTex);
      for (const g of geometries) g.dispose();
      for (const m of materials) m.dispose();
      scene.dispose();
    },
  };
  setWeather(options.weather ?? "clear");
  return handle;
}
