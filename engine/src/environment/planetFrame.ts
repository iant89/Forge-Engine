/**
 * Planet frames: the geometry and the calendar a globe viewer needs, for any planet.
 *
 * Two coordinate systems meet here and everything in this file is about converting between them:
 *
 *  - the **planet-fixed frame**: +Y is the rotation pole, longitude 0 lies on +X and longitude
 *    increases eastward toward +Z, so `direction(lat, lon) = (cosφ·cosλ, sinφ, cosφ·sinλ)`. It is the
 *    frame the Mars terrain port (`terrain/mars/cubeSphere.ts`) evaluates its geology in, so a
 *    direction from here can be handed to a terrain sampler unchanged;
 *  - the **world frame** of a scene that shows the planet from above. The analytic sky and the
 *    aerial-perspective path assume the planet's centre is straight below the camera (`+Y` is up at
 *    the observer), so a globe scene keeps the planet centred at `(0, -R, 0)` and the camera on the
 *    `+Y` axis, and *rotates the planet* instead of moving the camera. A {@link PlanetOrientation}
 *    is that rotation (planet-fixed → world).
 *
 * A *site frame* is the local tangent frame at a latitude/longitude: east, up, north — the same
 * orientation as `MarsSite` (local `+X` east, `+Z` north, `+Y` up). {@link planetOrientationForSite}
 * returns the orientation that makes the site's frame coincide with the world axes, which is what
 * lets a tangent-plane terrain world sit exactly where the globe's surface was a moment before.
 *
 * The calendar half ({@link PlanetOrbit}) turns a time in solar days ("sols") into the solar longitude
 * `Ls` (the season), the sun's declination, and the sun's direction in the planet-fixed frame, so a
 * globe, a weather table and a ground-level day/night cycle can all read one clock. The orbit is a
 * Keplerian ellipse with an axial tilt; the Mars preset reproduces the known season lengths
 * (northern spring 194 sols, summer 178, autumn 142, winter 154).
 *
 * Nothing here allocates once the scratch objects exist; every conversion writes into an `out`.
 */

import { Quat } from "../math/mat.js";
import type { Vec3Ops } from "../math/vec.js";
import { Vec3 } from "../math/vec.js";

const DEG = Math.PI / 180;
const TWO_PI = Math.PI * 2;

// ---------------------------------------------------------------------------------------- lat/lon

/** Unit direction for a latitude/longitude (degrees) in the planet-fixed frame. */
export function latLonToDirection(latDeg: number, lonDeg: number, out: Vec3Ops): Vec3Ops {
  const lat = latDeg * DEG;
  const lon = lonDeg * DEG;
  const c = Math.cos(lat);
  out.x = c * Math.cos(lon);
  out.y = Math.sin(lat);
  out.z = c * Math.sin(lon);
  return out;
}

/** Inverse of {@link latLonToDirection}; the direction need not be normalised. Longitude is in (-180, 180]. */
export function directionToLatLon(dir: Vec3Ops, out: { latDeg: number; lonDeg: number }): { latDeg: number; lonDeg: number } {
  const len = Math.hypot(dir.x, dir.y, dir.z) || 1;
  out.latDeg = Math.asin(Math.max(-1, Math.min(1, dir.y / len))) / DEG;
  out.lonDeg = Math.atan2(dir.z, dir.x) / DEG;
  return out;
}

/** Wrap a longitude into (-180, 180]. */
export function wrapLongitudeDeg(lonDeg: number): number {
  let l = ((lonDeg + 180) % 360 + 360) % 360 - 180;
  if (l === -180) l = 180;
  return l;
}

/** Great-circle angle between two unit directions, radians. */
export function angleBetweenDirections(a: Vec3Ops, b: Vec3Ops): number {
  const cross = Math.hypot(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);
  return Math.atan2(cross, a.x * b.x + a.y * b.y + a.z * b.z);
}

// ----------------------------------------------------------------------------------- site frames

export interface PlanetSiteBasis {
  up: Vec3;
  east: Vec3;
  north: Vec3;
}

/**
 * The tangent basis at a site, in the planet-fixed frame. At a pole the north reference vanishes, so
 * the frame falls back to the +Z axis (and `headingDeg` then defines it alone). `headingDeg` rotates
 * the frame about `up` exactly like `MarsSite`.
 */
export function planetSiteBasis(latDeg: number, lonDeg: number, headingDeg = 0, out?: PlanetSiteBasis): PlanetSiteBasis {
  const b = out ?? { up: new Vec3(), east: new Vec3(), north: new Vec3() };
  const up = latLonToDirection(latDeg, lonDeg, b.up) as Vec3;
  // Project the pole (+Y) into the tangent plane.
  let nx = -up.x * up.y;
  let ny = 1 - up.y * up.y;
  let nz = -up.z * up.y;
  let nl = Math.hypot(nx, ny, nz);
  if (nl < 1e-6) {
    // At a pole: any reference meridian will do.
    nx = -up.x * up.z;
    ny = -up.y * up.z;
    nz = 1 - up.z * up.z;
    nl = Math.hypot(nx, ny, nz);
  }
  nx /= nl;
  ny /= nl;
  nz /= nl;
  // east = up × north
  let ex = up.y * nz - up.z * ny;
  let ey = up.z * nx - up.x * nz;
  let ez = up.x * ny - up.y * nx;
  const el = Math.hypot(ex, ey, ez) || 1;
  ex /= el;
  ey /= el;
  ez /= el;
  const h = headingDeg * DEG;
  if (h !== 0) {
    const c = Math.cos(h);
    const s = Math.sin(h);
    const rex = ex * c + nx * s;
    const rey = ey * c + ny * s;
    const rez = ez * c + nz * s;
    const rnx = nx * c - ex * s;
    const rny = ny * c - ey * s;
    const rnz = nz * c - ez * s;
    ex = rex; ey = rey; ez = rez;
    nx = rnx; ny = rny; nz = rnz;
  }
  b.east.set(ex, ey, ez);
  b.north.set(nx, ny, nz);
  return b;
}

/** A rotation planet-fixed → world, stored as a unit quaternion (alias of {@link Quat}). */
export type PlanetOrientation = Quat;

/**
 * The orientation that puts the site at world `+Y` with its east axis on world `+X` and its north
 * axis on world `+Z`: `world = (v·east, v·up, v·north)` for a planet-fixed vector `v`.
 */
export function planetOrientationForSite(latDeg: number, lonDeg: number, headingDeg: number, out: PlanetOrientation): PlanetOrientation {
  const b = planetSiteBasis(latDeg, lonDeg, headingDeg);
  // Rows of the rotation matrix are east, up, north.
  return quatFromRows(b.east, b.up, b.north, out);
}

/** Quaternion of the rotation matrix whose rows are `r0`, `r1`, `r2` (Shepperd's method). */
export function quatFromRows(r0: Vec3Ops, r1: Vec3Ops, r2: Vec3Ops, out: Quat): Quat {
  const m00 = r0.x, m01 = r0.y, m02 = r0.z;
  const m10 = r1.x, m11 = r1.y, m12 = r1.z;
  const m20 = r2.x, m21 = r2.y, m22 = r2.z;
  const trace = m00 + m11 + m22;
  let x: number, y: number, z: number, w: number;
  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2;
    w = 0.25 * s;
    x = (m21 - m12) / s;
    y = (m02 - m20) / s;
    z = (m10 - m01) / s;
  } else if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    w = (m21 - m12) / s;
    x = 0.25 * s;
    y = (m01 + m10) / s;
    z = (m02 + m20) / s;
  } else if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    w = (m02 - m20) / s;
    x = (m01 + m10) / s;
    y = 0.25 * s;
    z = (m12 + m21) / s;
  } else {
    const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
    w = (m10 - m01) / s;
    x = (m02 + m20) / s;
    y = (m12 + m21) / s;
    z = 0.25 * s;
  }
  out.set(x, y, z, w);
  return out.normalize();
}

/** Rotate a vector by a quaternion into `out` (alias-safe). */
export function rotateByQuat(q: Quat, v: Vec3Ops, out: Vec3Ops): Vec3Ops {
  return q.rotateVector(v, out as Vec3) as Vec3Ops;
}

/** Rotate a vector by the inverse of a (unit) quaternion into `out` (alias-safe). */
export function rotateByQuatInverse(q: Quat, v: Vec3Ops, out: Vec3Ops): Vec3Ops {
  const vx = v.x, vy = v.y, vz = v.z;
  // conjugate of a unit quaternion is its inverse
  const x = -q.x, y = -q.y, z = -q.z, w = q.w;
  const tx = 2 * (y * vz - z * vy);
  const ty = 2 * (z * vx - x * vz);
  const tz = 2 * (x * vy - y * vx);
  out.x = vx + w * tx + (y * tz - z * ty);
  out.y = vy + w * ty + (z * tx - x * tz);
  out.z = vz + w * tz + (x * ty - y * tx);
  return out;
}

/** The unit quaternion rotating unit vector `a` onto unit vector `b` by the shortest arc. */
export function quatFromUnitVectors(a: Vec3Ops, b: Vec3Ops, out: Quat): Quat {
  const d = a.x * b.x + a.y * b.y + a.z * b.z;
  if (d < -0.999999) {
    // Opposite: any perpendicular axis.
    let ax = -a.z, ay = 0, az = a.x;
    if (Math.abs(a.x) < 1e-3 && Math.abs(a.z) < 1e-3) { ax = 0; ay = a.z; az = -a.y; }
    const l = Math.hypot(ax, ay, az) || 1;
    return out.set((ax / l), (ay / l), (az / l), 0);
  }
  out.set(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x, 1 + d);
  return out.normalize();
}

/** Spherical interpolation between two unit quaternions (shortest path) into `out`. */
export function slerpQuat(a: Quat, b: Quat, t: number, out: Quat): Quat {
  let bx = b.x, by = b.y, bz = b.z, bw = b.w;
  let cos = a.x * bx + a.y * by + a.z * bz + a.w * bw;
  if (cos < 0) {
    cos = -cos;
    bx = -bx; by = -by; bz = -bz; bw = -bw;
  }
  let s0: number, s1: number;
  if (cos > 0.9995) {
    s0 = 1 - t;
    s1 = t;
  } else {
    const theta = Math.acos(cos);
    const sin = Math.sin(theta);
    s0 = Math.sin((1 - t) * theta) / sin;
    s1 = Math.sin(t * theta) / sin;
  }
  out.set(a.x * s0 + bx * s1, a.y * s0 + by * s1, a.z * s0 + bz * s1, a.w * s0 + bw * s1);
  return out.normalize();
}

// ----------------------------------------------------------------------------------------- picking

/**
 * Nearest forward intersection of a ray with a sphere, as a distance along the (unit) direction, or
 * -1 when it misses or the sphere is behind. Exact for any scale because the quadratic is solved
 * relative to the sphere's centre.
 */
export function raySphereHit(
  ox: number, oy: number, oz: number,
  dx: number, dy: number, dz: number,
  cx: number, cy: number, cz: number,
  radius: number,
): number {
  const px = ox - cx, py = oy - cy, pz = oz - cz;
  const b = px * dx + py * dy + pz * dz;
  const c = px * px + py * py + pz * pz - radius * radius;
  const disc = b * b - c;
  if (disc < 0) return -1;
  const s = Math.sqrt(disc);
  const t0 = -b - s;
  if (t0 > 0) return t0;
  const t1 = -b + s;
  return t1 > 0 ? t1 : -1;
}

/**
 * Where a pointer ray meets the planet as a unit direction from the centre. A ray that misses is
 * *clamped* to the silhouette (the point of the ray closest to the centre, normalised) so a drag that
 * strays off the disc keeps turning the planet instead of freezing. Returns whether it truly hit.
 */
export function pickPlanetDirection(
  origin: Vec3Ops, dir: Vec3Ops, centre: Vec3Ops, radius: number, out: Vec3Ops,
): boolean {
  const t = raySphereHit(origin.x, origin.y, origin.z, dir.x, dir.y, dir.z, centre.x, centre.y, centre.z, radius);
  if (t > 0) {
    out.x = origin.x + dir.x * t - centre.x;
    out.y = origin.y + dir.y * t - centre.y;
    out.z = origin.z + dir.z * t - centre.z;
  } else {
    const px = origin.x - centre.x, py = origin.y - centre.y, pz = origin.z - centre.z;
    const along = -(px * dir.x + py * dir.y + pz * dir.z);
    out.x = px + dir.x * along;
    out.y = py + dir.y * along;
    out.z = pz + dir.z * along;
  }
  const l = Math.hypot(out.x, out.y, out.z) || 1;
  out.x /= l;
  out.y /= l;
  out.z /= l;
  return t > 0;
}

// ------------------------------------------------------------------------------------------ orbit

export interface PlanetOrbit {
  /** Axial tilt, degrees. */
  obliquityDeg: number;
  /** Length of one solar day, seconds. */
  solarDaySeconds: number;
  /** Length of the year in solar days. */
  yearSols: number;
  /** Orbital eccentricity, 0..<1. */
  eccentricity: number;
  /** Solar longitude `Ls` (degrees) at which the planet is at perihelion. */
  perihelionLsDeg: number;
}

/** Mars: 25.19° tilt, 88 775 s sol, 668.6-sol year, e = 0.0934, perihelion at Ls ≈ 251°. */
export const MARS_ORBIT: Readonly<PlanetOrbit> = Object.freeze({
  obliquityDeg: 25.19,
  solarDaySeconds: 88775.244,
  yearSols: 668.6,
  eccentricity: 0.0934,
  perihelionLsDeg: 251,
});

function keplerE(M: number, e: number): number {
  let E = M + e * Math.sin(M);
  for (let i = 0; i < 8; i++) E -= (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
  return E;
}

function trueAnomalyFromE(E: number, e: number): number {
  return 2 * Math.atan2(Math.sqrt(1 + e) * Math.sin(E / 2), Math.sqrt(1 - e) * Math.cos(E / 2));
}

/** Solar longitude `Ls` in [0, 360) after `sols` solar days past the northern spring equinox (Ls = 0). */
export function solarLongitudeDeg(orbit: PlanetOrbit, sols: number): number {
  const e = orbit.eccentricity;
  // The equinox sits at true anomaly ν₀ = −Lp (Ls = ν + Lp); start the mean anomaly there.
  const nu0 = -orbit.perihelionLsDeg * DEG;
  const E0 = 2 * Math.atan2(Math.sqrt(1 - e) * Math.sin(nu0 / 2), Math.sqrt(1 + e) * Math.cos(nu0 / 2));
  const M0 = E0 - e * Math.sin(E0);
  const M = M0 + (TWO_PI * sols) / orbit.yearSols;
  const nu = trueAnomalyFromE(keplerE(M, e), e);
  const ls = (nu / DEG + orbit.perihelionLsDeg) % 360;
  return ls < 0 ? ls + 360 : ls;
}

/** The sol count (since Ls = 0, within one year) at which the planet reaches `lsDeg`. Inverse of {@link solarLongitudeDeg}. */
export function solsForSolarLongitude(orbit: PlanetOrbit, lsDeg: number): number {
  const e = orbit.eccentricity;
  const nu = (lsDeg - orbit.perihelionLsDeg) * DEG;
  const E = 2 * Math.atan2(Math.sqrt(1 - e) * Math.sin(nu / 2), Math.sqrt(1 + e) * Math.cos(nu / 2));
  const M = E - e * Math.sin(E);
  const nu0 = -orbit.perihelionLsDeg * DEG;
  const E0 = 2 * Math.atan2(Math.sqrt(1 - e) * Math.sin(nu0 / 2), Math.sqrt(1 + e) * Math.cos(nu0 / 2));
  const M0 = E0 - e * Math.sin(E0);
  let dM = (M - M0) % TWO_PI;
  if (dM < 0) dM += TWO_PI;
  return (dM / TWO_PI) * orbit.yearSols;
}

/** Declination of the sun (degrees, +north) at solar longitude `lsDeg`. */
export function solarDeclinationDeg(orbit: PlanetOrbit, lsDeg: number): number {
  return Math.asin(Math.sin(orbit.obliquityDeg * DEG) * Math.sin(lsDeg * DEG)) / DEG;
}

/** Fraction of the solar day elapsed at `sols` (0 ≤ f < 1). */
export function solFraction(sols: number): number {
  const f = sols - Math.floor(sols);
  return f < 0 ? f + 1 : f;
}

/** Longitude (degrees east, in (-180, 180]) of the subsolar point: where it is local noon. */
export function subsolarLongitudeDeg(sols: number): number {
  return wrapLongitudeDeg(-360 * solFraction(sols));
}

/** Unit direction toward the sun in the planet-fixed frame at `sols` solar days past Ls = 0. */
export function planetSunDirection(orbit: PlanetOrbit, sols: number, out: Vec3Ops): Vec3Ops {
  const ls = solarLongitudeDeg(orbit, sols);
  return latLonToDirection(solarDeclinationDeg(orbit, ls), subsolarLongitudeDeg(sols), out);
}

/** Local mean solar time in hours [0, 24) at a longitude: 12 when that longitude is under the sun. */
export function localSolarHours(lonDeg: number, sols: number): number {
  const h = 12 + (lonDeg - subsolarLongitudeDeg(sols)) / 15;
  return ((h % 24) + 24) % 24;
}

/**
 * The `sols` value (keeping the year phase of `sols`) whose local solar time at `lonDeg` is `hours`.
 * Used to scrub the clock of a ground-level site without changing the season.
 */
export function solsForLocalHours(lonDeg: number, hours: number, sols: number): number {
  // hours = 12 + (lon - subLon)/15 and subLon = -360·f  ⇒  360·f = (hours - 12)·15 - lon  (mod 360)
  const f = ((((hours - 12) * 15 - lonDeg) / 360) % 1 + 1) % 1;
  const whole = Math.floor(sols);
  let next = whole + f;
  // Stay within half a day of the input so scrubbing never jumps a season.
  if (next - sols > 0.5) next -= 1;
  else if (sols - next > 0.5) next += 1;
  return next;
}
