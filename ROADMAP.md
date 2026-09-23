```text
================================================================================
                              FORGE ENGINE
                         DEVELOPMENT ROADMAP
                              VERSION 3.0
================================================================================

STATUS:
    Active Development

CURRENT CODEBASE BASELINE:
    Phases 0-7: IMPLEMENTED / VERIFIED
    Phase 8a:   IMPLEMENTED / VERIFIED
    Phase 8b:   IMPLEMENTED / VERIFIED
    Phase 9:    IN PROGRESS (9.2 - 9.6 landed; 9.1 partial)
    Phase 10:   IMPLEMENTED BUT REQUIRES HARDENING
    Phase 11:   IMPLEMENTED / VERIFIED
    Phase 12+:  NOT STARTED

    Phase status lines are cross-checked against engine/src/core/capabilities.ts and
    docs/KNOWN-ISSUES.md by `npm run docs:check`.

IMPORTANT:
    This roadmap reflects the actual implementation state of the repository,
    not only the desired architecture.

Forge is a browser-native, WebGPU-first 3D game and real-time simulation
engine focused on:

    - Real-time simulation
    - Large procedural worlds
    - Physically believable vehicles
    - Procedural terrain
    - GPU-driven rendering
    - GPU particle effects
    - Deterministic simulation
    - JavaScript/TypeScript gameplay scripting
    - Large-world streaming
    - Environmental simulation
    - Browser-native execution


================================================================================
                         ROADMAP STATUS LEGEND
================================================================================

    [ ] NOT STARTED
    [~] IN PROGRESS
    [x] IMPLEMENTED / VERIFIED
    [!] IMPLEMENTED BUT REQUIRES HARDENING
    [>] DEFERRED


A phase may only be marked [x] when:

    - Implementation exists
    - Automated tests exist
    - Real WebGPU validation exists where applicable
    - Performance is measured where applicable
    - Documentation is updated
    - Known limitations are documented


================================================================================
                         CURRENT ENGINE STATE
================================================================================

PHASE 0 - Architecture / Tooling
    [x]

PHASE 1 - Core Foundation
    [x]

PHASE 2 - Rendering Foundation
    [x]

PHASE 3 - Scene / ECS
    [x]

PHASE 4 - Terrain / Procedural Worlds
    [x]

PHASE 5 - Physics
    [x]

PHASE 6 - Vehicles
    [!] IMPLEMENTED BUT REQUIRES HARDENING

PHASE 7 - Particles
    [!] IMPLEMENTED BUT REQUIRES GPU COMPLETION

PHASE 8A - Environment / Atmosphere
    [x]

PHASE 8B - Weather / Clouds / Water / Lightning
    [x]

PHASE 9 - ENGINE HARDENING
    [~] IN PROGRESS

PHASE 10 - Terrain 2.0 / Streaming
    [!] IMPLEMENTED BUT REQUIRES HARDENING

PHASE 11 - Physics / Vehicle Integration
    [x]

PHASE 12+
    [ ] NOT STARTED


================================================================================
                     CRITICAL ROADMAP CORRECTIONS
================================================================================

The old roadmap must NOT continue directly from Phase 8 to scripting.

Several implemented systems are currently incomplete relative to the intended
engine architecture.

Before expanding into many new subsystems, Forge must close the gaps between
the existing implementations and their architectural contracts.


================================================================================
                         PHASE 9 - ENGINE HARDENING
================================================================================

GOAL:

    Harden the existing engine before adding major new systems.

This phase exists because the engine has now accumulated enough functionality
that architectural debt and implementation gaps are becoming more important
than simply adding features.


9.1 Worker Execution

    [x] Add real worker round-trip tests.   (tests/tasks.test.ts, tests/support/workerThreads.ts)

    [x] Test:

        Task submission
        Worker execution
        Result delivery
        Cancellation
        Invalidated tasks
        Worker failure
        Multiple workers
        Deterministic results

    [x] Verify terrain generation can execute outside the main thread.
        (terrain.cell reproduces inline generation bit-for-bit on a real worker thread)

    [x] Verify BVH/LBVH generation can execute outside the main thread.
        (engine/src/math/bvh.ts + the geometry.bvh task; a worker-built tree is byte-identical to
        the inline build and answers the same rays — tests/tasks.test.ts, tests/bvh.test.ts.
        Wiring it into raycasts and culling is later work: capability: physics.spatialIndex)

    [ ] Verify mesh decoding can execute outside the main thread.
        No glTF/GLB decoder exists yet (capability: assets.meshDecoding, Phase 15.1).

    The remaining open bullet is why 9.1 stays [~]: mesh decoding has nothing to run because no
    asset decoder exists yet, and a browser-side worker round-trip is still not asserted
    (capability: workers.browserThreads).


9.2 Resource Cache

    [x] Add resource eviction tests.   (tests/resources.test.ts)

    [x] Test:

        LRU behavior
        memory pressure
        reference counting
        eviction safety
        resource re-acquisition
        stale handles


9.3 Resource Statistics

    [x] Add GPU memory accounting.   (tests/gpuMemory.test.ts)

    [x] Add:

        textureBytes
        bufferBytes
        pipelineCount
        bindGroupCount
        transientBytes
        pooledBytes
        evictedBytes


9.4 Coordinate Space API

    [x] Formalize coordinate spaces.   (engine/src/scene/spaces.ts, tests/coordinateSpaces.test.ts)

    Required concepts:

        WorldPosition
        LocalPosition
        RenderPosition
        ChunkCoordinate
        TerrainCoordinate


9.5 Capability Registry

    [x] Add machine-readable feature status.
        (engine/src/core/capabilities.ts, tests/capabilities.test.ts)

    Example:

        rendering.renderGraph
        rendering.clusteredLighting
        terrain.streaming
        terrain.lod
        physics.ccd
        particles.gpuSimulation
        environment.atmosphere
        environment.weather


9.6 Known-Issue Enforcement

    [x] Every known limitation must link to a roadmap item.
        (capability: core.knownIssueEnforcement — notes and roadmap references are parsed and
        resolved by tools/docs-check.mjs; dangling or unknown references fail the gate)

    [x] Remove stale limitations after their implementation.
        The two Core entries about untested worker round-trips and eviction were deleted when
        Phase 9 landed; a limitation that references a now-verified capability fails docs:check.

    [x] Prevent "green CI" from implying production readiness.
        (.github/workflows/ci.yml runs the CPU gates and prints what they do not cover; the
        real-WebGPU gate runs as a separate advisory job on SwiftShader and mirrors its output
        onto the pull request, so it can inform without ever implying a merge was validated —
        capability: testing.browserGateInCi)


EXIT CRITERIA:

    Worker execution is tested.
    Resource eviction is tested.
    Memory accounting exists.
    Capability state is queryable.
    Every known limitation maps to planned work.


================================================================================
                    PHASE 10 - TERRAIN 2.0 / STREAMING
================================================================================

GOAL:

    Turn the existing procedural terrain system into a true scalable terrain
    system.

CURRENT PROBLEMS (addressed in this phase):

    - Terrain LOD is calculated but not reflected in mesh resolution. → fixed (10.1)
    - Loaded radius is limited by current chunk budget. → budgets (10.7)
    - Chunk generation occurs synchronously on the main thread. → workers (10.2)
    - Streaming can still hitch. → priority + cancel (10.4 / 10.5)
    - No horizon skirt. → fixed (10.6)
    - viewDistance is advisory rather than authoritative. → visible-chunk + memory budgets (10.7)


10.1 Real Terrain LOD

    [x] Generate actual lower-resolution meshes for distant chunks.

    Example:

        LOD 0 = 33x33
        LOD 1 = 17x17
        LOD 2 = 9x9
        LOD 3 = 5x5
        LOD 4 = 3x3

    [x] Use chunk.lod during mesh generation.

    [x] Implement geomorphing in the actual vertex positions.

    [x] Prevent cracks between neighboring LOD levels.


10.2 Worker Terrain Generation

    [x] Move terrain generation into TaskScheduler workers
        (default worker-entry installs terrain handlers; demos enable workerCount).

    [x] Generate:

        height
        erosion
        crater
        biome
        scatter
        mesh

        off the main thread where practical
        (cell grids via TaskScheduler; mesh build stays on the main thread).


10.3 Terrain Generation Cache

    [x] Cache deterministic generated chunks.

    Cache key:

        seed
        chunkX
        chunkZ
        generatorVersion
        generatorSettings


10.4 Priority Streaming

    [x] Priority based on:

        camera distance
        camera direction
        screen importance
        current LOD
        dependency state


10.5 Streaming Cancellation

    [x] Cancel terrain work when a chunk becomes irrelevant.


10.6 Horizon Handling

    [x] Add terrain horizon skirt / fallback representation.

    [x] Prevent visible terrain edge.


10.7 Terrain Budgeting

    [x] Replace arbitrary chunk limits with:

        memory budget
        generation budget
        upload budget
        visible-chunk budget


10.8 Terrain Material Improvements

    [!] Layered materials — `LayeredTerrainMaterial` helper + CPU blend tests exist;
        not wired into `TerrainWorld` / demos yet (single `Material` still used).
    [x] Macro variation (helper)
    [x] Micro detail (helper)
    [x] Slope blending (helper)
    [x] Height blending (helper)
    [x] Material-specific surface properties (helper)


EXIT CRITERIA:

    Terrain LOD changes actual geometry complexity.
    Terrain generation does not block the main thread.
    Streaming remains responsive while moving continuously.
    No visible cracks exist between LOD levels.
    Memory remains within configured budgets.


================================================================================
                    PHASE 11 - PHYSICS / VEHICLE INTEGRATION
================================================================================

GOAL:

    Connect the existing vehicle simulation to the actual physics and terrain
    systems.

This phase is intentionally before expanding the renderer further.

The vehicle system previously used a GroundQuery/heightfield model rather than
the Phase 5 rigid-body collision world. Phase 11 connects them: PhysicsBackend,
shared heightfield collider, kinematic chassis, physical pitch/roll, telemetry.


11.1 Physics Backend Interface

    [x] Define:

        PhysicsBackend


    Implementations:

        ForgeJSPhysics
        ForgeWasmPhysics (future stub)


11.2 Heightfield Collider

    [x] Add terrain heightfield collision to PhysicsWorld.

    [x] Terrain collision must use the same authoritative terrain data used
        for rendering and vehicle ground queries.


11.3 Vehicle Physics Integration

    [x] Vehicle chassis participates in the physics world.

    [x] Wheels interact with physics/terrain collision.

    [x] Props can collide with vehicles.


11.4 Vehicle Orientation

    Replace kinematic pitch/roll with physically meaningful orientation.

    [x] Integrate angular state.

    [x] Apply suspension forces.

    [x] Apply torque.

    [x] Apply reaction forces.


11.5 Wheel Collision

    [x] Wheel contact points become physics queries rather than a completely
        independent heightfield-only path.


11.6 Vehicle / Terrain Agreement

    [x] Required invariant validated in tests/vehiclePhysics.test.ts:

        VISUAL TERRAIN
             =
        TERRAIN COLLISION
             =
        VEHICLE CONTACT


11.7 Vehicle Stress Tests

    [x] Crater traversal
    [x] Large bump
    [x] Side slope
    [x] Jump
    [x] Wheel unloading
    [x] Wheel lift
    [x] High-speed impact
    [x] Collision with prop
    [x] Vehicle rollover


11.8 Vehicle Telemetry

    [x] wheel load
    [x] suspension travel
    [x] slip ratio
    [x] slip angle
    [x] tire force
    [x] engine RPM
    [x] gear
    [x] wheel angular velocity
    [x] contact state


EXIT CRITERIA:

    Vehicle uses the actual physics/terrain collision system.
    Vehicle pitch and roll emerge from simulation.
    Vehicle can interact with physical world objects.
    Terrain/visual/physics agreement is validated.


================================================================================
                    PHASE 12 - GPU PARTICLES 2.0
================================================================================

GOAL:

    Turn the existing compute particle integrator into a complete GPU particle
    system.

CURRENT STATE:

    CPU particle simulation is the reference implementation.

    Compute shader already reproduces the gravity/drag/lifetime integration.

    However:

        - GPU emission is not implemented.
        - GPU module processing is not implemented.
        - GPU trails are not implemented.
        - GPU particle rendering is not implemented.
        - There is no particle render-graph pass.
        - Current demo renders only a few hundred sprite entities.


12.1 GPU Particle Storage

    [ ] GPU storage buffer becomes authoritative for GPU particles.


12.2 GPU Emission

    [ ] Spawn particles entirely on GPU.

    [ ] Deterministic emitter seed.


12.3 GPU Modules

    Implement:

        gravity
        drag
        turbulence
        velocity
        color over life
        size over life
        rotation over life
        noise
        attractors


12.4 GPU Trails

    [ ] GPU trail history.

    [ ] Ribbon generation.


12.5 GPU Particle Culling

    [ ] Frustum culling.

    [ ] Distance culling.

    [ ] Optional depth/HiZ culling.


12.6 Particle Render Graph Pass

    [ ] Add:

        particle.sim
        particle.sort
        particle.render
        particle.resolve

    where appropriate.


12.7 Particle Rendering

    Support:

        billboard
        stretched billboard
        mesh particle
        ribbon
        soft particle


12.8 GPU Particle Collision

    [ ] Terrain collision.

    [ ] Depth-buffer collision.

    [ ] Optional signed-distance-field collision later.


12.9 Particle Stress Tests

    [ ] 10K
    [ ] 50K
    [ ] 100K
    [ ] 500K
    [ ] 1M


EXIT CRITERIA:

    100K particles can be simulated and rendered without creating
    100K ECS entities.

    Particle simulation, rendering and spawning can occur primarily on GPU.


================================================================================
                    PHASE 13 - RENDERER 2.0
================================================================================

GOAL:

    Move the renderer from the current forward foundation toward the intended
    scalable GPU-oriented architecture.


13.1 Depth Prepass

    [ ] Implement depth prepass.

    [ ] Reuse depth for:

        culling
        SSAO
        particles
        transparency
        post processing


13.2 Render Graph Aliasing Validation

    [ ] Create real production passes that exercise transient resource
        aliasing.

    [ ] Verify aliasedBytes becomes meaningful in normal frames.


13.3 Clustered / Forward+ Lighting

    [ ] Implement GPU-friendly clustered lighting.

    [ ] Remove fixed CPU light-list limitations.


13.4 GPU Light Culling

    [ ] Cluster lights on GPU where practical.

    [ ] Add light-count stress benchmark.


13.5 GPU Object Culling

    [ ] GPU frustum culling.

    [ ] GPU distance culling.

    [ ] Optional HiZ/occlusion culling.


13.6 Indirect Rendering

    [ ] GPU-generated indirect draw commands.

    [ ] Visible-object compaction.


13.7 Async Pipeline Compilation

    [ ] Implement the architecture's intended async pipeline path.

    [ ] Expose:

        pipelinesPending

    [ ] Never block a frame waiting for pipeline creation.


13.8 GPU Timing

    [ ] Wire timestamp queries where supported.

    [ ] Expose:

        GPU frame time
        pass time
        compute time
        render time


13.9 Shadow Improvements

    [ ] Per-object cascade assignment.

    [ ] Spot shadows.

    [ ] Point shadows.

    [ ] Contact shadows.

    [ ] Adaptive shadow resolution.


EXIT CRITERIA:

    Renderer supports scalable lighting.
    GPU culling works.
    GPU timing works where supported.
    Pipeline compilation is asynchronous.
    Render-graph aliasing occurs in realistic workloads.


================================================================================
                    PHASE 14 - WORLD POPULATION
================================================================================

GOAL:

    Efficiently populate procedural worlds without creating an ECS entity for
    every rock, boulder or environmental object.


14.1 Deterministic Scatter

    Placement determined by:

        seed
        chunk coordinate
        population type


14.2 Population Types

    [ ] Rocks
    [ ] Boulders
    [ ] Debris
    [ ] Vegetation
    [ ] Decals
    [ ] Environmental props


14.3 Instance Storage

    [ ] Compact instance buffers.


14.4 GPU LOD

    [ ] GPU-selected object LOD.


14.5 GPU Culling

    [ ] Population culling.


14.6 Population Streaming

    [ ] Population follows terrain/world chunk streaming.


EXIT CRITERIA:

    Large populations can exist without equivalent CPU object counts.


================================================================================
                       PHASE 15 - ASSET PIPELINE 2.0
================================================================================

GOAL:

    Turn the existing asset tooling into a scalable runtime asset system.


15.1 Content Addressing

    [ ] Stable AssetID.

    [ ] Content hashes.


15.2 Dependency Graph

    Example:

        Vehicle
          |
          +-- Mesh
          +-- Material
          +-- Texture
          +-- Animation
          +-- Physics
          +-- Audio


15.3 Streaming

    [ ] Async asset loading.

    [ ] Cancellation.

    [ ] Prioritization.

    [ ] GPU upload budgeting.


15.4 Hot Reload

    [ ] Mesh reload.
    [ ] Texture reload.
    [ ] Material reload.
    [ ] Shader reload.


15.5 Asset Validation

    [ ] Invalid mesh detection.
    [ ] Missing texture detection.
    [ ] Unsupported material detection.
    [ ] Excessive memory detection.


15.6 KTX2 / Basis

    [ ] Complete transcoding when suitable toolchain is available.


EXIT CRITERIA:

    Large scenes can load assets incrementally.
    Asset loading does not block the simulation loop.


================================================================================
                         PHASE 16 - ANIMATION
================================================================================

GOAL:

    Add a production-capable animation system.


16.1 Animation Clips

    [ ] glTF animation import
    [ ] clip sampling


16.2 Animation State Machines

    [ ] states
    [ ] transitions
    [ ] blending


16.3 Blend Trees

    [ ] 1D
    [ ] 2D


16.4 IK

    [ ] Two-bone IK
    [ ] FABRIK


16.5 Skinning

    [ ] GPU skinning


16.6 Mechanical Animation

    First target:

        rover wheels
        suspension
        steering
        robotic arm
        mechanical joints


EXIT CRITERIA:

    Animated assets can be imported, blended, skinned and streamed.


================================================================================
                       PHASE 17 - ENVIRONMENT 2.0
================================================================================

GOAL:

    Build on the now-implemented environment system rather than treating
    environment as an unfinished phase.

CURRENTLY COMPLETE:

    [x] Solar positioning
    [x] Atmosphere
    [x] Fog
    [x] Day/night
    [x] Weather state
    [x] Clouds
    [x] Gerstner water
    [x] Underwater state
    [x] Lightning


17.1 Atmosphere Quality

    [ ] Multiple-scattering approximation / LUT.

    [ ] Improved Mars atmospheric scattering.

    [ ] Better twilight.


17.2 Aerial Perspective

    [ ] Apply atmospheric distance scattering to scene geometry.


17.3 Cloud Improvements

    [ ] Multi-layer clouds.

    [ ] Better shadowing.

    [ ] Improved temporal stability.


17.4 Weather Integration

    [ ] Weather affects:

        terrain appearance
        particles
        visibility
        vehicle traction
        audio
        water


17.5 Water Improvements

    [ ] Reflection.

    [ ] Refraction.

    [ ] Depth-dependent absorption.

    [ ] Shoreline effects.

    [ ] Foam.


17.6 Lightning Integration

    [ ] Thunder audio.

    [ ] Weather-driven strikes.

    [ ] Terrain-aware strike positioning.


EXIT CRITERIA:

    Environment state affects the rest of the simulation rather than existing
    only as a visual system.


================================================================================
                     PHASE 18 - SCRIPTING
================================================================================

GOAL:

    Expose the engine as a usable gameplay platform.


18.1 Script Lifecycle

    [ ] onCreate
    [ ] onPreUpdate
    [ ] onFixedUpdate
    [ ] onUpdate
    [ ] onLateUpdate
    [ ] onDestroy


18.2 Timers

    [ ] deterministic timers
    [ ] render timers


18.3 Coroutines

    [ ] pause/resume
    [ ] cancellation


18.4 Events

    [ ] typed event system


18.5 Error Isolation

    A broken script must not corrupt:

        ECS
        physics
        rendering
        simulation clock


18.6 Public API Boundary

    Scripts should NOT directly manipulate internal:

        GPUDevice
        RenderGraph internals
        Physics solver internals

    unless using an explicitly documented low-level API.


18.7 Hot Reload

    [ ] development-time script reload


EXIT CRITERIA:

    A complete gameplay system can be implemented without modifying engine
    source code.


================================================================================
                  PHASE 19 - SAVE / SERIALIZATION / REPLAY
================================================================================

GOAL:

    Turn deterministic simulation into a usable gameplay feature.


19.1 Scene Serialization

    [ ] entities
    [ ] components
    [ ] transforms
    [ ] environment
    [ ] terrain settings


19.2 Versioned Save Format

    [ ] schema version
    [ ] migrations


19.3 Simulation Snapshots

    [ ] physics state
    [ ] vehicle state
    [ ] weather state
    [ ] RNG state


19.4 Replay

    [ ] input recording
    [ ] deterministic playback
    [ ] state hashing


19.5 Verification

    Same input stream must produce identical state hashes.


EXIT CRITERIA:

    A complete vehicle session can be saved and deterministically replayed.


================================================================================
                    PHASE 20 - AUDIO
================================================================================

GOAL:

    Integrate audio with simulation and environment.


20.1 Spatial Audio

20.2 Audio Resources

20.3 Streaming Audio

20.4 Buses / Mixing

20.5 Environmental Audio

20.6 Weather Audio

20.7 Vehicle Audio

    Engine RPM
    throttle
    load
    gear
    tire slip
    suspension
    terrain


20.8 Particle / Impact Audio


EXIT CRITERIA:

    Audio responds to simulation state rather than being purely scripted.


================================================================================
                  PHASE 21 - PROFILER / DEBUG TOOLS
================================================================================

GOAL:

    Make Forge self-diagnosing.


21.1 Frame Profiler

    Track:

        CPU frame
        GPU frame
        simulation
        physics
        terrain
        streaming
        rendering
        particles
        scripting
        audio


21.2 ECS Inspector

21.3 Render Graph Inspector

21.4 GPU Resource Inspector

21.5 Physics Debug Draw

21.6 Terrain Debugger

21.7 Particle Debugger

21.8 Streaming Debugger

21.9 Environment Debugger

    Show:

        sun
        atmosphere
        weather
        cloud coverage
        wind
        precipitation
        water
        lightning


21.10 Console


EXIT CRITERIA:

    Major performance and correctness problems can be diagnosed without
    changing engine source.


================================================================================
                    PHASE 22 - BENCHMARK + REGRESSION SYSTEM
================================================================================

GOAL:

    Prevent performance regressions as the engine grows.


22.1 Core

    [ ] ECS
    [ ] math
    [ ] scheduler
    [ ] resource management


22.2 Rendering

    [ ] draw submission
    [ ] render graph
    [ ] culling
    [ ] lighting
    [ ] shadows
    [ ] GPU memory


22.3 Terrain

    [ ] generation
    [ ] erosion
    [ ] LOD
    [ ] streaming
    [ ] mesh generation


22.4 Physics

    [ ] broadphase
    [ ] narrowphase
    [ ] solver
    [ ] queries
    [ ] vehicles


22.5 Particles

    [ ] 10K
    [ ] 100K
    [ ] 500K
    [ ] 1M


22.6 World

    [ ] 10K objects
    [ ] 100K objects
    [ ] 500K objects
    [ ] 1M objects


22.7 Regression Recording

    Store historical benchmark results in:

        PERFORMANCE.md


EXIT CRITERIA:

    Significant CPU, GPU or memory regressions are detectable automatically.


================================================================================
                    PHASE 23 - MARS REFERENCE VERTICAL SLICE
================================================================================

GOAL:

    Prove Forge works as a complete real-time simulation engine.

This is NOT simply another demo.

This is the primary validation environment for Forge.


23.1 Mars Terrain

    [ ] Large procedural Mars terrain
    [ ] Craters
    [ ] erosion
    [ ] rocks
    [ ] LOD
    [ ] streaming


23.2 Mars Environment

    [ ] Mars atmosphere
    [ ] dust haze
    [ ] solar cycle
    [ ] weather
    [ ] clouds where appropriate
    [ ] lighting


23.3 Rover

    [ ] physics chassis
    [ ] suspension
    [ ] wheels
    [ ] tire model
    [ ] drivetrain
    [ ] steering
    [ ] braking


23.4 Rover Environment Interaction

    [ ] crater traversal
    [ ] slope traversal
    [ ] rock collisions
    [ ] wheel slip
    [ ] suspension movement


23.5 Particles

    [ ] wheel dust
    [ ] drifting dust
    [ ] debris
    [ ] exhaust


23.6 Streaming

    [ ] continuous terrain traversal
    [ ] object streaming
    [ ] asset streaming


23.7 Camera

    [ ] chase
    [ ] cockpit
    [ ] free
    [ ] cinematic


23.8 Telemetry HUD

    Show:

        FPS
        CPU frame
        GPU frame
        physics
        terrain
        streaming
        particle count
        visible objects
        loaded chunks
        GPU memory


23.9 Deterministic Replay

    [ ] record input
    [ ] replay
    [ ] state hashes


EXIT CRITERIA:

    Player can continuously drive a physically simulated rover across
    procedural Mars terrain while the engine streams the world and renders
    environmental effects without instability.


================================================================================
                    PHASE 24 - GPU-DRIVEN WORLD SCALE
================================================================================

GOAL:

    Remove CPU bottlenecks revealed by the Mars vertical slice.


24.1 GPU Object Culling

24.2 GPU LOD Selection

24.3 GPU Visibility Compaction

24.4 Indirect Rendering

24.5 GPU Instance Generation

24.6 GPU Terrain Culling

24.7 GPU Particle Simulation

24.8 GPU Particle Rendering


TARGET:

    CPU describes the world.

    GPU determines as much of the visible workload as practical.


EXIT CRITERIA:

    Large object populations scale primarily with visible GPU workload rather
    than CPU submission count.


================================================================================
                    PHASE 25 - WASM PHYSICS
================================================================================

GOAL:

    Provide a high-performance physics backend without changing gameplay code.


25.1 WASM Backend

25.2 Shared Memory Representation

25.3 Snapshot Transfer

25.4 Backend Selection

    Example:

        physics.backend = "js"
        physics.backend = "wasm"


25.5 Cross-Backend Validation

    Same input must produce equivalent results within defined tolerances.


EXIT CRITERIA:

    WASM physics can replace the JS backend without changing gameplay code.


================================================================================
                    PHASE 26 - EDITOR
================================================================================

GOAL:

    Build editor tooling on top of the stable runtime API.


26.1 Scene Hierarchy

26.2 Entity Inspector

26.3 Component Inspector

26.4 Transform Gizmo

26.5 Terrain Editor

26.6 Material Editor

26.7 Particle Editor

26.8 Vehicle Inspector

26.9 Environment Editor

26.10 Streaming Inspector

26.11 Render Graph Viewer

26.12 Asset Browser

26.13 Profiler


CRITICAL RULE:

    The editor depends only on the public engine API.

    The runtime must never depend on the editor.


EXIT CRITERIA:

    A complete Mars scene can be created and modified without editing
    engine source code.


================================================================================
                    PHASE 27 - ENGINE API 1.0
================================================================================

GOAL:

    Stabilize Forge as a reusable engine.


27.1 Public API Audit

    [ ] public
    [ ] internal
    [ ] experimental
    [ ] deprecated


27.2 API Documentation

27.3 Examples

27.4 Migration Guide

27.5 Versioning Policy

27.6 Deprecation Policy

27.7 Extension API

    Support registration of:

        systems
        components
        importers
        terrain generators
        materials
        physics shapes
        debug visualizers
        console commands


EXIT CRITERIA:

    External developers can build a complete game using the public API.


================================================================================
                    PHASE 28 - PRODUCTION HARDENING
================================================================================

GOAL:

    Prepare Forge for long-running real games.


28.1 WebGPU Device Loss

28.2 Device Recovery

28.3 Browser Capability Negotiation

28.4 Low-End GPU Degradation

28.5 Mobile Browser Testing

28.6 Memory Pressure

28.7 Worker Failure Recovery

28.8 Asset Failure Recovery

28.9 Streaming Failure Recovery


28.10 Long-Running Soak Test

    Run Mars continuously for multiple hours.

    Monitor:

        memory
        GPU memory
        resources
        workers
        frame time
        allocations
        loaded chunks
        particle counts


EXIT CRITERIA:

    No progressive memory/resource degradation.


================================================================================
                    PHASE 29 - FORGE 1.0
================================================================================

Forge 1.0 requires:

    [ ] Stable core
    [ ] Stable ECS
    [ ] Stable resources
    [ ] Stable render graph
    [ ] PBR rendering
    [ ] HDR
    [ ] Bloom
    [ ] Tone mapping
    [ ] CSM
    [ ] Depth prepass
    [ ] Clustered lighting
    [ ] GPU culling
    [ ] Indirect rendering
    [ ] Large-world coordinates
    [ ] Terrain LOD
    [ ] Terrain streaming
    [ ] Deterministic terrain
    [ ] Deterministic physics
    [ ] Terrain collision
    [ ] Vehicle physics
    [ ] GPU particles
    [ ] World population
    [ ] Asset pipeline
    [ ] Animation
    [ ] Atmosphere
    [ ] Weather
    [ ] Water
    [ ] Audio
    [ ] Scripting
    [ ] Serialization
    [ ] Replay
    [ ] Profiling
    [ ] Debugging
    [ ] Benchmarks
    [ ] Mars vertical slice
    [ ] Public API documentation
    [ ] Long-running stability validation


================================================================================
                       CONTINUOUS DEVELOPMENT TRACKS
================================================================================

TRACK A - DOCUMENTATION

    [ ] README
    [ ] ARCHITECTURE
    [ ] ROADMAP
    [ ] subsystem docs
    [ ] ADRs
    [ ] KNOWN-ISSUES
    [ ] VERIFICATION

    Every major architectural change updates documentation.


TRACK B - TESTING

    [ ] Unit tests
    [ ] Integration tests
    [ ] Mock WebGPU
    [ ] Real WebGPU
    [ ] Determinism
    [ ] Resource leaks
    [ ] Architecture boundaries
    [ ] Performance benchmarks


TRACK C - PERFORMANCE

    Continuously measure:

        CPU
        GPU
        memory
        allocations
        draw calls
        workers
        streaming
        terrain
        particles


TRACK D - DETERMINISM

    Preserve deterministic behavior for:

        physics
        vehicles
        terrain
        procedural generation
        weather
        particle emission
        replay


TRACK E - KNOWN ISSUES

    Every known limitation must be classified:

        correctness
        performance
        missing feature
        approximation
        platform limitation


================================================================================
                         CURRENT PRIORITY QUEUE
================================================================================

DO NOT immediately start scripting, editor work, networking, or miscellaneous
features.

The recommended immediate sequence is:

    01. Engine hardening
    02. Worker terrain generation
    03. Real terrain LOD
    04. Terrain streaming improvements
    05. Terrain/physics collision integration
    06. Vehicle physics integration
    07. GPU particle rendering
    08. Depth prepass
    09. Clustered lighting
    10. GPU culling
    11. Indirect rendering
    12. World population
    13. Asset streaming
    14. Mars vertical slice


================================================================================
                          THINGS TO CHANGE
================================================================================

CHANGE:

    Old:
        Phase 8 = Environment, not started.

    New:
        Phase 8a/8b = COMPLETE.

    Reason:
        Environment is already implemented and verified.


CHANGE:

    Old:
        Move immediately into scripting after environment.

    New:
        Harden terrain, physics, vehicles and particles first.

    Reason:
        These systems exist but have important architectural limitations.


CHANGE:

    Old:
        Terrain LOD considered complete because quadtree LOD exists.

    New:
        Terrain LOD remains incomplete until mesh resolution actually changes.

    Reason:
        Current chunk.lod affects selection data but not generated mesh density.


CHANGE:

    Old:
        Terrain streaming considered complete.

    New:
        Terrain streaming remains a hardening phase.

    Reason:
        Generation is still synchronous and the loaded radius is budget-limited.


CHANGE:

    Old:
        Vehicle phase considered complete.

    New:
        Vehicle phase is functional but not production-ready.

    Reason:
        Vehicle contact is currently a GroundQuery rather than full physics-world
        collision and pitch/roll remain kinematic.


CHANGE:

    Old:
        Particle phase considered GPU-complete.

    New:
        Particle phase is a GPU simulation prototype.

    Reason:
        Compute integration exists, but GPU emission, rendering, trails and
        render-graph integration remain incomplete.


CHANGE:

    Old:
        Renderer architecture treated as mostly complete.

    New:
        Renderer foundation is complete; scalable GPU renderer remains ahead.

    Reason:
        Clustered lighting, depth prepass, GPU culling, indirect rendering,
        GPU timing and async pipeline creation remain unfinished.


CHANGE:

    Old:
        Mars is a final demonstration phase.

    New:
        Mars is the primary continuous validation target beginning once terrain,
        vehicle and particle integration are hardened.

    Reason:
        A single vertical slice exposes problems that isolated subsystem demos
        cannot.


================================================================================
                              DO NOT CHANGE
================================================================================

KEEP:

    WebGPU-first architecture.

    No WebGL compatibility layer.

    RenderGraph architecture.

    ResourceRegistry ownership model.

    Hybrid data-oriented ECS.

    Fixed timestep simulation.

    Deterministic procedural generation.

    Double-precision world coordinates.

    Origin rebasing.

    Worker-based procedural generation.

    Public API / internal implementation separation.

    Editor outside runtime dependency graph.

    Registration-based extension architecture.

    Mock WebGPU testing.

    Real WebGPU browser gate.

    Architecture boundary tests.

    Capability degradation through WebGPU feature/limit negotiation.


================================================================================
                           FEATURES TO DEFER
================================================================================

DEFER UNTIL THE CORE VERTICAL SLICE IS STRONG:

    [>] Multiplayer networking
    [>] Dedicated server
    [>] MMO-scale replication
    [>] General-purpose scripting VM
    [>] WebGL fallback
    [>] Cloud asset service
    [>] Visual scripting
    [>] Massive editor feature set
    [>] Advanced cinematic editor
    [>] SDF global illumination
    [>] Virtual texturing
    [>] Full real-time GI


NETWORKING SHOULD ONLY BEGIN AFTER:

    deterministic simulation
    snapshots
    serialization
    replay
    vehicle physics
    world streaming

are all stable.


================================================================================
                         ARCHITECTURAL RULES
================================================================================

RULE 1:
    No sibling subsystem imports another sibling's internals.


RULE 2:
    engine/src/index.ts remains the composition root.


RULE 3:
    Runtime never depends on editor.


RULE 4:
    GPU resources are owned by ResourceRegistry.


RULE 5:
    Rendering never mutates authoritative simulation state.


RULE 6:
    Simulation never depends on rendering results.


RULE 7:
    Terrain visual and collision data share an authoritative source.


RULE 8:
    Worker jobs are deterministic functions of:

        seed
        key
        input


RULE 9:
    Large world coordinates are never casually converted to Float32.


RULE 10:
    Gameplay scripts use public APIs.


RULE 11:
    Every performance-sensitive subsystem exposes statistics.


RULE 12:
    Every major feature has automated tests.


RULE 13:
    Every major feature has a benchmark.


RULE 14:
    Every asynchronous subsystem supports cancellation.


RULE 15:
    Every streaming subsystem has explicit budgets.


RULE 16:
    Known limitations are documented rather than hidden by green tests.


RULE 17:
    A feature cannot be marked complete simply because its API exists.


================================================================================
                         DEFINITION OF DONE
================================================================================

A feature is COMPLETE when applicable:

    [ ] Implementation complete
    [ ] Unit tests
    [ ] Integration tests
    [ ] Real WebGPU validation
    [ ] Determinism validation
    [ ] Error handling
    [ ] Resource lifetime validation
    [ ] Performance benchmark
    [ ] Memory benchmark
    [ ] Debug statistics
    [ ] Documentation
    [ ] Demo/reference implementation
    [ ] Known limitations documented
    [ ] Capability state updated


================================================================================
                        CANONICAL TEST SCENES
================================================================================

SCENE 1:
    PBR Showcase

    Purpose:
        renderer correctness


SCENE 2:
    Terrain

    Purpose:
        procedural terrain
        LOD
        streaming


SCENE 3:
    Vehicle

    Purpose:
        physics
        terrain
        suspension
        tires


SCENE 4:
    Particles

    Purpose:
        CPU/GPU particle validation


SCENE 5:
    Sky / Environment

    Purpose:
        atmosphere
        solar
        day/night


SCENE 6:
    Weather

    Purpose:
        weather
        clouds
        water
        lightning


SCENE 7:
    Mars

    Purpose:
        COMPLETE ENGINE VERTICAL SLICE


================================================================================
                       MARS VERTICAL SLICE STANDARD
================================================================================

Mars becomes the primary Forge benchmark.

The final reference scenario should contain:

    PROCEDURAL WORLD
        |
        +-- terrain generation
        +-- craters
        +-- erosion
        +-- LOD
        +-- streaming
        +-- rocks
        +-- world population
        |
        +-- MARS ATMOSPHERE
        |     +-- sky
        |     +-- dust
        |     +-- solar lighting
        |     +-- weather
        |
        +-- ROVER
        |     +-- physics
        |     +-- suspension
        |     +-- tires
        |     +-- drivetrain
        |
        +-- PARTICLES
        |     +-- wheel dust
        |     +-- debris
        |     +-- exhaust
        |
        +-- RENDERING
              +-- shadows
              +-- clustered lighting
              +-- GPU culling
              +-- indirect rendering
              +-- atmosphere
              +-- post processing


================================================================================
                           FINAL ENGINE TARGET
================================================================================

Forge should not attempt to become another general-purpose Three.js clone.

Forge's identity should remain:

    A browser-native, WebGPU-first real-time simulation engine designed for
    large procedural worlds, deterministic simulation, realistic vehicles,
    environmental simulation, GPU-driven rendering and large-scale particle
    effects.


The engine should ultimately demonstrate:

    LARGE WORLD
        +
    PROCEDURAL TERRAIN
        +
    REAL PHYSICS
        +
    VEHICLES
        +
    GPU PARTICLES
        +
    ENVIRONMENT
        +
    STREAMING
        +
    GPU-DRIVEN RENDERING
        +
    DETERMINISTIC SIMULATION
        +
    JAVASCRIPT / TYPESCRIPT


================================================================================
                              END OF ROADMAP
================================================================================
```
