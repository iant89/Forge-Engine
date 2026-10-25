/**
 * @suite examples:marsOrbitScene
 * @group unit
 * @covers examples/src/controls/gestures.ts
 * @covers examples/src/diag/touchDiagnostics.ts
 * @covers examples/src/scenes/marsOrbitMath.ts
 * @covers examples/src/scenes/marsOrbitEvents.ts
 * @covers examples/src/scenes/marsOrbitLandmarks.ts
 * @covers examples/src/sceneSelection.ts
 * @desc fe-39 Mars Orbit Explorer demo: gesture rules, diagnostics text, camera maths, the weather-event script and the landmark table
 */

export const suite = {
  name: "examples:marsOrbitScene",
  group: "unit",
  covers: [
    "examples/src/controls/gestures.ts",
    "examples/src/diag/touchDiagnostics.ts",
    "examples/src/scenes/marsOrbitMath.ts",
    "examples/src/scenes/marsOrbitEvents.ts",
    "examples/src/scenes/marsOrbitLandmarks.ts",
    "examples/src/sceneSelection.ts",
  ],
  desc: "fe-39 Mars Orbit Explorer demo: gesture rules, diagnostics text, camera maths, the weather-event script and the landmark table",
};
/**
 * The demo's own pieces (`?scene=mars-orbit`): the pointer gesture rules that make mouse and iOS touch
 * behave the same, the camera policy, and the event table that scripts the weather. The scene's pixels
 * are checked in a browser; its planet maths and weather systems are pinned by
 * `tests/environment/planetOrbit.test.ts`.
 */
import assert from "node:assert/strict";
import { assertCloseTo, finish, group, test } from "selrun";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MarsHeightAtlasStreamer, PlanetWeatherSystem, createPlanetWeatherSample, latLonToDirection, solsForLocalHours, Vec3 } from "@forge/engine";
import { GestureRecogniser } from "../../examples/src/controls/gestures.js";
import { formatDiagPointer } from "../../examples/src/diag/touchDiagnostics.js";
import {
  DETAIL_MAX_RADIUS,
  descentFogDensity,
  descentGroundHeight,
  detailFocusRadius,
  ENTRY_SWAP_ALTITUDE,
  ENTRY_VEIL_PEAK,
  entryHaze,
  groundPointerDirection,
  groundViewQuaternion,
  isSkyPick,
  orbitFacing,
  projectOrbitPoint,
  lerpLog,
  orbitAltitudeRange,
  orbitClipPlanes,
  orbitFitAltitude,
  pixelRay,
} from "../../examples/src/scenes/marsOrbitMath.js";
import { MARS_ORBIT_DESTINATIONS, MARS_ORBIT_EVENTS } from "../../examples/src/scenes/marsOrbitEvents.js";
import { MARS_LANDMARK_KIND_LABEL, MARS_LANDMARKS } from "../../examples/src/scenes/marsOrbitLandmarks.js";
import { resolveDemoSceneName } from "../../examples/src/sceneSelection.js";

function recorder() {
  const log: string[] = [];
  const g = new GestureRecogniser({
    dragStart: (x, y) => log.push(`dragStart ${x},${y}`),
    drag: (x, y) => log.push(`drag ${x},${y}`),
    dragEnd: (_t, cancelled) => log.push(`dragEnd ${cancelled}`),
    tap: (x, y) => log.push(`tap ${x},${y}`),
    doubleTap: (x, y) => log.push(`double ${x},${y}`),
    pinchStart: () => log.push("pinchStart"),
    pinch: (r) => log.push(`pinch ${r.toFixed(2)}`),
    pinchEnd: () => log.push("pinchEnd"),
  });
  return { g, log };
}

group("gestures", () => {
  test("a small quick press is a tap; a drag reports its press point and ends without a tap", () => {
    const { g, log } = recorder();
    g.pointerDown(1, 100, 100, 0);
    g.pointerUp(1, 102, 101, 80);
    assert.deepEqual(log, ["tap 102,101"]);
    log.length = 0;
    g.pointerDown(1, 300, 300, 1000);
    g.pointerMove(1, 303, 300, 1010);
    assert.equal(log.length, 0, "inside the slop nothing happens");
    g.pointerMove(1, 340, 310, 1030);
    g.pointerUp(1, 340, 310, 1060);
    assert.equal(log[0], "dragStart 300,300");
    assert.equal(log.at(-1), "dragEnd false");
    assert.ok(!log.some((l) => l.startsWith("tap")));
  });

  test("two quick taps are one double-tap, and the second is not also a tap", () => {
    const { g, log } = recorder();
    g.pointerDown(1, 200, 200, 0);
    g.pointerUp(1, 200, 200, 60);
    g.pointerDown(1, 205, 203, 200);
    g.pointerUp(1, 205, 203, 260);
    assert.deepEqual(log, ["tap 200,200", "double 205,203"]);
  });

  test("two taps too far apart or too slow stay separate taps", () => {
    const far = recorder();
    far.g.pointerDown(1, 200, 200, 0); far.g.pointerUp(1, 200, 200, 50);
    far.g.pointerDown(1, 400, 200, 120); far.g.pointerUp(1, 400, 200, 170);
    assert.ok(!far.log.some((l) => l.startsWith("double")));
    const slow = recorder();
    slow.g.pointerDown(1, 200, 200, 0); slow.g.pointerUp(1, 200, 200, 50);
    slow.g.pointerDown(1, 201, 200, 1500); slow.g.pointerUp(1, 201, 200, 1550);
    assert.ok(!slow.log.some((l) => l.startsWith("double")));
  });

  test("a second finger cancels the drag, pinches, and lifting from a pinch throws nothing", () => {
    const { g, log } = recorder();
    g.pointerDown(1, 100, 100, 0);
    g.pointerMove(1, 140, 100, 20);
    g.pointerDown(2, 300, 100, 30);
    assert.ok(log.includes("dragEnd true"));
    assert.equal(g.mode, "pinch");
    g.pointerMove(2, 400, 100, 50);
    assert.ok(log.some((l) => l.startsWith("pinch ") && Number(l.slice(6)) > 1), "spreading is a ratio above 1");
    const before = log.length;
    g.pointerUp(2, 400, 100, 70);
    g.pointerMove(1, 180, 100, 80);
    g.pointerUp(1, 180, 100, 90);
    assert.ok(!log.slice(before).some((l) => l.startsWith("drag")), "no drag after a pinch");
    assert.equal(g.pointerCount, 0);
  });
});

group("touch diagnostics text", () => {
  test("a pointer row shows id, type, state, rounded position, pressure and contact size", () => {
    const row = formatDiagPointer({ id: 3, type: "touch", x: 10.6, y: 20.2, pressure: 0.5, width: 22, height: 24, down: true });
    assert.equal(row, "#3 touch down (11, 20) p0.50 22×24");
    assert.ok(formatDiagPointer({ id: 1, type: "mouse", x: 0, y: 0, pressure: 0, width: 1, height: 1, down: false }).includes("up"));
  });
});

group("orbit camera maths", () => {
  test("the fit altitude frames the planet in landscape and portrait", () => {
    const R = 3389.5e3;
    const fov = (45 * Math.PI) / 180;
    const wide = orbitFitAltitude(R, fov, 16 / 9);
    const tall = orbitFitAltitude(R, fov, 9 / 19.5);
    assert.ok(tall > wide, "portrait must sit further back");
    const half = Math.asin(R / (R + wide));
    assert.ok(half < fov / 2, "the planet fits inside the vertical field");
    const range = orbitAltitudeRange(wide);
    assert.ok(range.min < wide && range.max > wide);
    const clip = orbitClipPlanes(R, wide);
    assert.ok(clip.far > wide + 2 * R && clip.near < wide);
  });

  test("log lerp, ground view and pixel rays", () => {
    assertCloseTo(lerpLog(100, 10000, 0.5), 1000, 1e-6);
    const q = groundViewQuaternion(0, -Math.PI / 2, [0, 0, 0, 1]);
    assertCloseTo(Math.hypot(q[0], q[1], q[2], q[3]), 1, 1e-9);
    const mid = pixelRay(640, 360, 1280, 720, 0.8);
    assertCloseTo(mid.z, 1, 1e-9);
    const right = pixelRay(1280, 360, 1280, 720, 0.8);
    assert.ok(right.x > 0.3 && Math.abs(right.y) < 1e-9);
  });

  test("ground pointer rays and the double-click-the-sky rule", () => {
    // Level view facing north (yaw 0): the screen centre looks along +Z, the top of the screen up.
    const centre = groundPointerDirection(640, 360, 1280, 720, 1, 0, 0);
    assertCloseTo(centre.z, 1, 9);
    assertCloseTo(Math.hypot(centre.x, centre.y, centre.z), 1, 9);
    const top = groundPointerDirection(640, 0, 1280, 720, 1, 0, 0);
    assertCloseTo(top.y, Math.sin(0.5), 9, "the top edge is half the vertical FOV up");
    const right = groundPointerDirection(1280, 360, 1280, 720, 1, 0, 0);
    assert.ok(right.x > 0.5, "the right edge looks east");
    // Facing east (yaw +90°) the centre looks along +X; pitching up raises it.
    const east = groundPointerDirection(640, 360, 1280, 720, 1, Math.PI / 2, 0);
    assertCloseTo(east.x, 1, 9);
    const up = groundPointerDirection(640, 360, 1280, 720, 1, 0, 0.4);
    assertCloseTo(up.y, Math.sin(0.4), 9);
    assertCloseTo(up.z, Math.cos(0.4), 9);

    assert.equal(isSkyPick(top.y, false), true, "above the horizon, no terrain: sky");
    assert.equal(isSkyPick(top.y, true), false, "a crater rim against the sky is ground");
    assert.equal(isSkyPick(0, false), false, "the horizon itself (unloaded distant ground) is not");
    assert.equal(isSkyPick(-0.2, false), false);
  });

  test("the detail patch covers what a zoomed-in orbit camera sees, and is off when zoomed out", () => {
    const R = 3389.5e3;
    const fov = (40 * Math.PI) / 180;
    // The fitted whole-planet view is far too wide for a patch.
    assert.equal(detailFocusRadius(R, orbitFitAltitude(R, fov, 1.6), fov, 1.6), 0);
    // The closest orbit zoom (900 km) sees ~11° of arc to its corners.
    const close = detailFocusRadius(R, 900e3, fov, 1.6);
    assert.ok(close > 0.15 && close < 0.25, `${close} rad at 900 km`);
    // Lower is smaller, a wider screen is larger, and the cap never exceeds the limit or the horizon.
    assert.ok(detailFocusRadius(R, 450e3, fov, 1.6) < close);
    assert.ok(detailFocusRadius(R, 900e3, fov, 2.4) > close);
    for (const alt of [200e3, 900e3, 1500e3, 2500e3, 4e6]) {
      const r = detailFocusRadius(R, alt, fov, 1.6);
      assert.ok(r <= DETAIL_MAX_RADIUS && r <= Math.acos(R / (R + alt)) + 1e-12, `${alt}: ${r}`);
    }
  });

  test("the dust veil is thin, peaks at the swap on both sides, and is gone in orbit and low down", () => {
    const swap = ENTRY_SWAP_ALTITUDE;
    assert.ok(ENTRY_VEIL_PEAK <= 0.35, "the terrain must stay readable through the veil");
    assert.equal(entryHaze(swap, false), ENTRY_VEIL_PEAK);
    assert.equal(entryHaze(swap, true), ENTRY_VEIL_PEAK);
    assert.equal(entryHaze(4e6, false), 0);
    assert.equal(entryHaze(10, true), 0);
    assert.equal(entryHaze(15e3, true), 0);
    for (const [a, b] of [[2e6, 5e5], [5e5, 1.5e5]] as const) assert.ok(entryHaze(a, false) < entryHaze(b, false), `${a} vs ${b}`);
    for (const [a, b] of [[2e4, 4e4], [4e4, 7e4]] as const) assert.ok(entryHaze(a, true) < entryHaze(b, true), `${a} vs ${b}`);
  });

  test("the descent fog is the ground fog at eye height and keeps the ground below at one fog depth from high up", () => {
    const base = 0.0014;
    assert.ok(Math.abs(descentFogDensity(base, 0) - base) < 1e-15);
    assert.ok(Math.abs(descentFogDensity(base, 1.7) - base) / base < 1e-5);
    let last = Infinity;
    for (const h of [10, 100, 1e3, 1e4, 8e4]) {
      const d = descentFogDensity(base, h);
      assert.ok(d < last && d > 0, `${h}: ${d}`);
      last = d;
    }
    // Looking straight down from high up: exp2 argument at the ground tends to the fog depth (0.6).
    for (const h of [2e4, 8e4]) assert.ok(Math.abs(descentFogDensity(base, h) * h - 0.6) < 0.01, `${h}`);
    // The old fixed density hid the ground completely from a few km up.
    assert.ok(Math.exp(-((base * 5e3) ** 2)) < 1e-10 && Math.exp(-((descentFogDensity(base, 5e3) * 5e3) ** 2)) > 0.6);
  });

  test("the ground side of the fall starts exactly where the orbit side stopped and ends at the altitude", () => {
    for (const elevation of [-7000, -4500, 0, 1500, 21000]) {
      // At the swap the ground camera (site elevation + height) is the orbit camera (swap above the datum).
      assert.ok(Math.abs(elevation + descentGroundHeight(ENTRY_SWAP_ALTITUDE, elevation) - ENTRY_SWAP_ALTITUDE) < 1e-6, `${elevation}`);
      assert.ok(Math.abs(descentGroundHeight(1.7, elevation) - 1.7) < 0.5, `${elevation}`);
      let last = -Infinity;
      for (let A = 1.7; A <= ENTRY_SWAP_ALTITUDE; A *= 1.5) {
        const h = descentGroundHeight(A, elevation);
        assert.ok(h > last && h > 0, `${elevation} @ ${A}: ${h}`);
        last = h;
      }
    }
  });
});

group("the event script", () => {
  test("every event is well-formed and every destination shows the event it names", () => {
    const ids = new Set<string>();
    for (const e of MARS_ORBIT_EVENTS) {
      assert.ok(!ids.has(e.id), `duplicate ${e.id}`);
      ids.add(e.id);
      assert.ok(e.peak > 0 && e.peak <= 1 && e.radiusKm > 0);
      assert.ok(Math.abs(e.latDeg) <= 90 && Math.abs(e.lonDeg) <= 180);
    }
    const kinds = new Set(MARS_ORBIT_EVENTS.map((e) => e.kind));
    for (const k of ["dust-storm", "regional-storm", "ice-cloud", "dust-devils", "frost"] as const) assert.ok(kinds.has(k), k);
    const weather = new PlanetWeatherSystem({ events: MARS_ORBIT_EVENTS });
    const sample = createPlanetWeatherSample();
    const expected: Record<string, (s: typeof sample) => boolean> = {
      devils: (s) => s.devilActivity > 0.2,
      storm: (s) => s.dust > 0.5,
      volcano: (s) => s.iceCloud > 0.1,
      frost: (s) => s.frost > 0.2,
    };
    for (const d of MARS_ORBIT_DESTINATIONS) {
      const check = expected[d.id];
      if (!check) continue;
      weather.setSolarLongitude(d.ls);
      // Land at the destination's local hour, as the demo does.
      weather.setSols(solsForLocalHours(d.lonDeg, d.hours, weather.sols));
      weather.sample(d.latDeg, d.lonDeg, sample);
      assert.ok(check(sample), `${d.id}: ${JSON.stringify(sample)}`);
    }
  });

  test("the scene name resolves with its aliases", () => {
    assert.equal(resolveDemoSceneName("mars-orbit"), "mars-orbit");
    assert.equal(resolveDemoSceneName("planet"), "mars-orbit");
  });
});

group("landmarks", () => {
  test("every landmark is complete, unique and in range", () => {
    const ids = new Set<string>();
    for (const l of MARS_LANDMARKS) {
      assert.ok(!ids.has(l.id), `duplicate ${l.id}`);
      ids.add(l.id);
      assert.ok(l.name.length > 2 && MARS_LANDMARK_KIND_LABEL[l.kind], l.id);
      assert.ok(l.latDeg >= -90 && l.latDeg <= 90, `${l.id} latitude`);
      assert.ok(l.lonDeg >= 0 && l.lonDeg < 360, `${l.id} longitude is east-positive 0–360`);
      assert.ok(l.description.length >= 60 && l.description.length <= 280, `${l.id}: brief but useful (${l.description.length} chars)`);
    }
    assert.ok(MARS_LANDMARKS.length >= 12);
    for (const kind of ["volcano", "canyon", "basin", "landing", "polar"] as const) {
      assert.ok(MARS_LANDMARKS.some((l) => l.kind === kind), `has a ${kind}`);
    }
  });

  test("volcanoes, basins and canyons sit where MOLA says they are", async () => {
    // A sign or hemisphere slip in a coordinate puts a summit in a basin: check the real heights.
    const molaDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../examples/public/mars/mola");
    const diskFetch = ((input: RequestInfo | URL) =>
      Promise.resolve(new Response(readFileSync(path.join(molaDir, String(input).replace(/^.*\/mars\/mola\//, "")))))) as typeof fetch;
    const streamer = await MarsHeightAtlasStreamer.open("/mars/mola/", { fetchImpl: diskFetch });
    await streamer.loadSize("tablet");
    const d = new Vec3();
    /** Extreme height within ±1.5° of a landmark (its marker is a point on a big feature). */
    const extreme = (id: string, mode: "max" | "min"): number => {
      const l = MARS_LANDMARKS.find((x) => x.id === id)!;
      let best = mode === "max" ? -Infinity : Infinity;
      for (let la = -1.5; la <= 1.5; la += 0.25) {
        for (let lo = -1.5; lo <= 1.5; lo += 0.25) {
          latLonToDirection(l.latDeg + la, l.lonDeg + lo, d);
          const h = streamer.atlas.sample(d.x, d.y, d.z);
          best = mode === "max" ? Math.max(best, h) : Math.min(best, h);
        }
      }
      return best;
    };
    const expect: Array<[string, "max" | "min", number]> = [
      ["olympus-mons", "max", 18000],
      ["tharsis-montes", "max", 10000],
      ["elysium-mons", "max", 10000],
      ["hellas", "min", -6000],
      ["argyre", "min", -1500],
      ["utopia", "min", -3000],
      ["valles-marineris", "min", -3000],
    ];
    for (const [id, mode, limit] of expect) {
      const h = extreme(id, mode);
      assert.ok(mode === "max" ? h > limit : h < limit, `${id}: ${mode} height ${h.toFixed(0)} m vs ${limit}`);
    }
  });

  test("markers project onto the pixel the orbit picker would pick, and hide on the far side", () => {
    const w = 1280;
    const h = 720;
    const fov = 0.7;
    const alt = 5e6;
    for (const [px, py] of [[640, 360], [100, 80], [1200, 650]] as const) {
      // pixelRay in the orbit basis: right +X, up +Z, forward −Y (as the scene's picker builds it).
      const ray = pixelRay(px, py, w, h, fov);
      const t = 1e6;
      const p = projectOrbitPoint(ray.x * t, alt - ray.z * t, ray.y * t, alt, fov, w, h);
      assert.ok(p.inFront);
      assertCloseTo(p.x, px, 6);
      assertCloseTo(p.y, py, 6);
    }
    assert.equal(projectOrbitPoint(0, alt + 10, 0, alt, fov, w, h).inFront, false, "behind the eye");
    const R = 3389.5e3;
    // Planet centre at (0, −R, 0): the sub-camera point faces the eye, the far side does not.
    assertCloseTo(orbitFacing(0, 1, 0, 0, 0, 0, alt), 1, 9);
    assert.ok(orbitFacing(0, -1, 0, 0, -2 * R, 0, alt) < 0);
    // From 5,000 km the limb is ~66° from the sub-camera point: 60° out is grazing, 90° out is hidden.
    const at = (deg: number): number => {
      const nx = Math.sin((deg * Math.PI) / 180);
      const ny = Math.cos((deg * Math.PI) / 180);
      return orbitFacing(nx, ny, 0, nx * R, ny * R - R, 0, alt);
    };
    assert.ok(at(60) > 0 && at(60) < 0.5, `60° out: ${at(60)}`);
    assert.ok(at(90) < 0, "beyond the limb");
  });
});

await finish();
