/**
 * Track weather ground (fe-37b): the weather's effect on a spline-carved track — where it is wet,
 * muddy, flooded or snowed in, and what that does to tyre grip on each surface.
 *
 * It composes three existing systems rather than adding a fourth:
 *
 *  - the Phase 17.4 scene-wide surface state (`WeatherSystem.surface`: wetness film, puddles, snow)
 *    — fine-grained, rendered by the standard shader on every surface, so the road's own ruts and
 *    stones stay visible under wetness and snow;
 *  - a {@link GroundMoistureField} (fe-38) laid over the track's bounds — coarse (metres per cell)
 *    but simulated: rain soaks the soil, water runs downhill and pools, dirt turns to mud, snow lies
 *    and melts. Its soil comes from the track's cross-section (gravel road, grass berms, dirt
 *    forest floor). It is drawn as a partial-coverage *overlay* (`MoistureOverlayMaps`) so the
 *    blobs never replace the road texture;
 *  - per-surface grip: {@link TrackWeatherGround.gripAt} is a `SurfaceGripField` for
 *    `setWorldSurfaceGripField` — gravel, grass and dirt each have their own dry grip and their own
 *    loss when wet (wet grass is far worse than wet gravel), times the field's mud/water/snow.
 *
 * Set `WeatherSystem.driveVehicles = false` when using it: the field already folds in the 17.4
 * wetness and snow, so leaving both on would count them twice.
 */

import { clamp } from "../math/scalar.js";
import { GroundMoistureField, type SoilName } from "../environment/moistureField.js";
import type { MeltEnvironment } from "../environment/snowMelt.js";
import type { SurfaceWeatherState } from "../environment/surfaceWeather.js";
import type { TrackSurfaceSample, TrackTerrain } from "./track.js";

/** Tyre grip of a track surface: dry multiplier, and the fraction lost at full wetness. */
export interface TrackSurfaceGrip {
  dry: number;
  wetLoss: number;
}

/**
 * Default grips. Gravel is the reference (1); a grassed berm is a little worse dry and much worse
 * wet (wet grass μ ≈ 0.3–0.5 against ≈ 0.55–0.65 for wet gravel); the forest floor sits between.
 */
export const TRACK_SURFACE_GRIP: Readonly<Record<"gravel" | "grass" | "dirt", TrackSurfaceGrip>> = Object.freeze({
  gravel: Object.freeze({ dry: 1, wetLoss: 0.22 }),
  grass: Object.freeze({ dry: 0.86, wetLoss: 0.45 }),
  dirt: Object.freeze({ dry: 0.94, wetLoss: 0.3 }),
});

/** A ground condition: the field's state plus the 17.4 surface state that goes with it. */
export interface TrackGroundCondition {
  /** Soil moisture 0..1. */
  moisture: number;
  /** Standing water spread before settling (m). */
  water: number;
  /** Lying snow (m). */
  snow: number;
  /** 17.4 surface state (shader film, puddles, snow cover). */
  surface: SurfaceWeatherState;
}

/** Typical conditions for presets (a demo's weather menu snaps to one of these). */
export const TRACK_GROUND_CONDITIONS: Readonly<Record<"dry" | "damp" | "wet" | "muddy" | "snow", Readonly<TrackGroundCondition>>> = Object.freeze({
  dry: Object.freeze({ moisture: 0.05, water: 0, snow: 0, surface: { wetness: 0, puddles: 0, snow: 0 } }),
  damp: Object.freeze({ moisture: 0.3, water: 0, snow: 0, surface: { wetness: 0.25, puddles: 0, snow: 0 } }),
  wet: Object.freeze({ moisture: 0.7, water: 0.004, snow: 0, surface: { wetness: 0.9, puddles: 0.45, snow: 0 } }),
  muddy: Object.freeze({ moisture: 0.95, water: 0.006, snow: 0, surface: { wetness: 0.75, puddles: 0.6, snow: 0 } }),
  snow: Object.freeze({ moisture: 0.4, water: 0, snow: 0.08, surface: { wetness: 0.2, puddles: 0, snow: 0.85 } }),
});

export interface TrackWeatherGroundOptions {
  /** Field cells per side. Default 128 (tier knob). */
  resolution?: number;
  /** Extra margin around the berms covered by the field (m). Default 12. */
  margin?: number;
  /** Simulated seconds per real second (weather on a track happens in minutes, not hours). Default 60. */
  timeScale?: number;
  /** Real seconds between field steps (and overlay uploads). Default 0.5. */
  interval?: number;
  /** Override the per-surface grips. */
  grip?: Partial<Record<"gravel" | "grass" | "dirt", TrackSurfaceGrip>>;
}

export class TrackWeatherGround {
  readonly field: GroundMoistureField;
  timeScale: number;
  interval: number;
  /** The 17.4 surface state the grip reads (point it at `WeatherSystem.surface`). */
  surface: SurfaceWeatherState = { wetness: 0, puddles: 0, snow: 0 };
  private readonly grip: Record<"gravel" | "grass" | "dirt", TrackSurfaceGrip>;
  private readonly sample: TrackSurfaceSample = { s: 0, lateral: 0, road: 0, rut: 0, berm: 0 };
  private accumulator = 0;

  constructor(readonly track: TrackTerrain, options: TrackWeatherGroundOptions = {}) {
    const sp = track.spline;
    const margin = track.bermOuterEdge + (options.margin ?? 12);
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (let i = 0; i < sp.sampleCount; i++) {
      minX = Math.min(minX, sp.px[i]!);
      maxX = Math.max(maxX, sp.px[i]!);
      minZ = Math.min(minZ, sp.pz[i]!);
      maxZ = Math.max(maxZ, sp.pz[i]!);
    }
    const size = Math.max(maxX - minX, maxZ - minZ) + 2 * margin;
    const cx = (minX + maxX) / 2;
    const cz = (minZ + maxZ) / 2;
    this.field = new GroundMoistureField({
      originX: cx - size / 2,
      originZ: cz - size / 2,
      size,
      resolution: options.resolution ?? 128,
      heightAt: (x, z) => track.heightAt(x, z),
      soilAt: (x, z) => this.soilAt(x, z),
      dryingTime: 7200,
    });
    this.timeScale = options.timeScale ?? 60;
    this.interval = options.interval ?? 0.5;
    this.grip = { ...TRACK_SURFACE_GRIP, ...(options.grip ?? {}) };
  }

  /** The soil under (x, z): gravel on the road and shoulder, grass on the berms, dirt beyond. */
  soilAt(x: number, z: number): SoilName {
    const s = this.track.surfaceAt(x, z, this.sample);
    if (!Number.isFinite(s.lateral)) return "dirt";
    if (s.road > 0.5 || (s.berm < 0.5 && Math.abs(s.lateral) < this.track.bermOuterEdge * 0.5)) return "gravel";
    if (s.berm > 0.3) return "grass";
    return "dirt";
  }

  /**
   * Tyre grip multiplier at (x, z): the surface's dry grip, its wet loss at the 17.4 wetness (or
   * the field's soil moisture, whichever is wetter), the field's mud/standing water, and snow (the
   * deeper of 17.4 cover and the field's drift, counted once).
   */
  gripAt(x: number, z: number): number {
    const s = this.track.surfaceAt(x, z, this.sample);
    let g: TrackSurfaceGrip;
    if (!Number.isFinite(s.lateral)) g = this.grip.dirt;
    else if (s.berm > 0.5) g = this.grip.grass;
    else if (s.road > 0.5 || Math.abs(s.lateral) < this.track.bermOuterEdge * 0.5) g = this.grip.gravel;
    else g = this.grip.dirt;
    const f = this.field;
    const k = f.indexAt(x, z);
    const soilWet = k < 0 ? 0 : f.moisture[k]!;
    const wet = Math.max(clamp(this.surface.wetness, 0, 1), soilWet);
    const fieldSnow = k < 0 ? 0 : clamp(f.snow[k]! / 0.05, 0, 1);
    const snow = Math.max(clamp(this.surface.snow, 0, 1), fieldSnow);
    // Field grip without its snow term (snow is counted once, below).
    const mud = k < 0 ? 0 : f.mudAt(x, z);
    const puddle = k < 0 ? clamp(this.surface.puddles, 0, 1) * 0.5 : clamp(f.water[k]! / 0.01, 0, 1);
    const grip = g.dry * (1 - g.wetLoss * wet) * (1 - 0.5 * mud) * (1 - 0.27 * puddle) * (1 - 0.7 * Math.sqrt(snow));
    return clamp(grip, 0.15, 1);
  }

  /** Snap the field to a condition (the weather menu): uniform state, then a settle so water pools. */
  applyCondition(condition: TrackGroundCondition, settleSeconds = 600): void {
    this.field.setUniform({ moisture: condition.moisture, water: condition.water, snow: condition.snow });
    if (settleSeconds > 0 && condition.water > 0) {
      const calm: MeltEnvironment = {
        sunDirection: { x: 0, y: 1, z: 0 }, sunIrradiance: 0, diffuseIrradiance: 0, airTemperatureC: 10,
        windSpeed: 0, cloudCover: 1, precipitation: 0, humidity: 1,
      };
      for (let t = 0; t < settleSeconds; t += 60) this.field.step(60, calm);
      // The settle drains a little; put the soil back where the condition asked.
      for (let k = 0; k < this.field.moisture.length; k++) this.field.moisture[k] = Math.max(this.field.moisture[k]!, condition.moisture);
    }
  }

  /**
   * Advance by `realDt` seconds under `env`. Steps the field every {@link interval} real seconds
   * (× {@link timeScale} simulated) and returns true when it stepped (re-upload the overlay then).
   */
  update(realDt: number, env: MeltEnvironment): boolean {
    this.accumulator += Math.max(0, realDt);
    if (this.accumulator < this.interval) return false;
    const sim = this.accumulator * this.timeScale;
    this.accumulator = 0;
    this.field.step(sim, env);
    return true;
  }
}
