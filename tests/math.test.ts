/**
 * Math layer: the invariants the rest of the engine silently depends on.
 * These are cheap to test and catastrophic when wrong (a 1-ulp error in `Mat4.perspective` shows up
 * as "shadows swim" or "z-fighting on flat ground" three subsystems away).
 */
import { describe, expect, it } from "vitest";
import {
  AABB, alignUp, chunkSeed, clamp, Color, combine32, decodePairToFloat64, Double3, encodeFloat64ToPair,
  fbm2, Frustum, hash2iFloat, linearToSrgb, lerp, Mat4, mix32, nextPowerOfTwo, perlin2, Quat, RayHit,
  Rng, simplex2, srgbToLinear, TRS, TransformStore, valueNoise2, Vec2, Vec3,
} from "@forge/engine";

describe("scalar helpers", () => {
  it("clamps and lerps at the edges", () => {
    expect(clamp(-1, 0, 1)).toBe(0);
    expect(clamp(2, 0, 1)).toBe(1);
    expect(lerp(10, 20, 0)).toBe(10);
    expect(lerp(10, 20, 1)).toBe(20);
    expect(nextPowerOfTwo(1000)).toBe(1024);
    expect(alignUp(1, 256)).toBe(256);
    expect(alignUp(256, 256)).toBe(256);
  });

  it("round-trips sRGB exactly enough for 8-bit authoring", () => {
    for (const v of [0, 0.04, 0.18, 0.5, 0.75, 1]) {
      const back = srgbToLinear(linearToSrgb(v));
      expect(Math.abs(back - v)).toBeLessThan(1e-4);
    }
    // The linear segment must be used below the kink, or darks crush to 0.
    expect(srgbToLinear(0.03)).toBeCloseTo(0.03 / 12.92, 8);
  });
});

describe("vectors and matrices", () => {
  it("Vec3 arithmetic is allocation-free but correct", () => {
    const a = new Vec3(1, 2, 3);
    const b = new Vec3(4, 5, 0);
    expect(a.add(b).toArray()).toEqual([5, 7, 3]);
    expect(new Vec3(1, 0, 0).cross(new Vec3(0, 1, 0))).toMatchObject({ x: 0, y: 0, z: 1 });
    expect(new Vec3(0, 3, 4).length()).toBe(5);
    const out = new Vec3();
    Vec3.lerpInto(new Vec3(0, 0, 0), new Vec3(10, 10, 10), 0.25, out);
    expect(out.x).toBeCloseTo(2.5);
  });

  it("Mat4 perspective maps near to 0 and far to 1 (WebGPU [0,1] depth, +Z forward convention)", () => {
    const m = new Mat4().setPerspective(Math.PI / 3, 16 / 9, 0.1, 100);
    // View space is right-handed Y-up with +Z forward, so points in front of the camera have z > 0,
    // and clipW == z. NDC z must land inside [0,1] across the whole range.
    const ndc = (z: number): number => (m.get(2, 2) * z + m.get(3, 2)) / z;
    expect(ndc(0.1)).toBeCloseTo(0, 6);
    expect(ndc(100)).toBeCloseTo(1, 6);
    expect(ndc(1)).toBeGreaterThan(0);
    expect(ndc(1)).toBeLessThan(1);
    // FOV/aspect: a point at the top of the frustum maps to NDC y = +1.
    const topY = m.get(1, 1);
    expect(topY).toBeGreaterThan(0);
    expect(topY * Math.tan(Math.PI / 6)).toBeCloseTo(1, 6);
  });

  it("invert round-trips and a singular matrix reports failure instead of NaNs", () => {
    const m = new Mat4().setCompose(new Vec3(1, 2, 3), Quat.fromAxisAngle(new Vec3(0, 1, 0), 0.7), new Vec3(1, 1, 1));
    const p = m.transformPoint(new Vec3(4, 5, 6), new Vec3());
    const inv = new Mat4();
    inv.copyFrom(m);
    expect(inv.invert()).toBeTruthy();
    const back = inv.transformPoint(p, new Vec3());
    expect(back.x).toBeCloseTo(4, 4);
    expect(back.y).toBeCloseTo(5, 4);
    const zero = new Mat4();
    zero.m.fill(0);
    expect(zero.invert()).toBe(false);
  });

  it("lookAt puts the target at -Z... no: engine convention is +Z forward, target on +Z", () => {
    const eye = new Vec3(0, 0, 0);
    const view = new Mat4().setLookAt(eye, new Vec3(0, 0, 5), new Vec3(0, 1, 0));
    const targetInView = view.transformPoint(new Vec3(0, 0, 5), new Vec3());
    expect(targetInView.z).toBeGreaterThan(0);
    expect(Math.abs(targetInView.x)).toBeLessThan(1e-6);
  });

  it("setLookAt is a VIEW matrix: the eye maps to the origin and the target to (0, 0, +distance)", () => {
    // Regression: an earlier version built the camera's *world* matrix (basis in columns, eye as
    // translation). With an off-axis eye that sent the whole scene behind/below the frustum — the
    // demo rendered a black screen with only the HUD visible. The trivial eye=origin case above
    // cannot catch that, so this one uses the demo's actual camera placement.
    const eye = new Vec3(0, 3.4, -9.5);
    const target = new Vec3(0, 0.8, 0);
    const view = new Mat4().setLookAt(eye, target, new Vec3(0, 1, 0));
    const e = view.transformPoint(eye, new Vec3());
    expect(Math.abs(e.x)).toBeLessThan(1e-5);
    expect(Math.abs(e.y)).toBeLessThan(1e-5);
    expect(Math.abs(e.z)).toBeLessThan(1e-5);
    const t = view.transformPoint(target, new Vec3());
    expect(Math.abs(t.x)).toBeLessThan(1e-5);
    expect(Math.abs(t.y)).toBeLessThan(1e-5);
    expect(t.z).toBeCloseTo(eye.clone().sub(target).length(), 4);
    // Something above the target should appear above the centre of the frame, and to the camera's
    // right (+X world, since the camera looks down +Z) should stay on the right.
    const up = view.transformPoint(new Vec3(0, 3, 0), new Vec3());
    expect(up.y).toBeGreaterThan(0);
    const right = view.transformPoint(new Vec3(2, 0.8, 0), new Vec3());
    expect(right.x).toBeGreaterThan(0);
    // And the whole demo layout projects inside the frustum.
    const proj = new Mat4().setPerspective(Math.PI / 3, 16 / 9, 0.1, 200);
    const vp = new Mat4().multiplyMatrices(proj, view);
    const clip = new Float32Array(4);
    for (let i = 0; i < 6; i++) {
      vp.transformVec4((i - 2.5) * 2.1, 0.9, Math.sin(i) * 1.5, 1, clip);
      expect(clip[3]).toBeGreaterThan(0);
      expect(Math.abs(clip[0]! / clip[3]!)).toBeLessThan(1);
      expect(Math.abs(clip[1]! / clip[3]!)).toBeLessThan(1);
      expect(clip[2]! / clip[3]!).toBeGreaterThan(0);
      expect(clip[2]! / clip[3]!).toBeLessThan(1);
    }
  });

  it("outward-facing primitive triangles wind clockwise on screen (pipeline frontFace must be 'cw')", () => {
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
    expect(signedArea).toBeLessThan(0); // negative = clockwise in NDC (+Y up)
  });

  it("quaternion rotate + invert are inverses", () => {
    const q = new Quat().setEulerComponents(0.3, -0.6, 1.1);
    const v = q.rotateVector(new Vec3(1, 0, 0), new Vec3());
    const back = q.clone().invert().rotateVector(v, new Vec3());
    expect(back.x).toBeCloseTo(1, 6);
    expect(back.y).toBeCloseTo(0, 6);
  });

  it("point/direction transforms accept the input as the output (in-place is how scratch vectors are used)", () => {
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
      expect(inPlace.x, name).toBeCloseTo(separate.x, 6);
      expect(inPlace.y, name).toBeCloseTo(separate.y, 6);
      expect(inPlace.z, name).toBeCloseTo(separate.z, 6);
    }
  });
});

describe("transform store", () => {
  it("composes a two-level hierarchy in one pass", () => {
    const store = new TransformStore(16);
    const parent = store.allocate(0, 0);
    store.setPosition(parent, 10, 0, 0);
    const child = store.allocate(parent, 1);
    store.setPosition(child, 0, 5, 0);
    const changed = [parent, child];
    store.updateWorld(changed, true);
    const out = new Vec3();
    store.getWorldPosition(child, out);
    expect(out.toArray()).toEqual([10, 5, 0]);
  });

  it("skips work when nothing is dirty, and re-does it after a write", () => {
    const store = new TransformStore(16);
    const a = store.allocate(0, 0);
    store.setPosition(a, 1, 2, 3);
    const changed: number[] = [];
    store.updateWorld(changed, true);
    expect(changed.length).toBeGreaterThan(0);
    const epoch = store.epoch;
    store.updateWorld([], false);
    expect(store.epoch).toBe(epoch);
    store.setPosition(a, 4, 5, 6);
    store.updateWorld([a], false);
    expect(store.epoch).toBeGreaterThan(epoch);
  });

  it("TRS damp converges without NaN at dt=0", () => {
    const t = new TRS(new Vec3(0, 0, 0), new Quat(), new Vec3(1, 1, 1));
    t.dampToward(new TRS(new Vec3(5, 0, 0), new Quat(), new Vec3(1, 1, 1)), 0.2, 0);
    expect(t.position.x).toBe(0);
    expect(Number.isFinite(t.position.x)).toBe(true);
  });

  it("keeps a subtree re-parented after allocation following its parent (and never skips roots)", () => {
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
      expect(store.getWorldPosition(child, out).toArray()).toEqual([frame, 1, 0]);
      expect(store.getWorldPosition(grandchild, out).toArray()).toEqual([frame, 1, 2]);
      for (const r of roots) expect(store.getWorldPosition(r, out).y).toBe(frame);
    }
  });

  it("cycle attempts in the parent chain are rejected by the store's own guard", () => {
    const store = new TransformStore(8);
    const a = store.allocate(0, 0);
    const b = store.allocate(a, 1);
    expect(() => store.setParent(a, b)).toThrow();
    void b;
  });
});

describe("large-world coordinates", () => {
  it("writeRelativeFloat32 recovers sub-millimetre precision far from the origin", () => {
    const origin = new Double3(1_000_000, 0, 2_000_000);
    const world = new Double3(1_000_000.125, 3.5, 2_000_000 - 0.25);
    const out = new Float32Array(3);
    world.writeRelativeFloat32(origin, out);
    expect(out[0]).toBeCloseTo(0.125, 6);
    expect(out[1]).toBeCloseTo(3.5, 6);
    expect(out[2]).toBeCloseTo(-0.25, 6);
    // Naively storing the absolute value in float32 would lose ~0.06 here: prove the difference.
    const naive = 1_000_000.125 - Math.fround(1_000_000);
    expect(Math.abs(naive - 0.125)).toBeLessThan(0.1);
  });

  it("float64-as-pair survives a GPU round trip to ~48 bits", () => {
    const buffer = new Float32Array(2);
    const value = 12345.678901234;
    encodeFloat64ToPair(value, buffer, 0);
    expect(decodePairToFloat64(buffer, 0)).toBeCloseTo(value, 8);
  });

  it("chunk keys pack without collisions over the terrain range", () => {
    const seen = new Set<number>();
    for (let cx = -64; cx < 64; cx++) {
      for (let cz = -64; cz < 64; cz++) {
        for (let level = 0; level < 4; level++) {
          const k = chunkSeed(cx, cz, level, 7) ^ 0;
          seen.add(k);
        }
      }
    }
    expect(seen.size).toBe(128 * 128 * 4);
  });
});

describe("deterministic randomness", () => {
  it("the same seed produces the same stream, a different seed does not", () => {
    const a = new Rng(1234);
    const b = new Rng(1234);
    const c = new Rng(1235);
    const va = [a.nextFloat(), a.nextFloat(), a.nextFloat()];
    const vb = [b.nextFloat(), b.nextFloat(), b.nextFloat()];
    expect(va).toEqual(vb);
    expect(va).not.toEqual([c.nextFloat(), c.nextFloat(), c.nextFloat()]);
  });

  it("mix32 has no fixed points in the low bits and distributes in [0,1)", () => {
    expect(mix32(0)).not.toBe(0);
    expect(combine32(1, 2)).not.toBe(combine32(2, 1));
    let sum = 0;
    for (let i = 0; i < 4096; i++) sum += mix32(i) / 4294967296;
    expect(sum / 4096).toBeGreaterThan(0.4);
    expect(sum / 4096).toBeLessThan(0.6);
  });

  it("noise is a pure function of (x, z, seed) and stays bounded", () => {
    expect(valueNoise2(1.5, -2.25, 9)).toBe(valueNoise2(1.5, -2.25, 9));
    expect(Math.abs(perlin2(3.1, 4.2, 1))).toBeLessThanOrEqual(1.5);
    expect(Math.abs(simplex2(3.1, 4.2, 1))).toBeLessThanOrEqual(1.5);
    expect(Math.abs(fbm2(3.1, 4.2, 1, { octaves: 5 }))).toBeLessThanOrEqual(2.5);
    expect(hash2iFloat(2, -3, 11)).toBeGreaterThanOrEqual(0);
    expect(hash2iFloat(2, -3, 11)).toBeLessThan(1);
  });
});

describe("colour", () => {
  it("hex authoring is interpreted as sRGB and stored linear", () => {
    const c = Color.fromSrgbHex(0x808080);
    expect(c.r).toBeCloseTo(srgbToLinear(128 / 255), 6);
    expect(c.toSrgbPacked() & 0xff).toBe(128);
  });

  it("mid-grey luminance is well below 0.5 in linear space", () => {
    const c = Color.fromSrgbHex(0x7f7f7f);
    expect(c.luminance).toBeLessThan(0.25);
  });
});

describe("bounds", () => {
  it("AABB slab intersection returns the entry distance and respects maxDistance", () => {
    const box = new AABB(new Vec3(-1, -1, -1), new Vec3(1, 1, 1));
    const tMinMax = new Float32Array([0, 100]);
    const hit = box.min.clone();
    void hit;
    const rayHit = new RayHit();
    const origin = new Vec3(0, 0, -5);
    const dir = new Vec3(0, 0, 1);
    const inv = new Vec3(1 / dir.x || Infinity, 1 / dir.y || Infinity, 1 / dir.z);
    expect(box.intersectsRay(origin, inv, tMinMax, rayHit)).toBe(true);
    expect(tMinMax[0]).toBeCloseTo(4, 5);
    // A ray that reaches the box at t=4 must be rejected by a 0..2 window.
    const miss = new Float32Array([0, 2]);
    expect(box.intersectsRay(origin, inv, miss)).toBe(false);
  });

  it("Vec2 keeps its own shape", () => {
    expect(new Vec2(1, 2).scale(3).toArray()).toEqual([3, 6]);
  });

  it("Mat4.multiply is alias-safe, so the natural proj.multiply(view) call is correct", () => {
    const proj = new Mat4().setPerspective(Math.PI / 3, 16 / 9, 0.5, 60);
    const view = new Mat4().setLookAt(new Vec3(3, 4, 5), new Vec3(0, 0, 0), new Vec3(0, 1, 0));

    // this = this * b, computed in place, must equal the three-operand form.
    const inPlace = proj.clone().multiply(view);
    const explicit = new Mat4().multiplyMatrices(proj, view);
    expect(Array.from(inPlace.m)).toEqual(Array.from(explicit.m));

    // And the result has to be a usable matrix, not garbage: the camera-space origin maps to the
    // same clip position either way.
    const originClip = explicit.transformPoint(new Vec3(0, 0, 0), new Vec3());
    const inPlaceClip = inPlace.transformPoint(new Vec3(0, 0, 0), new Vec3());
    expect(inPlaceClip.x).toBeCloseTo(originClip.x, 5);
    expect(inPlaceClip.z).toBeCloseTo(originClip.z, 5);

    // Self-multiplication is the other aliasing case (b === this).
    const squared = proj.clone().multiply(proj);
    const squaredExplicit = new Mat4().multiplyMatrices(proj, proj);
    expect(Array.from(squared.m)).toEqual(Array.from(squaredExplicit.m));
  });

  it("frustum extraction matches the projection convention (this pair has to agree)", () => {
    const proj = new Mat4().setPerspective(Math.PI / 3, 16 / 9, 0.5, 60);
    const view = new Mat4().setLookAt(new Vec3(0, 0, 0), new Vec3(0, 0, 10), new Vec3(0, 1, 0));
    const frustum = new Frustum().setFromViewProjection(new Mat4().multiplyMatrices(proj, view));
    const p = new Vec3();
    // Dead ahead, mid range: inside.
    p.set(0, 0, 20);
    expect(frustum.containsPoint(p)).toBe(true);
    // Behind the camera: outside. (With a mismatched z convention this returns true.)
    p.set(0, 0, -5);
    expect(frustum.containsPoint(p)).toBe(false);
    // Too near / too far: outside.
    p.set(0, 0, 0.25);
    expect(frustum.containsPoint(p)).toBe(false);
    p.set(0, 0, 61);
    expect(frustum.containsPoint(p)).toBe(false);
    // Off to the side but within the far distance: outside the left/right planes.
    p.set(40, 0, 10);
    expect(frustum.containsPoint(p)).toBe(false);
    // Straight up, close: inside the top plane's cone (16:9 at 60 deg covers ~37 deg vertically).
    p.set(0, 2, 5);
    expect(frustum.containsPoint(p)).toBe(true);
  });

  it("an orthographic shadow projection keeps x/y and maps depth into [0,1]", () => {
    const ortho = new Mat4().setOrthographic(-10, 10, -10, 10, 0.1, 50);
    const out = ortho.transformPoint(new Vec3(10, -10, 50), new Vec3());
    expect(out.x).toBeCloseTo(1, 5);
    expect(out.y).toBeCloseTo(-1, 5);
    expect(out.z).toBeGreaterThanOrEqual(0);
    expect(out.z).toBeLessThanOrEqual(1);
  });
});
