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
import { nearestLampIndices } from "../../examples/src/scenes/roverCourseScene.js";

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

await finish();
