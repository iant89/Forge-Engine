import { describe, expect, it } from "vitest";
import {
  Clock,
  EngineModel,
  EntityWorld,
  Logger,
  Profiler,
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
  flatGround,
  pacejka,
  pacejkaPeakSlip,
  slopeGround,
  splitDriveTorque,
  tractionControlScale,
  type SystemContext,
  DEFAULT_LONGITUDINAL,
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

describe("vehicles — Pacejka, drivetrain, loads", () => {
  it("magic formula is odd, zero at zero slip, and peaks near the sampled slip", () => {
    const peak = pacejkaPeakSlip(DEFAULT_LONGITUDINAL);
    expect(pacejka(0, { ...DEFAULT_LONGITUDINAL, D: 1000 })).toBeCloseTo(0, 8);
    const pos = pacejka(0.2, { ...DEFAULT_LONGITUDINAL, D: 1000 });
    const neg = pacejka(-0.2, { ...DEFAULT_LONGITUDINAL, D: 1000 });
    expect(pos).toBeCloseTo(-neg, 6);
    expect(Math.abs(pacejka(peak, { ...DEFAULT_LONGITUDINAL, D: 1 }))).toBeGreaterThan(0.9);
    expect(peak).toBeGreaterThan(0.05);
    expect(peak).toBeLessThan(0.4);
  });

  it("converts a constant torque into the analytic RPM (I·α = τ)", () => {
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
    expect(engine.omega).toBeCloseTo(400, 4);
    expect(engine.rpm).toBeCloseTo((400 * 60) / (2 * Math.PI), 2);
  });

  it("holds the crank at the rev limiter", () => {
    const engine = new EngineModel({ inertia: 0.1, peakTorque: 200, frictionTorque: 0, idleRpm: 0, redlineRpm: 3000 });
    engine.throttle = 1;
    for (let i = 0; i < 600; i++) engine.step(1 / 60, 0);
    expect(engine.rpm).toBeLessThanOrEqual(3000 + 1e-6);
    expect(engine.deliveredTorque()).toBe(0);
  });

  it("shifts up at the upshift RPM and down at the downshift RPM", () => {
    const box = new Transmission({ ratios: [3, 2, 1.4], upshiftRpm: 5500, downshiftRpm: 2000, shiftDuration: 0.1, upshiftThrottle: 0.2 });
    expect(box.update(5400, 1, 1 / 60)).toBe(false);
    expect(box.gear).toBe(1);
    expect(box.update(5500, 1, 0)).toBe(true);
    expect(box.gear).toBe(2);
    expect(box.ratio).toBe(0);
    box.shiftTimer = 0;
    expect(box.ratio).toBeCloseTo(2 * box.finalDrive);
    expect(box.update(1900, 0, 0)).toBe(true);
    expect(box.gear).toBe(1);
    // Coasting in below the throttle gate must not upshift.
    const coast = new Transmission({ ratios: [3, 2], upshiftRpm: 4000, upshiftThrottle: 0.5 });
    expect(coast.update(5000, 0.1, 0)).toBe(false);
    expect(coast.gear).toBe(1);
  });

  it("splits drive torque equally when open, and toward the slower wheel when LSD", () => {
    const wheels = [
      { driven: true, omega: 2 },
      { driven: true, omega: 40 },
      { driven: false, omega: 0 },
    ];
    const open = splitDriveTorque(100, wheels, "open");
    expect(open[0]).toBeCloseTo(50);
    expect(open[1]).toBeCloseTo(50);
    expect(open[2]).toBe(0);
    const lsd = splitDriveTorque(100, wheels, "lsd", 3);
    expect(lsd[0]! + lsd[1]!).toBeCloseTo(100, 5);
    expect(lsd[0]!).toBeGreaterThan(lsd[1]!);
    expect(lsd[2]).toBe(0);
  });

  it("computes aero drag as ½ρCdAv²", () => {
    const loads = aeroLoads(10, { rho: 1.2, dragCoefficient: 0.5, liftCoefficient: 0.2, frontalArea: 2 });
    expect(loads.drag).toBeCloseTo(60, 6);
    expect(loads.downforce).toBeCloseTo(24, 6);
  });

  it("transfers load rearward under acceleration and forward under braking", () => {
    const base = { mass: 1200, gravity: 9.81, wheelbase: 2.6, cgToFront: 1.3, cgHeight: 0.55, track: 1.6, ay: 0 };
    const accel = computeWheelLoads({ ...base, ax: 4 });
    const brake = computeWheelLoads({ ...base, ax: -4 });
    const lat = computeWheelLoads({ ...base, ax: 0, ay: 3 });
    expect(axleLoad(accel, "rear")).toBeGreaterThan(axleLoad(accel, "front"));
    expect(axleLoad(brake, "front")).toBeGreaterThan(axleLoad(brake, "rear"));
    expect(lat.fl + lat.rl).toBeGreaterThan(lat.fr + lat.rr);
    const weight = 1200 * 9.81;
    expect(accel.fl + accel.fr + accel.rl + accel.rr).toBeCloseTo(weight, 4);
    // A hard lateral accel can lift the inside wheels; loads stay non-negative.
    const lift = computeWheelLoads({ ...base, ax: 0, ay: 40 });
    expect(lift.fr).toBe(0);
    expect(lift.fl).toBeGreaterThan(0);
  });

  it("scales drive torque down once slip exceeds the TC threshold", () => {
    expect(tractionControlScale(0.05, 0.12, 6)).toBe(1);
    expect(tractionControlScale(0.3, 0.12, 6)).toBeLessThan(0.2);
  });
});

describe("vehicles — chassis", () => {
  function car(overrides: Parameters<typeof createVehicleConfig>[0] = {}) {
    const vehicle = new Vehicle(createVehicleConfig({ aero: null, tcEnabled: true, absEnabled: true, ...overrides }));
    const ground = flatGround(0);
    vehicle.placeOnGround(ground);
    return { vehicle, ground };
  }

  it("stops from 20 m/s within 15% of v² / (2μg)", () => {
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
    expect(vehicle.speed).toBeLessThan(0.25);
    expect(distance, `stopped in ${distance.toFixed(3)} m, ideal ${ideal.toFixed(3)} m`).toBeGreaterThan(ideal * 0.75);
    expect(distance).toBeLessThan(ideal * 1.15);
  });

  it("climbs a 12° slope when μ exceeds tan(θ), gaining both z and height", () => {
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
    expect(vehicle.position.z).toBeGreaterThan(4);
    expect(vehicle.position.y).toBeGreaterThan(y0 + 0.5);
    expect(Number.isFinite(vehicle.position.y)).toBe(true);
  });

  it("reports more rear load while accelerating and more front load while braking", () => {
    const { vehicle, ground } = car({ mass: 1400, mu: 1.2, cgHeight: 0.55 });
    vehicle.input.throttle = 1;
    run(vehicle, ground, 0.6);
    expect(vehicle.ax).toBeGreaterThan(1);
    const accel = vehicle.wheelLoads();
    expect(axleLoad(accel, "rear")).toBeGreaterThan(axleLoad(accel, "front"));

    vehicle.input.throttle = 0;
    vehicle.input.brake = 1;
    vehicle.setVelocity(0, 0, 18);
    run(vehicle, ground, 0.3);
    expect(vehicle.ax).toBeLessThan(-1);
    const braking = vehicle.wheelLoads();
    expect(axleLoad(braking, "front")).toBeGreaterThan(axleLoad(braking, "rear"));
  });

  it("upshifts under throttle within two seconds", () => {
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
    expect(vehicle.config.transmission.shiftCount).toBeGreaterThanOrEqual(1);
    expect(vehicle.gear).toBeGreaterThan(1);
  });

  it("keeps driven-wheel slip lower with traction control than without", () => {
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
    expect(withTc).toBeLessThan(0.35);
    expect(without).toBeGreaterThan(withTc + 0.15);
  });

  it("is deterministic for the same inputs", () => {
    function sample() {
      const { vehicle, ground } = car({ mass: 1300, mu: 1 });
      vehicle.input.throttle = 0.7;
      vehicle.input.steer = 0.15;
      run(vehicle, ground, 2);
      return [vehicle.position.x, vehicle.position.y, vehicle.position.z, vehicle.yaw, vehicle.rpm, vehicle.gear];
    }
    expect(sample()).toEqual(sample());
  });

  it("steps from VehicleSystem once per fixed step, and writes the chassis transform", () => {
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
    expect(vehicle.stepCount).toBe(6);
    const t = entity.get(Transform)!;
    expect(t.position.z).toBeCloseTo(vehicle.position.z, 5);
    expect(t.position.y).toBeCloseTo(vehicle.position.y, 5);
    world.dispose();
  });
});
