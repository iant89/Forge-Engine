import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import ts from "typescript";
import { SMOKE_FLOOR, isFallbackFile, isFoundationFile, subsystemForFile } from "./subsystems.mjs";

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

// ---------------------------------------------------------------------------
// Safe selection with complementary evidence sources (P2 upgrade)
// ---------------------------------------------------------------------------

/** Build full project import graph for transitive impact analysis. */
export function buildProjectGraph(root = process.cwd()) {
  const rootAbs = path.resolve(root);
  const allFiles = discoverProjectFiles(rootAbs);
  const graph = new Map();
  for (const file of allFiles) {
    const absolute = path.resolve(rootAbs, file);
    if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) {
      graph.set(file, { deps: [], specifiers: [], unresolved: [] });
      continue;
    }
    const ext = path.extname(file);
    const isText = textExtensions.has(ext) || [".mjs", ".js", ".cjs", ".mts", ".cts"].includes(ext);
    if (!isText) {
      graph.set(file, { deps: [], specifiers: [], unresolved: [] });
      continue;
    }
    try {
      const source = fs.readFileSync(absolute, "utf8");
      const specs = staticSpecifiers(source, absolute);
      const deps = [];
      const unresolved = [];
      for (const spec of specs) {
        const target = resolveProjectSpecifier(spec, file, rootAbs);
        if (target) deps.push(target);
        else if (spec.startsWith(".") || spec.startsWith("@forge/")) unresolved.push(spec);
      }
      graph.set(file, { deps, specifiers: specs, unresolved });
    } catch {
      graph.set(file, { deps: [], specifiers: [], unresolved: [], parseError: true });
    }
  }
  const reverse = new Map();
  for (const file of graph.keys()) reverse.set(file, new Set());
  for (const [file, { deps }] of graph) {
    for (const dep of deps) {
      if (!reverse.has(dep)) reverse.set(dep, new Set());
      reverse.get(dep).add(file);
    }
  }
  return { graph, reverse, allFiles };
}

function discoverProjectFiles(rootAbs) {
  const files = [];
  const ignored = new Set([".git", "node_modules", ".next", ".turbo", ".cache", "coverage", "dist", "target", "out", ".arena"]);
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory() && ignored.has(entry.name)) continue;
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else if (entry.isFile()) {
        const rel = path.relative(rootAbs, absolute).split(path.sep).join("/");
        if (!rel.startsWith("../") && rel !== "..") files.push(rel);
      }
    }
  };
  walk(rootAbs);
  return files;
}

export function findTransitiveDependents(changedFiles, reverseGraph) {
  const result = new Set();
  const queue = [...changedFiles];
  const visited = new Set(changedFiles);
  while (queue.length > 0) {
    const current = queue.shift();
    const dependents = reverseGraph.get(current);
    if (!dependents) continue;
    for (const dep of dependents) {
      if (!visited.has(dep)) {
        visited.add(dep);
        result.add(dep);
        queue.push(dep);
      }
    }
  }
  return result;
}

export function assessChangeConfidence(changedPaths, root = process.cwd()) {
  const changes = [...new Set(changedPaths.map((f) => normalizePath(f, root)))];
  for (const file of changes) {
    if (isFallbackFile(file)) {
      return { fallback: true, reason: `config change: ${file} matches fallback pattern`, scope: "full", matchedFile: file };
    }
  }
  if (changes.length > 20) {
    return { fallback: true, reason: `large change set: ${changes.length} files`, scope: "full" };
  }
  // Missing files: treat rename (old + new in same change set) as move, not deletion
  const missing = [];
  for (const file of changes) {
    const abs = path.resolve(root, file);
    if (!fs.existsSync(abs)) {
      if (file.startsWith("engine/src/") || file.startsWith("tools/") || file.startsWith("packages/")) {
        // If this missing file has a counterpart new file in same subsystem, it's likely a rename — don't fallback
        const missingSub = subsystemForFile(file);
        const hasRenameCounterpart = changes.some((other) => {
          if (other === file) return false;
          if (!fs.existsSync(path.resolve(root, other))) return false;
          const otherSub = subsystemForFile(other);
          // Same subsystem or same directory prefix suggests rename
          if (missingSub && otherSub && missingSub === otherSub) return true;
          // Also check same directory
          const missingDir = path.dirname(file);
          const otherDir = path.dirname(other);
          if (missingDir === otherDir) return true;
          return false;
        });
        if (!hasRenameCounterpart) missing.push(file);
      }
    }
  }
  if (missing.length > 0) {
    return { fallback: true, reason: `deleted production file: ${missing[0]}`, scope: "full", missing };
  }
  const foundationHits = changes.filter((f) => isFoundationFile(f));
  if (foundationHits.length > 0) {
    return { fallback: false, reason: `foundation file: ${foundationHits.join(", ")}`, scope: "transitive", expanded: true, foundationHits };
  }
  return { fallback: false, reason: null, scope: "direct" };
}

export function mapFileToSubsystem(file) {
  return subsystemForFile(file);
}

/** Detect production source files not assigned to any subsystem. */
export function findUnmappedProductionFiles(root = process.cwd()) {
  const unmapped = [];
  const roots = ["engine/src", "examples/src"];
  const sourceExtensions = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".wgsl"]);
  for (const sourceRoot of roots) {
    const absoluteRoot = path.resolve(root, sourceRoot);
    const walk = (directory) => {
      if (!fs.existsSync(directory)) return;
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const absolute = path.join(directory, entry.name);
        if (entry.isDirectory()) walk(absolute);
        else if (entry.isFile() && sourceExtensions.has(path.extname(entry.name))) {
          const file = normalizePath(absolute, root);
          if (!subsystemForFile(file)) unmapped.push(file);
        }
      }
    };
    walk(absoluteRoot);
  }
  return unmapped;
}

export function subsystemsForChanges(changedFiles) {
  const subsystems = new Set();
  for (const file of changedFiles) {
    const sub = subsystemForFile(file);
    if (sub) subsystems.add(sub);
  }
  return subsystems;
}

/**
 * Enhanced selection that incorporates complementary impact evidence:
 * - direct covers (as before)
 * - transitive dependents (files that import changed files)
 * - subsystem mapping (suites covering same subsystem)
 * - mandatory smoke floor
 * - fallback to full when confidence is low
 *
 * This is the fail-safe path used by the CLI; the original selectSuitesForChanges
 * remains for backward-compatible unit tests.
 */
export function selectWithImpact(suites, changedPaths, options = {}) {
  const root = options.root ?? process.cwd();
  const graphInfo = options.graph ?? buildProjectGraph(root);
  const changes = [...new Set(changedPaths.map((f) => normalizePath(f, root)))];

  // Confidence assessment — may force full fallback
  let assessment = options.assessment ?? assessChangeConfidence(changes, root);

  const missingSmoke = SMOKE_FLOOR.filter((smoke) => !suites.some((suite) => normalizePath(suite.file, root) === normalizePath(smoke, root)));
  if (!assessment.fallback && missingSmoke.length > 0) {
    assessment = { fallback: true, reason: `smoke floor metadata missing: ${missingSmoke.join(", ")}`, scope: "full", missing: missingSmoke };
  }

  // A stale or incomplete subsystem map makes impact inference unsafe, even if the
  // currently changed file happens to be covered. Fail closed until map ownership is repaired.
  const unmappedProduction = findUnmappedProductionFiles(root);
  if (!assessment.fallback && unmappedProduction.length > 0) {
    assessment = { fallback: true, reason: `subsystem map has unmapped production files: ${unmappedProduction.slice(0, 3).join(", ")}`, scope: "full", unowned: unmappedProduction };
  }

  // If changed production code cannot be parsed or is missing from the resolved graph,
  // selection confidence is insufficient: fall back rather than infer a narrow scope.
  if (!assessment.fallback) {
    for (const file of changes) {
      if (!/^(engine|examples)\/src\//.test(file)) continue;
      const node = graphInfo.graph.get(file);
      const renameCounterpart = !fs.existsSync(path.resolve(root, file)) && changes.some((other) => other !== file && fs.existsSync(path.resolve(root, other)) && subsystemForFile(other) === subsystemForFile(file));
      if (renameCounterpart) continue;
      if (!node || node.parseError) {
        assessment = { fallback: true, reason: `dependency graph unresolved for ${file}`, scope: "full", matchedFile: file };
        break;
      }
      if (node.unresolved?.some((specifier) => specifier.startsWith(".") || specifier.startsWith("@forge/"))) {
        assessment = { fallback: true, reason: `unresolved import in ${file}`, scope: "full", matchedFile: file };
        break;
      }
    }
  }

  // Unowned file check: production file not covered and not in subsystem => fallback
  if (!assessment.fallback) {
    const unowned = [];
    for (const file of changes) {
      if (file.startsWith("tests/")) continue;
      if (file.startsWith("docs/") && !isFallbackFile(file)) continue; // docs changes are usually safe to not fallback
      const covered = suites.some((suite) =>
        suite.covers.some((cover) => {
          const nc = normalizePath(cover, root);
          if (nc.includes("*")) return globMatches(file, nc);
          return file === nc;
        })
      );
      if (!covered) {
        const sub = subsystemForFile(file);
        if (!sub) unowned.push(file);
      }
    }
    if (unowned.length > 0) {
      assessment = { fallback: true, reason: `unowned file(s): ${unowned.slice(0, 3).join(", ")}`, scope: "full", unowned };
    }
  }

  // Also handle config-like changes that are unowned but not matched by fallback patterns
  // e.g., new untracked config file — treat as fallback

  if (assessment.fallback) {
    const reasons = new Map();
    for (const suite of suites) {
      reasons.set(suite.file, { kind: "fallback", path: assessment.matchedFile ?? changes[0] ?? "unknown", reason: assessment.reason });
    }
    return {
      changedPaths: changes,
      suites: [...suites],
      reasons,
      assessment,
      smokeAdded: [],
      fallback: true,
      transitiveDependents: [],
      impactedSubsystems: [],
      evidenceCounts: { covers: 0, fallback: suites.length, transitive: 0, subsystem: 0, smoke: 0, suite: 0, "test-import": 0 },
    };
  }

  const transitiveDependents = findTransitiveDependents(changes, graphInfo.reverse);
  const impactedSubsystems = subsystemsForChanges(changes);
  const aggregators = new Set(["engine/src/index.ts", "engine/src/math/index.ts", "engine/src/scene/components/index.ts"]);
  const dependentInfo = [...transitiveDependents]
    .filter((file) => !aggregators.has(file))
    .map((file) => ({ file, subsystem: subsystemForFile(file) }));
  const changeInfo = changes.map((file) => ({
    file,
    subsystem: subsystemForFile(file),
    foundation: isFoundationFile(file),
    fanIn: graphInfo.reverse.get(file)?.size ?? 0,
  }));
  const suiteSubsystems = new Map(suites.map((suite) => [
    normalizePath(suite.file, root),
    suite.covers.map((cover) => ({ cover: normalizePath(cover, root), subsystem: subsystemForFile(normalizePath(cover, root)) })),
  ]));

  const selected = [];
  const reasons = new Map();
  const evidenceCounts = { covers: 0, transitive: 0, subsystem: 0, smoke: 0, suite: 0, "test-import": 0, fallback: 0 };

  for (const suite of suites) {
    const suiteFile = normalizePath(suite.file, root);
    const ownChange = changes.find((f) => f === suiteFile);
    if (ownChange) {
      selected.push(suite);
      reasons.set(suiteFile, { kind: "suite", path: ownChange });
      evidenceCounts.suite++;
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
      evidenceCounts.covers++;
      continue;
    }

    // Reverse-graph transitives: identify files that import a changed file, then
    // match those dependents to the suite's explicit covers. This is linear in the
    // graph frontier and avoids recomputing a dependency closure per coverage claim.
    let transitiveHit = null;
    const suiteCovers = suiteSubsystems.get(suiteFile) ?? [];
    for (const dependent of dependentInfo) {
      const cover = suiteCovers.find((candidate) => {
        if (candidate.cover.includes("*")) return globMatches(dependent.file, candidate.cover);
        return dependent.file === candidate.cover;
      });
      if (!cover) continue;
      const changed = changeInfo.find((candidate) =>
        (dependent.subsystem && candidate.subsystem && dependent.subsystem === candidate.subsystem) ||
        candidate.foundation || candidate.fanIn >= 10,
      );
      if (changed) {
        transitiveHit = { kind: "transitive", path: changed.file, claim: cover.cover, via: dependent.file };
        break;
      }
    }
    if (transitiveHit) {
      selected.push(suite);
      reasons.set(suiteFile, transitiveHit);
      evidenceCounts.transitive++;
      continue;
    }

    // Subsystem: suite covers file in same subsystem as changed file
    if (impactedSubsystems.size > 0) {
      let subsystemHit = null;
      for (const cover of suite.covers) {
        const coverSub = subsystemForFile(normalizePath(cover, root));
        if (coverSub && impactedSubsystems.has(coverSub)) {
          const matchingChange = changes.find((c) => subsystemForFile(c) === coverSub);
          if (matchingChange) {
            // Avoid applying subsystem to docs/tests noise
            if (!["docs", "tests", "benchmarks", "config"].includes(coverSub)) {
              subsystemHit = { kind: "subsystem", path: matchingChange, claim: cover, subsystem: coverSub };
              break;
            }
          }
        }
      }
      if (subsystemHit) {
        selected.push(suite);
        reasons.set(suiteFile, subsystemHit);
        evidenceCounts.subsystem++;
        continue;
      }
    }

    const testChanges = changes.filter((f) => f.startsWith("tests/"));
    if (testChanges.length > 0) {
      const closure = staticImportClosure(suiteFile, root).files;
      const changed = testChanges.find((f) => closure.has(f));
      if (changed) {
        selected.push(suite);
        reasons.set(suiteFile, { kind: "test-import", path: changed });
        evidenceCounts["test-import"]++;
      }
    }
  }

  // Mandatory smoke floor — always add, regardless of scope
  const smokeAdded = [];
  for (const smokeFile of SMOKE_FLOOR) {
    const normalizedSmoke = normalizePath(smokeFile, root);
    if (!selected.some((s) => normalizePath(s.file, root) === normalizedSmoke)) {
      const suite = suites.find((s) => normalizePath(s.file, root) === normalizedSmoke);
      if (suite) {
        selected.push(suite);
        reasons.set(normalizedSmoke, { kind: "smoke", path: changes[0] ?? "smoke-floor", reason: "mandatory smoke floor" });
        smokeAdded.push(suite);
        evidenceCounts.smoke++;
      }
    }
  }

  const orderMap = new Map(suites.map((s, idx) => [normalizePath(s.file, root), idx]));
  selected.sort((a, b) => (orderMap.get(normalizePath(a.file, root)) ?? 0) - (orderMap.get(normalizePath(b.file, root)) ?? 0));

  return {
    changedPaths: changes,
    suites: selected,
    reasons,
    assessment,
    smokeAdded,
    fallback: false,
    transitiveDependents: [...transitiveDependents],
    impactedSubsystems: [...impactedSubsystems],
    evidenceCounts,
  };
}

/** Backward-compatible alias for safe selection */
export const selectSuitesForChangesSafe = selectWithImpact;

/**
 * Measure false negatives vs false positives for a selection.
 */
export function measureAccuracy(selection, fullResults, allSuites) {
  const selectedFiles = new Set(selection.suites.map((s) => s.file));
  let truePositives = 0;
  let falsePositives = 0;
  let trueNegatives = 0;
  let falseNegatives = 0;
  const falseNegativeSuites = [];
  const falsePositiveSuites = [];
  for (const suite of allSuites) {
    const file = suite.file;
    const selected = selectedFiles.has(file);
    const result = fullResults.get(file);
    const failed = result ? !result.passed : false;
    if (selected && failed) truePositives++;
    else if (selected && !failed) falsePositives++;
    else if (!selected && !failed) trueNegatives++;
    else if (!selected && failed) {
      falseNegatives++;
      falseNegativeSuites.push(file);
    }
  }
  const total = allSuites.length;
  return {
    total,
    selected: selectedFiles.size,
    accuracy: (truePositives + trueNegatives) / total,
    falseNegativeRate: falseNegatives / Math.max(1, falseNegatives + truePositives),
    falsePositiveRate: falsePositives / Math.max(1, falsePositives + trueNegatives),
    precision: truePositives / Math.max(1, truePositives + falsePositives),
    recall: truePositives / Math.max(1, truePositives + falseNegatives),
    truePositives,
    falsePositives,
    trueNegatives,
    falseNegatives,
    falseNegativeSuites,
    falsePositiveSuites,
  };
}

export function wouldCatchRegression(selection, knownFailingSuites) {
  const selectedFiles = new Set(selection.suites.map((s) => s.file));
  const missed = knownFailingSuites.filter((f) => !selectedFiles.has(f));
  return { caught: missed.length === 0, missed, caughtCount: knownFailingSuites.length - missed.length, total: knownFailingSuites.length };
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
