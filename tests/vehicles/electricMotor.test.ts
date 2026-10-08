/**
 * @suite vehicles:electricMotor
 * @group unit
 * @covers engine/src/core/log.ts
 * @covers engine/src/core/time.ts
 * @covers engine/src/debug/profiler.ts
 * @covers engine/src/index.ts
 * @covers engine/src/math/mat.ts
 * @covers engine/src/math/vec.ts
 * @covers engine/src/scene/components/index.ts
 * @covers engine/src/scene/systems.ts
 * @covers engine/src/scene/world.ts
 * @covers engine/src/vehicles/components.ts
 * @covers engine/src/vehicles/electric.ts
 * @covers engine/src/vehicles/ground.ts
 * @covers engine/src/vehicles/system.ts
 * @covers engine/src/vehicles/vehicle.ts
 * @desc Electric drivetrain (ElectricMotor, ReductionDrive) plus the rover fixes it carries: the
 */

export const suite = {
  name: "vehicles:electricMotor",
  group: "unit",
  covers:   [
    "engine/src/core/log.ts",
    "engine/src/core/time.ts",
    "engine/src/debug/profiler.ts",
    "engine/src/index.ts",
    "engine/src/math/mat.ts",
    "engine/src/math/vec.ts",
    "engine/src/scene/components/index.ts",
    "engine/src/scene/systems.ts",
    "engine/src/scene/world.ts",
    "engine/src/vehicles/components.ts",
    "engine/src/vehicles/electric.ts",
    "engine/src/vehicles/ground.ts",
    "engine/src/vehicles/system.ts",
    "engine/src/vehicles/vehicle.ts"
  ],
  desc: "Electric drivetrain (ElectricMotor, ReductionDrive) plus the rover fixes it carries: the",
};
/**
 * Electric drivetrain (`ElectricMotor`, `ReductionDrive`) plus the rover fixes it carries: the
 * top-speed cap, suspension-anchored wheel travel, and terrain-aligned wheel orientation.
 */
import assert from "node:assert/strict";
import { assertCloseTo, finish, group, test } from "selrun";
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
  slopeGround,
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

group("ElectricMotor — the traction envelope", () => {
  // peakPower is chosen continuous with the base speed: 10 N·m × (1000 rpm in rad/s).
  const motor = () =>
    new ElectricMotor({ peakTorque: 10, peakPower: 10 * 1000 * RPM_TO_RAD_S, ratedRpm: 1000, maxRpm: 4000, dragTorque: 0, inertia: 0.02 });

  test("holds constant torque from stall to the base speed", () => {
    const m = motor();
    assertCloseTo(m.envelopeTorque(0), 10, 9);
    assertCloseTo(m.envelopeTorque(500), 10, 9);
    assertCloseTo(m.envelopeTorque(999), 10, 9);
  });

  test("caps torque at constant power above the base speed", () => {
    const m = motor();
    const at2000 = m.envelopeTorque(2000);
    assertCloseTo(at2000, (10 * 1000) / 2000, 6); // peakPower / ω = τ₀ · rated / rpm
    const at3000 = m.envelopeTorque(3000);
    assertCloseTo(at3000, (10 * 1000) / 3000, 6);
    // Continuous through the base speed: no step between the two regions.
    assertCloseTo(m.envelopeTorque(1000), 10, 6);
  });

  test("tapers to zero at the no-load speed", () => {
    const m = motor();
    assert.equal(m.envelopeTorque(4000), 0);
    assert.equal(m.envelopeTorque(5000), 0);
    const at3900 = m.envelopeTorque(3900);
    const powerTorque = 1000 / (3900 * RPM_TO_RAD_S);
    assert.ok(at3900 < powerTorque); // inside the final-15% taper
    assert.ok(at3900 > 0);
  });

  test("scales with throttle and floors at zero (no backwards drive; regen rides elsewhere)", () => {
    const m = motor();
    m.throttle = 0.5;
    m.rpm = 500;
    assertCloseTo(m.deliveredTorque(), 5, 9);
    m.throttle = 0;
    assert.equal(m.deliveredTorque(), 0);
    m.throttle = 1;
    m.rpm = 4500; // past the envelope — the limiter, not a negative torque
    assert.equal(m.deliveredTorque(), 0);
  });

  test("subtracts coulomb drag only while the shaft is actually turning", () => {
    const m = new ElectricMotor({ peakTorque: 10, dragTorque: 0.2, peakPower: 10 * 1000 * RPM_TO_RAD_S });
    m.throttle = 1;
    m.omega = 0; // at rest: no drag term, full stall torque
    assertCloseTo(m.deliveredTorque(), 10, 9);
    m.omega = 50;
    assertCloseTo(m.deliveredTorque(), 10 - 0.2, 9);
    // Backwards-rotating shaft: friction still opposes *rotation*, so it adds to the
    // forward-driving torque — it is trying to stop the backwards spin.
    m.omega = -30;
    assertCloseTo(m.deliveredTorque(), 10 + 0.2, 9);
  });

  test("integrates I·α in step() and limits at maxRpm", () => {
    const m = motor();
    m.throttle = 1;
    m.step(0.1, 0); // α = 10 / 0.02 = 500 rad/s² → 50 rad/s
    assertCloseTo(m.omega, 50, 6);
    for (let i = 0; i < 2000; i++) m.step(1 / 60, 0);
    assertCloseTo(m.rpm, 4000, 6); // the taper asymptotes to the no-load speed
    assert.ok(m.deliveredTorque() < 1e-9);
  });

  test("does not idle: rpm reads the shaft, which rests at zero", () => {
    const m = motor();
    assert.equal(m.idleRpm, 0);
    assert.equal(m.rpm, 0);
  });

  test("reports shaft power, negative while regenerating", () => {
    const m = motor();
    m.throttle = 1;
    m.omega = 100;
    m.deliveredTorque();
    assertCloseTo(m.powerKW, 1, 6); // 10 N·m × 100 rad/s
    // Regen is a chassis-side subtraction; mirror it to check the readout goes negative.
    (m as unknown as { lastTorque: number }).lastTorque = -5;
    assertCloseTo(m.powerKW, -0.5, 6);
  });
});

group("ReductionDrive — fixed ratio, no shifts", () => {
  test("engages one ratio forever and never shifts", () => {
    const drive = new ReductionDrive(60);
    assert.equal(drive.ratio, 60);
    assert.equal(drive.gear, 1);
    for (const rpm of [0, 900, 50000]) assert.equal(drive.update(rpm, 1, 1 / 60), false);
    assert.equal(drive.shiftCount, 0);
    assert.equal(drive.shifting, false);
    assert.equal(drive.ratio, 60); // clutch never opens
  });

  test("reverses by flipping the ratio's sign, like Transmission", () => {
    const drive = new ReductionDrive(60);
    drive.gear = -1;
    assert.equal(drive.ratio, -60);
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
        peakPower: 1500,
        ratedRpm: 1500,
        maxRpm: 5700,
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

group("electric rover — the 'way too fast' regression", () => {
  test("caps a pinned-throttle rover at a fast walk, not 200 km/h", () => {
    const vehicle = roverVehicle(4.2);
    vehicle.input.throttle = 1;
    for (let i = 0; i < 60 * 40; i++) vehicle.step(1 / 60, flatGround(0));
    // No-load motor speed (5700 rpm ÷ 60:1 × 0.264 m) is ≈2.63 m/s; never anywhere near the old
    // combustion top gear, whose equivalent exceeded 200 km/h (55+ m/s).
    assert.ok(vehicle.speed < 2.65);
    assert.ok(vehicle.speed > 1.2);
  });

  test("stops the motor with the wheels: no idle hold while parked in gear", () => {
    const vehicle = roverVehicle(4.2);
    vehicle.input.throttle = 1;
    for (let i = 0; i < 60 * 5; i++) vehicle.step(1 / 60, flatGround(0));
    vehicle.input.throttle = 0;
    vehicle.input.brake = 1;
    for (let i = 0; i < 60 * 3; i++) vehicle.step(1 / 60, flatGround(0));
    assert.ok(vehicle.speed < 0.01);
    assertCloseTo(vehicle.rpm, 0, 1); // an EV winds down to 0 rpm; no idle
  });
});

group("regenerative braking", () => {
  test("shortens braking well before the friction pads do", () => {
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
    assert.ok(without > 0.05); // it was moving and stopped
    // ≈955 N of regen on top of ≈227 N/wheel of pads: decisively shorter, not a rounding error.
    assert.ok(withRegen < without * 0.75);
  });

  test("never pushes a stopped rover backwards", () => {
    const vehicle = roverVehicle(8);
    vehicle.setVelocity(0, 0, 1.5);
    vehicle.input.brake = 1;
    for (let i = 0; i < 60 * 2; i++) vehicle.step(1 / 60, flatGround(0));
    assert.ok(vehicle.speed < 0.35); // inside the park band
    const zAtRest = vehicle.position.z;
    for (let i = 0; i < 60 * 5; i++) vehicle.step(1 / 60, flatGround(0));
    assert.ok(vehicle.position.z >= zAtRest - 1e-6);
    assert.ok(vehicle.speed < 1e-6);
  });
});

group("wheel visuals — suspension travel and terrain-aligned orientation", () => {
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

  test("hangs the wheel centre (rest − compression) below its hardpoint", () => {
    const vehicle = roverVehicle(0);
    const w = vehicle.wheels[0]!;
    w.compression = 0.1;
    const pos = vehicle.wheelCenterPosition(w, new Vec3());
    // Level chassis: hardpoint is straight above, up is +Y.
    assertCloseTo(pos.x, vehicle.position.x + w.x, 6);
    assertCloseTo(pos.z, vehicle.position.z + w.z, 6);
    assertCloseTo(pos.y, vehicle.position.y - (vehicle.config.suspensionRest - 0.1), 6);
  });

  test("clamps to full droop when unloaded and to the bump stop when overloaded", () => {
    const vehicle = roverVehicle(0);
    const c = vehicle.config;
    const w = vehicle.wheels[0]!;
    w.compression = 0;
    let pos = vehicle.wheelCenterPosition(w, new Vec3());
    assertCloseTo(pos.y, vehicle.position.y - c.suspensionRest, 6);
    w.compression = 0.5; // beyond travel: the bump stop clamps, the chassis lift handles the rest
    pos = vehicle.wheelCenterPosition(w, new Vec3());
    assertCloseTo(pos.y, vehicle.position.y - (c.suspensionRest - c.suspensionTravel), 6);
  });

  test("keeps airborne wheels with the chassis over a cliff, not dropped to the terrain", () => {
    const vehicle = roverVehicle(0);
    vehicle.position.y = 3; // cruising off a ledge: every ray now misses by metres
    for (const w of vehicle.wheels) {
      w.inContact = false;
      w.compression = 0; // what sampleWheels writes the moment the ray releases
    }
    const pos = vehicle.wheelCenterPosition(vehicle.wheels[2]!, new Vec3());
    assertCloseTo(pos.y, vehicle.position.y - vehicle.config.suspensionRest, 6);
    assert.ok(pos.y > -1); // metres above the (−10 m) ground the old code chased
  });

  test("VehicleSystem writes wheel entities from the suspension pose, contact or not", () => {
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
    assertCloseTo(front.position.x, expected.x, 5);
    assertCloseTo(front.position.y, expected.y, 5);
    assertCloseTo(front.position.z, expected.z, 5);
    // The anchoring contract, spelled out: the written wheel hangs (rest − compression) below
    // its hardpoint along the body up-axis — never perched at contactY + radius.
    const w = vehicle.wheels[0]!;
    // The anchoring contract, spelled out: the written wheel hangs (rest − compression) below its
    // hardpoint along the body up-axis — never perched at contactY + radius. The ridge launches
    // the chassis into a tilt, so the hardpoint and up come from the full body rotation.
    const q = vehicle.writeRotation(new Quat());
    const hardpoint = q.rotateVector({ x: w.x, y: 0, z: w.z }, new Vec3());
    const up = q.rotateVector({ x: 0, y: 1, z: 0 }, new Vec3());
    assertCloseTo(front.position.y, vehicle.position.y + hardpoint.y - up.y * (vehicle.config.suspensionRest - w.compression), 4);
    world.dispose();
  });

  test("aligns each wheel to its terrain normal while retaining chassis heading, steering, and spin", () => {
    const ground = slopeGround((12 * Math.PI) / 180, "z");
    const vehicle = roverVehicle(0);
    vehicle.yaw = 0.35;
    vehicle.placeOnGround(ground);
    assert.ok(Math.hypot(vehicle.pitch, vehicle.roll) > 0.15);
    vehicle.input.parkingBrake = 1;
    vehicle.input.steer = 0.3;
    vehicle.wheels[0]!.spin = 1.1;

    const world = new EntityWorld();
    const entity = world.createEntity("rover");
    entity.add(new Transform());
    const component = new VehicleComponent(vehicle, ground);
    const wheelIds: number[] = [];
    for (let i = 0; i < vehicle.wheels.length; i++) {
      const wheelEntity = world.createEntity(`wheel-${i}`);
      wheelEntity.add(new Transform());
      component.wheelEntities.push(wheelEntity.id);
      wheelIds.push(wheelEntity.id);
    }
    entity.add(component);
    world.registerSystem(new VehicleSystem());
    world.runSystems(ctx(world, 1 / 60, 1));

    const wheel = vehicle.wheels[0]!;
    const transform = world.getComponent(wheelIds[0]!, Transform)!;
    assert.equal(wheel.inContact, true);
    assert.ok(wheel.steerAngle > 0);
    assertCloseTo(wheel.spin, 1.1, 6); // parking brake keeps the spin pose stable

    const normal = new Vec3(wheel.nx, wheel.ny, wheel.nz).normalize();
    const visualSpin = wheel.x < 0 ? -wheel.spin : wheel.spin;
    const withoutSpin = transform.rotation.clone().multiply(new Quat().setEulerComponents(-visualSpin, 0, 0));
    const actualUp = withoutSpin.rotateVector(Vec3.unitY, new Vec3());
    assertCloseTo(actualUp.x, normal.x, 5);
    assertCloseTo(actualUp.y, normal.y, 5);
    assertCloseTo(actualUp.z, normal.z, 5);

    // Remove the local-X spin to inspect the steered ground-plane heading independently.
    const actualForward = withoutSpin.rotateVector(Vec3.unitZ, new Vec3());
    const chassisForward = vehicle.writeRotation(new Quat()).rotateVector(Vec3.unitZ, new Vec3());
    const expectedForward = chassisForward.sub(normal.clone().scale(chassisForward.dot(normal))).normalize();
    const expectedRight = normal.clone().cross(expectedForward).normalize();
    expectedForward
      .scale(Math.cos(wheel.steerAngle))
      .add(expectedRight.scale(Math.sin(wheel.steerAngle)))
      .normalize();
    assertCloseTo(actualForward.x, expectedForward.x, 5);
    assertCloseTo(actualForward.y, expectedForward.y, 5);
    assertCloseTo(actualForward.z, expectedForward.z, 5);
    const actualAxle = withoutSpin.rotateVector(Vec3.unitX, new Vec3());
    const expectedAxle = normal.clone().cross(expectedForward).normalize();
    assertCloseTo(actualAxle.x, expectedAxle.x, 5);
    assertCloseTo(actualAxle.y, expectedAxle.y, 5);
    assertCloseTo(actualAxle.z, expectedAxle.z, 5);

    // Spin is still applied about the axle after the contact-aligned basis is built.
    const actualRadial = transform.rotation.rotateVector(Vec3.unitY, new Vec3());
    const expectedRadial = normal.clone().scale(Math.cos(visualSpin)).add(expectedForward.clone().scale(Math.sin(visualSpin)));
    assertCloseTo(actualRadial.x, expectedRadial.x, 5);
    assertCloseTo(actualRadial.y, expectedRadial.y, 5);
    assertCloseTo(actualRadial.z, expectedRadial.z, 5);
    world.dispose();
  });
});

await finish();
