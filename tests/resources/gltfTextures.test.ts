/**
 * @suite resources:gltfTextures
 * @group integration
 * @covers engine/src/resources/gltfTextures.ts
 * @covers engine/src/resources/gltfScene.ts
 * @covers engine/src/core/tasks/gltfMesh.ts
 * @covers engine/src/rendering/geometry.ts
 * @covers examples/assets/CesiumMan.glb
 * @covers examples/assets/Perseverance.glb
 * @desc Phase 16.1c: glTF images/samplers/textures decode and assemble into engine materials
 */

export const suite = {
  name: "resources:gltfTextures",
  group: "integration",
  covers: [
    "engine/src/resources/gltfTextures.ts",
    "engine/src/resources/gltfScene.ts",
    "engine/src/core/tasks/gltfMesh.ts",
    "engine/src/rendering/geometry.ts",
    "examples/assets/CesiumMan.glb",
    "examples/assets/Perseverance.glb",
  ],
  desc: "Phase 16.1c: glTF images/samplers/textures decode and assemble into engine materials",
};

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { afterEach, finish, group, test } from "selrun";
import {
  Geometry,
  GraphicsDevice,
  Renderable,
  Scene,
  decodeGltfMesh,
  instantiateGltfScene,
  loadGltfTextures,
  type DecodedGltfAsset,
  type GltfImageDecoder,
} from "@forge/engine";

const asset = (name: string) => readFileSync(fileURLToPath(new URL(`../../examples/assets/${name}`, import.meta.url)));
const cesium = asset("CesiumMan.glb");
const perseverance = asset("Perseverance.glb");

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function device(): Promise<GraphicsDevice> {
  const d = await GraphicsDevice.create({ forceMock: true });
  cleanups.push(() => d.dispose());
  return d;
}

/** Fake decoder: a 2×2 image whose red channel encodes the byte length, so tests can tell images apart. */
function fakeDecoder(calls: { mimeType: string; bytes: Uint8Array }[] = []): GltfImageDecoder {
  return async (bytes, mimeType) => {
    calls.push({ mimeType, bytes });
    return { width: 2, height: 2, pixels: new Uint8Array(16).fill(bytes.byteLength & 255) };
  };
}

const PNG_1X1 = "data:image/png;base64,iVBORw0KGgo=";

function textureDoc(extra: Record<string, unknown> = {}): string {
  // One triangle with TEXCOORD_0; positions + uvs in a base64 buffer.
  const f = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 1]);
  const b64 = Buffer.from(f.buffer).toString("base64");
  return JSON.stringify({
    asset: { version: "2.0" },
    buffers: [{ byteLength: 60, uri: `data:application/octet-stream;base64,${b64}` }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36 }, { buffer: 0, byteOffset: 36, byteLength: 24 }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: "VEC3", min: [0, 0, 0], max: [1, 1, 0] },
      { bufferView: 1, componentType: 5126, count: 3, type: "VEC2" },
    ],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, TEXCOORD_0: 1 }, material: 0 }] }],
    nodes: [{ mesh: 0 }],
    scenes: [{ nodes: [0] }],
    images: [{ uri: PNG_1X1 }],
    textures: [{ source: 0 }],
    materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }],
    ...extra,
  });
}

group("decode", () => {
  test("CesiumMan: embedded JPEG image, sampler and texture survive decode", async () => {
    const a = await decodeGltfMesh(cesium, { source: "CesiumMan.glb" });
    assert.equal(a.images.length, 1);
    assert.equal(a.images[0]!.mimeType, "image/jpeg");
    assert.ok(a.images[0]!.bytes);
    assert.equal(a.images[0]!.bytes![0], 0xff);
    assert.equal(a.images[0]!.bytes![1], 0xd8);
    assert.deepEqual(a.textures, [{ source: 0, sampler: 0 }]);
    assert.deepEqual(a.samplers[0], { magFilter: 9729, minFilter: 9986, wrapS: 10497, wrapT: 10497 });
    assert.equal(a.materials[0]!.baseColorTexture, 0);
  });

  test("Perseverance: 38 WebP images, normal maps and a metallic-roughness map", async () => {
    const a = await decodeGltfMesh(perseverance, { source: "Perseverance.glb" });
    assert.equal(a.images.length, 38);
    for (const image of a.images) {
      assert.equal(image.mimeType, "image/webp");
      assert.equal(new TextDecoder().decode(image.bytes!.subarray(0, 4)), "RIFF");
    }
    assert.equal(a.textures.length, 38);
    const brass = a.materials.find((m) => m.name === "mars_2020_06_brass")!;
    assert.equal(brass.baseColorTexture, 3);
    assert.equal(brass.normalTexture, 4);
    assert.ok(a.materials.some((m) => m.metallicRoughnessTexture === 25));
  });

  test("data URI images decode; external URIs are kept for the texture loader", async () => {
    const a = await decodeGltfMesh(textureDoc({ images: [{ uri: PNG_1X1 }, { uri: "tex/a.png" }], textures: [{ source: 0 }, { source: 1 }] }));
    assert.equal(a.images[0]!.mimeType, "image/png");
    assert.equal(a.images[0]!.bytes![1], 0x50); // 'P'
    assert.equal(a.images[1]!.bytes, null);
    assert.equal(a.images[1]!.uri, "tex/a.png");
    assert.equal(a.images[1]!.mimeType, "image/png");
  });

  test("bad image/texture/sampler references fail the load", async () => {
    await assert.rejects(decodeGltfMesh(textureDoc({ textures: [{ source: 4 }] })), /texture 0 source/);
    await assert.rejects(decodeGltfMesh(textureDoc({ textures: [{ source: 0, sampler: 1 }] })), /texture 0 sampler/);
    await assert.rejects(decodeGltfMesh(textureDoc({ images: [{ bufferView: 0 }] })), /image 0 .*mimeType/);
    await assert.rejects(decodeGltfMesh(textureDoc({ images: [{}] })), /image 0/);
  });

  test("normalTexture.scale is decoded; a non-zero texCoord drops that map with a warning", async () => {
    const warn = console.warn;
    const warnings: string[] = [];
    console.warn = (m: string) => warnings.push(m);
    try {
      const a = await decodeGltfMesh(textureDoc({
        materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0, texCoord: 1 } }, normalTexture: { index: 0, scale: 0.5 } }],
      }));
      assert.equal(a.materials[0]!.baseColorTexture, null);
      assert.equal(a.materials[0]!.normalTexture, 0);
      assert.equal(a.materials[0]!.normalScale, 0.5);
      assert.ok(warnings.some((w) => /texCoord 1/.test(w)));
    } finally {
      console.warn = warn;
    }
  });

  test("image bytes are copies the worker can transfer", async () => {
    const { transferablesForGltfMesh } = await import("@forge/engine");
    const a = await decodeGltfMesh(cesium, { source: "CesiumMan.glb" });
    assert.ok(transferablesForGltfMesh(a).includes(a.images[0]!.bytes!.buffer as ArrayBuffer));
    assert.equal(a.images[0]!.bytes!.byteOffset, 0);
  });
});

group("textures + materials", () => {
  test("CesiumMan baseColor becomes an sRGB albedo map on the instantiated material", async () => {
    const d = await device();
    const a: DecodedGltfAsset = await decodeGltfMesh(cesium, { source: "CesiumMan.glb" });
    const calls: { mimeType: string; bytes: Uint8Array }[] = [];
    const textures = await loadGltfTextures(d, a, { decodeImage: fakeDecoder(calls) });
    cleanups.push(() => textures.dispose());
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.mimeType, "image/jpeg");
    const scene = new Scene({ name: "t" });
    const instance = instantiateGltfScene(d, scene, a, { textures });
    cleanups.push(() => { instance.dispose(); scene.dispose(); });
    const renderables = instance.nodes.flatMap((n) => (n?.get(Renderable) ? [n.get(Renderable)!] : []));
    assert.ok(renderables.length > 0);
    const material = renderables[0]!.material!;
    assert.ok(material.albedoMap);
    assert.equal(material.albedoMap!.desc.format, "rgba8unorm-srgb");
    assert.equal(material.metallic, 0);
    assert.equal(material.roughness, 1);
  });

  test("Perseverance: normal and MR maps are linear, colour maps sRGB, each (texture, colour space) built once", async () => {
    const d = await device();
    const a = await decodeGltfMesh(perseverance, { source: "Perseverance.glb" });
    const calls: { mimeType: string; bytes: Uint8Array }[] = [];
    const textures = await loadGltfTextures(d, a, { decodeImage: fakeDecoder(calls) });
    cleanups.push(() => textures.dispose());
    // Images shared by several textures are decoded once.
    assert.ok(calls.length <= a.images.length);
    const scene = new Scene({ name: "t" });
    const instance = instantiateGltfScene(d, scene, a, { textures });
    cleanups.push(() => { instance.dispose(); scene.dispose(); });
    const materials = new Set(instance.nodes.flatMap((n) => (n?.get(Renderable)?.material ? [n.get(Renderable)!.material!] : [])));
    const brass = [...materials].find((m) => m.label === "mars_2020_06_brass")!;
    assert.ok(brass, "brass material instantiated");
    assert.equal(brass.albedoMap!.desc.format, "rgba8unorm-srgb");
    assert.equal(brass.normalMap!.desc.format, "rgba8unorm");
    const lines = a.materials.findIndex((m) => m.metallicRoughnessTexture === 25);
    assert.equal(textures.get(25, "linear")!.desc.format, "rgba8unorm");
    assert.equal(textures.get(a.materials[lines]!.baseColorTexture!, "srgb")!.desc.format, "rgba8unorm-srgb");
    assert.equal(textures.get(25, "linear"), textures.get(25, "linear"));
  });

  test("without a texture set, materials stay factor-only (16.1f behaviour)", async () => {
    const d = await device();
    const a = await decodeGltfMesh(cesium, { source: "CesiumMan.glb" });
    const scene = new Scene({ name: "t" });
    const instance = instantiateGltfScene(d, scene, a);
    cleanups.push(() => { instance.dispose(); scene.dispose(); });
    const r = instance.nodes.find((n) => n?.get(Renderable))!.get(Renderable)!;
    assert.equal(r.material!.albedoMap, null);
  });

  test("external image URIs are fetched relative to baseUrl", async () => {
    const d = await device();
    const a = await decodeGltfMesh(textureDoc({ images: [{ uri: "tex/a.png" }] }));
    const fetched: string[] = [];
    const textures = await loadGltfTextures(d, a, {
      baseUrl: "https://example.test/models/m.gltf",
      fetcher: async (url) => { fetched.push(String(url)); return new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } }); },
      decodeImage: fakeDecoder(),
    });
    cleanups.push(() => textures.dispose());
    assert.deepEqual(fetched, ["https://example.test/models/tex/a.png"]);
    assert.ok(textures.get(0, "srgb"));
  });

  test("an image that fails to decode leaves that map unbound with a warning, not a failed load", async () => {
    const d = await device();
    const a = await decodeGltfMesh(textureDoc());
    const warn = console.warn;
    const warnings: string[] = [];
    console.warn = (m: string) => warnings.push(m);
    try {
      const textures = await loadGltfTextures(d, a, { decodeImage: async () => { throw new Error("boom"); } });
      cleanups.push(() => textures.dispose());
      assert.equal(textures.get(0, "srgb"), null);
      assert.ok(warnings.some((w) => /image 0.*boom/.test(w)));
    } finally {
      console.warn = warn;
    }
  });

  test("dispose releases every texture it created", async () => {
    const d = await device();
    const a = await decodeGltfMesh(cesium, { source: "CesiumMan.glb" });
    const textures = await loadGltfTextures(d, a, { decodeImage: fakeDecoder() });
    const t = textures.get(0, "srgb")!;
    textures.dispose();
    assert.equal(t.releasedState, true);
    textures.dispose(); // idempotent
  });
});

group("geometry", () => {
  test("an odd uint16 index count is padded to a 4-byte write (Perseverance has such primitives)", async () => {
    const d = await device();
    const queue = d.device.queue;
    const original = queue.writeBuffer.bind(queue);
    const sizes: number[] = [];
    (queue as { writeBuffer: unknown }).writeBuffer = (buffer: GPUBuffer, offset: number, data: ArrayBufferView | ArrayBuffer, ...rest: unknown[]) => {
      sizes.push(data.byteLength);
      return (original as (...a: unknown[]) => void)(buffer, offset, data, ...rest);
    };
    try {
      const g = Geometry.create(d, { positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), indices: new Uint16Array([0, 1, 2]) });
      cleanups.push(() => g.release());
      assert.equal(g.indexCount, 3);
      assert.equal(g.indexFormat, "uint16");
      assert.ok(sizes.length > 0 && sizes.every((n) => n % 4 === 0), `write sizes ${sizes.join(",")}`);
    } finally {
      (queue as { writeBuffer: unknown }).writeBuffer = original;
    }
  });
});

await finish();
