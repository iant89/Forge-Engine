# Known issues and limitations

Kept current at the end of every phase. Each entry says what is missing or approximate and where
the honest detail lives; nothing here is hidden behind a green gate.

## Rendering (Phase 2)

* **Casters are drawn once per cascade they intersect.** There is per-cascade AABB culling but no
  per-object cascade assignment, so a near object costs up to N shadow draws. `stats.shadowsDrawn`
  makes it visible. (`docs/RENDERING.md` §9) (capability: rendering.shadowCascades)
* **Only the first shadow-casting directional light casts.** Spot and point lights light the scene
  but do not shadow it. (capability: rendering.shadows)
* **Shadow atlas memory.** The default profile's 2048² × 3 `depth24plus` array is ≈ 48 MB. Lower
  profiles cap `shadowMapSize`; there is no adaptive resolution. (capability: rendering.shadowMemory)
* **The prepass depth has two consumers so far.** SSAO and the soft-particle fade read it; there
  is no GPU/HiZ culling, no transparency technique and no depth-based post effect that uses it.
  (`docs/RENDERING.md` §9) (capability: rendering.depthReuse)
* **Cutout, fading and water surfaces are not in the depth prepass.** Alpha-tested, `opacity < 1`,
  transparent and water draws are shaded by `forge.main` exactly as without a prepass: no early-Z
  saving, and they neither receive nor cast SSAO (the forward shader's bilateral key finds no AO
  texel for them and leaves them unoccluded). Orthographic cameras run the prepass but not SSAO.
  (capability: rendering.prepassCoverage)
* **`renderScale` applies to the HDR path only.** The LDR path always renders at swapchain size. (capability: rendering.renderScale)
* **No GPU timestamps.** `renderTimeMs` is CPU encode time; pass timings are not measured. (capability: rendering.gpuTiming)
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

* **Layered terrain materials are not wired into the world.** `LayeredTerrainMaterial` blends
  height/slope/biome weights on the CPU and is covered by unit tests, but `TerrainWorld` and the
  demos still attach a single `Material`. A multi-texture splat path and world/demo integration are
  still open under 10.8. (capability: terrain.materialLayering)

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
