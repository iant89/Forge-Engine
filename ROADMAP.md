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
    Phase 12:   IMPLEMENTED / VERIFIED (honest subset — see Phase 12 checkboxes)
    Phase 13:   IN PROGRESS (13.1-13.8 landed: depth prepass + SSAO, aliasing,
                clustered lighting, GPU light fill/culling, indirect rendering,
                async pipeline compilation, GPU timing; 13.9 cascade assignment,
                bounded spot shadows and bounded point shadows landed;
                contact/adaptive work remains)
    Phase 14+:  NOT STARTED

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
    [~] IN PROGRESS

PHASE 10 - Terrain 2.0 / Streaming
    [!] IMPLEMENTED BUT REQUIRES HARDENING

PHASE 11 - Physics / Vehicle Integration
    [x]

PHASE 12 - GPU Particles 2.0
    [x]

PHASE 13 - Renderer 2.0
    [~] IN PROGRESS

PHASE 14+
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
        [!] No demo scene uses the port yet, the repo hosts no Stage A cache (so the demos
            would render the analytic-only surface), and the 4-channel splat weights it
            writes are not consumable until 10.8 lands.


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
        - Trail history (4 samples per particle) is written on GPU; ribbon mesh draw is deferred.

    Still deferred / stretch:

        - Ribbon mesh generation and draw; mesh particles.
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

    [!] Ribbon generation — deferred; history is stored, ribbon mesh not drawn.


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
        [!] ribbon — history only; ribbon draw deferred
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
