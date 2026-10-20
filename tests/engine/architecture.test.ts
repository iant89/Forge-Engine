/**
 * @suite engine:architecture
 * @group unit
 * @covers engine/src/**\/*.ts
 * @covers editor/src/**\/*.ts
 * @covers examples/src/**\/*.ts
 * @desc Pins architecture behavior and regression guarantees
 */

export const suite = {
  name: "engine:architecture",
  group: "unit",
  covers: [
    "engine/src/**/*.ts",
    "editor/src/**/*.ts",
    "examples/src/**/*.ts",
  ],
  desc: "Pins architecture behavior and regression guarantees",
};
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { finish, group, test } from "selrun";
import * as fs from "node:fs";
import * as path from "node:path";
import ts from "typescript";

const sourceExtensions = new Set([".ts", ".tsx", ".mts", ".cts"]);

function getAllFiles(dir: string): string[] {
  const files: string[] = [];
  if (!fs.existsSync(dir)) return files;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...getAllFiles(full));
    } else if (entry.isFile() && sourceExtensions.has(path.extname(entry.name))) {
      files.push(full);
    }
  }
  return files;
}

interface ParsedImport {
  specifier: string;
  isTypeOnly: boolean;
}

function parseImports(filePath: string, sourceText?: string): ParsedImport[] {
  const content = sourceText ?? fs.readFileSync(filePath, "utf-8");
  const source = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true);
  const imports: ParsedImport[] = [];
  const add = (literal: ts.Expression | undefined, isTypeOnly = false): void => {
    if (literal && ts.isStringLiteralLike(literal)) imports.push({ specifier: literal.text, isTypeOnly });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) add(node.moduleSpecifier, node.importClause?.isTypeOnly === true);
    else if (ts.isExportDeclaration(node)) add(node.moduleSpecifier, node.isTypeOnly);
    else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      add(node.moduleReference.expression, node.isTypeOnly);
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      add(node.argument.literal, true);
    } else if (ts.isCallExpression(node) && (
      node.expression.kind === ts.SyntaxKind.ImportKeyword
      || (ts.isIdentifier(node.expression) && node.expression.text === "require")
    )) {
      add(node.arguments[0]);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
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

  test("scripting depends on scene, math and core only (Phase 18.6: no GPU, render or solver internals)", () => {
    const files = getAllFiles(path.join(engineSrc, "scripting"));
    assert.ok(files.length > 0);
    for (const file of files) {
      for (const imp of parseImports(file)) {
        if (!imp.specifier.startsWith(".")) continue;
        const resolved = path.normalize(path.join(path.dirname(file), imp.specifier));
        const topLevel = path.relative(engineSrc, resolved).split(path.sep)[0];
        assert.equal(["core", "math", "scene", "scripting"].includes(topLevel ?? ""), true, `scripting file ${path.relative(engineSrc, file)} illegally imports from ${topLevel}: "${imp.specifier}"`);
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

  test("editor depends only on the public engine API and runtime never imports editor", () => {
    assert.deepEqual(
      parseImports("architecture-probe.tsx", `
        import "static-probe";
        type Probe = import("type-probe").Probe;
        void import("dynamic-probe");
        const commonJsProbe = require("require-probe");
      `),
      [
        { specifier: "static-probe", isTypeOnly: false },
        { specifier: "type-probe", isTypeOnly: true },
        { specifier: "dynamic-probe", isTypeOnly: false },
        { specifier: "require-probe", isTypeOnly: false },
      ],
      "all supported import forms must be visible to the architecture parser",
    );
    const editorSrc = path.join(rootDir, "editor", "src");
    const editorFiles = getAllFiles(editorSrc);
    assert.ok(editorFiles.length > 0);
    assert.ok(
      parseImports(path.join(editorSrc, "session.ts")).some((imp) => imp.specifier === "@forge/engine"),
      "multiline editor imports must be visible to the architecture parser",
    );
    for (const file of editorFiles) {
      for (const imp of parseImports(file)) {
        const isPublicApi = imp.specifier === "@forge/engine";
        const isRelativeLocal = imp.specifier.startsWith("./") || imp.specifier.startsWith("../");
        assert.equal(isPublicApi || isRelativeLocal, true, `editor file ${path.basename(file)} bypasses the public engine API: "${imp.specifier}"`);
        if (isRelativeLocal) {
          const resolved = path.normalize(path.join(path.dirname(file), imp.specifier));
          assert.equal(resolved === editorSrc || resolved.startsWith(`${editorSrc}${path.sep}`), true, `editor file ${path.basename(file)} imports outside editor/src: "${imp.specifier}"`);
        }
      }
    }
    for (const file of getAllFiles(engineSrc)) {
      for (const imp of parseImports(file)) {
        assert.equal(imp.specifier === "@forge/editor" || imp.specifier.startsWith("@forge/editor/"), false, `runtime file ${path.relative(engineSrc, file)} imports @forge/editor`);
        if (!imp.specifier.startsWith(".")) continue;
        const resolved = path.normalize(path.join(path.dirname(file), imp.specifier));
        assert.equal(resolved === editorSrc || resolved.startsWith(`${editorSrc}${path.sep}`), false, `runtime file ${path.relative(engineSrc, file)} imports editor source: "${imp.specifier}"`);
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
