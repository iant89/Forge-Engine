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
| 8 | **Environment**: analytic sky + scattering, fog, clouds, day/night, weather state sim, water (Gerstner + foam + refraction), lightning | sun-position/atmosphere numeric checks vs reference tables, weather state integration tests, underwater path test | `[x]` |
| 9 | **Scripting**: Script lifecycle, timers, coroutines, events, error isolation, sandbox boundary | lifecycle-order tests, fault-injection (broken script cannot corrupt ECS), coroutine timing | `[x]` |
| 10 | **Animation**: clips, blending, states/graphs, two-bone IK + FABRIK, skinning, wheel/suspension binding | keyframe sampling vs analytic, weight normalization, IK convergence tests, glTF animation import test | `[x]` |
| 11 | **Streaming + large world**: origin rebasing, double-precision coords, budgets, hitching tests, texture streaming | 10^6 m offset precision tests, streaming stall benchmark, no-artifact readback check | `[x]` |
| 12 | **Editor + tools**: hierarchy, inspector, transform gizmo, material/terrain/lighting/camera panels, asset browser, console, profiler overlay | editor works against public API only (enforced by test), gizmo drag math tests, dev-console command tests | `[x]` |
| 13 | **Optimization + profiling**: profiler, GPU timestamps, stats HUD, quality profiles, batch sort, allocator audit | benchmark deltas recorded in PERFORMANCE.md, zero-leak stress (1000 scene switches) | `[x]` |
| 14 | **Mars demonstration** | headless run: renders, 0 console/WebGPU errors, interactive loop, seed change, dust, day/night | `[x]` |

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

## Known limitations right now

See `docs/KNOWN-ISSUES.md` (kept current at every phase).
