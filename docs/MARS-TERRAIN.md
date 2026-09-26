# Mars Terrain — the generator port

Forge's Mars terrain is a **port of the dev-time generator `mars-terrain-gen`** into the engine's
`GeneratorPipeline` as a first-class terrain stage (`engine/src/terrain/mars/`). The port exists so
that the same planet — the same craters, the same 21 km shield volcano, the same dichotomy and canyon —
can be sampled at **any tile size** the renderer asks for, without pre-generating chunk files.

This document covers: why the port looks the way it does, what is bit-identical and what is not, how to
size tiles for it, and how to verify it against the generator's own output.

## 1. Why port a *stage* instead of loading the generator's chunks

The generator writes `<face>_<u0>_<v0>_<u1>_<v1>_r<res>.bin` chunks that are **not** renderer tiles:

| | generator chunk | Forge tile |
|---|---|---|
| shape | curved quad on a cube face (spherified) | square, planar, axis-aligned in XZ |
| size | fixed by quadtree depth (300 km at depth 4, 146 m at depth 15) | `chunkSize` (256 m default; 128 m in the demos) |
| edges | no skirts, no LOD seam handling (one depth per run) | skirts (`skirtDepth`) + a geomorph LOD ladder |
| contents | positions + heights + material index + slope (21 B/vertex) | `WorldCell`: heights, slopes, 4-channel splat weights, scatters |
| count to cover Mars at tile resolution | **~25.8 billion** chunks (depth 16, 22.9 KB each ≈ 590 TB) | still billions — which is why nobody should bake this |

Chunk files are fine for offline use, but they are a dead end as a *rendering* source: you cannot pick
a depth that matches both a 128 m demo tile and a 20 km view, and a hybrid (compose a tile from many
generator chunks) needs a loader with its own seams, LOD policy and material mapping.

The generator's own architecture points the other way. Its Stage B is **one pure function per vertex**:

```ts
// chunkGenerator.ts (generator) — the thing the port evaluates directly
elevation(p) = sampleAnalytic(dir(p))            // craters + volcanoes + cones + dichotomy + canyon
             + bilinear(erosionDelta, dir(p))    // the *simulated* erosion, cached per face
             + fineDetail(dir(p));               // high-frequency roughness
```

Those three terms depend on the **absolute direction** of the vertex, not on which chunk is asking. So
the port keeps the function and discards the chunking entirely: `MarsTerrainStage` evaluates every
vertex of *whatever* square tile Forge hands it, at `chunkSize`/`chunkResolution` of the caller's
choosing. Seams and LOD edges then agree **by construction** — two tiles that share a vertex evaluate the
same direction and get the same height.

The erosion term is the only thing that cannot be recomputed cheaply (it is a multi-pass flow simulation),
so it is consumed as data: the generator's `cache/global/` fields, ~30 MB for all six faces at res 512.

```
cache/global/face_<n>/            ~5 MB per face, 6 faces
  meta.json                       res, seed, generator version
  baseElevation.f32               analytic base (what mars-port-check.mjs compares against)
  erodedElevation.f32             post-simulation surface
  erosionDelta.f32                eroded - base  <- the correction the stage adds
  hardness.f32, flowAccum.f32     Stage A diagnostics (not used for rendering)
  material.u8                     nearest material index (drives the splat weights)
```

`MarsGlobalFieldSet` samples that cache (`sample(direction)` returns `erosionDelta`, `hardness`,
`material` and `flowAccum`, bilinearly for the continuous fields and nearest for the material index),
`fetchMarsFaceFields(url, face)` loads one face over HTTP, and `marsFaceFieldsFromBuffers` decodes the
same bytes from `node:fs`.

Running the stage without a cache is valid: it renders the analytic surface (`erosionDelta = 0`), which
is still a recognisably Martian planet, just not an eroded one. `MarsTerrainStage#hasErosionCorrection`
reports which mode a stage is in.

## 2. What the port contains

```
engine/src/terrain/mars/
  cubeSphere.ts   face ids, spherified-cube warp, face<->direction, lat/lon, angular distances,
                  face-centre chunk edge per depth, depth <-> metric sizing helpers
  noise3.ts       hash3 / hash3s, gradient noise (12 gradients), fbm, ridged, domain warp,
                  transcribed bit-for-bit from the generator's noise/ (do NOT swap in math/noise.ts:
                  the port has to hash identically or nothing lines up with the cache)
  geology.ts      MarsMaterial + hardness table, the three crater bands, volcanoes, cinder cones,
                  dichotomy + canyon, regional base, fine detail, and MarsCraterScanner (below)
  config.ts       MARS_RADIUS_M (3,389,500 m), gravity, the default world parameters (seed 1337 —
                  the generator's marsConfig.ts) and the Stage A defaults
  globalFields.ts reads/decodes the cache above, bilinear continuous sampling + nearest material,
                  MarsGlobalFieldSet (availableFaces/missingFaces/sample/bytes)
  stage.ts        MarsTerrainStage (a GeneratorPipeline stage), MarsSite, MARS_SITE_PRESETS,
                  adviseMarsTile, marsSurfaceLayers, createMarsPipeline, MarsTerrainStageOptions
  index.ts        barrel
```

Registered as stage kind `mars` in `engine/src/terrain/pipelineSpec.ts` so a pipeline containing it can
be described, hashed into the cache key, and sent to workers.

### The stage as a pipeline stage

`MarsTerrainStage#generate(context)` fills a `WorldCell` for one tile:

* **heights** — `marsSampleAnalytic(direction).elevation + bilinear(erosionDelta) + fineDetail`, then
  optional curvature compensation (below).
* **slopes** — central differences on the height grid.
* **biomes** — 4 channels per vertex, i.e. splat weights: `0 dust, 1 rock, 2 sand, 3 crust`. Base weights
  come from the material index the geology rules assigned (regolith/basalt → dust, bedrock/flank → rock,
  dunes/channel floor → sand, crater/ice/sediment → crust), then a slope bias moves weight towards rock
  (`clamp((slope − 0.45) / 0.4, 0, 1)`), renormalised. `marsSurfaceLayers()` returns matching
  `LayeredTerrainMaterial` layers in that channel order.
* **scatters** — deliberately empty. The generator has no scatter pass; the engine's scatterers are
  separate stages.

### Curvature compensation

A tile is a *plane*, Mars is a sphere. `MarsSite#planeHeight` (used when
`curvatureCompensation !== false`) subtracts the sphere's drop below the tangent plane:

```
drop(d) = (R + elevation) · cos(d / R) − R      // d = distance from the site along the plane
```

That is 0.15 m at 1 km, 59 m at 20 km, 1.3 km at 100 km. Without it, large views sag visibly. With
`compensate: false` the stage is **bit-identical** to the generator's heights, which is the mode
`tools/mars-port-check.mjs`-style comparisons and any "same numbers as upstream" work should use.

## 3. Sizing tiles — how big *should* a chunk be

The generator has no metric chunk size: only quadtree depth. Face-centre chunk edge per depth:

| depth | chunks/face | chunks/planet | edge (face centre) | side-length range | vertex spacing @ res 33 |
|---|---|---|---|---|---|
| 4 (default) | 16² | 1,536 | 300 km | 245–401 km | 4.6 km |
| 8 | 256² | 393,216 | 18.7 km | 15.3–26.4 km | 293 m |
| 12 | 4096² | 100.7 M | 1.17 km | 0.96–1.65 km | 18.3 m |
| 13 | 8192² | 402.7 M | 585 m | 479–828 m | 9.1 m |
| 14 | 16384² | 1.61 B | 293 m | 239–414 m | 4.6 m |
| 15 | 32768² | 6.44 B | 146 m | 119–207 m | 2.3 m |
| 16 | 65536² | 25.8 B | 73.1 m | 59.7–103 m | 1.14 m |

The rule for picking: **the generator's cell should be no wider than the tile that consumes it** —
`depthForChunkEdgeAtMost(chunkSize)`, i.e. 256 m tiles → depth 15, 128 m → depth 16, 64 m → depth 17
(at-most oversamples ~1.75x; `depthForChunkEdge` picks the nearest instead when a ~15% upsample is
acceptable).

For the ported stage none of that is needed — it is there for the standalone chunk tooling
(`tools/mars-terrain/`) and for sanity: it tells you the *fidelity* the generator considers native at
each depth. `adviseMarsTile(chunkSize, resolution)` in `stage.ts` answers the renderer-side question
instead, from `vertexSpacing = chunkSize / (resolution − 1)`:

| labelled | vertex spacing | verdict |
|---|---|---|
| `full` | ≤ 2.3 m | matches the generator's deepest useful band (depth 16 at res 33) |
| `micro` | ≤ 4.6 m | depth 15 fidelity — the recommended band |
| `meso` | ≤ 9.2 m | craters survive, rims soften |
| `silhouette` | > 9.2 m | large-scale shapes only; the generator's own default output is here |

`adviseMarsTile` also reports whether `resolution − 1` is a power of two (the engine's geomorph LOD
ladder needs 33 → 17 → 9 → 5 → 3), the nearest generator depth, and a recommended `skirtDepth`
(`clamp(chunkSize × 0.25, 8, 128)`— because small tiles on a 300 m-relief planet need real skirts, and
the engine's default assumes a flat earth).

Practical configurations (all under `MarsTerrainStage`, verified by `tests/marsTerrain.test.ts`):

| intent | chunkSize | resolution | spread | skirt |
|---|---|---|---|---|
| demo / hero shots (matches the existing Mars scenes) | 128 | 33 | ~4 km | 32 m |
| wide traversal | 256 | 33 | ~10 km | 64 m |
| close-up detail | 256 | 65 | ~2 km | 64 m |

Two hard limits: `chunkSize > 4096` breaks the engine's LOD bands (band 24 × 4096 = 98 km > the planet's
curvature budget) and float32 precision of the recentered render origin (~0.25 m ulp at 3.39e6 m), and
any tile vertex spacing below ~1 m gains nothing — it just samples the same 2.3 m generator cells.

## 4. Determinism and workers

The stage is pure given (seed, params, site, fields): the same tile generated twice is byte-identical
(`tests/marsTerrain.test.ts` asserts it), and sharing a vertex across tiles/seams gives the same height
to 1e-9.

**Analytic-only stages now run on workers.** `pipelineSpec.ts` reconstructs the stage from its
complete JSON `identity`, not just the seed and a fresh set of defaults. That includes the planet
radius, full dichotomy/canyon/volcano configuration, site latitude/longitude/heading and **site radius**,
as well as detail and curvature flags. The site radius is distinct from the geology's planet radius;
it now participates in the cache identity too. Malformed JSON, incomplete fields or scalar options
that disagree with the identity are rejected instead of silently generating a different surface.

`tests/tasks.test.ts` runs analytic Mars jobs through genuine worker threads and compares the
transferred height/slope/splat bytes against the **original live pipelines**, including custom
planets/sites, disabled detail/curvature and a subsequent scatter stage. The showcase integration
test spies on the live stage and proves streaming uploads worker results without running that stage
again on the main thread. The default worker bootstrap installs the terrain handler; no custom
worker URL or separate runtime dependency is needed.

**Live Stage A field caches remain inline-only.** The serialized identity includes a non-null cache
marker, not the ~30 MB of buffers. Reconstruction throws `InlineOnlyError` even for an empty field
set: a worker must never omit a requested erosion correction. `TerrainWorld` recovers using the live
pipeline; use `syncGeneration: true` for such worlds to skip the unsupported round trip. A real-thread
test checks that recovery executes the live stage once, preserves a synthetic +7 m erosion field and
does not detach its buffers. Hosting/transporting actual cache data remains separate work.

The scheduler also falls back inline when workers cannot start. Mesh building, GPU uploads and
`getHeightAt` cache misses remain on the main thread in either mode. Worker cancellation is not JS
preemption: once a cancelled handler finishes, a `cancelled` acknowledgement releases the worker's
slot. This matters during async bootstrap, when both a terrain task and its cancellation can arrive
before the handler has loaded; discarding the result without an acknowledgement used to strand the
slot and leave every subsequent task queued.

## 5. Usage

### The shipped Mars Showcase

`npm run demo:showcase` (or the default demo URL) now builds a `createMarsPipeline(...)` world in
`examples/src/scenes/marsShowcaseScene.ts`. The old **Terrain** demo retains its Phase 4 preset.
The showcase uses the generator's **unmodified seed 1337**, with `detail` and curvature compensation
on, at the **Equatorial plain** (`latDeg: 0`, `lonDeg: 0`, heading 0). This is a location on the
procedural planet, not a reconstruction of Perseverance's real landing site.

The rover starts at local `x = -164 m, z = 4 m`, on a surveyed gentle uphill traverse rather than the
summit preset's long downhill slope. No flattened pad or height scaling is added: `placeOnGround`
gets its height and attitude from `TerrainWorld.getHeightAt`, which also supplies wheel contacts,
camera clearance and the sky's local `seaLevel`. Queries made before streaming generate/cache the
same full-resolution grid the resident opening tiles subsequently use.

Configuration: **128 m chunks, 33 × 33 vertices (4 m spacing), 32 m skirts**, a 1024 m view distance,
LOD 0–3 and a 220-chunk visible budget. The scene uses `syncGeneration: false` and the demo's two
workers: nine initial requests, then at most one generation request per frame, with cached query
cells reused rather than regenerated. The opening terrain is available before the loading overlay
dismisses: it waits for the rover's actual tile, not just any resident bytes. These are chunk-count
budgets, not a promise that mesh uploads or cache-miss ground queries never hitch.

The HUD labels the surface **analytic only (no erosion cache)**. No external terrain download is
attempted. The stage's **dust / rock / sand / crust** weights now drive four GPU-blended PBR layers:
three shared 256² × 4 texture arrays (sRGB albedo, linear normals and metallic-roughness), plus a
small linear RGBA8 weight map per resident tile. Neutral procedural surface details are tinted with
scene-authored ferric dust, dark basalt, pale sand and weathered crust colours; these are artistic
approximations, not calibrated NASA reflectance measurements.
`marsState()` exposes the actual generator/mode, ready chunk count, rover-tile readiness and ground
height for diagnostics and the browser gate, plus `terrainGeneration` (`workers` or `inline`) from
current pool availability. The HUD displays that mode; the browser gate separately observes native
Worker task/result messages, so a mode label alone cannot prove off-thread execution.
`terrainMaterialMode`, `terrainMaterialLayers` and `terrainSplatTiles` report actual tile-material
wiring. `TerrainWorld.setLayeredMaterialsEnabled(false)` temporarily selects the representative
single material without regenerating geometry or changing contacts; `true` restores the splats.

### Layered material contract (10.8)

```ts
import { TerrainWorld, LayeredTerrainMaterial, marsSurfaceLayers, createMarsPipeline } from "@forge/engine";

const terrain = new TerrainWorld({
  seed: 1337,
  pipeline: createMarsPipeline({ site: { latDeg: 0, lonDeg: 0 } }),
  layeredMaterial: new LayeredTerrainMaterial({
    layers: marsSurfaceLayers(),
    // Optional SplatTextureSet: three Texture.fromRgba8Array(...) textures, each with four slices.
    // Without maps the helper supplies shared white, flat-normal and neutral-MR arrays.
  }),
});
```

The helper evaluates existing height/slope/biome gates at the cell vertices, stores normalized
weights in RGBA8, and the shader filters then renormalizes them. UV 0/1 addresses the **centres** of
the boundary texels, with a separate clamp sampler: neighbouring tiles never wrap to their opposite
edge. Layer textures repeat at `textureSize` metres (8 by default), with phase computed from the
absolute tile origin in CPU double precision. Thus tiling does not restart at a chunk border or
swim when the render origin changes. Albedo is decoded before blending; tangent normals are scaled,
blended and renormalized, and each layer supplies roughness/metallic factors times its MR map.
Macro colour variation is world-phased; micro darkening follows the albedo details.

The fixed 48-byte vertex layout and standard depth/shadow/PBR-lighting paths are unchanged. The
opt-in terrain technique extends material group 2; ordinary materials retain their original five
bindings. Material **identity**, not just pipeline compatibility, is required for batching, so two
masks on the same geometry cannot accidentally use the first mask's bind group.

A tile owns its mask and material buffers. Remeshing/eviction releases them; the world owns the
layered helper and its fallback arrays. Supplied arrays remain caller-owned and shared. A cloned
SplatMaterial borrows its textures, so keep their owner alive. Per-tile budget estimates include the
mask and 304 uniform bytes; shared arrays remain outside that tile budget (reported in GPU memory).
The showcase arrays are roughly 4 MiB including mipmaps. Mips are filtered independently per slice,
in linear light for albedo and vector space for normals.

This is four fixed layers with grid-sampled gates, not triplanar projection or texture-height
blending. The distant apron uses a representative single material. Coarse LODs can produce different
slope-derived biome weights: stable texture phase/filtering does not promise identical geology masks
between different grids. No generator heights, seed, landing location or rover physics were changed.

### Other sites and optional erosion fields

```ts
import {
  TerrainWorld, LayeredTerrainMaterial, marsSurfaceLayers, createMarsPipeline, MARS_GEN_PARAMS, MARS_SITE_PRESETS, adviseMarsTile,
  fetchMarsFaceFields, MarsGlobalFieldSet,
} from "@forge/engine";

// Optional: load the generator's Stage A cache (~30 MB) for the simulated erosion. Copy
// `cache/global/` to the served assets and fetch the six faces; everything else is computed.
const faces = await Promise.all(
  [0, 1, 2, 3, 4, 5].map((face) => fetchMarsFaceFields(`/mars/global/face_${face}`, face)),
);
const fields = new MarsGlobalFieldSet(faces);

const terrain = new TerrainWorld({
  seed: MARS_GEN_PARAMS.seed,
  chunkSize: 128,
  chunkResolution: 33,
  skirtDepth: adviseMarsTile(128, 33).recommendedSkirtDepth, // 32 m
  syncGeneration: true, // live Stage A buffers still require inline (§4); omit for analytic workers
  generationsPerFrame: 1,
  warmUpChunks: 9,
  layeredMaterial: new LayeredTerrainMaterial({ layers: marsSurfaceLayers() }),
  pipeline: createMarsPipeline({
    site: MARS_SITE_PRESETS.olympusMons, // or { latDeg, lonDeg, headingDeg }
    globalFields: fields,                // omit for the analytic-only surface
  }),
});
```

Lower-level entry points, all exported from the engine barrel:

```ts
marsSampleAnalytic(x, y, z, params)               // the generator's Stage B elevation, metres
marsSampleVolcanoDelta / marsSampleCraterDelta    // individual geology terms (also
  / marsSampleCinderCones / marsSampleRegionalBase   // cinder cones, regional base, fine detail)
new MarsTerrainStage(options)                     // a GeneratorPipeline stage (your own pipeline)
new MarsSite({ latDeg, lonDeg, headingDeg })      // site frame: up/north/east, planeHeight, latLonFor
fetchMarsFaceFields(url, face)                    // Stage A face loader (fetch-based)
marsFaceFieldsFromBuffers(buffers)                // Node/fs path for the same decode
adviseMarsTile(256, 65)                           // see the table above
marsSurfaceLayers()                               // 4 LayeredTerrainMaterial layers, splat channels
marsDepthForChunkEdgeAtMost(256, MARS_RADIUS_M)   // 15
```

`MARS_SITE_PRESETS` ships `olympusMons` (the config's 21 km volcano summit) and `vallesRift` (the canyon
midpoint); both are derived from the generator's `marsConfig.ts` rather than hard-coded coordinates.

## 6. Verification

```sh
npx vitest run tests/marsTerrain.test.ts        # mapping, geology, fields, analytic serialization, streaming/fallback
npx vitest run tests/marsTerrainPlan.test.ts    # 8 tests: tools/mars-terrain/plan.ts vs the engine
npx vitest run tests/marsShowcase.test.ts       # scene wiring, spawn/drive, camera, streaming/LOD
npm run check:browser:terrain-layers          # real-GPU one-hot/mixed/PBR pixels + showcase material A/B
npm run check:browser:mars-workers            # native Worker messages + actual showcase uploads/render
npm run check:browser                         # full suite, including W-drive and articulation
npm run check:mars-port -- --cache <generator-cache>   # point-for-point vs the generator's own output
```

`mars-port-check` is the only check that proves the *transcription* (hash, gradient noise, crater bands,
volcano profile, dichotomy warp, canyon carve) against the generator rather than against itself; it reads
`cache/global/face_<n>/baseElevation.f32` and compares each grid point with the port. It needs a real
cache, so it is not part of CI. It is tolerance-based on purpose: `baseElevation.f32` is float32 while
the port computes in float64, and the crater sum is evaluated in a different order (see below), so
agreement is ~1e-3 m, not bit equality.

Two deviations from the generator, both deliberate and both recorded in `docs/KNOWN-ISSUES.md`:

1. **Crater summation order.** `MarsCraterScanner` caches the craters that can influence a tile's
   vertices (the generator re-walks 27 neighbouring cells per vertex, 81 hash probes each). It samples
   the *same set* of craters — a test asserts zero `inCrater` mismatches and agreement to 1e-6 — but
   sums them in a different order, which moves results in the last mantissa bits of a metres-scale value.
2. **Bilinear erosion sampling.** The generator's Stage A lookup approximates the cube inverse (it uses
   the naive face-space projection, not the inverse of the spherify warp). The port uses the same
   approximation so cached fields line up; at face-centre regions the two coincide, near face edges the
   generator's own lookup is the approximate one.

## 7. Tooling in this repo

| tool | what it does |
|---|---|
| `tools/mars-terrain/plan.ts` | region/ring planner for the generator: site + rings → chunk list with real metric sizes, byte estimates and caps. Typechecked and tested here; shipped to the generator by copy. |
| `tools/mars-terrain/pregenerate.ts` | drop-in replacement for `build.ts`'s full-face sweep (`npx ts-node src/pregenerate.ts --site … --bands …`). Not runnable from this repo — it imports the generator's `src/`. |
| `tools/mars-port-check.mjs` | the comparison above (`npm run check:mars-port`). |
| `tools/mars-terrain/README.md` | install instructions, CLI flags, and the size table repeated for the generator side. |
