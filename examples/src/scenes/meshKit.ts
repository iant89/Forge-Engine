/**
 * Procedural mesh kit for the demo scenes: pure `GeometrySource` builders with no GPU dependency.
 *
 * The engine's primitives (box, cylinder, sphere…) are enough for props, but a believable vehicle
 * body needs rounded edges, a lofted cabin, wheel arches and lathe-turned tyres. These helpers add
 * those and a {@link MeshBuilder} that bakes many transformed parts into one source, so a truck is a
 * handful of draw calls rather than hundreds of entities.
 *
 * Conventions (match the engine primitives): +Y up, triangles wind so that
 * `cross(p1 - p0, p2 - p0)` points out of the solid, normals are unit and outward, UVs are in [0, 1].
 * Everything is deterministic — the same arguments give the same bytes.
 */

import { boxGeometrySource, computeNormalsAndTangents, cylinderGeometrySource, type GeometrySource } from "@forge/engine";

// ------------------------------------------------------------------ affine transforms

/** Row-major 3×4 affine transform: `[m00 m01 m02 tx, m10 m11 m12 ty, m20 m21 m22 tz]`. */
export type Affine = readonly [number, number, number, number, number, number, number, number, number, number, number, number];

export const IDENTITY: Affine = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];

export function translate(x: number, y: number, z: number): Affine {
  return [1, 0, 0, x, 0, 1, 0, y, 0, 0, 1, z];
}

export function scaleBy(x: number, y = x, z = x): Affine {
  return [x, 0, 0, 0, 0, y, 0, 0, 0, 0, z, 0];
}

export function rotateX(angle: number): Affine {
  const c = Math.cos(angle), s = Math.sin(angle);
  return [1, 0, 0, 0, 0, c, -s, 0, 0, s, c, 0];
}

export function rotateY(angle: number): Affine {
  const c = Math.cos(angle), s = Math.sin(angle);
  return [c, 0, s, 0, 0, 1, 0, 0, -s, 0, c, 0];
}

export function rotateZ(angle: number): Affine {
  const c = Math.cos(angle), s = Math.sin(angle);
  return [c, -s, 0, 0, s, c, 0, 0, 0, 0, 1, 0];
}

/** Apply `a` first, then `b` (so `compose(rotateX(r), translate(…))` rotates, then moves). */
export function compose(a: Affine, b: Affine): Affine {
  const o = new Array<number>(12);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) o[r * 4 + c] = b[r * 4]! * a[c]! + b[r * 4 + 1]! * a[4 + c]! + b[r * 4 + 2]! * a[8 + c]!;
    o[r * 4 + 3] = b[r * 4]! * a[3]! + b[r * 4 + 1]! * a[7]! + b[r * 4 + 2]! * a[11]! + b[r * 4 + 3]!;
  }
  return o as unknown as Affine;
}

/** Chain several transforms left to right (the first is applied first). */
export function chain(...ts: Affine[]): Affine {
  return ts.reduce((acc, t) => compose(acc, t), IDENTITY);
}

/** Rotation taking +Y onto the direction (dx, dy, dz) — for tubes and axle-aligned cylinders. */
export function alignYTo(dx: number, dy: number, dz: number): Affine {
  const len = Math.hypot(dx, dy, dz) || 1;
  const x = dx / len, y = dy / len, z = dz / len;
  if (y > 0.999999) return IDENTITY;
  if (y < -0.999999) return rotateX(Math.PI);
  // Axis = Y × d = (z, 0, -x), angle θ with cos θ = y and sin θ = |axis|: Rodrigues' formula.
  const s = Math.hypot(x, z);
  const kx = z / s, kz = -x / s;
  const c = y, t = 1 - c;
  return [
    t * kx * kx + c, -s * kz, t * kx * kz, 0,
    s * kz, c, -s * kx, 0,
    t * kx * kz, s * kx, t * kz * kz + c, 0,
  ];
}

function determinant(m: Affine): number {
  return m[0] * (m[5] * m[10] - m[6] * m[9]) - m[1] * (m[4] * m[10] - m[6] * m[8]) + m[2] * (m[4] * m[9] - m[5] * m[8]);
}

// ------------------------------------------------------------------ builder

/** Accumulates transformed copies of sources into one mesh (one material, one draw). */
export class MeshBuilder {
  private readonly positions: number[] = [];
  private readonly normals: number[] = [];
  private readonly uvs: number[] = [];
  private readonly indices: number[] = [];

  /** Append `source` transformed by `t`. Mirroring transforms flip the winding so faces stay outward. */
  add(source: GeometrySource, t: Affine = IDENTITY): this {
    const count = Math.floor(source.positions.length / 3);
    const base = this.positions.length / 3;
    const det = determinant(t);
    // Normals transform by the cofactor matrix (inverse-transpose up to scale), then renormalise.
    const cof = [
      t[5] * t[10] - t[6] * t[9], t[6] * t[8] - t[4] * t[10], t[4] * t[9] - t[5] * t[8],
      t[2] * t[9] - t[1] * t[10], t[0] * t[10] - t[2] * t[8], t[1] * t[8] - t[0] * t[9],
      t[1] * t[6] - t[2] * t[5], t[2] * t[4] - t[0] * t[6], t[0] * t[5] - t[1] * t[4],
    ];
    for (let i = 0; i < count; i++) {
      const x = source.positions[i * 3]!, y = source.positions[i * 3 + 1]!, z = source.positions[i * 3 + 2]!;
      this.positions.push(t[0] * x + t[1] * y + t[2] * z + t[3], t[4] * x + t[5] * y + t[6] * z + t[7], t[8] * x + t[9] * y + t[10] * z + t[11]);
      if (source.normals) {
        const nx = source.normals[i * 3]!, ny = source.normals[i * 3 + 1]!, nz = source.normals[i * 3 + 2]!;
        let ox = cof[0]! * nx + cof[1]! * ny + cof[2]! * nz;
        let oy = cof[3]! * nx + cof[4]! * ny + cof[5]! * nz;
        let oz = cof[6]! * nx + cof[7]! * ny + cof[8]! * nz;
        if (det < 0) { ox = -ox; oy = -oy; oz = -oz; }
        const l = Math.hypot(ox, oy, oz) || 1;
        this.normals.push(ox / l, oy / l, oz / l);
      } else {
        this.normals.push(0, 1, 0);
      }
      this.uvs.push(source.uvs ? source.uvs[i * 2]! : 0, source.uvs ? source.uvs[i * 2 + 1]! : 0);
    }
    const idx = source.indices;
    if (idx) {
      for (let i = 0; i + 2 < idx.length; i += 3) {
        if (det < 0) this.indices.push(base + idx[i]!, base + idx[i + 2]!, base + idx[i + 1]!);
        else this.indices.push(base + idx[i]!, base + idx[i + 1]!, base + idx[i + 2]!);
      }
    } else {
      for (let i = 0; i + 2 < count; i += 3) this.indices.push(base + i, base + i + 1, base + i + 2);
    }
    return this;
  }

  get vertexCount(): number {
    return this.positions.length / 3;
  }

  get triangleCount(): number {
    return this.indices.length / 3;
  }

  /** The merged source, with tangents derived from the merged positions/UVs (normals are kept). */
  build(label: string): GeometrySource {
    const positions = Float32Array.from(this.positions);
    const normals = Float32Array.from(this.normals);
    const uvs = Float32Array.from(this.uvs);
    const indices = Uint32Array.from(this.indices);
    const { tangents } = computeNormalsAndTangents(positions, indices, uvs);
    return { positions, normals, uvs, tangents, indices, label };
  }
}

/** Tangents for a source that already has analytic normals and UVs (the normals are not replaced). */
export function withTangents(source: GeometrySource, label = source.label): GeometrySource {
  const indices = source.indices ? Uint32Array.from(source.indices) : undefined;
  if (!indices) throw new Error("withTangents: an indexed source is required");
  const uvs = source.uvs ?? new Float32Array((source.positions.length / 3) * 2);
  const { tangents } = computeNormalsAndTangents(source.positions, indices, uvs);
  return { ...source, uvs, tangents, indices, label };
}

// ------------------------------------------------------------------ rounded box

export interface RoundedBoxOptions {
  width: number;
  height: number;
  depth: number;
  /** Edge/corner radius (clamped to half the smallest side). */
  radius: number;
  /** Subdivisions across each rounded edge. Default 4. */
  segments?: number;
}

/**
 * A box with rounded edges and spherical corners: each face's grid is bunched into the rounding
 * zones and pushed onto `inner + normal · radius`, so the normals are exact and the corners are
 * watertight. Centred on the origin.
 */
export function roundedBoxSource(options: RoundedBoxOptions): GeometrySource {
  const hw = options.width / 2, hh = options.height / 2, hd = options.depth / 2;
  const r = Math.max(1e-4, Math.min(options.radius, hw, hh, hd));
  const seg = Math.max(1, Math.floor(options.segments ?? 4));
  const half = [hw, hh, hd] as const;
  // Lattice along an axis: bunched into [-half, -half + r] and [half - r, half] with the flat run
  // between them as a single span.
  const lattice = (h: number): number[] => {
    const out: number[] = [];
    for (let i = 0; i <= seg; i++) out.push(-h + (r * i) / seg);
    for (let i = 0; i <= seg; i++) out.push(h - r + (r * i) / seg);
    return out;
  };
  const lat = [lattice(hw), lattice(hh), lattice(hd)];
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  // Face definitions: [normal axis, sign, u axis, v axis] with u × v = the outward normal.
  const faces: Array<[number, number, number, number]> = [
    [2, 1, 0, 1], // +Z: x × y = +z
    [2, -1, 1, 0], // -Z: y × x = -z
    [0, 1, 1, 2], // +X: y × z = +x
    [0, -1, 2, 1], // -X: z × y = -x
    [1, 1, 2, 0], // +Y: z × x = +y
    [1, -1, 0, 2], // -Y: x × z = -y
  ];
  for (const [axis, sign, ua, va] of faces) {
    const us = lat[ua]!, vs = lat[va]!;
    const base = positions.length / 3;
    for (let j = 0; j < vs.length; j++) {
      for (let i = 0; i < us.length; i++) {
        const p = [0, 0, 0];
        p[axis] = sign * half[axis]!;
        p[ua] = us[i]!;
        p[va] = vs[j]!;
        const inner = [Math.max(-(hw - r), Math.min(hw - r, p[0]!)), Math.max(-(hh - r), Math.min(hh - r, p[1]!)), Math.max(-(hd - r), Math.min(hd - r, p[2]!))];
        let nx = p[0]! - inner[0]!, ny = p[1]! - inner[1]!, nz = p[2]! - inner[2]!;
        const l = Math.hypot(nx, ny, nz);
        if (l < 1e-9) { nx = 0; ny = 0; nz = 0; (axis === 0 ? (nx = sign) : axis === 1 ? (ny = sign) : (nz = sign)); } else { nx /= l; ny /= l; nz /= l; }
        positions.push(inner[0]! + nx * r, inner[1]! + ny * r, inner[2]! + nz * r);
        normals.push(nx, ny, nz);
        uvs.push(i / (us.length - 1), j / (vs.length - 1));
      }
    }
    const cols = us.length;
    for (let j = 0; j < vs.length - 1; j++) {
      for (let i = 0; i < cols - 1; i++) {
        const a = base + j * cols + i, b = a + 1, c = a + cols, d = c + 1;
        indices.push(a, b, c, b, d, c);
      }
    }
  }
  const src: GeometrySource = { positions: Float32Array.from(positions), normals: Float32Array.from(normals), uvs: Float32Array.from(uvs), indices: Uint32Array.from(indices), label: "rounded-box" };
  return orientOutward(withTangents(src));
}

/**
 * Flip any triangle whose winding disagrees with its vertex normals (a safety net for generators
 * whose axis conventions would otherwise leave a face culled). Cheap and idempotent.
 */
export function orientOutward(source: GeometrySource): GeometrySource {
  const idx = source.indices;
  const n = source.normals;
  if (!idx || !n) return source;
  const p = source.positions;
  const out = Uint32Array.from(idx);
  for (let t = 0; t + 2 < out.length; t += 3) {
    const a = out[t]!, b = out[t + 1]!, c = out[t + 2]!;
    const e1x = p[b * 3]! - p[a * 3]!, e1y = p[b * 3 + 1]! - p[a * 3 + 1]!, e1z = p[b * 3 + 2]! - p[a * 3 + 2]!;
    const e2x = p[c * 3]! - p[a * 3]!, e2y = p[c * 3 + 1]! - p[a * 3 + 1]!, e2z = p[c * 3 + 2]! - p[a * 3 + 2]!;
    const fx = e1y * e2z - e1z * e2y, fy = e1z * e2x - e1x * e2z, fz = e1x * e2y - e1y * e2x;
    const dot = fx * (n[a * 3]! + n[b * 3]! + n[c * 3]!) + fy * (n[a * 3 + 1]! + n[b * 3 + 1]! + n[c * 3 + 1]!) + fz * (n[a * 3 + 2]! + n[b * 3 + 2]! + n[c * 3 + 2]!);
    if (dot < 0) { out[t + 1] = c; out[t + 2] = b; }
  }
  return { ...source, indices: out };
}

// ------------------------------------------------------------------ loft

/** One cross-section of a {@link loftSource}: a rounded rectangle at depth `z`. */
export interface LoftStation {
  z: number;
  /** Half-width at this station. */
  halfWidth: number;
  yBottom: number;
  yTop: number;
  /** Corner radius (clamped to the section). Default 0.08. */
  radius?: number;
  /** Offset of the section's centre line (e.g. a sloped nose). Default 0. */
  xOffset?: number;
}

export interface LoftOptions {
  /** Points per rounded corner (≥ 1). Default 4. */
  cornerSegments?: number;
  /** Close the first / last station with a flat cap. Default true. */
  capStart?: boolean;
  capEnd?: boolean;
  /** UV metres per repeat along the loft; 0 uses a 0..1 span. Default 0. */
  uvMeters?: number;
  label?: string;
}

function sectionRing(s: LoftStation, cornerSegments: number): Array<[number, number, number, number]> {
  // Returns [x, y, nx, ny] going counter-clockwise (seen from +Z looking at -Z in a right-handed
  // frame): start at the middle of the right side, up around the top, down the left, along the bottom.
  const hw = Math.max(1e-4, s.halfWidth);
  const hh = Math.max(1e-4, (s.yTop - s.yBottom) / 2);
  const r = Math.max(1e-4, Math.min(s.radius ?? 0.08, hw, hh));
  const cy = (s.yTop + s.yBottom) / 2;
  const cx = s.xOffset ?? 0;
  const ring: Array<[number, number, number, number]> = [];
  const corners: Array<[number, number, number]> = [
    // centre x, centre y, start angle
    [hw - r, hh - r, 0], // top right
    [-(hw - r), hh - r, Math.PI / 2], // top left
    [-(hw - r), -(hh - r), Math.PI], // bottom left
    [hw - r, -(hh - r), (3 * Math.PI) / 2], // bottom right
  ];
  for (const [ox, oy, a0] of corners) {
    for (let i = 0; i <= cornerSegments; i++) {
      const a = a0 + ((Math.PI / 2) * i) / cornerSegments;
      const nx = Math.cos(a), ny = Math.sin(a);
      ring.push([cx + ox + nx * r, cy + oy + ny * r, nx, ny]);
    }
  }
  return ring;
}

/**
 * Loft a rounded-rectangle section along +Z through `stations` (sorted by z; stations sharing a z
 * make a hard crease). Smooth around each ring and between rings; flat caps optional. The workhorse
 * for hoods, cabins, sills and any extruded body that changes size along its length.
 */
export function loftSource(input: readonly LoftStation[], options: LoftOptions = {}): GeometrySource {
  if (input.length < 2) throw new Error("loftSource: at least two stations are required");
  // Ascending z (a stable sort, so stations sharing a z keep the order they were given in).
  const stations = [...input].sort((a, b) => a.z - b.z);
  const cs = Math.max(1, Math.floor(options.cornerSegments ?? 4));
  const rings = stations.map((s) => sectionRing(s, cs));
  const per = rings[0]!.length;
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const meters = options.uvMeters ?? 0;
  const z0 = stations[0]!.z;
  const zSpan = Math.max(1e-6, stations[stations.length - 1]!.z - z0);
  // Side surface: one extra vertex per ring closes the UV seam.
  for (let k = 0; k < stations.length; k++) {
    const s = stations[k]!;
    const ring = rings[k]!;
    // Longitudinal slope bends the normal toward the direction the surface leans.
    const prev = stations[Math.max(0, k - 1)]!;
    const next = stations[Math.min(stations.length - 1, k + 1)]!;
    const dz = Math.max(1e-6, next.z - prev.z);
    const v = meters > 0 ? (s.z - z0) / meters : (s.z - z0) / zSpan;
    for (let i = 0; i <= per; i++) {
      const [x, y, nx, ny] = ring[i % per]!;
      positions.push(x, y, s.z);
      // Slopes along z of the section's extents at this point of the ring.
      const dhw = (next.halfWidth - prev.halfWidth) / dz;
      const dyt = (next.yTop - prev.yTop) / dz;
      const dyb = (next.yBottom - prev.yBottom) / dz;
      const slopeX = nx * dhw;
      const slopeY = ny > 0 ? ny * dyt : ny * dyb;
      let fx = nx, fy = ny, fz = -(slopeX + slopeY);
      const l = Math.hypot(fx, fy, fz) || 1;
      fx /= l; fy /= l; fz /= l;
      normals.push(fx, fy, fz);
      uvs.push(i / per, v);
    }
  }
  const cols = per + 1;
  for (let k = 0; k < stations.length - 1; k++) {
    if (stations[k + 1]!.z - stations[k]!.z < 1e-9) continue; // duplicate z: a crease, no surface
    for (let i = 0; i < per; i++) {
      const a = k * cols + i, b = a + 1, c = a + cols, d = c + 1;
      // The ring runs counter-clockwise (+x toward +y), so (ring tangent) × (+z) points out.
      indices.push(a, b, c, b, d, c);
    }
  }
  const addCap = (k: number, facing: 1 | -1): void => {
    const s = stations[k]!;
    const ring = rings[k]!;
    const base = positions.length / 3;
    positions.push(s.xOffset ?? 0, (s.yTop + s.yBottom) / 2, s.z);
    normals.push(0, 0, facing);
    uvs.push(0.5, 0.5);
    for (let i = 0; i < per; i++) {
      const [x, y] = ring[i]!;
      positions.push(x, y, s.z);
      normals.push(0, 0, facing);
      uvs.push(0.5 + (x - (s.xOffset ?? 0)) / (2 * s.halfWidth), 0.5 + (y - (s.yTop + s.yBottom) / 2) / (s.yTop - s.yBottom));
    }
    for (let i = 0; i < per; i++) {
      const a = base + 1 + i, b = base + 1 + ((i + 1) % per);
      if (facing === 1) indices.push(base, a, b);
      else indices.push(base, b, a);
    }
  };
  if (options.capStart ?? true) addCap(0, -1);
  if (options.capEnd ?? true) addCap(stations.length - 1, 1);
  const src: GeometrySource = { positions: Float32Array.from(positions), normals: Float32Array.from(normals), uvs: Float32Array.from(uvs), indices: Uint32Array.from(indices), label: options.label ?? "loft" };
  return orientOutward(withTangents(src));
}

// ------------------------------------------------------------------ revolve

/** A profile point for {@link revolveSource}: distance from the axis and position along it. */
export interface RevolvePoint {
  radius: number;
  along: number;
}

export interface RevolveOptions {
  segments?: number;
  /** Texture repeats around the circumference. Default 1. */
  uRepeat?: number;
  /** Close the ends with flat discs at the first / last profile point. Default false. */
  capped?: boolean;
  label?: string;
}

/**
 * Lathe a profile around the **X axis** (`along` is x, `radius` is the distance from the axis):
 * tyres, hubs, drums. UV `u` runs around the axle, `v` follows the profile from 0 to 1 by arc length.
 */
export function revolveSource(profile: readonly RevolvePoint[], options: RevolveOptions = {}): GeometrySource {
  if (profile.length < 2) throw new Error("revolveSource: at least two profile points are required");
  const seg = Math.max(3, Math.floor(options.segments ?? 24));
  const uRep = options.uRepeat ?? 1;
  // Arc-length parameter for v.
  const arc: number[] = [0];
  for (let i = 1; i < profile.length; i++) arc.push(arc[i - 1]! + Math.hypot(profile[i]!.radius - profile[i - 1]!.radius, profile[i]!.along - profile[i - 1]!.along));
  const total = Math.max(1e-9, arc[arc.length - 1]!);
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  for (let k = 0; k < profile.length; k++) {
    const p = profile[k]!;
    const a = profile[Math.max(0, k - 1)]!, b = profile[Math.min(profile.length - 1, k + 1)]!;
    // Profile tangent (d radius, d along) → outward normal in the (radius, along) plane.
    const tr = b.radius - a.radius, ta = b.along - a.along;
    const tl = Math.hypot(tr, ta) || 1;
    // Rotating the tangent -90° in (along, radius) gives the outward normal for increasing `along`.
    const nr = ta / tl, na = -tr / tl;
    for (let i = 0; i <= seg; i++) {
      const ang = (i / seg) * Math.PI * 2;
      const cy = Math.cos(ang), sz = Math.sin(ang);
      positions.push(p.along, cy * p.radius, sz * p.radius);
      normals.push(na, cy * nr, sz * nr);
      uvs.push((i / seg) * uRep, arc[k]! / total);
    }
  }
  const cols = seg + 1;
  for (let k = 0; k < profile.length - 1; k++) {
    for (let i = 0; i < seg; i++) {
      const a = k * cols + i, b = a + 1, c = a + cols, d = c + 1;
      indices.push(a, b, c, b, d, c);
    }
  }
  if (options.capped) {
    for (const [k, facing] of [[0, -1], [profile.length - 1, 1]] as const) {
      const p = profile[k]!;
      const base = positions.length / 3;
      positions.push(p.along, 0, 0);
      normals.push(facing, 0, 0);
      uvs.push(0.5, 0.5);
      for (let i = 0; i <= seg; i++) {
        const ang = (i / seg) * Math.PI * 2;
        positions.push(p.along, Math.cos(ang) * p.radius, Math.sin(ang) * p.radius);
        normals.push(facing, 0, 0);
        uvs.push(0.5 + Math.cos(ang) * 0.5, 0.5 + Math.sin(ang) * 0.5);
      }
      for (let i = 0; i < seg; i++) {
        if (facing === 1) indices.push(base, base + 1 + i, base + 2 + i);
        else indices.push(base, base + 2 + i, base + 1 + i);
      }
    }
  }
  const src: GeometrySource = { positions: Float32Array.from(positions), normals: Float32Array.from(normals), uvs: Float32Array.from(uvs), indices: Uint32Array.from(indices), label: options.label ?? "revolve" };
  return orientOutward(withTangents(src));
}

// ------------------------------------------------------------------ arc strip

export interface ArcStripOptions {
  /** Inner radius of the strip (the arch opening). */
  radius: number;
  /** Radial thickness. */
  thickness: number;
  /** Extent along the arc's axis (x). */
  width: number;
  /** Start / end angle (radians) measured from +Z toward +Y in the YZ plane about the origin. */
  start: number;
  end: number;
  segments?: number;
  label?: string;
}

/**
 * A rectangular profile swept along an arc in the YZ plane about the X axis — wheel-arch flares and
 * mudguards. The profile spans `[0, width]` along +X and `[radius, radius + thickness]` radially;
 * the end faces are capped so it is a closed solid.
 */
export function arcStripSource(options: ArcStripOptions): GeometrySource {
  const seg = Math.max(1, Math.floor(options.segments ?? 12));
  const { radius: r0, thickness, width, start, end } = options;
  const r1 = r0 + thickness;
  // Profile corners in (x, radial): bottom-inner, top-inner... walk the rectangle.
  const corners: Array<[number, number, number, number]> = [
    // x, radial, normal x, normal radial
    [0, r1, 0, 1], [width, r1, 0, 1], // outer face
    [width, r1, 1, 0], [width, r0, 1, 0], // +x side
    [width, r0, 0, -1], [0, r0, 0, -1], // inner face
    [0, r0, -1, 0], [0, r1, -1, 0], // -x side
  ];
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  for (let k = 0; k <= seg; k++) {
    const a = start + ((end - start) * k) / seg;
    const sy = Math.sin(a), cz = Math.cos(a);
    for (const [x, rad, nx, nr] of corners) {
      positions.push(x, rad * sy, rad * cz);
      normals.push(nx, nr * sy, nr * cz);
      uvs.push(x / width, k / seg);
    }
  }
  const per = corners.length;
  for (let k = 0; k < seg; k++) {
    for (let f = 0; f < per; f += 2) {
      const a = k * per + f, b = a + 1, c = a + per, d = c + 1;
      indices.push(a, c, b, b, c, d);
    }
  }
  for (const [k, facing] of [[0, -1], [seg, 1]] as const) {
    const a = start + ((end - start) * k) / seg;
    const sy = Math.sin(a), cz = Math.cos(a);
    // Tangent direction of travel at this end, used as the cap normal.
    const tx = 0, ty = cz * facing * Math.sign(end - start), tz = -sy * facing * Math.sign(end - start);
    const base = positions.length / 3;
    for (const [x, rad] of [[0, r0], [width, r0], [width, r1], [0, r1]] as const) {
      positions.push(x, rad * sy, rad * cz);
      normals.push(tx, ty, tz);
      uvs.push(x / width, (rad - r0) / thickness);
    }
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  const src: GeometrySource = { positions: Float32Array.from(positions), normals: Float32Array.from(normals), uvs: Float32Array.from(uvs), indices: Uint32Array.from(indices), label: options.label ?? "arc-strip" };
  return orientOutward(withTangents(src));
}

// ------------------------------------------------------------------ prism

/**
 * A triangular prism: a triangle `width` wide and `height` tall in the XY plane (base at y = 0,
 * apex at x = 0), extruded `depth` along Z. Flat-shaded; gable ends and roof wedges.
 */
export function prismSource(width: number, height: number, depth: number): GeometrySource {
  const hw = width / 2, hd = depth / 2;
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  const face = (verts: ReadonlyArray<readonly [number, number, number]>): void => {
    // Vertices are given counter-clockwise seen from outside; the normal is their cross product.
    const a = verts[0]!, b = verts[1]!, c = verts[2]!;
    const e1 = [b[0]! - a[0]!, b[1]! - a[1]!, b[2]! - a[2]!], e2 = [c[0]! - a[0]!, c[1]! - a[1]!, c[2]! - a[2]!];
    let nx = e1[1]! * e2[2]! - e1[2]! * e2[1]!, ny = e1[2]! * e2[0]! - e1[0]! * e2[2]!, nz = e1[0]! * e2[1]! - e1[1]! * e2[0]!;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l; ny /= l; nz /= l;
    const base = positions.length / 3;
    for (const v of verts) { positions.push(v[0], v[1], v[2]); normals.push(nx, ny, nz); }
    for (let i = 1; i + 1 < verts.length; i++) indices.push(base, base + i, base + i + 1);
  };
  face([[-hw, 0, hd], [hw, 0, hd], [0, height, hd]]); // +Z gable
  face([[-hw, 0, -hd], [0, height, -hd], [hw, 0, -hd]]); // -Z gable
  face([[-hw, 0, hd], [0, height, hd], [0, height, -hd], [-hw, 0, -hd]]); // left slope
  face([[hw, 0, hd], [hw, 0, -hd], [0, height, -hd], [0, height, hd]]); // right slope
  face([[-hw, 0, hd], [-hw, 0, -hd], [hw, 0, -hd], [hw, 0, hd]]); // underside
  const src: GeometrySource = { positions: Float32Array.from(positions), normals: Float32Array.from(normals), uvs: new Float32Array((positions.length / 3) * 2), indices: Uint32Array.from(indices), label: "prism" };
  return withTangents(src);
}

// ------------------------------------------------------------------ convenience

/** A cylinder along the segment `a → b` (radius `r`, flat caps) — rails, struts, pipes. */
export function tubeBetween(a: readonly [number, number, number], b: readonly [number, number, number], radius: number, radialSegments = 8): { source: GeometrySource; transform: Affine } {
  const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
  const length = Math.hypot(dx, dy, dz);
  const source = cylinderGeometrySource({ radiusTop: radius, radiusBottom: radius, height: length, radialSegments, capped: true });
  const mid: [number, number, number] = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
  return { source, transform: compose(alignYTo(dx, dy, dz), translate(mid[0], mid[1], mid[2])) };
}

/** Box centred at `(x, y, z)` — the common case of `add(boxGeometrySource(...), translate(...))`. */
export function boxAt(builder: MeshBuilder, width: number, height: number, depth: number, x: number, y: number, z: number, extra: Affine = IDENTITY): void {
  builder.add(boxGeometrySource({ width, height, depth }), compose(extra, translate(x, y, z)));
}

/** Signed volume of a closed, outward-wound mesh (positive when faces point out). Test/diagnostic helper. */
export function signedVolume(source: GeometrySource): number {
  const p = source.positions;
  const idx = source.indices;
  if (!idx) return 0;
  let v = 0;
  for (let t = 0; t + 2 < idx.length; t += 3) {
    const a = idx[t]! * 3, b = idx[t + 1]! * 3, c = idx[t + 2]! * 3;
    v += (p[a]! * (p[b + 1]! * p[c + 2]! - p[b + 2]! * p[c + 1]!) - p[a + 1]! * (p[b]! * p[c + 2]! - p[b + 2]! * p[c]!) + p[a + 2]! * (p[b]! * p[c + 1]! - p[b + 1]! * p[c]!)) / 6;
  }
  return v;
}
