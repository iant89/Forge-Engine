/**
 * Precipitation (fe-33): camera-following, wind-slanted rain as GPU billboards.
 *
 * Lifted from the Phase 8b weather demo into the engine so any scene can rain: a
 * `GpuParticleWorld` whose emitter slab follows a target point (usually the camera), whose rate is
 * `intensity × maxRate`, and whose fall direction leans with the wind (`windX/windZ` against a
 * near-terminal fall speed). The driver callback is the only coupling — a `WeatherSystem`
 * (`precipitation01`, `meanWind`) or a `CycloneSystem` (`observed.rain`, `observed.wind`) both fit.
 */

import { GpuParticleWorld } from "./gpuWorld.js";
import type { SystemContext } from "../scene/systems.js";

export interface PrecipitationDrive {
  /** 0..1 rain intensity. */
  intensity: number;
  /** Horizontal wind, m/s. */
  windX: number;
  windZ: number;
  /**
   * 0..1 fraction falling as snow (Phase 17.4; `weatherPrecipitationDrive` derives it from the
   * temperature). Snow falls at ≈ 1.2 m/s, lives long enough to cross the slab, and is whiter and
   * larger. Default 0 (rain).
   */
  snow?: number;
}

export interface PrecipitationFieldOptions {
  name?: string;
  /** Particle capacity (tier knob). Default 8192. */
  capacity?: number;
  /** Drops per second at intensity 1. Default 4200. */
  maxRate?: number;
  /** Point the slab follows (the camera). */
  follow: () => { x: number; y: number; z: number };
  drive: () => PrecipitationDrive;
  /** Fall speed (m/s). Default 21. */
  fallSpeed?: number;
  /** Fraction of the wind the drops take (they never reach full wind speed). Default 0.8. */
  windCoupling?: number;
  /** Half-extent of the spawn slab around the target. Default 26. */
  radius?: number;
  seed?: number;
  /** Drop tint (linear RGBA). */
  color?: { r: number; g: number; b: number; a: number };
}

/** Unit fall direction for a wind and fall speed (pure; the field and tests share it). */
export function precipitationDirection(windX: number, windZ: number, fallSpeed: number, coupling = 0.8): { x: number; y: number; z: number } {
  const x = windX * coupling;
  const z = windZ * coupling;
  const len = Math.hypot(x, fallSpeed, z) || 1;
  return { x: x / len, y: -fallSpeed / len, z: z / len };
}

export class PrecipitationField extends GpuParticleWorld {
  private readonly field: PrecipitationFieldOptions;
  /** Rate applied on the last update (drops/s). */
  rate = 0;

  constructor(options: PrecipitationFieldOptions) {
    const color = options.color ?? { r: 0.63, g: 0.75, b: 0.86, a: 0.72 };
    const radius = options.radius ?? 26;
    super({
      name: options.name ?? "precipitation",
      capacity: options.capacity ?? 8192,
      seed: options.seed ?? 41,
      maxEmitsPerFrame: 1024,
      softParticles: true,
      softScale: 28,
      stretch: 4.2,
      cullDistance: 120,
      emitter: {
        rate: 0,
        lifeMin: 0.9,
        lifeMax: 1.4,
        size: 0.03,
        position: { x: 0, y: 20, z: 0 },
        jitter: { x: radius * 2, y: 5, z: radius * 2 },
        coneDir: { x: 0, y: -1, z: 0 },
        coneAngle: 0.04,
        speedMin: 18,
        speedMax: 24,
        color,
      },
      modules: {
        gravity: { x: 0, y: 0, z: 0 },
        drag: 0,
        turbulence: 0.14,
        noiseScale: 0.06,
        colorFrom: color,
        colorTo: { r: color.r, g: color.g, b: color.b, a: 0 },
        sizeStart: 0.03,
        sizeEnd: 0.022,
        rotationSpeed: 0,
      },
    });
    this.field = options;
  }

  /** Approximate live drops (no GPU readback). */
  get aliveEstimate(): number {
    const system = this.system;
    if (!system?.ready || this.rate <= 0) return 0;
    const meanLife = (system.emitter.lifeMin + system.emitter.lifeMax) * 0.5;
    return Math.min(system.capacity, system.emitted, Math.ceil(this.rate * meanLife));
  }

  override update(context: SystemContext, dt: number): void {
    const system = this.system;
    const drive = this.field.drive();
    const snow = Math.max(0, Math.min(1, drive.snow ?? 0));
    const rainFall = this.field.fallSpeed ?? 21;
    const fall = rainFall + (1.2 - rainFall) * snow;
    const coupling = this.field.windCoupling ?? 0.8;
    this.rate = Math.max(0, Math.min(1, drive.intensity)) * (this.field.maxRate ?? 4200);
    if (system) {
      const emitter = system.emitter;
      const eye = this.field.follow();
      const dir = precipitationDirection(drive.windX, drive.windZ, fall, coupling);
      // Spawn upwind so slanted drops still cross the view.
      const lead = 13 / Math.max(1e-3, -dir.y);
      emitter.position.x = eye.x - dir.x * lead;
      emitter.position.y = eye.y + 13;
      emitter.position.z = eye.z - dir.z * lead;
      emitter.rate = this.rate;
      emitter.coneDir.x = dir.x;
      emitter.coneDir.y = dir.y;
      emitter.coneDir.z = dir.z;
      const speed = Math.hypot(fall, drive.windX * coupling, drive.windZ * coupling);
      emitter.speedMin = speed * 0.85;
      emitter.speedMax = speed * 1.1;
      // Same 19–30 m path length whatever the fall speed, so flakes still cross the slab.
      emitter.lifeMin = 19 / speed;
      emitter.lifeMax = 30 / speed;
      emitter.size = 0.03 + 0.03 * snow;
    }
    super.update(context, dt);
  }
}
