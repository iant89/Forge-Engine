# Phase 27.1 public API review record

> **1.0 status:** The Phase 27.1 review recorded here is now part of the released `@forge/engine`
> 1.0.0 contract. The current surface is 2,283 exports (2,274 public, 9 experimental, 0 deprecated),
> including the reviewed 1.0 extension contract and the Phase 14 population additions. Consumer guidance is in
> [API-REFERENCE.md](API-REFERENCE.md), [MIGRATION-1.0.md](MIGRATION-1.0.md), [VERSIONING.md](VERSIONING.md),
> [DEPRECATION.md](DEPRECATION.md), and [EXAMPLES.md](EXAMPLES.md).

This document is the human-readable review record for the `@forge/engine` package-root audit. The exact machine-enforced decisions live in [`engine/api-approvals.json`](../engine/api-approvals.json); the resolved declaration baseline lives in [`engine/api-surface.json`](../engine/api-surface.json).

## Decision and boundary

Phase 27.1 preserved **all 2,171 public candidates** as supported Engine API 1.0 candidates. The
released surface adds the 16 public extension-contract exports plus the reviewed Phase 13 contact-depth
shader export, for **2,188 approved public exports**. Phase 14 adds a separately reviewed population
batch of 13 canonical sampling, worker-task, and resident-raycast exports, and Phase 16 adds ten glTF,
morph-animation, and secondary-UV contracts across three follow-up batches, for **2,211 approved public
exports** out of 2,220 total across 29 review batches; the fe-39 planet-viewer batch (`environment/2`, 55 exports) plus the eight additions recorded below bring the surface to **2,274 approved public exports** out of 2,283. Each approved row has an exact declaration kind,
direct declaration hash, transitive contract hash, and subsystem review. The nine exports already marked
experimental remain experimental and are not approvals. There are no deprecated exports and no pending
public candidates.

The later Phase 27 work is now complete: the reference inventory, reviewed examples, 0.x migration
guide, semver/release policy, deprecation window, coherent extension contract, and `1.0.0` release
are linked from this record. The Phase 14 review is backed by the canonical population, scheduler, worker,
and raycast evidence listed below. The approval ledger remains the exact machine-enforced record.

The Phase 13 renderer review update records the current contracts for the contact-shadow settings,
adaptive shadow policy, material-aware prepass/orthographic SSAO path, contact-depth pipeline,
public contact-depth shader, and shared per-instance culling extension. The rendering review is backed
by `tests/rendering/frame.test.ts`, `tests/rendering/pipeline.test.ts`, `tests/rendering/wgsl.test.ts`,
`docs/RENDERING.md`, and the focused `check:wgsl`/`docs:check` gates.

The vehicles follow-up review (`vehicles/2`) updates the chassis-related declarations for Phase 23.3:
`VehicleChassisOptions` exposes the opt-in dynamic body settings, while `VehicleSystem` and
`createVehicleChassis` retain the existing kinematic default and now document the fixed-step bridge.
The focused vehicle-physics and Mars showcase suites cover the dynamic acceleration command, solver
contact/CCD, shared-world teardown, external teleports, and showcase contact behavior.

This follow-up also records eight public additions in the existing resources, rendering, particle,
and debug review batches: `DecodedGltfTextureTransform`, the two material texture-slot/transform
contracts, three GPU particle diagnostic contracts, `ParticleGpuDiagnosticInfo`, and
`requestGpuParticleDiagnostics`. The rendering, resource, particle, and debugger suites cover the
transformed bindings, MASK coverage, opt-in asynchronous readback, and debugger exposure; their exact
declarations and transitive hashes are recorded in the updated approval ledger.

## Review method

The review used the TypeScript program that builds the package, rather than parsing barrel text. The audit resolves every package-root alias to its target declaration, including declarations reached through nested barrels. The 103 distinct direct source modules named by `engine/src/index.ts` resolve to 276 declaration-owning source modules.

For every subsystem batch, the audit checked:

1. **Root ownership and classification.** The exported name, TypeScript kind (`type`, `value`, or `type-and-value`), and public classification are intentional. Experimental declarations are excluded from approvals.
2. **Declaration contract.** The normalized direct declaration and recursively reachable public type closure are externally resolvable. Exact SHA-256 declaration and contract hashes bind the decision to the reviewed shape.
3. **Runtime linkage.** Every value-bearing surface entry is present on the runtime package namespace, while type-only entries do not create runtime exports. `tests/core/runtimeApi.test.ts` enforces this over the complete surface.
4. **Behavioral evidence.** Focused subsystem suites exercise lifecycle, mutation, serialization, determinism, failure, GPU-layout/shader, or integration invariants as appropriate. The approval ledger records repository-relative evidence for each review.
5. **Compatibility decision.** The exposed declaration is accepted as a supported 1.0 candidate. Later signature or transitive-type drift invalidates its exact approval and must be reviewed; approval policy v2 also rejects any newly pending public export.

The audit is declaration-complete and runtime-link-complete. Behavioral tests are intentionally organized around subsystem invariants rather than one artificial test per exported type alias or constant.

## Review batches

| Review | Public approvals | Declaration scope | Principal runtime evidence |
| --- | ---: | --- | --- |
| `animation/1` | 41 | clips, samplers, blend trees, state machines, IK, skinning, assembly, mechanical animation | animation and mechanical-animation suites |
| `animation/2` | 2 | morph-weight sampling and animation bindings | animation and glTF scene suites |
| `audio/1` | 121 | sources, systems, resources, spatial/procedural/impact/particle/storm/vehicle/ambience audio | six audio suites |
| `core-errors/1` | 17 | error codes, structured engine errors, assertions, boundaries | core error suite |
| `core-runtime/1` | 78 | capabilities, config, device tiers, engine lifecycle, events, logging, pools, platform probes, snapshots, `VERSION` | runtime API, architecture, device-tier, and snapshot suites |
| `core-tasks/1` | 63 | task protocols, registries, schedulers, worker scope, glTF task handlers | task, worker-bundling, and glTF suites |
| `core-time/1` | 6 | clock configuration, frame timing, fixed-step accumulation | clock, replay, and environment timing suites |
| `debug/1` | 96 | console, profiler/timeline, ECS/GPU/render-graph/particle/environment/terrain/streaming inspectors | twelve focused debug suites |
| `debug/2` | 6 | bounded physics contact-point and normal debug overlay additions | physics debug-draw and Inspector suites |
| `environment/1` | 236 | atmosphere, clouds, cyclones, day/night, fog, lightning, ocean, snow, solar, water, weather, wind | environment, ocean, snow-melt, and storm-realism suites |
| `extensions/1` | 16 | the Forge 1.0 systems, components, importers, terrain generators, materials, physics shapes, debug visualizers, and console commands contract | extension contract, API reference, migration, and runnable example suites |
| `gpu/1` | 64 | constants, formats, layouts, buffer writing, device acquisition, shader cache | GPU fatal/memory and WGSL suites |
| `math/1` | 98 | scalar/vector/matrix/color/geometry/BVH/noise/RNG/deterministic math/transforms | math, deterministic-math, and BVH suites |
| `particles/1` | 89 | layouts, components, emitters, CPU/GPU worlds, shaders, precipitation/lightning/vortex visuals | particle and environment suites |
| `physics/1` | 41 | body/world/system contracts, broad phase, collision, solver, shapes, WASM memory | physics and vehicle-physics suites |
| `population/1` | 53 | scatter, LOD/culling, grass/trees/vegetation, settle, wind sway, population world | population, culling, and vegetation suites |
| `population/2` | 13 | canonical population surface sampling, worker task payloads/results, deterministic task handlers, and resident population raycast metadata | population, task/worker, runtime namespace, and terrain/world suites |
| `rendering/1` | 246 | geometry/material/mesh, clusters/culling, pipelines, graph, renderer, shadows, uniforms, public WGSL | frame, graph, pipeline, shader, culling, shadow, and rendering suites |
| `rendering/2` | 4 | morph-target geometry and stable secondary UV vertex streams | rendering skinning, glTF scene, texture, and WGSL suites |
| `replay/1` | 28 | channel/hash/recording/session contracts | replay and cross-engine replay suites |
| `resources/1` | 66 | IDs/graphs/registries, glTF/KTX2/textures, streaming, hot reload, validation | asset, glTF, resource, streaming, and texture suites |
| `resources/2` | 5 | glTF morph/instancing metadata and injectable Draco/meshopt decoder contracts | glTF decoder, scene, texture, and worker suites |
| `scene/1` | 123 | entity/component stores, spaces, scene/world/systems, serialization and snapshots | ECS, coordinate-space, save, and simulation-snapshot suites |
| `scripting/1` | 35 | script lifecycle, events, coroutines, timers, component/runtime contracts | five scripting suites |
| `terrain/1` | 231 | chunks/cache/LOD, generation/materials/interactions/deformation, tracks, realistic and Mars terrain | nine terrain suites |
| `testing/1` | 16 | supported mock GPU and mock audio helpers | GPU, audio, and runtime namespace suites |
| `ui/1` | 355 | core tree/context, layout/style/input/text/rendering, data binding, widgets, manager, world space | ten UI suites |
| `vehicles/1` | 67 | chassis, drivetrain/electric, tires/ground/loads, damage, rig and vehicle system | four vehicle suites |
| `vehicles/2` | 3 | dynamic chassis options and fixed-step vehicle-system coupling, preserving the kinematic default | vehicle-physics and Mars showcase suites |
| `environment/2` | 55 | planet frames and calendar, globe spin controller, planet weather and polar caps, Mars globe sampler, `PlanetGlobe`, `DustDevilField`, the optional sky aureole lobe and the external sun | planet-orbit and Mars-orbit demo suites |
| **Total** | **2,274** | **848 type, 1,044 value, 391 type-and-value declarations** | **complete namespace linkage plus subsystem suites** |

## Deliberately accepted compatibility costs

Preserving the complete candidate set is a consequential compatibility choice, not a claim that every root name is equally high-level:

- Low-level GPU constants/layout helpers, shader-source constants, diagnostic inspectors, and the mock GPU/audio testing APIs remain supported root contracts.
- Large implementation-rich terrain, environment, rendering, and UI surfaces remain public. Their nested option/state types are part of the transitive contracts captured by the ledger.
- Existing naming, including specialized suffixes and narrowly scoped reset/registration helpers, is accepted rather than renamed or hidden during this audit.
- Mutable engine objects, externally supplied GPU/audio handles, and explicit resource-lifecycle methods remain caller-visible contracts; backend behavior is bounded by the focused evidence and future reference documentation.
- The breadth of 2,274 public approvals increases future semver and deprecation obligations. Policy v2 makes that cost visible by rejecting an unapproved addition or any drift from an approved declaration.

The nine experimental physics exports retain their separate classification and can change without being represented as supported approvals. The Phase 14 population review specifically covers the new public names `GridPopulationSurfaceSampler`, `POPULATION_CHUNK_TASK`, `POPULATION_SURFACE_RESOLUTION`, `POPULATION_TASK_NAMES`, `PopulationChunkTaskEntry`, `PopulationChunkTaskPayload`, `PopulationChunkTaskResult`, `PopulationRaycastInfo`, `PopulationSurfaceGrid`, `executePopulationChunk`, `generatePopulationChunk`, `installPopulationTaskHandlers`, and `transferablesForPopulationChunk`. Their exact declaration and transitive hashes are recorded under `population/2` in the approval ledger. See [`docs/API.md`](API.md) for the current consumer-facing status and the linked 1.0 migration, release, deprecation, extension, and example guidance.
