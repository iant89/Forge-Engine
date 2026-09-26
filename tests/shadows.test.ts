/**
 * Cascaded-shadow-map fitting (engine/src/rendering/shadows.ts), pure math — no GPU.
 *
 * What these prove: the practical split scheme is monotone and ends exactly at the shadow distance;
 * every corner of every frustum slice lands inside its cascade's light-space box (so nothing in view
 * can fall outside the map it is looked up in); texel snapping holds the shadow-map grid still under
 * camera translation; degenerate light directions and orthographic cameras do not produce NaNs.
 */

import { describe, expect, it } from "vitest";
import { computeCascadeSplits, computeCascades, computeSpotShadow, computePointShadow, createPointShadowFaces, frustumSliceCorners, Mat4, Quat, Vec3, type CascadeCameraParams, type PointShadowFit, type SpotShadowFit } from "@forge/engine";

const corners = new Float32Array(24);

function perspectiveCamera(position: Vec3, target: Vec3): CascadeCameraParams {
  // The camera world matrix is the inverse of a view matrix looking from `position` at `target`.
  const view = new Mat4().setLookAt(position, target, new Vec3(0, 1, 0));
  const world = view.clone();
  expect(world.invert()).toBe(true);
  return { world, fovY: Math.PI / 3, aspect: 16 / 9, near: 0.1, orthographic: false, orthoHeight: 10 };
}

/** Clip-space position of a render-local point under `viewProj` (after the perspective divide). */
function project(viewProj: Mat4, x: number, y: number, z: number): Vec3 {
  const m = viewProj.m;
  const cx = m[0]! * x + m[4]! * y + m[8]! * z + m[12]!;
  const cy = m[1]! * x + m[5]! * y + m[9]! * z + m[13]!;
  const cz = m[2]! * x + m[6]! * y + m[10]! * z + m[14]!;
  const cw = m[3]! * x + m[7]! * y + m[11]! * z + m[15]!;
  return new Vec3(cx / cw, cy / cw, cz / cw);
}

describe("cascade splits", () => {
  it("interpolates between uniform (lambda 0) and logarithmic (lambda 1) schemes", () => {
    const uniform = computeCascadeSplits(0.1, 100, 3, 0);
    expect(uniform[0]).toBeCloseTo(0.1 + 99.9 / 3, 6);
    expect(uniform[1]).toBeCloseTo(0.1 + (99.9 * 2) / 3, 6);
    expect(uniform[2]).toBe(100);
    const log = computeCascadeSplits(0.1, 100, 3, 1);
    expect(log[0]).toBeCloseTo(1, 6);
    expect(log[1]).toBeCloseTo(10, 6);
    expect(log[2]).toBe(100);
    const mixed = computeCascadeSplits(0.1, 100, 3, 0.5);
    expect(mixed[0]).toBeCloseTo((uniform[0]! + log[0]!) / 2, 6);
  });

  it("is strictly increasing and ends at the shadow distance for every count", () => {
    for (const count of [1, 2, 3, 4]) {
      for (const lambda of [0, 0.3, 0.6, 1]) {
        const s = computeCascadeSplits(0.5, 160, count, lambda);
        expect(s).toHaveLength(count);
        for (let i = 1; i < count; i++) expect(s[i]!).toBeGreaterThan(s[i - 1]!);
        expect(s[count - 1]).toBe(160);
        expect(s[0]!).toBeGreaterThan(0.5);
      }
    }
  });
});

describe("cascade fitting", () => {
  const light = new Vec3(-0.4, -0.8, 0.45).normalize();

  it("contains every frustum-slice corner inside its cascade's light-space box", () => {
    const camera = perspectiveCamera(new Vec3(3, 4, -12), new Vec3(0, 1, 2));
    const cascades = computeCascades(camera, { count: 4, shadowDistance: 80, lambda: 0.6, mapSize: 1024, lightDirection: light });
    expect(cascades).toHaveLength(4);
    let previousFar = camera.near;
    for (const cascade of cascades) {
      expect(cascade.near).toBe(previousFar);
      expect(cascade.far).toBeGreaterThan(cascade.near);
      previousFar = cascade.far;
      frustumSliceCorners(camera, cascade.near, cascade.far, corners);
      for (let i = 0; i < 8; i++) {
        const p = project(cascade.viewProj, corners[i * 3]!, corners[i * 3 + 1]!, corners[i * 3 + 2]!);
        expect(Math.abs(p.x), `cascade ${cascade.near}-${cascade.far} corner ${i} x`).toBeLessThanOrEqual(1);
        expect(Math.abs(p.y), `corner ${i} y`).toBeLessThanOrEqual(1);
        expect(p.z, `corner ${i} z`).toBeGreaterThanOrEqual(0);
        expect(p.z, `corner ${i} z`).toBeLessThanOrEqual(1);
      }
      // The centre of the sphere projects to the middle of the map, and one texel is 2r / size.
      const c = project(cascade.viewProj, cascade.center.x, cascade.center.y, cascade.center.z);
      expect(Math.abs(c.x)).toBeLessThan(1e-4);
      expect(Math.abs(c.y)).toBeLessThan(1e-4);
      expect(cascade.texelWorld).toBeCloseTo((2 * cascade.radius) / 1024, 9);
    }
    expect(cascades[3]!.far).toBe(80);
    // Later cascades cover more world per texel (that is the whole point of cascading).
    for (let i = 1; i < 4; i++) expect(cascades[i]!.texelWorld).toBeGreaterThan(cascades[i - 1]!.texelWorld);
  });

  it("leaves room in front of the sphere for casters between the light and the slice", () => {
    const camera = perspectiveCamera(new Vec3(0, 2, -6), new Vec3(0, 1, 0));
    const [cascade] = computeCascades(camera, { count: 1, shadowDistance: 40, lambda: 0.5, mapSize: 512, lightDirection: light });
    const r = cascade!.radius;
    // A caster 2.5 radii toward the light is still inside the box; one 5 radii away is not.
    const inside = new Vec3().copyFrom(cascade!.center).addScaled(light, -2.5 * r);
    const outside = new Vec3().copyFrom(cascade!.center).addScaled(light, -5 * r);
    expect(project(cascade!.viewProj, inside.x, inside.y, inside.z).z).toBeGreaterThanOrEqual(0);
    expect(project(cascade!.viewProj, outside.x, outside.y, outside.z).z).toBeLessThan(0);
  });

  it("snaps the light-space origin to whole texels so a translating camera does not shift the grid", () => {
    const probe = new Vec3(1.5, 0.25, 4); // a fixed receiver in the world
    const size = 1024;
    const texelCoord = (camPos: Vec3) => {
      const camera = perspectiveCamera(camPos, new Vec3(camPos.x, camPos.y - 1, camPos.z + 10));
      const [cascade] = computeCascades(camera, { count: 1, shadowDistance: 30, lambda: 0.5, mapSize: size, lightDirection: light });
      const p = project(cascade!.viewProj, probe.x, probe.y, probe.z);
      return { u: (p.x * 0.5 + 0.5) * size, v: (p.y * -0.5 + 0.5) * size, radius: cascade!.radius };
    };
    const a = texelCoord(new Vec3(0, 3, -8));
    const b = texelCoord(new Vec3(0.013, 3.007, -7.991)); // a sub-texel camera move
    const c = texelCoord(new Vec3(0.7, 3.2, -6.4)); // a multi-texel camera move
    expect(a.radius).toBeCloseTo(b.radius, 9); // same slice shape → same texel size
    const frac = (x: number) => x - Math.floor(x);
    const wrapDiff = (x: number, y: number) => Math.min(Math.abs(frac(x) - frac(y)), 1 - Math.abs(frac(x) - frac(y)));
    // The probe lands on the same sub-texel phase regardless of how the camera moved.
    expect(wrapDiff(a.u, b.u)).toBeLessThan(1e-3);
    expect(wrapDiff(a.v, b.v)).toBeLessThan(1e-3);
    expect(wrapDiff(a.u, c.u)).toBeLessThan(1e-3);
    expect(wrapDiff(a.v, c.v)).toBeLessThan(1e-3);
  });

  it("handles a vertical light and an orthographic camera without degenerate matrices", () => {
    const down = new Vec3(0, -1, 0);
    const camera = perspectiveCamera(new Vec3(0, 5, -10), new Vec3(0, 0, 0));
    const [vertical] = computeCascades(camera, { count: 1, shadowDistance: 50, lambda: 0.6, mapSize: 256, lightDirection: down });
    expect(Array.from(vertical!.viewProj.m).every(Number.isFinite)).toBe(true);
    frustumSliceCorners(camera, vertical!.near, vertical!.far, corners);
    for (let i = 0; i < 8; i++) {
      const p = project(vertical!.viewProj, corners[i * 3]!, corners[i * 3 + 1]!, corners[i * 3 + 2]!);
      expect(Math.abs(p.x)).toBeLessThanOrEqual(1);
      expect(Math.abs(p.y)).toBeLessThanOrEqual(1);
    }

    const rotation = new Quat().setAxisAngle(new Vec3(1, 0, 0), Math.PI / 2); // look straight down
    const world = Mat4.compose(new Vec3(0, 30, 0), rotation, new Vec3(1, 1, 1));
    const ortho: CascadeCameraParams = { world, fovY: 1, aspect: 1.5, near: 0.1, orthographic: true, orthoHeight: 20 };
    const cascades = computeCascades(ortho, { count: 2, shadowDistance: 60, lambda: 0.5, mapSize: 512, lightDirection: light });
    for (const cascade of cascades) {
      expect(Array.from(cascade.viewProj.m).every(Number.isFinite)).toBe(true);
      frustumSliceCorners(ortho, cascade.near, cascade.far, corners);
      for (let i = 0; i < 8; i++) {
        const p = project(cascade.viewProj, corners[i * 3]!, corners[i * 3 + 1]!, corners[i * 3 + 2]!);
        expect(Math.abs(p.x)).toBeLessThanOrEqual(1);
        expect(Math.abs(p.y)).toBeLessThanOrEqual(1);
        expect(p.z).toBeGreaterThanOrEqual(0);
        expect(p.z).toBeLessThanOrEqual(1);
      }
    }
  });

  it("reuses the output array without allocating new cascades", () => {
    const camera = perspectiveCamera(new Vec3(0, 2, -5), new Vec3(0, 0, 0));
    const out = computeCascades(camera, { count: 3, shadowDistance: 40, lambda: 0.6, mapSize: 512, lightDirection: light });
    const identities = out.map((c) => c.viewProj);
    computeCascades(camera, { count: 3, shadowDistance: 40, lambda: 0.6, mapSize: 512, lightDirection: light }, out);
    expect(out.map((c) => c.viewProj)).toEqual(identities);
    computeCascades(camera, { count: 2, shadowDistance: 40, lambda: 0.6, mapSize: 512, lightDirection: light }, out);
    expect(out).toHaveLength(2);
  });
});

describe("spot-shadow fitting", () => {
  function output(): SpotShadowFit {
    return { viewProj: new Mat4(), fovY: 0, near: 0, far: 0, texelSize: 0, worldTexelScale: 0 };
  }

  it("fits the perspective cone and finite range into WebGPU clip space", () => {
    const position = new Vec3(2, 5, -3);
    const direction = new Vec3(0.4, -0.7, 0.2).normalize();
    const fit = output();
    expect(computeSpotShadow(position, direction, 0.8, 16, 1024, fit)).toBe(true);
    expect(fit.fovY).toBeCloseTo(2 * Math.acos(0.8), 12);
    expect(fit.near).toBeGreaterThan(0);
    expect(fit.near).toBeLessThan(fit.far);
    expect(fit.far).toBe(16);
    expect(fit.texelSize).toBe(1 / 1024);
    expect(fit.worldTexelScale).toBeCloseTo(2 * Math.tan(fit.fovY / 2) / 1024, 12);
    expect(Array.from(fit.viewProj.m).every(Number.isFinite)).toBe(true);

    const forward = direction.clone().normalize();
    const worldUp = Math.abs(forward.y) > 0.99 ? new Vec3(0, 0, 1) : new Vec3(0, 1, 0);
    const right = worldUp.clone().cross(forward).normalize();
    const up = forward.clone().cross(right).normalize();
    const depth = 8;
    const half = depth * Math.tan(fit.fovY / 2) * 0.8;
    const receiver = position.clone().addScaled(forward, depth).addScaled(right, half).addScaled(up, -half);
    const p = project(fit.viewProj, receiver.x, receiver.y, receiver.z);
    expect(Math.abs(p.x)).toBeLessThan(0.81);
    expect(Math.abs(p.y)).toBeLessThan(0.81);
    expect(p.z).toBeGreaterThan(0);
    expect(p.z).toBeLessThan(1);

    const beyondRange = position.clone().addScaled(forward, 17);
    expect(project(fit.viewProj, beyondRange.x, beyondRange.y, beyondRange.z).z).toBeGreaterThan(1);
  });

  it("keeps vertical spot directions finite and rejects degenerate inputs", () => {
    const fit = output();
    expect(computeSpotShadow(new Vec3(0, 4, 0), new Vec3(0, 1, 0), 0.5, 20, 512, fit)).toBe(true);
    expect(Array.from(fit.viewProj.m).every(Number.isFinite)).toBe(true);
    expect(computeSpotShadow(new Vec3(), new Vec3(), 0.5, 20, 512, fit)).toBe(false);
    expect(computeSpotShadow(new Vec3(), new Vec3(0, -1, 0), 0.5, 0, 512, fit)).toBe(false);
    expect(computeSpotShadow(new Vec3(), new Vec3(0, -1, 0), 0.5, 20, 0, fit)).toBe(false);
  });

  it("reuses the supplied fit and clamps the outer cosine to a valid projection", () => {
    const fit = output();
    const matrix = fit.viewProj;
    expect(computeSpotShadow(new Vec3(1, 2, 3), new Vec3(0, 0, 2), -2, 12, 256, fit)).toBe(true);
    expect(fit.viewProj).toBe(matrix);
    expect(fit.fovY).toBeLessThan(Math.PI);
    expect(fit.fovY).toBeGreaterThan(0);
    expect(Array.from(matrix.m).every(Number.isFinite)).toBe(true);
  });
});

/** Face order the renderer, shader and these tests agree on: +x -x +y -y +z -z. */
const FACE_AXES = [
  new Vec3(1, 0, 0),
  new Vec3(-1, 0, 0),
  new Vec3(0, 1, 0),
  new Vec3(0, -1, 0),
  new Vec3(0, 0, 1),
  new Vec3(0, 0, -1),
];

describe("point-shadow fitting", () => {
  function output(): PointShadowFit {
    return { faces: createPointShadowFaces(), near: 0, far: 0, texelSize: 0, worldTexelScale: 0 };
  }

  it("fits six 90-degree faces around the light with the range as the far plane", () => {
    const position = new Vec3(-3, 4, 2);
    const fit = output();
    expect(computePointShadow(position, 12, 512, fit)).toBe(true);
    expect(fit.faces).toHaveLength(6);
    expect(fit.near).toBeGreaterThan(0);
    expect(fit.near).toBeLessThan(fit.far);
    expect(fit.far).toBe(12);
    expect(fit.texelSize).toBe(1 / 512);
    // tan(45°) = 1, so one texel spans 2/512 world units per light-space unit.
    expect(fit.worldTexelScale).toBeCloseTo(2 / 512, 12);
    for (const face of fit.faces) {
      expect(Array.from(face.viewProj.m).every(Number.isFinite)).toBe(true);
    }

    // Each face looks down its own axis: a point on the axis lands in the map's centre, at a depth
    // proportional to its distance, and beyond the range it falls off the far plane.
    for (let f = 0; f < 6; f++) {
      const axis = FACE_AXES[f]!;
      expect(fit.faces[f]!.axis.x).toBe(axis.x);
      expect(fit.faces[f]!.axis.y).toBe(axis.y);
      expect(fit.faces[f]!.axis.z).toBe(axis.z);
      const mid = position.clone().addScaled(axis, 6);
      const p = project(fit.faces[f]!.viewProj, mid.x, mid.y, mid.z);
      expect(Math.abs(p.x)).toBeLessThan(1e-5);
      expect(Math.abs(p.y)).toBeLessThan(1e-5);
      expect(p.z).toBeGreaterThan(0);
      expect(p.z).toBeLessThan(1);
      const atRange = position.clone().addScaled(axis, 12);
      expect(project(fit.faces[f]!.viewProj, atRange.x, atRange.y, atRange.z).z).toBeCloseTo(1, 6);
      const beyond = position.clone().addScaled(axis, 13);
      expect(project(fit.faces[f]!.viewProj, beyond.x, beyond.y, beyond.z).z).toBeGreaterThan(1);
    }
  });

  it("covers every direction of the influence sphere with the dominant face", () => {
    const position = new Vec3(1, 2, -1);
    const range = 8;
    const fit = output();
    expect(computePointShadow(position, range, 256, fit)).toBe(true);

    // Deterministic directions in every octant: every receiver inside the sphere projects inside
    // the clip box of the face the shader would pick (dominant axis), whatever its direction.
    let seed = 42;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    for (let i = 0; i < 256; i++) {
      const dir = new Vec3(rand() * 2 - 1, rand() * 2 - 1, rand() * 2 - 1);
      if (dir.length() < 1e-3) continue;
      dir.normalize();
      const depth = 0.5 + rand() * (range - 0.6);
      const receiver = position.clone().addScaled(dir, depth);
      const ax = Math.abs(dir.x);
      const ay = Math.abs(dir.y);
      const az = Math.abs(dir.z);
      let face = 4;
      if (ax >= ay && ax >= az) face = dir.x > 0 ? 0 : 1;
      else if (ay >= az) face = dir.y > 0 ? 2 : 3;
      else face = dir.z > 0 ? 4 : 5;
      const p = project(fit.faces[face]!.viewProj, receiver.x, receiver.y, receiver.z);
      expect(Math.abs(p.x), `face ${face}`).toBeLessThanOrEqual(1 + 1e-6);
      expect(Math.abs(p.y), `face ${face}`).toBeLessThanOrEqual(1 + 1e-6);
      expect(p.z, `face ${face}`).toBeGreaterThan(0);
      expect(p.z, `face ${face}`).toBeLessThanOrEqual(1);
    }
  });

  it("rejects degenerate positions, ranges and resolutions", () => {
    const fit = output();
    expect(computePointShadow(new Vec3(NaN, 0, 0), 10, 512, fit)).toBe(false);
    expect(computePointShadow(new Vec3(0, 0, 0), 0, 512, fit)).toBe(false);
    expect(computePointShadow(new Vec3(0, 0, 0), 1e-5, 512, fit)).toBe(false);
    expect(computePointShadow(new Vec3(0, 0, 0), 10, 0, fit)).toBe(false);
    expect(computePointShadow(new Vec3(0, 0, 0), NaN, 512, fit)).toBe(false);
  });

  it("reuses the supplied fit across frames", () => {
    const fit = output();
    const faces = fit.faces;
    expect(computePointShadow(new Vec3(0, 3, 0), 10, 256, fit)).toBe(true);
    expect(fit.faces).toBe(faces);
    expect(computePointShadow(new Vec3(5, 1, 2), 4, 512, fit)).toBe(true);
    expect(fit.faces).toBe(faces);
    expect(fit.far).toBe(4);
  });
});
