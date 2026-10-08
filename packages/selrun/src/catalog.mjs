import * as fs from "node:fs";
import * as path from "node:path";
import ts from "typescript";
import { globMatches, normalizePath } from "./selection.mjs";

const FULL_SUITE_FILE = "tests/full.test.ts";

function scriptKind(fileName) {
  return fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : fileName.endsWith(".js") || fileName.endsWith(".mjs") ? ts.ScriptKind.JS : ts.ScriptKind.TS;
}

function parseSource(file, root) {
  const absolute = path.resolve(root, file);
  const source = fs.readFileSync(absolute, "utf8");
  const sourceFile = ts.createSourceFile(absolute, source, ts.ScriptTarget.Latest, true, scriptKind(absolute));
  return { absolute, source, sourceFile };
}

function propertyName(node) {
  if (!node.name) return null;
  if (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name) || ts.isNumericLiteral(node.name)) return node.name.text;
  return null;
}

function findProperty(object, name) {
  return object.properties.find((property) => ts.isPropertyAssignment(property) && propertyName(property) === name);
}

function getString(node) {
  return node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : null;
}

function getArrayOfStrings(node) {
  if (!node || !ts.isArrayLiteralExpression(node)) return null;
  const items = [];
  for (const element of node.elements) {
    const text = getString(element);
    if (text === null) return null;
    items.push(text);
  }
  return items;
}

function exportedSuiteObject(sourceFile) {
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    if (!statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.name.text === "suite" && declaration.initializer && ts.isObjectLiteralExpression(declaration.initializer)) {
        return declaration.initializer;
      }
    }
  }
  return null;
}

function readHeader(source) {
  const comment = source.match(/^\s*\/\*\*([\s\S]*?)\*\//)?.[1];
  if (comment === undefined) return null;
  const directives = { suite: [], group: [], covers: [], desc: [] };
  for (const line of comment.split(/\r?\n/)) {
    const content = line.replace(/^\s*\*?\s?/, "").trim();
    const match = content.match(/^@(suite|group|covers|desc)\s+(.+?)\s*$/);
    if (!match) continue;
    const [, key, value] = match;
    if (key === "covers") directives.covers.push(...value.split(/\s+/).filter(Boolean).map((cover) => cover.replaceAll("\\/", "/")));
    else directives[key].push(value);
  }
  return directives;
}

/** Read a suite's exported manifest and its matching JSDoc header. */
export function readSuiteManifest(file, root = process.cwd()) {
  const normalized = normalizePath(file, root);
  const { source, sourceFile } = parseSource(normalized, root);
  const object = exportedSuiteObject(sourceFile);
  if (!object) return { file: normalized, header: readHeader(source), manifest: null, parseErrors: sourceFile.parseDiagnostics };
  const name = getString(findProperty(object, "name")?.initializer);
  const group = getString(findProperty(object, "group")?.initializer);
  const desc = getString(findProperty(object, "desc")?.initializer);
  const covers = getArrayOfStrings(findProperty(object, "covers")?.initializer);
  return {
    file: normalized,
    header: readHeader(source),
    manifest: { name, group, covers, desc },
    parseErrors: sourceFile.parseDiagnostics,
  };
}

/** Find every TypeScript suite in its required tests/<area>/<name>.test.ts location. */
export function discoverSuiteFiles(root = process.cwd()) {
  const testsRoot = path.resolve(root, "tests");
  const files = [];
  const walk = (directory) => {
    if (!fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else if (entry.isFile() && entry.name.endsWith(".test.ts")) files.push(normalizePath(absolute, root));
    }
  };
  walk(testsRoot);
  return files.filter((file) => file !== FULL_SUITE_FILE).sort();
}

function discoverRepositoryFiles(root) {
  const files = [];
  const ignored = new Set([".git", "node_modules", ".next", ".turbo", ".cache", "coverage", "dist", "target", "out"]);
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory() && ignored.has(entry.name)) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else if (entry.isFile()) files.push(normalizePath(absolute, root));
    }
  };
  walk(root);
  return files;
}

function discoverAreas(root) {
  const areas = new Set();
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory()) areas.add(entry.name);
  }
  for (const sourceRoot of ["engine/src", "examples/src"]) {
    const absolute = path.resolve(root, sourceRoot);
    if (!fs.existsSync(absolute)) continue;
    for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
      if (entry.isDirectory()) areas.add(entry.name);
    }
  }
  return areas;
}

function findDynamicImport(node) {
  let found = null;
  const visit = (current) => {
    if (found) return;
    if (ts.isCallExpression(current) && current.expression.kind === ts.SyntaxKind.ImportKeyword && current.arguments.length === 1) {
      found = getString(current.arguments[0]);
      return;
    }
    ts.forEachChild(current, visit);
  };
  visit(node);
  return found;
}

/** Read the ordered links from tests/full.test.ts. */
export function readLinkedSuites(root = process.cwd()) {
  const { source, sourceFile } = parseSource(FULL_SUITE_FILE, root);
  let linkedArray = null;
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.name.text === "linkedSuites" && declaration.initializer) {
        let initializer = declaration.initializer;
        if (ts.isAsExpression(initializer) || ts.isSatisfiesExpression(initializer)) initializer = initializer.expression;
        if (ts.isArrayLiteralExpression(initializer)) linkedArray = initializer;
      }
    }
  }

  const links = [];
  if (linkedArray) {
    for (const element of linkedArray.elements) {
      if (!ts.isArrayLiteralExpression(element) || element.elements.length !== 2) {
        links.push({ file: null, importPath: null });
        continue;
      }
      const linkedPath = getString(element.elements[0]);
      const importPath = findDynamicImport(element.elements[1]);
      const resolvedImport = importPath === null ? null : normalizePath(path.resolve("tests", importPath), root);
      links.push({ file: linkedPath === null ? null : normalizePath(linkedPath, root), importPath: resolvedImport });
    }
  }

  const reportCounts = [];
  const visit = (node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "report" && node.arguments.length === 1) {
      const arg = node.arguments[0];
      reportCounts.push(ts.isNumericLiteral(arg) ? Number(arg.text) : null);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return { links, reportCounts, parseErrors: sourceFile.parseDiagnostics, source };
}

/** Validate link completeness, manifest/header agreement, unique names, and non-empty covers. */
export function validateCatalog(root = process.cwd()) {
  const errors = [];
  const suiteFiles = discoverSuiteFiles(root);
  const { links, reportCounts, parseErrors } = readLinkedSuites(root);
  const linkFiles = links.map((link) => link.file).filter(Boolean);
  const manifests = suiteFiles.map((file) => readSuiteManifest(file, root));
  const names = new Map();
  const areaNames = discoverAreas(root);
  const repositoryFiles = new Set(discoverRepositoryFiles(root));
  let coverageClaims = 0;

  if (parseErrors.length > 0) errors.push(`${FULL_SUITE_FILE} has TypeScript parse errors`);
  for (const suite of manifests) {
    if (suite.parseErrors.length > 0) errors.push(`${suite.file} has TypeScript parse errors`);
    if (!suite.header) {
      errors.push(`${suite.file} is missing its leading suite JSDoc header`);
      continue;
    }
    if (!suite.manifest) {
      errors.push(`${suite.file} must export a const named suite`);
      continue;
    }
    const { manifest, header, file } = suite;
    for (const key of ["suite", "group", "desc"]) {
      if (header[key].length !== 1) errors.push(`${file} must declare exactly one @${key} line`);
    }
    if (header.covers.length === 0) errors.push(`${file} must declare at least one @covers claim`);
    if (new Set(header.covers).size !== header.covers.length) errors.push(`${file} repeats an @covers claim`);
    for (const key of ["name", "group", "desc"]) {
      const directive = key === "name" ? header.suite[0] : header[key][0];
      if (directive !== manifest[key]) errors.push(`${file} header @${key === "name" ? "suite" : key} does not match suite.${key}`);
    }
    if (!Array.isArray(manifest.covers) || manifest.covers.length === 0) {
      errors.push(`${file} has empty suite.covers`);
    } else if (JSON.stringify(header.covers) !== JSON.stringify(manifest.covers)) {
      errors.push(`${file} header @covers claims do not match suite.covers`);
    } else {
      coverageClaims += manifest.covers.length;
      for (const cover of manifest.covers) {
        if (cover.includes("*")) {
          if (!Array.from(repositoryFiles).some((repositoryFile) => globMatches(repositoryFile, cover))) {
            errors.push(`${file} @covers ${cover} matches no repository file`);
          }
        } else if (!repositoryFiles.has(normalizePath(cover, root))) {
          errors.push(`${file} @covers ${cover} is not a repository file`);
        }
      }
    }
    if (!manifest.name || !manifest.group || !manifest.desc) errors.push(`${file} has an incomplete suite manifest`);
    if (manifest.desc && /[\r\n]/.test(manifest.desc)) errors.push(`${file} suite.desc must be one line`);
    if (manifest.name) {
      const prior = names.get(manifest.name);
      if (prior) errors.push(`duplicate suite name ${manifest.name}: ${prior} and ${file}`);
      else names.set(manifest.name, file);
    }
    const relativeParts = file.split("/");
    if (relativeParts.length !== 3 || relativeParts[0] !== "tests") {
      errors.push(`${file} must be directly under tests/<area>/`);
    } else {
      const area = relativeParts[1];
      if (!areaNames.has(area)) errors.push(`${file} uses area ${area}, which is not a repository directory`);
      if (manifest.name && !manifest.name.startsWith(`${area}:`)) {
        errors.push(`${file} suite.name must use its area prefix ${area}:`);
      }
    }
  }

  const duplicateLinks = linkFiles.filter((file, index) => linkFiles.indexOf(file) !== index);
  for (const file of duplicateLinks) errors.push(`${FULL_SUITE_FILE} links ${file} more than once`);
  for (const link of links) {
    if (!link.file || !link.importPath) {
      errors.push(`${FULL_SUITE_FILE} has a link without a literal tests path and dynamic import`);
      continue;
    }
    if (link.file !== link.importPath) errors.push(`${FULL_SUITE_FILE} link ${link.file} imports ${link.importPath}`);
    if (!suiteFiles.includes(link.file)) errors.push(`${FULL_SUITE_FILE} links unknown suite ${link.file}`);
  }
  const linkedSet = new Set(linkFiles);
  for (const file of suiteFiles) if (!linkedSet.has(file)) errors.push(`${file} is not linked from ${FULL_SUITE_FILE}`);
  for (const file of linkFiles) if (!suiteFiles.includes(file)) errors.push(`${file} is linked but is not a suite on disk`);
  if (reportCounts.length !== 1) errors.push(`${FULL_SUITE_FILE} must call report(n) exactly once`);
  else if (reportCounts[0] !== links.length) errors.push(`${FULL_SUITE_FILE} report(${reportCounts[0]}) must equal ${links.length} linked suites`);

  return {
    errors,
    suites: manifests.map(({ file, manifest }) => ({ file, ...(manifest ?? {}) })),
    linkedSuites: linkFiles,
    stats: {
      suitesOnDisk: suiteFiles.length,
      suitesLinked: linkFiles.length,
      suitesNamed: names.size,
      suitesWithCoverage: manifests.filter((suite) => Array.isArray(suite.manifest?.covers) && suite.manifest.covers.length > 0).length,
      coverageClaims,
    },
  };
}
