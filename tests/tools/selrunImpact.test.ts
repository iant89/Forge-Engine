/**
 * @suite tools:selrunImpact
 * @group unit
 * @covers packages/selrun/src/impact.mjs
 * @covers packages/selrun/src/mutation-audit.mjs
 * @covers packages/selrun/src/selection.mjs
 * @covers packages/selrun/src/subsystems.mjs
 * @covers packages/selrun/src/cli.mjs
 * @covers docs/TESTING.md
 * @desc Fail-safe selection: transitive impact, subsystem mapping, smoke floor, fallback, and accuracy tracking.
 */

export const suite = {
  name: "tools:selrunImpact",
  group: "unit",
  covers: [
    "packages/selrun/src/impact.mjs",
    "packages/selrun/src/mutation-audit.mjs",
    "packages/selrun/src/selection.mjs",
    "packages/selrun/src/subsystems.mjs",
    "packages/selrun/src/cli.mjs",
    "docs/TESTING.md",
  ],
  desc: "Fail-safe selection: transitive impact, subsystem mapping, smoke floor, fallback, and accuracy tracking.",
};

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { finish, group, test } from "selrun";
import { validateCatalog } from "../../packages/selrun/src/catalog.mjs";
import {
  buildProjectGraph,
  findTransitiveDependents,
  findUnmappedProductionFiles,
  assessChangeConfidence,
  selectWithImpact,
  selectSuitesForChanges,
  mapFileToSubsystem,
  subsystemsForChanges,
  measureAccuracy,
  wouldCatchRegression,
  parseNameStatusZ,
} from "../../packages/selrun/src/selection.mjs";
import { SMOKE_FLOOR, SUBSYSTEMS, isFallbackFile, isFoundationFile, subsystemForFile } from "../../packages/selrun/src/subsystems.mjs";
import { applyMutation, compareMutationResults, formatMutationAudit, generateMutationCases, runBounded } from "../../packages/selrun/src/mutation-audit.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const repoCatalog = validateCatalog(repoRoot);
const repoSuites = repoCatalog.suites.map((suite) => ({ ...suite, covers: suite.covers ?? [] }));
const repoGraph = buildProjectGraph(repoRoot);

group("subsystem mapping and smoke floor", () => {
  test("maps engine files to subsystems and leaves docs/tests unmapped for config", () => {
    assert.equal(subsystemForFile("engine/src/math/vec.ts"), "math");
    assert.equal(subsystemForFile("engine/src/rendering/renderer.ts"), "rendering");
    assert.equal(subsystemForFile("engine/src/terrain/pipelineSpec.ts"), "terrain");
    assert.equal(subsystemForFile("engine/src/scene/world.ts"), "scene");
    assert.equal(subsystemForFile("editor/src/session.ts"), "editor");
    assert.equal(subsystemForFile("engine/api-surface.json"), "engine-barrel");
    assert.equal(subsystemForFile("tools/browser-check.mjs"), "tools");
    assert.equal(subsystemForFile("package.json"), "config");
    assert.equal(mapFileToSubsystem("engine/src/math/vec.ts"), "math");
    const subs = subsystemsForChanges(["engine/src/math/vec.ts", "engine/src/rendering/renderer.ts"]);
    assert.ok(subs.has("math"));
    assert.ok(subs.has("rendering"));
    assert.equal(subs.size, 2);
  });

  test("smoke floor is 5 suites and always included even for empty change set", () => {
    assert.equal(SMOKE_FLOOR.length, 5);
    assert.ok(SMOKE_FLOOR.includes("tests/engine/architecture.test.ts"));
    assert.ok(SMOKE_FLOOR.includes("tests/math/math.test.ts"));
    assert.ok(SMOKE_FLOOR.includes("tests/tools/selrun.test.ts"));

    const suites = repoSuites;
    const graph = repoGraph;
    const empty = selectWithImpact(suites, [], { root: repoRoot, graph });
    assert.equal(empty.suites.length, 5);
    assert.ok(empty.suites.some((s) => s.file === "tests/engine/architecture.test.ts"));
    assert.equal(empty.smokeAdded.length, 5);
    assert.equal(empty.fallback, false);
  });

  test("missing smoke-floor metadata forces the full available catalog", () => {
    const incomplete = repoSuites.filter((suite) => suite.file !== "tests/math/math.test.ts");
    const selection = selectWithImpact(incomplete, [], { root: repoRoot, graph: repoGraph });
    assert.equal(selection.fallback, true);
    assert.match(selection.assessment.reason ?? "", /smoke floor metadata missing/);
    assert.equal(selection.suites.length, incomplete.length);
  });

  test("smoke floor is added when affected scope is narrow (leaf change)", () => {
    const suites = repoSuites;
    const graph = repoGraph;
    // Leaf change that would otherwise select only 2 suites
    const leaf = selectWithImpact(suites, ["engine/src/particles/components.ts"], { root: repoRoot, graph });
    assert.ok(leaf.suites.some((s) => s.file === "tests/engine/architecture.test.ts"), "smoke floor must be present");
    assert.ok(leaf.suites.some((s) => s.file === "tests/math/math.test.ts"));
    assert.ok(leaf.evidenceCounts.smoke >= 1);
  });

  test("editor source is owned and selects its suite plus the architecture smoke", () => {
    const selection = selectWithImpact(repoSuites, ["editor/src/session.ts"], { root: repoRoot, graph: repoGraph });
    assert.equal(selection.fallback, false);
    assert.ok(selection.suites.some((suite) => suite.file === "tests/editor/editor.test.ts"));
    assert.ok(selection.suites.some((suite) => suite.file === "tests/engine/architecture.test.ts"));
  });

  test("the API snapshot is owned and selects its audit suite", () => {
    const selection = selectWithImpact(repoSuites, ["engine/api-surface.json"], { root: repoRoot, graph: repoGraph });
    assert.equal(selection.fallback, false);
    assert.ok(selection.suites.some((suite) => suite.file === "tests/tools/apiAudit.test.ts"));
    assert.ok(selection.suites.some((suite) => suite.file === "tests/engine/architecture.test.ts"));
  });

  test("every subsystem has at least one file and the production source map has no gaps", () => {
    assert.deepEqual(findUnmappedProductionFiles(repoRoot), [], "new production source paths must be mapped before affected selection is trusted");
    assert.ok(Object.keys(SUBSYSTEMS).length >= 15);
    assert.ok(SUBSYSTEMS["math"].includes("engine/src/math/**"));
    assert.ok(SUBSYSTEMS["rendering"].includes("engine/src/rendering/**"));
    assert.ok(SUBSYSTEMS["editor"].includes("editor/src/**"));
  });
});

group("transitive dependency impact", () => {
  test("shared transform utility expands selection across subsystems", () => {
    const suites = repoSuites;
    const graph = repoGraph;
    const legacy = selectSuitesForChanges(suites, ["engine/src/math/transform.ts"], repoRoot);
    const safe = selectWithImpact(suites, ["engine/src/math/transform.ts"], { root: repoRoot, graph });
    // Legacy only selects direct covers (2 suites)
    assert.equal(legacy.suites.length, 2);
    assert.ok(legacy.suites.some((s) => s.file === "tests/math/math.test.ts"));
    // Safe selector must expand to downstream consumers (entity transforms, camera, vehicle, terrain, rendering)
    assert.ok(safe.suites.length > legacy.suites.length, "transform must expand beyond direct covers");
    assert.ok(safe.suites.length > 50, "transform is foundation — should select many suites");
    assert.ok(safe.evidenceCounts.transitive > 0);
    // Check downstream examples: transform is used by mechanical, scene, etc.
    const hasAnimation = safe.suites.some((s) => s.file === "tests/animation/mechanicalAnimation.test.ts");
    const hasScene = safe.suites.some((s) => s.file === "tests/scene/ecs.test.ts");
    assert.ok(hasAnimation || hasScene, "transform downstream should include animation or scene");
  });

  test("leaf file does not over-select via transitive (particles leaf vs rendering)", () => {
    const suites = repoSuites;
    const graph = repoGraph;
    const safe = selectWithImpact(suites, ["engine/src/particles/components.ts"], { root: repoRoot, graph });
    // Leaf should select subsystem + smoke, not full suite
    assert.ok(safe.suites.length < 30, `leaf should not select half the suite, got ${safe.suites.length}`);
    // Should not include unrelated rendering suite that doesn't depend on particles
    // But may include rendering if rendering depends on particles (it shouldn't)
    const hasClusters = safe.suites.some((s) => s.file === "tests/rendering/clusters.test.ts");
    // We allow some subsystem spill but not full
    if (hasClusters) {
      // If it does include, it must be via subsystem not transitive cross-subsystem
      const reason = safe.reasons.get("tests/rendering/clusters.test.ts");
      // Should not be transitive from particles to rendering
      if (reason) assert.notEqual(reason.kind, "transitive");
    }
  });

  test("buildProjectGraph finds transitive dependents via import graph", () => {
    const graph = repoGraph;
    // vec is imported by many files, so its reverse should be large
    const vecDependents = graph.reverse.get("engine/src/math/vec.ts");
    assert.ok(vecDependents && vecDependents.size > 10, "vec should have many dependents");
    // A leaf like particles/components should have few dependents
    const leafDependents = graph.reverse.get("engine/src/particles/components.ts");
    assert.ok(leafDependents && leafDependents.size <= 5, "leaf should have few dependents");
    // Transitive for transform should include scene/world.ts
    const trans = findTransitiveDependents(["engine/src/math/transform.ts"], graph.reverse);
    assert.ok(trans.has("engine/src/scene/world.ts") || trans.has("engine/src/animation/mechanical.ts"), "transform transitive should include scene or animation");
  });

  test("handles re-exports (export * from) via staticSpecifiers", () => {
    const root = mkdtempSync(path.join(tmpdir(), "selrun-reexport-"));
    try {
      mkdirSync(path.join(root, "src"), { recursive: true });
      writeFileSync(path.join(root, "src", "leaf.ts"), "export const value = 42;\n");
      writeFileSync(path.join(root, "src", "reexport.ts"), 'export * from "./leaf.js";\n');
      writeFileSync(path.join(root, "src", "consumer.ts"), 'import { value } from "./reexport.js";\nconsole.log(value);\n');
      const graph = buildProjectGraph(root);
      // consumer depends on reexport which depends on leaf
      const leafDependents = findTransitiveDependents(["src/leaf.ts"], graph.reverse);
      assert.ok(leafDependents.has("src/reexport.ts"));
      assert.ok(leafDependents.has("src/consumer.ts"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("changed exports expand selection via transitive (mechanical -> transform)", () => {
    const suites = repoSuites;
    const graph = repoGraph;
    // Simulate that mechanical.ts changes its exports (adds new joint type)
    // Its dependents are those that import mechanical, but also its own dependencies like transform
    // Changing mechanical should select suites covering mechanical and its dependents
    const safe = selectWithImpact(suites, ["engine/src/animation/mechanical.ts"], { root: repoRoot, graph });
    assert.ok(safe.suites.some((s) => s.file === "tests/animation/mechanicalAnimation.test.ts"));
    // Also check that a file that depends on mechanical (if any) would be selected
    // For now, at least direct covers should be selected
    const legacy = selectSuitesForChanges(suites, ["engine/src/animation/mechanical.ts"], repoRoot);
    assert.ok(legacy.suites.some((s) => s.file === "tests/animation/mechanicalAnimation.test.ts"));
    assert.ok(safe.suites.length >= legacy.suites.length);
  });
});

group("fallback to broader testing", () => {
  test("config changes fall back to full suite", () => {
    const suites = repoSuites;
    const graph = repoGraph;
    for (const configFile of ["package.json", "package-lock.json", "engine/package.json", "tsconfig.base.json", ".github/workflows/ci.yml", "scripts/setup-deps.sh"]) {
      const result = selectWithImpact(suites, [configFile], { root: repoRoot, graph });
      if (isFallbackFile(configFile)) {
        assert.equal(result.fallback, true, `${configFile} should fallback`);
        assert.equal(result.suites.length, repoCatalog.suites.length);
        assert.match(result.assessment.reason ?? "", /config change/);
      }
    }
  });

  test("deleted production file falls back to full suite", () => {
    const suites = repoSuites;
    const graph = repoGraph;
    const result = selectWithImpact(suites, ["engine/src/math/deleted.ts"], { root: repoRoot, graph });
    assert.equal(result.fallback, true);
    assert.match(result.assessment.reason ?? "", /deleted production file/);
    assert.equal(result.suites.length, repoCatalog.suites.length);
  });

  test("unowned file falls back to full suite", () => {
    const suites = repoSuites;
    const graph = repoGraph;
    // Create a synthetic unowned file scenario: file in no subsystem
    const result = selectWithImpact(suites, ["engine/src/unknown/newFeature.ts"], { root: repoRoot, graph });
    // This file is not in repo, so it's missing -> fallback
    assert.equal(result.fallback, true);
  });

  test("large change set (>20 files) falls back to full suite", () => {
    const suites = repoSuites;
    const graph = repoGraph;
    const manyFiles = Array.from({ length: 21 }, (_, i) => `engine/src/math/file${i}.ts`);
    const result = selectWithImpact(suites, manyFiles, { root: repoRoot, graph });
    assert.equal(result.fallback, true);
    assert.match(result.assessment.reason ?? "", /large change set/);
  });

  test("assessChangeConfidence separates direct vs fallback vs expanded", () => {
    assert.equal(assessChangeConfidence(["engine/src/math/transform.ts"], repoRoot).scope, "transitive");
    assert.equal(assessChangeConfidence(["engine/src/rendering/renderer.ts"], repoRoot).scope, "direct");
    assert.equal(assessChangeConfidence(["package.json"], repoRoot).fallback, true);
    assert.equal(assessChangeConfidence(["engine/src/missing.ts"], repoRoot).fallback, true);
  });

  test("fallback is conservative: extra suites are preferable to missing regression", () => {
    const suites = repoSuites;
    const graph = repoGraph;
    const safe = selectWithImpact(suites, ["engine/src/math/transform.ts"], { root: repoRoot, graph });
    const legacy = selectSuitesForChanges(suites, ["engine/src/math/transform.ts"], repoRoot);
    // Safe should be >= legacy
    assert.ok(safe.suites.length >= legacy.suites.length);
    // All legacy suites must be in safe
    for (const s of legacy.suites) {
      assert.ok(safe.suites.some((x) => x.file === s.file), `safe must include legacy suite ${s.file}`);
    }
  });
});

group("renamed, deleted, and re-export handling", () => {
  test("retains both sides of rename/copy records", () => {
    const changed = parseNameStatusZ([
      "M", "src/modified.ts",
      "R100", "src/old-name.ts", "src/new-name.ts",
      "C100", "src/copy-source.ts", "src/copied.ts",
      "D", "src/deleted.ts",
      "A", "src/added.ts",
      "",
    ].join("\0"));
    assert.deepEqual(changed, [
      "src/modified.ts",
      "src/old-name.ts",
      "src/new-name.ts",
      "src/copy-source.ts",
      "src/copied.ts",
      "src/deleted.ts",
      "src/added.ts",
    ]);
  });

  test("rename within same subsystem is treated as move, not deletion", () => {
    const suites = repoSuites;
    const graph = repoGraph;
    // Simulate rename: old file missing, new file exists and in same subsystem
    // We can't create actual rename on disk without git, but we test assessment logic
    const assessment = assessChangeConfidence(
      ["engine/src/math/old-vec.ts", "engine/src/math/vec.ts"],
      repoRoot,
    );
    // Should not be fallback because new counterpart exists in same subsystem
    assert.equal(assessment.fallback, false);
    const result = selectWithImpact(suites, ["engine/src/math/old-vec.ts", "engine/src/math/vec.ts"], { root: repoRoot, graph });
    assert.equal(result.fallback, false);
    assert.ok(result.suites.length < repoCatalog.suites.length, "rename within subsystem should not fallback to full");
  });

  test("re-export chain propagates correctly for transform example", () => {
    const graph = repoGraph;
    // transform is imported by mechanical.ts and scene/world.ts
    const mechanicalDeps = graph.graph.get("engine/src/animation/mechanical.ts")?.deps;
    assert.ok(mechanicalDeps?.includes("engine/src/math/transform.ts") || mechanicalDeps?.some((d) => d.includes("transform")));
    const closureForMechanical = (() => {
      const visited = new Set<string>();
      const queue = ["engine/src/animation/mechanical.ts"];
      visited.add(queue[0]);
      while (queue.length) {
        const cur = queue.shift()!;
        for (const dep of graph.graph.get(cur)?.deps ?? []) {
          if (!visited.has(dep)) {
            visited.add(dep);
            queue.push(dep);
          }
        }
      }
      return visited;
    })();
    assert.ok(closureForMechanical.has("engine/src/math/transform.ts"));
  });
});

group("accuracy tracking: false negatives vs false positives", () => {
  test("applies literal mutations only in the supplied disposable workspace and rejects ambiguous patches", () => {
    const root = mkdtempSync(path.join(tmpdir(), "selrun-mutation-helper-"));
    try {
      mkdirSync(path.join(root, "src"), { recursive: true });
      writeFileSync(path.join(root, "src/value.ts"), "export const value = 1;\\n");
      const applied = applyMutation(root, {
        name: "change numeric result",
        file: "src/value.ts",
        replace: [{ search: "value = 1", replacement: "value = 2" }],
      });
      assert.deepEqual(applied, { file: "src/value.ts", patchCount: 1 });
      assert.equal(readFileSync(path.join(root, "src/value.ts"), "utf8"), "export const value = 2;\\n");
      assert.throws(() => applyMutation(root, {
        file: "src/value.ts",
        replace: [{ search: "missing", replacement: "changed" }],
      }), /expected 1 match/);
      assert.throws(() => applyMutation(root, {
        file: "../escape.ts",
        replace: [{ search: "a", replacement: "b" }],
      }), /invalid mutation path|escapes workspace/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("generates bounded, deterministic operator mutants without changing source", () => {
    const root = mkdtempSync(path.join(tmpdir(), "selrun-operator-helper-"));
    try {
      writeFileSync(path.join(root, "sample.ts"), `export const sample = (x: number) => x < 4 && true + 1; // > ignored\nconst text = '==';\n`);
      const source = readFileSync(path.join(root, "sample.ts"), "utf8");
      const result = generateMutationCases(root, [{
        name: "sample operators",
        file: "sample.ts",
        operators: ["comparison-boundary", "boolean", "arithmetic"],
      }, {
        name: "sample swapped comparisons",
        file: "sample.ts",
        operators: ["comparison-swap"],
      }], { maxMutants: 20 });
      assert.equal(readFileSync(path.join(root, "sample.ts"), "utf8"), source);
      assert.ok(result.generatedCount >= 5);
      assert.equal(result.truncatedCount, 0);
      assert.ok(result.mutations.some((mutation) => mutation.name?.includes("comparison-boundary")));
      assert.ok(result.mutations.some((mutation) => mutation.name?.includes("boolean")));
      assert.ok(result.mutations.some((mutation) => mutation.name?.includes("arithmetic")));
      assert.ok(result.mutations.every((mutation) => mutation.replace?.length === 1));
      const scoped = generateMutationCases(root, [{
        file: "sample.ts",
        operators: ["comparison-boundary", "boolean", "arithmetic"],
        startLine: 1,
        endLine: 1,
      }]);
      assert.equal(scoped.generatedCount, 4);

      const capped = generateMutationCases(root, [{
        file: "sample.ts",
        operators: ["comparison-boundary", "comparison-swap", "boolean", "arithmetic"],
      }], { maxMutants: 2 });
      assert.equal(capped.generatedCount, 2);
      assert.ok(capped.truncatedCount > 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("bounds parallel work and preserves result order", async () => {
    let active = 0;
    let highWater = 0;
    const results = await runBounded([0, 1, 2, 3, 4, 5], 2, async (value) => {
      active++;
      highWater = Math.max(highWater, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active--;
      return value * 2;
    });
    assert.equal(highWater, 2);
    assert.deepEqual(results, [0, 2, 4, 6, 8, 10]);
  });

  test("compares real mutant failures against baseline, selected suites, and extra runs", () => {
    const compared = compareMutationResults(
      ["tests/core/tasks.test.ts"],
      ["tests/core/tasks.test.ts", "tests/math/math.test.ts", "tests/scene/ecs.test.ts"],
      ["tests/math/math.test.ts", "tests/tools/selrun.test.ts"],
    );
    assert.deepEqual(compared.newlyFailing, ["tests/math/math.test.ts", "tests/scene/ecs.test.ts"]);
    assert.deepEqual(compared.caught, ["tests/math/math.test.ts"]);
    assert.deepEqual(compared.falseNegatives, ["tests/scene/ecs.test.ts"]);
    assert.deepEqual(compared.falsePositives, ["tests/tools/selrun.test.ts"]);
    assert.equal(compared.survived, false);

    const survived = compareMutationResults([], [], ["tests/math/math.test.ts"]);
    assert.equal(survived.survived, true);
  });

  test("formats detected, missed, and surviving mutation audit results", () => {
    const report = formatMutationAudit({
      baselineFailures: [],
      baselineDurationMs: 10,
      scenarios: [{
        name: "clamp lower bound",
        changedFile: "engine/src/math/scalar.ts",
        patchCount: 1,
        selectedCount: 3,
        baselineFailures: 0,
        newlyFailing: ["tests/math/math.test.ts"],
        caught: ["tests/math/math.test.ts"],
        falseNegatives: [],
        falsePositives: ["tests/scene/ecs.test.ts"],
        survived: false,
        caughtAll: true,
        fullSuiteDurationMs: 1_000,
        fullSuiteResults: [],
        selectionFallback: false,
        fallbackReason: null,
      }],
      summary: {
        generatedMutants: 0,
        truncatedMutants: 0,
        totalMutants: 1,
        detectableMutants: 1,
        caughtMutants: 1,
        survivedMutants: 0,
        falseNegativeChecks: 0,
        detectedChecks: 1,
        mutationRecall: 1,
        totalDurationMs: 1_010,
      },
    });
    assert.match(report, /MUTATION AUDIT/);
    assert.match(report, /CAUGHT · clamp lower bound/);
    assert.match(report, /Mutation recall  100.0%/);
    assert.match(report, /False-negative suite checks  0/);
  });

  test("measureAccuracy separates false negatives from false positives", () => {
    const suites = repoSuites;
    const graph = repoGraph;
    const selection = selectWithImpact(suites, ["engine/src/math/transform.ts"], { root: repoRoot, graph });

    // Simulate full suite results: 3 suites would fail
    const fullResults = new Map<string, { passed: boolean }>();
    for (const suite of repoCatalog.suites) fullResults.set(suite.file, { passed: true });
    // Inject regressions that should be caught
    fullResults.set("tests/math/math.test.ts", { passed: false });
    fullResults.set("tests/scene/ecs.test.ts", { passed: false });
    fullResults.set("tests/rendering/pipeline.test.ts", { passed: false });
    // Also a suite that is not selected but would fail — false negative
    fullResults.set("tests/physics/physics.test.ts", { passed: false });
    // Force physics to be not selected for this test by using a narrow selection
    const narrowSelection = { suites: selection.suites.filter((s) => s.file !== "tests/physics/physics.test.ts") } as any;
    const accuracy = measureAccuracy(narrowSelection, fullResults, suites);
    assert.equal(accuracy.falseNegatives, 1);
    assert.ok(accuracy.falseNegativeSuites.includes("tests/physics/physics.test.ts"));
    assert.equal(accuracy.falseNegativeRate, 1 / 4); // 1 missed out of 4 failing
    assert.equal(accuracy.precision, 3 / narrowSelection.suites.length);
  });

  test("wouldCatchRegression checks if injected regression is caught", () => {
    const suites = repoSuites;
    const graph = repoGraph;
    const selection = selectWithImpact(suites, ["engine/src/math/transform.ts"], { root: repoRoot, graph });
    const result = wouldCatchRegression(selection, ["tests/math/math.test.ts", "tests/scene/ecs.test.ts"]);
    assert.equal(result.caught, true);
    assert.equal(result.missed.length, 0);
    // Now test a regression that would be missed by narrow selector
    const narrow = selectSuitesForChanges(suites, ["engine/src/math/transform.ts"], repoRoot);
    const missed = wouldCatchRegression(narrow, ["tests/scene/ecs.test.ts"]);
    // Legacy narrow selector misses scene/ecs because it only covers direct
    assert.equal(missed.caught, false);
    assert.ok(missed.missed.includes("tests/scene/ecs.test.ts"));
  });

  test("conservative selector prefers false positives over false negatives", () => {
    const suites = repoSuites;
    const graph = repoGraph;
    const safe = selectWithImpact(suites, ["engine/src/math/transform.ts"], { root: repoRoot, graph });
    const legacy = selectSuitesForChanges(suites, ["engine/src/math/transform.ts"], repoRoot);
    // Safe selects more (false positives) but catches regressions (fewer false negatives)
    assert.ok(safe.suites.length > legacy.suites.length);
    // For transform, safe should include at least one downstream that legacy misses
    const extra = safe.suites.filter((s) => !legacy.suites.some((l) => l.file === s.file));
    assert.ok(extra.length > 0);
    assert.ok(extra.some((s) => s.file.includes("scene") || s.file.includes("rendering") || s.file.includes("vehicles")));
  });

  test("tracks selection accuracy for shared utility vs leaf", () => {
    const suites = repoSuites;
    const graph = repoGraph;
    // Shared utility: transform should have high recall (catch many regressions)
    const shared = selectWithImpact(suites, ["engine/src/math/transform.ts"], { root: repoRoot, graph });
    assert.ok(shared.suites.length > 80);
    // Leaf: particles/components should have moderate recall, not over-select
    const leaf = selectWithImpact(suites, ["engine/src/particles/components.ts"], { root: repoRoot, graph });
    assert.ok(leaf.suites.length < 30);
    assert.ok(leaf.suites.length > 2); // more than direct but not huge
  });

  test("isFoundationFile and isFallbackFile correctly classify", () => {
    assert.equal(isFoundationFile("engine/src/math/transform.ts"), true);
    assert.equal(isFoundationFile("engine/src/rendering/renderer.ts"), false);
    assert.equal(isFallbackFile("package.json"), true);
    assert.equal(isFallbackFile("engine/src/math/vec.ts"), false);
    assert.equal(isFallbackFile(".github/workflows/ci.yml"), true);
  });
});

await finish();
