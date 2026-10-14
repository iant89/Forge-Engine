/**
 * @suite examples:roverCourseLampShadows
 * @group unit
 * @covers examples/src/scenes/roverCourseScene.ts
 * @desc fe-32 street lamps cast rover shadows: the spot-shadow slots follow the rover to the nearest lamps
 */

export const suite = {
  name: "examples:roverCourseLampShadows",
  group: "unit",
  covers:   [
    "examples/src/scenes/roverCourseScene.ts"
  ],
  desc: "fe-32 street lamps cast rover shadows: the spot-shadow slots follow the rover to the nearest lamps",
};
import assert from "node:assert/strict";
import { finish, group, test } from "selrun";
import { MAX_SPOT_SHADOWS } from "@forge/engine";
import { LAMP_SHADOWS_FOR_TIER, LAMP_SPOT, nearestLampIndices } from "../../examples/src/scenes/roverCourseScene.js";

const ring = Array.from({ length: 8 }, (_, k) => ({ x: Math.cos((k * Math.PI) / 4) * 40, z: Math.sin((k * Math.PI) / 4) * 40 }));

group("nearestLampIndices", () => {
  test("picks the lamps closest to the rover, not the first ones in the list", () => {
    // Rover beside lamp 4 (opposite side of the ring from lamp 0).
    const near = nearestLampIndices(ring, -40, 0, MAX_SPOT_SHADOWS);
    assert.equal(near.size, MAX_SPOT_SHADOWS);
    assert.ok(near.has(4), "the lamp the rover is under always gets a shadow slot");
    assert.ok(!near.has(0), "the far lamp does not");
  });
  test("every lamp gets a slot when the rover stands under it", () => {
    for (let k = 0; k < ring.length; k++) assert.ok(nearestLampIndices(ring, ring[k]!.x, ring[k]!.z, MAX_SPOT_SHADOWS).has(k), `lamp ${k}`);
  });
  test("count clamps to the lamp list and to zero", () => {
    assert.equal(nearestLampIndices(ring, 0, 0, 99).size, 8);
    assert.equal(nearestLampIndices(ring, 0, 0, 0).size, 0);
    assert.equal(nearestLampIndices(ring, 0, 0, -1).size, 0);
  });
});

group("tier budget", () => {
  test("low 1, medium 2, high 4 (never past the renderer's slots)", () => {
    assert.equal(LAMP_SHADOWS_FOR_TIER.low, 1);
    assert.equal(LAMP_SHADOWS_FOR_TIER.medium, 2);
    assert.equal(LAMP_SHADOWS_FOR_TIER.high, Math.min(4, MAX_SPOT_SHADOWS));
    for (const n of Object.values(LAMP_SHADOWS_FOR_TIER)) assert.ok(n >= 1 && n <= MAX_SPOT_SHADOWS);
  });
  test("low tier still shadows the lamp the rover is under", () => {
    for (let k = 0; k < ring.length; k++) assert.deepEqual([...nearestLampIndices(ring, ring[k]!.x, ring[k]!.z, LAMP_SHADOWS_FOR_TIER.low)], [k]);
  });
  test("lamps are brighter than the pre-fe-32 60 / 18 m", () => {
    assert.ok(LAMP_SPOT.intensity > 60 && LAMP_SPOT.range > 18);
  });
});

await finish();
