/**
 * fe-28 finale rig for the Perseverance GLB.
 *
 * The converter merges every body mesh by material, so the rocker-bogie suspension arms are baked
 * into the body. For the YMCA dance the front (rocker) arms and the middle (bogie) arms must move
 * with their wheels, so {@link splitSuspension} re-buckets the body triangles on the CPU
 * (`Geometry.source` keeps positions/indices) into body + four arm pieces, and
 * {@link suspensionArmPose} turns a wheel's posed hub into the arm piece's transform: rotate the
 * piece about its body pivot so it points at the posed hub, then carry it along so the hub end
 * stays on the wheel. The rear wheels are the dancer's feet and never move, so their arm stays in
 * the body.
 *
 * Model frame: x right, y up, z nose; wheel hubs sit at y ≈ 0.26, |x| ≈ 1.1.
 */

import { Quat, Vec3, type GeometrySource } from "@forge/engine";

export type SuspensionPiece = "body" | "front+" | "front-" | "middle+" | "middle-";
export const SUSPENSION_ARM_PIECES = ["front+", "front-", "middle+", "middle-"] as const;
export type SuspensionArmPiece = (typeof SUSPENSION_ARM_PIECES)[number];

/** Arm triangles live outboard of the deck sides and below the deck. */
export const SUSPENSION_MIN_ABS_X = 0.78;
export const SUSPENSION_MAX_Y = 1.1;
/** Front (rocker) arm: forward of this z. Middle (bogie) arm: between the two, below `MIDDLE_MAX_Y`. */
export const SUSPENSION_FRONT_MIN_Z = 0.25;
export const SUSPENSION_MIDDLE_MIN_Z = -0.7;
export const SUSPENSION_MIDDLE_MAX_Y = 0.75;

/** Model-space body pivots the arms swing about (x sign = side). */
export const SUSPENSION_PIVOTS: Readonly<Record<SuspensionArmPiece, readonly [number, number, number]>> = {
  "front+": [0.88, 0.9, 0.1],
  "front-": [-0.88, 0.9, 0.1],
  "middle+": [0.9, 0.65, -0.45],
  "middle-": [-0.9, 0.65, -0.45],
};

/** Which piece a triangle (by centroid, model space) belongs to. */
export function classifySuspensionTriangle(x: number, y: number, z: number): SuspensionPiece {
  if (Math.abs(x) <= SUSPENSION_MIN_ABS_X || y >= SUSPENSION_MAX_Y) return "body";
  const side = x > 0 ? "+" : "-";
  if (z > SUSPENSION_FRONT_MIN_Z) return `front${side}`;
  if (z > SUSPENSION_MIDDLE_MIN_Z && y < SUSPENSION_MIDDLE_MAX_Y) return `middle${side}`;
  return "body";
}

/** Arm piece driven by wheel `index` (FL FR ML MR RL RR), given the wheel's model-space hub x; null for the rear pair. */
export function armPieceForWheel(index: number, hubX: number): SuspensionArmPiece | null {
  if (index > 3) return null;
  const side = hubX > 0 ? "+" : "-";
  return index < 2 ? `front${side}` : `middle${side}`;
}

/**
 * Split one mesh into per-piece compacted sources (only pieces with triangles appear). Works on
 * indexed and non-indexed triangle lists; attributes that exist are carried over.
 */
export function splitSuspension(
  src: GeometrySource,
  classify: (x: number, y: number, z: number) => SuspensionPiece = classifySuspensionTriangle,
): Map<SuspensionPiece, GeometrySource> {
  const p = src.positions;
  const vertexCount = Math.floor(p.length / 3);
  const indices = src.indices ?? Uint32Array.from({ length: vertexCount }, (_, i) => i);
  const buckets = new Map<SuspensionPiece, number[]>();
  for (let t = 0; t + 2 < indices.length; t += 3) {
    const a = indices[t]!;
    const b = indices[t + 1]!;
    const c = indices[t + 2]!;
    const cx = (p[a * 3]! + p[b * 3]! + p[c * 3]!) / 3;
    const cy = (p[a * 3 + 1]! + p[b * 3 + 1]! + p[c * 3 + 1]!) / 3;
    const cz = (p[a * 3 + 2]! + p[b * 3 + 2]! + p[c * 3 + 2]!) / 3;
    const piece = classify(cx, cy, cz);
    let list = buckets.get(piece);
    if (!list) buckets.set(piece, (list = []));
    list.push(a, b, c);
  }
  const out = new Map<SuspensionPiece, GeometrySource>();
  const copy = (arr: Float32Array | null | undefined, stride: number, remap: Int32Array, n: number): Float32Array | null => {
    if (!arr) return null;
    const dst = new Float32Array(n * stride);
    for (let v = 0; v < remap.length; v++) {
      const k = remap[v]!;
      if (k < 0) continue;
      for (let s = 0; s < stride; s++) dst[k * stride + s] = arr[v * stride + s]!;
    }
    return dst;
  };
  for (const [piece, list] of buckets) {
    const remap = new Int32Array(vertexCount).fill(-1);
    let n = 0;
    const idx = new Uint32Array(list.length);
    for (let i = 0; i < list.length; i++) {
      const v = list[i]!;
      if (remap[v]! < 0) remap[v] = n++;
      idx[i] = remap[v]!;
    }
    out.set(piece, {
      positions: copy(p, 3, remap, n)!,
      normals: copy(src.normals, 3, remap, n),
      uvs: copy(src.uvs, 2, remap, n),
      tangents: copy(src.tangents, 4, remap, n),
      indices: idx,
      label: `${src.label ?? "mesh"}-${piece}`,
    });
  }
  return out;
}

/** Shortest-arc rotation taking direction `a` onto direction `b` (any lengths). */
export function quatFromTo(a: Vec3, b: Vec3, out: Quat = new Quat()): Quat {
  const la = Math.hypot(a.x, a.y, a.z);
  const lb = Math.hypot(b.x, b.y, b.z);
  if (la < 1e-9 || lb < 1e-9) return out.set(0, 0, 0, 1);
  const ax = a.x / la, ay = a.y / la, az = a.z / la;
  const bx = b.x / lb, by = b.y / lb, bz = b.z / lb;
  const d = ax * bx + ay * by + az * bz;
  if (d < -0.999999) {
    // Opposite: 180° about any axis perpendicular to a.
    const px = Math.abs(ax) < 0.9 ? 1 : 0;
    const py = px ? 0 : 1;
    const cx = ay * 0 - az * py, cy = az * px - ax * 0, cz = ax * py - ay * px;
    const l = Math.hypot(cx, cy, cz);
    return out.set(cx / l, cy / l, cz / l, 0);
  }
  out.set(ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx, 1 + d);
  return out.normalize();
}

const tmpA = new Vec3();
const tmpB = new Vec3();
const tmpC = new Vec3();

/**
 * Chassis-local transform of an arm piece whose vertices are in model space and whose entity
 * normally sits at `modelOffset` (the body offset) with identity rotation.
 *
 * `pivot` is the arm's body pivot, `restHub` the wheel hub at rest and `target` the posed hub, all
 * chassis-local. The piece swings about the pivot to point at the target, then translates by
 * whatever reach is left so its hub end stays on the wheel. At `target === restHub` the result is
 * exactly the rest transform.
 */
export function suspensionArmPose(
  pivot: Vec3,
  restHub: Vec3,
  target: Vec3,
  modelOffset: Vec3,
  outPosition: Vec3,
  outRotation: Quat,
): void {
  tmpA.set(restHub.x - pivot.x, restHub.y - pivot.y, restHub.z - pivot.z);
  tmpB.set(target.x - pivot.x, target.y - pivot.y, target.z - pivot.z);
  quatFromTo(tmpA, tmpB, outRotation);
  // Hub after the swing: pivot + R·(restHub − pivot); carry = target − that.
  outRotation.rotateVector(tmpA, tmpC);
  const carryX = target.x - (pivot.x + tmpC.x);
  const carryY = target.y - (pivot.y + tmpC.y);
  const carryZ = target.z - (pivot.z + tmpC.z);
  // Entity position so that R·(v + offset − pivot) + pivot + carry = R·v + position.
  tmpA.set(pivot.x - modelOffset.x, pivot.y - modelOffset.y, pivot.z - modelOffset.z);
  outRotation.rotateVector(tmpA, tmpC);
  outPosition.set(pivot.x - tmpC.x + carryX, pivot.y - tmpC.y + carryY, pivot.z - tmpC.z + carryZ);
}

// ---------------------------------------------------------------- stage lights (fe-28)

/** Rainbow rig: this many sweeping lights on a truss over the finale. */
export const STAGE_LIGHT_COUNT = 6;
/** Truss height above the rover's ground and half-width (m). */
export const STAGE_TRUSS_HEIGHT = 12;
export const STAGE_TRUSS_HALF_WIDTH = 7.5;
/** How far the beams' ground spots sweep left/right (m) at full swing. */
export const STAGE_SWEEP_REACH = 6;

/** HSV (h in turns) → linear-ish RGB 0..1, saturated. */
export function rainbow(h: number, out: { r: number; g: number; b: number } = { r: 0, g: 0, b: 0 }): { r: number; g: number; b: number } {
  const hh = ((h % 1) + 1) % 1 * 6;
  const i = Math.floor(hh);
  const f = hh - i;
  const q = 1 - f;
  const table: [number, number, number][] = [[1, f, 0], [q, 1, 0], [0, 1, f], [0, q, 1], [f, 0, 1], [1, 0, q]];
  const [r, g, b] = table[i % 6]!;
  out.r = r;
  out.g = g;
  out.b = b;
  return out;
}

/** Light `i`'s colour at time `t`: spread over the rainbow, drifting so the rig cycles. */
export function stageLightColor(i: number, t: number, out?: { r: number; g: number; b: number }): { r: number; g: number; b: number } {
  return rainbow(i / STAGE_LIGHT_COUNT + t * 0.15, out);
}

/**
 * Light `i`'s head and ground-spot offsets in the rover's frame (x = side, z = forward, y = up):
 * heads spaced along a truss in front of the rover, spots sweeping left/right with `sweep`
 * (−1..1); neighbours swing in opposite directions so the beams criss-cross.
 */
export function stageLightAim(i: number, sweep: number): { head: { x: number; y: number; z: number }; spot: { x: number; y: number; z: number } } {
  const n: number = STAGE_LIGHT_COUNT;
  const across = n === 1 ? 0 : -STAGE_TRUSS_HALF_WIDTH + (2 * STAGE_TRUSS_HALF_WIDTH * i) / (n - 1);
  const dir = i % 2 === 0 ? 1 : -1;
  return {
    head: { x: across, y: STAGE_TRUSS_HEIGHT, z: 6 },
    spot: { x: across * 0.35 + dir * sweep * STAGE_SWEEP_REACH, y: 0, z: 0 },
  };
}
