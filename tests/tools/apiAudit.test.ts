/**
 * @suite tools:apiAudit
 * @group unit
 * @covers .github/workflows/ci.yml
 * @covers docs/API.md
 * @covers engine/api-surface.json
 * @covers engine/package.json
 * @covers engine/README.md
 * @covers engine/src/index.ts
 * @covers engine/src/physics/backend.ts
 * @covers engine/src/physics/wasmMemory.ts
 * @covers package.json
 * @covers README.md
 * @covers tools/api-audit.mjs
 * @desc Phase 27.1 root-only public API classification, deterministic snapshot and drift gate
 */

export const suite = {
  name: "tools:apiAudit",
  group: "unit",
  covers: [
    ".github/workflows/ci.yml",
    "docs/API.md",
    "engine/api-surface.json",
    "engine/package.json",
    "engine/README.md",
    "engine/src/index.ts",
    "engine/src/physics/backend.ts",
    "engine/src/physics/wasmMemory.ts",
    "package.json",
    "README.md",
    "tools/api-audit.mjs",
  ],
  desc: "Phase 27.1 root-only public API classification, deterministic snapshot and drift gate",
};

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, finish, group, test } from "selrun";

interface ApiExportRow {
  name: string;
  kind: "type" | "value" | "type-and-value";
  stability: "public" | "experimental" | "deprecated";
}

interface ApiSurface {
  schema: string;
  package: string;
  packageVersion: string;
  entrypoint: string;
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

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const tool = path.join(root, "tools", "api-audit.mjs");
const snapshotFile = path.join(root, "engine", "api-surface.json");
const temporaryDirectories: string[] = [];
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function snapshot(): ApiSurface {
  return JSON.parse(fs.readFileSync(snapshotFile, "utf8")) as ApiSurface;
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

function byName(surface: ApiSurface, name: string): ApiExportRow {
  const item = surface.exports.find((entry) => entry.name === name);
  assert.ok(item, `missing API export ${name}`);
  return item;
}

group("Phase 27 public API audit", () => {
  test("records one sorted classification for every package-root export", () => {
    const surface = snapshot();
    assert.equal(surface.schema, "forge.api-surface/1");
    assert.equal(surface.package, "@forge/engine");
    assert.equal(surface.packageVersion, "0.1.0");
    assert.equal(surface.entrypoint, "engine/src/index.ts");
    assert.ok(surface.counts.total > 2_000, "the pre-1.0 barrel is intentionally audited before it is reduced");
    assert.equal(surface.exports.length, surface.counts.total);
    assert.equal(new Set(surface.exports.map((entry) => entry.name)).size, surface.exports.length);
    assert.deepEqual(
      surface.exports.map((entry) => entry.name),
      [...surface.exports.map((entry) => entry.name)].sort(),
    );
    assert.deepEqual(byName(surface, "AABB"), { name: "AABB", kind: "type-and-value", stability: "public" });
    assert.deepEqual(byName(surface, "EntityId"), { name: "EntityId", kind: "type", stability: "public" });
    assert.deepEqual(byName(surface, "VERSION"), { name: "VERSION", kind: "value", stability: "public" });
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

  test("keeps the package, documentation, scripts and CI on the root-only audited contract", () => {
    const enginePackage = JSON.parse(fs.readFileSync(path.join(root, "engine", "package.json"), "utf8"));
    const rootPackage = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
    assert.deepEqual(Object.keys(enginePackage.exports), ["."]);
    assert.deepEqual(enginePackage.exports["."], { types: "./dist/index.d.ts", import: "./dist/index.js" });
    assert.ok(enginePackage.files.includes("README.md"));
    assert.match(fs.readFileSync(path.join(root, "engine", "README.md"), "utf8"), /package exposes one entry point/);
    assert.equal(rootPackage.scripts["api:check"], "node tools/api-audit.mjs");
    assert.equal(rootPackage.scripts["api:update"], "node tools/api-audit.mjs --write");
    const readme = fs.readFileSync(path.join(root, "README.md"), "utf8");
    assert.match(readme, /npm run api:check/);
    assert.match(readme, /`docs\/API\.md`/);
    const docs = fs.readFileSync(path.join(root, "docs", "API.md"), "utf8");
    assert.match(docs, /2,180 named exports/);
    assert.match(docs, /does \*\*not\*\* yet compare function parameters/);
    assert.match(fs.readFileSync(path.join(root, ".github", "workflows", "ci.yml"), "utf8"), /Public API surface\s+run: npm run api:check/);
  });

  test("passes the reviewed snapshot", () => {
    const clean = run();
    assert.equal(clean.status, 0, clean.stderr);
    assert.match(clean.stdout, /api:check OK — 2,180 exports \(2,171 public, 9 experimental, 0 deprecated\)/);
  });

  test("rejects a semantic drift with an actionable diff", () => {
    const stale = snapshot();
    const versionIndex = stale.exports.findIndex((entry) => entry.name === "VERSION");
    assert.ok(versionIndex >= 0);
    stale.exports.splice(versionIndex, 1);
    stale.counts.total--;
    stale.counts.public--;
    stale.counts.value--;
    const file = temporarySnapshot();
    fs.writeFileSync(file, `${JSON.stringify(stale, null, 2)}\n`);
    const drift = run("--snapshot", file);
    assert.equal(drift.status, 1);
    assert.match(drift.stderr, /unrecorded exports: VERSION/);
    assert.match(drift.stderr, /run npm run api:update/i);
  });

  test("writes a canonical snapshot only when explicitly requested", () => {
    const file = temporarySnapshot();
    fs.writeFileSync(file, "{}\n");
    const result = run("--write", "--snapshot", file);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /api:update OK — wrote 2,180 exports/);
    assert.equal(fs.readFileSync(file, "utf8"), fs.readFileSync(snapshotFile, "utf8"));

    const badOption = run("--not-an-api-option");
    assert.equal(badOption.status, 2);
    assert.match(badOption.stderr, /unknown option/);
  });
});

await finish();
