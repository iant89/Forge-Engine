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
 * @covers examples/src/scenes/meshKit.ts
 * @covers examples/src/scenes/offroadHillScene.ts
 * @covers examples/src/scenes/offroadQuad.ts
 * @desc Whole off-road hill demo on the strict mock GPU: the two-stroke quad and its gearing, rate-limited handlebars, brakes that do not grab, a forest that culls and stops casting shadows at range, the rider camera, and leak-free disposal
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
    "examples/src/scenes/meshKit.ts",
    "examples/src/scenes/offroadHillScene.ts",
    "examples/src/scenes/offroadQuad.ts",
  ],
  desc: "Whole off-road hill demo on the strict mock GPU: the two-stroke quad and its gearing, rate-limited handlebars, brakes that do not grab, a forest that culls and stops casting shadows at range, the rider camera, and leak-free disposal",
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
  type Geometry,
  type SystemContext,
  type TaskScheduler,
} from "@forge/engine";
import { buildOffroadHillScene } from "../../examples/src/scenes/offroadHillScene.js";
import { allQuadBodySources, buildQuadSources, QUAD_FRONT_TYRE_WIDTH, QUAD_REAR_TYRE_WIDTH } from "../../examples/src/scenes/offroadQuad.js";
import { signedVolume } from "../../examples/src/scenes/meshKit.js";

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
  const chassisId = scene.world.findByName("quad")[0]!;
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

/** Axis-aligned bounds of a geometry source's positions. */
function bounds(positions: Float32Array): { min: number[]; max: number[] } {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k]!, positions[i + k]!);
      max[k] = Math.max(max[k]!, positions[i + k]!);
    }
  }
  return { min, max };
}

group("Off-road hill — the quad", () => {
  test("carries a two-stroke sport quad: six body draws, four wheels, and the spec that goes with them", async () => {
    const { scene, vehicle, component, chassisId, tick } = await fixture();
    tick(3);
    const root = scene.world.facade(chassisId)!;
    const names = root.children.map((child) => child.name);
    for (const expected of ["quad-plastic", "quad-trim", "quad-steel", "quad-engine", "quad-exhaust", "quad-lamps"]) {
      assert.ok(names.includes(expected), `${expected} is one of the quad's body draws`);
    }
    assert.ok(!names.some((name) => name.startsWith("utv-")), "the UTV tub, cab and bed are gone");

    const config = vehicle.config;
    assertCloseTo(config.mass, 265, 3, "quad and rider");
    assertCloseTo(config.wheelbase, 1.28, 3);
    assertCloseTo(config.track, 0.98, 3);
    assertCloseTo(config.wheelRadius, 0.27, 3);
    assertCloseTo(config.cgToFront, 0.6, 3, "a rider sits behind the bars, so the CG is ahead of mid-wheelbase");
    assert.equal(config.layout, "awd");
    assert.equal(config.differential, "lsd");
    // Short wheelbase, tall rider: the mass-scaled car inertias would have made it steer like a barge.
    assert.ok(config.inertiaYaw < 100, `yaw inertia ${config.inertiaYaw}`);
    assert.ok(config.inertiaRoll < config.inertiaPitch, `roll ${config.inertiaRoll} < pitch ${config.inertiaPitch}`);
    assert.ok(config.angularDamping > 2, `angular damping ${config.angularDamping}`);

    // Wheels are root entities (the vehicle system poses them in world space), each with a tyre, a
    // rim and a brake disc, and the fronts are narrower than the rears.
    const wheelIds = component.wheelEntities;
    assert.equal(wheelIds.length, 4);
    const tyres = new Map<number, Geometry>();
    for (let i = 0; i < wheelIds.length; i++) {
      const id = wheelIds[i]!;
      assert.equal(scene.world.facade(id)!.parent, null, `wheel ${i} has no parent`);
      const children = scene.world.facade(id)!.children;
      assert.deepEqual(children.map((child) => child.name).sort(), [`quad-wheel-${i}-brake`, `quad-wheel-${i}-rim`, `quad-wheel-${i}-tyre`]);
      for (const child of children) assert.ok(child.get(Renderable), `${child.name} is drawn`);
      tyres.set(i, children.find((child) => child.name.endsWith("-tyre"))!.get(Renderable)!.geometry!);
    }
    // Fronts share one tyre geometry with the other front, rears with the other rear — and the
    // front assembly is the narrower one, so the two are not interchangeable.
    const front = vehicle.wheels.findIndex((w) => w.z > 0);
    const rear = vehicle.wheels.findIndex((w) => w.z < 0);
    assert.equal(tyres.get(front), tyres.get(vehicle.wheels.findIndex((w) => w.z > 0 && w.x !== vehicle.wheels[front]!.x)), "one front tyre assembly");
    assert.notEqual(tyres.get(front), tyres.get(rear), "front and rear wheels are different assemblies");
  });

  test("the engine is a two-stroke band: soft below it, a hit through it, nothing at the limiter", async () => {
    const { vehicle } = await fixture();
    const engine = vehicle.config.engine;
    assert.equal(engine.idleRpm, 1900);
    assert.equal(engine.redlineRpm, 9500);
    const at = (rpm: number): number => {
      engine.rpm = rpm;
      return engine.deliveredTorque();
    };
    const saved = engine.throttle;
    engine.throttle = 1;
    const soft = at(2500);
    const peak = at(7600);
    const tail = at(9000);
    const limiter = at(9600);
    engine.throttle = saved;
    engine.rpm = 0;
    assert.ok(peak > soft * 1.5, `the band hits: ${peak.toFixed(1)} N·m at 7600 rpm against ${soft.toFixed(1)} at 2500`);
    assert.ok(tail < peak, `${tail.toFixed(1)} N·m at 9000 rpm is past peak`);
    assert.equal(limiter, 0, "the rev limiter cuts it");
  });

  test("the close-ratio box drops the crank back into the band on every upshift", async () => {
    const { vehicle } = await fixture();
    const box = vehicle.config.transmission;
    assert.equal(box.ratios.length, 5, "five forward speeds");
    assert.equal(box.upshiftRpm, 9000);
    assert.equal(box.downshiftRpm, 5600);
    for (let i = 1; i < box.ratios.length; i++) {
      const rpmAfter = (box.upshiftRpm * box.ratios[i]!) / box.ratios[i - 1]!;
      assert.ok(rpmAfter > box.downshiftRpm, `shift ${i}→${i + 1} lands at ${rpmAfter.toFixed(0)} rpm, still inside the band`);
    }
    // Overall spread: 1st has to launch a 265 kg quad up a hill, 5th has to be usable on the flat.
    const first = box.ratios[0]! * box.finalDrive;
    const top = box.ratios[box.ratios.length - 1]! * box.finalDrive;
    assert.ok(first / top > 2, `overall spread ${(first / top).toFixed(2)}`);
  });
});

group("Off-road hill — handling", () => {
  test("handlebar input is rate-limited toward lock and returns to centre faster", async () => {
    const { vehicle, tick, key } = await fixture();
    key("keydown", "KeyF");
    key("keydown", "KeyD");
    tick(1);
    // Digital keys used to give instant full lock, which is what made the quad dart.
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
    assert.ok(toCentre > 0 && toCentre < toLock, `the bars come back in ${toCentre} frames, faster than the ${toLock} it took to turn them`);
  });

  test("throttle and brake ramp instead of snapping, and the quad pulls away in the band", async () => {
    const { vehicle, handle, tick, key } = await fixture();
    key("keydown", "KeyF");
    key("keydown", "KeyW");
    tick(1);
    assert.ok(vehicle.input.throttle > 0 && vehicle.input.throttle < 0.35, `throttle opens at ${vehicle.input.throttle.toFixed(3)}`);
    tick(20);
    assert.ok(vehicle.input.throttle > 0.99, `throttle is wide open after 0.35 s (${vehicle.input.throttle.toFixed(3)})`);

    let peakRpm = 0;
    for (let i = 0; i < 180; i++) {
      tick(1);
      peakRpm = Math.max(peakRpm, vehicle.rpm);
      assert.ok(vehicle.rpm < vehicle.config.engine.redlineRpm, `the limiter holds: ${vehicle.rpm.toFixed(0)} rpm`);
    }
    key("keyup", "KeyW");
    assert.ok(vehicle.speed > 4, `it is away at ${(vehicle.speed * 3.6).toFixed(1)} km/h after 3.5 s`);
    assert.ok(vehicle.gear >= 1, `gear ${vehicle.gear}`);
    assert.ok(peakRpm > 6000, `it spent time in the powerband (peak ${peakRpm.toFixed(0)} rpm)`);
    assertCloseTo(handle.snapshot().speedKph, vehicle.speed * 3.6, 3);
    assertCloseTo(handle.vehicleState!().x, vehicle.position.x, 3);
  });

  test("the brakes are scaled to a 265 kg quad: they stop it without grabbing", async () => {
    const { vehicle, tick, key } = await fixture();
    const config = vehicle.config;
    // A car-scale brake torque (4500 N·m) locked all four 0.27 m wheels the instant the pedal was
    // touched, which read as "the brakes grab". Scaled to the quad, the tyres saturate first.
    assert.ok(config.maxBrakeTorque < 2 * config.mass, `brake torque ${config.maxBrakeTorque} N·m for ${config.mass} kg`);
    assert.ok(config.maxBrakeTorque * 4 / config.wheelRadius < 6 * config.mass * 9.81, "four wheels cannot out-brake the tyres' grip");
    assert.ok(config.handbrakeTorque > config.maxBrakeTorque, "the handbrake out-brakes the pedal");
    assert.ok(config.parkingBrakeTorque >= config.handbrakeTorque, "park holds it on the hill");

    key("keydown", "KeyF");
    key("keydown", "KeyW");
    tick(150);
    const from = vehicle.position.clone();
    assert.ok(vehicle.speed > 4, `up to ${(vehicle.speed * 3.6).toFixed(1)} km/h first`);
    key("keyup", "KeyW");
    key("keydown", "KeyS");
    let frames = 0;
    let locked = 0;
    while (vehicle.speed > 0.1 && frames < 600) {
      tick(1);
      frames++;
      // A wheel that is skidding is turning slower than the ground is moving under it.
      if (vehicle.wheels.some((w) => w.inContact && Math.abs(w.kappa) > 0.6)) locked++;
    }
    key("keyup", "KeyS");
    const stoppingDistance = Math.hypot(vehicle.position.x - from.x, vehicle.position.z - from.z);
    assert.ok(frames > 20, `it takes ${(frames / 60).toFixed(2)} s to stop, not an instant`);
    assert.ok(stoppingDistance < 40, `stops in ${stoppingDistance.toFixed(1)} m`);
    assert.ok(locked < frames * 0.9, `wheels are not simply locked for the whole stop (${locked}/${frames} frames skidding)`);
  });

  test("the handbrake slides the tail: the rear wheels break away and the quad rotates", async () => {
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
    const rear = vehicle.wheels.filter((w) => w.z < 0);
    assert.ok(rear.length === 2 && rear.every((w) => w.driven), "both rears are driven");
    assert.ok(Math.abs(vehicle.yaw - yawBefore) > 0.02, `the quad turned ${(Math.abs(vehicle.yaw - yawBefore) * 57.3).toFixed(1)}° through the slide`);
    assert.ok(vehicle.speed > 0.5, "and it is still moving, not spun to a stop");
  });
});

group("Off-road hill — the forest stops costing a frame", () => {
  test("trees and bushes cull by distance, and stop casting shadows well inside it", async () => {
    const { scene, tick } = await fixture();
    tick(8);
    const vegetation = scene.object<VegetationField>("offroad-vegetation")!;
    assert.ok(vegetation.count > 2000, `${vegetation.count} instances planted`);
    let trees = 0;
    for (const model of vegetation.models) {
      const casts = model.parts.some((part) => part.castShadow);
      if (!casts) continue;
      trees++;
      assert.ok(model.maxDistance > 0, `a shadow-casting model is drawn to ${model.maxDistance} m, not forever`);
      assert.ok(model.shadowDistance !== undefined && model.shadowDistance > 0, "and has a shadow ring");
      assert.ok(model.shadowDistance! < model.maxDistance, `shadows stop at ${model.shadowDistance} m, inside the ${model.maxDistance} m draw distance`);
      assert.ok((model.swayDistance ?? 0) <= model.maxDistance, "nothing sways that is not drawn");
      assert.ok(model.lodDistance < model.shadowDistance!, `the low model takes over at ${model.lodDistance} m, inside the ${model.shadowDistance} m shadow ring`);
    }
    assert.ok(trees >= 6, `${trees} shadow-casting models (trees and bushes)`);
    assert.ok(scene.settings.shadow.distance <= 70, `shadow range ${scene.settings.shadow.distance} m`);

    const stats = vegetation.stats_;
    assert.ok(stats.hidden > 500, `${stats.hidden} instances are hidden past their draw distance`);
    assert.ok(stats.casting > 0, `${stats.casting} instances still cast`);
    assert.ok(stats.casting < stats.hi + stats.lo, `only ${stats.casting} of ${stats.hi + stats.lo} drawn instances cast shadows`);

    // The point of the ring: the shadow pass used to walk every tree part in the world.
    const renderables = scene.world.store(Renderable);
    let visible = 0;
    let casters = 0;
    for (let i = 0; i < renderables.count; i++) {
      const r = renderables.valueAt(i)!;
      if (!r.visible) continue;
      visible++;
      if (r.castShadow) casters++;
    }
    assert.ok(visible > 200, `${visible} renderables are visible at the spawn`);
    assert.ok(casters < visible, `${casters} casters against ${visible} visible`);
    assert.ok(casters < 300, `the shadow pass walks ${casters} casters, not thousands`);
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
  test("the chase camera fits a 2 m machine and the rider view sits at the rider's eye", async () => {
    const { handle, vehicle, tick } = await fixture();
    assert.equal(handle.camera!.distance, 7);
    assert.equal(handle.camera!.minDistance, 2);
    assert.equal(handle.camera!.maxDistance, 40);
    tick(60);
    const chase = handle.cameraOverride!()!;
    const back = Math.hypot(chase.eye[0] - vehicle.position.x, chase.eye[2] - vehicle.position.z);
    assert.ok(back > 3.4 && back < 5.6, `the chase eye sits ${back.toFixed(2)} m behind the quad`);
    assert.ok(chase.eye[1] - vehicle.position.y > 1.2, `and ${(chase.eye[1] - vehicle.position.y).toFixed(2)} m above it`);
    assert.ok(chase.target[1] - vehicle.position.y > 0.4 && chase.target[1] - vehicle.position.y < 1.6, "looking at the rider, not over the trees");

    handle.setCameraMode("cab");
    const rider = handle.cameraOverride!()!;
    const eyeHeight = rider.eye[1] - vehicle.position.y;
    assert.ok(eyeHeight > 0.85 && eyeHeight < 1.05, `the rider's eye is ${eyeHeight.toFixed(2)} m above the chassis (a seated rider, pitched with the hill)`);
    assert.ok(Math.hypot(rider.eye[0] - vehicle.position.x, rider.eye[2] - vehicle.position.z) < 0.6, "on the seat, not in the middle of the tank");
    assert.ok(rider.target[1] < rider.eye[1], "looking slightly down the trail");
    handle.setCameraMode("orbit");
    assert.equal(handle.cameraOverride!(), null, "orbit hands the camera back to the controller");
    handle.setCameraMode("chase");
  });
});

group("Off-road hill — course and weather", () => {
  test("placing the quad on the course, the weather menu and the lap timer still work", async () => {
    const { handle, vehicle, tick } = await fixture();
    const start = handle.trackPoint(8, 0);
    handle.placeAt(8, 0);
    tick(4);
    const state = handle.snapshot();
    assert.ok(Math.hypot(state.x - start[0], state.z - start[2]) < 2, "placed on the course at the requested arc length");
    assert.ok(state.trackLength > 500, `the loop is ${(state.trackLength / 1000).toFixed(2)} km`);
    assert.ok(state.grip > 0.4 && state.grip <= 1.6, `grip under the quad is ${state.grip.toFixed(2)}`);

    const sun = handle.gripAt(8, 0);
    handle.setWeather("mud");
    tick(30);
    assert.equal(handle.snapshot().weather, "mud");
    assert.ok(handle.gripAt(8, 0) < sun, "mud is greasy where sun was not");
    handle.setWeather("snow");
    tick(30);
    assert.ok(handle.snapshot().surface.snow > 0, "snow settles on the ground field");
    handle.setWeather("clear");
    tick(30);

    // The lap timer arms when the quad crosses the start gate.
    handle.placeAt(16, 0);
    tick(10);
    handle.placeAt(24, 0);
    tick(10);
    assert.ok(handle.snapshot().running || handle.snapshot().progress > 0, "crossing the gate starts the lap");
    assert.ok(vehicle.speed < 1, "placing the quad brings it (almost) to rest");
  });
});

group("Off-road quad geometry", () => {
  const spec = {
    wheelbase: 1.28,
    track: 0.98,
    wheelRadius: 0.27,
    hubDrop: 0.1975,
    cgToFront: 0.6,
    frontTyreWidth: QUAD_FRONT_TYRE_WIDTH,
    rearTyreWidth: QUAD_REAR_TYRE_WIDTH,
  };

  test("every source is a complete mesh, and the whole machine stays inside a triangle budget", () => {
    const quad = buildQuadSources(spec);
    let triangles = 0;
    for (const source of allQuadBodySources(quad)) {
      const n = source.positions.length / 3;
      assert.equal(source.normals!.length, n * 3, `${source.label} normals`);
      assert.equal(source.uvs!.length, n * 2, `${source.label} uvs`);
      assert.equal(source.tangents!.length, n * 4, `${source.label} tangents`);
      triangles += source.indices!.length / 3;
    }
    // Rounded boxes are ~300 triangles each; 30 tyre lugs a wheel built that way put the quad at
    // 32k. Boxes for the lugs, spokes, pegs and plates bring the whole machine back under budget.
    assert.ok(triangles > 4000, `${triangles} triangles is too little detail`);
    assert.ok(triangles < 15000, `${triangles} triangles for one quad`);
  });

  test("every part is finite, closed and outward-facing", () => {
    const quad = buildQuadSources(spec);
    for (const [name, source] of Object.entries(quad.body)) {
      const vertices = source.positions.length / 3;
      assert.ok(vertices > 8, `${name} has geometry`);
      assert.equal(source.indices!.length % 3, 0, `${name} is triangles`);
      for (let i = 0; i < vertices; i++) {
        for (let k = 0; k < 3; k++) assert.ok(Number.isFinite(source.positions[i * 3 + k]!), `${name} position ${i}.${k}`);
        const length = Math.hypot(source.normals![i * 3]!, source.normals![i * 3 + 1]!, source.normals![i * 3 + 2]!);
        assert.ok(Math.abs(length - 1) < 1e-3, `${name} normal ${i} is unit length (${length.toFixed(4)})`);
      }
      for (const index of source.indices!) assert.ok(index >= 0 && index < vertices, `${name} index ${index} in range`);
      assert.ok(signedVolume(source) > 0, `${name} faces outward`);
    }
  });

  test("the wheels are the width of their tyres, the fenders clear them, and nothing hangs under the ground", () => {
    const quad = buildQuadSources(spec);
    const front = bounds(quad.wheelFront.tyre.positions);
    const rear = bounds(quad.wheelRear.tyre.positions);
    assertCloseTo(front.max[0]! - front.min[0]!, QUAD_FRONT_TYRE_WIDTH, 3, "front tyre width");
    assertCloseTo(rear.max[0]! - rear.min[0]!, QUAD_REAR_TYRE_WIDTH, 3, "rear tyre width");
    // Wheels are built about their own origin with the axle along +X, so the vehicle system can
    // pose them directly (no lay-down rotation, and left wheels mirror to put the dish outboard).
    for (const wheel of [quad.wheelFront, quad.wheelRear]) {
      const tyre = bounds(wheel.tyre.positions);
      const radius = Math.max(Math.abs(tyre.min[1]!), Math.abs(tyre.max[1]!));
      assert.ok(radius > spec.wheelRadius && radius < spec.wheelRadius + 0.05, `tread radius ${radius.toFixed(3)} m over a ${spec.wheelRadius} m rim`);
      assertCloseTo(tyre.min[1]!, -tyre.max[1]!, 3, "the tyre is centred on the axle");
      assert.ok(bounds(wheel.rim.positions).max[0]! <= tyre.max[0]!, "the rim sits inside the tyre");
    }

    const whole = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
    for (const source of Object.values(quad.body)) {
      const b = bounds(source.positions);
      for (let k = 0; k < 3; k++) {
        whole.min[k] = Math.min(whole.min[k]!, b.min[k]!);
        whole.max[k] = Math.max(whole.max[k]!, b.max[k]!);
      }
    }
    assert.ok(whole.min[1]! > quad.dims.groundY, `the body clears the ground plane (${whole.min[1]!.toFixed(3)} > ${quad.dims.groundY.toFixed(3)})`);
    assertCloseTo(quad.dims.groundY, -(spec.hubDrop + spec.wheelRadius), 4, "ground is a hub drop and a wheel radius below the chassis");
    assert.ok(quad.dims.length > 1.7 && quad.dims.length < 2.2, `overall length ${quad.dims.length.toFixed(2)} m`);
    assert.ok(quad.dims.width > spec.track && quad.dims.width < spec.track + 0.4, `overall width ${quad.dims.width.toFixed(2)} m`);
    assert.ok(whole.max[1]! < quad.dims.barY + 0.12, `nothing towers over the bars (${whole.max[1]!.toFixed(3)})`);
    assert.ok(quad.dims.riderEye[1] > quad.dims.seatY, "the rider's eye is above the seat");
    assert.ok(quad.dims.riderEye[2] < 0, "and behind the bars");
    assert.ok(quad.dims.headlamp[2] > quad.dims.halfLength * 0.35, "the headlight pod is ahead of the front axle");
    assert.ok(quad.dims.taillamp[2] < -quad.dims.halfLength * 0.8, "the tail lamp is at the back");
    assert.ok(quad.dims.exhaustTip[0] > 0, "the pipe exits on the right, clear of the chain side");
  });

  test("the geometry follows the spec it is given", () => {
    const quad = buildQuadSources(spec);
    const wide = buildQuadSources({ ...spec, track: spec.track + 0.2, rearTyreWidth: spec.rearTyreWidth + 0.06 });
    assert.ok(wide.dims.width > quad.dims.width + 0.2, `a wider track is a wider quad (${wide.dims.width.toFixed(2)} vs ${quad.dims.width.toFixed(2)})`);
    const tall = buildQuadSources({ ...spec, hubDrop: spec.hubDrop + 0.1 });
    assertCloseTo(quad.dims.groundY - tall.dims.groundY, 0.1, 4, "a longer suspension drops the ground plane");
    // The body is authored off the ground plane, so a longer suspension lifts the chassis and drops
    // the ground with it: the seat stays the same height above the ground.
    assertCloseTo(tall.dims.seatY - tall.dims.groundY, quad.dims.seatY - quad.dims.groundY, 4, "seat height above the ground is set by the body, not the suspension");
    assert.ok(tall.dims.barY - tall.dims.groundY > 0.9, "the bars stay at riding height");
  });
});

await finish();
