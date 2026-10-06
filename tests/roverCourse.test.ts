/**
 * Rover proving ground on the strict mock GPU. The Perseverance model is mocked with procedural
 * boxes (the real 10 MB GLB never loads): the full assembly — track, lamps, cones, barriers,
 * rover attach — still builds, drives, knocks cones, collides with the chicane and resets.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
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
} from "../examples/src/scenes/roverCourseScene.js";
import type { LoadedGlb } from "../examples/src/assets/glb.js";

vi.mock("../examples/src/assets/glb.js", () => ({
  loadGlb: async (
    device: unknown,
    _url: string,
    onProgress?: (progress: { phase: string; receivedBytes: number; totalBytes: number | null }) => void,
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
  },
}));

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.unstubAllGlobals();
});

async function fixture() {
  const windowStub = new EventTarget();
  vi.stubGlobal("window", windowStub);
  vi.stubGlobal("document", { getElementById: () => null });
  vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));
  const gpu = await GraphicsDevice.create({ forceMock: true });
  const engine = { gpu, tasks: undefined as unknown as TaskScheduler } as Engine;
  const handle = buildRoverCourseScene(engine);
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
    expect(gpu.mock.outstanding.buffers).toEqual([]);
    expect(gpu.mock.outstanding.textures).toEqual([]);
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

describe("Rover Course — proving ground assembly", () => {
  it("attaches the rover model and builds the track, lamps, cones and obstacles", async () => {
    const { handle, scene } = await fixture();
    expect(handle.courseState().modelLoaded, "mocked rover model attaches").toBe(true);
    expect(withPrefix(scene, "rover-body-").length).toBeGreaterThanOrEqual(2);
    expect(withPrefix(scene, "rover-wheel_FL-part").length).toBeGreaterThanOrEqual(1);
    expect(withPrefix(scene, "rover-mast-").length).toBeGreaterThanOrEqual(3);
    expect(withPrefix(scene, "rover-arm").length).toBeGreaterThanOrEqual(5);
    // Track ribbon + edge lines + start strip + gantry.
    expect(withPrefix(scene, "track").length).toBe(1);
    expect(withPrefix(scene, "line-").length).toBe(2);
    expect(withPrefix(scene, "start-strip").length).toBe(1);
    expect(withPrefix(scene, "gantry-").length).toBe(4);
    // Eight lamp posts with spotlights, twenty cones, three chicane barriers.
    expect(withPrefix(scene, "lamp-pole-").length).toBe(8);
    expect(withPrefix(scene, "lamp-spot-").length).toBe(8);
    expect(withPrefix(scene, "cone-").filter((e) => /cone-\d+$/.test(e.name)).length).toBe(20);
    expect(withPrefix(scene, "barrier-").filter((e) => /barrier-\d+$/.test(e.name)).length).toBe(3);
    expect(withPrefix(scene, "tires-").length).toBe(12);
    expect(handle.courseState().coneCount).toBe(20);
    expect(handle.courseState().conesHit).toBe(0);
  });

  it("drives the rover down the home straight without clipping the slalom", async () => {
    const { handle, component, tick, key } = await fixture();
    const rover = component.vehicle;
    const startX = rover.position.x;
    key("keydown", "KeyW");
    for (let i = 0; i < 120; i++) tick();
    key("keyup", "KeyW");
    expect(rover.position.x).toBeGreaterThan(startX + 1);
    expect(rover.speed).toBeGreaterThan(0.5);
    // Straight down the middle threads every slalom cone (1.6 m aside, body half-width 1.3).
    expect(handle.courseState().conesHit).toBe(0);
  });

  it("knocks a cone on contact, counts it, and R stands everything back up", async () => {
    const { handle, scene, component, tick, key } = await fixture();
    const rover = component.vehicle;
    // Teleport onto slalom cone 0: dead-centre contact on the next tick.
    const [coneX, coneZ] = COURSE_CONES[0]!;
    rover.position.set(coneX, rover.position.y, coneZ);
    rover.placeOnGround(component.ground);
    for (let i = 0; i < 10; i++) tick();
    const knocked = handle.courseState();
    expect(knocked.knocked[0]).toBe(true);
    expect(knocked.conesHit).toBe(1);
    expect(handle.overlay?.() ?? "").toContain("cones hit 1/20");
    // The cone visibly tips: its root leaves the upright pose.
    const root = withPrefix(scene, "cone-").find((e) => e.name === "cone-0")!;
    expect(root.transform.rotation.w).toBeLessThan(0.999);
    key("keydown", "KeyR");
    key("keyup", "KeyR");
    // Reset runs synchronously in the key handler; assert before the next tick, because the
    // rover is still parked on top of the cone and would knock it straight over again.
    const reset = handle.courseState();
    expect(reset.conesHit).toBe(0);
    expect(reset.knocked.every((k) => !k)).toBe(true);
    // …and it stays reset once the rover drives off: the root is upright at home.
    rover.position.set(-12.5, rover.position.y, 14.5);
    rover.placeOnGround(component.ground);
    for (let i = 0; i < 10; i++) tick();
    expect(handle.courseState().conesHit).toBe(0);
    expect(root.transform.rotation.w).toBeCloseTo(1, 8);
  });

  it("closes the loop with an upward-facing ribbon; cones sit on the track, lamps off it", async () => {
    const samples = sampleTrackLoop();
    expect(samples.length).toBeGreaterThan(100);
    let length = 0;
    for (let i = 0; i < samples.length; i++) {
      const s = samples[i]!;
      expect(Math.hypot(s.tx, s.tz), `tangent ${i} is unit`).toBeCloseTo(1, 8);
      const n = samples[(i + 1) % samples.length]!;
      const step = Math.hypot(n.x - s.x, n.z - s.z);
      // No degenerate quads (joints deduped) and the wrap closes the loop.
      expect(step, `step ${i}`).toBeGreaterThan(0.5);
      expect(step, `step ${i}`).toBeLessThan(2.5);
      length += step;
    }
    // 2×40 m straights + 2×π×10 m corners ≈ 143 m.
    expect(length).toBeGreaterThan(135);
    expect(length).toBeLessThan(150);

    // Every ribbon triangle faces +Y (inverted winding would cull the track from above).
    const ribbon = ribbonSource(samples, 0, 3.5, 0.03);
    expect(ribbon.indices!.length).toBe(samples.length * 6);
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
        expect(len, `triangle ${t} is not degenerate`).toBeGreaterThan(1e-6);
        expect(ny / len, `triangle ${t} faces up`).toBeGreaterThan(0.99);
      }
    }

    // Cones play on the asphalt (within 4.2 m of the centreline); lamps stand outside it.
    const nearCentreline = (x: number, z: number): number => {
      let best = Number.POSITIVE_INFINITY;
      for (const s of samples) best = Math.min(best, Math.hypot(x - s.x, z - s.z));
      return best;
    };
    expect(COURSE_CONES.length).toBe(20);
    for (const [x, z] of COURSE_CONES) expect(nearCentreline(x, z)).toBeLessThan(4.2);
    const { scene } = await fixture();
    const poles = withPrefix(scene, "lamp-pole-");
    expect(poles.length).toBe(8);
    for (const pole of poles) {
      const p = pole.transform.position;
      const d = nearCentreline(p.x, p.z);
      expect(d, `${pole.name} stands off the asphalt`).toBeGreaterThan(4.8);
      expect(d, `${pole.name} stays near the track`).toBeLessThan(6.8);
    }
  });

  it("blocks the rover at the chicane barriers instead of passing through", async () => {
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
    expect(dist).toBeGreaterThanOrEqual(1.64);
    expect(rover.position.z).toBeGreaterThan(barrierZ);
  });
});
