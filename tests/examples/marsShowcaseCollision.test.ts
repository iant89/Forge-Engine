/**
 * @suite examples:marsShowcaseCollision
 * @group integration
 * @covers engine/src/core/engine.ts
 * @covers engine/src/core/log.ts
 * @covers engine/src/core/tasks/scheduler.ts
 * @covers engine/src/core/time.ts
 * @covers engine/src/debug/profiler.ts
 * @covers engine/src/gpu/device.ts
 * @covers engine/src/index.ts
 * @covers engine/src/population/world.ts
 * @covers engine/src/scene/components/index.ts
 * @covers engine/src/scene/systems.ts
 * @covers engine/src/scene/world.ts
 * @covers engine/src/terrain/interaction.ts
 * @covers engine/src/terrain/world.ts
 * @covers engine/src/vehicles/components.ts
 * @covers engine/src/vehicles/ground.ts
 * @covers engine/src/vehicles/vehicle.ts
 * @covers examples/src/assets/glb.ts
 * @covers examples/src/scenes/marsShowcaseScene.ts
 * @desc The Mars rover stops at rock surfaces instead of driving through them or parking inside one
 */

export const suite = {
  name: "examples:marsShowcaseCollision",
  group: "integration",
  covers:   [
    "engine/src/core/engine.ts",
    "engine/src/core/log.ts",
    "engine/src/core/tasks/scheduler.ts",
    "engine/src/core/time.ts",
    "engine/src/debug/profiler.ts",
    "engine/src/gpu/device.ts",
    "engine/src/index.ts",
    "engine/src/population/world.ts",
    "engine/src/scene/components/index.ts",
    "engine/src/scene/systems.ts",
    "engine/src/scene/world.ts",
    "engine/src/terrain/interaction.ts",
    "engine/src/terrain/world.ts",
    "engine/src/vehicles/components.ts",
    "engine/src/vehicles/ground.ts",
    "engine/src/vehicles/vehicle.ts",
    "examples/src/assets/glb.ts",
    "examples/src/scenes/marsShowcaseScene.ts"
  ],
  desc: "The Mars rover stops at rock surfaces instead of driving through them or parking inside one",
};
/**
 * The Mars rover stops at rock surfaces instead of driving through them or parking inside one.
 *
 * Rock contacts used to transfer momentum only: taking away the inward velocity stops the rover
 * driving *further* in, but the overlap earlier frames had already accumulated stayed put, and the
 * impact branch was gated on a live approach speed — so a rover brought to rest against a rock was
 * never touched again and sat inside it. These pin the geometric half of the contact: the rover's
 * centre never gets deeper into a rock than the push slack allows, whether it rams in at speed or
 * is dropped on top of one.
 */
import assert from "node:assert/strict";
import { afterEach, finish, group, spyFunction, stubGlobal, test, unstubAllGlobals } from "selrun";
import {
  Clock,
  GraphicsDevice,
  Logger,
  PopulationWorld,
  Profiler,
  SystemScratch,
  TerrainWorld,
  type TaskScheduler,
  VehicleComponent,
  heightFunctionGround,
  type Engine,
  type Entity,
  type SystemContext,
} from "@forge/engine";
import {
  PUSH_CONTACT_SLACK,
  ROVER_CONTACT_RADIUS,
  buildMarsShowcaseScene,
} from "../../examples/src/scenes/marsShowcaseScene.js";
import type { GlbLoadProgress, LoadedGlb } from "../../examples/src/assets/glb.js";

const mockLoadGlb = async (
  device: unknown,
  _url: string,
  onProgress?: (progress: GlbLoadProgress) => void,
): Promise<LoadedGlb> => {
  const engine = await import("@forge/engine");
  const geometries: { dispose(): void }[] = [];
  const material = engine.Material.unlit({ label: "mock-rover", color: 0xb06030 });
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
  return {
    body: [
      box("nose", 0.5, [0, 0, 1.5]),
      box("tail", 0.5, [0, 0, -1.5]),
      box("deck", 0.6, [0, 0.3, 0]),
    ],
    wheels: ["wheel_FL", "wheel_FR", "wheel_ML", "wheel_MR", "wheel_RL", "wheel_RR"].map((name, i) => ({
      name,
      hub: [i % 2 === 0 ? -1.1 : 1.1, 0, 1.1 - Math.floor(i / 2) * 1.1] as [number, number, number],
      parts: [box(`${name}-tire`, 0.4, [0, 0, 0])],
    })),
    mast: null,
    arm: {
      joints: [
        { name: "arm", joint: "azimuth", offset: [0.45149457, 0.91479832, 1.17553592], axis: [0, 1, 0], parts: [] },
        { name: "arm_shoulder", joint: "shoulder", offset: [-0.16599844, -0.09205257, -0.07775922], axis: [0, 0, -1], parts: [] },
        { name: "arm_elbow", joint: "elbow", offset: [-0.78691312, 0.22860408, -0.0218314], axis: [0, 0, -1], parts: [] },
        { name: "arm_wrist", joint: "wrist", offset: [0.75290355, 0.02422731, -0.06037109], axis: [0, 0, -1], parts: [] },
        { name: "arm_turret", joint: "turret", offset: [0.1757079, 0.15246472, -0.06037109], axis: [0, 1, 0], parts: [] },
      ],
    },
    dispose(): void {
      for (const g of geometries) g.dispose();
      material.dispose();
    },
  };
};

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  unstubAllGlobals();
});

async function fixture() {
  const windowStub = new EventTarget();
  stubGlobal("window", windowStub);
  stubGlobal("document", { getElementById: () => null });
  const fetchStub = spyFunction(() => new Promise<Response>(() => {}));
  stubGlobal("fetch", fetchStub);
  const gpu = await GraphicsDevice.create({ forceMock: true });
  const engine = { gpu, tasks: undefined as unknown as TaskScheduler } as Engine;
  const handle = buildMarsShowcaseScene(engine, { loadGlb: mockLoadGlb });
  const scene = handle.scene;
  scene.attachToEngine(engine);
  const terrain = scene.object<TerrainWorld>("TerrainWorld")!;
  const population = scene.object<PopulationWorld>("population")!;
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
  /**
   * The two halves of {@link tick}, split so a test can inspect the state exactly as the scene's
   * own update left it — after the rock contact solve, before the vehicle integrator moves the
   * rover back towards whatever it is leaning on.
   */
  const tickHandleOnly = (): void => {
    context.frame++;
    context.elapsed += context.dt;
    handle.update(context.dt);
  };
  const tickWorldOnly = (): void => {
    scene.update(context, context.dt);
  };
  const key = (type: "keydown" | "keyup", code: string): void => {
    windowStub.dispatchEvent(Object.assign(new Event(type), { code, repeat: false }));
  };
  return { handle, scene, terrain, population, component, tick, tickHandleOnly, tickWorldOnly, key };
}

/**
 * Horizontal collision radius the scene derives for an instance, mirroring `syncInteractiveRocks`:
 * type 2 flattens Y by 0.38, and a flat rock collides as a box whose half-extent is the raw scale
 * times baseRadius/2 (0.4 for rocks, 1.2 for boulders).
 */
function collisionRadius(typeId: number, scales: ArrayLike<number>, p: number): number {
  const base = typeId === 2 ? 2.4 : 0.8;
  const rawSx = scales[p]! * base;
  const rawSy = scales[p + 1]! * base * (typeId === 2 ? 0.62 : 1);
  const rawSz = scales[p + 2]! * base;
  const minDim = Math.min(rawSx, rawSy, rawSz);
  const sy = minDim;
  const sx = rawSx === minDim ? rawSy : rawSx;
  const sz = rawSz === minDim ? rawSy : rawSz;
  if (sy < 0.7 * Math.max(sx, sz)) return Math.max(scales[p]!, scales[p + 2]!) * (typeId === 2 ? 1.2 : 0.4);
  return Math.max(0.12, ((sx + sy + sz) / 3) * 0.55);
}

interface Target {
  chunkKey: string;
  typeId: number;
  index: number;
  x: number;
  z: number;
  radius: number;
}

const RAM_GAP = 6;
/**
 * A shade over the rover's ≈2.4 m/s loaded top speed (`MARS_ROVER_TRACTION`). Between the contact
 * solve and the render the vehicle integrator still gets one step, so against a rock the rover can
 * shove it may re-enter by up to this much travel before the next solve puts it back out.
 */
const TOP_SPEED_MPS = 2.5;

group("Mars Showcase — rover/rock contact geometry", () => {
  test("never lets the rover's centre get deeper into a rock than the push slack allows", async () => {
    const { handle, scene, terrain, population, component, tick, tickHandleOnly, tickWorldOnly, key } = await fixture();
    const rover = component.vehicle;
    const ground = heightFunctionGround((x: number, z: number) => terrain.getHeightAt(x, z));
    for (let i = 0; i < 120; i++) tick();
    for (let i = 0; i < 60 && !handle.marsState().modelLoaded; i++) {
      tick();
      await Promise.resolve();
    }
    assert.equal(handle.marsState().modelLoaded, true, "mocked rover model attaches");

    const byName = (name: string): Entity | null => {
      const id = scene.world.findByName(name)[0];
      return id === undefined ? null : scene.world.facade(id);
    };

    const targets: Target[] = [];
    for (const [chunkKey] of terrain.chunks) {
      for (const typeId of [1, 2, 3]) {
        const block = population.chunkPopulation(chunkKey, typeId);
        if (!block) continue;
        for (let i = 0; i < block.count; i++) {
          const p = i * 3;
          if (block.scales[p] === 0 && block.scales[p + 1] === 0) continue;
          const x = block.positions[p]!;
          const z = block.positions[p + 2]!;
          if (Math.hypot(x - rover.position.x, z - rover.position.z) > 55) continue;
          targets.push({ chunkKey, typeId, index: i, x, z, radius: collisionRadius(typeId, block.scales, p) });
        }
      }
    }
    targets.sort((a, b) => b.radius - a.radius);
    assert.ok(targets.length >= 10, "a bench of ram targets near spawn");

    /** No *other* rock sits in the lane, so the ram measures one target in isolation. */
    const laneClear = (t: Target): boolean => {
      const sx = t.x + 0.35;
      const sz = t.z - RAM_GAP;
      const dx = t.x - sx;
      const dz = t.z - sz;
      for (const [chunkKey] of terrain.chunks) {
        for (const typeId of [1, 2, 3]) {
          const block = population.chunkPopulation(chunkKey, typeId);
          if (!block) continue;
          for (let i = 0; i < block.count; i++) {
            const p = i * 3;
            if (block.scales[p] === 0 && block.scales[p + 1] === 0) continue;
            if (chunkKey === t.chunkKey && typeId === t.typeId && i === t.index) continue;
            const rx = block.positions[p]!;
            const rz = block.positions[p + 2]!;
            const u = Math.min(1, Math.max(0, ((rx - sx) * dx + (rz - sz) * dz) / (dx * dx + dz * dz)));
            if (Math.hypot(rx - (sx + u * dx), rz - (sz + u * dz)) < 3.2) return false;
          }
        }
      }
      return true;
    };

    const spawnYaw = rover.yaw;
    let rammed = 0;
    let reached = 0;
    for (const t of targets) {
      if (rammed >= 4) break;
      const sx = t.x + 0.35;
      const sz = t.z - RAM_GAP;
      rover.yaw = spawnYaw;
      rover.yawRate = 0;
      rover.setVelocity(0, 0, 0);
      rover.position.set(sx, terrain.getHeightAt(sx, sz) + 1.0, sz);
      rover.placeOnGround(ground);
      key("keydown", "KeyS");
      for (let i = 0; i < 30; i++) tick();
      key("keyup", "KeyS");
      if (!laneClear(t)) continue;
      rammed++;

      const label = t.typeId === 2 ? "boulders" : t.typeId === 3 ? "rocks-b" : "rocks";
      const rockEntity = `active-rock-${t.chunkKey}:${label}:${t.index}`;
      const range = ROVER_CONTACT_RADIUS + t.radius;
      // Deepest the rover's centre may sit once the contact solve has run: the contact range, less
      // the slack a rock the rover can shove is allowed to keep while it leads the rover away.
      const floor = range - PUSH_CONTACT_SLACK - 1e-3;
      let worstSolved = Number.POSITIVE_INFINITY;
      let worstRendered = Number.POSITIVE_INFINITY;
      let sawContact = false;
      key("keydown", "KeyW");
      for (let i = 0; i < 400; i++) {
        tickHandleOnly();
        const block = population.chunkPopulation(t.chunkKey, t.typeId);
        if (!block) break;
        const p = t.index * 3;
        // Once the interaction layer promotes the rock its body moves; track the live pose, which
        // the scene syncs straight from the body (no render interpolation in the way).
        const live = byName(rockEntity)?.transform;
        const rx = live ? live.position.x : block.positions[p]!;
        const rz = live ? live.position.z : block.positions[p + 2]!;
        if (!live && block.scales[p] === 0 && block.scales[p + 1] === 0) break;
        const solved = Math.hypot(rover.position.x - rx, rover.position.z - rz);
        if (solved < range) sawContact = true;
        worstSolved = Math.min(worstSolved, solved);
        // Then let the vehicle integrator run. Against a rock the rover can shove it is still
        // driving in, so it may re-enter by up to one step of travel before the next solve — that
        // is the visible worst case, and it has to stay a scratch, not the rover inside the rock.
        tickWorldOnly();
        worstRendered = Math.min(worstRendered, Math.hypot(rover.position.x - rx, rover.position.z - rz));
      }
      key("keyup", "KeyW");
      assert.ok(
        worstSolved >= floor,
        `${rockEntity}: the rover's centre got to ${worstSolved.toFixed(3)} m from the rock centre ` +
        `after a contact solve — ${Math.max(0, floor - worstSolved).toFixed(3)} m inside the ` +
        `${floor.toFixed(3)} m floor (contact range ${range.toFixed(3)})`,
      );
      assert.ok(
        worstRendered >= range - PUSH_CONTACT_SLACK - TOP_SPEED_MPS / 60 - 1e-3,
        `${rockEntity}: the rover's centre got to ${worstRendered.toFixed(3)} m from the rock centre ` +
        `at render time, deeper than the push slack plus one integrator step (at top speed) allows`,
      );
      // A lane may still not produce a contact — the rock can be shoved clear faster than the
      // rover closes, or the ground can slow it first. What must hold is that *some* ram landed.
      if (sawContact) reached++;
      assert.ok(Number.isFinite(worstSolved) && Number.isFinite(worstRendered));
      rover.setVelocity(0, 0, 0);
      rover.yawRate = 0;
      key("keydown", "KeyS");
      for (let i = 0; i < 20; i++) tick();
      key("keyup", "KeyS");
    }
    assert.ok(rammed >= 1, "at least one clean lane for a full-throttle ram");
    assert.ok(reached >= 1, "at least one ram actually made contact with its rock");
  });

  test("ejects a rover whose centre ends up inside a rock, with no throttle applied", async () => {
    const { terrain, population, component, tick } = await fixture();
    const rover = component.vehicle;
    const ground = heightFunctionGround((x: number, z: number) => terrain.getHeightAt(x, z));
    for (let i = 0; i < 240; i++) tick();

    // Any nearby rock will do: the rover is dropped exactly on its centre, which is the degenerate
    // case where no contact normal can be derived from the two positions.
    let target: Target | null = null;
    for (const [chunkKey] of terrain.chunks) {
      for (const typeId of [1, 2, 3]) {
        const block = population.chunkPopulation(chunkKey, typeId);
        if (!block) continue;
        for (let i = 0; i < block.count; i++) {
          const p = i * 3;
          if (block.scales[p] === 0 && block.scales[p + 1] === 0) continue;
          const x = block.positions[p]!;
          const z = block.positions[p + 2]!;
          if (Math.hypot(x - rover.position.x, z - rover.position.z) > 25) continue;
          target = { chunkKey, typeId, index: i, x, z, radius: collisionRadius(typeId, block.scales, p) };
          break;
        }
        if (target) break;
      }
      if (target) break;
    }
    assert.notEqual(target, null, "a rock near spawn to drop the rover on");
    const t = target!;

    rover.setVelocity(0, 0, 0);
    rover.yawRate = 0;
    rover.position.set(t.x, terrain.getHeightAt(t.x, t.z) + 1.0, t.z);
    rover.placeOnGround(ground);
    // Sanity: the drop really is inside the rock before anything resolves it.
    assert.ok(
      Math.hypot(rover.position.x - t.x, rover.position.z - t.z) < ROVER_CONTACT_RADIUS + t.radius,
      "the rover starts overlapping the rock",
    );

    for (let i = 0; i < 5; i++) tick();

    const block = population.chunkPopulation(t.chunkKey, t.typeId)!;
    const p = t.index * 3;
    const distance = Math.hypot(rover.position.x - block.positions[p]!, rover.position.z - block.positions[p + 2]!);
    assert.ok(
      distance >= ROVER_CONTACT_RADIUS + t.radius - PUSH_CONTACT_SLACK - 1e-3,
      `rover centre ${distance.toFixed(3)} m from the rock centre after settling, expected clear of ` +
      `${(ROVER_CONTACT_RADIUS + t.radius - PUSH_CONTACT_SLACK).toFixed(3)} m`,
    );
    assert.equal(rover.input.throttle, 0, "the ejection is geometric, not a drive input");
  });
});

await finish();
