/**
 * Planet weather: a season-driven table of weather *events* turned into things a globe and a ground
 * scene can both use — an RGBA cloud/dust layer for the orbit view, the polar caps' surface overlay,
 * and point queries ("what is the sky doing at this latitude/longitude right now?") for a viewer
 * standing on the surface.
 *
 * The engine owns the *system*; a scene owns the *script*. An event is data
 * ({@link PlanetWeatherEventDef}): what kind, where, how big, which part of the year (a window of solar
 * longitude `Ls`, see `planetFrame.ts`), how intense, how it drifts. A table of them is the whole
 * climate; the Mars Orbit Explorer demo ships one (`examples/src/scenes/marsOrbitEvents.ts`) and this
 * file contains no Mars geography.
 *
 * Kinds and what they produce:
 *  - `dust-storm`    — a tan, ragged, drifting plume (opacity in the orbit layer; `dust` at the surface);
 *  - `regional-storm`— a spiral: dust-laden arms with white ice-cloud fringes (a baroclinic storm);
 *  - `ice-cloud`     — a water-ice cloud mass: a disc (orographic cap over a volcano, a basin fog) or a
 *                      latitude band (the aphelion cloud belt, a polar hood);
 *  - `dust-devils`   — no orbit-scale picture; raises `devilActivity` (and a little `dust`) at the surface;
 *  - `frost`         — a thin bright frost patch: white in the orbit layer, `frost` at the surface.
 *
 * Intensity of an event at a given `Ls` is `peak ×` a smooth envelope: a quick rise over the first
 * `attack` fraction of its window and a slower fall over the last `decay` fraction (storms build fast
 * and die slowly). Footprints are great-circle discs (or bands) with a ragged edge from a fixed noise
 * field, advected by `sols` so plumes slide and boil rather than sit.
 *
 * {@link PlanetPolarCaps} models the seasonal CO₂ caps and the residual caps as a latitude edge that
 * follows `Ls` with a ragged boundary, and {@link PlanetPolarCaps.overlay} wraps it for
 * `PlanetGlobe.setSurfaceOverlay`.
 *
 * Everything is CPU and allocation-free per query; the layer rasteriser works in row slices so the
 * renderer can spread it across frames.
 */

import { fbm3 } from "../math/noise.js";
import {
  MARS_ORBIT,
  type PlanetOrbit,
  latLonToDirection,
  localSolarHours,
  solarLongitudeDeg,
  wrapLongitudeDeg,
} from "./planetFrame.js";

const DEG = Math.PI / 180;

// ----------------------------------------------------------------------- shared overlay / layer types

/** Colour one overlay texel contributes (sRGB bytes) and how strongly it covers the base albedo. */
export interface PlanetOverlayTexel {
  coverage: number;
  r: number;
  g: number;
  b: number;
}

/** A per-texel surface overlay (the polar caps) composited by `PlanetGlobe` inside a latitude band. */
export interface PlanetSurfaceOverlay {
  /** Only texels with |latitude| ≥ this are asked (degrees). */
  minAbsLatDeg: number;
  texel(latDeg: number, lonDeg: number, out: PlanetOverlayTexel): PlanetOverlayTexel;
}

/** Fill rows `[row0, row1)` of an RGBA8 layer (sRGB colour, straight alpha) of `width × height`. */
export type PlanetAtmosphereFill = (row0: number, row1: number, width: number, height: number, rgba: Uint8Array) => void;

// -------------------------------------------------------------------------------------------- events

export type PlanetWeatherKind = "dust-storm" | "regional-storm" | "ice-cloud" | "dust-devils" | "frost";

export interface PlanetWeatherEventDef {
  id: string;
  kind: PlanetWeatherKind;
  /** Human-readable name for HUDs. */
  label?: string;
  /** Centre of the footprint (for a band: the latitude of its centre line; longitude is ignored). */
  latDeg: number;
  lonDeg: number;
  /** Footprint radius at full strength, kilometres (for a band: its half-width in kilometres). */
  radiusKm: number;
  /** Treat the footprint as a latitude band `radiusKm` either side of `latDeg` instead of a disc. */
  band?: boolean;
  /** Season window in solar longitude, degrees; `endLs` may be smaller than `startLs` to wrap the year. */
  startLs: number;
  endLs: number;
  /** Peak intensity, 0..1. */
  peak: number;
  /** Fraction of the window spent rising / falling. Defaults 0.25 / 0.4. */
  attack?: number;
  decay?: number;
  /** Centre drift, degrees per sol (east, north). */
  driftLonDegPerSol?: number;
  driftLatDegPerSol?: number;
  /** Spiral sense for `regional-storm`: +1 counter-clockwise seen from above, −1 clockwise. Default +1. */
  swirl?: number;
  /** 0..1: how much the intensity follows local afternoon at the footprint (devils, orographic cloud). Default 0. */
  diurnal?: number;
  /** Noise seed for the ragged edge. Defaults to a hash of the id. */
  seed?: number;
}

/** What the sky and ground are doing at one place and time. All 0..1 unless noted. */
export interface PlanetWeatherSample {
  /** Suspended-dust opacity (drives haze, fog and sun attenuation on the ground). */
  dust: number;
  /** Water-ice cloud cover. */
  iceCloud: number;
  /** Dust-devil activity (spawn rate scale). */
  devilActivity: number;
  /** Thin surface frost. */
  frost: number;
  /** Polar-cap coverage of the surface here. */
  cap: number;
  /** Near-surface wind speed, m/s. */
  windSpeed: number;
  /** The event contributing most, or null when the sky is quiet. */
  dominantId: string | null;
  dominantKind: PlanetWeatherKind | null;
}

export function createPlanetWeatherSample(): PlanetWeatherSample {
  return { dust: 0, iceCloud: 0, devilActivity: 0, frost: 0, cap: 0, windSpeed: 0, dominantId: null, dominantKind: null };
}

const smoothstep = (a: number, b: number, x: number): number => {
  const t = x <= a ? 0 : x >= b ? 1 : (x - a) / (b - a);
  return t * t * (3 - 2 * t);
};
const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);

function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h | 0;
}

/** Position of `ls` inside the window, in degrees from its start, or -1 when outside. */
function windowPosition(startLs: number, endLs: number, ls: number): { pos: number; length: number } | null {
  let length = (((endLs - startLs) % 360) + 360) % 360;
  if (length === 0) length = 360;
  const pos = (((ls - startLs) % 360) + 360) % 360;
  return pos <= length ? { pos, length } : null;
}

/** Envelope 0..1 of an event at solar longitude `ls` (0 outside its window). */
export function planetEventEnvelope(def: Pick<PlanetWeatherEventDef, "startLs" | "endLs" | "attack" | "decay">, ls: number): number {
  const w = windowPosition(def.startLs, def.endLs, ls);
  if (!w) return 0;
  const u = w.pos / w.length;
  const attack = Math.max(0.01, def.attack ?? 0.25);
  const decay = Math.max(0.01, def.decay ?? 0.4);
  return smoothstep(0, attack, u) * (1 - smoothstep(1 - decay, 1, u));
}

// ------------------------------------------------------------------------------------------ polar caps

export interface PlanetPolarCapOptions {
  /** Latitude (degrees) the seasonal cap reaches at its largest, and the residual cap that survives summer. */
  northMaxEdgeDeg?: number;
  northResidualEdgeDeg?: number;
  southMaxEdgeDeg?: number;
  southResidualEdgeDeg?: number;
  /** Solar longitude of each cap's largest extent (the hemisphere's late winter). */
  northPeakLs?: number;
  southPeakLs?: number;
  seed?: number;
}

/**
 * Seasonal CO₂ caps plus residual caps. The edge latitude follows a smooth annual cycle (largest at
 * the hemisphere's late winter, retreating to the residual cap by midsummer) and is ragged in
 * longitude. Defaults are Mars': north 58° → 84°, south −52° → −87°, peaks at Ls 330° and 150°.
 */
export class PlanetPolarCaps {
  readonly northMax: number;
  readonly northResidual: number;
  readonly southMax: number;
  readonly southResidual: number;
  readonly northPeakLs: number;
  readonly southPeakLs: number;
  private readonly seed: number;

  constructor(options: PlanetPolarCapOptions = {}) {
    this.northMax = options.northMaxEdgeDeg ?? 58;
    this.northResidual = options.northResidualEdgeDeg ?? 84;
    this.southMax = options.southMaxEdgeDeg ?? -52;
    this.southResidual = options.southResidualEdgeDeg ?? -87;
    this.northPeakLs = options.northPeakLs ?? 330;
    this.southPeakLs = options.southPeakLs ?? 150;
    this.seed = options.seed ?? 4242;
  }

  /** 0..1 extent of the seasonal cap at `ls` (1 = at its largest). */
  seasonalExtent(peakLs: number, ls: number): number {
    const c = Math.cos(((ls - peakLs) * Math.PI) / 180);
    return Math.pow(clamp01(0.5 + 0.5 * c), 1.15);
  }

  /** Mean cap-edge latitudes (degrees) at `ls`: the northern edge (≥ 0) and the southern edge (≤ 0). */
  edgeLatitudes(ls: number, out: { north: number; south: number } = { north: 0, south: 0 }): { north: number; south: number } {
    const n = this.seasonalExtent(this.northPeakLs, ls);
    const s = this.seasonalExtent(this.southPeakLs, ls);
    out.north = this.northResidual + (this.northMax - this.northResidual) * n;
    out.south = this.southResidual + (this.southMax - this.southResidual) * s;
    return out;
  }

  /** Cap coverage 0..1 at a surface point (a soft edge, ragged in longitude). */
  coverage(latDeg: number, lonDeg: number, ls: number): number {
    const lonR = lonDeg * DEG;
    const rag = fbm3(Math.cos(lonR) * 3, Math.sin(lonR) * 3, latDeg < 0 ? 7.1 : 1.3, this.seed, { octaves: 3 });
    const e = this.edgeLatitudes(ls, scratchEdges);
    if (latDeg >= 0) {
      const edge = e.north + rag * 4.5;
      return smoothstep(edge - 0.7, edge + 0.9, latDeg);
    }
    const edge = e.south - rag * 4.5;
    return smoothstep(-edge - 0.7, -edge + 0.9, -latDeg);
  }

  /**
   * The overlay `PlanetGlobe` composites: bright CO₂/water frost, dustier and slightly darker toward
   * the edge. `getLs` is read per refresh, so the overlay follows the season.
   */
  overlay(getLs: () => number): PlanetSurfaceOverlay {
    return {
      minAbsLatDeg: Math.min(Math.abs(this.northMax), Math.abs(this.southMax)) - 6,
      texel: (lat, lon, out) => {
        const ls = getLs();
        const c = this.coverage(lat, lon, ls);
        out.coverage = c * 0.96;
        // Edge dustiness: partial coverage near the margin reads as dirty frost.
        const dirty = 1 - smoothstep(0.55, 1, c);
        out.r = 244 - 22 * dirty;
        out.g = 240 - 36 * dirty;
        out.b = 238 - 56 * dirty;
        return out;
      },
    };
  }
}
const scratchEdges = { north: 0, south: 0 };

// ----------------------------------------------------------------------------------------- the system

export interface PlanetWeatherSystemOptions {
  events: readonly PlanetWeatherEventDef[];
  orbit?: PlanetOrbit;
  caps?: PlanetPolarCaps;
  /** Planet radius, metres (footprints are specified in km on this sphere). Default 3 389 500. */
  radiusM?: number;
  seed?: number;
  /** Starting time, sols past Ls = 0. Default 0. */
  sols?: number;
}

/** One live event for HUDs: the definition and its current intensity (envelope × peak). */
export interface PlanetActiveEvent {
  def: PlanetWeatherEventDef;
  intensity: number;
}

const DUST_RGB: readonly [number, number, number] = [206, 150, 104];
const ICE_RGB: readonly [number, number, number] = [238, 241, 247];
const FROST_RGB: readonly [number, number, number] = [244, 246, 250];

interface ResolvedEvent {
  def: PlanetWeatherEventDef;
  seed: number;
  swirl: number;
  radiusRad: number;
  /** Recomputed per refresh. */
  env: number;
  intensity: number;
  /** Current centre (drift applied), radians, with its trigonometry; recomputed with the season. */
  lat0: number;
  lon0: number;
  sinLat0: number;
  cosLat0: number;
  cosLon0: number;
  sinLon0: number;
}

export class PlanetWeatherSystem {
  readonly orbit: PlanetOrbit;
  readonly caps: PlanetPolarCaps;
  readonly radiusM: number;
  private readonly seed: number;
  private events: ResolvedEvent[] = [];
  private _sols: number;
  private _ls = 0;
  private lastRefreshSols = Number.NaN;
  private noiseW = 0;
  private noiseH = 0;
  private noiseCloud: Float32Array = new Float32Array(0);
  private noiseDust: Float32Array = new Float32Array(0);
  private noiseFilled = 0; // rows of the static noise built so far
  private cosLonCols: Float32Array = new Float32Array(0);
  private sinLonCols: Float32Array = new Float32Array(0);
  private readonly tmpDir = { x: 0, y: 0, z: 0 };

  constructor(options: PlanetWeatherSystemOptions) {
    this.orbit = options.orbit ?? MARS_ORBIT;
    this.caps = options.caps ?? new PlanetPolarCaps();
    this.radiusM = options.radiusM ?? 3_389_500;
    this.seed = options.seed ?? 1337;
    this._sols = options.sols ?? 0;
    this.setEvents(options.events);
    this.setSols(this._sols);
  }

  get sols(): number {
    return this._sols;
  }

  /** Solar longitude (season) now, degrees. */
  get ls(): number {
    return this._ls;
  }

  get eventDefs(): readonly PlanetWeatherEventDef[] {
    return this.events.map((e) => e.def);
  }

  setEvents(defs: readonly PlanetWeatherEventDef[]): void {
    this.events = defs.map((def) => ({
      def,
      seed: def.seed ?? hashString(def.id),
      swirl: def.swirl ?? 1,
      radiusRad: (def.radiusKm * 1000) / this.radiusM,
      env: 0,
      intensity: 0,
      lat0: 0,
      lon0: 0,
      sinLat0: 0,
      cosLat0: 1,
      cosLon0: 1,
      sinLon0: 0,
    }));
    this.updateEvents();
    this.lastRefreshSols = Number.NaN;
  }

  setSols(sols: number): void {
    this._sols = sols;
    this._ls = solarLongitudeDeg(this.orbit, sols);
    this.updateEvents();
  }

  advance(dSols: number): void {
    this.setSols(this._sols + dSols);
  }

  /** Move to a season (keeps the whole-year count of `sols`). */
  setSolarLongitude(lsDeg: number): void {
    const year = Math.floor(this._sols / this.orbit.yearSols);
    // find sols within the year for this Ls by bisection on the monotone map
    let lo = 0;
    let hi = this.orbit.yearSols;
    for (let i = 0; i < 40; i++) {
      const mid = (lo + hi) * 0.5;
      if (solarLongitudeDeg(this.orbit, mid) < lsDeg % 360) lo = mid;
      else hi = mid;
    }
    this.setSols(year * this.orbit.yearSols + lo);
  }

  /** Events with non-zero intensity right now, strongest first. */
  activeEvents(minIntensity = 0.02): PlanetActiveEvent[] {
    const out: PlanetActiveEvent[] = [];
    for (const e of this.events) if (e.intensity >= minIntensity) out.push({ def: e.def, intensity: e.intensity });
    return out.sort((a, b) => b.intensity - a.intensity);
  }

  /** Current intensity (0..1) of an event by id, 0 when unknown. */
  intensityOf(id: string): number {
    for (const e of this.events) if (e.def.id === id) return e.intensity;
    return 0;
  }

  /** Where an event's centre is now (drift applied): latitude and longitude, degrees. */
  centreOf(id: string, out: { latDeg: number; lonDeg: number } = { latDeg: 0, lonDeg: 0 }): { latDeg: number; lonDeg: number } | null {
    for (const e of this.events) {
      if (e.def.id !== id) continue;
      this.centre(e, out);
      return out;
    }
    return null;
  }

  private updateEvents(): void {
    for (const e of this.events) {
      e.env = planetEventEnvelope(e.def, this._ls);
      e.intensity = e.env * e.def.peak;
      this.centre(e, scratchCentre);
      e.lat0 = scratchCentre.latDeg * DEG;
      e.lon0 = scratchCentre.lonDeg * DEG;
      e.sinLat0 = Math.sin(e.lat0);
      e.cosLat0 = Math.cos(e.lat0);
      e.cosLon0 = Math.cos(e.lon0);
      e.sinLon0 = Math.sin(e.lon0);
    }
  }

  private centre(e: ResolvedEvent, out: { latDeg: number; lonDeg: number }): void {
    const w = windowPosition(e.def.startLs, e.def.endLs, this._ls);
    const solsIn = w ? (w.pos / 360) * this.orbit.yearSols : 0;
    out.lonDeg = wrapLongitudeDeg(e.def.lonDeg + (e.def.driftLonDegPerSol ?? 0) * solsIn);
    out.latDeg = Math.max(-89, Math.min(89, e.def.latDeg + (e.def.driftLatDegPerSol ?? 0) * solsIn));
  }

  // ---------------------------------------------------------------------------------- point query

  /** What the weather is at a surface point right now. Writes into and returns `out`. */
  sample(latDeg: number, lonDeg: number, out: PlanetWeatherSample = createPlanetWeatherSample()): PlanetWeatherSample {
    out.dust = 0;
    out.iceCloud = 0;
    out.devilActivity = 0;
    out.frost = 0;
    out.dominantId = null;
    out.dominantKind = null;
    out.cap = this.caps.coverage(latDeg, lonDeg, this._ls);
    const lat = latDeg * DEG;
    const lon = lonDeg * DEG;
    const sinLat = Math.sin(lat);
    const cosLat = Math.cos(lat);
    const cosLon = Math.cos(lon);
    const sinLon = Math.sin(lon);
    const noiseA = fbm3(cosLat * cosLon * 4, sinLat * 4, cosLat * sinLon * 4, this.seed, { octaves: 3 });
    const hours = localSolarHours(lonDeg, this._sols);
    let best = 0;
    for (const e of this.events) {
      if (e.intensity <= 0.003) continue;
      const shape = this.footprint(e, lat, sinLat, cosLat, cosLon, sinLon, noiseA, scratchFoot);
      if (shape <= 0) continue;
      const diurnal = e.def.diurnal ?? 0;
      // Afternoon peak at 14:00 local solar time.
      const dayFactor = 1 - diurnal + diurnal * (0.5 + 0.5 * Math.cos(((hours - 14) / 24) * Math.PI * 2));
      const v = e.intensity * shape * dayFactor;
      switch (e.def.kind) {
        case "dust-storm":
          out.dust = 1 - (1 - out.dust) * (1 - v);
          break;
        case "regional-storm":
          out.dust = 1 - (1 - out.dust) * (1 - v * 0.55 * scratchFoot.arm);
          out.iceCloud = 1 - (1 - out.iceCloud) * (1 - v * (0.4 + 0.6 * scratchFoot.arm));
          break;
        case "ice-cloud":
          out.iceCloud = 1 - (1 - out.iceCloud) * (1 - v);
          break;
        case "dust-devils":
          out.devilActivity = 1 - (1 - out.devilActivity) * (1 - v);
          out.dust = 1 - (1 - out.dust) * (1 - v * 0.12);
          break;
        case "frost":
          out.frost = 1 - (1 - out.frost) * (1 - v);
          break;
      }
      if (v > best) {
        best = v;
        out.dominantId = e.def.id;
        out.dominantKind = e.def.kind;
      }
    }
    out.frost = Math.max(out.frost, out.cap);
    out.windSpeed = 3.5 + 20 * out.dust + 7 * out.devilActivity + 4 * out.iceCloud;
    return out;
  }

  /**
   * 0..1 footprint of an event at a point (and the spiral-arm factor in `foot.arm`), or 0 outside.
   * `noise` is a −1..1 field value that roughens the edge.
   */
  private footprint(e: ResolvedEvent, lat: number, sinLat: number, cosLat: number, cosLon: number, sinLon: number, noise: number, foot: { arm: number }): number {
    foot.arm = 1;
    const def = e.def;
    if (def.band) {
      const d = Math.abs(lat - e.lat0);
      const r = e.radiusRad * (1 + 0.3 * noise);
      return d >= r ? 0 : 1 - smoothstep(0.45, 1, d / r);
    }
    // A great-circle distance is at least the latitude difference: reject most texels cheaply.
    if (Math.abs(lat - e.lat0) > e.radiusRad * 1.45) return 0;
    const cosD = sinLat * e.sinLat0 + cosLat * e.cosLat0 * (cosLon * e.cosLon0 + sinLon * e.sinLon0);
    const d = Math.acos(Math.max(-1, Math.min(1, cosD)));
    const r = e.radiusRad * (1 + 0.4 * noise);
    const dn = d / r;
    if (dn >= 1) return 0;
    let shape = 1 - smoothstep(0.25, 1, dn);
    if (def.kind === "regional-storm") {
      const sinD = sinLon * e.cosLon0 - cosLon * e.sinLon0; // sin(lon - lon0)
      const cosDl = cosLon * e.cosLon0 + sinLon * e.sinLon0; // cos(lon - lon0)
      const east = sinD * cosLat;
      const north = e.cosLat0 * sinLat - e.sinLat0 * cosLat * cosDl;
      const theta = Math.atan2(north, east);
      const arm = 0.5 + 0.5 * Math.cos(2 * (theta - e.swirl * 3.4 * dn));
      foot.arm = arm;
      shape *= 0.3 + 0.7 * arm;
    }
    return shape;
  }

  // ------------------------------------------------------------------------------- layer rasteriser

  /**
   * Whether the cloud layer should be refilled: the planet has moved by more than `thresholdSols`
   * since the last refill (or it never was). Call `markRefreshed()` when a refill is started.
   */
  needsAtmosphereRefresh(thresholdSols = 0.02): boolean {
    return !(Math.abs(this._sols - this.lastRefreshSols) < thresholdSols);
  }

  markRefreshed(): void {
    this.lastRefreshSols = this._sols;
  }

  /** The {@link PlanetAtmosphereFill} for `PlanetGlobe.setAtmosphereFill`. */
  readonly fillAtmosphere: PlanetAtmosphereFill = (row0, row1, width, height, rgba) => {
    this.ensureNoise(width, height);
    const sols = this._sols;
    // Advection in texels: dust drifts east faster than the ice (different altitudes).
    const dustShift = sols * 14;
    const iceShift = -sols * 6;
    const W = width;
    const H = height;
    const active = this.events.filter((e) => e.intensity > 0.003);
    for (let y = row0; y < row1; y++) {
      const latDeg = 90 - ((y + 0.5) / H) * 180;
      const lat = latDeg * DEG;
      const sinLat = Math.sin(lat);
      const cosLat = Math.cos(lat);
      for (let x = 0; x < W; x++) {
        const o = (y * W + x) * 4;
        const cosLon = this.cosLonCols[x]!;
        const sinLon = this.sinLonCols[x]!;
        const nC = this.noiseCloud[y * W + (((x + Math.floor(iceShift)) % W) + W) % W]!;
        const nD = this.noiseDust[y * W + (((x + Math.floor(dustShift)) % W) + W) % W]!;
        let dust = 0;
        let ice = 0;
        let frost = 0;
        for (let k = 0; k < active.length; k++) {
          const e = active[k]!;
          const shape = this.footprint(e, lat, sinLat, cosLat, cosLon, sinLon, nD, scratchFoot);
          if (shape <= 0) continue;
          const v = e.intensity * shape;
          switch (e.def.kind) {
            case "dust-storm": {
              // Ragged, boiling plume: opacity is modulated by the (advected) dust noise.
              dust = 1 - (1 - dust) * (1 - clamp01(v * (0.62 + 0.55 * nD) * 1.15));
              break;
            }
            case "regional-storm": {
              dust = 1 - (1 - dust) * (1 - clamp01(v * 0.55 * scratchFoot.arm * (0.7 + 0.5 * nD)));
              const m = nC * 0.5 + 0.5;
              ice = 1 - (1 - ice) * (1 - clamp01(smoothstep(0.55 - 0.45 * v, 0.9 - 0.45 * v, m + 0.35 * scratchFoot.arm) * v * 1.2));
              break;
            }
            case "ice-cloud": {
              const m = nC * 0.5 + 0.5;
              const t = 0.8 - 0.6 * v;
              ice = 1 - (1 - ice) * (1 - smoothstep(t, t + 0.24, m + 0.1 * nD) * clamp01(0.3 + 0.9 * v));
              break;
            }
            case "frost":
              frost = 1 - (1 - frost) * (1 - clamp01(v * (0.8 + 0.4 * nC)));
              break;
            default:
              break;
          }
        }
        ice = Math.max(ice, frost * 0.9);
        const aDust = clamp01(dust) * 0.82;
        const aIce = clamp01(ice) * 0.92;
        const a = 1 - (1 - aDust) * (1 - aIce);
        if (a < 0.004) {
          rgba[o] = DUST_RGB[0];
          rgba[o + 1] = DUST_RGB[1];
          rgba[o + 2] = DUST_RGB[2];
          rgba[o + 3] = 0;
          continue;
        }
        const wIce = aIce / (aIce + aDust + 1e-6);
        const ir = frost > 0.05 ? FROST_RGB[0] : ICE_RGB[0];
        rgba[o] = DUST_RGB[0] + (ir - DUST_RGB[0]) * wIce;
        rgba[o + 1] = DUST_RGB[1] + (ICE_RGB[1] - DUST_RGB[1]) * wIce;
        rgba[o + 2] = DUST_RGB[2] + (ICE_RGB[2] - DUST_RGB[2]) * wIce;
        rgba[o + 3] = Math.round(a * 255);
      }
    }
  };

  /** Static noise the rasteriser samples (built lazily, one band of rows per call until complete). */
  private ensureNoise(width: number, height: number): void {
    if (this.noiseW === width && this.noiseH === height && this.noiseFilled >= height) return;
    if (this.noiseW !== width || this.noiseH !== height) {
      this.noiseW = width;
      this.noiseH = height;
      this.noiseCloud = new Float32Array(width * height);
      this.noiseDust = new Float32Array(width * height);
      this.cosLonCols = new Float32Array(width);
      this.sinLonCols = new Float32Array(width);
      for (let x = 0; x < width; x++) {
        const lon = ((x + 0.5) / width) * 2 * Math.PI;
        this.cosLonCols[x] = Math.cos(lon);
        this.sinLonCols[x] = Math.sin(lon);
      }
      this.noiseFilled = 0;
    }
    // Build everything at once the first time (131k × two fbm, ~0.15 s) — the first fill is the
    // only one that pays it, and the globe fills in row slices so it is spread over its first frames
    // by the caller starting the fill after the planet has baked.
    const dir = this.tmpDir;
    for (let y = this.noiseFilled; y < height; y++) {
      const latDeg = 90 - ((y + 0.5) / height) * 180;
      for (let x = 0; x < width; x++) {
        const lonDeg = ((x + 0.5) / width) * 360;
        latLonToDirection(latDeg, lonDeg, dir);
        this.noiseCloud[y * width + x] = fbm3(dir.x * 5, dir.y * 5, dir.z * 5, this.seed + 11, { octaves: 5, gain: 0.55 });
        this.noiseDust[y * width + x] = fbm3(dir.x * 3.2, dir.y * 3.2, dir.z * 3.2, this.seed + 29, { octaves: 4 });
      }
      this.noiseFilled = y + 1;
    }
  }
}

const scratchFoot = { arm: 1 };
const scratchCentre = { latDeg: 0, lonDeg: 0 };
