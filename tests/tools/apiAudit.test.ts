/**
 * @suite tools:apiAudit
 * @group unit
 * @covers .github/workflows/ci.yml
 * @covers docs/API.md
 * @covers docs/API-REVIEW.md
 * @covers docs/API-REFERENCE.md
 * @covers docs/DEPRECATION.md
 * @covers docs/EXAMPLES.md
 * @covers docs/MIGRATION-1.0.md
 * @covers docs/VERSIONING.md
 * @covers engine/api-approvals.json
 * @covers engine/api-surface.json
 * @covers engine/package.json
 * @covers engine/README.md
 * @covers engine/src/index.ts
 * @covers engine/src/physics/backend.ts
 * @covers engine/src/physics/wasmMemory.ts
 * @covers package.json
 * @covers README.md
 * @covers tools/api-audit.mjs
 * @covers tools/api-reference.mjs
 * @covers tools/version-check.mjs
 * @desc Completed Phase 27.1 root-only inventory with exact approvals for every public candidate
 */

export const suite = {
  name: "tools:apiAudit",
  group: "unit",
  covers: [
    ".github/workflows/ci.yml",
    "docs/API.md",
    "docs/API-REVIEW.md",
    "docs/API-REFERENCE.md",
    "docs/DEPRECATION.md",
    "docs/EXAMPLES.md",
    "docs/MIGRATION-1.0.md",
    "docs/VERSIONING.md",
    "engine/api-approvals.json",
    "engine/api-surface.json",
    "engine/package.json",
    "engine/README.md",
    "engine/src/index.ts",
    "engine/src/physics/backend.ts",
    "engine/src/physics/wasmMemory.ts",
    "package.json",
    "README.md",
    "tools/api-audit.mjs",
    "tools/api-reference.mjs",
    "tools/version-check.mjs",
  ],
  desc: "Completed Phase 27.1 root-only inventory with exact approvals for every public candidate",
};

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, finish, group, test } from "selrun";

interface ApiExportRow {
  name: string;
  kind: "type" | "value" | "type-and-value";
  stability: "public" | "experimental" | "deprecated";
  declarationHash: string;
  contractHash: string;
}

interface ApiSurface {
  schema: string;
  package: string;
  packageVersion: string;
  entrypoint: string;
  signatureFormat: string;
  typescriptVersion: string;
  counts: {
    total: number;
    public: number;
    experimental: number;
    deprecated: number;
    internal: number;
    type: number;
    value: number;
    typeAndValue: number;
  };
  exports: ApiExportRow[];
}

interface ApiApprovals {
  schema: string;
  package: string;
  surfaceSchema: string;
  signatureFormat: string;
  policy: string;
  counts: {
    approved: number;
    pendingPublic: number;
    experimental: number;
    deprecated: number;
  };
  reviews: Array<{
    id: string;
    decision: string;
    summary: string;
    evidence: string[];
  }>;
  approvals: Array<{
    name: string;
    kind: ApiExportRow["kind"];
    declarationHash: string;
    contractHash: string;
    review: string;
  }>;
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const tool = path.join(root, "tools", "api-audit.mjs");
const snapshotFile = path.join(root, "engine", "api-surface.json");
const approvalsFile = path.join(root, "engine", "api-approvals.json");
const temporaryDirectories: string[] = [];

function snapshot(): ApiSurface {
  return JSON.parse(fs.readFileSync(snapshotFile, "utf8")) as ApiSurface;
}

function approvals(): ApiApprovals {
  return JSON.parse(fs.readFileSync(approvalsFile, "utf8")) as ApiApprovals;
}

function run(...args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [tool, ...args], { cwd: root, encoding: "utf8" });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function temporarySnapshot(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forge-api-audit-"));
  temporaryDirectories.push(directory);
  return path.join(directory, "api-surface.json");
}

function temporaryApprovalLedger(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forge-api-approval-"));
  temporaryDirectories.push(directory);
  return path.join(directory, "api-approvals.json");
}

function temporaryRepository(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forge-api-repository-"));
  temporaryDirectories.push(directory);
  fs.mkdirSync(path.join(directory, "engine"), { recursive: true });
  fs.cpSync(path.join(root, "engine", "src"), path.join(directory, "engine", "src"), { recursive: true });
  for (const file of ["package.json", "tsconfig.base.json"]) {
    fs.copyFileSync(path.join(root, file), path.join(directory, file));
  }
  for (const file of ["api-approvals.json", "api-surface.json", "package.json", "tsconfig.json"]) {
    fs.copyFileSync(path.join(root, "engine", file), path.join(directory, "engine", file));
  }
  const evidenceFiles = new Set(approvals().reviews.flatMap((review) => review.evidence));
  for (const file of evidenceFiles) {
    const destination = path.join(directory, file);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(path.join(root, file), destination);
  }
  fs.symlinkSync(path.join(root, "node_modules"), path.join(directory, "node_modules"), "dir");
  return directory;
}

function byName(surface: ApiSurface, name: string): ApiExportRow {
  const item = surface.exports.find((entry) => entry.name === name);
  assert.ok(item, `missing API export ${name}`);
  return item;
}

group("Phase 27 public API audit", () => {
  const pendingResult = (): ReturnType<typeof run> => ({ status: null, stdout: "", stderr: "beforeAll did not run" });
  let cleanResult = pendingResult();
  let staleResult = pendingResult();
  let directDriftResult = pendingResult();
  let transitiveDriftResult = pendingResult();
  let approvalDriftResult = pendingResult();
  let incompleteApprovalResult = pendingResult();
  let writeResult = pendingResult();
  let badOptionResult = pendingResult();
  let writtenSnapshotText = "";
  let preservedApprovalText = "";

  // Declaration emit is intentionally source-derived and takes several seconds. Prepare each CLI
  // scenario once under an explicit hook budget so a loaded CI runner cannot trip selrun's 20 s
  // per-case timer while spawnSync has the event loop blocked.
  beforeAll(() => {
    cleanResult = run();

    const stale = snapshot();
    const versionIndex = stale.exports.findIndex((entry) => entry.name === "VERSION");
    assert.ok(versionIndex >= 0);
    stale.exports.splice(versionIndex, 1);
    stale.counts.total--;
    stale.counts.public--;
    stale.counts.value--;
    const staleFile = temporarySnapshot();
    fs.writeFileSync(staleFile, `${JSON.stringify(stale, null, 2)}\n`);
    staleResult = run("--snapshot", staleFile);

    const directRepository = temporaryRepository();
    const transformFile = path.join(directRepository, "engine", "src", "scene", "components", "index.ts");
    const transformSource = fs.readFileSync(transformFile, "utf8");
    const transformMarker = "  setRotation(q: Quat): this {";
    assert.ok(transformSource.includes(transformMarker));
    fs.writeFileSync(transformFile, transformSource.replace(transformMarker, [
      "  phase27SignatureProbe(value: number): void {",
      "    void value;",
      "  }",
      "",
      transformMarker,
    ].join("\n")));
    directDriftResult = run(
      "--root",
      directRepository,
      "--snapshot",
      path.join(directRepository, "engine", "api-surface.json"),
    );

    const transitiveRepository = temporaryRepository();
    const configFile = path.join(transitiveRepository, "engine", "src", "core", "config.ts");
    const configSource = fs.readFileSync(configFile, "utf8");
    const configMarker = "  strict?: boolean;";
    assert.ok(configSource.includes(configMarker));
    fs.writeFileSync(configFile, configSource.replace(configMarker, `${configMarker}\n  phase27SignatureProbe?: number;`));
    transitiveDriftResult = run(
      "--root",
      transitiveRepository,
      "--snapshot",
      path.join(transitiveRepository, "engine", "api-surface.json"),
    );

    const approvalRepository = temporaryRepository();
    const errorsFile = path.join(approvalRepository, "engine", "src", "core", "errors.ts");
    const errorsSource = fs.readFileSync(errorsFile, "utf8");
    const errorsMarker = "  readonly details?: unknown;";
    assert.ok(errorsSource.includes(errorsMarker));
    fs.writeFileSync(
      errorsFile,
      errorsSource.replace(errorsMarker, `${errorsMarker}\n  readonly phase27ApprovalProbe?: number;`),
    );
    approvalDriftResult = run(
      "--root",
      approvalRepository,
      "--snapshot",
      path.join(approvalRepository, "engine", "api-surface.json"),
    );

    const incompleteLedger = approvals();
    incompleteLedger.approvals.pop();
    incompleteLedger.counts.approved--;
    incompleteLedger.counts.pendingPublic++;
    const incompleteApprovalFile = temporaryApprovalLedger();
    fs.writeFileSync(incompleteApprovalFile, `${JSON.stringify(incompleteLedger, null, 2)}\n`);
    incompleteApprovalResult = run("--approvals", incompleteApprovalFile);

    const writeFile = temporarySnapshot();
    fs.writeFileSync(writeFile, "{}\n");
    const manualApprovalFile = temporaryApprovalLedger();
    fs.writeFileSync(manualApprovalFile, "manual approval data is never generated\n");
    writeResult = run("--write", "--snapshot", writeFile, "--approvals", manualApprovalFile);
    writtenSnapshotText = fs.readFileSync(writeFile, "utf8");
    preservedApprovalText = fs.readFileSync(manualApprovalFile, "utf8");
    badOptionResult = run("--not-an-api-option");
  }, 180_000);

  afterAll(() => {
    for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
  });

  test("records one sorted classification for every package-root export", () => {
    const surface = snapshot();
    assert.equal(surface.schema, "forge.api-surface/2");
    assert.equal(surface.package, "@forge/engine");
    assert.equal(surface.packageVersion, "1.0.0");
    assert.equal(surface.entrypoint, "engine/src/index.ts");
    assert.equal(surface.signatureFormat, "forge.typescript-declaration-signature/1");
    assert.match(surface.typescriptVersion, /^5\.9\./);
    assert.ok(surface.counts.total > 2_000, "the pre-1.0 barrel is intentionally audited before it is reduced");
    assert.equal(surface.exports.length, surface.counts.total);
    assert.equal(new Set(surface.exports.map((entry) => entry.name)).size, surface.exports.length);
    assert.deepEqual(
      surface.exports.map((entry) => entry.name),
      [...surface.exports.map((entry) => entry.name)].sort(),
    );
    assert.deepEqual(
      [byName(surface, "AABB"), byName(surface, "EntityId"), byName(surface, "VERSION")]
        .map(({ name, kind, stability }) => ({ name, kind, stability })),
      [
        { name: "AABB", kind: "type-and-value", stability: "public" },
        { name: "EntityId", kind: "type", stability: "public" },
        { name: "VERSION", kind: "value", stability: "public" },
      ],
    );
    for (const item of surface.exports) {
      assert.match(item.declarationHash, /^sha256:[0-9a-f]{64}$/);
      assert.match(item.contractHash, /^sha256:[0-9a-f]{64}$/);
    }
    assert.equal(surface.counts.internal, 0);
    assert.equal(surface.counts.deprecated, 0);
    assert.deepEqual(
      surface.exports.filter((entry) => entry.stability === "experimental").map((entry) => entry.name),
      [
        "ForgeWasmPhysics",
        "ForgeWasmPhysicsOptions",
        "PhysicsBackendKind",
        "WASM_PHYSICS_LAYOUT",
        "WASM_PHYSICS_STATE_SCHEMA",
        "WasmPhysicsMemory",
        "WasmPhysicsMemoryOptions",
        "WasmPhysicsStateSnapshot",
        "createPhysicsBackend",
      ],
    );
  });

  test("binds every public candidate to a reviewed exact contract", () => {
    const surface = snapshot();
    const ledger = approvals();
    assert.equal(ledger.schema, "forge.api-approvals/1");
    assert.equal(ledger.package, "@forge/engine");
    assert.equal(ledger.surfaceSchema, "forge.api-surface/2");
    assert.equal(ledger.signatureFormat, "forge.typescript-declaration-signature/1");
    assert.equal(ledger.policy, "forge.api-approval-policy/2");
    assert.deepEqual(ledger.counts, {
      approved: 2_274,
      pendingPublic: 0,
      experimental: 9,
      deprecated: 0,
    });

    const expectedReviewCounts: Record<string, number> = {
      "animation/1": 41,
      "animation/2": 2,
      "audio/1": 121,
      "core-errors/1": 17,
      "core-runtime/1": 78,
      "core-tasks/1": 63,
      "core-time/1": 6,
      "debug/1": 96,
      "debug/2": 6,
      "environment/1": 236,
      "environment/2": 55,
      "extensions/1": 16,
      "gpu/1": 64,
      "math/1": 98,
      "particles/1": 89,
      "physics/1": 41,
      "population/1": 53,
      "population/2": 13,
      "rendering/1": 246,
      "rendering/2": 4,
      "replay/1": 28,
      "resources/1": 66,
      "resources/2": 5,
      "scene/1": 123,
      "scripting/1": 35,
      "terrain/1": 231,
      "testing/1": 16,
      "ui/1": 355,
      "vehicles/1": 67,
      "vehicles/2": 3,
    };
    assert.deepEqual(
      ledger.reviews.map((review) => review.id),
      Object.keys(expectedReviewCounts),
      "review batches stay sorted and complete",
    );
    for (const review of ledger.reviews) {
      assert.equal(review.decision, "approved-1.0-candidate");
      assert.ok(review.summary.length > 80, `${review.id} has a substantive decision summary`);
      assert.ok(review.evidence.includes("docs/API-REVIEW.md"));
      assert.ok(review.evidence.includes("tests/core/runtimeApi.test.ts"));
      for (const evidence of review.evidence) {
        assert.equal(fs.statSync(path.join(root, evidence)).isFile(), true, `${review.id}: ${evidence}`);
      }
    }

    assert.deepEqual(
      ledger.approvals.map((entry) => entry.name),
      surface.exports.filter((entry) => entry.stability === "public").map((entry) => entry.name),
      "all and only public candidates are approved",
    );
    const reviewCounts: Record<string, number> = {};
    for (const approval of ledger.approvals) {
      const current = byName(surface, approval.name);
      assert.equal(current.stability, "public");
      assert.equal(approval.kind, current.kind);
      assert.equal(approval.declarationHash, current.declarationHash);
      assert.equal(approval.contractHash, current.contractHash);
      reviewCounts[approval.review] = (reviewCounts[approval.review] ?? 0) + 1;
    }
    assert.deepEqual(reviewCounts, expectedReviewCounts);

    const batchAnchors: Record<string, string> = {
      AnimationClip: "animation/1",
      AUDIO_RESOURCE_KIND: "audio/1",
      AssetError: "core-errors/1",
      AdaptiveDeviceQuality: "core-runtime/1",
      BUILTIN_TASK_NAMES: "core-tasks/1",
      Clock: "core-time/1",
      DEFAULT_TIMELINE_BUDGET_MS: "debug/1",
      AtmosphereModel: "environment/1",
      AddressSpace: "gpu/1",
      AABB: "math/1",
      ColorOverLifeModule: "particles/1",
      BodyType: "physics/1",
      BushSpecies: "population/1",
      BINDINGS: "rendering/1",
      HashSceneStateOptions: "replay/1",
      AssetDiagnostic: "resources/1",
      AssetRef: "scene/1",
      CoroutineBody: "scripting/1",
      BedProfileOptions: "terrain/1",
      MockAudioBuffer: "testing/1",
      AUTO: "ui/1",
      AeroConfig: "vehicles/1",
    };
    for (const [name, review] of Object.entries(batchAnchors)) {
      assert.equal(ledger.approvals.find((entry) => entry.name === name)?.review, review);
    }

    assert.equal(approvalDriftResult.status, 1);
    assert.match(approvalDriftResult.stderr, /ForgeError approved declarationHash no longer matches/);
    assert.match(approvalDriftResult.stderr, /re-review the symbol before updating its approval/);
  });

  test("keeps the completed audit closed against a newly pending public export", () => {
    assert.equal(incompleteApprovalResult.status, 1);
    assert.match(incompleteApprovalResult.stderr, /forge\.api-approval-policy\/2 requires every public export/);
    assert.match(incompleteApprovalResult.stderr, /1 public export\(s\) remain pending/);
  });

  test("keeps the package, documentation, scripts and CI on the root-only audited contract", () => {
    const enginePackage = JSON.parse(fs.readFileSync(path.join(root, "engine", "package.json"), "utf8"));
    const rootPackage = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
    assert.deepEqual(Object.keys(enginePackage.exports), ["."]);
    assert.deepEqual(enginePackage.exports["."], { types: "./dist/index.d.ts", import: "./dist/index.js" });
    assert.ok(enginePackage.files.includes("README.md"));
    assert.match(fs.readFileSync(path.join(root, "engine", "README.md"), "utf8"), /package exposes one entry point/);
    assert.equal(rootPackage.scripts["api:check"], "node tools/api-audit.mjs");
    assert.equal(rootPackage.scripts["api:update"], "node tools/api-audit.mjs --write");
    assert.equal(rootPackage.scripts["api:reference:check"], "node tools/api-reference.mjs --check");
    const readme = fs.readFileSync(path.join(root, "README.md"), "utf8");
    assert.match(readme, /npm run api:check/);
    assert.match(readme, /`docs\/API\.md`/);
    const docs = fs.readFileSync(path.join(root, "docs", "API.md"), "utf8");
    assert.match(docs, /2,283/);
    assert.match(docs, /a `declarationHash` of that symbol's body-free emitted declaration/);
    assert.match(docs, /`engine\/api-approvals\.json`/);
    assert.match(docs, /2,274\/2,274 public candidates/);
    assert.match(docs, /a \*\*change detector\*\*, not a\s+compatibility oracle/);
    assert.match(fs.readFileSync(path.join(root, ".github", "workflows", "ci.yml"), "utf8"), /Public API surface\s+run: npm run api:check/);
    const versionCheck = spawnSync(process.execPath, [path.join(root, "tools", "version-check.mjs")], {
      cwd: root,
      encoding: "utf8",
    });
    assert.equal(versionCheck.status, 0, versionCheck.stderr);
    assert.match(versionCheck.stdout, /version:check OK — .*1\.0\.0/);
  });

  test("passes the reviewed snapshot", () => {
    assert.equal(cleanResult.status, 0, cleanResult.stderr);
    assert.match(
      cleanResult.stdout,
      /api:check OK — 2,283 exports \(2,274 public, 9 experimental, 0 deprecated\); 2,274\/2,274 public candidates approved \(0 pending\)/,
    );
  });

  test("rejects a semantic drift with an actionable diff", () => {
    assert.equal(staleResult.status, 1);
    assert.match(staleResult.stderr, /unrecorded exports: VERSION/);
    assert.match(staleResult.stderr, /run npm run api:update/i);
  });

  test("rejects a class-member declaration change even when the export name is unchanged", () => {
    assert.equal(directDriftResult.status, 1);
    assert.match(directDriftResult.stderr, /Transform approved declarationHash no longer matches/);
    assert.match(directDriftResult.stderr, /Transform approved contractHash no longer matches/);
  });

  test("rejects an unexported helper declaration change through transitive contracts", () => {
    assert.equal(transitiveDriftResult.status, 1);
    assert.doesNotMatch(transitiveDriftResult.stderr, /resolveConfig approved declarationHash no longer matches/);
    assert.match(transitiveDriftResult.stderr, /resolveConfig approved contractHash no longer matches/);
  });

  test("writes a canonical snapshot only when explicitly requested", () => {
    assert.equal(writeResult.status, 0, writeResult.stderr);
    assert.match(writeResult.stdout, /api:update OK — wrote 2,283 exports/);
    assert.equal(writtenSnapshotText, fs.readFileSync(snapshotFile, "utf8"));
    assert.equal(preservedApprovalText, "manual approval data is never generated\n");

    assert.equal(badOptionResult.status, 2);
    assert.match(badOptionResult.stderr, /unknown option/);
  });
});

await finish();
