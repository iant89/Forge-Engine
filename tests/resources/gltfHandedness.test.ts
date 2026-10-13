/**
 * @suite resources:gltfHandedness
 * @group integration
 * @covers engine/src/core/tasks/gltfHandedness.ts
 * @covers engine/src/core/tasks/gltfMesh.ts
 * @covers engine/src/resources/gltf.ts
 * @covers engine/src/math/mat.ts
 * @covers tools/gltf-fix-handedness.mjs
 * @covers examples/assets/Orientation.gltf
 * @desc glTF (right-handed) assets are mirrored into the engine's left-handed frame on import; the fix-handedness tool bakes it
 */

export const suite = {
  name: "resources:gltfHandedness",
  group: "integration",
  covers: [
    "engine/src/core/tasks/gltfHandedness.ts",
    "engine/src/core/tasks/gltfMesh.ts",
    "engine/src/resources/gltf.ts",
    "engine/src/math/mat.ts",
    "tools/gltf-fix-handedness.mjs",
    "examples/assets/Orientation.gltf",
  ],
  desc: "glTF (right-handed) assets are mirrored into the engine's left-handed frame on import; the fix-handedness tool bakes it",
};

import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { finish, group, test } from "selrun";
import { Mat4, Quat, Vec3, decodeGltfMesh, type DecodedGltfAsset } from "@forge/engine";
// @ts-expect-error plain .mjs tool without types
import { run as fixHandedness, fixHandednessDocument, HANDEDNESS_MARKER } from "../../tools/gltf-fix-handedness.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const assets = path.join(here, "../../examples/assets");
const orientation = readFileSync(path.join(assets, "Orientation.gltf"), "utf8");
const simpleSkin = readFileSync(path.join(assets, "SimpleSkin.gltf"), "utf8");
const cesium = readFileSync(path.join(assets, "CesiumMan.glb"));

function quiet<T>(fn: () => Promise<T>): Promise<{ value: T; warnings: string[] }> {
  const warn = console.warn;
  const warnings: string[] = [];
  console.warn = (m: string) => warnings.push(String(m));
  return fn().then((value) => ({ value, warnings }), (e) => { throw e; }).finally(() => { console.warn = warn; });
}

/** World position of a decoded node-local point, through the node chain to the root. */
function worldOf(asset: DecodedGltfAsset, node: number, p: Vec3): Vec3 {
  const parent = new Map<number, number>();
  asset.nodes.forEach((n, i) => n.children.forEach((c) => parent.set(c, i)));
  let out = p.clone();
  for (let i: number | undefined = node; i !== undefined; i = parent.get(i)) {
    const n = asset.nodes[i]!;
    let m: Mat4;
    if (n.matrix) m = new Mat4(n.matrix);
    else {
      const t = n.translation ?? [0, 0, 0], r = n.rotation ?? [0, 0, 0, 1], s = n.scale ?? [1, 1, 1];
      m = Mat4.compose(new Vec3(t[0]!, t[1]!, t[2]!), new Quat(r[0]!, r[1]!, r[2]!, r[3]!), new Vec3(s[0]!, s[1]!, s[2]!));
    }
    out = m.transformPoint(out, new Vec3());
  }
  return out;
}

group("verification", () => {
  test("the mirroring is real: an unconverted glTF's +X (its left side) lands on screen RIGHT seen from the front", () => {
    // glTF: front faces +Z, +Y up, right-handed, so viewed from the front +X is on the viewer's right... in a
    // right-handed viewer. Seen from the front in the engine (camera at +Z looking at the origin), world +X
    // projects to NDC x < 0, i.e. the viewer's LEFT: the picture is mirrored.
    const view = new Mat4().setLookAt(new Vec3(0, 0, 5), new Vec3(0, 0, 0), new Vec3(0, 1, 0));
    const p = view.transformPoint(new Vec3(1, 0, 0), new Vec3());
    assert.ok(p.x < 0, `engine view-space x of world +X from the front is ${p.x}`);
  });
});

group("import conversion", () => {
  test("Orientation.gltf: the marker on glTF +X ends up at engine -X, winding and normals stay outward", async () => {
    const { value: a, warnings } = await quiet(() => decodeGltfMesh(orientation, { source: "Orientation.gltf" }));
    assert.equal(a.handedness, "converted");
    assert.equal(warnings.filter((w) => /Orientation\.gltf/.test(w) && /handedness/i.test(w)).length, 1);
    const raw = await decodeGltfMesh(orientation, { source: "Orientation.gltf", handedness: "preserve" });
    assert.equal(raw.handedness, "preserved");
    // every position x negated, every normal x negated
    const p = a.meshes[0]!.primitives[0]!, q = raw.meshes[0]!.primitives[0]!;
    for (let i = 0; i < p.vertexCount; i++) {
      assert.equal(p.attributes.POSITION![i * 3], -q.attributes.POSITION![i * 3]!);
      assert.equal(p.attributes.NORMAL![i * 3 + 2], q.attributes.NORMAL![i * 3 + 2]);
      assert.equal(p.attributes.NORMAL![i * 3], -q.attributes.NORMAL![i * 3]! || 0);
    }
    // triangle winding swapped, so cross(e1, e2) is still the (mirrored) outward normal
    const P = p.attributes.POSITION!, N = p.attributes.NORMAL!, I = p.indices!;
    for (let t = 0; t < I.length; t += 3) {
      const [i0, i1, i2] = [I[t]!, I[t + 1]!, I[t + 2]!];
      const e1 = new Vec3(P[i1 * 3]! - P[i0 * 3]!, P[i1 * 3 + 1]! - P[i0 * 3 + 1]!, P[i1 * 3 + 2]! - P[i0 * 3 + 2]!);
      const e2 = new Vec3(P[i2 * 3]! - P[i0 * 3]!, P[i2 * 3 + 1]! - P[i0 * 3 + 1]!, P[i2 * 3 + 2]! - P[i0 * 3 + 2]!);
      const n = new Vec3(N[i0 * 3]!, N[i0 * 3 + 1]!, N[i0 * 3 + 2]!);
      const c = new Vec3();
      Vec3.crossInto(e1, e2, c);
      assert.ok(c.dot(n) > 0, `triangle ${t / 3} faces its normal`);
    }
    // bounds x mirrored
    assert.equal(p.bounds[0], -q.bounds[3]!);
    assert.equal(p.bounds[3], -q.bounds[0]!);
    // node transforms: the "left" marker node sits at +X in glTF, -X after conversion (world space)
    const marker = a.nodes.findIndex((n) => n.name === "left-marker");
    const w = worldOf(a, marker, new Vec3()), wr = worldOf(raw, marker, new Vec3());
    assert.ok(wr.x > 0.5 && Math.abs(w.x + wr.x) < 1e-5 && Math.abs(w.y - wr.y) < 1e-5 && Math.abs(w.z - wr.z) < 1e-5, `${wr.x} -> ${w.x}`);
  });

  test("tangents: x and w negated", async () => {
    const doc = JSON.parse(orientation);
    const a = await quiet(() => decodeGltfMesh(JSON.stringify(doc), { source: "t" }));
    const raw = await decodeGltfMesh(JSON.stringify(doc), { source: "t", handedness: "preserve" });
    const T = a.value.meshes[0]!.primitives[0]!.attributes.TANGENT!, R = raw.meshes[0]!.primitives[0]!.attributes.TANGENT!;
    assert.ok(T && R);
    for (let i = 0; i < T.length; i += 4) {
      assert.equal(T[i], -R[i]! || 0);
      assert.equal(T[i + 1], R[i + 1]);
      assert.equal(T[i + 2], R[i + 2]);
      assert.equal(T[i + 3], -R[i + 3]!);
    }
  });

  test("SimpleSkin: skinned world positions and animated poses are exact mirrors (IBMs, TRS, clip keys)", async () => {
    const a = (await quiet(() => decodeGltfMesh(simpleSkin, { source: "SimpleSkin.gltf" }))).value;
    const raw = await decodeGltfMesh(simpleSkin, { source: "SimpleSkin.gltf", handedness: "preserve" });
    const mirror = Mat4.compose(new Vec3(), new Quat(), new Vec3(-1, 1, 1));
    // IBM' = S · IBM · S
    const ibm = a.skins[0]!.inverseBindMatrices, rawIbm = raw.skins[0]!.inverseBindMatrices;
    for (let j = 0; j < ibm.length / 16; j++) {
      const expect = new Mat4().multiplyMatrices(mirror, new Mat4().multiplyMatrices(new Mat4(rawIbm.subarray(j * 16, j * 16 + 16)), mirror));
      for (let k = 0; k < 16; k++) assert.ok(Math.abs(ibm[j * 16 + k]! - expect.m[k]!) < 1e-6);
    }
    // rotation keys: q' = (x, -y, -z, w); translation keys: (-x, y, z)
    for (const [ai, anim] of a.animations.entries()) {
      for (const ch of anim.channels) {
        const o = anim.samplers[ch.samplerIndex]!.output, r = raw.animations[ai]!.samplers[ch.samplerIndex]!.output;
        const stride = ch.targetPath === "rotation" ? 4 : 3;
        for (let i = 0; i < o.length; i += stride) {
          const sign = ch.targetPath === "rotation" ? [1, -1, -1, 1] : ch.targetPath === "translation" ? [-1, 1, 1] : [1, 1, 1];
          for (let k = 0; k < stride; k++) assert.ok(Math.abs(o[i + k]! - sign[k]! * r[i + k]!) < 1e-7, `${ch.targetPath}[${i + k}]`);
        }
      }
    }
  });

  test("shared accessors are converted once, not twice", async () => {
    const doc = JSON.parse(orientation);
    doc.meshes[0].primitives.push({ ...doc.meshes[0].primitives[0] });
    const a = (await quiet(() => decodeGltfMesh(JSON.stringify(doc), { source: "shared" }))).value;
    const raw = await decodeGltfMesh(JSON.stringify(doc), { source: "shared", handedness: "preserve" });
    for (const k of [0, 1]) {
      assert.equal(a.meshes[0]!.primitives[k]!.attributes.POSITION![0], -raw.meshes[0]!.primitives[k]!.attributes.POSITION![0]!);
      assert.equal(a.meshes[0]!.primitives[k]!.indices![1], raw.meshes[0]!.primitives[k]!.indices![2]);
    }
  });

  test("non-indexed primitives get a winding-swapped index list", async () => {
    const doc = JSON.parse(orientation);
    delete doc.meshes[0].primitives[0].indices;
    for (const index of Object.values(doc.meshes[0].primitives[0].attributes) as number[]) doc.accessors[index].count = 3;
    const a = (await quiet(() => decodeGltfMesh(JSON.stringify(doc), { source: "ni" }))).value;
    assert.deepEqual([...a.meshes[0]!.primitives[0]!.indices!.subarray(0, 3)], [0, 2, 1]);
  });

  test("warns once per file name across decodes", async () => {
    const { warnings } = await quiet(async () => {
      await decodeGltfMesh(orientation, { source: "once.gltf" });
      await decodeGltfMesh(orientation, { source: "once.gltf" });
      await decodeGltfMesh(orientation, { source: "other.gltf" });
    });
    assert.equal(warnings.filter((w) => /once\.gltf/.test(w)).length, 1);
    assert.equal(warnings.filter((w) => /other\.gltf/.test(w)).length, 1);
  });
});

group("tools/gltf-fix-handedness.mjs", () => {
  const tmp = mkdtempSync(path.join(tmpdir(), "fe-hand-"));

  test("a converted file decodes to the same arrays as import-time conversion, with no warning", async () => {
    const out = path.join(tmp, "Orientation.fixed.gltf");
    const logs: string[] = [];
    assert.equal(fixHandedness([path.join(assets, "Orientation.gltf"), out], (m: string) => logs.push(m), () => {}), 0);
    const fixed = readFileSync(out, "utf8");
    assert.equal(JSON.parse(fixed).asset.extras[HANDEDNESS_MARKER.key], HANDEDNESS_MARKER.value);
    const { value: viaTool, warnings } = await quiet(() => decodeGltfMesh(fixed, { source: "fixed.gltf" }));
    assert.equal(viaTool.handedness, "preconverted");
    assert.deepEqual(warnings, []);
    const viaImport = (await quiet(() => decodeGltfMesh(orientation, { source: "x" }))).value;
    const a = viaTool.meshes[0]!.primitives[0]!, b = viaImport.meshes[0]!.primitives[0]!;
    for (const k of ["POSITION", "NORMAL", "TANGENT", "TEXCOORD_0"]) assert.deepEqual([...a.attributes[k]!], [...b.attributes[k]!], k);
    assert.deepEqual([...a.indices!], [...b.indices!]);
    assert.deepEqual(viaTool.nodes.map((n) => [n.translation && [...n.translation], n.rotation && [...n.rotation]]), viaImport.nodes.map((n) => [n.translation && [...n.translation], n.rotation && [...n.rotation]]));
  });

  test("GLB with skin + animation: tool output decodes like import-time conversion", async () => {
    const out = path.join(tmp, "CesiumMan.fixed.glb");
    assert.equal(fixHandedness([path.join(assets, "CesiumMan.glb"), out], () => {}, () => {}), 0);
    const viaTool = await decodeGltfMesh(readFileSync(out), { source: "c" });
    const viaImport = (await quiet(() => decodeGltfMesh(cesium, { source: "c2" }))).value;
    assert.equal(viaTool.handedness, "preconverted");
    const near = (x: ArrayLike<number>, y: ArrayLike<number>, label: string) => {
      assert.equal(x.length, y.length, label);
      for (let i = 0; i < x.length; i++) assert.ok(Math.abs(x[i]! - y[i]!) < 1e-5, `${label}[${i}] ${x[i]} vs ${y[i]}`);
    };
    near(viaTool.meshes[0]!.primitives[0]!.attributes.POSITION!, viaImport.meshes[0]!.primitives[0]!.attributes.POSITION!, "POSITION");
    near(viaTool.meshes[0]!.primitives[0]!.attributes.NORMAL!, viaImport.meshes[0]!.primitives[0]!.attributes.NORMAL!, "NORMAL");
    near(viaTool.meshes[0]!.primitives[0]!.indices!, viaImport.meshes[0]!.primitives[0]!.indices!, "indices");
    near(viaTool.skins[0]!.inverseBindMatrices, viaImport.skins[0]!.inverseBindMatrices, "IBM");
    viaTool.animations[0]!.samplers.forEach((s, i) => near(s.output, viaImport.animations[0]!.samplers[i]!.output, `anim ${i}`));
    viaTool.nodes.forEach((n, i) => {
      const m = viaImport.nodes[i]!;
      for (const k of ["translation", "rotation", "scale", "matrix"] as const) if (n[k] || m[k]) near(n[k]!, m[k]!, `node ${i} ${k}`);
    });
  });

  test("refuses to overwrite its input, refuses an already-converted file without --force, --dry-run writes nothing", () => {
    const input = path.join(tmp, "in.gltf");
    writeFileSync(input, orientation);
    const errs: string[] = [];
    assert.equal(fixHandedness([input, input], () => {}, (m: string) => errs.push(m)), 2);
    assert.ok(errs.some((e) => /overwrite/.test(e)));
    const out = path.join(tmp, "dry.gltf");
    assert.equal(fixHandedness([input, out, "--dry-run"], () => {}, () => {}), 0);
    assert.equal(existsSync(out), false);
    const once = path.join(tmp, "once.gltf");
    assert.equal(fixHandedness([input, once], () => {}, () => {}), 0);
    const twice = path.join(tmp, "twice.gltf");
    assert.equal(fixHandedness([once, twice], () => {}, () => {}), 1, "already converted");
    assert.equal(existsSync(twice), false);
    assert.equal(fixHandedness([once, twice, "--force"], () => {}, () => {}), 0, "--force reconverts (back to glTF handedness)");
    assert.equal(fixHandedness([], () => {}, () => {}), 2);
  });

  test("sparse accessors are refused rather than half-converted", () => {
    const doc = JSON.parse(orientation);
    doc.accessors[0].sparse = { count: 1, indices: { bufferView: 0, componentType: 5123 }, values: { bufferView: 0 } };
    assert.throws(() => fixHandednessDocument(doc, []), /sparse/);
  });
});

await finish();
