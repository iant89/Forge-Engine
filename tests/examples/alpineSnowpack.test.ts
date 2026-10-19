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
  alpineSnowCover01,
  alpineSnowShade01,
  ALPINE_SNOW_SHADE_MAX,
  ALPINE_SNOW_SHADE_MIN,
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

group("alpine snow cover", () => {
  test("maps pack depth onto the engine's 0..1 weather cover and clamps", () => {
    assert.equal(alpineSnowCover01(0), 0);
    assert.equal(alpineSnowCover01(ALPINE_SNOWPACK_MAX_DEPTH_M), 1);
    assertCloseTo(alpineSnowCover01(ALPINE_SNOWPACK_MAX_DEPTH_M / 2), 0.5, 12);
    assert.equal(alpineSnowCover01(-1), 0);
    assert.equal(alpineSnowCover01(10), 1);
    assert.equal(alpineSnowCover01(Number.NaN), 0);
  });

  test("the demo opens with a light pack and a storm buries it within about a minute", () => {
    const start = alpineSnowCover01(ALPINE_SNOWPACK_INITIAL_DEPTH_M);
    assert.ok(start > 0.15 && start < 0.4, `opening cover ${start}`);
    let depth = ALPINE_SNOWPACK_INITIAL_DEPTH_M;
    for (let second = 0; second < 90; second++) depth = advanceAlpineSnowpack(depth, 1, 1);
    assert.equal(alpineSnowCover01(depth), 1);
    // …and a gentle overcast barely moves it over the same time.
    let calm = ALPINE_SNOWPACK_INITIAL_DEPTH_M;
    for (let second = 0; second < 90; second++) calm = advanceAlpineSnowpack(calm, 0.06, 1);
    assert.ok(alpineSnowCover01(calm) - start < 0.06);
  });
});

group("alpine snow shade", () => {
  test("remaps the cover onto the span where the renderer's snow shader actually changes", () => {
    assertCloseTo(alpineSnowShade01(0), ALPINE_SNOW_SHADE_MIN, 12);
    assertCloseTo(alpineSnowShade01(1), ALPINE_SNOW_SHADE_MAX, 12);
    assertCloseTo(alpineSnowShade01(0.5), (ALPINE_SNOW_SHADE_MIN + ALPINE_SNOW_SHADE_MAX) / 2, 12);
    assertCloseTo(alpineSnowShade01(-3), ALPINE_SNOW_SHADE_MIN, 12);
    assertCloseTo(alpineSnowShade01(9), ALPINE_SNOW_SHADE_MAX, 12);
    assertCloseTo(alpineSnowShade01(Number.NaN), ALPINE_SNOW_SHADE_MIN, 12);
    let last = -1;
    for (let c = 0; c <= 1; c += 0.05) {
      const shade = alpineSnowShade01(c);
      assert.ok(shade > last, "monotonic");
      last = shade;
    }
  });

  test("a fully buried pack is past the shader's saturation point, the opening dusting is well short of it", () => {
    // The shader covers flat ground completely once (shade × 1.35 − 0.35) × 4 ≥ 1, i.e. shade ≥ 0.43.
    const saturation = (1 / 4 + 0.35) / 1.35;
    assert.ok(ALPINE_SNOW_SHADE_MAX >= saturation, `max shade ${ALPINE_SNOW_SHADE_MAX} reaches saturation ${saturation.toFixed(3)}`);
    assert.ok(alpineSnowShade01(alpineSnowCover01(ALPINE_SNOWPACK_INITIAL_DEPTH_M)) < saturation - 0.15, "the opening ground is patchy");
    // About halfway through the burial the ground is already mostly covered (so the storm reads early).
    assert.ok(alpineSnowShade01(0.7) > saturation - 0.1);
  });
});

await finish();
