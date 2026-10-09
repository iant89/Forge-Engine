/**
 * @suite tools:selrun
 * @group unit
 * @covers packages/selrun/src/catalog.mjs
 * @covers packages/selrun/src/cli.mjs
 * @covers packages/selrun/src/index.ts
 * @covers packages/selrun/src/selection.mjs
 * @covers packages/selrun/package.json
 * @covers package.json
 * @covers package-lock.json
 * @covers tests/full.test.ts
 * @desc Pins explicit many-to-many coverage, test-only import selection, Git change-set boundaries, and the suite catalog.
 */

export const suite = {
  name: "tools:selrun",
  group: "unit",
  covers: [
    "packages/selrun/src/catalog.mjs",
    "packages/selrun/src/cli.mjs",
    "packages/selrun/src/index.ts",
    "packages/selrun/src/selection.mjs",
    "packages/selrun/package.json",
    "package.json",
    "package-lock.json",
    "tests/full.test.ts",
  ],
  desc: "Pins explicit many-to-many coverage, test-only import selection, Git change-set boundaries, and the suite catalog.",
};

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { finish, group, test } from "selrun";
import { discoverSuiteFiles, readLinkedSuites, validateCatalog } from "../../packages/selrun/src/catalog.mjs";
import {
  collectBaseChanges,
  collectWorkingChanges,
  globMatches,
  matchesCover,
  normalizePath,
  parseNameStatusZ,
  selectSuitesForChanges,
  staticImportClosure,
  staticSpecifiers,
} from "../../packages/selrun/src/selection.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

group("selrun path and coverage selection", () => {
  test("matches exact paths and repository globs without letting `*` cross a directory", () => {
    assert.equal(matchesCover("engine\\src\\math\\vec.ts", "engine/src/**/*.ts", repoRoot), true);
    assert.equal(globMatches("engine/src/math/vec.ts", "engine/src/*.ts"), false);
    assert.equal(globMatches("engine/src/math.ts", "engine/src/**/*.ts"), true);
    assert.equal(globMatches("engine/src/math/vec.ts", "engine/src/**/*.ts"), true);
    assert.equal(globMatches("engine/src/math/vec.ts", "engine/src/math/vec.ts"), true);
    assert.equal(globMatches("engine/src/math/vec.ts", "engine/src/rendering/*.ts"), false);
    assert.equal(normalizePath("tests\\tools\\selrun.test.ts", repoRoot), "tests/tools/selrun.test.ts");
  });

  test("keeps every suite that explicitly covers a shared file, including all of one suite's claims", () => {
    const suites = [
      { file: "tests/a.test.ts", covers: ["engine/src/shared.ts", "engine/src/a-only.ts"] },
      { file: "tests/b.test.ts", covers: ["engine/src/shared.ts"] },
      { file: "tests/c.test.ts", covers: ["engine/src/c-only.ts"] },
    ];
    const shared = selectSuitesForChanges(suites, ["engine/src/shared.ts"], repoRoot);
    assert.deepEqual(shared.suites.map((item) => item.file), ["tests/a.test.ts", "tests/b.test.ts"]);
    assert.deepEqual(shared.reasons.get("tests/a.test.ts"), {
      kind: "covers",
      path: "engine/src/shared.ts",
      claim: "engine/src/shared.ts",
    });
    const onlyA = selectSuitesForChanges(suites, ["engine/src/a-only.ts"], repoRoot);
    assert.deepEqual(onlyA.suites.map((item) => item.file), ["tests/a.test.ts"]);
  });

  test("uses static import closure only for changed test files, never for production selection", () => {
    const root = mkdtempSync(path.join(tmpdir(), "selrun-static-imports-"));
    try {
      mkdirSync(path.join(root, "tests/samples"), { recursive: true });
      mkdirSync(path.join(root, "tests/support"), { recursive: true });
      mkdirSync(path.join(root, "src"), { recursive: true });
      writeFileSync(
        path.join(root, "tests/samples/selected.test.ts"),
        [
          'import { helper } from "../support/static.js";',
          'import type { Shape } from "../support/types.js";',
          'import "../../src/public.js";',
          'void import("../support/dynamic.js");',
          "void [helper, null as Shape | null];",
        ].join("\n"),
      );
      writeFileSync(path.join(root, "tests/samples/dynamic.test.ts"), 'void import("../support/dynamic.js");\n');
      writeFileSync(path.join(root, "tests/support/static.ts"), 'import "../../src/helper.js";\n');
      writeFileSync(path.join(root, "tests/support/types.ts"), "export interface Shape { value: number }\n");
      writeFileSync(path.join(root, "tests/support/dynamic.ts"), "export const lazy = true;\n");
      writeFileSync(path.join(root, "src/public.ts"), "export const api = true;\n");
      writeFileSync(path.join(root, "src/helper.ts"), "export const helper = true;\n");

      const specifiers = staticSpecifiers(
        'import "./one.js"; export * from "./two.js"; require("./three.cjs"); void import("./lazy.js");',
        "sample.ts",
      );
      assert.deepEqual(specifiers, ["./one.js", "./two.js", "./three.cjs"]);

      const closure = staticImportClosure("tests/samples/selected.test.ts", root);
      assert.ok(closure.files.has("tests/support/static.ts"));
      assert.ok(closure.files.has("tests/support/types.ts"));
      assert.ok(closure.files.has("src/public.ts"));
      assert.ok(closure.files.has("src/helper.ts"));
      assert.equal(closure.files.has("tests/support/dynamic.ts"), false);

      const suites = [
        { file: "tests/samples/selected.test.ts", covers: [] },
        { file: "tests/samples/dynamic.test.ts", covers: [] },
      ];
      assert.deepEqual(
        selectSuitesForChanges(suites, ["tests/support/static.ts"], root).suites.map((item) => item.file),
        ["tests/samples/selected.test.ts"],
      );
      assert.deepEqual(selectSuitesForChanges(suites, ["tests/support/dynamic.ts"], root).suites, []);
      assert.deepEqual(selectSuitesForChanges(suites, ["src/public.ts"], root).suites, []);
      assert.deepEqual(
        selectSuitesForChanges(suites, ["tests/samples/dynamic.test.ts"], root).suites.map((item) => item.file),
        ["tests/samples/dynamic.test.ts"],
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("retains both sides of rename/copy records from Git's NUL-delimited output", () => {
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

  test("separates working-tree/staged/untracked changes from the exact base...HEAD commit diff", () => {
    const root = mkdtempSync(path.join(tmpdir(), "selrun-git-changes-"));
    try {
      execFileSync("git", ["init", "--quiet"], { cwd: root });
      execFileSync("git", ["config", "user.name", "Selrun Tests"], { cwd: root });
      execFileSync("git", ["config", "user.email", "selrun@example.invalid"], { cwd: root });
      mkdirSync(path.join(root, "src"), { recursive: true });
      writeFileSync(path.join(root, "src/base.txt"), "base\n");
      execFileSync("git", ["add", "src/base.txt"], { cwd: root });
      execFileSync("git", ["commit", "--quiet", "-m", "base"], { cwd: root });
      const base = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();

      writeFileSync(path.join(root, "src/head.txt"), "committed on head\n");
      execFileSync("git", ["add", "src/head.txt"], { cwd: root });
      execFileSync("git", ["commit", "--quiet", "-m", "head change"], { cwd: root });

      writeFileSync(path.join(root, "src/base.txt"), "unstaged edit\n");
      writeFileSync(path.join(root, "src/staged.txt"), "staged edit\n");
      execFileSync("git", ["add", "src/staged.txt"], { cwd: root });
      mkdirSync(path.join(root, "tests"), { recursive: true });
      writeFileSync(path.join(root, "tests/untracked.test.ts"), "// untracked\n");

      assert.deepEqual(collectBaseChanges(base, root), ["src/head.txt"]);
      assert.deepEqual(collectWorkingChanges(root).sort(), [
        "src/base.txt",
        "src/staged.txt",
        "tests/untracked.test.ts",
      ]);
      assert.throws(() => collectBaseChanges("--bad-ref", root), /invalid comparison base/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

group("selrun catalog and many-to-many repository coverage", () => {
  test("links each discovered suite exactly once, reports the exact count, and leaves DOM suites last", () => {
    const catalog = validateCatalog(repoRoot);
    assert.deepEqual(catalog.errors, []);
    assert.equal(catalog.stats.suitesOnDisk, 72);
    assert.equal(catalog.stats.suitesLinked, 72);
    assert.equal(catalog.stats.suitesNamed, 72);
    assert.equal(catalog.stats.suitesWithCoverage, 72);
    assert.equal(catalog.stats.coverageClaims, 653);

    const discovered = discoverSuiteFiles(repoRoot);
    const linked = readLinkedSuites(repoRoot);
    const linkPaths = linked.links.map((link) => link.file);
    assert.equal(linked.reportCounts.length, 1);
    assert.equal(linked.reportCounts[0], 72);
    assert.equal(new Set(linkPaths).size, 72);
    assert.deepEqual([...linkPaths].sort(), discovered);

    const firstDomSuite = linkPaths.findIndex((file) => file?.startsWith("tests/controls/"));
    assert.ok(firstDomSuite > 0);
    assert.ok(linkPaths.slice(firstDomSuite).every((file) => file?.startsWith("tests/controls/")));
    assert.ok(linkPaths.slice(0, firstDomSuite).every((file) => !file?.startsWith("tests/controls/")));

    const invalidRoot = mkdtempSync(path.join(tmpdir(), "selrun-invalid-catalog-"));
    try {
      mkdirSync(path.join(invalidRoot, "tests/__invalid_area__"), { recursive: true });
      mkdirSync(path.join(invalidRoot, "tools"), { recursive: true });
      writeFileSync(path.join(invalidRoot, "tests/__invalid_area__/noop.test.ts"), [
        "/**",
        " * @suite __invalid_area__:noop",
        " * @group unit",
        " * @covers subsystem:__invalid_area__",
        " * @desc Synthetic invalid suite for catalog validation.",
        " */",
        'export const suite = { name: "__invalid_area__:noop", group: "unit", covers: ["subsystem:__invalid_area__"], desc: "Synthetic invalid suite for catalog validation." };',
      ].join("\n"));
      writeFileSync(path.join(invalidRoot, "tests/full.test.ts"), [
        'const linkedSuites = [["tests/__invalid_area__/noop.test.ts", () => import("./__invalid_area__/noop.test.ts")]];',
        "report(1);",
      ].join("\n"));
      const invalid = validateCatalog(invalidRoot);
      assert.ok(invalid.errors.some((error) => error.includes("uses area __invalid_area__, which is not a repository directory")));
      assert.ok(invalid.errors.some((error) => error.includes("@covers subsystem:__invalid_area__ is not a repository file")));
    } finally {
      rmSync(invalidRoot, { recursive: true, force: true });
    }
  });

  test("preserves the many-to-many owners of the public engine barrel and every explicit cover", () => {
    const catalog = validateCatalog(repoRoot);
    const barrelOwners = catalog.suites.filter((suite) => suite.covers?.includes("engine/src/index.ts"));
    assert.ok(barrelOwners.length > 10, "public-barrel coverage must remain many-to-many");

    const matchingClaims = catalog.suites.filter((suite) => suite.covers?.some((cover) => matchesCover("engine/src/index.ts", cover, repoRoot)));
    const selectableSuites = catalog.suites.map((suite) => ({ ...suite, covers: suite.covers ?? [] }));
    const selected = selectSuitesForChanges(selectableSuites, ["engine/src/index.ts"], repoRoot);
    assert.deepEqual(
      selected.suites.map((suite) => suite.file),
      matchingClaims.map((suite) => suite.file),
    );
    assert.ok(catalog.suites.some((suite) => (suite.covers?.length ?? 0) > 1));
  });

  test("checks the package CLI and keeps selrun installed as the local npm workspace", () => {
    const cli = path.join(repoRoot, "packages/selrun/src/cli.mjs");
    const output = execFileSync(process.execPath, [cli, "check"], { cwd: repoRoot, encoding: "utf8" });
    assert.match(output, /check OK — 72 linked suites, 653 explicit coverage claims/);

    const manifest = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
    const lock = JSON.parse(readFileSync(path.join(repoRoot, "package-lock.json"), "utf8"));
    assert.ok(manifest.workspaces.includes("packages/selrun"));
    assert.equal(manifest.scripts.test, "selrun run --all");
    assert.equal(manifest.devDependencies.vitest, undefined);
    assert.equal(lock.packages["node_modules/selrun"].resolved, "packages/selrun");
    assert.equal(lock.packages["node_modules/vitest"], undefined);
  });
});

await finish();
