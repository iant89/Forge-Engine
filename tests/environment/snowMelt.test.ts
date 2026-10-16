/**
 * @suite environment:snowMelt
 * @group unit
 * @covers engine/src/environment/snowMelt.ts
 * @covers engine/src/environment/snowCover.ts
 * @covers engine/src/environment/moistureField.ts
 * @covers engine/src/scene/surfaceGrip.ts
 * @covers engine/src/vehicles/system.ts
 * @covers engine/src/rendering/material.ts
 * @covers engine/src/rendering/moistureGround.ts
 * @desc fe-38: snow melt energy balance, per-object snow cover melt and shedding, ground moisture / mud field and its grip
 */

export const suite = {
  name: "environment:snowMelt",
  group: "unit",
  covers: [
    "engine/src/environment/snowMelt.ts",
    "engine/src/environment/snowCover.ts",
    "engine/src/environment/moistureField.ts",
    "engine/src/scene/surfaceGrip.ts",
    "engine/src/vehicles/system.ts",
    "engine/src/rendering/material.ts",
    "engine/src/rendering/moistureGround.ts",
  ],
  desc: "fe-38: snow melt energy balance, per-object snow cover melt and shedding, ground moisture / mud field and its grip",
};

import assert from "node:assert/strict";
import { assertCloseTo, assertContains, finish, group, test } from "selrun";
import {
  DEFAULT_SNOW_DENSITY,
  GroundMoistureField,
  Light,
  Material,
  RENDERING_STRUCTS,
  STANDARD_FRAGMENT_BODY,
  Scene,
  SnowCover,
  SnowMeltSystem,
  Transform,
  Vec3,
  Vehicle,
  VehicleComponent,
  VehicleSystem,
  WATER_DENSITY,
  WeatherSystem,
  createMeltEnvironment,
  createVehicleConfig,
  criticalShedAngle,
  flatGround,
  meltRate,
  moistureGroundGeometrySource,
  setWorldSurfaceGripField,
  snowAlbedo,
  snowEnergyBalance,
  sphereDetachAngle,
  substrateFlux,
  type SystemContext,
} from "@forge/engine";

const DEG = Math.PI / 180;
const MM_PER_HOUR = 1000 * 3600;

/** A scene with a sun at `elevationDeg` (intensity 4 → 1000 W/m² beam) and a WeatherSystem. */
function sunnyScene(elevationDeg: number, temperatureC: number, intensity = 4): { scene: Scene; sun: Light; weather: WeatherSystem } {
  const scene = new Scene();
  scene.settings.ambientIntensity = 0.3;
  scene.settings.ambientColor.set(0.3, 0.33, 0.38);
  const e = scene.createTransformedEntity("sun", new Vec3());
  const sun = new Light();
  sun.kind = "directional";
  sun.intensity = intensity;
  const el = elevationDeg * DEG;
  sun.direction.set(-Math.cos(el) * 0.6, -Math.sin(el), -Math.cos(el) * 0.8);
  scene.world.addComponent(e.id, sun);
  const weather = new WeatherSystem({ initial: { cloudCoverage: 0, storm01: 0, temperatureC, precipitation01: 0, windSpeed: 2 }, target: { cloudCoverage: 0, storm01: 0, temperatureC, precipitation01: 0, windSpeed: 2 } });
  weather.driveSurface = false;
  scene.add(weather);
  return { scene, sun, weather };
}

function addCovered(scene: Scene, position: Vec3, cover: SnowCover, rotation?: { axis: Vec3; angle: number }): Transform {
  const e = scene.createTransformedEntity("obj", position);
  const t = scene.world.getComponent(e.id, Transform)!;
  if (rotation) {
    t.rotation.setAxisAngle(rotation.axis, rotation.angle);
    t.sync();
  }
  scene.world.addComponent(e.id, cover);
  return t;
}

group("melt energy balance", () => {
  test("full sun on fresh snow melts ~1.4 mm/h of water (the 10–40 mm w.e./day textbook range)", () => {
    const env = createMeltEnvironment({ sunIrradiance: 1000, airTemperatureC: 5, windSpeed: 2, cloudCover: 0 });
    const q = snowEnergyBalance(env, { cosIncidence: 0.7, albedo: snowAlbedo(0) });
    assertCloseTo(q, 0.15 * 700 + 13 * 5 - 60, 6);
    const snowMmH = meltRate(q) * MM_PER_HOUR;
    const waterMmH = (snowMmH * DEFAULT_SNOW_DENSITY) / WATER_DENSITY;
    assert.ok(waterMmH > 1 && waterMmH < 2, `water ${waterMmH} mm/h`);
  });
  test("rate rises with sun, air temperature, wetness (lower albedo) and a dark substrate under thin snow", () => {
    const base = { cosIncidence: 0.8, albedo: snowAlbedo(0) };
    const q = (env: Parameters<typeof snowEnergyBalance>[0], s = base) => snowEnergyBalance(env, s);
    const dim = createMeltEnvironment({ sunIrradiance: 300, airTemperatureC: 2 });
    const bright = createMeltEnvironment({ sunIrradiance: 1000, airTemperatureC: 2 });
    const warm = createMeltEnvironment({ sunIrradiance: 300, airTemperatureC: 10 });
    assert.ok(q(bright) > q(dim));
    assert.ok(q(warm) > q(dim));
    assert.ok(q(bright, { cosIncidence: 0.8, albedo: snowAlbedo(1) }) > q(bright));
    assert.ok(substrateFlux(bright, 0.005, 0.1, 0.8) > 5 * substrateFlux(bright, 0.1, 0.1, 0.8));
    assert.ok(substrateFlux(bright, 0.005, 0.1, 0.8) > substrateFlux(bright, 0.005, 0.8, 0.8));
  });
  test("a cold night melts nothing", () => {
    const env = createMeltEnvironment({ sunIrradiance: 0, airTemperatureC: -5 });
    assert.equal(meltRate(snowEnergyBalance(env, { cosIncidence: 0, albedo: 0.85 })), 0);
  });
});

group("shedding mechanics", () => {
  test("critical angle: ~55° dry, ~15° saturated, lower on tight curvature", () => {
    assertCloseTo(criticalShedAngle(0, 0, Infinity) / DEG, 55, 6);
    assertCloseTo(criticalShedAngle(1, 0, Infinity) / DEG, 15, 6);
    assert.ok(criticalShedAngle(0.5, 0.1, 0.5) < criticalShedAngle(0.5, 0.1, 5));
  });
  test("a block sliding off a frictionless sphere leaves at cos θ = 2/3 (48.2°); friction delays it", () => {
    assertCloseTo(sphereDetachAngle(0.01, 0) / DEG, 48.19, 0);
    assert.ok(sphereDetachAngle(0.3, 0.2) > sphereDetachAngle(0.3, 0));
  });
});

group("SnowMeltSystem on objects", () => {
  test("full sun melts a sphere's cover, wets it, sheds sliding clumps that land on the ground field", () => {
    const { scene } = sunnyScene(50, 6);
    const field = new GroundMoistureField({ originX: -10, originZ: -10, size: 20, resolution: 40 });
    const system = new SnowMeltSystem({ field, timeScale: 60 });
    scene.add(system);
    const cover = new SnowCover({ shape: { kind: "sphere", radius: 1.1 }, depth: 0.06, extentDeg: 70 });
    addCovered(scene, new Vec3(0, 1.1, 0), cover);
    const v0 = cover.volume();
    const extent0 = cover.extent;
    assert.ok(extent0 <= criticalShedAngle(0, 0.06, 1.1) + 1e-9, "initial cover is stable");
    let sawSlide = false;
    let sawFall = false;
    for (let i = 0; i < 1200 && cover.depth > 0; i++) {
      system.advance(1 / 20);
      sawSlide ||= system.chunks.some((c) => c.phase === "slide-sphere");
      sawFall ||= system.chunks.some((c) => c.phase === "fall");
    }
    assert.ok(cover.wetness > 0.5 || cover.depth === 0, `wetness ${cover.wetness}`);
    assert.ok(cover.extent < extent0 - 10 * DEG, `extent ${cover.extent / DEG}°`);
    assert.ok(system.shedEvents > 0 && system.chunksReleased > 0, "shed");
    assert.ok(sawSlide && sawFall, "chunks slid then fell");
    for (let i = 0; i < 600 && system.chunks.length > 0; i++) system.advance(1 / 20);
    assert.equal(system.chunks.length, 0);
    assert.ok(system.chunksLanded === system.chunksReleased);
    // Mass balance: what is left + shed + melted equals what was there.
    const meltedSnow = (cover.meltwater * WATER_DENSITY) / DEFAULT_SNOW_DENSITY;
    const accounted = cover.volume() + cover.shedVolume;
    assert.ok(accounted <= v0 + 1e-9 && accounted + meltedSnow > v0 * 0.7, `v0 ${v0} accounted ${accounted} melted ${meltedSnow}`);
    // Shed snow lies on the field; meltwater reached it.
    assert.ok(field.totalSnow() > 0 || field.waterIn > 0);
    assert.ok(field.waterIn > 0);
  });
  test("faster in stronger sun and warmer air; nothing at night below freezing", () => {
    const run = (elev: number, t: number, intensity: number) => {
      const { scene } = sunnyScene(elev, t, intensity);
      const system = new SnowMeltSystem({ timeScale: 60 });
      scene.add(system);
      const cover = new SnowCover({ shape: { kind: "box", halfX: 1, halfZ: 1, topY: 0.5 }, depth: 0.1 });
      addCovered(scene, new Vec3(), cover);
      for (let i = 0; i < 60; i++) system.advance(1);
      return 0.1 - cover.depth;
    };
    const full = run(55, 4, 4);
    const weak = run(55, 4, 1.5);
    const warm = run(55, 12, 4);
    const night = run(-10, -5, 0);
    assert.ok(full > weak * 1.5, `full ${full} weak ${weak}`);
    assert.ok(warm > full, `warm ${warm} full ${full}`);
    assert.equal(night, 0);
  });
  test("a tilted slab's sheet slides off once wet; a flat box keeps its sheet but drops a wet cornice", () => {
    const { scene } = sunnyScene(55, 8);
    const system = new SnowMeltSystem({ timeScale: 60 });
    scene.add(system);
    const tilted = new SnowCover({ shape: { kind: "box", halfX: 1, halfZ: 1, topY: 0.25 }, depth: 0.08 });
    addCovered(scene, new Vec3(5, 1, 0), tilted, { axis: new Vec3(0, 0, 1), angle: 30 * DEG });
    const flat = new SnowCover({ shape: { kind: "box", halfX: 1, halfZ: 1, topY: 0.25 }, depth: 0.08 });
    addCovered(scene, new Vec3(-5, 1, 0), flat);
    system.advance(0.01);
    assert.equal(tilted.sheetSlid, false, "dry snow holds on 30°");
    let slideSeen = false;
    for (let i = 0; i < 400 && !(tilted.sheetSlid && flat.corniceDropped); i++) {
      system.advance(1 / 10);
      slideSeen ||= system.chunks.some((c) => c.phase === "slide-plane");
    }
    assert.ok(tilted.sheetSlid, `sheet slid (wet ${tilted.wetness})`);
    assert.ok(slideSeen, "sheet slabs slid along the tilt");
    assert.equal(flat.sheetSlid, false);
    assert.ok(flat.corniceDropped, `cornice (wet ${flat.wetness})`);
  });
  test("the cover drives its render target: amount, snow line and wetness", () => {
    const { scene } = sunnyScene(50, 6);
    const system = new SnowMeltSystem({ timeScale: 60 });
    scene.add(system);
    const material = new Material({ label: "snowy" });
    const cover = new SnowCover({ shape: { kind: "sphere", radius: 1 }, depth: 0.05, target: material });
    addCovered(scene, new Vec3(), cover);
    system.advance(0.05);
    assertCloseTo(material.snowCover.amount, 1, 6);
    assertCloseTo(material.snowCover.line, Math.cos(cover.extent), 3);
    for (let i = 0; i < 2000 && cover.depth > 0; i++) system.advance(0.5);
    assert.equal(cover.depth, 0, `depth ${cover.depth} wet ${cover.wetness} extent ${cover.extent}`);
    assert.equal(material.snowCover.amount, 0);
  });
});

group("ground moisture field", () => {
  const basin = (x: number, z: number) => 0.02 * (x * x + z * z) * 0.1;
  test("meltwater runs downhill into the low spot", () => {
    const field = new GroundMoistureField({ originX: -5, originZ: -5, size: 10, resolution: 20, heightAt: basin, soilAt: () => "rock" });
    for (let i = -4; i <= 4; i += 2) for (let j = -4; j <= 4; j += 2) field.addWater(i, j, 0.002);
    const env = createMeltEnvironment({ airTemperatureC: 5, humidity: 0.9 });
    for (let t = 0; t < 600; t++) field.step(1, env);
    const centre = field.waterAt(0.2, 0.2);
    const edge = field.waterAt(4.2, 4.2);
    assert.ok(centre > 0.002 && centre > 20 * edge, `centre ${centre} edge ${edge}`);
    assert.ok(field.puddleAt(0.2, 0.2) > 0.5);
  });
  test("dirt turns to mud (darker, glossier, less grip) and dries again; rock does not", () => {
    const field = new GroundMoistureField({ originX: 0, originZ: 0, size: 4, resolution: 4, openBoundary: false, soilAt: (x) => (x < 2 ? "dirt" : "rock") });
    const wet = createMeltEnvironment({ airTemperatureC: 4, humidity: 0.9 });
    for (let t = 0; t < 200; t++) {
      field.addWater(0.5, 0.5, 0.0002);
      field.addWater(2.5, 0.5, 0.0002);
      field.step(10, wet);
    }
    assert.ok(field.mudAt(0.5, 0.5) > 0.8, `dirt mud ${field.mudAt(0.5, 0.5)}`);
    assert.equal(field.mudAt(2.5, 0.5), 0);
    assert.ok(field.gripAt(0.5, 0.5) < 0.6);
    const albedo = new Uint8Array(16 * 4);
    const mr = new Uint8Array(16 * 4);
    field.writeSurfaceMaps(albedo, mr);
    const dryField = new GroundMoistureField({ originX: 0, originZ: 0, size: 4, resolution: 4 });
    const dryAlbedo = new Uint8Array(16 * 4);
    const dryMr = new Uint8Array(16 * 4);
    dryField.writeSurfaceMaps(dryAlbedo, dryMr);
    assert.ok(albedo[0]! < dryAlbedo[0]! - 20, `mud ${albedo[0]} vs dry ${dryAlbedo[0]}`);
    assert.ok(mr[1]! < dryMr[1]! - 100, `mud roughness ${mr[1]} vs dry ${dryMr[1]}`);
    // Sun, warmth and wind dry it out.
    const sunny = createMeltEnvironment({ sunIrradiance: 900, sunDirection: { x: 0, y: 0.8, z: 0.6 }, airTemperatureC: 20, windSpeed: 4, humidity: 0.3 });
    for (let t = 0; t < 360; t++) field.step(60, sunny);
    assert.ok(field.mudAt(0.5, 0.5) < 0.05, `dried mud ${field.mudAt(0.5, 0.5)}`);
    assertCloseTo(field.gripAt(0.5, 0.5), 1, 2);
  });
  test("puddles are flagged in the MR map's alpha; water leaving an open edge is accounted for", () => {
    const field = new GroundMoistureField({ originX: 0, originZ: 0, size: 3, resolution: 3, soilAt: () => "rock" });
    field.water[4] = 0.02;
    const albedo = new Uint8Array(36);
    const mr = new Uint8Array(36);
    field.writeSurfaceMaps(albedo, mr);
    assert.equal(mr[4 * 4 + 3], 0, "the puddle cell's alpha is 0");
    assert.equal(mr[3], 255, "dry cells keep alpha 1");
    assertContains(STANDARD_FRAGMENT_BODY, "standingWater = 1.0 - mr.a");
    const before = field.totalWater();
    for (let t = 0; t < 300; t++) field.step(1, createMeltEnvironment({ humidity: 1 }));
    assert.ok(field.totalWater() < before * 0.5, "most of it ran off the open edge");
    assertCloseTo(field.totalWater() + field.waterOut, before + 0, 6);
  });
  test("a cell rounded a hair below zero does not turn the water grid to NaN", () => {
    // Float32 rounding in the flow transfer can leave a cell at -1.4e-45 m. With no outflow that
    // cell's total (0) still exceeds its water, and rescaling divided 0 by it: 0 x -Infinity = NaN,
    // which then spread through the grid (the thaw scene's water went 0.00 -> NaN in the gate).
    const field = new GroundMoistureField({ originX: 0, originZ: 0, size: 4, resolution: 4, soilAt: () => "rock" });
    field.water[5] = -1.401298464324817e-45;
    field.water[10] = 0.01;
    for (let t = 0; t < 20; t++) field.step(3, createMeltEnvironment({ humidity: 1 }));
    for (let k = 0; k < field.water.length; k++) assert.ok(Number.isFinite(field.water[k]!), `cell ${k} is ${field.water[k]}`);
    assert.ok(Number.isFinite(field.totalWater()));
  });
  test("ground snow melts into water in the sun", () => {
    const field = new GroundMoistureField({ originX: 0, originZ: 0, size: 2, resolution: 2 });
    field.addSnow(0.5, 0.5, 0.05);
    const s0 = field.totalSnow();
    const env = createMeltEnvironment({ sunIrradiance: 900, sunDirection: { x: 0, y: 0.8, z: 0.6 }, airTemperatureC: 8 });
    // ~7 mm/h of 5 cm: half gone within ~4 h of afternoon sun.
    for (let t = 0; t < 300; t++) field.step(60, env);
    assert.ok(field.totalSnow() < s0 * 0.5, `snow ${field.totalSnow()} of ${s0}`);
    assert.ok(field.waterIn > 0);
  });
  test("mud reaches the vehicle through the 17.4 grip path", () => {
    const scene = new Scene();
    const vehicle = new Vehicle(createVehicleConfig({ aero: null }));
    const car = scene.world.createEntity("car");
    car.add(new Transform());
    car.add(new VehicleComponent(vehicle, flatGround(0)));
    const field = new GroundMoistureField({ originX: -5, originZ: -5, size: 10, resolution: 10 });
    field.moisture.fill(1);
    setWorldSurfaceGripField(scene.world, (x, z) => field.gripAt(x, z));
    new VehicleSystem().fixedStep({ world: scene.world, fixedDt: 1 / 60 } as unknown as SystemContext, 0);
    assertCloseTo(vehicle.surfaceGrip, 0.5, 6);
    setWorldSurfaceGripField(scene.world, undefined);
  });
});

group("rendering contract", () => {
  test("materials carry a per-object snow cover the standard shader reads", () => {
    assert.equal(RENDERING_STRUCTS.MaterialUniforms.offsetOf("snowCover"), 80);
    assertContains(STANDARD_FRAGMENT_BODY, "material.snowCover");
    const m = new Material({ label: "m" });
    m.dirty = false;
    const rev = m.revision;
    m.setSnowCover(1, 0.4, 0.2);
    assert.equal(m.dirty, true);
    assert.ok(m.revision > rev, "the renderer re-uploads on a new revision");
    assert.deepEqual({ ...m.snowCover }, { amount: 1, line: 0.4, wetness: 0.2 });
  });
  test("ground mesh UVs span the field so texel (i, j) lands on cell (i, j)", () => {
    const field = new GroundMoistureField({ originX: 10, originZ: 20, size: 8, resolution: 4 });
    const src = moistureGroundGeometrySource(field, () => 1, 4);
    assert.equal(src.positions.length, 25 * 3);
    assertCloseTo(src.positions[0]!, 10, 9);
    assertCloseTo(src.positions[2]!, 20, 9);
    assertCloseTo(src.uvs![src.uvs!.length - 2]!, 1, 9);
    assert.ok(src.normals![1]! > 0.99, "normals face up");
  });
});

await finish();
