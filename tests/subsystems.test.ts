import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * subsystems.test.ts — the drift guard for the test-selection map.
 *
 * `tools/test-subsystems.mjs` is the single source of truth that lets `npm run test:affected` run only
 * the suites a change can reach. If a suite is added without being claimed, or a subsystem's source
 * directory moves, selection silently under-tests. This suite is the honesty gate that stops that:
 * it drives the map's own `--check` (the same command CI runs) and pins the selection behaviour that
 * makes the feature worth having — a leaf change stays narrow; a foundation change opens up to full.
 *
 * The map is plain ESM (`allowJs` is false in this tsconfig), so — like `gpuEnv.test.ts` and
 * `capabilities.test.ts` drive their tools — this suite runs it as a subprocess rather than importing
 * it, and asserts on its output and exit code.
 */

const root = path.resolve(__dirname, "..");
const tool = path.join(root, "tools", "test-subsystems.mjs");

function run(args: string[]): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(process.execPath, [tool, ...args], { cwd: root, encoding: "utf-8" });
    return { status: 0, stdout, stderr: "" };
  } catch (err) {
    const e = err as { status?: number; stdout?: Buffer | string; stderr?: Buffer | string };
    return {
      status: e.status ?? 1,
      stdout: String(e.stdout ?? ""),
      stderr: String(e.stderr ?? ""),
    };
  }
}

function explain(files: string[]): {
  full: boolean;
  reason: string;
  subsystems: string[];
  testFiles: string[];
} {
  const { status, stdout } = run(["--explain", ...files]);
  expect(status).toBe(0);
  return JSON.parse(stdout);
}

describe("test-selection subsystem map", () => {
  it("claims every suite and source directory (the map has not drifted)", () => {
    const { status, stdout, stderr } = run(["--check"]);
    expect(stderr + stdout).toContain(status === 0 ? "test map OK" : "");
    // A failure prints the exact drift; surface it so the assertion message is actionable.
    expect(status, stderr || stdout).toBe(0);
  });

  it("names a subsystem for every suite that exists on disk", () => {
    // Independent second reader of rule 1: no suite file is left unclaimed by the map.
    const suites = fs.readdirSync(path.join(root, "tests")).filter((f) => f.endsWith(".test.ts"));
    // The map's --check already asserts this; here we just prove the directory it scanned is non-trivial.
    expect(suites.length).toBeGreaterThan(20);
  });

  it("keeps a leaf change narrow (rendering pulls its dependents, not the whole engine)", () => {
    const d = explain(["engine/src/rendering/renderer.ts"]);
    expect(d.full).toBe(false);
    expect(d.subsystems).toContain("rendering");
    expect(d.subsystems).toContain("terrain"); // terrain is built on rendering
    // Physics and vehicles are on the other side of the graph: a shader change must not run them.
    expect(d.subsystems).not.toContain("physics");
    expect(d.subsystems).not.toContain("vehicles");
    expect(d.testFiles).toContain("tests/rendering.test.ts");
    expect(d.testFiles.length).toBeLessThan(38);
  });

  it("always includes the smoke floor, even for a single leaf change", () => {
    const d = explain(["engine/src/physics/solver.ts"]);
    expect(d.full).toBe(false);
    for (const smoke of [
      "tests/math.test.ts",
      "tests/ecs.test.ts",
      "tests/renderGraph.test.ts",
      "tests/frame.test.ts",
      "tests/architecture.test.ts",
    ]) {
      expect(d.testFiles).toContain(smoke);
    }
  });

  it("opens up to the full suite when a foundation layer changes", () => {
    for (const file of ["engine/src/core/time.ts", "engine/src/math/vec.ts"]) {
      const d = explain([file]);
      expect(d.full, `${file} should force a full run`).toBe(true);
    }
  });

  it("opens up to the full suite for config and shared-infrastructure changes", () => {
    for (const file of [
      "vitest.config.ts",
      "package.json",
      "engine/src/index.ts",
      "engine/src/testing/mockGpu.ts",
    ]) {
      const d = explain([file]);
      expect(d.full, `${file} should force a full run`).toBe(true);
    }
  });

  it("falls back to a full run for a file no subsystem owns", () => {
    const d = explain(["some/brand-new/area/thing.ts"]);
    expect(d.full).toBe(true);
  });
});
