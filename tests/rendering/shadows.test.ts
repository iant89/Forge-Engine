/**
 * @suite rendering:shadows
 * @group unit
 * @covers engine/src/index.ts
 * @covers engine/src/math/mat.ts
 * @covers engine/src/math/vec.ts
 * @covers engine/src/rendering/shadows.ts
 * @covers engine/src/rendering/shadowBudget.ts
 * @desc Cascaded-shadow-map fitting (engine/src/rendering/shadows.ts), pure math — no GPU
 */

export const suite = {
  name: "rendering:shadows",
  group: "unit",
  covers:   [
    "engine/src/index.ts",
    "engine/src/math/mat.ts",
    "engine/src/math/vec.ts",
    "engine/src/rendering/shadows.ts",
    "engine/src/rendering/shadowBudget.ts"
  ],
  desc: "Cascaded-shadow-map fitting (engine/src/rendering/shadows.ts), pure math — no GPU",
};
/**
 * Cascaded-shadow-map fitting (engine/src/rendering/shadows.ts), pure math — no GPU.
 *
 * What these prove: the practical split scheme is monotone and ends exactly at the shadow distance;
 * every corner of every frustum slice lands inside its cascade's light-space box (so nothing in view
 * can fall outside the map it is looked up in); texel snapping holds the shadow-map grid still under
 * camera translation; degenerate light directions and orthographic cameras do not produce NaNs.
 */

import assert from "node:assert/strict";
import { assertCloseTo, finish, group, test } from "selrun";
import { computeCascadeSplits, computeCascades, computeSpotShadow, computePointShadow, createPointShadowFaces, shadowLightPriority, fitShadowMapSize, shadowAtlasBytes, DEFAULT_SHADOW_MEMORY_BUDGET, frustumSliceCorners, Mat4, Quat, Vec3, type CascadeCameraParams, type PointShadowFit, type SpotShadowFit } from "@forge/engine";

const corners = new Float32Array(24);

function perspectiveCamera(position: Vec3, target: Vec3): CascadeCameraParams {
  // The camera world matrix is the inverse of a view matrix looking from `position` at `target`.
  const view = new Mat4().setLookAt(position, target, new Vec3(0, 1, 0));
  const world = view.clone();
  assert.equal(world.invert(), true);
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

group("cascade splits", () => {
  test("interpolates between uniform (lambda 0) and logarithmic (lambda 1) schemes", () => {
    const uniform = computeCascadeSplits(0.1, 100, 3, 0);
    assertCloseTo(uniform[0], 0.1 + 99.9 / 3, 6);
    assertCloseTo(uniform[1], 0.1 + (99.9 * 2) / 3, 6);
    assert.equal(uniform[2], 100);
    const log = computeCascadeSplits(0.1, 100, 3, 1);
    assertCloseTo(log[0], 1, 6);
    assertCloseTo(log[1], 10, 6);
    assert.equal(log[2], 100);
    const mixed = computeCascadeSplits(0.1, 100, 3, 0.5);
    assertCloseTo(mixed[0], (uniform[0]! + log[0]!) / 2, 6);
  });

  test("is strictly increasing and ends at the shadow distance for every count", () => {
    for (const count of [1, 2, 3, 4]) {
      for (const lambda of [0, 0.3, 0.6, 1]) {
        const s = computeCascadeSplits(0.5, 160, count, lambda);
        assert.equal((s).length, count);
        for (let i = 1; i < count; i++) assert.ok(s[i]! > s[i - 1]!);
        assert.equal(s[count - 1], 160);
        assert.ok(s[0]! > 0.5);
      }
    }
  });
});

group("cascade fitting", () => {
  const light = new Vec3(-0.4, -0.8, 0.45).normalize();

  test("contains every frustum-slice corner inside its cascade's light-space box", () => {
    const camera = perspectiveCamera(new Vec3(3, 4, -12), new Vec3(0, 1, 2));
    const cascades = computeCascades(camera, { count: 4, shadowDistance: 80, lambda: 0.6, mapSize: 1024, lightDirection: light });
    assert.equal((cascades).length, 4);
    let previousFar = camera.near;
    for (const cascade of cascades) {
      assert.equal(cascade.near, previousFar);
      assert.ok(cascade.far > cascade.near);
      previousFar = cascade.far;
      frustumSliceCorners(camera, cascade.near, cascade.far, corners);
      for (let i = 0; i < 8; i++) {
        const p = project(cascade.viewProj, corners[i * 3]!, corners[i * 3 + 1]!, corners[i * 3 + 2]!);
        assert.ok(Math.abs(p.x) <= 1, `cascade ${cascade.near}-${cascade.far} corner ${i} x`);
        assert.ok(Math.abs(p.y) <= 1, `corner ${i} y`);
        assert.ok(p.z >= 0, `corner ${i} z`);
        assert.ok(p.z <= 1, `corner ${i} z`);
      }
      // The centre of the sphere projects to the middle of the map, and one texel is 2r / size.
      const c = project(cascade.viewProj, cascade.center.x, cascade.center.y, cascade.center.z);
      assert.ok(Math.abs(c.x) < 1e-4);
      assert.ok(Math.abs(c.y) < 1e-4);
      assertCloseTo(cascade.texelWorld, (2 * cascade.radius) / 1024, 9);
    }
    assert.equal(cascades[3]!.far, 80);
    // Later cascades cover more world per texel (that is the whole point of cascading).
    for (let i = 1; i < 4; i++) assert.ok(cascades[i]!.texelWorld > cascades[i - 1]!.texelWorld);
  });

  test("leaves room in front of the sphere for casters between the light and the slice", () => {
    const camera = perspectiveCamera(new Vec3(0, 2, -6), new Vec3(0, 1, 0));
    const [cascade] = computeCascades(camera, { count: 1, shadowDistance: 40, lambda: 0.5, mapSize: 512, lightDirection: light });
    const r = cascade!.radius;
    // A caster 2.5 radii toward the light is still inside the box; one 5 radii away is not.
    const inside = new Vec3().copyFrom(cascade!.center).addScaled(light, -2.5 * r);
    const outside = new Vec3().copyFrom(cascade!.center).addScaled(light, -5 * r);
    assert.ok(project(cascade!.viewProj, inside.x, inside.y, inside.z).z >= 0);
    assert.ok(project(cascade!.viewProj, outside.x, outside.y, outside.z).z < 0);
  });

  test("snaps the light-space origin to whole texels so a translating camera does not shift the grid", () => {
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
    assertCloseTo(a.radius, b.radius, 9); // same slice shape → same texel size
    const frac = (x: number) => x - Math.floor(x);
    const wrapDiff = (x: number, y: number) => Math.min(Math.abs(frac(x) - frac(y)), 1 - Math.abs(frac(x) - frac(y)));
    // The probe lands on the same sub-texel phase regardless of how the camera moved.
    assert.ok(wrapDiff(a.u, b.u) < 1e-3);
    assert.ok(wrapDiff(a.v, b.v) < 1e-3);
    assert.ok(wrapDiff(a.u, c.u) < 1e-3);
    assert.ok(wrapDiff(a.v, c.v) < 1e-3);
  });

  test("handles a vertical light and an orthographic camera without degenerate matrices", () => {
    const down = new Vec3(0, -1, 0);
    const camera = perspectiveCamera(new Vec3(0, 5, -10), new Vec3(0, 0, 0));
    const [vertical] = computeCascades(camera, { count: 1, shadowDistance: 50, lambda: 0.6, mapSize: 256, lightDirection: down });
    assert.equal(Array.from(vertical!.viewProj.m).every(Number.isFinite), true);
    frustumSliceCorners(camera, vertical!.near, vertical!.far, corners);
    for (let i = 0; i < 8; i++) {
      const p = project(vertical!.viewProj, corners[i * 3]!, corners[i * 3 + 1]!, corners[i * 3 + 2]!);
      assert.ok(Math.abs(p.x) <= 1);
      assert.ok(Math.abs(p.y) <= 1);
    }

    const rotation = new Quat().setAxisAngle(new Vec3(1, 0, 0), Math.PI / 2); // look straight down
    const world = Mat4.compose(new Vec3(0, 30, 0), rotation, new Vec3(1, 1, 1));
    const ortho: CascadeCameraParams = { world, fovY: 1, aspect: 1.5, near: 0.1, orthographic: true, orthoHeight: 20 };
    const cascades = computeCascades(ortho, { count: 2, shadowDistance: 60, lambda: 0.5, mapSize: 512, lightDirection: light });
    for (const cascade of cascades) {
      assert.equal(Array.from(cascade.viewProj.m).every(Number.isFinite), true);
      frustumSliceCorners(ortho, cascade.near, cascade.far, corners);
      for (let i = 0; i < 8; i++) {
        const p = project(cascade.viewProj, corners[i * 3]!, corners[i * 3 + 1]!, corners[i * 3 + 2]!);
        assert.ok(Math.abs(p.x) <= 1);
        assert.ok(Math.abs(p.y) <= 1);
        assert.ok(p.z >= 0);
        assert.ok(p.z <= 1);
      }
    }
  });

  test("reuses the output array without allocating new cascades", () => {
    const camera = perspectiveCamera(new Vec3(0, 2, -5), new Vec3(0, 0, 0));
    const out = computeCascades(camera, { count: 3, shadowDistance: 40, lambda: 0.6, mapSize: 512, lightDirection: light });
    const identities = out.map((c) => c.viewProj);
    computeCascades(camera, { count: 3, shadowDistance: 40, lambda: 0.6, mapSize: 512, lightDirection: light }, out);
    assert.deepEqual(out.map((c) => c.viewProj), identities);
    computeCascades(camera, { count: 2, shadowDistance: 40, lambda: 0.6, mapSize: 512, lightDirection: light }, out);
    assert.equal((out).length, 2);
  });
});

group("shadow-light priority", () => {
  test("ranks brightness and local influence area instead of scene order", () => {
    const color = { x: 1, y: 0.5, z: 0.25 };
    assert.equal(shadowLightPriority({ kind: "directional", intensity: 3, range: 0, color }), 3);
    assert.equal(shadowLightPriority({ kind: "spot", intensity: 2, range: 10, color }), 200);
    assert.ok(
      shadowLightPriority({ kind: "point", intensity: 1, range: 20, color }) >
      shadowLightPriority({ kind: "point", intensity: 8, range: 5, color }),
    );
    assert.equal(shadowLightPriority({ kind: "point", intensity: Number.NaN, range: 10, color }), 0);
    assert.equal(shadowLightPriority({ kind: "point", intensity: 1, range: -10, color }), 0);
  });
});

group("spot-shadow fitting", () => {
  function output(): SpotShadowFit {
    return { viewProj: new Mat4(), fovY: 0, near: 0, far: 0, texelSize: 0, worldTexelScale: 0 };
  }

  test("fits the perspective cone and finite range into WebGPU clip space", () => {
    const position = new Vec3(2, 5, -3);
    const direction = new Vec3(0.4, -0.7, 0.2).normalize();
    const fit = output();
    assert.equal(computeSpotShadow(position, direction, 0.8, 16, 1024, fit), true);
    assertCloseTo(fit.fovY, 2 * Math.acos(0.8), 12);
    assert.ok(fit.near > 0);
    assert.ok(fit.near < fit.far);
    assert.equal(fit.far, 16);
    assert.equal(fit.texelSize, 1 / 1024);
    assertCloseTo(fit.worldTexelScale, 2 * Math.tan(fit.fovY / 2) / 1024, 12);
    assert.equal(Array.from(fit.viewProj.m).every(Number.isFinite), true);

    const forward = direction.clone().normalize();
    const worldUp = Math.abs(forward.y) > 0.99 ? new Vec3(0, 0, 1) : new Vec3(0, 1, 0);
    const right = worldUp.clone().cross(forward).normalize();
    const up = forward.clone().cross(right).normalize();
    const depth = 8;
    const half = depth * Math.tan(fit.fovY / 2) * 0.8;
    const receiver = position.clone().addScaled(forward, depth).addScaled(right, half).addScaled(up, -half);
    const p = project(fit.viewProj, receiver.x, receiver.y, receiver.z);
    assert.ok(Math.abs(p.x) < 0.81);
    assert.ok(Math.abs(p.y) < 0.81);
    assert.ok(p.z > 0);
    assert.ok(p.z < 1);

    const beyondRange = position.clone().addScaled(forward, 17);
    assert.ok(project(fit.viewProj, beyondRange.x, beyondRange.y, beyondRange.z).z > 1);
  });

  test("keeps vertical spot directions finite and rejects degenerate inputs", () => {
    const fit = output();
    assert.equal(computeSpotShadow(new Vec3(0, 4, 0), new Vec3(0, 1, 0), 0.5, 20, 512, fit), true);
    assert.equal(Array.from(fit.viewProj.m).every(Number.isFinite), true);
    assert.equal(computeSpotShadow(new Vec3(), new Vec3(), 0.5, 20, 512, fit), false);
    assert.equal(computeSpotShadow(new Vec3(), new Vec3(0, -1, 0), 0.5, 0, 512, fit), false);
    assert.equal(computeSpotShadow(new Vec3(), new Vec3(0, -1, 0), 0.5, 20, 0, fit), false);
  });

  test("reuses the supplied fit and clamps the outer cosine to a valid projection", () => {
    const fit = output();
    const matrix = fit.viewProj;
    assert.equal(computeSpotShadow(new Vec3(1, 2, 3), new Vec3(0, 0, 2), -2, 12, 256, fit), true);
    assert.equal(fit.viewProj, matrix);
    assert.ok(fit.fovY < Math.PI);
    assert.ok(fit.fovY > 0);
    assert.equal(Array.from(matrix.m).every(Number.isFinite), true);
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

group("point-shadow fitting", () => {
  function output(): PointShadowFit {
    return { faces: createPointShadowFaces(), near: 0, far: 0, texelSize: 0, worldTexelScale: 0 };
  }

  test("fits six 90-degree faces around the light with the range as the far plane", () => {
    const position = new Vec3(-3, 4, 2);
    const fit = output();
    assert.equal(computePointShadow(position, 12, 512, fit), true);
    assert.equal((fit.faces).length, 6);
    assert.ok(fit.near > 0);
    assert.ok(fit.near < fit.far);
    assert.equal(fit.far, 12);
    assert.equal(fit.texelSize, 1 / 512);
    // The face includes a two-texel guard band beyond the nominal 90-degree cube face.
    assertCloseTo(fit.worldTexelScale, (2 * (1 + 2 / 512)) / 512, 12);
    for (const face of fit.faces) {
      assert.equal(Array.from(face.viewProj.m).every(Number.isFinite), true);
    }

    // Each face looks down its own axis: a point on the axis lands in the map's centre, at a depth
    // proportional to its distance, and beyond the range it falls off the far plane.
    for (let f = 0; f < 6; f++) {
      const axis = FACE_AXES[f]!;
      assert.equal(fit.faces[f]!.axis.x, axis.x);
      assert.equal(fit.faces[f]!.axis.y, axis.y);
      assert.equal(fit.faces[f]!.axis.z, axis.z);
      const mid = position.clone().addScaled(axis, 6);
      const p = project(fit.faces[f]!.viewProj, mid.x, mid.y, mid.z);
      assert.ok(Math.abs(p.x) < 1e-5);
      assert.ok(Math.abs(p.y) < 1e-5);
      assert.ok(p.z > 0);
      assert.ok(p.z < 1);
      const atRange = position.clone().addScaled(axis, 12);
      assertCloseTo(project(fit.faces[f]!.viewProj, atRange.x, atRange.y, atRange.z).z, 1, 6);
      const beyond = position.clone().addScaled(axis, 13);
      assert.ok(project(fit.faces[f]!.viewProj, beyond.x, beyond.y, beyond.z).z > 1);
    }
  });

  test("covers every direction of the influence sphere with the dominant face", () => {
    const position = new Vec3(1, 2, -1);
    const range = 8;
    const fit = output();
    assert.equal(computePointShadow(position, range, 256, fit), true);

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
      assert.ok(Math.abs(p.x) <= 1 + 1e-6, `face ${face}`);
      assert.ok(Math.abs(p.y) <= 1 + 1e-6, `face ${face}`);
      assert.ok(p.z > 0, `face ${face}`);
      assert.ok(p.z <= 1, `face ${face}`);
    }
  });

  test("keeps cube-boundary receivers inside a one-texel PCF guard band", () => {
    const fit = output();
    const resolution = 256;
    assert.equal(computePointShadow(new Vec3(), 20, resolution, fit), true);
    // +X/+Z is exactly the dominant-face boundary. It must project inside both overlapping faces,
    // leaving enough UV margin for a one-texel PCF tap on either side.
    const receiver = new Vec3(5, 0, 5);
    for (const face of [0, 4]) {
      const p = project(fit.faces[face]!.viewProj, receiver.x, receiver.y, receiver.z);
      const uvMargin = (1 - Math.abs(p.x)) * 0.5;
      assert.ok(uvMargin >= 0.9 / resolution, `face ${face} margin ${uvMargin}`);
    }
  });

  test("rejects degenerate positions, ranges and resolutions", () => {
    const fit = output();
    assert.equal(computePointShadow(new Vec3(NaN, 0, 0), 10, 512, fit), false);
    assert.equal(computePointShadow(new Vec3(0, 0, 0), 0, 512, fit), false);
    assert.equal(computePointShadow(new Vec3(0, 0, 0), 1e-5, 512, fit), false);
    assert.equal(computePointShadow(new Vec3(0, 0, 0), 10, 0, fit), false);
    assert.equal(computePointShadow(new Vec3(0, 0, 0), NaN, 512, fit), false);
  });

  test("reuses the supplied fit across frames", () => {
    const fit = output();
    const faces = fit.faces;
    assert.equal(computePointShadow(new Vec3(0, 3, 0), 10, 256, fit), true);
    assert.equal(fit.faces, faces);
    assert.equal(computePointShadow(new Vec3(5, 1, 2), 4, 512, fit), true);
    assert.equal(fit.faces, faces);
    assert.equal(fit.far, 4);
  });
});

group("shadow atlas memory budget", () => {
  test("halves layer resolution until the complete atlas fits", () => {
    assert.equal(fitShadowMapSize(2048, 20), 1024);
    assert.ok(shadowAtlasBytes(1024, 20) <= DEFAULT_SHADOW_MEMORY_BUDGET);
    assert.ok(shadowAtlasBytes(2048, 20) > DEFAULT_SHADOW_MEMORY_BUDGET);
    assert.equal(fitShadowMapSize(2048, 4), 2048);
  });

  test("honours custom budgets and a stable minimum", () => {
    assert.equal(fitShadowMapSize(1024, 6, 8 * 1024 * 1024, 128), 512);
    assert.equal(fitShadowMapSize(512, 1000, 1, 128), 128);
    assert.equal(fitShadowMapSize(1024, 0, 1), 1024);
  });
});

await finish();
