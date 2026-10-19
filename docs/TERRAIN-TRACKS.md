# Spline-carved tracks (fe-37)

`engine/src/terrain/track.ts` and `engine/src/terrain/trackSurface.ts`. Reusable pieces for any
road, trail or race course cut into a height function. First user: the off-road hill demo
(`?scene=offroad`, `examples/src/scenes/offroadHillScene.ts`).

## What it gives you

| API | What it does |
| --- | --- |
| `TrackSpline(points, { closed, step })` | Catmull-Rom centreline resampled at a uniform arc-length step. `sampleAt(s)` gives position + unit tangent; `project(x, z)` gives nearest arc length, signed lateral offset (+ = right of travel) and distance, using a uniform-grid index built by `buildIndex(radius)`. Outside the indexed corridor `dist` is `Infinity`. |
| `TrackTerrain(base, spline, profile)` | Carves the track into `base(x, z)`. Road bed = natural height under the centreline, box-filtered twice along the track over `bedSmoothing` m (rises and falls over crests, no per-bump following). Profile across: crown, two tyre ruts (`rutOffset`, `rutWidth`, `rutDepth`), flat shoulder, raised-cosine berm (`bermHeight`, `bermWidth`, wandering ±`bermVariation`), then a smoothstep back to natural ground over `blendWidth`. `heightAt`, `normalAt`, `surfaceAt` (road / rut / berm weights), `heightAtOffset(s, lateral)` (projection-free, used by meshes), `poseAt(s)`, `minLegSeparation()`. |
| `trackRibbonSource(track, { from, to, across, alongStep, lift, uvMetersAlong })` | Strip between two lateral offsets following the spline: `u` across (0 at `from`), `v` = metres along / `uvMetersAlong`. Normals and tangents are computed from the profile, so normal maps work. Use one for the road and one per side for the berms. |
| `trackTerrainGridSource(track, cx, cz, size, segments, { corridorSink, sinkTo })` | Regular ground grid over the carved surface with tangents. Sinks under the corridor so the ribbons always cover it (a coarse grid otherwise pokes through at the berm toes). |
| `scatterAlongTrack(track, { seed, lateralMin, lateralMax, density, weight, palettes, … })` | Deterministic placements in a lateral band on both sides (or one). Rejects points closer to another leg of the track. Used for leaf litter, brush and trees. |
| `litterQuadsSource(track, placements, { size, aspect, lift })` | Merges small surface-aligned cards (fallen leaves) into one mesh; build one per palette/material. |
| `TrackLapTimer(spline, { startS, checkpoints, maxStep })` | Start/finish timing on a closed spline: starts on the first forward crossing, counts a lap only after the checkpoints are passed in order; `resync()` after a teleport. |
| `gravelRoadPixels` / `createGravelRoadTextures` | Gravel/dirt road albedo + normal + MR. Rut bands sit at the same lateral offsets as the carved ruts (pass the same `rutOffset`/`rutWidth` and the ribbon's half-span), tread streaks run along them, stones and leaf specks scattered (more at the edges). Tiles in `v` only. |
| `grassBermPixels` / `createGrassBermTextures` | Short grass / hydroseed cover (blade noise, clumps, pale mulch specks). Tiles in both axes; also usable as a forest floor with a brown base and `mulch: 0`. |

## Grading a road into streamed terrain (`TrackGradingGenerator`, fe-39)

`TrackTerrain` carves a height *function*, which is what a fixed ground mesh wants. A `TerrainWorld`
streams chunks that a `GeneratorPipeline` produces (inline or on a worker), so a road has to be cut
into the *cells*. `engine/src/terrain/trackGrading.ts` is that pipeline stage; the Alpine rescue demo
(`?scene=alpine-rescue`) uses it for its service track and depot yard.

| API | What it does |
| --- | --- |
| `GradedCorridor { points, bed, halfWidth, blendWidth }` | One road: a centreline polyline (`[x0, z0, x1, z1, …]`), a bed elevation per point, the half-width of the level bed and the smoothstep distance over which it eases back into the natural ground. |
| `designBedProfile(natural, step, { smoothing, maxGrade })` | Designs the bed from natural centreline heights sampled every `step` m: a double box filter (crests are cut, sags filled, not followed), then a symmetric grade limit — the mean of the highest and lowest `maxGrade`-Lipschitz envelopes, which leaves any stretch that already meets the limit untouched. Pure and deterministic. |
| `TrackGradingGenerator({ corridors })` | The stage. Every vertex is graded from its **own world position and natural height only**, so two chunks that share a border vertex agree on it and every LOD resolution samples one surface. Corridors apply in order (put a wide pad before the road that leaves it). |
| `TrackGradingGenerator.identity` / `fromIdentity` | The complete configuration as canonical JSON (numbers rounded to a millimetre). It travels in the `TerrainPipelineSpec` (kind `track-grading`) like the Mars stage: workers rebuild it, the pipeline hash (cache key) changes with it, saved scenes carry it. `fromIdentity` rejects malformed or non-canonical text. |

How the demo wires it (`examples/src/scenes/alpineRoute.ts`, `alpineTerrain.ts`):

1. Sample the analytic natural height (`RealisticHeightGenerator.sampleHeight`) along a `TrackSpline`
   through the mission's centre line, and `designBedProfile` it (48 m smoothing, 10 % grade limit).
2. Describe the road (6 m level half-width, 10 m blend) and a depot pad as corridors, pad first.
3. Build the pipeline `height → grading → slopes` and give it to the `TerrainWorld`. The road ribbon
   (a lit, normal-mapped packed-snow strip) is built from the same bed, so ribbon, terrain mesh and the
   vehicle's ground query agree inside the level core.
4. `createGradedHeight` runs the stage on a one-vertex cell, so build-time placement (forest, boulders,
   markers) stands on the surface the streamed chunks will have, without waiting for them.

Measured on that 320 m route (raw hillside → graded): worst cross-slope along the centre line 62 % →
0.2 %, worst grade 87 % → 10 % (the design limit), cuts up to 5.2 m and fills up to 2.4 m (mean 1.1 m),
chunk-border mismatch 0 (pinned by `tests/terrain/trackGrading.test.ts` and
`tests/examples/alpineRoute.test.ts`).

Things to know:

* `Heightmap.getHeight` (the physics/vehicle surface) is bicubic Catmull-Rom over the 4 m grid, while the
  rendered mesh is linear on the same vertices, so beside a sharp feature the two differ by centimetres.
  Keep the level core wider than the surface you draw on it (the demo grades ±6 m for a ±3.4 m ribbon)
  and lift decals a few centimetres.
* The stage cannot sample the natural ground along the centreline (neighbouring chunks may not exist
  yet), which is why the bed is designed up front and handed in.
* It carves a level bed, not ruts or berms: at the 4 m chunk grid those cannot be represented. Ruts, banks
  and grit live in the road ribbon's normal map; use `TrackTerrain` + `trackTerrainGridSource` when you own
  a fine ground mesh and want real ruts and berms.

## Contracts and limits

* The same `heightAt` must feed the vehicle (`heightFunctionGround`), physics and meshes. That is
  what makes the berms real collision: wheels climb them and the chassis is lifted and rolled
  (pinned by `tests/terrain/trackTerrain.test.ts`, "berms are real collision").
* The profile is symmetric in `|lateral|`. Keep curve radii above the ribbon's outer offset and
  legs at least `2 × corridorHalfWidth` apart, or the nearest-point projection switches legs inside
  a corridor and leaves a crease. `minLegSeparation()` checks it.
* Per-surface grip is not wired: `surfaceAt` reports road/berm weights, but the vehicle still uses
  one `mu` (plus the Phase 17 weather grip). A per-wheel surface grip hook is future work.
* Everything is CPU-built static geometry. A 900 m loop at the high tier is ~0.3 M triangles of
  terrain/ribbon/forest in a few dozen draws.
