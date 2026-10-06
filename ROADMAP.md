```text
================================================================================
                              FORGE ENGINE
                         DEVELOPMENT ROADMAP
                              VERSION 3.0
================================================================================

STATUS:
    Active Development

CURRENT CODEBASE BASELINE:
    Phases 0-5, 7:  IMPLEMENTED / VERIFIED
    Phase 6:  IMPLEMENTED BUT REQUIRES HARDENING
                (Reconciled 2026-10-06: the top block previously claimed "Phases 0-7:
                IMPLEMENTED / VERIFIED", which contradicted the state block's [!] and the
                registry's `6: partial`. The registry is right: the open vehicle limitations
                are the four bullets in docs/KNOWN-ISSUES.md §Vehicles — solved longitudinal
                slip (vehicles.tireModel), box wheel visuals (vehicles.wheelVisuals), reverse
                as a ratio not a control (vehicles.transmission) and discrete-contact impacts
                (physics.ccd). None is a Phase 6 defect — the model itself is pinned by
                tests/vehicles.test.ts and tests/vehiclePhysics.test.ts — and the registry
                closes all four under 16.6 / 25.1. No separate Phase 6 hardening work is
                scheduled; this note records the interpretation rather than inventing scope.)
    Phase 8a:   IMPLEMENTED / VERIFIED
    Phase 8b:   IMPLEMENTED / VERIFIED
    Phase 9:    IMPLEMENTED / VERIFIED (worker-backed mesh decoding, BVH picking/frustum refinement,
                deterministic broadphase, resource hardening, coordinate API and docs gates verified)
    Phase 10:   IMPLEMENTED BUT REQUIRES HARDENING
    Phase 11:   IMPLEMENTED / VERIFIED
    Phase 12:   IMPLEMENTED / VERIFIED (honest subset — see Phase 12 checkboxes)
    Phase 13:   IN PROGRESS (13.1-13.8 landed: depth prepass + SSAO, aliasing,
                clustered lighting, GPU light fill/culling, indirect rendering,
                async pipeline compilation, GPU timing; 13.9 cascade assignment,
                bounded spot shadows and bounded point shadows landed;
                contact/adaptive work remains)
    Phase 14:   IN PROGRESS (planned 14.1-14.6 population slices implemented, including
                all six 14.2 types and GPU-selected LOD; capability remains partial for
                documented follow-ups: per-instance culling, load-order-independent
                surface sampling, worker generation and population raycast)
                (2026-10-06 reconcile: those four follow-ups now carry [ ] checkboxes under
                14.1, 14.5 and 14.6, so the [~] is backed by items, not only prose.)
    Phase 15+:  IMPLEMENTED / VERIFIED (15.1 content addressing, 15.2 dependency graph,
                15.3 streaming, 15.4 staged resource + shader reload, 15.5 validation,
                and 15.6 KTX2/Basis transcoding are implemented and covered by tests;
                real Chromium/SwiftShader verified an ETC1S-to-BC7 six-mip upload.
                KTX2 3D volumes are explicitly deferred; core glTF/GLB geometry decode is
                separately verified in Phase 9.1, with extended import in Phase 16.1.)
                The `15+` label covers Phase 15 only; the interactive terrain work is tracked
                separately as Phase 15.5 below.
    Phase 15.5: [~] IN PROGRESS (interactive terrain and object dynamics: physical near-field
                rocks, push/roll/destruction, rover impact response and persistent sand tracks)
                Phases 16 through 28 remain NOT STARTED ([ ]) in their sections below, and
                Phase 29 is a roll-up (see the status block; `docs:check` verifies the phase
                keys directly).

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
    [~] IN PROGRESS

PHASE 14 - World Population
    [~] IN PROGRESS

PHASE 15+
    [x] IMPLEMENTED / VERIFIED

PHASE 15.5 - Interactive Terrain / Object Dynamics
    [~] IN PROGRESS


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
        the inline build and answers the same rays — tests/tasks.test.ts, tests/bvh.test.ts.)

    [x] Use spatial indices in runtime queries.
        Geometry's lazy mesh BVH powers triangle-accurate scene picking and refines large-mesh
        frustum culling. PhysicsWorld's deterministic sweep-and-prune index prunes rigid-body pairs
        before narrowphase while preserving the original insertion order. Heightfield raycasts keep
        their specialized grid traversal. Evidence: tests/ecs.test.ts, tests/rendering.test.ts,
        tests/physics.test.ts; capability: physics.spatialIndex.

    [x] Verify mesh decoding can execute outside the main thread.

        `decodeGltfMesh` / `loadGltfMesh` decode core glTF 2.0 and GLB triangle primitives through
        the `asset.gltf.decode` TaskScheduler task. The worker returns transferable typed arrays,
        indices, bounds, scene/node transforms and material factors; external `.gltf` buffer fetches
        are resolved before dispatch. Interleaved and sparse accessors plus normalized integer
        attributes are covered by `tests/gltf.test.ts`; the same GLB result is compared against the
        inline decoder and a real Node worker thread (`tests/tasks.test.ts`,
        `tests/gltf.test.ts`).

    [x] Verify a browser module-worker round-trip.

        `npm run check:browser:workers` loads `tests/fixtures/triangle.glb` in Chromium, asks a real
        `TaskScheduler` module worker to decode it, and asserts worker count, task completion, decoded
        geometry, zero inline fallbacks and zero worker failures (`tools/browser-check.mjs`).
        This is separate from the Node `worker_threads` adapter. Full asset import beyond uncompressed
        triangle geometry — images/material GPU construction, skin/animation, morph targets,
        instancing, Draco and meshopt — is tracked under `assets.gltfAdvanced` (Phase 16.1).

    [x] Browser-side worker round trip: check:browser:mars-workers observes native Worker Mars
        task/result messages, validates typed grids + pipeline identity, and requires uploaded
        showcase tiles with rover contact. The full browser gate includes the same check.
        (capability: workers.browserMarsTerrain)


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

        tests/terrainMaterials.test.ts, tests/marsShowcase.test.ts and the real-WebGPU pixel oracle
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
            tests/marsTerrain.test.ts; region planner + port verification tooling
            (tools/mars-terrain, tools/mars-port-check.mjs) pinned by
            tests/marsTerrainPlan.test.ts.
        [x] Mars Showcase uses the analytic-only port (seed 1337, equatorial plain), with a
            surveyed rover spawn, shared tile/vehicle/camera height queries, 128 m / 33-vertex
            chunks and 32 m skirts. tests/marsShowcase.test.ts pins scene assembly, driving,
            streaming budgets and LOD edges; check:browser asserts the port/mode, resident
            rover tile, terrain clearance and forward W-drive with wheel dust.
        [x] A site inspector beside the showcase: `?scene=mars-generator` streams the same port with
            a free orbit camera and the site from the URL (`MARS_SITE_PRESETS` keys or any `lat,lon`
            pair), reporting site, band, skirts, generation/material mode and splat tiles through
            `window.__forge.marsGeneratorState()`. Pinned by tests/marsGeneratorScene.test.ts and the
            check:browser arm of the same name (volcano preset: workers + layered, zero GPU errors;
            `?marssite=0,0` crater field: a resident tile genuinely blends two channels, its
            non-dominant one over 25 % of the mask mass — the volcano stays flat). docs/MARS-TERRAIN.md §5.
        [x] Analytic Mars cells run on workers from a complete serialized configuration (including
            custom planet settings, site radius/heading, detail and curvature flags), byte-identical
            to the original live pipeline. The showcase opts into the scheduler with nine warm-up
            requests then one per frame; real-thread and native-browser checks pin the path, and
            a cancellation acknowledgement keeps a task cancelled during worker bootstrap from
            stranding its worker slot.
        [!] The repo hosts no Stage A erosion cache; fidelity against the real generator cache
            remains unverified. Live field-cache pipelines are still inline-only; mesh building,
            uploads and cache-miss ground queries remain on main. The 4-channel weights now render,
            but coarse-LOD slope/biome sampling can still change the material mix.

            (2026-10-06 triage of this [!]: the first sentence is a blocker, not work — the
            fidelity check needs the upstream generator's ~30 MB `cache/global/` fields, which
            this repository deliberately does not ship; `check:mars-port` stays a synthetic-cache
            smoke test until a human run supplies the real cache (docs/MARS-TERRAIN.md §5–6,
            capability: terrain.marsGeneratorPort). The inline-only mesh/upload/ground-query
            residual is the accepted shape recorded under 10.2 and KNOWN-ISSUES §Terrain, not
            unmet 10.9 scope. The coarse-LOD material-mix item closes with the 14.1 follow-up
            "Load-order-independent surface sampling" — the same resolution-independent surface
            is the fix in both phases — and is worked there, not twice here.)

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
        (tests/particles.test.ts; capability: particles.gpuRendering; docs/PARTICLES.md)


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

    In progress. Landed: the depth prepass (13.1) with SSAO as its first consumer,
    real transient aliasing in every SSAO frame (13.2), clustered lighting (13.3),
    the GPU cluster fill (13.4), GPU object culling with the HiZ pyramid (13.5),
    indirect rendering (13.6), asynchronous pipeline compilation (13.7) and GPU
    timing (13.8). Phase 13.9 has conservative per-object cascade assignment,
    bounded spot shadows (up to four lights) and bounded point shadows (up to two
    lights, six cube faces each); contact shadows and adaptive resolution remain.
    Frame: forge.shadow.<n> → forge.shadow.spot.<n> → forge.shadow.point.<n>.<face>
    (both optional, after cascades) → forge.prepass → forge.hiz.<n> →
    forge.objects.cull → forge.ssao → forge.ssao.blur.h → forge.ssao.blur.v →
    forge.main → forge.sky → particles → bloom → forge.tonemap (the cull passes
    exist only on the device path).

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
        `prepassDraws`; tests/frame.test.ts, tests/pipeline.test.ts, check:browser
        pixel identity.)

    [~] Reuse depth for:

        [x] SSAO            — `forge.ssao` samples the prepass depth.
        [x] particles       — the soft-particle fade samples the same scene depth,
                              which the prepass now lays down (no second depth pass).
        [x] culling         — `forge.objects.cull` + the HiZ pyramid read it (13.5).
        [ ] transparency    — blended surfaces depth-test against it; no
                              transparency technique (depth fade, OIT) consumes it.
        [ ] post processing — no depth-based post effect exists yet.

    [ ] Cutout (alphaTest), fading (opacity < 1) and water surfaces in the prepass
        (a fragment stage that discards exactly like forge.main), so they get early-Z
        and take part in SSAO.

    [ ] SSAO for orthographic cameras (the forward pass's bilateral key is clip.w,
        which only a perspective projection makes view depth).


13.2 Render Graph Aliasing Validation

    [x] Create real production passes that exercise transient resource
        aliasing. (The SSAO chain: `ssao.raw` → `ssao.blur` → `ssao.result`; the
        raw estimate's memory is reused for the result.)

    [x] Verify aliasedBytes becomes meaningful in normal frames. (Every frame with
        SSAO: 921,600 B at 1280x720 — PBR fixture 11 transients → 10 textures;
        tests/frame.test.ts, check:browser.)


13.3 Clustered / Forward+ Lighting

    [x] Implement GPU-friendly clustered lighting. (A 16x8x24 view-space grid built
        on the CPU and read from the fragment stage: `engine/src/rendering/clusters.ts`
        → `ClusterUniforms` / `ClusterLightBlock` / `ClusterGridBlock` on frame
        bindings 6-8 → `clusterIndexOf` + `lightContribution` in
        `shaders/standard.ts`, behind `perFrame.flags` bit 5; `Renderer.buildClusters`
        uploads the used prefixes and nothing is allocated per frame. Adds no pass —
        the graph is identical with it on or off, and so is the picture while a scene
        fits the old list. docs/RENDERING.md §4b; tests/clusters.test.ts (18),
        tests/frame.test.ts (6 clustered), tests/wgsl.test.ts, check:browser.)

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
        tests/lightCulling.test.ts pins it byte for byte (evictions included);
        `RendererOptions.lightCulling` = auto|cpu|gpu, `stats.clusterFill`, demo
        `?lightculling=cpu|gpu` + HUD. docs/RENDERING.md §4c; tests/lightCulling.test.ts
        (11), tests/frame.test.ts (round trip), check:browser — the two fills give an
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
        `cullBatchesOnCpu` is the twin the mock device runs; tests/objectCulling.test.ts
        (16), tests/frame.test.ts (3), check:browser.)

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
        `disabling occlusion culling changed 16161 px`, and tests/objectCulling.test.ts
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

    [ ] Per-instance culling inside a batch: one visible instance keeps its batch.

    [ ] Culling the shadow cascades with the same pass (the cascades still use the
        CPU's per-cascade AABB test).


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

    [x] Placement determined by:

        seed
        chunk coordinate
        population type

        `scatterPopulationChunk` (engine/src/population/scatter.ts) is a pure function of
        `(type, seed, chunk coordinate, sampler)`: a `chunkSeed`-derived `Rng` stream over a
        stratified jittered grid (one candidate per `densityGrid²` cell), with slope, height-band
        and `maxPerChunk` rules rejecting candidates after every random draw so the stream position
        never depends on acceptance. Bit-for-bit reproducibility pinned by tests/population.test.ts.

    [ ] Load-order-independent surface sampling (follow-up, added 2026-10-06 to make the phase's
        remaining work checkable — the baseline block names all four of these): acceptance samples
        must come from a resolution-independent surface, so the same chunk scatters the same
        instances whichever LOD its tile first became ready at (docs/KNOWN-ISSUES.md
        § World population "Placement depends on the tile resolution…").


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
        tests/population.test.ts (seam + streamed-terrain suites).


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
        paths, and streamed `PopulationWorld` metadata propagation (tests/population.test.ts,
        tests/pipeline.test.ts). The terrain demo exercises separate hi/lo rock and boulder meshes.


14.5 GPU Culling

    [x] Population culling.

        Each (chunk, type) submission becomes its own batch with its own conservative bounds, so
        the Phase 13.5 device object culler (frustum, distance, HiZ) and the Phase 13.6 indirect
        records apply to populations unchanged; a type's `maxDistance` is the per-batch distance
        limit the culler enforces. Per-chunk granularity only — a partially visible chunk draws all
        of its instances (per-instance device culling is not built).

    [ ] Per-instance culling inside a batch (follow-up, added 2026-10-06): the same work as the
        13.5 leftover "Per-instance culling inside a batch" — one visible instance keeps its batch
        today; closing either line closes both limitations (docs/KNOWN-ISSUES.md § World population
        "Device culling is per chunk, not per instance").


14.6 Population Streaming

    [x] Population follows terrain/world chunk streaming.

        `PopulationWorld` (engine/src/population/world.ts) diffs `TerrainWorld.chunks` every update:
        ready chunks get populations within a per-frame budget, evicted chunks lose them, and an
        LOD remesh re-anchors Y positions to the new heightmap without re-scattering XZ placement.
        Zero ECS entities are created — pinned by tests/population.test.ts.

    [ ] Population generation on workers (follow-up, added 2026-10-06): the scatter pass is
        main-thread inline, budgeted by `generationsPerFrame`; moving it behind `TaskScheduler`
        needs the heightmap samples available off-thread, like terrain cells in 10.2
        (docs/KNOWN-ISSUES.md § World population "Population generation is main-thread inline").

    [ ] Population raycast (follow-up, added 2026-10-06): picking and debug tools cannot hit
        population instances today; add a deterministic spatial query over the instance blocks
        (docs/KNOWN-ISSUES.md § World population "Population rendering has no raycast…").


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
        importer on callers. Verified in `tests/phase15.test.ts`.

    [x] Shader reload.

        `PipelineFactory.replaceShaderSource` runs the engine's WGSL structural/layout validator
        before it invalidates pipeline bundles; `clearShaderOverride` returns to the built-in source.
        Invalid source leaves the last good pipeline cached. Verified in
        `tests/shaderHotReload.test.ts`.


15.5 Asset Validation

    [x] Invalid mesh detection.
    [x] Missing texture detection.
    [x] Unsupported material detection.
    [x] Excessive memory detection.

        `engine/src/resources/validation.ts` provides structured mesh-stream/index, texture
        dimensions/mip/format/capability/block-alignment, material-technique/PBR, dependency and
        memory-budget diagnostics. `ResourceDescriptor.validate` rejects error-severity output before
        publication and disposes rejected values; warnings remain observable through the logger.
        Verified in `tests/phase15.test.ts`.


15.6 KTX2 / Basis

    [x] Transcode supported KTX2/Basis content to the best available WebGPU texture format.

        `loadKtx2Texture` lazily loads the pinned Basis Universal WASM, detects the KTX2 DFD transfer
        function, transcodes each mip/layer/face, and uploads BC7, ASTC, ETC2 or RGBA8 LDR data;
        HDR content selects BC6H or RGBA16F. `Texture.writeMipData` preserves block-compressed mip
        data, including the physical whole-block extents required for lower mips. Automatic selection
        falls back to RGBA when the device lacks compression support or the base dimensions cannot be
        represented by a block-compressed WebGPU texture. Verified with a real ETC1S fixture through
        Basis WASM in `tests/phase15.test.ts`, target-selection/mock-upload coverage there, and a
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
        remains open below.

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
        validated before a dynamic proxy is created. Roll resistance and per-instance geology remain
        open for the later break/settle step.

    [x] Dynamic rock bodies.

        `InteractiveRockProxy` owns a dynamic `RigidBody`; the Mars Showcase admits nearby proxies to
        a Mars-gravity `PhysicsWorld` with a shared terrain heightfield. Contact impulses move the
        body, and ordinary rigid-body gravity/inertia allow it to slide or roll when support is lost.
        The showcase uses a simplified sphere rather than the render mesh. Compound shapes and crater
        edge browser evidence remain open under deterministic verification.

    [x] Break and settle behavior.

        When impact force exceeds the material-derived break strength, the showcase zeroes the
        population instance, marks its block revision, removes the dynamic proxy and records the
        broken-rock count in `marsState()`. The broken state is deterministic and does not spawn
        fragment bodies; fractured pieces, persistence and save/load remain later work.


15.5.3 Rover Obstacle Response

    [x] Vehicle/rock contact bridge.

        `bridgeRockContact` transfers the assessed normal contact through the rover velocity and the
        dynamic rock proxy, while the showcase keeps wheel suspension on the terrain heightfield.
        Blocked contacts retain tangential motion but remove most inward velocity; pushable contacts
        transfer a smaller share to the rock. Continuous collision/tunnelling protection and per-wheel
        contact manifolds remain part of the next response step.

    [x] Climb, push and damage rules.

        Contact height, available traction and material-derived push force distinguish climbable,
        pushable and blocked rocks. `applyRoverImpactDamage` applies bounded hull, wheel and suspension
        damage to tall blocked impacts; a disabled rover cuts throttle and holds its brake. Damage and
        disabled state are exposed through `marsState()`. Per-wheel contact manifolds and repair/gameplay
        recovery remain open.

    [~] Deterministic physics and browser evidence.

        CPU coverage now replays promotion, impulse, gravity, rolling, blocking and damage decisions
        deterministically. The focused `npm run check:browser:mars-interactive` arm verifies the live
        streamed showcase promotes near-field rocks, records wheel tracks and runs 12 seconds with
        zero GPU errors; the full gate can compose this with the other focused commands. A deterministic
        drive-to-rock scenario is still required to verify push, block/damage and crater-edge roll
        pixels/telemetry.


15.5.4 Sand Deformation and Wheel Tracks

    [~] Persistent per-tile deformation state.

        `TerrainDeformationField` now stores bounded, chunk-keyed shallow wheel deltas separately from
        the procedural generator, supports sampling, revision tracking and serialize/restore, and the
        Mars Showcase records load-bearing wheel impressions into it. Rendering, collision application
        and eviction-time persistence wiring are still open.

    [x] Visual tracks first.

        The Mars Showcase now records load-bearing wheel contacts into a bounded ring of translucent
        terrain decals. Track marks are placed above the shared streamed surface, reuse one mesh/material,
        and expose `visibleTrackMarks` for the browser gate. Tile-owned mask integration and displaced
        sand edges remain open for the physical response step.

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

    [ ] glTF animation import
    [ ] clip sampling

        Phase 9.1 supplies worker-backed static glTF/GLB triangle decode. Skin/animation import,
        image/material GPU assembly and Draco/meshopt support remain separate extended-import work
        (`capability: assets.gltfAdvanced`).


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
                    ORIGINAL PRIORITY QUEUE (HISTORICAL)
================================================================================

DO NOT immediately start scripting, editor work, networking, or miscellaneous
features.

The sequence below is retained from the original plan, not a current queue: terrain workers/LOD,
vehicle integration, and Phase 13.1–13.8 have since landed. The active Phase 13 remainder is 13.9
shadow improvements (see the current state at the top of this document).

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

    Reason (at the time of this roadmap revision):
        Clustered lighting, depth prepass, GPU culling, indirect rendering,
        GPU timing and async pipeline creation were unfinished; 13.1–13.8 have
        since landed, with 13.9 shadow improvements still open.


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
