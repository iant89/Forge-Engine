/**
 * Waterspout visual (fe-34 v3): renders a {@link WaterspoutSystem}'s spouts as particle vortices —
 * the same swirling-swarm look as the Mars dust devils, generalised into the engine as
 * {@link VortexColumnParticles}, in water colours (slate-blue and grey column, white spray accents) —
 * plus a spray ring (a GPU particle field thrown up and out around the base of the strongest spout).
 *
 * The column follows `waterspoutFunnelAt`: it leans with the funnel's top offset, bends and snakes
 * with its wander, widens toward the cloud base, and thins out as the spout ropes out and lifts off
 * the sea (`waterspoutStrength` + the bottom opacity drive the emission).
 *
 * Kept apart from the simulation (`environment/waterspout.ts`) so headless hosts and tests can run
 * spouts without a device. One particle system per `maxActive` slot is preallocated; nothing is
 * created or destroyed per frame.
 */

import { SceneObject, type Scene } from "../scene/scene.js";
import type { SystemContext } from "../scene/systems.js";
import type { GraphicsDevice } from "../gpu/device.js";
import { GpuParticleWorld } from "./gpuWorld.js";
import { VORTEX_WATER_LOOK, VortexColumnParticles, type VortexColumnColors, type VortexColumnPose } from "./vortexColumn.js";
import { type WaterspoutSystem, type WaterspoutFunnelSample, waterspoutFunnelAt, waterspoutStrength } from "../environment/waterspout.js";

export interface WaterspoutVisualOptions {
  name?: string;
  /** Kept for API compatibility (the particle path needs no geometry). */
  gpu?: GraphicsDevice;
  spouts: WaterspoutSystem;
  /** Sea surface height under the spouts. */
  seaLevel: () => number;
  /** Cloud base height (the funnel's top). */
  cloudBase: () => number;
  /** Particles per spout column (tier knob). Default 12000. */
  columnCapacity?: number;
  /** Column emission at full strength (particles/s). Default 5000. */
  columnRate?: number;
  /** Spray particles (tier knob). Default 3072; 0 disables the spray ring. */
  sprayCapacity?: number;
  /** Particle colours. Default {@link VORTEX_WATER_LOOK}. */
  colors?: VortexColumnColors;
  /** Particle size over life (m). Defaults 3 → 11. */
  sizeStart?: number;
  sizeEnd?: number;
}

export class WaterspoutVisual extends SceneObject {
  readonly name: string;
  readonly options: WaterspoutVisualOptions;
  private readonly columns: VortexColumnParticles[] = [];
  private readonly poses: VortexColumnPose[] = [];
  private spray: GpuParticleWorld | null = null;
  private readonly sample: WaterspoutFunnelSample = { dx: 0, dz: 0, radius: 0, opacity: 0 };
  private readonly top: WaterspoutFunnelSample = { dx: 0, dz: 0, radius: 0, opacity: 0 };
  private readonly mid: WaterspoutFunnelSample = { dx: 0, dz: 0, radius: 0, opacity: 0 };
  /** Columns emitting last frame (tests/HUD). */
  activeColumns = 0;

  constructor(options: WaterspoutVisualOptions) {
    super();
    this.name = options.name ?? "waterspout-visual";
    this.options = options;
  }

  override onAttach(scene: Scene): void {
    const o = this.options;
    const maxActive = o.spouts.options.maxActive ?? 2;
    for (let k = 0; k < maxActive; k++) {
      const col = new VortexColumnParticles({
        name: `${this.name}-column-${k}`,
        capacity: o.columnCapacity ?? 12000,
        seed: 0x5b0 + k * 17,
        colors: o.colors ?? VORTEX_WATER_LOOK,
        sizeStart: o.sizeStart ?? 3,
        sizeEnd: o.sizeEnd ?? 11,
      });
      scene.add(col);
      this.columns.push(col);
      this.poses.push({ x: 0, y: 0, z: 0, height: 1, radiusBase: 1, radiusTop: 1, spin: 0, leanX: 0, leanZ: 0, strength: 0, rate: 0 });
    }
    if ((o.sprayCapacity ?? 3072) > 0) {
      this.spray = new GpuParticleWorld({
        name: `${this.name}-spray`,
        capacity: o.sprayCapacity ?? 3072,
        seed: 515,
        maxEmitsPerFrame: 512,
        softParticles: true,
        softScale: 8,
        softSprite: true,
        stretch: 1.4,
        cullDistance: 5000,
        emitter: {
          rate: 0,
          lifeMin: 1.2,
          lifeMax: 2.6,
          size: 2,
          position: { x: 0, y: 0, z: 0 },
          jitter: { x: 20, y: 1, z: 20 },
          coneDir: { x: 0, y: 1, z: 0 },
          coneAngle: 1.2,
          speedMin: 6,
          speedMax: 16,
          color: { r: 0.9, g: 0.93, b: 0.95, a: 0.65 },
        },
        modules: {
          gravity: { x: 0, y: -3, z: 0 },
          drag: 0.4,
          turbulence: 3,
          noiseScale: 0.05,
          colorFrom: { r: 0.9, g: 0.93, b: 0.95, a: 0.65 },
          colorTo: { r: 0.72, g: 0.78, b: 0.84, a: 0 },
          sizeStart: 2,
          sizeEnd: 10,
          rotationSpeed: 0.5,
        },
      });
      scene.add(this.spray);
    }
  }

  override onDetach(scene: Scene): void {
    for (const c of this.columns) scene.removeObject(c);
    this.columns.length = 0;
    this.poses.length = 0;
    if (this.spray) scene.removeObject(this.spray);
    this.spray = null;
  }

  override update(_context: SystemContext): void {
    const o = this.options;
    const spouts = o.spouts.spouts;
    const sea = o.seaLevel();
    const height = Math.max(sea + 50, o.cloudBase()) - sea;
    const t = o.spouts.time;
    let strongest = -1;
    let strongestValue = 0;
    this.activeColumns = 0;
    for (let k = 0; k < this.columns.length; k++) {
      const spout = spouts[k];
      const col = this.columns[k]!;
      if (!spout) {
        col.set(null);
        continue;
      }
      const strength = waterspoutStrength(spout.age, spout.life);
      if (strength > strongestValue) {
        strongestValue = strength;
        strongest = k;
      }
      const base = waterspoutFunnelAt(spout, 0.04, t, this.sample);
      const mid = waterspoutFunnelAt(spout, 0.5, t, this.mid);
      const top = waterspoutFunnelAt(spout, 0.97, t, this.top);
      const p = this.poses[k]!;
      p.x = spout.x + base.dx;
      p.y = sea + 0.5;
      p.z = spout.z + base.dz;
      p.height = height;
      p.radiusBase = Math.max(2, base.radius);
      p.radiusTop = Math.max(p.radiusBase * 1.5, top.radius);
      p.spin = 0.9 + 0.6 * strength;
      p.leanX = top.dx - base.dx;
      p.leanZ = top.dz - base.dz;
      // Mid-column wander beyond the straight lean → the bend.
      p.bendX = mid.dx - base.dx - p.leanX * 0.42;
      p.bendZ = mid.dz - base.dz - p.leanZ * 0.42;
      p.snakeX = p.snakeZ = 0;
      // Roping out: the column thins as condensation lifts off the sea (bottom opacity → 0).
      p.strength = strength * (0.35 + 0.65 * Math.max(base.opacity, 0.2));
      p.rate = o.columnRate ?? 5000;
      p.speedMin = 8;
      p.speedMax = 18;
      col.set(p);
      this.activeColumns++;
    }
    const spray = this.spray?.system;
    if (spray) {
      const e = spray.emitter;
      const spout = strongest >= 0 ? spouts[strongest] : undefined;
      if (spout) {
        const base = waterspoutFunnelAt(spout, 0, t, this.sample);
        e.position.x = spout.x + base.dx;
        e.position.y = sea + 1;
        e.position.z = spout.z + base.dz;
        e.jitter.x = e.jitter.z = Math.max(8, spout.baseRadius * 2.5);
        // The spray ring lives while the vortex touches the sea (forming and mature stages).
        e.rate = 1200 * strongestValue * (base.opacity > 0.05 ? 1 : 0.15);
      } else {
        e.rate = 0;
      }
    }
  }
}
