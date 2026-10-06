/**
 * The actual Mars Showcase assembly on the strict mock GPU. Only the browser DOM and the pending
 * GLB fetch are stubbed; terrain, textures, streaming, camera and six-wheel vehicle are real.
 * This pins the scene's use of the port (not just the factory in isolation), a traversable landing
 * site, one shared heightfield before/after upload, and bounded inline streaming with LOD skirts.
 * The real model, pixels, keyboard drive and dust are also exercised by check:browser.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
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
import { createWorkerThreadPool } from "./support/workerThreads.js";
import { OrbitControls } from "../examples/src/controls/orbitControls.js";
import {
  buildMarsShowcaseScene,
  layoutBreakFragments,
  MARS_SHOWCASE_SITE,
} from "../examples/src/scenes/marsShowcaseScene.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.unstubAllGlobals();
});

async function fixture(scheduler?: TaskScheduler) {
  const windowStub = new EventTarget();
  vi.stubGlobal("window", windowStub);
  vi.stubGlobal("document", { getElementById: () => null });
  // Hold the model at its loading placeholder. No network or image decoder is needed for these
  // terrain tests; the GLB content/attachment is covered by roverGlb.test and the browser gate.
  const fetchStub = vi.fn(() => new Promise<Response>(() => {}));
  vi.stubGlobal("fetch", fetchStub);
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
    expect(gpu.mock.outstanding.buffers).toEqual([]);
    expect(gpu.mock.outstanding.textures).toEqual([]);
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
  expect(tile, `resident tile at ${key}`).toBeTruthy();
  return tile!;
}

describe("Mars Showcase — ported terrain integration", () => {
  it("uses the unmodified generator seed/site without an erosion fetch, ready for workers", async () => {
    const { handle, terrain, fetchStub } = await fixture();
    expect(terrain.pipeline.stages).toHaveLength(1);
    const stage = terrain.pipeline.stages[0] as MarsTerrainStage;
    expect(stage).toBeInstanceOf(MarsTerrainStage);
    expect(stage.params).toEqual(MARS_GEN_PARAMS);
    expect(stage.site.latDeg).toBe(MARS_SHOWCASE_SITE.latDeg);
    expect(stage.site.lonDeg).toBe(MARS_SHOWCASE_SITE.lonDeg);
    expect(stage.site.headingDeg).toBe(MARS_SHOWCASE_SITE.headingDeg);
    expect(stage.detail).toBe(true);
    expect(stage.curvatureCompensation).toBe(true);
    expect(stage.globalFields).toBeNull();
    expect(stage.hasErosionCorrection).toBe(false);
    expect(terrain.seed).toBe(1337);
    expect(terrain.syncGeneration).toBe(false);
    expect(terrain.chunkSize).toBe(128);
    expect(terrain.chunkResolution).toBe(33);
    expect(terrain.skirtDepth).toBe(32);
    expect(terrain.budgets.generationsPerFrame).toBe(1);
    expect(terrain.warmUpChunks).toBe(9);
    expect(fetchStub).toHaveBeenCalledTimes(1);
    expect(fetchStub.mock.calls[0]).toEqual([expect.stringContaining("Perseverance.glb")]);
    expect(handle.marsState()).toMatchObject({
      terrainGenerator: "mars",
      terrainHasErosion: false,
      terrainGeneration: "inline", // This fixture has no scheduler; fallback remains functional.
      terrainReadyChunks: 0,
      terrainRoverChunkReady: false,
    });
    expect(handle.overlay?.()).toContain("analytic only (no erosion cache)");
  });

  it("uploads the actual Mars weights into tile-owned masks and toggles layering without changing geometry", async () => {
    const { handle, terrain, scene, context, gpu } = await fixture();
    terrain.update(context, context.dt);
    const state = handle.marsState();
    expect(state.terrainMaterialMode).toBe("layered");
    expect(state.terrainMaterialLayers).toEqual(["dust", "rock", "sand", "crust"]);
    expect(state.terrainSplatTiles).toBe(9);
    const ready = [...terrain.chunks.values()].filter((chunk) => chunk.tile?.gpuMaterial);
    for (const chunk of ready) {
      const tile = chunk.tile!;
      const material = tile.gpuMaterial!;
      expect(material).toBeInstanceOf(SplatMaterial);
      expect(material.maps.albedo).toBe(terrain.layeredMaterial!.maps!.albedo);
      expect(material.maps.albedo.desc.depthOrArrayLayers).toBe(4);
      const mask = [...gpu.mock.liveTextures].find((t) => t.label === material.weightMap.desc.label)!;
      expect(mask.texelBytes()).toEqual(terrain.layeredMaterial!.weightPixels(tile.cell));
    }
    const geometries = ready.map((chunk) => chunk.tile!.gpuGeometry);
    terrain.setLayeredMaterialsEnabled(false);
    expect(handle.marsState().terrainMaterialMode).toBe("single");
    for (const chunk of ready) expect(scene.world.getComponent(chunk.entityId!, Renderable)!.material).toBe(terrain.material);
    terrain.setLayeredMaterialsEnabled(true);
    expect(ready.map((chunk) => chunk.tile!.gpuGeometry)).toEqual(geometries);
    expect(handle.marsState().terrainGroundHeight).toBe(state.terrainGroundHeight);
    expect(handle.marsState().contactWheels).toBe(6);
  });

  it("uploads worker-generated opening tiles without regenerating the Mars stage on main", async () => {
    // Use the shipping worker bootstrap, not test-preinstalled terrain handlers.
    const pool = await createWorkerThreadPool({ installEngineHandlers: false });
    const scheduler = new TaskScheduler({ workerCount: 2, createWorker: (i) => pool.createWorker(i) });
    cleanups.push(async () => { scheduler.dispose(); await pool.dispose(); });
    const { handle, terrain, context } = await fixture(scheduler);
    const initial = handle.marsState();
    const stage = terrain.pipeline.stages[0] as MarsTerrainStage;
    const process = vi.spyOn(stage, "process");
    terrain.update(context, context.dt);
    const submitted = terrain.streamingStats.scheduledThisFrame;
    expect(submitted).toBeGreaterThan(0);
    expect([...terrain.chunks.values()].some((c) => c.state === "generating")).toBe(true);
    expect(process).not.toHaveBeenCalled(); // Only the spawn/query cache may hit inline.
    await scheduler.drain();
    expect(scheduler.stats.completed).toBe(submitted);
    expect(scheduler.stats.inlineFallbacks).toBe(0);
    expect(scheduler.stats.failed).toBe(0);
    expect(scheduler.stats.workerFailures).toBe(0);
    terrain.update(context, context.dt); // Drain the worker results through the normal upload path.
    expect(process).not.toHaveBeenCalled();
    const state = handle.marsState();
    expect(state.terrainGeneration).toBe("workers");
    expect(state.terrainReadyChunks).toBeGreaterThanOrEqual(terrain.warmUpChunks);
    expect(state.terrainRoverChunkReady).toBe(true);
    expect(state.terrainGroundHeight).toBe(initial.terrainGroundHeight);
    expect(state.contactWheels).toBe(6);
    for (const chunk of terrain.chunks.values()) {
      if (chunk.state === "ready") expect(chunk.tile?.gpuGeometry).not.toBeNull();
    }
    process.mockRestore();
  });

  it("uses the scheduler's no-worker fallback without failed tasks or a different surface", async () => {
    const scheduler = new TaskScheduler({ inline: true });
    cleanups.push(async () => { scheduler.dispose(); });
    const { handle, terrain, context } = await fixture(scheduler);
    const initial = handle.marsState();
    terrain.update(context, context.dt);
    await scheduler.drain();
    terrain.update(context, context.dt);
    expect(scheduler.stats.completed).toBeGreaterThan(0);
    expect(scheduler.stats.failed).toBe(0);
    expect(handle.marsState()).toMatchObject({
      terrainGeneration: "inline", terrainRoverChunkReady: true, terrainGroundHeight: initial.terrainGroundHeight,
    });
  });

  it("lands on a gentle surface that does not jump when the opening tiles become resident", async () => {
    const { handle, terrain, component, context } = await fixture();
    const v = component.vehicle;
    const start = handle.marsState();
    expect(start.contactWheels).toBe(6);
    expect(terrain.getSlopeAt(start.x, start.z)).toBeLessThan(5 * Math.PI / 180);
    expect(start.y - start.terrainGroundHeight).toBeGreaterThan(0.45);
    expect(start.y - start.terrainGroundHeight).toBeLessThan(0.65);
    const before = v.wheels.map((w) => terrain.getHeightAt(w.contactX, w.contactZ));

    terrain.update(context, context.dt);
    expect(terrain.streamingStats.generatedThisFrame).toBe(9);
    expect(terrain.streamingStats.scheduledThisFrame).toBe(0);
    expect(handle.marsState()).toMatchObject({ terrainReadyChunks: 9, terrainRoverChunkReady: true });
    expect(handle.marsState().terrainResidentBytes).toBeGreaterThan(0);
    expect(terrain.getHeightAt(start.x, start.z)).toBe(start.terrainGroundHeight);
    const sample = { height: 0, nx: 0, ny: 1, nz: 0 };
    for (const [i, wheel] of v.wheels.entries()) {
      const tile = tileAt(terrain, wheel.contactX, wheel.contactZ);
      expect(tile.gpuGeometry).not.toBeNull();
      expect(tile.resolution).toBe(33);
      component.ground.sample(wheel.contactX, wheel.contactZ, sample);
      expect(sample.height).toBe(before[i]);
      expect(sample.height).toBe(tile.heightmap.getHeight(wheel.contactX, wheel.contactZ));
      // The wheel ray's three-iteration intersection agrees within a millimetre, not just with
      // the analytic point sampler (which bypasses the rendered grid and must NOT be used here).
      expect(Math.abs(wheel.contactY - sample.height)).toBeLessThan(0.001);
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
        expect(y).toBe(tile.heightmap.heights[vertex]);
        expect(Math.abs(y - stage.sampleElevation(x, z))).toBeLessThan(1e-4);
      }
    }
  });

  it("drives the scene's six-wheel rover with W on the ported grid and throws wheel dust", async () => {
    const { handle, scene, terrain, component, tick, key } = await fixture();
    const wheelDust = scene.objects.filter(
      (object): object is ParticleWorld =>
        object instanceof ParticleWorld && object.name.startsWith("dust-kick-wheel-"),
    );
    const wheelChips = scene.objects.filter(
      (object): object is ParticleWorld =>
        object instanceof ParticleWorld && object.name.startsWith("rover-debris-wheel-"),
    );
    expect(wheelDust.map((dust) => dust.name).sort()).toEqual(
      Array.from({ length: 6 }, (_, index) => `dust-kick-wheel-${index}`),
    );
    expect(wheelChips.map((chips) => chips.name).sort()).toEqual(
      Array.from({ length: 6 }, (_, index) => `rover-debris-wheel-${index}`),
    );
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
      expect(state.terrainRoverChunkReady).toBe(true);
      expect(state.y - state.terrainGroundHeight).toBeGreaterThan(0.35);
      expect(state.y - state.terrainGroundHeight).toBeLessThan(0.8);
    }
    key("keyup", "KeyW");
    expect(handle.marsState().z - start.z).toBeGreaterThan(6);
    expect(minContact).toBeGreaterThanOrEqual(4);
    expect(maxSpeed).toBeGreaterThan(1);
    expect(maxSpeed).toBeLessThan(2.5); // Gentle uphill, not the runaway downhill summit spawn.
    expect(maxKick).toBeGreaterThan(0);
    expect(maxChips).toBeGreaterThan(0);
    const emissionsByWheel = new Map(
      wheelDust.map((dust) => [Number(dust.name.replace("dust-kick-wheel-", "")), dust.simulation.emitted]),
    );
    const chipsByWheel = new Map(
      wheelChips.map((chips) => [Number(chips.name.replace("rover-debris-wheel-", "")), chips.simulation.emitted]),
    );
    const emissionsOnSide = (wheelIndices: number[]): number =>
      wheelIndices.reduce((total, index) => total + (emissionsByWheel.get(index) ?? 0), 0);
    expect(emissionsOnSide([0, 2, 4])).toBeGreaterThan(0); // Left front, middle and rear.
    expect(emissionsOnSide([1, 3, 5])).toBeGreaterThan(0); // Right front, middle and rear.
    const chipEmissionsOnSide = (wheelIndices: number[]): number =>
      wheelIndices.reduce((total, index) => total + (chipsByWheel.get(index) ?? 0), 0);
    expect(chipEmissionsOnSide([0, 2, 4])).toBeGreaterThan(0);
    expect(chipEmissionsOnSide([1, 3, 5])).toBeGreaterThan(0);
    for (const wheel of component.vehicle.wheels) {
      expect(Math.abs(wheel.contactY - terrain.getHeightAt(wheel.contactX, wheel.contactZ))).toBeLessThan(0.001);
    }
  });

  it("keeps the original gentle drive tune, bounded speed and modest-grade grip", async () => {
    // Exercise the shipped vehicle, not a copied config that could miss a scene-only speedup.
    const { component } = await fixture();
    const rover = component.vehicle;
    expect(rover.config.engine).toBeInstanceOf(ElectricMotor);
    expect(rover.config.engine).toMatchObject({
      peakTorque: 9.5,
      peakPower: 1000,
      ratedRpm: 1000,
      maxRpm: 3800,
      regenTorque: 4.2,
    });
    expect(rover.config.transmission).toBeInstanceOf(ReductionDrive);
    expect(rover.config.transmission.ratio).toBe(60);
    expect(rover.config.rollingResistance).toBe(0.06);

    const level = flatGround(0);
    rover.position.set(0, 0, 0);
    rover.yaw = 0;
    rover.placeOnGround(level);
    rover.setVelocity(0, 0, 0);
    rover.input.brake = 0;
    rover.input.handbrake = 0;
    rover.input.throttle = 1;
    for (let i = 0; i < 60; i++) rover.step(1 / 60, level);
    // Restores the softer launch as well as the power cap; the 2.5 kW tune exceeds this band.
    expect(rover.speed).toBeGreaterThan(0.5);
    expect(rover.speed).toBeLessThan(1.2);
    let maxSpeed = rover.speed;
    for (let i = 60; i < 60 * 40; i++) {
      rover.step(1 / 60, level);
      maxSpeed = Math.max(maxSpeed, rover.speed);
    }
    expect(maxSpeed).toBeLessThan(1.75);
    expect(rover.speed).toBeGreaterThan(0.6);

    // The reverted motor no longer promises the boosted tune's 25° climb. Preserve the grip
    // check on a modest grade it can sustain, without raising power to make that test pass.
    const grade = slopeGround((15 * Math.PI) / 180);
    rover.position.set(0, 0, 0);
    rover.placeOnGround(grade);
    rover.setVelocity(0, 0, 0);
    rover.distance = 0;
    for (let i = 0; i < 600; i++) rover.step(1 / 60, grade);
    expect(rover.distance).toBeGreaterThan(1.5);
    expect(rover.speed).toBeGreaterThan(0.2);
    for (const wheel of rover.wheels) expect(Math.abs(wheel.kappa)).toBeLessThan(0.35);
  });

  it("lays break fragments out separated with a down-push bias", () => {
    // Largest-first footprints like a real break (chunks, then pebbles).
    const radii = [0.2, 0.18, 0.15, 0.08, 0.07, 0.06, 0.05, 0.05, 0.04];
    let s = 12345;
    const random = (): number => {
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      return s / 0x7fffffff;
    };
    const spots = layoutBreakFragments(radii, 10, -3, 0, 1, random);
    expect(spots).toHaveLength(radii.length);
    // No two spawn interpenetrating (7 cm clearance by construction; assert 6 for float slop).
    for (let a = 0; a < spots.length; a++) {
      for (let b = a + 1; b < spots.length; b++) {
        const dist = Math.hypot(spots[a]!.x - spots[b]!.x, spots[a]!.z - spots[b]!.z);
        expect(dist).toBeGreaterThanOrEqual(radii[a]! + radii[b]! + 0.06);
      }
    }
    // The pile favors the push direction (+z here).
    const meanZ = spots.reduce((total, spot) => total + spot.z, 0) / spots.length;
    expect(meanZ).toBeGreaterThan(-3);
  });

  it("shoving a rock leaves a furrow trail and mound; smashing it scatters separated fragments", async () => {
    const { scene, terrain, component, tick, key } = await fixture();
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
    // Mirror the scene's round-rock collision radius to pick a shoveable-then-breakable rock:
    // type-1, round, r in [0.35, 1.0] (large enough to break at speed, small enough to push).
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
    expect(target, "a round type-1 rock within 30 m of spawn").not.toBeNull();
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
    // it wakes and rolls without breaking.
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
    expect(isActive(), "the creep wakes the rock").toBe(true);
    expect(contactSpeed).toBeLessThan(0.35);
    expect(entitiesWithPrefix("rock-chunk-")).toHaveLength(0);
    expect(entitiesWithPrefix("rock-pebble-")).toHaveLength(0);
    const activeRock = (): NonNullable<ReturnType<typeof scene.world.facade>> =>
      entitiesWithPrefix(`active-rock-${rockId}`)[0]!;
    expect(activeRock(), "waking promotes the rock to an entity").toBeDefined();
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
    expect(pushed).toBeGreaterThanOrEqual(0.6);
    // Every stretch of shoved travel stamps a furrow segment and a backside dirt mound.
    const furrows = entitiesWithPrefix("mars-furrow-").filter(
      (entity) => entity.get(Renderable)?.visible,
    );
    const mounds = entitiesWithPrefix("mars-mound-").filter(
      (entity) => entity.get(Renderable)?.visible,
    );
    expect(furrows.length).toBeGreaterThanOrEqual(1);
    expect(mounds.length).toBeGreaterThanOrEqual(1);

    // Phase 2 — let the rock come to rest, then ram it at full speed and check the debris.
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
    key("keydown", "KeyW");
    let fragCount = 0;
    for (let i = 0; i < 600; i++) {
      tick();
      fragCount =
        entitiesWithPrefix("rock-chunk-").length + entitiesWithPrefix("rock-pebble-").length;
      if (fragCount >= 9) break;
    }
    key("keyup", "KeyW");
    expect(fragCount).toBeGreaterThanOrEqual(9);
    const chunks = entitiesWithPrefix("rock-chunk-");
    const pebbles = entitiesWithPrefix("rock-pebble-");
    // Rendered size matches the collider: entity scale is collision-half-extent ÷ geometry
    // radius, so round fragments (spherical collision on squashed geometry) have a fixed
    // Y/X scale ratio — 1.0/0.85/0.45 on the old size-blind scales.
    for (const pebble of pebbles) {
      const scale = pebble.transform.scale;
      expect(scale.y / scale.x).toBeCloseTo(0.22 / (0.22 * (1 - 0.2)), 2);
    }
    for (const chunk of chunks) {
      const scale = chunk.transform.scale;
      // Suffix "-c": c % 2 === 0 is a flat slab (sy/s = 0.45), c = 1 is round.
      const suffix = Number(scene.world.name(chunk.id).split("-").pop());
      const shapeRatio = suffix % 2 === 0 ? 0.45 : 1;
      expect(scale.y / scale.x).toBeCloseTo(shapeRatio * (0.6 / (0.6 * (1 - 0.35))), 2);
    }
    // No two fragments rest inside one another: pairwise XZ distance covers both footprints.
    const discs = [
      ...chunks.map((entity) => ({ entity, radius: entity.transform.scale.x * 0.6 })),
      ...pebbles.map((entity) => ({ entity, radius: entity.transform.scale.x * 0.22 })),
    ];
    for (let a = 0; a < discs.length; a++) {
      for (let b = a + 1; b < discs.length; b++) {
        const pa = discs[a]!.entity.transform.position;
        const pb = discs[b]!.entity.transform.position;
        const dist = Math.hypot(pa.x - pb.x, pa.z - pb.z);
        expect(dist).toBeGreaterThanOrEqual(discs[a]!.radius + discs[b]!.radius);
      }
    }
  });

  it("keeps the chase camera and sky reference on the same surface while zooming and relocating", async () => {
    const { handle, scene, terrain, component, controls, tick } = await fixture();
    tick();
    for (const [x, z] of [[-164, 4], [-36, 132], [92, 260]]) {
      const v = component.vehicle;
      v.position.x = x!;
      v.position.z = z!;
      v.placeOnGround(component.ground);
      handle.update(1 / 60);
      expect(scene.settings.sky.seaLevel).toBe(terrain.getHeightAt(x!, z!));
      const target = handle.followTarget!();
      controls.target.set(target.x, target.y, target.z);
      for (const zoom of [-10000, 600, 10000]) {
        controls.zoomBy(zoom);
        controls.update();
        const eye = controls.eyePosition();
        expect(eye.y - terrain.getHeightAt(eye.x, eye.z)).toBeGreaterThanOrEqual(0.5 - 1e-5);
      }
    }
  });

  it("streams nested LODs with matching shared samples, deep skirts and bounded inline work", async () => {
    const { handle, terrain, context } = await fixture();
    terrain.update(context, context.dt);
    for (let frame = 0; frame < 80; frame++) {
      terrain.update(context, context.dt);
      expect(terrain.streamingStats.generatedThisFrame).toBeLessThanOrEqual(1);
      expect(terrain.streamingStats.scheduledThisFrame).toBe(0);
    }
    const ready = [...terrain.chunks.values()].filter((chunk) => chunk.state === "ready");
    expect(new Set(ready.map((chunk) => chunk.resolution)).size).toBeGreaterThan(1);
    let mixedEdges = 0;
    let worstGap = 0;
    for (const chunk of ready) {
      const a = chunk.tile!;
      expect(a.skirtDepth).toBe(32);
      expect(a.bounds.min.y).toBeCloseTo(a.heightmap.minHeight - 32, 4);
      for (const [dx, dz] of [[1, 0], [0, 1]] as const) {
        const b = terrain.chunks.get(chunkCoordKey(chunk.cx + dx, chunk.cz + dz))?.tile;
        if (!b) continue;
        if (a.resolution !== b.resolution) mixedEdges++;
        const shared = Math.min(a.resolution, b.resolution);
        for (let k = 0; k < shared; k++) {
          const ia = k * (a.resolution - 1) / (shared - 1);
          const ib = k * (b.resolution - 1) / (shared - 1);
          const indexA = dx ? ia * a.resolution + a.resolution - 1 : (a.resolution - 1) * a.resolution + ia;
          const indexB = dx ? ib * b.resolution : ib;
          expect(a.cell.heights[indexA]).toBe(b.cell.heights[indexB]);
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
    expect(mixedEdges).toBeGreaterThan(0);
    expect(worstGap).toBeLessThan(terrain.skirtDepth);

    const eye = handle.cameraEntity.transform.position;
    handle.cameraEntity.transform.position = new Vec3(eye.x + 512, eye.y, eye.z + 512);
    for (let frame = 0; frame < 24; frame++) {
      terrain.update(context, context.dt);
      expect(terrain.streamingStats.generatedThisFrame).toBeLessThanOrEqual(1);
      expect(terrain.chunks.size).toBeLessThanOrEqual(terrain.budgets.visibleChunks);
      expect(terrain.streamingStats.residentBytes).toBeLessThan(terrain.budgets.memoryBytes);
    }
    const moved = handle.cameraEntity.transform.position;
    expect(terrain.focusPosition.x).toBe(moved.x);
    expect(terrain.focusPosition.z).toBe(moved.z);
    expect(tileAt(terrain, moved.x, moved.z).resolution).toBe(33);
  });
});
