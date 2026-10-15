/**
 * Spline-carved tracks (fe-37): a road or trail laid along a closed or open Catmull-Rom spline and
 * carved into any height function, with a crowned bed, tyre ruts, a shoulder, raised berms on both
 * sides, and a smooth blend back to the natural ground.
 *
 * Pieces:
 * - {@link TrackSpline}: the centreline, resampled at a fixed arc-length step, with a uniform-grid
 *   index so {@link TrackSpline.project} (nearest centreline point + signed lateral offset) is O(1)
 *   for points near the track and returns `dist = Infinity` for points outside the corridor.
 * - {@link TrackTerrain}: `heightAt` / `normalAt` / `surfaceAt` over the carved surface. The road
 *   bed elevation is the natural height under the centreline, box-filtered along the track
 *   (`bedSmoothing` metres) so the road rises and falls over crests without following every bump.
 *   This is the function the vehicle's ground query, the physics heightfield and the meshes share,
 *   so berms are real collision: wheels climb them and the chassis rolls off them.
 * - Mesh sources: {@link trackRibbonSource} (road / berm strips that follow the spline, UV `u`
 *   across, `v` along in metres) and {@link trackTerrainGridSource} (the surrounding ground, sunk a
 *   little under the corridor so the ribbons always cover it).
 * - {@link scatterAlongTrack}: deterministic placements in a lateral band (trees, leaf litter,
 *   posts) and {@link litterQuadsSource} to merge small flat litter cards into one mesh.
 *
 * Contract: the corridor profile is a function of `|lateral|` (symmetric). Keep curve radii larger
 * than the corridor half-width (`roadHalfWidth + shoulder + bermWidth + blendWidth`) and keep
 * separate legs of the track at least twice that apart, or the nearest-point projection will
 * switch legs mid-corridor (a visible crease). {@link TrackTerrain.minLegSeparation} reports it.
 */

import type { GeometrySource } from "../rendering/geometry.js";
import { Rng } from "../math/rng.js";
import { clamp, smoothstep } from "../math/scalar.js";

export interface TrackPoint {
  x: number;
  z: number;
}

export interface TrackSplineOptions {
  /** Close the loop (last point joins the first). Default true. */
  closed?: boolean;
  /** Arc-length resample step in metres. Default 0.5. */
  step?: number;
}

/** Result of {@link TrackSpline.project}. */
export interface TrackProjection {
  /** Arc length of the nearest centreline point. */
  s: number;
  /** Signed lateral offset: positive to the right of travel (tangent × up). */
  lateral: number;
  /** Absolute distance to the centreline; Infinity when outside the indexed corridor. */
  dist: number;
  /** Index of the segment start sample. */
  index: number;
}

function catmull(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const t2 = t * t;
  const t3 = t2 * t;
  return 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
}

export class TrackSpline {
  readonly closed: boolean;
  readonly step: number;
  /** Sample positions, tangents (unit) and arc length. */
  readonly px: Float64Array;
  readonly pz: Float64Array;
  readonly tx: Float64Array;
  readonly tz: Float64Array;
  readonly s: Float64Array;
  readonly length: number;
  private grid = new Map<number, number[]>();
  private cell = 16;
  private indexRadius = 0;

  constructor(points: readonly TrackPoint[], options: TrackSplineOptions = {}) {
    if (points.length < (options.closed === false ? 2 : 3)) throw new Error("TrackSpline: not enough control points");
    this.closed = options.closed ?? true;
    this.step = Math.max(0.05, options.step ?? 0.5);
    const n = points.length;
    const at = (i: number): TrackPoint => {
      if (this.closed) return points[((i % n) + n) % n]!;
      return points[clamp(i, 0, n - 1)]!;
    };
    // Dense polyline first, then resample at a uniform arc length.
    const dense: number[] = [];
    const spans = this.closed ? n : n - 1;
    const sub = 64;
    for (let i = 0; i < spans; i++) {
      const a = at(i - 1), b = at(i), c = at(i + 1), d = at(i + 2);
      for (let k = 0; k < sub; k++) {
        const t = k / sub;
        dense.push(catmull(a.x, b.x, c.x, d.x, t), catmull(a.z, b.z, c.z, d.z, t));
      }
    }
    if (this.closed) dense.push(dense[0]!, dense[1]!);
    else dense.push(at(n - 1).x, at(n - 1).z);
    const dl: number[] = [0];
    for (let i = 2; i < dense.length; i += 2) {
      dl.push(dl[dl.length - 1]! + Math.hypot(dense[i]! - dense[i - 2]!, dense[i + 1]! - dense[i - 1]!));
    }
    const total = dl[dl.length - 1]!;
    const count = Math.max(2, Math.round(total / this.step));
    const realStep = total / count;
    const samples = this.closed ? count : count + 1;
    this.px = new Float64Array(samples);
    this.pz = new Float64Array(samples);
    this.tx = new Float64Array(samples);
    this.tz = new Float64Array(samples);
    this.s = new Float64Array(samples);
    let j = 0;
    for (let i = 0; i < samples; i++) {
      const target = i * realStep;
      while (j < dl.length - 2 && dl[j + 1]! < target) j++;
      const seg = dl[j + 1]! - dl[j]! || 1;
      const f = clamp((target - dl[j]!) / seg, 0, 1);
      this.px[i] = dense[2 * j]! + (dense[2 * j + 2]! - dense[2 * j]!) * f;
      this.pz[i] = dense[2 * j + 1]! + (dense[2 * j + 3]! - dense[2 * j + 1]!) * f;
      this.s[i] = target;
    }
    this.length = total;
    (this as { step: number }).step = realStep;
    for (let i = 0; i < samples; i++) {
      const a = this.closed ? (i - 1 + samples) % samples : Math.max(0, i - 1);
      const b = this.closed ? (i + 1) % samples : Math.min(samples - 1, i + 1);
      const dx = this.px[b]! - this.px[a]!;
      const dz = this.pz[b]! - this.pz[a]!;
      const len = Math.hypot(dx, dz) || 1;
      this.tx[i] = dx / len;
      this.tz[i] = dz / len;
    }
  }

  get sampleCount(): number {
    return this.px.length;
  }

  get segmentCount(): number {
    return this.closed ? this.px.length : this.px.length - 1;
  }

  /** Wrap (closed) or clamp (open) a sample index. */
  wrapIndex(i: number): number {
    const n = this.px.length;
    return this.closed ? ((i % n) + n) % n : clamp(i, 0, n - 1);
  }

  /** Wrap (closed) or clamp (open) an arc length into [0, length]. */
  wrapS(s: number): number {
    const L = this.length;
    return this.closed ? ((s % L) + L) % L : clamp(s, 0, L);
  }

  /** Position and unit tangent at arc length `s`. */
  sampleAt(s: number, out: { x: number; z: number; tx: number; tz: number }): typeof out {
    const u = this.wrapS(s) / this.step;
    const i = Math.floor(u);
    const f = u - i;
    const a = this.wrapIndex(i);
    const b = this.wrapIndex(i + 1);
    out.x = this.px[a]! + (this.px[b]! - this.px[a]!) * f;
    out.z = this.pz[a]! + (this.pz[b]! - this.pz[a]!) * f;
    const tx = this.tx[a]! + (this.tx[b]! - this.tx[a]!) * f;
    const tz = this.tz[a]! + (this.tz[b]! - this.tz[a]!) * f;
    const len = Math.hypot(tx, tz) || 1;
    out.tx = tx / len;
    out.tz = tz / len;
    return out;
  }

  /** Index every segment into grid cells within `radius` metres; `project` only answers inside it. */
  buildIndex(radius: number, cellSize = 16): void {
    this.grid.clear();
    this.cell = cellSize;
    this.indexRadius = radius;
    const n = this.px.length;
    for (let i = 0; i < this.segmentCount; i++) {
      const b = (i + 1) % n;
      const x0 = Math.min(this.px[i]!, this.px[b]!) - radius;
      const x1 = Math.max(this.px[i]!, this.px[b]!) + radius;
      const z0 = Math.min(this.pz[i]!, this.pz[b]!) - radius;
      const z1 = Math.max(this.pz[i]!, this.pz[b]!) + radius;
      for (let cx = Math.floor(x0 / cellSize); cx <= Math.floor(x1 / cellSize); cx++) {
        for (let cz = Math.floor(z0 / cellSize); cz <= Math.floor(z1 / cellSize); cz++) {
          const key = cx * 73856093 + cz * 19349663;
          let list = this.grid.get(key);
          if (!list) this.grid.set(key, (list = []));
          list.push(i);
        }
      }
    }
  }

  /** Nearest centreline point. Call {@link buildIndex} first. Alloc-free when `out` is reused. */
  project(x: number, z: number, out: TrackProjection): TrackProjection {
    out.dist = Infinity;
    out.s = 0;
    out.lateral = 0;
    out.index = -1;
    const key = Math.floor(x / this.cell) * 73856093 + Math.floor(z / this.cell) * 19349663;
    const list = this.grid.get(key);
    if (!list) return out;
    const n = this.px.length;
    let best = Infinity;
    for (let k = 0; k < list.length; k++) {
      const i = list[k]!;
      const b = (i + 1) % n;
      const ax = this.px[i]!, az = this.pz[i]!;
      const ex = this.px[b]! - ax, ez = this.pz[b]! - az;
      const len2 = ex * ex + ez * ez || 1e-9;
      const t = clamp(((x - ax) * ex + (z - az) * ez) / len2, 0, 1);
      const qx = ax + ex * t, qz = az + ez * t;
      const d2 = (x - qx) * (x - qx) + (z - qz) * (z - qz);
      if (d2 < best) {
        best = d2;
        out.index = i;
        out.s = this.s[i]! + t * Math.sqrt(len2);
        // Right of travel = tangent rotated −90° about +Y: (tz, −tx)… +Y up, +Z forward → right is +X.
        const len = Math.sqrt(len2);
        out.lateral = ((x - qx) * ez - (z - qz) * ex) / len;
      }
    }
    const d = Math.sqrt(best);
    if (d > this.indexRadius) {
      out.dist = Infinity;
      return out;
    }
    out.dist = d;
    if (Math.abs(out.lateral) < d * 0.999) out.lateral = Math.sign(out.lateral || 1) * d;
    return out;
  }
}

export interface TrackProfileParams {
  /** Half the running surface width. Default 2.2 m. */
  roadHalfWidth?: number;
  /** Centre crown above the edges. Default 0.05 m. */
  crown?: number;
  /** Tyre rut depth. Default 0.06 m. */
  rutDepth?: number;
  /** Rut centre distance from the centreline. Default 0.8 m. */
  rutOffset?: number;
  /** Rut half width. Default 0.32 m. */
  rutWidth?: number;
  /** Flat shoulder between road edge and berm toe. Default 0.5 m. */
  shoulder?: number;
  /** Berm crest height above the road bed. Default 0.8 m. */
  bermHeight?: number;
  /** Berm base width (toe to toe). Default 2.8 m. */
  bermWidth?: number;
  /** Distance beyond the berm over which the surface eases back to natural ground. Default 7 m. */
  blendWidth?: number;
  /** Along-track window (m) of the bed elevation smoothing. Default 30 m. */
  bedSmoothing?: number;
  /** Per-sample berm height variation (0..1). Default 0.15. */
  bermVariation?: number;
  /** Seed for berm variation. Default 1. */
  seed?: number;
}

/** Surface classification at a point. Weights are 0..1 and need not sum to 1. */
export interface TrackSurfaceSample {
  road: number;
  rut: number;
  berm: number;
  /** Signed lateral offset (Infinity outside the corridor). */
  lateral: number;
  s: number;
}

type ResolvedProfile = Required<TrackProfileParams>;

function resolveProfile(p: TrackProfileParams): ResolvedProfile {
  return {
    roadHalfWidth: p.roadHalfWidth ?? 2.2,
    crown: p.crown ?? 0.05,
    rutDepth: p.rutDepth ?? 0.06,
    rutOffset: p.rutOffset ?? 0.8,
    rutWidth: p.rutWidth ?? 0.32,
    shoulder: p.shoulder ?? 0.5,
    bermHeight: p.bermHeight ?? 0.8,
    bermWidth: p.bermWidth ?? 2.8,
    blendWidth: p.blendWidth ?? 7,
    bedSmoothing: p.bedSmoothing ?? 30,
    bermVariation: p.bermVariation ?? 0.15,
    seed: p.seed ?? 1,
  };
}

/** A height function with a track carved into it. */
export class TrackTerrain {
  readonly profile: ResolvedProfile;
  /** Smoothed road bed elevation per spline sample. */
  readonly bed: Float64Array;
  /** Berm crest height per sample (with variation). */
  readonly bermCrest: Float64Array;
  private readonly proj: TrackProjection = { s: 0, lateral: 0, dist: Infinity, index: -1 };

  constructor(
    readonly base: (x: number, z: number) => number,
    readonly spline: TrackSpline,
    params: TrackProfileParams = {},
  ) {
    this.profile = resolveProfile(params);
    const n = spline.sampleCount;
    const raw = new Float64Array(n);
    for (let i = 0; i < n; i++) raw[i] = base(spline.px[i]!, spline.pz[i]!);
    // Two box-filter passes ≈ a triangle filter: crests stay rounded, no grade kinks.
    const half = Math.max(1, Math.round(this.profile.bedSmoothing / 2 / spline.step));
    let cur = raw;
    for (let pass = 0; pass < 2; pass++) {
      const next = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        let sum = 0;
        let cnt = 0;
        for (let k = -half; k <= half; k++) {
          sum += cur[spline.wrapIndex(i + k)]!;
          cnt++;
        }
        next[i] = sum / cnt;
      }
      cur = next;
    }
    this.bed = cur;
    this.bermCrest = new Float64Array(n);
    const rng = new Rng(this.profile.seed);
    // Smooth random walk so berm height wanders gently along the track.
    const knots = Math.max(4, Math.round(spline.length / 18));
    const kv: number[] = [];
    for (let k = 0; k < knots; k++) kv.push(rng.nextFloat() * 2 - 1);
    for (let i = 0; i < n; i++) {
      const u = (spline.s[i]! / spline.length) * (spline.closed ? knots : knots - 1);
      const k0 = Math.floor(u);
      const f = smoothstep(0, 1, u - k0);
      const a = kv[k0 % knots]!;
      const b = kv[spline.closed ? (k0 + 1) % knots : Math.min(knots - 1, k0 + 1)]!;
      this.bermCrest[i] = this.profile.bermHeight * (1 + this.profile.bermVariation * (a + (b - a) * f));
    }
    spline.buildIndex(this.corridorHalfWidth);
  }

  /** Lateral distance from the centreline where the surface is fully natural again. */
  get corridorHalfWidth(): number {
    const p = this.profile;
    return p.roadHalfWidth + p.shoulder + p.bermWidth + p.blendWidth;
  }

  /** Lateral distance of the outer berm toe. */
  get bermOuterEdge(): number {
    const p = this.profile;
    return p.roadHalfWidth + p.shoulder + p.bermWidth;
  }

  /** Bed elevation at arc length `s` (linear between samples). */
  bedAt(s: number): number {
    const u = this.spline.wrapS(s) / this.spline.step;
    const i = Math.floor(u);
    const a = this.bed[this.spline.wrapIndex(i)]!;
    const b = this.bed[this.spline.wrapIndex(i + 1)]!;
    return a + (b - a) * (u - i);
  }

  private crestAt(s: number): number {
    const u = this.spline.wrapS(s) / this.spline.step;
    const i = Math.floor(u);
    const a = this.bermCrest[this.spline.wrapIndex(i)]!;
    const b = this.bermCrest[this.spline.wrapIndex(i + 1)]!;
    return a + (b - a) * (u - i);
  }

  /** Corridor shape above the bed at |lateral| `d` (crown, ruts, shoulder, berm). */
  profileAt(d: number, crest = this.profile.bermHeight): number {
    const p = this.profile;
    const ad = Math.abs(d);
    let y = 0;
    if (ad < p.roadHalfWidth) {
      const r = ad / p.roadHalfWidth;
      y += p.crown * (1 - r * r);
      const q = (ad - p.rutOffset) / p.rutWidth;
      if (Math.abs(q) < 1) {
        const w = 1 - q * q;
        y -= p.rutDepth * w * w;
      }
    }
    const toe = p.roadHalfWidth + p.shoulder;
    const halfB = p.bermWidth / 2;
    const q = (ad - toe - halfB) / halfB;
    if (Math.abs(q) < 1) y += crest * 0.5 * (1 + Math.cos(Math.PI * q));
    return y;
  }

  /** Height at (x, z) given natural height `natural` and a projection. */
  private heightFrom(x: number, z: number, pr: TrackProjection): number {
    const natural = this.base(x, z);
    if (!Number.isFinite(pr.dist)) return natural;
    const d = pr.dist;
    const edge = this.bermOuterEdge;
    const t = smoothstep(edge, edge + this.profile.blendWidth, d);
    const corridor = this.bedAt(pr.s) + this.profileAt(d, this.crestAt(pr.s));
    return corridor + (natural - corridor) * t;
  }

  heightAt(x: number, z: number): number {
    return this.heightFrom(x, z, this.spline.project(x, z, this.proj));
  }

  /** Height at a lateral offset from the centreline sample at `s` (no projection: stable for meshes). */
  heightAtOffset(s: number, lateral: number, out?: { x: number; z: number }): number {
    const c = this.spline.sampleAt(s, scratchSample);
    // Right of travel: (tz, −tx).
    const x = c.x + c.tz * lateral;
    const z = c.z - c.tx * lateral;
    if (out) {
      out.x = x;
      out.z = z;
    }
    const natural = this.base(x, z);
    const d = Math.abs(lateral);
    const edge = this.bermOuterEdge;
    const t = smoothstep(edge, edge + this.profile.blendWidth, d);
    const corridor = this.bedAt(s) + this.profileAt(d, this.crestAt(s));
    return corridor + (natural - corridor) * t;
  }

  /** Unit normal by central differences. */
  normalAt(x: number, z: number, out: { x: number; y: number; z: number }, step = 0.25): typeof out {
    const dx = (this.heightAt(x + step, z) - this.heightAt(x - step, z)) / (2 * step);
    const dz = (this.heightAt(x, z + step) - this.heightAt(x, z - step)) / (2 * step);
    const len = Math.hypot(dx, 1, dz);
    out.x = -dx / len;
    out.y = 1 / len;
    out.z = -dz / len;
    return out;
  }

  /** Classify the surface (road / rut / berm weights) for grip, audio, dust or scatter rules. */
  surfaceAt(x: number, z: number, out: TrackSurfaceSample): TrackSurfaceSample {
    const pr = this.spline.project(x, z, this.proj);
    out.lateral = Number.isFinite(pr.dist) ? pr.lateral : Infinity;
    out.s = pr.s;
    out.road = out.rut = out.berm = 0;
    if (!Number.isFinite(pr.dist)) return out;
    const p = this.profile;
    const d = pr.dist;
    out.road = 1 - smoothstep(p.roadHalfWidth, p.roadHalfWidth + 0.3, d);
    const q = Math.abs(d - p.rutOffset) / p.rutWidth;
    out.rut = d < p.roadHalfWidth ? Math.max(0, 1 - q) : 0;
    const toe = p.roadHalfWidth + p.shoulder;
    out.berm = smoothstep(toe - 0.1, toe + 0.3, d) * (1 - smoothstep(this.bermOuterEdge, this.bermOuterEdge + 1, d));
    return out;
  }

  /**
   * Smallest distance between centreline samples that are more than `corridor·π` apart along the
   * track: if this is below `2·corridorHalfWidth`, two legs share corridor and will crease.
   */
  minLegSeparation(): number {
    const sp = this.spline;
    const n = sp.sampleCount;
    const skip = Math.ceil((this.corridorHalfWidth * Math.PI) / sp.step);
    let best = Infinity;
    const stride = Math.max(1, Math.round(2 / sp.step));
    for (let i = 0; i < n; i += stride) {
      for (let j = i + skip; j < n; j += stride) {
        if (sp.closed && n - (j - i) < skip) continue;
        best = Math.min(best, Math.hypot(sp.px[i]! - sp.px[j]!, sp.pz[i]! - sp.pz[j]!));
      }
    }
    return best;
  }

  /** World position of the centreline surface at `s` plus heading (radians, 0 = +Z, +X positive). */
  poseAt(s: number): { x: number; y: number; z: number; yaw: number } {
    const c = this.spline.sampleAt(s, scratchSample);
    return { x: c.x, y: this.heightAt(c.x, c.z), z: c.z, yaw: Math.atan2(c.tx, c.tz) };
  }
}

const scratchSample = { x: 0, z: 0, tx: 0, tz: 1 };

export interface TrackRibbonOptions {
  /** Lateral offset of the ribbon's u = 0 edge (negative = left of travel). */
  from: number;
  /** Lateral offset of the u = 1 edge. */
  to: number;
  /** Vertices across. Default 12. */
  across?: number;
  /** Metres between rows along the track. Default the spline step × 2. */
  alongStep?: number;
  /** Vertical lift over the carved surface (to sit above the ground grid). Default 0.03. */
  lift?: number;
  /** Metres along the track per texture repeat in v. Default 8. */
  uvMetersAlong?: number;
  label?: string;
}

/** Strip following the spline between two lateral offsets, sampling the carved surface. */
export function trackRibbonSource(track: TrackTerrain, opts: TrackRibbonOptions): GeometrySource {
  const sp = track.spline;
  const across = Math.max(2, opts.across ?? 12);
  const step = opts.alongStep ?? sp.step * 2;
  const rows = Math.max(2, Math.round(sp.length / step) + (sp.closed ? 1 : 1));
  const realStep = sp.length / (rows - 1);
  const lift = opts.lift ?? 0.03;
  const uvAlong = opts.uvMetersAlong ?? 8;
  const positions = new Float32Array(rows * across * 3);
  const normals = new Float32Array(rows * across * 3);
  const uvs = new Float32Array(rows * across * 2);
  const tangents = new Float32Array(rows * across * 4);
  const uSign = opts.to >= opts.from ? 1 : -1;
  const pos = { x: 0, z: 0 };
  const nrm = { x: 0, y: 1, z: 0 };
  const h = 0.2;
  for (let r = 0; r < rows; r++) {
    const s = Math.min(sp.length, r * realStep);
    const c = sp.sampleAt(s, { x: 0, z: 0, tx: 0, tz: 1 });
    for (let a = 0; a < across; a++) {
      const u = a / (across - 1);
      const lat = opts.from + (opts.to - opts.from) * u;
      const y = track.heightAtOffset(s, lat, pos);
      const k = (r * across + a) * 3;
      positions[k] = pos.x;
      positions[k + 1] = y + lift;
      positions[k + 2] = pos.z;
      // Normal from the profile directly (along + across differences), independent of projection.
      const yl = track.heightAtOffset(s, lat - h);
      const yr = track.heightAtOffset(s, lat + h);
      const yb = track.heightAtOffset(s - h, lat);
      const yf = track.heightAtOffset(s + h, lat);
      const dLat = (yr - yl) / (2 * h);
      const dS = (yf - yb) / (2 * h);
      // World gradient: lateral axis = (tz, −tx), along = (tx, tz).
      const gx = dLat * c.tz + dS * c.tx;
      const gz = -dLat * c.tx + dS * c.tz;
      const len = Math.hypot(gx, 1, gz);
      nrm.x = -gx / len;
      nrm.y = 1 / len;
      nrm.z = -gz / len;
      normals[k] = nrm.x;
      normals[k + 1] = nrm.y;
      normals[k + 2] = nrm.z;
      uvs[(r * across + a) * 2] = u;
      uvs[(r * across + a) * 2 + 1] = s / uvAlong;
      // Tangent = +u direction (lateral axis, toward `to`) projected onto the surface.
      writeTangent(tangents, (r * across + a) * 4, nrm, uSign * c.tz, uSign * -c.tx, c.tx, c.tz);
    }
  }
  const indices = new Uint32Array((rows - 1) * (across - 1) * 6);
  let o = 0;
  // Winding: the renderer uses frontFace "cw" for outward faces seen from above.
  const flip = opts.to < opts.from;
  for (let r = 0; r < rows - 1; r++) {
    for (let a = 0; a < across - 1; a++) {
      const i0 = r * across + a, i1 = i0 + 1, i2 = i0 + across, i3 = i2 + 1;
      if (!flip) {
        indices[o++] = i0; indices[o++] = i2; indices[o++] = i1;
        indices[o++] = i1; indices[o++] = i2; indices[o++] = i3;
      } else {
        indices[o++] = i0; indices[o++] = i1; indices[o++] = i2;
        indices[o++] = i1; indices[o++] = i3; indices[o++] = i2;
      }
    }
  }
  return { positions, normals, uvs, tangents, indices, label: opts.label ?? "track-ribbon" };
}

/**
 * Tangent (xyzw) from a horizontal +u direction (ux, uz) and +v direction (vx, vz): the +u axis
 * projected onto the surface plane, with w the handedness of (N, T, +v).
 */
function writeTangent(out: Float32Array, o: number, n: { x: number; y: number; z: number }, ux: number, uz: number, vx: number, vz: number): void {
  const d = n.x * ux + n.z * uz;
  let tx = ux - n.x * d, ty = -n.y * d, tz = uz - n.z * d;
  const len = Math.hypot(tx, ty, tz) || 1;
  tx /= len; ty /= len; tz /= len;
  // (N × T) · B
  const cx = n.y * tz - n.z * ty, cz = n.x * ty - n.y * tx;
  out[o] = tx;
  out[o + 1] = ty;
  out[o + 2] = tz;
  out[o + 3] = cx * vx + cz * vz >= 0 ? 1 : -1;
}

export interface TrackGridOptions {
  /** Sink the grid under the corridor (to `sinkTo` lateral) so ribbons always cover it. Default 0.12 m. */
  corridorSink?: number;
  /** Lateral distance where the sink reaches zero. Default the berm outer edge + 1 m. */
  sinkTo?: number;
  /** Metres per UV repeat. Default 8. */
  uvScale?: number;
  label?: string;
}

/** Regular ground grid over the carved surface. */
export function trackTerrainGridSource(
  track: TrackTerrain,
  centerX: number,
  centerZ: number,
  size: number,
  segments: number,
  opts: TrackGridOptions = {},
): GeometrySource {
  const n = segments + 1;
  const sink = opts.corridorSink ?? 0.12;
  const sinkTo = opts.sinkTo ?? track.bermOuterEdge + 1;
  const uvScale = opts.uvScale ?? 8;
  const positions = new Float32Array(n * n * 3);
  const normals = new Float32Array(n * n * 3);
  const uvs = new Float32Array(n * n * 2);
  const tangents = new Float32Array(n * n * 4);
  const pr: TrackProjection = { s: 0, lateral: 0, dist: Infinity, index: -1 };
  const nrm = { x: 0, y: 1, z: 0 };
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const x = centerX - size / 2 + (size * i) / segments;
      const z = centerZ - size / 2 + (size * j) / segments;
      let y = track.heightAt(x, z);
      track.spline.project(x, z, pr);
      if (Number.isFinite(pr.dist)) y -= sink * (1 - smoothstep(sinkTo - 1, sinkTo, pr.dist));
      const k = (j * n + i) * 3;
      positions[k] = x;
      positions[k + 1] = y;
      positions[k + 2] = z;
      track.normalAt(x, z, nrm, size / segments);
      normals[k] = nrm.x;
      normals[k + 1] = nrm.y;
      normals[k + 2] = nrm.z;
      uvs[(j * n + i) * 2] = x / uvScale;
      uvs[(j * n + i) * 2 + 1] = z / uvScale;
      writeTangent(tangents, (j * n + i) * 4, nrm, 1, 0, 0, 1);
    }
  }
  const indices = new Uint32Array(segments * segments * 6);
  let o = 0;
  for (let j = 0; j < segments; j++) {
    for (let i = 0; i < segments; i++) {
      const a = j * n + i, b = a + 1, c = a + n, d = c + 1;
      indices[o++] = a; indices[o++] = c; indices[o++] = b;
      indices[o++] = b; indices[o++] = c; indices[o++] = d;
    }
  }
  return { positions, normals, uvs, tangents, indices, label: opts.label ?? "track-terrain" };
}

export interface TrackScatterOptions {
  seed?: number;
  /** Lateral band (absolute distance from centreline). */
  lateralMin: number;
  lateralMax: number;
  /** Instances per square metre of band. */
  density: number;
  /** Optional density multiplier by |lateral| (e.g. litter piles up at the road edge). */
  weight?: (absLateral: number, s: number) => number;
  /** Only one side: -1 left, +1 right, 0 both. Default 0. */
  side?: -1 | 0 | 1;
  scaleMin?: number;
  scaleMax?: number;
  /** Number of palette slots to assign (0..n-1). Default 1. */
  palettes?: number;
  /** Hard cap. Default 200 000. */
  maxCount?: number;
}

export interface TrackPlacement {
  x: number;
  y: number;
  z: number;
  /** Yaw in radians. */
  yaw: number;
  scale: number;
  palette: number;
  lateral: number;
  s: number;
  /** 0..1 free random for the caller's own variation. */
  random: number;
}

/**
 * Deterministic placements in a lateral band along the track (both sides by default). The same
 * options always produce the same array. Points that are nearer another leg of the track than
 * their own are rejected, so a forest band never lands on the road of a neighbouring leg.
 */
export function scatterAlongTrack(track: TrackTerrain, opts: TrackScatterOptions): TrackPlacement[] {
  const sp = track.spline;
  const rng = new Rng(opts.seed ?? 1);
  const width = Math.max(0, opts.lateralMax - opts.lateralMin);
  const sides = opts.side ? 1 : 2;
  const expected = sp.length * width * sides * opts.density;
  const count = Math.min(opts.maxCount ?? 200_000, Math.round(expected));
  const out: TrackPlacement[] = [];
  const pr: TrackProjection = { s: 0, lateral: 0, dist: Infinity, index: -1 };
  const pos = { x: 0, z: 0 };
  const smin = opts.scaleMin ?? 1;
  const smax = opts.scaleMax ?? 1;
  const palettes = Math.max(1, opts.palettes ?? 1);
  for (let k = 0; k < count; k++) {
    // Fixed draw count per candidate: determinism independent of rejection.
    const s = rng.nextFloat() * sp.length;
    const lat = opts.lateralMin + rng.nextFloat() * width;
    const sideRoll = rng.nextFloat();
    const yaw = rng.nextFloat() * Math.PI * 2;
    const sc = smin + (smax - smin) * rng.nextFloat();
    const pal = Math.min(palettes - 1, Math.floor(rng.nextFloat() * palettes));
    const keep = rng.nextFloat();
    const random = rng.nextFloat();
    const side = opts.side || (sideRoll < 0.5 ? -1 : 1);
    if (opts.weight && keep > opts.weight(lat, s)) continue;
    const y = track.heightAtOffset(s, side * lat, pos);
    sp.project(pos.x, pos.z, pr);
    if (Number.isFinite(pr.dist) && pr.dist < lat - 0.5) continue; // another leg is closer
    out.push({ x: pos.x, y, z: pos.z, yaw, scale: sc, palette: pal, lateral: side * lat, s, random });
  }
  return out;
}

/**
 * Merge small flat cards (leaf litter, twigs) lying on the surface into one mesh. Each card is a
 * `size × size·aspect` quad tilted to the local surface normal, lifted `lift` metres. Pass a subset
 * of placements (e.g. one palette) to build one mesh per material.
 */
export function litterQuadsSource(
  track: TrackTerrain,
  placements: readonly TrackPlacement[],
  options: { size?: number; aspect?: number; lift?: number; label?: string } = {},
): GeometrySource {
  const size = options.size ?? 0.09;
  const aspect = options.aspect ?? 0.7;
  const lift = options.lift ?? 0.035;
  const n = placements.length;
  const positions = new Float32Array(n * 4 * 3);
  const normals = new Float32Array(n * 4 * 3);
  const uvs = new Float32Array(n * 4 * 2);
  const indices = new Uint32Array(n * 6);
  const nrm = { x: 0, y: 1, z: 0 };
  for (let i = 0; i < n; i++) {
    const p = placements[i]!;
    track.normalAt(p.x, p.z, nrm, 0.3);
    const hw = (size * p.scale) / 2;
    const hd = hw * aspect;
    const c = Math.cos(p.yaw), s = Math.sin(p.yaw);
    // Tangent basis on the surface: project yaw axes onto the plane with normal nrm.
    const ax = c, az = s, bx = -s, bz = c;
    const ay = -(nrm.x * ax + nrm.z * az) / nrm.y;
    const by = -(nrm.x * bx + nrm.z * bz) / nrm.y;
    const corners = [
      [-1, -1], [1, -1], [1, 1], [-1, 1],
    ] as const;
    for (let k = 0; k < 4; k++) {
      const [u, v] = corners[k]!;
      const o = (i * 4 + k) * 3;
      positions[o] = p.x + ax * u * hw + bx * v * hd + nrm.x * lift;
      positions[o + 1] = p.y + ay * u * hw + by * v * hd + nrm.y * lift;
      positions[o + 2] = p.z + az * u * hw + bz * v * hd + nrm.z * lift;
      normals[o] = nrm.x;
      normals[o + 1] = nrm.y;
      normals[o + 2] = nrm.z;
      uvs[(i * 4 + k) * 2] = (u + 1) / 2;
      uvs[(i * 4 + k) * 2 + 1] = (v + 1) / 2;
    }
    const b = i * 4;
    indices.set([b, b + 3, b + 1, b + 1, b + 3, b + 2], i * 6);
  }
  return { positions, normals, uvs, indices, label: options.label ?? "track-litter" };
}
