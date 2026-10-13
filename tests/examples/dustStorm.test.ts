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
  stormParticleBudget,
  type DustDevil,
  DRIFT_RINGS,
  DRIFT_SEGMENTS,
  DRIFT_SKIRT_DEPTH,
  DUST_REPOSE_SLOPE,
  STORM_SHEET_LOOK,
  STORM_SHEET_LOOK_FE16,
  buildDriftMoundMesh,
  buildFunnelMesh,
  devilFunnelProfile,
  devilParticleLook,
  devilSkirtProfile,
  driftMoundHeightAt,
  driftMoundRadius,
  settleDriftMound,
  FUNNEL_RINGS,
  FUNNEL_SEGMENTS,
  BEAM_RING_OFFSET,
  GUIDE_PATH_OFFSET,
  WaypointArrowState,
  ARROW_IN_MARGIN,
  beamPulse,
  BEAM_PULSE_PERIOD,
  buildDrapedRing,
  buildGuidePath,
  guidePathEnabled,
  waypointArrowEnabled,
  waypointInView,
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
    // iOS budget: sheet + every capped devil system stays at 28k particles, well under full.
    assert.ok(stormParticleBudget(STORM_QUALITY_TIERS.reduced) <= 28_000);
    assert.ok(STORM_QUALITY_TIERS.reduced.devilCapacity <= 2_000);
    assert.ok(stormParticleBudget(STORM_QUALITY_TIERS.reduced) * 4 < stormParticleBudget(STORM_QUALITY_TIERS.full));
    assert.ok(STORM_QUALITY_TIERS.reduced.devils < STORM_QUALITY_TIERS.full.devils);
    assert.equal(isRoverFlipped(0.2, 0.1), false);
    assert.equal(isRoverFlipped(1.6, 0), true);
  });
});

group("fe-18 dust storm polish", () => {
  // A 20° hill falling toward +X with gentle cross-wobble: the slope that used to leave a void.
  const hill = (x: number, z: number): number => -Math.tan((20 * Math.PI) / 180) * x + 0.3 * Math.sin(z * 0.4);
  const input = { x: 2, z: 1, height: 1.2, along: 1.4, across: 2, heading: 0.7 };

  test("drift mound drapes on a sloped heightfield: no vertex floats, rim on the ground, skirt below", () => {
    const shape = settleDriftMound(input, hill);
    const mesh = buildDriftMoundMesh(shape, hill);
    const p = mesh.positions;
    const S = DRIFT_SEGMENTS;
    for (let i = 0; i < p.length / 3; i++) {
      const wx = p[i * 3]! + shape.x;
      const wy = p[i * 3 + 1]! + mesh.baseY;
      const wz = p[i * 3 + 2]! + shape.z;
      const g = hill(wx, wz);
      const isRim = i >= 1 + (DRIFT_RINGS - 1) * S && i < 1 + DRIFT_RINGS * S;
      const isSkirt = i >= 1 + DRIFT_RINGS * S;
      if (isSkirt) assertCloseTo(wy, g - DRIFT_SKIRT_DEPTH, 5, `skirt vertex ${i} sunk below ground`);
      else if (isRim) assertCloseTo(wy, g, 5, `rim vertex ${i} sits on the ground`);
      else {
        assert.ok(wy >= g - 1e-5, `vertex ${i} below ground`);
        // Draped: the height above ground is the mound profile, not a flat-base offset over a void.
        assertCloseTo(wy - g, driftMoundHeightAt(shape, wx, wz) + 0.03, 3, `vertex ${i} follows the profile`);
      }
    }
    // The old dome sat at one Y; on this hill its downhill rim would hang ≥ 0.5 m above the terrain.
    const downhillRim = driftMoundRadius(shape, 0);
    assert.ok(hill(shape.x, shape.z) - hill(shape.x + downhillRim, shape.z) > 0.5, "test hill is steep enough to have shown the void");
  });

  test("angle of repose: no dust surface steeper than ~32°, and the pile stretches downhill", () => {
    const shape = settleDriftMound(input, hill);
    // Sample the dust surface (ground + mound) radially and check the slope never exceeds repose.
    for (let a = 0; a < 64; a++) {
      const phi = (a / 64) * Math.PI * 2;
      const R = driftMoundRadius(shape, phi);
      const step = R / 40;
      for (let k = 0; k < 40; k++) {
        const r0 = k * step;
        const r1 = r0 + step;
        const x0 = shape.x + Math.cos(phi) * r0, z0 = shape.z + Math.sin(phi) * r0;
        const x1 = shape.x + Math.cos(phi) * r1, z1 = shape.z + Math.sin(phi) * r1;
        const y0 = hill(x0, z0) + driftMoundHeightAt(shape, x0, z0);
        const y1 = hill(x1, z1) + driftMoundHeightAt(shape, x1, z1);
        assert.ok(Math.abs(y1 - y0) / step <= DUST_REPOSE_SLOPE + 0.06, `slope ${(Math.abs(y1 - y0) / step).toFixed(3)} at φ=${phi.toFixed(2)} r=${r0.toFixed(2)}`);
      }
    }
    assert.ok(driftMoundRadius(shape, 0) > driftMoundRadius(shape, Math.PI), "downhill (+X) flank is longer than the uphill one");
    const small = settleDriftMound({ ...input, height: 0.5 }, hill);
    assert.ok(driftMoundRadius(small, 0) > driftMoundRadius(small, Math.PI) * 1.8, "a modest pile slides into a long downhill tail");
    // Flat ground: the wind ellipse is untouched when it already fits.
    const flat = settleDriftMound({ ...input, height: 0.3 }, () => 0);
    assertCloseTo(flat.slope, 0, 9);
    assertCloseTo(driftMoundRadius(flat, flat.heading), input.along, 6);
    // Too steep to hold the dust: the height is cut (it slid away) rather than overhanging.
    const cliff = (x: number): number => -0.6 * x;
    const onCliff = settleDriftMound(input, cliff);
    assert.ok(onCliff.height < input.height, "steep ground sheds dust");
  });

  test("storm sheet particles are smaller than fe-16 with opacity compensating the haze", () => {
    assert.ok(STORM_SHEET_LOOK.size < STORM_SHEET_LOOK_FE16.size);
    assert.ok(STORM_SHEET_LOOK.sizeStart < STORM_SHEET_LOOK_FE16.sizeStart);
    assert.ok(STORM_SHEET_LOOK.sizeEnd < STORM_SHEET_LOOK_FE16.sizeEnd);
    assert.ok(STORM_SHEET_LOOK.alpha > STORM_SHEET_LOOK_FE16.alpha && STORM_SHEET_LOOK.alpha <= 0.6);
    // Per-particle coverage (size² × alpha) stays within half-to-par of fe-16, so the haze reads the same with fog.
    const cov = (l: { sizeStart: number; sizeEnd: number; alpha: number }): number => ((l.sizeStart + l.sizeEnd) / 2) ** 2 * l.alpha;
    const ratio = cov(STORM_SHEET_LOOK) / cov(STORM_SHEET_LOOK_FE16);
    assert.ok(ratio > 0.45 && ratio < 1, `coverage ratio ${ratio.toFixed(2)}`);
    // Particle budget unchanged by the polish.
    assert.ok(stormParticleBudget(STORM_QUALITY_TIERS.reduced) <= 28_000);
  });

  test("devil funnel profile: narrow tall column, pinched above the skirt, widening at the top", () => {
    assert.ok(devilFunnelProfile(0.5) < 0.4, "narrow mid-column");
    assert.ok(devilFunnelProfile(1) > devilFunnelProfile(0.5) * 1.5, "widens toward the top");
    assert.ok(devilFunnelProfile(0.12) <= devilFunnelProfile(0), "waist above the base");
    for (let u = 0.12; u < 1; u += 0.05) assert.ok(devilFunnelProfile(u + 0.05) >= devilFunnelProfile(u) - 1e-9, "monotonic above the waist");
    assert.ok(devilSkirtProfile(0) > devilFunnelProfile(0) * 2.5, "skirt is much wider than the funnel base");
    const devil = { id: 3, coreRadius: 4, swirl: -20 };
    const look = devilParticleLook(devil);
    assert.ok(look.jitterXZ < devil.coreRadius, "particles fed from inside the core");
    assert.ok(look.swirl < 0, "swirl follows the devil's spin");
    // Mesh: rotates with time (lumps advected), sways at the top, anchored at the ground.
    const h = 44;
    const a = buildFunnelMesh(devil, h, devilFunnelProfile, 1, 0);
    const b = buildFunnelMesh(devil, h, devilFunnelProfile, 1, 0.5);
    assert.equal(a.positions.length, FUNNEL_RINGS * FUNNEL_SEGMENTS * 3);
    let moved = 0;
    for (let i = 0; i < a.positions.length; i++) moved = Math.max(moved, Math.abs(a.positions[i]! - b.positions[i]!));
    assert.ok(moved > 0.05, "funnel surface animates");
    assertCloseTo(a.positions[1]!, 0, 9);
    assertCloseTo(a.positions[(FUNNEL_RINGS - 1) * FUNNEL_SEGMENTS * 3 + 1]!, h, 9);
    const baseR = Math.hypot(a.positions[0]!, a.positions[2]!);
    assert.ok(baseR < devil.coreRadius, "base is thinner than the vortex core");
  });
});

group("fe-18 waypoint guidance", () => {
  const hill = (x: number, z: number): number => 0.45 * x + 0.2 * z + 0.5 * Math.sin(x * 0.3);

  test("beam ring is draped on a slope: every vertex sits the offset above the terrain", () => {
    const ring = buildDrapedRing(10, -4, 6, 0.55, hill);
    for (let v = 0; v < ring.positions.length / 3; v++) {
      const wx = ring.positions[v * 3]! + 10;
      const wz = ring.positions[v * 3 + 2]! - 4;
      assertCloseTo(ring.positions[v * 3 + 1]! + ring.baseY, hill(wx, wz) + BEAM_RING_OFFSET, 5, `ring vertex ${v}`);
    }
    // A flat ring at the centre height would be ≥ 2 m buried uphill on this slope.
    assert.ok(hill(16, -4) - hill(10, -4) > 2);
  });

  test("easy-only path and arrow; path drapes on the terrain toward the beam", () => {
    assert.equal(guidePathEnabled("easy", true), true);
    assert.equal(guidePathEnabled("hard", true), false);
    assert.equal(guidePathEnabled("easy", false), false);
    assert.equal(waypointArrowEnabled("easy"), true);
    assert.equal(waypointArrowEnabled("hard"), false);
    const path = buildGuidePath(0, 0, 40, 30, hill);
    for (let v = 0; v < path.positions.length / 3; v++) {
      const wx = path.positions[v * 3]!;
      const wz = path.positions[v * 3 + 2]!;
      assertCloseTo(path.positions[v * 3 + 1]! + path.baseY, hill(wx, wz) + GUIDE_PATH_OFFSET, 5);
    }
    const n = path.positions.length / 3;
    const endX = (path.positions[(n - 1) * 3]! + path.positions[(n - 2) * 3]!) / 2;
    const endZ = (path.positions[(n - 1) * 3 + 2]! + path.positions[(n - 2) * 3 + 2]!) / 2;
    assertCloseTo(endX, 40, 3);
    assertCloseTo(endZ, 30, 3);
  });

  test("arrow visibility: in-view test and hysteresis without flicker", () => {
    const eye = { x: 0, y: 2, z: 0 };
    const fwd = { x: 0, y: 0, z: 1 };
    const fov = Math.PI / 3;
    assert.equal(waypointInView(eye, fwd, { x: 0, y: 2, z: 50 }, fov, 16 / 9), true);
    assert.equal(waypointInView(eye, fwd, { x: 0, y: 2, z: -50 }, fov, 16 / 9), false, "behind");
    assert.equal(waypointInView(eye, fwd, { x: 200, y: 2, z: 50 }, fov, 16 / 9), false, "far right");
    // Near the frame edge: inside the frame but outside the inner margin.
    const edge = { x: Math.tan(fov / 2) * (16 / 9) * 0.9 * 50, y: 2, z: 50 };
    assert.equal(waypointInView(eye, fwd, edge, fov, 16 / 9, 1), true);
    assert.equal(waypointInView(eye, fwd, edge, fov, 16 / 9, ARROW_IN_MARGIN), false);
    const st = new WaypointArrowState();
    assert.equal(st.step(0.1, false, false, true), false, "not shown instantly");
    for (let i = 0; i < 5; i++) st.step(0.1, false, false, true);
    assert.equal(st.visible, true, "shown once clearly off-screen");
    // Grazing the edge (in frame, not inside inner margin) keeps the current state: no flicker.
    for (let i = 0; i < 20; i++) assert.equal(st.step(0.1, false, i % 2 === 0, true), true);
    for (let i = 0; i < 5; i++) st.step(0.1, true, true, true);
    assert.equal(st.visible, false, "hidden once clearly in view");
    st.step(1, false, false, false);
    assert.equal(st.visible, false, "disabled (hard mode / no target) hides at once");
  });

  test("beam pulse: rhythmic glow and a band that travels upward each period", () => {
    const a = beamPulse(0);
    assert.ok(a.glow > 1.2, "launch peak");
    const mid = beamPulse(BEAM_PULSE_PERIOD / 2);
    assert.ok(mid.glow < a.glow && mid.glow >= 0.75);
    let last = -1;
    for (let k = 1; k < 10; k++) {
      const p = beamPulse((k / 10) * BEAM_PULSE_PERIOD);
      assert.ok(p.band > last, "band rises");
      last = p.band;
    }
    assert.ok(beamPulse(0.3 * BEAM_PULSE_PERIOD).bandOpacity > beamPulse(0.9 * BEAM_PULSE_PERIOD).bandOpacity, "fades as it climbs");
    assertCloseTo(beamPulse(0.4).glow, beamPulse(0.4 + BEAM_PULSE_PERIOD).glow, 9, "periodic");
  });
});

await finish();
