/**
 * One-shot converter: NASA Mars 2020 Perseverance Rover GLB (Draco-compressed, from
 * nasa/NASA-3D-Resources on GitHub — public domain, NASA/JPL-Caltech) → a plain glTF 2.0 GLB the
 * demo's minimal loader can read (no Draco, no KHR_materials_* extras).
 *
 * The source packs all six wheels into one mesh (`Wheels_objs`). The converter splits them out by
 * clustering vertices around their six hub centres and rewrites them as `wheel_FL / ML / RL /
 * FR / MR / RR` nodes with vertices centred on the hub, so `VehicleSystem` can pose each wheel as
 * its own entity (axle along local X, like the box-wheel playground). Everything else is baked
 * into world space (scene-root space) and merged per material.
 *
 * Source download (raw.githubusercontent.com is unreachable from some sandboxes; the contents API
 * with `Accept: application/vnd.github.raw` works):
 *   curl -4 -L -H "Accept: application/vnd.github.raw" \
 *     "https://api.github.com/repos/nasa/NASA-3D-Resources/contents/3D%20Models/Mars%202020%20Perseverance%20Rover/Mars%202020%20Perseverance%20Rover.glb" \
 *     -o /tmp/Mars2020.glb
 *
 * Usage: node scripts/convert-perseverance.mjs [input.glb] [output.glb]
 */
import fs from "node:fs";
import path from "node:path";
import draco3d from "draco3dgltf";

const INPUT = process.argv[2] ?? "/tmp/Mars2020.glb";
const OUTPUT = process.argv[3] ?? "examples/assets/Perseverance.glb";

// ---------------------------------------------------------------- GLB container

function parseGlb(fileBuf) {
  if (fileBuf.toString("ascii", 0, 4) !== "glTF") throw new Error("not a GLB file");
  const total = fileBuf.readUInt32LE(8);
  let off = 12;
  let json = null;
  let bin = null;
  while (off < total) {
    const len = fileBuf.readUInt32LE(off);
    const type = fileBuf.toString("ascii", off + 4, off + 8);
    if (type === "JSON") json = JSON.parse(fileBuf.toString("utf8", off + 8, off + 8 + len));
    else if (type === "BIN\u0000") bin = fileBuf.subarray(off + 8, off + 8 + len);
    off += 8 + len + ((4 - (len % 4)) % 4);
  }
  if (!json || !bin) throw new Error("missing JSON or BIN chunk");
  return { json, bin };
}

function bufferViewSlice(json, bin, index) {
  const bv = json.bufferViews[index];
  const start = bv.byteOffset ?? 0;
  return bin.subarray(start, start + bv.byteLength);
}

// ---------------------------------------------------------------- math (glTF column-major mat4)

function mat4Identity() {
  return new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
}

function mat4Multiply(a, b, out = new Float64Array(16)) {
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      out[c * 4 + r] =
        a[0 * 4 + r] * b[c * 4 + 0] +
        a[1 * 4 + r] * b[c * 4 + 1] +
        a[2 * 4 + r] * b[c * 4 + 2] +
        a[3 * 4 + r] * b[c * 4 + 3];
    }
  }
  return out;
}

function composeNode(node) {
  if (node.matrix) return Float64Array.from(node.matrix);
  const t = node.translation ?? [0, 0, 0];
  const s = node.scale ?? [1, 1, 1];
  const r = node.rotation ?? [0, 0, 0, 1];
  const [x, y, z, w] = r;
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2;
  const yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;
  const m = mat4Identity();
  m[0] = (1 - (yy + zz)) * s[0]; m[1] = (xy + wz) * s[0]; m[2] = (xz - wy) * s[0];
  m[4] = (xy - wz) * s[1]; m[5] = (1 - (xx + zz)) * s[1]; m[6] = (yz + wx) * s[1];
  m[8] = (xz + wy) * s[2]; m[9] = (yz - wx) * s[2]; m[10] = (1 - (xx + yy)) * s[2];
  m[12] = t[0]; m[13] = t[1]; m[14] = t[2];
  return m;
}

function computeWorldMatrices(nodes, roots) {
  const worlds = new Map();
  const walk = (index, parent) => {
    const local = composeNode(nodes[index]);
    const world = parent ? mat4Multiply(parent, local) : local;
    worlds.set(index, world);
    for (const child of nodes[index].children ?? []) walk(child, world);
  };
  for (const root of roots) walk(root, null);
  return worlds;
}

function transformPoint(m, x, y, z, out, o) {
  out[o] = m[0] * x + m[4] * y + m[8] * z + m[12];
  out[o + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
  out[o + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
}

function normalMatrix3(m) {
  // inverse-transpose of the upper-left 3x3.
  const a = m[0], b = m[4], c = m[8];
  const d = m[1], e = m[5], f = m[9];
  const g = m[2], h = m[6], i = m[10];
  const A = e * i - f * h, B = f * g - d * i, C = d * h - e * g;
  let det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-20) det = 1;
  const id = 1 / det;
  // inverse (column-major 3x3 as row-major here), then transpose → rows become columns.
  return [
    A * id, (c * h - b * i) * id, (b * f - c * e) * id,
    B * id, (a * i - c * g) * id, (c * d - a * f) * id,
    C * id, (b * g - a * h) * id, (a * e - b * d) * id,
  ];
}

function transformNormal(nm, x, y, z, out, o) {
  const nx = nm[0] * x + nm[1] * y + nm[2] * z;
  const ny = nm[3] * x + nm[4] * y + nm[5] * z;
  const nz = nm[6] * x + nm[7] * y + nm[8] * z;
  const len = Math.hypot(nx, ny, nz) || 1;
  out[o] = nx / len; out[o + 1] = ny / len; out[o + 2] = nz / len;
}

// ---------------------------------------------------------------- Draco decode

const decoderModule = await draco3d.createDecoderModule();

function decodePrimitive(prim) {
  const ext = prim.extensions?.KHR_draco_mesh_compression;
  if (!ext) throw new Error("primitive without Draco extension (expected all of them)");
  const bytes = bufferViewSlice(gltfJson, gltfBin, ext.bufferView);
  const decoder = new decoderModule.Decoder();
  const buffer = new decoderModule.DecoderBuffer();
  const dracoMesh = new decoderModule.Mesh();
  try {
    buffer.Init(new Int8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength), bytes.byteLength);
    const status = decoder.DecodeBufferToMesh(buffer, dracoMesh);
    if (!status.ok()) throw new Error(`draco decode failed: ${status.error_msg()}`);
    decoderModule.destroy(status);
    const numPoints = dracoMesh.num_points();
    const numFaces = dracoMesh.num_faces();

    const out = { count: numPoints, indices: new Uint32Array(numFaces * 3), attrs: new Map() };
    const tri = new decoderModule.DracoInt32Array();
    try {
      for (let f = 0; f < numFaces; f++) {
        decoder.GetFaceFromMesh(dracoMesh, f, tri);
        out.indices[f * 3] = tri.GetValue(0);
        out.indices[f * 3 + 1] = tri.GetValue(1);
        out.indices[f * 3 + 2] = tri.GetValue(2);
      }
    } finally {
      decoderModule.destroy(tri);
    }
    for (const [semantic, uniqueId] of Object.entries(ext.attributes)) {
      if (semantic !== "POSITION" && semantic !== "NORMAL" && semantic !== "TEXCOORD_0") continue;
      const att = decoder.GetAttributeByUniqueId(dracoMesh, uniqueId);
      const comps = att.num_components();
      const byteLength = numPoints * comps * 4;
      const ptr = decoderModule._malloc(byteLength);
      try {
        if (!decoder.GetAttributeDataArrayForAllPoints(dracoMesh, att, decoderModule.DT_FLOAT32, byteLength, ptr)) {
          throw new Error(`draco attribute read failed for ${semantic}`);
        }
        out.attrs.set(semantic, { comps, arr: new Float32Array(decoderModule.HEAPF32.buffer, ptr, numPoints * comps).slice() });
      } finally {
        decoderModule._free(ptr);
      }
    }
    return out;
  } finally {
    decoderModule.destroy(dracoMesh);
    decoderModule.destroy(buffer);
    decoderModule.destroy(decoder);
  }
}

// ---------------------------------------------------------------- load + bake

if (!fs.existsSync(INPUT)) {
  console.error(`input not found: ${INPUT}\nsee the header of this script for the download command`);
  process.exit(1);
}

const { json: gltfJson, bin: gltfBin } = parseGlb(fs.readFileSync(INPUT));
const worlds = computeWorldMatrices(gltfJson.nodes, gltfJson.scenes[gltfJson.scene ?? 0].nodes);

const WHEEL_NODE = gltfJson.nodes.findIndex((n) => n.name === "Wheels_objs");
if (WHEEL_NODE < 0) throw new Error("Wheels_objs node not found");
const hasWheelNode = (i) => i === WHEEL_NODE;

/** Decode node → mesh → primitives, bake to world space. Returns per-prim arrays. */
function bakeNodePrimitives(nodeIndex) {
  const node = gltfJson.nodes[nodeIndex];
  const world = worlds.get(nodeIndex);
  const nm = normalMatrix3(world);
  const mesh = gltfJson.meshes[node.mesh];
  const prims = [];
  for (const prim of mesh.primitives) {
    if (prim.mode !== undefined && prim.mode !== 4) continue;
    const decoded = decodePrimitive(prim);
    const pos = decoded.attrs.get("POSITION");
    const nrm = decoded.attrs.get("NORMAL");
    const uv = decoded.attrs.get("TEXCOORD_0");
    if (!pos || pos.comps !== 3) throw new Error("POSITION missing or not VEC3");
    const n = decoded.count;
    const positions = new Float32Array(n * 3);
    const normals = new Float32Array(n * 3);
    const uvs = uv ? new Float32Array(n * 2) : null;
    for (let i = 0; i < n; i++) {
      transformPoint(world, pos.arr[i * 3], pos.arr[i * 3 + 1], pos.arr[i * 3 + 2], positions, i * 3);
      if (nrm) transformNormal(nm, nrm.arr[i * 3], nrm.arr[i * 3 + 1], nrm.arr[i * 3 + 2], normals, i * 3);
    }
    if (uvs && uv) {
      if (uv.comps !== 2) throw new Error("TEXCOORD_0 not VEC2");
      uvs.set(uv.arr);
    }
    prims.push({
      material: prim.material ?? 0,
      positions,
      normals,
      uvs: uvs ?? new Float32Array(n * 2), // flat uv keeps one vertex layout
      indices: decoded.indices,
      count: n,
      hasNormals: !!nrm,
    });
  }
  return prims;
}

// ---- body: every mesh node except the wheel node, merged per material.
const bodyByMaterial = new Map();
let bodyPrimCount = 0;
for (let i = 0; i < gltfJson.nodes.length; i++) {
  const node = gltfJson.nodes[i];
  if (node.mesh === undefined || hasWheelNode(i)) continue;
  for (const prim of bakeNodePrimitives(i)) {
    bodyPrimCount++;
    let slot = bodyByMaterial.get(prim.material);
    if (!slot) {
      slot = { positions: [], normals: [], uvs: [], indices: [], count: 0, material: prim.material };
      bodyByMaterial.set(prim.material, slot);
    }
    for (let v = 0; v < prim.positions.length; v++) slot.positions.push(prim.positions[v]);
    for (let v = 0; v < prim.normals.length; v++) slot.normals.push(prim.normals[v]);
    for (let v = 0; v < prim.uvs.length; v++) slot.uvs.push(prim.uvs[v]);
    for (let v = 0; v < prim.indices.length; v++) slot.indices.push(prim.indices[v] + slot.count);
    slot.count += prim.count;
  }
}

// ---- wheels: decode the wheel node, cluster verts around the six hubs.
const wheelPrims = bakeNodePrimitives(WHEEL_NODE);
const totalWheelVerts = wheelPrims.reduce((s, p) => s + p.count, 0);

/** 3-means on Z (front / mid / rear axles), then split each cluster by the X sign. */
function clusterWheels(prims) {
  const zs = [];
  for (const p of prims) for (let i = 0; i < p.count; i++) zs.push(p.positions[i * 3 + 2]);
  zs.sort((a, b) => a - b);
  let seeds = [zs[Math.floor(zs.length * 0.9)], zs[Math.floor(zs.length * 0.5)], zs[Math.floor(zs.length * 0.1)]];
  const assignZ = new Int32Array(zs.length);
  for (let iter = 0; iter < 40; iter++) {
    for (let i = 0; i < zs.length; i++) {
      let best = 0;
      for (let k = 1; k < 3; k++) if (Math.abs(zs[i] - seeds[k]) < Math.abs(zs[i] - seeds[best])) best = k;
      assignZ[i] = best;
    }
    const sums = [0, 0, 0], counts = [0, 0, 0];
    for (let i = 0; i < zs.length; i++) { sums[assignZ[i]] += zs[i]; counts[assignZ[i]]++; }
    for (let k = 0; k < 3; k++) if (counts[k]) seeds[k] = sums[k] / counts[k];
  }
  // Order front → rear: front has the highest Z (+Z is the rover's nose). Rank the converged
  // seeds explicitly so the axle→name mapping holds even if a k-means run drifts the clusters
  // out of their initial order (silently mislabelled wheels pose at the wrong hubs).
  const axleOrder = [0, 1, 2].sort((a, b) => seeds[b] - seeds[a]);
  const axleRank = new Array(3);
  axleOrder.forEach((axle, rank) => { axleRank[axle] = rank; }); // 0 front, 1 middle, 2 rear

  // Bucket every vertex (across prims) into one of 6 clusters: axle × side.
  const clusterOfPrimVert = prims.map((p) => {
    const arr = new Int32Array(p.count);
    for (let i = 0; i < p.count; i++) {
      const x = p.positions[i * 3], z = p.positions[i * 3 + 2];
      let axle = 0, best = Infinity;
      for (let k = 0; k < 3; k++) { const d = Math.abs(z - seeds[k]); if (d < best) { best = d; axle = k; } }
      const side = x < 0 ? 0 : 1; // -X = left
      arr[i] = axleRank[axle] * 2 + side; // 0 FL, 1 FR, 2 ML, 3 MR, 4 RL, 5 RR
    }
    return arr;
  });

  // Hub centres = per-cluster centroids.
  const sums = Array.from({ length: 6 }, () => [0, 0, 0, 0]);
  for (let c = 0; c < prims.length; c++) {
    const p = prims[c], assign = clusterOfPrimVert[c];
    for (let i = 0; i < p.count; i++) {
      const s = sums[assign[i]];
      s[0] += p.positions[i * 3]; s[1] += p.positions[i * 3 + 1]; s[2] += p.positions[i * 3 + 2]; s[3]++;
    }
  }
  const hubs = sums.map((s) => (s[3] ? [s[0] / s[3], s[1] / s[3], s[2] / s[3]] : [0, 0, 0]));

  // Split each prim per cluster: re-index, recentre on the hub.
  const perWheel = Array.from({ length: 6 }, () => []);
  for (let c = 0; c < prims.length; c++) {
    const p = prims[c], assign = clusterOfPrimVert[c];
    const vertCounts = new Array(6).fill(0);
    for (let i = 0; i < p.count; i++) vertCounts[assign[i]]++;
    const base = new Array(6).fill(0);
    for (let k = 1; k < 6; k++) base[k] = base[k - 1] + vertCounts[k - 1];
    const localIndex = new Int32Array(p.count);
    const outPos = new Float32Array(p.count * 3);
    const outNrm = new Float32Array(p.count * 3);
    const outUv = new Float32Array(p.count * 2);
    const buckets = Array.from({ length: 6 }, () => ({ indices: [], prim: c, count: 0 }));
    const cursor = new Array(6).fill(0);
    const globalBase = base.slice();
    for (let i = 0; i < p.count; i++) {
      const k = assign[i];
      const local = cursor[k]++;
      localIndex[i] = globalBase[k] + local;
      const dst = (globalBase[k] + local) * 3;
      outPos[dst] = p.positions[i * 3] - hubs[k][0];
      outPos[dst + 1] = p.positions[i * 3 + 1] - hubs[k][1];
      outPos[dst + 2] = p.positions[i * 3 + 2] - hubs[k][2];
      outNrm[dst] = p.normals[i * 3];
      outNrm[dst + 1] = p.normals[i * 3 + 1];
      outNrm[dst + 2] = p.normals[i * 3 + 2];
      outUv[(globalBase[k] + local) * 2] = p.uvs[i * 2];
      outUv[(globalBase[k] + local) * 2 + 1] = p.uvs[i * 2 + 1];
    }
    for (let f = 0; f < p.indices.length; f += 3) {
      const k = assign[p.indices[f]];
      const b = buckets[k];
      const base = globalBase[k];
      // Each per-wheel slice is emitted as its own mesh with a 0-based vertex array, so the
      // packed (global) indices must be rebased. Skipping the `- base` shipped once as "only
      // wheel_FL visible": every other wheel's indices pointed past its own vertices and the GPU
      // discarded the lot with no error. Triangles never span wheels (metres of air between the
      // hubs) — fail loudly instead of emitting cross-cluster indices if one ever does.
      for (let corner = 0; corner < 3; corner++) {
        if (assign[p.indices[f + corner]] !== k) {
          throw new Error(`cross-wheel triangle in wheel prim ${c}: corners span clusters, cannot split`);
        }
      }
      b.indices.push(localIndex[p.indices[f]] - base, localIndex[p.indices[f + 1]] - base, localIndex[p.indices[f + 2]] - base);
    }
    for (let k = 0; k < 6; k++) {
      if (!buckets[k].indices.length) continue;
      const count = vertCounts[k];
      perWheel[k].push({
        material: p.material,
        positions: outPos.subarray(globalBase[k] * 3, (globalBase[k] + count) * 3),
        normals: outNrm.subarray(globalBase[k] * 3, (globalBase[k] + count) * 3),
        uvs: outUv.subarray(globalBase[k] * 2, (globalBase[k] + count) * 2),
        indices: Uint32Array.from(buckets[k].indices),
        count,
        hasNormals: true,
      });
    }
  }
  return { hubs, perWheel, seeds };
}

const { hubs, perWheel, seeds: axleZ } = clusterWheels(wheelPrims);

const WHEEL_NAMES = ["wheel_FL", "wheel_FR", "wheel_ML", "wheel_MR", "wheel_RL", "wheel_RR"];

// ---------------------------------------------------------------- pack a plain GLB

const binChunks = [];
let binLength = 0;
function pushBytes(bytes, align = 4) {
  const pad = (align - (binLength % align)) % align;
  if (pad) { binChunks.push(new Uint8Array(pad)); binLength += pad; }
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  binChunks.push(view);
  const start = binLength;
  binLength += view.byteLength;
  return start;
}

const outJson = {
  asset: { version: "2.0", generator: "forge-convert-perseverance (plain glTF for @forge demos)" },
  scene: 0,
  scenes: [{ nodes: [] }],
  nodes: [],
  meshes: [],
  materials: [],
  textures: [],
  images: [],
  accessors: [],
  bufferViews: [],
  buffers: [{ byteLength: 0 }],
};

// Materials: copy the core fields only (drop KHR_materials_* extensions).
const materialMap = new Map(); // src index → dst index
function copyMaterial(srcIndex) {
  if (materialMap.has(srcIndex)) return materialMap.get(srcIndex);
  const src = gltfJson.materials[srcIndex];
  const dst = { name: src.name ?? `material_${srcIndex}`, doubleSided: true };
  const pbr = {};
  if (src.pbrMetallicRoughness?.baseColorFactor) pbr.baseColorFactor = [...src.pbrMetallicRoughness.baseColorFactor];
  pbr.metallicFactor = src.pbrMetallicRoughness?.metallicFactor ?? 1;
  pbr.roughnessFactor = src.pbrMetallicRoughness?.roughnessFactor ?? 1;
  if (src.pbrMetallicRoughness?.baseColorTexture)
    pbr.baseColorTexture = { index: copyTexture(src.pbrMetallicRoughness.baseColorTexture.index) };
  if (src.pbrMetallicRoughness?.metallicRoughnessTexture)
    pbr.metallicRoughnessTexture = { index: copyTexture(src.pbrMetallicRoughness.metallicRoughnessTexture.index) };
  dst.pbrMetallicRoughness = pbr;
  if (src.normalTexture) dst.normalTexture = { index: copyTexture(src.normalTexture.index) };
  const index = outJson.materials.length;
  outJson.materials.push(dst);
  materialMap.set(srcIndex, index);
  return index;
}

const textureMap = new Map();
function copyTexture(srcIndex) {
  if (textureMap.has(srcIndex)) return textureMap.get(srcIndex);
  const src = gltfJson.textures[srcIndex];
  // EXT_texture_webp carries the WebP source with a PNG/JPEG fallback `source`; prefer WebP.
  const imageSrc = src.extensions?.EXT_texture_webp?.source ?? src.source;
  const image = gltfJson.images[imageSrc];
  const bytes = bufferViewSlice(gltfJson, gltfBin, image.bufferView);
  const start = pushBytes(bytes);
  const dstImage = { mimeType: image.mimeType, bufferView: outJson.bufferViews.length, byteLength: bytes.byteLength };
  outJson.bufferViews.push({ buffer: 0, byteOffset: start, byteLength: bytes.byteLength });
  outJson.images.push(dstImage);
  const dstIndex = outJson.textures.length;
  outJson.textures.push({ source: outJson.images.length - 1 });
  textureMap.set(srcIndex, dstIndex);
  return dstIndex;
}

/** Write one merged/centred primitive as a mesh; returns the mesh index. */
function addMesh(slot, name) {
  const positions = slot.positions instanceof Float32Array ? slot.positions : Float32Array.from(slot.positions);
  const normals = slot.normals instanceof Float32Array ? slot.normals : Float32Array.from(slot.normals);
  const uvs = slot.uvs instanceof Float32Array ? slot.uvs : Float32Array.from(slot.uvs);
  const indices = slot.indices instanceof Uint32Array ? slot.indices : Uint32Array.from(slot.indices);

  const posStart = pushBytes(positions.buffer.slice(positions.byteOffset, positions.byteOffset + positions.byteLength));
  outJson.bufferViews.push({ buffer: 0, byteOffset: posStart, byteLength: positions.byteLength });
  const posView = outJson.bufferViews.length - 1;
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    for (let c = 0; c < 3; c++) {
      if (positions[i + c] < min[c]) min[c] = positions[i + c];
      if (positions[i + c] > max[c]) max[c] = positions[i + c];
    }
  }
  outJson.accessors.push({ bufferView: posView, componentType: 5126, count: positions.length / 3, type: "VEC3", min, max });

  const nrmStart = pushBytes(normals.buffer.slice(normals.byteOffset, normals.byteOffset + normals.byteLength));
  outJson.bufferViews.push({ buffer: 0, byteOffset: nrmStart, byteLength: normals.byteLength });
  outJson.accessors.push({ bufferView: outJson.bufferViews.length - 1, componentType: 5126, count: normals.length / 3, type: "VEC3" });

  const uvStart = pushBytes(uvs.buffer.slice(uvs.byteOffset, uvs.byteOffset + uvs.byteLength));
  outJson.bufferViews.push({ buffer: 0, byteOffset: uvStart, byteLength: uvs.byteLength });
  outJson.accessors.push({ bufferView: outJson.bufferViews.length - 1, componentType: 5126, count: uvs.length / 2, type: "VEC2" });

  const idxStart = pushBytes(indices.buffer.slice(indices.byteOffset, indices.byteOffset + indices.byteLength));
  outJson.bufferViews.push({ buffer: 0, byteOffset: idxStart, byteLength: indices.byteLength });
  outJson.accessors.push({ bufferView: outJson.bufferViews.length - 1, componentType: 5125, count: indices.length, type: "SCALAR" });

  const meshIndex = outJson.meshes.length;
  outJson.meshes.push({
    name,
    primitives: [
      {
        attributes: { POSITION: outJson.accessors.length - 4, NORMAL: outJson.accessors.length - 3, TEXCOORD_0: outJson.accessors.length - 2 },
        indices: outJson.accessors.length - 1,
        material: copyMaterial(slot.material ?? slot.materialIndex ?? 0),
        mode: 4,
      },
    ],
  });
  return meshIndex;
}

// Body meshes (one per material) as identity nodes.
for (const [srcMat, slot] of [...bodyByMaterial.entries()].sort((a, b) => a[0] - b[0])) {
  slot.material = srcMat;
  const meshIndex = addMesh(slot, `body_${gltfJson.materials[srcMat].name ?? srcMat}`);
  const nodeIndex = outJson.nodes.length;
  outJson.nodes.push({ name: `body_${gltfJson.materials[srcMat].name ?? srcMat}`, mesh: meshIndex });
  outJson.scenes[0].nodes.push(nodeIndex);
}

// Wheel roots: hub-centred children under a node translated to the hub (assembled model pose);
// the demo ignores the root translation and poses the root entity itself.
for (let w = 0; w < 6; w++) {
  const children = [];
  for (const slot of perWheel[w]) {
    const meshIndex = addMesh(slot, `${WHEEL_NAMES[w]}_${gltfJson.materials[slot.material]?.name ?? slot.material}`);
    const nodeIndex = outJson.nodes.length;
    outJson.nodes.push({ name: `${WHEEL_NAMES[w]}_part`, mesh: meshIndex });
    children.push(nodeIndex);
  }
  const rootIndex = outJson.nodes.length;
  outJson.nodes.push({
    name: WHEEL_NAMES[w],
    translation: [hubs[w][0], hubs[w][1], hubs[w][2]],
    children,
  });
  outJson.scenes[0].nodes.push(rootIndex);
}

// Finalise the BIN chunk.
const binBytes = new Uint8Array(binLength);
let cursor = 0;
for (const part of binChunks) { binBytes.set(part, cursor); cursor += part.byteLength; }
outJson.buffers[0].byteLength = binLength;

const jsonBytes = Buffer.from(JSON.stringify(outJson), "utf8");
const jsonPad = (4 - (jsonBytes.length % 4)) % 4;
const binPad = (4 - (binBytes.length % 4)) % 4;
const jsonLen = jsonBytes.length + jsonPad;
const binLen = binBytes.length + binPad;
const totalLength = 12 + 8 + jsonLen + 8 + binLen;

const out = Buffer.alloc(totalLength);
out.write("glTF", 0, "ascii");
out.writeUInt32LE(2, 4);
out.writeUInt32LE(totalLength, 8);
out.writeUInt32LE(jsonLen, 12);
out.write("JSON", 16, "ascii");
jsonBytes.copy(out, 20);
out.writeUInt32LE(binLen, 20 + jsonLen);
out.write("BIN\u0000", 24 + jsonLen, "ascii");
Buffer.from(binBytes).copy(out, 28 + jsonLen);

fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
fs.writeFileSync(OUTPUT, out);

const report = {
  output: OUTPUT,
  bytes: totalLength,
  bodyPrims: bodyPrimCount,
  bodyMeshes: bodyByMaterial.size,
  wheelVerts: totalWheelVerts,
  axleSeedsZ: axleZ.map((z) => Number(z.toFixed(4))),
  hubs: Object.fromEntries(WHEEL_NAMES.map((n, i) => [n, hubs[i].map((v) => Number(v.toFixed(4)))])),
  wheelMeshes: perWheel.map((w) => w.length),
  materials: outJson.materials.length,
  images: outJson.images.length,
  textures: outJson.textures.length,
  meshes: outJson.meshes.length,
  tris: outJson.meshes.reduce((s, m) => s + outJson.accessors[m.primitives[0].indices].count / 3, 0),
};
console.log(JSON.stringify(report, null, 2));
