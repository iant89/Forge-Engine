/**
 * The capability registry — what this build of Forge can actually do, in one machine-readable place.
 *
 * Why it exists (Phase 9.5 / 9.6):
 *  - A green test run proves the tests pass, not that a subsystem is finished. Every claim the docs
 *    make about a subsystem ("terrain LOD", "GPU particles", "clustered lighting") gets a status
 *    here, and `partial` means "implemented but not finished"; the entry names what finishes it.
 *  - `docs/KNOWN-ISSUES.md` links every limitation to an entry in this registry (enforced by
 *    `npm run docs:check` and `tests/docs/capabilities.test.ts`), so a limitation cannot be quietly
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
  "4": "verified",
  "5": "verified",
  "6": "verified",
  "7": "verified",
  "8a": "verified",
  "8b": "verified",
  "9": "verified",
  "10": "partial",
  "11": "verified",
  "12": "verified",
  "13": "verified",
  "14": "inProgress",
  "15+": "verified",
  "15.5": "inProgress",
  "16": "inProgress",
  "17": "inProgress",
  "18": "verified",
  "19": "verified",
  "20": "verified",
  "21": "inProgress",
  "22": "inProgress",
  "23": "inProgress",
  "24": "inProgress",
  "25": "inProgress",
  "26": "verified",
  "27": "verified",
};

const ENTRIES: readonly CapabilityEntry[] = Object.freeze([
  // ---------------------------------------------------------------- core / tooling
  {
    id: "core.engine",
    phase: "1",
    status: "verified",
    summary: "Engine loop, fixed timestep, config resolution, error handling, logging",
    evidence: ["tests/rendering/rendering.test.ts", "tests/rendering/frame.test.ts"],
  },
  {
    id: "core.ecs",
    phase: "3",
    status: "verified",
    summary: "Hybrid data-oriented ECS: entity lifecycle, component stores, systems, hierarchy",
    evidence: ["tests/scene/ecs.test.ts"],
  },
  {
    id: "core.largeWorldCoordinates",
    phase: "1",
    status: "verified",
    summary: "Double-precision world positions with origin rebasing and pinned entities",
    evidence: ["tests/scene/coordinateSpaces.test.ts", "tests/math/math.test.ts"],
  },
  {
    id: "core.coordinateSpaces",
    phase: "9.4",
    status: "verified",
    summary: "Formal world/local/render/chunk/terrain coordinate types with conversions",
    evidence: ["tests/scene/coordinateSpaces.test.ts"],
    notes: "docs/COORDINATES.md",
  },
  {
    id: "core.capabilityRegistry",
    phase: "9.5",
    status: "verified",
    summary: "Machine-readable capability status, cross-checked against the roadmap and known issues",
    evidence: ["tests/docs/capabilities.test.ts"],
  },
  {
    id: "core.knownIssueEnforcement",
    phase: "9.6",
    status: "verified",
    summary: "Every known limitation must reference a capability or roadmap item; stale ones fail the docs gate",
    evidence: ["tools/docs-check.mjs", "tests/docs/capabilities.test.ts"],
  },
  {
    id: "testing.testSuiteTypecheck",
    phase: "9.6",
    status: "verified",
    summary: "The test suite is strictly typechecked as well as executed, so test-only type drift cannot hide behind runtime transpilation",
    evidence: ["tests/tsconfig.json", "package.json"],
    notes: "npm run typecheck now covers engine, examples and tests; the first run found 37 stale type errors",
  },
  {
    id: "core.ciQualityGate",
    phase: "9.6",
    status: "verified",
    summary: "CI runs typecheck, unit tests, shader validation, architecture and docs gates on every push",
    evidence: [".github/workflows/ci.yml"],
    notes: "The real-WebGPU gate is a separate advisory job (SwiftShader + a Vulkan loader and ICD) — see testing.browserGateInCi",
  },

  // ---------------------------------------------------------------- workers / resources
  {
    id: "workers.scheduler",
    phase: "1",
    status: "verified",
    summary: "Prioritized task scheduler with dedupe, cancellation, timeouts and an inline fallback",
    evidence: ["tests/core/tasks.test.ts"],
  },
  {
    id: "workers.roundTrip",
    phase: "9.1",
    status: "verified",
    summary: "Tasks execute on real worker threads: results, cancellation, crash recovery, determinism",
    evidence: ["tests/core/tasks.test.ts", "tests/support/workerThreads.ts"],
  },
  {
    id: "workers.browserThreads",
    phase: "9.1",
    status: "verified",
    summary: "The browser module-worker decodes and returns a GLB mesh through TaskScheduler without inline fallback",
    evidence: ["tools/browser-check.mjs", "docs/VERIFICATION.md"],
    notes: "The focused `npm run check:browser:workers` gate checks worker count, completed task, zero inline fallback/failures and decoded triangle contents on Chromium + SwiftShader.",
  },
  {
    id: "workers.browserMarsTerrain",
    phase: "9.1",
    status: "verified",
    summary: "Native browser workers return Mars terrain grids that the showcase uploads into resident tiles",
    evidence: ["tools/browser-check.mjs", "tools/browser-mars-workers.mjs"],
    notes: "check:browser:mars-workers observes actual native Worker task/result messages, pipeline hashes and typed grids; inline fallback cannot pass. The full browser gate includes the same check. Safari/mobile worker loading is not tested.",
  },
  {
    id: "workers.terrainGeneration",
    phase: "9.1",
    status: "verified",
    summary: "The full terrain generator pipeline runs in a worker and matches inline generation bit-for-bit",
    evidence: ["tests/core/tasks.test.ts"],
    notes: "Default worker-entry installs installTerrainTaskHandlers; real-thread tests include analytic Mars with custom planet/site settings and no fallback. Live Stage A buffers remain inline-only.",
  },
  {
    id: "workers.bvhGeneration",
    phase: "9.1",
    status: "verified",
    summary: "Mesh BVH construction runs in a worker, byte-identical to the inline build",
    evidence: ["tests/core/tasks.test.ts", "tests/math/bvh.test.ts", "engine/src/math/bvh.ts"],
  },
  {
    id: "assets.meshDecoding",
    phase: "9.1",
    status: "verified",
    summary: "Core glTF 2.0/GLB triangle mesh accessors decode on TaskScheduler workers and return transferable upload-ready arrays",
    evidence: ["tests/resources/gltf.test.ts", "tests/core/tasks.test.ts", "docs/VERIFICATION.md"],
    notes: "Covers interleaved/sparse accessors, normalized attributes, indices, bounds, nodes/scenes and material factors. Right-handed glTF is mirrored into the engine's left-handed frame at decode (x → -x with winding, tangents, nodes, skins and animation keys; warns once per file; handedness: \"preserve\" opts out; files baked by npm run gltf:fix-handedness carry asset.extras.forgeHandedness and load as-is). Skin import is assets.gltfSkins (16.1a); textures/materials are assets.gltfMaterials (16.1c); the rest (morph/instancing, Draco/meshopt) is tracked separately as assets.gltfAdvanced.",
  },
  {
    id: "assets.gltfSkins",
    phase: "16.1",
    status: "verified",
    summary: "glTF skin import: skins[] (joints, inverse bind matrices, skeleton), node.skin and one JOINTS_0/WEIGHTS_0 set per primitive, decoded on the worker into SkinningVertexData-shaped arrays",
    evidence: ["tests/resources/gltf.test.ts", "tests/tools/gltfStripSkinSets.test.ts"],
    notes: "Phase 16.1a. Validated per the glTF spec (unsigned joint indices in range of every skin using the mesh, float or normalized weights, FLOAT MAT4 inverse bind matrices with at least one per joint, identity when omitted); weights are not renormalized. Extra influence sets (JOINTS_n/WEIGHTS_n, n >= 1) are ignored when every weight is zero and rejected otherwise, because the GPU skinning path takes four; tools/gltf-strip-extra-skin-sets.mjs (npm run gltf:strip-skin-sets) removes them from an asset. Decode only; turning it into a drawn scene is assets.gltfSkinnedScene (16.1f).",
  },
  {
    id: "assets.gltfSkinnedScene",
    phase: "16.1",
    status: "verified",
    summary: "instantiateGltfScene: a decoded glTF becomes node entities (hierarchy + local TRS), skinned renderables bound to joint entities with the inverse bind matrices, and its clips on an AnimationComponent with a rest pose",
    evidence: ["tests/resources/gltfScene.test.ts", "tools/browser-check.mjs", "examples/src/scenes/gltfSkinScene.ts"],
    notes: "Phase 16.1f. Animations are decoded with the mesh (TRS channels, STEP/LINEAR/CUBICSPLINE; morph-weight channels are skipped, sparse animation accessors rejected). Verified on two assets, the Khronos SimpleSkin (CC0) and CesiumMan (CC-BY-4.0, 19 joints) samples: numerically on the mock device and with npm run check:browser:gltf-skin on real Chromium + SwiftShader (no physical GPU). Materials are built from factors, plus baseColor/metallicRoughness/normal maps when a texture set from loadGltfTextures is passed (assets.gltfMaterials, 16.1c); skinned primitives cull against per-frame posed bounds, the union of per-joint bind boxes carried by the live joint matrices (conservative, never smaller than the deformed mesh).",
  },
  {
    id: "assets.gltfMaterials",
    phase: "16.1",
    status: "verified",
    summary: "glTF images/samplers/textures: embedded (bufferView, data URI) and external images decode on the main thread (loadGltfTextures) into sRGB colour / linear data textures that instantiateGltfScene binds as baseColor, emissive, metallicRoughness, normal and occlusion maps with per-texture samplers, plus alpha MASK cutoff",
    evidence: ["tests/resources/gltfTextures.test.ts", "tools/browser-check.mjs", "examples/src/scenes/gltfSkinScene.ts"],
    notes: "Phase 16.1c. Verified on CesiumMan (JPEG base colour, skinned), Perseverance (38 WebP colour/normal/MR textures) and the generated MaterialFeatures.gltf (emissive, occlusion, MASK, clamp/nearest sampler) numerically on the mock device and with npm run check:browser:gltf-skin on Chromium + SwiftShader (per-feature on/off pixel A/B). Not applied: texCoord != 0 (map dropped with a warning; ROADMAP 16.1g), KHR_texture_transform, KTX2/Basis images; MASK cutouts cast full shadows. A failing image warns and leaves its map unbound.",
  },
  {
    id: "assets.gltfAdvanced",
    phase: "16.1",
    status: "planned",
    summary: "Extended glTF import: morph targets, instancing, compressed geometry extensions and skinned-GLB scene assembly",
    closesWith: "16.1",
    notes: "The Phase 9.1 importer deliberately covers static uncompressed triangle geometry and metadata, plus skin decoding since 16.1a (assets.gltfSkins); skinned scene assembly since 16.1f (assets.gltfSkinnedScene); textures/materials since 16.1c (assets.gltfMaterials); morphs, instancing and compression are 16.1b, 16.1d and 16.1e.",
  },
  {
    id: "assets.loaderPreemption",
    phase: "15.3",
    status: "deferred",
    summary: "Preempting arbitrary synchronous asset-loader code after a streaming request starts",
    notes: "JavaScript cannot interrupt synchronous work. The streamer cancels queued requests, signals running loaders and discards cancelled outputs; loader bodies must cooperate. No roadmap item schedules hard preemption.",
  },

  {
    id: "resources.registry",
    phase: "1",
    status: "verified",
    summary: "Refcounted, deduplicated, budgeted resource registry with leases and disposers",
    evidence: ["tests/resources/resources.test.ts"],
  },
  {
    id: "resources.eviction",
    phase: "9.2",
    status: "verified",
    summary: "LRU eviction under memory pressure, with pinned/in-use safety and re-acquisition",
    evidence: ["tests/resources/resources.test.ts"],
  },
  {
    id: "diagnostics.gpuMemory",
    phase: "9.3",
    status: "verified",
    summary: "Live GPU memory accounting: texture/buffer bytes, pipeline and bind-group counts, transient/pooled/evicted bytes",
    evidence: ["tests/gpu/gpuMemory.test.ts"],
  },
  {
    id: "diagnostics.profiler",
    phase: "21.1",
    status: "verified",
    summary: "CPU scope profiler plus asynchronously merged GPU pass samples, frame records, EWMAs, reports, a categorised frame breakdown and a per-frame timeline in the demo's floating panel",
    evidence: [
      "tests/core/frameBreakdown.test.ts",
      "tests/core/frameTimeline.test.ts",
      "tests/examples/profilerPanel.test.ts",
      "tests/examples/profilerTimeline.test.ts",
    ],
    closesWith: "21.1",
    notes: "Systems, scene-object hooks and the asset streamer are categorised scopes; Engine.frameBreakdown() folds them into simulation/physics/terrain/streaming/rendering/particles/scripting/audio plus CPU and GPU frame time, and frameTimeline/layoutTimeline turn the frame history into drawable rectangles. The toolbar Profiler panel is a floating window (drag, corner-grip resize, collapse to a corner icon, dwell-snap docking to a viewport edge, layout persisted) that refreshes the unified CPU/GPU report and redraws the timeline strip at 4 Hz; check:browser:ui drives both with real pointer input on real WebGPU frame records. The strip's own follow-ups (a bounded window with no scrub, a frame-total-only GPU marker) are tracked as diagnostics.frameTimeline.",
  },
  {
    id: "diagnostics.coreBenchmarks",
    phase: "22.1",
    status: "verified",
    summary: "Repeatable core benchmark matrix for 100k ECS entities, math kernels, inline task scheduling and resource lifecycle operations",
    evidence: [
      "benchmarks/src/ecs.bench.ts",
      "benchmarks/src/core.bench.ts",
      "benchmarks/run.mjs",
      ".github/workflows/ci.yml",
      "PERFORMANCE.md",
    ],
    notes: "npm run bench executes correctness, work-shape and catastrophe guards in CI; npm run bench -- --json PATH writes the measurements and exact host metadata for historical comparison.",
  },
  {
    id: "diagnostics.benchmarkRegression",
    phase: "22.7",
    status: "inProgress",
    summary: "Versioned machine-readable benchmark snapshots and an audited performance history for automatic regression detection",
    evidence: ["benchmarks/run.mjs", "PERFORMANCE.md"],
    closesWith: "22.7",
    notes: "Snapshot schema v1 records timings, operation counts, guard results and host metadata; the first measured baseline is in PERFORMANCE.md. Stable metric IDs, stored multi-run history and automatic same-host comparisons remain open together with the Phase 22.2-22.6 workload matrix.",
  },
  {
    id: "diagnostics.marsReferenceTelemetry",
    phase: "23",
    status: "inProgress",
    summary: "Versioned Mars reference-slice snapshot and HUD for frame, subsystem, streaming, particle, memory and continuous-traversal telemetry",
    evidence: [
      "tests/examples/marsReferenceTelemetry.test.ts",
      "tests/examples/marsShowcase.test.ts",
      "examples/src/scenes/marsReferenceTelemetry.ts",
      "examples/src/main.ts",
    ],
    closesWith: "23.8",
    notes: "Schema forge.mars-reference/1 aggregates public Engine.stats()/frameBreakdown() data with scene-owned terrain, particle and traversal counters. GPU time is null/n/a without resolved timestamp queries, GPU bytes do not double-count graph pools, and moving-time terrain gaps plus discontinuities remain visible. Focused tests are present; a real-browser contract assertion and sustained traversal thresholds/logging remain before this becomes a completed validation gate.",
  },
  {
    id: "diagnostics.frameTimeline",
    phase: "21.1",
    status: "partial",
    summary: "The frame history as drawable rectangles: self-time attribution with inherited categories, a rolling category-stacked band, and a lane chart of one frame's scopes",
    evidence: ["tests/core/frameTimeline.test.ts", "tests/examples/profilerTimeline.test.ts"],
    closesWith: "21.1",
    notes: "The model and layout are engine API (engine/src/debug/frameTimeline.ts) and the demo paints them into a canvas in the Profiler panel: hover a column to select that frame, tap to pin it. What remains is interaction depth rather than correctness — the window is the last 180 frames with no scrub or zoom, the GPU marker is the frame total only (per-pass GPU times stay in the text report), and columns carry category colours only while the profiler collects slices (detailed, on when gpuTimestamps is). Without slices a column is still the frame's CPU time, drawn as `other`.",
  },
  {
    id: "diagnostics.ecsInspector",
    phase: "21.2",
    status: "verified",
    summary: "Bounded read-only ECS snapshots of system order, entity hierarchy, component populations and scalar component fields, browsable in the demo's Inspector window",
    evidence: ["tests/core/ecsInspector.test.ts", "tests/examples/inspectorPanel.test.ts", "tools/browser-ui-check.mjs"],
    notes: "The public API is implemented and tested, and the demo browses it: the Inspector window's ECS tab lists entities and component populations with a filter, and selecting an entity shows its hierarchy, transform and scalar component fields. Rows are capped per tab (the filter narrows them) and the pane is read-only — nothing in it edits the world.",
  },
  {
    id: "diagnostics.renderGraphInspector",
    phase: "21.3",
    status: "verified",
    summary: "On-demand render graph snapshot of pass liveness, culling reasons, dependencies, resource live ranges, aliasing and GPU pass timings, browsable in the demo's Inspector window",
    evidence: ["tests/core/renderGraphInspector.test.ts", "tests/examples/inspectorPanel.test.ts", "tools/browser-ui-check.mjs"],
    notes: "The public API is implemented and tested, and the demo browses it: the Inspector window's Graph tab lists executed and culled passes with their reads, writes and dependencies, shows transient/aliased/pooled bytes in its summary, and explains a pass in the detail pane.",
  },
  {
    id: "diagnostics.gpuResourceInspector",
    phase: "21.4",
    status: "verified",
    summary: "Live GPU buffers and textures grouped by label, with byte counts, top allocations, recent churn and GPU object totals, browsable in the demo's Inspector window",
    evidence: ["tests/core/gpuResourceInspector.test.ts", "tests/examples/inspectorPanel.test.ts", "tools/browser-ui-check.mjs"],
    notes: "The device-level allocation list and public summary API are implemented and tested, and the demo browses them: the Inspector window's GPU tab groups live buffers and textures by label with their byte totals, names the largest allocation and reports pipeline/bind-group counts.",
  },
  {
    id: "diagnostics.physicsDebugDraw",
    phase: "21.5",
    status: "partial",
    summary: "Bounded, renderer-independent physics collider wireframes with optional AABBs and velocity vectors, switchable in the demo's Inspector window",
    evidence: ["tests/core/physicsDebugDraw.test.ts", "tests/examples/inspectorPanel.test.ts", "tools/browser-ui-check.mjs"],
    closesWith: "21.5",
    notes: "The public geometry and line-sink APIs are implemented and tested, and the demo browses them: the Inspector window's Physics tab lists bodies (state, sleeping, mass, velocity, bounds) and its overlay checkbox draws the collider wireframes through the renderer each frame. Contact manifolds have no overlay, so two resting bodies show their shapes and not the contacts between them.",
  },
  {
    id: "diagnostics.terrainDebugger",
    phase: "21.6",
    status: "verified",
    summary: "Read-only terrain streaming snapshots and bounded, LOD-coloured chunk-bound debug lines, browsable and switchable in the demo's Inspector window",
    evidence: ["tests/core/terrainDebugger.test.ts", "tests/examples/inspectorPanel.test.ts", "tools/browser-ui-check.mjs"],
    notes: "The public snapshot and debug-line APIs are implemented and tested, and the demo browses them: the Inspector window's Terrain tab lists chunks with state, LOD, geomorph, residency, centre height and bounds, and its overlay checkbox draws the LOD-coloured chunk boxes through the renderer each frame.",
  },
  {
    id: "diagnostics.particleDebugger",
    phase: "21.7",
    status: "partial",
    summary: "Bounded CPU particle samples, emitter configuration, and particle/velocity wireframes with GPU-safe counters, browsable in the demo's Inspector window",
    evidence: ["tests/core/particleDebugger.test.ts", "tests/examples/inspectorPanel.test.ts", "tools/browser-ui-check.mjs"],
    closesWith: "21.7",
    notes: "CPU scene-object and ECS simulations are sampled without mutation and the demo browses them: the Inspector window's Particles tab lists worlds with backend, capacity, alive/emitted counts and steps, shows emitter settings and a bounded sample of particles, and its overlay checkbox draws the particle bounds. GPU worlds report counters and emitter settings only — their particle buffers are not read back, so they have no particle rows or overlay.",
  },
  {
    id: "diagnostics.streamingDebugger",
    phase: "21.8",
    status: "verified",
    summary: "Bounded asset-load and worker-task inventories with scene streaming-owner statistics, browsable in the demo's Inspector window",
    evidence: ["tests/core/streamingDebugger.test.ts", "tests/examples/inspectorPanel.test.ts", "tools/browser-ui-check.mjs"],
    notes: "Payload-free asset/task metadata and scene-owner stats are public, tested and now browsable: the Inspector window's Streaming tab lists in-flight asset loads, background tasks and scene streaming owners with state, priority, age and timing, and one filter narrows all three.",
  },
  {
    id: "diagnostics.environmentDebugger",
    phase: "21.9",
    status: "verified",
    summary: "Read-only environment snapshots for sun, atmosphere, clouds, weather, wind, precipitation, water and lightning, browsable in the demo's Inspector window",
    evidence: ["tests/core/environmentDebugger.test.ts", "tests/examples/inspectorPanel.test.ts", "tools/browser-ui-check.mjs"],
    notes: "The public snapshot and renderer-independent sun/wind/lightning line APIs are implemented, tested and now browsable: the Inspector window's World tab lists sun/atmosphere/clouds/water plus one row per day-night, weather, wind and lightning system, and its overlay checkbox draws the sun and wind lines through the renderer each frame.",
  },
  {
    id: "diagnostics.inspectorPanel",
    phase: "21.10",
    status: "partial",
    summary: "The demo's floating Inspector window: one tab per Phase 21 diagnostic API, with a filter, a summary strip, a detail pane for the selected row and an opt-in debug-line overlay per tab",
    evidence: ["tests/examples/inspectorPanel.test.ts", "tools/browser-ui-check.mjs"],
    closesWith: "21.10",
    notes: "One window (same chrome as the Profiler: drag, corner-grip resize, collapse to a corner icon, dwell-snap docking, persisted layout) with nine tabs — ECS, systems, render graph, GPU, physics, terrain, particles, streaming, world — refreshing at 2 Hz while it is open and costing nothing while it is closed. Rows carry a stable key so a selection survives a refresh by identity rather than position; the detail is computed lazily for the selected row only; the list is rebuilt only when its contents change; a tab whose subsystem is absent reports a note instead of throwing; and overlays are opt-in flags the host's frame loop draws, never the panel. What remains is the rest of the milestone's UI: the window is a single instance showing one tab at a time, it is read-only (it inspects, it does not edit), rows are capped per tab, contact manifolds and GPU particle positions have no overlay, and the console is still an embeddable API with no visible terminal.",
  },
  {
    id: "diagnostics.developerConsole",
    phase: "21.10",
    status: "partial",
    summary: "Safe registered-command console for CPU/GPU profiling, engine statistics, and Phase 21 diagnostic APIs",
    evidence: ["tests/core/developerConsole.test.ts"],
    closesWith: "21.10",
    notes: "The embeddable command model, built-in diagnostics, bounded history/output and tests are implemented; a visible interactive console panel and live frame timeline remain open.",
  },
  {
    id: "testing.mockGpu",
    phase: "0",
    status: "verified",
    summary: "Deterministic mock WebGPU device: command log, allocation accounting and leak tracking",
    evidence: ["tests/rendering/renderGraph.test.ts", "tests/rendering/frame.test.ts", "tests/environment/environment8b.test.ts"],
  },
  {
    id: "testing.realWebGpuGate",
    phase: "2",
    status: "verified",
    summary: "Headless Chromium + SwiftShader gate asserting pixels, passes and zero GPU errors",
    evidence: ["tools/browser-check.mjs"],
  },
  {
    id: "testing.browserProvisioning",
    phase: "2",
    status: "verified",
    summary: "One script provisions the headless browser and the Vulkan ICD the gate needs, and says which",
    evidence: ["scripts/setup-deps.sh", "tools/gpu-env.mjs", "tests/tools/gpuEnv.test.ts"],
    notes: "Installing the loader and a software ICD needs root; without it the script reports the exact command and stays a warning",
  },
  {
    id: "testing.browserGateInCi",
    phase: "28.5",
    status: "partial",
    summary: "The real-WebGPU browser gate runs in CI as an advisory SwiftShader job",
    evidence: [".github/workflows/ci.yml"],
    closesWith: "28.5",
    notes: "It cannot block a merge, a runner without a WebGPU adapter reports \"did not run\", and WebKit/mobile browsers still run nowhere",
  },
  {
    id: "platform.webkitCompile",
    phase: "28.5",
    status: "partial",
    summary: "Uniform-layout strictness is enforced statically instead of by compiling on WebKit",
    evidence: ["tests/rendering/wgsl.test.ts", "tools/wgsl-check.mjs"],
    closesWith: "28.5",
    notes: "No Safari/WebKit build in the sandbox: shaders are validated against WebKit's rules, never compiled by it (the rules now include keeping derivatives in uniform control flow, the failure the Phase 17.3 cloud shader hit on the real adapter)",
  },
  {
    id: "determinism.simulation",
    phase: "5",
    status: "verified",
    summary: "Fixed-step physics and procedural generation reproduce bit-for-bit across rates and threads",
    evidence: ["tests/physics/physics.test.ts", "tests/terrain/terrain.test.ts", "tests/core/tasks.test.ts"],
  },
  {
    id: "determinism.replay",
    phase: "19.4",
    status: "verified",
    summary: "Input recording, deterministic playback and state hashing",
    evidence: ["tests/replay/replay.test.ts", "docs/REPLAY.md"],
    notes: "A replay records the frame schedule as well as input (fixed systems are not interleaved) and starts from the same scene build or from a 19.3 snapshot restored into a fresh one",
  },
  {
    id: "determinism.crossEngine",
    phase: "19.5",
    status: "verified",
    summary: "The same input stream produces identical state hashes in V8 and JavaScriptCore",
    evidence: ["tests/math/detmath.test.ts", "tests/replay/crossEngine.test.ts", "tools/replay-engines.mjs", "docs/REPLAY.md"],
    notes: "Simulation code calls DMath (exact-arithmetic fdlibm) instead of the implementation-approximated Math functions; lint:arch enforces it. check:replay-engines (CI: Node + Bun) replays a committed complete vehicle session, saved mid-run and resumed, to identical hashes. SpiderMonkey is checked by opening replay-verify.html (capability: determinism.firefox).",
  },
  {
    id: "determinism.firefox",
    phase: "19.5",
    status: "deferred",
    summary: "An automated SpiderMonkey (Firefox) run of the cross-engine replay check",
    notes: "No gate runs Firefox. DMath depends only on IEEE-754 arithmetic, which every engine implements exactly, and replay-verify.html checks any browser by hand. No roadmap item schedules a Firefox runner.",
  },
  {
    id: "scheduling.fixedStepInterleaving",
    phase: "19.4",
    status: "deferred",
    summary: "Interleaving fixed-step systems step by step within a frame",
    notes: "Each FixedSystem runs all of a frame's steps before the next system runs its own, so the same steps grouped into different frames give a different result. Replays record the frame schedule for this reason; no roadmap item changes the scheduler.",
  },

  // ---------------------------------------------------------------- rendering
  {
    id: "rendering.renderGraph",
    phase: "2",
    status: "verified",
    summary: "Pass validation, dead-pass culling, live-range aliasing, cross-frame texture pooling",
    evidence: ["tests/rendering/renderGraph.test.ts", "tests/rendering/frame.test.ts"],
  },
  {
    id: "rendering.forwardPipeline",
    phase: "2",
    status: "verified",
    summary: "PBR forward pass with HDR target, bloom chain, tone mapping and cascaded shadow maps",
    evidence: ["tests/rendering/frame.test.ts", "tools/browser-check.mjs"],
  },
  {
    id: "rendering.frustumCulling",
    phase: "2",
    status: "verified",
    summary: "CPU frustum culling per batch and per directional cascade, spot or point-face shadow map",
    evidence: ["tests/rendering/frame.test.ts", "tests/rendering/shadows.test.ts"],
  },
  {
    id: "rendering.shadows",
    phase: "2",
    status: "verified",
    summary: "Priority-selected directional cascades plus up to four spot maps and two six-face point cubes at adaptive, memory-budgeted shared resolution, with opt-in contact shadows",
    evidence: ["tests/rendering/shadows.test.ts", "tests/rendering/frame.test.ts", "tests/rendering/wgsl.test.ts", "tools/browser-check.mjs"],
    closesWith: "13.9",
  },
  {
    id: "rendering.shadowCascades",
    phase: "2",
    status: "verified",
    summary: "Per-object conservative masks and shared GPU per-instance caster lists across cascade, spot and point-face passes",
    evidence: ["tests/rendering/shadows.test.ts", "tests/rendering/frame.test.ts"],
    closesWith: "13.9",
    notes: "Casters whose bounds overlap multiple cascade/spot/point-face frusta submit to each assigned map; ordinary instanced batches and population batches use forge.populationCull.views to append per-map indices on the device, with the CPU range path as fallback. shadowInstancesDrawn/cull stats and population shadow counters expose the work.",
  },
  {
    id: "rendering.shadowMemory",
    phase: "2",
    status: "verified",
    summary: "Shadow atlas resolution adapts by powers of two so all cascade, spot, and point-face layers fit a configurable memory budget",
    evidence: ["tests/rendering/shadows.test.ts", "tests/rendering/frame.test.ts"],
    notes: "The default budget is 256 MiB with a 128px floor; quality profiles still cap the requested size before budgeting. Resolution is shared across active layers rather than per-light. settings.shadow.adaptive controls the policy: false retains the requested shared resolution and skips the adaptive budget."
  },
  {
    id: "rendering.contactShadows",
    phase: "13.9",
    status: "verified",
    summary: "Opt-in short-range screen-space contact shadows from a full-resolution prepass-depth resolve, complementary to atlas shadows",
    evidence: ["tests/rendering/frame.test.ts", "tests/rendering/wgsl.test.ts"],
    notes: "settings.shadow.contactShadows controls the pass; contactDistance/contactStrength tune it and RendererOptions.contactShadows can veto it. A neutral r32float fallback keeps the frame layout valid when the effect is off.",
  },
  {
    id: "rendering.renderScale",
    phase: "2",
    status: "verified",
    summary: "renderScale controls HDR and LDR scene/depth resolution with a full-size swapchain resolve",
    evidence: ["tests/rendering/frame.test.ts"],
    notes: "HDR resolves through tonemapping; scaled LDR resolves already-sRGB scene color through a bilinear passthrough post pass without double encoding."
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
    status: "verified",
    summary: "Live-range aliasing in production frames: the SSAO estimate's target is reused for the blurred result",
    evidence: ["tests/rendering/renderGraph.test.ts", "tests/rendering/frame.test.ts", "tools/browser-check.mjs"],
    notes: "aliasedBytes = (w/2)·(h/2)·4 B in every SSAO frame (921,600 B at 1280x720); minimal/low profiles run no SSAO and alias nothing",
  },
  {
    id: "rendering.depthPrepass",
    phase: "13.1",
    status: "verified",
    summary: "Material-aware depth prepass (forge.prepass): eligible opaque, cutout, fading and water depth first; forge.main shades each visible pixel once without re-writing it",
    evidence: ["tests/rendering/frame.test.ts", "tests/rendering/pipeline.test.ts", "tools/browser-check.mjs"],
    notes: "Standard, terrain, skinned and water prepass variants share the forward vertex path where applicable and use the material coverage fragment; real WebGPU frame is pixel-identical with the prepass on or off for eligible surfaces",
  },
  {
    id: "rendering.ssao",
    phase: "13.1",
    status: "verified",
    summary: "Half-resolution SSAO from the prepass depth for perspective and orthographic cameras: estimate, depth-aware separable blur, bilateral upsample into the ambient term",
    evidence: ["tests/rendering/frame.test.ts", "tests/rendering/wgsl.test.ts", "tools/browser-check.mjs"],
    notes: "Orthographic kernels use a constant pixels-per-metre radius and camera-forward view depth; ambient term only, so scenes lit mostly by direct light show little of it",
  },
  {
    id: "rendering.depthReuse",
    phase: "13.1",
    status: "verified",
    summary: "The stored prepass depth feeds SSAO, soft-particle fade, HiZ culling, transparent intersection fading and optional HDR depth-aware post haze",
    evidence: ["tests/rendering/frame.test.ts", "tests/rendering/objectCulling.test.ts", "tests/rendering/wgsl.test.ts"],
    notes: "Transparent and overlay batches remain outside the authoritative prepass, but eligible transparent draws sample the full-resolution r32float resolve for a short intersection fade. HDR frames with non-none fog bind that same resolve to tonemap for an opt-in far-field haze; default no-fog and all LDR frames remain unchanged.",
  },
  {
    id: "rendering.prepassCoverage",
    phase: "13.1",
    status: "verified",
    summary: "Material-aware prepass covers opaque, alpha-cutout, fading and water surfaces; transparent and overlay surfaces remain out by design, and orthographic cameras receive SSAO",
    evidence: ["tests/rendering/frame.test.ts", "tests/rendering/pipeline.test.ts"],
    closesWith: "13.1",
    notes: "Coverage fragments sample the same material alpha inputs as the forward path; water uses its deformed vertex entry. Blended transparent/overlay surfaces still avoid the prepass because their depth is not authoritative.",
  },
  {
    id: "rendering.clusteredLighting",
    phase: "13.3",
    status: "verified",
    summary: "Forward+ lighting: local lights indexed into a 16x8x24 view grid and walked per fragment, so the frame carries 256 lights instead of a fixed 16",
    evidence: ["tests/rendering/clusters.test.ts", "tests/rendering/frame.test.ts", "tests/rendering/wgsl.test.ts", "tools/browser-check.mjs"],
    notes: "docs/RENDERING.md §4b. Pixel-identical with clustering on/off while a scene fits the old list; the demo's 36-lamp rig carries all 40 lights where the uniform list truncated at 16. The fill runs on the device by default (rendering.gpuLightCulling); remaining gaps: rendering.clusterCoverage",
    closesWith: "13.3",
  },
  {
    id: "rendering.gpuLightCulling",
    phase: "13.4",
    status: "verified",
    summary: "The cluster fill is one compute pass (`forge.lights.assign`, <=256 invocations per workgroup x12) with no read-back: prepare and count stay on the CPU, the shader is the CPU fill's byte-for-byte twin",
    evidence: ["tests/rendering/lightCulling.test.ts", "tests/rendering/frame.test.ts", "benchmarks/src/lights.bench.ts", "tools/browser-check.mjs"],
    notes: "docs/RENDERING.md §4c. RendererOptions.lightCulling auto|cpu|gpu, stats.clusterFill, demo ?lightculling=cpu|gpu; check:browser A/Bs the two fills to an identical picture on a real device and pins that the pass returns after a cpu->gpu switch (a disposed culler left referenced silently drops the pass)",
    closesWith: "13.4",
  },
  {
    id: "rendering.clusterCoverage",
    phase: "13+",
    status: "deferred",
    summary: "Clustering is perspective-only: an orthographic frame keeps the fixed 16-entry uniform list, the caps are 256 lights and 32 per cluster (least influential evicted), and the grid's buffers cost ~416 KB resident",
    evidence: ["tests/rendering/clusters.test.ts", "tests/rendering/frame.test.ts"],
    notes: "docs/RENDERING.md §4b, docs/KNOWN-ISSUES.md. Clustering an orthographic camera needs a depth axis the projection does not produce, and the roadmap schedules no work for it; the caps and the resident buffers are design decisions, not pending work",
  },
  {
    id: "rendering.gpuCulling",
    phase: "13.5",
    status: "verified",
    summary: "Object culling on the device: one compute pass (forge.objects.cull) decides one visibility word per batch from the frustum planes, per-batch distance limits and the HiZ pyramid, plus a CPU twin the mock device uses",
    evidence: ["tests/rendering/objectCulling.test.ts", "tests/rendering/frame.test.ts", "tools/browser-check.mjs"],
    notes: "docs/RENDERING.md §4d. RendererOptions.objectCulling auto|cpu|gpu and occlusionCulling, stats.cullTested/cullFrustum/cullDistance/cullOccluded (the device path reports them one frame late, via a map-read copy of the atomic counters). check:browser A/Bs the two cullers to an identical frame on a real device and pins that switching HiZ off never darkens a pixel. The pass also writes the indirect records and the visible list that rendering.indirectDraw consumes",
  },
  {
    id: "rendering.cullCoverage",
    phase: "13.5",
    status: "verified",
    summary: "Per-batch object culling plus shared two-stage per-instance compaction for ordinary static instanced batches and population batches; indirect main and shadow records consume the survivors",
    evidence: ["tests/rendering/objectCulling.test.ts", "tests/rendering/frame.test.ts", "tests/rendering/wgsl.test.ts"],
    notes: "docs/RENDERING.md §4d, §4g and §4h. Generic instanced batches bind a dynamic source window into the frame arena, write batch-local visible/occluded lists and per-map caster indices, and keep the CPU per-batch path as fallback. The 8192-batch object-culler cap and CPU twin's missing HiZ test remain intentional limitations.",
    closesWith: "13.6",
  },
  {
    id: "rendering.indirectDraw",
    phase: "13.6",
    status: "verified",
    summary: "Draws come out of GPU-written indirect records: one 32-byte record per batch, seeded by the CPU with the batch's index window and zeroed in the instance-count word by the cull pass, submitted by forge.main through drawIndexedIndirect/drawIndirect, with a visible-batch compaction list alongside",
    evidence: ["tests/rendering/objectCulling.test.ts", "tests/rendering/frame.test.ts", "tools/browser-check.mjs"],
    notes: "docs/RENDERING.md §4e. RendererOptions.indirectDraws (default on, demo ?indirectdraws=0|1 + setIndirectDraws), stats.indirectDraws plus cullVisible/cullRecordZeroed; RendererOptions.objectCulling stays the A/B. A direct-submission frame writes no record (CULL_FLAG_RECORDS). check:browser pins indirectDraws === batches with the counters' identities on a real device, A/Bs the two submission paths to an identical picture (0 px beyond one level), and drives a 1 m draw distance that makes the device, not the CPU, zero records. Culling the shadow cascades through the same pass and rewriting the instance arena from the compaction list are not done",
    closesWith: "13.6",
  },
  {
    id: "rendering.gpuDrivenWorld",
    phase: "24",
    status: "inProgress",
    summary: "Opt-in device-authoritative world visibility: streamed terrain keeps CPU-rejected bounds in the GPU cull set and optional indirect records, with exact handoff counters in the Mars reference slice",
    evidence: [
      "tests/rendering/frame.test.ts",
      "tests/terrain/terrain.test.ts",
      "tests/examples/marsReferenceTelemetry.test.ts",
      "engine/src/terrain/world.ts",
      "examples/src/scenes/marsReferenceTelemetry.ts",
      "tools/browser-check.mjs",
    ],
    closesWith: "24",
    notes: "Renderable.gpuDrivenVisibility delegates opaque frustum discovery to forge.objects.cull in resolved GPU mode and preserves explicit CPU/auto-mock, layer-mask and transparent fallbacks. Terrain chunks and the horizon apron opt in. Schema forge.gpu-world/1 reports managed batches/instances, CPU-rejected handoffs and recent object/population device counters; the focused Mars browser arm requires a CPU-rejected handoff and an asynchronous device frustum verdict with exact accounting. This is the first 24.1/24.6 slice, not full GPU-driven submission: CPU batch assembly, per-tile prepass/draw calls, the 8192-batch cap, general instance generation, generic instance-arena compaction and particle rendering hardening remain.",
  },
  {
    id: "rendering.asyncPipelines",
    phase: "13.7",
    status: "verified",
    summary: "Asynchronous render-pipeline compilation that never blocks a frame",
    evidence: ["tests/rendering/pipeline.test.ts", "tests/rendering/frame.test.ts"],
    notes: "Renderer stats expose pipelinesPending and pipelineFailures; first-frame misses are skipped and retried without blocking.",
  },
  {
    id: "rendering.gpuTiming",
    phase: "13.8",
    status: "verified",
    summary: "Timestamp queries exposing asynchronous GPU frame/pass/compute/render times",
    evidence: ["tests/rendering/renderGraph.test.ts", "tests/rendering/frame.test.ts"],
    notes: "Supported devices report asynchronously; unsupported devices continue with gpuTimingAvailable=false.",
  },

  // ---------------------------------------------------------------- terrain
  {
    id: "terrain.generation",
    phase: "4",
    status: "verified",
    summary: "Deterministic procedural terrain: height, craters, erosion, biomes, scatter",
    evidence: ["tests/terrain/terrain.test.ts", "tests/terrain/realisticTerrain.test.ts"],
  },
  {
    id: "terrain.heightQueries",
    phase: "4",
    status: "verified",
    summary: "Bicubic height/normal sampling and grid-marched raycasts matching the drawn surface",
    evidence: ["tests/terrain/terrain.test.ts"],
  },
  {
    id: "terrain.streaming",
    phase: "4",
    status: "verified",
    summary: "Priority chunk streaming with memory/generation/upload/visible-chunk budgets",
    evidence: ["tests/terrain/terrain.test.ts"],
    notes: "warmUpChunks elevates generation (one-shot) and upload budgets until the opening disc is resident, so worker demos fill quickly without sync-only warm-up",
  },
  {
    id: "terrain.lod",
    phase: "4",
    status: "verified",
    summary: "Quadtree LOD with real lower-res meshes (33→3), geomorphing in vertex Y, and edge skirts",
    evidence: ["tests/terrain/terrain.test.ts"],
  },
  {
    id: "terrain.workerGeneration",
    phase: "10.2",
    status: "verified",
    summary: "TerrainWorld schedules cell generation through TaskScheduler; default worker entry installs terrain handlers; demos enable workers",
    evidence: ["tests/core/tasks.test.ts", "tests/terrain/terrain.test.ts"],
    notes: "Inline fallback when no scheduler is mounted or syncGeneration is set; mesh upload stays on the main thread",
  },
  {
    id: "terrain.horizonSkirt",
    phase: "10.6",
    status: "verified",
    summary: "Horizon apron around the loaded disc drops below the fog line so the edge is not visible",
    evidence: ["tests/terrain/terrain.test.ts"],
  },
  {
    id: "terrain.marsGeneratorPort",
    phase: "10.9",
    status: "partial",
    summary: "Ported external Mars generator (analytic Stage B + cached erosion) as a size-agnostic TerrainStage",
    evidence: ["tests/terrain/marsTerrain.test.ts", "tests/tools/marsTerrainPlan.test.ts", "tests/examples/marsShowcase.test.ts", "tests/examples/marsGeneratorScene.test.ts", "tests/core/tasks.test.ts", "tools/browser-check.mjs", "tools/browser-mars-workers.mjs"],
    closesWith: "10.9",
    notes:
      "Seamless at any chunkSize/chunkResolution because every vertex is evaluated from its absolute " +
      "direction. Mars Showcase uses the analytic-only port at a surveyed equatorial landing site. " +
      "Analytic cells run in workers; live Stage A fields, mesh building/uploads and missing-cell " +
      "ground queries still run on main. The ~30 MB erosion cache is not hosted, real-cache fidelity " +
      "is unverified. The showcase consumes its four absolute-position splat channels as GPU-blended " +
      "PBR layers; masks agree exactly at vertices shared across terrain LODs. A second demo, " +
      "`?scene=mars-generator`, inspects any site (`?marssite=<preset|lat,lon>`) with the same port; its " +
      "geology is regional, so most sites bake a single dominant channel.",
  },
  {
    id: "terrain.materialLayering",
    phase: "10.8",
    status: "verified",
    summary: "TerrainWorld and Mars Showcase blend four PBR texture-array layers through per-tile height/slope/biome weight maps",
    evidence: ["tests/terrain/terrainMaterials.test.ts", "tests/examples/marsShowcase.test.ts", "examples/src/diag/terrainLayerCheck.ts", "tools/browser-check.mjs"],
    notes: "GPU albedo/normal/MR blending, world-phased UVs and macro/micro variation; masks/materials follow tile lifetime and budgets. Real-GPU pixels pin one-hot channels, linear-light mixtures, PBR map/factor effects and ordinary/prepass parity. Four fixed layers; gates use the cell grid, and the distant horizon apron remains a representative single material.",
  },

  // ---------------------------------------------------------------- physics / vehicles
  {
    id: "physics.rigidBodies",
    phase: "5",
    status: "verified",
    summary: "Fixed-step rigid bodies, deterministic sweep-and-prune broadphase, sequential impulse solver, friction and restitution",
    evidence: ["tests/physics/physics.test.ts"],
  },
  {
    id: "physics.heightfield",
    phase: "5",
    status: "verified",
    summary: "Box/sphere vs heightfield contacts against the authoritative terrain data; PhysicsWorld.setHeightfield + raycast (Phase 11.2)",
    evidence: ["tests/physics/physics.test.ts", "tests/vehicles/vehiclePhysics.test.ts"],
    notes: "Contacts come from a height function, so there are no heightfield triangles to broadphase against",
  },
  {
    id: "physics.ccd",
    phase: "6",
    status: "verified",
    summary: "Deterministic time-of-impact sweeps for high-speed dynamic impacts",
    evidence: ["tests/physics/physics.test.ts"],
    notes: "The JavaScript PhysicsWorld sweeps dynamic spheres and boxes against static or kinematic planes, boxes, spheres and heightfields. Box sweeps use a conservative bounding sphere; dynamic-dynamic and rotational CCD remain outside this slice. The non-executable WASM backend does not provide a solver.",
  },
  {
    id: "physics.backend",
    phase: "11.1",
    status: "verified",
    summary: "PhysicsBackend interface with ForgeJSPhysics (create or adopt/share a PhysicsWorld) and an explicit fail-fast ForgeWasmPhysics seam; PhysicsSystem can adopt the same JS world",
    evidence: ["tests/vehicles/vehiclePhysics.test.ts", "engine/src/physics/backend.ts", "engine/src/physics/system.ts"],
    notes: "Default is single-owner; pass world/backend or ForgeJSPhysics.wrap to share. Pairing Vehicle + ECS without sharing creates two worlds (docs/VEHICLES.md). ForgeWasmPhysics now provisions the Phase 25 state ABI but is not a solver and is never an implicit JS fallback.",
  },
  {
    id: "physics.spatialIndex",
    phase: "9.1",
    status: "verified",
    summary: "Mesh BVH accelerates triangle picking and frustum refinement; deterministic sweep-and-prune reduces rigid-body broadphase pairs",
    evidence: ["tests/math/bvh.test.ts", "tests/scene/ecs.test.ts", "tests/rendering/rendering.test.ts", "tests/physics/physics.test.ts"],
    notes: "PhysicsWorld restores insertion-order pair processing for deterministic contacts. Heightfield raycasts keep their specialized grid marcher; GPU batch visibility still uses conservative bounds.",
  },
  {
    id: "physics.wasmBackend",
    phase: "25.1",
    status: "inProgress",
    summary: "Versioned WebAssembly.Memory physics-state ABI with optional shared seqlock memory and transferable exact state frames; solver module still absent",
    evidence: [
      "engine/src/physics/wasmMemory.ts",
      "engine/src/physics/backend.ts",
      "tests/physics/physics.test.ts",
      "tests/vehicles/vehiclePhysics.test.ts",
    ],
    closesWith: "25.1",
    notes: "WasmPhysicsMemory has a 192-byte world header, fixed 448-byte f64 records, finite-record and host-topology validation, and schema forge.physics-wasm-state/1. ForgeWasmPhysics owns that memory but every gameplay method still fails fast. No WASM narrowphase/solver/integrator, runtime topology command queue, worker ownership protocol, JS/WASM tolerance gate, CCD or performance result exists yet.",
  },
  {
    id: "vehicles.raycastModel",
    phase: "6",
    status: "verified",
    summary: "Pacejka tires, suspension, engine/gearbox/diff, aero, TC/ABS over a ground query",
    evidence: ["tests/vehicles/vehicles.test.ts"],
  },
  {
    id: "vehicles.physicsIntegration",
    phase: "11.3",
    status: "verified",
    summary: "Kinematic chassis collider in the physics world; wheels sample physics ground queries; props collide with the car",
    evidence: ["tests/vehicles/vehiclePhysics.test.ts", "tests/vehicles/vehicles.test.ts"],
  },
  {
    id: "vehicles.orientation",
    phase: "11.4",
    status: "verified",
    summary: "Pitch and roll integrate from suspension reaction torques + geometric spring (no tire pitch/roll moments)",
    evidence: ["tests/vehicles/vehiclePhysics.test.ts", "tests/vehicles/vehicles.test.ts"],
  },
  {
    id: "vehicles.wheelContact",
    phase: "11.5",
    status: "verified",
    summary: "Wheel contact uses physics heightfield/raycast queries sharing the terrain sampler",
    evidence: ["tests/vehicles/vehiclePhysics.test.ts"],
  },
  {
    id: "vehicles.terrainAgreement",
    phase: "11.6",
    status: "verified",
    summary: "Visual terrain height equals collision heightfield equals vehicle contact samples",
    evidence: ["tests/vehicles/vehiclePhysics.test.ts"],
  },
  {
    id: "vehicles.telemetry",
    phase: "11.8",
    status: "verified",
    summary: "Telemetry exposes wheel load, travel, slip, tire force, RPM, gear, omega, contact",
    evidence: ["tests/vehicles/vehiclePhysics.test.ts"],
  },
  {
    id: "vehicles.tireModel",
    phase: "6",
    status: "verified",
    summary: "Torque-integrated wheel angular velocity with Pacejka tire reaction, TC and ABS control",
    evidence: ["tests/vehicles/vehicles.test.ts"],
    notes: "Each contacting wheel integrates I·dω/dt through a backward-Euler/Newton torque step; TC limits drive torque and ABS scales brake torque before integration. The tire curve remains steady-state Pacejka, while wheel speed and slip are dynamic state.",
  },
  {
    id: "vehicles.transmission",
    phase: "6",
    status: "verified",
    summary: "Automatic forward gearbox plus safely interlocked manual F/N/R selection",
    evidence: ["tests/vehicles/vehicles.test.ts", "tests/controls/vehicleTouch.test.ts"],
    notes: "`Vehicle.selectGear` exposes F/N/R, rejects unsafe drive-direction changes above its low-speed threshold, and permits neutral at speed. The playground provides keyboard and touch controls; rejected touch positions are disabled with timed red feedback. Reverse is intentionally manual, as in a real direction selector, rather than part of the forward automatic schedule.",
  },
  {
    id: "animation.mechanical",
    phase: "16.6",
    status: "verified",
    summary: "Mechanical joints driven by machine state: channel-fed rigs of revolute/prismatic/aim joints",
    evidence: ["tests/animation/mechanicalAnimation.test.ts", "tests/examples/mechanicalScene.test.ts"],
    notes: "`MechanicalRig` recomposes `base ∘ motion` from the authored pose each frame (idempotent), clamps to min/max, rate-limits with `slew`, wraps angles and solves aim joints against the live local store so a joint sees the same frame's pose. `MechanicalSystem` (order 310) writes channels from a source, advances and poses. Consumers: the vehicle wheel assembly (`vehicles/wheelRig.ts`) and the Mars rover's robotic arm.",
  },
  {
    id: "vehicles.wheelVisuals",
    phase: "16.6",
    status: "verified",
    summary: "Tyre meshes, steered geometry and suspension-arm animation",
    evidence: ["tests/animation/mechanicalAnimation.test.ts", "tests/examples/mechanicalScene.test.ts", "tools/browser-check.mjs"],
    notes: "The playground (Phase 6) draws a tyre/rim/cleat/nut assembly per corner: a hub carrier riding suspension travel, a knuckle carrying the wheel's own Ackermann angle, an axle rolling at the tire's odometer, and arm/damper links aimed at the hub. `npm run check:browser:mechanical` A/Bs two deterministic wheel poses on a real adapter (2,313/921,600 pixels differ, max 206/255; the rear knuckles hold 0 while the fronts take lock).",
  },

  // ---------------------------------------------------------------- particles
  {
    id: "particles.cpuSimulation",
    phase: "7",
    status: "verified",
    summary: "Reference CPU particle simulation: emission, modules, budgets, trails, determinism",
    evidence: ["tests/particles/particles.test.ts"],
  },
  {
    id: "particles.gpuSimulation",
    phase: "12.3",
    status: "verified",
    summary: "GPU storage + emit + full-sim modules (gravity/drag/turbulence/noise/attractor/velocity/colour/size/rotation); CPU reference keeps gravity/drag/colour/size only",
    evidence: ["tests/particles/particles.test.ts", "tools/browser-check.mjs"],
  },
  {
    id: "particles.fixedStep",
    phase: "7",
    status: "verified",
    summary: "CPU and GPU particle simulation consume the engine's fixed substeps",
    evidence: ["tests/particles/particles.test.ts"],
    notes: "ParticleSystem and ParticleWorld consume fixedSteps × fixedDt alongside physics. GpuParticleWorld carries the same clock into the render graph, encodes one simulation dispatch per substep, skips simulation on zero-step frames, and still culls/renders existing state.",
  },
  {
    id: "particles.gpuRendering",
    phase: "12.7",
    status: "partial",
    summary: "Render-graph particle.sim/sort/render/resolve: billboards, stretched billboards, soft particles and trail ribbons from the GPU buffer",
    evidence: ["tests/particles/particles.test.ts"],
    closesWith: "12.7",
    notes: "Trail ribbons draw from the 4-sample ring via the vertex stage (12.4/12.7); mesh particles deferred. HiZ cull and particle/terrain collision deferred.",
  },

  // ---------------------------------------------------------------- environment
  {
    id: "environment.atmosphere",
    phase: "8a",
    status: "verified",
    summary: "Solar position, single-scattering sky pass with height fog and a day/night cycle",
    evidence: ["tests/environment/environment.test.ts", "tests/rendering/frame.test.ts"],
  },
  {
    id: "environment.skyFogModes",
    phase: "8a",
    status: "partial",
    summary: "Only height fog fogs sky pixels; linear/exp2 fog would erase an infinite path",
    evidence: ["tests/environment/environment.test.ts"],
    closesWith: "17",
    notes: "The planet ground the sky pass draws below the horizon is fogged in every mode",
  },
  {
    id: "environment.skyQuality",
    phase: "8a",
    status: "verified",
    summary: "Profile-tier sampling with a converged 64×32 floor in the optically longest horizon band",
    evidence: ["tests/environment/environment.test.ts", "tools/wgsl-check.mjs"],
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
    status: "verified",
    summary: "Cloud and storm cover attenuate directional and ambient lighting with configurable floors",
    evidence: ["tests/environment/environment8b.test.ts"],
    notes: "WeatherSystem composes attenuation over DayNightCycle output without cumulative dimming, restores undimmed values when disabled, and leaves point/spot lights untouched."
  },
  {
    id: "environment.multipleScattering",
    phase: "17.1",
    status: "verified",
    summary: "Multiple-scattering LUT: the higher orders the sky integral leaves out, on the CPU and the device",
    evidence: ["tests/environment/environment17.test.ts", "tests/rendering/frame.test.ts", "tools/browser-check.mjs"],
    notes:
      "Measured against the sphere mean of the model's own single scattering: within ±5 % in daylight below ~25 km for the device table and ±17 % for the CPU one, within a factor of ~2 through the terminator, exactly zero below a height's horizon. Adds ~1.3x luminance at noon on Earth, ~2.2x at dusk and ~2-5x on Mars; no ground bounce, isotropic higher orders, and the CPU-build field is opt-in (assign it to `AtmosphereModel.multiScattering`).",
  },
  {
    id: "environment.weather",
    phase: "8b",
    status: "verified",
    summary: "Weather state, fog/sky/turbidity coupling, gust/wind fields, deterministic lightning scheduling",
    evidence: ["tests/environment/environment8b.test.ts"],
  },
  {
    id: "environment.clouds",
    phase: "17.3",
    status: "verified",
    summary: "A stack of up to four advected cloud sheets through a slab, shaded by a marched sun-path optical depth that also darkens the scene below, with a per-pixel octave LOD fade",
    evidence: ["tests/environment/environment17_3.test.ts", "tests/environment/environment8b.test.ts", "tools/browser-check.mjs"],
    notes: "The stack's geometry (centres, column weights, drift) is computed on the CPU and uploaded per sheet, so the shader cannot disagree with the CPU twin or the shadow march, and `layers = 1` reproduces the Phase 8b plane exactly. The sheets are horizontal samples through the slab shaded by a marched depth, not a true volumetric march, and the CPU/GPU noise bases differ (Perlin vs value noise): the twins agree on formulas and statistics, never bit-exactly. The fade is a per-pixel Nyquist cut, not a temporal filter — a frozen deck is stable, a drifting one still moves.",
  },
  {
    id: "environment.water",
    phase: "17.5",
    status: "verified",
    summary: "Gerstner/shore water with exact normals; on HDR frames an opt-in screen-space pass adds refraction, Beer-Lambert depth absorption, contact foam/soft edges and SSR reflections",
    evidence: ["tests/environment/environment17_5.test.ts", "tests/environment/ocean.test.ts", "tests/environment/environment8b.test.ts", "tools/browser-check.mjs"],
    notes: "`water.screenSpace` (off | refraction | full, per tier via waterScreenSpaceForTier) defers water out of forge.main into forge.water.grab + forge.water. SSR finds only on-screen content (the sky reflection stands in elsewhere), the low tier keeps the sky-only water, there are no caustics, and the analytic shore bed is still two sinusoids.",
  },
  {
    id: "environment.snowMelt",
    phase: "17.4",
    status: "verified",
    summary: "Energy-balance snow melt (sun, air temperature, surface), per-object snow cover that sheds sheets/clumps/cornices by slope and curvature, and a ground moisture field where meltwater pools and dirt turns to drying mud with lower grip",
    evidence: ["tests/environment/snowMelt.test.ts", "tools/browser-check.mjs"],
  },
  {
    id: "environment.weatherIntegration",
    phase: "17.4",
    status: "verified",
    summary: "Weather drives surface wetness, puddles and snow (shading), vehicle tyre grip, snow/rain particles, visibility, storm audio levels and the sea state",
    evidence: ["tests/environment/environment17_4.test.ts", "tools/browser-check.mjs"],
    notes: "Measured braking from 20 m/s: 19.3 m dry, 25.8 m wet, 35.3 m puddles, 64.6 m snow. Surfaces wet everywhere (no occlusion from cover); weather audio is the 20.6 EnvironmentSoundscape on the ambient bus.",
  },
  {
    id: "environment.lightning",
    phase: "17.6",
    status: "verified",
    summary: "Deterministic HDR bolts with flash lights, weather-driven rates, rolling-sphere high-point attachment and speed-of-sound thunder events",
    evidence: ["tests/environment/environment17_6.test.ts", "tests/environment/environment8b.test.ts", "tests/rendering/wgsl.test.ts", "tools/browser-check.mjs"],
    notes: "Bolt segments use drawEmissiveLine in the HDR scene pass; thunder is queued on the simulated clock at the listener's distance to the channel over speedOfSound(T) and delivered through onThunder.",
  },
  {
    id: "environment.aerialPerspective",
    phase: "17.2",
    status: "verified",
    summary: "Opt-in finite-path atmospheric transmittance and in-scattering on standard and water geometry",
    evidence: ["tests/environment/environment17.test.ts", "tests/environment/environment.test.ts", "tests/rendering/frame.test.ts", "tools/browser-check.mjs"],
    notes: "SceneSkySettings.aerialPerspective defaults off, serializes, maps to perFrame flag bit 6, and is verified by a real-WebGPU geometry A/B; the CPU reference integrates direct and optional multiple scattering.",
  },

  // ---------------------------------------------------------------- world / content
  {
    id: "world.population",
    phase: "14.1",
    status: "verified",
    summary:
      "Deterministic per-chunk scatter into compact SoA instance blocks, drawn as instanced batches with zero ECS entities, following a canonical terrain surface through worker-backed streaming, GPU-selected LOD/culling, and resident population raycasts",
    evidence: ["tests/population/population.test.ts", "tests/population/populationCull.test.ts", "tests/rendering/pipeline.test.ts", "tests/math/math.test.ts", "tests/rendering/primitives.test.ts"],
    notes: "All planned 14.1-14.6 slices and all six 14.2 population types are implemented and verified. Placement uses TerrainWorld's fixed-resolution canonical surface; population.chunk runs the same surface reconstruction and scatter body through TaskScheduler with deterministic inline fallback; PopulationWorld.raycast covers resident geometry-backed instances. Remaining resident-only/query and scheduler fallback boundaries are documented in docs/KNOWN-ISSUES.md § World population.",
  },
  {
    id: "world.interactiveTerrain",
    phase: "15.5",
    status: "inProgress",
    summary: "Near-field physical rocks, pushable and rollable destruction, rover impact response and persistent sand track deformation",
    closesWith: "15.5",
    notes: "Roadmap only: current population objects are render-only instanced batches and terrain is not yet deformable.",
  },
  {
    id: "assets.contentAddressing",
    phase: "15.1",
    status: "verified",
    summary:
      "Stable path/content AssetIds, SHA-256 content hashing, re-acquire invalidation and a cycle-checked dependency graph with eviction safety",
    evidence: ["tests/resources/assetPipeline.test.ts"],
    notes:
      "15.1 + 15.2 behavior is covered on ResourceRegistry: ids/hashes, changed-content events, graph edges, eviction blocking, invalidation propagation and reload dependency updates",
  },
  {
    id: "assets.streaming",
    phase: "15.3",
    status: "verified",
    summary:
      "Frame-driven AssetStreamer with priority admission, concurrency cap, cancellation, estimated-byte upload budget and Engine.step pumping",
    evidence: ["tests/resources/streaming.test.ts", "docs/VERIFICATION.md"],
    notes:
      "The 15.3 scheduler is unit tested and was exercised with live texture uploads on real WebGPU; cancellation of queued work is immediate while running loader bodies cooperate with signals (assets.loaderPreemption is deliberately deferred).",
  },
  {
    id: "assets.hotReload",
    phase: "15.4",
    status: "verified",
    summary: "Staged, validated mesh/texture/material replacement and validated runtime WGSL overrides with pipeline invalidation",
    evidence: ["tests/resources/phase15.test.ts", "tests/rendering/shaderHotReload.test.ts"],
    notes: "Resource values remain live until the swap callback commits; shader overrides reject invalid WGSL before invalidating the last good pipelines. File watching/importer integration is caller-owned.",
  },
  {
    id: "assets.validation",
    phase: "15.5",
    status: "verified",
    summary: "Structured validation for mesh streams, texture limits/formats, material techniques/dependencies and memory budgets",
    evidence: ["tests/resources/phase15.test.ts"],
    notes: "The registry runs descriptor validators before publishing loaded output and disposes rejected values.",
  },
  {
    id: "assets.ktx2",
    phase: "15.6",
    status: "verified",
    summary: "Lazy Basis Universal WASM KTX2 transcoding to device-supported BC7/ASTC/ETC2/RGBA8 or HDR BC6H/RGBA16F, with mip/layer/face upload",
    evidence: ["tests/resources/phase15.test.ts", "docs/VERIFICATION.md"],
    notes: "Real Basis WASM and a real Chromium/SwiftShader BC7 six-mip upload are verified; automatic selection falls back to RGBA for unaligned base dimensions or unavailable compression features.",
  },
  {
    id: "assets.ktx2Volume",
    phase: "15.6",
    status: "deferred",
    summary: "KTX2 3D/volume texture transcoding and upload",
    closesWith: "15.6",
    notes: "The selected Basis JS binding does not expose volume slices; the loader rejects depth-bearing KTX2 files rather than uploading incomplete data.",
  },

  {
    id: "animation.clips",
    phase: "16.1",
    status: "verified",
    summary: "glTF animation import, clip sampling, playback, blending, state machines, blend trees, IK and GPU skinning",
    evidence: [
      "tests/animation/animation.test.ts",
      "tests/resources/gltf.test.ts",
      "tests/animation/animationSkinning.test.ts",
      "tests/rendering/renderingSkinning.test.ts",
      "tests/examples/skinningScene.test.ts",
    ],
    notes: "Clip import, linear/step/cubic sampling, quaternion SLERP, multi-clip NLERP blend and the AnimationSystem (order 300) are implemented. AnimationStateMachine (parameter-driven transitions, crossfade blending, interruptible transitions, priority-sorted evaluation, easeInOut curve) and BlendTree1D/BlendTree2D (1D linear interpolation, 2D bilinear interpolation) are implemented. TwoBoneIK (analytic 2-joint solver with pole target) and FABRIK (iterative N-joint solver with convergence tolerance) are implemented. Joint palette computation (world × inverseBindMatrix, missing-joint fallback) and skinning data validation (weight sum, joint/weight count) are implemented. The GPU path is implemented: JOINTS_0/WEIGHTS_0 upload as a second vertex buffer slot, the renderer fills one mesh-local palette per skinned batch into a single storage arena each frame, and the skinned colour/depth-prepass/shadow variants draw through it; a skinned mesh deforms on a real adapter in the demo (npm run check:browser:skinning A/Bs two poses of the same uploaded vertices: 16,974/921,600 pixels differ in the focused mode and 8,859/468,000 in the full gate, max 211/255, zero GPU errors). Mechanical animation (16.6) landed on top of it: `animation/mechanical.ts` poses rig joints from channels and `MechanicalSystem` (order 310) drives them, with the vehicle wheel assembly and the Mars rover arm as consumers.",
  },
  {
    id: "scripting.lifecycle",
    phase: "18.1",
    status: "verified",
    summary: "Gameplay script lifecycle, timers, coroutines, typed events, error isolation, API boundary and hot reload",
    evidence: [
      "tests/scripting/scriptLifecycle.test.ts",
      "tests/scripting/scriptTimers.test.ts",
      "tests/scripting/scriptCoroutines.test.ts",
      "tests/scripting/scriptEvents.test.ts",
      "tests/scripting/scriptHotReload.test.ts",
      "tests/examples/beaconDefense.test.ts",
      "tests/engine/architecture.test.ts",
      "tools/lint-arch.mjs",
      "docs/SCRIPTING.md",
    ],
    notes: "Phase 18 complete. Script/ScriptComponent/ScriptRuntime run onCreate, onPreUpdate (band 0), onFixedUpdate (band 100, per fixed step), onUpdate (200), onLateUpdate (450) and onDestroy in creation order; 'sim' (fixed-step, deterministic) and 'render' timers and coroutines; typed world/entity events (emit now, post to the next phase); every hook, timer, coroutine step and handler isolated (queued structural changes rolled back, script faulted, clock untouched); ScriptWorld/ScriptEntity types as the API boundary (pinned at compile time); in-place hot reload keeping data and order. Exit criterion: Beacon Defense (?scene=scripting), a whole game built only from scripts, plays, restarts, replays identically across frame splits and hot-reloads.",
  },
  {
    id: "scripting.hookPreemption",
    phase: "18.5",
    status: "deferred",
    summary: "Interrupting a script hook that never returns",
    notes: "JavaScript cannot interrupt synchronous work: error isolation catches throws, not infinite loops. No roadmap item schedules preemption (it would need scripts off the main thread).",
  },
  {
    id: "serialization.scene",
    phase: "19.1",
    status: "verified",
    summary: "Versioned scene saves: entities, components, hierarchy, transforms, environment and terrain settings, with migrations",
    evidence: ["tests/scene/sceneSave.test.ts", "tests/environment/environment.test.ts", "tests/environment/environment8b.test.ts", "docs/SERIALIZATION.md"],
    notes: "Components save by registered name, parents by file key, assets by reference; scene objects carry state via saveState/loadState; unusable content is reported, not dropped silently. Version 1 files migrate (19.2).",
  },
  {
    id: "serialization.snapshots",
    phase: "19.3",
    status: "verified",
    summary: "Simulation snapshots: physics, vehicle, weather and RNG state restored mid-run, bit-for-bit",
    evidence: ["tests/scene/simulationSnapshot.test.ts", "docs/SERIALIZATION.md"],
    notes: "core/snapshot.ts captures object state structurally (exact through JSON); captureSceneSnapshot adds transforms, settings, surface grip, system/component/object hooks and a state hash. A restored vehicle session reaches the uninterrupted run's hash.",
  },
  {
    id: "serialization.closuresAndTransients",
    phase: "19.3",
    status: "deferred",
    summary: "Snapshotting script timers/coroutines/subscriptions and in-flight transients (lightning strikes, pending thunder)",
    notes: "Closures cannot be serialized; scripts re-register them in onCreate, and replays (19.4) start from the beginning, where they are recreated. Transients are visual/audio and their schedule is restored.",
  },
  {
    id: "audio.mixer",
    phase: "20.4",
    status: "verified",
    summary: "Audio buses with live effect racks, anchored volume fades, and a dispose that disconnects every node",
    evidence: ["tests/audio/audioSystem.test.ts", "docs/AUDIO.md"],
    notes: "master → speakers, music/sfx/dialogue/ambient → master, custom child buses; unknown buses are usage errors. Verified on MockAudioContext (graph paths, path gain, automation timelines).",
  },
  {
    id: "audio.voices",
    phase: "20.1",
    status: "verified",
    summary: "Spatial voices: HRTF panner, listener, voice limit with stealing, occlusion (volume and low-pass)",
    evidence: ["tests/audio/audioSystem.test.ts", "docs/AUDIO.md"],
    notes: "Stolen voices fade 10 ms and stop counting at once; occlusion scales the voice's own volume; every fade is an anchored ramp.",
  },
  {
    id: "audio.clips",
    phase: "20.2",
    status: "verified",
    summary: "Clip loading: one request and decode per URL, failures evicted, release and cache statistics",
    evidence: ["tests/audio/audioSystem.test.ts", "docs/AUDIO.md"],
  },
  {
    id: "audio.streaming",
    phase: "20.3",
    status: "verified",
    summary: "Streaming audio from media elements through the buses, with the autoplay policy handled",
    evidence: ["tests/audio/audioSystem.test.ts", "docs/AUDIO.md"],
    notes: "A refused play() leaves the stream blocked; AudioSystem.resume() from a gesture retries it.",
  },
  {
    id: "audio.environmental",
    phase: "20.5",
    status: "verified",
    summary: "Environmental audio: birds with a dawn chorus, crickets at Dolbear's rate, listener context (underwater, indoors) and surroundings-driven reverb",
    evidence: ["tests/audio/ambienceAudio.test.ts", "docs/AUDIO.md"],
    notes: "Ambience is synthesized and driven by plain data (environment/soundInput.ts builds it); there are no positional ambient emitters for rivers or trees and no recorded beds.",
  },
  {
    id: "audio.weather",
    phase: "20.6",
    status: "verified",
    summary: "Weather audio from the weather and the ground: directional wind and gusts, rain coloured by wet ground, puddles and snow cover, roof drumming, snow damping, surf",
    evidence: ["tests/audio/ambienceAudio.test.ts", "docs/AUDIO.md"],
    notes: "The weather, off-road and Alpine demos mix it, vehicles and impacts through the ambient/sfx buses. StormSoundscape remains for the hurricane demo.",
  },
  {
    id: "audio.spatial",
    phase: "20.1",
    status: "verified",
    summary: "Spatial audio: handedness-correct listener and voices, Doppler, air absorption, occlusion, ECS listener/emitters",
    evidence: ["tests/audio/spatialAudio.test.ts", "docs/AUDIO.md"],
    notes: "Engine space is left-handed and Web Audio right-handed; every listener/panner write negates z (before 20.1 the demos' left and right were mirrored). Occlusion is a caller-supplied query (e.g. a physics raycast); there is no geometric reverb or sound propagation around corners.",
  },
  {
    id: "audio.resources",
    phase: "20.2",
    status: "verified",
    summary: "Audio clips as registry resources: shared loads, decoded-byte budget, codec fallback, cancellation, validation, procedural clips, banks",
    evidence: ["tests/audio/audioResources.test.ts", "docs/AUDIO.md"],
    notes: "Clips decode fully into memory; long clips are flagged by validation and belong in AudioSystem.stream (20.3). load/release/clearCache keep the clip contract of audio.clips on top of the registry.",
  },
  {
    id: "audio.vehicle",
    phase: "20.7",
    status: "verified",
    summary: "Vehicle audio driven by the simulation: engine RPM, throttle, load, gear, tyre slip, suspension and terrain",
    evidence: ["tests/audio/vehicleAudio.test.ts", "docs/AUDIO.md"],
    notes: "Read once per presented frame after the step and never written back (a run with audio hashes the same as one without). Plays into any AudioNode (a bus's input, or the destination); the voices are not distance-filtered beyond the optional HRTF panner.",
  },
  {
    id: "audio.impact",
    phase: "20.8",
    status: "verified",
    summary: "Impact and scrape audio from the physics solver's contacts, by material and size",
    evidence: ["tests/audio/impactAudio.test.ts", "docs/AUDIO.md"],
    notes: "PhysicsWorld.contactListener is opt-in and read-only (a world with a listener reaches the identical snapshot); materials live in a WeakMap, not on bodies. Vehicle raycast wheels are not physics contacts — their landings are 20.7's events.",
  },
  {
    id: "audio.particles",
    phase: "20.8",
    status: "verified",
    summary: "Particle audio from a CPU ParticleSimulation: births, bursts, flow and ground hits",
    evidence: ["tests/audio/impactAudio.test.ts", "docs/AUDIO.md"],
  },
  {
    id: "audio.gpuParticles",
    phase: "20.8",
    status: "deferred",
    summary: "Particle audio for GPU particle worlds",
    notes: "GpuParticleWorld keeps particle state on the device; hearing it would need a readback or device-side counters. No roadmap item schedules it.",
  },
  {
    id: "audio.deviceCheck",
    phase: "20.1",
    status: "deferred",
    summary: "A gate that plays the mixer's output on a real device and measures it",
    notes: "The suites prove graph, timing and bookkeeping on a mock context. An OfflineAudioContext render in the browser gate could measure levels; no roadmap item schedules it.",
  },
  {
    id: "api.publicSurface",
    phase: "27.1",
    status: "verified",
    summary: "Root-only @forge/engine API with a complete 2,201-symbol public review and exact-contract drift gates",
    evidence: [
      "engine/api-surface.json",
      "engine/api-approvals.json",
      "tools/api-audit.mjs",
      "tests/tools/apiAudit.test.ts",
      "tests/core/runtimeApi.test.ts",
      "tests/core/errors.test.ts",
      "tests/core/time.test.ts",
      "docs/API.md",
      "docs/API-REVIEW.md",
      "engine/README.md",
      ".github/workflows/ci.yml",
    ],
    notes: "The audit resolves all 2,210 package-root exports through TypeScript, rejects deep package exports and leaked @internal symbols, classifies the nine explained @experimental exports separately, and fingerprints each body-free declaration plus its transitive engine-local dependencies. All 2,201 public candidates have exact approvals across 24 subsystem reviews; approval policy v2 rejects pending additions and stale decisions, and runtime namespace linkage is complete. The consumer docs, extension contract and 1.0.0 release are tracked by api.onePointZero.",
  },
  {
    id: "api.onePointZero",
    phase: "27.2",
    status: "verified",
    summary: "Released Engine API 1.0 with complete reference docs, reviewed examples, migration and compatibility policy, extension contract, and version-consistent package metadata",
    evidence: [
      "docs/API-REFERENCE.md",
      "docs/EXAMPLES.md",
      "docs/MIGRATION-1.0.md",
      "docs/VERSIONING.md",
      "docs/DEPRECATION.md",
      "engine/src/extensions.ts",
      "engine/api-surface.json",
      "engine/api-approvals.json",
      "tests/core/extensions.test.ts",
      "tests/docs/capabilities.test.ts",
      "tests/core/runtimeApi.test.ts",
      "ROADMAP.md",
    ],
    notes: "The package root, engine package, exported VERSION and API snapshot are 1.0.0; the API reference inventory and example files are generated/typechecked, and the 1.0 extension contract covers systems, components, importers, terrain generators, materials, physics shapes, debug visualizers and console commands. Experimental WASM-physics exports remain outside the ordinary stability promise.",
  },
  {
    id: "editor.tooling",
    phase: "26",
    status: "verified",
    summary: "Public-API-only @forge/editor authoring workspace, optional DOM shell, transform gizmo math and specialist panels",
    evidence: [
      "editor/src/session.ts",
      "editor/src/history.ts",
      "editor/src/gizmo.ts",
      "editor/src/panels.ts",
      "editor/src/workspace.ts",
      "editor/src/shell.ts",
      "tests/editor/editor.test.ts",
      "tests/engine/architecture.test.ts",
      "docs/EDITOR.md",
    ],
    closesWith: "26",
    notes: "The workspace supports bounded hierarchy/filter/collapse, multi-selection, copied entity/component inspection, undoable rename/reparent/local-TRS/component-enabled/generic-field edits, registered-component creation, subtree duplication/deletion, world-pose-preserving reparent, deterministic gizmo math, material/terrain/particle authoring, and vehicle/environment/streaming/render-graph/asset/profiler adapters. A host-owned viewport remains intentionally outside the package; the complete Mars exit workflow attaches the workspace to a runtime scene and saves through public APIs. lint:arch and architecture tests enforce that editor imports only @forge/engine and runtime never imports editor.",
  },
  {
    id: "ui.framework",
    phase: "10+",
    status: "verified",
    summary: "Retained-mode UI drawn by the engine: element tree, flex/grid/anchor layout, skins/themes, input/focus/gamepad, widgets, SDF text, binding, declarative UI, WebGPU overlay pass",
    evidence: [
      "tests/ui/uiElement.test.ts",
      "tests/ui/uiLayout.test.ts",
      "tests/ui/uiStyle.test.ts",
      "tests/ui/uiInput.test.ts",
      "tests/ui/uiText.test.ts",
      "tests/ui/uiAnimation.test.ts",
      "tests/ui/uiWidgets.test.ts",
      "tests/ui/uiWidgetsGame.test.ts",
      "tests/ui/uiManager.test.ts",
      "tests/ui/uiGpu.test.ts",
      "tests/examples/uiGallery.test.ts",
      "tools/browser-ui-check.mjs",
      "docs/UI.md",
    ],
    notes: "Unscheduled by the roadmap (no UI phase exists). Limitations in docs/UI.md §11: no bidi/complex shaping, no IME composition, no rotated elements, no screen-reader bridge",
  },
  {
    id: "networking.replication",
    phase: "15+",
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
