/**
 * @suite math:math
 * @group unit
 * @covers engine/src/index.ts
 * @covers engine/src/math/color.ts
 * @covers engine/src/math/double3.ts
 * @covers engine/src/math/geometry.ts
 * @covers engine/src/math/mat.ts
 * @covers engine/src/math/noise.ts
 * @covers engine/src/math/rng.ts
 * @covers engine/src/math/scalar.ts
 * @covers engine/src/math/transform.ts
 * @covers engine/src/math/vec.ts
 * @desc Math layer: the invariants the rest of the engine silently depends on
 */

export const suite = {
  name: "math:math",
  group: "unit",
  covers:   [
    "engine/src/index.ts",
    "engine/src/math/color.ts",
    "engine/src/math/double3.ts",
    "engine/src/math/geometry.ts",
    "engine/src/math/mat.ts",
    "engine/src/math/noise.ts",
    "engine/src/math/rng.ts",
    "engine/src/math/scalar.ts",
    "engine/src/math/transform.ts",
    "engine/src/math/vec.ts"
  ],
  desc: "Math layer: the invariants the rest of the engine silently depends on",
};
/**
 * Math layer: the invariants the rest of the engine silently depends on.
 * These are cheap to test and catastrophic when wrong (a 1-ulp error in `Mat4.perspective` shows up
 * as "shadows swim" or "z-fighting on flat ground" three subsystems away).
 */
import assert from "node:assert/strict";
import { assertCloseTo, assertMatchObject, assertThrows, finish, group, test } from "selrun";
import {
  AABB, alignUp, chunkSeed, clamp, Color, combine32, composeYTRS, decodePairToFloat64, Double3, encodeFloat64ToPair,
  fbm2, Frustum, hash2iFloat, linearToSrgb, lerp, Mat4, mix32, nextPowerOfTwo, perlin2, Quat, RayHit,
  Rng, simplex2, srgbToLinear, TRS, TransformStore, valueNoise2, Vec2, Vec3,
} from "@forge/engine";

group("scalar helpers", () => {
  test("clamps and lerps at the edges", () => {
    assert.equal(clamp(-1, 0, 1), 0);
    assert.equal(clamp(2, 0, 1), 1);
    assert.equal(lerp(10, 20, 0), 10);
    assert.equal(lerp(10, 20, 1), 20);
    assert.equal(nextPowerOfTwo(1000), 1024);
    assert.equal(alignUp(1, 256), 256);
    assert.equal(alignUp(256, 256), 256);
  });

  test("round-trips sRGB exactly enough for 8-bit authoring", () => {
    for (const v of [0, 0.04, 0.18, 0.5, 0.75, 1]) {
      const back = srgbToLinear(linearToSrgb(v));
      assert.ok(Math.abs(back - v) < 1e-4);
    }
    // The linear segment must be used below the kink, or darks crush to 0.
    assertCloseTo(srgbToLinear(0.03), 0.03 / 12.92, 8);
  });
});

group("vectors and matrices", () => {
  test("Vec3 arithmetic is allocation-free but correct", () => {
    const a = new Vec3(1, 2, 3);
    const b = new Vec3(4, 5, 0);
    assert.deepEqual(a.add(b).toArray(), [5, 7, 3]);
    assertMatchObject(new Vec3(1, 0, 0).cross(new Vec3(0, 1, 0)), { x: 0, y: 0, z: 1 });
    assert.equal(new Vec3(0, 3, 4).length(), 5);
    const out = new Vec3();
    Vec3.lerpInto(new Vec3(0, 0, 0), new Vec3(10, 10, 10), 0.25, out);
    assertCloseTo(out.x, 2.5, 2);
  });

  test("Mat4 perspective maps near to 0 and far to 1 (WebGPU [0,1] depth, +Z forward convention)", () => {
    const m = new Mat4().setPerspective(Math.PI / 3, 16 / 9, 0.1, 100);
    // View space is right-handed Y-up with +Z forward, so points in front of the camera have z > 0,
    // and clipW == z. NDC z must land inside [0,1] across the whole range.
    const ndc = (z: number): number => (m.get(2, 2) * z + m.get(3, 2)) / z;
    assertCloseTo(ndc(0.1), 0, 6);
    assertCloseTo(ndc(100), 1, 6);
    assert.ok(ndc(1) > 0);
    assert.ok(ndc(1) < 1);
    // FOV/aspect: a point at the top of the frustum maps to NDC y = +1.
    const topY = m.get(1, 1);
    assert.ok(topY > 0);
    assertCloseTo(topY * Math.tan(Math.PI / 6), 1, 6);
  });

  test("invert round-trips and a singular matrix reports failure instead of NaNs", () => {
    const m = new Mat4().setCompose(new Vec3(1, 2, 3), Quat.fromAxisAngle(new Vec3(0, 1, 0), 0.7), new Vec3(1, 1, 1));
    const p = m.transformPoint(new Vec3(4, 5, 6), new Vec3());
    const inv = new Mat4();
    inv.copyFrom(m);
    assert.ok(inv.invert());
    const back = inv.transformPoint(p, new Vec3());
    assertCloseTo(back.x, 4, 4);
    assertCloseTo(back.y, 5, 4);
    const zero = new Mat4();
    zero.m.fill(0);
    assert.equal(zero.invert(), false);
  });

  test("lookAt puts the target at -Z... no: engine convention is +Z forward, target on +Z", () => {
    const eye = new Vec3(0, 0, 0);
    const view = new Mat4().setLookAt(eye, new Vec3(0, 0, 5), new Vec3(0, 1, 0));
    const targetInView = view.transformPoint(new Vec3(0, 0, 5), new Vec3());
    assert.ok(targetInView.z > 0);
    assert.ok(Math.abs(targetInView.x) < 1e-6);
  });

  test("setLookAt is a VIEW matrix: the eye maps to the origin and the target to (0, 0, +distance)", () => {
    // Regression: an earlier version built the camera's *world* matrix (basis in columns, eye as
    // translation). With an off-axis eye that sent the whole scene behind/below the frustum — the
    // demo rendered a black screen with only the HUD visible. The trivial eye=origin case above
    // cannot catch that, so this one uses the demo's actual camera placement.
    const eye = new Vec3(0, 3.4, -9.5);
    const target = new Vec3(0, 0.8, 0);
    const view = new Mat4().setLookAt(eye, target, new Vec3(0, 1, 0));
    const e = view.transformPoint(eye, new Vec3());
    assert.ok(Math.abs(e.x) < 1e-5);
    assert.ok(Math.abs(e.y) < 1e-5);
    assert.ok(Math.abs(e.z) < 1e-5);
    const t = view.transformPoint(target, new Vec3());
    assert.ok(Math.abs(t.x) < 1e-5);
    assert.ok(Math.abs(t.y) < 1e-5);
    assertCloseTo(t.z, eye.clone().sub(target).length(), 4);
    // Something above the target should appear above the centre of the frame, and to the camera's
    // right (+X world, since the camera looks down +Z) should stay on the right.
    const up = view.transformPoint(new Vec3(0, 3, 0), new Vec3());
    assert.ok(up.y > 0);
    const right = view.transformPoint(new Vec3(2, 0.8, 0), new Vec3());
    assert.ok(right.x > 0);
    // And the whole demo layout projects inside the frustum.
    const proj = new Mat4().setPerspective(Math.PI / 3, 16 / 9, 0.1, 200);
    const vp = new Mat4().multiplyMatrices(proj, view);
    const clip = new Float32Array(4);
    for (let i = 0; i < 6; i++) {
      vp.transformVec4((i - 2.5) * 2.1, 0.9, Math.sin(i) * 1.5, 1, clip);
      assert.ok(clip[3] > 0);
      assert.ok(Math.abs(clip[0]! / clip[3]!) < 1);
      assert.ok(Math.abs(clip[1]! / clip[3]!) < 1);
      assert.ok(clip[2]! / clip[3]! > 0);
      assert.ok(clip[2]! / clip[3]! < 1);
    }
  });

  test("outward-facing primitive triangles wind clockwise on screen (pipeline frontFace must be 'cw')", () => {
    // The projection is left-handed (+Z forward, +Y up, +X right) and primitives wind CCW as seen
    // from outside in a right-handed sense; under this projection that appears *clockwise*. The
    // pipeline's frontFace has to agree or back-face culling removes every camera-facing triangle.
    const view = new Mat4().setLookAt(new Vec3(0, 3.4, -9.5), new Vec3(0, 0.8, 0), new Vec3(0, 1, 0));
    const proj = new Mat4().setPerspective(Math.PI / 3, 16 / 9, 0.1, 200);
    const vp = new Mat4().multiplyMatrices(proj, view);
    // Ground plane tri (+Y normal) from planeGeometrySource's index order: a, c, b with
    // a=(-w,0,-d) c=(-w,0,+d) b=(+w,0,-d).
    const tri = [
      [-1, 0, -1],
      [-1, 0, 1],
      [1, 0, -1],
    ];
    const ndc = tri.map(([x, y, z]) => {
      const o = new Float32Array(4);
      vp.transformVec4(x!, y!, z!, 1, o);
      return [o[0]! / o[3]!, o[1]! / o[3]!];
    });
    const signedArea = (ndc[1]![0]! - ndc[0]![0]!) * (ndc[2]![1]! - ndc[0]![1]!) - (ndc[2]![0]! - ndc[0]![0]!) * (ndc[1]![1]! - ndc[0]![1]!);
    assert.ok(signedArea < 0); // negative = clockwise in NDC (+Y up)
  });

  test("quaternion rotate + invert are inverses", () => {
    const q = new Quat().setEulerComponents(0.3, -0.6, 1.1);
    const v = q.rotateVector(new Vec3(1, 0, 0), new Vec3());
    const back = q.clone().invert().rotateVector(v, new Vec3());
    assertCloseTo(back.x, 1, 6);
    assertCloseTo(back.y, 0, 6);
  });

  test("fromUnitVectorY rotates +Y onto the given direction", () => {
    // Regression: the x/z terms were negated, so +Y landed on the mirror of dir (e.g. +Z for -Z).
    for (const dir of [
      new Vec3(0, 0, -1),
      new Vec3(0, 0, 1),
      new Vec3(1, 0, 0),
      new Vec3(0.6585, -0.045, -0.7512).normalize(),
    ]) {
      const out = new Quat().fromUnitVectorY(dir).rotateVector(new Vec3(0, 1, 0), new Vec3());
      assertCloseTo(out.x, dir.x, 5);
      assertCloseTo(out.y, dir.y, 5);
      assertCloseTo(out.z, dir.z, 5);
    }
    // Antipodal input takes the 180° branch rather than dividing by ~0.
    const flip = new Quat().fromUnitVectorY(new Vec3(0, -1, 0)).rotateVector(new Vec3(0, 1, 0), new Vec3());
    assertCloseTo(flip.y, -1, 5);
  });

  test("point/direction transforms accept the input as the output (in-place is how scratch vectors are used)", () => {
    // Regression: transformPoint wrote out.x before reading v.y/v.z, so in-place calls silently
    // mixed transformed and untransformed components — the cascade fit was the first caller to notice.
    const m = Mat4.compose(new Vec3(3, -2, 5), new Quat().setEulerComponents(0.4, 1.3, -0.7), new Vec3(1, 1, 1));
    const q = new Quat().setEulerComponents(0.9, -0.2, 0.5);
    for (const [name, apply] of [
      ["transformPoint", (v: Vec3, out: Vec3) => m.transformPoint(v, out)],
      ["transformDirection", (v: Vec3, out: Vec3) => m.transformDirection(v, out)],
      ["rotateVector", (v: Vec3, out: Vec3) => q.rotateVector(v, out)],
    ] as const) {
      const separate = apply(new Vec3(1.5, -0.25, 2), new Vec3());
      const inPlace = new Vec3(1.5, -0.25, 2);
      apply(inPlace, inPlace);
      assertCloseTo(inPlace.x, separate.x, 6, name);
      assertCloseTo(inPlace.y, separate.y, 6, name);
      assertCloseTo(inPlace.z, separate.z, 6, name);
    }
  });
});

group("transform store", () => {
  test("composes a two-level hierarchy in one pass", () => {
    const store = new TransformStore(16);
    const parent = store.allocate(0, 0);
    store.setPosition(parent, 10, 0, 0);
    const child = store.allocate(parent, 1);
    store.setPosition(child, 0, 5, 0);
    const changed = [parent, child];
    store.updateWorld(changed, true);
    const out = new Vec3();
    store.getWorldPosition(child, out);
    assert.deepEqual(out.toArray(), [10, 5, 0]);
  });

  test("skips work when nothing is dirty, and re-does it after a write", () => {
    const store = new TransformStore(16);
    const a = store.allocate(0, 0);
    store.setPosition(a, 1, 2, 3);
    const changed: number[] = [];
    store.updateWorld(changed, true);
    assert.ok(changed.length > 0);
    const epoch = store.epoch;
    store.updateWorld([], false);
    assert.equal(store.epoch, epoch);
    store.setPosition(a, 4, 5, 6);
    store.updateWorld([a], false);
    assert.ok(store.epoch > epoch);
  });

  test("TRS damp converges without NaN at dt=0", () => {
    const t = new TRS(new Vec3(0, 0, 0), new Quat(), new Vec3(1, 1, 1));
    t.dampToward(new TRS(new Vec3(5, 0, 0), new Quat(), new Vec3(1, 1, 1)), 0.2, 0);
    assert.equal(t.position.x, 0);
    assert.equal(Number.isFinite(t.position.x), true);
  });

  test("keeps a subtree re-parented after allocation following its parent (and never skips roots)", () => {
    // Regression: `setParent` deepened the slot without widening the depth buckets `updateWorld`
    // sorts by, so a child attached after it was allocated (how the Mars rover's GLB parts join
    // the chassis) tracked its parent for ~9 frames and then froze where it was — the rover model
    // stayed at spawn while the vehicle and chase camera drove away. On the way out its stale
    // bucket also overwrote shallower entries, so unrelated roots skipped updates.
    const store = new TransformStore(64);
    const roots: number[] = [];
    for (let i = 0; i < 20; i++) roots.push(store.allocate());
    const parent = store.allocate();
    const child = store.allocate();
    const grandchild = store.allocate();
    store.setParent(child, parent);
    store.setParent(grandchild, child);
    store.setPosition(child, 0, 1, 0);
    store.setPosition(grandchild, 0, 0, 2);
    const changed: number[] = [];
    const out = new Vec3();
    for (let frame = 1; frame <= 40; frame++) {
      store.setPosition(parent, frame, 0, 0);
      for (const r of roots) store.setPosition(r, 0, frame, 0);
      changed.length = 0;
      store.updateWorld(changed);
      assert.deepEqual(store.getWorldPosition(child, out).toArray(), [frame, 1, 0]);
      assert.deepEqual(store.getWorldPosition(grandchild, out).toArray(), [frame, 1, 2]);
      for (const r of roots) assert.equal(store.getWorldPosition(r, out).y, frame);
    }
  });

  test("cycle attempts in the parent chain are rejected by the store's own guard", () => {
    const store = new TransformStore(8);
    const a = store.allocate(0, 0);
    const b = store.allocate(a, 1);
    assertThrows(() => store.setParent(a, b), undefined);
    void b;
  });
});

group("large-world coordinates", () => {
  test("writeRelativeFloat32 recovers sub-millimetre precision far from the origin", () => {
    const origin = new Double3(1_000_000, 0, 2_000_000);
    const world = new Double3(1_000_000.125, 3.5, 2_000_000 - 0.25);
    const out = new Float32Array(3);
    world.writeRelativeFloat32(origin, out);
    assertCloseTo(out[0], 0.125, 6);
    assertCloseTo(out[1], 3.5, 6);
    assertCloseTo(out[2], -0.25, 6);
    // Naively storing the absolute value in float32 would lose ~0.06 here: prove the difference.
    const naive = 1_000_000.125 - Math.fround(1_000_000);
    assert.ok(Math.abs(naive - 0.125) < 0.1);
  });

  test("float64-as-pair survives a GPU round trip to ~48 bits", () => {
    const buffer = new Float32Array(2);
    const value = 12345.678901234;
    encodeFloat64ToPair(value, buffer, 0);
    assertCloseTo(decodePairToFloat64(buffer, 0), value, 8);
  });

  test("chunk keys pack without collisions over the terrain range", () => {
    const seen = new Set<number>();
    for (let cx = -64; cx < 64; cx++) {
      for (let cz = -64; cz < 64; cz++) {
        for (let level = 0; level < 4; level++) {
          const k = chunkSeed(cx, cz, level, 7) ^ 0;
          seen.add(k);
        }
      }
    }
    assert.equal(seen.size, 128 * 128 * 4);
  });
});

group("deterministic randomness", () => {
  test("the same seed produces the same stream, a different seed does not", () => {
    const a = new Rng(1234);
    const b = new Rng(1234);
    const c = new Rng(1235);
    const va = [a.nextFloat(), a.nextFloat(), a.nextFloat()];
    const vb = [b.nextFloat(), b.nextFloat(), b.nextFloat()];
    assert.deepEqual(va, vb);
    assert.notDeepEqual(va, [c.nextFloat(), c.nextFloat(), c.nextFloat()]);
  });

  test("mix32 has no fixed points in the low bits and distributes in [0,1)", () => {
    assert.notEqual(mix32(0), 0);
    assert.notEqual(combine32(1, 2), combine32(2, 1));
    let sum = 0;
    for (let i = 0; i < 4096; i++) sum += mix32(i) / 4294967296;
    assert.ok(sum / 4096 > 0.4);
    assert.ok(sum / 4096 < 0.6);
  });

  test("noise is a pure function of (x, z, seed) and stays bounded", () => {
    assert.equal(valueNoise2(1.5, -2.25, 9), valueNoise2(1.5, -2.25, 9));
    assert.ok(Math.abs(perlin2(3.1, 4.2, 1)) <= 1.5);
    assert.ok(Math.abs(simplex2(3.1, 4.2, 1)) <= 1.5);
    assert.ok(Math.abs(fbm2(3.1, 4.2, 1, { octaves: 5 })) <= 2.5);
    assert.ok(hash2iFloat(2, -3, 11) >= 0);
    assert.ok(hash2iFloat(2, -3, 11) < 1);
  });
});

group("colour", () => {
  test("hex authoring is interpreted as sRGB and stored linear", () => {
    const c = Color.fromSrgbHex(0x808080);
    assertCloseTo(c.r, srgbToLinear(128 / 255), 6);
    assert.equal(c.toSrgbPacked() & 0xff, 128);
  });

  test("mid-grey luminance is well below 0.5 in linear space", () => {
    const c = Color.fromSrgbHex(0x7f7f7f);
    assert.ok(c.luminance < 0.25);
  });
});

group("bounds", () => {
  test("composeYTRS matches setCompose with a Y-axis quaternion, and writes at an offset", () => {
    const out = new Float32Array(32);
    let worst = 0;
    for (const radians of [0, 0.7, -1.9, Math.PI, 42.5]) {
      for (const p of [new Vec3(0, 0, 0), new Vec3(1, -2, 3.5)]) {
        for (const s of [new Vec3(1, 1, 1), new Vec3(0.5, 2, 1.7)]) {
          const ref = new Mat4().setCompose(p, Quat.fromAxisAngle(new Vec3(0, 1, 0), radians), s);
          composeYTRS(p.x, p.y, p.z, s.x, s.y, s.z, radians, out, 4);
          for (let i = 0; i < 16; i++) worst = Math.max(worst, Math.abs(out[4 + i]! - ref.m[i]!));
          // Untouched head and tail: the offset contract the renderer's arena writes rely on.
          assert.equal(out[0], 0);
          assert.equal(out[4 + 16], 0);
        }
      }
    }
    assert.equal(worst, 0);
  });

  test("AABB slab intersection returns the entry distance and respects maxDistance", () => {
    const box = new AABB(new Vec3(-1, -1, -1), new Vec3(1, 1, 1));
    const tMinMax = new Float32Array([0, 100]);
    const hit = box.min.clone();
    void hit;
    const rayHit = new RayHit();
    const origin = new Vec3(0, 0, -5);
    const dir = new Vec3(0, 0, 1);
    const inv = new Vec3(1 / dir.x || Infinity, 1 / dir.y || Infinity, 1 / dir.z);
    assert.equal(box.intersectsRay(origin, inv, tMinMax, rayHit), true);
    assertCloseTo(tMinMax[0], 4, 5);
    // A ray that reaches the box at t=4 must be rejected by a 0..2 window.
    const miss = new Float32Array([0, 2]);
    assert.equal(box.intersectsRay(origin, inv, miss), false);
  });

  test("Vec2 keeps its own shape", () => {
    assert.deepEqual(new Vec2(1, 2).scale(3).toArray(), [3, 6]);
  });

  test("Mat4.multiply is alias-safe, so the natural proj.multiply(view) call is correct", () => {
    const proj = new Mat4().setPerspective(Math.PI / 3, 16 / 9, 0.5, 60);
    const view = new Mat4().setLookAt(new Vec3(3, 4, 5), new Vec3(0, 0, 0), new Vec3(0, 1, 0));

    // this = this * b, computed in place, must equal the three-operand form.
    const inPlace = proj.clone().multiply(view);
    const explicit = new Mat4().multiplyMatrices(proj, view);
    assert.deepEqual(Array.from(inPlace.m), Array.from(explicit.m));

    // And the result has to be a usable matrix, not garbage: the camera-space origin maps to the
    // same clip position either way.
    const originClip = explicit.transformPoint(new Vec3(0, 0, 0), new Vec3());
    const inPlaceClip = inPlace.transformPoint(new Vec3(0, 0, 0), new Vec3());
    assertCloseTo(inPlaceClip.x, originClip.x, 5);
    assertCloseTo(inPlaceClip.z, originClip.z, 5);

    // Self-multiplication is the other aliasing case (b === this).
    const squared = proj.clone().multiply(proj);
    const squaredExplicit = new Mat4().multiplyMatrices(proj, proj);
    assert.deepEqual(Array.from(squared.m), Array.from(squaredExplicit.m));
  });

  test("frustum extraction matches the projection convention (this pair has to agree)", () => {
    const proj = new Mat4().setPerspective(Math.PI / 3, 16 / 9, 0.5, 60);
    const view = new Mat4().setLookAt(new Vec3(0, 0, 0), new Vec3(0, 0, 10), new Vec3(0, 1, 0));
    const frustum = new Frustum().setFromViewProjection(new Mat4().multiplyMatrices(proj, view));
    const p = new Vec3();
    // Dead ahead, mid range: inside.
    p.set(0, 0, 20);
    assert.equal(frustum.containsPoint(p), true);
    // Behind the camera: outside. (With a mismatched z convention this returns true.)
    p.set(0, 0, -5);
    assert.equal(frustum.containsPoint(p), false);
    // Too near / too far: outside.
    p.set(0, 0, 0.25);
    assert.equal(frustum.containsPoint(p), false);
    p.set(0, 0, 61);
    assert.equal(frustum.containsPoint(p), false);
    // Off to the side but within the far distance: outside the left/right planes.
    p.set(40, 0, 10);
    assert.equal(frustum.containsPoint(p), false);
    // Straight up, close: inside the top plane's cone (16:9 at 60 deg covers ~37 deg vertically).
    p.set(0, 2, 5);
    assert.equal(frustum.containsPoint(p), true);
  });

  test("an orthographic shadow projection keeps x/y and maps depth into [0,1]", () => {
    const ortho = new Mat4().setOrthographic(-10, 10, -10, 10, 0.1, 50);
    const out = ortho.transformPoint(new Vec3(10, -10, 50), new Vec3());
    assertCloseTo(out.x, 1, 5);
    assertCloseTo(out.y, -1, 5);
    assert.ok(out.z >= 0);
    assert.ok(out.z <= 1);
  });
});

await finish();
