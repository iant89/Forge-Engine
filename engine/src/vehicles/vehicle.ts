/**
 * Raycast vehicle.
 *
 * Four wheels, each a ray against a {@link GroundQuery} (preferably a physics-backed query — see
 * Phase 11). Yaw integrates from tire-plane moments; pitch and roll integrate from suspension
 * reaction torques plus a soft geometric spring while planted. Angular rates carry momentum when
 * wheels unload. The load-transfer formula still
 * accounts for accel quasi-statically. Suspension force is applied along the ground normal, so the
 * horizontal component of the support pushes the car downhill; climbing is tire force, not a
 * scripted height snap.
 *
 * `step(dt)` is the only integrator. The ECS system calls it once per fixed step with
 * `context.fixedDt`. Do not also step from a scene `update`.
 */

import { clamp, f32 } from "../math/scalar.js";
import { Quat } from "../math/mat.js";
import { Vec3 } from "../math/vec.js";
import {
  EngineModel,
  Transmission,
  absBrakeScale,
  aeroLoads,
  splitDriveTorque,
  tractionControlScale,
  ZERO_AERO,
  type AeroConfig,
  type DifferentialType,
  type DrivetrainLayout,
} from "./drivetrain.js";
import type { GroundQuery, GroundSample } from "./ground.js";
import { computeWheelLoads, distributeWheelLoads, type WheelLoads } from "./loads.js";
import { DEFAULT_LATERAL, DEFAULT_LONGITUDINAL, pacejka, pacejkaDerivative, pacejkaPeakSlip, type PacejkaCoefficients } from "./pacejka.js";

export interface VehicleInput {
  /** 0..1 */
  throttle: number;
  /** 0..1 */
  brake: number;
  /** −1..1, positive steers right (positive yaw: +Z rotates toward +X). */
  steer: number;
  /** 0..1, extra rear-wheel brake. */
  handbrake: number;
}

export interface VehicleWheelConfig {
  /** Local position of the hardpoint relative to the CG. +X right, +Z forward. Y is ignored. */
  x: number;
  z: number;
  driven: boolean;
  steered: boolean;
  handbrake: boolean;
}

export interface VehicleConfig {
  mass: number;
  /** Positive scalar. Applied as (0, −gravity, 0). */
  gravity: number;
  /** Yaw inertia (kg·m²). */
  inertiaYaw: number;
  /** Pitch inertia (kg·m²) about the lateral axis. */
  inertiaPitch: number;
  /** Roll inertia (kg·m²) about the longitudinal axis. */
  inertiaRoll: number;
  /** Angular damping for pitch/roll rates (1/s). */
  angularDamping: number;
  wheelbase: number;
  track: number;
  cgHeight: number;
  /** CG to front axle. Defaults to half the wheelbase. */
  cgToFront: number;
  wheelRadius: number;
  wheelInertia: number;
  /** Uncompressed suspension length (hardpoint to wheel centre, along up). */
  suspensionRest: number;
  suspensionTravel: number;
  springRate: number;
  damperRate: number;
  /** Peak friction coefficient. Pacejka D = μ · Fz. */
  mu: number;
  maxSteerAngle: number;
  maxBrakeTorque: number;
  handbrakeTorque: number;
  layout: DrivetrainLayout;
  differential: DifferentialType;
  lsdBias: number;
  slipReference: number;
  longitudinal: Omit<PacejkaCoefficients, "D">;
  lateral: Omit<PacejkaCoefficients, "D">;
  aero: AeroConfig;
  /** Drivetrain efficiency, 0..1. */
  efficiency: number;
  tcEnabled: boolean;
  absEnabled: boolean;
  /** |κ| above which TC starts cutting drive. */
  tcSlip: number;
  tcStrength: number;
  /** |κ| above which ABS starts cutting brake. Defaults to the longitudinal Pacejka peak. */
  absSlip: number;
  absStrength: number;
  engine: EngineModel;
  transmission: Transmission;
  wheels: VehicleWheelConfig[];
}

export interface VehicleOptions {
  mass?: number;
  gravity?: number;
  mu?: number;
  wheelbase?: number;
  track?: number;
  cgHeight?: number;
  cgToFront?: number;
  wheelRadius?: number;
  layout?: DrivetrainLayout;
  differential?: DifferentialType;
  aero?: AeroConfig | null;
  tcEnabled?: boolean;
  absEnabled?: boolean;
  maxBrakeTorque?: number;
  springRate?: number;
  damperRate?: number;
  engine?: EngineModel;
  transmission?: Transmission;
  longitudinal?: Omit<PacejkaCoefficients, "D">;
  lateral?: Omit<PacejkaCoefficients, "D">;
}

export interface WheelState {
  x: number;
  z: number;
  driven: boolean;
  steered: boolean;
  handbrake: boolean;
  omega: number;
  spin: number;
  steerAngle: number;
  compression: number;
  compressionRate: number;
  normalLoad: number;
  longForce: number;
  latForce: number;
  kappa: number;
  alpha: number;
  inContact: boolean;
  contactX: number;
  contactY: number;
  contactZ: number;
  nx: number;
  ny: number;
  nz: number;
}

const WHEEL_COUNT = 4;

function defaultWheels(wheelbase: number, track: number, cgToFront: number, layout: DrivetrainLayout): VehicleWheelConfig[] {
  const half = track * 0.5;
  const rearZ = -(wheelbase - cgToFront);
  const driveFront = layout === "fwd" || layout === "awd";
  const driveRear = layout === "rwd" || layout === "awd";
  return [
    { x: -half, z: cgToFront, driven: driveFront, steered: true, handbrake: false },
    { x: half, z: cgToFront, driven: driveFront, steered: true, handbrake: false },
    { x: -half, z: rearZ, driven: driveRear, steered: false, handbrake: true },
    { x: half, z: rearZ, driven: driveRear, steered: false, handbrake: true },
  ];
}

export function createVehicleConfig(options: VehicleOptions = {}): VehicleConfig {
  const mass = options.mass ?? 1400;
  const wheelbase = options.wheelbase ?? 2.6;
  const track = options.track ?? 1.55;
  const cgToFront = options.cgToFront ?? wheelbase * 0.5;
  const layout = options.layout ?? "rwd";
  const gravity = options.gravity ?? 9.81;
  const springRate = options.springRate ?? (mass * gravity) / (WHEEL_COUNT * 0.06);
  const long = options.longitudinal ?? DEFAULT_LONGITUDINAL;
  return {
    mass,
    gravity,
    inertiaYaw: options.mass ? options.mass * 0.9 : 1200,
    inertiaPitch: options.mass ? options.mass * 0.55 : 700,
    inertiaRoll: options.mass ? options.mass * 0.4 : 500,
    angularDamping: 3.5,
    wheelbase,
    track,
    cgHeight: options.cgHeight ?? 0.5,
    cgToFront,
    wheelRadius: options.wheelRadius ?? 0.34,
    wheelInertia: 0.9,
    suspensionRest: 0.28,
    suspensionTravel: 0.14,
    springRate,
    damperRate: options.damperRate ?? 2 * Math.sqrt(springRate * (mass / WHEEL_COUNT)) * 0.55,
    mu: options.mu ?? 1.05,
    maxSteerAngle: 0.48,
    maxBrakeTorque: options.maxBrakeTorque ?? 4500,
    handbrakeTorque: 6000,
    layout,
    differential: options.differential ?? "lsd",
    lsdBias: 2.5,
    slipReference: 1,
    longitudinal: long,
    lateral: options.lateral ?? DEFAULT_LATERAL,
    aero: options.aero === null ? ZERO_AERO : (options.aero ?? { rho: 1.225, dragCoefficient: 0.31, liftCoefficient: 0.15, frontalArea: 2.2 }),
    efficiency: 0.9,
    tcEnabled: options.tcEnabled ?? true,
    absEnabled: options.absEnabled ?? true,
    tcSlip: 0.12,
    tcStrength: 6,
    absSlip: pacejkaPeakSlip(long),
    absStrength: 10,
    engine: options.engine ?? new EngineModel({ peakTorque: 340, inertia: 0.28, idleRpm: 800, redlineRpm: 6800 }),
    transmission: options.transmission ?? new Transmission(),
    wheels: defaultWheels(wheelbase, track, cgToFront, layout),
  };
}


export interface WheelTelemetry {
  load: number;
  suspensionTravel: number;
  slipRatio: number;
  slipAngle: number;
  tireForceLong: number;
  tireForceLat: number;
  omega: number;
  inContact: boolean;
}

export interface VehicleTelemetry {
  engineRpm: number;
  gear: number;
  speed: number;
  pitch: number;
  roll: number;
  pitchRate: number;
  rollRate: number;
  yawRate: number;
  airborne: boolean;
  wheels: WheelTelemetry[];
}

export class Vehicle {
  readonly config: VehicleConfig;
  readonly position = new Vec3();
  readonly velocity = new Vec3();
  /** Radians. 0 faces +Z. Positive yaw rotates +Z toward +X. */
  yaw = 0;
  yawRate = 0;
  /** Radians. Positive pitch is nose-up. Integrated from suspension reaction + geometric spring (Phase 11.4). */
  pitch = 0;
  /** Radians. Positive roll lifts the right side. Integrated from suspension reaction + geometric spring. */
  roll = 0;
  /** Pitch rate (rad/s). */
  pitchRate = 0;
  /** Roll rate (rad/s). */
  rollRate = 0;
  readonly input: VehicleInput = { throttle: 0, brake: 0, steer: 0, handbrake: 0 };
  readonly wheels: WheelState[];
  /** Body-frame acceleration from the previous step. Load transfer uses this, not a guess. */
  ax = 0;
  ay = 0;
  /** Engine RPM after the last step. In gear it follows the driven wheels, but not below idle. */
  rpm = 0;
  /** Horizontal distance travelled (m). */
  distance = 0;
  stepCount = 0;
  airborne = false;

  private readonly groundSample: GroundSample = { height: 0, nx: 0, ny: 1, nz: 0 };
  private readonly forward = new Vec3(0, 0, 1);
  private readonly right = new Vec3(1, 0, 0);
  private readonly up = new Vec3(0, 1, 0);
  private readonly yawQuat = new Quat();
  private readonly pitchQuat = new Quat();
  private readonly rollQuat = new Quat();
  /** Scratch for shared body-axis → world ω mapping (writeAngularVelocity / hubVelocity). */
  private readonly scratchOmega = new Vec3();
  private prevVx = 0;
  private prevVy = 0;
  private prevVz = 0;
  private readonly torqueInputs: { driven: boolean; omega: number }[];
  private readonly torqueShares: number[];
  private readonly hubLong: number[];

  constructor(config: VehicleConfig = createVehicleConfig()) {
    this.config = config;
    this.torqueInputs = config.wheels.map((w) => ({ driven: w.driven, omega: 0 }));
    this.torqueShares = new Array<number>(config.wheels.length).fill(0);
    this.hubLong = new Array<number>(config.wheels.length).fill(0);
    this.wheels = config.wheels.map((w) => ({
      x: w.x,
      z: w.z,
      driven: w.driven,
      steered: w.steered,
      handbrake: w.handbrake,
      omega: 0,
      spin: 0,
      steerAngle: 0,
      compression: 0,
      compressionRate: 0,
      normalLoad: 0,
      longForce: 0,
      latForce: 0,
      kappa: 0,
      alpha: 0,
      inContact: false,
      contactX: 0,
      contactY: 0,
      contactZ: 0,
      nx: 0,
      ny: 1,
      nz: 0,
    }));
    this.rpm = config.engine.idleRpm;
    if (config.engine.omega < 1 && config.engine.idleRpm > 0) config.engine.rpm = config.engine.idleRpm;
  }

  get speed(): number {
    return Math.hypot(this.velocity.x, this.velocity.z);
  }

  /**
   * Set the chassis velocity and spin the wheels up to match, so a braking or coasting test does
   * not open with a full lockup slip. Also seeds the previous-step velocity used for `ax`/`ay`.
   */
  setVelocity(x: number, y: number, z: number): void {
    this.rebuildBasis();
    this.velocity.set(x, y, z);
    this.prevVx = x;
    this.prevVy = y;
    this.prevVz = z;
    const vLong = x * this.forward.x + y * this.forward.y + z * this.forward.z;
    const omega = vLong / this.config.wheelRadius;
    for (const w of this.wheels) w.omega = omega;
  }

  get gear(): number {
    return this.config.transmission.gear;
  }

  /** Equilibrium spring compression if every wheel shares the static weight equally. */
  equilibriumCompression(): number {
    const c = this.config;
    return clamp((c.mass * c.gravity) / (c.wheels.length * c.springRate), 0, c.suspensionTravel);
  }

  /**
   * Drop the chassis onto `ground` so the suspension sits at equilibrium compression.
   * Call after setting XZ (and yaw). Does not change XZ or velocity.
   */
  placeOnGround(ground: GroundQuery): void {
    const c = this.config;
    this.pitch = 0;
    this.roll = 0;
    this.pitchRate = 0;
    this.rollRate = 0;
    this.snapOrientationToGround(ground);
    ground.sample(this.position.x, this.position.z, this.groundSample);
    const hang = c.wheelRadius + (c.suspensionRest - this.equilibriumCompression());
    this.position.y = this.groundSample.height + hang * Math.max(0.25, this.up.y);
    this.velocity.y = 0;
    this.sampleWheels(ground, 1);
    for (const w of this.wheels) w.compressionRate = 0;
    this.pitchRate = 0;
    this.rollRate = 0;
  }

  /** Chassis orientation: yaw, then local pitch (nose-up), then local roll. */
  writeRotation(out: Quat): Quat {
    out.setEulerComponents(0, this.yaw, 0);
    if (this.pitch === 0 && this.roll === 0) return out;
    // Local +X pitch is nose-down in the right-hand sense, so the angle is negated.
    this.pitchQuat.setAxisAngle(AXIS_X, -this.pitch);
    this.rollQuat.setAxisAngle(AXIS_Z, this.roll);
    out.multiply(this.pitchQuat);
    out.multiply(this.rollQuat);
    return out;
  }

  /**
   * World-space angular velocity from body-axis Euler rates (rad/s).
   * After {@link rebuildBasis}: ω = −pitchRate·right + yawRate·up + rollRate·forward.
   * Pitch is negated so positive pitchRate (nose-up) matches {@link writeRotation}'s −pitch Euler
   * (local +X RH spin is nose-down in Y-up / +Z-forward).
   */
  writeAngularVelocity(out: Vec3): Vec3 {
    this.rebuildBasis();
    return this.writeBodyAngularVelocity(out);
  }

  /**
   * Map body-axis Euler rates to world ω (basis must already be current).
   * Shared by chassis sync and hubVelocity so the pitch sign cannot drift.
   */
  private writeBodyAngularVelocity(out: Vec3): Vec3 {
    out.x = -this.pitchRate * this.right.x + this.yawRate * this.up.x + this.rollRate * this.forward.x;
    out.y = -this.pitchRate * this.right.y + this.yawRate * this.up.y + this.rollRate * this.forward.y;
    out.z = -this.pitchRate * this.right.z + this.yawRate * this.up.z + this.rollRate * this.forward.z;
    return out;
  }

  /** Phase 11.8 telemetry snapshot for HUD / tests. */
  telemetry(): VehicleTelemetry {
    return {
      engineRpm: this.rpm,
      gear: this.gear,
      speed: this.speed,
      pitch: this.pitch,
      roll: this.roll,
      pitchRate: this.pitchRate,
      rollRate: this.rollRate,
      yawRate: this.yawRate,
      airborne: this.airborne,
      wheels: this.wheels.map((w) => ({
        load: w.normalLoad,
        suspensionTravel: w.compression,
        slipRatio: w.kappa,
        slipAngle: w.alpha,
        tireForceLong: w.longForce,
        tireForceLat: w.latForce,
        omega: w.omega,
        inContact: w.inContact,
      })),
    };
  }

  wheelLoads(): WheelLoads {
    const c = this.config;
    const down = aeroLoads(this.speed, c.aero).downforce;
    return computeWheelLoads({
      mass: c.mass,
      gravity: c.gravity,
      wheelbase: c.wheelbase,
      cgToFront: c.cgToFront,
      cgHeight: c.cgHeight,
      ax: this.ax,
      ay: this.ay,
      track: c.track,
      downforce: down,
    });
  }

  /**
   * Advance the car by `dt` seconds. Internally substeps at ≤ 1/120 s so a 60 Hz caller and a
   * hitch both stay stable. Substeps share the input sampled at the start of the call.
   */
  step(dt: number, ground: GroundQuery): void {
    if (!(dt > 0) || !Number.isFinite(dt)) return;
    const sub = 1 / 120;
    let left = dt;
    while (left > 1e-8) {
      const h = Math.min(sub, left);
      this.integrate(h, ground);
      left -= h;
    }
  }

  private integrate(dt: number, ground: GroundQuery): void {
    const c = this.config;
    const throttle = clamp(this.input.throttle, 0, 1);
    const brake = clamp(this.input.brake, 0, 1);
    const handbrake = clamp(this.input.handbrake, 0, 1);

    this.rebuildBasis();
    this.sampleWheels(ground, dt);

    // Four wheels use the calibrated axle model; other layouts (six-wheel rocker rovers) get the
    // generic N-wheel fit over the actual hardpoints. Out-of-contact wheels zero below either way.
    let loadArr: number[];
    if (this.wheels.length === 4) {
      const loads = this.wheelLoads();
      loadArr = [loads.fl, loads.fr, loads.rl, loads.rr];
    } else {
      const down = aeroLoads(this.speed, c.aero).downforce;
      loadArr = distributeWheelLoads(this.wheels, {
        mass: c.mass,
        gravity: c.gravity,
        cgHeight: c.cgHeight,
        ax: this.ax,
        ay: this.ay,
        downforce: down,
      });
    }
    let contactCount = 0;
    for (let i = 0; i < this.wheels.length; i++) {
      const w = this.wheels[i]!;
      w.normalLoad = w.inContact ? loadArr[i]! : 0;
      if (w.inContact) contactCount++;
    }
    this.airborne = contactCount === 0;

    // Shares are split before the slip clamp so TC knows the sign. The scale is applied *after*
    // holdSlip, using the slip the tire will actually see — the previous step's post-integration
    // ω is a numerical overshoot, and cutting torque from it makes the tire reaction reverse the wheel.
    c.engine.throttle = throttle;
    const ratio = c.transmission.ratio;
    const engineTorque = ratio !== 0 ? c.engine.deliveredTorque(0) : 0;
    const wheelTorqueTotal = engineTorque * ratio * c.efficiency;
    for (let i = 0; i < this.wheels.length; i++) {
      const w = this.wheels[i]!;
      const input = this.torqueInputs[i]!;
      input.driven = w.driven;
      input.omega = w.omega;
    }
    const shares = splitDriveTorque(wheelTorqueTotal, this.torqueInputs, c.differential, c.lsdBias, this.torqueShares);

    const hubLong = this.hubLong;
    let peakDrivenSlip = 0;
    for (let i = 0; i < this.wheels.length; i++) {
      const w = this.wheels[i]!;
      if (!w.inContact) {
        hubLong[i] = 0;
        w.kappa = 0;
        w.alpha = 0;
        continue;
      }
      const hub = this.hubVelocity(w);
      const heading = this.yaw + w.steerAngle;
      hubLong[i] = hub.x * Math.sin(heading) + hub.z * Math.cos(heading);
      this.balanceLongitudinal(w, shares[i] ?? 0, brake, handbrake, hubLong[i]!, dt);
      if (w.driven) peakDrivenSlip = Math.max(peakDrivenSlip, Math.abs(w.kappa));
    }
    // TC scale is applied on top of the slip clamp: a wheel already held at `tcSlip` is not cut,
    // but a wheel that the clamp did not catch (TC off, or slip still rising) is.
    const tcScale = c.tcEnabled ? tractionControlScale(peakDrivenSlip, c.tcSlip, c.tcStrength) : 1;
    if (tcScale !== 1) {
      for (let i = 0; i < shares.length; i++) shares[i] = (shares[i] ?? 0) * tcScale;
    }

    let fx = 0;
    let fy = 0;
    let fz = 0;
    let yawTorque = 0;
    let pitchTorque = 0;
    let rollTorque = 0;

    for (let i = 0; i < this.wheels.length; i++) {
      const w = this.wheels[i]!;
      const spring = w.inContact ? c.springRate * w.compression + c.damperRate * w.compressionRate : 0;
      const support = Math.max(0, spring);
      fx += w.nx * support;
      fy += w.ny * support;
      fz += w.nz * support;
      if (w.inContact && support > 0) {
        // Suspension reaction torque about CG (Phase 11.4).
        const rx = w.contactX - this.position.x;
        const ry = w.contactY - this.position.y;
        const rz = w.contactZ - this.position.z;
        const sx = w.nx * support;
        const sy = w.ny * support;
        const sz = w.nz * support;
        const tx = ry * sz - rz * sy;
        const ty = rz * sx - rx * sz;
        const tz = rx * sy - ry * sx;
        pitchTorque += tx * this.right.x + ty * this.right.y + tz * this.right.z;
        rollTorque += tx * this.forward.x + ty * this.forward.y + tz * this.forward.z;
      }

      if (!w.inContact || w.normalLoad <= 0) {
        w.longForce = 0;
        w.latForce = 0;
        const free = (shares[i] ?? 0) / c.wheelInertia;
        w.omega = f32(w.omega + free * dt);
        w.spin = f32(w.spin + w.omega * dt);
        continue;
      }

      const hub = this.hubVelocity(w);
      const heading = w.steerAngle;
      const s = Math.sin(this.yaw + heading);
      const co = Math.cos(this.yaw + heading);
      // Wheel forward / right in the ground plane (yaw + steer). +steer is a right turn.
      const wfx = s;
      const wfz = co;
      const wrx = co;
      const wrz = -s;
      const vLong = hubLong[i]!;
      const vLat = hub.x * wrx + hub.z * wrz;
      const ref = Math.max(Math.abs(vLong), c.slipReference);
      w.alpha = Math.atan2(vLat, ref);
      // A brake that has already blown past the ABS slip is scaled down; the slip solve has already
      // held κ on the rising face, so this only trims a request the clamp did not fully catch.
      const absScale = c.absEnabled ? absBrakeScale(w.kappa, c.absSlip, c.absStrength) : 1;
      if (absScale !== 1 && brake > 0) {
        // Re-balance with the cut brake so the force and the wheel speed agree.
        this.balanceLongitudinal(w, shares[i] ?? 0, brake * absScale, handbrake, vLong, dt);
      }

      const D = c.mu * w.normalLoad;
      let longF = pacejka(w.kappa, { ...c.longitudinal, D });
      let latF = -pacejka(w.alpha, { ...c.lateral, D });
      const mag = Math.hypot(longF, latF);
      const limit = c.mu * w.normalLoad;
      if (mag > limit && mag > 1e-8) {
        const scale = limit / mag;
        longF *= scale;
        latF *= scale;
      }
      w.longForce = longF;
      w.latForce = latF;
      const worldX = wfx * longF + wrx * latF;
      const worldZ = wfz * longF + wrz * latF;
      fx += worldX;
      fz += worldZ;

      const rx = w.contactX - this.position.x;
      const rz = w.contactZ - this.position.z;
      yawTorque += rz * worldX - rx * worldZ;
      w.spin = f32(w.spin + w.omega * dt);
    }

    const aero = aeroLoads(this.speed, c.aero);
    if (this.speed > 0.05) {
      fx -= (this.velocity.x / this.speed) * aero.drag;
      fz -= (this.velocity.z / this.speed) * aero.drag;
    }
    fy -= aero.downforce;
    fy -= c.mass * c.gravity;

    const invM = 1 / c.mass;
    this.velocity.x = f32(this.velocity.x + fx * invM * dt);
    this.velocity.y = f32(this.velocity.y + fy * invM * dt);
    this.velocity.z = f32(this.velocity.z + fz * invM * dt);

    // Damp the velocity *into* the ground, not world Y — world-Y damping fights a car tracking a slope.
    if (contactCount > 0) {
      const vn = this.velocity.x * this.up.x + this.velocity.y * this.up.y + this.velocity.z * this.up.z;
      const keep = Math.max(0, 1 - 1.5 * dt);
      const cut = vn * (1 - keep);
      this.velocity.x -= this.up.x * cut;
      this.velocity.y -= this.up.y * cut;
      this.velocity.z -= this.up.z * cut;
    }

    this.yawRate = f32(this.yawRate + (yawTorque / c.inertiaYaw) * dt);
    this.yawRate *= Math.max(0, 1 - 0.15 * dt);

    // Pitch / roll (Phase 11.4): suspension reaction torques only (no tire pitch/roll moments),
    // plus a critically-damped spring toward the geometric axle orientation while >= 3 wheels plant.
    // Airborne / sparse contact: spring is off so rates carry momentum (jump / unload / rollover).
    //
    // The geometric spring must be soft enough that suspension forces dominate on rough terrain —
    // a stiff spring (wn ≈ 18) snaps the chassis to the *averaged* ground orientation and kills
    // the developing pitch/roll from individual wheel contacts. A softer spring (wn ≈ 5) lets the
    // suspension articulate the chassis while still settling the pose on flat ground.
    const torqueScale = 0.65;
    // Negate pitch torque: τ·right > 0 is nose-down RH about +right; pitchRate is nose-up.
    this.pitchRate = f32(this.pitchRate + ((-pitchTorque * torqueScale) / c.inertiaPitch) * dt);
    this.rollRate = f32(this.rollRate + ((rollTorque * torqueScale) / c.inertiaRoll) * dt);
    if (contactCount >= 3) {
      const target = this.estimateGroundOrientation(ground);
      const wn = 5; // natural frequency — soft so suspension forces dominate on rough terrain
      const zeta = 1.0; // critical damping
      const kp = wn * wn;
      const kd = 2 * zeta * wn;
      this.pitchRate += (kp * (target.pitch - this.pitch) - kd * this.pitchRate) * dt;
      this.rollRate += (kp * (target.roll - this.roll) - kd * this.rollRate) * dt;
    } else {
      const angKeep = Math.max(0, 1 - c.angularDamping * dt);
      this.pitchRate *= angKeep;
      this.rollRate *= angKeep;
    }
    this.pitch = f32(this.pitch + this.pitchRate * dt);
    this.roll = f32(this.roll + this.rollRate * dt);
    const lim = Math.PI * 0.65;
    if (this.pitch > lim) { this.pitch = lim; this.pitchRate = Math.min(0, this.pitchRate); }
    if (this.pitch < -lim) { this.pitch = -lim; this.pitchRate = Math.max(0, this.pitchRate); }
    if (this.roll > lim) { this.roll = lim; this.rollRate = Math.min(0, this.rollRate); }
    if (this.roll < -lim) { this.roll = -lim; this.rollRate = Math.max(0, this.rollRate); }

    const prevX = this.position.x;
    const prevZ = this.position.z;
    this.position.x = f32(this.position.x + this.velocity.x * dt);
    this.position.y = f32(this.position.y + this.velocity.y * dt);
    this.position.z = f32(this.position.z + this.velocity.z * dt);
    this.yaw = f32(this.yaw + this.yawRate * dt);
    this.distance += Math.hypot(this.position.x - prevX, this.position.z - prevZ);

    // Keep basis in sync with integrated yaw/pitch/roll before penetration lift and body-frame ax/ay.
    this.rebuildBasis();
    this.correctPenetration(ground);
    // Static friction: a held brake should stop the car, not leave a 1 m/s creep from the slip floor.
    if ((brake > 0.5 || handbrake > 0.5) && this.speed < 0.35 && contactCount > 0) {
      this.velocity.x = 0;
      this.velocity.z = 0;
      this.yawRate *= 0.5;
      for (const w of this.wheels) if (Math.abs(w.omega) < 2) w.omega = 0;
    }

    // Body-frame acceleration for the *next* step's load transfer.
    const dVx = (this.velocity.x - this.prevVx) / dt;
    const dVy = (this.velocity.y - this.prevVy) / dt;
    const dVz = (this.velocity.z - this.prevVz) / dt;
    this.ax = dVx * this.forward.x + dVy * this.forward.y + dVz * this.forward.z;
    this.ay = dVx * this.right.x + dVy * this.right.y + dVz * this.right.z;
    this.prevVx = this.velocity.x;
    this.prevVy = this.velocity.y;
    this.prevVz = this.velocity.z;

    this.updateRpm(throttle, dt);
    this.stepCount++;

    if (!Number.isFinite(this.position.x) || !Number.isFinite(this.velocity.x)) {
      this.velocity.set(0, 0, 0);
      this.yawRate = 0;
      this.pitchRate = 0;
      this.rollRate = 0;
    }
  }

  /** Yaw, then pitch about the yawed right axis, then roll about the pitched forward axis. */
  private rebuildBasis(): void {
    this.yawQuat.setEulerComponents(0, this.yaw, 0);
    this.yawQuat.rotateVector(BASIS_FORWARD, this.forward);
    this.yawQuat.rotateVector(BASIS_RIGHT, this.right);
    this.up.set(0, 1, 0);
    const cp = Math.cos(this.pitch);
    const sp = Math.sin(this.pitch);
    if (this.pitch !== 0) {
      const fx = this.forward.x;
      const fy = this.forward.y;
      const fz = this.forward.z;
      // forward' = forward·cos + worldUp·sin, up' = worldUp·cos − forward·sin. Nose-up is +pitch.
      this.forward.set(fx * cp, fy * cp + sp, fz * cp);
      this.up.set(-fx * sp, cp - fy * sp, -fz * sp);
    }
    if (this.roll !== 0) {
      const cr = Math.cos(this.roll);
      const sr = Math.sin(this.roll);
      const rx = this.right.x;
      const ry = this.right.y;
      const rz = this.right.z;
      const ux = this.up.x;
      const uy = this.up.y;
      const uz = this.up.z;
      this.right.set(rx * cr + ux * sr, ry * cr + uy * sr, rz * cr + uz * sr);
      this.up.set(ux * cr - rx * sr, uy * cr - ry * sr, uz * cr - rz * sr);
    }
  }

  /**
   * One-shot geometric orientation from axle heights (spawn / placeOnGround only).
   */
  private snapOrientationToGround(ground: GroundQuery): void {
    const o = this.estimateGroundOrientation(ground);
    this.pitch = o.pitch;
    this.roll = o.roll;
    this.rebuildBasis();
  }

  /**
   * Geometric pitch/roll implied by ground under the hardpoints. Soft target while three or more
   * wheels plant; rates still integrate freely when contact is sparse or airborne (Phase 11.4).
   */
  private estimateGroundOrientation(ground: GroundQuery): { pitch: number; roll: number } {
    this.rebuildBasis();
    let hFront = 0;
    let hRear = 0;
    let hLeft = 0;
    let hRight = 0;
    let nFront = 0;
    let nRear = 0;
    let nLeft = 0;
    let nRight = 0;
    let xFront = 0;
    let zFront = 0;
    let xRear = 0;
    let zRear = 0;
    let xLeft = 0;
    let zLeft = 0;
    let xRight = 0;
    let zRight = 0;
    for (const w of this.wheels) {
      const x = this.position.x + this.right.x * w.x + this.forward.x * w.z;
      const z = this.position.z + this.right.z * w.x + this.forward.z * w.z;
      ground.sample(x, z, this.groundSample);
      const h = this.groundSample.height;
      if (w.z >= 0) {
        hFront += h;
        xFront += x;
        zFront += z;
        nFront++;
      } else {
        hRear += h;
        xRear += x;
        zRear += z;
        nRear++;
      }
      if (w.x <= 0) {
        hLeft += h;
        xLeft += x;
        zLeft += z;
        nLeft++;
      } else {
        hRight += h;
        xRight += x;
        zRight += z;
        nRight++;
      }
    }
    let pitch = this.pitch;
    let roll = this.roll;
    if (nFront > 0 && nRear > 0) {
      hFront /= nFront;
      hRear /= nRear;
      xFront /= nFront;
      zFront /= nFront;
      xRear /= nRear;
      zRear /= nRear;
      const axleDist = Math.max(0.2, Math.hypot(xFront - xRear, zFront - zRear));
      pitch = Math.atan2(hFront - hRear, axleDist);
    }
    if (nLeft > 0 && nRight > 0) {
      hLeft /= nLeft;
      hRight /= nRight;
      xLeft /= nLeft;
      zLeft /= nLeft;
      xRight /= nRight;
      zRight /= nRight;
      const trackDist = Math.max(0.2, Math.hypot(xLeft - xRight, zLeft - zRight));
      roll = Math.atan2(hRight - hLeft, trackDist);
    }
    return { pitch, roll };
  }

  private sampleWheels(ground: GroundQuery, dt: number): void {
    const c = this.config;
    const uy = this.up.y > 0.2 ? this.up.y : 0.2;
    for (const w of this.wheels) {
      w.steerAngle = w.steered ? steerAngle(this.input.steer, c.maxSteerAngle, this.speed) * (w.z < 0 ? -1 : 1) : 0;
      const hx = this.position.x + this.right.x * w.x + this.forward.x * w.z;
      const hy = this.position.y + this.right.y * w.x + this.forward.y * w.z;
      const hz = this.position.z + this.right.z * w.x + this.forward.z * w.z;
      let t = c.suspensionRest + c.wheelRadius;
      for (let k = 0; k < 3; k++) {
        ground.sample(hx - this.up.x * t, hz - this.up.z * t, this.groundSample);
        t = (hy - this.groundSample.height) / uy;
      }
      w.contactX = hx - this.up.x * t;
      w.contactY = this.groundSample.height;
      w.contactZ = hz - this.up.z * t;
      w.nx = this.groundSample.nx;
      w.ny = this.groundSample.ny;
      w.nz = this.groundSample.nz;
      const suspLen = t - c.wheelRadius;
      const raw = c.suspensionRest - suspLen;
      const prev = w.compression;
      if (raw <= 0) {
        w.inContact = false;
        w.compression = 0;
      } else {
        w.inContact = true;
        w.compression = Math.min(raw, c.suspensionTravel);
      }
      w.compressionRate = (w.compression - prev) / dt;
    }
  }

  private hubVelocity(w: WheelState): { x: number; z: number } {
    const rx = w.contactX - this.position.x;
    const ry = w.contactY - this.position.y;
    const rz = w.contactZ - this.position.z;
    // Full ω×r via the shared body-axis → world mapping (pitch sign matches chassis sync).
    const omega = this.writeBodyAngularVelocity(this.scratchOmega);
    const wx = omega.x;
    const wy = omega.y;
    const wz = omega.z;
    return {
      x: this.velocity.x + (wy * rz - wz * ry),
      z: this.velocity.z + (wx * ry - wy * rx),
    };
  }

  /**
   * Quasi-static longitudinal slip. A Pacejka tire at 120 Hz is too stiff to integrate explicitly:
   * wheel speed jumps past the peak and the force reverses on the next step. Solve for the slip
   * whose tire torque balances drive minus brake, and stay on the rising face.
   *
   * TC and ABS tighten that clamp. An unaided wheel whose demand exceeds the peak is allowed to
   * spin up, so traction control has a higher slip to compare against.
   */
  private balanceLongitudinal(w: WheelState, driveTorque: number, brake: number, handbrake: number, vLong: number, dt: number): void {
    const c = this.config;
    const r = c.wheelRadius;
    const ref = Math.max(Math.abs(vLong), c.slipReference);
    let brakeTorque = brake * c.maxBrakeTorque;
    if (w.handbrake) brakeTorque += handbrake * c.handbrakeTorque;

    if (!w.driven && brakeTorque < 1) {
      w.omega = vLong / r;
      w.kappa = 0;
      return;
    }

    let demand = driveTorque;
    if (brakeTorque > 0) {
      const oppose = Math.abs(vLong) > 0.25 ? Math.sign(vLong) : Math.abs(w.omega) > 0.25 ? Math.sign(w.omega) : 1;
      demand -= brakeTorque * oppose;
    }

    const D = c.mu * Math.max(0, w.normalLoad);
    const peakSlip = Math.max(0.05, c.absSlip);
    if (D < 1) {
      w.omega = f32(w.omega + (demand / c.wheelInertia) * dt);
      w.kappa = (w.omega * r - vLong) / ref;
      return;
    }

    const peakF = Math.abs(pacejka(peakSlip, { ...c.longitudinal, D }));
    const demandF = demand / r;
    const aided = (c.tcEnabled && w.driven && Math.abs(driveTorque) > 1) || (c.absEnabled && brakeTorque > 1 && Math.abs(vLong) > 0.4);
    if (Math.abs(demandF) > peakF && !aided) {
      const excess = demand - Math.sign(demand || 1) * peakF * r;
      w.omega = f32(w.omega + (excess / c.wheelInertia) * dt);
      w.kappa = (w.omega * r - vLong) / ref;
      return;
    }

    let kappa = clamp((w.omega * r - vLong) / ref, -peakSlip, peakSlip);
    const coeff = { ...c.longitudinal, D };
    for (let n = 0; n < 5; n++) {
      const F = pacejka(kappa, coeff);
      const dF = pacejkaDerivative(kappa, coeff);
      if (Math.abs(dF) < 1e-2) break;
      kappa = clamp(kappa + (demandF - F) / dF, -peakSlip, peakSlip);
    }
    if (c.tcEnabled && w.driven && driveTorque > 1) kappa = Math.min(kappa, c.tcSlip);
    if (c.tcEnabled && w.driven && driveTorque < -1) kappa = Math.max(kappa, -c.tcSlip);
    if (c.absEnabled && brakeTorque > 1 && Math.abs(vLong) > 0.4) {
      const sign = Math.sign(vLong) || 1;
      const lockSlip = -sign * c.absSlip;
      kappa = sign > 0 ? Math.max(kappa, lockSlip) : Math.min(kappa, lockSlip);
    }
    w.kappa = kappa;
    w.omega = (vLong + kappa * ref) / r;
  }

  /** Keep a fully compressed wheel from tunneling. Lift is along vehicle up, not world Y. */
  private correctPenetration(ground: GroundQuery): void {
    const c = this.config;
    const uy = this.up.y > 0.2 ? this.up.y : 0.2;
    const minT = c.wheelRadius + (c.suspensionRest - c.suspensionTravel);
    let lift = 0;
    for (const w of this.wheels) {
      const hx = this.position.x + this.right.x * w.x + this.forward.x * w.z;
      const hy = this.position.y + this.right.y * w.x + this.forward.y * w.z;
      const hz = this.position.z + this.right.z * w.x + this.forward.z * w.z;
      ground.sample(hx, hz, this.groundSample);
      const t = (hy - this.groundSample.height) / uy;
      if (t < minT) lift = Math.max(lift, minT - t);
    }
    if (lift > 0) {
      this.position.x += this.up.x * lift;
      this.position.y += this.up.y * lift;
      this.position.z += this.up.z * lift;
      const vn = this.velocity.x * this.up.x + this.velocity.y * this.up.y + this.velocity.z * this.up.z;
      if (vn < 0) {
        this.velocity.x -= this.up.x * vn;
        this.velocity.y -= this.up.y * vn;
        this.velocity.z -= this.up.z * vn;
      }
    }
  }

  private updateRpm(throttle: number, dt: number): void {
    const c = this.config;
    const ratio = c.transmission.ratio;
    if (ratio !== 0) {
      let sum = 0;
      let n = 0;
      for (const w of this.wheels) {
        if (!w.driven) continue;
        sum += w.omega;
        n++;
      }
      const avg = n > 0 ? sum / n : 0;
      const wheelOmega = Math.abs(avg * ratio);
      const idleOmega = (c.engine.idleRpm * 2 * Math.PI) / 60;
      // Below idle the crank is not locked to the wheels (torque-converter slip). A locked
      // reading sits at 0 rpm whenever the car is stopped in gear, and the next step's torque
      // curve then uses that stall. Hold idle; wheel speed still wins once it is higher.
      c.engine.omega = Math.max(wheelOmega, idleOmega);
      if (c.engine.rpm > c.engine.redlineRpm) c.engine.rpm = c.engine.redlineRpm;
    } else {
      c.engine.throttle = throttle;
      c.engine.step(dt, 0);
    }
    this.rpm = c.engine.rpm;
    c.transmission.update(this.rpm, throttle, dt);
  }
}

const BASIS_FORWARD = new Vec3(0, 0, 1);
const BASIS_RIGHT = new Vec3(1, 0, 0);
const AXIS_X = { x: 1, y: 0, z: 0 };
const AXIS_Z = { x: 0, y: 0, z: 1 };

function steerAngle(input: number, maxAngle: number, speed: number): number {
  // Soften the lock at speed so the playground doesn't swap ends from a full-lock tap.
  const soften = 1 / (1 + Math.max(0, speed - 8) * 0.04);
  return clamp(input, -1, 1) * maxAngle * soften;
}
