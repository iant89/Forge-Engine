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
  transferablesForGltfMesh,
  validateSkinningData,
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

interface SkinFixtureOptions {
  weightsNormalized?: boolean;
  jointComponentType?: number;
  ibmCount?: number | null;
  joint?: number;
  extra?: (doc: Record<string, any>) => void;
}

/** Three vertices skinned to a two-joint skin; one data-URI buffer, so no external resolution. */
function makeSkinnedGltf(options: SkinFixtureOptions = {}): string {
  const weightsNormalized = options.weightsNormalized ?? false;
  const jointType = options.jointComponentType ?? 5121;
  const ibmCount = options.ibmCount === undefined ? 2 : options.ibmCount;
  const jointBytes = jointType === 5123 ? 2 : jointType === 5126 ? 4 : 1;
  const weightBytes = weightsNormalized ? 1 : 4;
  const posLen = 36, jointLen = 12 * jointBytes, weightLen = 12 * weightBytes, ibmLen = (ibmCount ?? 0) * 64;
  const pad = (n: number): number => (n + 3) & ~3;
  const jointOff = posLen, weightOff = jointOff + pad(jointLen), ibmOff = weightOff + pad(weightLen);
  const total = ibmOff + ibmLen;
  const bytes = new ArrayBuffer(total);
  const view = new DataView(bytes);
  [[0, 0, 0], [1, 0, 0], [0, 1, 0]].forEach((p, i) => p.forEach((v, c) => view.setFloat32(i * 12 + c * 4, v, true)));
  const joints = [[0, 1, 0, 0], [1, 0, 0, 0], [options.joint ?? 0, 0, 0, 0]];
  const weights = [[0.75, 0.25, 0, 0], [1, 0, 0, 0], [1, 0, 0, 0]];
  joints.flat().forEach((j, i) => {
    const o = jointOff + i * jointBytes;
    if (jointType === 5123) view.setUint16(o, j, true);
    else if (jointType === 5126) view.setFloat32(o, j, true);
    else view.setUint8(o, j);
  });
  weights.flat().forEach((w, i) => {
    if (weightsNormalized) view.setUint8(weightOff + i, Math.round(w * 255));
    else view.setFloat32(weightOff + i * 4, w, true);
  });
  for (let m = 0; m < (ibmCount ?? 0); m++) {
    // Column-major translation by (-m, 0, 0): the inverse of a joint placed at x = m.
    const base = ibmOff + m * 64;
    [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, m === 0 ? 0 : -m, 0, 0, 1].forEach((v, k) => view.setFloat32(base + k * 4, v, true));
  }
  const b64 = Buffer.from(bytes).toString("base64");
  const accessors: Record<string, unknown>[] = [
    { bufferView: 0, componentType: 5126, count: 3, type: "VEC3" },
    { bufferView: 1, componentType: jointType, count: 3, type: "VEC4" },
    { bufferView: 2, componentType: weightsNormalized ? 5121 : 5126, normalized: weightsNormalized || undefined, count: 3, type: "VEC4" },
  ];
  const bufferViews: Record<string, unknown>[] = [
    { buffer: 0, byteOffset: 0, byteLength: posLen },
    { buffer: 0, byteOffset: jointOff, byteLength: jointLen },
    { buffer: 0, byteOffset: weightOff, byteLength: weightLen },
  ];
  const skin: Record<string, unknown> = { name: "arm", joints: [1, 2], skeleton: 1 };
  if (ibmCount !== null) {
    bufferViews.push({ buffer: 0, byteOffset: ibmOff, byteLength: ibmLen });
    accessors.push({ bufferView: 3, componentType: 5126, count: ibmCount, type: "MAT4" });
    skin.inverseBindMatrices = 3;
  }
  const doc: Record<string, any> = {
    asset: { version: "2.0" },
    buffers: [{ byteLength: total, uri: `data:application/octet-stream;base64,${b64}` }],
    bufferViews,
    accessors,
    meshes: [{ primitives: [{ attributes: { POSITION: 0, JOINTS_0: 1, WEIGHTS_0: 2 } }] }],
    nodes: [{ name: "body", mesh: 0, skin: 0 }, { name: "root", children: [2] }, { name: "tip", translation: [1, 0, 0] }],
    skins: [skin],
    scenes: [{ nodes: [0, 1] }],
  };
  options.extra?.(doc);
  return JSON.stringify(doc);
}

async function rejectsWith(json: string, code: string, pattern: RegExp): Promise<void> {
  await assertRejects(decodeGltfMesh(json), (error) => {
    assertMatchObject(error, { code });
    assert.match((error as Error).message, pattern);
    return true;
  });
}

group("glTF 2.0 skin import (Phase 16.1a)", () => {
  test("decodes skins, node skin bindings and JOINTS_0/WEIGHTS_0 into skinning vertex data", async () => {
    const asset = await decodeGltfMesh(makeSkinnedGltf());
    assert.equal(asset.skins.length, 1);
    const skin = asset.skins[0]!;
    assert.equal(skin.name, "arm");
    assert.deepEqual(skin.joints, [1, 2]);
    assert.equal(skin.skeleton, 1);
    assert.equal(skin.inverseBindMatrices.length, 32);
    assert.equal(skin.inverseBindMatrices[12], 0);
    assert.equal(skin.inverseBindMatrices[16 + 12], -1);
    assert.equal(asset.nodes[0]!.skinIndex, 0);
    assert.equal(asset.nodes[1]!.skinIndex, null);
    const primitive = asset.meshes[0]!.primitives[0]!;
    assert.ok(primitive.skin, "primitive carries skinning data");
    assert.ok(primitive.skin.joints instanceof Uint16Array);
    assert.deepEqual([...primitive.skin.joints], [0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0]);
    assert.deepEqual([...primitive.skin.weights], [0.75, 0.25, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]);
    assert.equal(primitive.skin.vertexCount, 3);
    assert.equal(primitive.attributes.JOINTS_0, undefined, "skin streams are not duplicated as float attributes");
    assert.equal(primitive.attributes.WEIGHTS_0, undefined);
    assert.deepEqual(validateSkinningData(primitive.skin), []);
  });

  test("accepts unsigned-short joints and normalized unsigned-byte weights", async () => {
    const asset = await decodeGltfMesh(makeSkinnedGltf({ jointComponentType: 5123, weightsNormalized: true }));
    const skin = asset.meshes[0]!.primitives[0]!.skin!;
    assert.deepEqual([...skin.joints.subarray(0, 4)], [0, 1, 0, 0]);
    assert.ok(Math.abs(skin.weights[0]! - 191 / 255) < 1e-6);
    assert.ok(Math.abs(skin.weights[1]! - 64 / 255) < 1e-6);
  });

  test("defaults missing inverse bind matrices to identity", async () => {
    const asset = await decodeGltfMesh(makeSkinnedGltf({ ibmCount: null }));
    const ibm = asset.skins[0]!.inverseBindMatrices;
    assert.deepEqual([...ibm], [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  });

  test("counts and transfers the skin arrays", async () => {
    const asset = await decodeGltfMesh(makeSkinnedGltf());
    const unskinned = await decodeGltfMesh(makeSkinnedGltf({ extra: (doc) => {
      doc.meshes[0].primitives[0].attributes = { POSITION: 0 };
      delete doc.nodes[0].skin;
      delete doc.skins;
    } }));
    // 12 Uint16 joints + 12 Float32 weights + 32 Float32 IBM floats.
    assert.equal(asset.decodedBytes - unskinned.decodedBytes, 24 + 48 + 128);
    const transferred = new Set(transferablesForGltfMesh(asset));
    const primitiveSkin = asset.meshes[0]!.primitives[0]!.skin!;
    assert.ok(transferred.has(primitiveSkin.joints.buffer as ArrayBuffer));
    assert.ok(transferred.has(primitiveSkin.weights.buffer as ArrayBuffer));
    assert.ok(transferred.has(asset.skins[0]!.inverseBindMatrices.buffer as ArrayBuffer));
    const pool = await createWorkerThreadPool();
    const scheduler = new TaskScheduler({ workerCount: 1, createWorker: (index) => pool.createWorker(index) });
    try {
      const workerResult = await decodeGltfMesh(makeSkinnedGltf(), { scheduler, key: "worker.gltf.skin" });
      assert.deepEqual(workerResult, asset);
      assert.equal(scheduler.stats.inlineFallbacks, 0);
      assert.equal(scheduler.stats.workerFailures, 0);
    } finally {
      scheduler.dispose();
      await pool.dispose();
    }
  });

  test("rejects malformed skins and skin streams with clear errors", async () => {
    await rejectsWith(makeSkinnedGltf({ joint: 2 }), "E_ASSET_GLTF", /joint index 2.*skin 0 has 2 joints/);
    await rejectsWith(makeSkinnedGltf({ jointComponentType: 5126 }), "E_ASSET_GLTF", /JOINTS_0 must be unsigned byte or unsigned short/);
    await rejectsWith(makeSkinnedGltf({ ibmCount: 1 }), "E_ASSET_GLTF", /inverseBindMatrices has 1 matrices; expected at least 2/);
    await rejectsWith(makeSkinnedGltf({ extra: (doc) => { delete doc.meshes[0].primitives[0].attributes.WEIGHTS_0; } }), "E_ASSET_GLTF", /JOINTS_0 and WEIGHTS_0 must appear together/);
    await rejectsWith(makeSkinnedGltf({ extra: (doc) => { doc.meshes[0].primitives[0].attributes.JOINTS_1 = 1; doc.meshes[0].primitives[0].attributes.WEIGHTS_1 = 2; } }), "E_ASSET_GLTF_EXTENSION", /more than four joint influences/);
    await rejectsWith(makeSkinnedGltf({ extra: (doc) => { doc.skins[0].joints = [1, 9]; } }), "E_ASSET_GLTF", /skin 0 joint index 9 is out of range/);
    await rejectsWith(makeSkinnedGltf({ extra: (doc) => { doc.skins[0].joints = [1, 1]; } }), "E_ASSET_GLTF", /skin 0 lists node 1 twice/);
    await rejectsWith(makeSkinnedGltf({ extra: (doc) => { doc.skins[0].joints = []; } }), "E_ASSET_GLTF", /skin 0 has no joints/);
    await rejectsWith(makeSkinnedGltf({ extra: (doc) => { doc.nodes[1].skin = 0; } }), "E_ASSET_GLTF", /node 1 has a skin but no mesh/);
    await rejectsWith(makeSkinnedGltf({ extra: (doc) => { doc.nodes[0].skin = 4; } }), "E_ASSET_GLTF", /node 0 skin index 4 is out of range/);
    await rejectsWith(makeSkinnedGltf({ extra: (doc) => {
      doc.meshes.push({ primitives: [{ attributes: { POSITION: 0 } }] });
      doc.nodes[0].mesh = 1;
    } }), "E_ASSET_GLTF", /node 0 is skinned but mesh 1 primitive 0 has no JOINTS_0\/WEIGHTS_0/);
  });
});

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
    const skinAttributes = JSON.stringify({ asset: { version: "2.0" }, meshes: [{ primitives: [{ attributes: { POSITION: 0, JOINTS_1: 1 } }] }] });
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
