/**
 * @suite examples:alpineSnowpack
 * @group integration
 * @covers examples/src/scenes/alpineSnowpack.ts
 * @desc Pins alpine snowpack behavior and regression guarantees
 */

export const suite = {
  name: "examples:alpineSnowpack",
  group: "integration",
  covers:   [
    "examples/src/scenes/alpineSnowpack.ts"
  ],
  desc: "Pins alpine snowpack behavior and regression guarantees",
};
import assert from "node:assert/strict";
import { assertCloseTo, finish, group, test } from "selrun";
import {
  ALPINE_SNOWPACK_INITIAL_DEPTH_M,
  ALPINE_SNOWPACK_MAX_DEPTH_M,
  ALPINE_SNOWPACK_RATE_MPS,
  advanceAlpineSnowpack,
} from "../../examples/src/scenes/alpineSnowpack.js";

group("alpine snowpack", () => {
  test("adds a visible layer during snowfall and keeps stacking over time", () => {
    const start = ALPINE_SNOWPACK_INITIAL_DEPTH_M;
    const afterOneSecond = advanceAlpineSnowpack(start, 1, 1);
    const afterTenSeconds = advanceAlpineSnowpack(afterOneSecond, 1, 9);

    assertCloseTo(afterOneSecond, start + ALPINE_SNOWPACK_RATE_MPS, 12);
    assertCloseTo(afterTenSeconds, start + 10 * ALPINE_SNOWPACK_RATE_MPS, 12);
    assert.ok(afterTenSeconds > afterOneSecond);
  });

  test("respects precipitation, elapsed time, and the pack depth limit", () => {
    const start = ALPINE_SNOWPACK_INITIAL_DEPTH_M;
    assert.equal(advanceAlpineSnowpack(start, 0, 60), start);
    assertCloseTo(advanceAlpineSnowpack(start, 0.5, 2), start + ALPINE_SNOWPACK_RATE_MPS, 12);
    assert.equal(advanceAlpineSnowpack(ALPINE_SNOWPACK_MAX_DEPTH_M - 0.001, 1, 10), ALPINE_SNOWPACK_MAX_DEPTH_M);
    assert.equal(advanceAlpineSnowpack(start, 1, -1), start);
    assert.equal(advanceAlpineSnowpack(start, Number.NaN, 1), start);
  });
});

await finish();
