/**
 * @suite examples:alpineRescueScene
 * @group integration
 * @covers engine/src/gpu/device.ts
 * @covers engine/src/index.ts
 * @covers engine/src/scene/world.ts
 * @covers engine/src/terrain/trackGrading.ts
 * @covers engine/src/terrain/world.ts
 * @covers engine/src/vehicles/components.ts
 * @covers engine/src/vehicles/system.ts
 * @covers examples/src/scenes/alpineRescueScene.ts
 * @covers examples/src/scenes/alpineRescueVehicle.ts
 * @covers examples/src/scenes/alpineRoute.ts
 * @covers examples/src/scenes/alpineSnowpack.ts
 * @covers examples/src/scenes/alpineTerrain.ts
 * @covers examples/src/scenes/meshKit.ts
 * @covers examples/src/textures/alpine.ts
 * @desc Whole Alpine rescue scene on the strict mock GPU: mission flow, wheels riding the chassis, driving, storm → snow cover → grip, and leak-free disposal
 */

export const suite = {
  name: "examples:alpineRescueScene",
  group: "integration",
  covers: [
    "engine/src/gpu/device.ts",
    "engine/src/index.ts",
    "engine/src/scene/world.ts",
    "engine/src/terrain/trackGrading.ts",
    "engine/src/terrain/world.ts",
    "engine/src/vehicles/components.ts",
    "engine/src/vehicles/system.ts",
    "examples/src/scenes/alpineRescueScene.ts",
    "examples/src/scenes/alpineRescueVehicle.ts",
    "examples/src/scenes/alpineRoute.ts",
    "examples/src/scenes/alpineSnowpack.ts",
    "examples/src/scenes/alpineTerrain.ts",
    "examples/src/scenes/meshKit.ts",
    "examples/src/textures/alpine.ts",
  ],
  desc: "Whole Alpine rescue scene on the strict mock GPU: mission flow, wheels riding the chassis, driving, storm → snow cover → grip, and leak-free disposal",
};
import assert from "node:assert/strict";
import { afterEach, assertCloseTo, finish, group, spyFunction, stubGlobal, test, unstubAllGlobals } from "selrun";
import {
  Clock,
  GraphicsDevice,
  Light,
  Logger,
  Profiler,
  SystemScratch,
  TerrainWorld,
  TrackGradingGenerator,
  VegetationField,
  VehicleComponent,
  worldSurfaceGrip,
  type Engine,
  type SystemContext,
  type TaskScheduler,
} from "@forge/engine";
import { ALPINE_WEATHER, buildAlpineRescueScene } from "../../examples/src/scenes/alpineRescueScene.js";
import { ALPINE_SNOWPACK_INITIAL_DEPTH_M, alpineSnowCover01, alpineSnowShade01 } from "../../examples/src/scenes/alpineSnowpack.js";
import { RELAY_SITES, DEPOT_X, BASE_Z } from "../../examples/src/scenes/alpineRoute.js";

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
  const handle = buildAlpineRescueScene(engine, { deviceTier: options.deviceTier ?? "low" });
  const scene = handle.scene;
  scene.attachToEngine(engine);
  const truckId = scene.world.findByName("Alpine rescue 4x4")[0]!;
  const component = scene.world.getComponent(truckId, VehicleComponent)!;
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
  return { handle, scene, component, truckId, tick, key, gpu };
}

group("Alpine rescue — scene assembly", () => {
  test("builds the mission, the dynamic props and a graded, split-material terrain", async () => {
    const { handle, scene, tick } = await fixture();
    tick(3); // world transforms exist only once the scene has updated
    const state = handle.snapshot();
    assert.equal(state.stage, "load-kit");
    assert.ok(state.dynamicProps >= 8, `dynamic props ${state.dynamicProps}`);
    assert.ok(state.objectiveDistance <= 11, `starting cargo in reach (${state.objectiveDistance.toFixed(1)} m)`);
    const terrain = scene.object<TerrainWorld>("TerrainWorld")!;
    assert.ok(terrain.layeredMaterial, "four-layer splat terrain");
    assert.ok(terrain.pipeline.stages.some((stage) => stage instanceof TrackGradingGenerator), "the road is graded into the streamed chunks");
    assert.ok(scene.object<VegetationField>("alpine-vegetation")!.count > 50, "a spruce forest is planted");
  });

  test("the physics world holds the boulders, crates, case, chassis and terrain", async () => {
    const { handle, tick } = await fixture();
    tick(3);
    const state = handle.snapshot();
    assert.ok(state.physicsSteps >= 3);
    assert.ok(state.physicsBodies >= 20, `bodies ${state.physicsBodies}`);
  });
});

group("Alpine rescue — the truck", () => {
  test("wheels are root entities posed in world space and ride with the chassis", async () => {
    const { scene, component, truckId, tick } = await fixture();
    tick(45);
    const chassis = scene.world.worldPosition(truckId);
    const vehicle = component.vehicle;
    assertCloseTo(chassis.x, vehicle.position.x, 3);
    assert.equal(component.wheelEntities.length, 4);
    for (let i = 0; i < 4; i++) {
      const id = component.wheelEntities[i]!;
      assert.equal(scene.world.facade(id)!.parent, null, `wheel ${i} has no parent`);
      const p = scene.world.worldPosition(id);
      const wheel = vehicle.wheels[i]!;
      // Within a wheelbase of the chassis, and hanging below it: never hundreds of metres away.
      assert.ok(Math.hypot(p.x - chassis.x, p.z - chassis.z) < 1.9, `wheel ${i} horizontal offset ${Math.hypot(p.x - chassis.x, p.z - chassis.z).toFixed(2)}`);
      assert.ok(p.y < chassis.y && p.y > chassis.y - 0.7, `wheel ${i} hangs ${(chassis.y - p.y).toFixed(2)} m below the chassis`);
      assert.ok(Math.abs(Math.hypot(p.x - chassis.x, p.z - chassis.z) - Math.hypot(wheel.x, wheel.z)) < 0.1, `wheel ${i} sits at its hardpoint`);
    }
    // And the truck root owns no wheel entities as children.
    const root = scene.world.facade(truckId)!;
    assert.ok(root.children.every((child) => !child.name.startsWith("Rescue wheel")));
  });

  test("builds the body, lamps, a tailgate spare and two spot headlamps under one root", async () => {
    const { scene, truckId } = await fixture();
    const root = scene.world.facade(truckId)!;
    const names = root.children.map((child) => child.name);
    for (const expected of ["Rescue 4x4 paint", "Rescue 4x4 glass", "Rescue light bar", "Rescue red flasher", "Rescue blue flasher", "Rescue spare wheel"]) {
      assert.ok(names.includes(expected), `${expected} is part of the truck`);
    }
    const spots = root.children.map((child) => child.get(Light)).filter((light): light is Light => light?.kind === "spot");
    assert.equal(spots.length, 2);
  });

  test("starts on the road in Neutral facing along it, then drives forward under throttle once shifted to F", async () => {
    const { handle, component, tick, key } = await fixture();
    tick(30);
    const start = handle.snapshot();
    assert.equal(start.gear, 0, "starts in Neutral (N)");
    assert.equal(start.speedKph < 1, true, "holds still until the driver asks");
    assert.equal(handle.setGear("F"), true);
    assert.equal(handle.snapshot().gear, 1);
    key("keydown", "KeyW");
    tick(240);
    key("keyup", "KeyW");
    const driven = handle.snapshot();
    assert.ok(driven.positionZ > start.positionZ + 3, `drove ${(driven.positionZ - start.positionZ).toFixed(1)} m`);
    assert.ok(driven.speedKph > 3, `speed ${driven.speedKph.toFixed(1)} km/h`);
    assert.ok(component.vehicle.wheels.some((wheel) => wheel.inContact));
    for (let i = 0; i < 4; i++) assert.ok(Math.abs(component.vehicle.wheels[i]!.spin) > 0.5 || component.vehicle.wheels[i]!.omega !== 0, `wheel ${i} turns`);
  });

  test("F - N - R shifter grinds on rolling F -> R and locks rear wheels on rolling-back R -> F", async () => {
    const { handle, component, tick, key } = await fixture();
    tick(10);
    assert.equal(handle.snapshot().gear, 0);
    handle.setGear("F");
    key("keydown", "KeyW");
    tick(120);
    key("keyup", "KeyW");
    assert.ok(component.vehicle.forwardSpeed > 1, "rolling forward in F");

    handle.setGear("R");
    assert.equal(handle.snapshot().gear, -1);
    assert.equal(handle.snapshot().grinding, true, "grinds when shifted to R while rolling forward");
    tick(95);
    assert.equal(handle.snapshot().grinding, false, "grind finishes once R gear engages");

    key("keydown", "KeyW");
    tick(120);
    key("keyup", "KeyW");
    assert.ok(component.vehicle.forwardSpeed < -1, "rolling backward in R");

    handle.setGear("F");
    assert.equal(handle.snapshot().gear, 1);
    assert.equal(handle.snapshot().rearWheelLock, true, "locks rear wheels when shifted to F while rolling back");
    tick(10);
    for (let i = 0; i < component.vehicle.wheels.length; i++) {
      const w = component.vehicle.wheels[i]!;
      if (component.vehicle.isRearWheel(i)) {
        assert.equal(w.omega, 0, `rear wheel ${i} locked until throttle`);
      }
    }
    key("keydown", "KeyW");
    tick(5);
    key("keyup", "KeyW");
    assert.equal(handle.snapshot().rearWheelLock, false, "pressing gas releases rear wheel lock");
  });
});

group("Alpine rescue — mission, weather and controls", () => {
  test("plays the whole mission: load the kit, light two relays, deliver, return", async () => {
    const { handle, component, tick } = await fixture();
    tick(3);
    const at = (x: number, z: number): void => {
      component.vehicle.position.set(x, component.vehicle.position.y, z);
      tick(2);
    };
    assert.equal(handle.interact(), true);
    assertMission(handle.snapshot(), { stage: "relay-1", cargoLoaded: true });
    at(RELAY_SITES[0].x, RELAY_SITES[0].z);
    assert.equal(handle.interact(), true);
    assertMission(handle.snapshot(), { stage: "relay-2", beaconsActivated: 1, weatherTarget: "storm" });
    assert.equal(handle.interact(), false, "out of reach of the second relay");
    at(RELAY_SITES[1].x, RELAY_SITES[1].z);
    assert.equal(handle.interact(), true);
    at(RELAY_SITES[2].x, RELAY_SITES[2].z);
    assert.equal(handle.interact(), true);
    assertMission(handle.snapshot(), { stage: "return", beaconsActivated: 3, cargoDelivered: true, cargoLoaded: false });
    at(DEPOT_X, BASE_Z);
    assert.equal(handle.interact(), true);
    assertMission(handle.snapshot(), { stage: "complete", complete: true, parked: true });
    assert.equal(handle.interact(), false);
  });

  test("a storm buries the route in engine snow cover and the tyres lose grip", async () => {
    const { handle, scene, tick, key } = await fixture();
    tick(30);
    const calm = handle.snapshot();
    assert.equal(calm.weatherTarget, "overcast");
    assert.ok(calm.temperatureC < 0, "winter air is below freezing");
    assertCloseTo(calm.snowCover, alpineSnowCover01(ALPINE_SNOWPACK_INITIAL_DEPTH_M), 2);
    // The renderer is given the remapped shade; the raw cover is what the grip factor reads.
    assertCloseTo(scene.settings.surface.snow, alpineSnowShade01(calm.snowCover), 2);
    const gripBefore = worldSurfaceGrip(scene.world)!;
    key("keydown", "KeyG");
    key("keyup", "KeyG");
    tick(600);
    const storm = handle.snapshot();
    assert.equal(storm.weatherTarget, "storm");
    assert.ok(storm.weatherIntensity > 0.99);
    assert.ok(storm.snowpackDepthM > calm.snowpackDepthM + 0.02, "the pack deepens");
    assert.ok(storm.snowCover > calm.snowCover);
    assertCloseTo(scene.settings.surface.snow, alpineSnowShade01(storm.snowCover), 2);
    assert.ok(storm.temperatureC < calm.temperatureC, "the storm is colder");
    assert.ok(worldSurfaceGrip(scene.world)! < gripBefore, "snow cover lowers the tyre-grip factor");
    // Press G again to calm it: the target flips back; snow stays where it fell (it is below zero).
    key("keydown", "KeyG");
    assert.equal(handle.snapshot().weatherTarget, "clear");
  });

  test("the weather states keep the air below freezing, so snow lies instead of melting", () => {
    for (const [name, state] of Object.entries(ALPINE_WEATHER)) assert.ok((state.temperatureC ?? 0) < 0, `${name} is below freezing`);
    assert.ok(ALPINE_WEATHER.storm.precipitation01! > ALPINE_WEATHER.rain.precipitation01!);
    assert.ok(ALPINE_WEATHER.rain.precipitation01! > ALPINE_WEATHER.overcast.precipitation01!);
  });

  test("headlights, parking brake and the teleport hook work", async () => {
    const { handle, component, tick, key } = await fixture();
    assert.equal(handle.snapshot().headlightsOn, true);
    key("keydown", "KeyF");
    assert.equal(handle.snapshot().headlightsOn, false);
    key("keydown", "KeyP");
    assert.equal(handle.snapshot().parked, true);
    handle.placeTruck(120, 0);
    tick(5);
    const after = handle.snapshot();
    assert.ok(after.positionZ > -120 && after.positionZ < 140, `parked on the road at z=${after.positionZ.toFixed(1)}`);
    assertCloseTo(component.vehicle.velocity.x, 0, 1);
  });

  test("a low tier plants a lighter forest than a high tier", async () => {
    const low = await fixture({ deviceTier: "low" });
    const high = await fixture({ deviceTier: "high" });
    assert.ok(high.handle.snapshot().trees > low.handle.snapshot().trees);
  });
});

function assertMission(state: object, expected: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(expected)) assert.equal((state as Record<string, unknown>)[key], value, key);
}

await finish();
