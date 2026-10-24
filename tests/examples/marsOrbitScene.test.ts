/**
 * @suite examples:marsOrbitScene
 * @group unit
 * @covers examples/src/controls/gestures.ts
 * @covers examples/src/diag/touchDiagnostics.ts
 * @covers examples/src/scenes/marsOrbitMath.ts
 * @covers examples/src/scenes/marsOrbitEvents.ts
 * @covers examples/src/sceneSelection.ts
 * @desc fe-39 Mars Orbit Explorer demo: gesture rules, diagnostics text, camera maths, and the weather-event script
 */

export const suite = {
  name: "examples:marsOrbitScene",
  group: "unit",
  covers: [
    "examples/src/controls/gestures.ts",
    "examples/src/diag/touchDiagnostics.ts",
    "examples/src/scenes/marsOrbitMath.ts",
    "examples/src/scenes/marsOrbitEvents.ts",
    "examples/src/sceneSelection.ts",
  ],
  desc: "fe-39 Mars Orbit Explorer demo: gesture rules, diagnostics text, camera maths, and the weather-event script",
};
/**
 * The demo's own pieces (`?scene=mars-orbit`): the pointer gesture rules that make mouse and iOS touch
 * behave the same, the camera policy, and the event table that scripts the weather. The scene's pixels
 * are checked in a browser; its planet maths and weather systems are pinned by
 * `tests/environment/planetOrbit.test.ts`.
 */
import assert from "node:assert/strict";
import { assertCloseTo, finish, group, test } from "selrun";
import { PlanetWeatherSystem, createPlanetWeatherSample, solsForLocalHours } from "@forge/engine";
import { GestureRecogniser } from "../../examples/src/controls/gestures.js";
import { formatDiagPointer } from "../../examples/src/diag/touchDiagnostics.js";
import {
  entryHaze,
  groundViewQuaternion,
  lerpLog,
  orbitAltitudeRange,
  orbitClipPlanes,
  orbitFitAltitude,
  pixelRay,
} from "../../examples/src/scenes/marsOrbitMath.js";
import { MARS_ORBIT_DESTINATIONS, MARS_ORBIT_EVENTS } from "../../examples/src/scenes/marsOrbitEvents.js";
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

  test("the entry haze peaks near the swap and is gone in orbit and on the ground", () => {
    assert.ok(entryHaze(450e3, false) > 0.9 || entryHaze(450e3, false) > entryHaze(2.5e6, false));
    assertCloseTo(entryHaze(4e6, false), 0, 1e-9);
    assertCloseTo(entryHaze(10, true), 0, 1e-9);
    assert.ok(entryHaze(450e3, true) > 0.9);
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

await finish();
