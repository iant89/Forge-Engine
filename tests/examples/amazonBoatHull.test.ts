/**
 * @suite examples:amazonBoatHull
 * @group integration
 * @covers examples/src/scenes/amazonBoatSim.ts
 * @desc Pins the floodplain launch's hydrostatics, planing trim and shallow-water behaviour
 */

export const suite = {
  name: "examples:amazonBoatHull",
  group: "integration",
  covers: ["examples/src/scenes/amazonBoatSim.ts"],
  desc: "Pins the floodplain launch's hydrostatics, planing trim and shallow-water behaviour",
};
import assert from "node:assert/strict";
import { Transform, Vec3 } from "@forge/engine";
import { assertCloseTo, finish, group, test } from "selrun";
import {
  BOAT_DEPTH,
  BOAT_LOA,
  BOAT_MASS,
  WATER_DENSITY,
  applyBoatPose,
  bodyToWorld,
  createBoatConfig,
  createBoatInput,
  createBoatState,
  hullHalfWidth,
  hullProfileAt,
  resetBoat,
  riverChop,
  stepBoat,
  type BoatEnvironment,
  type BoatInput,
  type BoatState,
} from "../../examples/src/scenes/amazonBoatSim.js";

/** The sim keeps its own gravity; the test restates it so the weight identity is checked, not assumed. */
const GRAVITY = 9.81;

/** A world the boat can be measured against: flat water, a level bed, and an optional current. */
function plainWater(
  options: {
    level?: number;
    bed?: number;
    shoal?: number;
    current?: number;
  } = {},
): BoatEnvironment {
  const level = options.level ?? 0;
  const bed = options.bed ?? -8;
  const shoal = options.shoal ?? 0;
  const current = options.current ?? 0;
  return {
    level,
    waves: [],
    time: 0,
    bedElevation: (_x: number, z: number) => (bed === Number.POSITIVE_INFINITY ? level : bed + shoal * z),
    currentAt: (_x: number, _z: number, out: { x: number; z: number }) => {
      out.x = 0;
      out.z = current;
      return out;
    },
  };
}

const config = createBoatConfig();

/** A fresh state, floated at the solved draft and trim — `createBoatState` alone would start her in the air. */
function afloat(environment: BoatEnvironment, at: readonly [number, number, number] = [0, 0, 0]): BoatState {
  const state = createBoatState();
  resetBoat(state, config, environment, at[0], at[1], at[2]);
  return state;
}

function sail(
  seconds: number,
  environment: BoatEnvironment,
  input: Partial<BoatInput> & { gear?: number },
  state: BoatState,
  sample?: (state: BoatState, input: BoatInput, seconds: number) => void,
): BoatState {
  const controls = createBoatInput();
  controls.gear = input.gear ?? 1;
  controls.throttle = input.throttle ?? 0;
  controls.steer = input.steer ?? 0;
  controls.trim = input.trim ?? 0;
  const frames = Math.round(seconds * 60);
  for (let frame = 0; frame < frames; frame++) {
    environment.time += 1 / 60;
    stepBoat(state, config, controls, environment, 1 / 60);
    sample?.(state, controls, (frame + 1) / 60);
  }
  return state;
}

group("amazon launch hull", () => {
  test("the lofting is a vee: narrow at the keel, full at the deck, and it closes at both ends", () => {
    for (const t of [0.2, 0.5, 0.8]) {
      const profile = hullProfileAt(t);
      assert.ok(profile.deckY > profile.keelY, `station ${t} has an inverted section`);
      const atKeel = hullHalfWidth(t, 0.02);
      const atDeck = hullHalfWidth(t, profile.deckY - profile.keelY);
      assert.ok(atKeel < atDeck * 0.45, `station ${t} is box-shaped: ${atKeel} vs ${atDeck}`);
      assert.ok(Math.abs(profile.keelY) < 0.6, "the rocker ran away from the drawing");
    }
    // The bow rises and the transom comes up on the rocker: both ends must clear the water at rest, or the
    // columns would be underwater before the hull is, and the boat would float at a draft nobody drew.
    // `t` runs transom (0) to stem (1): the forefoot rocks up so she can be run over a 0.3 m bar, and the
    // run is the low point, which is what the driver watches when the depth sounder starts complaining.
    assert.ok(hullProfileAt(1).keelY > hullProfileAt(0.5).keelY + 0.02, "the bow has no rocker in it");
    assert.ok(hullProfileAt(0).keelY <= hullProfileAt(0.4).keelY, "the run is not the lowest part of the keel");
    assert.ok(BOAT_LOA > 8 && BOAT_LOA < 11);
  });

  test("the solved floatation carries exactly the boat's weight", () => {
    const weight = BOAT_MASS * GRAVITY;
    let supported = 0;
    let displaced = 0;
    for (const panel of config.panels) {
      supported += panel.load;
      displaced += panel.load / (WATER_DENSITY * GRAVITY);
    }
    assert.ok(Math.abs(displaced - BOAT_MASS / WATER_DENSITY) < 0.005 * (BOAT_MASS / WATER_DENSITY));
    assert.ok(Math.abs(supported - weight) < 0.005 * weight, `panels carry ${supported} N against ${weight} N`);
    assert.ok(config.draft > 0.15 && config.draft < 0.6, `solved draft ${config.draft} m`);
    assert.ok(config.draft < BOAT_DEPTH - 0.3, "the deck edge must stay above the solved waterline");
    assert.ok(config.gm > 0.5, "the boat must be stiff enough to be worth driving");
    assert.ok(config.rollPeriod > 0.7 && config.rollPeriod < 3, `roll period ${config.rollPeriod} s`);
    assert.ok(boatWettedPlanform() > 2, "the columns must have some bottom to plane on");
  });

  test("the integrator settles where the statics were solved, and stays put", () => {
    const water = plainWater();
    const state = sail(20, water, { throttle: 0, gear: 0 }, afloat(water));
    assertCloseTo(state.draft, config.draft, 2);
    assertCloseTo(state.pitch, config.trimDesign, 2);
    assert.ok(Math.abs(state.roll) < 1e-3, "a boat at rest in flat water must not heel");
    assert.ok(Math.abs(state.speedGround) < 0.05, `drifting at ${state.speedGround} m/s with no thrust`);
    assert.equal(state.grounded, false);
    assert.ok(Number.isFinite(state.y) && Number.isFinite(state.pitch) && Number.isFinite(state.heading));
    // Drop her out of the water and let her slam back: a settling hull must not turn sinkage into way on.
    const dropped = afloat(water);
    dropped.y -= 0.25;
    sail(30, water, { gear: 0 }, dropped);
    assertCloseTo(dropped.draft, config.draft, 2);
    assert.ok(Math.abs(dropped.speedGround) < 0.1, `settling pushed her along at ${dropped.speedGround} m/s`);
    // Out of gear she stops dead; in gear at idle the prop still walks her along, which is exactly how you
    // bring a launch alongside a floating jetty without touching the throttle.
    const idle = sail(30, water, { throttle: 0, gear: 1 }, afloat(water));
    assert.ok(idle.speedWater > 0.5, `in gear at idle she made only ${idle.speedWater.toFixed(2)} m/s`);
    assert.ok(idle.speedWater < 2.6, `idle shift is a race trim at ${idle.speedWater.toFixed(2)} m/s`);
  });

  test("the attitude matrix is the same rotation the scene graph is given", () => {
    const hull = { heading: 0.7, roll: -0.22, pitch: 0.13 };
    const matrix = bodyToWorld(hull, new Float64Array(9));
    // `applyBoatPose` hands the scene graph `setRotationEuler(-pitch, heading, roll)`. If the matrix the
    // integrator rotates its forces by ever disagrees with that, the boat is driven one way and drawn
    // another, and no amount of tuning the water model will make the demo look right.
    const pose = new Transform();
    applyBoatPose(pose, { ...createBoatState(), ...hull } as BoatState);
    const spin = new Vec3();
    for (const [bx, by, bz] of [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ]) {
      pose.rotation.rotateVector({ x: bx!, y: by!, z: bz! } as Vec3, spin);
      // Row-major by world row: the world image of a body axis is that matrix's column.
      assertCloseTo(spin.x, bx! * (matrix[0] ?? 0) + by! * (matrix[1] ?? 0) + bz! * (matrix[2] ?? 0), 5);
      assertCloseTo(spin.y, bx! * (matrix[3] ?? 0) + by! * (matrix[4] ?? 0) + bz! * (matrix[5] ?? 0), 5);
      assertCloseTo(spin.z, bx! * (matrix[6] ?? 0) + by! * (matrix[7] ?? 0) + bz! * (matrix[8] ?? 0), 5);
    }
  });

  test("full throttle climbs through the hull-speed wall and holds the plane", () => {
    const environment = plainWater();
    const state = afloat(environment);
    let stuckAt = 0;
    sail(40, environment, { throttle: 1 }, state, (s, _i, at) => {
      if (!stuckAt && s.speedWater > config.hullSpeed * 0.92) stuckAt = at;
    });
    assert.ok(state.speedWater > 12 && state.speedWater < 19, `WOT settled at ${state.speedWater} m/s`);
    assert.ok(stuckAt > 1 && stuckAt < 20, `through the wall at ${stuckAt} s`);
    assert.ok(state.planing > 0.1, "the readout must know she is on the plane");
    assert.ok(state.draft < config.draft - 0.05, "planing means rising out of the water, not dragging");
    assert.ok(state.freeboard > BOAT_DEPTH - config.draft, `freeboard grew to ${state.freeboard} m`);
    assert.ok(Math.abs(state.pitch) < 0.2, "the trim must not run to its clamp");
    assert.ok(state.wake > 0.9, "a boat at WOT throws a wake");
    assert.ok(state.rpm > 5000);
  });

  test("throttle is monotonic, and neutral is neutral", () => {
    const speeds: number[] = [];
    for (const throttle of [0.2, 0.45, 0.7, 1]) {
      const state = sail(35, plainWater(), { throttle }, afloat(plainWater()));
      speeds.push(state.speedWater);
    }
    for (let i = 1; i < speeds.length; i++) {
      assert.ok(speeds[i]! > speeds[i - 1]!, `throttle ladder went backwards: ${speeds.join(", ")}`);
    }
    const neutral = sail(10, plainWater(), { throttle: 1, gear: 0 }, afloat(plainWater()));
    assert.ok(Math.abs(neutral.speedWater) < 0.3, `in neutral she drifts at ${neutral.speedWater} m/s`);
    assert.ok(neutral.rpm < 900, "the engine drops to idle speed when the gear comes out");
  });

  test("trimming the leg out buys speed and a flatter run", () => {
    const running = plainWater();
    const down = sail(45, running, { throttle: 1, trim: -1 }, afloat(running));
    const up = sail(45, plainWater(), { throttle: 1, trim: 1 }, afloat(plainWater()));
    assert.ok(up.legTrim > 0.9 && down.legTrim < 0.1, "the ram has to actually move");
    assert.ok(
      up.speedWater > down.speedWater + 1.5,
      `a leg left hard down costs ${(down.speedWater - up.speedWater).toFixed(2)} m/s`,
    );
    const shallow = plainWater({ bed: -0.22 });
    const aground = sail(6, shallow, { throttle: 0.7 }, afloat(shallow));
    assert.ok(aground.legTrim >= 0 && aground.grounded, "dragging a leg along the bottom is still grounding");
  });

  test("a 1.3 m wind sea stays bounded and finite for a minute of hard running", () => {
    const environment = plainWater();
    environment.waves = riverChop(1.3, 0.5);
    const state = afloat(environment, [0, 0, 0.9]);
    let maxRoll = 0;
    let maxPitch = 0;
    let minFreeboard = Infinity;
    let slaps = 0;
    sail(60, environment, { throttle: 1 }, state, (s) => {
      maxRoll = Math.max(maxRoll, Math.abs(s.roll));
      maxPitch = Math.max(maxPitch, Math.abs(s.pitch));
      minFreeboard = Math.min(minFreeboard, s.freeboard);
      if (s.slap > 0.35) slaps++;
    });
    assert.ok(maxRoll < 0.5, `rolled ${((maxRoll * 180) / Math.PI).toFixed(1)} degrees`);
    assert.ok(maxPitch < 0.21, `pitched ${((maxPitch * 180) / Math.PI).toFixed(1)} degrees`);
    assert.ok(minFreeboard > 0, "she went under: the demo would be swimming");
    assert.ok(state.speedWater > 8, `made only ${state.speedWater} m/s in the chop`);
    assert.ok(slaps > 0 && slaps < 60 * 60 * 0.2, `${slaps} slap frames in 60 s`);
    assert.ok(state.seaState > 0.05, "the boat must feel the sea it is driving through");
    for (const value of [state.x, state.y, state.z, state.roll, state.pitch, state.heading, state.rpm]) {
      assert.ok(Number.isFinite(value));
    }
  });

  test("free roll returns to level on the reported period", () => {
    const environment = plainWater();
    const state = afloat(environment);
    state.roll = 0.17;
    let quarter = 0;
    sail(20, environment, {}, state, (_s, _i, at) => {
      if (!quarter && state.roll < 0) quarter = at;
    });
    const measured = quarter * 4;
    assert.ok(Math.abs(state.roll) < 0.005 * 0.17, "the roll damps out instead of wallowing");
    assert.ok(
      Math.abs(measured - config.rollPeriod) / config.rollPeriod < 0.5,
      `measured ${measured.toFixed(2)} s against the config's ${config.rollPeriod.toFixed(2)} s`,
    );
  });

  test("a current moves the ground track and leaves the water speed alone", () => {
    const slack = sail(30, plainWater(), { throttle: 1 }, afloat(plainWater()));
    const tide = sail(30, plainWater({ current: 1.3 }), { throttle: 1 }, afloat(plainWater({ current: 1.3 })));
    assertCloseTo(tide.speedWater, slack.speedWater, 0);
    assert.ok(
      tide.speedGround > tide.speedWater + 1,
      `a following current has to show up over the ground: ${tide.speedGround} vs ${tide.speedWater}`,
    );
    assert.ok(Math.abs(tide.speedWater - slack.speedWater) < 0.02 * slack.speedWater);
  });

  test("she takes the ground on a bar and comes off it backing down", () => {
    const environment = plainWater({ bed: -0.3, shoal: 0.11 });
    const state = sail(10, environment, { throttle: 0.6 }, afloat(environment, [0, -10, 0]));
    assert.ok(state.grounded, "a hull that draws 0.35 m must find a bar that shoals to 0.3 m");
    assert.ok(state.penetration > 0.005, "the keel has to be actually on the bottom");
    assert.ok(state.speedGround < 3, `she dragged over the bar at ${state.speedGround} m/s`);
    sail(14, environment, { throttle: 1, gear: -1, trim: -1 }, state);
    assert.equal(state.grounded, false, "backing her off into deeper water has to work");
    assert.equal(state.penetration, 0);
    const deepWater = plainWater({ bed: -1.3 });
    const deep = sail(10, deepWater, { throttle: 0.6 }, afloat(deepWater));
    assert.equal(deep.grounded, false, "1.3 m of water over a 0.3 m bar is not grounding");
    assert.ok(deep.speedWater > 6);
  });

  test("helm authority is a planing hull's, not a barge's", () => {
    for (const [label, throttle, gear] of [
      ["ahead at WOT", 1, 1],
      ["at tickover", 0.08, 1],
      ["astern", 0.7, -1],
    ] as const) {
      const environment = plainWater();
      const state = afloat(environment);
      let turned = 0;
      sail(12, environment, { throttle, gear, steer: 1 }, state, (s) => {
        turned = Math.max(turned, Math.abs(s.heading));
      });
      const radius = Math.max(0.5, Math.abs(state.speedWater) / Math.max(0.02, Math.abs(state.yawRate)));
      assert.ok(turned > 0.3, `${label}: the helm did nothing (${turned.toFixed(2)} rad)`);
      assert.ok(radius < 120, `${label}: turned in a ${radius.toFixed(0)} m radius`);
      assert.ok(Math.abs(state.slip) < 1, `${label}: sliding sideways at ${(state.slip * 57.3).toFixed(0)} degrees`);
    }
  });

  test("stopping is a manoeuvre, and the engine spools like a two-stroke", () => {
    const running = plainWater();
    const state = sail(40, running, { throttle: 1 }, afloat(running));
    const from = state.speedWater;
    let stoppedAt = 0;
    let travelled = 0;
    const start = state.z;
    sail(25, plainWater(), { throttle: 1, gear: -1 }, state, (s, _i, at) => {
      if (!stoppedAt && s.speedWater <= 0.1) {
        stoppedAt = at;
        travelled = s.z - start;
      }
    });
    assert.ok(stoppedAt > 1 && stoppedAt < 12, `still in ${stoppedAt.toFixed(1)} s from ${from.toFixed(1)} m/s`);
    assert.ok(travelled > 0, "she carries on ahead for a moment before the stern takes charge");
    assert.ok(Math.abs(state.speedWater) < from, "reverse thrust is weaker than ahead thrust");
    const spoolWater = plainWater();
    const spool = afloat(spoolWater);
    let toRedline = 0;
    sail(8, spoolWater, { throttle: 1 }, spool, (s, _i, at) => {
      if (!toRedline && s.rpm > 4800) toRedline = at;
    });
    assert.ok(toRedline > 1 && toRedline < 6, `spun up in ${toRedline.toFixed(2)} s`);
  });

  test("30 Hz and 240 Hz agree, because the demo runs at whatever the display asks for", () => {
    const controls = createBoatInput();
    controls.gear = 1;
    controls.throttle = 1;
    controls.trim = 0.4;
    const environment = plainWater();
    const coarse = afloat(environment, [0, 0, 0.4]);
    const fine = afloat(environment, [0, 0, 0.4]);
    for (let frame = 0; frame < 600; frame++) {
      stepBoat(coarse, config, controls, environment, 1 / 30);
      for (let sub = 0; sub < 8; sub++) stepBoat(fine, config, controls, environment, 1 / 240);
    }
    assert.ok(Math.abs(coarse.speedWater - fine.speedWater) < 0.4, "the top speed depends on the frame rate");
    assert.ok(Math.abs(coarse.pitch - fine.pitch) < 0.02, "the trim depends on the frame rate");
    assert.ok(Math.abs(coarse.y - fine.y) < 0.05, "the ride height depends on the frame rate");
    assert.ok(Math.abs(coarse.x - fine.x) < 4, "the track depends on the frame rate");
  });

  test("the wind sea fits the water shader's budget and stays under the breaking limit", () => {
    const waves = riverChop(1.3, 0.4);
    assert.equal(waves.length, 4);
    for (const wave of waves) {
      assert.ok(wave.wavelength >= 16, `${wave.wavelength} m is shorter than the water grid can resolve`);
      assert.ok(wave.amplitude <= 0.11 * wave.wavelength + 1e-6, "this crest would loop over in the shader");
      assert.ok(wave.steepness >= 0 && wave.steepness <= 1);
      assert.ok(Math.abs(Math.hypot(wave.directionX, wave.directionZ) - 1) < 1e-6);
      assertCloseTo(wave.speed, Math.sqrt((GRAVITY * wave.wavelength) / (Math.PI * 2)), 6);
    }
    assert.ok(
      riverChop(0).every((wave) => wave.amplitude === 0),
      "no wind, no sea",
    );
    assert.ok(riverChop(3)[2]!.amplitude > riverChop(1)[2]!.amplitude);
  });
});

function boatWettedPlanform(): number {
  let area = 0;
  for (const panel of config.panels) area += panel.area;
  return area;
}

await finish();
