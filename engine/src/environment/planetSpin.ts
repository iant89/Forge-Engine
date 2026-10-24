/**
 * Planet spin: the drag / inertia / idle-resume behaviour of a globe viewer, as a pure state machine.
 *
 * It owns one {@link PlanetOrientation} (planet-fixed → world, see `planetFrame.ts`) and decides how
 * it changes:
 *
 *  - **drag** — the point of the planet under the pointer stays under the pointer: each pointer move
 *    rotates the planet by the shortest arc from the previously grabbed direction to the current
 *    one (an arcball on the real sphere, not a screen-space approximation, so it is exact near the
 *    limb and the poles). A pointer that leaves the disc is clamped to the silhouette by the caller;
 *  - **inertia** — on release the angular velocity measured over the last few moves carries on and
 *    decays exponentially (`inertiaHalfLifeSeconds`);
 *  - **idle auto-spin** — after `idleDelaySeconds` without any interaction the planet turns about its
 *    own pole at `autoSpinRadPerSecond`, eased in over `resumeRampSeconds` so it never lurches;
 *  - **animateTo** — a timed eased move to a target orientation (used to bring a double-tapped site
 *    under the camera); while it runs, input is ignored.
 *
 * It never touches the DOM or the renderer: the host converts pointer events to unit directions
 * with `pickPlanetDirection` and calls {@link beginDrag} / {@link dragTo} / {@link endDrag} /
 * {@link touch} / {@link update}. `onSpin` reports the real planetary rotation (the part that came from
 * auto-spin, in radians) so a clock can advance the planet's calendar consistently with the picture.
 */

import { Quat } from "../math/mat.js";
import { Vec3, type Vec3Ops } from "../math/vec.js";
import { quatFromUnitVectors, slerpQuat } from "./planetFrame.js";

export interface PlanetSpinOptions {
  /** Seconds without interaction before the planet resumes turning on its own. Default 4. */
  idleDelaySeconds?: number;
  /** Seconds the auto-spin takes to reach full speed. Default 1.5. */
  resumeRampSeconds?: number;
  /** Auto-spin speed about the planet's pole, radians per second (positive = eastward). Default 0.1. */
  autoSpinRadPerSecond?: number;
  /** Half-life of the release velocity, seconds. Default 0.9. */
  inertiaHalfLifeSeconds?: number;
  /** Velocities below this (rad/s) snap to rest. Default 0.002. */
  restRadPerSecond?: number;
  /** Largest angular speed inertia may carry, rad/s. Default 6. */
  maxRadPerSecond?: number;
}

export type PlanetSpinPhase = "auto" | "idle-wait" | "inertia" | "drag" | "animating";

const SMOOTH_TAU = 0.06;

export class PlanetSpinController {
  /** Planet-fixed → world rotation. Mutated in place; read it every frame. */
  readonly orientation = new Quat(0, 0, 0, 1);
  idleDelaySeconds: number;
  resumeRampSeconds: number;
  autoSpinRadPerSecond: number;
  inertiaHalfLifeSeconds: number;
  restRadPerSecond: number;
  maxRadPerSecond: number;
  /** When false the planet only moves by drag/inertia/animateTo. */
  autoSpinEnabled = true;
  /** Host callback: radians of true planetary rotation applied this update (auto-spin only). */
  onSpin: ((radians: number) => void) | null = null;

  private dragging = false;
  private readonly lastDir = new Vec3();
  private hasLastDir = false;
  private readonly velocity = new Vec3(); // world-frame angular velocity, rad/s
  private idle = 0;
  private sinceMove = 0;
  private anim: { from: Quat; to: Quat; t: number; duration: number } | null = null;
  private animDone: (() => void) | null = null;

  private readonly q = new Quat();
  private readonly pole = new Vec3();
  private readonly tmp = new Vec3();

  constructor(options: PlanetSpinOptions = {}) {
    this.idleDelaySeconds = options.idleDelaySeconds ?? 4;
    this.resumeRampSeconds = options.resumeRampSeconds ?? 1.5;
    this.autoSpinRadPerSecond = options.autoSpinRadPerSecond ?? 0.1;
    this.inertiaHalfLifeSeconds = options.inertiaHalfLifeSeconds ?? 0.9;
    this.restRadPerSecond = options.restRadPerSecond ?? 0.002;
    this.maxRadPerSecond = options.maxRadPerSecond ?? 6;
  }

  get isDragging(): boolean {
    return this.dragging;
  }

  get isAnimating(): boolean {
    return this.anim !== null;
  }

  /** Seconds since the last interaction (drag, wheel, button — anything that called {@link touch}). */
  get idleSeconds(): number {
    return this.idle;
  }

  /** Current angular speed of the inertia, rad/s. */
  get inertiaSpeed(): number {
    return this.velocity.length();
  }

  /** Auto-spin ease-in factor 0..1 right now. */
  get autoSpinBlend(): number {
    if (!this.autoSpinEnabled || this.dragging || this.anim) return 0;
    const t = (this.idle - this.idleDelaySeconds) / Math.max(1e-6, this.resumeRampSeconds);
    return t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t);
  }

  get phase(): PlanetSpinPhase {
    if (this.anim) return "animating";
    if (this.dragging) return "drag";
    if (this.velocity.length() > this.restRadPerSecond) return "inertia";
    return this.autoSpinBlend > 0 ? "auto" : "idle-wait";
  }

  /** Reset the idle timer without moving anything (zoom, a button press, a double-tap). */
  touch(): void {
    this.idle = 0;
  }

  setOrientation(q: Quat): void {
    this.orientation.copyFrom(q);
    this.velocity.set(0, 0, 0);
    this.anim = null;
    this.animDone = null;
  }

  /** Grab the planet at unit world direction `dir` (from the centre), or null when nothing is under the pointer. */
  beginDrag(dir: Vec3Ops | null): void {
    if (this.anim) return;
    this.dragging = true;
    this.idle = 0;
    this.sinceMove = 0;
    this.velocity.set(0, 0, 0);
    if (dir) {
      this.lastDir.set(dir.x, dir.y, dir.z);
      this.hasLastDir = true;
    } else {
      this.hasLastDir = false;
    }
  }

  /**
   * The pointer is now over unit world direction `dir`; turn the planet so the grabbed point follows
   * it. `dt` is the time since the previous move (for the inertia estimate).
   */
  dragTo(dir: Vec3Ops, dt: number): void {
    if (!this.dragging || this.anim) return;
    this.idle = 0;
    if (!this.hasLastDir) {
      this.lastDir.set(dir.x, dir.y, dir.z);
      this.hasLastDir = true;
      return;
    }
    const a = this.lastDir;
    const q = quatFromUnitVectors(a, dir, this.q);
    // q has w = cos(θ/2); recover axis/angle for the velocity estimate.
    const sinHalf = Math.hypot(q.x, q.y, q.z);
    const angle = 2 * Math.atan2(sinHalf, q.w);
    this.orientation.premultiply(q).normalize();
    if (sinHalf > 1e-9 && dt > 1e-4) {
      const speed = Math.min(this.maxRadPerSecond, angle / dt);
      const k = speed / sinHalf;
      // Low-pass so one jittery move does not decide the throw.
      const blend = 1 - Math.exp(-dt / SMOOTH_TAU);
      this.velocity.x += (q.x * k - this.velocity.x) * blend;
      this.velocity.y += (q.y * k - this.velocity.y) * blend;
      this.velocity.z += (q.z * k - this.velocity.z) * blend;
      this.sinceMove = 0;
    }
    this.lastDir.set(dir.x, dir.y, dir.z);
  }

  /** Release the planet; the measured velocity (if the pointer was still moving) becomes inertia. */
  endDrag(): void {
    if (!this.dragging) return;
    this.dragging = false;
    this.hasLastDir = false;
    this.idle = 0;
    // A pointer held still before release throws nothing.
    if (this.sinceMove > 0.09) this.velocity.set(0, 0, 0);
  }

  /** Cancel a drag without a throw (pointer cancel, a second finger arrived). */
  cancelDrag(): void {
    this.dragging = false;
    this.hasLastDir = false;
    this.velocity.set(0, 0, 0);
  }

  /** Ease to `target` over `seconds`; `done` fires once when it arrives. Ignores input meanwhile. */
  animateTo(target: Quat, seconds: number, done?: () => void): void {
    this.dragging = false;
    this.velocity.set(0, 0, 0);
    this.idle = 0;
    this.anim = { from: this.orientation.clone(), to: target.clone(), t: 0, duration: Math.max(1e-3, seconds) };
    this.animDone = done ?? null;
  }

  cancelAnimation(): void {
    this.anim = null;
    this.animDone = null;
  }

  update(dt: number): void {
    if (!(dt > 0)) return;
    if (this.anim) {
      const a = this.anim;
      a.t = Math.min(a.duration, a.t + dt);
      const u = a.t / a.duration;
      const eased = u * u * (3 - 2 * u);
      slerpQuat(a.from, a.to, eased, this.orientation);
      if (a.t >= a.duration) {
        this.anim = null;
        const done = this.animDone;
        this.animDone = null;
        done?.();
      }
      return;
    }
    if (this.dragging) {
      this.sinceMove += dt;
      return;
    }
    const speed = this.velocity.length();
    if (speed > this.restRadPerSecond) {
      this.rotateWorld(this.velocity.x / speed, this.velocity.y / speed, this.velocity.z / speed, speed * dt);
      const decay = Math.pow(0.5, dt / Math.max(1e-3, this.inertiaHalfLifeSeconds));
      this.velocity.scale(decay);
      this.idle = 0;
      return;
    }
    this.velocity.set(0, 0, 0);
    this.idle += dt;
    const blend = this.autoSpinBlend;
    if (blend > 0) {
      const angle = this.autoSpinRadPerSecond * blend * dt;
      // The pole (+Y planet-fixed) in the world; positive rotation about it is eastward.
      this.orientation.rotateVector(this.tmp.set(0, 1, 0), this.pole);
      this.rotateWorld(this.pole.x, this.pole.y, this.pole.z, angle);
      this.onSpin?.(angle);
    }
  }

  private rotateWorld(ax: number, ay: number, az: number, angle: number): void {
    const h = angle * 0.5;
    const s = Math.sin(h);
    this.q.set(ax * s, ay * s, az * s, Math.cos(h));
    this.orientation.premultiply(this.q).normalize();
  }
}
