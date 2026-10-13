/**
 * @suite tools:gltfStripSkinSets
 * @group unit
 * @covers tools/gltf-strip-extra-skin-sets.mjs
 * @desc Pins the extra skin-set strip tool: round trip, idempotence, --force, --dry-run, engine decode of the output
 */

export const suite = {
  name: "tools:gltfStripSkinSets",
  group: "unit",
  covers:   [
    "tools/gltf-strip-extra-skin-sets.mjs"
  ],
  desc: "Pins the extra skin-set strip tool: round trip, idempotence, --force, --dry-run, engine decode of the output",
};
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import assert from "node:assert/strict";
import { afterEach, assertContains, assertRejects, finish, group, test } from "selrun";
import { decodeGltfMesh } from "@forge/engine";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const tool = path.join(root, "tools", "gltf-strip-extra-skin-sets.mjs");
const tempDirs: string[] = [];
afterEach(() => { for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-strip-skin-"));
  tempDirs.push(dir);
  return dir;
}

/**
 * A triangle skinned to two joints with an extra JOINTS_1/WEIGHTS_1 set. The extra set's views sit
 * between the skin streams and the indices + inverse bind matrices, so compaction must move data
 * and renumber the accessors and views that follow it.
 */
function makeAsset(extraWeight: number): { doc: Record<string, any>; bin: Uint8Array } {
  const parts: Uint8Array[] = [];
  const views: Record<string, unknown>[] = [];
  let offset = 0;
  const push = (bytes: Uint8Array): number => {
    const padded = new Uint8Array((bytes.byteLength + 3) & ~3);
    padded.set(bytes);
    views.push({ buffer: 0, byteOffset: offset, byteLength: bytes.byteLength });
    parts.push(padded);
    offset += padded.byteLength;
    return views.length - 1;
  };
  const f32 = (values: number[]): Uint8Array => new Uint8Array(new Float32Array(values).buffer);
  const position = push(f32([0, 0, 0, 1, 0, 0, 0, 1, 0]));
  const joints0 = push(new Uint8Array([0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0]));
  const weights0 = push(f32([0.75, 0.25, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]));
  const joints1 = push(new Uint8Array([1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]));
  const weights1 = push(f32([extraWeight, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]));
  const indices = push(new Uint8Array(new Uint16Array([0, 1, 2]).buffer));
  const ibm = push(f32([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -1, 0, 0, 1]));
  const bin = new Uint8Array(offset);
  let at = 0;
  for (const part of parts) { bin.set(part, at); at += part.byteLength; }
  const doc = {
    asset: { version: "2.0", generator: "strip-test" },
    buffers: [{ byteLength: bin.byteLength }],
    bufferViews: views,
    accessors: [
      { bufferView: position, componentType: 5126, count: 3, type: "VEC3", min: [0, 0, 0], max: [1, 1, 0] },
      { bufferView: joints0, componentType: 5121, count: 3, type: "VEC4" },
      { bufferView: weights0, componentType: 5126, count: 3, type: "VEC4" },
      { bufferView: joints1, componentType: 5121, count: 3, type: "VEC4" },
      { bufferView: weights1, componentType: 5126, count: 3, type: "VEC4" },
      { bufferView: indices, componentType: 5123, count: 3, type: "SCALAR" },
      { bufferView: ibm, componentType: 5126, count: 2, type: "MAT4" },
    ],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, JOINTS_0: 1, WEIGHTS_0: 2, JOINTS_1: 3, WEIGHTS_1: 4 }, indices: 5 }] }],
    nodes: [{ name: "body", mesh: 0, skin: 0 }, { name: "root", children: [2] }, { name: "tip", translation: [1, 0, 0] }],
    skins: [{ joints: [1, 2], inverseBindMatrices: 6 }],
    scenes: [{ nodes: [0, 1] }],
    scene: 0,
  };
  return { doc, bin };
}

function glb(doc: Record<string, unknown>, bin: Uint8Array): Uint8Array {
  const json = Buffer.from(JSON.stringify(doc));
  const jsonPadded = Buffer.concat([json, Buffer.alloc((4 - (json.length % 4)) % 4, 0x20)]);
  const total = 12 + 8 + jsonPadded.length + 8 + bin.byteLength;
  const out = Buffer.alloc(total);
  out.writeUInt32LE(0x46546c67, 0); out.writeUInt32LE(2, 4); out.writeUInt32LE(total, 8);
  out.writeUInt32LE(jsonPadded.length, 12); out.writeUInt32LE(0x4e4f534a, 16); jsonPadded.copy(out, 20);
  const at = 20 + jsonPadded.length;
  out.writeUInt32LE(bin.byteLength, at); out.writeUInt32LE(0x004e4942, at + 4); Buffer.from(bin).copy(out, at + 8);
  return out;
}

function run(...args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [tool, ...args], { encoding: "utf8" });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

const asArrayBuffer = (bytes: Buffer): ArrayBuffer => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;

function readGlbJson(file: string): Record<string, any> {
  const bytes = fs.readFileSync(file);
  return JSON.parse(bytes.subarray(20, 20 + bytes.readUInt32LE(12)).toString("utf8"));
}

group("tools/gltf-strip-extra-skin-sets.mjs", () => {
  test("strips an all-zero set from a GLB, compacts it, and the engine decodes the output", async () => {
    const dir = tempDir();
    const { doc, bin } = makeAsset(0);
    const input = path.join(dir, "in.glb");
    const output = path.join(dir, "out.glb");
    fs.writeFileSync(input, glb(doc, bin));
    // Precondition: the input itself is accepted (zero set ignored), so stripping is cleanup, not a fix.
    assert.ok((await decodeGltfMesh(asArrayBuffer(fs.readFileSync(input)))).skins.length === 1);
    const result = run(input, output);
    assert.equal(result.status, 0, result.stderr);
    assertContains(result.stdout, "stripped 1 extra JOINTS_n/WEIGHTS_n set(s); removed 2 accessor(s), 2 bufferView(s), 60 buffer byte(s)");
    const out = readGlbJson(output);
    assert.deepEqual(out.meshes[0].primitives[0].attributes, { POSITION: 0, JOINTS_0: 1, WEIGHTS_0: 2 });
    assert.equal(out.accessors.length, 5);
    assert.equal(out.bufferViews.length, 5);
    assert.equal(out.meshes[0].primitives[0].indices, 3);
    assert.equal(out.skins[0].inverseBindMatrices, 4);
    assert.equal(out.buffers[0].byteLength, bin.byteLength - 60);
    assert.deepEqual(out.nodes, doc.nodes);
    assert.deepEqual(out.asset, doc.asset);
    const original = await decodeGltfMesh(asArrayBuffer(fs.readFileSync(input)));
    const stripped = await decodeGltfMesh(asArrayBuffer(fs.readFileSync(output)));
    assert.deepEqual(stripped.meshes, original.meshes);
    assert.deepEqual(stripped.skins, original.skins);
    assert.deepEqual(stripped.nodes, original.nodes);
  });

  test("is idempotent: a second pass strips nothing and writes identical bytes", () => {
    const dir = tempDir();
    const { doc, bin } = makeAsset(0);
    fs.writeFileSync(path.join(dir, "in.glb"), glb(doc, bin));
    assert.equal(run(path.join(dir, "in.glb"), path.join(dir, "once.glb")).status, 0);
    const second = run(path.join(dir, "once.glb"), path.join(dir, "twice.glb"));
    assert.equal(second.status, 0);
    assertContains(second.stdout, "stripped 0 extra");
    assert.deepEqual(fs.readFileSync(path.join(dir, "twice.glb")), fs.readFileSync(path.join(dir, "once.glb")));
  });

  test("keeps a set with non-zero weights unless --force, which warns about accuracy loss", async () => {
    const dir = tempDir();
    const { doc, bin } = makeAsset(0.5);
    const input = path.join(dir, "in.glb");
    fs.writeFileSync(input, glb(doc, bin));
    const kept = run(input, path.join(dir, "kept.glb"));
    assert.equal(kept.status, 1);
    assertContains(kept.stderr, "kept mesh 0 primitive 0 set 1: it carries non-zero weights; rerun with --force");
    assert.equal(readGlbJson(path.join(dir, "kept.glb")).meshes[0].primitives[0].attributes.WEIGHTS_1, 4);
    await assertRejects(decodeGltfMesh(asArrayBuffer(fs.readFileSync(path.join(dir, "kept.glb")))), (error) => {
      assertContains((error as Error).message, "gltf-strip-extra-skin-sets.mjs");
      return true;
    });
    const forced = run(input, path.join(dir, "forced.glb"), "--force");
    assert.equal(forced.status, 0, forced.stderr);
    assertContains(forced.stderr, "warning: --force stripped non-zero weights from mesh 0 primitive 0 set 1");
    const decoded = await decodeGltfMesh(asArrayBuffer(fs.readFileSync(path.join(dir, "forced.glb"))));
    assert.ok(decoded.meshes[0]!.primitives[0]!.skin);
  });

  test("--dry-run reports without writing", () => {
    const dir = tempDir();
    const { doc, bin } = makeAsset(0);
    fs.writeFileSync(path.join(dir, "in.glb"), glb(doc, bin));
    const result = run(path.join(dir, "in.glb"), path.join(dir, "out.glb"), "--dry-run");
    assert.equal(result.status, 0);
    assertContains(result.stdout, "stripped 1 extra");
    assertContains(result.stdout, "dry run: nothing written");
    assert.equal(fs.existsSync(path.join(dir, "out.glb")), false);
  });

  test("handles .gltf with an external .bin and with a data-URI buffer", async () => {
    const dir = tempDir();
    const { doc, bin } = makeAsset(0);
    const external = { ...doc, buffers: [{ byteLength: bin.byteLength, uri: "in.bin" }] };
    fs.writeFileSync(path.join(dir, "in.bin"), bin);
    fs.writeFileSync(path.join(dir, "in.gltf"), JSON.stringify(external));
    fs.mkdirSync(path.join(dir, "out"));
    assert.equal(run(path.join(dir, "in.gltf"), path.join(dir, "out", "rig.gltf")).status, 0);
    const outDoc = JSON.parse(fs.readFileSync(path.join(dir, "out", "rig.gltf"), "utf8"));
    assert.equal(outDoc.buffers[0].uri, "rig.bin");
    const outBin = fs.readFileSync(path.join(dir, "out", "rig.bin"));
    assert.equal(outBin.byteLength, bin.byteLength - 60);
    const decodedExternal = await decodeGltfMesh({ json: JSON.stringify(outDoc), buffers: [asArrayBuffer(outBin)] });
    assert.deepEqual(Object.keys(decodedExternal.meshes[0]!.primitives[0]!.attributes), ["POSITION"]);
    assert.ok(decodedExternal.meshes[0]!.primitives[0]!.skin);

    const embedded = { ...doc, buffers: [{ byteLength: bin.byteLength, uri: `data:application/octet-stream;base64,${Buffer.from(bin).toString("base64")}` }] };
    fs.writeFileSync(path.join(dir, "embedded.gltf"), JSON.stringify(embedded));
    assert.equal(run(path.join(dir, "embedded.gltf"), path.join(dir, "embedded-out.gltf")).status, 0);
    const embeddedOut = fs.readFileSync(path.join(dir, "embedded-out.gltf"), "utf8");
    assert.match(JSON.parse(embeddedOut).buffers[0].uri, /^data:application\/octet-stream;base64,/);
    const decodedEmbedded = await decodeGltfMesh(embeddedOut);
    assert.deepEqual(decodedEmbedded.skins, decodedExternal.skins);
  });

  test("rejects bad usage and a format change", () => {
    assert.equal(run().status, 2);
    const dir = tempDir();
    const { doc, bin } = makeAsset(0);
    fs.writeFileSync(path.join(dir, "in.glb"), glb(doc, bin));
    const result = run(path.join(dir, "in.glb"), path.join(dir, "out.gltf"));
    assert.equal(result.status, 2);
    assertContains(result.stderr, "output must use the input's format (.glb)");
  });

  test("never overwrites the input or its external buffer", () => {
    const dir = tempDir();
    const { doc, bin } = makeAsset(0);
    const input = path.join(dir, "in.glb");
    const original = glb(doc, bin);
    fs.writeFileSync(input, original);
    const same = run(input, input);
    assert.equal(same.status, 2);
    assertContains(same.stderr, "refusing to overwrite input file");
    assert.deepEqual(new Uint8Array(fs.readFileSync(input)), new Uint8Array(original));

    fs.writeFileSync(path.join(dir, "out.bin"), bin);
    fs.writeFileSync(path.join(dir, "src.gltf"), JSON.stringify({ ...doc, buffers: [{ byteLength: bin.byteLength, uri: "out.bin" }] }));
    const clash = run(path.join(dir, "src.gltf"), path.join(dir, "out.gltf"));
    assert.equal(clash.status, 2);
    assertContains(clash.stderr, "refusing to overwrite input file");
    assert.deepEqual(new Uint8Array(fs.readFileSync(path.join(dir, "out.bin"))), new Uint8Array(bin));
    assert.equal(fs.existsSync(path.join(dir, "out.gltf")), false);
  });
});

await finish();
