/** Focused regression tests for the Phase 15 asset pipeline completion slices. */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BasisUniversal, TranscoderTextureFormat } from "@h00w/basis-universal-transcoder";
import {
  AssetHotReloader,
  AssetStreamer,
  AssetValidationError,
  GraphicsDevice,
  ResourceRegistry,
  Texture,
  chooseKtx2Target,
  detectKtx2Srgb,
  loadKtx2Texture,
  validateAssetDependencies,
  validateMaterialData,
  validateMemoryBudget,
  validateMeshData,
  validateRegistryMemory,
  validateTextureData,
  type Ktx2TextureOptions,
  type ResourceDescriptor,
} from "@forge/engine";

const H1 = "1".repeat(64);
const H2 = "2".repeat(64);

describe("Phase 15.4 — staged asset hot reload", () => {
  it("commits mesh, texture, and material replacements only after staging; live handles observe the swap", async () => {
    const registry = new ResourceRegistry();
    const streamer = new AssetStreamer(registry, { maxConcurrent: 1 });
    const hotReload = new AssetHotReloader(registry, streamer);
    const id = "mesh:hero";
    const oldValue = { revision: 1 };
    const newValue = { revision: 2 };
    const order: string[] = [];
    let activeBinding = oldValue;
    const oldDescriptor: ResourceDescriptor<typeof oldValue> = {
      id,
      kind: "mesh",
      contentHash: H1,
      load: () => oldValue,
      bytes: () => 32,
      dispose: (value) => { order.push(`dispose-${value.revision}`); },
      dependencies: () => ["texture:hero-old"],
    };
    const handle = registry.acquire(oldDescriptor);
    await expect(handle.wait()).resolves.toBe(oldValue);
    const reloadEvents: unknown[] = [];
    registry.events.reloaded.on((event) => reloadEvents.push(event));

    const descriptorFor = (kind: "mesh" | "texture" | "material"): ResourceDescriptor<typeof newValue> => ({
      id,
      kind,
      contentHash: H2,
      load: () => newValue,
      bytes: () => 64,
      dispose: (value) => { order.push(`dispose-${value.revision}`); },
      dependencies: () => [`texture:${kind}-new`],
    });
    const reload = hotReload.reload(descriptorFor("mesh"), {
      swap: (previous, replacement) => {
        expect(previous).toBe(oldValue);
        expect(replacement).toBe(newValue);
        expect(order).toEqual([]); // old GPU/resource value is still alive during consumer rebinding
        activeBinding = replacement;
        order.push("swap");
      },
    });

    // AssetStreamer does not start work until admitted. The active registry value stays readable.
    await Promise.resolve();
    expect(streamer.queued).toBe(1);
    expect(handle.value).toBe(oldValue);
    expect(activeBinding).toBe(oldValue);
    expect(registry.bytes).toBe(32);

    streamer.pump();
    await expect(reload).resolves.toMatchObject({ id, value: newValue, oldBytes: 32, newBytes: 64, oldHash: H1, newHash: H2 });
    expect(handle.value).toBe(newValue);
    expect(activeBinding).toBe(newValue);
    expect(order).toEqual(["swap", "dispose-1"]);
    expect(registry.bytes).toBe(64);
    expect(registry.dependenciesOf(id)).toEqual(["texture:mesh-new"]);
    expect(reloadEvents).toEqual([expect.objectContaining({ id, kind: "mesh", oldHash: H1, newHash: H2 })]);

    // The coordinator is asset-kind agnostic: other resource classes use the same atomic commit.
    for (const kind of ["texture", "material"] as const) {
      const next = { revision: kind === "texture" ? 3 : 4 };
      const nextDescriptor: ResourceDescriptor<typeof next> = {
        id,
        kind,
        contentHash: H2,
        load: () => next,
        bytes: () => 16,
        dispose: () => undefined,
      };
      const nextReload = hotReload.reload(nextDescriptor, { swap: (_previous, replacement) => { activeBinding = replacement; } });
      await Promise.resolve();
      streamer.pump();
      await expect(nextReload).resolves.toMatchObject({ id, value: next, newBytes: 16 });
      expect(handle.value).toBe(next);
      expect(activeBinding).toBe(next);
    }

    handle.release();
    hotReload.dispose();
    streamer.dispose();
    registry.dispose();
  });

  it("rejects invalid staged output and leaves the old resource usable", async () => {
    const registry = new ResourceRegistry();
    const streamer = new AssetStreamer(registry);
    const hotReload = new AssetHotReloader(registry, streamer);
    const old = { revision: 1 };
    const rejected = { revision: 2 };
    let rejectedDisposals = 0;
    const handle = registry.acquire({ id: "material:stone", kind: "material", load: () => old, bytes: () => 48 });
    await handle.wait();

    const reload = hotReload.reload({
      id: "material:stone",
      kind: "material",
      contentHash: H2,
      load: () => rejected,
      bytes: () => 96,
      dispose: () => { rejectedDisposals++; },
      validate: () => [{ code: "material.invalid", severity: "error", message: "unsupported material" }],
    });
    await Promise.resolve();
    streamer.pump();
    await expect(reload).rejects.toBeInstanceOf(AssetValidationError);
    expect(rejectedDisposals).toBe(1);
    expect(handle.value).toBe(old);
    expect(registry.stateOf("material:stone")).toBe("ready");
    expect(registry.bytes).toBe(48);

    handle.release();
    hotReload.dispose();
    streamer.dispose();
    registry.dispose();
  });

  it("cancels a queued replacement without changing the live entry", async () => {
    const registry = new ResourceRegistry();
    const streamer = new AssetStreamer(registry);
    const hotReload = new AssetHotReloader(registry, streamer);
    const old = { revision: 1 };
    const handle = registry.acquire({ id: "texture:sky", kind: "texture", load: () => old });
    await handle.wait();

    const reload = hotReload.reload({ id: "texture:sky", kind: "texture", contentHash: H2, load: () => ({ revision: 2 }) });
    await Promise.resolve();
    expect(streamer.queued).toBe(1);
    expect(hotReload.cancel("texture:sky")).toBe(true);
    await expect(reload).rejects.toThrow(/cancelled/);
    expect(handle.value).toBe(old);
    expect(streamer.queued).toBe(0);

    handle.release();
    hotReload.dispose();
    streamer.dispose();
    registry.dispose();
  });
});

describe("Phase 15.5 — asset validation", () => {
  it("detects malformed mesh streams and accepts valid triangle data", () => {
    expect(validateMeshData({
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      normals: new Float32Array(9),
      uvs: new Float32Array(6),
      indices: new Uint16Array([0, 1, 2]),
    })).toEqual([]);

    const diagnostics = validateMeshData({
      positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
      normals: [0, 1],
      indices: [0, 1, 3],
    }, "mesh:broken");
    expect(diagnostics.map((issue) => issue.code)).toEqual(["asset.mesh.attribute-length", "asset.mesh.index-range"]);
    expect(validateMeshData({ positions: [] }).map((issue) => issue.code)).toContain("asset.mesh.empty");
  });

  it("reports missing textures, unsupported material techniques, and bad texture memory/limits", () => {
    const registry = new ResourceRegistry();
    const materialIssues = validateMaterialData({ technique: "legacy-unlit", metallic: 2 }, {
      registry,
      requiredTextures: [{ slot: "albedoMap", id: "texture:missing" }],
    }, "material:broken");
    expect(materialIssues.map((issue) => issue.code)).toEqual([
      "asset.material.unsupported",
      "asset.material.invalid-pbr",
      "asset.texture.missing",
    ]);
    expect(validateAssetDependencies("material:broken", ["texture:missing"], registry).map((issue) => issue.code)).toEqual(["asset.texture.missing"]);

    const textureIssues = validateTextureData({
      width: 1024,
      height: 1024,
      depthOrArrayLayers: 16,
      mipLevelCount: 12,
      format: "bc7-rgba-unorm",
      gpuBytes: 4096,
    }, {
      maxTextureDimension2D: 512,
      maxArrayLayers: 8,
      maxBytes: 1024,
      textureCompressionBc: false,
    }, "texture:oversized");
    expect(textureIssues.map((issue) => issue.code)).toEqual([
      "asset.texture.dimension-limit",
      "asset.texture.layer-limit",
      "asset.texture.unsupported-format",
      "asset.texture.too-many-mips",
      "asset.memory.exceeded",
    ]);
    expect(validateTextureData({ width: 10, height: 8, format: "bc7-rgba-unorm" }, { textureCompressionBc: true }).map((issue) => issue.code))
      .toEqual(["asset.texture.block-alignment"]);
    expect(validateMemoryBudget(-1, 128).map((issue) => issue.code)).toEqual(["asset.memory.invalid"]);
    registry.dispose();
  });

  it("enforces load-time descriptor validation and can report registry budget overruns", async () => {
    const registry = new ResourceRegistry({ maxBytes: 16 });
    let disposed = false;
    const bad = registry.acquire({
      id: "mesh:bad",
      kind: "mesh",
      load: () => ({ positions: [], indices: [] }),
      bytes: () => 32,
      dispose: () => { disposed = true; },
      validate: (mesh) => validateMeshData(mesh),
    });
    await expect(bad.wait()).rejects.toBeInstanceOf(AssetValidationError);
    expect(disposed).toBe(true);
    bad.release();

    const held = registry.acquire({ id: "buffer:large", kind: "buffer", load: () => new Uint8Array(32), bytes: (value) => value.byteLength });
    await held.wait();
    expect(validateRegistryMemory(registry)).toMatchObject({
      valid: false,
      diagnostics: [expect.objectContaining({ code: "asset.memory.exceeded" })],
    });
    held.release();
    registry.dispose();
  });
});

const KTX2_IDENTIFIER = [0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a];
function makeKtx2WithDfd(transferFunction = 2): Uint8Array {
  const bytes = new Uint8Array(100);
  bytes.set(KTX2_IDENTIFIER, 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(48, 80, true); // DFD byte offset
  view.setUint32(52, 20, true); // DFD byte length
  view.setUint32(80, 20, true); // DFD total size
  view.setUint16(90, 16, true); // descriptor block size
  view.setUint8(94, transferFunction);
  return bytes;
}

describe("Phase 15.6 — KTX2/Basis transcoding", () => {
  it("selects the best supported LDR target and falls back through ASTC, ETC2, and RGBA8", async () => {
    const device = await GraphicsDevice.create({ forceMock: true });
    const caps = device.caps;
    const old = { bc: caps.textureCompressionBc, astc: caps.textureCompressionAstc, etc2: caps.textureCompressionEtc2 };
    expect(chooseKtx2Target(device, true, false)).toMatchObject({ family: "bc7", gpuFormat: "bc7-rgba-unorm-srgb", compressed: true });
    caps.textureCompressionBc = false;
    expect(chooseKtx2Target(device, false, false).family).toBe("astc");
    caps.textureCompressionAstc = false;
    expect(chooseKtx2Target(device, false, false).family).toBe("etc2");
    caps.textureCompressionEtc2 = false;
    expect(chooseKtx2Target(device, false, false)).toMatchObject({ family: "rgba8", gpuFormat: "rgba8unorm", compressed: false });
    caps.textureCompressionBc = old.bc;
    caps.textureCompressionAstc = old.astc;
    caps.textureCompressionEtc2 = old.etc2;
    expect(chooseKtx2Target(device, false, true)).toMatchObject({ family: "bc7", gpuFormat: "bc6h-rgb-ufloat", hdr: true });
    await device.dispose();
  });

  it("rejects directly-created compressed textures with block-unaligned base dimensions", async () => {
    const device = await GraphicsDevice.create({ forceMock: true });
    expect(() => Texture.create(device, { width: 10, height: 8, format: "bc7-rgba-unorm" }))
      .toThrow(/requires base dimensions aligned to 4x4 blocks/);
    expect(device.mock.errors).toEqual([]);
    await device.dispose();
  });

  it("detects sRGB from the DFD and uploads every compressed mip through the mock GPU", async () => {
    const device = await GraphicsDevice.create({ forceMock: true });
    const bytes = makeKtx2WithDfd(2);
    expect(detectKtx2Srgb(bytes)).toBe(true);
    expect(detectKtx2Srgb(makeKtx2WithDfd(1))).toBe(false);

    const calls: { format: number; level: number; layer: number; face: number }[] = [];
    let disposed = false;
    const fakeTranscoder = {
      init: (_input: Uint8Array) => true,
      getHeader: () => ({ width: 4, height: 4, depth: 0, layers: 0, faces: 1, levels: 2 }),
      getBasisTextureFormat: () => 0, // BasisTextureFormat.cETC1S
      startTranscoding: () => true,
      transcodeImageLevel: (options: { format: number; level: number; layer: number; face: number }) => {
        calls.push(options);
        const width = Math.max(1, 4 >> options.level);
        const height = Math.max(1, 4 >> options.level);
        // BC7 stores one 16-byte block for both 4x4 and smaller mip extents.
        return { width, height, data: new Uint8Array(16).fill(options.level + 1) };
      },
      dispose: () => { disposed = true; },
    };
    const transcoderFactory: NonNullable<Ktx2TextureOptions["transcoderFactory"]> = () => fakeTranscoder as unknown as Awaited<ReturnType<NonNullable<Ktx2TextureOptions["transcoderFactory"]>>>;

    const texture = await loadKtx2Texture(device, bytes, { label: "fixture.ktx2", transcoderFactory });
    expect(texture.format).toBe("bc7-rgba-unorm-srgb");
    expect(texture.width).toBe(4);
    expect(texture.height).toBe(4);
    expect(texture.mipLevels).toBe(2);
    expect(texture.gpuBytes).toBe(32);
    expect(calls.map((call) => call.level)).toEqual([0, 1]);
    expect(device.mock.queue.writeTextureCalls).toBe(2);
    expect(device.mock.errors).toEqual([]);
    expect(disposed).toBe(true);

    texture.release();
    await device.dispose();
  });

  it("uses RGBA8 for unaligned base dimensions instead of creating an invalid compressed texture", async () => {
    const device = await GraphicsDevice.create({ forceMock: true });
    let selectedFormat = -1;
    const fakeTranscoder = {
      init: (_input: Uint8Array) => true,
      getHeader: () => ({ width: 3, height: 3, depth: 0, layers: 0, faces: 1, levels: 1 }),
      getBasisTextureFormat: () => 0,
      startTranscoding: () => true,
      transcodeImageLevel: (options: { format: number }) => {
        selectedFormat = options.format;
        return { width: 3, height: 3, data: new Uint8Array(3 * 3 * 4) };
      },
      dispose: () => undefined,
    };
    const transcoderFactory: NonNullable<Ktx2TextureOptions["transcoderFactory"]> = () => fakeTranscoder as unknown as Awaited<ReturnType<NonNullable<Ktx2TextureOptions["transcoderFactory"]>>>;
    const texture = await loadKtx2Texture(device, makeKtx2WithDfd(2), { transcoderFactory });

    expect(texture.format).toBe("rgba8unorm-srgb");
    expect(selectedFormat).toBe(TranscoderTextureFormat.cTFRGBA32);
    expect(texture.gpuBytes).toBe(36);
    expect(device.mock.errors).toEqual([]);
    texture.release();
    await device.dispose();
  });

  it("transcodes a real ETC1S KTX2 fixture through the bundled Basis WASM", async () => {
    const device = await GraphicsDevice.create({ forceMock: true });
    const ktx2 = readFileSync(new URL("./fixtures/2d_etc1s.ktx2", import.meta.url));
    const wasmFile = readFileSync(new URL("../node_modules/@h00w/basis-universal-transcoder/dist/basis_capi_transcoder.wasm", import.meta.url));
    const wasmBytes = wasmFile.buffer.slice(wasmFile.byteOffset, wasmFile.byteOffset + wasmFile.byteLength) as ArrayBuffer;

    // The upstream package's ESM build probes global process and calls require("fs") in Node.
    // Hide that probe only while its Module factory is constructed; our explicit loader supplies
    // the WASM bytes, as the browser's bundled ?url loader does in production.
    const globalWithProcess = globalThis as unknown as { process?: unknown };
    const nodeProcess = globalWithProcess.process;
    let basisPromise: ReturnType<typeof BasisUniversal.getInstance>;
    try {
      globalWithProcess.process = undefined;
      basisPromise = BasisUniversal.getInstance(async (imports) => WebAssembly.instantiate(wasmBytes, imports));
    } finally {
      globalWithProcess.process = nodeProcess;
    }
    const basis = await basisPromise;
    const texture = await loadKtx2Texture(device, ktx2, {
      label: "real-etc1s-fixture.ktx2",
      transcoderFactory: () => basis.createKTX2Transcoder(),
    });

    expect(texture.width).toBe(40);
    expect(texture.height).toBe(40);
    expect(texture.mipLevels).toBe(6);
    expect(texture.format).toBe("bc7-rgba-unorm-srgb");
    expect(texture.gpuBytes).toBe(2240);
    expect(device.mock.queue.writeTextureCalls).toBe(6);
    expect(device.mock.errors).toEqual([]);

    texture.release();
    await device.dispose();
  });
});
