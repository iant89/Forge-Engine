/**
 * Electric drivetrain (`ElectricMotor`, `ReductionDrive`) plus the two rover fixes it carries:
 * the top-speed cap (the combustion defaults geared a 1-tonne rover past 200 km/h) and the
 * suspension-anchored wheel visuals (`Vehicle.wheelCenterPosition` via `VehicleSystem` — wheels
 * that ride the suspension instead of sticking to the terrain contact).
 */
import { describe, expect, it } from "vitest";
import {
  Clock,
  ElectricMotor,
  Quat,
  EntityWorld,
  Logger,
  Profiler,
  ReductionDrive,
  SystemScratch,
  Transform,
  Vehicle,
  VehicleComponent,
  VehicleSystem,
  createVehicleConfig,
  flatGround,
  type GroundQuery,
  type SystemContext,
  Vec3,
} from "@forge/engine";

const RPM_TO_RAD_S = Math.PI / 30;

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

describe("ElectricMotor — the traction envelope", () => {
  // peakPower is chosen continuous with the base speed: 10 N·m × (1000 rpm in rad/s).
  const motor = () =>
    new ElectricMotor({ peakTorque: 10, peakPower: 10 * 1000 * RPM_TO_RAD_S, ratedRpm: 1000, maxRpm: 4000, dragTorque: 0, inertia: 0.02 });

  it("holds constant torque from stall to the base speed", () => {
    const m = motor();
    expect(m.envelopeTorque(0)).toBeCloseTo(10, 9);
    expect(m.envelopeTorque(500)).toBeCloseTo(10, 9);
    expect(m.envelopeTorque(999)).toBeCloseTo(10, 9);
  });

  it("caps torque at constant power above the base speed", () => {
    const m = motor();
    const at2000 = m.envelopeTorque(2000);
    expect(at2000).toBeCloseTo((10 * 1000) / 2000, 6); // peakPower / ω = τ₀ · rated / rpm
    const at3000 = m.envelopeTorque(3000);
    expect(at3000).toBeCloseTo((10 * 1000) / 3000, 6);
    // Continuous through the base speed: no step between the two regions.
    expect(m.envelopeTorque(1000)).toBeCloseTo(10, 6);
  });

  it("tapers to zero at the no-load speed", () => {
    const m = motor();
    expect(m.envelopeTorque(4000)).toBe(0);
    expect(m.envelopeTorque(5000)).toBe(0);
    const at3900 = m.envelopeTorque(3900);
    const powerTorque = 1000 / (3900 * RPM_TO_RAD_S);
    expect(at3900).toBeLessThan(powerTorque); // inside the final-15% taper
    expect(at3900).toBeGreaterThan(0);
  });

  it("scales with throttle and floors at zero (no backwards drive; regen rides elsewhere)", () => {
    const m = motor();
    m.throttle = 0.5;
    m.rpm = 500;
    expect(m.deliveredTorque()).toBeCloseTo(5, 9);
    m.throttle = 0;
    expect(m.deliveredTorque()).toBe(0);
    m.throttle = 1;
    m.rpm = 4500; // past the envelope — the limiter, not a negative torque
    expect(m.deliveredTorque()).toBe(0);
  });

  it("subtracts coulomb drag only while the shaft is actually turning", () => {
    const m = new ElectricMotor({ peakTorque: 10, dragTorque: 0.2, peakPower: 10 * 1000 * RPM_TO_RAD_S });
    m.throttle = 1;
    m.omega = 0; // at rest: no drag term, full stall torque
    expect(m.deliveredTorque()).toBeCloseTo(10, 9);
    m.omega = 50;
    expect(m.deliveredTorque()).toBeCloseTo(10 - 0.2, 9);
    // Backwards-rotating shaft: friction still opposes *rotation*, so it adds to the
    // forward-driving torque — it is trying to stop the backwards spin.
    m.omega = -30;
    expect(m.deliveredTorque()).toBeCloseTo(10 + 0.2, 9);
  });

  it("integrates I·α in step() and limits at maxRpm", () => {
    const m = motor();
    m.throttle = 1;
    m.step(0.1, 0); // α = 10 / 0.02 = 500 rad/s² → 50 rad/s
    expect(m.omega).toBeCloseTo(50, 6);
    for (let i = 0; i < 2000; i++) m.step(1 / 60, 0);
    expect(m.rpm).toBeCloseTo(4000, 6); // the taper asymptotes to the no-load speed
    expect(m.deliveredTorque()).toBeLessThan(1e-9);
  });

  it("does not idle: rpm reads the shaft, which rests at zero", () => {
    const m = motor();
    expect(m.idleRpm).toBe(0);
    expect(m.rpm).toBe(0);
  });

  it("reports shaft power, negative while regenerating", () => {
    const m = motor();
    m.throttle = 1;
    m.omega = 100;
    m.deliveredTorque();
    expect(m.powerKW).toBeCloseTo(1, 6); // 10 N·m × 100 rad/s
    // Regen is a chassis-side subtraction; mirror it to check the readout goes negative.
    (m as unknown as { lastTorque: number }).lastTorque = -5;
    expect(m.powerKW).toBeCloseTo(-0.5, 6);
  });
});

describe("ReductionDrive — fixed ratio, no shifts", () => {
  it("engages one ratio forever and never shifts", () => {
    const drive = new ReductionDrive(60);
    expect(drive.ratio).toBe(60);
    expect(drive.gear).toBe(1);
    for (const rpm of [0, 900, 50000]) expect(drive.update(rpm, 1, 1 / 60)).toBe(false);
    expect(drive.shiftCount).toBe(0);
    expect(drive.shifting).toBe(false);
    expect(drive.ratio).toBe(60); // clutch never opens
  });

  it("reverses by flipping the ratio's sign, like Transmission", () => {
    const drive = new ReductionDrive(60);
    drive.gear = -1;
    expect(drive.ratio).toBe(-60);
  });
});

/** The Mars showcase rover's drivetrain, replicated so the regression pins the shipped numbers. */
function roverVehicle(regenTorque: number, maxBrakeTorque = 3600): Vehicle {
  const springRate = (1025 * 3.72) / (6 * 0.05);
  const wheels = [
    { x: -1.091, z: 1.095, steered: true, handbrake: false },
    { x: 1.091, z: 1.095, steered: true, handbrake: false },
    { x: -1.213, z: -0.09, steered: false, handbrake: false },
    { x: 1.213, z: -0.09, steered: false, handbrake: false },
    { x: -1.091, z: -1.165, steered: true, handbrake: true },
    { x: 1.091, z: -1.165, steered: true, handbrake: true },
  ];
  const config = {
    ...createVehicleConfig({
      mass: 1025,
      gravity: 3.72,
      mu: 1.1,
      wheelRadius: 0.264,
      wheelbase: 2.26,
      track: 2.18,
      cgToFront: 1.095,
      cgHeight: 0.54,
      springRate,
      damperRate: 2 * Math.sqrt(springRate * (1025 / 6)) * 0.55,
      aero: null,
      maxBrakeTorque,
      engine: new ElectricMotor({
        peakTorque: 9.5,
        peakPower: 1000,
        ratedRpm: 1000,
        maxRpm: 3800,
        regenTorque,
        dragTorque: 0.12,
        inertia: 0.02,
      }),
      transmission: new ReductionDrive(60),
    }),
    wheels: wheels.map((w) => ({ ...w, driven: true })),
  };
  config.suspensionRest = 0.32;
  config.suspensionTravel = 0.16;
  config.maxSteerAngle = 0.62;
  const vehicle = new Vehicle(config);
  vehicle.placeOnGround(flatGround(0));
  return vehicle;
}

describe("electric rover — the 'way too fast' regression", () => {
  it("caps a pinned-throttle rover near walking pace, not 200 km/h", () => {
    const vehicle = roverVehicle(4.2);
    vehicle.input.throttle = 1;
    for (let i = 0; i < 60 * 40; i++) vehicle.step(1 / 60, flatGround(0));
    // No-load motor speed (3800 rpm ÷ 60:1 × 0.264 m) is ≈1.75 m/s; never anywhere near the old
    // combustion top gear, whose equivalent exceeded 200 km/h (55+ m/s).
    expect(vehicle.speed).toBeLessThan(2.2);
    expect(vehicle.speed).toBeGreaterThan(0.6);
  });

  it("stops the motor with the wheels: no idle hold while parked in gear", () => {
    const vehicle = roverVehicle(4.2);
    vehicle.input.throttle = 1;
    for (let i = 0; i < 60 * 5; i++) vehicle.step(1 / 60, flatGround(0));
    vehicle.input.throttle = 0;
    vehicle.input.brake = 1;
    for (let i = 0; i < 60 * 3; i++) vehicle.step(1 / 60, flatGround(0));
    expect(vehicle.speed).toBeLessThan(0.01);
    expect(vehicle.rpm).toBeCloseTo(0, 1); // an EV winds down to 0 rpm; no idle
  });
});

describe("regenerative braking", () => {
  it("shortens braking well before the friction pads do", () => {
    const run = (regenTorque: number): number => {
      const vehicle = roverVehicle(regenTorque, 60); // tiny friction brakes so regen dominates
      vehicle.setVelocity(0, 0, 1.5);
      vehicle.input.brake = 1;
      let travelled = 0;
      let prevZ = vehicle.position.z;
      for (let i = 0; i < 60 * 4; i++) {
        vehicle.step(1 / 60, flatGround(0));
        travelled += vehicle.position.z - prevZ;
        prevZ = vehicle.position.z;
      }
      return travelled;
    };
    const without = run(0);
    const withRegen = run(4.2);
    expect(without).toBeGreaterThan(0.05); // it was moving and stopped
    // ≈955 N of regen on top of ≈227 N/wheel of pads: decisively shorter, not a rounding error.
    expect(withRegen).toBeLessThan(without * 0.75);
  });

  it("never pushes a stopped rover backwards", () => {
    const vehicle = roverVehicle(8);
    vehicle.setVelocity(0, 0, 1.5);
    vehicle.input.brake = 1;
    for (let i = 0; i < 60 * 2; i++) vehicle.step(1 / 60, flatGround(0));
    expect(vehicle.speed).toBeLessThan(0.35); // inside the park band
    const zAtRest = vehicle.position.z;
    for (let i = 0; i < 60 * 5; i++) vehicle.step(1 / 60, flatGround(0));
    expect(vehicle.position.z).toBeGreaterThanOrEqual(zAtRest - 1e-6);
    expect(vehicle.speed).toBeLessThan(1e-6);
  });
});

describe("wheel visuals — anchored to the suspension, not the terrain", () => {
  /** Flat at 0 with a 0.4 m ridge under the front axle (the crest-overload case). */
  function ridgeGround(): GroundQuery {
    return {
      sample(_x, z, out) {
        out.height = Math.abs(z - 6.1) < 0.3 ? 0.4 : 0;
        out.nx = 0;
        out.ny = 1;
        out.nz = 0;
      },
    };
  }

  it("hangs the wheel centre (rest − compression) below its hardpoint", () => {
    const vehicle = roverVehicle(0);
    const w = vehicle.wheels[0]!;
    w.compression = 0.1;
    const pos = vehicle.wheelCenterPosition(w, new Vec3());
    // Level chassis: hardpoint is straight above, up is +Y.
    expect(pos.x).toBeCloseTo(vehicle.position.x + w.x, 6);
    expect(pos.z).toBeCloseTo(vehicle.position.z + w.z, 6);
    expect(pos.y).toBeCloseTo(vehicle.position.y - (vehicle.config.suspensionRest - 0.1), 6);
  });

  it("clamps to full droop when unloaded and to the bump stop when overloaded", () => {
    const vehicle = roverVehicle(0);
    const c = vehicle.config;
    const w = vehicle.wheels[0]!;
    w.compression = 0;
    let pos = vehicle.wheelCenterPosition(w, new Vec3());
    expect(pos.y).toBeCloseTo(vehicle.position.y - c.suspensionRest, 6);
    w.compression = 0.5; // beyond travel: the bump stop clamps, the chassis lift handles the rest
    pos = vehicle.wheelCenterPosition(w, new Vec3());
    expect(pos.y).toBeCloseTo(vehicle.position.y - (c.suspensionRest - c.suspensionTravel), 6);
  });

  it("keeps airborne wheels with the chassis over a cliff, not dropped to the terrain", () => {
    const vehicle = roverVehicle(0);
    vehicle.position.y = 3; // cruising off a ledge: every ray now misses by metres
    for (const w of vehicle.wheels) {
      w.inContact = false;
      w.compression = 0; // what sampleWheels writes the moment the ray releases
    }
    const pos = vehicle.wheelCenterPosition(vehicle.wheels[2]!, new Vec3());
    expect(pos.y).toBeCloseTo(vehicle.position.y - vehicle.config.suspensionRest, 6);
    expect(pos.y).toBeGreaterThan(-1); // metres above the (−10 m) ground the old code chased
  });

  it("VehicleSystem writes wheel entities from the suspension pose, contact or not", () => {
    const world = new EntityWorld();
    const ground = ridgeGround();
    const vehicle = roverVehicle(0);
    vehicle.position.z = 5; // front axle hardpoints (z + 1.095) sit over the ridge at 6.1
    vehicle.placeOnGround(ground);
    const ids: number[] = [];
    const entity = world.createEntity("rover");
    entity.add(new Transform());
    const component = new VehicleComponent(vehicle, ground);
    for (let i = 0; i < vehicle.wheels.length; i++) {
      const wheel = world.createEntity(`wheel-${i}`);
      wheel.add(new Transform());
      component.wheelEntities.push(wheel.id);
      ids.push(wheel.id);
    }
    entity.add(component);
    world.registerSystem(new VehicleSystem());
    world.runSystems(ctx(world, 1 / 60, 1));
    const front = world.getComponent(ids[0]!, Transform)!;
    const expected = vehicle.wheelCenterPosition(vehicle.wheels[0]!, new Vec3());
    expect(front.position.x).toBeCloseTo(expected.x, 5);
    expect(front.position.y).toBeCloseTo(expected.y, 5);
    expect(front.position.z).toBeCloseTo(expected.z, 5);
    // The anchoring contract, spelled out: the written wheel hangs (rest − compression) below
    // its hardpoint along the body up-axis — never perched at contactY + radius.
    const w = vehicle.wheels[0]!;
    // The anchoring contract, spelled out: the written wheel hangs (rest − compression) below its
    // hardpoint along the body up-axis — never perched at contactY + radius. The ridge launches
    // the chassis into a tilt, so the hardpoint and up come from the full body rotation.
    const q = vehicle.writeRotation(new Quat());
    const hardpoint = q.rotateVector({ x: w.x, y: 0, z: w.z }, new Vec3());
    const up = q.rotateVector({ x: 0, y: 1, z: 0 }, new Vec3());
    expect(front.position.y).toBeCloseTo(
      vehicle.position.y + hardpoint.y - up.y * (vehicle.config.suspensionRest - w.compression),
      4,
    );
    world.dispose();
  });
});
