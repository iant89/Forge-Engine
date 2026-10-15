/**
 * Coastal terrain (fe-33): a procedural beach profile — sloped seabed, sand beach rising to a berm,
 * a dune ridge, and a low hinterland — as a height function, a mesh source and the
 * matching water shoreline.
 *
 * Coordinates follow the water shore (`SceneWaterSettings.shore`): `origin` is a point on the
 * still waterline at `bedLevel`, `direction` points inland. `along` = metres inland from the
 * waterline (negative offshore), `across` = metres along the coast. Offshore the bed is exactly the
 * water's analytic seabed (`bedLevel + slope·along`, floored at `minDepth`), so the rendered depth
 * colour, shoaling and swash foam meet the sand where the mesh does. Use
 * {@link coastalShoreSettings} to configure the water from the same parameters.
 */

import type { WaterShoreSettings } from "../scene/scene.js";
import { clamp } from "../math/scalar.js";
import { shoreCurveOffset } from "../environment/water.js";

export interface CoastalTerrainParams {
  originX: number;
  originZ: number;
  /** Inland direction (normalised internally). */
  directionX: number;
  directionZ: number;
  /** Height of the still waterline. Default 0. */
  bedLevel?: number;
  /** Beach and nearshore slope (rise per metre). Default 0.035. */
  slope?: number;
  /** Deepest the seabed goes below `bedLevel`. Default 30. */
  minDepth?: number;
  /** Berm (top of beach) height above the waterline. Default 1.6. */
  bermHeight?: number;
  /** Distance inland where the dunes start. Default 55. */
  beachWidth?: number;
  /** Dune ridge height above the berm. Default 4. */
  duneHeight?: number;
  /** Dune ridge width. Default 35. */
  duneWidth?: number;
  /** Hinterland height above the berm. Default 1.2. */
  inlandHeight?: number;
  /** Noise seed for the dune crest / hummocks. Default 1. */
  seed?: number;
  /**
   * fe-34 curvy coast: waterline displaced inland by `Σ curveAmpN·sin(2π·across/curveLengthN +
   * curvePhaseN)` (the water's `shoreCurveOffset`), so bays and points wind along the coast and
   * the whole profile (beach, berm, dunes) follows them. Default 0 (straight).
   */
  curveAmp1?: number;
  curveLength1?: number;
  curvePhase1?: number;
  curveAmp2?: number;
  curveLength2?: number;
  curvePhase2?: number;
  /** Dune field: number of extra hummock rows behind the main ridge (0..2). Default 0. */
  duneRows?: number;
}

function hash1(n: number, seed: number): number {
  const s = Math.sin(n * 127.1 + seed * 311.7) * 43758.5453123;
  return s - Math.floor(s);
}

/** Smooth 1D value noise in [0, 1]. */
function noise1(x: number, seed: number): number {
  const i = Math.floor(x);
  const f = x - i;
  const u = f * f * (3 - 2 * f);
  return hash1(i, seed) * (1 - u) + hash1(i + 1, seed) * u;
}

function smoothstep(a: number, b: number, x: number): number {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
}

interface Resolved {
  ox: number;
  oz: number;
  dx: number;
  dz: number;
  bed: number;
  slope: number;
  minDepth: number;
  berm: number;
  beach: number;
  dune: number;
  duneW: number;
  inland: number;
  seed: number;
}

function resolve(p: CoastalTerrainParams): Resolved {
  const len = Math.hypot(p.directionX, p.directionZ) || 1;
  return {
    ox: p.originX,
    oz: p.originZ,
    dx: p.directionX / len,
    dz: p.directionZ / len,
    bed: p.bedLevel ?? 0,
    slope: Math.max(1e-4, p.slope ?? 0.035),
    minDepth: p.minDepth ?? 30,
    berm: p.bermHeight ?? 1.6,
    beach: p.beachWidth ?? 55,
    dune: p.duneHeight ?? 4,
    duneW: p.duneWidth ?? 35,
    inland: p.inlandHeight ?? 1.2,
    seed: p.seed ?? 1,
  };
}

/** Inland distance (`along`) and coast-wise position (`across`) of a world XZ. */
export function coastalCoordinates(params: CoastalTerrainParams, x: number, z: number): { along: number; across: number } {
  const r = resolve(params);
  const px = x - r.ox;
  const pz = z - r.oz;
  const across = -px * r.dz + pz * r.dx;
  return { along: px * r.dx + pz * r.dz - shoreCurveOffset(params, across), across };
}

/** Terrain height at a world XZ. */
export function coastalHeightAt(params: CoastalTerrainParams, x: number, z: number): number {
  const r = resolve(params);
  const px = x - r.ox;
  const pz = z - r.oz;
  const across = -px * r.dz + pz * r.dx;
  const along = px * r.dx + pz * r.dz - shoreCurveOffset(params, across);
  // Seabed and beach face: one plane through the waterline (exactly the water's shore bed)...
  const plane = r.bed + r.slope * along;
  if (along <= 0) return Math.max(plane, r.bed - r.minDepth);
  // ...that rolls over into a flat berm.
  const bermStart = r.berm / r.slope;
  let h = along < bermStart ? plane : r.bed + r.berm;
  // Soft roll-over between face and berm.
  const k = Math.min(6, bermStart * 0.3);
  if (Math.abs(along - bermStart) < k) {
    const u = (along - bermStart + k) / (2 * k);
    h = r.bed + r.berm - (r.slope * k * (1 - u) * (1 - u)) / 1;
  }
  // Dune ridge with a wandering crest line and height.
  const wander = (noise1(across / 60, r.seed) - 0.5) * 14;
  const duneCentre = r.beach + r.duneW * 0.5 + wander;
  const dist = (along - duneCentre) / (r.duneW * 0.5);
  const ridge = Math.exp(-dist * dist * 1.6);
  const crest = 0.65 + 0.35 * noise1(across / 23, r.seed + 7) + 0.15 * (noise1(across / 7, r.seed + 3) - 0.5);
  h += r.dune * ridge * crest;
  // fe-34: secondary dune rows (hummocks with blowouts) behind the fore-dune.
  const rows = Math.max(0, Math.min(2, Math.round(params.duneRows ?? 0)));
  for (let k = 1; k <= rows; k++) {
    const c = duneCentre + k * r.duneW * 0.9 + (noise1(across / 45, r.seed + 20 + k) - 0.5) * 18;
    const dd = (along - c) / (r.duneW * 0.42);
    const hump = Math.exp(-dd * dd * 1.8) * (0.35 + 0.65 * noise1(across / 17, r.seed + 30 + k));
    h += r.dune * (0.75 - 0.2 * k) * hump;
  }
  // Hinterland behind the dunes.
  h += r.inland * smoothstep(duneCentre, duneCentre + r.duneW, along) * (0.7 + 0.3 * noise1(across / 40 + along / 50, r.seed + 11));
  return h;
}

/** The water shoreline that matches this coast (spread into `scene.setWater({ shore })`). */
export function coastalShoreSettings(params: CoastalTerrainParams, extra: Partial<WaterShoreSettings> = {}): Partial<WaterShoreSettings> {
  const r = resolve(params);
  return {
    enabled: true,
    originX: r.ox,
    originZ: r.oz,
    directionX: r.dx,
    directionZ: r.dz,
    bedLevel: r.bed,
    slope: r.slope,
    curveAmp1: params.curveAmp1 ?? 0,
    curveLength1: params.curveLength1 ?? 400,
    curvePhase1: params.curvePhase1 ?? 0,
    curveAmp2: params.curveAmp2 ?? 0,
    curveLength2: params.curveLength2 ?? 150,
    curvePhase2: params.curvePhase2 ?? 0,
    ...extra,
  };
}

export interface CoastalMeshSource {
  positions: Float32Array;
  normals: Float32Array;
  uvs: Float32Array;
  indices: Uint32Array;
  boundsMin: [number, number, number];
  boundsMax: [number, number, number];
}

/**
 * A heightfield mesh of the coast over a `sizeX × sizeZ` rectangle centred on `(centerX, centerZ)`
 * (finite-difference normals, UVs in metres / `uvScale`).
 */
export function coastalTerrainSource(params: CoastalTerrainParams, centerX: number, centerZ: number, sizeX: number, sizeZ: number, segmentsX: number, segmentsZ: number, uvScale = 8): CoastalMeshSource {
  const sx = Math.max(1, Math.floor(segmentsX));
  const sz = Math.max(1, Math.floor(segmentsZ));
  const nx = sx + 1;
  const nz = sz + 1;
  const positions = new Float32Array(nx * nz * 3);
  const normals = new Float32Array(nx * nz * 3);
  const uvs = new Float32Array(nx * nz * 2);
  const ex = sizeX / sx;
  const ez = sizeZ / sz;
  let minY = Infinity;
  let maxY = -Infinity;
  for (let iz = 0; iz < nz; iz++) {
    for (let ix = 0; ix < nx; ix++) {
      const x = centerX - sizeX / 2 + ix * ex;
      const z = centerZ - sizeZ / 2 + iz * ez;
      const y = coastalHeightAt(params, x, z);
      const v = iz * nx + ix;
      positions[v * 3] = x;
      positions[v * 3 + 1] = y;
      positions[v * 3 + 2] = z;
      const hx = coastalHeightAt(params, x + 0.5, z) - coastalHeightAt(params, x - 0.5, z);
      const hz = coastalHeightAt(params, x, z + 0.5) - coastalHeightAt(params, x, z - 0.5);
      const inv = 1 / Math.hypot(hx, 1, hz);
      normals[v * 3] = -hx * inv;
      normals[v * 3 + 1] = inv;
      normals[v * 3 + 2] = -hz * inv;
      uvs[v * 2] = x / uvScale;
      uvs[v * 2 + 1] = z / uvScale;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  const indices = new Uint32Array(sx * sz * 6);
  let o = 0;
  for (let iz = 0; iz < sz; iz++) {
    for (let ix = 0; ix < sx; ix++) {
      const a = iz * nx + ix;
      const b = a + 1;
      const c = a + nx;
      const d = c + 1;
      indices[o++] = a;
      indices[o++] = c;
      indices[o++] = b;
      indices[o++] = b;
      indices[o++] = c;
      indices[o++] = d;
    }
  }
  return {
    positions,
    normals,
    uvs,
    indices,
    boundsMin: [centerX - sizeX / 2, minY, centerZ - sizeZ / 2],
    boundsMax: [centerX + sizeX / 2, maxY, centerZ + sizeZ / 2],
  };
}
