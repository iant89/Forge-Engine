/**
 * Procedural primitive geometry.
 *
 * These exist so that examples, tests, the editor's gizmos and debug drawing never depend on an
 * asset loader — and so a demo can be validated with *known* vertex counts (the "spinning cube must
 * issue exactly 1 draw of 12 triangles" style assertions in tests/ are only possible because the
 * primitive generator is deterministic).
 *
 * Convention: +Y up, CCW front faces when viewed from outside, UVs in [0,1] per face, normals
 * smooth for spheres/cylinders and flat for boxes.
 */

import { Geometry, VERTEX_STRIDE, computeNormalsAndTangents, type GeometrySource } from "./geometry.js";
import type { GraphicsDevice } from "../gpu/device.js";

export interface BoxOptions {
  width?: number;
  height?: number;
  depth?: number;
  /** Segments per axis (1 = flat faces). */
  segmentsX?: number;
  segmentsY?: number;
  segmentsZ?: number;
}

export function boxGeometrySource(options: BoxOptions = {}): GeometrySource {
  const w = options.width ?? 1;
  const h = options.height ?? 1;
  const d = options.depth ?? 1;
  const sx = Math.max(1, Math.floor(options.segmentsX ?? 1));
  const sy = Math.max(1, Math.floor(options.segmentsY ?? 1));
  const sz = Math.max(1, Math.floor(options.segmentsZ ?? 1));
  // Each face: outward normal, its two in-plane axes (u × v == n, so CCW seen from outside), and the
  // extents along them. Segment counts follow the world axis each in-plane direction lies on.
  const faces: { n: Vec; u: Vec; v: Vec; extentU: number; extentV: number; segU: number; segV: number }[] = [
    { n: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0], extentU: w, extentV: h, segU: sx, segV: sy },
    { n: [0, 0, -1], u: [-1, 0, 0], v: [0, 1, 0], extentU: w, extentV: h, segU: sx, segV: sy },
    { n: [1, 0, 0], u: [0, 0, -1], v: [0, 1, 0], extentU: d, extentV: h, segU: sz, segV: sy },
    { n: [-1, 0, 0], u: [0, 0, 1], v: [0, 1, 0], extentU: d, extentV: h, segU: sz, segV: sy },
    { n: [0, 1, 0], u: [1, 0, 0], v: [0, 0, -1], extentU: w, extentV: d, segU: sx, segV: sz },
    { n: [0, -1, 0], u: [1, 0, 0], v: [0, 0, 1], extentU: w, extentV: d, segU: sx, segV: sz },
  ];
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  let vertex = 0;
  for (const f of faces) {
    const half = (f.n[0] !== 0 ? w : f.n[1] !== 0 ? h : d) / 2;
    for (let j = 0; j <= f.segV; j++) {
      const b = (j / f.segV) * 2 - 1;
      for (let i = 0; i <= f.segU; i++) {
        const a = (i / f.segU) * 2 - 1;
        const p = [0, 0, 0];
        for (let k = 0; k < 3; k++) p[k] = f.n[k]! * half + f.u[k]! * a * (f.extentU / 2) + f.v[k]! * b * (f.extentV / 2);
        positions.push(p[0]!, p[1]!, p[2]!);
        normals.push(f.n[0], f.n[1], f.n[2]);
        uvs.push(i / f.segU, 1 - j / f.segV);
      }
    }
    const cols = f.segU + 1;
    for (let j = 0; j < f.segV; j++) {
      for (let i = 0; i < f.segU; i++) {
        const p00 = vertex + j * cols + i;
        const p10 = p00 + 1;
        const p01 = p00 + cols;
        const p11 = p01 + 1;
        indices.push(p00, p10, p01, p10, p11, p01);
      }
    }
    vertex += (f.segU + 1) * (f.segV + 1);
  }
  const pos = new Float32Array(positions);
  const nrm = new Float32Array(normals);
  const uv = new Float32Array(uvs);
  const idx = new Uint32Array(indices);
  const tangents = computeNormalsAndTangents(pos, idx, uv).tangents;
  return { positions: pos, normals: nrm, uvs: uv, tangents, indices: idx, label: "box" };
}

type Vec = [number, number, number];

export interface PlaneOptions {
  width?: number;
  depth?: number;
  segmentsX?: number;
  segmentsZ?: number;
  /** Rotate into the XZ plane (default) or keep it in XY (billboard-style). */
  horizontal?: boolean;
}

export function planeGeometrySource(options: PlaneOptions = {}): GeometrySource {
  const w = options.width ?? 1;
  const d = options.depth ?? w;
  const nx = Math.max(1, Math.floor(options.segmentsX ?? 1));
  const nz = Math.max(1, Math.floor(options.segmentsZ ?? 1));
  const horizontal = options.horizontal ?? true;
  const positions = new Float32Array((nx + 1) * (nz + 1) * 3);
  const normals = new Float32Array((nx + 1) * (nz + 1) * 3);
  const uvs = new Float32Array((nx + 1) * (nz + 1) * 2);
  const indices = new Uint32Array(nx * nz * 6);
  let v = 0;
  for (let j = 0; j <= nz; j++) {
    for (let i = 0; i <= nx; i++) {
      const x = ((i / nx) * 2 - 1) * (w / 2);
      const z = ((j / nz) * 2 - 1) * (d / 2);
      positions[v * 3] = x;
      positions[v * 3 + 1] = horizontal ? 0 : z;
      positions[v * 3 + 2] = horizontal ? z : 0;
      normals[v * 3 + 1] = horizontal ? 1 : 0;
      normals[v * 3 + 2] = horizontal ? 0 : 1;
      uvs[v * 2] = i / nx;
      uvs[v * 2 + 1] = 1 - j / nz;
      v++;
    }
  }
  let k = 0;
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const a = j * (nx + 1) + i;
      const b = a + 1;
      const c = a + nx + 1;
      const dd = c + 1;
      indices[k++] = a;
      indices[k++] = c;
      indices[k++] = b;
      indices[k++] = b;
      indices[k++] = c;
      indices[k++] = dd;
    }
  }
  const tangents = computeNormalsAndTangents(positions, indices, uvs).tangents;
  return { positions, normals, uvs, tangents, indices, label: horizontal ? "plane" : "quad" };
}

export interface SphereOptions {
  radius?: number;
  widthSegments?: number;
  heightSegments?: number;
  /** Partial spheres for hemispheres / dome skies. */
  phiStart?: number;
  phiLength?: number;
  thetaStart?: number;
  thetaLength?: number;
}

export function sphereGeometrySource(options: SphereOptions = {}): GeometrySource {
  const r = options.radius ?? 0.5;
  const ws = Math.max(3, Math.floor(options.widthSegments ?? 24));
  const hs = Math.max(2, Math.floor(options.heightSegments ?? 16));
  const phiStart = options.phiStart ?? 0;
  const phiLength = options.phiLength ?? Math.PI * 2;
  const thetaStart = options.thetaStart ?? 0;
  const thetaLength = options.thetaLength ?? Math.PI;
  const vertCount = (ws + 1) * (hs + 1);
  const positions = new Float32Array(vertCount * 3);
  const normals = new Float32Array(vertCount * 3);
  const uvs = new Float32Array(vertCount * 2);
  const indices = new Uint32Array(ws * hs * 6);
  let vi = 0;
  for (let j = 0; j <= hs; j++) {
    const theta = thetaStart + (j / hs) * thetaLength;
    const sinT = Math.sin(theta);
    const cosT = Math.cos(theta);
    for (let i = 0; i <= ws; i++) {
      const phi = phiStart + (i / ws) * phiLength;
      const x = sinT * Math.cos(phi);
      const y = cosT;
      const z = sinT * Math.sin(phi);
      positions[vi * 3] = x * r;
      positions[vi * 3 + 1] = y * r;
      positions[vi * 3 + 2] = z * r;
      normals[vi * 3] = x;
      normals[vi * 3 + 1] = y;
      normals[vi * 3 + 2] = z;
      uvs[vi * 2] = i / ws;
      uvs[vi * 2 + 1] = j / hs;
      vi++;
    }
  }
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
  const tangents = computeNormalsAndTangents(positions, indices, uvs).tangents;
  return { positions, normals, uvs, tangents, indices, label: "sphere" };
}

export interface RockOptions {
  /** Mean radius before displacement. Default 0.5. */
  radius?: number;
  /** Lat-long subdivisions per side; the vertex count is `(segments+1)²`. Default 10. */
  segments?: number;
  /** Displacement amplitude as a fraction of `radius` (0 = sphere). Default 0.28. */
  roughness?: number;
  /** Vertical squash after displacement, 0..1 (0.35 ≈ a settled boulder). Default 0. */
  flatten?: number;
  /** Seed of the deterministic displacement field; same seed → same rock, byte for byte. */
  seed?: number;
}

/**
 * A displaced, optionally squashed sphere — the engine's rock/boulder primitive (Phase 14's first
 * population types). The displacement is a seeded sum of sine lobes over the sphere direction
 * (`1 + roughness · Σ aᵏ·sin(dot(dir, kᵏ)·fᵏ + φᵏ)` with geometrically falling amplitudes), which
 * is smooth, deterministic and needs no noise library; normals come from the shared face-averaging
 * pass so the craggy silhouette shades correctly. UVs are the sphere's (a rock texture can wrap
 * them; the flat-colour demo does not).
 */
export function rockGeometrySource(options: RockOptions = {}): GeometrySource {
  const radius = options.radius ?? 0.5;
  const seg = Math.max(4, Math.floor(options.segments ?? 10));
  const roughness = options.roughness ?? 0.28;
  const flatten = options.flatten ?? 0;
  const seed = options.seed ?? 0;

  // Seeded displacement field: three random unit directions with rising frequency and falling
  // amplitude each (nine lobes total) — enough facets to read as rock at scatter scales.
  const lobes: { x: number; y: number; z: number; f: number; p: number; a: number }[] = [];
  let state = (seed | 0) || 1;
  const nextRandom = () => {
    // xorshift32 — local to this generator so it never couples to math/rng's stream contract.
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state |= 0;
    return ((state >>> 0) / 4294967296) as number;
  };
  for (let l = 0; l < 3; l++) {
    const theta = nextRandom() * Math.PI * 2;
    const y = nextRandom() * 2 - 1;
    const ring = Math.sqrt(Math.max(0, 1 - y * y));
    lobes.push({
      x: ring * Math.cos(theta),
      y,
      z: ring * Math.sin(theta),
      f: 1.7 + l * 1.9 + nextRandom(),
      p: nextRandom() * Math.PI * 2,
      a: Math.pow(0.45, l),
    });
  }

  const vertCount = (seg + 1) * (seg + 1);
  const positions = new Float32Array(vertCount * 3);
  const uvs = new Float32Array(vertCount * 2);
  const indices = new Uint32Array(seg * seg * 6);
  let vi = 0;
  for (let j = 0; j <= seg; j++) {
    const theta = (j / seg) * Math.PI;
    const sinT = Math.sin(theta);
    const cosT = Math.cos(theta);
    for (let i = 0; i <= seg; i++) {
      const phi = (i / seg) * Math.PI * 2;
      const dx = sinT * Math.cos(phi);
      const dy = cosT;
      const dz = sinT * Math.sin(phi);
      let r = 1;
      if (roughness > 0) {
        for (const lobe of lobes) {
          r += roughness * lobe.a * Math.sin((dx * lobe.x + dy * lobe.y + dz * lobe.z) * lobe.f * Math.PI + lobe.p);
        }
        r = Math.max(0.55, r);
      }
      positions[vi * 3] = dx * r * radius;
      positions[vi * 3 + 1] = dy * r * radius * (1 - flatten);
      positions[vi * 3 + 2] = dz * r * radius;
      uvs[vi * 2] = i / seg;
      uvs[vi * 2 + 1] = j / seg;
      vi++;
    }
  }
  let k = 0;
  for (let j = 0; j < seg; j++) {
    for (let i = 0; i < seg; i++) {
      const a = j * (seg + 1) + i;
      const b = a + 1;
      const c = a + seg + 1;
      const d = c + 1;
      indices[k++] = a;
      indices[k++] = b;
      indices[k++] = c;
      indices[k++] = b;
      indices[k++] = d;
      indices[k++] = c;
    }
  }
  const { normals, tangents } = computeNormalsAndTangents(positions, indices, uvs);
  // The lat-long top pole leaves vertex 0 in degenerate triangles only — its whole first strip
  // collapses onto the pole point, so no face contributes a normal. Vertex 1 sits at the same
  // position, and its normal is therefore the correct one; borrow it. (The sphere primitive writes
  // analytic normals instead and never hits this; the rock displaces, so it must recompute.)
  if (Math.hypot(normals[0]!, normals[1]!, normals[2]!) < 1e-6) {
    normals[0] = normals[3]!;
    normals[1] = normals[4]!;
    normals[2] = normals[5]!;
  }
  return { positions, normals, uvs, tangents, indices, label: "rock" };
}

export interface CylinderOptions {
  radiusTop?: number;
  radiusBottom?: number;
  height?: number;
  radialSegments?: number;
  heightSegments?: number;
  capped?: boolean;
}

export function cylinderGeometrySource(options: CylinderOptions = {}): GeometrySource {
  const rt = options.radiusTop ?? 0.5;
  const rb = options.radiusBottom ?? 0.5;
  const height = options.height ?? 1;
  const rs = Math.max(3, Math.floor(options.radialSegments ?? 24));
  const hs = Math.max(1, Math.floor(options.heightSegments ?? 1));
  const capped = options.capped ?? true;
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const slope = Math.atan2(rb - rt, height);
  const ny = Math.sin(slope);
  let vertex = 0;
  for (let j = 0; j <= hs; j++) {
    const t = j / hs;
    const y = (t - 0.5) * height;
    const radius = rb + (rt - rb) * t;
    for (let i = 0; i <= rs; i++) {
      const a = (i / rs) * Math.PI * 2;
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      positions.push(ca * radius, y, sa * radius);
      normals.push(ca * Math.cos(slope), ny, sa * Math.cos(slope));
      uvs.push(i / rs, t);
    }
  }
  for (let j = 0; j < hs; j++) {
    for (let i = 0; i < rs; i++) {
      const a = j * (rs + 1) + i;
      const b = a + 1;
      const c = a + rs + 1;
      const d = c + 1;
      indices.push(a, c, b, b, c, d);
    }
  }
  vertex = (hs + 1) * (rs + 1);
  if (capped) {
    for (const cap of [0, 1]) {
      const radius = cap === 0 ? rt : rb;
      const y = cap === 0 ? height / 2 : -height / 2;
      const n = cap === 0 ? 1 : -1;
      positions.push(0, y, 0);
      normals.push(0, n, 0);
      uvs.push(0.5, 0.5);
      const center = vertex++;
      for (let i = 0; i <= rs; i++) {
        const a = (i / rs) * Math.PI * 2;
        positions.push(Math.cos(a) * radius, y, Math.sin(a) * radius);
        normals.push(0, n, 0);
        uvs.push(0.5 + Math.cos(a) * 0.5, 0.5 + Math.sin(a) * 0.5);
        vertex++;
      }
      for (let i = 0; i < rs; i++) {
        const ring = center + 1 + i;
        if (cap === 0) indices.push(center, ring + 1, ring);
        else indices.push(center, ring, ring + 1);
      }
    }
  }
  const pos = new Float32Array(positions);
  const nrm = new Float32Array(normals);
  const uv = new Float32Array(uvs);
  const idx = new Uint32Array(indices);
  return { positions: pos, normals: nrm, uvs: uv, tangents: computeNormalsAndTangents(pos, idx, uv).tangents, indices: idx, label: "cylinder" };
}

export function coneGeometrySource(options: { radius?: number; height?: number; radialSegments?: number } = {}): GeometrySource {
  return cylinderGeometrySource({
    radiusTop: 0,
    radiusBottom: options.radius ?? 0.5,
    height: options.height ?? 1,
    radialSegments: options.radialSegments ?? 24,
    capped: true,
  });
}

export function torusGeometrySource(options: { radius?: number; tube?: number; radialSegments?: number; tubularSegments?: number } = {}): GeometrySource {
  const R = options.radius ?? 0.6;
  const tube = options.tube ?? 0.2;
  const rs = Math.max(3, Math.floor(options.radialSegments ?? 24));
  const ts = Math.max(3, Math.floor(options.tubularSegments ?? 12));
  const positions = new Float32Array((rs + 1) * (ts + 1) * 3);
  const normals = new Float32Array((rs + 1) * (ts + 1) * 3);
  const uvs = new Float32Array((rs + 1) * (ts + 1) * 2);
  const indices = new Uint32Array(rs * ts * 6);
  let v = 0;
  for (let j = 0; j <= rs; j++) {
    const u = (j / rs) * Math.PI * 2;
    for (let i = 0; i <= ts; i++) {
      const w = (i / ts) * Math.PI * 2;
      const cx = Math.cos(u) * R;
      const cz = Math.sin(u) * R;
      const nx = Math.cos(u) * Math.cos(w);
      const ny = Math.sin(w);
      const nz = Math.sin(u) * Math.cos(w);
      positions[v * 3] = cx + nx * tube;
      positions[v * 3 + 1] = ny * tube;
      positions[v * 3 + 2] = cz + nz * tube;
      normals[v * 3] = nx;
      normals[v * 3 + 1] = ny;
      normals[v * 3 + 2] = nz;
      uvs[v * 2] = j / rs;
      uvs[v * 2 + 1] = i / ts;
      v++;
    }
  }
  let k = 0;
  for (let j = 0; j < rs; j++) {
    for (let i = 0; i < ts; i++) {
      const a = j * (ts + 1) + i;
      const b = a + 1;
      const c = a + ts + 1;
      const d = c + 1;
      indices[k++] = a;
      indices[k++] = b;
      indices[k++] = c;
      indices[k++] = b;
      indices[k++] = d;
      indices[k++] = c;
    }
  }
  const tangents = computeNormalsAndTangents(positions, indices, uvs).tangents;
  return { positions, normals, uvs, tangents, indices, label: "torus" };
}

// ------------------------------------------------------------------ Phase 14.2 population types

/**
 * A deterministic local random stream (xorshift32).
 *
 * The population primitives each need a handful of jitter values, and they must not couple to
 * `math/rng`'s stream contract (which the scatter's determinism is pinned against): a primitive's
 * output is a pure function of its own options, so its stream is private and its seed is its own.
 */
function primitiveRandom(seed: number): () => number {
  let state = (seed | 0) || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state |= 0;
    return (state >>> 0) / 4294967296;
  };
}

export interface DebrisOptions {
  /** Fragments in one instance — a chip pile reads as debris where one chip reads as a pebble. Default 3. */
  fragments?: number;
  /** Radius of the pile the fragments are scattered inside. Default 0.5. */
  radius?: number;
  /** Sides of each fragment's prism (3 = a shard, 5 = a chunk). Default 4. */
  sides?: number;
  /** Fragment height as a fraction of `radius`. Default 0.55. */
  height?: number;
  /** Seed of the deterministic jitter; same seed → same pile, byte for byte. */
  seed?: number;
}

/**
 * Broken fragments — the engine's debris primitive (Phase 14.2).
 *
 * Each fragment is a tapered prism: a jittered base polygon at y = 0 and an apex above it, so the
 * silhouette is a wedge rather than a scaled rock. A few of them per instance, each with its own
 * yaw, tilt and scale, is what makes a debris field read as *broken* — one convex blob per instance
 * reads as gravel no matter how it is displaced. There is no bottom face: the base sits at y = 0 and
 * the scatter embeds it.
 */
export function debrisGeometrySource(options: DebrisOptions = {}): GeometrySource {
  const fragments = Math.max(1, Math.floor(options.fragments ?? 3));
  const sides = Math.max(3, Math.floor(options.sides ?? 4));
  const radius = options.radius ?? 0.5;
  const height = (options.height ?? 0.55) * radius;
  const random = primitiveRandom(options.seed ?? 0);

  const vertCount = fragments * (sides + 1);
  const positions = new Float32Array(vertCount * 3);
  const uvs = new Float32Array(vertCount * 2);
  const indices = new Uint32Array(fragments * sides * 3);
  let vi = 0;
  let ii = 0;
  for (let f = 0; f < fragments; f++) {
    // The pile: fragments within `radius` of the instance origin, none exactly on top of another
    // (the angle steps around the pile, so they spread instead of clumping).
    const angle = (f / fragments) * Math.PI * 2 + random() * 0.9;
    const distance = radius * (0.15 + 0.75 * random());
    const cx = Math.cos(angle) * distance;
    const cz = Math.sin(angle) * distance;
    const yaw = random() * Math.PI * 2;
    const tilt = (random() - 0.5) * 0.5;
    const scale = radius * (0.35 + 0.5 * random());
    const apexHeight = height * (0.7 + 0.9 * random());
    const base = vi;
    for (let k = 0; k < sides; k++) {
      const a = yaw + (k / sides) * Math.PI * 2;
      const r = scale * (0.7 + 0.5 * random());
      positions[vi * 3] = cx + Math.cos(a) * r;
      // The tilt leans the whole base polygon, so a fragment can look knocked over rather than planted.
      positions[vi * 3 + 1] = Math.sin(a) * r * tilt;
      positions[vi * 3 + 2] = cz + Math.sin(a) * r;
      uvs[vi * 2] = k / sides;
      uvs[vi * 2 + 1] = 0;
      vi++;
    }
    positions[vi * 3] = cx + scale * 0.15 * (random() - 0.5);
    positions[vi * 3 + 1] = apexHeight;
    positions[vi * 3 + 2] = cz + scale * 0.15 * (random() - 0.5);
    uvs[vi * 2] = 0.5;
    uvs[vi * 2 + 1] = 1;
    vi++;
    for (let k = 0; k < sides; k++) {
      // Outward winding (`frontFace: "cw"`, as every primitive here): the face normal of
      // (base k, apex, base k+1) points away from the fragment's axis and slightly up, so back-face
      // culling keeps the walls a camera can see and drops the far side of the shard.
      indices[ii++] = base + k;
      indices[ii++] = base + sides;
      indices[ii++] = base + ((k + 1) % sides);
    }
  }
  const { normals, tangents } = computeNormalsAndTangents(positions, indices, uvs);
  return { positions, normals, uvs, tangents, indices, label: "debris" };
}

export interface VegetationOptions {
  /** Blades in one tuft. Default 9. */
  blades?: number;
  /** Tuft height. Default 1. */
  height?: number;
  /** Radius of the base the blades spring from. Default 0.3. */
  radius?: number;
  /** Segments per blade (a blade bends, so it needs more than one). Default 3. */
  segments?: number;
  /** Blade width at the base, as a fraction of `height`. Default 0.09. */
  width?: number;
  /** Outward bend at the tip, as a fraction of `height` (0 = upright, 1 = a full arch). Default 0.45. */
  droop?: number;
  /** Seed of the deterministic jitter. */
  seed?: number;
}

/**
 * A tuft of blades — the engine's vegetation primitive (Phase 14.2).
 *
 * Each blade is a tapered, bent ribbon of `segments` quads rising from a point on the tuft's base
 * disc: two vertices per ring, offset along the blade's own horizontal perpendicular, so the ribbon
 * is a *plane* the whole way up. That is what makes a double-sided material the right answer (and a
 * shadow map the wrong one: the silhouette of a blade ribbon is a solid sliver, not a plant). UVs run
 * across the blade (u) and along it (v), so an alpha-cutout leaf texture maps blade by blade.
 *
 * There is no trunk and no canopy: at population scatter scales a shrub reads as a tuft, and a
 * canopy needs a branching structure this primitive deliberately does not grow.
 */
export function vegetationGeometrySource(options: VegetationOptions = {}): GeometrySource {
  const blades = Math.max(1, Math.floor(options.blades ?? 9));
  const segments = Math.max(1, Math.floor(options.segments ?? 3));
  const height = options.height ?? 1;
  const radius = options.radius ?? 0.3;
  const width = (options.width ?? 0.09) * height;
  const droop = Math.max(0, options.droop ?? 0.45);
  const random = primitiveRandom(options.seed ?? 0);

  const rings = segments + 1;
  const vertCount = blades * rings * 2;
  const positions = new Float32Array(vertCount * 3);
  const uvs = new Float32Array(vertCount * 2);
  const indices = new Uint32Array(blades * segments * 6);
  let vi = 0;
  let ii = 0;
  for (let b = 0; b < blades; b++) {
    // Blades step around the disc rather than landing anywhere: a tuft reads as a tuft when its
    // blades radiate, and a pure random scatter leaves gaps and overlaps.
    const yaw = (b / blades) * Math.PI * 2 + (random() - 0.5) * 0.7;
    const base = vi;
    const baseRadius = radius * (0.2 + 0.8 * random());
    const bx = Math.cos(yaw) * baseRadius;
    const bz = Math.sin(yaw) * baseRadius;
    const outwardX = Math.cos(yaw);
    const outwardZ = Math.sin(yaw);
    const bladeHeight = height * (0.7 + 0.5 * random());
    const bladeDroop = droop * (0.6 + 0.7 * random());
    const twist = (random() - 0.5) * 0.6;
    for (let ring = 0; ring < rings; ring++) {
      const t = ring / segments;
      // The centre line: up, minus a little for the arch, and outward by the droop's own square so
      // the tip hangs past the base instead of leaning in a straight line.
      const cx = bx + outwardX * bladeDroop * bladeHeight * t * t;
      const cz = bz + outwardZ * bladeDroop * bladeHeight * t * t;
      const cy = bladeHeight * t * (1 - 0.3 * bladeDroop * t);
      // The ribbon's perpendicular, rotated a little per blade so neighbouring blades are not parallel.
      const perpX = -Math.sin(yaw + twist * t);
      const perpZ = Math.cos(yaw + twist * t);
      const halfWidth = (width * (1 - 0.85 * t)) / 2;
      positions[vi * 3] = cx + perpX * halfWidth;
      positions[vi * 3 + 1] = cy;
      positions[vi * 3 + 2] = cz + perpZ * halfWidth;
      uvs[vi * 2] = 0;
      uvs[vi * 2 + 1] = t;
      vi++;
      positions[vi * 3] = cx - perpX * halfWidth;
      positions[vi * 3 + 1] = cy;
      positions[vi * 3 + 2] = cz - perpZ * halfWidth;
      uvs[vi * 2] = 1;
      uvs[vi * 2 + 1] = t;
      vi++;
    }
    for (let ring = 0; ring < segments; ring++) {
      const a = base + ring * 2;
      indices[ii++] = a;
      indices[ii++] = a + 1;
      indices[ii++] = a + 2;
      indices[ii++] = a + 1;
      indices[ii++] = a + 3;
      indices[ii++] = a + 2;
    }
  }
  const { normals, tangents } = computeNormalsAndTangents(positions, indices, uvs);
  return { positions, normals, uvs, tangents, indices, label: "vegetation" };
}

export interface PropOptions {
  /** Post radius at the base. Default 0.18. */
  radius?: number;
  /** Post height. Default 1.6. */
  height?: number;
  /** Sides of the shaft (6 reads as a driven stake, 4 as a timber post). Default 6. */
  sides?: number;
  /** Fraction of the height the chamfered cap takes. Default 0.14. */
  bevel?: number;
  /** Per-vertex irregularity as a fraction of `radius` (a machined post is 0). Default 0.06. */
  roughness?: number;
  /** Seed of the deterministic jitter. */
  seed?: number;
}

/**
 * A beveled post — the engine's environmental-prop primitive (Phase 14.2).
 *
 * Three stacked rings plus a pyramidal cap: the shaft tapers slightly, the shoulder steps in, and the
 * cap closes it, so the silhouette reads as *made* rather than grown — which is the whole job of a
 * prop. There is no bottom face (the scatter embeds the base) and no separate material slot for the
 * cap: a prop is one draw, one material, one instance.
 */
export function propGeometrySource(options: PropOptions = {}): GeometrySource {
  const sides = Math.max(3, Math.floor(options.sides ?? 6));
  const radius = options.radius ?? 0.18;
  const height = options.height ?? 1.6;
  const bevel = Math.min(0.5, Math.max(0, options.bevel ?? 0.14));
  const roughness = options.roughness ?? 0.06;
  const random = primitiveRandom(options.seed ?? 0);

  // Rings: base, shoulder, cap rim — then the apex. Radii and heights as fractions of the post.
  const rings = [
    { y: 0, r: 1 },
    { y: 1 - bevel, r: 0.94 },
    { y: 1 - bevel, r: 0.55 },
  ];
  const vertCount = rings.length * sides + 1;
  const positions = new Float32Array(vertCount * 3);
  const uvs = new Float32Array(vertCount * 2);
  const indices = new Uint32Array((2 * sides + 2 * sides + sides) * 3);
  let vi = 0;
  for (let ring = 0; ring < rings.length; ring++) {
    const spec = rings[ring]!;
    for (let k = 0; k < sides; k++) {
      const a = (k / sides) * Math.PI * 2;
      const r = radius * spec.r * (1 + (random() - 0.5) * 2 * roughness);
      positions[vi * 3] = Math.cos(a) * r;
      positions[vi * 3 + 1] = height * spec.y;
      positions[vi * 3 + 2] = Math.sin(a) * r;
      uvs[vi * 2] = k / sides;
      uvs[vi * 2 + 1] = spec.y;
      vi++;
    }
  }
  positions[vi * 3] = 0;
  positions[vi * 3 + 1] = height;
  positions[vi * 3 + 2] = 0;
  uvs[vi * 2] = 0.5;
  uvs[vi * 2 + 1] = 1;
  const apex = vi;
  vi++;

  let ii = 0;
  // The two shaft bands (base → shoulder rim, shoulder rim → cap rim) as quads, wound so the face
  // normal points away from the post's axis: (lower k, upper k, lower k+1) is the cylinder's own
  // side ordering, and the second band's shoulder annulus therefore faces up.
  for (let band = 0; band < 2; band++) {
    const lower = band * sides;
    const upper = (band + 1) * sides;
    for (let k = 0; k < sides; k++) {
      const next = (k + 1) % sides;
      indices[ii++] = lower + k;
      indices[ii++] = upper + k;
      indices[ii++] = lower + next;
      indices[ii++] = lower + next;
      indices[ii++] = upper + k;
      indices[ii++] = upper + next;
    }
  }
  // The cap: rim ring to apex, wound so the fan faces up and out (the cylinder's top-cap ordering).
  const capRing = 2 * sides;
  for (let k = 0; k < sides; k++) {
    indices[ii++] = apex;
    indices[ii++] = capRing + ((k + 1) % sides);
    indices[ii++] = capRing + k;
  }
  if (ii !== indices.length) throw new Error(`propGeometrySource: wrote ${ii} of ${indices.length} indices`);
  const { normals, tangents } = computeNormalsAndTangents(positions, indices, uvs);
  return { positions, normals, uvs, tangents, indices, label: "prop" };
}

export interface LodPrimitiveOptions {
  /** Builds one level's source; called with 0 for the finest and `levels - 1` for the coarsest. */
  build: (level: number) => GeometrySource;
  /** Levels in the chain (at least two — one level is not a chain). */
  levels: number;
  /** Metres at which each level after the first takes over; ascending, `levels - 1` entries. */
  distances: number[];
}

/**
 * A primitive with a device-selectable LOD chain (Phase 14.4): one geometry whose index buffer holds
 * every level, so the culler can switch levels by rewriting the draw's index window.
 *
 * The builder is what makes the levels *the same shape at different detail* — a rock at fewer
 * segments, a tuft with fewer blades — which is why this takes a function rather than a decimation
 * pass. A general mesh decimator (quadric collapse over an imported asset) is not built; the levels
 * here are regenerated, not reduced.
 */
export function createLodPrimitive(device: GraphicsDevice, options: LodPrimitiveOptions): Geometry {
  const levels = Math.max(2, Math.floor(options.levels));
  const sources: GeometrySource[] = [];
  for (let i = 0; i < levels; i++) sources.push(options.build(i));
  return Geometry.createLodChain(device, sources, options.distances);
}

/** Line-list geometry for the debug overlay: pairs of positions. */
export function linesGeometry(positions: Float32Array, colors: Uint32Array): { positions: Float32Array; colors: Uint32Array; vertexCount: number } {
  return { positions, colors, vertexCount: Math.floor(positions.length / 3) };
}

/** Unit cube as an uploaded geometry (the phase-1 demo's mesh). */
export function createBox(device: GraphicsDevice, options: BoxOptions = {}): Geometry {
  return Geometry.create(device, boxGeometrySource(options));
}

export function createPlane(device: GraphicsDevice, options: PlaneOptions = {}): Geometry {
  return Geometry.create(device, planeGeometrySource(options));
}

export function createSphere(device: GraphicsDevice, options: SphereOptions = {}): Geometry {
  return Geometry.create(device, sphereGeometrySource(options));
}

/** A rock/boulder as an uploaded geometry (Phase 14 population types). */
export function createRock(device: GraphicsDevice, options: RockOptions = {}): Geometry {
  return Geometry.create(device, rockGeometrySource(options));
}

/** Debris fragments as an uploaded geometry (Phase 14.2). */
export function createDebris(device: GraphicsDevice, options: DebrisOptions = {}): Geometry {
  return Geometry.create(device, debrisGeometrySource(options));
}

/** A vegetation tuft as an uploaded geometry (Phase 14.2). Pair it with a double-sided material. */
export function createVegetation(device: GraphicsDevice, options: VegetationOptions = {}): Geometry {
  return Geometry.create(device, vegetationGeometrySource(options));
}

/** An environmental prop (a beveled post) as an uploaded geometry (Phase 14.2). */
export function createProp(device: GraphicsDevice, options: PropOptions = {}): Geometry {
  return Geometry.create(device, propGeometrySource(options));
}

export function createCylinder(device: GraphicsDevice, options: CylinderOptions = {}): Geometry {
  return Geometry.create(device, cylinderGeometrySource(options));
}

export function createTorus(device: GraphicsDevice, options: { radius?: number; tube?: number } = {}): Geometry {
  return Geometry.create(device, torusGeometrySource(options));
}

export const PRIMITIVE_SIZES = { VERTEX_STRIDE } as const;
