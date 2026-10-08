/**
 * @suite environment:environment8b
 * @group unit
 * @covers engine/src/environment/atmosphere.ts
 * @covers engine/src/environment/clouds.ts
 * @covers engine/src/environment/lightning.ts
 * @covers engine/src/environment/water.ts
 * @covers engine/src/environment/weather.ts
 * @covers engine/src/gpu/device.ts
 * @covers engine/src/index.ts
 * @covers engine/src/math/color.ts
 * @covers engine/src/math/geometry.ts
 * @covers engine/src/math/vec.ts
 * @covers engine/src/rendering/geometry.ts
 * @covers engine/src/rendering/material.ts
 * @covers engine/src/rendering/renderer.ts
 * @covers engine/src/scene/components/index.ts
 * @covers engine/src/scene/scene.ts
 * @desc Environment (Phase 8b): weather state, cloud deck, water surface and lightning
 */

export const suite = {
  name: "environment:environment8b",
  group: "unit",
  covers:   [
    "engine/src/environment/atmosphere.ts",
    "engine/src/environment/clouds.ts",
    "engine/src/environment/lightning.ts",
    "engine/src/environment/water.ts",
    "engine/src/environment/weather.ts",
    "engine/src/gpu/device.ts",
    "engine/src/index.ts",
    "engine/src/math/color.ts",
    "engine/src/math/geometry.ts",
    "engine/src/math/vec.ts",
    "engine/src/rendering/geometry.ts",
    "engine/src/rendering/material.ts",
    "engine/src/rendering/renderer.ts",
    "engine/src/scene/components/index.ts",
    "engine/src/scene/scene.ts"
  ],
  desc: "Environment (Phase 8b): weather state, cloud deck, water surface and lightning",
};
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

import assert from "node:assert/strict";
import { assertCloseTo, assertContains, assertNotContains, finish, group, test } from "selrun";
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

group("weather state", () => {
  test("orders the presets from clear to storm", () => {
    const { clear, overcast, rain, storm } = WEATHER_PRESETS;
    assert.ok(clear.windSpeed < overcast.windSpeed);
    assert.ok(overcast.windSpeed < rain.windSpeed);
    assert.ok(rain.windSpeed < storm.windSpeed);
    assert.ok(clear.cloudCoverage < overcast.cloudCoverage);
    assert.ok(overcast.cloudCoverage < rain.cloudCoverage);
    assert.ok(rain.cloudCoverage < storm.cloudCoverage);
    assert.equal(clear.precipitation01, 0);
    assert.equal(storm.storm01, 1);
    assert.equal(storm.gust, 1);
  });

  test("drifts exponentially toward the target (1 − 1/e of the gap per tau)", () => {
    const w = new WeatherSystem({ initial: "clear", target: "storm" });
    const before = w.state.temperatureC;
    const goal = w.target.temperatureC;
    w.advance(DEFAULT_WEATHER_TAU.temperatureC);
    assertCloseTo(w.state.temperatureC, before + (goal - before) * (1 - Math.exp(-1)), 10);
    // Convergence: after many taus the state is the target.
    w.advance(100 * DEFAULT_WEATHER_TAU.temperatureC);
    assertCloseTo(w.state.temperatureC, goal, 10);
    assertCloseTo(w.state.windSpeed, w.target.windSpeed, 6);
  });

  test("is path-independent: one long step equals many short ones", () => {
    const opts = { initial: "clear" as const, target: "storm" as const, seed: 42 };
    const a = new WeatherSystem(opts);
    const b = new WeatherSystem(opts);
    a.advance(37);
    for (let i = 0; i < 37; i++) b.advance(1);
    for (const k of ["windSpeed", "windDirection", "gust", "temperatureC", "humidity01", "precipitation01", "storm01", "cloudCoverage"] as const) {
      assertCloseTo(a.state[k], b.state[k], 9);
    }
    // The step itself is exact exponential integration, not Euler.
    assertCloseTo(approachExponential(10, 20, 5, 5), 20 - 10 * Math.exp(-1), 12);
  });

  test("turns the wind along the shortest arc (350° → 10° goes up, not down)", () => {
    const w = new WeatherSystem({ initial: { windDirection: 350 * DEG }, target: { windDirection: 10 * DEG } });
    w.advance(1);
    assert.ok(w.state.windDirection > 350 * DEG);
    assert.ok(w.state.windDirection < 360 * DEG);
    w.advance(100 * DEFAULT_WEATHER_TAU.windDirection);
    const converged = wrapAngle(w.state.windDirection - 10 * DEG);
    assertCloseTo(Math.min(converged, 2 * Math.PI - converged), 0, 6);
  });

  test("drives fog, turbidity, cover and deck wind into the scene (or nothing when told not to)", () => {
    const scene = new Scene({ name: "weather-drive" });
    const baseFog = scene.settings.fog.density;
    const baseTurbidity = scene.settings.sky.turbidity;
    const w = new WeatherSystem({ initial: "storm", target: "storm" });
    scene.add(w);
    assertCloseTo(scene.settings.fog.density, baseFog + w.rainFogDensity, 12);
    assertCloseTo(scene.settings.sky.turbidity, baseTurbidity + w.humidityTurbidity + w.stormTurbidity, 12);
    assert.equal(scene.settings.clouds.coverage, 1);
    const wind = w.meanWind();
    assertCloseTo(scene.settings.clouds.windX, wind.x, 12);
    assertCloseTo(scene.settings.clouds.windZ, wind.y, 12);

    w.driveFog = false;
    w.driveSky = false;
    w.driveClouds = false;
    scene.settings.fog.density = 0.001;
    scene.settings.sky.turbidity = 3;
    scene.settings.clouds.coverage = 0.2;
    scene.settings.clouds.windX = 0;
    w.snapTo("clear");
    assert.equal(scene.settings.fog.density, 0.001);
    assert.equal(scene.settings.sky.turbidity, 3);
    assert.equal(scene.settings.clouds.coverage, 0.2);
    assert.equal(scene.settings.clouds.windX, 0);
  });

  test("advances from the fixed-step budget through update()", () => {
    const scene = new Scene({ name: "weather-steps" });
    const w = new WeatherSystem({ initial: "clear", target: "storm" });
    scene.add(w);
    w.update(fakeContext(4, 0.5));
    assert.equal(w.simulatedSeconds, 2);
    const stepped = w.state.windSpeed;
    const direct = new WeatherSystem({ initial: "clear", target: "storm" });
    direct.advance(2);
    assert.equal(stepped, direct.state.windSpeed);
  });
});

group("weather fields", () => {
  test("reports the mean wind from speed + direction (+x east, +z north)", () => {
    const w = new WeatherSystem({ initial: { windSpeed: 10, windDirection: Math.PI / 2 } });
    const m = w.meanWind();
    assertCloseTo(m.x, 10, 12);
    assertCloseTo(m.y, 0, 12);
  });

  test("samples exactly the mean wind when the gust is zero, deterministically otherwise", () => {
    const calm = new WeatherSystem({ initial: { windSpeed: 7, windDirection: 1, gust: 0 } });
    const mean = calm.meanWind();
    const at = calm.sampleWindAt(123, -456, new Vec2(), 99);
    assert.equal(at.x, mean.x);
    assert.equal(at.y, mean.y);

    const gusty = new WeatherSystem({ initial: "storm", seed: 7 });
    const a = gusty.sampleWindAt(10, 20, new Vec2(), 5);
    const b = gusty.sampleWindAt(10, 20, new Vec2(), 5);
    assert.equal(a.x, b.x);
    assert.equal(a.y, b.y);
    const later = gusty.sampleWindAt(10, 20, new Vec2(), 6);
    assert.notEqual(later.x, a.x);
  });

  test("bounds the gust turbulence by gust · (2 + 0.3 · speed) per component", () => {
    const w = new WeatherSystem({ initial: "storm", seed: 11 });
    const amp = w.state.gust * (2 + 0.3 * w.state.windSpeed);
    const mean = w.meanWind();
    let worst = 0;
    for (let i = 0; i < 200; i++) {
      const v = w.sampleWindAt(i * 37.5, i * -11.25, new Vec2(), i * 0.7);
      worst = Math.max(worst, Math.abs(v.x - mean.x), Math.abs(v.y - mean.y));
    }
    // fbm2 is normalised to [−1, 1]; the 5 % slack is Perlin overshoot headroom, not physics.
    assert.ok(worst <= amp * 1.05);
    assert.ok(worst > amp * 0.2);
  });

  test("cools with altitude at the lapse rate and rains nowhere when dry", () => {
    const w = new WeatherSystem({ initial: "rain" });
    const low = w.sampleTemperatureAt(100, 0, -50, 12);
    const high = w.sampleTemperatureAt(100, 1000, -50, 12);
    assertCloseTo(high - low, -TEMPERATURE_LAPSE_PER_M * 1000, 12);
    const dry = new WeatherSystem({ initial: "clear" });
    assert.equal(dry.samplePrecipitationAt(0, 0), 0);
    assert.equal(dry.samplePrecipitationAt(9999, -9999, 4242), 0);
    const wet = dry.samplePrecipitationAt(100, 100);
    assert.ok(wet >= 0);
    assert.ok(wet <= 1);
  });
});

group("cloud deck", () => {
  const params = () => ({ ...defaultCloudLayerParams(), density: 0.8, scale: 0.0008, seed: 4242 });

  test("is clear at coverage 0 and overcast at coverage 1", () => {
    const p = params();
    for (const [x, z] of [[0, 0], [12345, -6789], [-1e6, 2e6]] as const) {
      assert.equal(cloudDensityAt(x, z, 0, p.density, p.scale, p.seed), 0);
      assertCloseTo(cloudDensityAt(x, z, 1, p.density, p.scale, p.seed), p.density, 12);
    }
  });

  test("raises the mean density monotonically with the coverage slider", () => {
    const p = params();
    const means = [0, 0.25, 0.5, 0.75, 1].map((c) => meanCloudDensity(c, p.density, p.scale, p.seed));
    assert.equal(means[0], 0);
    assertCloseTo(means[4], p.density, 12);
    for (let i = 1; i < means.length; i++) assert.ok(means[i] > means[i - 1]!);
    for (const m of means) {
      assert.ok(m >= 0);
      assert.ok(m <= p.density + 1e-9);
    }
  });

  test("lights the deck from the 8a sky: sun through transmittance, sky as ambient", () => {
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
    assert.ok(toward[0] > away[0]);
    // Dense cores transmit less of the direct sun.
    const thin = cloudRadiance(noon, noon, 0.05, { ...shading, ambientTint: new Float64Array(3) }, new Float64Array(3));
    const thick = cloudRadiance(noon, noon, 1, { ...shading, ambientTint: new Float64Array(3) }, new Float64Array(3));
    assert.ok(thin[1] > thick[1]);
    // Linear in the sun: double the light, double the sunlit part.
    const doubled = cloudRadiance(noon, noon, 0.5, { ...shading, ambientTint: new Float64Array(3), sunTint: new Float64Array([sunTint[0]! * 2, sunTint[1]! * 2, sunTint[2]! * 2]) }, new Float64Array(3));
    const single = cloudRadiance(noon, noon, 0.5, { ...shading, ambientTint: new Float64Array(3) }, new Float64Array(3));
    assertCloseTo(doubled[2], single[2]! * 2, 10);
    // The same deck is dimmer at sunset than at noon (redder, too).
    const noonRad = cloudRadiance(up, noon, 0.6, shading, new Float64Array(3));
    const duskTint = model.sunTransmittance(sunset, 0, new Float64Array(3));
    const duskAmb = model.skyAmbient(sunset, 0, new Float64Array(3));
    const duskRad = cloudRadiance(up, sunset, 0.6, { ...shading, sunTint: duskTint, ambientTint: duskAmb }, new Float64Array(3));
    assert.ok(noonRad[1]! > duskRad[1]!);
    assert.ok(duskRad[0]! / Math.max(1e-9, duskRad[2]!) > noonRad[0]! / Math.max(1e-9, noonRad[2]!));
  });

  test("fades the opacity to zero at the horizon (1 − e^(−3d) at the zenith)", () => {
    assert.equal(cloudAlpha(0, 1), 0);
    assert.equal(cloudAlpha(1, 0), 0);
    assertCloseTo(cloudAlpha(1, 1), 1 - Math.exp(-3), 12);
    assert.ok(cloudAlpha(0.5, 0.04) < cloudAlpha(0.5, 1));
  });

  test("caches the sky tints until the sun moves", () => {
    const cache = new SkyLightingCache();
    const sun = new Vec3(0.3, 0.8, 0.5).normalize();
    assert.equal(cache.update(sun, EARTH_ATMOSPHERE, 0, 20), true);
    assert.equal(cache.evaluations, 1);
    assert.equal(cache.update(sun, EARTH_ATMOSPHERE, 0, 20), false);
    assert.equal(cache.evaluations, 1);
    for (const tint of [cache.sunTint, cache.ambientTint, cache.horizonTint]) {
      for (const v of tint) {
        assert.equal(Number.isFinite(v), true);
        assert.ok(v >= 0);
      }
    }
    const moved = sun.clone().add(new Vec3(0.01, 0, 0)).normalize();
    assert.equal(cache.update(moved, EARTH_ATMOSPHERE, 0, 20), true);
    // The direct tint scales with the intensity; the others do not move.
    const dim = new SkyLightingCache();
    dim.update(sun, EARTH_ATMOSPHERE, 0, 10);
    const bright = new SkyLightingCache();
    bright.update(sun, EARTH_ATMOSPHERE, 0, 20);
    for (let i = 0; i < 3; i++) {
      assertCloseTo(bright.sunTint[i], dim.sunTint[i]! * 2, 10);
      assertCloseTo(bright.ambientTint[i], dim.ambientTint[i]!, 12);
    }
  });
});

group("water surface", () => {
  const sine = [{ directionX: 1, directionZ: 0, wavelength: 2 * Math.PI, amplitude: 2, speed: 1, steepness: 0, phase: 0 }];

  test("reproduces the single-wave closed form (height, normal, crest)", () => {
    // k = 1, f = x − t: at (π/2, 0) the crest, y = A, flat normal, crest 1/2.
    const crest = sampleGerstner(sine, Math.PI / 2, 0, 0);
    assertCloseTo(crest.y, 2, 12);
    assert.equal(crest.dx, 0);
    assert.equal(crest.dz, 0);
    assertCloseTo(crest.nx, 0, 12);
    assertCloseTo(crest.ny, 1, 12);
    assertCloseTo(crest.nz, 0, 12);
    assertCloseTo(crest.crest, 0.5, 12);
    // At the zero crossing the slope is −k·A and the normal is exact.
    const slope = sampleGerstner(sine, 0, 0, 0);
    assertCloseTo(slope.y, 0, 12);
    assertCloseTo(slope.nx, -2 / Math.sqrt(5), 12);
    assertCloseTo(slope.ny, 1 / Math.sqrt(5), 12);
    assertCloseTo(slope.crest, 1, 12);
    // The phase speed carries the shape: sampling at (x, t) equals (x − t, 0).
    const moved = sampleGerstner(sine, 3, 0, 1);
    const still = sampleGerstner(sine, 2, 0, 0);
    assertCloseTo(moved.y, still.y, 12);
  });

  test("displaces horizontally along the travel direction with steepness", () => {
    const steep = [{ ...sine[0]!, steepness: 0.5 }];
    // Q = steepness/(k·A·N) with N = 1: dx = Q·A·cos(0) = steepness/k = 0.5.
    const s = sampleGerstner(steep, 0, 0, 0);
    assertCloseTo(s.dx, 0.5, 12);
    assertCloseTo(s.dz, 0, 12);
    // Diagonal travel splits the displacement over both axes.
    const diag = [{ ...sine[0]!, directionX: 1, directionZ: 1, steepness: 0.5 }];
    const d = sampleGerstner(diag, 0, 0, 0);
    assertCloseTo(d.dx, d.dz!, 12);
    assertCloseTo(d.dx, 0.5 / Math.sqrt(2), 12);
  });

  test("stays inside its amplitude budget with unit normals and 0..1 crests", () => {
    const waves = [
      { directionX: 1, directionZ: 0.3, wavelength: 28, amplitude: 0.22, speed: 3.2, steepness: 0.35, phase: 0 },
      { directionX: 0.7, directionZ: -0.7, wavelength: 13, amplitude: 0.1, speed: 2.4, steepness: 0.3, phase: 1.7 },
    ];
    const budget = totalWaveAmplitude(waves);
    assertCloseTo(budget, 0.32, 12);
    const out = createWaterSample();
    for (let i = 0; i < 100; i++) {
      const s = sampleGerstner(waves, i * 3.3, i * -1.7, i * 0.4, out);
      assert.ok(Math.abs(s.y) <= budget + 1e-9);
      assertCloseTo(Math.hypot(s.nx, s.ny, s.nz), 1, 9);
      assert.ok(s.crest >= 0);
      assert.ok(s.crest <= 1);
    }
    assertCloseTo(waterHeightAt(waves, 5, 1, 2, 3), 5 + sampleGerstner(waves, 1, 2, 3).y, 12);
  });

  test("foams past the threshold with a smoothstep shoulder", () => {
    assert.equal(foamFromCrest(0.5, 0.72), 0);
    assert.equal(foamFromCrest(1, 0.72), 1);
    assertCloseTo(foamFromCrest((1 + 0.72) / 2, 0.72), 0.5, 12);
    assert.equal(isUnderwater(-0.1, { enabled: true, level: 0 }), true);
    assert.equal(isUnderwater(0.1, { enabled: true, level: 0 }), false);
    assert.equal(isUnderwater(-100, { enabled: false, level: 0 }), false);
  });

  test("builds a valid indexed grid with amplitude-padded bounds", () => {
    const grid = waterGridSource(100, 8, 0.5);
    assert.equal((grid.positions).length, 81 * 3);
    assert.equal((grid.normals).length, 81 * 3);
    assert.equal((grid.uvs).length, 81 * 2);
    assert.equal((grid.indices).length, 8 * 8 * 6);
    for (let v = 0; v < 81; v++) {
      assert.equal(grid.positions[v * 3 + 1], 0);
      assert.equal(grid.normals[v * 3], 0);
      assert.equal(grid.normals[v * 3 + 1], 1);
      assert.equal(grid.normals[v * 3 + 2], 0);
    }
    assert.equal(grid.uvs[0], 0);
    assert.equal(grid.uvs[1], 0);
    assert.equal(grid.uvs[80 * 2], 1);
    assert.equal(grid.uvs[80 * 2 + 1], 1);
    for (const index of grid.indices) assert.ok(index < 81);
    assert.deepEqual(grid.boundsMin, [-50, -0.5, -50]);
    assert.deepEqual(grid.boundsMax, [50, 0.5, 50]);
  });

  test("owns the clock and the queries through WaterSurface", () => {
    const scene = new Scene({ name: "water-clock" });
    const surface = new WaterSurface({ level: 2, size: 300 });
    scene.add(surface);
    assert.equal(scene.settings.water.enabled, true);
    assert.equal(scene.settings.water.level, 2);
    assert.equal(scene.settings.water.size, 300);
    assert.notEqual(surface.renderable, null);
    surface.update(fakeContext(3, 1 / 60));
    assertCloseTo(scene.settings.water.time, 3 / 60, 12);
    // The helpers read the same waves + time the shader does.
    const waves = scene.settings.water.waves;
    assertCloseTo(surface.sampleHeight(10, -4), waterHeightAt(waves, 2, 10, -4, scene.settings.water.time), 9);
    assertCloseTo(surface.sample(1, 1).y, sampleGerstner(waves, 1, 1, scene.settings.water.time).y, 9);
    assert.equal(surface.sampleFoam(0, 0), foamFromCrest(sampleGerstner(waves, 0, 0, scene.settings.water.time).crest, scene.settings.water.foamThreshold));
    surface.onDetach!(scene);
    assert.equal(scene.settings.water.enabled, false);
  });
});

group("lightning", () => {
  test("shapes the flash as a double stroke below 1 % after its duration", () => {
    assert.equal(flashEnvelope(-1), 0);
    assert.equal(flashEnvelope(0), 0);
    const peak = flashEnvelope(DEFAULT_FLASH_ATTACK * 3);
    assert.ok(peak > 0.5);
    assert.ok(flashEnvelope(flashDuration()) < 0.011);
    // The return stroke adds a second hump the single stroke lacks.
    const single = { attack: 0.008, decay: 0.09, restrikeDelay: 0, restrikeStrength: 0 };
    const t = 0.12 + 0.008 * 3;
    assert.ok(flashEnvelope(t) > flashEnvelope(t, single) + 0.2);
  });

  test("grows deterministic bolts from cloud to ground", () => {
    const start = new Vec3(10, 1200, -5);
    const end = new Vec3(14, 0, -2);
    const a = generateBoltPoints(start, end, 1234, 5, 0.35);
    const b = generateBoltPoints(start, end, 1234, 5, 0.35);
    assert.equal((a).length, 2 ** 5 + 1);
    assert.deepEqual(a[0], start);
    assert.deepEqual(a[a.length - 1], end);
    assert.deepEqual(a, b);
    const other = generateBoltPoints(start, end, 999, 5, 0.35);
    assert.notDeepEqual(other, a);
    // Straight-line mode never leaves the segment.
    const straight = generateBoltPoints(start, end, 1, 4, 0);
    for (const p of straight) {
      const t = (1200 - p.y) / 1200;
      assertCloseTo(p.x, 10 + 4 * t, 9);
      assertCloseTo(p.z, -5 + 3 * t, 9);
    }
    // The midpoint displacement is bounded by roughness × segment length / √2 per axis.
    const rough = generateBoltPoints(start, end, 77, 1, 0.5);
    assert.equal((rough).length, 3);
    const segLen = Math.hypot(4, 1200, 3);
    const bound = 0.5 * segLen * 0.5 * Math.SQRT2;
    assert.ok(Math.abs(rough[1]!.x - 12) <= bound + 1e-9);
    assert.ok(Math.abs(rough[1]!.z - -3.5) <= bound + 1e-9);
  });

  test("schedules strikes as a seeded Poisson process and replays it exactly", () => {
    const run = () => {
      const l = new LightningSystem({ seed: 31337, rate: 2, stormOverride: 1, areaRadius: 100 });
      for (let i = 0; i < 60; i++) l.advance(0.5);
      return l;
    };
    const a = run();
    const b = run();
    assert.ok(a.strikeCount > 0);
    assert.equal(a.strikeCount, b.strikeCount);
    assert.deepEqual(a.strikes.map((s) => [s.position.x, s.position.z, s.energy]), b.strikes.map((s) => [s.position.x, s.position.z, s.energy]));
    // With the tap closed the sky goes quiet: strikes age out and the flash dies.
    a.rate = 0;
    a.advance(10);
    assert.equal((a.strikes).length, 0);
    assert.equal(a.flashTotal, 0);
  });

  test("drives the flash light and the sky exposure from the live strikes", () => {
    const scene = new Scene({ name: "lightning-present" });
    const l = new LightningSystem({ seed: 5, rate: 0, stormOverride: 0 });
    scene.add(l);
    l.trigger(new Vec3(30, 0, -10), 2);
    l.advance(0.02);
    assert.ok(l.flashTotal > 0);
    const calls: { exposure?: number; lines: number } = { lines: 0 };
    const context = { render: { setSkyOverride: (p: { exposure?: number }) => (calls.exposure = p.exposure), drawLine: () => calls.lines++ } } as never;
    l.present(context);
    assertCloseTo(calls.exposure!, 1 + l.flashTotal * l.skyFlashExposure, 9);
    assert.ok(calls.lines > 0);
    assert.equal((l.lastBolts).length, 1);
    l.advance(10);
    l.present(context);
    assert.equal((l.lastBolts).length, 0);
  });
});

group("weather + clouds + water rendering (mock device)", () => {
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
        assert.deepEqual(mock.outstanding.buffers, []);
        assert.deepEqual(mock.outstanding.textures, []);
      },
    };
  }

  test("draws the water technique and the cloud deck with zero validation errors", async () => {
    const f = await waterFixture(6);
    f.renderer.renderScene(f.scene);
    assert.deepEqual(f.mock.errors, []);
    assertContains(f.renderer.passNames, "forge.main");
    assertContains(f.renderer.passNames, "forge.sky");
    assert.equal(f.renderer.stats.sky, true);
    assert.equal(f.renderer.stats.clouds, true);
    assert.equal(f.renderer.stats.underwater, false);
    await f.dispose();
  });

  test("runs the underwater path when the camera drops below the mean level", async () => {
    const f = await waterFixture(-3);
    f.renderer.renderScene(f.scene);
    assert.deepEqual(f.mock.errors, []);
    assert.equal(f.renderer.stats.underwater, true);
    assert.equal(f.renderer.stats.sky, false);
    assert.equal(f.renderer.stats.clouds, false);
    assertNotContains(f.renderer.passNames, "forge.sky");
    // The scene settings are untouched: the murk lives in the frame uniforms only.
    assert.equal(f.scene.settings.fog.mode, "none");
    await f.dispose();
  });

  test("round-trips clouds, water and wind through serialize/applySerialized", async () => {
    const f = await waterFixture(6);
    f.scene.setClouds({ coverage: 0.7, windX: 5, windZ: -2 });
    f.scene.setWater({ foamThreshold: 0.9 });
    const data = f.scene.serialize();
    const clone = new Scene({ name: "clone" });
    clone.applySerialized(JSON.parse(JSON.stringify(data)));
    assert.equal(clone.settings.clouds.coverage, 0.7);
    assert.equal(clone.settings.clouds.windX, 5);
    assert.equal(clone.settings.clouds.windZ, -2);
    assert.equal(clone.settings.water.foamThreshold, 0.9);
    assert.equal((clone.settings.water.waves).length, 4);
    assert.equal(clone.settings.water.waves[0]!.wavelength, f.scene.settings.water.waves[0]!.wavelength);
    await f.dispose();
  });
});

await finish();
