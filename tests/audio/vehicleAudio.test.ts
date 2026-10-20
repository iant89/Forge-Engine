/**
 * @suite audio:vehicleAudio
 * @group integration
 * @covers engine/src/audio/vehicle.ts
 * @covers engine/src/audio/index.ts
 * @desc Phase 20.7 vehicle audio: engine RPM, throttle, load, gear, tyre slip, suspension and terrain read from a stepping Vehicle drive the voice levels and one-shot events; the analyzer never changes the simulation; the WebAudio graph applies levels, plays events and tears down
 */

export const suite = {
  name: "audio:vehicleAudio",
  group: "integration",
  covers: [
    "engine/src/audio/vehicle.ts",
    "engine/src/audio/index.ts",
  ],
  desc: "Phase 20.7 vehicle audio: engine RPM, throttle, load, gear, tyre slip, suspension and terrain read from a stepping Vehicle drive the voice levels and one-shot events; the analyzer never changes the simulation; the WebAudio graph applies levels, plays events and tears down",
};
import assert from "node:assert/strict";
import { finish, group, test } from "selrun";
import {
  ElectricMotor,
  ReductionDrive,
  VEHICLE_SOUND_SURFACES,
  VEHICLE_SURFACE_SOUND,
  Vehicle,
  VehicleAudio,
  VehicleSoundAnalyzer,
  VehicleSoundscape,
  createVehicleConfig,
  flatGround,
  heightFunctionGround,
  vehicleSoundLevels,
  type GroundQuery,
  type VehicleSoundEvent,
  type VehicleSoundState,
  type VehicleSurfaceClassifier,
} from "@forge/engine";
import { fakeAudioContext, type FakeNode, type FakeParam } from "../support/fakeAudio.js";

const DT = 1 / 60;

interface Drive {
  vehicle: Vehicle;
  analyzer: VehicleSoundAnalyzer;
  events: Array<VehicleSoundEvent & { frame: number }>;
  states: VehicleSoundState[];
}

/** Step a vehicle and its analyzer frame by frame, keeping a copy of every state and event. */
function drive(frames: number, setup: (v: Vehicle) => void = () => {}, ground: GroundQuery = flatGround(), surfaceAt?: VehicleSurfaceClassifier, vehicle = new Vehicle(createVehicleConfig())): Drive {
  vehicle.placeOnGround(ground);
  setup(vehicle);
  const analyzer = new VehicleSoundAnalyzer(vehicle, { surfaceAt });
  const events: Drive["events"] = [];
  const states: VehicleSoundState[] = [];
  for (let i = 0; i < frames; i++) {
    vehicle.step(DT, ground);
    const s = analyzer.update(DT);
    states.push(structuredClone(s));
    for (const e of analyzer.events) events.push({ ...e, frame: i });
  }
  return { vehicle, analyzer, events, states };
}

const last = (d: Drive): VehicleSoundState => d.states[d.states.length - 1]!;

group("engine: rpm, throttle, load, gear", () => {
  test("at idle the engine sits at idle rpm with no load, and the firing frequency is rpm/60 × cylinders/2", () => {
    const d = drive(120);
    const s = last(d);
    const idle = d.vehicle.config.engine.idleRpm;
    assert.ok(Math.abs(s.rpm - idle) < 1, `rpm ${s.rpm}`);
    assert.equal(s.rpmNorm, 0);
    assert.equal(s.load, 0);
    assert.equal(s.slip, 0);
    assert.equal(d.events.length, 0, "a parked car makes no one-shots");
    const l = vehicleSoundLevels(s);
    assert.ok(Math.abs(l.engineFrequency - (idle / 60) * 2) < 1e-9);
    assert.ok(Math.abs(vehicleSoundLevels(s, { cylinders: 8 }).engineFrequency - (idle / 60) * 4) < 1e-9);
    assert.ok(l.engineGain > 0.1 && l.engineGain < 0.3, `idle gain ${l.engineGain}`);
    assert.equal(l.roarGain, 0, "no tyre roar standing still");
  });

  test("two strokes: twice the firings of a four-stroke single, brighter, and an expansion-chamber ring up top", () => {
    const parked = last(drive(120));
    const idle = parked.rpm;
    const four = vehicleSoundLevels(parked, { cylinders: 1 });
    const two = vehicleSoundLevels(parked, { cylinders: 1, strokes: 2 });
    assert.ok(Math.abs(four.engineFrequency - (idle / 60) * 0.5) < 1e-9, `a single four-stroke fires every other revolution (${four.engineFrequency.toFixed(2)} Hz)`);
    assert.ok(Math.abs(two.engineFrequency - idle / 60) < 1e-9, `a two-stroke fires every revolution (${two.engineFrequency.toFixed(2)} Hz)`);
    assert.equal(two.engineFrequency, four.engineFrequency * 2);

    // Deep in the rev range under throttle is where a two-stroke's pipe speaks.
    const d = drive(600, (v) => (v.input.throttle = 1));
    const loaded = d.states.reduce((best, s) => (s.rpmNorm > best.rpmNorm ? s : best), d.states[0]!);
    assert.ok(loaded.rpmNorm > 0.6, `reached ${(loaded.rpmNorm * 100).toFixed(0)}% of the rev range`);
    const band = vehicleSoundLevels(loaded, { cylinders: 1, strokes: 2 });
    const sameState = vehicleSoundLevels(loaded, { cylinders: 1 });
    assert.ok(band.engineBrightness > sameState.engineBrightness, "the pipe note is brighter");
    assert.ok(band.engineRoughness < sameState.engineRoughness, "and it buzzes rather than rumbles");
    assert.ok(band.whineGain > 0.02, `the expansion chamber rings (${band.whineGain.toFixed(3)})`);
    assert.ok(Math.abs(band.whineFrequency - band.engineFrequency * 4) < 1e-9, "on the voice a four-stroke leaves free in forward gear");
    assert.equal(sameState.whineGain, 0, "that voice is silent on a four-stroke going forward");

    // Below the band the pipe is quiet — the ring is the top end, not the whole rev range.
    const low = d.states.find((s) => s.throttle > 0.5 && s.rpmNorm > 0.05 && s.rpmNorm < 0.4)!;
    assert.ok(low, "there is a state under throttle below the band");
    assert.equal(vehicleSoundLevels(low, { cylinders: 1, strokes: 2 }).whineGain, 0);
  });

  test("full throttle: pitch follows rpm through the gears, load is high, and each upshift is an event with from/to", () => {
    const d = drive(600, (v) => (v.input.throttle = 1));
    const shifts = d.events.filter((e) => e.kind === "shift");
    assert.ok(shifts.length >= 2, `shifts ${shifts.length}`);
    for (const [i, e] of shifts.entries()) {
      assert.equal(e.from, i + 1);
      assert.equal(e.to, i + 2);
      assert.ok(e.strength > 0.9, "a shift at full throttle is a hard one");
      // The clutch-open frames read as shifting and drop the engine voice.
      const during = d.states[e.frame]!;
      assert.ok(during.shifting);
      const before = d.states[e.frame - 2]!;
      assert.ok(vehicleSoundLevels(during).engineGain < vehicleSoundLevels(before).engineGain);
      // An upshift drops the rpm, so the pitch falls.
      const after = d.states[e.frame + 15]!;
      assert.ok(after.rpm < before.rpm, `rpm ${before.rpm} → ${after.rpm}`);
    }
    // Between shifts the firing frequency tracks the crank exactly.
    const mid = d.states[100]!;
    assert.ok(Math.abs(vehicleSoundLevels(mid).engineFrequency - (mid.rpm / 60) * 2) < 1e-9);
    const pulling = d.states.filter((s) => !s.shifting && s.speed > 2);
    // The frame the clutch re-engages is a transient (the crank free-revved while it was open).
    const loaded = pulling.filter((s) => s.load > 0.5).length;
    assert.ok(loaded >= pulling.length * 0.98, `pulling in gear at full throttle is loaded (${loaded}/${pulling.length})`);
    const idle = vehicleSoundLevels(drive(10).states[9]!);
    const l = vehicleSoundLevels(d.states[100]!);
    assert.ok(l.engineGain > idle.engineGain + 0.4 && l.engineBrightness > idle.engineBrightness + 1500);
    assert.ok(l.roarGain > 0 && l.windGain > 0);
  });

  test("load is not throttle: revving in neutral is unloaded; the same throttle pulling a car is loaded", () => {
    const free = last(drive(90, (v) => { v.selectGear(0); v.input.throttle = 1; }));
    const pull = drive(90, (v) => (v.input.throttle = 1)).states[60]!;
    assert.equal(free.throttle, 1);
    assert.ok(free.rpmNorm > 0.9, "the free crank revs out");
    assert.equal(free.load, 0);
    assert.ok(pull.load > 0.6, `pull load ${pull.load}`);
    const lf = vehicleSoundLevels(free), lp = vehicleSoundLevels(pull);
    assert.ok(lp.engineRoughness > lf.engineRoughness * 3, "combustion grit comes with load, not revs");
  });

  test("lifting off in gear is overrun; a closed-throttle slide does not load the engine", () => {
    const coast = last(drive(120, (v) => { v.setVelocity(0, 0, 25); v.config.transmission.gear = 3; }));
    assert.ok(coast.overrun > 0.3 && coast.load === 0, `overrun ${coast.overrun}`);
    assert.ok(vehicleSoundLevels(coast).overrunGain > 0.08);
    const slide = drive(120, (v) => { v.setVelocity(0, 0, 18); v.config.transmission.gear = 3; v.input.handbrake = 1; v.input.steer = 1; });
    assert.ok(slide.states.every((s) => s.load === 0), "tyre scrub on driven wheels is not engine load");
  });

  test("shifting F → R while rolling forward makes a transmission grinding sound until R kicks in", () => {
    const d = drive(120, (v) => {
      v.selectGear(1);
      v.setVelocity(0, 0, 4);
      v.selectGear(-1);
    });
    const early = d.states[5]!;
    assert.equal(early.grinding, true);
    const earlyLevels = vehicleSoundLevels(early);
    assert.ok(earlyLevels.grindGain > 0.4, `expected grinding sound while R has not engaged, got ${earlyLevels.grindGain}`);
    assert.ok(earlyLevels.grindFrequency > 1000);

    const late = last(d);
    assert.equal(late.grinding, false, "grinding stops once R gear kicks in");
    const lateLevels = vehicleSoundLevels(late);
    assert.equal(lateLevels.grindGain, 0);
    assert.equal(lateLevels.grindFrequency, 0);
  });

  test("reverse gear whines; an electric motor whines with rpm and has no combustion voice", () => {
    const rev = last(drive(120, (v) => { v.selectGear(-1); v.input.throttle = 0.6; }));
    assert.equal(rev.gear, -1);
    assert.ok(vehicleSoundLevels(rev).whineGain > 0.02);
    const ev = () =>
      new Vehicle(createVehicleConfig({
        engine: new ElectricMotor({ peakTorque: 140, peakPower: 90_000, ratedRpm: 4000, maxRpm: 12_000, regenTorque: 40 }),
        transmission: new ReductionDrive(9),
      }));
    const d = drive(240, (v) => (v.input.throttle = 1), flatGround(), undefined, ev());
    assert.equal(d.analyzer.state.powertrain, "electric");
    const early = vehicleSoundLevels(d.states[30]!), late = vehicleSoundLevels(d.states[220]!);
    assert.equal(late.engineGain, 0);
    assert.equal(late.overrunGain, 0);
    assert.ok(late.whineFrequency > early.whineFrequency * 1.5, `${early.whineFrequency} → ${late.whineFrequency}`);
    assert.ok(late.whineGain > 0.05);
    assert.equal(new VehicleSoundAnalyzer(ev(), { powertrain: "combustion" }).state.powertrain, "combustion");
  });
});

group("tyres and terrain", () => {
  const slide = (v: Vehicle): void => {
    v.setVelocity(0, 0, 18);
    v.config.transmission.gear = 3;
    v.input.handbrake = 1;
    v.input.steer = 1;
  };

  test("rolling straight does not squeal; a handbrake slide squeals at the slide's speed", () => {
    const cruise = drive(120, (v) => (v.input.throttle = 0.4));
    assert.ok(cruise.states.every((s) => vehicleSoundLevels(s).squealGain === 0), "grip below the peak is silent");
    const d = drive(60, slide);
    const s = d.states[40]!;
    assert.ok(s.slip > 0.8 && s.slideSpeed > 5, `slip ${s.slip} slide ${s.slideSpeed}`);
    const l = vehicleSoundLevels(s);
    assert.ok(l.squealGain > 0.5, `squeal ${l.squealGain}`);
    assert.ok(l.squealFrequency > 650);
  });

  test("wheelspin past the peak is slip too (traction control off, low grip)", () => {
    const d = drive(120, (v) => { v.config.tcEnabled = false; v.surfaceGrip = 0.4; v.input.throttle = 1; });
    assert.ok(d.states.some((s) => s.slip > 0.8));
  });

  test("the same slide on gravel scrabbles instead of squealing, and each surface has its own roll", () => {
    const tar = vehicleSoundLevels(drive(40, slide).states[39]!);
    const gravel = drive(40, slide, flatGround(), () => "gravel").states[39]!;
    assert.equal(gravel.surface.gravel, 1);
    const g = vehicleSoundLevels(gravel);
    assert.ok(g.squealGain < tar.squealGain * 0.2, `gravel squeal ${g.squealGain} vs ${tar.squealGain}`);
    assert.ok(g.crunchGain > 0.5 && tar.crunchGain === 0);
    // Cruising: mud sloshes, asphalt does not; the roar is duller off the road.
    const cruise = (surface: VehicleSurfaceClassifier) => vehicleSoundLevels(drive(150, (v) => { v.setVelocity(0, 0, 15); v.config.transmission.gear = 2; v.input.throttle = 0.3; }, flatGround(), surface).states[149]!);
    const mud = cruise(() => "mud"), road = cruise(() => "asphalt");
    assert.ok(mud.sloshGain > 0.2 && road.sloshGain === 0);
    assert.ok(mud.roarCutoff < road.roarCutoff && mud.roarGain < road.roarGain);
    for (const k of VEHICLE_SOUND_SURFACES) assert.ok(VEHICLE_SURFACE_SOUND[k], k);
  });

  test("the surface is read per wheel at its contact point", () => {
    // Left wheels (x < 0) on grass, right on asphalt.
    const d = drive(30, (v) => v.setVelocity(0, 0, 8), flatGround(), (x) => (x < 0 ? "grass" : "asphalt"));
    const s = last(d);
    assert.ok(Math.abs(s.surface.grass - 0.5) < 1e-9 && Math.abs(s.surface.asphalt - 0.5) < 1e-9);
    assert.deepEqual(s.wheels.map((w) => w.surface), ["grass", "asphalt", "grass", "asphalt"]);
  });
});

group("suspension", () => {
  test("a smooth road makes no impacts; a bump hits the front axle first, then the rear", () => {
    const setup = (v: Vehicle): void => { v.setVelocity(0, 0, 10); v.config.transmission.gear = 2; v.input.throttle = 0.3; };
    const smooth = drive(120, setup);
    assert.equal(smooth.events.filter((e) => e.kind !== "shift").length, 0);
    const bump = heightFunctionGround((_x, z) => (z > 10 && z < 10.6 ? 0.12 : 0), 0.05);
    const d = drive(120, setup, bump, () => "gravel");
    const hits = d.events.filter((e) => e.kind === "impact" || e.kind === "bottomOut");
    const front = hits.filter((e) => e.wheel < 2), rear = hits.filter((e) => e.wheel >= 2);
    assert.ok(front.length >= 2 && rear.length >= 2, hits.map((e) => `${e.frame}:${e.kind}${e.wheel}`).join(" "));
    assert.ok(front[0]!.frame < rear[0]!.frame, "the front axle reaches the bump first");
    // 2.6 m wheelbase at ~10 m/s is ~15 frames between axles.
    const gap = rear[0]!.frame - front[0]!.frame;
    assert.ok(gap >= 10 && gap <= 20, `axle gap ${gap} frames`);
    assert.ok(hits.every((e) => e.strength > 0 && e.strength <= 1 && e.surface === "gravel"));
    // One hit per wheel per bump edge: the trigger re-arms only once the wheel settles.
    const perWheel = new Map<number, number>();
    for (const e of hits) perWheel.set(e.wheel, (perWheel.get(e.wheel) ?? 0) + 1);
    for (const n of perWheel.values()) assert.ok(n <= 3, `hits per wheel ${n}`);
  });

  test("a drop lands on every wheel once, louder from higher", () => {
    const fall = (h: number) => drive(120, (v) => (v.position.y += h)).events.filter((e) => e.kind === "landing");
    const low = fall(0.6), high = fall(1.5);
    assert.deepEqual(high.map((e) => e.wheel).sort(), [0, 1, 2, 3]);
    assert.equal(low.length, 4);
    assert.ok(high[0]!.strength > low[0]!.strength, `${low[0]!.strength} < ${high[0]!.strength}`);
    assert.equal(fall(0).length, 0, "settling on the spot is not a landing");
  });
});

group("the simulation is unaffected", () => {
  test("a vehicle stepped with an analyzer reaches the bit-identical snapshot of one stepped without", () => {
    const ground = heightFunctionGround((x, z) => 0.2 * Math.sin(z * 0.4) + 0.1 * Math.cos(x * 0.7));
    const run = (withAudio: boolean): string => {
      const v = new Vehicle(createVehicleConfig());
      v.placeOnGround(ground);
      const a = withAudio ? new VehicleSoundAnalyzer(v, { surfaceAt: () => "dirt" }) : null;
      for (let i = 0; i < 300; i++) {
        v.input.throttle = i < 200 ? 1 : 0;
        v.input.steer = Math.sin(i / 40);
        v.input.handbrake = i > 240 ? 1 : 0;
        v.step(DT, ground);
        a?.update(DT);
      }
      return JSON.stringify(v.snapshot());
    };
    assert.equal(run(true), run(false));
  });
});

// ------------------------------------------------------------------ WebAudio graph (fake context)

group("soundscape", () => {
  test("the graph is built once, levels reach the voices, events add one-shots, and dispose stops everything", () => {
    const { ctx, nodes } = fakeAudioContext();
    const scape = new VehicleSoundscape(ctx as unknown as BaseAudioContext, ctx.destination as unknown as AudioNode, { volume: 0.5 });
    const built = nodes.length;
    const loops = nodes.filter((n) => n.kind === "buffer" || n.kind === "oscillator");
    assert.equal(loops.length, 12, "4 oscillators + 8 noise voices");
    assert.ok(loops.every((n) => (n.started as number[]).length === 1));
    assert.ok(nodes.filter((n) => n.kind === "buffer").every((n) => n.loop === true));
    assert.ok((scape.output as unknown as FakeNode).connected.includes(ctx.destination));

    const d = drive(100, (v) => (v.input.throttle = 1));
    const state = d.states[99]!;
    const l = scape.set(state);
    assert.deepEqual(l, vehicleSoundLevels(state));
    const fundamental = nodes.find((n) => n.kind === "oscillator" && n.type === "sawtooth")!;
    assert.ok(Math.abs(((fundamental.frequency as FakeParam).targets.at(-1) ?? 0) - l.engineFrequency) < 1e-9);
    const gains = nodes.filter((n) => n.kind === "gain").map((n) => (n.gain as FakeParam).targets.at(-1));
    assert.ok(gains.includes(l.engineGain) && gains.includes(l.roarGain) && gains.includes(l.windGain));
    assert.equal(nodes.length, built, "updating levels creates no nodes");

    scape.play([{ kind: "landing", wheel: 0, strength: 1, surface: "gravel", from: 0, to: 0 }, { kind: "shift", wheel: -1, strength: 1, surface: "asphalt", from: 1, to: 2 }]);
    const shots = nodes.slice(built).filter((n) => n.kind === "buffer" || n.kind === "oscillator");
    assert.equal(shots.length, 3, "thump + gravel burst + shift clunk");
    assert.ok(shots.every((n) => (n.stopped as number) === 1), "one-shots schedule their own stop");

    scape.dispose();
    assert.ok(loops.every((n) => (n.stopped as number) === 1 && n.disconnected > 0));
    const after = nodes.length;
    scape.play([{ kind: "impact", wheel: 1, strength: 1, surface: "asphalt", from: 0, to: 0 }]);
    scape.set(state);
    scape.dispose();
    assert.equal(nodes.length, after, "a disposed soundscape is inert");
  });

  test("VehicleAudio follows one vehicle: spatial position, events and levels from the same frame", () => {
    const { ctx, nodes } = fakeAudioContext();
    const v = new Vehicle(createVehicleConfig());
    const ground = flatGround();
    v.placeOnGround(ground);
    v.position.y += 1.2;
    const audio = new VehicleAudio(v, ctx as unknown as BaseAudioContext, ctx.destination as unknown as AudioNode, { spatial: true, surfaceAt: () => "mud" });
    const panner = nodes.find((n) => n.kind === "panner")!;
    let landings = 0;
    for (let i = 0; i < 90; i++) {
      v.step(DT, ground);
      audio.update(DT);
      landings += audio.analyzer.events.filter((e) => e.kind === "landing").length;
    }
    assert.equal(landings, 4);
    assert.ok(Math.abs(((panner.positionY as FakeParam).targets.at(-1) ?? NaN) - v.position.y) < 1e-9);
    assert.deepEqual(audio.levels, vehicleSoundLevels(audio.state));
    assert.equal(audio.state.surface.mud, 1);
    audio.dispose();
  });
});

finish();
