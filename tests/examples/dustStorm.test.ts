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
import { Material, PARTICLE_FULL_SIM_SHADER, PARTICLE_RENDER_SHADER } from "@forge/engine";
import { assertCloseTo, finish, group, test } from "selrun";
import {
  devilGrainSizeMultiplier,
  DEVIL_SIZE_RANGE,
  DEVIL_GRAIN_MAX_SIZE,
  DEVIL_SWIRL_OVER_CORE,
  devilSwirlRadius,
  devilCoreHalfWidth,
  devilTerrainTint,
  STORM_TERRAIN_TINTS,
  DevilPebbles,
  pebbleLiftRadius,
  devilLiftStrength,
  PEBBLE_MAX_LIFT_RADIUS,
  PEBBLE_LIFT_STRENGTH,
  PEBBLE_POOL,
  devilRoverForceAt,
  devilWander,
  devilAxisCurve,
  devilAxisAt,
  devilAxisLag,
  devilBulge,
  devilBulgeScale,
  DEVIL_BULGE_GAIN_MAX,
  DEVIL_WANDER_MAX,
  devilColumnSpread,
  DEVIL_SWIRL_ACCEL_FE21,
  DEVIL_AXIS_PULL_FE21,
  DEVIL_SWIRL_RADIUS_SCALE,
  DEVIL_CORE_CARD_WIDTH,
  DEVIL_FADE_NEAR,
  devilCoreCardHalfWidth,
  devilFunnelProfile,
  devilShellFade,
  buildFunnelCard,
  CARD_VERTEX_COUNT,
  DEVIL_BASE_CLOUD,
  DEVIL_EMIT_CYCLE,
  DEVIL_GRAIN_END,
  DEVIL_SWIRL_MAX,
  devilBaseWind,
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
  devilParticleLook,
  devilFunnelSway,
  devilVortexLife,
  devilEmitRate,
  DEVIL_RF_BASE_PER_CORE,
  driftMoundHeightAt,
  driftMoundRadius,
  settleDriftMound,
  BEAM_RING_OFFSET,
  WaypointArrowState,
  beamPulse,
  BEAM_PULSE_PERIOD,
  buildDrapedRing,
  guidePathEnabled,
  waypointArrowEnabled,
  DEVIL_RULES,
  STORM_DUST_PALETTE,
  devilLifespan,
  devilEnvelope,
  devilSizeFactor,
  type DevilRules,
  BlownAwayTracker,
  BLOWN_AWAY_DISTANCE,
  STORM_STRENGTH,
  STORM_DIFFICULTIES,
  parseStormDifficulty,
  StormRunStats,
  stormRunSummary,
  formatDistance,
  DEVIL_SWIRL_CAP,
  STORM_GUST_PEAK,
  STORM_WIND_SPEED,
  StormField as _SF,
  DEVIL_LIFT_CEILING,
  DEVIL_LIFT_DAMPING,
  MARS_AIR_DENSITY,
  MARS_G,
  ROVER_REFERENCE_MASS,
  SAFE_STABLE_TIME,
  stormWindAccel,
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
  slot: 0,
  opacity: 1,
  fadeOut: 4,
  targetCore: overrides.coreRadius ?? 4,
  state: "free",
  orbit: null,
  endCause: null,
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
    const core = devilRoverForce(devilAt({ swirl: 31 }), 0.2, 0, undefined, undefined, 0, STORM_STRENGTH.expert);
    assert.ok(core.lift > 3.72, `strongest devils out-lift Mars gravity at the eye (${core.lift})`);
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
    assert.deepEqual(STORM_DIFFICULTY.easy, { onStuck: "soft", onFlip: "right", onBlownAway: "respawn", stormStrength: 30, timePenalty: 15 });
    assert.equal(STORM_DIFFICULTY.expert.onBlownAway, "lose");
    assert.equal(STORM_DIFFICULTY.expert.onStuck, "reset");
    assert.equal(STORM_DIFFICULTY.expert.onFlip, "reset");
    assert.equal(stormQualityForPlatform("ios"), "reduced");
    assert.equal(stormQualityForPlatform("macos"), "full");
    // iOS budget: sheet + every capped devil system stays at 28k particles, well under full.
    assert.ok(stormParticleBudget(STORM_QUALITY_TIERS.reduced) <= 28_000);
    // fe-21b: budget rebalanced from the sheet toward the swarm devils (10k sheet + 3 × 6k devils).
    assert.ok(STORM_QUALITY_TIERS.reduced.devilCapacity <= 6_000);
    assert.ok(STORM_QUALITY_TIERS.reduced.devils * STORM_QUALITY_TIERS.reduced.devilCapacity > STORM_QUALITY_TIERS.reduced.sheetCapacity, "most of the iOS budget is in the devils");
    assert.ok(STORM_QUALITY_TIERS.reduced.devilRate * 1.7 <= STORM_QUALITY_TIERS.reduced.devilCapacity * 1.3, "column rate fits its capacity");
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

  test("devil swarm (red-frontier vortex): wobbling axis, column/skirt frames, lifecycle, reusable look", () => {
    const devil = { id: 3, coreRadius: 4, swirl: -20 };
    // Wobble: base planted, top capped at 1.7 footprints.
    for (let t = 0; t < 60; t += 0.7) {
      const b = devilFunnelSway(devil, 0, t), top = devilFunnelSway(devil, 1, t);
      assert.equal(Math.hypot(b.x, b.z), 0);
      assert.ok(Math.hypot(top.x, top.z) <= devil.coreRadius * DEVIL_RF_BASE_PER_CORE * 1.7 + 1e-9);
    }
    // Column vs skirt frames, and the birth burst.
    const adult = { ...devil, age: 10, life: 30, fadeOut: 4 };
    const col = devilParticleLook(adult, 0, 2), skirt = devilParticleLook(adult, 0, 0);
    assert.ok(col.column && !skirt.column);
    assert.ok(col.vortex.radiusTop > col.vortex.radiusBase * 2 && col.vortex.radiusTop <= devil.coreRadius * 1.1, "swarm is tight at the ground and widens a little with height");
    assert.ok(col.vortex.spin < 0 && col.swirl < 0, "spin follows the devil");
    assert.ok(skirt.vortex.outward > 0 && skirt.vortex.height < 2, "skirt blasts outward at the ground");
    assert.equal(devilParticleLook({ ...adult, age: 0.1 }, 0, 1).column, false, "birth burst is skirt-only");
    // Growth: the column climbs out of the ground; dying thins it.
    assert.ok(devilVortexLife({ age: 0.2, life: 30 }).growth < 0.1);
    assertCloseTo(devilVortexLife({ age: 5, life: 30 }).growth, 1, 9);
    assert.ok(devilVortexLife({ age: 29.5, life: 30, fadeOut: 4 }).radiusScale < 0.5);
    assert.ok(devilEmitRate(1000, col, 1, false) <= 1000 && devilEmitRate(1000, col, 0, false) === 0);
    // Out-param reuse: no allocation per frame, same objects come back updated.
    const reuse = devilParticleLook(adult, 0, 2);
    const vRef = reuse.vortex;
    const again = devilParticleLook(adult, 0, 0, reuse);
    assert.equal(again, reuse);
    assert.equal(again.vortex, vRef);
    assert.equal(again.column, false);
    assert.ok(col.sizeEnd <= 0.55, "fine grain, not flakes");
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

  test("easy-only path and arrow", () => {
    assert.equal(guidePathEnabled("easy", true), true);
    assert.equal(guidePathEnabled("expert", true), false);
    assert.equal(guidePathEnabled("easy", false), false);
    assert.equal(waypointArrowEnabled("easy"), true);
    assert.equal(waypointArrowEnabled("expert"), false);
  });

  test("arrow visibility hysteresis without flicker (the on-screen test is targetOnScreen)", () => {
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

group("fe-19 devil dynamics", () => {
  const NONE: DevilRules = { ...DEVIL_RULES, bigConsumes: 0, orbitThenConsumed: 0, smallMerge: 0, combine: 0, separate: 0, oneDies: 0, orbitMin: 2, orbitMax: 2 };
  /** A field with two staged devils near the rover at the origin, past their fade-in. */
  const stage = (rules: Partial<DevilRules>, coreA: number, coreB: number, gap = 3) => {
    const field = new DustDevilField(6, 1234, { ...NONE, ...rules });
    const a = field.makeDevil(0, 0, coreA);
    field.devils.push(a);
    const b = field.makeDevil(gap, 0, coreB);
    field.devils.push(b);
    for (const d of field.devils) {
      d.age = 5;
      d.life = 80;
    }
    const run = (seconds: number) => {
      for (let t = 0; t < seconds; t += 0.05) field.step(0.05, 0, 0, 0, 0, 0);
    };
    return { field, a, b, run };
  };

  test("big meets small: consumed at once, the big one grows wider and stronger, the slot frees", () => {
    const { field, a, b, run } = stage({ bigConsumes: 1 }, 6, 2.5);
    const swirl0 = Math.abs(a.swirl);
    run(0.05);
    assert.equal(b.state, "dying");
    assert.equal(b.endCause, "consumed");
    run(4);
    assert.equal(field.byId(b.id), undefined, "removed once faded");
    assert.ok(a.coreRadius > 6.3 && a.coreRadius <= Math.hypot(6, 2.5) + 1e-6, `grew to ${a.coreRadius}`);
    assert.ok(Math.abs(a.swirl) > swirl0);
    assert.equal(field.bySlot(b.slot), undefined);
    assert.equal(field.ended.consumed, 1);
  });

  test("small orbits the big one, then is consumed — or dies out", () => {
    const eaten = stage({ orbitThenConsumed: 1 }, 6, 2.5);
    eaten.run(0.05);
    assert.equal(eaten.b.state, "orbiting");
    eaten.run(1);
    const r = Math.hypot(eaten.b.x - eaten.a.x, eaten.b.z - eaten.a.z);
    assertCloseTo(r, eaten.b.orbit!.radius, 3, "circles the host");
    eaten.run(1.2);
    assert.equal(eaten.b.endCause, "consumed");
    const died = stage({ orbitThenConsumed: 0 }, 6, 2.5);
    died.run(2.5);
    assert.equal(died.b.endCause, "orbit-died");
    assert.equal(died.a.targetCore, 6, "no growth when the small one just dies");
  });

  test("two small devils: merge at once, or orbit then combine / separate / one dies / both die", () => {
    const merge = stage({ smallMerge: 1 }, 2.5, 2.8);
    merge.run(0.05);
    assert.equal(merge.a.endCause, "merged", "the smaller is merged into the larger");
    assert.ok(merge.b.targetCore > 2.8);

    const combine = stage({ combine: 1 }, 2.5, 2.8);
    combine.run(0.05);
    assert.equal(combine.a.state, "orbiting");
    assert.equal(combine.b.state, "orbiting");
    combine.run(2.5);
    assert.equal(combine.field.ended.merged, 1);
    assert.equal(combine.b.state, "free");

    const separate = stage({ separate: 1 }, 2.5, 2.8);
    separate.run(2.1);
    assert.equal(separate.a.state, "free");
    assert.equal(separate.b.state, "free");
    assert.ok(Math.hypot(separate.a.x - separate.b.x, separate.a.z - separate.b.z) > 5, "flung apart");

    const one = stage({ oneDies: 1 }, 2.5, 2.8);
    one.run(2.1);
    assert.equal(one.a.endCause, "orbit-died");
    assert.equal(one.b.state, "free");

    const both = stage({}, 2.5, 2.8);
    both.run(2.1);
    assert.equal(both.a.endCause, "orbit-died");
    assert.equal(both.b.endCause, "orbit-died");
  });

  test("dying devils fade (no pop) and never share a slot; wide similar devils pass through", () => {
    const { a, b, run } = stage({ bigConsumes: 1 }, 6, 2.5);
    const env0 = devilEnvelope(b);
    run(0.05);
    assert.ok(Math.abs(devilEnvelope(b) - env0) < 0.05, "envelope continuous at the moment of consumption");
    const big = stage({ bigConsumes: 1, smallMerge: 1 }, 6, 5.5);
    big.run(1);
    assert.equal(big.a.state, "free");
    assert.equal(big.b.state, "free");
    assert.notEqual(a.slot, b.slot);
  });

  test("size → wind: wider devils swirl, push and lift harder; narrow ones live short", () => {
    assert.ok(devilSizeFactor(2) < devilSizeFactor(4.5) && devilSizeFactor(4.5) < devilSizeFactor(8));
    assertCloseTo(devilSizeFactor(4.5), 1, 9);
    // Same seed, same rolls: only the width differs.
    const narrow = new DustDevilField(6, 77).makeDevil(0, 0, 2);
    const wide = new DustDevilField(6, 77).makeDevil(0, 0, 7);
    // fe-29: the size factor scales the swirl, clamped to the measured 10..DEVIL_SWIRL_CAP m/s range.
    const ratio = Math.abs(wide.swirl) / Math.abs(narrow.swirl);
    assert.ok(ratio > 1.3 && ratio <= devilSizeFactor(7) / devilSizeFactor(2) + 1e-9, `${ratio}`);
    assert.ok(narrow.life < wide.life, "narrow devil spawned with the shorter life");
    for (const d of [narrow, wide]) {
      d.age = 10;
      d.life = 60;
    }
    const fn = devilRoverForce(narrow, narrow.coreRadius * 0.5, 0);
    const fw = devilRoverForce(wide, wide.coreRadius * 0.5, 0);
    assert.ok(Math.hypot(fw.ax, fw.az) > Math.hypot(fn.ax, fn.az) * 1.5, "stronger push");
    assert.ok(fw.lift > fn.lift, "stronger lift");
    assert.ok(Math.abs(fw.yawAccel) > Math.abs(fn.yawAccel));
    assert.ok(devilLifespan(2, 1) < 17, "narrow devils die quickly");
    assert.ok(devilLifespan(7, 0) > 40);
  });

  test("per-devil variety and deterministic replay (with interactions) under the fixed seed", () => {
    const simulate = () => {
      const field = new DustDevilField(6);
      const storm = new StormField();
      const w = { x: 0, z: 0 };
      const slotsOk: boolean[] = [];
      for (let t = 0; t < 900; t += 0.1) {
        storm.wind(t, w);
        field.step(0.1, storm.intensity(t), w.x, w.z, 0, 0);
        const slots = field.devils.map((d) => d.slot);
        slotsOk.push(new Set(slots).size === slots.length && slots.every((s) => s >= 0 && s < 6));
      }
      return { field, slotsOk };
    };
    const a = simulate();
    const b = simulate();
    assert.deepEqual(a.field.devils, b.field.devils);
    assert.deepEqual(a.field.ended, b.field.ended);
    assert.ok(a.slotsOk.every(Boolean), "slots unique and in range");
    const e = a.field.ended;
    assert.ok(e.consumed + e.merged + e["orbit-died"] > 0, `interactions happen in play: ${JSON.stringify(e)}`);
    // Variety across spawns: widths, densities and lifespans differ.
    const f = new DustDevilField(6);
    const ds = Array.from({ length: 12 }, () => f.makeDevil(0, 0, 2));
    assert.ok(new Set(ds.map((d) => d.opacity.toFixed(3))).size > 6, "opacity varies");
    // Reset replays the same spawn stream.
    const r1 = new DustDevilField(6);
    r1.step(0.1, 1, 10, 0, 0, 0);
    const first = JSON.stringify(r1.devils);
    for (let i = 0; i < 300; i++) r1.step(0.1, 1, 10, 0, 0, 0);
    r1.reset();
    r1.step(0.1, 1, 10, 0, 0, 0);
    assert.equal(JSON.stringify(r1.devils), first);
    const widths = new Set(JSON.parse(first).map((d: DustDevil) => d.coreRadius.toFixed(2)));
    assert.ok(widths.size >= 4, "spawned widths vary");
  });

  test("dust colours: palette from the scene, per-particle variation in the sim", () => {
    const lum = (c: { r: number; g: number; b: number }) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
    assert.ok(lum(STORM_DUST_PALETTE.rock) < lum(STORM_DUST_PALETTE.dust), "rock tone darker than the dust");
    assert.ok(STORM_DUST_PALETTE.sheetVariation > 0 && STORM_DUST_PALETTE.devilVariation > 0);
    assert.ok(PARTICLE_FULL_SIM_SHADER.includes("colorVariation: f32,"));
    assert.ok(PARTICLE_FULL_SIM_SHADER.includes("params.colorAlt.rgb"));
  });
});

group("fe-19 review: ending a devil never raises its envelope", () => {
  test("a consumed devil already fading out keeps its shorter natural ramp", () => {
    const f = new DustDevilField(4, 7);
    const big = f.makeDevil(0, 0, 7, 0);
    const small = f.makeDevil(0.5, 0, 2, 1);
    small.age = small.life - 0.5; // already fading out naturally
    f.devils.push(big, small);
    const before = devilEnvelope(small);
    (f as unknown as { absorb(a: unknown, b: unknown, c: string): void }).absorb(big, small, "consumed");
    assert.ok(devilEnvelope(small) <= before + 1e-9, `envelope rose ${before} -> ${devilEnvelope(small)}`);
  });
});

group("fe-21d devil base cloud", () => {
  const adult = { id: 5, coreRadius: 4, swirl: 18, age: 10, life: 30, fadeOut: 4 };
  test("one frame per cycle is a short, wide, slow-swirling, long-lived ground cloud", () => {
    const kinds = Array.from({ length: DEVIL_EMIT_CYCLE }, (_, f) => devilParticleLook(adult, 0, f));
    assert.equal(kinds.filter((k) => k.base).length, 1);
    assert.equal(kinds.filter((k) => !k.base && !k.column).length, 1, "skirt still present");
    const base = kinds.find((k) => k.base)!, col = kinds.find((k) => k.column)!, skirt = kinds.find((k) => !k.base && !k.column)!;
    assert.ok(base.vortex.height < 2 && base.vortex.height === DEVIL_BASE_CLOUD.height, "short");
    assert.ok(base.lifeMin >= 2 && base.lifeMax <= 3, "fe-21f: 2-3 s so the tail can trail downwind");
    assert.ok(base.vortex.radiusTop > col.vortex.radiusBase * 3, "wide");
    assert.ok(Math.abs(base.vortex.spin) < Math.abs(col.vortex.spin) * 0.5 && Math.sign(base.vortex.spin) === 1, "slow, same sense");
    assert.ok(base.vortex.outward < skirt.vortex.outward, "drifts, not blasted");
    assert.ok(base.lifeMin > skirt.lifeMax && base.speedMax < 1, "lingers low");
    assert.ok(DEVIL_BASE_CLOUD.windHeight > base.vortex.height, "wind band covers the cloud");
    assert.equal(devilParticleLook({ ...adult, age: 0.1 }, 0, 1).base, false, "birth burst is skirt-only");
  });
  test("emit weights keep a full-vigour devil's live count inside its capacity", () => {
    for (const q of Object.values(STORM_QUALITY_TIERS)) {
      let live = 0;
      for (let f = 0; f < DEVIL_EMIT_CYCLE; f++) {
        const look = devilParticleLook(adult, 0, f);
        live += (devilEmitRate(q.devilRate, look, 1, false) / DEVIL_EMIT_CYCLE) * ((look.lifeMin + look.lifeMax) / 2);
      }
      assert.ok(live <= q.devilCapacity, `live ${live.toFixed(0)} > ${q.devilCapacity}`);
    }
  });
  test("ground wind follows the storm wind and grows sharply in gusts", () => {
    const lull = devilBaseWind(10, 0, LULL_INTENSITY), peak = devilBaseWind(26, 0, 1);
    assert.ok(lull.x > 0 && lull.z === 0);
    assert.ok(peak.x > lull.x * 10, `gust ${peak.x} vs lull ${lull.x}`);
    const dir = devilBaseWind(-3, 4, 0.8);
    assertCloseTo(Math.atan2(dir.z, dir.x), Math.atan2(4, -3), 9);
    assert.equal(DEVIL_SWIRL_MAX > 0, true);
    assert.match(PARTICLE_FULL_SIM_SHADER, /params\.groundWindHeight/);
    assert.match(PARTICLE_RENDER_SHADER, /params\.flags & 2u/, "opt-in soft sprite bit");
  });
});

group("fe-22 old-devil core wrapped by a narrower swirl", () => {
  const adult = { id: 3, coreRadius: 5, swirl: 18, age: 10, life: 30, fadeOut: 4 };
  const col = devilParticleLook(adult, 0, 3);
  test("swirl column radius is 50-60% of fe-21's", () => {
    assert.ok(DEVIL_SWIRL_RADIUS_SCALE >= 0.5 && DEVIL_SWIRL_RADIUS_SCALE <= 0.6);
    const fe21Top = adult.coreRadius * DEVIL_RF_BASE_PER_CORE * 1.1, fe21Base = adult.coreRadius * DEVIL_RF_BASE_PER_CORE * 0.35;
    assertCloseTo(col.vortex.radiusTop, fe21Top * DEVIL_SWIRL_RADIUS_SCALE, 9);
    assertCloseTo(col.vortex.radiusBase, fe21Base * DEVIL_SWIRL_RADIUS_SCALE, 9);
    const base = devilParticleLook(adult, 0, 1);
    assertCloseTo(base.vortex.radiusTop, adult.coreRadius * DEVIL_RF_BASE_PER_CORE * DEVIL_BASE_CLOUD.radiusTop, 9);
  });
  test("core cards sit inside the swirl, the wispy layer reaches about its radius", () => {
    for (const u of [0.2, 0.5, 1]) {
      const swirlR = col.vortex.radiusBase + (col.vortex.radiusTop - col.vortex.radiusBase) * u;
      const core = devilCoreCardHalfWidth(adult.coreRadius, u, DEVIL_CORE_CARD_WIDTH.core);
      const outer = devilCoreCardHalfWidth(adult.coreRadius, u, DEVIL_CORE_CARD_WIDTH.outer);
      assert.ok(core > 0 && core <= swirlR * 0.9 + 0.2, `dense core within the swirl at u=${u}`);
      assert.ok(outer > core && outer <= swirlR * 1.3 + 0.3, `wispy layer wraps the core, not much wider than the swirl at u=${u}`);
    }
    assertCloseTo(devilCoreCardHalfWidth(4, 0.5, 1), devilFunnelProfile(0.5) * 4, 9);
  });
  test("core card follows the swirl axis and stays visible near the camera", () => {
    const m = buildFunnelCard({ ...adult, x: 0, z: 0 }, 60, DEVIL_CORE_CARD_WIDTH.core, 7, 30, 0, 0);
    assert.equal(m.positions.length, CARD_VERTEX_COUNT * 3);
    // Middle column of the top ring is the swayed axis.
    const top = (CARD_VERTEX_COUNT - 2) * 3;
    const sway = devilFunnelSway(adult, 1, 7);
    assertCloseTo(m.positions[top]!, sway.x, 4);
    assertCloseTo(m.positions[top + 2]!, sway.z, 4);
    assert.equal(devilShellFade(DEVIL_FADE_NEAR), 0);
    assert.ok(DEVIL_FADE_NEAR <= 5 && devilShellFade(25) === 1, "visible inside the wrap from mid range");
  });
  test("fe-22c: steady-state radial spread of column grains is ~55% of fe-21 and wraps the cards", () => {
    for (const core of [2.5, 5, 8]) {
      const d = { id: 3, coreRadius: core, swirl: 18 };
      const old = devilColumnSpread(d, { swirlAccel: DEVIL_SWIRL_ACCEL_FE21, axisPull: DEVIL_AXIS_PULL_FE21, radiusScale: 1 });
      const nu = devilColumnSpread(d);
      const ratio = nu.p90 / old.p90;
      assert.ok(ratio > 0.45 && ratio < 0.62, `core ${core}: p90 ratio ${ratio.toFixed(2)}`);
      assert.ok(nu.p90 < 4, `core ${core}: p90 ${nu.p90.toFixed(2)} m`);
      // Both cards stay inside the grains' 90th-percentile radius all the way up.
      for (const u of [0.1, 0.5, 1]) assert.ok(devilCoreHalfWidth(core, u) * DEVIL_CORE_CARD_WIDTH.outer < nu.p90 * 1.05, `core ${core} u ${u}: card inside`);
    }
  });
  test("transparent depthWrite opt-out (the pale-band fix) defaults to the old behaviour", () => {
    assert.equal(new Material({ transparent: true }).depthWrite, true);
    assert.equal(new Material({ transparent: true, depthWrite: false }).clone().depthWrite, false);
  });
});

group("fe-22d dancing devils", () => {
  const devil = { id: 7, coreRadius: 5, swirl: 18 };
  test("base wanders smoothly within bounds and differs per devil", () => {
    let prev = devilWander(devil, 0, { x: 0, z: 0 });
    let maxStep = 0, maxR = 0, travelled = 0;
    for (let t = 0.1; t < 120; t += 0.1) {
      const w = devilWander(devil, t, { x: 0, z: 0 });
      const step = Math.hypot(w.x - prev.x, w.z - prev.z);
      maxStep = Math.max(maxStep, step); travelled += step; maxR = Math.max(maxR, Math.hypot(w.x, w.z));
      prev = w;
    }
    assert.ok(maxR <= Math.min(DEVIL_WANDER_MAX, 5 * 1.2) + 1e-9 && maxR > 1.5, `wander radius ${maxR}`);
    assert.ok(maxStep < 0.8, `smooth (max 0.1 s step ${maxStep})`);
    assert.ok(travelled > 20, "actually moves");
    const other = devilWander({ id: 8, coreRadius: 5 }, 10);
    const mine = devilWander(devil, 10);
    assert.ok(Math.hypot(other.x - mine.x, other.z - mine.z) > 1e-3, "varied per devil");
  });
  test("axis lag: the top replays the base's past position; mid replays half the lag", () => {
    for (const t of [3, 17.5, 40]) {
      const c = devilAxisCurve(devil, t);
      const lag = devilAxisLag(devil.id);
      const past = devilWander(devil, t - lag), half = devilWander(devil, t - lag / 2);
      const sway = devilFunnelSway(devil, 1, t);
      const top = devilAxisAt(c, 1), mid = devilAxisAt(c, 0.5);
      // world top (base + offset) = base position lag seconds ago (+ the small top wobble)
      assertCloseTo(c.baseX + top.x, past.x + sway.x, 6);
      assertCloseTo(c.baseZ + top.z, past.z + sway.z, 6);
      // mid sits on the half-lagged base, plus the snake (sin 2π·0.5 = 0)
      assertCloseTo(c.baseX + mid.x, half.x, 6);
      assertCloseTo(c.baseZ + mid.z, half.z, 6);
      const ground = devilAxisAt(c, 0);
      assert.ok(Math.hypot(ground.x, ground.z) < 1e-3, "axis anchored at the base");
    }
    assert.ok(devilAxisLag(1) !== devilAxisLag(2) && devilAxisLag(1) >= 1.2 && devilAxisLag(1) <= 2.4);
  });
  test("bulges are bounded, come at random intervals and return to base size", () => {
    let peak = 0, swells = 0, inSwell = false, zeroTime = 0;
    for (let t = 0; t < 300; t += 0.05) {
      const g = devilBulge(devil.id, t);
      assert.ok(g >= 0 && g <= DEVIL_BULGE_GAIN_MAX + 1e-9);
      peak = Math.max(peak, g);
      if (g > 0.05 && !inSwell) { swells++; inSwell = true; }
      if (g === 0) { inSwell = false; zeroTime += 0.05; }
    }
    assert.ok(peak >= 0.45, `swells reach ~1.5x+ (peak ${peak})`);
    assert.ok(swells >= 15 && swells <= 60, `random intervals (${swells} in 300 s)`);
    assert.ok(zeroTime > 100, "back to exactly base size between swells");
    const c = { bulge: 0.8 };
    assertCloseTo(devilBulgeScale(c, 0.5), 1.8, 9);
    assertCloseTo(devilBulgeScale(c, 0), 1, 9);
    assertCloseTo(devilBulgeScale(c, 1), 1, 9);
  });
  test("deterministic per devil id and time", () => {
    const a = devilAxisCurve(devil, 12.34), b = devilAxisCurve({ ...devil }, 12.34);
    assert.deepEqual(a, b);
    const look1 = devilParticleLook({ ...devil, age: 10, life: 30 }, 12.34, 3);
    const look2 = devilParticleLook({ ...devil, age: 10, life: 30 }, 12.34, 3);
    assert.deepEqual(look1, look2);
    assert.equal(look1.vortex.bendX, look1.curve.bendX, "grains spawn on the same curve");
    const skirt = devilParticleLook({ ...devil, age: 10, life: 30 }, 12.34, 0);
    assert.equal(skirt.vortex.bendX, 0, "skirt/base cloud stay on the (wandering) ground point");
  });
});

group("fe-22e rover push follows the wandered base", () => {
  test("force at the visible base offset equals the unwandered force at the sim position", () => {
    const field = new DustDevilField(1);
    const d = field.makeDevil(40, -20, 5, 0);
    d.age = 10; d.life = 40;
    for (const t of [2, 11.5, 33]) {
      const w = devilWander(d, t);
      assert.ok(Math.hypot(w.x, w.z) > 0.1, "base has actually wandered");
      for (const [rx, rz] of [[1, 0], [0, 3], [-2.5, 1], [7, -4]]) {
        const atVisible = devilRoverForceAt(d, t, d.x + w.x + rx!, d.z + w.z + rz!);
        const ref = devilRoverForce(d, d.x + rx!, d.z + rz!);
        assert.deepEqual(atVisible, ref);
      }
      // Standing in the visible eye gets the eye's lift; the old sim spot (now off-centre) does not match.
      const eye = devilRoverForceAt(d, t, d.x + w.x, d.z + w.z);
      assert.deepEqual(eye, devilRoverForce(d, d.x, d.z));
    }
  });
});

group("fe-22f random sizes, full-width core, terrain tint, pebbles", () => {
  test("grain sizes are a continuous wide distribution with a sane max", () => {
    const n = 2000, xs: number[] = [];
    for (let i = 0; i < n; i++) xs.push(devilGrainSizeMultiplier((i + 0.5) / n));
    for (let i = 1; i < n; i++) assert.ok(xs[i]! >= xs[i - 1]!, "monotone in r");
    assertCloseTo(xs[0]!, DEVIL_SIZE_RANGE.min, 2);
    assert.ok(Math.abs(xs[n - 1]! - DEVIL_SIZE_RANGE.max) < 0.05);
    assert.ok(DEVIL_SIZE_RANGE.max / DEVIL_SIZE_RANGE.min >= 8, "wide");
    // Continuous: no gaps (largest step tiny) and no two-value split: >= 50 distinct 2-decimal sizes.
    let maxStep = 0; for (let i = 1; i < n; i++) maxStep = Math.max(maxStep, xs[i]! - xs[i - 1]!);
    assert.ok(maxStep < 0.02, `no gaps (${maxStep})`);
    assert.ok(new Set(xs.map((x) => x.toFixed(2))).size > 50);
    const median = xs[n / 2]!;
    assert.ok(median < (DEVIL_SIZE_RANGE.min + DEVIL_SIZE_RANGE.max) / 2, "skewed toward fine grains");
    assert.ok(DEVIL_GRAIN_END * DEVIL_SIZE_RANGE.max <= DEVIL_GRAIN_MAX_SIZE, "max sprite capped");
  });
  test("core spans the devil; the swirl is ~1.15x the core", () => {
    assertCloseTo(DEVIL_SWIRL_OVER_CORE, 1.15, 9);
    for (const core of [2.5, 5, 8]) {
      const spread = devilColumnSpread({ id: 3, coreRadius: core, swirl: 18 });
      assert.ok(Math.abs(devilSwirlRadius(core) - spread.p90) / spread.p90 < 0.1, `swirl fit at core ${core}`);
      const ratio = spread.p90 / devilCoreHalfWidth(core, 0.5);
      assert.ok(ratio > 1.0 && ratio < 1.3, `outer/core ${ratio.toFixed(2)} ≈ 1.15`);
      for (const u of [0, 0.5, 1]) assert.ok(devilCoreHalfWidth(core, u) * DEVIL_CORE_CARD_WIDTH.outer < spread.p90 * 1.05, "core stays under the swirl");
    }
  });
  test("dust colour follows the terrain under the base", () => {
    const flat = devilTerrainTint(0), mid = devilTerrainTint(0.3), steep = devilTerrainTint(1.2);
    const ratio = (c: { r: number; g: number; b: number }, t: { r: number; g: number; b: number }) => [c.r / t.r, c.g / t.g, c.b / t.b];
    for (const v of ratio(flat.color, STORM_TERRAIN_TINTS.sand)) assertCloseTo(v, 0.3, 6);
    for (const v of ratio(steep.color, STORM_TERRAIN_TINTS.rock)) assertCloseTo(v, 0.3, 6);
    assert.notDeepEqual(mid.color, flat.color);
    assert.ok(steep.color.r < flat.color.r && steep.alt.r < steep.color.r + 0.05, "basalt slopes darker; alternate darker still");
  });
  test("pebble pickup: strength and size thresholds, never boulders, carried then dropped", () => {
    assert.equal(pebbleLiftRadius(PEBBLE_LIFT_STRENGTH - 0.01), 0, "weak devils lift nothing");
    assert.ok(pebbleLiftRadius(PEBBLE_LIFT_STRENGTH) > 0);
    assert.ok(pebbleLiftRadius(5) <= PEBBLE_MAX_LIFT_RADIUS && PEBBLE_MAX_LIFT_RADIUS < 0.9, "boulders (≥0.9 m) never lifted");
    assert.ok(PEBBLE_POOL.reduced <= 8);
    const ground = () => 0;
    const field = new DustDevilField(1);
    const d = field.makeDevil(0, 0, 5, 0);
    d.swirl = 28; d.age = 10; d.life = 40; d.state = "free";
    const pool = new DevilPebbles(3);
    const [small, big, far] = pool.pebbles;
    Object.assign(small!, { x: 1, z: 0, radius: 0.1 });
    Object.assign(big!, { x: 0, z: 1, radius: 0.38 });
    Object.assign(far!, { x: 40, z: 0, radius: 0.05 });
    const at = () => ({ x: 0, z: 0 });
    assert.ok(devilLiftStrength(d) > PEBBLE_LIFT_STRENGTH);
    pool.step(1 / 30, [d], at, ground, 0, 0);
    assert.equal(small!.state, "carried");
    assert.equal(big!.state, "ground", "too big for any devil");
    assert.equal(far!.state, "ground", "out of the swirl's reach");
    let maxH = 0;
    for (let i = 0; i < 30; i++) { pool.step(1 / 30, [d], at, ground, 0, 0); maxH = Math.max(maxH, small!.y); }
    assert.ok(maxH > 1, "lifted and carried round");
    d.age = d.life; // weakens to nothing
    pool.step(1 / 30, [d], at, ground, 0, 0);
    assert.equal(small!.state, "falling", "dropped as it weakens");
    for (let i = 0; i < 600 && small!.state !== "ground"; i++) pool.step(1 / 30, [], at, ground, 0, 0);
    assert.equal(small!.state, "ground", "lands");
  });
});

/** Integrate the rover's height above ground under devil lift + Mars gravity (the scene's model). */
function flyColumn(d: DustDevil, mass: number, xAt: (t: number) => number, seconds: number, strength: number = STORM_STRENGTH.expert) {
  let y = 0;
  let vy = 0;
  let maxY = 0;
  const trace: number[] = [];
  const dt = 1 / 60;
  for (let t = 0; t < seconds; t += dt) {
    const f = devilRoverForce(d, xAt(t), 0, undefined, mass, y, strength);
    vy += (f.lift - MARS_G) * dt;
    if (f.lift > 0 && vy > 0) vy -= DEVIL_LIFT_DAMPING * vy * dt;
    y += vy * dt;
    if (y <= 0) {
      y = 0;
      vy = Math.max(0, vy);
    }
    maxY = Math.max(maxY, y);
    trace.push(y);
  }
  return { y, maxY, trace };
}

group("fe-29 force-based wind and blown-away rule", () => {
  test("every wind term is real drag ½ρv²CdA × STORM_STRENGTH / mass", () => {
    const d = devilAt();
    const ref = devilRoverForce(d, 2, 0, undefined, ROVER_REFERENCE_MASS);
    const heavy = devilRoverForce(d, 2, 0, undefined, ROVER_REFERENCE_MASS * 2);
    for (const k of ["lift", "ax", "az", "yawAccel", "rollAccel"] as const) assertCloseTo(heavy[k], ref[k] / 2, 9);
    const v = devilTangentialSpeed(d, 6);
    const edge = devilRoverForce(d, 6, 0, undefined, ROVER_REFERENCE_MASS, 0, 1);
    assertCloseTo(edge.az * ROVER_REFERENCE_MASS, 0.5 * MARS_AIR_DENSITY * 1.2 * 6 * v * v, 6);
    // Real Mars (strength 1): a peak gust is ~0.06 m/s² — imperceptible.
    assert.ok(stormWindAccel(STORM_GUST_PEAK, 0, 0, 0, 1025, undefined, STORM_STRENGTH.real).x < 0.08);
    const g1 = stormWindAccel(STORM_WIND_SPEED, 0, 0, 0, 1025);
    const g2 = stormWindAccel(STORM_WIND_SPEED, 0, 0, 0, 2050);
    assert.ok(g1.x > 0.8 && g1.x < 2, `mean storm wind shoves noticeably on easy (${g1.x})`);
    assertCloseTo(g2.x, g1.x / 2, 9);
    assert.ok(stormWindAccel(STORM_WIND_SPEED, 0, 0, 0, 1025, undefined, STORM_STRENGTH.expert).x > g1.x, "hard is stormier");
    assert.equal(stormWindAccel(10, 0, 10, 0).x, 0, "no push moving with the wind");
    assert.ok(STORM_STRENGTH.expert > STORM_STRENGTH.easy && STORM_DIFFICULTY.expert.stormStrength === STORM_STRENGTH.expert);
  });

  test("wind speeds stay in the measured Mars range", () => {
    const f = new _SF();
    let peak = 0;
    for (let t = 0; t < 600; t += 0.25) peak = Math.max(peak, Math.hypot(f.wind(t).x, f.wind(t).z));
    assert.ok(peak <= STORM_GUST_PEAK + 1e-9 && peak > 25, `gust peak ${peak}`);
    const field = new DustDevilField(6, 5);
    for (let i = 0; i < 40; i++) {
      const dv = field.makeDevil(0, 0, 1 + (i % 8));
      assert.ok(Math.abs(dv.swirl) >= 10 && Math.abs(dv.swirl) <= DEVIL_SWIRL_CAP, `swirl ${dv.swirl}`);
    }
  });

  test("only strong devils near the eye lift; a heavier rover lifts less; too heavy never leaves the ground", () => {
    assert.equal(flyColumn(devilAt({ swirl: 20 }), 1025, () => 0.3, 6, STORM_STRENGTH.easy).maxY, 0, "a moderate devil can't lift on easy");
    assert.equal(flyColumn(devilAt({ swirl: 31 }), 1025, () => 3.5, 6).maxY, 0, "not at the core's rim");
    const d = devilAt({ swirl: 31 });
    const light = flyColumn(d, 1025, () => 0.3, 6);
    const heavy = flyColumn(d, 1200, () => 0.3, 6);
    const tank = flyColumn(d, 2500, () => 0.3, 6);
    assert.ok(light.maxY > heavy.maxY, `${light.maxY} > ${heavy.maxY}`);
    assert.equal(tank.maxY, 0);
  });

  test("lift is sustained inside the eye (no 4 m cap, bounded below the ceiling) and the rover falls on leaving", () => {
    const d = devilAt({ swirl: 31 });
    d.life = 1000;
    const stay = flyColumn(d, 1025, () => 0.3, 12);
    assert.ok(stay.maxY > 4, `climbs past the old 4 m cap (${stay.maxY})`);
    assert.ok(stay.maxY < DEVIL_LIFT_CEILING, "bounded");
    assert.ok(stay.trace.slice(-120).every((y) => y > 3), "still aloft after 10 s in the eye");
    const leave = flyColumn(d, 1025, (t) => (t < 6 ? 0.3 : 12), 12);
    assert.equal(leave.y, 0, "falls back once out of the vortex");
  });

  test("four difficulties: hidden strength rises, ?difficulty parses with hard = expert, Easy/Advanced respawn and Expert/Unreal lose", () => {
    const k = STORM_DIFFICULTIES.map((d) => STORM_DIFFICULTY[d].stormStrength);
    assert.deepEqual([...STORM_DIFFICULTIES], ["easy", "advanced", "expert", "unreal"]);
    assert.ok(k.every((v, i) => i === 0 || v > k[i - 1]!), `${k}`);
    assert.deepEqual(STORM_DIFFICULTIES.map((d) => STORM_DIFFICULTY[d].onBlownAway), ["respawn", "respawn", "lose", "lose"]);
    assert.equal(parseStormDifficulty("hard"), "expert");
    assert.equal(parseStormDifficulty("UNREAL"), "unreal");
    assert.equal(parseStormDifficulty("advanced"), "advanced");
    assert.equal(parseStormDifficulty(null), "easy");
    assert.equal(parseStormDifficulty("nope"), "easy");
    // Easy is closest to real: even the strongest capped devil cannot lift the rover at the eye.
    assert.ok(devilRoverForce(devilAt({ swirl: DEVIL_SWIRL_CAP }), 0, 0, undefined, 1025, 0, STORM_STRENGTH.easy).lift < MARS_G);
    // Unreal is wild: an ordinary devil throws it.
    assert.ok(devilRoverForce(devilAt({ swirl: 22 }), 0.5, 0, undefined, 1025, 0, STORM_STRENGTH.unreal).lift > MARS_G);
  });

  test("run stats: distance skips teleports, maxima, lift episodes; summary rows", () => {
    const st = new StormRunStats();
    const base = { clearance: 0, speed: 3, wind: 12, lifted: false };
    for (let i = 0; i <= 10; i++) st.step({ ...base, x: i, z: 0 });
    st.step({ ...base, x: 200, z: 0 }); // respawn jump: not driving
    st.step({ ...base, x: 201, z: 0, speed: 9, wind: 28 });
    st.step({ ...base, x: 202, z: 0, clearance: 6.4, lifted: true });
    st.step({ ...base, x: 203, z: 0, clearance: 7, lifted: true });
    st.step({ ...base, x: 204, z: 0 });
    st.step({ ...base, x: 205, z: 0, clearance: 2, lifted: true });
    assertCloseTo(st.distance, 15, 9);
    assert.equal(st.timesLifted, 2);
    assert.equal(st.maxHeight, 7);
    assert.equal(st.topSpeed, 9);
    assert.equal(st.maxWind, 28);
    st.respawns = 1;
    const sum = stormRunSummary({ result: "lost", reason: "BLOWN AWAY", difficulty: "expert", time: 125.4, reached: 2, total: 5, seed: 42, stats: st });
    assert.equal(sum.title, "Lost — Blown away");
    const rows = Object.fromEntries(sum.rows);
    assert.equal(rows["Difficulty"], "Expert");
    assert.equal(rows["Time taken"], "2:05");
    assert.equal(rows["Waypoints reached"], "2 / 5");
    assert.equal(rows["Respawns used"], "1");
    assert.equal(rows["Times lifted / thrown"], "2");
    assert.equal(rows["Seed"], "42");
    assert.equal(formatDistance(15), "15 m");
    assert.equal(formatDistance(2345), "2.35 km");
    assert.equal(stormRunSummary({ result: "completed", reason: null, difficulty: "easy", time: 1, reached: 5, total: 5, seed: 1, stats: st }).title, "Completed");
    st.reset();
    assert.equal(st.distance + st.timesLifted + st.respawns, 0);
  });

  test("blown-away tracker: wind throws trigger it, driving does not", () => {
    const base = { y: 0, yaw: 0, wheels: 6, flipped: false, windLift: 0, windPush: 0 };
    const t = new BlownAwayTracker();
    t.reset(0, 0, 0, 0);
    // Drive 100 m on the ground, and off a ridge (airborne, no wind): never blown away.
    for (let i = 0; i < 100; i++) assert.equal(t.step(0.1, { ...base, x: i, z: 0, grounded: 6 }), false);
    for (let i = 0; i < 20; i++) assert.equal(t.step(0.1, { ...base, x: 100 + i, y: -i, z: 0, grounded: 0 }), false);
    assert.ok(t.safe.x > 80, "safe spot follows stable driving");
    // A devil lifts the rover and carries it away.
    const t2 = new BlownAwayTracker();
    t2.reset(0, 0, 0, 0.7);
    let fired = -1;
    for (let i = 0; i < 100 && fired < 0; i++) if (t2.step(0.1, { ...base, x: i, z: 0, grounded: 0, windLift: 4 })) fired = i;
    assert.ok(fired > BLOWN_AWAY_DISTANCE - 2 && fired < BLOWN_AWAY_DISTANCE + 2, `fires at ~${BLOWN_AWAY_DISTANCE} m (${fired})`);
    assert.equal(t2.safe.yaw, 0.7);
    // Short hop inside a devil that lands nearby: episode ends, no trigger, safe spot moves.
    const t3 = new BlownAwayTracker();
    t3.reset(0, 0, 0, 0);
    for (let i = 0; i < 5; i++) t3.step(0.1, { ...base, x: i, z: 0, grounded: 0, windLift: 4 });
    for (let i = 0; i < (SAFE_STABLE_TIME + 0.2) / 0.1; i++) assert.equal(t3.step(0.1, { ...base, x: 5, z: 0, grounded: 6 }), false);
    assert.equal(t3.episode, false);
    assert.equal(t3.safe.x, 5);
    // Thrown over a ridge: big height loss counts even if close.
    const t4 = new BlownAwayTracker();
    t4.reset(0, 10, 0, 0);
    let dropped = false;
    for (let i = 0; i < 30 && !dropped; i++) dropped = t4.step(0.1, { ...base, x: i * 0.3, y: 10 - i, z: 0, grounded: 0, windPush: 3 });
    assert.ok(dropped);
  });
});

await finish();
