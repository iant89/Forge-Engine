/**
 * Perseverance high-gain antenna (HGA) — automatic deployment and Earth tracking. Pure state (no
 * engine scene, DOM or GPU objects) so it runs, and is unit-tested, in Node. The Mars scene owns
 * one controller, arms it the moment the rover GLB lands, and writes `azimuth` / `elevation` onto
 * the two gimbal pivots of the procedural HGA assembly (the NASA model ships without an antenna).
 *
 * Behaviour, which is also the contract:
 *
 * - **One-way.** There is no stow: no API on this class re-enters `"stowed"`, and the scene wires
 *   no key or pad button to one. The dish unfurls {@link HGA_DEPLOY_SECONDS} after `arm()`, then
 *   tracks Earth for the life of the rover — "no way to lay it back down".
 * - **Automatic.** `update(dt, pose)` takes the chassis attitude and computes the gimbal angles
 *   that keep the boresight on {@link EARTH_DIRECTION} in *world* space, so driving, turning or
 *   pitching the rover is compensated every frame.
 * - **Mechanical.** The gimbals slew at a limited rate ({@link HGA_DEPLOY_RATE} while unfurling,
 *   {@link HGA_SLEW_RATE} while tracking) and the elevation axis is clamped to
 *   {@link HGA_MIN_ELEVATION}…{@link HGA_MAX_ELEVATION} so the dish never sweeps the deck nor
 *   passes through gimbal lock at zenith. A hard turn makes the dish lag, then catch up —
 *   never snap.
 *
 * Frames and signs (the vehicle convention, +Z nose / +Y up): `azimuth` is the yaw-pivot angle
 * about chassis +Y, 0 = dish facing the nose, positive = right; `elevation` is the pitch-pivot
 * angle, 0 = horizontal, positive = up. The stowed pose lies the dish flat on its yoke facing
 * aft (`azimuth = π`, `elevation = 0`).
 */

import { clamp, Quat, Vec3 } from "@forge/engine";

/** Seconds after `arm()` (the rover GLB landing) before the dish starts to unfurl. */
export const HGA_DEPLOY_DELAY_SECONDS = 5;
/** Minimum seconds for the unfurl slew; the dish also has to reach the Earth pose first. */
export const HGA_DEPLOY_SECONDS = 3;
/** Gimbal slew limit while unfurling (rad/s) — the slow, deliberate deploy motion. */
export const HGA_DEPLOY_RATE = (40 * Math.PI) / 180;
/** Gimbal slew limit while tracking (rad/s) — catches up with a hard turn inside ~2 s. */
export const HGA_SLEW_RATE = (70 * Math.PI) / 180;
/** Lowest tracking elevation (rad): keeps the dish off the rover's deck. */
export const HGA_MIN_ELEVATION = (12 * Math.PI) / 180;
/** Highest tracking elevation (rad): short of zenith so the azimuth axis keeps authority. */
export const HGA_MAX_ELEVATION = (85 * Math.PI) / 180;

/**
 * Earth's direction in world space (unit vector), kept a plausible elongation from the scene's
 * sun direction `(0.487, 0.730, 0.487)`: from Mars, Earth never strays more than ~47° from the
 * Sun; this one sits ~20° away, 38.6° above the horizon, azimuth 70.5° right of the spawn heading.
 */
export const EARTH_DIRECTION: Readonly<{ x: number; y: number; z: number }> = normalize({
  x: 0.85,
  y: 0.72,
  z: 0.3,
});

/** Stowed gimbal pose: dish lying flat on its yoke, facing aft. */
export const HGA_STOWED_AZIMUTH = Math.PI;
export const HGA_STOWED_ELEVATION = 0;

export type HgaPhase = "stowed" | "deploying" | "tracking";

/** Chassis attitude snapshot the caller reads off the vehicle each update. */
export interface HgaChassisPose {
  yaw: number;
  /** Positive = nose-up (the Vehicle convention). */
  pitch: number;
  /** Positive = right side up (the Vehicle convention). */
  roll: number;
}

function normalize(v: { x: number; y: number; z: number }): { x: number; y: number; z: number } {
  const len = Math.hypot(v.x, v.y, v.z) || 1;
  return { x: v.x / len, y: v.y / len, z: v.z / len };
}

/** Wrap an angle difference to (−π, π]. */
export function wrapPi(angle: number): number {
  const wrapped = ((angle + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
  return wrapped === -Math.PI ? Math.PI : wrapped;
}

const ANGULAR_EPS = 1e-5;
const AXIS_X = { x: 1, y: 0, z: 0 };
const AXIS_Z = { x: 0, y: 0, z: 1 };

/**
 * The chassis rotation as `Vehicle.writeRotation` builds it (yaw, then pitch about the yawed
 * right axis, then roll), so the gimbal math and the rendered rover cannot disagree.
 */
function chassisQuaternion(pose: HgaChassisPose, out: Quat, scratch: Quat): Quat {
  out.setEulerComponents(0, pose.yaw, 0);
  scratch.setAxisAngle(AXIS_X, -pose.pitch);
  out.multiply(scratch);
  scratch.setAxisAngle(AXIS_Z, pose.roll);
  out.multiply(scratch);
  return out;
}

/**
 * The dish boresight in world space for a gimbal pose — the inverse of the controller's target
 * solve, exported so tests can verify the loop end-to-end ("points at Earth") without a scene.
 */
export function gimbalBoresight(pose: HgaChassisPose, azimuth: number, elevation: number, out: Vec3): Vec3 {
  const ce = Math.cos(elevation);
  const local = { x: Math.sin(azimuth) * ce, y: Math.sin(elevation), z: Math.cos(azimuth) * ce };
  const q = chassisQuaternion(pose, new Quat(), new Quat());
  return q.rotateVector(local, out);
}

/**
 * HGA state machine: `stowed` → (armed, after the delay) → `deploying` → `tracking`, one-way.
 * `update` returns true whenever a gimbal angle changed, so the scene only rewrites the pivots
 * (and dirties matrices) on real motion.
 */
export class HighGainAntennaController {
  phase: HgaPhase = "stowed";
  /** Seconds until the unfurl starts (counts down once armed; 0 from then on). */
  countdown = HGA_DEPLOY_DELAY_SECONDS;
  /** Unfurl progress 0..1 — a clock, not a pose; the pose slews at the mechanical rate. */
  deployT = 0;
  azimuth = HGA_STOWED_AZIMUTH;
  elevation = HGA_STOWED_ELEVATION;
  /** Current Earth-pointing solution in gimbal space (what the slew chases). */
  targetAzimuth = HGA_STOWED_AZIMUTH;
  targetElevation = HGA_STOWED_ELEVATION;

  private armed = false;
  private readonly quat = new Quat();
  private readonly quatScratch = new Quat();
  private readonly local = new Vec3();

  /** Start the deployment countdown. Idempotent; called when the rover model lands. */
  arm(): void {
    if (this.phase !== "stowed" || this.armed) return;
    this.armed = true;
    this.countdown = HGA_DEPLOY_DELAY_SECONDS;
  }

  /** The dish is unfurled and locked on Earth. One-way: never true again after stow… there is no stow. */
  get deployed(): boolean {
    return this.phase === "tracking";
  }

  /**
   * Advance the antenna. `pose` is the chassis attitude this frame; Earth is re-solved in gimbal
   * space every call, so any rover motion is corrected. Returns true when a gimbal moved.
   */
  update(dt: number, pose: HgaChassisPose): boolean {
    if (!(dt > 0)) return false;
    if (this.phase === "stowed") {
      if (!this.armed) return false;
      this.countdown = Math.max(0, this.countdown - dt);
      if (this.countdown > 0) return false;
      this.phase = "deploying";
    }

    this.solveTarget(pose);

    if (this.phase === "deploying") {
      this.deployT = Math.min(1, this.deployT + dt / HGA_DEPLOY_SECONDS);
      const moving = this.slewToward(this.targetAzimuth, this.targetElevation, HGA_DEPLOY_RATE * dt);
      if (this.deployT >= 1 && !moving) this.phase = "tracking";
      return true;
    }

    // Tracking: keep chasing the (moving) Earth solution at the slew limit. Never re-stows.
    return this.slewToward(this.targetAzimuth, this.targetElevation, HGA_SLEW_RATE * dt);
  }

  /** Solve Earth's direction in chassis-local space into gimbal azimuth/elevation targets. */
  private solveTarget(pose: HgaChassisPose): void {
    const q = chassisQuaternion(pose, this.quat, this.quatScratch);
    q.rotateVectorInverse(EARTH_DIRECTION, this.local);
    const ly = clamp(this.local.y, -1, 1);
    this.targetElevation = clamp(Math.asin(ly), HGA_MIN_ELEVATION, HGA_MAX_ELEVATION);
    if (Math.abs(ly) < 0.999) {
      // Near zenith the azimuth is degenerate; hold the last solution instead of whipping round.
      this.targetAzimuth = Math.atan2(this.local.x, this.local.z);
    }
  }

  /** Move the gimbals up to `maxStep` (rad) toward the target, shortest arc. False = on target. */
  private slewToward(targetAzimuth: number, targetElevation: number, maxStep: number): boolean {
    const da = wrapPi(targetAzimuth - this.azimuth);
    const de = targetElevation - this.elevation;
    if (Math.abs(da) < ANGULAR_EPS && Math.abs(de) < ANGULAR_EPS) {
      this.azimuth = targetAzimuth;
      this.elevation = targetElevation;
      return false;
    }
    this.azimuth = wrapPi(this.azimuth + clamp(da, -maxStep, maxStep));
    this.elevation += clamp(de, -maxStep, maxStep);
    return true;
  }
}
