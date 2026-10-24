/**
 * DustDevilField — a reusable, self-managing population of dust devils around a viewer.
 *
 * A few {@link VortexColumnParticles} (one GPU particle world each) are spawned, drifted on the wind,
 * grown, faded and recycled by this object; the host only says *how active the weather is*
 * ({@link DustDevilField.activity}, 0..1), which way the wind blows and where the viewer is. At 0 the
 * field is empty and costs nothing; at 1 every slot is busy. Devils appear in a ring around the
 * viewer (not on top of it), rise on the ground the host's `groundHeight` reports, lean downwind,
 * spin in a random sense, and live 25–70 s. Deterministic for a seed.
 *
 * It owns the *behaviour* (spawn, motion, envelope); the look is the vortex's — {@link VORTEX_DUST_LOOK}
 * by default.
 */
import { Rng } from "../math/rng.js";
import { SceneObject, type Scene } from "../scene/scene.js";
import type { SystemContext } from "../scene/systems.js";
import { VORTEX_DUST_LOOK, VortexColumnParticles, type VortexColumnColors, type VortexColumnPose } from "./vortexColumn.js";

export interface DustDevilFieldOptions {
  name?: string;
  /** Devils alive at once, at most. Default 3. */
  count?: number;
  seed?: number;
  /** Particle capacity of each devil. Default 7000. */
  capacity?: number;
  /** Particles per second of a full-strength devil. Default 4500. */
  rate?: number;
  /** Ground height at an XZ position (render-local metres). Default flat at 0. */
  groundHeight?: (x: number, z: number) => number;
  /** Spawn ring around the viewer, metres. Default 140..1300. */
  minDistance?: number;
  maxDistance?: number;
  /** Lifetime range, seconds. Default 25..70. */
  lifeMin?: number;
  lifeMax?: number;
  /** Column height and base radius ranges, metres. Defaults 70..300 and 4..13. */
  heightMin?: number;
  heightMax?: number;
  radiusMin?: number;
  radiusMax?: number;
  colors?: VortexColumnColors;
  /** Particle size over life, metres. Defaults 1.4 → 4.5. */
  sizeStart?: number;
  sizeEnd?: number;
}

interface Slot {
  column: VortexColumnParticles;
  alive: boolean;
  age: number;
  life: number;
  x: number;
  z: number;
  height: number;
  radius: number;
  spin: number;
  phase: number;
  wobble: number;
  pose: VortexColumnPose;
}

/** What the devils are doing, for HUDs and tests. */
export interface DustDevilFieldState {
  alive: number;
  capacity: number;
  activity: number;
  /** Alive devils: world position of the base and 0..1 strength. */
  devils: { x: number; y: number; z: number; strength: number; height: number }[];
}

const smooth = (t: number): number => {
  const c = t < 0 ? 0 : t > 1 ? 1 : t;
  return c * c * (3 - 2 * c);
};

export class DustDevilField extends SceneObject {
  readonly name: string;
  /** 0..1: how much dust-devil weather there is (spawn probability and strength). */
  activity = 0;
  /** Wind the devils drift with, m/s (+x east, +z north). */
  windX = 0;
  windZ = 0;
  /** Where the viewer is (devils spawn in a ring around it). */
  focusX = 0;
  focusZ = 0;
  groundHeight: (x: number, z: number) => number;

  private readonly slots: Slot[] = [];
  private readonly rng: Rng;
  private readonly minDistance: number;
  private readonly maxDistance: number;
  private readonly lifeMin: number;
  private readonly lifeMax: number;
  private readonly heightMin: number;
  private readonly heightMax: number;
  private readonly radiusMin: number;
  private readonly radiusMax: number;
  private readonly rate: number;

  constructor(options: DustDevilFieldOptions = {}) {
    super();
    this.name = options.name ?? "dust-devils";
    this.rng = new Rng(options.seed ?? 0xd0575);
    this.groundHeight = options.groundHeight ?? (() => 0);
    this.minDistance = options.minDistance ?? 140;
    this.maxDistance = options.maxDistance ?? 1300;
    this.lifeMin = options.lifeMin ?? 25;
    this.lifeMax = options.lifeMax ?? 70;
    this.heightMin = options.heightMin ?? 70;
    this.heightMax = options.heightMax ?? 300;
    this.radiusMin = options.radiusMin ?? 4;
    this.radiusMax = options.radiusMax ?? 13;
    this.rate = options.rate ?? 4500;
    const count = Math.max(0, Math.floor(options.count ?? 3));
    for (let i = 0; i < count; i++) {
      const column = new VortexColumnParticles({
        name: `${this.name}-${i}`,
        capacity: options.capacity ?? 7000,
        seed: (options.seed ?? 0xd0575) + i * 7919,
        colors: options.colors ?? VORTEX_DUST_LOOK,
        sizeStart: options.sizeStart ?? 1.4,
        sizeEnd: options.sizeEnd ?? 4.5,
        cullDistance: this.maxDistance * 3,
      });
      this.slots.push({
        column, alive: false, age: 0, life: 1, x: 0, z: 0, height: 100, radius: 6, spin: 1, phase: 0, wobble: 0,
        pose: { x: 0, y: 0, z: 0, height: 100, radiusBase: 6, radiusTop: 12, spin: 3, leanX: 0, leanZ: 0, strength: 0, rate: this.rate },
      });
    }
  }

  override onAttach(scene: Scene): void {
    for (const s of this.slots) scene.add(s.column);
  }

  override onDetach(scene: Scene): void {
    for (const s of this.slots) scene.removeObject(s.column);
  }

  /** Remove every devil now (their particles finish their life). */
  clear(): void {
    for (const s of this.slots) {
      s.alive = false;
      s.column.set(null);
    }
  }

  state(): DustDevilFieldState {
    const devils = this.slots.filter((s) => s.alive).map((s) => ({ x: s.pose.x, y: s.pose.y, z: s.pose.z, strength: s.pose.strength, height: s.pose.height }));
    return { alive: devils.length, capacity: this.slots.length, activity: this.activity, devils };
  }

  override update(_context: SystemContext, dt: number): void {
    if (!(dt > 0)) return;
    const wind = Math.hypot(this.windX, this.windZ);
    const dirX = wind > 1e-3 ? this.windX / wind : 1;
    const dirZ = wind > 1e-3 ? this.windZ / wind : 0;
    const activity = Math.max(0, Math.min(1, this.activity));
    for (const s of this.slots) {
      if (!s.alive) {
        // Expected spawn about every 5 s / activity per idle slot, and none in dead-calm weather.
        if (activity > 0.06 && this.rng.nextFloat() < dt * activity * 0.22) this.spawn(s);
        else continue;
      }
      s.age += dt;
      if (s.age >= s.life) {
        s.alive = false;
        s.column.set(null);
        continue;
      }
      // Drift on a fraction of the wind with a slow meander.
      s.phase += dt * 0.35;
      const speed = wind * 0.45 + 0.6;
      s.x += (dirX * speed + Math.cos(s.phase) * s.wobble) * dt;
      s.z += (dirZ * speed + Math.sin(s.phase * 0.8) * s.wobble) * dt;
      const grow = smooth(s.age / 7);
      const fade = smooth((s.life - s.age) / 9);
      const env = Math.min(grow, fade);
      const p = s.pose;
      p.x = s.x;
      p.z = s.z;
      p.y = this.groundHeight(s.x, s.z);
      p.height = s.height * (0.35 + 0.65 * grow) * (0.7 + 0.3 * fade);
      p.radiusBase = s.radius * (0.6 + 0.4 * grow);
      p.radiusTop = p.radiusBase * 2.3;
      p.spin = s.spin * 3.2;
      const lean = Math.min(0.5, 0.12 + wind * 0.02);
      p.leanX = dirX * p.height * lean;
      p.leanZ = dirZ * p.height * lean;
      p.snakeX = Math.sin(s.phase * 1.7) * p.height * 0.05;
      p.snakeZ = Math.cos(s.phase * 1.3) * p.height * 0.05;
      p.strength = env * (0.55 + 0.45 * activity);
      p.rate = this.rate;
      s.column.set(p);
    }
  }

  private spawn(s: Slot): void {
    const r = this.rng;
    const angle = r.nextFloat() * Math.PI * 2;
    // Spread by area, so devils are not all bunched near the inner edge.
    const d = Math.sqrt(this.minDistance * this.minDistance + r.nextFloat() * (this.maxDistance * this.maxDistance - this.minDistance * this.minDistance));
    s.alive = true;
    s.age = 0;
    s.life = this.lifeMin + (this.lifeMax - this.lifeMin) * r.nextFloat();
    s.x = this.focusX + Math.cos(angle) * d;
    s.z = this.focusZ + Math.sin(angle) * d;
    s.height = this.heightMin + (this.heightMax - this.heightMin) * r.nextFloat();
    s.radius = this.radiusMin + (this.radiusMax - this.radiusMin) * Math.min(1, r.nextFloat() * 0.6 + (s.height - this.heightMin) / Math.max(1, this.heightMax - this.heightMin) * 0.4);
    s.spin = r.nextFloat() < 0.5 ? 1 : -1;
    s.phase = r.nextFloat() * Math.PI * 2;
    s.wobble = 0.5 + r.nextFloat() * 1.5;
  }
}
