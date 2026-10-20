# Procedural vegetation, track weather and tyre tracks (fe-37b/c)

## Trees — `engine/src/population/tree.ts`
`generateTree(species, seed, lod)` returns `{ wood, leaves, height, crownRadius }` as `GeometrySource`s.
Pure and deterministic. The trunk and up to 3 branch levels are tapered, curved tubes laid out with golden-angle phyllotaxis, `branchAngle`, `lengthRatio`, `gravitropism`, and a crown `shape` (round, conical, columnar or vase).
Leaves are alpha-cut cards whose normals are bent out from the crown. Use `leafCardPixels` with `Material.alphaTest ≈ 0.5` and `doubleSided`.
`"lo"` is the same skeleton without its last level, with fewer, larger cards (under 40% of the hi triangles).
Leaves are white-balanced, so per-instance `Renderable.tint` sets the colour. `barkPixels` makes a tiling bark texture (furrowed or birch).

## Bushes — `generateBush` in `engine/src/population/tree.ts` (fe-37c)
`generateBush(species, seed, lod)` has the same contract as `generateTree`: same seed gives the same bush, `"lo"` is a cheaper twin, and it drops straight into a `VegetationField` model.
It grows `stems` (default 5) thin two-level leaders from one root crown, each leaning out by `spread` and densely carded so the mass reads solid.
Stems are sunk 0.3 m like a tree trunk, so a bush never floats on a slope. The off-road demo uses 2–4 variants as understory.

## Grass — `engine/src/population/grass.ts`
`grassPatchSource(options, lod)` builds real tapered, curved blades rooted `sink` below the ground. `"lo"` keeps every third blade (density LOD).
`grassBladePixels` gives a root-to-tip gradient for tinting.

## VegetationField — `engine/src/population/vegetation.ts`
A `SceneObject` holding models (parts = hi/lo geometry + material) and instances (position, yaw, scale, tint, optional ground normal).
Instances are `Renderable` entities spawned part-major and model-major, so the renderer merges them into instanced draws.
Every `refreshInterval` it applies hide (`maxDistance`) and hi/lo (`lodDistance`), both scaled by `distanceScale` for tiers.
Instances inside `swayDistance` lean about their root through `windSway`. `setSurface(wetness, snow)` writes per-object snow/wetness to the materials.
Shadow casting is a **third ring** (fe-37d): a model's `shadowDistance` (default `Infinity`) turns `castShadow` off on its parts past that range, so a forest stops paying for shadows it cannot show. `stats_`/`stats()` report `casting` alongside `hidden`, `hi`, `lo` and `swaying`. Keep `maxDistance` finite: a model left at `0` is drawn forever, and its casters walk the shadow pass every frame.
The off-road hill demo had exactly that: ~3500 trees with `maxDistance: 0` and both parts casting, so facing the treeline cost ~6700 visible renderables and thousands of casters. With `maxDistance` 70/105/145 m, `shadowDistance` 26/38/52 m and `lodDistance` 16/22/30 m (low/medium/high), the same view draws ~2800 renderables with 664 casters.
Limits: the sway is a whole-plant lean (no per-vertex bending). Leaf shadows are card-shaped, because the depth pass has no alpha test.

## Track weather — `engine/src/terrain/trackWeather.ts`
`TrackWeatherGround(track)` lays a `GroundMoistureField` over the track. Soils come from the cross-section: gravel road, grass berms, dirt beyond.
`gripAt` is a `SurfaceGripField`: per-surface dry grip and wet loss (`TRACK_SURFACE_GRIP`; wet grass is much worse than wet gravel), × mud × standing water × snow (snow counted once).
Set `WeatherSystem.driveVehicles = false` with it.
`applyCondition(TRACK_GROUND_CONDITIONS.*)` snaps a preset. `update(dt, env)` steps the field at `timeScale`.
The field is drawn with `MoistureOverlayMaps` + `withFieldUvs` (`rendering/moistureGround.ts`): a transparent overlay whose alpha is mud/water/snow coverage, capped by `maxAlpha`, so the coarse grid never replaces a detailed road texture.
Remember `Renderable.transparent = true` on the overlay renderables.

## Tyre tracks — `engine/src/terrain/tireTracks.ts` (fe-37c)
`TireTrackMap` is a set of world-space tiles (`tileSize` m, `tileResolution`² texels), created on demand where wheels go. At most `maxTiles` exist; past that, the least recently stamped tile is recycled (a ring over the area driven).
`stamp(x0, z0, x1, z1, width, surface, load)` paints a capsule with a soft tread profile. Each pass cuts `depth × load × 0.5`, up to 2× the style depth, and `depthAt(x, z)` reads it back.
`TIRE_MARK_STYLES` sets colour, coverage alpha and roughness per surface: gravel compacts slightly darker, grass flattens dark green, snow packs down, and mud cuts deep ruts.
Only mud ruts hold water. Their deep middle carries the MR-alpha water mark, so the standard shader gives them the puddle film.
`fadeTime` (default 0 = never) decays marks by 1/e per `fadeTime` seconds.

`TireTrackLayer(device, { heightAt, … })` is the `SceneObject` that draws it: one transparent, non-shadow-casting mesh per tile following `heightAt` (lifted `lift`, 0.045 m), with dirty tiles re-uploaded at most every `uploadInterval`.
`followVehicle(vehicle, surfaceAt)` stamps each grounded wheel's contact every frame. A move over 3 m in one step (a reset or teleport) re-seeds the wheel instead of painting a streak.
Evicted tiles and `onDetach` release their GPU textures, geometry and entity. Pinned by `tests/terrain/tireTracks.test.ts`.

## Touch wheel and pedals — `examples/src/controls/touchWheel.ts` (fe-37c)
Demo-side input, shared by any driving scene. `attachSteeringWheel(el, { maxAngle = 135, returnRate = 10, rim })` follows the finger around the control's centre (hand-over-hand works), clamps to ±`maxAngle` and springs back on release; `value()` is steer −1..1.
`attachPedal(el)` is hold-to-press, with pressure set by how far down the pedal the finger sits (top 0.35 → bottom 1).
Each control tracks only its own pointer, so steering and pedals work together (multi-touch). The off-road touch layout puts the wheel on the left, GAS/BRAKE on the right, and the gear switch top right.
The control is a drawing, so a scene can dress it for the machine: `#offroad-wheel` is a steering wheel for the demo's UTV, and the same gesture would steer handlebars (`maxAngle: 45`, `returnRate: 14`) on a quad or bike.

## Renderer note
Count-1 batches draw through the non-instanced entry, which now reads the tint from the batch's instance record (`objectData.instanceCount == 1`). Before this, a lone tinted renderable drew untinted.

Puddle shading (fe-37c): the forward pass's puddle/wet-film reflection uses the ambient sky radiance (`ambientColor × ambientIntensity`), not `max(fogColor, 1.6 × ambient)`.
In rain the fog is a bright grey haze, and reflecting it made every puddle pale grey at road brightness. Measured on the rain frame, puddles went from 89/86/67 to 68/59/48 sRGB against a ~101/89/62 wet road.
