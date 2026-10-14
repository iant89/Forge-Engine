/**
 * Wind-blown particles (fe-34): sea spray, spindrift, blowing sand, debris and mist streaks as
 * camera-following GPU billboards carried horizontally by the wind.
 *
 * A {@link WindBlownField} is a `GpuParticleWorld` whose emitter sits upwind of a follow point in
 * a low band above the surface; particles leave along the wind at `windCoupling × gust speed`, with
 * a little lift, then fall or fade. The driver callback is the only coupling (any wind source works:
 * `CycloneSystem.observed`, `WeatherSystem.meanWind`, a script). {@link windBlownPreset} gives the
 * look of each material; every field is tier-scalable through `capacity`/`maxRate`.
 */

import { GpuParticleWorld } from "./gpuWorld.js";
import type { SystemContext } from "../scene/systems.js";

export interface WindBlownDrive {
  /** 0..1 how much is in the air (e.g. wind above a threshold × gust). */
  intensity: number;
  /** Horizontal wind (m/s) the particles ride, gusts included. */
  windX: number;
  windZ: number;
}

export type WindBlownMaterial = "spray" | "spindrift" | "sand" | "mist" | "debris";

export interface WindBlownLook {
  color: { r: number; g: number; b: number; a: number };
  size: number;
  sizeEnd: number;
  lifeMin: number;
  lifeMax: number;
  /** Height band (m above `baseY`) particles are born in. */
  heightMin: number;
  heightMax: number;
  /** Fraction of the wind speed the particles move at. */
  windCoupling: number;
  /** Upward launch speed (m/s). */
  lift: number;
  /** Gravity (m/s², negative = down). */
  gravity: number;
  /** Billboard stretch along velocity (streaks). */
  stretch: number;
  turbulence: number;
}

/** The look of each material (pure data; override any field through the options). */
export function windBlownPreset(material: WindBlownMaterial): WindBlownLook {
  switch (material) {
    case "spray":
      return { color: { r: 0.82, g: 0.87, b: 0.9, a: 0.55 }, size: 0.09, sizeEnd: 0.5, lifeMin: 0.8, lifeMax: 1.8, heightMin: 0, heightMax: 3, windCoupling: 0.7, lift: 2.5, gravity: -2.5, stretch: 1.6, turbulence: 0.6 };
    case "spindrift":
      return { color: { r: 0.9, g: 0.93, b: 0.95, a: 0.4 }, size: 0.25, sizeEnd: 1.6, lifeMin: 1.2, lifeMax: 2.6, heightMin: 0.5, heightMax: 5, windCoupling: 0.85, lift: 1.2, gravity: -0.4, stretch: 2.5, turbulence: 0.5 };
    case "sand":
      return { color: { r: 0.72, g: 0.62, b: 0.45, a: 0.6 }, size: 0.025, sizeEnd: 0.02, lifeMin: 0.6, lifeMax: 1.3, heightMin: 0, heightMax: 0.8, windCoupling: 0.55, lift: 0.8, gravity: -6, stretch: 3, turbulence: 0.3 };
    case "mist":
      return { color: { r: 0.7, g: 0.74, b: 0.78, a: 0.18 }, size: 1.4, sizeEnd: 4, lifeMin: 1.5, lifeMax: 3, heightMin: 0, heightMax: 14, windCoupling: 0.95, lift: 0, gravity: 0, stretch: 6, turbulence: 0.25 };
    case "debris":
      return { color: { r: 0.32, g: 0.36, b: 0.22, a: 0.95 }, size: 0.08, sizeEnd: 0.07, lifeMin: 1, lifeMax: 2, heightMin: 0.3, heightMax: 6, windCoupling: 0.6, lift: 3, gravity: -3, stretch: 1, turbulence: 1.2 };
  }
}

export interface WindBlownFieldOptions {
  name?: string;
  material: WindBlownMaterial;
  /** Overrides on the preset look. */
  look?: Partial<WindBlownLook>;
  capacity?: number;
  /** Particles per second at intensity 1. Default 600. */
  maxRate?: number;
  /** Point the field follows (camera, or a stretch of surf). */
  follow: () => { x: number; y: number; z: number };
  /** Surface height the band sits on (sea level for spray, ground for sand). Default 0. */
  baseY?: () => number;
  drive: () => WindBlownDrive;
  /** Half-extent of the spawn area. Default 40. */
  radius?: number;
  /** Metres upwind of the follow point the area is centred. Default 0.6 × radius. */
  upwind?: number;
  seed?: number;
}

/** Horizontal launch direction + speed for a wind and look (pure; shared by the field and tests). */
export function windBlownVelocity(windX: number, windZ: number, look: Pick<WindBlownLook, "windCoupling" | "lift">): { x: number; y: number; z: number; speed: number } {
  const x = windX * look.windCoupling;
  const z = windZ * look.windCoupling;
  const y = look.lift;
  const speed = Math.hypot(x, y, z);
  if (speed < 1e-6) return { x: 0, y: 1, z: 0, speed: 0 };
  return { x: x / speed, y: y / speed, z: z / speed, speed };
}

export class WindBlownField extends GpuParticleWorld {
  readonly look: WindBlownLook;
  private readonly field: WindBlownFieldOptions;
  /** Rate applied on the last update (particles/s). */
  rate = 0;

  constructor(options: WindBlownFieldOptions) {
    const look = { ...windBlownPreset(options.material), ...options.look };
    const radius = options.radius ?? 40;
    super({
      name: options.name ?? `wind-${options.material}`,
      capacity: options.capacity ?? 4096,
      seed: options.seed ?? 77,
      maxEmitsPerFrame: 1024,
      softParticles: true,
      softScale: 6,
      stretch: look.stretch,
      cullDistance: radius * 4,
      emitter: {
        rate: 0,
        lifeMin: look.lifeMin,
        lifeMax: look.lifeMax,
        size: look.size,
        position: { x: 0, y: 0, z: 0 },
        jitter: { x: radius * 2, y: Math.max(0.01, look.heightMax - look.heightMin), z: radius * 2 },
        coneDir: { x: 1, y: 0, z: 0 },
        coneAngle: 0.25,
        speedMin: 1,
        speedMax: 1,
        color: look.color,
      },
      modules: {
        gravity: { x: 0, y: look.gravity, z: 0 },
        drag: 0.15,
        turbulence: look.turbulence,
        noiseScale: 0.08,
        colorFrom: look.color,
        colorTo: { r: look.color.r, g: look.color.g, b: look.color.b, a: 0 },
        sizeStart: look.size,
        sizeEnd: look.sizeEnd,
        rotationSpeed: 0,
      },
    });
    this.look = look;
    this.field = options;
  }

  override update(context: SystemContext, dt: number): void {
    const system = this.system;
    const drive = this.field.drive();
    this.rate = Math.max(0, Math.min(1, drive.intensity)) * (this.field.maxRate ?? 600);
    if (system) {
      const e = system.emitter;
      const at = this.field.follow();
      const v = windBlownVelocity(drive.windX, drive.windZ, this.look);
      const radius = this.field.radius ?? 40;
      const up = this.field.upwind ?? radius * 0.6;
      const h = Math.hypot(v.x, v.z) || 1;
      e.position.x = at.x - (v.x / h) * up;
      e.position.z = at.z - (v.z / h) * up;
      e.position.y = (this.field.baseY?.() ?? 0) + (this.look.heightMin + this.look.heightMax) * 0.5;
      e.rate = this.rate;
      e.coneDir.x = v.x;
      e.coneDir.y = v.y;
      e.coneDir.z = v.z;
      e.speedMin = v.speed * 0.75;
      e.speedMax = v.speed * 1.15;
    }
    super.update(context, dt);
  }
}
