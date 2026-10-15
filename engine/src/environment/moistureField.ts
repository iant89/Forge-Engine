/**
 * Ground moisture field (fe-38): standing water, soil moisture, mud and lying snow over a patch of
 * ground, on a regular grid.
 *
 * Water arrives from rain ({@link MeltEnvironment.precipitation}), from snow melting on the ground,
 * and from anything that calls {@link GroundMoistureField.addWater} (snow melting off objects drips
 * here). It runs downhill over the height function into low spots (a 4-neighbour shallow-water
 * "pipe" step on ground + water surface), soaks into the soil at the soil's infiltration rate and
 * evaporates; the soil's moisture dries back toward zero over its own time constant, faster in sun,
 * warmth and wind. Soils marked `muddy` (dirt, partly grass) turn to mud as they saturate.
 *
 * The field is the simulation state; {@link GroundMoistureField.gripAt} feeds vehicle traction
 * (through `scene/surfaceGrip.ts`) and {@link GroundMoistureField.writeSurfaceMaps} renders it
 * into albedo / metallic-roughness texels (see `rendering/moistureGround.ts`).
 */

import { clamp, smoothstep } from "../math/scalar.js";
import { DEFAULT_SNOW_DENSITY, WATER_DENSITY, meltRate, snowAlbedo, snowEnergyBalance, type MeltEnvironment } from "./snowMelt.js";

export interface SoilType {
  name: string;
  /** Linear albedo of the dry soil. */
  color: [number, number, number];
  /** Linear albedo when saturated (dark, wet). */
  wetColor: [number, number, number];
  /** Dry roughness. */
  roughness: number;
  /** Infiltration rate into dry soil, m/s of water. */
  infiltration: number;
  /** Water the top layer holds at saturation, m. */
  capacity: number;
  /** 0..1: how fully this soil turns to mud when saturated. */
  muddy: number;
}

export const SOIL_TYPES = {
  dirt: { name: "dirt", color: [0.24, 0.17, 0.11], wetColor: [0.085, 0.06, 0.04], roughness: 0.92, infiltration: 6e-6, capacity: 0.012, muddy: 1 },
  grass: { name: "grass", color: [0.12, 0.17, 0.06], wetColor: [0.06, 0.085, 0.03], roughness: 0.9, infiltration: 1e-5, capacity: 0.02, muddy: 0.35 },
  sand: { name: "sand", color: [0.5, 0.42, 0.28], wetColor: [0.3, 0.24, 0.15], roughness: 0.85, infiltration: 5e-5, capacity: 0.01, muddy: 0 },
  rock: { name: "rock", color: [0.22, 0.21, 0.2], wetColor: [0.12, 0.115, 0.11], roughness: 0.8, infiltration: 0, capacity: 0.0005, muddy: 0 },
} as const satisfies Record<string, SoilType>;

export type SoilName = keyof typeof SOIL_TYPES;

export interface GroundMoistureFieldOptions {
  /** World-space minimum corner (x, z) of the patch. */
  originX: number;
  originZ: number;
  /** Side length in metres. */
  size: number;
  /** Cells per side. Default 64. */
  resolution?: number;
  /** Ground height. Default flat 0. */
  heightAt?: (x: number, z: number) => number;
  /** Soil at a point. Default dirt everywhere. */
  soilAt?: (x: number, z: number) => SoilName;
  /** Rain rate at precipitation 1, m/s of water. Default 2.8e-6 (10 mm/h). */
  rainRate?: number;
  /** Seconds for saturated soil to dry by 1/e at 15 °C, no sun, no wind. Default 3600. */
  dryingTime?: number;
  /** Standing-water evaporation at 1000 W/m² sun, m/s. Default 1.5e-7 (≈0.5 mm/h). */
  evaporation?: number;
}

const NEIGHBOURS: ReadonlyArray<[number, number]> = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

export class GroundMoistureField {
  readonly originX: number;
  readonly originZ: number;
  readonly size: number;
  readonly resolution: number;
  readonly cell: number;
  /** Ground height per cell (m). */
  readonly height: Float32Array;
  /** Standing water depth per cell (m). */
  readonly water: Float32Array;
  /** Soil moisture per cell, 0 dry … 1 saturated. */
  readonly moisture: Float32Array;
  /** Lying snow depth per cell (m of snow). */
  readonly snow: Float32Array;
  readonly soil: SoilType[];
  rainRate: number;
  dryingTime: number;
  evaporation: number;
  /** Seconds simulated so far. */
  simulatedSeconds = 0;
  /** Total water that has entered the field (m³) and left it (soaked, evaporated) — conservation checks. */
  waterIn = 0;
  waterOut = 0;
  private readonly flux: Float32Array;

  constructor(options: GroundMoistureFieldOptions) {
    this.originX = options.originX;
    this.originZ = options.originZ;
    this.size = options.size;
    this.resolution = Math.max(2, Math.floor(options.resolution ?? 64));
    this.cell = this.size / this.resolution;
    const n = this.resolution * this.resolution;
    this.height = new Float32Array(n);
    this.water = new Float32Array(n);
    this.moisture = new Float32Array(n);
    this.snow = new Float32Array(n);
    this.flux = new Float32Array(n * 4);
    this.soil = new Array<SoilType>(n);
    this.rainRate = options.rainRate ?? 2.8e-6;
    this.dryingTime = options.dryingTime ?? 3600;
    this.evaporation = options.evaporation ?? 1.5e-7;
    const heightAt = options.heightAt ?? (() => 0);
    const soilAt = options.soilAt ?? (() => "dirt" as SoilName);
    for (let j = 0; j < this.resolution; j++) {
      for (let i = 0; i < this.resolution; i++) {
        const x = this.originX + (i + 0.5) * this.cell;
        const z = this.originZ + (j + 0.5) * this.cell;
        const k = j * this.resolution + i;
        this.height[k] = heightAt(x, z);
        this.soil[k] = SOIL_TYPES[soilAt(x, z)];
      }
    }
  }

  get cellArea(): number {
    return this.cell * this.cell;
  }

  /** Cell index for a world point, or -1 outside the patch. */
  indexAt(x: number, z: number): number {
    const i = Math.floor((x - this.originX) / this.cell);
    const j = Math.floor((z - this.originZ) / this.cell);
    if (i < 0 || j < 0 || i >= this.resolution || j >= this.resolution) return -1;
    return j * this.resolution + i;
  }

  /** Pour `volume` m³ of water onto the ground at (x, z). Returns false outside the patch. */
  addWater(x: number, z: number, volume: number): boolean {
    const k = this.indexAt(x, z);
    if (k < 0 || !(volume > 0)) return false;
    this.water[k] += volume / this.cellArea;
    this.waterIn += volume;
    return true;
  }

  /** Drop `volume` m³ of snow at (x, z) (shed clumps landing). */
  addSnow(x: number, z: number, volume: number): boolean {
    const k = this.indexAt(x, z);
    if (k < 0 || !(volume > 0)) return false;
    this.snow[k] += volume / this.cellArea;
    return true;
  }

  waterAt(x: number, z: number): number {
    const k = this.indexAt(x, z);
    return k < 0 ? 0 : this.water[k]!;
  }
  moistureAt(x: number, z: number): number {
    const k = this.indexAt(x, z);
    return k < 0 ? 0 : this.moisture[k]!;
  }
  snowAt(x: number, z: number): number {
    const k = this.indexAt(x, z);
    return k < 0 ? 0 : this.snow[k]!;
  }
  /** 0..1 puddle coverage: standing water from 2 mm (damp sheen) to 1 cm (a real puddle). */
  puddleAt(x: number, z: number): number {
    return smoothstep(0.002, 0.01, this.waterAt(x, z));
  }
  /** 0..1 mud: a muddy soil past ~35 % saturation, full by ~80 %. */
  mudAt(x: number, z: number): number {
    const k = this.indexAt(x, z);
    return k < 0 ? 0 : this.mudOf(k);
  }
  private mudOf(k: number): number {
    return this.soil[k]!.muddy * smoothstep(0.35, 0.8, this.moisture[k]!);
  }

  /**
   * Tyre grip multiplier at (x, z), composed with the 17.4 weather grip: mud halves it (wet clay
   * μ ≈ 0.4–0.5 of dry), standing water costs the 17.4 puddle factor (×0.73), lying snow 1 − 0.7√s.
   */
  gripAt(x: number, z: number): number {
    const k = this.indexAt(x, z);
    if (k < 0) return 1;
    const mud = this.mudOf(k);
    const puddle = smoothstep(0.002, 0.01, this.water[k]!);
    const snowCover = clamp(this.snow[k]! / 0.05, 0, 1);
    return Math.max(0.2, (1 - 0.5 * mud) * (1 - 0.27 * puddle) * (1 - 0.7 * Math.sqrt(snowCover)));
  }

  /** Mean mud over the patch (diagnostics / gates). */
  meanMud(): number {
    let s = 0;
    for (let k = 0; k < this.moisture.length; k++) s += this.mudOf(k);
    return s / this.moisture.length;
  }
  totalWater(): number {
    let s = 0;
    for (let k = 0; k < this.water.length; k++) s += this.water[k]!;
    return s * this.cellArea;
  }
  totalSnow(): number {
    let s = 0;
    for (let k = 0; k < this.snow.length; k++) s += this.snow[k]!;
    return s * this.cellArea;
  }

  /** Advance `dt` simulated seconds under `env`. */
  step(dt: number, env: MeltEnvironment): void {
    if (!(dt > 0)) return;
    this.simulatedSeconds += dt;
    const n = this.water.length;
    const area = this.cellArea;
    // 1. Rain and ground snow melt add water.
    const rain = this.rainRate * clamp(env.precipitation, 0, 1) * dt;
    const snowing = env.airTemperatureC < 1;
    const groundQ = snowEnergyBalance(env, { cosIncidence: env.sunDirection.y, albedo: snowAlbedo(0.3) });
    const melt = meltRate(groundQ) * dt;
    for (let k = 0; k < n; k++) {
      if (rain > 0) {
        if (snowing) this.snow[k] += (rain * WATER_DENSITY) / DEFAULT_SNOW_DENSITY;
        else {
          this.water[k] += rain;
          this.waterIn += rain * area;
        }
      }
      if (melt > 0 && this.snow[k]! > 0) {
        const m = Math.min(this.snow[k]!, melt);
        this.snow[k] -= m;
        const w = (m * DEFAULT_SNOW_DENSITY) / WATER_DENSITY;
        this.water[k] += w;
        this.waterIn += w * area;
      }
    }
    // 2. Flow downhill: sub-stepped so no cell sends more than a quarter of its head per step.
    this.flow(dt);
    // 3. Infiltration, evaporation and drying.
    const warmth = Math.max(0.2, 1 + (env.airTemperatureC - 15) * 0.04);
    const sun = Math.max(0, env.sunIrradiance * Math.max(0, env.sunDirection.y) + env.diffuseIrradiance) / 1000;
    const dryRate = (warmth * (1 + 2 * sun) * (1 + 0.1 * env.windSpeed) * (1.4 - clamp(env.humidity, 0, 1))) / this.dryingTime;
    const evap = this.evaporation * (0.3 + sun) * (1 + 0.1 * env.windSpeed) * (1.2 - clamp(env.humidity, 0, 1)) * dt;
    for (let k = 0; k < n; k++) {
      const soil = this.soil[k]!;
      const room = (1 - this.moisture[k]!) * soil.capacity;
      const soak = Math.min(this.water[k]!, soil.infiltration * dt, room);
      if (soak > 0) {
        this.water[k] -= soak;
        this.moisture[k] += soak / soil.capacity;
        this.waterOut += soak * area;
      }
      // Standing water keeps the soil under it saturated; bare soil dries exponentially.
      if (this.water[k]! < 1e-4) this.moisture[k] *= Math.exp(-dryRate * dt);
      const ev = Math.min(this.water[k]!, evap);
      if (ev > 0) {
        this.water[k] -= ev;
        this.waterOut += ev * area;
      }
      this.moisture[k] = clamp(this.moisture[k]!, 0, 1);
    }
  }

  private flow(dt: number): void {
    const res = this.resolution;
    const n = res * res;
    // Pipe model: flux ∝ surface difference; rate constant g·dt/cell gives ~1 cell per second per m.
    const rate = 9.81 * 0.05;
    const steps = Math.max(1, Math.ceil((rate * dt) / 0.2));
    const h = (rate * dt) / steps;
    const f = this.flux;
    for (let s = 0; s < steps; s++) {
      for (let k = 0; k < n; k++) {
        const w = this.water[k]!;
        const i = k % res;
        const j = (k - i) / res;
        let total = 0;
        for (let d = 0; d < 4; d++) {
          const [di, dj] = NEIGHBOURS[d]!;
          const ni = i + di;
          const nj = j + dj;
          let out = 0;
          if (w > 0 && ni >= 0 && nj >= 0 && ni < res && nj < res) {
            const m = nj * res + ni;
            const drop = this.height[k]! + w - this.height[m]! - this.water[m]!;
            if (drop > 0) out = Math.min(drop * 0.5, w) * h;
          }
          f[k * 4 + d] = out;
          total += out;
        }
        if (total > w) {
          const scale = w / total;
          for (let d = 0; d < 4; d++) f[k * 4 + d] *= scale;
        }
      }
      for (let k = 0; k < n; k++) {
        const i = k % res;
        const j = (k - i) / res;
        for (let d = 0; d < 4; d++) {
          const q = f[k * 4 + d]!;
          if (q <= 0) continue;
          const [di, dj] = NEIGHBOURS[d]!;
          this.water[k] -= q;
          this.water[(j + dj) * res + i + di] += q;
        }
      }
    }
  }

  /**
   * Render the field into RGBA8 texels (one per cell, row = z): `albedo` is sRGB-encoded colour
   * (dry soil → darker wet soil → dark glossy mud → puddle water → white snow), `metallicRoughness`
   * follows the glTF layout (G roughness, B metallic): dry 0.9 → mud 0.3 → puddle 0.05 → snow 0.6.
   */
  writeSurfaceMaps(albedo: Uint8Array, metallicRoughness: Uint8Array): void {
    const n = this.water.length;
    for (let k = 0; k < n; k++) {
      const soil = this.soil[k]!;
      const m = this.moisture[k]!;
      const mud = this.mudOf(k);
      const puddle = smoothstep(0.002, 0.01, this.water[k]!);
      const snowCover = smoothstep(0.005, 0.04, this.snow[k]!);
      const wetT = clamp(Math.max(m, puddle), 0, 1);
      let r = soil.color[0] + (soil.wetColor[0] - soil.color[0]) * wetT;
      let g = soil.color[1] + (soil.wetColor[1] - soil.color[1]) * wetT;
      let b = soil.color[2] + (soil.wetColor[2] - soil.color[2]) * wetT;
      // Mud: a dark chocolate film; puddles: the muddy water's own dark tone (the sky reflection
      // comes from the low roughness).
      r = r + (0.07 - r) * mud * 0.6;
      g = g + (0.05 - g) * mud * 0.6;
      b = b + (0.035 - b) * mud * 0.6;
      r = r + (0.05 - r) * puddle * 0.7;
      g = g + (0.045 - g) * puddle * 0.7;
      b = b + (0.04 - b) * puddle * 0.7;
      r = r + (0.9 - r) * snowCover;
      g = g + (0.91 - g) * snowCover;
      b = b + (0.93 - b) * snowCover;
      let rough = soil.roughness + (0.55 - soil.roughness) * m;
      rough = rough + (0.28 - rough) * mud;
      rough = rough + (0.04 - rough) * puddle;
      rough = rough + (0.6 - rough) * snowCover;
      const o = k * 4;
      albedo[o] = toSrgb8(r);
      albedo[o + 1] = toSrgb8(g);
      albedo[o + 2] = toSrgb8(b);
      albedo[o + 3] = 255;
      metallicRoughness[o] = 255;
      metallicRoughness[o + 1] = Math.round(clamp(rough, 0, 1) * 255);
      metallicRoughness[o + 2] = 0;
      metallicRoughness[o + 3] = 255;
    }
  }
}

function toSrgb8(linear: number): number {
  const c = clamp(linear, 0, 1);
  const s = c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
  return Math.round(s * 255);
}
