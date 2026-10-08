export interface SelectableSuite {
  readonly file: string;
  readonly covers: readonly string[];
}

export interface SelectionReason {
  readonly kind: "suite" | "covers" | "test-import";
  readonly path: string;
  readonly claim?: string;
}

export interface SuiteSelection<T extends SelectableSuite> {
  readonly changedPaths: string[];
  readonly suites: T[];
  readonly reasons: Map<string, SelectionReason>;
}

export interface ImportEdge {
  readonly specifier: string;
  readonly target: string | null;
}

export function normalizePath(file: string, root?: string): string;
export function globMatches(file: string, pattern: string): boolean;
export function matchesCover(changedPath: string, cover: string, root?: string): boolean;
export function staticSpecifiers(source: string, fileName?: string): string[];
export function resolveProjectSpecifier(specifier: string, importer: string, root?: string): string | null;
export function staticImportClosure(suiteFile: string, root?: string): { files: Set<string>; graph: Map<string, ImportEdge[]> };
export function selectSuitesForChanges<T extends SelectableSuite>(suites: readonly T[], changedPaths: readonly string[], root?: string): SuiteSelection<T>;
export function parseNameStatusZ(output: string): string[];
export function collectWorkingChanges(root?: string): string[];
export function collectBaseChanges(base: string, root?: string): string[];
export function formatPath(file: string): string;
