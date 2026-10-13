/**
 * Shared Mars rover building blocks for the Mars Showcase and Mars Dust Storm Survival scenes.
 *
 * Factored out of `marsShowcaseScene.ts` without changing its behaviour (fe-16, captain decision
 * D7): the six-wheel electric Perseverance build, the streamed Mars terrain + layered material,
 * the portrait-safe chase framing (fe-15 values), keyboard + touch drive input, and the static
 * GLB attach. Each helper returns exactly what the showcase built inline before, so the showcase
 * gates keep pinning the same rover, terrain and camera.
 */

import {
  Color,
  ElectricMotor,
  type Entity,
  type GraphicsDevice,
  type GroundQuery,
  LayeredTerrainMaterial,
  type Material,
  type MarsTerrainStage,
  type Geometry,
  ReductionDrive,
  Renderable,
  type Scene,
  TerrainWorld,
  Vec3,
  Vehicle,
  adviseMarsTile,
  createMarsPipeline,
  createVehicleConfig,
  marsSurfaceLayers,
} from "@forge/engine";
import type { OrbitCameraSetup } from "../controls/orbitControls.js";
import type { VehicleTouchAxes } from "../controls/vehicleTouch.js";
import type { LoadedGlb } from "../assets/glb.js";
import { createMarsSurfaceTextures, disposePbrTextureSet, type PbrTextureSet } from "../textures/procedural.js";

// ---------------------------------------------------------------- chase camera

/**
 * Chase-cam framing tuned so the rover fills a portrait (iPhone) frame with terrain underfoot.
 * Prior values (distance 8.5 / elevation 0.28 / look-at CG+1.35) put the look-at near the mast tip,
 * so on tall FOV-Y viewports the chassis sat in the lower third and read as "lost in the haze"
 * behind on-screen controls — desktop landscape still looked fine, which is why fe-13 screenshots
 * passed while iPhone Safari did not.
 */
export const MARS_CHASE_DISTANCE = 6;
export const MARS_CHASE_MIN_DISTANCE = 3;
export const MARS_CHASE_AZIMUTH = 0.55;
export const MARS_CHASE_ELEVATION = 0.48;
/** Metres above the vehicle CG — mid-chassis, not the remote-sensing mast. */
export const MARS_CHASE_LOOK_OFFSET_Y = 0.55;
export const MARS_CHASE_GROUND_CLEARANCE = 0.5;

/** Orbit setup for the rover chase framing, starting on `target` (vehicle CG + look offset). */
export function marsChaseCamera(target: Vec3, groundHeight: (x: number, z: number) => number, maxDistance = 120): OrbitCameraSetup {
  return {
    target,
    // Closer + higher elevation keeps the chassis in the middle of a portrait FOV-Y frame with
    // terrain underfoot; users can still zoom out for a wider valley view.
    distance: MARS_CHASE_DISTANCE,
    minDistance: MARS_CHASE_MIN_DISTANCE,
    maxDistance,
    azimuth: MARS_CHASE_AZIMUTH,
    elevation: MARS_CHASE_ELEVATION,
    // Must stay below CHASE_LOOK_OFFSET_Y + hang so the surface clamp cannot hoist the look-at
    // above the chassis (that tip-over-rover-into-haze bug returned whenever clearance was 2 m).
    groundClearance: MARS_CHASE_GROUND_CLEARANCE,
    groundHeight,
    keyboard: false,
  };
}

/** `followTarget` for the chase framing: vehicle CG + mid-chassis offset. */
export function marsChaseFollow(vehicle: Vehicle): () => { x: number; y: number; z: number } {
  return () => ({
    x: vehicle.position.x,
    y: vehicle.position.y + MARS_CHASE_LOOK_OFFSET_Y,
    z: vehicle.position.z,
  });
}

// ---------------------------------------------------------------- rover

/**
 * Hub centres measured from the converted GLB (`scripts/convert-perseverance.mjs` prints them):
 * front/rear track 2.18 m, middle axle slightly wider, radius 0.264 m — the real Perseverance
 * geometry. Front and rear axles steer (the middle pair is fixed), all six are driven.
 */
export const MARS_ROVER_WHEELS = [
  { name: "wheel_FL", x: -1.091, z: 1.095, steered: true, driven: true, handbrake: false },
  { name: "wheel_FR", x: 1.091, z: 1.095, steered: true, driven: true, handbrake: false },
  { name: "wheel_ML", x: -1.213, z: -0.09, steered: false, driven: true, handbrake: false },
  { name: "wheel_MR", x: 1.213, z: -0.09, steered: false, driven: true, handbrake: false },
  { name: "wheel_RL", x: -1.091, z: -1.165, steered: true, driven: true, handbrake: true },
  { name: "wheel_RR", x: 1.091, z: -1.165, steered: true, driven: true, handbrake: true },
] as const;

export const MARS_WHEEL_RADIUS = 0.264;
/** Pristine suspension rest length; suspension wear sags it up to 30% shorter (visible squat). */
export const MARS_BASE_SUSPENSION_REST = 0.32;
const WHEEL_SPRING_RATE = (1025 * 3.72) / (6 * 0.05); // ~5 cm static sag across six wheels

/**
 * Traction constants the rover build below consumes. The gentle drive tune and regolith rolling
 * resistance keep acceleration and loaded speed down; grouser grip is retained.
 *
 * The speed envelope is the original gentle tune scaled 1.5× in speed (the reported rover was
 * "too slow"): same 9.5 N·m peak torque, so the launch feels unchanged, but the base speed, the
 * power cap and the no-load speed are all 50% higher — ≈2.4 m/s loaded instead of ≈1.6 m/s.
 */
export const MARS_ROVER_TRACTION = {
  /** Stall torque (N·m). 9.5 N·m through the 60:1 reduction ≈ 570 N·m before losses. */
  peakTorque: 9.5,
  /** Field-weakening power cap (W): 1.5× the original tune, continuous with the base speed. */
  peakPower: 1500,
  /** Base speed (rpm): constant torque below, constant power above. 1500 rpm ≈ 0.69 m/s. */
  ratedRpm: 1500,
  /** Tire/soil friction. 1.4 ≈ chevron-grouser wheels biting into regolith. */
  mu: 1.4,
  /** Rolling resistance of regolith/sand, restored with the original drive tune. */
  rollingResistance: 0.06,
  /** Stiffer-than-default longitudinal curve (default B:10): grousers build force fast. */
  longitudinal: { B: 14, C: 1.65, E: 0.97 },
  /** Stiffer-than-default lateral curve (default B:8.5): holds to large slip angles. */
  lateral: { B: 12, C: 1.3, E: 0.97 },
};

/**
 * Electric traction — the real rovers are battery-electric, and the old combustion defaults
 * (340 N·m through a 5-speed gearbox) geared the 1025 kg rover past 200 km/h equivalent, which
 * is the "way too fast, wheels fly off at hill crests" report. A ~1.5 kW motor behind a 60:1
 * reduction gives ≈513 N·m at the wheels after losses (≈1943 N peak tractive force), and
 * the motor's no-load speed caps the rover at ≈2.63 m/s ≈ 9.5 km/h (`maxRpm` is 1.5× the
 * original 3800 so the loaded top speed rises 50%, from ≈1.6 m/s to ≈2.4 m/s).
 * `regenTorque` blends ≈859 N of regenerative braking in ahead of the friction pads after
 * losses (see `ElectricMotor`).
 */
const ROVER_MOTOR = {
  peakTorque: MARS_ROVER_TRACTION.peakTorque,
  peakPower: MARS_ROVER_TRACTION.peakPower,
  ratedRpm: MARS_ROVER_TRACTION.ratedRpm,
  maxRpm: 5700,
  regenTorque: 4.2,
  dragTorque: 0.12,
  inertia: 0.02,
};
export const MARS_ROVER_REDUCTION = 60;

/** The six-wheel electric Perseverance build, placed on `ground` at (x, z). */
export function createMarsRoverVehicle(ground: GroundQuery, x: number, z: number): Vehicle {
  const motor = new ElectricMotor({ ...ROVER_MOTOR });
  const config = {
    ...createVehicleConfig({
      mass: 1025,
      gravity: 3.72,
      mu: MARS_ROVER_TRACTION.mu,
      wheelRadius: MARS_WHEEL_RADIUS,
      wheelbase: 2.26,
      track: 2.18,
      cgToFront: 1.095,
      cgHeight: 0.54,
      // Stiffer-than-default tire curves (see MARS_ROVER_TRACTION): grouser wheels on
      // regolith build force fast and hold it to large slip angles, so the wheels bite instead
      // of spinning.
      longitudinal: MARS_ROVER_TRACTION.longitudinal,
      lateral: MARS_ROVER_TRACTION.lateral,
      springRate: WHEEL_SPRING_RATE,
      damperRate: 2 * Math.sqrt(WHEEL_SPRING_RATE * (1025 / 6)) * 0.55,
      aero: null,
      maxBrakeTorque: 4200,
      absEnabled: false,
      rollingResistance: MARS_ROVER_TRACTION.rollingResistance,
      engine: motor,
      transmission: new ReductionDrive(MARS_ROVER_REDUCTION),
    }),
    wheels: MARS_ROVER_WHEELS.map((w) => ({
      x: w.x,
      z: w.z,
      steered: w.steered,
      driven: w.driven,
      handbrake: w.handbrake,
    })),
  };
  config.suspensionRest = MARS_BASE_SUSPENSION_REST;
  config.suspensionTravel = 0.16;
  config.maxSteerAngle = 0.62;
  const vehicle = new Vehicle(config);
  vehicle.position.x = x;
  vehicle.position.z = z;
  vehicle.placeOnGround(ground);
  return vehicle;
}

// ---------------------------------------------------------------- terrain

export interface MarsTerrainBundle {
  terrain: TerrainWorld;
  terrainLayers: LayeredTerrainMaterial;
  marsStage: MarsTerrainStage;
  /** Release the layered material and the procedural PBR arrays (the terrain itself is scene-owned). */
  dispose(): void;
}

/**
 * Streamed Mars terrain: the same planet as mars-terrain-gen, evaluated per tile rather than
 * loading baked chunks. Each tile consumes its actual geology weights; the four PBR arrays are
 * shared. `overrides` adjusts streaming budgets (the storm scene sees less than a kilometre).
 */
export function createMarsTerrain(
  gpu: GraphicsDevice,
  options: { site: { name: string; latDeg: number; lonDeg: number; headingDeg: number }; label: string; viewDistance?: number; visibleChunks?: number },
): MarsTerrainBundle {
  let marsMaps: PbrTextureSet | null = createMarsSurfaceTextures(gpu, 256);
  // Scene-authored sRGB tints: ferric dust, dark basalt, pale sand, weathered crust. The shared
  // helper's generic linear palette is intentionally overridable; these are not calibrated NASA data.
  const surfaceColors = [0xc9784f, 0x5c5046, 0xd1a06b, 0x9a6549];
  const terrainLayers = new LayeredTerrainMaterial({
    label: options.label,
    layers: marsSurfaceLayers().map((layer, i) => ({ ...layer, color: Color.fromSrgbHex(surfaceColors[i]!), textureSize: i === 2 ? 4 : 8 })),
    maps: marsMaps,
  });
  const terrainMat = terrainLayers.toMaterial(); // horizon apron + reversible diagnostic fallback
  const pipeline = createMarsPipeline({ site: options.site });
  const marsStage = pipeline.stages[0] as MarsTerrainStage;
  const terrain = new TerrainWorld({
    seed: marsStage.seed,
    chunkSize: 128,
    chunkResolution: 33,
    skirtDepth: adviseMarsTile(128, 33).recommendedSkirtDepth,
    viewDistance: options.viewDistance ?? 1024,
    maxLOD: 3,
    visibleChunks: options.visibleChunks ?? 220,
    generationsPerFrame: 1,
    uploadsPerFrame: 2,
    warmUpChunks: 9,
    // The analytic configuration round-trips to workers; no Stage A field buffers are needed.
    // TerrainWorld still falls back inline when there is no scheduler / workers cannot start.
    syncGeneration: false,
    material: terrainMat,
    layeredMaterial: terrainLayers,
    pipeline,
  });
  return {
    terrain,
    terrainLayers,
    marsStage,
    dispose(): void {
      terrainMat.dispose();
      disposePbrTextureSet(marsMaps);
      marsMaps = null;
    },
  };
}

// ---------------------------------------------------------------- drive input

export interface MarsDriveInput {
  throttle: number;
  brake: number;
  steer: number;
  /** Space held. */
  handbrake: boolean;
}

/** WASD / arrows combined with the on-screen stick and pads (max of each axis, steer summed). */
export function readMarsDriveInput(keys: ReadonlySet<string>, pad: VehicleTouchAxes, out: MarsDriveInput = { throttle: 0, brake: 0, steer: 0, handbrake: false }): MarsDriveInput {
  const keyThrottle = keys.has("KeyW") || keys.has("ArrowUp") ? 1 : 0;
  const keyBrake = keys.has("KeyS") || keys.has("ArrowDown") ? 1 : 0;
  const keySteer = (keys.has("KeyD") || keys.has("ArrowRight") ? 1 : 0) - (keys.has("KeyA") || keys.has("ArrowLeft") ? 1 : 0);
  out.throttle = Math.max(keyThrottle, pad.throttle);
  out.brake = Math.max(keyBrake, pad.brake);
  out.steer = Math.max(-1, Math.min(1, keySteer + pad.steer));
  out.handbrake = keys.has("Space");
  return out;
}

// ---------------------------------------------------------------- static model attach

function attachPart(scene: Scene, parent: Entity, name: string, position: Vec3, part: { geometry: Geometry; material: Material }): void {
  const child = scene.createTransformedEntity(name, position);
  parent.addChild(child);
  child.transform.position = position;
  const renderable = new Renderable();
  renderable.geometry = part.geometry;
  renderable.material = part.material;
  renderable.castShadow = true;
  renderable.receiveShadow = true;
  scene.world.addComponent(child.id, renderable);
}

/**
 * Parent the Perseverance GLB under a chassis and its system-posed wheel roots, with the mast and
 * arm frozen in their stowed pose (the rover course and the dust storm do not articulate them).
 */
export function attachStaticRoverModel(
  scene: Scene,
  chassis: Entity,
  wheelRoots: readonly Entity[],
  wheelNames: readonly string[],
  glb: LoadedGlb,
  bodyOffsetY: number,
): void {
  for (const part of glb.body) {
    attachPart(scene, chassis, `rover-body-${part.name}`, new Vec3(0, bodyOffsetY, 0), part);
  }
  const byName = new Map(glb.wheels.map((w) => [w.name, w]));
  for (let i = 0; i < wheelNames.length; i++) {
    const name = wheelNames[i]!;
    const root = wheelRoots[i];
    const wheel = byName.get(name);
    if (!wheel || !root) continue;
    for (const part of wheel.parts) attachPart(scene, root, `rover-${name}-part`, new Vec3(0, 0, 0), part);
  }
  // Mast: same three-tier pivots as the showcase, frozen in the stowed pose.
  if (glb.mast && glb.mast.parts.length > 0 && glb.mast.lowerParts.length > 0) {
    const [px, py, pz] = glb.mast.pivot;
    const [jx, jy, jz] = glb.mast.joint;
    const [hx, hy, hz] = glb.mast.headPivot;
    const lower = scene.createTransformedEntity("rover-mast-lower", new Vec3(px, py + bodyOffsetY, pz));
    chassis.addChild(lower);
    lower.transform.position = new Vec3(px, py + bodyOffsetY, pz);
    for (const part of glb.mast.lowerParts) attachPart(scene, lower, `rover-${part.name}`, new Vec3(0, 0, 0), part);
    const upper = scene.createTransformedEntity("rover-mast-upper", new Vec3(jx, jy, jz));
    lower.addChild(upper);
    upper.transform.position = new Vec3(jx, jy, jz);
    const upperOffset = scene.createTransformedEntity("rover-mast-upper-offset", new Vec3(-jx, -jy, -jz));
    upper.addChild(upperOffset);
    upperOffset.transform.position = new Vec3(-jx, -jy, -jz);
    for (const part of glb.mast.upperParts) attachPart(scene, upperOffset, `rover-${part.name}`, new Vec3(0, 0, 0), part);
    const head = scene.createTransformedEntity("rover-mast-head", new Vec3(hx - jx, hy - jy, hz - jz));
    upper.addChild(head);
    head.transform.position = new Vec3(hx - jx, hy - jy, hz - jz);
    const headOffset = scene.createTransformedEntity("rover-mast-head-offset", new Vec3(-hx, -hy, -hz));
    head.addChild(headOffset);
    headOffset.transform.position = new Vec3(-hx, -hy, -hz);
    for (const part of glb.mast.headParts) attachPart(scene, headOffset, `rover-${part.name}`, new Vec3(0, 0, 0), part);
  }
  // Arm: nest one pivot per joint like the GLB chain; identity rotations hold the fold.
  if (glb.arm && glb.arm.joints.length > 0) {
    let parent: Entity = chassis;
    let first = true;
    for (const joint of glb.arm.joints) {
      const [ox, oy, oz] = joint.offset;
      const pivot = scene.createTransformedEntity(`rover-${joint.name}`, new Vec3(ox, oy + (first ? bodyOffsetY : 0), oz));
      parent.addChild(pivot);
      pivot.transform.position = new Vec3(ox, oy + (first ? bodyOffsetY : 0), oz);
      first = false;
      for (const part of joint.parts) attachPart(scene, pivot, `rover-${part.name}`, new Vec3(0, 0, 0), part);
      parent = pivot;
    }
  }
}
