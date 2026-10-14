/**
 * Wind sway (fe-33): a generic wind-response hook for any foliage — trees, palms, reeds, flags.
 *
 * The engine owns no plant models. A scene builds its own plant (any entity chain) and asks this
 * module how it should lean: {@link windBendAngle} maps wind speed to a quadratic-drag lean that
 * saturates at `maxBend`; {@link windBendWeights} spreads it along a chain (more toward the tip);
 * {@link windSway} adds per-plant gust rocking and a leaf flutter and returns the bend axis
 * (horizontal, ⟂ to the wind, so a rotation about it tips +Y downwind).
 *
 * Wind comes from anywhere: `cycloneWindAt`, `WeatherSystem.meanWind`, or a constant.
 */

import { clamp } from "../math/scalar.js";

export interface WindSwayParams {
  /** Lean (radians) the plant reaches in very strong wind. Default 1.05. */
  maxBend?: number;
  /** Wind (m/s) at which half of `maxBend` is reached. Default 45. */
  halfBendWind?: number;
  /** Natural rocking frequency (Hz) of this plant. Default 0.45. */
  frequency?: number;
  /** Per-plant phase (radians). Default 0. */
  phase?: number;
  /** Wind (m/s) treated as "full storm" for gust/flutter scaling. Default 60. */
  stormWind?: number;
}

export interface WindSwayPose {
  /** Total lean (radians), gusts included. */
  bend: number;
  /** Unit bend axis (horizontal). Rotate about it by `bend` to tip +Y downwind. */
  axisX: number;
  axisZ: number;
  /** Unit downwind direction (falls back to +X in still air). */
  downwindX: number;
  downwindZ: number;
  /** 0..1 storm strength (wind / stormWind). */
  strength: number;
  /** Leaf flutter angle (radians) for this time; scale per leaf with its own phase. */
  flutter: number;
}

/** Mean lean (radians) for a wind speed: quadratic drag, saturating at `maxBend`. */
export function windBendAngle(windSpeed: number, maxBend = 1.05, halfBendWind = 45): number {
  const v = Math.max(0, windSpeed);
  return (maxBend * v * v) / (v * v + halfBendWind * halfBendWind);
}

/** Fraction of the bend each of `segments` chain links takes (base → tip), summing to 1. */
export function windBendWeights(segments: number): number[] {
  const n = Math.max(1, Math.floor(segments));
  let sum = 0;
  const raw: number[] = [];
  for (let i = 0; i < n; i++) {
    raw.push((i + 1) * (i + 1));
    sum += (i + 1) * (i + 1);
  }
  return raw.map((w) => w / sum);
}

export function createWindSwayPose(): WindSwayPose {
  return { bend: 0, axisX: 0, axisZ: -1, downwindX: 1, downwindZ: 0, strength: 0, flutter: 0 };
}

/** Pose for a plant in wind `(windX, windZ)` m/s at time `t` seconds. */
export function windSway(windX: number, windZ: number, t: number, params: WindSwayParams = {}, out: WindSwayPose = createWindSwayPose()): WindSwayPose {
  const speed = Math.hypot(windX, windZ);
  const strength = clamp(speed / (params.stormWind ?? 60), 0, 1);
  const f = params.frequency ?? 0.45;
  const phase = params.phase ?? 0;
  const gust = Math.sin(t * f * (1 + strength) * Math.PI * 2 + phase) * (0.04 + 0.12 * strength) + Math.sin(t * 2.7 + phase * 1.7) * 0.03 * strength;
  out.bend = windBendAngle(speed, params.maxBend ?? 1.05, params.halfBendWind ?? 45) * (1 + gust);
  out.downwindX = speed > 1e-3 ? windX / speed : 1;
  out.downwindZ = speed > 1e-3 ? windZ / speed : 0;
  out.axisX = out.downwindZ;
  out.axisZ = -out.downwindX;
  out.strength = strength;
  out.flutter = Math.sin(t * (3 + strength * 9) + phase) * (0.05 + 0.3 * strength);
  return out;
}
