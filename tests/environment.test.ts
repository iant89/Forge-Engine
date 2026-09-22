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

import { describe, expect, it } from "vitest";
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

describe("solar position (Meeus / NOAA)", () => {
  it("computes the Julian day of calendar dates (Meeus 7.a and J2000)", () => {
    expect(julianDay(1957, 10, 4.81)).toBeCloseTo(2436116.31, 2);
    expect(julianDay(2000, 1, 1, 12)).toBe(2451545);
    expect(julianDay(1992, 10, 13)).toBe(2448908.5);
    expect(julianDayFromDayOfYear(2000, 1)).toBe(2451544.5);
    expect(julianDayFromDayOfYear(2000, 366, 12)).toBe(julianDay(2000, 12, 31, 12));
    expect(daysInYear(2000)).toBe(366);
    expect(daysInYear(1900)).toBe(365);
    expect(daysInYear(2024)).toBe(366);
  });

  it("reproduces Meeus example 25.a: the sun on 1992 October 13, 0h TD", () => {
    const c = solarCoordinates(2448908.5);
    expect(c.rightAscension / DEG).toBeCloseTo(198.38083, 2);
    expect(c.declination / DEG).toBeCloseTo(-7.78507, 2);
    expect(c.distanceAu).toBeCloseTo(0.99766, 4);
    expect(c.apparentLongitude / DEG).toBeCloseTo(199.90895, 2);
  });

  it("reproduces Meeus example 28.a: the equation of time on 1992 October 13", () => {
    // Meeus: E = 3.427351° = 13m 42.6s (from the rigorous method; 28.3's series agrees to ~1 s).
    const c = solarCoordinates(2448908.5);
    expect(c.equationOfTime).toBeCloseTo(13.71, 1);
    // Extremes of the year (NOAA tables): ≈ −14.2 min around Feb 11, ≈ +16.4 min around Nov 3.
    expect(solarCoordinates(julianDay(2000, 2, 11)).equationOfTime).toBeGreaterThan(-14.5);
    expect(solarCoordinates(julianDay(2000, 2, 11)).equationOfTime).toBeLessThan(-14.0);
    expect(solarCoordinates(julianDay(2000, 11, 3)).equationOfTime).toBeGreaterThan(16.2);
    expect(solarCoordinates(julianDay(2000, 11, 3)).equationOfTime).toBeLessThan(16.6);
  });

  it("puts the declination at ±23.44° on the solstices and ~0 on the equinoxes", () => {
    expect(solarCoordinates(julianDay(2000, 6, 21, 2)).declination / DEG).toBeCloseTo(23.44, 1);
    expect(solarCoordinates(julianDay(2000, 12, 21, 14)).declination / DEG).toBeCloseTo(-23.44, 1);
    expect(Math.abs(solarCoordinates(julianDay(2000, 3, 20, 8)).declination / DEG)).toBeLessThan(0.05);
    expect(Math.abs(solarCoordinates(julianDay(2000, 9, 22, 18)).declination / DEG)).toBeLessThan(0.05);
  });

  it("gives the noon elevation 90° − |latitude − declination| and a due-south azimuth", () => {
    // Greenwich, June 21: solar noon is at 12:00 UTC minus the equation of time (~−1.7 min).
    const jd = julianDay(2000, 6, 21, 12 + 1.7 / 60);
    const p = solarPosition(jd, 51.48, 0, undefined, false);
    const expected = 90 - Math.abs(51.48 - p.declination / DEG);
    expect(p.trueElevation / DEG).toBeCloseTo(expected, 1);
    expect(p.azimuth / DEG).toBeCloseTo(180, 0);
    expect(Math.abs(p.hourAngle)).toBeLessThan(0.01);
    // Southern hemisphere at the same instant: the sun is due north.
    const south = solarPosition(jd, -33.9, 0, undefined, false);
    expect(south.azimuth / DEG).toBeCloseTo(0, 0);
  });

  it("rises in the north-east at 40°N in June and sets in the north-west", () => {
    const events = sunEvents(julianDay(2000, 6, 21), 40, 0);
    expect(events.sunrise).not.toBeNull();
    expect(events.sunset).not.toBeNull();
    const rise = solarPosition(julianDay(2000, 6, 21, events.sunrise!), 40, 0);
    const set = solarPosition(julianDay(2000, 6, 21, events.sunset!), 40, 0);
    // At the NOAA sunrise (zenith 90.833°) the refracted upper limb is on the horizon.
    expect(rise.trueElevation / DEG).toBeCloseTo(-0.833, 1);
    expect(set.trueElevation / DEG).toBeCloseTo(-0.833, 1);
    // Geometric sunrise azimuth ≈ acos(−sin δ / cos φ) ≈ 58.7°; the depressed horizon shifts it a little north.
    expect(rise.azimuth / DEG).toBeGreaterThan(56);
    expect(rise.azimuth / DEG).toBeLessThan(60);
    expect(set.azimuth / DEG).toBeGreaterThan(300);
    expect(set.azimuth / DEG).toBeLessThan(304);
    expect(events.dayLength).toBeGreaterThan(14.9);
    expect(events.dayLength).toBeLessThan(15.2);
  });

  it("gives ~18.9 h of daylight at 60°N on the June solstice and none at 80°N in December", () => {
    const june = sunEvents(julianDay(2000, 6, 21), 60, 0);
    expect(june.dayLength).toBeGreaterThan(18.6);
    expect(june.dayLength).toBeLessThan(19.1);
    const polarNight = sunEvents(julianDay(2000, 12, 21), 80, 0);
    expect(polarNight.sunrise).toBeNull();
    expect(polarNight.dayLength).toBe(0);
    const midnightSun = sunEvents(julianDay(2000, 6, 21), 80, 0);
    expect(midnightSun.sunrise).toBeNull();
    expect(midnightSun.dayLength).toBe(24);
    // And the sun really is up at local midnight there.
    expect(solarPosition(julianDay(2000, 6, 21, 0), 80, 0).elevation).toBeGreaterThan(0);
    // Solar noon moves 4 minutes per degree of longitude (east = earlier).
    const paris = sunEvents(julianDay(2000, 6, 21), 48.85, 2.35);
    expect((june.solarNoon - paris.solarNoon) * 60).toBeCloseTo(4 * 2.35, 0);
  });

  it("applies NOAA's refraction: ~34′ on the horizon, nothing near the zenith", () => {
    expect(atmosphericRefractionDeg(0) * 60).toBeCloseTo(28.9, 0);
    expect(atmosphericRefractionDeg(-0.5) * 60).toBeGreaterThan(30);
    expect(atmosphericRefractionDeg(10) * 60).toBeCloseTo(5.4, 0);
    expect(atmosphericRefractionDeg(89)).toBe(0);
    const p = solarPosition(julianDay(2000, 6, 21, 4), 51.48, 0);
    expect(p.elevation).toBeGreaterThan(p.trueElevation);
  });

  it("maps elevation/azimuth to engine axes: +Y up, north = +Z, east = +X", () => {
    const east = directionFromElevationAzimuth(0, 90 * DEG);
    expect(east.x).toBeCloseTo(1, 6);
    expect(east.z).toBeCloseTo(0, 6);
    const north = directionFromElevationAzimuth(0, 0);
    expect(north.z).toBeCloseTo(1, 6);
    const up = directionFromElevationAzimuth(90 * DEG, 123 * DEG);
    expect(up.y).toBeCloseTo(1, 6);
    // Round trip through the inverse.
    const [el, az] = elevationAzimuthOf(directionFromElevationAzimuth(37 * DEG, 250 * DEG));
    expect(el / DEG).toBeCloseTo(37, 5);
    expect(az / DEG).toBeCloseTo(250, 5);
    // A summer morning in the northern hemisphere: sun east-ish and up.
    const morning = sunDirection(solarPosition(julianDay(2000, 6, 21, 8), 45, 0));
    expect(morning.x).toBeGreaterThan(0.3);
    expect(morning.y).toBeGreaterThan(0.3);
    expect(morning.length()).toBeCloseTo(1, 6);
  });
});

describe("atmosphere model", () => {
  const earth = new AtmosphereModel(createAtmosphere());
  const UP = new Vec3(0, 1, 0);

  it("derives Bruneton's Rayleigh table (5.802, 13.558, 33.1 ×10⁻⁶/m) from the scattering formula", () => {
    const [r, g, b] = EARTH_ATMOSPHERE.rayleighScattering;
    expect(rayleighCoefficient(680) / r).toBeCloseTo(1, 1);
    expect(rayleighCoefficient(550) / g).toBeCloseTo(1, 1);
    expect(rayleighCoefficient(440) / b).toBeCloseTo(1, 1);
    expect(Math.abs(rayleighCoefficient(550) / g - 1)).toBeLessThan(0.01);
    // λ⁻⁴: blue scatters ~5.7× more than red.
    expect(rayleighCoefficient(440) / rayleighCoefficient(680)).toBeCloseTo((680 / 440) ** 4, 6);
  });

  it("normalises both phase functions over the sphere", () => {
    const integrate = (f: (c: number) => number): number => {
      let sum = 0;
      const n = 20000;
      for (let i = 0; i < n; i++) {
        const c = -1 + (2 * (i + 0.5)) / n;
        sum += f(c) * (2 / n);
      }
      return sum * 2 * Math.PI;
    };
    expect(integrate(rayleighPhase)).toBeCloseTo(1, 4);
    expect(integrate((c) => miePhase(c, 0.76))).toBeCloseTo(1, 3);
    expect(integrate((c) => miePhase(c, 0))).toBeCloseTo(1, 4);
    expect(integrate((c) => henyeyGreensteinPhase(c, 0.8))).toBeCloseTo(1, 3);
    // Forward peaked: a forward Mie lobe is orders of magnitude above the backward one.
    expect(miePhase(1, 0.76) / miePhase(-1, 0.76)).toBeGreaterThan(100);
  });

  it("matches the closed-form vertical optical depth β·H (≈ 0.108 in the green)", () => {
    const p = earth.params;
    const od = earth.opticalDepth(0, p.planetRadius, 0, 0, 1, 0, p.atmosphereHeight, 256, rgb());
    const H = p.rayleighScaleHeight;
    const rayleighColumn = H * (1 - Math.exp(-p.atmosphereHeight / H));
    const mieColumn = p.mieScaleHeight * (1 - Math.exp(-p.atmosphereHeight / p.mieScaleHeight));
    const ozoneColumn = p.ozoneWidth; // tent of half-width w integrates to w
    for (let c = 0; c < 3; c++) {
      const expected = p.rayleighScattering[c]! * rayleighColumn + p.mieExtinction[c]! * mieColumn + p.ozoneAbsorption[c]! * ozoneColumn;
      expect(od[c]! / expected).toBeCloseTo(1, 2);
    }
    // Rayleigh-only zenith depth in the green is the textbook ~0.1.
    const rayleighOnly = new AtmosphereModel(createAtmosphere({ mieScattering: [0, 0, 0], mieExtinction: [0, 0, 0], ozoneAbsorption: [0, 0, 0] }));
    const green = rayleighOnly.opticalDepth(0, p.planetRadius, 0, 0, 1, 0, p.atmosphereHeight, 256, rgb())[1]!;
    expect(green).toBeGreaterThan(0.09);
    expect(green).toBeLessThan(0.12);
  });

  it("gives a horizon air mass of ≈ √(πR/2H) ≈ 35 for the spherical exponential atmosphere", () => {
    const rayleighOnly = new AtmosphereModel(createAtmosphere({ mieScattering: [0, 0, 0], mieExtinction: [0, 0, 0], ozoneAbsorption: [0, 0, 0] }));
    const p = rayleighOnly.params;
    const zenith = rayleighOnly.transmittance(0, 0, 1, 0, rgb(), 512);
    const horizon = rayleighOnly.transmittance(0, 1, 0, 0, rgb(), 4096);
    const airMass = Math.log(horizon[1]!) / Math.log(zenith[1]!);
    const analytic = Math.sqrt((Math.PI * p.planetRadius) / (2 * p.rayleighScaleHeight));
    expect(airMass).toBeGreaterThan(30);
    expect(airMass).toBeLessThan(42);
    expect(Math.abs(airMass / analytic - 1)).toBeLessThan(0.15);
  });

  it("converges at low sample counts thanks to the cubic view-ray spacing (horizon blue survives)", () => {
    // A horizon ray is ~1000 km long; with uniform segments the first sample sits ~60 km out where
    // the blue channel is already extinguished, and 8×4 came out 10× too dark in blue.
    const sun = directionFromElevationAzimuth(66 * DEG, 180 * DEG);
    for (const el of [0.5, 6, 30]) {
      const dir = directionFromElevationAzimuth(el * DEG, 90 * DEG);
      const coarse = earth.skyRadiance(dir, sun, 0, rgb(), 8, 4).slice();
      const fine = earth.skyRadiance(dir, sun, 0, rgb(), 512, 32);
      for (let c = 0; c < 3; c++) {
        const ratio = coarse[c]! / fine[c]!;
        expect(ratio, `elevation ${el}° channel ${c}`).toBeGreaterThan(0.6);
        expect(ratio, `elevation ${el}° channel ${c}`).toBeLessThan(1.1);
      }
    }
  });

  it("estimates the hemispherical ambient within 25 % of a 4000-direction reference, dust lobe included", () => {
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
      for (let c = 0; c < 3; c++) expect(Math.abs(estimate[c]! / reference[c]! - 1), `${name} channel ${c}`).toBeLessThan(0.25);
    }
  });

  it("makes a blue zenith at noon and a red horizon at sunset", () => {
    const noon = new Vec3(0.2, 0.9, 0.3).normalize();
    const zenith = earth.skyRadiance(UP, noon, 0, rgb(), 32, 16);
    expect(zenith[2]).toBeGreaterThan(zenith[1]!);
    expect(zenith[1]).toBeGreaterThan(zenith[0]!);
    expect(zenith[2]).toBeGreaterThan(0);
    const sunset = directionFromElevationAzimuth(0.5 * DEG, 270 * DEG);
    const towardSun = directionFromElevationAzimuth(1.5 * DEG, 270 * DEG);
    const horizon = earth.skyRadiance(towardSun, sunset, 0, rgb(), 64, 32);
    expect(horizon[0]).toBeGreaterThan(horizon[2]!);
    expect(horizon[0]).toBeGreaterThan(0);
  });

  it("red-shifts and dims direct sunlight toward the horizon and blocks it below", () => {
    const high = earth.sunTransmittance(new Vec3(0, 1, 0), 0, rgb(), 64);
    expect(high[0]).toBeGreaterThan(high[1]!);
    expect(high[1]).toBeGreaterThan(high[2]!);
    expect(high[0]).toBeGreaterThan(0.85);
    expect(high[2]).toBeGreaterThan(0.6);
    const low = earth.sunTransmittance(directionFromElevationAzimuth(2 * DEG, 180 * DEG), 0, rgb(), 64);
    expect(low[0]).toBeLessThan(high[0]!);
    expect(low[0] / low[2]!).toBeGreaterThan(high[0]! / high[2]!);
    expect(low[2]).toBeLessThan(0.05);
    const below = earth.sunTransmittance(directionFromElevationAzimuth(-3 * DEG, 180 * DEG), 0, rgb(), 64);
    expect(below[0]).toBe(0);
    // Higher observers see more sun: less air above them.
    const alpine = earth.sunTransmittance(directionFromElevationAzimuth(30 * DEG, 180 * DEG), 4000, rgb(), 64);
    const sea = earth.sunTransmittance(directionFromElevationAzimuth(30 * DEG, 180 * DEG), 0, rgb(), 64);
    expect(alpine[2]).toBeGreaterThan(sea[2]!);
  });

  it("is symmetric in azimuth, dark when the sun is far below the horizon, and lit ground below the horizon", () => {
    const sun = directionFromElevationAzimuth(40 * DEG, 180 * DEG);
    const left = earth.skyRadiance(directionFromElevationAzimuth(20 * DEG, 120 * DEG), sun, 0, rgb());
    const right = earth.skyRadiance(directionFromElevationAzimuth(20 * DEG, 240 * DEG), sun, 0, rgb());
    for (let c = 0; c < 3; c++) expect(left[c]).toBeCloseTo(right[c]!, 10);
    const night = directionFromElevationAzimuth(-30 * DEG, 0);
    const dark = earth.skyRadiance(UP, night, 0, rgb());
    expect(Math.max(dark[0]!, dark[1]!, dark[2]!)).toBeLessThan(1e-6);
    const ground = earth.skyRadiance(directionFromElevationAzimuth(-20 * DEG, 0), sun, 100, rgb());
    const sky = earth.skyRadiance(directionFromElevationAzimuth(20 * DEG, 0), sun, 100, rgb());
    expect(ground[0]).toBeGreaterThan(0);
    // Grey ground (albedo 0.1) is less blue than the sky above it.
    expect(ground[2]! / ground[0]!).toBeLessThan(sky[2]! / sky[0]!);
  });

  it("produces an ambient and horizon colour that follow the sun", () => {
    const noon = directionFromElevationAzimuth(60 * DEG, 180 * DEG);
    const dusk = directionFromElevationAzimuth(-2 * DEG, 270 * DEG);
    const dayAmbient = earth.skyAmbient(noon, 0, rgb());
    const duskAmbient = earth.skyAmbient(dusk, 0, rgb());
    expect(dayAmbient[2]).toBeGreaterThan(dayAmbient[0]!);
    expect(dayAmbient[1]).toBeGreaterThan(0.05);
    expect(duskAmbient[1]).toBeLessThan(dayAmbient[1]! * 0.2);
    const horizon = earth.horizonColor(noon, 0, rgb());
    const zenith = earth.skyRadiance(UP, noon, 0, rgb(), 8, 4);
    // The horizon is brighter and whiter than the zenith (more air, more multiple-order Mie).
    expect(horizon[0]! / horizon[2]!).toBeGreaterThan(zenith[0]! / zenith[2]!);
  });

  it("ships a Mars preset that reads butterscotch by day with a bright aureole around the sun", () => {
    const mars = new AtmosphereModel(createAtmosphere({}, MARS_ATMOSPHERE));
    const high = directionFromElevationAzimuth(50 * DEG, 180 * DEG);
    const day = mars.skyRadiance(directionFromElevationAzimuth(30 * DEG, 0), high, 0, rgb(), 32, 16);
    expect(day[0]).toBeGreaterThan(day[1]!);
    expect(day[1]).toBeGreaterThan(day[2]!);
    // Dust is strongly forward scattering: the sky 5° from the sun far outshines the sky 90° away.
    const nearSun = mars.skyRadiance(directionFromElevationAzimuth(45 * DEG, 180 * DEG), high, 0, rgb(), 32, 16);
    const awayFromSun = mars.skyRadiance(directionFromElevationAzimuth(50 * DEG, 90 * DEG), high, 0, rgb(), 32, 16);
    expect(nearSun[0]! / awayFromSun[0]!).toBeGreaterThan(5);
    // And a much darker sky overall than Earth's under the same sun (thin atmosphere).
    const earthDay = earth.skyRadiance(directionFromElevationAzimuth(30 * DEG, 0), high, 0, rgb(), 32, 16);
    expect(day[2]).toBeLessThan(earthDay[2]!);
  });
});

describe("fog", () => {
  const fog = { ...new Scene().settings.fog };

  it("linear and exp2 modes match their definitions", () => {
    expect(fogTransmittance({ ...fog, mode: "none" }, 1e9, 0, 0)).toBe(1);
    expect(fogTransmittance({ ...fog, mode: "linear", start: 10, end: 110 }, 60, 0, 0)).toBeCloseTo(0.5, 9);
    expect(fogTransmittance({ ...fog, mode: "linear", start: 10, end: 110 }, 5, 0, 0)).toBe(1);
    expect(fogTransmittance({ ...fog, mode: "linear", start: 10, end: 110 }, 500, 0, 0)).toBe(0);
    expect(fogTransmittance({ ...fog, mode: "exp2", density: 0.01 }, 100, 0, 0)).toBeCloseTo(Math.exp(-1), 9);
    expect(FOG_MODE_ID).toEqual({ none: 0, linear: 1, exp2: 2, height: 3 });
  });

  it("height fog's closed form equals a brute-force integral of the exponential density", () => {
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
      expect(heightFogOpticalDepth(distance, cameraY, surfaceY, density, falloff, base)).toBeCloseTo(numeric, 6);
      expect(fogTransmittanceHeight(distance, cameraY, surfaceY, density, falloff, base)).toBeCloseTo(Math.exp(-numeric), 6);
    }
    // Fog pools: looking down into the layer is thicker than looking up out of it over the same distance.
    expect(fogTransmittanceHeight(100, 50, 0, density, falloff, base)).toBeLessThan(fogTransmittanceHeight(100, 50, 100, density, falloff, base));
    expect(fogTransmittance({ ...fog, mode: "height", density, heightFalloff: falloff, heightBase: base }, 100, 50, 0)).toBeCloseTo(fogTransmittanceHeight(100, 50, 0, density, falloff, base), 12);
  });
});

describe("scene sky/fog settings", () => {
  it("round-trip through serialize/applySerialized, including a custom atmosphere", () => {
    const scene = new Scene({ name: "settings" });
    expect(scene.settings.fog.mode).toBe("none"); // fog is opt-in
    expect(scene.settings.skyEnabled).toBe(true);
    scene.setFog("height", { density: 0.01, heightFalloff: 0.2, heightBase: 3 });
    scene.setSky({ sunDirection: new Vec3(3, 4, 0), quality: "high", turbidity: 5, atmosphere: createAtmosphere({ mieAnisotropy: 0.9 }, MARS_ATMOSPHERE) });
    expect(scene.settings.sky.sunDirection!.x).toBeCloseTo(0.6, 9);
    const data = JSON.parse(JSON.stringify(scene.serialize()));
    const copy = new Scene({ name: "copy" });
    copy.setBackgroundColor(0x000000);
    expect(copy.settings.skyEnabled).toBe(false);
    copy.applySerialized(data);
    expect(copy.settings.skyEnabled).toBe(true);
    expect(copy.settings.fog.mode).toBe("height");
    expect(copy.settings.fog.heightFalloff).toBe(0.2);
    expect(copy.settings.fog.heightBase).toBe(3);
    expect(copy.settings.sky.quality).toBe("high");
    expect(copy.settings.sky.turbidity).toBe(5);
    expect(copy.settings.sky.sunDirection!.y).toBeCloseTo(0.8, 9);
    expect(copy.settings.sky.atmosphere?.mieAnisotropy).toBe(0.9);
    expect(copy.settings.sky.atmosphere?.planetRadius).toBe(MARS_ATMOSPHERE.planetRadius);
    // setBackgroundColor turns the sky off again; setSky() with no options turns it back on.
    copy.setBackgroundColor(0x112233);
    expect(copy.settings.skyEnabled).toBe(false);
    copy.setSky();
    expect(copy.settings.skyEnabled).toBe(true);
  });
});

describe("DayNightCycle", () => {
  const makeScene = (): { scene: Scene; sun: Light } => {
    const scene = new Scene({ name: "cycle" });
    const sunEntity = scene.createTransformedEntity("sun", new Vec3(0, 10, 0));
    const sun = new Light();
    sun.kind = "directional";
    scene.world.addComponent(sunEntity.id, sun);
    return { scene, sun };
  };

  it("finds the directional light on attach and points it at the computed sun", () => {
    const { scene, sun } = makeScene();
    const cycle = new DayNightCycle({ latitude: 45, dayOfYear: 172, timeOfDay: 12, timeScale: 0 });
    scene.addObject(cycle);
    expect(cycle.sun).toBe(sun);
    expect(sun.followRotation).toBe(false);
    // Noon in June at 45°N: the sun is high and to the south (−Z is south, light travels toward −Y).
    expect(cycle.elevationDeg).toBeGreaterThan(60);
    expect(sun.direction.y).toBeLessThan(-0.85);
    expect(sun.direction.x).toBeCloseTo(-cycle.sunDirection.x, 9);
    expect(sun.direction.z).toBeCloseTo(-cycle.sunDirection.z, 9);
    expect(sun.intensity).toBeCloseTo(cycle.sunIntensity, 6);
    expect(sun.color.x).toBeGreaterThan(sun.color.z);
    expect(scene.settings.skyEnabled).toBe(true);
    expect(scene.settings.sky.sunDirection).not.toBeNull();
    expect(scene.settings.sky.sunDirection!.y).toBeCloseTo(cycle.sunDirection.y, 9);
  });

  it("turns the light off at night, keeps an ambient floor, and tints fog to the horizon", () => {
    const { scene, sun } = makeScene();
    scene.settings.fog.color.set(1, 0, 1);
    const cycle = new DayNightCycle({ latitude: 45, dayOfYear: 172, timeOfDay: 12, timeScale: 0 });
    scene.addObject(cycle);
    const dayAmbient = scene.settings.ambientColor.clone();
    const dayFog = scene.settings.fog.color.clone();
    expect(dayFog.r).not.toBe(1);
    expect(dayAmbient.b).toBeGreaterThan(dayAmbient.r);
    cycle.setTime(1).apply();
    expect(cycle.isDay).toBe(false);
    expect(sun.intensity).toBe(0);
    const night = scene.settings.ambientColor;
    expect(night.r).toBeCloseTo(cycle.nightAmbient.r, 9);
    expect(night.g).toBeLessThan(dayAmbient.g);
    expect(scene.settings.fog.color.g).toBeLessThan(dayFog.g);
  });

  it("advances by the fixed-step budget, so the result is frame-rate independent", async () => {
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
    expect(fast.simulated).toBeCloseTo((fast.steps / 60) * 600, 6);
    expect(slow.simulated).toBeCloseTo((slow.steps / 60) * 600, 6);
    // Both runs cover 2 s of engine time (≈ 20 simulated minutes, within one fixed step).
    expect(fast.time).toBeCloseTo(6 + 20 / 60, 2);
    expect(slow.time).toBeCloseTo(6 + 20 / 60, 2);
    expect(Math.abs(slow.steps - fast.steps)).toBeLessThanOrEqual(1);
    expect(slow.y).toBeCloseTo(fast.y, 2); // one fixed step (10 simulated s) moves the sun ~0.04°
  });

  it("wraps days and years and is idempotent for an instant", () => {
    const cycle = new DayNightCycle({ latitude: 10, year: 2023, dayOfYear: 365, timeOfDay: 23.5, timeScale: 0 });
    cycle.advance(3600);
    expect(cycle.year).toBe(2024);
    expect(cycle.dayOfYear).toBe(1);
    expect(cycle.timeOfDay).toBeCloseTo(0.5, 9);
    cycle.advance(-7200);
    expect(cycle.year).toBe(2023);
    expect(cycle.dayOfYear).toBe(365);
    expect(cycle.timeOfDay).toBeCloseTo(22.5, 9);
    cycle.apply();
    const a = cycle.sunDirection.clone();
    const first = cycle.stats();
    cycle.apply();
    expect(cycle.sunDirection.x).toBe(a.x);
    expect(cycle.sunDirection.y).toBe(a.y);
    expect(cycle.stats()).toEqual(first);
    expect(cycle.clockText).toBe("22:30");
    // A clock that is frozen does not move in update.
    const fresh = new DayNightCycle({ timeScale: 0, timeOfDay: 9 });
    fresh.update({ fixedSteps: 3, fixedDt: 1 / 60 } as never);
    expect(fresh.timeOfDay).toBe(9);
  });

  it("respects an explicit sun light and the drive switches", () => {
    const { scene, sun } = makeScene();
    const other = new Light();
    other.kind = "directional";
    const before = scene.settings.ambientColor.clone();
    const cycle = new DayNightCycle({ sun: other, driveAmbient: false, driveFog: false, driveSky: false, timeScale: 0, timeOfDay: 12 });
    scene.addObject(cycle);
    expect(cycle.sun).toBe(other);
    expect(sun.followRotation).toBe(true);
    expect(other.followRotation).toBe(false);
    expect(scene.settings.ambientColor.r).toBe(before.r);
    expect(scene.settings.sky.sunDirection).toBeNull();
    expect(scene.settings.skyEnabled).toBe(true); // the scene default; the cycle did not touch it
    const atmo = new DayNightCycle({ atmosphere: MARS_ATMOSPHERE });
    expect(atmo.atmosphere.params.planetRadius).toBe(MARS_ATMOSPHERE.planetRadius);
    const tweaked = new DayNightCycle({ atmosphere: { mieAnisotropy: 0.9 } });
    expect(tweaked.atmosphere.params.mieAnisotropy).toBe(0.9);
    expect(tweaked.atmosphere.params.planetRadius).toBe(EARTH_ATMOSPHERE.planetRadius);
    expect(defaultSkySettings().quality).toBe("medium");
    expect(new Color(0.02, 0.023, 0.032).r).toBeCloseTo(cycle.nightAmbient.r, 9);
  });
});
