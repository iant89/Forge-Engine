/**
 * @suite examples:marsGeneratorScene
 * @group integration
 * @covers engine/src/core/engine.ts
 * @covers engine/src/core/log.ts
 * @covers engine/src/core/time.ts
 * @covers engine/src/debug/profiler.ts
 * @covers engine/src/gpu/device.ts
 * @covers engine/src/index.ts
 * @covers engine/src/rendering/splatMaterial.ts
 * @covers engine/src/scene/components/index.ts
 * @covers engine/src/scene/systems.ts
 * @covers engine/src/terrain/mars/stage.ts
 * @covers engine/src/terrain/world.ts
 * @covers examples/src/controls/orbitControls.ts
 * @covers examples/src/sceneSelection.ts
 * @covers examples/src/scenes/marsGeneratorScene.ts
 * @desc The ported Mars generator as a site inspector (Phase 10.9) —
 */

export const suite = {
  name: "examples:marsGeneratorScene",
  group: "integration",
  covers:   [
    "engine/src/core/engine.ts",
    "engine/src/core/log.ts",
    "engine/src/core/time.ts",
    "engine/src/debug/profiler.ts",
    "engine/src/gpu/device.ts",
    "engine/src/index.ts",
    "engine/src/rendering/splatMaterial.ts",
    "engine/src/scene/components/index.ts",
    "engine/src/scene/systems.ts",
    "engine/src/terrain/mars/stage.ts",
    "engine/src/terrain/world.ts",
    "examples/src/controls/orbitControls.ts",
    "examples/src/sceneSelection.ts",
    "examples/src/scenes/marsGeneratorScene.ts"
  ],
  desc: "The ported Mars generator as a site inspector (Phase 10.9) —",
};
/**
 * The ported Mars generator as a **site inspector** (Phase 10.9) —
 * `examples/src/scenes/marsGeneratorScene.ts`.
 *
 * `tests/examples/marsShowcase.test.ts` already pins the rover's patch (one surveyed site, worker-backed
 * streaming, tile-owned splat masks). What this suite adds is the inspector's own contract: the demo
 * URL chooses the site, the advised `adviseMarsTile` sizing reaches the world, the port's
 * dust/rock/sand/crust weights land in per-tile masks through main's `SplatMaterial` path, and the
 * camera preset agrees with the ported surface it orbits. Real pixels are the browser gate's job
 * (`check:browser`, which loads `?scene=mars-generator&marssite=0,0`); this suite runs on the strict
 * mock device.
 */
import assert from "node:assert/strict";
import { afterEach, assertCloseTo, assertContains, assertMatchObject, finish, group, test } from "selrun";
import {
  Clock,
  GraphicsDevice,
  Logger,
  MARS_SITE_PRESETS,
  MarsTerrainStage,
  Profiler,
  Renderable,
  SplatMaterial,
  SystemScratch,
  TerrainWorld,
  adviseMarsTile,
  marsSurfaceLayers,
  type Engine,
  type SystemContext,
} from "@forge/engine";
import {
  buildMarsGeneratorScene,
  MARS_GENERATOR_TILE,
  parseMarsSiteParam,
} from "../../examples/src/scenes/marsGeneratorScene.js";
import { resolveDemoSceneName } from "../../examples/src/sceneSelection.js";
import { OrbitControls } from "../../examples/src/controls/orbitControls.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture(site?: string) {
  const gpu = await GraphicsDevice.create({ forceMock: true });
  const engine = { gpu } as Engine;
  const handle = buildMarsGeneratorScene(engine, site === undefined ? {} : { site });
  const scene = handle.scene;
  scene.attachToEngine(engine); // Upload real tile geometry to the mock, not a metadata path.
  const terrain = scene.object<TerrainWorld>("TerrainWorld")!;
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
  const canvas = {
    clientHeight: 720,
    addEventListener() {},
    removeEventListener() {},
    setPointerCapture() {},
    releasePointerCapture() {},
  } as unknown as HTMLElement;
  const controls = new OrbitControls(handle.cameraEntity, canvas).configure(handle.camera!);
  cleanups.push(async () => {
    controls.dispose();
    handle.dispose?.();
    await gpu.dispose();
    assert.deepEqual(gpu.mock.outstanding.buffers, []);
    assert.deepEqual(gpu.mock.outstanding.textures, []);
    assert.deepEqual(gpu.mock.errors, []);
  });
  const tick = (times = 1): void => {
    for (let i = 0; i < times; i++) {
      context.frame++;
      context.elapsed += context.dt;
      handle.update(context.dt);
      scene.update(context, context.dt);
    }
  };
  return { handle, scene, terrain, controls, context, tick, gpu };
}

/** Per-tile channel shares of the CPU mask the tiles were built from. */
function tileChannelShares(terrain: TerrainWorld): Array<{ cx: number; cz: number; shares: number[] }> {
  const layered = terrain.layeredMaterial!;
  const out: Array<{ cx: number; cz: number; shares: number[] }> = [];
  for (const chunk of terrain.chunks.values()) {
    const cell = chunk.tile?.cell;
    if (!cell) continue;
    const pixels = layered.weightPixels(cell);
    const sums = [0, 0, 0, 0];
    for (let i = 0; i < pixels.length; i += 4) for (let c = 0; c < 4; c++) sums[c] += pixels[i + c];
    const total = sums[0] + sums[1] + sums[2] + sums[3];
    if (total > 0) out.push({ cx: chunk.cx, cz: chunk.cz, shares: sums.map((s) => s / total) });
  }
  return out;
}

/** The largest non-dominant share in a patch — 0 when every tile is one channel. */
const bestSecondShare = (shares: number[][]): number =>
  shares.length === 0 ? 0 : Math.max(...shares.map((s) => [...s].sort((a, b) => b - a)[1]!));

function meanChannelShares(shares: number[][]): number[] {
  return shares.length === 0
    ? [0, 0, 0, 0]
    : [0, 1, 2, 3].map((channel) => shares.reduce((sum, tile) => sum + tile[channel]!, 0) / shares.length);
}

group("Mars generator inspector (Phase 10.9)", () => {
  test("is addressable as ?scene=mars-generator, with the port's aliases", () => {
    assert.equal(resolveDemoSceneName("mars-generator"), "mars-generator");
    assert.equal(resolveDemoSceneName("mars-port"), "mars-generator");
    assert.equal(resolveDemoSceneName("mars-generator-port"), "mars-generator");
    // `?scene=mars` keeps meaning the hand-written Martian terrain demo, and the showcase keeps its slot.
    assert.equal(resolveDemoSceneName("mars"), "terrain");
    assert.equal(resolveDemoSceneName("mars-showcase"), "mars-showcase");
  });

  test("accepts `lat,lon` site options and rejects everything else", () => {
    assert.deepEqual(parseMarsSiteParam("0,0"), { latDeg: 0, lonDeg: 0 });
    assert.deepEqual(parseMarsSiteParam(" -12.5 , 180 "), { latDeg: -12.5, lonDeg: 180 });
    assert.equal(parseMarsSiteParam("91,0"), null); // out of range
    assert.equal(parseMarsSiteParam("0,181"), null);
    assert.equal(parseMarsSiteParam("olympusMons"), null);
    assert.equal(parseMarsSiteParam("1,2,3"), null);
    assert.equal(parseMarsSiteParam(""), null);
  });

  test("streams the ported planet at the advised sizing, analytic-only, ready for workers", async () => {
    const { handle, terrain, gpu } = await fixture();
    const advice = adviseMarsTile(MARS_GENERATOR_TILE.chunkSize, MARS_GENERATOR_TILE.resolution);

    assert.equal((terrain.pipeline.stages).length, 1);
    const stage = terrain.pipeline.stages[0] as MarsTerrainStage;
    assert.ok(stage instanceof MarsTerrainStage);
    // The volcano preset is the generator CLI's own default; the terrain seed is the port's seed.
    assert.equal(stage.site.latDeg, MARS_SITE_PRESETS.olympusMons!.latDeg);
    assert.equal(stage.site.lonDeg, MARS_SITE_PRESETS.olympusMons!.lonDeg);
    assert.equal(stage.hasErosionCorrection, false);
    assert.equal(terrain.seed, 1337);
    // The repo ships no Stage A cache, so the demo must not pretend it has one.
    assert.equal(advice.ok, true);
    assert.equal(advice.detailLevel, "micro");
    assertCloseTo(advice.vertexSpacing, 4, 6);
    assert.equal(terrain.chunkSize, MARS_GENERATOR_TILE.chunkSize);
    assert.equal(terrain.chunkResolution, MARS_GENERATOR_TILE.resolution);
    assert.equal(terrain.skirtDepth, advice.recommendedSkirtDepth);
    assert.equal(terrain.syncGeneration, false); // workers when a scheduler is mounted, inline otherwise
    assert.equal(terrain.budgets.generationsPerFrame, 1);
    assert.equal(terrain.warmUpChunks, 9);
    assert.ok(gpu.mock.liveTextures.size > 0); // the four shared PBR arrays

    assertMatchObject(handle.marsGeneratorState(), {
      site: MARS_SITE_PRESETS.olympusMons!.name,
      detailLevel: "micro",
      chunkSize: 128,
      skirtDepth: 32,
      generation: "inline", // this fixture mounts no scheduler
      materialMode: "layered",
      layers: ["dust", "rock", "sand", "crust"],
      stageSeed: 1337,
      hasErosionCorrection: false,
    });
    assertContains(handle.overlay?.(), "analytic only (no erosion cache)");
  });

  test("moves the patch when the site moves, and reports it", async () => {
    const volcano = await fixture();
    const canyon = await fixture("vallesRift");
    assert.equal(canyon.handle.marsGeneratorState().site, MARS_SITE_PRESETS.vallesRift!.name);
    // The canyon's site sits ~13 km below the volcano's summit, so the same local (0,0) must differ.
    assert.ok(Math.abs(volcano.terrain.getHeightAt(0, 0) - canyon.terrain.getHeightAt(0, 0)) > 1000);
    assertContains(canyon.handle.overlay?.(), `${MARS_SITE_PRESETS.vallesRift!.latDeg}°`);

    // An arbitrary lat,lon pair is a site too, and an unknown key falls back to the volcano.
    const crater = await fixture("0,0");
    assertMatchObject(crater.handle.marsGeneratorState(), { site: "lat 0 lon 0", latDeg: 0, lonDeg: 0 });
    const unknown = await fixture("not-a-site");
    assert.equal(unknown.handle.marsGeneratorState().site, MARS_SITE_PRESETS.olympusMons!.name);
  });

  test("gives every resident tile its own splat mask built from the stage's own weights", async () => {
    const { scene, terrain, tick, gpu } = await fixture();
    tick(2);
    const ready = [...terrain.chunks.values()].filter((chunk) => chunk.tile);
    assert.ok(ready.length > 0);
    const layered = terrain.layeredMaterial!;
    assert.deepEqual(layered.layers.map((l) => l.name), marsSurfaceLayers().map((l) => l.name));
    for (const chunk of ready) {
      const tile = chunk.tile!;
      const material = tile.gpuMaterial;
      assert.ok(material instanceof SplatMaterial, `tile ${tile.cx},${tile.cz} has a splat material`);
      assert.equal((material!.layers).length, 4);
      assert.equal(material!.maps.albedo, layered.maps!.albedo);
      assert.equal(material!.maps.albedo.desc.depthOrArrayLayers, 4);
      // The mask is the stage's own four-channel output for this cell, not a placeholder.
      const upload = [...gpu.mock.liveTextures].find((t) => t.label === material!.weightMap.desc.label)!;
      assert.deepEqual(upload.texelBytes(), layered.weightPixels(tile.cell));
      // The chunk entity draws with the tile's splat material (the apron material is the fallback).
      assert.equal(scene.world.getComponent(chunk.entityId!, Renderable)!.material, material);
      assert.notEqual(material, terrain.material);
    }
  });

  test("keeps chunk entities bounded: terrain is geometry plus the skirt, camera and two lights", async () => {
    const { scene, terrain, tick } = await fixture();
    tick(2);
    const ready = [...terrain.chunks.values()].filter((chunk) => chunk.state === "ready" && chunk.tile);
    assert.ok(ready.length > 0);
    // One entity per chunk, plus the horizon skirt, the camera and two lights.
    assert.ok(scene.entityCount <= ready.length + 4);
    assert.ok(scene.entityCount >= ready.length);
  });

  test("keeps the camera above the ported surface across the flank and at the closest zoom", async () => {
    const { handle, terrain, controls, tick } = await fixture();
    tick(1);
    // The preset's own framing must be inside the controller's limits and above the heightfield.
    const start = controls.eyePosition();
    assert.ok(start.y > terrain.getHeightAt(start.x, start.z) + 1);

    for (const [dx, dy] of [
      [400, 0],
      [0, 400],
      [-900, 900],
    ]) {
      controls.panBy(dx, dy, 720);
      const eye = controls.eyePosition();
      assert.ok(eye.y > terrain.getHeightAt(eye.x, eye.z) + 1);
    }
    for (let i = 0; i < 8; i++) controls.zoomBy(-600);
    const floor = controls.eyePosition();
    assert.ok(floor.y > terrain.getHeightAt(floor.x, floor.z) + 1);

    // Sky seaLevel tracks the ported surface under the look-at (the seam rule the Martian demos document).
    tick(1);
    const target = controls.target;
    assertCloseTo(handle.scene.settings.sky.seaLevel, terrain.getHeightAt(target.x, target.z), 3);
  });

  test("adds local material veneers at the crater field and volcano summit", async () => {
    // The geology label remains regional, but the renderer now adds a seeded, planet-space veneer.
    // The 0,0 inspector still frames tile (-1, 2), whose 128 m footprint crosses the rock/crust rim.
    const crater = await fixture("0,0");
    crater.tick(10);
    const craterTiles = tileChannelShares(crater.terrain);
    const mixed = craterTiles.map((tile) => tile.shares);
    assert.ok(mixed.length >= 6);
    // Pin the known rim tile itself, so local veneers cannot stand in for the real rock/crust class boundary.
    const rim = craterTiles.find((tile) => tile.cx === -1 && tile.cz === 2);
    assert.ok(rim, "the inspector should keep the known rim tile resident");
    assert.ok(rim.shares[1]! > 0.2 && rim.shares[3]! > 0.15, `the rim must retain rock and crust: ${rim.shares}`);
    assert.ok(bestSecondShare([rim.shares]) > 0.25);
    assert.ok(meanChannelShares(mixed).every((share) => share > 0.03));

    const volcano = await fixture();
    volcano.tick(10);
    const summitTiles = tileChannelShares(volcano.terrain);
    const summit = summitTiles.map((tile) => tile.shares);
    assert.ok(summit.length >= 6);
    assert.ok(bestSecondShare(summit) > 0.1, "the summit should no longer be a one-channel material patch");
    assert.ok(meanChannelShares(summit)[2]! > 0.08, "fine sediment should appear over the volcanic substrate");
  });
});

await finish();
