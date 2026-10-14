/**
 * Mars Dust Storm Survival — fe-28 game model additions (pure, Node-testable):
 *
 * - {@link findRoute}: grid A* over the heightfield + boulder list. Cells inside a boulder (plus
 *   rover clearance) and steps steeper than the rover can climb are blocked; the cell path is then
 *   string-pulled into a few straight legs that are re-checked against the same rules.
 * - {@link randomStormCourse}: a fresh checkpoint layout every load (seeded, `?seed=` pins it),
 *   each beam accepted only when {@link findRoute} reaches it from the previous one.
 * - {@link buildGuideRibbon} / {@link guidePulse}: the easy-mode path follows the route, floats a
 *   hair above the ground, and a blue pulse runs along it toward the beam.
 * - {@link targetOnScreen}: clip-space frustum test for the off-screen arrow.
 * - {@link autoDriveDirection}: forward/reverse without a gear selector.
 * - {@link clearSkyProgress} / {@link ymcaDance}: the victory finale.
 */
import { Rng } from "@forge/engine";
import type { GroundHeightFn, StormCheckpoint, StripMesh } from "./dustStorm.js";

// ---------------------------------------------------------------- route finder

export interface RouteObstacle {
  x: number;
  z: number;
  radius: number;
}

export interface RoutePoint {
  x: number;
  z: number;
}

export interface RouteOptions {
  /** Grid cell size (m). */
  cell?: number;
  /** Steepest grade the route may take, degrees. */
  maxSlopeDeg?: number;
  /** Rover half-width kept clear of every boulder's collision radius (m). */
  clearance?: number;
  /** Search margin around the start/goal bounding box (m). */
  pad?: number;
}

export const ROUTE_CELL = 2;
/** The rover climbs ~30°; routes keep a margin under it. */
export const ROUTE_MAX_SLOPE_DEG = 27;
/** Matches the scene's rover push-out radius (ROVER_RADIUS 1.6) less a little slack. */
export const ROUTE_CLEARANCE = 1.5;
export const ROUTE_PAD = 40;
/** Boulders collide at 0.85 × their visual radius (the scene's `collideProps`). */
const OBSTACLE_SCALE = 0.85;

function blockedByObstacle(x: number, z: number, obstacles: readonly RouteObstacle[], clearance: number): boolean {
  for (const o of obstacles) {
    const r = o.radius * OBSTACLE_SCALE + clearance;
    const dx = x - o.x;
    const dz = z - o.z;
    if (dx * dx + dz * dz < r * r) return true;
  }
  return false;
}

/** True when the straight segment is drivable: no boulder within clearance, no step too steep. */
export function routeClear(x0: number, z0: number, x1: number, z1: number, ground: GroundHeightFn, obstacles: readonly RouteObstacle[], options: RouteOptions = {}): boolean {
  const clearance = options.clearance ?? ROUTE_CLEARANCE;
  const maxGrade = Math.tan(((options.maxSlopeDeg ?? ROUTE_MAX_SLOPE_DEG) * Math.PI) / 180);
  const len = Math.hypot(x1 - x0, z1 - z0);
  const steps = Math.max(1, Math.ceil(len / 1));
  let prevH = ground(x0, z0);
  const stepLen = len / steps;
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const x = x0 + (x1 - x0) * t;
    const z = z0 + (z1 - z0) * t;
    // The end points may sit inside a clearance ring (rover pushed against a rock, beam near one).
    if (i < steps && blockedByObstacle(x, z, obstacles, clearance)) return false;
    const h = ground(x, z);
    // Grade measured over ~ROUTE_CELL so micro-bumps the wheels roll over do not count.
    if (stepLen > 0 && Math.abs(h - prevH) / stepLen > maxGrade * 1.15 && len > 0.5) {
      // Re-measure over a 2 m baseline before refusing (sampling noise on 1 m steps).
      const bx = x - ((x1 - x0) / len) * Math.min(2, i * stepLen);
      const bz = z - ((z1 - z0) / len) * Math.min(2, i * stepLen);
      const base = Math.hypot(x - bx, z - bz);
      if (base > 0 && Math.abs(h - ground(bx, bz)) / base > maxGrade) return false;
    }
    prevH = h;
  }
  return true;
}

class MinHeap {
  private readonly ids: number[] = [];
  private readonly keys: number[] = [];
  get size(): number {
    return this.ids.length;
  }
  push(id: number, key: number): void {
    const ids = this.ids;
    const keys = this.keys;
    let i = ids.length;
    ids.push(id);
    keys.push(key);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (keys[p]! <= key) break;
      ids[i] = ids[p]!;
      keys[i] = keys[p]!;
      i = p;
    }
    ids[i] = id;
    keys[i] = key;
  }
  pop(): number {
    const ids = this.ids;
    const keys = this.keys;
    const top = ids[0]!;
    const lastId = ids.pop()!;
    const lastKey = keys.pop()!;
    const n = ids.length;
    if (n > 0) {
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        if (l >= n) break;
        const r = l + 1;
        const c = r < n && keys[r]! < keys[l]! ? r : l;
        if (keys[c]! >= lastKey) break;
        ids[i] = ids[c]!;
        keys[i] = keys[c]!;
        i = c;
      }
      ids[i] = lastId;
      keys[i] = lastKey;
    }
    return top;
  }
}

const NEIGHBOURS: readonly [number, number, number][] = [
  [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
  [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2],
];

/**
 * Drivable route from (x0, z0) to (x1, z1), or null when none exists inside the search window.
 * Returns the string-pulled corner points, starting and ending exactly at the two inputs.
 */
export function findRoute(x0: number, z0: number, x1: number, z1: number, ground: GroundHeightFn, obstacles: readonly RouteObstacle[], options: RouteOptions = {}): RoutePoint[] | null {
  const cell = options.cell ?? ROUTE_CELL;
  const pad = options.pad ?? ROUTE_PAD;
  const clearance = options.clearance ?? ROUTE_CLEARANCE;
  const maxGrade = Math.tan(((options.maxSlopeDeg ?? ROUTE_MAX_SLOPE_DEG) * Math.PI) / 180);
  if (routeClear(x0, z0, x1, z1, ground, obstacles, options)) return [{ x: x0, z: z0 }, { x: x1, z: z1 }];

  const minX = Math.min(x0, x1) - pad;
  const minZ = Math.min(z0, z1) - pad;
  const nx = Math.ceil((Math.max(x0, x1) + pad - minX) / cell) + 1;
  const nz = Math.ceil((Math.max(z0, z1) + pad - minZ) / cell) + 1;
  const count = nx * nz;
  const height = new Float32Array(count);
  const blocked = new Uint8Array(count);
  const wx = (i: number): number => minX + (i % nx) * cell;
  const wz = (i: number): number => minZ + Math.floor(i / nx) * cell;
  const local = (x: number, z: number): number => Math.round((z - minZ) / cell) * nx + Math.round((x - minX) / cell);
  const start = local(x0, z0);
  const goal = local(x1, z1);
  for (let i = 0; i < count; i++) {
    const x = wx(i);
    const z = wz(i);
    height[i] = ground(x, z);
    blocked[i] = blockedByObstacle(x, z, obstacles, clearance) ? 1 : 0;
  }
  blocked[start] = 0;
  blocked[goal] = 0;

  const g = new Float32Array(count).fill(Infinity);
  const from = new Int32Array(count).fill(-1);
  const closed = new Uint8Array(count);
  const heap = new MinHeap();
  const gx = wx(goal);
  const gz = wz(goal);
  g[start] = 0;
  heap.push(start, Math.hypot(wx(start) - gx, wz(start) - gz));
  let found = false;
  while (heap.size > 0) {
    const cur = heap.pop();
    if (closed[cur]) continue;
    closed[cur] = 1;
    if (cur === goal) {
      found = true;
      break;
    }
    const cx = cur % nx;
    const cz = Math.floor(cur / nx);
    for (const [dx, dz, unit] of NEIGHBOURS) {
      const ax = cx + dx;
      const az = cz + dz;
      if (ax < 0 || az < 0 || ax >= nx || az >= nz) continue;
      const n = az * nx + ax;
      if (closed[n] || blocked[n]) continue;
      // Diagonals may not cut a blocked corner.
      if (dx !== 0 && dz !== 0 && (blocked[cz * nx + ax] || blocked[az * nx + cx])) continue;
      const run = unit * cell;
      const grade = Math.abs(height[n]! - height[cur]!) / run;
      if (grade > maxGrade) continue;
      const cost = g[cur]! + run * (1 + 2 * grade);
      if (cost < g[n]!) {
        g[n] = cost;
        from[n] = cur;
        heap.push(n, cost + Math.hypot(wx(n) - gx, wz(n) - gz));
      }
    }
  }
  if (!found) return null;

  const cells: RoutePoint[] = [];
  for (let c = goal; c !== -1; c = from[c]!) cells.push({ x: wx(c), z: wz(c) });
  cells.reverse();
  cells[0] = { x: x0, z: z0 };
  cells[cells.length - 1] = { x: x1, z: z1 };
  // String-pull: from each corner jump to the farthest cell still in clear line of sight.
  const out: RoutePoint[] = [cells[0]!];
  let i = 0;
  while (i < cells.length - 1) {
    // Greedy forward scan (stop at the first blocked shortcut): O(cells) segment checks per
    // corner instead of re-testing every far cell from the goal backwards.
    let j = i + 1;
    while (j + 1 < cells.length && routeClear(cells[i]!.x, cells[i]!.z, cells[j + 1]!.x, cells[j + 1]!.z, ground, obstacles, options)) j++;
    out.push(cells[j]!);
    i = j;
  }
  return out;
}

export function polylineLength(points: readonly RoutePoint[]): number {
  let len = 0;
  for (let i = 1; i < points.length; i++) len += Math.hypot(points[i]!.x - points[i - 1]!.x, points[i]!.z - points[i - 1]!.z);
  return len;
}

/** Point `s` metres along the polyline (clamped), with its unit direction. */
export function samplePolyline(points: readonly RoutePoint[], s: number, out = { x: 0, z: 0, dx: 1, dz: 0 }): { x: number; z: number; dx: number; dz: number } {
  let rest = Math.max(0, s);
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    if (len < 1e-9) continue;
    const last = i === points.length - 1;
    if (rest <= len || last) {
      const t = Math.min(1, rest / len);
      out.x = a.x + (b.x - a.x) * t;
      out.z = a.z + (b.z - a.z) * t;
      out.dx = (b.x - a.x) / len;
      out.dz = (b.z - a.z) / len;
      return out;
    }
    rest -= len;
  }
  const p = points[0] ?? { x: 0, z: 0 };
  out.x = p.x;
  out.z = p.z;
  return out;
}

/** True when every leg spawn → cp0 → cp1 … has a drivable route. */
export function courseReachable(spawnX: number, spawnZ: number, checkpoints: readonly StormCheckpoint[], ground: GroundHeightFn, obstacles: readonly RouteObstacle[], options: RouteOptions = {}): boolean {
  let px = spawnX;
  let pz = spawnZ;
  for (const cp of checkpoints) {
    if (!findRoute(px, pz, cp.x, cp.z, ground, obstacles, options)) return false;
    px = cp.x;
    pz = cp.z;
  }
  return true;
}

// ---------------------------------------------------------------- random course

export interface RandomCourseOptions {
  count?: number;
  /** Leg length range (m). */
  minLeg?: number;
  maxLeg?: number;
  /** Beams stay within this distance of the spawn (inside the streamed terrain). */
  worldRadius?: number;
  /** Candidate tries per beam before the whole course is retried. */
  triesPerBeam?: number;
  /** Whole-course retries before falling back. */
  maxAttempts?: number;
  /** Used when no random course validates (e.g. the surveyed fixed layout). */
  fallback?: readonly StormCheckpoint[];
  route?: RouteOptions;
}

export interface RandomCourse {
  seed: number;
  checkpoints: StormCheckpoint[];
  /** Whole-course attempts used (1 = first try). */
  attempts: number;
  fallback: boolean;
}

/** Ground around a beam must be gentle enough to stop on (≈ the rover's limit over the ring). */
function beamSiteOk(x: number, z: number, ground: GroundHeightFn, maxGrade: number): boolean {
  const h = ground(x, z);
  for (let a = 0; a < 8; a++) {
    const ang = (a / 8) * Math.PI * 2;
    if (Math.abs(ground(x + Math.cos(ang) * 4, z + Math.sin(ang) * 4) - h) / 4 > maxGrade) return false;
  }
  return true;
}

/**
 * Seeded random course: each beam lands 60–120 m from the previous in a random direction (biased
 * to keep wandering instead of doubling back) and is kept only if a drivable route reaches it.
 */
export function randomStormCourse(seed: number, spawnX: number, spawnZ: number, ground: GroundHeightFn, options: RandomCourseOptions = {}): RandomCourse {
  const count = options.count ?? 6;
  const minLeg = options.minLeg ?? 60;
  const maxLeg = options.maxLeg ?? 120;
  const worldRadius = options.worldRadius ?? 400;
  const triesPerBeam = options.triesPerBeam ?? 24;
  const maxAttempts = options.maxAttempts ?? 8;
  const route = options.route ?? {};
  const maxGrade = Math.tan(((route.maxSlopeDeg ?? ROUTE_MAX_SLOPE_DEG) * Math.PI) / 180);
  const rng = new Rng(seed >>> 0 || 1);
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const out: StormCheckpoint[] = [];
    let px = spawnX;
    let pz = spawnZ;
    let heading = rng.nextFloat() * Math.PI * 2;
    let ok = true;
    for (let i = 0; i < count && ok; i++) {
      let placed = false;
      for (let t = 0; t < triesPerBeam; t++) {
        const h = heading + rng.nextSignedFloat() * (t < triesPerBeam / 2 ? 1.2 : Math.PI);
        const step = rng.nextRange(minLeg, maxLeg);
        const x = px + Math.cos(h) * step;
        const z = pz + Math.sin(h) * step;
        if (Math.hypot(x - spawnX, z - spawnZ) > worldRadius) continue;
        if (out.some((c) => Math.hypot(c.x - x, c.z - z) < minLeg * 0.6) || Math.hypot(x - spawnX, z - spawnZ) < minLeg * 0.6) continue;
        if (!beamSiteOk(x, z, ground, maxGrade)) continue;
        if (!findRoute(px, pz, x, z, ground, [], route)) continue;
        out.push({ x, z });
        px = x;
        pz = z;
        heading = h;
        placed = true;
        break;
      }
      ok = placed;
    }
    if (ok) return { seed, checkpoints: out, attempts: attempt, fallback: false };
  }
  return { seed, checkpoints: (options.fallback ?? []).map((c) => ({ x: c.x, z: c.z })), attempts: maxAttempts, fallback: true };
}

/** `?seed=` (uint32) when it parses, otherwise a fresh random seed every load. */
export function randomCourseSeed(param: string | null, random: () => number = Math.random): number {
  if (param !== null && /^\d+$/.test(param.trim())) return Number(param.trim()) >>> 0;
  return Math.floor(random() * 0xffffffff) >>> 0;
}

// ---------------------------------------------------------------- guide ribbon + pulse

/** The path barely floats: high enough to read as hovering, low enough to hug the ground. */
export const GUIDE_FLOAT_OFFSET = 0.3;
export const GUIDE_RIBBON_POINTS = 96;
export const GUIDE_RIBBON_HALF_WIDTH = 0.45;
/** Drawn reach (m) along the route; legs are ≤ ~130 m so this normally covers the whole leg. */
export const GUIDE_RIBBON_MAX = 160;
/** Ribbon starts this far ahead of the rover so it does not sit under the chassis. */
export const GUIDE_RIBBON_START = 2.5;

export interface RibbonOptions {
  from?: number;
  to?: number;
  points?: number;
  offset?: number;
  halfWidth?: number;
}

/**
 * Ribbon draped along a route polyline between arc lengths `from`..`to`, `offset` above the ground.
 * Positions are relative to (start.x, ground(start), start.z) where start is the polyline's first
 * point; uv.y runs 0 → 1 along the ribbon.
 */
export function buildGuideRibbon(route: readonly RoutePoint[], ground: GroundHeightFn, out?: StripMesh & { baseY: number }, options: RibbonOptions = {}): StripMesh & { baseY: number } {
  const N = options.points ?? GUIDE_RIBBON_POINTS;
  const offset = options.offset ?? GUIDE_FLOAT_OFFSET;
  const hw = options.halfWidth ?? GUIDE_RIBBON_HALF_WIDTH;
  const mesh = out ?? {
    positions: new Float32Array(N * 2 * 3),
    normals: new Float32Array(N * 2 * 3),
    uvs: new Float32Array(N * 2 * 2),
    indices: (() => {
      const idx: number[] = [];
      for (let i = 0; i < N - 1; i++) {
        const a = i * 2;
        idx.push(a, a + 2, a + 3, a, a + 3, a + 1);
      }
      return new Uint16Array(idx);
    })(),
    baseY: 0,
  };
  const origin = route[0] ?? { x: 0, z: 0 };
  const baseY = ground(origin.x, origin.z);
  mesh.baseY = baseY;
  const total = polylineLength(route);
  const s0 = Math.max(0, Math.min(total, options.from ?? Math.min(GUIDE_RIBBON_START, total)));
  const s1 = Math.max(s0, Math.min(total, options.to ?? Math.min(total, GUIDE_RIBBON_MAX)));
  const p = { x: 0, z: 0, dx: 1, dz: 0 };
  for (let i = 0; i < N; i++) {
    const s = s0 + ((s1 - s0) * i) / (N - 1);
    samplePolyline(route, s, p);
    for (let j = 0; j < 2; j++) {
      const side = j === 0 ? -hw : hw;
      const wx = p.x - p.dz * side;
      const wz = p.z + p.dx * side;
      const v = i * 2 + j;
      mesh.positions[v * 3] = wx - origin.x;
      mesh.positions[v * 3 + 1] = ground(wx, wz) + offset - baseY;
      mesh.positions[v * 3 + 2] = wz - origin.z;
      mesh.normals[v * 3] = 0;
      mesh.normals[v * 3 + 1] = 1;
      mesh.normals[v * 3 + 2] = 0;
      mesh.uvs[v * 2] = j;
      mesh.uvs[v * 2 + 1] = i / (N - 1);
    }
  }
  return mesh;
}

export const GUIDE_PULSE_SPEED = 24;
export const GUIDE_PULSE_LENGTH = 6;
/** Pause (s) with no pulse before the next one leaves the rover. */
export const GUIDE_PULSE_GAP = 0.4;
export const GUIDE_PULSE_POINTS = 8;

/** The travelling blue pulse: a short bright stretch [tail, head] running rover → beam, looping. */
export function guidePulse(t: number, length: number, out = { head: 0, tail: 0, opacity: 0 }): { head: number; tail: number; opacity: number } {
  const span = Math.max(1, length);
  const period = (span + GUIDE_PULSE_LENGTH) / GUIDE_PULSE_SPEED + GUIDE_PULSE_GAP;
  const phase = ((t % period) + period) % period;
  const head = Math.min(span, phase * GUIDE_PULSE_SPEED);
  const tail = Math.max(0, Math.min(span, phase * GUIDE_PULSE_SPEED - GUIDE_PULSE_LENGTH));
  out.head = head;
  out.tail = Math.min(tail, Math.max(0, head - 0.2));
  // Fade in leaving the rover and out arriving at the beam.
  const fadeIn = Math.min(1, head / 4);
  const fadeOut = Math.min(1, (span - out.tail) / 4);
  out.opacity = head - out.tail > 0.05 ? 0.85 * Math.max(0, Math.min(fadeIn, fadeOut)) : 0;
  return out;
}

// ---------------------------------------------------------------- off-screen arrow

/**
 * True when the world point lies inside the camera frustum of a column-major view-projection
 * (WebGPU clip: x, y in [−w, w], z in [0, w]). `margin` < 1 shrinks the accepted x/y window.
 */
export function targetOnScreen(viewProjection: ArrayLike<number>, x: number, y: number, z: number, margin = 1): boolean {
  const m = viewProjection;
  const cx = m[0]! * x + m[4]! * y + m[8]! * z + m[12]!;
  const cy = m[1]! * x + m[5]! * y + m[9]! * z + m[13]!;
  const cz = m[2]! * x + m[6]! * y + m[10]! * z + m[14]!;
  const cw = m[3]! * x + m[7]! * y + m[11]! * z + m[15]!;
  if (!(cw > 1e-4)) return false;
  const lim = cw * margin;
  return Math.abs(cx) <= lim && Math.abs(cy) <= lim && cz >= 0 && cz <= cw;
}

// ---------------------------------------------------------------- drive direction

/** Below this ground speed (m/s) the rover may swap between forward and reverse. */
export const AUTO_REVERSE_SPEED = 0.6;

/**
 * Gas / brake → gear + pedals without a selector: gas drives forward, brake slows and, once
 * (nearly) stopped, backs up. While rolling the opposite pedal only brakes.
 * `forwardSpeed` is signed along the chassis heading (negative = rolling backwards).
 */
export function autoDriveDirection(gear: number, throttle: number, brake: number, forwardSpeed: number): { gear: 1 | -1; throttle: number; brake: number } {
  const current: 1 | -1 = gear < 0 ? -1 : 1;
  const slow = Math.abs(forwardSpeed) < AUTO_REVERSE_SPEED;
  if (current === 1) {
    if (brake > 0.01 && throttle <= 0.01 && slow) return { gear: -1, throttle: brake, brake: 0 };
    return { gear: 1, throttle, brake };
  }
  // In reverse: brake is the "go backwards" pedal, gas brakes until stopped then drives forward.
  if (throttle > 0.01) {
    if (slow || forwardSpeed > 0) return { gear: 1, throttle, brake: 0 };
    return { gear: -1, throttle: 0, brake: throttle };
  }
  return { gear: -1, throttle: brake, brake: 0 };
}

// ---------------------------------------------------------------- finale

export const CLEAR_SKY_DURATION = 6;

/** 0 → 1 smoothstep over {@link CLEAR_SKY_DURATION} seconds after the last beam. */
export function clearSkyProgress(sinceWin: number): number {
  const t = Math.max(0, Math.min(1, sinceWin / CLEAR_SKY_DURATION));
  return t * t * (3 - 2 * t);
}

export const YMCA_LETTERS = ["Y", "M", "C", "A"] as const;
export type YmcaLetter = (typeof YMCA_LETTERS)[number];
/** Seconds to rise onto the rear wheels before the first letter. */
export const YMCA_RISE = 1.8;
/** Seconds per letter (blend in + hold), then a short bounce before the next chorus. */
export const YMCA_BEAT = 0.8;
export const YMCA_BREAK = 1.2;
export const YMCA_STAND_PITCH = (72 * Math.PI) / 180;

/**
 * Wheel offsets per letter, chassis-local (x right, y deck-up, z nose), as deltas from each
 * wheel's rest hub; with the chassis pitched nose-up, +z is "up" for the dancer and ±x are its
 * sides. Order: FL, FR (hands), ML, MR (elbows), RL, RR (feet, always 0).
 */
type Pose = readonly (readonly [number, number, number])[];
const REST: Pose = [[0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]];
const POSES: Record<YmcaLetter, Pose> = {
  // Y: hands high and wide, elbows tucked in so the arms read as a V.
  Y: [[-1.7, 0.4, 2.2], [1.7, 0.4, 2.2], [0.2, 0.3, 1.2], [-0.2, 0.3, 1.2], [0, 0, 0], [0, 0, 0]],
  // M: hands folded in over the "head", elbows out wide.
  M: [[0.8, 0.7, 1.6], [-0.8, 0.7, 1.6], [-1.0, 0.4, 1.5], [1.0, 0.4, 1.5], [0, 0, 0], [0, 0, 0]],
  // C: both arms curve to the dancer's right.
  C: [[1.7, 0.4, 1.8], [1.2, 0.4, -0.2], [0.9, 0.3, 1.6], [1.0, 0.3, -0.4], [0, 0, 0], [0, 0, 0]],
  // A: hands meet high above the head, elbows slightly out.
  A: [[0.95, 0.5, 2.4], [-0.95, 0.5, 2.4], [-0.3, 0.3, 1.0], [0.3, 0.3, 1.0], [0, 0, 0], [0, 0, 0]],
};

export interface YmcaFrame {
  /** 0 → 1 while rising onto the rear wheels. */
  stand: number;
  /** Nose-up chassis pitch (radians). */
  pitch: number;
  /** Small vertical bounce of the rear-axle pivot (m). */
  bounce: number;
  /** Letter being formed (null while rising / on the break). */
  letter: YmcaLetter | null;
  /** 0 → 1: how fully the current letter is formed. */
  hold: number;
  /** Six chassis-local wheel deltas, FL FR ML MR RL RR. */
  wheels: { x: number; y: number; z: number }[];
  /** Shorthand for wheels[0], wheels[1]. */
  hands: [{ x: number; y: number; z: number }, { x: number; y: number; z: number }];
  /** Wheel spin rate (rad/s) for the waving wheels. */
  spin: number;
}

const smooth = (t: number): number => {
  const c = Math.max(0, Math.min(1, t));
  return c * c * (3 - 2 * c);
};

function blendPose(a: Pose, b: Pose, t: number, out: YmcaFrame["wheels"]): void {
  for (let i = 0; i < 6; i++) {
    const w = out[i]!;
    w.x = a[i]![0] + (b[i]![0] - a[i]![0]) * t;
    w.y = a[i]![1] + (b[i]![1] - a[i]![1]) * t;
    w.z = a[i]![2] + (b[i]![2] - a[i]![2]) * t;
  }
}

/** YMCA finale at `t` seconds after it began: rise, then Y-M-C-A + break, looping. */
export function ymcaDance(t: number): YmcaFrame {
  const wheels = Array.from({ length: 6 }, () => ({ x: 0, y: 0, z: 0 }));
  const frame: YmcaFrame = { stand: 0, pitch: 0, bounce: 0, letter: null, hold: 0, wheels, hands: [wheels[0]!, wheels[1]!], spin: 0 };
  if (t < YMCA_RISE) {
    frame.stand = smooth(t / YMCA_RISE);
    frame.pitch = YMCA_STAND_PITCH * frame.stand;
    return frame;
  }
  frame.stand = 1;
  const chorus = YMCA_LETTERS.length * YMCA_BEAT + YMCA_BREAK;
  const c = (t - YMCA_RISE) % chorus;
  const slot = Math.floor(c / YMCA_BEAT);
  const beatPhase = (c % YMCA_BEAT) / YMCA_BEAT;
  frame.bounce = 0.08 * Math.abs(Math.sin(((t - YMCA_RISE) * Math.PI) / YMCA_BEAT));
  frame.pitch = YMCA_STAND_PITCH + 0.04 * Math.sin(((t - YMCA_RISE) * Math.PI * 2) / YMCA_BEAT);
  if (slot < YMCA_LETTERS.length) {
    const letter = YMCA_LETTERS[slot]!;
    const prev = slot === 0 ? REST : POSES[YMCA_LETTERS[slot - 1]!];
    // Blend in over the first 45% of the beat, hold the rest.
    const k = smooth(beatPhase / 0.45);
    blendPose(prev, POSES[letter], k, wheels);
    frame.letter = letter;
    frame.hold = k;
    frame.spin = 0;
  } else {
    // Break: arms drop back to rest while the wheels spin like a cheering crowd.
    const k = smooth((c - YMCA_LETTERS.length * YMCA_BEAT) / (YMCA_BREAK * 0.6));
    blendPose(POSES.A, REST, k, wheels);
    frame.spin = 10 * Math.sin(Math.PI * Math.min(1, k));
  }
  return frame;
}
