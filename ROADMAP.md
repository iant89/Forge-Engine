```text
================================================================================
                              FORGE ENGINE
                         DEVELOPMENT ROADMAP
                              VERSION 3.0
================================================================================

STATUS:
    Active Development

CURRENT CODEBASE BASELINE:
    Phases 0-7:  IMPLEMENTED / VERIFIED
    Phase 6 hardening (reconciled 2026-10-21): the longitudinal wheel path now integrates
                angular velocity from drive/brake/tire torque with deterministic TC/ABS control,
                and JavaScript PhysicsWorld has deterministic time-of-impact sweeps for supported
                high-speed static/kinematic impacts. The former `vehicles.tireModel` and
                `physics.ccd` gaps are closed by the focused vehicle/physics suites. Box wheel
                visuals remain tracked under Phase 16.6; the non-executable WASM solver remains
                tracked under Phase 25 rather than being implied by the JS CCD result.
    Phase 8a:   IMPLEMENTED / VERIFIED
    Phase 8b:   IMPLEMENTED / VERIFIED
    Phase 9:    IMPLEMENTED / VERIFIED (worker-backed mesh decoding, BVH picking/frustum refinement,
                deterministic broadphase, resource hardening, coordinate API and docs gates verified)
    Phase 10:   IMPLEMENTED BUT REQUIRES HARDENING
    Phase 11:   IMPLEMENTED / VERIFIED
    Phase 12:   IMPLEMENTED / VERIFIED (honest subset — see Phase 12 checkboxes)
    Phase 13:   IMPLEMENTED / VERIFIED (13.1-13.8: depth prepass + SSAO, aliasing,
                clustered lighting, GPU light fill/culling, indirect rendering,
                async pipeline compilation and GPU timing; 13.9 cascade assignment,
                bounded spot/point shadows, contact shadows, adaptive atlas resolution,
                and shared per-instance culling are covered by focused suites and docs)
    Phase 14:   IMPLEMENTED / VERIFIED (14.1-14.6: canonical-surface deterministic scatter,
                all six 14.2 types, compact/device-resident storage, GPU LOD/culling, worker-backed
                population streaming and resident geometry raycasts are covered by focused suites;
                scheduler/custom-stage boundaries are documented as intentional contract limits.)
    Phase 15+:  IMPLEMENTED / VERIFIED (15.1 content addressing, 15.2 dependency graph,
                15.3 streaming, 15.4 staged resource + shader reload, 15.5 validation,
                and 15.6 KTX2/Basis transcoding are implemented and covered by tests;
                real Chromium/SwiftShader verified an ETC1S-to-BC7 six-mip upload.
                KTX2 3D volumes are explicitly deferred; core glTF/GLB geometry decode is
                separately verified in Phase 9.1, with extended import in Phase 16.1.)
                The `15+` label covers Phase 15 only; the interactive terrain work is tracked
                separately as Phase 15.5 below.
    Phase 15.5: IMPLEMENTED / VERIFIED (15.5.1-15.5.5: bounded interactive population proxies,
                deterministic push/roll/break and rover obstacle response, persistent deformation and
                visible wheel tracks, bounded streaming budgets and save/restore diagnostics)
                Phases 16 and 17 are IN PROGRESS ([~]); Phases 18 through 20 are VERIFIED ([x]),
                Phase 21 is IMPLEMENTED / VERIFIED ([x]). Phase 22 is IMPLEMENTED / VERIFIED ([x]): its 22.1 core,
                22.2 rendering, 22.3 terrain, 22.4 physics, 22.5 particle and 22.6 world matrices cover
                ECS, math, scheduling, resources, renderer submission, terrain generation/erosion/LOD/streaming/
                mesh construction, deterministic broadphase/narrowphase/solver/query/vehicle workloads, and
                the runner emits schema-2 host-described snapshots with stable IDs, repeated raw samples,
                stored history and same-host statistical rejection. Phases 23 through 28 remain NOT STARTED ([ ]).
                Phase 29 is a roll-up (see the status block; `docs:check` verifies the phase keys directly).

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
    [x] IMPLEMENTED / VERIFIED

PHASE 7 - Particles
    [x]

PHASE 8A - Environment / Atmosphere
    [x]

PHASE 8B - Weather / Clouds / Water / Lightning
    [x]

PHASE 9 - ENGINE HARDENING
    [x]

PHASE 10 - Terrain 2.0 / Streaming
    [!] IMPLEMENTED BUT REQUIRES HARDENING

PHASE 11 - Physics / Vehicle Integration
    [x]

PHASE 12 - GPU Particles 2.0
    [x]

PHASE 13 - Renderer 2.0
    [x] IMPLEMENTED / VERIFIED

PHASE 14 - World Population
    [x] IMPLEMENTED / VERIFIED

PHASE 15+
    [x] IMPLEMENTED / VERIFIED

PHASE 15.5 - Interactive Terrain / Object Dynamics
    [x] IMPLEMENTED / VERIFIED

PHASE 16 - ANIMATION
    [~] IN PROGRESS (16.1-16.6 landed: clip import, sampling, playback, state machines, blend trees,
        IK, joint palette computation, GPU skinning and extended glTF import including morphs,
        instancing, UV1 routing and Draco/meshopt seams; 16.1i Mars importer migration remains deferred)

PHASE 17 - ENVIRONMENT 2.0
    [~] IN PROGRESS (17.1 landed: the multiple-scattering LUT — the sky gains the higher orders on
        the CPU and in two compute passes on the device, measured 1.3x at noon and 2-7x at twilight
        on Earth and 2-5x on Mars, with the remaining limits in KNOWN-ISSUES; 17.2 landed: opt-in
        finite-path atmospheric scattering reaches standard and water geometry, CPU reference and
        real-WebGPU A/B verified; 17.3 landed: the deck is a stack of up to four sheets through
        a slab, each shaded by the sun-path optical depth the shader marches — the same depth
        darkens the scene below — with every octave fading against the pixel's own footprint,
        verified by a CPU reference plus real-WebGPU layer and shadow A/Bs; 17.4-17.6 landed: the
        ground wets, puddles and snows from the weather and sets every vehicle's grip, the high tier
        draws screen-space water (refraction, depth absorption, contact foam, SSR), and thunder and
        strike attachment are simulation events — measured and real-WebGPU A/B verified)

PHASE 18 - SCRIPTING
    [x]

PHASE 19 - SAVE / SERIALIZATION / REPLAY
    [x]

PHASE 20 - AUDIO
    [x]

PHASE 21 - PROFILER / DEBUG TOOLS
    [x] IMPLEMENTED / VERIFIED (the Profiler timeline is browsable and scrub/zoomable across the retained
        history; Physics overlays include bounded contact points and normals; the Inspector's overlays
        use those contacts, and the visible Console provides safe registered commands with bounded
        transcript/history. GPU particle positions remain intentionally device-authoritative; the
        debugger reports their counters/configuration without a readback.)

PHASE 22 - BENCHMARK + REGRESSION SYSTEM
    [x] COMPLETE (22.1 core, 22.2 rendering, 22.3 terrain, 22.4 physics, 22.5 particles,
        22.6 world matrices and 22.7 same-host regression recording/comparison are implemented and guarded)

PHASE 23 - MARS REFERENCE VERTICAL SLICE
    [~] IN PROGRESS (the existing showcase is now reconciled against the phase and exposes a
        versioned telemetry/streaming/traversal contract; dry Mars weather/cloud integration has
        started; erosion, the environment acceptance gate, continuous traversal validation, camera
        modes and integrated deterministic replay remain)

PHASE 24 - GPU-DRIVEN WORLD SCALE
    [~] IN PROGRESS (streamed terrain can now hand CPU-rejected bounds to device culling and, when
        enabled, indirect records; Mars exposes the handoff; CPU batch/prepass submission, instance
        generation, generic compaction and complete GPU particle rendering remain)

PHASE 25 - WASM PHYSICS
    [~] IN PROGRESS (versioned fixed-capacity WebAssembly.Memory ABI, optional shared seqlock memory
        and transferable exact state frames landed; the WASM solver, runtime body commands,
        cross-backend tolerance gate and CCD remain)

PHASE 26 - EDITOR
    [x] COMPLETE (`@forge/editor` public-API-only workspace, optional DOM shell, hierarchy/inspector
        CRUD and multi-selection, generic fields, world-pose-preserving reparent, deterministic gizmo
        math, specialist authoring/diagnostic panels and complete-Mars-scene attachment/save workflow)

PHASE 27 - ENGINE API 1.0
    [x] COMPLETE (the root-only package boundary, deterministic declaration-contract audit and
        exact approvals remain CI-gated; the released 1.0.0 surface contains 2,196 exports,
        including 2,187 approved public exports and nine experimental WASM-physics seam exports.
        Reference documentation, reviewed examples, 0.x migration guidance, semver/release and
        deprecation policy, and one extension contract are shipped and typechecked.)


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

    [x] Add real worker round-trip tests.   (tests/core/tasks.test.ts, tests/support/workerThreads.ts)

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
        the inline build and answers the same rays — tests/core/tasks.test.ts, tests/math/bvh.test.ts.)

    [x] Use spatial indices in runtime queries.
        Geometry's lazy mesh BVH powers triangle-accurate scene picking and refines large-mesh
        frustum culling. PhysicsWorld's deterministic sweep-and-prune index prunes rigid-body pairs
        before narrowphase while preserving the original insertion order. Heightfield raycasts keep
        their specialized grid traversal. Evidence: tests/scene/ecs.test.ts, tests/rendering/rendering.test.ts,
        tests/physics/physics.test.ts; capability: physics.spatialIndex.

    [x] Verify mesh decoding can execute outside the main thread.

        `decodeGltfMesh` / `loadGltfMesh` decode core glTF 2.0 and GLB triangle primitives through
        the `asset.gltf.decode` TaskScheduler task. The worker returns transferable typed arrays,
        indices, bounds, scene/node transforms and material factors; external `.gltf` buffer fetches
        are resolved before dispatch. Interleaved and sparse accessors plus normalized integer
        attributes are covered by `tests/resources/gltf.test.ts`; the same GLB result is compared against the
        inline decoder and a real Node worker thread (`tests/core/tasks.test.ts`,
        `tests/resources/gltf.test.ts`).

    [x] Verify a browser module-worker round-trip.

        `npm run check:browser:workers` loads `tests/fixtures/triangle.glb` in Chromium, asks a real
        `TaskScheduler` module worker to decode it, and asserts worker count, task completion, decoded
        geometry, zero inline fallbacks and zero worker failures (`tools/browser-check.mjs`).
        This is separate from the Node `worker_threads` adapter. Extended glTF import beyond the
        Phase 9.1 core is covered under `assets.gltfAdvanced` (Phase 16.1).

    [x] Browser-side worker round trip: check:browser:mars-workers observes native Worker Mars
        task/result messages, validates typed grids + pipeline identity, and requires uploaded
        showcase tiles with rover contact. The full browser gate includes the same check.
        (capability: workers.browserMarsTerrain)


9.2 Resource Cache

    [x] Add resource eviction tests.   (tests/resources/resources.test.ts)

    [x] Test:

        LRU behavior
        memory pressure
        reference counting
        eviction safety
        resource re-acquisition
        stale handles


9.3 Resource Statistics

    [x] Add GPU memory accounting.   (tests/gpu/gpuMemory.test.ts)

    [x] Add:

        textureBytes
        bufferBytes
        pipelineCount
        bindGroupCount
        transientBytes
        pooledBytes
        evictedBytes


9.4 Coordinate Space API

    [x] Formalize coordinate spaces.   (engine/src/scene/spaces.ts, tests/scene/coordinateSpaces.test.ts)

    Required concepts:

        WorldPosition
        LocalPosition
        RenderPosition
        ChunkCoordinate
        TerrainCoordinate


9.5 Capability Registry

    [x] Add machine-readable feature status.
        (engine/src/core/capabilities.ts, tests/docs/capabilities.test.ts)

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
    Mesh queries and large-mesh frustum culling use the spatial index; rigid-body pairs are broadphase-pruned.
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

    [x] Layered materials — TerrainWorld and Mars Showcase use per-tile weight maps and four
        shared albedo/normal/metallic-roughness texture-array layers. SplatMaterial shares the
        standard vertex, prepass, shadow and PBR lighting paths; ordinary materials keep their
        existing layout. Tile eviction/remesh releases masks and uniforms; shared arrays persist.
    [x] Macro variation (world-phased shader modulation)
    [x] Micro detail (per-layer textures + albedo-driven detail)
    [x] Slope blending (cell-grid gates before filtered/renormalized GPU splat blending)
    [x] Height blending (cell-grid altitude gates)
    [x] Material-specific surface properties (albedo, tangent normals, roughness and metallic)

        tests/terrain/terrainMaterials.test.ts, tests/examples/marsShowcase.test.ts and the real-WebGPU pixel oracle
        in check:browser:terrain-layers pin the path. Four fixed layers; the horizon apron remains
        a representative single material. This does not add triplanar projection or material painting.


10.9 Mars Generator Port

    [!] Port the external `mars-terrain-gen` analytic generator (Stage B) into a Forge
        `TerrainStage`, so its planet can be rendered at any `chunkSize`/`chunkResolution`
        instead of only at quadtree-depth chunk files (docs/MARS-TERRAIN.md).

        [x] `engine/src/terrain/mars/`: cube-sphere mapping, bit-identical noise, geology
            (crater bands, volcanoes, cinder cones, dichotomy + canyon), Stage A field
            cache reader, `MarsTerrainStage`, `MarsSite`, `adviseMarsTile`, splat layers.
        [x] Deterministic/seamless generation and renderer integration pinned by
            tests/terrain/marsTerrain.test.ts; region planner + port verification tooling
            (tools/mars-terrain, tools/mars-port-check.mjs) pinned by
            tests/tools/marsTerrainPlan.test.ts.
        [x] Mars Showcase uses the analytic-only port (seed 1337, equatorial plain), with a
            surveyed rover spawn, shared tile/vehicle/camera height queries, 128 m / 33-vertex
            chunks and 32 m skirts. tests/examples/marsShowcase.test.ts pins scene assembly, driving,
            streaming budgets and LOD edges; check:browser asserts the port/mode, resident
            rover tile, terrain clearance and forward W-drive with wheel dust.
        [x] A site inspector beside the showcase: `?scene=mars-generator` streams the same port with
            a free orbit camera and the site from the URL (`MARS_SITE_PRESETS` keys or any `lat,lon`
            pair), reporting site, band, skirts, generation/material mode and splat tiles through
            `window.__forge.marsGeneratorState()`. Pinned by tests/examples/marsGeneratorScene.test.ts and the
            check:browser arm of the same name (volcano preset: workers + layered, zero GPU errors and
            sub-tile mask variation; `?marssite=0,0` crater field: rim tile (-1,2) retains rock + crust
            and a >25 % runner-up share). Coincident LOD vertices keep exact mask equality.
            docs/MARS-TERRAIN.md §5.
        [x] Analytic Mars cells run on workers from a complete serialized configuration (including
            custom planet settings, site radius/heading, detail and curvature flags), byte-identical
            to the original live pipeline. The showcase opts into the scheduler with nine warm-up
            requests then one per frame; real-thread and native-browser checks pin the path, and
            a cancellation acknowledgement keeps a task cancelled during worker bootstrap from
            stranding its worker slot.
        [!] The repo hosts no Stage A erosion cache; fidelity against the real generator cache
            remains unverified. Live field-cache pipelines are still inline-only; mesh building,
            uploads and cache-miss ground queries remain on main. A seeded 40–170 m planet-space
            veneer now breaks up the coarse regional materials while preserving exact raw-mask
            equality at coincident LOD vertices; it is a rendering approximation, not an upstream
            material map or sediment-transport simulation.

            (2026-10-09 update: the coarse-LOD material-mask mismatch is closed by pointwise
            planet-space geology + splat sampling in `MarsTerrainStage`; 14.1's separate
            "Load-order-independent surface sampling" is implemented for population placement;
            Mars terrain's separate Stage A fidelity blocker remains open. The first sentence above is still a blocker, not work — the fidelity check
            needs the upstream generator's ~30 MB `cache/global/` fields, which this repository
            deliberately does not ship; `check:mars-port` stays a synthetic-cache smoke test until
            a human run supplies the real cache (docs/MARS-TERRAIN.md §5–6,
            capability: terrain.marsGeneratorPort). The inline-only mesh/upload/ground-query
            residual is the accepted shape recorded under 10.2 and KNOWN-ISSUES §Terrain, not
            unmet 10.9 scope.)

            NEEDS HUMAN RUN (fidelity half): download the upstream `mars-terrain-gen`
            `cache/global/` Stage A fields for seed 1337, place them where
            `tools/mars-port-check.mjs` expects its `--cache` input, run
            `npm run check:mars-port`, and compare field heights against the generator's
            float32 output; the gate reports agreement, so anything but a clean match keeps
            this [!]. Nothing in this sandbox can produce that cache.


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

    [x] Apply suspension reaction torques (pitch/roll); yaw from tire-plane moments.

    [x] Soft geometric spring while >= 3 wheels plant (no tire pitch/roll moments this phase).


11.5 Wheel Collision

    [x] Wheel contact points become physics queries rather than a completely
        independent heightfield-only path.


11.6 Vehicle / Terrain Agreement

    [x] Required invariant validated in tests/vehicles/vehiclePhysics.test.ts:

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

    Honest subset shipped (see checkboxes below). CPU simulation remains the reference.

        - GPU storage is authoritative (`GpuParticleSystem` / `GpuParticleWorld`); no sprite entities
          for the GPU fountain demo (100k capacity).
        - GPU ring-buffer emission with a deterministic seed hash.
        - Full-sim modules on GPU (gravity, drag, turbulence, velocity, colour/size/rotation over
          life, noise, attractors).
        - Frustum + distance cull compact into an indirect draw list.
        - Render-graph passes `particle.sim` / `particle.sort` / `particle.render` /
          `particle.resolve` draw billboards, stretched billboards, and soft particles.
        - Trail history (4 samples per particle) is written on GPU and drawn as camera-facing
          ribbon strips by the vertex stage (no mesh, 18 verts/particle from the same compacted list).

    Still deferred / stretch:

        - Mesh particles (a ribbon is now drawn; per-particle user geometry is not).
        - HiZ / depth occlusion culling.
        - Terrain / depth-buffer / SDF particle collision (soft fade samples depth only; no bounce).
        - 500K / 1M stress gates.


12.1 GPU Particle Storage

    [x] GPU storage buffer becomes authoritative for GPU particles
        (`GpuParticleSystem` / `GpuParticleWorld`).


12.2 GPU Emission

    [x] Spawn particles entirely on GPU (ring-buffer emit compute).

    [x] Deterministic emitter seed (hash of seed + emit index).


12.3 GPU Modules

    Implemented on the GPU full-sim path. CPU reference modules remain for gravity / drag /
    colour-over-life / size-over-life; velocity / attractor / rotation-over-life are GPU-only
    (CPU ports removed):

        [x] gravity
        [x] drag
        [x] turbulence
        [x] velocity
        [x] color over life
        [x] size over life
        [x] rotation over life
        [x] noise
        [x] attractors


12.4 GPU Trails

    [x] GPU trail history (4-sample ring per particle written in full-sim).

    [x] Ribbon generation and draw — the vertex stage sorts the ring newest-first (fixed network,
        deterministic), triangulates three quads per strip (18 verts, `PARTICLE_RIBBON_VERTS`),
        tapers and fades toward the tail, and samples the same soft depth as billboards; the cull
        pass counts survivors into the second indirect record while the ribbon flag is set, and the
        resolve pass keeps it zeroed. `GpuParticleWorld.setRibbon` toggles live; the demo builds
        ribbons on (`?ribbons=0` pins them off). No mesh or CPU geometry exists — by design.
        (tests/particles/particles.test.ts; capability: particles.gpuRendering; docs/PARTICLES.md)


12.5 GPU Particle Culling

    [x] Frustum culling.

    [x] Distance culling.

    [>] Optional depth/HiZ culling — deferred.


12.6 Particle Render Graph Pass

    [x] Add:

        particle.sim
        particle.sort   (frustum/distance compact; not a full key sort)
        particle.render
        particle.resolve

    where appropriate.


12.7 Particle Rendering

        [x] billboard
        [x] stretched billboard (velocity stretch factor)
        [>] mesh particle — deferred
        [x] ribbon — trail strips from the ring, drawn from the same compacted list as the billboards (12.4)
        [x] soft particle (depth-buffer fade)


12.8 GPU Particle Collision

    [>] Terrain collision — deferred.

    [>] Depth-buffer collision — deferred (soft fade samples depth; no bounce).

    [>] Optional signed-distance-field collision later.


12.9 Particle Stress Tests

    [x] 10K
    [x] 50K
    [x] 100K
    [>] 500K — stretch / not gated
    [>] 1M — stretch / not gated


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

CURRENT STATE:

    Implemented and verified. Landed: the depth prepass (13.1) with material-aware
    coverage, full-resolution depth reuse for transparent intersection fading and the
    optional HDR depth-aware post haze, plus orthographic SSAO; real transient aliasing
    in every SSAO frame (13.2),
    clustered lighting (13.3), the GPU cluster fill (13.4), GPU object culling with
    the HiZ pyramid (13.5), indirect rendering (13.6), asynchronous pipeline
    compilation (13.7) and GPU timing (13.8). Phase 13.9 adds conservative
    per-object cascade assignment, bounded spot shadows (up to four lights), bounded
    point shadows (up to two lights, six cube faces each), a prepass-depth contact
    resolve, budget-driven adaptive atlas resolution, and shared per-instance culling
    for ordinary instanced batches and population batches.
    Frame: forge.lights.assign (optional GPU fill) → forge.populationCull.views
    (optional per-instance view/shadow lists) → forge.shadow.<n> →
    forge.shadow.spot.<n> → forge.shadow.point.<n>.<face> (both optional, after
    cascades) → forge.prepass → forge.depth.resolve / forge.contact.depth
    (optional full-resolution r32float depth reuse) → forge.hiz.<n> →
    forge.objects.cull → forge.populationCull → forge.ssao → forge.ssao.blur.h →
    forge.ssao.blur.v → forge.main → forge.sky → particles → bloom → forge.tonemap
    (the cull passes exist only on the device path; contact.depth is shared by
    transparent intersection fading and HDR depth-aware post haze when those consumers coexist).

        - `forge.prepass` draws every opaque, non-cutout, fully opaque surface depth
          only, with the standard module's own vertex entry points (`@invariant`
          position); `forge.main` loads that depth and shades each visible pixel once
          (`less-equal`, no depth writes for prepassed draws). On real WebGPU the
          frame is pixel-identical with the prepass on or off.
        - SSAO: a half-resolution normal-oriented obscurance estimate from the prepass
          depth, a separable depth-aware blur, a bilateral upsample in the forward
          shader; it scales the ambient term only.
        - The SSAO estimate's target is dead once the horizontal blur has read it, so
          the graph hands its memory to the blur result: aliasedBytes =
          (w/2)·(h/2)·4 B in every SSAO frame (921,600 B at 1280x720).
        - Quality profiles: prepass + SSAO on medium/high/ultra, off on minimal/low
          (`EngineConfig.depthPrepass` / `ssao`); per scene `settings.depthPrepass` /
          `settings.ssao`.
        - Object culling: `forge.objects.cull` writes one visibility word per batch
          (frustum planes from the frame's own view-projection, per-batch distance
          limits, HiZ occlusion against the prepass depth); the batch's vertex stage
          collapses its clip position when the word says no, so a culled batch costs
          no rasterisation. `RendererOptions.objectCulling` / `occlusionCulling`, the
          CPU twin on the mock device, live counters one frame late.


13.1 Depth Prepass

    [x] Implement depth prepass. (`forge.prepass`; stats `depthPrepass`,
        `prepassDraws`; tests/rendering/frame.test.ts, tests/rendering/pipeline.test.ts, check:browser
        pixel identity.)

    [x] Reuse depth for:

        [x] SSAO            — `forge.ssao` samples the prepass depth.
        [x] particles       — the soft-particle fade samples the same scene depth,
                              which the prepass now lays down (no second depth pass).
        [x] culling         — `forge.objects.cull` + the HiZ pyramid read it (13.5).
        [x] transparency    — `forge.depth.resolve` (or the shared contact resolve)
                              writes full-resolution `r32float` depth; blended standard
                              draws use it for a short intersection fade while staying
                              outside the authoritative prepass.
        [x] post processing — HDR frames with non-`none` fog bind that resolve to
                              `forge.tonemap` for optional depth-aware final haze;
                              default no-fog and LDR output remain unchanged.

    [x] Cutout (alphaTest), fading (opacity < 1) and water surfaces in the prepass
        (a material-aware fragment stage matches forward alpha coverage; water uses
        its deformed vertex path), so eligible surfaces get early-Z. Transparent and
        overlay surfaces remain intentionally outside the prepass.

    [x] SSAO for orthographic cameras. The uniform carries a projection-mode bit;
        the kernel uses a constant pixels-per-metre radius and reconstructs view depth
        along the camera forward axis instead of dividing by clip.w.


13.2 Render Graph Aliasing Validation

    [x] Create real production passes that exercise transient resource
        aliasing. (The SSAO chain: `ssao.raw` → `ssao.blur` → `ssao.result`; the
        raw estimate's memory is reused for the result.)

    [x] Verify aliasedBytes becomes meaningful in normal frames. (Every frame with
        SSAO: 921,600 B at 1280x720 — PBR fixture 11 transients → 10 textures;
        tests/rendering/frame.test.ts, check:browser.)


13.3 Clustered / Forward+ Lighting

    [x] Implement GPU-friendly clustered lighting. (A 16x8x24 view-space grid built
        on the CPU and read from the fragment stage: `engine/src/rendering/clusters.ts`
        → `ClusterUniforms` / `ClusterLightBlock` / `ClusterGridBlock` on frame
        bindings 6-8 → `clusterIndexOf` + `lightContribution` in
        `shaders/standard.ts`, behind `perFrame.flags` bit 5; `Renderer.buildClusters`
        uploads the used prefixes and nothing is allocated per frame. Adds no pass —
        the graph is identical with it on or off, and so is the picture while a scene
        fits the old list. docs/RENDERING.md §4b; tests/rendering/clusters.test.ts (18),
        tests/rendering/frame.test.ts (6 clustered), tests/rendering/wgsl.test.ts, check:browser.)

    [x] Remove fixed CPU light-list limitations. (The frame now carries 256 local
        lights (`MAX_CLUSTERED_LIGHTS`) with at most 32 per cluster
        (`MAX_LIGHTS_PER_CLUSTER`), the least influential evicted by
        intensity x colour luma and *reported*, instead of 16 entries truncated
        silently; directional lights stay in the uniform list, where the cascade
        caster's shadow index lives. New stats: `lights`, `clusteredLights`,
        `clustersUsed`, `clusterIndices`, `maxLightsPerCluster`, `lightsDropped`.
        check:browser drives the demo's 36-lamp rig: 40 lights in the scene, 39
        clustered, none dropped, 88,036 px brighter than the truncated uniform path
        and none darker. GPU-side assignment and the light-count stress benchmark
        are 13.4.)


13.4 GPU Light Culling

    [x] Cluster lights on GPU where practical. (The *fill* becomes one compute pass,
        `forge.lights.assign`, first in the frame: one invocation per cluster in 12
        workgroups of 256, reading the frame's packed ranges (`ClusterRangeBlock`,
        2 KB) and the grid's counts, writing the index lists — at most `counts[c]`
        entries per cluster, so a wrong count trims a list instead of spilling into
        the next one. `prepare` and `count` stay on the CPU because their output is
        needed exactly and immediately (the fragment stage indexes with `counts`,
        `stats` reports them, `lightsDropped` is a correctness signal) and because
        neither grows with coverage; nothing is read back, so `clustersUsed`,
        `clusterIndices`, `maxLightsPerCluster` and `lightsDropped` are the CPU's own
        numbers for the same frame. `assignClustersOnCpu` is the shader's twin and
        tests/rendering/lightCulling.test.ts pins it byte for byte (evictions included);
        `RendererOptions.lightCulling` = auto|cpu|gpu, `stats.clusterFill`, demo
        `?lightculling=cpu|gpu` + HUD. docs/RENDERING.md §4c; tests/rendering/lightCulling.test.ts
        (11), tests/rendering/frame.test.ts (round trip), check:browser — the two fills give an
        identical picture and identical grid stats on one frozen scene, the pass is in
        the gpu arm's frame and not the cpu arm's, and the many-light frame is strictly
        brighter than the truncated uniform path with no pixel darker. The generated
        range decode is parenthesised (`((key >> shift) & mask)u`): Tint rejects `<`
        mixed with `&` at parse time, which invalidated every pipeline on the device
        while every CPU gate stayed green, so `validateWgsl` now fails on that shape.)

    [x] Add light-count stress benchmark. (benchmarks/src/lights.bench.ts, run by
        `npm run bench` in CI: `prepare`/`count`/`fill` timed per frame over 16/64/256
        lights on two rigs — the demo's spread shape (~30 clusters per lamp) and a
        saturating one (every lamp in every cluster). Measured on the dev box: the
        spread rig's fill goes 922 -> 7,749 list entries in 0.01 -> 0.50 ms, the
        saturating rig reaches the 98,304-entry grid (3072 clusters x cap 32) in
        74.8 ms, while the counting pass stays 0.04-0.09 ms at every light count. The
        guards are shape checks (fill follows coverage; count does not; the worst case
        is under a second) so a slow runner cannot turn a correct build red.)


13.5 GPU Object Culling

    [x] GPU frustum culling. (`forge.objects.cull`, one invocation per batch in
        ceil(batches/64) workgroups, between `forge.prepass` and the SSAO chain; the
        six planes are extracted in-shader from the frame's own view-projection, as
        `Frustum.setFromViewProjection` extracts them on the CPU — unnormalized rows,
        compared against a sphere radius with `CULL_SLOP`. `ObjectBatchBlock` carries
        one 32-byte entry per batch in draw order, and the verdict lands in
        `ObjectUniforms.visibilityIndex`'s word, which the vertex stage reads as group
        1 binding 2 (minBindingSize 4, reset to zero every frame by one writeBuffer).
        `cullBatchesOnCpu` is the twin the mock device runs; tests/rendering/objectCulling.test.ts
        (16), tests/rendering/frame.test.ts (3), check:browser.)

    [x] GPU distance culling. (`Renderable.maxDistance` is a draw rule: a batch is
        dropped once its bounding sphere no longer touches its limit
        (`distance - radius > limit`), so the limit travels in the bounds entry
        (`ObjectBatchEntry.min.w`) and a merged batch keeps the most permissive
        member's. The frame's flags carry a distance bit only when some batch in it
        has a limit, so a frame with none does not pay for the test. `stats.
        cullDistance`.)

    [x] Optional HiZ/occlusion culling. (`forge.hiz.0..<n>` reduce the prepass depth
        into a pyramid of view-space metres (2x2 max, unwritten texels = `far`), and
        the cull pass drops a batch only when every texel under its padded footprint —
        the projection of the sphere's view-space box — is nearer than its nearest
        point minus `CULL_EPSILON`; the level is picked so texels are a few pixels
        across. The pixel row is the negated NDC y (texel row 0 is the top): the
        mirrored rectangle is over the *other half of the screen*, which culled
        floating geometry against the ground rows below it — check:browser saw it as
        `disabling occlusion culling changed 16161 px`, and tests/rendering/objectCulling.test.ts
        now pins the sign. Perspective-only, off on the CPU twin (no depth), skipped
        when the target cannot build a pyramid; a frame the renderer did not ask to
        occlude neither reads the depth nor declares levels. Stats `cullTested`,
        `cullFrustum`, `cullOccluded` come back through one map-read copy per frame —
        one frame late, because a device-side count cannot be known sooner.
        `RendererOptions.objectCulling` = auto|cpu|gpu, `occlusionCulling` on/off,
        demo `?objectculling=cpu|gpu` / `?occlusionculling=0|1` + HUD line + the
        `setObjectCulling`/`setOcclusionCulling` hooks. docs/RENDERING.md §4d;
        benchmarks/src/culling.bench.ts, run by `npm run bench` in CI: measured on the
        dev box the twin costs 1.1 us/batch (9.2 ms for the full 8192-batch cap, 3.0 ms
        frustum-only and 3.7 ms with the distance limits) while building the
        1280x720 pyramid on the CPU costs 39.5 ms/frame — the reduction the device does
        in-frame, which is why the twin leaves occlusion to it. The guards are shape
        checks (per-batch cost stays linear; the distance test stays a comparison; the
        cap stays inside a frame) so a slow runner cannot turn a correct build red.
        The visible-object compaction and indirect draws that consume this buffer
        landed in 13.6.)

    [x] Per-instance culling inside a batch: one visible instance no longer keeps the
        whole ordinary instanced batch. The shared two-stage population culler compacts
        ordinary static instanced renderables as well as population batches; its dynamic
        source window leaves the frame arena intact and `forge.main` consumes the batch
        records indirectly.

    [x] Culling the shadow cascades with the same pass. Ordinary instanced batches and
        population batches append per-map caster indices in `forge.populationCull.views`;
        the CPU range path remains the conservative fallback when the device path is off.


13.6 Indirect Rendering

    [x] GPU-generated indirect draw commands.

        The cull pass now writes draw commands, not just verdicts: one 32-byte record
        per batch (`DRAW_RECORD_WORDS` 8 / `DRAW_RECORD_BYTES`, 16-aligned slots, so
        both `drawIndexedIndirect` and `drawIndirect` can read it), seeded by the CPU
        with the batch's index window (indexCount / count / indexStart) and owned by
        the pass in one word only — the instance count, the batch's own when the
        batch is visible and 0 when it is not. `forge.main` submits through the
        records whenever `Renderer.indirectDraws` is on (the default), at
        `batch.cullIndex * 32`; a zero-instance record is a draw the device does not
        run at all, where Phase 13.5's collapsed clip position still paid for every
        instance's vertex stage. The mock reads the record bytes back out of the
        buffer for every indirect draw, so the unit tests assert the words rather
        than the renderer's intention. Stats `indirectDraws`; demo `?indirectdraws=0|1`
        + `setIndirectDraws`. docs/RENDERING.md §4d.

    [x] Visible-object compaction.

        The same pass writes a compacted list of the visible batch indices
        (`atomicAdd(&counts.visible, 1u)` for the slot, so the order is the device's,
        not the frame's) into `cull.visibleBatches`, one slot per visible batch, at
        most `MAX_CULLED_BATCHES` of them. It is the producer a compaction-driven
        frame consumes (a `firstInstance` offset into the instance arena per slot is
        the natural next step, and the record's slot is already the batch index, so
        nothing about the list has to change for it); the counters that describe it
        are exact on both arms — `visible = tested - frustum - distance - occluded`
        and `recordZeroed = frustum + distance + occluded` are identities the unit
        tests and the browser gate both assert. Batches past `MAX_CULLED_BATCHES`
        keep the CPU-uploaded record, so "untested" stays "draw".


13.7 Async Pipeline Compilation

    [x] Implement the architecture's intended async pipeline path.

        `PipelineFactory.getReady()` starts one `createRenderPipelineAsync()` per cache key and
        returns immediately; the renderer skips only the draws whose variants are not ready yet.
        The synchronous `get()` remains available for explicit tooling and the deterministic mock.

    [x] Expose:

        `pipelinesPending` and async `pipelineFailures` in renderer stats.

    [x] Never block a frame waiting for pipeline creation.

        Renderer call sites use the non-blocking lookup by default on real devices. Startup fallback
        keeps forward depth writes correct while prepass and forward variants compile.


13.8 GPU Timing

    [x] Wire timestamp queries where supported.

        RenderGraph brackets render and compute passes and resolves into a three-slot readback ring;
        `mapAsync()` updates stats later and is never awaited by `execute()`. Devices without the
        optional `timestamp-query` feature continue without timing.

    [x] Expose:

        GPU frame time, per-pass time, compute time and render time through `Renderer.stats` / `engine.stats().render`; the Profiler receives per-pass GPU samples.


13.9 Shadow Improvements

    [x] Per-object cascade assignment.

        Each caster gets a conservative cascade bitmask from its world AABB. Contiguous instances
        with the same mask become `firstInstance` ranges within the existing colour batch, so each
        shadow layer submits only the instances assigned to it without fragmenting the main draw.
        `shadowInstancesDrawn` and `shadowInstancesCulled` report the assignment work; objects whose
        bounds intersect multiple cascade volumes remain in each corresponding layer.

    [x] Spot shadows.

        The first four valid shadow-casting spot lights share the directional depth-array atlas,
        appended after active cascade layers. Every map uses the frame's capped shadow resolution;
        per-light/adaptive resolution is intentionally deferred. Spot indices survive uniform and
        clustered light paths, and caster AABBs are assigned against each spot frustum. Covered by
        math/frame/WGSL tests and the PBR browser visual A/B; `Renderer.stats.spotShadowMaps` reports
        the active spot-map prefix.

    [x] Point shadows.

        The first two valid shadow-casting point lights each render six 90° cube faces into the
        shared depth-array atlas (layers follow the spot maps; face order +x -x +y -y +z -z), all
        at the frame's capped shadow resolution. Caster AABBs are assigned per face behind a range
        sphere pre-test; the shader selects the dominant face per fragment and PCF-samples it
        (WebGPU has no depth-cube comparison sampling). Point slots survive both the uniform and
        clustered light paths. Covered by math/frame/WGSL tests and the PBR browser visual A/B;
        `Renderer.stats.pointShadowMaps` reports the active cube prefix.

    [x] Contact shadows.

        A short, configurable screen-space ray (`contactDistance`, `contactStrength`)
        samples a full-resolution `r32float` resolve of the prepass depth in the forward
        shader. The pass is opt-in (`settings.shadow.contactShadows`) and complements,
        rather than replaces, directional/spot/point atlas shadows; the renderer option
        can veto it and the neutral fallback keeps the frame bind group stable.

    [x] Adaptive shadow resolution.

        When `settings.shadow.adaptive` is enabled, the complete active depth atlas is
        reduced by powers of two until it fits `RendererOptions.shadowMemoryBudget`
        (256 MiB by default), with a 128 px floor. When `adaptive: false`, the renderer
        retains the requested shared resolution and does not apply the adaptive budget.


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

    [x] Placement determined by:

        seed
        chunk coordinate
        population type

        `scatterPopulationChunk` (engine/src/population/scatter.ts) is a pure function of
        `(type, seed, chunk coordinate, sampler)`: a `chunkSeed`-derived `Rng` stream over a
        stratified jittered grid (one candidate per `densityGrid²` cell), with slope, height-band
        and `maxPerChunk` rules rejecting candidates after every random draw so the stream position
        never depends on acceptance. Bit-for-bit reproducibility pinned by tests/population/population.test.ts.

    [x] Load-order-independent surface sampling: acceptance samples come from TerrainWorld's
        fixed-resolution canonical surface rather than the resident tile's first-ready LOD, so the
        same chunk scatters the same instances in every load order. Inline and worker generation use
        the same bilinear grid sampler; tests/population/population.test.ts compares coarse-first and
        fine-first resident tiles bit-for-bit.


14.2 Population Types

    [x] Rocks
    [x] Boulders

        Both ship in the terrain demo on the shared `rockGeometrySource` primitive (displaced,
        optionally squashed sphere; deterministic per seed). Boulders are the same geometry at a
        larger scale band with a tighter slope limit and deeper embed.

    [x] Debris

        Fractured, low-profile slabs scatter as their own material/geometry type with a tighter
        scale band and shorter draw distance than the native rocks.

    [x] Vegetation

        A procedural rosette-scrub prototype has tapered radial leaves with explicit front/back
        faces; slope filtering keeps it on plantable ground.

    [x] Decals

        Flat, +Y-facing erosion discs use a translucent material, skip shadow casting, and use a
        small negative surface offset to avoid z-fighting on nearly flat terrain.

    [x] Environmental props

        Low-poly mineral spires provide a sparse, longer-range landmark type, with their mesh base
        anchored at the surface.


14.3 Instance Storage

    [x] Compact instance buffers.
    [x] Device-resident instance buffers.

        `PopulationInstanceBlock` (engine/src/scene/population.ts) is SoA typed arrays — positions
        (3), non-uniform scales (3), Y rotations (1), packed tints (1) — allocated once per
        (chunk, type), no per-instance object anywhere. The renderer composes the records
        (`composeYTRS`, math/mat.ts) once per content revision and uploads them to a *device-
        resident* buffer that lives as long as the chunk: one stable GPUBuffer plus one draw bind
        group per (chunk, type), bound in place of the frame's instance arena. A live chunk costs
        zero per-frame instance copies — `stats.populationUploads` is 0 in steady state — and the
        buffer is destroyed when the source stops offering the chunk (terrain eviction). A remesh
        re-anchor moves the revision and is the only other event that re-uploads. Pinned by
        tests/population/population.test.ts (seam + streamed-terrain suites).


14.4 GPU LOD

    [x] GPU-selected object LOD.

        Population prototypes are built into one merged, unindexed hi+lo vertex buffer
        (`buildLodGeometry`, `engine/src/population/lod.ts`): the high window's triangle list comes
        first, then the low window. The renderer writes `hiTriangles` into the existing object
        uniform slot and, in `forge.populationLod`, dispatches one invocation per instance to set
        the low-window bit in the device-resident instance record when its origin is strictly
        farther than the type's `lodDistance` from the camera. Standard colour, depth-prepass and
        shadow vertex entries clip out the unselected half; even a one-instance population batch
        takes the instanced entry. The mock compute pass applies the same decision to its backing
        buffer. Tests pin merge/attribute ordering, the distance boundary, camera reselection without
        an instance re-upload, 256-byte uniform slots for multiple LOD batches, all three render
        paths, and streamed `PopulationWorld` metadata propagation (tests/population/population.test.ts,
        tests/rendering/pipeline.test.ts). The terrain demo exercises separate hi/lo rock and boulder meshes.


14.5 GPU Culling

    [x] Population culling.

        Each (chunk, type) submission becomes its own batch with its own conservative bounds, so
        the Phase 13.5 device object culler (frustum, distance, HiZ) and the Phase 13.6 indirect
        records apply to populations unchanged; a type's `maxDistance` is the per-batch distance
        limit the culler enforces. The shared `forge.populationCull` path now also compacts each
        eligible population instance for colour, prepass and shadow maps; a CPU/per-batch fallback
        remains when the device path or indirect draws are off.

    [x] Per-instance culling inside a batch (fe-30, GPU-placement Phase A): `forge.populationCull`
        tests every instance of an instanced population batch (frustum, distance, HiZ), merged with
        the 14.4 LOD selection in one dispatch, and compacts survivors into the batch's indirect
        draw (atomic append, the particle pattern). Placement unchanged. Device-tier aware (low tier:
        no per-instance HiZ); per-batch fallback when the device culler or indirect draws are off.
        docs/RENDERING.md §4g; tests/population/populationCull.test.ts; check:browser terrain A/B.
    [x] Per-instance culling for shadow casters and the depth prepass (fe-31): `forge.populationCull.views`
        (before the depth passes) tests every instance against the camera and each sun cascade, spot
        map and point face its chunk touches; casters append 4-byte indices to per-map ranges of one
        shared buffer per chunk, drawn indirectly by `DEPTH_CULLED_VERTEX`; the prepass draws the
        main-view list `forge.main` draws (or its HiZ subset). Low tier: cascades only. CPU twins,
        HUD `pop shadow … in → … drawn`, check:browser terrain shadow A/B. docs/RENDERING.md §4g.
    [x] Population distance fade and per-tier draw distance (fe-31): instances shrink about their pivot
        to nothing over the last 25% of their distance (`populationFadeFraction`) in forge.main, the
        prepass and every shadow map alike, and the per-instance cull fires exactly at the fade end, so
        nothing pops; `populationDistanceScale` 0.75 / 1 / 1.5 for low / medium / high
        (`populationCullingForTier`). docs/RENDERING.md §4g; check:browser terrain distance A/B.


14.6 Population Streaming

    [x] Population follows terrain/world chunk streaming.

        `PopulationWorld` (engine/src/population/world.ts) diffs `TerrainWorld.chunks` every update:
        ready chunks get populations within a per-frame budget, evicted chunks lose them, and an
        LOD remesh re-anchors Y positions to the new heightmap without re-scattering XZ placement.
        Zero ECS entities are created — pinned by tests/population/population.test.ts.

    [x] Population generation on workers: `population.chunk` reconstructs the canonical terrain
        surface from the serialized pipeline and runs the same scatter/settling body on TaskScheduler
        workers, transferring typed-array results back to PopulationWorld. Unsupported custom/live
        Stage A pipelines and unavailable schedulers use the deterministic inline fallback. Covered by
        tests/population/population.test.ts and the task worker protocol suites.

    [x] Population raycast: PopulationWorld implements the SceneObject raycast seam and tests each
        resident instance's prototype geometry through its YTRS matrix, returning the nearest triangle
        point/normal and a decodable chunk/type/instance tag. Covered by tests/population/population.test.ts.


EXIT CRITERIA:

    Large populations can exist without equivalent CPU object counts.


================================================================================
                       PHASE 15 - ASSET PIPELINE 2.0
================================================================================

GOAL:

    Turn the existing asset tooling into a scalable runtime asset system.


15.1 Content Addressing

    [x] Stable AssetID.

        `AssetId` (engine/src/resources/assetId.ts) is the one place resource identity is
        constructed and parsed: `<kind>:<address>` with two address forms — `texture:assets/rocks.png`
        (path-addressed, today's style) and `texture:c/<sha256>[~name]` (content-addressed).
        Constructors validate at call time (`UsageError`), `parse` returns `null` for legacy bare
        ids instead of throwing, and the registry exposes `info(id)` for the parsed metadata.

    [x] Content hashes.

        `hashContent` is the pipeline's single hasher (SHA-256 via WebCrypto; async, never blocks
        a frame). A `ResourceDescriptor` may carry the id's `contentHash`; re-acquiring the same
        id with a different hash means the bytes changed under a stable path id, so the cached
        value is released and re-loaded and `events.contentChanged` names the transitive loaded
        dependents that now hold stale values (the fix for the "edit the file in place, the
        registry serves old bytes forever" failure).

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

    [x] The graph above, live in the registry.

        `AssetGraph` (engine/src/resources/assetGraph.ts) stores (dependent → dependency) edges in
        both directions with cycle detection at link time. A descriptor reports its deps via
        `dependencies(value)` once the value exists (a glTF only knows its textures after
        parsing); the registry registers the edges on load, re-registers on `retry`, and clears
        them on eviction. A loaded dependent blocks eviction of its dependencies and the scan
        cascades within one `evictIdle`, so a whole chain leaves together. `invalidate(id)`
        releases an asset and returns the transitive loaded reload list (the Phase 15.4 hot-reload
        hook); `dependenciesOf`/`dependentsOf`/`subgraph` serve the editor's asset browser. The
        graph is metadata + safety, not a load scheduler — loaders pull their own deps through
        `context.registry` (orchestration is 15.3).


15.3 Streaming

    [x] Async asset loading.

        `AssetStreamer` (engine/src/resources/streaming.ts) is the scheduler in front of the
        registry: `request()` only queues, and loads start when `pump()` admits them — once per
        frame, before systems run (`Engine.step` pumps `engine.streamer`, so a scene can use what
        lands that frame). Nothing blocks the simulation loop: a frame admits what it can and the
        rest waits. `Engine.settle()` drains it; `engine.stats().streaming` shows queue depth,
        in-flight count and budget state for the HUD.

    [x] Cancellation.

        `streamer.cancel(id)` drops a queued load outright (it never runs, never touches the
        registry); an in-flight load goes through the registry's new `cancelLoad` — the load
        finishes off the record, its output is disposed, the entry fails with a cancellation
        error, and the streamer classifies it as `cancelled` (not a failure). A cancelled or
        failed id is re-requestable: the retry goes through the queue like any real upload.

    [x] Prioritization.

        The queue drains highest `descriptor.priority` first (FIFO ties) under a `maxConcurrent`
        in-flight cap. A high-priority texture a visible object needs jumps over queued background
        pre-fetches; the streamer's lease on an in-flight entry keeps it eviction-safe mid-load.

    [x] GPU upload budgeting.

        Each frame carries `uploadBudgetBytes` of estimated upload, reset by `newFrame()`.
        Admitting a load charges its `descriptor.estimatedBytes` (a conservative pre-load
        estimate — `bytes(value)` stays the post-load accounting for the eviction budget); items
        that do not fit stay queued, so a 16 MB pre-fetch never starves the frame and smaller
        high-priority items still make it. Verified on real WebGPU: three 85 KB priority-9
        textures admitted one per frame, 20 KB smalls packed at the cap, a mid-queue cancel that
        never reached the GPU, 7/7 admitted textures ready, zero GPU errors (targeted probe, see
        docs/VERIFICATION.md).


15.4 Hot Reload

    [x] Mesh, texture and material resource replacement.

        `AssetHotReloader` (`engine/src/resources/hotReload.ts`) stages a replacement under a private
        id through `AssetStreamer`, keeps the old ready value alive while loading/validating, then
        runs the caller's synchronous consumer-swap callback before the registry adopts the new value
        and disposes the old one. The stable id, dependency edges, byte accounting and content-hash
        events are updated at commit. Failed and cancelled stages leave the live value untouched;
        same-hash in-flight requests are shared and differing versions serialize. The generic
        descriptor API covers mesh/texture/material values without imposing a file-watcher or
        importer on callers. Verified in `tests/resources/phase15.test.ts`.

    [x] Shader reload.

        `PipelineFactory.replaceShaderSource` runs the engine's WGSL structural/layout validator
        before it invalidates pipeline bundles; `clearShaderOverride` returns to the built-in source.
        Invalid source leaves the last good pipeline cached. Verified in
        `tests/rendering/shaderHotReload.test.ts`.


15.5 Asset Validation

    [x] Invalid mesh detection.
    [x] Missing texture detection.
    [x] Unsupported material detection.
    [x] Excessive memory detection.

        `engine/src/resources/validation.ts` provides structured mesh-stream/index, texture
        dimensions/mip/format/capability/block-alignment, material-technique/PBR, dependency and
        memory-budget diagnostics. `ResourceDescriptor.validate` rejects error-severity output before
        publication and disposes rejected values; warnings remain observable through the logger.
        Verified in `tests/resources/phase15.test.ts`.


15.6 KTX2 / Basis

    [x] Transcode supported KTX2/Basis content to the best available WebGPU texture format.

        `loadKtx2Texture` lazily loads the pinned Basis Universal WASM, detects the KTX2 DFD transfer
        function, transcodes each mip/layer/face, and uploads BC7, ASTC, ETC2 or RGBA8 LDR data;
        HDR content selects BC6H or RGBA16F. `Texture.writeMipData` preserves block-compressed mip
        data, including the physical whole-block extents required for lower mips. Automatic selection
        falls back to RGBA when the device lacks compression support or the base dimensions cannot be
        represented by a block-compressed WebGPU texture. Verified with a real ETC1S fixture through
        Basis WASM in `tests/resources/phase15.test.ts`, target-selection/mock-upload coverage there, and a
        Chromium/SwiftShader WebGPU upload of a 40×40 sRGB texture with six BC7 mips (2,240 GPU bytes,
        no validation or page errors; see `docs/VERIFICATION.md`).

    [>] KTX2 3D/volume textures.

        The bundled JS transcoder binding does not expose volume slices; `loadKtx2Texture` rejects
        depth-bearing KTX2 files explicitly. 2D, 2D-array, cube and cube-array textures are supported.


EXIT CRITERIA:

    Large scenes can load assets incrementally.
    Asset loading does not block the simulation loop.
    Resource and shader replacements are staged and only committed after validation.
    Invalid geometry, absent texture dependencies, unsupported material data and excessive memory
    are reported before invalid assets become live.
    Supported KTX2/Basis assets upload on a real WebGPU implementation with device-appropriate
    compression or an RGBA fallback.


================================================================================
              PHASE 15.5 - INTERACTIVE TERRAIN / OBJECT DYNAMICS
================================================================================

GOAL:

    Turn selected streamed terrain population into physically meaningful, near-field
    interactions without making every GPU instance a rigid body. Small rocks can be pushed,
    roll under gravity and break under sufficient load; large obstacles can stop or damage the
    rover; and soft sand can retain shallow wheel-track impressions.


15.5.1 Interactive Population Proxies

    [x] Stable population instance identity.

        The first showcase bridge uses the deterministic `(chunk, rocks, index)` identity and the
        reusable `InteractiveRockProxy` contract. The identity is derived from the streamed population
        block rather than a transient renderer batch index; persistence across deformation and save/load
        is covered by 15.5.5's validated interactive-terrain snapshot.

    [x] Near-field proxy admission and eviction.

        `marsShowcaseScene.ts` promotes type-1 rocks only inside the bounded 48 m interaction radius,
        adds them to a gravity/heightfield `PhysicsWorld`, and removes proxies as chunks or rocks leave
        that radius. Distant instances remain GPU-only and no ECS entity is created per rock.

    [x] Shared render/physics transforms.

        The showcase bridge uses the same streamed block position/scale and Mars heightfield as the
        renderer and rover ground query. Proxy motion is copied back into the instance block, including
        yaw, and the block revision is marked only when a body actually moves. A debug body budget is
        exposed through `marsState().interactiveRocks`; proxy visualization is still open.


15.5.2 Push, Roll and Destruction

    [x] Material and strength model.

        `InteractiveRockMaterial`, `MARS_ROCK_MATERIAL` and `createInteractiveRockSpec` derive mass,
        friction, restitution, crush strength, push force and climb height from the proxy shape. The
        Mars Showcase now uses this profile instead of hard-coded per-rock thresholds; values are
        validated before a dynamic proxy is created. Per-instance geology remains a future material
        refinement, outside the bounded phase contract.

    [x] Dynamic rock bodies.

        `InteractiveRockProxy` owns a dynamic `RigidBody`; the Mars Showcase admits nearby proxies to
        a Mars-gravity `PhysicsWorld` with a shared terrain heightfield. Contact impulses move the
        body, and ordinary rigid-body gravity/inertia allow it to slide or roll when support is lost.
        The showcase uses a simplified sphere rather than the render mesh; compound shapes and crater
        edge fidelity are intentionally future collision refinements.

    [x] Break and settle behavior.

        When impact force exceeds the material-derived break strength, the showcase zeroes the
        population instance, marks its block revision, removes the dynamic proxy and records the
        broken-rock count in `marsState()`. The broken state is deterministic and does not spawn
        fragment bodies; fractured pieces remain a future visual refinement, while persistence and
        save/load are covered by 15.5.5.


15.5.3 Rover Obstacle Response

    [x] Vehicle/rock contact bridge.

        `bridgeRockContact` transfers the assessed normal contact through the rover velocity and the
        dynamic rock proxy, while the showcase keeps wheel suspension on the terrain heightfield.
        Blocked contacts retain tangential motion but remove most inward velocity; pushable contacts
        transfer a smaller share to the rock. The current bounded separation bridge prevents persistent
        overlap; swept continuous contacts and per-wheel manifolds remain future vehicle refinements.

    [x] Climb, push and damage rules.

        Contact height, available traction and material-derived push force distinguish climbable,
        pushable and blocked rocks. `applyRoverImpactDamage` applies bounded hull, wheel and suspension
        damage to tall blocked impacts; a disabled rover cuts throttle and holds its brake. Damage and
        disabled state are exposed through `marsState()`. Per-wheel contact manifolds and repair/gameplay
        recovery remain future vehicle refinements.

    [x] Deterministic physics and browser evidence.

        CPU coverage replays promotion, impulse, gravity, rolling, blocking and damage decisions
        deterministically. The focused `npm run check:browser:mars-interactive` arm verifies the live
        streamed showcase promotes near-field rocks, records wheel tracks and runs the interaction
        interval with zero GPU errors. The full gate is now composable from focused commands; the
        heavier HGA/arm suite remains separate and the browser arm deliberately avoids a slow capture.


15.5.4 Sand Deformation and Wheel Tracks

    [x] Persistent per-tile deformation state.

        `TerrainDeformationField` stores bounded, chunk-keyed shallow wheel deltas separately from the
        procedural generator, supports sampling, revision tracking and serialize/restore, and the Mars
        Showcase records load-bearing wheel impressions into it. The rover ground query, camera clamp
        and interactive-rock heightfield consume the deltas, while the showcase snapshot API preserves
        them across eviction/save boundaries. Terrain-mask rendering and material-specific resistance
        remain future refinements rather than hidden gaps in the persistence contract.

    [x] Visual tracks first.

        The Mars Showcase now records load-bearing wheel contacts into a bounded ring of translucent
        terrain decals. Track marks are placed above the shared streamed surface, reuse one mesh/material,
        and expose `visibleTrackMarks` for the browser gate. Tile-owned mask integration and displaced
        sand edges remain future material refinements; the bounded physical response is covered below.

    [x] Physical track response.

        The Mars Showcase ground query, camera clamp and interactive-rock heightfield now include the
        bounded deformation field, so subsequent wheel samples run in the shallow pressed-in track.
        Track depth is load-scaled and clamped; material-specific sand/crust resistance and traction
        changes remain open for a later terrain-material refinement.


15.5.5 Performance, Streaming and Save/Load

    [x] Bound the interaction budget.

        The Mars Showcase caps active interactive rock proxies at 64 inside the 48 m interaction
        radius; distant rocks remain render-only and the population path remains instanced. The
        deformation field caps runtime state at 128 chunks, and the visual track ring caps marks at
        256. Budgets are exposed through `marsState()` where applicable.

    [x] Persistence and diagnostics.

        The Mars Showcase exposes `saveInteractiveTerrain()` / `restoreInteractiveTerrain()` snapshots
        containing stable broken-rock identities and serialized deformation chunks. Restore removes
        matching active proxies before they can respawn. `marsState()` reports active/budgeted proxies,
        broken rocks, damage, deformation chunks/samples/revision and visible track marks; malformed or
        unsupported snapshots are rejected.


EXIT CRITERIA:

    Near-field rocks have stable identities and bounded physics proxies.
    Small rocks can be pushed; rocks can roll when unsupported; excessive impacts can break rocks.
    Heavy/tall obstacles block or damage the rover without tunnelling or destabilizing terrain contact.
    Wheel tracks are visible, persist through terrain streaming, and produce bounded sand response.
    CPU determinism, memory budgets, focused browser checks and real-WebGPU evidence are documented.


================================================================================
                         PHASE 16 - ANIMATION
================================================================================

GOAL:

    Add a production-capable animation system.


16.1 Animation Clips

    [x] glTF animation import (STEP, LINEAR, CUBICSPLINE; translation, rotation, scale channels;
        worker-decoded via `decodeGltfAnimations`, assembled into engine clips via `assembleClip`;
        tests/animation/animation.test.ts, tests/resources/gltf.test.ts)

    [x] clip sampling (stateless `sampleClip` with STEP/LINEAR/CUBICSPLINE interpolation,
        quaternion SLER with NLERP fallback, Hermite spline for cubic, identity initialisation,
        per-track validation; 44 tests in tests/animation/animation.test.ts)

    [x] animation component and system (AnimationComponent extends Component, registered;
        AnimationSystem at order 300: dt advance, loop wrap, clamp-stop, multi-clip NLERP blend
        with weight normalisation, per-joint TRS application to Transform; stats: clipsPlayed,
        keysSampled)

    [x] skeleton node mapping (nodeToEntity array, per-node TRS buffer with NODE_STRIDE=10,
        identity initialisation for un-targeted joints, blend with existing transform for
        weight < 1)

        Phase 9.1 supplies worker-backed static glTF/GLB triangle decode. The rest of extended
        import is split into slices (`capability: assets.gltfAdvanced` until all land):

    [x] 16.1a skin import (`skins[]` joints / inverse bind matrices / skeleton, `node.skin`, one
        JOINTS_0/WEIGHTS_0 set per primitive decoded on the worker into `SkinningVertexData`-shaped
        arrays, spec validation; extra JOINTS_n/WEIGHTS_n sets are ignored when all-zero and rejected
        when weighted, with `npm run gltf:strip-skin-sets` (tools/gltf-strip-extra-skin-sets.mjs) to
        remove them; decode only, not browser-verified; tests/resources/gltf.test.ts,
        tests/tools/gltfStripSkinSets.test.ts; capability: assets.gltfSkins)

    [x] 16.1b morph targets: POSITION/NORMAL/TANGENT deltas, mesh/node defaults, flattened `weights`
        animation channels and CPU geometry updates through `instantiateGltfScene`; covered by
        `tests/resources/gltfScene.test.ts` and `tests/animation/animation.test.ts`

    [x] 16.1c images / samplers / textures and engine material assembly: the decoder returns
        `images` (embedded bufferView / data-URI bytes, or an external `uri`), `samplers`, `textures`
        and `normalTexture.scale`; `loadGltfTextures` decodes each image once on the main thread
        (createImageBitmap, no premultiply / colour conversion) into sRGB colour or linear data
        textures with mips, and `instantiateGltfScene({ textures })` binds baseColor, emissive
        (factor × map), metallicRoughness, normal and occlusion (strength, ambient only) maps, each
        with its own glTF sampler (wrapS/wrapT, mag/min filters → `GraphicsDevice.samplerFromDescriptor`,
        cached by descriptor; material group bindings 11-16). alpha MASK discards below `alphaCutoff`
        (drawn opaque), doubleSided disables culling. Odd uint16 index counts are now padded for
        writeBuffer. TEXCOORD_0/TEXCOORD_1 is carried in the fixed material vertex interface and every
        texture slot honours `texCoord: 0/1`; KHR_texture_transform and KTX2 remain unsupported. Verified
        on CesiumMan, Perseverance.glb and the generated MaterialFeatures.gltf (CC0):
        tests/resources/gltfTextures.test.ts and `npm run check:browser:gltf-skin` (per-feature pixel
        A/B: albedo, emissive, occlusion, MASK, sampler); capability: assets.gltfMaterials

    [x] 16.1h glTF handedness: glTF is right-handed (front +Z, left +X); the engine is left-handed
        (+X right), so assets imported as-is were mirrored (verified: Orientation.gltf's letter F read
        backwards and its left-side marker sat on the viewer's left). `decodeGltfMesh` now mirrors x on
        import (positions, normals, tangents + sign, winding, bounds, node TRS/matrices, inverse bind
        matrices, translation/rotation keys) and warns once per file; `handedness: "preserve"` opts out.
        `npm run gltf:fix-handedness` bakes it into a file and marks `asset.extras.forgeHandedness`, which
        the importer then uses as-is. The Mars showcase's own Perseverance loader (examples/src/assets/
        glb.ts) is unchanged. tests/resources/gltfHandedness.test.ts; browser check: Orientation.gltf
        before/after

    [ ] 16.1i (deferred) Mars showcase on the engine importer: drop examples/src/assets/glb.ts (the
        showcase's own Perseverance loader) and load the rover through decodeGltfMesh +
        loadGltfTextures. This also fixes the rover's left/right mirroring (that loader skips the 16.1h
        handedness conversion); the articulation/arm conventions it relies on must be re-derived and the
        rover scenes/tests re-checked

    [x] 16.1g second UV set: carry TEXCOORD_1 in a stable secondary vertex stream (zero-filled when
        absent) and honour `texCoord: 1` on every texture slot; covered by `tests/resources/gltfTextures.test.ts`,
        `tests/resources/gltfScene.test.ts` and `tests/rendering/renderingSkinning.test.ts`

    [x] 16.1d EXT_mesh_gpu_instancing: decode per-instance TRS accessors and expand them into child
        entities during scene assembly; covered by `tests/resources/gltfScene.test.ts`

    [x] 16.1e Draco / meshopt geometry decompression: meshopt runs through inline/worker decoders;
        Draco accepts a host decoder and stays inline; metadata/output validation and both seams are
        covered by `tests/resources/gltf.test.ts`

    [x] 16.1f skinned glTF scene assembly: `instantiateGltfScene` builds one entity per node of the
        active scene with the glTF parent links and local TRS (matrices decomposed), binds each skin to
        the joint entities with the decoded inverse bind matrices, and attaches the asset's clips
        (now decoded with the mesh; TRS channels, STEP/LINEAR/CUBICSPLINE) to an AnimationComponent
        whose new `restPose` keeps channels a clip does not animate at their authored values.
        Materials were factor-only until 16.1c; skinned primitives cull against per-frame posed bounds (per-joint
        bind boxes × live joint matrices). Demo scene `?scene=gltf-skin` plays the Khronos SimpleSkin
        sample (CC0) and `&model=cesium` Khronos CesiumMan (CC-BY-4.0, textured since 16.1c; examples/assets/);
        tests/resources/gltfScene.test.ts (hierarchy, bind pose, sampled pose, mock skinned draw) and
        `npm run check:browser:gltf-skin` (real Chromium + SwiftShader: one skinned batch, 2 joints,
        no fallback, the live clip advancing, three clip times A/B'd per pixel);
        capability: assets.gltfSkinnedScene


16.2 Animation State Machines

    [x] states (named states backed by clips with looping/speed config;
        AnimationStateMachine.addState/removeState/start/stop; tests/animation/animationStateMachine.test.ts)

    [x] transitions (parameter-driven condition functions, priority-sorted evaluation,
        wildcard source state `*`, interruptible crossfade override, crossfadeDuration config;
        AnimationStateMachine.addTransition/removeTransition; tests/animation/animationStateMachine.test.ts)

    [x] blending (crossfade with configurable duration, easeInOut smoothstep or linear blend
        curve, proper weight ramp on outgoing/incoming clips, interruption of in-progress
        crossfade by higher-priority transition, forced transitionTo bypassing conditions;
        tests/animation/animationStateMachine.test.ts)


16.3 Blend Trees

    [x] 1D (BlendTree1D: sorted threshold array, linear interpolation between bracketing clips,
        values outside range clamp to nearest clip, at most 2 non-zero weights; tests/animation/animationBlendTree.test.ts)

    [x] 2D (BlendTree2D: rectangle layout with four corner clips, bilinear interpolation,
        parameter clamping to rectangle extents, four weights summing to 1;
        tests/animation/animationBlendTree.test.ts)


16.4 IK

    [x] Two-bone IK (analytic 2-joint solver: law of cosines for mid/root angles, Rodrigues'
        rotation, pole target / bend direction, unreachable-target clamping, weight blending,
        zero-length bone safety; tests/animation/animationIK.test.ts)

    [x] FABRIK (iterative N-joint solver: forward/backward reaching, bone length preservation,
        convergence tolerance, maxIterations, fixedRoot option, unreachable-target stretch,
        weight blending; tests/animation/animationIK.test.ts)


16.5 Skinning

    [x] Joint palette computation (computeJointPalette: world × inverseBindMatrix per joint,
        missing-joint identity fallback, multi-joint support; tests/animation/animationSkinning.test.ts)

    [x] Skinning data validation (validateSkinningData: weight sum check, joint/weight count,
        createIdentitySkinningData for default non-skinned fallback; tests/animation/animationSkinning.test.ts)

    [x] GPU upload pipeline (per-frame joint palette into one storage buffer, one
        `PALETTE_SLOT_ALIGN`-aligned slot per skinned batch, filled mesh-local
        (`inverse(meshWorld) × jointWorld × IBM`) from the joints' live world matrices and uploaded
        in a single write; JOINTS_0/WEIGHTS_0 as a second vertex buffer slot with the skinned vertex
        entries `vertexMainSkinned`/`vertexMainInstancedSkinned`; skinned variants of the colour,
        depth-prepass and shadow programs keyed by `skinned` in PipelineFactory, with the palette at
        group 3 behind an empty placeholder group for the programs that have no material group;
        RenderStats.skinnedBatches/skinJoints/skinFallbacks;
        tests/rendering/renderingSkinning.test.ts, tests/examples/skinningScene.test.ts, and the demo's skinned arm
        pixel-verified on a real adapter by `npm run check:browser:skinning`)


16.6 Mechanical Animation

    First target:

        rover wheels
        suspension
        steering
        robotic arm
        mechanical joints

    [x] mechanical rig (`animation/mechanical.ts`): 1-DOF joints of kind revolute (angle about a
        parent-frame axis), prismatic (offset along it) and aim (solved so the joint's local
        direction points at a target entity, optionally stretching a telescoping link to it).
        Poses are recomposed as `base ∘ motion` from the authored TRS every frame, so re-posing is
        idempotent (no drift); min/max clamps, `slew` rate limits (units/s, 0 = follow directly),
        angle wrap for odometers, and aim joints solved against the live local store so a joint
        declared after the ones it watches sees their pose from the same frame. Allocation-free
        scratch; tests/animation/mechanicalAnimation.test.ts

    [x] MechanicalSystem + MechanicalRigComponent (`animation/mechanicalSystem.ts`): per component,
        the channel source writes this frame's values, then the rig advances (limits + slew) and
        poses; order 310, after AnimationSystem (300) and after the fixed simulation band that
        produces the state the source reads; stats mechanicalRigs / mechanicalJoints /
        mechanicalJointsPosed / mechanicalJointsSolved / mechanicalJointsSaturated

    [x] rover wheels + suspension + steering (`vehicles/wheelRig.ts`): `createVehicleWheelRig` binds
        a Vehicle's per-wheel telemetry to joints — hub carrier (travel, prismatic), steering
        knuckle (the wheel's *own* Ackermann angle, so the rear knuckles the solver left at zero stay
        at zero), axle (odometer, sign-flipped on the left so both sides roll forward), trailing arm
        and damper (aim joints, telescoping to the carrier) — and `VehicleWheelSource` feeds them
        each frame. The Phase 6 playground builds the tyre/rim/cleat/nut geometry per corner and
        drops its box wheels; tests/examples/mechanicalScene.test.ts, `npm run check:browser:mechanical`
        (deterministic wheel poses A/B'd on a real adapter)

    [x] robotic arm: the Mars showcase's five-joint GLB arm chain is posed by a MechanicalRig
        (`MechanicalSystem` registered on that world) from the controller's channels instead of a
        hand-written pose loop; `wrap: false` is load-bearing, because the unfold deliberately takes
        the elbow the long way round (−242°) and wrapping would flip it through the ground. The
        browser gate reads the pivot angles back off the transform store and asserts they follow the
        command out of the stowed pose

    The phase's exit criteria (import, blend, skin, stream) are met for the animation subsystem;
    Phase 16 itself stays in progress because the 16.1i Mars importer migration remains deferred;
    skin decoding (16.1a), morphs (16.1b), textures/materials (16.1c), instancing (16.1d),
    compression (16.1e), skinned scene assembly (16.1f), UV1 (16.1g), handedness (16.1h),
    and mechanical animation (16.6) are landed.


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

    [x] Multiple-scattering approximation / LUT. (Phase 17.1: `environment/multiScattering.ts` is
        the reference table, `rendering/shaders/multiScattering.ts` the two compute entry points
        that build it on the device, and the sky pass adds it per march step. Built only when the
        sun moves past 0.5 deg or the atmosphere changes; the `rgba32float` LUT is written with
        `textureStore`, read with `textureLoad` in fragment stages, and read back in
        `npm run check:browser` against the CPU twin. `validateWgsl` rejects fixed-size storage
        arrays in fragment modules — the WebKit black-sky regression that prompted the texture path.)

    [x] Improved Mars atmospheric scattering. (The dust sky gains the most from the LUT — 2-5x
        luminance at every sun elevation the preset is used at — because a thin, strongly
        forward-scattering atmosphere loses most of its light to higher orders. The remaining
        wavelength-dependent Mie lobe landed with the Mars Orbit Explorer: `AtmosphereParams.mieAureole`
        adds a tight, per-channel forward lobe, which is Mars' blue sunset glow; its limits are in
        KNOWN-ISSUES.)

    [x] Better twilight. (Twilight is the second-and-higher orders: the sky integral alone goes to
        zero the moment the sun crosses the horizon. Measured 2.2x at the zenith and 6x at the
        horizon away from the sun, six degrees after sunset, Earth; the terminator columns carry an
        order-of-magnitude accuracy and the limit is documented.)


17.2 Aerial Perspective

    [x] Apply atmospheric distance scattering to scene geometry. (`SceneSkySettings.aerialPerspective`
        is opt-in; standard and water fragments integrate finite-path transmittance/in-scattering,
        with the Phase 17.1 LUT, CPU reference, frame-flag tests and real-WebGPU A/B verification.)


17.3 Cloud Improvements

    [x] Multi-layer clouds. (`SceneCloudSettings.layers` (1-4, default 3) splits the deck into
        sheets spread through a slab of `thickness` metres centred on `height`; each sheet carries
        its own scale (`scale*layerScale^i`), seed and advection (`wind*(1 +/- layerDrift/2)`), and
        the column weights `0.55 + 0.45*sin(pi*(k+0.5)/n)` normalise to one, so a uniform deck's
        column density is the Phase 8b plane's at any count and `layers = 1` reproduces 8b exactly.
        The CPU packs each sheet into `CloudUniforms.layers` — (driftX, driftZ, centre, weight),
        192 bytes in total — so the shader never re-derives geometry the CPU and the tests could
        disagree about. The browser gate A/Bs 1 vs 4 sheets at a pinned coverage: >5 % of the
        frame's pixels must move, more than ten times the repeat-capture noise.)

    [x] Better shadowing. (`cloudDeckShadowTau` marches the sun ray through the stack above the
        shaded point — the sample count follows the path length (3 on the device, 24 as the CPU
        reference), the secant is clamped at the horizon — so the deck's own sheets are shaded by
        the depth above them. The same optical depth reaches the scene: standard/terrain/water
        fragments multiply their directional light by `exp(-2.5*shadowStrength*tau)` while
        `surfaceShadows` is on, so the ground under the deck darkens. Measured: the 3-sample device
        march stays within 0.2 % of the 24-sample reference; mean transmittance falls
        1.000/0.963/0.452/0.121/0.097 across coverage 0/0.25/0.5/0.75/1 at a fixed sun; the
        real-WebGPU A/B darkens >10 % of the frame's pixels in one direction, with nothing
        brightened.)

    [x] Improved temporal stability. (An octave whose wavelength falls under the pixel's sampling
        footprint fades out across the 1x-3x Nyquist band, and a fully faded octave stops the loop,
        so a grazing ray stops resolving detail it cannot hold and the far deck costs fewer
        octaves. The fade scales the octave's contribution and the normaliser keeps counting it —
        fading the divisor too would cancel the fade, which is the bug the CPU probe caught. The
        footprint comes from `dpdx`/`dpdy` in uniform control flow (the sky's deck plane in the sky
        pass, the fragment's own surface for the shadow), with the vertical-derivative term
        (`pixelAngle*(dh/sin el)*max(1, 1/sin el)`) that a horizontal-only model misses: a 1.5 km
        deck at 1.1 deg elevation is 6 km per pixel, not 24 m. Measured pixel-to-pixel change:
        0.16583 -> 0.000 at 1.1 deg, 0.10336 -> 0.02146 at 2.9 deg, 0.03393 -> 0.03363 where the
        deck can resolve its octaves. On the real adapter a deck with the wind pinned moves 3307 of
        468000 pixels (0.7 %, the gate camera's own dither) between two captures of the same
        setting, while changing the layer count moves 113674 — 34x the noise floor — so the
        stability the fade buys is asserted against a measured baseline, not a fixed threshold.)


17.4 Weather Integration

    [x] Weather affects:

        terrain appearance
        particles
        visibility
        vehicle traction
        audio
        water

        (`environment/surfaceWeather.ts` integrates the ground's memory of the weather —
        `SurfaceWeatherState` wetness / puddles / snow — on the weather's fixed clock: rain wets dry
        ground in about a minute, drying takes ~10 min scaled by temperature, humidity and wind,
        puddles need sustained rain over half intensity on wet ground, snow lies only below +2 C
        (`snowFraction`) and melts into wetness. `WeatherSystem` publishes it (`driveSurface`) to
        `scene.settings.surface`, which the standard/terrain shading reads through
        `PerFrameUniforms.surfaceWeather` (flags bit 7, zero cost while dry): a darkened, glossier
        wet film, sky-reflecting puddles in flat noise basins, snow on up-facing ground. Traction:
        `driveVehicles` publishes `tyreGripFactor(surface)`, which `VehicleSystem` applies (wet 0.75, standing water down to 0.55,
        snow 0.3) to every `Vehicle.surfaceGrip`, which scales the Pacejka peak — measured braking
        from 20 m/s: 19.3 m dry, 25.8 m wet, 35.3 m in puddles, 64.6 m on snow (v^2/2mu g within
        2 %). Visibility: the 8b fog drive, now read back as metres by `visibilityForFogDensity`
        (Koschmieder). Particles: `PrecipitationField` takes `drive.snow` (1.2 m/s flakes, path-length
        lifetimes), and `weatherPrecipitationDrive` maps the state. Audio: `weatherSoundInput` feeds
        `StormSoundscape` (the weather demo plays it once a gesture has started audio). Water:
        `driveWater` rebuilds the sea from the weather's wind (`weatherOceanOptions`: direction,
        storm height and chop). Real WebGPU A/B on the weather island: wet + puddles move 74 % of
        the frame's pixels, snow raises the mean from 111 to 158; ten simulated storm minutes
        through the weather itself reach wetness 1.0, puddles 0.94, grip 0.56, fog 0.0216.
        tests/environment/environment17_4.test.ts.)


17.5 Water Improvements

    [x] Reflection. (High tier: `water.screenSpace = "full"` marches the reflected ray through the
        grabbed depth (40 growing steps, thickness test, screen-edge and length fade) and replaces
        the sky reflection wherever it finds the scene; elsewhere the fe-35 sky/fog fresnel stays.
        Off-screen content still reflects only the sky — KNOWN-ISSUES.)

    [x] Refraction. (The renderer defers water out of `forge.main` on HDR frames,
        `forge.water.grab` copies the opaque scene + sky colour and its raw depth (MRT, r32float),
        and `forge.water` draws the water reading them: the refracted ray (n = 1.33) is followed a
        column's length (<= 6 m x `refractionStrength`) and re-projected, with a fall-back to the
        straight-through pixel when the probe lands on something in front of the water.)

    [x] Depth-dependent absorption. (Beer-Lambert over the real water column reconstructed from the
        depth buffer, `scene x T + body x (1 - T)`, `water.absorption` default (0.35, 0.075,
        0.045)/m — CPU twin `waterTransmittance`: at 5 m red keeps 17 %, green 69 %, blue 80 %.)

    [x] Shoreline effects. (fe-33..35 analytic shore — shoaling, depth-limited breaking, swash band,
        depth colour, drop-off — plus, in the screen-space mode, the real geometry: a soft contact
        edge and foam where the column over rocks, piers, hulls and the island is thinner than
        `intersectionFoam` (CPU twin `intersectionFoam`).)

    [x] Foam. (Whitecaps above the wind-driven `foamThreshold`, breaking-crest and swash foam in
        the surf zone, contact foam at intersections; foam is shaded by the wave relief.
        Real WebGPU A/B, weather lake, off vs full: 207 503 of 468 000 pixels change, zero GPU
        errors, and the two passes run only in the screen-space mode; per-tier mode via
        `waterScreenSpaceForTier` (low off, medium refraction, high full).
        tests/environment/environment17_5.test.ts, tests/environment/ocean.test.ts.)


17.6 Lightning Integration

    [x] Thunder audio. (Thunder is a simulation event: with a `listener`, each strike schedules its
        thunder at the distance from the listener to the nearest point of the channel over the
        speed of sound at the weather's air temperature (`speedOfSound`, `thunderDelay`), and
        `onThunder` fires on the simulated clock when it arrives; the weather demo plays its
        thunder from it. Measured on the device: a 218.7 m strike is heard 0.644 s later — not
        before, exactly once.)

    [x] Weather-driven strikes. (Pre-existing since 8b, now measured: the Poisson rate is
        `rate x storm01` of the attached `WeatherSystem` — 0 / ~75 / ~150 strikes per ten
        simulated minutes at storm 0 / 0.5 / 1 with `rate` 0.25.)

    [x] Terrain-aware strike positioning. (`strikeTarget`: the leader attaches to the highest
        ground sample or attractor (mast, tree, rod) inside its rolling-sphere striking distance
        (`strikingDistance`, 10 x I^0.65 m, 91 m at 30 kA) and the bolt ends at that height
        (`attachStrike`). Measured on a 120 m ridge: strikes landing above 60 m rise from 7.8 %
        (area share, no target) to 12.7 %, every bolt ends on the surface.
        tests/environment/environment17_6.test.ts.)


EXIT CRITERIA:

    Environment state affects the rest of the simulation rather than existing
    only as a visual system.


================================================================================
                     PHASE 18 - SCRIPTING
================================================================================

GOAL:

    Expose the engine as a usable gameplay platform.


18.1 Script Lifecycle

    [x] onCreate
    [x] onPreUpdate
    [x] onFixedUpdate
    [x] onUpdate
    [x] onLateUpdate
    [x] onDestroy

    `engine/src/scripting/`: subclass `Script`, attach it with `ScriptComponent` (instances, or names
    registered with `ScriptRuntime.define`), and `ScriptRuntime.install(world)` registers four
    systems — scripts.pre (band 0: pending onCreate, then onPreUpdate), scripts.fixed (band 100,
    once per fixed step, before vehicles/physics), scripts.update (200) and scripts.late (450,
    before transforms). Scripts run in creation order; one attached mid-frame starts at the next
    phase; `enabled` gates the per-frame hooks and defers onCreate; onDestroy runs on script,
    component or entity removal (the entity's other components still readable) and on runtime
    dispose, and only for scripts whose onCreate started. tests/scripting/scriptLifecycle.test.ts,
    docs/SCRIPTING.md


18.2 Timers

    [x] deterministic timers
    [x] render timers

    `Script.after/every(seconds, cb, { clock, steps })` (`scripting/timers.ts`). "sim" timers count
    whole fixed steps on the runtime's tick and fire at the start of their step, before
    onFixedUpdate, ordered by due tick then creation: the same fixed-step sequence gives the same
    firings however frames split it. "render" timers count frame seconds and fire before onUpdate
    (repeating ones drop overshot intervals). Timers belong to their script: held while it is
    disabled, cancelled when it is destroyed or faulted, and isolated like hooks.
    tests/scripting/scriptTimers.test.ts, docs/SCRIPTING.md


18.3 Coroutines

    [x] pause/resume
    [x] cancellation

    `Script.startCoroutine(function* (ctx) { ... }, { clock })` (`scripting/coroutines.ts`): the body
    runs now up to its first yield, then advances once per tick of its clock — "render" before
    onUpdate, "sim" per fixed step before onFixedUpdate (deterministic: the same ticks however frames
    split the steps) — waiting on a bare yield, Wait.seconds/steps/frames/until/while or another
    coroutine's handle. pause() freezes the wait and resume() continues with the time left; cancel()
    (and destroying or faulting the script) closes the generator so its finally blocks run. Throws
    from the body, a predicate or a bad yield fail the coroutine under hook isolation.
    tests/scripting/scriptCoroutines.test.ts, docs/SCRIPTING.md


18.4 Events

    [x] typed event system

    `defineEvent<T>(name)` tokens carry the payload type; `Script.on/emit/post` and
    `runtime.events` (host code) use them (`scripting/events.ts`). World and per-entity channels;
    `emit` delivers now in subscription order, `post` queues until the start of the next script
    phase (FIFO, before timers, coroutines and hooks). Script handlers run under hook isolation, only
    while their script is active and enabled, and are removed with it; re-entrant subscribe and
    unsubscribe are safe and a depth guard stops event loops. tests/scripting/scriptEvents.test.ts,
    docs/SCRIPTING.md


18.5 Error Isolation

    A broken script must not corrupt:

        ECS
        physics
        rendering
        simulation clock

    [x] Each hook runs in its own deferred-structure scope: when it throws, the add/remove/destroy
        calls it queued are discarded and the entities it created are destroyed (field writes made
        before the throw stay). The error is caught in the runtime, so the rest of the phase, every
        other system (physics, rendering) and later frames run; scripts only ever see copies of
        the clock's values. The script is faulted after `faultAfter` errors (default 1; a throwing
        onCreate always faults) and keeps only its onDestroy. Errors are recorded (`errors`,
        `lastError`, `onError`, the `scripts` logger). Limit: JavaScript cannot interrupt a hook
        that never returns. tests/scripting/scriptLifecycle.test.ts


18.6 Public API Boundary

    Scripts should NOT directly manipulate internal:

        GPUDevice
        RenderGraph internals
        Physics solver internals

    unless using an explicitly documented low-level API.

    [x] The script context carries the entity, the world, time copies and a logger only, typed as
        `ScriptEntity` / `ScriptWorld`: entities and components, but no registerSystem/runSystems,
        dispose, structural journal, raw storage or `entity.world` back-pointer. Host code holds
        the full `EntityWorld` (`runtime.world`) — the documented low-level path; scripts never get
        the GPU device or a render context. `engine/src/scripting/` may import core, math and scene
        alone (lint:arch, tests/engine/architecture.test.ts), and @ts-expect-error pins in
        tests/scripting/scriptLifecycle.test.ts fail the typecheck if the types widen again.


18.7 Hot Reload

    [x] development-time script reload

    `ScriptRuntime.reload(name, NewClass)`: re-points the name and swaps every live script of that
    name (or of the previously defined class) in place — same entity, component slot and execution
    order. The new instance is built first (a throwing constructor leaves the old script running);
    the old one's timers, coroutines and event listeners are cancelled and its onUnload runs; its
    data fields carry over; the new one's onReload(ctx, previous) — or onCreate — re-registers.
    Faulted scripts are revived. Bundler-agnostic (the docs show the Vite HMR hook).
    tests/scripting/scriptHotReload.test.ts, docs/SCRIPTING.md


EXIT CRITERIA:

    A complete gameplay system can be implemented without modifying engine
    source code.

    [x] Beacon Defense (`?scene=scripting`, examples/src/scripting/beaconDefense.ts): waves,
        drones, a turret, a beacon, score, game over and restart, written only as scripts against
        `@forge/engine`. tests/examples/beaconDefense.test.ts plays it to a game over and restart
        with no script errors, replays it identically under three frame splits and hot-reloads its
        turret mid-game; it renders on real WebGPU with zero GPU errors. Building it exposed and
        fixed two engine bugs (a Transform posed before a deferred add lost its pose; fixed steps
        did not see the previous step's structural changes within one frame).


================================================================================
                  PHASE 19 - SAVE / SERIALIZATION / REPLAY
================================================================================

GOAL:

    Turn deterministic simulation into a usable gameplay feature.


19.1 Scene Serialization

    [x] entities           (keyed by file index; parents by key, so duplicate names round-trip)
    [x] components         (by registered name; registry hook, own serialize(), or field capture;
                            assets by reference; dropped fields and skipped types are reported)
    [x] transforms         (local TRS read from the store, rotation included)
    [x] environment        (scene settings + DayNightCycle / WeatherSystem saveState/loadState)
    [x] terrain settings   (TerrainWorld.saveState with the pipeline spec; terrainOptionsFromState)
        Scripts save their data fields and are rebuilt by defined name before onCreate.
        docs/SERIALIZATION.md, tests/scene/sceneSave.test.ts


19.2 Versioned Save Format

    [x] schema version     (format "forge.scene", SCENE_SAVE_VERSION 2; newer versions are refused)
    [x] migrations         (registerSceneSaveMigration, one step per version; version 1 -> 2 built in)


19.3 Simulation Snapshots

    [x] physics state      (PhysicsWorld.snapshot: bodies by id and order, world clock; exact)
    [x] vehicle state      (Vehicle.snapshot: chassis, wheels, engine, gearbox, damage; structural)
    [x] weather state      (WeatherSystem / DayNightCycle / LightningSystem schedule)
    [x] RNG state          (Rng.snapshot, cached Gaussian included)
        Scene level: captureSceneSnapshot / restoreSceneSnapshot (transforms, settings, surface grip,
        system/component/object hooks), exact through JSON. A vehicle session restored mid-drive
        reaches the uninterrupted run's state hash. docs/SERIALIZATION.md, tests/scene/simulationSnapshot.test.ts


19.4 Replay

    [x] input recording          (channels: vehicle controls, object fields, custom; changes only;
                                  plus each frame's dt / fixed steps / alpha, because fixed systems
                                  are not interleaved and grouping changes the result)
    [x] deterministic playback   (ReplayPlayer at the input point; Clock.scriptFrames drives a live
                                  engine; a 720-frame vehicle session with contacts replays
                                  bit-identically from a fresh scene, through JSON)
    [x] state hashing            (exact-bit 64-bit StateHasher; per-part hashes: transforms, physics,
                                  vehicles, objects, plus game parts; divergence names the parts.
                                  Snapshots hash with hashState / hashSceneSnapshot from 19.3)
        docs/REPLAY.md, tests/replay/replay.test.ts. A replay starts from the same build or from a
        19.3 snapshot restored into a fresh one (tested: a mid-drive snapshot + 480 recorded frames
        replay bit-identically).


19.5 Verification

    Same input stream must produce identical state hashes.

    [x] identical hashes across JavaScript engines (V8 and JavaScriptCore: Math.atan already
                                  differed by an ulp and diverged a replay within a frame. Simulation
                                  code calls DMath, fdlibm in exact arithmetic, bit-identical to V8's
                                  Math where V8 runs fdlibm; lint:arch forbids the approximated Math
                                  functions and ** in simulation sources)
    [x] a complete vehicle session (the offroad demo's simulation headless: track terrain, weather-driven
                                  ground, rain, storm and lightning, snow, day/night, a physics
                                  chassis hitting crates, a reverse manoeuvre; 1,080 frames recorded
                                  under an uneven frame rate and committed as the cross-engine contract)
    [x] saved and replayed      (playback to all 19 hashes, a live re-run, and a frame-540 snapshot
                                  resumed in a fresh build all end on the recorded final hash)
        npm run check:replay-engines (Node + Bun, in CI), tests/replay/crossEngine.test.ts,
        tests/math/detmath.test.ts, examples/replay-verify.html for any browser, docs/REPLAY.md.


EXIT CRITERIA:

    A complete vehicle session can be saved and deterministically replayed.


================================================================================
                    PHASE 20 - AUDIO
================================================================================

GOAL:

    Integrate audio with simulation and environment.


20.1 Spatial Audio

    [x] voices, HRTF panner, listener, voice limit (stolen voices fade 10 ms and stop counting at
        once), occlusion (scales the voice's volume, closes a low-pass to 800 Hz)
    [x] coordinates              (engine left-handed → Web Audio right-handed: every listener/panner
                                  write negates z; before this, demo left/right were mirrored)
    [x] panning, distance, cone  (CPU twins of the spec's azimuth/equal-power, distance models and cone)
    [x] Doppler                  (from source/listener velocity along the line; scale; clamped)
    [x] air absorption           (low-pass ~20 kHz up close, an octave per ~350 m)
    [x] occlusion                (caller query, e.g. a raycast; smoothed gain + low-pass)
    [x] ECS                      (AudioListenerComponent, AudioEmitterComponent, SpatialAudioSystem
                                  in band 800 after transforms)
        engine/src/audio/spatial.ts, tests/audio/spatialAudio.test.ts, docs/AUDIO.md

20.2 Audio Resources

    [x] load once per URL (shared requests), failures evicted, release, decoded-seconds statistics
    [x] registry clips           (audio:<url> ResourceRegistry entries: one load per id, handles,
                                  decoded-byte budget with LRU eviction of idle clips, cancellation)
    [x] formats                  (alternative sources ranked by canPlayType, fall through on fetch or
                                  decode failure)
    [x] validation               (empty/channel-less output rejected; long clips flagged for streaming)
    [x] procedural clips + banks (audio:procedural/<name>; AudioBank load/progress/pin/release)
        engine/src/audio/resources.ts, tests/audio/audioResources.test.ts, docs/AUDIO.md. The weather
        demo's thunder variants are registry clips, filtered by strike distance.

20.3 Streaming Audio

    [x] media-element streams through a gain into a bus; blocked by the autoplay policy until
        resume(); fade-in, volume ramps, end callback, release on dispose

20.4 Buses / Mixing

    [x] master/music/sfx/dialogue/ambient plus custom child buses, live effect racks, anchored
        volume fades (an unanchored ramp clicks). docs/AUDIO.md, tests/audio/audioSystem.test.ts

20.5 Environmental Audio

    [x] wildlife                 (birds from the sun's elevation with a dawn chorus, silenced by rain,
                                  wind and frost; crickets on warm nights at Dolbear's rate)
    [x] listener context         (underwater: everything muffled to a rumble; indoors: the outdoor bed
                                  low-passed, rain becomes roof drumming)
    [x] reverb                   (decay and mix from the surroundings' reflectivity and enclosure;
                                  procedural impulses, rebuilt per 0.25 s bucket; a bus effect)

20.6 Weather Audio

    [x] wind                     (roar and gust howl from speed and gustiness, panned from the side it
                                  blows from relative to the listener)
    [x] rain on the ground       (liquid rain only; brighter and louder on wet ground and puddles from
                                  the surface model, duller on snow cover; snowfall is silent)
    [x] snow damping, surf       (snow cover absorbs the outdoor bed's highs; surf from shore × storm)
        engine/src/audio/ambience.ts, engine/src/environment/soundInput.ts,
        tests/audio/ambienceAudio.test.ts, docs/AUDIO.md. The weather, off-road and Alpine demos play
        it with their vehicles and impacts through the ambient/sfx buses.

20.7 Vehicle Audio

    [x] Engine RPM               (firing frequency rpm/60 × cylinders/2; electric motors whine with rpm)
    [x] throttle                 (intake noise and engine level)
    [x] load                     (driven-tyre torque over peak engine torque, capped by what the engine
                                  delivers: zero revving in neutral or sliding at closed throttle; it
                                  brightens the engine and adds combustion grit; lift-off is overrun)
    [x] gear                     (shift events with from/to; the open clutch dips the engine voice;
                                  reverse whine)
    [x] tire slip                (combined slip over the Pacejka peak × load share, so a tyre squeals
                                  where it saturates; squeal pitch rises with sliding speed)
    [x] suspension               (impact / bottom-out / landing events per wheel from compression speed
                                  and airtime: a bump hits the front axle a wheelbase before the rear)
    [x] terrain                  (a per-wheel classifier shaped like TireTrackLayer's: asphalt squeals,
                                  gravel crunches, mud and water slosh, each surface has its own roar)
        engine/src/audio/vehicle.ts, tests/audio/vehicleAudio.test.ts, docs/AUDIO.md. The analyzer only
        reads the vehicle (a run with audio reaches the bit-identical snapshot of one without). The
        off-road demo plays it (SOUND button / M). Mixing through buses is 20.4.


20.8 Particle / Impact Audio

    [x] impacts                  (PhysicsWorld.contactListener, read-only: each solved manifold's
                                  approach speed, slide speed, impulse, point and normal; a hit past
                                  0.6 m/s, once per pair per 80 ms, louder by ½·m·v²; capped per frame)
    [x] scrapes                  (pairs sliding under load: looping friction voices at the slide speed)
    [x] materials and size       (metal / wood / rock / plastic / glass / rubber / dirt / snow / ice
                                  modal profiles; smaller bodies ring higher; ground does not ring)
    [x] particle audio           (a CPU ParticleSimulation's births, bursts, flow and ground crossings:
                                  hiss, burst one-shots and per-hit grains)
        engine/src/audio/impact.ts, engine/src/audio/particles.ts, tests/audio/impactAudio.test.ts,
        docs/AUDIO.md. Alpine Rescue plays the truck (20.7) and every contact (SOUND / M). GPU particle
        worlds keep their state on the device and are not heard (capability: audio.gpuParticles).


EXIT CRITERIA:

    Audio responds to simulation state rather than being purely scripted.


================================================================================
                  PHASE 21 - PROFILER / DEBUG TOOLS
================================================================================

GOAL:

    Make Forge self-diagnosing.


21.1 Frame Profiler [x]

    Track:

        [x] CPU frame
        [x] GPU frame (timestamp queries, when the adapter has them)
        [x] simulation
        [x] physics
        [x] terrain
        [x] streaming
        [x] rendering
        [x] particles
        [x] scripting
        [x] audio (SpatialAudioSystem; soundscapes driven outside the scene are not timed)

    As built: engine/src/debug/frameBreakdown.ts and engine/src/debug/frameTimeline.ts.
    EntityWorld.runSystems and Scene.update open a `<category>:<name>` profiler scope per system and
    per scene-object hook (the category comes from a `profileCategory` **getter**, never an own field,
    so snapshots and replay hashes do not change; labels are cached in a WeakMap for the same reason,
    and classifyProfileName guesses from the name otherwise). The engine wraps the asset streamer in
    `streaming:assets`, and Engine.frameBreakdown() folds the scopes into the eight categories above
    plus CPU and GPU frame time, with the frame's unattributed remainder reported separately.

    The history is also *drawn*: frameTimeline() charges every scope its self time (so nested scopes
    are counted once) and layoutTimeline() turns the last 180 frames into rectangles — a category-
    stacked column per frame against the budget line, and a lane chart of the selected frame's
    scopes underneath. The demo's floating Profiler panel paints that into a canvas above the text
    report: hover a column to select that frame, tap to pin it. Pinned by
    tests/core/frameBreakdown.test.ts and tests/core/frameTimeline.test.ts (model and geometry),
    tests/examples/profilerTimeline.test.ts (the strip, against a fake canvas) and check:browser:ui
    (real pointer input on real WebGPU frame records). The strip now supports bounded scrub and zoom
    across the retained history by wheel, keyboard, and pointer drag; its GPU marker remains a
    frame-total marker while per-pass device times stay in the text report.


21.2 ECS Inspector

    [x] Read-only, bounded ECS snapshot API for systems, entity hierarchy, component populations
        and scalar component fields (engine/src/debug/ecsInspector.ts, tests/core/ecsInspector.test.ts).
        The demo's Inspector window browses it: the ECS tab lists entities and component populations
        with a filter, and selecting an entity shows its hierarchy, transform and component fields.

21.3 Render Graph Inspector

    [x] On-demand pass/resource snapshot includes liveness, culling reasons, dependencies, transient
        lifetimes, alias slots, texture-pool state and available GPU pass timings. The Inspector
        window's Graph tab browses executed and culled passes, their reads/writes/dependencies and
        the transient/aliased/pooled byte totals (engine/src/debug/renderGraphInspector.ts).

21.4 GPU Resource Inspector

    [x] Device-level live buffer/texture inventory grouped by label, with allocation sizes, recent
        churn and GPU object totals. The Inspector window's GPU tab browses it, naming the largest
        allocation and the pipeline/bind-group counts (engine/src/debug/gpuResourceInspector.ts).

21.5 Physics Debug Draw

    [x] Bounded read-only collider wireframes for rigid bodies, with optional AABBs, linear velocity
        vectors, and current narrowphase contact-point/normal overlays. Backend-independent line
        data/callback can be forwarded to Renderer.drawLine (engine/src/debug/physicsDebugDraw.ts,
        tests/core/physicsDebugDraw.test.ts). The Inspector window's Physics tab lists bodies and
        switches the complete overlay on each frame; contact points are capped independently so a
        dense scene cannot make the debug pass unbounded.

21.6 Terrain Debugger

    [x] Read-only terrain streaming snapshot with chunk state, LOD, budgets, resident bytes and
        generated height/bounds; bounded LOD-coloured chunk wireframes are renderer-independent
        (engine/src/debug/terrainDebugger.ts, tests/core/terrainDebugger.test.ts). The Inspector
        window's Terrain tab browses the chunks and switches the LOD-coloured bounds overlay on.

21.7 Particle Debugger

    [~] Read-only CPU particle samples and emitter settings across scene-object and ECS simulations;
        bounded particle/velocity/emitter line data can be forwarded to Renderer.drawLine. GPU worlds
        report counters and emitter settings without particle-buffer readback
        (engine/src/debug/particleDebugger.ts, tests/core/particleDebugger.test.ts). The Inspector
        window's Particles tab browses CPU worlds (counts, emitter settings, a bounded particle
        sample) and switches their overlay on; GPU worlds get counters only.

21.8 Streaming Debugger

    [x] Bounded asset-load and background-task inventories include IDs, states, priorities, ages,
        timing and payload-free diagnostics, alongside stats from scene streaming owners
        (engine/src/debug/streamingDebugger.ts, tests/core/streamingDebugger.test.ts). The Inspector
        window's Streaming tab browses all three under one filter.

21.9 Environment Debugger

    [x] Read-only snapshots cover sun direction/lights and day-night state, effective atmosphere,
        cloud parameters, weather targets/surface state, sampled wind and precipitation, water waves/
        shoreline, and active lightning/thunder. Sun, wind, and bolt line data is backend-independent
        (engine/src/debug/environmentDebugger.ts, tests/core/environmentDebugger.test.ts). The
        Inspector window's World tab browses them, with a sun/wind overlay checkbox.


21.10 Console

    `DeveloperConsole` / `createDeveloperConsole` (engine/src/debug/console.ts) provide an
    embeddable, read-only diagnostic command model with quoted-argument parsing, explicit command
    registration (input is never evaluated as JavaScript), completion, help, and bounded history,
    input, and output. Built-ins expose CPU/GPU profiler scopes and recent frame slices, engine
    stats, plus the ECS, render graph, GPU resources, physics, terrain, particles, streaming, and
    environment diagnostics already added in Phase 21.
    A host can attach the model to a terminal/editor surface, and the demo now does: the floating
    Console window (examples/src/diag/consolePanel.ts) provides a real input, bounded transcript,
    Up/Down history and Tab completion while still dispatching only registered commands. Pinned by
    tests/core/developerConsole.test.ts, tests/examples/consolePanel.test.ts and section 7c of
    check:browser:ui.

    The milestone's diagnostics are browsed interactively in the demo's floating Inspector window
    (examples/src/diag/inspectorPanel.ts and examples/src/diag/inspectorTabs.ts, opened from the
    toolbar's Inspector button): one tab per API above — ECS, systems, render graph, GPU resources,
    physics, terrain, particles, streaming and world — each with a summary strip, a filter, a list
    and a detail pane for the selected row, refreshing at 2 Hz while it is open and costing nothing
    while it is closed. Rows carry a stable key, so a selection survives a refresh by identity and
    not by position; the detail is computed lazily for the selected row only; the list is rebuilt
    only when its contents change; a tab whose subsystem is missing from the scene reports a note
    instead of throwing; and four tabs offer opt-in debug-line overlays, including bounded contact
    points and normals, that the frame loop forwards through Renderer.drawLine. Pinned by
    tests/examples/inspectorPanel.test.ts and section 7b of check:browser:ui. The Inspector remains
    one read-only window with capped rows, and GPU particle positions remain device-authoritative;
    their counters/configuration are shown without a synchronization readback.


EXIT CRITERIA:

    Major performance and correctness problems can be diagnosed without
    changing engine source.


================================================================================
                    PHASE 22 - BENCHMARK + REGRESSION SYSTEM
================================================================================

GOAL:

    Prevent performance regressions as the engine grows.


22.1 Core

    [x] ECS
    [x] math
    [x] scheduler
    [x] resource management

    As built: `npm run bench` runs 100,000-entity creation/transform/frustum work, one million
    allocation-free Vec3 cross/normalize kernels, 250,000 Mat4 multiplies, 8,192 inline scheduler
    jobs plus a 4,096-subscriber dedup fan-out, and 10,000 ResourceRegistry loads, cache hits,
    handle releases and LRU evictions. Every workload validates its result/accounting and carries a
    deliberately generous catastrophe bound; narrow cross-host stopwatch thresholds are not used.
    (`benchmarks/src/ecs.bench.ts`, `benchmarks/src/core.bench.ts`)


22.2 Rendering

    [x] draw submission
    [x] render graph
    [x] culling
    [x] lighting
    [x] shadows
    [x] GPU memory

    As built: `npm run bench` runs a mock-device steady draw-submission sweep, render-graph
    compile/submit and transient-aliasing sweep, the existing object/cluster culling twins, finite
    cascade/spot/point shadow-fit and adaptive-atlas checks, and repeated texture/buffer allocation
    accounting that must return to zero live bytes. `benchmarks/src/rendering.bench.ts` owns the
    renderer matrix; the browser gate remains the real shader/GPU validation for device timing.


22.3 Terrain

    [x] generation
    [x] erosion
    [x] LOD
    [x] streaming
    [x] mesh generation

    As built: `npm run bench` runs worker-equivalent deterministic generation at 33²/65²/129²,
    explicit thermal and hydraulic erosion, multi-level LOD/geomorph selection, a real budgeted
    `TerrainWorld` cold/resident/moved/cache-return scenario, and skirted `TerrainTile` mesh-source
    construction at three resolutions. Guards cover deterministic digests, finite height ranges,
    cache reuse, resident-chunk limits and exact grid-plus-skirt topology; the real browser gate
    remains the device-side terrain validation.


22.4 Physics

    [x] broadphase
    [x] narrowphase
    [x] solver
    [x] queries
    [x] vehicles

    As built: `npm run bench` runs deterministic sweep-and-prune pair generation/pruning at multiple
    body counts, every supported narrowphase shape-pair manifold dispatcher, sequential-impulse contact
    solving plus a fixed-step resting-contact stability workload, physics-world raycasts and registered
    heightfield samples, and several fixed-step vehicle fleets. Guards cover pair/contact shape,
    deterministic state digests, finite/stable solver and vehicle state, query hits, and the benchmark
    catastrophe bound; repeated same-host statistical comparison is enforced by the Phase 22.7 history runner.


22.5 Particles

    [x] 10K
    [x] 100K
    [x] 500K
    [x] 1M

    As built: `npm run bench` measures deterministic CPU setup and fixed-step integration plus strict
    mock-GPU storage allocation and per-frame command/uniform preparation at all four capacity bands.
    Guards compare CPU gravity with the analytic reference, require deterministic state digests and
    zero ECS entities, validate the 64-byte particle storage shape, and require zero live mock buffers
    after teardown. The mock does not execute WGSL, so its rows are allocation/API validation rather
    than real-device throughput; the browser/device gate remains authoritative for GPU timing.


22.6 World

    [x] 10K objects
    [x] 100K objects
    [x] 500K objects
    [x] 1M objects

    As built: `npm run bench` measures public `EntityWorld` object creation/component attachment,
    flat transform composition and frustum visibility queries at all four object bands. Guards require
    one Transform and Renderable per object, non-trivial visible and culled populations, deterministic
    work digests, measured typed transform storage and zero live ECS objects after teardown. This is a
    CPU/ECS world-scale matrix; GPU instance generation and complete visibility compaction remain
    Phase 24 work.


22.7 Regression Recording

    [x] Emit a versioned machine-readable snapshot (`npm run bench -- --json PATH`) containing
        stable metric IDs, operation counts, timings, repeated raw samples, guard results, total run
        time and exact Node/OS/CPU/memory metadata.
    [x] Store raw repeated benchmark history in `benchmarks/history/benchmark-history.json` and retain
        an audited human-readable baseline in `PERFORMANCE.md`; only matching host fingerprints and
        metric manifests are comparable.
    [x] Fail automatically when a comparable timing regresses by at least 15% with a z-score of 3 or
        greater; changed operation counts or metric shape require an intentional baseline record.


EXIT CRITERIA:

    Significant CPU, GPU or memory regressions are detectable automatically through the versioned
    snapshot, shape guards and same-host timing policy.


================================================================================
                    PHASE 23 - MARS REFERENCE VERTICAL SLICE
================================================================================

GOAL:

    Prove Forge works as a complete real-time simulation engine.

This is NOT simply another demo.

This is the primary validation environment for Forge.


23.1 Mars Terrain

    [x] Large procedural Mars terrain
    [x] Craters
    [ ] erosion
    [x] rocks
    [x] LOD
    [x] streaming

    As built: Mars Showcase evaluates the deterministic seed-1337 analytic Mars stage over streamed
    128 m chunks, with crater fields, streamed rock populations, real lower-resolution LOD meshes,
    skirts and bounded worker generation/upload. The scene and its Phase 23 snapshot both report
    `hasErosion: false`: the external Stage A erosion cache is still absent and is not implied by the
    completed terrain checks. (`marsShowcaseScene.ts`, `marsShared.ts`, `marsShowcase.test.ts`)


23.2 Mars Environment

    [x] Mars atmosphere
    [x] dust haze
    [x] solar cycle
    [~] weather
    [~] clouds where appropriate
    [x] lighting

    As built: the showcase uses the Mars atmosphere, exponential dust haze, and a fixed-step
    `DayNightCycle` that drives the sun direction/intensity, ambient, sky direction and horizon fog.
    The deterministic Mars clock is exposed in `marsState().solarCycle` and can be scrubbed through
    `window.__forge.setMarsSolarTime(hours)`. The dry Mars weather integration owns deterministic
    clear/regional-dust/global-dust profiles, wind/advection, storm haze and light attenuation; a
    thin high cloud/dust veil is driven by the same state, and `window.__forge.setMarsWeather(mode)`
    plus `?marsweather=` expose it to diagnostics. A scene-owned acceptance monitor and the Mars
    browser section now assert all profiles keep precipitation, wetness, puddles and snow at zero;
    the real-browser gate is implemented but was not runnable in this checkout because Chromium was
    not provisioned. Richer Mars-specific dust transport remains separate, and the reference slice
    still has no Stage A erosion cache (`23.1`).


23.3 Rover

    [x] physics chassis (the showcase uses an opt-in fully dynamic rigid-body chassis coupled to
        the existing wheel/suspension/tire model; supported high-speed rigid-body CCD remains live)
    [x] suspension
    [x] wheels
    [x] tire model
    [x] drivetrain
    [x] steering
    [x] braking

    As built: the six-wheel battery-electric rover uses the shared Vehicle simulation, per-wheel
    suspension/contact, combined-slip tires, reduction drivetrain, front/rear steering and
    regenerative/friction braking. Its chassis is now a dynamic `RigidBody` in the same shared
    terrain/rock `PhysicsWorld`: VehicleSystem queues wheel-model acceleration per fixed substep,
    PhysicsSystem consumes those commands and feeds solver contacts/CCD back to the vehicle pose.
    The public chassis helper remains kinematic by default so Alpine Rescue and other existing
    recipes stay backward-compatible.


23.4 Rover Environment Interaction

    [~] crater traversal (the deterministic `forge.mars-crater-route/1` crosses a real seed-1337
        crater and is joined to the rover soak acceptance contract; the real-browser gate is
        implemented but remains unverified here because Chromium was not provisioned)
    [x] slope traversal
    [x] rock collisions
    [x] wheel slip
    [x] suspension movement


23.5 Particles

    [x] wheel dust
    [x] drifting dust
    [x] debris
    [ ] exhaust (the reference rover is battery-electric; roadmap disposition remains explicit)


23.6 Streaming

    [~] continuous terrain traversal (the `forge.mars-acceptance/1` monitor now evaluates moving
        time, path distance, visited chunks, discontinuities and moving-time terrain gaps; the real
        browser gate holds throttle until the threshold result is live, but Chromium was not
        provisioned for verification here)
    [x] object streaming
    [~] asset streaming (live GLB progress, resident bytes and engine asset counters are included in
        the acceptance snapshot; the browser recovery/budget arm is implemented but unverified here)


23.7 Camera

    [~] chase (default and acceptance-covered)
    [~] cockpit (deterministic rover-relative pose; browser gate implemented, Chromium unavailable here)
    [~] free (explicit diagnostic eye/target pose; browser gate implemented, Chromium unavailable here)
    [~] cinematic (deterministic simulation-time orbit; browser gate implemented, Chromium unavailable here)


23.8 Telemetry HUD

    [~] The Mars HUD and `window.__forge.marsReferenceState()` expose schema
        `forge.mars-reference/1`; focused tests pin aggregation and unavailable-data semantics. The
        HUD now also shows the live acceptance result, path/gap counters, dry-environment invariant,
        camera coverage, asset peaks and analytic crater-route result. The Mars browser section
        asserts the versioned snapshot and sustained thresholds, but the gate is unverified here
        because Chromium was not provisioned.

    Show:

        [x] FPS
        [x] CPU frame
        [x] GPU frame (real timestamp value or explicit `n/a`; never estimated)
        [x] physics
        [x] terrain
        [x] streaming
        [x] particle count
        [x] visible objects
        [x] loaded chunks
        [x] GPU memory

    The same snapshot includes terrain generation/upload queues and cumulative traversal distance,
    moving time, visited chunks, missing-ready-chunk frames and discontinuities. GPU memory is live
    buffer + texture allocation; overlapping transient/pool counters are not double-counted.
    (`marsReferenceTelemetry.ts`, `main.ts`, `marsReferenceTelemetry.test.ts`)


23.9 Deterministic Replay

    [~] record input (Mars exposes the generic `ReplayRecorder` through `window.__forge`)
    [~] replay (Mars exposes the generic `ReplayPlayer` and portable recording document)
    [~] state hashes (vehicle-part hashes and divergence results are surfaced by the Mars handle)

    The Mars handle is now wired to the generic recording/session/hash infrastructure and the browser
    section records a fresh short route, rebuilds the deterministic scene and checks a zero-divergence
    playback. This remains `[~]` until that real-browser check is observed; the current checkout has
    no provisioned Chromium. The explicit no-exhaust disposition remains unchanged in 23.5 because
    the reference rover is battery-electric.


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

    [~] `forge.objects.cull` already performs per-batch frustum/distance/HiZ tests and writes
        visibility plus indirect records when that path is enabled. Phase 24 now lets opted-in opaque
        world renderables bypass CPU frustum rejection on the real-device path, but CPU batch assembly
        and the 8,192-batch cap remain.

24.2 GPU LOD Selection

    [~] Population instances select their high/low geometry window on the GPU. General renderables
        and terrain chunk mesh density are still selected on the CPU.

24.3 GPU Visibility Compaction

    [~] The object culler produces a dense visible-batch list; the population culler and the
        generic instanced-batch extension compact per-instance records and feed indirect draws.
        The world-scale path still does not rewrite one global instance arena or consume the visible
        batch list to remove CPU batch assembly.

24.4 Indirect Rendering

    [x] `forge.main` consumes GPU-written indexed/non-indexed indirect records; a culled batch has
        zero instances and executes no vertex work. WebGPU still requires one CPU-issued indirect
        call per batch because the engine has no multi-draw API.

24.5 GPU Instance Generation

    [ ] Population scatter and generic instance transforms are still generated on the CPU/workers.

24.6 GPU Terrain Culling

    [~] Every streamed terrain tile and the horizon apron set `Renderable.gpuDrivenVisibility`.
        On a real GPU path, CPU-rejected tile bounds remain in `forge.objects.cull`, which makes the
        device's frustum verdict authoritative and writes the indirect count when that default path
        is enabled. Explicit CPU mode (including the mock's `auto` resolution) remains the
        deterministic fallback. Per-tile CPU collection and prepass/draw submission remain.

24.7 GPU Particle Simulation

    [x] Storage-buffer emission/full simulation runs in fixed-step compute passes; the more limited
        CPU particle implementation remains the deterministic reference path.

24.8 GPU Particle Rendering

    [~] GPU billboards, stretched billboards, soft particles and trail ribbons render through the
        graph; mesh particles, HiZ particle culling and terrain collision remain.

    Phase 24 validation begins in Mars rather than a synthetic-only scene. The HUD and
    `window.__forge.gpuWorldState()` expose additive schema `forge.gpu-world/1`: resolved culling and
    indirect modes, managed terrain batches/instances, bounds the CPU rejected but handed to the
    device, recent object-cull visibility/reasons and population compaction counts. Current-frame
    handoff counters are exact; device results remain intentionally asynchronous. The focused Mars
    browser gate requires a real device frustum rejection and exact cull-accounting identity.


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

    [ ] `ForgeWasmPhysics` now owns the memory a solver module will import, but no WASM narrowphase,
        solver or integration kernel ships yet. Its gameplay methods deliberately fail instead of
        disguising `PhysicsWorld` as WASM.

25.2 Shared Memory Representation

    [~] `WasmPhysicsMemory` defines versioned schema `forge.physics-wasm-state/1`: a 192-byte world
        header and fixed 448-byte f64 body records in `WebAssembly.Memory`, with stable numeric codes
        for body/shape kinds. Optional shared memory uses an even/odd single-writer seqlock. JS still
        owns topology, heightfield callbacks and body add/remove commands; capacity is fixed at create.

25.3 Snapshot Transfer

    [~] The used memory prefix can be copied into a transferable `ArrayBuffer`, loaded into a memory
        with a different capacity and applied only to an identically constructed host world. World
        clock/gravity/solver settings and complete numerical body state round-trip exactly; malformed
        records and non-finite host/frame state are rejected before publication or mutation. This is
        a solver-state frame, not a replacement for the generic save format or topology serialization.

25.4 Backend Selection

    [~] The existing public selector remains explicit:

        physics.backend = "js"
        physics.backend = "wasm"

    `js` is production-ready. `wasm` provisions the ABI but fails fast until 25.1 lands; there is no
    silent fallback and `PhysicsSystem` still requires a JS `PhysicsWorld`.


25.5 Cross-Backend Validation

    [ ] The ABI tests prove transferred JS state continues bit-for-bit identically in another JS
        reference world. Same-input JS/WASM comparison and its defined tolerances cannot exist until
        a WASM solver executes.


EXIT CRITERIA:

    WASM physics can replace the JS backend without changing gameplay code.


================================================================================
                    PHASE 26 - EDITOR
================================================================================

GOAL:

    Build editor tooling on top of the stable runtime API.

    [x] Exit criterion met by the public-API-only EditorWorkspace: a complete Mars runtime scene can
        be attached, inspected and modified (and ordinary entities/components can be created,
        duplicated, reparented and saved) without editing engine source code. The optional DOM shell
        owns no renderer or simulation loop; a host supplies the viewport integration.


26.1 Scene Hierarchy

    [x] `EditorWorkspace` exposes a deterministic, bounded root-first tree with selection,
        multi-selection, collapse/expand, ancestor-context filtering, drag/drop-ready reparenting and
        an optional visible DOM tree.

26.2 Entity Inspector

    [x] The inspector exposes copied name, parent/children and authoritative local TRS; rename,
        transform, world-pose-preserving reparent and subtree create/duplicate/delete commands are
        validated and undoable.

26.3 Component Inspector

    [x] Registered `editorGroup`, enabled state and bounded scalar/vector fields are editable through
        public APIs. Entity creation accepts registered component definitions and generic field edits
        are undoable without exposing live component objects.

26.4 Transform Gizmo

    [x] `editor/src/gizmo.ts` provides deterministic ray/axis picking, translate/rotate/scale drag
        math and snapping. It returns transform patches for any host viewport to commit through the
        workspace; camera, pointer capture and GPU drawing remain host-owned.

26.5 Terrain Editor

    [x] The terrain panel adapts `inspectTerrain`; workspace commands edit focus, forward direction
        and layered-material presentation through `TerrainWorld`'s public API.

26.6 Material Editor

    [x] The material panel lists public `Renderable`/`Material` state and workspace commands edit
        color, PBR values, opacity, flags, alpha test, tiling and offset with history.

26.7 Particle Editor

    [x] The particle panel adapts `inspectParticles` and workspace commands edit the selected/first
        CPU emitter's public rate, lifetime, size, drag, burst and cone settings.

26.8 Vehicle Inspector

    [x] The vehicle panel lists public `VehicleComponent` telemetry, input and configuration without
        duplicating or taking ownership of vehicle simulation.

26.9 Environment Editor

    [x] The environment panel adapts `inspectEnvironment`; workspace scene-settings patches provide
        undoable public authoring for fog, sky, lighting, post and related scene settings.

26.10 Streaming Inspector

    [x] The workspace exposes a bounded `inspectStreaming(engine)` snapshot, including queue state,
        priorities, bytes and failures, while `AssetStreamer` remains runtime-owned.

26.11 Render Graph Viewer

    [x] The workspace exposes a bounded `inspectRenderGraph(engine.renderer.graph)` snapshot of
        passes, resources, dependencies and lifetimes; graph construction remains renderer-owned.

26.12 Asset Browser

    [x] The asset panel browses bounded public registry/streamer metadata with kind/state filtering,
        dependency/dependent links and load bytes; resource ownership remains in the runtime.

26.13 Profiler

    [x] The profiler panel adapts public scope/frame history, frame breakdown, timeline and report
        APIs; capture and scheduling remain engine-owned.


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

    [x] `@forge/engine` exposes only its package root; TypeScript resolves that barrel into a
        deterministic checked-in `forge.api-surface/2` snapshot of every name, type/value kind,
        stability label, direct declaration and transitive engine-local type contract. CI fails on
        unreviewed additions, removals, renames, classifications or declaration drift; the separate
        `forge.api-approvals/1` ledger fails when an approved exact contract becomes stale.
    [x] public — preserve and approve all 2,187 current package-root candidates across 23 coherent
        subsystem reviews. Every row is bound to its exact declaration and transitive contract;
        `forge.api-approval-policy/2` requires zero pending public exports.
    [x] internal — deep package paths are blocked, any root export tagged `@internal` fails the
        audit, and unexported declaration dependencies feed transitive contract hashes.
    [x] experimental — nine non-executable WASM-physics seam exports carry explained
        `@experimental` tags and remain outside public approvals.
    [x] deprecated — the category and explained-tag rule are enforced; there are currently no
        deprecated top-level exports. Final support windows remain the separate Phase 27.6 task.
    [x] Add direct declaration-signature/member and transitive engine-local compatibility drift
        detection using body/comment/path-free TypeScript declaration emit.
    [x] Complete per-symbol approval and decide which detected contracts are supported 1.0
        candidates: 2,187/2,187 public names are approved, exact-hash stale approvals fail, complete
        runtime namespace linkage is tested, and subsystem suites provide behavioral evidence.
        (`docs/API-REVIEW.md`, `engine/api-approvals.json`, `tests/core/runtimeApi.test.ts`)


27.2 API Documentation

    [x] `docs/API.md`, the generated [`docs/API-REFERENCE.md`](docs/API-REFERENCE.md) and the
        published package README document the root boundary, every audited export, stability labels,
        the extension contract, and the exact limits of declaration/approval gates.

27.3 Examples

    [x] `docs/EXAMPLES.md` and `examples/src/api/` provide reviewed, root-import-only, strict-
        TypeScript runnable scene and complete-extension examples.

27.4 Migration Guide

    [x] `docs/MIGRATION-1.0.md` documents the 0.x-to-1.0 import, startup, data, extension, and
        compatibility migration path.

27.5 Versioning Policy

    [x] `docs/VERSIONING.md` defines semver, the single version-of-truth rule, API review, release
        gates, tags, dist-tags, and the supported upgrade path.

27.6 Deprecation Policy

    [x] `docs/DEPRECATION.md` defines the required since/replacement explanation, minimum two-minor-
        release and six-month window, migration requirements, emergency exception, and removal rules.

27.7 Extension API

    [x] `ForgeExtensionRegistry` is one supported 1.0 contract, with manifest validation, named
        disposable registrations, catalog lookup/snapshot, and host system attachment for:

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
                    ORIGINAL PRIORITY QUEUE (HISTORICAL)
================================================================================

DO NOT immediately start scripting, editor work, networking, or miscellaneous
features.

The sequence below is retained from the original plan, not a current queue: terrain workers/LOD,
vehicle integration, and Phase 13.1–13.9 have since landed. Phase 10 remains intentionally
skipped/blocked as documented in the current status and known-issues sections.

The original recommended sequence was:

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
        Vehicle wheel contact is still a GroundQuery rather than full mesh/world
        collision; the dynamic chassis coupling is opt-in in Phase 23.3 and the
        existing public helper remains kinematic by default.


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

    Reason (at the time of this roadmap revision):
        Clustered lighting, depth prepass, GPU culling, indirect rendering,
        GPU timing and async pipeline creation were unfinished; 13.1–13.9 have
        since landed and are now covered by focused renderer verification.


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
