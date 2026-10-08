# Forge Engine — Progress

_Last updated: 2026-10-08_

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
- [ ] GPU-driven world scale: GPU instance generation and GPU terrain culling (Phase 24)

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
- [ ] WASM physics backend with shared memory, snapshots and cross-backend validation (Phase 25; `ForgeWasmPhysics` is an empty stub)

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

- [x] Solar position and a day/night cycle; single-scattering sky with Earth and Mars presets and height fog _(partial: no multiple scattering)_
- [x] Weather state: storm presets, fog, sky and turbidity coupling, wind and gust fields
- [x] Deterministic lightning schedule
- [x] Gerstner water with a fresnel-tinted horizon, and an underwater state _(partial: no reflections, refraction, absorption or foam)_
- [x] Cloud deck with noise shading _(partial: one flat layer, no self-shadowing)_
- [x] Lightning bolts with a flash light _(partial: silent, one shared light)_
- [ ] Multiple-scattering sky and better Mars twilight (Phase 17.1)
- [ ] Aerial perspective: atmospheric scattering applied to scene geometry (Phase 17.2)
- [ ] Multi-layer clouds with better shadowing and temporal stability (Phase 17.3)
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

- [ ] Script lifecycle: onCreate, onPreUpdate, onFixedUpdate, onUpdate, onLateUpdate and onDestroy (Phase 18.1)
- [ ] Deterministic and render timers, pause/resume and cancellable coroutines (Phase 18.2–18.3)
- [ ] Typed event system, with script errors isolated from ECS, physics, rendering and the clock (Phase 18.4–18.5)
- [ ] Script reload during development, and a public-API boundary for scripts (Phase 18.6–18.7)
- [ ] Versioned save format with migrations for entities, components and terrain settings _(only scene settings serialize today)_ (Phase 19.1–19.2)
- [ ] Simulation snapshots: physics, vehicle, weather and RNG state (Phase 19.3)
- [ ] Input recording, deterministic playback and state hashing (Phase 19.4)

## Debugging, profiling & benchmarks (Phases 21, 22)

- [x] CPU scope profiler, with GPU pass times merged into frame records _(partial: no profiler UI)_
- [x] Engine statistics through `engine.stats()` for renderer, culling, shadows, streaming and resources
- [x] Benchmarks for ECS, particles, lights and culling (`npm run bench`)
- [ ] Profiler UI and frame timeline (Phase 21.1)
- [ ] Inspectors and debug draw for ECS, render graph, GPU resources, physics, terrain, particles, streaming and environment, plus a console (Phase 21.2–21.10)
- [ ] Benchmarks for every subsystem, including 1M-scale runs (Phase 22)
- [ ] Automatic regression detection against stored benchmark history (Phase 22.7)

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
- [x] **Skinned Arm** (`?scene=skinning`): GPU-skinned demo
- [x] **PBR Showcase** (`?scene=pbr`): material grid with bloom, shadows and cascade toggles
- [x] **Cubes** (`?scene=cubes`): the Phase 1 basic scene

## Road to 1.0 (Phases 23, 27–29)

- [ ] Mars reference vertical slice: continuous driving across streamed terrain, with environment, telemetry and replay. The Mars Showcase covers much of this, but the phase checklist is not complete (Phase 23)
- [ ] Public API audit, stability labels, API docs, examples, migration guide, versioning and deprecation policy (Phase 27.1–27.6)
- [ ] Extension API for systems, components, importers, terrain generators, materials, physics shapes, debug visualisers and console commands (Phase 27.7)
- [ ] Production hardening: device loss and recovery, browser capability negotiation, low-end GPU degradation, memory pressure, and worker/asset/streaming failure recovery (Phase 28.1–28.9)
- [ ] Forge 1.0 release criteria (Phase 29)

## Deferred (out of scope for now)

- [ ] Multiplayer networking, dedicated servers and MMO-scale replication
- [ ] General-purpose scripting VM and visual scripting
- [ ] Audio system: spatial audio, buses, streaming, and vehicle and impact audio (Phase 20)
- [ ] Editor and advanced cinematic editor (Phase 26)
- [ ] WebGL fallback
- [ ] Cloud asset service
- [ ] SDF global illumination, virtual texturing and full real-time GI
- [ ] Hard preemption of running asset loaders (JavaScript cannot interrupt synchronous code; loaders must cooperate)

---

_Maintenance: update this file in the same change as any status change in ROADMAP.md. `npm run docs:check`
checks ROADMAP.md and the capability registry, not this file._
