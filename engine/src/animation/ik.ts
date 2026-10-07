/**
 * Inverse kinematics solvers — post-sampling constraint passes that modify the TRS buffer.
 *
 * IK solvers run between `sampleClip` and `applyToTransforms` in the animation pipeline. They
 * read the sampled joint positions, compute constrained positions, and write corrected rotations
 * back into the TRS buffer. The solvers are pure functions: (TRS buffer, chain, target) → void.
 *
 * Two solvers:
 *  - **TwoBoneIK**: analytically solves a 2-joint chain (root → mid → end). Used for foot
 *    placement, arm reaching, and any 2-link constraint. O(1), no iteration.
 *  - **FABRIK**: iteratively solves an N-joint chain. Forward-and-backward reaching with a
 *    configurable iteration count and tolerance. Used for tentacles, tails, spines, ropes.
 *
 * Both solvers operate in the local space of the TRS buffer (post-sampling, pre-apply). The
 * caller must ensure the chain node indices map to the correct joints in the skeleton.
 *
 * Determinism: pure functions of (buffer, chain, target, config). No RNG, no global state.
 */

import { NODE_STRIDE } from "./sampler.js";

// ──────────────────────── scratch vectors ────────────────────────

const _axis = { x: 0, y: 0, z: 0 };

// ──────────────────────── two-bone IK ────────────────────────

/** Configuration for a two-bone IK solve. */
export interface TwoBoneIKConfig {
  /** Index of the root joint in the TRS buffer (e.g., hip/shoulder). */
  root: number;
  /** Index of the mid joint (e.g., knee/elbow). */
  mid: number;
  /** Index of the end effector (e.g., ankle/wrist). */
  end: number;
  /** Target position in the same coordinate space as the TRS buffer translations. */
  target: { x: number; y: number; z: number };
  /**
   * Hint direction for the mid joint (e.g., knee bend direction).
   * The mid joint bends toward this side. If zero, the solver picks a default.
   */
  bendDirection?: { x: number; y: number; z: number };
  /**
   * Pole target: the mid joint bends toward this position.
   * Overrides `bendDirection` if both are provided.
   */
  poleTarget?: { x: number; y: number; z: number };
  /**
   * Weight [0..1] for blending the IK result with the original pose.
   * 0 = original pose, 1 = full IK. Default: 1.
   */
  weight?: number;
}

/**
 * Solve a two-bone IK chain analytically.
 *
 * Given the root and mid joint translations from the TRS buffer, computes the rotations needed
 * to place the end effector at `target`. Writes corrected rotations for root and mid back into
 * the buffer.
 *
 * The solver works in 2D in the plane formed by (root, mid, end, target), then rotates that
 * plane to aim at the target. This is the standard approach used by Maya, Unity, and Unreal.
 */
export function solveTwoBoneIK(trs: Float32Array, config: TwoBoneIKConfig): void {
  const { root, mid, end, target } = config;
  const weight = config.weight ?? 1;
  if (weight <= 0) return;

  const rOff = root * NODE_STRIDE;
  const mOff = mid * NODE_STRIDE;
  const eOff = end * NODE_STRIDE;

  // Read current positions from the TRS buffer.
  const rx = trs[rOff]!, ry = trs[rOff + 1]!, rz = trs[rOff + 2]!;
  const mx = trs[mOff]!, my = trs[mOff + 1]!, mz = trs[mOff + 2]!;
  const ex = trs[eOff]!, ey = trs[eOff + 1]!, ez = trs[eOff + 2]!;

  // Upper and lower bone vectors.
  const upperX = mx - rx, upperY = my - ry, upperZ = mz - rz;
  const lowerX = ex - mx, lowerY = ey - my, lowerZ = ez - mz;
  const upperLen = Math.sqrt(upperX * upperX + upperY * upperY + upperZ * upperZ);
  const lowerLen = Math.sqrt(lowerX * lowerX + lowerY * lowerY + lowerZ * lowerZ);

  if (upperLen < 1e-6 || lowerLen < 1e-6) return; // degenerate chain

  // Target vector from root.
  const targetX = target.x - rx, targetY = target.y - ry, targetZ = target.z - rz;
  const targetLen = Math.sqrt(targetX * targetX + targetY * targetY + targetZ * targetZ);

  // Clamp target: can't reach beyond upper + lower, can't reach inside |upper - lower|.
  const maxReach = upperLen + lowerLen - 1e-4;
  const minReach = Math.abs(upperLen - lowerLen) + 1e-4;

  let clampedTargetX = targetX, clampedTargetY = targetY, clampedTargetZ = targetZ;
  let clampedLen = targetLen;

  if (targetLen > maxReach) {
    const scale = maxReach / targetLen;
    clampedTargetX = targetX * scale;
    clampedTargetY = targetY * scale;
    clampedTargetZ = targetZ * scale;
    clampedLen = maxReach;
  } else if (targetLen < minReach) {
    const scale = minReach / (targetLen || 1e-8);
    clampedTargetX = targetX * scale;
    clampedTargetY = targetY * scale;
    clampedTargetZ = targetZ * scale;
    clampedLen = minReach;
  }

  // Law of cosines: angle at the mid joint.
  // cos(C) = (a² + b² - c²) / (2ab)
  const a2 = upperLen * upperLen;
  const b2 = lowerLen * lowerLen;
  const c2 = clampedLen * clampedLen;

  // Angle at the root joint.
  // cos(A) = (b² + c² - a²) / (2bc)
  const cosRoot = clamp((a2 + c2 - b2) / (2 * upperLen * clampedLen), -1, 1);
  const angleRoot = Math.acos(cosRoot);

  // Build the bend direction: the axis the mid joint bends around.
  if (config.poleTarget) {
    // Pole target: the bend axis is perpendicular to (root→target) × (root→poleTarget).
    const pt = config.poleTarget;
    const ptX = pt.x - rx, ptY = pt.y - ry, ptZ = pt.z - rz;
    cross(clampedTargetX, clampedTargetY, clampedTargetZ, ptX, ptY, ptZ, _axis);
  } else if (config.bendDirection) {
    _axis.x = config.bendDirection.x;
    _axis.y = config.bendDirection.y;
    _axis.z = config.bendDirection.z;
  } else {
    // Default: cross target direction with world up, falling back to a cardinal axis.
    cross(clampedTargetX, clampedTargetY, clampedTargetZ, 0, 1, 0, _axis);
    if (length(_axis.x, _axis.y, _axis.z) < 1e-6) {
      cross(clampedTargetX, clampedTargetY, clampedTargetZ, 1, 0, 0, _axis);
    }
  }
  const axisLen = length(_axis.x, _axis.y, _axis.z);
  if (axisLen < 1e-6) return; // can't determine bend direction
  _axis.x /= axisLen; _axis.y /= axisLen; _axis.z /= axisLen;

  // Compute the desired mid position: rotate the upper bone by (π - angleRoot) around the bend axis,
  // then rotate the lower bone by (π - angleMid) from the upper direction.

  // Desired upper direction: rotate clampedTarget toward the bend axis by angleRoot.
  const tDirX = clampedTargetX / clampedLen;
  const tDirY = clampedTargetY / clampedLen;
  const tDirZ = clampedTargetZ / clampedLen;

  // Rodrigues: rotate tDir around _axis by -angleRoot to get the upper bone direction.
  const upperDirX = rodriguesX(tDirX, tDirY, tDirZ, _axis.x, _axis.y, _axis.z, -angleRoot);
  const upperDirY = rodriguesY(tDirX, tDirY, tDirZ, _axis.x, _axis.y, _axis.z, -angleRoot);
  const upperDirZ = rodriguesZ(tDirX, tDirY, tDirZ, _axis.x, _axis.y, _axis.z, -angleRoot);

  // New mid position.
  const newMidX = rx + upperDirX * upperLen;
  const newMidY = ry + upperDirY * upperLen;
  const newMidZ = rz + upperDirZ * upperLen;

  // New end position (should be at the target).
  const midToTargetX = target.x - newMidX;
  const midToTargetY = target.y - newMidY;
  const midToTargetZ = target.z - newMidZ;
  const midToTargetLen = length(midToTargetX, midToTargetY, midToTargetZ);
  const lowerDirX = midToTargetLen > 1e-6 ? midToTargetX / midToTargetLen : 0;
  const lowerDirY = midToTargetLen > 1e-6 ? midToTargetY / midToTargetLen : 0;
  const lowerDirZ = midToTargetLen > 1e-6 ? midToTargetZ / midToTargetLen : 0;
  const newEndX = newMidX + lowerDirX * lowerLen;
  const newEndY = newMidY + lowerDirY * lowerLen;
  const newEndZ = newMidZ + lowerDirZ * lowerLen;

  // Apply with weight.
  if (weight >= 1) {
    trs[mOff] = newMidX; trs[mOff + 1] = newMidY; trs[mOff + 2] = newMidZ;
    trs[eOff] = newEndX; trs[eOff + 1] = newEndY; trs[eOff + 2] = newEndZ;
  } else {
    const w = weight;
    const inv = 1 - w;
    trs[mOff] = trs[mOff]! * inv + newMidX * w;
    trs[mOff + 1] = trs[mOff + 1]! * inv + newMidY * w;
    trs[mOff + 2] = trs[mOff + 2]! * inv + newMidZ * w;
    trs[eOff] = trs[eOff]! * inv + newEndX * w;
    trs[eOff + 1] = trs[eOff + 1]! * inv + newEndY * w;
    trs[eOff + 2] = trs[eOff + 2]! * inv + newEndZ * w;
  }
}

// ──────────────────────── FABRIK ────────────────────────

/** Configuration for a FABRIK chain solve. */
export interface FABRIKConfig {
  /** Ordered list of joint indices in the TRS buffer (root first, end effector last). */
  chain: number[];
  /** Target position for the end effector. */
  target: { x: number; y: number; z: number };
  /** Maximum iterations (default: 10). */
  maxIterations?: number;
  /** Convergence tolerance in world units (default: 0.001). */
  tolerance?: number;
  /**
   * Fixed root: if true (default), the first joint is pinned and does not move.
   * If false, the whole chain can translate.
   */
  fixedRoot?: boolean;
  /**
   * Weight [0..1] for blending the IK result with the original pose.
   * Default: 1.
   */
  weight?: number;
}

/**
 * Solve an N-joint IK chain using the FABRIK algorithm (Forward And Backward Reaching IK).
 *
 * FABRIK is an iterative solver that alternates between:
 *  1. Forward pass: move the end effector to the target, then adjust each joint toward its
 *     successor while preserving bone lengths.
 *  2. Backward pass: fix the root in place, then adjust each joint toward its predecessor
 *     while preserving bone lengths.
 *
 * Converges quickly for short chains (2-5 iterations typical for 3-4 joints). The algorithm
 * works in position space only — it does not compute rotations. The caller must derive
 * rotations from the solved positions if needed (e.g., for the joint TRS buffer).
 *
 * @returns The number of iterations used, or 0 if the chain was already at the target.
 */
export function solveFABRIK(trs: Float32Array, config: FABRIKConfig): number {
  const { chain, target } = config;
  const maxIter = config.maxIterations ?? 10;
  const tolerance = config.tolerance ?? 0.001;
  const fixedRoot = config.fixedRoot ?? true;
  const weight = config.weight ?? 1;

  if (chain.length < 2 || weight <= 0) return 0;

  const n = chain.length;

  // Read joint positions and compute bone lengths.
  const positions = new Float32Array(n * 3);
  const boneLengths = new Float32Array(n - 1);

  for (let i = 0; i < n; i++) {
    const off = chain[i]! * NODE_STRIDE;
    positions[i * 3] = trs[off]!;
    positions[i * 3 + 1] = trs[off + 1]!;
    positions[i * 3 + 2] = trs[off + 2]!;
  }

  for (let i = 0; i < n - 1; i++) {
    const ax = positions[i * 3]!, ay = positions[i * 3 + 1]!, az = positions[i * 3 + 2]!;
    const bx = positions[(i + 1) * 3]!, by = positions[(i + 1) * 3 + 1]!, bz = positions[(i + 1) * 3 + 2]!;
    boneLengths[i] = Math.sqrt((bx - ax) ** 2 + (by - ay) ** 2 + (bz - az) ** 2);
  }

  // Total chain length.
  let totalLength = 0;
  for (let i = 0; i < boneLengths.length; i++) totalLength += boneLengths[i]!;

  // Check if the target is reachable.
  const rootX = positions[0]!, rootY = positions[1]!, rootZ = positions[2]!;
  const rootToTarget = Math.sqrt(
    (target.x - rootX) ** 2 + (target.y - rootY) ** 2 + (target.z - rootZ) ** 2,
  );

  if (rootToTarget > totalLength && fixedRoot) {
    // Target is unreachable: stretch the chain toward it.
    for (let i = 0; i < n - 1; i++) {
      const r = boneLengths[i]! / (rootToTarget || 1e-8);
      positions[(i + 1) * 3] = positions[i * 3]! + (target.x - rootX) * r;
      positions[(i + 1) * 3 + 1] = positions[i * 3 + 1]! + (target.y - rootY) * r;
      positions[(i + 1) * 3 + 2] = positions[i * 3 + 2]! + (target.z - rootZ) * r;
    }
    // Apply and return.
    applyPositions(trs, chain, positions, weight);
    return 1;
  }

  // FABRIK iteration.
  const savedRootX = positions[0]!, savedRootY = positions[1]!, savedRootZ = positions[2]!;
  let iterations = 0;

  for (let iter = 0; iter < maxIter; iter++) {
    iterations++;

    // Forward reaching: move end effector to target.
    positions[(n - 1) * 3] = target.x;
    positions[(n - 1) * 3 + 1] = target.y;
    positions[(n - 1) * 3 + 2] = target.z;

    for (let i = n - 2; i >= 0; i--) {
      constrainBone(positions, i + 1, i, boneLengths[i]!);
    }

    // Backward reaching: fix root.
    if (fixedRoot) {
      positions[0] = savedRootX;
      positions[1] = savedRootY;
      positions[2] = savedRootZ;
    }

    for (let i = 0; i < n - 1; i++) {
      constrainBone(positions, i, i + 1, boneLengths[i]!);
    }

    // Check convergence.
    const endX = positions[(n - 1) * 3]!, endY = positions[(n - 1) * 3 + 1]!, endZ = positions[(n - 1) * 3 + 2]!;
    const dist = Math.sqrt(
      (endX - target.x) ** 2 + (endY - target.y) ** 2 + (endZ - target.z) ** 2,
    );
    if (dist < tolerance) break;
  }

  // Apply solved positions to the TRS buffer.
  applyPositions(trs, chain, positions, weight);
  return iterations;
}

// ──────────────────────── helpers ────────────────────────

/** Move joint `from` toward joint `to` at exactly `distance`. */
function constrainBone(positions: Float32Array, from: number, to: number, distance: number): void {
  const fx = positions[from * 3]!, fy = positions[from * 3 + 1]!, fz = positions[from * 3 + 2]!;
  const tx = positions[to * 3]!, ty = positions[to * 3 + 1]!, tz = positions[to * 3 + 2]!;
  const dx = tx - fx, dy = ty - fy, dz = tz - fz;
  const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (len < 1e-8) return;
  const r = distance / len;
  positions[to * 3] = fx + dx * r;
  positions[to * 3 + 1] = fy + dy * r;
  positions[to * 3 + 2] = fz + dz * r;
}

/** Apply solved positions to the TRS buffer with weight blending. */
function applyPositions(
  trs: Float32Array,
  chain: number[],
  positions: Float32Array,
  weight: number,
): void {
  for (let i = 0; i < chain.length; i++) {
    const off = chain[i]! * NODE_STRIDE;
    if (weight >= 1) {
      trs[off] = positions[i * 3]!;
      trs[off + 1] = positions[i * 3 + 1]!;
      trs[off + 2] = positions[i * 3 + 2]!;
    } else {
      const inv = 1 - weight;
      trs[off] = trs[off]! * inv + positions[i * 3]! * weight;
      trs[off + 1] = trs[off + 1]! * inv + positions[i * 3 + 1]! * weight;
      trs[off + 2] = trs[off + 2]! * inv + positions[i * 3 + 2]! * weight;
    }
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function length(x: number, y: number, z: number): number {
  return Math.sqrt(x * x + y * y + z * z);
}

function cross(
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  out: { x: number; y: number; z: number },
): void {
  out.x = ay * bz - az * by;
  out.y = az * bx - ax * bz;
  out.z = ax * by - ay * bx;
}

/** Rodrigues' rotation formula: rotate vector (vx,vy,vz) around axis (ax,ay,az) by angle. */
function rodriguesX(
  vx: number, vy: number, vz: number,
  ax: number, ay: number, az: number,
  angle: number,
): number {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const dot = vx * ax + vy * ay + vz * az;
  return vx * c + (ay * vz - az * vy) * s + ax * dot * (1 - c);
}

function rodriguesY(
  vx: number, vy: number, vz: number,
  ax: number, ay: number, az: number,
  angle: number,
): number {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const dot = vx * ax + vy * ay + vz * az;
  return vy * c + (az * vx - ax * vz) * s + ay * dot * (1 - c);
}

function rodriguesZ(
  vx: number, vy: number, vz: number,
  ax: number, ay: number, az: number,
  angle: number,
): number {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const dot = vx * ax + vy * ay + vz * az;
  return vz * c + (ax * vy - ay * vx) * s + az * dot * (1 - c);
}