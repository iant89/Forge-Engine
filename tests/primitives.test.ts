import { describe, expect, it } from "vitest";
import {
  boxGeometrySource,
  sphereGeometrySource,
  cylinderGeometrySource,
  planeGeometrySource,
  torusGeometrySource,
  coneGeometrySource,
  Mat4,
  Vec3,
} from "@forge/engine";

function analyzeGeometry(geo: ReturnType<typeof boxGeometrySource>, name: string) {
  const p = geo.positions;
  const n = geo.normals!;
  const idx = geo.indices!;
  let outward = 0;
  let inward = 0;
  let zero = 0;

  for (let t = 0; t < idx.length; t += 3) {
    const i0 = idx[t]!;
    const i1 = idx[t + 1]!;
    const i2 = idx[t + 2]!;

    const p0 = [p[i0 * 3]!, p[i0 * 3 + 1]!, p[i0 * 3 + 2]!];
    const p1 = [p[i1 * 3]!, p[i1 * 3 + 1]!, p[i1 * 3 + 2]!];
    const p2 = [p[i2 * 3]!, p[i2 * 3 + 1]!, p[i2 * 3 + 2]!];

    // e1 = p1 - p0, e2 = p2 - p0
    const e1 = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]];
    const e2 = [p2[0] - p0[0], p2[1] - p0[1], p2[2] - p0[2]];

    // Cross product e1 x e2
    const fn = [
      e1[1] * e2[2] - e1[2] * e2[1],
      e1[2] * e2[0] - e1[0] * e2[2],
      e1[0] * e2[1] - e1[1] * e2[0],
    ];

    // Vertex normals average
    const vn = [
      (n[i0 * 3]! + n[i1 * 3]! + n[i2 * 3]!) / 3,
      (n[i0 * 3 + 1]! + n[i1 * 3 + 1]! + n[i2 * 3 + 1]!) / 3,
      (n[i0 * 3 + 2]! + n[i1 * 3 + 2]! + n[i2 * 3 + 2]!) / 3,
    ];

    const dot = fn[0] * vn[0] + fn[1] * vn[1] + fn[2] * vn[2];
    if (dot > 1e-6) outward++;
    else if (dot < -1e-6) inward++;
    else zero++;
  }

  // `name` is part of the returned record so a failing assertion says which primitive it was.
  return { name, outward, inward, zero, total: idx.length / 3 };
}

describe("Primitive face normal vs vertex normal", () => {
  it("all primitives have outward windings matching pipeline frontFace: cw", () => {
    const box = analyzeGeometry(boxGeometrySource(), "box");
    expect(box.inward).toBe(0);

    const plane = analyzeGeometry(planeGeometrySource(), "plane");
    expect(plane.inward).toBe(0);

    const cyl = analyzeGeometry(cylinderGeometrySource(), "cylinder");
    expect(cyl.inward).toBe(0);

    const cone = analyzeGeometry(coneGeometrySource(), "cone");
    expect(cone.inward).toBe(0);

    const sphere = analyzeGeometry(sphereGeometrySource(), "sphere");
    expect(sphere.inward).toBe(0);

    const torus = analyzeGeometry(torusGeometrySource(), "torus");
    expect(torus.inward).toBe(0);
    expect(torus.outward).toBe(torus.total);
  });

  it("torus camera-facing triangles wind clockwise on screen", () => {
    const geo = torusGeometrySource({ radius: 0.8, tube: 0.28 });
    const view = new Mat4().setLookAt(new Vec3(0, 0, -5), new Vec3(0, 0, 0), new Vec3(0, 1, 0));
    const proj = new Mat4().setPerspective(Math.PI / 3, 16 / 9, 0.1, 100);
    const vp = new Mat4().multiplyMatrices(proj, view);

    const p = geo.positions;
    const n = geo.normals!;
    const idx = geo.indices!;

    let cameraFacingCw = 0;
    let cameraFacingCcw = 0;

    for (let t = 0; t < idx.length; t += 3) {
      const i0 = idx[t]!;
      const i1 = idx[t + 1]!;
      const i2 = idx[t + 2]!;

      // Normal facing camera has n_z < -0.2 (camera looks down +Z from -5 to 0)
      const avgNz = (n[i0 * 3 + 2]! + n[i1 * 3 + 2]! + n[i2 * 3 + 2]!) / 3;
      if (avgNz >= -0.2) continue;

      const tri = [
        [p[i0 * 3]!, p[i0 * 3 + 1]!, p[i0 * 3 + 2]!],
        [p[i1 * 3]!, p[i1 * 3 + 1]!, p[i1 * 3 + 2]!],
        [p[i2 * 3]!, p[i2 * 3 + 1]!, p[i2 * 3 + 2]!],
      ];

      const ndc = tri.map(([x, y, z]) => {
        const o = new Float32Array(4);
        vp.transformVec4(x!, y!, z!, 1, o);
        return [o[0]! / o[3]!, o[1]! / o[3]!];
      });

      const signedArea =
        (ndc[1]![0]! - ndc[0]![0]!) * (ndc[2]![1]! - ndc[0]![1]!) -
        (ndc[2]![0]! - ndc[0]![0]!) * (ndc[1]![1]! - ndc[0]![1]!);

      if (signedArea < 0) cameraFacingCw++;
      else cameraFacingCcw++;
    }

    expect(cameraFacingCw).toBeGreaterThan(0);
    expect(cameraFacingCcw).toBe(0);
  });
});
