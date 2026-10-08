/**
 * @suite resources:gltf
 * @group unit
 * @covers engine/src/core/errors.ts
 * @covers engine/src/core/tasks/gltfMesh.ts
 * @covers engine/src/core/tasks/scheduler.ts
 * @covers engine/src/index.ts
 * @covers engine/src/resources/gltf.ts
 * @covers tests/fixtures/triangle.glb
 * @desc Pins gltf behavior and regression guarantees
 */

export const suite = {
  name: "resources:gltf",
  group: "unit",
  covers:   [
    "engine/src/core/errors.ts",
    "engine/src/core/tasks/gltfMesh.ts",
    "engine/src/core/tasks/scheduler.ts",
    "engine/src/index.ts",
    "engine/src/resources/gltf.ts",
    "tests/fixtures/triangle.glb"
  ],
  desc: "Pins gltf behavior and regression guarantees",
};
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { assertMatchObject, assertRejects, finish, group, test } from "selrun";
import {
  AssetError,
  TaskScheduler,
  decodeGltfMesh,
  loadGltfMesh,
  type DecodedGltfAsset,
} from "@forge/engine";
import { createWorkerThreadPool } from "../support/workerThreads.js";

const fixturePath = fileURLToPath(new URL("../fixtures/triangle.glb", import.meta.url));
const fixture = readFileSync(fixturePath);
const fixtureBuffer = (): ArrayBuffer => fixture.buffer.slice(fixture.byteOffset, fixture.byteOffset + fixture.byteLength) as ArrayBuffer;

function makeGltfJson(bufferByteLength: number): string {
  return JSON.stringify({
    asset: { version: "2.0" },
    buffers: [{ byteLength: bufferByteLength, uri: "mesh.bin" }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: bufferByteLength, byteStride: 16 }],
    accessors: [
      { bufferView: 0, byteOffset: 0, componentType: 5126, count: 3, type: "VEC3" },
      { bufferView: 0, byteOffset: 12, componentType: 5121, normalized: true, count: 3, type: "VEC4" },
    ],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, COLOR_0: 1 } }] }],
  });
}

function makeInterleavedBuffer(): ArrayBuffer {
  const bytes = new ArrayBuffer(48);
  const view = new DataView(bytes);
  const vertices = [
    [0, 0, 0, 255, 0, 0, 255],
    [1, 0, 0, 0, 255, 0, 255],
    [0, 1, 0, 0, 0, 255, 255],
  ];
  vertices.forEach((vertex, i) => {
    const offset = i * 16;
    for (let component = 0; component < 3; component++) view.setFloat32(offset + component * 4, vertex[component]!, true);
    for (let component = 0; component < 4; component++) view.setUint8(offset + 12 + component, vertex[component + 3]!);
  });
  return bytes;
}

group("glTF 2.0 mesh decoder", () => {
  test("decodes GLB triangle geometry, node transforms, scenes and PBR factors", async () => {
    const result = await decodeGltfMesh(fixtureBuffer(), { source: "triangle.glb" });
    assert.equal(result.version, "2.0");
    assert.equal(result.source, "triangle.glb");
    assert.equal((result.meshes).length, 1);
    assert.equal(result.meshes[0]!.name, "triangle");
    assert.equal(result.primitiveCount, 1);
    assert.equal(result.vertexCount, 3);
    const primitive = result.meshes[0]!.primitives[0]!;
    assert.deepEqual(primitive.attributes.POSITION, new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]));
    assert.deepEqual(primitive.attributes.NORMAL, new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]));
    assert.deepEqual(primitive.attributes.TEXCOORD_0, new Float32Array([0, 0, 1, 0, 0, 1]));
    assert.deepEqual(primitive.indices, new Uint16Array([0, 1, 2]));
    assert.deepEqual(primitive.bounds, new Float32Array([0, 0, 0, 1, 1, 0]));
    assert.equal(primitive.materialIndex, 0);
    assert.equal(result.materials[0]!.name, "fixture-red");
    assert.deepEqual(result.materials[0]!.baseColorFactor, new Float32Array([1, 0.25, 0.1, 1]));
    assert.equal(result.nodes[0]!.meshIndex, 0);
    assert.deepEqual(result.nodes[0]!.translation, new Float32Array([1, 2, 3]));
    assert.deepEqual(result.scenes[0]!.nodes, [0]);
    assert.equal(result.sceneIndex, 0);
  });

  test("unpacks interleaved normalized vertex attributes from a JSON glTF document", async () => {
    const buffer = makeInterleavedBuffer();
    const result = await decodeGltfMesh({ json: makeGltfJson(buffer.byteLength), buffers: [buffer] });
    const primitive = result.meshes[0]!.primitives[0]!;
    assert.deepEqual(primitive.attributes.POSITION, new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]));
    assert.deepEqual(primitive.attributes.COLOR_0, new Float32Array([
      1, 0, 0, 1,
      0, 1, 0, 1,
      0, 0, 1, 1,
    ]));
    assert.equal(primitive.indices, null);
    assert.equal(primitive.vertexCount, 3);
  });

  test("decodes an embedded data-URI buffer inside the decoder", async () => {
    const binary = Buffer.from(makeInterleavedBuffer());
    const document = JSON.parse(makeGltfJson(binary.byteLength)) as { buffers: { uri: string; byteLength: number }[] };
    document.buffers[0]!.uri = `data:application/octet-stream;base64,${binary.toString("base64")}`;
    const decoded = await decodeGltfMesh(JSON.stringify(document));
    assert.equal(decoded.vertexCount, 3);
    assert.equal(decoded.meshes[0]!.primitives[0]!.attributes.POSITION![3], 1);
  });

  test("applies sparse accessor values to a zero-initialized vertex stream", async () => {
    const buffer = new ArrayBuffer(40);
    const bytes = new Uint8Array(buffer);
    bytes.set([0, 1, 2], 0);
    const data = new DataView(buffer);
    const positions = [0, 0, 0, 2, 0, 0, 0, 2, 0];
    positions.forEach((value, i) => data.setFloat32(4 + i * 4, value, true));
    const json = JSON.stringify({
      asset: { version: "2.0" },
      buffers: [{ byteLength: 40 }],
      bufferViews: [
        { buffer: 0, byteOffset: 0, byteLength: 3 },
        { buffer: 0, byteOffset: 4, byteLength: 36 },
      ],
      accessors: [{ componentType: 5126, count: 3, type: "VEC3", sparse: {
        count: 3,
        indices: { bufferView: 0, componentType: 5121 },
        values: { bufferView: 1 },
      } }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    });
    const decoded = await decodeGltfMesh({ json, buffers: [buffer] });
    assert.deepEqual(decoded.meshes[0]!.primitives[0]!.attributes.POSITION, new Float32Array(positions));
  });

  test("resolves external .gltf buffers before scheduling the decoder", async () => {
    const binary = makeInterleavedBuffer();
    const calls: string[] = [];
    const fetcher = async (input: string | URL): Promise<Response> => {
      const href = String(input);
      calls.push(href);
      if (href === "https://assets.test/model.gltf") {
        return new Response(makeGltfJson(binary.byteLength), { status: 200, headers: { "content-type": "model/gltf+json" } });
      }
      if (href === "https://assets.test/mesh.bin") return new Response(binary, { status: 200 });
      return new Response("not found", { status: 404 });
    };
    const result = await loadGltfMesh("https://assets.test/model.gltf", { fetcher, source: "model.gltf" });
    assert.deepEqual(calls, ["https://assets.test/model.gltf", "https://assets.test/mesh.bin"]);
    assert.equal(result.meshes[0]!.primitives[0]!.attributes.COLOR_0![3], 1);
  });

  test("fails clearly on unsupported compressed geometry and malformed GLB headers", async () => {
    const compressed = JSON.stringify({
      asset: { version: "2.0" },
      extensionsRequired: ["KHR_draco_mesh_compression"],
      meshes: [],
    });
    await assertRejects(decodeGltfMesh(compressed), (error) => { assertMatchObject(error, { code: "E_ASSET_GLTF_EXTENSION" }); return true; });
    const morphMesh = JSON.stringify({ asset: { version: "2.0" }, meshes: [{ weights: [0], primitives: [{ attributes: { POSITION: 0 } }] }] });
    await assertRejects(decodeGltfMesh(morphMesh), (error) => { assertMatchObject(error, { code: "E_ASSET_GLTF_EXTENSION" }); return true; });
    const morphNode = JSON.stringify({ asset: { version: "2.0" }, meshes: [], nodes: [{ weights: [0] }] });
    await assertRejects(decodeGltfMesh(morphNode), (error) => { assertMatchObject(error, { code: "E_ASSET_GLTF_EXTENSION" }); return true; });
    const skinAttributes = JSON.stringify({ asset: { version: "2.0" }, meshes: [{ primitives: [{ attributes: { POSITION: 0, JOINTS_0: 1 } }] }] });
    await assertRejects(decodeGltfMesh(skinAttributes), (error) => { assertMatchObject(error, { code: "E_ASSET_GLTF_EXTENSION" }); return true; });
    const malformed = new ArrayBuffer(20);
    await assertRejects(decodeGltfMesh(malformed), (error) => error instanceof AssetError);
  });

  test("runs the same decoder through the inline scheduler", async () => {
    const scheduler = new TaskScheduler({ workerCount: 1, inline: true });
    try {
      const result = await decodeGltfMesh(fixtureBuffer(), { scheduler, key: "inline.gltf" });
      assert.equal(result.vertexCount, 3);
      assert.equal(scheduler.stats.completed, 1);
      assert.equal(scheduler.stats.inline, true);
    } finally {
      scheduler.dispose();
    }
  });

  test("runs GLB mesh decoding on a real worker thread and transfers the result", async () => {
    const pool = await createWorkerThreadPool();
    const scheduler = new TaskScheduler({ workerCount: 1, createWorker: (index) => pool.createWorker(index) });
    try {
      const workerResult = await decodeGltfMesh(fixtureBuffer(), {
        scheduler,
        key: "worker.gltf.triangle",
        transferInput: true,
      });
      const inlineResult = await decodeGltfMesh(fixtureBuffer());
      assert.deepEqual(workerResult, inlineResult);
      assert.equal(scheduler.stats.workers, 1);
      assert.equal(scheduler.stats.inline, false);
      assert.equal(scheduler.stats.completed, 1);
      assert.equal(scheduler.stats.inlineFallbacks, 0);
      assert.equal(scheduler.stats.workerFailures, 0);
    } finally {
      scheduler.dispose();
      await pool.dispose();
    }
  });

  test("loads through a worker without mutating the input when transfer is disabled", async () => {
    const scheduler = new TaskScheduler({ inline: true });
    const input = fixtureBuffer();
    try {
      const result: DecodedGltfAsset = await decodeGltfMesh(input, { scheduler, key: "keep-input" });
      assert.equal(new DataView(input).getUint32(0, true), 0x46546c67);
      assert.ok(result.decodedBytes > 0);
    } finally {
      scheduler.dispose();
    }
  });
});

await finish();
