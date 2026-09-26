/**
 * Real-renderer splat pixel oracle. A tiny offscreen canvas isolates surface sampling from the
 * showcase's atmosphere/motion: four one-hot masks, a bilinear mixture, ordinary-material parity,
 * prepass parity, and isolated normal/roughness/metallic changes. All draws use Renderer/RenderGraph.
 */
import {
  BufferUsage, Camera, Color, GraphicsDevice, LayeredTerrainMaterial, Light, Material, Renderable,
  Renderer, Scene, SplatMaterial, TerrainTile, Texture, Vec3, createWorldCell, linearToSrgb, srgbToLinear,
  type SplatTextureSet, type TerrainSurfaceLayer,
} from "@forge/engine";

type RGB = [number, number, number];
export async function runTerrainLayerCheck() {
  const extent = 129; // centre pixel exactly on the optical axis (no half-pixel weighting ambiguity)
  const canvas = new OffscreenCanvas(extent, extent);
  const gpu = await GraphicsDevice.create({ canvas });
  if (gpu.isMock) throw new Error("terrain layer pixel check requires real WebGPU");
  const renderer = new Renderer(gpu, { shadows: false, bloom: false, ssao: false, objectCulling: "cpu", occlusionCulling: false });
  const scene = new Scene({ name: "terrain-layer-pixel-oracle" });
  scene.settings.skyEnabled = false;
  scene.settings.hdr = false;
  scene.settings.postProcessing = false;
  scene.settings.depthPrepass = false;
  scene.settings.toneMapping = "none";
  scene.settings.exposure = 1;
  scene.settings.ambientColor.set(1, 1, 1, 1);
  scene.settings.ambientIntensity = 1;
  const camera = scene.createTransformedEntity("camera", new Vec3(4, 10, 3.99));
  camera.add(new Camera()); camera.transform.lookAt(new Vec3(4, 0, 4));
  const cell = createWorldCell(0, 0, 8, 2, 1337);
  const tile = TerrainTile.fromCell({ cx: 0, cz: 0, size: 8, skirtDepth: 0, cell });
  const draw = scene.createTransformedEntity("terrain", new Vec3()).add(new Renderable());
  draw.geometry = tile.uploadGpu(gpu);
  const colors: RGB[] = [[255, 0, 0], [0, 255, 0], [0, 0, 255], [188, 128, 64]];
  const surfaces: TerrainSurfaceLayer[] = colors.map((_, i) => ({ name: `oracle-${i}`, color: new Color(1, 1, 1), roughness: 0.9, metallic: 0, biomeChannel: i }));
  const maps: SplatTextureSet = {
    albedo: Texture.fromRgba8Array(gpu, 1, 1, colors.map((c) => new Uint8Array([...c, 255])), { srgb: true }),
    normal: Texture.fromRgba8Array(gpu, 1, 1, colors.map(() => new Uint8Array([128, 128, 255, 255])), { normal: true }),
    metallicRoughness: Texture.fromRgba8Array(gpu, 1, 1, colors.map(() => new Uint8Array([255, 255, 255, 255]))),
  };
  const helper = new LayeredTerrainMaterial({ layers: surfaces, maps });
  const materials: Material[] = [];
  const extraTextures: Texture[] = [];
  const rowBytes = Math.ceil(extent * 4 / 256) * 256;
  const readback = gpu.createBuffer({ size: rowBytes * extent, usage: BufferUsage.MAP_READ | BufferUsage.COPY_DST });
  const delta = (a: RGB, b: RGB): number => Math.max(...a.map((value, i) => Math.abs(value - b[i]!)));
  const expected = (weights: number[]): RGB => [0, 1, 2].map((c) => Math.round(linearToSrgb(
    // No lights: the standard shader's dielectric ambient term is albedo * (1 - F0).
    colors.reduce((sum, rgb, i) => sum + srgbToLinear(rgb[c]! / 255) * weights[i]!, 0) * 0.96,
  ) * 255)) as RGB;
  async function pixel(material: Material): Promise<RGB> {
    draw.material = material;
    for (let attempt = 0; attempt < 5; attempt++) {
      renderer.renderScene(scene);
      if (renderer.stats.pipelineFailures) throw new Error(`splat pipeline compilation failed: ${gpu.lastError}`);
      if (renderer.stats.pipelinesPending === 0) break;
      await renderer.pipelines.settle();
    }
    if (renderer.stats.drawCalls < 1) throw new Error("pixel oracle drew no terrain");
    // No await between render and copy: the canvas texture must be copied before presentation.
    const encoder = gpu.device.createCommandEncoder();
    encoder.copyTextureToBuffer({ texture: gpu.currentTexture! }, { buffer: readback, bytesPerRow: rowBytes, rowsPerImage: extent }, [extent, extent, 1]);
    gpu.device.queue.submit([encoder.finish()]);
    await readback.mapAsync(GPUMapMode.READ);
    const offset = 64 * rowBytes + 64 * 4;
    const data = new Uint8Array(readback.getMappedRange());
    const rgb: RGB = gpu.format.startsWith("bgra") ? [data[offset + 2]!, data[offset + 1]!, data[offset]!] : [data[offset]!, data[offset + 1]!, data[offset + 2]!];
    readback.unmap();
    if (gpu.totalErrorCount) throw new Error(`splat pixel GPU error: ${gpu.lastError}`);
    return rgb;
  }
  function splat(weights: number[] | "corners"): SplatMaterial {
    for (let i = 0; i < 4; i++) {
      cell.biomes.set(weights === "corners" ? [0, 1, 2, 3].map((c) => +(c === i)) : weights, i * 4);
    }
    const material = helper.createTileMaterial(gpu, cell);
    materials.push(material);
    return material;
  }
  try {
    const oneHot: RGB[] = [];
    for (let i = 0; i < 4; i++) {
      const weights = [0, 1, 2, 3].map((c) => +(c === i));
      const actual = await pixel(splat(weights));
      if (delta(actual, expected(weights)) > 2) throw new Error(`layer ${i}: got ${actual}, expected ${expected(weights)}`);
      oneHot.push(actual);
    }
    const mixedMaterial = splat("corners");
    const mixed = await pixel(mixedMaterial);
    if (delta(mixed, expected([0.25, 0.25, 0.25, 0.25])) > 2) throw new Error(`bilinear linear-light mixture: got ${mixed}`);
    scene.settings.depthPrepass = true;
    const prepassed = await pixel(mixedMaterial);
    if (delta(mixed, prepassed) > 1) throw new Error(`terrain prepass changed pixels: ${mixed} / ${prepassed}`);
    scene.settings.depthPrepass = false;
    const ordinary = new Material({ color: 0xffffff, metallic: 0, roughness: 0.9 });
    materials.push(ordinary);
    ordinary.baseColor.set(...colors.reduce((sum, rgb) => sum.map((n, c) => n + srgbToLinear(rgb[c]! / 255) / 4) as RGB, [0, 0, 0] as RGB), 1);
    ordinary.markChanged();
    const ordinaryPixel = await pixel(ordinary);
    if (delta(mixed, ordinaryPixel) > 2) throw new Error(`ordinary/splat PBR parity: ${mixed} / ${ordinaryPixel}`);

    scene.settings.ambientIntensity = 0;
    const sunEntity = scene.createTransformedEntity("sun", new Vec3(4, 10, 0));
    const light = sunEntity.add(new Light()); light.kind = "directional"; light.intensity = 2; light.color.set(1, 1, 1); light.castShadow = false;
    sunEntity.transform.lookAt(new Vec3(4, 0, 4));
    const baseline = splat([1, 0, 0, 0]);
    const lit = await pixel(baseline);
    const variant = async (roughness: number, metallic: number, normal = maps.normal, mr = maps.metallicRoughness): Promise<RGB> => {
      const material = new SplatMaterial({ layers: surfaces.map((l) => ({ ...l, roughness, metallic })), maps: { ...maps, normal, metallicRoughness: mr },
        weightMap: baseline.weightMap, originX: 0, originZ: 0, size: 8 });
      materials.push(material);
      return pixel(material);
    };
    const roughness = await variant(0.15, 0);
    const metallic = await variant(0.9, 0.8);
    const tilted = Texture.fromRgba8Array(gpu, 1, 1, colors.map(() => new Uint8Array([204, 128, 230, 255])), { normal: true });
    extraTextures.push(tilted);
    const normal = await variant(0.9, 0, tilted);
    for (const [name, rgb] of [["roughness", roughness], ["metallic", metallic], ["normal", normal]] as const) {
      if (delta(lit, rgb) < 2) throw new Error(`${name} map/factor had no visible effect: ${lit} / ${rgb}`);
    }
    // Map channels must multiply the matching scalar factors (G = roughness, B = metallic).
    const variedMr = Texture.fromRgba8Array(gpu, 1, 1, colors.map(() => new Uint8Array([255, 64, 128, 255])));
    extraTextures.push(variedMr);
    const mrMapped = await variant(0.9, 0.8, maps.normal, variedMr);
    const mrFactors = await variant(0.9 * 64 / 255, 0.8 * 128 / 255);
    if (delta(mrMapped, mrFactors) > 1 || delta(mrMapped, metallic) < 2) throw new Error(`MR texture channels disagree: ${mrMapped} / ${mrFactors}`);
    return { gpuExecuted: true, oneHot, mixed, expectedMixed: expected([0.25, 0.25, 0.25, 0.25]), prepassed, ordinary: ordinaryPixel,
      lit, roughness, metallic, normal, mrMapped, mrFactors, gpuErrors: gpu.totalErrorCount };
  } finally {
    readback.destroy(); scene.dispose(); renderer.dispose(); tile.dispose();
    for (const material of materials.reverse()) material.dispose();
    helper.dispose();
    for (const texture of [...Object.values(maps), ...extraTextures]) texture.dispose();
    await gpu.dispose();
  }
}
