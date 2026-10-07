import { describe, expect, it } from "vitest";
import {
  ALPINE_SNOWPACK_INITIAL_DEPTH_M,
  ALPINE_SNOWPACK_MAX_DEPTH_M,
  ALPINE_SNOWPACK_RATE_MPS,
  advanceAlpineSnowpack,
} from "../examples/src/scenes/alpineSnowpack.js";

describe("alpine snowpack", () => {
  it("adds a visible layer during snowfall and keeps stacking over time", () => {
    const start = ALPINE_SNOWPACK_INITIAL_DEPTH_M;
    const afterOneSecond = advanceAlpineSnowpack(start, 1, 1);
    const afterTenSeconds = advanceAlpineSnowpack(afterOneSecond, 1, 9);

    expect(afterOneSecond).toBeCloseTo(start + ALPINE_SNOWPACK_RATE_MPS, 12);
    expect(afterTenSeconds).toBeCloseTo(start + 10 * ALPINE_SNOWPACK_RATE_MPS, 12);
    expect(afterTenSeconds).toBeGreaterThan(afterOneSecond);
  });

  it("respects precipitation, elapsed time, and the pack depth limit", () => {
    const start = ALPINE_SNOWPACK_INITIAL_DEPTH_M;
    expect(advanceAlpineSnowpack(start, 0, 60)).toBe(start);
    expect(advanceAlpineSnowpack(start, 0.5, 2)).toBeCloseTo(start + ALPINE_SNOWPACK_RATE_MPS, 12);
    expect(advanceAlpineSnowpack(ALPINE_SNOWPACK_MAX_DEPTH_M - 0.001, 1, 10)).toBe(ALPINE_SNOWPACK_MAX_DEPTH_M);
    expect(advanceAlpineSnowpack(start, 1, -1)).toBe(start);
    expect(advanceAlpineSnowpack(start, Number.NaN, 1)).toBe(start);
  });
});
