/**
 * @suite scene:simulationSnapshot
 * @group integration
 * @covers engine/src/core/snapshot.ts
 * @covers engine/src/scene/snapshot.ts
 * @covers engine/src/scene/systems.ts
 * @covers engine/src/math/rng.ts
 * @covers engine/src/physics/world.ts
 * @covers engine/src/physics/system.ts
 * @covers engine/src/vehicles/vehicle.ts
 * @covers engine/src/vehicles/components.ts
 * @covers engine/src/environment/weather.ts
 * @covers engine/src/environment/dayNight.ts
 * @covers engine/src/environment/lightning.ts
 * @desc Phase 19.3: simulation snapshots — physics, vehicle, weather and RNG state restored mid-run continue bit-for-bit (through JSON) as the uninterrupted run did, and a scene-level snapshot of a driven vehicle session reproduces its state hash
 */

export const suite = {
  name: "scene:simulationSnapshot",
  group: "integration",
  covers: [
    "engine/src/core/snapshot.ts",
    "engine/src/scene/snapshot.ts",
    "engine/src/scene/systems.ts",
    "engine/src/math/rng.ts",
    "engine/src/physics/world.ts",
    "engine/src/physics/system.ts",
    "engine/src/vehicles/vehicle.ts",
    "engine/src/vehicles/components.ts",
    "engine/src/environment/weather.ts",
    "engine/src/environment/dayNight.ts",
    "engine/src/environment/lightning.ts",
  ],
  desc: "Phase 19.3: simulation snapshots — physics, vehicle, weather and RNG state restored mid-run continue bit-for-bit (through JSON) as the uninterrupted run did, and a scene-level snapshot of a driven vehicle session reproduces its state hash",
};
import assert from "node:assert/strict";
import { finish, group, test } from "selrun";
import {
  BoxShape,
  Clock,
  ColliderComponent,
  DayNightCycle,
  LightningSystem,
  LogLevel,
  Logger,
  PhysicsSystem,
  PhysicsWorld,
  PlaneShape,
  Profiler,
  RigidBody,
  RigidBodyComponent,
  Rng,
  Scene,
  SphereShape,
  SystemScratch,
  Vec3,
  Vehicle,
  VehicleComponent,
  VehicleSystem,
  WeatherSystem,
  captureSceneSnapshot,
  captureState,
  createVehicleConfig,
  hashSceneSnapshot,
  hashState,
  restoreSceneSnapshot,
  restoreState,
  type GroundQuery,
  type SystemContext,
} from "@forge/engine";

const json = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

group("structural capture (core/snapshot.ts)", () => {
  test("numbers survive JSON exactly, including -0, NaN, the infinities and float32 arrays", () => {
    const o = { a: -0, b: Number.NaN, c: Infinity, d: -Infinity, e: 0.1 + 0.2, f: new Float32Array([Math.fround(1 / 3), -0]), g: [1, -0], nested: { v: new Vec3(1e-300, -2, 3) } };
    const snap = json(captureState(o));
    const target = { a: 1, b: 1, c: 1, d: 1, e: 1, f: new Float32Array(2), g: [0, 0], nested: { v: new Vec3() } };
    restoreState(target, snap);
    assert.ok(Object.is(target.a, -0) && Number.isNaN(target.b) && target.c === Infinity && target.d === -Infinity);
    assert.equal(target.e, 0.1 + 0.2);
    assert.ok(Object.is(target.f[0], Math.fround(1 / 3)) && Object.is(target.f[1], -0));
    assert.ok(Object.is(target.g[1], -0));
    assert.ok(target.nested.v instanceof Vec3, "nested objects are written into, not replaced");
    assert.deepEqual(target.nested.v.toArray(), [1e-300, -2, 3]);
  });

  test("functions and skipped fields are left out, shared references are written once, and a shape mismatch is refused", () => {
    const shared = { n: 1 };
    const o = { f: () => 1, ext: { big: 1 }, x: shared, y: shared, list: [1, 2, 3] };
    const s = captureState(o, { skip: ["ext"] });
    assert.deepEqual(Object.keys(s), ["x", "list"]);
    assert.throws(() => restoreState({ list: [1, 2] }, { list: [1, 2, 3] }), /has 2 entries, the snapshot 3/);
    assert.throws(() => restoreState({ list: 5 }, { list: [1] }), /is not an array/);
    assert.equal(hashState({ a: 1, b: [2] }), hashState({ b: [2], a: 1 }), "the hash ignores key order");
    assert.notEqual(hashState({ a: 1 }), hashState({ a: 1.0000000000000002 }));
  });
});

group("RNG state", () => {
  test("snapshot() carries the cached Gaussian, so a restored stream continues exactly; restore() clears it", () => {
    const rng = new Rng(1234);
    for (let i = 0; i < 7; i++) rng.nextGaussian(); // odd count: a second value is cached
    const snap = json(rng.snapshot());
    assert.equal(snap.hasSpare, true);
    const expected = Array.from({ length: 9 }, () => rng.nextGaussian());
    const fork = new Rng(1);
    fork.restoreSnapshot(snap);
    assert.deepEqual(Array.from({ length: 9 }, () => fork.nextGaussian()), expected);
    const pos = new Rng(9).save();
    const r = new Rng(9);
    r.nextGaussian();
    r.restore(pos);
    const fresh = new Rng(9);
    assert.equal(r.nextGaussian(), fresh.nextGaussian(), "restore() no longer replays a stale cached value");
  });
});

function physicsWorld(): PhysicsWorld {
  const w = new PhysicsWorld();
  w.addBody(new RigidBody({ type: "static", shape: new PlaneShape(new Vec3(0, 1, 0), 0) }));
  for (let i = 0; i < 8; i++) {
    w.addBody(new RigidBody({
      shape: i % 2 ? new SphereShape(0.45) : new BoxShape(0.4, 0.4, 0.4),
      position: { x: (i % 3) * 0.35, y: 0.6 + i * 0.95, z: (i % 2) * 0.25 },
      angularVelocity: { x: 0.2 * i, y: 0.1, z: 0.35 },
    }));
  }
  return w;
}

group("physics state", () => {
  test("a pile restored mid-collision (through JSON, into a fresh world) continues bit-for-bit", () => {
    for (const at of [12, 40, 90]) {
      const a = physicsWorld();
      a.stepDeterministic(at);
      const snap = json(a.snapshot());
      a.stepDeterministic(150);
      const b = physicsWorld();
      b.restoreSnapshot(snap);
      b.stepDeterministic(150);
      assert.equal(hashState(json(b.snapshot()) as never), hashState(json(a.snapshot()) as never), `snapshot at step ${at}`);
      assert.equal(b.stepCount, at + 150);
    }
  });

  test("a world with other bodies, or the same bodies in another order, is refused before anything changes", () => {
    const a = physicsWorld();
    a.stepDeterministic(5);
    const snap = a.snapshot();
    const fewer = physicsWorld();
    fewer.removeBody(fewer.bodies[3]!);
    const before = fewer.bodies.map((b) => b.position.y);
    assert.throws(() => fewer.restoreSnapshot(snap), /do not match the snapshot/);
    assert.deepEqual(fewer.bodies.map((b) => b.position.y), before, "untouched");
  });
});

const rolling: GroundQuery = {
  sample(x, z, out) {
    out.height = 0.06 * Math.sin(x * 0.3) + 0.05 * Math.cos(z * 0.21);
    out.nx = 0;
    out.ny = 1;
    out.nz = 0;
  },
};
function driveInput(v: Vehicle, i: number): void {
  v.input.throttle = i % 240 < 170 ? 0.85 : 0;
  v.input.brake = i % 240 >= 200 ? 0.7 : 0;
  v.input.steer = Math.sin(i * 0.017) * 0.75;
  v.input.handbrake = i % 480 > 450 ? 1 : 0;
}

group("vehicle state", () => {
  test("a car restored mid-drive (wheel spin, suspension, engine, gear) continues bit-for-bit", () => {
    const a = new Vehicle(createVehicleConfig());
    for (let i = 0; i < 333; i++) {
      driveInput(a, i);
      a.step(1 / 60, rolling);
    }
    const snap = json(a.snapshot());
    const b = new Vehicle(createVehicleConfig());
    b.restoreSnapshot(snap);
    for (let i = 333; i < 900; i++) {
      driveInput(a, i);
      a.step(1 / 60, rolling);
      driveInput(b, i);
      b.step(1 / 60, rolling);
    }
    assert.ok(a.distance > 50, `the car drove (${a.distance.toFixed(1)} m)`);
    assert.equal(hashState(b.snapshot()), hashState(a.snapshot()));
    assert.equal(b.gear, a.gear);
    assert.equal(b.rpm, a.rpm);
  });
});

group("weather and lightning state", () => {
  test("weather and day/night restored mid-storm continue exactly; the lightning keeps its strike schedule", () => {
    const build = () => {
      const scene = new Scene();
      const weather = new WeatherSystem({ seed: 11, initial: "overcast", target: "storm" });
      const sky = new DayNightCycle({ timeScale: 900 });
      const lightning = new LightningSystem({ seed: 21, rate: 3 });
      scene.add(weather);
      scene.add(sky);
      scene.add(lightning);
      return { scene, weather, sky, lightning };
    };
    const run = (s: ReturnType<typeof build>, seconds: number) => {
      for (let t = 0; t < seconds * 10; t++) {
        s.weather.advance(0.1);
        s.sky.advance(0.1);
        s.lightning.advance(0.1);
      }
    };
    const a = build();
    run(a, 120);
    const snap = json({ w: a.weather.snapshotState(), d: a.sky.snapshotState(), l: a.lightning.snapshotState() });
    const strikesBefore = a.lightning.strikeCount;
    run(a, 200);
    const b = build();
    b.weather.restoreSnapshotState(snap.w);
    b.sky.restoreSnapshotState(snap.d);
    b.lightning.restoreSnapshotState(snap.l);
    run(b, 200);
    assert.deepEqual({ ...b.weather.state }, { ...a.weather.state });
    assert.deepEqual({ ...b.weather.surface }, { ...a.weather.surface });
    assert.equal(b.sky.timeOfDay, a.sky.timeOfDay);
    assert.equal(b.sky.dayOfYear, a.sky.dayOfYear);
    assert.ok(a.lightning.strikeCount > strikesBefore + 5, "the storm struck after the snapshot");
    assert.equal(b.lightning.strikeCount, a.lightning.strikeCount, "the same number of strikes, from the same schedule");
    assert.equal(hashState(b.lightning.snapshotState()), hashState(a.lightning.snapshotState()));
  });
});

// ---------------------------------------------------------------- the scene-level session

function context(scene: Scene, frame: number): SystemContext {
  return {
    world: scene.world,
    clock: new Clock(),
    dt: 1 / 60,
    fixedDt: 1 / 60,
    fixedSteps: 1,
    alpha: 0,
    elapsed: frame / 60,
    frame,
    logger: new Logger({ level: LogLevel.Silent }),
    profiler: new Profiler(),
    services: { get: () => undefined, engineConfig: {} },
    scratch: new SystemScratch(),
  };
}

function session(): { scene: Scene; car: Vehicle; step: (frame: number) => void; dispose: () => void } {
  const scene = new Scene({ name: "snapshot-session" });
  const physics = new PhysicsSystem();
  physics.world.addBody(new RigidBody({ type: "static", shape: new PlaneShape(new Vec3(0, 1, 0), 0) }));
  scene.world.registerSystem(physics);
  scene.world.registerSystem(new VehicleSystem());
  for (let i = 0; i < 5; i++) {
    const crate = scene.createTransformedEntity(`crate${i}`, new Vec3(3 + i * 0.7, 1 + i * 1.3, 4 + (i % 2) * 0.4));
    const rb = new RigidBodyComponent();
    rb.bodyType = "dynamic";
    rb.mass = 2 + i;
    crate.add(rb);
    crate.add(new ColliderComponent().setBox(0.3, 0.3, 0.3));
  }
  const car = new Vehicle(createVehicleConfig());
  const carEntity = scene.createTransformedEntity("car", new Vec3());
  carEntity.add(new VehicleComponent(car, rolling));
  scene.add(new WeatherSystem({ seed: 7, initial: "rain", target: "storm" }));
  scene.add(new DayNightCycle({ timeScale: 600 }));
  return {
    scene,
    car,
    step: (frame) => {
      driveInput(car, frame);
      const c = context(scene, frame);
      scene.update(c, c.dt);
    },
    dispose: () => scene.dispose(),
  };
}

group("scene snapshots (vehicle session)", () => {
  test("the same inputs from the same start give the same state hash (19.5's check, on two fresh sessions)", () => {
    const a = session();
    const b = session();
    for (let f = 1; f <= 400; f++) {
      a.step(f);
      b.step(f);
    }
    assert.equal(hashSceneSnapshot(captureSceneSnapshot(b.scene)), hashSceneSnapshot(captureSceneSnapshot(a.scene)));
    a.dispose();
    b.dispose();
  });

  test("a session restored from a mid-drive snapshot (through JSON) reaches the same state hash as the uninterrupted one", () => {
    const a = session();
    for (let f = 1; f <= 300; f++) a.step(f);
    const snap = json(captureSceneSnapshot(a.scene));
    assert.ok(snap.components.some((c) => c.type === "Vehicle"), "the vehicle is in the snapshot");
    assert.ok(snap.systems["physics"] && snap.objects["weather"] && snap.objects["dayNight"]);
    for (let f = 301; f <= 600; f++) a.step(f);
    const expected = hashSceneSnapshot(captureSceneSnapshot(a.scene));

    const b = session();
    b.step(1); // spawn the crates' bodies, so the physics world has the snapshot's bodies
    restoreSceneSnapshot(b.scene, snap);
    for (let f = 301; f <= 600; f++) b.step(f);
    assert.equal(hashSceneSnapshot(captureSceneSnapshot(b.scene)), expected);
    assert.ok(a.car.distance > 40, `the car drove (${a.car.distance.toFixed(1)} m)`);
    const crateY = (s: Scene) => s.world.facade(s.world.findByName("crate4")[0]!)!.transform.position.y;
    assert.equal(crateY(b.scene), crateY(a.scene));
    a.dispose();
    b.dispose();
  });

  test("a scene with a different structure is refused before anything changes", () => {
    const a = session();
    a.step(1);
    const snap = captureSceneSnapshot(a.scene);
    const b = session();
    b.step(1);
    b.scene.createTransformedEntity("extra", new Vec3());
    const carBefore = b.car.snapshot();
    assert.throws(() => restoreSceneSnapshot(b.scene, snap), /entities do not match/);
    assert.deepEqual(b.car.snapshot(), carBefore);
    assert.throws(() => restoreSceneSnapshot(b.scene, { format: "nope" }), /not a forge.snapshot/);
    a.dispose();
    b.dispose();
  });
});

await finish();
