/**
 * @suite replay:replay
 * @group integration
 * @covers engine/src/replay/hash.ts
 * @covers engine/src/replay/channels.ts
 * @covers engine/src/replay/recording.ts
 * @covers engine/src/replay/session.ts
 * @covers engine/src/replay/index.ts
 * @covers engine/src/core/time.ts
 * @desc Phase 19.4 replay: exact-bit state hashing with per-part digests (pinned), Clock frame scripting, replay from a 19.3 snapshot, a vehicle-on-terrain session with physics props recorded under a random frame schedule and played back bit-identically through JSON from a freshly built scene, live input overridden during playback, divergence detection (initial state, tampered input, schedule) naming the parts that differ, and format validation
 */

export const suite = {
  name: "replay:replay",
  group: "integration",
  covers: ["engine/src/replay/hash.ts", "engine/src/replay/channels.ts", "engine/src/replay/recording.ts", "engine/src/replay/session.ts", "engine/src/replay/index.ts", "engine/src/core/time.ts"],
  desc: "Phase 19.4 replay: exact-bit state hashing with per-part digests (pinned), Clock frame scripting, replay from a 19.3 snapshot, a vehicle-on-terrain session with physics props recorded under a random frame schedule and played back bit-identically through JSON from a freshly built scene, live input overridden during playback, divergence detection (initial state, tampered input, schedule) naming the parts that differ, and format validation",
};

import assert from "node:assert/strict";
import { finish, group, test } from "selrun";
import {
  ColliderComponent,
  ForgeJSPhysics,
  HeightfieldShape,
  Logger,
  ManualClock,
  PhysicsSystem,
  Profiler,
  ReplayPlayer,
  ReplayRecorder,
  RigidBodyComponent,
  Rng,
  Scene,
  SceneObject,
  StateHasher,
  System,
  SystemScratch,
  Transform,
  Vehicle,
  VehicleComponent,
  VehicleSystem,
  createVehicleChassis,
  createVehicleConfig,
  fieldsChannel,
  hashSceneState,
  physicsGroundQuery,
  registerStateHashContributor,
  stateHashParts,
  unregisterStateHashContributor,
  validateReplay,
  vehicleInputChannel,
  type Clock,
  type ReplayRecording,
  type StateRecord,
  captureSceneSnapshot,
  restoreSceneSnapshot,
  type SystemContext,
  type TickResult,
} from "@forge/engine";

const FIXED_DT = 1 / 60;

/** A scene object with saved state that changes every frame (stands in for weather/day-night). */
class Beacon extends SceneObject {
  readonly name = "beacon";
  phase = 0;
  override update(_c: SystemContext, dt: number): void {
    this.phase = (this.phase + dt * 0.7) % 1;
  }
  override saveState(): Record<string, unknown> {
    return { phase: this.phase };
  }
  override snapshotState(): StateRecord {
    return { phase: this.phase };
  }
  override restoreSnapshotState(state: StateRecord): void {
    this.phase = state.phase as number;
  }
}

/** The game's own input code: a scripted "driver" in the input band (order 50). */
class Driver extends System {
  readonly name = "test.driver";
  override readonly order = 50;
  frame = 0;
  constructor(private readonly vehicle: Vehicle) {
    super();
  }
  update(): void {
    const f = this.frame++;
    const i = this.vehicle.input;
    if (f < 240) {
      i.throttle = 0.8;
      i.steer = Math.sin(f / 40) * 0.6;
      i.brake = 0;
    } else if (f < 300) {
      i.throttle = 0;
      i.brake = 1;
      i.steer = 0.2;
    } else if (f < 330) {
      this.vehicle.selectGear(-1);
      i.brake = 0;
      i.throttle = 0.5;
      i.steer = -0.4;
    } else {
      this.vehicle.selectGear(1);
      i.throttle = 0.6;
      i.handbrake = f % 90 < 20 ? 1 : 0;
      i.steer = Math.cos(f / 25) * 0.5;
    }
  }
}

interface Session {
  scene: Scene;
  vehicle: Vehicle;
  driver: Driver;
  props: RigidBodyComponent[];
  beacon: Beacon;
}

/** The same scene built the same way each time: rolling terrain, a car, three boxes in its path. */
function buildSession(): Session {
  const scene = new Scene({ name: "replay-session" });
  const backend = new ForgeJSPhysics({ gravity: { x: 0, y: -9.81, z: 0 } });
  backend.setHeightfield(new HeightfieldShape({ sampleHeight: (x, z) => 0.35 * Math.sin(x * 0.17) * Math.cos(z * 0.13) }));
  const ground = physicsGroundQuery(backend);
  scene.world.registerSystem(new PhysicsSystem({ world: backend.world }));
  scene.world.registerSystem(new VehicleSystem());
  const vehicle = new Vehicle(createVehicleConfig({ mass: 1400 }));
  vehicle.placeOnGround(ground);
  const chassis = createVehicleChassis(vehicle, backend);
  const car = scene.world.createEntity("car");
  const t = new Transform();
  t.setPosition(vehicle.position.x, vehicle.position.y, vehicle.position.z);
  car.add(t);
  const vc = new VehicleComponent(vehicle, ground);
  vc.chassisBody = chassis;
  vc.chassisWorld = backend.world;
  car.add(vc);
  const props: RigidBodyComponent[] = [];
  for (let k = 0; k < 3; k++) {
    const e = scene.world.createEntity(`crate${k}`);
    const tr = new Transform();
    tr.setPosition(-1 + k, 1.5, 12 + k * 4);
    e.add(tr);
    const rb = new RigidBodyComponent();
    rb.bodyType = "dynamic";
    rb.mass = 40;
    e.add(rb);
    const col = new ColliderComponent();
    col.setBox(0.5, 0.5, 0.5);
    e.add(col);
    props.push(rb);
  }
  const driver = new Driver(vehicle);
  scene.world.registerSystem(driver);
  const beacon = new Beacon();
  scene.addObject(beacon);
  return { scene, vehicle, driver, props, beacon };
}

function context(scene: Scene, clock: Clock, tick: TickResult): SystemContext {
  return {
    world: scene.world,
    clock,
    dt: clock.deltaTime,
    fixedDt: clock.fixedDeltaTime,
    fixedSteps: tick.fixedSteps,
    alpha: tick.alpha,
    elapsed: clock.elapsedTime,
    frame: clock.frameIndex,
    logger: new Logger(),
    profiler: new Profiler(),
    services: { get: () => undefined, engineConfig: {} },
    scratch: new SystemScratch(),
  } as unknown as SystemContext;
}

/** One engine-like frame: advance the clock by `wallDt`, then update the scene with its tick. */
function frame(s: Session, clock: ManualClock, wallDt: number): TickResult {
  const tick = clock.advance(wallDt);
  const c = context(s.scene, clock, tick);
  s.scene.update(c, c.dt);
  return tick;
}

/** Record `frames` frames with an uneven, seeded frame rate (0–3 fixed steps per frame). */
function recordSession(frames: number, seed = 7, hashEvery = 60): { rec: ReplayRecording; session: Session } {
  const s = buildSession();
  // Settle the props and suspension before recording, so the recording starts mid-simulation.
  const settle = new ManualClock({ fixedDeltaTime: FIXED_DT });
  for (let i = 0; i < 30; i++) frame(s, settle, FIXED_DT);
  const recorder = new ReplayRecorder(s.scene, { channels: [vehicleInputChannel("car", s.vehicle)], hashEvery, meta: { map: "rolling" } });
  recorder.start();
  const rng = new Rng(seed);
  const clock = new ManualClock({ fixedDeltaTime: FIXED_DT });
  for (let i = 0; i < frames; i++) frame(s, clock, 0.004 + rng.nextFloat() * 0.045);
  return { rec: recorder.stop(), session: s };
}

/** A fresh scene brought to the recording's starting state (same build, same settle). */
function freshAtStart(): Session {
  const s = buildSession();
  const settle = new ManualClock({ fixedDeltaTime: FIXED_DT });
  for (let i = 0; i < 30; i++) frame(s, settle, FIXED_DT);
  return s;
}

function playThroughClock(s: Session, rec: unknown, wallDt: () => number): ReplayPlayer {
  const clock = new ManualClock({ fixedDeltaTime: FIXED_DT });
  const player = new ReplayPlayer(s.scene, rec, { channels: [vehicleInputChannel("car", s.vehicle)], clock });
  player.start();
  let guard = 0;
  while (!player.finished && guard++ < 100_000) frame(s, clock, wallDt());
  return player;
}

group("state hashing", () => {
  test("StateHasher folds exact bits; its digests are pinned (they are part of the replay format)", () => {
    const h = () => new StateHasher();
    assert.equal(h().digest(), h().digest());
    assert.notEqual(h().f64(1).digest(), h().f64(1 + Number.EPSILON).digest(), "one ulp differs");
    assert.notEqual(h().f64(0).digest(), h().f64(-0).digest(), "signed zero is state");
    assert.equal(h().f64(NaN).digest(), h().f64(-NaN).digest(), "NaN payloads are not");
    assert.notEqual(h().str("ab").str("c").digest(), h().str("a").str("bc").digest(), "strings are length-prefixed");
    assert.equal(h().value({ b: 1, a: [true, "x"] }).digest(), h().value({ a: [true, "x"], b: 1 }).digest(), "object keys are canonical");
    // Pinned: changing the folding invalidates every saved recording, so it must be deliberate.
    assert.equal(h().digest(), "ab3e7c0b92ca2f0e");
    assert.equal(h().f64(Math.PI).u32(42).str("forge").bool(true).digest(), "c374ab39f80f214a");
  });

  test("hashSceneState hashes part by part; games register their own parts", () => {
    const s = buildSession();
    const a = hashSceneState(s.scene);
    assert.deepEqual(Object.keys(a.parts).sort(), ["objects", "physics", "transforms", "vehicles"]);
    assert.deepEqual(hashSceneState(s.scene), a, "hashing reads state only");
    s.vehicle.velocity.x += 1e-12;
    const b = hashSceneState(s.scene);
    assert.notEqual(b.hash, a.hash);
    assert.deepEqual(Object.keys(a.parts).filter((p) => a.parts[p] !== b.parts[p]), ["vehicles"], "only the vehicle part moved");
    s.beacon.phase = 0.5;
    assert.notEqual(hashSceneState(s.scene).parts.objects, b.parts.objects, "scene objects' saved state is hashed");
    let score = 3;
    registerStateHashContributor("test.score", (_scene, h) => void h.f64(score));
    try {
      const withScore = hashSceneState(s.scene, { parts: ["test.score"] });
      score = 4;
      assert.notEqual(hashSceneState(s.scene, { parts: ["test.score"] }).hash, withScore.hash);
      assert.ok(stateHashParts().includes("test.score"));
      assert.throws(() => registerStateHashContributor("test.score", () => {}), /already registered/);
    } finally {
      unregisterStateHashContributor("test.score");
    }
    assert.throws(() => hashSceneState(s.scene, { parts: ["nope"] }), /unknown part/);
  });
});

group("clock scripting", () => {
  test("Clock.scriptFrames reports a recorded schedule exactly, then resumes from wall time without a jump", () => {
    const clock = new ManualClock({ fixedDeltaTime: FIXED_DT });
    clock.advance(FIXED_DT);
    const before = clock.fixedStepIndex;
    clock.scriptFrames([
      { dt: 0.05, fixedSteps: 3, alpha: 0.25 },
      { dt: 0, fixedSteps: 0, alpha: 0.25 },
      { dt: 0.01, fixedSteps: 0, alpha: 0.85 },
    ]);
    assert.deepEqual(clock.advance(1), { fixedSteps: 3, alpha: 0.25 }, "wall time is ignored");
    assert.equal(clock.deltaTime, 0.05);
    assert.deepEqual(clock.advance(1), { fixedSteps: 0, alpha: 0.25 });
    assert.deepEqual(clock.advance(1), { fixedSteps: 0, alpha: 0.85 });
    assert.equal(clock.fixedStepIndex, before + 3);
    assert.equal(clock.scriptedFramesRemaining, 0);
    // Back on wall time: the accumulator continues from alpha 0.85, so 0.15 of a step completes one.
    assert.equal(clock.advance(FIXED_DT * 0.2).fixedSteps, 1);
    clock.scriptFrames([{ dt: 1, fixedSteps: 9, alpha: 0 }]);
    clock.cancelScriptedFrames();
    assert.ok(clock.advance(FIXED_DT).fixedSteps <= 1, "cancelled frames are not played");
  });
});

group("record and play", () => {
  test("a vehicle session recorded under an uneven frame rate plays back bit-identically from a fresh scene, through JSON", () => {
    const { rec, session } = recordSession(720);
    assert.equal(rec.frames.length, 720);
    assert.equal(rec.checkpoints.length, 12);
    assert.ok(rec.frames.some((f) => f[1] === 0) && rec.frames.some((f) => f[1] >= 2), "the schedule mixes empty and multi-step frames");
    assert.ok(rec.frames.filter((f) => f.length === 3).length > 0, "unchanged frames carry no input");
    assert.ok(session.vehicle.distance > 20, `the car drove (${session.vehicle.distance.toFixed(1)} m)`);
    const starts = [-1, 0, 1];
    assert.ok(session.props.some((p, k) => Math.abs(p.body!.position.x - starts[k]!) > 1), "the car knocked a crate aside: contacts are part of what replays");
    const json = JSON.parse(JSON.stringify(rec)) as unknown;
    const fresh = freshAtStart();
    fresh.driver.enabled = false; // the recording drives now
    const rng = new Rng(99);
    const player = playThroughClock(fresh, json, () => 0.001 + rng.nextFloat() * 0.1);
    const result = player.result();
    assert.deepEqual(result.divergences, []);
    assert.ok(result.ok && result.finished);
    assert.equal(result.framesPlayed, 720);
    assert.equal(result.checkpointsCompared, 13, "12 checkpoints + the final state");
    assert.ok(Object.is(fresh.vehicle.position.x, session.vehicle.position.x) && Object.is(fresh.vehicle.position.z, session.vehicle.position.z), "bit-identical pose");
    assert.equal(hashSceneState(fresh.scene).hash, hashSceneState(session.scene).hash);
    player.stop();
    assert.equal(fresh.scene.world.systemByName("replay.play"), undefined, "detached");
    assert.ok(!fresh.scene.objects.some((o) => o.name.startsWith("replay.")));
  });

  test("live input is overridden during playback", () => {
    const { rec } = recordSession(240, 11);
    const fresh = freshAtStart();
    const noise = new Rng(5);
    // The live input code keeps running and writes garbage; the input point overwrites it.
    fresh.scene.world.systemByName("test.driver")!.enabled = false;
    fresh.scene.world.registerSystem(
      new (class extends System {
        readonly name = "test.noise";
        override readonly order = 60;
        update(): void {
          fresh.vehicle.input.throttle = noise.nextFloat();
          fresh.vehicle.input.steer = noise.nextFloat() * 2 - 1;
        }
      })(),
    );
    const player = playThroughClock(fresh, rec, () => FIXED_DT);
    assert.ok(player.result().ok, JSON.stringify(player.result().divergences[0]));
  });

  test("headless playback through player.frame(i), and a schedule that differs is reported", () => {
    const { rec } = recordSession(120, 3, 30);
    const run = (alter: boolean): ReplayPlayer => {
      const fresh = freshAtStart();
      fresh.driver.enabled = false;
      const player = new ReplayPlayer(fresh.scene, rec, { channels: [vehicleInputChannel("car", fresh.vehicle)] });
      player.start();
      const clock = new ManualClock({ fixedDeltaTime: FIXED_DT });
      for (let i = 0; i < player.framesTotal; i++) {
        const f = player.frame(i);
        const steps = alter && i === 40 ? f.fixedSteps + 1 : f.fixedSteps;
        clock.scriptFrames([{ ...f, fixedSteps: steps }]);
        const tick = clock.advance(0);
        const c = context(fresh.scene, clock, tick);
        fresh.scene.update(c, c.dt);
      }
      return player;
    };
    assert.ok(run(false).result().ok);
    const bad = run(true).result();
    assert.equal(bad.divergences[0]!.kind, "schedule");
    assert.equal(bad.divergences[0]!.frame, 40);
    assert.ok(bad.divergences.some((d) => d.kind === "checkpoint" && d.frame === 59), "and the state diverges at the next checkpoint");
  });
});

group("from a snapshot (19.3 + 19.4)", () => {
  test("a session snapshotted mid-run and replayed from that snapshot on an unsettled fresh scene matches", () => {
    const s = buildSession();
    const settle = new ManualClock({ fixedDeltaTime: FIXED_DT });
    for (let i = 0; i < 90; i++) frame(s, settle, FIXED_DT * (1 + (i % 3)));
    // Save the running simulation, then record what the player does from there.
    const snap = JSON.stringify(captureSceneSnapshot(s.scene));
    const recorder = new ReplayRecorder(s.scene, { channels: [vehicleInputChannel("car", s.vehicle)], hashEvery: 60 });
    recorder.start();
    const rng = new Rng(17);
    const clock = new ManualClock({ fixedDeltaTime: FIXED_DT });
    for (let i = 0; i < 480; i++) frame(s, clock, 0.004 + rng.nextFloat() * 0.045);
    const rec = JSON.parse(JSON.stringify(recorder.stop())) as unknown;
    // A fresh build that never ran: the snapshot alone brings it to where recording started.
    const fresh = buildSession();
    fresh.driver.enabled = false;
    frame(fresh, new ManualClock({ fixedDeltaTime: FIXED_DT }), FIXED_DT); // spawn the crates' bodies (19.3 matches bodies)
    restoreSceneSnapshot(fresh.scene, JSON.parse(snap));
    const player = playThroughClock(fresh, rec, () => FIXED_DT);
    assert.deepEqual(player.result().divergences, []);
    assert.ok(player.result().ok);
    assert.ok(Object.is(fresh.vehicle.position.z, s.vehicle.position.z), "bit-identical end pose");
  });
});

group("divergence", () => {
  test("a tampered input is caught at the first checkpoint after it, naming the parts that differ", () => {
    const { rec } = recordSession(360, 21, 30);
    const tampered = JSON.parse(JSON.stringify(rec)) as ReplayRecording;
    const at = tampered.frames.findIndex((f, i) => i > 100 && f.length === 4);
    (tampered.frames[at] as [number, number, number, number[][]])[3][0]![1] = 0.31; // throttle
    const fresh = freshAtStart();
    fresh.driver.enabled = false;
    const seen: string[] = [];
    const clock = new ManualClock({ fixedDeltaTime: FIXED_DT });
    const player = new ReplayPlayer(fresh.scene, tampered, { channels: [vehicleInputChannel("car", fresh.vehicle)], clock });
    player.start();
    while (!player.finished) {
      const tick = clock.advance(FIXED_DT);
      const c = context(fresh.scene, clock, tick);
      fresh.scene.update(c, c.dt);
    }
    const first = player.firstDivergence!;
    seen.push(...first.parts);
    assert.equal(first.kind, "checkpoint");
    const firstCheckpointAfter = rec.checkpoints.find((c) => c.frame >= at)!.frame;
    assert.equal(first.frame, firstCheckpointAfter);
    assert.ok(seen.includes("vehicles") && seen.includes("transforms"), seen.join(","));
    assert.ok(!seen.includes("objects"), "the beacon is unaffected by driving");
    assert.equal(player.result().ok, false);
  });

  test("a scene that does not start where the recording started is reported before playing", () => {
    const { rec } = recordSession(60, 2);
    const fresh = freshAtStart();
    fresh.vehicle.position.x += 0.5;
    const player = new ReplayPlayer(fresh.scene, rec, { channels: [vehicleInputChannel("car", fresh.vehicle)] });
    const initial = player.start();
    assert.equal(initial?.kind, "initial");
    assert.ok(initial!.parts.includes("vehicles"));
    player.stop();
  });
});

group("format", () => {
  test("validateReplay names the first problem; the player checks channels and the hash algorithm", () => {
    const { rec } = recordSession(30, 4, 10);
    assert.doesNotThrow(() => validateReplay(JSON.parse(JSON.stringify(rec))));
    const bad = (mut: (r: Record<string, unknown>) => void): unknown => {
      const r = JSON.parse(JSON.stringify(rec)) as Record<string, unknown>;
      mut(r);
      return r;
    };
    assert.throws(() => validateReplay(bad((r) => (r.format = "forge.scene"))), /format/);
    assert.throws(() => validateReplay(bad((r) => (r.version = 99))), /newer/);
    assert.throws(() => validateReplay(bad((r) => ((r.frames as unknown[])[3] = [0.1, -1, 0]))), /frames\[3\]/);
    assert.throws(() => validateReplay(bad((r) => ((r.frames as unknown[])[5] = [0.1, 1, 0, [[3, 1]]]))), /unknown channel/);
    assert.throws(() => validateReplay(bad((r) => ((r.final as { frame: number }).frame = 3))), /final.frame/);
    assert.throws(() => validateReplay(bad((r) => ((r.initial as { values: number[][] }).values = [[1]]))), /initial.values\[0\]/);
    const s = freshAtStart();
    assert.throws(() => new ReplayPlayer(s.scene, rec, { channels: [] }), /no channel named "car"/);
    assert.throws(() => new ReplayPlayer(s.scene, rec, { channels: [fieldsChannel("car", s.vehicle.input, ["throttle"])] }), /size 1/);
    assert.throws(() => new ReplayPlayer(s.scene, bad((r) => (r.hashAlgorithm = "other")), { channels: [vehicleInputChannel("car", s.vehicle)] }), /hash/);
    assert.throws(() => new ReplayPlayer(s.scene, rec, { channels: [vehicleInputChannel("car", s.vehicle)], clock: new ManualClock({ fixedDeltaTime: 1 / 30 }) }), /steps/);
  });

  test("fieldsChannel records numbers and booleans and refuses other fields", () => {
    const target = { aim: 0.25, firing: true, label: "x" };
    const ch = fieldsChannel("turret", target, ["aim", "firing"]);
    const out: number[] = [];
    ch.read(out);
    assert.deepEqual(out, [0.25, 1]);
    ch.write([0.5, 0]);
    assert.deepEqual([target.aim, target.firing], [0.5, false]);
    assert.throws(() => fieldsChannel("bad", target, ["label"]), /not a number or boolean/);
  });
});

await finish();
