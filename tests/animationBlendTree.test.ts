/**
 * Blend tree tests (Phase 16.3).
 *
 * Coverage:
 *  - BlendTree1D: two-clip, three-clip, boundary values, out-of-range clamping, single clip
 *  - BlendTree2D: centre, corners, edges, out-of-range clamping, non-unit rectangle
 *  - Weight invariant: all weights sum to 1
 *  - Determinism: same inputs → same outputs
 */

import { describe, expect, it } from "vitest";
import { BlendTree1D, BlendTree2D, type BlendResult } from "@forge/engine";

/** Sum all weights in a blend result. */
function totalWeight(results: BlendResult[]): number {
  return results.reduce((sum, r) => sum + r.weight, 0);
}

/** Find the weight for a named clip (0 if absent). */
function weightOf(results: BlendResult[], name: string): number {
  return results.find((r) => r.name === name)?.weight ?? 0;
}

// ──────────────────────── BlendTree1D ────────────────────────

describe("BlendTree1D", () => {
  it("returns single clip when only one entry exists", () => {
    const tree = new BlendTree1D([{ name: "idle", threshold: 0 }]);
    const result = tree.evaluate(0.5);
    expect(result).toEqual([{ name: "idle", weight: 1 }]);
  });

  it("returns first clip when param is at or below first threshold", () => {
    const tree = new BlendTree1D([
      { name: "idle", threshold: 0 },
      { name: "walk", threshold: 1 },
    ]);
    expect(tree.evaluate(-1)).toEqual([{ name: "idle", weight: 1 }]);
    expect(tree.evaluate(0)).toEqual([{ name: "idle", weight: 1 }]);
  });

  it("returns last clip when param is at or above last threshold", () => {
    const tree = new BlendTree1D([
      { name: "idle", threshold: 0 },
      { name: "walk", threshold: 1 },
    ]);
    expect(tree.evaluate(1)).toEqual([{ name: "walk", weight: 1 }]);
    expect(tree.evaluate(2)).toEqual([{ name: "walk", weight: 1 }]);
  });

  it("linearly interpolates between two clips", () => {
    const tree = new BlendTree1D([
      { name: "idle", threshold: 0 },
      { name: "walk", threshold: 1 },
    ]);
    const result = tree.evaluate(0.5);
    expect(weightOf(result, "idle")).toBeCloseTo(0.5, 6);
    expect(weightOf(result, "walk")).toBeCloseTo(0.5, 6);
    expect(totalWeight(result)).toBeCloseTo(1, 6);
  });

  it("interpolates the correct pair in a three-clip tree", () => {
    const tree = new BlendTree1D([
      { name: "idle", threshold: 0 },
      { name: "walk", threshold: 0.5 },
      { name: "run", threshold: 1.0 },
    ]);

    // At 0.75: between walk (0.5) and run (1.0), alpha = 0.5
    const result = tree.evaluate(0.75);
    expect(weightOf(result, "idle")).toBeCloseTo(0, 6);
    expect(weightOf(result, "walk")).toBeCloseTo(0.5, 6);
    expect(weightOf(result, "run")).toBeCloseTo(0.5, 6);
    expect(totalWeight(result)).toBeCloseTo(1, 6);
  });

  it("handles unsorted entries (sorts by threshold)", () => {
    const tree = new BlendTree1D([
      { name: "run", threshold: 1.0 },
      { name: "idle", threshold: 0 },
      { name: "walk", threshold: 0.5 },
    ]);
    const result = tree.evaluate(0.25);
    expect(weightOf(result, "idle")).toBeCloseTo(0.5, 6);
    expect(weightOf(result, "walk")).toBeCloseTo(0.5, 6);
    expect(weightOf(result, "run")).toBeCloseTo(0, 6);
  });

  it("handles non-uniform thresholds", () => {
    const tree = new BlendTree1D([
      { name: "a", threshold: 0 },
      { name: "b", threshold: 0.25 },
      { name: "c", threshold: 1.0 },
    ]);
    // At 0.625: between b (0.25) and c (1.0), alpha = (0.625-0.25)/0.75 = 0.5
    const result = tree.evaluate(0.625);
    expect(weightOf(result, "b")).toBeCloseTo(0.5, 6);
    expect(weightOf(result, "c")).toBeCloseTo(0.5, 6);
  });

  it("returns empty array for empty tree", () => {
    const tree = new BlendTree1D([]);
    expect(tree.evaluate(0.5)).toEqual([]);
  });

  it("exposes min/max threshold and clip count", () => {
    const tree = new BlendTree1D([
      { name: "a", threshold: -1 },
      { name: "b", threshold: 2 },
    ]);
    expect(tree.minThreshold).toBe(-1);
    expect(tree.maxThreshold).toBe(2);
    expect(tree.clipCount).toBe(2);
  });

  it("is deterministic: same input always produces same output", () => {
    const tree = new BlendTree1D([
      { name: "a", threshold: 0 },
      { name: "b", threshold: 0.33 },
      { name: "c", threshold: 0.67 },
      { name: "d", threshold: 1.0 },
    ]);
    for (let i = 0; i < 100; i++) {
      const t = i / 100;
      const r1 = tree.evaluate(t);
      const r2 = tree.evaluate(t);
      expect(r1).toEqual(r2);
    }
  });
});

// ──────────────────────── BlendTree2D ────────────────────────

describe("BlendTree2D", () => {
  const standardRect = {
    bottomLeft:  { name: "walkLeft",  x: -1, y: -1 },
    bottomRight: { name: "walkRight", x: +1, y: -1 },
    topLeft:     { name: "runLeft",   x: -1, y: +1 },
    topRight:    { name: "runRight",  x: +1, y: +1 },
  };

  it("returns equal weights at the centre", () => {
    const tree = new BlendTree2D(standardRect);
    const result = tree.evaluate(0, 0);
    expect(weightOf(result, "walkLeft")).toBeCloseTo(0.25, 6);
    expect(weightOf(result, "walkRight")).toBeCloseTo(0.25, 6);
    expect(weightOf(result, "runLeft")).toBeCloseTo(0.25, 6);
    expect(weightOf(result, "runRight")).toBeCloseTo(0.25, 6);
    expect(totalWeight(result)).toBeCloseTo(1, 6);
  });

  it("returns full weight at bottom-left corner", () => {
    const tree = new BlendTree2D(standardRect);
    const result = tree.evaluate(-1, -1);
    expect(weightOf(result, "walkLeft")).toBeCloseTo(1, 6);
    expect(weightOf(result, "walkRight")).toBeCloseTo(0, 6);
    expect(weightOf(result, "runLeft")).toBeCloseTo(0, 6);
    expect(weightOf(result, "runRight")).toBeCloseTo(0, 6);
  });

  it("returns full weight at top-right corner", () => {
    const tree = new BlendTree2D(standardRect);
    const result = tree.evaluate(1, 1);
    expect(weightOf(result, "runRight")).toBeCloseTo(1, 6);
    expect(weightOf(result, "walkLeft")).toBeCloseTo(0, 6);
  });

  it("interpolates along the bottom edge", () => {
    const tree = new BlendTree2D(standardRect);
    const result = tree.evaluate(0, -1); // centre of bottom edge
    expect(weightOf(result, "walkLeft")).toBeCloseTo(0.5, 6);
    expect(weightOf(result, "walkRight")).toBeCloseTo(0.5, 6);
    expect(weightOf(result, "runLeft")).toBeCloseTo(0, 6);
    expect(weightOf(result, "runRight")).toBeCloseTo(0, 6);
    expect(totalWeight(result)).toBeCloseTo(1, 6);
  });

  it("interpolates along the left edge", () => {
    const tree = new BlendTree2D(standardRect);
    const result = tree.evaluate(-1, 0); // centre of left edge
    expect(weightOf(result, "walkLeft")).toBeCloseTo(0.5, 6);
    expect(weightOf(result, "runLeft")).toBeCloseTo(0.5, 6);
    expect(weightOf(result, "walkRight")).toBeCloseTo(0, 6);
    expect(weightOf(result, "runRight")).toBeCloseTo(0, 6);
  });

  it("clamps to rectangle extents", () => {
    const tree = new BlendTree2D(standardRect);
    // Outside the rectangle.
    const result = tree.evaluate(5, 5);
    expect(weightOf(result, "runRight")).toBeCloseTo(1, 6);
    expect(totalWeight(result)).toBeCloseTo(1, 6);
  });

  it("clamps negative out-of-range", () => {
    const tree = new BlendTree2D(standardRect);
    const result = tree.evaluate(-5, -5);
    expect(weightOf(result, "walkLeft")).toBeCloseTo(1, 6);
    expect(totalWeight(result)).toBeCloseTo(1, 6);
  });

  it("works with non-unit rectangle", () => {
    const tree = new BlendTree2D({
      bottomLeft:  { name: "a", x: 0, y: 0 },
      bottomRight: { name: "b", x: 10, y: 0 },
      topLeft:     { name: "c", x: 0, y: 10 },
      topRight:    { name: "d", x: 10, y: 10 },
    });
    // At (5, 5) = centre of [0,10]×[0,10]
    const result = tree.evaluate(5, 5);
    expect(weightOf(result, "a")).toBeCloseTo(0.25, 6);
    expect(weightOf(result, "b")).toBeCloseTo(0.25, 6);
    expect(weightOf(result, "c")).toBeCloseTo(0.25, 6);
    expect(weightOf(result, "d")).toBeCloseTo(0.25, 6);
    expect(totalWeight(result)).toBeCloseTo(1, 6);
  });

  it("is deterministic: same input always produces same output", () => {
    const tree = new BlendTree2D(standardRect);
    for (let x = -1; x <= 1; x += 0.25) {
      for (let y = -1; y <= 1; y += 0.25) {
        const r1 = tree.evaluate(x, y);
        const r2 = tree.evaluate(x, y);
        expect(r1).toEqual(r2);
      }
    }
  });
});