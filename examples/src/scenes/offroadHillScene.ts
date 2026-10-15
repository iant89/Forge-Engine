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
  sphereGeometrySource,
  tierValue,
  trackRibbonSource,
  trackTerrainGridSource,
  type DeviceTier,
  type Engine,
  type Entity,
  type GeometrySource,
  type TrackPlacement,
  type TrackProjection,
} from "@forge/engine";
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

export type OffroadCameraMode = "chase" | "cab" | "orbit";

export interface OffroadSceneOptions {
  deviceTier?: DeviceTier;
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
}

export interface OffroadSceneHandle extends DemoSceneHandle {
  setCameraMode(mode: OffroadCameraMode): void;
  /** Gate hook: put the car at arc length `s` (+ lateral offset) facing along the track, at rest. */
  placeAt(s: number, lateral?: number, yawOffset?: number): void;
  snapshot(): OffroadSnapshot;
}

/** The hillside before the track is cut: climbs to the north and falls away to the east, with knolls. */
function hillside(x: number, z: number): number {
  const climb = 0.085 * z + 0.04 * x;
  const knolls = 7 * fbm2(x / 70, z / 70, 3707, { octaves: 3 });
  const ridges = 2.2 * Math.sin(z / 23 + Math.sin(x / 41) * 1.3);
  return climb + knolls + ridges;
}

/** Transform-and-append a source into flat arrays (merging static props into one draw). */
function appendTransformed(
  into: { p: number[]; n: number[]; uv: number[]; i: number[] },
  src: GeometrySource,
  tx: number, ty: number, tz: number,
  sx: number, sy: number, sz: number,
  yaw: number, tiltX = 0, tiltZ = 0,
): void {
  const base = into.p.length / 3;
  const c = Math.cos(yaw), s = Math.sin(yaw);
  const pos = src.positions;
  const nrm = src.normals!;
  for (let k = 0; k < pos.length; k += 3) {
    let x = pos[k]! * sx, y = pos[k + 1]! * sy, z = pos[k + 2]! * sz;
    // Lean (small, for trunks): shear by height.
    x += tiltX * y;
    z += tiltZ * y;
    into.p.push(tx + x * c + z * s, ty + y, tz - x * s + z * c);
    let nx = nrm[k]! / sx, ny = nrm[k + 1]! / sy, nz = nrm[k + 2]! / sz;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l; ny /= l; nz /= l;
    into.n.push(nx * c + nz * s, ny, -nx * s + nz * c);
  }
  if (src.uvs) for (let k = 0; k < src.uvs.length; k++) into.uv.push(src.uvs[k]!);
  else for (let k = 0; k < pos.length / 3; k++) into.uv.push(0, 0);
  const idx = src.indices!;
  for (let k = 0; k < idx.length; k++) into.i.push(base + idx[k]!);
}

function flush(into: { p: number[]; n: number[]; uv: number[]; i: number[] }, label: string): GeometrySource {
  return {
    positions: new Float32Array(into.p),
    normals: new Float32Array(into.n),
    uvs: new Float32Array(into.uv),
    indices: new Uint32Array(into.i),
    label,
  };
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

  // ------------------------------------------------------------------ forest
  const density = tierValue(tier, { low: 0.4, medium: 0.7, high: 1 });
  const near = scatterAlongTrack(track, { seed: 7, lateralMin: track.bermOuterEdge + 3, lateralMax: 40, density: 0.038 * density, scaleMin: 0.8, scaleMax: 1.25, palettes: 6 });
  const back = scatterAlongTrack(track, { seed: 8, lateralMin: 40, lateralMax: 120, density: 0.008 * density, scaleMin: 1, scaleMax: 1.5, palettes: 6 });
  const brush = scatterAlongTrack(track, { seed: 9, lateralMin: track.bermOuterEdge + 0.8, lateralMax: track.bermOuterEdge + 6, density: 0.16 * density, scaleMin: 0.7, scaleMax: 1.8, palettes: 3 });
  const trunkSrc = cylinderGeometrySource({ radiusTop: 0.09, radiusBottom: 0.17, height: 1, radialSegments: 6 });
  const blobSrc = sphereGeometrySource({ radius: 1, widthSegments: tier === "low" ? 6 : 8, heightSegments: tier === "low" ? 4 : 6 });
  // Autumn mix from the photos: lots of yellow and gold, some orange and red, holdout greens.
  const canopyColors = [0xc9a227, 0xb7b03a, 0xd07a1e, 0xa83a1c, 0x5f7f2a, 0x8e9a32];
  const trunkBuf = { p: [] as number[], n: [] as number[], uv: [] as number[], i: [] as number[] };
  const canopyBufs = canopyColors.map(() => ({ p: [] as number[], n: [] as number[], uv: [] as number[], i: [] as number[] }));
  const placeTree = (t: TrackPlacement): void => {
    const h = (7 + t.random * 8) * t.scale;
    const lean = (t.random - 0.5) * 0.12;
    appendTransformed(trunkBuf, trunkSrc, t.x, t.y + h * 0.5 - 0.3, t.z, 1.2 * t.scale, h, 1.2 * t.scale, t.yaw, lean, 0);
    const buf = canopyBufs[t.palette]!;
    const crown = (2.2 + t.random * 1.6) * t.scale;
    const blobs = tier === "low" ? 2 : 4;
    for (let b = 0; b < blobs; b++) {
      const a = t.yaw + b * 2.1;
      const r = b === 0 ? 0 : crown * 0.55;
      const by = h * (0.72 + 0.1 * Math.sin(a * 3)) + (b === 0 ? crown * 0.3 : 0);
      const sc = crown * (b === 0 ? 1 : 0.75);
      appendTransformed(buf, blobSrc, t.x + Math.cos(a) * r + lean * by, t.y + by, t.z + Math.sin(a) * r, sc, sc * 0.8, sc, a);
    }
  };
  for (const t of near) placeTree(t);
  for (const t of back) placeTree(t);
  const trunkMat = mat(new Material({ label: "offroad.bark", color: 0x5b5148, roughness: 0.95, metallic: 0 }));
  add("trunks", geo(flush(trunkBuf, "offroad.trunks")), trunkMat, true);
  canopyColors.forEach((c, i) => {
    add(`canopy-${i}`, geo(flush(canopyBufs[i]!, `offroad.canopy-${i}`)), mat(new Material({ label: `offroad.canopy-${i}`, color: c, roughness: 0.88, metallic: 0 })), true);
  });
  // Greenery behind the berms (understory brush).
  const brushColors = [0x4f7a26, 0x6d8c2c, 0x8a8f2e];
  const brushBufs = brushColors.map(() => ({ p: [] as number[], n: [] as number[], uv: [] as number[], i: [] as number[] }));
  for (const b of brush) {
    const sc = 0.9 * b.scale;
    appendTransformed(brushBufs[b.palette]!, blobSrc, b.x, b.y + sc * 0.35, b.z, sc * 1.3, sc * 0.85, sc, b.yaw);
  }
  brushColors.forEach((c, i) => {
    add(`brush-${i}`, geo(flush(brushBufs[i]!, `offroad.brush-${i}`)), mat(new Material({ label: `offroad.brush-${i}`, color: c, roughness: 0.9, metallic: 0 })), true);
  });

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
  const camButton = document.getElementById("offroad-cam");
  const onCamButton = (event: Event): void => {
    event.preventDefault();
    cycleCamera();
  };
  camButton?.addEventListener("click", onCamButton);
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
    controlsHint: "WASD / arrows drive · Space handbrake · R forward/reverse · C chase / cab / orbit camera · T back on track",
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
      vehicle.input.throttle = Math.max(keyThrottle, pad.throttle);
      vehicle.input.brake = Math.max(keyBrake, pad.brake);
      vehicle.input.steer = Math.max(-1, Math.min(1, keySteer + pad.steer));
      vehicle.input.handbrake = keys.has("Space") ? 1 : 0;
      vehicle.input.parkingBrake = parkingBrake ? 1 : 0;
      timer.update(vehicle.position.x, vehicle.position.z, dt);

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
        `speed ${(vehicle.speed * 3.6).toFixed(0)} km/h  gear ${vehicle.gear === 0 ? "N" : vehicle.gear < 0 ? "R" : vehicle.gear}  camera ${cameraMode}`
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
      };
    },
    dispose(): void {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      camButton?.removeEventListener("click", onCamButton);
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
  return handle;
}
