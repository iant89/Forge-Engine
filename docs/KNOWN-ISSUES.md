# Known issues and limitations

Kept current at the end of every phase. Each entry says what is missing or approximate and where
the honest detail lives; nothing here is hidden behind a green gate.

## Rendering (Phase 2)

* **Shadow vertex work still repeats across overlapping maps.** The renderer assigns each
  renderable a conservative mask from its world AABB and submits only assigned instance ranges;
  adjacent ranges whose masks include the same map are coalesced into one draw. When an object's
  bounds intersect multiple cascade, spot or point-face frusta, it must still be processed by each
  map; no per-map GPU compaction is implemented, and non-adjacent assigned runs may need multiple
  draws. A single-map heuristic is intentionally not used because it could drop valid shadows.
  `stats.shadowsDrawn` reports draw submissions; `shadowInstancesDrawn` and `shadowInstancesCulled`
  expose per-map caster work. (`docs/RENDERING.md` §9) (capability: rendering.shadowCascades)
* **Shadowed-light coverage is bounded.** The highest-priority shadow-casting directional light,
  up to four spot lights and up to two point lights receive maps; priority combines brightness and
  local-light influence area rather than scene order. Contact shadows remain deferred. Maps share
  a resolution that adapts to the configured shadow-memory budget. (capability: rendering.shadows)
* **The prepass depth has three consumers so far.** SSAO, the soft-particle fade and the object
  culler's HiZ pyramid read it; no transparency technique and no depth-based post effect uses it.
  (`docs/RENDERING.md` §9) (capability: rendering.depthReuse)
* **Object culling is per batch, and the batch still pays for its uploads.** `forge.objects.cull`
  drops the *draw* of a batch the frame cannot see — since 13.6 by writing a zero-instance indirect
  record, so a culled batch no longer enters the vertex stage at all — but `collectBatches` and the
  instance/object arenas still run for every renderable, one visible instance keeps its whole batch,
  the CPU twin (the mock device's path) has no depth buffer and therefore no occlusion test, and only
  the first `MAX_CULLED_BATCHES` (8192) batches of a frame are tested — the rest stay visible rather
  than being wrongly culled, and their records keep the count the CPU uploaded. The device path's
  counters are one frame late (a readback cannot be known sooner). (`docs/RENDERING.md` §4d, §4e)
  (capability: rendering.cullCoverage)
* **The compaction list is produced but not yet consumed by the upload path.** `cull.visibleBatches`
  names the surviving batches in the device's own order, and the records are one per *batch*, so the
  instance arena is still written and bound for every renderable — a denser arena (a `firstInstance`
  offset per slot, one record per visible batch) is the next step that would save the upload and is
  not scheduled. Records are only written when `Renderer.indirectDraws` is on, the shadow cascades
  keep their own per-cascade AABB test rather than this pass, and a non-perspective or near-plane-
  straddling camera still skips the occlusion test. (`docs/RENDERING.md` §4e)
  (capability: rendering.cullCoverage)
* **Cutout, fading and water surfaces are not in the depth prepass.** Alpha-tested, `opacity < 1`,
  transparent and water draws are shaded by `forge.main` exactly as without a prepass: no early-Z
  saving, and they neither receive nor cast SSAO (the forward shader's bilateral key finds no AO
  texel for them and leaves them unoccluded). Orthographic cameras run the prepass but not SSAO.
  (capability: rendering.prepassCoverage)
* **The cluster grid's preparation and counting pass are still CPU work, every frame.** The *fill*
  (the lists) runs on the device by default — `forge.lights.assign`, one compute pass, no read-back
  (`docs/RENDERING.md` §4c) — and the CPU fallback uploads the lists' used prefix (≈ 43 KB for the
  demo's 40-light rig). `prepare` (O(lights)) and `count` (O(lights × slices + clusters)) stay on the
  render thread because their output is needed exactly and immediately and neither grows with how much
  of the frame the lights cover, but they are still per-frame render-thread work, and the three cluster
  buffers cost ≈ 416 KB of VRAM from the first frame whether or not a scene clusters.
  (`docs/RENDERING.md` §4b, §4c, §9) (capability: rendering.clusterCoverage)
* **256 local lights, 32 per cluster.** Past `MAX_CLUSTERED_LIGHTS` the frame truncates; past
  `MAX_LIGHTS_PER_CLUSTER` candidates in one cluster, the least influential (intensity × colour luma)
  are evicted *there* — so a dense rig in a small volume loses its dimmest lamps while the rest of the
  scene keeps them. Both are reported (`stats.lightsDropped`, `stats.maxLightsPerCluster`) instead of
  silently dropping a lamp the way the old 16-entry list did. (`docs/RENDERING.md` §4b)
  (capability: rendering.clusterCoverage)
* **Orthographic cameras are not clustered.** The grid's depth axis is view depth, which an
  orthographic projection does not put in `clip.w` (the same reason SSAO is perspective-only), so their
  local lights still go through the fixed 16-entry uniform list and still truncate at
  `MAX_LIGHTS_PER_FRAME`. (`docs/RENDERING.md` §4b) (capability: rendering.clusterCoverage)
* **Bloom and tone mapping are not compared against reference images.** The browser gate proves
  presence and direction (A/B luminance) and the pass structure; visual quality is an eyeball check
  on `tools/.browser-check.png`. (capability: rendering.postFxVerification)
* **WebKit is not run.** Uniform layout strictness and constant-argument strictness are enforced
  statically (`check:wgsl`, `tests/rendering/wgsl.test.ts`); no Safari build exists in the sandbox, and the
  Chromium the sandbox runs is newer — and more permissive — than the one the advisory gate
  downloads. (capability: platform.webkitCompile)

## Core (Phase 1)

The worker round-trip and resource-eviction test gaps are gone (`tests/core/tasks.test.ts`,
`tests/resources/resources.test.ts`). Phase 9.1 also verifies core glTF/GLB mesh decoding on Node and browser
workers. `MeshBvh` now backs triangle-accurate scene picking and large-mesh frustum refinement;
PhysicsWorld uses deterministic sweep-and-prune for rigid-body pair candidates.

* **Core glTF import is geometry-first.** `decodeGltfMesh` handles static, uncompressed triangle
  primitives and returns typed vertex/index arrays, bounds, node transforms, scene roots and material
  factors, and (Phase 16.1a) skins with four-influence JOINTS_0/WEIGHTS_0 streams. Extra
  JOINTS_n/WEIGHTS_n sets are ignored when all-zero and rejected when they carry weight; strip them
  with `npm run gltf:strip-skin-sets` (`--force` drops weighted ones, losing accuracy). Textures
  (16.1c, `loadGltfTextures`) bind baseColor / emissive / metallicRoughness / normal / occlusion maps
  with per-texture samplers, on TEXCOORD_0 only: a map with `texCoord: 1` is dropped with a warning
  (deferred to ROADMAP 16.1g), and KHR_texture_transform and KTX2 images are ignored. alpha MASK
  cutouts still cast full-quad shadows (the shadow pass has no material). glTF assets are mirrored
  from glTF's right-handed frame into the engine's left-handed one at import (x → -x, warns once per
  file); a file baked with `npm run gltf:fix-handedness` loads as-is but is mirrored in other glTF
  viewers. The Mars showcase's own Perseverance loader (`examples/src/assets/glb.ts`) does not apply
  this conversion. It does not import morph targets/instancing or decode Draco/meshopt
  compression; those are tracked for the extended glTF importer (16.1b, 16.1d, 16.1e). Skinned primitives cull against posed bounds
  (per-joint bind boxes carried by the live joint matrices), which are conservative: a box per joint
  can be looser than the deformed mesh.
  (capability: assets.gltfAdvanced)

* **Streaming loader cancellation is cooperative.** `AssetStreamer` (Phase 15.3) gates when loads
  *start* — priority, concurrency cap and per-frame upload budget — and safely disposes a completed
  in-flight result after cancellation. JavaScript cannot interrupt an arbitrary synchronous loader
  body, so loaders must poll `ResourceLoadContext.signal`; queued cancellation remains immediate.
  The glTF decoder polls worker cancellation, while `.gltf` sidecar network fetches remain host-side.
  (capability: assets.loaderPreemption)

## Asset Pipeline (Phase 15)

* **KTX2 3D/volume textures are not supported.** The current Basis JS binding exposes mip/layer/face
  transcoding but not volume slices; `loadKtx2Texture` rejects depth-bearing inputs instead of
  silently uploading an incomplete image. 2D, 2D-array, cube and cube-array paths are supported.
  (capability: assets.ktx2Volume)


## Terrain (Phase 10)

* **Mars Showcase is analytic-only; no erosion cache is hosted.** The showcase now uses
  `createMarsPipeline(...)` at the equatorial plain, but the simulated-erosion correction needs the
  generator's real `cache/global/` fields (~30 MB for six faces), which this repository does not ship.
  `check:mars-port` has not yet verified fidelity against that real cache; the synthetic-cache smoke
  test is not evidence of agreement with upstream. `docs/MARS-TERRAIN.md` §5–6 describes both paths.
  (capability: terrain.marsGeneratorPort)
* **Mars still has main-thread work.** Analytic cell grids now generate on workers (nine warm-up
  requests, then one per frame in the showcase), but mesh construction/uploads and missing-cell
  camera/vehicle queries remain synchronous. Live Stage A field caches cannot be reconstructed on a
  worker yet: those pipelines require the live-instance fallback, preferably `syncGeneration: true`
  to bypass the rejected worker hop. Missing/blocked workers also fall back inline. This is a
  chunk-count budget, not a millisecond guarantee. (capability: terrain.marsGeneratorPort)
* **Mars subregional splats are procedural veneers, not upstream geology.** `terrain.marsGeneratorPort`
  still classifies one dominant material per broad terrain region, but `MarsTerrainStage` now overlays
  two related dust/rock/sand/crust channels with a seeded 40–170 m planet-space field. This gives
  128 m tiles deterministic local variation while keeping the classifier's substrate dominant and
  the masks identical at coincident LOD vertices. It does not change terrain geometry, material IDs,
  or Stage A erosion, and it does not claim to reproduce measured sediment transport or a finer
  upstream material map. `?scene=mars-generator&marssite=0,0` remains the shipped inspector for seeing
  those veneers alongside the real crater-rim material boundary. (capability: terrain.marsGeneratorPort)

## Vehicles (Phase 6 / 11)

Phase 11 connected the raycast car to the physics heightfield and a kinematic chassis collider.
What remains:

* **Longitudinal slip is solved, not freely integrated, while the tire can balance the demand.**
  Past the peak, and only when TC/ABS are not clamping, the residual torque spins the wheel. Do not
  expect a stable explicit-Euler wheel at 120 Hz — that path limit-cycles, which is why it was removed. (capability: vehicles.tireModel)
* **No continuous collision detection.** High-speed impacts use discrete contacts; tunneling a thin
  prop at extreme speed is still possible. (capability: physics.ccd)

## Particles (Phase 12)

* **Mesh particles are deferred.** The GPU full-sim writes a 4-sample trail history per particle and
  the vertex stage draws it as ribbon strips (12.4/12.7); billboards / stretched billboards / soft
  particles draw from the storage buffer. There is no mesh-particle path: particles cannot draw user
  geometry. (capability: particles.gpuRendering)
* **HiZ / depth occlusion culling is deferred.** Frustum + distance cull compact the draw list;
  hierarchical Z is not built. (capability: particles.gpuRendering)
* **GPU particle collision is deferred.** Soft particles *sample* the scene depth for a fade; they
  do not bounce off terrain or the depth buffer. (capability: particles.gpuRendering)

## Environment (Phase 8a)

* **Multiple scattering is an approximation with a shaped error.** Phase 17.1 adds the second-and-
  higher orders as an isotropic source (`J₁ = (1/4π)∫L₁dω`) summed as a geometric series with the
  local scattering ratio, into a `height × sun-elevation` table the sky pass samples per march step.
  Measured against the sphere mean of the model's own single scattering: the device table holds
  ±5 % in daylight below ~25 km and the CPU one ±17 %; the terminator columns (|μ_sun| < 0.1, where
  the table changes by orders of magnitude within one column) are good to a factor of ~2; below each
  height's own horizon the table is exactly zero. Two terms are deliberately absent: there is **no
  ground bounce** (the planet is black to the table, worth 1.5-2.2× of the sphere mean at 20 km with
  the default albedo) and the higher orders are treated as **isotropic**, so a wavelength-dependent
  Mie lobe is not represented. A field built on the CPU is opt-in: assign it to
  `AtmosphereModel.multiScattering` (the renderer's own table is built on the device and the derived
  ambient/fog colours gain the term only through that assignment). (`docs/ENVIRONMENT.md` §8)
  (roadmap: 17)
* **The sky pass is not affected by linear or exp² fog.** Only height fog (whose path integral is
  finite for upward rays) fogs sky pixels; linear/exp² fog would erase the whole sky over an infinite
  path. The planet ground the pass draws below the horizon *is* fogged in every mode, and
  `DayNightCycle.driveFog` keeps the fog colour equal to the sky just above the horizon, so seams
  only appear when a scene sets a fog colour that disagrees with its sky. (`docs/ENVIRONMENT.md` §4) (capability: environment.skyFogModes)
* **Nights are a full-moon sky with no lunar phases.** Nights include an atmosphere-attenuated
  anti-solar full moon and stars over `nightAmbient`, but the moon has no phases or orbital
  inclination. (roadmap: 17)
* **The sun disc is not a physical radiance.** `sunDiscIntensity` (default 100× the sun's
  transmitted irradiance) is a look control; the real disc (~14 700×) would bloom the whole frame. (capability: environment.sunDisc)
* **Mars' blue sunset aureole is not modelled.** It needs a wavelength-dependent Mie lobe; the preset
  has one `g`, and the LUT's higher orders are deliberately isotropic (Phase 17.1). The daytime
  butterscotch sky and the bright forward aureole are there. (roadmap: 17)
* **Fog is per-fragment and unshadowed.** No volumetric light shafts; the fog colour does not depend on
  the view direction (the sky's horizon average is used). (roadmap: 17)

## Environment (Phase 8b)

* **Screen-space water sees only the screen; the shore is analytic.** Since 17.5 the high tier
  (`water.screenSpace = "full"`) refracts and absorbs through the real depth buffer and
  ray-marches reflections, but SSR finds only on-screen content (elsewhere the sky reflection
  stands in), the low tier and LDR frames keep the sky-only water, there are no caustics, and the
  underwater path is still the sky skip plus murk fog. Shore breaking and swash come from an
  *analytic* bed (`water.shore`, two sinusoids even with fe-34's `curveAmp*`), so they only line
  up with terrain built from the same parameters (`coastalTerrainSource`); contact foam does follow
  the real geometry. The cyclone eye hole (`eyeHole`) is a dense ring at deck height on a flat slab,
  scaled toward the observer, and its centre assumes the render origin is the world origin.
  (roadmap: 17)
* **Weather wets surfaces under cover, and its audio bypasses the mixer.** The 17.4 surface state is
  one scene-wide value: ground under a roof gets wet and snowy too, and puddle basins are noise, not
  terrain hollows. `StormSoundscape` connects to the context's destination rather than a mixer bus.
  (roadmap: 20.6)

## World population (Phase 14)

* **Per-instance population culling has a one-frame lag and per-path limits.** `forge.populationCull.views`
  and `forge.populationCull` (docs/RENDERING.md §4g) cull instanced population batches per instance for
  the prepass, `forge.main` and every device-culled shadow map, but LOD switches and the distance
  cut land one frame late (the cut is invisible: the distance fade has shrunk an instance to nothing
  by then); shadow-only chunks (no part in view) keep the CPU per-instance caster
  assignment; on the low tier spot and point maps keep it too (`populationShadowCulling: "cascades"`);
  the shadow caster LOD bit is the camera-distance one, as before; and on the per-batch fallback (CPU
  object culling, `indirectDraws` off, `populationCulling` off) culling stays per chunk. On frames
  without occlusion `forge.main` draws the prepass list even when the object culler culled the whole
  batch (no visible difference: that list is already frustum-tested per instance). The mock device runs
  the CPU twins without HiZ. The distance fade is a scale-down about the instance pivot, not a dither:
  a half-buried rock sinks as it shrinks, and a very large prototype visibly shrinks rather than
  dissolving. (capability: world.population)
* **Placement depends on the tile resolution the chunk first became ready at.** Slope/height
  acceptance samples the resident tile's heightmap at whatever LOD was live when the chunk was
  populated; a chunk that first appears at a coarse LOD may keep slightly different instances than
  one that appeared at LOD 0. XZ placement, scale, rotation and tint are stable forever after (an
  LOD remesh re-anchors Y to the new surface instead of re-scattering), and the same warm-up
  sequence is bit-for-bit reproducible — but "same chunk, any load order" is not guaranteed until
  placement samples a resolution-independent surface. (capability: world.population)
* **Population generation is main-thread inline.** Populating a chunk is one bounded scatter pass
  per type over the resident heightmap (budgeted by `generationsPerFrame`), not a `TaskScheduler`
  job — unlike terrain cells, which generate in workers. Moving it behind a task needs the
  heightmap samples available off-thread. (capability: world.population)
* **Population rendering has no raycast or per-instance visibility.** All six Phase 14.2 types
  (rocks, boulders, debris, rosette vegetation, decals, mineral spires) now draw as batches, but
  picking/debug tools cannot hit them and the device culls only whole chunk/type bounds (noted
  above). Placement still depends on the tile LOD at first readiness, and generation is inline on
  the main thread (noted above). (capability: world.population)

## Scripting (Phase 18)

* **A hook that never returns hangs the frame.** Error isolation catches throws, not infinite
  loops: JavaScript cannot interrupt synchronous script code. (`docs/SCRIPTING.md`)
  (capability: scripting.lifecycle)
* **Fixed steps are not interleaved across systems.** `scripts.fixed` runs all of a frame's fixed
  steps before `vehicles` runs its own, like every `FixedSystem`; a script cannot read the vehicle
  state between two steps of the same frame. (capability: scripting.lifecycle)
* **The API boundary is partial (18.6).** The script context carries no GPU, render or solver
  handles, but a script can reach every component on its entity, including ones that wrap GPU
  state. Typed events and hot reload (18.4, 18.7) are not built.
  (capability: scripting.lifecycle)

## Documentation debt

`ARCHITECTURE.md` describes the target design and refers to documents that do not exist yet
(`PERFORMANCE.md`, `ASSETS.md`, ADRs). Sections marked "As built" in `ARCHITECTURE.md` and
`docs/RENDERING.md` describe what is real today. `ROADMAP.md`'s status block, this file and
`engine/src/core/capabilities.ts` are cross-checked by `npm run docs:check` (Phase 9.6), so a phase
cannot be advertised as verified while a capability inside it is not, and a limitation cannot outlive
its implementation. An earlier revision of the roadmap marked phases done without the code; that is
what the gate now makes impossible to repeat silently.

## Snow melt and mud (fe-38)

* **Melt ignores shadows.** Each cover takes the full sun from its own facing. Shaded snow (under a car, or behind a rock) melts as fast as sunlit snow. (roadmap: 17)
* **Chunks are simple projectiles.** Shed clumps slide on their own source shape, then fall onto the terrain height. They do not hit other objects or each other. (roadmap: 17)
* **One drying climate per field.** Drying and evaporation use the scene-wide sun and humidity, with no per-cell shading. (roadmap: 17)
* **Puddles reflect only the sky.** The standing-water film is a smooth, flat surface lit by the environment and sky. It shows no reflections of the objects around it. (roadmap: 17)
* **Only sphere and box covers.** Vehicles and rocks are approximated by their bounding sphere or box. (roadmap: 17)
