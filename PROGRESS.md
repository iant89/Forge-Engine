# Forge Engine — Progress

_Last updated: 2026-10-21_

A simple checklist of what Forge can do today and what is still planned. Statuses come from
[ROADMAP.md](ROADMAP.md) and [engine/src/core/capabilities.ts](engine/src/core/capabilities.ts).
Known gaps are listed in [docs/KNOWN-ISSUES.md](docs/KNOWN-ISSUES.md).

**How to read it**

- `[x]` implemented
- `[ ]` planned, in progress, or not built yet
- _(partial)_ implemented, with known gaps
- _(deferred)_ explicitly out of scope for now

---

## Core engine (Phases 1, 3, 5, 9)

- [x] Engine loop with fixed-timestep simulation, config, logging and error handling
- [x] Hybrid data-oriented ECS: entities, component stores, systems and hierarchy
- [x] Double-precision world coordinates with origin rebasing
- [x] Typed coordinate spaces: world, local, render, chunk and terrain
- [x] Deterministic fixed-step physics and seeded generation (bit-for-bit across step rates and threads)
- [x] Mesh BVH for triangle picking and frustum refinement

## Rendering (Phases 2, 13, 24)

- [x] Render graph: pass validation, dead-pass culling, texture aliasing and pooling
- [x] PBR forward pass with HDR, bloom and tone mapping _(partial: no reference-image comparison)_
- [x] Cascaded shadow maps for the first directional light _(partial: only the first shadow-casting directional light)_
- [x] Spot-light and point-light shadow maps _(partial: up to 4 spot and 2 point lights, shared resolution)_
- [x] Depth prepass, reused by SSAO, soft particles and occlusion culling
- [x] SSAO for perspective cameras
- [x] Forward+ clustered lighting: 256 local lights in a 16×8×24 grid, with GPU light assignment
- [x] CPU frustum culling per batch, and per shadow cascade, spot and point-face map
- [x] GPU object culling: frustum, distance and HiZ occlusion _(partial: per batch, not per instance)_
- [x] GPU-generated indirect draws with visible-batch compaction
- [x] Asynchronous pipeline compilation that never blocks a frame
- [x] GPU frame and pass timing via timestamp queries, where the device supports them
- [x] Render scale _(partial: HDR path only)_
- [ ] Contact shadows
- [ ] Adaptive shadow resolution
- [ ] Per-instance culling inside a batch
- [ ] Shadow cascades culled by the GPU pass
- [ ] Depth prepass for cutout, transparent and water surfaces
- [ ] SSAO for orthographic cameras
- [ ] Transparency and post effects that use the prepass depth
- [ ] Clustered lighting for orthographic cameras _(deferred)_
- [~] GPU-driven world scale: streamed terrain now opts into device-authoritative frustum culling (and indirect counts when enabled), with Mars handoff telemetry plus a real-device browser assertion; CPU batch/prepass submission and GPU instance generation remain (Phase 24)

## Terrain (Phases 4, 10)

- [x] Deterministic procedural terrain: height, craters, erosion, biomes and scatter
- [x] Quadtree LOD with real lower-resolution meshes, geomorphing and edge skirts
- [x] Priority chunk streaming with memory, generation, upload and visible-chunk budgets, a chunk cache and cancellation
- [x] Terrain generation on worker threads, identical to inline generation
- [x] Horizon apron that hides the loaded-terrain edge
- [x] Four-layer PBR materials blended by height, slope and biome weight maps
- [x] Height and normal queries, and raycasts that match the drawn surface
- [x] Mars terrain generator port _(partial: analytic-only, no erosion cache shipped, mesh uploads on the main thread)_
- [ ] Verify Mars port fidelity against the upstream erosion cache (needs a human run with the ~30 MB cache)

## Physics (Phases 5, 11, 25)

- [x] Fixed-step rigid bodies: sweep-and-prune broadphase, sequential impulse solver, friction and restitution
- [x] Heightfield collision and raycasts against the same terrain data the renderer draws
- [x] Pluggable physics backend: vehicles and ECS can share one world
- [ ] Continuous collision detection for fast impacts (Phase 25.1)
- [~] WASM physics: versioned linear/shared memory ABI and transferable exact state frames are
  implemented; `ForgeWasmPhysics` still has no solver, runtime topology queue, cross-backend
  tolerance gate or performance result (Phase 25)

## Vehicles (Phases 6, 11, 16.6)

- [x] Raycast vehicle model: Pacejka tyres, suspension, engine, gearbox, differential, aero, traction control and ABS
- [x] Electric drivetrain: traction-motor torque curve, regenerative braking and a 60:1 reduction (rover scenes)
- [x] Chassis collider in the physics world; props collide with the car
- [x] Pitch and roll from suspension reaction torques
- [x] Wheel contact from physics ground queries that match the drawn terrain
- [x] Telemetry: wheel load, suspension travel, slip, tyre force, RPM, gear and contact
- [x] Animated tyres, steering knuckles, suspension arms and axles
- [x] Tyre model _(partial: longitudinal slip is solved, not integrated)_
- [x] Transmission _(partial: reverse is a gear ratio, not a control; automatic shifts forward gears only)_

## Particles (Phases 7, 12)

- [x] CPU reference simulation: emission, modules, budgets, trails and determinism
- [x] GPU particles: compute emission and modules for gravity, drag, turbulence, noise, attractors, velocity, colour, size and rotation
- [x] GPU trails, billboards, stretched billboards and soft particles _(partial: no mesh particles)_
- [x] GPU frustum and distance culling
- [x] Stress-tested at 10K, 50K and 100K particles
- [ ] Particle updates on a fixed physics step (the CPU path advances once per frame)
- [ ] Mesh particles _(deferred)_
- [ ] HiZ occlusion culling for particles _(deferred)_
- [ ] Particle collision with terrain or the depth buffer _(deferred)_
- [ ] 500K and 1M particle stress tests _(deferred stretch goals)_

## Environment & weather (Phases 8a, 8b, 17)

- [x] Solar position and a day/night cycle; Earth and Mars sky presets with height fog
- [x] Multiple scattering: a height × sun-elevation table built on the CPU and in two compute passes, sampled per march step _(partial: no ground bounce, isotropic higher orders, ~±2× through the terminator)_
- [x] Weather state: storm presets, fog, sky and turbidity coupling, wind and gust fields
- [x] Deterministic lightning schedule
- [x] Gerstner water with a fresnel-tinted horizon, and an underwater state _(partial: no reflections, refraction, absorption or foam)_
- [x] Cloud deck with noise shading
- [x] Lightning bolts with a flash light _(partial: silent, one shared light)_
- [x] Aerial perspective: opt-in atmospheric transmittance and in-scattering on standard/water geometry (Phase 17.2; CPU reference + real-WebGPU A/B verified)
- [x] Multi-layer clouds with better shadowing and temporal stability (Phase 17.3; up to four
      sheets through a slab, a marched sun-path shadow that also darkens the scene below, and a
      per-pixel octave fade — CPU reference + real-WebGPU A/B verified)
- [ ] Weather affecting sunlight, terrain look, particles, visibility, vehicle traction, audio and water (Phase 17.4)
- [ ] Water reflections, refraction, depth absorption, shorelines and foam (Phase 17.5)
- [ ] Thunder audio, weather-driven strikes and terrain-aware strike placement (Phase 17.6)

## World population (Phase 14)

- [x] Deterministic per-chunk scatter into compact instance blocks, with no ECS entity per instance
- [x] Six types: rocks, boulders, debris, vegetation (rosette scrub), decals and mineral spires
- [x] Device-resident instance buffers and GPU-selected object LOD
- [x] Population streams with terrain chunks _(partial: culling works per chunk, not per instance)_
- [ ] Per-instance culling inside a batch (Phase 14.5)
- [ ] Load-order-independent surface sampling, so placement does not depend on LOD at first load (Phase 14.1)
- [ ] Population generation on worker threads (Phase 14.6)
- [ ] Raycasting against population instances, for picking and debug tools (Phase 14.6)

## Interactive terrain (Phase 15.5, in progress — Mars Showcase)

- [x] Near-field rocks become physics bodies within 48 m (up to 64 at a time); distant rocks stay instanced
- [x] Rocks can be pushed, roll when unsupported and break under hard impacts
- [x] Rover impacts: blocked, pushable and climbable rocks, with bounded hull, wheel and suspension damage
- [x] Wheel tracks: persistent sand deformation and visible track marks
- [x] Save and restore of broken rocks and track deformation
- [ ] Fractured rock pieces, compound rock shapes, roll resistance and per-rock geology
- [ ] Per-wheel contact manifolds and continuous collision for rover impacts
- [ ] Material-specific sand resistance and traction, with displaced track edges
- [ ] Repair and gameplay recovery after damage

## Assets, resources & workers (Phases 1, 9, 15, 16.1)

- [x] Task scheduler with priorities, cancellation, timeouts and inline fallback
- [x] Real worker threads, in Node and in browser module workers
- [x] Worker-decoded glTF/GLB static meshes and worker-built BVHs
- [x] Refcounted, deduplicated resource registry with budgets, leases and LRU eviction
- [x] Live GPU memory accounting: texture and buffer bytes, pipelines and bind groups
- [x] Content-hashed asset IDs and a dependency graph with invalidation
- [x] Async asset streaming with priority, cancellation and per-frame upload budgets
- [x] Hot reload for meshes, textures, materials and WGSL shaders (the host app decides when to watch files)
- [x] Asset validation for meshes, textures, materials and memory budgets
- [x] KTX2/Basis transcoding to BC7, ASTC, ETC2, RGBA8 or HDR BC6H
- [x] glTF animation clip import
- [ ] glTF images and materials, Draco and meshopt compression, and instancing (Phase 16.1)
- [ ] KTX2 3D/volume textures _(deferred)_

## Animation (Phase 16)

- [x] Clip sampling and playback: step, linear and cubic keys, slerp, and multi-clip blending
- [x] Animation state machines with parameter-driven transitions and crossfades
- [x] 1D and 2D blend trees
- [x] Two-bone IK and FABRIK
- [x] GPU skinning: joint palettes deform meshes, including shadow and depth-prepass passes
- [x] Mechanical rigs: revolute, prismatic and aim joints driven by machine state (rover wheels, suspension and arm)
- [ ] Import glTF skins and morph targets from files (Phase 16.1)

## Gameplay platform (Phases 18, 19)

- [x] Script lifecycle: onCreate, onPreUpdate, onFixedUpdate, onUpdate, onLateUpdate and onDestroy, in the frame's bands and in creation order (Phase 18.1; `docs/SCRIPTING.md`)
- [x] Script errors isolated from the ECS, physics, rendering and the clock: a throwing hook's structural changes are rolled back and the script is faulted (Phase 18.5)
- [x] Deterministic (fixed-step) and render-rate script timers (Phase 18.2)
- [x] Coroutines with pause/resume and cancellation, on the render or fixed-step clock (Phase 18.3)
- [x] Typed events: world and per-entity channels, immediate or queued to the next phase (Phase 18.4)
- [x] Public-API boundary for scripts: `ScriptWorld`/`ScriptEntity` expose entities and components, not systems, disposal or engine internals (Phase 18.6)
- [x] Exit criterion: Beacon Defense (`?scene=scripting`), a whole game written only as scripts (Phase 18)
- [x] Script hot reload during development, keeping each script's data and order (Phase 18.7)
- [x] Versioned scene saves with migrations: entities, components, hierarchy, transforms, scripts, environment and terrain settings (Phase 19.1–19.2; `docs/SERIALIZATION.md`)
- [x] Simulation snapshots: physics, vehicle, weather and RNG state restored mid-run bit-for-bit, with state hashing (Phase 19.3; `docs/SERIALIZATION.md`)
- [x] Input recording, deterministic playback and state hashing (Phase 19.4; `docs/REPLAY.md`)
- [x] Identical replays across JavaScript engines: a complete vehicle session, saved mid-run and replayed, gives the same state hashes in V8 (Chrome) and JavaScriptCore (Safari) (Phase 19.5; `docs/REPLAY.md`)

## Debugging, profiling & benchmarks (Phases 21, 22)

- [x] CPU scope profiler, with GPU pass times merged into frame records
- [x] Engine statistics through `engine.stats()` for renderer, culling, shadows, streaming and resources
- [x] Benchmarks for ECS, particles, lights and culling (`npm run bench`)
- [x] Phase 22.1 core matrix: 100k ECS entities, allocation-free Vec3/Mat4 kernels, inline task dispatch/deduplication, and ResourceRegistry load/cache/eviction paths, all with correctness/accounting and catastrophe guards
- [x] Benchmark snapshot schema 1 (`npm run bench -- --json PATH`): operation counts, timings, guard results and exact host metadata; the first audited baseline is in `PERFORMANCE.md`
- [x] Frame profiler (Phase 21.1): CPU/GPU frame records, per-scope EWMAs, the categorised `Engine.frameBreakdown()` (simulation, physics, terrain, streaming, rendering, particles, scripting, audio) and the drawn frame timeline — a category-stacked column per frame against the budget line with a lane chart of the selected frame's scopes, in the demo's floating Profiler panel (hover to select, tap to pin)
- [ ] Timeline scrub, pause and zoom (Phase 21.1 follow-up) _(partial: the strip shows the last 180 frames only, its GPU marker is the frame total, and per-pass device times stay in the text report)_
- [x] ECS Inspector (Phase 21.2): bounded, read-only system/entity/component snapshots are public and tested, and the demo's floating Inspector window browses them — entity list, component populations, a filter and a per-entity detail pane
- [x] Render Graph and GPU Resource inspectors (Phases 21.3–21.4): pass/dependency/alias data and live labelled allocation summaries are public, tested and browsable in the Inspector window's Graph and GPU tabs
- [~] Physics Debug Draw (Phase 21.5): bounded collider wireframes with optional AABBs/velocity vectors and a renderer-independent line sink are public, tested and browsable in the Inspector window's Physics tab, whose overlay checkbox draws them each frame; contact-manifold overlays remain open
- [x] Terrain Debugger (Phase 21.6): read-only chunk/LOD/streaming snapshot and bounded LOD-coloured chunk-bound lines are public, tested and browsable in the Inspector window's Terrain tab, whose overlay checkbox draws them each frame
- [~] Particle Debugger (Phase 21.7): bounded CPU samples, emitter settings, and particle/velocity line data for CPU worlds and ECS components, browsable in the Inspector window's Particles tab with its own overlay; GPU worlds expose counters/settings without readback
- [x] Streaming Debugger (Phase 21.8): bounded asset-load/task inventories and scene streaming-owner stats are public, tested and browsable in the Inspector window's Streaming tab under one filter
- [x] Environment Debugger (Phase 21.9): read-only sun, atmosphere, cloud, weather/wind/precipitation, water and lightning snapshots plus renderer-independent debug lines, browsable in the Inspector window's World tab with its own sun/wind overlay
- [~] Console (Phase 21.10): safe registered-command API integrates CPU/GPU profiler scopes, engine stats and Phase 21 diagnostic snapshots; bounded input/output/history; the Inspector window exposes the diagnostics interactively but the visible console terminal remains open
- [ ] Rendering, terrain, physics and full particle/world-scale benchmark matrices, including 500k and 1M runs (Phase 22.2–22.6)
- [ ] Automatic same-host regression detection against repeated stored history; JSON snapshots and the first human-readable baseline are in place (Phase 22.7)

## Testing & CI (Phases 0, 2, 9, 28)

- [x] Mock WebGPU device with command log and leak tracking
- [x] Node test suites run with selrun, using explicit coverage claims and affected-test selection
- [x] Real-WebGPU browser gate: headless Chromium with SwiftShader, pixel assertions and zero GPU errors
- [x] Focused browser checks for workers, Mars, terrain layers, skinning, mechanical animation, interactive terrain and rescue
- [x] Architecture lint, WGSL validation and docs honesty gate (`npm run docs:check`)
- [x] One-command setup for dependencies and headless Chromium (`npm run setup`)
- [x] CI on pull requests and pushes to `main`: typecheck, unit tests, shader validation, architecture and docs gates
- [x] Real-WebGPU gate runs in CI as an advisory job _(partial: it cannot block a merge)_
- [ ] Safari/WebKit and mobile browser testing (Phase 28.5)
- [ ] Long-running soak test: a multi-hour Mars run with memory and resource monitoring (Phase 28.10)

## Demo scenes (`npm run demo`)

The scene selector includes these demos. Mars Showcase opens by default.

- [x] **Mars Showcase** (`?scene=mars-showcase`): Perseverance rover with an electric drivetrain on streamed Mars terrain, with dust, wheel tracks, a robotic arm, a high-gain antenna and rover tools
- [x] **Mars Generator** (`?scene=mars-generator`): free-camera site inspector for any Mars site
- [x] **Terrain** (`?scene=terrain`): Mars-flavoured streamed terrain with rocks, boulders and mineral spires
- [x] **Realistic (Alpine)** terrain (`?scene=realistic`)
- [x] **Vehicle playground** (`?scene=vehicle`)
- [x] **Rover Course** (`?scene=rover-course`): Perseverance on an Earth-gravity obstacle track
- [x] **Alpine Search & Rescue: Whiteout Run** (`?scene=alpine-rescue`): a mountain rescue run in building snow and wind
- [x] **Particles** (`?scene=particles`): CPU particle fountain
- [x] **Sky / Day-night** (`?scene=sky`): a June day at 47°N, with an Earth/Mars toggle
- [x] **Weather / Water** (`?scene=weather`): storms, lightning, a Gerstner lake and an underwater dive
- [x] **Amazon River: Upriver Run** (`?scene=amazon-river`): drivable launch on the shared floodplain/water model, with jungle banks, channel buoys, five stops, river telemetry and touch controls
- [x] **Skinned Arm** (`?scene=skinning`): GPU-skinned demo
- [x] **PBR Showcase** (`?scene=pbr`): material grid with bloom, shadows and cascade toggles
- [x] **Cubes** (`?scene=cubes`): the Phase 1 basic scene
- [x] **Beacon Defense** (`?scene=scripting`): a small game built entirely from Phase 18 scripts

## Road to 1.0 (Phases 23, 27–29)

- [~] Mars reference vertical slice: the existing showcase is reconciled against Phase 23 and now publishes `forge.mars-reference/1` frame/streaming/particle/traversal telemetry in the HUD and browser API. Sustained continuous-drive validation, erosion, environment breadth, camera modes and integrated replay remain (Phase 23)
- [x] Public API audit and release contract: the root-only `@forge/engine` boundary and the
  2,196-export surface (2,187 public, nine experimental), type/value kinds, stability labels,
  direct declarations and transitive engine-local type contracts have a deterministic CI-gated
  snapshot; every public row has an exact approval (Phase 27.1 and 27.7)
- [x] Engine API 1.0 completion: generated comprehensive reference inventory, reviewed strict-
  TypeScript examples, 0.x migration guide, semver/release policy, deprecation windows, and
  version-consistent `1.0.0` package metadata are shipped (Phase 27.2–27.6)
- [x] Extension API: `ForgeExtensionRegistry` supports systems, components, importers, terrain
  generators, materials, physics shapes, debug visualizers and console commands with manifest,
  lookup, snapshot and disposal contracts (Phase 27.7)
- [ ] Production hardening: device loss and recovery, browser capability negotiation, low-end GPU degradation, memory pressure, and worker/asset/streaming failure recovery (Phase 28.1–28.9)
- [ ] Forge 1.0 release criteria (Phase 29)

## Deferred (out of scope for now)

- [ ] Multiplayer networking, dedicated servers and MMO-scale replication
- [ ] General-purpose scripting VM and visual scripting
- [x] Audio mixer: spatial voices with a voice limit and occlusion, clip loading, streaming, buses with live effects and smooth fades (Phase 20.1–20.4; `docs/AUDIO.md`)
- [ ] Simulation-driven audio: environment, weather, vehicle and impact sounds (Phase 20.5–20.8)
- [x] Editor (Phase 26): `@forge/editor` now provides the public-API-only authoring workspace,
  optional DOM shell, hierarchy/inspector CRUD, multi-selection, generic fields, world-pose-preserving
  reparent, deterministic transform gizmo math, material/terrain/particle authoring, and vehicle /
  environment / streaming / render-graph / asset / profiler panel adapters. The host still owns the
  renderer viewport, camera controls, simulation loop and scene lifetime.
- [ ] WebGL fallback
- [ ] Cloud asset service
- [ ] SDF global illumination, virtual texturing and full real-time GI
- [ ] Hard preemption of running asset loaders (JavaScript cannot interrupt synchronous code; loaders must cooperate)

---

_Maintenance: update this file in the same change as any status change in ROADMAP.md. `npm run docs:check`
checks ROADMAP.md and the capability registry, not this file._
