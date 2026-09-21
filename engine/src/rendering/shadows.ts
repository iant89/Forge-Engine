/**
 * Cascaded shadow map fitting (docs/RENDERING.md §4).
 *
 * Pure math, no GPU: the renderer feeds it the camera and the light direction and gets back one
 * orthographic light view-projection per cascade plus the numbers the shader needs to pick and
 * bias a cascade. Kept separate so the tests can pin the properties that matter without a device:
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
