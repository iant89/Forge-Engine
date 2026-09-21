/**
 * `TerrainMaterial` — terrain PBR material configuration.
 */

import { Material, type MaterialOptions } from "../rendering/material.js";
import { Color } from "../math/color.js";

export interface TerrainMaterialOptions {
  label?: string;
  baseColor?: number | Color;
  roughness?: number;
  metallic?: number;
}

export class TerrainMaterial {
  readonly material: Material;

  constructor(options: TerrainMaterialOptions = {}) {
    const matOpts: MaterialOptions = {
      label: options.label ?? "terrain-material",
      color: options.baseColor ?? new Color(0.68, 0.45, 0.32, 1.0), // Martian terra-cotta tint
      roughness: options.roughness ?? 0.85,
      metallic: options.metallic ?? 0.05,
      doubleSided: false,
    };
    this.material = new Material(matOpts);
  }

  dispose(): void {
    this.material.dispose();
  }
}
