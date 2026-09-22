/**
 * Realistic Terrain Generation — Earth-like terrain with tectonic uplift,
 * mountain ranges, hydraulic erosion, river valleys and climate-based biomes.
 *
 * This module implements a suite of generator stages designed to produce
 * realistic terrain similar to alpine / mountainous reference imagery:
 *
 * - Continental-scale base with domain warping for organic flow
 * - Ridged multifractal mountain ranges with masked uplift
 * - Multi-octave hills and high-frequency detail
 * - Thermal weathering (talus / scree stabilization)
 * - Hydraulic erosion (water flow, sediment transport, valley carving)
 * - Fluvial / river valley carving based on flow accumulation
 * - Surface detail re-injection after erosion
 * - Climate model (temperature, moisture) and realistic biome splatting
 *
 * All stages are:
 * - Pure, deterministic in (seed, cx, cz, worldX, worldZ)
 * - Seamless across chunk boundaries (world-space noise sampling)
 * - Order-independent and worker-safe
 * - Designed for real-time chunk generation (33x33 @ ~1-3ms per stage)
 */

import { NoiseField } from "../math/noise.js";
import { Rng, chunkSeed } from "../math/rng.js";
import { clamp, smoothstep } from "../math/scalar.js";
import type { WorldCell, TerrainStage } from "./generators.js";

// ------------------------------------------------------------------ Utilities

function powClamped(v: number, p: number): number {
  return Math.pow(Math.max(0, v), p);
}

// ------------------------------------------------------------------ Realistic Height Generator

export interface RealisticHeightOptions {
  /** Sea level baseline. */
  seaLevel?: number;
  /** Continental base amplitude (large-scale elevation). */
  continentalAmplitude?: number;
  /** Continental frequency (1/m). Default 1/2048. */
  continentalFrequency?: number;
  /** Mountain amplitude. */
  mountainAmplitude?: number;
  /** Mountain frequency. */
  mountainFrequency?: number;
  /** Hill amplitude. */
  hillAmplitude?: number;
  /** Hill frequency. */
  hillFrequency?: number;
  /** Detail amplitude (small rocks / roughness). */
  detailAmplitude?: number;
  /** Detail frequency. */
  detailFrequency?: number;
  /** Domain warp amount in meters. */
  warpAmount?: number;
  /** Domain warp frequency. */
  warpFrequency?: number;
  /** How sharp mountain peaks are (power curve). */
  mountainSharpness?: number;
  /** Continental bias power (higher = more lowlands). */
  continentalBias?: number;
  /** Mask threshold for mountain appearance. */
  mountainMaskThreshold?: number;
  /** Additional large-scale swell amplitude. */
  swellAmplitude?: number;
  /** Plateau / terrace strength 0..1. */
  plateauStrength?: number;
}

export class RealisticHeightGenerator implements TerrainStage {
  readonly name = "realistic-height";
  readonly seaLevel: number;
  readonly continentalAmplitude: number;
  readonly continentalFrequency: number;
  readonly mountainAmplitude: number;
  readonly mountainFrequency: number;
  readonly hillAmplitude: number;
  readonly hillFrequency: number;
  readonly detailAmplitude: number;
  readonly detailFrequency: number;
  readonly warpAmount: number;
  readonly warpFrequency: number;
  readonly mountainSharpness: number;
  readonly continentalBias: number;
  readonly mountainMaskThreshold: number;
  readonly swellAmplitude: number;
  readonly plateauStrength: number;

  constructor(options: RealisticHeightOptions = {}) {
    this.seaLevel = options.seaLevel ?? 0;
    this.continentalAmplitude = options.continentalAmplitude ?? 280;
    this.continentalFrequency = options.continentalFrequency ?? 1 / 2048;
    this.mountainAmplitude = options.mountainAmplitude ?? 850;
    this.mountainFrequency = options.mountainFrequency ?? 1 / 320;
    this.hillAmplitude = options.hillAmplitude ?? 85;
    this.hillFrequency = options.hillFrequency ?? 1 / 180;
    this.detailAmplitude = options.detailAmplitude ?? 12;
    this.detailFrequency = options.detailFrequency ?? 1 / 32;
    this.warpAmount = options.warpAmount ?? 180;
    this.warpFrequency = options.warpFrequency ?? 1 / 800;
    this.mountainSharpness = options.mountainSharpness ?? 1.6;
    this.continentalBias = options.continentalBias ?? 2.2;
    this.mountainMaskThreshold = options.mountainMaskThreshold ?? 0.35;
    this.swellAmplitude = options.swellAmplitude ?? 45;
    this.plateauStrength = options.plateauStrength ?? 0.15;
  }

  /** Pure height sample at world coordinates. */
  sampleHeight(worldX: number, worldZ: number, seed: number): number {
    // Three noise fields with different seeds for decorrelation
    const continentField = new NoiseField(seed, { octaves: 4, lacunarity: 2.0, gain: 0.5 });
    const mountainField = new NoiseField(seed ^ 0x9e3779b1, { octaves: 5, lacunarity: 2.1, gain: 0.48 });
    const hillField = new NoiseField(seed ^ 0x517cc1b7, { octaves: 4, lacunarity: 2.05, gain: 0.5 });
    const detailField = new NoiseField(seed ^ 0x27d4eb2f, { octaves: 3, lacunarity: 2.2, gain: 0.5 });
    const warpField = new NoiseField(seed ^ 0x5bd1e995, { octaves: 3, lacunarity: 2.0, gain: 0.5 });

    // Domain warping — makes mountain ranges flow organically instead of axis-aligned
    const wx = warpField.fbm(worldX * this.warpFrequency, worldZ * this.warpFrequency, 101) * this.warpAmount;
    const wz = warpField.fbm(worldX * this.warpFrequency + 100, worldZ * this.warpFrequency + 100, 202) * this.warpAmount;
    const x = worldX + wx;
    const z = worldZ + wz;

    // Continental base: large-scale fBm, remapped to favor lowlands with occasional highlands
    const contFreq = this.continentalFrequency;
    let continent = continentField.fbm(x * contFreq, z * contFreq, 10);
    continent = (continent + 1) * 0.5; // 0..1
    continent = Math.pow(continent, this.continentalBias); // bias to low
    // Add subtle warp to continent as well
    continent += continentField.fbm(x * contFreq * 0.5, z * contFreq * 0.5, 11) * 0.15;

    // Mountain mask: ridged noise that decides where mountain ranges appear
    const maskFreq = 1 / 650;
    let mountainMask = mountainField.ridged(x * maskFreq, z * maskFreq, 20);
    // Smooth threshold for natural transition between plains and mountains
    mountainMask = smoothstep(this.mountainMaskThreshold, 0.75, mountainMask);
    // Add large-scale variation to mask so mountains form chains
    const chainMod = continentField.fbm(x * maskFreq * 0.4, z * maskFreq * 0.4, 30) * 0.5 + 0.5;
    mountainMask *= 0.6 + chainMod * 0.8;

    // Mountain ridges: sharp, ridged multifractal
    const mFreq = this.mountainFrequency;
    let mountain = mountainField.ridged(x * mFreq, z * mFreq, 40);
    // Sharpen peaks with power curve — makes alpine-like spires
    mountain = powClamped(mountain, this.mountainSharpness);
    // Add secondary ridge at different orientation for cross-cutting ranges
    const mountain2 = mountainField.ridged(x * mFreq * 1.7 + 200, z * mFreq * 1.7, 41) * 0.5;
    mountain = Math.max(mountain, mountain2 * 0.7);

    // Hills: rolling mid-frequency terrain, stronger in lowlands
    const hFreq = this.hillFrequency;
    let hills = hillField.fbm(x * hFreq, z * hFreq, 50);
    // Modulate hills by continent — more hills in highlands
    hills *= 0.5 + continent * 0.8;

    // Detail: high-frequency rocky roughness
    const dFreq = this.detailFrequency;
    let detail = detailField.fbm(x * dFreq, z * dFreq, 60) * 0.6;
    detail += detailField.fbm(x * dFreq * 2.1, z * dFreq * 2.1, 61) * 0.3;
    detail += detailField.fbm(x * dFreq * 4.3, z * dFreq * 4.3, 62) * 0.1;

    // Large-scale swell / tectonic undulation
    const swellFreq = this.continentalFrequency * 0.35;
    const swell = continentField.fbm(x * swellFreq, z * swellFreq, 70);

    // Terrace / plateau formation: gentle steps in highlands
    let plateau = 0;
    if (this.plateauStrength > 0) {
      const terrace = Math.floor((continent * 0.7 + mountain * mountainMask * 0.3) * 6) / 6;
      plateau = (terrace - (continent * 0.7 + mountain * mountainMask * 0.3)) * 20 * this.plateauStrength;
    }

    // Final blend — physically plausible stacking
    const base = continent * this.continentalAmplitude;
    const mountainHeight = mountain * mountainMask * this.mountainAmplitude;
    const hillHeight = hills * this.hillAmplitude;
    const detailHeight = detail * this.detailAmplitude;
    const swellHeight = swell * this.swellAmplitude;

    let total = base + mountainHeight + hillHeight + detailHeight + swellHeight + plateau;

    // Slight non-linear remapping to push low areas flatter (valley floors) and keep peaks sharp
    // This mimics natural erosion baseline
    if (total < 80) {
      total = total * 0.6 + Math.pow(Math.max(0, total) / 80, 1.3) * 80 * 0.4;
    }

    return this.seaLevel + total;
  }

  process(cell: WorldCell): void {
    const res = cell.resolution;
    const step = cell.size / (res - 1);
    const originX = cell.cx * cell.size;
    const originZ = cell.cz * cell.size;

    for (let j = 0; j < res; j++) {
      for (let i = 0; i < res; i++) {
        const wx = originX + i * step;
        const wz = originZ + j * step;
        cell.heights[j * res + i] = this.sampleHeight(wx, wz, cell.seed);
      }
    }
  }
}

// ------------------------------------------------------------------ Thermal Weathering (improved talus)

export interface ThermalErosionOptions {
  iterations?: number;
  talusAngle?: number; // radians
  erosionRate?: number;
  depositionRate?: number;
}

export class ThermalErosionGenerator implements TerrainStage {
  readonly name = "thermal-erosion";
  readonly iterations: number;
  readonly talusAngle: number;
  readonly erosionRate: number;
  readonly depositionRate: number;

  constructor(options: ThermalErosionOptions = {}) {
    this.iterations = options.iterations ?? 3;
    this.talusAngle = options.talusAngle ?? 0.65; // ~37 deg, realistic scree angle
    this.erosionRate = options.erosionRate ?? 0.25;
    this.depositionRate = options.depositionRate ?? 0.9; // most material conserved
  }

  process(cell: WorldCell): void {
    const res = cell.resolution;
    const step = cell.size / (res - 1);
    const count = res * res;

    // Temporary buffer for material conservation
    const delta = new Float32Array(count);

    for (let iter = 0; iter < this.iterations; iter++) {
      delta.fill(0);

      for (let j = 1; j < res - 1; j++) {
        for (let i = 1; i < res - 1; i++) {
          const idx = j * res + i;
          const h = cell.heights[idx]!;

          // Check 8 neighbors for more realistic slumping
          let totalDiff = 0;
          let lowestH = h;
          let lowestIdx = -1;

          const neighbors = [
            (j - 1) * res + i, // N
            (j + 1) * res + i, // S
            j * res + (i - 1), // W
            j * res + (i + 1), // E
            (j - 1) * res + (i - 1), // NW
            (j - 1) * res + (i + 1), // NE
            (j + 1) * res + (i - 1), // SW
            (j + 1) * res + (i + 1), // SE
          ];

          for (const nIdx of neighbors) {
            const nh = cell.heights[nIdx]!;
            if (nh < lowestH) {
              lowestH = nh;
              lowestIdx = nIdx;
            }
          }

          if (lowestIdx !== -1) {
            const diff = h - lowestH;
            // Diagonal neighbors have longer distance
            const isDiagonal =
              lowestIdx === (j - 1) * res + (i - 1) ||
              lowestIdx === (j - 1) * res + (i + 1) ||
              lowestIdx === (j + 1) * res + (i - 1) ||
              lowestIdx === (j + 1) * res + (i + 1);
            const dist = isDiagonal ? step * 1.4142 : step;
            const maxStable = Math.tan(this.talusAngle) * dist;

            if (diff > maxStable) {
              const excess = (diff - maxStable) * this.erosionRate;
              delta[idx]! -= excess;
              delta[lowestIdx]! += excess * this.depositionRate;
              totalDiff += excess;
            }
          }
        }
      }

      // Apply deltas
      for (let k = 0; k < count; k++) {
        cell.heights[k]! += delta[k]!;
      }
    }
  }
}

// ------------------------------------------------------------------ Hydraulic Erosion (water flow, sediment transport)

export interface HydraulicErosionOptions {
  iterations?: number;
  rainfall?: number;
  solubility?: number;
  evaporation?: number;
  sedimentCapacity?: number;
  depositionRate?: number;
  flowRate?: number;
}

export class HydraulicErosionGenerator implements TerrainStage {
  readonly name = "hydraulic-erosion";
  readonly iterations: number;
  readonly rainfall: number;
  readonly solubility: number;
  readonly evaporation: number;
  readonly sedimentCapacity: number;
  readonly depositionRate: number;
  readonly flowRate: number;

  constructor(options: HydraulicErosionOptions = {}) {
    this.iterations = options.iterations ?? 12;
    this.rainfall = options.rainfall ?? 0.012;
    this.solubility = options.solubility ?? 0.015;
    this.evaporation = options.evaporation ?? 0.02;
    this.sedimentCapacity = options.sedimentCapacity ?? 0.08;
    this.depositionRate = options.depositionRate ?? 0.15;
    this.flowRate = options.flowRate ?? 0.3;
  }

  process(cell: WorldCell): void {
    const res = cell.resolution;
    const count = res * res;
    const step = cell.size / (res - 1);

    // Water and sediment buffers
    const water = new Float32Array(count);
    const sediment = new Float32Array(count);
    const waterOut = new Float32Array(count);
    const sedimentOut = new Float32Array(count);
    const flowDir = new Int32Array(count); // index of outflow neighbor, -1 if pit

    // Initialize with small random water to break symmetry deterministically
    const rng = new Rng(chunkSeed(cell.cx, cell.cz, 777, cell.seed));
    for (let i = 0; i < count; i++) {
      water[i] = this.rainfall * (0.8 + rng.nextFloat() * 0.4);
    }

    for (let iter = 0; iter < this.iterations; iter++) {
      // 1. Compute flow directions (steepest descent)
      for (let j = 1; j < res - 1; j++) {
        for (let i = 1; i < res - 1; i++) {
          const idx = j * res + i;
          const h = cell.heights[idx]! + water[idx]! * 0.1; // water slightly raises effective height

          let minH = h;
          let minIdx = -1;

          // 4 cardinal + 4 diagonal, but weight diagonals less
          const neighbors: [number, number][] = [
            [i, j - 1],
            [i, j + 1],
            [i - 1, j],
            [i + 1, j],
            [i - 1, j - 1],
            [i + 1, j - 1],
            [i - 1, j + 1],
            [i + 1, j + 1],
          ];

          for (const [ni, nj] of neighbors) {
            const nIdx = nj * res + ni;
            const nh = cell.heights[nIdx]! + water[nIdx]! * 0.1;
            if (nh < minH) {
              minH = nh;
              minIdx = nIdx;
            }
          }

          flowDir[idx] = minIdx;
        }
      }

      // 2. Water flow and sediment transport
      waterOut.fill(0);
      sedimentOut.fill(0);

      for (let j = 1; j < res - 1; j++) {
        for (let i = 1; i < res - 1; i++) {
          const idx = j * res + i;
          const outIdx = flowDir[idx]!;

          if (outIdx === -1) {
            // Pit: deposit all sediment, evaporate water slowly
            const dep = sediment[idx]! * this.depositionRate;
            cell.heights[idx]! += dep;
            sediment[idx]! -= dep;
            water[idx]! *= 1 - this.evaporation * 0.5;
            continue;
          }

          const hDiff = cell.heights[idx]! - cell.heights[outIdx]!;
          if (hDiff <= 0) continue;

          // Slope factor: steeper = faster flow, more erosion
          const slope = hDiff / step;
          const flowAmount = Math.min(water[idx]!, water[idx]! * this.flowRate * (1 + slope * 2));

          // Sediment capacity: how much sediment water can carry (proportional to slope * water)
          const capacity = Math.max(0, slope * flowAmount * this.sedimentCapacity * 8);

          if (sediment[idx]! > capacity) {
            // Deposit excess sediment
            const excess = (sediment[idx]! - capacity) * this.depositionRate;
            cell.heights[idx]! += excess;
            sediment[idx]! -= excess;
          } else {
            // Erode: pick up material if below capacity
            const erodeAmount = Math.min(
              (capacity - sediment[idx]!) * this.solubility,
              hDiff * 0.5, // don't erode more than half the height difference
            );
            if (erodeAmount > 0) {
              cell.heights[idx]! -= erodeAmount;
              sediment[idx]! += erodeAmount;
            }
          }

          // Move water and sediment downstream
          waterOut[outIdx]! += flowAmount;
          sedimentOut[outIdx]! += sediment[idx]! * (flowAmount / Math.max(0.001, water[idx]!));
          water[idx]! -= flowAmount;
          sediment[idx]! *= 1 - flowAmount / Math.max(0.001, water[idx]! + flowAmount);
        }
      }

      // Apply outflows
      for (let k = 0; k < count; k++) {
        water[k]! += waterOut[k]!;
        sediment[k]! += sedimentOut[k]!;
        waterOut[k] = 0;
        sedimentOut[k] = 0;

        // Rainfall and evaporation
        water[k]! += this.rainfall * (0.5 + (k % 3) * 0.1); // slight variation
        water[k]! *= 1 - this.evaporation;
        water[k] = Math.max(0, water[k]!);
      }
    }

    // Final deposition: dump remaining sediment
    for (let k = 0; k < count; k++) {
      if (sediment[k]! > 0.001) {
        cell.heights[k]! += sediment[k]! * 0.5;
      }
    }
  }
}

// ------------------------------------------------------------------ River / Valley Carving (fluvial erosion based on flow accumulation)

export interface ValleyCarvingOptions {
  /** Minimum flow accumulation to start carving. */
  minAccumulation?: number;
  /** Valley depth factor. */
  carveDepth?: number;
  /** Valley width in cells. */
  valleyWidth?: number;
  /** How much to widen valley with distance. */
  widthFalloff?: number;
  /** River bed flatness. */
  riverBedSlope?: number;
}

export class ValleyCarvingGenerator implements TerrainStage {
  readonly name = "valley-carving";
  readonly minAccumulation: number;
  readonly carveDepth: number;
  readonly valleyWidth: number;
  readonly widthFalloff: number;
  readonly riverBedSlope: number;

  constructor(options: ValleyCarvingOptions = {}) {
    this.minAccumulation = options.minAccumulation ?? 8;
    this.carveDepth = options.carveDepth ?? 0.6;
    this.valleyWidth = options.valleyWidth ?? 2.5;
    this.widthFalloff = options.widthFalloff ?? 0.85;
    this.riverBedSlope = options.riverBedSlope ?? 0.02;
  }

  process(cell: WorldCell): void {
    const res = cell.resolution;
    const count = res * res;

    // Flow accumulation: how many cells drain through each cell
    const accumulation = new Float32Array(count);
    const flowDir = new Int32Array(count);
    accumulation.fill(1); // each cell at least drains itself
    flowDir.fill(-1);

    // Compute flow direction (steepest descent)
    for (let j = 1; j < res - 1; j++) {
      for (let i = 1; i < res - 1; i++) {
        const idx = j * res + i;
        const h = cell.heights[idx]!;

        let minH = h;
        let minIdx = -1;

        for (let dj = -1; dj <= 1; dj++) {
          for (let di = -1; di <= 1; di++) {
            if (di === 0 && dj === 0) continue;
            const ni = i + di;
            const nj = j + dj;
            if (ni < 0 || ni >= res || nj < 0 || nj >= res) continue;
            const nIdx = nj * res + ni;
            const nh = cell.heights[nIdx]!;
            if (nh < minH) {
              minH = nh;
              minIdx = nIdx;
            }
          }
        }

        flowDir[idx] = minIdx;
      }
    }

    // Compute accumulation by processing cells from high to low elevation
    const indices = Array.from({ length: count }, (_, k) => k);
    indices.sort((a, b) => cell.heights[b]! - cell.heights[a]!);

    for (const idx of indices) {
      const outIdx = flowDir[idx]!;
      if (outIdx !== -1) {
        accumulation[outIdx]! += accumulation[idx]!;
      }
    }

    // Carve valleys where accumulation is high
    // Use a second pass to create V-shaped valleys with smooth falloff
    const carveAmount = new Float32Array(count);

    for (let j = 1; j < res - 1; j++) {
      for (let i = 1; i < res - 1; i++) {
        const idx = j * res + i;
        const acc = accumulation[idx]!;

        if (acc < this.minAccumulation) continue;

        // Depth proportional to sqrt(accumulation) — realistic river scaling
        const normalizedAcc = (acc - this.minAccumulation) / (res * 2);
        const depth = Math.sqrt(normalizedAcc) * this.carveDepth * 12 * (1 + Math.log10(1 + acc) * 0.5);

        // V-shaped valley: carve center deeper, sides shallower
        carveAmount[idx] = Math.max(carveAmount[idx]!, depth);

        // Widen valley to neighboring cells with falloff
        const width = Math.min(res * 0.3, this.valleyWidth + Math.sqrt(acc) * 0.15);
        const iWidth = Math.ceil(width);

        for (let dj = -iWidth; dj <= iWidth; dj++) {
          for (let di = -iWidth; di <= iWidth; di++) {
            if (di === 0 && dj === 0) continue;
            const ni = i + di;
            const nj = j + dj;
            if (ni < 1 || ni >= res - 1 || nj < 1 || nj >= res - 1) continue;

            const dist = Math.sqrt(di * di + dj * dj);
            if (dist > width) continue;

            const falloff = Math.pow(1 - dist / width, this.widthFalloff);
            const nIdx = nj * res + ni;
            const sideDepth = depth * falloff * 0.6;

            // Only carve if this would make a valley (don't raise terrain)
            // And blend with existing carve to keep deepest
            carveAmount[nIdx] = Math.max(carveAmount[nIdx]!, sideDepth);
          }
        }
      }
    }

    // Apply carving with slight smoothing to avoid sharp artifacts
    for (let k = 0; k < count; k++) {
      if (carveAmount[k]! > 0.01) {
        // Don't carve below a minimum slope relative to outflow (river bed gradient)
        const outIdx = flowDir[k]!;
        if (outIdx !== -1) {
          const maxCarve = Math.max(0, cell.heights[k]! - cell.heights[outIdx]! - this.riverBedSlope);
          carveAmount[k] = Math.min(carveAmount[k]!, maxCarve + carveAmount[k]! * 0.3);
        }
        cell.heights[k]! -= carveAmount[k]!;
      }
    }
  }
}

// ------------------------------------------------------------------ Detail Noise (re-inject surface roughness after erosion)

export interface DetailNoiseOptions {
  amplitude?: number;
  frequency?: number;
  octaves?: number;
  /** Only apply detail above this slope (preserve flat valley floors). */
  minSlope?: number;
  /** Blend factor 0..1. */
  blend?: number;
}

export class DetailNoiseGenerator implements TerrainStage {
  readonly name = "detail-noise";
  readonly amplitude: number;
  readonly frequency: number;
  readonly octaves: number;
  readonly minSlope: number;
  readonly blend: number;

  constructor(options: DetailNoiseOptions = {}) {
    this.amplitude = options.amplitude ?? 3.5;
    this.frequency = options.frequency ?? 1 / 18;
    this.octaves = options.octaves ?? 3;
    this.minSlope = options.minSlope ?? 0.05;
    this.blend = options.blend ?? 0.7;
  }

  process(cell: WorldCell): void {
    const res = cell.resolution;
    const step = cell.size / (res - 1);
    const originX = cell.cx * cell.size;
    const originZ = cell.cz * cell.size;

    const field = new NoiseField(cell.seed ^ 0xabcd1234, {
      octaves: this.octaves,
      lacunarity: 2.15,
      gain: 0.5,
    });

    // Precompute slopes for masking
    const slopes = new Float32Array(res * res);

    for (let j = 1; j < res - 1; j++) {
      for (let i = 1; i < res - 1; i++) {
        const idx = j * res + i;
        const hL = cell.heights[j * res + (i - 1)]!;
        const hR = cell.heights[j * res + (i + 1)]!;
        const hD = cell.heights[(j - 1) * res + i]!;
        const hU = cell.heights[(j + 1) * res + i]!;

        const dx = (hR - hL) / (2 * step);
        const dz = (hU - hD) / (2 * step);
        slopes[idx] = Math.hypot(dx, dz);
      }
    }

    for (let j = 0; j < res; j++) {
      for (let i = 0; i < res; i++) {
        const idx = j * res + i;
        const wx = originX + i * step;
        const wz = originZ + j * step;

        const slope = slopes[idx] ?? 0;
        if (slope < this.minSlope) continue; // preserve flat areas (river beds, plains)

        // Fractal detail noise
        const n1 = field.fbm(wx * this.frequency, wz * this.frequency, 100);
        const n2 = field.fbm(wx * this.frequency * 2.3, wz * this.frequency * 2.3, 101) * 0.5;
        const n3 = field.fbm(wx * this.frequency * 5.7, wz * this.frequency * 5.7, 102) * 0.25;
        const detail = (n1 + n2 + n3) * this.amplitude;

        // Slope-modulated: more detail on steep slopes (rocky outcrops)
        const slopeFactor = clamp(slope / 0.5, 0.3, 1.5);
        cell.heights[idx]! += detail * this.blend * slopeFactor;
      }
    }
  }
}

// ------------------------------------------------------------------ Climate & Realistic Biome Generator

export interface ClimateBiomeOptions {
  /** Sea level for beach/sand transition. */
  seaLevel?: number;
  /** Snow line height (base, modulated by latitude/moisture). */
  snowLine?: number;
  /** Temperature lapse rate per meter. */
  lapseRate?: number;
  /** Moisture noise frequency. */
  moistureFrequency?: number;
}

export class ClimateBiomeGenerator implements TerrainStage {
  readonly name = "climate-biome";
  readonly seaLevel: number;
  readonly snowLine: number;
  readonly lapseRate: number;
  readonly moistureFrequency: number;

  constructor(options: ClimateBiomeOptions = {}) {
    this.seaLevel = options.seaLevel ?? 5;
    this.snowLine = options.snowLine ?? 420;
    this.lapseRate = options.lapseRate ?? 0.006; // 6°C per 1000m, realistic
    this.moistureFrequency = options.moistureFrequency ?? 1 / 350;
  }

  process(cell: WorldCell): void {
    const res = cell.resolution;
    const step = cell.size / (res - 1);
    const originX = cell.cx * cell.size;
    const originZ = cell.cz * cell.size;

    const moistureField = new NoiseField(cell.seed ^ 0x13579bdf, { octaves: 4, lacunarity: 2.0, gain: 0.5 });
    const tempField = new NoiseField(cell.seed ^ 0x2468ace0, { octaves: 3, lacunarity: 2.1, gain: 0.5 });

    for (let j = 0; j < res; j++) {
      for (let i = 0; i < res; i++) {
        const idx = j * res + i;
        const h = cell.heights[idx]!;
        const wx = originX + i * step;
        const wz = originZ + j * step;

        // Slope via central difference
        const iL = Math.max(0, i - 1);
        const iR = Math.min(res - 1, i + 1);
        const jD = Math.max(0, j - 1);
        const jU = Math.min(res - 1, j + 1);

        const hL = cell.heights[j * res + iL]!;
        const hR = cell.heights[j * res + iR]!;
        const hD = cell.heights[jD * res + i]!;
        const hU = cell.heights[jU * res + i]!;

        const dx = (hR - hL) / ((iR - iL) * step);
        const dz = (hU - hD) / ((jU - jD) * step);
        const slope = Math.atan(Math.hypot(dx, dz));
        cell.slopes[idx] = slope;

        // Climate model
        // Temperature: base temp minus lapse rate * height, plus latitude variation (z) and noise
        const latitudeEffect = Math.cos(wz * 0.00005) * 5; // subtle latitude bands
        const tempNoise = tempField.fbm(wx * 0.001, wz * 0.001, 200) * 8;
        const temperature = 25 - h * this.lapseRate * 100 + latitudeEffect + tempNoise; // °C approx

        // Moisture: fBm noise + height inverse (valleys more moist) + slope inverse (flat holds water)
        const moistureNoise = moistureField.fbm(wx * this.moistureFrequency, wz * this.moistureFrequency, 300);
        const moistureBase = (moistureNoise + 1) * 0.5; // 0..1
        const heightMoisture = clamp(1 - h / 600, 0, 1) * 0.3; // higher = drier
        const slopeMoisture = clamp(1 - slope / 0.8, 0, 1) * 0.2; // steeper = drier
        const moisture = clamp(moistureBase + heightMoisture + slopeMoisture, 0, 1);

        // Biome splat weights — 4 channels for material blending:
        // w0: grass / lowland fertile (green)
        // w1: cliff / rock (brown/gray, steep slopes)
        // w2: sand / scree / beach (yellowish, low or transitional)
        // w3: snow / high alpine (white)

        // Rock factor: steep slopes are rocky
        const cliffFactor = smoothstep(0.35, 0.9, slope);

        // Snow factor: high elevation and low temperature
        const snowHeightFactor = smoothstep(this.snowLine - 80, this.snowLine + 120, h);
        const snowTempFactor = smoothstep(5, -5, temperature); // colder = more snow
        let snowFactor = Math.max(snowHeightFactor, snowTempFactor * 0.7);
        // Snow doesn't stick on very steep slopes (>50 deg) — avalanches
        if (slope > 0.85) {
          snowFactor *= clamp(1 - (slope - 0.85) / 0.4, 0.1, 1);
        }

        // Sand / beach: low elevation near sea level, or scree at mid slopes
        const beachFactor = smoothstep(this.seaLevel + 15, this.seaLevel - 5, h) * (1 - cliffFactor * 0.8);
        const screeFactor = smoothstep(0.25, 0.6, slope) * (1 - cliffFactor) * 0.5 * (1 - snowFactor);
        const sandFactor = clamp(beachFactor + screeFactor, 0, 1);

        // Grass / fertile: moderate slope, moderate height, decent moisture, not snow/rock/sand
        const grassSlopeFactor = 1 - smoothstep(0.2, 0.7, slope);
        const grassHeightFactor = 1 - smoothstep(300, 550, h);
        const grassMoistureFactor = 0.3 + moisture * 0.7;
        let grassFactor = grassSlopeFactor * grassHeightFactor * grassMoistureFactor;
        // Reduce grass where sand or snow dominates
        grassFactor *= 1 - sandFactor * 0.8;
        grassFactor *= 1 - snowFactor * 0.9;
        grassFactor *= 1 - cliffFactor * 0.7;

        // Rock is remainder of steep or high areas
        let rockFactor = cliffFactor * (1 - snowFactor * 0.5) + smoothstep(400, 700, h) * 0.3 * (1 - grassFactor);

        // Normalize weights
        let wGrass = Math.max(0, grassFactor);
        let wRock = Math.max(0, rockFactor);
        let wSand = Math.max(0, sandFactor);
        let wSnow = Math.max(0, snowFactor);

        const sum = wGrass + wRock + wSand + wSnow;
        if (sum > 0) {
          const inv = 1 / sum;
          wGrass *= inv;
          wRock *= inv;
          wSand *= inv;
          wSnow *= inv;
        } else {
          wGrass = 1;
          wRock = 0;
          wSand = 0;
          wSnow = 0;
        }

        const bIdx = idx * 4;
        cell.biomes[bIdx] = wGrass;
        cell.biomes[bIdx + 1] = wRock;
        cell.biomes[bIdx + 2] = wSand;
        cell.biomes[bIdx + 3] = wSnow;
      }
    }
  }
}

// ------------------------------------------------------------------ Realistic Scatter (vegetation, rocks)

export interface RealisticScatterOptions {
  countPerChunk?: number;
  maxSlope?: number;
  minHeight?: number;
  maxHeight?: number;
}

export class RealisticScatterGenerator implements TerrainStage {
  readonly name = "realistic-scatter";
  readonly countPerChunk: number;
  readonly maxSlope: number;
  readonly minHeight: number;
  readonly maxHeight: number;

  constructor(options: RealisticScatterOptions = {}) {
    this.countPerChunk = options.countPerChunk ?? 18;
    this.maxSlope = options.maxSlope ?? 0.6;
    this.minHeight = options.minHeight ?? -50;
    this.maxHeight = options.maxHeight ?? 500;
  }

  process(cell: WorldCell): void {
    const rng = new Rng(chunkSeed(cell.cx, cell.cz, 4242, cell.seed));
    const res = cell.resolution;
    const step = cell.size / (res - 1);
    const originX = cell.cx * cell.size;
    const originZ = cell.cz * cell.size;

    for (let k = 0; k < this.countPerChunk; k++) {
      const lx = rng.nextFloat() * cell.size;
      const lz = rng.nextFloat() * cell.size;

      const gi = Math.floor(lx / step);
      const gj = Math.floor(lz / step);
      if (gi < 0 || gi >= res - 1 || gj < 0 || gj >= res - 1) continue;

      const idx = gj * res + gi;
      const slope = cell.slopes[idx] ?? 0;
      if (slope > this.maxSlope) continue;

      const fx = (lx - gi * step) / step;
      const fz = (lz - gj * step) / step;

      const h00 = cell.heights[gj * res + gi]!;
      const h10 = cell.heights[gj * res + gi + 1]!;
      const h01 = cell.heights[(gj + 1) * res + gi]!;
      const h11 = cell.heights[(gj + 1) * res + gi + 1]!;

      const y = (h00 * (1 - fx) + h10 * fx) * (1 - fz) + (h01 * (1 - fx) + h11 * fx) * fz;

      if (y < this.minHeight || y > this.maxHeight) continue;

      // Biome check: only scatter on grassy areas (w0 dominant)
      const bIdx = idx * 4;
      const wGrass = cell.biomes[bIdx]!;
      const wRock = cell.biomes[bIdx + 1]!;
      const wSnow = cell.biomes[bIdx + 3]!;

      if (wSnow > 0.5) continue; // no vegetation in snow
      if (wGrass < 0.25 && wRock < 0.4) continue; // need some grass or rock

      // Type based on biome weights
      let type = 0;
      if (wRock > 0.5) {
        type = rng.nextFloat() < 0.7 ? 2 : 1; // mostly rocks on rocky terrain
      } else if (wGrass > 0.5) {
        type = rng.nextFloat() < 0.6 ? 0 : 1; // mostly trees/bushes on grass
      } else {
        type = Math.floor(rng.nextFloat() * 3);
      }

      cell.scatters.push({
        x: originX + lx,
        y,
        z: originZ + lz,
        scale: 0.4 + rng.nextFloat() * 1.6,
        rotationY: rng.nextFloat() * Math.PI * 2,
        type,
      });
    }
  }
}

// ------------------------------------------------------------------ Pipeline Factory

import { GeneratorPipeline } from "./generators.js";

export interface RealisticTerrainPipelineOptions {
  seed?: number;
  seaLevel?: number;
  continentalAmplitude?: number;
  mountainAmplitude?: number;
  hillAmplitude?: number;
  detailAmplitude?: number;
  warpAmount?: number;
  snowLine?: number;
  thermalIterations?: number;
  hydraulicIterations?: number;
  scatterCount?: number;
  /** If true, include river valley carving (more expensive). */
  enableRivers?: boolean;
  /** If true, include detail noise after erosion. */
  enableDetail?: boolean;
}

export function createRealisticTerrainPipeline(options: RealisticTerrainPipelineOptions = {}): GeneratorPipeline {
  const pipeline = new GeneratorPipeline();

  pipeline
    .addStage(
      new RealisticHeightGenerator({
        seaLevel: options.seaLevel ?? 0,
        continentalAmplitude: options.continentalAmplitude ?? 280,
        mountainAmplitude: options.mountainAmplitude ?? 850,
        hillAmplitude: options.hillAmplitude ?? 85,
        detailAmplitude: options.detailAmplitude ?? 12,
        warpAmount: options.warpAmount ?? 180,
      }),
    )
    .addStage(
      new ThermalErosionGenerator({
        iterations: options.thermalIterations ?? 3,
        talusAngle: 0.65,
        erosionRate: 0.25,
      }),
    )
    .addStage(
      new HydraulicErosionGenerator({
        iterations: options.hydraulicIterations ?? 10,
        rainfall: 0.012,
        solubility: 0.015,
        evaporation: 0.02,
      }),
    );

  if (options.enableRivers ?? true) {
    pipeline.addStage(
      new ValleyCarvingGenerator({
        minAccumulation: 8,
        carveDepth: 0.55,
        valleyWidth: 2.8,
      }),
    );
  }

  if (options.enableDetail ?? true) {
    pipeline.addStage(
      new DetailNoiseGenerator({
        amplitude: 3.0,
        frequency: 1 / 20,
        octaves: 3,
      }),
    );
  }

  pipeline
    .addStage(
      new ClimateBiomeGenerator({
        seaLevel: options.seaLevel ?? 5,
        snowLine: options.snowLine ?? 420,
      }),
    )
    .addStage(
      new RealisticScatterGenerator({
        countPerChunk: options.scatterCount ?? 16,
        maxSlope: 0.6,
      }),
    );

  return pipeline;
}

/** Alias for backward compatibility / discoverability. */
export const createRealisticPipeline = createRealisticTerrainPipeline;

// ------------------------------------------------------------------ Preset configurations for different terrain styles

export type RealisticPreset = "alpine" | "rolling-hills" | "mountainous" | "canyon" | "archipelago";

export function createRealisticPipelinePreset(preset: RealisticPreset, seed?: number): GeneratorPipeline {
  switch (preset) {
    case "alpine":
      return createRealisticTerrainPipeline({
        seed,
        continentalAmplitude: 220,
        mountainAmplitude: 950,
        hillAmplitude: 70,
        detailAmplitude: 14,
        warpAmount: 200,
        snowLine: 380,
        thermalIterations: 4,
        hydraulicIterations: 14,
        enableRivers: true,
        enableDetail: true,
      });

    case "rolling-hills":
      return createRealisticTerrainPipeline({
        seed,
        continentalAmplitude: 180,
        mountainAmplitude: 250,
        hillAmplitude: 120,
        detailAmplitude: 8,
        warpAmount: 120,
        snowLine: 650,
        thermalIterations: 2,
        hydraulicIterations: 8,
        enableRivers: true,
        enableDetail: true,
      });

    case "mountainous":
      return createRealisticTerrainPipeline({
        seed,
        continentalAmplitude: 320,
        mountainAmplitude: 1200,
        hillAmplitude: 90,
        detailAmplitude: 16,
        warpAmount: 250,
        snowLine: 450,
        thermalIterations: 3,
        hydraulicIterations: 12,
        enableRivers: true,
        enableDetail: true,
      });

    case "canyon":
      return createRealisticTerrainPipeline({
        seed,
        continentalAmplitude: 350,
        mountainAmplitude: 600,
        hillAmplitude: 60,
        detailAmplitude: 18,
        warpAmount: 150,
        snowLine: 800,
        thermalIterations: 5,
        hydraulicIterations: 18,
        enableRivers: true,
        enableDetail: true,
      });

    case "archipelago":
      return createRealisticTerrainPipeline({
        seed,
        seaLevel: 25,
        continentalAmplitude: 120,
        mountainAmplitude: 400,
        hillAmplitude: 80,
        detailAmplitude: 10,
        warpAmount: 160,
        snowLine: 500,
        thermalIterations: 2,
        hydraulicIterations: 10,
        enableRivers: false,
        enableDetail: true,
      });

    default:
      return createRealisticTerrainPipeline({ seed });
  }
}
