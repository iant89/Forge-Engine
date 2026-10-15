/**
 * Waterspout visual (fe-34): renders a {@link WaterspoutSystem}'s spouts as twisting translucent
 * funnels (a stack of lumpy tapered segments following `waterspoutFunnelAt`, each spun by the
 * spout's rotation so the condensation bands visibly twist) plus a spray ring (a GPU particle
 * field thrown up and out around the base of the strongest spout).
 *
 * Kept apart from the simulation (`environment/waterspout.ts`) so headless hosts and tests can run
 * spouts without a device. Slots are preallocated (`maxActive × segments` entities) and hidden when
 * unused, so nothing is created or destroyed per frame.
 */

import { SceneObject, type Scene } from "../scene/scene.js";
import type { SystemContext } from "../scene/systems.js";
import { Renderable } from "../scene/components/index.js";
import type { Entity } from "../scene/world.js";
import { Geometry } from "../rendering/geometry.js";
import type { GraphicsDevice } from "../gpu/device.js";
import { Material } from "../rendering/material.js";
import { cylinderGeometrySource } from "../rendering/primitives.js";
import { Quat, Vec3 } from "../math/index.js";
import { GpuParticleWorld } from "./gpuWorld.js";
import { type WaterspoutSystem, type WaterspoutFunnelSample, waterspoutFunnelAt, waterspoutStrength } from "../environment/waterspout.js";

export interface WaterspoutVisualOptions {
  name?: string;
  gpu: GraphicsDevice;
  spouts: WaterspoutSystem;
  /** Sea surface height under the spouts. */
  seaLevel: () => number;
  /** Cloud base height (the funnel's top). */
  cloudBase: () => number;
  /** Funnel segments (tier knob). Default 14. */
  segments?: number;
  /** Spray particles (tier knob). Default 3072; 0 disables the spray ring. */
  sprayCapacity?: number;
  /** Funnel colour (sRGB hex). Default a rain-grey 0x8a9098. */
  color?: number;
  /** Peak funnel opacity. Default 0.72. */
  opacity?: number;
  /**
   * fe-34 v2: skip distance fog. Dense storm fog washes a spout a kilometre out into the horizon
   * haze; true keeps the funnel readable. Default false.
   */
  fogExempt?: boolean;
}

interface Slot {
  entities: Entity[];
  renderables: Renderable[];
  material: Material;
}

const UP = new Vec3(0, 1, 0);

export class WaterspoutVisual extends SceneObject {
  readonly name: string;
  readonly options: WaterspoutVisualOptions;
  private readonly slots: Slot[] = [];
  private geometry: Geometry | null = null;
  private spray: GpuParticleWorld | null = null;
  private readonly sample: WaterspoutFunnelSample = { dx: 0, dz: 0, radius: 0, opacity: 0 };
  private readonly next: WaterspoutFunnelSample = { dx: 0, dz: 0, radius: 0, opacity: 0 };
  private readonly dir = new Vec3();
  private readonly tilt = new Quat();
  private readonly spin = new Quat();
  /** Segments drawn last frame (tests/HUD). */
  drawnSegments = 0;

  constructor(options: WaterspoutVisualOptions) {
    super();
    this.name = options.name ?? "waterspout-visual";
    this.options = options;
  }

  override onAttach(scene: Scene): void {
    const o = this.options;
    const segs = Math.max(4, Math.floor(o.segments ?? 14));
    // A unit segment (pivot at the bottom) with a lumpy rim so the spin reads as twisting bands.
    const unit = cylinderGeometrySource({ radiusTop: 1, radiusBottom: 1, height: 1, radialSegments: 9, heightSegments: 2, capped: false });
    const p = unit.positions;
    for (let i = 0; i < p.length; i += 3) {
      const a = Math.atan2(p[i + 2]!, p[i]!);
      const y = p[i + 1]! + 0.5;
      const lump = 1 + 0.18 * Math.sin(a * 3 + y * 4.0);
      p[i] = p[i]! * lump;
      p[i + 2] = p[i + 2]! * lump;
      p[i + 1] = y;
    }
    unit.bounds = null;
    this.geometry = Geometry.create(o.gpu, { ...unit, label: "waterspout.segment" });
    const maxActive = o.spouts.options.maxActive ?? 2;
    for (let k = 0; k < maxActive; k++) {
      const material = new Material({ label: `waterspout.${k}`, color: o.color ?? 0x8a9098, roughness: 1, metallic: 0, transparent: true, opacity: 0, fogExempt: o.fogExempt ?? false });
      const slot: Slot = { entities: [], renderables: [], material };
      for (let s = 0; s < segs; s++) {
        const e = scene.createTransformedEntity(`${this.name}-${k}-${s}`, new Vec3(0, -1000, 0));
        const r = new Renderable();
        r.geometry = this.geometry;
        r.material = material;
        r.castShadow = false;
        r.visible = false;
        scene.world.addComponent(e.id, r);
        slot.entities.push(e);
        slot.renderables.push(r);
      }
      this.slots.push(slot);
    }
    if ((o.sprayCapacity ?? 3072) > 0) {
      this.spray = new GpuParticleWorld({
        name: `${this.name}-spray`,
        capacity: o.sprayCapacity ?? 3072,
        seed: 515,
        maxEmitsPerFrame: 512,
        softParticles: true,
        softScale: 8,
        stretch: 1.4,
        cullDistance: 4000,
        emitter: {
          rate: 0,
          lifeMin: 1.2,
          lifeMax: 2.6,
          size: 1.2,
          position: { x: 0, y: 0, z: 0 },
          jitter: { x: 20, y: 1, z: 20 },
          coneDir: { x: 0, y: 1, z: 0 },
          coneAngle: 1.2,
          speedMin: 6,
          speedMax: 14,
          color: { r: 0.85, g: 0.88, b: 0.9, a: 0.6 },
        },
        modules: {
          gravity: { x: 0, y: -3, z: 0 },
          drag: 0.4,
          turbulence: 3,
          noiseScale: 0.05,
          colorFrom: { r: 0.85, g: 0.88, b: 0.9, a: 0.6 },
          colorTo: { r: 0.8, g: 0.83, b: 0.86, a: 0 },
          sizeStart: 1.2,
          sizeEnd: 7,
          rotationSpeed: 0.5,
        },
      });
      scene.add(this.spray);
    }
  }

  override onDetach(scene: Scene): void {
    for (const slot of this.slots) for (const e of slot.entities) scene.destroyEntity(e);
    this.slots.length = 0;
    this.geometry?.dispose();
    this.geometry = null;
  }

  override update(_context: SystemContext): void {
    const o = this.options;
    const spouts = o.spouts.spouts;
    const sea = o.seaLevel();
    const top = Math.max(sea + 50, o.cloudBase());
    const height = top - sea;
    const peak = o.opacity ?? 0.72;
    let strongest = -1;
    let strongestValue = 0;
    this.drawnSegments = 0;
    for (let k = 0; k < this.slots.length; k++) {
      const slot = this.slots[k]!;
      const spout = spouts[k];
      if (!spout) {
        for (const r of slot.renderables) r.visible = false;
        continue;
      }
      const strength = waterspoutStrength(spout.age, spout.life);
      if (strength > strongestValue) {
        strongestValue = strength;
        strongest = k;
      }
      slot.material.opacity = peak * (0.35 + 0.65 * strength);
      const n = slot.entities.length;
      const t = o.spouts.time;
      for (let s = 0; s < n; s++) {
        const h0 = s / n;
        const h1 = (s + 1) / n;
        const a = waterspoutFunnelAt(spout, h0, t, this.sample);
        const b = waterspoutFunnelAt(spout, h1, t, this.next);
        // A segment shows if either end has condensation (the bottom ring has opacity 0 at the sea
        // surface itself, which used to leave the funnel floating one segment above the water).
        const visible = Math.max(a.opacity, b.opacity) > 0.05 && a.radius > 0.2;
        slot.renderables[s]!.visible = visible;
        if (!visible) continue;
        this.drawnSegments++;
        const e = slot.entities[s]!;
        const x0 = spout.x + a.dx;
        const z0 = spout.z + a.dz;
        const y0 = sea + h0 * height;
        this.dir.set(spout.x + b.dx - x0, height / n, spout.z + b.dz - z0);
        const len = this.dir.length();
        this.dir.normalize();
        this.tilt.fromUnitVectorY(this.dir);
        // Upper segments spin slower than the tight rope at the sea (the twist).
        this.spin.setAxisAngle(UP, spout.angle * (1.6 - h0));
        e.transform.position = new Vec3(x0, y0, z0);
        e.transform.rotation = this.tilt.clone().multiply(this.spin);
        const r = Math.max(0.2, a.radius) * (0.75 + 0.25 * a.opacity);
        e.transform.scale = new Vec3(r, len * 1.04, r);
      }
    }
    const spray = this.spray?.system;
    if (spray) {
      const e = spray.emitter;
      const spout = strongest >= 0 ? spouts[strongest] : undefined;
      if (spout) {
        const base = waterspoutFunnelAt(spout, 0, o.spouts.time, this.sample);
        e.position.x = spout.x + base.dx;
        e.position.y = sea + 1;
        e.position.z = spout.z + base.dz;
        e.jitter.x = e.jitter.z = Math.max(6, spout.baseRadius * 2.5);
        // The spray ring lives while the vortex touches the sea (forming and mature stages).
        e.rate = 900 * strongestValue * (base.opacity > 0.05 ? 1 : 0.15);
      } else {
        e.rate = 0;
      }
    }
  }
}
