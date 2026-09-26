/**
 * Region-bounded pre-generation for `mars-terrain-gen` — a drop-in replacement for the
 * "walk every chunk of every face at one depth" loop in `src/build.ts`.
 *
 * Install (see tools/mars-terrain/README.md):
 *   1. copy `plan.ts` and this file into the generator's `src/` directory,
 *   2. run `npx ts-node src/pregenerate.ts --help`.
 *
 * What it adds over `build.ts`:
 *   - a **site + rings** plan instead of a full-face sweep, so you can pre-generate a place rather
 *     than a planet (the full-face default at depth 4 is 1,536 chunks of ~300 km; depth 15 is 6.4
 *     billion chunks, which is not a thing anyone can do),
 *   - **metric sizes**: every planned chunk reports its real edge length in metres, because the
 *     spherified cube keeps area even but shears side lengths (a "depth 4 chunk" is 245-401 km),
 *   - **cost estimates and hard caps** before anything is written, and a `--dry-run` that needs no
 *     Stage A cache,
 *   - an optional **manifest** describing the cache (chunk -> file -> metres -> bytes), which is what a
 *     loader/tool wants when it has to reason about the data,
 *   - incremental behaviour kept from `build.ts`: existing chunks are skipped unless `--force`.
 *
 * Note that Forge itself does not need these files: `MarsTerrainStage` rebuilds the terrain at any
 * tile size from the generator's Stage A fields (~30 MB for the whole planet). Use this walker when
 * you want standalone chunk files — for a non-Forge renderer, for offline inspection, or for a
 * pre-baked area to ship next to the Stage A cache.
 */

import * as fs from "fs";
import * as path from "path";
import { runStageAForFace, GlobalFaceFields } from "./global/stageA";
import { saveGlobalFace, loadGlobalFace } from "./global/globalCache";
import { generateChunk, ChunkAddress } from "./chunk/chunkGenerator";
import { saveChunk, chunkExists, chunkCacheKey } from "./chunk/chunkCache";
import { marsParams, stageAOptions, MARS_RADIUS_M } from "./config/marsConfig";
import { chunkFileBytes, latLonOfDirection, normalize, planMarsChunks, type PlanBand } from "./plan";

const OUT_DIR = path.join(__dirname, "..", "cache");
const GLOBAL_DIR = path.join(OUT_DIR, "global");
const CHUNK_DIR = path.join(OUT_DIR, "chunks");
const MANIFEST_FILE = path.join(OUT_DIR, "chunks.manifest.json");

interface CliOptions {
  bands: PlanBand[];
  site: { latDeg: number; lonDeg: number };
  dryRun: boolean;
  force: boolean;
  manifest: boolean;
  stageAOnly: boolean;
  regenerateStageA: boolean;
  maxChunks: number;
  maxBytes: number;
}

/**
 * The default plan: 73 m chunks (depth 16, 2.3 m vertex spacing) inside 4 km, 146 m chunks out to
 * 12 km. Those two sizes are the ones that line up with a 128-256 m renderer tile; see the README for
 * the arithmetic and the cost of going finer or wider.
 */
const DEFAULT_BANDS = "16:33:4,15:33:12";

/** The config's first volcano is the most interesting place in the default world, so start there. */
function defaultSite(): { latDeg: number; lonDeg: number } {
  const volcano = marsParams.volcanoes[0];
  if (!volcano) return { latDeg: 0, lonDeg: 0 };
  return latLonOfDirection(normalize(volcano.center));
}

function parseBands(text: string): PlanBand[] {
  return text.split(",").map((entry) => {
    const [depth, resolution, withinKm] = entry.split(":").map((piece) => Number(piece.trim()));
    if (!Number.isFinite(depth) || !Number.isFinite(resolution) || !Number.isFinite(withinKm)) {
      throw new Error(`--bands entry "${entry}" is not depth:resolution:withinKm (e.g. 15:33:12)`);
    }
    return { depth: depth!, resolution: resolution!, withinKm: withinKm! };
  });
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    bands: parseBands(DEFAULT_BANDS),
    site: defaultSite(),
    dryRun: false,
    force: false,
    manifest: false,
    stageAOnly: false,
    regenerateStageA: false,
    maxChunks: 250_000,
    maxBytes: 12 * 1024 ** 3,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const next = () => {
      const value = argv[++i];
      if (value === undefined) throw new Error(`${arg} needs a value`);
      return value;
    };
    switch (arg) {
      case "--site": {
        const [lat, lon] = next().split(",").map(Number);
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) throw new Error("--site expects lat,lon in degrees");
        options.site = { latDeg: lat!, lonDeg: lon! };
        break;
      }
      case "--bands":
        options.bands = parseBands(next());
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--force":
        options.force = true;
        break;
      case "--manifest":
        options.manifest = true;
        break;
      case "--stage-a-only":
        options.stageAOnly = true;
        break;
      case "--regen-stage-a":
        options.regenerateStageA = true;
        break;
      case "--max-chunks":
        options.maxChunks = Number(next());
        break;
      case "--max-bytes":
        options.maxBytes = Number(next()) * 1024 ** 3;
        break;
      case "--help":
      case "-h":
        printHelp();
        process.exit(0);
        break;
      default:
        throw new Error(`unknown argument "${arg}" (try --help)`);
    }
  }
  return options;
}

function printHelp(): void {
  console.log(`mars-terrain-gen pre-generation

  --site lat,lon        centre of the area to pre-generate (default: the config's first volcano)
  --bands LIST          comma-separated depth:resolution:withinKm rings, finest first
                        (default ${DEFAULT_BANDS})
  --dry-run             print the plan, sizes and cost, write nothing (needs no Stage A cache)
  --force               regenerate chunks that already exist
  --manifest            also write cache/chunks.manifest.json describing what was generated
  --stage-a-only        stop after the global (Stage A) fields
  --regen-stage-a       rebuild the Stage A fields even if a cache exists
  --max-chunks N        refuse a plan larger than N chunks (default 250000)
  --max-bytes GB        refuse a plan larger than GB gigabytes (default 12)

Chunk sizes, for reference (face-centre edge per quadtree depth):
  depth 12 = 1.17 km   depth 13 = 585 m   depth 14 = 293 m
  depth 15 = 146 m     depth 16 = 73.1 m  depth 17 = 36.6 m

A renderer tile wants chunks at most as wide as the tile: 256 m tiles -> depth 15, 128 m -> depth 16,
64 m -> depth 17. See tools/mars-terrain/README.md.`);
}

function ensureStageA(regenerate: boolean): GlobalFaceFields[] {
  if (!regenerate) {
    const cached: GlobalFaceFields[] = [];
    let complete = true;
    for (let face = 0; face < 6; face++) {
      const file = path.join(GLOBAL_DIR, `face_${face}`, "meta.json");
      if (!fs.existsSync(file)) {
        complete = false;
        break;
      }
      cached.push(loadGlobalFace(GLOBAL_DIR, face));
    }
    if (complete) {
      console.log(`[stageA] reusing cached global fields (res ${cached[0]?.res ?? "?"}) in ${GLOBAL_DIR}`);
      return cached;
    }
    console.log("[stageA] no complete cache found, simulating...");
  }

  const faces: GlobalFaceFields[] = [];
  for (let face = 0; face < 6; face++) {
    const started = Date.now();
    const fields = runStageAForFace(face, marsParams, stageAOptions);
    saveGlobalFace(GLOBAL_DIR, fields);
    faces.push(fields);
    console.log(`[stageA] face ${face} done in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  }
  return faces;
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const plan = planMarsChunks({
    site: options.site,
    bands: options.bands,
    radiusM: marsParams.radius,
    maxChunks: options.maxChunks,
    maxBytes: options.maxBytes,
  });

  const mib = (bytes: number) => `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
  console.log(`\n[plan] site ${options.site.latDeg.toFixed(4)}, ${options.site.lonDeg.toFixed(4)} on Mars`);
  for (const band of plan.estimate.perBand) {
    console.log(
      `[plan] depth ${band.depth} res ${band.resolution} within ${band.withinKm} km: ` +
        `${band.chunks.toLocaleString()} chunks, chunk edge ~${(band.edgeMeters / 1000).toFixed(3)} km, ` +
        `${mib(band.bytes)}`,
    );
  }
  console.log(
    `[plan] total ${plan.estimate.chunks.toLocaleString()} chunks, ` +
      `${plan.estimate.vertices.toLocaleString()} vertices, ${mib(plan.estimate.bytes)}`,
  );
  for (const warning of plan.warnings) console.warn(`[plan] warning: ${warning}`);

  const blocked = plan.warnings.some((warning) => warning.includes("above the"));
  if (options.dryRun) {
    console.log("[plan] dry run: nothing written");
    return;
  }
  if (blocked) {
    console.error("[plan] refusing to generate: raise --max-chunks/--max-bytes or shrink the plan");
    process.exit(1);
  }

  if (options.stageAOnly) {
    if (plan.estimate.chunks === 0) ensureStageA(options.regenerateStageA);
    return;
  }

  const faces = ensureStageA(options.regenerateStageA);
  fs.mkdirSync(CHUNK_DIR, { recursive: true });

  let written = 0;
  let skipped = 0;
  const manifest: { file: string; face: number; depth: number; edgeMeters: number; bytes: number }[] = [];
  const startedAll = Date.now();

  for (const chunk of plan.chunks) {
    const address: ChunkAddress = {
      face: chunk.face,
      u0: chunk.u0,
      v0: chunk.v0,
      u1: chunk.u1,
      v1: chunk.v1,
      resolution: chunk.resolution,
    };
    if (!options.force && chunkExists(CHUNK_DIR, address)) {
      skipped++;
      continue;
    }
    const file = `${chunkCacheKey(address)}.bin`;
    try {
      const generated = generateChunk(address, marsParams, faces);
      saveChunk(CHUNK_DIR, address, generated);
    } catch (error) {
      console.error(`[chunks] FAILED ${file}: ${(error as Error).message}`);
      process.exit(1);
    }
    written++;
    if (options.manifest) {
      manifest.push({
        file,
        face: chunk.face,
        depth: chunk.depth,
        edgeMeters: Math.round(chunk.edgeMeters * 1000) / 1000,
        bytes: chunkFileBytes(chunk.resolution),
      });
    }
    if (written % 25 === 0) {
      const rate = written / ((Date.now() - startedAll) / 1000);
      console.log(`[chunks] ${written}/${plan.chunks.length} written (${rate.toFixed(1)}/s)`);
    }
  }

  if (options.manifest) {
    const document = {
      generator: "mars-terrain-gen",
      seed: marsParams.seed,
      radiusM: marsParams.radius,
      stageA: { res: stageAOptions.res, thermalIterations: stageAOptions.thermalIterations },
      site: options.site,
      bands: options.bands,
      chunks: manifest,
    };
    fs.writeFileSync(MANIFEST_FILE, `${JSON.stringify(document, null, 2)}\n`);
    console.log(`[chunks] wrote ${MANIFEST_FILE} (${manifest.length} entries)`);
  }

  console.log(
    `[chunks] done: ${written} written, ${skipped} already present, ` +
      `${((Date.now() - startedAll) / 1000).toFixed(1)}s`,
  );
  console.log(`[chunks] radius ${MARS_RADIUS_M} m, cache ${CHUNK_DIR}`);
}

try {
  main();
} catch (error) {
  console.error(`pregenerate failed: ${(error as Error).message}`);
  process.exit(1);
}
