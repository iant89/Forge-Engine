/**
 * fe-34 v2: LightningBoltVisual — draws a {@link LightningSystem}'s live bolts as real geometry.
 *
 * The system's own bolt lines are 1-px debug lines: fine up close, invisible a kilometre out in a
 * storm. This visual renders each bolt segment (main channel + branches) as an emissive, fog-exempt
 * cylinder whose radius is chosen per segment so it covers `corePixels` on screen at its distance,
 * plus a wider transparent glow sheath (`glowPixels`). Brightness follows the strike's flash envelope.
 * Pooled: `maxSegments` entities are allocated once; nothing is created per strike.
 *
 * Reusable: any scene with a `LightningSystem` adds one and passes a viewer callback.
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
import { type LightningSystem, flashEnvelope } from "../environment/lightning.js";

export interface LightningBoltVisualOptions {
  name?: string;
  gpu: GraphicsDevice;
  lightning: LightningSystem;
  /** Viewer (camera) position, render-local. */
  viewer: () => { x: number; y: number; z: number };
  /** Main-channel core width in screen pixels. Default 5. Branches get half. */
  corePixels?: number;
  /** Glow sheath width in pixels (total). Default 16; 0 = no glow. */
  glowPixels?: number;
  /** Angle one pixel subtends (rad). Default (π/3)/720. */
  pixelAngle?: number;
  /** Core colour (sRGB hex) and peak emissive strength. Defaults 0xf2f4ff / 60. */
  color?: number;
  strength?: number;
  /** Glow colour (sRGB hex) and peak opacity. Defaults 0x9fb2ff / 0.35. */
  glowColor?: number;
  glowOpacity?: number;
  /** Pool size (segments per layer). Default 512. */
  maxSegments?: number;
}

/**
 * Radius (m) that makes a cylinder at `distance` cover `pixels` on screen.
 * Pure — exported for tests.
 */
export function lightningSegmentRadius(distance: number, pixels: number, pixelAngle = Math.PI / 3 / 720): number {
  return Math.max(0, distance) * pixelAngle * pixels * 0.5;
}

interface Layer {
  material: Material;
  entities: Entity[];
  renderables: Renderable[];
}

export class LightningBoltVisual extends SceneObject {
  readonly name: string;
  readonly options: LightningBoltVisualOptions;
  /** Segments drawn last frame (tests/HUD). */
  drawnSegments = 0;
  private geometry: Geometry | null = null;
  private core: Layer | null = null;
  private glow: Layer | null = null;
  private readonly dir = new Vec3();
  private readonly rot = new Quat();

  constructor(options: LightningBoltVisualOptions) {
    super();
    this.name = options.name ?? "lightning-visual";
    this.options = options;
  }

  override onAttach(scene: Scene): void {
    const o = this.options;
    const unit = cylinderGeometrySource({ radiusTop: 1, radiusBottom: 1, height: 1, radialSegments: 6, heightSegments: 1, capped: false });
    const p = unit.positions;
    for (let i = 1; i < p.length; i += 3) p[i] = p[i]! + 0.5; // pivot at the bottom
    unit.bounds = null;
    this.geometry = Geometry.create(o.gpu, { ...unit, label: "lightning.segment" });
    const n = Math.max(16, Math.floor(o.maxSegments ?? 512));
    const make = (label: string, material: Material): Layer => {
      const layer: Layer = { material, entities: [], renderables: [] };
      for (let i = 0; i < n; i++) {
        const e = scene.createTransformedEntity(`${this.name}-${label}-${i}`, new Vec3(0, -1000, 0));
        const r = new Renderable();
        r.geometry = this.geometry;
        r.material = material;
        r.castShadow = false;
        r.visible = false;
        scene.world.addComponent(e.id, r);
        layer.entities.push(e);
        layer.renderables.push(r);
      }
      return layer;
    };
    this.core = make(
      "core",
      new Material({ label: `${this.name}.core`, technique: "emissive", color: o.color ?? 0xf2f4ff, emissive: o.color ?? 0xf2f4ff, emissiveStrength: 0, fogExempt: true, doubleSided: true }),
    );
    if ((o.glowPixels ?? 16) > 0) {
      this.glow = make(
        "glow",
        new Material({ label: `${this.name}.glow`, technique: "emissive", color: o.glowColor ?? 0x9fb2ff, emissive: o.glowColor ?? 0x9fb2ff, emissiveStrength: 0, transparent: true, opacity: 0, depthWrite: false, fogExempt: true, doubleSided: true }),
      );
    }
  }

  override onDetach(scene: Scene): void {
    for (const layer of [this.core, this.glow]) {
      if (!layer) continue;
      for (const e of layer.entities) scene.destroyEntity(e);
    }
    this.core = this.glow = null;
    this.geometry?.dispose();
    this.geometry = null;
  }

  override update(_context: SystemContext): void {
    const core = this.core;
    if (!core) return;
    const o = this.options;
    const l = o.lightning;
    const v = o.viewer();
    const pa = o.pixelAngle ?? Math.PI / 3 / 720;
    const corePx = o.corePixels ?? 5;
    const glowPx = o.glowPixels ?? 16;
    let used = 0;
    let peak = 0;
    for (const s of l.strikes) {
      if (s.bolt.cloudOnly) continue;
      const f = s.energy * flashEnvelope(s.age, l.envelope);
      if (f <= 0.02) continue;
      peak = Math.max(peak, f);
      const lines = [s.bolt.points, ...s.bolt.branches];
      for (let b = 0; b < lines.length; b++) {
        const pts = lines[b]!;
        const scale = b === 0 ? 1 : 0.5;
        for (let i = 1; i < pts.length && used < core.entities.length; i++, used++) {
          const a = pts[i - 1]!;
          const c = pts[i]!;
          this.dir.set(c.x - a.x, c.y - a.y, c.z - a.z);
          const len = this.dir.length();
          if (len < 1e-4) {
            used--;
            continue;
          }
          this.dir.scale(1 / len);
          this.rot.fromUnitVectorY(this.dir);
          const d = Math.hypot((a.x + c.x) * 0.5 - v.x, (a.y + c.y) * 0.5 - v.y, (a.z + c.z) * 0.5 - v.z);
          const rc = lightningSegmentRadius(d, corePx * scale, pa);
          this.place(core, used, a, rc, len);
          if (this.glow) this.place(this.glow, used, a, lightningSegmentRadius(d, glowPx * scale, pa), len);
        }
      }
    }
    for (const layer of [core, this.glow]) {
      if (!layer) continue;
      for (let i = used; i < layer.renderables.length; i++) layer.renderables[i]!.visible = false;
    }
    core.material.emissiveStrength = (o.strength ?? 60) * Math.min(1.5, peak);
    if (this.glow) {
      this.glow.material.emissiveStrength = (o.strength ?? 60) * 0.25 * Math.min(1.5, peak);
      this.glow.material.opacity = (o.glowOpacity ?? 0.35) * Math.min(1, peak);
    }
    this.drawnSegments = used;
  }

  private place(layer: Layer, i: number, a: { x: number; y: number; z: number }, radius: number, len: number): void {
    const e = layer.entities[i]!;
    e.transform.position = new Vec3(a.x, a.y, a.z);
    e.transform.rotation = this.rot.clone();
    e.transform.scale = new Vec3(radius, len * 1.02, radius);
    layer.renderables[i]!.visible = true;
  }
}
