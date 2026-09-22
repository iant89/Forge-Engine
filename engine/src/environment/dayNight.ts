/**
 * Day/night cycle (Phase 8a): a `SceneObject` that owns a calendar clock and, every frame, points
 * the scene's sun at where the sun really is for that latitude, date and time — then colours it by
 * the atmosphere's transmittance, fills `ambientColor` from the sky's hemispherical radiance, and
 * (optionally) tints the fog to the horizon so distant geometry fades into the sky pass.
 *
 * Time advances by the **fixed-step** budget of the frame (`fixedSteps × fixedDt × timeScale`), so
 * a run of N steps lands on the same minute regardless of frame rate, and the cycle freezes when the
 * clock is paused. The drive is idempotent: `apply()` recomputes everything from
 * (year, dayOfYear, timeOfDay), which is also what `setTime`/`advance` mutate, so a scene can scrub
 * time freely and a test can assert the exact sun vector for a given instant.
 *
 * Coordinates: `timeOfDay` is local clock time (hours); `timeZone` (hours east of UTC) and
 * `longitude` (degrees east) turn it into UTC for the solar model. Leaving both at 0 makes
 * `timeOfDay` local **mean solar** time — noon is within the equation of time (±16 min) of the sun's
 * highest point, which is what most games want.
 */

import { SceneObject, type Scene } from "../scene/scene.js";
import type { SystemContext } from "../scene/systems.js";
import { Light } from "../scene/components/index.js";
import { Vec3 } from "../math/vec.js";
import { Color } from "../math/color.js";
import { clamp, RAD_TO_DEG, smoothstep } from "../math/scalar.js";
import { AtmosphereModel, EARTH_ATMOSPHERE, SKY_QUALITY_SAMPLES, createAtmosphere, type AtmosphereParams } from "./atmosphere.js";
import { createSolarPosition, daysInYear, julianDayFromDayOfYear, solarPosition, sunDirection, type SolarPosition } from "./solar.js";

export interface DayNightOptions {
  name?: string;
  /** Degrees north. Default 45. */
  latitude?: number;
  /** Degrees east. Default 0. */
  longitude?: number;
  /** Hours east of UTC that `timeOfDay` is expressed in. Default 0. */
  timeZone?: number;
  /** Calendar year (leap years and the slow drift of the equinoxes come from it). Default 2000. */
  year?: number;
  /** 1-based day of the year; may carry a fraction. Default 172 (June 21). */
  dayOfYear?: number;
  /** Local clock time in hours [0, 24). Default 9. */
  timeOfDay?: number;
  /** Simulated seconds per real second. 0 freezes the clock. Default 60. */
  timeScale?: number;
  /** Atmosphere the sun colour / ambient / horizon are computed with. Default Earth. */
  atmosphere?: Partial<AtmosphereParams> | Readonly<AtmosphereParams>;
  /** The directional light to drive; `null` finds the first directional light on attach. */
  sun?: Light | null;
  /** `Light.intensity` at the zenith with no atmosphere in the way. Default 4. */
  sunIntensity?: number;
  /** Write `scene.settings.ambientColor` from the sky's hemispherical radiance. Default true. */
  driveAmbient?: boolean;
  /** Multiplier on the sky-derived ambient. Default 1. */
  ambientScale?: number;
  /** Linear-RGB floor the ambient never drops below (starlight/airglow). Default (0.02, 0.023, 0.032). */
  nightAmbient?: Color;
  /** Write `scene.settings.fog.color` from the horizon radiance. Default true. */
  driveFog?: boolean;
  /** Write `scene.settings.sky.sunDirection` and enable the sky pass on attach. Default true. */
  driveSky?: boolean;
  /** Observer height above sea level used for the transmittance/ambient evaluation, metres. Default 0. */
  observerHeight?: number;
}

const HORIZON_RAMP = 0.5 * (Math.PI / 180);
/** Elevation the fog colour is sampled at: just above the horizon, clear of the ground term. */
const HORIZON_ELEVATION = 1.5 * (Math.PI / 180);
const COS_REEVALUATE = Math.cos(0.03 * (Math.PI / 180));
const SUN_TRANSMITTANCE_SAMPLES = 32;

export class DayNightCycle extends SceneObject {
  readonly name: string;
  latitude: number;
  longitude: number;
  timeZone: number;
  year: number;
  dayOfYear: number;
  timeOfDay: number;
  timeScale: number;
  sun: Light | null;
  sunIntensity: number;
  driveAmbient: boolean;
  ambientScale: number;
  driveFog: boolean;
  driveSky: boolean;
  observerHeight: number;
  readonly nightAmbient: Color;
  readonly atmosphere: AtmosphereModel;

  /** Outputs of the last `apply()`. */
  readonly position: SolarPosition = createSolarPosition();
  /** Unit vector toward the sun (engine axes). */
  readonly sunDirection = new Vec3(0, 1, 0);
  /** Transmittance-coloured sunlight (linear RGB, before intensity). */
  readonly sunColor = new Color(1, 1, 1);
  /** Light intensity after the horizon ramp. */
  sunLightIntensity = 0;
  readonly ambient = new Color();
  readonly horizon = new Color();
  /** Seconds of simulated time advanced since creation. */
  simulatedSeconds = 0;

  private readonly rgb = new Float64Array(3);
  private readonly evaluatedDirection = new Vec3(0, 0, 0);
  private evaluated = false;
  private applied = false;

  constructor(options: DayNightOptions = {}) {
    super();
    this.name = options.name ?? "dayNight";
    this.latitude = options.latitude ?? 45;
    this.longitude = options.longitude ?? 0;
    this.timeZone = options.timeZone ?? 0;
    this.year = options.year ?? 2000;
    this.dayOfYear = options.dayOfYear ?? 172;
    this.timeOfDay = options.timeOfDay ?? 9;
    this.timeScale = options.timeScale ?? 60;
    this.sun = options.sun ?? null;
    this.sunIntensity = options.sunIntensity ?? 4;
    this.driveAmbient = options.driveAmbient ?? true;
    this.ambientScale = options.ambientScale ?? 1;
    this.nightAmbient = options.nightAmbient ? options.nightAmbient.clone() : new Color(0.02, 0.023, 0.032);
    this.driveFog = options.driveFog ?? true;
    this.driveSky = options.driveSky ?? true;
    this.observerHeight = options.observerHeight ?? 0;
    const atmo = options.atmosphere;
    const params = atmo && "planetRadius" in atmo && "viewSamples" in atmo ? createAtmosphere({}, atmo as Readonly<AtmosphereParams>) : createAtmosphere(atmo ?? {}, EARTH_ATMOSPHERE);
    this.atmosphere = new AtmosphereModel(params);
  }

  /** UTC Julian day of the current instant. */
  get julianDay(): number {
    return julianDayFromDayOfYear(this.year, this.dayOfYear, this.timeOfDay - this.timeZone);
  }

  get elevationDeg(): number {
    return this.position.elevation * RAD_TO_DEG;
  }

  get azimuthDeg(): number {
    return this.position.azimuth * RAD_TO_DEG;
  }

  /** True while the (refracted) sun centre is above the horizon. */
  get isDay(): boolean {
    return this.position.elevation > 0;
  }

  /** Hours as `HH:MM`. */
  get clockText(): string {
    const total = Math.floor(((this.timeOfDay % 24) + 24) % 24 * 60);
    const h = Math.floor(total / 60);
    const m = total % 60;
    return `${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}`;
  }

  setTime(hours: number): this {
    this.timeOfDay = ((hours % 24) + 24) % 24;
    this.applied = false;
    return this;
  }

  setDate(dayOfYear: number, year = this.year): this {
    this.year = year;
    this.dayOfYear = clamp(dayOfYear, 1, daysInYear(year) + 0.999999);
    this.applied = false;
    return this;
  }

  /**
   * Swap the atmosphere the light/ambient/fog are derived from (the sky pass reads
   * `scene.settings.sky.atmosphere` separately — keep the two in step). Copies `params`.
   */
  setAtmosphere(params: Partial<AtmosphereParams> | Readonly<AtmosphereParams>): this {
    Object.assign(this.atmosphere.params, createAtmosphere(params, this.atmosphere.params));
    return this.refresh();
  }

  /** Force the next `apply()` to re-evaluate the sky-derived colours even if the sun did not move. */
  refresh(): this {
    this.evaluated = false;
    this.applied = false;
    return this;
  }

  /** Advance the simulated clock (seconds), wrapping days and years. */
  advance(seconds: number): this {
    if (!(seconds !== 0) || !Number.isFinite(seconds)) return this;
    this.simulatedSeconds += seconds;
    let hours = this.timeOfDay + seconds / 3600;
    while (hours >= 24) {
      hours -= 24;
      this.dayOfYear += 1;
      if (this.dayOfYear >= daysInYear(this.year) + 1) {
        this.dayOfYear -= daysInYear(this.year);
        this.year += 1;
      }
    }
    while (hours < 0) {
      hours += 24;
      this.dayOfYear -= 1;
      if (this.dayOfYear < 1) {
        this.year -= 1;
        this.dayOfYear += daysInYear(this.year);
      }
    }
    this.timeOfDay = hours;
    this.applied = false;
    return this;
  }

  override onAttach(scene: Scene): void {
    if (!this.sun) {
      for (const light of scene.collectLights()) {
        if (light.kind === "directional") {
          this.sun = light;
          break;
        }
      }
    }
    if (this.driveSky) scene.settings.skyEnabled = true;
    this.applied = false;
    this.apply();
  }

  override update(context: SystemContext): void {
    const seconds = context.fixedSteps * context.fixedDt * this.timeScale;
    if (seconds !== 0) this.advance(seconds);
    if (!this.applied) this.apply();
  }

  /**
   * Recompute the sun from the calendar and push it into the light and the scene settings. Safe to
   * call at any time (the demo calls it after scrubbing time so the HUD reads the new values).
   */
  apply(): void {
    this.applied = true;
    const pos = solarPosition(this.julianDay, this.latitude, this.longitude, this.position);
    sunDirection(pos, this.sunDirection);
    const atmo = this.atmosphere;
    const rgb = this.rgb;

    // 32 uniform light samples: the horizon path is ~400 km with its air in the first 100, and the
    // sun's colour at dusk is what this number decides. Cheap (96 exponentials).
    atmo.sunTransmittance(this.sunDirection, this.observerHeight, rgb, SUN_TRANSMITTANCE_SAMPLES);
    this.sunColor.set(rgb[0]!, rgb[1]!, rgb[2]!);
    const ramp = smoothstep(-HORIZON_RAMP, HORIZON_RAMP, pos.elevation);
    this.sunLightIntensity = this.sunIntensity * ramp;

    const sun = this.sun;
    if (sun) {
      sun.followRotation = false;
      sun.direction.set(-this.sunDirection.x, -this.sunDirection.y, -this.sunDirection.z);
      sun.color.set(this.sunColor.r, this.sunColor.g, this.sunColor.b);
      sun.intensity = this.sunLightIntensity;
    }

    // The hemispherical integrals (~0.25 ms) only move with the sun: skip them until it has moved
    // by more than ~0.03° (a fraction of the sun's own width) since they were last evaluated.
    const moved = this.sunDirection.dot(this.evaluatedDirection) < COS_REEVALUATE;
    if (moved || !this.evaluated) {
      this.evaluated = true;
      this.evaluatedDirection.copyFrom(this.sunDirection);
      atmo.skyAmbient(this.sunDirection, this.observerHeight, rgb);
      const floor = this.nightAmbient;
      this.ambient.set(Math.max(floor.r, rgb[0]! * this.ambientScale), Math.max(floor.g, rgb[1]! * this.ambientScale), Math.max(floor.b, rgb[2]! * this.ambientScale));
      // Same sample counts as the sky pass, so the fog colour is the horizon the pass actually draws.
      const [viewSamples, lightSamples] = SKY_QUALITY_SAMPLES[this.scene?.settings.sky.quality ?? "medium"];
      atmo.horizonColor(this.sunDirection, this.observerHeight, rgb, 8, HORIZON_ELEVATION, viewSamples, lightSamples);
      this.horizon.set(Math.max(floor.r, rgb[0]!), Math.max(floor.g, rgb[1]!), Math.max(floor.b, rgb[2]!));
    }
    const scene = this.scene;
    if (!scene) return;
    if (this.driveAmbient) scene.settings.ambientColor.copyFrom(this.ambient);
    if (this.driveFog) scene.settings.fog.color.copyFrom(this.horizon);
    if (this.driveSky) {
      const sky = scene.settings.sky;
      if (sky.sunDirection) sky.sunDirection.copyFrom(this.sunDirection);
      else sky.sunDirection = this.sunDirection.clone();
    }
  }

  override stats(): Record<string, number | string | boolean> {
    return {
      time: this.clockText,
      day: Math.floor(this.dayOfYear),
      elevationDeg: Math.round(this.elevationDeg * 10) / 10,
      azimuthDeg: Math.round(this.azimuthDeg * 10) / 10,
      isDay: this.isDay,
      sunIntensity: Math.round(this.sunLightIntensity * 100) / 100,
    };
  }
}
