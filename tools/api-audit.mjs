#!/usr/bin/env node
/**
 * Phase 27 public-API audit.
 *
 * The only supported runtime entry point is `@forge/engine`. This tool asks TypeScript for the
 * resolved exports of `engine/src/index.ts`, classifies every top-level name, and compares that
 * surface with the reviewed `engine/api-surface.json` snapshot. It deliberately snapshots names,
 * type/value presence and stability — not implementation paths, declaration order or signatures.
 *
 * Usage:
 *   npm run api:check
 *   npm run api:update
 *   node tools/api-audit.mjs --json
 *   node tools/api-audit.mjs --snapshot /tmp/surface.json [--write]
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

export const API_SURFACE_SCHEMA = "forge.api-surface/1";
export const API_STABILITIES = Object.freeze(["public", "experimental", "deprecated"]);
export const API_KINDS = Object.freeze(["type", "value", "type-and-value"]);

const here = path.dirname(fileURLToPath(import.meta.url));
const defaultRoot = path.resolve(here, "..");
const defaultSnapshot = path.join(defaultRoot, "engine", "api-surface.json");
const stabilityTags = new Set(["public", "experimental", "deprecated", "internal"]);

export class ApiAuditError extends Error {}

function readJson(file, label) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      throw new ApiAuditError(`${label} does not exist: ${file}`);
    }
    throw new ApiAuditError(`${label} is not valid JSON (${file}): ${String(error)}`);
  }
}

function compareText(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function exportIsTypeOnly(symbol) {
  for (const declaration of symbol.declarations ?? []) {
    if (ts.isExportSpecifier(declaration)) {
      const exportDeclaration = declaration.parent?.parent;
      if (declaration.isTypeOnly || (exportDeclaration && ts.isExportDeclaration(exportDeclaration) && exportDeclaration.isTypeOnly)) {
        return true;
      }
    } else if (ts.isExportDeclaration(declaration) && declaration.isTypeOnly) {
      return true;
    }
  }
  return false;
}

function symbolKind(alias, target) {
  if (exportIsTypeOnly(alias)) return "type";
  const hasType = (target.flags & ts.SymbolFlags.Type) !== 0;
  const hasValue = (target.flags & ts.SymbolFlags.Value) !== 0;
  if (hasType && hasValue) return "type-and-value";
  if (hasType) return "type";
  if (hasValue) return "value";
  throw new ApiAuditError(`could not classify export ${alias.name} as a type or value`);
}

function jsDocStabilityTags(alias, target, checker) {
  const tags = new Map();
  for (const symbol of alias === target ? [target] : [alias, target]) {
    for (const tag of symbol.getJsDocTags(checker)) {
      if (!stabilityTags.has(tag.name)) continue;
      const text = Array.isArray(tag.text) ? tag.text.map((part) => part.text).join("").trim() : "";
      const existing = tags.get(tag.name) ?? [];
      existing.push(text);
      tags.set(tag.name, existing);
    }
  }
  return tags;
}

function stabilityOf(alias, target, checker, failures) {
  const tagged = jsDocStabilityTags(alias, target, checker);
  const tags = new Set(tagged.keys());
  if (tags.has("internal")) {
    failures.push(`${alias.name} is tagged @internal but exported from @forge/engine`);
    return "public";
  }
  const categories = [...tags].filter((tag) => tag !== "internal");
  if (categories.length > 1) {
    failures.push(`${alias.name} has conflicting API stability tags: ${categories.map((tag) => `@${tag}`).join(", ")}`);
  }
  for (const category of ["experimental", "deprecated"]) {
    if (tags.has(category) && (tagged.get(category) ?? []).every((text) => text.length === 0)) {
      failures.push(`${alias.name} uses @${category} without an explanation`);
    }
  }
  if (tags.has("deprecated")) return "deprecated";
  if (tags.has("experimental")) return "experimental";
  return "public";
}

function formatDiagnostics(diagnostics, root) {
  return diagnostics.slice(0, 20).map((diagnostic) => {
    const text = ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
    if (!diagnostic.file || diagnostic.start === undefined) return text;
    const position = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
    return `${path.relative(root, diagnostic.file.fileName)}:${position.line + 1}:${position.character + 1} ${text}`;
  });
}

function literalVersion(symbol) {
  for (const declaration of symbol.declarations ?? []) {
    if (ts.isVariableDeclaration(declaration) && declaration.initializer && ts.isStringLiteralLike(declaration.initializer)) {
      return declaration.initializer.text;
    }
  }
  return null;
}

function validatePackageBoundary(enginePackage, rootPackage, entrySource, moduleExports) {
  const failures = [];
  if (enginePackage.name !== "@forge/engine") failures.push(`engine package name is ${JSON.stringify(enginePackage.name)}, expected "@forge/engine"`);
  if (enginePackage.version !== rootPackage.version) {
    failures.push(`root package version ${rootPackage.version} differs from @forge/engine ${enginePackage.version}`);
  }
  const exportKeys = Object.keys(enginePackage.exports ?? {}).sort(compareText);
  if (exportKeys.length !== 1 || exportKeys[0] !== ".") {
    failures.push(`@forge/engine must expose only the root entry point; found: ${exportKeys.join(", ") || "none"}`);
  }
  const rootExport = enginePackage.exports?.["."];
  if (rootExport?.types !== "./dist/index.d.ts" || rootExport?.import !== "./dist/index.js") {
    failures.push("@forge/engine package export must map types/import to ./dist/index.d.ts and ./dist/index.js");
  }
  if (enginePackage.main !== "./dist/index.js" || enginePackage.module !== "./dist/index.js" || enginePackage.types !== "./dist/index.d.ts") {
    failures.push("@forge/engine main/module/types must agree with the root package export");
  }
  const versionAlias = moduleExports.find((symbol) => symbol.name === "VERSION");
  const versionTarget = versionAlias && (versionAlias.flags & ts.SymbolFlags.Alias) !== 0
    ? null
    : versionAlias;
  const sourceVersion = versionTarget ? literalVersion(versionTarget) : null;
  if (sourceVersion !== enginePackage.version) {
    failures.push(`engine VERSION ${JSON.stringify(sourceVersion)} differs from package version ${enginePackage.version}`);
  }
  if (!entrySource.fileName.endsWith(`${path.sep}engine${path.sep}src${path.sep}index.ts`)) {
    failures.push(`public entry point resolved unexpectedly: ${entrySource.fileName}`);
  }
  return failures;
}

function countsFor(exportsList) {
  const counts = {
    total: exportsList.length,
    public: 0,
    experimental: 0,
    deprecated: 0,
    internal: 0,
    type: 0,
    value: 0,
    typeAndValue: 0,
  };
  for (const item of exportsList) {
    if (!item || typeof item !== "object") continue;
    if (typeof item.stability === "string" && item.stability in counts) counts[item.stability]++;
    if (item.kind === "type-and-value") counts.typeAndValue++;
    else if (item.kind in counts) counts[item.kind]++;
  }
  return counts;
}

/** Resolve the actual package-root exports and return a deterministic plain-JSON surface. */
export function buildApiSurface(root = defaultRoot) {
  const engineDirectory = path.join(root, "engine");
  const entryPath = path.join(engineDirectory, "src", "index.ts");
  const enginePackage = readJson(path.join(engineDirectory, "package.json"), "engine package manifest");
  const rootPackage = readJson(path.join(root, "package.json"), "root package manifest");
  const configPath = path.join(engineDirectory, "tsconfig.json");
  const loadedConfig = ts.readConfigFile(configPath, ts.sys.readFile);
  if (loadedConfig.error) throw new ApiAuditError(formatDiagnostics([loadedConfig.error], root).join("\n"));
  const config = ts.parseJsonConfigFileContent(loadedConfig.config, ts.sys, engineDirectory, undefined, configPath);
  if (config.errors.length > 0) throw new ApiAuditError(formatDiagnostics(config.errors, root).join("\n"));

  const program = ts.createProgram({ rootNames: config.fileNames, options: config.options });
  // `npm run typecheck` owns semantic diagnostics. The API gate needs a parseable program and a
  // checker, but repeating a full semantic pass for each focused CLI test makes the audit needlessly
  // slow and risks per-case timeouts on CI.
  const diagnostics = [...program.getOptionsDiagnostics(), ...program.getSyntacticDiagnostics()];
  if (diagnostics.length > 0) {
    throw new ApiAuditError(`engine TypeScript program has ${diagnostics.length} configuration/syntax diagnostic(s):\n${formatDiagnostics(diagnostics, root).join("\n")}`);
  }
  const entrySource = program.getSourceFile(entryPath);
  if (!entrySource) throw new ApiAuditError(`TypeScript program did not include ${entryPath}`);
  const checker = program.getTypeChecker();
  const moduleSymbol = checker.getSymbolAtLocation(entrySource);
  if (!moduleSymbol) throw new ApiAuditError("could not resolve the engine public entry point as a TypeScript module");
  const moduleExports = checker.getExportsOfModule(moduleSymbol);
  const failures = validatePackageBoundary(enginePackage, rootPackage, entrySource, moduleExports);

  const exportsList = moduleExports.map((alias) => {
    const target = (alias.flags & ts.SymbolFlags.Alias) !== 0 ? checker.getAliasedSymbol(alias) : alias;
    return {
      name: alias.name,
      kind: symbolKind(alias, target),
      stability: stabilityOf(alias, target, checker, failures),
    };
  }).sort((a, b) => compareText(a.name, b.name));

  const duplicates = exportsList.filter((item, index) => index > 0 && exportsList[index - 1].name === item.name);
  if (duplicates.length > 0) failures.push(`duplicate public export names: ${duplicates.map((item) => item.name).join(", ")}`);
  if (exportsList.some((item) => item.name === "default")) failures.push("@forge/engine must use named exports; a default export was found");
  if (failures.length > 0) throw new ApiAuditError(failures.join("\n"));

  return {
    schema: API_SURFACE_SCHEMA,
    package: enginePackage.name,
    packageVersion: enginePackage.version,
    entrypoint: "engine/src/index.ts",
    counts: countsFor(exportsList),
    exports: exportsList,
  };
}

export function canonicalApiSurface(surface) {
  return `${JSON.stringify(surface, null, 2)}\n`;
}

/** Validate a recorded surface independently of the current source tree. */
export function validateRecordedSurface(surface) {
  const failures = [];
  if (!surface || typeof surface !== "object" || Array.isArray(surface)) return ["snapshot root must be an object"];
  if (surface.schema !== API_SURFACE_SCHEMA) failures.push(`snapshot schema must be ${API_SURFACE_SCHEMA}`);
  if (!Array.isArray(surface.exports)) return [...failures, "snapshot exports must be an array"];
  let previous = null;
  const names = new Set();
  for (const [index, item] of surface.exports.entries()) {
    if (!item || typeof item !== "object" || typeof item.name !== "string") {
      failures.push(`snapshot export ${index} has no string name`);
      continue;
    }
    if (names.has(item.name)) failures.push(`snapshot repeats export ${item.name}`);
    names.add(item.name);
    if (previous !== null && compareText(previous, item.name) >= 0) failures.push(`snapshot exports are not strictly sorted at ${item.name}`);
    previous = item.name;
    if (!API_KINDS.includes(item.kind)) failures.push(`${item.name} has unknown kind ${JSON.stringify(item.kind)}`);
    if (!API_STABILITIES.includes(item.stability)) failures.push(`${item.name} has unknown stability ${JSON.stringify(item.stability)}`);
  }
  const expectedCounts = countsFor(surface.exports);
  if (JSON.stringify(surface.counts) !== JSON.stringify(expectedCounts)) failures.push("snapshot counts do not match its export rows");
  return failures;
}

/** Human-readable semantic differences between a reviewed and current surface. */
export function diffApiSurfaces(recorded, current) {
  const differences = [];
  for (const key of ["schema", "package", "packageVersion", "entrypoint"]) {
    if (recorded?.[key] !== current[key]) differences.push(`${key}: ${JSON.stringify(recorded?.[key])} -> ${JSON.stringify(current[key])}`);
  }
  const recordedByName = new Map((recorded?.exports ?? []).map((item) => [item.name, item]));
  const currentByName = new Map(current.exports.map((item) => [item.name, item]));
  const unrecorded = current.exports.filter((item) => !recordedByName.has(item.name)).map((item) => item.name);
  const missing = (recorded?.exports ?? []).filter((item) => !currentByName.has(item.name)).map((item) => item.name);
  const changed = current.exports.flatMap((item) => {
    const old = recordedByName.get(item.name);
    if (!old || (old.kind === item.kind && old.stability === item.stability)) return [];
    return [`${item.name} (${old.kind}/${old.stability} -> ${item.kind}/${item.stability})`];
  });
  if (unrecorded.length > 0) differences.push(`unrecorded exports: ${unrecorded.join(", ")}`);
  if (missing.length > 0) differences.push(`missing or renamed exports: ${missing.join(", ")}`);
  if (changed.length > 0) differences.push(`changed classifications: ${changed.join(", ")}`);
  return differences;
}

function parseArgs(argv) {
  const options = { write: false, json: false, snapshot: defaultSnapshot, help: false };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === "--write") options.write = true;
    else if (argument === "--json") options.json = true;
    else if (argument === "--help" || argument === "-h") options.help = true;
    else if (argument === "--snapshot") {
      const value = argv[++index];
      if (!value) throw new ApiAuditError("--snapshot requires a path");
      options.snapshot = path.resolve(value);
    } else if (argument.startsWith("--snapshot=")) {
      const value = argument.slice("--snapshot=".length);
      if (!value) throw new ApiAuditError("--snapshot requires a path");
      options.snapshot = path.resolve(value);
    } else {
      throw new ApiAuditError(`unknown option: ${argument}`);
    }
  }
  if (options.write && options.json) throw new ApiAuditError("--write and --json cannot be combined");
  return options;
}

function usage() {
  return "Usage: node tools/api-audit.mjs [--write | --json] [--snapshot PATH]";
}

export function main(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    console.error(`api:check: ${error.message}\n${usage()}`);
    return 2;
  }
  if (options.help) {
    console.log(usage());
    return 0;
  }

  let current;
  try {
    current = buildApiSurface(defaultRoot);
  } catch (error) {
    console.error(`api:check FAILED — ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  const canonical = canonicalApiSurface(current);
  if (options.json) {
    process.stdout.write(canonical);
    return 0;
  }
  if (options.write) {
    fs.mkdirSync(path.dirname(options.snapshot), { recursive: true });
    fs.writeFileSync(options.snapshot, canonical);
    console.log(`api:update OK — wrote ${current.counts.total.toLocaleString("en-US")} exports to ${path.relative(defaultRoot, options.snapshot) || options.snapshot}`);
    return 0;
  }

  let recorded;
  let recordedText;
  try {
    recordedText = fs.readFileSync(options.snapshot, "utf8");
    recorded = JSON.parse(recordedText);
  } catch (error) {
    console.error(`api:check FAILED — cannot read ${options.snapshot}: ${String(error)}\nRun npm run api:update to create it.`);
    return 1;
  }
  const invalid = validateRecordedSurface(recorded);
  if (invalid.length > 0) {
    console.error(`api:check FAILED — invalid API snapshot:\n  ${invalid.join("\n  ")}`);
    return 1;
  }
  const differences = diffApiSurfaces(recorded, current);
  if (differences.length > 0 || recordedText !== canonicalApiSurface(recorded)) {
    if (recordedText !== canonicalApiSurface(recorded)) differences.push("snapshot JSON formatting is not canonical");
    console.error(`api:check FAILED — engine/api-surface.json is stale:\n  ${differences.join("\n  ")}\nReview the API change, then run npm run api:update.`);
    return 1;
  }
  console.log(
    `api:check OK — ${current.counts.total.toLocaleString("en-US")} exports `
    + `(${current.counts.public.toLocaleString("en-US")} public, ${current.counts.experimental} experimental, ${current.counts.deprecated} deprecated); root-only package boundary intact.`,
  );
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
