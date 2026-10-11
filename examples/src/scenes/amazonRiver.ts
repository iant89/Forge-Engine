/**
 * The Amazon demo's river world: one deterministic description of a meandering lowland river, its
 * floodplain and its navigation marks, from which everything else in the scene is derived.
 *
 * The channel is authored as an *analytic function of (x, z)* rather than a baked heightmap, on
 * purpose: the terrain ribbon the demo draws, the water ribbon it floats on, the boat's grounding
 * test, the camera's ground constraint and every scatter rule all call the same `elevationAt`, so they
 * cannot drift apart the way a drawn mesh and a collision grid can. The same function is cheap enough
 * to evaluate in a Node test, which is where the cross-section, the meander shape and the journey's
 * station scale are pinned.
 *
 * Structure:
 *  - `createRiverCourse` integrates a bounded-curvature heading profile into a station table (station
 *    = arc length along the centreline). That is the only place the meanders are decided.
 *  - `RiverQuery` wraps a table with nearest-station projection (spatial hash + strided scan, exact
 *    because each candidate list covers the whole search radius) and the channel's own half-width and
 *    bed-depth functions. `elevationAt` composes the main channel, a tributary *igarapé* and stranded
 *    oxbow lakes by taking the minimum of the elevations they each imply.
 *  - `buildRiverRibbon` sweeps that field into the terrain and water meshes, with a cross-section
 *    that is dense at the shore and geometric beyond it.
 *
 * River engineering as modelled (deliberately simple, deliberately honest):
 *  - the bed is deepest against the **cut bank** on the outside of a bend and shoals into a **point
 *    bar** on the inside — which is what a meander actually does, and what turns a run upriver into a
 *    line choice instead of a straight stick;
 *  - the floodplain has a natural levee at the bank, a back-swamp behind it, then rising jungle
 *    terrace: the classic Amazonian cross-section;
 *  - the thalweg is held a fixed depth under the water surface, so a hill standing over the line
 *    becomes a gorge instead of damming the river;
 *  - every feature's profile is continuous with the shared upland base where its influence ends, which
 *    is why there is no seam to find at `influenceQ`;
 *  - the water surface sits 6 cm under the contour the banks were drawn to, so the shoreline is a
 *    shallow wetted band rather than two coplanar surfaces shimmering at the same height.
 */

import { NoiseField, Vec3, clamp, hash2i, lerp, smoothstep } from "@forge/engine";

/** Master seed for the river, its lakes, its villages and every scatter stream derived from it. */
export const AMAZON_SEED = 20260812;

/**
 * Mean river stage. The bank profile is authored so the ground meets 0 at the designed shoreline;
 * floating the surface just under that contour keeps the waterline from being coplanar with the bank.
 */
export const AMAZON_WATER_LEVEL = -0.06;

/** Metres of channel the journey covers, measured along the thalweg from the starting landing stage. */
export const RIVER_JOURNEY_METRES = 4200;

/** Station spacing of the query table (metres). Dense enough that the polyline never facets visibly. */
export const RIVER_STATION_STEP = 6;

/** Station spacing of the drawn ribbons (metres). */
export const RIBBON_STATION_STEP = 12;

/** Half-width of the wetted channel on a straight (metres), before bend shaping. */
export const RIVER_HALF_WIDTH = 92;

/** Thalweg depth under the water surface on a straight (metres). */
export const RIVER_BED_DEPTH = 6.9;

/** How far the drawn terrain ribbon reaches each side of the centreline (metres). */
export const RIVER_RIBBON_HALF_SPAN = 1250;

/** Half-span of the drawn water sheet: past the wetted channel, under the banks, to the fog line. */
export const WATER_RIBBON_HALF_SPAN = 300;

/** Lateral search radius of a nearest-station query (metres). */
export const RIVER_SEARCH_RADIUS = 360;

/** Metres of channel built beyond each end of the journey, so the river runs off the map (main channel). */
export const RIVER_END_OVERSHOOT = 900;

/** The *igarapé* is a creek: a shorter run-off at each end is enough to hide its edges. */
const TRIB_OVERSHOOT = 300;

/** Lateral hash cell size for the nearest-station accelerator (metres). */
const RIVER_HASH_CELL = 100;

/**
 * Normalised thalweg depth shape, keyed on `q = |lateral| / halfWidth`: 1 on the centreline, 0 at the
 * designed shoreline. The soft shoulder from 0.62 to 1 is the point-bar wedge.
 */
const DEPTH_SHAPE: readonly [number, number][] = [
  [0, 1],
  [0.36, 0.985],
  [0.62, 0.93],
  [0.78, 0.78],
  [0.9, 0.48],
  [0.97, 0.19],
  [1, 0],
];

/**
 * Bank height above the waterline (metres), keyed on `q`. The 2.6 m crest near q = 1.6 is the natural
 * levee the jungle stands on; the dip near q = 2 is the back-swamp behind it.
 */
const BANK_SHAPE: readonly [number, number][] = [
  [1, 0],
  [1.05, 0.26],
  [1.16, 0.82],
  [1.34, 1.85],
  [1.55, 2.62],
  [1.78, 2.74],
  [2.05, 1.42],
  [2.3, 1.68],
  [2.7, 2.34],
  [3.3, 3.28],
];

/** Slope continued past the last `BANK_SHAPE` key (metres of rise per metre of `q`). */
const BANK_FAR_SLOPE = 1.32;

/** Height of the natural levee crest over the waterline; ground above this cuts a gorge. */
const BANK_CREST = 2.8;

/** Where a feature's own profile has handed over to the upland base completely. */
const FEATURE_BLEND_Q = 2.6;

/** Uniform-spacing band of the drawn cross-section; beyond it the columns grow geometrically. */
const RIBBON_INNER_BAND = 250;
const RIBBON_INNER_COLUMNS = 42;
const RIBBON_OUTER_RATIO = 1.34;
const RIBBON_OUTER_COLUMNS = 9;

/** One point of the integrated channel polyline. */
export interface RiverStation {
  s: number;
  x: number;
  z: number;
  /** Heading in radians; forward is `(sin h, cos h)`, so h = 0 runs along +Z. */
  heading: number;
  /** Signed curvature (1/m). Positive turns the heading to the left. */
  curvature: number;
}

function createRiverStation(): RiverStation {
  return { s: 0, x: 0, z: 0, heading: 0, curvature: 0 };
}

/** A channel: an integrated course plus the width/bed functions of its own cross-section. */
export interface RiverChannel {
  readonly name: string;
  /** Upriver end of the *journey*, measured from the first station (metres of arc). */
  readonly length: number;
  /** First station of the table, which is negative when the channel is built past the journey. */
  readonly startS: number;
  /** Last station of the table plus one step: the table's full extent, journey and overshoot alike. */
  readonly endS: number;
  readonly stationStep: number;
  /** `s, x, z, heading, curvature` per station, stride 5. */
  readonly stations: Float64Array;
  readonly halfWidthAt: (s: number) => number;
  readonly bedDepthAt: (s: number) => number;
  /** Beyond this `q` the feature contributes nothing, so its edge cannot be found. */
  readonly influenceQ: number;
}

/** Result of projecting a world position onto a channel. */
export interface RiverProbe {
  /** Arc length of the nearest centreline point (metres; runs slightly past either end). */
  s: number;
  /** Signed lateral offset from the centreline (metres). Positive is to the channel's left. */
  lateral: number;
  /** Absolute lateral offset (metres). */
  distance: number;
  /** `|lateral| / halfWidth(s)`: 1 is the designed shoreline. */
  q: number;
  /** Local half-width at `s` (metres). */
  halfWidth: number;
  /** 1 on the outside of a bend (cut bank), -1 on the inside (point bar), 0 on a straight. */
  bendSide: number;
}

export function createRiverProbe(): RiverProbe {
  return { s: 0, lateral: 0, distance: 0, q: 0, halfWidth: RIVER_HALF_WIDTH, bendSide: 0 };
}

/** A centreline position with everything a caller usually wants about the local channel. */
export interface RiverPose {
  x: number;
  z: number;
  heading: number;
  curvature: number;
  halfWidth: number;
  /** Thalweg depth under the water surface, bend shaping excluded (metres, always > 0). */
  depth: number;
  forwardX: number;
  forwardZ: number;
  /** Unit vector to the channel's left. */
  leftX: number;
  leftZ: number;
}

export function createRiverPose(): RiverPose {
  return {
    x: 0,
    z: 0,
    heading: 0,
    curvature: 0,
    halfWidth: RIVER_HALF_WIDTH,
    depth: RIVER_BED_DEPTH,
    forwardX: 0,
    forwardZ: 1,
    leftX: 1,
    leftZ: 0,
  };
}

/** Interpolate a `q`-keyed profile table, continuing with `farSlope` past the last key. */
function sampleShape(keys: readonly [number, number][], q: number, farSlope: number): number {
  const first = keys[0]!;
  if (q <= first[0]) return first[1];
  const last = keys[keys.length - 1]!;
  if (q >= last[0]) return last[1] + (q - last[0]) * farSlope;
  for (let i = 1; i < keys.length; i++) {
    const b = keys[i]!;
    if (q <= b[0]) {
      const a = keys[i - 1]!;
      return lerp(a[1], b[1], smoothstep(a[0], b[0], q));
    }
  }
  return last[1];
}

/** Fraction of the thalweg depth still under water at `q` (1 on the centreline, 0 at the shoreline). */
export function channelDepthFactor(q: number): number {
  return sampleShape(DEPTH_SHAPE, Math.abs(q), 0);
}

/** Bank height above the waterline at `q`, in metres (0 at and inboard of the shoreline). */
export function channelBankHeight(q: number): number {
  const aq = Math.abs(q);
  if (aq <= 1) return 0;
  return sampleShape(BANK_SHAPE, aq, BANK_FAR_SLOPE);
}

/**
 * Integrate a bounded-curvature heading profile into a station table.
 *
 * The heading is a sum of sines of incommensurate wavelength, so the meanders never repeat along the
 * journey while the curvature stays inside the bound the cross-section relies on (see the note at the
 * amplitude table: no bend tighter than ~440 m radius, so a query near the bank always has exactly one
 * nearest station). The long-wavelength swing sets
 * the overall bearing, which keeps the channel running upriver instead of wandering back on itself.
 */
/**
 * Station table for a channel that runs from `s = -overshoot` to `s = length + overshoot`.
 *
 * The overshoot is not decoration: the influence band of a channel ends ~2.8 half-widths from its
 * centreline and the nearest-station hash only knows stations within `RIVER_SEARCH_RADIUS`, so a channel
 * that simply *stopped* at the journey's end would show a step where its carved valley met untouched
 * terrace. Integrating the heading across the whole span (the sines are continuous in `s`, negative
 * included) keeps the meanders flowing through the map edge, and the demo can see the river run off in
 * front of the bow and behind the transom.
 */
export function createRiverCourse(options: {
  seed: number;
  length: number;
  stationStep: number;
  startHeading?: number;
  overshoot?: number;
}): Float64Array {
  const seed = options.seed | 0;
  const length = options.length;
  const stationStep = options.stationStep;
  const overshoot = Math.max(0, options.overshoot ?? 0);
  const count = Math.max(2, Math.round((length + 2 * overshoot) / stationStep) + 1);
  const swing = hash2i(seed, 11, 0x51ee7) / 2147483647.5;
  const startHeading = options.startHeading ?? lerp(-0.16, 0.16, swing * 0.5 + 0.5);
  // Amplitudes/wavelengths are bounded so |dθ/ds| stays under ~0.0023 m⁻¹: the channel's radius of
  // curvature never drops below ~440 m, which is outside the band where the cross-section still has a
  // say (2.6 × half-width). Inside that band a nearest-station query is unique, so the elevation field
  // cannot fold over itself at a bend's centre of curvature; past it every feature has already handed
  // over to the upland base, where a station jump is invisible. Tight oxbow-style meanders are exactly
  // what this formulation cannot represent, so the bends are long and lazy — as they look from a boat.
  const amplitude = [0.3, 0.055, 0.014, 0.006];
  const wavelength = [1900, 900, 380, 190];
  const meanderAmp: number[] = [];
  const meanderK: number[] = [];
  const meanderPhase: number[] = [];
  for (let i = 0; i < amplitude.length; i++) {
    const jitter = hash2i(seed, i * 7 + 3, 0x2f11) / 2147483647.5 * 0.5 + 0.5;
    meanderAmp.push(amplitude[i]! * lerp(0.75, 1.25, jitter));
    meanderK.push((Math.PI * 2) / (wavelength[i]! * lerp(0.85, 1.15, jitter)));
    meanderPhase.push(i * 1.7015 + swing * Math.PI);
  }
  const swingAmp = 0.18;
  const swingK = (Math.PI * 2) / 2600;

  const table = new Float64Array(count * 5);
  let x = 0;
  let z = 0;
  for (let i = 0; i < count; i++) {
    const s = i * stationStep - overshoot;
    let heading = startHeading;
    let curvature = 0;
    for (let m = 0; m < meanderAmp.length; m++) {
      const a = meanderAmp[m]!;
      const k = meanderK[m]!;
      const p = meanderPhase[m]!;
      heading += a * Math.sin(k * s + p);
      curvature += a * k * Math.cos(k * s + p);
    }
    const swingAngle = swingK * s + swing * Math.PI;
    heading += swingAmp * Math.sin(swingAngle);
    curvature += swingAmp * swingK * Math.cos(swingAngle);
    const o = i * 5;
    table[o] = s;
    table[o + 1] = x;
    table[o + 2] = z;
    table[o + 3] = heading;
    table[o + 4] = curvature;
    // Midpoint integration: advancing at the half-step heading keeps arc length honest, so `s` really
    // is distance travelled and the HUD's distance readout agrees with the drawn channel.
    const stepHeading = heading + curvature * stationStep * 0.5;
    x += Math.sin(stepHeading) * stationStep;
    z += Math.cos(stepHeading) * stationStep;
  }
  return table;
}

/**
 * A channel with its nearest-point accelerator.
 *
 * Each hash cell holds the station indices within `RIVER_SEARCH_RADIUS` of that cell, in table order, so
 * a query scans only candidates that could be nearest — typically a hundred instead of seven hundred.
 * Because the list is sorted, a meander that comes back on itself appears as several *runs* of
 * consecutive indices, and the scan keeps one winner per run: `probe` reports the nearest, `elevationAt`
 * takes the minimum over all of them. Projection is onto the polyline *segments* rather than the station
 * points, which is what makes `lateral` continuous instead of sawtoothing at station steps.
 */
export class RiverQuery {
  readonly channel: RiverChannel;
  readonly stationCount: number;
  private readonly cellToStations = new Map<number, number[]>();
  private readonly minX: number;
  private readonly minZ: number;
  private readonly scratchA = createRiverStation();
  private readonly scratchB = createRiverStation();
  private readonly scratchProbe = createRiverProbe();
  private readonly branchStation: number[] = [];
  private readonly branchT: number[] = [];
  private readonly branchDistance: number[] = [];
  private readonly branchScratch: RiverProbe[] = [createRiverProbe(), createRiverProbe(), createRiverProbe()];

  constructor(channel: RiverChannel) {
    this.channel = channel;
    this.stationCount = Math.max(2, Math.floor(channel.stations.length / 5));
    const table = channel.stations;
    let minX = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxZ = -Infinity;
    for (let i = 0; i < this.stationCount; i++) {
      const o = i * 5;
      const x = table[o + 1]!;
      const z = table[o + 2]!;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
    }
    this.minX = minX - RIVER_SEARCH_RADIUS;
    this.minZ = minZ - RIVER_SEARCH_RADIUS;
    const reach = Math.ceil(RIVER_SEARCH_RADIUS / RIVER_HASH_CELL);
    const reachSq = (reach + 0.55) * (reach + 0.55);
    for (let i = 0; i < this.stationCount; i++) {
      const o = i * 5;
      const cx = Math.floor((table[o + 1]! - this.minX) / RIVER_HASH_CELL);
      const cz = Math.floor((table[o + 2]! - this.minZ) / RIVER_HASH_CELL);
      for (let dz = -reach; dz <= reach; dz++) {
        for (let dx = -reach; dx <= reach; dx++) {
          if (dx * dx + dz * dz > reachSq) continue;
          const key = (cz + dz) * 100000 + (cx + dx);
          const list = this.cellToStations.get(key);
          if (list) list.push(i);
          else this.cellToStations.set(key, [i]);
        }
      }
    }
  }

  get length(): number {
    return this.channel.length;
  }

  /** How many candidate stations a query scans, so a test can pin the accelerator's work. */
  candidateCountAt(x: number, z: number): number {
    return this.cellOf(x, z)?.length ?? 0;
  }

  /** Channel half-width at the waterline for a station (metres). */
  halfWidthAt(s: number): number {
    return this.channel.halfWidthAt(clamp(s, this.channel.startS, this.channel.endS));
  }

  /** Thalweg depth under the water surface for a station (metres, bend shaping excluded). */
  bedDepthAt(s: number): number {
    return this.channel.bedDepthAt(clamp(s, this.channel.startS, this.channel.endS));
  }

  private cellOf(x: number, z: number): readonly number[] | undefined {
    const key =
      Math.floor((z - this.minZ) / RIVER_HASH_CELL) * 100000 + Math.floor((x - this.minX) / RIVER_HASH_CELL);
    return this.cellToStations.get(key);
  }

  private stationAt(index: number, out: RiverStation): RiverStation {
    const o = index * 5;
    const table = this.channel.stations;
    out.s = table[o] ?? this.channel.startS + index * this.channel.stationStep;
    out.x = table[o + 1] ?? 0;
    out.z = table[o + 2] ?? 0;
    out.heading = table[o + 3] ?? 0;
    out.curvature = table[o + 4] ?? 0;
    return out;
  }

  /** Squared distance from (x, z) to the segment starting at station `i`; `hitT` receives its `t`. */
  private segmentDistance(i: number, x: number, z: number, hitT: { t: number }): number {
    const table = this.channel.stations;
    const o = i * 5;
    const ax = table[o + 1]!;
    const az = table[o + 2]!;
    const p = Math.min(this.stationCount - 1, i + 1) * 5;
    const bx = table[p + 1]!;
    const bz = table[p + 2]!;
    const ex = bx - ax;
    const ez = bz - az;
    const len2 = ex * ex + ez * ez;
    let t = len2 > 1e-9 ? ((x - ax) * ex + (z - az) * ez) / len2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    hitT.t = t;
    const px = ax + ex * t;
    const pz = az + ez * t;
    return (x - px) * (x - px) + (z - pz) * (z - pz);
  }

  /**
   * Project (x, z) onto the centreline. A position past either end clamps to the terminal station and
   * is measured straight from it, so every query — even far off the map — stays finite.
   */
  probe(x: number, z: number, out: RiverProbe = this.scratchProbe): RiverProbe {
    this.probeBranches(x, z, this.branchScratch);
    const best = this.branchScratch[0]!;
    out.s = best.s;
    out.lateral = best.lateral;
    out.distance = best.distance;
    out.q = best.q;
    out.halfWidth = best.halfWidth;
    out.bendSide = best.bendSide;
    return out;
  }

  /**
   * Project (x, z) onto every branch of the channel that reaches it, nearest first, up to three.
   *
   * A floodplain point can be within the cross-section's reach of *two* sides of the same meander; if
   * the elevation used only the single nearest station, the field would fold — a step from "in the
   * channel" to "on the terrace" wherever the two candidates trade places. Taking the minimum over the
   * branches is both the physical answer (the ground is as low as the nearest carve makes it) and
   * continuous, because a minimum of continuous functions is continuous.
   */
  probeBranches(x: number, z: number, out: RiverProbe[]): number {
    const candidates = this.cellOf(x, z);
    const hit = { t: 0 };
    this.branchStation.length = 0;
    this.branchT.length = 0;
    this.branchDistance.length = 0;
    if (candidates && candidates.length > 0) {
      // One linear pass over the cell's stations. They are sorted by station index, so a meander that
      // comes back on itself shows up as several *runs* of consecutive indices; each run gets its own
      // minimum and the global minimum, which is everything the caller needs. A strided scan with a
      // refine window cannot be trusted here — a short run (two or three stations on the far side of a
      // neck) can sit between two samples and go missing, and a missing branch is a crease in the
      // elevation field.
      let runStation = -1;
      let runT = 0;
      let runD2 = Infinity;
      let previous = -2;
      for (let i = 0; i < candidates.length; i++) {
        const index = candidates[i]!;
        if (index > this.stationCount - 2 || index < 0) {
          previous = index;
          continue;
        }
        if (index !== previous + 1) {
          this.pushBranch(runStation, runT, runD2);
          runStation = -1;
          runD2 = Infinity;
        }
        previous = index;
        const d2 = this.segmentDistance(index, x, z, hit);
        if (d2 < runD2) {
          runStation = index;
          runT = hit.t;
          runD2 = d2;
        }
      }
      this.pushBranch(runStation, runT, runD2);
      // Nearest branch first (insertion sort: there are rarely more than two).
      for (let i = 1; i < this.branchStation.length; i++) {
        for (let j = i; j > 0 && this.branchDistance[j]! < this.branchDistance[j - 1]!; j--) {
          this.swapBranch(i, j - 1);
        }
      }
    } else {
      // Nothing within the search radius: the point is off the end of the channel, or out in the open
      // floodplain past any influence. Measure it straight from the nearer terminal station — never by
      // reusing the segment projection, which would report a plausible-looking `lateral` for a point
      // kilometres from the water and hand a mid-channel profile to somewhere that has none.
      const tail = this.stationAt(this.stationCount - 1, this.scratchA);
      const head = this.stationAt(0, this.scratchB);
      const dHead = Math.hypot(x - head.x, z - head.z);
      const dTail = Math.hypot(x - tail.x, z - tail.z);
      const isHead = dHead <= dTail;
      const end = isHead ? head : tail;
      const endS = end.s;
      const forwardX = Math.sin(end.heading);
      const forwardZ = Math.cos(end.heading);
      const dx = x - end.x;
      const dz = z - end.z;
      // Beyond the head station the channel has not started yet, so the along-track offset counts against
      // the lateral distance instead of advancing `s`; past the tail it is simply extra river.
      const along = dx * forwardX + dz * forwardZ;
      const lateral = dx * Math.cos(end.heading) - dz * Math.sin(end.heading) + (isHead ? -Math.max(0, -along) : 0);
      const halfWidth = this.halfWidthAt(endS);
      const probe = out[0]!;
      probe.s = endS;
      probe.lateral = lateral;
      probe.distance = Math.hypot(dx, dz);
      probe.q = halfWidth > 1e-3 ? probe.distance / halfWidth : Number.MAX_VALUE;
      probe.halfWidth = halfWidth;
      probe.bendSide = 0;
      return 1;
    }
    const branches = Math.min(out.length, this.branchStation.length);
    for (let k = 0; k < branches; k++) {
      this.writeProbe(x, z, this.branchStation[k]!, this.branchT[k]!, out[k]!);
    }
    return branches;
  }

  private pushBranch(station: number, t: number, d2: number): void {
    if (station < 0) return;
    this.branchStation.push(station);
    this.branchT.push(t);
    this.branchDistance.push(d2);
  }

  private swapBranch(i: number, j: number): void {
    const station = this.branchStation[i]!;
    const t = this.branchT[i]!;
    const d = this.branchDistance[i]!;
    this.branchStation[i] = this.branchStation[j]!;
    this.branchT[i] = this.branchT[j]!;
    this.branchDistance[i] = this.branchDistance[j]!;
    this.branchStation[j] = station;
    this.branchT[j] = t;
    this.branchDistance[j] = d;
  }

  /** Finish a probe from a winning (station, segment parameter) pair. */
  private writeProbe(x: number, z: number, index: number, t: number, out: RiverProbe): void {
    const a = this.stationAt(index, this.scratchA);
    const b = this.stationAt(Math.min(this.stationCount - 1, index + 1), this.scratchB);
    const heading = lerp(a.heading, b.heading, t);
    const curvature = lerp(a.curvature, b.curvature, t);
    const px = lerp(a.x, b.x, t);
    const pz = lerp(a.z, b.z, t);
    const forwardX = Math.sin(heading);
    const forwardZ = Math.cos(heading);
    const leftX = Math.cos(heading);
    const leftZ = -Math.sin(heading);
    const dx = x - px;
    const dz = z - pz;
    const s = lerp(a.s, b.s, t) + dx * forwardX + dz * forwardZ;
    const lateral = dx * leftX + dz * leftZ;
    const halfWidth = this.halfWidthAt(s);
    out.s = s;
    out.lateral = lateral;
    out.distance = Math.abs(lateral);
    out.q = halfWidth > 1e-3 ? Math.abs(lateral) / halfWidth : 0;
    out.halfWidth = halfWidth;
    // A left turn (curvature > 0) puts the deep water and the steep bank on the right, hence the flip.
    out.bendSide = Math.abs(curvature) < 1e-7 ? 0 : -Math.sign(curvature * lateral);
  }

  /** Centreline pose at arc length `s`, clamped to the channel. */
  poseAt(s: number, out: RiverPose = createRiverPose()): RiverPose {
    const step = this.channel.stationStep;
    const clamped = clamp(s, this.channel.startS, this.channel.endS - step);
    const exact = (clamped - this.channel.startS) / step;
    const i = Math.min(this.stationCount - 1, Math.floor(exact));
    const t = clamp(exact - i, 0, 1);
    const a = this.stationAt(i, this.scratchA);
    const b = this.stationAt(Math.min(this.stationCount - 1, i + 1), this.scratchB);
    const heading = lerp(a.heading, b.heading, t);
    out.x = lerp(a.x, b.x, t);
    out.z = lerp(a.z, b.z, t);
    out.heading = heading;
    out.curvature = lerp(a.curvature, b.curvature, t);
    out.forwardX = Math.sin(heading);
    out.forwardZ = Math.cos(heading);
    out.leftX = Math.cos(heading);
    out.leftZ = -Math.sin(heading);
    out.halfWidth = this.halfWidthAt(clamped);
    out.depth = this.bedDepthAt(clamped);
    return out;
  }

  /**
   * Elevation this channel implies at a world position, carved into the given upland base.
   *
   * The minimum over every branch whose cross-section reaches the point (see `probeBranches`), so two
   * reaches crowding around a meander neck are carved by both and the field cannot fold. `nearest`, when
   * given, receives the branch that produced the winning profile — the caller wants its `q` to gate
   * floodplain detail without paying for a second scan.
   */
  elevationAt(x: number, z: number, base: number, nearest?: RiverProbe): number {
    const branches = this.probeBranches(x, z, this.branchScratch);
    let elevation = Number.POSITIVE_INFINITY;
    let winner = 0;
    for (let k = 0; k < branches; k++) {
      const value = this.profileAt(this.branchScratch[k]!, base);
      if (value < elevation) {
        elevation = value;
        winner = k;
      }
    }
    if (nearest) {
      const source = this.branchScratch[winner]!;
      nearest.s = source.s;
      nearest.lateral = source.lateral;
      nearest.distance = source.distance;
      nearest.q = source.q;
      nearest.halfWidth = source.halfWidth;
      nearest.bendSide = source.bendSide;
    }
    return elevation === Number.POSITIVE_INFINITY ? base : elevation;
  }

  /**
   * The cross-section itself: thalweg, point-bar wedge, shoreline, natural levee, back-swamp, then a
   * hand-over to the upland base as `q` approaches `influenceQ`.
   *
   * Three regimes, one continuous curve. The channel gets deeper where ground stands above the bank
   * crest, which is what turns a hill over the line into a gorge instead of a dam; the point bar lifts the
   * inside of a bend until it dries out, so the wetted shoreline genuinely wanders with the meander
   * instead of sitting at a fixed `q`; the cut bank deepens and steepens the outside. Returns `+Infinity`
   * where the point is outside this channel's reach, so "no opinion" is a neutral element of the minimum.
   */
  private profileAt(probe: RiverProbe, base: number): number {
    const channel = this.channel;
    const q = probe.q;
    if (q >= channel.influenceQ) return Number.POSITIVE_INFINITY;
    const inside = probe.bendSide < 0;
    const barWeight = inside ? smoothstep(0.12, 0.9, q) * (1 - smoothstep(2.1, 3.4, q)) : 0;
    const cutWeight = probe.bendSide > 0 ? smoothstep(0.18, 0.95, q) * (1 - smoothstep(1.9, 3.2, q)) : 0;
    // Only ground standing above the bank crest deepens the cut; ordinary terrace keeps the authored
    // thalweg depth.
    const overBank = Math.max(0, base - AMAZON_WATER_LEVEL - BANK_CREST);
    const depth = channel.bedDepthAt(probe.s) + overBank + cutWeight * 2.4;
    const barLift = barWeight * Math.min(depth - 0.45, 5.2 + 2.1 * Math.sin(probe.s * 0.0171 + 1.3));
    const floorDepth = Math.max(0.3, depth - barLift);
    const shoreLift = barLift * 0.28;
    if (q <= 1) {
      // Runs the bed up to the shoreline: 0 → 1 as `q` goes 0 → 1.
      const t = 1 - channelDepthFactor(q);
      return AMAZON_WATER_LEVEL - floorDepth + t * (floorDepth + shoreLift);
    }
    const bankSqueeze = 1 - 0.32 * cutWeight + 0.46 * barWeight;
    const levee = Math.max(0, channelBankHeight(1 + (q - 1) * bankSqueeze)) * (1 - smoothstep(1.45, FEATURE_BLEND_Q, q));
    const toBase = smoothstep(1.0, FEATURE_BLEND_Q, q);
    return AMAZON_WATER_LEVEL + lerp(levee + shoreLift, base - AMAZON_WATER_LEVEL, toBase);
  }
}

/** A stranded meander loop: shallow, reed-choked, and the reason the jungle is not one flat green. */
export interface AmazonOxbow {
  readonly name: string;
  readonly x: number;
  readonly z: number;
  readonly radiusX: number;
  readonly radiusZ: number;
  readonly rotation: number;
  readonly depth: number;
}

/** Where the demo places a prop, measured along the channel rather than in world coordinates. */
export interface AmazonJourneyMark {
  readonly name: string;
  readonly s: number;
  /** Lateral offset from the centreline (metres, positive to the channel's left). */
  readonly lateral: number;
  readonly kind: "landing" | "buoy-port" | "buoy-starboard" | "village" | "outpost" | "research";
}

export interface AmazonRiver {
  readonly length: number;
  readonly main: RiverQuery;
  readonly tributary: RiverQuery;
  readonly oxbows: readonly AmazonOxbow[];
  /** Journey stages first, then the channel marks. */
  readonly marks: readonly AmazonJourneyMark[];
  /** Terrain with no channel influence: the base every feature's profile is carved into. */
  uplandAt(x: number, z: number): number;
  /** Full terrain elevation at a world position. */
  elevationAt(x: number, z: number): number;
  /** Water depth at a world position: > 0 is wet, ≤ 0 is dry. */
  depthAt(x: number, z: number): number;
  /** Terrain surface normal at (x, z), written into `out`. */
  normalAt(x: number, z: number, out: Vec3): Vec3;
  /** Signed lateral offset of the navigable thalweg at `s` (metres from the centreline). */
  thalwegLateralAt(s: number): number;
  /** Point on the navigable line at `s`, at water height. */
  thalwegAt(s: number, out: Vec3): Vec3;
  /** Surface current at (x, z): downstream, strongest in the thalweg, near zero over the banks. */
  currentAt(x: number, z: number, out: { x: number; z: number }): { x: number; z: number };
  /** True when (x, z) has at least `need` metres of water over the bed. */
  isWater(x: number, z: number, need?: number): boolean;
  /** Journey progress 0..1 for a world position, measured along the channel. */
  progressAt(x: number, z: number): number;
  /** Wetted channel width on a straight at station `s`, in metres. */
  nominalWidthAt(s: number): number;
  /** Station the journey starts at; the tables run before it, so the river keeps going off the map. */
  readonly journeyStart: number;
  /** Metres of channel built beyond each end of the journey. */
  readonly overshoot: number;
}

export interface AmazonRiverOptions {
  seed?: number;
  length?: number;
  stationStep?: number;
  mainHalfWidth?: number;
  mainBedDepth?: number;
  /** Channel built beyond each end of the journey, in metres. */
  overshoot?: number;
}

/** Build the river world: main channel, tributary *igarapé*, oxbow lakes, and the journey's marks. */
export function createAmazonRiver(options: AmazonRiverOptions = {}): AmazonRiver {
  const seed = options.seed ?? AMAZON_SEED;
  const length = options.length ?? RIVER_JOURNEY_METRES;
  const stationStep = options.stationStep ?? RIVER_STATION_STEP;
  const halfWidthBase = options.mainHalfWidth ?? RIVER_HALF_WIDTH;
  const bedBase = options.mainBedDepth ?? RIVER_BED_DEPTH;
  const noise = new NoiseField(seed ^ 0x51a2011, { octaves: 4, lacunarity: 2.07, gain: 0.52 });

  const overshoot = options.overshoot ?? RIVER_END_OVERSHOOT;
  const mainChannel: RiverChannel = {
    name: "amazon",
    length,
    startS: -overshoot,
    endS: length + overshoot + stationStep,
    stationStep,
    stations: createRiverCourse({ seed, length, stationStep, startHeading: 0.05, overshoot }),
    halfWidthAt: (s: number) =>
      halfWidthBase * (1.05 + 0.27 * Math.sin(s * 0.00218 + 0.4) + 0.12 * Math.sin(s * 0.00571 + 2.2)),
    bedDepthAt: (s: number) =>
      bedBase * (1 + 0.16 * Math.sin(s * 0.00194 + 1.1) + 0.07 * Math.sin(s * 0.00607 + 0.2)) +
      0.45 * Math.sin(s * 0.0311),
    influenceQ: FEATURE_BLEND_Q + 0.2,
  };
  const main = new RiverQuery(mainChannel);

  // The igarapé leaves the main river at an inside bend and runs off at ~55°, so the journey can turn
  // into a tributary and come back out — and, like every real one, it silts up going inland.
  const junctionStation = Math.round((length * 0.577) / stationStep) * stationStep;
  const junctionPose = main.poseAt(junctionStation, createRiverPose());
  const tributaryLength = 1150;
  const tributaryTable = createRiverCourse({
    seed: (seed ^ 0x194f1a55) | 0,
    length: tributaryLength,
    stationStep,
    startHeading: junctionPose.heading + Math.PI * 0.3,
    overshoot: TRIB_OVERSHOOT,
  });
  const mouthX = junctionPose.x + junctionPose.leftX * 150;
  const mouthZ = junctionPose.z + junctionPose.leftZ * 150;
  for (let i = 0; i < tributaryTable.length; i += 5) {
    tributaryTable[i + 1] = (tributaryTable[i + 1] ?? 0) + mouthX;
    tributaryTable[i + 2] = (tributaryTable[i + 2] ?? 0) + mouthZ;
  }
  const tributaryChannel: RiverChannel = {
    name: "igarape-do-meio",
    length: tributaryLength,
    startS: -TRIB_OVERSHOOT,
    endS: tributaryLength + TRIB_OVERSHOOT + stationStep,
    stationStep,
    stations: tributaryTable,
    halfWidthAt: (s: number) => Math.max(7, 23 + 5.5 * Math.sin(s * 0.011 + 0.7) - s * 0.0045),
    // A real igarapé silts up inland; the bed rises to the waterline over the last 300 m so the creek
    // becomes marsh instead of ending in a cut-off hole, and the mouth stays navigable for a small boat.
    bedDepthAt: (s: number) =>
      Math.max(0.05, 2.8 + 0.7 * Math.sin(s * 0.0093 + 2.1) - s * 0.0011 - 3.2 * smoothstep(tributaryLength - 320, tributaryLength - 40, s)),
    influenceQ: FEATURE_BLEND_Q + 0.9,
  };
  const tributary = new RiverQuery(tributaryChannel);

  const oxbows: AmazonOxbow[] = [];
  for (let i = 0; i < 4; i++) {
    const s = length * (0.14 + 0.22 * i);
    const pose = main.poseAt(s, createRiverPose());
    const jitter = hash2i(seed, i * 13 + 5, 0x0ba9) / 2147483647.5 * 0.5 + 0.5;
    const side = i % 2 === 0 ? 1 : -1;
    oxbows.push({
      name: `lagoa-${i + 1}`,
      x: pose.x + pose.leftX * (320 + jitter * 60) * side,
      z: pose.z + pose.leftZ * (320 + jitter * 60) * side,
      radiusX: 150 + jitter * 90,
      radiusZ: 48 + ((jitter * 7) % 1) * 26,
      rotation: pose.heading + (jitter - 0.5) * 0.6,
      depth: 1.2 + jitter * 0.6,
    });
  }

  // The floodplain is a terrace, so the base never dips far under the waterline: a soft floor keeps
  // ponds from appearing in the middle of the jungle, where the demo draws no water sheet. Below the
  // floor the terrain compresses instead of clipping, so a dip still reads as a swale.
  const TERRACE_FLOOR = AMAZON_WATER_LEVEL + 0.6;
  const uplandAt = (x: number, z: number): number => {
    const raw =
      2.55 + noise.fbm(x * 0.0016, z * 0.0016, 11) * 5.4 + noise.fbm(x * 0.0062, z * 0.0062, 23) * 1.15;
    return raw < TERRACE_FLOOR ? TERRACE_FLOOR - (TERRACE_FLOOR - raw) * 0.22 : raw;
  };

  /**
   * Terrain elevation: the main channel, the *igarapé* and every oxbow are deltas on one base, and the
   * ground is as low as the deepest of them makes it. Composing features as `min` of *absolute* profiles
   * would leave a dry channel where a hill happened to cross the line, and would crease the ground where
   * one feature's influence ended; neither happens when every feature starts from the same base.
   */
  const elevationAt = (x: number, z: number): number => {
    const base = uplandAt(x, z);
    let elevation = main.elevationAt(x, z, base, MAIN_PROBE);
    const tribElevation = tributary.elevationAt(x, z, base, TRIB_PROBE);
    if (tribElevation < elevation) elevation = tribElevation;
    for (let i = 0; i < oxbows.length; i++) {
      const lake = oxbows[i]!;
      const dx = x - lake.x;
      const dz = z - lake.z;
      const cos = Math.cos(-lake.rotation);
      const sin = Math.sin(-lake.rotation);
      const lx = dx * cos - dz * sin;
      const lz = dx * sin + dz * cos;
      const nx = lx / lake.radiusX;
      const nz = lz / lake.radiusZ;
      const r = Math.hypot(nx, nz);
      // Blend on *metres* outside the one-contour, not on `r`: the ellipse is three or four times longer
      // than it is wide, so an r-based fade would be 20 m thick on the flanks and 90 m thick at the tips,
      // and the flanks would read as a canal cut through the reeds. |∇r| converts one to the other.
      const grad = Math.hypot(nx / lake.radiusX, nz / lake.radiusZ);
      const outside = grad > 1e-6 ? (r - 1) / grad : 0;
      if (outside > 34) continue;
      const blend = 1 - smoothstep(-6, 34, outside);
      const floor = AMAZON_WATER_LEVEL - lake.depth * (1 - smoothstep(0.3, 1.0, r));
      const rim = 0.55 * Math.exp(-Math.pow((outside - 9) / 13, 2));
      const lakeElevation = base * (1 - blend) + floor * blend + rim;
      if (lakeElevation < elevation) elevation = lakeElevation;
    }
    // Fine floodplain relief, gated to nothing inside the channel so the bed the boat reads is the bed
    // that was drawn.
    const relief = smoothstep(1.4, 2.5, MAIN_PROBE.q);
    if (relief > 0) {
      elevation +=
        (noise.fbm(x * 0.021, z * 0.021, 41) * 0.62 + noise.fbm(x * 0.0075, z * 0.0075, 53) * 1.25) * relief;
    }
    return elevation;
  };

  // Scratch for the compose path. `elevationAt` is the hottest function in the demo — the terrain mesh,
  // the buoyancy panels and every scatter rule go through it — so it reuses one probe instead of
  // allocating; nothing recurses into it, and a query's scratch is only read back after its own call.
  const MAIN_PROBE = createRiverProbe();
  const TRIB_PROBE = createRiverProbe();
  const scratchPose = createRiverPose();

  const thalwegLateralAt = (s: number): number => {
    const pose = main.poseAt(s, scratchPose);
    return -Math.tanh(pose.curvature * 240) * pose.halfWidth * 0.34;
  };

  const thalwegAt = (s: number, out: Vec3): Vec3 => {
    const pose = main.poseAt(s, scratchPose);
    const lateral = thalwegLateralAt(s);
    return out.set(pose.x + pose.leftX * lateral, AMAZON_WATER_LEVEL, pose.z + pose.leftZ * lateral);
  };

  const currentAt = (x: number, z: number, out: { x: number; z: number }): { x: number; z: number } => {
    const probe = main.probe(x, z);
    const pose = main.poseAt(probe.s, scratchPose);
    // Downstream is against the upriver heading; the thalweg carries the flow, the banks barely move.
    const strength = 1.32 * (1 - smoothstep(0.5, 1.12, probe.q)) + 0.16;
    out.x = -pose.forwardX * strength;
    out.z = -pose.forwardZ * strength;
    const tribProbe = tributary.probe(x, z);
    if (tribProbe.q < 1.1) {
      const tribPose = tributary.poseAt(tribProbe.s, scratchPose);
      const speed = 0.66 * (1 - smoothstep(0.45, 1.05, tribProbe.q));
      out.x = out.x * 0.35 - tribPose.forwardX * speed;
      out.z = out.z * 0.35 - tribPose.forwardZ * speed;
    }
    return out;
  };

  const normalAt = (x: number, z: number, out: Vec3): Vec3 => {
    const h = 0.7;
    const dx = elevationAt(x + h, z) - elevationAt(x - h, z);
    const dz = elevationAt(x, z + h) - elevationAt(x, z - h);
    return out.set(-dx, 2 * h, -dz).normalize();
  };

  const marks: AmazonJourneyMark[] = [
    { name: "Ponta Aripuanã landing stage", s: 46, lateral: 0, kind: "landing" },
    {
      name: "Vila da Bom Jesus",
      s: length * 0.238,
      lateral: -1.75 * mainChannel.halfWidthAt(length * 0.238),
      kind: "village",
    },
    { name: "Igarapé do Meio", s: junctionStation, lateral: 300, kind: "research" },
    {
      name: "Castanho trail community",
      s: length * 0.744,
      lateral: 1.8 * mainChannel.halfWidthAt(length * 0.744),
      kind: "village",
    },
    { name: "Reserva Adolpho research post", s: length - 70, lateral: 0, kind: "outpost" },
  ];
  const buoys: AmazonJourneyMark[] = [];
  let markIndex = 0;
  for (let s = 250; s < length - 150; s += 235) {
    const pose = main.poseAt(s, scratchPose);
    const lateral = thalwegLateralAt(s);
    const side = markIndex % 2 === 0 ? 1 : -1;
    markIndex++;
    buoys.push({
      name: `channel-mark-${markIndex}`,
      s,
      lateral: clamp(lateral + side * pose.halfWidth * 0.58, -pose.halfWidth * 1.05, pose.halfWidth * 1.05),
      kind: side > 0 ? "buoy-starboard" : "buoy-port",
    });
  }
  const allMarks: AmazonJourneyMark[] = [...marks, ...buoys];

  return {
    length,
    main,
    tributary,
    oxbows,
    marks: allMarks,
    uplandAt,
    elevationAt,
    depthAt: (x: number, z: number) => AMAZON_WATER_LEVEL - elevationAt(x, z),
    normalAt,
    thalwegLateralAt,
    thalwegAt,
    currentAt,
    isWater: (x: number, z: number, need = 0.55) => AMAZON_WATER_LEVEL - elevationAt(x, z) >= need,
    progressAt: (x: number, z: number) => clamp(main.probe(x, z).s / length, 0, 1),
    journeyStart: 0,
    overshoot,
    nominalWidthAt: (s: number) => mainChannel.halfWidthAt(s) * 2,
  };
}

/**
 * Cross-section column offsets for a ribbon: uniform through the bank band, geometric beyond, so the
 * shore gets metres of detail while the far floodplain gets long triangles that only have to hold a
 * silhouette through the haze.
 */
export function ribbonLateralOffsets(span = RIVER_RIBBON_HALF_SPAN): number[] {
  const inner = Math.min(RIBBON_INNER_BAND, span);
  const out: number[] = [0];
  for (let k = 1; k <= RIBBON_INNER_COLUMNS; k++) {
    const at = (k * inner) / RIBBON_INNER_COLUMNS;
    out.push(at, -at);
  }
  let last = inner;
  for (let j = 0; j < RIBBON_OUTER_COLUMNS; j++) {
    const next = Math.min(span, last * RIBBON_OUTER_RATIO);
    if (next - last < 0.5) break;
    out.push(next, -next);
    last = next;
  }
  if (last < span) out.push(span, -span);
  const unique = Array.from(new Set(out.map((value) => Math.round(value * 100) / 100)));
  unique.sort((a, b) => a - b);
  return unique;
}

/** One swept surface, in the shape `Geometry.create` takes plus the grid it was built from. */
export interface RiverRibbonGeometry {
  positions: Float32Array;
  normals: Float32Array;
  uvs: Float32Array;
  indices: Uint32Array;
  vertexCount: number;
  triangleCount: number;
  boundsMin: [number, number, number];
  boundsMax: [number, number, number];
  columns: number;
  stations: number;
}

export interface RiverRibbonOptions {
  stationStep?: number;
  /** First station to build; lets a caller split the ribbon into upload-sized pieces. */
  from?: number;
  to?: number;
  span?: number;
  /** A flat build is the water sheet: one surface at river stage that the water program displaces. */
  flat?: boolean;
  /** Metres of channel per UV repeat along `u`. */
  uvAlongMeters?: number;
  /** Elevation range mapped across `v`; `v = 0.42` is the waterline by construction. */
  uvHeightRange?: number;
  /** Shift of every vertex, used to float the water sheet just under the bank contour. */
  yOffset?: number;
}

/**
 * Sweep a channel-following ribbon through the elevation field.
 *
 * The mesh is parametric in (station, lateral column) rather than a world grid, which is what buys the
 * detail where it matters: every station row spends its columns on the channel and its banks. Normals
 * come from the grid's own finite differences, so the shading matches the drawn surface exactly and no
 * extra elevation queries are needed. `v` is derived from *elevation*, so the bands the demo paints
 * follow the waterline instead of the grid and the mud line never stair-steps across a meander.
 */
export function buildRiverRibbon(
  river: AmazonRiver,
  channel: "main" | "tributary",
  options: RiverRibbonOptions = {},
): RiverRibbonGeometry {
  const query = channel === "main" ? river.main : river.tributary;
  const stationStep = options.stationStep ?? RIBBON_STATION_STEP;
  const from = options.from ?? query.channel.startS;
  const to = options.to ?? query.channel.endS - query.channel.stationStep;
  const span = options.span ?? (options.flat ? WATER_RIBBON_HALF_SPAN : RIVER_RIBBON_HALF_SPAN);
  const uvAlong = options.uvAlongMeters ?? 260;
  const heightRange = options.uvHeightRange ?? 6.5;
  const yOffset = options.yOffset ?? 0;
  const stations = Math.max(2, Math.round((to - from) / stationStep) + 1);
  const offsets = ribbonLateralOffsets(span);
  const columns = offsets.length;
  const vertexCount = stations * columns;
  const positions = new Float32Array(vertexCount * 3);
  const normals = new Float32Array(vertexCount * 3);
  const uvs = new Float32Array(vertexCount * 2);
  const pose = createRiverPose();
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  let v = 0;
  for (let i = 0; i < stations; i++) {
    const s = from + i * stationStep;
    query.poseAt(s, pose);
    for (let j = 0; j < columns; j++) {
      const lateral = offsets[j]!;
      const x = pose.x + pose.leftX * lateral;
      const z = pose.z + pose.leftZ * lateral;
      const y = options.flat ? AMAZON_WATER_LEVEL : river.elevationAt(x, z);
      positions[v * 3] = x;
      positions[v * 3 + 1] = y + yOffset;
      positions[v * 3 + 2] = z;
      uvs[v * 2] = s / uvAlong;
      uvs[v * 2 + 1] = clamp((y - AMAZON_WATER_LEVEL) / heightRange + 0.42, 0, 1);
      v++;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
    }
  }
  const indices = new Uint32Array((stations - 1) * (columns - 1) * 6);
  let o = 0;
  for (let i = 0; i < stations - 1; i++) {
    for (let j = 0; j < columns - 1; j++) {
      const a = i * columns + j;
      const b = a + 1;
      const c = a + columns;
      const d = c + 1;
      // The engine's front face is the one whose (v1-v0)×(v2-v0) points out of the surface, which for
      // rows advancing along the channel with columns increasing to its left means (a, c, b) — the same
      // winding `planeGeometrySource` and `waterGridSource` use for an up-facing grid.
      indices[o++] = a;
      indices[o++] = c;
      indices[o++] = b;
      indices[o++] = b;
      indices[o++] = c;
      indices[o++] = d;
    }
  }
  // Vertex normals from the grid itself: central differences along station and across columns.
  for (let i = 0; i < stations; i++) {
    const rowUp = Math.max(0, i - 1);
    const rowDown = Math.min(stations - 1, i + 1);
    for (let j = 0; j < columns; j++) {
      const here = (i * columns + j) * 3;
      const up = (rowUp * columns + j) * 3;
      const down = (rowDown * columns + j) * 3;
      const left = (i * columns + Math.max(0, j - 1)) * 3;
      const right = (i * columns + Math.min(columns - 1, j + 1)) * 3;
      const dsx = positions[down]! - positions[up]!;
      const dsy = positions[down + 1]! - positions[up + 1]!;
      const dsz = positions[down + 2]! - positions[up + 2]!;
      const dcx = positions[right]! - positions[left]!;
      const dcy = positions[right + 1]! - positions[left + 1]!;
      const dcz = positions[right + 2]! - positions[left + 2]!;
      let nx = dsy * dcz - dsz * dcy;
      let ny = dsz * dcx - dsx * dcz;
      let nz = dsx * dcy - dsy * dcx;
      // The cross of (station, column) can point down depending on which way the ribbon runs; this is
      // a terrain heightfield everywhere, so force the normal up.
      if (ny < 0) {
        nx = -nx;
        ny = -ny;
        nz = -nz;
      }
      const len = Math.hypot(nx, ny, nz) || 1;
      normals[here] = nx / len;
      normals[here + 1] = ny / len;
      normals[here + 2] = nz / len;
    }
  }
  return {
    positions,
    normals,
    uvs,
    indices,
    vertexCount,
    triangleCount: (stations - 1) * (columns - 1) * 2,
    boundsMin: [minX, minY - Math.abs(yOffset), minZ],
    boundsMax: [maxX, maxY + Math.abs(yOffset), maxZ],
    columns,
    stations,
  };
}

/**
 * Deterministic 0..1 hash used by prop placement and shoreline banding, so a hut, a buoy or a tree
 * clump lands in the same place in every process and in every run.
 */
export function riverJitter(a: number, b: number, salt: number): number {
  return (hash2i(Math.floor(a), Math.floor(b), salt | 0) / 2147483647.5) * 0.5 + 0.5;
}

/**
 * A buildable spot on the bank: walking out from the channel, the first place where the ground is
 * `above` metres over the water and flat enough to stand a house on. `null` — the bank never gets
 * there, because it is a cut cliff or a lake shore — is the caller's cue to skip the prop, not to force
 * one.
 */
export function findBankSite(
  river: AmazonRiver,
  s: number,
  side: number,
  above: number,
  maxSlope = 0.2,
  steps = 34,
): { x: number; z: number; y: number; heading: number; distance: number } | null {
  const pose = river.main.poseAt(s, createRiverPose());
  const normal = new Vec3();
  for (let i = 0; i < steps; i++) {
    const lateral = pose.halfWidth * (1.05 + i * 0.09) * side;
    const x = pose.x + pose.leftX * lateral;
    const z = pose.z + pose.leftZ * lateral;
    const y = river.elevationAt(x, z);
    if (y - AMAZON_WATER_LEVEL < above) continue;
    river.normalAt(x, z, normal);
    if (1 - normal.y > maxSlope) continue;
    return { x, z, y, heading: pose.heading, distance: Math.abs(lateral) };
  }
  return null;
}
