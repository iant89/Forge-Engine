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
      indices[k++] = c;
      indices[k++] = b;
      indices[k++] = b;
      indices[k++] = c;
      indices[k++] = d;
    }
  }
  const tangents = computeNormalsAndTangents(positions, indices, uvs).tangents;
  return { positions, normals, uvs, tangents, indices, label: "sphere" };
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
        if (cap === 0) indices.push(center, ring, ring + 1);
        else indices.push(center, ring + 1, ring);
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
      indices[k++] = c;
      indices[k++] = b;
      indices[k++] = b;
      indices[k++] = c;
      indices[k++] = d;
    }
  }
  const tangents = computeNormalsAndTangents(positions, indices, uvs).tangents;
  return { positions, normals, uvs, tangents, indices, label: "torus" };
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

export function createCylinder(device: GraphicsDevice, options: CylinderOptions = {}): Geometry {
  return Geometry.create(device, cylinderGeometrySource(options));
}

export function createTorus(device: GraphicsDevice, options: { radius?: number; tube?: number } = {}): Geometry {
  return Geometry.create(device, torusGeometrySource(options));
}

export const PRIMITIVE_SIZES = { VERTEX_STRIDE } as const;
