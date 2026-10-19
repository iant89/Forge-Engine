import type { ProjectGraph, SafeSuiteSelection, SelectableSuite } from "./selection.mjs";
export { SMOKE_FLOOR, SUBSYSTEMS, FALLBACK_PATTERNS, FOUNDATION_FILES, subsystemForFile, isFallbackFile, isFoundationFile } from "./subsystems.mjs";
export { buildProjectGraph, findTransitiveDependents, assessChangeConfidence, mapFileToSubsystem, subsystemsForChanges, selectWithImpact, selectSuitesForChangesSafe, measureAccuracy, wouldCatchRegression } from "./selection.mjs";
export function auditScenarios<T extends SelectableSuite>(suites: readonly T[], scenarios: Array<{ name: string; changedFiles: string[]; expectedFailingSuites: string[] }>, root?: string): {
  readonly total: number;
  readonly caught: number;
  readonly missed: number;
  readonly falseNegativeScenarios: Array<{ name: string; changedFiles: string[]; selectedCount: number; expectedFailing: number; missed: string[]; caught: boolean; fallback: boolean; reason: string | null }>;
  readonly results: Array<{ name: string; changedFiles: string[]; selectedCount: number; expectedFailing: number; missed: string[]; caught: boolean; fallback: boolean; reason: string | null }>;
};
