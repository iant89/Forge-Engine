/**
 * Environment (Phase 8b): weather state, cloud deck, water surface and lightning.
 *
 * What these prove, and against what:
 *  - the weather presets order clear → storm, the drift is exponential (exact per-step, so the
 *    path does not matter), the wind direction takes the shortest arc, and `apply` drives fog /
 *    turbidity / cloud cover + deck wind (or nothing, when the drive flags are off);
 *  - the wind/temperature/precipitation fields are deterministic in (x, z, t, seed): zero gust is
 *    exactly the mean wind, turbulence is bounded by `gust·(2 + 0.3·speed)`, temperature falls at
 *    the lapse rate, and a dry state rains nowhere;
 *  - the cloud deck is honest: coverage 0 is clear, coverage 1 is overcast at `density`, the mean
 *    over a large area rises monotonically with the slider, and the CPU shading is the documented
 *    formula (forward silver lobe, dense cores transmit less, horizon fade) lit by the 8a sky —
 *    the lighting cache re-evaluates only when the sun moves;
 *  - the Gerstner sampler reproduces single-wave closed forms (height, analytic normal, crest,
 *    horizontal displacement), stays within its amplitude budget, and agrees with the surface's
 *    query helpers; the grid source is a valid indexed plane with amplitude-padded bounds;
 *  - the flash envelope is a double stroke below 1 % after `flashDuration`, bolts are deterministic
 *    polylines from cloud to ground, and the Poisson scheduler replays identically for a seed;
 *  - the renderer draws the water technique and the cloud deck with zero mock-device errors, and
 *    the underwater path skips `forge.sky` while flagging `stats.underwater` (round-trips through
 *    serialize/applySerialized keep the new settings).
 */

import { describe, expect, it } from "vitest";
import {
  AABB,
  AtmosphereModel,
  Camera,
  Color,
  DEFAULT_WEATHER_TAU,
  EARTH_ATMOSPHERE,
  Geometry,
  GraphicsDevice,
  Light,
  LightningSystem,
  Material,
  Renderer,
  Scene,
  SkyLightingCache,
  TEMPERATURE_LAPSE_PER_M,
  Vec2,
  Vec3,
  WaterSurface,
  WeatherSystem,
  WEATHER_PRESETS,
  approachExponential,
  cloudAlpha,
  cloudDensityAt,
  cloudRadiance,
  createWaterSample,
  defaultCloudLayerParams,
  flashDuration,
  flashEnvelope,
  foamFromCrest,
  generateBoltPoints,
  isUnderwater,
  meanCloudDensity,
  sampleGerstner,
  totalWaveAmplitude,
  waterGridSource,
  waterHeightAt,
  wrapAngle,
} from "@forge/engine";

const DEG = Math.PI / 180;
// The default attack (8 ms) is the unit the envelope tests measure the peak in.
const DEFAULT_FLASH_ATTACK = 0.008;
const fakeContext = (fixedSteps: number, fixedDt: number) => ({ fixedSteps, fixedDt }) as never;

describe("weather state", () => {
  it("orders the presets from clear to storm", () => {
    const { clear, overcast, rain, storm } = WEATHER_PRESETS;
    expect(clear.windSpeed).toBeLessThan(overcast.windSpeed);
    expect(overcast.windSpeed).toBeLessThan(rain.windSpeed);
    expect(rain.windSpeed).toBeLessThan(storm.windSpeed);
    expect(clear.cloudCoverage).toBeLessThan(overcast.cloudCoverage);
    expect(overcast.cloudCoverage).toBeLessThan(rain.cloudCoverage);
    expect(rain.cloudCoverage).toBeLessThan(storm.cloudCoverage);
    expect(clear.precipitation01).toBe(0);
    expect(storm.storm01).toBe(1);
    expect(storm.gust).toBe(1);
  });

  it("drifts exponentially toward the target (1 − 1/e of the gap per tau)", () => {
    const w = new WeatherSystem({ initial: "clear", target: "storm" });
    const before = w.state.temperatureC;
    const goal = w.target.temperatureC;
    w.advance(DEFAULT_WEATHER_TAU.temperatureC);
    expect(w.state.temperatureC).toBeCloseTo(before + (goal - before) * (1 - Math.exp(-1)), 10);
    // Convergence: after many taus the state is the target.
    w.advance(100 * DEFAULT_WEATHER_TAU.temperatureC);
    expect(w.state.temperatureC).toBeCloseTo(goal, 10);
    expect(w.state.windSpeed).toBeCloseTo(w.target.windSpeed, 6);
  });

  it("is path-independent: one long step equals many short ones", () => {
    const opts = { initial: "clear" as const, target: "storm" as const, seed: 42 };
    const a = new WeatherSystem(opts);
    const b = new WeatherSystem(opts);
    a.advance(37);
    for (let i = 0; i < 37; i++) b.advance(1);
    for (const k of ["windSpeed", "windDirection", "gust", "temperatureC", "humidity01", "precipitation01", "storm01", "cloudCoverage"] as const) {
      expect(a.state[k]).toBeCloseTo(b.state[k], 9);
    }
    // The step itself is exact exponential integration, not Euler.
    expect(approachExponential(10, 20, 5, 5)).toBeCloseTo(20 - 10 * Math.exp(-1), 12);
  });

  it("turns the wind along the shortest arc (350° → 10° goes up, not down)", () => {
    const w = new WeatherSystem({ initial: { windDirection: 350 * DEG }, target: { windDirection: 10 * DEG } });
    w.advance(1);
    expect(w.state.windDirection).toBeGreaterThan(350 * DEG);
    expect(w.state.windDirection).toBeLessThan(360 * DEG);
    w.advance(100 * DEFAULT_WEATHER_TAU.windDirection);
    const converged = wrapAngle(w.state.windDirection - 10 * DEG);
    expect(Math.min(converged, 2 * Math.PI - converged)).toBeCloseTo(0, 6);
  });

  it("drives fog, turbidity, cover and deck wind into the scene (or nothing when told not to)", () => {
    const scene = new Scene({ name: "weather-drive" });
    const baseFog = scene.settings.fog.density;
    const baseTurbidity = scene.settings.sky.turbidity;
    const w = new WeatherSystem({ initial: "storm", target: "storm" });
    scene.add(w);
    expect(scene.settings.fog.density).toBeCloseTo(baseFog + w.rainFogDensity, 12);
    expect(scene.settings.sky.turbidity).toBeCloseTo(baseTurbidity + w.humidityTurbidity + w.stormTurbidity, 12);
    expect(scene.settings.clouds.coverage).toBe(1);
    const wind = w.meanWind();
    expect(scene.settings.clouds.windX).toBeCloseTo(wind.x, 12);
    expect(scene.settings.clouds.windZ).toBeCloseTo(wind.y, 12);

    w.driveFog = false;
    w.driveSky = false;
    w.driveClouds = false;
    scene.settings.fog.density = 0.001;
    scene.settings.sky.turbidity = 3;
    scene.settings.clouds.coverage = 0.2;
    scene.settings.clouds.windX = 0;
    w.snapTo("clear");
    expect(scene.settings.fog.density).toBe(0.001);
    expect(scene.settings.sky.turbidity).toBe(3);
    expect(scene.settings.clouds.coverage).toBe(0.2);
    expect(scene.settings.clouds.windX).toBe(0);
  });

  it("advances from the fixed-step budget through update()", () => {
    const scene = new Scene({ name: "weather-steps" });
    const w = new WeatherSystem({ initial: "clear", target: "storm" });
    scene.add(w);
    w.update(fakeContext(4, 0.5));
    expect(w.simulatedSeconds).toBe(2);
    const stepped = w.state.windSpeed;
    const direct = new WeatherSystem({ initial: "clear", target: "storm" });
    direct.advance(2);
    expect(stepped).toBe(direct.state.windSpeed);
  });
});

describe("weather fields", () => {
  it("reports the mean wind from speed + direction (+x east, +z north)", () => {
    const w = new WeatherSystem({ initial: { windSpeed: 10, windDirection: Math.PI / 2 } });
    const m = w.meanWind();
    expect(m.x).toBeCloseTo(10, 12);
    expect(m.y).toBeCloseTo(0, 12);
  });

  it("samples exactly the mean wind when the gust is zero, deterministically otherwise", () => {
    const calm = new WeatherSystem({ initial: { windSpeed: 7, windDirection: 1, gust: 0 } });
    const mean = calm.meanWind();
    const at = calm.sampleWindAt(123, -456, new Vec2(), 99);
    expect(at.x).toBe(mean.x);
    expect(at.y).toBe(mean.y);

    const gusty = new WeatherSystem({ initial: "storm", seed: 7 });
    const a = gusty.sampleWindAt(10, 20, new Vec2(), 5);
    const b = gusty.sampleWindAt(10, 20, new Vec2(), 5);
    expect(a.x).toBe(b.x);
    expect(a.y).toBe(b.y);
    const later = gusty.sampleWindAt(10, 20, new Vec2(), 6);
    expect(later.x).not.toBe(a.x);
  });

  it("bounds the gust turbulence by gust · (2 + 0.3 · speed) per component", () => {
    const w = new WeatherSystem({ initial: "storm", seed: 11 });
    const amp = w.state.gust * (2 + 0.3 * w.state.windSpeed);
    const mean = w.meanWind();
    let worst = 0;
    for (let i = 0; i < 200; i++) {
      const v = w.sampleWindAt(i * 37.5, i * -11.25, new Vec2(), i * 0.7);
      worst = Math.max(worst, Math.abs(v.x - mean.x), Math.abs(v.y - mean.y));
    }
    // fbm2 is normalised to [−1, 1]; the 5 % slack is Perlin overshoot headroom, not physics.
    expect(worst).toBeLessThanOrEqual(amp * 1.05);
    expect(worst).toBeGreaterThan(amp * 0.2);
  });

  it("cools with altitude at the lapse rate and rains nowhere when dry", () => {
    const w = new WeatherSystem({ initial: "rain" });
    const low = w.sampleTemperatureAt(100, 0, -50, 12);
    const high = w.sampleTemperatureAt(100, 1000, -50, 12);
    expect(high - low).toBeCloseTo(-TEMPERATURE_LAPSE_PER_M * 1000, 12);
    const dry = new WeatherSystem({ initial: "clear" });
    expect(dry.samplePrecipitationAt(0, 0)).toBe(0);
    expect(dry.samplePrecipitationAt(9999, -9999, 4242)).toBe(0);
    const wet = dry.samplePrecipitationAt(100, 100);
    expect(wet).toBeGreaterThanOrEqual(0);
    expect(wet).toBeLessThanOrEqual(1);
  });
});

describe("cloud deck", () => {
  const params = () => ({ ...defaultCloudLayerParams(), density: 0.8, scale: 0.0008, seed: 4242 });

  it("is clear at coverage 0 and overcast at coverage 1", () => {
    const p = params();
    for (const [x, z] of [[0, 0], [12345, -6789], [-1e6, 2e6]] as const) {
      expect(cloudDensityAt(x, z, 0, p.density, p.scale, p.seed)).toBe(0);
      expect(cloudDensityAt(x, z, 1, p.density, p.scale, p.seed)).toBeCloseTo(p.density, 12);
    }
  });

  it("raises the mean density monotonically with the coverage slider", () => {
    const p = params();
    const means = [0, 0.25, 0.5, 0.75, 1].map((c) => meanCloudDensity(c, p.density, p.scale, p.seed));
    expect(means[0]).toBe(0);
    expect(means[4]).toBeCloseTo(p.density, 12);
    for (let i = 1; i < means.length; i++) expect(means[i]).toBeGreaterThan(means[i - 1]!);
    for (const m of means) {
      expect(m).toBeGreaterThanOrEqual(0);
      expect(m).toBeLessThanOrEqual(p.density + 1e-9);
    }
  });

  it("lights the deck from the 8a sky: sun through transmittance, sky as ambient", () => {
    const model = new AtmosphereModel(EARTH_ATMOSPHERE);
    const noon = new Vec3(0.2, 1, 0.1).normalize();
    const sunset = new Vec3(1, 0.03, 0).normalize();
    const sunTint = new Float64Array(3);
    const ambient = new Float64Array(3);
    model.sunTransmittance(noon, 0, sunTint);
    model.skyAmbient(noon, 0, ambient);
    const shading = { sunTint, ambientTint: ambient, albedo: new Color(1, 1, 1), silverLining: 0.8 };
    const up = new Vec3(0, 1, 0);
    // Toward the sun the silver lobe adds light; away from it only sun + ambient remain.
    const toward = cloudRadiance(noon, noon, 0.5, shading, new Float64Array(3));
    const awayDir = new Vec3(1, 0.05, -0.2).normalize();
    const away = cloudRadiance(awayDir, noon, 0.5, shading, new Float64Array(3));
    expect(toward[0]).toBeGreaterThan(away[0]);
    // Dense cores transmit less of the direct sun.
    const thin = cloudRadiance(noon, noon, 0.05, { ...shading, ambientTint: new Float64Array(3) }, new Float64Array(3));
    const thick = cloudRadiance(noon, noon, 1, { ...shading, ambientTint: new Float64Array(3) }, new Float64Array(3));
    expect(thin[1]).toBeGreaterThan(thick[1]);
    // Linear in the sun: double the light, double the sunlit part.
    const doubled = cloudRadiance(noon, noon, 0.5, { ...shading, ambientTint: new Float64Array(3), sunTint: new Float64Array([sunTint[0]! * 2, sunTint[1]! * 2, sunTint[2]! * 2]) }, new Float64Array(3));
    const single = cloudRadiance(noon, noon, 0.5, { ...shading, ambientTint: new Float64Array(3) }, new Float64Array(3));
    expect(doubled[2]).toBeCloseTo(single[2]! * 2, 10);
    // The same deck is dimmer at sunset than at noon (redder, too).
    const noonRad = cloudRadiance(up, noon, 0.6, shading, new Float64Array(3));
    const duskTint = model.sunTransmittance(sunset, 0, new Float64Array(3));
    const duskAmb = model.skyAmbient(sunset, 0, new Float64Array(3));
    const duskRad = cloudRadiance(up, sunset, 0.6, { ...shading, sunTint: duskTint, ambientTint: duskAmb }, new Float64Array(3));
    expect(noonRad[1]!).toBeGreaterThan(duskRad[1]!);
    expect(duskRad[0]! / Math.max(1e-9, duskRad[2]!)).toBeGreaterThan(noonRad[0]! / Math.max(1e-9, noonRad[2]!));
  });

  it("fades the opacity to zero at the horizon (1 − e^(−3d) at the zenith)", () => {
    expect(cloudAlpha(0, 1)).toBe(0);
    expect(cloudAlpha(1, 0)).toBe(0);
    expect(cloudAlpha(1, 1)).toBeCloseTo(1 - Math.exp(-3), 12);
    expect(cloudAlpha(0.5, 0.04)).toBeLessThan(cloudAlpha(0.5, 1));
  });

  it("caches the sky tints until the sun moves", () => {
    const cache = new SkyLightingCache();
    const sun = new Vec3(0.3, 0.8, 0.5).normalize();
    expect(cache.update(sun, EARTH_ATMOSPHERE, 0, 20)).toBe(true);
    expect(cache.evaluations).toBe(1);
    expect(cache.update(sun, EARTH_ATMOSPHERE, 0, 20)).toBe(false);
    expect(cache.evaluations).toBe(1);
    for (const tint of [cache.sunTint, cache.ambientTint, cache.horizonTint]) {
      for (const v of tint) {
        expect(Number.isFinite(v)).toBe(true);
        expect(v).toBeGreaterThanOrEqual(0);
      }
    }
    const moved = sun.clone().add(new Vec3(0.01, 0, 0)).normalize();
    expect(cache.update(moved, EARTH_ATMOSPHERE, 0, 20)).toBe(true);
    // The direct tint scales with the intensity; the others do not move.
    const dim = new SkyLightingCache();
    dim.update(sun, EARTH_ATMOSPHERE, 0, 10);
    const bright = new SkyLightingCache();
    bright.update(sun, EARTH_ATMOSPHERE, 0, 20);
    for (let i = 0; i < 3; i++) {
      expect(bright.sunTint[i]).toBeCloseTo(dim.sunTint[i]! * 2, 10);
      expect(bright.ambientTint[i]).toBeCloseTo(dim.ambientTint[i]!, 12);
    }
  });
});

describe("water surface", () => {
  const sine = [{ directionX: 1, directionZ: 0, wavelength: 2 * Math.PI, amplitude: 2, speed: 1, steepness: 0, phase: 0 }];

  it("reproduces the single-wave closed form (height, normal, crest)", () => {
    // k = 1, f = x − t: at (π/2, 0) the crest, y = A, flat normal, crest 1/2.
    const crest = sampleGerstner(sine, Math.PI / 2, 0, 0);
    expect(crest.y).toBeCloseTo(2, 12);
    expect(crest.dx).toBe(0);
    expect(crest.dz).toBe(0);
    expect(crest.nx).toBeCloseTo(0, 12);
    expect(crest.ny).toBeCloseTo(1, 12);
    expect(crest.nz).toBeCloseTo(0, 12);
    expect(crest.crest).toBeCloseTo(0.5, 12);
    // At the zero crossing the slope is −k·A and the normal is exact.
    const slope = sampleGerstner(sine, 0, 0, 0);
    expect(slope.y).toBeCloseTo(0, 12);
    expect(slope.nx).toBeCloseTo(-2 / Math.sqrt(5), 12);
    expect(slope.ny).toBeCloseTo(1 / Math.sqrt(5), 12);
    expect(slope.crest).toBeCloseTo(1, 12);
    // The phase speed carries the shape: sampling at (x, t) equals (x − t, 0).
    const moved = sampleGerstner(sine, 3, 0, 1);
    const still = sampleGerstner(sine, 2, 0, 0);
    expect(moved.y).toBeCloseTo(still.y, 12);
  });

  it("displaces horizontally along the travel direction with steepness", () => {
    const steep = [{ ...sine[0]!, steepness: 0.5 }];
    // Q = steepness/(k·A·N) with N = 1: dx = Q·A·cos(0) = steepness/k = 0.5.
    const s = sampleGerstner(steep, 0, 0, 0);
    expect(s.dx).toBeCloseTo(0.5, 12);
    expect(s.dz).toBeCloseTo(0, 12);
    // Diagonal travel splits the displacement over both axes.
    const diag = [{ ...sine[0]!, directionX: 1, directionZ: 1, steepness: 0.5 }];
    const d = sampleGerstner(diag, 0, 0, 0);
    expect(d.dx).toBeCloseTo(d.dz!, 12);
    expect(d.dx).toBeCloseTo(0.5 / Math.sqrt(2), 12);
  });

  it("stays inside its amplitude budget with unit normals and 0..1 crests", () => {
    const waves = [
      { directionX: 1, directionZ: 0.3, wavelength: 28, amplitude: 0.22, speed: 3.2, steepness: 0.35, phase: 0 },
      { directionX: 0.7, directionZ: -0.7, wavelength: 13, amplitude: 0.1, speed: 2.4, steepness: 0.3, phase: 1.7 },
    ];
    const budget = totalWaveAmplitude(waves);
    expect(budget).toBeCloseTo(0.32, 12);
    const out = createWaterSample();
    for (let i = 0; i < 100; i++) {
      const s = sampleGerstner(waves, i * 3.3, i * -1.7, i * 0.4, out);
      expect(Math.abs(s.y)).toBeLessThanOrEqual(budget + 1e-9);
      expect(Math.hypot(s.nx, s.ny, s.nz)).toBeCloseTo(1, 9);
      expect(s.crest).toBeGreaterThanOrEqual(0);
      expect(s.crest).toBeLessThanOrEqual(1);
    }
    expect(waterHeightAt(waves, 5, 1, 2, 3)).toBeCloseTo(5 + sampleGerstner(waves, 1, 2, 3).y, 12);
  });

  it("foams past the threshold with a smoothstep shoulder", () => {
    expect(foamFromCrest(0.5, 0.72)).toBe(0);
    expect(foamFromCrest(1, 0.72)).toBe(1);
    expect(foamFromCrest((1 + 0.72) / 2, 0.72)).toBeCloseTo(0.5, 12);
    expect(isUnderwater(-0.1, { enabled: true, level: 0 })).toBe(true);
    expect(isUnderwater(0.1, { enabled: true, level: 0 })).toBe(false);
    expect(isUnderwater(-100, { enabled: false, level: 0 })).toBe(false);
  });

  it("builds a valid indexed grid with amplitude-padded bounds", () => {
    const grid = waterGridSource(100, 8, 0.5);
    expect(grid.positions).toHaveLength(81 * 3);
    expect(grid.normals).toHaveLength(81 * 3);
    expect(grid.uvs).toHaveLength(81 * 2);
    expect(grid.indices).toHaveLength(8 * 8 * 6);
    for (let v = 0; v < 81; v++) {
      expect(grid.positions[v * 3 + 1]).toBe(0);
      expect(grid.normals[v * 3]).toBe(0);
      expect(grid.normals[v * 3 + 1]).toBe(1);
      expect(grid.normals[v * 3 + 2]).toBe(0);
    }
    expect(grid.uvs[0]).toBe(0);
    expect(grid.uvs[1]).toBe(0);
    expect(grid.uvs[80 * 2]).toBe(1);
    expect(grid.uvs[80 * 2 + 1]).toBe(1);
    for (const index of grid.indices) expect(index).toBeLessThan(81);
    expect(grid.boundsMin).toEqual([-50, -0.5, -50]);
    expect(grid.boundsMax).toEqual([50, 0.5, 50]);
  });

  it("owns the clock and the queries through WaterSurface", () => {
    const scene = new Scene({ name: "water-clock" });
    const surface = new WaterSurface({ level: 2, size: 300 });
    scene.add(surface);
    expect(scene.settings.water.enabled).toBe(true);
    expect(scene.settings.water.level).toBe(2);
    expect(scene.settings.water.size).toBe(300);
    expect(surface.renderable).not.toBe(null);
    surface.update(fakeContext(3, 1 / 60));
    expect(scene.settings.water.time).toBeCloseTo(3 / 60, 12);
    // The helpers read the same waves + time the shader does.
    const waves = scene.settings.water.waves;
    expect(surface.sampleHeight(10, -4)).toBeCloseTo(waterHeightAt(waves, 2, 10, -4, scene.settings.water.time), 9);
    expect(surface.sample(1, 1).y).toBeCloseTo(sampleGerstner(waves, 1, 1, scene.settings.water.time).y, 9);
    expect(surface.sampleFoam(0, 0)).toBe(foamFromCrest(sampleGerstner(waves, 0, 0, scene.settings.water.time).crest, scene.settings.water.foamThreshold));
    surface.onDetach!(scene);
    expect(scene.settings.water.enabled).toBe(false);
  });
});

describe("lightning", () => {
  it("shapes the flash as a double stroke below 1 % after its duration", () => {
    expect(flashEnvelope(-1)).toBe(0);
    expect(flashEnvelope(0)).toBe(0);
    const peak = flashEnvelope(DEFAULT_FLASH_ATTACK * 3);
    expect(peak).toBeGreaterThan(0.5);
    expect(flashEnvelope(flashDuration())).toBeLessThan(0.011);
    // The return stroke adds a second hump the single stroke lacks.
    const single = { attack: 0.008, decay: 0.09, restrikeDelay: 0, restrikeStrength: 0 };
    const t = 0.12 + 0.008 * 3;
    expect(flashEnvelope(t)).toBeGreaterThan(flashEnvelope(t, single) + 0.2);
  });

  it("grows deterministic bolts from cloud to ground", () => {
    const start = new Vec3(10, 1200, -5);
    const end = new Vec3(14, 0, -2);
    const a = generateBoltPoints(start, end, 1234, 5, 0.35);
    const b = generateBoltPoints(start, end, 1234, 5, 0.35);
    expect(a).toHaveLength(2 ** 5 + 1);
    expect(a[0]).toEqual(start);
    expect(a[a.length - 1]).toEqual(end);
    expect(a).toEqual(b);
    const other = generateBoltPoints(start, end, 999, 5, 0.35);
    expect(other).not.toEqual(a);
    // Straight-line mode never leaves the segment.
    const straight = generateBoltPoints(start, end, 1, 4, 0);
    for (const p of straight) {
      const t = (1200 - p.y) / 1200;
      expect(p.x).toBeCloseTo(10 + 4 * t, 9);
      expect(p.z).toBeCloseTo(-5 + 3 * t, 9);
    }
    // The midpoint displacement is bounded by roughness × segment length / √2 per axis.
    const rough = generateBoltPoints(start, end, 77, 1, 0.5);
    expect(rough).toHaveLength(3);
    const segLen = Math.hypot(4, 1200, 3);
    const bound = 0.5 * segLen * 0.5 * Math.SQRT2;
    expect(Math.abs(rough[1]!.x - 12)).toBeLessThanOrEqual(bound + 1e-9);
    expect(Math.abs(rough[1]!.z - -3.5)).toBeLessThanOrEqual(bound + 1e-9);
  });

  it("schedules strikes as a seeded Poisson process and replays it exactly", () => {
    const run = () => {
      const l = new LightningSystem({ seed: 31337, rate: 2, stormOverride: 1, areaRadius: 100 });
      for (let i = 0; i < 60; i++) l.advance(0.5);
      return l;
    };
    const a = run();
    const b = run();
    expect(a.strikeCount).toBeGreaterThan(0);
    expect(a.strikeCount).toBe(b.strikeCount);
    expect(a.strikes.map((s) => [s.position.x, s.position.z, s.energy])).toEqual(b.strikes.map((s) => [s.position.x, s.position.z, s.energy]));
    // With the tap closed the sky goes quiet: strikes age out and the flash dies.
    a.rate = 0;
    a.advance(10);
    expect(a.strikes).toHaveLength(0);
    expect(a.flashTotal).toBe(0);
  });

  it("drives the flash light and the sky exposure from the live strikes", () => {
    const scene = new Scene({ name: "lightning-present" });
    const l = new LightningSystem({ seed: 5, rate: 0, stormOverride: 0 });
    scene.add(l);
    l.trigger(new Vec3(30, 0, -10), 2);
    l.advance(0.02);
    expect(l.flashTotal).toBeGreaterThan(0);
    const calls: { exposure?: number; lines: number } = { lines: 0 };
    const context = { render: { setSkyOverride: (p: { exposure?: number }) => (calls.exposure = p.exposure), drawLine: () => calls.lines++ } } as never;
    l.present(context);
    expect(calls.exposure).toBeCloseTo(1 + l.flashTotal * l.skyFlashExposure, 9);
    expect(calls.lines).toBeGreaterThan(0);
    expect(l.lastBolts).toHaveLength(1);
    l.advance(10);
    l.present(context);
    expect(l.lastBolts).toHaveLength(0);
  });
});

describe("weather + clouds + water rendering (mock device)", () => {
  async function waterFixture(cameraY: number): Promise<{
    device: GraphicsDevice;
    mock: GraphicsDevice["mock"];
    renderer: Renderer;
    scene: Scene;
    dispose(): Promise<void>;
  }> {
    const device = await GraphicsDevice.create({ forceMock: true });
    device.resize(320, 180);
    const mock = device.mock;
    const renderer = new Renderer(device, { shadowMapSize: 256 });
    const scene = new Scene({ name: "water-test" });
    scene.settings.shadow.mapSize = 256;

    const camEntity = scene.createTransformedEntity("camera", new Vec3(0, cameraY, -8));
    const camera = new Camera();
    camera.far = 600;
    scene.world.addComponent(camEntity.id, camera);
    camEntity.transform.lookAt(new Vec3(0, 2, 0));

    const sunEntity = scene.createTransformedEntity("sun", new Vec3(5, 10, -5));
    const sun = new Light();
    sun.kind = "directional";
    sun.castShadow = true;
    scene.world.addComponent(sunEntity.id, sun);
    sunEntity.transform.lookAt(new Vec3(0, 0, 0));

    const surface = new WaterSurface({ level: 0, size: 400 });
    scene.add(surface);
    const grid = waterGridSource(400, 16, 1);
    const geometry = Geometry.create(device, {
      positions: grid.positions,
      normals: grid.normals,
      uvs: grid.uvs,
      indices: grid.indices,
      bounds: new AABB(new Vec3(...grid.boundsMin), new Vec3(...grid.boundsMax)),
    });
    const material = new Material({ label: "water", technique: "water" });
    surface.renderable!.geometry = geometry;
    surface.renderable!.material = material;
    scene.setClouds({ coverage: 0.55, density: 0.9 });

    return {
      device,
      mock,
      renderer,
      scene,
      async dispose() {
        scene.dispose();
        renderer.dispose();
        geometry.dispose();
        material.dispose();
        await device.dispose();
        expect(mock.outstanding.buffers).toEqual([]);
        expect(mock.outstanding.textures).toEqual([]);
      },
    };
  }

  it("draws the water technique and the cloud deck with zero validation errors", async () => {
    const f = await waterFixture(6);
    f.renderer.renderScene(f.scene);
    expect(f.mock.errors).toEqual([]);
    expect(f.renderer.passNames).toContain("forge.main");
    expect(f.renderer.passNames).toContain("forge.sky");
    expect(f.renderer.stats.sky).toBe(true);
    expect(f.renderer.stats.clouds).toBe(true);
    expect(f.renderer.stats.underwater).toBe(false);
    await f.dispose();
  });

  it("runs the underwater path when the camera drops below the mean level", async () => {
    const f = await waterFixture(-3);
    f.renderer.renderScene(f.scene);
    expect(f.mock.errors).toEqual([]);
    expect(f.renderer.stats.underwater).toBe(true);
    expect(f.renderer.stats.sky).toBe(false);
    expect(f.renderer.stats.clouds).toBe(false);
    expect(f.renderer.passNames).not.toContain("forge.sky");
    // The scene settings are untouched: the murk lives in the frame uniforms only.
    expect(f.scene.settings.fog.mode).toBe("none");
    await f.dispose();
  });

  it("round-trips clouds, water and wind through serialize/applySerialized", async () => {
    const f = await waterFixture(6);
    f.scene.setClouds({ coverage: 0.7, windX: 5, windZ: -2 });
    f.scene.setWater({ foamThreshold: 0.9 });
    const data = f.scene.serialize();
    const clone = new Scene({ name: "clone" });
    clone.applySerialized(JSON.parse(JSON.stringify(data)));
    expect(clone.settings.clouds.coverage).toBe(0.7);
    expect(clone.settings.clouds.windX).toBe(5);
    expect(clone.settings.clouds.windZ).toBe(-2);
    expect(clone.settings.water.foamThreshold).toBe(0.9);
    expect(clone.settings.water.waves).toHaveLength(4);
    expect(clone.settings.water.waves[0]!.wavelength).toBe(f.scene.settings.water.waves[0]!.wavelength);
    await f.dispose();
  });
});
