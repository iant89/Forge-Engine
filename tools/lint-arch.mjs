#!/usr/bin/env node
/**
 * lint:arch — the import-boundary linter.
 *
 * `tests/architecture.test.ts` asserts the same boundaries with vitest. This tool exists as well for
 * two reasons:
 *
 *  1. `npm run lint:arch` is cheap (no vitest startup), so it can run first in CI and in a pre-commit
 *     hook, where a boundary violation should be a one-line explanation rather than a failing suite.
 *  2. It is a second, independent reader of the same rule. `ARCHITECTURE.md` §2 draws the dependency
 *     arrows; a bug in the regex-based test is caught by the tool and vice versa.
 *
 * Rules (from ARCHITECTURE.md §2 and AGENTS.md §3):
 *
 *   core/**            -> core, math only (core/engine.ts is the composition host and is exempt)
 *   gpu/**             -> core, gpu, math, testing
 *   math/**            -> core, math
 *   scene/**           -> never rendering or environment at runtime (type-only imports allowed)
 *   environment/**     -> core, math, scene, environment
 *   examples/**        -> "@forge/engine" or a local relative file, never engine/src
 *   tests/**           -> "@forge/engine" or a local relative file outside engine/src
 *   all engine sources -> no WebGL fallback, ever (WebGPU-first, ADR-001)
 *
 * Run with `npm run lint:arch`. Exits 1 with file:line for every violation.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const engineSrc = path.join(root, "engine", "src");

const violations = [];

function files(dir, ext = ".ts") {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...files(full, ext));
    else if (entry.isFile() && entry.name.endsWith(ext)) out.push(full);
  }
  return out;
}

/** Relative specifiers only; package imports are checked separately. */
function relativeImports(file) {
  const found = [];
  const lines = fs.readFileSync(file, "utf-8").split("\n");
  lines.forEach((line, index) => {
    const isTypeOnly = /^\s*(?:import|export)\s+type\s+/.test(line);
    const match = line.match(/(?:import|export)\s+(?:type\s+)?.*?from\s+["']([^"']+)["']/);
    if (!match) return;
    found.push({ specifier: match[1], isTypeOnly, line: index + 1 });
  });
  return found;
}

function topLevelOf(file, specifier) {
  const resolved = path.normalize(path.join(path.dirname(file), specifier));
  const rel = path.relative(engineSrc, resolved);
  return { resolved, top: rel.split(path.sep)[0] ?? "" };
}

function checkEngineDir(dir, allowed, note, exempt = () => false) {
  for (const file of files(path.join(engineSrc, dir))) {
    if (exempt(file)) continue;
    for (const imp of relativeImports(file)) {
      if (!imp.specifier.startsWith(".")) continue;
      const { top } = topLevelOf(file, imp.specifier);
      if (allowed.includes(top)) continue;
      violations.push({
        file,
        line: imp.line,
        message: `${path.relative(root, file)} imports "${imp.specifier}" (${top || "outside engine/src"}) — ${note}`,
      });
    }
  }
}

// ----------------------------------------------------------------- engine layers

// core/engine.ts is the composition host: it is allowed to see the whole engine.
const isCompositionHost = (file) => file.endsWith(path.join("core", "engine.ts"));
checkEngineDir("core", ["core", "math"], "core may only depend on core and math (core/engine.ts excepted)", isCompositionHost);

checkEngineDir("gpu", ["core", "gpu", "math", "testing"], "gpu may use core, gpu, math and the test device");
checkEngineDir("math", ["core", "math"], "math may only depend on core and math");
checkEngineDir("environment", ["core", "math", "scene", "environment"], "environment must not import rendering or its siblings");

// scene: no runtime rendering/environment imports (the sky settings block is type-only).
for (const file of files(path.join(engineSrc, "scene"))) {
  for (const imp of relativeImports(file)) {
    if (!imp.specifier.startsWith(".")) continue;
    const { top } = topLevelOf(file, imp.specifier);
    if (top !== "rendering" && top !== "environment") continue;
    if (imp.isTypeOnly) continue;
    violations.push({
      file,
      line: imp.line,
      message: `${path.relative(root, file)} has a runtime import from ${top}: "${imp.specifier}" — use "import type"`,
    });
  }
}

// ----------------------------------------------------------------- never WebGL

for (const file of files(engineSrc, ".ts")) {
  const text = fs.readFileSync(file, "utf-8");
  if (/webgl/i.test(text)) {
    const line = text.split("\n").findIndex((l) => /webgl/i.test(l)) + 1;
    violations.push({
      file,
      line,
      message: `${path.relative(root, file)} mentions WebGL — Forge is WebGPU-first with no compatibility layer`,
    });
  }
}

// ----------------------------------------------------------------- hosts

function checkHost(dir, label, { allowBarePackages = false } = {}) {
  for (const file of files(path.join(root, dir))) {
    for (const imp of relativeImports(file)) {
      const isPublicApi = imp.specifier === "@forge/engine";
      const isRelative = imp.specifier.startsWith("./") || imp.specifier.startsWith("../");
      if (!isPublicApi && !isRelative) {
        // Tests may use any bare package (vitest, esbuild, node:*); examples are browser code and
        // must come through the engine's public API or their own files.
        if (allowBarePackages) continue;
        violations.push({ file, line: imp.line, message: `${label} ${path.relative(root, file)} imports "${imp.specifier}"` });
        continue;
      }
      if (imp.specifier.startsWith("@forge/engine/")) {
        violations.push({
          file,
          line: imp.line,
          message: `${label} ${path.relative(root, file)} imports a subpath of the engine package: "${imp.specifier}" — use @forge/engine`,
        });
        continue;
      }
      if (!isRelative) continue;
      const resolved = path.normalize(path.join(path.dirname(file), imp.specifier));
      if (resolved.includes(path.join("engine", "src"))) {
        violations.push({
          file,
          line: imp.line,
          message: `${label} ${path.relative(root, file)} deep-imports engine/src: "${imp.specifier}" — use @forge/engine`,
        });
      }
    }
  }
}

checkHost("examples/src", "example");
checkHost("tests", "test", { allowBarePackages: true });

// ----------------------------------------------------------------- report

if (violations.length > 0) {
  console.error(`lint:arch FAILED — ${violations.length} boundary violation${violations.length === 1 ? "" : "s"}\n`);
  for (const violation of violations) console.error(`  ${violation.message}  (line ${violation.line})`);
  console.error("\nARCHITECTURE.md §2 defines the dependency direction these rules enforce.");
  process.exit(1);
}

const scanned = [
  files(path.join(engineSrc)).length,
  files(path.join(root, "examples", "src")).length,
  files(path.join(root, "tests")).length,
];
console.log(
  `lint:arch OK — ${scanned[0]} engine sources, ${scanned[1]} example sources, ${scanned[2]} test files: ` +
    "boundaries intact, no WebGL fallback, no engine/src deep imports.",
);
