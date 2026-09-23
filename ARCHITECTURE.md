# Forge Engine — Architecture

Forge is a browser-native, WebGPU-first 3D game and real-time simulation engine. It is
designed as a reusable technology platform (an engine), not as a single demo. The Mars
rover application in `examples/mars` exists to prove the engine works.

This document records the *structure* and the *reasoning*. Individual subsystem contracts
live in `docs/` (`RENDERING.md`, `PHYSICS.md`, `TERRAIN.md`, `VEHICLES.md`,
`PARTICLES.md`, `SCRIPTING.md`, `ASSETS.md`, `PERFORMANCE.md`, `EDITOR.md`, `API.md`).
Decision records for every major technology choice are in `docs/decisions/`.

---

## 1. Design principles (and what they mean concretely)

| Principle | Concrete commitment |
|---|---|
| WebGPU-first | The renderer is written against the WebGPU model (bind groups, pipelines, storage buffers, render/compute passes). No WebGL fallback layer; capability *degradation* within WebGPU is handled by feature/limit negotiation (see §5.4). |
| Modern GPU architecture | Compute-first particle and clustering paths, one large dynamic vertex/index buffer with offset addressing, texture arrays instead of atlases where possible, no per-draw uniform writes. |
| Data-oriented where it pays | Hot component data (transforms, renderables, rigid bodies, particles) lives in typed arrays and struct-of-arrays stores with index-based iteration. Object wrappers exist for API ergonomics but are *handles over* the arrays, never the storage. |
| Multithreaded where the browser permits | `TaskScheduler` runs CPU-heavy work (terrain generation, BVH builds, mesh decoding, erosion, occlusion prep) in a worker pool. Workers are pure functions of `(seed, key, input)` so results are order-independent and deterministic. SharedArrayBuffer is used only when cross-origin isolation permits it. |
| Deterministic simulation | All simulation (physics, vehicles, weather, procedural generation, particle spawn ordering) advances on a fixed timestep with a seeded RNG and index-ordered iteration. Bit-exact reproducibility is asserted in tests. Rendering is *not* deterministic and never feeds simulation. |
| PBR | Smith–Schlick visibility, Trowbridge–Rebragg NDF, Schlick fresnel, analytic DFG approximation, energy-conserving diffuse. Cook–Torrance, not "fake specular". |
| Large worlds | Double-precision (`Double3`) world coordinates, origin rebasing, and origin-relative float32 rendering (§7). |
| Streaming + LOD | Content-addressed chunk managers with priority queues, budgets, and eviction; GPU geomorphing quadtree terrain LOD; texture/mesh streaming through the same resource handle system. |
| Modular subsystems | Subsystems depend only on interfaces of lower layers plus `EngineContext` services. No imports from siblings' internals; enforced by import-boundary tests (§11). |
| Explicit lifecycle | Everything GPU-resident is owned by a `ResourceRegistry` with refcounts; `engine.dispose()` provably frees all GPU objects (asserted by the mock-GPU leak tests). |
| Debuggable | `Profiler` scopes, `DebugLayer` visualizers, an in-page console, and machine-readable `stats` on every subsystem. |
| Extensible | Systems, components, importers, material features (shader chunks), terrain generator stages, physics shapes, debug visualizers, and console commands are all registration-based. No engine file needs editing to add one. |

Anti-goals: no WebGL1 support, no Node server, no bundled asset pipeline service, no
general-purpose scripting VM outside the JS environment, no editor dependency in the
runtime path.

---

## 2. Repository layout

```
engine/                 @forge/engine — the runtime. Builds with tsc, zero runtime deps.
  src/core/             application loop, time, config, logging, events, memory, tasks, math
  src/rendering/        device, render graph, materials, shaders, passes, cameras, lights
  src/scene/            entity ids, component stores, systems, transform/visibility/render systems
  src/world/            streaming orchestration, biomes, weather, coordinate space
  src/terrain/          TerrainWorld/Chunk/Tile/LOD/Material/Generator
  src/physics/          fixed-step rigid bodies, broadphase, narrowphase, solver, queries
  src/vehicles/         raycast vehicle, tires, suspension, engine, transmission, differentials
  src/particles/        CPU reference + Phase 12 GPU path (emit/sim/cull/billboard+soft render-graph passes)
  src/environment/      sun position (NOAA/Meeus), atmosphere model + presets, fog reference, DayNightCycle (8a);
                        weather, clouds, water, lightning join here in 8b
  src/animation/        clips, states, graphs, IK, skinning
  src/audio/            WebAudio graph, spatialization, procedural engine audio
  src/input/            devices + action mapping
  src/scripting/        Script base, ScriptComponent, coroutines, timers, events
  src/assets/           AssetManager, cache/handles, importers (glTF/GLB/HDR/WAV/KTX2/…)
  src/resources/        ResourceRegistry, handles, refcounting, eviction
  src/debug/            debug draw, visualizers, dev console
  src/gpu/              WebGPU helpers (buffer/texture builders, formats, sync)
editor/                 @forge/editor — browser dev tools. Depends on engine's public API only.
examples/               vite apps: spinning-cube (P1), pbr-scene (P2), terrain (P4),
                        vehicle-playground (P6), particles / Phase 12 GPU, sky / day-night (P8a).
                        Mars (P14) is not built.
tests/                  cross-subsystem integration tests + real-WebGPU browser tests
benchmarks/             measured performance suites (math, ECS, terrain, physics, particles)
docs/                   documentation + ADRs in docs/decisions/
tools/                  asset importer CLI, format converters, validation scripts
```

Dependency direction (one-way, verified by `tests/architecture.test.ts`):

```
core  <-  gpu  <-  rendering
  ^         ^          ^
  |         |          |
resources - + -> assets |
  ^         ^           |
  |         |           v
  +---------+------ scene <- { terrain, physics, vehicles, particles, environment, animation,
                               audio, input, scripting, world }
                                         ^
                                         |
                                    editor / examples
```

`core` imports nothing. `engine/src/index.ts` is the only module allowed to see all
subsystems (composition root). `rendering` additionally imports `environment` (the sky pass
uploads the atmosphere presets and the fog mode table); `environment` never imports `rendering`,
and `scene` knows the environment's *types* only (the `sky` settings block).

---

## 3. Threading model

| Work | Thread | Notes |
|---|---|---|
| Scripting, gameplay, rendering submission | main | Browser forbids DOM/GPU-encodable work off-main in practice; keep logic here |
| Fixed-step simulation (physics, vehicles, weather) | main (worker **optional**) | Determinism + tight coupling to transforms wins over raw parallelism. `EngineConfig.simulation.worker` can move the *whole* sim step to a worker with double-buffered state snapshots (implemented, off by default; see ADR-008). |
| Terrain generation, erosion, scatter, BVH/LBVH build, mesh decode, texture decode | worker pool | Pure functions, prioritized, cancel-on-invalidate |
| Culling | main + GPU | GPU occlusion queries where `occlusion-query` style timestamp support exists; otherwise CPU frustum + HiZ from previous frame's depth |
| Audio graph | audio thread (browser-managed) | We only schedule; never block |

Because only the main thread owns the scene, there is no shared mutable scene state; all
worker results are values copied back into typed arrays. This is the reason SharedArrayBuffer
is not a hard requirement.

---

## 4. Frame pipeline

```
RAF(t)
 ├─ collect input (action state snapshot, ring-buffered for fixed steps)
 ├─ scheduler.drain()                 (asset/task completions, applied before sim)
 ├─ script onPreUpdate
 ├─ while(accumulator >= fixedDt) {   (max N substeps, then clamp)
 │     physics.fixedStep · vehicle.fixedStep · particleSim.fixedStep
 │     weather.fixedStep · script.onFixedUpdate · transforms sync
 │  }
 ├─ script.onUpdate                 (variable rate; render-facing, non-simulating)
 ├─ animation.update (blend, IK, skin)
 ├─ transformSystem.update (local→world, dirty propagation, bounds)
 ├─ camera update (rigs, shake, origin rebase decision)
 ├─ streaming update (chunk load/evict requests, budgeted)
 ├─ visibilitySystem (frustum + distance + optional HiZ/occlusion)
 ├─ renderGraph.execute()            (see §5.2)
 ├─ stats/profiler flush
 └─ present
```

Render graph passes for the default "quality" profile:

```
shadow.cascade(N=4) → depth.prepass → gbuffer(opaque forward, velocity)
  → lighting(forward+ clustered, SSAO) → atmosphere(sky+fog+clouds)
  → volumetrics(light scattering) → particles(sim → resolve)
  → transparent(water, FX particles) → reflections(screen-space, probe)
  → post(bloom down/up, DoF, motion blur) → tonemap(FXAA) → ui → present
```

Passes are individually enabled/disabled by quality profile and by feature
availability. The pass *description* is cheap and is rebuilt every frame from the scene
settings; the GPU resources behind it are pooled by descriptor and survive across frames,
so a steady frame allocates nothing (asserted by the tests and the browser gate).

**Built today (Phase 2 + 8a, see `docs/RENDERING.md`):**
`shadow.cascade(N≤4) → main(forward, HDR rgba16float, fog in-shader) → sky(analytic, far
plane, depth read-only) → bloom(prefilter, down×n, up×n) → tonemap → present`, with an LDR
path (`main` + `sky` straight to the swapchain) when `hdr` is off. Depth prepass, clustered
lighting, SSAO, clouds, volumetrics, particles, reflections, DoF, motion blur and FXAA are
not built yet.

---

## 5. Rendering architecture

### 5.1 Device layer (`engine/src/rendering/device.ts`)
Owns `GPUAdapter`, `GPUDevice`, swapchain format, limits, feature set, sampler/pipeline
caches, and error scopes. Every subsystem requests resources through
`GraphicsDevice`/`ResourceRegistry` rather than creating them ad hoc.

### 5.2 Render graph
Typed pass description: each pass declares `read`/`write` resources (transient or import),
`colorTargets`, `depthTarget`, and an `execute(ctx)` callback. The graph:
1. validates the pass set (single writer per resource per pass, no cycles, no read-before-write),
2. computes per-resource live ranges and *aliases* transient textures that never overlap,
3. creates/destroys transient textures only when the topology changes,
4. records and submits one command buffer per execute, wrapped in debug groups and
   (when available) timestamp queries.

Chosen over a per-frame barrier model because WebGPU infers barriers, so the graph's job is
memory planning and pass ordering, not synchronization. See ADR-004.

As built (`engine/src/rendering/renderGraph.ts`): producers are tracked per subresource
(mip/array layer) so one cascade array can be written by N passes and sampled by one; dead
passes are culled unless they have a side effect or write an imported texture; same-shaped
transients with disjoint live ranges share a physical texture; physical textures are pooled
across frames and retired after two idle frames; misuse (read-before-write, load of undefined
contents, self-sampling, stale handles) throws `UsageError` with the pass name before anything
is recorded. Timestamp queries are not wired up yet.

### 5.3 Materials, shaders, caching
A `Material` is a data record + a `ShaderKey`. The key is
`hash(shaderSourceHash | vertexLayoutHash | defines | blendState | depthState | textureFlags)`.
Identical materials with different textures share one pipeline; per-material differences
live in a bind group + uniform buffer. Consequence: `ShaderCache` hit rate is dominated by
*feature combinations*, not material count. Pipeline creation is async and never stalls a
frame: if a pipeline is not ready, the renderable is drawn with the previous frame's
pipeline or skipped (documented, visible in stats as `pipelinesPending`).

As built: `PipelineFactory` keys on technique × colour/depth format × blend × cull ×
instancing × fragment entry, shares six bind group layouts, and creates pipelines
synchronously (`createRenderPipeline`); the async path and `pipelinesPending` are not built.
`invalidate()` is the device-loss hook.

### 5.4 Graceful degradation
Feature matrix checked at init and expressed as booleans that the graph reads
(`device.supports.timestampQuery`, `.textureArray`, `.float32Filterable`, `.subgroups`…).
Shadows, clustered lighting, SSAO, DoF, motion blur, HDR, KTX2, and GPU particle
collisions each have a reduced path. Missing features *never* throw in `initialize()`; they
downgrade and log.

### 5.5 Lighting/shadows
Forward+ with a 16×8×24 CPU-built cluster list (built in a worker when lights change),
4-cascade CSM with texel-snapped, flicker-free projections and a 2048 atlas; spot lights
use dedicated 1024 atlased maps; point lights use 6-face atlased cube maps with
single-face-per-frame amortized updates. Contact shadows are a short-range depth-test pass
in the SSAO buffer (documented as an approximation).

As built: plain forward lighting over a fixed light list (no clustering); directional CSM
with up to 4 cascades (3 in the default profile) fitted as texel-snapped bounding spheres
over practical-split slices into a `depth24plus` 2d-array, normal-offset bias + 3×3 PCF,
cascade blending and distance fade (`engine/src/rendering/shadows.ts`, `docs/RENDERING.md`
§4). Spot/point shadows and contact shadows are not built.

---

## 6. Scene model (ECS-informed, not purist)

- `EntityId` = 32-bit generational index (16 bits index, 16 bits generation).
- Components: plain classes registered in a `ComponentRegistry` with a dense id; storage is
  per-component-type: `StructStore` (typed-array, for `Transform`, `Renderable`,
  `RigidBody`, `ParticleHeader`) or `ObjectStore` (instances, for `MeshRenderer`,
  `ScriptComponent`, `Vehicle`). Both expose index-aligned arrays so systems iterate densely.
- A per-entity `componentMask` (big-int/word-set) enables `Query<...>` to iterate the
  smallest candidate store and mask-filter, avoiding per-entity hash maps.
- Systems implement `ISystem { order, enabled, update(ctx) }`; the `SystemScheduler`
  topologically sorts on `order` + declared `before/after` and warns on ambiguity.
  Ordering is fixed and recorded in `stats`, never insertion-order-dependent.
- Structural changes (add/remove component, destroy entity) are recorded in a journal and
  applied at defined safe points (system boundaries), so iteration is allocation-free and
  cannot observe mutation mid-pass.

See ADR-005 for "why not a full archetype store".

---

## 7. Large worlds

`Double3` stores world position as `(hi, lo)` float64 pairs with exact Dekker addition.
`CoordinateSpace` maintains `renderOrigin` (a `Double3`). Rules:

1. Simulation, physics, and terrain math use origin-relative float32/float64 local space
   with the origin within ~1 km of the active sim focus; bodies are rebaselined (position
   and velocity transformed exactly) only when the focus moves > `rebaseThreshold`
   (default 1024 m), a rare, logged event.
2. All GPU uploads happen in origin-relative float32.
3. Terrain heights are a pure function `h(x,z,seed)`; chunk data is a *cache* of that
   function, so a chunk's world position never depends on what else is loaded.
4. Streaming keys are `(chunkX, chunkZ, level)` ints; nothing in the world is addressed by
   float coordinates.

---

## 8. Terrain and procedural worlds

`TerrainWorld` (chunk manager, LOD tree, material layers, deformation log) →
`TerrainChunk` (independent streamable unit) → `TerrainTile` (mesh + heightmap + splatmap +
collision acceleration) → `TerrainLOD` (geomorph weights). Generation is a `GeneratorPipeline`
of stages (`HeightGenerator`, `ErosionGenerator`, `CraterGenerator`, `BiomeGenerator`,
`ScatterGenerator`, …) that each consume a deterministic noise field and a `WorldCell`.
Same pipeline runs on main thread (small budgets) or worker pool (large). Because generation
is pure, worker results are idempotent and cacheable to disk by key.

Terrain *collision* and *vehicle contact* sample the cached heightmap with bicubic
interpolation, guaranteeing that what you see is what you drive on (a real correctness
requirement, see ADR-006).

---

## 9. Physics

Own implementation, float64 accumulator / float32 storage split where it matters, semi-implicit
Euler + sequential-impulse solver with warm starting, split-impulse position correction,
Coulomb friction, restitution with velocity-threshold rest, sphere/box/capsule/cylinder/
convex-hull/heightfield/trimesh shapes, GJK+EPA for convex pairs, analytic for primitives,
BVH (LBVH via worker) for trimesh/heightfield queries. Broadphase: sort-and-sweep on 3 axes
with incremental update, deterministic ordering by `(a,b)` id pair.

Fixed timestep `1/60` default, substepping up to `maxSubsteps`, render interpolation
between `prev` and `cur` states with an `alpha` — physics framerate never affects visuals
and visuals never affect physics (tested by running the same sim at 15/30/60/144 Hz display
rates and asserting identical trajectories).

WASM: the solver's hot inner loops are structured so a future `forge-physics.wasm` can
replace `Narrowphase`/`Solver` behind the existing interface (see ADR-009). No Rust
toolchain exists in the current development container, so shipping hand-written WASM now
would be unverified code — the engine instead keeps the layout WASM-ready (flat arrays, no
GC-visible object graph in the solver) and measures in JS.

---

## 10. Resources and lifecycle

`ResourceRegistry` is the single owner of GPU-backed resources.
- `acquire(desc) → ResourceHandle<T>`; refcounted, key-addressed (shared when descriptors match).
- Handles are opaque tokens: `handle.id` + `handle.peek()`; using a released handle throws a
  typed error rather than touching a dangling object.
- Eviction: LRU among unpinned handles with a GPU-memory budget; streaming systems pin what
  they need.
- `engine.dispose()` walks the registry and asserts it is empty; the mock-GPU test suite
  fails the build if any texture/buffer/pipeline created during a scene change is not released.

Asset side: `AssetManager` gives `AssetHandle<T>` with priorities, cancellation, `loadModel`,
`loadTexture`, `loadMaterial`, `loadAudio`, `loadScene`; importers are registered by extension.

---

## 11. Testing strategy

| Layer | Tooling | Examples |
|---|---|---|
| Unit (math, ECS, terrain, physics, vehicles, particles, assets, serialization) | vitest on Node | ~1200 assertions covering determinism, edge cases, known-good analytic values |
| GPU-logic without a GPU | in-repo **mock WebGPU** (`engine/src/testing/mockGpu.ts`) that validates descriptors, tracks object lifetime, records command streams | pipeline cache reuse, render-graph validation/aliasing, leak checks, bind-group layout, particle buffer math |
| Real WebGPU | Playwright + headless Chromium (`--enable-unsafe-webgpu`, SwiftShader) | adapter init, first-frame no validation errors, non-empty framebuffer (readback variance), demo page runs with 0 console errors |
| Benchmarks | custom harness in `benchmarks/` | reported in `docs/PERFORMANCE.md` with the exact host spec and date; never fabricated |
| Architecture | vitest | import boundaries, no cycles, public API surface snapshot, "no TODO-stub systems" scan |

Every phase ends with: build → typecheck → tests → demo run (headless WebGPU) → benchmarks
→ leak check → docs + ROADMAP update.

---

## 12. Public API shape

```ts
const engine = new Engine({ canvas, quality: "high", assets: { baseUrl: "/assets" } });
await engine.initialize();               // resolves { backend, features, limits, degraded[] }

const scene = new Scene();
scene.add(new TerrainWorld({ seed: 1234, chunkSize: 512, maxLOD: 12 }));
const rover = scene.createEntity("Rover");
rover.add(new Transform().setWorldPosition(0, 0, 0));
rover.add(new MeshRenderer(mesh, material));
rover.add(new VehicleBody({ mass: 1800, drivetrain: "4WD" }));
rover.add(new ScriptComponent("RoverController"));

engine.setScene(scene);
engine.start();
```

Lower-level access for advanced users goes through `engine.gpu` (`device`, `queue`,
`createRenderPipeline`, `createComputePipeline`, `createBindGroup`, buffers/textures/samplers)
and `engine.renderGraph.appendPass(...)`. `engine.gpu` hands out *raw* WebGPU objects the
caller owns, but engine-owned internals are never returned mutable. See `docs/API.md`.

---

## 13. Where the design deliberately chose less

Documented in `docs/decisions/ADR-010-deferred-techniques.md`: real-time GI (uses SSAO +
probe IBL instead), virtual texturing (needs sparse binding, not widely exposable —
streamed clipmap tiles instead), full trimesh dynamics for terrain (heightfield is exact
and cheaper), Unreal-style Nanite meshlet pipeline (geomorphing quadtree + GPU instancing
chosen; geometry shader-free), networked replication (out of scope; deterministic sim and
snapshot APIs make it possible later).
