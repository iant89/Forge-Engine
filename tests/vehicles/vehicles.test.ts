/**
 * @suite vehicles:vehicles
 * @group unit
 * @covers engine/src/core/log.ts
 * @covers engine/src/core/time.ts
 * @covers engine/src/debug/profiler.ts
 * @covers engine/src/index.ts
 * @covers engine/src/scene/components/index.ts
 * @covers engine/src/scene/systems.ts
 * @covers engine/src/scene/world.ts
 * @covers engine/src/vehicles/components.ts
 * @covers engine/src/vehicles/damage.ts
 * @covers engine/src/vehicles/drivetrain.ts
 * @covers engine/src/vehicles/electric.ts
 * @covers engine/src/vehicles/ground.ts
 * @covers engine/src/vehicles/loads.ts
 * @covers engine/src/vehicles/pacejka.ts
 * @covers engine/src/vehicles/system.ts
 * @covers engine/src/vehicles/vehicle.ts
 * @desc Pins vehicles behavior and regression guarantees
 */

export const suite = {
  name: "vehicles:vehicles",
  group: "unit",
  covers:   [
    "engine/src/core/log.ts",
    "engine/src/core/time.ts",
    "engine/src/debug/profiler.ts",
    "engine/src/index.ts",
    "engine/src/scene/components/index.ts",
    "engine/src/scene/systems.ts",
    "engine/src/scene/world.ts",
    "engine/src/vehicles/components.ts",
    "engine/src/vehicles/damage.ts",
    "engine/src/vehicles/drivetrain.ts",
    "engine/src/vehicles/electric.ts",
    "engine/src/vehicles/ground.ts",
    "engine/src/vehicles/loads.ts",
    "engine/src/vehicles/pacejka.ts",
    "engine/src/vehicles/system.ts",
    "engine/src/vehicles/vehicle.ts"
  ],
  desc: "Pins vehicles behavior and regression guarantees",
};
import assert from "node:assert/strict";
import { assertCloseTo, finish, group, test } from "selrun";
import {
  Clock,
  ElectricMotor,
  EngineModel,
  EntityWorld,
  Logger,
  Profiler,
  ReductionDrive,
  SystemScratch,
  Transmission,
  Transform,
  Vehicle,
  VehicleComponent,
  VehicleSystem,
  aeroLoads,
  axleLoad,
  computeWheelLoads,
  createVehicleConfig,
  distributeWheelLoads,
  flatGround,
  pacejka,
  pacejkaPeakSlip,
  slopeGround,
  splitDriveTorque,
  tractionControlScale,
  type SystemContext,
  DEFAULT_LONGITUDINAL,
  createVehicleDamageZones,
  applyBodyDamage,
  applyWheelDamage,
  computeBodyCrushOffset,
  WHEEL_DETACH_DAMAGE,
  WHEEL_BEND_MAX,
} from "@forge/engine";

function ctx(world: EntityWorld, fixedDt = 1 / 60, fixedSteps = 1): SystemContext {
  return {
    world,
    clock: new Clock(),
    dt: fixedDt,
    fixedDt,
    fixedSteps,
    alpha: 0,
    elapsed: 0,
    frame: 1,
    logger: new Logger(),
    profiler: new Profiler(),
    services: { get: () => undefined, engineConfig: {} },
    scratch: new SystemScratch(),
  };
}

function run(v: Vehicle, ground: ReturnType<typeof flatGround>, seconds: number, dt = 1 / 60): void {
  const steps = Math.round(seconds / dt);
  for (let i = 0; i < steps; i++) v.step(dt, ground);
}

group("vehicles — Pacejka, drivetrain, loads", () => {
  test("magic formula is odd, zero at zero slip, and peaks near the sampled slip", () => {
    const peak = pacejkaPeakSlip(DEFAULT_LONGITUDINAL);
    assertCloseTo(pacejka(0, { ...DEFAULT_LONGITUDINAL, D: 1000 }), 0, 8);
    const pos = pacejka(0.2, { ...DEFAULT_LONGITUDINAL, D: 1000 });
    const neg = pacejka(-0.2, { ...DEFAULT_LONGITUDINAL, D: 1000 });
    assertCloseTo(pos, -neg, 6);
    assert.ok(Math.abs(pacejka(peak, { ...DEFAULT_LONGITUDINAL, D: 1 })) > 0.9);
    assert.ok(peak > 0.05);
    assert.ok(peak < 0.4);
  });

  test("converts a constant torque into the analytic RPM (I·α = τ)", () => {
    const engine = new EngineModel({
      inertia: 0.25,
      peakTorque: 100,
      frictionTorque: 0,
      idleRpm: 0,
      redlineRpm: 20000,
    });
    engine.throttle = 1;
    const dt = 1 / 60;
    for (let i = 0; i < 60; i++) engine.step(dt, 0);
    // α = 100 / 0.25 = 400 rad/s², one second, ω = 400.
    assertCloseTo(engine.omega, 400, 4);
    assertCloseTo(engine.rpm, (400 * 60) / (2 * Math.PI), 2);
  });

  test("holds the crank at the rev limiter", () => {
    const engine = new EngineModel({ inertia: 0.1, peakTorque: 200, frictionTorque: 0, idleRpm: 0, redlineRpm: 3000 });
    engine.throttle = 1;
    for (let i = 0; i < 600; i++) engine.step(1 / 60, 0);
    assert.ok(engine.rpm <= 3000 + 1e-6);
    assert.equal(engine.deliveredTorque(), 0);
  });

  test("shifts up at the upshift RPM and down at the downshift RPM", () => {
    const box = new Transmission({ ratios: [3, 2, 1.4], upshiftRpm: 5500, downshiftRpm: 2000, shiftDuration: 0.1, upshiftThrottle: 0.2 });
    assert.equal(box.update(5400, 1, 1 / 60), false);
    assert.equal(box.gear, 1);
    assert.equal(box.update(5500, 1, 0), true);
    assert.equal(box.gear, 2);
    assert.equal(box.ratio, 0);
    box.shiftTimer = 0;
    assertCloseTo(box.ratio, 2 * box.finalDrive, 2);
    assert.equal(box.update(1900, 0, 0), true);
    assert.equal(box.gear, 1);
    // Coasting in below the throttle gate must not upshift.
    const coast = new Transmission({ ratios: [3, 2], upshiftRpm: 4000, upshiftThrottle: 0.5 });
    assert.equal(coast.update(5000, 0.1, 0), false);
    assert.equal(coast.gear, 1);
  });

  test("splits drive torque equally when open, and toward the slower wheel when LSD", () => {
    const wheels = [
      { driven: true, omega: 2 },
      { driven: true, omega: 40 },
      { driven: false, omega: 0 },
    ];
    const open = splitDriveTorque(100, wheels, "open");
    assertCloseTo(open[0], 50, 2);
    assertCloseTo(open[1], 50, 2);
    assert.equal(open[2], 0);
    const lsd = splitDriveTorque(100, wheels, "lsd", 3);
    assertCloseTo(lsd[0]! + lsd[1]!, 100, 5);
    assert.ok(lsd[0]! > lsd[1]!);
    assert.equal(lsd[2], 0);
  });

  test("computes aero drag as ½ρCdAv²", () => {
    const loads = aeroLoads(10, { rho: 1.2, dragCoefficient: 0.5, liftCoefficient: 0.2, frontalArea: 2 });
    assertCloseTo(loads.drag, 60, 6);
    assertCloseTo(loads.downforce, 24, 6);
  });

  test("transfers load rearward under acceleration and forward under braking", () => {
    const base = { mass: 1200, gravity: 9.81, wheelbase: 2.6, cgToFront: 1.3, cgHeight: 0.55, track: 1.6, ay: 0 };
    const accel = computeWheelLoads({ ...base, ax: 4 });
    const brake = computeWheelLoads({ ...base, ax: -4 });
    const lat = computeWheelLoads({ ...base, ax: 0, ay: 3 });
    assert.ok(axleLoad(accel, "rear") > axleLoad(accel, "front"));
    assert.ok(axleLoad(brake, "front") > axleLoad(brake, "rear"));
    assert.ok(lat.fl + lat.rl > lat.fr + lat.rr);
    const weight = 1200 * 9.81;
    assertCloseTo(accel.fl + accel.fr + accel.rl + accel.rr, weight, 4);
    // A hard lateral accel can lift the inside wheels; loads stay non-negative.
    const lift = computeWheelLoads({ ...base, ax: 0, ay: 40 });
    assert.equal(lift.fr, 0);
    assert.ok(lift.fl > 0);
  });

  test("fits six-wheel loads through the hardpoints: sum = weight, transfer, non-negative", () => {
    // Perseverance-style layout: front / middle / rear axles, +Z forward, +X right.
    const mass = 1025;
    const gravity = 3.72;
    const weight = mass * gravity;
    const wheels = [
      { x: -1.1, z: 1.1 },
      { x: 1.1, z: 1.1 },
      { x: -1.2, z: -0.09 },
      { x: 1.2, z: -0.09 },
      { x: -1.1, z: -1.17 },
      { x: 1.1, z: -1.17 },
    ];
    const cgHeight = 0.55;
    const rest = distributeWheelLoads(wheels, { mass, gravity, cgHeight, ax: 0, ay: 0 });
    assert.equal((rest).length, 6);
    let sum = 0;
    for (const l of rest) {
      assert.equal(Number.isFinite(l), true);
      assert.ok(l >= 0);
      sum += l;
    }
    assertCloseTo(sum, weight, 6);

    // Accel (ax > 0) unloads the front axle pair; braking reverses it.
    const accel = distributeWheelLoads(wheels, { mass, gravity, cgHeight, ax: 3, ay: 0 });
    const frontA = accel[0]! + accel[1]!;
    const rearA = accel[4]! + accel[5]!;
    assert.ok(rearA > frontA);
    assertCloseTo(accel.reduce((a, b) => a + b, 0), weight, 6);
    const brake = distributeWheelLoads(wheels, { mass, gravity, cgHeight, ax: -3, ay: 0 });
    assert.ok(brake[0]! + brake[1]! > brake[4]! + brake[5]!);

    // Lateral (+ay, accel right) loads the left wheels; hard transfers clamp at zero, never below.
    const lat = distributeWheelLoads(wheels, { mass, gravity, cgHeight, ax: 0, ay: 3 });
    const left = lat[0]! + lat[2]! + lat[4]!;
    const right = lat[1]! + lat[3]! + lat[5]!;
    assert.ok(left > right);
    const hard = distributeWheelLoads(wheels, { mass, gravity, cgHeight, ax: 0, ay: 60 });
    for (const l of hard) assert.ok(l >= 0);
  });

  test("scales drive torque down once slip exceeds the TC threshold", () => {
    assert.equal(tractionControlScale(0.05, 0.12, 6), 1);
    assert.ok(tractionControlScale(0.3, 0.12, 6) < 0.2);
  });
});

group("vehicles — chassis", () => {
  function car(overrides: Parameters<typeof createVehicleConfig>[0] = {}) {
    const vehicle = new Vehicle(createVehicleConfig({ aero: null, tcEnabled: true, absEnabled: true, ...overrides }));
    const ground = flatGround(0);
    vehicle.placeOnGround(ground);
    return { vehicle, ground };
  }

  test("selects reverse only while effectively stopped", () => {
    const { vehicle } = car();
    assert.equal(vehicle.selectDriveDirection(true), true);
    assert.equal(vehicle.gear, -1);
    assert.ok(vehicle.config.transmission.shiftTimer > 0);
    vehicle.setVelocity(0, 0, 2);
    assert.equal(vehicle.selectDriveDirection(false), false);
    assert.equal(vehicle.gear, -1);
    assert.equal(vehicle.selectGear(0), true);
    assert.equal(vehicle.gear, 0);
    assert.equal(vehicle.selectGear(1), false);
    vehicle.setVelocity(0, 0, 0);
    assert.equal(vehicle.selectDriveDirection(false), true);
    assert.equal(vehicle.gear, 1);
  });

  test("stops from 20 m/s within 15% of v² / (2μg)", () => {
    const { vehicle, ground } = car({
      mass: 1000,
      gravity: 9.81,
      mu: 1,
      maxBrakeTorque: 8000,
      wheelRadius: 0.3,
    });
    vehicle.config.transmission.gear = 0;
    vehicle.setVelocity(0, 0, 20);
    vehicle.input.brake = 1;
    const ideal = (20 * 20) / (2 * 1 * 9.81);
    let distance = 0;
    const startZ = vehicle.position.z;
    for (let i = 0; i < 60 * 8; i++) {
      vehicle.step(1 / 60, ground);
      if (vehicle.speed < 0.2) break;
    }
    distance = vehicle.position.z - startZ;
    assert.ok(vehicle.speed < 0.25);
    assert.ok(distance > ideal * 0.75, `stopped in ${distance.toFixed(3)} m, ideal ${ideal.toFixed(3)} m`);
    assert.ok(distance < ideal * 1.15);
  });

  test("climbs a 12° slope when μ exceeds tan(θ), gaining both z and height", () => {
    const theta = (12 * Math.PI) / 180;
    const ground = slopeGround(theta, "z");
    const vehicle = new Vehicle(
      createVehicleConfig({
        mass: 1200,
        mu: 1.1,
        aero: null,
        tcEnabled: true,
        engine: new EngineModel({ peakTorque: 420, inertia: 0.25, idleRpm: 700, redlineRpm: 7000, frictionTorque: 8 }),
      }),
    );
    vehicle.placeOnGround(ground);
    const y0 = vehicle.position.y;
    vehicle.input.throttle = 1;
    run(vehicle, ground, 4);
    assert.ok(vehicle.position.z > 4);
    assert.ok(vehicle.position.y > y0 + 0.5);
    assert.equal(Number.isFinite(vehicle.position.y), true);
  });

  test("reports more rear load while accelerating and more front load while braking", () => {
    const { vehicle, ground } = car({ mass: 1400, mu: 1.2, cgHeight: 0.55 });
    vehicle.input.throttle = 1;
    run(vehicle, ground, 0.6);
    assert.ok(vehicle.ax > 1);
    const accel = vehicle.wheelLoads();
    assert.ok(axleLoad(accel, "rear") > axleLoad(accel, "front"));

    vehicle.input.throttle = 0;
    vehicle.input.brake = 1;
    vehicle.setVelocity(0, 0, 18);
    run(vehicle, ground, 0.3);
    assert.ok(vehicle.ax < -1);
    const braking = vehicle.wheelLoads();
    assert.ok(axleLoad(braking, "front") > axleLoad(braking, "rear"));
  });

  test("drives a six-wheel rover config with finite, non-negative per-wheel loads", () => {
    const base = createVehicleConfig({ aero: null, mass: 1025, gravity: 3.72, wheelRadius: 0.264 });
    const sixWheels = [
      { x: -1.1, z: 1.1, driven: true, steered: true, handbrake: false },
      { x: 1.1, z: 1.1, driven: true, steered: true, handbrake: false },
      { x: -1.2, z: -0.09, driven: true, steered: false, handbrake: false },
      { x: 1.2, z: -0.09, driven: true, steered: false, handbrake: false },
      { x: -1.1, z: -1.17, driven: true, steered: true, handbrake: true },
      { x: 1.1, z: -1.17, driven: true, steered: true, handbrake: true },
    ];
    const vehicle = new Vehicle({
      ...base,
      wheels: sixWheels,
      wheelbase: 2.27,
      track: 2.2,
      cgToFront: 1.1,
      cgHeight: 0.55,
      springRate: (1025 * 3.72) / (6 * 0.05),
    });
    const ground = flatGround(0);
    vehicle.placeOnGround(ground);
    // The equilibrium sits on the six-wheel share of the weight, inside the travel.
    assert.ok(vehicle.equilibriumCompression() > 0);
    assert.ok(vehicle.equilibriumCompression() <= vehicle.config.suspensionTravel);

    vehicle.input.throttle = 1;
    run(vehicle, ground, 2);
    assert.ok(vehicle.position.z > 0.5);
    assert.equal(Number.isFinite(vehicle.position.y), true);
    let restingSum = 0;
    for (const w of vehicle.wheels) {
      assert.equal(Number.isFinite(w.normalLoad), true);
      assert.ok(w.normalLoad >= 0);
      restingSum += w.normalLoad;
    }
    // Contact wheels between them carry the (possibly transferred) weight.
    assert.ok(restingSum > 1025 * 3.72 * 0.5);
    assert.ok(restingSum <= 1025 * 3.72 * 1.5);

    // Handbrake + throttle-free settle still leaves sane loads.
    vehicle.input.throttle = 0;
    vehicle.input.handbrake = 1;
    run(vehicle, ground, 0.5);
    for (const w of vehicle.wheels) assert.ok(w.normalLoad >= 0);
  });

  test("upshifts under throttle within two seconds", () => {
    const transmission = new Transmission({
      ratios: [3.2, 2.0, 1.3],
      finalDrive: 3.8,
      upshiftRpm: 2800,
      downshiftRpm: 800,
      shiftDuration: 0.05,
      upshiftThrottle: 0.2,
    });
    const { vehicle, ground } = car({
      mass: 900,
      mu: 1.3,
      transmission,
      engine: new EngineModel({ peakTorque: 380, inertia: 0.2, idleRpm: 600, redlineRpm: 8000, frictionTorque: 0 }),
    });
    vehicle.input.throttle = 1;
    run(vehicle, ground, 2.5);
    assert.ok(vehicle.config.transmission.shiftCount >= 1);
    assert.ok(vehicle.gear > 1);
  });

  test("keeps driven-wheel slip lower with traction control than without", () => {
    function launch(tc: boolean) {
      const vehicle = new Vehicle(
        createVehicleConfig({
          mass: 1100,
          mu: 0.25,
          aero: null,
          tcEnabled: tc,
          absEnabled: false,
          engine: new EngineModel({ peakTorque: 700, inertia: 0.15, idleRpm: 0, redlineRpm: 9000, frictionTorque: 0 }),
          transmission: new Transmission({ ratios: [2.8], finalDrive: 4.1, upshiftRpm: 20000, downshiftRpm: 0 }),
        }),
      );
      const ground = flatGround(0);
      vehicle.placeOnGround(ground);
      vehicle.input.throttle = 1;
      let peak = 0;
      for (let i = 0; i < 90; i++) {
        vehicle.step(1 / 60, ground);
        for (const w of vehicle.wheels) if (w.driven) peak = Math.max(peak, Math.abs(w.kappa));
      }
      return peak;
    }
    const withTc = launch(true);
    const without = launch(false);
    assert.ok(withTc < 0.35);
    assert.ok(without > withTc + 0.15);
  });

  test("is deterministic for the same inputs", () => {
    function sample() {
      const { vehicle, ground } = car({ mass: 1300, mu: 1 });
      vehicle.input.throttle = 0.7;
      vehicle.input.steer = 0.15;
      run(vehicle, ground, 2);
      return [vehicle.position.x, vehicle.position.y, vehicle.position.z, vehicle.yaw, vehicle.rpm, vehicle.gear];
    }
    assert.deepEqual(sample(), sample());
  });

  test("steps from VehicleSystem once per fixed step, and writes the chassis transform", () => {
    const world = new EntityWorld();
    const ground = flatGround(0);
    const vehicle = new Vehicle(createVehicleConfig({ aero: null, mass: 1000 }));
    vehicle.placeOnGround(ground);
    vehicle.input.throttle = 1;
    const entity = world.createEntity("car");
    entity.add(new Transform());
    entity.add(new VehicleComponent(vehicle, ground));
    world.registerSystem(new VehicleSystem());
    world.runSystems(ctx(world, 1 / 60, 3));
    // step(1/60) substeps at 1/120, so three fixed steps are six integrates.
    assert.equal(vehicle.stepCount, 6);
    const t = entity.get(Transform)!;
    assertCloseTo(t.position.z, vehicle.position.z, 5);
    assertCloseTo(t.position.y, vehicle.position.y, 5);
    world.dispose();
  });
});

group("vehicles — brakes and the parking brake", () => {
  function parked(overrides: Parameters<typeof createVehicleConfig>[0] = {}) {
    const vehicle = new Vehicle(createVehicleConfig({ aero: null, ...overrides }));
    const ground = flatGround(0);
    vehicle.placeOnGround(ground);
    return { vehicle, ground };
  }

  test("holds a car parked on any brake, with the wheels stopped and locked", () => {
    // In gear: the idle creep torque that the fix has to beat is present, as it is in the demo.
    for (const input of ["brake", "handbrake", "parkingBrake"] as const) {
      const { vehicle, ground } = parked();
      vehicle.input[input] = 1;
      run(vehicle, ground, 4);
      assert.equal(vehicle.speed, 0, input);
      for (const w of vehicle.wheels) {
        // `spin` is the odometer VehicleSystem poses the visual wheels with. Regression: a car
        // parked on the brake had all four wheels turning (4.7 rad/s in gear on the flat) for as
        // long as it was held.
        assert.equal(w.omega, 0, input);
        assert.equal(w.spin, 0, input);
      }
    }
  });

  test("parks on a 12° slope without creeping, and holds against full throttle", () => {
    const theta = (12 * Math.PI) / 180;
    const ground = slopeGround(theta, "z");
    const vehicle = new Vehicle(createVehicleConfig({ aero: null, mass: 1200, mu: 1.1 }));
    vehicle.placeOnGround(ground);
    const z0 = vehicle.position.z;
    const y0 = vehicle.position.y;
    vehicle.input.parkingBrake = 1;
    run(vehicle, ground, 5);
    assert.equal(vehicle.speed, 0);
    assert.equal(vehicle.position.z, z0);
    assert.equal(vehicle.position.y, y0);
    for (const w of vehicle.wheels) assert.equal(w.spin, 0);

    // Latching the parking brake is a state, not a rolling resistance: the drive cannot creep out.
    vehicle.input.throttle = 1;
    run(vehicle, ground, 4);
    assert.equal(vehicle.speed, 0);
    assert.equal(vehicle.position.z, z0);
    assert.ok(vehicle.rpm <= vehicle.config.engine.idleRpm + 1);
  });

  test("brakes a parking brake at every wheel, where the handbrake covers only the rears", () => {
    function omegas(input: "handbrake" | "parkingBrake"): number[] {
      const { vehicle, ground } = parked();
      vehicle.config.transmission.gear = 0;
      vehicle.setVelocity(0, 0, 12);
      vehicle.input[input] = 1;
      run(vehicle, ground, 0.25);
      return vehicle.wheels.map((w) => w.omega);
    }
    // Handbrake: rears (index 2, 3) lock, the undriven fronts keep rolling.
    const handbrake = omegas("handbrake");
    assert.equal(handbrake[2], 0);
    assert.equal(handbrake[3], 0);
    assert.ok(Math.abs(handbrake[0]!) > 1);
    assert.ok(Math.abs(handbrake[1]!) > 1);
    // Parking brake: all four.
    for (const omega of omegas("parkingBrake")) assert.equal(omega, 0);
  });

  test("stops from speed and leaves the wheels stopped, not spinning backwards", () => {
    const { vehicle, ground } = parked({ mass: 1400, mu: 1.05 });
    vehicle.setVelocity(0, 0, 20);
    vehicle.input.brake = 0.6;
    run(vehicle, ground, 5);
    assert.equal(vehicle.speed, 0);
    const atStop = vehicle.wheels.map((w) => w.spin);
    run(vehicle, ground, 2);
    for (let i = 0; i < vehicle.wheels.length; i++) {
      // Regression: a braked wheel used to be spun backwards by demand the tire cannot transmit —
      // huge |κ|, nearly no force, and a car creeping at ~0.4 m/s with the brake fully on.
      assert.equal(vehicle.wheels[i]!.omega, 0);
      assert.equal(vehicle.wheels[i]!.spin, atStop[i]);
    }
  });

  test("banks no fall speed while parked: releasing a long hold neither slams nor launches", () => {
    // Regression: a park latched only the horizontal velocity while gravity kept integrating into
    // velocity.y (~9.8 m/s banked per held second), so releasing the brake slammed the chassis
    // into the ground and the suspension fired it back up. The Mars showcase sits parked from
    // scene load until the first throttle input, which made every demo open with a jump.
    for (const input of ["brake", "handbrake", "parkingBrake"] as const) {
      const { vehicle, ground } = parked();
      vehicle.input[input] = 1;
      run(vehicle, ground, 10);
      assert.equal(vehicle.velocity.y, 0, input);
      const y0 = vehicle.position.y;
      vehicle.input[input] = 0;
      let minY = Infinity;
      let maxY = -Infinity;
      for (let i = 0; i < 120; i++) {
        vehicle.step(1 / 60, ground);
        minY = Math.min(minY, vehicle.position.y);
        maxY = Math.max(maxY, vehicle.position.y);
      }
      assert.ok(y0 - minY < 0.05, input);
      assert.ok(maxY - y0 < 0.05, input);
      assert.equal(vehicle.speed, 0, input);
    }
  });

  test("releases a slope park into a gentle roll, not a banked-velocity slam", () => {
    const theta = (12 * Math.PI) / 180;
    const ground = slopeGround(theta, "z");
    const vehicle = new Vehicle(createVehicleConfig({ aero: null, mass: 1200, mu: 1.1 }));
    vehicle.placeOnGround(ground);
    vehicle.input.brake = 1;
    run(vehicle, ground, 6);
    assert.equal(vehicle.velocity.y, 0);
    vehicle.input.brake = 0;
    // The car rolls downhill from rest; its clearance above the surface it rolls on must stay in
    // the suspension's working band the whole way down — never buried, never airborne.
    const sample = { height: 0, nx: 0, ny: 1, nz: 0 };
    for (let i = 0; i < 120; i++) {
      vehicle.step(1 / 60, ground);
      ground.sample(vehicle.position.x, vehicle.position.z, sample);
      const clearance = vehicle.position.y - sample.height;
      assert.ok(clearance > 0.2);
      assert.ok(clearance < 1.0);
    }
    assert.ok(vehicle.speed > 0.1);
  });

  test("gives the drive back when the brake is released", () => {
    // A brake held for a long time must not poison the drivetrain for the drive that follows: the
    // browser gate presses W with the parking brake latched, holds it, then releases and expects the
    // car to move. Free wheels and free revs are not enough — the car has to leave.
    for (const input of ["brake", "handbrake", "parkingBrake"] as const) {
      const { vehicle, ground } = parked();
      vehicle.input[input] = 1;
      vehicle.input.throttle = 1;
      run(vehicle, ground, 8);
      assert.equal(vehicle.speed, 0, input);
      const z0 = vehicle.position.z;
      vehicle.input[input] = 0;
      run(vehicle, ground, 4);
      assert.ok(vehicle.speed > 1, input);
      assert.ok(vehicle.position.z - z0 > 1, input);
    }
  });

  test("stops an airborne wheel instead of winding it backwards", () => {
    const { vehicle, ground } = parked({ absEnabled: false });
    vehicle.setVelocity(0, 0, 15); // spins the wheels up to the rolling speed
    vehicle.position.y += 60; // airborne for the whole test
    vehicle.velocity.set(0, 0, 0);
    vehicle.input.brake = 1;
    run(vehicle, ground, 1);
    for (const w of vehicle.wheels) {
      assert.equal(w.omega, 0);
      assert.ok(w.spin >= 0);
    }
  });

  test("decelerates an unpowered coasting vehicle under rolling resistance", () => {
    const { vehicle, ground } = parked({ rollingResistance: 0.05, aero: null });
    vehicle.setVelocity(0, 0, 5);
    vehicle.input.throttle = 0;
    vehicle.input.brake = 0;
    run(vehicle, ground, 2);
    // Speed should have decreased due to rolling resistance
    assert.ok(vehicle.speed < 4.5);
    assert.ok(vehicle.speed > 0);
  });

  test("firm braking stops the vehicle promptly without endless sliding", () => {
    const { vehicle, ground } = parked({ rollingResistance: 0.05, maxBrakeTorque: 5000, absEnabled: false });
    vehicle.setVelocity(0, 0, 5);
    vehicle.input.throttle = 0;
    vehicle.input.brake = 1;
    run(vehicle, ground, 1.2);
    assert.ok(vehicle.speed < 0.05);
  });
});

group("vehicles — area damage", () => {
  test("splits body damage across the zones an impact direction implies", () => {
    const zones = createVehicleDamageZones();
    applyBodyDamage(zones, 1, 0, 0.4); // dead-on nose hit
    assertCloseTo(zones.front, 0.4, 8);
    assert.equal(zones.rear + zones.left + zones.right, 0);
    const corner = createVehicleDamageZones();
    applyBodyDamage(corner, 1, 1, 0.4); // front-right corner hit splits evenly
    assertCloseTo(corner.front, 0.2, 8);
    assertCloseTo(corner.right, 0.2, 8);
    const tail = createVehicleDamageZones();
    applyBodyDamage(tail, -0.5, -1, 0.6); // rear-left, mostly side
    assertCloseTo(tail.rear, 0.2, 8);
    assertCloseTo(tail.left, 0.4, 8);
    // Crush clamps at fully crushed, and zero impacts change nothing.
    applyBodyDamage(tail, -1, 0, 5);
    assert.equal(tail.rear, 1);
    applyBodyDamage(tail, 0, 0, 0.5);
    assert.equal(tail.front, 0);
  });

  test("sinks crushed panels inward with a falloff from the zone edge", () => {
    const out = { x: 0, y: 0, z: 0 };
    const zones = createVehicleDamageZones();
    zones.front = 1;
    computeBodyCrushOffset(0, 1.6, zones, out); // nose tip, fully inside the front zone
    assertCloseTo(out.z, -0.3, 8);
    assertCloseTo(out.x, 0, 8);
    assertCloseTo(out.y, -0.1, 8);
    computeBodyCrushOffset(0, 0.8, zones, out); // halfway in takes half the inset
    assertCloseTo(out.z, -0.15, 8);
    computeBodyCrushOffset(0, 0, zones, out); // the deck centre never moves
    assertCloseTo(out.x, 0, 8);
    assertCloseTo(out.y, 0, 8);
    assertCloseTo(out.z, 0, 8);
    const side = createVehicleDamageZones();
    side.left = 0.5;
    computeBodyCrushOffset(-1.4, 0, side, out); // left rocker panel folds inward (+x)
    assertCloseTo(out.x, 0.15, 8);
    assertCloseTo(out.y, -0.05, 8);
  });

  test("clamps wheel damage at the detach threshold", () => {
    const wheels = [0, 0, 0, 0];
    applyWheelDamage(wheels, 1, 0.4);
    applyWheelDamage(wheels, 1, 0.8);
    assert.equal(wheels[1], 1);
    assert.equal(wheels[0], 0);
    assert.equal(WHEEL_DETACH_DAMAGE, 1);
    // Out-of-range indices are ignored rather than growing the array.
    applyWheelDamage(wheels, 9, 1);
    assert.deepEqual(wheels, [0, 1, 0, 0]);
  });

  test("a disabled wheel reports no contact or load, takes no torque, and the car drives on", () => {
    const vehicle = new Vehicle(createVehicleConfig({ aero: null, mass: 1000 }));
    const ground = flatGround(0);
    vehicle.placeOnGround(ground);
    const w = vehicle.wheels[0]!;
    w.disabled = true;
    // `driven` is deliberately left on: the engine must exclude disabled wheels from the
    // torque split even if a scene forgets to clear the flag alongside.
    vehicle.input.throttle = 1;
    vehicle.input.steer = 0.5;
    run(vehicle, ground, 2);
    assert.equal(w.inContact, false);
    assert.equal(w.normalLoad, 0);
    assert.equal(w.compression, 0);
    assert.equal(w.steerAngle, 0);
    assert.equal(w.omega, 0);
    // The three survivors still pull the car away, listing to the dead corner.
    assert.ok(vehicle.speed > 0.5);
  });

  test("VehicleSystem leans a bent wheel in place without moving its hub", () => {
    const poseWheel = (bend: number) => {
      const world = new EntityWorld();
      const ground = flatGround(0);
      const vehicle = new Vehicle(createVehicleConfig({ aero: null, mass: 1000 }));
      vehicle.placeOnGround(ground);
      vehicle.wheels[0]!.bend = bend;
      const entity = world.createEntity("car");
      entity.add(new Transform());
      const comp = new VehicleComponent(vehicle, ground);
      const wheelEntities = vehicle.wheels.map((_, i) => {
        const e = world.createEntity(`wheel-${i}`);
        e.add(new Transform());
        return e;
      });
      comp.wheelEntities = wheelEntities.map((e) => e.id);
      entity.add(comp);
      world.registerSystem(new VehicleSystem());
      world.runSystems(ctx(world));
      const t = wheelEntities[0]!.get(Transform)!;
      const result = {
        px: t.position.x,
        py: t.position.y,
        pz: t.position.z,
        qx: t.rotation.x,
        qy: t.rotation.y,
        qz: t.rotation.z,
        qw: t.rotation.w,
      };
      world.dispose();
      return result;
    };
    // Twin deterministic builds: the only difference is the bend, applied after spin.
    const straight = poseWheel(0);
    const bent = poseWheel(WHEEL_BEND_MAX);
    assertCloseTo(bent.px, straight.px, 8);
    assertCloseTo(bent.py, straight.py, 8);
    assertCloseTo(bent.pz, straight.pz, 8);
    const dot = Math.abs(
      bent.qx * straight.qx + bent.qy * straight.qy + bent.qz * straight.qz + bent.qw * straight.qw,
    );
    assert.ok(dot < 0.999);
  });
});

group("vehicles — reported rover-course regressions", () => {
  /** The rover course's shipped vehicle: 1025 kg, six wheels, 9.5 N·m / 1.5 kW through 60:1. */
  function courseRover(): Vehicle {
    const springRate = (1025 * 9.81) / (6 * 0.05);
    const vehicle = new Vehicle({
      ...createVehicleConfig({
        mass: 1025,
        gravity: 9.81,
        mu: 1.4,
        wheelRadius: 0.264,
        wheelbase: 2.26,
        track: 2.18,
        cgToFront: 1.095,
        cgHeight: 0.54,
        longitudinal: { B: 14, C: 1.65, E: 0.97 },
        lateral: { B: 12, C: 1.3, E: 0.97 },
        springRate,
        damperRate: 2 * Math.sqrt(springRate * (1025 / 6)) * 0.55,
        aero: null,
        maxBrakeTorque: 4200,
        absEnabled: false,
        rollingResistance: 0.035,
        engine: new ElectricMotor({
          peakTorque: 9.5,
          peakPower: 1500,
          ratedRpm: 1500,
          maxRpm: 5700,
          regenTorque: 4.2,
          dragTorque: 0.12,
          inertia: 0.02,
        }),
        transmission: new ReductionDrive(60),
      }),
      wheels: [
        { x: -1.091, z: 1.095, steered: true, driven: true, handbrake: false },
        { x: 1.091, z: 1.095, steered: true, driven: true, handbrake: false },
        { x: -1.213, z: -0.09, steered: false, driven: true, handbrake: false },
        { x: 1.213, z: -0.09, steered: false, driven: true, handbrake: false },
        { x: -1.091, z: -1.165, steered: true, driven: true, handbrake: true },
        { x: 1.091, z: -1.165, steered: true, driven: true, handbrake: true },
      ],
    });
    vehicle.config.suspensionRest = 0.32;
    vehicle.config.suspensionTravel = 0.16;
    vehicle.config.maxSteerAngle = 0.62;
    return vehicle;
  }

  test("brakes a downhill rover to a hold instead of driving it faster", () => {
    const ground = slopeGround((25 * Math.PI) / 180, "z");
    const vehicle = courseRover();
    vehicle.position.set(0, 0, 0);
    vehicle.placeOnGround(ground);
    vehicle.yaw = Math.PI; // faces -Z, downhill on slopeGround
    vehicle.placeOnGround(ground);
    vehicle.input.throttle = 0;
    vehicle.input.brake = 0;
    run(vehicle, ground, 2); // coast up to speed
    const entry = vehicle.speed;
    assert.ok(entry > 3);

    vehicle.input.brake = 1;
    let maxAfter = 0;
    for (let i = 0; i < 60 * 3; i++) {
      vehicle.step(1 / 60, ground);
      maxAfter = Math.max(maxAfter, vehicle.speed);
    }
    // Regression: a brake demand past the tire's grip used to solve to the mirrored slip clamp,
    // so the pinned brake delivered peak *forward* force and the rover ran away downhill
    // (~49 m/s in three seconds on 12°). A held brake must stop it, and never speed it up.
    assert.ok(maxAfter < entry + 0.01);
    assert.ok(vehicle.speed < 0.05);
  });

  test("keeps accelerating with the throttle pinned and the steering at full lock", () => {
    const ground = flatGround(0);
    const vehicle = courseRover();
    vehicle.placeOnGround(ground);
    vehicle.input.throttle = 1;
    vehicle.input.steer = -1; // full left lock
    run(vehicle, ground, 3);
    // Regression: steering every wheel in parallel put them at their own slip angles, and the
    // lateral answer ate the rover's whole traction budget — throttle + steer crawled at
    // ≈0.13 m/s. Ackermann keeps the tires rolling while the rover turns and accelerates.
    assert.ok(vehicle.speed > 1);
    assert.ok(Math.abs(vehicle.yaw) > 0.5);
    // …and the wheels are still aimed at their own turn centre, not all at the same angle.
    const steerAngles = vehicle.wheels.filter((w) => w.steered).map((w) => w.steerAngle);
    assert.ok(new Set(steerAngles.map((a) => a.toFixed(4))).size > 1);
  });
});

await finish();
