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
 * The baked relief takes its slope from a bicubic (Catmull-Rom) interpolation of the grid, so the
 * shading is continuous across grid cells rather than one flat tone per cell.
 *
 * **Detail patch** (zoomed-in level of detail, enabled by `detailTextureSize`). One texture for the
 * whole planet is ≈10–20 km per texel, which a close orbit magnifies into blur. {@link setDetailFocus}
 * names the spot under the camera; once the globe is baked, `update` bakes a *detail window* around it
 * (`rendering/planetDetail.ts`): globe mesh cells snapped to a latitude/longitude rectangle, re-drawn as
 * a finer displaced patch with its own texture — colour from a coarse grid of full samples, elevation
 * and shaded relief from a finer grid of the sampler's cheap `elevation` path, the surface overlay on
 * top. The globe leaves those cells out of its index buffer while the patch shows; the patch's border
 * lies on the globe's cell edges and its outermost cell fades into the globe's own texture and shape,
 * so the seam has no crack or step. A bake runs in the same time-sliced budget; the previous patch
 * stays visible until the next one swaps in. The host shows `detailGeometry` with `detailMaterial`
 * whenever {@link detailVisible}.
 *
 * Texture updates write every mip level (`Texture.writeMipData`), box-filtered on the CPU, so a
 * minified globe never shows stale or garbage mips. All GPU objects are released by `dispose()`.
 */

import type { GraphicsDevice } from "../gpu/device.js";
import { Texture, boxFilterRgba8 } from "../resources/texture.js";
import { Geometry, computeNormalsAndTangents } from "./geometry.js";
import { Material } from "./material.js";
import { maxMipLevels } from "../gpu/formats.js";
import type { PlanetAtmosphereFill, PlanetOverlayTexel, PlanetSurfaceOverlay } from "../environment/planetWeather.js";
import { localGridCubic, planetDetailMesh, planetDetailWindow, planetDetailWindowContains, planetGridCubic, planetReliefShade, type PlanetDetailWindow } from "./planetDetail.js";

export type { PlanetAtmosphereFill, PlanetOverlayTexel, PlanetSurfaceOverlay };

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
  /**
   * `footprintRad` is the angular size of the grid cell the sample will be interpolated over (the current
   * sampling pass's spacing); samplers over real data average across it to avoid aliasing. Optional.
   */
  sample(dx: number, dy: number, dz: number, out: PlanetSurfaceSample, footprintRad?: number): PlanetSurfaceSample;
  /** Cheap albedo multiplier around 1 for texel-level variation; omitted = none. */
  detail?(dx: number, dy: number, dz: number): number;
  /**
   * Elevation only (metres), much cheaper than `sample`; the detail patch reads its fine relief from it.
   * Omitted: the patch takes elevation from its colour grid's `sample` calls (coarser).
   */
  elevation?(dx: number, dy: number, dz: number, footprintRad?: number): number;
}

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
  /**
   * How strongly the baked relief modulates the albedo (the `1.15` in `1 + gain·(shade − flat)`).
   * Raise it where the real relief is subtle at orbit scale so the lit side keeps visible form even at
   * noon (default 1.15).
   */
  reliefGain?: number;
  /** Cloud layer: texture width (height half) and shell height above the sphere, metres. Default 512 / 18 km. */
  cloudTextureWidth?: number;
  cloudAltitude?: number;
  /** Cloud shell mesh segments. Default 128 × 64. */
  cloudSegments?: readonly [number, number];
  /** Detail patch texture size (square). 0 (the default) disables the patch. */
  detailTextureSize?: number;
  /** Detail patch mesh resolution: roughly this many quads across the window. Default 160. */
  detailMeshQuads?: number;
  label?: string;
}

/** The globe surface mesh as built (kept so the detail patch can cut and restore its hole). */
interface SurfaceSource {
  positions: Float32Array;
  normals: Float32Array;
  uvs: Float32Array;
  tangents: Float32Array;
  indices: Uint32Array;
  label: string;
}

/** A detail patch bake in progress (see `stepDetail`). */
interface DetailJob {
  window: PlanetDetailWindow;
  /** The cap baked: unit centre and radius (radians). */
  x: number;
  y: number;
  z: number;
  radius: number;
  /** 0 colour grid, 1 elevation grid, 2 texels, 3 mesh + swap. */
  phase: number;
  cursor: number;
  /** Colour grid: `gw×gh` nodes with a one-node apron, rgb (× the sampler's `detail`) + elevation per node. */
  gw: number;
  gh: number;
  colour: Float32Array;
  /** Elevation grid: `ew×eh` nodes with a one-node apron. */
  ew: number;
  eh: number;
  elev: Float32Array;
  /** Relief multiplier per elevation node (filled when the elevation grid is complete). */
  shade: Float32Array;
  pixels: Uint8Array;
}

const DEG = Math.PI / 180;

export class PlanetGlobe {
  readonly radius: number;
  readonly surfaceGeometry: Geometry;
  readonly surfaceMaterial: Material;
  readonly cloudGeometry: Geometry;
  readonly cloudMaterial: Material;
  /** The detail patch (null when `detailTextureSize` is 0); draw it while {@link detailVisible}. */
  readonly detailGeometry: Geometry | null;
  readonly detailMaterial: Material | null;

  private readonly device: GraphicsDevice;
  private readonly sampler: PlanetSurfaceSampler;
  private readonly meshW: number;
  private readonly meshH: number;
  private readonly texW: number;
  private readonly texH: number;
  private readonly passes: readonly number[];
  private readonly exaggeration: number;
  private readonly relief: number;
  private readonly reliefGain: number;
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
  private bakeShade: Float32Array = new Float32Array(0);
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

  // detail patch
  private readonly detailSize: number;
  private readonly detailQuads: number;
  private readonly detailTexture: Texture | null = null;
  private surfaceSource: SurfaceSource | null = null;
  private focus: { x: number; y: number; z: number; radius: number } | null = null;
  private shown: { window: PlanetDetailWindow; x: number; y: number; z: number; radius: number } | null = null;
  private job: DetailJob | null = null;
  private detailStale = false;

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
    this.reliefGain = options.reliefGain ?? 1.15;
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
    this.detailSize = Math.max(0, Math.floor(options.detailTextureSize ?? 0));
    this.detailQuads = Math.max(16, Math.floor(options.detailMeshQuads ?? 160));
    if (this.detailSize > 0) {
      this.detailSize = Math.max(64, this.detailSize);
      const blank = new Uint8Array(this.detailSize * this.detailSize * 4);
      this.detailTexture = Texture.fromRgba8(device, this.detailSize, this.detailSize, blank, { label: `${label}.detail`, srgb: true, mipmaps: true });
      // Clamp, not repeat: a repeating sampler blends the far edge of the patch into its border texels
      // (a one-texel stripe along the seam); anisotropy keeps the patch crisp toward the limb.
      this.detailMaterial = new Material({ label: `${label}.detail`, color: 0xffffff, roughness: 0.96, metallic: 0, albedoMap: this.detailTexture })
        .setSamplers({ albedo: device.sampler("anisotropic") });
      // A placeholder until the first patch is baked (the host keeps it hidden until then).
      this.detailGeometry = Geometry.create(device, this.shellSource(2, 2, this.radius, `${label}.detail`));
    } else {
      this.detailMaterial = null;
      this.detailGeometry = null;
    }
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

  /** True while a baked detail patch is in place (draw `detailGeometry`; the globe has a hole under it). */
  get detailVisible(): boolean {
    return this.shown !== null;
  }

  /** True while a detail patch is being baked. */
  get detailBusy(): boolean {
    return this.job !== null;
  }

  /** The shown patch's cap radius, degrees (0 when none). */
  get detailRadiusDeg(): number {
    return this.shown ? this.shown.radius / DEG : 0;
  }

  /**
   * Ask for detail within `radiusRad` of the unit direction `(dx, dy, dz)` (planet-fixed frame). The
   * shown patch is kept while it still covers that cap at a useful resolution; otherwise a patch with
   * some margin around it is baked in the background. Ignored without `detailTextureSize`.
   */
  setDetailFocus(dx: number, dy: number, dz: number, radiusRad: number): void {
    if (!this.detailTexture) return;
    const l = Math.hypot(dx, dy, dz);
    if (!(l > 0) || !(radiusRad > 0)) return;
    this.focus = { x: dx / l, y: dy / l, z: dz / l, radius: Math.min(radiusRad, Math.PI / 3) };
  }

  /** Drop the detail patch: the full globe is drawn again. */
  clearDetailFocus(): void {
    this.focus = null;
    this.job = null;
    if (this.shown) {
      this.shown = null;
      if (this.surfaceSource) this.surfaceGeometry.updateFrom(this.surfaceSource);
    }
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
    // A shown patch carries its own copy of the overlay: re-bake it in place if it reaches the band.
    const w = this.shown?.window;
    if (w && (w.lat0 >= minAbs || w.lat0 - w.latSpan <= -minAbs)) this.detailStale = true;
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
    if (this.done && this.detailTexture) {
      this.planDetail();
      if (this.job && !over()) this.stepDetail(over);
    }
    if (!over() && this.atmosphereCursor >= 0 && this.atmosphere) this.stepAtmosphere();
    return !this.done || this.overlayPending || this.atmosphereCursor >= 0 || this.job !== null;
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
    this.detailGeometry?.dispose();
    this.detailTexture?.dispose();
    this.detailMaterial?.dispose(this.device);
    this.job = null;
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
    const cellRad = (Math.PI * 2) / cols;
    let n = 0;
    while (this.cursor < total) {
      const j = (this.cursor / cols) | 0;
      const i = this.cursor - j * cols;
      const lat = (90 - ((j + 0.5) / rows) * 180) * DEG;
      const lon = (((i + 0.5) / cols) * 360) * DEG;
      const c = Math.cos(lat);
      this.sampler.sample(c * Math.cos(lon), Math.sin(lat), c * Math.sin(lon), out, cellRad);
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
    this.surfaceSource = this.buildSurfaceSource(cols, rows, this.bakeElevation);
    this.surfaceGeometry.updateFrom(this.surfaceSource);
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
    // The relief multiplier per grid node, once per pass; each texel interpolates it bicubically.
    if (this.bakeRow === 0 || this.bakeShade.length !== cols * rows) {
      this.bakeShade = planetReliefShade(
        elev, cols, rows, true,
        (j) => R * DEG * Math.max(0.02, Math.cos((90 - ((j + 0.5) / rows) * 180) * DEG)) * cellLon,
        R * DEG * cellLat, this.relief, this.reliefGain,
      );
    }
    const shadeGrid = this.bakeShade;
    while (this.bakeRow < H) {
      const y = this.bakeRow;
      const lat = 90 - ((y + 0.5) / H) * 180;
      const latR = lat * DEG;
      const cosLat = Math.max(0.02, Math.cos(latR));
      const sinLat = Math.sin(latR);
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
        // Shaded relief: the node multipliers, interpolated bicubically (a bilinear slope would be one
        // flat tone per grid cell).
        let k = planetGridCubic(shadeGrid, cols, rows, lat, lon);
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

  // -------------------------------------------------------------------------------- detail patch

  /** Start a bake when the focus has left the shown patch (or it needs a refresh). */
  private planDetail(): void {
    const f = this.focus;
    if (!f) return;
    const covers = (c: { x: number; y: number; z: number; radius: number }): boolean => {
      const angle = Math.acos(Math.max(-1, Math.min(1, c.x * f.x + c.y * f.y + c.z * f.z)));
      // Covered with a little room to spare, and not so much larger than asked that it is blurry (a
      // fresh bake is 1.45× the view; zooming in past 0.55 of it re-bakes at the finer size).
      return angle + f.radius <= c.radius * 0.97 && f.radius >= c.radius * 0.55;
    };
    if (this.job && covers(this.job)) return;
    if (this.shown && covers(this.shown) && !this.detailStale) return;
    if (this.shown && covers(this.shown) && this.detailStale) {
      this.detailStale = false;
      this.beginDetail(this.shown.x, this.shown.y, this.shown.z, this.shown.radius);
      return;
    }
    // Bake with margin, so small moves and zooms stay inside it.
    this.detailStale = false;
    this.beginDetail(f.x, f.y, f.z, Math.min(Math.PI / 3, f.radius * 1.45));
  }

  private beginDetail(x: number, y: number, z: number, radius: number): void {
    const window = planetDetailWindow(x, y, z, radius, this.meshW, this.meshH);
    const P = this.detailSize;
    // Node counts follow the window's ground extent so nodes are roughly square on the ground.
    const midLat = (window.lat0 - window.latSpan / 2) * DEG;
    const kmX = window.lonSpan * Math.max(0.05, Math.cos(midLat));
    const kmY = window.latSpan;
    const nodes = (along: number, longest: number, n: number): number => Math.max(6, Math.round((along / Math.max(longest, 1e-9)) * n)) + 3;
    const longest = Math.max(kmX, kmY);
    const gw = nodes(kmX, longest, P / 8);
    const gh = nodes(kmY, longest, P / 8);
    const fine = typeof this.sampler.elevation === "function";
    // Fine relief at half the texture's resolution: ≈ the atlas node spacing at a close zoom.
    const ew = fine ? nodes(kmX, longest, P / 2) : gw;
    const eh = fine ? nodes(kmY, longest, P / 2) : gh;
    this.job = {
      window, x, y, z, radius,
      phase: 0, cursor: 0,
      gw, gh, colour: new Float32Array(gw * gh * 4),
      ew, eh, elev: new Float32Array(ew * eh), shade: new Float32Array(ew * eh),
      pixels: new Uint8Array(P * P * 4),
    };
  }

  private stepDetail(over: () => boolean): void {
    const job = this.job!;
    const w = job.window;
    const sampler = this.sampler;
    if (job.phase === 0) {
      const out = this.sampleOut;
      const stepLon = w.lonSpan / (job.gw - 3);
      const stepLat = w.latSpan / (job.gh - 3);
      const footprint = Math.min(stepLat, stepLon) * DEG;
      const total = job.gw * job.gh;
      let n = 0;
      while (job.cursor < total) {
        const b = (job.cursor / job.gw) | 0;
        const a = job.cursor - b * job.gw;
        const lat = clampLat(w.lat0 - (b - 1) * stepLat);
        const lon = w.lon0 + (a - 1) * stepLon;
        const c = Math.cos(lat * DEG);
        const dx = c * Math.cos(lon * DEG);
        const dy = Math.sin(lat * DEG);
        const dz = c * Math.sin(lon * DEG);
        sampler.sample(dx, dy, dz, out, footprint);
        // The sampler's `detail` is low-frequency (tens of km): the colour grid resolves it.
        const k = typeof sampler.detail === "function" ? sampler.detail(dx, dy, dz) : 1;
        const o = job.cursor * 4;
        job.colour[o] = out.r * k;
        job.colour[o + 1] = out.g * k;
        job.colour[o + 2] = out.b * k;
        job.colour[o + 3] = out.elevation;
        job.cursor++;
        if ((++n & 15) === 0 && over()) return;
      }
      job.phase = 1;
      job.cursor = 0;
    }
    if (job.phase === 1) {
      if (typeof sampler.elevation !== "function") {
        for (let i = 0; i < job.gw * job.gh; i++) job.elev[i] = job.colour[i * 4 + 3]!;
      } else {
        const stepLon = w.lonSpan / (job.ew - 3);
        const stepLat = w.latSpan / (job.eh - 3);
        const footprint = Math.min(stepLat, stepLon) * DEG;
        const total = job.ew * job.eh;
        let n = 0;
        while (job.cursor < total) {
          const b = (job.cursor / job.ew) | 0;
          const a = job.cursor - b * job.ew;
          const lat = clampLat(w.lat0 - (b - 1) * stepLat);
          const lon = w.lon0 + (a - 1) * stepLon;
          const c = Math.cos(lat * DEG);
          job.elev[job.cursor] = sampler.elevation(c * Math.cos(lon * DEG), Math.sin(lat * DEG), c * Math.sin(lon * DEG), footprint);
          job.cursor++;
          if ((++n & 63) === 0 && over()) return;
        }
      }
      this.shadeDetailNodes(job);
      job.phase = 2;
      job.cursor = 0;
      if (over()) return;
    }
    if (job.phase === 2) {
      while (job.cursor < this.detailSize) {
        this.bakeDetailRow(job, job.cursor);
        job.cursor++;
        if (over()) return;
      }
      job.phase = 3;
    }
    // Phase 3: the mesh, then swap everything in at once.
    this.swapDetail(job);
    this.job = null;
  }

  /** The relief multiplier at every elevation node. */
  private shadeDetailNodes(job: DetailJob): void {
    const w = job.window;
    const R = this.radius;
    const eStepLon = w.lonSpan / (job.ew - 3);
    const eStepLat = w.latSpan / (job.eh - 3);
    // The globe's relief multiplier is tuned for its own grid spacing; slopes over finer spacing are
    // steeper, so scale it down with the square root of the spacing ratio to keep the same character.
    const baseCellLat = 180 / Math.max(1, this.bakeRows);
    const relief = this.relief * Math.sqrt(Math.min(1, eStepLat / baseCellLat));
    const nodeLat = (b: number): number => clampLat(w.lat0 - (b - 1) * eStepLat);
    planetReliefShade(
      job.elev, job.ew, job.eh, false,
      (b) => R * DEG * Math.max(0.02, Math.cos(nodeLat(b) * DEG)) * eStepLon,
      R * DEG * eStepLat, relief, this.reliefGain, job.shade,
    );
  }

  /** One row of the patch texture: colour grid × node shade (bicubic), overlay, border fade. */
  private bakeDetailRow(job: DetailJob, y: number): void {
    const P = this.detailSize;
    const w = job.window;
    const lat = w.lat0 - ((y + 0.5) / P) * w.latSpan;
    const cStepLon = w.lonSpan / (job.gw - 3);
    const cStepLat = w.latSpan / (job.gh - 3);
    const eStepLon = w.lonSpan / (job.ew - 3);
    const eStepLat = w.latSpan / (job.eh - 3);
    const overlay = this.overlay && Math.abs(lat) >= this.overlay.minAbsLatDeg ? this.overlay : null;
    const ov = this.overlayOut;
    const cellLon = 360 / this.meshW;
    const cellLat = 180 / this.meshH;
    const fullCircle = w.cellsX >= this.meshW;
    const dLat = Math.min(w.j0 > 0 ? (w.lat0 - lat) / cellLat : Infinity, w.j1 < this.meshH ? (lat - (w.lat0 - w.latSpan)) / cellLat : Infinity);
    const cy = (w.lat0 - lat) / cStepLat + 1;
    const ey = (w.lat0 - lat) / eStepLat + 1;
    const pix = job.pixels;
    const col = job.colour;
    for (let x = 0; x < P; x++) {
      const along = ((x + 0.5) / P) * w.lonSpan;
      const lon = w.lon0 + along;
      // Colour: bilinear in the colour grid.
      const cx = along / cStepLon + 1;
      const i0 = Math.min(job.gw - 2, Math.floor(cx));
      const j0 = Math.min(job.gh - 2, Math.floor(cy));
      const fu = cx - i0;
      const fv = cy - j0;
      const o00 = (j0 * job.gw + i0) * 4, o10 = o00 + 4, o01 = o00 + job.gw * 4, o11 = o01 + 4;
      const w00 = (1 - fu) * (1 - fv), w10 = fu * (1 - fv), w01 = (1 - fu) * fv, w11 = fu * fv;
      let r = col[o00]! * w00 + col[o10]! * w10 + col[o01]! * w01 + col[o11]! * w11;
      let g = col[o00 + 1]! * w00 + col[o10 + 1]! * w10 + col[o01 + 1]! * w01 + col[o11 + 1]! * w11;
      let b = col[o00 + 2]! * w00 + col[o10 + 2]! * w10 + col[o01 + 2]! * w01 + col[o11 + 2]! * w11;
      let k = localGridCubic(job.shade, job.ew, job.eh, along / eStepLon + 1, ey);
      k = k < 0.45 ? 0.45 : k > 1.55 ? 1.55 : k;
      r *= k; g *= k; b *= k;
      if (overlay) {
        overlay.texel(lat, ((lon % 360) + 360) % 360, ov);
        const c = ov.coverage < 0 ? 0 : ov.coverage > 1 ? 1 : ov.coverage;
        r += (ov.r - r) * c;
        g += (ov.g - g) * c;
        b += (ov.b - b) * c;
      }
      // Fade into the globe's own texture across the outermost globe cell, where the shape fades too.
      const dLon = fullCircle ? Infinity : Math.min(along, w.lonSpan - along) / cellLon;
      const t = Math.min(dLat, dLon);
      if (t < 1) {
        const fade = t <= 0 ? 0 : t * t * (3 - 2 * t);
        this.globeTexel(lat, lon, ov);
        r = ov.r + (r - ov.r) * fade;
        g = ov.g + (g - ov.g) * fade;
        b = ov.b + (b - ov.b) * fade;
      }
      const p = (y * P + x) * 4;
      pix[p] = r < 0 ? 0 : r > 255 ? 255 : r;
      pix[p + 1] = g < 0 ? 0 : g > 255 ? 255 : g;
      pix[p + 2] = b < 0 ? 0 : b > 255 ? 255 : b;
      pix[p + 3] = 255;
    }
  }

  /** Bilinear read of the uploaded globe texture (base + overlay) at a latitude/longitude into `out.r/g/b`. */
  private globeTexel(lat: number, lon: number, out: PlanetOverlayTexel): void {
    const W = this.texW;
    const H = this.texH;
    const u = ((((lon % 360) + 360) % 360) / 360) * W - 0.5;
    const v = ((90 - lat) / 180) * H - 0.5;
    const i0 = Math.floor(u);
    const j0 = Math.floor(v);
    const fu = u - i0;
    const fv = v - j0;
    const ja = Math.min(H - 1, Math.max(0, j0)) * W;
    const jb = Math.min(H - 1, Math.max(0, j0 + 1)) * W;
    const ia = ((i0 % W) + W) % W;
    const ib = (ia + 1) % W;
    const f = this.surfaceFinal;
    const a = (ja + ia) * 4, b = (ja + ib) * 4, c = (jb + ia) * 4, d = (jb + ib) * 4;
    const w00 = (1 - fu) * (1 - fv), w10 = fu * (1 - fv), w01 = (1 - fu) * fv, w11 = fu * fv;
    out.r = f[a]! * w00 + f[b]! * w10 + f[c]! * w01 + f[d]! * w11;
    out.g = f[a + 1]! * w00 + f[b + 1]! * w10 + f[c + 1]! * w01 + f[d + 1]! * w11;
    out.b = f[a + 2]! * w00 + f[b + 2]! * w10 + f[c + 2]! * w01 + f[d + 2]! * w11;
  }

  /** Build the patch mesh for a finished job and swap mesh, texture and the globe's hole in together. */
  private swapDetail(job: DetailJob): void {
    const src = this.surfaceSource;
    if (!src || !this.detailGeometry || !this.detailTexture) return;
    const w = job.window;
    const rows = w.j1 - w.j0;
    const eStepLon = w.lonSpan / (job.ew - 3);
    const eStepLat = w.latSpan / (job.eh - 3);
    const mesh = planetDetailMesh(
      w, src.positions, this.meshW, this.meshH,
      Math.max(1, Math.round(this.detailQuads / w.cellsX)), Math.max(1, Math.round(this.detailQuads / rows)),
      this.radius, this.exaggeration,
      (along, lat) => localGridCubic(job.elev, job.ew, job.eh, along / eStepLon + 1, (w.lat0 - lat) / eStepLat + 1),
    );
    const { positions, uvs, tangents, indices } = mesh;
    const normals = computeNormalsAndTangents(positions, indices, uvs).normals;
    this.detailGeometry.updateFrom({ positions, normals, uvs, tangents, indices, label: "planet.detail" });
    uploadChain(this.device, this.detailTexture, job.pixels, this.detailSize, this.detailSize);
    this.surfaceGeometry.updateFrom({ ...src, indices: sphereIndicesWithout(this.meshW, this.meshH, w) });
    this.shown = { window: w, x: job.x, y: job.y, z: job.z, radius: job.radius };
  }

  // ------------------------------------------------------------------------------------- meshes

  /** The surface sphere, displaced by `elevation` (a `cols×rows` grid) when given. */
  private buildSurfaceSource(cols: number, rows: number, elevation: Float32Array | null): SurfaceSource {
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

/** `sphereIndices` with the cells inside `hole` left out (the detail patch draws them). */
function sphereIndicesWithout(ws: number, hs: number, hole: PlanetDetailWindow): Uint32Array {
  const indices = new Uint32Array(ws * hs * 6);
  let k = 0;
  for (let j = 0; j < hs; j++) {
    for (let i = 0; i < ws; i++) {
      if (planetDetailWindowContains(hole, i, j, ws)) continue;
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
  return indices.subarray(0, k);
}

function clampLat(lat: number): number {
  return lat > 90 ? 90 : lat < -90 ? -90 : lat;
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
