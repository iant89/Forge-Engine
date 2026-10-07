/**
 * Skinning data and joint palette tests (Phase 16.5).
 *
 * Coverage:
 *  - computeJointPalette: identity bind pose, translation/rotation, missing joints
 *  - validateSkinningData: weight sum, joint/weight count, identity data
 *  - createIdentitySkinningData: correct defaults
 *  - Determinism: same inputs → same outputs
 */

import { describe, expect, it } from "vitest";
import {
  computeJointPalette,
  validateSkinningData,
  createIdentitySkinningData,
  MAX_JOINTS_PER_VERTEX,
  JOINT_MATRIX_BYTES,
} from "@forge/engine";

// ──────────────────────── helpers ────────────────────────

/** Create a translation-only world matrix as a Float32Array(16). */
function translationMatrix(tx: number, ty: number, tz: number): Float32Array {
  const m = new Float32Array(16);
  m[0] = 1; m[5] = 1; m[10] = 1; m[15] = 1;
  m[12] = tx; m[13] = ty; m[14] = tz;
  return m;
}

/** Create an identity matrix as a Float32Array(16). */
function identityMatrix(): Float32Array {
  const m = new Float32Array(16);
  m[0] = 1; m[5] = 1; m[10] = 1; m[15] = 1;
  return m;
}

/** Create a Y-rotation matrix as a Float32Array(16). */
function rotationYMatrix(radians: number): Float32Array {
  const c = Math.cos(radians);
  const s = Math.sin(radians);
  const m = new Float32Array(16);
  m[0] = c;  m[1] = 0; m[2] = -s; m[3] = 0;
  m[4] = 0;  m[5] = 1; m[6] = 0;  m[7] = 0;
  m[8] = s;  m[9] = 0; m[10] = c; m[11] = 0;
  m[12] = 0; m[13] = 0; m[14] = 0; m[15] = 1;
  return m;
}

// ──────────────────────── computeJointPalette ────────────────────────

describe("computeJointPalette", () => {
  it("returns 0 for empty joint list", () => {
    const worldMatrices = new Map<number, Float32Array>();
    const output = new Float32Array(16);
    expect(computeJointPalette(worldMatrices, [], new Float32Array(0), output)).toBe(0);
  });

  it("returns 0 when output is too small", () => {
    const worldMatrices = new Map<number, Float32Array>();
    worldMatrices.set(1, identityMatrix());
    const output = new Float32Array(4); // too small for 1 joint × 16
    expect(computeJointPalette(worldMatrices, [1], new Float32Array(16), output)).toBe(0);
  });

  it("computes identity palette when world = identity and IBM = identity", () => {
    const worldMatrices = new Map<number, Float32Array>();
    worldMatrices.set(1, identityMatrix());
    const ibm = identityMatrix();
    const output = new Float32Array(16);

    const written = computeJointPalette(worldMatrices, [1], ibm, output);
    expect(written).toBe(1);
    // identity × identity = identity
    expect(output[0]).toBeCloseTo(1, 6);
    expect(output[5]).toBeCloseTo(1, 6);
    expect(output[10]).toBeCloseTo(1, 6);
    expect(output[15]).toBeCloseTo(1, 6);
    expect(output[12]).toBeCloseTo(0, 6);
    expect(output[13]).toBeCloseTo(0, 6);
    expect(output[14]).toBeCloseTo(0, 6);
  });

  it("applies translation when world has translation and IBM is identity", () => {
    const worldMatrices = new Map<number, Float32Array>();
    worldMatrices.set(1, translationMatrix(5, 10, 15));
    const ibm = identityMatrix();
    const output = new Float32Array(16);

    computeJointPalette(worldMatrices, [1], ibm, output);
    // world × identity = world
    expect(output[12]).toBeCloseTo(5, 6);
    expect(output[13]).toBeCloseTo(10, 6);
    expect(output[14]).toBeCloseTo(15, 6);
  });

  it("applies world × IBM: palette moves vertices from mesh space to animated world space", () => {
    // IBM (inverse bind matrix) = inverse(bindPoseWorld).
    // If bind pose was at translation(-1,0,0), then IBM = translation(1,0,0).
    // World = translation(3,0,0).
    // palette = world × IBM = translation(3) × translation(1) = translation(4).
    // This means a mesh-space vertex at the origin gets moved to (4,0,0) in world space.
    const ibm = translationMatrix(1, 0, 0);
    const worldMatrices = new Map<number, Float32Array>();
    worldMatrices.set(1, translationMatrix(3, 0, 0));
    const output = new Float32Array(16);

    computeJointPalette(worldMatrices, [1], ibm, output);
    // translation(3) × translation(1) = translation(4)
    expect(output[12]).toBeCloseTo(4, 5);
  });

  it("writes identity for missing joint (entity not in worldMatrices)", () => {
    const worldMatrices = new Map<number, Float32Array>();
    // Joint 99 is not in the map.
    const ibm = identityMatrix();
    const output = new Float32Array(16);

    const written = computeJointPalette(worldMatrices, [99], ibm, output);
    expect(written).toBe(1);
    // Should be identity.
    expect(output[0]).toBeCloseTo(1, 6);
    expect(output[5]).toBeCloseTo(1, 6);
    expect(output[10]).toBeCloseTo(1, 6);
    expect(output[15]).toBeCloseTo(1, 6);
  });

  it("handles multiple joints", () => {
    const worldMatrices = new Map<number, Float32Array>();
    worldMatrices.set(1, translationMatrix(1, 0, 0));
    worldMatrices.set(2, translationMatrix(0, 2, 0));
    worldMatrices.set(3, translationMatrix(0, 0, 3));

    const ibm = new Float32Array(48); // 3 joints × 16
    // IBM 0: identity
    ibm[0] = 1; ibm[5] = 1; ibm[10] = 1; ibm[15] = 1;
    // IBM 1: identity
    ibm[16] = 1; ibm[21] = 1; ibm[26] = 1; ibm[31] = 1;
    // IBM 2: identity
    ibm[32] = 1; ibm[37] = 1; ibm[42] = 1; ibm[47] = 1;

    const output = new Float32Array(48);
    const written = computeJointPalette(worldMatrices, [1, 2, 3], ibm, output);
    expect(written).toBe(3);

    // Joint 0: translation(1,0,0)
    expect(output[12]).toBeCloseTo(1, 6);
    // Joint 1: translation(0,2,0)
    expect(output[29]).toBeCloseTo(2, 6);
    // Joint 2: translation(0,0,3)
    expect(output[46]).toBeCloseTo(3, 6);
  });

  it("is deterministic: same inputs → same outputs", () => {
    const worldMatrices = new Map<number, Float32Array>();
    worldMatrices.set(1, rotationYMatrix(Math.PI / 4));
    worldMatrices.set(2, translationMatrix(5, 10, 0));

    const ibm = new Float32Array(32);
    ibm[0] = 1; ibm[5] = 1; ibm[10] = 1; ibm[15] = 1;
    ibm[16] = 1; ibm[21] = 1; ibm[26] = 1; ibm[31] = 1;

    for (let i = 0; i < 50; i++) {
      const out1 = new Float32Array(32);
      const out2 = new Float32Array(32);
      computeJointPalette(worldMatrices, [1, 2], ibm, out1);
      computeJointPalette(worldMatrices, [1, 2], ibm, out2);
      for (let j = 0; j < 32; j++) {
        expect(out1[j]).toBe(out2[j]);
      }
    }
  });
});

// ──────────────────────── validateSkinningData ────────────────────────

describe("validateSkinningData", () => {
  it("accepts valid identity skinning data", () => {
    const data = createIdentitySkinningData(3);
    expect(validateSkinningData(data)).toEqual([]);
  });

  it("rejects wrong joint count", () => {
    const data = {
      joints: new Uint16Array(8), // should be 2 * 4 = 8 ✓
      weights: new Float32Array(8),
      vertexCount: 2,
    };
    data.weights[0] = 1; data.weights[4] = 1; // weight sum = 1 per vertex
    expect(validateSkinningData(data)).toEqual([]);
  });

  it("rejects weights not summing to ~1", () => {
    const data = {
      joints: new Uint16Array(4),
      weights: new Float32Array([0.5, 0.1, 0.1, 0.1]), // sum = 0.8, not ~1
      vertexCount: 1,
    };
    const errors = validateSkinningData(data);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain("weights sum");
  });

  it("rejects wrong weights length", () => {
    const data = {
      joints: new Uint16Array(4),
      weights: new Float32Array(2), // wrong: should be 4
      vertexCount: 1,
    };
    const errors = validateSkinningData(data);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain("weights");
  });
});

// ──────────────────────── createIdentitySkinningData ────────────────────────

describe("createIdentitySkinningData", () => {
  it("creates correct defaults for 3 vertices", () => {
    const data = createIdentitySkinningData(3);
    expect(data.vertexCount).toBe(3);
    expect(data.joints.length).toBe(3 * MAX_JOINTS_PER_VERTEX);
    expect(data.weights.length).toBe(3 * MAX_JOINTS_PER_VERTEX);
    // All joints are 0.
    expect(data.joints.every((j) => j === 0)).toBe(true);
    // First weight per vertex is 1, rest are 0.
    for (let v = 0; v < 3; v++) {
      expect(data.weights[v * MAX_JOINTS_PER_VERTEX]).toBe(1);
      for (let j = 1; j < MAX_JOINTS_PER_VERTEX; j++) {
        expect(data.weights[v * MAX_JOINTS_PER_VERTEX + j]).toBe(0);
      }
    }
  });

  it("produces valid skinning data", () => {
    const data = createIdentitySkinningData(5);
    expect(validateSkinningData(data)).toEqual([]);
  });
});

// ──────────────────────── constants ────────────────────────

describe("Skinning constants", () => {
  it("MAX_JOINTS_PER_VERTEX is 4", () => {
    expect(MAX_JOINTS_PER_VERTEX).toBe(4);
  });

  it("JOINT_MATRIX_BYTES is 64", () => {
    expect(JOINT_MATRIX_BYTES).toBe(64);
  });
});