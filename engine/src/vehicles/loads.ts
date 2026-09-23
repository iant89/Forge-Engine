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
  return axle === "front" ? loads.fr + loads.fl : loads.rr + loads.rl;
}

export interface NWheelLoadInput {
  mass: number;
  /** Positive (m/s²). */
  gravity: number;
  /** CG height above the ground plane (m). */
  cgHeight: number;
  /** Longitudinal acceleration in the vehicle frame, +forward (m/s²). */
  ax: number;
  /** Lateral acceleration in the vehicle frame, +right (m/s²). */
  ay: number;
  /** Extra downward force (aero). */
  downforce?: number;
}

/**
 * Per-wheel static load share for layouts the four-wheel axle model does not cover (six-wheel
 * rocker rovers, and so on). Fits `wᵢ = a + b·zᵢ + c·xᵢ` through the wheel hardpoints exactly so
 * that Σw = weight, Σw·z = −m·aₓ·h (longitudinal transfer) and Σw·x = −m·a_y·h (lateral transfer),
 * then clamps at zero — a wheel cannot pull the chassis down. With three axles the middle axle
 * lands on the interpolation between front and rear, the usual quasi-static answer for a
 * statically indeterminate rocker layout. Falls back to an even split on a degenerate layout.
 */
export function distributeWheelLoads(
  wheels: readonly { x: number; z: number }[],
  input: NWheelLoadInput,
): number[] {
  const n = wheels.length;
  if (n === 0) return [];
  const weight = input.mass * input.gravity + (input.downforce ?? 0);
  let sz = 0, sx = 0, szz = 0, sxx = 0, sxz = 0;
  for (const w of wheels) {
    sz += w.z;
    sx += w.x;
    szz += w.z * w.z;
    sxx += w.x * w.x;
    sxz += w.x * w.z;
  }
  const mz = -(input.mass * input.ax * input.cgHeight);
  const mx = -(input.mass * input.ay * input.cgHeight);
  // 3×3 solve of the constraint system (Gaussian elimination, partial pivoting).
  const m = [
    [n, sz, sx, weight],
    [sz, szz, sxz, mz],
    [sx, sxz, sxx, mx],
  ];
  for (let col = 0; col < 3; col++) {
    let pivot = col;
    for (let r = col + 1; r < 3; r++) if (Math.abs(m[r]![col]!) > Math.abs(m[pivot]![col]!)) pivot = r;
    if (Math.abs(m[pivot]![col]!) < 1e-9) {
      const even = weight / n;
      return wheels.map(() => even);
    }
    [m[col]!, m[pivot]!] = [m[pivot]!, m[col]!];
    const inv = 1 / m[col]![col]!;
    for (let c = col; c < 4; c++) m[col]![c]! *= inv;
    for (let r = 0; r < 3; r++) {
      if (r === col) continue;
      const factor = m[r]![col]!;
      if (factor === 0) continue;
      for (let c = col; c < 4; c++) m[r]![c]! -= factor * m[col]![c]!;
    }
  }
  const a = m[0]![3]!, b = m[1]![3]!, c = m[2]![3]!;
  return wheels.map((w) => Math.max(0, a + b * w.z + c * w.x));
}
