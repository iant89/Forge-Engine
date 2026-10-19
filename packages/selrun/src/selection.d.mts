export interface SelectableSuite {
  readonly file: string;
  readonly covers: readonly string[];
}

export interface SelectionReason {
  readonly kind: "suite" | "covers" | "test-import" | "transitive" | "subsystem" | "smoke" | "fallback";
  readonly path: string;
  readonly claim?: string;
  readonly via?: string;
  readonly subsystem?: string;
  readonly reason?: string;
}

export interface SuiteSelection<T extends SelectableSuite> {
  readonly changedPaths: string[];
  readonly suites: T[];
  readonly reasons: Map<string, SelectionReason>;
}

export interface ImpactAssessment {
  readonly fallback: boolean;
  readonly reason: string | null;
  readonly scope: "direct" | "transitive" | "full";
  readonly expanded?: boolean;
  readonly matchedFile?: string;
  readonly foundationHits?: string[];
  readonly missing?: string[];
  readonly unowned?: string[];
}

export interface SafeSuiteSelection<T extends SelectableSuite> extends SuiteSelection<T> {
  readonly assessment: ImpactAssessment;
  readonly fallback: boolean;
  readonly smokeAdded: T[];
  readonly transitiveDependents: string[];
  readonly impactedSubsystems: string[];
  readonly evidenceCounts: Record<string, number>;
}

export interface ImportEdge {
  readonly specifier: string;
  readonly target: string | null;
}

export interface ProjectGraph {
  readonly graph: Map<string, { deps: string[]; specifiers: string[]; unresolved: string[]; parseError?: boolean }>;
  readonly reverse: Map<string, Set<string>>;
  readonly allFiles: string[];
}

export function normalizePath(file: string, root?: string): string;
export function globMatches(file: string, pattern: string): boolean;
export function matchesCover(changedPath: string, cover: string, root?: string): boolean;
export function staticSpecifiers(source: string, fileName?: string): string[];
export function resolveProjectSpecifier(specifier: string, importer: string, root?: string): string | null;
export function staticImportClosure(suiteFile: string, root?: string): { files: Set<string>; graph: Map<string, ImportEdge[]> };
export function selectSuitesForChanges<T extends SelectableSuite>(suites: readonly T[], changedPaths: readonly string[], root?: string): SuiteSelection<T>;
export function buildProjectGraph(root?: string): ProjectGraph;
export function findUnmappedProductionFiles(root?: string): string[];
export function findTransitiveDependents(changedFiles: string[], reverseGraph: Map<string, Set<string>>): Set<string>;
export function assessChangeConfidence(changedPaths: string[], root?: string): ImpactAssessment;
export function mapFileToSubsystem(file: string): string | null;
export function subsystemsForChanges(changedFiles: string[]): Set<string>;
export function selectWithImpact<T extends SelectableSuite>(suites: readonly T[], changedPaths: readonly string[], options?: { root?: string; graph?: ProjectGraph; assessment?: ImpactAssessment }): SafeSuiteSelection<T>;
export const selectSuitesForChangesSafe: typeof selectWithImpact;
export function measureAccuracy<T extends SelectableSuite>(selection: SuiteSelection<T>, fullResults: Map<string, { passed: boolean }>, allSuites: readonly T[]): {
  readonly total: number;
  readonly selected: number;
  readonly accuracy: number;
  readonly falseNegativeRate: number;
  readonly falsePositiveRate: number;
  readonly precision: number;
  readonly recall: number;
  readonly truePositives: number;
  readonly falsePositives: number;
  readonly trueNegatives: number;
  readonly falseNegatives: number;
  readonly falseNegativeSuites: string[];
  readonly falsePositiveSuites: string[];
};
export function wouldCatchRegression<T extends SelectableSuite>(selection: SuiteSelection<T>, knownFailingSuites: string[]): {
  readonly caught: boolean;
  readonly missed: string[];
  readonly caughtCount: number;
  readonly total: number;
};
export function parseNameStatusZ(output: string): string[];
export function collectWorkingChanges(root?: string): string[];
export function collectBaseChanges(base: string, root?: string): string[];
export function formatPath(file: string): string;
