/**
 * Persistent tyre tracks (fe-37c): a tiled mark map every wheel contact stamps into, drawn as
 * transparent decal tiles draped over the ground.
 *
 * - **Map**: world-space square tiles (`tileSize` m, `tileResolution`² texels) allocated on demand
 *   where wheels go. Tiles never fade (or fade very slowly with `fadeTime`); the count is capped by
 *   `maxTiles` and the least-recently-stamped tile is recycled — a ring buffer over the area driven.
 * - **Stamp**: {@link TireTrackMap.stamp} paints a capsule from the wheel's last contact to its new
 *   one, `width` wide. What it leaves depends on the surface: gravel compacts slightly darker, grass
 *   flattens dark green, mud cuts deep dark ruts that *hold water* (the MR alpha water mark, so the
 *   standard shader gives them the puddle film), snow packs down and shows darker ground. Depth
 *   (per surface, scaled by wheel load) sets the coverage and is queryable ({@link depthAt}).
 * - **Render**: {@link TireTrackLayer} (a SceneObject) owns one textured, transparent mesh per tile
 *   following `heightAt`, re-uploading dirty tiles at most every `uploadInterval` seconds.
 *
 * `TireTrackLayer.followVehicle(vehicle, surfaceAt)` is all a demo needs.
 */

import { clamp } from "../math/scalar.js";
import { Vec3 } from "../math/vec.js";
import type { GraphicsDevice } from "../gpu/device.js";
import { Texture } from "../resources/texture.js";
import { Geometry, computeNormalsAndTangents } from "../rendering/geometry.js";
import { Material } from "../rendering/material.js";
import { Renderable } from "../scene/components/index.js";
import { SceneObject, type Scene } from "../scene/scene.js";
import type { SystemContext } from "../scene/systems.js";

export type TireSurface = "gravel" | "grass" | "mud" | "snow";

export interface TireMarkStyle {
  /** Linear colour of the mark. */
  color: [number, number, number];
  /** Rut depth (m) for a full-load pass. */
  depth: number;
  /** Coverage alpha a full-depth rut reaches. */
  alpha: number;
  roughness: number;
  /** Ruts hold standing water (puddle film). */
  holdsWater: boolean;
}

/** Defaults: shallow compaction on gravel, flattened grass, deep wet mud ruts, packed snow. */
export const TIRE_MARK_STYLES: Readonly<Record<TireSurface, TireMarkStyle>> = Object.freeze({
  gravel: { color: [0.13, 0.11, 0.09], depth: 0.01, alpha: 0.32, roughness: 0.9, holdsWater: false },
  grass: { color: [0.06, 0.085, 0.03], depth: 0.02, alpha: 0.5, roughness: 0.8, holdsWater: false },
  mud: { color: [0.035, 0.026, 0.018], depth: 0.07, alpha: 0.85, roughness: 0.25, holdsWater: true },
  snow: { color: [0.2, 0.19, 0.18], depth: 0.08, alpha: 0.75, roughness: 0.7, holdsWater: false },
});

interface Tile {
  key: string;
  ix: number;
  iz: number;
  depth: Float32Array;
  albedo: Uint8Array;
  mr: Uint8Array;
  dirty: boolean;
  lastStamp: number;
}

export interface TireTrackMapOptions {
  tileSize?: number;
  tileResolution?: number;
  maxTiles?: number;
  /** Seconds for marks to fade by 1/e; 0 = never (default). */
  fadeTime?: number;
}

export class TireTrackMap {
  readonly tileSize: number;
  readonly res: number;
  readonly maxTiles: number;
  fadeTime: number;
  readonly tiles = new Map<string, Tile>();
  /** Tiles evicted to make room (diagnostics). */
  recycled = 0;
  private clock = 0;
  /** Called when a tile is created / recycled (the renderer binds its GPU side). */
  onTile: ((tile: Tile, created: boolean) => void) | null = null;
  onEvict: ((tile: Tile) => void) | null = null;

  constructor(options: TireTrackMapOptions = {}) {
    this.tileSize = options.tileSize ?? 32;
    this.res = options.tileResolution ?? 256;
    this.maxTiles = Math.max(1, options.maxTiles ?? 24);
    this.fadeTime = options.fadeTime ?? 0;
  }

  private tile(ix: number, iz: number, create: boolean): Tile | null {
    const key = `${ix},${iz}`;
    let t = this.tiles.get(key) ?? null;
    if (t || !create) return t;
    if (this.tiles.size >= this.maxTiles) {
      let oldest: Tile | null = null;
      for (const c of this.tiles.values()) if (!oldest || c.lastStamp < oldest.lastStamp) oldest = c;
      if (oldest) {
        this.tiles.delete(oldest.key);
        this.onEvict?.(oldest);
        this.recycled++;
      }
    }
    const n = this.res * this.res;
    t = { key, ix, iz, depth: new Float32Array(n), albedo: new Uint8Array(n * 4), mr: new Uint8Array(n * 4).fill(255), dirty: true, lastStamp: this.clock };
    for (let k = 0; k < n; k++) t.mr[k * 4 + 2] = 0;
    this.tiles.set(key, t);
    this.onTile?.(t, true);
    return t;
  }

  /** Rut depth (m) at a world point (0 where nothing has driven). */
  depthAt(x: number, z: number): number {
    const ix = Math.floor(x / this.tileSize), iz = Math.floor(z / this.tileSize);
    const t = this.tile(ix, iz, false);
    if (!t) return 0;
    const i = clamp(Math.floor(((x - ix * this.tileSize) / this.tileSize) * this.res), 0, this.res - 1);
    const j = clamp(Math.floor(((z - iz * this.tileSize) / this.tileSize) * this.res), 0, this.res - 1);
    return t.depth[j * this.res + i]!;
  }

  /**
   * Stamp a tyre segment from (x0, z0) to (x1, z1), `width` m wide, on `surface`. `load` (0..1+)
   * scales the depth (a heavier pass cuts deeper); repeated passes deepen up to 2× the style depth.
   */
  stamp(x0: number, z0: number, x1: number, z1: number, width: number, surface: TireSurface, load = 1, style: TireMarkStyle = TIRE_MARK_STYLES[surface]): void {
    this.clock++;
    const half = width / 2;
    const texel = this.tileSize / this.res;
    const minX = Math.min(x0, x1) - half, maxX = Math.max(x0, x1) + half;
    const minZ = Math.min(z0, z1) - half, maxZ = Math.max(z0, z1) + half;
    const dx = x1 - x0, dz = z1 - z0;
    const len2 = dx * dx + dz * dz;
    const add = style.depth * clamp(load, 0.2, 1.5) * 0.5;
    for (let iz = Math.floor(minZ / this.tileSize); iz <= Math.floor(maxZ / this.tileSize); iz++) {
      for (let ix = Math.floor(minX / this.tileSize); ix <= Math.floor(maxX / this.tileSize); ix++) {
        const t = this.tile(ix, iz, true)!;
        t.lastStamp = this.clock;
        const ox = ix * this.tileSize, oz = iz * this.tileSize;
        const i0 = clamp(Math.floor((minX - ox) / texel), 0, this.res - 1), i1 = clamp(Math.ceil((maxX - ox) / texel), 0, this.res - 1);
        const j0 = clamp(Math.floor((minZ - oz) / texel), 0, this.res - 1), j1 = clamp(Math.ceil((maxZ - oz) / texel), 0, this.res - 1);
        for (let j = j0; j <= j1; j++) {
          const pz = oz + (j + 0.5) * texel;
          for (let i = i0; i <= i1; i++) {
            const px = ox + (i + 0.5) * texel;
            let u = len2 > 1e-9 ? ((px - x0) * dx + (pz - z0) * dz) / len2 : 0;
            u = clamp(u, 0, 1);
            const d = Math.hypot(px - (x0 + dx * u), pz - (z0 + dz * u));
            if (d > half) continue;
            // Tread profile: full in the middle, soft shoulders; a faint lug pattern along it.
            const prof = 1 - (d / half) ** 4;
            const k = j * this.res + i;
            const nd = Math.min(style.depth * 2, t.depth[k]! + add * prof);
            if (nd <= t.depth[k]!) continue;
            t.depth[k] = nd;
            const cover = clamp((nd / style.depth) * style.alpha, 0, style.alpha) * (0.85 + 0.15 * Math.abs(Math.sin((px + pz) * 9)));
            const o = k * 4;
            const a0 = t.albedo[o + 3]! / 255;
            if (cover > a0) {
              t.albedo[o] = toSrgb8(style.color[0]);
              t.albedo[o + 1] = toSrgb8(style.color[1]);
              t.albedo[o + 2] = toSrgb8(style.color[2]);
              t.albedo[o + 3] = Math.round(cover * 255);
              t.mr[o + 1] = Math.round(style.roughness * 255);
              // Water mark (alpha < 1 = standing water) in the deep middle of mud ruts.
              t.mr[o + 3] = style.holdsWater && prof > 0.6 ? 70 : 255;
            }
          }
        }
        t.dirty = true;
      }
    }
  }

  /** Slow fade (when `fadeTime` > 0): call with elapsed seconds. */
  fade(dt: number): void {
    if (!(this.fadeTime > 0) || dt <= 0) return;
    const f = Math.exp(-dt / this.fadeTime);
    for (const t of this.tiles.values()) {
      for (let k = 0; k < t.depth.length; k++) {
        if (t.depth[k] === 0) continue;
        t.depth[k] *= f;
        t.albedo[k * 4 + 3] = Math.floor(t.albedo[k * 4 + 3]! * f);
      }
      t.dirty = true;
    }
  }
}

function toSrgb8(linear: number): number {
  const c = clamp(linear, 0, 1);
  return Math.round((c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055) * 255);
}

/** The minimal vehicle shape the layer follows (engine `Vehicle` fits). */
export interface TireTrackVehicle {
  wheels: ReadonlyArray<{ inContact: boolean; contactX: number; contactZ: number; normalLoad: number }>;
  config: { mass: number };
}

export interface TireTrackLayerOptions extends TireTrackMapOptions {
  heightAt: (x: number, z: number) => number;
  /** Mesh segments per tile side. Default 24. */
  segments?: number;
  /** Lift above the ground (m). Default 0.045. */
  lift?: number;
  uploadInterval?: number;
}

export class TireTrackLayer extends SceneObject {
  readonly name = "tireTracks";
  readonly map: TireTrackMap;
  private readonly gpu = new Map<string, { albedo: Texture; mr: Texture; material: Material; geometry: Geometry; entity: number }>();
  private readonly followers: Array<{ vehicle: TireTrackVehicle; surfaceAt: (x: number, z: number) => TireSurface; width: number; last: Array<{ x: number; z: number; on: boolean }> }> = [];
  private sinceUpload = 0;

  constructor(private readonly device: GraphicsDevice, private readonly options: TireTrackLayerOptions) {
    super();
    this.map = new TireTrackMap(options);
    this.map.onEvict = (t) => this.release(t.key);
  }

  /** Stamp this vehicle's wheel contacts every frame; `surfaceAt` picks the mark style. */
  followVehicle(vehicle: TireTrackVehicle, surfaceAt: (x: number, z: number) => TireSurface, tyreWidth = 0.26): void {
    this.followers.push({ vehicle, surfaceAt, width: tyreWidth, last: vehicle.wheels.map(() => ({ x: 0, z: 0, on: false })) });
  }

  get tileCount(): number {
    return this.map.tiles.size;
  }

  private release(key: string): void {
    const g = this.gpu.get(key);
    if (!g) return;
    this.scene?.destroyEntity({ id: g.entity });
    g.geometry.dispose();
    g.material.dispose();
    g.albedo.dispose();
    g.mr.dispose();
    this.gpu.delete(key);
  }

  private bind(scene: Scene, key: string): void {
    const t = this.map.tiles.get(key)!;
    const seg = this.options.segments ?? 24;
    const size = this.map.tileSize;
    const lift = this.options.lift ?? 0.045;
    const ox = t.ix * size, oz = t.iz * size;
    const n = seg + 1;
    const positions = new Float32Array(n * n * 3), uvs = new Float32Array(n * n * 2);
    for (let j = 0; j <= seg; j++) {
      for (let i = 0; i <= seg; i++) {
        const k = j * n + i;
        const x = ox + (i / seg) * size, z = oz + (j / seg) * size;
        positions[k * 3] = x;
        positions[k * 3 + 1] = this.options.heightAt(x, z) + lift;
        positions[k * 3 + 2] = z;
        uvs[k * 2] = i / seg;
        uvs[k * 2 + 1] = j / seg;
      }
    }
    const indices = new Uint32Array(seg * seg * 6);
    let o = 0;
    for (let j = 0; j < seg; j++) {
      for (let i = 0; i < seg; i++) {
        const a = j * n + i;
        indices.set([a, a + n, a + 1, a + 1, a + n, a + n + 1], o);
        o += 6;
      }
    }
    const { normals, tangents } = computeNormalsAndTangents(positions, indices, uvs);
    const geometry = Geometry.create(this.device, { positions, normals, uvs, tangents, indices, label: `tireTracks.${key}` });
    const r = this.map.res;
    const albedo = Texture.fromRgba8(this.device, r, r, t.albedo, { label: `tireTracks.${key}.albedo`, srgb: true, mipmaps: false });
    const mr = Texture.fromRgba8(this.device, r, r, t.mr, { label: `tireTracks.${key}.mr`, mipmaps: false });
    const material = new Material({ label: `tireTracks.${key}`, color: 0xffffff, roughness: 1, metallic: 1, transparent: true, albedoMap: albedo, metallicRoughnessMap: mr });
    const e = scene.createTransformedEntity(`tireTracks-${key}`, new Vec3());
    const rend = new Renderable();
    rend.geometry = geometry;
    rend.material = material;
    rend.transparent = true;
    rend.castShadow = false;
    scene.world.addComponent(e.id, rend);
    this.gpu.set(key, { albedo, mr, material, geometry, entity: e.id });
    t.dirty = false;
  }

  override update(_context: SystemContext, dt: number): void {
    const scene = this.scene;
    if (!scene) return;
    for (const f of this.followers) {
      const wheels = f.vehicle.wheels;
      const perWheel = (f.vehicle.config.mass * 9.81) / Math.max(1, wheels.length);
      for (let w = 0; w < wheels.length; w++) {
        const wh = wheels[w]!;
        const last = f.last[w]!;
        if (!wh.inContact) {
          last.on = false;
          continue;
        }
        if (!last.on) {
          last.x = wh.contactX;
          last.z = wh.contactZ;
          last.on = true;
          continue;
        }
        const moved = Math.hypot(wh.contactX - last.x, wh.contactZ - last.z);
        if (moved < 0.05) continue;
        if (moved < 3) this.map.stamp(last.x, last.z, wh.contactX, wh.contactZ, f.width, f.surfaceAt(wh.contactX, wh.contactZ), wh.normalLoad / perWheel);
        last.x = wh.contactX;
        last.z = wh.contactZ;
      }
    }
    this.map.fade(dt);
    this.sinceUpload += dt;
    if (this.sinceUpload < (this.options.uploadInterval ?? 0.1)) return;
    this.sinceUpload = 0;
    for (const t of this.map.tiles.values()) {
      if (!t.dirty) continue;
      const g = this.gpu.get(t.key);
      if (!g) {
        this.bind(scene, t.key);
        continue;
      }
      g.albedo.writeMipData(this.device, 0, 0, t.albedo);
      g.mr.writeMipData(this.device, 0, 0, t.mr);
      t.dirty = false;
    }
  }

  override onDetach(): void {
    for (const key of [...this.gpu.keys()]) this.release(key);
  }
}
