# Procedural vegetation and track weather (fe-37b)

## Trees — `engine/src/population/tree.ts`
`generateTree(species, seed, lod)` returns `{ wood, leaves, height, crownRadius }` as `GeometrySource`s.
Pure and deterministic. The trunk and up to 3 branch levels are tapered, curved tubes laid out with golden-angle phyllotaxis, `branchAngle`, `lengthRatio`, `gravitropism`, and a crown `shape` (round, conical, columnar or vase).
Leaves are alpha-cut cards whose normals are bent out from the crown. Use `leafCardPixels` with `Material.alphaTest ≈ 0.5` and `doubleSided`.
`"lo"` is the same skeleton without its last level, with fewer, larger cards (under 40% of the hi triangles).
Leaves are white-balanced, so per-instance `Renderable.tint` sets the colour. `barkPixels` makes a tiling bark texture (furrowed or birch).

## Grass — `engine/src/population/grass.ts`
`grassPatchSource(options, lod)` builds real tapered, curved blades rooted `sink` below the ground. `"lo"` keeps every third blade (density LOD).
`grassBladePixels` gives a root-to-tip gradient for tinting.

## VegetationField — `engine/src/population/vegetation.ts`
A `SceneObject` holding models (parts = hi/lo geometry + material) and instances (position, yaw, scale, tint, optional ground normal).
Instances are `Renderable` entities spawned part-major and model-major, so the renderer merges them into instanced draws.
Every `refreshInterval` it applies hide (`maxDistance`) and hi/lo (`lodDistance`), both scaled by `distanceScale` for tiers.
Instances inside `swayDistance` lean about their root through `windSway`. `setSurface(wetness, snow)` writes per-object snow/wetness to the materials.
Limits: the sway is a whole-plant lean (no per-vertex bending). Leaf shadows are card-shaped, because the depth pass has no alpha test.

## Track weather — `engine/src/terrain/trackWeather.ts`
`TrackWeatherGround(track)` lays a `GroundMoistureField` over the track. Soils come from the cross-section: gravel road, grass berms, dirt beyond.
`gripAt` is a `SurfaceGripField`: per-surface dry grip and wet loss (`TRACK_SURFACE_GRIP`; wet grass is much worse than wet gravel), × mud × standing water × snow (snow counted once).
Set `WeatherSystem.driveVehicles = false` with it.
`applyCondition(TRACK_GROUND_CONDITIONS.*)` snaps a preset. `update(dt, env)` steps the field at `timeScale`.
The field is drawn with `MoistureOverlayMaps` + `withFieldUvs` (`rendering/moistureGround.ts`): a transparent overlay whose alpha is mud/water/snow coverage, capped by `maxAlpha`, so the coarse grid never replaces a detailed road texture.
Remember `Renderable.transparent = true` on the overlay renderables.

## Renderer note
Count-1 batches draw through the non-instanced entry, which now reads the tint from the batch's instance record (`objectData.instanceCount == 1`). Before this, a lone tinted renderable drew untinted.
