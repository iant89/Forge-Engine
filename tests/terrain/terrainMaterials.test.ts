/**
 * @suite terrain:terrainMaterials
 * @group unit
 * @covers engine/src/core/engine.ts
 * @covers engine/src/core/log.ts
 * @covers engine/src/core/time.ts
 * @covers engine/src/debug/profiler.ts
 * @covers engine/src/gpu/device.ts
 * @covers engine/src/index.ts
 * @covers engine/src/math/color.ts
 * @covers engine/src/math/vec.ts
 * @covers engine/src/rendering/material.ts
 * @covers engine/src/rendering/pipeline.ts
 * @covers engine/src/rendering/renderer.ts
 * @covers engine/src/rendering/splatMaterial.ts
 * @covers engine/src/rendering/uniforms.ts
 * @covers engine/src/resources/texture.ts
 * @covers engine/src/scene/components/index.ts
 * @covers engine/src/scene/scene.ts
 * @covers engine/src/scene/systems.ts
 * @covers engine/src/terrain/budget.ts
 * @covers engine/src/terrain/chunk.ts
 * @covers engine/src/terrain/generators.ts
 * @covers engine/src/terrain/material.ts
 * @covers engine/src/terrain/world.ts
 * @desc The real splat upload/draw/lifetime path; mock rasterization is NOT pixel evidence
 */

export const suite = {
  name: "terrain:terrainMaterials",
  group: "unit",
  covers:   [
    "engine/src/core/engine.ts",
    "engine/src/core/log.ts",
    "engine/src/core/time.ts",
    "engine/src/debug/profiler.ts",
    "engine/src/gpu/device.ts",
    "engine/src/index.ts",
    "engine/src/math/color.ts",
    "engine/src/math/vec.ts",
    "engine/src/rendering/material.ts",
    "engine/src/rendering/pipeline.ts",
    "engine/src/rendering/renderer.ts",
    "engine/src/rendering/splatMaterial.ts",
    "engine/src/rendering/uniforms.ts",
    "engine/src/resources/texture.ts",
    "engine/src/scene/components/index.ts",
    "engine/src/scene/scene.ts",
    "engine/src/scene/systems.ts",
    "engine/src/terrain/budget.ts",
    "engine/src/terrain/chunk.ts",
    "engine/src/terrain/generators.ts",
    "engine/src/terrain/material.ts",
    "engine/src/terrain/world.ts"
  ],
  desc: "The real splat upload/draw/lifetime path; mock rasterization is NOT pixel evidence",
};
/** The real splat upload/draw/lifetime path; mock rasterization is NOT pixel evidence. */
import assert from "node:assert/strict";
import { afterEach, assertCloseTo, assertThrows, finish, group, test } from "selrun";
import {
  Camera, Clock, Color, GraphicsDevice, LayeredTerrainMaterial, Light, Logger, Material, PipelineFactory,
  Profiler, Renderable, Renderer, Scene, SplatMaterial, SplatUniforms, SystemScratch, TerrainTile,
  TerrainWorld, Texture, Vec3, boxFilterRgba8, createWorldCell, estimateTileBytes, splatUvTransform,
  type Engine, type SystemContext, type TerrainSurfaceLayer,
} from "@forge/engine";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
async function device() {
  const gpu = await GraphicsDevice.create({ forceMock: true });
  cleanup.push(async () => {
    await gpu.dispose();
    assert.deepEqual(gpu.mock.outstanding.buffers, []);
    assert.deepEqual(gpu.mock.outstanding.textures, []);
    assert.deepEqual(gpu.mock.errors, []);
  });
  return gpu;
}
const layers = (): TerrainSurfaceLayer[] => Array.from({ length: 4 }, (_, i) => ({
  name: `layer-${i}`, color: new Color(0.1 + i * 0.2, 0.4, 0.3),
  roughness: 0.9 - i * 0.1, metallic: i * 0.1, biomeChannel: i, textureSize: 7.5 + i,
}));
function cell(res = 3, cx = 0, cz = 0) {
  const c = createWorldCell(cx, cz, 128, res, 7);
  for (let i = 0; i < c.heights.length; i++) c.biomes[i * 4 + i % 4] = 1;
  return c;
}

group("four-layer terrain materials", () => {
  test("uploads independent array slices and complete mip chains without overwriting another slice", async () => {
    const gpu = await device();
    const pixels = [0, 60, 128, 200].map((v) => new Uint8Array([v, 0, 0, 255, v, 0, 0, 255, v, 0, 0, 255, v, 0, 0, 255]));
    pixels[0] = new Uint8Array([0, 0, 0, 255, 255, 255, 255, 255, 0, 0, 0, 255, 255, 255, 255, 255]);
    const texture = Texture.fromRgba8Array(gpu, 2, 2, pixels, { label: "array-mips", srgb: true });
    cleanup.push(() => texture.dispose());
    assert.equal(texture.desc.depthOrArrayLayers, 4);
    assert.equal(texture.mipLevels, 2);
    assert.equal(texture.gpuBytes, 80);
    assert.notEqual(texture.view, texture.viewFor({ dimension: "2d", arrayLayerCount: 1 }));
    assert.equal(texture.view, texture.viewFor({ dimension: "2d-array" }));
    const raw = [...gpu.mock.liveTextures].find((t) => t.label === "array-mips")!;
    for (let i = 0; i < 4; i++) {
      assert.deepEqual(raw.texelBytes(0, i), pixels[i]);
      assert.deepEqual(raw.texelBytes(1, i), boxFilterRgba8(pixels[i]!, 2, 2, 1, 1, "srgb"));
    }
    assertThrows(() => Texture.fromRgba8Array(gpu, 2, 2, [new Uint8Array(3)]), /each layer/);
    assertThrows(() => Texture.fromRgba8Array(gpu, 1, 1, [], {}), /at least one layer/);
    assertThrows(() => Texture.fromRgba8Array(gpu, 1, 1, [new Uint8Array(4)], { srgb: true, normal: true }), /cannot be sRGB/);
  });

  test("packs the cell's gated height/slope/biome weights, preserving channel order and safe fallbacks", () => {
    const config = layers();
    config[0]!.heightRange = [0, 10];
    config[0]!.blendWidth = 1;
    config[1]!.slopeRange = [0.5, 1];
    config[1]!.blendWidth = 1;
    const material = new LayeredTerrainMaterial({ layers: config });
    const c = cell(2);
    c.heights[0] = 20; // excluded dust -> equal fallback, never a black pixel
    c.slopes[1] = 0.7;
    const bytes = material.weightPixels(c);
    assert.deepEqual([...bytes.subarray(0, 4)], [64, 64, 64, 64]);
    assert.deepEqual([...bytes.subarray(4, 8)], [0, 255, 0, 0]);
    assert.deepEqual([...bytes.subarray(8, 12)], [0, 0, 255, 0]);
    assert.deepEqual([...bytes.subarray(12, 16)], [0, 0, 0, 255]);
    c.biomes.fill(Number.NaN);
    assert.deepEqual([...material.weightPixels(c)], Array(16).fill(64));
    assertThrows(() => new LayeredTerrainMaterial({ layers: [] }), /at least one/);
    assertThrows(() => new LayeredTerrainMaterial({ layers: config.slice(0, 2) }).weightPixels(c), /four layers/);
  });

  test("keeps world-space texture phase at negative/large coordinates and across neighbouring tiles", () => {
    for (const origin of [-256, -128, 0, 128, 3_389_500, 1e10]) {
      const a = splatUvTransform(origin, -origin, 128, 7.5);
      const b = splatUvTransform(origin + 128, -origin, 128, 7.5);
      const phaseA = (a[2] + a[0]) % 1;
      assertCloseTo(phaseA, b[2], 10);
      assert.ok(a[2] >= 0);
      assert.ok(a[2] < 1);
    }
    assertThrows(() => splatUvTransform(0, 0, 128, 0), /positive/);
  });

  test("preserves matching splat edges at different resolutions and retains edge UVs on skirts", () => {
    const material = new LayeredTerrainMaterial({ layers: layers() });
    const a = cell(5, -1), b = cell(3, 0);
    // A shared analytic two-channel field; no generator-dependent slope/biome discontinuity.
    for (const c of [a, b]) for (let z = 0; z < c.resolution; z++) for (let x = 0; x < c.resolution; x++) {
      const o = (z * c.resolution + x) * 4;
      c.biomes.set([1 - z / (c.resolution - 1), z / (c.resolution - 1), 0, 0], o);
    }
    const wa = material.weightPixels(a), wb = material.weightPixels(b);
    for (let z = 0; z < 3; z++) {
      assert.deepEqual(wa.slice((z * 2 * 5 + 4) * 4, (z * 2 * 5 + 5) * 4), wb.slice(z * 3 * 4, z * 3 * 4 + 4));
    }
    const tile = TerrainTile.fromCell({ cx: -1, cz: 0, size: 128, cell: a, geomorphAlpha: 0.8 });
    const uv = tile.geometrySource.uvs!;
    for (let x = 0; x < 5; x++) assert.deepEqual(uv.slice((25 + x) * 2, (26 + x) * 2), uv.slice(x * 2, (x + 1) * 2));
    tile.dispose();
  });

  test("draws splats through standard depth/shadow paths without changing ordinary material layouts", async () => {
    const gpu = await device();
    const helper = new LayeredTerrainMaterial({ layers: layers() });
    const c = cell();
    const tile = TerrainTile.fromCell({ cx: 0, cz: 0, size: 128, cell: c });
    tile.gpuMaterial = helper.createTileMaterial(gpu, c);
    const renderer = new Renderer(gpu, { shadowMapSize: 64, shadowCascades: 1, bloom: false, ssao: false, objectCulling: "cpu" });
    const scene = new Scene();
    scene.settings.skyEnabled = false;
    scene.settings.hdr = false;
    scene.settings.postProcessing = false;
    scene.settings.shadow.cascades = 1;
    scene.settings.shadow.mapSize = 64;
    const sunEntity = scene.createTransformedEntity("sun", new Vec3(64, 100, 0));
    const sun = sunEntity.add(new Light()); sun.kind = "directional"; sun.castShadow = true;
    sunEntity.transform.lookAt(new Vec3(64, 0, 64));
    const eye = scene.createTransformedEntity("camera", new Vec3(64, 60, -40));
    eye.add(new Camera()); eye.transform.lookAt(new Vec3(64, 0, 64));
    const r = scene.createTransformedEntity("tile", new Vec3()).add(new Renderable());
    r.geometry = tile.uploadGpu(gpu); r.material = tile.gpuMaterial; r.castShadow = true;
    const ordinary = new Material();
    cleanup.push(() => { scene.dispose(); renderer.dispose(); tile.dispose(); ordinary.dispose(); helper.dispose(); });
    renderer.renderScene(scene);
    assert.equal(renderer.stats.drawCalls, 1);
    assert.equal(renderer.stats.prepassDraws, 1);
    assert.ok(renderer.stats.shadowsDrawn > 0);
    assert.equal(gpu.mock.commandLog.some((e) => e.type === "setPipeline" && String(e["pipeline"]).includes("terrain|")), true);
    const buffer = [...gpu.mock.liveBuffers].find((b) => b.label.startsWith("splat."))!;
    assert.equal(buffer.size, 224);
    const values = new Float32Array(buffer.data);
    assertCloseTo(values[SplatUniforms.offsetOf("surfaces") / 4], 0.9, 2);
    const textures = gpu.mock.liveTextures.size;
    const writes = gpu.mock.queue.writeTextureCalls;
    renderer.renderScene(scene);
    assert.equal(renderer.stats.texturesCreated, 0);
    assert.equal(gpu.mock.liveTextures.size, textures);
    assert.equal(gpu.mock.queue.writeTextureCalls, writes);
    r.material = ordinary;
    renderer.renderScene(scene);
    assert.equal(renderer.stats.drawCalls, 1);
    assert.notEqual(ordinary.bindGroup, tile.gpuMaterial.bindGroup);
    // Same geometry/pipeline but a different material needs its own binding, not an instance of
    // the first surface. Reusing the very same material still permits instancing.
    const second = scene.createTransformedEntity("second", new Vec3()).add(new Renderable());
    second.geometry = r.geometry; second.material = tile.gpuMaterial;
    renderer.renderScene(scene);
    assert.equal(renderer.stats.drawCalls, 2);
    r.material = tile.gpuMaterial;
    renderer.renderScene(scene);
    assert.equal(renderer.stats.drawCalls, 1);
    assert.equal(renderer.stats.instances, 2);
    assert.deepEqual(gpu.mock.errors, []);
  });

  test("releases per-tile masks on remesh/eviction, accounts for their budget, and preserves ordinary fallback", async () => {
    const gpu = await device();
    const helper = new LayeredTerrainMaterial({ layers: layers() });
    const scene = new Scene();
    scene.attachToEngine({ gpu } as Engine);
    const terrain = new TerrainWorld({ chunkSize: 32, chunkResolution: 9, visibleChunks: 3, generationsPerFrame: 3, maxLOD: 1, viewDistance: 64, syncGeneration: true, horizonSkirt: false, layeredMaterial: helper });
    scene.add(terrain);
    const eye = scene.createTransformedEntity("camera", new Vec3(0, 20, 0)); eye.add(new Camera());
    const context: SystemContext = { world: scene.world, clock: new Clock(), dt: 1 / 60, fixedDt: 1 / 60,
      fixedSteps: 1, alpha: 0, elapsed: 0, frame: 0, logger: new Logger(), profiler: new Profiler(),
      services: { get: () => undefined, engineConfig: {} }, scratch: new SystemScratch() };
    cleanup.push(() => scene.dispose());
    terrain.update(context, context.dt);
    const first = [...terrain.chunks.values()].find((chunk) => chunk.tile?.gpuMaterial)!.tile!;
    const old = first.gpuMaterial!;
    assert.ok(old instanceof SplatMaterial);
    assert.equal(estimateTileBytes(9, true) - estimateTileBytes(9), 9 * 9 * 4 + 304);
    terrain.setLayeredMaterialsEnabled(false);
    for (const id of terrain.activeEntities.values()) assert.equal(scene.world.getComponent(id, Renderable)!.material, terrain.material);
    terrain.setLayeredMaterialsEnabled(true);
    for (const id of terrain.activeEntities.values()) assert.ok(scene.world.getComponent(id, Renderable)!.material instanceof SplatMaterial);
    // Existing streaming invalidation/remesh path, not manual mask disposal.
    eye.transform.position = new Vec3(4096, 20, 4096);
    terrain.update(context, context.dt);
    assert.equal(old.weightMap.releasedState, true);
    assert.equal(old.maps.albedo.releasedState, false); // shared arrays remain valid for new tiles
  });

  test("rejects invalid GPU layer/map contracts without leaking a newly created mask", async () => {
    const gpu = await device();
    const helper = new LayeredTerrainMaterial({ layers: layers() });
    const material = helper.createTileMaterial(gpu, cell());
    cleanup.push(() => { material.dispose(); helper.dispose(); });
    assertThrows(() => new SplatMaterial({ layers: layers().slice(0, 3), maps: material.maps, weightMap: material.weightMap, size: 128, originX: 0, originZ: 0 }), /four/);
    const single = Texture.fromRgba8(gpu, 1, 1, new Uint8Array([255, 255, 255, 255]), { srgb: true });
    cleanup.push(() => single.dispose());
    const bad = new LayeredTerrainMaterial({ layers: layers(), maps: { ...material.maps, albedo: single } });
    const textures = gpu.mock.liveTextures.size;
    assertThrows(() => bad.createTileMaterial(gpu, cell()), /four rgba8unorm-srgb/);
    assert.equal(gpu.mock.liveTextures.size, textures); // the temporary mask was released
    bad.dispose();
    const clone = material.clone({ roughness: 0.7 });
    assert.ok(clone instanceof SplatMaterial);
    assert.equal(clone.weightMap, material.weightMap);
    assert.equal(clone.roughness, 0.7);
    assertThrows(() => clone.setTechnique("standard"), /terrain technique/);
    clone.dispose();
    assert.equal(material.weightMap.releasedState, false);
    const factory = new PipelineFactory(gpu);
    cleanup.push(() => factory.invalidate());
    assert.ok(factory.get({ technique: "terrain", colorFormat: "rgba8unorm", depthFormat: "depth24plus", transparent: false, doubleSided: false, instanced: true }));
  });
});

await finish();
