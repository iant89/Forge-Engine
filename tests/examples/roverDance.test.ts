/**
 * @suite examples:roverDance
 * @group unit
 * @covers examples/src/scenes/roverDance.ts
 * @desc fe-28 finale rig: suspension-arm triangle split, arm swing/carry transform, shortest-arc quaternion
 */

export const suite = {
  name: "examples:roverDance",
  group: "unit",
  covers:   [
    "examples/src/scenes/roverDance.ts"
  ],
  desc: "fe-28 finale rig: suspension-arm triangle split, arm swing/carry transform, shortest-arc quaternion",
};
import assert from "node:assert/strict";
import { finish, group, test } from "selrun";
import { Quat, Vec3 } from "@forge/engine";
import {
  armPieceForWheel,
  classifySuspensionTriangle,
  quatFromTo,
  splitSuspension,
  rainbow,
  stageLightAim,
  stageLightColor,
  STAGE_LIGHT_COUNT,
  suspensionArmPose,
} from "../../examples/src/scenes/roverDance.js";

const near = (a: number, b: number, eps = 1e-5): void => assert.ok(Math.abs(a - b) < eps, `${a} vs ${b}`);

group("triangle classification", () => {
  test("deck/top stays body; outboard low triangles split front/middle by side", () => {
    assert.equal(classifySuspensionTriangle(0, 0.5, 0), "body");
    assert.equal(classifySuspensionTriangle(1.0, 1.3, 0.5), "body");
    assert.equal(classifySuspensionTriangle(1.0, 0.6, 0.6), "front+");
    assert.equal(classifySuspensionTriangle(-1.0, 0.6, 0.6), "front-");
    assert.equal(classifySuspensionTriangle(1.0, 0.5, -0.3), "middle+");
    assert.equal(classifySuspensionTriangle(-1.0, 0.5, -0.3), "middle-");
    assert.equal(classifySuspensionTriangle(1.0, 0.9, -0.3), "body", "the rocker beam above the bogie stays on the body");
    assert.equal(classifySuspensionTriangle(1.0, 0.4, -1.0), "body", "rear arm (feet) stays");
  });
  test("wheel → arm piece: front pair, middle pair, rear none", () => {
    assert.equal(armPieceForWheel(0, 1.1), "front+");
    assert.equal(armPieceForWheel(1, -1.1), "front-");
    assert.equal(armPieceForWheel(2, 1.1), "middle+");
    assert.equal(armPieceForWheel(3, -1.1), "middle-");
    assert.equal(armPieceForWheel(4, 1.1), null);
  });
});

group("split", () => {
  test("every triangle lands in exactly one compacted piece with its attributes", () => {
    // Three triangles: body (centre), front+ and middle-.
    const positions = new Float32Array([
      0, 0.5, 0, 0.1, 0.5, 0, 0, 0.6, 0,
      1, 0.6, 0.6, 1.1, 0.6, 0.6, 1, 0.7, 0.6,
      -1, 0.5, -0.3, -1.1, 0.5, -0.3, -1, 0.6, -0.3,
    ]);
    const uvs = new Float32Array(18).map((_, i) => i);
    const parts = splitSuspension({ positions, uvs, indices: new Uint16Array([0, 1, 2, 3, 4, 5, 6, 7, 8]) });
    assert.deepEqual([...parts.keys()].sort(), ["body", "front+", "middle-"]);
    const front = parts.get("front+")!;
    assert.deepEqual([...front.indices!], [0, 1, 2]);
    assert.deepEqual([...front.positions], [1, 0.6, 0.6, 1.1, 0.6, 0.6, 1, 0.7, 0.6].map((v) => Math.fround(v)));
    assert.deepEqual([...front.uvs!], [6, 7, 8, 9, 10, 11]);
    assert.equal(front.normals, null);
    // Non-indexed input works too.
    assert.equal(splitSuspension({ positions }).size, 3);
  });
  test("shared vertices are kept once per piece", () => {
    const positions = new Float32Array([1, 0.6, 0.6, 1.1, 0.6, 0.6, 1, 0.7, 0.6, 1.1, 0.7, 0.6]);
    const parts = splitSuspension({ positions, indices: new Uint32Array([0, 1, 2, 1, 3, 2]) });
    assert.equal(parts.get("front+")!.positions.length, 12);
    assert.deepEqual([...parts.get("front+")!.indices!], [0, 1, 2, 1, 3, 2]);
  });
});

group("arm pose", () => {
  test("quatFromTo maps a onto b (incl. opposite vectors)", () => {
    const out = new Vec3();
    for (const [a, b] of [[new Vec3(1, 0, 0), new Vec3(0, 2, 0)], [new Vec3(0, -1, 1), new Vec3(1, 1, 0)], [new Vec3(0, 0, 1), new Vec3(0, 0, -3)]] as const) {
      quatFromTo(a, b).rotateVector(a, out);
      const la = Math.hypot(a.x, a.y, a.z);
      const lb = Math.hypot(b.x, b.y, b.z);
      near(out.x, (b.x / lb) * la);
      near(out.y, (b.y / lb) * la);
      near(out.z, (b.z / lb) * la);
    }
  });
  test("rest target → rest transform; posed target → the hub end lands on the wheel, the pivot end swings", () => {
    const pivot = new Vec3(0.88, 0.9 - 0.5, 0.1);
    const rest = new Vec3(1.1, 0.263 - 0.5, 0.9);
    const offset = new Vec3(0, -0.5, 0);
    const pos = new Vec3();
    const rot = new Quat();
    suspensionArmPose(pivot, rest, rest, offset, pos, rot);
    near(pos.x, 0); near(pos.y, -0.5); near(pos.z, 0);
    near(rot.w, 1);
    const target = new Vec3(rest.x - 1.7, rest.y + 0.4, rest.z + 2.2);
    suspensionArmPose(pivot, rest, target, offset, pos, rot);
    // The model-space hub vertex (rest − offset) maps onto the target.
    const hubModel = new Vec3(rest.x - offset.x, rest.y - offset.y, rest.z - offset.z);
    const mapped = new Vec3();
    rot.rotateVector(hubModel, mapped);
    near(mapped.x + pos.x, target.x, 1e-4);
    near(mapped.y + pos.y, target.y, 1e-4);
    near(mapped.z + pos.z, target.z, 1e-4);
    // The arm points from its (carried) pivot toward the target.
    const pivotModel = new Vec3(pivot.x - offset.x, pivot.y - offset.y, pivot.z - offset.z);
    const pm = new Vec3();
    rot.rotateVector(pivotModel, pm);
    const dir = new Vec3(target.x - (pm.x + pos.x), target.y - (pm.y + pos.y), target.z - (pm.z + pos.z));
    const want = new Vec3(target.x - pivot.x, target.y - pivot.y, target.z - pivot.z);
    const cos = (dir.x * want.x + dir.y * want.y + dir.z * want.z) / (Math.hypot(dir.x, dir.y, dir.z) * Math.hypot(want.x, want.y, want.z));
    near(cos, 1, 1e-4);
  });
});


group("stage lights", () => {
  test("rainbow hits the primaries and lights spread over the hue wheel", () => {
    const eq = (c: { r: number; g: number; b: number }, r: number, g: number, b: number) => { near(c.r, r); near(c.g, g); near(c.b, b); };
    eq(rainbow(0), 1, 0, 0);
    eq(rainbow(1 / 3), 0, 1, 0);
    eq(rainbow(2 / 3), 0, 0, 1);
    const colours = Array.from({ length: STAGE_LIGHT_COUNT }, (_, i) => stageLightColor(i, 0));
    assert.equal(new Set(colours.map((c) => `${c.r.toFixed(2)},${c.g.toFixed(2)},${c.b.toFixed(2)}`)).size, STAGE_LIGHT_COUNT);
    assert.notDeepEqual(stageLightColor(0, 0), stageLightColor(0, 2), "colours cycle over time");
  });
  test("spots sweep left and right, neighbours in opposite directions; heads stay on the truss", () => {
    for (let i = 0; i < STAGE_LIGHT_COUNT; i++) {
      const left = stageLightAim(i, -1);
      const right = stageLightAim(i, 1);
      assert.deepEqual(left.head, right.head);
      assert.ok(Math.abs(right.spot.x - left.spot.x) > 10);
      if (i > 0) assert.ok(Math.sign(right.spot.x - left.spot.x) !== Math.sign(stageLightAim(i - 1, 1).spot.x - stageLightAim(i - 1, -1).spot.x));
    }
  });
});

await finish();
