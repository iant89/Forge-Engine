/**
 * Cube-sphere addressing for the Mars terrain port (see `docs/MARS-TERRAIN.md`).
 *
 * A transcription of `src/cubeSphere.ts` from the dev-time generator `mars-terrain-gen`. It is kept
 * byte-for-byte in behaviour (same face ordering, same spherified-cube warp, same normalisation) on
 * purpose: the generator's Stage A writes a *correction* field (`erosionDelta = eroded - analytic
 * base`) on this grid, and the port adds that correction to its own analytic base. If the two
 * disagree about where a point lies on the sphere — or how far apart two grid points are — the
 * correction is applied to the wrong place and shows up as relief that does not line up with the
 * craters and volcanoes that produced it.
 *
 * The whole planet is 6 quadtrees, one per cube face, each with local coordinates in [-1, 1]. 3D
 * noise is sampled from the resulting unit direction, so the six faces join without seams and
 * nothing needs a lat/long projection (no pole singularity, no pinching).
 */

/** The planet is covered by six cube faces. */
export const MARS_FACE_COUNT = 6;

/** Face ids, in the generator's order. `+X, -X, +Y, -Y, +Z, -Z`. */
export const MARS_FACE_PX = 0;
export const MARS_FACE_NX = 1;
export const MARS_FACE_PY = 2;
export const MARS_FACE_NY = 3;
export const MARS_FACE_PZ = 4;
export const MARS_FACE_NZ = 5;

/** Cube face + face-local coordinates, in [-1, 1]. */
export interface MarsFaceUV {
  face: number;
  u: number;
  v: number;
}

/** Unit direction for a face-local (u, v). Throws for an unknown face id. */
export function marsFaceUVToDirection(face: number, u: number, v: number): { x: number; y: number; z: number } {
  let x: number;
  let y: number;
  let z: number;
  switch (face) {
    case MARS_FACE_PX:
      x = 1;
      y = v;
      z = -u;
      break;
    case MARS_FACE_NX:
      x = -1;
      y = v;
      z = u;
      break;
    case MARS_FACE_PY:
      x = u;
      y = 1;
      z = -v;
      break;
    case MARS_FACE_NY:
      x = u;
      y = -1;
      z = v;
      break;
    case MARS_FACE_PZ:
      x = u;
      y = v;
      z = 1;
      break;
    case MARS_FACE_NZ:
      x = -u;
      y = v;
      z = -1;
      break;
    default:
      throw new Error(`marsFaceUVToDirection: bad face ${face}`);
  }

  // "Spherified cube" warp (Cignoni et al.). Evens out area across a face far better than a naive
  // normalise(), which matters because the erosion correction is simulated on a per-face grid: an
  // uneven warp would make one part of a face coarser than another in real metres.
  const x2 = x * x;
  const y2 = y * y;
  const z2 = z * z;
  const sx = x * Math.sqrt(1 - y2 / 2 - z2 / 2 + (y2 * z2) / 3);
  const sy = y * Math.sqrt(1 - z2 / 2 - x2 / 2 + (z2 * x2) / 3);
  const sz = z * Math.sqrt(1 - x2 / 2 - y2 / 2 + (x2 * y2) / 3);
  const inv = 1 / Math.hypot(sx, sy, sz);
  return { x: sx * inv, y: sy * inv, z: sz * inv };
}

/**
 * Nearest face + face-local coordinates for a direction — the *approximate* inverse used to pick
 * which low-res Stage A cell a direction falls in.
 *
 * The spherify warp is not exactly inverted here (the generator documents this as acceptable for a
 * lookup into a grid whose cells are ~10 km across). Do not use it to reconstruct geometry.
 */
export function marsDirectionToFaceUV(dir: { x: number; y: number; z: number }): MarsFaceUV {
  const ax = Math.abs(dir.x);
  const ay = Math.abs(dir.y);
  const az = Math.abs(dir.z);
  if (ax >= ay && ax >= az) {
    const face = dir.x > 0 ? MARS_FACE_PX : MARS_FACE_NX;
    const u = dir.x > 0 ? -dir.z / ax : dir.z / ax;
    const v = dir.y / ax;
    return { face, u, v };
  }
  if (ay >= ax && ay >= az) {
    const face = dir.y > 0 ? MARS_FACE_PY : MARS_FACE_NY;
    const u = dir.x / ay;
    const v = dir.y > 0 ? -dir.z / ay : dir.z / ay;
    return { face, u, v };
  }
  const face = dir.z > 0 ? MARS_FACE_PZ : MARS_FACE_NZ;
  const u = dir.z > 0 ? dir.x / az : -dir.x / az;
  const v = dir.y / az;
  return { face, u, v };
}

/**
 * Exact inverse of `marsFaceUVToDirection` on a given face (closed form, no iteration).
 *
 * The spherified-cube warp maps a cube point with free coordinates `(p, q)` to a *unit* vector whose
 * two non-axis components are `P = p·sqrt(1/2 - q²/6)` and `Q = q·sqrt(1/2 - p²/6)`. Squaring and
 * substituting `A = p²`, `B = q²` gives `A - B = 2(P² - Q²)` and a quadratic in `B`, so `(p, q)` come
 * back exactly (to double precision). That is what lets a baked height atlas, written by evaluating
 * `marsFaceUVToDirection` at every grid node, be read back at *the same place* from an arbitrary
 * direction: `marsDirectionToFaceUV` is only the approximate gnomonic inverse and is off by up to
 * ~0.1 of a face-local unit near the edges (hundreds of kilometres), so it must not be used for
 * this.
 *
 * `face` defaults to the face the direction lies on. Passing another face evaluates that face's
 * (extended) chart, which stays valid slightly beyond `|u|, |v| <= 1`; the atlas uses that to bake
 * and read its one-texel apron without any cross-face lookup.
 */
export function marsDirectionToFaceUVExact(
  dir: { x: number; y: number; z: number },
  face?: number,
  out?: MarsFaceUV,
): MarsFaceUV {
  const len = Math.hypot(dir.x, dir.y, dir.z) || 1;
  const x = dir.x / len;
  const y = dir.y / len;
  const z = dir.z / len;
  let f = face;
  if (f === undefined) {
    const ax = Math.abs(x);
    const ay = Math.abs(y);
    const az = Math.abs(z);
    if (ax >= ay && ax >= az) f = x > 0 ? MARS_FACE_PX : MARS_FACE_NX;
    else if (ay >= ax && ay >= az) f = y > 0 ? MARS_FACE_PY : MARS_FACE_NY;
    else f = z > 0 ? MARS_FACE_PZ : MARS_FACE_NZ;
  }
  // The two components of the unit direction that are *not* along the face's axis, in the order the
  // face maps them to (p, q) — see `marsFaceUVToDirection`.
  let P: number;
  let Q: number;
  switch (f) {
    case MARS_FACE_PX:
    case MARS_FACE_NX:
      P = y;
      Q = z;
      break;
    case MARS_FACE_PY:
    case MARS_FACE_NY:
      P = x;
      Q = z;
      break;
    case MARS_FACE_PZ:
    case MARS_FACE_NZ:
      P = x;
      Q = y;
      break;
    default:
      throw new Error(`marsDirectionToFaceUVExact: bad face ${f}`);
  }
  const P2 = P * P;
  const Q2 = Q * Q;
  const D = P2 - Q2;
  // Smaller root of B² + (2D - 3)B + 6Q² = 0 in its cancellation-free form (and A by symmetry), then
  // p = P / sqrt(1/2 - B/6), q = Q / sqrt(1/2 - A/6): exact to rounding even where p or q is ~0.
  const bB = 3 - 2 * D;
  const B = (12 * Q2) / (bB + Math.sqrt(Math.max(0, bB * bB - 24 * Q2)));
  const bA = 3 + 2 * D;
  const A = (12 * P2) / (bA + Math.sqrt(Math.max(0, bA * bA - 24 * P2)));
  const p = P / Math.sqrt(Math.max(1e-12, 0.5 - B / 6));
  const q = Q / Math.sqrt(Math.max(1e-12, 0.5 - A / 6));
  let u: number;
  let v: number;
  switch (f) {
    case MARS_FACE_PX:
      v = p;
      u = -q;
      break;
    case MARS_FACE_NX:
      v = p;
      u = q;
      break;
    case MARS_FACE_PY:
      u = p;
      v = -q;
      break;
    case MARS_FACE_NY:
      u = p;
      v = q;
      break;
    case MARS_FACE_PZ:
      u = p;
      v = q;
      break;
    default:
      u = -p;
      v = q;
      break;
  }
  const result = out ?? { face: f, u, v };
  result.face = f;
  result.u = u;
  result.v = v;
  return result;
}

/** Normalise a direction in place-safe form (returns a fresh object; exact `1 / hypot` scaling). */
export function marsNormalize(v: { x: number; y: number; z: number }): { x: number; y: number; z: number } {
  const inv = 1 / Math.hypot(v.x, v.y, v.z);
  return { x: v.x * inv, y: v.y * inv, z: v.z * inv };
}

/** Direction for an Earth-style (lat, lon) in degrees, on the planet-fixed frame used by the port. */
export function marsLatLonToDirection(latDeg: number, lonDeg: number): { x: number; y: number; z: number } {
  const lat = (latDeg * Math.PI) / 180;
  const lon = (lonDeg * Math.PI) / 180;
  const cosLat = Math.cos(lat);
  return { x: cosLat * Math.cos(lon), y: Math.sin(lat), z: cosLat * Math.sin(lon) };
}

/** Inverse of `marsLatLonToDirection`. */
export function marsLatLonOfDirection(dir: { x: number; y: number; z: number }): { latDeg: number; lonDeg: number } {
  const unit = marsNormalize(dir);
  return {
    latDeg: (Math.asin(Math.max(-1, Math.min(1, unit.y))) * 180) / Math.PI,
    lonDeg: (Math.atan2(unit.z, unit.x) * 180) / Math.PI,
  };
}

/** Great-circle distance between two directions, in metres on a sphere of `radius`. */
export function marsAngularDistanceMeters(
  a: { x: number; y: number; z: number },
  b: { x: number; y: number; z: number },
  radius: number,
): number {
  const an = marsNormalize(a);
  const bn = marsNormalize(b);
  const dot = Math.max(-1, Math.min(1, an.x * bn.x + an.y * bn.y + an.z * bn.z));
  return Math.acos(dot) * radius;
}

/**
 * Edge length of the *face-centre* chunk at a quadtree depth — i.e. the size the generator's
 * `--depth` argument produces "on average" (real chunks run from ~0.82x to ~1.4x this, because the
 * spherified cube evens out area but shears side lengths).
 *
 * This is the number to compare against Forge's `chunkSize` when deciding what to pre-generate; it
 * is exact for the cube-sphere map rather than a `2R/3 * step` approximation.
 */
export function marsFaceCentreChunkEdgeMeters(depth: number, radius: number): number {
  const divisions = 2 ** Math.floor(depth);
  const step = 2 / divisions;
  // Depth 0 is a single chunk covering the whole face, so measure the full span; deeper levels have
  // a chunk boundary on u = 0 and the centre chunk runs from there outwards.
  const u0 = divisions > 1 ? 0 : -1;
  const a = marsFaceUVToDirection(MARS_FACE_PZ, u0, 0);
  const b = marsFaceUVToDirection(MARS_FACE_PZ, u0 + step, 0);
  return marsAngularDistanceMeters(a, b, radius);
}

/**
 * Inverse of `marsFaceCentreChunkEdgeMeters`: the depth whose face-centre chunk edge is nearest
 * `meters`, in log space.
 *
 * Note this is a search, not a division: the spherified-cube warp is nonlinear in (u, v), so
 * halving the face divisions does *not* exactly halve the face-centre chunk edge (depth 4 is 300 km,
 * while "half the face at depth 0" would predict 333 km).
 */
export function marsDepthForChunkEdge(meters: number, radius: number): number {
  const target = Math.max(1e-9, meters);
  let bestDepth = 0;
  let bestRatio = Infinity;
  for (let depth = 0; depth <= 24; depth++) {
    const ratio = Math.abs(Math.log(marsFaceCentreChunkEdgeMeters(depth, radius) / target));
    if (ratio < bestRatio) {
      bestRatio = ratio;
      bestDepth = depth;
    }
  }
  return bestDepth;
}

/**
 * The smallest quadtree depth whose face-centre chunk is still *at most* `meters` across — the
 * conservative depth to pre-generate at when the result feeds a renderer tile of that size, so the
 * generator's cell never has to be upsampled into the tile.
 *
 * It is the rule behind the sizing table in `docs/MARS-TERRAIN.md`: 256 m -> depth 15 (146 m
 * chunks), 128 m -> depth 16 (73 m), 64 m -> depth 17 (37 m). It deliberately oversamples
 * (a 256 m tile gets 146 m chunks, ~1.75x finer, which costs 3x the chunks); `marsDepthForChunkEdge`
 * answers the cheaper question — "which depth is this size *closest* to" — and is the right pick when
 * a ~15% upsample is acceptable (512 m -> depth 13 at 585 m chunks rather than depth 14 at 293 m).
 */
export function marsDepthForChunkEdgeAtMost(meters: number, radius: number): number {
  let depth = 0;
  while (depth < 24 && marsFaceCentreChunkEdgeMeters(depth, radius) > meters) depth++;
  return depth;
}
