/**
 * @suite environment:ocean
 * @group unit
 * @covers engine/src/environment/ocean.ts
 * @covers engine/src/environment/cyclone.ts
 * @covers engine/src/environment/water.ts
 * @covers engine/src/terrain/coastal.ts
 * @covers engine/src/population/windSway.ts
 * @covers engine/src/particles/precipitation.ts
 * @covers engine/src/scene/scene.ts
 * @covers engine/src/rendering/renderer.ts
 * @covers engine/src/rendering/shaders/water.ts
 * @covers engine/src/rendering/uniforms.ts
 * @desc fe-33 ocean, shoreline, cyclone field/system, coastal terrain, wind sway and precipitation direction
 */

export const suite = {
  name: "environment:ocean",
  group: "unit",
  covers:   [
    "engine/src/environment/ocean.ts",
    "engine/src/environment/cyclone.ts",
    "engine/src/environment/water.ts",
    "engine/src/terrain/coastal.ts",
    "engine/src/population/windSway.ts",
    "engine/src/particles/precipitation.ts",
    "engine/src/scene/scene.ts",
    "engine/src/rendering/renderer.ts",
    "engine/src/rendering/shaders/water.ts",
    "engine/src/rendering/uniforms.ts"
  ],
  desc: "fe-33 ocean, shoreline, cyclone field/system, coastal terrain, wind sway and precipitation direction",
};
/**
 * What these prove:
 *  - Pierson–Moskowitz closed forms, wind-driven wave sets (direction, caps, deep-water speeds),
 *    the tier table and the focused ocean grid (valid, monotonic, denser at the focus);
 *  - the shoreline: depth from the analytic bed, shoaling peak/zero/limit, the breaker-index cap,
 *    choppiness and shoaling reaching `sampleWater`, and settings round-tripping through serialize;
 *  - the cyclone: Saffir–Simpson thresholds, track interpolation, a calm eye / peak at Rm /
 *    decaying outer wind, counter-clockwise northern rotation, dry eye vs wet eyewall, clear eye,
 *    phases, and a `CycloneSystem` driving clouds/fog/ocean/surge on the scene;
 *  - the coast: the seabed equals the water's shore bed offshore, berm + dunes inland;
 *  - wind sway and precipitation slant are monotonic in wind and point downwind.
 */

import assert from "node:assert/strict";
import { assertCloseTo, finish, group, test } from "selrun";
import {
  CycloneSystem,
  CycloneTrack,
  Scene,
  WaterSurface,
  coastalHeightAt,
  coastalShoreSettings,
  coastalTerrainSource,
  createCycloneState,
  cyclonePhaseAt,
  cycloneRainAt,
  cycloneCoverAt,
  cycloneWindAt,
  cycloneWindProfile,
  deepWaterSpeed,
  oceanGridSource,
  oceanQualityForTier,
  oceanWavesFromWind,
  pmPeakWavelength,
  pmSignificantHeight,
  precipitationDirection,
  sampleGerstner,
  sampleWater,
  saffirSimpsonCategory,
  shoalFactor,
  shoreDepthAt,
  totalWaveAmplitude,
  windBendAngle,
  windBendWeights,
  windSway,
  BREAKER_INDEX,
  SHOAL_PEAK,
} from "@forge/engine";

const ctx = (fixedSteps: number, fixedDt: number) => ({ fixedSteps, fixedDt }) as never;

group("ocean waves from wind", () => {
  test("Pierson–Moskowitz closed forms", () => {
    assertCloseTo(pmSignificantHeight(10), (0.21 * 100) / 9.81, 9);
    const omega = (0.877 * 9.81) / 10;
    assertCloseTo(pmPeakWavelength(10), (2 * Math.PI * 9.81) / (omega * omega), 6);
    assertCloseTo(deepWaterSpeed(100), Math.sqrt((9.81 * 100) / (2 * Math.PI)), 9);
  });

  test("waves follow the wind, respect the height cap and use deep-water speeds", () => {
    const s = oceanWavesFromWind({ windSpeed: 60, direction: Math.PI / 2, maxHeight: 4 });
    assert.equal(s.waves.length, 4);
    assertCloseTo(s.significantHeight, 4, 9);
    assertCloseTo(totalWaveAmplitude(s.waves), 2, 9);
    const w0 = s.waves[0]!;
    assertCloseTo(w0.directionX, 0, 9);
    assertCloseTo(w0.directionZ, 1, 9);
    for (const w of s.waves) assertCloseTo(w.speed, deepWaterSpeed(w.wavelength), 9);
    const calm = oceanWavesFromWind({ windSpeed: 3, direction: 0 });
    assert.ok(calm.choppiness < s.choppiness);
    assert.ok(calm.foamThreshold > s.foamThreshold);
    assert.equal(oceanWavesFromWind({ windSpeed: 10, direction: 0, waveCount: 2 }).waves.length, 2);
  });

  test("tiers scale the grid and the focused grid is valid and denser at the focus", () => {
    assert.ok(oceanQualityForTier("low").gridSegments < oceanQualityForTier("medium").gridSegments);
    assert.ok(oceanQualityForTier("medium").gridSegments < oceanQualityForTier("high").gridSegments);
    const g = oceanGridSource(1000, 40, 2, 0, 100, 2);
    assert.equal(g.positions.length, 41 * 41 * 3);
    assert.equal(g.indices.length, 40 * 40 * 6);
    let prev = -Infinity;
    let minGapNear = Infinity;
    let maxGap = 0;
    for (let iz = 0; iz < 41; iz++) {
      const z = g.positions[iz * 41 * 3 + 2]!;
      assert.ok(z > prev);
      if (iz > 0) {
        const gap = z - prev;
        if (Math.abs(z - 100) < 60) minGapNear = Math.min(minGapNear, gap);
        maxGap = Math.max(maxGap, gap);
      }
      prev = z;
    }
    assertCloseTo(prev, 500, 6);
    assert.ok(minGapNear * 4 < maxGap);
  });
});

group("shoreline", () => {
  const scene = new Scene();
  scene.add(new WaterSurface({ level: 0 }));
  scene.setWater({ shore: { enabled: true, originX: 0, originZ: 0, directionX: 0, directionZ: -1, slope: 0.05, breakDepth: 2 } });
  const water = scene.settings.water;

  test("depth comes from the analytic bed and rises with the level (surge)", () => {
    assertCloseTo(shoreDepthAt(water.shore, 0, 0, 100), 5, 9);
    assertCloseTo(shoreDepthAt(water.shore, 0, 0, -20), -1, 9);
    assertCloseTo(shoreDepthAt(water.shore, 1, 0, -20), 0, 9);
    assert.equal(shoreDepthAt({ ...water.shore, enabled: false }, 0, 0, 0), Number.POSITIVE_INFINITY);
  });

  test("shoaling: 1 offshore, peak at the break line, 0 at the waterline, capped by depth", () => {
    assert.equal(shoalFactor(10, 2), 1);
    assertCloseTo(shoalFactor(2, 2), SHOAL_PEAK, 9);
    assert.equal(shoalFactor(0, 2), 0);
    assert.equal(shoalFactor(-1, 2), 0);
    assertCloseTo(shoalFactor(2, 2, 3), (BREAKER_INDEX * 0.5 * 2) / 3, 9);
  });

  test("sampleWater applies choppiness and shoaling like the shader", () => {
    scene.setWater({ waves: [{ directionX: 0, directionZ: -1, wavelength: 40, amplitude: 0.5, speed: 5, steepness: 0.4, phase: 0 }], choppiness: 2 });
    const deep = sampleWater(water, 3, 200, 1.3);
    const ref = sampleGerstner(water.waves, 3, 200, 1.3, undefined, 2, 1);
    assertCloseTo(deep.y, ref.y, 12);
    assertCloseTo(deep.dz, ref.dz, 12);
    const near = sampleWater(water, 3, 40, 1.3);
    const s = shoalFactor(2, 2, 0.5);
    assertCloseTo(near.y, sampleGerstner(water.waves, 3, 40, 1.3, undefined, 2, s).y, 12);
    const dry = sampleWater(water, 0, -10, 1.3);
    assert.equal(dry.y, 0);
  });

  test("shore + choppiness survive serialize / applySerialized", () => {
    const data = scene.serialize();
    const other = new Scene();
    other.applySerialized(data);
    assert.equal(other.settings.water.shore.enabled, true);
    assertCloseTo(other.settings.water.shore.slope, 0.05, 9);
    assertCloseTo(other.settings.water.choppiness, 2, 9);
  });
});

group("cyclone field", () => {
  const s = createCycloneState();
  Object.assign(s, { maxWind: 60, radiusMaxWind: 30000, eyeRadius: 12000, rain: 1 });

  test("Saffir–Simpson thresholds", () => {
    assert.equal(saffirSimpsonCategory(10), -1);
    assert.equal(saffirSimpsonCategory(20), 0);
    assert.equal(saffirSimpsonCategory(35), 1);
    assert.equal(saffirSimpsonCategory(45), 2);
    assert.equal(saffirSimpsonCategory(52), 3);
    assert.equal(saffirSimpsonCategory(62), 4);
    assert.equal(saffirSimpsonCategory(72), 5);
  });

  test("calm eye, peak at the radius of maximum wind, decay outside", () => {
    assert.ok(cycloneWindProfile(s, 0) < 1e-9);
    assert.ok(cycloneWindProfile(s, 6000) < 0.1 * 60);
    assertCloseTo(cycloneWindProfile(s, 30000), 60, 9);
    assert.ok(cycloneWindProfile(s, 90000) < cycloneWindProfile(s, 45000));
    assert.ok(cycloneWindProfile(s, 45000) < 60);
  });

  test("northern storms turn counter-clockwise with inflow", () => {
    const w = cycloneWindAt(s, 30000, 0);
    assert.ok(w.z > 0, "east of the centre the wind blows toward +Z");
    assert.ok(w.x < 0, "and a little inward");
    const south = cycloneWindAt(s, 30000, 0, { hemisphere: -1 });
    assert.ok(south.z < 0);
  });

  test("forward motion is scaled by the time compression", () => {
    const m = { ...s, velocityX: 600, velocityZ: 0 };
    const fast = cycloneWindAt(m, 0, 0);
    assertCloseTo(fast.x, 300, 9);
    const real = cycloneWindAt(m, 0, 0, { timeCompression: 100 });
    assertCloseTo(real.x, 3, 9);
  });

  test("dry clear eye, wet overcast eyewall, phases", () => {
    assert.equal(cycloneRainAt(s, 0, 0), 0);
    assert.ok(cycloneRainAt(s, 30000, 0) > 0.9);
    assert.ok(cycloneCoverAt(s, 0, 0) < 0.2);
    assert.ok(cycloneCoverAt(s, 30000, 0) > 0.8);
    assert.equal(cyclonePhaseAt(s, 0, 0), "eye");
    assert.equal(cyclonePhaseAt(s, 35000, 0), "eyewall");
    assert.equal(cyclonePhaseAt(s, 120000, 0), "rainbands");
    assert.equal(cyclonePhaseAt(s, 300000, 0), "outer-bands");
    assert.equal(cyclonePhaseAt(s, 900000, 0), "clear");
  });

  test("track interpolation and velocity", () => {
    const track = new CycloneTrack([
      { time: 10, x: 0, z: 1000, maxWind: 40, radiusMaxWind: 20000, eyeRadius: 5000, rain: 0.5 },
      { time: 0, x: 0, z: 2000, maxWind: 20, radiusMaxWind: 40000, eyeRadius: 0, rain: 0 },
    ]);
    assert.equal(track.duration, 10);
    const st = track.sample(5);
    assertCloseTo(st.z, 1500, 9);
    assertCloseTo(st.maxWind, 30, 9);
    assertCloseTo(st.velocityZ, -100, 9);
    assertCloseTo(track.sample(99).z, 1000, 9);
  });
});

group("cyclone system", () => {
  test("drives clouds, fog, ocean and surge at the observer, and lags the sea", () => {
    const scene = new Scene();
    scene.add(new WaterSurface({ level: 0 }));
    const track = new CycloneTrack([
      { time: 0, x: 0, z: 400000, maxWind: 25, radiusMaxWind: 40000, eyeRadius: 10000, rain: 0.4 },
      { time: 10, x: 0, z: 30000, maxWind: 70, radiusMaxWind: 30000, eyeRadius: 12000, rain: 1, surge: 1 },
      { time: 20, x: 0, z: 0, maxWind: 70, radiusMaxWind: 30000, eyeRadius: 12000, rain: 1, surge: 1 },
    ]);
    const cyclone = new CycloneSystem({ track, observer: () => ({ x: 0, z: 0 }), timeCompression: 600 });
    scene.add(cyclone);
    const calmCover = scene.settings.clouds.coverage;
    cyclone.update(ctx(600, 1 / 60));
    assertCloseTo(cyclone.time, 10, 6);
    const o = cyclone.observed;
    assert.equal(o.phase, "eyewall");
    assert.ok(o.wind.speed > 60);
    assert.ok(scene.settings.clouds.coverage > calmCover);
    assert.ok(scene.settings.fog.density > 0.005);
    assert.ok(o.darkness > 0.5);
    assert.ok(o.seaWind < o.wind.speed, "the sea lags the wind");
    assert.ok(scene.settings.water.level > 0.5, "surge");
    assert.ok(cyclone.ocean && cyclone.ocean.waves.length === 4);
    cyclone.seek(20);
    assert.equal(cyclone.observed.phase, "eye");
    assert.ok(cyclone.observed.seaWind > 30, "seek keeps the swell in the eye");
    assert.ok(scene.settings.clouds.coverage < 0.2);
  });
});

group("coast, sway and rain", () => {
  const coast = { originX: 0, originZ: 0, directionX: 0, directionZ: -1, slope: 0.05, bermHeight: 1.5, beachWidth: 60, duneHeight: 4 };
  test("offshore the bed is exactly the water's shore bed", () => {
    const shore = coastalShoreSettings(coast);
    assert.equal(shore.enabled, true);
    for (const z of [5, 40, 200]) assertCloseTo(coastalHeightAt(coast, 7, z), -0.05 * z, 9);
    assertCloseTo(coastalHeightAt(coast, 0, 2000), -30, 9);
    assert.ok(coastalHeightAt(coast, 0, -45) > 1.4);
    let crest = 0;
    for (let a = 50; a < 120; a += 2) crest = Math.max(crest, coastalHeightAt(coast, 0, -a));
    assert.ok(crest > 3, "dune ridge");
    const mesh = coastalTerrainSource(coast, 0, 0, 100, 60, 10, 6);
    assert.equal(mesh.indices.length, 10 * 6 * 6);
    assert.ok(mesh.boundsMax[1] >= mesh.boundsMin[1]);
  });

  test("wind sway bends downwind, more in stronger wind, weighted to the tip", () => {
    assert.equal(windBendAngle(0), 0);
    assert.ok(windBendAngle(20) < windBendAngle(60));
    assert.ok(windBendAngle(500, 1) < 1);
    const w = windBendWeights(4);
    assertCloseTo(w.reduce((a, b) => a + b, 0), 1, 12);
    assert.ok(w[3]! > w[0]!);
    const p = windSway(0, 30, 0);
    assertCloseTo(p.downwindZ, 1, 12);
    // Rotating +Y about (axisX, 0, axisZ) tips it toward (−axisZ, 0, axisX)… = downwind.
    assertCloseTo(-p.axisZ, p.downwindX, 12);
    assertCloseTo(p.axisX, p.downwindZ, 12);
  });

  test("rain slants downwind and falls", () => {
    const d = precipitationDirection(20, 0, 20, 1);
    assert.ok(d.x > 0 && d.y < 0);
    assertCloseTo(Math.hypot(d.x, d.y, d.z), 1, 12);
    assertCloseTo(precipitationDirection(0, 0, 20).y, -1, 12);
  });
});

finish();
