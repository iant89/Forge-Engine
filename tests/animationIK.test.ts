/**
 * Inverse kinematics tests (Phase 16.4).
 *
 * Coverage:
 *  - TwoBoneIK: straight chain, bend direction, pole target, unreachable target,
 *    weight blending, degenerate chains, zero-length bones
 *  - FABRIK: straight chain, convergence, unreachable target, multi-joint chain,
 *    fixedRoot vs free root, weight blending, tolerance, iteration count
 *  - Determinism: same inputs → same outputs
 */

import { describe, expect, it } from "vitest";
import {
  solveTwoBoneIK,
  solveFABRIK,
  initIdentity,
  NODE_STRIDE,
} from "@forge/engine";

// ──────────────────────── helpers ────────────────────────

/** Create an identity TRS buffer for `nodeCount` nodes. */
function makeTRS(nodeCount: number): Float32Array {
  const buf = new Float32Array(nodeCount * NODE_STRIDE);
  initIdentity(buf, nodeCount);
  return buf;
}

/** Set translation for a node in the TRS buffer. */
function setPos(trs: Float32Array, node: number, x: number, y: number, z: number): void {
  const off = node * NODE_STRIDE;
  trs[off] = x; trs[off + 1] = y; trs[off + 2] = z;
}

/** Get translation for a node from the TRS buffer. */
function getPos(trs: Float32Array, node: number): { x: number; y: number; z: number } {
  const off = node * NODE_STRIDE;
  return { x: trs[off]!, y: trs[off + 1]!, z: trs[off + 2]! };
}

/** Distance between two 3D points. */
function dist(a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }): number {
  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2);
}

// ──────────────────────── TwoBoneIK ────────────────────────

describe("TwoBoneIK", () => {
  it("places the end effector at the target for a straight chain", () => {
    // Root at origin, mid at (0,1,0), end at (0,2,0).
    const trs = makeTRS(3);
    setPos(trs, 0, 0, 0, 0);
    setPos(trs, 1, 0, 1, 0);
    setPos(trs, 2, 0, 2, 0);

    // Target at (1, 1, 0) — reachable (distance from root = √2 ≈ 1.414, chain length = 2).
    solveTwoBoneIK(trs, {
      root: 0, mid: 1, end: 2,
      target: { x: 1, y: 1, z: 0 },
      bendDirection: { x: 0, y: 0, z: 1 }, // bend toward +Z
    });

    const end = getPos(trs, 2);
    expect(dist(end, { x: 1, y: 1, z: 0 })).toBeLessThan(0.01);
  });

  it("preserves bone lengths", () => {
    const trs = makeTRS(3);
    setPos(trs, 0, 0, 0, 0);
    setPos(trs, 1, 0, 1, 0);
    setPos(trs, 2, 0, 2, 0);

    solveTwoBoneIK(trs, {
      root: 0, mid: 1, end: 2,
      target: { x: 1.5, y: 0.5, z: 0 },
      bendDirection: { x: 0, y: 0, z: -1 },
    });

    const root = getPos(trs, 0);
    const mid = getPos(trs, 1);
    const end = getPos(trs, 2);

    const upperLen = dist(root, mid);
    const lowerLen = dist(mid, end);

    expect(upperLen).toBeCloseTo(1, 3);
    expect(lowerLen).toBeCloseTo(1, 3);
  });

  it("stretches toward unreachable targets", () => {
    const trs = makeTRS(3);
    setPos(trs, 0, 0, 0, 0);
    setPos(trs, 1, 0, 1, 0);
    setPos(trs, 2, 0, 2, 0);

    solveTwoBoneIK(trs, {
      root: 0, mid: 1, end: 2,
      target: { x: 0, y: 100, z: 0 }, // way beyond reach
    });

    const end = getPos(trs, 2);
    // End should be close to the max reach (2.0) from root.
    expect(dist(end, { x: 0, y: 0, z: 0 })).toBeCloseTo(2, 1);
  });

  it("uses pole target to control bend direction", () => {
    // Without a pole target, the mid joint stays in the XY plane.
    const trsNoPole = makeTRS(3);
    setPos(trsNoPole, 0, 0, 0, 0);
    setPos(trsNoPole, 1, 0, 1, 0);
    setPos(trsNoPole, 2, 0, 2, 0);
    solveTwoBoneIK(trsNoPole, {
      root: 0, mid: 1, end: 2,
      target: { x: 1, y: 1, z: 0 },
    });
    const midNoPole = getPos(trsNoPole, 1);

    // With a pole target off the XY plane, the mid joint should move out of the plane.
    const trsPole = makeTRS(3);
    setPos(trsPole, 0, 0, 0, 0);
    setPos(trsPole, 1, 0, 1, 0);
    setPos(trsPole, 2, 0, 2, 0);
    solveTwoBoneIK(trsPole, {
      root: 0, mid: 1, end: 2,
      target: { x: 1, y: 1, z: 0 },
      poleTarget: { x: 0, y: 1, z: 5 },
    });
    const midPole = getPos(trsPole, 1);

    // The pole-targeted mid joint should have a different Z than the no-pole case.
    expect(Math.abs(midPole.z)).toBeGreaterThan(Math.abs(midNoPole.z) + 0.01);
  });

  it("weight 0 does not modify the buffer", () => {
    const trs = makeTRS(3);
    setPos(trs, 0, 0, 0, 0);
    setPos(trs, 1, 0, 1, 0);
    setPos(trs, 2, 0, 2, 0);

    const originalMid = getPos(trs, 1);
    const originalEnd = getPos(trs, 2);

    solveTwoBoneIK(trs, {
      root: 0, mid: 1, end: 2,
      target: { x: 1, y: 1, z: 0 },
      weight: 0,
    });

    expect(getPos(trs, 1)).toEqual(originalMid);
    expect(getPos(trs, 2)).toEqual(originalEnd);
  });

  it("weight 0.5 blends halfway", () => {
    const trs = makeTRS(3);
    setPos(trs, 0, 0, 0, 0);
    setPos(trs, 1, 0, 1, 0);
    setPos(trs, 2, 0, 2, 0);

    const originalEnd = getPos(trs, 2);

    solveTwoBoneIK(trs, {
      root: 0, mid: 1, end: 2,
      target: { x: 1, y: 1, z: 0 },
      bendDirection: { x: 0, y: 0, z: 1 },
      weight: 0.5,
    });

    const end = getPos(trs, 2);
    // Should be between original (0,2,0) and the full IK result.
    // With weight 0.5 the end moves halfway, so it should differ from the original.
    expect(end.y).not.toBeCloseTo(originalEnd.y, 1);
    // But not as far as the full IK result.
    expect(Math.abs(end.y - originalEnd.y)).toBeLessThan(1.0);
  });

  it("handles zero-length bones gracefully (no crash)", () => {
    const trs = makeTRS(3);
    setPos(trs, 0, 0, 0, 0);
    setPos(trs, 1, 0, 0, 0); // zero-length upper
    setPos(trs, 2, 0, 0, 0);

    // Should not throw.
    solveTwoBoneIK(trs, {
      root: 0, mid: 1, end: 2,
      target: { x: 1, y: 1, z: 0 },
    });
  });

  it("is deterministic: same input → same output", () => {
    for (let i = 0; i < 50; i++) {
      const trs1 = makeTRS(3);
      setPos(trs1, 0, 0, 0, 0);
      setPos(trs1, 1, 0, 1, 0);
      setPos(trs1, 2, 0, 2, 0);

      const trs2 = new Float32Array(trs1);

      solveTwoBoneIK(trs1, {
        root: 0, mid: 1, end: 2,
        target: { x: 0.5, y: 1.5, z: 0.3 },
        bendDirection: { x: 0, y: 0, z: 1 },
      });
      solveTwoBoneIK(trs2, {
        root: 0, mid: 1, end: 2,
        target: { x: 0.5, y: 1.5, z: 0.3 },
        bendDirection: { x: 0, y: 0, z: 1 },
      });

      for (let j = 0; j < trs1.length; j++) {
        expect(trs1[j]).toBe(trs2[j]);
      }
    }
  });
});

// ──────────────────────── FABRIK ────────────────────────

describe("FABRIK", () => {
  it("solves a 2-joint chain (same as two-bone IK)", () => {
    const trs = makeTRS(3);
    setPos(trs, 0, 0, 0, 0);
    setPos(trs, 1, 0, 1, 0);
    setPos(trs, 2, 0, 2, 0);

    const iters = solveFABRIK(trs, {
      chain: [0, 1, 2],
      target: { x: 1, y: 1, z: 0 },
    });

    const end = getPos(trs, 2);
    expect(dist(end, { x: 1, y: 1, z: 0 })).toBeLessThan(0.01);
    expect(iters).toBeGreaterThan(0);
  });

  it("preserves bone lengths after solving", () => {
    const trs = makeTRS(4);
    setPos(trs, 0, 0, 0, 0);
    setPos(trs, 1, 0, 1, 0);
    setPos(trs, 2, 0, 2, 0);
    setPos(trs, 3, 0, 3, 0);

    const boneLen01 = 1, boneLen12 = 1, boneLen23 = 1;

    solveFABRIK(trs, {
      chain: [0, 1, 2, 3],
      target: { x: 2, y: 1, z: 0 },
    });

    const p0 = getPos(trs, 0);
    const p1 = getPos(trs, 1);
    const p2 = getPos(trs, 2);
    const p3 = getPos(trs, 3);

    expect(dist(p0, p1)).toBeCloseTo(boneLen01, 3);
    expect(dist(p1, p2)).toBeCloseTo(boneLen12, 3);
    expect(dist(p2, p3)).toBeCloseTo(boneLen23, 3);
  });

  it("stretches toward unreachable targets", () => {
    const trs = makeTRS(3);
    setPos(trs, 0, 0, 0, 0);
    setPos(trs, 1, 0, 1, 0);
    setPos(trs, 2, 0, 2, 0);

    solveFABRIK(trs, {
      chain: [0, 1, 2],
      target: { x: 0, y: 100, z: 0 },
    });

    const end = getPos(trs, 2);
    // Should stretch toward the target (end.y ≈ 2, pointing upward).
    expect(end.y).toBeGreaterThan(1.5);
  });

  it("keeps the root fixed when fixedRoot is true (default)", () => {
    const trs = makeTRS(3);
    setPos(trs, 0, 1, 2, 3);
    setPos(trs, 1, 1, 3, 3);
    setPos(trs, 2, 1, 4, 3);

    solveFABRIK(trs, {
      chain: [0, 1, 2],
      target: { x: 3, y: 2, z: 0 },
    });

    const root = getPos(trs, 0);
    expect(root.x).toBeCloseTo(1, 4);
    expect(root.y).toBeCloseTo(2, 4);
    expect(root.z).toBeCloseTo(3, 4);
  });

  it("allows the root to move when fixedRoot is false", () => {
    const trs = makeTRS(3);
    setPos(trs, 0, 0, 0, 0);
    setPos(trs, 1, 0, 1, 0);
    setPos(trs, 2, 0, 2, 0);

    solveFABRIK(trs, {
      chain: [0, 1, 2],
      target: { x: 5, y: 5, z: 0 },
      fixedRoot: false,
    });

    // With free root, the chain should have moved toward the target.
    const end = getPos(trs, 2);
    expect(dist(end, { x: 5, y: 5, z: 0 })).toBeLessThan(0.01);
  });

  it("converges immediately when the chain is already at the target", () => {
    const trs = makeTRS(3);
    setPos(trs, 0, 0, 0, 0);
    setPos(trs, 1, 0, 1, 0);
    setPos(trs, 2, 0, 2, 0);

    const iters = solveFABRIK(trs, {
      chain: [0, 1, 2],
      target: { x: 0, y: 2, z: 0 }, // end is already here
    });

    // FABRIK does at least one iteration pass to verify convergence.
    expect(iters).toBeLessThanOrEqual(1);
    const end = getPos(trs, 2);
    expect(dist(end, { x: 0, y: 2, z: 0 })).toBeLessThan(0.01);
  });

  it("respects maxIterations", () => {
    const trs = makeTRS(5);
    setPos(trs, 0, 0, 0, 0);
    setPos(trs, 1, 1, 0, 0);
    setPos(trs, 2, 2, 0, 0);
    setPos(trs, 3, 3, 0, 0);
    setPos(trs, 4, 4, 0, 0);

    const iters = solveFABRIK(trs, {
      chain: [0, 1, 2, 3, 4],
      target: { x: 0, y: 0, z: 5 },
      maxIterations: 3,
    });

    expect(iters).toBeLessThanOrEqual(3);
  });

  it("weight 0 does not modify the buffer", () => {
    const trs = makeTRS(3);
    setPos(trs, 0, 0, 0, 0);
    setPos(trs, 1, 0, 1, 0);
    setPos(trs, 2, 0, 2, 0);

    const original = new Float32Array(trs);

    solveFABRIK(trs, {
      chain: [0, 1, 2],
      target: { x: 1, y: 1, z: 0 },
      weight: 0,
    });

    for (let i = 0; i < trs.length; i++) {
      expect(trs[i]).toBe(original[i]);
    }
  });

  it("handles a chain shorter than 2 joints (no-op)", () => {
    const trs = makeTRS(1);
    setPos(trs, 0, 0, 0, 0);

    const iters = solveFABRIK(trs, {
      chain: [0],
      target: { x: 5, y: 5, z: 0 },
    });

    expect(iters).toBe(0);
    expect(getPos(trs, 0)).toEqual({ x: 0, y: 0, z: 0 });
  });

  it("is deterministic: same input → same output", () => {
    for (let i = 0; i < 50; i++) {
      const trs1 = makeTRS(4);
      setPos(trs1, 0, 0, 0, 0);
      setPos(trs1, 1, 1, 0, 0);
      setPos(trs1, 2, 2, 0, 0);
      setPos(trs1, 3, 3, 0, 0);

      const trs2 = new Float32Array(trs1);

      solveFABRIK(trs1, { chain: [0, 1, 2, 3], target: { x: 1, y: 2, z: 0.5 } });
      solveFABRIK(trs2, { chain: [0, 1, 2, 3], target: { x: 1, y: 2, z: 0.5 } });

      for (let j = 0; j < trs1.length; j++) {
        expect(trs1[j]).toBe(trs2[j]);
      }
    }
  });
});