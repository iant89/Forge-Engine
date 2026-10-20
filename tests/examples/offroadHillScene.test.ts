/**
 * @suite examples:offroadHillScene
 * @group integration
 * @covers engine/src/gpu/device.ts
 * @covers engine/src/index.ts
 * @covers engine/src/population/vegetation.ts
 * @covers engine/src/scene/world.ts
 * @covers engine/src/vehicles/components.ts
 * @covers engine/src/vehicles/drivetrain.ts
 * @covers engine/src/vehicles/system.ts
 * @covers engine/src/vehicles/vehicle.ts
 * @covers examples/src/scenes/offroadHillScene.ts
 * @desc Whole off-road hill demo on the strict mock GPU: the UTV's assembly and config, rate-limited driver input, braking and a handbrake slide, a forest that culls and stops casting shadows at range, the chase/in-cab cameras, course placement and weather, and leak-free disposal
 */

export const suite = {
  name: "examples:offroadHillScene",
  group: "integration",
  covers: [
    "engine/src/gpu/device.ts",
    "engine/src/index.ts",
    "engine/src/population/vegetation.ts",
    "engine/src/scene/world.ts",
    "engine/src/vehicles/components.ts",
    "engine/src/vehicles/drivetrain.ts",
    "engine/src/vehicles/system.ts",
    "engine/src/vehicles/vehicle.ts",
    "examples/src/scenes/offroadHillScene.ts",
  ],
  desc: "Whole off-road hill demo on the strict mock GPU: the UTV's assembly and config, rate-limited driver input, braking and a handbrake slide, a forest that culls and stops casting shadows at range, the chase/in-cab cameras, course placement and weather, and leak-free disposal",
};
import assert from "node:assert/strict";
import { afterEach, assertCloseTo, finish, group, spyFunction, stubGlobal, test, unstubAllGlobals } from "selrun";
import {
  Clock,
  GraphicsDevice,
  Logger,
  Profiler,
  Renderable,
  SystemScratch,
  VegetationField,
  VehicleComponent,
  type Engine,
  type SystemContext,
  type TaskScheduler,
} from "@forge/engine";
import { buildOffroadHillScene } from "../../examples/src/scenes/offroadHillScene.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  unstubAllGlobals();
});

async function fixture(options: { deviceTier?: "low" | "medium" | "high" } = {}) {
  const windowStub = new EventTarget();
  stubGlobal("window", windowStub);
  stubGlobal("document", { getElementById: () => null });
  stubGlobal("fetch", spyFunction(() => new Promise<Response>(() => {})));
  const gpu = await GraphicsDevice.create({ forceMock: true });
  const engine = { gpu, tasks: undefined as unknown as TaskScheduler } as Engine;
  const handle = buildOffroadHillScene(engine, { deviceTier: options.deviceTier ?? "low" });
  const scene = handle.scene;
  scene.attachToEngine(engine);
  const chassisId = scene.world.findByName("utv")[0]!;
  const component = scene.world.getComponent(chassisId, VehicleComponent)!;
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
    await gpu.dispose();
    assert.deepEqual(gpu.mock.outstanding.buffers, [], "every buffer is released");
    assert.deepEqual(gpu.mock.outstanding.textures, [], "every texture is released");
  });
  const tick = (count = 1): void => {
    for (let i = 0; i < count; i++) {
      context.frame++;
      context.elapsed += context.dt;
      handle.update(context.dt);
      scene.update(context, context.dt);
    }
  };
  const key = (type: "keydown" | "keyup", code: string): void => {
    windowStub.dispatchEvent(Object.assign(new Event(type), { code, repeat: false }));
  };
  return { handle, scene, component, vehicle: component.vehicle, chassisId, tick, key, gpu };
}

group("Off-road hill — the vehicle", () => {
  test("assembles the UTV's tub, cab and bed under one root, with four wheels as root entities", async () => {
    const { scene, vehicle, component, chassisId, tick } = await fixture();
    tick(3);
    const root = scene.world.facade(chassisId)!;
    const names = root.children.map((child) => child.name);
    for (const expected of ["utv-tub", "utv-hood", "utv-bed", "utv-roof", "utv-visor", "utv-dash", "utv-windscreen-frame", "utv-seat"]) {
      assert.ok(names.includes(expected), `${expected} is part of the body`);
    }
    assert.equal(names.filter((name) => name.startsWith("utv-pillar-")).length, 4, "four cab pillars");
    assert.ok(!names.some((name) => name.startsWith("quad-")), "the quad this demo briefly carried is gone");

    const config = vehicle.config;
    assertCloseTo(config.mass, 1250, 3);
    assertCloseTo(config.wheelbase, 2.35, 3);
    assertCloseTo(config.track, 1.45, 3);
    assertCloseTo(config.wheelRadius, 0.36, 3);
    assertCloseTo(config.cgHeight, 0.55, 3);
    assertCloseTo(config.suspensionRest, 0.36, 3, "long travel for a hill course");
    assertCloseTo(config.suspensionTravel, 0.22, 3);
    assertCloseTo(config.mu, 1.0, 3);
    assertCloseTo(config.rollingResistance, 0.03, 3);
    assert.equal(config.maxBrakeTorque, 3200);
    assert.equal(config.layout, "rwd");
    assert.equal(config.differential, "lsd");
    assert.equal(config.engine.redlineRpm, 6800, "the demo keeps the engine's default rev limit");
    assert.ok(config.transmission.ratios.length >= 4, `${config.transmission.ratios.length} forward ratios`);

    // Wheels are root entities: `VehicleSystem` writes world poses into them, so a wheel parented to
    // the chassis would be offset by the chassis's own pose (this is the bug the Alpine truck had).
    const wheelIds = component.wheelEntities;
    assert.equal(wheelIds.length, 4);
    const geometries = new Set<unknown>();
    for (let i = 0; i < wheelIds.length; i++) {
      const id = wheelIds[i]!;
      assert.equal(scene.world.facade(id)!.parent, null, `wheel ${i} has no parent`);
      const children = scene.world.facade(id)!.children;
      assert.equal(children.length, 2, `wheel ${i} is a tyre and a rim`);
      for (const child of children) {
        const renderable = child.get(Renderable)!;
        assert.ok(renderable, `${child.name} is drawn`);
        assert.equal(renderable.castShadow, true);
        geometries.add(renderable.geometry);
      }
    }
    assert.equal(geometries.size, 2, "all four wheels share one tyre geometry and one rim geometry");
    assert.ok(Math.hypot(vehicle.wheels[0]!.x, vehicle.wheels[0]!.z) > 1, "the hardpoints are a car's, not a quad's");
  });
});

group("Off-road hill — handling", () => {
  test("steering input is rate-limited toward lock and returns to centre faster", async () => {
    const { vehicle, tick, key } = await fixture();
    key("keydown", "KeyF");
    key("keydown", "KeyD");
    tick(1);
    // Digital keys used to give instant full lock, which is what made the vehicle dart.
    assert.ok(vehicle.input.steer > 0 && vehicle.input.steer < 0.25, `first frame of lock is ${vehicle.input.steer.toFixed(3)}, not 1`);
    let toLock = 0;
    while (vehicle.input.steer < 0.95 && toLock < 60) {
      tick(1);
      toLock++;
    }
    assert.ok(toLock >= 10 && toLock <= 30, `full lock takes ${toLock} frames (${(toLock / 60).toFixed(2)} s)`);
    key("keyup", "KeyD");
    tick(1);
    let toCentre = 0;
    while (Math.abs(vehicle.input.steer) > 0.05 && toCentre < 60) {
      tick(1);
      toCentre++;
    }
    assert.ok(toCentre > 0 && toCentre < toLock, `the wheel comes back in ${toCentre} frames, faster than the ${toLock} it took to turn it`);
    assert.ok(Math.abs(vehicle.wheels[0]!.steerAngle) <= vehicle.config.maxSteerAngle + 1e-9, "the steered wheels stay inside the config's lock");
  });

  test("throttle and brake ramp instead of snapping, and the vehicle pulls away", async () => {
    const { vehicle, handle, tick, key } = await fixture();
    key("keydown", "KeyF");
    key("keydown", "KeyW");
    tick(1);
    assert.ok(vehicle.input.throttle > 0 && vehicle.input.throttle < 0.35, `throttle opens at ${vehicle.input.throttle.toFixed(3)}`);
    tick(20);
    assert.ok(vehicle.input.throttle > 0.99, `throttle is wide open after 0.35 s (${vehicle.input.throttle.toFixed(3)})`);

    for (let i = 0; i < 180; i++) {
      tick(1);
      assert.ok(vehicle.rpm < vehicle.config.engine.redlineRpm, `the limiter holds: ${vehicle.rpm.toFixed(0)} rpm`);
    }
    key("keyup", "KeyW");
    assert.ok(vehicle.speed > 5, `it is away at ${(vehicle.speed * 3.6).toFixed(1)} km/h after 3.5 s`);
    assert.ok(vehicle.gear >= 1, `gear ${vehicle.gear}`);
    assertCloseTo(handle.snapshot().speedKph, vehicle.speed * 3.6, 3);
    assertCloseTo(handle.vehicleState!().x, vehicle.position.x, 3);
    assert.ok(handle.snapshot().lapTime >= 0);
  });

  test("the brakes stop it from speed, and the handbrake is stronger than the pedal", async () => {
    const { vehicle, tick, key } = await fixture();
    const config = vehicle.config;
    assert.ok(config.handbrakeTorque > config.maxBrakeTorque, "the handbrake out-brakes the pedal");
    assert.ok(config.parkingBrakeTorque >= config.handbrakeTorque, "park holds it on the hill");

    key("keydown", "KeyF");
    key("keydown", "KeyW");
    tick(150);
    const from = vehicle.position.clone();
    assert.ok(vehicle.speed > 5, `up to ${(vehicle.speed * 3.6).toFixed(1)} km/h first`);
    key("keyup", "KeyW");
    key("keydown", "KeyS");
    let frames = 0;
    let skidding = 0;
    while (vehicle.speed > 0.1 && frames < 900) {
      tick(1);
      frames++;
      // A wheel that is skidding is turning slower than the ground is moving under it.
      if (vehicle.wheels.some((w) => w.inContact && Math.abs(w.kappa) > 0.6)) skidding++;
    }
    key("keyup", "KeyS");
    const stoppingDistance = Math.hypot(vehicle.position.x - from.x, vehicle.position.z - from.z);
    assert.ok(frames > 20, `it takes ${(frames / 60).toFixed(2)} s to stop, not an instant`);
    assert.ok(stoppingDistance < 80, `stops in ${stoppingDistance.toFixed(1)} m`);
    assert.ok(skidding < frames, `ABS modulates instead of locking every wheel for the whole stop (${skidding}/${frames} frames skidding)`);
  });

  test("the handbrake slides the tail: the driven rears break away and the vehicle rotates", async () => {
    const { vehicle, tick, key } = await fixture();
    key("keydown", "KeyF");
    key("keydown", "KeyW");
    tick(120);
    key("keydown", "KeyD");
    tick(30);
    const yawBefore = vehicle.yaw;
    key("keydown", "Space");
    tick(45);
    key("keyup", "Space");
    key("keyup", "KeyD");
    key("keyup", "KeyW");
    const rears = vehicle.wheels.filter((w) => w.z < 0);
    assert.equal(rears.length, 2);
    assert.ok(rears.every((w) => w.driven), "the rears are the driven wheels");
    assert.ok(rears.every((w) => w.handbrake), "and the handbrake acts on them");
    assert.ok(Math.abs(vehicle.yaw - yawBefore) > 0.02, `it turned ${(Math.abs(vehicle.yaw - yawBefore) * 57.3).toFixed(1)}° through the slide`);
    assert.ok(vehicle.speed > 0.5, "and it is still moving, not spun to a stop");
  });
});

group("Off-road hill — the forest stops costing a frame", () => {
  test("trees and bushes cull by distance, and stop casting shadows well inside it", async () => {
    const { scene, tick } = await fixture();
    tick(8);
    const vegetation = scene.object<VegetationField>("offroad-vegetation")!;
    assert.ok(vegetation.count > 2000, `${vegetation.count} instances planted`);
    let casters = 0;
    for (const model of vegetation.models) {
      const casts = model.parts.some((part) => part.castShadow);
      if (!casts) continue;
      casters++;
      assert.ok(model.maxDistance > 0, `a shadow-casting model is drawn to ${model.maxDistance} m, not forever`);
      assert.ok(model.shadowDistance !== undefined && model.shadowDistance > 0, "and has a shadow ring");
      assert.ok(model.shadowDistance! < model.maxDistance, `shadows stop at ${model.shadowDistance} m, inside the ${model.maxDistance} m draw distance`);
      assert.ok((model.swayDistance ?? 0) <= model.maxDistance, "nothing sways that is not drawn");
      assert.ok(model.lodDistance < model.shadowDistance!, `the low model takes over at ${model.lodDistance} m, inside the ${model.shadowDistance} m shadow ring`);
    }
    assert.ok(casters >= 6, `${casters} shadow-casting models (trees and bushes)`);
    assert.ok(scene.settings.shadow.distance <= 70, `shadow range ${scene.settings.shadow.distance} m`);

    const stats = vegetation.stats_;
    assert.ok(stats.hidden > 500, `${stats.hidden} instances are hidden past their draw distance`);
    assert.ok(stats.casting > 0, `${stats.casting} instances still cast`);
    assert.ok(stats.casting < stats.hi + stats.lo, `only ${stats.casting} of ${stats.hi + stats.lo} drawn instances cast shadows`);

    // The point of the ring: the shadow pass used to walk every tree part in the world.
    const renderables = scene.world.store(Renderable);
    let visible = 0;
    let shadowCasters = 0;
    for (let i = 0; i < renderables.count; i++) {
      const r = renderables.valueAt(i)!;
      if (!r.visible) continue;
      visible++;
      if (r.castShadow) shadowCasters++;
    }
    assert.ok(visible > 200, `${visible} renderables are visible at the spawn`);
    assert.ok(shadowCasters < visible, `${shadowCasters} casters against ${visible} visible`);
    assert.ok(shadowCasters < 300, `the shadow pass walks ${shadowCasters} casters, not thousands`);
  });

  test("the snapshot reports the shadow ring alongside the LOD counts", async () => {
    const { handle, tick } = await fixture();
    tick(8);
    const state = handle.snapshot();
    assert.ok(state.vegetation.hidden > 0);
    assert.ok(typeof state.vegetation.casting === "number", "casting is part of the snapshot");
    assert.ok(state.vegetation.casting <= state.vegetation.hi + state.vegetation.lo);
    assert.ok(state.treeTriangles.hi > state.treeTriangles.lo, "the hi model is the detailed one");
    assert.equal(state.cameraMode, "chase");
  });
});

group("Off-road hill — camera", () => {
  test("the chase camera frames the machine and the in-cab view sits at the driver's eye", async () => {
    const { handle, vehicle, tick } = await fixture();
    assert.equal(handle.camera!.distance, 10);
    assert.equal(handle.camera!.minDistance, 3);
    assert.equal(handle.camera!.maxDistance, 80);
    tick(60);
    const chase = handle.cameraOverride!()!;
    const back = Math.hypot(chase.eye[0] - vehicle.position.x, chase.eye[2] - vehicle.position.z);
    assert.ok(back > 5.4 && back < 8.2, `the chase eye sits ${back.toFixed(2)} m behind the vehicle`);
    assert.ok(chase.eye[1] - vehicle.position.y > 1.8, `and ${(chase.eye[1] - vehicle.position.y).toFixed(2)} m above it`);
    assert.ok(chase.target[1] - vehicle.position.y > 0.6 && chase.target[1] - vehicle.position.y < 1.8, "looking at the cab, not over the trees");

    handle.setCameraMode("cab");
    const driver = handle.cameraOverride!()!;
    const eyeHeight = driver.eye[1] - vehicle.position.y;
    assert.ok(eyeHeight > 1.05 && eyeHeight < 1.45, `the driver's eye is ${eyeHeight.toFixed(2)} m above the chassis (under the roof, pitched with the hill)`);
    assert.ok(Math.hypot(driver.eye[0] - vehicle.position.x, driver.eye[2] - vehicle.position.z) < 0.6, "on the seat, not in the middle of the tub");
    handle.setCameraMode("orbit");
    assert.equal(handle.cameraOverride!(), null, "orbit hands the camera back to the controller");
    handle.setCameraMode("chase");
  });
});

group("Off-road hill — course and weather", () => {
  test("placing the vehicle on the course, the weather menu and the lap timer still work", async () => {
    const { handle, vehicle, tick } = await fixture();
    const start = handle.trackPoint(8, 0);
    handle.placeAt(8, 0);
    tick(4);
    const state = handle.snapshot();
    assert.ok(Math.hypot(state.x - start[0], state.z - start[2]) < 2, "placed on the course at the requested arc length");
    assert.ok(state.trackLength > 500, `the loop is ${(state.trackLength / 1000).toFixed(2)} km`);
    assert.ok(state.grip > 0.4 && state.grip <= 1.6, `grip under the vehicle is ${state.grip.toFixed(2)}`);

    const dry = handle.gripAt(8, 0);
    handle.setWeather("mud");
    tick(30);
    assert.equal(handle.snapshot().weather, "mud");
    assert.ok(handle.gripAt(8, 0) < dry, "mud is greasy where dry ground was not");
    handle.setWeather("snow");
    tick(30);
    assert.ok(handle.snapshot().surface.snow > 0, "snow settles on the ground field");
    handle.setWeather("clear");
    tick(30);

    // The lap timer arms when the vehicle crosses the start gate.
    handle.placeAt(16, 0);
    tick(10);
    handle.placeAt(24, 0);
    tick(10);
    assert.ok(handle.snapshot().running || handle.snapshot().progress > 0, "crossing the gate starts the lap");
    assert.ok(vehicle.speed < 1, "placing the vehicle brings it (almost) to rest");
  });
});

await finish();
