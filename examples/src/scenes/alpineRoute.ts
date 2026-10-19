/**
 * Mission layout and road design for the Alpine rescue demo.
 *
 * The depot, the three relay beacons and the winding service track are fixed by the mission; what
 * this module adds is the road *as engineering*: a {@link TrackSpline} through the existing
 * centre line, a bed elevation designed from the natural terrain (smoothed, grade-limited — see
 * `designBedProfile`), and the graded corridors the terrain pipeline cuts into every streamed chunk
 * (`TrackGradingGenerator`), so the truck drives a level, believable track instead of the raw
 * hillside's lumps and 60 % cross-slopes. The same bed feeds the road ribbon mesh.
 *
 * Pure (no GPU, no scene): `designAlpineRoute` takes the natural height function and returns data.
 */

import {
  TrackSpline,
  computeNormalsAndTangents,
  designBedProfile,
  type GeometrySource,
  type GradedCorridor,
  type TrackProjection,
} from "@forge/engine";

// ------------------------------------------------------------------ mission layout

export const ALPINE_SEED = 7421;
export const BASE_X = 256;
export const DEPOT_X = BASE_X - 16;
export const DEPOT_HUT_X = DEPOT_X - 14;
export const BASE_Z = -188;
export const ROUTE_X = 256;
export const ROUTE_START_Z = -166;
export const RELAY_SITES = [
  { name: "EAST RIDGE DISTRESS BEACON", callsign: "ECHO 01", x: 269, z: -92 },
  { name: "PINE NOTCH DISTRESS BEACON", callsign: "ECHO 02", x: 244, z: -4 },
  { name: "GLACIER GATE DISTRESS BEACON", callsign: "ECHO 03", x: 260, z: 96 },
] as const;
export const ROUTE_MAIN_START_Z = ROUTE_START_Z - 13;
export const ROUTE_END_Z = RELAY_SITES[2].z + 28;
export const DEPOT_APPROACH_Z = BASE_Z + 8.5;
export const ROUTE_MERGE_Z = ROUTE_START_Z + 12;
export const DEPOT_APPROACH_X = DEPOT_X + 4.5;
export const INTERACT_RADIUS = 11;
/** Nominal width of the running surface (the ribbon is wider: it includes the plough banks). */
export const ROAD_WIDTH = 5.2;

/** Centre line of the winding main route as a function of z. */
export function mainRouteCenterX(z: number): number {
  const t = (z - ROUTE_MAIN_START_Z) / (ROUTE_END_Z - ROUTE_MAIN_START_Z);
  return ROUTE_X + Math.sin(t * Math.PI * 2.4) * 4.2 + Math.sin(t * 8.1) * 1.15;
}

/** Centre line of the whole road: the depot spur easing into the main route. */
export function roadCenterX(z: number): number {
  if (z >= ROUTE_MERGE_Z) return mainRouteCenterX(z);
  const mergeX = mainRouteCenterX(ROUTE_MERGE_Z);
  const t = Math.max(0, Math.min(1, (z - DEPOT_APPROACH_Z) / (ROUTE_MERGE_Z - DEPOT_APPROACH_Z)));
  const eased = t * t * (3 - 2 * t);
  return DEPOT_APPROACH_X + (mergeX - DEPOT_APPROACH_X) * eased;
}

// ------------------------------------------------------------------ road design

/** z where the road starts: on the depot yard, a few metres behind the truck's spawn. */
export const ROAD_START_Z = DEPOT_APPROACH_Z - 10.5;

export interface AlpineRouteOptions {
  /** Half-width of the level bed graded under the road. Default 6 m. */
  bedHalfWidth?: number;
  /** Distance over which the bed eases back into the hillside. Default 10 m. */
  blendWidth?: number;
  /** Along-route window of the bed smoothing. Default 48 m. */
  smoothing?: number;
  /** Steepest grade of the designed bed. Default 0.10. */
  maxGrade?: number;
  /** Spline resample step. Default 2 m. */
  step?: number;
}

export interface RouteProjection {
  /** Arc length of the nearest centre-line point. */
  s: number;
  /** Signed offset: positive to the right of travel. `Infinity` when outside the indexed corridor. */
  lateral: number;
  /** Absolute distance to the centre line (`Infinity` outside the corridor). */
  distance: number;
}

export interface AlpineRoute {
  readonly spline: TrackSpline;
  /** Designed bed elevation per spline sample. */
  readonly bed: Float64Array;
  readonly length: number;
  /** Graded corridors for `TrackGradingGenerator`: the depot pad first, then the road. */
  readonly corridors: GradedCorridor[];
  readonly bedHalfWidth: number;
  readonly blendWidth: number;
  /** Bed elevation at arc length `s` (linear between samples). */
  bedAt(s: number): number;
  /** World pose of the bed at `s`: position, heading (radians, 0 = +Z, +X positive). */
  poseAt(s: number): { x: number; y: number; z: number; yaw: number };
  /** Nearest route point; `distance` is `Infinity` farther than {@link INDEX_RADIUS} m away. */
  project(x: number, z: number, out?: RouteProjection): RouteProjection;
}

/** How far from the centre line `project` answers. */
export const INDEX_RADIUS = 26;

/**
 * Design the road from the natural height function: sample the centre line, derive a smoothed,
 * grade-limited bed, and describe the depot pad and the road as graded corridors.
 */
export function designAlpineRoute(naturalHeight: (x: number, z: number) => number, options: AlpineRouteOptions = {}): AlpineRoute {
  const bedHalfWidth = options.bedHalfWidth ?? 6;
  const blendWidth = options.blendWidth ?? 10;
  const step = options.step ?? 2;
  const control: Array<{ x: number; z: number }> = [];
  for (let z = ROAD_START_Z; z < ROUTE_END_Z; z += 6) control.push({ x: roadCenterX(z), z });
  control.push({ x: roadCenterX(ROUTE_END_Z), z: ROUTE_END_Z });
  const spline = new TrackSpline(control, { closed: false, step });
  spline.buildIndex(INDEX_RADIUS);
  const n = spline.sampleCount;
  const natural = new Float64Array(n);
  for (let i = 0; i < n; i++) natural[i] = naturalHeight(spline.px[i]!, spline.pz[i]!);
  const bed = designBedProfile(natural, spline.step, { smoothing: options.smoothing ?? 48, maxGrade: options.maxGrade ?? 0.1 });

  // The road corridor: every other sample is plenty (4 m chords on a gentle curve).
  const points: number[] = [];
  const bedPoints: number[] = [];
  for (let i = 0; i < n; i += 2) {
    points.push(spline.px[i]!, spline.pz[i]!);
    bedPoints.push(bed[i]!);
  }
  if ((n - 1) % 2 !== 0) {
    points.push(spline.px[n - 1]!, spline.pz[n - 1]!);
    bedPoints.push(bed[n - 1]!);
  }
  const road: GradedCorridor = { points, bed: bedPoints, halfWidth: bedHalfWidth, blendWidth };
  // The depot yard: a level pad under the hut, the lanterns, the supply case and the spawn, at the
  // road's own starting elevation so the two corridors meet without a step.
  const padLevel = bed[0]!;
  const pad: GradedCorridor = {
    points: [DEPOT_HUT_X - 8, BASE_Z + 1, DEPOT_APPROACH_X + 2.5, BASE_Z + 1],
    bed: [padLevel, padLevel],
    halfWidth: 9,
    blendWidth: 10,
  };

  const scratch: TrackProjection = { s: 0, lateral: 0, dist: Infinity, index: -1 };
  const bedAt = (s: number): number => {
    const u = Math.max(0, Math.min(n - 1, s / spline.step));
    const i = Math.min(n - 2, Math.floor(u));
    return bed[i]! + (bed[i + 1]! - bed[i]!) * (u - i);
  };
  const sample = { x: 0, z: 0, tx: 0, tz: 1 };
  return {
    spline,
    bed,
    length: spline.length,
    corridors: [pad, road],
    bedHalfWidth,
    blendWidth,
    bedAt,
    poseAt(s: number) {
      const c = spline.sampleAt(s, sample);
      return { x: c.x, y: bedAt(s), z: c.z, yaw: Math.atan2(c.tx, c.tz) };
    },
    project(x: number, z: number, out: RouteProjection = { s: 0, lateral: Infinity, distance: Infinity }): RouteProjection {
      spline.project(x, z, scratch);
      out.s = scratch.s;
      out.lateral = Number.isFinite(scratch.dist) ? scratch.lateral : Infinity;
      out.distance = scratch.dist;
      return out;
    },
  };
}

// ------------------------------------------------------------------ road ribbon

export interface RoadRibbonOptions {
  /** Lateral half-span of the ribbon (m): the running surface plus the plough banks. Default 3.4. */
  halfSpan?: number;
  /** Vertices across. Default 9. */
  across?: number;
  /** Metres between rows along the road. Default 1.5. */
  alongStep?: number;
  /** Lift over the graded bed (m); keeps the ribbon clear of the terrain mesh. Default 0.035. */
  lift?: number;
  /** Metres along the road per texture repeat in `v`. Default 8. */
  uvMetersAlong?: number;
  /** Arc length range to build; default the whole road. */
  from?: number;
  to?: number;
}

/**
 * The road surface as a strip following the centre line at the designed bed elevation. UV `u` runs
 * across (0 at the left edge), `v` along in metres / `uvMetersAlong`, matching `snowRoadPixels`.
 */
export function roadRibbonSource(route: AlpineRoute, options: RoadRibbonOptions = {}): GeometrySource {
  const span = options.halfSpan ?? 3.4;
  const across = Math.max(2, options.across ?? 9);
  const from = Math.max(0, options.from ?? 0);
  const to = Math.min(route.length, options.to ?? route.length);
  const rows = Math.max(2, Math.round((to - from) / (options.alongStep ?? 1.5)) + 1);
  const lift = options.lift ?? 0.035;
  const uvAlong = options.uvMetersAlong ?? 8;
  const positions = new Float32Array(rows * across * 3);
  const uvs = new Float32Array(rows * across * 2);
  const c = { x: 0, z: 0, tx: 0, tz: 1 };
  for (let r = 0; r < rows; r++) {
    const s = from + ((to - from) * r) / (rows - 1);
    route.spline.sampleAt(s, c);
    const y = route.bedAt(s) + lift;
    for (let a = 0; a < across; a++) {
      const u = a / (across - 1);
      const lateral = -span + 2 * span * u;
      const o = r * across + a;
      // Right of travel is (tz, -tx).
      positions[o * 3] = c.x + c.tz * lateral;
      positions[o * 3 + 1] = y;
      positions[o * 3 + 2] = c.z - c.tx * lateral;
      uvs[o * 2] = u;
      uvs[o * 2 + 1] = s / uvAlong;
    }
  }
  const indices = new Uint32Array((rows - 1) * (across - 1) * 6);
  let k = 0;
  for (let r = 0; r < rows - 1; r++) {
    for (let a = 0; a < across - 1; a++) {
      const i0 = r * across + a, i1 = i0 + 1, i2 = i0 + across, i3 = i2 + 1;
      // Forward then right winds counter-clockwise seen from above: (i0, i2, i1), (i1, i2, i3).
      indices[k++] = i0; indices[k++] = i2; indices[k++] = i1;
      indices[k++] = i1; indices[k++] = i2; indices[k++] = i3;
    }
  }
  const { normals, tangents } = computeNormalsAndTangents(positions, indices, uvs);
  return { positions, normals, uvs, tangents, indices, label: "alpine.road" };
}
