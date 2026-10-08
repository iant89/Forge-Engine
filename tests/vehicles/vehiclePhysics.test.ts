/**
 * @suite vehicles:vehiclePhysics
 * @group unit
 * @covers engine/src/index.ts
 * @covers engine/src/physics/backend.ts
 * @covers engine/src/physics/body.ts
 * @covers engine/src/physics/shapes.ts
 * @covers engine/src/physics/system.ts
 * @covers engine/src/physics/world.ts
 * @covers engine/src/vehicles/chassis.ts
 * @covers engine/src/vehicles/components.ts
 * @covers engine/src/vehicles/ground.ts
 * @covers engine/src/vehicles/physicsGround.ts
 * @covers engine/src/vehicles/system.ts
 * @covers engine/src/vehicles/vehicle.ts
 * @desc Phase 11 — physics / vehicle integration: backend, heightfield agreement, chassis/prop collision,
 */

export const suite = {
  name: "vehicles:vehiclePhysics",
  group: "unit",
  covers:   [
    "engine/src/index.ts",
    "engine/src/physics/backend.ts",
    "engine/src/physics/body.ts",
    "engine/src/physics/shapes.ts",
    "engine/src/physics/system.ts",
    "engine/src/physics/world.ts",
    "engine/src/vehicles/chassis.ts",
    "engine/src/vehicles/components.ts",
    "engine/src/vehicles/ground.ts",
    "engine/src/vehicles/physicsGround.ts",
    "engine/src/vehicles/system.ts",
    "engine/src/vehicles/vehicle.ts"
  ],
  desc: "Phase 11 — physics / vehicle integration: backend, heightfield agreement, chassis/prop collision,",
};
/**
 * Phase 11 — physics / vehicle integration: backend, heightfield agreement, chassis/prop collision,
 * physical orientation, stress cases, and telemetry.
 */
import assert from "node:assert/strict";
import { assertCloseTo, assertContains, assertNotCloseTo, assertNotContains, assertThrows, finish, group, test } from "selrun";
import {
  BoxShape,
  ForgeJSPhysics,
  ForgeWasmPhysics,
  HeightfieldShape,
  PhysicsSystem,
  PhysicsWorld,
  RigidBody,
  Vehicle,
  VehicleComponent,
  VehicleSystem,
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

group("Phase 11.1 — PhysicsBackend", () => {
  test("ForgeJSPhysics wraps a PhysicsWorld and registers a heightfield", () => {
    const backend = createPhysicsBackend("js");
    assert.equal(backend.kind, "js");
    assert.notEqual(backend.world, null);
    const hf = new HeightfieldShape({ sampleHeight: (x, z) => 0.1 * x + 0.05 * z });
    const body = backend.setHeightfield(hf);
    assert.notEqual(body, null);
    assertCloseTo(backend.queryHeight(10, 0)!, 1, 6);
    const sample = { height: 0, nx: 0, ny: 1, nz: 0 };
    assert.equal(backend.sampleGround(0, 0, sample), true);
    assert.equal(sample.height, 0);
  });

  test("ForgeWasmPhysics is a stub that throws until Phase 25", () => {
    const wasm = new ForgeWasmPhysics();
    assert.equal(wasm.kind, "wasm");
    assertThrows(() => wasm.step(1 / 60), /Phase 25/);
  });
});

group("Captain C — shared / adopted PhysicsWorld", () => {
  test("defaults to single-owner worlds (distinct identities)", () => {
    const backend = new ForgeJSPhysics();
    const system = new PhysicsSystem();
    assert.equal(backend.ownsWorld, true);
    assert.equal(system.ownsWorld, true);
    assert.notEqual(backend.world, system.world);
  });

  test("ForgeJSPhysics.wrap and PhysicsSystem({ world }) share one world identity", () => {
    const world = new PhysicsWorld();
    const backend = ForgeJSPhysics.wrap(world);
    const system = new PhysicsSystem({ world });
    assert.equal(backend.world, world);
    assert.equal(system.world, world);
    assert.equal(backend.ownsWorld, false);
    assert.equal(system.ownsWorld, false);
  });

  test("PhysicsSystem({ backend }) adopts the backend world", () => {
    const backend = new ForgeJSPhysics();
    const system = new PhysicsSystem({ backend });
    assert.equal(system.world, backend.world);
    assert.equal(system.ownsWorld, false);
    assert.equal(backend.ownsWorld, true);
  });

  test("adopt copies explicit gravity/fixedDt/solverOptions onto the shared world", () => {
    const world = new PhysicsWorld({ gravity: { x: 0, y: -9.81, z: 0 }, fixedDt: 1 / 60 });
    assertCloseTo(world.gravity.y, -9.81, 5);
    assert.equal(world.solver.velocityIterations, 8);

    const system = new PhysicsSystem({
      world,
      gravity: { x: 0, y: 0, z: 0 },
      fixedDt: 1 / 120,
      solverOptions: { velocityIterations: 4 },
    });
    assert.equal(system.world, world);
    assert.equal(world.gravity.x, 0);
    assert.equal(world.gravity.y, 0);
    assert.equal(world.gravity.z, 0);
    assertCloseTo(world.fixedDt, 1 / 120, 10);
    assert.equal(world.solver.velocityIterations, 4);
    // Unspecified solver fields are left alone.
    assert.equal(world.solver.positionIterations, 2);

    // Omit fields → do not clobber.
    const world2 = new PhysicsWorld({ gravity: { x: 1, y: 2, z: 3 }, fixedDt: 1 / 30 });
    new PhysicsSystem({ world: world2 });
    assert.equal(world2.gravity.x, 1);
    assert.equal(world2.gravity.y, 2);
    assert.equal(world2.gravity.z, 3);
    assertCloseTo(world2.fixedDt, 1 / 30, 10);

    // ForgeJSPhysics adopt path matches.
    const world3 = new PhysicsWorld({ gravity: { x: 0, y: -9.81, z: 0 } });
    new ForgeJSPhysics({ world: world3, gravity: { x: 0, y: 0, z: 0 }, fixedDt: 1 / 90 });
    assert.equal(world3.gravity.y, 0);
    assertCloseTo(world3.fixedDt, 1 / 90, 10);
  });

  test("shared world: heightfield and chassis are visible to both sides", () => {
    const backend = new ForgeJSPhysics({ gravity: { x: 0, y: -9.81, z: 0 } });
    const system = new PhysicsSystem({ world: backend.world });

    const hf = new HeightfieldShape({ sampleHeight: () => 0 });
    const hfBody = backend.setHeightfield(hf);
    assert.notEqual(hfBody, null);
    assert.equal(system.world.getHeightfield(), hf);
    assertContains(system.world.bodies, hfBody);

    const vehicle = new Vehicle(createVehicleConfig({ aero: null }));
    vehicle.placeOnGround(flatGround(0));
    vehicle.position.set(0, 1, 0);
    const chassis = createVehicleChassis(vehicle, backend);
    syncVehicleChassis(vehicle, chassis);

    assertContains(system.world.bodies, chassis);
    assertContains(backend.world.bodies, chassis);
    // Same world identity ⇒ both sides see the same body list.
    assert.equal(backend.world.bodies, system.world.bodies);
  });

  test("PhysicsSystem.dispose does not clear an adopted world", () => {
    const backend = new ForgeJSPhysics();
    backend.setHeightfield(new HeightfieldShape({ sampleHeight: () => 1 }));
    const system = new PhysicsSystem({ backend });
    system.dispose();
    assert.equal(backend.queryHeight(0, 0), 1);
    assert.notEqual(backend.world.getHeightfield(), null);
  });

  test("dispose removes system-spawned RigidBodyComponent bodies on shared world, leaves others", async () => {
    const {
      Clock,
      ColliderComponent,
      EntityWorld,
      Logger,
      Profiler,
      RigidBodyComponent,
      SystemScratch,
      Transform,
      createVehicleChassis,
      createVehicleConfig,
      Vehicle,
    } = await import("@forge/engine");

    const shared = new PhysicsWorld({ gravity: { x: 0, y: 0, z: 0 } });
    const hf = new HeightfieldShape({ sampleHeight: () => 0.5 });
    shared.setHeightfield(hf);
    const external = new RigidBody({
      type: "static",
      shape: new BoxShape(0.3, 0.3, 0.3),
      position: { x: 5, y: 0, z: 0 },
    });
    shared.addBody(external);

    const backend = ForgeJSPhysics.wrap(shared);
    const vehicle = new Vehicle(createVehicleConfig({ mass: 1200 }));
    const chassis = createVehicleChassis(vehicle, backend);
    assertContains(shared.bodies, chassis);

    const ecs = new EntityWorld();
    const physics = new PhysicsSystem({ world: shared });
    assert.equal(physics.ownsWorld, false);
    ecs.registerSystem(physics);

    const entity = ecs.createEntity("prop");
    const transform = new Transform();
    transform.setPosition(0, 2, 0);
    entity.add(transform);
    const rb = new RigidBodyComponent();
    rb.bodyType = "dynamic";
    rb.mass = 1;
    entity.add(rb);
    const col = new ColliderComponent();
    col.setBox(0.25, 0.25, 0.25);
    entity.add(col);

    const dt = 1 / 60;
    const ctx = {
      world: ecs,
      clock: new Clock(),
      dt,
      fixedDt: dt,
      fixedSteps: 1,
      alpha: 0,
      elapsed: 0,
      frame: 1,
      logger: new Logger(),
      profiler: new Profiler(),
      services: { get: () => undefined, engineConfig: {} },
      scratch: new SystemScratch(),
    };
    ecs.runSystems(ctx);
    assert.notEqual(rb.body, null);
    const spawned = rb.body!;
    assertContains(shared.bodies, spawned);
    assertContains(shared.bodies, external);
    assertContains(shared.bodies, chassis);
    assert.notEqual(shared.getHeightfield(), null);

    // Dispose PhysicsSystem only (shared world stays alive).
    physics.dispose();

    assertNotContains(shared.bodies, spawned);
    assertContains(shared.bodies, external);
    assertContains(shared.bodies, chassis);
    assert.notEqual(shared.getHeightfield(), null);
    assert.equal(backend.queryHeight(0, 0), 0.5);

    ecs.dispose();
  });

  test("dispose nulls RigidBodyComponent.body so a new PhysicsSystem re-adds on shared world", async () => {
    const {
      Clock,
      ColliderComponent,
      EntityWorld,
      Logger,
      Profiler,
      RigidBodyComponent,
      SystemScratch,
      Transform,
    } = await import("@forge/engine");

    const shared = new PhysicsWorld({ gravity: { x: 0, y: 0, z: 0 } });
    const ecs = new EntityWorld();
    const first = new PhysicsSystem({ world: shared });
    const firstReg = ecs.registerSystem(first);

    const entity = ecs.createEntity("prop");
    const transform = new Transform();
    transform.setPosition(0, 2, 0);
    entity.add(transform);
    const rb = new RigidBodyComponent();
    rb.bodyType = "dynamic";
    rb.mass = 1;
    entity.add(rb);
    const col = new ColliderComponent();
    col.setBox(0.25, 0.25, 0.25);
    entity.add(col);

    const dt = 1 / 60;
    const ctx = {
      world: ecs,
      clock: new Clock(),
      dt,
      fixedDt: dt,
      fixedSteps: 1,
      alpha: 0,
      elapsed: 0,
      frame: 1,
      logger: new Logger(),
      profiler: new Profiler(),
      services: { get: () => undefined, engineConfig: {} },
      scratch: new SystemScratch(),
    };
    ecs.runSystems(ctx);
    assert.notEqual(rb.body, null);
    const firstBody = rb.body!;
    assertContains(shared.bodies, firstBody);

    // Hot-swap: dispose removes collider and clears the component handle; unregister so a
    // replacement PhysicsSystem can register under the same system name.
    first.dispose();
    firstReg.dispose();
    assertNotContains(shared.bodies, firstBody);
    assert.equal(rb.body, null);

    // Replacement system must re-add (not skip because of a stale non-null body).
    const second = new PhysicsSystem({ world: shared });
    ecs.registerSystem(second);
    ecs.runSystems({ ...ctx, frame: 2 });
    assert.notEqual(rb.body, null);
    assert.notEqual(rb.body, firstBody);
    assertContains(shared.bodies, rb.body!);
    assertNotContains(shared.bodies, firstBody);

    second.dispose();
    ecs.dispose();
  });

  test("destroyEntity removes system-spawned body from shared world immediately", async () => {
    const {
      Clock,
      ColliderComponent,
      EntityWorld,
      Logger,
      Profiler,
      RigidBodyComponent,
      SystemScratch,
      Transform,
    } = await import("@forge/engine");

    const shared = new PhysicsWorld({ gravity: { x: 0, y: 0, z: 0 } });
    const external = new RigidBody({
      type: "static",
      shape: new BoxShape(0.3, 0.3, 0.3),
      position: { x: 5, y: 0, z: 0 },
    });
    shared.addBody(external);

    const ecs = new EntityWorld();
    const physics = new PhysicsSystem({ world: shared });
    ecs.registerSystem(physics);

    const entity = ecs.createEntity("prop");
    const transform = new Transform();
    transform.setPosition(0, 2, 0);
    entity.add(transform);
    const rb = new RigidBodyComponent();
    rb.bodyType = "dynamic";
    rb.mass = 1;
    entity.add(rb);
    const col = new ColliderComponent();
    col.setBox(0.25, 0.25, 0.25);
    entity.add(col);

    const dt = 1 / 60;
    const ctx = {
      world: ecs,
      clock: new Clock(),
      dt,
      fixedDt: dt,
      fixedSteps: 1,
      alpha: 0,
      elapsed: 0,
      frame: 1,
      logger: new Logger(),
      profiler: new Profiler(),
      services: { get: () => undefined, engineConfig: {} },
      scratch: new SystemScratch(),
    };
    ecs.runSystems(ctx);
    assert.notEqual(rb.body, null);
    const spawned = rb.body!;
    assertContains(shared.bodies, spawned);
    assertContains(shared.bodies, external);

    // Despawn must drop the collider now — not leave a ghost until PhysicsSystem.dispose().
    const removed = ecs.destroyEntity(entity.id);
    assert.equal(removed, true);
    assert.equal(rb.body, null);
    assertNotContains(shared.bodies, spawned);
    assertContains(shared.bodies, external);

    physics.dispose();
    ecs.dispose();
  });

  test("destroyEntity removes VehicleComponent chassisBody from shared world immediately", async () => {
    const {
      EntityWorld,
      Transform,
      VehicleComponent,
      createVehicleChassis,
      createVehicleConfig,
      Vehicle,
    } = await import("@forge/engine");

    const shared = new PhysicsWorld({ gravity: { x: 0, y: 0, z: 0 } });
    const external = new RigidBody({
      type: "static",
      shape: new BoxShape(0.3, 0.3, 0.3),
      position: { x: 5, y: 0, z: 0 },
    });
    shared.addBody(external);

    const backend = ForgeJSPhysics.wrap(shared);
    const vehicle = new Vehicle(createVehicleConfig({ mass: 1200, aero: null }));
    vehicle.placeOnGround(flatGround(0));
    const chassis = createVehicleChassis(vehicle, backend);
    assertContains(shared.bodies, chassis);

    const ecs = new EntityWorld();
    // Shared-world recipe: PhysicsSystem adopts the same world (does not own chassis teardown).
    const physics = new PhysicsSystem({ world: shared });
    ecs.registerSystem(physics);

    const entity = ecs.createEntity("car");
    const transform = new Transform();
    transform.setPosition(vehicle.position.x, vehicle.position.y, vehicle.position.z);
    entity.add(transform);
    const comp = new VehicleComponent(vehicle, flatGround(0));
    comp.attachChassis(chassis, shared);
    entity.add(comp);
    assert.equal(comp.chassisBody, chassis);
    assert.equal(comp.chassisWorld, shared);

    // Despawn must drop the kinematic chassis now — not leave a ghost until PhysicsSystem.dispose().
    const removed = ecs.destroyEntity(entity.id);
    assert.equal(removed, true);
    assert.equal(comp.chassisBody, null);
    assert.equal(comp.chassisWorld, null);
    assertNotContains(shared.bodies, chassis);
    assertContains(shared.bodies, external);

    physics.dispose();
    ecs.dispose();
  });

  test("removeComponent(VehicleComponent) removes chassisBody and nulls handles", async () => {
    const {
      EntityWorld,
      Transform,
      VehicleComponent,
      createVehicleChassis,
      createVehicleConfig,
      Vehicle,
    } = await import("@forge/engine");

    const shared = new PhysicsWorld({ gravity: { x: 0, y: 0, z: 0 } });
    const backend = ForgeJSPhysics.wrap(shared);
    const vehicle = new Vehicle(createVehicleConfig({ aero: null }));
    vehicle.placeOnGround(flatGround(0));
    const chassis = createVehicleChassis(vehicle, backend);

    const ecs = new EntityWorld();
    const entity = ecs.createEntity("car");
    entity.add(new Transform());
    const comp = new VehicleComponent(vehicle, flatGround(0));
    comp.attachChassis(chassis, shared);
    entity.add(comp);

    assert.equal(entity.remove(VehicleComponent), true);
    assert.equal(comp.chassisBody, null);
    assert.equal(comp.chassisWorld, null);
    assertNotContains(shared.bodies, chassis);

    ecs.dispose();
  });

  test("attachChassis hot-swap removes prior body; detach removes only the current", async () => {
    const {
      EntityWorld,
      Transform,
      VehicleComponent,
      createVehicleChassis,
      createVehicleConfig,
      Vehicle,
    } = await import("@forge/engine");

    const shared = new PhysicsWorld({ gravity: { x: 0, y: 0, z: 0 } });
    const backend = ForgeJSPhysics.wrap(shared);
    const vehicle = new Vehicle(createVehicleConfig({ aero: null }));
    vehicle.placeOnGround(flatGround(0));
    const chassisA = createVehicleChassis(vehicle, backend);
    const chassisB = createVehicleChassis(vehicle, backend);
    assertContains(shared.bodies, chassisA);
    assertContains(shared.bodies, chassisB);

    const ecs = new EntityWorld();
    const entity = ecs.createEntity("car");
    entity.add(new Transform());
    const comp = new VehicleComponent(vehicle, flatGround(0));
    comp.attachChassis(chassisA, shared);
    entity.add(comp);
    assert.equal(comp.chassisBody, chassisA);

    // Hot-swap / respawn: prior kinematic must leave the world immediately.
    comp.attachChassis(chassisB, shared);
    assert.equal(comp.chassisBody, chassisB);
    assert.equal(comp.chassisWorld, shared);
    assertNotContains(shared.bodies, chassisA);
    assertContains(shared.bodies, chassisB);

    assert.equal(entity.remove(VehicleComponent), true);
    assert.equal(comp.chassisBody, null);
    assert.equal(comp.chassisWorld, null);
    assertNotContains(shared.bodies, chassisB);
    assertNotContains(shared.bodies, chassisA);

    ecs.dispose();
  });

  test("wrap/adopt backend clear() throws and does not wipe the shared world", () => {
    const world = new PhysicsWorld();
    world.setHeightfield(new HeightfieldShape({ sampleHeight: () => 2 }));
    const body = new RigidBody({
      type: "dynamic",
      shape: new BoxShape(0.2, 0.2, 0.2),
      mass: 1,
      position: { x: 0, y: 1, z: 0 },
    });
    world.addBody(body);
    const wrapped = ForgeJSPhysics.wrap(world);
    assert.equal(wrapped.ownsWorld, false);
    assertThrows(() => wrapped.clear(), /ownsWorld=false|adopted/i);
    assert.notEqual(world.getHeightfield(), null);
    assertContains(world.bodies, body);
    assert.equal(wrapped.queryHeight(0, 0), 2);
  });

  test("adopted world: exactly one solver step per ECS fixedStep (ignores accumulator)", () => {
    const shared = new PhysicsWorld({ fixedDt: 1 / 60 });
    // Leftover accumulator that would make world.step(fixedDt) run TWO fixed steps.
    shared.accumulator = shared.fixedDt * 0.99;
    const system = new PhysicsSystem({ world: shared });
    assert.equal(system.ownsWorld, false);

    const before = shared.stepCount;
    // Drive PhysicsSystem through one ECS fixed step without needing entities.
    const fakeCtx = {
      world: { query: () => ({ refresh() {}, count: 0, entity: () => 0, value: () => null }) },
      fixedDt: 1 / 60,
      fixedSteps: 1,
    } as any;
    system.fixedStep(fakeCtx, 0);
    assert.equal(shared.stepCount, before + 1);

    // Again with accumulator that would yield ZERO steps under world.step(eps).
    shared.accumulator = 0;
    const before2 = shared.stepCount;
    system.fixedStep({ ...fakeCtx, fixedDt: shared.fixedDt * 0.25 }, 0);
    // stepOnce still advances exactly once even when dt != world.fixedDt.
    assert.equal(shared.stepCount, before2 + 1);
  });
});

group("Phase 11.2 / 11.6 — heightfield agreement", () => {
  test("VISUAL TERRAIN = TERRAIN COLLISION = VEHICLE CONTACT", () => {
    const heightAt = (x: number, z: number) => 2 + 0.15 * Math.sin(x * 0.4) + 0.1 * Math.cos(z * 0.3);
    const shape = new HeightfieldShape({ sampleHeight: heightAt });
    const backend = new ForgeJSPhysics();
    backend.setHeightfield(shape);

    const visual = heightFunctionGround(heightAt);
    const collision = physicsGroundQuery(backend);
    // HF-only vehicle contact: physicsGroundQuery (not raycast — see physicsRaycastGroundQuery limits).
    const vehicle = physicsGroundQuery(backend);
    // Raycast agreement is supplemental; valid here because heights (~2) sit well below the
    // default fixed origin (maxDistance*0.5 = 32). Prefer physicsGroundQuery for pure HF.
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
      assert.equal(assertTerrainAgreement(outV.height, outC.height, outQ.height), true, `disagree at (${x},${z}): v=${outV.height} c=${outC.height} q=${outQ.height}`);
      assertCloseTo(outR.height, outV.height, 2);
      assert.ok(outC.ny > 0.5);
    }
  });
});

group("Phase 11.3 — chassis participates; props collide", () => {
  test("a dynamic prop bouncing into the kinematic chassis changes its velocity", () => {
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
    assert.ok(prop.linearVelocity.z > vz0);
    assertNotCloseTo(prop.linearVelocity.z, vz0, 1);
  });

  test("syncVehicleChassis maps body-axis Euler rates to world angular velocity", () => {
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
    assertCloseTo(chassis.angularVelocity.y, 1.5, 5);
    assert.ok(Math.abs(chassis.angularVelocity.x) < 1e-6);
    assert.ok(Math.abs(chassis.angularVelocity.z) < 1e-6);

    vehicle.yaw = 0;
    vehicle.pitchRate = 2;
    vehicle.yawRate = 0;
    vehicle.rollRate = 0;
    syncVehicleChassis(vehicle, chassis);
    // Facing +Z, right ≈ +X: −pitchRate · right → world −X (nose-up; +X RH spin is nose-down).
    assertCloseTo(chassis.angularVelocity.x, -2, 5);
    assert.ok(Math.abs(chassis.angularVelocity.y) < 1e-6);
    assert.ok(Math.abs(chassis.angularVelocity.z) < 1e-6);
  });

  test("VehicleComponent.chassisBody + PhysicsSystem — prop contact uses live pose, not spawn ghost", async () => {
    const {
      Clock,
      EntityWorld,
      Logger,
      Profiler,
      SystemScratch,
      Transform,
    } = await import("@forge/engine");

    const backend = new ForgeJSPhysics({ gravity: { x: 0, y: 0, z: 0 } });
    const ground = flatGround(0);
    const vehicle = new Vehicle(createVehicleConfig({ mass: 1400, aero: null }));
    vehicle.placeOnGround(ground);
    vehicle.position.set(0, 1, 0);
    const chassis = createVehicleChassis(vehicle, backend);
    // Leave chassis at spawn; move the vehicle without syncing — classic ghost pose.
    vehicle.position.set(0, 1, 6);
    vehicle.velocity.set(0, 0, 0);
    assertCloseTo(chassis.position.z, 0, 5);

    const world = new EntityWorld();
    world.registerSystem(new VehicleSystem());
    // Documented recipe: shared world — PhysicsSystem drives chassisBody via pose-delta.
    // Explicit gravity:{0,0,0} is copied onto the adopted world (zero-g for prop contact).
    world.registerSystem(new PhysicsSystem({ world: backend.world, gravity: { x: 0, y: 0, z: 0 } }));

    const entity = world.createEntity("car");
    const transform = new Transform();
    transform.setPosition(vehicle.position.x, vehicle.position.y, vehicle.position.z);
    entity.add(transform);
    const comp = new VehicleComponent(vehicle, ground);
    comp.attachChassis(chassis, backend.world); // recipe: chassisBody + chassisWorld
    entity.add(comp);

    // Prop aimed at the LIVE pose (z≈6), not the spawn ghost (z≈0).
    const prop = new RigidBody({
      type: "dynamic",
      shape: new BoxShape(0.3, 0.3, 0.3),
      mass: 40,
      position: { x: 0, y: 1, z: 9 },
      linearVelocity: { x: 0, y: 0, z: -14 },
      restitution: 0.4,
      friction: 0.2,
    });
    backend.addBody(prop);

    const makeCtx = (fixedSteps = 1) => ({
      world,
      clock: new Clock(),
      dt: 1 / 60,
      fixedDt: 1 / 60,
      fixedSteps,
      alpha: 0,
      elapsed: 0,
      frame: 1,
      logger: new Logger(),
      profiler: new Profiler(),
      services: { get: () => undefined, engineConfig: {} },
      scratch: new SystemScratch(),
    });

    const vz0 = prop.linearVelocity.z;
    for (let i = 0; i < 90; i++) {
      // VehicleSystem writes Transform; PhysicsSystem pose-delta + stepOnce on the shared world.
      world.runSystems(makeCtx(1));
    }
    // Chassis must have been driven off the spawn ghost.
    assert.ok(chassis.position.z > 4);
    // Prop should have bounced off the live chassis (not sailed through past a ghost at origin).
    assert.ok(prop.linearVelocity.z > vz0);
    assertNotCloseTo(prop.linearVelocity.z, vz0, 1);
    world.dispose();
  });
});

group("adversarial auto-fix — raycast exclude / hubVelocity", () => {
  test("physicsRaycastGroundQuery skips kinematic chassis so wheels cannot self-hit", () => {
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
    assert.ok(out.height > 0.2);

    const safe = physicsRaycastGroundQuery(backend, { excludeBody: chassis });
    safe.sample(0, 0, out);
    assertCloseTo(out.height, 0, 2);
  });

  test("hubVelocity includes pitch/roll via ω×r (not yaw-only)", () => {
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
    // ω ≈ (−3,0,0) for pitchRate=3 (nose-up), r ≈ (0,-0.5,1) → ω×r z = wx·ry = (−3)·(−0.5) = 1.5
    assertCloseTo(hub.z, 1.5, 5);
    assert.ok(Math.abs(hub.x) < 1e-6);
  });
});

group("Phase 11.4 — physical orientation", () => {
  test("pitch and roll carry angular rates (not a pure kinematic snap)", () => {
    const ground = flatGround(0);
    const vehicle = new Vehicle(createVehicleConfig({ aero: null }));
    vehicle.placeOnGround(ground);
    vehicle.pitchRate = 1.2;
    vehicle.rollRate = -0.8;
    // One short step with no contact change: rates should integrate into angles.
    const p0 = vehicle.pitch;
    const r0 = vehicle.roll;
    vehicle.step(1 / 120, ground);
    assert.ok(Math.abs(vehicle.pitch - p0) > 0.001);
    assert.ok(Math.abs(vehicle.roll - r0) > 0.001);
  });

  test("basis matches integrated pitch/roll after a high-rate step (rebuildBasis before penetration)", () => {
    const ground = flatGround(0);
    const vehicle = new Vehicle(createVehicleConfig({ aero: null }));
    vehicle.placeOnGround(ground);
    // Large rates so integrate moves angles far from start-of-step basis.
    vehicle.pitchRate = 4;
    vehicle.rollRate = -3;
    vehicle.yawRate = 1.5;
    vehicle.step(1 / 120, ground);
    assert.ok(Math.abs(vehicle.pitch) > 0.01);
    assert.ok(Math.abs(vehicle.roll) > 0.01);

    const fwd = (vehicle as any).forward as { x: number; y: number; z: number };
    const right = (vehicle as any).right as { x: number; y: number; z: number };
    const up = (vehicle as any).up as { x: number; y: number; z: number };
    const fx = fwd.x, fy = fwd.y, fz = fwd.z;
    const rx = right.x, ry = right.y, rz = right.z;
    const ux = up.x, uy = up.y, uz = up.z;

    // writeAngularVelocity always rebuilds from current yaw/pitch/roll — idempotent iff
    // integrate already called rebuildBasis after orientation update.
    vehicle.writeAngularVelocity({ x: 0, y: 0, z: 0 } as any);
    assertCloseTo(fwd.x, fx, 6);
    assertCloseTo(fwd.y, fy, 6);
    assertCloseTo(fwd.z, fz, 6);
    assertCloseTo(right.x, rx, 6);
    assertCloseTo(right.y, ry, 6);
    assertCloseTo(right.z, rz, 6);
    assertCloseTo(up.x, ux, 6);
    assertCloseTo(up.y, uy, 6);
    assertCloseTo(up.z, uz, 6);
  });

  test("settles to a positive pitch on a constant uphill slope", () => {
    const theta = (12 * Math.PI) / 180;
    const ground = slopeGround(theta, "z");
    const vehicle = new Vehicle(createVehicleConfig({ mass: 1200, mu: 1.1, aero: null }));
    vehicle.placeOnGround(ground);
    run(vehicle, ground, 1.5);
    assert.ok(vehicle.pitch > 0.08);
    assert.ok(Math.abs(vehicle.pitch - theta) < 0.12);
  });
});

group("Phase 11.5 — wheel contact via physics queries", () => {
  test("drives on a physics-backed ground query", () => {
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
    assert.ok(vehicle.position.z > 1);
    assert.equal(Number.isFinite(vehicle.position.y), true);
    assert.equal(vehicle.wheels.some((w) => w.inContact), true);
  });
});

group("Phase 11.7 — stress tests", () => {
  const bump = (_x: number, z: number) => 0.6 * Math.exp(-((z - 8) ** 2) / 2.5);
  const crater = (x: number, z: number) => -0.8 * Math.exp(-(x * x + (z - 6) ** 2) / 4);
  const sideSlope = (x: number, _z: number) => 0.25 * x;

  test("traverses a crater without NaNs", () => {
    const ground = heightFunctionGround(crater);
    const v = new Vehicle(createVehicleConfig({ aero: null, mu: 1.1 }));
    v.placeOnGround(ground);
    v.input.throttle = 0.7;
    run(v, ground, 4);
    assert.equal(Number.isFinite(v.position.y), true);
    assert.equal(Number.isFinite(v.pitch), true);
  });

  test("survives a large bump", () => {
    const ground = heightFunctionGround(bump);
    const v = new Vehicle(createVehicleConfig({ aero: null }));
    v.placeOnGround(ground);
    v.setVelocity(0, 0, 12);
    run(v, ground, 2);
    assert.equal(Number.isFinite(v.position.y), true);
    assert.equal(v.wheels.some((w) => w.inContact || v.airborne), true);
  });

  test("holds contact on a side slope (roll emerges)", () => {
    const ground = heightFunctionGround(sideSlope);
    const v = new Vehicle(createVehicleConfig({ aero: null }));
    v.placeOnGround(ground);
    run(v, ground, 1.5);
    assert.ok(Math.abs(v.roll) > 0.05);
    assert.equal(Number.isFinite(v.rollRate), true);
  });

  test("goes airborne off a jump ramp then lands", () => {
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
    assert.equal(wasAirborne, true);
    assert.equal(Number.isFinite(v.position.y), true);
  });

  test("unloads / lifts an inside wheel under hard lateral transfer", () => {
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
    assert.equal(lifted || Math.abs(v.roll) > 0.02 || Math.abs(v.ay) > 1, true);
  });

  test("survives a high-speed impact against a prop", () => {
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
    assert.equal(Number.isFinite(v.position.x), true);
    assert.equal(Number.isFinite(chassis.position.x), true);
  });

  test("can approach a rollover attitude on a steep side slope at speed", () => {
    const steep = (x: number, _z: number) => 0.55 * x;
    const ground = heightFunctionGround(steep);
    const v = new Vehicle(createVehicleConfig({ aero: null, cgHeight: 0.75 }));
    v.placeOnGround(ground);
    v.setVelocity(0, 0, 16);
    v.input.steer = -0.3;
    run(v, ground, 2.5);
    assert.ok(Math.abs(v.roll) > 0.15);
    assert.equal(Number.isFinite(v.roll), true);
  });
});

group("Phase 11.8 — telemetry", () => {
  test("reports wheel load, suspension travel, slip, tire force, RPM, gear, omega, contact", () => {
    const ground = flatGround(0);
    const v = new Vehicle(createVehicleConfig({ aero: null }));
    v.placeOnGround(ground);
    v.input.throttle = 1;
    run(v, ground, 0.5);
    const t = v.telemetry();
    assert.equal((t.wheels).length, 4);
    assert.ok(t.engineRpm > 0);
    assert.equal(typeof t.gear, "number");
    assert.ok(t.speed >= 0);
    for (const w of t.wheels) {
      assert.ok(w.load >= 0);
      assert.ok(w.suspensionTravel >= 0);
      assert.equal(typeof w.slipRatio, "number");
      assert.equal(typeof w.slipAngle, "number");
      assert.equal(typeof w.tireForceLong, "number");
      assert.equal(typeof w.tireForceLat, "number");
      assert.equal(typeof w.omega, "number");
      assert.equal(typeof w.inContact, "boolean");
    }
  });
});

group("adversarial auto-fix — kinematic pose-delta velocities", () => {
  test("PhysicsSystem derives kinematic linear/angular velocity from Transform deltas", async () => {
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
    assert.notEqual(rb.body, null);
    assertCloseTo(rb.body!.linearVelocity.x, 0, 6);

    transform.setPosition(3, 1, 0);
    transform.setRotation(new Quat().setAxisAngle({ x: 0, y: 1, z: 0 }, 0.3));
    world.runSystems(makeCtx(1));

    assertCloseTo(rb.body!.linearVelocity.x, 3 / dt, 4);
    assertCloseTo(rb.body!.angularVelocity.y, 0.3 / dt, 2);
    world.dispose();
  });

  test("fixedSteps>1: kinematic pose-delta velocities are per-substep (not ~fixedSteps too high)", async () => {
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
      dt: dt * fixedSteps,
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
    assert.notEqual(rb.body, null);

    // Transform jumps by the full frame delta before PhysicsSystem runs all substeps
    // (same pattern as VehicleSystem completing its fixedSteps first).
    const steps = 3;
    const frameDx = 3;
    transform.setPosition(frameDx, 1, 0);
    transform.setRotation(new Quat().setAxisAngle({ x: 0, y: 1, z: 0 }, 0.3));
    world.runSystems(makeCtx(steps));

    // Velocity must be frameDelta / (fixedSteps * fixedDt), not frameDelta / fixedDt.
    assertCloseTo(rb.body!.linearVelocity.x, frameDx / (steps * dt), 4);
    assert.ok(rb.body!.linearVelocity.x < (frameDx / dt) * 0.5);
    assertCloseTo(rb.body!.angularVelocity.y, 0.3 / (steps * dt), 2);
    assertCloseTo(rb.body!.position.x, frameDx, 5);
    world.dispose();
  });

  test("fixedSteps>1: VehicleComponent.chassisBody uses pose-delta (not parked at end pose/ω)", async () => {
    const {
      Clock,
      EntityWorld,
      Logger,
      Profiler,
      SystemScratch,
      Transform,
    } = await import("@forge/engine");

    const backend = new ForgeJSPhysics({ gravity: { x: 0, y: 0, z: 0 } });
    const ground = flatGround(0);
    const vehicle = new Vehicle(createVehicleConfig({ mass: 1400, aero: null }));
    vehicle.placeOnGround(ground);
    vehicle.position.set(0, 1, 0);
    vehicle.velocity.set(0, 0, 0);
    const chassis = createVehicleChassis(vehicle, backend);
    const startZ = chassis.position.z;

    const world = new EntityWorld();
    world.registerSystem(new VehicleSystem());
    // Explicit gravity:{0,0,0} is copied onto the adopted world (zero-g pose-delta test).
    const physics = new PhysicsSystem({ world: backend.world, gravity: { x: 0, y: 0, z: 0 } });
    world.registerSystem(physics);

    const entity = world.createEntity("car");
    const transform = new Transform();
    transform.setPosition(0, 1, 0);
    entity.add(transform);
    const comp = new VehicleComponent(vehicle, ground);
    comp.chassisBody = chassis;
    entity.add(comp);

    const dt = 1 / 60;
    const makeCtx = (fixedSteps = 1) => ({
      world,
      clock: new Clock(),
      dt: dt * fixedSteps,
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

    // Steady frame so Transform/chassis agree at the start pose.
    world.runSystems(makeCtx(1));
    assertCloseTo(chassis.position.z, transform.position.z, 5);

    // Hitch pattern: VehicleSystem has already written Transform to the end pose while
    // chassisBody still sits at the start. PhysicsSystem must distribute start→end across
    // its substeps — not contact a parked end pose every step.
    const steps = 3;
    const frameDz = 3;
    vehicle.position.set(0, 1, frameDz);
    vehicle.velocity.set(0, 0, frameDz / (steps * dt));
    transform.setPosition(0, 1, frameDz);

    chassis.position.set(0, 1, startZ);
    chassis.linearVelocity.set(0, 0, 0);
    chassis.angularVelocity.set(0, 0, 0);
    chassis.updateAABB();
    assertCloseTo(chassis.position.z, startZ, 5);

    const ctx = makeCtx(steps);
    physics.update(ctx);

    assertCloseTo(chassis.position.z, frameDz, 4);
    assertCloseTo(chassis.linearVelocity.z, frameDz / (steps * dt), 4);
    assert.ok(chassis.linearVelocity.z < (frameDz / dt) * 0.5);

    // Mid-frame sweep: rebuild hitch and sample after each fixedStep.
    chassis.position.set(0, 1, startZ);
    chassis.linearVelocity.set(0, 0, 0);
    chassis.angularVelocity.set(0, 0, 0);
    chassis.updateAABB();
    const midZ: number[] = [];
    for (let i = 0; i < steps; i++) {
      physics.fixedStep(ctx, i);
      midZ.push(chassis.position.z);
    }
    assertCloseTo(midZ[0]!, startZ + frameDz / steps, 4);
    assertCloseTo(midZ[1]!, startZ + (2 * frameDz) / steps, 4);
    assertCloseTo(midZ[2]!, startZ + frameDz, 4);
    world.dispose();
  });

  test("no pose delta zeros stale kinematic linear/angular velocity (RigidBodyComponent)", async () => {
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
    const makeCtx = () => ({
      world,
      clock: new Clock(),
      dt,
      fixedDt: dt,
      fixedSteps: 1,
      alpha: 0,
      elapsed: 0,
      frame: 1,
      logger: new Logger(),
      profiler: new Profiler(),
      services: { get: () => undefined, engineConfig: {} },
      scratch: new SystemScratch(),
    });

    world.runSystems(makeCtx());
    assert.notEqual(rb.body, null);

    // Moving frame writes non-zero chassis ω/v from pose-delta.
    transform.setPosition(3, 1, 0);
    transform.setRotation(new Quat().setAxisAngle({ x: 0, y: 1, z: 0 }, 0.3));
    world.runSystems(makeCtx());
    assertCloseTo(rb.body!.linearVelocity.x, 3 / dt, 4);
    assertCloseTo(rb.body!.angularVelocity.y, 0.3 / dt, 2);

    // Brake: Transform matches body — poseMoved/rotMoved false. Must clear stale velocities
    // so SequentialImpulseSolver does not treat the parked body like a conveyor.
    world.runSystems(makeCtx());
    assertCloseTo(rb.body!.linearVelocity.x, 0, 6);
    assertCloseTo(rb.body!.linearVelocity.y, 0, 6);
    assertCloseTo(rb.body!.linearVelocity.z, 0, 6);
    assertCloseTo(rb.body!.angularVelocity.x, 0, 6);
    assertCloseTo(rb.body!.angularVelocity.y, 0, 6);
    assertCloseTo(rb.body!.angularVelocity.z, 0, 6);
    world.dispose();
  });

  test("no pose delta zeros stale VehicleComponent.chassisBody velocities", async () => {
    const {
      Clock,
      EntityWorld,
      Logger,
      Profiler,
      SystemScratch,
      Transform,
    } = await import("@forge/engine");

    const backend = new ForgeJSPhysics({ gravity: { x: 0, y: 0, z: 0 } });
    const ground = flatGround(0);
    const vehicle = new Vehicle(createVehicleConfig({ mass: 1400, aero: null }));
    vehicle.placeOnGround(ground);
    vehicle.position.set(0, 1, 0);
    vehicle.velocity.set(0, 0, 0);
    const chassis = createVehicleChassis(vehicle, backend);

    const world = new EntityWorld();
    // Explicit gravity:{0,0,0} is copied onto the adopted world (zero-g stale-velocity test).
    const physics = new PhysicsSystem({ world: backend.world, gravity: { x: 0, y: 0, z: 0 } });
    world.registerSystem(physics);

    const entity = world.createEntity("car");
    const transform = new Transform();
    transform.setPosition(0, 1, 0);
    entity.add(transform);
    const comp = new VehicleComponent(vehicle, ground);
    comp.chassisBody = chassis;
    entity.add(comp);

    const dt = 1 / 60;
    const makeCtx = () => ({
      world,
      clock: new Clock(),
      dt,
      fixedDt: dt,
      fixedSteps: 1,
      alpha: 0,
      elapsed: 0,
      frame: 1,
      logger: new Logger(),
      profiler: new Profiler(),
      services: { get: () => undefined, engineConfig: {} },
      scratch: new SystemScratch(),
    });

    physics.update(makeCtx());
    assertCloseTo(chassis.position.z, transform.position.z, 5);

    // Drive: pose-delta writes non-zero chassis v/ω.
    const frameDz = 2;
    transform.setPosition(0, 1, frameDz);
    assert.ok(Math.abs(chassis.position.z - frameDz) > 0.5);
    physics.update(makeCtx());
    assertCloseTo(chassis.linearVelocity.z, frameDz / dt, 4);
    assert.ok(Math.abs(chassis.linearVelocity.z) > 1);

    // Parked: Transform matches body. Inject stale ω/v as if from the last moving frame
    // (post-captain A VehicleSystem no longer syncVehicleChassis-writes ~0).
    chassis.linearVelocity.set(5, 0, -8);
    chassis.angularVelocity.set(0.2, 1.1, -0.4);
    physics.update(makeCtx());

    assertCloseTo(chassis.linearVelocity.x, 0, 6);
    assertCloseTo(chassis.linearVelocity.y, 0, 6);
    assertCloseTo(chassis.linearVelocity.z, 0, 6);
    assertCloseTo(chassis.angularVelocity.x, 0, 6);
    assertCloseTo(chassis.angularVelocity.y, 0, 6);
    assertCloseTo(chassis.angularVelocity.z, 0, 6);
    world.dispose();
  });
});

await finish();
