export interface SuiteHeader {
  readonly suite: string[];
  readonly group: string[];
  readonly covers: string[];
  readonly desc: string[];
}

export interface SuiteManifest {
  readonly name: string | null;
  readonly group: string | null;
  readonly covers: string[] | null;
  readonly desc: string | null;
}

export interface ReadSuiteResult {
  readonly file: string;
  readonly header: SuiteHeader | null;
  readonly manifest: SuiteManifest | null;
  readonly parseErrors: readonly unknown[];
}

export interface SuiteLink {
  readonly file: string | null;
  readonly importPath: string | null;
}

export interface CatalogResult {
  readonly errors: string[];
  readonly suites: Array<{ file: string } & SuiteManifest>;
  readonly linkedSuites: string[];
  readonly stats: {
    readonly suitesOnDisk: number;
    readonly suitesLinked: number;
    readonly suitesNamed: number;
    readonly suitesWithCoverage: number;
    readonly coverageClaims: number;
  };
}

export function readSuiteManifest(file: string, root?: string): ReadSuiteResult;
export function discoverSuiteFiles(root?: string): string[];
export function readLinkedSuites(root?: string): {
  readonly links: SuiteLink[];
  readonly reportCounts: Array<number | null>;
  readonly parseErrors: readonly unknown[];
  readonly source: string;
};
export function validateCatalog(root?: string): CatalogResult;
