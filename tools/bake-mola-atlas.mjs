#!/usr/bin/env node
/**
 * tools/bake-mola-atlas.mjs — OFFLINE bake of the MOLA global DEM into the Mars height atlas.
 *
 * Not part of CI or any npm script that runs in CI: it needs the 2.1 GB source GeoTIFF
 * (`Mars_MGS_MOLA_DEM_mosaic_global_463m.tif`, USGS Astrogeology, 463 m/px, int16 metres above the MOLA
 * areoid, equirectangular, uncompressed strips, -180..180 / +90..-90, nodata -32768) and ~3 GB of RAM.
 * Its *output* (`examples/public/mars/mola/`) is what is committed.
 *
 *   npx tsx tools/bake-mola-atlas.mjs --input /path/to/Mars_MGS_MOLA_DEM_mosaic_global_463m.tif \
 *        [--out examples/public/mars/mola] [--sizes phone,tablet,desktop] [--check]
 *
 * What it does (see docs/MARS-TERRAIN.md "Real elevation"):
 *  1. Reads the TIFF header (so nothing is assumed about strips/geotransform) and the raw int16 raster.
 *  2. Builds a box-filter pyramid (levels 2..6) so each atlas node can be sampled band-limited.
 *  3. For every node of every cube face — evaluated with the engine's own `marsFaceUVToDirection`, the
 *     same spherified-cube warp the runtime uses, and including a one-texel apron on the extended
 *     chart — averages a k x k grid of bilinear taps spread over the node's footprint, from the pyramid
 *     level matching the tap spacing (no aliasing from 463 m data into 2-10 km nodes).
 *  4. Makes the nodes shared by two or three faces (cube edges and corners) identical.
 *  5. Quantises to 16 bits over [MIN_M, MAX_M], applies the predictor/byte-split filter, gzips (level 9),
 *     writes `<size>/face<N>.bin` and a `manifest.json` with sizes, hashes and the source description.
 *  6. Reads the result back through the runtime `MarsHeightAtlas` and prints known features.
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { marsFaceUVToDirection, MARS_FACE_COUNT } from "../engine/src/terrain/mars/cubeSphere.ts";
import { marsAtlasFilter, marsAtlasQuantize, MarsHeightAtlas, marsAtlasUnfilter } from "../engine/src/terrain/mars/heightAtlas.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SIZES = { phone: 512, tablet: 1024, desktop: 2048 };
const MIN_M = -8200; // MOLA global min is -8142 m
const MAX_M = 21200; // MOLA global max is +21160 m (Olympus Mons)
const APRON = 1;
const MOLA_RADIUS_M = 3396190;

const args = new Map();
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith("--")) {
    const next = process.argv[i + 1];
    if (next && !next.startsWith("--")) { args.set(a.slice(2), next); i++; } else args.set(a.slice(2), "1");
  }
}
const input = args.get("input");
if (!input) { console.error("usage: tsx tools/bake-mola-atlas.mjs --input <Mars_MGS_MOLA_DEM_mosaic_global_463m.tif> [--out dir] [--sizes a,b] [--check]"); process.exit(2); }
const outDir = path.resolve(ROOT, args.get("out") ?? "examples/public/mars/mola");
const sizeNames = (args.get("sizes") ?? "phone,tablet,desktop").split(",").map((s) => s.trim());
for (const n of sizeNames) if (!SIZES[n]) { console.error(`unknown size ${n}`); process.exit(2); }

// ---------------------------------------------------------------------------------- TIFF reader

function readTiff(file) {
  const fd = fs.openSync(file, "r");
  const head = Buffer.alloc(8);
  fs.readSync(fd, head, 0, 8, 0);
  if (head.toString("latin1", 0, 2) !== "II" || head.readUInt16LE(2) !== 42) throw new Error("expected a little-endian classic TIFF");
  const ifd = head.readUInt32LE(4);
  const nbuf = Buffer.alloc(2);
  fs.readSync(fd, nbuf, 0, 2, ifd);
  const n = nbuf.readUInt16LE(0);
  const ents = Buffer.alloc(n * 12);
  fs.readSync(fd, ents, 0, n * 12, ifd + 2);
  const TYPE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 12: 8, 16: 8 };
  const tags = new Map();
  for (let i = 0; i < n; i++) {
    const tag = ents.readUInt16LE(i * 12), type = ents.readUInt16LE(i * 12 + 2), count = ents.readUInt32LE(i * 12 + 4);
    const size = (TYPE[type] ?? 1) * count;
    let raw;
    if (size <= 4) raw = ents.subarray(i * 12 + 8, i * 12 + 8 + size);
    else { raw = Buffer.alloc(size); fs.readSync(fd, raw, 0, size, ents.readUInt32LE(i * 12 + 8)); }
    let value;
    if (type === 3) value = Array.from({ length: count }, (_, k) => raw.readUInt16LE(k * 2));
    else if (type === 4) value = Array.from({ length: count }, (_, k) => raw.readUInt32LE(k * 4));
    else if (type === 12) value = Array.from({ length: count }, (_, k) => raw.readDoubleLE(k * 8));
    else if (type === 2) value = raw.toString("latin1").replace(/\0.*$/s, "");
    else value = Array.from(raw);
    tags.set(tag, value);
  }
  const W = tags.get(256)[0], H = tags.get(257)[0];
  const bits = tags.get(258)[0], comp = tags.get(259)[0], spp = (tags.get(277) ?? [1])[0];
  const fmt = (tags.get(339) ?? [1])[0];
  const rps = (tags.get(278) ?? [H])[0];
  if (bits !== 16 || fmt !== 2 || comp !== 1 || spp !== 1 || tags.has(322)) throw new Error(`unsupported TIFF: bits ${bits} fmt ${fmt} compression ${comp} spp ${spp}`);
  const offsets = tags.get(273), counts = tags.get(279);
  const scale = tags.get(33550), tie = tags.get(33922);
  const nodata = tags.has(42113) ? Number(tags.get(42113)) : null;
  // Geotransform → degrees: x = tie.x + col * scale.x metres on a sphere of the GeoKey radius.
  // The raster is global and symmetric about lon 0 / the equator (checked to within one pixel below), so
  // the degrees-per-pixel come from the pixel counts and not from the (slightly inconsistent) GeoKey radius.
  const radius = tags.get(34736)?.[5] ?? MOLA_RADIUS_M;
  const globalX = Math.abs(tie[3] + (W * scale[0]) / 2) < scale[0] && Math.abs(tie[4] - (H * scale[1]) / 2) < scale[1];
  if (!globalX) throw new Error("expected a global raster symmetric about lon 0 / the equator");
  const info = { W, H, west: -180, north: 90, dLon: 360 / W, dLat: 180 / H, radius, nodata, metresPerPixel: scale[0], rowsPerStrip: rps };
  const data = new Int16Array(W * H);
  const bytes = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  let at = 0;
  for (let s = 0; s < offsets.length; s++) {
    const len = counts[s];
    let done = 0;
    while (done < len) { // chunked: a single readSync is capped at 2 GiB
      const got = fs.readSync(fd, bytes, at + done, Math.min(len - done, 1 << 28), offsets[s] + done);
      if (got <= 0) throw new Error("short read");
      done += got;
    }
    at += len;
  }
  fs.closeSync(fd);
  if (at !== W * H * 2) throw new Error(`strips cover ${at} bytes, expected ${W * H * 2}`);
  return { info, data };
}

// ------------------------------------------------------------------------------------ pyramid

function boxDown(src, W, H, f) { // f x f box average of an Int16Array/Float32Array -> Float32Array
  const w = Math.floor(W / f), h = Math.floor(H / f);
  const out = new Float32Array(w * h);
  const inv = 1 / (f * f);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let j = 0; j < f; j++) { const row = (y * f + j) * W + x * f; for (let i = 0; i < f; i++) s += src[row + i]; }
      out[y * w + x] = s * inv;
    }
  }
  return { data: out, W: w, H: h };
}

function buildPyramid(l0, W, H) {
  const levels = new Map();
  levels.set(0, { data: l0, W, H });
  const l2 = boxDown(l0, W, H, 4); levels.set(2, l2);
  for (const L of [3, 4, 5, 6]) { const p = levels.get(L === 3 ? 2 : L - 1); levels.set(L, boxDown(p.data, p.W, p.H, 2)); }
  return levels;
}

// ---------------------------------------------------------------------------------- the bake

function bake(size, info, pyramid) {
  const res = SIZES[size];
  const stored = res + 2 * APRON;
  const faces = [];
  const t0 = Date.now();
  const levelKeys = [...pyramid.keys()].sort((a, b) => a - b);
  const { W, H, west, north, dLon, dLat } = info;
  // Source pixel (level pixel units) of a direction.
  const sampleLevel = (L, lonDeg, latDeg) => {
    const lv = pyramid.get(L);
    const f = 1 << L;
    let x = ((lonDeg - west) / dLon) / f - 0.5;
    let y = ((north - latDeg) / dLat) / f - 0.5;
    const x0 = Math.floor(x), y0 = Math.floor(y);
    const tx = x - x0, ty = y - y0;
    const ya = y0 < 0 ? 0 : y0 >= lv.H ? lv.H - 1 : y0, yb = y0 + 1 < 0 ? 0 : y0 + 1 >= lv.H ? lv.H - 1 : y0 + 1;
    const xa = ((x0 % lv.W) + lv.W) % lv.W, xb = (xa + 1) % lv.W;
    const d = lv.data;
    const a = d[ya * lv.W + xa] * (1 - tx) + d[ya * lv.W + xb] * tx;
    const b = d[yb * lv.W + xa] * (1 - tx) + d[yb * lv.W + xb] * tx;
    return a * (1 - ty) + b * ty;
  };
  const step = 2 / (res - 1);
  const RAD = 180 / Math.PI;
  for (let face = 0; face < MARS_FACE_COUNT; face++) {
    const h = new Float32Array(stored * stored);
    for (let j = 0; j < stored; j++) {
      const v = -1 + (j - APRON) * step;
      for (let i = 0; i < stored; i++) {
        const u = -1 + (i - APRON) * step;
        const c = marsFaceUVToDirection(face, u, v);
        const lat = Math.asin(Math.max(-1, Math.min(1, c.y))) * RAD;
        const cosLat = Math.max(0.02, Math.cos(lat / RAD));
        // Footprint of this node in source pixels (lat direction is true scale; lon is stretched by 1/cos).
        const du = marsFaceUVToDirection(face, u + step, v), dv = marsFaceUVToDirection(face, u, v + step);
        const ang = Math.max(Math.acos(Math.min(1, c.x * du.x + c.y * du.y + c.z * du.z)), Math.acos(Math.min(1, c.x * dv.x + c.y * dv.y + c.z * dv.z)));
        const fpPx = (ang * info.radius) / info.metresPerPixel;
        const k = Math.abs(lat) > 75 ? 8 : 4;
        const target = Math.log2(Math.max(1, fpPx / k));
        let L = 0;
        for (const key of levelKeys) if (key <= target + 0.25) L = key;
        let sum = 0;
        for (let sj = 0; sj < k; sj++) {
          const vs = v + ((sj + 0.5) / k - 0.5) * step;
          for (let si = 0; si < k; si++) {
            const us = u + ((si + 0.5) / k - 0.5) * step;
            const d = marsFaceUVToDirection(face, us, vs);
            const la = Math.asin(Math.max(-1, Math.min(1, d.y))) * RAD;
            let lo = Math.atan2(d.z, d.x) * RAD;
            sum += sampleLevel(L, lo, la);
          }
        }
        h[j * stored + i] = sum / (k * k);
      }
    }
    faces.push(h);
    process.stdout.write(`  ${size} face ${face} baked (${((Date.now() - t0) / 1000).toFixed(0)} s)\n`);
  }
  // Nodes shared by faces (cube edges/corners) must be one value: average the duplicates.
  const groups = new Map();
  for (let face = 0; face < MARS_FACE_COUNT; face++) {
    for (let j = 0; j < res; j++) {
      for (let i = 0; i < res; i++) {
        if (i !== 0 && j !== 0 && i !== res - 1 && j !== res - 1) continue;
        const d = marsFaceUVToDirection(face, -1 + i * step, -1 + j * step);
        const key = `${Math.round(d.x * 1e7)},${Math.round(d.y * 1e7)},${Math.round(d.z * 1e7)}`;
        let g = groups.get(key);
        if (!g) groups.set(key, (g = []));
        g.push([face, (j + APRON) * stored + (i + APRON)]);
      }
    }
  }
  let maxEdgeDiff = 0;
  for (const g of groups.values()) {
    if (g.length < 2) continue;
    let s = 0, lo = Infinity, hi = -Infinity;
    for (const [f, idx] of g) { const x = faces[f][idx]; s += x; lo = Math.min(lo, x); hi = Math.max(hi, x); }
    maxEdgeDiff = Math.max(maxEdgeDiff, hi - lo);
    const m = s / g.length;
    for (const [f, idx] of g) faces[f][idx] = m;
  }
  console.log(`  ${size}: shared-edge nodes merged (${groups.size} unique, worst pre-merge disagreement ${maxEdgeDiff.toFixed(1)} m)`);
  return { res, stored, faces };
}

function encode(size, baked, dir) {
  const { res, stored, faces } = baked;
  fs.mkdirSync(path.join(dir, size), { recursive: true });
  const entries = [];
  let total = 0;
  const qFaces = [];
  for (let f = 0; f < faces.length; f++) {
    const q = new Uint16Array(stored * stored);
    for (let i = 0; i < q.length; i++) q[i] = marsAtlasQuantize(faces[f][i], MIN_M, MAX_M);
    qFaces.push(q);
    const gz = zlib.gzipSync(Buffer.from(marsAtlasFilter(q, stored)), { level: 9, mtime: 0 });
    const file = `${size}/face${f}.bin`;
    fs.writeFileSync(path.join(dir, file), gz);
    entries.push({ file, bytes: gz.length, sha256: crypto.createHash("sha256").update(gz).digest("hex") });
    total += gz.length;
  }
  const nodeSpacingM = Math.round(((Math.PI / 2) * MOLA_RADIUS_M) / (res - 1));
  console.log(`  ${size}: ${res}² per face, ${(total / 1e6).toFixed(2)} MB gzip (${entries.map((e) => (e.bytes / 1e6).toFixed(2)).join(" / ")})`);
  return { entry: { res, stored, nodeSpacingM, faces: entries, totalBytes: total }, qFaces };
}

// ------------------------------------------------------------------------------------ verify

// Known features, as windows (lat0, lat1, lon0, lon1 east-positive) searched on the *baked* atlas through
// the runtime sampler. The expected bands are wide enough for a 10 km phone node to smooth a summit and
// narrow enough that a flipped/shifted/transposed face fails. Reference (full-resolution GeoTIFF):
// Olympus Mons +21241 m at 17.3N 226.6E; Hellas floor -8194 m; Valles Marineris -5717 m at 14.4S 302.2E;
// Elysium Mons +14071 m at 24.7N 146.7E; Ascraeus +18233 m at 11.7N 255.4E; north lowland mean -3.9 km,
// south highland mean +1.5 km.
const FEATURES = [
  ["Olympus Mons summit (max)", 14, 22, 222, 231, "max", 20000, 21300],
  ["Ascraeus Mons (max)", 8, 15, 252, 259, "max", 16500, 18400],
  ["Elysium Mons (max)", 22, 28, 143, 152, "max", 12500, 14200],
  ["Hellas Planitia floor (min)", -60, -25, 50, 100, "min", -8300, -7400],
  ["Valles Marineris (min)", -20, 0, 270, 330, "min", -6000, -4500],
  ["Argyre Planitia (min)", -60, -35, 300, 330, "min", -5400, -4000],
  ["Utopia Planitia (min)", 40, 55, 110, 125, "min", -6600, -5000],
];
function verify(sizeEntries, qBySize, manifest) {
  const D = Math.PI / 180;
  for (const [size, entry] of Object.entries(sizeEntries)) {
    const atlas = new MarsHeightAtlas(manifest.range);
    qBySize[size].forEach((q, f) => atlas.addFace(entry.res, f, q));
    const at = (lat, lon) => atlas.sample(Math.cos(lat * D) * Math.cos(lon * D), Math.sin(lat * D), Math.cos(lat * D) * Math.sin(lon * D));
    console.log(`  ${size} read-back:`);
    for (const [name, la0, la1, lo0, lo1, mode, lo, hi] of FEATURES) {
      let best = mode === "max" ? -Infinity : Infinity;
      for (let la = la0; la <= la1; la += 0.1) for (let lon = lo0; lon <= lo1; lon += 0.1) {
        const h = at(la, lon);
        best = mode === "max" ? Math.max(best, h) : Math.min(best, h);
      }
      const ok = best >= lo && best <= hi;
      console.log(`    ${ok ? "ok  " : "FAIL"} ${name.padEnd(30)} ${best.toFixed(0).padStart(7)} m  (expected ${lo}..${hi})`);
      if (!ok) process.exitCode = 1;
    }
    // Hemispheric means (dichotomy sense): 45-80N vs 45-80S.
    let n = 0, s = 0, cn = 0;
    for (let la = 45; la <= 80; la += 1) for (let lon = 0; lon < 360; lon += 2) { n += at(la, lon); s += at(-la, lon); cn++; }
    const okMean = n / cn < -2500 && s / cn > 500;
    console.log(`    ${okMean ? "ok  " : "FAIL"} north 45-80N mean ${(n / cn).toFixed(0)} m, south 45-80S mean ${(s / cn).toFixed(0)} m`);
    if (!okMean) process.exitCode = 1;
  }
}

// -------------------------------------------------------------------------------------- main
console.log(`reading ${input} ...`);
const { info, data } = readTiff(input);
console.log(`  ${info.W} x ${info.H}, west ${info.west.toFixed(3)} north ${info.north.toFixed(3)} pixel ${info.dLon.toFixed(6)} deg, ${info.metresPerPixel.toFixed(1)} m, nodata ${info.nodata}`);
if (info.nodata !== null) { let n = 0; for (let i = 0; i < data.length; i++) if (data[i] === info.nodata) { n++; data[i] = -4000; } if (n) console.log(`  WARNING: ${n} nodata pixels replaced by -4000 m`); }
console.log("building pyramid ...");
const pyramid = buildPyramid(data, info.W, info.H);
fs.mkdirSync(outDir, { recursive: true });
const manifestPath = path.join(outDir, "manifest.json");
const manifest = fs.existsSync(manifestPath) && !args.has("fresh")
  ? JSON.parse(fs.readFileSync(manifestPath, "utf8"))
  : {
      format: "forge-mars-height-atlas", version: 1,
      source: {
        name: "Mars MGS MOLA DEM 463m (USGS Astrogeology Science Center / NASA MGS MOLA Science Team)",
        resolutionM: 463,
        datum: "MOLA areoid (elevation in metres above the reference sphere, as in the GeoTIFF; sphere radius 3396190 m)",
        file: "Mars_MGS_MOLA_DEM_mosaic_global_463m.tif",
        license: "Public domain (NASA/USGS)",
      },
      range: { minM: MIN_M, maxM: MAX_M },
      apron: APRON,
      encoding: "gzip-grad16",
      cubeSphere: { faceOrder: ["+X", "-X", "+Y", "-Y", "+Z", "-Z"], warp: "spherified-cube (cubeSphere.ts)", registration: "node (u = -1 + 2i/(res-1))", latLon: "lat = asin(y), lon = atan2(z, x), east-positive" },
      sizes: {},
    };
const qBySize = {}, entries = {};
for (const size of sizeNames) {
  console.log(`baking ${size} (${SIZES[size]}²) ...`);
  const baked = bake(size, info, pyramid);
  const { entry, qFaces } = encode(size, baked, outDir);
  manifest.sizes[size] = entry; entries[size] = entry; qBySize[size] = qFaces;
}
manifest.generated = { tool: "tools/bake-mola-atlas.mjs", note: "Offline bake; not run in CI." };
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
// Round-trip the files from disk (decode what was written, not what is in memory).
for (const size of sizeNames) {
  const e = entries[size];
  qBySize[size] = e.faces.map((f) => marsAtlasUnfilter(new Uint8Array(zlib.gunzipSync(fs.readFileSync(path.join(outDir, f.file)))), e.stored));
}
verify(entries, qBySize, manifest);
const totals = Object.entries(manifest.sizes).map(([k, v]) => `${k} ${(v.totalBytes / 1e6).toFixed(2)} MB`).join(", ");
console.log(`done: ${totals}`);
