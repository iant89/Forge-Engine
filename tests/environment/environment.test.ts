/**
 * @suite environment:environment
 * @group unit
 * @covers engine/src/core/engine.ts
 * @covers engine/src/core/time.ts
 * @covers engine/src/environment/atmosphere.ts
 * @covers engine/src/environment/dayNight.ts
 * @covers engine/src/environment/fog.ts
 * @covers engine/src/environment/solar.ts
 * @covers engine/src/index.ts
 * @covers engine/src/math/color.ts
 * @covers engine/src/math/vec.ts
 * @covers engine/src/scene/components/index.ts
 * @covers engine/src/scene/scene.ts
 * @desc Environment (Phase 8a): sun position, atmosphere model, fog formulas and the day/night cycle
 */

export const suite = {
  name: "environment:environment",
  group: "unit",
  covers:   [
    "engine/src/core/engine.ts",
    "engine/src/core/time.ts",
    "engine/src/environment/atmosphere.ts",
    "engine/src/environment/dayNight.ts",
    "engine/src/environment/fog.ts",
    "engine/src/environment/solar.ts",
    "engine/src/index.ts",
    "engine/src/math/color.ts",
    "engine/src/math/vec.ts",
    "engine/src/scene/components/index.ts",
    "engine/src/scene/scene.ts"
  ],
  desc: "Environment (Phase 8a): sun position, atmosphere model, fog formulas and the day/night cycle",
};
/**
 * Environment (Phase 8a): sun position, atmosphere model, fog formulas and the day/night cycle.
 *
 * What these prove, and against what:
 *  - the solar model reproduces Meeus' worked examples (25.a: apparent RA/Dec of the sun on
 *    1992-10-13; 28.a: equation of time) and textbook facts (declination ±23.44° at the solstices,
 *    noon elevation 90° − |φ − δ|, 18.9 h days at 60°N in June, polar night at 80°N in December);
 *  - the atmosphere reproduces published coefficients from first principles (Rayleigh β(λ) table),
 *    closed forms (vertical optical depth β·H, √(πR/2H) horizon air mass, phase-function
 *    normalisation), and the qualitative sky everyone can check by looking up (blue zenith, red
 *    horizon at sunset, red-shifted direct sun);
 *  - the fog closed form equals a brute-force integral of the height-fog density;
 *  - the `DayNightCycle` is frame-rate independent, drives the light/ambient/fog/sky settings, and
 *    is idempotent for a given instant.
 */

import assert from "node:assert/strict";
import { assertCloseTo, finish, group, test } from "selrun";
import {
  AtmosphereModel,
  Color,
  DayNightCycle,
  EARTH_ATMOSPHERE,
  Engine,
  FOG_MODE_ID,
  Light,
  MARS_ATMOSPHERE,
  ManualClock,
  Scene,
  Vec3,
  atmosphericRefractionDeg,
  createAtmosphere,
  daysInYear,
  defaultSkySettings,
  directionFromElevationAzimuth,
  elevationAzimuthOf,
  fogTransmittance,
  fogTransmittanceHeight,
  heightFogOpticalDepth,
  henyeyGreensteinPhase,
  julianDay,
  julianDayFromDayOfYear,
  miePhase,
  rayleighCoefficient,
  rayleighPhase,
  solarCoordinates,
  solarPosition,
  sunDirection,
  sunEvents,
} from "@forge/engine";

const DEG = Math.PI / 180;
const rgb = () => new Float64Array(3);

group("solar position (Meeus / NOAA)", () => {
  test("computes the Julian day of calendar dates (Meeus 7.a and J2000)", () => {
    assertCloseTo(julianDay(1957, 10, 4.81), 2436116.31, 2);
    assert.equal(julianDay(2000, 1, 1, 12), 2451545);
    assert.equal(julianDay(1992, 10, 13), 2448908.5);
    assert.equal(julianDayFromDayOfYear(2000, 1), 2451544.5);
    assert.equal(julianDayFromDayOfYear(2000, 366, 12), julianDay(2000, 12, 31, 12));
    assert.equal(daysInYear(2000), 366);
    assert.equal(daysInYear(1900), 365);
    assert.equal(daysInYear(2024), 366);
  });

  test("reproduces Meeus example 25.a: the sun on 1992 October 13, 0h TD", () => {
    const c = solarCoordinates(2448908.5);
    assertCloseTo(c.rightAscension / DEG, 198.38083, 2);
    assertCloseTo(c.declination / DEG, -7.78507, 2);
    assertCloseTo(c.distanceAu, 0.99766, 4);
    assertCloseTo(c.apparentLongitude / DEG, 199.90895, 2);
  });

  test("reproduces Meeus example 28.a: the equation of time on 1992 October 13", () => {
    // Meeus: E = 3.427351° = 13m 42.6s (from the rigorous method; 28.3's series agrees to ~1 s).
    const c = solarCoordinates(2448908.5);
    assertCloseTo(c.equationOfTime, 13.71, 1);
    // Extremes of the year (NOAA tables): ≈ −14.2 min around Feb 11, ≈ +16.4 min around Nov 3.
    assert.ok(solarCoordinates(julianDay(2000, 2, 11)).equationOfTime > -14.5);
    assert.ok(solarCoordinates(julianDay(2000, 2, 11)).equationOfTime < -14.0);
    assert.ok(solarCoordinates(julianDay(2000, 11, 3)).equationOfTime > 16.2);
    assert.ok(solarCoordinates(julianDay(2000, 11, 3)).equationOfTime < 16.6);
  });

  test("puts the declination at ±23.44° on the solstices and ~0 on the equinoxes", () => {
    assertCloseTo(solarCoordinates(julianDay(2000, 6, 21, 2)).declination / DEG, 23.44, 1);
    assertCloseTo(solarCoordinates(julianDay(2000, 12, 21, 14)).declination / DEG, -23.44, 1);
    assert.ok(Math.abs(solarCoordinates(julianDay(2000, 3, 20, 8)).declination / DEG) < 0.05);
    assert.ok(Math.abs(solarCoordinates(julianDay(2000, 9, 22, 18)).declination / DEG) < 0.05);
  });

  test("gives the noon elevation 90° − |latitude − declination| and a due-south azimuth", () => {
    // Greenwich, June 21: solar noon is at 12:00 UTC minus the equation of time (~−1.7 min).
    const jd = julianDay(2000, 6, 21, 12 + 1.7 / 60);
    const p = solarPosition(jd, 51.48, 0, undefined, false);
    const expected = 90 - Math.abs(51.48 - p.declination / DEG);
    assertCloseTo(p.trueElevation / DEG, expected, 1);
    assertCloseTo(p.azimuth / DEG, 180, 0);
    assert.ok(Math.abs(p.hourAngle) < 0.01);
    // Southern hemisphere at the same instant: the sun is due north.
    const south = solarPosition(jd, -33.9, 0, undefined, false);
    assertCloseTo(south.azimuth / DEG, 0, 0);
  });

  test("rises in the north-east at 40°N in June and sets in the north-west", () => {
    const events = sunEvents(julianDay(2000, 6, 21), 40, 0);
    assert.notEqual(events.sunrise, null);
    assert.notEqual(events.sunset, null);
    const rise = solarPosition(julianDay(2000, 6, 21, events.sunrise!), 40, 0);
    const set = solarPosition(julianDay(2000, 6, 21, events.sunset!), 40, 0);
    // At the NOAA sunrise (zenith 90.833°) the refracted upper limb is on the horizon.
    assertCloseTo(rise.trueElevation / DEG, -0.833, 1);
    assertCloseTo(set.trueElevation / DEG, -0.833, 1);
    // Geometric sunrise azimuth ≈ acos(−sin δ / cos φ) ≈ 58.7°; the depressed horizon shifts it a little north.
    assert.ok(rise.azimuth / DEG > 56);
    assert.ok(rise.azimuth / DEG < 60);
    assert.ok(set.azimuth / DEG > 300);
    assert.ok(set.azimuth / DEG < 304);
    assert.ok(events.dayLength > 14.9);
    assert.ok(events.dayLength < 15.2);
  });

  test("gives ~18.9 h of daylight at 60°N on the June solstice and none at 80°N in December", () => {
    const june = sunEvents(julianDay(2000, 6, 21), 60, 0);
    assert.ok(june.dayLength > 18.6);
    assert.ok(june.dayLength < 19.1);
    const polarNight = sunEvents(julianDay(2000, 12, 21), 80, 0);
    assert.equal(polarNight.sunrise, null);
    assert.equal(polarNight.dayLength, 0);
    const midnightSun = sunEvents(julianDay(2000, 6, 21), 80, 0);
    assert.equal(midnightSun.sunrise, null);
    assert.equal(midnightSun.dayLength, 24);
    // And the sun really is up at local midnight there.
    assert.ok(solarPosition(julianDay(2000, 6, 21, 0), 80, 0).elevation > 0);
    // Solar noon moves 4 minutes per degree of longitude (east = earlier).
    const paris = sunEvents(julianDay(2000, 6, 21), 48.85, 2.35);
    assertCloseTo((june.solarNoon - paris.solarNoon) * 60, 4 * 2.35, 0);
  });

  test("applies NOAA's refraction: ~34′ on the horizon, nothing near the zenith", () => {
    assertCloseTo(atmosphericRefractionDeg(0) * 60, 28.9, 0);
    assert.ok(atmosphericRefractionDeg(-0.5) * 60 > 30);
    assertCloseTo(atmosphericRefractionDeg(10) * 60, 5.4, 0);
    assert.equal(atmosphericRefractionDeg(89), 0);
    const p = solarPosition(julianDay(2000, 6, 21, 4), 51.48, 0);
    assert.ok(p.elevation > p.trueElevation);
  });

  test("maps elevation/azimuth to engine axes: +Y up, north = +Z, east = +X", () => {
    const east = directionFromElevationAzimuth(0, 90 * DEG);
    assertCloseTo(east.x, 1, 6);
    assertCloseTo(east.z, 0, 6);
    const north = directionFromElevationAzimuth(0, 0);
    assertCloseTo(north.z, 1, 6);
    const up = directionFromElevationAzimuth(90 * DEG, 123 * DEG);
    assertCloseTo(up.y, 1, 6);
    // Round trip through the inverse.
    const [el, az] = elevationAzimuthOf(directionFromElevationAzimuth(37 * DEG, 250 * DEG));
    assertCloseTo(el / DEG, 37, 5);
    assertCloseTo(az / DEG, 250, 5);
    // A summer morning in the northern hemisphere: sun east-ish and up.
    const morning = sunDirection(solarPosition(julianDay(2000, 6, 21, 8), 45, 0));
    assert.ok(morning.x > 0.3);
    assert.ok(morning.y > 0.3);
    assertCloseTo(morning.length(), 1, 6);
  });
});

group("atmosphere model", () => {
  const earth = new AtmosphereModel(createAtmosphere());
  const UP = new Vec3(0, 1, 0);

  test("derives Bruneton's Rayleigh table (5.802, 13.558, 33.1 ×10⁻⁶/m) from the scattering formula", () => {
    const [r, g, b] = EARTH_ATMOSPHERE.rayleighScattering;
    assertCloseTo(rayleighCoefficient(680) / r, 1, 1);
    assertCloseTo(rayleighCoefficient(550) / g, 1, 1);
    assertCloseTo(rayleighCoefficient(440) / b, 1, 1);
    assert.ok(Math.abs(rayleighCoefficient(550) / g - 1) < 0.01);
    // λ⁻⁴: blue scatters ~5.7× more than red.
    assertCloseTo(rayleighCoefficient(440) / rayleighCoefficient(680), (680 / 440) ** 4, 6);
  });

  test("normalises both phase functions over the sphere", () => {
    const integrate = (f: (c: number) => number): number => {
      let sum = 0;
      const n = 20000;
      for (let i = 0; i < n; i++) {
        const c = -1 + (2 * (i + 0.5)) / n;
        sum += f(c) * (2 / n);
      }
      return sum * 2 * Math.PI;
    };
    assertCloseTo(integrate(rayleighPhase), 1, 4);
    assertCloseTo(integrate((c) => miePhase(c, 0.76)), 1, 3);
    assertCloseTo(integrate((c) => miePhase(c, 0)), 1, 4);
    assertCloseTo(integrate((c) => henyeyGreensteinPhase(c, 0.8)), 1, 3);
    // Forward peaked: a forward Mie lobe is orders of magnitude above the backward one.
    assert.ok(miePhase(1, 0.76) / miePhase(-1, 0.76) > 100);
  });

  test("matches the closed-form vertical optical depth β·H (≈ 0.108 in the green)", () => {
    const p = earth.params;
    const od = earth.opticalDepth(0, p.planetRadius, 0, 0, 1, 0, p.atmosphereHeight, 256, rgb());
    const H = p.rayleighScaleHeight;
    const rayleighColumn = H * (1 - Math.exp(-p.atmosphereHeight / H));
    const mieColumn = p.mieScaleHeight * (1 - Math.exp(-p.atmosphereHeight / p.mieScaleHeight));
    const ozoneColumn = p.ozoneWidth; // tent of half-width w integrates to w
    for (let c = 0; c < 3; c++) {
      const expected = p.rayleighScattering[c]! * rayleighColumn + p.mieExtinction[c]! * mieColumn + p.ozoneAbsorption[c]! * ozoneColumn;
      assertCloseTo(od[c]! / expected, 1, 2);
    }
    // Rayleigh-only zenith depth in the green is the textbook ~0.1.
    const rayleighOnly = new AtmosphereModel(createAtmosphere({ mieScattering: [0, 0, 0], mieExtinction: [0, 0, 0], ozoneAbsorption: [0, 0, 0] }));
    const green = rayleighOnly.opticalDepth(0, p.planetRadius, 0, 0, 1, 0, p.atmosphereHeight, 256, rgb())[1]!;
    assert.ok(green > 0.09);
    assert.ok(green < 0.12);
  });

  test("gives a horizon air mass of ≈ √(πR/2H) ≈ 35 for the spherical exponential atmosphere", () => {
    const rayleighOnly = new AtmosphereModel(createAtmosphere({ mieScattering: [0, 0, 0], mieExtinction: [0, 0, 0], ozoneAbsorption: [0, 0, 0] }));
    const p = rayleighOnly.params;
    const zenith = rayleighOnly.transmittance(0, 0, 1, 0, rgb(), 512);
    const horizon = rayleighOnly.transmittance(0, 1, 0, 0, rgb(), 4096);
    const airMass = Math.log(horizon[1]!) / Math.log(zenith[1]!);
    const analytic = Math.sqrt((Math.PI * p.planetRadius) / (2 * p.rayleighScaleHeight));
    assert.ok(airMass > 30);
    assert.ok(airMass < 42);
    assert.ok(Math.abs(airMass / analytic - 1) < 0.15);
  });

  test("converges at low sample counts thanks to the cubic view-ray spacing (horizon blue survives)", () => {
    // A horizon ray is ~1000 km long; with uniform segments the first sample sits ~60 km out where
    // the blue channel is already extinguished, and 8×4 came out 10× too dark in blue.
    const sun = directionFromElevationAzimuth(66 * DEG, 180 * DEG);
    for (const el of [0.5, 6, 30]) {
      const dir = directionFromElevationAzimuth(el * DEG, 90 * DEG);
      const coarse = earth.skyRadiance(dir, sun, 0, rgb(), 8, 4).slice();
      const fine = earth.skyRadiance(dir, sun, 0, rgb(), 512, 32);
      for (let c = 0; c < 3; c++) {
        const ratio = coarse[c]! / fine[c]!;
        assert.ok(ratio > 0.6, `elevation ${el}° channel ${c}`);
        assert.ok(ratio < 1.1, `elevation ${el}° channel ${c}`);
      }
    }
  });

  test("estimates the hemispherical ambient within 25 % of a 4000-direction reference, dust lobe included", () => {
    const sun = directionFromElevationAzimuth(66 * DEG, 180 * DEG);
    const golden = Math.PI * (3 - Math.sqrt(5));
    for (const [name, model] of [
      ["earth", earth],
      ["mars", new AtmosphereModel(createAtmosphere({}, MARS_ATMOSPHERE))],
    ] as const) {
      const reference = [0, 0, 0];
      const n = 4000;
      const tmp = rgb();
      for (let i = 0; i < n; i++) {
        const u = (i + 0.5) / n;
        const dir = new Vec3(Math.sqrt(u) * Math.cos(i * golden), Math.sqrt(1 - u), Math.sqrt(u) * Math.sin(i * golden));
        model.skyRadiance(dir, sun, 0, tmp, 16, 8);
        for (let c = 0; c < 3; c++) reference[c]! += tmp[c]! / n;
      }
      const estimate = model.skyAmbient(sun, 0, rgb());
      for (let c = 0; c < 3; c++) assert.ok(Math.abs(estimate[c]! / reference[c]! - 1) < 0.25, `${name} channel ${c}`);
    }
  });

  test("makes a blue zenith at noon and a red horizon at sunset", () => {
    const noon = new Vec3(0.2, 0.9, 0.3).normalize();
    const zenith = earth.skyRadiance(UP, noon, 0, rgb(), 32, 16);
    assert.ok(zenith[2] > zenith[1]!);
    assert.ok(zenith[1] > zenith[0]!);
    assert.ok(zenith[2] > 0);
    const sunset = directionFromElevationAzimuth(0.5 * DEG, 270 * DEG);
    const towardSun = directionFromElevationAzimuth(1.5 * DEG, 270 * DEG);
    const horizon = earth.skyRadiance(towardSun, sunset, 0, rgb(), 64, 32);
    assert.ok(horizon[0] > horizon[2]!);
    assert.ok(horizon[0] > 0);
  });

  test("red-shifts and dims direct sunlight toward the horizon and blocks it below", () => {
    const high = earth.sunTransmittance(new Vec3(0, 1, 0), 0, rgb(), 64);
    assert.ok(high[0] > high[1]!);
    assert.ok(high[1] > high[2]!);
    assert.ok(high[0] > 0.85);
    assert.ok(high[2] > 0.6);
    const low = earth.sunTransmittance(directionFromElevationAzimuth(2 * DEG, 180 * DEG), 0, rgb(), 64);
    assert.ok(low[0] < high[0]!);
    assert.ok(low[0] / low[2]! > high[0]! / high[2]!);
    assert.ok(low[2] < 0.05);
    const below = earth.sunTransmittance(directionFromElevationAzimuth(-3 * DEG, 180 * DEG), 0, rgb(), 64);
    assert.equal(below[0], 0);
    // Higher observers see more sun: less air above them.
    const alpine = earth.sunTransmittance(directionFromElevationAzimuth(30 * DEG, 180 * DEG), 4000, rgb(), 64);
    const sea = earth.sunTransmittance(directionFromElevationAzimuth(30 * DEG, 180 * DEG), 0, rgb(), 64);
    assert.ok(alpine[2] > sea[2]!);
  });

  test("is symmetric in azimuth, dark when the sun is far below the horizon, and lit ground below the horizon", () => {
    const sun = directionFromElevationAzimuth(40 * DEG, 180 * DEG);
    const left = earth.skyRadiance(directionFromElevationAzimuth(20 * DEG, 120 * DEG), sun, 0, rgb());
    const right = earth.skyRadiance(directionFromElevationAzimuth(20 * DEG, 240 * DEG), sun, 0, rgb());
    for (let c = 0; c < 3; c++) assertCloseTo(left[c], right[c]!, 10);
    const night = directionFromElevationAzimuth(-30 * DEG, 0);
    const dark = earth.skyRadiance(UP, night, 0, rgb());
    assert.ok(Math.max(dark[0]!, dark[1]!, dark[2]!) < 1e-6);
    const ground = earth.skyRadiance(directionFromElevationAzimuth(-20 * DEG, 0), sun, 100, rgb());
    const sky = earth.skyRadiance(directionFromElevationAzimuth(20 * DEG, 0), sun, 100, rgb());
    assert.ok(ground[0] > 0);
    // Grey ground (albedo 0.1) is less blue than the sky above it.
    assert.ok(ground[2]! / ground[0]! < sky[2]! / sky[0]!);
  });

  test("produces an ambient and horizon colour that follow the sun", () => {
    const noon = directionFromElevationAzimuth(60 * DEG, 180 * DEG);
    const dusk = directionFromElevationAzimuth(-2 * DEG, 270 * DEG);
    const dayAmbient = earth.skyAmbient(noon, 0, rgb());
    const duskAmbient = earth.skyAmbient(dusk, 0, rgb());
    assert.ok(dayAmbient[2] > dayAmbient[0]!);
    assert.ok(dayAmbient[1] > 0.05);
    assert.ok(duskAmbient[1] < dayAmbient[1]! * 0.2);
    const horizon = earth.horizonColor(noon, 0, rgb());
    const zenith = earth.skyRadiance(UP, noon, 0, rgb(), 8, 4);
    // The horizon is brighter and whiter than the zenith (more air, more multiple-order Mie).
    assert.ok(horizon[0]! / horizon[2]! > zenith[0]! / zenith[2]!);
  });

  test("ships a Mars preset that reads butterscotch by day with a bright aureole around the sun", () => {
    const mars = new AtmosphereModel(createAtmosphere({}, MARS_ATMOSPHERE));
    const high = directionFromElevationAzimuth(50 * DEG, 180 * DEG);
    const day = mars.skyRadiance(directionFromElevationAzimuth(30 * DEG, 0), high, 0, rgb(), 32, 16);
    assert.ok(day[0] > day[1]!);
    assert.ok(day[1] > day[2]!);
    // Dust is strongly forward scattering: the sky 5° from the sun far outshines the sky 90° away.
    const nearSun = mars.skyRadiance(directionFromElevationAzimuth(45 * DEG, 180 * DEG), high, 0, rgb(), 32, 16);
    const awayFromSun = mars.skyRadiance(directionFromElevationAzimuth(50 * DEG, 90 * DEG), high, 0, rgb(), 32, 16);
    assert.ok(nearSun[0]! / awayFromSun[0]! > 5);
    // And a much darker sky overall than Earth's under the same sun (thin atmosphere).
    const earthDay = earth.skyRadiance(directionFromElevationAzimuth(30 * DEG, 0), high, 0, rgb(), 32, 16);
    assert.ok(day[2] < earthDay[2]!);
  });
});

group("fog", () => {
  const fog = { ...new Scene().settings.fog };

  test("linear and exp2 modes match their definitions", () => {
    assert.equal(fogTransmittance({ ...fog, mode: "none" }, 1e9, 0, 0), 1);
    assertCloseTo(fogTransmittance({ ...fog, mode: "linear", start: 10, end: 110 }, 60, 0, 0), 0.5, 9);
    assert.equal(fogTransmittance({ ...fog, mode: "linear", start: 10, end: 110 }, 5, 0, 0), 1);
    assert.equal(fogTransmittance({ ...fog, mode: "linear", start: 10, end: 110 }, 500, 0, 0), 0);
    assertCloseTo(fogTransmittance({ ...fog, mode: "exp2", density: 0.01 }, 100, 0, 0), Math.exp(-1), 9);
    assert.deepEqual(FOG_MODE_ID, { none: 0, linear: 1, exp2: 2, height: 3 });
  });

  test("height fog's closed form equals a brute-force integral of the exponential density", () => {
    const density = 0.02;
    const falloff = 0.15;
    const base = 5;
    const cases: [number, number, number][] = [
      [200, 2, 60],
      [200, 60, 2],
      [50, 10, 10.0001],
      [500, 0, 300],
      [120, 40, 0],
    ];
    for (const [distance, cameraY, surfaceY] of cases) {
      let numeric = 0;
      const n = 20000;
      for (let i = 0; i < n; i++) {
        const t = (i + 0.5) / n;
        const y = cameraY + (surfaceY - cameraY) * t;
        numeric += density * Math.exp(-falloff * (y - base)) * (distance / n);
      }
      assertCloseTo(heightFogOpticalDepth(distance, cameraY, surfaceY, density, falloff, base), numeric, 6);
      assertCloseTo(fogTransmittanceHeight(distance, cameraY, surfaceY, density, falloff, base), Math.exp(-numeric), 6);
    }
    // Fog pools: looking down into the layer is thicker than looking up out of it over the same distance.
    assert.ok(fogTransmittanceHeight(100, 50, 0, density, falloff, base) < fogTransmittanceHeight(100, 50, 100, density, falloff, base));
    assertCloseTo(fogTransmittance({ ...fog, mode: "height", density, heightFalloff: falloff, heightBase: base }, 100, 50, 0), fogTransmittanceHeight(100, 50, 0, density, falloff, base), 12);
  });
});

group("scene sky/fog settings", () => {
  test("round-trip through serialize/applySerialized, including a custom atmosphere", () => {
    const scene = new Scene({ name: "settings" });
    assert.equal(scene.settings.fog.mode, "none"); // fog is opt-in
    assert.equal(scene.settings.skyEnabled, true);
    scene.setFog("height", { density: 0.01, heightFalloff: 0.2, heightBase: 3 });
    scene.setSky({ sunDirection: new Vec3(3, 4, 0), quality: "high", turbidity: 5, atmosphere: createAtmosphere({ mieAnisotropy: 0.9 }, MARS_ATMOSPHERE) });
    assertCloseTo(scene.settings.sky.sunDirection!.x, 0.6, 9);
    const data = JSON.parse(JSON.stringify(scene.serialize()));
    const copy = new Scene({ name: "copy" });
    copy.setBackgroundColor(0x000000);
    assert.equal(copy.settings.skyEnabled, false);
    copy.applySerialized(data);
    assert.equal(copy.settings.skyEnabled, true);
    assert.equal(copy.settings.fog.mode, "height");
    assert.equal(copy.settings.fog.heightFalloff, 0.2);
    assert.equal(copy.settings.fog.heightBase, 3);
    assert.equal(copy.settings.sky.quality, "high");
    assert.equal(copy.settings.sky.turbidity, 5);
    assertCloseTo(copy.settings.sky.sunDirection!.y, 0.8, 9);
    assert.equal(copy.settings.sky.atmosphere?.mieAnisotropy, 0.9);
    assert.equal(copy.settings.sky.atmosphere?.planetRadius, MARS_ATMOSPHERE.planetRadius);
    // setBackgroundColor turns the sky off again; setSky() with no options turns it back on.
    copy.setBackgroundColor(0x112233);
    assert.equal(copy.settings.skyEnabled, false);
    copy.setSky();
    assert.equal(copy.settings.skyEnabled, true);
  });
});

group("DayNightCycle", () => {
  const makeScene = (): { scene: Scene; sun: Light } => {
    const scene = new Scene({ name: "cycle" });
    const sunEntity = scene.createTransformedEntity("sun", new Vec3(0, 10, 0));
    const sun = new Light();
    sun.kind = "directional";
    scene.world.addComponent(sunEntity.id, sun);
    return { scene, sun };
  };

  test("finds the directional light on attach and points it at the computed sun", () => {
    const { scene, sun } = makeScene();
    const cycle = new DayNightCycle({ latitude: 45, dayOfYear: 172, timeOfDay: 12, timeScale: 0 });
    scene.addObject(cycle);
    assert.equal(cycle.sun, sun);
    assert.equal(sun.followRotation, false);
    // Noon in June at 45°N: the sun is high and to the south (−Z is south, light travels toward −Y).
    assert.ok(cycle.elevationDeg > 60);
    assert.ok(sun.direction.y < -0.85);
    assertCloseTo(sun.direction.x, -cycle.sunDirection.x, 9);
    assertCloseTo(sun.direction.z, -cycle.sunDirection.z, 9);
    assertCloseTo(sun.intensity, cycle.sunIntensity, 6);
    assert.ok(sun.color.x > sun.color.z);
    assert.equal(scene.settings.skyEnabled, true);
    assert.notEqual(scene.settings.sky.sunDirection, null);
    assertCloseTo(scene.settings.sky.sunDirection!.y, cycle.sunDirection.y, 9);
  });

  test("turns the light off at night, keeps an ambient floor, and tints fog to the horizon", () => {
    const { scene, sun } = makeScene();
    scene.settings.fog.color.set(1, 0, 1);
    const cycle = new DayNightCycle({ latitude: 45, dayOfYear: 172, timeOfDay: 12, timeScale: 0 });
    scene.addObject(cycle);
    const dayAmbient = scene.settings.ambientColor.clone();
    const dayFog = scene.settings.fog.color.clone();
    assert.notEqual(dayFog.r, 1);
    assert.ok(dayAmbient.b > dayAmbient.r);
    cycle.setTime(1).apply();
    assert.equal(cycle.isDay, false);
    assert.equal(sun.intensity, 0);
    const night = scene.settings.ambientColor;
    assertCloseTo(night.r, cycle.nightAmbient.r, 9);
    assert.ok(night.g < dayAmbient.g);
    assert.ok(scene.settings.fog.color.g < dayFog.g);
  });

  test("advances by the fixed-step budget, so the result is frame-rate independent", async () => {
    const run = async (dt: number, frames: number): Promise<{ time: number; y: number; steps: number; simulated: number }> => {
      const engine = await Engine.create({ forceMock: true, clock: new ManualClock({ fixedDeltaTime: 1 / 60 }) });
      try {
        const { scene } = makeScene();
        const cycle = new DayNightCycle({ latitude: 30, dayOfYear: 100, timeOfDay: 6, timeScale: 600 });
        scene.addObject(cycle);
        engine.setScene(scene);
        engine.runFrames(frames, dt);
        return { time: cycle.timeOfDay, y: cycle.sunDirection.y, steps: engine.clock.fixedStepCount, simulated: cycle.simulatedSeconds };
      } finally {
        await engine.dispose();
      }
    };
    const fast = await run(1 / 60, 120);
    const slow = await run(1 / 30, 60);
    // Exactly the fixed steps the clock executed, scaled — never the wall clock or the frame count.
    assertCloseTo(fast.simulated, (fast.steps / 60) * 600, 6);
    assertCloseTo(slow.simulated, (slow.steps / 60) * 600, 6);
    // Both runs cover 2 s of engine time (≈ 20 simulated minutes, within one fixed step).
    assertCloseTo(fast.time, 6 + 20 / 60, 2);
    assertCloseTo(slow.time, 6 + 20 / 60, 2);
    assert.ok(Math.abs(slow.steps - fast.steps) <= 1);
    assertCloseTo(slow.y, fast.y, 2); // one fixed step (10 simulated s) moves the sun ~0.04°
  });

  test("wraps days and years and is idempotent for an instant", () => {
    const cycle = new DayNightCycle({ latitude: 10, year: 2023, dayOfYear: 365, timeOfDay: 23.5, timeScale: 0 });
    cycle.advance(3600);
    assert.equal(cycle.year, 2024);
    assert.equal(cycle.dayOfYear, 1);
    assertCloseTo(cycle.timeOfDay, 0.5, 9);
    cycle.advance(-7200);
    assert.equal(cycle.year, 2023);
    assert.equal(cycle.dayOfYear, 365);
    assertCloseTo(cycle.timeOfDay, 22.5, 9);
    cycle.apply();
    const a = cycle.sunDirection.clone();
    const first = cycle.stats();
    cycle.apply();
    assert.equal(cycle.sunDirection.x, a.x);
    assert.equal(cycle.sunDirection.y, a.y);
    assert.deepEqual(cycle.stats(), first);
    assert.equal(cycle.clockText, "22:30");
    // A clock that is frozen does not move in update.
    const fresh = new DayNightCycle({ timeScale: 0, timeOfDay: 9 });
    fresh.update({ fixedSteps: 3, fixedDt: 1 / 60 } as never);
    assert.equal(fresh.timeOfDay, 9);
  });

  test("respects an explicit sun light and the drive switches", () => {
    const { scene, sun } = makeScene();
    const other = new Light();
    other.kind = "directional";
    const before = scene.settings.ambientColor.clone();
    const cycle = new DayNightCycle({ sun: other, driveAmbient: false, driveFog: false, driveSky: false, timeScale: 0, timeOfDay: 12 });
    scene.addObject(cycle);
    assert.equal(cycle.sun, other);
    assert.equal(sun.followRotation, true);
    assert.equal(other.followRotation, false);
    assert.equal(scene.settings.ambientColor.r, before.r);
    assert.equal(scene.settings.sky.sunDirection, null);
    assert.equal(scene.settings.skyEnabled, true); // the scene default; the cycle did not touch it
    const atmo = new DayNightCycle({ atmosphere: MARS_ATMOSPHERE });
    assert.equal(atmo.atmosphere.params.planetRadius, MARS_ATMOSPHERE.planetRadius);
    const tweaked = new DayNightCycle({ atmosphere: { mieAnisotropy: 0.9 } });
    assert.equal(tweaked.atmosphere.params.mieAnisotropy, 0.9);
    assert.equal(tweaked.atmosphere.params.planetRadius, EARTH_ATMOSPHERE.planetRadius);
    assert.equal(defaultSkySettings().quality, "medium");
    assertCloseTo(new Color(0.02, 0.023, 0.032).r, cycle.nightAmbient.r, 9);
  });
});

await finish();
