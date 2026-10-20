#!/usr/bin/env node
/**
 * lint:arch — the import-boundary linter.
 *
 * `tests/engine/architecture.test.ts` asserts the same boundaries through selrun. This tool exists
 * as well for two reasons:
 *
 *  1. `npm run lint:arch` is cheap (no test-runner startup), so it can run first in CI and in a pre-commit
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
 *   scripting/**       -> core, math, scene, scripting (Phase 18.6: no gpu/rendering/physics internals)
 *   ui/** (not ui/gpu) -> core, math, ui; ui/gpu/** -> also gpu, rendering; nothing else imports ui
 *   replay/**          -> core, math, scene, physics, vehicles, replay
 *   audio/**           -> core, math, scene, resources, vehicles, physics, particles, audio (reads simulation state; nothing simulated imports audio)
 *   editor/**          -> "@forge/engine" or a local relative editor file; runtime never imports editor
 *   examples/**        -> "@forge/engine" or a local relative file, never engine/src
 *   tests/**           -> "@forge/engine" or a local relative file outside engine/src
 *   all engine sources -> no WebGL fallback, ever (WebGPU-first, ADR-001)
 *   simulation sources -> no implementation-approximated Math function and no `**` (Phase 19.5: they
 *                         differ between JavaScript engines; use DMath). DETERMINISTIC_SOURCES below.
 *
 * Run with `npm run lint:arch`. Exits 1 with file:line for every violation.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const engineSrc = path.join(root, "engine", "src");
const editorSrc = path.join(root, "editor", "src");

const violations = [];

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts"]);

function files(dir, ext = undefined) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...files(full, ext));
    else if (entry.isFile() && (ext ? entry.name.endsWith(ext) : SOURCE_EXTENSIONS.has(path.extname(entry.name)))) out.push(full);
  }
  return out;
}

/** Static, type-query, import-equals, literal dynamic and CommonJS imports across multiline declarations. */
function parsedImports(file) {
  const source = fs.readFileSync(file, "utf-8");
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const found = [];
  const add = (node, literal, isTypeOnly = false) => {
    if (!literal || !ts.isStringLiteralLike(literal)) return;
    const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
    found.push({ specifier: literal.text, isTypeOnly, line });
  };
  const visit = (node) => {
    if (ts.isImportDeclaration(node)) add(node, node.moduleSpecifier, node.importClause?.isTypeOnly === true);
    else if (ts.isExportDeclaration(node)) add(node, node.moduleSpecifier, node.isTypeOnly);
    else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      add(node, node.moduleReference.expression, node.isTypeOnly);
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      add(node, node.argument.literal, true);
    } else if (ts.isCallExpression(node) && (
      node.expression.kind === ts.SyntaxKind.ImportKeyword
      || (ts.isIdentifier(node.expression) && node.expression.text === "require")
    )) {
      add(node, node.arguments[0]);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
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
    for (const imp of parsedImports(file)) {
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
const isCompositionHost = (file) =>
  file.endsWith(path.join("core", "engine.ts")) ||
  file.endsWith(path.join("core", "tasks", "worker-entry.ts"));
checkEngineDir("core", ["core", "math"], "core may only depend on core and math (core/engine.ts excepted)", isCompositionHost);

checkEngineDir("gpu", ["core", "gpu", "math", "testing"], "gpu may use core, gpu, math and the test device");
checkEngineDir("math", ["core", "math"], "math may only depend on core and math");
checkEngineDir("environment", ["core", "math", "scene", "environment"], "environment must not import rendering or its siblings");
checkEngineDir("scripting", ["core", "math", "scene", "scripting"], "scripts reach the engine through entities and components, never GPU/render/solver internals");
// ui (docs/UI.md §2): the framework is GPU-free; only ui/gpu (the WebGPU backend) may see gpu/rendering.
const isUiGpu = (file) => file.includes(`${path.sep}ui${path.sep}gpu${path.sep}`);
// replay (docs/REPLAY.md): reads scene, physics and vehicle state to hash it; nothing imports replay
// except the barrel, so the simulation never depends on being recorded.
checkEngineDir("replay", ["core", "math", "scene", "physics", "vehicles", "replay"], "replay may read core, math, scene, physics and vehicles; it must not reach rendering or the GPU");
// audio (docs/AUDIO.md): voices read entity transforms and vehicle, contact and particle state after it stepped, and
// clips are registry resources; it never reaches rendering, and
// no simulation module imports audio, so the simulation is the same with sound on or off.
checkEngineDir("audio", ["core", "math", "scene", "resources", "vehicles", "physics", "particles", "audio"], "audio may read core, math, scene components, resources and vehicle, physics and particle state; it must not reach rendering or the GPU");
checkEngineDir("ui", ["core", "math", "ui"], "the UI framework depends on core, math and itself; GPU code lives in ui/gpu", isUiGpu);
for (const file of files(path.join(engineSrc, "ui", "gpu"))) {
  for (const imp of parsedImports(file)) {
    if (!imp.specifier.startsWith(".")) continue;
    const { top } = topLevelOf(file, imp.specifier);
    if (["core", "math", "ui", "gpu", "rendering"].includes(top)) continue;
    violations.push({ file, line: imp.line, message: `${path.relative(root, file)} imports "${imp.specifier}" (${top}) — ui/gpu may use core, math, ui, gpu and rendering` });
  }
}
// Nothing outside ui (except the barrel) may depend on the UI.
for (const file of files(engineSrc)) {
  if (file.includes(`${path.sep}ui${path.sep}`) || file === path.join(engineSrc, "index.ts")) continue;
  for (const imp of parsedImports(file)) {
    if (!imp.specifier.startsWith(".")) continue;
    const { top } = topLevelOf(file, imp.specifier);
    if (top === "ui") violations.push({ file, line: imp.line, message: `${path.relative(root, file)} imports the UI ("${imp.specifier}") — engine layers below ui must not depend on it` });
  }
}

// scene: no runtime rendering/environment imports (the sky settings block is type-only).
for (const file of files(path.join(engineSrc, "scene"))) {
  for (const imp of parsedImports(file)) {
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

// The editor is a host above the public package boundary. No runtime source — including the
// composition root — may import it through either a package or relative path.
for (const file of files(engineSrc)) {
  for (const imp of parsedImports(file)) {
    const resolved = imp.specifier.startsWith(".")
      ? path.normalize(path.join(path.dirname(file), imp.specifier))
      : "";
    if (imp.specifier === "@forge/editor" || imp.specifier.startsWith("@forge/editor/") || resolved === editorSrc || resolved.startsWith(`${editorSrc}${path.sep}`)) {
      violations.push({
        file,
        line: imp.line,
        message: `${path.relative(root, file)} imports the editor ("${imp.specifier}") — runtime must never depend on editor`,
      });
    }
  }
}

// ----------------------------------------------------------------- never WebGL

for (const file of files(engineSrc)) {
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
    for (const imp of parsedImports(file)) {
      const isPublicApi = imp.specifier === "@forge/engine";
      const isRelative = imp.specifier.startsWith("./") || imp.specifier.startsWith("../");
      if (!isPublicApi && !isRelative) {
        // Tests may use any bare package (esbuild, node:*); examples are browser code and
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

checkHost("editor/src", "editor");
checkHost("examples/src", "example");
checkHost("tests", "test", { allowBarePackages: true });

// ----------------------------------------------------------------- deterministic simulation (19.5)

// Everything a replay or a snapshot hash depends on. ECMAScript leaves these Math functions (and `**`)
// implementation-approximated, so V8 and JavaScriptCore can return different last bits; simulation code
// calls DMath (engine/src/math/detmath.ts) instead. tests/replay/crossEngine.test.ts checks the same thing
// at run time: the verification session calls none of them.
const DETERMINISTIC_SOURCES = [
  "engine/src/physics",
  "engine/src/vehicles",
  "engine/src/replay",
  "engine/src/core/snapshot.ts",
  "engine/src/scene/snapshot.ts",
  "engine/src/math/detmath.ts",
  "engine/src/math/mat.ts",
  "engine/src/math/vec.ts",
  "engine/src/math/rng.ts",
  "engine/src/math/noise.ts",
  "engine/src/environment/atmosphere.ts",
  "engine/src/environment/dayNight.ts",
  "engine/src/environment/lightning.ts",
  "engine/src/environment/moistureField.ts",
  "engine/src/environment/snowMelt.ts",
  "engine/src/environment/solar.ts",
  "engine/src/environment/surfaceWeather.ts",
  "engine/src/environment/weather.ts",
  "engine/src/terrain/track.ts",
  "engine/src/terrain/trackGrading.ts",
  "engine/src/terrain/trackWeather.ts",
  "examples/src/replay",
];
const APPROXIMATED =
  /\bMath\.(acosh?|asinh?|atanh?|atan2|cbrt|cosh?|exp|expm1|hypot|log|log1p|log10|log2|pow|sinh?|tanh?)\s*\(/;
const EXPONENT = /[\w)\]]\s*\*\*(?!\/)\s*[\w(.-]/;

/** Source with comments and string contents blanked, line structure kept. */
function codeOnly(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\/\/.*$/gm, "")
    .replace(/(["'`])(?:\\.|(?!\1)[^\\\n])*\1/g, (m) => m[0] + " ".repeat(m.length - 2) + m[0]);
}

for (const entry of DETERMINISTIC_SOURCES) {
  const full = path.join(root, entry);
  if (!fs.existsSync(full)) {
    violations.push({ file: full, line: 0, message: `DETERMINISTIC_SOURCES lists ${entry}, which does not exist` });
    continue;
  }
  const list = fs.statSync(full).isDirectory() ? files(full) : [full];
  for (const file of list) {
    codeOnly(fs.readFileSync(file, "utf-8"))
      .split("\n")
      .forEach((line, index) => {
        const approx = line.match(APPROXIMATED);
        if (approx) {
          violations.push({ file, line: index + 1, message: `${path.relative(root, file)} calls Math.${approx[1]} in simulation code — it differs between JavaScript engines; use DMath.${approx[1]}` });
        } else if (EXPONENT.test(line)) {
          violations.push({ file, line: index + 1, message: `${path.relative(root, file)} uses \`**\` in simulation code — it differs between JavaScript engines; multiply, or use DMath.pow` });
        }
      });
  }
}

// ----------------------------------------------------------------- report

if (violations.length > 0) {
  console.error(`lint:arch FAILED — ${violations.length} boundary violation${violations.length === 1 ? "" : "s"}\n`);
  for (const violation of violations) console.error(`  ${violation.message}  (line ${violation.line})`);
  console.error("\nARCHITECTURE.md §2 defines the dependency direction these rules enforce.");
  process.exit(1);
}

const scanned = [
  files(path.join(engineSrc)).length,
  files(editorSrc).length,
  files(path.join(root, "examples", "src")).length,
  files(path.join(root, "tests")).length,
];
console.log(
  `lint:arch OK — ${scanned[0]} engine sources, ${scanned[1]} editor sources, ${scanned[2]} example sources, ${scanned[3]} test files: ` +
    "boundaries intact, no WebGL fallback, no engine/src deep imports, no engine-dependent Math in simulation code.",
);
