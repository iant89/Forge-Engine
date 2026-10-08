/**
 * @suite examples:mechanicalScene
 * @group integration
 * @covers engine/src/core/engine.ts
 * @covers engine/src/core/log.ts
 * @covers engine/src/core/time.ts
 * @covers engine/src/debug/profiler.ts
 * @covers engine/src/gpu/device.ts
 * @covers engine/src/index.ts
 * @covers engine/src/math/mat.ts
 * @covers engine/src/math/vec.ts
 * @covers engine/src/rendering/renderer.ts
 * @covers engine/src/scene/components/index.ts
 * @covers engine/src/scene/entityId.ts
 * @covers engine/src/scene/systems.ts
 * @covers engine/src/vehicles/components.ts
 * @covers engine/src/vehicles/vehicle.ts
 * @covers examples/src/scenes/vehiclePlaygroundScene.ts
 * @desc The Phase 6 playground's wheel assemblies on the strict mock device (Phase 16.6)
 */

export const suite = {
  name: "examples:mechanicalScene",
  group: "integration",
  covers:   [
    "engine/src/core/engine.ts",
    "engine/src/core/log.ts",
    "engine/src/core/time.ts",
    "engine/src/debug/profiler.ts",
    "engine/src/gpu/device.ts",
    "engine/src/index.ts",
    "engine/src/math/mat.ts",
    "engine/src/math/vec.ts",
    "engine/src/rendering/renderer.ts",
    "engine/src/scene/components/index.ts",
    "engine/src/scene/entityId.ts",
    "engine/src/scene/systems.ts",
    "engine/src/vehicles/components.ts",
    "engine/src/vehicles/vehicle.ts",
    "examples/src/scenes/vehiclePlaygroundScene.ts"
  ],
  desc: "The Phase 6 playground's wheel assemblies on the strict mock device (Phase 16.6)",
};
/**
 * The Phase 6 playground's wheel assemblies on the strict mock device (Phase 16.6).
 *
 * The unit suites prove the rig's arithmetic and the vehicle binding in isolation; this pins the
 * *scene* wiring that would silently rot otherwise: the assembly hierarchy the demo builds actually
 * resolves through `createVehicleWheelRig`, the mechanical system poses it from wheel telemetry (or
 * from the gate's fixed override), the aim links point at the hub they claim to connect to, and the
 * renderer draws the result through the unskinned pipelines with no mock-device errors.
 *
 * Pixels are the browser gate's job (`npm run check:browser:mechanical`); this owns the assembly.
 */

import assert from "node:assert/strict";
import { afterEach, assertCloseTo, assertNotCloseTo, finish, group, stubGlobal, test, unstubAllGlobals } from "selrun";
import {
  Clock,
  GraphicsDevice,
  Logger,
  Profiler,
  Quat,
  Renderer,
  SystemScratch,
  Transform,
  Vec3,
  VehicleComponent,
  type Engine,
  type EntityId,
  type SystemContext,
  type Vehicle,
} from "@forge/engine";
import { buildVehiclePlaygroundScene } from "../../examples/src/scenes/vehiclePlaygroundScene.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  unstubAllGlobals();
});

async function fixture() {
  // The scene binds keyboard listeners on `window` and looks up its touch pad in `document`.
  stubGlobal("window", new EventTarget());
  stubGlobal("document", { getElementById: () => null });
  const gpu = await GraphicsDevice.create({ forceMock: true });
  const renderer = new Renderer(gpu);
  const engine = { gpu, stats: () => ({ render: renderer.stats }) } as unknown as Engine;
  const handle = buildVehiclePlaygroundScene(engine);
  const scene = handle.scene;
  scene.attachToEngine(engine);
  const context = {
    world: scene.world,
    clock: new Clock(),
    dt: 1 / 60,
    fixedDt: 1 / 60,
    fixedSteps: 1,
    alpha: 0,
    elapsed: 0,
    frame: 0,
    logger: new Logger(),
    profiler: new Profiler(),
    services: { get: () => undefined, engineConfig: {} },
    scratch: new SystemScratch(),
  } satisfies SystemContext;
  cleanups.push(async () => {
    handle.dispose?.();
    renderer.dispose();
    await gpu.dispose();
    assert.deepEqual(gpu.mock.outstanding.buffers, []);
    assert.deepEqual(gpu.mock.outstanding.textures, []);
  });
  const entity = (name: string): EntityId => {
    const id = scene.world.findByName(name)[0];
    assert.ok(id, `entity ${name}`);
    return id!;
  };
  const vehicle = scene.world.getComponent(entity("chassis"), VehicleComponent)!.vehicle;
  /**
   * One frame: the scene's own update (keys/touch), then an optional drive override — it has to come
   * after `handle.update`, which rewrites `vehicle.input` from the keyboard every frame — then the
   * standard `Scene.update` pass (systems → transforms).
   */
  const tick = (frames = 1, drive?: (v: Vehicle) => void): void => {
    for (let i = 0; i < frames; i++) {
      context.frame++;
      context.elapsed += context.dt;
      handle.update(context.dt);
      drive?.(vehicle);
      scene.update(context, context.dt);
    }
  };
  return { gpu, renderer, handle, scene, context, tick, entity, vehicle };
}

/** The local direction a rotation sends a unit axis to — what a link's geometry points along. */
function directionOf(rotation: Quat, axis = new Vec3(0, 0, 1)): Vec3 {
  return rotation.rotateVector(axis, new Vec3());
}

group("vehicle playground — mechanical wheel assemblies", () => {
  test("builds one 20-joint rig over four corners and draws the assemblies", async () => {
    const { gpu, renderer, scene, handle, entity, tick } = await fixture();
    const tickFixture = (): void => tick(1);
    // One frame first, so the source has written its channels.
    tickFixture();
    const mechanical = handle.vehicleState!().mechanical!;
    // travel + steer + spin + arm + shock per wheel.
    assert.equal(mechanical.joints, 20);
    // steer / spin / travel per wheel.
    assert.equal(mechanical.channels, 12);

    renderer.renderScene(scene);
    assert.deepEqual(gpu.mock.errors, []);
    assert.ok(renderer.stats.drawCalls > 0);
    for (const name of [
      "wheel-0-hub",
      "wheel-0-knuckle",
      "wheel-0-axle",
      "wheel-0-tyre",
      "wheel-0-upright",
      "wheel-3-shock",
      "wheel-3-arm-link",
    ]) {
      assert.equal(scene.world.hasComponent(entity(name), Transform), true);
    }
  });

  test("poses the hierarchy from wheel telemetry while the car drives", async () => {
    const { handle, scene, tick, entity, vehicle } = await fixture();
    handle.vehicleState!(); // the state path the browser gate reads
    tick(60, (v) => {
      v.input.throttle = 0.7;
      v.input.steer = 1;
    });

    assert.ok(Math.abs(vehicle.wheels[0]!.steerAngle) > 0.05);
    assert.ok(Math.abs(vehicle.wheels[0]!.spin) > 0.5);

    // The knuckle yaws with the wheel's own Ackermann angle.
    const knuckle = scene.world.getTRS(entity("wheel-0-knuckle")).rotation;
    const steered = directionOf(knuckle);
    const reference = directionOf(new Quat().setAxisAngle(new Vec3(0, 1, 0), vehicle.wheels[0]!.steerAngle));
    assertCloseTo(steered.x, reference.x, 4);
    assertCloseTo(steered.z, reference.z, 4);

    // The axle rolls at the odometer the tire integrated (left wheel: negated by the rig).
    const axle = scene.world.getTRS(entity("wheel-0-axle")).rotation;
    const rolled = directionOf(axle, new Vec3(0, 1, 0));
    assertCloseTo(rolled.y, Math.cos(vehicle.wheels[0]!.spin), 3);
    assertCloseTo(rolled.z, Math.sin(-vehicle.wheels[0]!.spin), 3);

    // The hub rides the compression the spring produced, at its own hardpoint.
    const hub = scene.world.getTRS(entity("wheel-0-hub")).position;
    assertCloseTo(hub.y, -vehicle.config.suspensionRest + vehicle.wheels[0]!.compression, 5);
    assertCloseTo(hub.x, vehicle.wheels[0]!.x, 5);
    assertCloseTo(hub.z, vehicle.wheels[0]!.z, 5);
  });

  test("aims the arm and damper at the hub, whatever the travel is", async () => {
    const { handle, scene, tick, entity } = await fixture();
    handle.setWheelOverride!({ steer: 0, travel: 0.12, spin: 0 });
    tick(20);

    const hubWorld = scene.world.worldPosition(entity("wheel-0-hub"));
    for (const link of ["wheel-0-arm", "wheel-0-shock"]) {
      const linkId = entity(link);
      const pivotWorld = scene.world.worldPosition(linkId);
      const toHub = hubWorld.clone().sub(pivotWorld).normalize();
      const points = directionOf(scene.world.getTRS(linkId).rotation);
      const dot = points.x * toHub.x + points.y * toHub.y + points.z * toHub.z;
      assert.ok(dot > 0.999, `${link} points at the hub`);
    }
    // The telescoping links stretch along their own axis only.
    const shockScale = scene.world.getTRS(entity("wheel-0-shock")).scale;
    assert.ok(shockScale.z > 0);
    assertCloseTo(shockScale.x, 1, 6);
    assertCloseTo(shockScale.y, 1, 6);

    // They follow the hub when the suspension moves: less compression drops the hub lower, and the
    // links stay aimed at it (the distance they have to cover changes with it).
    const lengthBefore = scene.world.worldPosition(entity("wheel-0-shock")).distanceTo(hubWorld);
    handle.setWheelOverride!({ steer: 0, travel: 0.02, spin: 0 });
    tick(20);
    const hubNow = scene.world.worldPosition(entity("wheel-0-hub"));
    const shockNow = scene.world.worldPosition(entity("wheel-0-shock"));
    assert.ok(hubNow.y < hubWorld.y);
    assertNotCloseTo(shockNow.distanceTo(hubNow), lengthBefore, 6);
    const toHubNow = hubNow.clone().sub(shockNow).normalize();
    const pointsNow = directionOf(scene.world.getTRS(entity("wheel-0-shock")).rotation);
    assert.ok(pointsNow.x * toHubNow.x + pointsNow.y * toHubNow.y + pointsNow.z * toHubNow.z > 0.999);
  });

  test("steers only the steered corners, like the per-wheel Ackermann solve", async () => {
    const { handle, tick, vehicle } = await fixture();
    handle.setWheelOverride!({ steer: 0.4, travel: 0.08, spin: 0 });
    tick(20);
    const mechanical = handle.vehicleState!().mechanical!;
    // FL/FR yaw; RL/RR hold zero so the rig reproduces the solver's decision, not a crab turn.
    assert.ok(Math.abs(mechanical.steer[0] - 0.4) < 1e-6);
    assert.ok(Math.abs(mechanical.steer[1] - 0.4) < 1e-6);
    assert.ok(Math.abs(mechanical.steer[2]) < 1e-6);
    assert.ok(Math.abs(mechanical.steer[3]) < 1e-6);
    assert.equal(vehicle.wheels[2]!.steered, false);
    // The front knuckles' slew had time to arrive, so nothing is saturated after 20 frames.
    assert.equal(mechanical.saturated.every((s) => s === false), true);
  });

  test("returns the assembly to telemetry when the override is cleared", async () => {
    const { handle, scene, tick, entity, vehicle } = await fixture();
    handle.setWheelOverride!({ steer: 0.3, travel: 0.14, spin: 2 });
    tick(20);
    assertCloseTo(scene.world.getTRS(entity("wheel-0-hub")).position.y, -vehicle.config.suspensionRest + 0.14, 4);
    assert.ok(Math.abs(scene.world.getTRS(entity("wheel-0-knuckle")).rotation.y) > 0.1);

    handle.setWheelOverride!(null);
    tick(30);
    const expected = -vehicle.config.suspensionRest + vehicle.wheels[0]!.compression;
    assertCloseTo(scene.world.getTRS(entity("wheel-0-hub")).position.y, expected, 5);
    // A parked car is not steering: the knuckle slew settles back to the telemetry's zero.
    assert.ok(Math.abs(scene.world.getTRS(entity("wheel-0-knuckle")).rotation.y) < 1e-4);
  });
});

await finish();
