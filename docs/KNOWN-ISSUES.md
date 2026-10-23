# Known issues and limitations

Kept current at the end of every phase. Each entry says what is missing or approximate and where
the honest detail lives; nothing here is hidden behind a green gate.

## Diagnostics (Phase 21)

* **GPU particle worlds report counters, not particles.** The Inspector's Particles tab shows
  backend, capacity, alive/emitted counts, emitter settings and a bounded sample of particles for CPU
  worlds, and draws their bounds; a GPU world's particle buffer is not read back, so it gets counters
  and emitter settings with no particle rows and no overlay. (capability: diagnostics.particleDebugger)

## Benchmarks (Phase 22)

* **Only the core benchmark matrix is complete, and history is not compared automatically.** Phase
  22.1 now measures ECS, allocation-free math, inline scheduler dispatch/deduplication and resource
  loading/cache/eviction with correctness and catastrophe guards. The runner can write a schema-1
  JSON snapshot with exact host metadata, and `PERFORMANCE.md` records the first measured baseline,
  but rendering, terrain, physics, particle/world scale sweeps remain incomplete. There are no stable
  metric IDs, repeated-sample variance or same-host regression policy yet, so ordinary timing drift
  does not fail CI automatically. (capability: diagnostics.benchmarkRegression)

## Rendering (Phase 2)

* **Shadow vertex work still repeats across overlapping maps on the fallback path.** The device
  path now appends per-instance caster indices in `forge.populationCull.views` for ordinary static
  instanced batches and population batches, while non-instanced, skinned, transparent and CPU-mode
  batches retain conservative AABB/range submissions. A caster whose bounds intersect multiple
  cascade, spot or point-face frusta is intentionally tested/drawn for each map; the renderer cannot
  use a single-map heuristic without risking a missing shadow, and non-adjacent assigned runs may
  still need multiple fallback draws. `stats.shadowsDrawn`, `shadowInstancesDrawn` and the population
  shadow counters expose the work; world-scale submission remains future work (`docs/RENDERING.md` §4, §4h).
  (roadmap: 24.3)
* **Object culling is still per batch for ordinary non-instanced renderables, and uploads are not
  eliminated.** `forge.objects.cull` drops the *draw* of a batch the frame cannot see — since 13.6
  by writing a zero-instance indirect record — while `collectBatches` and the instance/object arenas
  still run for every renderable. Ordinary eligible static instanced batches additionally use the
  shared per-instance compactor: visible/occluded lists are batch-local, and shadow map indices are
  per-map. The CPU twin (the mock device's path) has no depth buffer and therefore no HiZ test, and
  only the first `MAX_CULLED_BATCHES` (8192) object batches are tested — the rest stay visible rather
  than being wrongly culled. Device counters are one frame late (a readback cannot be known sooner).
  (`docs/RENDERING.md` §4d, §4h) (roadmap: 24.3)
* **The batch compaction list is still a submission handoff, not arena compaction.** `cull.visibleBatches`
  names surviving object batches in device order, while generic instance culling writes per-batch
  records and local output buffers; the source arena is still uploaded and bound for every renderable.
  A future world-scale path can rewrite `firstInstance` and submit only a compacted arena, but that is
  separate from the completed per-instance visibility contract. Records are only written when
  `Renderer.indirectDraws` is on, and a non-perspective or near-plane-straddling camera still skips
  the object HiZ stage. (`docs/RENDERING.md` §4e, §4h) (roadmap: 24.3)
* **GPU-driven terrain visibility is not GPU-driven terrain submission yet.** Phase 24's first slice
  keeps opted-in streamed tiles in the device cull set (and indirect set when enabled) even when the
  CPU pre-test rejects them, but the CPU still walks each resident renderable, builds its batch,
  submits its prepass and issues one draw/indirect call. Until the visible list drives submission and
  arena compaction, moving the authoritative verdict to the GPU can increase CPU command work versus
  early CPU rejection; the `gpuDriven*` counters make that transitional cost explicit rather than
  calling it a speedup. (`docs/RENDERING.md` §4d) (capability: rendering.gpuDrivenWorld)
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
* **Orthographic cameras are not clustered.** The grid's logarithmic depth axis is not useful for an
  orthographic projection, so their local lights still go through the fixed 16-entry uniform list and
  still truncate at `MAX_LIGHTS_PER_FRAME`. SSAO is no longer part of this limitation: its orthographic
  kernel uses camera-forward depth and a constant pixels-per-metre radius. (`docs/RENDERING.md` §4b)
  (capability: rendering.clusterCoverage)
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

* **Core glTF import is geometry-first, not a complete scene-format importer.** `decodeGltfMesh` and
  `instantiateGltfScene` now cover uncompressed and meshopt/host-Draco triangle geometry, morph targets
  and animated weights, four-influence skins, `EXT_mesh_gpu_instancing`, TEXCOORD_0/TEXCOORD_1 texture
  routing, images/materials, node transforms and scenes. The remaining importer tail intentionally
  leaves KHR_texture_transform, KTX2/Basis image decoding, cameras and lights outside this slice;
  supplied Draco decoders stay on the caller's thread because their WASM state is not transferable.
  glTF assets are mirrored from glTF's right-handed frame into the engine's left-handed one at import
  (x → -x, warns once per file); a file baked with `npm run gltf:fix-handedness` loads as-is but is
  mirrored in other glTF viewers. The Mars showcase's own Perseverance loader
  (`examples/src/assets/glb.ts`) still does not apply this conversion and has not yet migrated to the
  engine importer (ROADMAP 16.1i). alpha MASK cutouts still cast full-quad shadows (the shadow pass
  has no material). Skinned primitives cull against posed bounds (per-joint bind boxes carried by the
  live joint matrices), which are conservative: a box per joint can be looser than the deformed mesh.
  (roadmap: 16.1)

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

## Physics (Phase 25)

* **The WASM memory ABI is not a WASM solver.** `WasmPhysicsMemory` now gives a future module stable
  f64 world/body records, optional SharedArrayBuffer seqlock publication and transferable exact state
  frames, but JavaScript still owns body topology and executes every broadphase, contact and solver
  step. `ForgeWasmPhysics` intentionally throws on gameplay calls rather than silently using the JS
  solver. There is no runtime add/remove command queue, worker ownership handshake, JS/WASM tolerance
  gate or WASM performance result yet. The JavaScript `PhysicsWorld` has deterministic CCD, but the
  non-executable WASM seam does not expose that solver. The fixed body capacity is chosen when memory
  is created; a state frame applies only to a host world with matching ids, order, body types and
  shape parameters. (capability: physics.wasmBackend)

## Vehicles (Phase 6 / 11)

Phase 11 connected the raycast car to the physics heightfield and a kinematic chassis collider.
Phase 6's longitudinal wheel-torque integration and JavaScript PhysicsWorld continuous-collision
hardening are now covered by the focused vehicle and physics suites. The remaining vehicle/world
scope is documented where it belongs: the chassis collider remains kinematic, and the executable
WASM backend is still a future solver seam.

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
* **Weather wets surfaces under cover.** The 17.4 surface state is one scene-wide value: ground under
  a roof gets wet and snowy too, and puddle basins are noise, not terrain hollows. (The weather audio
  that also bypassed the mixer here is 20.6's `EnvironmentSoundscape` on the ambient bus now.)
  (roadmap: 17)

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
  dissolving. Broader world-scale visibility compaction remains tracked under GPU-driven world work.
  (roadmap: 24.3)
* **Population raycasts are resident and prototype-geometry only.** `PopulationWorld.raycast()`
  uses the resident chunk/type blocks and each type's CPU triangle geometry, so evicted chunks and
  CPU-only population types without a geometry/material submission cannot be picked. The returned
  `RayHit.tag` decodes through `PopulationWorld.raycastInfo()` while the hit is current; this is a
  deliberate query boundary, not an ECS entity fallback. Broader world-scale population query coverage
  remains a separate future concern. (roadmap: 24.3)
* **Worker generation has a deterministic inline fallback.** With an engine `TaskScheduler`, the
  complete canonical-surface + scatter job runs through `population.chunk` on the worker path. A
  scheduler that is unavailable/disposed, an unsupported custom terrain stage, or a live Mars Stage A
  field cache falls back to the same pure inline body; the fallback preserves placement but does not
  provide off-main-thread performance. Broader worker failure/recovery policy remains tracked separately.
  (roadmap: 28.7)

## Scripting (Phase 18)

* **A hook that never returns hangs the frame.** Error isolation catches throws, not infinite
  loops: JavaScript cannot interrupt synchronous script code. (`docs/SCRIPTING.md`)
  (capability: scripting.hookPreemption)
* **Fixed steps are not interleaved across systems.** `scripts.fixed` runs all of a frame's fixed
  steps before `vehicles` runs its own, like every `FixedSystem`; a script cannot read the vehicle
  state between two steps of the same frame, and the same steps grouped into different frames give
  a different result. Replays record the frame schedule for this reason (`docs/REPLAY.md`).
  (capability: scheduling.fixedStepInterleaving)

## Save / serialization (Phase 19)

* **Replays are verified on V8 and JavaScriptCore, not on SpiderMonkey.** No gate runs Firefox;
  `replay-verify.html` checks it (or any browser) by hand. Game code outside the engine's simulation
  sources is not linted: a script that feeds `Math.sin` into simulated state can still diverge
  between browsers — use `DMath` (`docs/REPLAY.md`). (capability: determinism.firefox)

* **Script timers, coroutines and subscriptions are in neither a save nor a snapshot, and neither are
  lightning strikes in flight.** Closures cannot be serialized: a loaded script re-registers them in
  `onCreate`; a restored storm keeps its strike schedule but starts with a clear sky. (capability:
  serialization.closuresAndTransients)

## Audio (Phase 20)

* **Audio is verified on a mock context, not by listening.** The suites prove the node graph, the
  automation timing and the bookkeeping on `MockAudioContext`; no gate plays the mixer on a device or
  measures its output. (capability: audio.deviceCheck)
* **GPU particle effects are silent.** Particle audio reads a CPU `ParticleSimulation`'s state
  buffer; a `GpuParticleWorld` (the fountain, the snowfall) keeps its state on the device.
  (capability: audio.gpuParticles)

## Documentation debt

`ARCHITECTURE.md` describes the target design and still refers to documents that do not exist yet
(`ASSETS.md` and some ADRs). `PERFORMANCE.md` now exists as Phase 22's audited benchmark history.
Sections marked "As built" in `ARCHITECTURE.md` and
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
