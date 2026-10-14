/**
 * Waterspouts (fe-34): the simulation of tornadic vortices over water — spawning, wander, life
 * cycle and funnel shape — with no rendering (see `WaterspoutVisual` in `particles/` for the
 * funnel meshes and the spray ring).
 *
 * Spawning is a seeded Poisson process: the host supplies the rate (spouts per second) every
 * frame, typically {@link waterspoutSpawnRate} of the wind and a scripted time window, so a seeded
 * run spawns the same spouts at the same places. Each spout drifts with the steering wind plus a
 * slow seeded wander, and runs a life cycle: it *forms* (a thin rope lowering from cloud base and
 * the spray ring spinning up), *matures* (full width, strongest spray), then *decays* (ropes out,
 * narrows and lifts off the sea). {@link waterspoutFunnelAt} is the funnel centre-line and radius at
 * a height fraction, the shape both the visual and the tests read.
 */

import { SceneObject } from "../scene/scene.js";
import type { SystemContext } from "../scene/systems.js";
import { clamp } from "../math/scalar.js";
import { Rng } from "../math/rng.js";

export interface Waterspout {
  id: number;
  /** Base position on the sea (render-local XZ). */
  x: number;
  z: number;
  /** Seconds since it formed / total life. */
  age: number;
  life: number;
  /** Funnel radius at the sea (m) at maturity, and at cloud base. */
  baseRadius: number;
  topRadius: number;
  /** Rotation rate (rad/s, sign = sense of rotation). */
  spin: number;
  /** Accumulated rotation angle (rad) — the visual twists by it. */
  angle: number;
  /** Seed of its wander/shape noise. */
  seed: number;
}

/** 0..1 strength over a spout's life: forms (first 20 %), matures, decays (last 30 %). */
export function waterspoutStrength(age: number, life: number): number {
  if (life <= 0 || age < 0 || age >= life) return 0;
  const u = age / life;
  if (u < 0.2) {
    const t = u / 0.2;
    return t * t * (3 - 2 * t);
  }
  if (u > 0.7) {
    const t = (1 - u) / 0.3;
    return t * t * (3 - 2 * t);
  }
  return 1;
}

/**
 * Spawn rate (spouts per second) for a wind speed: zero below `threshold`, rising linearly to
 * `perSecond` at `full` m/s and capped there (waterspouts need instability and shear, not a
 * hurricane core — hosts usually also gate by a time window or by distance to the storm).
 */
export function waterspoutSpawnRate(windSpeed: number, options: { threshold?: number; full?: number; perSecond?: number } = {}): number {
  const threshold = options.threshold ?? 12;
  const full = Math.max(threshold + 1e-3, options.full ?? 30);
  const per = options.perSecond ?? 0.02;
  return per * clamp((windSpeed - threshold) / (full - threshold), 0, 1);
}

function hashNoise(t: number, seed: number): number {
  const i = Math.floor(t);
  const f = t - i;
  const h = (k: number): number => {
    const v = Math.sin(k * 12.9898 + seed * 78.233) * 43758.5453;
    return v - Math.floor(v);
  };
  const u = f * f * (3 - 2 * f);
  return (h(i) * (1 - u) + h(i + 1) * u) * 2 - 1;
}

export interface WaterspoutFunnelSample {
  /** Centre-line offset from the base (m), at this height. */
  dx: number;
  dz: number;
  /** Funnel radius (m) at this height. */
  radius: number;
  /** 0..1 how condensed/opaque the funnel is here (the decaying rope lifts off the sea first). */
  opacity: number;
}

/**
 * The funnel at height fraction `h` (0 = sea, 1 = cloud base) for a spout, its current strength
 * and a time `t`: a narrow rope at the sea widening to a cone under the cloud, the centre-line
 * snaking (more as it decays — "roping out") and the lowest part fading as it forms/decays.
 */
export function waterspoutFunnelAt(spout: Waterspout, h: number, t: number, out: WaterspoutFunnelSample = { dx: 0, dz: 0, radius: 0, opacity: 0 }): WaterspoutFunnelSample {
  const s = waterspoutStrength(spout.age, spout.life);
  const u = spout.life > 0 ? spout.age / spout.life : 1;
  const hh = clamp(h, 0, 1);
  const width = 0.35 + 0.65 * s;
  out.radius = (spout.baseRadius + (spout.topRadius - spout.baseRadius) * Math.pow(hh, 2.2)) * width;
  const rope = 1 + 2.5 * clamp((u - 0.6) / 0.4, 0, 1);
  const amp = (6 + 10 * hh) * rope * Math.sin(Math.PI * hh);
  out.dx = hashNoise(hh * 2.2 + t * 0.15, spout.seed) * amp;
  out.dz = hashNoise(hh * 2.2 + t * 0.15 + 17.3, spout.seed + 3) * amp;
  // Condensation reaches down to `reach` (forms top-down, lifts off bottom-up when decaying).
  const reach = u < 0.2 ? 1 - s : u > 0.7 ? 1 - s * 0.9 : 0;
  out.opacity = clamp((hh - reach) / 0.12 + 0.0, 0, 1) * (0.4 + 0.6 * s);
  return out;
}

export interface WaterspoutSystemOptions {
  name?: string;
  seed?: number;
  /** Spawn rate now (spouts/s). The host scripts the wind dependence and the time window. */
  spawnRate: () => number;
  /** Where spouts may form: a disc (render-local XZ, metres). */
  area: () => { x: number; z: number; radius: number };
  /** Steering wind the spouts drift with (m/s). */
  wind: () => { x: number; z: number };
  /** Fraction of the steering wind they move at. Default 0.35. */
  drift?: number;
  /** Life range (s). Default 25..45. */
  lifeMin?: number;
  lifeMax?: number;
  /** Most spouts alive at once. Default 2. */
  maxActive?: number;
  /** Funnel radius at sea / at cloud base (m). Defaults 9 / 70. */
  baseRadius?: number;
  topRadius?: number;
  /** Rotation sense: 1 cyclonic (counter-clockwise from above, northern hemisphere), −1 anticyclonic. Default 1. */
  hemisphere?: number;
}

export class WaterspoutSystem extends SceneObject {
  readonly name: string;
  readonly options: WaterspoutSystemOptions;
  readonly spouts: Waterspout[] = [];
  /** Spouts spawned since creation. */
  spawned = 0;
  /** Simulated seconds (the wander clock). */
  time = 0;
  /** Freeze ages (screenshots). */
  paused = false;
  private readonly rng: Rng;
  private nextId = 1;
  private untilNext: number;

  constructor(options: WaterspoutSystemOptions) {
    super();
    this.name = options.name ?? "waterspouts";
    this.options = options;
    this.rng = new Rng((options.seed ?? 4242) >>> 0 || 1);
    this.untilNext = this.exp();
  }

  /** Unit-mean exponential draw (the next spawn happens when the integrated rate passes it). */
  private exp(): number {
    return -Math.log(1 - this.rng.nextFloat());
  }

  /** Force a spout now (debug hook / scripted beat); `at` defaults to a seeded point in the area. */
  spawn(at?: { x: number; z: number }, life?: number): Waterspout {
    const o = this.options;
    const area = o.area();
    const a = this.rng.nextFloat() * Math.PI * 2;
    const r = Math.sqrt(this.rng.nextFloat()) * area.radius;
    const lifeMin = o.lifeMin ?? 25;
    const lifeMax = o.lifeMax ?? 45;
    const spout: Waterspout = {
      id: this.nextId++,
      x: at?.x ?? area.x + Math.cos(a) * r,
      z: at?.z ?? area.z + Math.sin(a) * r,
      age: 0,
      life: life ?? lifeMin + (lifeMax - lifeMin) * this.rng.nextFloat(),
      baseRadius: (o.baseRadius ?? 9) * (0.7 + 0.6 * this.rng.nextFloat()),
      topRadius: (o.topRadius ?? 70) * (0.8 + 0.4 * this.rng.nextFloat()),
      spin: (o.hemisphere ?? 1) * (1.6 + 1.2 * this.rng.nextFloat()),
      angle: 0,
      seed: this.rng.nextU32() % 10007,
    };
    if (this.spouts.length >= (o.maxActive ?? 2)) this.spouts.shift();
    this.spouts.push(spout);
    this.spawned++;
    return spout;
  }

  override update(context: SystemContext): void {
    const dt = context.fixedSteps * context.fixedDt;
    if (dt > 0) this.advance(dt);
  }

  /** Advance spawning, drift/wander and ages by `seconds`. */
  advance(seconds: number): void {
    if (!(seconds > 0) || this.paused) return;
    const o = this.options;
    this.time += seconds;
    const rate = Math.max(0, o.spawnRate());
    if (rate > 0) {
      this.untilNext -= rate * seconds;
      if (this.untilNext <= 0) {
        if (this.spouts.length < (o.maxActive ?? 2)) this.spawn();
        this.untilNext = this.exp();
      }
    }
    const w = o.wind();
    const k = o.drift ?? 0.35;
    for (let i = this.spouts.length - 1; i >= 0; i--) {
      const s = this.spouts[i]!;
      s.age += seconds;
      if (s.age >= s.life) {
        this.spouts.splice(i, 1);
        continue;
      }
      // Drift with the steering wind plus a slow seeded wander (a few m/s).
      s.x += (w.x * k + hashNoise(this.time * 0.07, s.seed + 40) * 4) * seconds;
      s.z += (w.z * k + hashNoise(this.time * 0.07, s.seed + 90) * 4) * seconds;
      s.angle += s.spin * seconds * (0.4 + 0.6 * waterspoutStrength(s.age, s.life));
    }
  }

  override stats(): Record<string, number | string | boolean> {
    return { active: this.spouts.length, spawned: this.spawned };
  }
}
