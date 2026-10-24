/**
 * PlanetGlobe: a whole planet as renderable geometry — a displaced, textured surface sphere and an
 * optional cloud/dust shell — built from a *sampler* and baked progressively so the first frame never
 * waits for the planet.
 *
 * What it owns (and the scene places, with one shared rotation about the planet's centre):
 *
 *  - `surfaceGeometry` / `surfaceMaterial`: a UV sphere (`u` = longitude/360°, `v` = from the north
 *    pole down, the planet-fixed frame of `environment/planetFrame.ts`) displaced by the sampler's
 *    elevation × `elevationExaggeration`, lit by the ordinary PBR shader with an equirectangular
 *    albedo texture whose texels carry the sampler's colour, a baked shaded-relief term (so craters
 *    and volcanoes read at any sun angle) and the sampler's high-frequency `detail`;
 *  - `cloudGeometry` / `cloudMaterial`: a transparent shell above the surface whose RGBA texture is
 *    produced by a host callback ({@link PlanetGlobe.setAtmosphereFill}) — weather rasterised from
 *    `environment/planetWeather.ts` — and refreshed a band of rows per frame;
 *  - a *surface overlay* ({@link PlanetGlobe.setSurfaceOverlay}): a per-texel colour/coverage callback
 *    composited over the base albedo inside a latitude band (the polar caps, which move with season).
 *
 * **Progressive bake.** The sampler is expensive (the Mars one is ~50 µs/sample), so `update(budgetMs)`
 * does at most that much work per call: it samples a coarse grid first (default 90×45, then 180×90,
 * then 360×180), and after every pass rebuilds the mesh and re-bakes the texture from the grid by
 * bilinear interpolation — the planet resolves in over a second or two rather than blocking start-up.
 * `progress` runs 0..1 across the passes.
 *
 * Texture updates write every mip level (`Texture.writeMipData`), box-filtered on the CPU, so a
 * minified globe never shows stale or garbage mips. All GPU objects are released by `dispose()`.
 */

import type { GraphicsDevice } from "../gpu/device.js";
import { Texture, boxFilterRgba8 } from "../resources/texture.js";
import { Geometry, computeNormalsAndTangents } from "./geometry.js";
import { Material } from "./material.js";
import { maxMipLevels } from "../gpu/formats.js";

export interface PlanetSurfaceSample {
  /** Metres above the reference sphere. */
  elevation: number;
  /** sRGB, 0..255. */
  r: number;
  g: number;
  b: number;
}

/** Anything that can say what a planet looks like at a unit direction (planet-fixed frame). */
export interface PlanetSurfaceSampler {
  readonly radius: number;
  sample(dx: number, dy: number, dz: number, out: PlanetSurfaceSample): PlanetSurfaceSample;
  /** Cheap albedo multiplier around 1 for texel-level variation; omitted = none. */
  detail?(dx: number, dy: number, dz: number): number;
}

/** Colour a surface overlay writes for one texel (sRGB bytes) and how strongly it covers the base. */
export interface PlanetOverlayTexel {
  coverage: number;
  r: number;
  g: number;
  b: number;
}

export interface PlanetSurfaceOverlay {
  /** Only texels with |latitude| ≥ this are asked (degrees). */
  minAbsLatDeg: number;
  texel(latDeg: number, lonDeg: number, out: PlanetOverlayTexel): PlanetOverlayTexel;
}

/** Fill rows `[row0, row1)` of an RGBA8 atmosphere layer (sRGB colour, straight alpha) of `width×height`. */
export type PlanetAtmosphereFill = (row0: number, row1: number, width: number, height: number, rgba: Uint8Array) => void;

export interface PlanetGlobeOptions {
  sampler: PlanetSurfaceSampler;
  /** Sphere radius in metres; default the sampler's. */
  radius?: number;
  /** Mesh segments (longitude × latitude). Default 256 × 128. */
  meshSegments?: readonly [number, number];
  /** Surface texture width; height is half. Default 1024. */
  textureWidth?: number;
  /** Grid columns of each sampling pass (rows are half). Default [90, 180, 360]. */
  gridPasses?: readonly number[];
  /** Displacement multiplier on real elevations (orbit-scale relief is otherwise invisible). Default 3. */
  elevationExaggeration?: number;
  /** Slope multiplier of the baked shaded relief. Default 24. */
  reliefStrength?: number;
  /** Cloud layer: texture width (height half) and shell height above the sphere, metres. Default 512 / 18 km. */
  cloudTextureWidth?: number;
  cloudAltitude?: number;
  /** Cloud shell mesh segments. Default 128 × 64. */
  cloudSegments?: readonly [number, number];
  label?: string;
}

const DEG = Math.PI / 180;

export class PlanetGlobe {
  readonly radius: number;
  readonly surfaceGeometry: Geometry;
  readonly surfaceMaterial: Material;
  readonly cloudGeometry: Geometry;
  readonly cloudMaterial: Material;

  private readonly device: GraphicsDevice;
  private readonly sampler: PlanetSurfaceSampler;
  private readonly meshW: number;
  private readonly meshH: number;
  private readonly texW: number;
  private readonly texH: number;
  private readonly passes: readonly number[];
  private readonly exaggeration: number;
  private readonly relief: number;
  private readonly cloudW: number;
  private readonly cloudH: number;

  private readonly surfaceTexture: Texture;
  private readonly surfaceBase: Uint8Array; // baked albedo without overlay
  private readonly surfaceFinal: Uint8Array; // base + overlay, what is uploaded
  private readonly cloudTexture: Texture;
  private readonly cloudPixels: Uint8Array;

  // sampling state
  private passIndex = 0;
  private cursor = 0;
  private gridCols = 0;
  private gridRows = 0;
  private gridElevation: Float32Array = new Float32Array(0);
  private gridColor: Uint8Array = new Uint8Array(0);
  /** The finished grid the texture/mesh are baked from (the current pass's, once complete). */
  private bakeCols = 0;
  private bakeRows = 0;
  private bakeElevation: Float32Array = new Float32Array(0);
  private bakeColor: Uint8Array = new Uint8Array(0);
  private bakeRow = 0;
  private bakeActive = false;
  private bakeDetail = false;
  private done = false;
  private readonly sampleOut: PlanetSurfaceSample = { elevation: 0, r: 0, g: 0, b: 0 };

  // overlay + clouds
  private overlay: PlanetSurfaceOverlay | null = null;
  private overlayNorthRows = 0;
  private overlaySouthStart = 0;
  private overlayPending = false;
  private overlayCursor = 0;
  private atmosphere: PlanetAtmosphereFill | null = null;
  private atmosphereCursor = -1; // -1 idle, else next row to fill
  private atmosphereRowsPerSlice: number;
  private readonly overlayOut: PlanetOverlayTexel = { coverage: 0, r: 0, g: 0, b: 0 };
  private disposed = false;

  constructor(device: GraphicsDevice, options: PlanetGlobeOptions) {
    this.device = device;
    this.sampler = options.sampler;
    this.radius = options.radius ?? options.sampler.radius;
    const [mw, mh] = options.meshSegments ?? [256, 128];
    this.meshW = Math.max(8, Math.floor(mw));
    this.meshH = Math.max(4, Math.floor(mh));
    this.texW = Math.max(64, Math.floor(options.textureWidth ?? 1024));
    this.texH = this.texW >> 1;
    this.passes = (options.gridPasses ?? [90, 180, 360]).map((c) => Math.max(8, Math.floor(c)));
    this.exaggeration = options.elevationExaggeration ?? 3;
    this.relief = options.reliefStrength ?? 24;
    this.cloudW = Math.max(64, Math.floor(options.cloudTextureWidth ?? 512));
    this.cloudH = this.cloudW >> 1;
    this.atmosphereRowsPerSlice = Math.max(8, this.cloudH >> 3);
    const label = options.label ?? "planet";
    const cloudAltitude = options.cloudAltitude ?? 18e3;

    // Start dusty-orange rather than black so the first frame already reads as a planet.
    this.surfaceBase = new Uint8Array(this.texW * this.texH * 4);
    for (let i = 0; i < this.surfaceBase.length; i += 4) {
      this.surfaceBase[i] = 150;
      this.surfaceBase[i + 1] = 100;
      this.surfaceBase[i + 2] = 70;
      this.surfaceBase[i + 3] = 255;
    }
    this.surfaceFinal = this.surfaceBase.slice();
    this.surfaceTexture = Texture.fromRgba8(device, this.texW, this.texH, this.surfaceFinal, { label: `${label}.albedo`, srgb: true, mipmaps: true });
    this.surfaceMaterial = new Material({ label: `${label}.surface`, color: 0xffffff, roughness: 0.96, metallic: 0, albedoMap: this.surfaceTexture });
    this.surfaceGeometry = Geometry.create(device, this.buildSurfaceSource(0, 0, null));

    this.cloudPixels = new Uint8Array(this.cloudW * this.cloudH * 4); // fully transparent
    this.cloudTexture = Texture.fromRgba8(device, this.cloudW, this.cloudH, this.cloudPixels, { label: `${label}.clouds`, srgb: true, mipmaps: true });
    this.cloudMaterial = new Material({
      label: `${label}.clouds`,
      color: 0xffffff,
      roughness: 1,
      metallic: 0,
      albedoMap: this.cloudTexture,
      transparent: true,
      depthWrite: false,
    });
    const [cw, ch] = options.cloudSegments ?? [128, 64];
    this.cloudGeometry = Geometry.create(device, this.shellSource(Math.max(8, Math.floor(cw)), Math.max(4, Math.floor(ch)), this.radius + cloudAltitude, `${label}.cloudShell`));
    this.beginPass();
  }

  /** 0..1 over all sampling + baking passes; 1 means the finest pass is baked and uploaded. */
  get progress(): number {
    if (this.done) return 1;
    const total = this.passes.length;
    const cells = this.gridCols * this.gridRows || 1;
    const within = this.bakeActive ? 0.5 + 0.5 * (this.bakeRow / this.texH) : 0.5 * (this.cursor / cells);
    return Math.min(1, (this.passIndex + within) / total);
  }

  get ready(): boolean {
    return this.done;
  }

  /** The finest completed pass's grid columns (0 before the first pass finishes). */
  get bakedColumns(): number {
    return this.bakeCols;
  }

  /** Surface elevation (metres) from the baked grid at a latitude/longitude, or 0 before the first pass. */
  elevationAt(latDeg: number, lonDeg: number): number {
    if (this.bakeCols === 0) return 0;
    return this.gridLookup(this.bakeElevation, this.bakeCols, this.bakeRows, latDeg, lonDeg);
  }

  /** Composite `overlay` over the base albedo (null removes it). Rows redraw across the next `update`s. */
  setSurfaceOverlay(overlay: PlanetSurfaceOverlay | null): void {
    this.overlay = overlay;
    this.invalidateOverlay();
  }

  /** The overlay's inputs changed: recomposite its latitude band. */
  invalidateOverlay(): void {
    // Two bands: the north rows [0, northRows) and the south rows [southStart, texH).
    const minAbs = this.overlay ? this.overlay.minAbsLatDeg : 90;
    const rows = Math.min(this.texH >> 1, Math.ceil(((90 - minAbs) / 180) * this.texH) + 1);
    this.overlayNorthRows = rows;
    this.overlaySouthStart = this.texH - rows;
    this.overlayPending = true;
    this.overlayCursor = 0;
  }

  /** Produce the cloud layer's pixels with `fill`; null clears it. */
  setAtmosphereFill(fill: PlanetAtmosphereFill | null): void {
    this.atmosphere = fill;
    if (!fill) {
      this.cloudPixels.fill(0);
      this.uploadCloud();
      this.atmosphereCursor = -1;
    } else {
      this.invalidateAtmosphere();
    }
  }

  /** The atmosphere's inputs changed: refill the whole layer across the next few updates. */
  invalidateAtmosphere(): void {
    if (this.atmosphere) this.atmosphereCursor = 0;
  }

  /** True while the cloud layer is part-way through a refill. */
  get atmosphereBusy(): boolean {
    return this.atmosphereCursor >= 0;
  }

  /**
   * Spend at most `budgetMs` on sampling, baking, overlay and cloud refills (checked between small
   * units of work, so it can overshoot by one unit). Returns whether anything is still pending.
   */
  update(budgetMs: number): boolean {
    if (this.disposed) return false;
    const t0 = now();
    const over = (): boolean => now() - t0 >= budgetMs;
    if (!this.done) {
      if (this.bakeActive) this.stepBake(over);
      else this.stepSample(over);
    }
    if (!over() && this.overlayPending && this.bakeCols > 0 && !this.bakeActive) this.stepOverlay(over);
    if (!over() && this.atmosphereCursor >= 0 && this.atmosphere) this.stepAtmosphere();
    return !this.done || this.overlayPending || this.atmosphereCursor >= 0;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.surfaceGeometry.dispose();
    this.cloudGeometry.dispose();
    this.surfaceTexture.dispose();
    this.cloudTexture.dispose();
    this.surfaceMaterial.dispose(this.device);
    this.cloudMaterial.dispose(this.device);
  }

  // ---------------------------------------------------------------------------------- sampling

  private beginPass(): void {
    const cols = this.passes[this.passIndex]!;
    this.gridCols = cols;
    this.gridRows = cols >> 1;
    this.gridElevation = new Float32Array(this.gridCols * this.gridRows);
    this.gridColor = new Uint8Array(this.gridCols * this.gridRows * 3);
    this.cursor = 0;
  }

  private stepSample(over: () => boolean): void {
    const cols = this.gridCols;
    const rows = this.gridRows;
    const total = cols * rows;
    const out = this.sampleOut;
    let n = 0;
    while (this.cursor < total) {
      const j = (this.cursor / cols) | 0;
      const i = this.cursor - j * cols;
      const lat = (90 - ((j + 0.5) / rows) * 180) * DEG;
      const lon = (((i + 0.5) / cols) * 360) * DEG;
      const c = Math.cos(lat);
      this.sampler.sample(c * Math.cos(lon), Math.sin(lat), c * Math.sin(lon), out);
      this.gridElevation[this.cursor] = out.elevation;
      const o = this.cursor * 3;
      this.gridColor[o] = clampByte(out.r);
      this.gridColor[o + 1] = clampByte(out.g);
      this.gridColor[o + 2] = clampByte(out.b);
      this.cursor++;
      // Check the clock every few samples, not every one.
      if ((++n & 31) === 0 && over()) return;
    }
    // Pass complete: this grid is now what the mesh and texture bake from.
    this.bakeCols = cols;
    this.bakeRows = rows;
    this.bakeElevation = this.gridElevation;
    this.bakeColor = this.gridColor;
    this.surfaceGeometry.updateFrom(this.buildSurfaceSource(cols, rows, this.bakeElevation));
    this.bakeRow = 0;
    this.bakeActive = true;
    this.bakeDetail = this.passIndex > 0 && typeof this.sampler.detail === "function";
  }

  /** Bilinear lookup in a (cols×rows, 1 or 3 channels) grid with longitude wrap and latitude clamp. */
  private gridLookup(grid: Float32Array, cols: number, rows: number, latDeg: number, lonDeg: number): number {
    const u = (((lonDeg % 360) + 360) % 360) / 360 * cols - 0.5;
    const v = ((90 - latDeg) / 180) * rows - 0.5;
    const i0 = Math.floor(u);
    const j0 = Math.floor(v);
    const fu = u - i0;
    const fv = v - j0;
    const ja = Math.min(rows - 1, Math.max(0, j0));
    const jb = Math.min(rows - 1, Math.max(0, j0 + 1));
    const ia = ((i0 % cols) + cols) % cols;
    const ib = (ia + 1) % cols;
    const a = grid[ja * cols + ia]! * (1 - fu) + grid[ja * cols + ib]! * fu;
    const b = grid[jb * cols + ia]! * (1 - fu) + grid[jb * cols + ib]! * fu;
    return a * (1 - fv) + b * fv;
  }

  // ------------------------------------------------------------------------------------- baking

  private stepBake(over: () => boolean): void {
    const W = this.texW;
    const H = this.texH;
    const cols = this.bakeCols;
    const rows = this.bakeRows;
    const elev = this.bakeElevation;
    const color = this.bakeColor;
    const base = this.surfaceBase;
    const detail = this.bakeDetail ? this.sampler.detail! : null;
    const cellLon = 360 / cols;
    const cellLat = 180 / rows;
    const R = this.radius;
    const relief = this.relief;
    // Light for the baked relief: from the north-west, 42° up, in (east, north, up) of the texel.
    const lx = -0.5, ly = 0.5, lz = 0.7071;
    const lnorm = Math.hypot(lx, ly, lz);
    const flat = lz / lnorm;
    while (this.bakeRow < H) {
      const y = this.bakeRow;
      const lat = 90 - ((y + 0.5) / H) * 180;
      const latR = lat * DEG;
      const cosLat = Math.max(0.02, Math.cos(latR));
      const sinLat = Math.sin(latR);
      const metresPerDegLon = R * DEG * cosLat;
      const metresPerDegLat = R * DEG;
      for (let x = 0; x < W; x++) {
        const lon = ((x + 0.5) / W) * 360;
        // Colour: bilinear of the 3-channel grid.
        const u = (lon / 360) * cols - 0.5;
        const v = ((90 - lat) / 180) * rows - 0.5;
        const i0 = Math.floor(u);
        const j0 = Math.floor(v);
        const fu = u - i0;
        const fv = v - j0;
        const ja = Math.min(rows - 1, Math.max(0, j0));
        const jb = Math.min(rows - 1, Math.max(0, j0 + 1));
        const ia = ((i0 % cols) + cols) % cols;
        const ib = (ia + 1) % cols;
        const o00 = (ja * cols + ia) * 3, o10 = (ja * cols + ib) * 3, o01 = (jb * cols + ia) * 3, o11 = (jb * cols + ib) * 3;
        const w00 = (1 - fu) * (1 - fv), w10 = fu * (1 - fv), w01 = (1 - fu) * fv, w11 = fu * fv;
        let r = color[o00]! * w00 + color[o10]! * w10 + color[o01]! * w01 + color[o11]! * w11;
        let g = color[o00 + 1]! * w00 + color[o10 + 1]! * w10 + color[o01 + 1]! * w01 + color[o11 + 1]! * w11;
        let b = color[o00 + 2]! * w00 + color[o10 + 2]! * w10 + color[o01 + 2]! * w01 + color[o11 + 2]! * w11;
        // Shaded relief from the elevation gradient (central differences, half a cell either side).
        const eE = this.gridLookup(elev, cols, rows, lat, lon + cellLon * 0.5);
        const eW = this.gridLookup(elev, cols, rows, lat, lon - cellLon * 0.5);
        const eN = this.gridLookup(elev, cols, rows, lat + cellLat * 0.5, lon);
        const eS = this.gridLookup(elev, cols, rows, lat - cellLat * 0.5, lon);
        const dEast = ((eE - eW) / (cellLon * metresPerDegLon)) * relief;
        const dNorth = ((eN - eS) / (cellLat * metresPerDegLat)) * relief;
        // Surface normal in (east, north, up): (-dEast, -dNorth, 1).
        const nl = Math.hypot(dEast, dNorth, 1);
        const shade = (-dEast * lx - dNorth * ly + lz) / (nl * lnorm);
        let k = 1 + 1.15 * (shade - flat);
        if (detail) {
          const cl = cosLat;
          const lonR = lon * DEG;
          k *= detail(cl * Math.cos(lonR), sinLat, cl * Math.sin(lonR));
        }
        k = k < 0.45 ? 0.45 : k > 1.55 ? 1.55 : k;
        r *= k; g *= k; b *= k;
        const p = (y * W + x) * 4;
        base[p] = r > 255 ? 255 : r;
        base[p + 1] = g > 255 ? 255 : g;
        base[p + 2] = b > 255 ? 255 : b;
        base[p + 3] = 255;
      }
      this.bakeRow++;
      if (over()) return;
    }
    // Bake complete: show it (with the overlay re-applied), then move on.
    this.bakeActive = false;
    this.surfaceFinal.set(base);
    if (this.overlay) this.invalidateOverlay();
    this.uploadSurface();
    this.passIndex++;
    if (this.passIndex >= this.passes.length) {
      this.done = true;
    } else {
      this.beginPass();
    }
  }

  private stepOverlay(over: () => boolean): void {
    const overlay = this.overlay;
    if (!overlay) {
      // Overlay removed: restore the base.
      this.surfaceFinal.set(this.surfaceBase);
      this.uploadSurface();
      this.overlayPending = false;
      return;
    }
    const W = this.texW;
    const H = this.texH;
    const northRows = this.overlayNorthRows;
    const southStart = this.overlaySouthStart;
    const rowsToDo = northRows + (H - southStart);
    const out = this.overlayOut;
    while (this.overlayCursor < rowsToDo) {
      const y = this.overlayCursor < northRows ? this.overlayCursor : southStart + (this.overlayCursor - northRows);
      const lat = 90 - ((y + 0.5) / H) * 180;
      for (let x = 0; x < W; x++) {
        const lon = ((x + 0.5) / W) * 360;
        const p = (y * W + x) * 4;
        const f = this.surfaceFinal;
        const b = this.surfaceBase;
        if (Math.abs(lat) < overlay.minAbsLatDeg) {
          f[p] = b[p]!; f[p + 1] = b[p + 1]!; f[p + 2] = b[p + 2]!;
          continue;
        }
        overlay.texel(lat, lon, out);
        const c = out.coverage < 0 ? 0 : out.coverage > 1 ? 1 : out.coverage;
        f[p] = b[p]! + (out.r - b[p]!) * c;
        f[p + 1] = b[p + 1]! + (out.g - b[p + 1]!) * c;
        f[p + 2] = b[p + 2]! + (out.b - b[p + 2]!) * c;
      }
      this.overlayCursor++;
      if (over()) return;
    }
    this.overlayPending = false;
    this.uploadSurface();
  }

  private stepAtmosphere(): void {
    const fill = this.atmosphere!;
    const row0 = this.atmosphereCursor;
    const row1 = Math.min(this.cloudH, row0 + this.atmosphereRowsPerSlice);
    fill(row0, row1, this.cloudW, this.cloudH, this.cloudPixels);
    if (row1 >= this.cloudH) {
      this.atmosphereCursor = -1;
      this.uploadCloud();
    } else {
      this.atmosphereCursor = row1;
    }
  }

  private uploadSurface(): void {
    uploadChain(this.device, this.surfaceTexture, this.surfaceFinal, this.texW, this.texH);
  }

  private uploadCloud(): void {
    uploadChain(this.device, this.cloudTexture, this.cloudPixels, this.cloudW, this.cloudH);
  }

  // ------------------------------------------------------------------------------------- meshes

  /** The surface sphere, displaced by `elevation` (a `cols×rows` grid) when given. */
  private buildSurfaceSource(cols: number, rows: number, elevation: Float32Array | null): { positions: Float32Array; normals: Float32Array; uvs: Float32Array; tangents: Float32Array; indices: Uint32Array; label: string } {
    const ws = this.meshW;
    const hs = this.meshH;
    const count = (ws + 1) * (hs + 1);
    const positions = new Float32Array(count * 3);
    const uvs = new Float32Array(count * 2);
    const R = this.radius;
    const ex = this.exaggeration;
    let vi = 0;
    for (let j = 0; j <= hs; j++) {
      const lat = 90 - (j / hs) * 180;
      const latR = lat * DEG;
      const cy = Math.sin(latR);
      const cxz = Math.cos(latR);
      for (let i = 0; i <= ws; i++) {
        const lon = (i / ws) * 360;
        const lonR = lon * DEG;
        const e = elevation ? this.gridLookup(elevation, cols, rows, lat, lon) * ex : 0;
        const r = R + e;
        positions[vi * 3] = cxz * Math.cos(lonR) * r;
        positions[vi * 3 + 1] = cy * r;
        positions[vi * 3 + 2] = cxz * Math.sin(lonR) * r;
        uvs[vi * 2] = i / ws;
        uvs[vi * 2 + 1] = j / hs;
        vi++;
      }
    }
    const indices = sphereIndices(ws, hs);
    const normals = computeNormalsAndTangents(positions, indices, uvs).normals;
    // The longitude seam duplicates a column; make both copies agree, and pin the poles.
    for (let j = 0; j <= hs; j++) {
      const a = (j * (ws + 1)) * 3;
      const b = (j * (ws + 1) + ws) * 3;
      const nx = normals[a]! + normals[b]!;
      const ny = normals[a + 1]! + normals[b + 1]!;
      const nz = normals[a + 2]! + normals[b + 2]!;
      const l = Math.hypot(nx, ny, nz) || 1;
      normals[a] = normals[b] = nx / l;
      normals[a + 1] = normals[b + 1] = ny / l;
      normals[a + 2] = normals[b + 2] = nz / l;
    }
    for (const j of [0, hs]) {
      for (let i = 0; i <= ws; i++) {
        const o = (j * (ws + 1) + i) * 3;
        normals[o] = 0;
        normals[o + 1] = j === 0 ? 1 : -1;
        normals[o + 2] = 0;
      }
    }
    // Tangents along +u (east), the direction the texture runs; the normal map slot is unused, but
    // the vertex layout always carries a complete record.
    const tangents = new Float32Array(count * 4);
    for (let j = 0; j <= hs; j++) {
      for (let i = 0; i <= ws; i++) {
        const lonR = ((i / ws) * 360) * DEG;
        const o = (j * (ws + 1) + i) * 4;
        // east = d(dir)/d(lon); at the poles any horizontal direction will do.
        tangents[o] = -Math.sin(lonR);
        tangents[o + 1] = 0;
        tangents[o + 2] = Math.cos(lonR);
        tangents[o + 3] = 1;
      }
    }
    return { positions, normals, uvs, tangents, indices, label: "planet.surface" };
  }

  /** A smooth sphere shell of `radius` with the same UV layout (for the cloud/dust layer). */
  private shellSource(ws: number, hs: number, radius: number, label: string): { positions: Float32Array; normals: Float32Array; uvs: Float32Array; tangents: Float32Array; indices: Uint32Array; label: string } {
    const count = (ws + 1) * (hs + 1);
    const positions = new Float32Array(count * 3);
    const normals = new Float32Array(count * 3);
    const uvs = new Float32Array(count * 2);
    const tangents = new Float32Array(count * 4);
    let vi = 0;
    for (let j = 0; j <= hs; j++) {
      const latR = (90 - (j / hs) * 180) * DEG;
      const cy = Math.sin(latR);
      const cxz = Math.cos(latR);
      for (let i = 0; i <= ws; i++) {
        const lonR = ((i / ws) * 360) * DEG;
        const x = cxz * Math.cos(lonR);
        const z = cxz * Math.sin(lonR);
        positions[vi * 3] = x * radius;
        positions[vi * 3 + 1] = cy * radius;
        positions[vi * 3 + 2] = z * radius;
        normals[vi * 3] = x;
        normals[vi * 3 + 1] = cy;
        normals[vi * 3 + 2] = z;
        uvs[vi * 2] = i / ws;
        uvs[vi * 2 + 1] = j / hs;
        tangents[vi * 4] = -Math.sin(lonR);
        tangents[vi * 4 + 2] = Math.cos(lonR);
        tangents[vi * 4 + 3] = 1;
        vi++;
      }
    }
    return { positions, normals, uvs, tangents, indices: sphereIndices(ws, hs), label };
  }
}

function sphereIndices(ws: number, hs: number): Uint32Array {
  const indices = new Uint32Array(ws * hs * 6);
  let k = 0;
  for (let j = 0; j < hs; j++) {
    for (let i = 0; i < ws; i++) {
      const a = j * (ws + 1) + i;
      const b = a + 1;
      const c = a + ws + 1;
      const d = c + 1;
      indices[k++] = a;
      indices[k++] = b;
      indices[k++] = c;
      indices[k++] = b;
      indices[k++] = d;
      indices[k++] = c;
    }
  }
  return indices;
}

/** Upload mip 0 and a box-filtered chain below it. */
function uploadChain(device: GraphicsDevice, texture: Texture, base: Uint8Array, width: number, height: number): void {
  const levels = maxMipLevels(width, height);
  let level = base;
  let w = width;
  let h = height;
  for (let mip = 0; mip < levels; mip++) {
    texture.writeMipData(device, mip, 0, level);
    if (mip + 1 >= levels) break;
    const nw = Math.max(1, w >> 1);
    const nh = Math.max(1, h >> 1);
    level = boxFilterRgba8(level, w, h, nw, nh, "linear");
    w = nw;
    h = nh;
  }
}

function clampByte(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
}

function now(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}
