/**
 * test-subsystems.mjs — the machine-readable map from source to tests (Phase 9 hardening).
 *
 * `npm test` runs every suite. That is the right thing for a merge to `main`, but for a one-file
 * change it re-runs 500 tests to prove that a shader tweak did not break the vehicle solver. This
 * module is the single source of truth that lets `tools/affected-tests.mjs` run only the suites a
 * change can actually reach — and lets `tests/subsystems.test.ts` prove the map has not gone stale.
 *
 * Why a hand-written manifest and not an import graph? Every suite imports the public barrel
 * `@forge/engine` (AGENTS.md §3: "Public API only from the demo/tests"), so a static import graph
 * cannot tell the rendering tests apart from the physics tests — they all import the same file.
 * Ownership is therefore declared here, in the repository's registry style (cf. `capabilities.ts`,
 * `lint-arch.mjs`), and guarded by a drift test so it cannot silently rot: every suite must be
 * claimed exactly once, every top-level `engine/src` directory must be owned, and every declared
 * path and dependency must resolve.
 *
 * The model:
 *   - Each SUBSYSTEM owns a set of source paths and a set of test suites.
 *   - `deps` records which other subsystems a subsystem is *built upon* (derived from the real
 *     relative imports in `engine/src`, runtime only — type-only edges are a typecheck concern, and
 *     typecheck always runs in full). A change to X therefore selects X and everyone who transitively
 *     depends on X (its dependents), because those are the suites the change can reach.
 *   - `foundation: true` marks a layer everything rests on (core, math). A change there is not worth
 *     reasoning about selectively: it selects the full suite. Same for FULL_TRIGGERS below.
 *   - SMOKE_TESTS always run, on every selection, as a cheap floor of confidence.
 *
 * Kept dependency-light on purpose (only `node:fs`/`node:path`, used by the tree helpers) so the
 * vitest drift test can import it directly.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The subsystem manifest. Keys are stable ids used on the command line (`--only rendering`).
 *
 * `src`   — path prefixes (posix, repo-relative) whose files belong to this subsystem.
 * `tests` — the suites that exercise it (repo-relative).
 * `deps`  — subsystems this one is built upon (see the real edges in `engine/src`).
 */
export const subsystems = {
  // ---- foundation: a change here reaches everything, so it selects the full suite ----
  math: {
    title: "Math (vec/mat/quat, geometry, BVH, noise, rng)",
    src: ["engine/src/math"],
    tests: ["tests/math.test.ts", "tests/bvh.test.ts"],
    deps: [],
    foundation: true,
  },
  core: {
    title: "Core (engine loop, config, time, events, tasks, profiler)",
    // debug/ (the profiler) threads through core and every system that instruments itself; it rides
    // with core rather than earning a subsystem of its own.
    src: ["engine/src/core", "engine/src/debug"],
    tests: ["tests/tasks.test.ts", "tests/workerBundling.test.ts"],
    deps: ["math"],
    foundation: true,
  },

  // ---- leaf and mid layers: the selective win lives here ----
  gpu: {
    title: "GPU device, buffer/struct writers, formats, shader cache",
    src: ["engine/src/gpu"],
    tests: ["tests/gpuMemory.test.ts"],
    deps: ["core", "math"],
  },
  resources: {
    title: "Resource registry, textures, mip generation",
    src: ["engine/src/resources"],
    tests: ["tests/resources.test.ts", "tests/textureMips.test.ts"],
    deps: ["core", "gpu", "math"],
  },
  scene: {
    title: "Scene / ECS (entity world, component stores, coordinate spaces)",
    src: ["engine/src/scene"],
    tests: ["tests/ecs.test.ts", "tests/coordinateSpaces.test.ts"],
    deps: ["core", "math"],
  },
  environment: {
    title: "Environment (sun, sky, fog, day/night, weather, water)",
    src: ["engine/src/environment"],
    tests: ["tests/environment.test.ts", "tests/environment8b.test.ts"],
    deps: ["math", "scene"],
  },
  particles: {
    title: "Particles (CPU simulation + compute integrator, trails)",
    src: ["engine/src/particles"],
    tests: ["tests/particles.test.ts"],
    deps: ["gpu", "math", "rendering", "scene"],
  },
  rendering: {
    title: "Renderer, render graph, shadows, clustered lighting, pipeline, primitives, WGSL",
    src: ["engine/src/rendering"],
    tests: [
      "tests/rendering.test.ts",
      "tests/renderGraph.test.ts",
      "tests/frame.test.ts",
      "tests/pipeline.test.ts",
      "tests/shadows.test.ts",
      "tests/clusters.test.ts",
      "tests/lightCulling.test.ts",
      "tests/primitives.test.ts",
      "tests/wgsl.test.ts",
    ],
    deps: ["core", "environment", "gpu", "math", "particles", "resources", "scene"],
  },
  physics: {
    title: "Physics (fixed-step rigid bodies, broad/narrowphase, solver)",
    src: ["engine/src/physics"],
    tests: ["tests/physics.test.ts"],
    deps: ["core", "math", "scene", "vehicles"],
  },
  vehicles: {
    title: "Vehicles (Pacejka, drivetrain, electric motor, ground query)",
    src: ["engine/src/vehicles"],
    tests: [
      "tests/vehicles.test.ts",
      "tests/vehiclePhysics.test.ts",
      "tests/electricMotor.test.ts",
    ],
    deps: ["math", "physics", "scene"],
  },
  terrain: {
    title: "Terrain (chunks, heightmaps, LOD, streaming, generators)",
    src: ["engine/src/terrain"],
    tests: ["tests/terrain.test.ts", "tests/realisticTerrain.test.ts"],
    deps: ["core", "gpu", "math", "rendering", "scene"],
  },

  // ---- integration + tooling ----
  // The demo used to be one `examples` subsystem depending on the whole engine. It is split by scene
  // so a leaf engine change pulls only the demo pieces it can actually reach. The touch controls are
  // pure UI state machines (they import nothing from `@forge/engine`), so their suites depend on
  // nothing and run only when their own source changes — an engine change cannot break them.
  "ex-ui": {
    title: "Demo touch controls & scene selector (examples) — pure UI, no engine coupling",
    src: [
      "examples/src/controls/armTouch.ts",
      "examples/src/controls/skyTouch.ts",
      "examples/src/controls/toolbarMenu.ts",
      "examples/src/controls/vehicleTouch.ts",
      "examples/src/sceneSelection.ts",
    ],
    tests: [
      "tests/armTouch.test.ts",
      "tests/skyTouch.test.ts",
      "tests/toolbarMenu.test.ts",
      "tests/vehicleTouch.test.ts",
      "tests/demoSceneSelection.test.ts",
    ],
    deps: [],
  },
  "ex-weather": {
    title: "Weather HUD controls (examples) — driven by the environment API",
    src: ["examples/src/controls/weatherTouch.ts"],
    tests: ["tests/weatherTouch.test.ts"],
    deps: ["environment"],
  },
  "ex-rover": {
    title: "Rover arm kinematics + Perseverance GLB parsing (examples) — self-contained",
    src: [
      "examples/src/scenes/roverArm.ts",
      "examples/src/assets/glb.ts",
      "examples/assets", // the Perseverance.glb the roverGlb suite parses off disk
    ],
    tests: ["tests/roverArm.test.ts", "tests/roverGlb.test.ts"],
    deps: [],
  },
  "ex-antenna": {
    title: "High-gain antenna gimbal tracking (examples)",
    src: ["examples/src/scenes/highGainAntenna.ts"],
    tests: ["tests/highGainAntenna.test.ts"],
    deps: ["scene"],
  },
  "ex-orbit": {
    title: "Orbit camera controls + the demo scenes it assembles (examples) — integration",
    // orbitControls.test drives real scenes (mars showcase, terrain), and the mars showcase in turn
    // assembles the rover, antenna and touch UI. So this subsystem owns the shared demo scaffolding
    // and depends both on the broad engine and on the other example subsystems it pulls in.
    src: [
      "examples/src/controls/orbitControls.ts",
      "examples/src/main.ts",
      "examples/src/diag",
      "examples/src/textures",
      "examples/src/scenes/cubesScene.ts",
      "examples/src/scenes/pbrScene.ts",
      "examples/src/scenes/particleScene.ts",
      "examples/src/scenes/skyScene.ts",
      "examples/src/scenes/weatherScene.ts",
      "examples/src/scenes/terrainScene.ts",
      "examples/src/scenes/realisticTerrainScene.ts",
      "examples/src/scenes/vehiclePlaygroundScene.ts",
      "examples/src/scenes/marsShowcaseScene.ts",
    ],
    tests: ["tests/orbitControls.test.ts"],
    deps: [
      "ex-ui",
      "ex-rover",
      "ex-antenna",
      "scene",
      "rendering",
      "terrain",
      "environment",
      "vehicles",
      "particles",
      "resources",
      "gpu",
    ],
  },
  docs: {
    title: "Documentation honesty (capability registry ↔ roadmap ↔ known issues)",
    // The docs:check gate reads capabilities/roadmap/known-issues; the rest are prose that no test
    // depends on, but routing them here keeps a docs-only edit to the (fast) honesty suite + smoke
    // instead of falling through to a full run.
    src: [
      "engine/src/core/capabilities.ts",
      "ROADMAP.md",
      "docs",
      "AGENTS.md",
      "ARCHITECTURE.md",
      "README.md",
      "mnemosyne.md",
      "change-log.md",
    ],
    tests: ["tests/capabilities.test.ts"],
    deps: [],
  },
  gpuenv: {
    title: "GPU environment provisioning (tools/gpu-env.mjs, setup script)",
    src: ["tools/gpu-env.mjs", "scripts/setup-deps.sh"],
    tests: ["tests/gpuEnv.test.ts"],
    deps: [],
  },
};

/**
 * Always-run smoke floor: the fundamentals that catch broad breakage cheaply. `architecture` is a
 * global import-boundary guard owned by nothing else, so it lives here and only here.
 */
export const SMOKE_TESTS = [
  "tests/math.test.ts",
  "tests/ecs.test.ts",
  "tests/renderGraph.test.ts",
  "tests/frame.test.ts",
  "tests/architecture.test.ts",
  // The selection map's own drift guard rides with the smoke floor: it must run on every selection,
  // so a stale map is caught even on the narrowest affected run.
  "tests/subsystems.test.ts",
];

/**
 * Repo-relative path prefixes that force a full run when touched: the build/test config, the public
 * barrel, the strict mock device every suite loads, shared test helpers, and the selection tooling
 * itself. Changing any of these can invalidate the assumptions selection is built on.
 */
export const FULL_TRIGGERS = [
  "package.json",
  "package-lock.json",
  "tsconfig.base.json",
  "vitest.config.ts",
  "vitest.gpu.config.ts",
  "engine/tsconfig.json",
  "examples/tsconfig.json",
  "tests/tsconfig.json",
  "engine/src/index.ts",
  "engine/src/testing",
  "tests/support",
  "tools/test-subsystems.mjs",
  "tools/affected-tests.mjs",
  ".github/workflows/ci.yml",
];

// --------------------------------------------------------------------------- pure helpers

/** Normalize a path to posix, repo-relative form. */
export function toRepoRelative(p) {
  const abs = path.isAbsolute(p) ? p : path.join(repoRoot, p);
  return path.relative(repoRoot, abs).split(path.sep).join("/");
}

/** True when `file` is inside (or equal to) the prefix `dir`, both posix repo-relative. */
function underPrefix(file, prefix) {
  const f = file.replace(/\/+$/, "");
  const p = prefix.replace(/\/+$/, "");
  return f === p || f.startsWith(`${p}/`);
}

/** Does this changed file force a full run on its own? */
export function isFullTrigger(file) {
  const rel = toRepoRelative(file);
  return FULL_TRIGGERS.some((prefix) => underPrefix(rel, prefix));
}

/** All suites known to the manifest (subsystem-owned + smoke), de-duplicated and sorted. */
export function allTestFiles() {
  const set = new Set(SMOKE_TESTS);
  for (const s of Object.values(subsystems)) for (const t of s.tests) set.add(t);
  return [...set].sort();
}

/**
 * Which subsystems claim a changed file. A file may belong to more than one (e.g. `capabilities.ts`
 * is both `core` source and a `docs` honesty input); the union is the safe answer for selection.
 * Returns [] for files no subsystem owns (the caller decides that means "full", conservatively).
 */
export function classifyFile(file) {
  const rel = toRepoRelative(file);
  const hits = new Set();
  for (const [id, s] of Object.entries(subsystems)) {
    if (s.tests.includes(rel)) hits.add(id);
    if (s.src.some((prefix) => underPrefix(rel, prefix))) hits.add(id);
  }
  return [...hits];
}

/** Reverse-dependency closure: every subsystem that transitively depends on any seed subsystem. */
export function dependentsOf(seedIds) {
  // Build the reverse graph: dep -> [subsystems that list it in `deps`].
  const dependents = new Map();
  for (const id of Object.keys(subsystems)) dependents.set(id, []);
  for (const [id, s] of Object.entries(subsystems)) {
    for (const dep of s.deps) {
      if (!dependents.has(dep)) continue;
      dependents.get(dep).push(id);
    }
  }
  const affected = new Set(seedIds);
  const queue = [...seedIds];
  while (queue.length) {
    const current = queue.shift();
    for (const dependent of dependents.get(current) ?? []) {
      if (!affected.has(dependent)) {
        affected.add(dependent);
        queue.push(dependent);
      }
    }
  }
  return affected;
}

/**
 * The core decision. Given a list of changed files (repo-relative or absolute), return:
 *   { full: boolean, reason: string, subsystems: string[], testFiles: string[] }
 *
 * `full` means "run everything"; `testFiles` is still populated (all suites) so callers can print it.
 */
export function selectForChanges(changedFiles) {
  const files = changedFiles.map(toRepoRelative).filter(Boolean);

  if (files.length === 0) {
    return {
      full: false,
      reason: "no changed files detected — running the smoke floor only",
      subsystems: [],
      testFiles: [...SMOKE_TESTS].sort(),
    };
  }

  const triggers = files.filter(isFullTrigger);
  if (triggers.length > 0) {
    return {
      full: true,
      reason: `full-run trigger touched: ${triggers.slice(0, 5).join(", ")}${triggers.length > 5 ? " …" : ""}`,
      subsystems: Object.keys(subsystems),
      testFiles: allTestFiles(),
    };
  }

  const seeds = new Set();
  const unowned = [];
  for (const file of files) {
    const owners = classifyFile(file);
    if (owners.length === 0) unowned.push(file);
    else for (const o of owners) seeds.add(o);
  }

  if (unowned.length > 0) {
    return {
      full: true,
      reason: `changed files not owned by any subsystem: ${unowned.slice(0, 5).join(", ")}${unowned.length > 5 ? " …" : ""}`,
      subsystems: Object.keys(subsystems),
      testFiles: allTestFiles(),
    };
  }

  const foundationHit = [...seeds].filter((id) => subsystems[id]?.foundation);
  if (foundationHit.length > 0) {
    return {
      full: true,
      reason: `foundation subsystem changed: ${foundationHit.join(", ")}`,
      subsystems: Object.keys(subsystems),
      testFiles: allTestFiles(),
    };
  }

  const affected = dependentsOf([...seeds]);
  const testSet = new Set(SMOKE_TESTS);
  for (const id of affected) for (const t of subsystems[id].tests) testSet.add(t);

  return {
    full: false,
    reason: `affected subsystems: ${[...affected].sort().join(", ")}`,
    subsystems: [...affected].sort(),
    testFiles: [...testSet].sort(),
  };
}

// --------------------------------------------------------------------------- tree helpers (drift test)

/** Every `*.test.ts` suite that actually exists on disk (repo-relative). */
export function discoverTestFiles() {
  const dir = path.join(repoRoot, "tests");
  const out = [];
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith(".test.ts")) out.push(toRepoRelative(full));
    }
  };
  walk(dir);
  return out.sort();
}

/** Top-level directories under `engine/src` (repo-relative), the units the drift test insists are owned. */
export function engineSourceDirs() {
  const base = path.join(repoRoot, "engine", "src");
  return fs
    .readdirSync(base, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => toRepoRelative(path.join(base, e.name)))
    .sort();
}

function existsOnDisk(rel) {
  return fs.existsSync(path.join(repoRoot, rel));
}

/**
 * Validate the manifest against what is actually on disk. Returns `{ errors, stats }`. The drift test
 * (`tests/subsystems.test.ts`) and the `--check` CLI both consume this — a non-empty `errors` array
 * means the map has drifted and selection can no longer be trusted.
 */
export function selfCheck() {
  const errors = [];
  const onDisk = discoverTestFiles();

  // Every suite listed in the manifest (and smoke) exists.
  for (const [id, s] of Object.entries(subsystems)) {
    for (const t of s.tests) {
      if (!onDisk.includes(t)) errors.push(`subsystem "${id}" lists a suite that does not exist: ${t}`);
    }
    for (const src of s.src) {
      if (!existsOnDisk(src)) errors.push(`subsystem "${id}" declares a source path that does not exist: ${src}`);
    }
    for (const dep of s.deps) {
      if (dep === id) errors.push(`subsystem "${id}" depends on itself`);
      else if (!subsystems[dep]) errors.push(`subsystem "${id}" depends on unknown subsystem "${dep}"`);
    }
  }
  for (const t of SMOKE_TESTS) {
    if (!onDisk.includes(t)) errors.push(`smoke set lists a suite that does not exist: ${t}`);
  }

  // A suite belongs to at most one subsystem; if it belongs to none it must be a smoke suite.
  const ownersByTest = new Map();
  for (const [id, s] of Object.entries(subsystems)) {
    for (const t of s.tests) ownersByTest.set(t, [...(ownersByTest.get(t) ?? []), id]);
  }
  for (const [t, owners] of ownersByTest) {
    if (owners.length > 1) errors.push(`suite ${t} is claimed by multiple subsystems: ${owners.join(", ")}`);
  }
  for (const t of onDisk) {
    const owners = ownersByTest.get(t) ?? [];
    if (owners.length === 0 && !SMOKE_TESTS.includes(t)) {
      errors.push(`suite ${t} is not claimed by any subsystem and is not in the smoke set`);
    }
  }

  // Every top-level engine/src directory is owned by exactly one subsystem, unless it is a
  // full-run trigger (e.g. engine/src/testing, the strict mock device every suite loads).
  for (const dir of engineSourceDirs()) {
    if (FULL_TRIGGERS.some((p) => dir === p || dir.startsWith(`${p}/`))) continue;
    const owners = Object.entries(subsystems).filter(([, s]) =>
      s.src.some((prefix) => dir === prefix || dir.startsWith(`${prefix}/`)),
    );
    // `docs` claims a single file inside core (capabilities.ts), which does not own the directory.
    const dirOwners = owners.filter(([id]) => id !== "docs" || subsystems.docs.src.includes(dir));
    if (dirOwners.length === 0) errors.push(`engine source dir ${dir} is owned by no subsystem`);
    else if (dirOwners.length > 1) {
      errors.push(`engine source dir ${dir} is owned by multiple subsystems: ${dirOwners.map(([id]) => id).join(", ")}`);
    }
  }

  return {
    errors,
    stats: {
      subsystems: Object.keys(subsystems).length,
      suitesOnDisk: onDisk.length,
      suitesClaimed: ownersByTest.size,
      smoke: SMOKE_TESTS.length,
    },
  };
}

// --------------------------------------------------------------------------- CLI

function isMain() {
  const invoked = process.argv[1] ? path.resolve(process.argv[1]) : "";
  return invoked === fileURLToPath(import.meta.url);
}

if (isMain()) {
  const args = process.argv.slice(2);
  if (args[0] === "--explain") {
    const decision = selectForChanges(args.slice(1));
    console.log(JSON.stringify(decision, null, 2));
    process.exit(0);
  } else if (args[0] === "--list") {
    for (const [id, s] of Object.entries(subsystems)) {
      console.log(`${id}${s.foundation ? " (foundation)" : ""} — ${s.title}`);
      console.log(`  deps:  ${s.deps.join(", ") || "(none)"}`);
      console.log(`  tests: ${s.tests.join(", ") || "(none)"}`);
    }
    console.log(`\nsmoke: ${SMOKE_TESTS.join(", ")}`);
    process.exit(0);
  } else {
    // default / --check
    const { errors, stats } = selfCheck();
    if (errors.length > 0) {
      console.error(`test map FAILED — ${errors.length} problem${errors.length === 1 ? "" : "s"}:\n`);
      for (const e of errors) console.error(`  - ${e}`);
      console.error("\nUpdate tools/test-subsystems.mjs so every suite and source directory is claimed.");
      process.exit(1);
    }
    console.log(
      `test map OK — ${stats.subsystems} subsystems, ${stats.suitesClaimed} claimed suites ` +
        `(+${stats.smoke} smoke) covering ${stats.suitesOnDisk} suites on disk.`,
    );
    process.exit(0);
  }
}
