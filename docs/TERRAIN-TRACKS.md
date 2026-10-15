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
