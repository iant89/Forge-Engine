/**
 * @suite environment:environment17_4
 * @group unit
 * @covers engine/src/environment/surfaceWeather.ts
 * @covers engine/src/environment/weather.ts
 * @covers engine/src/particles/precipitation.ts
 * @covers engine/src/rendering/renderer.ts
 * @covers engine/src/rendering/shaders/standard.ts
 * @covers engine/src/rendering/uniforms.ts
 * @covers engine/src/scene/scene.ts
 * @covers engine/src/vehicles/vehicle.ts
 * @covers engine/src/vehicles/system.ts
 * @covers engine/src/scene/surfaceGrip.ts
 * @desc Environment (Phase 17.4): weather integration — wet/puddled/snowy ground, traction, particles, visibility, audio and water
 */

export const suite = {
  name: "environment:environment17_4",
  group: "unit",
  covers: [
    "engine/src/environment/surfaceWeather.ts",
    "engine/src/environment/weather.ts",
    "engine/src/particles/precipitation.ts",
    "engine/src/rendering/renderer.ts",
    "engine/src/rendering/shaders/standard.ts",
    "engine/src/rendering/uniforms.ts",
    "engine/src/scene/scene.ts",
    "engine/src/vehicles/vehicle.ts",
    "engine/src/vehicles/system.ts",
    "engine/src/scene/surfaceGrip.ts",
  ],
  desc: "Environment (Phase 17.4): weather integration — wet/puddled/snowy ground, traction, particles, visibility, audio and water",
};

import assert from "node:assert/strict";
import { assertCloseTo, assertContains, finish, group, test } from "selrun";
import {
  RENDERING_STRUCTS,
  STANDARD_FRAGMENT_BODY,
  Scene,
  Transform,
  Vehicle,
  VehicleSystem,
  type SystemContext,
  VehicleComponent,
  WEATHER_PRESETS,
  WeatherSystem,
  createSurfaceWeather,
  createVehicleConfig,
  flatGround,
  snowFraction,
  stepSurfaceWeather,
  tyreGripFactor,
  visibilityForFogDensity,
  weatherOceanOptions,
  weatherPrecipitationDrive,
  weatherSoundInput,
  type WeatherState,
} from "@forge/engine";

const rain: WeatherState = { ...WEATHER_PRESETS.rain, temperatureC: 12 };
const heavy: WeatherState = { ...WEATHER_PRESETS.storm, precipitation01: 1, temperatureC: 14 };
const clear: WeatherState = { ...WEATHER_PRESETS.clear };
const snowing: WeatherState = { ...WEATHER_PRESETS.rain, precipitation01: 0.8, temperatureC: -4 };

function simulate(weather: WeatherState, seconds: number, state = createSurfaceWeather()) {
  for (let t = 0; t < seconds; t++) stepSurfaceWeather(state, weather, 1);
  return state;
}

/** Brake from 20 m/s to rest on flat ground (ABS), returning the stopping distance in metres. */
function stoppingDistance(grip: number): number {
  const v = new Vehicle(createVehicleConfig({ aero: null }));
  v.surfaceGrip = grip;
  const g = flatGround(0);
  const dt = 1 / 120;
  for (let i = 0; i < 120; i++) v.step(dt, g);
  v.input.throttle = 1;
  for (let t = 0; v.speed < 20 && t < 40; t += dt) v.step(dt, g);
  v.input.throttle = 0;
  v.input.brake = 1;
  const z0 = v.position.z;
  for (let n = 0; v.speed > 0.3 && n < 20000; n++) v.step(dt, g);
  return v.position.z - z0;
}

group("17.4 surface state", () => {
  test("rain wets the ground within a minute; drying takes far longer", () => {
    const wet = simulate(rain, 60);
    assert.ok(wet.wetness > 0.6, `wetness after 60 s rain ${wet.wetness}`);
    const dried = simulate(clear, 60, { ...wet });
    assert.ok(dried.wetness > wet.wetness * 0.75, `60 s of sun must not dry it (${dried.wetness})`);
    const long = simulate(clear, 3600, { ...wet });
    assert.ok(long.wetness < 0.1, `an hour of clear sky dries it (${long.wetness})`);
  });
  test("puddles need sustained heavy rain, and never outlast the film", () => {
    assert.ok(simulate(rain, 120).puddles < 0.1, "a 2-minute shower leaves only traces of standing water");
    const soaked = simulate(heavy, 900);
    assert.ok(soaked.puddles > 0.5, `15 min of cloudburst fills puddles (${soaked.puddles})`);
    const later = simulate(clear, 7200, { ...soaked });
    assert.ok(later.puddles <= later.wetness * 1.25 + 1e-9);
  });
  test("snow only lies below freezing and melts into wetness above it", () => {
    assertCloseTo(snowFraction(5), 0, 9);
    assertCloseTo(snowFraction(-3), 1, 9);
    assert.ok(simulate(rain, 600).snow === 0);
    const snowy = simulate(snowing, 600);
    assert.ok(snowy.snow > 0.7, `10 min of snowfall covers (${snowy.snow})`);
    const thaw = simulate({ ...clear, temperatureC: 8 }, 120, { ...snowy, wetness: 0 });
    assert.ok(thaw.snow < snowy.snow && thaw.wetness > 0.2, `melt wets (${thaw.snow}, ${thaw.wetness})`);
  });
});

group("17.4 simulation coupling", () => {
  test("tyre grip falls with wetness, puddles and snow", () => {
    assertCloseTo(tyreGripFactor(createSurfaceWeather()), 1, 9);
    assertCloseTo(tyreGripFactor({ wetness: 1, puddles: 0, snow: 0 }), 0.75, 9);
    assert.ok(tyreGripFactor({ wetness: 1, puddles: 1, snow: 0 }) < 0.56);
    assert.ok(tyreGripFactor({ wetness: 0, puddles: 0, snow: 1 }) <= 0.3 + 1e-9);
  });
  test("measured: braking distance from 20 m/s grows as v²/(2·μ·grip·g)", () => {
    const dry = stoppingDistance(1);
    const wet = stoppingDistance(tyreGripFactor({ wetness: 1, puddles: 0, snow: 0 }));
    const snow = stoppingDistance(tyreGripFactor({ wetness: 0, puddles: 0, snow: 1 }));
    // μ = 1.05 → 19.4 m dry; ideal wet 25.9 m, snow 64.7 m.
    assert.ok(Math.abs(dry - 19.4) < 1.5, `dry ${dry}`);
    assert.ok(Math.abs(wet / dry - 1 / 0.75) < 0.08, `wet ratio ${wet / dry}`);
    assert.ok(snow / dry > 3, `snow ratio ${snow / dry}`);
  });
  test("WeatherSystem drives scene.settings.surface and every vehicle's grip", () => {
    const scene = new Scene();
    const vehicle = new Vehicle(createVehicleConfig({ aero: null }));
    const car = scene.world.createEntity("car");
    car.add(new Transform());
    car.add(new VehicleComponent(vehicle, flatGround(0)));
    const weather = new WeatherSystem({ initial: { ...heavy }, target: { ...heavy } });
    scene.add(weather);
    const vehicles = new VehicleSystem();
    const step = (): void => vehicles.fixedStep({ world: scene.world, fixedDt: 1 / 60 } as unknown as SystemContext, 0);
    step();
    assertCloseTo(vehicle.surfaceGrip, 1, 9);
    weather.advance(600);
    step();
    assert.ok(scene.settings.surface.wetness > 0.95);
    assert.ok(scene.settings.surface.puddles > 0.2);
    assertCloseTo(vehicle.surfaceGrip, weather.grip, 9);
    assert.ok(vehicle.surfaceGrip < 0.75);
    assertCloseTo(vehicle.mu, vehicle.config.mu * vehicle.surfaceGrip, 9);
    weather.driveVehicles = false;
    vehicle.surfaceGrip = 1;
    weather.advance(1);
    step();
    assertCloseTo(vehicle.surfaceGrip, 1, 9);
  });
  test("driveWater rebuilds the sea from the wind; a storm raises it", () => {
    const scene = new Scene();
    scene.setWater({ enabled: true });
    const weather = new WeatherSystem({ initial: { ...clear, windSpeed: 6 }, driveWater: { maxHeight: 12 } });
    scene.add(weather);
    const calmAmp = scene.settings.water.waves.reduce((a, w) => a + w.amplitude, 0);
    weather.snapTo({ windSpeed: 24, storm01: 1 });
    const stormAmp = scene.settings.water.waves.reduce((a, w) => a + w.amplitude, 0);
    assert.ok(stormAmp > calmAmp * 4, `storm ${stormAmp} vs calm ${calmAmp}`);
    assert.ok(weatherOceanOptions({ ...clear, storm01: 1 }).choppiness > weatherOceanOptions(clear).choppiness);
    // The wave direction follows the compass wind (toward east = +x).
    assertCloseTo(weatherOceanOptions({ ...clear, windDirection: Math.PI / 2 }).direction, 0, 9);
  });
  test("visibility, particles and audio read the same state", () => {
    assert.equal(visibilityForFogDensity(0), Number.POSITIVE_INFINITY);
    assertCloseTo(visibilityForFogDensity(0.02), Math.log(20) / 0.02, 9);
    const scene = new Scene();
    scene.setFog("exp2", { density: 0.002 });
    const weather = new WeatherSystem({ initial: { ...heavy } });
    scene.add(weather);
    assert.ok(visibilityForFogDensity(scene.settings.fog.density) < visibilityForFogDensity(0.002) / 5, "rain cuts visibility");
    const drive = weatherPrecipitationDrive(snowing);
    assert.ok(drive.snow > 0.9 && drive.intensity === 0.8);
    assert.equal(weatherPrecipitationDrive(rain).snow, 0);
    assert.ok(weatherSoundInput(heavy).rain > weatherSoundInput(snowing).rain, "snow is quieter than rain");
  });
});

group("17.4 shading contract", () => {
  test("PerFrame carries the surface vector and the shader gates it on flags bit7", () => {
    assert.equal(RENDERING_STRUCTS.PerFrameUniforms.offsetOf("surfaceWeather"), 256);
    assertContains(STANDARD_FRAGMENT_BODY, "fn weatherSurface(");
    assertContains(STANDARD_FRAGMENT_BODY, "(perFrame.flags & 128u) == 0u");
    assertContains(STANDARD_FRAGMENT_BODY, "ws.puddle");
  });
  test("scene settings round-trip the surface block", () => {
    const scene = new Scene();
    scene.settings.surface.wetness = 0.4;
    scene.settings.surface.snow = 0.2;
    const copy = new Scene();
    copy.applySerialized(JSON.parse(JSON.stringify(scene.serialize())));
    assertCloseTo(copy.settings.surface.wetness, 0.4, 9);
    assertCloseTo(copy.settings.surface.snow, 0.2, 9);
  });
});

await finish();
