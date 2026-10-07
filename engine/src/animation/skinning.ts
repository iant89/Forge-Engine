/**
 * Skinning data and joint palette computation.
 *
 * GPU skinning requires two things per frame:
 *  1. **Joint palette**: an array of 4×4 matrices (one per joint) that transforms vertices from
 *     bind pose to the current animated pose. Computed as:
 *     `palette[i] = worldMatrix[joint[i]] × inverseBindMatrix[i]`
 *  2. **Per-vertex skinning data**: joint indices (uvec4) and weights (vec4) stored alongside
 *     the mesh geometry.
 *
 * This module provides the CPU-side palette computation and the data layout that the GPU path
 * consumes. The actual GPU upload and vertex shader skinning are renderer integration work
 * (Phase 16.5 follow-up); the palette computation is the deterministic, testable core.
 *
 * Determinism: pure function of (world matrices, inverse bind matrices, joint mapping).
 * No RNG, no global state.
 */

import { Mat4 } from "../math/mat.js";

// Module-level scratch matrix to avoid per-call allocation.
const _scratchResult = new Mat4();

/** Number of joints that can influence one vertex (glTF 2.0 max). */
export const MAX_JOINTS_PER_VERTEX = 4;

/** Bytes per joint in the palette: 16 floats × 4 bytes = 64 bytes. */
export const JOINT_MATRIX_BYTES = 64;

/**
 * Per-vertex skinning data: which joints influence this vertex and by how much.
 *
 * Stored as two separate typed arrays for SoA layout (GPU-friendly).
 */
export interface SkinningVertexData {
  /** Joint indices per vertex: 4 × vertexCount unsigned shorts. */
  joints: Uint16Array;
  /** Blend weights per vertex: 4 × vertexCount floats. */
  weights: Float32Array;
  /** Number of vertices. */
  vertexCount: number;
}

/**
 * Compute the joint palette: an array of 4×4 matrices that transform from bind pose to
 * the current animated pose.
 *
 * @param worldMatrices - World-space matrices for each joint entity (read from the transform
 *   store). Indexed by the *scene entity id*, not the joint ordinal.
 * @param jointEntities - The ordered list of joint entity ids (from SkinBinding.joints).
 * @param inverseBindMatrices - The inverse bind matrices (from SkinBinding.inverseBindMatrices).
 *   16 floats per joint, column-major.
 * @param output - Pre-allocated Float32Array of `jointCount × 16` floats. Written in-place.
 * @returns The number of joints written (0 if the inputs are degenerate).
 */
export function computeJointPalette(
  worldMatrices: Map<number, Float32Array>,
  jointEntities: readonly number[],
  inverseBindMatrices: Float32Array,
  output: Float32Array,
): number {
  const jointCount = jointEntities.length;
  if (jointCount === 0) return 0;
  if (output.length < jointCount * 16) return 0;

  let written = 0;

  for (let i = 0; i < jointCount; i++) {
    const entityId = jointEntities[i]!;
    const world = worldMatrices.get(entityId);
    if (!world) {
      // Missing joint — write identity so the mesh doesn't explode.
      output.fill(0, i * 16, i * 16 + 16);
      output[i * 16 + 0] = 1;
      output[i * 16 + 5] = 1;
      output[i * 16 + 10] = 1;
      output[i * 16 + 15] = 1;
      written++;
      continue;
    }

    const ibmOffset = i * 16;
    // palette[i] = world × inverseBindMatrix[i]
    // Column-major multiply: result = world × ibm
    // Mat4.m is a Float32Array(16); copyFrom copies from another Mat4's .m.
    // We need to create temporary Mat4 views of the raw arrays.
    const worldView = new Mat4(world);
    const ibmView = new Mat4(new Float32Array(inverseBindMatrices.buffer, inverseBindMatrices.byteOffset + ibmOffset * 4, 16));
    _scratchResult.multiplyMatrices(worldView, ibmView);
    output.set(_scratchResult.m, i * 16);
    written++;
  }

  return written;
}

/**
 * Validate skinning vertex data. Returns a list of problems (empty = healthy).
 */
export function validateSkinningData(data: SkinningVertexData): string[] {
  const errors: string[] = [];
  const expectedJoints = data.vertexCount * MAX_JOINTS_PER_VERTEX;
  const expectedWeights = data.vertexCount * MAX_JOINTS_PER_VERTEX;

  if (data.joints.length !== expectedJoints) {
    errors.push(`Expected ${expectedJoints} joint indices, got ${data.joints.length}`);
  }
  if (data.weights.length !== expectedWeights) {
    errors.push(`Expected ${expectedWeights} weights, got ${data.weights.length}`);
  }

  // Check weights sum to ~1 per vertex.
  for (let v = 0; v < data.vertexCount; v++) {
    let sum = 0;
    for (let j = 0; j < MAX_JOINTS_PER_VERTEX; j++) {
      sum += data.weights[v * MAX_JOINTS_PER_VERTEX + j]!;
    }
    if (Math.abs(sum - 1) > 0.01) {
      errors.push(`Vertex ${v}: weights sum to ${sum.toFixed(4)}, expected ~1`);
      break; // one is enough
    }
  }

  return errors;
}

/**
 * Create identity skinning data for a vertex count (all vertices influenced by joint 0 with
 * weight 1). Useful as a default when skinning data is not available.
 */
export function createIdentitySkinningData(vertexCount: number): SkinningVertexData {
  const joints = new Uint16Array(vertexCount * MAX_JOINTS_PER_VERTEX);
  const weights = new Float32Array(vertexCount * MAX_JOINTS_PER_VERTEX);
  for (let v = 0; v < vertexCount; v++) {
    // Joint 0, weight 1 for the first joint; rest are zero.
    weights[v * MAX_JOINTS_PER_VERTEX] = 1;
  }
  return { joints, weights, vertexCount };
}