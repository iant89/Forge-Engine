/**
 * @suite resources:phase15
 * @group unit
 * @covers engine/src/gpu/device.ts
 * @covers engine/src/index.ts
 * @covers engine/src/resources/hotReload.ts
 * @covers engine/src/resources/ktx2.ts
 * @covers engine/src/resources/registry.ts
 * @covers engine/src/resources/streaming.ts
 * @covers engine/src/resources/texture.ts
 * @covers engine/src/resources/validation.ts
 * @covers tests/fixtures/2d_etc1s.ktx2
 * @desc Focused regression tests for the Phase 15 asset pipeline completion slices
 */

export const suite = {
  name: "resources:phase15",
  group: "unit",
  covers:   [
    "engine/src/gpu/device.ts",
    "engine/src/index.ts",
    "engine/src/resources/hotReload.ts",
    "engine/src/resources/ktx2.ts",
    "engine/src/resources/registry.ts",
    "engine/src/resources/streaming.ts",
    "engine/src/resources/texture.ts",
    "engine/src/resources/validation.ts",
    "tests/fixtures/2d_etc1s.ktx2"
  ],
  desc: "Focused regression tests for the Phase 15 asset pipeline completion slices",
};
/** Focused regression tests for the Phase 15 asset pipeline completion slices. */

import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { assertContains, assertMatchObject, assertMatches, assertRejects, assertThrows, finish, group, objectContaining, test } from "selrun";
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

group("Phase 15.4 — staged asset hot reload", () => {
  test("commits mesh, texture, and material replacements only after staging; live handles observe the swap", async () => {
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
    await assert.equal((await handle.wait()), oldValue);
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
        assert.equal(previous, oldValue);
        assert.equal(replacement, newValue);
        assert.deepEqual(order, [] as string[]); // old GPU/resource value is still alive during consumer rebinding
        activeBinding = replacement;
        order.push("swap");
      },
    });

    // AssetStreamer does not start work until admitted. The active registry value stays readable.
    await Promise.resolve();
    assert.equal(streamer.queued, 1);
    assert.equal(handle.value, oldValue);
    assert.equal(activeBinding, oldValue);
    assert.equal(registry.bytes, 32);

    streamer.pump();
    await assertMatchObject((await reload), { id, value: newValue, oldBytes: 32, newBytes: 64, oldHash: H1, newHash: H2 });
    assert.equal(handle.value, newValue);
    assert.equal(activeBinding, newValue);
    assert.deepEqual(order, ["swap", "dispose-1"]);
    assert.equal(registry.bytes, 64);
    assert.deepEqual(registry.dependenciesOf(id), ["texture:mesh-new"]);
    assertMatches(reloadEvents, [objectContaining({ id, kind: "mesh", oldHash: H1, newHash: H2 })]);

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
      await assertMatchObject((await nextReload), { id, value: next, newBytes: 16 });
      assert.equal(handle.value, next);
      assert.equal(activeBinding, next);
    }

    handle.release();
    hotReload.dispose();
    streamer.dispose();
    registry.dispose();
  });

  test("rejects invalid staged output and leaves the old resource usable", async () => {
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
    await assertRejects(reload, (error) => error instanceof AssetValidationError);
    assert.equal(rejectedDisposals, 1);
    assert.equal(handle.value, old);
    assert.equal(registry.stateOf("material:stone"), "ready");
    assert.equal(registry.bytes, 48);

    handle.release();
    hotReload.dispose();
    streamer.dispose();
    registry.dispose();
  });

  test("cancels a queued replacement without changing the live entry", async () => {
    const registry = new ResourceRegistry();
    const streamer = new AssetStreamer(registry);
    const hotReload = new AssetHotReloader(registry, streamer);
    const old = { revision: 1 };
    const handle = registry.acquire({ id: "texture:sky", kind: "texture", load: () => old });
    await handle.wait();

    const reload = hotReload.reload({ id: "texture:sky", kind: "texture", contentHash: H2, load: () => ({ revision: 2 }) });
    await Promise.resolve();
    assert.equal(streamer.queued, 1);
    assert.equal(hotReload.cancel("texture:sky"), true);
    await assertRejects(reload, /cancelled/);
    assert.equal(handle.value, old);
    assert.equal(streamer.queued, 0);

    handle.release();
    hotReload.dispose();
    streamer.dispose();
    registry.dispose();
  });
});

group("Phase 15.5 — asset validation", () => {
  test("detects malformed mesh streams and accepts valid triangle data", () => {
    assert.deepEqual(validateMeshData({
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      normals: new Float32Array(9),
      uvs: new Float32Array(6),
      indices: new Uint16Array([0, 1, 2]),
    }), []);

    const diagnostics = validateMeshData({
      positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
      normals: [0, 1],
      indices: [0, 1, 3],
    }, "mesh:broken");
    assert.deepEqual(diagnostics.map((issue) => issue.code), ["asset.mesh.attribute-length", "asset.mesh.index-range"]);
    assertContains(validateMeshData({ positions: [] }).map((issue) => issue.code), "asset.mesh.empty");
  });

  test("reports missing textures, unsupported material techniques, and bad texture memory/limits", () => {
    const registry = new ResourceRegistry();
    const materialIssues = validateMaterialData({ technique: "legacy-unlit", metallic: 2 }, {
      registry,
      requiredTextures: [{ slot: "albedoMap", id: "texture:missing" }],
    }, "material:broken");
    assert.deepEqual(materialIssues.map((issue) => issue.code), [
      "asset.material.unsupported",
      "asset.material.invalid-pbr",
      "asset.texture.missing",
    ]);
    assert.deepEqual(validateAssetDependencies("material:broken", ["texture:missing"], registry).map((issue) => issue.code), ["asset.texture.missing"]);

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
    assert.deepEqual(textureIssues.map((issue) => issue.code), [
      "asset.texture.dimension-limit",
      "asset.texture.layer-limit",
      "asset.texture.unsupported-format",
      "asset.texture.too-many-mips",
      "asset.memory.exceeded",
    ]);
    assert.deepEqual(validateTextureData({ width: 10, height: 8, format: "bc7-rgba-unorm" }, { textureCompressionBc: true }).map((issue) => issue.code), ["asset.texture.block-alignment"]);
    assert.deepEqual(validateMemoryBudget(-1, 128).map((issue) => issue.code), ["asset.memory.invalid"]);
    registry.dispose();
  });

  test("enforces load-time descriptor validation and can report registry budget overruns", async () => {
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
    await assertRejects(bad.wait(), (error) => error instanceof AssetValidationError);
    assert.equal(disposed, true);
    bad.release();

    const held = registry.acquire({ id: "buffer:large", kind: "buffer", load: () => new Uint8Array(32), bytes: (value) => value.byteLength });
    await held.wait();
    assertMatchObject(validateRegistryMemory(registry), {
      valid: false,
      diagnostics: [objectContaining({ code: "asset.memory.exceeded" })],
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

group("Phase 15.6 — KTX2/Basis transcoding", () => {
  test("selects the best supported LDR target and falls back through ASTC, ETC2, and RGBA8", async () => {
    const device = await GraphicsDevice.create({ forceMock: true });
    const caps = device.caps;
    const old = { bc: caps.textureCompressionBc, astc: caps.textureCompressionAstc, etc2: caps.textureCompressionEtc2 };
    assertMatchObject(chooseKtx2Target(device, true, false), { family: "bc7", gpuFormat: "bc7-rgba-unorm-srgb", compressed: true });
    caps.textureCompressionBc = false;
    assert.equal(chooseKtx2Target(device, false, false).family, "astc");
    caps.textureCompressionAstc = false;
    assert.equal(chooseKtx2Target(device, false, false).family, "etc2");
    caps.textureCompressionEtc2 = false;
    assertMatchObject(chooseKtx2Target(device, false, false), { family: "rgba8", gpuFormat: "rgba8unorm", compressed: false });
    caps.textureCompressionBc = old.bc;
    caps.textureCompressionAstc = old.astc;
    caps.textureCompressionEtc2 = old.etc2;
    assertMatchObject(chooseKtx2Target(device, false, true), { family: "bc7", gpuFormat: "bc6h-rgb-ufloat", hdr: true });
    await device.dispose();
  });

  test("rejects directly-created compressed textures with block-unaligned base dimensions", async () => {
    const device = await GraphicsDevice.create({ forceMock: true });
    assertThrows(() => Texture.create(device, { width: 10, height: 8, format: "bc7-rgba-unorm" }), /requires base dimensions aligned to 4x4 blocks/);
    assert.deepEqual(device.mock.errors, []);
    await device.dispose();
  });

  test("detects sRGB from the DFD and uploads every compressed mip through the mock GPU", async () => {
    const device = await GraphicsDevice.create({ forceMock: true });
    const bytes = makeKtx2WithDfd(2);
    assert.equal(detectKtx2Srgb(bytes), true);
    assert.equal(detectKtx2Srgb(makeKtx2WithDfd(1)), false);

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
    assert.equal(texture.format, "bc7-rgba-unorm-srgb");
    assert.equal(texture.width, 4);
    assert.equal(texture.height, 4);
    assert.equal(texture.mipLevels, 2);
    assert.equal(texture.gpuBytes, 32);
    assert.deepEqual(calls.map((call) => call.level), [0, 1]);
    assert.equal(device.mock.queue.writeTextureCalls, 2);
    assert.deepEqual(device.mock.errors, []);
    assert.equal(disposed, true);

    texture.release();
    await device.dispose();
  });

  test("uses RGBA8 for unaligned base dimensions instead of creating an invalid compressed texture", async () => {
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

    assert.equal(texture.format, "rgba8unorm-srgb");
    assert.equal(selectedFormat, TranscoderTextureFormat.cTFRGBA32);
    assert.equal(texture.gpuBytes, 36);
    assert.deepEqual(device.mock.errors, []);
    texture.release();
    await device.dispose();
  });

  test("transcodes a real ETC1S KTX2 fixture through the bundled Basis WASM", async () => {
    const device = await GraphicsDevice.create({ forceMock: true });
    const ktx2 = readFileSync(new URL("../fixtures/2d_etc1s.ktx2", import.meta.url));
    const wasmFile = readFileSync(new URL("../../node_modules/@h00w/basis-universal-transcoder/dist/basis_capi_transcoder.wasm", import.meta.url));
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

    assert.equal(texture.width, 40);
    assert.equal(texture.height, 40);
    assert.equal(texture.mipLevels, 6);
    assert.equal(texture.format, "bc7-rgba-unorm-srgb");
    assert.equal(texture.gpuBytes, 2240);
    assert.equal(device.mock.queue.writeTextureCalls, 6);
    assert.deepEqual(device.mock.errors, []);

    texture.release();
    await device.dispose();
  });
});

await finish();
