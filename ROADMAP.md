# Roadmap

Status legend: `[ ]` not started · `[~]` in progress · `[x]` done (built + tested + demoed + documented)

| Phase | Deliverable | Verification | Status |
|---|---|---|---|
| 0 | Architecture, repo/tooling bootstrap | typecheck, `npm test`, mock-GPU harness works | `[x]` |
| 1 | **Core foundation**: Engine/Application lifecycle, time, logging, config, events, memory pools, task scheduler + workers, resource handles, math library, basic scene | unit tests (math incl. determinism/precision, ECS-lite, pools, handles), spinning-cube demo renders in real WebGPU | `[x]` |
| 2 | **Rendering foundation**: meshes, textures, materials, PBR shaders, cameras, lights, CSM shadows, HDR + bloom + tonemap, render graph, pipeline cache | mock-GPU tests (graph validation, aliasing, cache hits, zero leaks), real-WebGPU framebuffer readback test, `pbr-scene` demo | `[x]` |
| 3 | **Scene/ECS**: entities, component stores, systems, transforms, visibility, culling, render batching | 100k-entity transform/visibility benchmark, query correctness tests, import-boundary tests | `[x]` |
| 4 | **Terrain + procedural worlds**: chunks, heightmap, quadtree LOD + geomorphing, streaming, splat materials, generators (height/erosion/crater/biome/scatter) | determinism tests (seed → identical heightmaps), streaming budget tests, `terrain` demo with 10 km+ visible world | `[x]` |
| 5 | **Physics**: fixed timestep, rigid bodies, broad/narrowphase, solver, queries, interpolation | bounce/friction/stacking tests, 15/30/60/144 Hz identical-trajectory determinism, penetration tolerances | `[x]` |
| 6 | **Vehicles**: suspension, tires (Pacejka), engine/transmission/diff, aero, terrain contact, TC/ABS | torque→RPM, shift points, stopping distance, slope traversal, wheel-load transfer tests; `vehicle-playground` demo | `[x]` |
| 7 | **Particles**: GPU compute emitters, modules, trails, CPU fallback, budgets | state-buffer math vs analytic gravity in mock GPU + real GPU test; 100k particle benchmark | `[x]` |
| 8a | **Environment I — sky, fog, day/night**: analytic sky pass (single-scattering Rayleigh/Mie/ozone, sun disc, stars, Earth + Mars presets), fog in the forward shader (linear/exp²/height) that meets the sky, `DayNightCycle` (NOAA/Meeus sun position driving the sun light, ambient, fog colour) | sun position vs Meeus worked examples + NOAA facts, atmosphere vs closed forms (β·H, horizon air mass, phase normalisation), height-fog closed form vs brute-force integral, frame tests for the `forge.sky` pass, browser gate: sky compiles on real WebGPU, noon ≫ night, Earth/Mars swap | `[x]` |
| 8b | **Environment II — weather, clouds, water, lightning**: weather state sim (wind/precipitation/temperature fields), volumetric or layered clouds lit by the 8a sky, water (Gerstner + foam + refraction), lightning | weather state integration tests, cloud coverage/lighting checks against the sky model, underwater path test | `[ ]` |
| 9 | **Scripting**: Script lifecycle, timers, coroutines, events, error isolation, sandbox boundary | lifecycle-order tests, fault-injection (broken script cannot corrupt ECS), coroutine timing | `[ ]` |
| 10 | **Animation**: clips, blending, states/graphs, two-bone IK + FABRIK, skinning, wheel/suspension binding | keyframe sampling vs analytic, weight normalization, IK convergence tests, glTF animation import test | `[ ]` |
| 11 | **Streaming + large world**: origin rebasing, double-precision coords, budgets, hitching tests, texture streaming | 10^6 m offset precision tests, streaming stall benchmark, no-artifact readback check | `[ ]` |
| 12 | **Editor + tools**: hierarchy, inspector, transform gizmo, material/terrain/lighting/camera panels, asset browser, console, profiler overlay | editor works against public API only (enforced by test), gizmo drag math tests, dev-console command tests | `[ ]` |
| 13 | **Optimization + profiling**: profiler, GPU timestamps, stats HUD, quality profiles, batch sort, allocator audit | benchmark deltas recorded in PERFORMANCE.md, zero-leak stress (1000 scene switches) | `[ ]` |
| 14 | **Mars demonstration** | headless run: renders, 0 console/WebGPU errors, interactive loop, seed change, dust, day/night | `[ ]` |

## Cross-cutting tracks (run continuously)

- **T-A Documentation**: `README`, `ARCHITECTURE`, `docs/*.md`, ADRs — updated at the end of every phase.
- **T-B Test infrastructure**: mock WebGPU, headless real-GPU harness, benchmark harness — phase 0/1.
- **T-C Asset pipeline**: `tools/forge-assets` importer (glTF→forge mesh, HDR/PNG→KTX2-ready, WAV→forge audio), procedural asset generator so the repo needs no binary blobs.
- **T-D Stability**: leak detector in CI-equivalent test, "no stub subsystem" scan.

## Deferred / next after v1 (honest list)

- WASM physics core (ADR-009) once a verified toolchain is available in the build image.
- KTX2/Basis *transcoding* (needs a third-party transcoder; container parsing is implemented, see ASSETS.md).
- Virtual texturing when sparse resource bindings are exposable.
- SDFGI / real-time GI.
- Editor scene *editing* (save back to disk via File System Access API; serialization exists).
- Networking/replay via deterministic sim snapshots.

## Phase 8 split

Phase 8 was one row covering two different kinds of work, so it is delivered in two sections:

- **8a (done)** is everything that decides *what the light is*: where the sun is, what the sky looks
  like, how far you can see. It lands as `engine/src/environment/` (`solar.ts`, `atmosphere.ts`,
  `fog.ts`, `dayNight.ts`), the `forge.sky` render pass, fog in the forward shader, and the `sky`
  demo scene. `docs/ENVIRONMENT.md` is the as-built description.
- **8b (next)** is everything that *reacts* to that light and has its own simulation state: weather,
  clouds, water, lightning. It builds on 8a's `AtmosphereModel` (clouds and water need the sky's
  radiance and the sun's transmittance) and joins the same module.

## Known limitations right now

Phases 0–7 and 8a are built, tested, and demoed. Phase 8b and phases 9–14 are not started — the
directories those rows name (`animation`, `scripting`, `editor`, a Mars scene) are not in the tree.
Marking them done was a documentation error; the `[ ]` above is the status.

Phase 6, 7 and 8a limitations that a green test does not erase are in `docs/KNOWN-ISSUES.md` (no
mesh collision on the car, no GPU particle emit or trail draw, no particle pass in the render graph,
single-scattering sky with no multiple scattering or moon, sky not affected by linear/exp² fog).
`docs/VEHICLES.md`, `docs/PARTICLES.md` and `docs/ENVIRONMENT.md` are the as-built descriptions.

See `docs/KNOWN-ISSUES.md` (kept current at every phase).
