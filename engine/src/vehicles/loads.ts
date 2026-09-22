/**
 * Quasi-static axle loads.
 *
 * Longitudinal transfer is `m · a_x · h / L` (accel forward unloads the front axle) and lateral
 * transfer is `m · a_y · h / track` (accel to the right unloads the right wheels). The four wheel
 * loads sum to `m·g` plus any extra downforce, unless a wheel is clamped at zero (inside-wheel
 * lift). This is the number the tire model multiplies by μ — spring force holds the chassis up,
 * it is not the friction budget.
 */

export interface WheelLoadInput {
  mass: number;
  /** Positive (m/s²). */
  gravity: number;
  /** Front-axle to rear-axle distance (m). */
  wheelbase: number;
  /** CG to front axle (m). Centred when this is `wheelbase / 2`. */
  cgToFront: number;
  /** CG height above the ground plane (m). */
  cgHeight: number;
  /** Longitudinal acceleration in the vehicle frame, +forward (m/s²). */
  ax: number;
  /** Lateral acceleration in the vehicle frame, +right (m/s²). */
  ay: number;
  /** Track width (m). */
  track: number;
  /** Extra downward force (aero), split evenly before transfer. */
  downforce?: number;
}

export interface WheelLoads {
  /** Front-left, front-right, rear-left, rear-right. Newtons, ≥ 0. */
  fl: number;
  fr: number;
  rl: number;
  rr: number;
}

export function computeWheelLoads(input: WheelLoadInput): WheelLoads {
  const L = Math.max(1e-3, input.wheelbase);
  const track = Math.max(1e-3, input.track);
  const weight = input.mass * input.gravity + (input.downforce ?? 0);
  const cgToRear = L - input.cgToFront;
  let front = weight * (cgToRear / L);
  let rear = weight * (input.cgToFront / L);
  const longDelta = (input.mass * input.ax * input.cgHeight) / L;
  front -= longDelta;
  rear += longDelta;
  const latDelta = (input.mass * input.ay * input.cgHeight) / track;
  // +ay (accel to the right) loads the left wheels.
  let fl = front / 2 + latDelta / 2;
  let fr = front / 2 - latDelta / 2;
  let rl = rear / 2 + latDelta / 2;
  let rr = rear / 2 - latDelta / 2;
  fl = Math.max(0, fl);
  fr = Math.max(0, fr);
  rl = Math.max(0, rl);
  rr = Math.max(0, rr);
  return { fl, fr, rl, rr };
}

export function axleLoad(loads: WheelLoads, axle: "front" | "rear"): number {
  return axle === "front" ? loads.fl + loads.fr : loads.rl + loads.rr;
}
