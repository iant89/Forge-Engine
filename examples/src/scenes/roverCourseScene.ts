/**
 * Rover proving ground: the NASA Perseverance GLB on an asphalt loop laid over dirt, with a
 * cone slalom, gates and corner markers (all knockable), street lamps (real spotlights), a
 * barrier chicane, tire stacks and rock piles. Dusk is frozen at golden hour so the lamps read.
 *
 * The rover is the showcase's six-wheel electric build re-sprung for Earth gravity; the mast
 * and arm attach statically (stowed is the modelled pose). `VehicleSystem` is the only stepper —
 * `update` writes input, resolves barrier/rock collisions, and integrates knocked cones.
 */

import {
  Camera,
  DayNightCycle,
  ElectricMotor,
  type Engine,
  type Entity,
  Geometry,
  type GeometrySource,
  Light,
  Material,
  Quat,
  ReductionDrive,
  Renderable,
  Scene,
  Vec3,
  Vehicle,
  VehicleComponent,
  VehicleSystem,
  createBox,
  createCylinder,
  createPlane,
  createRock,
  createTorus,
  createVehicleConfig,
  flatGround,
} from "@forge/engine";
import type { DemoSceneHandle } from "./cubesScene.js";
import { attachVehicleTouch } from "../controls/vehicleTouch.js";
import { loadGlb, type GlbLoadProgress, type LoadedGlb } from "../assets/glb.js";

export interface RoverCourseHandle extends DemoSceneHandle {
  /** Test/gate snapshot: model state, cone score and rover pose. */
  courseState(): {
    modelLoaded: boolean;
    modelError: string | null;
    conesHit: number;
    coneCount: number;
    knocked: boolean[];
    speed: number;
    x: number;
    z: number;
    yaw: number;
  };
  /** Stand every cone back up and zero the counter (the R key calls this too). */
  resetCones(): void;
  /** Re-run the GLB fetch after a failure. */
  retryModelLoad(): void;
}

// ---------------------------------------------------------------- track layout

/** Straights run x in [-TRACK_HALF_STRAIGHT, TRACK_HALF_STRAIGHT] at z = ±TRACK_CORNER_R. */
const TRACK_HALF_STRAIGHT = 20;
const TRACK_CORNER_R = 10;
const TRACK_HALF_WIDTH = 3.5;
const TRACK_Y = 0.03;
const LINE_Y = 0.05;

const SPAWN_X = -18;
const SPAWN_Z = TRACK_CORNER_R;
const SPAWN_YAW = Math.PI / 2; // facing +X, down the home straight into the slalom

export interface TrackSample {
  x: number;
  z: number;
  tx: number;
  tz: number;
}

/**
 * Clockwise loop samples (position + unit tangent): straight A, east corner, straight B, west
 * corner. Exported so tests pin the loop the asphalt, lamps and cones are all laid out from.
 */
export function sampleTrackLoop(): TrackSample[] {
  const pts: TrackSample[] = [];
  const S = TRACK_HALF_STRAIGHT;
  const R = TRACK_CORNER_R;
  for (let x = -S; x <= S; x += 2) pts.push({ x, z: R, tx: 1, tz: 0 });
  const corner = (cx: number, fromDeg: number, toDeg: number): void => {
    const step = fromDeg > toDeg ? -4 : 4;
    for (let a = fromDeg; ; a += step) {
      const rad = (a * Math.PI) / 180;
      pts.push({
        x: cx + Math.cos(rad) * R,
        z: Math.sin(rad) * R,
        tx: Math.sin(rad) * Math.sign(toDeg - fromDeg) * -1,
        tz: -Math.cos(rad) * Math.sign(toDeg - fromDeg) * -1,
      });
      if (a === toDeg) break;
    }
  };
  corner(S, 90, -90);
  for (let x = S; x >= -S; x -= 2) pts.push({ x, z: -R, tx: -1, tz: 0 });
  corner(-S, -90, -270);
  // Segment joints duplicate (a straight's last point is the corner's first), as does the
  // wrap (corner W ends where straight A begins); drop them so no ribbon quad is degenerate.
  const deduped = pts.filter((p, i) => i === 0 || Math.hypot(p.x - pts[i - 1]!.x, p.z - pts[i - 1]!.z) > 1e-9);
  const first = deduped[0]!;
  const last = deduped[deduped.length - 1]!;
  if (Math.hypot(last.x - first.x, last.z - first.z) < 1e-9) deduped.pop();
  return deduped;
}

/**
 * Flat ribbon over the loop centreline. `lateralOffset` shifts across the track (positive is
 * inward — the loop runs clockwise), `halfWidth` is the ribbon half-width. Winding faces +Y.
 */
export function ribbonSource(samples: TrackSample[], lateralOffset: number, halfWidth: number, y: number): GeometrySource {
  const n = samples.length;
  const positions = new Float32Array(n * 2 * 3);
  const normals = new Float32Array(n * 2 * 3);
  const uvs = new Float32Array(n * 2 * 2);
  const indices = new Uint32Array(n * 6);
  let length = 0;
  for (let i = 0; i < n; i++) {
    const s = samples[i]!;
    const nx = s.tz;
    const nz = -s.tx;
    const lo = lateralOffset + halfWidth;
    const ro = lateralOffset - halfWidth;
    positions.set([s.x + nx * lo, y, s.z + nz * lo], i * 6);
    positions.set([s.x + nx * ro, y, s.z + nz * ro], i * 6 + 3);
    normals.set([0, 1, 0], i * 6);
    normals.set([0, 1, 0], i * 6 + 3);
    if (i > 0) {
      const p = samples[i - 1]!;
      length += Math.hypot(s.x - p.x, s.z - p.z);
    }
    uvs.set([0, length / 8], i * 4);
    uvs.set([1, length / 8], i * 4 + 2);
    const j = (i + 1) % n;
    indices.set([i * 2, i * 2 + 1, j * 2, i * 2 + 1, j * 2 + 1, j * 2], i * 6);
  }
  return { positions, normals, uvs, indices };
}

// ---------------------------------------------------------------- rover build (Earth-gravity twin of the showcase's)

const COURSE_WHEELS = [
  { name: "wheel_FL", x: -1.091, z: 1.095, steered: true, driven: true, handbrake: false },
  { name: "wheel_FR", x: 1.091, z: 1.095, steered: true, driven: true, handbrake: false },
  { name: "wheel_ML", x: -1.213, z: -0.09, steered: false, driven: true, handbrake: false },
  { name: "wheel_MR", x: 1.213, z: -0.09, steered: false, driven: true, handbrake: false },
  { name: "wheel_RL", x: -1.091, z: -1.165, steered: true, driven: true, handbrake: true },
  { name: "wheel_RR", x: 1.091, z: -1.165, steered: true, driven: true, handbrake: true },
] as const;

/** The Mars showcase's motor: 9.5 N·m / 1.5 kW, spread 1.5× in speed (≈2.63 m/s no-load). */
const COURSE_MOTOR = {
  peakTorque: 9.5,
  peakPower: 1500,
  ratedRpm: 1500,
  maxRpm: 5700,
  regenTorque: 4.2,
  dragTorque: 0.12,
  inertia: 0.02,
};

/** Cone spots [x, z]: 6 slalom, 6 gate, 8 corner markers. The scene and tests share this. */
function coneLayout(): [number, number][] {
  const spots: [number, number][] = [];
  for (let i = 0; i < 6; i++) spots.push([-12.5 + i * 5, SPAWN_Z + (i % 2 === 0 ? 1.6 : -1.6)]);
  for (const gx of [-10, 0, 10]) {
    spots.push([gx, -TRACK_CORNER_R - 2]);
    spots.push([gx, -TRACK_CORNER_R + 2]);
  }
  for (const cx of [TRACK_HALF_STRAIGHT, -TRACK_HALF_STRAIGHT]) {
    for (const deg of [60, 30, -30, -60]) {
      const rad = (deg * Math.PI) / 180;
      spots.push([cx + Math.sign(cx) * Math.cos(rad) * 7, Math.sin(rad) * 7]);
    }
  }
  return spots;
}
export const COURSE_CONES: [number, number][] = coneLayout();
/** Chicane barrier centres [x, z] (each spans ±1.1 m along X). */
export const COURSE_BARRIERS: [number, number][] = [[-7, -8.2], [1, -11.8], [8, -8.2]];
/** Tire-stack centres [x, z] outside the corners. */
export const COURSE_TIRE_STACKS: [number, number][] = [[33, 13], [33, -13], [-33, 13], [-33, -13]];

export function buildRoverCourseScene(engine: Engine): RoverCourseHandle {
  const gpu = engine.gpu;
  const scene = new Scene({ name: "rover-course" });
  scene.settings.hdr = true;
  scene.settings.exposure = 1.0;
  scene.settings.toneMapping = "aces";
  scene.settings.bloom.enabled = true;
  scene.settings.bloom.threshold = 1;
  scene.settings.bloom.intensity = 0.05;
  scene.settings.shadow.enabled = true;
  scene.settings.shadow.cascades = 3;
  scene.settings.shadow.distance = 120;
  scene.settings.shadow.mapSize = 2048;
  scene.setFog("height", { density: 0.003, heightFalloff: 0.08, heightBase: 0 });
  scene.setSky({ quality: "medium", sunDiscIntensity: 120 });

  const disposables: { dispose(): void }[] = [];
  const track = <T extends { dispose(): void }>(resource: T): T => {
    disposables.push(resource);
    return resource;
  };

  const place = (
    name: string,
    position: Vec3,
    geometry: Geometry,
    material: Material,
    castShadow = true,
  ): Entity => {
    const e = scene.createTransformedEntity(name, position);
    const r = new Renderable();
    r.geometry = geometry;
    r.material = material;
    r.castShadow = castShadow;
    r.receiveShadow = true;
    scene.world.addComponent(e.id, r);
    return e;
  };

  // ---------------------------------------------------------------- ground + track

  const dirtMaterial = track(new Material({ label: "course.dirt", color: 0x7a5c40, roughness: 0.96, metallic: 0 }));
  place("dirt", new Vec3(0, 0, 0), track(createPlane(gpu, { width: 400, depth: 400 })), dirtMaterial, false);

  const samples = sampleTrackLoop();
  const asphaltMaterial = track(new Material({ label: "course.asphalt", color: 0x33373b, roughness: 0.94, metallic: 0 }));
  place("track", new Vec3(0, 0, 0), track(Geometry.create(gpu, ribbonSource(samples, 0, TRACK_HALF_WIDTH, TRACK_Y))), asphaltMaterial, false);
  const lineMaterial = track(new Material({ label: "course.line", color: 0xe8e6df, roughness: 0.8, metallic: 0 }));
  const edgeOffset = TRACK_HALF_WIDTH - 0.2;
  place("line-inner", new Vec3(0, 0, 0), track(Geometry.create(gpu, ribbonSource(samples, edgeOffset, 0.09, LINE_Y))), lineMaterial, false);
  place("line-outer", new Vec3(0, 0, 0), track(Geometry.create(gpu, ribbonSource(samples, -edgeOffset, 0.09, LINE_Y))), lineMaterial, false);
  // Start/finish strip across the home straight (the loop runs along X here).
  place("start-strip", new Vec3(SPAWN_X, LINE_Y, SPAWN_Z), track(createPlane(gpu, { width: 0.7, depth: TRACK_HALF_WIDTH * 2 })), lineMaterial, false);

  // Start gantry: posts + beam + banner.
  const gantryMaterial = track(new Material({ label: "course.gantry", color: 0x46505c, roughness: 0.5, metallic: 0.6 }));
  const bannerMaterial = track(new Material({ label: "course.banner", color: 0x1f3a5f, roughness: 0.7, metallic: 0 }));
  const postGeo = track(createCylinder(gpu, { radiusTop: 0.12, radiusBottom: 0.14, height: 5.5, radialSegments: 12 }));
  place("gantry-post-l", new Vec3(SPAWN_X, 2.75, SPAWN_Z - 4.5), postGeo, gantryMaterial);
  place("gantry-post-r", new Vec3(SPAWN_X, 2.75, SPAWN_Z + 4.5), postGeo, gantryMaterial);
  place("gantry-beam", new Vec3(SPAWN_X, 5.5, SPAWN_Z), track(createBox(gpu, { width: 0.3, height: 0.5, depth: 9.6 })), gantryMaterial);
  place("gantry-banner", new Vec3(SPAWN_X, 4.85, SPAWN_Z), track(createBox(gpu, { width: 0.12, height: 0.9, depth: 6 })), bannerMaterial);

  // ---------------------------------------------------------------- street lamps (real spotlights)

  const lampPoleMaterial = track(new Material({ label: "course.lamp-pole", color: 0x3a4148, roughness: 0.55, metallic: 0.5 }));
  const lampHeadMaterial = track(new Material({ label: "course.lamp-head", color: 0x23272c, roughness: 0.5, metallic: 0.4 }));
  const lampLensMaterial = track(
    new Material({ label: "course.lamp-lens", color: 0x2a1f10, emissive: 0xffc37a, emissiveStrength: 3, roughness: 0.4, metallic: 0 }),
  );
  const poleGeo = track(createCylinder(gpu, { radiusTop: 0.08, radiusBottom: 0.11, height: 6, radialSegments: 10 }));
  const armGeo = track(createBox(gpu, { width: 0.12, height: 0.12, depth: 1.9 }));
  const headGeo = track(createBox(gpu, { width: 0.34, height: 0.14, depth: 0.8 }));
  const lensGeo = track(createBox(gpu, { width: 0.26, height: 0.05, depth: 0.6 }));
  const LAMP_COUNT = 8;
  for (let k = 0; k < LAMP_COUNT; k++) {
    const s = samples[Math.floor((k * samples.length) / LAMP_COUNT)]!;
    // (tz, -tx) is the inward normal on this clockwise loop, so the pole stands at
    // centreline − n×5.7 (outside the track) and the head reaches 1.5 m back toward it.
    const nx = s.tz;
    const nz = -s.tx;
    const px = s.x - nx * (TRACK_HALF_WIDTH + 2.2);
    const pz = s.z - nz * (TRACK_HALF_WIDTH + 2.2);
    const yaw = Math.atan2(s.x - px, s.z - pz);
    const lampQ = new Quat().setEulerComponents(0, yaw, 0);
    place(`lamp-pole-${k}`, new Vec3(px, 3, pz), poleGeo, lampPoleMaterial);
    const arm = place(
      `lamp-arm-${k}`,
      new Vec3(px + Math.sin(yaw) * 0.95, 5.9, pz + Math.cos(yaw) * 0.95),
      armGeo,
      lampPoleMaterial,
    );
    arm.transform.rotation = lampQ;
    const hx = px + Math.sin(yaw) * 1.5;
    const hz = pz + Math.cos(yaw) * 1.5;
    const head = place(`lamp-head-${k}`, new Vec3(hx, 5.9, hz), headGeo, lampHeadMaterial);
    head.transform.rotation = lampQ;
    const lens = scene.createTransformedEntity(`lamp-lens-${k}`, new Vec3(0, -0.09, 0));
    head.addChild(lens);
    lens.transform.position = new Vec3(0, -0.09, 0);
    const lensRenderable = new Renderable();
    lensRenderable.geometry = lensGeo;
    lensRenderable.material = lampLensMaterial;
    lensRenderable.castShadow = false;
    scene.world.addComponent(lens.id, lensRenderable);
    // The spot aims at the centreline from the head — offset along the track so the aim is
    // never straight down (degenerate for lookAt).
    const spotEntity = scene.createTransformedEntity(`lamp-spot-${k}`, new Vec3(hx, 5.85, hz));
    const spot = new Light();
    spot.kind = "spot";
    spot.range = 18;
    spot.intensity = 60;
    spot.innerCone = 0.93;
    spot.outerCone = 0.78;
    spot.castShadow = false;
    spot.setColor(1.0, 0.8, 0.58);
    scene.world.addComponent(spotEntity.id, spot);
    spotEntity.transform.lookAt(new Vec3(s.x + s.tx * 0.4, 0, s.z + s.tz * 0.4));
  }

  // ---------------------------------------------------------------- cones (knockable)

  const coneBodyGeo = track(createCylinder(gpu, { radiusTop: 0.03, radiusBottom: 0.16, height: 0.55, radialSegments: 20 }));
  const coneBaseGeo = track(createBox(gpu, { width: 0.34, height: 0.05, depth: 0.34 }));
  const coneStripeGeo = track(createCylinder(gpu, { radiusTop: 0.076, radiusBottom: 0.105, height: 0.12, radialSegments: 20 }));
  const coneOrange = track(new Material({ label: "course.cone", color: 0xe85d10, roughness: 0.55, metallic: 0 }));
  const coneBaseMat = track(new Material({ label: "course.cone-base", color: 0xb84408, roughness: 0.7, metallic: 0 }));
  const coneWhite = track(new Material({ label: "course.cone-stripe", color: 0xf2f0ea, roughness: 0.5, metallic: 0 }));

  interface ConeState {
    root: Entity;
    homeX: number;
    homeZ: number;
    knocked: boolean;
    vx: number;
    vz: number;
    slideX: number;
    slideZ: number;
    tip: number;
    tipAxis: Vec3;
  }
  const cones: ConeState[] = [];
  const addCone = (x: number, z: number): void => {
    const root = scene.createTransformedEntity(`cone-${cones.length}`, new Vec3(x, 0, z));
    const body = scene.createTransformedEntity(`cone-${cones.length}-body`, new Vec3(0, 0.325, 0));
    root.addChild(body);
    body.transform.position = new Vec3(0, 0.325, 0);
    const bodyR = new Renderable();
    bodyR.geometry = coneBodyGeo;
    bodyR.material = coneOrange;
    bodyR.castShadow = true;
    bodyR.receiveShadow = true;
    scene.world.addComponent(body.id, bodyR);
    const base = scene.createTransformedEntity(`cone-${cones.length}-base`, new Vec3(0, 0.025, 0));
    root.addChild(base);
    base.transform.position = new Vec3(0, 0.025, 0);
    const baseR = new Renderable();
    baseR.geometry = coneBaseGeo;
    baseR.material = coneBaseMat;
    baseR.castShadow = true;
    baseR.receiveShadow = true;
    scene.world.addComponent(base.id, baseR);
    const stripe = scene.createTransformedEntity(`cone-${cones.length}-stripe`, new Vec3(0, 0.36, 0));
    root.addChild(stripe);
    stripe.transform.position = new Vec3(0, 0.36, 0);
    const stripeR = new Renderable();
    stripeR.geometry = coneStripeGeo;
    stripeR.material = coneWhite;
    stripeR.castShadow = false;
    stripeR.receiveShadow = true;
    scene.world.addComponent(stripe.id, stripeR);
    cones.push({ root, homeX: x, homeZ: z, knocked: false, vx: 0, vz: 0, slideX: 0, slideZ: 0, tip: 0, tipAxis: new Vec3(1, 0, 0) });
  };
  // Slalom down the home straight (drive +X from spawn, weave ±), gates across the back
  // straight, corner apex markers on the inner edge.
  for (const [x, z] of COURSE_CONES) addCone(x, z);

  // ---------------------------------------------------------------- obstacles: chicane barriers, tire stacks, rocks

  const barrierGeo = track(createBox(gpu, { width: 2.2, height: 0.8, depth: 0.55 }));
  const barrierStripeGeo = track(createBox(gpu, { width: 2.2, height: 0.18, depth: 0.57 }));
  const barrierMat = track(new Material({ label: "course.barrier", color: 0xb5b0a6, roughness: 0.85, metallic: 0 }));
  const barrierStripeMat = track(new Material({ label: "course.barrier-stripe", color: 0xe85d10, roughness: 0.6, metallic: 0 }));
  interface BarrierSeg {
    ax: number;
    az: number;
    bx: number;
    bz: number;
  }
  const barrierSegs: BarrierSeg[] = [];
  const addBarrier = (x: number, z: number): void => {
    place(`barrier-${barrierSegs.length}`, new Vec3(x, 0.4, z), barrierGeo, barrierMat);
    place(`barrier-stripe-${barrierSegs.length}`, new Vec3(x, 0.71, z), barrierStripeGeo, barrierStripeMat);
    barrierSegs.push({ ax: x - 1.1, az: z, bx: x + 1.1, bz: z });
  };
  // Chicane S across the back straight (drive -X: pass left of the first, right of the next…).
  for (const [x, z] of COURSE_BARRIERS) addBarrier(x, z);

  const tireGeo = track(createTorus(gpu, { radius: 0.33, tube: 0.14 }));
  const tireMat = track(new Material({ label: "course.tire", color: 0x1f2124, roughness: 0.9, metallic: 0 }));
  const tireWhiteMat = track(new Material({ label: "course.tire-white", color: 0xd8d8d8, roughness: 0.7, metallic: 0 }));
  interface Blocker {
    x: number;
    z: number;
    r: number;
  }
  const blockers: Blocker[] = [];
  for (const [i, [tx, tz]] of COURSE_TIRE_STACKS.entries()) {
    place(`tires-${i}-0`, new Vec3(tx, 0.14, tz), tireGeo, tireMat);
    place(`tires-${i}-1`, new Vec3(tx, 0.42, tz), tireGeo, tireWhiteMat);
    place(`tires-${i}-2`, new Vec3(tx, 0.7, tz), tireGeo, tireMat);
    blockers.push({ x: tx, z: tz, r: 0.55 });
  }

  const rockMat = track(new Material({ label: "course.rock", color: 0x6e6259, roughness: 0.95, metallic: 0 }));
  const rockGeos = [
    track(createRock(gpu, { radius: 0.7, seed: 11, flatten: 0.25 })),
    track(createRock(gpu, { radius: 0.5, seed: 23, flatten: 0.3 })),
    track(createRock(gpu, { radius: 0.9, seed: 37, flatten: 0.2 })),
  ];
  const rockClusters: [number, number, number][] = [
    [0, 0, 0],
    [1.4, 0.6, 1],
    [-1.1, 0.9, 2],
    [0.3, -1.3, 1],
    [-8, 3, 2],
    [-6.7, 3.8, 0],
    [-8.9, 1.9, 1],
    [7, -4, 1],
    [8.3, -3.1, 2],
    [6.2, -5.2, 0],
  ];
  for (const [i, [rx, rz, g]] of rockClusters.entries()) {
    const e = place(`rock-${i}`, new Vec3(rx, 0.1, rz), rockGeos[g]!, rockMat);
    e.transform.rotation = new Quat().setEulerComponents(0, i * 1.7, 0);
    blockers.push({ x: rx, z: rz, r: 0.75 });
  }

  // ---------------------------------------------------------------- rover vehicle

  const ground = flatGround(0);
  const motor = new ElectricMotor({ ...COURSE_MOTOR });
  const springRate = (1025 * 9.81) / (6 * 0.05); // same ~5 cm sag as Mars, re-sprung for Earth
  const config = {
    ...createVehicleConfig({
      mass: 1025,
      gravity: 9.81,
      mu: 1.4,
      wheelRadius: 0.264,
      wheelbase: 2.26,
      track: 2.18,
      cgToFront: 1.095,
      cgHeight: 0.54,
      longitudinal: { B: 14, C: 1.65, E: 0.97 },
      lateral: { B: 12, C: 1.3, E: 0.97 },
      springRate,
      damperRate: 2 * Math.sqrt(springRate * (1025 / 6)) * 0.55,
      aero: null,
      maxBrakeTorque: 4200,
      absEnabled: false,
      rollingResistance: 0.035,
      engine: motor,
      transmission: new ReductionDrive(60),
    }),
    wheels: COURSE_WHEELS.map((w) => ({
      x: w.x,
      z: w.z,
      steered: w.steered,
      driven: w.driven,
      handbrake: w.handbrake,
    })),
  };
  config.suspensionRest = 0.32;
  config.suspensionTravel = 0.16;
  config.maxSteerAngle = 0.62;
  const vehicle = new Vehicle(config);
  vehicle.position.set(SPAWN_X, 0, SPAWN_Z);
  vehicle.yaw = SPAWN_YAW;
  vehicle.placeOnGround(ground);
  let startupBrake = true;
  vehicle.input.brake = 1;
  vehicle.input.handbrake = 1;
  // Local Y that puts the model's ground plane on the dirt at equilibrium.
  const bodyOffsetY = 0 - vehicle.position.y;

  scene.world.registerSystem(new VehicleSystem());

  const chassis = scene.createTransformedEntity(
    "rover-chassis",
    new Vec3(vehicle.position.x, vehicle.position.y, vehicle.position.z),
  );
  const wheelRoots: Entity[] = [];
  const wheelIds: number[] = [];
  for (let i = 0; i < COURSE_WHEELS.length; i++) {
    const wheel = scene.createTransformedEntity(
      `rover-${COURSE_WHEELS[i]!.name}`,
      new Vec3(vehicle.position.x, vehicle.position.y, vehicle.position.z),
    );
    wheelRoots.push(wheel);
    wheelIds.push(wheel.id);
  }
  const component = new VehicleComponent(vehicle, ground);
  component.wheelEntities = wheelIds;
  chassis.add(component);

  // ---------------------------------------------------------------- GLB attach (mast/arm static — stowed is the modelled pose)

  let modelLoaded = false;
  let modelError: string | null = null;
  let modelProgress: GlbLoadProgress | null = null;
  let loadAttempt = 0;
  let loaded: LoadedGlb | null = null;
  let disposed = false;

  const attachPart = (parent: Entity, name: string, position: Vec3, part: { geometry: Geometry; material: Material }): void => {
    const child = scene.createTransformedEntity(name, position);
    parent.addChild(child);
    child.transform.position = position;
    const renderable = new Renderable();
    renderable.geometry = part.geometry;
    renderable.material = part.material;
    renderable.castShadow = true;
    renderable.receiveShadow = true;
    scene.world.addComponent(child.id, renderable);
  };

  const attachGlb = (glb: LoadedGlb): void => {
    for (const part of glb.body) {
      attachPart(chassis, `rover-body-${part.name}`, new Vec3(0, bodyOffsetY, 0), part);
    }
    const byName = new Map(glb.wheels.map((w) => [w.name, w]));
    for (let i = 0; i < COURSE_WHEELS.length; i++) {
      const spec = COURSE_WHEELS[i]!;
      const root = wheelRoots[i]!;
      const wheel = byName.get(spec.name);
      if (!wheel) continue;
      for (const part of wheel.parts) attachPart(root, `rover-${spec.name}-part`, new Vec3(0, 0, 0), part);
    }
    // Mast: same three-tier pivots as the showcase, frozen in the stowed pose.
    if (glb.mast && glb.mast.parts.length > 0 && glb.mast.lowerParts.length > 0) {
      const [px, py, pz] = glb.mast.pivot;
      const [jx, jy, jz] = glb.mast.joint;
      const [hx, hy, hz] = glb.mast.headPivot;
      const lower = scene.createTransformedEntity("rover-mast-lower", new Vec3(px, py + bodyOffsetY, pz));
      chassis.addChild(lower);
      lower.transform.position = new Vec3(px, py + bodyOffsetY, pz);
      for (const part of glb.mast.lowerParts) attachPart(lower, `rover-${part.name}`, new Vec3(0, 0, 0), part);
      const upper = scene.createTransformedEntity("rover-mast-upper", new Vec3(jx, jy, jz));
      lower.addChild(upper);
      upper.transform.position = new Vec3(jx, jy, jz);
      const upperOffset = scene.createTransformedEntity("rover-mast-upper-offset", new Vec3(-jx, -jy, -jz));
      upper.addChild(upperOffset);
      upperOffset.transform.position = new Vec3(-jx, -jy, -jz);
      for (const part of glb.mast.upperParts) attachPart(upperOffset, `rover-${part.name}`, new Vec3(0, 0, 0), part);
      const head = scene.createTransformedEntity("rover-mast-head", new Vec3(hx - jx, hy - jy, hz - jz));
      upper.addChild(head);
      head.transform.position = new Vec3(hx - jx, hy - jy, hz - jz);
      const headOffset = scene.createTransformedEntity("rover-mast-head-offset", new Vec3(-hx, -hy, -hz));
      head.addChild(headOffset);
      headOffset.transform.position = new Vec3(-hx, -hy, -hz);
      for (const part of glb.mast.headParts) attachPart(headOffset, `rover-${part.name}`, new Vec3(0, 0, 0), part);
    }
    // Arm: nest one pivot per joint like the GLB chain; identity rotations hold the fold.
    if (glb.arm && glb.arm.joints.length > 0) {
      let parent: Entity = chassis;
      let first = true;
      for (const joint of glb.arm.joints) {
        const [ox, oy, oz] = joint.offset;
        const pivot = scene.createTransformedEntity(
          `rover-${joint.name}`,
          new Vec3(ox, oy + (first ? bodyOffsetY : 0), oz),
        );
        parent.addChild(pivot);
        pivot.transform.position = new Vec3(ox, oy + (first ? bodyOffsetY : 0), oz);
        first = false;
        for (const part of joint.parts) attachPart(pivot, `rover-${part.name}`, new Vec3(0, 0, 0), part);
        parent = pivot;
      }
    }
  };

  const modelUrl = new URL("../../assets/Perseverance.glb", import.meta.url).href;
  const startModelLoad = (): void => {
    const attempt = ++loadAttempt;
    modelLoaded = false;
    modelError = null;
    modelProgress = { phase: "fetch", receivedBytes: 0, totalBytes: null };
    loadGlb(gpu, modelUrl, (progress) => {
      if (attempt === loadAttempt) modelProgress = progress;
    })
      .then((glb) => {
        if (attempt !== loadAttempt || disposed) {
          glb.dispose();
          return;
        }
        loaded = glb;
        modelLoaded = true;
        attachGlb(glb);
      })
      .catch((error: unknown) => {
        if (attempt !== loadAttempt) return;
        modelError = error instanceof Error ? error.message : String(error);
      });
  };
  const retryModelLoad = (): void => {
    if (!disposed) startModelLoad();
  };
  startModelLoad();

  // ---------------------------------------------------------------- sky, sun, camera

  const sunEntity = scene.createTransformedEntity("sun", new Vec3(0, 50, 0));
  const sun = new Light();
  sun.kind = "directional";
  sun.castShadow = true;
  sun.shadowNormalBias = 0.8;
  scene.world.addComponent(sunEntity.id, sun);
  // Golden hour, frozen: June 21, 47°N, ~7:18 pm local solar time. The cycle drives the sun,
  // ambient, fog and sky from that instant; timeScale 0 holds it there all session.
  const cycle = new DayNightCycle({
    name: "dayNight",
    latitude: 47,
    dayOfYear: 172,
    timeOfDay: 19.3,
    timeScale: 0,
    sun,
    sunIntensity: 4.2,
    ambientScale: 0.6,
    driveAmbient: true,
    driveFog: true,
    driveSky: true,
  });
  scene.add(cycle);
  cycle.apply();

  const cameraEntity = scene.createTransformedEntity("camera", new Vec3(SPAWN_X - 8, 4.5, SPAWN_Z - 6));
  const camera = new Camera();
  camera.fovY = Math.PI / 3;
  camera.near = 0.1;
  camera.far = 900;
  scene.world.addComponent(cameraEntity.id, camera);
  cameraEntity.transform.lookAt(new Vec3(SPAWN_X, 1, SPAWN_Z));

  // ---------------------------------------------------------------- input

  const keys = new Set<string>();
  const onKeyDown = (event: KeyboardEvent): void => {
    keys.add(event.code);
    if (event.code === "KeyR" && !event.repeat) resetCones();
    if (event.code === "Space" || event.code.startsWith("Arrow")) event.preventDefault();
  };
  const onKeyUp = (event: KeyboardEvent): void => {
    keys.delete(event.code);
  };
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
  const touch = attachVehicleTouch(document.getElementById("vehicle-touch"), {});

  // ---------------------------------------------------------------- cones + collisions

  let conesHit = 0;
  const scratchQ = new Quat();

  function resetCones(): void {
    conesHit = 0;
    for (const cone of cones) {
      cone.knocked = false;
      cone.vx = 0;
      cone.vz = 0;
      cone.slideX = 0;
      cone.slideZ = 0;
      cone.tip = 0;
      cone.root.transform.position = new Vec3(cone.homeX, 0, cone.homeZ);
      cone.root.transform.rotation = scratchQ.setEulerComponents(0, 0, 0);
    }
  }

  /** Push the rover centre out of barrier capsules and blocker circles, sliding along them. */
  const collideCourse = (): void => {
    const pushOut = (cx: number, cz: number, radius: number): void => {
      const dx = vehicle.position.x - cx;
      const dz = vehicle.position.z - cz;
      const d = Math.hypot(dx, dz);
      if (!(d < radius) || d < 1e-6) return;
      const nx = dx / d;
      const nz = dz / d;
      vehicle.position.x = cx + nx * radius;
      vehicle.position.z = cz + nz * radius;
      const into = vehicle.velocity.x * nx + vehicle.velocity.z * nz;
      if (into < 0) {
        vehicle.velocity.x -= nx * into;
        vehicle.velocity.z -= nz * into;
      }
    };
    const ROVER_BODY_R = 1.35;
    for (const seg of barrierSegs) {
      const dx = seg.bx - seg.ax;
      const dz = seg.bz - seg.az;
      const u = Math.min(1, Math.max(0, ((vehicle.position.x - seg.ax) * dx + (vehicle.position.z - seg.az) * dz) / (dx * dx + dz * dz)));
      pushOut(seg.ax + u * dx, seg.az + u * dz, ROVER_BODY_R + 0.3);
    }
    for (const b of blockers) pushOut(b.x, b.z, b.r + 1.1);
  };

  const stepCones = (dt: number): void => {
    const sinYaw = Math.sin(vehicle.yaw);
    const cosYaw = Math.cos(vehicle.yaw);
    for (const cone of cones) {
      if (!cone.knocked) {
        // Rover-frame rect test (half extents 1.30 × 1.50): threading the slalom cleanly
        // must be possible, so a plain radius check would clip both sides at once.
        const cx = cone.homeX - vehicle.position.x;
        const cz = cone.homeZ - vehicle.position.z;
        const lx = cx * cosYaw - cz * sinYaw;
        const lz = cx * sinYaw + cz * cosYaw;
        if (Math.abs(lx) < 1.3 && Math.abs(lz) < 1.5) {
          cone.knocked = true;
          conesHit++;
          const d = Math.max(0.3, Math.hypot(cx, cz));
          const dx = cx / d;
          const dz = cz / d;
          cone.vx = vehicle.velocity.x * 0.9 + dx * 2.0;
          cone.vz = vehicle.velocity.z * 0.9 + dz * 2.0;
          cone.tipAxis.set(dz, 0, -dx);
        }
      } else {
        cone.slideX += cone.vx * dt;
        cone.slideZ += cone.vz * dt;
        const friction = Math.max(0, 1 - 3 * dt);
        cone.vx *= friction;
        cone.vz *= friction;
        cone.tip = Math.min(1, cone.tip + dt / 0.45);
        const angle = cone.tip * 1.35;
        cone.root.transform.position = new Vec3(
          cone.homeX + cone.slideX,
          0.165 * Math.sin(angle),
          cone.homeZ + cone.slideZ,
        );
        cone.root.transform.rotation = scratchQ.setAxisAngle(cone.tipAxis, angle);
      }
    }
  };

  return {
    scene,
    cameraEntity,
    controlsHint: "WASD / arrows drive · Space handbrake · R resets cones · Drag to orbit · Scroll zoom · camera follows",
    camera: {
      target: new Vec3(SPAWN_X, 1.6, SPAWN_Z),
      distance: 7,
      minDistance: 3,
      maxDistance: 60,
      azimuth: 0.55,
      elevation: 0.48,
      groundHeight: () => 0,
      groundClearance: 0.5,
      keyboard: false,
    },
    followTarget: () => ({ x: vehicle.position.x, y: vehicle.position.y + 0.55, z: vehicle.position.z }),
    update(dt: number): void {
      const padSample = touch.sample();
      const keyThrottle = keys.has("KeyW") || keys.has("ArrowUp") ? 1 : 0;
      const keyBrake = keys.has("KeyS") || keys.has("ArrowDown") ? 1 : 0;
      const keySteer =
        (keys.has("KeyD") || keys.has("ArrowRight") ? 1 : 0) - (keys.has("KeyA") || keys.has("ArrowLeft") ? 1 : 0);
      const throttle = Math.max(keyThrottle, padSample.throttle);
      if (throttle > 0.01) startupBrake = false;
      vehicle.input.throttle = throttle;
      vehicle.input.brake = Math.max(keyBrake, padSample.brake, startupBrake ? 1 : 0);
      vehicle.input.steer = Math.max(-1, Math.min(1, keySteer + padSample.steer));
      vehicle.input.handbrake = keys.has("Space") || startupBrake ? 1 : 0;
      collideCourse();
      stepCones(dt);
    },
    overlay(): string {
      const mb = (bytes: number): string => (bytes / 1048576).toFixed(1);
      const model = modelLoaded
        ? "GLB ok"
        : modelError
          ? `GLB failed: ${modelError}`
          : modelProgress?.phase === "fetch" && modelProgress.totalBytes
            ? `GLB ${mb(modelProgress.receivedBytes)}/${mb(modelProgress.totalBytes)} MB`
            : `GLB ${modelProgress?.phase ?? "loading"}…`;
      return (
        `rover course · Perseverance 6/6 · ${model} · dusk ${cycle.clockText} frozen\n` +
        `speed ${(vehicle.speed * 3.6).toFixed(1)} km/h  cones hit ${conesHit}/${cones.length} · R resets cones\n` +
        `pos ${vehicle.position.x.toFixed(1)}, ${vehicle.position.y.toFixed(1)}, ${vehicle.position.z.toFixed(1)}  NASA/JPL-Caltech (public domain)`
      );
    },
    vehicleState: () => ({
      speed: vehicle.speed,
      rpm: vehicle.rpm,
      gear: vehicle.gear,
      x: vehicle.position.x,
      y: vehicle.position.y,
      z: vehicle.position.z,
    }),
    courseState: () => ({
      modelLoaded,
      modelError,
      conesHit,
      coneCount: cones.length,
      knocked: cones.map((c) => c.knocked),
      speed: vehicle.speed,
      x: vehicle.position.x,
      z: vehicle.position.z,
      yaw: vehicle.yaw,
    }),
    resetCones,
    retryModelLoad,
    dispose(): void {
      disposed = true;
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      touch.dispose();
      keys.clear();
      loaded?.dispose();
      for (const resource of disposables) resource.dispose();
      scene.dispose();
    },
  };
}
