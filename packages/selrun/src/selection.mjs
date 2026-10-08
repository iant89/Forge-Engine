import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import ts from "typescript";

const textExtensions = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);
const internalAliases = new Map([
  ["@forge/engine", "engine/src/index.ts"],
  ["@forge/editor", "editor/src/index.ts"],
  ["selrun", "packages/selrun/src/index.ts"],
]);

/** Convert a repository path to a stable POSIX-relative path. */
export function normalizePath(file, root = process.cwd()) {
  const raw = String(file).replaceAll("\\", "/");
  const absolute = path.isAbsolute(raw) ? raw : path.resolve(root, raw);
  return path.relative(root, absolute).split(path.sep).join("/").replace(/^\.\//, "");
}

/** Match `*` within one path segment and `**` across zero or more path segments. */
export function globMatches(file, pattern) {
  const target = String(file).replaceAll("\\", "/").split("/");
  const parts = String(pattern).replaceAll("\\", "/").split("/");
  const memo = new Map();
  const segmentMatches = (value, glob) => {
    if (glob === "*") return value.length > 0;
    const escaped = [...glob].map((character) => character === "*" ? "[^/]*" : ".+?^${}()|[]\\".includes(character) ? `\\${character}` : character).join("");
    return new RegExp(`^${escaped}$`).test(value);
  };
  const visit = (patternIndex, targetIndex) => {
    const key = `${patternIndex}:${targetIndex}`;
    const cached = memo.get(key);
    if (cached !== undefined) return cached;
    if (patternIndex === parts.length) return targetIndex === target.length;
    const part = parts[patternIndex];
    let result;
    if (part === "**") {
      result = visit(patternIndex + 1, targetIndex) ||
        (targetIndex < target.length && visit(patternIndex, targetIndex + 1));
    } else {
      result = targetIndex < target.length && segmentMatches(target[targetIndex], part) && visit(patternIndex + 1, targetIndex + 1);
    }
    memo.set(key, result);
    return result;
  };
  return visit(0, 0);
}

/** Match one explicit suite coverage claim against one normalized changed path/token. */
export function matchesCover(changedPath, cover, root = process.cwd()) {
  const normalizedChanged = normalizePath(changedPath, root);
  const normalizedCover = normalizePath(cover, root);
  if (normalizedCover.includes("*")) return globMatches(normalizedChanged, normalizedCover);
  return normalizedChanged === normalizedCover;
}

/** Parse static local specifiers from TypeScript/JavaScript. Dynamic imports are intentionally excluded. */
export function staticSpecifiers(source, fileName = "module.ts") {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, scriptKind(fileName));
  const found = [];
  const addLiteral = (node) => {
    if (node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))) found.push(node.text);
  };
  const visit = (node) => {
    if (ts.isImportDeclaration(node)) addLiteral(node.moduleSpecifier);
    else if (ts.isExportDeclaration(node)) addLiteral(node.moduleSpecifier);
    else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) addLiteral(node.moduleReference.expression);
    else if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "require" && node.arguments.length === 1) addLiteral(node.arguments[0]);
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return [...new Set(found)];
}

function scriptKind(fileName) {
  return fileName.endsWith(".tsx") || fileName.endsWith(".jsx") ? ts.ScriptKind.TSX : fileName.endsWith(".js") || fileName.endsWith(".mjs") || fileName.endsWith(".cjs") ? ts.ScriptKind.JS : ts.ScriptKind.TS;
}

function candidatesFor(base) {
  const ext = path.extname(base);
  const candidates = [base];
  const remap = new Map([[".js", ".ts"], [".jsx", ".tsx"], [".mjs", ".mts"], [".cjs", ".cts"]]);
  if (remap.has(ext)) candidates.push(base.slice(0, -ext.length) + remap.get(ext));
  if (!ext || !textExtensions.has(ext)) {
    for (const suffix of [".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".json"]) candidates.push(base + suffix);
  }
  for (const index of ["index.ts", "index.tsx", "index.mts", "index.js", "index.mjs"]) candidates.push(path.join(base, index));
  return candidates;
}

/** Resolve a project file specifier; external and unresolved modules return null and are not walked. */
export function resolveProjectSpecifier(specifier, importer, root = process.cwd()) {
  if (specifier.startsWith("node:")) return null;
  let base;
  if (internalAliases.has(specifier)) {
    base = path.resolve(root, internalAliases.get(specifier));
  } else if (specifier.startsWith(".")) {
    base = path.resolve(root, path.dirname(importer), specifier);
  } else {
    // Only workspaces explicitly owned by this repository are traversed. Registry packages remain
    // graph leaves, even if their source happens to be available under node_modules.
    return null;
  }

  for (const candidate of candidatesFor(base)) {
    if (!fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) continue;
    const relative = path.relative(root, candidate).split(path.sep).join("/");
    if (relative === ".." || relative.startsWith("../") || path.isAbsolute(relative)) continue;
    if (relative.startsWith("node_modules/")) continue;
    return relative;
  }
  return null;
}

/** Build the suite's static import closure. Project production nodes stay in the graph but never select suites. */
export function staticImportClosure(suiteFile, root = process.cwd()) {
  const rootAbs = path.resolve(root);
  const start = normalizePath(suiteFile, rootAbs);
  const visited = new Set();
  const graph = new Map();
  const queue = [start];
  while (queue.length > 0) {
    const current = queue.shift();
    if (visited.has(current)) continue;
    visited.add(current);
    const absolute = path.resolve(rootAbs, current);
    if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) {
      graph.set(current, []);
      continue;
    }
    const source = fs.readFileSync(absolute, "utf8");
    const edges = staticSpecifiers(source, absolute).map((specifier) => ({
      specifier,
      target: resolveProjectSpecifier(specifier, current, rootAbs),
    }));
    graph.set(current, edges);
    for (const edge of edges) if (edge.target && !visited.has(edge.target)) queue.push(edge.target);
  }
  return { files: visited, graph };
}

/** Select all suites with direct-file, explicit-cover, or test-only static-import-closure evidence. */
export function selectSuitesForChanges(suites, changedPaths, root = process.cwd()) {
  const changes = [...new Set(changedPaths.map((file) => normalizePath(file, root)))];
  const selected = [];
  const reasons = new Map();
  for (const suite of suites) {
    const suiteFile = normalizePath(suite.file, root);
    const ownChange = changes.find((file) => file === suiteFile);
    if (ownChange) {
      selected.push(suite);
      reasons.set(suiteFile, { kind: "suite", path: ownChange });
      continue;
    }

    let hit = null;
    for (const changed of changes) {
      const claim = suite.covers.find((cover) => matchesCover(changed, cover, root));
      if (claim !== undefined) {
        hit = { kind: "covers", path: changed, claim };
        break;
      }
    }
    if (hit) {
      selected.push(suite);
      reasons.set(suiteFile, hit);
      continue;
    }

    const testChanges = changes.filter((file) => file.startsWith("tests/"));
    if (testChanges.length > 0) {
      const closure = staticImportClosure(suiteFile, root).files;
      const changed = testChanges.find((file) => closure.has(file));
      if (changed) {
        selected.push(suite);
        reasons.set(suiteFile, { kind: "test-import", path: changed });
      }
    }
  }
  return { changedPaths: changes, suites: selected, reasons };
}

/** Parse `git diff --name-status -z`, retaining both sides of rename/copy records. */
export function parseNameStatusZ(output) {
  const fields = output.split("\0").filter((field, index, all) => !(field === "" && index === all.length - 1));
  const paths = [];
  for (let i = 0; i < fields.length;) {
    const status = fields[i++];
    const kind = status[0];
    if (kind === "R" || kind === "C") {
      const oldPath = fields[i++];
      const newPath = fields[i++];
      if (oldPath) paths.push(oldPath);
      if (newPath) paths.push(newPath);
    } else {
      const changedPath = fields[i++];
      if (changedPath) paths.push(changedPath);
    }
  }
  return [...new Set(paths)];
}

function git(root, args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${(result.stderr || "").trim()}`);
  }
  return result.stdout;
}

/** Collect staged, unstaged, deleted, renamed, and untracked working-tree paths. */
export function collectWorkingChanges(root = process.cwd()) {
  const tracked = parseNameStatusZ(git(root, ["diff", "--name-status", "--find-renames", "-z", "HEAD"]));
  const untracked = git(root, ["ls-files", "--others", "--exclude-standard", "-z"]).split("\0").filter(Boolean);
  return [...new Set([...tracked, ...untracked].map((file) => normalizePath(file, root)))];
}

/** A branch comparison is exactly `base...HEAD`; local/staged/untracked changes are not included. */
export function collectBaseChanges(base, root = process.cwd()) {
  if (!base || base.startsWith("-")) throw new Error(`invalid comparison base: ${base}`);
  const output = git(root, ["diff", "--name-status", "--find-renames", "-z", `${base}...HEAD`]);
  return [...new Set(parseNameStatusZ(output).map((file) => normalizePath(file, root)))];
}

/** Utility for tests and the CLI: return a shell-safe display form without changing a path. */
export function formatPath(file) {
  return String(file).replaceAll("\\", "/");
}
