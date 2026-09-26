# mars-terrain tooling

Two small tools for working with the dev-time generator [`mars-terrain-gen`](../../docs/MARS-TERRAIN.md)
and the engine's port of it. Neither is part of the engine's runtime.

## `plan.ts` + `pregenerate.ts` — region-bounded pre-generation (drop-in for the generator)

The generator's own `src/build.ts` walks **every** chunk of **every** cube face at **one** depth. At
the shipped default that is 1,536 chunks of ~300 km; one level deeper it is 6,144; the depth that would
match a renderer tile (15) is 6.4 billion chunks. So `pregenerate.ts` replaces that walk with a
**site + rings** plan:

```sh
# 1. copy both files into the generator's src/
cp tools/mars-terrain/plan.ts tools/mars-terrain/pregenerate.ts /path/to/mars-terrain-gen/src/

# 2. see what a plan costs, writing nothing (no Stage A cache needed)
cd /path/to/mars-terrain-gen
npx ts-node src/pregenerate.ts --site 30.3,110.6 --bands 15:33:12,14:65:32 --dry-run

# 3. generate it
npx ts-node src/pregenerate.ts --site 30.3,110.6 --bands 15:33:12 --manifest
```

* `--bands depth:resolution:withinKm,...` — rings, **finest first**. A chunk is generated once, by the
  finest band that covers it, so the result is a proper LOD/city-block plan rather than overlapping
  layers. Default: `16:33:4,15:33:12` (73 m chunks inside 4 km, 146 m chunks out to 12 km).
* `--dry-run` — prints chunk counts, **metric chunk sizes** and bytes per band, then exits.
* `--manifest` — writes `cache/chunks.manifest.json` (file → depth → edge metres → bytes), the index a
  loader or a build script wants when it has to reason about the cache without opening 20k binaries.
* `--max-chunks` / `--max-bytes` — hard caps; the run refuses rather than filling a disk.
* Everything else (`cache/global/`, `cache/chunks/`, incremental skipping, `chunkCacheKey` file names)
  is unchanged, so existing caches keep working and `build.ts` can still be used for full-face runs.

### Sizes this prints, and what they mean

The spherified cube keeps cell *area* even to within ±8% but not *side lengths*: a depth-4 chunk is
245–401 km across depending on where it sits. So "the chunk size" is only exact at a face centre:

| depth | chunks/face | chunks/planet | face-centre edge | file @ res 33 | file @ res 65 |
|---|---|---|---|---|---|
| 4 (generator default) | 16×16 | 1,536 | 300 km | 22.9 KB | 88.7 KB |
| 8 | 256² | 393,216 | 18.7 km | 22.9 KB | 88.7 KB |
| 12 | 4096² | 100.7 M | 1.17 km | 22.9 KB | 88.7 KB |
| 13 | 8192² | 402.7 M | 585 m | 22.9 KB | 88.7 KB |
| 14 | 16384² | 1.61 B | 293 m | 22.9 KB | 88.7 KB |
| 15 | 32768² | 6.44 B | 146 m | 22.9 KB | 88.7 KB |
| 16 | 65536² | 25.8 B | 73.1 m | 22.9 KB | 88.7 KB |

Pick the depth whose face-centre edge is **at most** your renderer tile size (`plan.ts` exposes this as
`depthForChunkEdgeAtMost`): 256 m tiles → depth 15, 128 m → depth 16, 64 m → depth 17. Forge's ported
stage does not need these files at all — see `docs/MARS-TERRAIN.md` — they are for standalone use or
pre-baked areas.

## `../mars-port-check.mjs` — does the engine port match the generator?

```sh
npm run check:mars-port -- --cache /path/to/mars-terrain-gen/cache
```

Reads `cache/global/face_<n>/baseElevation.f32` (the generator's cached analytic base) and compares it
point-by-point with the engine's transcription, per face. Passing means the port's craters, volcanoes,
dichotomy, canyon and noise are the same function the generator's erosion correction was measured
against; a warning about ~1e-3 m differences is float32 storage, not drift.

## `../../tests/marsTerrainPlan.test.ts` — the planner's own tests

`plan.ts` is a *copy* of cube-sphere math that also exists in the engine, so the test suite imports the
copy directly and asserts it still agrees with `engine/src/terrain/mars/cubeSphere.ts` point-for-point,
plus the documented chunk-size table and ring-planning behaviour. Edit either side and the other one
fails loudly instead of the two drifting apart.
