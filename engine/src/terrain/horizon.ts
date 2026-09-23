/**
 * Horizon skirt — a low-poly apron around the loaded terrain disc (Phase 10.6).
 *
 * The resident chunk skirts hide LOD T-junctions; this ring hides the *edge of the loaded disc*
 * by dropping an outer lip below the fog line so no cliff of missing chunks is visible.
 */

import { AABB } from "../math/geometry.js";
import { Vec3 } from "../math/vec.js";
import type { GeometrySource } from "../rendering/geometry.js";

export interface HorizonSkirtOptions {
  centerX: number;
  centerZ: number;
  /** Radius of the loaded/visible disc (metres). */
  innerRadius: number;
  /** How far past the disc the apron extends. */
  outerExtent: number;
  /** Radial / circumferential segments. */
  radialSegments?: number;
  ringSegments?: number;
  /** How far the outer lip drops below the sampled rim height. */
  dropDepth?: number;
  /** Height at world XZ (usually TerrainWorld.getHeightAt). */
  sampleHeight: (x: number, z: number) => number;
}

/**
 * Build a two-ring apron: inner ring follows terrain height at `innerRadius`, outer ring sits at
 * the same XZ-offset with Y dropped by `dropDepth`. CW winding matches the engine's front face.
 */
export function buildHorizonSkirt(options: HorizonSkirtOptions): GeometrySource {
  const radialSegments = Math.max(1, options.radialSegments ?? 1);
  const ringSegments = Math.max(8, options.ringSegments ?? 64);
  const dropDepth = options.dropDepth ?? 80;
  const outerRadius = options.innerRadius + Math.max(1, options.outerExtent);

  const rings = radialSegments + 1;
  const vertsPerRing = ringSegments;
  const vertexCount = rings * vertsPerRing;
  const positions = new Float32Array(vertexCount * 3);
  const normals = new Float32Array(vertexCount * 3);
  const uvs = new Float32Array(vertexCount * 2);
  const tangents = new Float32Array(vertexCount * 4);

  let minY = Infinity;
  let maxY = -Infinity;

  for (let r = 0; r < rings; r++) {
    const t = r / (rings - 1 || 1);
    const radius = options.innerRadius + (outerRadius - options.innerRadius) * t;
    for (let i = 0; i < vertsPerRing; i++) {
      const angle = (i / vertsPerRing) * Math.PI * 2;
      const x = options.centerX + Math.cos(angle) * radius;
      const z = options.centerZ + Math.sin(angle) * radius;
      const rimH = options.sampleHeight(
        options.centerX + Math.cos(angle) * options.innerRadius,
        options.centerZ + Math.sin(angle) * options.innerRadius,
      );
      const y = rimH - dropDepth * t;
      const idx = r * vertsPerRing + i;
      positions[idx * 3] = x;
      positions[idx * 3 + 1] = y;
      positions[idx * 3 + 2] = z;
      // Outward-ish normal so lighting doesn't go black on the apron.
      const nx = Math.cos(angle) * 0.35;
      const ny = 0.9;
      const nz = Math.sin(angle) * 0.35;
      const len = Math.hypot(nx, ny, nz) || 1;
      normals[idx * 3] = nx / len;
      normals[idx * 3 + 1] = ny / len;
      normals[idx * 3 + 2] = nz / len;
      uvs[idx * 2] = i / vertsPerRing;
      uvs[idx * 2 + 1] = t;
      tangents[idx * 4] = -Math.sin(angle);
      tangents[idx * 4 + 1] = 0;
      tangents[idx * 4 + 2] = Math.cos(angle);
      tangents[idx * 4 + 3] = -1;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }

  const quadCount = radialSegments * ringSegments;
  const indices = new Uint32Array(quadCount * 6);
  let iOff = 0;
  for (let r = 0; r < radialSegments; r++) {
    for (let i = 0; i < ringSegments; i++) {
      const i0 = r * vertsPerRing + i;
      const i1 = r * vertsPerRing + ((i + 1) % vertsPerRing);
      const i2 = (r + 1) * vertsPerRing + i;
      const i3 = (r + 1) * vertsPerRing + ((i + 1) % vertsPerRing);
      // CW
      indices[iOff++] = i0;
      indices[iOff++] = i3;
      indices[iOff++] = i1;
      indices[iOff++] = i0;
      indices[iOff++] = i2;
      indices[iOff++] = i3;
    }
  }

  const pad = outerRadius + 1;
  const bounds = new AABB(
    new Vec3(options.centerX - pad, minY - 1, options.centerZ - pad),
    new Vec3(options.centerX + pad, maxY + 1, options.centerZ + pad),
  );

  return {
    positions,
    normals,
    uvs,
    tangents,
    indices,
    bounds,
    label: "terrain-horizon-skirt",
  };
}
