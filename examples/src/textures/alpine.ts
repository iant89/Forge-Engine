/**
 * Procedural surface art for the Alpine rescue demo: the four-layer mountain-ground splat set,
 * a packed-snow trail, winter tyre tread, a spruce-bough card and the truck's hi-vis stripe.
 *
 * Every `*Pixels` function is pure and deterministic (testable without a GPU, previewable as a
 * PNG); the `create*` wrappers upload them. Tiling textures are built on wrapped lattices, so an
 * integer repeat has no seam at the texture edge. Terrain layer albedos are *neutral detail*
 * (mean ≈ 0.85) — the layer colours in `alpineTerrain.ts` supply the hue, exactly like the Mars
 * set — so the representative colour baked for the horizon matches what the splat shows.
 */

import { Texture, hash2i, type GraphicsDevice, type SplatTextureSet } from "@forge/engine";

// ------------------------------------------------------------------ noise on a wrapped lattice

const U32 = 4294967296;

function lat(ix: number, iy: number, px: number, py: number, seed: number): number {
  const x = ((ix % px) + px) % px;
  const y = ((iy % py) + py) % py;
  return hash2i(x, y, seed) / U32;
}

/** Smooth value noise in [0, 1] that repeats every `px` × `py` lattice cells. */
export function wrapNoise(x: number, y: number, px: number, py: number, seed: number): number {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * xf * (xf * (xf * 6 - 15) + 10);
  const v = yf * yf * yf * (yf * (yf * 6 - 15) + 10);
  const a = lat(xi, yi, px, py, seed), b = lat(xi + 1, yi, px, py, seed);
  const c = lat(xi, yi + 1, px, py, seed), d = lat(xi + 1, yi + 1, px, py, seed);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

/** fBm in [0, 1]; every octave doubles frequency *and* the wrap period, so the field tiles. */
export function wrapFbm(x: number, y: number, px: number, py: number, octaves: number, seed: number): number {
  let sum = 0, amp = 0.5, norm = 0, f = 1;
  for (let o = 0; o < octaves; o++) {
    sum += amp * wrapNoise(x * f, y * f, px * f, py * f, seed + o * 1013);
    norm += amp;
    amp *= 0.5;
    f *= 2;
  }
  return sum / norm;
}

interface Cell {
  /** Distance to the nearest feature point, in lattice cells. */
  f1: number;
  /** Distance to the second nearest. */
  f2: number;
  /** Stable id of the nearest cell, in [0, 1). */
  id: number;
  /** Vector from the nearest feature point to the sample (lattice cells). */
  dx: number;
  dy: number;
}

/** Cellular (Worley) noise that tiles every `period` cells — stones, fissures, cracked rock. */
export function wrapCells(x: number, y: number, period: number, seed: number, out: Cell): Cell {
  const cx = Math.floor(x), cy = Math.floor(y);
  let f1 = 9, f2 = 9, id = 0, vx = 0, vy = 0;
  for (let j = -1; j <= 1; j++) {
    for (let i = -1; i <= 1; i++) {
      const gx = cx + i, gy = cy + j;
      const wx = ((gx % period) + period) % period, wy = ((gy % period) + period) % period;
      const fx = gx + hash2i(wx, wy, seed) / U32, fy = gy + hash2i(wx, wy, seed ^ 0x9e3779b1) / U32;
      const d = Math.sqrt((x - fx) * (x - fx) + (y - fy) * (y - fy));
      if (d < f1) { f2 = f1; f1 = d; id = hash2i(wx, wy, seed ^ 0x51ed270b) / U32; vx = x - fx; vy = y - fy; } else if (d < f2) f2 = d;
    }
  }
  out.f1 = f1; out.f2 = f2; out.id = id; out.dx = vx; out.dy = vy;
  return out;
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (a: number, b: number, x: number): number => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };
const byte = (v: number): number => Math.round(clamp01(v) * 255);

/** Tangent-space normal bytes from a wrapped height field (the engine's green = −dy convention). */
function normalFromHeight(height: Float32Array, w: number, h: number, strength: number, wrapY = true): Uint8Array {
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const xl = (x - 1 + w) % w, xr = (x + 1) % w;
      const yu = wrapY ? (y - 1 + h) % h : Math.max(0, y - 1), yd = wrapY ? (y + 1) % h : Math.min(h - 1, y + 1);
      const dx = (height[y * w + xr]! - height[y * w + xl]!) * strength;
      const dy = (height[yd * w + x]! - height[yu * w + x]!) * strength;
      const l = Math.sqrt(dx * dx + dy * dy + 1);
      const o = (y * w + x) * 4;
      out[o] = Math.round((0.5 - (dx / l) * 0.5) * 255);
      out[o + 1] = Math.round((0.5 - (dy / l) * 0.5) * 255);
      out[o + 2] = Math.round((0.5 + (1 / l) * 0.5) * 255);
      out[o + 3] = 255;
    }
  }
  return out;
}

// ------------------------------------------------------------------ terrain layers

export interface SurfaceLayerPixels {
  albedo: Uint8Array;
  normal: Uint8Array;
  /** G = roughness factor, B = metallic factor (both multiply the layer's constants). */
  metallicRoughness: Uint8Array;
}

export type AlpineLayerKind = "snow" | "rock" | "scree" | "tundra";
export const ALPINE_LAYER_ORDER: readonly AlpineLayerKind[] = ["snow", "rock", "scree", "tundra"];

/** One tileable layer of the alpine ground set (neutral albedo detail, normal, roughness). */
export function alpineLayerPixels(kind: AlpineLayerKind, size = 256, seed = 0xa1b1): SurfaceLayerPixels {
  const albedo = new Uint8Array(size * size * 4);
  const mr = new Uint8Array(size * size * 4);
  const height = new Float32Array(size * size);
  const cell: Cell = { f1: 0, f2: 0, id: 0, dx: 0, dy: 0 };
  const cell2: Cell = { f1: 0, f2: 0, id: 0, dx: 0, dy: 0 };
  const k = ALPINE_LAYER_ORDER.indexOf(kind);
  const s = seed + k * 7919;
  let strength = 1.4;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size;
      const o = (y * size + x) * 4;
      let lum = 0.85, rough = 1, h = 0;
      let tr = 1, tg = 1, tb = 1;
      if (kind === "snow") {
        // Wind-sculpted pack: broad swells, sastrugi streaks stretched along u, and a fine grain.
        const swell = wrapFbm(u * 4, v * 4, 4, 4, 4, s);
        const warp = wrapFbm(u * 3, v * 3, 3, 3, 2, s + 11);
        const streak = wrapFbm(u * 3 + warp * 1.2, v * 20, 3, 20, 3, s + 23);
        const ridge = 1 - Math.abs(streak * 2 - 1);
        const grain = wrapNoise(u * 128, v * 128, 128, 128, s + 31);
        h = swell * 0.55 + ridge * ridge * 0.32 + grain * 0.04;
        const hn = clamp01((h - 0.2) / 0.7);
        lum = 0.9 + 0.08 * hn - 0.04 * (1 - hn);
        // Hollows pick up a faint blue from the ice; crests stay neutral.
        tr = 0.965 + 0.035 * hn; tg = 0.985 + 0.015 * hn; tb = 1;
        const glint = hash2i(x, y, s + 77) / U32;
        if (glint > 0.995) { lum = 1; rough = 0.4; }
        rough *= 0.97 + 0.03 * grain;
        strength = 1.3;
      } else if (kind === "rock") {
        // Fractured granite: warped plates and blocks split by fissures of varying depth, bedding
        // bands, vertical water staining and sparse, pale lichen.
        const wa = wrapFbm(u * 3, v * 3, 3, 3, 3, s + 5), wb = wrapFbm(u * 3 + 5, v * 3 + 5, 3, 3, 3, s + 6);
        wrapCells(u * 5 + (wa - 0.5) * 0.9, v * 5 + (wb - 0.5) * 0.9, 5, s, cell);
        wrapCells(u * 14 + (wa - 0.5) * 0.5, v * 14 + (wb - 0.5) * 0.5, 14, s + 99, cell2);
        const crack = smooth(0.0, 0.07, cell.f2 - cell.f1);
        const crack2 = smooth(0.0, 0.06, cell2.f2 - cell2.f1);
        const fine = wrapFbm(u * 28, v * 28, 28, 28, 4, s + 9);
        const stain = wrapFbm(u * 26, v * 2.5, 26, 3, 3, s + 41);
        const bands = Math.sin((v * 14 + wa * 2.4) * Math.PI * 2);
        h = cell.id * 0.25 + crack * 0.36 + crack2 * 0.14 + fine * 0.16;
        lum = 0.64 + 0.2 * cell.id + 0.08 * cell2.id - 0.42 * (1 - crack) - 0.14 * (1 - crack2) + 0.2 * (fine - 0.5) - 0.13 * (stain - 0.4) + 0.03 * bands;
        const lichen = smooth(0.66, 0.82, wrapFbm(u * 8, v * 8, 8, 8, 3, s + 17)) * crack * 0.5;
        tr = 1.01 - lichen * 0.03; tg = 1 + lichen * 0.01; tb = 0.985 - lichen * 0.12;
        lum += lichen * 0.1;
        rough = 0.88 + 0.12 * fine;
        strength = 3.0;
      } else if (kind === "scree") {
        // Loose angular stones, domed and lit differently, over a fill of shaded gravel.
        const wa = wrapFbm(u * 4, v * 4, 4, 4, 3, s + 3), wb = wrapFbm(u * 4 + 9, v * 4 + 9, 4, 4, 3, s + 4);
        wrapCells(u * 8 + (wa - 0.5) * 0.7, v * 8 + (wb - 0.5) * 0.7, 8, s, cell);
        wrapCells(u * 26 + (wa - 0.5) * 0.4, v * 26 + (wb - 0.5) * 0.4, 26, s + 50, cell2);
        const gap = smooth(0.02, 0.24, cell.f2 - cell.f1);
        const dome = 1 - smooth(0, 0.72, cell.f1);
        const dome2 = 1 - smooth(0, 0.7, cell2.f1);
        const fine = wrapFbm(u * 60, v * 60, 60, 60, 3, s + 3);
        const stone = (0.36 + 0.5 * cell.id) * (0.62 + 0.38 * dome);
        const gravel = (0.2 + 0.42 * cell2.id) * (0.5 + 0.5 * dome2);
        lum = (gravel * (1 - gap) + stone * gap) + 0.1 * (fine - 0.5);
        tr = 1 + 0.08 * (cell.id - 0.5); tg = 1; tb = 1 - 0.1 * (cell.id - 0.5);
        h = gap * (0.32 + 0.5 * dome) + (1 - gap) * 0.12 * dome2 + fine * 0.05;
        rough = 0.9 + 0.08 * fine;
        strength = 3.2;
      } else {
        // Frost-bleached winter tussocks: blades fan out of each small tuft over dark soil flecks,
        // blended with isotropic grain so no single direction (or radial motif) dominates.
        const wa = wrapFbm(u * 4, v * 4, 4, 4, 3, s + 2), wb = wrapFbm(u * 4 + 7, v * 4 + 7, 4, 4, 3, s + 3);
        wrapCells(u * 13 + (wa - 0.5) * 1.1, v * 13 + (wb - 0.5) * 1.1, 13, s, cell);
        const ang = Math.atan2(cell.dy, cell.dx);
        const bend = wrapFbm(u * 22, v * 22, 22, 22, 3, s + 8);
        const radial = 0.5 + 0.5 * Math.sin(ang * (9 + Math.floor(cell.id * 10)) + cell.f1 * 6 + bend * 6);
        const grain = wrapFbm(u * 96, v * 96, 96, 96, 3, s + 21);
        const blade = 0.42 * radial + 0.58 * grain;
        const tuft = 1 - smooth(0.28, 0.62, cell.f1 + (bend - 0.5) * 0.3);
        const soil = 1 - tuft;
        h = tuft * (0.4 + 0.4 * blade) + grain * 0.14;
        lum = (0.3 + tuft * (0.3 + 0.38 * blade) + 0.1 * (grain - 0.5)) * (0.8 + 0.2 * cell.id);
        // Olive and rust variation instead of one flat tint; the soil between tufts runs browner.
        tr = 1 + 0.1 * (cell.id - 0.5) + 0.05 * soil; tg = 1 + 0.03 * (blade - 0.5); tb = 1 - 0.16 * (cell.id - 0.5) - 0.06 * soil;
        const frost = hash2i(x, y, s + 91) / U32;
        if (frost > 0.994) lum = 1;
        rough = 0.9 + 0.1 * blade;
        strength = 2.4;
      }
      height[y * size + x] = h;
      albedo[o] = byte(lum * tr);
      albedo[o + 1] = byte(lum * tg);
      albedo[o + 2] = byte(lum * tb);
      albedo[o + 3] = 255;
      mr[o] = 255;
      mr[o + 1] = byte(rough);
      mr[o + 2] = 255;
      mr[o + 3] = 255;
    }
  }
  return { albedo, normal: normalFromHeight(height, size, size, strength), metallicRoughness: mr };
}

export interface AlpineSurfaceTextures {
  maps: SplatTextureSet;
  /** Mean *linear* albedo of each layer's texture, in {@link ALPINE_LAYER_ORDER} order. */
  meanLinear: ReadonlyArray<readonly [number, number, number]>;
}

const toLinear = (b: number): number => { const c = b / 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };

/** Mean linear RGB of an sRGB RGBA8 image. */
export function meanLinearAlbedo(albedo: Uint8Array): [number, number, number] {
  const lut = new Float64Array(256);
  for (let i = 0; i < 256; i++) lut[i] = toLinear(i);
  let r = 0, g = 0, b = 0;
  const n = albedo.length / 4;
  for (let i = 0; i < n; i++) { r += lut[albedo[i * 4]!]!; g += lut[albedo[i * 4 + 1]!]!; b += lut[albedo[i * 4 + 2]!]!; }
  return [r / n, g / n, b / n];
}

/** The four alpine ground layers (snow, rock, scree, tundra) as GPU texture arrays. */
export function createAlpineSurfaceTextures(device: GraphicsDevice, size = 256): AlpineSurfaceTextures {
  const layers = ALPINE_LAYER_ORDER.map((kind) => alpineLayerPixels(kind, size));
  return {
    maps: {
      albedo: Texture.fromRgba8Array(device, size, size, layers.map((l) => l.albedo), { label: "alpine.layers.albedo", srgb: true }),
      normal: Texture.fromRgba8Array(device, size, size, layers.map((l) => l.normal), { label: "alpine.layers.normal", normal: true }),
      metallicRoughness: Texture.fromRgba8Array(device, size, size, layers.map((l) => l.metallicRoughness), { label: "alpine.layers.mr" }),
    },
    meanLinear: layers.map((l) => meanLinearAlbedo(l.albedo)),
  };
}

/** Release a set made by {@link createAlpineSurfaceTextures}. */
export function disposeSplatTextureSet(set: SplatTextureSet | null): void {
  if (!set) return;
  set.albedo.dispose();
  set.normal.dispose();
  set.metallicRoughness.dispose();
}

// ------------------------------------------------------------------ packed-snow road

export interface SnowRoadOptions {
  /** Pixels across the ribbon (u). Default 256. */
  width?: number;
  /** Pixels along one repeat (v). Default 512. */
  height?: number;
  /** Lateral half-span of the ribbon in metres (u 0 → −span, u 1 → +span). Default 3.4. */
  halfSpan?: number;
  /** Half-width of the running surface; beyond it is the plough bank. Default 2.7. */
  roadHalfWidth?: number;
  rutOffset?: number;
  rutWidth?: number;
  /** Metres along per repeat — must match the ribbon's `uvMetersAlong`. Default 8. */
  metersAlong?: number;
  seed?: number;
}

export interface PixelSet {
  width: number;
  height: number;
  albedo: Uint8Array;
  normal: Uint8Array;
  metallicRoughness: Uint8Array;
}

/**
 * A plough-packed mountain track: dark, sanded and trafficked, with two glossy, darker wheel ruts and
 * tread streaks, gritted down the crown, with soft white banks along both edges. Tiles in `v` only
 * (the ribbon's UVs run across 0..1 and along `metersAlong`).
 */
export function snowRoadPixels(options: SnowRoadOptions = {}): PixelSet {
  const W = options.width ?? 256, H = options.height ?? 512;
  const span = options.halfSpan ?? 3.4;
  const roadHW = options.roadHalfWidth ?? 2.7;
  const rutO = options.rutOffset ?? 0.85, rutW = options.rutWidth ?? 0.34;
  const along = options.metersAlong ?? 8;
  const seed = options.seed ?? 311;
  const albedo = new Uint8Array(W * H * 4), mr = new Uint8Array(W * H * 4);
  const height = new Float32Array(W * H);
  const mU = (2 * span) / W, mV = along / H;
  // Every noise cell is sized to divide the repeat exactly, so the texture tiles along `v` without a seam.
  const cellsAlong = (size: number): number => Math.max(1, Math.round(along / size));
  const vA = cellsAlong(0.7), vB = cellsAlong(0.12), vC = cellsAlong(1.8), vG = cellsAlong(0.022);
  for (let y = 0; y < H; y++) {
    const vm = y * mV;
    for (let x = 0; x < W; x++) {
      const latm = -span + (x + 0.5) * mU;
      const ad = Math.abs(latm);
      const n1 = wrapFbm((latm + 12) / 0.7, (vm / along) * vA, 64, vA, 3, seed);
      const n2 = wrapFbm((latm + 12) / 0.12, (vm / along) * vB, 400, vB, 2, seed + 7);
      const rq = Math.abs(ad - rutO) / rutW;
      const rut = ad < roadHW ? clamp01(1 - rq) : 0;
      const rutS = rut * rut * (3 - 2 * rut);
      const streak = wrapNoise(latm / 0.025 + 40, (vm / along) * vC, 4000, vC, seed + 3);
      const bank = smooth(roadHW - 0.18, roadHW + 0.32, ad);
      // A ploughed, sanded and trafficked mountain track: dark grey-brown, mottled, with darker wet
      // wheel ruts. (A pale road disappears the moment the engine's snow settles on it.) The plough
      // banks along both edges are fresh and white.
      let r = 0.36, g = 0.375, b = 0.4;
      const mott = (n1 - 0.5) * 0.11 + (n2 - 0.5) * 0.07;
      r += mott; g += mott; b += mott * 0.9;
      const rutDark = rutS * (0.24 + 0.12 * (streak - 0.5));
      r *= 1 - rutDark * 1.1; g *= 1 - rutDark; b *= 1 - rutDark * 0.8;
      r = r * (1 - bank) + 0.95 * bank; g = g * (1 - bank) + 0.97 * bank; b = b * (1 - bank) + 1.0 * bank;
      // Grit and dirt flecks sanded onto the crown, thinner in the ruts and absent on the banks.
      const cu = Math.floor((latm + 12) / 0.022), cv = Math.floor((vm / along) * vG) % vG;
      const hs = hash2i(cu, cv, seed + 101) / U32;
      let bump = (n2 - 0.5) * 0.3 + bank * (0.35 + 0.25 * n1);
      if (hs < 0.014 * (1 - bank) * (1 - rutS * 0.5)) {
        const dark = 0.55 + 0.3 * (hash2i(cu, cv, seed + 202) / U32);
        r *= dark; g *= dark; b *= dark * 0.95;
        bump += 0.4;
      }
      bump -= rutS * 0.55;
      height[y * W + x] = bump;
      const o = (y * W + x) * 4;
      albedo[o] = byte(r); albedo[o + 1] = byte(g); albedo[o + 2] = byte(b); albedo[o + 3] = 255;
      mr[o] = 255;
      // Polished ruts are the glossiest thing on the road; banks are matte powder.
      mr[o + 1] = byte(0.9 - rutS * 0.34 + bank * 0.08);
      mr[o + 2] = 0;
      mr[o + 3] = 255;
    }
  }
  return { width: W, height: H, albedo, normal: normalFromHeight(height, W, H, 2.2), metallicRoughness: mr };
}

export interface MaterialTextureSet {
  albedo: Texture;
  normal: Texture;
  metallicRoughness: Texture;
}

function upload(device: GraphicsDevice, label: string, px: PixelSet, mipmaps = true): MaterialTextureSet {
  return {
    albedo: Texture.fromRgba8(device, px.width, px.height, px.albedo, { label: `${label}.albedo`, srgb: true, mipmaps }),
    normal: Texture.fromRgba8(device, px.width, px.height, px.normal, { label: `${label}.normal`, normal: true, mipmaps }),
    metallicRoughness: Texture.fromRgba8(device, px.width, px.height, px.metallicRoughness, { label: `${label}.mr`, mipmaps }),
  };
}

export function createSnowRoadTextures(device: GraphicsDevice, options: SnowRoadOptions = {}): MaterialTextureSet {
  return upload(device, "alpine.road", snowRoadPixels(options));
}

export function disposeMaterialTextureSet(set: MaterialTextureSet | null): void {
  if (!set) return;
  set.albedo.dispose();
  set.normal.dispose();
  set.metallicRoughness.dispose();
}

// ------------------------------------------------------------------ winter tyre tread

export interface TyreTreadOptions {
  /** Pixels per repeat around the tyre (u). Default 128. */
  width?: number;
  /** Pixels across the profile (v). Default 256. */
  height?: number;
  /** Fraction of `v` where the flat tread starts / ends (from the tyre profile's arc length). */
  treadFrom: number;
  treadTo: number;
  seed?: number;
}

/**
 * Directional winter tread for the lathe-turned tyre: chevron blocks with sipes across the tread
 * band, a smooth moulded sidewall with fine ribs and a raised bead. `u` repeats around the tyre.
 */
export function tyreTreadPixels(options: TyreTreadOptions): PixelSet {
  const W = options.width ?? 128, H = options.height ?? 256;
  const { treadFrom, treadTo } = options;
  const seed = options.seed ?? 5;
  const albedo = new Uint8Array(W * H * 4), mr = new Uint8Array(W * H * 4);
  const height = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    const v = y / H;
    const t = (v - treadFrom) / (treadTo - treadFrom); // 0..1 across the tread, outside → sidewall
    const onTread = t >= 0 && t <= 1;
    for (let x = 0; x < W; x++) {
      const u = x / W;
      let h = 0, lum = 0.1, rough = 0.93;
      if (onTread) {
        // Chevron: each half of the tread slants toward the centre; blocks are separated by grooves.
        const centre = Math.abs(t - 0.5) * 2; // 0 at the centre line, 1 at the shoulders
        const phase = (u * 2 + centre * 0.55) % 1; // two lug rows per repeat
        const lugV = Math.abs(((phase * 2) % 1) - 0.5) * 2; // 1 at block centre … 0 at the groove
        const groove = smooth(0.0, 0.2, lugV);
        const centreRib = smooth(0.0, 0.08, Math.abs(t - 0.5) - 0.025); // narrow circumferential groove
        // Sipes: fine slits across each block.
        const sipe = 1 - 0.5 * (1 - smooth(0, 0.07, Math.abs(((phase * 8) % 1) - 0.5)));
        h = groove * centreRib * (0.75 + 0.25 * sipe) - (1 - groove) * 0.1;
        lum = 0.085 + 0.045 * groove + 0.02 * (hash2i(x, y, seed) / U32);
        rough = 0.9;
      } else {
        // Sidewall: smooth rubber, fine concentric ribs, a bead step near the rim, faint scuffing.
        const s = t < 0 ? v / Math.max(1e-6, treadFrom) : (1 - v) / Math.max(1e-6, 1 - treadTo); // 0 at the bead, 1 at the shoulder
        const ribs = 0.5 + 0.5 * Math.sin(s * Math.PI * 26);
        h = 0.14 * smooth(0, 0.06, s) + 0.025 * ribs * smooth(0.12, 0.3, s) * (1 - smooth(0.8, 0.95, s));
        lum = 0.07 + 0.03 * wrapFbm(u * 18, v * 18, 18, 18, 3, seed + 3);
        rough = 0.82 + 0.1 * wrapNoise(u * 32, v * 32, 32, 32, seed + 9);
      }
      height[y * W + x] = h;
      const o = (y * W + x) * 4;
      const l = byte(lum * 2.6);
      albedo[o] = l; albedo[o + 1] = l; albedo[o + 2] = byte(lum * 2.7); albedo[o + 3] = 255;
      mr[o] = 255; mr[o + 1] = byte(rough); mr[o + 2] = 0; mr[o + 3] = 255;
    }
  }
  return { width: W, height: H, albedo, normal: normalFromHeight(height, W, H, 3.2), metallicRoughness: mr };
}

export function createTyreTreadTextures(device: GraphicsDevice, options: TyreTreadOptions): MaterialTextureSet {
  return upload(device, "alpine.tyre", tyreTreadPixels(options));
}

// ------------------------------------------------------------------ spruce bough card

/**
 * RGBA pixels for a spruce bough card: a twig with alternating side shoots and short, dense
 * needles. White-to-grey so a per-instance tint colours it; alpha is the silhouette (use with
 * `Material.alphaTest ≈ 0.5`, double-sided). The card is taller than wide — a drooping frond.
 */
export function spruceBoughPixels(size = 128, seed = 17): Uint8Array {
  const px = new Uint8Array(size * size * 4);
  const lum = new Float32Array(size * size);
  const alpha = new Float32Array(size * size);
  const stamp = (x0: number, y0: number, x1: number, y1: number, radius: number, shade: number): void => {
    const minx = Math.max(0, Math.floor(Math.min(x0, x1) - radius - 1)), maxx = Math.min(size - 1, Math.ceil(Math.max(x0, x1) + radius + 1));
    const miny = Math.max(0, Math.floor(Math.min(y0, y1) - radius - 1)), maxy = Math.min(size - 1, Math.ceil(Math.max(y0, y1) + radius + 1));
    const ex = x1 - x0, ey = y1 - y0;
    const len2 = ex * ex + ey * ey || 1e-9;
    for (let y = miny; y <= maxy; y++) {
      for (let x = minx; x <= maxx; x++) {
        const t = clamp01(((x + 0.5 - x0) * ex + (y + 0.5 - y0) * ey) / len2);
        const d = Math.hypot(x + 0.5 - (x0 + ex * t), y + 0.5 - (y0 + ey * t));
        const a = 1 - smooth(radius * 0.55, radius, d);
        if (a <= 0) continue;
        const i = y * size + x;
        if (a > alpha[i]!) { alpha[i] = a; lum[i] = shade; }
      }
    }
  };
  const rnd = (i: number, salt: number): number => hash2i(i, salt, seed) / U32;
  const cx = size * 0.5;
  // Main twig, bottom to top, with a slight bow.
  const twig = (t: number): [number, number] => [cx + Math.sin(t * 2.4 + rnd(0, 1) * 6) * size * 0.012, size * (0.97 - 0.94 * t)];
  const shoots = 15;
  for (let i = 0; i < shoots; i++) {
    const t = (i + 0.7) / (shoots + 0.4);
    const [bx, by] = twig(t);
    for (const side of [-1, 1]) {
      // Side shoots shorten toward the tip and sweep forward (up the card).
      const reach = size * (0.43 - 0.34 * t) * (0.85 + 0.3 * rnd(i, 3 + side));
      const sweep = 0.5 + 0.25 * rnd(i, 7 + side);
      const ex = bx + side * reach, ey = by - reach * sweep * 0.55 + reach * 0.22;
      stamp(bx, by, ex, ey, size * 0.012, 0.55);
      // Needles along the shoot, angled forward on both sides.
      const needles = 12 + Math.floor(rnd(i, 11) * 4);
      for (let n = 1; n <= needles; n++) {
        const f = n / (needles + 1);
        const nx = bx + (ex - bx) * f, ny = by + (ey - by) * f;
        for (const nside of [-1, 1]) {
          const ang = Math.atan2(ey - by, ex - bx) + nside * (0.95 + 0.25 * rnd(n + i * 31, 13));
          const nl = size * (0.075 - 0.03 * f) * (0.8 + 0.4 * rnd(n + i * 17, 19 + nside));
          stamp(nx, ny, nx + Math.cos(ang) * nl, ny + Math.sin(ang) * nl, size * 0.0085, 0.72 + 0.28 * f + 0.08 * rnd(n, i));
        }
      }
    }
  }
  // Terminal tuft.
  const [tx, ty] = twig(1);
  for (let n = 0; n < 9; n++) {
    const ang = -Math.PI / 2 + (n - 4) * 0.28;
    stamp(tx, ty, tx + Math.cos(ang) * size * 0.07, ty + Math.sin(ang) * size * 0.07, size * 0.009, 0.95);
  }
  for (let i = 0; i < size * size; i++) {
    const a = alpha[i]!;
    const l = byte(lum[i]! * 0.9 + 0.1);
    px[i * 4] = l; px[i * 4 + 1] = l; px[i * 4 + 2] = l;
    px[i * 4 + 3] = a > 0.5 ? 255 : Math.round(a * 255);
  }
  return px;
}

// ------------------------------------------------------------------ hi-vis stripe

/**
 * A battenburg-style hi-vis band: two rows of alternating signal-orange and white blocks with a
 * reflective sheen. `u` runs along the vehicle, `v` across the band; tiles along `u`.
 */
export function hiVisStripePixels(width = 128, height = 32): PixelSet {
  const albedo = new Uint8Array(width * height * 4), mr = new Uint8Array(width * height * 4);
  const hmap = new Float32Array(width * height);
  const blocks = 8;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const bx = Math.floor((x / width) * blocks);
      const by = Math.floor((y / height) * 2);
      const orange = (bx + by) % 2 === 0;
      const edge = Math.min(((x / width) * blocks) % 1, 1 - (((x / width) * blocks) % 1), (y / height * 2) % 1, 1 - ((y / height * 2) % 1));
      const trim = edge < 0.05 ? 0.35 : 1;
      const o = (y * width + x) * 4;
      const c = orange ? [0.93, 0.36, 0.1] : [0.95, 0.95, 0.93];
      albedo[o] = byte(c[0]! * trim); albedo[o + 1] = byte(c[1]! * trim); albedo[o + 2] = byte(c[2]! * trim); albedo[o + 3] = 255;
      mr[o] = 255; mr[o + 1] = byte(0.32); mr[o + 2] = 0; mr[o + 3] = 255;
      hmap[y * width + x] = edge < 0.05 ? -0.3 : 0;
    }
  }
  return { width, height, albedo, normal: normalFromHeight(hmap, width, height, 1.5), metallicRoughness: mr };
}

export function createHiVisStripeTextures(device: GraphicsDevice): MaterialTextureSet {
  return upload(device, "alpine.stripe", hiVisStripePixels());
}
