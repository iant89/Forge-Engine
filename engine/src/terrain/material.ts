/**
 * Terrain materials — single-material presets plus layered surface blending (Phase 10.8).
 *
 * The renderer still binds one `Material` per chunk today; layered blending is evaluated on the
 * CPU (splat / height / slope weights → colour & surface properties) so demos and tools get the
 * correct look without waiting on a multi-texture terrain shader. The layer descriptors are the
 * contract that shader will consume later.
 */

import { Material, type MaterialOptions } from "../rendering/material.js";
import { Color } from "../math/color.js";
import { clamp } from "../math/scalar.js";

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
      color: options.baseColor ?? new Color(0.68, 0.45, 0.32, 1.0),
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

/** One surface layer with macro/micro variation and height/slope presence ranges. */
export interface TerrainSurfaceLayer {
  name: string;
  color: Color;
  roughness: number;
  metallic: number;
  /** World-height range where the layer is fully present; outside it falls off. */
  heightRange?: readonly [number, number];
  /** Slope (radians) range where the layer is present. */
  slopeRange?: readonly [number, number];
  /** Soft falloff width for height/slope edges (metres / radians). */
  blendWidth?: number;
  /** Macro colour variation amplitude [0,1]. */
  macroVariation?: number;
  /** Micro detail darkening amplitude [0,1]. */
  microDetail?: number;
  /** Optional biome-channel weight index into the 4-weight splat (0=R … 3=A). */
  biomeChannel?: number;
}

export interface LayeredSurfaceSample {
  color: Color;
  roughness: number;
  metallic: number;
  /** Normalised layer weights after height/slope/biome gating. */
  weights: Float32Array;
}

export interface LayeredTerrainMaterialOptions {
  label?: string;
  layers?: TerrainSurfaceLayer[];
}

const DEFAULT_LAYERS: TerrainSurfaceLayer[] = [
  {
    name: "soil",
    color: new Color(0.45, 0.32, 0.22, 1),
    roughness: 0.9,
    metallic: 0.02,
    heightRange: [-50, 80],
    slopeRange: [0, 0.7],
    macroVariation: 0.08,
    microDetail: 0.05,
    biomeChannel: 0,
  },
  {
    name: "rock",
    color: new Color(0.42, 0.4, 0.38, 1),
    roughness: 0.95,
    metallic: 0.05,
    heightRange: [40, 400],
    slopeRange: [0.45, 1.4],
    blendWidth: 0.25,
    macroVariation: 0.06,
    microDetail: 0.1,
    biomeChannel: 1,
  },
  {
    name: "sand",
    color: new Color(0.72, 0.62, 0.42, 1),
    roughness: 0.85,
    metallic: 0.02,
    heightRange: [-20, 40],
    slopeRange: [0, 0.35],
    macroVariation: 0.1,
    microDetail: 0.04,
    biomeChannel: 2,
  },
  {
    name: "snow",
    color: new Color(0.92, 0.94, 0.96, 1),
    roughness: 0.7,
    metallic: 0.01,
    heightRange: [120, 600],
    slopeRange: [0, 0.9],
    blendWidth: 20,
    macroVariation: 0.03,
    microDetail: 0.02,
    biomeChannel: 3,
  },
];

function rangeWeight(value: number, range: readonly [number, number] | undefined, width: number): number {
  if (!range) return 1;
  const [lo, hi] = range;
  const w = Math.max(1e-4, width);
  if (value >= lo && value <= hi) return 1;
  if (value < lo) return clamp(1 - (lo - value) / w, 0, 1);
  return clamp(1 - (value - hi) / w, 0, 1);
}

/**
 * Layered terrain material: evaluates slope/height/biome-weighted surface properties and can produce
 * a single averaged `Material` for the current renderer.
 */
export class LayeredTerrainMaterial {
  readonly label: string;
  readonly layers: TerrainSurfaceLayer[];

  constructor(options: LayeredTerrainMaterialOptions = {}) {
    this.label = options.label ?? "layered-terrain";
    this.layers = (options.layers ?? DEFAULT_LAYERS).map((layer) => ({
      ...layer,
      color: layer.color.clone(),
    }));
  }

  /**
   * Blend layers at a surface point. `biomeWeights` is an optional length-4 splat (R,G,B,A);
   * `macroNoise` / `microNoise` ∈ [0,1] supply macro/micro variation when the caller has them.
   */
  sample(
    height: number,
    slope: number,
    biomeWeights?: ArrayLike<number> | null,
    macroNoise = 0.5,
    microNoise = 0.5,
    out: LayeredSurfaceSample = {
      color: new Color(),
      roughness: 0,
      metallic: 0,
      weights: new Float32Array(this.layers.length),
    },
  ): LayeredSurfaceSample {
    if (out.weights.length !== this.layers.length) {
      out.weights = new Float32Array(this.layers.length);
    }
    let sum = 0;
    for (let i = 0; i < this.layers.length; i++) {
      const layer = this.layers[i]!;
      const width = layer.blendWidth ?? 15;
      let w = rangeWeight(height, layer.heightRange, width) * rangeWeight(slope, layer.slopeRange, width * 0.05);
      if (biomeWeights && layer.biomeChannel !== undefined) {
        w *= biomeWeights[layer.biomeChannel] ?? 0;
      }
      out.weights[i] = w;
      sum += w;
    }
    if (sum <= 1e-8) {
      // Fallback: equal weight so a weird sample never goes black.
      const eq = 1 / this.layers.length;
      for (let i = 0; i < this.layers.length; i++) out.weights[i] = eq;
      sum = 1;
    }
    let r = 0;
    let g = 0;
    let b = 0;
    let roughness = 0;
    let metallic = 0;
    for (let i = 0; i < this.layers.length; i++) {
      const layer = this.layers[i]!;
      const w = out.weights[i]! / sum;
      out.weights[i] = w;
      const macro = 1 + ((macroNoise - 0.5) * 2) * (layer.macroVariation ?? 0);
      const micro = 1 - (microNoise * (layer.microDetail ?? 0));
      const shade = macro * micro;
      r += layer.color.r * shade * w;
      g += layer.color.g * shade * w;
      b += layer.color.b * shade * w;
      roughness += layer.roughness * w;
      metallic += layer.metallic * w;
    }
    out.color.set(clamp(r, 0, 1), clamp(g, 0, 1), clamp(b, 0, 1), 1);
    out.roughness = clamp(roughness, 0, 1);
    out.metallic = clamp(metallic, 0, 1);
    return out;
  }

  /** Bake the blend at a representative point into a single GPU material. */
  toMaterial(height = 30, slope = 0.2, biomeWeights?: ArrayLike<number>): Material {
    const sample = this.sample(height, slope, biomeWeights);
    return new Material({
      label: this.label,
      color: sample.color,
      roughness: sample.roughness,
      metallic: sample.metallic,
      doubleSided: false,
    });
  }
}
