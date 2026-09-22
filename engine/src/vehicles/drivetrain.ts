/**
 * Engine, gearbox, differential, aero and the two driver aids (TC / ABS).
 *
 * These are pure enough to unit-test without a chassis: torque→RPM is an inertia integral,
 * shift points are a threshold on that RPM, and the differential is a torque split. The vehicle
 * composes them; it does not hide the equations.
 */

import { clamp } from "../math/scalar.js";

export interface EngineModelOptions {
  /** Rotational inertia about the crank (kg·m²). */
  inertia?: number;
  /** Peak torque (N·m) of a flat curve, used when `torqueCurve` is omitted. */
  peakTorque?: number;
  /** Constant friction torque opposing crank rotation (N·m). */
  frictionTorque?: number;
  idleRpm?: number;
  redlineRpm?: number;
  /** Optional curve. Return value is clamped to ≥ 0. RPM may be outside the idle/redline band. */
  torqueCurve?: (rpm: number) => number;
}

/**
 * Crank dynamics with no gearbox attached: `I·α = throttle·τ(rpm) − friction − load`.
 * A flat curve and zero load is the analytic case the torque→RPM test checks.
 */
export class EngineModel {
  inertia: number;
  peakTorque: number;
  frictionTorque: number;
  idleRpm: number;
  redlineRpm: number;
  throttle = 0;
  /** Crank speed (rad/s). Positive only — the gearbox owns direction. */
  omega = 0;
  private readonly curve: (rpm: number) => number;

  constructor(options: EngineModelOptions = {}) {
    this.inertia = Math.max(1e-4, options.inertia ?? 0.25);
    this.peakTorque = options.peakTorque ?? 320;
    this.frictionTorque = options.frictionTorque ?? 0;
    this.idleRpm = options.idleRpm ?? 900;
    this.redlineRpm = options.redlineRpm ?? 6800;
    this.curve = options.torqueCurve ?? ((rpm) => this.flatCurve(rpm));
  }

  get rpm(): number {
    return (this.omega * 60) / (2 * Math.PI);
  }

  set rpm(value: number) {
    this.omega = (Math.max(0, value) * 2 * Math.PI) / 60;
  }

  /** Torque the crank can deliver right now, after throttle, friction and the rev limiter. */
  deliveredTorque(loadTorque = 0): number {
    void loadTorque;
    if (this.rpm >= this.redlineRpm) return 0;
    const raw = Math.max(0, this.curve(this.rpm));
    return Math.max(0, this.throttle * raw - this.frictionTorque);
  }

  /**
   * Advance the crank. `loadTorque` is the torque the clutch is pulling out of the engine
   * (positive when the wheels are loading the crank). Returns the torque actually delivered
   * to the clutch this step (before the load is subtracted from the crank).
   */
  step(dt: number, loadTorque = 0): number {
    const delivered = this.deliveredTorque(loadTorque);
    const net = delivered - Math.max(0, loadTorque);
    this.omega = Math.max(0, this.omega + (net / this.inertia) * dt);
    if (this.rpm > this.redlineRpm) this.omega = (this.redlineRpm * 2 * Math.PI) / 60;
    return delivered;
  }

  private flatCurve(rpm: number): number {
    if (rpm < this.idleRpm * 0.5) return this.peakTorque * 0.35;
    if (rpm > this.redlineRpm) return 0;
    // Gentle taper over the last 15% so the limiter is not a step.
    const taperStart = this.redlineRpm * 0.85;
    if (rpm > taperStart) {
      const t = clamp((rpm - taperStart) / (this.redlineRpm - taperStart), 0, 1);
      return this.peakTorque * (1 - t);
    }
    return this.peakTorque;
  }
}

export interface TransmissionOptions {
  /** Forward ratios, 1st gear first. Must be non-empty. */
  ratios?: number[];
  reverseRatio?: number;
  finalDrive?: number;
  upshiftRpm?: number;
  downshiftRpm?: number;
  /** Clutch-open time after a shift (seconds). Ratio reads as 0 while this is running. */
  shiftDuration?: number;
  /** Throttle below this will not provoke an upshift (avoids shifting while coasting in). */
  upshiftThrottle?: number;
}

/**
 * Gearbox. `gear` is 1..N forward, 0 neutral, −1 reverse. `ratio` is the total crank-to-wheel
 * ratio (gear × final drive), or 0 while the clutch is open.
 */
export class Transmission {
  readonly ratios: number[];
  reverseRatio: number;
  finalDrive: number;
  upshiftRpm: number;
  downshiftRpm: number;
  shiftDuration: number;
  upshiftThrottle: number;
  gear = 1;
  /** Remaining clutch-open time. */
  shiftTimer = 0;
  /** Shifts completed. Tests and the HUD both read this. */
  shiftCount = 0;

  constructor(options: TransmissionOptions = {}) {
    this.ratios = options.ratios ?? [3.4, 2.1, 1.45, 1.1, 0.85];
    this.reverseRatio = options.reverseRatio ?? 3.2;
    this.finalDrive = options.finalDrive ?? 3.7;
    this.upshiftRpm = options.upshiftRpm ?? 6200;
    this.downshiftRpm = options.downshiftRpm ?? 2200;
    this.shiftDuration = options.shiftDuration ?? 0.12;
    this.upshiftThrottle = options.upshiftThrottle ?? 0.15;
  }

  get shifting(): boolean {
    return this.shiftTimer > 0;
  }

  /** Signed crank-to-wheel ratio. 0 in neutral or while the clutch is open. */
  get ratio(): number {
    if (this.shiftTimer > 0 || this.gear === 0) return 0;
    if (this.gear < 0) return -this.reverseRatio * this.finalDrive;
    const g = this.ratios[this.gear - 1];
    return g === undefined ? 0 : g * this.finalDrive;
  }

  /**
   * Consider a shift. A crossing of `upshiftRpm` / `downshiftRpm` changes gear immediately and
   * opens the clutch for `shiftDuration`. Returns true when a shift happened this call.
   */
  update(rpm: number, throttle: number, dt: number): boolean {
    if (this.shiftTimer > 0) {
      this.shiftTimer = Math.max(0, this.shiftTimer - dt);
      return false;
    }
    if (this.gear >= 1 && this.gear < this.ratios.length && rpm >= this.upshiftRpm && throttle >= this.upshiftThrottle) {
      this.gear += 1;
      this.shiftTimer = this.shiftDuration;
      this.shiftCount += 1;
      return true;
    }
    if (this.gear > 1 && rpm > 0 && rpm <= this.downshiftRpm) {
      this.gear -= 1;
      this.shiftTimer = this.shiftDuration;
      this.shiftCount += 1;
      return true;
    }
    return false;
  }
}

export type DrivetrainLayout = "fwd" | "rwd" | "awd";
export type DifferentialType = "open" | "locked" | "lsd";

export interface WheelTorqueInput {
  driven: boolean;
  /** Wheel speed (rad/s). LSD biases torque toward the slower wheel. */
  omega: number;
}

/**
 * Split a gearbox output torque across wheels.
 *
 * Open: equal share of the driven wheels (the unlocked case — a spinning wheel takes its share
 * and no more, which is exactly why TC exists).
 * Locked: equal share, plus the caller is expected to average wheel speeds.
 * LSD: open split biased by `bias` toward the slower wheel. `bias` 1 is open; 3 means the slower
 * wheel may receive up to 3× the faster wheel's torque.
 */
export function splitDriveTorque(
  totalTorque: number,
  wheels: readonly WheelTorqueInput[],
  type: DifferentialType,
  bias = 2.5,
  out: number[] = new Array<number>(wheels.length).fill(0),
): number[] {
  out.length = wheels.length;
  for (let i = 0; i < wheels.length; i++) out[i] = 0;
  const driven: number[] = [];
  for (let i = 0; i < wheels.length; i++) if (wheels[i]!.driven) driven.push(i);
  if (driven.length === 0 || totalTorque === 0) return out;
  if (type === "open" || type === "locked" || driven.length === 1) {
    const share = totalTorque / driven.length;
    for (const i of driven) out[i] = share;
    return out;
  }
  // LSD: weight = 1 / (|omega| + eps), then clamp the max/min weight ratio to `bias`.
  const weights = driven.map((i) => 1 / (Math.abs(wheels[i]!.omega) + 0.5));
  let minW = Infinity;
  let maxW = 0;
  for (const w of weights) {
    minW = Math.min(minW, w);
    maxW = Math.max(maxW, w);
  }
  const cap = Math.max(1, bias) * minW;
  let sum = 0;
  for (let k = 0; k < weights.length; k++) {
    weights[k] = Math.min(weights[k]!, cap);
    sum += weights[k]!;
  }
  if (!(maxW >= minW) || sum <= 0) {
    const share = totalTorque / driven.length;
    for (const i of driven) out[i] = share;
    return out;
  }
  for (let k = 0; k < driven.length; k++) out[driven[k]!] = totalTorque * (weights[k]! / sum);
  return out;
}

export interface AeroConfig {
  rho: number;
  dragCoefficient: number;
  /** Positive produces downforce (force along −up), not lift. */
  liftCoefficient: number;
  frontalArea: number;
}

export const ZERO_AERO: AeroConfig = { rho: 1.225, dragCoefficient: 0, liftCoefficient: 0, frontalArea: 0 };

/** `½ ρ v² A` times the coefficients. `speed` is the horizontal airspeed (m/s). */
export function aeroLoads(speed: number, aero: AeroConfig): { drag: number; downforce: number } {
  const q = 0.5 * aero.rho * speed * speed * aero.frontalArea;
  return { drag: q * aero.dragCoefficient, downforce: q * aero.liftCoefficient };
}

/**
 * Drive-torque scale in [0, 1]. `slip` is the peak |κ| of the driven wheels.
 * Below `threshold` the scale is 1; above it, strength pulls the scale down (1 = full cut per unit slip).
 */
export function tractionControlScale(slip: number, threshold: number, strength: number): number {
  const excess = Math.abs(slip) - threshold;
  if (excess <= 0 || strength <= 0) return 1;
  return clamp(1 - excess * strength, 0.05, 1);
}

/** Brake-torque scale in [0, 1]. Same shape as TC, applied to the brake when |κ| exceeds the ABS slip. */
export function absBrakeScale(slip: number, threshold: number, strength: number): number {
  const excess = Math.abs(slip) - threshold;
  if (excess <= 0 || strength <= 0) return 1;
  return clamp(1 - excess * strength, 0.08, 1);
}
