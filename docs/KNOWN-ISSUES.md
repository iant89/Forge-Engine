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
* **WebKit is not run.** Uniform layout strictness is enforced statically (`check:wgsl`,
  `tests/wgsl.test.ts`); no Safari build exists in the sandbox. (capability: platform.webkitCompile)

## Core (Phase 1)

Two entries left this section when Phase 9 landed: the worker round-trip and resource-eviction test gaps
are gone (`tests/tasks.test.ts`, `tests/resources.test.ts`). What remains is the part of 9.1 that could not
be verified, plus the index that now exists but is not used.

* **No asset decoder.** There is no glTF/GLB decoder, so "verify mesh decoding can execute outside the
  main thread" has nothing to run.
  (capability: assets.meshDecoding)

* **The BVH is built, not used.** `MeshBvh` (median split, deterministic, buildable in a worker) exists
  and is tested, but terrain raycasts are still grid-marched, the broadphase is pairwise, and the
  renderer culls with per-batch AABBs — so the tree saves nothing at runtime yet.
  (capability: physics.spatialIndex)


## Terrain (Phase 10)

* **The Mars generator port has no demo scene and no hosted erosion cache.** `MarsTerrainStage`
  renders the ported analytic surface anywhere, but the simulated-erosion correction needs the
  generator's `cache/global/` fields (~30 MB for six faces), which this repository does not ship, and
  no example scene builds a `createMarsPipeline(...)` world yet. `docs/MARS-TERRAIN.md` §5 is the
  wiring recipe. (capability: terrain.marsGeneratorPort)
* **The Mars port's crater sum is order-sensitive in the last mantissa bits.** `MarsCraterScanner`
  batches the generator's per-vertex 27-cell scan (it samples the same craters — a test asserts zero
  class mismatches and 1e-6 agreement) but sums them in a different order, so `mars-port-check`
  compares against the generator's float32 output with a tolerance rather than for bit equality.
  (`docs/MARS-TERRAIN.md` §6) (capability: terrain.marsGeneratorPort)
* **Layered terrain materials are not wired into the world.** `LayeredTerrainMaterial` blends
  height/slope/biome weights on the CPU and is covered by unit tests, but `TerrainWorld` and the
  demos still attach a single `Material`. A multi-texture splat path and world/demo integration are
  still open under 10.8 — this is also what keeps the Mars port's dust/rock/sand/crust weights
  invisible. (capability: terrain.materialLayering)

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

* **Ribbon draw and mesh particles are deferred.** The GPU full-sim writes a 4-sample trail history
  per particle; billboards / stretched billboards / soft particles draw from the storage buffer.
  There is no ribbon mesh pass and no mesh-particle path yet. (capability: particles.gpuRendering)
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

## Documentation debt

`ARCHITECTURE.md` describes the target design and refers to documents that do not exist yet
(`PERFORMANCE.md`, `ASSETS.md`, ADRs). Sections marked "As built" in `ARCHITECTURE.md` and
`docs/RENDERING.md` describe what is real today. `ROADMAP.md`'s status block, this file and
`engine/src/core/capabilities.ts` are cross-checked by `npm run docs:check` (Phase 9.6), so a phase
cannot be advertised as verified while a capability inside it is not, and a limitation cannot outlive
its implementation. An earlier revision of the roadmap marked phases done without the code; that is
what the gate now makes impossible to repeat silently.
