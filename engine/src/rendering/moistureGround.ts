/**
 * fe-38: draw a {@link GroundMoistureField} — the ground mesh over the field's patch and the two
 * material maps (albedo, metallic-roughness) the field writes, re-uploaded when it changes.
 *
 * The field is the simulation (environment layer); this is its renderer-side binding. Use it as a
 * standard `Material`'s `albedoMap` / `metallicRoughnessMap` on the mesh from
 * {@link moistureGroundGeometrySource} (UVs span the patch, row 0 = the field's first z row).
 */

import type { GraphicsDevice } from "../gpu/device.js";
import { Texture } from "../resources/texture.js";
import { Geometry, computeNormalsAndTangents, type GeometrySource } from "./geometry.js";
import { Material } from "./material.js";
import type { GroundMoistureField } from "../environment/moistureField.js";

export class MoistureGroundMaps {
  readonly albedo: Texture;
  readonly metallicRoughness: Texture;
  readonly material: Material;
  private readonly albedoData: Uint8Array;
  private readonly mrData: Uint8Array;
  /** Uploads so far (diagnostics). */
  uploads = 0;

  constructor(
    private readonly device: GraphicsDevice,
    readonly field: GroundMoistureField,
    label = "moistureGround",
  ) {
    const n = field.resolution;
    this.albedoData = new Uint8Array(n * n * 4);
    this.mrData = new Uint8Array(n * n * 4);
    field.writeSurfaceMaps(this.albedoData, this.mrData);
    this.albedo = Texture.fromRgba8(device, n, n, this.albedoData, { label: `${label}.albedo`, srgb: true, mipmaps: false });
    this.metallicRoughness = Texture.fromRgba8(device, n, n, this.mrData, { label: `${label}.mr`, mipmaps: false });
    this.material = new Material({ label, color: 0xffffff, roughness: 1, metallic: 1, albedoMap: this.albedo, metallicRoughnessMap: this.metallicRoughness });
  }

  /** Re-render the field into the maps and upload them. */
  upload(): void {
    this.field.writeSurfaceMaps(this.albedoData, this.mrData);
    this.albedo.writeMipData(this.device, 0, 0, this.albedoData);
    this.metallicRoughness.writeMipData(this.device, 0, 0, this.mrData);
    this.uploads++;
  }

  dispose(): void {
    this.material.dispose();
    this.albedo.dispose();
    this.metallicRoughness.dispose();
  }
}

/**
 * Ground mesh over the field's patch: (segments + 1)² vertices at `heightAt`, UV (0..1) across the
 * patch so texel (i, j) of the field's maps lands on cell (i, j).
 */
export function moistureGroundGeometrySource(field: GroundMoistureField, heightAt: (x: number, z: number) => number, segments = field.resolution): GeometrySource {
  const s = Math.max(1, Math.floor(segments));
  const verts = (s + 1) * (s + 1);
  const positions = new Float32Array(verts * 3);
  const uvs = new Float32Array(verts * 2);
  for (let j = 0; j <= s; j++) {
    for (let i = 0; i <= s; i++) {
      const k = j * (s + 1) + i;
      const x = field.originX + (i / s) * field.size;
      const z = field.originZ + (j / s) * field.size;
      positions[k * 3] = x;
      positions[k * 3 + 1] = heightAt(x, z);
      positions[k * 3 + 2] = z;
      uvs[k * 2] = i / s;
      uvs[k * 2 + 1] = j / s;
    }
  }
  const indices = new Uint32Array(s * s * 6);
  let o = 0;
  for (let j = 0; j < s; j++) {
    for (let i = 0; i < s; i++) {
      const a = j * (s + 1) + i;
      const b = a + 1;
      const c = a + s + 1;
      const d = c + 1;
      // Counter-clockwise seen from above (+y).
      indices[o++] = a;
      indices[o++] = c;
      indices[o++] = b;
      indices[o++] = b;
      indices[o++] = c;
      indices[o++] = d;
    }
  }
  const { normals, tangents } = computeNormalsAndTangents(positions, indices, uvs);
  return { positions, normals, uvs, tangents, indices, label: "moistureGround" };
}

export function createMoistureGround(device: GraphicsDevice, field: GroundMoistureField, heightAt: (x: number, z: number) => number, segments?: number): Geometry {
  return Geometry.create(device, moistureGroundGeometrySource(field, heightAt, segments));
}
