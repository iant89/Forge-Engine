/**
 * Realistic Terrain Materials — PBR material presets for Earth-like biomes.
 *
 * Provides color palettes and material properties that match the 4-channel
 * splat output of ClimateBiomeGenerator:
 *  - R: grass / lowland fertile
 *  - G: rock / cliff
 *  - B: sand / scree / beach
 *  - A: snow / alpine
 *
 * Currently the renderer uses a single material per chunk; these presets
 * give a base color that approximates the blended result. A future shader
 * will sample the biome texture for true splat blending.
 */

import { Material, type MaterialOptions } from "../rendering/material.js";
import { Color } from "../math/color.js";

export interface RealisticMaterialPreset {
  name: string;
  baseColor: Color;
  roughness: number;
  metallic: number;
}

export const REALISTIC_MATERIAL_PRESETS: Record<string, RealisticMaterialPreset> = {
  alpine: {
    name: "alpine",
    baseColor: Color.fromSrgbHex(0x5a7a3a), // grassy with rocky tint
    roughness: 0.92,
    metallic: 0.02,
  },
  "rolling-hills": {
    name: "rolling-hills",
    baseColor: Color.fromSrgbHex(0x6b8c42), // lush green
    roughness: 0.88,
    metallic: 0.01,
  },
  mountainous: {
    name: "mountainous",
    baseColor: Color.fromSrgbHex(0x7a7a6e), // gray-brown rocky
    roughness: 0.94,
    metallic: 0.04,
  },
  canyon: {
    name: "canyon",
    baseColor: Color.fromSrgbHex(0xa67c52), // reddish sandstone
    roughness: 0.90,
    metallic: 0.03,
  },
  archipelago: {
    name: "archipelago",
    baseColor: Color.fromSrgbHex(0xc2b280), // sandy
    roughness: 0.85,
    metallic: 0.02,
  },
  grassland: {
    name: "grassland",
    baseColor: Color.fromSrgbHex(0x5c8a3c),
    roughness: 0.90,
    metallic: 0.01,
  },
  desert: {
    name: "desert",
    baseColor: Color.fromSrgbHex(0xd2b48c),
    roughness: 0.88,
    metallic: 0.02,
  },
  tundra: {
    name: "tundra",
    baseColor: Color.fromSrgbHex(0xc8d8c8),
    roughness: 0.93,
    metallic: 0.01,
  },
};

export function createRealisticTerrainMaterial(
  preset: string | RealisticMaterialPreset = "alpine",
  overrides: Partial<MaterialOptions> = {},
): Material {
  const base =
    typeof preset === "string" ? (REALISTIC_MATERIAL_PRESETS[preset] ?? REALISTIC_MATERIAL_PRESETS.alpine!) : preset;

  return new Material({
    label: `realistic-${base.name}`,
    color: base.baseColor.clone(),
    roughness: base.roughness,
    metallic: base.metallic,
    doubleSided: false,
    ...overrides,
  });
}

/**
 * Utility to blend biome colors for debugging / CPU-side visualization.
 * Given splat weights (wGrass, wRock, wSand, wSnow), returns blended color.
 */
export function blendBiomeColor(
  wGrass: number,
  wRock: number,
  wSand: number,
  wSnow: number,
  out = new Color(),
): Color {
  // Define biome base colors (sRGB)
  const grass = { r: 0.35, g: 0.55, b: 0.22 };
  const rock = { r: 0.45, g: 0.42, b: 0.38 };
  const sand = { r: 0.76, g: 0.70, b: 0.50 };
  const snow = { r: 0.95, g: 0.96, b: 0.98 };

  const r = wGrass * grass.r + wRock * rock.r + wSand * sand.r + wSnow * snow.r;
  const g = wGrass * grass.g + wRock * rock.g + wSand * sand.g + wSnow * snow.g;
  const b = wGrass * grass.b + wRock * rock.b + wSand * sand.b + wSnow * snow.b;

  out.set(r, g, b, 1);
  return out;
}
