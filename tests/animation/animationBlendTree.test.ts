/**
 * @suite animation:animationBlendTree
 * @group unit
 * @covers engine/src/animation/blendTree.ts
 * @covers engine/src/index.ts
 * @desc Blend tree tests (Phase 16.3)
 */

export const suite = {
  name: "animation:animationBlendTree",
  group: "unit",
  covers:   [
    "engine/src/animation/blendTree.ts",
    "engine/src/index.ts"
  ],
  desc: "Blend tree tests (Phase 16.3)",
};
/**
 * Blend tree tests (Phase 16.3).
 *
 * Coverage:
 *  - BlendTree1D: two-clip, three-clip, boundary values, out-of-range clamping, single clip
 *  - BlendTree2D: centre, corners, edges, out-of-range clamping, non-unit rectangle
 *  - Weight invariant: all weights sum to 1
 *  - Determinism: same inputs → same outputs
 */

import assert from "node:assert/strict";
import { assertCloseTo, finish, group, test } from "selrun";
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

group("BlendTree1D", () => {
  test("returns single clip when only one entry exists", () => {
    const tree = new BlendTree1D([{ name: "idle", threshold: 0 }]);
    const result = tree.evaluate(0.5);
    assert.deepEqual(result, [{ name: "idle", weight: 1 }]);
  });

  test("returns first clip when param is at or below first threshold", () => {
    const tree = new BlendTree1D([
      { name: "idle", threshold: 0 },
      { name: "walk", threshold: 1 },
    ]);
    assert.deepEqual(tree.evaluate(-1), [{ name: "idle", weight: 1 }]);
    assert.deepEqual(tree.evaluate(0), [{ name: "idle", weight: 1 }]);
  });

  test("returns last clip when param is at or above last threshold", () => {
    const tree = new BlendTree1D([
      { name: "idle", threshold: 0 },
      { name: "walk", threshold: 1 },
    ]);
    assert.deepEqual(tree.evaluate(1), [{ name: "walk", weight: 1 }]);
    assert.deepEqual(tree.evaluate(2), [{ name: "walk", weight: 1 }]);
  });

  test("linearly interpolates between two clips", () => {
    const tree = new BlendTree1D([
      { name: "idle", threshold: 0 },
      { name: "walk", threshold: 1 },
    ]);
    const result = tree.evaluate(0.5);
    assertCloseTo(weightOf(result, "idle"), 0.5, 6);
    assertCloseTo(weightOf(result, "walk"), 0.5, 6);
    assertCloseTo(totalWeight(result), 1, 6);
  });

  test("interpolates the correct pair in a three-clip tree", () => {
    const tree = new BlendTree1D([
      { name: "idle", threshold: 0 },
      { name: "walk", threshold: 0.5 },
      { name: "run", threshold: 1.0 },
    ]);

    // At 0.75: between walk (0.5) and run (1.0), alpha = 0.5
    const result = tree.evaluate(0.75);
    assertCloseTo(weightOf(result, "idle"), 0, 6);
    assertCloseTo(weightOf(result, "walk"), 0.5, 6);
    assertCloseTo(weightOf(result, "run"), 0.5, 6);
    assertCloseTo(totalWeight(result), 1, 6);
  });

  test("handles unsorted entries (sorts by threshold)", () => {
    const tree = new BlendTree1D([
      { name: "run", threshold: 1.0 },
      { name: "idle", threshold: 0 },
      { name: "walk", threshold: 0.5 },
    ]);
    const result = tree.evaluate(0.25);
    assertCloseTo(weightOf(result, "idle"), 0.5, 6);
    assertCloseTo(weightOf(result, "walk"), 0.5, 6);
    assertCloseTo(weightOf(result, "run"), 0, 6);
  });

  test("handles non-uniform thresholds", () => {
    const tree = new BlendTree1D([
      { name: "a", threshold: 0 },
      { name: "b", threshold: 0.25 },
      { name: "c", threshold: 1.0 },
    ]);
    // At 0.625: between b (0.25) and c (1.0), alpha = (0.625-0.25)/0.75 = 0.5
    const result = tree.evaluate(0.625);
    assertCloseTo(weightOf(result, "b"), 0.5, 6);
    assertCloseTo(weightOf(result, "c"), 0.5, 6);
  });

  test("returns empty array for empty tree", () => {
    const tree = new BlendTree1D([]);
    assert.deepEqual(tree.evaluate(0.5), []);
  });

  test("exposes min/max threshold and clip count", () => {
    const tree = new BlendTree1D([
      { name: "a", threshold: -1 },
      { name: "b", threshold: 2 },
    ]);
    assert.equal(tree.minThreshold, -1);
    assert.equal(tree.maxThreshold, 2);
    assert.equal(tree.clipCount, 2);
  });

  test("is deterministic: same input always produces same output", () => {
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
      assert.deepEqual(r1, r2);
    }
  });
});

// ──────────────────────── BlendTree2D ────────────────────────

group("BlendTree2D", () => {
  const standardRect = {
    bottomLeft:  { name: "walkLeft",  x: -1, y: -1 },
    bottomRight: { name: "walkRight", x: +1, y: -1 },
    topLeft:     { name: "runLeft",   x: -1, y: +1 },
    topRight:    { name: "runRight",  x: +1, y: +1 },
  };

  test("returns equal weights at the centre", () => {
    const tree = new BlendTree2D(standardRect);
    const result = tree.evaluate(0, 0);
    assertCloseTo(weightOf(result, "walkLeft"), 0.25, 6);
    assertCloseTo(weightOf(result, "walkRight"), 0.25, 6);
    assertCloseTo(weightOf(result, "runLeft"), 0.25, 6);
    assertCloseTo(weightOf(result, "runRight"), 0.25, 6);
    assertCloseTo(totalWeight(result), 1, 6);
  });

  test("returns full weight at bottom-left corner", () => {
    const tree = new BlendTree2D(standardRect);
    const result = tree.evaluate(-1, -1);
    assertCloseTo(weightOf(result, "walkLeft"), 1, 6);
    assertCloseTo(weightOf(result, "walkRight"), 0, 6);
    assertCloseTo(weightOf(result, "runLeft"), 0, 6);
    assertCloseTo(weightOf(result, "runRight"), 0, 6);
  });

  test("returns full weight at top-right corner", () => {
    const tree = new BlendTree2D(standardRect);
    const result = tree.evaluate(1, 1);
    assertCloseTo(weightOf(result, "runRight"), 1, 6);
    assertCloseTo(weightOf(result, "walkLeft"), 0, 6);
  });

  test("interpolates along the bottom edge", () => {
    const tree = new BlendTree2D(standardRect);
    const result = tree.evaluate(0, -1); // centre of bottom edge
    assertCloseTo(weightOf(result, "walkLeft"), 0.5, 6);
    assertCloseTo(weightOf(result, "walkRight"), 0.5, 6);
    assertCloseTo(weightOf(result, "runLeft"), 0, 6);
    assertCloseTo(weightOf(result, "runRight"), 0, 6);
    assertCloseTo(totalWeight(result), 1, 6);
  });

  test("interpolates along the left edge", () => {
    const tree = new BlendTree2D(standardRect);
    const result = tree.evaluate(-1, 0); // centre of left edge
    assertCloseTo(weightOf(result, "walkLeft"), 0.5, 6);
    assertCloseTo(weightOf(result, "runLeft"), 0.5, 6);
    assertCloseTo(weightOf(result, "walkRight"), 0, 6);
    assertCloseTo(weightOf(result, "runRight"), 0, 6);
  });

  test("clamps to rectangle extents", () => {
    const tree = new BlendTree2D(standardRect);
    // Outside the rectangle.
    const result = tree.evaluate(5, 5);
    assertCloseTo(weightOf(result, "runRight"), 1, 6);
    assertCloseTo(totalWeight(result), 1, 6);
  });

  test("clamps negative out-of-range", () => {
    const tree = new BlendTree2D(standardRect);
    const result = tree.evaluate(-5, -5);
    assertCloseTo(weightOf(result, "walkLeft"), 1, 6);
    assertCloseTo(totalWeight(result), 1, 6);
  });

  test("works with non-unit rectangle", () => {
    const tree = new BlendTree2D({
      bottomLeft:  { name: "a", x: 0, y: 0 },
      bottomRight: { name: "b", x: 10, y: 0 },
      topLeft:     { name: "c", x: 0, y: 10 },
      topRight:    { name: "d", x: 10, y: 10 },
    });
    // At (5, 5) = centre of [0,10]×[0,10]
    const result = tree.evaluate(5, 5);
    assertCloseTo(weightOf(result, "a"), 0.25, 6);
    assertCloseTo(weightOf(result, "b"), 0.25, 6);
    assertCloseTo(weightOf(result, "c"), 0.25, 6);
    assertCloseTo(weightOf(result, "d"), 0.25, 6);
    assertCloseTo(totalWeight(result), 1, 6);
  });

  test("is deterministic: same input always produces same output", () => {
    const tree = new BlendTree2D(standardRect);
    for (let x = -1; x <= 1; x += 0.25) {
      for (let y = -1; y <= 1; y += 0.25) {
        const r1 = tree.evaluate(x, y);
        const r2 = tree.evaluate(x, y);
        assert.deepEqual(r1, r2);
      }
    }
  });
});

await finish();
