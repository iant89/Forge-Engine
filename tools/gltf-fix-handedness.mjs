#!/usr/bin/env node
/**
 * Permanently convert a glTF 2.0 asset from glTF's right-handed frame to Forge Engine's left-handed one.
 *
 * Usage: node tools/gltf-fix-handedness.mjs <input.gltf|input.glb> <output> [--force] [--dry-run]
 *        npm run gltf:fix-handedness -- <input> <output> [--force] [--dry-run]
 *
 * The engine importer (`decodeGltfMesh`) mirrors every glTF on load (x → -x; see
 * engine/src/core/tasks/gltfHandedness.ts) and warns once per file. This tool bakes the same
 * conversion into the file and marks it (`asset.extras.forgeHandedness = "engine-left-handed"`), so
 * the importer uses it as-is with no warning:
 *   - POSITION / NORMAL x negated (POSITION min/max updated), TANGENT x and w negated, morph-target
 *     deltas x negated; triangle winding swapped (non-indexed triangle lists get an index accessor);
 *   - node translation / rotation / matrix, inverse bind matrices and translation / rotation
 *     animation keys mirrored (q → (x, -y, -z, w), M → S·M·S).
 * Use it on a COPY for engine use, never to replace the original: a converted file is NOT a correctly
 * oriented glTF for other viewers any more (it is mirrored there).
 *
 * Refused (exit 2): sparse accessors, unsigned components that would need negation, non-triangle-list
 * primitives, geometry-compression / instancing extensions, an output that is the input.
 * An already-marked input exits 1 without writing; --force converts it again (back to glTF
 * handedness) and removes the marker. --dry-run prints the summary without writing.
 * The output keeps the input's container format (.glb in → .glb out, .gltf in → .gltf out).
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { encodeGlb, finishBuffers, loadBuffers, parseContainer } from "./gltf-strip-extra-skin-sets.mjs";

export const HANDEDNESS_MARKER = { key: "forgeHandedness", value: "engine-left-handed" };
const COMPONENT_BYTES = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
const COMPONENTS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };
const REFUSED_EXTENSIONS = ["KHR_draco_mesh_compression", "EXT_meshopt_compression", "EXT_mesh_gpu_instancing"];

export class HandednessError extends Error {}

function element(doc, buffers, accessorIndex) {
  const accessor = doc.accessors?.[accessorIndex];
  if (!accessor) throw new HandednessError(`accessor ${accessorIndex} is missing`);
  if (accessor.sparse) throw new HandednessError(`accessor ${accessorIndex} is sparse; sparse accessors are not supported by this tool`);
  if (accessor.bufferView === undefined) return null; // all zeros: nothing to mirror
  const bufferView = doc.bufferViews?.[accessor.bufferView];
  if (!bufferView) throw new HandednessError(`bufferView ${accessor.bufferView} is missing`);
  const bytes = buffers[bufferView.buffer]?.bytes;
  if (!bytes) throw new HandednessError(`buffer ${bufferView.buffer} is missing`);
  const size = COMPONENT_BYTES[accessor.componentType];
  const components = COMPONENTS[accessor.type];
  const stride = bufferView.byteStride ?? size * components;
  const base = (bufferView.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const type = accessor.componentType;
  const at = (e, c) => base + e * stride + c * size;
  const get = (e, c) => {
    const o = at(e, c);
    return type === 5126 ? view.getFloat32(o, true) : type === 5120 ? view.getInt8(o) : type === 5121 ? view.getUint8(o)
      : type === 5122 ? view.getInt16(o, true) : type === 5123 ? view.getUint16(o, true) : view.getUint32(o, true);
  };
  const set = (e, c, v) => {
    const o = at(e, c);
    if (type === 5126) view.setFloat32(o, v, true);
    else if (type === 5120) view.setInt8(o, v);
    else if (type === 5121) view.setUint8(o, v);
    else if (type === 5122) view.setInt16(o, v, true);
    else if (type === 5123) view.setUint16(o, v, true);
    else view.setUint32(o, v, true);
  };
  return { accessor, count: accessor.count, get, set, signed: type === 5126 || type === 5120 || type === 5122 };
}

/** Negate the listed components of every element. Signed int8/int16 -128/-32768 clamp to the max. */
function negate(doc, buffers, accessorIndex, componentsToNegate, label) {
  const el = element(doc, buffers, accessorIndex);
  if (!el) return;
  if (!el.signed) throw new HandednessError(`${label} accessor ${accessorIndex} uses unsigned components and cannot be mirrored`);
  const type = el.accessor.componentType;
  const max = type === 5120 ? 127 : type === 5122 ? 32767 : Infinity;
  for (let e = 0; e < el.count; e++) {
    for (const c of componentsToNegate) {
      const v = el.get(e, c);
      el.set(e, c, v === 0 ? 0 : Math.min(max, -v));
    }
  }
}

function mirrorMatrices(doc, buffers, accessorIndex) {
  const el = element(doc, buffers, accessorIndex);
  if (!el) return;
  if (el.accessor.type !== "MAT4" || el.accessor.componentType !== 5126) throw new HandednessError(`inverseBindMatrices accessor ${accessorIndex} must be FLOAT MAT4`);
  for (let e = 0; e < el.count; e++) {
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) if ((r === 0) !== (c === 0)) el.set(e, c * 4 + r, -el.get(e, c * 4 + r) || 0);
  }
}

function swapWinding(doc, buffers, accessorIndex) {
  const el = element(doc, buffers, accessorIndex);
  if (!el) throw new HandednessError(`index accessor ${accessorIndex} has no bufferView`);
  for (let t = 0; t + 2 < el.count; t += 3) {
    const a = el.get(t + 1, 0);
    el.set(t + 1, 0, el.get(t + 2, 0));
    el.set(t + 2, 0, a);
  }
}

function appendIndexAccessor(doc, buffers, vertexCount, kindForNew) {
  const n = vertexCount - (vertexCount % 3);
  const wide = vertexCount > 65535;
  const data = wide ? new Uint32Array(n) : new Uint16Array(n);
  for (let i = 0; i < n; i += 3) { data[i] = i; data[i + 1] = i + 2; data[i + 2] = i + 1; }
  const bytes = new Uint8Array(data.buffer);
  doc.buffers ??= [];
  if (buffers.length === 0) {
    buffers.push({ kind: kindForNew, bytes: new Uint8Array(0) });
    doc.buffers.push({ byteLength: 0 });
  }
  const target = buffers[0];
  const offset = (target.bytes.byteLength + 3) & ~3;
  const grown = new Uint8Array(offset + bytes.byteLength);
  grown.set(target.bytes);
  grown.set(bytes, offset);
  target.bytes = grown;
  doc.buffers[0].byteLength = grown.byteLength;
  doc.bufferViews ??= [];
  doc.bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: bytes.byteLength, target: 34963 });
  doc.accessors ??= [];
  doc.accessors.push({ bufferView: doc.bufferViews.length - 1, componentType: wide ? 5125 : 5123, count: n, type: "SCALAR" });
  return doc.accessors.length - 1;
}

/** Mirror `doc` + `buffers` in place. Returns a summary. */
export function fixHandednessDocument(doc, buffers, { kindForNew = "data" } = {}) {
  for (const ext of REFUSED_EXTENSIONS) {
    if ((doc.extensionsUsed ?? []).includes(ext)) throw new HandednessError(`${ext} is not supported by this tool`);
  }
  const roles = new Map(); // accessor -> role
  const claim = (index, role) => {
    const prior = roles.get(index);
    if (prior && prior !== role) throw new HandednessError(`accessor ${index} is used as both ${prior} and ${role}`);
    const first = !prior;
    roles.set(index, role);
    return first;
  };
  const summary = { accessors: 0, primitives: 0, generatedIndices: 0, nodes: 0, skins: 0, channels: 0 };
  for (const accessor of doc.accessors ?? []) if (accessor.sparse) throw new HandednessError("sparse accessors are not supported by this tool");
  (doc.meshes ?? []).forEach((mesh, m) => (mesh.primitives ?? []).forEach((p, pi) => {
    if ((p.mode ?? 4) !== 4) throw new HandednessError(`mesh ${m} primitive ${pi} is not a triangle list (mode ${p.mode})`);
    const a = p.attributes ?? {};
    if (a.POSITION !== undefined && claim(a.POSITION, "POSITION")) {
      negate(doc, buffers, a.POSITION, [0], "POSITION");
      const acc = doc.accessors[a.POSITION];
      if (acc.min && acc.max) [acc.min[0], acc.max[0]] = [-acc.max[0] || 0, -acc.min[0] || 0];
      summary.accessors++;
    }
    if (a.NORMAL !== undefined && claim(a.NORMAL, "NORMAL")) { negate(doc, buffers, a.NORMAL, [0], "NORMAL"); summary.accessors++; }
    if (a.TANGENT !== undefined && claim(a.TANGENT, "TANGENT")) { negate(doc, buffers, a.TANGENT, [0, 3], "TANGENT"); summary.accessors++; }
    for (const target of p.targets ?? []) {
      for (const key of ["POSITION", "NORMAL", "TANGENT"]) {
        if (target[key] === undefined || !claim(target[key], `target ${key}`)) continue;
        negate(doc, buffers, target[key], [0], `target ${key}`);
        const acc = doc.accessors[target[key]];
        if (key === "POSITION" && acc.min && acc.max) [acc.min[0], acc.max[0]] = [-acc.max[0] || 0, -acc.min[0] || 0];
        summary.accessors++;
      }
    }
    if (p.indices !== undefined) {
      if (claim(p.indices, "indices")) { swapWinding(doc, buffers, p.indices); summary.accessors++; }
    } else if (a.POSITION !== undefined) {
      p.indices = appendIndexAccessor(doc, buffers, doc.accessors[a.POSITION].count, kindForNew);
      claim(p.indices, "indices");
      summary.generatedIndices++;
    }
    summary.primitives++;
  }));
  for (const node of doc.nodes ?? []) {
    if (node.translation) node.translation[0] = -node.translation[0] || 0;
    if (node.rotation) { node.rotation[1] = -node.rotation[1] || 0; node.rotation[2] = -node.rotation[2] || 0; }
    if (node.matrix) for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) if ((r === 0) !== (c === 0)) node.matrix[c * 4 + r] = -node.matrix[c * 4 + r] || 0;
    summary.nodes++;
  }
  for (const skin of doc.skins ?? []) {
    if (skin.inverseBindMatrices !== undefined && claim(skin.inverseBindMatrices, "inverseBindMatrices")) { mirrorMatrices(doc, buffers, skin.inverseBindMatrices); summary.skins++; }
  }
  for (const animation of doc.animations ?? []) {
    for (const channel of animation.channels ?? []) {
      const pathName = channel.target?.path;
      if (pathName !== "translation" && pathName !== "rotation") continue;
      const output = animation.samplers?.[channel.sampler]?.output;
      if (output === undefined || !claim(output, `${pathName} keys`)) continue;
      negate(doc, buffers, output, pathName === "translation" ? [0] : [1, 2], `${pathName} keys`);
      summary.channels++;
    }
  }
  return summary;
}

function isMarked(doc) {
  return doc.asset?.extras?.[HANDEDNESS_MARKER.key] === HANDEDNESS_MARKER.value;
}

export function run(argv, log = console.log, warn = console.error) {
  const flags = new Set(argv.filter((a) => a.startsWith("--")));
  const positional = argv.filter((a) => !a.startsWith("--"));
  const unknown = [...flags].filter((f) => f !== "--force" && f !== "--dry-run");
  if (positional.length !== 2 || unknown.length > 0) {
    warn("usage: node tools/gltf-fix-handedness.mjs <input.gltf|input.glb> <output> [--force] [--dry-run]\n  writes an engine-only copy; keep the original (the output is mirrored in other glTF viewers)");
    return 2;
  }
  const [input, output] = positional;
  const force = flags.has("--force");
  const dryRun = flags.has("--dry-run");
  try {
    if (path.resolve(input) === path.resolve(output)) throw new HandednessError(`refusing to overwrite input file ${input}; choose another output name`);
    const { format, doc, bin } = parseContainer(fs.readFileSync(input), input);
    if (path.extname(output).toLowerCase() !== `.${format}`) throw new HandednessError(`output must use the input's format (.${format})`);
    const marked = isMarked(doc);
    if (marked && !force) {
      warn(`${input} is already converted (asset.extras.${HANDEDNESS_MARKER.key}); rerun with --force to convert it back`);
      return 1;
    }
    const buffers = loadBuffers(doc, bin, input);
    const summary = fixHandednessDocument(doc, buffers, { kindForNew: format === "glb" ? "glb" : "data" });
    doc.asset ??= { version: "2.0" };
    if (marked) {
      delete doc.asset.extras[HANDEDNESS_MARKER.key];
      if (Object.keys(doc.asset.extras).length === 0) delete doc.asset.extras;
    } else {
      doc.asset.extras = { ...(doc.asset.extras ?? {}), [HANDEDNESS_MARKER.key]: HANDEDNESS_MARKER.value };
    }
    log(`${input}: ${marked ? "converted back to glTF handedness" : "mirrored to engine handedness"} — ${summary.primitives} primitive(s), ` +
      `${summary.accessors} accessor(s), ${summary.generatedIndices} generated index list(s), ${summary.nodes} node(s), ${summary.skins} skin(s), ${summary.channels} animation channel(s)`);
    if (dryRun) {
      log("dry run: nothing written");
      return 0;
    }
    const { bin: outBin, files } = finishBuffers(doc, buffers, output);
    const protectedPaths = new Set([path.resolve(input), ...buffers.filter((b) => b.kind === "file")
      .map((b) => path.resolve(path.dirname(input), decodeURIComponent(b.uri)))]);
    for (const target of [output, ...files.map((f) => f.file)]) {
      if (protectedPaths.has(path.resolve(target))) throw new HandednessError(`refusing to overwrite input file ${target}; choose another output name`);
    }
    for (const { file, bytes } of files) fs.writeFileSync(file, bytes);
    fs.writeFileSync(output, format === "glb" ? encodeGlb(doc, outBin) : JSON.stringify(doc, null, 2));
    log(`wrote ${output}`);
    return 0;
  } catch (error) {
    warn(`error: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = run(process.argv.slice(2));
}
