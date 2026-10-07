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

import { afterEach, describe, expect, it, vi } from "vitest";
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
import { buildVehiclePlaygroundScene } from "../examples/src/scenes/vehiclePlaygroundScene.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.unstubAllGlobals();
});

async function fixture() {
  // The scene binds keyboard listeners on `window` and looks up its touch pad in `document`.
  vi.stubGlobal("window", new EventTarget());
  vi.stubGlobal("document", { getElementById: () => null });
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
    expect(gpu.mock.outstanding.buffers).toEqual([]);
    expect(gpu.mock.outstanding.textures).toEqual([]);
  });
  const entity = (name: string): EntityId => {
    const id = scene.world.findByName(name)[0];
    expect(id, `entity ${name}`).toBeTruthy();
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

describe("vehicle playground — mechanical wheel assemblies", () => {
  it("builds one 20-joint rig over four corners and draws the assemblies", async () => {
    const { gpu, renderer, scene, handle, entity, tick } = await fixture();
    const tickFixture = (): void => tick(1);
    // One frame first, so the source has written its channels.
    tickFixture();
    const mechanical = handle.vehicleState!().mechanical!;
    // travel + steer + spin + arm + shock per wheel.
    expect(mechanical.joints).toBe(20);
    // steer / spin / travel per wheel.
    expect(mechanical.channels).toBe(12);

    renderer.renderScene(scene);
    expect(gpu.mock.errors).toEqual([]);
    expect(renderer.stats.drawCalls).toBeGreaterThan(0);
    for (const name of [
      "wheel-0-hub",
      "wheel-0-knuckle",
      "wheel-0-axle",
      "wheel-0-tyre",
      "wheel-0-upright",
      "wheel-3-shock",
      "wheel-3-arm-link",
    ]) {
      expect(scene.world.hasComponent(entity(name), Transform)).toBe(true);
    }
  });

  it("poses the hierarchy from wheel telemetry while the car drives", async () => {
    const { handle, scene, tick, entity, vehicle } = await fixture();
    handle.vehicleState!(); // the state path the browser gate reads
    tick(60, (v) => {
      v.input.throttle = 0.7;
      v.input.steer = 1;
    });

    expect(Math.abs(vehicle.wheels[0]!.steerAngle)).toBeGreaterThan(0.05);
    expect(Math.abs(vehicle.wheels[0]!.spin)).toBeGreaterThan(0.5);

    // The knuckle yaws with the wheel's own Ackermann angle.
    const knuckle = scene.world.getTRS(entity("wheel-0-knuckle")).rotation;
    const steered = directionOf(knuckle);
    const reference = directionOf(new Quat().setAxisAngle(new Vec3(0, 1, 0), vehicle.wheels[0]!.steerAngle));
    expect(steered.x).toBeCloseTo(reference.x, 4);
    expect(steered.z).toBeCloseTo(reference.z, 4);

    // The axle rolls at the odometer the tire integrated (left wheel: negated by the rig).
    const axle = scene.world.getTRS(entity("wheel-0-axle")).rotation;
    const rolled = directionOf(axle, new Vec3(0, 1, 0));
    expect(rolled.y).toBeCloseTo(Math.cos(vehicle.wheels[0]!.spin), 3);
    expect(rolled.z).toBeCloseTo(Math.sin(-vehicle.wheels[0]!.spin), 3);

    // The hub rides the compression the spring produced, at its own hardpoint.
    const hub = scene.world.getTRS(entity("wheel-0-hub")).position;
    expect(hub.y).toBeCloseTo(-vehicle.config.suspensionRest + vehicle.wheels[0]!.compression, 5);
    expect(hub.x).toBeCloseTo(vehicle.wheels[0]!.x, 5);
    expect(hub.z).toBeCloseTo(vehicle.wheels[0]!.z, 5);
  });

  it("aims the arm and damper at the hub, whatever the travel is", async () => {
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
      expect(dot, `${link} points at the hub`).toBeGreaterThan(0.999);
    }
    // The telescoping links stretch along their own axis only.
    const shockScale = scene.world.getTRS(entity("wheel-0-shock")).scale;
    expect(shockScale.z).toBeGreaterThan(0);
    expect(shockScale.x).toBeCloseTo(1, 6);
    expect(shockScale.y).toBeCloseTo(1, 6);

    // They follow the hub when the suspension moves: less compression drops the hub lower, and the
    // links stay aimed at it (the distance they have to cover changes with it).
    const lengthBefore = scene.world.worldPosition(entity("wheel-0-shock")).distanceTo(hubWorld);
    handle.setWheelOverride!({ steer: 0, travel: 0.02, spin: 0 });
    tick(20);
    const hubNow = scene.world.worldPosition(entity("wheel-0-hub"));
    const shockNow = scene.world.worldPosition(entity("wheel-0-shock"));
    expect(hubNow.y).toBeLessThan(hubWorld.y);
    expect(shockNow.distanceTo(hubNow)).not.toBeCloseTo(lengthBefore, 6);
    const toHubNow = hubNow.clone().sub(shockNow).normalize();
    const pointsNow = directionOf(scene.world.getTRS(entity("wheel-0-shock")).rotation);
    expect(pointsNow.x * toHubNow.x + pointsNow.y * toHubNow.y + pointsNow.z * toHubNow.z).toBeGreaterThan(0.999);
  });

  it("steers only the steered corners, like the per-wheel Ackermann solve", async () => {
    const { handle, tick, vehicle } = await fixture();
    handle.setWheelOverride!({ steer: 0.4, travel: 0.08, spin: 0 });
    tick(20);
    const mechanical = handle.vehicleState!().mechanical!;
    // FL/FR yaw; RL/RR hold zero so the rig reproduces the solver's decision, not a crab turn.
    expect(Math.abs(mechanical.steer[0] - 0.4)).toBeLessThan(1e-6);
    expect(Math.abs(mechanical.steer[1] - 0.4)).toBeLessThan(1e-6);
    expect(Math.abs(mechanical.steer[2])).toBeLessThan(1e-6);
    expect(Math.abs(mechanical.steer[3])).toBeLessThan(1e-6);
    expect(vehicle.wheels[2]!.steered).toBe(false);
    // The front knuckles' slew had time to arrive, so nothing is saturated after 20 frames.
    expect(mechanical.saturated.every((s) => s === false)).toBe(true);
  });

  it("returns the assembly to telemetry when the override is cleared", async () => {
    const { handle, scene, tick, entity, vehicle } = await fixture();
    handle.setWheelOverride!({ steer: 0.3, travel: 0.14, spin: 2 });
    tick(20);
    expect(scene.world.getTRS(entity("wheel-0-hub")).position.y).toBeCloseTo(
      -vehicle.config.suspensionRest + 0.14,
      4,
    );
    expect(Math.abs(scene.world.getTRS(entity("wheel-0-knuckle")).rotation.y)).toBeGreaterThan(0.1);

    handle.setWheelOverride!(null);
    tick(30);
    const expected = -vehicle.config.suspensionRest + vehicle.wheels[0]!.compression;
    expect(scene.world.getTRS(entity("wheel-0-hub")).position.y).toBeCloseTo(expected, 5);
    // A parked car is not steering: the knuckle slew settles back to the telemetry's zero.
    expect(Math.abs(scene.world.getTRS(entity("wheel-0-knuckle")).rotation.y)).toBeLessThan(1e-4);
  });
});
