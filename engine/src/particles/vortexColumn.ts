/**
 * fe-34 v3: VortexColumnParticles — a reusable particle vortex (dust devil, waterspout, fire whirl).
 *
 * Generalises the Mars dust-storm devil look (examples/src/scenes/dustStorm.ts `devilParticleLook`,
 * red-frontier's column/skirt alternation) into the engine: one {@link GpuParticleWorld} whose
 * emitter alternates frames between a rising **column** (the GPU vortex spawn: particles placed up a
 * leaning, widening funnel with tangential spin and an updraft) and a wide outward **skirt** at the
 * base, with the swirl (`swirlStrength`) and the axis spring (`axisPull` + `axisLean`) keeping the
 * swarm rope-like while it bends. The host sets the pose and look each frame with {@link set}.
 *
 * Colours are the caller's: dust tones for a devil; white / grey / blue-grey spray and mist for a
 * waterspout ({@link VORTEX_WATER_LOOK}).
 */
import { SceneObject, type Scene } from "../scene/scene.js";
import type { SystemContext } from "../scene/systems.js";
import { GpuParticleWorld } from "./gpuWorld.js";
import type { GpuParticleVortexSpawn } from "./gpuSystem.js";

export interface VortexColumnColors {
  /** Main particle colour (linear 0..1) and peak alpha. */
  color: { r: number; g: number; b: number };
  /** Alternate tint particles blend toward (`variation`). */
  alt: { r: number; g: number; b: number };
  alpha: number;
  variation: number;
}

/** Water: white spray, grey mist, blue-grey condensation. */
export const VORTEX_WATER_LOOK: VortexColumnColors = {
  color: { r: 0.86, g: 0.89, b: 0.92 },
  alt: { r: 0.5, g: 0.57, b: 0.65 },
  alpha: 0.8,
  variation: 0.7,
};

export interface VortexColumnOptions {
  name?: string;
  capacity?: number;
  seed?: number;
  colors?: VortexColumnColors;
  /** Particle size range over life (m). Defaults 2.5 → 9 (waterspout scale; a devil uses ~0.2 → 0.5). */
  sizeStart?: number;
  sizeEnd?: number;
  /** Frames per emit cycle and how many of them emit the skirt. Defaults 6 / 1. */
  cycle?: number;
  skirtFrames?: number;
  cullDistance?: number;
}

/** The per-frame pose of the vortex (render-local metres). */
export interface VortexColumnPose {
  /** Base of the column (where it meets the ground / sea). */
  x: number;
  y: number;
  z: number;
  height: number;
  radiusBase: number;
  radiusTop: number;
  /** Signed angular speed (rad/s) at the rim; sign = rotation sense. */
  spin: number;
  /** Top offset relative to the base (m), the column's lean. */
  leanX: number;
  leanZ: number;
  /** Mid-column bend and S-snake amplitudes (m). */
  bendX?: number;
  bendZ?: number;
  snakeX?: number;
  snakeZ?: number;
  /** 0..1 vigour: scales emission (0 = off, particles finish their life). */
  strength: number;
  /** Particles per second at strength 1. */
  rate: number;
  /** Updraft speed range (m/s). */
  speedMin?: number;
  speedMax?: number;
}

/**
 * Pure: the vortex spawn shape for this frame — column or skirt (red-frontier alternation). Exported
 * for tests.
 */
export function vortexColumnSpawn(pose: VortexColumnPose, frame: number, cycle = 6, skirtFrames = 1, out?: GpuParticleVortexSpawn): { spawn: GpuParticleVortexSpawn; skirt: boolean } {
  const o: GpuParticleVortexSpawn = out ?? { height: 0, bias: 1, radiusBase: 0, radiusTop: 0, spin: 0, outward: 0, leanX: 0, leanZ: 0 };
  const skirt = frame % Math.max(1, cycle) < skirtFrames;
  if (skirt) {
    o.height = Math.max(1, pose.height * 0.03);
    o.bias = 1;
    o.radiusBase = pose.radiusBase * 1.4;
    o.radiusTop = pose.radiusBase * 3.2;
    o.spin = pose.spin * 0.5;
    o.outward = Math.max(4, pose.radiusBase * 0.6);
    o.leanX = o.leanZ = 0;
    o.bendX = o.bendZ = o.snakeX = o.snakeZ = 0;
  } else {
    o.height = pose.height;
    o.bias = 1.25;
    o.radiusBase = pose.radiusBase * 0.6;
    o.radiusTop = pose.radiusTop;
    o.spin = pose.spin;
    o.outward = 0;
    o.leanX = pose.leanX;
    o.leanZ = pose.leanZ;
    o.bendX = pose.bendX ?? 0;
    o.bendZ = pose.bendZ ?? 0;
    o.snakeX = pose.snakeX ?? 0;
    o.snakeZ = pose.snakeZ ?? 0;
  }
  return { spawn: o, skirt };
}

export class VortexColumnParticles extends SceneObject {
  readonly name: string;
  readonly world: GpuParticleWorld;
  private readonly options: VortexColumnOptions;
  private frame = 0;
  private pose: VortexColumnPose | null = null;
  private readonly spawn: GpuParticleVortexSpawn = { height: 0, bias: 1, radiusBase: 0, radiusTop: 0, spin: 0, outward: 0, leanX: 0, leanZ: 0 };

  constructor(options: VortexColumnOptions = {}) {
    super();
    this.name = options.name ?? "vortex-column";
    this.options = options;
    const c = options.colors ?? VORTEX_WATER_LOOK;
    this.world = new GpuParticleWorld({
      name: `${this.name}-particles`,
      capacity: options.capacity ?? 12000,
      seed: options.seed ?? 0x5b0,
      maxEmitsPerFrame: 2048,
      softParticles: true,
      softScale: 12,
      softSprite: true,
      stretch: 0,
      cullDistance: options.cullDistance ?? 5000,
      emitter: {
        rate: 0,
        lifeMin: 1.6,
        lifeMax: 3.2,
        size: options.sizeStart ?? 2.5,
        position: { x: 0, y: 0, z: 0 },
        jitter: { x: 0, y: 0, z: 0 },
        coneDir: { x: 0, y: 1, z: 0 },
        coneAngle: 0.2,
        speedMin: 6,
        speedMax: 14,
        color: { ...c.color, a: c.alpha },
      },
      modules: {
        gravity: { x: 0, y: -0.4, z: 0 },
        drag: 0.25,
        turbulence: 2.5,
        noiseScale: 0.02,
        colorFrom: { ...c.color, a: c.alpha },
        colorTo: { ...c.color, a: 0 },
        colorAlt: { ...c.alt, a: 1 },
        colorVariation: c.variation,
        sizeStart: options.sizeStart ?? 2.5,
        sizeEnd: options.sizeEnd ?? 9,
        sizeVariation: 0.45,
        rotationSpeed: 0.4,
      },
    });
  }

  override onAttach(scene: Scene): void {
    scene.add(this.world);
  }

  override onDetach(scene: Scene): void {
    scene.removeObject(this.world);
  }

  /** Set this frame's pose (null = stop emitting; live particles finish their life). */
  set(pose: VortexColumnPose | null): void {
    this.pose = pose;
  }

  override update(_context: SystemContext): void {
    const sys = this.world.system;
    if (!sys) return;
    const e = sys.emitter;
    const m = sys.modules;
    const p = this.pose;
    if (!p || p.strength <= 0) {
      e.rate = 0;
      m.swirlStrength = 0;
      m.axisPull = 0;
      return;
    }
    this.frame++;
    const { skirt } = vortexColumnSpawn(p, this.frame, this.options.cycle ?? 6, this.options.skirtFrames ?? 1, this.spawn);
    e.vortex = this.spawn;
    e.position.x = p.x;
    e.position.y = p.y;
    e.position.z = p.z;
    e.rate = p.rate * p.strength * (skirt ? 1.5 : 1);
    e.speedMin = skirt ? 2 : (p.speedMin ?? 6);
    e.speedMax = skirt ? 6 : (p.speedMax ?? 14);
    e.lifeMin = skirt ? 1.0 : 1.8;
    e.lifeMax = skirt ? 2.2 : 3.4;
    m.attractorPos.x = p.x;
    m.attractorPos.y = p.y;
    m.attractorPos.z = p.z;
    m.attractorStrength = 0;
    // Swirl ∝ spin × r (1/r falloff in the module, so scale by the rim radius squared).
    m.swirlStrength = p.spin * p.radiusBase * p.radiusBase * 0.6;
    m.axisPull = 0.35;
    const lean = (m.axisLean ??= { x: 0, y: 1, z: 0 });
    lean.x = p.leanX;
    lean.y = Math.max(1, p.height);
    lean.z = p.leanZ;
    const curve = (m.axisCurve ??= { bendX: 0, bendZ: 0, snakeX: 0, snakeZ: 0, bulge: 0 });
    curve.bendX = p.bendX ?? 0;
    curve.bendZ = p.bendZ ?? 0;
    curve.snakeX = p.snakeX ?? 0;
    curve.snakeZ = p.snakeZ ?? 0;
    curve.bulge = 0;
  }
}
