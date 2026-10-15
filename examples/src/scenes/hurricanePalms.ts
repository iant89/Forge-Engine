/**
 * Hurricane demo palms (fe-33): the palm model (segmented trunk + arching fronds + coconuts), its
 * placement on the back beach, and its posing. Demo code by design — the engine only supplies the
 * generic wind-response hook (`windSway`, `windBendWeights`) that this grove calls every frame
 * with the cyclone's own wind at each tree.
 */

import {
  Geometry,
  Material,
  Quat,
  Renderable,
  SceneObject,
  Vec3,
  coastalHeightAt,
  createWindSwayPose,
  shoreCurveOffset,
  cylinderGeometrySource,
  sphereGeometrySource,
  windBendWeights,
  windSway,
  type CoastalTerrainParams,
  type Entity,
  type GeometrySource,
  type GraphicsDevice,
  type Scene,
  type SystemContext,
} from "@forge/engine";

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
  weights: number[];
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
const SWAY = createWindSwayPose();

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
        weights: windBendWeights(segments.length),
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

  /** Pose every palm for the current wind at simulated time `t` (engine `windSway` hook). */
  pose(t: number): void {
    const o = this.options;
    let windSum = 0;
    let bendSum = 0;
    for (const p of this.palms) {
      o.wind(p.site.x, p.site.z, this.windScratch);
      const sway = windSway(this.windScratch.x, this.windScratch.z, t, { maxBend: o.maxBend ?? 1.05, frequency: p.freq, phase: p.phase }, SWAY);
      windSum += Math.hypot(this.windScratch.x, this.windScratch.z);
      bendSum += sway.bend;
      const weights = p.weights;
      for (let s = 0; s < p.segments.length; s++) {
        AXIS.set(sway.axisX, 0, sway.axisZ);
        Q.setAxisAngle(AXIS, sway.bend * weights[s]!);
        if (s === 0) {
          // The tree's own natural lean, under the wind's.
          AXIS.set(Math.sin(p.leanYaw), 0, -Math.cos(p.leanYaw));
          Q2.setAxisAngle(AXIS, p.lean);
          Quat.multiplyInto(Q, Q2, Q);
        }
        p.segments[s]!.transform.rotation = Q;
      }
      // Fronds point along their yaw, droop and flutter harder as the wind builds; upwind fronds fold over.
      for (let f = 0; f < p.fronds.length; f++) {
        const yaw = p.frondYaw[f]!;
        const facing = Math.cos(yaw) * sway.downwindX + Math.sin(yaw) * sway.downwindZ;
        const flutter = sway.flutter * Math.cos(f * 1.3 + p.phase);
        const pitch = p.frondPitch[f]! + sway.strength * (0.6 - 0.5 * facing) + flutter;
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

function hash1(n: number, seed: number): number {
  const v = Math.sin(n * 127.1 + seed * 311.7) * 43758.5453123;
  return v - Math.floor(v);
}

/**
 * Deterministic palm sites on the back beach: `count` trees between `minAlong` and `maxAlong`
 * metres inland, spread over `width` metres of coast (uses the engine's coastal coordinates).
 */
export function palmSites(coast: CoastalTerrainParams, count: number, width: number, minAlong: number, maxAlong: number, seed = 5): PalmSite[] {
  const len = Math.hypot(coast.directionX, coast.directionZ) || 1;
  const dx = coast.directionX / len;
  const dz = coast.directionZ / len;
  const out: PalmSite[] = [];
  for (let i = 0; i < count; i++) {
    const c = ((i + hash1(i * 3 + 2, seed) * 0.8) / Math.max(1, count) - 0.5) * width;
    // fe-34: measured from the curvy waterline, so the grove follows bays and points.
    const a = minAlong + (maxAlong - minAlong) * hash1(i * 3 + 1, seed) + shoreCurveOffset(coast, c);
    const x = coast.originX + dx * a - dz * c;
    const z = coast.originZ + dz * a + dx * c;
    const random = hash1(i * 3 + 3, seed);
    out.push({ x, y: coastalHeightAt(coast, x, z), z, random, height: 7.5 + random * 4 });
  }
  return out;
}
