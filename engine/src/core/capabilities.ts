/**
 * The capability registry — what this build of Forge can actually do, in one machine-readable place.
 *
 * Why it exists (Phase 9.5 / 9.6):
 *  - A green test run proves the tests pass, not that a subsystem is finished. Every claim the docs
 *    make about a subsystem ("terrain LOD", "GPU particles", "clustered lighting") gets a status
 *    here, and `partial` means "implemented but not finished"; the entry names what finishes it.
 *  - `docs/KNOWN-ISSUES.md` links every limitation to an entry in this registry (enforced by
 *    `npm run docs:check` and `tests/capabilities.test.ts`), so a limitation cannot be quietly
 *    dropped, and a limitation whose capability became `verified` cannot be quietly kept.
 *  - Tools and UIs can read `capabilityRegistry.snapshot()` instead of guessing from the version
 *    number: an editor can grey out a "GPU particles" panel because the status says `planned`.
 *
 * Statuses and markers mirror ROADMAP.md's legend exactly, because `tools/docs-check.mjs` compares
 * them against the roadmap's "CURRENT ENGINE STATE" block:
 *
 *  - `verified`   `[x]` implemented, tested, and the tests are named in `evidence`.
 *  - `partial`    `[!]` implemented but requires hardening; `closesWith` names the roadmap work
 *                      that finishes it. The honest detail is in `docs/KNOWN-ISSUES.md`.
 *  - `inProgress` `[~]` being built right now.
 *  - `planned`    `[ ]` designed in the roadmap, not built.
 *  - `deferred`   `[>]` explicitly out of scope for now (roadmap "features to defer").
 *
 * `closesWith` accepts a roadmap item (`"13.5"`) or a whole phase (`"12"`) when the work is spread
 * across the phase rather than owned by one item.
 *
 * This file must stay dependency-free: `tools/docs-check.mjs` loads it in Node, and a worker bundle
 * may read it. It is data, not code.
 */

export type CapabilityStatus = "verified" | "partial" | "inProgress" | "planned" | "deferred";

export interface CapabilityEntry {
  /** Stable id, `area.feature` — referenced from docs/KNOWN-ISSUES.md as `(capability: <id>)`. */
  readonly id: string;
  /** Roadmap phase or item that owns it, e.g. `"4"` or `"9.1"` (or `"10+"` for unscheduled work). */
  readonly phase: string;
  readonly status: CapabilityStatus;
  /** One line a human — or a UI tooltip — can read. */
  readonly summary: string;
  /** Where the claim is checked: test files, tools, docs. Required for `verified`. */
  readonly evidence?: readonly string[];
  /** For `partial`/`inProgress`/`planned`: the roadmap item or phase that closes the gap. */
  readonly closesWith?: string;
  /** Extra honest detail (kept in sync with docs/KNOWN-ISSUES.md). */
  readonly notes?: string;
}

/** Roadmap marker per status — docs-check compares these against ROADMAP.md. */
export const ROADMAP_MARKER: Record<CapabilityStatus, string> = {
  verified: "[x]",
  partial: "[!]",
  inProgress: "[~]",
  planned: "[ ]",
  deferred: "[>]",
};

/** Human labels ROADMAP.md's state block uses next to a marker. */
export const ROADMAP_STATUS_LABEL: Record<CapabilityStatus, string | undefined> = {
  verified: undefined,
  partial: undefined, // the block spells out its own reason for each phase
  inProgress: "IN PROGRESS",
  planned: "NOT STARTED",
  deferred: "DEFERRED",
};

/**
 * Phase-level status. Must equal the markers in ROADMAP.md's "CURRENT ENGINE STATE" block; that is
 * the whole point — the roadmap's summary of the engine cannot drift from the registry.
 */
export const ROADMAP_PHASE_STATUS: Record<string, CapabilityStatus> = {
  "0": "verified",
  "1": "verified",
  "2": "verified",
  "3": "verified",
  "4": "partial",
  "5": "verified",
  "6": "partial",
  "7": "partial",
  "8a": "verified",
  "8b": "verified",
  "9": "inProgress",
  "10+": "planned",
};

const ENTRIES: readonly CapabilityEntry[] = Object.freeze([
  // ---------------------------------------------------------------- core / tooling
  {
    id: "core.engine",
    phase: "1",
    status: "verified",
    summary: "Engine loop, fixed timestep, config resolution, error handling, logging",
    evidence: ["tests/rendering.test.ts", "tests/frame.test.ts"],
  },
  {
    id: "core.ecs",
    phase: "3",
    status: "verified",
    summary: "Hybrid data-oriented ECS: entity lifecycle, component stores, systems, hierarchy",
    evidence: ["tests/ecs.test.ts"],
  },
  {
    id: "core.largeWorldCoordinates",
    phase: "1",
    status: "verified",
    summary: "Double-precision world positions with origin rebasing and pinned entities",
    evidence: ["tests/coordinateSpaces.test.ts", "tests/math.test.ts"],
  },
  {
    id: "core.coordinateSpaces",
    phase: "9.4",
    status: "verified",
    summary: "Formal world/local/render/chunk/terrain coordinate types with conversions",
    evidence: ["tests/coordinateSpaces.test.ts"],
    notes: "docs/COORDINATES.md",
  },
  {
    id: "core.capabilityRegistry",
    phase: "9.5",
    status: "verified",
    summary: "Machine-readable capability status, cross-checked against the roadmap and known issues",
    evidence: ["tests/capabilities.test.ts"],
  },
  {
    id: "core.knownIssueEnforcement",
    phase: "9.6",
    status: "verified",
    summary: "Every known limitation must reference a capability or roadmap item; stale ones fail the docs gate",
    evidence: ["tools/docs-check.mjs", "tests/capabilities.test.ts"],
  },
  {
    id: "testing.testSuiteTypecheck",
    phase: "9.6",
    status: "verified",
    summary: "The test suite is typechecked: vitest only transpiles, so type drift used to be invisible",
    evidence: ["tests/tsconfig.json", "package.json"],
    notes: "npm run typecheck now covers engine, examples and tests; the first run found 37 stale type errors",
  },
  {
    id: "core.ciQualityGate",
    phase: "9.6",
    status: "verified",
    summary: "CI runs typecheck, unit tests, shader validation, architecture and docs gates on every push",
    evidence: [".github/workflows/ci.yml"],
    notes: "The real-WebGPU browser gate is not part of CI — see testing.browserGateInCi",
  },

  // ---------------------------------------------------------------- workers / resources
  {
    id: "workers.scheduler",
    phase: "1",
    status: "verified",
    summary: "Prioritized task scheduler with dedupe, cancellation, timeouts and an inline fallback",
    evidence: ["tests/tasks.test.ts"],
  },
  {
    id: "workers.roundTrip",
    phase: "9.1",
    status: "verified",
    summary: "Tasks execute on real worker threads: results, cancellation, crash recovery, determinism",
    evidence: ["tests/tasks.test.ts", "tests/support/workerThreads.ts"],
  },
  {
    id: "workers.browserThreads",
    phase: "9.1",
    status: "partial",
    summary: "No browser-side worker round-trip is asserted",
    closesWith: "9.1",
    notes: "Node suites drive the same worker scope on node:worker_threads; the demo and the browser gate both run inline",
  },
  {
    id: "workers.terrainGeneration",
    phase: "9.1",
    status: "verified",
    summary: "The full terrain generator pipeline runs in a worker and matches inline generation bit-for-bit",
    evidence: ["tests/tasks.test.ts"],
    notes: "TerrainWorld still generates synchronously; scheduling it through the worker path is 10.2",
  },
  {
    id: "workers.bvhGeneration",
    phase: "9.1",
    status: "verified",
    summary: "Mesh BVH construction runs in a worker, byte-identical to the inline build",
    evidence: ["tests/tasks.test.ts", "tests/bvh.test.ts", "engine/src/math/bvh.ts"],
  },
  {
    id: "assets.meshDecoding",
    phase: "15.1",
    status: "planned",
    summary: "Mesh/asset decoding off the main thread",
    closesWith: "15.1",
    notes: "No glTF/GLB decoder exists yet; the worker harness already supports the decode-handler pattern",
  },
  {
    id: "resources.registry",
    phase: "1",
    status: "verified",
    summary: "Refcounted, deduplicated, budgeted resource registry with leases and disposers",
    evidence: ["tests/resources.test.ts"],
  },
  {
    id: "resources.eviction",
    phase: "9.2",
    status: "verified",
    summary: "LRU eviction under memory pressure, with pinned/in-use safety and re-acquisition",
    evidence: ["tests/resources.test.ts"],
  },
  {
    id: "diagnostics.gpuMemory",
    phase: "9.3",
    status: "verified",
    summary: "Live GPU memory accounting: texture/buffer bytes, pipeline and bind-group counts, transient/pooled/evicted bytes",
    evidence: ["tests/gpuMemory.test.ts"],
  },
  {
    id: "diagnostics.profiler",
    phase: "21.1",
    status: "partial",
    summary: "CPU scope profiler with frame records and EWMAs",
    closesWith: "21.1",
    notes: "No dedicated test suite (tests only construct it as a SystemContext field); no GPU timestamps, no per-pass GPU timing, no profiler UI",
  },
  {
    id: "testing.mockGpu",
    phase: "0",
    status: "verified",
    summary: "Deterministic mock WebGPU device: command log, allocation accounting and leak tracking",
    evidence: ["tests/renderGraph.test.ts", "tests/frame.test.ts", "tests/environment8b.test.ts"],
  },
  {
    id: "testing.realWebGpuGate",
    phase: "2",
    status: "verified",
    summary: "Headless Chromium + SwiftShader gate asserting pixels, passes and zero GPU errors",
    evidence: ["tools/browser-check.mjs"],
  },
  {
    id: "testing.browserGateInCi",
    phase: "28.5",
    status: "planned",
    summary: "The real-WebGPU browser gate running in CI",
    closesWith: "28.5",
    notes: "CI prints that it does not run the browser gate; a green CI run is not a WebGPU validation",
  },
  {
    id: "platform.webkitCompile",
    phase: "28.5",
    status: "partial",
    summary: "Uniform-layout strictness is enforced statically instead of by compiling on WebKit",
    evidence: ["tests/wgsl.test.ts", "tools/wgsl-check.mjs"],
    closesWith: "28.5",
    notes: "No Safari/WebKit build in the sandbox: shaders are validated against WebKit's rules, never compiled by it",
  },
  {
    id: "determinism.simulation",
    phase: "5",
    status: "verified",
    summary: "Fixed-step physics and procedural generation reproduce bit-for-bit across rates and threads",
    evidence: ["tests/physics.test.ts", "tests/terrain.test.ts", "tests/tasks.test.ts"],
  },
  {
    id: "determinism.replay",
    phase: "19.4",
    status: "planned",
    summary: "Input recording, deterministic playback and state hashing",
    closesWith: "19.4",
  },

  // ---------------------------------------------------------------- rendering
  {
    id: "rendering.renderGraph",
    phase: "2",
    status: "verified",
    summary: "Pass validation, dead-pass culling, live-range aliasing, cross-frame texture pooling",
    evidence: ["tests/renderGraph.test.ts", "tests/frame.test.ts"],
  },
  {
    id: "rendering.forwardPipeline",
    phase: "2",
    status: "verified",
    summary: "PBR forward pass with HDR target, bloom chain, tone mapping and cascaded shadow maps",
    evidence: ["tests/frame.test.ts", "tools/browser-check.mjs"],
  },
  {
    id: "rendering.frustumCulling",
    phase: "2",
    status: "verified",
    summary: "CPU frustum culling per batch and per shadow cascade",
    evidence: ["tests/frame.test.ts", "tests/shadows.test.ts"],
  },
  {
    id: "rendering.shadows",
    phase: "2",
    status: "partial",
    summary: "Cascaded directional shadow maps (first shadow-casting directional light only)",
    evidence: ["tests/shadows.test.ts", "tests/frame.test.ts"],
    closesWith: "13.9",
  },
  {
    id: "rendering.shadowCascades",
    phase: "2",
    status: "partial",
    summary: "Per-cascade AABB culling without per-object cascade assignment",
    evidence: ["tests/shadows.test.ts"],
    closesWith: "13.9",
    notes: "A near caster costs up to N shadow draws; stats.shadowsDrawn makes it visible",
  },
  {
    id: "rendering.shadowMemory",
    phase: "2",
    status: "partial",
    summary: "Fixed shadow atlas size (2048² x 3 depth24plus is ~48 MB)",
    evidence: ["tests/shadows.test.ts"],
    closesWith: "13.9",
    notes: "Quality profiles cap the size; there is no adaptive resolution",
  },
  {
    id: "rendering.renderScale",
    phase: "2",
    status: "partial",
    summary: "renderScale applies to the HDR path only; the LDR path always renders at swapchain size",
    evidence: ["tests/frame.test.ts"],
    closesWith: "13",
  },
  {
    id: "rendering.postFxVerification",
    phase: "2",
    status: "partial",
    summary: "Bloom and tone mapping are proven present and directional, not compared against reference images",
    evidence: ["tools/browser-check.mjs"],
    closesWith: "22.2",
  },
  {
    id: "rendering.resourceAliasing",
    phase: "13.2",
    status: "partial",
    summary: "Live-range aliasing is implemented and tested, but the shipped pass set aliases nothing",
    evidence: ["tests/renderGraph.test.ts"],
    closesWith: "13.2",
    notes: "aliasedBytes reads 0 in a normal frame until a depth prepass/SSAO buffer exists",
  },
  {
    id: "rendering.depthPrepass",
    phase: "13.1",
    status: "planned",
    summary: "Depth prepass reused by culling, SSAO, particles, transparency and post",
    closesWith: "13.1",
  },
  {
    id: "rendering.clusteredLighting",
    phase: "13.3",
    status: "planned",
    summary: "Clustered / Forward+ lighting without a fixed CPU light list",
    closesWith: "13.3",
  },
  {
    id: "rendering.gpuCulling",
    phase: "13.5",
    status: "planned",
    summary: "GPU frustum/distance/HiZ culling and visible-object compaction",
    closesWith: "13.5",
  },
  {
    id: "rendering.indirectDraw",
    phase: "13.6",
    status: "planned",
    summary: "GPU-generated indirect draw commands",
    closesWith: "13.6",
  },
  {
    id: "rendering.asyncPipelines",
    phase: "13.7",
    status: "planned",
    summary: "Asynchronous pipeline compilation that never blocks a frame",
    closesWith: "13.7",
  },
  {
    id: "rendering.gpuTiming",
    phase: "13.8",
    status: "planned",
    summary: "Timestamp queries exposing GPU frame/pass/compute times",
    closesWith: "13.8",
    notes: "renderTimeMs is CPU encode time",
  },

  // ---------------------------------------------------------------- terrain
  {
    id: "terrain.generation",
    phase: "4",
    status: "verified",
    summary: "Deterministic procedural terrain: height, craters, erosion, biomes, scatter",
    evidence: ["tests/terrain.test.ts", "tests/realisticTerrain.test.ts"],
  },
  {
    id: "terrain.heightQueries",
    phase: "4",
    status: "verified",
    summary: "Bicubic height/normal sampling and grid-marched raycasts matching the drawn surface",
    evidence: ["tests/terrain.test.ts"],
  },
  {
    id: "terrain.streaming",
    phase: "4",
    status: "partial",
    summary: "Nearest-first chunk streaming bounded by a resident-chunk budget",
    evidence: ["tests/terrain.test.ts"],
    closesWith: "10.7",
    notes: "viewDistance is advisory (the budget caps it); no horizon skirt",
  },
  {
    id: "terrain.lod",
    phase: "4",
    status: "partial",
    summary: "Quadtree LOD selection with geomorph alpha; every chunk is still meshed at full resolution",
    evidence: ["tests/terrain.test.ts"],
    closesWith: "10.1",
    notes: "chunk.lod does not change the generated mesh, so distant chunks cost the same vertices",
  },
  {
    id: "terrain.workerGeneration",
    phase: "10.2",
    status: "partial",
    summary: "Terrain cells can be generated in a worker (tested bit-for-bit); the streaming path does not use it yet",
    evidence: ["tests/tasks.test.ts"],
    closesWith: "10.2",
  },
  {
    id: "terrain.horizonSkirt",
    phase: "10.6",
    status: "planned",
    summary: "Horizon fallback so the loaded disc has no visible edge",
    closesWith: "10.6",
  },
  {
    id: "terrain.materialLayering",
    phase: "10.8",
    status: "planned",
    summary: "Layered terrain materials with macro variation, slope/height blending and micro detail",
    closesWith: "10.8",
  },

  // ---------------------------------------------------------------- physics / vehicles
  {
    id: "physics.rigidBodies",
    phase: "5",
    status: "verified",
    summary: "Fixed-step rigid bodies, pairwise broadphase, sequential impulse solver, friction and restitution",
    evidence: ["tests/physics.test.ts"],
  },
  {
    id: "physics.heightfield",
    phase: "5",
    status: "verified",
    summary: "Box/sphere vs heightfield contacts against the authoritative terrain data",
    evidence: ["tests/physics.test.ts"],
    notes: "Contacts come from a height function, so there are no heightfield triangles to broadphase against",
  },
  {
    id: "physics.ccd",
    phase: "11",
    status: "planned",
    summary: "Continuous collision detection for high-speed impacts",
    closesWith: "11",
    notes: "9.5 lists physics.ccd as an example id; the roadmap schedules no CCD item of its own",
  },
  {
    id: "physics.spatialIndex",
    phase: "9.1",
    status: "partial",
    summary: "A deterministic median-split mesh BVH exists; raycasts, culling and the broadphase do not use it yet",
    evidence: ["tests/bvh.test.ts"],
    closesWith: "13.5",
    notes: "Grid-marched terrain raycasts and the pairwise broadphase still answer queries without it",
  },
  {
    id: "physics.wasmBackend",
    phase: "25.1",
    status: "planned",
    summary: "WASM physics backend behind the same gameplay API",
    closesWith: "25.1",
  },
  {
    id: "vehicles.raycastModel",
    phase: "6",
    status: "verified",
    summary: "Pacejka tires, suspension, engine/gearbox/diff, aero, TC/ABS over a ground query",
    evidence: ["tests/vehicles.test.ts"],
  },
  {
    id: "vehicles.physicsIntegration",
    phase: "11.3",
    status: "partial",
    summary: "The chassis is not a rigid body in the physics world; contact is a height query",
    evidence: ["tests/vehicles.test.ts"],
    closesWith: "11.3",
    notes: "No collision with meshes, props or rigid bodies",
  },
  {
    id: "vehicles.orientation",
    phase: "6",
    status: "partial",
    summary: "Pitch and roll are kinematic rewrites of the axle heights",
    evidence: ["tests/vehicles.test.ts"],
    closesWith: "11.4",
  },
  {
    id: "vehicles.tireModel",
    phase: "6",
    status: "partial",
    summary: "Longitudinal slip is solved, not freely integrated, while the tire can balance the demand",
    evidence: ["tests/vehicles.test.ts"],
    closesWith: "11.7",
  },
  {
    id: "vehicles.transmission",
    phase: "6",
    status: "partial",
    summary: "Reverse is a gear ratio, not a control; the automatic shifts forward gears only",
    evidence: ["tests/vehicles.test.ts"],
    closesWith: "11",
  },
  {
    id: "vehicles.wheelVisuals",
    phase: "16.6",
    status: "planned",
    summary: "Tyre meshes, steered geometry and suspension-arm animation",
    closesWith: "16.6",
  },

  // ---------------------------------------------------------------- particles
  {
    id: "particles.cpuSimulation",
    phase: "7",
    status: "verified",
    summary: "Reference CPU particle simulation: emission, modules, budgets, trails, determinism",
    evidence: ["tests/particles.test.ts"],
  },
  {
    id: "particles.gpuSimulation",
    phase: "12.3",
    status: "partial",
    summary: "Compute integrator reproduces the CPU gravity/drag/life step; no GPU emission or modules",
    evidence: ["tests/particles.test.ts", "tools/browser-check.mjs"],
    closesWith: "12.3",
  },
  {
    id: "particles.fixedStep",
    phase: "7",
    status: "partial",
    summary: "ParticleSystem advances once per frame, not once per physics substep",
    evidence: ["tests/particles.test.ts"],
    closesWith: "12",
  },
  {
    id: "particles.gpuRendering",
    phase: "12.7",
    status: "planned",
    summary: "Particle render-graph passes: billboards, ribbons, mesh particles, soft particles",
    closesWith: "12.7",
    notes: "The demo draws a few hundred boxes; per-particle colour and trails are stored but not drawn",
  },

  // ---------------------------------------------------------------- environment
  {
    id: "environment.atmosphere",
    phase: "8a",
    status: "verified",
    summary: "Solar position, single-scattering sky pass with height fog and a day/night cycle",
    evidence: ["tests/environment.test.ts", "tests/frame.test.ts"],
  },
  {
    id: "environment.skyFogModes",
    phase: "8a",
    status: "partial",
    summary: "Only height fog fogs sky pixels; linear/exp2 fog would erase an infinite path",
    evidence: ["tests/environment.test.ts"],
    closesWith: "17",
    notes: "The planet ground the sky pass draws below the horizon is fogged in every mode",
  },
  {
    id: "environment.skyQuality",
    phase: "8a",
    status: "partial",
    summary: "Sample-count truncation darkens the horizon sky by up to ~35% at quality \"low\"",
    evidence: ["tests/environment.test.ts"],
    closesWith: "17.1",
  },
  {
    id: "environment.sunDisc",
    phase: "8a",
    status: "partial",
    summary: "sunDiscIntensity is a look control, not the sun's physical radiance",
    closesWith: "17",
    notes: "A physically-scaled disc (~14 700x) would bloom the whole frame",
  },
  {
    id: "environment.stormLighting",
    phase: "8b",
    status: "partial",
    summary: "Weather whitens the sky and thickens fog but never dims the directional light",
    evidence: ["tests/environment8b.test.ts"],
    closesWith: "17.4",
  },
  {
    id: "environment.multipleScattering",
    phase: "17.1",
    status: "planned",
    summary: "Multiple-scattering approximation / LUT and a better Mars twilight",
    closesWith: "17.1",
    notes: "Single scattering makes the sky ~3x darker than a real one and the horizon yellow on Earth",
  },
  {
    id: "environment.weather",
    phase: "8b",
    status: "verified",
    summary: "Weather state, fog/sky/turbidity coupling, gust/wind fields, deterministic lightning scheduling",
    evidence: ["tests/environment8b.test.ts"],
  },
  {
    id: "environment.clouds",
    phase: "17.3",
    status: "partial",
    summary: "One noise-shaded cloud deck with no vertical structure and no self-shadowing",
    evidence: ["tests/environment8b.test.ts"],
    closesWith: "17.3",
  },
  {
    id: "environment.water",
    phase: "17.5",
    status: "partial",
    summary: "Gerstner waves with fresnel-mixed horizon tint; no planar reflection, depth absorption or foam",
    evidence: ["tests/environment8b.test.ts"],
    closesWith: "17.5",
  },
  {
    id: "environment.lightning",
    phase: "17.6",
    status: "partial",
    summary: "Deterministic cloud-to-ground bolts with a flash light; strikes are silent and share one light",
    evidence: ["tests/environment8b.test.ts"],
    closesWith: "17.6",
  },
  {
    id: "environment.aerialPerspective",
    phase: "17.2",
    status: "planned",
    summary: "Atmospheric in-scattering applied to scene geometry, not just the sky pass",
    closesWith: "17.2",
  },

  // ---------------------------------------------------------------- world / content
  {
    id: "world.population",
    phase: "14.1",
    status: "planned",
    summary: "Deterministic scatter with instance buffers, GPU LOD/culling and population streaming",
    closesWith: "14.1",
  },
  {
    id: "assets.contentAddressing",
    phase: "15.1",
    status: "planned",
    summary: "Stable asset ids, content hashes and a dependency graph",
    closesWith: "15.1",
  },
  {
    id: "assets.streaming",
    phase: "15.3",
    status: "planned",
    summary: "Async, cancellable, prioritized asset streaming with GPU upload budgeting",
    closesWith: "15.3",
  },
  {
    id: "animation.clips",
    phase: "16.1",
    status: "planned",
    summary: "glTF animation import, clip sampling, state machines, blend trees, IK and GPU skinning",
    closesWith: "16.1",
  },
  {
    id: "scripting.lifecycle",
    phase: "18.1",
    status: "planned",
    summary: "Gameplay script lifecycle, timers, coroutines, typed events and error isolation",
    closesWith: "18.1",
  },
  {
    id: "serialization.scene",
    phase: "19.1",
    status: "planned",
    summary: "Versioned scene/snapshot serialization with migrations",
    closesWith: "19.1",
    notes: "Scene settings already serialize; entities/components/snapshots do not",
  },
  {
    id: "audio.system",
    phase: "20.1",
    status: "deferred",
    summary: "Spatial audio, buses, streaming and simulation-driven mixing",
    closesWith: "20.1",
  },
  {
    id: "editor.tooling",
    phase: "26.1",
    status: "deferred",
    summary: "Editor built exclusively on the public API",
    closesWith: "26.1",
  },
  {
    id: "networking.replication",
    phase: "10+",
    status: "deferred",
    summary: "Multiplayer replication and dedicated servers",
    notes: "The roadmap gates networking behind Phase 29 and schedules no item for it yet",
  },
]);

/**
 * The registry. Frozen: statuses are compile-time facts about a build, not runtime state. A tool
 * that needs data gets `snapshot()` (plain JSON, safe to post to a worker or a UI).
 */
export const capabilityRegistry = Object.freeze({
  /** Every entry, ordered as declared (roughly by subsystem). */
  entries: ENTRIES,
  has(id: string): boolean {
    return ENTRIES.some((e) => e.id === id);
  },
  get(id: string): CapabilityEntry | undefined {
    return ENTRIES.find((e) => e.id === id);
  },
  /** Entries with a given status, or all of them. */
  list(status?: CapabilityStatus): CapabilityEntry[] {
    return status ? ENTRIES.filter((e) => e.status === status) : [...ENTRIES];
  },
  /** Entries that name unfinished work — the registry's honest gap list. */
  gaps(): { id: string; status: CapabilityStatus; closesWith: string | undefined }[] {
    return ENTRIES.filter((e) => e.status !== "verified").map((e) => ({
      id: e.id,
      status: e.status,
      closesWith: e.closesWith,
    }));
  },
  /** Plain-data snapshot for tooling/UIs (JSON.stringify-safe). */
  snapshot(): { phases: Record<string, CapabilityStatus>; entries: CapabilityEntry[] } {
    return { phases: { ...ROADMAP_PHASE_STATUS }, entries: ENTRIES.map((e) => ({ ...e })) };
  },
});

/** Status of one id, `undefined` when unknown (never guess — an unknown id is a bug). */
export function capabilityStatus(id: string): CapabilityStatus | undefined {
  return capabilityRegistry.get(id)?.status;
}

/** Marker ROADMAP.md would print for a status (`[x]`, `[!]`, `[~]`, `[ ]`, `[>]`). */
export function capabilityMarker(status: CapabilityStatus): string {
  return ROADMAP_MARKER[status];
}
