/**
 * @suite examples:marsDustStorm
 * @group integration
 * @covers engine/src/particles/gpuWorld.ts
 * @covers engine/src/rendering/material.ts
 * @covers engine/src/vehicles/components.ts
 * @covers examples/src/assets/glb.ts
 * @covers examples/src/scenes/dustStorm.ts
 * @covers examples/src/scenes/marsDustStormScene.ts
 * @covers examples/src/scenes/marsShared.ts
 * @desc Mars Dust Storm Survival on the strict mock GPU: rover, beams, piles, storm atmosphere, stuck/reset rules
 */

export const suite = {
  name: "examples:marsDustStorm",
  group: "integration",
  covers:   [
    "engine/src/particles/gpuWorld.ts",
    "engine/src/rendering/material.ts",
    "engine/src/vehicles/components.ts",
    "examples/src/assets/glb.ts",
    "examples/src/scenes/dustStorm.ts",
    "examples/src/scenes/marsDustStormScene.ts",
    "examples/src/scenes/marsShared.ts"
  ],
  desc: "Mars Dust Storm Survival on the strict mock GPU: rover, beams, piles, storm atmosphere, stuck/reset rules",
};
/**
 * The Perseverance GLB is mocked with procedural boxes (the 10 MB model never loads) and the
 * terrain runs inline on the mock device. Ticks drive the scene `update` and the ECS systems the
 * way the engine does, so the vehicle, storm, piles and course all advance together.
 */
import assert from "node:assert/strict";
import { afterEach, finish, group, spyFunction, stubGlobal, test, unstubAllGlobals } from "selrun";
import {
  Clock,
  GraphicsDevice,
  Logger,
  Profiler,
  Renderable,
  SystemScratch,
  type Engine,
  type Entity,
  type SystemContext,
  type TaskScheduler,
  VehicleComponent,
} from "@forge/engine";
import { buildMarsDustStormScene } from "../../examples/src/scenes/marsDustStormScene.js";
import { BURIAL_STUCK, STORM_DIFFICULTY, type StormDifficulty } from "../../examples/src/scenes/dustStorm.js";
import type { GlbLoadProgress, LoadedGlb } from "../../examples/src/assets/glb.js";

const mockLoadGlb = async (device: unknown, _url: string, onProgress?: (progress: GlbLoadProgress) => void): Promise<LoadedGlb> => {
  const engine = await import("@forge/engine");
  const geometries: { dispose(): void }[] = [];
  const material = engine.Material.unlit({ label: "mock-storm-rover", color: 0xb06030 });
  const box = (name: string) => {
    const geometry = engine.Geometry.create(device as GraphicsDevice, engine.boxGeometrySource({ width: 0.4, height: 0.4, depth: 0.4 }));
    geometries.push(geometry);
    return { name, geometry, material };
  };
  onProgress?.({ phase: "done", receivedBytes: 1, totalBytes: 1 });
  return {
    body: [box("deck")],
    wheels: ["wheel_FL", "wheel_FR", "wheel_ML", "wheel_MR", "wheel_RL", "wheel_RR"].map((name) => ({
      name,
      hub: [0, 0, 0] as [number, number, number],
      parts: [box(`${name}-tire`)],
    })),
    mast: null,
    arm: null,
    dispose(): void {
      for (const g of geometries) g.dispose();
      material.dispose();
    },
  } as unknown as LoadedGlb;
};

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  unstubAllGlobals();
});

async function fixture(difficulty: StormDifficulty = "easy") {
  const windowStub = new EventTarget();
  stubGlobal("window", windowStub);
  stubGlobal("document", { getElementById: () => null });
  stubGlobal("fetch", spyFunction(() => new Promise<Response>(() => {})));
  const gpu = await GraphicsDevice.create({ forceMock: true });
  const engine = { gpu, tasks: undefined as unknown as TaskScheduler } as Engine;
  const handle = buildMarsDustStormScene(engine, { loadGlb: mockLoadGlb, difficulty, quality: "reduced" });
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
  const tick = (dt = context.dt): void => {
    context.frame++;
    context.elapsed += dt;
    handle.update(dt);
    scene.update(context, dt);
  };
  const key = (type: "keydown" | "keyup", code: string): void => {
    windowStub.dispatchEvent(Object.assign(new Event(type), { code, repeat: false }));
  };
  for (let i = 0; i < 60 && !handle.stormState().modelLoaded; i++) {
    tick();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return { handle, scene, vehicle: component.vehicle, tick, key };
}

function named(scene: { world: { liveEntityIds(): Iterable<number>; name(id: number): string; facade(id: number): Entity | null } }, prefix: string): Entity[] {
  const out: Entity[] = [];
  for (const id of scene.world.liveEntityIds()) {
    if (!scene.world.name(id).startsWith(prefix)) continue;
    const entity = scene.world.facade(id);
    if (entity) out.push(entity);
  }
  return out;
}

/** Release the startup brake (first throttle), then let go. */
function start(key: (type: "keydown" | "keyup", code: string) => void, tick: () => void): void {
  key("keydown", "KeyW");
  tick();
  key("keyup", "KeyW");
}

group("Mars Dust Storm Survival — scene assembly", () => {
  test("attaches the rover, the fog-exempt beams, boulders and their dust piles", async () => {
    const { handle, scene } = await fixture();
    const state = handle.stormState();
    assert.equal(state.modelLoaded, true);
    assert.equal(state.quality, "reduced");
    assert.ok(named(scene, "rover-body-").length >= 1);
    assert.equal(named(scene, "storm-beam-ring-").length, state.checkpointCount);
    const beams = named(scene, "storm-beam-").filter((e) => !scene.world.name(e.id).startsWith("storm-beam-ring-"));
    assert.equal(beams.length, state.checkpointCount);
    const visible = beams.filter((e) => e.get(Renderable)!.visible);
    assert.equal(visible.length, 2, "active + next beam only");
    for (const beam of beams) assert.equal(beam.get(Renderable)!.material!.fogExempt, true);
    assert.ok(named(scene, "storm-boulder-").length > 20);
    assert.equal(named(scene, "storm-pile-").length, named(scene, "storm-boulder-").length);
    assert.equal(scene.settings.skyEnabled, false, "the storm replaces the sky with dust");
    assert.equal(scene.settings.fog.mode, "exp2");
  });

  test("storm intensity drives fog, and boulder piles grow on their windward side", async () => {
    const { handle, tick } = await fixture();
    const lullFog = handle.stormState().fogDensity;
    for (let i = 0; i < 40 * 4; i++) tick(0.25); // into the first gust
    const s = handle.stormState();
    assert.equal(s.phase === "gust" || s.phase === "easing", true, s.phase);
    assert.ok(s.fogDensity > lullFog * 1.5, `fog ${lullFog} → ${s.fogDensity}`);
    assert.ok(s.piles.every((p) => p.depth > 0));
    assert.ok(s.devils.length >= 1);
  });

  test("checkpoints are reached in sequence and the last one wins the run", async () => {
    const { handle, scene, vehicle, tick, key } = await fixture();
    start(key, tick);
    const course = handle.stormState();
    for (let i = 0; i < course.checkpointCount; i++) {
      const beam = named(scene, `storm-beam-ring-${i}`)[0]!;
      vehicle.position.x = beam.transform.position.x;
      vehicle.position.z = beam.transform.position.z;
      tick();
      assert.equal(handle.stormState().checkpoint, i + 1);
    }
    assert.equal(handle.stormState().won, true);
  });
});

group("Mars Dust Storm Survival — difficulty rules (D3)", () => {
  test("easy: staying put sticks the rover, adds the penalty once, and throttle pumping rocks it free", async () => {
    const { handle, vehicle, tick, key } = await fixture("easy");
    start(key, tick);
    let guard = 0;
    while (!handle.stormState().stuck && guard++ < 2000) tick(0.1);
    const stuck = handle.stormState();
    assert.equal(stuck.stuck, true);
    assert.ok(stuck.burial >= BURIAL_STUCK);
    assert.equal(stuck.penalty, STORM_DIFFICULTY.easy.timePenalty);
    // Held: throttle does not drive while stuck.
    key("keydown", "KeyW");
    tick(0.1);
    assert.equal(vehicle.input.throttle, 0);
    key("keyup", "KeyW");
    for (let i = 0; i < 200 && handle.stormState().stuck; i++) {
      key(i % 2 === 0 ? "keydown" : "keyup", "KeyW");
      tick(0.1);
    }
    assert.equal(handle.stormState().stuck, false, "rocked free");
    assert.equal(handle.stormState().penalty, STORM_DIFFICULTY.easy.timePenalty);
  });

  test("hard: burial sends the rover back to the last checkpoint (the start before any beam)", async () => {
    const { handle, vehicle, tick, key } = await fixture("hard");
    start(key, tick);
    const spawnX = vehicle.position.x;
    const spawnZ = vehicle.position.z;
    vehicle.position.x += 6;
    let guard = 0;
    while (handle.stormState().resets === 0 && guard++ < 2000) tick(0.1);
    const s = handle.stormState();
    assert.equal(s.resets, 1);
    assert.ok(Math.hypot(s.x - spawnX, s.z - spawnZ) < 0.5);
    assert.equal(s.burial, 0);
    assert.equal(s.penalty, 0);
  });

  test("a flipped rover is righted with a penalty on easy and sent back on hard", async () => {
    const easy = await fixture("easy");
    start(easy.key, easy.tick);
    for (let i = 0; i < 40 && easy.handle.stormState().penalty === 0; i++) {
      easy.vehicle.roll = 1.9;
      easy.tick(0.1);
    }
    assert.equal(easy.handle.stormState().flipped, false);
    assert.equal(easy.handle.stormState().penalty, STORM_DIFFICULTY.easy.timePenalty);
    assert.equal(easy.handle.stormState().resets, 0);
    await cleanups.pop()!();
    const hard = await fixture("hard");
    start(hard.key, hard.tick);
    for (let i = 0; i < 40 && hard.handle.stormState().resets === 0; i++) {
      hard.vehicle.roll = 1.9;
      hard.tick(0.1);
    }
    assert.equal(hard.handle.stormState().resets, 1);
    assert.equal(hard.handle.stormState().flipped, false);
  });
});

await finish();
