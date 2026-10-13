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
 * @desc Mars Dust Storm Survival on the strict mock GPU: rover, beams, piles, storm atmosphere, stuck/reset rules, per-devil particle systems, EASY/HARD toggle
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
  desc: "Mars Dust Storm Survival on the strict mock GPU: rover, beams, piles, storm atmosphere, stuck/reset rules, per-devil particle systems, EASY/HARD toggle",
};
/**
 * The Perseverance GLB is mocked with procedural boxes (the 10 MB model never loads) and the
 * terrain runs inline on the mock device. Ticks drive the scene `update` and the ECS systems the
 * way the engine does, so the vehicle, storm, piles and course all advance together.
 */
import assert from "node:assert/strict";
import { afterEach, assertMatchObject, finish, group, spyFunction, stubGlobal, test, unstubAllGlobals } from "selrun";
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
  findGpuParticleWorlds,
} from "@forge/engine";
import { buildMarsDustStormScene } from "../../examples/src/scenes/marsDustStormScene.js";
import { BURIAL_STUCK, STORM_DIFFICULTY, STORM_QUALITY_TIERS, stormParticleBudget, type StormDifficulty } from "../../examples/src/scenes/dustStorm.js";
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

/** A toolbar/touch button stand-in: click events plus the class/aria/caption surface the scene writes. */
function fakeButton() {
  const classes = new Set<string>();
  const attrs = new Map<string, string>();
  const letter = { textContent: "" };
  const caption = { textContent: "" };
  return Object.assign(new EventTarget(), {
    classList: { toggle: (c: string, on: boolean) => (on ? classes.add(c) : classes.delete(c), on), contains: (c: string) => classes.has(c) },
    setAttribute: (k: string, v: string) => void attrs.set(k, v),
    getAttribute: (k: string) => attrs.get(k) ?? null,
    querySelector: (sel: string) => (sel === ".veh-letter" ? letter : sel === ".veh-caption" ? caption : null),
    letter,
    caption,
  });
}

async function fixture(difficulty: StormDifficulty = "easy", tickWhileLoading = true) {
  const windowStub = new EventTarget();
  stubGlobal("window", windowStub);
  const buttons = { "btn-storm-easy": fakeButton(), "btn-storm-hard": fakeButton(), "storm-difficulty": fakeButton() };
  stubGlobal("document", { getElementById: (id: string) => (buttons as Record<string, unknown>)[id] ?? null });
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
    if (tickWhileLoading) tick();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return { handle, scene, gpu, buttons, vehicle: component.vehicle, tick, key };
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

  test("fe-18: easy shows the draped guide path, hard hides path and arrow; beam pulse animates", async () => {
    const { handle, scene, tick } = await fixture();
    const path = named(scene, "storm-guide-path")[0]!.get(Renderable)!;
    const arrow = named(scene, "storm-waypoint-arrow")[0]!.get(Renderable)!;
    tick();
    assert.equal(path.visible, true, "easy: path on");
    const beamMat = named(scene, "storm-beam-").filter((e) => !scene.world.name(e.id).startsWith("storm-beam-ring-")).map((e) => e.get(Renderable)!).find((r) => r.visible && r.material!.label === "storm-beam-active")!.material!;
    const rev0 = beamMat.revision;
    const glows = new Set<number>();
    for (let i = 0; i < 8; i++) {
      tick(0.2);
      glows.add(Math.round(beamMat.emissiveStrength * 100));
    }
    assert.ok(glows.size > 3, "active beam pulses");
    for (const e of [...named(scene, "storm-devil-"), ...named(scene, "storm-guide-path"), ...named(scene, "storm-beam-")]) {
      const r = e.get(Renderable)!;
      assert.equal(r.transparent, r.material!.transparent, `${scene.world.name(e.id)} draws in the matching (blend) bucket`);
    }
    assert.ok(beamMat.revision > rev0, "pulse marks the material changed so the GPU uniforms update");
    handle.setDifficulty("hard");
    for (let i = 0; i < 20; i++) tick(0.1);
    assert.equal(path.visible, false, "hard: no path");
    assert.equal(arrow.visible, false, "hard: no arrow");
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

group("Mars Dust Storm Survival — one GPU particle system per dust devil", () => {
  test("the sheet and every devil slot own a system; each live devil swirls its own column, within the reduced budget", async () => {
    const { handle, scene, gpu, tick } = await fixture();
    const worlds = findGpuParticleWorlds(scene);
    const reduced = STORM_QUALITY_TIERS.reduced;
    assert.equal(worlds.length, 1 + reduced.devils);
    assert.equal(worlds[0]!.name, "storm dust");
    for (const w of worlds) await w.attachDevice(gpu);
    assert.equal(worlds[0]!.system!.capacity, reduced.sheetCapacity);
    for (const w of worlds.slice(1)) assert.equal(w.system!.capacity, reduced.devilCapacity);
    assert.ok(worlds.reduce((n, w) => n + w.system!.capacity, 0) <= stormParticleBudget(reduced));
    let guard = 0;
    while (handle.stormState().devils.length < 1 && guard++ < 400) tick(0.25);
    tick();
    const devils = handle.stormState().devils;
    assert.ok(devils.length >= 1);
    const sheet = worlds[0]!.system!;
    assert.equal(sheet.modules.swirlStrength, 0, "the storm sheet does not spin");
    for (const w of worlds) {
      assert.ok(w.system!.modules.colorVariation > 0, "per-particle palette variation on every dust system");
      assert.ok(w.system!.modules.colorAlt.r < w.system!.modules.colorFrom.r, "alternate tone is the darker rock colour");
    }
    assert.ok(sheet.emitter.rate > 0);
    for (let i = 0; i < reduced.devils; i++) {
      const sys = worlds[1 + i]!.system!;
      const d = devils.find((x) => x.slot === i);
      if (!d) {
        assert.equal(sys.emitter.rate, 0, `idle slot ${i}`);
        continue;
      }
      assert.ok(sys.emitter.rate > 0 && sys.emitter.rate <= reduced.devilRate, "rate follows the devil's life envelope");
      assert.ok(Math.abs(sys.modules.swirlStrength) > 0, `devil ${i} swirls`);
      // fe-21: red-frontier vortex column spawn + axis spring, not the old box/cone + 3D attractor.
      assert.ok(sys.emitter.vortex && sys.emitter.vortex.height > 0, `devil ${i} uses the vortex spawn`);
      assert.ok((sys.modules.axisPull ?? 0) > 0, `devil ${i} is held on its axis`);
      assert.equal(sys.modules.attractorStrength, 0);
      assert.equal(Math.sign(sys.modules.swirlStrength), Math.sign(d.swirl || 1));
      // fe-22d: the base dances on a bounded wander around the sim position; spawn and axis agree.
      assert.equal(sys.emitter.position.x, sys.modules.attractorPos.x);
      assert.equal(sys.emitter.position.z, sys.modules.attractorPos.z);
      assert.ok(Math.hypot(sys.modules.attractorPos.x - d.x, sys.modules.attractorPos.z - d.z) <= 6 + 1e-6, "wander stays bounded");
    }
  });
});

group("Mars Dust Storm Survival — EASY/HARD toggle", () => {
  test("the toolbar and touch toggles switch the rules and restart the run; the URL value seeds them", async () => {
    const { handle, scene, buttons, vehicle, tick, key } = await fixture("hard");
    assert.equal(buttons["btn-storm-hard"].classList.contains("active"), true, "seeded from ?difficulty");
    assert.equal(buttons["storm-difficulty"].caption.textContent, "HARD");
    start(key, tick);
    const beam = named(scene, "storm-beam-ring-0")[0]!;
    vehicle.position.x = beam.transform.position.x;
    vehicle.position.z = beam.transform.position.z;
    tick();
    assert.equal(handle.stormState().checkpoint, 1);
    buttons["btn-storm-easy"].dispatchEvent(new Event("click"));
    let s = handle.stormState();
    assert.equal(s.difficulty, "easy");
    assert.equal(s.checkpoint, 0, "run restarted");
    assert.equal(s.elapsed, 0);
    assert.equal(buttons["btn-storm-easy"].classList.contains("active"), true);
    assert.equal(buttons["btn-storm-hard"].getAttribute("aria-pressed"), "false");
    assert.equal(buttons["storm-difficulty"].letter.textContent, "E");
    // The touch pad flips between the two.
    buttons["storm-difficulty"].dispatchEvent(new Event("click"));
    s = handle.stormState();
    assert.equal(s.difficulty, "hard");
    assert.equal(buttons["storm-difficulty"].classList.contains("active"), true);
    // Hard rules are live after the switch: burial sends the rover back.
    handle.setDifficulty("hard");
    start(key, tick);
    vehicle.position.x += 6;
    let guard = 0;
    while (handle.stormState().resets === 0 && guard++ < 2000) tick(0.1);
    assert.equal(handle.stormState().resets, 1);
    assert.equal(handle.stormState().penalty, 0);
  });
});

group("Mars Dust Storm Survival — restart resets everything (fixed seed)", () => {
  test("R and the EASY/HARD toggle restore the fresh-run state, and the run replays identically", async () => {
    // No ticks while the mock model loads: this is the state a brand-new run starts from (t = 0).
    const { handle, scene, vehicle, tick, key } = await fixture("easy", false);
    const fresh = handle.stormState();
    assert.equal(fresh.modelLoaded, true);
    assert.equal(fresh.time, 0);
    // Play a recorded run: into a gust, devils spawned, piles grown, a beam reached.
    const replay = (): ReturnType<typeof handle.stormState>[] => {
      const out = [];
      start(key, tick);
      for (let i = 0; i < 160; i++) {
        tick(0.25);
        if (i % 20 === 0) out.push(handle.stormState());
      }
      return out;
    };
    const first = replay();
    const played = handle.stormState();
    assert.ok(played.time > 30 && played.devils.length >= 1 && played.piles.every((p) => p.depth > 0));
    const beam = named(scene, "storm-beam-ring-0")[0]!;
    vehicle.position.x = beam.transform.position.x;
    vehicle.position.z = beam.transform.position.z;
    tick();
    assert.equal(handle.stormState().checkpoint, 1);

    key("keydown", "KeyR");
    key("keyup", "KeyR");
    const afterR = handle.stormState();
    assert.deepEqual(afterR, fresh, "R restores the fresh-run state");
    assertMatchObject(afterR, { time: 0, devils: [], checkpoint: 0, burial: 0, elapsed: 0, penalty: 0, resets: 0 });
    assert.ok(afterR.piles.every((p) => p.depth === 0));
    const second = replay();
    assert.deepEqual(second.map(stormOnly), first.map(stormOnly), "same storm, devils and piles after a restart");

    handle.setDifficulty("hard");
    assert.deepEqual({ ...handle.stormState(), difficulty: "easy" }, fresh, "the toggle restarts everything too");
  });
});

/** The seeded storm model (clock, gusts, devils, piles), independent of the driven rover path. */
function stormOnly(s: ReturnType<Awaited<ReturnType<typeof fixture>>["handle"]["stormState"]>) {
  return { time: s.time, intensity: s.intensity, phase: s.phase, windSpeed: s.windSpeed, fogDensity: s.fogDensity, devils: s.devils.map((d) => ({ coreRadius: d.coreRadius, swirl: d.swirl })), piles: s.piles };
}

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
