/**
 * @suite engine:architecture
 * @group unit
 * @covers engine/src/**\/*.ts
 * @covers examples/src/**\/*.ts
 * @desc Pins architecture behavior and regression guarantees
 */

export const suite = {
  name: "engine:architecture",
  group: "unit",
  covers:   [
    "engine/src/**/*.ts",
    "examples/src/**/*.ts"
  ],
  desc: "Pins architecture behavior and regression guarantees",
};
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { finish, group, test } from "selrun";
import * as fs from "node:fs";
import * as path from "node:path";

function getAllFiles(dir: string, ext = ".ts"): string[] {
  const files: string[] = [];
  if (!fs.existsSync(dir)) return files;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...getAllFiles(full, ext));
    } else if (entry.isFile() && entry.name.endsWith(ext)) {
      files.push(full);
    }
  }
  return files;
}

interface ParsedImport {
  specifier: string;
  isTypeOnly: boolean;
}

function parseImports(filePath: string): ParsedImport[] {
  const content = fs.readFileSync(filePath, "utf-8");
  const imports: ParsedImport[] = [];
  const lines = content.split("\n");
  for (const line of lines) {
    const isTypeOnly = /^\s*(?:import|export)\s+type\s+/.test(line);
    const match = line.match(/(?:import|export)\s+(?:type\s+)?.*?from\s+['"]([^'"]+)['"]/);
    if (match && match[1]) {
      imports.push({ specifier: match[1], isTypeOnly });
    }
  }
  return imports;
}

group("Architecture - Import Boundaries", () => {
  const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const engineSrc = path.join(rootDir, "engine", "src");

  test("core primitives do not import from higher layers", () => {
    // core/engine.ts is the composition host, but all other core modules must be dependency-free
    const coreFiles = getAllFiles(path.join(engineSrc, "core")).filter(
      (f) => !f.endsWith("core/engine.ts") && !f.endsWith("core/tasks/worker-entry.ts"),
    );
    for (const file of coreFiles) {
      const imports = parseImports(file);
      for (const imp of imports) {
        if (!imp.specifier.startsWith(".")) continue;
        const resolved = path.normalize(path.join(path.dirname(file), imp.specifier));
        const rel = path.relative(engineSrc, resolved);
        const topLevel = rel.split(path.sep)[0];
        assert.equal(["core", "math"].includes(topLevel ?? ""), true, `core file ${path.relative(engineSrc, file)} illegally imports from ${topLevel}: "${imp.specifier}"`);
      }
    }
  });

  test("gpu subsystem only imports from core and math (and testing for mock device)", () => {
    const gpuFiles = getAllFiles(path.join(engineSrc, "gpu"));
    for (const file of gpuFiles) {
      const imports = parseImports(file);
      for (const imp of imports) {
        if (!imp.specifier.startsWith(".")) continue;
        const resolved = path.normalize(path.join(path.dirname(file), imp.specifier));
        const rel = path.relative(engineSrc, resolved);
        const topLevel = rel.split(path.sep)[0];
        assert.equal(["core", "gpu", "math", "testing"].includes(topLevel ?? ""), true, `gpu file ${path.relative(engineSrc, file)} illegally imports from ${topLevel}: "${imp.specifier}"`);
      }
    }
  });

  test("math subsystem does not import from gpu, rendering, or scene", () => {
    const mathFiles = getAllFiles(path.join(engineSrc, "math"));
    for (const file of mathFiles) {
      const imports = parseImports(file);
      for (const imp of imports) {
        if (!imp.specifier.startsWith(".")) continue;
        const resolved = path.normalize(path.join(path.dirname(file), imp.specifier));
        const rel = path.relative(engineSrc, resolved);
        const topLevel = rel.split(path.sep)[0];
        assert.equal(["core", "math"].includes(topLevel ?? ""), true, `math file ${path.relative(engineSrc, file)} illegally imports from ${topLevel}: "${imp.specifier}"`);
      }
    }
  });

  test("scene subsystem has no runtime imports from rendering", () => {
    const sceneFiles = getAllFiles(path.join(engineSrc, "scene"));
    for (const file of sceneFiles) {
      const imports = parseImports(file);
      for (const imp of imports) {
        if (imp.isTypeOnly || !imp.specifier.startsWith(".")) continue;
        const resolved = path.normalize(path.join(path.dirname(file), imp.specifier));
        const rel = path.relative(engineSrc, resolved);
        const topLevel = rel.split(path.sep)[0];
        assert.equal(topLevel !== "rendering", true, `scene file ${path.relative(engineSrc, file)} has illegal runtime import from rendering: "${imp.specifier}"`);
      }
    }
  });

  test("environment depends on scene, math and core only (rendering imports it, never the reverse)", () => {
    const files = getAllFiles(path.join(engineSrc, "environment"));
    assert.ok(files.length > 0);
    for (const file of files) {
      const imports = parseImports(file);
      for (const imp of imports) {
        if (!imp.specifier.startsWith(".")) continue;
        const resolved = path.normalize(path.join(path.dirname(file), imp.specifier));
        const rel = path.relative(engineSrc, resolved);
        const topLevel = rel.split(path.sep)[0];
        assert.equal(["core", "math", "scene", "environment"].includes(topLevel ?? ""), true, `environment file ${path.relative(engineSrc, file)} illegally imports from ${topLevel}: "${imp.specifier}"`);
      }
    }
    // The scene layer may only know the environment's *types* (the sky settings block).
    for (const file of getAllFiles(path.join(engineSrc, "scene"))) {
      for (const imp of parseImports(file)) {
        if (!imp.specifier.includes("environment")) continue;
        assert.equal(imp.isTypeOnly, true, `scene file ${path.relative(engineSrc, file)} must not import environment at runtime: "${imp.specifier}"`);
      }
    }
  });

  test("examples only import from @forge/engine or relative local files", () => {
    const exampleFiles = getAllFiles(path.join(rootDir, "examples", "src"));
    for (const file of exampleFiles) {
      const imports = parseImports(file);
      for (const imp of imports) {
        const isPublicApi = imp.specifier === "@forge/engine";
        const isRelativeLocal = imp.specifier.startsWith("./") || imp.specifier.startsWith("../");
        assert.equal(isPublicApi || isRelativeLocal, true, `example file ${path.basename(file)} must use public API @forge/engine, not deep import "${imp.specifier}"`);
        if (isRelativeLocal) {
          const resolved = path.normalize(path.join(path.dirname(file), imp.specifier));
          assert.equal(resolved.includes(path.join("engine", "src")), false, `example file ${path.basename(file)} has forbidden deep import into engine/src: "${imp.specifier}"`);
        }
      }
    }
  });
});

await finish();
