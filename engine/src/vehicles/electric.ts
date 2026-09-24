/**
 * Electric drivetrain: a traction motor with an EV torque envelope, and the fixed-ratio reduction
 * that rover and EV drivetrains bolt behind it in place of a shifting gearbox.
 *
 * The envelope is the classical traction-motor curve: constant torque ({@link ElectricMotorOptions.peakTorque})
 * from stall to the base speed ({@link ElectricMotorOptions.ratedRpm}), constant power
 * ({@link ElectricMotorOptions.peakPower}) above it as the field weakens, then a linear taper to zero
 * across the last 15% of {@link ElectricMotorOptions.maxRpm} so the no-load speed is a real
 * asymptote rather than a wall. Torque is available from 0 rpm — there is no idle and no clutch —
 * so {@link ElectricMotor} reports `idleRpm = 0` and {@link ReductionDrive} never opens a shift:
 * {@link Vehicle}'s "hold idle / clutch open" paths simply never engage.
 *
 * Regeneration is a *request* the chassis folds in: {@link Vehicle} subtracts
 * `brake × regenTorque` from the motor torque it feeds the slip solve, blended out near a
 * standstill (real blends hand the last bit of braking to the friction pads, and a negative
 * demand at zero speed would creep the car backwards). The motor itself stays a pure torque
 * source: `deliveredTorque()` is never negative, `powerKW` goes negative while regenerating.
 *
 * Like the rest of `vehicles/`, these are pure state — unit-testable without a chassis.
 */

import { EngineModel, Transmission, type EngineModelOptions } from "./drivetrain.js";

export interface ElectricMotorOptions {
  /** Rotor (+ reflected reduction) inertia about the shaft (kg·m²). */
  inertia?: number;
  /** Stall / constant-torque-region torque (N·m). */
  peakTorque?: number;
  /** Mechanical power cap of the field-weakening region (W). */
  peakPower?: number;
  /** Base speed (rpm): constant torque up to here, constant power above. */
  ratedRpm?: number;
  /** No-load speed (rpm). Torque tapers to zero across the last 15% and is 0 at/above it. */
  maxRpm?: number;
  /** Coulomb drag torque opposing shaft rotation (N·m). */
  dragTorque?: number;
  /**
   * Maximum regenerative braking torque at the shaft (N·m). The chassis applies it against the
   * brake pedal (0..1), faded out below ~0.5 m/s. 0 disables regen.
   */
  regenTorque?: number;
}

/**
 * Electric traction motor. Drop-in for {@link EngineModel} (`VehicleConfig.engine`): same
 * `throttle` / `omega` / `rpm` surface, an EV envelope instead of an ICE curve, no idle.
 */
export class ElectricMotor extends EngineModel {
  readonly peakPower: number;
  readonly ratedRpm: number;
  readonly maxRpm: number;
  readonly regenTorque: number;
  readonly dragTorque: number;
  /** Torque the last `deliveredTorque` call returned (N·m), for the power readout. */
  private lastTorque = 0;

  constructor(options: ElectricMotorOptions = {}) {
    const peakTorque = options.peakTorque ?? 9.5;
    const maxRpm = options.maxRpm ?? 3800;
    super({
      inertia: options.inertia ?? 0.02,
      peakTorque,
      frictionTorque: 0,
      // EVs do not idle: the shaft rests at 0 rpm, and Vehicle's torque-converter idle-hold
      // only engages when idleRpm > 0.
      idleRpm: 0,
      redlineRpm: maxRpm,
    } satisfies EngineModelOptions);
    this.peakPower = options.peakPower ?? 1000;
    this.ratedRpm = options.ratedRpm ?? 1000;
    this.maxRpm = maxRpm;
    this.dragTorque = options.dragTorque ?? 0.1;
    this.regenTorque = options.regenTorque ?? 0;
  }

  /**
   * Torque the envelope allows at `rpm` (N·m), before throttle and drag. Constant
   * `peakTorque` up to `ratedRpm`, `peakPower / ω` above it (clamped by `peakTorque`, so an
   * oversized `peakPower` cannot step the curve at the base speed), tapering to 0 at `maxRpm`.
   */
  envelopeTorque(rpm: number = this.rpm): number {
    if (rpm >= this.maxRpm) return 0;
    const omega = Math.max(0, rpm) * (Math.PI / 30); // rpm → rad/s
    let base = this.peakTorque;
    if (rpm > this.ratedRpm && omega > 1e-9) base = Math.min(base, this.peakPower / omega);
    const taperStart = this.maxRpm * 0.85;
    if (rpm > taperStart) {
      const t = (rpm - taperStart) / (this.maxRpm - taperStart);
      return base * (1 - t);
    }
    return base;
  }

  /**
   * Torque at the shaft right now: `throttle × envelope − drag`, floored at 0 (a driven motor
   * never pushes backwards — regen rides in through the chassis, see the module doc). The base
   * class's rev limiter is inherited: `redlineRpm` is `maxRpm`.
   */
  override deliveredTorque(loadTorque = 0): number {
    void loadTorque;
    const drag = Math.abs(this.omega) > 0.5 ? this.dragTorque * Math.sign(this.omega) : 0;
    this.lastTorque = Math.max(0, this.throttle * this.envelopeTorque() - drag);
    return this.lastTorque;
  }

  /**
   * Shaft power of the last `deliveredTorque` evaluation (kW). Negative while regenerating
   * (torque subtracted by the chassis while the shaft still spins forward).
   */
  get powerKW(): number {
    return (this.lastTorque * this.omega) / 1000;
  }
}

/**
 * Single-speed reduction drive: a fixed motor→wheel ratio with no gears to hunt for, no clutch
 * and no shift events. `gear` stays 1 (−1 reverses the ratio, as with {@link Transmission}),
 * `ratio` is never 0, and `update()` never shifts (`shiftCount` stays 0).
 */
export class ReductionDrive extends Transmission {
  /** Motor-to-wheel reduction. `ratio` is exactly this, always engaged. */
  readonly reduction: number;

  constructor(ratio = 1) {
    super({
      ratios: [1],
      reverseRatio: 1,
      finalDrive: ratio,
      // No shift thresholds: upshift needs rpm ≥ ∞, downshift needs gear > 1. Both impossible.
      upshiftRpm: Number.POSITIVE_INFINITY,
      downshiftRpm: -1,
      shiftDuration: 0,
    });
    this.reduction = ratio;
  }
}
