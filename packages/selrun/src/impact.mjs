/**
 * Impact analysis re-exports and audit helpers.
 * Core graph logic lives in selection.mjs; this module provides
 * complementary auditor utilities for tracking selection accuracy.
 */

export {
  buildProjectGraph,
  findTransitiveDependents,
  assessChangeConfidence,
  mapFileToSubsystem,
  subsystemsForChanges,
  selectWithImpact,
  selectSuitesForChangesSafe,
  measureAccuracy,
  wouldCatchRegression,
} from "./selection.mjs";

export { SMOKE_FLOOR, SUBSYSTEMS, FALLBACK_PATTERNS, FOUNDATION_FILES, subsystemForFile, isFallbackFile, isFoundationFile } from "./subsystems.mjs";

import { buildProjectGraph, selectWithImpact } from "./selection.mjs";

/**
 * Run a synthetic audit: for each scenario, check if selector would catch regression.
 * Scenarios: array of { name, changedFiles, expectedFailingSuites }
 */
export function auditScenarios(suites, scenarios, root = process.cwd()) {
  const graph = buildProjectGraph(root);
  const results = [];
  for (const scenario of scenarios) {
    const selection = selectWithImpact(suites, scenario.changedFiles, { root, graph });
    const selectedFiles = new Set(selection.suites.map((s) => s.file));
    const missed = scenario.expectedFailingSuites.filter((f) => !selectedFiles.has(f));
    results.push({
      name: scenario.name,
      changedFiles: scenario.changedFiles,
      selectedCount: selection.suites.length,
      expectedFailing: scenario.expectedFailingSuites.length,
      missed,
      caught: missed.length === 0,
      fallback: selection.fallback,
      reason: selection.assessment?.reason,
    });
  }
  const total = results.length;
  const caught = results.filter((r) => r.caught).length;
  return {
    total,
    caught,
    missed: total - caught,
    falseNegativeScenarios: results.filter((r) => !r.caught),
    results,
  };
}
