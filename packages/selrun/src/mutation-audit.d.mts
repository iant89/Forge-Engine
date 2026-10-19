export interface LiteralMutationPatch {
  readonly search: string;
  readonly replacement: string;
  readonly count?: number;
}

export interface MutationCase {
  readonly name?: string;
  readonly file: string;
  readonly replace?: readonly LiteralMutationPatch[];
  readonly operators?: readonly ("comparison-boundary" | "comparison-swap" | "boolean" | "arithmetic")[];
  readonly startLine?: number;
  readonly endLine?: number;
}

export interface SuiteMutationResult {
  readonly file: string;
  readonly passed: boolean;
  readonly durationMs: number;
  readonly status: number | null;
  readonly timedOut: boolean;
  readonly error: string | null;
  readonly output: string;
}

export function applyMutation(root: string, mutation: MutationCase): { file: string; patchCount: number };
export function compareMutationResults(baselineFailures: Iterable<string>, mutantFailures: Iterable<string>, selectedSuites: Iterable<string>): {
  readonly newlyFailing: string[];
  readonly caught: string[];
  readonly falseNegatives: string[];
  readonly falsePositives: string[];
  readonly survived: boolean;
};
export function generateMutationCases(root: string, definitions: readonly MutationCase[], options?: { maxMutants?: number }): {
  readonly mutations: MutationCase[];
  readonly generatedCount: number;
  readonly truncatedCount: number;
};
export function runBounded<T, R>(items: readonly T[], concurrency: number, handler: (item: T, index: number) => R | Promise<R>): Promise<R[]>;
export function copyWorkspace(sourceRoot: string, destinationRoot: string): void;
export function runSuiteSet(root: string, suiteFiles: readonly string[], options?: { timeoutMs?: number; concurrency?: number; phase?: string; onProgress?: (progress: { phase: string; completed: number; total: number; file: string; result: SuiteMutationResult }) => void }): Promise<SuiteMutationResult[]>;
export function auditMutations(root: string, mutations: readonly MutationCase[], options?: { timeoutMs?: number; concurrency?: number; maxMutants?: number; onProgress?: (progress: { phase: string; completed: number; total: number; file: string; result: SuiteMutationResult }) => void }): Promise<{
  readonly baselineFailures: string[];
  readonly baselineDurationMs: number;
  readonly scenarios: Array<{
    readonly name: string;
    readonly changedFile: string;
    readonly patchCount: number;
    readonly selectedCount: number;
    readonly baselineFailures: number;
    readonly newlyFailing: string[];
    readonly failureDetails?: Array<{ readonly file: string; readonly summary: string }>;
    readonly caught: string[];
    readonly falseNegatives: string[];
    readonly falsePositives: string[];
    readonly survived: boolean;
    readonly caughtAll: boolean;
    readonly fullSuiteDurationMs: number;
    readonly fullSuiteResults: SuiteMutationResult[];
    readonly selectionFallback: boolean;
    readonly fallbackReason: string | null;
  }>;
  readonly summary: {
    readonly generatedMutants: number;
    readonly truncatedMutants: number;
    readonly totalMutants: number;
    readonly detectableMutants: number;
    readonly caughtMutants: number;
    readonly survivedMutants: number;
    readonly falseNegativeChecks: number;
    readonly detectedChecks: number;
    readonly mutationRecall: number | null;
    readonly totalDurationMs: number;
  };
}>;
export function formatMutationAudit(audit: Awaited<ReturnType<typeof auditMutations>>): string;
export function readMutationFile(file: string): MutationCase[];
