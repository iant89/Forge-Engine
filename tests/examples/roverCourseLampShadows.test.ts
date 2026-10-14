/**
 * @suite examples:roverCourseLampShadows
 * @group unit
 * @covers examples/src/scenes/roverCourseScene.ts
 * @desc fe-32 street lamps cast rover shadows: tier spot-shadow budgets and lamp brightness
 */

export const suite = {
  name: "examples:roverCourseLampShadows",
  group: "unit",
  covers:   [
    "examples/src/scenes/roverCourseScene.ts"
  ],
  desc: "fe-32 street lamps cast rover shadows: tier spot-shadow budgets and lamp brightness",
};
import assert from "node:assert/strict";
import { finish, group, test } from "selrun";
import { MAX_SPOT_SHADOWS } from "@forge/engine";
import { LAMP_SHADOWS_FOR_TIER, LAMP_SPOT } from "../../examples/src/scenes/roverCourseScene.js";

group("tier budget", () => {
  test("low 1, medium 2, high 6 (never past the renderer's slots)", () => {
    assert.equal(LAMP_SHADOWS_FOR_TIER.low, 1);
    assert.equal(LAMP_SHADOWS_FOR_TIER.medium, 2);
    assert.equal(LAMP_SHADOWS_FOR_TIER.high, Math.min(6, MAX_SPOT_SHADOWS));
    for (const n of Object.values(LAMP_SHADOWS_FOR_TIER)) assert.ok(n >= 1 && n <= MAX_SPOT_SHADOWS);
  });
  test("lamps are brighter than the pre-fe-32 60 / 18 m", () => {
    assert.ok(LAMP_SPOT.intensity > 60 && LAMP_SPOT.range > 18);
  });
});

await finish();
