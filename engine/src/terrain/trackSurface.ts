/**
 * Procedural surface textures for spline-carved tracks (fe-37): a gravel/dirt road with compacted
 * tyre ruts, tread streaks, loose stones and fallen leaves, and a hydroseeded/grass berm cover.
 *
 * Mapping contract (matches {@link trackRibbonSource}): `u` runs across the ribbon from its `from`
 * edge to its `to` edge (the road ribbon spans `±(roadHalfWidth + shoulder)`), `v` runs along the
 * track and repeats every `uvMetersAlong` metres, so the texture tiles seamlessly in `v` only.
 * Rut bands in the texture sit at the same lateral offsets as the carved rut geometry
 * (`rutOffset`, `rutWidth` from the {@link TrackProfileParams} you pass), so shading and the
 * physical grooves line up.
 *
 * Pixel generation is pure (`*Pixels` functions, deterministic per seed, testable without a GPU);
 * the `create*` functions upload albedo (sRGB), tangent-space normal and metallic-roughness
 * (G = roughness, B = metallic) with mip chains via `Texture.fromRgba8`.
 */

import { hash2i } from "../math/rng.js";
import { clamp, smoothstep } from "../math/scalar.js";
import { Texture } from "../resources/texture.js";
import type { GraphicsDevice } from "../gpu/device.js";

export interface TrackSurfaceTextureSet {
  albedo: Texture;
  normal: Texture;
  metallicRoughness: Texture;
}

export interface TrackSurfacePixels {
  width: number;
  height: number;
  albedo: Uint8Array;
  normal: Uint8Array;
  metallicRoughness: Uint8Array;
}

export interface GravelRoadTextureOptions {
  /** Pixels across (u). Default 256. */
  width?: number;
  /** Pixels along one repeat (v). Default 512. */
  height?: number;
  /** Lateral half-span of the ribbon in metres (u = 0 → −span, u = 1 → +span). Default 2.7. */
  halfSpan?: number;
  /** Running-surface half width; outside it is shoulder/verge. Default 2.2. */
  roadHalfWidth?: number;
  rutOffset?: number;
  rutWidth?: number;
  /** Metres along per repeat (must match the ribbon's `uvMetersAlong`). Default 8. */
  metersAlong?: number;
  /** Base gravel colour (sRGB 0xRRGGBB). Default pale limestone tan 0xb5aa96. */
  baseColor?: number;
  /** Leaf specks per square metre near the edges (centre gets a fifth). Default 9. */
  leafDensity?: number;
  seed?: number;
}

function wrapNoise(x: number, y: number, periodY: number, seed: number, periodX = 0): number {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const w = (n: number): number => ((n % periodY) + periodY) % periodY;
  const wx = (n: number): number => (periodX > 0 ? ((n % periodX) + periodX) % periodX : n);
  const h = (a: number, b: number): number => hash2i(wx(a), w(b), seed) / 4294967296;
  const a = h(xi, yi), b = h(xi + 1, yi), c = h(xi, yi + 1), d = h(xi + 1, yi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

/** fBm in [0,1] that wraps every `periodY` lattice units at octave 0. */
function wrapFbm(x: number, y: number, periodY: number, octaves: number, seed: number): number {
  let sum = 0, amp = 0.5, norm = 0, f = 1;
  for (let o = 0; o < octaves; o++) {
    sum += amp * wrapNoise(x * f, y * f, periodY * f, seed + o * 977);
    norm += amp;
    amp *= 0.5;
    f *= 2;
  }
  return sum / norm;
}

function srgbComponents(hex: number): [number, number, number] {
  return [((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255];
}

const LEAF_COLORS = [0xc8741f, 0xa8461c, 0xd9a032, 0x7e4a24, 0x9c3a1a, 0xb88a3a];

function heightToNormal(h: Float32Array, w: number, hh: number, strength: number, wrapX: boolean, out: Uint8Array): void {
  for (let y = 0; y < hh; y++) {
    for (let x = 0; x < w; x++) {
      const xl = wrapX ? (x - 1 + w) % w : Math.max(0, x - 1);
      const xr = wrapX ? (x + 1) % w : Math.min(w - 1, x + 1);
      const yu = (y - 1 + hh) % hh, yd = (y + 1) % hh;
      const dx = (h[y * w + xr]! - h[y * w + xl]!) * strength;
      const dy = (h[yd * w + x]! - h[yu * w + x]!) * strength;
      const len = Math.hypot(dx, dy, 1);
      const o = (y * w + x) * 4;
      out[o] = Math.round(((-dx / len) * 0.5 + 0.5) * 255);
      out[o + 1] = Math.round(((-dy / len) * 0.5 + 0.5) * 255);
      out[o + 2] = Math.round(((1 / len) * 0.5 + 0.5) * 255);
      out[o + 3] = 255;
    }
  }
}

/** Gravel/dirt road with compacted rut bands, tread streaks, stones and leaf specks. */
export function gravelRoadPixels(opts: GravelRoadTextureOptions = {}): TrackSurfacePixels {
  const W = opts.width ?? 256, H = opts.height ?? 512;
  const span = opts.halfSpan ?? 2.7;
  const roadHW = opts.roadHalfWidth ?? 2.2;
  const rutO = opts.rutOffset ?? 0.8, rutW = opts.rutWidth ?? 0.32;
  const along = opts.metersAlong ?? 8;
  const seed = opts.seed ?? 11;
  const [br, bg, bb] = srgbComponents(opts.baseColor ?? 0xb5aa96);
  const albedo = new Uint8Array(W * H * 4);
  const mr = new Uint8Array(W * H * 4);
  const normal = new Uint8Array(W * H * 4);
  const height = new Float32Array(W * H);
  const mPerPxU = (2 * span) / W, mPerPxV = along / H;
  const vPeriod = Math.max(1, Math.round(along / 0.6)); // lattice periods for 0.6 m noise
  for (let y = 0; y < H; y++) {
    const vm = y * mPerPxV;
    for (let x = 0; x < W; x++) {
      const lat = -span + (x + 0.5) * mPerPxU;
      const ad = Math.abs(lat);
      // Mottling at 0.6 m and 0.15 m.
      const n1 = wrapFbm((lat + 10) / 0.6, vm / 0.6, vPeriod, 3, seed);
      const n2 = wrapFbm((lat + 10) / 0.12, vm / 0.12, vPeriod * 5, 2, seed + 7);
      // Rut band weight (compacted, darker, smoother, with tread streaks running along).
      const rq = Math.abs(ad - rutO) / rutW;
      const rut = ad < roadHW ? clamp(1 - rq, 0, 1) : 0;
      const rutSoft = rut * rut * (3 - 2 * rut);
      const streak = wrapNoise(lat / 0.03 + 50, vm / 1.6, Math.max(1, Math.round(along / 1.6)), seed + 3);
      // Crown is lighter/looser, edges collect fines and organic dirt.
      const edge = smoothstep(roadHW - 0.5, roadHW + 0.4, ad);
      let r = br, g = bg, b = bb;
      const mott = (n1 - 0.5) * 0.22 + (n2 - 0.5) * 0.12;
      r *= 1 + mott; g *= 1 + mott; b *= 1 + mott * 0.9;
      // Ruts: darker, slightly browner, with streaks.
      const rutDark = rutSoft * (0.2 + 0.1 * (streak - 0.5));
      r *= 1 - rutDark; g *= 1 - rutDark * 1.05; b *= 1 - rutDark * 1.15;
      // Edge dirt (brown) and verge.
      r = r * (1 - edge * 0.45) + 0.36 * edge * 0.45;
      g = g * (1 - edge * 0.45) + 0.28 * edge * 0.45;
      b = b * (1 - edge * 0.45) + 0.2 * edge * 0.45;
      // Stones: hashed cells of ~4 cm, light or dark, sparse in the compacted ruts.
      const cu = Math.floor((lat + 10) / 0.04), cv = Math.floor(vm / 0.04) % Math.round(along / 0.04);
      const hs = hash2i(cu, cv, seed + 101) / 4294967296;
      let bump = (n2 - 0.5) * 0.3;
      if (hs < 0.16 * (1 - rutSoft * 0.7)) {
        const tone = hash2i(cu, cv, seed + 202) / 4294967296;
        const k = tone < 0.5 ? 0.72 + tone * 0.3 : 1.05 + (tone - 0.5) * 0.25;
        r *= k; g *= k; b *= k;
        bump += 0.6;
      }
      bump -= rutSoft * 0.5;
      height[y * W + x] = bump;
      const o = (y * W + x) * 4;
      albedo[o] = Math.round(clamp(r, 0, 1) * 255);
      albedo[o + 1] = Math.round(clamp(g, 0, 1) * 255);
      albedo[o + 2] = Math.round(clamp(b, 0, 1) * 255);
      albedo[o + 3] = 255;
      mr[o] = 255;
      mr[o + 1] = Math.round((0.93 - rutSoft * 0.1) * 255);
      mr[o + 2] = 0;
      mr[o + 3] = 255;
    }
  }
  // Leaf specks: elliptical blobs, denser toward the edges, sparse on the crown.
  const leafDensity = opts.leafDensity ?? 9;
  const area = 2 * span * along;
  const leaves = Math.round(area * leafDensity);
  for (let i = 0; i < leaves; i++) {
    const h0 = hash2i(i, 1, seed + 303) / 4294967296;
    const h1 = hash2i(i, 2, seed + 303) / 4294967296;
    const h2 = hash2i(i, 3, seed + 303) / 4294967296;
    const h3 = hash2i(i, 4, seed + 303) / 4294967296;
    const lat = -span + h0 * 2 * span;
    const ad = Math.abs(lat);
    const keep = 0.2 + 0.8 * smoothstep(roadHW * 0.4, roadHW + 0.2, ad);
    const rutQ = Math.abs(ad - rutO) / rutW;
    if (h3 > keep * (rutQ < 1 ? 0.35 : 1)) continue;
    const cx = (lat + span) / mPerPxU, cy = (h1 * along) / mPerPxV;
    const [lr, lg, lb] = srgbComponents(LEAF_COLORS[Math.floor(h2 * LEAF_COLORS.length)]!);
    const rx = (0.035 + h2 * 0.03) / mPerPxU, ry = (0.025 + h3 * 0.02) / mPerPxV;
    const ang = h1 * Math.PI * 7;
    const ca = Math.cos(ang), sa = Math.sin(ang);
    const ext = Math.ceil(Math.max(rx, ry * (mPerPxV / mPerPxU)) + 1);
    for (let dy = -ext; dy <= ext; dy++) {
      for (let dx = -ext; dx <= ext; dx++) {
        const px = Math.round(cx) + dx;
        if (px < 0 || px >= W) continue;
        const py = (((Math.round(cy) + dy) % H) + H) % H;
        const mx = dx * mPerPxU, my = dy * mPerPxV;
        const ex = (mx * ca + my * sa) / (rx * mPerPxU), ey = (-mx * sa + my * ca) / (ry * mPerPxV);
        if (ex * ex + ey * ey > 1) continue;
        const o = (py * W + px) * 4;
        albedo[o] = Math.round(lr * 255);
        albedo[o + 1] = Math.round(lg * 255);
        albedo[o + 2] = Math.round(lb * 255);
        mr[o + 1] = 200;
        height[py * W + px] = (height[py * W + px] ?? 0) + 0.15;
      }
    }
  }
  heightToNormal(height, W, H, 1.6, false, normal);
  return { width: W, height: H, albedo, normal, metallicRoughness: mr };
}

export interface GrassBermTextureOptions {
  size?: number;
  /** Metres per repeat. Default 4. */
  meters?: number;
  /** Base colour (sRGB). Default fresh hydroseed green 0x6aa53c. */
  baseColor?: number;
  /** 0..1 amount of pale blue-grey hydroseed mulch showing through. Default 0.25. */
  mulch?: number;
  seed?: number;
}

/** Short grass / hydroseed cover: blade streak noise, clumps, and pale mulch specks. */
export function grassBermPixels(opts: GrassBermTextureOptions = {}): TrackSurfacePixels {
  const S = opts.size ?? 256;
  const meters = opts.meters ?? 4;
  const seed = opts.seed ?? 21;
  const mulch = opts.mulch ?? 0.25;
  const [br, bg, bb] = srgbComponents(opts.baseColor ?? 0x6aa53c);
  const albedo = new Uint8Array(S * S * 4);
  const mr = new Uint8Array(S * S * 4);
  const normal = new Uint8Array(S * S * 4);
  const height = new Float32Array(S * S);
  const per = Math.max(1, Math.round(meters / 0.5));
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const um = (x / S) * meters, vm = (y / S) * meters;
      const clump = wrapNoise(um / 0.5, vm / 0.5, per, seed, per);
      const blade = hash2i(x % S, y % S, seed + 5) / 4294967296;
      const fine = wrapNoise(um / 0.0625, vm / 0.0625, per * 8, seed + 9, per * 8);
      const k = 0.75 + clump * 0.35 + (blade - 0.5) * 0.25 + (fine - 0.5) * 0.2;
      let r = br * k, g = bg * k, b = bb * k;
      // Yellow-green tips.
      const tip = smoothstep(0.75, 0.98, blade) * 0.4;
      r += tip * 0.25; g += tip * 0.12;
      const m = smoothstep(1 - mulch * 0.6, 1, fine * (1 - clump * 0.5) + 0.25);
      r = r * (1 - m) + 0.72 * m; g = g * (1 - m) + 0.78 * m; b = b * (1 - m) + 0.7 * m;
      const o = (y * S + x) * 4;
      albedo[o] = Math.round(clamp(r, 0, 1) * 255);
      albedo[o + 1] = Math.round(clamp(g, 0, 1) * 255);
      albedo[o + 2] = Math.round(clamp(b, 0, 1) * 255);
      albedo[o + 3] = 255;
      mr[o] = 255;
      mr[o + 1] = Math.round(0.82 * 255);
      mr[o + 2] = 0;
      mr[o + 3] = 255;
      height[y * S + x] = blade * 0.6 + clump * 0.8;
    }
  }
  heightToNormal(height, S, S, 1.2, true, normal);
  return { width: S, height: S, albedo, normal, metallicRoughness: mr };
}

/** Upload a pixel set as an sRGB albedo + linear normal + linear MR texture set. */
export function uploadTrackSurface(device: GraphicsDevice, px: TrackSurfacePixels, label: string): TrackSurfaceTextureSet {
  return {
    albedo: Texture.fromRgba8(device, px.width, px.height, px.albedo, { label: `${label}.albedo`, srgb: true }),
    normal: Texture.fromRgba8(device, px.width, px.height, px.normal, { label: `${label}.normal`, normal: true }),
    metallicRoughness: Texture.fromRgba8(device, px.width, px.height, px.metallicRoughness, { label: `${label}.mr` }),
  };
}

export function createGravelRoadTextures(device: GraphicsDevice, opts: GravelRoadTextureOptions = {}): TrackSurfaceTextureSet {
  return uploadTrackSurface(device, gravelRoadPixels(opts), "track.gravel");
}

export function createGrassBermTextures(device: GraphicsDevice, opts: GrassBermTextureOptions = {}): TrackSurfaceTextureSet {
  return uploadTrackSurface(device, grassBermPixels(opts), "track.grass");
}

export function disposeTrackSurface(set: TrackSurfaceTextureSet | null): void {
  if (!set) return;
  set.albedo.dispose();
  set.normal.dispose();
  set.metallicRoughness.dispose();
}
