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
import { afterEach, assertCloseTo, assertMatchObject, finish, group, spyFunction, stubGlobal, test, unstubAllGlobals } from "selrun";

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
  Vec3,
  VehicleComponent,
  findGpuParticleWorlds,
} from "@forge/engine";
import { buildMarsDustStormScene, STORM_TIER_PARTICLES, STORM_TIER_ROUTE_INTERVAL } from "../../examples/src/scenes/marsDustStormScene.js";
import { BURIAL_STUCK, STORM_DIFFICULTY, STORM_QUALITY_TIERS, stormParticleBudget, type StormDifficulty } from "../../examples/src/scenes/dustStorm.js";
import type { GlbLoadProgress, LoadedGlb } from "../../examples/src/assets/glb.js";
import { YMCA_TOTAL } from "../../examples/src/scenes/dustStormRoute.js";

const mockLoadGlb = async (device: unknown, _url: string, onProgress?: (progress: GlbLoadProgress) => void): Promise<LoadedGlb> => {
  const engine = await import("@forge/engine");
  const geometries: { dispose(): void }[] = [];
  const material = engine.Material.unlit({ label: "mock-storm-rover", color: 0xb06030 });
  const box = (name: string) => {
    const geometry = engine.Geometry.create(device as GraphicsDevice, engine.boxGeometrySource({ width: 0.4, height: 0.4, depth: 0.4 }));
    geometries.push(geometry);
    return { name, geometry, material };
  };
  // A body mesh with a front-right rocker arm baked in (fe-28 splits it back out).
  const merged = (() => {
    const deck = engine.boxGeometrySource({ width: 0.4, height: 0.4, depth: 0.4 });
    const arm = engine.boxGeometrySource({ width: 0.1, height: 0.1, depth: 0.4 });
    const armPos = arm.positions.map((v, i) => v + [1.0, 0.6, 0.6][i % 3]!);
    const n = deck.positions.length / 3;
    const indices = new Uint32Array([...deck.indices!, ...[...arm.indices!].map((i) => i + n)]);
    const join = (a?: Float32Array | null, b?: Float32Array | null) => (a && b ? Float32Array.from([...a, ...b]) : null);
    const geometry = engine.Geometry.create(device as GraphicsDevice, { positions: Float32Array.from([...deck.positions, ...armPos]), normals: join(deck.normals, arm.normals), uvs: join(deck.uvs, arm.uvs), indices });
    geometries.push(geometry);
    return { name: "deck", geometry, material };
  })();
  onProgress?.({ phase: "done", receivedBytes: 1, totalBytes: 1 });
  return {
    body: [merged],
    wheels: ["wheel_FL", "wheel_FR", "wheel_ML", "wheel_MR", "wheel_RL", "wheel_RR"].map((name) => ({
      name,
      hub: [0, 0, 0] as [number, number, number],
      parts: [box(`${name}-tire`)],
    })),
    mast: null,
    arm: {
      joints: [
        { name: "arm", joint: "azimuth", offset: [0.5, 0.8, 1.0], axis: [0, 1, 0], parts: [box("arm-base")] },
        { name: "arm_shoulder", joint: "shoulder", offset: [0, 0, 0.2], axis: [1, 0, 0], parts: [box("arm-upper")] },
      ],
    },
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

async function fixture(difficulty: StormDifficulty = "easy", tickWhileLoading = true, courseSeed = 1234) {
  const windowStub = new EventTarget();
  stubGlobal("window", windowStub);
  const buttons = { "btn-storm-easy": fakeButton(), "btn-storm-advanced": fakeButton(), "btn-storm-expert": fakeButton(), "btn-storm-unreal": fakeButton(), "storm-difficulty": fakeButton() };
  stubGlobal("document", { getElementById: (id: string) => (buttons as Record<string, unknown>)[id] ?? null });
  stubGlobal("fetch", spyFunction(() => new Promise<Response>(() => {})));
  const gpu = await GraphicsDevice.create({ forceMock: true });
  const engine = { gpu, tasks: undefined as unknown as TaskScheduler } as Engine;
  const handle = buildMarsDustStormScene(engine, { loadGlb: mockLoadGlb, difficulty, quality: "reduced", courseSeed, deviceHints: {}, adaptiveQuality: false });
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
    handle.setDifficulty("expert");
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
      assert.ok(Math.hypot(sys.modules.attractorPos.x - d.x, sys.modules.attractorPos.z - d.z) <= 10 + 1e-6, "wander stays bounded");
    }
  });
});

group("Mars Dust Storm Survival — difficulty buttons (fe-29: four levels)", () => {
  test("the toolbar and touch toggles switch the rules and restart the run; the URL value seeds them", async () => {
    const { handle, scene, buttons, vehicle, tick, key } = await fixture("expert");
    assert.equal(buttons["btn-storm-expert"].classList.contains("active"), true, "seeded from ?difficulty");
    assert.equal(buttons["storm-difficulty"].caption.textContent, "EXPERT");
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
    assert.equal(buttons["btn-storm-expert"].getAttribute("aria-pressed"), "false");
    assert.equal(buttons["storm-difficulty"].letter.textContent, "E");
    // The touch pad cycles Easy → Advanced → Expert → Unreal.
    buttons["storm-difficulty"].dispatchEvent(new Event("click"));
    s = handle.stormState();
    assert.equal(s.difficulty, "advanced");
    assert.equal(buttons["storm-difficulty"].caption.textContent, "ADVANCED");
    buttons["btn-storm-unreal"].dispatchEvent(new Event("click"));
    assert.equal(handle.stormState().difficulty, "unreal");
    assert.equal(buttons["storm-difficulty"].classList.contains("active"), true);
    buttons["storm-difficulty"].dispatchEvent(new Event("click"));
    assert.equal(handle.stormState().difficulty, "easy", "wraps around");
    // Hard rules are live after the switch: burial sends the rover back.
    handle.setDifficulty("expert");
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

    handle.setDifficulty("expert");
    assert.deepEqual({ ...handle.stormState(), difficulty: "easy", stormStrength: fresh.stormStrength }, fresh, "the toggle restarts everything too");
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
    const { handle, vehicle, tick, key } = await fixture("expert");
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
    const hard = await fixture("expert");
    start(hard.key, hard.tick);
    for (let i = 0; i < 40 && hard.handle.stormState().resets === 0; i++) {
      hard.vehicle.roll = 1.9;
      hard.tick(0.1);
    }
    assert.equal(hard.handle.stormState().resets, 1);
    assert.equal(hard.handle.stormState().flipped, false);
  });
});


group("Mars Dust Storm Survival — fe-29 blown away", () => {
  test("easy: thrown far by the wind respawns at the last safe spot with invulnerability", async () => {
    const { handle, vehicle, tick, key } = await fixture("easy");
    start(key, tick);
    for (let i = 0; i < 20; i++) tick(0.1); // settle: the start becomes the safe spot
    const safe = handle.stormState().safe;
    handle.debugBlow(45, 0);
    tick(0.05);
    const s = handle.stormState();
    assert.equal(s.blownAway, 1);
    assert.equal(s.lost, false);
    assert.ok(Math.hypot(s.x - safe.x, s.z - safe.z) < 0.5, "back at the safe spot");
    assertCloseTo(vehicle.yaw, safe.yaw, 4);
    assert.ok(s.invulnerable > 2.5);
    assert.match(handle.overlay!(), /BLOWN AWAY/);
  });

  test("advanced respawns like easy; unreal loses like expert", async () => {
    for (const [d, lost] of [["advanced", false], ["unreal", true]] as const) {
      const { handle, tick, key } = await fixture(d);
      start(key, tick);
      for (let i = 0; i < 20; i++) tick(0.1);
      handle.debugBlow(45, 0);
      tick(0.05);
      assert.equal(handle.stormState().lost, lost, d);
      assert.equal(handle.stormState().blownAway, 1);
      await cleanups.pop()!();
    }
  });

  test("expert: thrown far loses the run ('Blown away'); R restarts", async () => {
    const { handle, tick, key } = await fixture("expert");
    start(key, tick);
    for (let i = 0; i < 20; i++) tick(0.1);
    handle.debugBlow(0, 45);
    tick(0.05);
    const s = handle.stormState();
    assert.equal(s.lost, true);
    assert.equal(s.lostReason, "BLOWN AWAY");
    const t = s.elapsed;
    tick(0.5);
    assert.equal(handle.stormState().elapsed, t, "clock stops");
    assert.match(handle.overlay!(), /RUN LOST/);
    assert.equal(handle.stormState().summaryVisible, true, "summary on loss");
    assert.equal(handle.summary().title, "Lost — Blown away");
    handle.restart();
    assert.equal(handle.stormState().lost, false);
  });

  test("completion: the summary waits for the finale to end; stats track the run; retry resets them", async () => {
    const { handle, tick, key } = await fixture("easy");
    start(key, tick);
    key("keydown", "KeyW");
    for (let i = 0; i < 60; i++) tick(0.1);
    key("keyup", "KeyW");
    assert.ok(handle.stormState().stats.distance > 0.3, `distance ${handle.stormState().stats.distance}`);
    assert.ok(handle.stormState().stats.topSpeed > 0.5);
    assert.ok(handle.stormState().stats.maxWind > 0);
    for (const cp of handle.stormState().checkpoints) {
      handle.teleport(cp.x, cp.z);
      tick(0.05);
    }
    assert.equal(handle.stormState().won, true);
    assert.equal(handle.stormState().summaryVisible, false, "not during the finale");
    handle.advanceFinale(1000);
    tick(0.05);
    tick(0.05);
    assert.equal(handle.stormState().summaryVisible, true);
    const rows = Object.fromEntries(handle.summary().rows);
    assert.equal(rows["Result"], "Completed");
    assert.equal(rows["Waypoints reached"], `${handle.stormState().checkpointCount} / ${handle.stormState().checkpointCount}`);
    handle.restart();
    assert.equal(handle.stormState().summaryVisible, false);
    assert.equal(handle.stormState().stats.distance, 0);
  });

  test("driving far in still air never counts as blown away", async () => {
    const { handle, tick, key } = await fixture("easy");
    start(key, tick);
    key("keydown", "KeyW");
    for (let i = 0; i < 300; i++) tick(0.1);
    key("keyup", "KeyW");
    assert.equal(handle.stormState().blownAway, 0);
  });
});

group("Mars Dust Storm Survival — fe-28 polish", () => {
  test("random course per seed: same seed replays, another seed moves the beams; the route dodges every boulder", async () => {
    const a = await fixture("easy", true, 11);
    const sa = a.handle.stormState();
    assert.equal(sa.courseSeed, 11);
    const b = await fixture("easy", true, 11);
    assert.deepEqual(b.handle.stormState().checkpoints, sa.checkpoints);
    const c = await fixture("easy", true, 12);
    assert.notDeepEqual(c.handle.stormState().checkpoints, sa.checkpoints);
    for (const fx of [a, c]) {
      fx.tick();
      const route = fx.handle.stormState().guideRoute;
      assert.ok(route.length >= 2);
      const rocks = named(fx.scene, "storm-boulder-").map((e) => ({ x: e.transform.position.x, z: e.transform.position.z, r: e.transform.scale.x }));
      assert.ok(rocks.length > 10);
      for (let i = 0; i < route.length - 1; i++) {
        const p = route[i]!;
        const q = route[i + 1]!;
        for (let k = 1; k < 40; k++) {
          const x = p.x + ((q.x - p.x) * k) / 40;
          const z = p.z + ((q.z - p.z) * k) / 40;
          for (const r of rocks) assert.ok(Math.hypot(x - r.x, z - r.z) >= r.r * 0.85 + 1.3, `route clips a boulder at ${x.toFixed(1)},${z.toFixed(1)}`);
        }
      }
    }
  });

  test("the arrow shows only while the beam is off screen", async () => {
    const { handle, scene, tick } = await fixture();
    const cam = named(scene, "camera")[0]!;
    const beam = named(scene, "storm-beam-ring-0")[0]!.transform.position;
    const eye = { x: handle.stormState().x - 10, z: handle.stormState().z - 10 };
    // Look straight at the beam from behind the rover: on screen → no arrow.
    const look = () => {
      cam.transform.position = new Vec3(eye.x, beam.y + 6, eye.z);
      cam.transform.lookAt(new Vec3(beam.x, beam.y + 6, beam.z));
    };
    look();
    for (let i = 0; i < 20; i++) { look(); tick(0.1); }
    assert.equal(handle.stormState().arrowVisible, false, "beam in view: arrow hidden");
    // Turn the camera to face directly away from the beam: off screen → arrow.
    const away = () => {
      cam.transform.position = new Vec3(eye.x, beam.y + 6, eye.z);
      cam.transform.lookAt(new Vec3(eye.x * 2 - beam.x, beam.y + 6, eye.z * 2 - beam.z));
    };
    for (let i = 0; i < 20; i++) { away(); tick(0.1); }
    assert.equal(handle.stormState().arrowVisible, true, "beam behind the camera: arrow shown");
    for (let i = 0; i < 20; i++) { look(); tick(0.1); }
    assert.equal(handle.stormState().arrowVisible, false, "back in view: hidden again");
  });

  test("no gear selector: brake from rest backs the rover up, gas drives it forward again", async () => {
    const { handle, vehicle, tick, key } = await fixture();
    key("keydown", "KeyS");
    for (let i = 0; i < 90; i++) tick();
    assert.equal(handle.stormState().gear, -1);
    const fwd = vehicle.velocity.x * Math.sin(vehicle.yaw) + vehicle.velocity.z * Math.cos(vehicle.yaw);
    assert.ok(fwd < -0.2, `backing up at ${fwd}`);
    key("keyup", "KeyS");
    key("keydown", "KeyW");
    for (let i = 0; i < 240; i++) tick();
    key("keyup", "KeyW");
    assert.equal(handle.stormState().gear, 1);
    const fwd2 = vehicle.velocity.x * Math.sin(vehicle.yaw) + vehicle.velocity.z * Math.cos(vehicle.yaw);
    assert.ok(fwd2 > 0.2, `driving forward at ${fwd2}`);
  });

  test("finale: the last beam clears the sky and the rover stands up for Y-M-C-A; R puts it all back", async () => {
    const { handle, scene, vehicle, tick, key } = await fixture();
    start(key, tick);
    const count = handle.stormState().checkpointCount;
    for (let i = 0; i < count; i++) {
      const beam = named(scene, `storm-beam-ring-${i}`)[0]!;
      vehicle.position.x = beam.transform.position.x;
      vehicle.position.z = beam.transform.position.z;
      tick();
    }
    assert.equal(handle.stormState().won, true);
    assert.equal(scene.settings.skyEnabled, false, "clearing starts from the dust backdrop");
    const letters: string[] = [];
    const chassis = named(scene, "rover-chassis")[0]!;
    let maxNoseUp = 0;
    for (let i = 0; i < 12 * 30; i++) {
      tick(1 / 30);
      const l = handle.stormState().dance;
      if (l && letters[letters.length - 1] !== l) letters.push(l);
      const f = new Vec3();
      chassis.transform.rotation.rotateVector(Vec3.unitZ, f);
      maxNoseUp = Math.max(maxNoseUp, f.y);
    }
    const s = handle.stormState();
    assert.equal(s.clearSky, 1);
    assert.equal(scene.settings.skyEnabled, true, "the analytic Mars sky is back");
    assert.ok(s.fogDensity < 0.004, `clear-day haze ${s.fogDensity}`);
    assert.equal(s.dancing, true);
    assert.deepEqual(letters.slice(0, 4), ["Y", "M", "C", "A"]);
    assert.ok(maxNoseUp > 0.85, `stands on its rear wheels (nose-up ${maxNoseUp})`);
    // The upper wheels leave their rest hubs while the rear pair stays on the ground.
    const wheels = MARS_WHEELS.map((n) => named(scene, `rover-${n}`)[0]!.transform.position);
    assert.ok(wheels[0]!.y - wheels[4]!.y > 1.5, "front wheel raised high above the rear");
    key("keydown", "KeyR");
    key("keyup", "KeyR");
    const r = handle.stormState();
    assert.equal(r.dancing, false);
    assert.equal(r.clearSky, 0);
    assert.equal(scene.settings.skyEnabled, false);
    assert.ok(scene.world.getComponent(chassis.id, VehicleComponent), "physics re-attached");
  });

  test("finale clip: arms + robotic arm dance, rainbow stage lights sweep, then lights out and the rover lowers back onto its wheels", async () => {
    const { handle, scene, vehicle, tick, key } = await fixture();
    start(key, tick);
    const chassis = named(scene, "rover-chassis")[0]!;
    const arm = named(scene, "rover-susp-front+")[0]!;
    assert.ok(arm, "front-right suspension arm split out of the body");
    assert.equal(named(scene, "rover-susp-middle-").length, 0, "only pieces with triangles are created");
    const joint = named(scene, "rover-arm_shoulder")[0]!;

    const restY = vehicle.position.y;
    const count = handle.stormState().checkpointCount;
    for (let i = 0; i < count; i++) {
      const beam = named(scene, `storm-beam-ring-${i}`)[0]!;
      vehicle.position.x = beam.transform.position.x;
      vehicle.position.z = beam.transform.position.z;
      tick();
    }
    assert.equal(handle.stormState().won, true);
    const phases: string[] = [];
    let armMoved = 0;
    let jointMoved = 0;
    let lightsMax = 0;
    let sweepMin = 0;
    let sweepMax = 0;
    let beamsSeen = false;
    for (let i = 0; i < Math.ceil((YMCA_TOTAL + 1) * 30); i++) {
      tick(1 / 30);
      const s = handle.stormState();
      if (s.dancePhase && phases[phases.length - 1] !== s.dancePhase) phases.push(s.dancePhase);
      if (s.dancePhase === "dance") {
        armMoved = Math.max(armMoved, Math.hypot(arm.transform.position.x, arm.transform.position.z), 1 - Math.abs(arm.transform.rotation.w));
        jointMoved = Math.max(jointMoved, 1 - Math.abs(joint.transform.rotation.w));
        lightsMax = Math.max(lightsMax, s.stageLights);
        sweepMin = Math.min(sweepMin, s.stageSweep);
        sweepMax = Math.max(sweepMax, s.stageSweep);
        beamsSeen ||= named(scene, "storm-stage-beam-").some((e) => scene.world.getComponent(e.id, Renderable)?.visible === true);
      }
    }
    assert.deepEqual(phases, ["rise", "dance", "lower", "done"]);
    assert.ok(armMoved > 0.05, `suspension arm moves with its wheel (${armMoved})`);
    assert.ok(jointMoved > 0.01, `robotic arm joint animates (${jointMoved})`);
    assert.equal(lightsMax, 1);
    assert.ok(sweepMin < -0.9 && sweepMax > 0.9, "lights sweep left and right");
    assert.ok(beamsSeen, "stage beams visible during the dance");
    const s = handle.stormState();
    assert.equal(s.dancing, false);
    assert.equal(s.stageLights, 0);
    assert.ok(named(scene, "storm-stage-beam-").every((e) => scene.world.getComponent(e.id, Renderable)?.visible === false), "lights gone after the clip");
    assert.ok(scene.world.getComponent(chassis.id, VehicleComponent), "physics re-attached after lowering");
    assert.deepEqual([arm.transform.rotation.x, arm.transform.rotation.y, arm.transform.rotation.z, arm.transform.rotation.w], [0, 0, 0, 1]);
    assert.equal(joint.transform.rotation.w, 1);
    // Back on all six wheels: level chassis at ride height.
    const f = new Vec3();
    chassis.transform.rotation.rotateVector(Vec3.unitZ, f);
    assert.ok(Math.abs(f.y) < 0.2, `nose level again (${f.y})`);
    assert.ok(Math.abs(vehicle.position.y - restY) < 3, "rover on the ground");
    assert.equal(s.won, true, "still a win; no restart");
  });

  test("the F/N/R gear selector is hidden in the dust storm", async () => {
    const { readFileSync } = await import("node:fs");
    const html = readFileSync(new URL("../../examples/index.html", import.meta.url), "utf8");
    assert.match(html, /body\.scene-vehicle:not\(\.scene-mars\):not\(\.scene-storm\) \.veh-gear-switch \{ display: grid; \}/);
  });
});

const MARS_WHEELS = ["wheel_FL", "wheel_FR", "wheel_ML", "wheel_MR", "wheel_RL", "wheel_RR"];


group("Mars Dust Storm Survival — device tier + random start (fe-28)", () => {
  test("random start is 10–20 % farther from beam 1 than the surveyed spawn; the rover spawns there", async () => {
    const { handle, vehicle } = await fixture();
    const s = handle.stormState();
    assert.equal(s.start.fallback, false);
    const first = s.checkpoints[0]!;
    const base = Math.hypot(first.x + 164, first.z - 4);
    const d = Math.hypot(first.x - s.start.x, first.z - s.start.z);
    assert.ok(d >= base * 1.1 - 1e-6 && d <= base * 1.2 + 1e-6, `${d} vs ${base}`);
    assert.ok(Math.hypot(vehicle.position.x - s.start.x, vehicle.position.z - s.start.z) < 0.01);
  });
  test("device tier picks the route interval / particle scale; hints classify, ?tier forces", async () => {
    const { handle } = await fixture();
    assert.equal(handle.deviceQuality.tier, "high");
    const gpu = await GraphicsDevice.create({ forceMock: true });
    const engine = { gpu, tasks: undefined as unknown as TaskScheduler } as Engine;
    const phone = buildMarsDustStormScene(engine, { loadGlb: mockLoadGlb, quality: "reduced", courseSeed: 1234, deviceHints: { mobile: true, hardwareConcurrency: 8 }, adaptiveQuality: false });
    assert.equal(phone.deviceQuality.tier, "medium");
    const forced = buildMarsDustStormScene(engine, { loadGlb: mockLoadGlb, quality: "reduced", courseSeed: 1234, deviceHints: {}, deviceTier: "low", adaptiveQuality: false });
    assert.equal(forced.deviceQuality.tier, "low");
    // Let both mock model loads settle before tearing the device down.
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
    phone.dispose?.();
    forced.dispose?.();
    await gpu.dispose();
    assert.ok(STORM_TIER_ROUTE_INTERVAL.medium > STORM_TIER_ROUTE_INTERVAL.high && STORM_TIER_ROUTE_INTERVAL.low > STORM_TIER_ROUTE_INTERVAL.medium);
    assert.ok(STORM_TIER_PARTICLES.low < STORM_TIER_PARTICLES.high);
  });
});

await finish();
