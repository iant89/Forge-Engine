/**
 * @suite environment:planetOrbit
 * @group unit
 * @covers engine/src/environment/planetFrame.ts
 * @covers engine/src/environment/planetSpin.ts
 * @covers engine/src/environment/planetWeather.ts
 * @covers engine/src/environment/atmosphere.ts
 * @covers engine/src/environment/dayNight.ts
 * @covers engine/src/terrain/mars/globeSampler.ts
 * @covers engine/src/particles/dustDevilField.ts
 * @covers engine/src/rendering/planetGlobe.ts
 * @desc fe-39: planet frames and calendar, the globe spin controller, the planet weather system, the sky aureole lobe, the external sun, the Mars globe sampler, the dust-devil field and the progressive globe
 */

export const suite = {
  name: "environment:planetOrbit",
  group: "unit",
  covers: [
    "engine/src/environment/planetFrame.ts",
    "engine/src/environment/planetSpin.ts",
    "engine/src/environment/planetWeather.ts",
    "engine/src/environment/atmosphere.ts",
    "engine/src/environment/dayNight.ts",
    "engine/src/terrain/mars/globeSampler.ts",
    "engine/src/particles/dustDevilField.ts",
    "engine/src/rendering/planetGlobe.ts",
  ],
  desc: "fe-39: planet frames and calendar, the globe spin controller, the planet weather system, the sky aureole lobe, the external sun, the Mars globe sampler, the dust-devil field and the progressive globe",
};
/**
 * The reusable planet-viewer systems behind `?scene=mars-orbit`. Real pixels are the browser
 * gate's job; this suite pins the maths and the state machines on the strict mock device.
 */
import assert from "node:assert/strict";
import { afterEach, assertCloseTo, finish, group, test } from "selrun";
import {
  AtmosphereModel,
  DayNightCycle,
  DustDevilField,
  GraphicsDevice,
  MARS_ATMOSPHERE,
  MARS_ORBIT,
  PlanetPolarCaps,
  PlanetGlobe,
  PlanetSpinController,
  PlanetWeatherSystem,
  Quat,
  Scene,
  Vec3,
  createAtmosphere,
  createMarsGlobeSampler,
  createPlanetWeatherSample,
  directionToLatLon,
  latLonToDirection,
  localSolarHours,
  mieChannelPhase,
  pickPlanetDirection,
  planetEventEnvelope,
  planetGroundWeather,
  planetOrientationForSite,
  planetSiteBasis,
  planetSunDirection,
  rotateByQuat,
  solarLongitudeDeg,
  solsForLocalHours,
  solsForSolarLongitude,
  wrapLongitudeDeg,
  type PlanetWeatherEventDef,
  type SystemContext,
} from "@forge/engine";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

const close = (a: number, b: number, eps = 1e-6, msg = ""): void => assertCloseTo(a, b, eps, msg);

group("planetFrame: directions, site frames, picking", () => {
  test("latitude/longitude round-trip and the documented axes", () => {
    const d = latLonToDirection(0, 0, new Vec3());
    close(d.x, 1); close(d.y, 0); close(d.z, 0);
    const east = latLonToDirection(0, 90, new Vec3());
    close(east.z, 1); // longitude increases toward +Z
    const pole = latLonToDirection(90, 0, new Vec3());
    close(pole.y, 1);
    const back = directionToLatLon(latLonToDirection(-33.5, 141.25, new Vec3()), { latDeg: 0, lonDeg: 0 });
    close(back.latDeg, -33.5, 1e-9); close(back.lonDeg, 141.25, 1e-9);
    close(wrapLongitudeDeg(190), -170); close(wrapLongitudeDeg(-190), 170);
  });

  test("the site orientation puts east on +X, up on +Y and north on +Z", () => {
    for (const [lat, lon] of [[0, 0], [30, 100], [-45, -120], [75, 10]] as const) {
      const b = planetSiteBasis(lat, lon, 0);
      const q = planetOrientationForSite(lat, lon, 0, new Quat());
      const e = rotateByQuat(q, b.east, new Vec3());
      const u = rotateByQuat(q, b.up, new Vec3());
      const n = rotateByQuat(q, b.north, new Vec3());
      close(e.x, 1, 1e-5); close(u.y, 1, 1e-5); close(n.z, 1, 1e-5);
    }
  });

  test("picking hits the near side of the sphere and clamps a miss to the silhouette", () => {
    const R = 3389.5e3;
    const centre = new Vec3(0, -R, 0);
    const out = new Vec3();
    assert.equal(pickPlanetDirection(new Vec3(0, 900e3, 0), new Vec3(0, -1, 0), centre, R, out), true);
    close(out.y, 1, 1e-9);
    // A ray that grazes far to the side misses but still yields a unit direction on the limb.
    const hit = pickPlanetDirection(new Vec3(0, 900e3, 0), new Vec3(Math.sin(1.2), -Math.cos(1.2), 0), centre, R, out);
    assert.equal(hit, false);
    close(Math.hypot(out.x, out.y, out.z), 1, 1e-9);
  });
});

group("planetFrame: the calendar", () => {
  test("Ls is 0 at the equinox, monotone, and inverted by solsForSolarLongitude", () => {
    close(solarLongitudeDeg(MARS_ORBIT, 0), 0, 1e-6);
    let prev = -1;
    for (let s = 0; s < MARS_ORBIT.yearSols; s += 20) {
      const ls = solarLongitudeDeg(MARS_ORBIT, s);
      assert.ok(ls > prev, "Ls rises through the year");
      prev = ls;
    }
    for (const target of [30, 90, 180, 251, 330]) {
      close(solarLongitudeDeg(MARS_ORBIT, solsForSolarLongitude(MARS_ORBIT, target)), target, 1e-4);
    }
  });

  test("local solar time follows longitude and scrubbing keeps the season", () => {
    const sols = 200.3;
    const lon = -60;
    const h = localSolarHours(lon, sols);
    const target = (h + 5) % 24;
    const next = solsForLocalHours(lon, target, sols);
    close(localSolarHours(lon, next), target, 1e-6);
    assert.ok(Math.abs(next - sols) <= 1, "stays within a sol of the input");
    // Noon is when the longitude is under the sun.
    const sun = planetSunDirection(MARS_ORBIT, sols, new Vec3());
    const ll = directionToLatLon(sun, { latDeg: 0, lonDeg: 0 });
    close(localSolarHours(ll.lonDeg, sols), 12, 1e-6);
  });
});

group("PlanetSpinController: drag, inertia, auto-spin, animation", () => {
  const worldDirOf = (spin: PlanetSpinController, lat: number, lon: number): Vec3 =>
    rotateByQuat(spin.orientation, latLonToDirection(lat, lon, new Vec3()), new Vec3()) as Vec3;

  test("a dragged point follows the pointer", () => {
    const spin = new PlanetSpinController({ autoSpinRadPerSecond: 0 });
    const grab = worldDirOf(spin, 0, 0);
    spin.beginDrag(grab);
    const to = new Vec3(Math.sin(0.4), Math.cos(0.4), 0).normalize();
    const tz = new Vec3(grab.x, grab.y, grab.z);
    spin.dragTo(tz, 0.016);
    spin.dragTo(to, 0.016);
    const now = worldDirOf(spin, 0, 0);
    assert.ok(now.dot(to) > 0.9999, `the grabbed point is under the pointer (${now.dot(to)})`);
    assert.equal(spin.phase, "drag");
  });

  test("a throw coasts and comes to rest; a held pointer throws nothing", () => {
    const spin = new PlanetSpinController({ autoSpinRadPerSecond: 0 });
    spin.autoSpinEnabled = false;
    spin.beginDrag(new Vec3(0, 1, 0));
    let a = 0;
    for (let i = 0; i < 6; i++) {
      a += 0.05;
      spin.dragTo(new Vec3(Math.sin(a), Math.cos(a), 0), 0.016);
    }
    spin.endDrag();
    assert.equal(spin.phase, "inertia");
    for (let i = 0; i < 60 * 20; i++) spin.update(1 / 60);
    assert.equal(spin.phase, "idle-wait");

    const held = new PlanetSpinController({ autoSpinRadPerSecond: 0 });
    held.autoSpinEnabled = false;
    held.beginDrag(new Vec3(0, 1, 0));
    held.dragTo(new Vec3(0, 1, 0), 0.016);
    held.dragTo(new Vec3(Math.sin(0.1), Math.cos(0.1), 0), 0.016);
    held.update(0.5);
    held.endDrag();
    assert.equal(held.inertiaSpeed, 0);
  });

  test("auto-spin resumes after the idle delay and turns eastward", () => {
    const spin = new PlanetSpinController({ idleDelaySeconds: 4, resumeRampSeconds: 1, autoSpinRadPerSecond: 0.2 });
    // Look down on the equator (the pole is then a horizontal axis, so longitude under the camera is defined).
    spin.setOrientation(planetOrientationForSite(0, 0, 0, new Quat()));
    spin.touch();
    for (let i = 0; i < 60 * 3; i++) spin.update(1 / 60);
    assert.equal(spin.phase, "idle-wait", "still waiting at 3 s");
    for (let i = 0; i < 60 * 3; i++) spin.update(1 / 60);
    assert.equal(spin.phase, "auto", "turning again by 6 s");
    // The planet turns eastward like Mars does, so features slide east (screen-right) and the longitude
    // under the camera falls by the spin angle.
    const planetDirUnderCamera = (): { latDeg: number; lonDeg: number } => {
      const inv = new Quat(-spin.orientation.x, -spin.orientation.y, -spin.orientation.z, spin.orientation.w);
      return directionToLatLon(rotateByQuat(inv, new Vec3(0, 1, 0), new Vec3()), { latDeg: 0, lonDeg: 0 });
    };
    const lon0 = planetDirUnderCamera().lonDeg;
    for (let i = 0; i < 60; i++) spin.update(1 / 60);
    const dLon = wrapLongitudeDeg(planetDirUnderCamera().lonDeg - lon0);
    close(dLon, -0.2 * (180 / Math.PI), 0.5, "the surface moves east under the camera at the spin rate");
  });

  test("animateTo eases to the target and calls done once", () => {
    const spin = new PlanetSpinController();
    const target = planetOrientationForSite(20, 40, 0, new Quat());
    let done = 0;
    spin.animateTo(target, 1, () => done++);
    assert.equal(spin.phase, "animating");
    for (let i = 0; i < 90; i++) spin.update(1 / 60);
    assert.equal(done, 1);
    const o = spin.orientation;
    close(Math.abs(o.x * target.x + o.y * target.y + o.z * target.z + o.w * target.w), 1, 1e-6);
  });
});

const EVENTS: PlanetWeatherEventDef[] = [
  { id: "storm", kind: "dust-storm", latDeg: -40, lonDeg: 70, radiusKm: 1500, startLs: 200, endLs: 260, peak: 0.9, driftLonDegPerSol: 0.05 },
  { id: "hood", kind: "ice-cloud", latDeg: 72, lonDeg: 0, radiusKm: 900, band: true, startLs: 330, endLs: 40, peak: 0.8 },
  { id: "devils", kind: "dust-devils", latDeg: 20, lonDeg: -100, radiusKm: 1800, startLs: 100, endLs: 200, peak: 0.7, diurnal: 1 },
  { id: "frost", kind: "frost", latDeg: -45, lonDeg: 70, radiusKm: 1200, startLs: 100, endLs: 160, peak: 0.8 },
];

group("planetWeather: events and sampling", () => {
  test("the envelope rises, holds and falls inside its window and wraps the year", () => {
    const d = { startLs: 330, endLs: 40, attack: 0.25, decay: 0.4 };
    close(planetEventEnvelope(d, 300), 0);
    close(planetEventEnvelope(d, 330), 0);
    assert.ok(planetEventEnvelope(d, 355) > 0.9);
    close(planetEventEnvelope(d, 40), 0);
    close(planetEventEnvelope(d, 100), 0);
  });

  test("a storm is strongest at its own centre and absent far away and outside its season", () => {
    const w = new PlanetWeatherSystem({ events: EVENTS });
    w.setSolarLongitude(228);
    const c = w.centreOf("storm")!;
    const s = w.sample(c.latDeg, c.lonDeg, createPlanetWeatherSample());
    assert.ok(s.dust > 0.6, `dust at the centre ${s.dust}`);
    assert.equal(s.dominantId, "storm");
    assert.ok(s.windSpeed > 10, "storm winds");
    const far = w.sample(60, -100, createPlanetWeatherSample());
    assert.ok(far.dust < 0.05, `dust far away ${far.dust}`);
    w.setSolarLongitude(30);
    assert.ok(w.sample(c.latDeg, c.lonDeg).dust < 0.05, "out of season");
    assert.equal(w.intensityOf("storm"), 0);
  });

  test("ice hoods, devils and frost land in their own channels", () => {
    const w = new PlanetWeatherSystem({ events: EVENTS });
    w.setSolarLongitude(355);
    assert.ok(w.sample(72, 30).iceCloud > 0.3, "polar hood cloud");
    w.setSolarLongitude(150);
    // Local afternoon at the devil field: pick the sol whose local time at lon -100 is 14 h.
    w.setSols(solsForLocalHours(-100, 14, w.sols));
    assert.ok(w.sample(20, -100).devilActivity > 0.2, "afternoon devils");
    w.setSols(solsForLocalHours(-100, 3, w.sols));
    assert.ok(w.sample(20, -100).devilActivity < 0.1, "none at 3 am");
    assert.ok(w.sample(-45, 70).frost > 0.3, "frost");
    assert.ok(w.activeEvents().length >= 1);
  });

  test("planetGroundWeather maps dust to storm haze and stays dry", () => {
    const s = createPlanetWeatherSample();
    s.dust = 0.9; s.windSpeed = 20; s.iceCloud = 0.1;
    const out = { windSpeed: 0, windDirection: 0, gust: 0, temperatureC: 0, humidity01: 0, precipitation01: 0, storm01: 0, cloudCoverage: 0 };
    planetGroundWeather(s, 14, out);
    close(out.storm01, 0.9); assert.equal(out.precipitation01, 0);
    assert.ok(out.temperatureC < -20 && out.temperatureC > -110);
    const calm = createPlanetWeatherSample();
    planetGroundWeather(calm, 3, out);
    assert.ok(out.temperatureC < -70, "cold night");
  });

  test("polar caps grow in winter, retreat in summer and cover the pole", () => {
    const caps = new PlanetPolarCaps();
    assert.ok(caps.coverage(88, 0, 330) > 0.9);
    assert.ok(caps.coverage(-88, 0, 150) > 0.9);
    close(caps.coverage(0, 0, 100), 0);
    assert.ok(caps.seasonalExtent(330, 330) !== caps.seasonalExtent(330, 150));
  });
});

group("sky aureole lobe and external sun", () => {
  test("the aureole is a blue forward lobe and absent when zero", () => {
    const base = createAtmosphere({ mieAureole: undefined }, MARS_ATMOSPHERE);
    const plain = { ...base, mieAureole: undefined };
    assert.equal(mieChannelPhase(plain, 2, 0.99), mieChannelPhase(plain, 0, 0.99));
    const p = MARS_ATMOSPHERE;
    assert.ok(mieChannelPhase(p, 2, 0.999) > mieChannelPhase(p, 0, 0.999) * 2, "blue forward lobe is brighter near the sun");
    close(mieChannelPhase(p, 0, -0.5), mieChannelPhase(p, 0, -0.5, p.mieAnisotropy));
  });

  test("a Mars sunset sky is bluer near the sun with the aureole than without", () => {
    const withLobe = new AtmosphereModel(createAtmosphere({}, MARS_ATMOSPHERE));
    const without = new AtmosphereModel(createAtmosphere({ mieAureole: [0, 0, 0] }, MARS_ATMOSPHERE));
    const sun = new Vec3(0.995, 0.03, 0.09).normalize();
    const view = new Vec3(sun.x, sun.y + 0.01, sun.z).normalize();
    const a = withLobe.skyRadiance(view, sun, 2, new Float64Array(3), 16, 8);
    const b = without.skyRadiance(view, sun, 2, new Float64Array(3), 16, 8);
    assert.ok(a[2]! / a[0]! > b[2]! / b[0]!, "blue-to-red ratio rises with the aureole");
  });

  test("an external sun direction overrides the calendar and updates elevation and azimuth", async () => {
    const scene = new Scene({ name: "ext-sun" });
    const cycle = new DayNightCycle();
    scene.add(cycle);
    cycle.externalSunDirection = new Vec3(0, 1, 0);
    cycle.apply();
    close(cycle.sunDirection.y, 1, 1e-9);
    close(cycle.elevationDeg, 90, 1e-6);
    cycle.externalSunDirection = new Vec3(1, 0.5, 0);
    cycle.apply();
    close(cycle.sunDirection.x, 1 / Math.hypot(1, 0.5), 1e-9);
    close(cycle.azimuthDeg, 90, 1e-6);
    cycle.externalSunDirection = null;
    cycle.apply();
    assert.ok(Math.abs(cycle.sunDirection.x - 1 / Math.hypot(1, 0.5)) > 1e-3, "calendar sun returns");
  });
});

group("Mars globe sampler, globe and devils", () => {
  test("the sampler returns relief and plausible Mars albedo, deterministically", () => {
    const sampler = createMarsGlobeSampler();
    const a = sampler.sample(1, 0, 0, { elevation: 0, r: 0, g: 0, b: 0 });
    const b = sampler.sample(1, 0, 0, { elevation: 0, r: 0, g: 0, b: 0 });
    assert.deepEqual(a, b);
    assert.ok(a.r > a.b, "red-brown");
    assert.ok(a.r <= 255 && a.b >= 0);
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < 200; i++) {
      const d = latLonToDirection(-80 + (i * 0.8), i * 7.3, new Vec3());
      const s = sampler.sample(d.x, d.y, d.z, { elevation: 0, r: 0, g: 0, b: 0 });
      lo = Math.min(lo, s.elevation); hi = Math.max(hi, s.elevation);
    }
    assert.ok(hi - lo > 2000, `real relief (${hi - lo} m)`);
  });

  test("the globe bakes progressively on the mock device and releases its GPU resources", async () => {
    const gpu = await GraphicsDevice.create({ forceMock: true });
    const globe = new PlanetGlobe(gpu, { sampler: createMarsGlobeSampler(), radius: 3389.5e3, meshSegments: [32, 16], textureWidth: 64, gridPasses: [16, 32], cloudTextureWidth: 32, cloudSegments: [16, 8] });
    assert.equal(globe.ready, false);
    let steps = 0;
    while (globe.update(5) && steps++ < 2000);
    assert.ok(steps < 2000, "finishes");
    assert.equal(globe.ready, true);
    close(globe.progress, 1);
    assert.ok(Math.abs(globe.elevationAt(0, 0)) < 40000);
    globe.dispose();
    await gpu.dispose();
    assert.deepEqual(gpu.mock.outstanding.buffers, []);
    assert.deepEqual(gpu.mock.outstanding.textures, []);
    assert.deepEqual(gpu.mock.errors, []);
  });

  test("devils spawn only with activity, drift downwind and clear", () => {
    const field = new DustDevilField({ count: 3, seed: 5 });
    const ctx = {} as SystemContext;
    field.activity = 0;
    for (let i = 0; i < 600; i++) field.update(ctx, 0.1);
    assert.equal(field.state().alive, 0);
    field.activity = 1;
    field.windX = 6;
    for (let i = 0; i < 1200 && field.state().alive === 0; i++) field.update(ctx, 0.1);
    assert.ok(field.state().alive > 0, "a devil spawned");
    const s0 = field.state().devils[0]!;
    for (let i = 0; i < 20; i++) field.update(ctx, 0.1);
    const s1 = field.state().devils[0];
    if (s1) assert.ok(s1.x > s0.x - 1, "drifts east with the wind");
    field.clear();
    assert.equal(field.state().alive, 0);
  });
});

await finish();
