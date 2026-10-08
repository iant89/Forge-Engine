/**
 * @suite examples:roverCourse
 * @group integration
 * @covers engine/src/core/engine.ts
 * @covers engine/src/core/log.ts
 * @covers engine/src/core/tasks/scheduler.ts
 * @covers engine/src/core/time.ts
 * @covers engine/src/debug/profiler.ts
 * @covers engine/src/gpu/device.ts
 * @covers engine/src/index.ts
 * @covers engine/src/scene/systems.ts
 * @covers engine/src/scene/world.ts
 * @covers engine/src/vehicles/components.ts
 * @covers examples/src/assets/glb.ts
 * @covers examples/src/scenes/roverCourseScene.ts
 * @desc Rover proving ground on the strict mock GPU. The Perseverance model is mocked with procedural
 */

export const suite = {
  name: "examples:roverCourse",
  group: "integration",
  covers:   [
    "engine/src/core/engine.ts",
    "engine/src/core/log.ts",
    "engine/src/core/tasks/scheduler.ts",
    "engine/src/core/time.ts",
    "engine/src/debug/profiler.ts",
    "engine/src/gpu/device.ts",
    "engine/src/index.ts",
    "engine/src/scene/systems.ts",
    "engine/src/scene/world.ts",
    "engine/src/vehicles/components.ts",
    "examples/src/assets/glb.ts",
    "examples/src/scenes/roverCourseScene.ts"
  ],
  desc: "Rover proving ground on the strict mock GPU. The Perseverance model is mocked with procedural",
};
/**
 * Rover proving ground on the strict mock GPU. The Perseverance model is mocked with procedural
 * boxes (the real 10 MB GLB never loads): the full assembly — track, lamps, cones, barriers,
 * rover attach — still builds, drives, knocks cones, collides with the chicane and resets.
 */
import assert from "node:assert/strict";
import { afterEach, assertCloseTo, assertContains, assertMatchObject, finish, group, spyFunction, stubGlobal, test, unstubAllGlobals } from "selrun";
import {
  Clock,
  GraphicsDevice,
  Logger,
  Profiler,
  SystemScratch,
  type Engine,
  type Entity,
  type SystemContext,
  type TaskScheduler,
  VehicleComponent,
} from "@forge/engine";
import {
  COURSE_BARRIERS,
  COURSE_CONES,
  buildRoverCourseScene,
  ribbonSource,
  sampleTrackLoop,
} from "../../examples/src/scenes/roverCourseScene.js";
import type { GlbLoadProgress, LoadedGlb } from "../../examples/src/assets/glb.js";

const mockLoadGlb = async (
    device: unknown,
    _url: string,
    onProgress?: (progress: GlbLoadProgress) => void,
  ): Promise<LoadedGlb> => {
    const engine = await import("@forge/engine");
    const geometries: { dispose(): void }[] = [];
    const material = engine.Material.unlit({ label: "mock-course-rover", color: 0xb06030 });
    const box = (name: string, size: number, at: [number, number, number]) => {
      const src = engine.boxGeometrySource({ width: size, height: size, depth: size });
      for (let i = 0; i < src.positions.length; i += 3) {
        src.positions[i]! += at[0];
        src.positions[i + 1]! += at[1];
        src.positions[i + 2]! += at[2];
      }
      const geometry = engine.Geometry.create(device as GraphicsDevice, src);
      geometries.push(geometry);
      return { name, geometry, material };
    };
    onProgress?.({ phase: "done", receivedBytes: 1, totalBytes: 1 });
    const mastLower = box("mast_lower-part", 0.3, [0, 0.5, -0.5]);
    const mastUpper = box("mast_upper-part", 0.3, [0, 0.6, -0.5]);
    const mastHead = box("mast_head-part", 0.3, [0, 0.7, -0.5]);
    return {
      body: [box("deck", 0.6, [0, 0, 0]), box("nose", 0.5, [0, 0, 1.5])],
      wheels: ["wheel_FL", "wheel_FR", "wheel_ML", "wheel_MR", "wheel_RL", "wheel_RR"].map((name) => ({
        name,
        hub: [0, 0, 0] as [number, number, number],
        parts: [box(`${name}-tire`, 0.4, [0, 0, 0])],
      })),
      mast: {
        pivot: [0, 0.5, -0.5] as [number, number, number],
        parts: [mastLower, mastUpper, mastHead],
        joint: [0, 0.1, 0] as [number, number, number],
        headPivot: [0, 0.2, 0] as [number, number, number],
        lowerParts: [mastLower],
        upperParts: [mastUpper],
        headParts: [mastHead],
      },
      arm: {
        joints: ["arm", "arm_shoulder", "arm_elbow", "arm_wrist", "arm_turret"].map((name, i) => ({
          name,
          joint: name,
          offset: [0, i === 0 ? 0.4 : 0.1, 0.9] as [number, number, number],
          axis: [0, 1, 0] as [number, number, number],
          parts: [box(`${name}-link`, 0.2, [0, 0, 0])],
        })),
      },
      dispose(): void {
        for (const g of geometries) g.dispose();
        material.dispose();
      },
    };
  };;

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  unstubAllGlobals();
});

async function fixture() {
  const windowStub = new EventTarget();
  stubGlobal("window", windowStub);
  stubGlobal("document", { getElementById: () => null });
  stubGlobal("fetch", spyFunction(() => new Promise<Response>(() => {})));
  const gpu = await GraphicsDevice.create({ forceMock: true });
  const engine = { gpu, tasks: undefined as unknown as TaskScheduler } as Engine;
  const handle = buildRoverCourseScene(engine, { loadGlb: mockLoadGlb });
  const scene = handle.scene;
  scene.attachToEngine(engine);
  const component = scene.world.getComponent(scene.world.findByName("rover-chassis")[0]!, VehicleComponent)!;
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
    assert.deepEqual(gpu.mock.outstanding.buffers, []);
    assert.deepEqual(gpu.mock.outstanding.textures, []);
  });
  const tick = (): void => {
    context.frame++;
    context.elapsed += context.dt;
    handle.update(context.dt);
    scene.update(context, context.dt);
  };
  const key = (type: "keydown" | "keyup", code: string): void => {
    windowStub.dispatchEvent(Object.assign(new Event(type), { code, repeat: false }));
  };
  // The mocked model resolves without network or timers; pump microtasks so the promise settles.
  for (let i = 0; i < 60 && !handle.courseState().modelLoaded; i++) {
    tick();
    await Promise.resolve();
  }
  return { handle, scene, component, tick, key };
}

function withPrefix(scene: { world: { liveEntityIds(): Iterable<number>; name(id: number): string; facade(id: number): Entity | null } }, prefix: string): Entity[] {
  const out: Entity[] = [];
  for (const id of scene.world.liveEntityIds()) {
    if (!scene.world.name(id).startsWith(prefix)) continue;
    const entity = scene.world.facade(id);
    if (entity) out.push(entity);
  }
  return out;
}

group("Rover Course — proving ground assembly", () => {
  test("attaches the rover model and builds the track, lamps, cones and obstacles", async () => {
    const { handle, scene } = await fixture();
    assert.equal(handle.courseState().modelLoaded, true, "mocked rover model attaches");
    assert.ok(withPrefix(scene, "rover-body-").length >= 2);
    assert.ok(withPrefix(scene, "rover-wheel_FL-part").length >= 1);
    assert.ok(withPrefix(scene, "rover-mast-").length >= 3);
    assert.ok(withPrefix(scene, "rover-arm").length >= 5);
    // Track ribbon + edge lines + start strip + gantry.
    assert.equal(withPrefix(scene, "track").length, 1);
    assert.equal(withPrefix(scene, "line-").length, 2);
    assert.equal(withPrefix(scene, "start-strip").length, 1);
    assert.equal(withPrefix(scene, "gantry-").length, 4);
    // Eight lamp posts with spotlights, twenty cones, three chicane barriers.
    assert.equal(withPrefix(scene, "lamp-pole-").length, 8);
    assert.equal(withPrefix(scene, "lamp-spot-").length, 8);
    assert.equal(withPrefix(scene, "cone-").filter((e) => /cone-\d+$/.test(e.name)).length, 20);
    assert.equal(withPrefix(scene, "barrier-").filter((e) => /barrier-\d+$/.test(e.name)).length, 3);
    assert.equal(withPrefix(scene, "tires-").length, 12);
    assert.equal(handle.courseState().coneCount, 20);
    assert.equal(handle.courseState().conesHit, 0);
  });

  test("keeps the 1.5× speed tune and its 50%-faster full-throttle speed", async () => {
    const { component } = await fixture();
    const rover = component.vehicle;
    assertMatchObject(rover.config.engine, {
      peakTorque: 9.5,
      peakPower: 1500,
      ratedRpm: 1500,
      maxRpm: 5700,
      regenTorque: 4.2,
    });
    assert.equal(rover.config.transmission.ratio, 60);
    // Step the actual vehicle directly on the course's flat ground: track obstacles must not
    // masquerade as a speed cap, and the scene must not overwrite this full-throttle input.
    rover.input.brake = 0;
    rover.input.handbrake = 0;
    rover.input.throttle = 1;
    for (let i = 0; i < 60; i++) rover.step(1 / 60, component.ground);
    assert.ok(rover.speed > 0.5);
    assert.ok(rover.speed < 1.6);
    let maxSpeed = rover.speed;
    for (let i = 60; i < 60 * 40; i++) {
      rover.step(1 / 60, component.ground);
      maxSpeed = Math.max(maxSpeed, rover.speed);
    }
    // 5700 rpm through 60:1 on 0.264 m wheels is ≈2.63 m/s no-load; the requested +50% over the
    // old 3800 rpm tune's ≈1.75 m/s. Loaded on asphalt it settles at ≈2.36 m/s — still slow.
    assert.ok(maxSpeed < 2.65);
    assert.ok(rover.speed > 1.5);
  });

  test("drives the rover down the home straight without clipping the slalom", async () => {
    const { handle, component, tick, key } = await fixture();
    const rover = component.vehicle;
    const startX = rover.position.x;
    key("keydown", "KeyW");
    for (let i = 0; i < 120; i++) tick();
    key("keyup", "KeyW");
    assert.ok(rover.position.x > startX + 1);
    assert.ok(rover.speed > 0.5);
    // Straight down the middle threads every slalom cone (1.6 m aside, body half-width 1.3).
    assert.equal(handle.courseState().conesHit, 0);
  });

  test("steers under full throttle instead of stalling in the corners", async () => {
    const { handle, component, tick, key } = await fixture();
    const rover = component.vehicle;
    key("keydown", "KeyW");
    key("keydown", "KeyD");
    for (let i = 0; i < 180; i++) tick();
    key("keyup", "KeyW");
    key("keyup", "KeyD");
    // Regression: throttle + steering used to scrub off nearly everything — the rover crawled
    // at ≈0.13 m/s with the throttle pinned, which reads as "it doesn't move on the course".
    assert.ok(handle.courseState().speed > 1);
    assert.ok(rover.speed > 1);
    // …and it is the steering that turned it, not a straight line with the wheels dragging.
    assert.ok(Math.abs(handle.courseState().yaw - Math.PI / 2) > 0.5);
  });

  test("knocks a cone on contact, counts it, and R stands everything back up", async () => {
    const { handle, scene, component, tick, key } = await fixture();
    const rover = component.vehicle;
    // Teleport onto slalom cone 0: dead-centre contact on the next tick.
    const [coneX, coneZ] = COURSE_CONES[0]!;
    rover.position.set(coneX, rover.position.y, coneZ);
    rover.placeOnGround(component.ground);
    for (let i = 0; i < 10; i++) tick();
    const knocked = handle.courseState();
    assert.equal(knocked.knocked[0], true);
    assert.equal(knocked.conesHit, 1);
    assertContains(handle.overlay?.() ?? "", "cones hit 1/20");
    // The cone visibly tips: its root leaves the upright pose.
    const root = withPrefix(scene, "cone-").find((e) => e.name === "cone-0")!;
    assert.ok(root.transform.rotation.w < 0.999);
    key("keydown", "KeyR");
    key("keyup", "KeyR");
    // Reset runs synchronously in the key handler; assert before the next tick, because the
    // rover is still parked on top of the cone and would knock it straight over again.
    const reset = handle.courseState();
    assert.equal(reset.conesHit, 0);
    assert.equal(reset.knocked.every((k) => !k), true);
    // …and it stays reset once the rover drives off: the root is upright at home.
    rover.position.set(-12.5, rover.position.y, 14.5);
    rover.placeOnGround(component.ground);
    for (let i = 0; i < 10; i++) tick();
    assert.equal(handle.courseState().conesHit, 0);
    assertCloseTo(root.transform.rotation.w, 1, 8);
  });

  test("closes the loop with an upward-facing ribbon; cones sit on the track, lamps off it", async () => {
    const samples = sampleTrackLoop();
    assert.ok(samples.length > 100);
    let length = 0;
    for (let i = 0; i < samples.length; i++) {
      const s = samples[i]!;
      assertCloseTo(Math.hypot(s.tx, s.tz), 1, 8, `tangent ${i} is unit`);
      const n = samples[(i + 1) % samples.length]!;
      const step = Math.hypot(n.x - s.x, n.z - s.z);
      // No degenerate quads (joints deduped) and the wrap closes the loop.
      assert.ok(step > 0.5, `step ${i}`);
      assert.ok(step < 2.5, `step ${i}`);
      length += step;
    }
    // 2×40 m straights + 2×π×10 m corners ≈ 143 m.
    assert.ok(length > 135);
    assert.ok(length < 150);

    // Every ribbon triangle faces +Y (inverted winding would cull the track from above).
    const ribbon = ribbonSource(samples, 0, 3.5, 0.03);
    assert.equal(ribbon.indices!.length, samples.length * 6);
    for (let t = 0; t < ribbon.indices!.length; t += 6) {
      const v = (k: number): [number, number, number] => {
        const vi = ribbon.indices![t + k]! * 3;
        return [ribbon.positions[vi]!, ribbon.positions[vi + 1]!, ribbon.positions[vi + 2]!];
      };
      for (const tri of [[0, 1, 2], [3, 4, 5]]) {
        const [ax, ay, az] = v(tri[0]!);
        const [bx, by, bz] = v(tri[1]!);
        const [cx, cy, cz] = v(tri[2]!);
        const nx = (by - ay) * (cz - az) - (bz - az) * (cy - ay);
        const ny = (bz - az) * (cx - ax) - (bx - ax) * (cz - az);
        const nz = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
        const len = Math.hypot(nx, ny, nz);
        assert.ok(len > 1e-6, `triangle ${t} is not degenerate`);
        assert.ok(ny / len > 0.99, `triangle ${t} faces up`);
      }
    }

    // Cones play on the asphalt (within 4.2 m of the centreline); lamps stand outside it.
    const nearCentreline = (x: number, z: number): number => {
      let best = Number.POSITIVE_INFINITY;
      for (const s of samples) best = Math.min(best, Math.hypot(x - s.x, z - s.z));
      return best;
    };
    assert.equal(COURSE_CONES.length, 20);
    for (const [x, z] of COURSE_CONES) assert.ok(nearCentreline(x, z) < 4.2);
    const { scene } = await fixture();
    const poles = withPrefix(scene, "lamp-pole-");
    assert.equal(poles.length, 8);
    for (const pole of poles) {
      const p = pole.transform.position;
      const d = nearCentreline(p.x, p.z);
      assert.ok(d > 4.8, `${pole.name} stands off the asphalt`);
      assert.ok(d < 6.8, `${pole.name} stays near the track`);
    }
  });

  test("blocks the rover at the chicane barriers instead of passing through", async () => {
    const { component, tick, key } = await fixture();
    const rover = component.vehicle;
    const [barrierX, barrierZ] = COURSE_BARRIERS[0]!;
    // South of barrier 1 (it spans ±1.1 m along X), facing it (yaw π faces -Z).
    rover.yaw = Math.PI;
    rover.position.set(barrierX, rover.position.y, barrierZ + 2.2);
    rover.placeOnGround(component.ground);
    key("keydown", "KeyW");
    for (let i = 0; i < 90; i++) tick();
    key("keyup", "KeyW");
    // Capsule radius is 1.35 + 0.3 = 1.65; the centre never gets closer than that.
    const dist = Math.abs(rover.position.z - barrierZ);
    assert.ok(dist >= 1.64);
    assert.ok(rover.position.z > barrierZ);
  });
});

await finish();
