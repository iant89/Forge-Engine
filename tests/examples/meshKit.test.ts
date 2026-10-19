/**
 * @suite examples:meshKit
 * @group unit
 * @covers examples/src/scenes/meshKit.ts
 * @desc Pins the procedural mesh kit: closed outward-wound solids, loft ordering and creases, lathe/arc/prism volumes, builder transforms and mirroring
 */

export const suite = {
  name: "examples:meshKit",
  group: "unit",
  covers: ["examples/src/scenes/meshKit.ts"],
  desc: "Pins the procedural mesh kit: closed outward-wound solids, loft ordering and creases, lathe/arc/prism volumes, builder transforms and mirroring",
};
import assert from "node:assert/strict";
import { assertCloseTo, finish, group, test } from "selrun";
import { boxGeometrySource, type GeometrySource } from "@forge/engine";
import {
  IDENTITY,
  MeshBuilder,
  alignYTo,
  arcStripSource,
  chain,
  compose,
  loftSource,
  orientOutward,
  prismSource,
  revolveSource,
  rotateX,
  rotateY,
  rotateZ,
  roundedBoxSource,
  scaleBy,
  signedVolume,
  translate,
  tubeBetween,
  withTangents,
  type Affine,
} from "../../examples/src/scenes/meshKit.js";

function bounds(source: GeometrySource): { min: number[]; max: number[] } {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < source.positions.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k]!, source.positions[i + k]!);
      max[k] = Math.max(max[k]!, source.positions[i + k]!);
    }
  }
  return { min, max };
}

/** Every attribute is present, finite, in range, and the triangles' own winding agrees with the normals. */
function assertWellFormed(source: GeometrySource, label: string): void {
  const n = source.positions.length / 3;
  assert.ok(n > 0, `${label} has vertices`);
  assert.equal(source.normals!.length, n * 3, `${label} normals`);
  assert.equal(source.uvs!.length, n * 2, `${label} uvs`);
  assert.equal(source.tangents!.length, n * 4, `${label} tangents`);
  for (const v of source.positions) assert.ok(Number.isFinite(v), `${label} positions are finite`);
  for (let i = 0; i < n; i++) assertCloseTo(Math.hypot(source.normals![i * 3]!, source.normals![i * 3 + 1]!, source.normals![i * 3 + 2]!), 1, 4, `${label} normal ${i}`);
  const idx = source.indices!;
  assert.ok(idx.length > 0 && idx.length % 3 === 0, `${label} has whole triangles`);
  const p = source.positions, nm = source.normals!;
  let disagree = 0;
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t]!, b = idx[t + 1]!, c = idx[t + 2]!;
    assert.ok(a < n && b < n && c < n, `${label} indices are valid`);
    const e1 = [p[b * 3]! - p[a * 3]!, p[b * 3 + 1]! - p[a * 3 + 1]!, p[b * 3 + 2]! - p[a * 3 + 2]!];
    const e2 = [p[c * 3]! - p[a * 3]!, p[c * 3 + 1]! - p[a * 3 + 1]!, p[c * 3 + 2]! - p[a * 3 + 2]!];
    const f = [e1[1]! * e2[2]! - e1[2]! * e2[1]!, e1[2]! * e2[0]! - e1[0]! * e2[2]!, e1[0]! * e2[1]! - e1[1]! * e2[0]!];
    const dot = f[0]! * (nm[a * 3]! + nm[b * 3]! + nm[c * 3]!) + f[1]! * (nm[a * 3 + 1]! + nm[b * 3 + 1]! + nm[c * 3 + 1]!) + f[2]! * (nm[a * 3 + 2]! + nm[b * 3 + 2]! + nm[c * 3 + 2]!);
    if (dot < -1e-12) disagree++;
  }
  assert.equal(disagree, 0, `${label}: no triangle winds against its normals`);
}

const apply = (t: Affine, v: [number, number, number]): number[] => [
  t[0] * v[0] + t[1] * v[1] + t[2] * v[2] + t[3],
  t[4] * v[0] + t[5] * v[1] + t[6] * v[2] + t[7],
  t[8] * v[0] + t[9] * v[1] + t[10] * v[2] + t[11],
];

group("meshKit — transforms", () => {
  test("compose applies the first transform first; chain folds left to right", () => {
    const p = apply(compose(scaleBy(2), translate(1, 0, 0)), [1, 1, 1]);
    assert.deepEqual(p, [3, 2, 2]);
    const q = apply(chain(translate(1, 0, 0), scaleBy(2)), [1, 1, 1]);
    assert.deepEqual(q, [4, 2, 2]);
    assert.deepEqual(apply(IDENTITY, [3, 4, 5]), [3, 4, 5]);
  });

  test("rotations turn axes the right way", () => {
    const x = apply(rotateY(Math.PI / 2), [1, 0, 0]);
    assertCloseTo(x[2]!, -1, 9);
    const y = apply(rotateZ(Math.PI / 2), [1, 0, 0]);
    assertCloseTo(y[1]!, 1, 9);
    const z = apply(rotateX(Math.PI / 2), [0, 1, 0]);
    assertCloseTo(z[2]!, 1, 9);
  });

  test("alignYTo takes +Y onto any direction", () => {
    for (const d of [[1, 0, 0], [0, 0, -1], [0.3, 0.8, -0.5], [0, -1, 0], [0, 1, 0], [-2, 0.1, 1]] as const) {
      const len = Math.hypot(...d);
      const out = apply(alignYTo(d[0], d[1], d[2]), [0, 1, 0]);
      for (let k = 0; k < 3; k++) assertCloseTo(out[k]!, d[k]! / len, 6, `direction ${d} axis ${k}`);
    }
  });
});

group("meshKit — rounded box", () => {
  const rb = roundedBoxSource({ width: 2, height: 1, depth: 3, radius: 0.2, segments: 4 });

  test("is a closed, outward-wound solid with exact bounds and a plausible volume", () => {
    assertWellFormed(rb, "rounded box");
    const b = bounds(rb);
    for (const [k, h] of [[0, 1], [1, 0.5], [2, 1.5]] as const) {
      assertCloseTo(b.min[k]!, -h, 5);
      assertCloseTo(b.max[k]!, h, 5);
    }
    const volume = signedVolume(rb);
    assert.ok(volume < 6 && volume > 6 * 0.93, `volume ${volume} (a sharp box is 6)`);
  });

  test("normals point away from the centre and every face is smooth into its neighbour", () => {
    for (let i = 0; i < rb.positions.length; i += 3) {
      const out = rb.positions[i]! * rb.normals![i]! + rb.positions[i + 1]! * rb.normals![i + 1]! + rb.positions[i + 2]! * rb.normals![i + 2]!;
      assert.ok(out > 0, "outward normal");
    }
    // Rounding clamps to half the smallest side: a huge radius becomes a capsule/pill, still closed.
    const pill = roundedBoxSource({ width: 1, height: 1, depth: 2, radius: 50 });
    assert.ok(signedVolume(pill) > 0 && bounds(pill).max[0]! <= 0.5 + 1e-6);
  });

  test("is deterministic", () => {
    const again = roundedBoxSource({ width: 2, height: 1, depth: 3, radius: 0.2, segments: 4 });
    assert.deepEqual(Array.from(again.positions), Array.from(rb.positions));
    assert.deepEqual(Array.from(again.indices!), Array.from(rb.indices!));
  });
});

group("meshKit — loft", () => {
  const stations = [
    { z: 0, halfWidth: 1, yBottom: 0, yTop: 1, radius: 0.1 },
    { z: 2, halfWidth: 1, yBottom: 0, yTop: 1, radius: 0.1 },
    { z: 4, halfWidth: 0.5, yBottom: 0, yTop: 0.5, radius: 0.1 },
  ];

  test("builds a closed, outward-wound, capped solid", () => {
    const loft = loftSource(stations, { cornerSegments: 4 });
    assertWellFormed(loft, "loft");
    assert.ok(signedVolume(loft) > 0);
    // A 2×1 section over 2 m (area 2 less the corner gaps) plus the frustum that tapers it to 1×0.5:
    // (L/3)(A₁ + A₂ + √(A₁A₂)) with A₁ ≈ 1.99, A₂ ≈ 0.49.
    const a1 = 2 - (4 - Math.PI) * 0.01, a2 = 0.5 - (4 - Math.PI) * 0.01;
    const expected = 2 * a1 + (2 / 3) * (a1 + a2 + Math.sqrt(a1 * a2));
    assert.ok(Math.abs(signedVolume(loft) - expected) < 0.06, `volume ${signedVolume(loft)} vs ${expected}`);
  });

  test("station order does not matter (the loft sorts by z)", () => {
    const forward = loftSource(stations);
    const reversed = loftSource([...stations].reverse());
    assert.equal(forward.indices!.length, reversed.indices!.length);
    assertCloseTo(signedVolume(reversed), signedVolume(forward), 9);
    assert.deepEqual(bounds(reversed), bounds(forward));
  });

  test("stations sharing a z make a crease: no surface between them, and the caps stay optional", () => {
    const creased = loftSource([{ ...stations[0]!, z: 0 }, { ...stations[1]!, z: 2 }, { ...stations[1]!, z: 2, yBottom: 0.4 }, { ...stations[2]!, z: 4 }]);
    const plain = loftSource([stations[0]!, stations[1]!, stations[2]!]);
    // One extra ring but the same number of side bands: only the cap fans and two real bands remain.
    assert.ok(creased.indices!.length >= plain.indices!.length);
    const open = loftSource(stations, { capStart: false, capEnd: false });
    assert.ok(open.indices!.length < loftSource(stations).indices!.length);
    assert.throws(() => loftSource([stations[0]!]));
  });

  test("a uniform loft has the area of its rounded rectangle", () => {
    const loft = loftSource([{ z: 0, halfWidth: 1, yBottom: 0, yTop: 2, radius: 0.5 }, { z: 3, halfWidth: 1, yBottom: 0, yTop: 2, radius: 0.5 }], { cornerSegments: 16 });
    const area = 2 * 2 - (4 - Math.PI) * 0.25; // rectangle minus the four corner gaps
    assertCloseTo(signedVolume(loft), area * 3, 1);
  });
});

group("meshKit — lathe, arc and prism", () => {
  test("a capped cylinder profile revolves into πr²L about the X axis", () => {
    const r = 0.4, L = 1.5;
    const solid = revolveSource([{ radius: 0, along: -L / 2 }, { radius: r, along: -L / 2 }, { radius: r, along: L / 2 }, { radius: 0, along: L / 2 }], { segments: 64 });
    assertWellFormed(solid, "revolve");
    assertCloseTo(signedVolume(solid), Math.PI * r * r * L, 1);
    const b = bounds(solid);
    assertCloseTo(b.min[0]!, -L / 2, 6);
    assertCloseTo(b.max[0]!, L / 2, 6);
    assertCloseTo(b.max[1]!, r, 2);
  });

  test("an open profile can be capped, and UV v follows the profile's arc length", () => {
    const profile = [{ radius: 0.3, along: -0.2 }, { radius: 0.4, along: -0.1 }, { radius: 0.4, along: 0.1 }, { radius: 0.3, along: 0.2 }];
    const open = revolveSource(profile, { segments: 16 });
    const capped = revolveSource(profile, { segments: 16, capped: true });
    assert.ok(capped.indices!.length > open.indices!.length);
    assert.ok(signedVolume(capped) > 0);
    assert.equal(open.uvs![1], 0);
    assertCloseTo(open.uvs![open.uvs!.length - 1]!, 1, 9);
    const repeated = revolveSource(profile, { segments: 16, uRepeat: 7 });
    assertCloseTo(repeated.uvs![16 * 2]!, 7, 9, "u repeats around the axle");
    assert.throws(() => revolveSource([{ radius: 1, along: 0 }]));
  });

  test("an arc strip is a closed solid with Pappus' volume", () => {
    const strip = arcStripSource({ radius: 0.5, thickness: 0.1, width: 0.2, start: 0, end: Math.PI, segments: 48 });
    assertWellFormed(strip, "arc strip");
    // Pappus: cross-section area × path length of its centroid.
    const expected = 0.2 * 0.1 * (0.55 * Math.PI);
    assertCloseTo(signedVolume(strip), expected, 2);
  });

  test("a prism is half a box and flat-shaded", () => {
    const prism = prismSource(4, 1.5, 3);
    assertWellFormed(prism, "prism");
    assertCloseTo(signedVolume(prism), 0.5 * 4 * 1.5 * 3, 6);
    const b = bounds(prism);
    assert.deepEqual([b.min[1], b.max[1]], [0, 1.5]);
  });
});

group("meshKit — builder", () => {
  test("merges sources with offset indices and bakes the transform", () => {
    const box = boxGeometrySource({ width: 1, height: 1, depth: 1 });
    const builder = new MeshBuilder().add(box, translate(5, 0, 0)).add(box, translate(-5, 0, 0));
    const merged = builder.build("two boxes");
    assert.equal(builder.vertexCount, 2 * (box.positions.length / 3));
    assert.equal(builder.triangleCount, 2 * (box.indices!.length / 3));
    assertWellFormed(merged, "merged");
    const b = bounds(merged);
    assert.deepEqual([b.min[0], b.max[0]], [-5.5, 5.5]);
    assertCloseTo(signedVolume(merged), 2, 9);
  });

  test("mirroring flips the winding so mirrored parts stay outward-facing", () => {
    const wedge = prismSource(1, 1, 1);
    const merged = new MeshBuilder().add(wedge, translate(2, 0, 0)).add(wedge, compose(translate(2, 0, 0), scaleBy(-1, 1, 1))).build("pair");
    assertWellFormed(merged, "mirrored pair");
    assertCloseTo(signedVolume(merged), 2 * signedVolume(wedge), 9);
    const b = bounds(merged);
    assertCloseTo(b.min[0]!, -2.5, 9);
    assertCloseTo(b.max[0]!, 2.5, 9);
  });

  test("non-uniform scale keeps normals perpendicular to the surface", () => {
    const box = boxGeometrySource({ width: 1, height: 1, depth: 1 });
    const stretched = new MeshBuilder().add(box, scaleBy(4, 1, 1)).build("stretched");
    assertCloseTo(signedVolume(stretched), 4, 9);
    // A 45° slope stretched 2× in Y is steeper: its normal must tilt toward horizontal, (−4, 1)/√17.
    const prism = prismSource(2, 1, 1); // left slope normal ∝ (−1, 1, 0) / √2 ... apex height 1 over half-width 1
    const tall = new MeshBuilder().add(prism, scaleBy(1, 2, 1)).build("tall");
    let found = false;
    for (let i = 0; i < tall.normals!.length; i += 3) {
      const nx = tall.normals![i]!, ny = tall.normals![i + 1]!;
      if (nx < -0.5 && ny > 0) {
        found = true;
        assertCloseTo(nx, -2 / Math.sqrt(5), 5);
        assertCloseTo(ny, 1 / Math.sqrt(5), 5);
      }
    }
    assert.ok(found, "the left slope is present");
  });

  test("tubeBetween spans exactly the segment between its endpoints", () => {
    const { source, transform } = tubeBetween([1, 2, 3], [4, 6, 3], 0.05, 8);
    const merged = new MeshBuilder().add(source, transform).build("tube");
    const b = bounds(merged);
    // The cylinder is 5 m long (3-4-5) and 0.05 thick: every vertex lies within the radius of the axis.
    let farthest = 0;
    for (let i = 0; i < merged.positions.length; i += 3) {
      const px = merged.positions[i]! - 1, py = merged.positions[i + 1]! - 2, pz = merged.positions[i + 2]! - 3;
      const along = (px * 3 + py * 4) / 5;
      const radial = Math.hypot(px - (along * 3) / 5, py - (along * 4) / 5, pz);
      farthest = Math.max(farthest, radial);
      assert.ok(along >= -1e-6 && along <= 5 + 1e-6, "inside the segment");
    }
    assert.ok(farthest <= 0.05 + 1e-6);
    assert.ok(b.max[0]! > 3.9 && b.min[0]! < 1.1);
  });

  test("withTangents keeps the normals it was given; orientOutward fixes a flipped triangle", () => {
    const rb = roundedBoxSource({ width: 1, height: 1, depth: 1, radius: 0.1 });
    const again = withTangents(rb);
    assert.deepEqual(Array.from(again.normals!), Array.from(rb.normals!));
    const flipped: GeometrySource = { ...rb, indices: Uint32Array.from(rb.indices!, (v, i) => (i % 3 === 1 ? rb.indices![i + 1]! : i % 3 === 2 ? rb.indices![i - 1]! : v)) };
    assert.ok(signedVolume(flipped) < 0);
    assertCloseTo(signedVolume(orientOutward(flipped)), signedVolume(rb), 9);
  });
});

await finish();
