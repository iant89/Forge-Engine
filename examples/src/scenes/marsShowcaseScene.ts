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
 * - rover: `Vehicle` on an electric drivetrain (`ElectricMotor` ≈1 kW + `ReductionDrive` 60:1 —
 *   the real rovers are battery-electric; the no-load motor speed caps the rover near 6 km/h,
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
  type TransformHandle,
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
} from "@forge/engine";
import { attachVehicleTouch } from "../controls/vehicleTouch.js";
import { attachArmTouch } from "../controls/armTouch.js";
import { loadGlb, type GlbLoadProgress, type LoadedGlb } from "../assets/glb.js";
import { ARM_JOINT_COUNT, RoverArmController, type ArmJogInput } from "./roverArm.js";
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
const WHEEL_SPRING_RATE = (1025 * 3.72) / (6 * 0.05); // ~5 cm static sag across six wheels

/**
 * Electric traction — the real rovers are battery-electric, and the old combustion defaults
 * (340 N·m through a 5-speed gearbox) geared the 1025 kg rover past 200 km/h equivalent, which
 * is the "way too fast, wheels fly off at hill crests" report. A ~1 kW motor behind a 60:1
 * reduction gives ≈570 N·m at the wheels (≈2160 N tractive — climbs ~34° regolith at Mars
 * gravity) and the motor's no-load speed caps the rover at ≈1.75 m/s ≈ 6 km/h. `regenTorque`
 * blends ≈955 N of regenerative braking in ahead of the friction pads (see `ElectricMotor`).
 */
const ROVER_MOTOR = {
  peakTorque: 9.5,
  peakPower: 1000,
  ratedRpm: 1000,
  maxRpm: 3800,
  regenTorque: 4.2,
  dragTorque: 0.12,
  inertia: 0.02,
};
const ROVER_REDUCTION = 60;

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
const ROCK_CHIP_SPRITES_PER_WHEEL = 10;
const AXIS_X = { x: 1, y: 0, z: 0 };
const AXIS_Y = { x: 0, y: 1, z: 0 };

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
    // The rover tops out around 1.75 m/s: fade in at walking pace, then scale emission with
    // wheel load and tire scrub instead of using a combustion-car speed curve.
    if (kick && kick.speed > 0.2 && kick.normalLoad > 0) {
      const speedFactor = Math.max(0, Math.min(1, (kick.speed - 0.2) / 1.55));
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
  const rockLod = buildLodGeometry({
    hi: unindexedLodWindow(rockGeometrySource({ radius: 0.8, segments: 7, seed: 7, roughness: 0.34 })),
    lo: unindexedLodWindow(rockGeometrySource({ radius: 0.8, segments: 4, seed: 7, roughness: 0.34 })),
  });
  const boulderLod = buildLodGeometry({
    hi: unindexedLodWindow(rockGeometrySource({ radius: 2.4, segments: 8, seed: 11, roughness: 0.3, flatten: 0.4 })),
    lo: unindexedLodWindow(rockGeometrySource({ radius: 2.4, segments: 4, seed: 11, roughness: 0.3, flatten: 0.4 })),
  });
  const rockGeometry = Geometry.create(gpu, rockLod.source);
  const boulderGeometry = Geometry.create(gpu, boulderLod.source);
  const population = new PopulationWorld({
    terrain,
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
      mu: 1.1,
      wheelRadius: WHEEL_RADIUS,
      wheelbase: 2.26,
      track: 2.18,
      cgToFront: 1.095,
      cgHeight: 0.54,
      springRate: WHEEL_SPRING_RATE,
      damperRate: 2 * Math.sqrt(WHEEL_SPRING_RATE * (1025 / 6)) * 0.55,
      aero: null,
      maxBrakeTorque: 3600,
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
  config.suspensionRest = 0.32;
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
  const interactiveRocks = new Map<string, { block: NonNullable<ReturnType<typeof population.chunkPopulation>>; index: number; proxy: InteractiveRockProxy }>();
  let brokenInteractiveRocks = 0;
  const brokenInteractiveRockIds = new Set<string>();
  const roverDamage = { hull: 0, wheels: 0, suspension: 0, disabled: false };
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
  const INTERACTION_RADIUS = 48;
  const MAX_INTERACTIVE_ROCKS = 64;
  const syncInteractiveRocks = (): void => {
    const wanted = new Set<string>();
    for (const [chunkKey, chunk] of terrain.chunks) {
      if (chunk.state !== "ready") continue;
      const block = population.chunkPopulation(chunkKey, 1); // type 1 is the terrain demo's rocks
      if (!block) continue;
      for (let i = 0; i < block.count; i++) {
        const p = i * 3;
        const dx = block.positions[p]! - vehicle.position.x;
        const dz = block.positions[p + 2]! - vehicle.position.z;
        if (dx * dx + dz * dz > INTERACTION_RADIUS * INTERACTION_RADIUS) continue;
        const id = `${chunkKey}:rocks:${i}`;
        if (brokenInteractiveRockIds.has(id)) continue;
        if (!interactiveRocks.has(id) && interactiveRocks.size >= MAX_INTERACTIVE_ROCKS) continue;
        wanted.add(id);
        if (interactiveRocks.has(id)) continue;
        const radius = Math.max(0.12, block.scales[p]! * 0.65);
        const proxy = new InteractiveRockProxy(createInteractiveRockSpec({
          id,
          shape: new SphereShape(radius),
          material: MARS_ROCK_MATERIAL,
          climbRadius: radius,
        }), { x: block.positions[p]!, y: block.positions[p + 1]!, z: block.positions[p + 2]! });
        interactivePhysics.addBody(proxy.body);
        interactiveRocks.set(id, { block, index: i, proxy });
      }
    }
    for (const [id, record] of interactiveRocks) {
      if (wanted.has(id)) continue;
      interactivePhysics.removeBody(record.proxy.body);
      interactiveRocks.delete(id);
    }
  };
  const stepInteractiveRocks = (dt: number): void => {
    syncInteractiveRocks();
    const vx = vehicle.velocity.x;
    const vz = vehicle.velocity.z;
    for (const [id, record] of interactiveRocks) {
      const body = record.proxy.body;
      const dx = body.position.x - vehicle.position.x;
      const dz = body.position.z - vehicle.position.z;
      const distance = Math.hypot(dx, dz);
      if (distance > 1e-4 && distance < 1.6 + (body.shape as SphereShape).radius) {
        const nx = dx / distance;
        const nz = dz / distance;
        const approach = vx * nx + vz * nz;
        if (approach > 0.05) {
          const assessment = bridgeRockContact(record.proxy, {
            roverMass: 1025,
            relativeSpeed: approach,
            availableForce: 2160,
            obstacleHeight: (body.shape as SphereShape).radius * 2,
            vehicleVelocity: vehicle.velocity,
          }, { x: nx, y: 0, z: nz });
          applyRoverImpactDamage(roverDamage, assessment, {
            roverMass: 1025,
            relativeSpeed: approach,
            availableForce: 2160,
            obstacleHeight: (body.shape as SphereShape).radius * 2,
          }, (body.shape as SphereShape).radius * 2, dt);
          if (assessment.outcome === "crushed") {
            // Break now, then remove the proxy from the active world. The zeroed instance is a
            // deterministic settled/broken state; no fragment bodies are spawned in this first slice.
            record.block.scales[record.index * 3] = 0;
            record.block.scales[record.index * 3 + 1] = 0;
            record.block.scales[record.index * 3 + 2] = 0;
            record.block.markModified();
            interactivePhysics.removeBody(body);
            interactiveRocks.delete(id);
            brokenInteractiveRockIds.add(id);
            brokenInteractiveRocks++;
          }
        }
      }
    }
    interactivePhysics.step(dt);
    for (const record of interactiveRocks.values()) {
      const p = record.index * 3;
      const body = record.proxy.body;
      const q = body.rotation;
      const yaw = Math.atan2(2 * (q.w * q.y + q.x * q.z), 1 - 2 * (q.y * q.y + q.z * q.z));
      const moved =
        Math.abs(record.block.positions[p]! - body.position.x) > 1e-5 ||
        Math.abs(record.block.positions[p + 1]! - body.position.y) > 1e-5 ||
        Math.abs(record.block.positions[p + 2]! - body.position.z) > 1e-5 ||
        Math.abs(record.block.rotations[record.index]! - yaw) > 1e-5;
      if (!moved) continue;
      record.block.positions[p] = body.position.x;
      record.block.positions[p + 1] = body.position.y;
      record.block.positions[p + 2] = body.position.z;
      record.block.rotations[record.index] = yaw;
      record.block.markModified();
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
  const armQ = new Quat();
  const armInput: ArmJogInput = { swing: 0, shoulder: 0, elbow: 0, turret: 0 };
  let armPivots: { transform: TransformHandle; axis: Vec3 }[] = [];

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
      }
    }
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
      const pivots: { transform: TransformHandle; axis: Vec3 }[] = [];
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
        pivots.push({ transform: pivot.transform, axis: new Vec3(joint.axis[0], joint.axis[1], joint.axis[2]) });
        parent = pivot;
      }
      armPivots = pivots;
      writeArmPose();
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

  /** Pose every arm pivot from the controller (no-op until the GLB lands). */
  const writeArmPose = (): void => {
    if (armPivots.length === 0) return;
    arm.pose(armPose);
    for (let j = 0; j < armPivots.length; j++) {
      const pivot = armPivots[j]!;
      pivot.transform.rotation = armQ.setAxisAngle(pivot.axis, armPose[j] ?? 0);
    }
  };

  /** Command the arm; the button/keys call this, the controller animates it. */
  const setArm = (deployed: boolean): void => {
    arm.setDeployed(deployed);
    touch.setArm(deployed);
    // Stowing hides the sticks at once; unfolding shows them only once the arm is fully out.
    if (!deployed) armTouch.setVisible(false);
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
  /** One arm jog axis from the keyboard: +1 / −1 while a key of the pair is held. */
  const keyAxis = (positive: string, negative: string): number => (keys.has(positive) ? 1 : 0) - (keys.has(negative) ? 1 : 0);
  const unit = (v: number): number => Math.max(-1, Math.min(1, v));

  return {
    scene,
    cameraEntity,
    controlsHint: "WASD / arrows drive · Space handbrake · M mast · R arm (TFGH / IJKL move it) · HGA auto-tracks Earth · Drag to orbit · Scroll zoom",
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
      vehicle.input.throttle = roverDamage.disabled ? 0 : throttle;
      vehicle.input.brake = Math.max(keyBrake, startupBrake ? 1 : 0, roverDamage.disabled ? 1 : 0);
      vehicle.input.steer = Math.max(-1, Math.min(1, keySteer + pad.steer));
      vehicle.input.handbrake = keys.has("Space") || startupBrake ? 1 : 0;

      // Robotic arm: sticks + keys → joint jog (the controller only applies it once unfolded),
      // pose the pivots when anything moved, and keep the sticks shown exactly while unfolded.
      const sticks = armTouch.sample();
      armInput.swing = unit(sticks.swing + keyAxis("KeyH", "KeyF"));
      armInput.shoulder = unit(sticks.shoulder + keyAxis("KeyT", "KeyG"));
      armInput.elbow = unit(sticks.elbow + keyAxis("KeyI", "KeyK"));
      armInput.turret = unit(sticks.turret + keyAxis("KeyL", "KeyJ"));
      if (armPivots.length > 0 && arm.update(dt, armInput)) writeArmPose();
      armTouch.setVisible(arm.unfolded);
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
      return (
        `mars showcase · Perseverance 6/6 · ${model} · mast ${mastLabel} · arm ${armLabel} · HGA ${antennaLabel}\n` +
        `${MARS_SHOWCASE_SITE.name} · Mars seed ${terrain.seed} · analytic only (no erosion cache) · ${terrainGeneration()} · ${terrain.layeredMaterialsEnabled ? "4-layer PBR" : "single material"}\n` +
        `speed ${(vehicle.speed * 3.6).toFixed(1)} km/h  motor ${vehicle.rpm.toFixed(0)} rpm  ${powerLabel}  wheels ${contact}/6\n` +
        `pos ${vehicle.position.x.toFixed(1)}, ${vehicle.position.y.toFixed(1)}, ${vehicle.position.z.toFixed(1)}  ` +
        `dust ${ambientDust.simulation.alive}+${kickDustAlive()} · chips ${wheelRockChipsAlive()}  NASA/JPL-Caltech (public domain)`
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
        roverDamageHull: roverDamage.hull,
        roverDamageWheels: roverDamage.wheels,
        roverDamageSuspension: roverDamage.suspension,
        roverDisabled: roverDamage.disabled,
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
      keys.clear();
      loaded?.dispose();
      loaded = null;
      for (const resource of hgaResources) resource.dispose();
      hgaResources.length = 0;
      dustMesh.dispose();
      ambientDustMaterial.dispose();
      kickDustMaterial.dispose();
      trackMesh.dispose();
      trackMaterial.dispose();
      population.dispose();
      for (const record of interactiveRocks.values()) interactivePhysics.removeBody(record.proxy.body);
      interactiveRocks.clear();
      interactivePhysics.setHeightfield(null);
      rockGeometry.dispose();
      boulderGeometry.dispose();
      rockMaterial.dispose();
      scene.dispose(); // tile materials/masks before the shared arrays they reference
      terrainMat.dispose();
      disposePbrTextureSet(marsMaps);
      marsMaps = null;
    },
  };
}

