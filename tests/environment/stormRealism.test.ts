/**
 * @suite environment:storm-realism
 * @group unit
 * @covers engine/src/environment/waterspout.ts
 * @covers engine/src/environment/windBuffet.ts
 * @covers engine/src/environment/lightning.ts
 * @covers engine/src/environment/cyclone.ts
 * @covers engine/src/environment/clouds.ts
 * @covers engine/src/environment/water.ts
 * @covers engine/src/environment/ocean.ts
 * @covers engine/src/terrain/coastal.ts
 * @covers engine/src/particles/windBlown.ts
 * @covers engine/src/particles/waterspoutVisual.ts
 * @covers engine/src/audio/storm.ts
 * @desc fe-34 storm realism: curvy shore, set-up/tide, gusts, billows, lightning branches, waterspouts, wind-blown fields, soundscape, buffet
 */

export const suite = {
  name: "environment:storm-realism",
  group: "unit",
  covers:   [
    "engine/src/environment/waterspout.ts",
    "engine/src/environment/windBuffet.ts",
    "engine/src/environment/lightning.ts",
    "engine/src/environment/cyclone.ts",
    "engine/src/environment/clouds.ts",
    "engine/src/environment/water.ts",
    "engine/src/environment/ocean.ts",
    "engine/src/terrain/coastal.ts",
    "engine/src/particles/windBlown.ts",
    "engine/src/particles/waterspoutVisual.ts",
    "engine/src/audio/storm.ts"
  ],
  desc: "fe-34 storm realism: curvy shore, set-up/tide, gusts, billows, lightning branches, waterspouts, wind-blown fields, soundscape, buffet",
};
/**
 * What these prove:
 *  - the curvy coast: terrain and water share one waterline (`shoreCurveOffset`) that winds;
 *  - the sea level: wind set-down offshore / set-up onshore, the scripted tide, surge and run-up reach
 *    `water.level`, and the water mesh follows the live level;
 *  - gusts are deterministic, bounded and absent without gustiness;
 *  - billows keep structure at full coverage and are a no-op at 0;
 *  - lightning: branches are seeded, strikes land on the supplied surface at the supplied centre,
 *    intra-cloud flashes stay in the deck, `paused` freezes, the rate follows the `storm` callback;
 *  - waterspouts: life cycle, wind-scaled seeded spawning (identical runs), drift, funnel widening;
 *  - wind-blown fields, the soundscape mapping and the camera buffet are monotonic in wind.
 */
import assert from "node:assert/strict";
import { assertCloseTo, finish, group, test } from "selrun";
import {
  CycloneSystem,
  CycloneTrack,
  LightningSystem,
  Scene,
  Vec3,
  WaterSurface,
  WaterspoutSystem,
  cloudBillowApply,
  cloudDensityAt,
  coastalCoordinates,
  coastalHeightAt,
  coastalShoreSettings,
  cycloneGustSignal,
  cycloneWindSetup,
  defaultWaterShore,
  lightningBranches,
  generateBoltPoints,
  oceanWavesFromWind,
  shoreCurveOffset,
  shoreDepthAt,
  stormSoundLevels,
  waterspoutFunnelAt,
  waterspoutSpawnRate,
  waterspoutStrength,
  windBlownPreset,
  windBlownVelocity,
  windBuffet,
  type SystemContext,
} from "@forge/engine";

const ctx = (steps: number, dt = 1 / 60): SystemContext => ({ fixedSteps: steps, fixedDt: dt }) as unknown as SystemContext;

group("curvy coast", () => {
  const coast = { originX: 0, originZ: 0, directionX: 0, directionZ: -1, slope: 0.05, curveAmp1: 20, curveLength1: 400, curvePhase1: 0.3, curveAmp2: 5, curveLength2: 120, curvePhase2: 1 };
  test("terrain and water share the winding waterline", () => {
    const shore = { ...defaultWaterShore(), ...coastalShoreSettings(coast) };
    for (const x of [-300, -120, 0, 77, 260]) {
      // `across` = x here (direction −Z): the waterline sits curve(x) metres inland (−Z).
      const c = shoreCurveOffset(coast, x);
      const zLine = -c;
      assertCloseTo(coastalHeightAt(coast, x, zLine), 0, 6);
      assertCloseTo(shoreDepthAt(shore, 0, x, zLine), 0, 6);
      assert.ok(shoreDepthAt(shore, 0, x, zLine + 20) > 0, "seaward is wet");
      assertCloseTo(coastalCoordinates(coast, x, zLine).along, 0, 9);
    }
    const offsets = [-300, -150, 0, 150, 300].map((x) => shoreCurveOffset(coast, x));
    assert.ok(Math.max(...offsets) - Math.min(...offsets) > 15, "the coast actually winds");
    assert.equal(shoreCurveOffset({}, 123), 0, "straight by default");
  });
  test("dune rows add hummocks behind the fore-dune", () => {
    let plain = 0;
    let rows = 0;
    for (let x = -100; x <= 100; x += 10) {
      plain += coastalHeightAt({ ...coast, curveAmp1: 0, curveAmp2: 0 }, x, -140);
      rows += coastalHeightAt({ ...coast, curveAmp1: 0, curveAmp2: 0, duneRows: 2 }, x, -140);
    }
    assert.ok(rows > plain);
  });
});

group("sea level, gusts, billows, waves", () => {
  test("offshore wind sets the sea down, onshore sets it up", () => {
    // Land toward −Z: wind toward +Z blows offshore.
    assert.ok(cycloneWindSetup(0, 40, 0, -1, 4e-4) < -0.5);
    assert.ok(cycloneWindSetup(0, -40, 0, -1, 4e-4) > 0.5);
    assertCloseTo(cycloneWindSetup(40, 0, 0, -1, 4e-4), 0, 9);
    assert.equal(cycloneWindSetup(0, 200, 0, -1, 4e-4, 1.2), -1.2);
  });
  test("tide, set-up, surge and run-up reach the water; the mesh follows the level", () => {
    const scene = new Scene();
    const water = new WaterSurface({ level: 0 });
    scene.add(water);
    const track = new CycloneTrack([
      { time: 0, x: 0, z: 30000, maxWind: 60, radiusMaxWind: 30000, eyeRadius: 10000, rain: 1, surge: 2 },
      { time: 10, x: 0, z: 29000, maxWind: 60, radiusMaxWind: 30000, eyeRadius: 10000, rain: 1, surge: 2 },
    ]);
    const cyclone = new CycloneSystem({ track, observer: () => ({ x: 0, z: 0 }), coast: { onshoreX: 0, onshoreZ: -1, coefficient: 4e-4 }, runup: { base: 0.5, perMetre: 0.5 } });
    scene.add(cyclone);
    cyclone.tideOffset = -0.7;
    cyclone.evaluate(0.1);
    const o = cyclone.observed;
    assertCloseTo(scene.settings.water.level, o.surge + o.setup - 0.7, 9);
    assert.ok(o.surge > 0.5);
    assertCloseTo(scene.settings.water.shore.foamDepth, 0.5 + 0.5 * (cyclone.ocean?.significantHeight ?? 0), 9);
    water.update(ctx(1));
    const id = (water as unknown as { entityId: number }).entityId;
    assert.ok(id !== 0);
    assertCloseTo(scene.world.facade(id as never)!.transform.position.y, scene.settings.water.level, 5);
  });
  test("gusts are bounded, deterministic and off without gustiness", () => {
    let max = 0;
    for (let t = 0; t < 120; t += 0.1) {
      const g = cycloneGustSignal(t, 5);
      assert.ok(g >= 0 && g <= 1);
      max = Math.max(max, g);
      assert.equal(g, cycloneGustSignal(t, 5));
    }
    assert.ok(max > 0.5, "real gusts happen");
    const scene = new Scene();
    const track = new CycloneTrack([{ time: 0, x: 0, z: 40000, maxWind: 50, radiusMaxWind: 30000, eyeRadius: 9000, rain: 1 }]);
    const steady = new CycloneSystem({ track, observer: () => ({ x: 0, z: 0 }) });
    scene.add(steady);
    steady.update(ctx(60));
    assert.equal(steady.observed.gust, 0);
    assert.equal(steady.observed.gustSpeed, steady.observed.wind.speed);
  });
  test("billows keep structure at full coverage; 0 is the old deck", () => {
    assert.equal(cloudBillowApply(0.7, 0.3, 0), 0.7);
    assert.equal(cloudDensityAt(10, 20, 1, 0.9, 0.001, 3), 0.9);
    const vals = new Set<number>();
    for (let x = 0; x < 20000; x += 997) vals.add(Math.round(cloudDensityAt(x, x * 0.7, 1, 0.9, 0.001, 3, 0, 0.9) * 100));
    assert.ok(vals.size > 4, "overcast but lumpy");
  });
  test("eight components add wave groups and chop; four are unchanged", () => {
    const four = oceanWavesFromWind({ windSpeed: 30, direction: 0, waveCount: 4, maxHeight: 6 });
    const eight = oceanWavesFromWind({ windSpeed: 30, direction: 0, waveCount: 8, maxHeight: 6 });
    assert.equal(four.waves.length, 4);
    assert.equal(eight.waves.length, 8);
    const lens = eight.waves.map((w) => w.wavelength).sort((a, b) => b - a);
    assert.ok(lens[1]! / lens[0]! > 0.85, "a near-twin of the peak (groups)");
    assert.ok(lens[7]! < lens[0]! * 0.1, "short chop");
    const sumA = (s: typeof four) => s.waves.reduce((a, w) => a + w.amplitude, 0);
    assertCloseTo(sumA(four), sumA(eight), 9);
  });
});

group("lightning", () => {
  test("branches are seeded and start on the channel", () => {
    const main = generateBoltPoints(new Vec3(0, 900, 0), new Vec3(0, 0, 0), 7, 5, 0.4);
    const a = lightningBranches(main, 7, 3, 5, 0.4);
    const b = lightningBranches(main, 7, 3, 5, 0.4);
    assert.equal(a.length, 3);
    assert.deepEqual(a.map((p) => p.map((v) => [v.x, v.y, v.z])), b.map((p) => p.map((v) => [v.x, v.y, v.z])));
    for (const br of a) assert.ok(main.some((m) => m.x === br[0]!.x && m.y === br[0]!.y && m.z === br[0]!.z));
    assert.equal(lightningBranches(main, 7, 0, 5, 0.4).length, 0);
  });
  test("strikes follow the storm callback, centre and surface; pause freezes", () => {
    let storm = 0;
    const l = new LightningSystem({ seed: 5, rate: 2, storm: () => storm, center: () => ({ x: 5000, z: -3000 }), areaRadius: 100, surfaceAt: () => 2.5, branches: 2 });
    l.advance(30);
    assert.equal(l.strikeCount, 0, "calm: no strikes");
    storm = 1;
    l.advance(10);
    assert.ok(l.strikeCount > 5);
    const s = l.strikes[l.strikes.length - 1] ?? l.trigger();
    assert.ok(Math.hypot(s.position.x - 5000, s.position.z + 3000) <= 150);
    assertCloseTo(s.bolt.points[s.bolt.points.length - 1]!.y, 2.5, 6);
    assert.equal(s.bolt.branches.length, 2);
    const cloud = l.trigger(undefined, 1, true);
    assert.ok(cloud.bolt.cloudOnly && cloud.bolt.points[cloud.bolt.points.length - 1]!.y > 500);
    l.paused = true;
    const n = l.strikeCount;
    const age = cloud.age;
    l.advance(5);
    assert.equal(l.strikeCount, n);
    assert.equal(cloud.age, age);
  });
});

group("waterspouts", () => {
  test("life cycle and wind-scaled spawn rate", () => {
    assert.equal(waterspoutStrength(-1, 10), 0);
    assert.ok(waterspoutStrength(1, 10) < 1);
    assert.equal(waterspoutStrength(5, 10), 1);
    assert.ok(waterspoutStrength(9.5, 10) < 0.2);
    assert.equal(waterspoutSpawnRate(8), 0);
    assert.ok(waterspoutSpawnRate(20) > 0 && waterspoutSpawnRate(20) < waterspoutSpawnRate(28));
    assert.equal(waterspoutSpawnRate(80), waterspoutSpawnRate(30));
  });
  test("seeded spawning is reproducible, drifts and dissipates", () => {
    const run = () => {
      const sys = new WaterspoutSystem({ seed: 11, spawnRate: () => 0.2, area: () => ({ x: 0, z: 1000, radius: 500 }), wind: () => ({ x: 20, z: 0 }), lifeMin: 20, lifeMax: 30 });
      const log: number[] = [];
      for (let i = 0; i < 600; i++) {
        sys.advance(0.1);
        for (const s of sys.spouts) log.push(Math.round(s.x), Math.round(s.z));
      }
      return { log, spawned: sys.spawned, left: sys.spouts.length };
    };
    const a = run();
    const b = run();
    assert.deepEqual(a, b);
    assert.ok(a.spawned >= 2);
    const sys = new WaterspoutSystem({ spawnRate: () => 0, area: () => ({ x: 0, z: 0, radius: 1 }), wind: () => ({ x: 10, z: 0 }) });
    const s = sys.spawn({ x: 0, z: 0 }, 10);
    sys.advance(5);
    assert.ok(s.x > 5, "drifts downwind");
    sys.advance(6);
    assert.equal(sys.spouts.length, 0, "dissipates");
    assert.equal(sys.spawned, 1, "no spawns at rate 0");
  });
  test("the funnel widens toward the cloud and lifts off the sea as it dies", () => {
    const sys = new WaterspoutSystem({ spawnRate: () => 0, area: () => ({ x: 0, z: 0, radius: 1 }), wind: () => ({ x: 0, z: 0 }) });
    const s = sys.spawn({ x: 0, z: 0 }, 40);
    s.age = 20;
    const low = waterspoutFunnelAt(s, 0.05, 0);
    const high = waterspoutFunnelAt(s, 0.95, 0);
    assert.ok(high.radius > low.radius * 1.5);
    assert.ok(waterspoutFunnelAt(s, 0.3, 0).opacity > 0.9, "reaches the sea mid-life");
    s.age = 38;
    assert.ok(waterspoutFunnelAt(s, 0.05, 0).opacity < 0.2, "ropes out from the bottom");
  });
});

group("wind made visible", () => {
  test("wind-blown fields ride the wind", () => {
    for (const m of ["spray", "spindrift", "sand", "mist", "debris"] as const) {
      const look = windBlownPreset(m);
      const v = windBlownVelocity(30, 0, look);
      assert.ok(v.x > 0.5 && v.speed > 10, m);
    }
    assert.equal(windBlownVelocity(0, 0, { windCoupling: 1, lift: 0 }).speed, 0);
  });
  test("soundscape and buffet grow with the wind", () => {
    const calm = stormSoundLevels({ windSpeed: 5, gust: 0, rain: 0, surf: 0.1 });
    const storm = stormSoundLevels({ windSpeed: 65, gust: 1, rain: 1, surf: 1 });
    assert.ok(storm.windGain > calm.windGain && storm.howlGain > calm.howlGain && storm.windFrequency > calm.windFrequency);
    assert.ok(storm.rainGain > calm.rainGain && storm.surfGain > calm.surfGain);
    const still = windBuffet(3.3, 0, 0);
    assert.equal(Math.hypot(still.x, still.y, still.z, still.roll), 0);
    let weak = 0;
    let strong = 0;
    for (let t = 0; t < 20; t += 0.05) {
      const a = windBuffet(t, 20, 0.2);
      const b = windBuffet(t, 65, 1);
      weak = Math.max(weak, Math.abs(a.x) + Math.abs(a.z));
      strong = Math.max(strong, Math.abs(b.x) + Math.abs(b.z));
    }
    assert.ok(strong > weak * 4 && strong < 1);
  });
});

finish();
