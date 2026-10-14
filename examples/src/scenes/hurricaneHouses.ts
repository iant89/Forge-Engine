/**
 * Hurricane demo beach houses (fe-34): simple stilt houses behind the dunes — box body on pilings,
 * a pitched roof (two tilted slabs), a porch deck and dark windows. Demo code by design (the engine
 * ships no buildings); placed with the engine's `coastalHeightAt` / `coastalCoordinates`.
 */

import {
  Geometry,
  Material,
  Quat,
  Renderable,
  SceneObject,
  Vec3,
  boxGeometrySource,
  coastalHeightAt,
  cylinderGeometrySource,
  shoreCurveOffset,
  type CoastalTerrainParams,
  type GraphicsDevice,
  type Scene,
} from "@forge/engine";

export interface HouseSite {
  x: number;
  y: number;
  z: number;
  /** Yaw (rad): the house faces the sea. */
  yaw: number;
  width: number;
  depth: number;
  /** Body colour (sRGB hex). */
  color: number;
}

function hash1(n: number, seed: number): number {
  const s = Math.sin(n * 91.345 + seed * 47.853) * 43758.5453;
  return s - Math.floor(s);
}

const PASTELS = [0xe8d6b0, 0xa9c8d8, 0xe6b8a2, 0xc9d9b4, 0xf0e4d0, 0xb7c4e0];

/** `count` house sites in a row `along` metres inland of the (curvy) waterline, spread over `width`. */
export function houseSites(coast: CoastalTerrainParams, count: number, width: number, along: number, seed = 11): HouseSite[] {
  const len = Math.hypot(coast.directionX, coast.directionZ) || 1;
  const dx = coast.directionX / len;
  const dz = coast.directionZ / len;
  const out: HouseSite[] = [];
  for (let i = 0; i < count; i++) {
    const c = ((i + 0.5 + (hash1(i, seed) - 0.5) * 0.4) / count - 0.5) * width;
    const a = along + shoreCurveOffset(coast, c) + (hash1(i + 40, seed) - 0.5) * 14;
    const x = coast.originX + dx * a - dz * c;
    const z = coast.originZ + dz * a + dx * c;
    // Ground under the footprint: the highest corner so pilings never float.
    let y = -Infinity;
    for (const [ox, oz] of [[-5, -5], [5, -5], [-5, 5], [5, 5], [0, 0]] as const) y = Math.max(y, coastalHeightAt(coast, x + ox, z + oz));
    out.push({ x, y, z, yaw: Math.atan2(-dx, -dz) + (hash1(i + 80, seed) - 0.5) * 0.25, width: 9 + hash1(i + 7, seed) * 4, depth: 8 + hash1(i + 9, seed) * 3, color: PASTELS[i % PASTELS.length]! });
  }
  return out;
}

export interface BeachHousesOptions {
  name?: string;
  gpu: GraphicsDevice;
  sites: readonly HouseSite[];
}

export class BeachHouses extends SceneObject {
  readonly name: string;
  private readonly options: BeachHousesOptions;
  private readonly owned: { dispose(): void }[] = [];

  constructor(options: BeachHousesOptions) {
    super();
    this.name = options.name ?? "houses";
    this.options = options;
  }

  get count(): number {
    return this.options.sites.length;
  }

  override onAttach(scene: Scene): void {
    const gpu = this.options.gpu;
    const box = Geometry.create(gpu, { ...boxGeometrySource({ width: 1, height: 1, depth: 1 }), label: "house.box" });
    const post = Geometry.create(gpu, { ...cylinderGeometrySource({ radiusTop: 0.14, radiusBottom: 0.14, height: 1, radialSegments: 6 }), label: "house.post" });
    const roofMat = new Material({ label: "house.roof", color: 0x4a4f57, roughness: 0.8, metallic: 0.1 });
    const trimMat = new Material({ label: "house.trim", color: 0xf4f1ea, roughness: 0.8, metallic: 0 });
    const glassMat = new Material({ label: "house.glass", color: 0x1c2630, roughness: 0.2, metallic: 0.2 });
    const woodMat = new Material({ label: "house.wood", color: 0x8b7355, roughness: 0.9, metallic: 0 });
    this.owned.push(box, post, roofMat, trimMat, glassMat, woodMat);
    const bodyMats = new Map<number, Material>();
    const part = (parent: { id: number } | null, name: string, geo: Geometry, mat: Material, pos: Vec3, scale: Vec3, rot?: Quat): void => {
      const e = scene.createTransformedEntity(name, pos);
      if (parent) (e as unknown as { parent: unknown }).parent = parent;
      e.transform.scale = scale;
      if (rot) e.transform.rotation = rot;
      const r = new Renderable();
      r.geometry = geo;
      r.material = mat;
      r.castShadow = true;
      scene.world.addComponent(e.id, r);
    };
    this.options.sites.forEach((s, i) => {
      let body = bodyMats.get(s.color);
      if (!body) {
        body = new Material({ label: `house.body.${s.color.toString(16)}`, color: s.color, roughness: 0.85, metallic: 0 });
        bodyMats.set(s.color, body);
        this.owned.push(body);
      }
      const root = scene.createTransformedEntity(`${this.name}-${i}`, new Vec3(s.x, s.y, s.z));
      root.transform.rotation = Quat.fromAxisAngle(new Vec3(0, 1, 0), s.yaw);
      const stilt = 2.4;
      const wallH = 3.2;
      const w = s.width;
      const d = s.depth;
      for (const [px, pz] of [[-w / 2 + 0.4, -d / 2 + 0.4], [w / 2 - 0.4, -d / 2 + 0.4], [-w / 2 + 0.4, d / 2 - 0.4], [w / 2 - 0.4, d / 2 - 0.4], [0, d / 2 + 2.2], [-w / 2 + 0.4, d / 2 + 2.2], [w / 2 - 0.4, d / 2 + 2.2]] as const) {
        part(root, `${this.name}-${i}-post`, post, woodMat, new Vec3(px, stilt / 2 - 0.5, pz), new Vec3(1, stilt + 1, 1));
      }
      part(root, `${this.name}-${i}-body`, box, body, new Vec3(0, stilt + wallH / 2, 0), new Vec3(w, wallH, d));
      // Porch deck facing the sea (+Z local) and its rail.
      part(root, `${this.name}-${i}-deck`, box, woodMat, new Vec3(0, stilt + 0.05, d / 2 + 1.25), new Vec3(w, 0.15, 2.5));
      part(root, `${this.name}-${i}-rail`, box, trimMat, new Vec3(0, stilt + 1.0, d / 2 + 2.45), new Vec3(w, 0.08, 0.08));
      // Windows + door on the sea side.
      for (let k = -1; k <= 1; k++) {
        part(root, `${this.name}-${i}-win${k}`, box, glassMat, new Vec3(k * w * 0.3, stilt + wallH * 0.55, d / 2 + 0.03), new Vec3(k === 0 ? 1.1 : 1.6, k === 0 ? 2.1 : 1.3, 0.08));
      }
      // Pitched roof: two slabs tilted about the ridge (local X axis), plus trim at the eaves.
      const pitch = 0.5;
      const half = d / 2 + 0.6;
      const slab = half / Math.cos(pitch);
      const ridgeY = stilt + wallH + Math.tan(pitch) * half * 0.5;
      for (const side of [-1, 1]) {
        part(
          root,
          `${this.name}-${i}-roof${side}`,
          box,
          roofMat,
          new Vec3(0, ridgeY, (side * half) / 2),
          new Vec3(w + 1.2, 0.22, slab),
          Quat.fromAxisAngle(new Vec3(1, 0, 0), side * pitch),
        );
      }
      // Gable ends (a squat box under the roof).
      part(root, `${this.name}-${i}-gable`, box, body, new Vec3(0, stilt + wallH + 0.55, 0), new Vec3(w * 0.98, 1.1, d * 0.55));
    });
  }

  override onDetach(): void {
    for (const o of this.owned) o.dispose();
    this.owned.length = 0;
  }
}
