/**
 * World-space UI support: projecting 3D points into the UI viewport.
 *
 * Forge's convention (AGENTS.md §3): column-major `Mat4`, `clip = viewProj × [x, y, z, 1]`, depth in
 * `[0, 1]` with `clip.w = view-space z` (positive in front of the camera), NDC +Y up. The UI's +Y is
 * down, so `y = (1 − (ndc.y + 1) / 2) × height`. A point is *on screen* when it is in front of the
 * camera (`w > 0`), inside the depth range, and inside the viewport.
 *
 * This is deliberately separate from the core layout system: world-anchored widgets
 * (`WorldSpaceLabel`) position themselves with a render translation each frame, so following a moving
 * object never re-runs layout.
 */

export interface WorldPoint {
  x: number;
  y: number;
  z: number;
}

export interface ProjectedPoint {
  /** Viewport position in logical units. */
  x: number;
  y: number;
  /** View-space depth (distance along the camera's forward axis). */
  depth: number;
  /** In front of the camera and within the depth range. */
  inFront: boolean;
  /** `inFront` and inside the viewport rectangle. */
  onScreen: boolean;
}

/** Project a world point with a column-major view-projection matrix. */
export function projectToViewport(p: WorldPoint, viewProj: ArrayLike<number>, width: number, height: number, out: ProjectedPoint = { x: 0, y: 0, depth: 0, inFront: false, onScreen: false }): ProjectedPoint {
  const m = viewProj;
  const cx = m[0]! * p.x + m[4]! * p.y + m[8]! * p.z + m[12]!;
  const cy = m[1]! * p.x + m[5]! * p.y + m[9]! * p.z + m[13]!;
  const cz = m[2]! * p.x + m[6]! * p.y + m[10]! * p.z + m[14]!;
  const cw = m[3]! * p.x + m[7]! * p.y + m[11]! * p.z + m[15]!;
  out.depth = cw;
  if (cw <= 1e-6) {
    out.inFront = false;
    out.onScreen = false;
    out.x = out.y = NaN;
    return out;
  }
  const nx = cx / cw;
  const ny = cy / cw;
  const nz = cz / cw;
  out.x = (nx * 0.5 + 0.5) * width;
  out.y = (1 - (ny * 0.5 + 0.5)) * height;
  out.inFront = nz >= 0 && nz <= 1;
  out.onScreen = out.inFront && out.x >= 0 && out.x <= width && out.y >= 0 && out.y <= height;
  return out;
}

/** What a world-anchored widget needs from the camera each frame. */
export interface WorldCamera {
  readonly viewProj: ArrayLike<number>;
  readonly position: WorldPoint;
}

/** Linear distance fade: 1 inside `fadeStart`, 0 beyond `maxDistance`. */
export function distanceFade(distance: number, fadeStart: number, maxDistance: number): number {
  if (distance <= fadeStart) return 1;
  if (distance >= maxDistance) return 0;
  return 1 - (distance - fadeStart) / Math.max(1e-6, maxDistance - fadeStart);
}
