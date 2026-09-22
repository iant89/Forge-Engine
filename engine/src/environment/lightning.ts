/**
 * Lightning (Phase 8b): scheduled strikes, fractal bolts, and the flash that lights the scene.
 *
 * Strikes are a Poisson process in simulated time: the rate scales with the storm intensity (read
 * from the `WeatherSystem` named "weather" when one is attached, else the system's own
 * `stormOverride`), and every strike's position, energy and bolt shape comes from a seeded `Rng`
 * stream, so a seeded run reproduces its thunder to the arc. Each strike owns a bolt — a
 * midpoint-displaced polyline from cloud to ground — drawn as debug lines while the flash lives,
 * a point light whose intensity is the flash envelope, and a one-frame sky exposure boost pushed
 * through `RenderFrameContext.setSkyOverride`, so the clouds themselves flash.
 *
 * The envelope is a double stroke: a fast attack (`attack`, default 8 ms) and exponential decay
 * (`decay`, default 90 ms), plus an optional return stroke at `restrikeDelay` with
 * `restrikeStrength` of the energy. Nothing here touches the audio graph; thunder is a Phase 9+
 * concern (the strike's time/position/energy are all a sound system needs).
 */

import { SceneObject, type Scene } from "../scene/scene.js";
import type { SystemContext } from "../scene/systems.js";
import { Light } from "../scene/components/index.js";
import { Vec3 } from "../math/vec.js";
import { clamp } from "../math/scalar.js";
import { Rng, hash1i } from "../math/rng.js";
import { WeatherSystem } from "./weather.js";

export interface LightningBolt {
  /** Polyline from the cloud (`points[0]`) to the ground (last point). */
  points: Vec3[];
  /** RNG seed this bolt was grown from (re-grows identically). */
  seed: number;
}

export interface LightningStrike {
  id: number;
  /** Ground position of the strike (render-local XZ, `groundY` height). */
  position: Vec3;
  /** Energy 0.5..1.5 (scales the light and the sky flash). */
  energy: number;
  /** Simulated seconds since the strike started. */
  age: number;
  /** Seconds the flash (and bolt) lives. */
  duration: number;
  bolt: LightningBolt;
}

export interface FlashEnvelope {
  /** Attack time constant (seconds). */
  attack: number;
  /** Decay time constant (seconds). */
  decay: number;
  /** Delay of the return stroke (0 disables the second stroke). */
  restrikeDelay: number;
  /** Energy fraction of the return stroke. */
  restrikeStrength: number;
}

export const DEFAULT_FLASH_ENVELOPE: Readonly<FlashEnvelope> = Object.freeze({ attack: 0.008, decay: 0.09, restrikeDelay: 0.12, restrikeStrength: 0.45 });

/**
 * Flash brightness 0..~1 at `t` seconds after the strike: `(1 − e^(−t/a))·e^(−t/d)` plus the
 * return stroke. Zero at t = 0, peaks within a few attack constants, and is below 1 % after
 * `durationFor` (which the scheduler uses as the strike's lifetime).
 */
export function flashEnvelope(t: number, envelope: FlashEnvelope = DEFAULT_FLASH_ENVELOPE): number {
  if (!(t >= 0)) return 0;
  const main = (1 - Math.exp(-t / Math.max(1e-6, envelope.attack))) * Math.exp(-t / Math.max(1e-6, envelope.decay));
  if (!(envelope.restrikeDelay > 0) || t < envelope.restrikeDelay) return main;
  const tr = t - envelope.restrikeDelay;
  return main + envelope.restrikeStrength * (1 - Math.exp(-tr / Math.max(1e-6, envelope.attack))) * Math.exp(-tr / Math.max(1e-6, envelope.decay));
}

/** Seconds until the envelope (and the strike) has faded below 1 % of its energy. */
export function flashDuration(envelope: FlashEnvelope = DEFAULT_FLASH_ENVELOPE): number {
  const tail = envelope.restrikeDelay > 0 ? envelope.restrikeDelay : 0;
  return tail + envelope.decay * Math.log(100 * (1 + envelope.restrikeStrength));
}

/**
 * Grow a bolt from `start` (cloud) to `end` (ground) by midpoint displacement: `subdivisions`
 * bisections give `2^subdivisions + 1` points, and each midpoint is pushed off the segment by up
 * to `roughness` × the segment length along a deterministic perpendicular. `roughness = 0` is a
 * straight line. Pure function of its inputs — no stream state, so the order strikes are drawn in
 * cannot change a bolt.
 */
export function generateBoltPoints(start: Vec3, end: Vec3, seed: number, subdivisions: number, roughness: number, out: Vec3[] = []): Vec3[] {
  out.length = 0;
  out.push(start.clone(), end.clone());
  const sub = Math.max(0, Math.min(8, Math.floor(subdivisions)));
  for (let level = 0; level < sub; level++) {
    const step = out.length - 1;
    for (let i = step; i >= 1; i--) {
      const a = out[i - 1]!;
      const b = out[i]!;
      const mid = new Vec3((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
      if (roughness > 0) {
        const segLen = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
        // Two perpendiculars of the segment; the hash picks the offset in that plane.
        const dx = (b.x - a.x) / (segLen || 1);
        const dy = (b.y - a.y) / (segLen || 1);
        const dz = (b.z - a.z) / (segLen || 1);
        // `up` is never parallel to a cloud-to-ground bolt, so this basis is never degenerate.
        const ux = 0;
        const uy = 1;
        const uz = 0;
        let px = dy * uz - dz * uy;
        let py = dz * ux - dx * uz;
        let pz = dx * uy - dy * ux;
        const pl = Math.hypot(px, py, pz) || 1;
        px /= pl;
        py /= pl;
        pz /= pl;
        const qx = dy * pz - dz * py;
        const qy = dz * px - dx * pz;
        const qz = dx * py - dy * px;
        const h1 = (hash1i((seed ^ (i * 0x9e3779b9 + level * 0x85ebca6b)) | 0, 0xc0ffee) / 4294967296 - 0.5) * 2;
        const h2 = (hash1i((seed ^ (i * 0x27d4eb2f + level * 0x165667b1)) | 0, 0x5bd1e995) / 4294967296 - 0.5) * 2;
        const amp = roughness * segLen * 0.5;
        mid.x += (px * h1 + qx * h2) * amp;
        mid.y += (py * h1 + qy * h2) * amp;
        mid.z += (pz * h1 + qz * h2) * amp;
      }
      out.splice(i, 0, mid);
    }
  }
  return out;
}

export interface LightningOptions {
  name?: string;
  /** Deterministic seed for strike scheduling and bolt shapes. Default 9001. */
  seed?: number;
  /** Strikes per second at full storm. Default 0.25 (one strike every 4 s in a storm). */
  rate?: number;
  /** Storm intensity when no `WeatherSystem` is attached. Default 0 (silent). */
  stormOverride?: number;
  /** Name of the weather system to read the storm from. Default "weather". */
  weatherName?: string;
  /** Strikes land in a disc of this radius around the origin. Default 400. */
  areaRadius?: number;
  /** Bolt start height (cloud base). Default 1200. */
  cloudHeight?: number;
  /** Ground height the bolts end at. Default 0. */
  groundY?: number;
  /** Bolt detail (2^subdivisions + 1 points). Default 5 (33 points). */
  subdivisions?: number;
  /** Bolt jaggedness 0..1. Default 0.35. */
  roughness?: number;
  /** Point-light intensity at flash = 1, energy = 1. Default 60. */
  flashLightIntensity?: number;
  /** Sky exposure added at flash = 1, energy = 1. Default 0.8. */
  skyFlashExposure?: number;
  envelope?: Partial<FlashEnvelope>;
}

export class LightningSystem extends SceneObject {
  readonly name: string;
  readonly seed: number;
  rate: number;
  stormOverride: number;
  readonly weatherName: string;
  areaRadius: number;
  cloudHeight: number;
  groundY: number;
  subdivisions: number;
  roughness: number;
  flashLightIntensity: number;
  skyFlashExposure: number;
  readonly envelope: FlashEnvelope;

  /** Live strikes (oldest first). */
  readonly strikes: LightningStrike[] = [];
  /** Total strikes since creation. */
  strikeCount = 0;
  /** Sum of energy × envelope over the live strikes (what the light and sky flash follow). */
  flashTotal = 0;

  private readonly rng: Rng;
  private nextStrikeIn = 0;
  private nextId = 1;
  private light: Light | null = null;
  private lightEntityId = 0;
  private readonly scratchPos = new Vec3();
  /** Last frame's bolt polylines (for tests that cannot read debug lines back). */
  readonly lastBolts: Vec3[][] = [];

  constructor(options: LightningOptions = {}) {
    super();
    this.name = options.name ?? "lightning";
    this.seed = options.seed ?? 9001;
    this.rate = options.rate ?? 0.25;
    this.stormOverride = options.stormOverride ?? 0;
    this.weatherName = options.weatherName ?? "weather";
    this.areaRadius = options.areaRadius ?? 400;
    this.cloudHeight = options.cloudHeight ?? 1200;
    this.groundY = options.groundY ?? 0;
    this.subdivisions = options.subdivisions ?? 5;
    this.roughness = options.roughness ?? 0.35;
    this.flashLightIntensity = options.flashLightIntensity ?? 60;
    this.skyFlashExposure = options.skyFlashExposure ?? 0.8;
    this.envelope = { ...DEFAULT_FLASH_ENVELOPE, ...options.envelope };
    this.rng = new Rng(this.seed === 0 ? 0x9e3779b9 : this.seed);
    this.nextStrikeIn = this.drawInterarrival(1);
  }

  /** Current storm intensity: the weather system's, or the override when absent. */
  stormIntensity(): number {
    const weather = this.scene?.object<WeatherSystem>(this.weatherName);
    if (weather) return clamp(weather.state.storm01, 0, 1);
    return clamp(this.stormOverride, 0, 1);
  }

  /** Schedule a strike now (the demo's thunder key and the browser gate use this). */
  trigger(position?: Vec3, energy = 1): LightningStrike {
    const scene = this.scene;
    const px = position?.x ?? (this.rng.nextFloat() * 2 - 1) * this.areaRadius;
    const pz = position?.z ?? (this.rng.nextFloat() * 2 - 1) * this.areaRadius;
    void scene;
    const boltSeed = this.rng.nextU32();
    const start = new Vec3(px, this.cloudHeight, pz);
    const end = new Vec3(px, this.groundY, pz);
    const strike: LightningStrike = {
      id: this.nextId++,
      position: end.clone(),
      energy: clamp(energy, 0.1, 3),
      age: 0,
      duration: flashDuration(this.envelope),
      bolt: { points: generateBoltPoints(start, end, boltSeed, this.subdivisions, this.roughness), seed: boltSeed },
    };
    this.strikes.push(strike);
    this.strikeCount++;
    return strike;
  }

  override onAttach(scene: Scene): void {
    const entity = scene.createTransformedEntity(`${this.name}.flash`, new Vec3(0, this.cloudHeight / 2, 0));
    const light = new Light();
    light.kind = "point";
    light.range = Math.max(500, this.areaRadius * 3);
    light.intensity = 0;
    light.setColor(0.75, 0.85, 1);
    scene.world.addComponent(entity.id, light);
    this.light = light;
    this.lightEntityId = entity.id as number;
  }

  override onDetach(scene: Scene): void {
    if (this.lightEntityId !== 0) {
      const facade = scene.world.facade(this.lightEntityId as never);
      if (facade) scene.world.destroyEntity(facade.id);
      this.light = null;
      this.lightEntityId = 0;
    }
    this.strikes.length = 0;
  }

  override update(context: SystemContext): void {
    const dt = context.fixedSteps * context.fixedDt;
    if (dt > 0) this.advance(dt);
    this.present(context);
  }

  /** Advance scheduling and strike ages (seconds of simulated time). */
  advance(seconds: number): void {
    if (!(seconds > 0) || !Number.isFinite(seconds)) return;
    const storm = this.stormIntensity();
    if (storm > 0 && this.rate > 0) {
      this.nextStrikeIn -= seconds;
      let guard = 0;
      while (this.nextStrikeIn <= 0 && guard++ < 64) {
        // Position and energy from the stream (in this order — the determinism test replays it).
        const angle = this.rng.nextFloat() * Math.PI * 2;
        const radius = Math.sqrt(this.rng.nextFloat()) * this.areaRadius;
        const energy = 0.5 + this.rng.nextFloat();
        this.trigger(new Vec3(Math.cos(angle) * radius, this.groundY, Math.sin(angle) * radius), energy);
        this.nextStrikeIn += this.drawInterarrival(storm);
      }
    }
    for (let i = this.strikes.length - 1; i >= 0; i--) {
      const s = this.strikes[i]!;
      s.age += seconds;
      if (s.age >= s.duration) this.strikes.splice(i, 1);
    }
    this.flashTotal = 0;
    for (const s of this.strikes) this.flashTotal += s.energy * flashEnvelope(s.age, this.envelope);
  }

  /** Drive the light, the sky flash and the bolt lines for the current state. */
  present(context: SystemContext): void {
    if (this.light) {
      // The light sits at the brightest live strike (or goes dark when the sky is quiet).
      let best: LightningStrike | null = null;
      let bestFlash = 0;
      for (const s of this.strikes) {
        const f = s.energy * flashEnvelope(s.age, this.envelope);
        if (f > bestFlash) {
          bestFlash = f;
          best = s;
        }
      }
      if (best && this.scene) {
        const facade = this.scene.world.facade(this.lightEntityId as never);
        if (facade) facade.transform.position = this.scratchPos.set(best.position.x, (this.cloudHeight + this.groundY) / 2, best.position.z);
      }
      this.light.intensity = this.flashTotal * this.flashLightIntensity;
    }
    if (this.flashTotal > 0.001) {
      context.render?.setSkyOverride({ exposure: 1 + this.flashTotal * this.skyFlashExposure });
      const render = context.render;
      if (render) {
        this.lastBolts.length = 0;
        for (const s of this.strikes) {
          const f = s.energy * flashEnvelope(s.age, this.envelope);
          if (f <= 0.01) continue;
          this.lastBolts.push(s.bolt.points);
          const pts = s.bolt.points;
          for (let i = 1; i < pts.length; i++) render.drawLine(pts[i - 1]!, pts[i]!, 0xdde8ffff);
        }
      }
    } else {
      this.lastBolts.length = 0;
    }
  }

  /** Exponential interarrival at `rate × storm` (mean 1/(rate·storm) seconds). */
  private drawInterarrival(storm: number): number {
    const lambda = Math.max(1e-6, this.rate * Math.max(0, storm));
    return -Math.log(1 - this.rng.nextFloat()) / lambda;
  }

  override stats(): Record<string, number | string | boolean> {
    return {
      strikes: this.strikeCount,
      active: this.strikes.length,
      flash: Math.round(this.flashTotal * 1000) / 1000,
      storm: Math.round(this.stormIntensity() * 1000) / 1000,
    };
  }
}
