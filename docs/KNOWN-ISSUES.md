# Known issues and limitations

Kept current at the end of every phase. Each entry says what is missing or approximate and where
the honest detail lives; nothing here is hidden behind a green gate.

## Rendering (Phase 2)

* **Casters can still contribute to multiple shadow maps.** The renderer assigns each renderable a
  conservative mask from its world AABB and submits only its assigned contiguous instance ranges;
  when an object's bounds intersect multiple cascade, spot or point-face frusta, it is drawn into
  each map. A single-map heuristic is intentionally not used because it could drop valid shadows.
  `stats.shadowInstancesDrawn` and `shadowInstancesCulled` expose the work.
  (`docs/RENDERING.md` §9) (capability: rendering.shadowCascades)
* **Shadowed-light coverage is bounded.** Only the first shadow-casting directional light, up to
  four valid spot lights and up to two valid point lights receive maps. Contact shadows and
  adaptive resolution remain deferred; all maps share the frame's capped `shadow.mapSize`
  resolution. (capability: rendering.shadows)
* **Point cube faces seam at grazing angles.** WebGPU has no comparison sampling for depth cubes,
  so the shader picks the dominant face per fragment; PCF taps that cross a face edge fall back to
  lit, which can leave a thin bright seam where faces meet at shallow receiver angles.
  (`docs/RENDERING.md` §4) (capability: rendering.shadows)
* **Shadow atlas memory.** One 2048² `depth24plus` layer is about 16 MiB; the
  four-cascade/four-spot/two-point-cube maximum is twenty layers — about 320 MiB at 2048² and
  1.25 GiB at the 4096² ultra cap. Quality profiles cap `shadowMapSize`; maps are not adaptive.
  (capability: rendering.shadowMemory)
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
* **`renderScale` applies to the HDR path only.** The LDR path always renders at swapchain size. (capability: rendering.renderScale)
* **No profiler UI.** The profiler receives asynchronous GPU pass samples, but this build has no timeline or pass-timing overlay. (capability: diagnostics.profiler)
* **Bloom and tone mapping are not compared against reference images.** The browser gate proves
  presence and direction (A/B luminance) and the pass structure; visual quality is an eyeball check
  on `tools/.browser-check.png`. (capability: rendering.postFxVerification)
* **WebKit is not run.** Uniform layout strictness and constant-argument strictness are enforced
  statically (`check:wgsl`, `tests/wgsl.test.ts`); no Safari build exists in the sandbox, and the
  Chromium the sandbox runs is newer — and more permissive — than the one the advisory gate
  downloads. (capability: platform.webkitCompile)

## Core (Phase 1)

The worker round-trip and resource-eviction test gaps are gone (`tests/tasks.test.ts`,
`tests/resources.test.ts`). Phase 9.1 also verifies core glTF/GLB mesh decoding on Node and browser
workers. `MeshBvh` now backs triangle-accurate scene picking and large-mesh frustum refinement;
PhysicsWorld uses deterministic sweep-and-prune for rigid-body pair candidates.

* **Core glTF import is geometry-first.** `decodeGltfMesh` handles static, uncompressed triangle
  primitives and returns typed vertex/index arrays, bounds, node transforms, scene roots and material
  factors. It does not decode images/textures, assemble GPU materials/meshes, import skins/animations/
  morph targets/instancing, or decode Draco/meshopt compression; those are tracked for the extended
  glTF importer.
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
* **The Mars port's crater sum is order-sensitive in the last mantissa bits.** `MarsCraterScanner`
  batches the generator's per-vertex 27-cell scan (it samples the same craters — a test asserts zero
  class mismatches and 1e-6 agreement) but sums them in a different order, so `mars-port-check`
  compares against the generator's float32 output with a tolerance rather than for bit equality.
  (`docs/MARS-TERRAIN.md` §6) (capability: terrain.marsGeneratorPort)
* **The port's material regions are coarse relative to a demo tile.** `terrain.marsGeneratorPort`'s
  geology assigns a material per terrain *region* (crater floors and rims, the volcano's flank, the
  canyon's walls), so the four splat channels a 128 m tile carries are usually near one dominant
  channel: a 54-site scan (15° latitude × 60° longitude) found only crater fields mixing two dominant
  channels inside a single 640 m window, and the volcano-summit preset bakes one colour for kilometres.
  That is the port's geology, not a wiring failure — albedo variety *within* a site would need finer
  regional rules, not a different material path. `?scene=mars-generator&marssite=0,0` is the shipped
  site where the mix is real enough to see. (capability: terrain.marsGeneratorPort)
* **Mars material weights still inherit LOD sampling.** The four PBR layers now render, with
  phase-aligned tiled maps and clamped texel-centre mask sampling. That removes shader-introduced
  border wrapping, not differences in the input data: slope-derived biome weights can change when
  a tile is regenerated at a coarser resolution. There is no independent high-resolution global
  material map, triplanar cliff projection or material-mask geomorph. The distant horizon apron
  retains a representative single material. (capability: terrain.marsGeneratorPort)

## Vehicles (Phase 6 / 11)

Phase 11 connected the raycast car to the physics heightfield and a kinematic chassis collider.
What remains:

* **Longitudinal slip is solved, not freely integrated, while the tire can balance the demand.**
  Past the peak, and only when TC/ABS are not clamping, the residual torque spins the wheel. Do not
  expect a stable explicit-Euler wheel at 120 Hz — that path limit-cycles, which is why it was removed. (capability: vehicles.tireModel)
* **Wheel visuals are boxes.** Spin is an euler on that box. No tyre mesh, no steered geometry beyond
  the yaw, no suspension-arm skinning. (capability: vehicles.wheelVisuals)
* **Reverse is a ratio, not a control.** Set `transmission.gear = -1`. The automatic only shifts
  forward gears, and the playground has no reverse key. (capability: vehicles.transmission)
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
* **`ParticleSystem` (CPU) is still variable-rate.** One step per frame, not per physics substep.
  The GPU path is also frame-driven via the render graph. The analytic gravity check passes an
  explicit `dt`. (capability: particles.fixedStep)
* **One owner per CPU simulation.** `ParticleWorld` and `ParticleSystem` both call `step`. Attaching
  both to the same sim double-integrates. The GPU demo uses `GpuParticleWorld` only. (capability: particles.fixedStep)

## Environment (Phase 8a)

* **Single scattering only.** The sky pass and `AtmosphereModel` integrate one scattering event per
  path (Rayleigh + Mie + ozone absorption) with no multiple scattering, so the sky is ~3× darker than
  a real one relative to the sun and the horizon reads yellow rather than white on Earth. The demo
  compensates by rendering the sky at `sky.sunIntensity` 20 against a light of 4.2; `ambientScale`
  trims the derived ambient. A multiple-scattering LUT is the natural 8b/13 follow-up. (capability: environment.multipleScattering)
* **The sky pass is not affected by linear or exp² fog.** Only height fog (whose path integral is
  finite for upward rays) fogs sky pixels; linear/exp² fog would erase the whole sky over an infinite
  path. The planet ground the pass draws below the horizon *is* fogged in every mode, and
  `DayNightCycle.driveFog` keeps the fog colour equal to the sky just above the horizon, so seams
  only appear when a scene sets a fog colour that disagrees with its sky. (`docs/ENVIRONMENT.md` §4) (capability: environment.skyFogModes)
* **Sample-count truncation is visible at the horizon.** With `quality: "low"` (8×4) the horizon sky
  is up to ~35 % darker in blue than the converged integral (`tests/environment.test.ts` pins the
  bound); `medium` halves that. The cubic view-ray spacing is what makes even `low` usable. (capability: environment.skyQuality)
* **No moon, no twilight glow from below the horizon, no aerial perspective on geometry.** Nights are
  stars over an ambient floor (`nightAmbient`). Geometry gets fog, not the sky's in-scattering. (capability: environment.aerialPerspective)
* **The sun disc is not a physical radiance.** `sunDiscIntensity` (default 100× the sun's
  transmitted irradiance) is a look control; the real disc (~14 700×) would bloom the whole frame. (capability: environment.sunDisc)
* **Mars' blue sunset aureole is not modelled.** It needs a wavelength-dependent Mie lobe; the preset
  has one `g`. The daytime butterscotch sky and the bright forward aureole are there. (capability: environment.multipleScattering)
* **`DayNightCycle` drives one directional light.** Point/spot lights, emissive materials and the
  fog *density* are untouched; only the light's direction/colour/intensity, `ambientColor`,
  `fog.color` and `sky.sunDirection` are written. (roadmap: 17)
* **Fog is per-fragment and unshadowed.** No volumetric light shafts; the fog colour does not depend on
  the view direction (the sky's horizon average is used). (roadmap: 17)

## Environment (Phase 8b)

* **One flat cloud layer, not a volume.** The deck is a single noise-textured plane at a fixed
  height with no vertical structure and no self-shadowing; `thickness` in `CloudUniforms` is
  reserved for a volumetric follow-up. The CPU and GPU noise bases differ (Perlin vs value-noise
  fbm), so the twins agree on formulas and statistics, never bit-exactly. (capability: environment.clouds)
* **Weather does not dim the sun.** Storms whiten the sky and thicken the fog, but the directional
  light and the ambient keep their clear-day values — the browser gate's "overcast noon is brighter
  than clear noon" direction depends on this. A storm-darkened sun is later work. (capability: environment.stormLighting)
* **Water reflects the sky tint, not the scene.** The "refraction" is fresnel-mixed body colour plus
  the horizon tint: no planar reflection pass, no depth sampling, no shore foam, no caustics, and
  submerged geometry gets no depth tint — the underwater path is the sky skip plus the murk fog.
  The vertex normals ignore the horizontal displacement's Jacobian (exact for `steepness = 0`), and
  the GPU evaluates 4 waves while the CPU sums any number. (capability: environment.water)
* **Lightning has no thunder and one shared light.** Strikes are silent (a sound system can read
  time/position/energy); the flash light sits at the brightest live strike, so two simultaneous
  bolts share one light; bolts draw as debug lines only (no emissive mesh, no bloom seeding beyond
  the sky flash). (capability: environment.lightning)

## World population (Phase 14)

* **Device culling is per chunk, not per instance.** Each (chunk, type) submission is one batch, so
  the `forge.objects.cull` verdict and the `maxDistance` test drop whole chunks; a chunk whose edge
  alone is in view draws all of its instances, and HiZ occlusion sees only the chunk's conservative
  union bounds. Per-instance culling on the device is the 14.5 follow-up. (capability: world.population)
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

## Documentation debt

`ARCHITECTURE.md` describes the target design and refers to documents that do not exist yet
(`PERFORMANCE.md`, `ASSETS.md`, ADRs). Sections marked "As built" in `ARCHITECTURE.md` and
`docs/RENDERING.md` describe what is real today. `ROADMAP.md`'s status block, this file and
`engine/src/core/capabilities.ts` are cross-checked by `npm run docs:check` (Phase 9.6), so a phase
cannot be advertised as verified while a capability inside it is not, and a limitation cannot outlive
its implementation. An earlier revision of the roadmap marked phases done without the code; that is
what the gate now makes impossible to repeat silently.
