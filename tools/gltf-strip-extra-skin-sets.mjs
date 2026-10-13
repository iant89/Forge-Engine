#!/usr/bin/env node
/**
 * Remove extra skin influence sets (JOINTS_n / WEIGHTS_n for n >= 1) from a glTF 2.0 asset.
 *
 * Usage: node tools/gltf-strip-extra-skin-sets.mjs <input.gltf|input.glb> <output> [--force] [--dry-run]
 *        npm run gltf:strip-skin-sets -- <input> <output> [--force] [--dry-run]
 *
 * Forge's skinning path takes four influences per vertex (JOINTS_0/WEIGHTS_0). The engine loader
 * ignores extra sets whose weights are all zero and rejects any that carry weight. This tool:
 *   - strips every all-zero extra set (default),
 *   - with --force, also strips non-zero sets and warns: those influences are lost, and the remaining
 *     WEIGHTS_0 no longer sum to 1 for the affected vertices (the engine does not renormalize),
 *   - drops the accessors and bufferViews only those sets used, compacts the buffers (the GLB BIN
 *     chunk, data-URI buffers, or external .bin files written next to the output) and leaves the
 *     rest of the document as it was,
 *   - prints a summary; --dry-run prints it without writing.
 *
 * The output keeps the input's container format (.glb in → .glb out, .gltf in → .gltf out).
 * Exit codes: 0 done, 1 non-zero sets were kept (rerun with --force), 2 usage or input error.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const GLB_MAGIC = 0x46546c67;
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;
const COMPONENT_BYTES = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
const COMPONENTS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };
const EXTRA_SET = /^(JOINTS|WEIGHTS)_([1-9]\d*)$/;
/** Extensions whose accessor/bufferView references this tool rewrites, or that hold none. */
const COMPACT_SAFE_EXTENSIONS = new Set([
  "EXT_mesh_gpu_instancing", "KHR_draco_mesh_compression", "KHR_mesh_quantization", "KHR_lights_punctual",
  "KHR_texture_transform", "KHR_texture_basisu", "EXT_texture_webp", "EXT_texture_avif", "KHR_materials_variants",
  "KHR_materials_emissive_strength", "KHR_materials_unlit", "KHR_materials_clearcoat", "KHR_materials_ior",
  "KHR_materials_specular", "KHR_materials_transmission", "KHR_materials_volume", "KHR_materials_sheen",
  "KHR_materials_iridescence", "KHR_materials_anisotropy", "KHR_materials_dispersion", "KHR_xmp_json_ld",
]);

export class StripError extends Error {}

export function parseContainer(bytes, inputPath) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  if (u8.byteLength >= 4 && view.getUint32(0, true) === GLB_MAGIC) {
    if (u8.byteLength < 20 || view.getUint32(4, true) !== 2) throw new StripError(`${inputPath}: not a GLB 2.0 file`);
    let offset = 12;
    let json = null;
    let bin = null;
    while (offset + 8 <= u8.byteLength) {
      const length = view.getUint32(offset, true);
      const type = view.getUint32(offset + 4, true);
      const data = u8.subarray(offset + 8, offset + 8 + length);
      if (type === CHUNK_JSON) json = new TextDecoder().decode(data);
      else if (type === CHUNK_BIN && bin === null) bin = data.slice();
      offset += 8 + length;
    }
    if (json === null) throw new StripError(`${inputPath}: GLB has no JSON chunk`);
    return { format: "glb", doc: JSON.parse(json), bin };
  }
  return { format: "gltf", doc: JSON.parse(new TextDecoder().decode(u8)), bin: null };
}

function decodeDataUri(uri) {
  const comma = uri.indexOf(",");
  const meta = uri.slice(5, comma);
  const data = uri.slice(comma + 1);
  return /;base64/i.test(meta) ? new Uint8Array(Buffer.from(data, "base64")) : new Uint8Array(Buffer.from(decodeURIComponent(data), "latin1"));
}

/** Resolve every buffer to bytes; `kind` records how to write it back. */
export function loadBuffers(doc, bin, inputPath) {
  return (doc.buffers ?? []).map((buffer, index) => {
    if (buffer.uri === undefined) {
      if (index !== 0 || !bin) throw new StripError(`buffer ${index} has no uri and no GLB BIN chunk`);
      return { kind: "glb", bytes: bin.subarray(0, buffer.byteLength) };
    }
    if (buffer.uri.startsWith("data:")) return { kind: "data", bytes: decodeDataUri(buffer.uri) };
    const file = path.resolve(path.dirname(inputPath), decodeURIComponent(buffer.uri));
    if (!fs.existsSync(file)) throw new StripError(`buffer ${index} file not found: ${file}`);
    return { kind: "file", bytes: new Uint8Array(fs.readFileSync(file)), uri: buffer.uri };
  });
}

function readComponent(view, offset, type) {
  switch (type) {
    case 5120: return view.getInt8(offset);
    case 5121: return view.getUint8(offset);
    case 5122: return view.getInt16(offset, true);
    case 5123: return view.getUint16(offset, true);
    case 5125: return view.getUint32(offset, true);
    case 5126: return view.getFloat32(offset, true);
    default: throw new StripError(`unsupported componentType ${type}`);
  }
}

function forEachViewValue(doc, buffers, viewIndex, byteOffset, count, components, componentType, fn) {
  const bufferView = doc.bufferViews?.[viewIndex];
  if (!bufferView) throw new StripError(`bufferView ${viewIndex} is missing`);
  const bytes = buffers[bufferView.buffer]?.bytes;
  if (!bytes) throw new StripError(`buffer ${bufferView.buffer} is missing`);
  const size = COMPONENT_BYTES[componentType];
  const stride = bufferView.byteStride ?? size * components;
  const base = (bufferView.byteOffset ?? 0) + byteOffset;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let e = 0; e < count; e++) {
    for (let c = 0; c < components; c++) fn(readComponent(view, base + e * stride + c * size, componentType));
  }
}

/** True when every element of the accessor is zero (sparse overlays included). */
export function accessorIsAllZero(doc, buffers, accessorIndex) {
  const accessor = doc.accessors?.[accessorIndex];
  if (!accessor) throw new StripError(`accessor ${accessorIndex} is missing`);
  const components = COMPONENTS[accessor.type];
  let zero = true;
  const check = (value) => { if (value !== 0) zero = false; };
  if (accessor.bufferView !== undefined) {
    forEachViewValue(doc, buffers, accessor.bufferView, accessor.byteOffset ?? 0, accessor.count, components, accessor.componentType, check);
  }
  if (accessor.sparse) {
    const values = accessor.sparse.values;
    forEachViewValue(doc, buffers, values.bufferView, values.byteOffset ?? 0, accessor.sparse.count, components, accessor.componentType, check);
  }
  return zero;
}

/** Every place a glTF document references an accessor; `visit(holder, key)` may rewrite it. */
function accessorRefs(doc, visit) {
  for (const mesh of doc.meshes ?? []) {
    for (const primitive of mesh.primitives ?? []) {
      for (const key of Object.keys(primitive.attributes ?? {})) visit(primitive.attributes, key);
      if (primitive.indices !== undefined) visit(primitive, "indices");
      for (const target of primitive.targets ?? []) for (const key of Object.keys(target)) visit(target, key);
    }
  }
  for (const skin of doc.skins ?? []) if (skin.inverseBindMatrices !== undefined) visit(skin, "inverseBindMatrices");
  for (const animation of doc.animations ?? []) {
    for (const sampler of animation.samplers ?? []) { visit(sampler, "input"); visit(sampler, "output"); }
  }
  for (const node of doc.nodes ?? []) {
    const attributes = node.extensions?.EXT_mesh_gpu_instancing?.attributes;
    for (const key of Object.keys(attributes ?? {})) visit(attributes, key);
  }
}

function bufferViewRefs(doc, visit) {
  for (const accessor of doc.accessors ?? []) {
    if (accessor.bufferView !== undefined) visit(accessor, "bufferView");
    if (accessor.sparse) { visit(accessor.sparse.indices, "bufferView"); visit(accessor.sparse.values, "bufferView"); }
  }
  for (const image of doc.images ?? []) if (image.bufferView !== undefined) visit(image, "bufferView");
  for (const mesh of doc.meshes ?? []) {
    for (const primitive of mesh.primitives ?? []) {
      const draco = primitive.extensions?.KHR_draco_mesh_compression;
      if (draco?.bufferView !== undefined) visit(draco, "bufferView");
    }
  }
}

/** Drop the listed items of `doc[key]` that nothing references any more and renumber the rest. */
function dropUnreferenced(doc, key, candidates, refs) {
  const used = new Set();
  refs(doc, (holder, field) => used.add(holder[field]));
  const drop = [...candidates].filter((index) => !used.has(index));
  if (drop.length === 0) return 0;
  const dropSet = new Set(drop);
  const remap = new Map();
  const kept = [];
  (doc[key] ?? []).forEach((item, index) => {
    if (dropSet.has(index)) return;
    remap.set(index, kept.length);
    kept.push(item);
  });
  doc[key] = kept;
  refs(doc, (holder, field) => { holder[field] = remap.get(holder[field]); });
  return drop.length;
}

/** Rebuild each buffer from the byte ranges its remaining bufferViews cover, keeping 4-byte alignment. */
function compactBuffers(doc, buffers) {
  let saved = 0;
  buffers.forEach((buffer, bufferIndex) => {
    const views = (doc.bufferViews ?? []).filter((view) => view.buffer === bufferIndex);
    const ranges = views.map((view) => [view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength]).sort((a, b) => a[0] - b[0]);
    const merged = [];
    for (const range of ranges) {
      const last = merged[merged.length - 1];
      if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
      else merged.push([...range]);
    }
    const placed = [];
    let cursor = 0;
    for (const [start, end] of merged) {
      cursor += ((start % 4) - (cursor % 4) + 4) % 4; // same offset mod 4 as before, so alignment holds
      placed.push({ start, end, to: cursor });
      cursor += end - start;
    }
    const out = new Uint8Array(cursor);
    for (const { start, end, to } of placed) out.set(buffer.bytes.subarray(start, end), to);
    for (const view of views) {
      const from = view.byteOffset ?? 0;
      const range = placed.find((p) => from >= p.start && from < p.end) ?? placed.find((p) => from === p.start);
      view.byteOffset = range.to + (from - range.start);
    }
    saved += buffer.bytes.byteLength - out.byteLength;
    buffer.bytes = out;
    doc.buffers[bufferIndex].byteLength = out.byteLength;
  });
  return saved;
}

/**
 * Strip extra influence sets from `doc` in place. Returns a summary; `buffers` entries are replaced
 * with compacted bytes.
 */
export function stripExtraSkinSets(doc, buffers, { force = false } = {}) {
  const summary = { stripped: [], keptNonZero: [], forcedNonZero: [], accessorsRemoved: 0, bufferViewsRemoved: 0, bytesSaved: 0, compacted: false, skippedCompaction: null };
  const candidates = new Set();
  (doc.meshes ?? []).forEach((mesh, meshIndex) => {
    (mesh.primitives ?? []).forEach((primitive, primitiveIndex) => {
      const attributes = primitive.attributes ?? {};
      const sets = new Set(Object.keys(attributes).map((k) => EXTRA_SET.exec(k)?.[2]).filter(Boolean));
      for (const n of [...sets].sort((a, b) => Number(a) - Number(b))) {
        const label = `mesh ${meshIndex} primitive ${primitiveIndex} set ${n}`;
        const weights = attributes[`WEIGHTS_${n}`];
        const zero = weights === undefined || accessorIsAllZero(doc, buffers, weights);
        if (!zero && !force) { summary.keptNonZero.push(label); continue; }
        if (!zero) summary.forcedNonZero.push(label);
        summary.stripped.push(label);
        for (const semantic of [`JOINTS_${n}`, `WEIGHTS_${n}`]) {
          if (attributes[semantic] !== undefined) { candidates.add(attributes[semantic]); delete attributes[semantic]; }
        }
      }
    });
  });
  if (summary.stripped.length === 0) return summary;
  const unsafe = [...(doc.extensionsUsed ?? [])].filter((ext) => !COMPACT_SAFE_EXTENSIONS.has(ext));
  if (unsafe.length > 0) {
    summary.skippedCompaction = `extensions ${unsafe.join(", ")} may reference accessors/buffers this tool does not rewrite`;
    return summary;
  }
  const viewCandidates = new Set();
  for (const index of candidates) {
    const accessor = doc.accessors[index];
    if (accessor.bufferView !== undefined) viewCandidates.add(accessor.bufferView);
    if (accessor.sparse) { viewCandidates.add(accessor.sparse.indices.bufferView); viewCandidates.add(accessor.sparse.values.bufferView); }
  }
  // Renumber the view candidates as accessors drop: bufferView indices do not change in this step.
  summary.accessorsRemoved = dropUnreferenced(doc, "accessors", candidates, accessorRefs);
  summary.bufferViewsRemoved = dropUnreferenced(doc, "bufferViews", viewCandidates, bufferViewRefs);
  if (doc.accessors?.length === 0) delete doc.accessors;
  summary.bytesSaved = compactBuffers(doc, buffers);
  summary.compacted = true;
  return summary;
}

function pad4(bytes, fill) {
  const padded = new Uint8Array((bytes.byteLength + 3) & ~3).fill(fill);
  padded.set(bytes);
  return padded;
}

export function encodeGlb(doc, bin) {
  const json = pad4(new TextEncoder().encode(JSON.stringify(doc)), 0x20);
  const binChunk = bin ? pad4(bin, 0) : null;
  const total = 12 + 8 + json.byteLength + (binChunk ? 8 + binChunk.byteLength : 0);
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint32(0, GLB_MAGIC, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, total, true);
  view.setUint32(12, json.byteLength, true);
  view.setUint32(16, CHUNK_JSON, true);
  out.set(json, 20);
  if (binChunk) {
    const at = 20 + json.byteLength;
    view.setUint32(at, binChunk.byteLength, true);
    view.setUint32(at + 4, CHUNK_BIN, true);
    out.set(binChunk, at + 8);
  }
  return out;
}

/** Write buffers back into `doc`; returns the GLB BIN bytes (or null) and external files to write. */
export function finishBuffers(doc, buffers, outputPath) {
  const files = [];
  let bin = null;
  const base = path.basename(outputPath).replace(/\.(gltf|glb)$/i, "");
  const externals = buffers.filter((b) => b.kind === "file").length;
  let externalIndex = 0;
  buffers.forEach((buffer, index) => {
    if (buffer.kind === "glb") bin = buffer.bytes;
    else if (buffer.kind === "data") doc.buffers[index].uri = `data:application/octet-stream;base64,${Buffer.from(buffer.bytes).toString("base64")}`;
    else {
      const name = externals === 1 ? `${base}.bin` : `${base}_${externalIndex}.bin`;
      externalIndex++;
      doc.buffers[index].uri = encodeURIComponent(name);
      files.push({ file: path.join(path.dirname(outputPath), name), bytes: buffer.bytes });
    }
  });
  return { bin, files };
}

export function run(argv, log = console.log, warn = console.error) {
  const flags = new Set(argv.filter((a) => a.startsWith("--")));
  const positional = argv.filter((a) => !a.startsWith("--"));
  const unknown = [...flags].filter((f) => f !== "--force" && f !== "--dry-run");
  if (positional.length !== 2 || unknown.length > 0) {
    warn("usage: node tools/gltf-strip-extra-skin-sets.mjs <input.gltf|input.glb> <output> [--force] [--dry-run]");
    return 2;
  }
  const [input, output] = positional;
  const force = flags.has("--force");
  const dryRun = flags.has("--dry-run");
  try {
    const { format, doc, bin } = parseContainer(fs.readFileSync(input), input);
    if (path.extname(output).toLowerCase() !== `.${format}`) throw new StripError(`output must use the input's format (.${format})`);
    const buffers = loadBuffers(doc, bin, input);
    const summary = stripExtraSkinSets(doc, buffers, { force });
    log(`${input}: stripped ${summary.stripped.length} extra JOINTS_n/WEIGHTS_n set(s)` +
      (summary.compacted ? `; removed ${summary.accessorsRemoved} accessor(s), ${summary.bufferViewsRemoved} bufferView(s), ${summary.bytesSaved} buffer byte(s)` : ""));
    for (const label of summary.stripped) log(`  stripped ${label}`);
    for (const label of summary.forcedNonZero) warn(`warning: --force stripped non-zero weights from ${label}; those influences are lost and WEIGHTS_0 no longer sums to 1 there`);
    for (const label of summary.keptNonZero) warn(`kept ${label}: it carries non-zero weights; rerun with --force to strip it (accuracy loss)`);
    if (summary.skippedCompaction) warn(`warning: attributes removed but buffers not compacted: ${summary.skippedCompaction}`);
    const relativeImages = (doc.images ?? []).some((img) => img.uri && !img.uri.startsWith("data:"));
    if (relativeImages && path.resolve(path.dirname(input)) !== path.resolve(path.dirname(output))) {
      warn("warning: the asset references external images by relative URI; copy them next to the output");
    }
    if (dryRun) log("dry run: nothing written");
    else {
      const { bin: outBin, files } = finishBuffers(doc, buffers, output);
      // Never overwrite the input asset or any external buffer it reads from.
      const protectedPaths = new Set([path.resolve(input), ...buffers.filter((b) => b.kind === "file")
        .map((b) => path.resolve(path.dirname(input), decodeURIComponent(b.uri)))]);
      for (const target of [output, ...files.map((f) => f.file)]) {
        if (protectedPaths.has(path.resolve(target))) throw new StripError(`refusing to overwrite input file ${target}; choose another output name`);
      }
      for (const { file, bytes } of files) fs.writeFileSync(file, bytes);
      fs.writeFileSync(output, format === "glb" ? encodeGlb(doc, outBin) : JSON.stringify(doc, null, 2));
      log(`wrote ${output}`);
    }
    return summary.keptNonZero.length > 0 ? 1 : 0;
  } catch (error) {
    warn(`error: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = run(process.argv.slice(2));
}
