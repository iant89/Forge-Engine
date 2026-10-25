/**
 * Pure helpers for the Mars Orbit Explorer's camera and transitions (kept DOM- and GPU-free so they
 * are unit-tested). The engine owns the planet maths (`environment/planetFrame.ts`); this is only the
 * demo's camera policy: how far back to hold the camera, how a dive eases, how thick the entry haze is.
 */

export const clamp = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x);

/** Hermite smoothstep between `a` and `b` (a < b). */
export function smoothstep(a: number, b: number, x: number): number {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
}

/**
 * Altitude (m above the surface) at which a planet of `radius` fills `fill` (0..1) of the shorter
 * half-field of view: the framing that works in landscape and portrait alike.
 */
export function orbitFitAltitude(radius: number, fovYRad: number, aspect: number, fill = 0.82): number {
  const halfY = fovYRad / 2;
  const halfX = Math.atan(Math.tan(halfY) * Math.max(0.1, aspect));
  const half = Math.min(halfY, halfX);
  return radius / Math.sin(half * fill) - radius;
}

/** Orbit zoom limits as multiples of the fit altitude, plus an absolute floor so relief stays visible. */
export function orbitAltitudeRange(fitAltitude: number, minAltitude = 900e3): { min: number; max: number } {
  return { min: Math.min(fitAltitude * 0.9, minAltitude), max: fitAltitude * 2.4 };
}

/**
 * Camera clip planes for a camera at `altitude` over a planet of `radius`: near scales with altitude
 * (depth precision), far reaches just past the planet's far limb.
 */
export function orbitClipPlanes(radius: number, altitude: number): { near: number; far: number } {
  const near = Math.max(200, altitude * 0.02);
  const far = (altitude + 2 * radius) * 1.15 + near;
  return { near, far };
}

/** Largest visible cap (radians) the globe's detail patch is used for; wider views use the whole-planet texture. */
export const DETAIL_MAX_RADIUS = (24 * Math.PI) / 180;

/**
 * Angular radius (radians, at the planet centre) of the ground an orbit camera at `altitude`, looking
 * straight down with vertical field `fovYRad`, can see out to its frame corners — or 0 when that is
 * wider than {@link DETAIL_MAX_RADIUS} and the detail patch should be off.
 */
export function detailFocusRadius(radius: number, altitude: number, fovYRad: number, aspect: number): number {
  const corner = Math.atan(Math.tan(fovYRad / 2) * Math.hypot(1, Math.max(0.1, aspect)));
  const k = ((radius + altitude) / radius) * Math.sin(corner);
  // A corner ray past the limb sees out to the horizon.
  const cap = k >= 1 ? Math.acos(radius / (radius + altitude)) : Math.asin(k) - corner;
  return cap > DETAIL_MAX_RADIUS ? 0 : cap;
}

/** Log-space interpolation between two positive heights; `u` in 0..1. */
export function lerpLog(a: number, b: number, u: number): number {
  return Math.exp(Math.log(a) + (Math.log(b) - Math.log(a)) * clamp(u, 0, 1));
}

/**
 * The butterscotch entry haze (0..1) that hides the swap between the baked globe and the ground
 * world. Orbit-scale altitudes ramp up as the camera closes on the surface; once on the ground side of
 * the swap the ground-relative height fades it out again.
 *
 * @param altitude metres above the surface
 * @param groundSide true once the terrain world (not the globe) is what is drawn
 */
export function entryHaze(altitude: number, groundSide: boolean): number {
  if (groundSide) return smoothstep(2.5e4, 3.8e5, altitude);
  return 1 - smoothstep(3.5e5, 2.2e6, altitude);
}

/** Camera quaternion (x, y, z, w) for a ground view with compass heading `yaw` and look-up `pitch`, radians. */
export function groundViewQuaternion(yaw: number, pitch: number, out: [number, number, number, number]): [number, number, number, number] {
  // q = Ry(yaw) · Rx(-pitch): +Z forward, +X right, +Y up; positive pitch looks up.
  const hy = yaw / 2;
  const hx = -pitch / 2;
  const sy = Math.sin(hy), cy = Math.cos(hy);
  const sx = Math.sin(hx), cx = Math.cos(hx);
  // Ry = (0, sy, 0, cy), Rx = (sx, 0, 0, cx); product Ry * Rx.
  out[0] = cy * sx;
  out[1] = sy * cx;
  out[2] = -sy * sx;
  out[3] = cy * cx;
  return out;
}

/**
 * World direction under a pointer (CSS px) for the ground camera of {@link groundViewQuaternion}:
 * the camera-space {@link pixelRay} rotated by the view. Unit length.
 */
export function groundPointerDirection(
  px: number, py: number, width: number, height: number, fovYRad: number, yaw: number, pitch: number,
): { x: number; y: number; z: number } {
  const v = pixelRay(px, py, width, height, fovYRad);
  const q = groundViewQuaternion(yaw, pitch, [0, 0, 0, 1]);
  const [qx, qy, qz, qw] = q;
  // v' = v + 2w(q × v) + 2 q × (q × v)
  const tx = 2 * (qy * v.z - qz * v.y);
  const ty = 2 * (qz * v.x - qx * v.z);
  const tz = 2 * (qx * v.y - qy * v.x);
  return {
    x: v.x + qw * tx + (qy * tz - qz * ty),
    y: v.y + qw * ty + (qz * tx - qx * tz),
    z: v.z + qw * tz + (qx * ty - qy * tx),
  };
}

/** Lowest elevation (radians) a ground double-tap that hits no loaded terrain still counts as the sky. */
export const SKY_PICK_MIN_ELEVATION = (0.5 * Math.PI) / 180;

/**
 * Whether a ground-view double-tap landed on the sky: the view ray hit no loaded terrain and points
 * above the horizon (so the unloaded distant ground just under it does not count).
 */
export function isSkyPick(directionY: number, hitTerrain: boolean): boolean {
  return !hitTerrain && directionY > Math.sin(SKY_PICK_MIN_ELEVATION);
}

/**
 * Screen position (CSS px) of a world point for the orbit camera: eye at `(0, altitude, 0)` looking down
 * −Y with +X right and +Z up the screen (the basis `pixelRay` picking uses, so this is its inverse).
 * `inFront` is false for a point behind the eye.
 */
export function projectOrbitPoint(
  x: number, y: number, z: number, altitude: number, fovYRad: number, width: number, height: number,
): { x: number; y: number; inFront: boolean } {
  const forward = altitude - y;
  const tanY = Math.tan(fovYRad / 2);
  const tanX = tanY * (width / Math.max(1, height));
  const depth = Math.max(forward, 1e-9);
  const nx = x / (depth * tanX);
  const ny = z / (depth * tanY);
  return { x: ((nx + 1) / 2) * width, y: ((1 - ny) / 2) * height, inFront: forward > 0 };
}

/**
 * How squarely a surface point faces an orbit camera at `(0, altitude, 0)`: the cosine between the outward
 * normal and the direction to the eye (≤ 0 on the far side; small near the limb). `nx, ny, nz` is the
 * unit normal, `px, py, pz` the point, both in world space.
 */
export function orbitFacing(nx: number, ny: number, nz: number, px: number, py: number, pz: number, altitude: number): number {
  const ex = -px;
  const ey = altitude - py;
  const ez = -pz;
  const l = Math.hypot(ex, ey, ez) || 1;
  return (nx * ex + ny * ey + nz * ez) / l;
}

/** The orbit camera is the ground view with yaw 0 and pitch −90°: straight down, north up the screen. */
export const ORBIT_VIEW_PITCH = -Math.PI / 2;

/** Pointer position (CSS px) → camera-space ray direction components for a symmetric perspective camera. */
export function pixelRay(
  px: number, py: number, width: number, height: number, fovYRad: number,
): { x: number; y: number; z: number } {
  const tanY = Math.tan(fovYRad / 2);
  const tanX = tanY * (width / Math.max(1, height));
  const nx = (px / Math.max(1, width)) * 2 - 1;
  const ny = 1 - (py / Math.max(1, height)) * 2;
  const x = nx * tanX;
  const y = ny * tanY;
  const l = Math.hypot(x, y, 1);
  return { x: x / l, y: y / l, z: 1 / l };
}
