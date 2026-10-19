/** Read-only environment diagnostics for sun, atmosphere, weather, clouds, water, and lightning (21.9). */

import type { Scene } from "../scene/scene.js";
import type { EntityId } from "../scene/entityId.js";
import { Light } from "../scene/components/index.js";
import { DayNightCycle } from "../environment/dayNight.js";
import { EARTH_ATMOSPHERE, type AtmosphereParams } from "../environment/atmosphere.js";
import { LightningSystem } from "../environment/lightning.js";
import { WeatherSystem, type WeatherState } from "../environment/weather.js";
import type { SurfaceWeatherState } from "../environment/surfaceWeather.js";
import { Vec3 } from "../math/vec.js";

export interface EnvironmentDebugOptions {
  /** Sample weather wind and precipitation at this world-space point (default origin). */
  samplePosition?: { x: number; y: number; z: number };
  /** Maximum weather/day-night/lightning systems and strike records to include. */
  maxSystems?: number;
  maxStrikes?: number;
  /** Length of the sun-direction line in world units. Defaults to 100. */
  sunLineLength?: number;
  /** Converts wind speed (m/s) to debug-line world units. Defaults to 2. */
  windLineScale?: number;
  /** Maximum lightning bolt line segments returned. Defaults to 512. */
  maxLightningLines?: number;
}

export interface DayNightDebugInfo {
  name: string;
  year: number;
  dayOfYear: number;
  timeOfDay: number;
  timeZone: number;
  latitude: number;
  longitude: number;
  simulatedSeconds: number;
  isDay: boolean;
  elevationDeg: number;
  azimuthDeg: number;
  sunDirection: [number, number, number];
  sunColor: [number, number, number];
  sunLightIntensity: number;
}

export interface SunLightDebugInfo {
  entityId: EntityId;
  direction: [number, number, number];
  towardSun: [number, number, number];
  color: [number, number, number];
  intensity: number;
  castShadow: boolean;
  affectsScene: boolean;
}

export interface WeatherDebugInfo {
  name: string;
  enabled: boolean;
  state: WeatherState;
  target: WeatherState;
  surface: SurfaceWeatherState;
  grip: number;
  simulatedSeconds: number;
  wind: [number, number, number];
  precipitationAtSample: number;
  samplePosition: [number, number, number];
  drives: {
    fog: boolean;
    sky: boolean;
    clouds: boolean;
    lighting: boolean;
    surface: boolean;
    vehicles: boolean;
    water: boolean;
  };
}

export interface LightningStrikeDebugInfo {
  id: number;
  position: [number, number, number];
  energy: number;
  age: number;
  duration: number;
  cloudOnly: boolean;
  pointCount: number;
  branchCount: number;
}

export interface LightningDebugInfo {
  name: string;
  enabled: boolean;
  rate: number;
  stormIntensity: number;
  areaRadius: number;
  strikeCount: number;
  activeStrikes: number;
  flashTotal: number;
  thunderCount: number;
  pendingThunder: number;
  nextThunderIn: number | null;
  strikes: LightningStrikeDebugInfo[];
  truncatedStrikes: boolean;
}

export interface EnvironmentDebugSnapshot {
  sceneName: string;
  samplePosition: [number, number, number];
  sun: {
    directionTowardSun: [number, number, number] | null;
    source: "skySettings" | "dayNightCycle" | "directionalLight" | "none";
    skyIntensity: number;
    angularRadius: number;
    lights: SunLightDebugInfo[];
    truncatedLights: boolean;
  };
  dayNight: DayNightDebugInfo[];
  truncatedDayNight: boolean;
  atmosphere: { source: "earthDefault" | "sceneCustom" | "dayNightCycle"; params: AtmosphereParams };
  clouds: {
    enabled: boolean;
    coverage: number;
    density: number;
    height: number;
    thickness: number;
    scale: number;
    layers: number;
    wind: [number, number];
    surfaceShadows: boolean;
    shadowStrength: number;
    flash: { x: number; z: number; radius: number; intensity: number };
    albedo: [number, number, number];
  };
  weather: WeatherDebugInfo[];
  truncatedWeather: boolean;
  water: {
    enabled: boolean;
    level: number;
    size: number;
    time: number;
    screenSpace: string;
    choppiness: number;
    murkDensity: number;
    opacity: number;
    sunGlint: number;
    absorption: [number, number, number];
    waves: Array<{ directionX: number; directionZ: number; wavelength: number; amplitude: number; speed: number; steepness: number; phase: number }>;
    shore: { enabled: boolean; origin: [number, number]; direction: [number, number]; bedLevel: number; slope: number; foamDepth: number; breakDepth: number };
    colors: { deep: [number, number, number]; shallow: [number, number, number]; foam: [number, number, number]; murk: [number, number, number] };
  };
  lightning: LightningDebugInfo[];
  truncatedLightning: boolean;
}

export type EnvironmentDebugLineKind = "sunDirection" | "wind" | "lightning";

export interface EnvironmentDebugLine {
  source: string;
  kind: EnvironmentDebugLineKind;
  start: [number, number, number];
  end: [number, number, number];
  color: number;
}

const SUN_COLOR = 0xffffd040;
const WIND_COLOR = 0xff40e0ff;
const LIGHTNING_COLOR = 0xffe0e8ff;

/** Copy the live environment state into detached, bounded plain data. */
export function inspectEnvironment(scene: Scene, options: EnvironmentDebugOptions = {}): EnvironmentDebugSnapshot {
  const maxSystems = bounded(options.maxSystems, 32, 128);
  const maxStrikes = bounded(options.maxStrikes, 32, 256);
  const samplePosition = options.samplePosition ?? { x: 0, y: 0, z: 0 };
  const sample: [number, number, number] = [samplePosition.x, samplePosition.y, samplePosition.z];
  const settings = scene.settings;
  const cycles = scene.objects.filter((object): object is DayNightCycle => object instanceof DayNightCycle);
  const weatherSystems = scene.objects.filter((object): object is WeatherSystem => object instanceof WeatherSystem);
  const lightningSystems = scene.objects.filter((object): object is LightningSystem => object instanceof LightningSystem);
  const lights = scene.world.store(Light).liveValues().filter((light) => light.enabled && light.kind === "directional");
  const activeCycle = cycles[0];
  const firstSun = lights[0];
  const skyDirection = settings.sky.sunDirection;
  const directionTowardSun = skyDirection
    ? [skyDirection.x, skyDirection.y, skyDirection.z] as [number, number, number]
    : activeCycle
      ? [activeCycle.sunDirection.x, activeCycle.sunDirection.y, activeCycle.sunDirection.z] as [number, number, number]
      : firstSun
        ? [-firstSun.direction.x, -firstSun.direction.y, -firstSun.direction.z] as [number, number, number]
        : null;
  const sunSource = skyDirection ? "skySettings" : activeCycle ? "dayNightCycle" : firstSun ? "directionalLight" : "none";
  const atmosphere = settings.sky.atmosphere;
  const cycleAtmosphere = activeCycle?.atmosphere.params;
  const atmosphereParams = atmosphere ?? cycleAtmosphere ?? EARTH_ATMOSPHERE;
  const atmosphereSource = atmosphere ? "sceneCustom" : cycleAtmosphere ? "dayNightCycle" : "earthDefault";

  return {
    sceneName: scene.name,
    samplePosition: sample,
    sun: {
      directionTowardSun,
      source: sunSource,
      skyIntensity: settings.sky.sunIntensity,
      angularRadius: settings.sky.sunAngularRadius,
      lights: lights.slice(0, maxSystems).map((light) => ({
        entityId: light.entity,
        direction: [light.direction.x, light.direction.y, light.direction.z],
        towardSun: [-light.direction.x, -light.direction.y, -light.direction.z],
        color: [light.color.x, light.color.y, light.color.z],
        intensity: light.intensity,
        castShadow: light.castShadow,
        affectsScene: light.affectScene,
      })),
      truncatedLights: lights.length > maxSystems,
    },
    dayNight: cycles.slice(0, maxSystems).map((cycle) => ({
      name: cycle.name,
      year: cycle.year,
      dayOfYear: cycle.dayOfYear,
      timeOfDay: cycle.timeOfDay,
      timeZone: cycle.timeZone,
      latitude: cycle.latitude,
      longitude: cycle.longitude,
      simulatedSeconds: cycle.simulatedSeconds,
      isDay: cycle.isDay,
      elevationDeg: cycle.elevationDeg,
      azimuthDeg: cycle.azimuthDeg,
      sunDirection: [cycle.sunDirection.x, cycle.sunDirection.y, cycle.sunDirection.z],
      sunColor: [cycle.sunColor.r, cycle.sunColor.g, cycle.sunColor.b],
      sunLightIntensity: cycle.sunLightIntensity,
    })),
    truncatedDayNight: cycles.length > maxSystems,
    atmosphere: { source: atmosphereSource, params: cloneAtmosphere(atmosphereParams) },
    clouds: {
      enabled: settings.clouds.enabled,
      coverage: settings.clouds.coverage,
      density: settings.clouds.density,
      height: settings.clouds.height,
      thickness: settings.clouds.thickness,
      scale: settings.clouds.scale,
      layers: settings.clouds.layers,
      wind: [settings.clouds.windX, settings.clouds.windZ],
      surfaceShadows: settings.clouds.surfaceShadows,
      shadowStrength: settings.clouds.shadowStrength,
      flash: { x: settings.clouds.flashX, z: settings.clouds.flashZ, radius: settings.clouds.flashRadius, intensity: settings.clouds.flashIntensity },
      albedo: [settings.clouds.albedo.r, settings.clouds.albedo.g, settings.clouds.albedo.b],
    },
    weather: weatherSystems.slice(0, maxSystems).map((weather) => {
      const wind = weather.sampleWindAt(sample[0], sample[2]);
      return {
        name: weather.name,
        enabled: weather.enabled,
        state: { ...weather.state },
        target: { ...weather.target },
        surface: { ...weather.surface },
        grip: weather.grip,
        simulatedSeconds: weather.simulatedSeconds,
        wind: [wind.x, 0, wind.y],
        precipitationAtSample: weather.samplePrecipitationAt(sample[0], sample[2]),
        samplePosition: [...sample],
        drives: {
          fog: weather.driveFog,
          sky: weather.driveSky,
          clouds: weather.driveClouds,
          lighting: weather.driveLighting,
          surface: weather.driveSurface,
          vehicles: weather.driveVehicles,
          water: Boolean(weather.driveWater),
        },
      };
    }),
    truncatedWeather: weatherSystems.length > maxSystems,
    water: {
      enabled: settings.water.enabled,
      level: settings.water.level,
      size: settings.water.size,
      time: settings.water.time,
      screenSpace: settings.water.screenSpace,
      choppiness: settings.water.choppiness,
      murkDensity: settings.water.murkDensity,
      opacity: settings.water.opacity,
      sunGlint: settings.water.sunGlint,
      absorption: [...settings.water.absorption],
      waves: settings.water.waves.map((wave) => ({ ...wave })),
      shore: {
        enabled: settings.water.shore.enabled,
        origin: [settings.water.shore.originX, settings.water.shore.originZ],
        direction: [settings.water.shore.directionX, settings.water.shore.directionZ],
        bedLevel: settings.water.shore.bedLevel,
        slope: settings.water.shore.slope,
        foamDepth: settings.water.shore.foamDepth,
        breakDepth: settings.water.shore.breakDepth,
      },
      colors: {
        deep: [settings.water.deepColor.r, settings.water.deepColor.g, settings.water.deepColor.b],
        shallow: [settings.water.shallowColor.r, settings.water.shallowColor.g, settings.water.shallowColor.b],
        foam: [settings.water.foamColor.r, settings.water.foamColor.g, settings.water.foamColor.b],
        murk: [settings.water.murkColor.r, settings.water.murkColor.g, settings.water.murkColor.b],
      },
    },
    lightning: lightningSystems.slice(0, maxSystems).map((system) => {
      const pending = system.pendingThunder.map((item) => Math.max(0, item.at - system.simulatedSeconds));
      const strikes = system.strikes.slice(0, maxStrikes).map((strike) => ({
        id: strike.id,
        position: [strike.position.x, strike.position.y, strike.position.z] as [number, number, number],
        energy: strike.energy,
        age: strike.age,
        duration: strike.duration,
        cloudOnly: strike.bolt.cloudOnly,
        pointCount: strike.bolt.points.length,
        branchCount: strike.bolt.branches.length,
      }));
      return {
        name: system.name,
        enabled: system.enabled,
        rate: system.rate,
        stormIntensity: system.stormIntensity(),
        areaRadius: system.areaRadius,
        strikeCount: system.strikeCount,
        activeStrikes: system.strikes.length,
        flashTotal: system.flashTotal,
        thunderCount: system.thunderCount,
        pendingThunder: system.pendingThunder.length,
        nextThunderIn: pending.length ? Math.min(...pending) : null,
        strikes,
        truncatedStrikes: system.strikes.length > strikes.length,
      };
    }),
    truncatedLightning: lightningSystems.length > maxSystems,
  };
}

/** Generate sun, sampled-wind, and active-lightning line segments. */
export function environmentDebugLines(scene: Scene, options: EnvironmentDebugOptions = {}): EnvironmentDebugLine[] {
  const snapshot = inspectEnvironment(scene, options);
  const p = snapshot.samplePosition;
  const lines: EnvironmentDebugLine[] = [];
  const sunLength = Number.isFinite(options.sunLineLength) ? options.sunLineLength! : 100;
  if (snapshot.sun.directionTowardSun) {
    const d = snapshot.sun.directionTowardSun;
    lines.push(makeLine("sun", "sunDirection", p, [p[0] + d[0] * sunLength, p[1] + d[1] * sunLength, p[2] + d[2] * sunLength], SUN_COLOR));
  }
  const windScale = Number.isFinite(options.windLineScale) ? options.windLineScale! : 2;
  for (const weather of snapshot.weather) {
    const w = weather.wind;
    lines.push(makeLine(weather.name, "wind", p, [p[0] + w[0] * windScale, p[1] + w[1] * windScale, p[2] + w[2] * windScale], WIND_COLOR));
  }
  const lineCap = bounded(options.maxLightningLines, 512, 4096);
  const maxSystems = bounded(options.maxSystems, 32, 128);
  const maxStrikes = bounded(options.maxStrikes, 32, 256);
  const systems = scene.objects.filter((object): object is LightningSystem => object instanceof LightningSystem).slice(0, maxSystems);
  let lightningLineCount = 0;
  for (const system of systems) {
    for (const strike of system.strikes.slice(0, maxStrikes)) {
      lightningLineCount += appendPolyline(lines, system.name, strike.bolt.points, lineCap - lightningLineCount);
      for (const branch of strike.bolt.branches) {
        lightningLineCount += appendPolyline(lines, system.name, branch, lineCap - lightningLineCount);
        if (lightningLineCount >= lineCap) return lines;
      }
      if (lightningLineCount >= lineCap) return lines;
    }
  }
  return lines;
}

/** Forward environment vectors and bolt segments to a Renderer-compatible callback. */
export function drawEnvironmentDebug(
  scene: Scene,
  drawLine: (start: Vec3, end: Vec3, color: number) => void,
  options: EnvironmentDebugOptions = {},
): number {
  const lines = environmentDebugLines(scene, options);
  for (const item of lines) drawLine(new Vec3(...item.start), new Vec3(...item.end), item.color);
  return lines.length;
}

function appendPolyline(out: EnvironmentDebugLine[], source: string, points: readonly Vec3[], remaining: number): number {
  let added = 0;
  for (let i = 1; i < points.length && added < remaining; i++, added++) {
    const a = points[i - 1]!, b = points[i]!;
    out.push(makeLine(source, "lightning", [a.x, a.y, a.z], [b.x, b.y, b.z], LIGHTNING_COLOR));
  }
  return added;
}

function makeLine(source: string, kind: EnvironmentDebugLineKind, start: [number, number, number], end: [number, number, number], color: number): EnvironmentDebugLine {
  return { source, kind, start, end, color: color >>> 0 };
}

function cloneAtmosphere(input: Readonly<AtmosphereParams>): AtmosphereParams {
  return {
    ...input,
    rayleighScattering: [...input.rayleighScattering],
    mieScattering: [...input.mieScattering],
    mieExtinction: [...input.mieExtinction],
    ozoneAbsorption: [...input.ozoneAbsorption],
    groundAlbedo: [...input.groundAlbedo],
  };
}

function bounded(value: number | undefined, fallback: number, maximum: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(maximum, Math.floor(value!))) : fallback;
}
