/**
 * @suite terrain:marsHeightAtlas
 * @group unit
 * @covers engine/src/terrain/mars/cubeSphere.ts
 * @covers engine/src/terrain/mars/heightAtlas.ts
 * @covers engine/src/terrain/mars/stage.ts
 * @covers engine/src/terrain/mars/geology.ts
 * @covers engine/src/terrain/mars/globeSampler.ts
 * @covers engine/src/terrain/pipelineSpec.ts
 * @covers examples/src/scenes/marsOrbitAtlas.ts
 * @desc fe-40: exact cube-sphere inverse, the MOLA height-atlas codec/sampler/streamer, the committed phone/tablet/desktop assets (known features, seams), real-height terrain stage and globe sampler, and the demo's atlas size selection
 */

export const suite = {
  name: "terrain:marsHeightAtlas",
  group: "unit",
  covers: [
    "engine/src/terrain/mars/cubeSphere.ts",
    "engine/src/terrain/mars/heightAtlas.ts",
    "engine/src/terrain/mars/stage.ts",
    "engine/src/terrain/mars/geology.ts",
    "engine/src/terrain/mars/globeSampler.ts",
    "engine/src/terrain/pipelineSpec.ts",
    "examples/src/scenes/marsOrbitAtlas.ts",
  ],
  desc: "fe-40: exact cube-sphere inverse, the MOLA height-atlas codec/sampler/streamer, the committed phone/tablet/desktop assets (known features, seams), real-height terrain stage and globe sampler, and the demo's atlas size selection",
};
/**
 * Real Mars elevation (fe-40). The committed atlases under `examples/public/mars/mola/` are baked from
 * the USGS MOLA GeoTIFF by `tools/bake-mola-atlas.mjs`; these tests read the *shipped files* back through
 * the runtime code and check them against facts about Mars that do not depend on the baker: where the big
 * volcanoes and basins are and how high/deep, the hemispheric dichotomy, and that the cube faces join.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { finish, group, test } from "selrun";
import {
  InlineOnlyError,
  MARS_FACE_COUNT,
  MarsHeightAtlas,
  MarsHeightAtlasStreamer,
  MarsTerrainStage,
  chooseMarsAtlasSize,
  createMarsGlobeSampler,
  createMarsPipeline,
  createWorldCell,
  decodeMarsAtlasFace,
  describePipeline,
  createPipelineFromSpec,
  marsAtlasFilter,
  marsAtlasPlan,
  marsAtlasQuantize,
  marsAtlasTexelDirection,
  marsAtlasUnfilter,
  marsDirectionToFaceUV,
  marsDirectionToFaceUVExact,
  marsFaceUVToDirection,
  marsLatLonToDirection,
  parseMarsAtlasManifest,
  type MarsAtlasCache,
  type MarsAtlasManifest,
  type MarsAtlasSize,
} from "@forge/engine";
import { createMarsOrbitAtlas } from "../../examples/src/scenes/marsOrbitAtlas.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const molaDir = path.join(repoRoot, "examples/public/mars/mola");
const manifestJson = JSON.parse(readFileSync(path.join(molaDir, "manifest.json"), "utf8")) as unknown;

/** `fetch` served from the committed files (`/mars/mola/<file>`). */
const diskFetch = ((input: RequestInfo | URL): Promise<Response> => {
  const url = String(input);
  const file = path.join(molaDir, url.replace(/^.*\/mars\/mola\//, ""));
  try {
    return Promise.resolve(new Response(readFileSync(file)));
  } catch {
    return Promise.resolve(new Response("not found", { status: 404 }));
  }
}) as typeof fetch;

const dirOf = (latDeg: number, lonDeg: number): { x: number; y: number; z: number } => marsLatLonToDirection(latDeg, lonDeg);

async function loadAll(size: MarsAtlasSize): Promise<MarsHeightAtlasStreamer> {
  const streamer = await MarsHeightAtlasStreamer.open("/mars/mola/", { fetchImpl: diskFetch });
  await streamer.loadSize(size);
  return streamer;
}

/** Extreme of the atlas over a lat/lon window, sampled every 0.1 degree. */
function windowExtreme(atlas: MarsHeightAtlas, la0: number, la1: number, lo0: number, lo1: number, mode: "max" | "min"): number {
  let best = mode === "max" ? -Infinity : Infinity;
  for (let la = la0; la <= la1; la += 0.1) {
    for (let lo = lo0; lo <= lo1; lo += 0.1) {
      const d = dirOf(la, lo);
      const h = atlas.sample(d.x, d.y, d.z);
      best = mode === "max" ? Math.max(best, h) : Math.min(best, h);
    }
  }
  return best;
}

// ------------------------------------------------------------------------------ cube-sphere inverse

group("cubeSphere: exact inverse of the spherified-cube warp", () => {
  test("round-trips every face over its chart, including a margin beyond the edges", () => {
    let worst = 0;
    for (let face = 0; face < MARS_FACE_COUNT; face++) {
      for (let i = 0; i <= 40; i++) {
        for (let j = 0; j <= 40; j++) {
          const u = -1.03 + (2.06 * i) / 40;
          const v = -1.03 + (2.06 * j) / 40;
          const r = marsDirectionToFaceUVExact(marsFaceUVToDirection(face, u, v), face);
          worst = Math.max(worst, Math.abs(r.u - u), Math.abs(r.v - v));
        }
      }
    }
    assert.ok(worst < 1e-12, `worst round-trip error ${worst}`);
  });

  test("picks the same face as the approximate inverse, and is far more exact", () => {
    let approxWorst = 0;
    for (let k = 0; k < 600; k++) {
      const u = Math.sin(k * 12.9898) * 0.98;
      const v = Math.sin(k * 78.233) * 0.98;
      const face = k % MARS_FACE_COUNT;
      const d = marsFaceUVToDirection(face, u, v);
      const exact = marsDirectionToFaceUVExact(d);
      const approx = marsDirectionToFaceUV(d);
      assert.equal(exact.face, face);
      assert.equal(approx.face, face);
      assert.ok(Math.abs(exact.u - u) < 1e-12 && Math.abs(exact.v - v) < 1e-12);
      approxWorst = Math.max(approxWorst, Math.abs(approx.u - u), Math.abs(approx.v - v));
    }
    assert.ok(approxWorst > 0.05, "the approximate inverse is visibly off (which is why the atlas needs the exact one)");
  });

  test("the pole and the face corners are well behaved", () => {
    const pole = marsDirectionToFaceUVExact({ x: 0, y: 1, z: 0 });
    assert.ok(pole.face === 2 && Math.abs(pole.u) < 1e-12 && Math.abs(pole.v) < 1e-12);
    const c = marsFaceUVToDirection(4, 1, 1);
    const r = marsDirectionToFaceUVExact(c, 4);
    assert.ok(Math.abs(r.u - 1) < 1e-9 && Math.abs(r.v - 1) < 1e-9);
  });
});

// ---------------------------------------------------------------------------------------- codec

group("height atlas codec and manifest", () => {
  test("the predictor/byte-split filter round-trips arbitrary 16-bit data, gzip included", async () => {
    const n = 37;
    const q = new Uint16Array(n * n);
    let s = 12345;
    for (let i = 0; i < q.length; i++) {
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      q[i] = i % 5 === 0 ? s & 0xffff : (3000 + (i % n) * 17 + Math.floor(i / n) * 5) & 0xffff;
    }
    const back = marsAtlasUnfilter(marsAtlasFilter(q, n), n);
    assert.deepEqual([...back], [...q]);
    const viaGzip = await decodeMarsAtlasFace(gzipSync(Buffer.from(marsAtlasFilter(q, n))), n);
    assert.deepEqual([...viaGzip], [...q]);
  });

  test("smooth terrain compresses far below raw 16-bit", () => {
    const n = 258;
    const q = new Uint16Array(n * n);
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) q[y * n + x] = Math.round(30000 + 8000 * Math.sin(x / 40) * Math.cos(y / 55));
    const gz = gzipSync(Buffer.from(marsAtlasFilter(q, n)), { level: 9 });
    assert.ok(gz.length < q.byteLength / 3, `gzip ${gz.length} vs raw ${q.byteLength}`);
  });

  test("quantisation covers the range with sub-metre steps and clamps outside it", () => {
    assert.equal(marsAtlasQuantize(-8200, -8200, 21200), 0);
    assert.equal(marsAtlasQuantize(21200, -8200, 21200), 65535);
    assert.equal(marsAtlasQuantize(99999, -8200, 21200), 65535);
    assert.equal(marsAtlasQuantize(-99999, -8200, 21200), 0);
    assert.ok((21200 + 8200) / 65535 < 0.5);
  });

  test("the shipped manifest parses, lists three sizes, and its hashes match the files", () => {
    const manifest = parseMarsAtlasManifest(manifestJson);
    assert.deepEqual(Object.keys(manifest.sizes).sort(), ["desktop", "phone", "tablet"]);
    assert.deepEqual([512, 1024, 2048], [manifest.sizes.phone!.res, manifest.sizes.tablet!.res, manifest.sizes.desktop!.res]);
    let total = 0;
    for (const [name, size] of Object.entries(manifest.sizes)) {
      assert.equal(size!.faces.length, 6, name);
      assert.equal(size!.stored, size!.res + 2);
      let sum = 0;
      for (const face of size!.faces) {
        const bytes = readFileSync(path.join(molaDir, face.file));
        assert.equal(bytes.length, face.bytes, face.file);
        assert.equal(createHash("sha256").update(bytes).digest("hex"), face.sha256, face.file);
        sum += bytes.length;
      }
      assert.equal(sum, size!.totalBytes, name);
      total += sum;
    }
    // The size budget this PR documents: phone ≲ 10 MB, the whole set well under 50 MB.
    assert.ok(manifest.sizes.phone!.totalBytes < 10e6, "phone atlas under 10 MB");
    assert.ok(total < 50e6, `all three sizes under 50 MB (${(total / 1e6).toFixed(1)} MB)`);
    assert.ok(manifest.range.minM <= -8142 && manifest.range.maxM >= 21160, "the range covers MOLA's global min and max");
  });

  test("malformed manifests are rejected with a clear error", () => {
    const good = JSON.parse(JSON.stringify(manifestJson)) as MarsAtlasManifest;
    assert.throws(() => parseMarsAtlasManifest(null), /format/);
    assert.throws(() => parseMarsAtlasManifest({ ...good, version: 2 }), /version/);
    assert.throws(() => parseMarsAtlasManifest({ ...good, encoding: "raw" }), /encoding/);
    assert.throws(() => parseMarsAtlasManifest({ ...good, range: { minM: 5, maxM: 5 } }), /range/);
    assert.throws(() => parseMarsAtlasManifest({ ...good, sizes: { phone: { ...good.sizes.phone!, stored: 3 } } }), /invalid/);
    assert.throws(() => parseMarsAtlasManifest({ ...good, sizes: { phone: { ...good.sizes.phone!, faces: [] } } }), /faces/);
  });
});

// ------------------------------------------------------------------------- sampler (synthetic)

/** A smooth analytic height field of direction, baked into a test atlas exactly like the real one. */
const field = (d: { x: number; y: number; z: number }): number => 1500 * d.x + 800 * d.y * d.z - 600 * d.z * d.z + 300;

function syntheticAtlas(
  res: number,
  faces: readonly number[] = [0, 1, 2, 3, 4, 5],
  fn = field,
  atlas = new MarsHeightAtlas({ minM: -3000, maxM: 3000 }),
): MarsHeightAtlas {
  const stored = res + 2;
  for (const face of faces) {
    const q = new Uint16Array(stored * stored);
    for (let j = 0; j < stored; j++) for (let i = 0; i < stored; i++) q[j * stored + i] = marsAtlasQuantize(fn(marsAtlasTexelDirection(face, res, i, j)), -3000, 3000);
    atlas.addFace(res, face, q);
  }
  return atlas;
}

group("MarsHeightAtlas sampling (synthetic atlas)", () => {
  test("a direction reads back the analytic field it was baked from (bicubic ≈ exact, bilinear close)", () => {
    const atlas = syntheticAtlas(96);
    let worstCubic = 0;
    let worstLinear = 0;
    for (let k = 0; k < 500; k++) {
      const z = Math.sin(k * 1.7) ;
      const phi = k * 2.399963;
      const r = Math.sqrt(Math.max(0, 1 - z * z));
      const d = { x: r * Math.cos(phi), y: z, z: r * Math.sin(phi) };
      worstCubic = Math.max(worstCubic, Math.abs(atlas.sample(d.x, d.y, d.z, "bicubic") - field(d)));
      worstLinear = Math.max(worstLinear, Math.abs(atlas.sample(d.x, d.y, d.z, "bilinear") - field(d)));
    }
    assert.ok(worstCubic < 1.5, `bicubic worst ${worstCubic} m (quantisation step is ~0.09 m)`);
    assert.ok(worstLinear < 12, `bilinear worst ${worstLinear} m`);
    assert.ok(worstCubic < worstLinear);
  });

  test("the sample at a node's own direction is that node's value (the grid and the lookup agree)", () => {
    const atlas = syntheticAtlas(64);
    for (const face of [0, 3, 5]) {
      for (const [i, j] of [[1, 1], [32, 20], [64, 64], [10, 55]] as const) {
        const d = marsAtlasTexelDirection(face, 64, i, j);
        assert.ok(Math.abs(atlas.sample(d.x, d.y, d.z, "bilinear") - field(d)) < 0.2, `face ${face} node ${i},${j}`);
      }
    }
  });

  test("faces join: a shared edge node reads the same from either face's chart and from its direction", () => {
    const atlas = syntheticAtlas(64);
    let worst = 0;
    for (let face = 0; face < MARS_FACE_COUNT; face++) {
      for (let k = 0; k <= 63; k++) {
        const t = -1 + (2 * k) / 63;
        for (const [u, v] of [[-1, t], [1, t], [t, -1], [t, 1]] as const) {
          const d = marsFaceUVToDirection(face, u, v);
          const own = atlas.sampleFaceUV(face, u, v, 64);
          const nb = marsDirectionToFaceUVExact(d);
          const neighbour = atlas.sampleFaceUV(nb.face, nb.u, nb.v, 64);
          const byDirection = atlas.sample(d.x, d.y, d.z);
          worst = Math.max(worst, Math.abs(own - neighbour), Math.abs(own - byDirection));
        }
      }
    }
    assert.ok(worst < 0.5, `shared edge nodes differ by ${worst} m`);
  });

  test("a coarse level covers every face while a finer level covers only some; the finest present wins", () => {
    const both = syntheticAtlas(32);
    syntheticAtlas(128, [4], field, both);
    assert.deepEqual(both.resolutions, [128, 32]);
    assert.deepEqual(both.facesLoaded(), [0, 1, 2, 3, 4, 5]);
    assert.deepEqual(both.facesLoaded(128), [4]);
    const onFine = marsFaceUVToDirection(4, 0.3, 0.2);
    const onCoarse = marsFaceUVToDirection(1, 0.3, 0.2);
    assert.equal(both.resolutionAt(onFine.x, onFine.y, onFine.z), 128);
    assert.equal(both.resolutionAt(onCoarse.x, onCoarse.y, onCoarse.z), 32);
    assert.ok(Math.abs(both.sample(onFine.x, onFine.y, onFine.z) - field(onFine)) < 0.6);
    assert.ok(Math.abs(both.sample(onFine.x, onFine.y, onFine.z, "bicubic", 32) - field(onFine)) < 4, "maxRes forces the coarse level");
  });

  test("an unloaded face reads NaN (callers fall back to the procedural surface); bad faces are rejected", () => {
    const atlas = syntheticAtlas(32, [0]);
    const d = marsFaceUVToDirection(3, 0, 0);
    assert.ok(Number.isNaN(atlas.sample(d.x, d.y, d.z)));
    assert.equal(atlas.complete, false);
    assert.throws(() => atlas.addFace(32, 9, new Uint16Array(34 * 34)), /bad face/);
    assert.throws(() => atlas.addFace(32, 1, new Uint16Array(10)), /needs/);
    assert.throws(() => new MarsHeightAtlas({ minM: 1, maxM: 1 }), /range/);
  });

  test("facesNear lists the neighbours a disc reaches, own face first", () => {
    const atlas = syntheticAtlas(16, [0]);
    const mid = marsFaceUVToDirection(4, 0, 0);
    assert.deepEqual(atlas.facesNear(mid.x, mid.y, mid.z, 0.01), [4]);
    const edge = marsFaceUVToDirection(4, 0.999, 0);
    const near = atlas.facesNear(edge.x, edge.y, edge.z, 0.02);
    assert.equal(near[0], 4);
    assert.ok(near.length >= 2 && near.includes(0), `reaches the +X face: ${near}`);
    const corner = marsFaceUVToDirection(4, 0.999, 0.999);
    assert.ok(atlas.facesNear(corner.x, corner.y, corner.z, 0.03).length >= 3, "a corner touches three faces");
  });
});

// ------------------------------------------------------------------------ committed assets (real)

const KNOWN: ReadonlyArray<readonly [string, number, number, number, number, "max" | "min", number, number]> = [
  ["Olympus Mons summit", 14, 22, 222, 231, "max", 20000, 21300],
  ["Ascraeus Mons", 8, 15, 252, 259, "max", 16500, 18400],
  ["Elysium Mons", 22, 28, 143, 152, "max", 12500, 14200],
  ["Hellas Planitia floor", -60, -25, 50, 100, "min", -8300, -7400],
  ["Valles Marineris", -20, 0, 270, 330, "min", -6000, -4500],
  ["Argyre Planitia", -60, -35, 300, 330, "min", -5400, -4000],
  ["Utopia Planitia", 40, 55, 110, 125, "min", -6600, -5000],
];

for (const size of ["phone", "tablet"] as const) {
  group(`committed ${size} atlas: real Mars`, () => {
    test("known features sit where and how high/deep they really are (MOLA datum)", async () => {
      const { atlas } = await loadAll(size);
      for (const [name, la0, la1, lo0, lo1, mode, lo, hi] of KNOWN) {
        const h = windowExtreme(atlas, la0, la1, lo0, lo1, mode);
        assert.ok(h >= lo && h <= hi, `${name}: ${h.toFixed(0)} m not in ${lo}..${hi}`);
      }
    });

    test("the dichotomy has the right sense: north lowlands far below the southern highlands", async () => {
      const { atlas } = await loadAll(size);
      let n = 0;
      let s = 0;
      let c = 0;
      for (let la = 45; la <= 80; la += 2) {
        for (let lo = 0; lo < 360; lo += 5) {
          const a = dirOf(la, lo);
          const b = dirOf(-la, lo);
          n += atlas.sample(a.x, a.y, a.z);
          s += atlas.sample(b.x, b.y, b.z);
          c++;
        }
      }
      assert.ok(n / c < -2500, `north mean ${n / c}`);
      assert.ok(s / c > 500, `south mean ${s / c}`);
    });

    test("longitude is east-positive and the volcanoes are in the right order (Olympus west of Tharsis)", async () => {
      const { atlas } = await loadAll(size);
      const at = (la: number, lo: number): number => {
        const d = dirOf(la, lo);
        return atlas.sample(d.x, d.y, d.z);
      };
      assert.ok(at(17.3, 226.6) > 19000, "Olympus at 226.6E");
      assert.ok(at(17.3, 226.6 - 180) < 8000 && at(17.3, 133.4) < 8000, "nothing there 180° away");
      assert.ok(at(17.3, 133.4) < at(17.3, 226.6) - 12000);
      // Mirrored longitude would put Olympus at 133.4E.
      assert.ok(at(11.7, 255.4) > 14000, "Ascraeus east of Olympus");
      assert.ok(at(-14.4, 302.2) < -3500, "Valles Marineris east of Tharsis");
      assert.ok(at(-14.4, 360 - 302.2) > -3000, "and not mirrored");
    });

    test("the cube faces join: nodes on a shared edge agree exactly, and a walk across every edge has no step", async () => {
      const { atlas } = await loadAll(size);
      const manifest = parseMarsAtlasManifest(manifestJson);
      const res = manifest.sizes[size]!.res;
      let worstNode = 0;
      let worstStep = 0;
      for (let face = 0; face < MARS_FACE_COUNT; face++) {
        for (let k = 0; k < res; k += 7) {
          const t = -1 + (2 * k) / (res - 1);
          for (const [u, v] of [[-1, t], [1, t], [t, -1], [t, 1]] as const) {
            const d = marsFaceUVToDirection(face, u, v);
            const own = atlas.sampleFaceUV(face, u, v, res, "bilinear");
            // The same point read through the *neighbour's* chart.
            const nb = marsDirectionToFaceUVExact(d);
            const other = atlas.sampleFaceUV(nb.face, nb.u, nb.v, res, "bilinear");
            worstNode = Math.max(worstNode, Math.abs(own - other));
            // Step across the edge: two points 1e-5 rad (~34 m) either side, along the edge normal.
            const inward = marsFaceUVToDirection(face, u * 0.99999, v * 0.99999);
            const outward = marsFaceUVToDirection(face, u * 1.00001, v * 1.00001);
            const a = atlas.sample(inward.x, inward.y, inward.z);
            const b = atlas.sample(outward.x, outward.y, outward.z);
            worstStep = Math.max(worstStep, Math.abs(a - b));
          }
        }
      }
      assert.ok(worstNode < 1.0, `shared edge nodes differ by ${worstNode} m`);
      assert.ok(worstStep < 120, `step across an edge ${worstStep} m (terrain slope alone is ≲ 100 m per 34 m only on cliffs)`);
    });

    test("heights fit the documented range and the global extremes match MOLA", async () => {
      const { atlas } = await loadAll(size);
      let lo = Infinity;
      let hi = -Infinity;
      for (let la = -89; la <= 89; la += 0.5) {
        for (let lo2 = 0; lo2 < 360; lo2 += 0.5) {
          const d = dirOf(la, lo2);
          const h = atlas.sample(d.x, d.y, d.z, "bilinear");
          if (h < lo) lo = h;
          if (h > hi) hi = h;
        }
      }
      assert.ok(hi > 20000 && hi < 21300, `max ${hi}`);
      assert.ok(lo < -7500 && lo > -8300, `min ${lo}`);
    });
  });
}

group("committed desktop atlas: lazy 2048² faces over the tablet base", () => {
  test("one desktop face decodes to 2050² texels and refines the tablet heights without contradicting them", async () => {
    const streamer = await MarsHeightAtlasStreamer.open("/mars/mola/", { fetchImpl: diskFetch });
    await streamer.loadSize("tablet");
    const olympus = dirOf(17.3, 226.6);
    const face = marsDirectionToFaceUVExact(olympus).face;
    const before = streamer.atlas.sample(olympus.x, olympus.y, olympus.z);
    await streamer.loadFaces("desktop", [face]);
    assert.deepEqual(streamer.facesReady("desktop"), [face]);
    assert.equal(streamer.atlas.resolutionAt(olympus.x, olympus.y, olympus.z), 2048);
    const after = streamer.atlas.sample(olympus.x, olympus.y, olympus.z);
    assert.ok(Math.abs(after - before) < 400, `tablet ${before.toFixed(0)} vs desktop ${after.toFixed(0)}`);
    const peak = windowExtreme(streamer.atlas, 16.5, 18.2, 225.5, 227.6, "max");
    assert.ok(peak > 20900 && peak < 21300, `desktop Olympus summit ${peak}`);
    // The face that was not loaded still answers from the tablet level.
    const elsewhere = dirOf(-30, 60);
    assert.ok(Number.isFinite(streamer.atlas.sample(elsewhere.x, elsewhere.y, elsewhere.z)));
  });
});

// ---------------------------------------------------------------------------------- streamer + cache

function memoryCache(): MarsAtlasCache & { store: Map<string, ArrayBuffer>; gets: number } {
  const store = new Map<string, ArrayBuffer>();
  return {
    store,
    gets: 0,
    async get(key) {
      this.gets++;
      return store.get(key);
    },
    async put(key, bytes) {
      store.set(key, bytes);
    },
  };
}

group("MarsHeightAtlasStreamer", () => {
  test("loads only what is asked for, counts bytes, and serves a second session from the cache", async () => {
    const cache = memoryCache();
    const first = await MarsHeightAtlasStreamer.open("/mars/mola/", { fetchImpl: diskFetch, cache });
    await first.loadFaces("phone", [0, 4]);
    assert.deepEqual(first.facesReady("phone"), [0, 4]);
    assert.deepEqual(first.facesReady("tablet"), []);
    const stats = first.streamStats;
    assert.equal(stats.downloaded, 2);
    assert.equal(stats.cacheHits, 0);
    assert.equal(stats.bytesDownloaded, first.manifest.sizes.phone!.faces[0]!.bytes + first.manifest.sizes.phone!.faces[4]!.bytes);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(cache.store.size, 2, "face files were cached by hash");

    let fetches = 0;
    const counting = ((input: RequestInfo | URL) => {
      if (!String(input).endsWith("manifest.json")) fetches++;
      return diskFetch(input);
    }) as typeof fetch;
    const second = await MarsHeightAtlasStreamer.open("/mars/mola/", { fetchImpl: counting, cache });
    await second.loadFaces("phone", [0, 4]);
    assert.equal(fetches, 0, "no face file refetched");
    assert.equal(second.streamStats.cacheHits, 2);
    assert.equal(second.streamStats.bytesDownloaded, 0);
  });

  test("concurrent requests for one face share one download; a failure is reported and retryable", async () => {
    let fetches = 0;
    const counting = ((input: RequestInfo | URL) => {
      if (String(input).includes("phone/face2")) fetches++;
      return diskFetch(input);
    }) as typeof fetch;
    const s = await MarsHeightAtlasStreamer.open("/mars/mola/", { fetchImpl: counting });
    await Promise.all([s.loadFace("phone", 2), s.loadFace("phone", 2), s.loadFace("phone", 2)]);
    assert.equal(fetches, 1);
    await s.loadFace("phone", 2);
    assert.equal(fetches, 1, "already loaded: no request");

    let fail = true;
    const flaky = ((input: RequestInfo | URL) => (fail && String(input).includes("phone/face1") ? Promise.resolve(new Response("x", { status: 503 })) : diskFetch(input))) as typeof fetch;
    const f = await MarsHeightAtlasStreamer.open("/mars/mola/", { fetchImpl: flaky });
    await assert.rejects(f.loadFace("phone", 1), /503/);
    assert.match(f.failure("phone", 1) ?? "", /503/);
    fail = false;
    await f.loadFace("phone", 1);
    assert.deepEqual(f.facesReady("phone"), [1]);
  });

  test("a truncated file or a size not in the manifest is rejected", async () => {
    const truncated = ((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("phone/face0")) return Promise.resolve(new Response(readFileSync(path.join(molaDir, "phone/face0.bin")).subarray(0, 100)));
      return diskFetch(input);
    }) as typeof fetch;
    const s = await MarsHeightAtlasStreamer.open("/mars/mola/", { fetchImpl: truncated });
    await assert.rejects(s.loadFace("phone", 0), /manifest says/);
    const only = parseMarsAtlasManifest({ ...(manifestJson as object), sizes: { phone: parseMarsAtlasManifest(manifestJson).sizes.phone } });
    const t = new MarsHeightAtlasStreamer(only, "/mars/mola/", { fetchImpl: diskFetch });
    await assert.rejects(t.loadFace("desktop", 0), /not in the manifest/);
  });

  test("loadNear fetches the faces under a site (and its neighbours at an edge)", async () => {
    const s = await MarsHeightAtlasStreamer.open("/mars/mola/", { fetchImpl: diskFetch });
    const mid = marsFaceUVToDirection(2, 0, 0);
    await s.loadNear("phone", mid, 0.01);
    assert.deepEqual(s.facesReady("phone"), [2]);
    const edge = marsFaceUVToDirection(2, 0.9999, 0);
    await s.loadNear("phone", edge, 0.02);
    assert.ok(s.facesReady("phone").length >= 2);
  });
});

group("atlas size selection", () => {
  test("?mola= wins; otherwise the smaller of the tier's wish and the device's limit", () => {
    assert.equal(chooseMarsAtlasSize({ override: "desktop", tier: "low", phone: true }), "desktop");
    assert.equal(chooseMarsAtlasSize({ override: "bogus", tier: "high" }), "desktop");
    assert.equal(chooseMarsAtlasSize({ tier: "high" }), "desktop");
    assert.equal(chooseMarsAtlasSize({ tier: "medium" }), "tablet");
    assert.equal(chooseMarsAtlasSize({ tier: "low" }), "phone");
    assert.equal(chooseMarsAtlasSize({ tier: "high", phone: true, mobile: true }), "phone", "iPhone");
    assert.equal(chooseMarsAtlasSize({ tier: "high", mobile: true }), "tablet", "iPad");
    assert.equal(chooseMarsAtlasSize({ tier: "high", deviceMemoryGB: 2 }), "phone");
    assert.equal(chooseMarsAtlasSize({ tier: "high", deviceMemoryGB: 4 }), "tablet");
    assert.equal(chooseMarsAtlasSize({ tier: "high", deviceMemoryGB: 8 }), "desktop");
    assert.equal(chooseMarsAtlasSize({ tier: "low", deviceMemoryGB: 8 }), "phone", "never above the tier");
  });

  test("a size's wire plan: phone and tablet are one level; desktop is the tablet base plus lazy 2048² faces", () => {
    assert.deepEqual(marsAtlasPlan("phone"), { base: "phone", detail: null });
    assert.deepEqual(marsAtlasPlan("tablet"), { base: "tablet", detail: null });
    assert.deepEqual(marsAtlasPlan("desktop"), { base: "tablet", detail: "desktop" });
  });
});

// ------------------------------------------------------------------------------- terrain stage

const SITE = { name: "t", description: "t", latDeg: 17.3, lonDeg: 226.6, headingDeg: 0 };

group("MarsTerrainStage over real heights", () => {
  test("without an atlas the stage is bit-identical to before (same identity, same heights)", () => {
    const a = new MarsTerrainStage({ site: SITE });
    const b = new MarsTerrainStage({ site: SITE, heightAtlas: null });
    assert.equal(a.identity, b.identity);
    assert.ok(!a.identity.includes("heightAtlas"));
    assert.equal(a.hasRealElevation, false);
    const ca = createWorldCell(1, 2, 128, 33, 1337);
    const cb = createWorldCell(1, 2, 128, 33, 1337);
    a.process(ca);
    b.process(cb);
    assert.deepEqual([...ca.heights], [...cb.heights]);
  });

  test("with the atlas the surface follows the real heights (km-scale), with only metres of procedural detail on top", async () => {
    const { atlas } = await loadAll("tablet");
    const stage = new MarsTerrainStage({ site: SITE, heightAtlas: atlas });
    assert.equal(stage.hasRealElevation, true);
    const procedural = new MarsTerrainStage({ site: SITE });
    const cell = createWorldCell(0, 0, 256, 33, 1337);
    stage.process(cell);
    const centre = stage.sampleElevation(0, 0);
    const d = stage.site.up;
    const real = atlas.sample(d.x, d.y, d.z);
    // Detail band + small craters (≤ ~330 m deep) ride on the real height.
    assert.ok(Math.abs(centre - real) < 400, `stage ${centre.toFixed(1)} vs atlas ${real.toFixed(1)}`);
    // The site is on Olympus: the real summit region is ≥ 18 km, while the procedural model puts the site wherever its own volcano is.
    assert.ok(centre > 17000, `Olympus site elevation ${centre}`);
    assert.notEqual(procedural.sampleElevation(0, 0).toFixed(0), centre.toFixed(0));
    // Heights written to the cell follow the sphere's curvature compensation like the procedural stage's.
    assert.ok(Number.isFinite(cell.heights[16 * 33 + 16]!));
  });

  test("procedural detail fades in as tiles get finer and never swamps a coarse tile", async () => {
    const { atlas } = await loadAll("tablet");
    const stage = new MarsTerrainStage({ site: SITE, heightAtlas: atlas, curvatureCompensation: false });
    const noDetail = new MarsTerrainStage({ site: SITE, heightAtlas: atlas, curvatureCompensation: false, detail: false });
    const wiggle = (size: number, res: number, s: MarsTerrainStage): number => {
      const cell = createWorldCell(0, 0, size, res, 1337);
      s.process(cell);
      // Real-height-only reference at the same vertices: sample the atlas through the stage's site frame.
      const step = size / (res - 1);
      let worst = 0;
      const dir = { x: 0, y: 0, z: 0 };
      for (let j = 0; j < res; j += 4) {
        for (let i = 0; i < res; i += 4) {
          s.site.directionFor(i * step, j * step, dir);
          worst = Math.max(worst, Math.abs(cell.heights[j * res + i]! - atlas.sample(dir.x, dir.y, dir.z)));
        }
      }
      return worst;
    };
    assert.ok(wiggle(256, 33, stage) > 0.5, "fine tiles carry procedural detail");
    assert.ok(wiggle(256, 33, stage) < 400);
    assert.ok(wiggle(256, 33, noDetail) > 0 && wiggle(256, 33, noDetail) < 400, "small craters still apply with detail: false");
    // A 1.5 km-spacing tile (49 km chunk) has no procedural contribution: exactly the real heights.
    assert.ok(wiggle(49152, 33, stage) < 1e-3, "coarse tile = real heights only");
  });

  test("faces that are not loaded fall back to the procedural surface per vertex", () => {
    const empty = new MarsHeightAtlas({ minM: -8200, maxM: 21200 });
    const withEmpty = new MarsTerrainStage({ site: SITE, heightAtlas: empty });
    const plain = new MarsTerrainStage({ site: SITE });
    assert.equal(withEmpty.hasRealElevation, false);
    const ca = createWorldCell(0, 0, 128, 17, 1337);
    const cb = createWorldCell(0, 0, 128, 17, 1337);
    withEmpty.process(ca);
    plain.process(cb);
    assert.deepEqual([...ca.heights], [...cb.heights]);
  });

  test("an atlas-backed stage identifies itself and refuses to be rebuilt in a worker", async () => {
    const { atlas } = await loadAll("phone");
    const pipeline = createMarsPipeline({ site: SITE, heightAtlas: atlas });
    const stage = pipeline.stages[0] as MarsTerrainStage;
    assert.match(stage.identity, /"heightAtlas":\{"resolutions":\[512\],"faces":\[0,1,2,3,4,5\]\}/);
    const spec = describePipeline(pipeline);
    assert.throws(() => createPipelineFromSpec(spec), (e: unknown) => e instanceof InlineOnlyError);
  });
});

// --------------------------------------------------------------------------------- globe sampler

group("Mars globe sampler over real heights", () => {
  test("without an atlas it is the procedural sampler; attaching one switches to real heights and back", async () => {
    const sampler = createMarsGlobeSampler();
    assert.equal(sampler.hasRealElevation, false);
    const out = { elevation: 0, r: 0, g: 0, b: 0 };
    const d = dirOf(17.3, 226.6);
    const procedural = sampler.sample(d.x, d.y, d.z, out).elevation;
    const { atlas } = await loadAll("phone");
    sampler.setAtlas(atlas);
    assert.equal(sampler.hasRealElevation, true);
    const real = sampler.sample(d.x, d.y, d.z, out).elevation;
    assert.ok(real > 19500, `Olympus ${real}`);
    assert.notEqual(Math.round(procedural), Math.round(real));
    sampler.setAtlas(null);
    assert.equal(sampler.sample(d.x, d.y, d.z, out).elevation, procedural);
  });

  test("elevations and colours at known places are plausible, and the elevation ramp darkens basins and brightens highs", async () => {
    const { atlas } = await loadAll("tablet");
    const sampler = createMarsGlobeSampler(undefined, { atlas });
    const at = (la: number, lo: number) => {
      const d = dirOf(la, lo);
      return sampler.sample(d.x, d.y, d.z, { elevation: 0, r: 0, g: 0, b: 0 });
    };
    const hellas = at(-32.8, 62.2);
    const olympus = at(17.3, 226.6);
    assert.ok(hellas.elevation < -7500 && olympus.elevation > 20000);
    const luma = (c: { r: number; g: number; b: number }): number => 0.3 * c.r + 0.59 * c.g + 0.11 * c.b;
    // Average over many places so the albedo-marking noise cancels: low ground is darker than high ground.
    let lowL = 0, lowN = 0, highL = 0, highN = 0;
    for (let la = -60; la <= 60; la += 3) {
      for (let lo = 0; lo < 360; lo += 6) {
        const s = at(la, lo);
        if (s.elevation < -3000) { lowL += luma(s); lowN++; } else if (s.elevation > 3500) { highL += luma(s); highN++; }
      }
    }
    assert.ok(lowN > 20 && highN > 20);
    assert.ok(highL / highN > lowL / lowN + 8, `high ${highL / highN} vs low ${lowL / lowN}`);
    for (const c of [hellas, olympus]) assert.ok([c.r, c.g, c.b].every((v) => Number.isFinite(v) && v >= 0 && v <= 300));
  });

  test("a footprint band-limits the height: a coarse cell reads the mean of its neighbourhood", async () => {
    const { atlas } = await loadAll("tablet");
    const sampler = createMarsGlobeSampler(undefined, { atlas });
    const out = { elevation: 0, r: 0, g: 0, b: 0 };
    // A narrow canyon wall: point sample vs a 1° footprint.
    const d = dirOf(-13.5, 301);
    const point = sampler.sample(d.x, d.y, d.z, out, 0).elevation;
    const wide = sampler.sample(d.x, d.y, d.z, out, (1 * Math.PI) / 180).elevation;
    assert.ok(Number.isFinite(point) && Number.isFinite(wide));
    // The 1° average of a canyon sits above the canyon floor.
    assert.ok(wide > point - 2000);
    let spread = 0;
    for (let k = 0; k < 30; k++) {
      const e = dirOf(-20 + k * 0.5, 295 + k * 0.7);
      spread += Math.abs(sampler.sample(e.x, e.y, e.z, out, 0).elevation - sampler.sample(e.x, e.y, e.z, out, 0.0175).elevation);
    }
    assert.ok(spread > 0, "footprint changes the answer over rough ground");
  });
});

// ----------------------------------------------------------------------- the demo's atlas controller

group("Mars Orbit Explorer atlas controller", () => {
  const device = { phone: false, mobile: false };
  test("?mola=off never touches the network and reports procedural", async () => {
    let calls = 0;
    const c = createMarsOrbitAtlas({ mola: "off", tier: "high", device, fetchImpl: (() => { calls++; return diskFetch("x"); }) as typeof fetch });
    await c.ready;
    assert.equal(c.info.status, "off");
    assert.equal(c.atlas, null);
    assert.equal(calls, 0);
    assert.equal(c.groundReady({ x: 1, y: 0, z: 0 }, 0.01), true);
  });

  test("each size downloads only what it needs: phone one level, tablet one level, desktop the tablet base then lazy faces", async () => {
    const seen: string[] = [];
    const spy = ((input: RequestInfo | URL) => {
      seen.push(String(input).replace(/^.*\/mars\/mola\//, ""));
      return diskFetch(input);
    }) as typeof fetch;
    for (const mola of ["phone", "tablet", "desktop"] as const) {
      seen.length = 0;
      const c = createMarsOrbitAtlas({ mola, tier: "low", device, fetchImpl: spy, baseUrl: "/mars/mola/", cache: null });
      await c.ready;
      assert.equal(c.info.status, "ready", mola);
      assert.equal(c.info.size, mola);
      assert.equal(c.info.reason, `?mola=${mola}`);
      const dirs = new Set(seen.filter((s) => s !== "manifest.json").map((s) => s.split("/")[0]));
      assert.deepEqual([...dirs], [mola === "desktop" ? "tablet" : mola], `${mola}: only its base level fetched`);
      assert.equal(seen.filter((s) => s !== "manifest.json").length, 6);
      assert.equal(c.info.facesBase, 6);
      if (mola === "desktop") {
        const site = dirOf(17.3, 226.6);
        assert.equal(c.groundReady(site, 0.005), false);
        const before = seen.length;
        await c.loadGround(site, 0.005);
        assert.equal(c.groundReady(site, 0.005), true);
        const added = seen.slice(before);
        assert.ok(added.length >= 1 && added.length <= 4 && added.every((s) => s.startsWith("desktop/")), `lazy desktop faces: ${added}`);
        assert.equal(c.info.resolution, 2048);
        assert.ok(c.info.facesDetail >= 1 && c.info.facesDetail <= 4);
      } else {
        assert.equal(c.groundReady(dirOf(0, 0), 0.01), true, "phone/tablet have no finer level to wait for");
      }
      c.dispose();
    }
  });

  test("automatic choice follows the tier and the device, and says why", async () => {
    const c = createMarsOrbitAtlas({ tier: "high", device: { phone: true, mobile: true }, fetchImpl: diskFetch, cache: null, baseUrl: "/mars/mola/" });
    assert.equal(c.info.size, "phone");
    assert.match(c.info.reason, /tier high, phone/);
    await c.ready;
    const t = createMarsOrbitAtlas({ tier: "medium", device, fetchImpl: diskFetch, cache: null, baseUrl: "/mars/mola/" });
    assert.equal(t.info.size, "tablet");
    await t.ready;
  });

  test("a missing atlas degrades to the procedural planet instead of breaking the demo", async () => {
    const c = createMarsOrbitAtlas({ mola: "phone", tier: "low", device, fetchImpl: (() => Promise.resolve(new Response("nope", { status: 404 }))) as typeof fetch, cache: null });
    await c.ready;
    assert.equal(c.info.status, "failed");
    assert.match(c.info.error ?? "", /404/);
    assert.equal(c.atlas, null);
  });
});

await finish();
