import { describe, expect, it } from "vitest";
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

describe("Architecture - Import Boundaries", () => {
  const rootDir = path.resolve(__dirname, "..");
  const engineSrc = path.join(rootDir, "engine", "src");

  it("core primitives do not import from higher layers", () => {
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
        expect(
          ["core", "math"].includes(topLevel ?? ""),
          `core file ${path.relative(engineSrc, file)} illegally imports from ${topLevel}: "${imp.specifier}"`,
        ).toBe(true);
      }
    }
  });

  it("gpu subsystem only imports from core and math (and testing for mock device)", () => {
    const gpuFiles = getAllFiles(path.join(engineSrc, "gpu"));
    for (const file of gpuFiles) {
      const imports = parseImports(file);
      for (const imp of imports) {
        if (!imp.specifier.startsWith(".")) continue;
        const resolved = path.normalize(path.join(path.dirname(file), imp.specifier));
        const rel = path.relative(engineSrc, resolved);
        const topLevel = rel.split(path.sep)[0];
        expect(
          ["core", "gpu", "math", "testing"].includes(topLevel ?? ""),
          `gpu file ${path.relative(engineSrc, file)} illegally imports from ${topLevel}: "${imp.specifier}"`,
        ).toBe(true);
      }
    }
  });

  it("math subsystem does not import from gpu, rendering, or scene", () => {
    const mathFiles = getAllFiles(path.join(engineSrc, "math"));
    for (const file of mathFiles) {
      const imports = parseImports(file);
      for (const imp of imports) {
        if (!imp.specifier.startsWith(".")) continue;
        const resolved = path.normalize(path.join(path.dirname(file), imp.specifier));
        const rel = path.relative(engineSrc, resolved);
        const topLevel = rel.split(path.sep)[0];
        expect(
          ["core", "math"].includes(topLevel ?? ""),
          `math file ${path.relative(engineSrc, file)} illegally imports from ${topLevel}: "${imp.specifier}"`,
        ).toBe(true);
      }
    }
  });

  it("scene subsystem has no runtime imports from rendering", () => {
    const sceneFiles = getAllFiles(path.join(engineSrc, "scene"));
    for (const file of sceneFiles) {
      const imports = parseImports(file);
      for (const imp of imports) {
        if (imp.isTypeOnly || !imp.specifier.startsWith(".")) continue;
        const resolved = path.normalize(path.join(path.dirname(file), imp.specifier));
        const rel = path.relative(engineSrc, resolved);
        const topLevel = rel.split(path.sep)[0];
        expect(
          topLevel !== "rendering",
          `scene file ${path.relative(engineSrc, file)} has illegal runtime import from rendering: "${imp.specifier}"`,
        ).toBe(true);
      }
    }
  });

  it("environment depends on scene, math and core only (rendering imports it, never the reverse)", () => {
    const files = getAllFiles(path.join(engineSrc, "environment"));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const imports = parseImports(file);
      for (const imp of imports) {
        if (!imp.specifier.startsWith(".")) continue;
        const resolved = path.normalize(path.join(path.dirname(file), imp.specifier));
        const rel = path.relative(engineSrc, resolved);
        const topLevel = rel.split(path.sep)[0];
        expect(
          ["core", "math", "scene", "environment"].includes(topLevel ?? ""),
          `environment file ${path.relative(engineSrc, file)} illegally imports from ${topLevel}: "${imp.specifier}"`,
        ).toBe(true);
      }
    }
    // The scene layer may only know the environment's *types* (the sky settings block).
    for (const file of getAllFiles(path.join(engineSrc, "scene"))) {
      for (const imp of parseImports(file)) {
        if (!imp.specifier.includes("environment")) continue;
        expect(imp.isTypeOnly, `scene file ${path.relative(engineSrc, file)} must not import environment at runtime: "${imp.specifier}"`).toBe(true);
      }
    }
  });

  it("examples only import from @forge/engine or relative local files", () => {
    const exampleFiles = getAllFiles(path.join(rootDir, "examples", "src"));
    for (const file of exampleFiles) {
      const imports = parseImports(file);
      for (const imp of imports) {
        const isPublicApi = imp.specifier === "@forge/engine";
        const isRelativeLocal = imp.specifier.startsWith("./") || imp.specifier.startsWith("../");
        expect(
          isPublicApi || isRelativeLocal,
          `example file ${path.basename(file)} must use public API @forge/engine, not deep import "${imp.specifier}"`,
        ).toBe(true);
        if (isRelativeLocal) {
          const resolved = path.normalize(path.join(path.dirname(file), imp.specifier));
          expect(
            resolved.includes(path.join("engine", "src")),
            `example file ${path.basename(file)} has forbidden deep import into engine/src: "${imp.specifier}"`,
          ).toBe(false);
        }
      }
    }
  });
});
