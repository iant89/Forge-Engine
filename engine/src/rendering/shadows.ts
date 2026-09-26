/**
 * Shadow-map fitting (docs/RENDERING.md §4).
 *
 * Pure math, no GPU: `computeCascades` fits an orthographic directional projection to each camera
 * slice; `computeSpotShadow` fits a perspective projection to one light's cone and finite range;
 * `computePointShadow` fits six 90° perspective projections — one per cube face — around a point
 * light's finite range. Kept separate so tests can pin the properties that matter without a device:
 *
 *  - splits are monotone and cover exactly `[near, shadowDistance]` (practical split scheme,
 *    `lambda` blends uniform and logarithmic spacing);
 *  - every corner of a cascade's frustum slice projects inside the cascade's clip box, so no
 *    receiver inside the slice can fall off its shadow map;
 *  - the light box is fitted to the slice's *bounding sphere*, so its size does not depend on the
 *    camera's orientation (rotating the camera does not change the texel footprint → no shimmer
 *    from rotation), and its centre is snapped to whole shadow texels in light space (translating
 *    the camera does not make the shadow edge crawl).
 *
 * All positions are render-local (relative to the coordinate-space origin), like everything else
 * the renderer uploads.
 */

import { Mat4 } from "../math/mat.js";
import { Vec3 } from "../math/vec.js";

export interface CascadeCameraParams {
  /** Camera world matrix in render-local space (the inverse of the view matrix). */
  world: Mat4;
  fovY: number;
  aspect: number;
  near: number;
  orthographic: boolean;
  /** Full height of the orthographic view volume (ignored for perspective cameras). */
  orthoHeight: number;
}

export interface CascadeOptions {
  count: number;
  /** Distance from the camera covered by shadows (the last split). */
  shadowDistance: number;
  /** 0 = uniform splits, 1 = logarithmic; ~0.6 is a good outdoor default. */
  lambda: number;
  /** Shadow map resolution per cascade (texel snapping needs it). */
  mapSize: number;
  /** Light travel direction (normalised). */
  lightDirection: Vec3;
  /** How far behind the slice's sphere the light eye sits, in sphere radii (casters beyond it are missed). */
  casterBackoff?: number;
}

export interface Cascade {
  /** View-space near/far distances of the slice this cascade covers. */
  near: number;
  far: number;
  /** Light view-projection for the slice, render-local → clip. */
  viewProj: Mat4;
  /** Render-local size of one shadow texel in this cascade. */
  texelWorld: number;
  /** Sphere the box was fitted to (render-local centre, after snapping). */
  center: Vec3;
  radius: number;
}

/** Practical split scheme (Zhang et al.): a blend of uniform and logarithmic partitions. */
export function computeCascadeSplits(near: number, far: number, count: number, lambda: number, out: number[] = []): number[] {
  out.length = 0;
  const n = Math.max(near, 1e-3);
  const f = Math.max(far, n + 1e-3);
  const l = Math.min(1, Math.max(0, lambda));
  for (let i = 1; i <= count; i++) {
    const p = i / count;
    const log = n * Math.pow(f / n, p);
    const uni = n + (f - n) * p;
    out.push(l * log + (1 - l) * uni);
  }
  // The last split is the shadow distance exactly, whatever floating point did above.
  out[count - 1] = f;
  return out;
}

const scratchCorner = new Vec3();
const scratchCenter = new Vec3();
const scratchEye = new Vec3();
const scratchUp = new Vec3();
const scratchRot = new Mat4();
const scratchInv = new Mat4();
const scratchView = new Mat4();
const scratchProj = new Mat4();

/** The 8 corners of the view-frustum slice `[near, far]`, in render-local space, written to `out` (24 floats). */
export function frustumSliceCorners(camera: CascadeCameraParams, near: number, far: number, out: Float32Array): Float32Array {
  let k = 0;
  for (const d of [near, far]) {
    let halfH: number;
    let halfW: number;
    if (camera.orthographic) {
      halfH = camera.orthoHeight / 2;
      halfW = halfH * camera.aspect;
    } else {
      halfH = Math.tan(camera.fovY / 2) * d;
      halfW = halfH * camera.aspect;
    }
    for (const sy of [-1, 1]) {
      for (const sx of [-1, 1]) {
        scratchCorner.set(sx * halfW, sy * halfH, d);
        camera.world.transformPoint(scratchCorner, scratchCorner);
        out[k++] = scratchCorner.x;
        out[k++] = scratchCorner.y;
        out[k++] = scratchCorner.z;
      }
    }
  }
  return out;
}

/**
 * Fit every cascade. `out` is reused when it already holds `count` entries (the renderer calls this
 * per frame and must not allocate).
 */
export function computeCascades(camera: CascadeCameraParams, options: CascadeOptions, out: Cascade[] = []): Cascade[] {
  const count = Math.max(1, Math.min(4, Math.floor(options.count)));
  const splits = computeCascadeSplits(camera.near, options.shadowDistance, count, options.lambda);
  while (out.length < count) out.push({ near: 0, far: 0, viewProj: new Mat4(), texelWorld: 0, center: new Vec3(), radius: 0 });
  out.length = count;
  const dir = options.lightDirection;
  const backoff = options.casterBackoff ?? 4;

  // Light rotation (render-local → light view) shared by all cascades: the eye sits at the origin
  // so the matrix is pure rotation and can be inverted by transposition.
  scratchUp.set(0, 1, 0);
  if (Math.abs(dir.y) > 0.99) scratchUp.set(0, 0, 1);
  scratchRot.setLookAt(Vec3.zero, dir, scratchUp);
  scratchInv.copyFrom(scratchRot).transpose();

  let sliceNear = camera.near;
  for (let c = 0; c < count; c++) {
    const cascade = out[c]!;
    const sliceFar = splits[c]!;
    cascade.near = sliceNear;
    cascade.far = sliceFar;

    // Bounding sphere of the slice: the centre lies on the view axis where the distances to the
    // near-corner ring and the far-corner ring are equal; clamp it into the slice.
    let rn: number;
    let rf: number;
    if (camera.orthographic) {
      const hh = camera.orthoHeight / 2;
      rn = rf = Math.hypot(hh, hh * camera.aspect);
    } else {
      const t = Math.tan(camera.fovY / 2);
      const k = Math.hypot(t, t * camera.aspect);
      rn = k * sliceNear;
      rf = k * sliceFar;
    }
    let z = (sliceFar * sliceFar + rf * rf - sliceNear * sliceNear - rn * rn) / (2 * Math.max(sliceFar - sliceNear, 1e-6));
    z = Math.min(sliceFar, Math.max(sliceNear, z));
    const radiusRaw = Math.max(Math.hypot(sliceFar - z, rf), Math.hypot(z - sliceNear, rn));
    // A little padding keeps PCF taps at the slice boundary inside the map.
    const radius = radiusRaw * 1.02 + 1e-3;
    scratchCenter.set(0, 0, z);
    camera.world.transformPoint(scratchCenter, scratchCenter);

    // Texel snapping in light space: the box moves in whole-texel steps, so a translating camera
    // does not make shadow edges crawl.
    const texelWorld = (2 * radius) / options.mapSize;
    scratchRot.transformPoint(scratchCenter, scratchCenter);
    scratchCenter.x = Math.round(scratchCenter.x / texelWorld) * texelWorld;
    scratchCenter.y = Math.round(scratchCenter.y / texelWorld) * texelWorld;
    scratchInv.transformPoint(scratchCenter, scratchCenter);

    const back = radius * backoff;
    scratchEye.set(scratchCenter.x - dir.x * back, scratchCenter.y - dir.y * back, scratchCenter.z - dir.z * back);
    scratchView.setLookAt(scratchEye, scratchCenter, scratchUp);
    scratchProj.setOrthographic(-radius, radius, -radius, radius, 0, back + radius);
    cascade.viewProj.multiplyMatrices(scratchProj, scratchView);
    cascade.texelWorld = texelWorld;
    cascade.center.copyFrom(scratchCenter);
    cascade.radius = radius;
    sliceNear = sliceFar;
  }
  return out;
}

/** Reused renderer output for one perspective spotlight depth map. */
export interface SpotShadowFit {
  /** Render-local -> spot light clip space; WebGPU depth is [0,1]. */
  viewProj: Mat4;
  fovY: number;
  near: number;
  far: number;
  /** One map texel in UV space. */
  texelSize: number;
  /** World-space texel footprint per light-view-space unit (multiply by clip.w). */
  worldTexelScale: number;
}

const spotView = new Mat4();
const spotProjection = new Mat4();
const spotTarget = new Vec3();
const spotUp = new Vec3();

/**
 * Fit a square perspective map to a spotlight's outer cone and finite range. The fit is conservative
 * with respect to the analytic cone: the outer cosine is clamped to a valid perspective FOV, and
 * callers supply the wider of the configured inner/outer cones. Returns false for a degenerate
 * direction, range or resolution instead of emitting a singular matrix.
 */
export function computeSpotShadow(
  position: Vec3,
  direction: Vec3,
  outerConeCos: number,
  range: number,
  mapSize: number,
  out: SpotShadowFit,
): boolean {
  const directionLength = Math.hypot(direction.x, direction.y, direction.z);
  if (
    !Number.isFinite(position.x) || !Number.isFinite(position.y) || !Number.isFinite(position.z) ||
    !(directionLength > 1e-8) || !Number.isFinite(directionLength) || !(range > 1e-4) || !Number.isFinite(range) || !(mapSize > 0) || !Number.isFinite(mapSize)
  ) {
    return false;
  }
  const dx = direction.x / directionLength;
  const dy = direction.y / directionLength;
  const dz = direction.z / directionLength;
  spotTarget.set(position.x + dx, position.y + dy, position.z + dz);
  spotUp.set(0, 1, 0);
  if (Math.abs(dy) > 0.99) spotUp.set(0, 0, 1);

  const cosine = Math.max(-1, Math.min(1, Number.isFinite(outerConeCos) ? outerConeCos : 0.6));
  const fovY = Math.max(Math.PI / 360, Math.min(Math.PI - Math.PI / 360, 2 * Math.acos(cosine)));
  const near = Math.min(0.1, range * 0.01);
  const resolution = Math.max(1, Math.floor(mapSize));
  spotView.setLookAt(position, spotTarget, spotUp);
  spotProjection.setPerspective(fovY, 1, near, range);
  out.viewProj.multiplyMatrices(spotProjection, spotView);
  out.fovY = fovY;
  out.near = near;
  out.far = range;
  out.texelSize = 1 / resolution;
  out.worldTexelScale = (2 * Math.tan(fovY / 2)) / resolution;
  return true;
}

/**
 * One cube face of a point-light shadow map: a 90° perspective projection aimed down that face's
 * axis, exactly the transform the sampler inverts at shading time (face order +x -x +y -y +z -z).
 */
export interface PointShadowFace {
  /** Render-local -> this face's clip space; WebGPU depth is [0,1]. */
  viewProj: Mat4;
  /** Unit axis this face looks along (render-local). */
  readonly axis: Vec3;
}

/** Reused renderer output for one point light's six-face depth map. */
export interface PointShadowFit {
  readonly faces: PointShadowFace[];
  near: number;
  far: number;
  /** One map texel in UV space. */
  texelSize: number;
  /** World-space texel footprint per light-view-space unit (multiply by clip.w). */
  worldTexelScale: number;
}

/** Cube-face axis + up pairs. The view matrix aims local +Z down `axis`; `up` breaks the ±axis
 *  ambiguity. Face order matches `POINT_FACE_AXES` consumers (shader, renderer, tests). */
const POINT_FACE_AXES: ReadonlyArray<readonly [axis: [number, number, number], up: [number, number, number]]> = [
  [[1, 0, 0], [0, 1, 0]], // +x
  [[-1, 0, 0], [0, 1, 0]], // -x
  [[0, 1, 0], [0, 0, -1]], // +y
  [[0, -1, 0], [0, 0, 1]], // -y
  [[0, 0, 1], [0, 1, 0]], // +z
  [[0, 0, -1], [0, 1, 0]], // -z
];

const pointView = new Mat4();
const pointProjection = new Mat4();
const pointTarget = new Vec3();
const pointUp = new Vec3();

/** Allocate the six reusable face records (the renderer keeps one set per point-shadow slot). */
export function createPointShadowFaces(): PointShadowFace[] {
  return POINT_FACE_AXES.map(([axis]) => ({ viewProj: new Mat4(), axis: new Vec3(...axis) }));
}

/**
 * Fit six square perspective maps (one cube face each) to a point light's finite range. Every face
 * shares the light's position as its eye and the range as its far plane, so any caster inside the
 * light's sphere lands in at least one face. Returns false for a degenerate position, range or
 * resolution instead of emitting singular matrices.
 */
export function computePointShadow(position: Vec3, range: number, mapSize: number, out: PointShadowFit): boolean {
  if (
    !Number.isFinite(position.x) || !Number.isFinite(position.y) || !Number.isFinite(position.z) ||
    !(range > 1e-4) || !Number.isFinite(range) || !(mapSize > 0) || !Number.isFinite(mapSize)
  ) {
    return false;
  }
  const near = Math.min(0.1, range * 0.01);
  const resolution = Math.max(1, Math.floor(mapSize));
  pointProjection.setPerspective(Math.PI / 2, 1, near, range);
  for (let f = 0; f < POINT_FACE_AXES.length; f++) {
    const [axis, up] = POINT_FACE_AXES[f]!;
    const face = out.faces[f]!;
    pointTarget.set(position.x + axis[0]!, position.y + axis[1]!, position.z + axis[2]!);
    pointUp.set(up[0]!, up[1]!, up[2]!);
    pointView.setLookAt(position, pointTarget, pointUp);
    face.viewProj.multiplyMatrices(pointProjection, pointView);
  }
  out.near = near;
  out.far = range;
  out.texelSize = 1 / resolution;
  // tan(45°) = 1: a 90° face spans two world units per light-space unit at clip.w distance.
  out.worldTexelScale = 2 / resolution;
  return true;
}
