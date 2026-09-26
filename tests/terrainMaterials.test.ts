/** The real splat upload/draw/lifetime path; mock rasterization is NOT pixel evidence. */
import { afterEach, describe, expect, it } from "vitest";
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
    expect(gpu.mock.outstanding.buffers).toEqual([]);
    expect(gpu.mock.outstanding.textures).toEqual([]);
    expect(gpu.mock.errors).toEqual([]);
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

describe("four-layer terrain materials", () => {
  it("uploads independent array slices and complete mip chains without overwriting another slice", async () => {
    const gpu = await device();
    const pixels = [0, 60, 128, 200].map((v) => new Uint8Array([v, 0, 0, 255, v, 0, 0, 255, v, 0, 0, 255, v, 0, 0, 255]));
    pixels[0] = new Uint8Array([0, 0, 0, 255, 255, 255, 255, 255, 0, 0, 0, 255, 255, 255, 255, 255]);
    const texture = Texture.fromRgba8Array(gpu, 2, 2, pixels, { label: "array-mips", srgb: true });
    cleanup.push(() => texture.dispose());
    expect(texture.desc.depthOrArrayLayers).toBe(4);
    expect(texture.mipLevels).toBe(2);
    expect(texture.gpuBytes).toBe(80);
    expect(texture.view).not.toBe(texture.viewFor({ dimension: "2d", arrayLayerCount: 1 }));
    expect(texture.view).toBe(texture.viewFor({ dimension: "2d-array" }));
    const raw = [...gpu.mock.liveTextures].find((t) => t.label === "array-mips")!;
    for (let i = 0; i < 4; i++) {
      expect(raw.texelBytes(0, i)).toEqual(pixels[i]);
      expect(raw.texelBytes(1, i)).toEqual(boxFilterRgba8(pixels[i]!, 2, 2, 1, 1, "srgb"));
    }
    expect(() => Texture.fromRgba8Array(gpu, 2, 2, [new Uint8Array(3)])).toThrow(/each layer/);
    expect(() => Texture.fromRgba8Array(gpu, 1, 1, [], {})).toThrow(/at least one layer/);
    expect(() => Texture.fromRgba8Array(gpu, 1, 1, [new Uint8Array(4)], { srgb: true, normal: true })).toThrow(/cannot be sRGB/);
  });

  it("packs the cell's gated height/slope/biome weights, preserving channel order and safe fallbacks", () => {
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
    expect([...bytes.subarray(0, 4)]).toEqual([64, 64, 64, 64]);
    expect([...bytes.subarray(4, 8)]).toEqual([0, 255, 0, 0]);
    expect([...bytes.subarray(8, 12)]).toEqual([0, 0, 255, 0]);
    expect([...bytes.subarray(12, 16)]).toEqual([0, 0, 0, 255]);
    c.biomes.fill(Number.NaN);
    expect([...material.weightPixels(c)]).toEqual(Array(16).fill(64));
    expect(() => new LayeredTerrainMaterial({ layers: [] })).toThrow(/at least one/);
    expect(() => new LayeredTerrainMaterial({ layers: config.slice(0, 2) }).weightPixels(c)).toThrow(/four layers/);
  });

  it("keeps world-space texture phase at negative/large coordinates and across neighbouring tiles", () => {
    for (const origin of [-256, -128, 0, 128, 3_389_500, 1e10]) {
      const a = splatUvTransform(origin, -origin, 128, 7.5);
      const b = splatUvTransform(origin + 128, -origin, 128, 7.5);
      const phaseA = (a[2] + a[0]) % 1;
      expect(phaseA).toBeCloseTo(b[2], 10);
      expect(a[2]).toBeGreaterThanOrEqual(0);
      expect(a[2]).toBeLessThan(1);
    }
    expect(() => splatUvTransform(0, 0, 128, 0)).toThrow(/positive/);
  });

  it("preserves matching splat edges at different resolutions and retains edge UVs on skirts", () => {
    const material = new LayeredTerrainMaterial({ layers: layers() });
    const a = cell(5, -1), b = cell(3, 0);
    // A shared analytic two-channel field; no generator-dependent slope/biome discontinuity.
    for (const c of [a, b]) for (let z = 0; z < c.resolution; z++) for (let x = 0; x < c.resolution; x++) {
      const o = (z * c.resolution + x) * 4;
      c.biomes.set([1 - z / (c.resolution - 1), z / (c.resolution - 1), 0, 0], o);
    }
    const wa = material.weightPixels(a), wb = material.weightPixels(b);
    for (let z = 0; z < 3; z++) {
      expect(wa.slice((z * 2 * 5 + 4) * 4, (z * 2 * 5 + 5) * 4)).toEqual(wb.slice(z * 3 * 4, z * 3 * 4 + 4));
    }
    const tile = TerrainTile.fromCell({ cx: -1, cz: 0, size: 128, cell: a, geomorphAlpha: 0.8 });
    const uv = tile.geometrySource.uvs!;
    for (let x = 0; x < 5; x++) expect(uv.slice((25 + x) * 2, (26 + x) * 2)).toEqual(uv.slice(x * 2, (x + 1) * 2));
    tile.dispose();
  });

  it("draws splats through standard depth/shadow paths without changing ordinary material layouts", async () => {
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
    expect(renderer.stats.drawCalls).toBe(1);
    expect(renderer.stats.prepassDraws).toBe(1);
    expect(renderer.stats.shadowsDrawn).toBeGreaterThan(0);
    expect(gpu.mock.commandLog.some((e) => e.type === "setPipeline" && String(e["pipeline"]).includes("terrain|"))).toBe(true);
    const buffer = [...gpu.mock.liveBuffers].find((b) => b.label.startsWith("splat."))!;
    expect(buffer.size).toBe(224);
    const values = new Float32Array(buffer.data);
    expect(values[SplatUniforms.offsetOf("surfaces") / 4]).toBeCloseTo(0.9);
    const textures = gpu.mock.liveTextures.size;
    const writes = gpu.mock.queue.writeTextureCalls;
    renderer.renderScene(scene);
    expect(renderer.stats.texturesCreated).toBe(0);
    expect(gpu.mock.liveTextures.size).toBe(textures);
    expect(gpu.mock.queue.writeTextureCalls).toBe(writes);
    r.material = ordinary;
    renderer.renderScene(scene);
    expect(renderer.stats.drawCalls).toBe(1);
    expect(ordinary.bindGroup).not.toBe(tile.gpuMaterial.bindGroup);
    // Same geometry/pipeline but a different material needs its own binding, not an instance of
    // the first surface. Reusing the very same material still permits instancing.
    const second = scene.createTransformedEntity("second", new Vec3()).add(new Renderable());
    second.geometry = r.geometry; second.material = tile.gpuMaterial;
    renderer.renderScene(scene);
    expect(renderer.stats.drawCalls).toBe(2);
    r.material = tile.gpuMaterial;
    renderer.renderScene(scene);
    expect(renderer.stats.drawCalls).toBe(1);
    expect(renderer.stats.instances).toBe(2);
    expect(gpu.mock.errors).toEqual([]);
  });

  it("releases per-tile masks on remesh/eviction, accounts for their budget, and preserves ordinary fallback", async () => {
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
    expect(old).toBeInstanceOf(SplatMaterial);
    expect(estimateTileBytes(9, true) - estimateTileBytes(9)).toBe(9 * 9 * 4 + 304);
    terrain.setLayeredMaterialsEnabled(false);
    for (const id of terrain.activeEntities.values()) expect(scene.world.getComponent(id, Renderable)!.material).toBe(terrain.material);
    terrain.setLayeredMaterialsEnabled(true);
    for (const id of terrain.activeEntities.values()) expect(scene.world.getComponent(id, Renderable)!.material).toBeInstanceOf(SplatMaterial);
    // Existing streaming invalidation/remesh path, not manual mask disposal.
    eye.transform.position = new Vec3(4096, 20, 4096);
    terrain.update(context, context.dt);
    expect(old.weightMap.releasedState).toBe(true);
    expect(old.maps.albedo.releasedState).toBe(false); // shared arrays remain valid for new tiles
  });

  it("rejects invalid GPU layer/map contracts without leaking a newly created mask", async () => {
    const gpu = await device();
    const helper = new LayeredTerrainMaterial({ layers: layers() });
    const material = helper.createTileMaterial(gpu, cell());
    cleanup.push(() => { material.dispose(); helper.dispose(); });
    expect(() => new SplatMaterial({ layers: layers().slice(0, 3), maps: material.maps, weightMap: material.weightMap, size: 128, originX: 0, originZ: 0 })).toThrow(/four/);
    const single = Texture.fromRgba8(gpu, 1, 1, new Uint8Array([255, 255, 255, 255]), { srgb: true });
    cleanup.push(() => single.dispose());
    const bad = new LayeredTerrainMaterial({ layers: layers(), maps: { ...material.maps, albedo: single } });
    const textures = gpu.mock.liveTextures.size;
    expect(() => bad.createTileMaterial(gpu, cell())).toThrow(/four rgba8unorm-srgb/);
    expect(gpu.mock.liveTextures.size).toBe(textures); // the temporary mask was released
    bad.dispose();
    const clone = material.clone({ roughness: 0.7 });
    expect(clone).toBeInstanceOf(SplatMaterial);
    expect(clone.weightMap).toBe(material.weightMap);
    expect(clone.roughness).toBe(0.7);
    expect(() => clone.setTechnique("standard")).toThrow(/terrain technique/);
    clone.dispose();
    expect(material.weightMap.releasedState).toBe(false);
    const factory = new PipelineFactory(gpu);
    cleanup.push(() => factory.invalidate());
    expect(factory.get({ technique: "terrain", colorFormat: "rgba8unorm", depthFormat: "depth24plus", transparent: false, doubleSided: false, instanced: true })).toBeTruthy();
  });
});
