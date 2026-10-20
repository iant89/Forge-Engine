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
  VehicleAudio,
  AudioSystem,
  EnvironmentSoundscape,
  ambienceSoundInput,
  type VehicleSoundSurface,
  VehicleSystem,
  createBox,
  createGrassBermTextures,
  createGravelRoadTextures,
  createVehicleConfig,
  EngineModel,
  cylinderGeometrySource,
  disposeTrackSurface,
  fbm2,
  heightFunctionGround,
  litterQuadsSource,
  scatterAlongTrack,
  tierValue,
  Transmission,
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
import {
  buildQuadSources,
  QUAD_FRONT_TYRE_WIDTH,
  QUAD_REAR_TYRE_WIDTH,
} from "./offroadQuad.js";

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

/**
 * Handlebar feel (rad/s of steering input): a quad's bars are light and self-centring, so lock comes
 * on slower than the fingers move and releases faster when they stop — otherwise digital keys give
 * instant full lock, and the quad darts.
 */
const STEER_RATE = 4.2;
const STEER_RETURN = 6.5;
/** Throttle/brake input ramps (1/s), up and down. No rider snaps from nothing to wide open. */
const THROTTLE_RISE = 5.5;
const THROTTLE_FALL = 9;
const BRAKE_RISE = 8;
const BRAKE_FALL = 10;

/** Move `current` toward `target` by at most `maxStep` (per frame, so `rate * dt`). */
const approach = (current: number, target: number, maxStep: number): number => {
  const delta = target - current;
  return Math.abs(delta) <= maxStep ? target : current + Math.sign(delta) * maxStep;
};

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
  vegetation: { hidden: number; hi: number; lo: number; swaying: number; casting: number };
  treeTriangles: { hi: number; lo: number };
  /** Phase 20.7 vehicle audio (opt-in: M / SOUND). */
  sound: { enabled: boolean; running: boolean; engineHz: number; load: number; slip: number; surface: VehicleSoundSurface | "air" };
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
  // Shadows reach as far as the vegetation's shadow ring and no further: the extra range bought
  // nothing (a 120 m cascade over a 2 m quad is mush) and cost caster work every frame.
  scene.settings.shadow.distance = tierValue(tier, { low: 40, medium: 55, high: 70 });
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
  // Backdrop forest: thin enough to read as a treeline, and pulled in to the distance the trees
  // are culled at, so no instance is spawned that can never be drawn.
  const back = scatterAlongTrack(track, { seed: 8, lateralMin: 40, lateralMax: 95, density: 0.005 * density, scaleMin: 1, scaleMax: 1.5, palettes: 4 });
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
        // Facing the treeline the field used to draw ~3500 trees × 2 shadow-casting parts every
        // frame (`maxDistance: 0` never culled, and both parts cast at any range). The three
        // distances below are what keeps that affordable: the low model from 16 m, no draw beyond
        // 70 m, and no shadow cast beyond 26 m — a tree's shadow is only readable close in.
        lodDistance: tierValue(tier, { low: 16, medium: 22, high: 30 }),
        maxDistance: tierValue(tier, { low: 70, medium: 105, high: 145 }),
        shadowDistance: tierValue(tier, { low: 26, medium: 38, high: 52 }),
        sway: { maxBend: 0.22, halfBendWind: 30, frequency: 0.3 },
        swayDistance: tierValue(tier, { low: 22, medium: 32, high: 44 }),
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
      maxDistance: tierValue(tier, { low: 45, medium: 70, high: 100 }),
      shadowDistance: tierValue(tier, { low: 28, medium: 38, high: 48 }),
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

  // ------------------------------------------------------------------ vehicle: a two-stroke sport quad
  scene.world.registerSystem(new VehicleSystem());
  /**
   * A 421 cc two-stroke single's port timing: soft and almost flat below 4000 rpm, a steep "hit"
   * as the powerband opens, peak at 7600, then a fall-off into the limiter. `EngineModel` clamps at
   * the redline, so the curve only describes the band — and the band is why the gearing is close.
   */
  const twoStrokeTorque = (rpm: number): number => {
    if (rpm <= 0) return 0;
    if (rpm < 4000) return 15 + 11 * (rpm / 4000);
    if (rpm < 7600) {
      const t = (rpm - 4000) / 3600;
      return 26 + 20 * (t * t * (3 - 2 * t));
    }
    return 46 - 20 * Math.min(1, (rpm - 7600) / 1900);
  };
  const quadEngine = new EngineModel({
    peakTorque: 46,
    inertia: 0.055,
    frictionTorque: 1.6,
    idleRpm: 1900,
    redlineRpm: 9500,
    torqueCurve: twoStrokeTorque,
  });
  const quadGearbox = new Transmission({
    // Close-ratio five-speed behind a 3.45 final drive: every upshift drops the crank back into the
    // band (9000 → ~7100), and the downshift threshold sits above the band's floor so it cannot
    // lug. Top gear totals 9.4:1 — about 100 km/h at the limiter on 0.27 m tyres.
    ratios: [6.0, 4.55, 3.6, 3.0, 2.72],
    reverseRatio: 4.4,
    finalDrive: 3.45,
    upshiftRpm: 9000,
    downshiftRpm: 5600,
    shiftDuration: 0.09,
    upshiftThrottle: 0.12,
  });
  const vehicle = new Vehicle(createVehicleConfig({
    // 180 kg of quad and an 85 kg rider.
    mass: 265,
    wheelbase: 1.28,
    track: 0.98,
    cgToFront: 0.6,
    wheelRadius: 0.27,
    cgHeight: 0.52,
    // A quad is a rider on a short wheelbase, not a long wide body: the mass-scaled car inertias
    // (0.9·m yaw) would make it steer like a barge and hide the suspension's work in pitch/roll.
    inertiaYaw: 78,
    inertiaPitch: 42,
    inertiaRoll: 26,
    angularDamping: 4.5,
    mu: 1.15,
    rollingResistance: 0.05,
    suspensionRest: 0.26,
    suspensionTravel: 0.21,
    springRate: 10400,
    damperRate: 1250,
    wheelInertia: 0.42,
    maxSteerAngle: 0.4,
    // Light machine: the car-scale brake/handbrake torques (4500/6000 N·m) locked all four wheels
    // the instant the pedal was touched, which read as "the brakes grab".
    maxBrakeTorque: 420,
    handbrakeTorque: 520,
    parkingBrakeTorque: 560,
    layout: "awd",
    lsdBias: 2.2,
    // Let it spin a little: knobbies on loose gravel, and a two-stroke that only pulls in the band.
    tcSlip: 0.18,
    tcStrength: 5,
    // An upright rider is a bluff body. It is also what stops the quad running away downhill.
    aero: { rho: 1.225, dragCoefficient: 0.78, liftCoefficient: 0.02, frontalArea: 0.85 },
    engine: quadEngine,
    transmission: quadGearbox,
  }));
  const quadStaticCompression = (vehicle.config.mass * vehicle.config.gravity) / (4 * vehicle.config.springRate);
  const quad = buildQuadSources({
    wheelbase: vehicle.config.wheelbase,
    track: vehicle.config.track,
    wheelRadius: vehicle.config.wheelRadius,
    hubDrop: vehicle.config.suspensionRest - quadStaticCompression,
    cgToFront: vehicle.config.cgToFront,
    frontTyreWidth: QUAD_FRONT_TYRE_WIDTH,
    rearTyreWidth: QUAD_REAR_TYRE_WIDTH,
  });
  const placeAt = (s: number, lateral = 0, yawOffset = 0): void => {
    const c = spline.sampleAt(s, { x: 0, z: 0, tx: 0, tz: 1 });
    vehicle.position.set(c.x + c.tz * lateral, 0, c.z - c.tx * lateral);
    vehicle.yaw = Math.atan2(c.tx, c.tz) + yawOffset;
    vehicle.velocity.set(0, 0, 0);
    vehicle.yawRate = 0;
    vehicle.placeOnGround(ground);
  };
  placeAt(START_S - SPAWN_BACK);

  const plasticMat = mat(new Material({ label: "offroad.quad-plastic", color: 0x1f6fd0, roughness: 0.42, metallic: 0.05 }));
  const trimMat = mat(new Material({ label: "offroad.quad-trim", color: 0x1b1d21, roughness: 0.78, metallic: 0.05 }));
  const steelMat = mat(new Material({ label: "offroad.quad-steel", color: 0x9aa0a6, roughness: 0.38, metallic: 0.85 }));
  const engineMat = mat(new Material({ label: "offroad.quad-engine", color: 0xa8adb2, roughness: 0.45, metallic: 0.7 }));
  const exhaustMat = mat(new Material({ label: "offroad.quad-exhaust", color: 0x6d7378, roughness: 0.32, metallic: 0.9 }));
  const lampMat = mat(new Material({ label: "offroad.quad-lamp", color: 0xfff6e2, roughness: 0.18, metallic: 0, emissive: Color.fromSrgbHex(0xfff0c8), emissiveStrength: 0.85 }));
  const tyreMat = mat(new Material({ label: "offroad.tyre", color: 0x17181a, roughness: 0.95, metallic: 0 }));
  const rimMat = mat(new Material({ label: "offroad.rim", color: 0xb9bcc0, roughness: 0.34, metallic: 0.85 }));
  const brakeMat = mat(new Material({ label: "offroad.brake", color: 0x53575c, roughness: 0.5, metallic: 0.8 }));
  const chassis = scene.createTransformedEntity("quad", vehicle.position.clone());
  /** One merged draw per material: the quad's whole body is six of them. */
  const quadPart = (name: string, source: GeometrySource, material: Material, shadow = true): void => {
    const e = scene.createTransformedEntity(name, new Vec3());
    chassis.addChild(e);
    e.transform.position = new Vec3();
    const r = new Renderable();
    r.geometry = geo(source);
    r.material = material;
    r.castShadow = shadow;
    scene.world.addComponent(e.id, r);
  };
  quadPart("quad-plastic", quad.body.plastic, plasticMat);
  quadPart("quad-trim", quad.body.trim, trimMat, false);
  quadPart("quad-steel", quad.body.steel, steelMat);
  quadPart("quad-engine", quad.body.engine, engineMat);
  quadPart("quad-exhaust", quad.body.exhaust, exhaustMat);
  quadPart("quad-lamps", quad.body.lamps, lampMat, false);

  const chassisComp = new VehicleComponent(vehicle, ground);
  // Fronts are narrower than rears, so there are two wheel assemblies; each axle shares one.
  const wheelSets = [
    { tyre: geo(quad.wheelFront.tyre), rim: geo(quad.wheelFront.rim), brake: geo(quad.wheelFront.brake) },
    { tyre: geo(quad.wheelRear.tyre), rim: geo(quad.wheelRear.rim), brake: geo(quad.wheelRear.brake) },
  ];
  const wheelIds: number[] = [];
  for (let i = 0; i < vehicle.wheels.length; i++) {
    const wheel = vehicle.wheels[i]!;
    // Wheel centres are root entities: `VehicleSystem` poses them in world space, so a wheel
    // parented to the chassis would be offset by the chassis's own pose.
    const root = scene.createTransformedEntity(`quad-wheel-${i}`, vehicle.position.clone());
    const set = wheelSets[wheel.z >= 0 ? 0 : 1]!;
    for (const [name, geometry, material] of [["tyre", set.tyre, tyreMat], ["rim", set.rim, rimMat], ["brake", set.brake, brakeMat]] as const) {
      const e = scene.createTransformedEntity(`quad-wheel-${i}-${name}`, new Vec3());
      root.addChild(e);
      e.transform.position = new Vec3();
      // Left-side wheels turn their meshes 180° so the rim dish always faces outboard.
      if (wheel.x < 0) e.transform.rotation = new Quat().setAxisAngle(new Vec3(0, 1, 0), Math.PI);
      const r = new Renderable();
      r.geometry = geometry;
      r.material = material;
      r.castShadow = true;
      scene.world.addComponent(e.id, r);
    }
    wheelIds.push(root.id);
  }
  chassisComp.wheelEntities = wheelIds;
  // Persistent tyre tracks (engine): the demo only says what the ground is under each tyre.
  const tracks = new TireTrackLayer(engine.gpu, { heightAt, tileResolution: tierValue(tier, { low: 128, medium: 192, high: 256 }), maxTiles: tierValue(tier, { low: 12, medium: 20, high: 32 }) });
  const trackSample = { s: 0, lateral: 0, road: 0, rut: 0, berm: 0 };
  const groundAt = (x: number, z: number): "snow" | "mud" | "grass" | "gravel" => {
    if (weather.surface.snow > 0.3 || trackGround.field.snow[trackGround.field.indexAt(x, z)]! > 0.02) return "snow";
    if (trackGround.field.mudAt(x, z) > 0.3) return "mud";
    track.surfaceAt(x, z, trackSample);
    return trackSample.berm > 0.5 || !Number.isFinite(trackSample.lateral) || Math.abs(trackSample.lateral) > track.bermOuterEdge ? "grass" : "gravel";
  };
  tracks.followVehicle(vehicle, groundAt);
  // Phase 20.7: the engine, tyres and suspension are heard from the simulation; the ground the
  // tyre tracks use is the ground the tyres sound on, plus standing water.
  const soundSurfaceAt = (x: number, z: number): VehicleSoundSurface => (trackGround.field.puddleAt(x, z) > 0.5 ? "water" : groundAt(x, z));
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
  const chaseEye = new Vec3(vehicle.position.x, vehicle.position.y + 1.9, vehicle.position.z - 4.6);
  const chaseLook = new Vec3(vehicle.position.x, vehicle.position.y + 0.85, vehicle.position.z);
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
  /** Rate-limited rider inputs: the demand from keys/touch, and what is actually applied. */
  let steerNow = 0;
  let throttleNow = 0;
  let brakeNow = 0;
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
  // Sound is opt-in and needs a gesture (autoplay policy): the SOUND button or M creates/resumes it.
  // Phase 20.4-20.7: the UTV on the sfx bus, the hillside's ambience (wind, rain on the track, birds,
  // crickets, snow damping) on the ambient bus, the woods' reverb on sfx.
  let sound: { mixer: AudioSystem; context: AudioContext; audio: VehicleAudio; ambience: EnvironmentSoundscape } | null = null;
  let soundOn = false;
  let userMuted = false;
  const soundButton = document.getElementById("offroad-sound");
  const setSound = (on: boolean): void => {
    if (on && !sound) {
      const Ctor = globalThis.AudioContext ?? (globalThis as typeof globalThis & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;
      const mixer = new AudioSystem({ context: new Ctor() });
      const context = mixer.context;
      const ambience = new EnvironmentSoundscape(context, mixer.bus("ambient").input, { volume: 0.45 });
      mixer.bus("sfx").add(ambience.reverb);
      // One cylinder, two strokes: firings per crank revolution, so it buzzes an octave above a
      // single-cylinder four-stroke, and the expansion chamber rings on the whine voice.
      sound = { mixer, context, audio: new VehicleAudio(vehicle, context, mixer.bus("sfx").input, { surfaceAt: soundSurfaceAt, volume: 0.5, cylinders: 1, strokes: 2 }), ambience };
    }
    soundOn = on;
    // Never chain behaviour behind these promises: headless autoplay can leave resume() pending.
    if (sound) void (on ? sound.context.resume() : sound.context.suspend()).catch(() => {});
    soundButton?.setAttribute("aria-pressed", String(on));
    if (soundButton) soundButton.textContent = on ? "SOUND ON" : "SOUND";
  };
  tap("offroad-sound", () => {
    userMuted = soundOn;
    setSound(!soundOn);
  });
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
  // Handlebars, not a steering wheel: ±45° of finger rotation is full lock on a quad, and the bars
  // snap back to centre harder than a wheel does (`returnRate` 1/s).
  const wheel = attachSteeringWheel(document.getElementById("offroad-wheel"), {
    maxAngle: 45,
    returnRate: 14,
    rim: document.getElementById("offroad-wheel-rim"),
  });
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
  vehicle.selectGear(0);
  const selectPosition = (position: "F" | "N" | "R"): boolean => {
    if (!userMuted && !soundOn) setSound(true);
    const ok = vehicle.selectGear(position === "F" ? 1 : position === "R" ? -1 : 0);
    if (ok) touch.setGear(position);
    return ok;
  };
  const onKeyDown = (event: KeyboardEvent): void => {
    keys.add(event.code);
    if (event.code === "KeyC" && !event.repeat) cycleCamera();
    if (event.code === "KeyP" && !event.repeat) {
      parkingBrake = !parkingBrake;
      touch.setPark(parkingBrake);
    }
    if (event.code === "KeyF" && !event.repeat) selectPosition("F");
    if (event.code === "KeyN" && !event.repeat) selectPosition("N");
    if (event.code === "KeyR" && !event.repeat) {
      const reverse = vehicle.gear >= 0;
      selectPosition(reverse ? "R" : "F");
    }
    if (event.code === "KeyT" && !event.repeat) resetToTrack();
    if (event.code === "KeyM" && !event.repeat) {
      userMuted = soundOn;
      setSound(!soundOn);
    }
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
    onGearSelect: (position) => selectPosition(position),
    onParkToggle: () => {
      parkingBrake = !parkingBrake;
      touch.setPark(parkingBrake);
    },
  });
  touch.setGear("N");

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
    controlsHint: "WASD / arrows ride · F / N / R gear · Space handbrake · P park · C camera (chase, rider, orbit) · T back on track · 1–5 weather (sun, overcast, rain, snow, mud) · M sound",
    camera: {
      target: new Vec3(vehicle.position.x, vehicle.position.y + 0.85, vehicle.position.z),
      distance: 7,
      minDistance: 2,
      maxDistance: 40,
      azimuth: vehicle.yaw + Math.PI,
      elevation: 0.3,
      groundHeight: heightAt,
      groundClearance: 0.8,
      keyboard: false,
    },
    followTarget: () => ({ x: vehicle.position.x, y: vehicle.position.y + 0.85, z: vehicle.position.z }),
    cameraOverride: () => {
      if (cameraMode === "orbit") return null;
      if (cameraMode === "free") return { eye: [freeEye.x, freeEye.y, freeEye.z], target: [freeTarget.x, freeTarget.y, freeTarget.z] };
      vehicle.writeRotation(rot);
      if (cameraMode === "cab") {
        // Rider's eye: on the seat, behind the bars, looking slightly down the trail.
        rot.rotateVector(tmp.set(quad.dims.riderEye[0], quad.dims.riderEye[1], quad.dims.riderEye[2]), tmp);
        rot.rotateVector(tmp2.set(0, -0.18, 10), tmp2);
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
      const throttleDemand = Math.max(keyThrottle, pad.throttle, gasPedal.value());
      const brakeDemand = Math.max(keyBrake, pad.brake, brakePedal.value());
      const steerDemand = Math.max(-1, Math.min(1, keySteer + pad.steer + wheel.value()));
      throttleNow = approach(throttleNow, throttleDemand, (throttleDemand > throttleNow ? THROTTLE_RISE : THROTTLE_FALL) * dt);
      brakeNow = approach(brakeNow, brakeDemand, (brakeDemand > brakeNow ? BRAKE_RISE : BRAKE_FALL) * dt);
      // Toward lock at handlebar speed, back to centre faster — the bars return themselves.
      steerNow = approach(steerNow, steerDemand, (Math.abs(steerDemand) > Math.abs(steerNow) ? STEER_RATE : STEER_RETURN) * dt);
      vehicle.input.throttle = throttleNow;
      vehicle.input.brake = brakeNow;
      vehicle.input.steer = steerNow;
      vehicle.input.handbrake = keys.has("Space") || handbrakeHeld ? 1 : 0;
      vehicle.input.parkingBrake = parkingBrake ? 1 : 0;
      timer.update(vehicle.position.x, vehicle.position.z, dt);
      if (sound && soundOn && sound.context.state === "running") {
        sound.audio.update(dt);
        sound.ambience.update(
          ambienceSoundInput(weather.state, weather.surface, { sunElevationDeg: cycle.elevationDeg, listenerYaw: cameraMode === "cab" ? vehicle.yaw : chaseYaw, reflectivity: 0.3 }),
          dt,
        );
      }

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
      // A 2 m machine wants a much tighter chase than the 4.5 m truck this demo used to carry: 4.6 m
      // back and 1.9 m up keeps the whole quad and the trail ahead of it in frame at 62°.
      const dist = 4.6;
      const tx = vehicle.position.x - Math.sin(chaseYaw) * dist;
      const tz = vehicle.position.z - Math.cos(chaseYaw) * dist;
      const ty = Math.max(vehicle.position.y + 1.9, heightAt(tx, tz) + 1.0);
      chaseEye.x += (tx - chaseEye.x) * k;
      chaseEye.y += (ty - chaseEye.y) * k;
      chaseEye.z += (tz - chaseEye.z) * k;
      chaseLook.set(vehicle.position.x + Math.sin(chaseYaw) * 2.4, vehicle.position.y + 0.85, vehicle.position.z + Math.cos(chaseYaw) * 2.4);
    },
    overlay(): string {
      const { lap, running, lapTime, lastLap, bestLap, progress } = timer.state;
      return (
        `OFF-ROAD HILL  lap ${Math.max(1, lap)}  ${running ? fmtTime(lapTime) : "drive through the gate to start"}\n` +
        `last ${fmtTime(lastLap)}  best ${fmtTime(bestLap)}  progress ${(progress * 100).toFixed(0)}%\n` +
        `speed ${(vehicle.speed * 3.6).toFixed(0)} km/h  ${Math.round(vehicle.rpm / 50) * 50} rpm  gear ${vehicle.gear === 0 ? "N" : vehicle.gear < 0 ? "R" : vehicle.gear}  camera ${cameraMode}\n` +
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
        sound: {
          enabled: soundOn,
          running: sound?.context.state === "running",
          engineHz: sound?.audio.levels.engineFrequency ?? 0,
          load: sound?.audio.state.load ?? 0,
          slip: sound?.audio.state.slip ?? 0,
          surface: sound ? (sound.audio.state.wheels.find((w) => w.inContact)?.surface ?? "air") : "air",
        },
      };
    },
    dispose(): void {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      for (const [t, type, f] of domListeners) t.removeEventListener(type, f);
      if (sound) {
        sound.audio.dispose();
        sound.ambience.dispose();
        void sound.mixer.dispose().catch(() => {});
        sound = null;
      }
      soundButton?.setAttribute("aria-pressed", "false");
      if (soundButton) soundButton.textContent = "SOUND";
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
