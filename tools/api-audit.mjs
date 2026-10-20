#!/usr/bin/env node
/**
 * Phase 27 public-API audit.
 *
 * The only supported runtime entry point is `@forge/engine`. This tool asks TypeScript for the
 * resolved exports of `engine/src/index.ts`, classifies every top-level name, emits the declarations
 * consumers receive, and compares that contract with the reviewed `engine/api-surface.json`
 * snapshot. It deliberately omits implementation paths and function bodies while fingerprinting
 * direct declarations and their engine-local type dependencies. A separate, manually reviewed
 * approval ledger binds approved 1.0 candidates to the exact declaration contracts that were
 * inspected; regenerating the surface can never grant or refresh an approval.
 *
 * Usage:
 *   npm run api:check
 *   npm run api:update
 *   node tools/api-audit.mjs --json
 *   node tools/api-audit.mjs --snapshot /tmp/surface.json [--write]
 *   node tools/api-audit.mjs --approvals /tmp/approvals.json
 *   node tools/api-audit.mjs --root /tmp/forge-copy
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

export const API_SURFACE_SCHEMA = "forge.api-surface/2";
export const API_SIGNATURE_FORMAT = "forge.typescript-declaration-signature/1";
export const API_APPROVAL_SCHEMA = "forge.api-approvals/1";
export const API_APPROVAL_POLICY = "forge.api-approval-policy/1";
export const API_APPROVAL_DECISION = "approved-1.0-candidate";
export const API_STABILITIES = Object.freeze(["public", "experimental", "deprecated"]);
export const API_KINDS = Object.freeze(["type", "value", "type-and-value"]);

const signatureHashPattern = /^sha256:[0-9a-f]{64}$/;

const here = path.dirname(fileURLToPath(import.meta.url));
const defaultRoot = path.resolve(here, "..");
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

function declarationOutputPath(sourceFile, options) {
  const rootDirectory = options.rootDir;
  const outputDirectory = options.outDir;
  if (!rootDirectory || !outputDirectory) return null;
  const relative = path.relative(rootDirectory, sourceFile);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
  const extension = relative.endsWith(".mts") ? ".d.mts" : relative.endsWith(".cts") ? ".d.cts" : ".d.ts";
  return path.normalize(path.join(outputDirectory, relative.replace(/\.(?:[cm]?ts|tsx)$/i, extension)));
}

function hashSignature(namespace, text) {
  return `sha256:${createHash("sha256").update(`${namespace}\n${text}`).digest("hex")}`;
}

/**
 * Emit declarations in memory and fingerprint the contract of each package-root symbol.
 *
 * A declaration hash covers that symbol's own body-free `.d.ts` declaration. A contract hash also
 * covers the transitive closure of engine-local declarations referenced by it. The latter is what
 * catches a change to an unexported helper type without putting implementation paths in the
 * snapshot. Normal prose comments are intentionally absent; type/member shape is the contract here.
 */
function buildDeclarationSignatures(sourceProgram, config, entryPath, root) {
  const emittedFiles = new Map();
  const emitResult = sourceProgram.emit(
    undefined,
    (fileName, text) => {
      if (/\.d\.(?:ts|mts|cts)$/i.test(fileName)) emittedFiles.set(path.normalize(fileName), text);
    },
    undefined,
    true,
  );
  if (emitResult.emitSkipped || emitResult.diagnostics.length > 0) {
    const details = formatDiagnostics(emitResult.diagnostics, root).join("\n");
    throw new ApiAuditError(`could not emit the engine declaration contract${details ? `:\n${details}` : ""}`);
  }

  const declarationEntryPath = declarationOutputPath(entryPath, config.options);
  if (!declarationEntryPath || !emittedFiles.has(declarationEntryPath)) {
    throw new ApiAuditError(`declaration emit did not produce the public entry point for ${entryPath}`);
  }

  const declarationOptions = {
    ...config.options,
    noEmit: true,
    declaration: false,
    declarationMap: false,
    composite: false,
    incremental: false,
    tsBuildInfoFile: undefined,
  };
  const baseHost = ts.createCompilerHost(declarationOptions, true);
  const emittedDirectories = new Set();
  for (const fileName of emittedFiles.keys()) {
    let directory = path.dirname(fileName);
    while (!emittedDirectories.has(directory)) {
      emittedDirectories.add(directory);
      const parent = path.dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
  }
  const declarationHost = {
    ...baseHost,
    fileExists(fileName) {
      return emittedFiles.has(path.normalize(fileName)) || baseHost.fileExists(fileName);
    },
    directoryExists(directoryName) {
      return emittedDirectories.has(path.normalize(directoryName)) || baseHost.directoryExists?.(directoryName) === true;
    },
    realpath(fileName) {
      const normalized = path.normalize(fileName);
      return emittedFiles.has(normalized) ? normalized : (baseHost.realpath?.(fileName) ?? normalized);
    },
    readFile(fileName) {
      return emittedFiles.get(path.normalize(fileName)) ?? baseHost.readFile(fileName);
    },
    getSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile) {
      const emitted = emittedFiles.get(path.normalize(fileName));
      if (emitted !== undefined) {
        return ts.createSourceFile(fileName, emitted, languageVersion, true, ts.ScriptKind.TS);
      }
      return baseHost.getSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile);
    },
    writeFile() {},
  };
  const declarationProgram = ts.createProgram({
    rootNames: [declarationEntryPath],
    options: declarationOptions,
    host: declarationHost,
  });
  const declarationDiagnostics = [
    ...declarationProgram.getOptionsDiagnostics(),
    ...declarationProgram.getSyntacticDiagnostics(),
  ];
  if (declarationDiagnostics.length > 0) {
    throw new ApiAuditError(
      `emitted declaration program has ${declarationDiagnostics.length} configuration/syntax diagnostic(s):\n`
      + formatDiagnostics(declarationDiagnostics, root).join("\n"),
    );
  }

  const declarationEntry = declarationProgram.getSourceFile(declarationEntryPath);
  if (!declarationEntry) throw new ApiAuditError("could not reload the emitted package declaration entry point");
  const checker = declarationProgram.getTypeChecker();
  const moduleSymbol = checker.getSymbolAtLocation(declarationEntry);
  if (!moduleSymbol) throw new ApiAuditError("could not resolve the emitted declaration entry point as a module");
  const rootExports = checker.getExportsOfModule(moduleSymbol);
  const outputPrefix = `${path.normalize(config.options.outDir ?? "")}${path.sep}`;
  const printer = ts.createPrinter({ removeComments: true, newLine: ts.NewLineKind.LineFeed });
  const directTextCache = new Map();
  const dependencyCache = new Map();

  function resolveAlias(symbol) {
    let current = symbol;
    const seen = new Set();
    while (current && (current.flags & ts.SymbolFlags.Alias) !== 0 && !seen.has(current)) {
      seen.add(current);
      current = checker.getAliasedSymbol(current);
    }
    return current;
  }

  function engineDeclarations(symbol) {
    return (symbol?.declarations ?? []).filter((declaration) => {
      const fileName = path.normalize(declaration.getSourceFile().fileName);
      return outputPrefix !== path.sep && fileName.startsWith(outputPrefix);
    });
  }

  function isolatedDeclaration(declaration) {
    if (
      ts.isVariableDeclaration(declaration)
      && ts.isVariableDeclarationList(declaration.parent)
      && ts.isVariableStatement(declaration.parent.parent)
    ) {
      const statement = declaration.parent.parent;
      const list = ts.factory.updateVariableDeclarationList(declaration.parent, [declaration]);
      return ts.factory.updateVariableStatement(statement, statement.modifiers, list);
    }
    return declaration;
  }

  function canonicalDeclarationText(symbol) {
    const existing = directTextCache.get(symbol);
    if (existing !== undefined) return existing;
    const declarations = engineDeclarations(symbol);
    const text = declarations.map((declaration) => printer
      .printNode(ts.EmitHint.Unspecified, isolatedDeclaration(declaration), declaration.getSourceFile())
      .replace(/\r\n/g, "\n")
      .split("\n")
      .map((line) => line.trimEnd())
      .join("\n")
      .trim())
      .filter(Boolean)
      .join("\n");
    directTextCache.set(symbol, text);
    return text;
  }

  function declarationsAreNested(declarations, containers) {
    return declarations.length > 0 && declarations.every((declaration) => containers.some((container) => (
      declaration.getSourceFile() === container.getSourceFile()
      && declaration.pos >= container.pos
      && declaration.end <= container.end
    )));
  }

  function dependenciesOf(symbol) {
    const existing = dependencyCache.get(symbol);
    if (existing) return existing;
    const declarations = engineDeclarations(symbol);
    const dependencies = new Set();
    for (const declaration of declarations) {
      const visit = (node) => {
        if (ts.isIdentifier(node)) {
          const referenced = resolveAlias(checker.getSymbolAtLocation(node));
          if (referenced && referenced !== symbol) {
            const referencedDeclarations = engineDeclarations(referenced);
            if (
              referencedDeclarations.length > 0
              && !declarationsAreNested(referencedDeclarations, declarations)
            ) {
              dependencies.add(referenced);
            }
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(declaration);
    }
    dependencyCache.set(symbol, dependencies);
    return dependencies;
  }

  const signatures = new Map();
  for (const exported of rootExports) {
    const target = resolveAlias(exported);
    const directText = target ? canonicalDeclarationText(target) : "";
    if (!target || !directText) {
      throw new ApiAuditError(`could not serialize the emitted declaration for ${exported.name}`);
    }
    const visited = new Set([target]);
    const pending = [target];
    while (pending.length > 0) {
      const current = pending.pop();
      for (const dependency of dependenciesOf(current)) {
        if (visited.has(dependency)) continue;
        visited.add(dependency);
        pending.push(dependency);
      }
    }
    const dependencyText = [...visited]
      .filter((symbol) => symbol !== target)
      .map((symbol) => canonicalDeclarationText(symbol))
      .filter(Boolean)
      .sort(compareText)
      .join("\n---\n");
    signatures.set(exported.name, {
      declarationHash: hashSignature("forge.api-declaration/1", directText),
      contractHash: hashSignature(
        "forge.api-contract/1",
        `${directText}\n--- engine-local dependencies ---\n${dependencyText}`,
      ),
    });
  }
  return signatures;
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
  const signatures = buildDeclarationSignatures(program, config, entryPath, root);

  const exportsList = moduleExports.map((alias) => {
    const target = (alias.flags & ts.SymbolFlags.Alias) !== 0 ? checker.getAliasedSymbol(alias) : alias;
    const signature = signatures.get(alias.name);
    if (!signature) failures.push(`${alias.name} is missing from the emitted declaration contract`);
    return {
      name: alias.name,
      kind: symbolKind(alias, target),
      stability: stabilityOf(alias, target, checker, failures),
      declarationHash: signature?.declarationHash ?? "",
      contractHash: signature?.contractHash ?? "",
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
    signatureFormat: API_SIGNATURE_FORMAT,
    typescriptVersion: ts.version,
    counts: countsFor(exportsList),
    exports: exportsList,
  };
}

export function canonicalApiSurface(surface) {
  return `${JSON.stringify(surface, null, 2)}\n`;
}

export function canonicalApiApprovals(approvals) {
  return `${JSON.stringify(approvals, null, 2)}\n`;
}

function validateObjectKeys(value, expected, label, failures) {
  const actual = Object.keys(value).sort(compareText);
  const wanted = [...expected].sort(compareText);
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    const missing = wanted.filter((key) => !actual.includes(key));
    const unknown = actual.filter((key) => !wanted.includes(key));
    const details = [
      missing.length > 0 ? `missing ${missing.join(", ")}` : "",
      unknown.length > 0 ? `unknown ${unknown.join(", ")}` : "",
    ].filter(Boolean).join("; ");
    failures.push(`${label} fields are invalid${details ? ` (${details})` : ""}`);
  }
}

function approvalCountsFor(surface, approvals) {
  return {
    approved: approvals.length,
    pendingPublic: surface.counts.public - approvals.length,
    experimental: surface.counts.experimental,
    deprecated: surface.counts.deprecated,
  };
}

/**
 * Validate the manual approval ledger against the current resolved surface.
 *
 * Approval is intentionally separate from `api:update`: a row means a reviewer inspected that
 * exact public declaration and transitive contract under a named review batch. Any subsequent
 * contract or classification drift makes the approval stale until it is reviewed explicitly.
 */
export function validateRecordedApprovals(approvals, surface, root = defaultRoot) {
  const failures = [];
  if (!approvals || typeof approvals !== "object" || Array.isArray(approvals)) {
    return ["approval ledger root must be an object"];
  }
  validateObjectKeys(
    approvals,
    ["schema", "package", "surfaceSchema", "signatureFormat", "policy", "counts", "reviews", "approvals"],
    "approval ledger",
    failures,
  );
  if (approvals.schema !== API_APPROVAL_SCHEMA) failures.push(`approval ledger schema must be ${API_APPROVAL_SCHEMA}`);
  if (approvals.package !== surface.package) failures.push(`approval ledger package must be ${surface.package}`);
  if (approvals.surfaceSchema !== API_SURFACE_SCHEMA) failures.push(`approval ledger surfaceSchema must be ${API_SURFACE_SCHEMA}`);
  if (approvals.signatureFormat !== API_SIGNATURE_FORMAT) {
    failures.push(`approval ledger signatureFormat must be ${API_SIGNATURE_FORMAT}`);
  }
  if (approvals.policy !== API_APPROVAL_POLICY) failures.push(`approval ledger policy must be ${API_APPROVAL_POLICY}`);

  const reviews = Array.isArray(approvals.reviews) ? approvals.reviews : [];
  if (!Array.isArray(approvals.reviews)) failures.push("approval ledger reviews must be an array");
  const reviewIds = new Set();
  let previousReview = null;
  for (const [index, review] of reviews.entries()) {
    if (!review || typeof review !== "object" || Array.isArray(review)) {
      failures.push(`approval review ${index} must be an object`);
      continue;
    }
    validateObjectKeys(review, ["id", "decision", "summary", "evidence"], `approval review ${index}`, failures);
    if (typeof review.id !== "string" || !/^[a-z0-9][a-z0-9.-]*\/[1-9][0-9]*$/.test(review.id)) {
      failures.push(`approval review ${index} has an invalid id`);
      continue;
    }
    if (reviewIds.has(review.id)) failures.push(`approval ledger repeats review ${review.id}`);
    reviewIds.add(review.id);
    if (previousReview !== null && compareText(previousReview, review.id) >= 0) {
      failures.push(`approval reviews are not strictly sorted at ${review.id}`);
    }
    previousReview = review.id;
    if (review.decision !== API_APPROVAL_DECISION) {
      failures.push(`${review.id} has unknown decision ${JSON.stringify(review.decision)}`);
    }
    if (typeof review.summary !== "string" || review.summary.trim().length === 0) {
      failures.push(`${review.id} must have a non-empty summary`);
    }
    const validEvidence = Array.isArray(review.evidence)
      && review.evidence.length > 0
      && review.evidence.every((item) => typeof item === "string" && item.length > 0)
      && new Set(review.evidence).size === review.evidence.length;
    if (!validEvidence) {
      failures.push(`${review.id} must list unique non-empty evidence paths`);
    } else {
      for (const evidence of review.evidence) {
        const normalized = path.normalize(evidence);
        const evidencePath = path.resolve(root, normalized);
        if (path.isAbsolute(evidence) || normalized === ".." || normalized.startsWith(`..${path.sep}`)) {
          failures.push(`${review.id} evidence must be a repository-relative path: ${evidence}`);
        } else if (!fs.existsSync(evidencePath) || !fs.statSync(evidencePath).isFile()) {
          failures.push(`${review.id} evidence does not exist: ${evidence}`);
        }
      }
    }
  }

  const rows = Array.isArray(approvals.approvals) ? approvals.approvals : [];
  if (!Array.isArray(approvals.approvals)) failures.push("approval ledger approvals must be an array");
  const surfaceByName = new Map(surface.exports.map((item) => [item.name, item]));
  const names = new Set();
  const usedReviews = new Set();
  let previousName = null;
  for (const [index, item] of rows.entries()) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      failures.push(`approval row ${index} must be an object`);
      continue;
    }
    validateObjectKeys(
      item,
      ["name", "kind", "declarationHash", "contractHash", "review"],
      `approval row ${index}`,
      failures,
    );
    if (typeof item.name !== "string" || item.name.length === 0) {
      failures.push(`approval row ${index} has no string name`);
      continue;
    }
    if (names.has(item.name)) failures.push(`approval ledger repeats symbol ${item.name}`);
    names.add(item.name);
    if (previousName !== null && compareText(previousName, item.name) >= 0) {
      failures.push(`approval rows are not strictly sorted at ${item.name}`);
    }
    previousName = item.name;
    if (!API_KINDS.includes(item.kind)) failures.push(`${item.name} approval has unknown kind ${JSON.stringify(item.kind)}`);
    if (!signatureHashPattern.test(item.declarationHash ?? "")) failures.push(`${item.name} approval has an invalid declarationHash`);
    if (!signatureHashPattern.test(item.contractHash ?? "")) failures.push(`${item.name} approval has an invalid contractHash`);
    if (typeof item.review !== "string" || !reviewIds.has(item.review)) {
      failures.push(`${item.name} approval references unknown review ${JSON.stringify(item.review)}`);
    } else {
      usedReviews.add(item.review);
    }

    const current = surfaceByName.get(item.name);
    if (!current) {
      failures.push(`${item.name} is approved but no longer exported from @forge/engine`);
      continue;
    }
    if (current.stability !== "public") {
      failures.push(`${item.name} is approved but its current stability is ${current.stability}, not public`);
    }
    if (item.kind !== current.kind) failures.push(`${item.name} approved kind no longer matches the current API surface`);
    if (item.declarationHash !== current.declarationHash) {
      failures.push(`${item.name} approved declarationHash no longer matches the current API surface; re-review the symbol before updating its approval`);
    }
    if (item.contractHash !== current.contractHash) {
      failures.push(`${item.name} approved contractHash no longer matches the current API surface; re-review the symbol before updating its approval`);
    }
  }
  for (const reviewId of reviewIds) {
    if (!usedReviews.has(reviewId)) failures.push(`${reviewId} has no approved symbols`);
  }

  if (!approvals.counts || typeof approvals.counts !== "object" || Array.isArray(approvals.counts)) {
    failures.push("approval ledger counts must be an object");
  } else {
    validateObjectKeys(
      approvals.counts,
      ["approved", "pendingPublic", "experimental", "deprecated"],
      "approval ledger counts",
      failures,
    );
    const expectedCounts = approvalCountsFor(surface, rows);
    if (JSON.stringify(approvals.counts) !== JSON.stringify(expectedCounts)) {
      failures.push("approval ledger counts do not match the current API surface and approval rows");
    }
  }
  return failures;
}

/** Validate a recorded surface independently of the current source tree. */
export function validateRecordedSurface(surface) {
  const failures = [];
  if (!surface || typeof surface !== "object" || Array.isArray(surface)) return ["snapshot root must be an object"];
  if (surface.schema !== API_SURFACE_SCHEMA) failures.push(`snapshot schema must be ${API_SURFACE_SCHEMA}`);
  if (surface.signatureFormat !== API_SIGNATURE_FORMAT) failures.push(`snapshot signatureFormat must be ${API_SIGNATURE_FORMAT}`);
  if (typeof surface.typescriptVersion !== "string" || surface.typescriptVersion.length === 0) {
    failures.push("snapshot typescriptVersion must be a non-empty string");
  }
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
    if (!signatureHashPattern.test(item.declarationHash ?? "")) failures.push(`${item.name} has an invalid declarationHash`);
    if (!signatureHashPattern.test(item.contractHash ?? "")) failures.push(`${item.name} has an invalid contractHash`);
  }
  const expectedCounts = countsFor(surface.exports);
  if (JSON.stringify(surface.counts) !== JSON.stringify(expectedCounts)) failures.push("snapshot counts do not match its export rows");
  return failures;
}

/** Human-readable semantic differences between a reviewed and current surface. */
export function diffApiSurfaces(recorded, current) {
  const differences = [];
  for (const key of ["schema", "package", "packageVersion", "entrypoint", "signatureFormat", "typescriptVersion"]) {
    if (recorded?.[key] !== current[key]) differences.push(`${key}: ${JSON.stringify(recorded?.[key])} -> ${JSON.stringify(current[key])}`);
  }
  const recordedByName = new Map((recorded?.exports ?? []).map((item) => [item.name, item]));
  const currentByName = new Map(current.exports.map((item) => [item.name, item]));
  const unrecorded = current.exports.filter((item) => !recordedByName.has(item.name)).map((item) => item.name);
  const missing = (recorded?.exports ?? []).filter((item) => !currentByName.has(item.name)).map((item) => item.name);
  const changedClassifications = current.exports.flatMap((item) => {
    const old = recordedByName.get(item.name);
    if (!old || (old.kind === item.kind && old.stability === item.stability)) return [];
    return [`${item.name} (${old.kind}/${old.stability} -> ${item.kind}/${item.stability})`];
  });
  const changedDeclarations = current.exports
    .filter((item) => {
      const old = recordedByName.get(item.name);
      return old && old.declarationHash !== item.declarationHash;
    })
    .map((item) => item.name);
  const changedDependencies = current.exports
    .filter((item) => {
      const old = recordedByName.get(item.name);
      return old
        && old.declarationHash === item.declarationHash
        && old.contractHash !== item.contractHash;
    })
    .map((item) => item.name);
  if (unrecorded.length > 0) differences.push(`unrecorded exports: ${unrecorded.join(", ")}`);
  if (missing.length > 0) differences.push(`missing or renamed exports: ${missing.join(", ")}`);
  if (changedClassifications.length > 0) differences.push(`changed classifications: ${changedClassifications.join(", ")}`);
  if (changedDeclarations.length > 0) differences.push(`changed declarations: ${changedDeclarations.join(", ")}`);
  if (changedDependencies.length > 0) differences.push(`changed transitive contracts: ${changedDependencies.join(", ")}`);
  return differences;
}

function parseArgs(argv) {
  const options = { write: false, json: false, snapshot: null, approvals: null, root: defaultRoot, help: false };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === "--write") options.write = true;
    else if (argument === "--json") options.json = true;
    else if (argument === "--help" || argument === "-h") options.help = true;
    else if (argument === "--root") {
      const value = argv[++index];
      if (!value) throw new ApiAuditError("--root requires a path");
      options.root = path.resolve(value);
    } else if (argument.startsWith("--root=")) {
      const value = argument.slice("--root=".length);
      if (!value) throw new ApiAuditError("--root requires a path");
      options.root = path.resolve(value);
    } else if (argument === "--snapshot") {
      const value = argv[++index];
      if (!value) throw new ApiAuditError("--snapshot requires a path");
      options.snapshot = path.resolve(value);
    } else if (argument.startsWith("--snapshot=")) {
      const value = argument.slice("--snapshot=".length);
      if (!value) throw new ApiAuditError("--snapshot requires a path");
      options.snapshot = path.resolve(value);
    } else if (argument === "--approvals") {
      const value = argv[++index];
      if (!value) throw new ApiAuditError("--approvals requires a path");
      options.approvals = path.resolve(value);
    } else if (argument.startsWith("--approvals=")) {
      const value = argument.slice("--approvals=".length);
      if (!value) throw new ApiAuditError("--approvals requires a path");
      options.approvals = path.resolve(value);
    } else {
      throw new ApiAuditError(`unknown option: ${argument}`);
    }
  }
  if (options.write && options.json) throw new ApiAuditError("--write and --json cannot be combined");
  options.snapshot ??= path.join(options.root, "engine", "api-surface.json");
  options.approvals ??= path.join(options.root, "engine", "api-approvals.json");
  return options;
}

function usage() {
  return "Usage: node tools/api-audit.mjs [--write | --json] [--root PATH] [--snapshot PATH] [--approvals PATH]";
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
    current = buildApiSurface(options.root);
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
    console.log(`api:update OK — wrote ${current.counts.total.toLocaleString("en-US")} exports to ${path.relative(options.root, options.snapshot) || options.snapshot}`);
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

  let approvals;
  let approvalsText;
  try {
    approvalsText = fs.readFileSync(options.approvals, "utf8");
    approvals = JSON.parse(approvalsText);
  } catch (error) {
    console.error(
      `api:check FAILED — cannot read approval ledger ${options.approvals}: ${String(error)}\n`
      + "The approval ledger is manual reviewed data and is not created by api:update.",
    );
    return 1;
  }
  const invalidApprovals = validateRecordedApprovals(approvals, current, options.root);
  if (approvalsText !== canonicalApiApprovals(approvals)) {
    invalidApprovals.push("approval ledger JSON formatting is not canonical");
  }
  if (invalidApprovals.length > 0) {
    console.error(`api:check FAILED — invalid API approval ledger:\n  ${invalidApprovals.join("\n  ")}`);
    return 1;
  }

  const differences = diffApiSurfaces(recorded, current);
  if (differences.length > 0 || recordedText !== canonicalApiSurface(recorded)) {
    if (recordedText !== canonicalApiSurface(recorded)) differences.push("snapshot JSON formatting is not canonical");
    const snapshotLabel = path.relative(options.root, options.snapshot) || options.snapshot;
    console.error(`api:check FAILED — ${snapshotLabel} is stale:\n  ${differences.join("\n  ")}\nReview the API change, then run npm run api:update.`);
    return 1;
  }
  console.log(
    `api:check OK — ${current.counts.total.toLocaleString("en-US")} exports `
    + `(${current.counts.public.toLocaleString("en-US")} public, ${current.counts.experimental} experimental, ${current.counts.deprecated} deprecated); `
    + `${approvals.counts.approved.toLocaleString("en-US")}/${current.counts.public.toLocaleString("en-US")} public candidates approved `
    + `(${approvals.counts.pendingPublic.toLocaleString("en-US")} pending); root-only boundary, declaration contracts and approvals intact.`,
  );
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
