import {
  ARM_MIN_TURRET_HEIGHT,
  ARM_SHOULDER_ROVER_FORWARD,
  ARM_SHOULDER_ROVER_RIGHT,
  ARM_READY_DEG,
  solveArmPoseForPoint,
  turretJointPoint,
  type ArmJogInput,
} from "./roverArm.js";

export type RoverToolAction = "drill" | "abrade" | "analyze";

export interface RoverToolSpec {
  readonly action: RoverToolAction;
  readonly label: string;
  readonly displayName: string;
  /** Turret spin in degrees from the stowed GLB pose. */
  readonly turretDeg: number;
  /** Tool contact point relative to the turret pivot in turret-local (right, up, forward) axes. */
  readonly mountOffset: readonly [right: number, up: number, forward: number];
  readonly workSeconds: number;
}

/** Contact points are measured from the converted Perseverance turret mesh bounds. */
export const ROVER_TOOL_SPECS: Readonly<Record<RoverToolAction, RoverToolSpec>> = Object.freeze({
  drill: {
    action: "drill",
    label: "DRILL",
    displayName: "Coring drill",
    turretDeg: -90,
    mountOffset: [-0.03, -0.16, 0.26],
    workSeconds: 3.6,
  },
  abrade: {
    action: "abrade",
    label: "ABRADE",
    displayName: "Surface abrasion",
    turretDeg: 0,
    mountOffset: [0.25, -0.08, 0.03],
    workSeconds: 2.4,
  },
  analyze: {
    action: "analyze",
    label: "ANALYZE",
    displayName: "PIXL-style analysis",
    turretDeg: 90,
    mountOffset: [-0.29, -0.04, -0.05],
    workSeconds: 2.8,
  },
});

export interface RoverToolPoint {
  right: number;
  forward: number;
  height: number;
}

export interface RoverToolWorldPoint {
  x: number;
  y: number;
  z: number;
}

const DEG = Math.PI / 180;
const clamp = (value: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, value));
const planarScratch = { reach: 0, height: 0 };
const offsetScratch: RoverToolPoint = { right: 0, forward: 0, height: 0 };
const postScratch: RoverToolPoint = { right: 0, forward: 0, height: 0 };
const solvedPointScratch: RoverToolPoint = { right: 0, forward: 0, height: 0 };

/** Turret-mounted tool tip in rover-local coordinates for a given five-joint arm pose. */
export function roverToolPointFromPose(
  pose: ArrayLike<number>,
  tool: RoverToolAction | RoverToolSpec,
  out: RoverToolPoint = { right: 0, forward: 0, height: 0 },
): RoverToolPoint {
  const spec = typeof tool === "string" ? ROVER_TOOL_SPECS[tool] : tool;
  const post = turretJointPoint(pose, planarScratch);
  const azimuth = pose[0] ?? 0;
  const spin = pose[4] ?? 0;
  turretMountOffset(spec, azimuth, spin, offsetScratch);
  out.right = ARM_SHOULDER_ROVER_RIGHT - Math.cos(azimuth) * post.reach + offsetScratch.right;
  out.forward = ARM_SHOULDER_ROVER_FORWARD + Math.sin(azimuth) * post.reach + offsetScratch.forward;
  out.height = post.height + offsetScratch.height;
  return out;
}

/** Solve a safe arm pose whose selected turret tool tip reaches a rover-local point. */
export function solveArmPoseForToolPoint(
  target: Readonly<RoverToolPoint>,
  tool: RoverToolAction | RoverToolSpec,
  out: Float64Array,
): Float64Array | null {
  const spec = typeof tool === "string" ? ROVER_TOOL_SPECS[tool] : tool;
  let azimuth = Math.atan2(
    target.forward - ARM_SHOULDER_ROVER_FORWARD,
    -(target.right - ARM_SHOULDER_ROVER_RIGHT),
  );
  const spin = spec.turretDeg * DEG;
  for (let iteration = 0; iteration < 4; iteration++) {
    turretMountOffset(spec, azimuth, spin, offsetScratch);
    postScratch.right = target.right - offsetScratch.right;
    postScratch.forward = target.forward - offsetScratch.forward;
    postScratch.height = target.height - offsetScratch.height;
    const pose = solveArmPoseForPoint(postScratch.right, postScratch.forward, postScratch.height, spin, out);
    if (!pose) return null;
    if (Math.abs(pose[0]! - azimuth) < 1e-5) return pose;
    azimuth = pose[0]!;
  }
  // The final iterate has already solved the point using the previous azimuth. Reject a residual
  // larger than a millimetre rather than moving to a pose that could put the instrument off target.
  const solvedPoint = roverToolPointFromPose(out, spec, solvedPointScratch);
  return Math.hypot(solvedPoint.right - target.right, solvedPoint.forward - target.forward, solvedPoint.height - target.height) <= 0.01
    ? out
    : null;
}

/** Rotate a selected instrument's local mount offset through turret spin and arm azimuth. */
function turretMountOffset(spec: RoverToolSpec, azimuth: number, spin: number, out: RoverToolPoint): RoverToolPoint {
  const [localRight, localUp, localForward] = spec.mountOffset;
  const cosSpin = Math.cos(spin);
  const sinSpin = Math.sin(spin);
  const spunRight = cosSpin * localRight + sinSpin * localForward;
  const spunForward = -sinSpin * localRight + cosSpin * localForward;
  out.right = -Math.cos(azimuth) * spunRight + Math.sin(azimuth) * spunForward;
  out.forward = Math.sin(azimuth) * spunRight + Math.cos(azimuth) * spunForward;
  out.height = localUp;
  return out;
}

/** Transform rover-local tool point into world space using the vehicle's yaw-only chassis frame. */
export function roverToolWorldPoint(
  point: Readonly<RoverToolPoint>,
  rootX: number,
  rootY: number,
  rootZ: number,
  yaw: number,
  out: RoverToolWorldPoint = { x: 0, y: 0, z: 0 },
): RoverToolWorldPoint {
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  out.x = rootX + point.right * c + point.forward * s;
  out.y = rootY + point.height;
  out.z = rootZ - point.right * s + point.forward * c;
  return out;
}

/** Project a world-space target to rover-local right/forward axes. */
export function worldPointToRoverLocal(
  x: number,
  y: number,
  z: number,
  rootX: number,
  rootY: number,
  rootZ: number,
  yaw: number,
  out: RoverToolPoint = { right: 0, forward: 0, height: 0 },
): RoverToolPoint {
  const dx = x - rootX;
  const dz = z - rootZ;
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  out.right = dx * c - dz * s;
  out.forward = dx * s + dz * c;
  out.height = y - rootY;
  return out;
}

/** Convert arm joint error to smooth jog inputs, preserving the controller's joint-rate limits. */
export function roverToolServoInput(current: ArrayLike<number>, target: ArrayLike<number>, out: ArmJogInput): ArmJogInput {
  const maxRates = [30, 20, 30, 1, 60] as const;
  const command = (index: number, rate: number): number => clamp(((target[index] ?? 0) - (current[index] ?? 0)) * 3 / (rate * DEG), -1, 1);
  out.swing = command(0, maxRates[0]);
  out.shoulder = command(1, maxRates[1]);
  out.elbow = command(2, maxRates[2]);
  // Positive tool-controller turret input decreases joint spin in RoverArmController.
  out.turret = -command(4, maxRates[4]);
  return out;
}

export interface DrillSplitCandidate {
  readonly id: string;
  readonly radius: number;
  readonly isFlat: boolean;
  readonly thickness: number;
}

/** Deliberately rare: drilling only has an 8% split chance for a genuinely small or thin rock. */
export const DRILLED_ROCK_SPLIT_CHANCE = 0.08;

export function isEligibleDrillSplit(candidate: DrillSplitCandidate): boolean {
  return candidate.radius <= 0.32 || (candidate.isFlat && candidate.thickness <= 0.22);
}

/** Stable per-rock/per-attempt roll so replaying a save gives the same fracture result. */
export function shouldSplitRockDuringDrilling(candidate: DrillSplitCandidate, attempt = 0): boolean {
  if (!isEligibleDrillSplit(candidate)) return false;
  let hash = 2166136261;
  const key = `${candidate.id}:drill:${Math.max(0, Math.floor(attempt))}`;
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  const roll = (hash >>> 0) / 0x1_0000_0000;
  return roll < DRILLED_ROCK_SPLIT_CHANCE;
}

/** Build the tool-space point at a world-space location without letting the arm scrape the ground. */
export function canArmReachToolPoint(
  target: Readonly<RoverToolPoint>,
  tool: RoverToolAction,
  out: Float64Array,
): boolean {
  if (target.height < ARM_MIN_TURRET_HEIGHT - 0.25) return false;
  return solveArmPoseForToolPoint(target, tool, out) !== null;
}

/** Ready-pose joint angles, radians, for tools whose contact target has not been selected yet. */
export function roverToolReadyPose(out: Float64Array): Float64Array {
  for (let i = 0; i < ARM_READY_DEG.length; i++) out[i] = ARM_READY_DEG[i]! * DEG;
  return out;
}
