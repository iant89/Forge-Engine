/**
 * @suite examples:dustStorm
 * @group unit
 * @covers examples/src/scenes/dustStorm.ts
 * @desc Mars Dust Storm Survival game model: gust cycles, dust devils, dust accumulation, course and difficulty rules
 */

export const suite = {
  name: "examples:dustStorm",
  group: "unit",
  covers:   [
    "examples/src/scenes/dustStorm.ts"
  ],
  desc: "Mars Dust Storm Survival game model: gust cycles, dust devils, dust accumulation, course and difficulty rules",
};
import assert from "node:assert/strict";
import { assertCloseTo, finish, group, test } from "selrun";
import {
  BURIAL_STUCK,
  CHECKPOINT_REACH,
  DustAccumulation,
  DustDevilField,
  GUST_PERIOD,
  LULL_INTENSITY,
  STORM_CHECKPOINT_COUNT,
  STORM_DIFFICULTY,
  STORM_QUALITY_TIERS,
  StormCourse,
  StormField,
  devilRoverForce,
  devilTangentialSpeed,
  isRoverFlipped,
  pileWindwardPoint,
  stormCheckpointLayout,
  stormQualityForPlatform,
  type DustDevil,
} from "../../examples/src/scenes/dustStorm.js";

const devilAt = (overrides: Partial<DustDevil> = {}): DustDevil => ({
  id: 0,
  x: 0,
  z: 0,
  vx: 0,
  vz: 0,
  coreRadius: 4,
  outerRadius: 16,
  swirl: 24,
  life: 40,
  age: 20,
  ...overrides,
});

group("storm field: gust cycles with lulls (D8)", () => {
  test("holds a lull plateau, then gusts close to full intensity, every cycle", () => {
    const storm = new StormField();
    for (const t of [1, 5, 10]) assertCloseTo(storm.intensity(t), LULL_INTENSITY, 9);
    assert.equal(storm.phase(5), "lull");
    const gustT = GUST_PERIOD * 0.7;
    assert.equal(storm.phase(gustT), "gust");
    assert.ok(storm.intensity(gustT) > 0.8, `gust ${storm.intensity(gustT)}`);
    assert.ok(storm.intensity(gustT) <= 1);
    // Periodic envelope: the next cycle's lull is a lull again.
    assertCloseTo(storm.intensity(GUST_PERIOD + 5), LULL_INTENSITY, 9);
  });

  test("is deterministic for a seed and scales wind with intensity", () => {
    const a = new StormField(7);
    const b = new StormField(7);
    for (const t of [0, 13.5, 40, 101]) {
      assert.equal(a.intensity(t), b.intensity(t));
      assert.deepEqual(a.wind(t), b.wind(t));
    }
    const lull = Math.hypot(a.wind(5).x, a.wind(5).z);
    const gust = Math.hypot(a.wind(GUST_PERIOD * 0.7).x, a.wind(GUST_PERIOD * 0.7).z);
    assert.ok(gust > lull * 2);
  });
});

group("dust devils (D5)", () => {
  test("Rankine profile: rises through the core, decays outside, zero beyond the outer radius", () => {
    const d = devilAt();
    assert.equal(devilTangentialSpeed(d, 0), 0);
    assert.ok(devilTangentialSpeed(d, 2) < devilTangentialSpeed(d, 4));
    assertCloseTo(devilTangentialSpeed(d, 4), 24, 9);
    assert.ok(devilTangentialSpeed(d, 8) < 12);
    assert.equal(devilTangentialSpeed(d, 16), 0);
    assert.equal(devilTangentialSpeed(devilAt({ age: 0 }), 4), 0, "fades in from nothing");
  });

  test("pushes the rover along the swirl and inward, yaws it with the spin, and lifts/rolls only in the core", () => {
    const d = devilAt();
    // Rover east of the eye at the core edge: counter-clockwise tangent is +Z, inflow is −X.
    const edge = devilRoverForce(d, 6, 0);
    assert.ok(edge.az > 0, "tangential push");
    assert.ok(edge.ax < 0, "inflow toward the eye");
    assert.ok(edge.yawAccel > 0, "yaw follows the spin");
    assert.equal(edge.lift, 0, "no lift outside the core");
    const core = devilRoverForce(d, 2, 0);
    assert.ok(core.lift > 3.72, `strongest devils out-lift Mars gravity (${core.lift})`);
    assert.ok(core.rollAccel !== 0);
    const reversed = devilRoverForce(devilAt({ swirl: -24 }), 6, 0);
    assert.ok(reversed.az < 0 && reversed.yawAccel < 0, "clockwise devils push and yaw the other way");
    const far = devilRoverForce(d, 40, 0);
    assert.deepEqual(far, { ax: 0, az: 0, yawAccel: 0, lift: 0, rollAccel: 0 });
  });

  test("spawns upwind, more in gusts, and replays from the seed", () => {
    const a = new DustDevilField(6, 99);
    const b = new DustDevilField(6, 99);
    a.step(0.1, 0.35, 20, 0, 0, 0);
    b.step(0.1, 0.35, 20, 0, 0, 0);
    assert.equal(a.devils.length, a.activeSlots(0.35));
    assert.deepEqual(a.devils, b.devils);
    for (const d of a.devils) assert.ok(d.x < 0, "wind blows +X, so devils start on the −X side");
    a.step(0.1, 1, 20, 0, 0, 0);
    assert.equal(a.devils.length, 6);
    assert.equal(new DustDevilField(0).activeSlots(1), 0);
  });
});

group("dust accumulation (D1/D2)", () => {
  test("props pile up to their cap on the windward face", () => {
    const acc = new DustAccumulation();
    const pile = acc.addPile(10, 0, 2);
    for (let i = 0; i < 2000; i++) acc.stepPiles(0.1, 1);
    assertCloseTo(pile.depth, pile.maxDepth, 9);
    const p = pileWindwardPoint(pile, 20, 0);
    assert.ok(p.x < 10, "wind blows +X so the pile sits on the −X (upwind) face");
  });

  test("a parked rover gets buried, driving sheds it, and throttle pumps dig it out", () => {
    const acc = new DustAccumulation();
    let t = 0;
    while (acc.burial < BURIAL_STUCK && t < 120) {
      acc.stepRover(0.1, 1, 0, 0, false);
      t += 0.1;
    }
    assert.ok(t > 8 && t < 30, `stuck after ${t.toFixed(1)} s of a gust`);
    const lull = new DustAccumulation();
    for (let i = 0; i < 150; i++) lull.stepRover(0.1, LULL_INTENSITY, 0, 0, false);
    assert.ok(lull.burial < BURIAL_STUCK, "lulls give a window");
    const stuckAt = acc.burial;
    // Holding throttle while stuck barely helps; pumping it digs out.
    for (let i = 0; i < 20; i++) acc.stepRover(0.1, 1, 0, i % 4 < 2 ? 1 : 0, true);
    assert.ok(acc.burial < stuckAt - 0.2, `pumped from ${stuckAt} to ${acc.burial}`);
    const driving = new DustAccumulation();
    driving.burial = 0.5;
    for (let i = 0; i < 20; i++) driving.stepRover(0.1, 1, 2, 1, false);
    assert.ok(driving.burial < 0.25);
  });
});

group("course and difficulty (D3/D4)", () => {
  test("fixed-seed checkpoints, reached in sequence, then the run is won", () => {
    const layout = stormCheckpointLayout(0, 0);
    assert.deepEqual(layout, stormCheckpointLayout(0, 0));
    assert.equal(layout.length, STORM_CHECKPOINT_COUNT);
    const course = new StormCourse(layout, 0, 0);
    const second = layout[1]!;
    assert.equal(course.step(1, second.x, second.z), false, "out of order does not count");
    for (let i = 0; i < layout.length; i++) {
      const cp = layout[i]!;
      assert.equal(course.step(0.5, cp.x + CHECKPOINT_REACH * 0.5, cp.z), true);
    }
    assert.equal(course.state, "won");
    assert.equal(course.active, null);
    assertCloseTo(course.elapsed, 1 + 0.5 * layout.length, 9);
  });

  test("respawns at the last reached beam, and bearing points at the active one", () => {
    const course = new StormCourse([{ x: 0, z: 100 }, { x: 100, z: 100 }], 0, 0);
    assert.deepEqual(course.respawnPoint(), { x: 0, z: 0 });
    assertCloseTo(course.bearing(0, 0, 0), 0, 9);
    assertCloseTo(course.bearing(0, 0, Math.PI / 2), -Math.PI / 2, 9);
    course.step(0, 0, 100);
    assert.deepEqual(course.respawnPoint(), { x: 0, z: 100 });
    assertCloseTo(course.bearing(0, 100, 0), Math.PI / 2, 9, "beam 2 is to the right (+X) of a rover facing +Z");
  });

  test("easy rocks free with a time penalty; hard resets; iOS gets the reduced tier", () => {
    assert.deepEqual(STORM_DIFFICULTY.easy, { onStuck: "soft", onFlip: "right", timePenalty: 15 });
    assert.equal(STORM_DIFFICULTY.hard.onStuck, "reset");
    assert.equal(STORM_DIFFICULTY.hard.onFlip, "reset");
    assert.equal(stormQualityForPlatform("ios"), "reduced");
    assert.equal(stormQualityForPlatform("macos"), "full");
    assert.ok(STORM_QUALITY_TIERS.reduced.particleCapacity * 4 < STORM_QUALITY_TIERS.full.particleCapacity);
    assert.ok(STORM_QUALITY_TIERS.reduced.devils < STORM_QUALITY_TIERS.full.devils);
    assert.equal(isRoverFlipped(0.2, 0.1), false);
    assert.equal(isRoverFlipped(1.6, 0), true);
  });
});

await finish();
