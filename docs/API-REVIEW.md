# Phase 27.1 public API review record

This document is the human-readable review record for the `@forge/engine` package-root audit. The exact machine-enforced decisions live in [`engine/api-approvals.json`](../engine/api-approvals.json); the resolved declaration baseline lives in [`engine/api-surface.json`](../engine/api-surface.json).

## Decision and boundary

Phase 27.1 preserves **all 2,171 current public candidates** as supported Engine API 1.0 candidates. Each candidate has an exact approval row bound to its declaration kind, direct declaration hash, transitive contract hash, and one of the subsystem reviews below. The nine exports already marked experimental remain experimental and are not approvals. There are no deprecated exports and no pending public candidates.

This closes only the package-root inventory and compatibility-decision work in Phase 27.1. It does **not** claim that the broader Engine API 1.0 effort is complete. Reference documentation, examples, migration/versioning/deprecation guidance, extension contracts, and the eventual `1.0.0` release remain Phase 27.2–27.7 work. The package and exported `VERSION` therefore remain `0.1.0`.

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
| `audio/1` | 121 | sources, systems, resources, spatial/procedural/impact/particle/storm/vehicle/ambience audio | six audio suites |
| `core-errors/1` | 17 | error codes, structured engine errors, assertions, boundaries | core error suite |
| `core-runtime/1` | 78 | capabilities, config, device tiers, engine lifecycle, events, logging, pools, platform probes, snapshots, `VERSION` | runtime API, architecture, device-tier, and snapshot suites |
| `core-tasks/1` | 63 | task protocols, registries, schedulers, worker scope, glTF task handlers | task, worker-bundling, and glTF suites |
| `core-time/1` | 6 | clock configuration, frame timing, fixed-step accumulation | clock, replay, and environment timing suites |
| `debug/1` | 100 | console, profiler/timeline, ECS/GPU/render-graph/physics/particle/environment/terrain/streaming inspectors | twelve focused debug suites |
| `environment/1` | 236 | atmosphere, clouds, cyclones, day/night, fog, lightning, ocean, snow, solar, water, weather, wind | environment, ocean, snow-melt, and storm-realism suites |
| `gpu/1` | 64 | constants, formats, layouts, buffer writing, device acquisition, shader cache | GPU fatal/memory and WGSL suites |
| `math/1` | 98 | scalar/vector/matrix/color/geometry/BVH/noise/RNG/deterministic math/transforms | math, deterministic-math, and BVH suites |
| `particles/1` | 86 | layouts, components, emitters, CPU/GPU worlds, shaders, precipitation/lightning/vortex visuals | particle and environment suites |
| `physics/1` | 41 | body/world/system contracts, broad phase, collision, solver, shapes, WASM memory | physics and vehicle-physics suites |
| `population/1` | 53 | scatter, LOD/culling, grass/trees/vegetation, settle, wind sway, population world | population, culling, and vegetation suites |
| `rendering/1` | 243 | geometry/material/mesh, clusters/culling, pipelines, graph, renderer, shadows, uniforms, public WGSL | frame, graph, pipeline, shader, culling, shadow, and rendering suites |
| `replay/1` | 28 | channel/hash/recording/session contracts | replay and cross-engine replay suites |
| `resources/1` | 66 | IDs/graphs/registries, glTF/KTX2/textures, streaming, hot reload, validation | asset, glTF, resource, streaming, and texture suites |
| `scene/1` | 123 | entity/component stores, spaces, scene/world/systems, serialization and snapshots | ECS, coordinate-space, save, and simulation-snapshot suites |
| `scripting/1` | 35 | script lifecycle, events, coroutines, timers, component/runtime contracts | five scripting suites |
| `terrain/1` | 231 | chunks/cache/LOD, generation/materials/interactions/deformation, tracks, realistic and Mars terrain | nine terrain suites |
| `testing/1` | 16 | supported mock GPU and mock audio helpers | GPU, audio, and runtime namespace suites |
| `ui/1` | 355 | core tree/context, layout/style/input/text/rendering, data binding, widgets, manager, world space | ten UI suites |
| `vehicles/1` | 70 | chassis, drivetrain/electric, tires/ground/loads, damage, rig and vehicle system | four vehicle suites |
| **Total** | **2,171** | **791 type, 998 value, 382 type-and-value declarations** | **complete namespace linkage plus subsystem suites** |

## Deliberately accepted compatibility costs

Preserving the complete candidate set is a consequential compatibility choice, not a claim that every root name is equally high-level:

- Low-level GPU constants/layout helpers, shader-source constants, diagnostic inspectors, and the mock GPU/audio testing APIs remain supported root contracts.
- Large implementation-rich terrain, environment, rendering, and UI surfaces remain public. Their nested option/state types are part of the transitive contracts captured by the ledger.
- Existing naming, including specialized suffixes and narrowly scoped reset/registration helpers, is accepted rather than renamed or hidden during this audit.
- Mutable engine objects, externally supplied GPU/audio handles, and explicit resource-lifecycle methods remain caller-visible contracts; backend behavior is bounded by the focused evidence and future reference documentation.
- The breadth of 2,171 public approvals increases future semver and deprecation obligations. Policy v2 makes that cost visible by rejecting an unapproved addition or any drift from an approved declaration.

The nine experimental physics exports retain their separate classification and can change without being represented as supported approvals. See [`docs/API.md`](API.md) for the current consumer-facing status and the remaining Phase 27 work.
