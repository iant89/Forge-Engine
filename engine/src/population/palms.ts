/**
 * Palm trees with wind sway (fe-33): procedural trunk + arching fronds built from a short entity
 * chain, bent every frame by a wind callback.
 *
 * Each palm is a root entity at its base and `trunkSegments` child-chained trunk segments; the
 * crown (fronds + coconuts) is parented to the top segment, so bending the chain carries the crown
 * with it. Bending is the reusable part: {@link palmBendAngle} maps a wind speed to the total
 * downwind lean (stiff at a breeze, ~60° at Cat 5), distributed toward the top of the trunk
 * ({@link palmSegmentWeights}), plus a gust oscillation at each tree's own frequency and a frond
 * flutter that grows with the wind. The wind comes from any `(x, z) → vector` callback, so a
 * `CycloneSystem`, a `WeatherSystem` or a constant can drive the grove.
 *
 * Meshes and materials are owned by the grove and released in `onDetach`.
 */

import { SceneObject, type Scene } from "../scene/scene.js";
import type { SystemContext } from "../scene/systems.js";
import { Renderable } from "../scene/components/index.js";
import type { Entity } from "../scene/world.js";
import type { GraphicsDevice } from "../gpu/device.js";
import { Geometry, type GeometrySource } from "../rendering/geometry.js";
import { Material } from "../rendering/material.js";
import { cylinderGeometrySource, sphereGeometrySource } from "../rendering/primitives.js";
import { Quat } from "../math/mat.js";
import { Vec3 } from "../math/vec.js";
import { clamp } from "../math/scalar.js";

export interface PalmSite {
  x: number;
  y: number;
  z: number;
  /** Trunk height in metres. Default 9. */
  height?: number;
  /** 0..1 variation seed (phase, frequency, lean, yaw). */
  random?: number;
}

export interface PalmWind {
  x: number;
  z: number;
}

export interface PalmGroveOptions {
  name?: string;
  gpu: GraphicsDevice;
  sites: readonly PalmSite[];
  /** Wind (m/s) at a world XZ; written into `out`. */
  wind: (x: number, z: number, out: PalmWind) => void;
  /** Trunk segments (tier knob). Default 6. */
  trunkSegments?: number;
  /** Fronds per crown (tier knob). Default 9. */
  fronds?: number;
  /** Lean (radians) at Cat 5-ish winds. Default 1.05. */
  maxBend?: number;
  trunkColor?: number;
  frondColor?: number;
}

/** Total downwind lean (radians) for a wind speed: quadratic drag, saturating at `maxBend`. */
export function palmBendAngle(windSpeed: number, maxBend = 1.05): number {
  const v = Math.max(0, windSpeed);
  const drag = (v * v) / (v * v + 45 * 45);
  return maxBend * drag;
}

/** Fraction of the bend each segment takes (bottom → top), summing to 1, weighted to the top. */
export function palmSegmentWeights(segments: number): number[] {
  const n = Math.max(1, Math.floor(segments));
  const raw: number[] = [];
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const w = (i + 1) * (i + 1);
    raw.push(w);
    sum += w;
  }
  return raw.map((w) => w / sum);
}

/** An arching, tapered, two-sided frond strip along +Z from the origin. */
export function palmFrondSource(length = 4.2, width = 1.1, segments = 8): GeometrySource {
  const n = Math.max(2, segments);
  const verts = (n + 1) * 3;
  const positions = new Float32Array(verts * 3 * 2);
  const normals = new Float32Array(verts * 3 * 2);
  const uvs = new Float32Array(verts * 2 * 2);
  const idx: number[] = [];
  for (let side = 0; side < 2; side++) {
    const base = side * verts;
    for (let i = 0; i <= n; i++) {
      const u = i / n;
      const z = u * length;
      const y = length * (0.35 * u - 0.75 * u * u);
      const w = width * Math.pow(Math.sin(Math.PI * Math.min(1, u * 1.08 + 0.02)), 0.8) * 0.5;
      // Centre rib slightly raised: a V-shaped leaf catches the light better than a flat card.
      const pts: [number, number][] = [[-w, y - w * 0.25], [0, y], [w, y - w * 0.25]];
      for (let j = 0; j < 3; j++) {
        const v = base + i * 3 + j;
        positions[v * 3] = pts[j]![0];
        positions[v * 3 + 1] = pts[j]![1];
        positions[v * 3 + 2] = z;
        normals[v * 3 + 1] = side === 0 ? 1 : -1;
        uvs[v * 2] = j / 2;
        uvs[v * 2 + 1] = u;
      }
    }
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < 2; j++) {
        const a = base + i * 3 + j;
        const b = a + 1;
        const c = a + 3;
        const d = c + 1;
        if (side === 0) idx.push(a, c, b, b, c, d);
        else idx.push(a, b, c, b, d, c);
      }
    }
  }
  return { positions, normals, uvs, indices: new Uint32Array(idx), label: "palm.frond" };
}

interface PalmRuntime {
  site: PalmSite;
  root: Entity;
  segments: Entity[];
  fronds: Entity[];
  frondYaw: number[];
  frondPitch: number[];
  phase: number;
  freq: number;
  lean: number;
  leanYaw: number;
}

const AXIS = new Vec3();
const Q = new Quat();
const Q2 = new Quat();
const Y_AXIS = new Vec3(0, 1, 0);
const X_AXIS = new Vec3(1, 0, 0);

export class PalmGrove extends SceneObject {
  readonly name: string;
  readonly options: PalmGroveOptions;
  private readonly palms: PalmRuntime[] = [];
  private readonly geometries: Geometry[] = [];
  private readonly materials: Material[] = [];
  private time = 0;
  private readonly windScratch: PalmWind = { x: 0, z: 0 };
  /** Mean wind speed seen by the grove last update (HUD/tests). */
  meanWind = 0;
  /** Mean applied bend (radians) last update. */
  meanBend = 0;

  constructor(options: PalmGroveOptions) {
    super();
    this.name = options.name ?? "palms";
    this.options = options;
  }

  get count(): number {
    return this.palms.length;
  }

  override onAttach(scene: Scene): void {
    const o = this.options;
    const segs = Math.max(2, Math.floor(o.trunkSegments ?? 6));
    const frondCount = Math.max(3, Math.floor(o.fronds ?? 9));
    const unit = cylinderGeometrySource({ radiusTop: 0.17, radiusBottom: 0.22, height: 1, radialSegments: 10, capped: false });
    // Pivot at the bottom of the segment.
    for (let i = 1; i < unit.positions.length; i += 3) unit.positions[i] = unit.positions[i]! + 0.5;
    unit.bounds = null;
    const trunkGeo = Geometry.create(o.gpu, { ...unit, label: "palm.trunk" });
    const frondGeo = Geometry.create(o.gpu, palmFrondSource());
    const nutGeo = Geometry.create(o.gpu, { ...sphereGeometrySource({ radius: 0.16, widthSegments: 10, heightSegments: 8 }), label: "palm.coconut" });
    this.geometries.push(trunkGeo, frondGeo, nutGeo);
    const trunkMat = new Material({ label: "palm.trunk", color: o.trunkColor ?? 0x7a6248, roughness: 0.9, metallic: 0 });
    const frondMat = new Material({ label: "palm.frond", color: o.frondColor ?? 0x3f7a2c, roughness: 0.7, metallic: 0 });
    const nutMat = new Material({ label: "palm.coconut", color: 0x5a4024, roughness: 0.6, metallic: 0 });
    this.materials.push(trunkMat, frondMat, nutMat);
    const attach = (e: Entity, geometry: Geometry, material: Material): void => {
      const r = new Renderable();
      r.geometry = geometry;
      r.material = material;
      r.castShadow = true;
      scene.world.addComponent(e.id, r);
    };
    o.sites.forEach((site, index) => {
      const rnd = site.random ?? (index * 0.618) % 1;
      const height = site.height ?? 9;
      const segLen = height / segs;
      const root = scene.createTransformedEntity(`${this.name}-${index}`, new Vec3(site.x, site.y - 0.2, site.z));
      // Unscaled joints carry the bend (no shear under rotation); each joint's mesh child carries
      // the segment's taper/length scale.
      const segments: Entity[] = [];
      let parent = root;
      for (let s = 0; s < segs; s++) {
        const joint = scene.createTransformedEntity(`${this.name}-${index}-joint${s}`, new Vec3(0, s === 0 ? 0 : segLen, 0));
        joint.parent = parent;
        const mesh = scene.createTransformedEntity(`${this.name}-${index}-trunk${s}`, new Vec3(0, 0, 0));
        mesh.parent = joint;
        const taper = 1 - (s / segs) * 0.35;
        mesh.transform.scale = new Vec3(taper, segLen * 1.02, taper);
        attach(mesh, trunkGeo, trunkMat);
        segments.push(joint);
        parent = joint;
      }
      const crown = scene.createTransformedEntity(`${this.name}-${index}-crown`, new Vec3(0, segLen, 0));
      crown.parent = parent;
      const fronds: Entity[] = [];
      const frondYaw: number[] = [];
      const frondPitch: number[] = [];
      for (let f = 0; f < frondCount; f++) {
        const e = scene.createTransformedEntity(`${this.name}-${index}-frond${f}`, new Vec3(0, 0, 0));
        e.parent = crown;
        attach(e, frondGeo, frondMat);
        fronds.push(e);
        frondYaw.push((f / frondCount) * Math.PI * 2 + rnd * 1.3);
        frondPitch.push(-0.15 + ((f * 7) % 5) * 0.08);
      }
      for (let c = 0; c < 3; c++) {
        const a = (c / 3) * Math.PI * 2 + rnd;
        const e = scene.createTransformedEntity(`${this.name}-${index}-nut${c}`, new Vec3(Math.cos(a) * 0.22, -0.25, Math.sin(a) * 0.22));
        e.parent = crown;
        attach(e, nutGeo, nutMat);
      }
      this.palms.push({
        site,
        root,
        segments,
        fronds,
        frondYaw,
        frondPitch,
        phase: rnd * Math.PI * 2,
        freq: 0.35 + rnd * 0.25,
        lean: 0.05 + rnd * 0.12,
        leanYaw: rnd * Math.PI * 2,
      });
    });
    this.pose(0);
  }

  override onDetach(scene: Scene): void {
    for (const p of this.palms) {
      const destroy = (e: Entity): void => {
        for (const c of e.children) destroy(c);
        scene.world.destroyEntity(e.id);
      };
      destroy(p.root);
    }
    this.palms.length = 0;
    for (const g of this.geometries) g.dispose();
    for (const m of this.materials) m.dispose();
    this.geometries.length = 0;
    this.materials.length = 0;
  }

  override update(context: SystemContext): void {
    const dt = context.fixedSteps * context.fixedDt;
    this.time += dt;
    this.pose(this.time);
  }

  /** Pose every palm for the current wind at simulated time `t`. */
  pose(t: number): void {
    const o = this.options;
    const maxBend = o.maxBend ?? 1.05;
    let windSum = 0;
    let bendSum = 0;
    for (const p of this.palms) {
      o.wind(p.site.x, p.site.z, this.windScratch);
      const wx = this.windScratch.x;
      const wz = this.windScratch.z;
      const speed = Math.hypot(wx, wz);
      windSum += speed;
      const strength = clamp(speed / 60, 0, 1);
      // Gusting: the tree rocks around its mean lean; more amplitude (and faster) in strong wind.
      const gust = Math.sin(t * (p.freq * (1 + strength)) * Math.PI * 2 + p.phase) * (0.04 + 0.12 * strength) + Math.sin(t * 2.7 + p.phase * 1.7) * 0.03 * strength;
      const bend = palmBendAngle(speed, maxBend) * (1 + gust);
      bendSum += bend;
      // Axis ⟂ to the wind so +Y tips downwind; the tree's own natural lean is added on top.
      const len = speed > 1e-3 ? speed : 1;
      const dirX = speed > 1e-3 ? wx / len : Math.cos(p.leanYaw);
      const dirZ = speed > 1e-3 ? wz / len : Math.sin(p.leanYaw);
      const weights = palmSegmentWeights(p.segments.length);
      for (let s = 0; s < p.segments.length; s++) {
        const w = weights[s]!;
        AXIS.set(dirZ, 0, -dirX);
        Q.setAxisAngle(AXIS, bend * w);
        if (s === 0) {
          AXIS.set(Math.sin(p.leanYaw), 0, -Math.cos(p.leanYaw));
          Q2.setAxisAngle(AXIS, p.lean);
          Quat.multiplyInto(Q, Q2, Q);
        }
        p.segments[s]!.transform.rotation = Q;
      }
      // Fronds: each points along its yaw, droops more and flutters harder as the wind builds;
      // fronds facing upwind get folded over by the wind.
      for (let f = 0; f < p.fronds.length; f++) {
        const yaw = p.frondYaw[f]!;
        const facing = Math.cos(yaw) * dirX + Math.sin(yaw) * dirZ; // +1 downwind
        const flutter = Math.sin(t * (3 + strength * 9) + p.phase + f * 1.3) * (0.05 + 0.3 * strength);
        const pitch = p.frondPitch[f]! + strength * (0.6 - 0.5 * facing) + flutter;
        // Local +Z → yaw direction: rotation about Y by (π/2 − yaw) maps +Z onto (cos yaw, sin yaw).
        Q.setAxisAngle(Y_AXIS, Math.PI / 2 - yaw);
        Q2.setAxisAngle(X_AXIS, pitch);
        Quat.multiplyInto(Q, Q2, Q);
        p.fronds[f]!.transform.rotation = Q;
      }
    }
    this.meanWind = this.palms.length ? windSum / this.palms.length : 0;
    this.meanBend = this.palms.length ? bendSum / this.palms.length : 0;
  }

  override stats(): Record<string, number | string | boolean> {
    return { palms: this.palms.length, wind: Math.round(this.meanWind * 10) / 10, bend: Math.round(this.meanBend * 100) / 100 };
  }
}
