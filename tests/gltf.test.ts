import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  AssetError,
  TaskScheduler,
  decodeGltfMesh,
  loadGltfMesh,
  type DecodedGltfAsset,
} from "@forge/engine";
import { createWorkerThreadPool } from "./support/workerThreads.js";

const fixturePath = fileURLToPath(new URL("./fixtures/triangle.glb", import.meta.url));
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

describe("glTF 2.0 mesh decoder", () => {
  it("decodes GLB triangle geometry, node transforms, scenes and PBR factors", async () => {
    const result = await decodeGltfMesh(fixtureBuffer(), { source: "triangle.glb" });
    expect(result.version).toBe("2.0");
    expect(result.source).toBe("triangle.glb");
    expect(result.meshes).toHaveLength(1);
    expect(result.meshes[0]!.name).toBe("triangle");
    expect(result.primitiveCount).toBe(1);
    expect(result.vertexCount).toBe(3);
    const primitive = result.meshes[0]!.primitives[0]!;
    expect(primitive.attributes.POSITION).toEqual(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]));
    expect(primitive.attributes.NORMAL).toEqual(new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]));
    expect(primitive.attributes.TEXCOORD_0).toEqual(new Float32Array([0, 0, 1, 0, 0, 1]));
    expect(primitive.indices).toEqual(new Uint16Array([0, 1, 2]));
    expect(primitive.bounds).toEqual(new Float32Array([0, 0, 0, 1, 1, 0]));
    expect(primitive.materialIndex).toBe(0);
    expect(result.materials[0]!.name).toBe("fixture-red");
    expect(result.materials[0]!.baseColorFactor).toEqual(new Float32Array([1, 0.25, 0.1, 1]));
    expect(result.nodes[0]!.meshIndex).toBe(0);
    expect(result.nodes[0]!.translation).toEqual(new Float32Array([1, 2, 3]));
    expect(result.scenes[0]!.nodes).toEqual([0]);
    expect(result.sceneIndex).toBe(0);
  });

  it("unpacks interleaved normalized vertex attributes from a JSON glTF document", async () => {
    const buffer = makeInterleavedBuffer();
    const result = await decodeGltfMesh({ json: makeGltfJson(buffer.byteLength), buffers: [buffer] });
    const primitive = result.meshes[0]!.primitives[0]!;
    expect(primitive.attributes.POSITION).toEqual(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]));
    expect(primitive.attributes.COLOR_0).toEqual(new Float32Array([
      1, 0, 0, 1,
      0, 1, 0, 1,
      0, 0, 1, 1,
    ]));
    expect(primitive.indices).toBeNull();
    expect(primitive.vertexCount).toBe(3);
  });

  it("decodes an embedded data-URI buffer inside the decoder", async () => {
    const binary = Buffer.from(makeInterleavedBuffer());
    const document = JSON.parse(makeGltfJson(binary.byteLength)) as { buffers: { uri: string; byteLength: number }[] };
    document.buffers[0]!.uri = `data:application/octet-stream;base64,${binary.toString("base64")}`;
    const decoded = await decodeGltfMesh(JSON.stringify(document));
    expect(decoded.vertexCount).toBe(3);
    expect(decoded.meshes[0]!.primitives[0]!.attributes.POSITION![3]).toBe(1);
  });

  it("applies sparse accessor values to a zero-initialized vertex stream", async () => {
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
    expect(decoded.meshes[0]!.primitives[0]!.attributes.POSITION).toEqual(new Float32Array(positions));
  });

  it("resolves external .gltf buffers before scheduling the decoder", async () => {
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
    expect(calls).toEqual(["https://assets.test/model.gltf", "https://assets.test/mesh.bin"]);
    expect(result.meshes[0]!.primitives[0]!.attributes.COLOR_0![3]).toBe(1);
  });

  it("fails clearly on unsupported compressed geometry and malformed GLB headers", async () => {
    const compressed = JSON.stringify({
      asset: { version: "2.0" },
      extensionsRequired: ["KHR_draco_mesh_compression"],
      meshes: [],
    });
    await expect(decodeGltfMesh(compressed)).rejects.toMatchObject({ code: "E_ASSET_GLTF_EXTENSION" });
    const morphMesh = JSON.stringify({ asset: { version: "2.0" }, meshes: [{ weights: [0], primitives: [{ attributes: { POSITION: 0 } }] }] });
    await expect(decodeGltfMesh(morphMesh)).rejects.toMatchObject({ code: "E_ASSET_GLTF_EXTENSION" });
    const morphNode = JSON.stringify({ asset: { version: "2.0" }, meshes: [], nodes: [{ weights: [0] }] });
    await expect(decodeGltfMesh(morphNode)).rejects.toMatchObject({ code: "E_ASSET_GLTF_EXTENSION" });
    const skinAttributes = JSON.stringify({ asset: { version: "2.0" }, meshes: [{ primitives: [{ attributes: { POSITION: 0, JOINTS_0: 1 } }] }] });
    await expect(decodeGltfMesh(skinAttributes)).rejects.toMatchObject({ code: "E_ASSET_GLTF_EXTENSION" });
    const malformed = new ArrayBuffer(20);
    await expect(decodeGltfMesh(malformed)).rejects.toBeInstanceOf(AssetError);
  });

  it("runs the same decoder through the inline scheduler", async () => {
    const scheduler = new TaskScheduler({ workerCount: 1, inline: true });
    try {
      const result = await decodeGltfMesh(fixtureBuffer(), { scheduler, key: "inline.gltf" });
      expect(result.vertexCount).toBe(3);
      expect(scheduler.stats.completed).toBe(1);
      expect(scheduler.stats.inline).toBe(true);
    } finally {
      scheduler.dispose();
    }
  });

  it("runs GLB mesh decoding on a real worker thread and transfers the result", async () => {
    const pool = await createWorkerThreadPool();
    const scheduler = new TaskScheduler({ workerCount: 1, createWorker: (index) => pool.createWorker(index) });
    try {
      const workerResult = await decodeGltfMesh(fixtureBuffer(), {
        scheduler,
        key: "worker.gltf.triangle",
        transferInput: true,
      });
      const inlineResult = await decodeGltfMesh(fixtureBuffer());
      expect(workerResult).toEqual(inlineResult);
      expect(scheduler.stats.workers).toBe(1);
      expect(scheduler.stats.inline).toBe(false);
      expect(scheduler.stats.completed).toBe(1);
      expect(scheduler.stats.inlineFallbacks).toBe(0);
      expect(scheduler.stats.workerFailures).toBe(0);
    } finally {
      scheduler.dispose();
      await pool.dispose();
    }
  });

  it("loads through a worker without mutating the input when transfer is disabled", async () => {
    const scheduler = new TaskScheduler({ inline: true });
    const input = fixtureBuffer();
    try {
      const result: DecodedGltfAsset = await decodeGltfMesh(input, { scheduler, key: "keep-input" });
      expect(new DataView(input).getUint32(0, true)).toBe(0x46546c67);
      expect(result.decodedBytes).toBeGreaterThan(0);
    } finally {
      scheduler.dispose();
    }
  });
});
