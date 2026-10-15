/**
 * @suite environment:environment17_6
 * @group unit
 * @covers engine/src/environment/lightning.ts
 * @covers engine/src/environment/weather.ts
 * @desc Environment (Phase 17.6): lightning integration — distance-delayed thunder events, weather-driven strike rate, terrain-aware attachment
 */

export const suite = {
  name: "environment:environment17_6",
  group: "unit",
  covers: ["engine/src/environment/lightning.ts", "engine/src/environment/weather.ts"],
  desc: "Environment (Phase 17.6): lightning integration — distance-delayed thunder events, weather-driven strike rate, terrain-aware attachment",
};

import assert from "node:assert/strict";
import { assertCloseTo, finish, group, test } from "selrun";
import {
  LightningSystem,
  Scene,
  Vec3,
  WeatherSystem,
  attachStrike,
  speedOfSound,
  strikingDistance,
  thunderDelay,
  type ThunderEvent,
} from "@forge/engine";

/** A ridge: a 120 m peak at x = 300 falling off with a 150 m scale, flat 0 elsewhere. */
const ridge = (x: number, z: number): number => 120 * Math.exp(-((x - 300) ** 2 + z * z) / (2 * 150 * 150));

group("17.6 thunder", () => {
  test("speed of sound follows air temperature; flash-to-bang ≈ 3 s/km", () => {
    assertCloseTo(speedOfSound(20), 343.42, 2);
    assertCloseTo(thunderDelay(1000, 20), 2.912, 2);
    assert.ok(thunderDelay(1000, -10) > thunderDelay(1000, 30));
  });
  test("measured: thunder arrives on the simulated clock at distance / c from the nearest channel point", () => {
    const scene = new Scene();
    const weather = new WeatherSystem({ initial: { temperatureC: 20, storm01: 0 } });
    scene.add(weather);
    const heard: { t: number; e: ThunderEvent }[] = [];
    const lightning = new LightningSystem({ seed: 7, cloudHeight: 1200, listener: () => ({ x: 0, y: 2, z: 0 }), onThunder: (e) => heard.push({ t: lightning.simulatedSeconds, e }) });
    scene.add(lightning);
    const near = lightning.trigger(new Vec3(400, 0, 0));
    const far = lightning.trigger(new Vec3(2500, 0, 0));
    assert.equal(lightning.pendingThunder.length, 2);
    for (let i = 0; i < 1200; i++) lightning.advance(1 / 100);
    assert.equal(heard.length, 2);
    assert.equal(heard[0]!.e.strike, near, "the near strike is heard first");
    assert.equal(heard[1]!.e.strike, far);
    for (const h of heard) {
      const minD = Math.min(...h.e.strike.bolt.points.map((p) => Math.hypot(p.x, p.y - 2, p.z)));
      assertCloseTo(h.e.distance, minD, 6);
      assertCloseTo(h.e.delay, minD / speedOfSound(20), 6);
      assert.ok(Math.abs(h.t - h.e.delay) <= 0.011, `delivered at ${h.t}, expected ${h.e.delay}`);
    }
    assert.ok(heard[0]!.e.delay > 1 && heard[0]!.e.delay < 1.4, `400 m strike delay ${heard[0]!.e.delay}`);
    assert.ok(heard[1]!.e.delay > 6.5, `2.5 km strike delay ${heard[1]!.e.delay}`);
  });
  test("no listener, no thunder queue (opt-in)", () => {
    const lightning = new LightningSystem({ seed: 3 });
    lightning.trigger(new Vec3(10, 0, 10));
    assert.equal(lightning.pendingThunder.length, 0);
  });
});

group("17.6 weather-driven strikes", () => {
  test("measured: strikes per 10 simulated minutes scale with the weather's storm01", () => {
    const counts = [0, 0.5, 1].map((storm) => {
      const scene = new Scene();
      scene.add(new WeatherSystem({ initial: { storm01: storm }, target: { storm01: storm } }));
      const lightning = new LightningSystem({ seed: 11, rate: 0.25 });
      scene.add(lightning);
      for (let i = 0; i < 6000; i++) lightning.advance(0.1);
      return lightning.strikeCount;
    });
    assert.equal(counts[0], 0, "a calm sky never strikes");
    // Poisson mean = 0.25·storm·600 → 75 and 150.
    assert.ok(Math.abs(counts[1]! - 75) < 30, `half storm ${counts[1]}`);
    assert.ok(Math.abs(counts[2]! - 150) < 40, `full storm ${counts[2]}`);
    assert.ok(counts[2]! > counts[1]!);
  });
});

group("17.6 terrain-aware strikes", () => {
  test("striking distance follows the rolling-sphere law", () => {
    assertCloseTo(strikingDistance(30), 10 * Math.pow(30, 0.65), 9);
    assert.ok(strikingDistance(100) > strikingDistance(10));
  });
  test("a leader attaches to the highest ground within reach, and a mast beats the ground", () => {
    const hit = attachStrike(250, 0, 1, 99, { heightAt: ridge });
    assert.ok(hit.x > 250, `moved toward the peak (${hit.x})`);
    assertCloseTo(hit.y, ridge(hit.x, hit.z), 9);
    assert.ok(hit.y > ridge(250, 0));
    const mast = { x: 230, y: ridge(230, 0) + 60, z: 20 };
    const rod = attachStrike(250, 0, 1, 99, { heightAt: ridge, attractors: [mast] });
    assert.deepEqual(rod, mast);
    // Out of reach, the mast is ignored.
    const far = attachStrike(-600, 0, 1, 99, { heightAt: ridge, attractors: [mast] });
    assert.notDeepEqual(far, mast);
  });
  test("measured: scheduled strikes land on high ground more often than the area share", () => {
    const lightning = new LightningSystem({ seed: 5, rate: 1, stormOverride: 1, areaRadius: 600, strikeTarget: { heightAt: ridge } });
    const heights: number[] = [];
    let high = 0;
    lightning.onStrike = (s) => {
      heights.push(Math.abs(s.position.y - ridge(s.position.x, s.position.z)));
      if (s.position.y > 60) high++;
    };
    for (let i = 0; i < 4000; i++) lightning.advance(0.1);
    assert.ok(lightning.strikeCount > 200);
    assert.ok(Math.max(...heights) < 1e-6, "every bolt ends on the surface");
    // The y > 60 m cap of the ridge (radius ≈ 177 m) is ≈ 8.7 % of the 600 m disc.
    const share = high / lightning.strikeCount;
    assert.ok(share > 0.087 * 1.3, `high-ground share ${share.toFixed(3)} vs area 0.087`);
  });
});

await finish();
