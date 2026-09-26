#!/usr/bin/env node
/**
 * mars-port-check — prove the engine's Mars transcription against the generator's own output.
 *
 * The port in `engine/src/terrain/mars/` re-derives the generator's analytic surface per vertex
 * (craters, volcanoes, dichotomy, canyon, cinder cones) and adds the generator's *simulated* erosion
 * correction on top. That only works if the analytic half is the same function the correction was
 * measured against: Stage A stores `erosionDelta = eroded - baseElevation`, and `baseElevation` is
 * literally `sampleAnalytic(dir).elevation` evaluated on a face grid. So the port and the cache can be
 * compared directly, point for point, with no rendering involved.
 *
 * Usage:
 *   npm run check:mars-port -- --cache /path/to/mars-terrain-gen/cache
 *   npm run check:mars-port -- --cache ./cache --tolerance 0.05 --faces 0,1
 *
 * What it proves on success: the transcription (hash, gradient noise, crater bands, volcano profile,
 * dichotomy warp, canyon carve) matches the generator's arithmetic to within float32 storage error.
 * What it does *not* prove: that the residual erosion is applied correctly (that is a rendering
 * concern), or that a *different* seed/params/cache combination lines up (the cache carries the
 * generator version it was built with — see docs/MARS-TERRAIN.md).
 *
 * Exits 0 with a per-face table, 1 when a face is over tolerance or a file is missing/malformed.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { marsSampleAnalytic, marsFaceUVToDirection, MARS_GEN_PARAMS } = await import(
  path.join(root, "engine/src/terrain/mars/index.ts")
);

function arg(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  if (value === undefined) {
    console.error(`${name} needs a value`);
    process.exit(2);
  }
  return value;
}

const cacheDir = path.resolve(arg("--cache", path.join(process.cwd(), "cache")));
const tolerance = Number(arg("--tolerance", "0.05"));
const facesArg = arg("--faces", "0,1,2,3,4,5");
const faces = facesArg.split(",").map((f) => Number(f.trim()));
const sampleStride = Number(arg("--stride", "1"));

const globalDir = path.join(cacheDir, "global");
if (!fs.existsSync(globalDir)) {
  console.error(`No Stage A cache at ${globalDir}`);
  console.error("Run the generator first:  npm run generate:stageA   (in mars-terrain-gen)");
  process.exit(2);
}

console.log(`mars-port-check`);
console.log(`  cache      ${cacheDir}`);
console.log(`  seed       ${MARS_GEN_PARAMS.seed} (engine port default — must match the cache's marsConfig)`);
console.log(`  tolerance  ${tolerance} m`);
console.log(`  stride     ${sampleStride} (1 = every grid point)`);

let worstOverall = 0;
let failures = 0;
const rows = [];

for (const face of faces) {
  const faceDir = path.join(globalDir, `face_${face}`);
  const metaFile = path.join(faceDir, "meta.json");
  const baseFile = path.join(faceDir, "baseElevation.f32");
  if (!fs.existsSync(metaFile) || !fs.existsSync(baseFile)) {
    console.error(`  face ${face}: missing meta.json or baseElevation.f32 in ${faceDir}`);
    failures++;
    continue;
  }

  const { res } = JSON.parse(fs.readFileSync(metaFile, "utf8"));
  const buf = fs.readFileSync(baseFile);
  const expected = res * res * 4;
  if (buf.byteLength < expected) {
    console.error(`  face ${face}: baseElevation.f32 is ${buf.byteLength} bytes, expected ${expected} for res ${res}`);
    failures++;
    continue;
  }
  const base = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + expected));

  let worst = 0;
  let sumSq = 0;
  let count = 0;
  let worstAt = null;
  for (let j = 0; j < res; j += sampleStride) {
    for (let i = 0; i < res; i += sampleStride) {
      const u = (i / (res - 1)) * 2 - 1;
      const v = (j / (res - 1)) * 2 - 1;
      const dir = marsFaceUVToDirection(face, u, v);
      const ported = marsSampleAnalytic(dir.x, dir.y, dir.z, MARS_GEN_PARAMS).elevation;
      const stored = base[j * res + i];
      const error = Math.abs(ported - stored);
      sumSq += error * error;
      count++;
      if (error > worst) {
        worst = error;
        worstAt = { u, v };
      }
    }
  }

  const rms = Math.sqrt(sumSq / Math.max(1, count));
  worstOverall = Math.max(worstOverall, worst);
  const overTolerance = worst > tolerance;
  if (overTolerance) failures++;
  rows.push({
    face,
    res,
    samples: count,
    maxAbsErrorM: worst,
    rmsErrorM: rms,
    status: overTolerance ? "FAIL" : "ok",
    worstAt,
  });
}

console.log(`\n  face   res   samples      max |err| m     rms m   status   worst at (u, v)`);
for (const row of rows) {
  const at = row.worstAt ? `(${row.worstAt.u.toFixed(3)}, ${row.worstAt.v.toFixed(3)})` : "-";
  console.log(
    `  ${String(row.face).padStart(4)}  ${String(row.res).padStart(4)}  ${String(row.samples).padStart(8)}  ` +
      `${row.maxAbsErrorM.toExponential(3).padStart(12)}  ${row.rmsErrorM.toExponential(2).padStart(8)}  ` +
      `${row.status.padStart(6)}   ${at}`,
  );
}

console.log(`\n  worst absolute error across checked faces: ${worstOverall.toExponential(3)} m`);

if (failures > 0) {
  console.error(
    `\nmars-port-check FAILED (${failures} face(s) over ${tolerance} m).\n` +
      `  - A mismatch this large usually means the cache was built with different parameters ` +
      `(seed, dichotomy, volcanoes, canyon) than engine/src/terrain/mars/config.ts.\n` +
      `  - A mismatch of order 1e-3 m is just float32 storage: baseElevation.f32 is float32 and the ` +
      `port computes in float64. Raise --tolerance if that is what you are seeing.`,
  );
  process.exit(1);
}

console.log("\nmars-port-check passed: the engine port reproduces the generator's analytic base.");
