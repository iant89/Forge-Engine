/**
 * Subsystem map and smoke floor for Forge's affected-test selection.
 *
 * This module is intentionally hand-written and reviewed: a stale map silently
 * under-tests. Every production path belongs to a subsystem, and every subsystem
 * is claimed by at least one suite. Unowned files force a full-run fallback.
 */

/** Map from subsystem name to glob patterns that define its files. */
export const SUBSYSTEMS = {
  "math": ["engine/src/math/**"],
  "core": ["engine/src/core/**"],
  "gpu": ["engine/src/gpu/**"],
  "rendering": ["engine/src/rendering/**"],
  "scene": ["engine/src/scene/**"],
  "terrain": ["engine/src/terrain/**"],
  "physics": ["engine/src/physics/**"],
  "vehicles": ["engine/src/vehicles/**"],
  "particles": ["engine/src/particles/**"],
  "environment": ["engine/src/environment/**"],
  "animation": ["engine/src/animation/**"],
  "audio": ["engine/src/audio/**"],
  "resources": [
    "engine/src/resources/**",
    "engine/src/gltf/**",
  ],
  "replay": ["engine/src/replay/**"],
  "population": ["engine/src/population/**"],
  "scripting": ["engine/src/scripting/**"],
  "ui": ["engine/src/ui/**"],
  "debug": ["engine/src/debug/**"],
  "testing": ["engine/src/testing/**"],
  // Cross-cutting
  "engine-barrel": ["engine/src/index.ts"],
  // Tooling and config subsystems — changes here are high-confidence fallback triggers
  "tools": ["tools/**"],
  "benchmarks": ["benchmarks/**"],
  "tests": ["tests/**"],
  "examples": ["examples/**"],
  "docs": ["docs/**"],
  "config": [
    "package.json",
    "package-lock.json",
    "engine/package.json",
    "examples/package.json",
    "tsconfig*.json",
    "engine/tsconfig.json",
    "examples/tsconfig.json",
    "tests/tsconfig.json",
    "benchmarks/tsconfig.json",
    "vite.config.*",
    "examples/vite.config.*",
    ".github/**",
    "scripts/**",
  ],
};

/** Patterns that, when changed, must fall back to the full suite. */
export const FALLBACK_PATTERNS = [
  "package.json",
  "package-lock.json",
  "engine/package.json",
  "tsconfig*.json",
  "engine/tsconfig.json",
  "tests/tsconfig.json",
  "examples/tsconfig.json",
  "benchmarks/tsconfig.json",
  ".github/**",
  "scripts/**",
  // Top-level config that can affect any subsystem
  "*.config.*",
  "vite.config.*",
  "examples/vite.config.*",
];

/** Foundation files whose change is known to have wide downstream impact. */
export const FOUNDATION_FILES = new Set([
  "engine/src/math/transform.ts",
  "engine/src/math/vec.ts",
  "engine/src/math/mat.ts",
  "engine/src/math/double3.ts",
  "engine/src/math/geometry.ts",
  "engine/src/math/rng.ts",
  "engine/src/scene/coordinateSpace.ts",
  "engine/src/scene/spaces.ts",
  "engine/src/core/engine.ts",
  "engine/src/core/config.ts",
  "engine/src/gpu/device.ts",
  "engine/src/rendering/renderGraph.ts",
  "engine/src/index.ts",
]);

/** Mandatory smoke suites — always run, even when affected scope is empty. */
export const SMOKE_FLOOR = [
  "tests/engine/architecture.test.ts",
  "tests/math/math.test.ts",
  "tests/tools/selrun.test.ts",
  "tests/scene/ecs.test.ts",
  "tests/rendering/pipeline.test.ts",
];

/** Resolve a file path to its subsystem, or null if unowned. */
export function subsystemForFile(file) {
  const normalized = String(file).replaceAll("\\", "/");
  for (const [subsystem, patterns] of Object.entries(SUBSYSTEMS)) {
    for (const pattern of patterns) {
      if (globMatchesInline(normalized, pattern)) return subsystem;
    }
  }
  return null;
}

// Inline glob matching to avoid circular import with selection.mjs
function globMatchesInline(file, pattern) {
  const target = String(file).replaceAll("\\", "/").split("/");
  const parts = String(pattern).replaceAll("\\", "/").split("/");
  const memo = new Map();
  const segmentMatches = (value, glob) => {
    if (glob === "*") return value.length > 0;
    const escaped = [...glob].map((c) => (c === "*" ? "[^/]*" : ".+?^${}()|[]\\".includes(c) ? `\\${c}` : c)).join("");
    return new RegExp(`^${escaped}$`).test(value);
  };
  const visit = (pi, ti) => {
    const key = `${pi}:${ti}`;
    if (memo.has(key)) return memo.get(key);
    if (pi === parts.length) return ti === target.length;
    const part = parts[pi];
    let result;
    if (part === "**") {
      result = visit(pi + 1, ti) || (ti < target.length && visit(pi, ti + 1));
    } else {
      result = ti < target.length && segmentMatches(target[ti], part) && visit(pi + 1, ti + 1);
    }
    memo.set(key, result);
    return result;
  };
  return visit(0, 0);
}

/** Check if a file matches any fallback pattern. */
export function isFallbackFile(file) {
  for (const pattern of FALLBACK_PATTERNS) {
    if (globMatchesInline(file, pattern)) return true;
  }
  return false;
}

/** Check if a file is a known foundation file with wide impact. */
export function isFoundationFile(file) {
  return FOUNDATION_FILES.has(String(file).replaceAll("\\", "/"));
}
