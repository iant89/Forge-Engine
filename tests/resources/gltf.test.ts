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
import { createRequire } from "node:module";
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
  type GltfDracoDecoder,
} from "@forge/engine";
import { createWorkerThreadPool } from "../support/workerThreads.js";
import { MeshoptEncoder } from "meshoptimizer/encoder";

// These suites check the file's authored numbers, so they decode without the handedness mirror
// (tests/resources/gltfHandedness.test.ts covers the conversion).
const PRESERVE = { handedness: "preserve" as const };
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

async function makeDracoGltf(): Promise<{ json: string; decoder: GltfDracoDecoder }> {
  // draco3dgltf is a Node/WASM test dependency; the engine deliberately receives this host decoder
  // through its structured-clone-safe interface instead of importing WASM in the worker task.
  type DracoBindings = Record<string, any>;
  const draco3d = createRequire(import.meta.url)("draco3dgltf") as {
    createEncoderModule: (options: Record<string, unknown>) => Promise<DracoBindings>;
    createDecoderModule: (options: Record<string, unknown>) => Promise<DracoBindings>;
  };
  const encoderModule = await draco3d.createEncoderModule({});
  const mesh = new encoderModule.Mesh();
  const builder = new encoderModule.MeshBuilder();
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  builder.AddFacesToMesh(mesh, 1, new Uint32Array([0, 1, 2]));
  const positionAttribute = builder.AddFloatAttributeToMesh(mesh, encoderModule.POSITION, 3, 3, positions);
  const encoder = new encoderModule.Encoder();
  const encoded = new encoderModule.DracoInt8Array();
  const encodedLength = encoder.EncodeMeshToDracoBuffer(mesh, encoded);
  assert.ok(encodedLength > 0);
  const bytes = new Uint8Array(encodedLength);
  for (let i = 0; i < encodedLength; i++) bytes[i] = encoded.GetValue(i);
  encoderModule.destroy(encoded);
  encoderModule.destroy(encoder);
  encoderModule.destroy(mesh);
  encoderModule.destroy(builder);

  const decoderModule = await draco3d.createDecoderModule({});
  const decoder: GltfDracoDecoder = {
    decode(data, attributes) {
      const buffer = new decoderModule.DecoderBuffer();
      buffer.Init(new Int8Array(data.buffer, data.byteOffset, data.byteLength), data.byteLength);
      const nativeDecoder = new decoderModule.Decoder();
      const geometry = new decoderModule.Mesh();
      const status = nativeDecoder.DecodeBufferToMesh(buffer, geometry);
      if (!status.ok()) throw new Error(status.error_msg());
      const vertexCount = geometry.num_points();
      const decodedAttributes: Record<string, Float32Array> = {};
      for (const [semantic, attributeId] of Object.entries(attributes)) {
        const attribute = nativeDecoder.GetAttribute(geometry, attributeId);
        if (!attribute) throw new Error(`missing Draco attribute ${semantic}`);
        const values = new decoderModule.DracoFloat32Array();
        nativeDecoder.GetAttributeFloatForAllPoints(geometry, attribute, values);
        const output = new Float32Array(values.size());
        for (let i = 0; i < output.length; i++) output[i] = values.GetValue(i);
        decoderModule.destroy(values);
        decodedAttributes[semantic] = output;
      }
      const face = new decoderModule.DracoInt32Array();
      const indices = new Uint32Array(geometry.num_faces() * 3);
      for (let i = 0; i < geometry.num_faces(); i++) {
        nativeDecoder.GetFaceFromMesh(geometry, i, face);
        indices.set([face.GetValue(0), face.GetValue(1), face.GetValue(2)], i * 3);
      }
      decoderModule.destroy(face);
      decoderModule.destroy(geometry);
      decoderModule.destroy(nativeDecoder);
      decoderModule.destroy(buffer);
      return { attributes: decodedAttributes, indices, vertexCount };
    },
  };
  const json = JSON.stringify({
    asset: { version: "2.0" },
    extensionsRequired: ["KHR_draco_mesh_compression"],
    buffers: [{ byteLength: bytes.byteLength, uri: `data:application/octet-stream;base64,${Buffer.from(bytes).toString("base64")}` }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: bytes.byteLength }],
    meshes: [{ primitives: [{ extensions: { KHR_draco_mesh_compression: { bufferView: 0, attributes: { POSITION: positionAttribute } } } }] }],
  });
  return { json, decoder };
}

async function makeMeshoptGltf(): Promise<string> {
  await MeshoptEncoder.ready;
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  const indices = new Uint16Array([0, 1, 2]);
  const compressedPositions = MeshoptEncoder.encodeGltfBuffer(new Uint8Array(positions.buffer), 3, 12, "ATTRIBUTES");
  const compressedIndices = MeshoptEncoder.encodeGltfBuffer(new Uint8Array(indices.buffer), 3, 2, "INDICES");
  const bytes = new Uint8Array(compressedPositions.byteLength + compressedIndices.byteLength);
  bytes.set(compressedPositions, 0);
  bytes.set(compressedIndices, compressedPositions.byteLength);
  const extension = (byteOffset: number, byteLength: number, byteStride: number, mode: "ATTRIBUTES" | "INDICES") => ({
    EXT_meshopt_compression: { buffer: 0, byteOffset, byteLength, byteStride, count: 3, mode },
  });
  return JSON.stringify({
    asset: { version: "2.0" },
    extensionsRequired: ["EXT_meshopt_compression"],
    buffers: [{ byteLength: bytes.byteLength, uri: `data:application/octet-stream;base64,${Buffer.from(bytes).toString("base64")}` }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: compressedPositions.byteLength, extensions: extension(0, compressedPositions.byteLength, 12, "ATTRIBUTES") },
      { buffer: 0, byteOffset: compressedPositions.byteLength, byteLength: compressedIndices.byteLength, extensions: extension(compressedPositions.byteLength, compressedIndices.byteLength, 2, "INDICES") },
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: "VEC3" },
      { bufferView: 1, componentType: 5123, count: 3, type: "SCALAR" },
    ],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
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
  /** Append an all-zero float VEC4 accessor (index returned as `doc.accessors.length - 1`). */
  zeroSet?: boolean;
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
  const zeroOff = ibmOff + ibmLen, zeroLen = options.zeroSet ? 48 : 0;
  const total = zeroOff + zeroLen;
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
  if (options.zeroSet) {
    bufferViews.push({ buffer: 0, byteOffset: zeroOff, byteLength: zeroLen });
    accessors.push({ bufferView: bufferViews.length - 1, componentType: 5126, count: 3, type: "VEC4" });
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
  await assertRejects(decodeGltfMesh(json, PRESERVE), (error) => {
    assertMatchObject(error, { code });
    assert.match((error as Error).message, pattern);
    return true;
  });
}

group("glTF 2.0 skin import (Phase 16.1a)", () => {
  test("decodes skins, node skin bindings and JOINTS_0/WEIGHTS_0 into skinning vertex data", async () => {
    const asset = await decodeGltfMesh(makeSkinnedGltf(), PRESERVE);
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

  test("an unsupported animation is skipped with console.warn; the model still loads", async () => {
    const warnings: unknown[][] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args); };
    try {
      const asset = await decodeGltfMesh(makeSkinnedGltf({ extra: (doc) => {
        doc.animations = [{ name: "bezier", channels: [{ sampler: 0, target: { node: 1, path: "rotation" } }], samplers: [{ input: 0, output: 0, interpolation: "BEZIER" }] }];
      } }), PRESERVE);
      assert.equal(asset.meshes.length, 1);
      assert.equal(asset.skins.length, 1);
      assert.deepEqual(asset.animations, []);
      assert.equal(warnings.length, 1);
      assert.match(String(warnings[0]![0]), /skipping animation 0 \(bezier\).*unsupported interpolation/);
    } finally {
      console.warn = originalWarn;
    }
  });

  test("accepts unsigned-short joints and normalized unsigned-byte weights", async () => {
    const asset = await decodeGltfMesh(makeSkinnedGltf({ jointComponentType: 5123, weightsNormalized: true }), PRESERVE);
    const skin = asset.meshes[0]!.primitives[0]!.skin!;
    assert.deepEqual([...skin.joints.subarray(0, 4)], [0, 1, 0, 0]);
    assert.ok(Math.abs(skin.weights[0]! - 191 / 255) < 1e-6);
    assert.ok(Math.abs(skin.weights[1]! - 64 / 255) < 1e-6);
  });

  test("defaults missing inverse bind matrices to identity", async () => {
    const asset = await decodeGltfMesh(makeSkinnedGltf({ ibmCount: null }), PRESERVE);
    const ibm = asset.skins[0]!.inverseBindMatrices;
    assert.deepEqual([...ibm], [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  });

  test("counts and transfers the skin arrays", async () => {
    const asset = await decodeGltfMesh(makeSkinnedGltf(), PRESERVE);
    const unskinned = await decodeGltfMesh(makeSkinnedGltf({ extra: (doc) => {
      doc.meshes[0].primitives[0].attributes = { POSITION: 0 };
      delete doc.nodes[0].skin;
      delete doc.skins;
    } }), PRESERVE);
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
      const workerResult = await decodeGltfMesh(makeSkinnedGltf(), { ...PRESERVE, scheduler, key: "worker.gltf.skin" });
      assert.deepEqual(workerResult, asset);
      assert.equal(scheduler.stats.inlineFallbacks, 0);
      assert.equal(scheduler.stats.workerFailures, 0);
    } finally {
      scheduler.dispose();
      await pool.dispose();
    }
  });

  test("ignores extra JOINTS_n/WEIGHTS_n sets whose weights are all zero", async () => {
    const reference = await decodeGltfMesh(makeSkinnedGltf(), PRESERVE);
    const reference2 = await decodeGltfMesh(makeSkinnedGltf({ zeroSet: true }), PRESERVE);
    const padded = await decodeGltfMesh(makeSkinnedGltf({ zeroSet: true, extra: (doc) => {
      // Exporters pad to eight influences with sets like these.
      const zeroWeights = doc.accessors.length - 1;
      Object.assign(doc.meshes[0].primitives[0].attributes, { JOINTS_1: 1, WEIGHTS_1: zeroWeights, JOINTS_2: 1, WEIGHTS_2: zeroWeights });
    } }), PRESERVE);
    const primitive = padded.meshes[0]!.primitives[0]!;
    assert.deepEqual(Object.keys(primitive.attributes), ["POSITION"]);
    assert.deepEqual(primitive.skin, reference.meshes[0]!.primitives[0]!.skin);
    assert.equal(padded.decodedBytes, reference2.decodedBytes, "ignored sets are not decoded or counted");
  });

  test("rejects an extra influence set that carries weight and points at the strip script", async () => {
    await rejectsWith(
      makeSkinnedGltf({ extra: (doc) => Object.assign(doc.meshes[0].primitives[0].attributes, { JOINTS_1: 1, WEIGHTS_1: 2 }) }),
      "E_ASSET_GLTF_EXTENSION",
      /WEIGHTS_1 carries non-zero weights.*tools\/gltf-strip-extra-skin-sets\.mjs/,
    );
  });

  test("rejects malformed skins and skin streams with clear errors", async () => {
    await rejectsWith(makeSkinnedGltf({ joint: 2 }), "E_ASSET_GLTF", /joint index 2.*skin 0 has 2 joints/);
    await rejectsWith(makeSkinnedGltf({ jointComponentType: 5126 }), "E_ASSET_GLTF", /JOINTS_0 must be unsigned byte or unsigned short/);
    await rejectsWith(makeSkinnedGltf({ ibmCount: 1 }), "E_ASSET_GLTF", /inverseBindMatrices has 1 matrices; expected at least 2/);
    await rejectsWith(makeSkinnedGltf({ extra: (doc) => { delete doc.meshes[0].primitives[0].attributes.WEIGHTS_0; } }), "E_ASSET_GLTF", /JOINTS_0 and WEIGHTS_0 must appear together/);
    await rejectsWith(makeSkinnedGltf({ extra: (doc) => { doc.meshes[0].primitives[0].attributes.JOINTS_1 = 1; } }), "E_ASSET_GLTF", /JOINTS_1 and WEIGHTS_1 must appear together/);
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
    const result = await decodeGltfMesh(fixtureBuffer(), { ...PRESERVE, source: "triangle.glb" });
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
    const result = await decodeGltfMesh({ json: makeGltfJson(buffer.byteLength), buffers: [buffer] }, PRESERVE);
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
    const decoded = await decodeGltfMesh(JSON.stringify(document), PRESERVE);
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
    const decoded = await decodeGltfMesh({ json, buffers: [buffer] }, PRESERVE);
    assert.deepEqual(decoded.meshes[0]!.primitives[0]!.attributes.POSITION, new Float32Array(positions));
  });

  test("decodes KHR_draco_mesh_compression through a supplied host decoder without cloning it", async () => {
    const { json, decoder } = await makeDracoGltf();
    const scheduler = new TaskScheduler({ workerCount: 1, inline: true });
    try {
      const asset = await decodeGltfMesh(json, { ...PRESERVE, source: "draco.gltf", dracoDecoder: decoder, scheduler });
      const primitive = asset.meshes[0]!.primitives[0]!;
      assert.equal(primitive.vertexCount, 3);
      assert.equal(primitive.attributes.POSITION!.length, 9);
      assert.deepEqual(primitive.indices, new Uint16Array([0, 1, 2]));
      assert.ok(Math.abs(primitive.attributes.POSITION![3]! - 1) < 1e-6);
      assert.equal(scheduler.stats.completed, 0, "the non-transferable decoder forces this call inline");
    } finally {
      scheduler.dispose();
    }
    await assertRejects(decodeGltfMesh(json, PRESERVE), (error) => {
      assertMatchObject(error, { code: "E_ASSET_GLTF_EXTENSION" });
      assert.match((error as Error).message, /no Draco decoder/);
      return true;
    });
  });

  test("decodes EXT_meshopt_compression attributes and indices on the inline and worker paths", async () => {
    const json = await makeMeshoptGltf();
    const inline = await decodeGltfMesh(json, { ...PRESERVE, source: "meshopt.gltf" });
    const primitive = inline.meshes[0]!.primitives[0]!;
    assert.deepEqual(primitive.attributes.POSITION, new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]));
    assert.deepEqual(primitive.indices, new Uint16Array([0, 1, 2]));

    const pool = await createWorkerThreadPool();
    const scheduler = new TaskScheduler({ workerCount: 1, createWorker: (index) => pool.createWorker(index) });
    try {
      const worker = await decodeGltfMesh(json, { ...PRESERVE, source: "meshopt-worker.gltf", scheduler, key: "worker.gltf.meshopt" });
      assert.deepEqual(worker.meshes[0]!.primitives[0]!.attributes.POSITION, primitive.attributes.POSITION);
      assert.deepEqual(worker.meshes[0]!.primitives[0]!.indices, primitive.indices);
      assert.equal(scheduler.stats.workers, 1);
      assert.equal(scheduler.stats.inlineFallbacks, 0);
      assert.equal(scheduler.stats.workerFailures, 0);
    } finally {
      scheduler.dispose();
      await pool.dispose();
    }
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
    const result = await loadGltfMesh("https://assets.test/model.gltf", { ...PRESERVE, fetcher, source: "model.gltf" });
    assert.deepEqual(calls, ["https://assets.test/model.gltf", "https://assets.test/mesh.bin"]);
    assert.equal(result.meshes[0]!.primitives[0]!.attributes.COLOR_0![3], 1);
  });

  test("fails clearly on unsupported compressed geometry and malformed GLB headers", async () => {
    const compressed = JSON.stringify({
      asset: { version: "2.0" },
      extensionsRequired: ["KHR_draco_mesh_compression"],
      meshes: [],
    });
    await assertRejects(decodeGltfMesh(compressed, PRESERVE), (error) => { assertMatchObject(error, { code: "E_ASSET_GLTF_EXTENSION" }); return true; });
    const morphMesh = JSON.stringify({ asset: { version: "2.0" }, meshes: [{ weights: [0], primitives: [{ attributes: { POSITION: 0 } }] }] });
    await assertRejects(decodeGltfMesh(morphMesh, PRESERVE), (error) => { assertMatchObject(error, { code: "E_ASSET_GLTF_EXTENSION" }); return true; });
    const morphNode = JSON.stringify({ asset: { version: "2.0" }, meshes: [], nodes: [{ weights: [0] }] });
    await assertRejects(decodeGltfMesh(morphNode, PRESERVE), (error) => { assertMatchObject(error, { code: "E_ASSET_GLTF_EXTENSION" }); return true; });
    const malformed = new ArrayBuffer(20);
    await assertRejects(decodeGltfMesh(malformed, PRESERVE), (error) => error instanceof AssetError);
  });

  test("runs the same decoder through the inline scheduler", async () => {
    const scheduler = new TaskScheduler({ workerCount: 1, inline: true });
    try {
      const result = await decodeGltfMesh(fixtureBuffer(), { ...PRESERVE, scheduler, key: "inline.gltf" });
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
      const workerResult = await decodeGltfMesh(fixtureBuffer(), { ...PRESERVE, scheduler,
        key: "worker.gltf.triangle",
        transferInput: true,
      });
      const inlineResult = await decodeGltfMesh(fixtureBuffer(), PRESERVE);
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
      const result: DecodedGltfAsset = await decodeGltfMesh(input, { ...PRESERVE, scheduler, key: "keep-input" });
      assert.equal(new DataView(input).getUint32(0, true), 0x46546c67);
      assert.ok(result.decodedBytes > 0);
    } finally {
      scheduler.dispose();
    }
  });
});

await finish();
