/**
 * @suite examples:dustStormRoute
 * @group unit
 * @covers examples/src/scenes/dustStormRoute.ts
 * @desc Mars Dust Storm fe-28: obstacle/slope-aware route finder, random reachable courses, fe-29 smoothed route + guide dots wave, off-screen arrow test, auto reverse, YMCA finale poses
 */

export const suite = {
  name: "examples:dustStormRoute",
  group: "unit",
  covers:   [
    "examples/src/scenes/dustStormRoute.ts"
  ],
  desc: "Mars Dust Storm fe-28: obstacle/slope-aware route finder, random reachable courses, fe-29 smoothed route + guide dots wave, off-screen arrow test, auto reverse, YMCA finale poses",
};
import assert from "node:assert/strict";
import { finish, group, test } from "selrun";
import {
  CLEAR_SKY_DURATION,
  YMCA_LETTERS,
  autoDriveDirection,
  smoothRoute,
  sampleRouteEvenly,
  guideDotWave,
  GUIDE_WAVE_SPEED,
  clearSkyProgress,
  courseReachable,
  findRoute,
  polylineLength,
  randomCourseSeed,
  randomStormCourse,
  randomStormStart,
  startSiteOk,
  START_STRETCH_MAX,
  START_STRETCH_MIN,
  routeClear,
  targetOnScreen,
  ymcaDance,
  YMCA_CLIP,
  YMCA_TOTAL,
  type RouteObstacle,
} from "../../examples/src/scenes/dustStormRoute.js";

const flat = (): number => 0;
const rolling = (x: number, z: number): number => Math.sin(x * 0.02) * 3 + Math.cos(z * 0.025) * 2;

function minObstacleGap(points: readonly { x: number; z: number }[], o: RouteObstacle): number {
  let best = Infinity;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i]!;
    const b = points[i + 1]!;
    for (let s = 0; s <= 20; s++) {
      const t = s / 20;
      best = Math.min(best, Math.hypot(a.x + (b.x - a.x) * t - o.x, a.z + (b.z - a.z) * t - o.z));
    }
  }
  return best;
}

group("route finder (fe-28)", () => {
  test("open ground: a straight two-point route", () => {
    const r = findRoute(0, 0, 60, 20, flat, []);
    assert.ok(r);
    assert.equal(r.length, 2);
    assert.deepEqual(r[0], { x: 0, z: 0 });
    assert.deepEqual(r[r.length - 1], { x: 60, z: 20 });
  });

  test("routes around a rock sitting on the straight line, keeping rover clearance", () => {
    const rock: RouteObstacle = { x: 30, z: 0, radius: 2 };
    const r = findRoute(0, 0, 60, 0, flat, [rock]);
    assert.ok(r && r.length >= 3, "detours with at least one corner");
    assert.ok(minObstacleGap(r, rock) >= rock.radius * 0.85 + 1.5, `gap ${minObstacleGap(r, rock)}`);
    assert.ok(polylineLength(r) < 60 * 1.25, "the detour stays short");
    assert.equal(routeClear(r[0]!.x, r[0]!.z, 60, 0, flat, [rock]), false, "the straight line is blocked");
  });

  test("a wall of rocks with one gap is threaded through the gap", () => {
    const wall: RouteObstacle[] = [];
    for (let z = -60; z <= 60; z += 4) if (Math.abs(z - 20) > 6) wall.push({ x: 30, z, radius: 2 });
    const r = findRoute(0, 0, 60, 0, flat, wall, { pad: 30 });
    assert.ok(r);
    for (const o of wall) assert.ok(minObstacleGap(r, o) >= o.radius * 0.85 + 1.4);
  });

  test("steep ground is refused; a fully enclosed goal is unreachable", () => {
    const cliff = (x: number): number => (x > 30 ? (x - 30) * 2 : 0); // 63° ramp
    assert.equal(findRoute(0, 0, 50, 0, cliff, [], { pad: 10 }), null);
    const ring: RouteObstacle[] = [];
    for (let a = 0; a < Math.PI * 2; a += 0.2) ring.push({ x: 60 + Math.cos(a) * 12, z: Math.sin(a) * 12, radius: 2.4 });
    assert.equal(findRoute(0, 0, 60, 0, flat, ring), null);
  });
});

group("random reachable course (fe-28)", () => {
  test("same seed → same course; different seeds differ", () => {
    const a = randomStormCourse(7, 0, 0, rolling);
    assert.deepEqual(a, randomStormCourse(7, 0, 0, rolling));
    assert.notDeepEqual(a.checkpoints, randomStormCourse(8, 0, 0, rolling).checkpoints);
  });

  test("every waypoint is reachable from the previous one, within the world radius", () => {
    for (const seed of [1, 2, 3, 99, 12345]) {
      const c = randomStormCourse(seed, -164, 4, rolling, { count: 6 });
      assert.equal(c.checkpoints.length, 6);
      assert.equal(courseReachable(-164, 4, c.checkpoints, rolling, []), true, `seed ${seed}`);
      let px = -164;
      let pz = 4;
      for (const cp of c.checkpoints) {
        const leg = Math.hypot(cp.x - px, cp.z - pz);
        assert.ok(leg >= 55 && leg <= 130, `leg ${leg}`);
        assert.ok(Math.hypot(cp.x + 164, cp.z - 4) <= 420);
        px = cp.x;
        pz = cp.z;
      }
    }
  });

  test("blocked candidates are rejected and generation retries until reachable", () => {
    // A moat of steep ground north of x=40 forbids anything there.
    const moat = (x: number): number => (x > 40 && x < 60 ? Math.sin(x * 2) * 40 : 0);
    const c = randomStormCourse(5, 0, 0, moat, { count: 4 });
    assert.equal(courseReachable(0, 0, c.checkpoints, moat, []), true);
    assert.ok(c.attempts >= 1);
  });

  test("an impossible world falls back to the supplied fallback layout", () => {
    const walls = (x: number, z: number): number => (Math.hypot(x, z) > 20 ? 500 : 0);
    const fallback = [{ x: 1, z: 1 }];
    const c = randomStormCourse(3, 0, 0, walls, { count: 3, maxAttempts: 2, fallback });
    assert.equal(c.fallback, true);
    assert.deepEqual(c.checkpoints, fallback);
  });

  test("randomCourseSeed uses ?seed= when present, a fresh uint32 otherwise", () => {
    assert.equal(randomCourseSeed("42", () => 0.5), 42);
    assert.equal(randomCourseSeed(null, () => 0.25), Math.floor(0.25 * 0xffffffff));
    assert.equal(randomCourseSeed("nope", () => 0.5), Math.floor(0.5 * 0xffffffff));
  });
});

group("off-screen arrow (fe-28)", () => {
  // Column-major perspective × lookAt(eye (0,2,0) → +Z): built by hand, so the test does not trust
  // the engine's camera forward convention (the fe-18 arrow used the wrong forward axis).
  const f = 1 / Math.tan(Math.PI / 6);
  const aspect = 16 / 9;
  const near = 0.5;
  const far = 1000;
  // View: camera looks along world +Z → view −Z, so world z maps to view −z and world x to view −x.
  const view = [-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, -1, 0, 0, -2, 0, 1];
  const proj = [f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, far / (near - far), -1, 0, 0, (near * far) / (near - far), 0];
  const vp = new Array<number>(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) vp[c * 4 + r]! += proj[k * 4 + r]! * view[c * 4 + k]!;
  test("in front and inside the frame → on screen; behind or far to the side → off screen", () => {
    assert.equal(targetOnScreen(vp, 0, 2, 50), true);
    assert.equal(targetOnScreen(vp, 0, 2, -50), false, "behind");
    assert.equal(targetOnScreen(vp, 200, 2, 50), false, "off to the side");
    assert.equal(targetOnScreen(vp, 0, 200, 50), false, "above the frame");
  });
});

group("drive without a gear selector (fe-28)", () => {
  test("brake from rest selects reverse and backs up; gas from rest goes forward", () => {
    assert.deepEqual(autoDriveDirection(1, 0, 1, 0), { gear: -1, throttle: 1, brake: 0 });
    assert.deepEqual(autoDriveDirection(-1, 1, 0, 0), { gear: 1, throttle: 1, brake: 0 });
  });
  test("while rolling, the opposite pedal brakes instead of flipping direction", () => {
    assert.deepEqual(autoDriveDirection(1, 0, 1, 4), { gear: 1, throttle: 0, brake: 1 });
    assert.deepEqual(autoDriveDirection(-1, 1, 0, -3), { gear: -1, throttle: 0, brake: 1 });
    assert.deepEqual(autoDriveDirection(-1, 0, 0.6, -3), { gear: -1, throttle: 0.6, brake: 0 });
  });
});

group("finale: clear sky + YMCA (fe-28)", () => {
  test("the sky clears smoothly after the win", () => {
    assert.equal(clearSkyProgress(0), 0);
    assert.ok(clearSkyProgress(CLEAR_SKY_DURATION / 2) > 0.2 && clearSkyProgress(CLEAR_SKY_DURATION / 2) < 0.8);
    assert.equal(clearSkyProgress(CLEAR_SKY_DURATION + 1), 1);
  });

  test("rises onto the rear wheels, then spells Y, M, C, A in order and loops", () => {
    const start = ymcaDance(0);
    assert.equal(start.stand, 0);
    const up = ymcaDance(3);
    assert.ok(up.pitch > (60 * Math.PI) / 180 && up.pitch < (85 * Math.PI) / 180, `pitch ${up.pitch}`);
    const seen: string[] = [];
    for (let t = 0; t < 30; t += 0.05) {
      const l = ymcaDance(t).letter;
      if (l && seen[seen.length - 1] !== l) seen.push(l);
    }
    assert.deepEqual(seen.slice(0, 8), [...YMCA_LETTERS, ...YMCA_LETTERS]);
  });

  test("the four letters are distinct poses of the four upper wheels; the rear wheels stay planted", () => {
    const poseAt = (letter: string) => {
      for (let t = 2; t < 20; t += 0.01) {
        const d = ymcaDance(t);
        if (d.letter === letter && d.hold > 0.99) return d;
      }
      throw new Error(`no ${letter}`);
    };
    const poses = YMCA_LETTERS.map(poseAt);
    for (let i = 0; i < poses.length; i++) {
      for (let j = i + 1; j < poses.length; j++) {
        let diff = 0;
        for (let w = 0; w < 4; w++) diff += Math.hypot(poses[i]!.wheels[w]!.x - poses[j]!.wheels[w]!.x, poses[i]!.wheels[w]!.z - poses[j]!.wheels[w]!.z);
        assert.ok(diff > 1.5, `${YMCA_LETTERS[i]} vs ${YMCA_LETTERS[j]}: ${diff}`);
      }
      // Rear wheels (4, 5) carry no offset: they are the feet.
      for (const w of [4, 5]) assert.deepEqual([poses[i]!.wheels[w]!.x, poses[i]!.wheels[w]!.y, poses[i]!.wheels[w]!.z], [0, 0, 0]);
    }
    // Y: hands (deltas from the rest hubs at x ≈ ±1.09) high and pushed outward; A: high and pulled together.
    const [Y, , , A] = poses;
    assert.ok(Y!.hands[0].x < -0.5 && Y!.hands[1].x > 0.5 && Y!.hands[0].z > 1.5, "Y spreads up and out");
    assert.ok(A!.hands[0].x > 0.5 && A!.hands[1].x < -0.5 && A!.hands[0].z > 1.5, "A meets overhead");
  });

  test("poses move continuously (no teleporting wheels between frames)", () => {
    let prev = ymcaDance(0);
    for (let t = 1 / 60; t < 20; t += 1 / 60) {
      const d = ymcaDance(t);
      for (let w = 0; w < 6; w++) {
        const jump = Math.hypot(d.wheels[w]!.x - prev.wheels[w]!.x, d.wheels[w]!.y - prev.wheels[w]!.y, d.wheels[w]!.z - prev.wheels[w]!.z);
        assert.ok(jump < 0.25, `wheel ${w} jumped ${jump} at t=${t.toFixed(2)}`);
      }
      assert.ok(Math.abs(d.pitch - prev.pitch) < 0.05);
      prev = d;
    }
  });
});


group("random start (fe-28)", () => {
  test("start is 10–20 % farther from the first beam than the base spawn, flat and reachable", () => {
    for (const seed of [1, 7, 99, 1234, 4242]) {
      const course = randomStormCourse(seed, 0, 0, rolling);
      const first = course.checkpoints[0]!;
      const base = Math.hypot(first.x, first.z);
      const s = randomStormStart(seed, 0, 0, course.checkpoints, rolling);
      assert.equal(s.fallback, false, `seed ${seed}`);
      const d = Math.hypot(first.x - s.x, first.z - s.z);
      assert.ok(d >= base * START_STRETCH_MIN - 1e-6 && d <= base * START_STRETCH_MAX + 1e-6, `seed ${seed}: ${d} vs ${base}`);
      assert.ok(Math.abs(s.stretch - d / base) < 1e-6);
      assert.ok(startSiteOk(s.x, s.z, rolling));
      assert.ok(findRoute(s.x, s.z, first.x, first.z, rolling, []));
    }
  });
  test("deterministic per seed, different across seeds", () => {
    const course = randomStormCourse(5, 0, 0, flat);
    const a = randomStormStart(5, 0, 0, course.checkpoints, flat);
    const b = randomStormStart(5, 0, 0, course.checkpoints, flat);
    const c = randomStormStart(6, 0, 0, course.checkpoints, flat);
    assert.deepEqual(a, b);
    assert.notDeepEqual(a, c);
  });
  test("falls back to the base spawn when nothing validates", () => {
    const cliff = (x: number, z: number): number => (x * x + z * z) * 0.5;
    const s = randomStormStart(3, 0, 0, [{ x: 80, z: 0 }], cliff);
    assert.deepEqual(s, { x: 0, z: 0, stretch: 1, fallback: true });
    assert.equal(randomStormStart(3, 1, 2, [], flat).fallback, true);
  });
});


group("finale clip timeline (fe-28)", () => {
  test("rise → dance → lower → done; lights on for the clip only; arm out during the dance and stowed at both ends", () => {
    assert.equal(ymcaDance(0.5).phase, "rise");
    assert.equal(ymcaDance(5).phase, "dance");
    assert.equal(ymcaDance(YMCA_CLIP + 0.1).phase, "lower");
    assert.equal(ymcaDance(YMCA_TOTAL + 0.01).phase, "done");
    assert.ok(Math.abs(YMCA_CLIP - 15) < 1e-9);
    assert.equal(ymcaDance(5).lights, 1);
    assert.ok(ymcaDance(YMCA_CLIP + 0.1).lights < 1);
    assert.equal(ymcaDance(YMCA_CLIP + 1).lights, 0, "lights out once the clip ends");
    const end = ymcaDance(YMCA_TOTAL + 0.01);
    assert.equal(end.stand, 0);
    assert.equal(end.pitch, 0);
    assert.ok(end.wheels.every((w) => w.x === 0 && w.y === 0 && w.z === 0), "back on all six wheels");
    for (const f of [ymcaDance(0), end]) assert.ok(Object.values(f.arm).every((v) => Math.abs(v) < 1e-9));
    let armMax = 0;
    for (let t = 2; t < YMCA_CLIP; t += 0.05) armMax = Math.max(armMax, Math.abs(ymcaDance(t).arm.shoulder), Math.abs(ymcaDance(t).arm.azimuth));
    assert.ok(armMax > 0.5);
  });
  test("lowering is continuous (pitch, bounce, arm)", () => {
    let prev = ymcaDance(YMCA_CLIP - 1);
    for (let t = YMCA_CLIP - 1; t < YMCA_TOTAL + 0.5; t += 1 / 60) {
      const d = ymcaDance(t);
      assert.ok(Math.abs(d.pitch - prev.pitch) < 0.05, `pitch @${t}`);
      assert.ok(Math.abs(d.bounce - prev.bounce) < 0.02, `bounce @${t}`);
      assert.ok(Math.abs(d.arm.shoulder - prev.arm.shoulder) < 0.08, `arm @${t}`);
      prev = d;
    }
  });
});

group("fe-29 guide dots", () => {
  test("Chaikin smoothing rounds corners, keeps endpoints, and never clips a boulder", () => {
    const flat = () => 0;
    const rock = { x: 10, z: 0, radius: 3 };
    const route = [{ x: 0, z: 0 }, { x: 10, z: 6 }, { x: 20, z: 0 }];
    const sm = smoothRoute(route, flat, [rock]);
    assert.ok(sm.length > route.length, "corners cut into curves");
    assert.deepEqual(sm[0], route[0]);
    assert.deepEqual(sm[sm.length - 1], route[2]);
    for (let i = 1; i < sm.length; i++) {
      for (let t = 0; t <= 1; t += 0.05) {
        const x = sm[i - 1]!.x + (sm[i]!.x - sm[i - 1]!.x) * t;
        const z = sm[i - 1]!.z + (sm[i]!.z - sm[i - 1]!.z) * t;
        assert.ok(Math.hypot(x - rock.x, z - rock.z) > rock.radius * 0.85, "clear of the rock");
      }
    }
    // A corner hugging a rock is kept where cutting it would clip.
    const tight = smoothRoute([{ x: 0, z: 0 }, { x: 10, z: 3.2 }, { x: 20, z: 0 }], flat, [rock]);
    assert.ok(tight.some((p) => p.x === 10 && p.z === 3.2), "unsafe corner kept");
  });

  test("dots are evenly spaced and the wave crest travels rover → beam", () => {
    const pts = sampleRouteEvenly([{ x: 0, z: 0 }, { x: 30, z: 0 }], 2, 100, 1);
    assert.equal(pts.length, 15);
    for (let i = 1; i < pts.length; i++) assert.ok(Math.abs(pts[i]!.x - pts[i - 1]!.x - 2) < 1e-9);
    const crestAt = (t: number) => {
      let best = -1;
      let bestG = 0;
      for (let s = 0; s <= 60; s += 0.5) if (guideDotWave(t, s, 60) > bestG) (bestG = guideDotWave(t, s, 60)), (best = s);
      return best;
    };
    const a = crestAt(0.8);
    const b = crestAt(1.3);
    assert.ok(b > a, `${a} → ${b}`);
    assert.ok(Math.abs(b - a - 0.5 * GUIDE_WAVE_SPEED) < 1);
    assert.ok(guideDotWave(0.8, a, 60) > 0.99 && guideDotWave(0.8, a + 20, 60) === 0);
  });
});

await finish();
