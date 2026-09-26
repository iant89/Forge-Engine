/**
 * Region/ring planner for `mars-terrain-gen` — "which chunks do I actually pre-generate, and how big
 * are they in metres?" — as pure, dependency-free code.
 *
 * Why this file exists: the generator's own `buildChunks()` in `src/build.ts` walks *every* chunk of
 * *every* cube face at *one* fixed depth. At the shipped default (depth 4, resolution 65) that is
 * 1,536 chunks of ~300 km each; one depth deeper is 6,144 chunks, depth 15 is 6.4 billion. Nothing
 * about that walk is wrong for a demo of the erosion pass, but it cannot express the thing a renderer
 * actually needs: "give me the terrain around this place, at sizes that match my tiles".
 *
 * This module is deliberately self-contained (it mirrors `src/cubeSphere.ts` rather than importing it)
 * so it can be unit-tested from the engine repo, where a test asserts the two cube-sphere
 * implementations still agree point-for-point. Copy it next to `pregenerate.ts` into the generator's
 * `src/` — see `tools/mars-terrain/README.md`.
 */

// ------------------------------------------------------------------ cube sphere (mirror of src/cubeSphere.ts)

export const FACE_PX = 0;
export const FACE_NX = 1;
export const FACE_PY = 2;
export const FACE_NY = 3;
export const FACE_PZ = 4;
export const FACE_NZ = 5;

export const FACE_COUNT = 6;

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** Unit direction for a face-local (u, v) in [-1, 1]. Mirrors the generator's `faceUVToDirection`. */
export function faceUVToDirection(face: number, u: number, v: number): Vec3 {
  let x: number;
  let y: number;
  let z: number;
  switch (face) {
    case FACE_PX:
      x = 1;
      y = v;
      z = -u;
      break;
    case FACE_NX:
      x = -1;
      y = v;
      z = u;
      break;
    case FACE_PY:
      x = u;
      y = 1;
      z = -v;
      break;
    case FACE_NY:
      x = u;
      y = -1;
      z = v;
      break;
    case FACE_PZ:
      x = u;
      y = v;
      z = 1;
      break;
    case FACE_NZ:
      x = -u;
      y = v;
      z = -1;
      break;
    default:
      throw new Error(`bad face: ${face}`);
  }
  const x2 = x * x;
  const y2 = y * y;
  const z2 = z * z;
  const sx = x * Math.sqrt(1 - y2 / 2 - z2 / 2 + (y2 * z2) / 3);
  const sy = y * Math.sqrt(1 - z2 / 2 - x2 / 2 + (z2 * x2) / 3);
  const sz = z * Math.sqrt(1 - x2 / 2 - y2 / 2 + (x2 * y2) / 3);
  const inv = 1 / Math.hypot(sx, sy, sz);
  return { x: sx * inv, y: sy * inv, z: sz * inv };
}

export function normalize(v: Vec3): Vec3 {
  const inv = 1 / Math.hypot(v.x, v.y, v.z);
  return { x: v.x * inv, y: v.y * inv, z: v.z * inv };
}

/** Direction for a (lat, lon) in degrees, matching the engine port's planet-fixed frame. */
export function latLonToDirection(latDeg: number, lonDeg: number): Vec3 {
  const lat = (latDeg * Math.PI) / 180;
  const lon = (lonDeg * Math.PI) / 180;
  const cosLat = Math.cos(lat);
  return { x: cosLat * Math.cos(lon), y: Math.sin(lat), z: cosLat * Math.sin(lon) };
}

/** Inverse of `latLonToDirection`. */
export function latLonOfDirection(dir: Vec3): { latDeg: number; lonDeg: number } {
  const unit = normalize(dir);
  return {
    latDeg: (Math.asin(Math.max(-1, Math.min(1, unit.y))) * 180) / Math.PI,
    lonDeg: (Math.atan2(unit.z, unit.x) * 180) / Math.PI,
  };
}

/** Great-circle distance between two directions, in metres. */
export function angularDistanceMeters(a: Vec3, b: Vec3, radiusM: number): number {
  const an = normalize(a);
  const bn = normalize(b);
  const dot = Math.max(-1, Math.min(1, an.x * bn.x + an.y * bn.y + an.z * bn.z));
  return Math.acos(dot) * radiusM;
}

/**
 * Edge length of the face-centre chunk at a quadtree depth, in metres.
 *
 * Real chunks are not this size: the spherified cube evens out *area* between faces (within +-8%) but
 * shears side lengths, so a depth-4 chunk runs 245-401 km depending on where it sits. Use this to
 * choose a depth; use `planMarsChunks`'s per-chunk `edgeMeters` to see what you actually got.
 */
export function faceCentreChunkEdgeMeters(depth: number, radiusM: number): number {
  const divisions = 2 ** Math.floor(depth);
  const step = 2 / divisions;
  const u0 = divisions > 1 ? 0 : -1;
  return angularDistanceMeters(faceUVToDirection(FACE_PZ, u0, 0), faceUVToDirection(FACE_PZ, u0 + step, 0), radiusM);
}

/** The depth whose face-centre chunk is nearest `meters` (cheapest choice). */
export function depthForChunkEdge(meters: number, radiusM: number): number {
  let best = 0;
  let bestRatio = Infinity;
  for (let depth = 0; depth <= 24; depth++) {
    const ratio = Math.abs(Math.log(faceCentreChunkEdgeMeters(depth, radiusM) / Math.max(1e-9, meters)));
    if (ratio < bestRatio) {
      bestRatio = ratio;
      best = depth;
    }
  }
  return best;
}

/**
 * The smallest depth whose face-centre chunk is at most `meters` across — the conservative choice for
 * feeding a renderer tile of that size without upsampling (256 m -> depth 15, 128 m -> 16).
 */
export function depthForChunkEdgeAtMost(meters: number, radiusM: number): number {
  let depth = 0;
  while (depth < 24 && faceCentreChunkEdgeMeters(depth, radiusM) > meters) depth++;
  return depth;
}

// ------------------------------------------------------------------ planning

/** Same fields as the generator's `ChunkAddress`. */
export interface ChunkAddress {
  face: number;
  u0: number;
  v0: number;
  u1: number;
  v1: number;
  resolution: number;
}

export interface PlanBand {
  /** Quadtree depth: `2^depth` chunks per face edge. */
  depth: number;
  /** Vertices per chunk edge (use 33 or 65; anything else is off the engine's LOD ladder). */
  resolution: number;
  /** Radius of this band's ring, in km, from the plan site. */
  withinKm: number;
}

export interface PlanOptions {
  /** Centre of the area of interest. */
  site: { latDeg: number; lonDeg: number };
  /** Rings, finest first. Each chunk is generated by the finest band that contains it. */
  bands: PlanBand[];
  radiusM?: number;
  /** Restrict to these cube faces (default: all six). */
  faces?: number[];
  /** Refuse to plan more than this many chunks (default 250,000). */
  maxChunks?: number;
  /** Refuse to plan more than this many bytes on disk (default 12 GiB). */
  maxBytes?: number;
}

export interface PlannedChunk extends ChunkAddress {
  depth: number;
  /** Mean edge length of this chunk in metres (min/max show the shear across the chunk). */
  edgeMeters: number;
  minEdgeMeters: number;
  maxEdgeMeters: number;
  /** File size in bytes: the generator's `4 + 21 * resolution^2` layout. */
  bytes: number;
  /** Distance from the plan site to the chunk centre, in metres. */
  distanceMeters: number;
}

export interface PlanEstimate {
  chunks: number;
  bytes: number;
  vertices: number;
  perBand: { depth: number; resolution: number; withinKm: number; chunks: number; bytes: number; edgeMeters: number }[];
}

export interface Plan {
  chunks: PlannedChunk[];
  estimate: PlanEstimate;
  warnings: string[];
}

/** Chunk file size for the generator's packed layout: int32 header + positions + heights + materials + slope. */
export function chunkFileBytes(resolution: number): number {
  return 4 + resolution * resolution * (3 * 4 + 4 + 1 + 4);
}

/** File name the generator's `chunkCacheKey` produces for an address. */
export function chunkFileName(addr: ChunkAddress): string {
  return `f${addr.face}_${addr.u0.toFixed(6)}_${addr.v0.toFixed(6)}_${addr.u1.toFixed(6)}_${addr.v1.toFixed(6)}_r${addr.resolution}.bin`;
}

interface RawChunk {
  face: number;
  u0: number;
  v0: number;
  u1: number;
  v1: number;
  depth: number;
  resolution: number;
  distanceMeters: number;
  edgeMeters: number;
  minEdgeMeters: number;
  maxEdgeMeters: number;
}

function measureChunk(face: number, u0: number, v0: number, u1: number, v1: number, radiusM: number): { edge: number; min: number; max: number } {
  const sides = [
    angularDistanceMeters(faceUVToDirection(face, u0, v0), faceUVToDirection(face, u1, v0), radiusM),
    angularDistanceMeters(faceUVToDirection(face, u0, v1), faceUVToDirection(face, u1, v1), radiusM),
    angularDistanceMeters(faceUVToDirection(face, u0, v0), faceUVToDirection(face, u0, v1), radiusM),
    angularDistanceMeters(faceUVToDirection(face, u1, v0), faceUVToDirection(face, u1, v1), radiusM),
  ];
  let sum = 0;
  let min = Infinity;
  let max = 0;
  for (const side of sides) {
    sum += side;
    if (side < min) min = side;
    if (side > max) max = side;
  }
  return { edge: sum / sides.length, min, max };
}

/**
 * Descend the per-face quadtree and keep only the chunks whose centre is inside a band's ring.
 *
 * The descent is what makes this usable at depth 15+: pruning a node when even its nearest corner is
 * outside the ring means the walk costs roughly the number of chunks it emits, instead of the 6 x 4^15
 * of a full sweep.
 */
function collectBand(
  out: RawChunk[],
  site: Vec3,
  band: PlanBand,
  radiusM: number,
  faces: number[],
  withinMeters: number,
): void {
  const visit = (face: number, u0: number, v0: number, level: number): void => {
    const size = 2 / 2 ** level;
    const centreU = u0 + size / 2;
    const centreV = v0 + size / 2;
    const centreDir = faceUVToDirection(face, centreU, centreV);
    const corner = faceUVToDirection(face, u0, v0);
    // Conservative half-extent: the diagonal of the sub-quadtree node, measured at this level.
    const halfDiag = angularDistanceMeters(centreDir, corner, radiusM);
    const centreDistance = angularDistanceMeters(centreDir, site, radiusM);
    if (centreDistance - halfDiag > withinMeters) return;

    if (level === band.depth) {
      const metrics = measureChunk(face, u0, v0, u0 + size, v0 + size, radiusM);
      out.push({
        face,
        u0,
        v0,
        u1: u0 + size,
        v1: v0 + size,
        depth: band.depth,
        resolution: band.resolution,
        distanceMeters: centreDistance,
        edgeMeters: metrics.edge,
        minEdgeMeters: metrics.min,
        maxEdgeMeters: metrics.max,
      });
      return;
    }
    visit(face, u0, v0, level + 1);
    visit(face, u0 + size / 2, v0, level + 1);
    visit(face, u0, v0 + size / 2, level + 1);
    visit(face, u0 + size / 2, v0 + size / 2, level + 1);
  };

  for (const face of faces) visit(face, -1, -1, 0);
}

/**
 * Plan a region: a site plus a list of rings, finest first. Returns the chunks to generate plus a
 * cost estimate, and refuses (with warnings) when the plan exceeds the configured caps.
 */
export function planMarsChunks(options: PlanOptions): Plan {
  const radiusM = options.radiusM ?? 3_389_500;
  const faces = options.faces ?? [FACE_PX, FACE_NX, FACE_PY, FACE_NY, FACE_PZ, FACE_NZ];
  const maxChunks = options.maxChunks ?? 250_000;
  const maxBytes = options.maxBytes ?? 12 * 1024 ** 3;
  const warnings: string[] = [];

  if (options.bands.length === 0) throw new Error("planMarsChunks: at least one band is required");
  // Bands are authored finest-first and each ring must reach at least as far as the one before it,
  // so a chunk is always generated once, by the finest band that covers it.
  for (let i = 1; i < options.bands.length; i++) {
    const previous = options.bands[i - 1]!;
    const band = options.bands[i]!;
    if (band.withinKm < previous.withinKm) {
      throw new Error(
        `planMarsChunks: bands must be ordered finest first (depth ${band.depth} ring ${band.withinKm} km ` +
          `is inside depth ${previous.depth} ring ${previous.withinKm} km)`,
      );
    }
    if (band.depth > previous.depth) {
      throw new Error(
        `planMarsChunks: bands must be ordered finest first (depth ${band.depth} is finer than depth ${previous.depth})`,
      );
    }
  }
  for (const band of options.bands) {
    const steps = band.resolution - 1;
    if (steps < 2 || (steps & (steps - 1)) !== 0) {
      warnings.push(
        `band depth ${band.depth}: resolution ${band.resolution} is off the renderer's geomorph LOD ladder ` +
          `(use 3, 5, 9, 17, 33, 65 or 129)`,
      );
    }
  }

  const site = normalize(latLonToDirection(options.site.latDeg, options.site.lonDeg));
  const planned = new Set<string>();
  const chunks: PlannedChunk[] = [];
  const perBand: PlanEstimate["perBand"] = [];

  for (const band of options.bands) {
    const raw: RawChunk[] = [];
    collectBand(raw, site, band, radiusM, faces, band.withinKm * 1000);
    // Finest band wins: a chunk already placed by a closer ring is not generated twice.
    raw.sort((a, b) => a.distanceMeters - b.distanceMeters);
    let bandChunks = 0;
    let bandBytes = 0;
    let edgeSum = 0;
    for (const chunk of raw) {
      const key = `${chunk.face}|${chunk.u0.toFixed(6)}|${chunk.v0.toFixed(6)}|${chunk.resolution}`;
      if (planned.has(key)) continue;
      planned.add(key);
      chunks.push({ ...chunk, bytes: chunkFileBytes(chunk.resolution) });
      bandChunks++;
      bandBytes += chunkFileBytes(chunk.resolution);
      edgeSum += chunk.edgeMeters;
    }
    perBand.push({
      depth: band.depth,
      resolution: band.resolution,
      withinKm: band.withinKm,
      chunks: bandChunks,
      bytes: bandBytes,
      edgeMeters: bandChunks > 0 ? edgeSum / bandChunks : 0,
    });
  }

  const estimate: PlanEstimate = {
    chunks: chunks.length,
    bytes: chunks.reduce((total, c) => total + c.bytes, 0),
    vertices: chunks.reduce((total, c) => total + c.resolution * c.resolution, 0),
    perBand,
  };

  if (estimate.chunks > maxChunks) {
    warnings.push(
      `plan has ${estimate.chunks.toLocaleString()} chunks, above the ${maxChunks.toLocaleString()} cap: ` +
        `shrink the outer ring, drop the coarsest band, or raise --max-chunks`,
    );
  }
  if (estimate.bytes > maxBytes) {
    warnings.push(
      `plan writes ${(estimate.bytes / 1024 ** 3).toFixed(2)} GiB, above the ${(maxBytes / 1024 ** 3).toFixed(2)} GiB cap: ` +
        `raise --max-bytes or shrink the plan`,
    );
  }
  const widest = chunks.reduce((max, c) => Math.max(max, c.maxEdgeMeters), 0);
  const narrowest = chunks.reduce((min, c) => Math.min(min, c.minEdgeMeters), Infinity);
  if (chunks.length > 0 && widest / Math.max(1, narrowest) > 1.6) {
    warnings.push(
      `chunk edges within this plan run ${(narrowest / 1000).toFixed(1)}-${(widest / 1000).toFixed(1)} km: the ` +
        `spherified cube keeps area even but not side lengths, so "chunk size" is only exact at a face centre`,
    );
  }

  chunks.sort((a, b) => a.face - b.face || a.depth - b.depth || a.v0 - b.v0 || a.u0 - b.u0);
  return { chunks, estimate, warnings };
}

/** Convenience: the geometry of the chunk containing a point, for sanity checks and logs. */
export function chunkContaining(
  latDeg: number,
  lonDeg: number,
  depth: number,
  radiusM = 3_389_500,
): { face: number; u0: number; v0: number; u1: number; v1: number; edgeMeters: number; distanceMeters: number } {
  const dir = normalize(latLonToDirection(latDeg, lonDeg));
  // Nearest face by dominant axis (the generator's own lookup approach).
  const ax = Math.abs(dir.x);
  const ay = Math.abs(dir.y);
  const az = Math.abs(dir.z);
  let face: number;
  let u: number;
  let v: number;
  if (ax >= ay && ax >= az) {
    face = dir.x > 0 ? FACE_PX : FACE_NX;
    u = dir.x > 0 ? -dir.z / ax : dir.z / ax;
    v = dir.y / ax;
  } else if (ay >= ax && ay >= az) {
    face = dir.y > 0 ? FACE_PY : FACE_NY;
    u = dir.x / ay;
    v = dir.y > 0 ? -dir.z / ay : dir.z / ay;
  } else {
    face = dir.z > 0 ? FACE_PZ : FACE_NZ;
    u = dir.z > 0 ? dir.x / az : -dir.x / az;
    v = dir.y / az;
  }
  const divisions = 2 ** depth;
  const step = 2 / divisions;
  const u0 = Math.max(-1, Math.min(1 - step, Math.floor((u + 1) / step) * step - 1));
  const v0 = Math.max(-1, Math.min(1 - step, Math.floor((v + 1) / step) * step - 1));
  const metrics = measureChunk(face, u0, v0, u0 + step, v0 + step, radiusM);
  return { face, u0, v0, u1: u0 + step, v1: v0 + step, edgeMeters: metrics.edge, distanceMeters: 0 };
}
