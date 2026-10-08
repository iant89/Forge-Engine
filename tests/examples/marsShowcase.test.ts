/**
 * @suite examples:marsShowcase
 * @group integration
 * @covers engine/src/core/engine.ts
 * @covers engine/src/core/log.ts
 * @covers engine/src/core/tasks/scheduler.ts
 * @covers engine/src/core/time.ts
 * @covers engine/src/debug/profiler.ts
 * @covers engine/src/gpu/device.ts
 * @covers engine/src/index.ts
 * @covers engine/src/math/vec.ts
 * @covers engine/src/particles/world.ts
 * @covers engine/src/population/world.ts
 * @covers engine/src/rendering/splatMaterial.ts
 * @covers engine/src/scene/components/index.ts
 * @covers engine/src/scene/systems.ts
 * @covers engine/src/terrain/chunk.ts
 * @covers engine/src/terrain/mars/config.ts
 * @covers engine/src/terrain/mars/stage.ts
 * @covers engine/src/terrain/world.ts
 * @covers engine/src/vehicles/components.ts
 * @covers engine/src/vehicles/electric.ts
 * @covers engine/src/vehicles/ground.ts
 * @covers examples/src/controls/orbitControls.ts
 * @covers examples/src/scenes/marsShowcaseScene.ts
 * @desc The actual Mars Showcase assembly on the strict mock GPU. Only the browser DOM and the pending
 */

export const suite = {
  name: "examples:marsShowcase",
  group: "integration",
  covers:   [
    "engine/src/core/engine.ts",
    "engine/src/core/log.ts",
    "engine/src/core/tasks/scheduler.ts",
    "engine/src/core/time.ts",
    "engine/src/debug/profiler.ts",
    "engine/src/gpu/device.ts",
    "engine/src/index.ts",
    "engine/src/math/vec.ts",
    "engine/src/particles/world.ts",
    "engine/src/population/world.ts",
    "engine/src/rendering/splatMaterial.ts",
    "engine/src/scene/components/index.ts",
    "engine/src/scene/systems.ts",
    "engine/src/terrain/chunk.ts",
    "engine/src/terrain/mars/config.ts",
    "engine/src/terrain/mars/stage.ts",
    "engine/src/terrain/world.ts",
    "engine/src/vehicles/components.ts",
    "engine/src/vehicles/electric.ts",
    "engine/src/vehicles/ground.ts",
    "examples/src/controls/orbitControls.ts",
    "examples/src/scenes/marsShowcaseScene.ts"
  ],
  desc: "The actual Mars Showcase assembly on the strict mock GPU. Only the browser DOM and the pending",
};
/**
 * The actual Mars Showcase assembly on the strict mock GPU. Only the browser DOM and the pending
 * GLB fetch are stubbed; terrain, textures, streaming, camera and six-wheel vehicle are real.
 * This pins the scene's use of the port (not just the factory in isolation), a traversable landing
 * site, one shared heightfield before/after upload, and bounded inline streaming with LOD skirts.
 * The real model, pixels, keyboard drive and dust are also exercised by check:browser.
 */
import assert from "node:assert/strict";
import { afterEach, assertCallCount, assertCloseTo, assertContains, assertMatchObject, assertMatches, assertNotCalled, assertNotContains, finish, group, spyFunction, spyOn, stringContaining, stubGlobal, test, unstubAllGlobals } from "selrun";
import {
  Clock,
  ElectricMotor,
  GraphicsDevice,
  Logger,
  MARS_GEN_PARAMS,
  MarsTerrainStage,
  ParticleWorld,
  PopulationWorld,
  Profiler,
  ReductionDrive,
  Renderable,
  SplatMaterial,
  SystemScratch,
  TaskScheduler,
  TerrainWorld,
  Vec3,
  VehicleComponent,
  chunkCoordKey,
  flatGround,
  heightFunctionGround,
  slopeGround,
  type Engine,
  type SystemContext,
  type TerrainTile,
} from "@forge/engine";
import { createWorkerThreadPool } from "../support/workerThreads.js";
import { OrbitControls } from "../../examples/src/controls/orbitControls.js";
import {
  buildMarsShowcaseScene,
  layoutBreakFragments,
  MARS_SHOWCASE_SITE,
} from "../../examples/src/scenes/marsShowcaseScene.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  unstubAllGlobals();
});

async function fixture(scheduler?: TaskScheduler) {
  const windowStub = new EventTarget();
  stubGlobal("window", windowStub);
  stubGlobal("document", { getElementById: () => null });
  // Hold the model at its loading placeholder. No network or image decoder is needed for these
  // terrain tests; the GLB content/attachment is covered by roverGlb.test and the browser gate.
  const fetchStub = spyFunction(() => new Promise<Response>(() => {}));
  stubGlobal("fetch", fetchStub);
  const gpu = await GraphicsDevice.create({ forceMock: true });
  const engine = { gpu, tasks: scheduler } as Engine;
  const handle = buildMarsShowcaseScene(engine);
  const scene = handle.scene;
  scene.attachToEngine(engine); // Upload actual tile geometry to the mock, not a headless metadata path.
  const terrain = scene.object<TerrainWorld>("TerrainWorld")!;
  const component = scene.world.getComponent(scene.world.findByName("rover-chassis")[0]!, VehicleComponent)!;
  const canvas = {
    clientHeight: 720,
    addEventListener() {},
    removeEventListener() {},
    setPointerCapture() {},
    releasePointerCapture() {},
  } as unknown as HTMLElement;
  const controls = new OrbitControls(handle.cameraEntity, canvas).configure(handle.camera!);
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
    services: {
      get: <T>(key: string) => key === "tasks" ? scheduler as T | undefined : undefined,
      engineConfig: {},
    },
    scratch: new SystemScratch(),
  } satisfies SystemContext;
  cleanups.push(async () => {
    controls.dispose();
    handle.dispose?.();
    await gpu.dispose();
    assert.deepEqual(gpu.mock.outstanding.buffers, []);
    assert.deepEqual(gpu.mock.outstanding.textures, []);
  });
  const tick = (): void => {
    context.frame++;
    context.elapsed += context.dt;
    handle.update(context.dt);
    const target = handle.followTarget!();
    controls.target.set(target.x, target.y, target.z);
    controls.update();
    scene.update(context, context.dt);
  };
  const key = (type: "keydown" | "keyup", code: string): void => {
    windowStub.dispatchEvent(Object.assign(new Event(type), { code, repeat: false }));
  };
  return { handle, scene, terrain, component, controls, context, fetchStub, tick, key, gpu };
}

function tileAt(terrain: TerrainWorld, x: number, z: number): TerrainTile {
  const key = chunkCoordKey(Math.floor(x / terrain.chunkSize), Math.floor(z / terrain.chunkSize));
  const tile = terrain.chunks.get(key)?.tile;
  assert.ok(tile, `resident tile at ${key}`);
  return tile!;
}

group("Mars Showcase — ported terrain integration", () => {
  test("uses the unmodified generator seed/site without an erosion fetch, ready for workers", async () => {
    const { handle, terrain, fetchStub } = await fixture();
    assert.equal((terrain.pipeline.stages).length, 1);
    const stage = terrain.pipeline.stages[0] as MarsTerrainStage;
    assert.ok(stage instanceof MarsTerrainStage);
    assert.deepEqual(stage.params, MARS_GEN_PARAMS);
    assert.equal(stage.site.latDeg, MARS_SHOWCASE_SITE.latDeg);
    assert.equal(stage.site.lonDeg, MARS_SHOWCASE_SITE.lonDeg);
    assert.equal(stage.site.headingDeg, MARS_SHOWCASE_SITE.headingDeg);
    assert.equal(stage.detail, true);
    assert.equal(stage.curvatureCompensation, true);
    assert.equal(stage.globalFields, null);
    assert.equal(stage.hasErosionCorrection, false);
    assert.equal(terrain.seed, 1337);
    assert.equal(terrain.syncGeneration, false);
    assert.equal(terrain.chunkSize, 128);
    assert.equal(terrain.chunkResolution, 33);
    assert.equal(terrain.skirtDepth, 32);
    assert.equal(terrain.budgets.generationsPerFrame, 1);
    assert.equal(terrain.warmUpChunks, 9);
    assertCallCount(fetchStub, 1);
    assertMatches(fetchStub.mock.calls[0], [stringContaining("Perseverance.glb")]);
    assertMatchObject(handle.marsState(), {
      terrainGenerator: "mars",
      terrainHasErosion: false,
      terrainGeneration: "inline", // This fixture has no scheduler; fallback remains functional.
      terrainReadyChunks: 0,
      terrainRoverChunkReady: false,
    });
    assertContains(handle.overlay?.(), "analytic only (no erosion cache)");
  });

  test("uploads the actual Mars weights into tile-owned masks and toggles layering without changing geometry", async () => {
    const { handle, terrain, scene, context, gpu } = await fixture();
    terrain.update(context, context.dt);
    const state = handle.marsState();
    assert.equal(state.terrainMaterialMode, "layered");
    assert.deepEqual(state.terrainMaterialLayers, ["dust", "rock", "sand", "crust"]);
    assert.equal(state.terrainSplatTiles, 9);
    const ready = [...terrain.chunks.values()].filter((chunk) => chunk.tile?.gpuMaterial);
    for (const chunk of ready) {
      const tile = chunk.tile!;
      const material = tile.gpuMaterial!;
      assert.ok(material instanceof SplatMaterial);
      assert.equal(material.maps.albedo, terrain.layeredMaterial!.maps!.albedo);
      assert.equal(material.maps.albedo.desc.depthOrArrayLayers, 4);
      const mask = [...gpu.mock.liveTextures].find((t) => t.label === material.weightMap.desc.label)!;
      assert.deepEqual(mask.texelBytes(), terrain.layeredMaterial!.weightPixels(tile.cell));
    }
    const geometries = ready.map((chunk) => chunk.tile!.gpuGeometry);
    terrain.setLayeredMaterialsEnabled(false);
    assert.equal(handle.marsState().terrainMaterialMode, "single");
    for (const chunk of ready) assert.equal(scene.world.getComponent(chunk.entityId!, Renderable)!.material, terrain.material);
    terrain.setLayeredMaterialsEnabled(true);
    assert.deepEqual(ready.map((chunk) => chunk.tile!.gpuGeometry), geometries);
    assert.equal(handle.marsState().terrainGroundHeight, state.terrainGroundHeight);
    assert.equal(handle.marsState().contactWheels, 6);
  });

  test("uploads worker-generated opening tiles without regenerating the Mars stage on main", async () => {
    // Use the shipping worker bootstrap, not test-preinstalled terrain handlers.
    const pool = await createWorkerThreadPool({ installEngineHandlers: false });
    const scheduler = new TaskScheduler({ workerCount: 2, createWorker: (i) => pool.createWorker(i) });
    cleanups.push(async () => { scheduler.dispose(); await pool.dispose(); });
    const { handle, terrain, context } = await fixture(scheduler);
    const initial = handle.marsState();
    const stage = terrain.pipeline.stages[0] as MarsTerrainStage;
    const process = spyOn(stage, "process");
    terrain.update(context, context.dt);
    const submitted = terrain.streamingStats.scheduledThisFrame;
    assert.ok(submitted > 0);
    assert.equal([...terrain.chunks.values()].some((c) => c.state === "generating"), true);
    assertNotCalled(process); // Only the spawn/query cache may hit inline.
    await scheduler.drain();
    assert.equal(scheduler.stats.completed, submitted);
    assert.equal(scheduler.stats.inlineFallbacks, 0);
    assert.equal(scheduler.stats.failed, 0);
    assert.equal(scheduler.stats.workerFailures, 0);
    terrain.update(context, context.dt); // Drain the worker results through the normal upload path.
    assertNotCalled(process);
    const state = handle.marsState();
    assert.equal(state.terrainGeneration, "workers");
    assert.ok(state.terrainReadyChunks >= terrain.warmUpChunks);
    assert.equal(state.terrainRoverChunkReady, true);
    assert.equal(state.terrainGroundHeight, initial.terrainGroundHeight);
    assert.equal(state.contactWheels, 6);
    for (const chunk of terrain.chunks.values()) {
      if (chunk.state === "ready") assert.notEqual(chunk.tile?.gpuGeometry, null);
    }
    process.mockRestore();
  });

  test("uses the scheduler's no-worker fallback without failed tasks or a different surface", async () => {
    const scheduler = new TaskScheduler({ inline: true });
    cleanups.push(async () => { scheduler.dispose(); });
    const { handle, terrain, context } = await fixture(scheduler);
    const initial = handle.marsState();
    terrain.update(context, context.dt);
    await scheduler.drain();
    terrain.update(context, context.dt);
    assert.ok(scheduler.stats.completed > 0);
    assert.equal(scheduler.stats.failed, 0);
    assertMatchObject(handle.marsState(), {
      terrainGeneration: "inline", terrainRoverChunkReady: true, terrainGroundHeight: initial.terrainGroundHeight,
    });
  });

  test("lands on a gentle surface that does not jump when the opening tiles become resident", async () => {
    const { handle, terrain, component, context } = await fixture();
    const v = component.vehicle;
    const start = handle.marsState();
    assert.equal(start.contactWheels, 6);
    assert.ok(terrain.getSlopeAt(start.x, start.z) < 5 * Math.PI / 180);
    assert.ok(start.y - start.terrainGroundHeight > 0.45);
    assert.ok(start.y - start.terrainGroundHeight < 0.65);
    const before = v.wheels.map((w) => terrain.getHeightAt(w.contactX, w.contactZ));

    terrain.update(context, context.dt);
    assert.equal(terrain.streamingStats.generatedThisFrame, 9);
    assert.equal(terrain.streamingStats.scheduledThisFrame, 0);
    assertMatchObject(handle.marsState(), { terrainReadyChunks: 9, terrainRoverChunkReady: true });
    assert.ok(handle.marsState().terrainResidentBytes > 0);
    assert.equal(terrain.getHeightAt(start.x, start.z), start.terrainGroundHeight);
    const sample = { height: 0, nx: 0, ny: 1, nz: 0 };
    for (const [i, wheel] of v.wheels.entries()) {
      const tile = tileAt(terrain, wheel.contactX, wheel.contactZ);
      assert.notEqual(tile.gpuGeometry, null);
      assert.equal(tile.resolution, 33);
      component.ground.sample(wheel.contactX, wheel.contactZ, sample);
      assert.equal(sample.height, before[i]);
      assert.equal(sample.height, tile.heightmap.getHeight(wheel.contactX, wheel.contactZ));
      // The wheel ray's three-iteration intersection agrees within a millimetre, not just with
      // the analytic point sampler (which bypasses the rendered grid and must NOT be used here).
      assert.ok(Math.abs(wheel.contactY - sample.height) < 0.001);
    }

    const tile = tileAt(terrain, start.x, start.z);
    const stage = terrain.pipeline.stages[0] as MarsTerrainStage;
    const positions = tile.geometrySource.positions;
    for (let j = 0; j < tile.resolution; j += 4) {
      for (let i = 0; i < tile.resolution; i += 4) {
        const vertex = j * tile.resolution + i;
        const x = positions[vertex * 3]!;
        const y = positions[vertex * 3 + 1]!;
        const z = positions[vertex * 3 + 2]!;
        assert.equal(y, tile.heightmap.heights[vertex]);
        assert.ok(Math.abs(y - stage.sampleElevation(x, z)) < 1e-4);
      }
    }
  });

  test("drives the scene's six-wheel rover with W on the ported grid and throws wheel dust", async () => {
    const { handle, scene, terrain, component, tick, key } = await fixture();
    const wheelDust = scene.objects.filter(
      (object): object is ParticleWorld =>
        object instanceof ParticleWorld && object.name.startsWith("dust-kick-wheel-"),
    );
    const wheelChips = scene.objects.filter(
      (object): object is ParticleWorld =>
        object instanceof ParticleWorld && object.name.startsWith("rover-debris-wheel-"),
    );
    assert.deepEqual(wheelDust.map((dust) => dust.name).sort(), Array.from({ length: 6 }, (_, index) => `dust-kick-wheel-${index}`));
    assert.deepEqual(wheelChips.map((chips) => chips.name).sort(), Array.from({ length: 6 }, (_, index) => `rover-debris-wheel-${index}`));
    tick();
    const start = handle.marsState();
    key("keydown", "KeyW");
    let minContact = 6;
    let maxKick = 0;
    let maxChips = 0;
    let maxSpeed = 0;
    for (let i = 0; i < 360; i++) {
      tick();
      const state = handle.marsState();
      minContact = Math.min(minContact, state.contactWheels);
      maxKick = Math.max(maxKick, state.kickDust);
      maxChips = Math.max(maxChips, state.kickDebris);
      maxSpeed = Math.max(maxSpeed, state.speed);
      assert.equal(state.terrainRoverChunkReady, true);
      assert.ok(state.y - state.terrainGroundHeight > 0.35);
      assert.ok(state.y - state.terrainGroundHeight < 0.8);
    }
    key("keyup", "KeyW");
    assert.ok(handle.marsState().z - start.z > 6);
    assert.ok(minContact >= 4);
    assert.ok(maxSpeed > 1);
    assert.ok(maxSpeed < 2.5); // Gentle uphill, not the runaway downhill summit spawn.
    assert.ok(maxKick > 0);
    assert.ok(maxChips > 0);
    const emissionsByWheel = new Map(
      wheelDust.map((dust) => [Number(dust.name.replace("dust-kick-wheel-", "")), dust.simulation.emitted]),
    );
    const chipsByWheel = new Map(
      wheelChips.map((chips) => [Number(chips.name.replace("rover-debris-wheel-", "")), chips.simulation.emitted]),
    );
    const emissionsOnSide = (wheelIndices: number[]): number =>
      wheelIndices.reduce((total, index) => total + (emissionsByWheel.get(index) ?? 0), 0);
    assert.ok(emissionsOnSide([0, 2, 4]) > 0); // Left front, middle and rear.
    assert.ok(emissionsOnSide([1, 3, 5]) > 0); // Right front, middle and rear.
    const chipEmissionsOnSide = (wheelIndices: number[]): number =>
      wheelIndices.reduce((total, index) => total + (chipsByWheel.get(index) ?? 0), 0);
    assert.ok(chipEmissionsOnSide([0, 2, 4]) > 0);
    assert.ok(chipEmissionsOnSide([1, 3, 5]) > 0);
    for (const wheel of component.vehicle.wheels) {
      assert.ok(Math.abs(wheel.contactY - terrain.getHeightAt(wheel.contactX, wheel.contactZ)) < 0.001);
    }
  });

  test("keeps the 1.5× speed tune, bounded full-throttle speed and modest-grade grip", async () => {
    // Exercise the shipped vehicle, not a copied config that could miss a scene-only speedup.
    const { component } = await fixture();
    const rover = component.vehicle;
    assert.ok(rover.config.engine instanceof ElectricMotor);
    assertMatchObject(rover.config.engine, {
      peakTorque: 9.5,
      peakPower: 1500,
      ratedRpm: 1500,
      maxRpm: 5700,
      regenTorque: 4.2,
    });
    assert.ok(rover.config.transmission instanceof ReductionDrive);
    assert.equal(rover.config.transmission.ratio, 60);
    assert.equal(rover.config.rollingResistance, 0.06);

    const level = flatGround(0);
    rover.position.set(0, 0, 0);
    rover.yaw = 0;
    rover.placeOnGround(level);
    rover.setVelocity(0, 0, 0);
    rover.input.brake = 0;
    rover.input.handbrake = 0;
    rover.input.throttle = 1;
    for (let i = 0; i < 60; i++) rover.step(1 / 60, level);
    // The launch is the gentler tune's (same 9.5 N·m); only the speed axis moved up 1.5×.
    assert.ok(rover.speed > 0.5);
    assert.ok(rover.speed < 1.6);
    let maxSpeed = rover.speed;
    for (let i = 60; i < 60 * 40; i++) {
      rover.step(1 / 60, level);
      maxSpeed = Math.max(maxSpeed, rover.speed);
    }
    // 5700 rpm through 60:1 on 0.264 m wheels is ≈2.63 m/s no-load (≈9.5 km/h on Mars), the
    // requested +50% over the old 3800 rpm tune; loaded in regolith it settles at ≈2.44 m/s.
    assert.ok(maxSpeed < 2.65);
    assert.ok(rover.speed > 1.5);

    // The reverted 2.5 kW tune's 25° climb is still not promised. Preserve the grip check on a
    // modest grade the tune can sustain, without raising power to make that test pass.
    const grade = slopeGround((15 * Math.PI) / 180);
    rover.position.set(0, 0, 0);
    rover.placeOnGround(grade);
    rover.setVelocity(0, 0, 0);
    rover.distance = 0;
    for (let i = 0; i < 600; i++) rover.step(1 / 60, grade);
    assert.ok(rover.distance > 1.5);
    assert.ok(rover.speed > 0.2);
    for (const wheel of rover.wheels) assert.ok(Math.abs(wheel.kappa) < 0.35);
  });

  test("lays break fragments out separated with a down-push bias", () => {
    // Largest-first footprints like a real break (chunks, then pebbles).
    const radii = [0.2, 0.18, 0.15, 0.08, 0.07, 0.06, 0.05, 0.05, 0.04];
    let s = 12345;
    const random = (): number => {
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      return s / 0x7fffffff;
    };
    const spots = layoutBreakFragments(radii, 10, -3, 0, 1, random);
    assert.equal((spots).length, radii.length);
    // No two spawn interpenetrating (7 cm clearance by construction; assert 6 for float slop).
    for (let a = 0; a < spots.length; a++) {
      for (let b = a + 1; b < spots.length; b++) {
        const dist = Math.hypot(spots[a]!.x - spots[b]!.x, spots[a]!.z - spots[b]!.z);
        assert.ok(dist >= radii[a]! + radii[b]! + 0.06);
      }
    }
    // The pile favors the push direction (+z here).
    const meanZ = spots.reduce((total, spot) => total + spot.z, 0) / spots.length;
    assert.ok(meanZ > -3);
  });

  test("shoving leaves a furrow and mound; a full-speed ram keeps the rock intact without fragments", async () => {
    const { handle, scene, terrain, component, tick, key } = await fixture();
    const population = scene.object<PopulationWorld>("population")!;
    const rover = component.vehicle;
    const entitiesWithPrefix = (prefix: string) => {
      const out: Array<NonNullable<ReturnType<typeof scene.world.facade>>> = [];
      for (const id of scene.world.liveEntityIds()) {
        if (!scene.world.name(id).startsWith(prefix)) continue;
        const entity = scene.world.facade(id);
        if (entity) out.push(entity);
      }
      return out;
    };
    // Mirror the scene's round-rock collision radius to pick a shoveable target:
    // type-1, round, r in [0.35, 1.0] (small enough to move under rover contact).
    const roundRockRadius = (blockScales: ArrayLike<number>, p: number): number | null => {
      const rawSx = blockScales[p]! * 0.8;
      const rawSy = blockScales[p + 1]! * 0.8;
      const rawSz = blockScales[p + 2]! * 0.8;
      const minDim = Math.min(rawSx, rawSy, rawSz);
      const sy = minDim;
      const sx = rawSx === minDim ? rawSy : rawSx;
      const sz = rawSz === minDim ? rawSy : rawSz;
      if (sy < 0.7 * Math.max(sx, sz)) return null;
      return Math.max(0.12, ((sx + sy + sz) / 3) * 0.55);
    };
    for (let i = 0; i < 120; i++) tick();
    let target: { chunkKey: string; index: number; x: number; z: number; radius: number } | null = null;
    for (const [chunkKey] of terrain.chunks) {
      const block = population.chunkPopulation(chunkKey, 1);
      if (!block) continue;
      for (let i = 0; i < block.count; i++) {
        const p = i * 3;
        if (block.scales[p] === 0 && block.scales[p + 1] === 0) continue;
        const radius = roundRockRadius(block.scales, p);
        if (radius === null || radius < 0.35 || radius > 1.0) continue;
        const dx = block.positions[p]! - rover.position.x;
        const dz = block.positions[p + 2]! - rover.position.z;
        if (Math.hypot(dx, dz) > 30) continue;
        target = { chunkKey, index: i, x: block.positions[p]!, z: block.positions[p + 2]!, radius };
        break;
      }
      if (target) break;
    }
    assert.notEqual(target, null, "a round type-1 rock within 30 m of spawn");
    const rockId = `${target!.chunkKey}:rocks:${target!.index}`;

    const ground = heightFunctionGround((x: number, z: number) => terrain.getHeightAt(x, z));
    const teleportBehind = (x: number, z: number, gap: number): void => {
      rover.position.set(x, terrain.getHeightAt(x, z - gap) + 1.0, z - gap);
      rover.placeOnGround(ground);
      key("keydown", "KeyS");
      for (let i = 0; i < 30; i++) tick();
      key("keyup", "KeyS");
    };
    const isActive = (): boolean => {
      const fresh = population.chunkPopulation(target!.chunkKey, 1)!;
      return fresh.scales[target!.index * 3] === 0;
    };

    // Phase 1 — creep into the rock (adaptive W pulses, never faster than a gentle nudge) so
    // it wakes and rolls. Impacts are not a fracture action.
    teleportBehind(target!.x, target!.z, 1.6 + target!.radius + 0.12);
    let contactSpeed = 0;
    for (let i = 0; i < 800 && !isActive(); i++) {
      if (rover.speed < 0.12) {
        key("keydown", "KeyW");
        tick();
        tick();
        key("keyup", "KeyW");
      } else {
        tick();
      }
      contactSpeed = rover.speed;
    }
    assert.equal(isActive(), true, "the creep wakes the rock");
    assert.ok(contactSpeed < 0.35);
    assert.equal((entitiesWithPrefix("rock-chunk-")).length, 0);
    assert.equal((entitiesWithPrefix("rock-pebble-")).length, 0);
    const activeRock = (): NonNullable<ReturnType<typeof scene.world.facade>> =>
      entitiesWithPrefix(`active-rock-${rockId}`)[0]!;
    assert.notEqual(activeRock(), undefined, "waking promotes the rock to an entity");
    const pushStartX = activeRock().transform.position.x;
    const pushStartZ = activeRock().transform.position.z;
    // The shove carries the rock well past the 0.3 m trail spacing; hold the brakes so the
    // rover does not follow it into the pile.
    key("keydown", "KeyS");
    let pushed = 0;
    for (let i = 0; i < 600; i++) {
      tick();
      pushed = Math.hypot(
        activeRock().transform.position.x - pushStartX,
        activeRock().transform.position.z - pushStartZ,
      );
      if (pushed >= 0.6) break;
    }
    key("keyup", "KeyS");
    assert.ok(pushed >= 0.6);
    // Every stretch of shoved travel stamps a furrow segment and a backside dirt mound.
    const furrows = entitiesWithPrefix("mars-furrow-").filter(
      (entity) => entity.get(Renderable)?.visible,
    );
    const mounds = entitiesWithPrefix("mars-mound-").filter(
      (entity) => entity.get(Renderable)?.visible,
    );
    assert.ok(furrows.length >= 1);
    assert.ok(mounds.length >= 1);

    // Phase 2 — let the shoved rock settle, then ram it at full speed. It can move again, but
    // rover contact must not remove its population identity or spawn fracture fragments.
    key("keydown", "KeyS");
    let restX = activeRock().transform.position.x;
    let restZ = activeRock().transform.position.z;
    for (let i = 0; i < 900; i++) {
      tick();
      const nowX = activeRock().transform.position.x;
      const nowZ = activeRock().transform.position.z;
      if (Math.hypot(nowX - restX, nowZ - restZ) < 1e-4 && i > 60) break;
      restX = nowX;
      restZ = nowZ;
    }
    key("keyup", "KeyS");
    teleportBehind(restX, restZ, 4);
    const brokenBeforeRam = handle.marsState().brokenInteractiveRocks;
    key("keydown", "KeyW");
    let impactObserved = false;
    for (let i = 0; i < 600; i++) {
      tick();
      const p = activeRock().transform.position;
      if (Math.hypot(p.x - restX, p.z - restZ) > 0.05) {
        impactObserved = true;
        break;
      }
    }
    key("keyup", "KeyW");
    assert.equal(impactObserved, true, "the full-speed rover contacts and pushes the rock");
    assert.equal(handle.marsState().brokenInteractiveRocks, brokenBeforeRam);
    assert.equal(isActive(), true, "the rock remains promoted rather than broken");
    assert.notEqual(activeRock().get(Renderable), undefined, "the original rock entity stays visible");
    assert.equal((entitiesWithPrefix("rock-chunk-")).length, 0);
    assert.equal((entitiesWithPrefix("rock-pebble-")).length, 0);
    const snapshot = JSON.parse(handle.saveInteractiveTerrain()) as { brokenRockIds: string[] };
    assertNotContains(snapshot.brokenRockIds, rockId);
  });

  test("keeps the chase camera and sky reference on the same surface while zooming and relocating", async () => {
    const { handle, scene, terrain, component, controls, tick } = await fixture();
    tick();
    for (const [x, z] of [[-164, 4], [-36, 132], [92, 260]]) {
      const v = component.vehicle;
      v.position.x = x!;
      v.position.z = z!;
      v.placeOnGround(component.ground);
      handle.update(1 / 60);
      assert.equal(scene.settings.sky.seaLevel, terrain.getHeightAt(x!, z!));
      const target = handle.followTarget!();
      controls.target.set(target.x, target.y, target.z);
      for (const zoom of [-10000, 600, 10000]) {
        controls.zoomBy(zoom);
        controls.update();
        const eye = controls.eyePosition();
        assert.ok(eye.y - terrain.getHeightAt(eye.x, eye.z) >= 0.5 - 1e-5);
      }
    }
  });

  test("streams nested LODs with matching shared samples, deep skirts and bounded inline work", async () => {
    const { handle, terrain, context } = await fixture();
    terrain.update(context, context.dt);
    for (let frame = 0; frame < 80; frame++) {
      terrain.update(context, context.dt);
      assert.ok(terrain.streamingStats.generatedThisFrame <= 1);
      assert.equal(terrain.streamingStats.scheduledThisFrame, 0);
    }
    const ready = [...terrain.chunks.values()].filter((chunk) => chunk.state === "ready");
    assert.ok(new Set(ready.map((chunk) => chunk.resolution)).size > 1);
    let mixedEdges = 0;
    let worstGap = 0;
    for (const chunk of ready) {
      const a = chunk.tile!;
      assert.equal(a.skirtDepth, 32);
      assertCloseTo(a.bounds.min.y, a.heightmap.minHeight - 32, 4);
      for (const [dx, dz] of [[1, 0], [0, 1]] as const) {
        const b = terrain.chunks.get(chunkCoordKey(chunk.cx + dx, chunk.cz + dz))?.tile;
        if (!b) continue;
        if (a.resolution !== b.resolution) mixedEdges++;
        const shared = Math.min(a.resolution, b.resolution);
        for (let k = 0; k < shared; k++) {
          const ia = k * (a.resolution - 1) / (shared - 1);
          const ib: number = k * (b.resolution - 1) / (shared - 1);
          const indexA = dx ? ia * a.resolution + a.resolution - 1 : (a.resolution - 1) * a.resolution + ia;
          const indexB: number = dx ? ib * b.resolution : ib;
          assert.equal(a.cell.heights[indexA], b.cell.heights[indexB]);
        }
        // Geomorphed surfaces need not meet between common samples, but the skirts must enclose
        // the actual gap, not just exist in the configuration. Inspect both X and Z neighbours.
        const samples = Math.max(a.resolution, b.resolution);
        for (let k = 0; k < samples; k++) {
          const t = k / (samples - 1);
          const x = (chunk.cx + (dx ? 1 : t)) * terrain.chunkSize;
          const z = (chunk.cz + (dz ? 1 : t)) * terrain.chunkSize;
          worstGap = Math.max(worstGap, Math.abs(a.heightmap.getHeight(x, z) - b.heightmap.getHeight(x, z)));
        }
      }
    }
    assert.ok(mixedEdges > 0);
    assert.ok(worstGap < terrain.skirtDepth);

    const eye = handle.cameraEntity.transform.position;
    handle.cameraEntity.transform.position = new Vec3(eye.x + 512, eye.y, eye.z + 512);
    for (let frame = 0; frame < 24; frame++) {
      terrain.update(context, context.dt);
      assert.ok(terrain.streamingStats.generatedThisFrame <= 1);
      assert.ok(terrain.chunks.size <= terrain.budgets.visibleChunks);
      assert.ok(terrain.streamingStats.residentBytes < terrain.budgets.memoryBytes);
    }
    const moved = handle.cameraEntity.transform.position;
    assert.equal(terrain.focusPosition.x, moved.x);
    assert.equal(terrain.focusPosition.z, moved.z);
    assert.equal(tileAt(terrain, moved.x, moved.z).resolution, 33);
  });
});

await finish();
