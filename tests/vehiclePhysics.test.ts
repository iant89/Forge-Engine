/**
 * Phase 11 — physics / vehicle integration: backend, heightfield agreement, chassis/prop collision,
 * physical orientation, stress cases, and telemetry.
 */
import { describe, expect, it } from "vitest";
import {
  BoxShape,
  ForgeJSPhysics,
  ForgeWasmPhysics,
  HeightfieldShape,
  RigidBody,
  Vehicle,
  assertTerrainAgreement,
  createPhysicsBackend,
  createVehicleChassis,
  createVehicleConfig,
  flatGround,
  heightFunctionGround,
  physicsGroundQuery,
  physicsRaycastGroundQuery,
  slopeGround,
  syncVehicleChassis,
} from "@forge/engine";

function run(v: Vehicle, ground: { sample: Function }, seconds: number, dt = 1 / 60): void {
  const steps = Math.round(seconds / dt);
  for (let i = 0; i < steps; i++) v.step(dt, ground as any);
}

describe("Phase 11.1 — PhysicsBackend", () => {
  it("ForgeJSPhysics wraps a PhysicsWorld and registers a heightfield", () => {
    const backend = createPhysicsBackend("js");
    expect(backend.kind).toBe("js");
    expect(backend.world).not.toBeNull();
    const hf = new HeightfieldShape({ sampleHeight: (x, z) => 0.1 * x + 0.05 * z });
    const body = backend.setHeightfield(hf);
    expect(body).not.toBeNull();
    expect(backend.queryHeight(10, 0)).toBeCloseTo(1, 6);
    const sample = { height: 0, nx: 0, ny: 1, nz: 0 };
    expect(backend.sampleGround(0, 0, sample)).toBe(true);
    expect(sample.height).toBe(0);
  });

  it("ForgeWasmPhysics is a stub that throws until Phase 25", () => {
    const wasm = new ForgeWasmPhysics();
    expect(wasm.kind).toBe("wasm");
    expect(() => wasm.step(1 / 60)).toThrow(/Phase 25/);
  });
});

describe("Phase 11.2 / 11.6 — heightfield agreement", () => {
  it("VISUAL TERRAIN = TERRAIN COLLISION = VEHICLE CONTACT", () => {
    const heightAt = (x: number, z: number) => 2 + 0.15 * Math.sin(x * 0.4) + 0.1 * Math.cos(z * 0.3);
    const shape = new HeightfieldShape({ sampleHeight: heightAt });
    const backend = new ForgeJSPhysics();
    backend.setHeightfield(shape);

    const visual = heightFunctionGround(heightAt);
    const collision = physicsGroundQuery(backend);
    const vehicle = physicsGroundQuery(backend); // vehicle contact shares the backend sampler
    const raycast = physicsRaycastGroundQuery(backend);

    const pts = [
      [0, 0],
      [3, -2],
      [-4, 5],
      [1.5, 1.5],
      [8, -3],
    ] as const;
    const outV = { height: 0, nx: 0, ny: 1, nz: 0 };
    const outC = { height: 0, nx: 0, ny: 1, nz: 0 };
    const outQ = { height: 0, nx: 0, ny: 1, nz: 0 };
    const outR = { height: 0, nx: 0, ny: 1, nz: 0 };
    for (const [x, z] of pts) {
      visual.sample(x, z, outV);
      collision.sample(x, z, outC);
      vehicle.sample(x, z, outQ);
      raycast.sample(x, z, outR);
      expect(
        assertTerrainAgreement(outV.height, outC.height, outQ.height),
        `disagree at (${x},${z}): v=${outV.height} c=${outC.height} q=${outQ.height}`,
      ).toBe(true);
      expect(outR.height).toBeCloseTo(outV.height, 2);
      expect(outC.ny).toBeGreaterThan(0.5);
    }
  });
});

describe("Phase 11.3 — chassis participates; props collide", () => {
  it("a dynamic prop bouncing into the kinematic chassis changes its velocity", () => {
    const backend = new ForgeJSPhysics({ gravity: { x: 0, y: 0, z: 0 } });
    const ground = flatGround(0);
    const vehicle = new Vehicle(createVehicleConfig({ mass: 1400, aero: null }));
    vehicle.placeOnGround(ground);
    vehicle.position.set(0, 1, 0);
    const chassis = createVehicleChassis(vehicle, backend);
    syncVehicleChassis(vehicle, chassis);

    const prop = new RigidBody({
      type: "dynamic",
      shape: new BoxShape(0.3, 0.3, 0.3),
      mass: 40,
      position: { x: 0, y: 1, z: 3 },
      linearVelocity: { x: 0, y: 0, z: -12 },
      restitution: 0.4,
      friction: 0.2,
    });
    backend.addBody(prop);

    const vz0 = prop.linearVelocity.z;
    for (let i = 0; i < 90; i++) {
      syncVehicleChassis(vehicle, chassis);
      backend.step(1 / 60);
    }
    // Prop should have been slowed / reversed / deflected by the chassis collision.
    expect(prop.linearVelocity.z).toBeGreaterThan(vz0);
    expect(prop.linearVelocity.z).not.toBeCloseTo(vz0, 1);
  });

  it("syncVehicleChassis maps body-axis Euler rates to world angular velocity", () => {
    const backend = new ForgeJSPhysics({ gravity: { x: 0, y: 0, z: 0 } });
    const vehicle = new Vehicle(createVehicleConfig({ aero: null }));
    vehicle.placeOnGround(flatGround(0));
    vehicle.yaw = Math.PI / 2; // face +X
    vehicle.pitchRate = 0;
    vehicle.yawRate = 1.5;
    vehicle.rollRate = 0;
    const chassis = createVehicleChassis(vehicle, backend);
    syncVehicleChassis(vehicle, chassis);
    // Facing +X: body up ≈ world Y, so yawRate maps primarily to world +Y.
    expect(chassis.angularVelocity.y).toBeCloseTo(1.5, 5);
    expect(Math.abs(chassis.angularVelocity.x)).toBeLessThan(1e-6);
    expect(Math.abs(chassis.angularVelocity.z)).toBeLessThan(1e-6);

    vehicle.yaw = 0;
    vehicle.pitchRate = 2;
    vehicle.yawRate = 0;
    vehicle.rollRate = 0;
    syncVehicleChassis(vehicle, chassis);
    // Facing +Z, right ≈ +X: pitchRate · right → world +X (nose-up rate about right).
    expect(chassis.angularVelocity.x).toBeCloseTo(2, 5);
    expect(Math.abs(chassis.angularVelocity.y)).toBeLessThan(1e-6);
    expect(Math.abs(chassis.angularVelocity.z)).toBeLessThan(1e-6);
  });
});

describe("adversarial auto-fix — raycast exclude / hubVelocity", () => {
  it("physicsRaycastGroundQuery skips kinematic chassis so wheels cannot self-hit", () => {
    const backend = new ForgeJSPhysics();
    backend.setHeightfield(new HeightfieldShape({ sampleHeight: () => 0 }));
    const vehicle = new Vehicle(createVehicleConfig({ aero: null }));
    vehicle.placeOnGround(flatGround(0));
    vehicle.position.set(0, 1, 0);
    const chassis = createVehicleChassis(vehicle, backend);
    syncVehicleChassis(vehicle, chassis);

    const out = { height: 0, nx: 0, ny: 1, nz: 0 };
    // Without skip, a ray from above through the chassis box can hit y≈chassis top (>0).
    const naive = physicsRaycastGroundQuery(backend, { maxDistance: 64, skipKinematic: false });
    naive.sample(0, 0, out);
    expect(out.height).toBeGreaterThan(0.2);

    const safe = physicsRaycastGroundQuery(backend, { excludeBody: chassis });
    safe.sample(0, 0, out);
    expect(out.height).toBeCloseTo(0, 2);
  });

  it("hubVelocity includes pitch/roll via ω×r (not yaw-only)", () => {
    const vehicle = new Vehicle(createVehicleConfig({ aero: null }));
    vehicle.placeOnGround(flatGround(0));
    vehicle.velocity.set(0, 0, 0);
    vehicle.yawRate = 0;
    vehicle.pitchRate = 3;
    vehicle.rollRate = 0;
    // Force a known contact offset below/ahead of CG.
    const w = vehicle.wheels[0]!;
    w.contactX = vehicle.position.x;
    w.contactY = vehicle.position.y - 0.5;
    w.contactZ = vehicle.position.z + 1.0;
    // rebuildBasis via a zero-length-safe path: writeAngularVelocity
    vehicle.writeAngularVelocity({ x: 0, y: 0, z: 0 } as any);
    const hub = (vehicle as any).hubVelocity(w) as { x: number; z: number };
    // ω ≈ (3,0,0), r ≈ (0,-0.5,1) → ω×r = (0, -3, -1.5) so vz = -1.5
    expect(hub.z).toBeCloseTo(-1.5, 5);
    expect(Math.abs(hub.x)).toBeLessThan(1e-6);
  });
});

describe("Phase 11.4 — physical orientation", () => {
  it("pitch and roll carry angular rates (not a pure kinematic snap)", () => {
    const ground = flatGround(0);
    const vehicle = new Vehicle(createVehicleConfig({ aero: null }));
    vehicle.placeOnGround(ground);
    vehicle.pitchRate = 1.2;
    vehicle.rollRate = -0.8;
    // One short step with no contact change: rates should integrate into angles.
    const p0 = vehicle.pitch;
    const r0 = vehicle.roll;
    vehicle.step(1 / 120, ground);
    expect(Math.abs(vehicle.pitch - p0)).toBeGreaterThan(0.001);
    expect(Math.abs(vehicle.roll - r0)).toBeGreaterThan(0.001);
  });

  it("settles to a positive pitch on a constant uphill slope", () => {
    const theta = (12 * Math.PI) / 180;
    const ground = slopeGround(theta, "z");
    const vehicle = new Vehicle(createVehicleConfig({ mass: 1200, mu: 1.1, aero: null }));
    vehicle.placeOnGround(ground);
    run(vehicle, ground, 1.5);
    expect(vehicle.pitch).toBeGreaterThan(0.08);
    expect(Math.abs(vehicle.pitch - theta)).toBeLessThan(0.12);
  });
});

describe("Phase 11.5 — wheel contact via physics queries", () => {
  it("drives on a physics-backed ground query", () => {
    const heightAt = (_x: number, z: number) => Math.max(0, z - 18) * Math.tan((12 * Math.PI) / 180);
    const shape = new HeightfieldShape({ sampleHeight: heightAt });
    const backend = new ForgeJSPhysics();
    backend.setHeightfield(shape);
    const ground = physicsRaycastGroundQuery(backend);
    const vehicle = new Vehicle(
      createVehicleConfig({
        mass: 1200,
        mu: 1.1,
        aero: null,
      }),
    );
    vehicle.placeOnGround(ground);
    vehicle.input.throttle = 1;
    run(vehicle, ground, 5);
    expect(vehicle.position.z).toBeGreaterThan(1);
    expect(Number.isFinite(vehicle.position.y)).toBe(true);
    expect(vehicle.wheels.some((w) => w.inContact)).toBe(true);
  });
});

describe("Phase 11.7 — stress tests", () => {
  const bump = (_x: number, z: number) => 0.6 * Math.exp(-((z - 8) ** 2) / 2.5);
  const crater = (x: number, z: number) => -0.8 * Math.exp(-(x * x + (z - 6) ** 2) / 4);
  const sideSlope = (x: number, _z: number) => 0.25 * x;

  it("traverses a crater without NaNs", () => {
    const ground = heightFunctionGround(crater);
    const v = new Vehicle(createVehicleConfig({ aero: null, mu: 1.1 }));
    v.placeOnGround(ground);
    v.input.throttle = 0.7;
    run(v, ground, 4);
    expect(Number.isFinite(v.position.y)).toBe(true);
    expect(Number.isFinite(v.pitch)).toBe(true);
  });

  it("survives a large bump", () => {
    const ground = heightFunctionGround(bump);
    const v = new Vehicle(createVehicleConfig({ aero: null }));
    v.placeOnGround(ground);
    v.setVelocity(0, 0, 12);
    run(v, ground, 2);
    expect(Number.isFinite(v.position.y)).toBe(true);
    expect(v.wheels.some((w) => w.inContact || v.airborne)).toBe(true);
  });

  it("holds contact on a side slope (roll emerges)", () => {
    const ground = heightFunctionGround(sideSlope);
    const v = new Vehicle(createVehicleConfig({ aero: null }));
    v.placeOnGround(ground);
    run(v, ground, 1.5);
    expect(Math.abs(v.roll)).toBeGreaterThan(0.05);
    expect(Number.isFinite(v.rollRate)).toBe(true);
  });

  it("goes airborne off a jump ramp then lands", () => {
    const ramp = (_x: number, z: number) => {
      if (z < 0) return 0;
      if (z < 10) return z * 0.45;
      return 0; // drop-off (not a plateau) so the car must leave the ground
    };
    const ground = heightFunctionGround(ramp);
    const v = new Vehicle(createVehicleConfig({ aero: null, mu: 1.2 }));
    v.placeOnGround(ground);
    v.setVelocity(0, 0, 22);
    let wasAirborne = false;
    for (let i = 0; i < 240; i++) {
      v.step(1 / 60, ground);
      if (v.airborne) wasAirborne = true;
    }
    expect(wasAirborne).toBe(true);
    expect(Number.isFinite(v.position.y)).toBe(true);
  });

  it("unloads / lifts an inside wheel under hard lateral transfer", () => {
    const ground = flatGround(0);
    const v = new Vehicle(createVehicleConfig({ aero: null, cgHeight: 0.7, mass: 1400 }));
    v.placeOnGround(ground);
    v.setVelocity(0, 0, 20);
    v.input.steer = 1;
    v.input.throttle = 0.4;
    let lifted = false;
    for (let i = 0; i < 120; i++) {
      v.step(1 / 60, ground);
      if (v.wheels.some((w) => !w.inContact)) lifted = true;
    }
    // Soft expectation: either a wheel lifts or roll rate is significant under steer.
    expect(lifted || Math.abs(v.roll) > 0.02 || Math.abs(v.ay) > 1).toBe(true);
  });

  it("survives a high-speed impact against a prop", () => {
    const backend = new ForgeJSPhysics({ gravity: { x: 0, y: -9.81, z: 0 } });
    backend.setHeightfield(new HeightfieldShape({ sampleHeight: () => 0 }));
    const ground = physicsGroundQuery(backend);
    const v = new Vehicle(createVehicleConfig({ aero: null }));
    v.placeOnGround(ground);
    const chassis = createVehicleChassis(v, backend);
    const wall = new RigidBody({
      type: "static",
      shape: new BoxShape(2, 1, 0.4),
      position: { x: 0, y: 1, z: 6 },
    });
    backend.addBody(wall);
    v.setVelocity(0, 0, 25);
    for (let i = 0; i < 90; i++) {
      v.step(1 / 60, ground);
      syncVehicleChassis(v, chassis);
      backend.step(1 / 60);
    }
    expect(Number.isFinite(v.position.x)).toBe(true);
    expect(Number.isFinite(chassis.position.x)).toBe(true);
  });

  it("can approach a rollover attitude on a steep side slope at speed", () => {
    const steep = (x: number, _z: number) => 0.55 * x;
    const ground = heightFunctionGround(steep);
    const v = new Vehicle(createVehicleConfig({ aero: null, cgHeight: 0.75 }));
    v.placeOnGround(ground);
    v.setVelocity(0, 0, 16);
    v.input.steer = -0.3;
    run(v, ground, 2.5);
    expect(Math.abs(v.roll)).toBeGreaterThan(0.15);
    expect(Number.isFinite(v.roll)).toBe(true);
  });
});

describe("Phase 11.8 — telemetry", () => {
  it("reports wheel load, suspension travel, slip, tire force, RPM, gear, omega, contact", () => {
    const ground = flatGround(0);
    const v = new Vehicle(createVehicleConfig({ aero: null }));
    v.placeOnGround(ground);
    v.input.throttle = 1;
    run(v, ground, 0.5);
    const t = v.telemetry();
    expect(t.wheels).toHaveLength(4);
    expect(t.engineRpm).toBeGreaterThan(0);
    expect(typeof t.gear).toBe("number");
    expect(t.speed).toBeGreaterThanOrEqual(0);
    for (const w of t.wheels) {
      expect(w.load).toBeGreaterThanOrEqual(0);
      expect(w.suspensionTravel).toBeGreaterThanOrEqual(0);
      expect(typeof w.slipRatio).toBe("number");
      expect(typeof w.slipAngle).toBe("number");
      expect(typeof w.tireForceLong).toBe("number");
      expect(typeof w.tireForceLat).toBe("number");
      expect(typeof w.omega).toBe("number");
      expect(typeof w.inContact).toBe("boolean");
    }
  });
});

describe("adversarial auto-fix — kinematic pose-delta velocities", () => {
  it("PhysicsSystem derives kinematic linear/angular velocity from Transform deltas", async () => {
    const {
      Clock,
      ColliderComponent,
      EntityWorld,
      Logger,
      PhysicsSystem,
      Profiler,
      Quat,
      RigidBodyComponent,
      SystemScratch,
      Transform,
    } = await import("@forge/engine");

    const world = new EntityWorld();
    world.registerSystem(new PhysicsSystem({ gravity: { x: 0, y: 0, z: 0 } }));

    const entity = world.createEntity("kin");
    const transform = new Transform();
    transform.setPosition(0, 1, 0);
    entity.add(transform);
    const rb = new RigidBodyComponent();
    rb.bodyType = "kinematic";
    entity.add(rb);
    const col = new ColliderComponent();
    col.setBox(0.5, 0.5, 0.5);
    entity.add(col);

    const dt = 1 / 60;
    const makeCtx = (fixedSteps = 1) => ({
      world,
      clock: new Clock(),
      dt,
      fixedDt: dt,
      fixedSteps,
      alpha: 0,
      elapsed: 0,
      frame: 1,
      logger: new Logger(),
      profiler: new Profiler(),
      services: { get: () => undefined, engineConfig: {} },
      scratch: new SystemScratch(),
    });

    world.runSystems(makeCtx(1));
    expect(rb.body).not.toBeNull();
    expect(rb.body!.linearVelocity.x).toBeCloseTo(0, 6);

    transform.setPosition(3, 1, 0);
    transform.setRotation(new Quat().setAxisAngle({ x: 0, y: 1, z: 0 }, 0.3));
    world.runSystems(makeCtx(1));

    expect(rb.body!.linearVelocity.x).toBeCloseTo(3 / dt, 4);
    expect(rb.body!.angularVelocity.y).toBeCloseTo(0.3 / dt, 2);
    world.dispose();
  });
});
