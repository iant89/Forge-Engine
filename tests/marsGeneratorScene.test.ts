/**
 * The ported Mars generator as a **site inspector** (Phase 10.9) —
 * `examples/src/scenes/marsGeneratorScene.ts`.
 *
 * `tests/marsShowcase.test.ts` already pins the rover's patch (one surveyed site, worker-backed
 * streaming, tile-owned splat masks). What this suite adds is the inspector's own contract: the demo
 * URL chooses the site, the advised `adviseMarsTile` sizing reaches the world, the port's
 * dust/rock/sand/crust weights land in per-tile masks through main's `SplatMaterial` path, and the
 * camera preset agrees with the ported surface it orbits. Real pixels are the browser gate's job
 * (`check:browser`, which loads `?scene=mars-generator&marssite=0,0`); this suite runs on the strict
 * mock device.
 */
import { afterEach, describe, expect, it } from "vitest";
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
} from "../examples/src/scenes/marsGeneratorScene.js";
import { resolveDemoSceneName } from "../examples/src/sceneSelection.js";
import { OrbitControls } from "../examples/src/controls/orbitControls.js";

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
    expect(gpu.mock.outstanding.buffers).toEqual([]);
    expect(gpu.mock.outstanding.textures).toEqual([]);
    expect(gpu.mock.errors).toEqual([]);
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
function channelShares(terrain: TerrainWorld): number[][] {
  const layered = terrain.layeredMaterial!;
  const out: number[][] = [];
  for (const chunk of terrain.chunks.values()) {
    const cell = chunk.tile?.cell;
    if (!cell) continue;
    const pixels = layered.weightPixels(cell);
    const sums = [0, 0, 0, 0];
    for (let i = 0; i < pixels.length; i += 4) for (let c = 0; c < 4; c++) sums[c] += pixels[i + c];
    const total = sums[0] + sums[1] + sums[2] + sums[3];
    if (total > 0) out.push(sums.map((s) => s / total));
  }
  return out;
}

/** The largest non-dominant share in a patch — 0 when every tile is one channel. */
const bestSecondShare = (shares: number[][]): number =>
  shares.length === 0 ? 0 : Math.max(...shares.map((s) => [...s].sort((a, b) => b - a)[1]!));

describe("Mars generator inspector (Phase 10.9)", () => {
  it("is addressable as ?scene=mars-generator, with the port's aliases", () => {
    expect(resolveDemoSceneName("mars-generator")).toBe("mars-generator");
    expect(resolveDemoSceneName("mars-port")).toBe("mars-generator");
    expect(resolveDemoSceneName("mars-generator-port")).toBe("mars-generator");
    // `?scene=mars` keeps meaning the hand-written Martian terrain demo, and the showcase keeps its slot.
    expect(resolveDemoSceneName("mars")).toBe("terrain");
    expect(resolveDemoSceneName("mars-showcase")).toBe("mars-showcase");
  });

  it("accepts `lat,lon` site options and rejects everything else", () => {
    expect(parseMarsSiteParam("0,0")).toEqual({ latDeg: 0, lonDeg: 0 });
    expect(parseMarsSiteParam(" -12.5 , 180 ")).toEqual({ latDeg: -12.5, lonDeg: 180 });
    expect(parseMarsSiteParam("91,0")).toBeNull(); // out of range
    expect(parseMarsSiteParam("0,181")).toBeNull();
    expect(parseMarsSiteParam("olympusMons")).toBeNull();
    expect(parseMarsSiteParam("1,2,3")).toBeNull();
    expect(parseMarsSiteParam("")).toBeNull();
  });

  it("streams the ported planet at the advised sizing, analytic-only, ready for workers", async () => {
    const { handle, terrain, gpu } = await fixture();
    const advice = adviseMarsTile(MARS_GENERATOR_TILE.chunkSize, MARS_GENERATOR_TILE.resolution);

    expect(terrain.pipeline.stages).toHaveLength(1);
    const stage = terrain.pipeline.stages[0] as MarsTerrainStage;
    expect(stage).toBeInstanceOf(MarsTerrainStage);
    // The volcano preset is the generator CLI's own default; the terrain seed is the port's seed.
    expect(stage.site.latDeg).toBe(MARS_SITE_PRESETS.olympusMons!.latDeg);
    expect(stage.site.lonDeg).toBe(MARS_SITE_PRESETS.olympusMons!.lonDeg);
    expect(stage.hasErosionCorrection).toBe(false);
    expect(terrain.seed).toBe(1337);
    // The repo ships no Stage A cache, so the demo must not pretend it has one.
    expect(advice.ok).toBe(true);
    expect(advice.detailLevel).toBe("micro");
    expect(advice.vertexSpacing).toBeCloseTo(4, 6);
    expect(terrain.chunkSize).toBe(MARS_GENERATOR_TILE.chunkSize);
    expect(terrain.chunkResolution).toBe(MARS_GENERATOR_TILE.resolution);
    expect(terrain.skirtDepth).toBe(advice.recommendedSkirtDepth);
    expect(terrain.syncGeneration).toBe(false); // workers when a scheduler is mounted, inline otherwise
    expect(terrain.budgets.generationsPerFrame).toBe(1);
    expect(terrain.warmUpChunks).toBe(9);
    expect(gpu.mock.liveTextures.size).toBeGreaterThan(0); // the four shared PBR arrays

    expect(handle.marsGeneratorState()).toMatchObject({
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
    expect(handle.overlay?.()).toContain("analytic only (no erosion cache)");
  });

  it("moves the patch when the site moves, and reports it", async () => {
    const volcano = await fixture();
    const canyon = await fixture("vallesRift");
    expect(canyon.handle.marsGeneratorState().site).toBe(MARS_SITE_PRESETS.vallesRift!.name);
    // The canyon's site sits ~13 km below the volcano's summit, so the same local (0,0) must differ.
    expect(Math.abs(volcano.terrain.getHeightAt(0, 0) - canyon.terrain.getHeightAt(0, 0))).toBeGreaterThan(1000);
    expect(canyon.handle.overlay?.()).toContain(`${MARS_SITE_PRESETS.vallesRift!.latDeg}°`);

    // An arbitrary lat,lon pair is a site too, and an unknown key falls back to the volcano.
    const crater = await fixture("0,0");
    expect(crater.handle.marsGeneratorState()).toMatchObject({ site: "lat 0 lon 0", latDeg: 0, lonDeg: 0 });
    const unknown = await fixture("not-a-site");
    expect(unknown.handle.marsGeneratorState().site).toBe(MARS_SITE_PRESETS.olympusMons!.name);
  });

  it("gives every resident tile its own splat mask built from the stage's own weights", async () => {
    const { scene, terrain, tick, gpu } = await fixture();
    tick(2);
    const ready = [...terrain.chunks.values()].filter((chunk) => chunk.tile);
    expect(ready.length).toBeGreaterThan(0);
    const layered = terrain.layeredMaterial!;
    expect(layered.layers.map((l) => l.name)).toEqual(marsSurfaceLayers().map((l) => l.name));
    for (const chunk of ready) {
      const tile = chunk.tile!;
      const material = tile.gpuMaterial;
      expect(material, `tile ${tile.cx},${tile.cz} has a splat material`).toBeInstanceOf(SplatMaterial);
      expect(material!.layers).toHaveLength(4);
      expect(material!.maps.albedo).toBe(layered.maps!.albedo);
      expect(material!.maps.albedo.desc.depthOrArrayLayers).toBe(4);
      // The mask is the stage's own four-channel output for this cell, not a placeholder.
      const upload = [...gpu.mock.liveTextures].find((t) => t.label === material!.weightMap.desc.label)!;
      expect(upload.texelBytes()).toEqual(layered.weightPixels(tile.cell));
      // The chunk entity draws with the tile's splat material (the apron material is the fallback).
      expect(scene.world.getComponent(chunk.entityId!, Renderable)!.material).toBe(material);
      expect(material).not.toBe(terrain.material);
    }
  });

  it("keeps chunk entities bounded: terrain is geometry plus the skirt, camera and two lights", async () => {
    const { scene, terrain, tick } = await fixture();
    tick(2);
    const ready = [...terrain.chunks.values()].filter((chunk) => chunk.state === "ready" && chunk.tile);
    expect(ready.length).toBeGreaterThan(0);
    // One entity per chunk, plus the horizon skirt, the camera and two lights.
    expect(scene.entityCount).toBeLessThanOrEqual(ready.length + 4);
    expect(scene.entityCount).toBeGreaterThanOrEqual(ready.length);
  });

  it("keeps the camera above the ported surface across the flank and at the closest zoom", async () => {
    const { handle, terrain, controls, tick } = await fixture();
    tick(1);
    // The preset's own framing must be inside the controller's limits and above the heightfield.
    const start = controls.eyePosition();
    expect(start.y).toBeGreaterThan(terrain.getHeightAt(start.x, start.z) + 1);

    for (const [dx, dy] of [
      [400, 0],
      [0, 400],
      [-900, 900],
    ]) {
      controls.panBy(dx, dy, 720);
      const eye = controls.eyePosition();
      expect(eye.y).toBeGreaterThan(terrain.getHeightAt(eye.x, eye.z) + 1);
    }
    for (let i = 0; i < 8; i++) controls.zoomBy(-600);
    const floor = controls.eyePosition();
    expect(floor.y).toBeGreaterThan(terrain.getHeightAt(floor.x, floor.z) + 1);

    // Sky seaLevel tracks the ported surface under the look-at (the seam rule the Martian demos document).
    tick(1);
    const target = controls.target;
    expect(handle.scene.settings.sky.seaLevel).toBeCloseTo(terrain.getHeightAt(target.x, target.z), 3);
  });

  it("mixes two channels inside one tile at the crater field, and stays flat on the volcano", async () => {
    // The port assigns a material per terrain *region*, so most sites bake one channel for
    // kilometres — the volcano summit included. The crater field at 0,0 is the site where a single
    // 128 m tile straddles the rim, and its mask is the only place the demo shows a real blend.
    const crater = await fixture("0,0");
    crater.tick(10);
    const mixed = channelShares(crater.terrain);
    expect(mixed.length).toBeGreaterThanOrEqual(6);
    // Measured over the streamed patch: the best tile splits ~45/55 rock/crust, so 0.25 is a floor
    // a broken or placeholder mask cannot clear without being a genuine two-channel blend.
    expect(bestSecondShare(mixed)).toBeGreaterThan(0.25);

    const volcano = await fixture();
    volcano.tick(10);
    const summit = channelShares(volcano.terrain);
    expect(summit.length).toBeGreaterThanOrEqual(6);
    expect(bestSecondShare(summit)).toBeLessThan(0.05);
  });
});
