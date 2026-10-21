#!/usr/bin/env node
/**
 * Release gate for Forge's version-of-truth policy.
 *
 * Keep this check deliberately independent of the TypeScript API audit: a package can retain an
 * unchanged declaration shape while its runtime version literal or workspace lock metadata drifts.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readJson = (relative) => JSON.parse(fs.readFileSync(path.join(root, relative), "utf8"));
const rootPackage = readJson("package.json");
const enginePackage = readJson("engine/package.json");
const editorPackage = readJson("editor/package.json");
const lock = readJson("package-lock.json");
const surface = readJson("engine/api-surface.json");
const source = fs.readFileSync(path.join(root, "engine/src/index.ts"), "utf8");
const versionLiteral = source.match(/export const VERSION\s*=\s*["']([^"']+)["']/)?.[1];
const expected = rootPackage.version;
const failures = [];

if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(expected)) failures.push(`root package version is not semver: ${expected}`);
for (const [label, actual] of [
  ["@forge/engine package", enginePackage.version],
  ["@forge/editor package", editorPackage.version],
  ["exported VERSION", versionLiteral],
  ["API snapshot", surface.packageVersion],
  ["lockfile root", lock.packages?.[""]?.version],
  ["lockfile engine", lock.packages?.engine?.version],
  ["lockfile editor", lock.packages?.editor?.version],
]) {
  if (actual !== expected) failures.push(`${label} ${JSON.stringify(actual)} differs from root ${JSON.stringify(expected)}`);
}
if (editorPackage.dependencies?.["@forge/engine"] !== expected) {
  failures.push(`@forge/editor must depend on @forge/engine ${expected}, found ${editorPackage.dependencies?.["@forge/engine"]}`);
}
if (lock.packages?.editor?.dependencies?.["@forge/engine"] !== expected) {
  failures.push(`lockfile editor dependency must be @forge/engine ${expected}, found ${lock.packages?.editor?.dependencies?.["@forge/engine"]}`);
}

if (failures.length > 0) {
  console.error(`version:check FAILED\n  ${failures.join("\n  ")}`);
  process.exitCode = 1;
} else {
  console.log(`version:check OK — root, engine, editor, VERSION, API snapshot and lockfile are ${expected}`);
}
