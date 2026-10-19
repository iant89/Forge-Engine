/**
 * @suite core:environmentDebugger
 * @group unit
 * @covers engine/src/debug/environmentDebugger.ts
 * @covers engine/src/environment/atmosphere.ts
 * @covers engine/src/environment/dayNight.ts
 * @covers engine/src/environment/lightning.ts
 * @covers engine/src/environment/weather.ts
 * @covers engine/src/index.ts
 * @covers engine/src/scene/components/index.ts
 * @covers engine/src/scene/scene.ts
 * @desc Phase 21.9 — read-only environment snapshots and sun/wind/lightning debug lines
 */

export const suite = {
  name: "core:environmentDebugger",
  group: "unit",
  covers: [
    "engine/src/debug/environmentDebugger.ts",
    "engine/src/environment/atmosphere.ts",
    "engine/src/environment/dayNight.ts",
    "engine/src/environment/lightning.ts",
    "engine/src/environment/weather.ts",
    "engine/src/index.ts",
    "engine/src/scene/components/index.ts",
    "engine/src/scene/scene.ts",
  ],
  desc: "Phase 21.9 — read-only environment snapshots and sun/wind/lightning debug lines",
};

import assert from "node:assert/strict";
import { finish, group, test } from "selrun";
import {
  DayNightCycle,
  drawEnvironmentDebug,
  environmentDebugLines,
  inspectEnvironment,
  LightningSystem,
  Light,
  Scene,
  Vec3,
  WeatherSystem,
} from "@forge/engine";

group("environment debugger", () => {
  test("reports sun, atmosphere, clouds, sampled weather/wind/precipitation, water, and lightning", () => {
    const scene = new Scene({ name: "environment-debug" });
    const sun = new Light();
    sun.kind = "directional";
    scene.createEntity("sun").add(sun);
    const cycle = new DayNightCycle({ year: 2025, dayOfYear: 172, timeOfDay: 14, latitude: 38, longitude: -77 });
    scene.addObject(cycle);
    const weather = new WeatherSystem({ initial: "storm", target: "clear" });
    scene.addObject(weather);
    const lightning = new LightningSystem({ rate: 0.75, stormOverride: 0.8 });
    scene.addObject(lightning);
    lightning.trigger(new Vec3(4, 12, -7), 1.2, true);
    scene.setWater({ enabled: true, level: 3, screenSpace: "full", shore: { enabled: true, bedLevel: -2, slope: 0.2 } });

    const snapshot = inspectEnvironment(scene, { samplePosition: { x: 15, y: 3, z: -8 } });
    assert.equal(snapshot.sceneName, "environment-debug");
    assert.equal(snapshot.sun.source, "skySettings");
    assert.ok(snapshot.sun.directionTowardSun);
    assert.equal(snapshot.sun.lights.length, 1);
    assert.equal(snapshot.dayNight[0]!.timeOfDay, 14);
    assert.equal(snapshot.atmosphere.source, "dayNightCycle");
    assert.ok(snapshot.atmosphere.params.planetRadius > 6_000_000);
    assert.ok(snapshot.clouds.coverage > 0.9);
    assert.equal(snapshot.weather.length, 1);
    assert.equal(snapshot.weather[0]!.state.storm01, 1);
    assert.equal(snapshot.weather[0]!.samplePosition[0], 15);
    assert.ok(snapshot.weather[0]!.wind.some((value) => value !== 0));
    assert.ok(snapshot.weather[0]!.precipitationAtSample > 0);
    assert.equal(snapshot.water.enabled, true);
    assert.equal(snapshot.water.level, 3);
    assert.equal(snapshot.water.shore.enabled, true);
    assert.equal(snapshot.lightning[0]!.strikeCount, 1);
    assert.equal(snapshot.lightning[0]!.activeStrikes, 1);
    assert.equal(snapshot.lightning[0]!.strikes[0]!.cloudOnly, true);

    const before = weather.state.windSpeed;
    snapshot.weather[0]!.state.windSpeed = -100;
    assert.equal(weather.state.windSpeed, before, "returned weather data is detached from live state");
    assert.ok(snapshot.water.waves.length > 0);
    snapshot.water.waves[0]!.amplitude = -10;
    assert.notEqual(scene.settings.water.waves[0]!.amplitude, -10, "water waves are copied");

    const lines = environmentDebugLines(scene, { samplePosition: { x: 15, y: 3, z: -8 } });
    assert.ok(lines.some((line) => line.kind === "sunDirection"));
    assert.ok(lines.some((line) => line.kind === "wind"));
    assert.ok(lines.some((line) => line.kind === "lightning"));
    const noBoltLines = environmentDebugLines(scene, { maxLightningLines: 0 });
    assert.ok(noBoltLines.some((line) => line.kind === "sunDirection"));
    assert.ok(noBoltLines.some((line) => line.kind === "wind"));
    assert.ok(noBoltLines.every((line) => line.kind !== "lightning"));
    const forwarded: number[] = [];
    assert.equal(drawEnvironmentDebug(scene, (_start, _end, color) => forwarded.push(color)), environmentDebugLines(scene).length);
    assert.equal(forwarded.length, environmentDebugLines(scene).length);
    scene.removeObject(lightning);
    scene.removeObject(weather);
    scene.removeObject(cycle);
    scene.world.dispose();
  });

  test("reports disabled/default environment sources and bounds active strike data", () => {
    const scene = new Scene({ name: "clear-environment" });
    const snapshot = inspectEnvironment(scene);
    assert.equal(snapshot.sun.source, "none");
    assert.equal(snapshot.atmosphere.source, "earthDefault");
    assert.equal(snapshot.weather.length, 0);
    assert.equal(snapshot.lightning.length, 0);
    assert.equal(environmentDebugLines(scene).length, 0);

    const lightning = new LightningSystem({ stormOverride: 1 });
    scene.addObject(lightning);
    lightning.trigger(new Vec3(0, 10, 0));
    lightning.trigger(new Vec3(1, 10, 0));
    const bounded = inspectEnvironment(scene, { maxSystems: 0, maxStrikes: 0 });
    assert.deepEqual([bounded.lightning.length, bounded.truncatedLightning], [0, true]);
    scene.removeObject(lightning);
    scene.world.dispose();
  });
});

finish();
