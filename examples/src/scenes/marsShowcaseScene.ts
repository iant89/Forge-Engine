/**
 * Mars showcase: the public-domain NASA Mars 2020 Perseverance model driving over the ported
 * Mars generator's analytic surface under the Phase 8a Mars sky, with wheel-kick and ambient dust.
 *
 * Stack, all on the public `@forge/engine` API:
 * - terrain: `createMarsPipeline` at the equatorial plain (generator seed 1337), 128 m / 33-vertex
 *   tiles with 32 m skirts, dust/rock/sand/crust splat materials and exp² dust haze. Analytic-only: no external Stage A
 *   erosion cache is fetched. Cell generation uses the engine's worker pool, with nine warm-up
 *   requests then one per frame; mesh uploads and missing-cell ground queries remain on main;
 * - sky: `MARS_ATMOSPHERE` through `forge.sky` with the horizon-coloured haze (same recipe as the
 *   terrain demo, quality raised to medium — this scene spends its budget on the rover up close);
 * - rover: `Vehicle` on an electric drivetrain (`ElectricMotor` ≈1.5 kW + `ReductionDrive` 60:1 —
 *   the real rovers are battery-electric; the no-load motor speed caps the rover near 9.5 km/h,
 *   and braking regenerates), with the model's six hub positions (front + rear steer, all six
 *   driven, Mars gravity 3.72 m/s², aero off), posed by `VehicleSystem`; the GLB arrives async —
 *   the rover stays invisible until the real body/wheel meshes land
 *   (`assets/glb.ts` reads `examples/assets/Perseverance.glb`, produced by
 *   `scripts/convert-perseverance.mjs`);
 * - high-gain antenna: the NASA model ships without an HGA, so the scene builds one procedurally
 *   (mount post → azimuth pivot → elevation pivot → dish + feed) on the front-right deck.
 *   `HighGainAntennaController` (`highGainAntenna.ts`) unfurls it `HGA_DEPLOY_DELAY_SECONDS`
 *   after the model lands and then keeps the boresight on `EARTH_DIRECTION` in world space —
 *   driving or turning is compensated by slew-limited gimbals every frame. One-way: there is no
 *   stow control anywhere.
 * - dust and regolith: an ambient field, six load- and slip-responsive wheel plumes, and occasional
 *   low-poly rock chips kicked into ballistic arcs. Puffs trail rearward/outward; airborne wheels
 *   stop emitting. The particles are stepped by scene objects every engine frame.
 *
 * - robotic arm: the GLB's five-joint `arm` chain becomes nested pivot entities under the chassis,
 *   posed every frame from `RoverArmController` (`roverArm.ts`): R / the D·ARM pad button unfolds
 *   or stows it along a keyframed choreography, and once it is out two thumbsticks (`armTouch.ts`,
 *   above the drive controls) or T/G F/H + I/K J/L jog the swing, shoulder, elbow and turret.
 *
 * Controls mirror the vehicle playground: WASD / arrows + the on-screen stick, orbit camera with
 * `keyboard: false` (the scene owns those keys) that tracks the chassis via `followTarget`.
 */

import {
  AABB,
  AtmosphereModel,
  Camera,
  Color,
  Geometry,
  HeightfieldShape,
  PhysicsWorld,
  SphereShape,
  BoxShape,
  RigidBody,
  type Shape,
  type Engine,
  type Entity,
  type EntityId,
  ElectricMotor,
  ReductionDrive,
  Mat4,
  System,
  type SystemContext,
  type MarsTerrainStage,
  Light,
  LayeredTerrainMaterial,
  marsSurfaceLayers,
  MARS_ATMOSPHERE,
  Material,
  Quat,
  type ParticleModule,
  PARTICLE_FLOATS,
  P_AGE,
  P_FLAGS,
  P_MAX_LIFE,
  P_SEED,
  P_SIZE,
  P_VX,
  P_VZ,
  isAlive,
  ParticleWorld,
  PopulationWorld,
  Renderable,
  Scene,
  SizeOverLifeModule,
  TerrainWorld,
  Transform,
  Vec3,
  Vehicle,
  VehicleComponent,
  VehicleSystem,
  adviseMarsTile,
  chunkCoordKey,
  createAtmosphere,
  createMarsPipeline,
  createBox,
  createCylinder,
  createTorus,
  createSphere,
  createVehicleConfig,
  heightFunctionGround,
  InteractiveRockProxy,
  applyRoverImpactDamage,
  bridgeRockContact,
  MARS_ROCK_MATERIAL,
  createInteractiveRockSpec,
  TerrainDeformationField,
  buildLodGeometry,
  rockGeometrySource,
  unindexedLodWindow,
  createVehicleDamageZones,
  applyBodyDamage,
  applyWheelDamage,
  computeBodyCrushOffset,
  WHEEL_DETACH_DAMAGE,
  WHEEL_BEND_MAX,
  TRS,
  MechanicalRig,
  MechanicalRigComponent,
  MechanicalSystem,
  type MechanicalChannelSource,
} from "@forge/engine";
import { attachVehicleTouch } from "../controls/vehicleTouch.js";
import { attachArmTouch } from "../controls/armTouch.js";
import { attachRoverToolTouch, type RoverToolTouchHandle } from "../controls/roverToolTouch.js";
import { loadGlb, type GlbLoadProgress, type GlbPart, type LoadedGlb } from "../assets/glb.js";
import { ARM_JOINT_COUNT, ARM_READY_DEG, RoverArmController, type ArmJogInput } from "./roverArm.js";
import {
  ROVER_TOOL_SPECS,
  roverToolPointFromPose,
  roverToolServoInput,
  roverToolWorldPoint,
  solveArmPoseForToolPoint,
  shouldSplitRockDuringDrilling,
  worldPointToRoverLocal,
  type RoverToolAction,
  type RoverToolPoint,
  type RoverToolWorldPoint,
} from "./roverTools.js";
import { HighGainAntennaController } from "./highGainAntenna.js";
import {
  createMarsSurfaceTextures,
  disposePbrTextureSet,
  type PbrTextureSet,
} from "../textures/procedural.js";
import type { DemoSceneHandle } from "./cubesScene.js";

export interface MarsShowcaseSceneHandle extends DemoSceneHandle {
  /** Gate-facing snapshot: model load state, dust counts and rover pose. */
  marsState(): {
    modelLoaded: boolean;
    modelError: string | null;
    /** Live fetch/parse/build progress for the loading screen; null before the first attempt. */
    modelProgress: GlbLoadProgress | null;
    /** Terrain streaming: chunk objects requested and bytes resident on the GPU. */
    terrainChunks: number;
    terrainResidentBytes: number;
    /** Actual pipeline/mode and resident terrain, not just requested chunk objects. */
    terrainGenerator: string;
    terrainHasErosion: boolean;
    /** Current worker-pool availability; browser tests separately observe real result messages. */
    terrainGeneration: "workers" | "inline";
    terrainMaterialMode: "layered" | "single";
    terrainMaterialLayers: string[];
    terrainSplatTiles: number;
    terrainReadyChunks: number;
    terrainRoverChunkReady: boolean;
    terrainGroundHeight: number;
    wheelCount: number;
    contactWheels: number;
    /** Cumulative interactive rocks the rover has shattered (rover impacts never count). */
    brokenInteractiveRocks: number;
    /** Proximity prompt for the closest arm-reachable rock; null when no action is available. */
    toolPrompt: string | null;
    toolTargetId: string | null;
    toolAction: RoverToolAction | null;
    toolPhase: "idle" | "approach" | "working" | "retract";
    toolProgress: number;
    toolMarks: number;
    toolRubble: number;
    toolDust: number;
    toolLastResult: string;
    drilledRocks: number;
    abradedRocks: number;
    analyzedRocks: number;
    drillSplits: number;
    /** Per-panel crush 0 (pristine) .. 1 (fully crushed in). */
    damageZoneFront: number;
    damageZoneRear: number;
    damageZoneLeft: number;
    damageZoneRight: number;
    /** Per-wheel damage 0..1 in wheel order (front-left first). */
    damageWheels: number[];
    /** Indices of torn-off wheels (disabled, hidden, dropped as props). */
    detachedWheels: number[];
    ambientDust: number;
    kickDust: number;
    /** Live rock/regolith fragments in ballistic flight. */
    kickDebris: number;
    /** Mast deployment 0 (stowed flat) … 1 (raised); overshoots slightly on the latch. */
    mastT: number;
    /** Commanded mast state (the MAST button / `setMast` target). */
    mastDeployed: boolean;
    /** Robotic arm unfold progress: 0 stowed … 1 unfolded (the choreography's position). */
    armT: number;
    /** Commanded arm state (the ARM button / R key / `setArm` target). */
    armDeployed: boolean;
    /** Fully unfolded: the arm thumbsticks are showing and jog the joints. */
    armUnfolded: boolean;
    /** Arm thumbsticks currently on screen (follows `armUnfolded`). */
    armSticksVisible: boolean;
    /** Arm joint angles in degrees, stowed = 0: azimuth, shoulder, elbow, wrist, turret. */
    armJoints: number[];
    /**
     * The same five angles *read back from the pivots* (Phase 16.6). `armJoints` is the controller's
     * command; this is what `MechanicalSystem` actually wrote through the rig, so the browser gate
     * can catch a rig that stopped being driven instead of trusting the controller's own report.
     */
    armPivotDeg: number[];
    /**
     * High-gain antenna telemetry. It arms itself when the rover model lands, unfurls
     * `HGA_DEPLOY_DELAY_SECONDS` later and then tracks Earth — one-way, no stow control.
     */
    antenna: {
      /** stowed → deploying → tracking; never goes back. */
      phase: "stowed" | "deploying" | "tracking";
      /** Seconds until the unfurl starts (0 once deploying/tracking). */
      countdown: number;
      /** Unfurl clock 0..1. */
      deployT: number;
      /** Live gimbal angles in degrees (azimuth about the mount's Y, elevation up from horizontal). */
      azimuthDeg: number;
      elevationDeg: number;
      /** The Earth solution the gimbals are slewing toward, in degrees. */
      targetAzimuthDeg: number;
      targetElevationDeg: number;
    };
    speed: number;
    x: number;
    y: number;
    z: number;
  };
  /** Re-run the GLB fetch after a failure (the loading screen's Retry button). */
  retryModelLoad(): void;
  /** Raise (true) or stow (false) the Remote Sensing Mast; the spring animates it smoothly. */
  setMast(deployed: boolean): void;
  /** Unfold (true) or stow (false) the robotic arm; the choreography animates it. */
  setArm(deployed: boolean): void;
  /** Start a proximity-checked turret operation on the nearest reachable rock. */
  useTool(action: RoverToolAction): boolean;
  /**
   * Rover "where it is supposed to be" wireframe boxes. `auto` (default) shows them until the
   * GLB has landed, `on`/`off` force the overlay either way.
   */
  setDebugBounds(mode: "auto" | "on" | "off"): void;
  /** Serialize interactive rock and terrain deformation state for save/load. */
  saveInteractiveTerrain(): string;
  /** Restore a prior interactive terrain snapshot. Invalid snapshots are rejected. */
  restoreInteractiveTerrain(serialized: string): void;
}

/** Footprint boxes for the rover debug overlay, in each entity's local space (metres). */
const CHASSIS_DEBUG_MIN = new Vec3(-1.4, -0.4, -1.6);
const CHASSIS_DEBUG_MAX = new Vec3(1.4, 1.6, 1.6);
const WHEEL_DEBUG_MIN = new Vec3(-0.2, -0.27, -0.27);
const WHEEL_DEBUG_MAX = new Vec3(0.2, 0.27, 0.27);
const CHASSIS_BOUNDS_COLOR = 0xffffff00; // yellow (RGBA byte pack)
const WHEEL_BOUNDS_COLOR = 0xff00ff00; // green

/**
 * Debug band (order 900): wireframe boxes where the rover model is supposed to sit — one footprint
 * box at the chassis origin and one hub box per wheel — through the renderer's debug AABB path.
 * The boxes are drawn depth-test-free, so they stay visible when the mesh is missing, frustum
 * culled, or buried under terrain: exactly the failure modes of an "invisible rover" report.
 */
class RoverDebugBounds extends System {
  readonly name = "mars-debug-bounds";
  override readonly order = 900;
  private readonly scratchMat = new Mat4();
  private readonly localBox = new AABB();
  private readonly worldBox = new AABB();

  constructor(private readonly sample: () => { chassis: EntityId; wheels: readonly EntityId[] } | null) {
    super();
  }

  override update(context: SystemContext): void {
    const render = context.render;
    if (!render) return; // headless (benchmarks/tests): nothing to draw through
    const target = this.sample();
    if (!target) return;
    const world = context.world;
    world.getWorldMatrix(target.chassis, this.scratchMat);
    render.drawAabb(this.localBox.setFrom(CHASSIS_DEBUG_MIN, CHASSIS_DEBUG_MAX).transformByMatrix(this.scratchMat, this.worldBox), CHASSIS_BOUNDS_COLOR);
    for (const id of target.wheels) {
      world.getWorldMatrix(id, this.scratchMat);
      render.drawAabb(this.localBox.setFrom(WHEEL_DEBUG_MIN, WHEEL_DEBUG_MAX).transformByMatrix(this.scratchMat, this.worldBox), WHEEL_BOUNDS_COLOR);
    }
  }
}

/** A local patch of the port's procedural planet, not a reconstruction of a NASA landing site. */
export const MARS_SHOWCASE_SITE = {
  name: "Equatorial plain",
  latDeg: 0,
  lonDeg: 0,
  headingDeg: 0,
} as const;

/**
 * Surveyed gentle uphill traverse on the unmodified seed-1337 surface. The summit preset starts
 * on a long downhill slope; this site keeps all six wheels planted during the opening drive without
 * flattening the generator or changing the rover's physics. placeOnGround supplies Y and attitude.
 */
const SPAWN_X = -164;
const SPAWN_Z = 4;

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

/**
 * Hub centres measured from the converted GLB (`scripts/convert-perseverance.mjs` prints them):
 * front/rear track 2.18 m, middle axle slightly wider, radius 0.264 m — the real Perseverance
 * geometry. Front and rear axles steer (the middle pair is fixed), all six are driven.
 */
const WHEELS = [
  { name: "wheel_FL", x: -1.091, z: 1.095, steered: true, driven: true, handbrake: false },
  { name: "wheel_FR", x: 1.091, z: 1.095, steered: true, driven: true, handbrake: false },
  { name: "wheel_ML", x: -1.213, z: -0.09, steered: false, driven: true, handbrake: false },
  { name: "wheel_MR", x: 1.213, z: -0.09, steered: false, driven: true, handbrake: false },
  { name: "wheel_RL", x: -1.091, z: -1.165, steered: true, driven: true, handbrake: true },
  { name: "wheel_RR", x: 1.091, z: -1.165, steered: true, driven: true, handbrake: true },
] as const;

const WHEEL_RADIUS = 0.264;
/** Pristine suspension rest length; suspension wear sags it up to 30% shorter (visible squat). */
const BASE_SUSPENSION_REST = 0.32;
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
const ROVER_REDUCTION = 60;
/** Peak tractive force (N) for rock contacts, using the vehicle's default 0.9 efficiency. */
const ROVER_TRACTIVE_FORCE = (MARS_ROVER_TRACTION.peakTorque * ROVER_REDUCTION * 0.9) / WHEEL_RADIUS;

/**
 * Fragment geometry half-extents (see `rockGeometrySource`: Y is squashed by `(1 − flatten)`).
 * Fragment entity scales are collision-half-extent ÷ these radii, so the rendered rock matches
 * the simulated shape instead of floating inside (or outside) its collider.
 */
const CHUNK_GEO_RADIUS_XZ = 0.6;
const CHUNK_GEO_RADIUS_Y = 0.6 * (1 - 0.35);
const PEBBLE_GEO_RADIUS_XZ = 0.22;
const PEBBLE_GEO_RADIUS_Y = 0.22 * (1 - 0.2);

/**
 * Deterministic-ish golden-angle placement for rock-break fragments: rings expand from the
 * impact point and every candidate is rejection-tested against all already-placed fragments,
 * so no two spawn interpenetrating (the old ring packed 9 fragments into ~0.5 m and they
 * rested stacked inside one another). `radii` must be largest-first so big chunks claim the
 * inner ring. `random` defaults to `Math.random`; tests inject a seeded stream.
 */
export function layoutBreakFragments(
  radii: readonly number[],
  originX: number,
  originZ: number,
  pushX: number,
  pushZ: number,
  random: () => number = Math.random,
): Array<{ x: number; z: number }> {
  const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
  const placed: Array<{ x: number; z: number }> = [];
  for (let i = 0; i < radii.length; i++) {
    const r = Math.max(0.03, radii[i]!);
    let px = originX;
    let pz = originZ;
    let ok = false;
    for (let attempt = 0; attempt < 48 && !ok; attempt++) {
      // A fresh ring every 6 attempts; radius jitter keeps the scatter organic.
      const ring = Math.floor(attempt / 6);
      const ringR = r + 0.1 + ring * 0.24 + random() * 0.1;
      const a = i * GOLDEN_ANGLE + attempt * 0.9 + random() * 0.6;
      const cx = originX + Math.cos(a) * ringR + pushX * 0.22;
      const cz = originZ + Math.sin(a) * ringR + pushZ * 0.22;
      ok = true;
      for (let j = 0; j < placed.length; j++) {
        const q = placed[j]!;
        const need = r + Math.max(0.03, radii[j]!) + 0.07;
        const dx = cx - q.x;
        const dz = cz - q.z;
        if (dx * dx + dz * dz < need * need) {
          ok = false;
          break;
        }
      }
      if (ok) {
        px = cx;
        pz = cz;
      }
    }
    if (!ok) {
      // Deterministic overflow: far out on its own golden spoke, biased down-push.
      const a = i * GOLDEN_ANGLE;
      const ringR = 1.4 + i * 0.2;
      px = originX + Math.cos(a) * ringR + pushX * 0.4;
      pz = originZ + Math.sin(a) * ringR + pushZ * 0.4;
    }
    placed.push({ x: px, z: pz });
  }
  return placed;
}

/**
 * `Entity.transform` getters return fresh throwaway copies — mutating them in place
 * (`transform.position.copyFrom(...)`, `transform.scale.set(...)`) silently discards the write
 * and freezes the visual at its creation pose. Poses must go through the setters (assignment),
 * which copy the components into the slot immediately, so these shared scratch objects are safe
 * to reuse. Every entity-pose write in this scene funnels through these two helpers.
 */
const poseScratchPosition = new Vec3();
const poseScratchRotation = new Quat();
const poseScratchScale = new Vec3();

/** Assign an entity's position + rotation (the per-frame body-following path). */
function syncEntityPose(entity: Entity, position: Vec3, rotation: Quat): void {
  entity.transform.position = poseScratchPosition.set(position.x, position.y, position.z);
  entity.transform.rotation = poseScratchRotation.copyFrom(rotation);
}

/** Assign an entity's non-uniform scale (fragment sizing, trail stamps). */
function setEntityScale(entity: Entity, x: number, y: number, z: number): void {
  entity.transform.scale = poseScratchScale.set(x, y, z);
}

/**
 * Stowed head centroid relative to the mast hinge, from the converter report (`mast.headOffset`
 * in `scripts/convert-perseverance.mjs` output). The deployed pose is the quaternion taking this
 * offset onto +Y; re-measure from a fresh report if the model is ever reconverted.
 */
const MAST_STOWED_HEAD = new Vec3(0.5222, -0.0357, -0.5955);
/** Deployment spring: ω≈2.2 rad/s settles in ~3 s, ζ≈0.7 gives a small latch overshoot. */
const MAST_STIFFNESS = 5.0;
const MAST_DAMPING = 3.2;
/**
 * Mast azimuth sweep range (radians). Real Perseverance rotates its upper mast ±180°, but a
 * narrow ±25° sweep scans the horizon naturally without whipping the cameras around.
 */
const MAST_AZIMUTH_RANGE = 0.44;
/** Azimuth sweep angular speed (rad/s). One full oscillation in ~14 s. */
const MAST_AZIMUTH_SPEED = 0.44;
/** Head elevation when deployed (radians). ~15° upward tilt, within Mastcam-Z's −30°/+30° range. */
const MAST_ELEVATION = 0.26;
/** Elevation spring natural frequency (rad/s) and damping ratio. */
const MAST_ELEVATION_WN = 6.0;
const MAST_ELEVATION_ZETA = 0.8;
const AMBIENT_DUST_SPRITES = 420;
const KICK_DUST_SPRITES = 500;
const KICK_DUST_SPRITES_PER_WHEEL = Math.ceil(KICK_DUST_SPRITES / WHEELS.length);
const TOOL_DUST_SPRITES = 96;
const ROCK_CHIP_SPRITES_PER_WHEEL = 10;
const AXIS_X = { x: 1, y: 0, z: 0 };
const AXIS_Y = { x: 0, y: 1, z: 0 };
const AXIS_Z = { x: 0, y: 0, z: 1 };

/** Grows a wheel puff across its life, then shrinks it away — the shared material has no
 * per-particle alpha (see docs/KNOWN-ISSUES.md), so dissipation rides on size instead. Seeded size
 * variation keeps a plume from reading as a row of identical bubbles. */
class DustPuffSizeModule implements ParticleModule {
  readonly name = "dustPuffSize";
  constructor(
    private readonly start: number,
    private readonly end: number,
  ) {}
  apply(state: Float32Array, index: number, _dt: number): void {
    const o = index * PARTICLE_FLOATS;
    if (state[o + P_FLAGS]! < 0.5) return;
    const maxLife = state[o + P_MAX_LIFE]!;
    if (!(maxLife > 0)) return;
    const t = Math.min(1, Math.max(0, state[o + P_AGE]! / maxLife));
    const grow = this.start + (this.end - this.start) * Math.min(1, t / 0.58);
    const shrink = t > 0.68 ? Math.max(0.025, 1 - (t - 0.68) / 0.32) : 1;
    const variation = 0.72 + state[o + P_SEED]! * 0.56;
    state[o + P_SIZE] = grow * shrink * variation;
  }
}

/** Dust motes that always spawn in a jittered slab around the camera. */
class AmbientDustField extends ParticleWorld {
  constructor(private readonly cameraEntity: Entity) {
    super({ name: "dust-ambient", capacity: AMBIENT_DUST_SPRITES, gravity: { x: 0, y: -0.3, z: 0 }, drag: 0.5, seed: 9 });
    const emitter = this.simulation.emitter;
    emitter.rate = 40;
    emitter.lifeMin = 4;
    emitter.lifeMax = 8;
    emitter.size = 0.1;
    emitter.cone = { direction: { x: 0, y: -1, z: 0 }, angle: 2.6, speedMin: 0.25, speedMax: 1.1 };
    emitter.color = { r: 1, g: 1, b: 1, a: 1 };
    this.simulation.modules.push(new SizeOverLifeModule(0.1, 0.01));
  }

  override update(context: Parameters<NonNullable<ParticleWorld["update"]>>[0], dt: number): void {
    const eye = this.cameraEntity.transform.position;
    const emitter = this.simulation.emitter;
    emitter.position.x = eye.x + (Math.random() - 0.5) * 56;
    emitter.position.y = eye.y + Math.random() * 10 - 3;
    emitter.position.z = eye.z + (Math.random() - 0.5) * 56;
    super.update(context, dt);
  }
}

interface WheelKickSample {
  x: number;
  y: number;
  z: number;
  speed: number;
  velocityX: number;
  velocityZ: number;
  yaw: number;
  side: -1 | 1;
  normalLoad: number;
  slipRatio: number;
  slipAngle: number;
  longitudinalForce: number;
  lateralForce: number;
  throttle: number;
  brake: number;
}

/**
 * One tire's regolith plume. Each wheel has its own deterministic emitter, so all six contact
 * patches leave a bilateral trail and a wheel that is airborne cannot keep throwing dust.
 */
class WheelKickDust extends ParticleWorld {
  constructor(
    wheelIndex: number,
    private readonly sampleKick: () => WheelKickSample | null,
  ) {
    super({
      name: `dust-kick-wheel-${wheelIndex}`,
      capacity: KICK_DUST_SPRITES_PER_WHEEL,
      gravity: { x: 0, y: -0.85, z: 0 },
      drag: 0.72,
      seed: 11 + wheelIndex,
    });
    const emitter = this.simulation.emitter;
    emitter.rate = 0;
    emitter.lifeMin = 0.8;
    emitter.lifeMax = 1.45;
    emitter.size = 0.1;
    emitter.jitter.x = 0.16;
    emitter.jitter.y = 0.05;
    emitter.jitter.z = 0.16;
    emitter.cone = { direction: { x: 0, y: 1, z: 0 }, angle: 0.72, speedMin: 0.6, speedMax: 1.8 };
    this.simulation.modules.push(new DustPuffSizeModule(0.08, 0.46));
  }

  override update(context: Parameters<NonNullable<ParticleWorld["update"]>>[0], dt: number): void {
    const kick = this.sampleKick();
    const emitter = this.simulation.emitter;
    // The rover tops out around 2.4 m/s: fade in at walking pace, then scale emission with
    // wheel load and tire scrub instead of using a combustion-car speed curve.
    if (kick && kick.speed > 0.2 && kick.normalLoad > 0) {
      const speedFactor = Math.max(0, Math.min(1, (kick.speed - 0.2) / 2.2));
      const slip = Math.max(
        Math.min(1, Math.abs(kick.slipRatio) / 0.22),
        Math.min(1, Math.abs(kick.slipAngle) / 0.28),
      );
      const loadFactor = Math.max(0.3, Math.min(1.45, kick.normalLoad / ((1025 * 3.72) / 6)));
      const traction = Math.max(
        0,
        Math.min(1, Math.hypot(kick.longitudinalForce, kick.lateralForce) / Math.max(kick.normalLoad, 1)),
      );
      const effort =
        0.62 +
        Math.max(0, Math.min(1, kick.throttle)) * 0.2 +
        Math.max(0, Math.min(1, kick.brake)) * 0.1 +
        slip * 0.45 +
        traction * 0.1;
      emitter.rate = Math.min(60, (4 + speedFactor * 48) * loadFactor * effort);

      // Use actual ground velocity so reverse and lateral scrub throw dust the right way. Add a
      // small outward fan from each tire, with more spread and loft when the tread slips.
      const moveX = kick.velocityX / kick.speed;
      const moveZ = kick.velocityZ / kick.speed;
      const rightX = Math.cos(kick.yaw) * kick.side;
      const rightZ = -Math.sin(kick.yaw) * kick.side;
      emitter.position.x = kick.x - moveX * 0.05 + rightX * 0.035;
      emitter.position.y = kick.y + 0.025;
      emitter.position.z = kick.z - moveZ * 0.05 + rightZ * 0.035;
      const dx = -moveX * 0.72 + rightX * 0.34;
      const dy = 1.05 + slip * 0.3;
      const dz = -moveZ * 0.72 + rightZ * 0.34;
      const length = Math.hypot(dx, dy, dz) || 1;
      emitter.cone.direction.x = dx / length;
      emitter.cone.direction.y = dy / length;
      emitter.cone.direction.z = dz / length;
      emitter.cone.angle = 0.62 + slip * 0.24;
      emitter.cone.speedMin = 0.5 + speedFactor * 0.25;
      emitter.cone.speedMax = 1.3 + speedFactor * 0.7 + slip * 0.35;
      const spread = 0.1 + speedFactor * 0.04 + slip * 0.05;
      emitter.jitter.x = spread;
      emitter.jitter.y = spread * 0.35;
      emitter.jitter.z = spread;
    } else {
      emitter.rate = 0;
    }
    super.update(context, dt);

    // Billow each sprite into a soft, wind-stretched ellipsoid aligned with its own travel vector.
    // The shared sphere geometry stays cheap; only the per-sprite transform changes.
    const scene = this.scene;
    if (!scene) return;
    const state = this.simulation.state;
    let sprite = 0;
    for (let slot = 0; slot < this.simulation.capacity && sprite < this.spriteEntities.length; slot++) {
      if (!isAlive(state, slot)) continue;
      const entity = this.spriteEntities[sprite++];
      if (entity === undefined || !scene.world.exists(entity)) continue;
      const transform = scene.world.getComponent(entity, Transform);
      const o = slot * PARTICLE_FLOATS;
      const size = state[o + P_SIZE]!;
      const yaw = Math.atan2(state[o + P_VX]!, state[o + P_VZ]!);
      transform?.setRotationEuler(0, yaw, 0);
      transform?.setScale(size * 0.92, size * 0.72, size * 1.35);
    }
  }
}

/** Low, slow dust puffs from the turret contact point; old particles keep drifting after work ends. */
class RoverToolDustField extends ParticleWorld {
  private readonly point = new Vec3();
  private readonly normal = new Vec3(0, 1, 0);
  private activeAction: RoverToolAction | null = null;
  private burstAction: RoverToolAction = "drill";
  private burstTimer = 0;
  private readonly burstPoint = new Vec3();

  constructor() {
    super({ name: "rover-tool-dust", capacity: TOOL_DUST_SPRITES, gravity: { x: 0, y: -0.12, z: 0 }, drag: 0.46, seed: 73 });
    const emitter = this.simulation.emitter;
    emitter.rate = 0;
    emitter.lifeMin = 1.2;
    emitter.lifeMax = 2.6;
    emitter.size = 0.08;
    emitter.jitter.x = 0.1;
    emitter.jitter.y = 0.045;
    emitter.jitter.z = 0.1;
    emitter.cone = { direction: { x: 0, y: 1, z: 0 }, angle: 0.72, speedMin: 0.35, speedMax: 0.9 };
    this.simulation.modules.push(new DustPuffSizeModule(0.035, 0.24));
  }

  setWork(action: RoverToolAction | null, point?: Readonly<RoverToolWorldPoint>, normal?: Readonly<{ x: number; y: number; z: number }>): void {
    this.activeAction = action;
    if (!action || !point) return;
    this.point.set(point.x, point.y, point.z);
    if (normal) this.normal.set(normal.x, normal.y, normal.z);
  }

  burst(action: RoverToolAction, point: Readonly<RoverToolWorldPoint>, normal: Readonly<{ x: number; y: number; z: number }>): void {
    this.burstAction = action;
    this.burstPoint.set(point.x, point.y, point.z);
    this.normal.set(normal.x, normal.y, normal.z);
    this.burstTimer = Math.max(this.burstTimer, action === "drill" ? 0.34 : 0.24);
  }

  override update(context: Parameters<NonNullable<ParticleWorld["update"]>>[0], dt: number): void {
    const emitter = this.simulation.emitter;
    const working = this.activeAction !== null && this.activeAction !== "analyze";
    const bursting = this.burstTimer > 0;
    if (working || bursting) {
      const point = working ? this.point : this.burstPoint;
      const action = working ? this.activeAction! : this.burstAction;
      emitter.rate = working ? (action === "drill" ? 38 : 25) : 88 * Math.min(1, this.burstTimer / 0.12);
      emitter.position.x = point.x;
      emitter.position.y = point.y + 0.025;
      emitter.position.z = point.z;
      const lift = action === "drill" ? 0.88 : 0.72;
      const side = action === "drill" ? 0.26 : 0.4;
      const length = Math.hypot(this.normal.x * side, lift, this.normal.z * side) || 1;
      emitter.cone.direction.x = (this.normal.x * side) / length;
      emitter.cone.direction.y = lift / length;
      emitter.cone.direction.z = (this.normal.z * side) / length;
      emitter.cone.angle = action === "drill" ? 0.64 : 0.82;
      emitter.cone.speedMin = action === "drill" ? 0.42 : 0.3;
      emitter.cone.speedMax = action === "drill" ? 1.1 : 0.82;
    } else {
      emitter.rate = 0;
    }
    if (bursting) this.burstTimer = Math.max(0, this.burstTimer - dt);
    super.update(context, dt);
  }
}

/** Keeps the fragments pebble-sized while varying them from particle to particle. */
class RockChipSizeModule implements ParticleModule {
  readonly name = "rockChipSize";
  apply(state: Float32Array, index: number, _dt: number): void {
    const o = index * PARTICLE_FLOATS;
    if (state[o + P_FLAGS]! < 0.5) return;
    state[o + P_SIZE] = 0.028 + state[o + P_SEED]! * 0.035;
  }
}

/** Rare ballistic regolith chips: unlike the suspended dust, these arc under Martian gravity. */
class WheelRockChips extends ParticleWorld {
  constructor(
    wheelIndex: number,
    private readonly sampleKick: () => WheelKickSample | null,
  ) {
    super({
      name: `rover-debris-wheel-${wheelIndex}`,
      capacity: ROCK_CHIP_SPRITES_PER_WHEEL,
      gravity: { x: 0, y: -3.72, z: 0 },
      drag: 0.12,
      seed: 101 + wheelIndex,
    });
    const emitter = this.simulation.emitter;
    emitter.rate = 0;
    emitter.lifeMin = 0.45;
    emitter.lifeMax = 1.05;
    emitter.size = 0.04;
    emitter.jitter.x = 0.06;
    emitter.jitter.y = 0.025;
    emitter.jitter.z = 0.06;
    emitter.cone = { direction: { x: 0, y: 1, z: 0 }, angle: 0.38, speedMin: 1.2, speedMax: 3.2 };
    this.simulation.modules.push(new RockChipSizeModule());
  }

  override update(context: Parameters<NonNullable<ParticleWorld["update"]>>[0], dt: number): void {
    const kick = this.sampleKick();
    const emitter = this.simulation.emitter;
    if (kick && kick.speed > 0.25 && kick.normalLoad > 0) {
      const speedFactor = Math.max(0, Math.min(1, (kick.speed - 0.2) / 1.55));
      const slip = Math.max(
        Math.min(1, Math.abs(kick.slipRatio) / 0.22),
        Math.min(1, Math.abs(kick.slipAngle) / 0.28),
      );
      const effort = Math.max(
        slip,
        Math.max(0, Math.min(1, kick.throttle)) * 0.55,
        Math.max(0, Math.min(1, kick.brake)) * 0.4,
      );
      if (effort > 0.18) {
        const loadFactor = Math.max(0.3, Math.min(1.4, kick.normalLoad / ((1025 * 3.72) / 6)));
        emitter.rate = Math.min(8, (1 + speedFactor * 2 + (effort - 0.18) * 12) * loadFactor);

        const moveX = kick.velocityX / kick.speed;
        const moveZ = kick.velocityZ / kick.speed;
        const rightX = Math.cos(kick.yaw) * kick.side;
        const rightZ = -Math.sin(kick.yaw) * kick.side;
        emitter.position.x = kick.x - moveX * 0.06 + rightX * 0.045;
        emitter.position.y = kick.y + 0.045;
        emitter.position.z = kick.z - moveZ * 0.06 + rightZ * 0.045;
        const dx = -moveX * 0.78 + rightX * 0.46;
        const dy = 0.9 + slip * 0.35;
        const dz = -moveZ * 0.78 + rightZ * 0.46;
        const length = Math.hypot(dx, dy, dz) || 1;
        emitter.cone.direction.x = dx / length;
        emitter.cone.direction.y = dy / length;
        emitter.cone.direction.z = dz / length;
        emitter.cone.angle = 0.28 + slip * 0.22;
        emitter.cone.speedMin = 1.1 + speedFactor * 0.3;
        emitter.cone.speedMax = 2.1 + speedFactor * 0.8 + slip * 1.2;
        const spread = 0.035 + slip * 0.035;
        emitter.jitter.x = spread;
        emitter.jitter.y = spread * 0.35;
        emitter.jitter.z = spread;
      } else {
        emitter.rate = 0;
      }
    } else {
      emitter.rate = 0;
    }
    super.update(context, dt);

    // Low-poly chips tumble on all axes while following their own ballistic arcs.
    const scene = this.scene;
    if (!scene) return;
    const state = this.simulation.state;
    let sprite = 0;
    for (let slot = 0; slot < this.simulation.capacity && sprite < this.spriteEntities.length; slot++) {
      if (!isAlive(state, slot)) continue;
      const entity = this.spriteEntities[sprite++];
      if (entity === undefined || !scene.world.exists(entity)) continue;
      const transform = scene.world.getComponent(entity, Transform);
      const o = slot * PARTICLE_FLOATS;
      const age = state[o + P_AGE]!;
      const seed = state[o + P_SEED]!;
      const spin = 7 + seed * 13;
      const phase = seed * Math.PI * 2;
      transform?.setRotationEuler(phase + age * spin * 0.73, age * spin, phase * 0.6 + age * spin * 0.41);
    }
  }
}

export function buildMarsShowcaseScene(engine: Engine): MarsShowcaseSceneHandle {
  const scene = new Scene({ name: "mars-showcase" });

  scene.settings.hdr = true;
  scene.settings.exposure = 1.1;
  scene.settings.toneMapping = "aces";
  scene.settings.bloom.enabled = true;
  scene.settings.bloom.threshold = 1.0;
  scene.settings.bloom.intensity = 0.05;

  // Mars sky (terrain demo's recipe, medium quality — the horizon and the rover share the frame).
  const marsAtmosphere = createAtmosphere({}, MARS_ATMOSPHERE);
  scene.setSky({ atmosphere: marsAtmosphere, quality: "medium", sunIntensity: 20 });
  const sunDirection = new Vec3(200, 300, 200).normalize();
  const horizon = new AtmosphereModel(marsAtmosphere).horizonColor(sunDirection, 0, new Float64Array(3));
  // Match the terrain demo's readable streaming-edge haze: distant Mars ground and the newly
  // shared rock population should fade together instead of leaving rocks floating over fog.
  scene.setFog("exp2", {
    density: 0.0008,
    color: new Color(horizon[0]!, horizon[1]!, horizon[2]!),
  });

  scene.settings.shadow.enabled = true;
  scene.settings.shadow.cascades = 3;
  scene.settings.shadow.mapSize = 2048;
  scene.settings.shadow.distance = 250;
  scene.settings.shadow.splitLambda = 0.7;

  // Terrain: the same planet as mars-terrain-gen, evaluated per tile rather than loading baked
  // chunks. Each tile consumes its actual geology weights; the four PBR arrays are shared.
  const gpu = engine.gpu;
  let marsMaps: PbrTextureSet | null = createMarsSurfaceTextures(gpu, 256);
  // Scene-authored sRGB tints: ferric dust, dark basalt, pale sand, weathered crust. The shared
  // helper's generic linear palette is intentionally overridable; these are not calibrated NASA data.
  const surfaceColors = [0xc9784f, 0x5c5046, 0xd1a06b, 0x9a6549];
  const terrainLayers = new LayeredTerrainMaterial({
    label: "showcase-mars-layers",
    layers: marsSurfaceLayers().map((layer, i) => ({ ...layer, color: Color.fromSrgbHex(surfaceColors[i]!), textureSize: i === 2 ? 4 : 8 })),
    maps: marsMaps,
  });
  const terrainMat = terrainLayers.toMaterial(); // horizon apron + reversible diagnostic fallback
  const pipeline = createMarsPipeline({ site: MARS_SHOWCASE_SITE });
  const marsStage = pipeline.stages[0] as MarsTerrainStage;
  const terrain = new TerrainWorld({
    seed: marsStage.seed,
    chunkSize: 128,
    chunkResolution: 33,
    skirtDepth: adviseMarsTile(128, 33).recommendedSkirtDepth,
    viewDistance: 1024,
    maxLOD: 3,
    visibleChunks: 220,
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
  scene.add(terrain);
  const terrainGeneration = (): "workers" | "inline" =>
    !terrain.syncGeneration && engine.tasks && !engine.tasks.isInline ? "workers" : "inline";

  // Reuse the terrain demo's deterministic rock population on the showcase surface. The
  // population follows the Mars tiles (rather than a second terrain) so every rock is anchored to
  // the same heightmap the rover's wheels query. Rocks and boulders use the same merged hi/lo
  // geometry and GPU-selected LOD as the terrain demo; the lower density keeps the close rover
  // composition readable while the per-chunk culler handles the distant field.
  const rockMaterial = new Material({
    label: "mars-showcase-rock",
    color: Color.fromSrgbHex(0x9a6a4e),
    roughness: 0.96,
    metallic: 0.03,
  });
  // Two rock variants with distinct displacement seeds: every instance of one population type
  // shares a single lump of geometry, and a whole field of the same lump at different scales reads
  // as unnatural repetition next to the varied break fragments (their own seeds, 23 and 37). The
  // variants share radius/collision so the interactive layer treats them identically; only the
  // silhouette and crag differ.
  const rockLod = buildLodGeometry({
    hi: unindexedLodWindow(rockGeometrySource({ radius: 0.8, segments: 10, seed: 7, roughness: 0.42 })),
    lo: unindexedLodWindow(rockGeometrySource({ radius: 0.8, segments: 4, seed: 7, roughness: 0.42 })),
  });
  const rockLodB = buildLodGeometry({
    hi: unindexedLodWindow(rockGeometrySource({ radius: 0.8, segments: 10, seed: 41, roughness: 0.5 })),
    lo: unindexedLodWindow(rockGeometrySource({ radius: 0.8, segments: 4, seed: 41, roughness: 0.5 })),
  });
  const boulderLod = buildLodGeometry({
    hi: unindexedLodWindow(rockGeometrySource({ radius: 2.4, segments: 12, seed: 11, roughness: 0.38, flatten: 0.38 })),
    lo: unindexedLodWindow(rockGeometrySource({ radius: 2.4, segments: 4, seed: 11, roughness: 0.38, flatten: 0.38 })),
  });
  const rockGeometry = Geometry.create(gpu, rockLod.source);
  const rockGeometryB = Geometry.create(gpu, rockLodB.source);
  const boulderGeometry = Geometry.create(gpu, boulderLod.source);
  const chunkGeometry = Geometry.create(
    gpu,
    rockGeometrySource({ radius: 0.6, segments: 8, seed: 23, roughness: 0.35, flatten: 0.35 }),
  );
  const pebbleGeometry = Geometry.create(
    gpu,
    rockGeometrySource({ radius: 0.22, segments: 6, seed: 37, roughness: 0.28, flatten: 0.2 }),
  );
  const population = new PopulationWorld({
    terrain,
    settlePhysics: { gravity: 3.72, maxSteps: 90 },
    types: [
      {
        id: 1,
        label: "rocks",
        densityGrid: 6,
        scaleMin: 0.3,
        scaleMax: 1.7,
        scaleExponent: 1.7,
        slopeLimit: 0.55,
        tintJitter: 0.3,
        maxDistance: 550,
        geometry: rockGeometry,
        material: rockMaterial,
        lod: { hiTriangles: rockLod.hiTriangles, distance: 260 },
      },
      {
        id: 3,
        label: "rocks-b",
        densityGrid: 4,
        scaleMin: 0.3,
        scaleMax: 1.7,
        scaleExponent: 1.7,
        slopeLimit: 0.55,
        tintJitter: 0.3,
        maxDistance: 550,
        geometry: rockGeometryB,
        material: rockMaterial,
        lod: { hiTriangles: rockLodB.hiTriangles, distance: 260 },
      },
      {
        id: 2,
        label: "boulders",
        densityGrid: 2,
        scaleMin: 0.6,
        scaleMax: 1.4,
        slopeLimit: 0.4,
        tintJitter: 0.25,
        embed: 0.25,
        maxDistance: 800,
        geometry: boulderGeometry,
        material: rockMaterial,
        lod: { hiTriangles: boulderLod.hiTriangles, distance: 420 },
      },
    ],
  });
  scene.add(population);

  // Sun + rust-coloured bounce fill (terrain demo's lights).
  const sunEntity = scene.createTransformedEntity("sun", new Vec3(200, 300, 200));
  const sun = new Light();
  sun.kind = "directional";
  sun.intensity = 4.2;
  sun.castShadow = true;
  sun.setColor(1.0, 0.92, 0.8);
  sun.shadowBias = 0.001;
  scene.world.addComponent(sunEntity.id, sun);
  sunEntity.transform.lookAt(new Vec3(0, 0, 0));

  const fillEntity = scene.createTransformedEntity("ambient-fill", new Vec3(-200, -300, -200));
  const fill = new Light();
  fill.kind = "directional";
  fill.intensity = 0.8;
  fill.castShadow = false;
  fill.setColor(0.36, 0.2, 0.16);
  scene.world.addComponent(fillEntity.id, fill);
  fillEntity.transform.lookAt(new Vec3(0, 0, 0));

  // Camera: chase framing; `followTarget` tracks the chassis and the surface clamp glides over
  // the terrain (keyboard pan off — the scene binds WASD to the rover).
  const groundY = terrain.getHeightAt(SPAWN_X, SPAWN_Z);
  // Pin the sky's observer height to the surface the rover stands on. With `seaLevel` left at 0 the
  // atmosphere treats the camera as tens of metres above the virtual planet ground while the mesh
  // sits at `groundY`, and on tall phone viewports that mismatch reads as a flat beige disc with
  // the rover lost in the haze.
  scene.settings.sky.seaLevel = groundY;
  // Seed streaming focus on the spawn before the first engine update copies the camera — warm-up
  // then fills the disc under the rover instead of whatever default eye the orbit controller had.
  terrain.focusPosition.set(SPAWN_X, groundY, SPAWN_Z);
  const cameraEntity = scene.createTransformedEntity("camera", new Vec3(SPAWN_X - 8, groundY + 5, SPAWN_Z - 10));
  const camera = new Camera();
  camera.fovY = Math.PI / 3;
  camera.near = 0.35;
  camera.far = 8000;
  scene.world.addComponent(cameraEntity.id, camera);
  // ---------------------------------------------------------------- rover (six wheels)
  const deformation = new TerrainDeformationField({ resolution: 33, maxChunks: 128 });
  const deformedGroundHeight = (x: number, z: number): number => {
    const cx = Math.floor(x / terrain.chunkSize);
    const cz = Math.floor(z / terrain.chunkSize);
    return terrain.getHeightAt(x, z) + deformation.sample(chunkCoordKey(cx, cz), x - cx * terrain.chunkSize, z - cz * terrain.chunkSize, terrain.chunkSize);
  };
  const ground = heightFunctionGround(deformedGroundHeight);
  const motor = new ElectricMotor({ ...ROVER_MOTOR });
  const config = {
    ...createVehicleConfig({
      mass: 1025,
      gravity: 3.72,
      mu: MARS_ROVER_TRACTION.mu,
      wheelRadius: WHEEL_RADIUS,
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
      transmission: new ReductionDrive(ROVER_REDUCTION),
    }),
    wheels: WHEELS.map((w) => ({
      x: w.x,
      z: w.z,
      steered: w.steered,
      driven: w.driven,
      handbrake: w.handbrake,
    })),
  };
  config.suspensionRest = BASE_SUSPENSION_REST;
  config.suspensionTravel = 0.16;
  config.maxSteerAngle = 0.62;
  const vehicle = new Vehicle(config);
  vehicle.position.x = SPAWN_X;
  vehicle.position.z = SPAWN_Z;
  vehicle.placeOnGround(ground);
  // Hold the newly spawned rover until the user explicitly asks it to move. This covers both
  // rolling on the landing slope and input arriving before the async GLB has finished building.
  let startupBrake = true;
  vehicle.input.brake = 1;
  vehicle.input.handbrake = 1;
  // Local Y that puts the model's ground plane on the terrain at equilibrium (≈ radius + rest − sag).
  const bodyOffsetY = terrain.getHeightAt(SPAWN_X, SPAWN_Z) - vehicle.position.y;
  const chaseLookY = vehicle.position.y + MARS_CHASE_LOOK_OFFSET_Y;

  scene.world.registerSystem(new VehicleSystem());
  // Phase 16.6: machine joints from channels — the rover's robotic arm is a MechanicalRig here.
  scene.world.registerSystem(new MechanicalSystem());

  // Keep the vehicle's physics chassis and wheel roots alive while the GLB loads, but do not add
  // placeholder renderables. Showing a temporary orange box makes the loading state look like a
  // spawned rover and also encourages users to drive before the real model is ready.
  const chassis = scene.createTransformedEntity(
    "rover-chassis",
    new Vec3(vehicle.position.x, vehicle.position.y, vehicle.position.z),
  );
  const wheelRoots: Entity[] = [];
  const wheelIds: number[] = [];
  for (let i = 0; i < WHEELS.length; i++) {
    const wheel = scene.createTransformedEntity(`rover-${WHEELS[i]!.name}`, new Vec3(vehicle.position.x, vehicle.position.y, vehicle.position.z));
    wheelRoots.push(wheel);
    wheelIds.push(wheel.id);
  }

  const component = new VehicleComponent(vehicle, ground);
  component.wheelEntities = wheelIds;
  chassis.add(component);

  // Phase 15.5 foundation: promote only nearby rocks to dynamic physics proxies. The population
  // remains instanced; these bodies are a bounded interaction layer, not one rigid body per rock.
  const interactivePhysics = new PhysicsWorld({ gravity: { x: 0, y: -3.72, z: 0 } });
  interactivePhysics.setHeightfield(new HeightfieldShape({
    sampleHeight: deformedGroundHeight,
  }));
  interface InteractiveRockRecord {
    block: NonNullable<ReturnType<typeof population.chunkPopulation>>;
    index: number;
    proxy: InteractiveRockProxy;
    typeId: number;
    isFlat: boolean;
    origScaleX: number;
    origScaleY: number;
    origScaleZ: number;
    /** Resting height of the body center above the ground (hy for slabs, radius for rounds). */
    restOffsetY: number;
    /** Horizontal half-extent of the collision shape, for sizing push-trail stamps. */
    trailRadius: number;
    /** Last push-trail stamp position (NaN until the rock first moves while awake). */
    lastTrailX: number;
    lastTrailZ: number;
    activeEntity: Entity | null;
    awake: boolean;
    settledTimer: number;
  }
  const interactiveRocks = new Map<string, InteractiveRockRecord>();
  let brokenInteractiveRocks = 0;
  const brokenInteractiveRockIds = new Set<string>();

  interface FragmentRecord {
    id: string;
    body: RigidBody;
    entity: Entity;
    isFlat: boolean;
    scale: number;
    awake: boolean;
    settledTimer: number;
    /** Seconds since spawn. Fragments must stay awake (`MIN_FRAGMENT_AWAKE`) so the scatter has
     * time to separate the pile before anything is allowed to fall asleep mid-stack. */
    age: number;
  }
  const fragments: FragmentRecord[] = [];
  type RoverToolPhase = "approach" | "working" | "retract";
  interface ToolMarkRecord {
    targetId: string;
    entity: Entity;
    renderable: Renderable;
    localPoint: Vec3;
    localNormal: Vec3;
    kind: "hole" | "rim" | "abrasion" | "scan";
    age: number;
    duration: number;
    baseScale: number;
  }
  interface ToolCandidate {
    record: InteractiveRockRecord;
    point: RoverToolWorldPoint;
    normal: { x: number; y: number; z: number };
    distance: number;
  }
  interface ToolOperation {
    action: RoverToolAction;
    targetId: string;
    phase: RoverToolPhase;
    elapsed: number;
    workSeconds: number;
    targetPose: Float64Array;
    targetPoint: RoverToolWorldPoint;
    targetNormal: { x: number; y: number; z: number };
    result: string;
  }
  const toolMarks: ToolMarkRecord[] = [];
  const toolCounts = { drilled: 0, abraded: 0, analyzed: 0, split: 0, rubble: 0 };
  let toolLastResult = "";
  let toolOperation: ToolOperation | null = null;
  let toolCandidate: ToolCandidate | null = null;
  let toolPrompt: string | null = null;
  let toolTargetId: string | null = null;
  let toolOperationProgress = 0;
  let toolDrillAttempt = 0;
  let toolMarkSequence = 0;
  let toolRubbleSequence = 0;
  let toolTouch: RoverToolTouchHandle | null = null;
  const MAX_TOOL_MARKS = 96;
  const MAX_FRAGMENTS = 64;
  /** Minimum seconds a fresh fragment simulates before it may fall asleep. */
  const MIN_FRAGMENT_AWAKE = 1.0;
  /** Safety cap (m/s) on fragment and shoved-rock speeds: solver separations must fling rocks
   * apart, never launch them skyward. */
  const MAX_ROCK_SPEED = 6;

  const roverDamage = { hull: 0, wheels: 0, suspension: 0, disabled: false };

  // Area-dependent visible damage: per-panel crush zones plus per-wheel damage, accumulated
  // from the same assessed rock contacts that feed the mechanical `roverDamage` numbers.
  const damageZones = createVehicleDamageZones();
  const wheelDamage = WHEELS.map(() => 0);
  const detachedWheels = new Set<number>();
  /** Impacts below this force (N) only scratch the paint; above it panels start to crumple. */
  const IMPACT_DAMAGE_THRESHOLD = 5000;
  /** Force (N) above the threshold that counts as a worst-case, fully-crushing hit. */
  const IMPACT_DAMAGE_RANGE = 100000;
  /** Body crush per full-severity first touch (× outcome/size factors). */
  const BODY_DAMAGE_INSTANT = 0.45;
  /** Wheel damage per full-severity first touch (× outcome/size factors). */
  const WHEEL_DAMAGE_INSTANT = 0.65;
  /** Body/wheel damage per second of sustained full-severity grinding contact. */
  const DAMAGE_GRIND_RATE = 0.3;
  /** Wheels catch debris even from small rocks: their size factor never drops below this. */
  const WHEEL_SIZE_FLOOR = 0.3;
  /** Maximum deterministic crumple tilt (radians) for a fully crushed body panel. */
  const BODY_CRUMPLE_TILT_MAX = 0.12;

  interface BodyPartRecord {
    entity: Entity;
    centerX: number;
    centerZ: number;
    baseX: number;
    baseY: number;
    baseZ: number;
    tiltAxis: Vec3;
  }
  const bodyPartRecords: BodyPartRecord[] = [];
  interface WheelPartRecord {
    entity: Entity;
    renderable: Renderable;
    part: GlbPart;
  }
  const wheelPartRecords: WheelPartRecord[][] = WHEELS.map(() => []);
  const crushOffset = { x: 0, y: 0, z: 0 };
  const crushPos = new Vec3();
  const crushQuat = new Quat();
  const detachQuat = new Quat();
  const detachTip = new Quat();

  const hashName = (name: string): number => {
    let h = 0;
    for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
    return h;
  };

  /** Repose every recorded body part from the live crush zones (no-op while pristine). */
  const applyBodyCrush = (): void => {
    for (const rec of bodyPartRecords) {
      computeBodyCrushOffset(rec.centerX, rec.centerZ, damageZones, crushOffset);
      rec.entity.transform.position = crushPos.set(
        rec.baseX + crushOffset.x,
        rec.baseY + crushOffset.y,
        rec.baseZ + crushOffset.z,
      );
      const severity = Math.min(
        1,
        (Math.abs(crushOffset.x) + Math.abs(crushOffset.y) + Math.abs(crushOffset.z)) / 0.3,
      );
      rec.entity.transform.rotation = crushQuat.setAxisAngle(rec.tiltAxis, severity * BODY_CRUMPLE_TILT_MAX);
    }
  };

  /** Drop a torn-off wheel's meshes on the ground where it came off (shared GLB resources). */
  const spawnDetachedWheelProp = (index: number): void => {
    const parts = wheelPartRecords[index];
    if (!parts || parts.length === 0) return;
    const root = wheelRoots[index]!;
    const p = root.transform.position;
    const propY = deformedGroundHeight(p.x, p.z) + WHEEL_RADIUS * 0.35;
    // Lying flat with a deterministic yaw so repeat rams read differently per corner.
    detachQuat.setAxisAngle(AXIS_Y, index * 1.3);
    detachTip.setAxisAngle(AXIS_Z, Math.PI / 2);
    detachQuat.multiply(detachTip);
    for (const rec of parts) {
      const prop = scene.createTransformedEntity(`detached-${WHEELS[index]!.name}-part`, new Vec3(p.x, propY, p.z));
      prop.transform.rotation = detachQuat;
      const renderable = new Renderable();
      renderable.geometry = rec.part.geometry;
      renderable.material = rec.part.material;
      renderable.castShadow = true;
      renderable.receiveShadow = true;
      scene.world.addComponent(prop.id, renderable);
    }
  };

  /** Tear a wheel off: mechanically dead, meshes hidden, wreckage dropped on the ground. */
  const detachWheel = (index: number): void => {
    const wheel = vehicle.wheels[index];
    if (!wheel || detachedWheels.has(index)) return;
    wheel.disabled = true;
    wheel.driven = false;
    wheel.steered = false;
    wheel.bend = 0;
    detachedWheels.add(index);
    for (const rec of wheelPartRecords[index] ?? []) rec.renderable.visible = false;
    spawnDetachedWheelProp(index);
  };

  /**
   * Accumulate area damage from one assessed contact. `forward`/`right` come from the contact
   * normal in vehicle frame, so the rammed corner crushes; big rocks dent more than pebbles;
   * the nearest wheel takes the debris. Blocked grinds keep wearing while they last; a pushed
   * rock only dents when the hit shatters it (a clean shove that rolls away is harmless).
   */
  const applyImpactZoneDamage = (
    rockX: number,
    rockZ: number,
    nx: number,
    nz: number,
    collisionRadius: number,
    assessment: { outcome: string; impactForce: number },
    firstTouch: boolean,
    breaking: boolean,
    dt: number,
  ): void => {
    if (assessment.outcome !== "blocked" && !breaking) return;
    const severity = Math.min(
      1,
      Math.max(0, (assessment.impactForce - IMPACT_DAMAGE_THRESHOLD) / IMPACT_DAMAGE_RANGE),
    );
    if (severity <= 0) return;
    const outcomeFactor = assessment.outcome === "blocked" ? 1 : 0.8;
    const sizeFactor = Math.min(1, Math.max(0.15, collisionRadius / 0.8));
    const wheelSize = Math.max(sizeFactor, WHEEL_SIZE_FLOOR);
    const sinYaw = Math.sin(vehicle.yaw);
    const cosYaw = Math.cos(vehicle.yaw);
    const forward = nx * sinYaw + nz * cosYaw;
    const right = nx * cosYaw - nz * sinYaw;
    const instant = firstTouch ? 1 : 0;
    applyBodyDamage(
      damageZones,
      forward,
      right,
      severity * outcomeFactor * sizeFactor * (instant * BODY_DAMAGE_INSTANT + dt * DAMAGE_GRIND_RATE),
    );
    let nearest = 0;
    let best = Number.POSITIVE_INFINITY;
    for (let i = 0; i < WHEELS.length; i++) {
      const spec = WHEELS[i]!;
      const wx = vehicle.position.x + spec.x * cosYaw + spec.z * sinYaw;
      const wz = vehicle.position.z - spec.x * sinYaw + spec.z * cosYaw;
      const d = (wx - rockX) * (wx - rockX) + (wz - rockZ) * (wz - rockZ);
      if (d < best) {
        best = d;
        nearest = i;
      }
    }
    if (!detachedWheels.has(nearest)) {
      applyWheelDamage(
        wheelDamage,
        nearest,
        severity * outcomeFactor * wheelSize * (instant * WHEEL_DAMAGE_INSTANT + dt * DAMAGE_GRIND_RATE),
      );
      if (wheelDamage[nearest]! >= WHEEL_DETACH_DAMAGE) detachWheel(nearest);
      else vehicle.wheels[nearest]!.bend = wheelDamage[nearest]! * WHEEL_BEND_MAX;
    }
    applyBodyCrush();
  };
  const trackMesh = createBox(gpu, { width: 0.22, height: 0.012, depth: 0.72 });
  const trackMaterial = Material.unlit({ label: "mars-wheel-tracks", color: 0x4b3028, opacity: 0.42, transparent: true });
  const trackMarks = Array.from({ length: 256 }, (_, index) => {
    const entity = scene.createTransformedEntity(`mars-track-${index}`, new Vec3(0, -400, 0));
    const renderable = new Renderable();
    renderable.geometry = trackMesh;
    renderable.material = trackMaterial;
    renderable.castShadow = false;
    renderable.receiveShadow = false;
    renderable.transparent = true;
    renderable.visible = false;
    scene.world.addComponent(entity.id, renderable);
    return { entity, renderable };
  });
  const lastTrack = WHEELS.map(() => ({ x: Number.NaN, z: Number.NaN }));
  let nextTrack = 0;
  let visibleTrackMarks = 0;
  const trackRotation = new Quat();

  // Push-trail pools: shoving a rock gouges a dark furrow behind it and piles a dirt mound on
  // its backside. Ring buffers like the wheel tracks (the deformation field's 4 m cells are far
  // too coarse for rock-scale ruts, so trails are decals, not heightfield edits).
  const furrowMesh = createBox(gpu, { width: 1, height: 0.012, depth: 1 });
  const furrowMaterial = Material.unlit({ label: "mars-push-furrows", color: 0x3a241c, opacity: 0.55, transparent: true });
  const furrowMarks = Array.from({ length: 128 }, (_, index) => {
    const entity = scene.createTransformedEntity(`mars-furrow-${index}`, new Vec3(0, -400, 0));
    const renderable = new Renderable();
    renderable.geometry = furrowMesh;
    renderable.material = furrowMaterial;
    renderable.castShadow = false;
    renderable.receiveShadow = false;
    renderable.transparent = true;
    renderable.visible = false;
    scene.world.addComponent(entity.id, renderable);
    return { entity, renderable };
  });
  let nextFurrow = 0;
  const moundMesh = createSphere(gpu, { radius: 0.5 });
  const moundMaterial = new Material({ label: "mars-push-mounds", color: 0x8a5a3c, roughness: 1 });
  const moundMarks = Array.from({ length: 64 }, (_, index) => {
    const entity = scene.createTransformedEntity(`mars-mound-${index}`, new Vec3(0, -400, 0));
    const renderable = new Renderable();
    renderable.geometry = moundMesh;
    renderable.material = moundMaterial;
    renderable.castShadow = false;
    renderable.receiveShadow = true;
    renderable.visible = false;
    scene.world.addComponent(entity.id, renderable);
    return { entity, renderable };
  });
  let nextMound = 0;
  const trailRotation = new Quat();

  const toolMarkResources: { dispose(): void }[] = [];
  const drillHoleGeometry = createCylinder(gpu, { radiusTop: 0.078, radiusBottom: 0.092, height: 0.012, radialSegments: 18, capped: true });
  const drillRimGeometry = createTorus(gpu, { radius: 0.102, tube: 0.009 });
  const abrasionMarkGeometry = createCylinder(gpu, { radiusTop: 0.14, radiusBottom: 0.14, height: 0.008, radialSegments: 20, capped: true });
  const analysisRingGeometry = createTorus(gpu, { radius: 0.16, tube: 0.012 });
  const drillHoleMaterial = Material.unlit({ label: "mars-drill-hole", color: 0x211610 });
  const drillRimMaterial = Material.unlit({ label: "mars-drill-rim", color: 0xb96c3e });
  const abrasionMarkMaterial = Material.unlit({ label: "mars-abrasion-mark", color: 0x714832 });
  const analysisRingMaterial = Material.emissive(0xffa84d, 1.8, { label: "mars-pixl-scan-ring", transparent: true, opacity: 0.82 });
  toolMarkResources.push(
    drillHoleGeometry, drillRimGeometry, abrasionMarkGeometry, analysisRingGeometry,
    drillHoleMaterial, drillRimMaterial, abrasionMarkMaterial, analysisRingMaterial,
  );

  /**
   * Stamp one furrow segment + backside mound for a rock that moved from (fromX, fromZ) to
   * (toX, toZ). The furrow spans the segment (widened to the rock's footprint); the mound sits
   * just behind the rock's leading edge, where the shoved dirt piles up.
   */
  const stampPushTrail = (
    fromX: number,
    fromZ: number,
    toX: number,
    toZ: number,
    rockRadius: number,
  ): void => {
    const segX = toX - fromX;
    const segZ = toZ - fromZ;
    const segLen = Math.hypot(segX, segZ);
    if (segLen < 1e-6) return;
    const dirX = segX / segLen;
    const dirZ = segZ / segLen;
    const midX = (fromX + toX) / 2;
    const midZ = (fromZ + toZ) / 2;
    const furrow = furrowMarks[nextFurrow]!;
    nextFurrow = (nextFurrow + 1) % furrowMarks.length;
    trailRotation.setAxisAngle(AXIS_Y, Math.atan2(dirX, dirZ));
    syncEntityPose(
      furrow.entity,
      new Vec3(midX, deformedGroundHeight(midX, midZ) + 0.015, midZ),
      trailRotation,
    );
    setEntityScale(furrow.entity, rockRadius * 2.2, 1, segLen + rockRadius * 1.2);
    furrow.renderable.visible = true;
    const moundW = rockRadius * (1.0 + Math.random() * 0.5);
    const moundH = moundW * 0.38;
    const moundX = toX - dirX * rockRadius * 1.1;
    const moundZ = toZ - dirZ * rockRadius * 1.1;
    const mound = moundMarks[nextMound]!;
    nextMound = (nextMound + 1) % moundMarks.length;
    syncEntityPose(
      mound.entity,
      new Vec3(moundX, deformedGroundHeight(moundX, moundZ) + moundH * 0.3, moundZ),
      // Mounds are never rotated (radially symmetric) — identity keeps the slot untouched.
      new Quat(),
    );
    setEntityScale(mound.entity, moundW, moundH, moundW);
    mound.renderable.visible = true;
  };
  const INTERACTION_RADIUS = 48;
  const MAX_INTERACTIVE_ROCKS = 64;
  /**
   * Population types the interaction layer promotes, with the collision radii their geometry was
   * built at. Both rock variants share the 0.8 m radius (only the displacement seed differs), so
   * one table row each keeps the sync, ids and active-entity geometry in agreement.
   */
  const INTERACTIVE_ROCK_TYPES = [
    { typeId: 1, label: "rocks", baseRadius: 0.8, baseFlatten: 0 },
    { typeId: 3, label: "rocks-b", baseRadius: 0.8, baseFlatten: 0 },
    { typeId: 2, label: "boulders", baseRadius: 2.4, baseFlatten: 0.38 },
  ] as const;
  const interactiveGeometryForType = (typeId: number): Geometry =>
    typeId === 2 ? boulderGeometry : typeId === 3 ? rockGeometryB : rockGeometry;

  const syncInteractiveRocks = (): void => {
    const wanted = new Set<string>();
    for (const [chunkKey, chunk] of terrain.chunks) {
      if (chunk.state !== "ready") continue;
      for (const { typeId, label, baseRadius, baseFlatten } of INTERACTIVE_ROCK_TYPES) {
        const block = population.chunkPopulation(chunkKey, typeId);
        if (!block) continue;
        for (let i = 0; i < block.count; i++) {
          const p = i * 3;
          const id = `${chunkKey}:${label}:${i}`;
          if (brokenInteractiveRockIds.has(id)) continue;
          const existing = interactiveRocks.get(id);
          // Zeroed scales mark a removed instance — unless a live record already tracks it, in
          // which case this is an awake/settled rock whose entity replaced the instance. Those
          // stay wanted: evicting them every frame would discard the body's momentum (shoved
          // rocks could never roll), churn the entity every other frame, and wipe per-record
          // state like the push-trail cursor.
          if (!existing && block.scales[p] === 0 && block.scales[p + 1] === 0) continue;
          // Tracked rocks anchor to the BODY (the hidden instance sits at a stale spot).
          const anchorX = existing ? existing.proxy.body.position.x : block.positions[p]!;
          const anchorZ = existing ? existing.proxy.body.position.z : block.positions[p + 2]!;
          const dx = anchorX - vehicle.position.x;
          const dz = anchorZ - vehicle.position.z;
          if (dx * dx + dz * dz > INTERACTION_RADIUS * INTERACTION_RADIUS) continue;
          if (!existing && interactiveRocks.size >= MAX_INTERACTIVE_ROCKS) continue;
          wanted.add(id);
          if (existing) continue;

          const rawSx = block.scales[p]! * baseRadius;
          const rawSy = block.scales[p + 1]! * baseRadius * (1 - baseFlatten);
          const rawSz = block.scales[p + 2]! * baseRadius;

          // Natural stability: rocks resting on terrain lie flat on their thinnest dimension
          const minDim = Math.min(rawSx, rawSy, rawSz);
          const sy = minDim;
          const sx = rawSx === minDim ? rawSy : rawSx;
          const sz = rawSz === minDim ? rawSy : rawSz;

          const isFlat = sy < 0.70 * Math.max(sx, sz);

          const posX = block.positions[p]!;
          const posZ = block.positions[p + 2]!;
          const groundY = deformedGroundHeight(posX, posZ);

          let shape: Shape;
          let restingY: number;
          let climbRadius: number;
          if (isFlat) {
            const hx = Math.max(0.12, sx * 0.5);
            const hy = Math.max(0.06, sy * 0.5);
            const hz = Math.max(0.12, sz * 0.5);
            shape = new BoxShape(hx, hy, hz);
            restingY = groundY + hy;
            climbRadius = Math.max(hx, hz);
          } else {
            const radius = Math.max(0.12, ((sx + sy + sz) / 3) * 0.55);
            shape = new SphereShape(radius);
            restingY = groundY + radius;
            climbRadius = radius;
          }

          const spec = createInteractiveRockSpec({
            id,
            shape,
            material: MARS_ROCK_MATERIAL,
            climbRadius,
          });

          const proxy = new InteractiveRockProxy(spec, { x: posX, y: restingY, z: posZ });
          proxy.body.linearVelocity.set(0, 0, 0);
          proxy.body.angularVelocity.set(0, 0, 0);
          proxy.body.rotation.setAxisAngle(new Vec3(0, 1, 0), block.rotations[i]!);
          proxy.body.prevPosition.copyFrom(proxy.body.position);
          proxy.body.prevRotation.copyFrom(proxy.body.rotation);
          proxy.body.renderPosition.copyFrom(proxy.body.position);
          proxy.body.renderRotation.copyFrom(proxy.body.rotation);

          if (isFlat) {
            proxy.body.angularDamping = 0.25;
            proxy.body.linearDamping = 0.15;
            proxy.body.friction = 0.95;
          } else {
            proxy.body.angularDamping = 0.05;
            proxy.body.linearDamping = 0.02;
            proxy.body.friction = 0.6;
          }

          // Uncontacted rocks remain dormant static colliders until touched
          proxy.body.type = "static";
          interactivePhysics.addBody(proxy.body);
          interactiveRocks.set(id, {
            block,
            index: i,
            proxy,
            typeId,
            isFlat,
            origScaleX: block.scales[p]!,
            origScaleY: block.scales[p + 1]!,
            origScaleZ: block.scales[p + 2]!,
            restOffsetY: restingY - groundY,
            trailRadius: climbRadius,
            lastTrailX: Number.NaN,
            lastTrailZ: Number.NaN,
            activeEntity: null,
            awake: false,
            settledTimer: 0,
          });
        }
      }
    }
    for (const [id, record] of interactiveRocks) {
      if (wanted.has(id)) continue;
      interactivePhysics.removeBody(record.proxy.body);
      if (record.activeEntity) {
        const p = record.index * 3;
        const q = record.proxy.body.rotation;
        const yaw = Math.atan2(2 * (q.w * q.y + q.x * q.z), 1 - 2 * (q.y * q.y + q.z * q.z));
        record.block.positions[p] = record.proxy.body.position.x;
        // snapY: the restored Y is authoritative, so the anchor target moves with it — Y
        // settling must never drag a restored rock back toward a stale remesh target.
        record.block.snapY(record.index, record.proxy.body.position.y - (record.isFlat ? record.origScaleY * 0.4 : record.origScaleY * 0.5));
        record.block.positions[p + 2] = record.proxy.body.position.z;
        record.block.scales[p] = record.origScaleX;
        record.block.scales[p + 1] = record.origScaleY;
        record.block.scales[p + 2] = record.origScaleZ;
        record.block.rotations[record.index] = yaw;
        record.block.markModified();
        scene.world.destroyEntity(record.activeEntity.id);
      }
      interactiveRocks.delete(id);
    }
  };

  const breakRock = (
    record: InteractiveRockRecord,
    nx: number,
    nz: number,
    approach: number,
  ): void => {
    const id = record.proxy.spec.id;
    const body = record.proxy.body;
    const posX = body.position.x;
    const posZ = body.position.z;

    // 1. Remove original rock from population block and physics
    record.block.scales[record.index * 3] = 0;
    record.block.scales[record.index * 3 + 1] = 0;
    record.block.scales[record.index * 3 + 2] = 0;
    record.block.markModified();

    if (record.activeEntity) {
      scene.world.destroyEntity(record.activeEntity.id);
      record.activeEntity = null;
    }
    interactivePhysics.removeBody(body);
    interactiveRocks.delete(id);
    brokenInteractiveRockIds.add(id);
    brokenInteractiveRocks++;

    // 2. Spawn smaller rocks: a few large chunks, then a small pile of pebbles
    // "Never should the broken pieces be larger then the original"
    const origBaseScale = record.typeId === 2 ? 2.4 : 0.8;
    const origScale = ((record.origScaleX + record.origScaleY + record.origScaleZ) / 3) * origBaseScale;

    const numChunks = 3;
    const numPebbles = 6;

    // Size every fragment before placing any: the layout needs all footprints upfront (and
    // largest-first) so no two spawn interpenetrating.
    interface FragmentSize {
      readonly scale: number;
      readonly sy: number;
      readonly isFlat: boolean;
      readonly radius: number;
    }
    const sizes: FragmentSize[] = [];
    for (let c = 0; c < numChunks; c++) {
      // Strict constraint: chunk scale strictly < original scale
      const chunkScale = Math.min(origScale * 0.45, Math.max(0.12, origScale * (0.3 + 0.1 * Math.random())));
      const isFlatChunk = c % 2 === 0;
      sizes.push({
        scale: chunkScale,
        // Round chunks collide as spheres, so their visual Y matches XZ exactly (a squashed
        // visual on a spherical collider would float its belly above the ground).
        sy: isFlatChunk ? chunkScale * 0.45 : chunkScale,
        isFlat: isFlatChunk,
        radius: chunkScale * 0.5,
      });
    }
    for (let p = 0; p < numPebbles; p++) {
      // Strict constraint: pebble scale strictly < original scale
      const pebbleScale = Math.min(origScale * 0.18, Math.max(0.05, origScale * (0.1 + 0.06 * Math.random())));
      sizes.push({ scale: pebbleScale, sy: pebbleScale, isFlat: false, radius: pebbleScale * 0.5 });
    }
    const spots = layoutBreakFragments(
      sizes.map((s) => s.radius),
      posX,
      posZ,
      nx,
      nz,
    );

    const evictOldestFragment = (): void => {
      if (fragments.length < MAX_FRAGMENTS) return;
      const oldest = fragments.shift()!;
      interactivePhysics.removeBody(oldest.body);
      scene.world.destroyEntity(oldest.entity.id);
    };

    for (let c = 0; c < numChunks; c++) {
      evictOldestFragment();
      const size = sizes[c]!;
      const spot = spots[c]!;
      const fx = spot.x;
      const fz = spot.z;
      const groundH = deformedGroundHeight(fx, fz);

      let chunkShape: Shape;
      let restingY: number;
      if (size.isFlat) {
        chunkShape = new BoxShape(size.scale * 0.5, size.sy * 0.5, size.scale * 0.5);
        restingY = groundH + size.sy * 0.5;
      } else {
        const r = size.scale * 0.5;
        chunkShape = new SphereShape(r);
        restingY = groundH + r;
      }

      const chunkMass = Math.max(1, size.scale * size.scale * size.scale * 120);
      const chunkBody = new RigidBody({
        type: "dynamic",
        shape: chunkShape,
        mass: chunkMass,
        position: { x: fx, y: restingY, z: fz },
        friction: size.isFlat ? 0.95 : 0.6,
        linearDamping: size.isFlat ? 0.2 : 0.03,
        angularDamping: size.isFlat ? 8.0 : 0.05,
        restitution: 0.1,
      });

      // Scatter outward from the impact point plus the push-through, hard enough that gravity
      // and the solver separate the pile instead of freezing it mid-stack.
      const pushSpeed = 0.6 + approach * 0.9;
      const outSpeed = 1.0 + Math.random() * 1.0;
      const radial = Math.hypot(fx - posX, fz - posZ);
      const dirX = radial > 1e-6 ? (fx - posX) / radial : Math.cos((c / numChunks) * Math.PI * 2);
      const dirZ = radial > 1e-6 ? (fz - posZ) / radial : Math.sin((c / numChunks) * Math.PI * 2);
      chunkBody.linearVelocity.x = nx * pushSpeed + dirX * outSpeed;
      chunkBody.linearVelocity.y = 0.8 + Math.random() * 0.7;
      chunkBody.linearVelocity.z = nz * pushSpeed + dirZ * outSpeed;

      if (!size.isFlat) {
        chunkBody.angularVelocity.x = (Math.random() - 0.5) * 8;
        chunkBody.angularVelocity.y = (Math.random() - 0.5) * 4;
        chunkBody.angularVelocity.z = (Math.random() - 0.5) * 8;
      }

      interactivePhysics.addBody(chunkBody);

      const entity = scene.createTransformedEntity(`rock-chunk-${id}-${c}`, new Vec3(fx, restingY, fz));
      const renderable = new Renderable();
      renderable.geometry = chunkGeometry;
      renderable.material = rockMaterial;
      renderable.castShadow = true;
      renderable.receiveShadow = true;
      scene.world.addComponent(entity.id, renderable);
      // Visual matches collision: collision half-extent ÷ geometry radius, per axis.
      setEntityScale(
        entity,
        (size.scale * 0.5) / CHUNK_GEO_RADIUS_XZ,
        (size.sy * 0.5) / CHUNK_GEO_RADIUS_Y,
        (size.scale * 0.5) / CHUNK_GEO_RADIUS_XZ,
      );

      fragments.push({
        id: `chunk-${id}-${c}`,
        body: chunkBody,
        entity,
        isFlat: size.isFlat,
        scale: size.scale,
        awake: true,
        settledTimer: 0,
        age: 0,
      });
    }

    for (let p = 0; p < numPebbles; p++) {
      evictOldestFragment();
      const size = sizes[numChunks + p]!;
      const spot = spots[numChunks + p]!;
      const fx = spot.x;
      const fz = spot.z;
      const groundH = deformedGroundHeight(fx, fz);

      const pebbleR = size.scale * 0.5;
      const pebbleShape = new SphereShape(pebbleR);
      const restingY = groundH + pebbleR;

      const pebbleBody = new RigidBody({
        type: "dynamic",
        shape: pebbleShape,
        mass: Math.max(0.1, size.scale * size.scale * size.scale * 120),
        position: { x: fx, y: restingY, z: fz },
        friction: 0.7,
        linearDamping: 0.05,
        angularDamping: 0.1,
        restitution: 0.15,
      });

      const pPush = 0.5 + approach * 0.7;
      const pOut = 1.2 + Math.random() * 1.2;
      const pRadial = Math.hypot(fx - posX, fz - posZ);
      const pDirX = pRadial > 1e-6 ? (fx - posX) / pRadial : Math.cos((p / numPebbles) * Math.PI * 2);
      const pDirZ = pRadial > 1e-6 ? (fz - posZ) / pRadial : Math.sin((p / numPebbles) * Math.PI * 2);
      pebbleBody.linearVelocity.x = nx * pPush + pDirX * pOut;
      pebbleBody.linearVelocity.y = 0.9 + Math.random() * 0.8;
      pebbleBody.linearVelocity.z = nz * pPush + pDirZ * pOut;
      pebbleBody.angularVelocity.x = (Math.random() - 0.5) * 12;
      pebbleBody.angularVelocity.z = (Math.random() - 0.5) * 12;

      interactivePhysics.addBody(pebbleBody);

      const entity = scene.createTransformedEntity(`rock-pebble-${id}-${p}`, new Vec3(fx, restingY, fz));
      const renderable = new Renderable();
      renderable.geometry = pebbleGeometry;
      renderable.material = rockMaterial;
      renderable.castShadow = true;
      renderable.receiveShadow = true;
      scene.world.addComponent(entity.id, renderable);
      // Visual matches collision: collision half-extent ÷ geometry radius, per axis.
      setEntityScale(
        entity,
        pebbleR / PEBBLE_GEO_RADIUS_XZ,
        pebbleR / PEBBLE_GEO_RADIUS_Y,
        pebbleR / PEBBLE_GEO_RADIUS_XZ,
      );

      fragments.push({
        id: `pebble-${id}-${p}`,
        body: pebbleBody,
        entity,
        isFlat: false,
        scale: size.scale,
        awake: true,
        settledTimer: 0,
        age: 0,
      });
    }
  };

  const stepInteractiveRocks = (dt: number): void => {
    syncInteractiveRocks();
    const vx = vehicle.velocity.x;
    const vz = vehicle.velocity.z;
    const toBreak: Array<{ record: InteractiveRockRecord; nx: number; nz: number; approach: number }> = [];

    for (const record of interactiveRocks.values()) {
      const body = record.proxy.body;
      const dx = body.position.x - vehicle.position.x;
      const dz = body.position.z - vehicle.position.z;
      const distance = Math.hypot(dx, dz);
      const collisionRadius = record.isFlat
        ? Math.max(record.origScaleX, record.origScaleZ) * (record.typeId === 2 ? 1.2 : 0.4)
        : (body.shape instanceof SphereShape ? body.shape.radius : 0.5);
      const obstacleHeight = record.isFlat
        ? record.origScaleY * (record.typeId === 2 ? 1.44 : 0.8)
        : collisionRadius * 2;

      if (distance > 1e-4 && distance < 1.6 + collisionRadius) {
        const nx = dx / distance;
        const nz = dz / distance;
        const approach = vx * nx + vz * nz;
        if (approach > 0.04) {
          const firstTouch = !record.awake;
          record.awake = true;
          // Clean handoff: wake exactly on today's surface (never a stale resting Y), with the
          // integration history synced so the first dynamic step starts from rest, not from a
          // teleport the solver would answer with a velocity kick.
          const waking = record.proxy.body;
          waking.type = "dynamic";
          waking.position.y = deformedGroundHeight(waking.position.x, waking.position.z) + record.restOffsetY;
          waking.prevPosition.copyFrom(waking.position);
          waking.renderPosition.copyFrom(waking.position);
          waking.linearVelocity.set(0, 0, 0);
          waking.angularVelocity.set(0, 0, 0);
          const assessment = bridgeRockContact(record.proxy, {
            roverMass: 1025,
            relativeSpeed: approach,
            availableForce: ROVER_TRACTIVE_FORCE,
            obstacleHeight,
            vehicleVelocity: vehicle.velocity,
          }, { x: nx, y: 0, z: nz });
          applyRoverImpactDamage(roverDamage, assessment, {
            roverMass: 1025,
            relativeSpeed: approach,
            availableForce: ROVER_TRACTIVE_FORCE,
            obstacleHeight,
          }, obstacleHeight, dt);
          // Impacts may shove a rock or damage the rover, but fracture is gated solely by the
          // material crush threshold. The Mars profile puts that threshold far beyond rover power.
          const breaking = assessment.outcome === "crushed";
          applyImpactZoneDamage(
            body.position.x,
            body.position.z,
            nx,
            nz,
            collisionRadius,
            assessment,
            firstTouch,
            breaking,
            dt,
          );
          if (breaking) {
            toBreak.push({ record, nx, nz, approach });
          }
        }
      }
    }

    for (const item of toBreak) {
      breakRock(item.record, item.nx, item.nz, item.approach);
    }

    // Keep uncontacted rocks stationary so they never shoot up or jitter. Dormant bodies
    // also re-ground every frame: when the terrain mesh refines under a chunk, a stale resting Y
    // would otherwise make the rock drop (or pop) the moment the rover touches it.
    for (const record of interactiveRocks.values()) {
      if (!record.awake) {
        const dormant = record.proxy.body;
        dormant.type = "static";
        dormant.linearVelocity.set(0, 0, 0);
        dormant.angularVelocity.set(0, 0, 0);
        dormant.position.y = deformedGroundHeight(dormant.position.x, dormant.position.z) + record.restOffsetY;
      }
    }

    interactivePhysics.step(dt);

    for (const record of interactiveRocks.values()) {
      const body = record.proxy.body;
      if (!record.awake) {
        body.linearVelocity.set(0, 0, 0);
        body.angularVelocity.set(0, 0, 0);
        continue;
      }

      if (!record.activeEntity) {
        const entity = scene.createTransformedEntity(
          `active-rock-${record.proxy.spec.id}`,
          new Vec3(body.position.x, body.position.y, body.position.z),
        );
        const renderable = new Renderable();
        renderable.geometry = interactiveGeometryForType(record.typeId);
        renderable.material = rockMaterial;
        renderable.castShadow = true;
        renderable.receiveShadow = true;
        scene.world.addComponent(entity.id, renderable);
        record.activeEntity = entity;
        // The entity replaces the hidden instance at the instance's scale (constant for life).
        setEntityScale(entity, record.origScaleX, record.origScaleY, record.origScaleZ);

        record.block.scales[record.index * 3] = 0;
        record.block.scales[record.index * 3 + 1] = 0;
        record.block.scales[record.index * 3 + 2] = 0;
        record.block.markModified();
      }

      const rockSpeed = body.linearVelocity.length();
      if (rockSpeed > MAX_ROCK_SPEED) body.linearVelocity.scale(MAX_ROCK_SPEED / rockSpeed);

      // Update full 3D pose: pitch, roll, and yaw!
      syncEntityPose(record.activeEntity, body.position, body.rotation);

      // Push trail: every stretch of shoved (or rolling) travel gouges a furrow segment and
      // piles a dirt mound on the rock's backside.
      const trailX = body.position.x;
      const trailZ = body.position.z;
      if (!Number.isFinite(record.lastTrailX)) {
        record.lastTrailX = trailX;
        record.lastTrailZ = trailZ;
      } else if (Math.hypot(trailX - record.lastTrailX, trailZ - record.lastTrailZ) >= 0.3) {
        stampPushTrail(record.lastTrailX, record.lastTrailZ, trailX, trailZ, record.trailRadius);
        record.lastTrailX = trailX;
        record.lastTrailZ = trailZ;
      }

      const spd = body.linearVelocity.length() + body.angularVelocity.length();
      if (spd < 0.03) {
        record.settledTimer += dt;
        if (record.settledTimer > 0.5) {
          body.linearVelocity.set(0, 0, 0);
          body.angularVelocity.set(0, 0, 0);
          body.type = "static";
          record.awake = false;
        }
      } else {
        record.settledTimer = 0;
      }
    }

    // Step fragments
    for (let f = fragments.length - 1; f >= 0; f--) {
      const frag = fragments[f]!;
      const dx = frag.body.position.x - vehicle.position.x;
      const dz = frag.body.position.z - vehicle.position.z;
      if (dx * dx + dz * dz > (INTERACTION_RADIUS + 12) * (INTERACTION_RADIUS + 12)) {
        interactivePhysics.removeBody(frag.body);
        scene.world.destroyEntity(frag.entity.id);
        fragments.splice(f, 1);
        continue;
      }
      frag.age += dt;
      const fragSpeed = frag.body.linearVelocity.length();
      if (fragSpeed > MAX_ROCK_SPEED) frag.body.linearVelocity.scale(MAX_ROCK_SPEED / fragSpeed);
      syncEntityPose(frag.entity, frag.body.position, frag.body.rotation);
      const spd = frag.body.linearVelocity.length() + frag.body.angularVelocity.length();
      if (spd < 0.03 && frag.age >= MIN_FRAGMENT_AWAKE) {
        frag.settledTimer += dt;
        if (frag.settledTimer > 0.5) {
          frag.body.linearVelocity.set(0, 0, 0);
          frag.body.angularVelocity.set(0, 0, 0);
          frag.awake = false;
        }
      } else {
        frag.settledTimer = 0;
      }
    }
  };

  // "Where the rover is supposed to be" wireframe (loading screen's companion diagnostic). `auto`
  // keeps the boxes up until the GLB lands so an invisible-model report always has an answer on
  // screen: the yellow footprint + green hub boxes mark the pose even with no mesh attached.
  let debugBoundsMode: "auto" | "on" | "off" = "auto";
  scene.world.registerSystem(
    new RoverDebugBounds(() => {
      if (disposed) return null;
      const active = debugBoundsMode === "on" || (debugBoundsMode === "auto" && !modelLoaded);
      return active ? { chassis: chassis.id, wheels: wheelIds } : null;
    }),
  );

  // ---------------------------------------------------------------- dust (ambient + wheel kick)
  const sampleKick = (wheelIndex: number): WheelKickSample | null => {
    const wheel = vehicle.wheels[wheelIndex];
    if (!wheel || !wheel.inContact || wheel.normalLoad <= 0) return null;
    return {
      x: wheel.contactX,
      y: wheel.contactY,
      z: wheel.contactZ,
      speed: vehicle.speed,
      velocityX: vehicle.velocity.x,
      velocityZ: vehicle.velocity.z,
      yaw: vehicle.yaw,
      side: wheel.x < 0 ? -1 : 1,
      normalLoad: wheel.normalLoad,
      slipRatio: wheel.kappa,
      slipAngle: wheel.alpha,
      longitudinalForce: wheel.longForce,
      lateralForce: wheel.latForce,
      throttle: vehicle.input.throttle,
      brake: vehicle.input.brake,
    };
  };

  const ambientDust = new AmbientDustField(cameraEntity);
  scene.add(ambientDust);
  const toolDust = new RoverToolDustField();
  scene.add(toolDust);
  const kickDustWheels = vehicle.wheels.map((_, index) => {
    const dust = new WheelKickDust(index, () => sampleKick(index));
    scene.add(dust);
    return dust;
  });
  const wheelRockChips = vehicle.wheels.map((_, index) => {
    const chips = new WheelRockChips(index, () => sampleKick(index));
    scene.add(chips);
    return chips;
  });
  const kickDustAlive = (): number => kickDustWheels.reduce((total, dust) => total + dust.simulation.alive, 0);
  const wheelRockChipsAlive = (): number => wheelRockChips.reduce((total, chips) => total + chips.simulation.alive, 0);

  // Smooth spheres replace the hard-edged cubes; low alpha lets overlapping, seeded puffs build a
  // translucent ochre plume instead of painting opaque tan blocks across the ground.
  const dustMesh = createSphere(gpu, { radius: 0.5, widthSegments: 12, heightSegments: 8 });
  const ambientDustMaterial = Material.unlit({ label: "dust-ambient", color: 0xc4a17e, opacity: 0.11, transparent: true });
  const kickDustMaterial = Material.unlit({ label: "dust-kick", color: 0xc68f5b, opacity: 0.25, transparent: true });
  const toolDustMaterial = Material.unlit({ label: "dust-rover-tool", color: 0xd9a270, opacity: 0.34, transparent: true });
  const spawnSprites = (
    world: ParticleWorld,
    count: number,
    material: Material,
    prefix: string,
    geometry: Geometry = dustMesh,
  ): void => {
    const ids: number[] = [];
    for (let i = 0; i < count; i++) {
      const mote = scene.createTransformedEntity(`${prefix}-${i}`, new Vec3(0, -400, 0));
      const renderable = new Renderable();
      renderable.geometry = geometry;
      renderable.material = material;
      renderable.castShadow = false;
      renderable.receiveShadow = false;
      // The renderer picks blending from the Renderable, not the material; mirror it explicitly so
      // the puffs layer while the rock chips retain opaque, depth-tested silhouettes.
      renderable.transparent = material.transparent;
      renderable.visible = false;
      scene.world.addComponent(mote.id, renderable);
      ids.push(mote.id);
    }
    world.spriteEntities = ids;
  };
  spawnSprites(ambientDust, AMBIENT_DUST_SPRITES, ambientDustMaterial, "dust-mote");
  spawnSprites(toolDust, TOOL_DUST_SPRITES, toolDustMaterial, "rover-tool-dust");
  for (const [index, dust] of kickDustWheels.entries()) {
    spawnSprites(dust, KICK_DUST_SPRITES_PER_WHEEL, kickDustMaterial, `dust-puff-wheel-${index}`);
  }
  for (const [index, chips] of wheelRockChips.entries()) {
    spawnSprites(chips, ROCK_CHIP_SPRITES_PER_WHEEL, rockMaterial, `rover-rock-chip-wheel-${index}`, rockGeometry);
  }

  // ---------------------------------------------------------------- NASA GLB (async swap-in)
  let modelLoaded = false;
  let modelError: string | null = null;
  let loaded: LoadedGlb | null = null;
  let disposed = false;
  let modelProgress: GlbLoadProgress | null = null;
  let loadAttempt = 0;

  // Mast deployment: `mastTarget` is the commanded state (MAST button / M key / `setMast`), `mastT`
  // the spring position the pivot quaternion follows. The pivot exists once the GLB lands; a
  // toggle before then just arms the target.
  let mastTarget = 0;
  let mastT = 0;
  let mastV = 0;
  let mastPivot: Entity | null = null;
  let mastUpperPivot: Entity | null = null;
  let mastHeadPivotEntity: Entity | null = null;
  let mastElapsed = 0;
  let mastAzimuthAngle = 0;
  let mastElevationAngle = 0;
  let mastElevationV = 0;
  const mastIdentity = new Quat();
  const mastDeployedQ = new Quat().fromUnitVectorY(
    new Vec3(MAST_STOWED_HEAD.x, MAST_STOWED_HEAD.y, MAST_STOWED_HEAD.z).normalize(),
  ).invert();
  const mastScratchQ = new Quat();
  const mastAzimuthQ = new Quat();
  const mastElevationQ = new Quat();

  // High-gain antenna: armed the moment the rover GLB lands, unfurled HGA_DEPLOY_DELAY_SECONDS
  // later, then tracking Earth for the life of the scene. Deliberately one-way — the controller
  // exposes no stow and the scene binds no key or pad button to one ("no way to lay it back
  // down"). The pivots only exist once the model lands; until then the controller stays stowed.
  const hga = new HighGainAntennaController();
  let hgaYawPivot: Entity | null = null;
  let hgaPitchPivot: Entity | null = null;
  const hgaYawQ = new Quat();
  const hgaPitchQ = new Quat();
  const hgaResources: { dispose(): void }[] = [];

  /** Push the gimbal angles onto the two pivot entities (no-op until the model lands). */
  const writeHgaPose = (): void => {
    if (!hgaYawPivot || !hgaPitchPivot) return;
    // Elevation is negated about +X the same way Vehicle pitch is: positive elevation tilts up.
    hgaYawPivot.transform.rotation = hgaYawQ.setAxisAngle(AXIS_Y, hga.azimuth);
    hgaPitchPivot.transform.rotation = hgaPitchQ.setAxisAngle(AXIS_X, -hga.elevation);
  };


  // Robotic arm: `arm` owns the choreography + jog state (commanded by the ARM button / R key /
  // `setArm`); `armPivots` are the GLB's joint entities, nested like its chain, with cached
  // transform handles so posing allocates nothing. Like the mast, a toggle before the model lands
  // only arms the target: the controller does not advance until the pivots exist, so the unfold
  // still plays once they do.
  const arm = new RoverArmController();
  const armPose = new Float64Array(ARM_JOINT_COUNT);
  const armReadyPose = Float64Array.from(ARM_READY_DEG, (degrees) => (degrees * Math.PI) / 180);
  const armTrsScratch = new TRS();
  const armInput: ArmJogInput = { swing: 0, shoulder: 0, elbow: 0, turret: 0 };
  let armPivots: { entity: Entity; axis: Vec3 }[] = [];
  // Mechanical half of the arm (Phase 16.6): one revolute joint per GLB pivot, posed by
  // `MechanicalSystem` from the controller's channels rather than by a hand-written write loop.
  // `wrap: false` is load-bearing: the unfold takes the elbow the long way round (−242°, see
  // roverArm.ts) and wrapping the value into (−π, π] would flip it to the short way through the
  // ground. Slew is 0 for the same reason it is in `RoverArmController`: the choreography already
  // runs through an acceleration ramp, so the joint follows it exactly.
  let armRig: MechanicalRig | null = null;
  const armSource: MechanicalChannelSource = {
    writeChannels(rig) {
      arm.pose(armPose);
      for (let j = 0; j < armPivots.length; j++) rig.setChannel(`arm${j}`, armPose[j] ?? 0);
    },
  };
  const bindArmRig = (): void => {
    if (armRig || armPivots.length === 0) return;
    armRig = new MechanicalRig(scene.world);
    for (let j = 0; j < armPivots.length; j++) {
      const pivot = armPivots[j]!;
      armRig.addJoint({
        entity: pivot.entity.id,
        kind: "revolute",
        axis: pivot.axis,
        channel: `arm${j}`,
        wrap: false,
      });
    }
    chassis.add(new MechanicalRigComponent(armRig, armSource));
  };

  const attachGlb = (glb: LoadedGlb): void => {
    // Body: drop the placeholder box, parent the model-root-space parts under the chassis with the
    // ground-plane offset (chassis sits at the CG, the model at its ground-centred origin).
    scene.world.removeComponent(chassis.id, Renderable);
    for (const part of glb.body) {
      const child = scene.createTransformedEntity(`rover-body-${part.name}`, new Vec3(0, bodyOffsetY, 0));
      chassis.addChild(child);
      child.transform.position = new Vec3(0, bodyOffsetY, 0);
      const renderable = new Renderable();
      renderable.geometry = part.geometry;
      renderable.material = part.material;
      renderable.castShadow = true;
      renderable.receiveShadow = true;
      scene.world.addComponent(child.id, renderable);
      // Crush anchor: the part's model-space centre picks which zone dents it; the hash gives
      // each panel a deterministic crumple axis so repeat impacts fold it the same way.
      const center = part.geometry.bounds.getCenter(new Vec3());
      const tiltHash = hashName(part.name);
      const tiltLen = Math.hypot(Math.sin(tiltHash), 0.35, Math.cos(tiltHash));
      bodyPartRecords.push({
        entity: child,
        centerX: center.x,
        centerZ: center.z,
        baseX: 0,
        baseY: bodyOffsetY,
        baseZ: 0,
        tiltAxis: new Vec3(Math.sin(tiltHash) / tiltLen, 0.35 / tiltLen, Math.cos(tiltHash) / tiltLen),
      });
    }
    // Wheels: hub-centred parts become children of the system-posed wheel roots (identity local).
    const byName = new Map(glb.wheels.map((w) => [w.name, w]));
    for (let i = 0; i < WHEELS.length; i++) {
      const spec = WHEELS[i]!;
      const root = wheelRoots[i]!;
      const wheel = byName.get(spec.name);
      if (!wheel) continue;
      scene.world.removeComponent(root.id, Renderable);
      for (const part of wheel.parts) {
        const child = scene.createTransformedEntity(`rover-${spec.name}-part`, new Vec3(0, 0, 0));
        root.addChild(child);
        child.transform.position = new Vec3(0, 0, 0);
        const renderable = new Renderable();
        renderable.geometry = part.geometry;
        renderable.material = part.material;
        renderable.castShadow = true;
        renderable.receiveShadow = true;
        scene.world.addComponent(child.id, renderable);
        wheelPartRecords[i]!.push({ entity: child, renderable, part });
      }
      // A wheel torn off before the model landed arrives already wrecked: hide its meshes and
      // drop the prop now that the parts exist.
      if (detachedWheels.has(i)) {
        for (const rec of wheelPartRecords[i] ?? []) rec.renderable.visible = false;
        spawnDetachedWheelProp(i);
      } else if (wheelDamage[i]! > 0) {
        vehicle.wheels[i]!.bend = wheelDamage[i]! * WHEEL_BEND_MAX;
      }
    }
    // Impacts during loading still dented the zones; repose the fresh parts to match.
    applyBodyCrush();
    // Mast: three-tier articulation hierarchy matching the real Perseverance joints.
    // Lower pivot (hinge) → upper pivot (azimuth) → head pivot (elevation).
    // Each tier's parts are offset so vertices stay in their original hinge-relative coords
    // when all rotations are identity, but rotate around their respective joint when animated.
    if (glb.mast && glb.mast.parts.length > 0 && glb.mast.lowerParts.length > 0) {
      const [px, py, pz] = glb.mast.pivot;
      const [jx, jy, jz] = glb.mast.joint;
      const [hx, hy, hz] = glb.mast.headPivot;

      // 1. Lower mast pivot at the deployment hinge (chassis-local).
      const lowerPivot = scene.createTransformedEntity("rover-mast-lower", new Vec3(px, py + bodyOffsetY, pz));
      chassis.addChild(lowerPivot);
      lowerPivot.transform.position = new Vec3(px, py + bodyOffsetY, pz);
      for (const part of glb.mast.lowerParts) {
        const child = scene.createTransformedEntity(`rover-${part.name}`, new Vec3(0, 0, 0));
        lowerPivot.addChild(child);
        child.transform.position = new Vec3(0, 0, 0);
        const r = new Renderable();
        r.geometry = part.geometry; r.material = part.material;
        r.castShadow = true; r.receiveShadow = true;
        scene.world.addComponent(child.id, r);
      }

      // 2. Upper mast pivot at the azimuth joint (lower-pivot-local).
      //    Upper parts are offset by -joint so they stay at hinge-relative coords when identity.
      const upperPivot = scene.createTransformedEntity("rover-mast-upper", new Vec3(jx, jy, jz));
      lowerPivot.addChild(upperPivot);
      upperPivot.transform.position = new Vec3(jx, jy, jz);
      if (glb.mast.upperParts.length > 0) {
        const upperOffset = scene.createTransformedEntity("rover-mast-upper-offset", new Vec3(-jx, -jy, -jz));
        upperPivot.addChild(upperOffset);
        upperOffset.transform.position = new Vec3(-jx, -jy, -jz);
        for (const part of glb.mast.upperParts) {
          const child = scene.createTransformedEntity(`rover-${part.name}`, new Vec3(0, 0, 0));
          upperOffset.addChild(child);
          child.transform.position = new Vec3(0, 0, 0);
          const r = new Renderable();
          r.geometry = part.geometry; r.material = part.material;
          r.castShadow = true; r.receiveShadow = true;
          scene.world.addComponent(child.id, r);
        }
      }

      // 3. Head pivot at the elevation joint (upper-pivot-local = headPivot − joint).
      //    Head parts are offset by -headPivot so they stay at hinge-relative coords when identity.
      const headPivotRelX = hx - jx;
      const headPivotRelY = hy - jy;
      const headPivotRelZ = hz - jz;
      const headPivotE = scene.createTransformedEntity("rover-mast-head-pivot", new Vec3(headPivotRelX, headPivotRelY, headPivotRelZ));
      upperPivot.addChild(headPivotE);
      headPivotE.transform.position = new Vec3(headPivotRelX, headPivotRelY, headPivotRelZ);
      if (glb.mast.headParts.length > 0) {
        const headOffset = scene.createTransformedEntity("rover-mast-head-offset", new Vec3(-hx, -hy, -hz));
        headPivotE.addChild(headOffset);
        headOffset.transform.position = new Vec3(-hx, -hy, -hz);
        for (const part of glb.mast.headParts) {
          const child = scene.createTransformedEntity(`rover-${part.name}`, new Vec3(0, 0, 0));
          headOffset.addChild(child);
          child.transform.position = new Vec3(0, 0, 0);
          const r = new Renderable();
          r.geometry = part.geometry; r.material = part.material;
          r.castShadow = true; r.receiveShadow = true;
          scene.world.addComponent(child.id, r);
        }
      }

      mastPivot = lowerPivot;
      mastUpperPivot = upperPivot;
      mastHeadPivotEntity = headPivotE;
      writeMastPose();
    }
    // Robotic arm: one pivot entity per joint, each parented to the previous one at its
    // parent-relative pivot (the first under the chassis, with the ground-plane offset), carrying
    // its link's pivot-relative parts at identity. Rotating a pivot about its axis swings
    // everything outboard of it, exactly like the GLB node hierarchy.
    if (glb.arm && glb.arm.joints.length === ARM_JOINT_COUNT) {
      let parent: Entity = chassis;
      const pivots: { entity: Entity; axis: Vec3 }[] = [];
      for (const [j, joint] of glb.arm.joints.entries()) {
        const [ox, oy, oz] = joint.offset;
        const at = new Vec3(ox, j === 0 ? oy + bodyOffsetY : oy, oz);
        const pivot = scene.createTransformedEntity(`rover-arm-${joint.joint}`, at);
        parent.addChild(pivot);
        pivot.transform.position = at;
        for (const part of joint.parts) {
          const child = scene.createTransformedEntity(`rover-${part.name}`, new Vec3(0, 0, 0));
          pivot.addChild(child);
          child.transform.position = new Vec3(0, 0, 0);
          const r = new Renderable();
          r.geometry = part.geometry;
          r.material = part.material;
          r.castShadow = true;
          r.receiveShadow = true;
          scene.world.addComponent(child.id, r);
        }
        pivots.push({ entity: pivot, axis: new Vec3(joint.axis[0], joint.axis[1], joint.axis[2]) });
        parent = pivot;
      }
      armPivots = pivots;
      bindArmRig();
    }
    // High-gain antenna: the NASA model ships without one — no `hga` nodes, and a vertex scan of
    // the body meshes finds nothing above the front-right deck — so the assembly is procedural:
    // base post → yaw (azimuth) pivot → pitch (elevation) pivot → dish + feed. Both pivots are
    // chassis children at the same deck point, so the gimbal solve in `highGainAntenna.ts`
    // (chassis-local angles) lines up with the transform hierarchy exactly.
    {
      const HGA_X = 0.62; // front-right deck, clear of the mast (front-left) and arm mount
      const HGA_Z = 0.55;
      const HGA_DECK_Y = 1.2; // deck panel boxes top out at y ≈ 1.2 in model space
      const baseY = HGA_DECK_Y + bodyOffsetY;

      const hgaDishMaterial = new Material({ label: "hga-dish", color: 0xd8d8d2, roughness: 0.38, metallic: 0.7 });
      const hgaMountMaterial = new Material({ label: "hga-mount", color: 0x3a3d42, roughness: 0.6, metallic: 0.5 });
      const baseGeo = createCylinder(gpu, { radiusTop: 0.085, radiusBottom: 0.11, height: 0.24, radialSegments: 16, capped: true });
      const yokeGeo = createBox(gpu, { width: 0.05, height: 0.18, depth: 0.05 });
      const dishGeo = createCylinder(gpu, { radiusTop: 0.24, radiusBottom: 0.045, height: 0.1, radialSegments: 24, capped: true });
      const feedGeo = createCylinder(gpu, { radiusTop: 0.014, radiusBottom: 0.014, height: 0.16, radialSegments: 8, capped: true });
      const feedTipGeo = createSphere(gpu, { radius: 0.03, widthSegments: 12, heightSegments: 8 });
      hgaResources.push(hgaDishMaterial, hgaMountMaterial, baseGeo, yokeGeo, dishGeo, feedGeo, feedTipGeo);

      const hgaPart = (name: string, parent: Entity, geometry: ReturnType<typeof createBox>, material: Material, at: Vec3, rotation?: Quat): Entity => {
        const part = scene.createTransformedEntity(`rover-hga-${name}`, at);
        parent.addChild(part);
        part.transform.position = at;
        if (rotation) part.transform.rotation = rotation;
        const renderable = new Renderable();
        renderable.geometry = geometry;
        renderable.material = material;
        renderable.castShadow = true;
        renderable.receiveShadow = true;
        scene.world.addComponent(part.id, renderable);
        return part;
      };

      // Static mount post on the deck (no articulation; 0.24 m so the stowed dish clears the deck).
      hgaPart("base", chassis, baseGeo, hgaMountMaterial, new Vec3(HGA_X, baseY + 0.12, HGA_Z));
      // Azimuth pivot at the top of the post, carrying the yoke arms.
      const yawPivot = scene.createTransformedEntity("rover-hga-yaw", new Vec3(HGA_X, baseY + 0.24, HGA_Z));
      chassis.addChild(yawPivot);
      yawPivot.transform.position = new Vec3(HGA_X, baseY + 0.24, HGA_Z);
      hgaPart("yoke-forward", yawPivot, yokeGeo, hgaMountMaterial, new Vec3(0, 0.05, 0.06));
      hgaPart("yoke-aft", yawPivot, yokeGeo, hgaMountMaterial, new Vec3(0, 0.05, -0.06));
      // Elevation pivot between the yoke arms, carrying dish + feed, boresight +Z at 0°.
      const pitchPivot = scene.createTransformedEntity("rover-hga-pitch", new Vec3(0, 0.05, 0));
      yawPivot.addChild(pitchPivot);
      pitchPivot.transform.position = new Vec3(0, 0.05, 0);
      // The dish's cylinder axis is +Y; a +90° X rotation points it along +Z (wide rim forward).
      const dishQ = new Quat().setAxisAngle(AXIS_X, Math.PI / 2);
      hgaPart("dish", pitchPivot, dishGeo, hgaDishMaterial, new Vec3(0, 0, 0.06), dishQ);
      hgaPart("feed", pitchPivot, feedGeo, hgaMountMaterial, new Vec3(0, 0, 0.19), dishQ);
      hgaPart("feed-tip", pitchPivot, feedTipGeo, hgaDishMaterial, new Vec3(0, 0, 0.3));

      hgaYawPivot = yawPivot;
      hgaPitchPivot = pitchPivot;
      writeHgaPose();
      hga.arm(); // the unfurl countdown starts when the model lands, not at scene load
    }
  };

  /** Pose all mast pivots from the spring state (no-op until the GLB lands). */
  const writeMastPose = (): void => {
    if (!mastPivot) return;
    const t = Math.max(-0.1, Math.min(1.1, mastT));
    Quat.slerpInto(mastIdentity, mastDeployedQ, t, mastScratchQ);
    mastPivot.transform.rotation = mastScratchQ;
    // Upper and head pivots reset when stowed; the update loop animates them when deployed.
    if (mastUpperPivot && t < 0.5) mastUpperPivot.transform.rotation = mastIdentity;
    if (mastHeadPivotEntity && t < 0.5) mastHeadPivotEntity.transform.rotation = mastIdentity;
  };

  /** Command the mast; the button/keys call this, the spring does the rest. */
  const setMast = (deployed: boolean): void => {
    mastTarget = deployed ? 1 : 0;
    touch.setMast(deployed);
  };

  /** Command the arm; the button/keys call this, the controller animates it. */
  const setArm = (deployed: boolean): void => {
    arm.setDeployed(deployed);
    touch.setArm(deployed);
    if (!deployed) {
      toolOperation = null;
      toolOperationProgress = 0;
      toolDust.setWork(null);
      toolTouch?.setBusy(null);
      toolTouch?.setTarget(null);
      toolTouch?.setProgress(0);
      // Stowing hides the sticks and cancels an in-flight robotic-tool action immediately.
      armTouch.setVisible(false);
    }
  };

  const modelUrl = new URL("../../assets/Perseverance.glb", import.meta.url).href;
  /** Fetch+build with progress; a retry bumps the attempt so a stale fetch cannot win. */
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
        console.error("mars showcase: rover model failed to load; rover remains invisible", error);
      });
  };
  startModelLoad();

  // ---------------------------------------------------------------- input (playground pattern)
  const keys = new Set<string>();
  const onKeyDown = (event: KeyboardEvent): void => {
    keys.add(event.code);
    if (event.code === "Space" || event.code.startsWith("Arrow")) event.preventDefault();
    // M toggles the mast (keydown, not hold; ignore auto-repeat so it flips once per press).
    if (event.code === "KeyM" && !event.repeat) setMast(mastTarget < 0.5);
    // R toggles the robotic arm, same rule.
    if (event.code === "KeyR" && !event.repeat) setArm(!arm.deployed);
    // E/Q/V are keyboard shortcuts for the same proximity-gated turret tools as the buttons.
    if (!event.repeat && event.code === "KeyE") startToolAction("drill");
    if (!event.repeat && event.code === "KeyQ") startToolAction("abrade");
    if (!event.repeat && event.code === "KeyV") startToolAction("analyze");
  };
  const onKeyUp = (event: KeyboardEvent): void => {
    keys.delete(event.code);
  };
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
  const touch = attachVehicleTouch(document.getElementById("vehicle-touch"), {
    onMastToggle: () => setMast(mastTarget < 0.5),
    onArmToggle: () => setArm(!arm.deployed),
  });
  const armTouch = attachArmTouch(document.getElementById("arm-touch"));
  toolTouch = attachRoverToolTouch(document.getElementById("rover-tool-touch"), (action) => startToolAction(action));
  /** One arm jog axis from the keyboard: +1 / −1 while a key of the pair is held. */
  const keyAxis = (positive: string, negative: string): number => (keys.has(positive) ? 1 : 0) - (keys.has(negative) ? 1 : 0);
  const unit = (v: number): number => Math.max(-1, Math.min(1, v));
  const toolCandidatePoseScratch = new Float64Array(ARM_JOINT_COUNT);
  const toolCurrentPointLocal: RoverToolPoint = { right: 0, forward: 0, height: 0 };
  const toolCurrentPointWorld: RoverToolWorldPoint = { x: 0, y: 0, z: 0 };
  const toolTargetPointLocal: RoverToolPoint = { right: 0, forward: 0, height: 0 };
  const toolRoverDirection = new Vec3();
  const toolBoxLocalDirection = new Vec3();
  const toolBoxPoint = new Vec3();
  const toolBoxWorldOffset = new Vec3();
  const toolBoxUp = new Vec3(0, 1, 0);
  const toolBoxWorldNormal = new Vec3();
  const toolMarkRelative = new Vec3();
  const toolMarkLocalPoint = new Vec3();
  const toolMarkLocalNormal = new Vec3();
  const toolMarkWorldOffset = new Vec3();
  const toolMarkWorldNormal = new Vec3();
  const toolMarkWorldPoint = new Vec3();
  const toolMarkRotation = new Quat();

  const toolRootY = (): number => vehicle.position.y + bodyOffsetY;
  const toolClamp = (value: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, value));

  /** Pick a point on the upper, rover-facing surface so the bit approaches from above. */
  function toolSurfaceTarget(record: InteractiveRockRecord): { point: RoverToolWorldPoint; normal: { x: number; y: number; z: number } } {
    const body = record.proxy.body;
    let towardX = vehicle.position.x - body.position.x;
    let towardZ = vehicle.position.z - body.position.z;
    let towardLength = Math.hypot(towardX, towardZ);
    if (towardLength < 1e-5) {
      towardX = Math.sin(vehicle.yaw);
      towardZ = Math.cos(vehicle.yaw);
      towardLength = 1;
    }
    towardX /= towardLength;
    towardZ /= towardLength;

    if (record.isFlat && body.shape instanceof BoxShape) {
      body.rotation.rotateVectorInverse(toolRoverDirection.set(towardX, 0, towardZ), toolBoxLocalDirection);
      const half = body.shape.halfExtents;
      toolBoxPoint.set(
        toolClamp(toolBoxLocalDirection.x * half.x * 0.46, -half.x * 0.52, half.x * 0.52),
        half.y,
        toolClamp(toolBoxLocalDirection.z * half.z * 0.46, -half.z * 0.52, half.z * 0.52),
      );
      body.rotation.rotateVector(toolBoxPoint, toolBoxWorldOffset);
      body.rotation.rotateVector(toolBoxUp, toolBoxWorldNormal);
      toolBoxWorldNormal.normalize();
      return {
        point: {
          x: body.position.x + toolBoxWorldOffset.x,
          y: body.position.y + toolBoxWorldOffset.y,
          z: body.position.z + toolBoxWorldOffset.z,
        },
        normal: { x: toolBoxWorldNormal.x, y: toolBoxWorldNormal.y, z: toolBoxWorldNormal.z },
      };
    }

    const radius = body.shape instanceof SphereShape ? body.shape.radius : record.trailRadius;
    const tangent = 0.28;
    const normalY = Math.sqrt(1 - tangent * tangent);
    const normal = { x: towardX * tangent, y: normalY, z: towardZ * tangent };
    return {
      point: {
        x: body.position.x + normal.x * radius,
        y: body.position.y + normal.y * radius,
        z: body.position.z + normal.z * radius,
      },
      normal,
    };
  }

  /** Return the nearest rock for which the arm can safely solve a drilling pose. */
  function findReachableToolCandidate(): ToolCandidate | null {
    if (!modelLoaded || !arm.unfolded || armPivots.length !== ARM_JOINT_COUNT) return null;
    arm.pose(armPose);
    roverToolPointFromPose(armPose, "drill", toolCurrentPointLocal);
    roverToolWorldPoint(
      toolCurrentPointLocal,
      vehicle.position.x,
      toolRootY(),
      vehicle.position.z,
      vehicle.yaw,
      toolCurrentPointWorld,
    );
    let nearest: ToolCandidate | null = null;
    for (const record of interactiveRocks.values()) {
      const surface = toolSurfaceTarget(record);
      const local = worldPointToRoverLocal(
        surface.point.x,
        surface.point.y,
        surface.point.z,
        vehicle.position.x,
        toolRootY(),
        vehicle.position.z,
        vehicle.yaw,
        toolTargetPointLocal,
      );
      if (!solveArmPoseForToolPoint(local, "drill", toolCandidatePoseScratch)) continue;
      const distance = Math.hypot(
        surface.point.x - toolCurrentPointWorld.x,
        surface.point.y - toolCurrentPointWorld.y,
        surface.point.z - toolCurrentPointWorld.z,
      );
      if (!nearest || distance < nearest.distance) {
        nearest = { record, point: surface.point, normal: surface.normal, distance };
      }
    }
    return nearest;
  }

  function armPoseClose(current: ArrayLike<number>, target: ArrayLike<number>, tolerance = (1.6 * Math.PI) / 180): boolean {
    for (let i = 0; i < ARM_JOINT_COUNT; i++) {
      if (Math.abs((current[i] ?? 0) - (target[i] ?? 0)) > tolerance) return false;
    }
    return true;
  }

  function addToolMark(
    record: InteractiveRockRecord,
    kind: ToolMarkRecord["kind"],
    point: RoverToolWorldPoint,
    normal: Readonly<{ x: number; y: number; z: number }>,
    geometry: Geometry,
    material: Material,
    duration = 0,
    baseScale = 1,
  ): void {
    if (toolMarks.length >= MAX_TOOL_MARKS) {
      scene.world.destroyEntity(toolMarks[0]!.entity.id);
      toolMarks.shift();
    }
    const body = record.proxy.body;
    toolMarkRelative.set(point.x - body.position.x, point.y - body.position.y, point.z - body.position.z);
    body.rotation.rotateVectorInverse(toolMarkRelative, toolMarkLocalPoint);
    body.rotation.rotateVectorInverse(new Vec3(normal.x, normal.y, normal.z), toolMarkLocalNormal);
    const localPoint = toolMarkLocalPoint.clone();
    const localNormal = toolMarkLocalNormal.clone();
    const at = new Vec3(point.x + normal.x * 0.009, point.y + normal.y * 0.009, point.z + normal.z * 0.009);
    const entity = scene.createTransformedEntity(`rover-tool-${kind}-${toolMarkSequence++}`, at);
    toolMarkRotation.fromUnitVectorY(normal);
    entity.transform.rotation = toolMarkRotation;
    const renderable = new Renderable();
    renderable.geometry = geometry;
    renderable.material = material;
    renderable.castShadow = false;
    renderable.receiveShadow = false;
    renderable.transparent = material.transparent;
    scene.world.addComponent(entity.id, renderable);
    setEntityScale(entity, baseScale, 1, baseScale);
    toolMarks.push({ targetId: record.proxy.spec.id, entity, renderable, localPoint, localNormal, kind, age: 0, duration, baseScale });
  }

  function stepToolMarks(dt: number): void {
    for (let i = toolMarks.length - 1; i >= 0; i--) {
      const mark = toolMarks[i]!;
      const record = interactiveRocks.get(mark.targetId);
      if (!record || (mark.duration > 0 && (mark.age += dt) >= mark.duration)) {
        scene.world.destroyEntity(mark.entity.id);
        toolMarks.splice(i, 1);
        continue;
      }
      const body = record.proxy.body;
      body.rotation.rotateVector(mark.localPoint, toolMarkWorldOffset);
      body.rotation.rotateVector(mark.localNormal, toolMarkWorldNormal);
      toolMarkWorldNormal.normalize();
      toolMarkWorldPoint.set(
        body.position.x + toolMarkWorldOffset.x + toolMarkWorldNormal.x * 0.009,
        body.position.y + toolMarkWorldOffset.y + toolMarkWorldNormal.y * 0.009,
        body.position.z + toolMarkWorldOffset.z + toolMarkWorldNormal.z * 0.009,
      );
      toolMarkRotation.fromUnitVectorY(toolMarkWorldNormal);
      syncEntityPose(mark.entity, toolMarkWorldPoint, toolMarkRotation);
      if (mark.kind === "scan") {
        const pulse = 0.82 + Math.sin(mark.age * 8) * 0.18;
        setEntityScale(mark.entity, mark.baseScale * pulse, 1, mark.baseScale * pulse);
      }
    }
  }

  function spawnToolRubble(record: InteractiveRockRecord, normal: Readonly<{ x: number; y: number; z: number }>, count: number): void {
    const offsets = [
      { x: 0, z: 0, y: 0, r: 0.052 },
      { x: 0.086, z: 0.01, y: 0.024, r: 0.041 },
      { x: -0.084, z: 0.015, y: 0.026, r: 0.039 },
      { x: 0.015, z: -0.09, y: 0.052, r: 0.034 },
      { x: 0.09, z: 0.08, y: 0.058, r: 0.03 },
    ];
    const horizontalLength = Math.hypot(normal.x, normal.z) || 1;
    const awayX = normal.x / horizontalLength;
    const awayZ = normal.z / horizontalLength;
    const body = record.proxy.body;
    const baseX = body.position.x + awayX * (record.trailRadius + 0.13);
    const baseZ = body.position.z + awayZ * (record.trailRadius + 0.13);
    const evictOldest = (): void => {
      if (fragments.length < MAX_FRAGMENTS) return;
      const oldest = fragments.shift()!;
      interactivePhysics.removeBody(oldest.body);
      scene.world.destroyEntity(oldest.entity.id);
    };
    for (let i = 0; i < Math.min(count, offsets.length); i++) {
      evictOldest();
      const piece = offsets[i]!;
      const radius = piece.r;
      const x = baseX + piece.x;
      const z = baseZ + piece.z;
      const y = deformedGroundHeight(x, z) + radius + piece.y;
      const rubbleBody = new RigidBody({
        type: "dynamic",
        shape: new SphereShape(radius),
        mass: Math.max(0.05, radius * radius * radius * 120),
        position: { x, y, z },
        friction: 0.9,
        linearDamping: 0.7,
        angularDamping: 0.6,
        restitution: 0.04,
      });
      rubbleBody.linearVelocity.set(awayX * 0.08, 0.08 + piece.y * 0.3, awayZ * 0.08);
      rubbleBody.angularVelocity.set(0.6, 0.4, -0.5);
      interactivePhysics.addBody(rubbleBody);
      const entity = scene.createTransformedEntity(`tool-rubble-${toolRubbleSequence++}`, new Vec3(x, y, z));
      const renderable = new Renderable();
      renderable.geometry = pebbleGeometry;
      renderable.material = rockMaterial;
      renderable.castShadow = true;
      renderable.receiveShadow = true;
      scene.world.addComponent(entity.id, renderable);
      setEntityScale(entity, radius / PEBBLE_GEO_RADIUS_XZ, radius / PEBBLE_GEO_RADIUS_Y, radius / PEBBLE_GEO_RADIUS_XZ);
      fragments.push({ id: `tool-rubble-${toolRubbleSequence}`, body: rubbleBody, entity, isFlat: false, scale: radius * 2, awake: true, settledTimer: 0, age: 0 });
      toolCounts.rubble++;
    }
  }

  function performToolAction(operation: ToolOperation, record: InteractiveRockRecord): string {
    const targetId = record.proxy.spec.id;
    if (operation.action === "drill") {
      toolCounts.drilled++;
      const shape = record.proxy.body.shape;
      const thickness = shape instanceof BoxShape ? shape.halfExtents.y * 2 : record.trailRadius * 2;
      const splits = shouldSplitRockDuringDrilling({
        id: targetId,
        radius: record.trailRadius,
        isFlat: record.isFlat,
        thickness,
      }, toolDrillAttempt++);
      if (splits) {
        toolCounts.split++;
        breakRock(record, operation.targetNormal.x, operation.targetNormal.z, 0.15);
        toolDust.burst(operation.action, operation.targetPoint, operation.targetNormal);
        return "CORE FRACTURE · small rock split";
      }
      addToolMark(record, "hole", operation.targetPoint, operation.targetNormal, drillHoleGeometry, drillHoleMaterial, 0, 1);
      addToolMark(record, "rim", operation.targetPoint, operation.targetNormal, drillRimGeometry, drillRimMaterial, 0, 1);
      spawnToolRubble(record, operation.targetNormal, 5);
      toolDust.burst(operation.action, operation.targetPoint, operation.targetNormal);
      return "CORE DRILLED · regolith dust settling";
    }
    if (operation.action === "abrade") {
      toolCounts.abraded++;
      addToolMark(record, "abrasion", operation.targetPoint, operation.targetNormal, abrasionMarkGeometry, abrasionMarkMaterial, 0, 1);
      spawnToolRubble(record, operation.targetNormal, 3);
      toolDust.burst(operation.action, operation.targetPoint, operation.targetNormal);
      return "SURFACE ABRADED · fresh material exposed";
    }
    toolCounts.analyzed++;
    const sample = Math.abs(hashName(targetId)) % 3;
    const readings = ["Fe/Mg basaltic signal", "silicate-rich trace", "mafic crust signature"];
    addToolMark(record, "scan", operation.targetPoint, operation.targetNormal, analysisRingGeometry, analysisRingMaterial, 2.5, 1);
    return `PIXL SAMPLE · ${readings[sample]}`;
  }

  function startToolAction(action: RoverToolAction): boolean {
    if (disposed || toolOperation || !modelLoaded || !arm.unfolded || armPivots.length !== ARM_JOINT_COUNT) return false;
    const candidate = findReachableToolCandidate();
    if (!candidate) return false;
    const targetPose = new Float64Array(ARM_JOINT_COUNT);
    const targetLocal = worldPointToRoverLocal(
      candidate.point.x,
      candidate.point.y,
      candidate.point.z,
      vehicle.position.x,
      toolRootY(),
      vehicle.position.z,
      vehicle.yaw,
      toolTargetPointLocal,
    );
    if (!solveArmPoseForToolPoint(targetLocal, action, targetPose)) return false;
    const operation: ToolOperation = {
      action,
      targetId: candidate.record.proxy.spec.id,
      phase: "approach",
      elapsed: 0,
      workSeconds: ROVER_TOOL_SPECS[action].workSeconds,
      targetPose,
      targetPoint: { ...candidate.point },
      targetNormal: { ...candidate.normal },
      result: "",
    };
    toolOperation = operation;
    toolOperationProgress = 0;
    toolTargetId = operation.targetId;
    toolPrompt = `${ROVER_TOOL_SPECS[action].label} · ${candidate.distance.toFixed(1)} m`;
    candidate.record.proxy.body.linearVelocity.set(0, 0, 0);
    candidate.record.proxy.body.angularVelocity.set(0, 0, 0);
    candidate.record.proxy.body.type = "static";
    candidate.record.awake = false;
    candidate.record.settledTimer = 0;
    armTouch.setVisible(false);
    toolTouch?.setTarget(toolPrompt);
    toolTouch?.setBusy("ALIGNING ARM");
    toolTouch?.setProgress(0);
    return true;
  }

  function advanceToolOperation(dt: number): void {
    const operation = toolOperation;
    if (!operation) {
      toolDust.setWork(null);
      return;
    }
    const record = interactiveRocks.get(operation.targetId);
    if (!record && operation.phase !== "retract") {
      toolOperation = null;
      toolOperationProgress = 0;
      toolDust.setWork(null);
      toolTouch?.setBusy(null);
      toolTouch?.setProgress(0);
      return;
    }

    if (operation.phase === "approach" && armPoseClose(armPose, operation.targetPose)) {
      operation.phase = "working";
      operation.elapsed = 0;
    } else if (operation.phase === "working") {
      operation.elapsed += dt;
      toolOperationProgress = Math.min(1, operation.elapsed / operation.workSeconds);
      if (operation.elapsed >= operation.workSeconds && record) {
        operation.result = performToolAction(operation, record);
        toolLastResult = operation.result;
        operation.phase = "retract";
        operation.elapsed = 0;
      }
    } else if (operation.phase === "retract" && armPoseClose(armPose, armReadyPose, (2.2 * Math.PI) / 180)) {
      toolOperation = null;
      toolOperationProgress = 0;
      toolDust.setWork(null);
      toolTouch?.setBusy(null);
      toolTouch?.setProgress(0);
      return;
    }

    if (toolOperation?.phase === "working" && operation.action !== "analyze") {
      toolDust.setWork(operation.action, operation.targetPoint, operation.targetNormal);
    } else {
      toolDust.setWork(null);
    }
    if (operation.phase === "approach") {
      toolTouch?.setBusy(`ALIGNING ${ROVER_TOOL_SPECS[operation.action].displayName.toUpperCase()}`);
      toolOperationProgress = 0;
    } else if (operation.phase === "working") {
      toolTouch?.setBusy(`${ROVER_TOOL_SPECS[operation.action].label} · ${Math.round(toolOperationProgress * 100)}%`);
    } else {
      toolTouch?.setBusy(`${operation.result} · RETRACTING`);
      toolOperationProgress = 1;
    }
    toolTouch?.setProgress(toolOperationProgress);
  }

  return {
    scene,
    cameraEntity,
    controlsHint: "WASD / arrows drive · Space handbrake · M mast · R arm · E drill / Q abrade / V PIXL when in reach · HGA auto-tracks Earth · Drag to orbit · Scroll zoom",
    camera: {
      // Match followTarget from frame 0: vehicle CG + mid-chassis offset (not groundY + mast height).
      target: new Vec3(SPAWN_X, chaseLookY, SPAWN_Z),
      // Closer + higher elevation keeps the chassis in the middle of a portrait FOV-Y frame with
      // terrain underfoot; users can still zoom out for a wider valley view.
      distance: MARS_CHASE_DISTANCE,
      minDistance: MARS_CHASE_MIN_DISTANCE,
      maxDistance: 120,
      azimuth: MARS_CHASE_AZIMUTH,
      elevation: MARS_CHASE_ELEVATION,
      // Must stay below CHASE_LOOK_OFFSET_Y + hang so the surface clamp cannot hoist the look-at
      // above the chassis (that tip-over-rover-into-haze bug returned whenever clearance was 2 m).
      groundClearance: MARS_CHASE_GROUND_CLEARANCE,
      groundHeight: deformedGroundHeight,
      keyboard: false,
    },
    followTarget: () => ({
      x: vehicle.position.x,
      y: vehicle.position.y + MARS_CHASE_LOOK_OFFSET_Y,
      z: vehicle.position.z,
    }),
    update(dt: number): void {
      // Keep the atmosphere's observer reference on the local rover terrain as it drives, rather than
      // leaving the spawn height in place while the camera follows across a changing landscape.
      scene.settings.sky.seaLevel = deformedGroundHeight(vehicle.position.x, vehicle.position.z);
      stepInteractiveRocks(dt);
      stepToolMarks(dt);
      // Record shallow wheel impressions separately from the procedural heightfield. The renderer
      // and ground-query consumers do not apply this delta yet; this keeps the runtime state ready
      // for the visual and physical deformation steps without mutating generated Mars cells.
      for (const wheel of vehicle.wheels) {
        if (!wheel.inContact) continue;
        const cx = Math.floor(wheel.contactX / terrain.chunkSize);
        const cz = Math.floor(wheel.contactZ / terrain.chunkSize);
        const key = chunkCoordKey(cx, cz);
        deformation.stamp(key, {
          x: wheel.contactX - cx * terrain.chunkSize,
          z: wheel.contactZ - cz * terrain.chunkSize,
          radius: 0.18,
          depth: 0.008 * Math.min(1.5, Math.max(0.2, wheel.normalLoad / 625)),
        }, terrain.chunkSize);
        const last = lastTrack[vehicle.wheels.indexOf(wheel)]!;
        if (!Number.isFinite(last.x) || Math.hypot(wheel.contactX - last.x, wheel.contactZ - last.z) >= 0.32) {
          const mark = trackMarks[nextTrack]!;
          mark.entity.transform.position = new Vec3(wheel.contactX, wheel.contactY + 0.008, wheel.contactZ);
          mark.entity.transform.rotation = trackRotation.setAxisAngle(AXIS_Y, vehicle.yaw);
          mark.renderable.visible = true;
          last.x = wheel.contactX;
          last.z = wheel.contactZ;
          nextTrack = (nextTrack + 1) % trackMarks.length;
          visibleTrackMarks = Math.min(trackMarks.length, visibleTrackMarks + 1);
        }
      }
      // Mast deployment spring (semi-implicit Euler; the main loop already clamps dt ≤ 0.05).
      // Slightly underdamped on purpose: the head swings up, kisses past vertical, and settles
      // onto the latch like the real pyro deployment — and a mid-swing toggle reverses smoothly.
      mastElapsed += dt;
      if (mastPivot && (mastT !== mastTarget || mastV !== 0)) {
        mastV += ((mastTarget - mastT) * MAST_STIFFNESS - mastV * MAST_DAMPING) * dt;
        mastT += mastV * dt;
        if (Math.abs(mastTarget - mastT) < 1e-4 && Math.abs(mastV) < 1e-4) {
          mastT = mastTarget;
          mastV = 0;
        }
        writeMastPose();
      }
      // Upper mast azimuth: sinusoidal sweep once the mast is mostly deployed.
      // Smoothly fades in as mastT crosses 0.5 (mid-deployment) so the upper assembly
      // doesn't start rotating before it's clear of the deck.
      if (mastUpperPivot) {
        const fade = Math.max(0, Math.min(1, (mastT - 0.5) * 2));
        if (fade > 0) {
          mastAzimuthAngle = Math.sin(mastElapsed * MAST_AZIMUTH_SPEED) * MAST_AZIMUTH_RANGE * fade;
          mastAzimuthQ.setAxisAngle(AXIS_Y, mastAzimuthAngle);
          mastUpperPivot.transform.rotation = mastAzimuthQ;
        }
      }
      // Camera head elevation: spring toward the deployed tilt angle.
      // The real Mastcam-Z tilts ±30°; a gentle 15° upward is a natural survey pose.
      if (mastHeadPivotEntity) {
        const fade = Math.max(0, Math.min(1, (mastT - 0.5) * 2));
        const elevTarget = MAST_ELEVATION * fade;
        const wn = MAST_ELEVATION_WN;
        const zeta = MAST_ELEVATION_ZETA;
        mastElevationV += ((elevTarget - mastElevationAngle) * wn * wn - mastElevationV * 2 * zeta * wn) * dt;
        mastElevationAngle += mastElevationV * dt;
        if (fade < 0.01 && Math.abs(mastElevationAngle) < 1e-4 && Math.abs(mastElevationV) < 1e-4) {
          mastElevationAngle = 0;
          mastElevationV = 0;
        }
        mastElevationQ.setAxisAngle(AXIS_X, mastElevationAngle);
        mastHeadPivotEntity.transform.rotation = mastElevationQ;
      }
      // High-gain antenna: unfurls HGA_DEPLOY_DELAY_SECONDS after the model lands, then re-solves
      // Earth in gimbal space every frame — driving, turning or pitching the rover is compensated
      // by the slew-limited gimbals, never snapped. One-way: there is no stow path at all.
      if (hgaYawPivot && hga.update(dt, { yaw: vehicle.yaw, pitch: vehicle.pitch, roll: vehicle.roll })) {
        writeHgaPose();
      }
      const pad = touch.sample();
      const keyThrottle = keys.has("KeyW") || keys.has("ArrowUp") ? 1 : 0;
      const keyBrake = keys.has("KeyS") || keys.has("ArrowDown") ? 1 : 0;
      const keySteer =
        (keys.has("KeyD") || keys.has("ArrowRight") ? 1 : 0) - (keys.has("KeyA") || keys.has("ArrowLeft") ? 1 : 0);
      const throttle = Math.max(keyThrottle, pad.throttle);
      // The first non-zero throttle input is the user's acknowledgement that the rover should
      // move. Until then both brakes stay engaged, including while the GLB is still loading.
      if (throttle > 0.01) startupBrake = false;
      const brake = Math.max(keyBrake, pad.brake);
      // Suspension wear sags the ride: the rest length shortens up to 30% at 100% damage, so
      // a battered rover visibly squats (and bottoms out sooner — travel itself is unchanged).
      vehicle.config.suspensionRest =
        BASE_SUSPENSION_REST * (1 - 0.3 * Math.min(1, roverDamage.suspension / 100));
      vehicle.input.throttle = roverDamage.disabled ? 0 : throttle;
      vehicle.input.brake = Math.max(brake, startupBrake ? 1 : 0, roverDamage.disabled ? 1 : 0);
      vehicle.input.steer = Math.max(-1, Math.min(1, keySteer + pad.steer));
      vehicle.input.handbrake = keys.has("Space") || startupBrake ? 1 : 0;
      if (toolOperation) {
        // Hold the rover still while the instrument is aligned and in contact with the target.
        vehicle.input.throttle = 0;
        vehicle.input.brake = 1;
        vehicle.input.handbrake = 1;
        vehicle.input.steer = 0;
      }

      // Manual jog input remains live when no tool is selected. During an operation it becomes a
      // closed-loop joint servo, then the arm returns to its ready pose before control is handed back.
      const sticks = armTouch.sample();
      armInput.swing = unit(sticks.swing + keyAxis("KeyH", "KeyF"));
      armInput.shoulder = unit(sticks.shoulder + keyAxis("KeyT", "KeyG"));
      armInput.elbow = unit(sticks.elbow + keyAxis("KeyI", "KeyK"));
      armInput.turret = unit(sticks.turret + keyAxis("KeyL", "KeyJ"));
      arm.pose(armPose);
      if (toolOperation) {
        const servoTarget = toolOperation.phase === "retract" ? armReadyPose : toolOperation.targetPose;
        roverToolServoInput(armPose, servoTarget, armInput);
      }
      if (armPivots.length > 0) arm.update(dt, armInput);
      arm.pose(armPose);
      advanceToolOperation(dt);
      toolCandidate = findReachableToolCandidate();
      if (toolOperation) {
        const activeRecord = interactiveRocks.get(toolOperation.targetId);
        toolTargetId = toolOperation.targetId;
        toolPrompt = activeRecord
          ? `${ROVER_TOOL_SPECS[toolOperation.action].label} · ${activeRecord.typeId === 2 ? "BOULDER" : "ROCK"}`
          : "CORE FRACTURE · RETRACTING";
      } else if (toolCandidate) {
        toolTargetId = toolCandidate.record.proxy.spec.id;
        toolPrompt = `${toolCandidate.record.typeId === 2 ? "BOULDER" : "ROCK"} · ${toolCandidate.distance.toFixed(1)} m`;
      } else {
        toolTargetId = null;
        toolPrompt = null;
      }
      toolTouch?.setTarget(toolPrompt);
      if (!toolOperation) {
        toolTouch?.setBusy(null);
        toolTouch?.setProgress(0);
      }
      armTouch.setVisible(arm.unfolded && !toolOperation && !toolCandidate);
    },
    overlay(): string {
      const contact = vehicle.wheels.filter((w) => w.inContact).length;
      const mb = (bytes: number): string => (bytes / 1048576).toFixed(1);
      const model = modelLoaded
        ? "GLB ok"
        : modelError
          ? `GLB failed: ${modelError}`
          : modelProgress?.phase === "fetch" && modelProgress.totalBytes
            ? `GLB ${mb(modelProgress.receivedBytes)}/${mb(modelProgress.totalBytes)} MB`
            : `GLB ${modelProgress?.phase ?? "loading"}…`;
      const mastLabel =
        !modelLoaded || !mastPivot
          ? "—"
          : mastTarget === 1
            ? mastT > 0.98
              ? `UP pan ${(mastAzimuthAngle * 180 / Math.PI).toFixed(0)}° tilt ${(mastElevationAngle * 180 / Math.PI).toFixed(0)}°`
              : `${Math.round(mastT * 100)}%↑`
            : mastT < 0.02
              ? "STOWED"
              : `${Math.round(mastT * 100)}%↓`;
      const deg = (rad: number): string => ((rad * 180) / Math.PI).toFixed(0);
      const antennaLabel =
        !modelLoaded || !hgaYawPivot
          ? "—"
          : hga.phase === "tracking"
            ? `EARTH az ${deg(hga.azimuth)}° el ${deg(hga.elevation)}°`
            : hga.phase === "deploying"
              ? `DEPLOY ${Math.round(hga.deployT * 100)}%`
              : `ARMED ${hga.countdown.toFixed(0)}s`;
      const powerKW = motor.powerKW;
      const powerLabel = `${Math.abs(powerKW).toFixed(2)} ${powerKW < -0.005 ? "kW regen" : "kW"}`;
      const jog = (joint: number, tag: string): string => {
        const d = Math.round(arm.jogDegrees(joint));
        return d === 0 ? "" : ` ${tag}${d > 0 ? "+" : "−"}${Math.abs(d)}°`;
      };
      const armLabel =
        !modelLoaded || armPivots.length === 0
          ? "—"
          : arm.deployed
            ? arm.unfolded
              ? `READY${jog(0, "sw")}${jog(1, "sh")}${jog(2, "el")}${jog(4, "tu")}`
              : `${Math.round(arm.progress * 100)}%↑`
            : arm.progress <= 0
              ? "STOWED"
              : `${Math.round(arm.progress * 100)}%↓`;
      const zonePct = (v: number): string => `${Math.round(v * 100)}`;
      const zoneTotal = damageZones.front + damageZones.rear + damageZones.left + damageZones.right;
      const wheelTotal = wheelDamage.reduce((sum, w) => sum + w, 0);
      const damageLine =
        zoneTotal + wheelTotal > 0.005
          ? `\n damage zones F${zonePct(damageZones.front)} R${zonePct(damageZones.rear)} ` +
            `L${zonePct(damageZones.left)} R${zonePct(damageZones.right)}` +
            WHEELS.map((w, i) =>
              detachedWheels.has(i)
                ? ` ${w.name.replace("wheel_", "")}✕`
                : wheelDamage[i]! > 0.005
                  ? ` ${w.name.replace("wheel_", "")}${zonePct(wheelDamage[i]!)}`
                  : "",
            ).join("")
          : "";
      return (
        `mars showcase · Perseverance 6/6 · ${model} · mast ${mastLabel} · arm ${armLabel} · HGA ${antennaLabel}\n` +
        `${MARS_SHOWCASE_SITE.name} · Mars seed ${terrain.seed} · analytic only (no erosion cache) · ${terrainGeneration()} · ${terrain.layeredMaterialsEnabled ? "4-layer PBR" : "single material"}\n` +
        `speed ${(vehicle.speed * 3.6).toFixed(1)} km/h  motor ${vehicle.rpm.toFixed(0)} rpm  ${powerLabel}  wheels ${contact}/6\n` +
        `pos ${vehicle.position.x.toFixed(1)}, ${vehicle.position.y.toFixed(1)}, ${vehicle.position.z.toFixed(1)}  ` +
        `dust ${ambientDust.simulation.alive}+${kickDustAlive()} · chips ${wheelRockChipsAlive()}  NASA/JPL-Caltech (public domain)` +
        damageLine
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
    marsState: () => {
      const terrainStats = terrain.stats();
      const populationStats = population.stats();
      let readyChunks = 0;
      for (const chunk of terrain.chunks.values()) if (chunk.state === "ready") readyChunks++;
      const roverChunkKey = chunkCoordKey(
        Math.floor(vehicle.position.x / terrain.chunkSize),
        Math.floor(vehicle.position.z / terrain.chunkSize),
      );
      return {
        modelLoaded,
        modelError,
        modelProgress,
        terrainChunks: Number(terrainStats.chunks ?? 0),
        terrainResidentBytes: Number(terrainStats.residentBytes ?? 0),
        terrainGenerator: marsStage.name,
        terrainHasErosion: marsStage.hasErosionCorrection,
        terrainGeneration: terrainGeneration(),
        terrainMaterialMode: terrain.layeredMaterialsEnabled ? "layered" : "single",
        terrainMaterialLayers: terrainLayers.layers.map((layer) => layer.name),
        terrainSplatTiles: [...terrain.chunks.values()].filter((chunk) => chunk.tile?.gpuMaterial !== null && chunk.tile?.gpuMaterial !== undefined).length,
        terrainReadyChunks: readyChunks,
        terrainRoverChunkReady: terrain.chunks.get(roverChunkKey)?.state === "ready",
        terrainGroundHeight: deformedGroundHeight(vehicle.position.x, vehicle.position.z),
        populationChunks: Number(populationStats.chunks ?? 0),
        populationInstances: Number(populationStats.instances ?? 0),
        interactiveRocks: interactiveRocks.size,
        interactiveRockBudget: MAX_INTERACTIVE_ROCKS,
        brokenInteractiveRocks,
        toolPrompt,
        toolTargetId,
        toolAction: toolOperation?.action ?? null,
        toolPhase: toolOperation?.phase ?? "idle",
        toolProgress: toolOperationProgress,
        toolMarks: toolMarks.length,
        toolRubble: fragments.filter((fragment) => fragment.id.startsWith("tool-rubble-")).length,
        toolDust: toolDust.simulation.alive,
        toolLastResult,
        drilledRocks: toolCounts.drilled,
        abradedRocks: toolCounts.abraded,
        analyzedRocks: toolCounts.analyzed,
        drillSplits: toolCounts.split,
        roverDamageHull: roverDamage.hull,
        roverDamageWheels: roverDamage.wheels,
        roverDamageSuspension: roverDamage.suspension,
        roverDisabled: roverDamage.disabled,
        damageZoneFront: damageZones.front,
        damageZoneRear: damageZones.rear,
        damageZoneLeft: damageZones.left,
        damageZoneRight: damageZones.right,
        damageWheels: [...wheelDamage],
        detachedWheels: [...detachedWheels].sort((a, b) => a - b),
        deformationChunks: deformation.chunkCount,
        deformationSamples: deformation.sampleCount,
        deformationRevision: deformation.revision,
        visibleTrackMarks,
        wheelCount: vehicle.wheels.length,
        contactWheels: vehicle.wheels.filter((w) => w.inContact).length,
        ambientDust: ambientDust.simulation.alive,
        kickDust: kickDustAlive(),
        kickDebris: wheelRockChipsAlive(),
        mastT,
        mastDeployed: mastTarget === 1,
        armT: arm.progress,
        armDeployed: arm.deployed,
        armUnfolded: arm.unfolded,
        armSticksVisible: armTouch.visible,
        armJoints: Array.from(arm.pose(armPose), (v) => (v * 180) / Math.PI),
        armPivotDeg: armPivots.map((pivot) => {
          const q = scene.world.getTRS(pivot.entity.id, armTrsScratch).rotation;
          const alongAxis = q.x * pivot.axis.x + q.y * pivot.axis.y + q.z * pivot.axis.z;
          const magnitude = 2 * Math.atan2(Math.hypot(q.x, q.y, q.z), q.w);
          return ((alongAxis < 0 ? -magnitude : magnitude) * 180) / Math.PI;
        }),
        antenna: {
          phase: hga.phase,
          countdown: hga.countdown,
          deployT: hga.deployT,
          azimuthDeg: (hga.azimuth * 180) / Math.PI,
          elevationDeg: (hga.elevation * 180) / Math.PI,
          targetAzimuthDeg: (hga.targetAzimuth * 180) / Math.PI,
          targetElevationDeg: (hga.targetElevation * 180) / Math.PI,
        },
        speed: vehicle.speed,
        x: vehicle.position.x,
        y: vehicle.position.y,
        z: vehicle.position.z,
      };
    },
    retryModelLoad(): void {
      if (!disposed) startModelLoad();
    },
    setMast(deployed: boolean): void {
      if (!disposed) setMast(deployed);
    },
    setArm(deployed: boolean): void {
      if (!disposed) setArm(deployed);
    },
    useTool(action: RoverToolAction): boolean {
      return startToolAction(action);
    },
    setDebugBounds(mode: "auto" | "on" | "off"): void {
      debugBoundsMode = mode;
    },
    saveInteractiveTerrain(): string {
      return JSON.stringify({
        version: 1,
        brokenRockIds: [...brokenInteractiveRockIds],
        deformation: deformation.serialize(),
      });
    },
    restoreInteractiveTerrain(serialized: string): void {
      let snapshot: { version?: number; brokenRockIds?: unknown; deformation?: unknown };
      try {
        snapshot = JSON.parse(serialized) as typeof snapshot;
      } catch {
        throw new Error("invalid interactive terrain snapshot: malformed JSON");
      }
      if (snapshot.version !== 1 || !Array.isArray(snapshot.brokenRockIds) || !Array.isArray(snapshot.deformation)) {
        throw new Error("invalid interactive terrain snapshot: unsupported shape");
      }
      for (const id of snapshot.brokenRockIds) if (typeof id === "string") brokenInteractiveRockIds.add(id);
      deformation.restore(snapshot.deformation as Parameters<typeof deformation.restore>[0]);
      for (const [id, record] of interactiveRocks) {
        if (!brokenInteractiveRockIds.has(id)) continue;
        interactivePhysics.removeBody(record.proxy.body);
        if (record.activeEntity) scene.world.destroyEntity(record.activeEntity.id);
        record.block.scales[record.index * 3] = 0;
        record.block.scales[record.index * 3 + 1] = 0;
        record.block.scales[record.index * 3 + 2] = 0;
        record.block.markModified();
        interactiveRocks.delete(id);
      }
      brokenInteractiveRocks = brokenInteractiveRockIds.size;
    },
    dispose(): void {
      disposed = true;
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      touch.dispose();
      armTouch.dispose();
      toolTouch?.dispose();
      toolDust.setWork(null);
      keys.clear();
      loaded?.dispose();
      loaded = null;
      for (const resource of hgaResources) resource.dispose();
      hgaResources.length = 0;
      dustMesh.dispose();
      ambientDustMaterial.dispose();
      kickDustMaterial.dispose();
      toolDustMaterial.dispose();
      for (const mark of toolMarks) scene.world.destroyEntity(mark.entity.id);
      toolMarks.length = 0;
      for (const resource of toolMarkResources) resource.dispose();
      toolMarkResources.length = 0;
      trackMesh.dispose();
      trackMaterial.dispose();
      furrowMesh.dispose();
      furrowMaterial.dispose();
      moundMesh.dispose();
      moundMaterial.dispose();
      population.dispose();
      for (const record of interactiveRocks.values()) {
        interactivePhysics.removeBody(record.proxy.body);
        if (record.activeEntity) scene.world.destroyEntity(record.activeEntity.id);
      }
      interactiveRocks.clear();
      for (const frag of fragments) {
        interactivePhysics.removeBody(frag.body);
        scene.world.destroyEntity(frag.entity.id);
      }
      fragments.length = 0;
      interactivePhysics.setHeightfield(null);
      rockGeometry.dispose();
      rockGeometryB.dispose();
      boulderGeometry.dispose();
      chunkGeometry.dispose();
      pebbleGeometry.dispose();
      rockMaterial.dispose();
      scene.dispose(); // tile materials/masks before the shared arrays they reference
      terrainMat.dispose();
      disposePbrTextureSet(marsMaps);
      marsMaps = null;
    },
  };
}

