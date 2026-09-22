# Known issues and limitations

Kept current at the end of every phase. Each entry says what is missing or approximate and where
the honest detail lives; nothing here is hidden behind a green gate.

## Rendering (Phase 2)

* **Casters are drawn once per cascade they intersect.** There is per-cascade AABB culling but no
  per-object cascade assignment, so a near object costs up to N shadow draws. `stats.shadowsDrawn`
  makes it visible. (`docs/RENDERING.md` §9)
* **Only the first shadow-casting directional light casts.** Spot and point lights light the scene
  but do not shadow it.
* **Shadow atlas memory.** The default profile's 2048² × 3 `depth24plus` array is ≈ 48 MB. Lower
  profiles cap `shadowMapSize`; there is no adaptive resolution.
* **No aliasing happens in the default frame.** The graph's live-range aliasing is implemented and
  tested, but the current pass set has no two same-shaped transients with disjoint lifetimes, so
  `aliasedBytes` reads 0 in the HUD until a depth prepass / SSAO buffer exists.
* **`renderScale` applies to the HDR path only.** The LDR path always renders at swapchain size.
* **No GPU timestamps.** `renderTimeMs` is CPU encode time; pass timings are not measured.
* **Bloom and tone mapping are not compared against reference images.** The browser gate proves
  presence and direction (A/B luminance) and the pass structure; visual quality is an eyeball check
  on `tools/.browser-check.png`.
* **WebKit is not run.** Uniform layout strictness is enforced statically (`check:wgsl`,
  `tests/wgsl.test.ts`); no Safari build exists in the sandbox.

## Terrain & demo (Phase 4)

* **The loaded disc has a visible edge.** `maxChunksLoaded` caps the resident set (the demo uses 220
  chunks of 128 m ≈ a 1 km radius), and the eviction pass can never drop a chunk the camera still
  selects, so the resident radius is `min(viewDistance, budget)`. Zooming out to the camera's maximum
  distance shows where the world stops. There is no backdrop, horizon skirt or fade yet.
* **`viewDistance` is advisory.** The chunk selection is capped by the budget (nearest first), not by
  the radius alone: the terrain scene's 2 km view distance would have selected ~900 chunks and
  generated them in scan order — nearest chunks (including the one under the camera) could starve while
  far ones were built, which is fixed — but the *drawn* radius is still the budget, not the setting.
* **Chunk generation is synchronous on the main thread.** 33×33 samples through the crater + erosion
  stages costs ~8 ms per chunk on a desktop CPU; the demo budgets 2 per frame, so streaming shows up
  as a hitched frame rather than a fluid crank. The worker/cached pipelines in `GeneratorPipeline` are
  built for this but the streaming path does not use them.
* **The terrain mesh ignores `chunk.lod`.** LOD selection and geomorph alpha are computed and stored,
  but every chunk is generated at `chunkResolution` (33), so distant chunks cost the same vertices as
  near ones and there is no geomorphing in the mesh.
* **No atmosphere.** `scene.setFog` stores settings and the forward pass uploads
  `fogColor`/`fogDensity`/`fogRange`, but no shipped shader samples them (ROADMAP Phase 8), so the
  terrain demo renders with no haze or aerial perspective — part of why the disc edge reads as a cliff.

## Core (Phase 1)

* **Worker execution across threads has no test suite.** The scheduler and worker entry exist and
  typecheck; round-trips are not exercised.
* **Resource cache eviction is untested.** Texture/mesh registries compile; LRU behaviour under
  memory pressure is not covered.

## Vehicles (Phase 6)

* **Ground contact is a height query, not the physics world.** The car does not collide with meshes,
  props, terrain triangles, or Phase 5 rigid bodies. `docs/VEHICLES.md`.
* **Pitch and roll are kinematic.** They are rewritten from the axle heights each substep. A kink in
  the heightfield snaps the pose; it does not conserve angular momentum.
* **Longitudinal slip is solved, not freely integrated, while the tire can balance the demand.**
  Past the peak, and only when TC/ABS are not clamping, the residual torque spins the wheel. Do not
  expect a stable explicit-Euler wheel at 120 Hz — that path limit-cycles, which is why it was removed.
* **Wheel visuals are boxes.** Spin is an euler on that box. No tyre mesh, no steered geometry beyond
  the yaw, no suspension-arm skinning.
* **Reverse is a ratio, not a control.** Set `transmission.gear = -1`. The automatic only shifts
  forward gears, and the playground has no reverse key.

## Particles (Phase 7)

* **The compute shader integrates. It does not emit, shade modules, or write trails.** Emission,
  colour, size, and trails are CPU. There is no particle pass in the render graph (`ARCHITECTURE.md`
  already lists that pass as not built).
* **The demo draws a few hundred boxes, not the buffer.** Per-particle colour is stored and not
  applied to the shared material. Trails are recorded and not drawn. The 100k figure is an integrator
  benchmark (`npm run bench`), not a frame of sprites.
* **`ParticleSystem` is variable-rate.** One step per frame, not per physics substep. A fountain will
  not match across frame rates the way the vehicle will. The analytic check passes an explicit `dt`.
* **One owner per simulation.** `ParticleWorld` and `ParticleSystem` both call `step`. Attaching both
  to the same sim double-integrates. The particle scene uses `ParticleWorld` only.

## Documentation debt

`ARCHITECTURE.md` describes the target design and refers to documents that do not exist yet
(`PERFORMANCE.md`, `ASSETS.md`, ADRs). Sections marked "As built" in `ARCHITECTURE.md` and
`docs/RENDERING.md` describe what is real today. `ROADMAP.md` marks phases 8–14 as not started;
an earlier revision had marked them done without the code.
