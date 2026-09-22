#!/usr/bin/env node
/**
 * docs:check — the honesty gate (Phase 9.5 / 9.6).
 *
 * `npm test` proves the tests pass. It does not prove that the engine does what the documents say,
 * and it certainly does not prove that a subsystem is finished. This tool closes that gap by
 * cross-checking the three places where the project makes claims about itself:
 *
 *   ROADMAP.md            — what is done, in what order, and what is deliberately deferred
 *   docs/KNOWN-ISSUES.md  — what is missing or approximate *today*
 *   engine/src/core/capabilities.ts — the machine-readable status of every capability
 *
 * Rules enforced (each one has bitten a project somewhere):
 *
 *   1. Registry integrity: unique ids, `verified` entries carry evidence, unfinished entries name
 *      the roadmap work that closes them.
 *   2. Every evidence path exists on disk. "Tested in tests/foo.test.ts" must not point at a file
 *      that was renamed or never written.
 *   3. Every capability's roadmap phase/item exists in ROADMAP.md.
 *   4. ROADMAP.md's "CURRENT ENGINE STATE" block must equal the registry's phase status — the
 *      roadmap's summary cannot drift from the registry, so a phase cannot be advertised as
 *      verified while a capability in it is not.
 *   5. Every Phase 9 item is claimed by at least one capability (no item silently dropped).
 *   6. Every known limitation carries a reference — `(capability: id)` or `(roadmap: N.M)` — that
 *      resolves. The referenced capability (or the referenced item's phase) must not be
 *      `verified`: that is the stale-limitation check. Delete the bullet when the work lands.
 *   7. A closing statement, printed on success, about what these gates do *not* cover, so a green
 *      run is not read as "production ready".
 *
 * Run with `npm run docs:check`. Exits 1 with a list of violations, or 0 with a summary.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];
const fail = (rule, message) => failures.push(`[rule ${rule}] ${message}`);

function read(rel) {
  return fs.readFileSync(path.join(root, rel), "utf-8");
}

const { capabilityRegistry, ROADMAP_MARKER, ROADMAP_PHASE_STATUS, capabilityMarker } = await import(
  path.join(root, "engine/src/core/capabilities.ts")
);

const roadmap = read("ROADMAP.md");
const knownIssues = read("docs/KNOWN-ISSUES.md");

// ----------------------------------------------------------------- helpers

/** Normalizes a phase heading to the registry's key form: `8B` -> `8b`, `10+` -> `10+`. */
const phaseKey = (raw) => raw.toLowerCase().replace(/[^0-9a-z+]/g, "");

/** Markers used in ROADMAP.md, e.g. `[x]` -> `x`. */
const markerChar = (marker) => marker.replace(/[[\]]/g, "");

/** Registry phase key -> what ROADMAP.md must print. */
const expectedMarkers = new Map(
  Object.entries(ROADMAP_PHASE_STATUS).map(([key, status]) => [key, capabilityMarker(status)]),
);

function parsePhaseState(text) {
  const state = new Map();
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const heading = lines[i].match(/^PHASE\s+([0-9]+[A-Za-z+]*)/);
    if (!heading) continue;
    const marker = (lines[i + 1] ?? "").match(/^\s*\[(.?)\]/);
    if (marker) state.set(phaseKey(heading[1]), `[${marker[1]}]`);
  }
  return state;
}

function parseRoadmapItems(text) {
  const items = new Set();
  for (const line of text.split("\n")) {
    const m = line.match(/^(\d+\.\d+)\s+\S/);
    if (m) items.add(m[1]);
  }
  return items;
}

function parseRoadmapPhases(text) {
  const phases = new Set();
  for (const line of text.split("\n")) {
    // Phase banners are indented in the roadmap; the state block's lines are not.
    const m = line.match(/^\s*PHASE\s+([0-9]+[A-Za-z+]*)/);
    if (m) phases.add(phaseKey(m[1]));
  }
  return phases;
}

/** Section heading -> [{ line, text, refs }] for every `*` bullet, continuations joined. */
function parseKnownIssues(text) {
  const bullets = [];
  let section = "(none)";
  let current = null;
  const lines = text.split("\n");
  lines.forEach((line, index) => {
    const heading = line.match(/^#{2,3}\s+(.*)$/);
    if (heading) {
      section = heading[1].trim();
      current = null;
      return;
    }
    if (/^\*\s+/.test(line)) {
      current = { section, line: index + 1, text: line.replace(/^\*\s+/, "").trim(), refs: [] };
      bullets.push(current);
      return;
    }
    if (current && /^\s{2,}\S/.test(line)) {
      current.text += ` ${line.trim()}`;
      return;
    }
    if (line.trim() === "") current = null;
  });
  for (const bullet of bullets) {
    for (const group of bullet.text.matchAll(/\(([^()]*)\)/g)) {
      for (const clause of group[1].split(",")) {
        const ref = clause.trim().match(/^(capability|roadmap)\s*:\s*(.+)$/);
        if (ref) bullet.refs.push({ kind: ref[1], value: ref[2].trim().replace(/\.$/, "") });
      }
    }
  }
  return bullets;
}

const roadmapItems = parseRoadmapItems(roadmap);
const roadmapPhases = parseRoadmapPhases(roadmap);
const phaseState = parsePhaseState(roadmap);

/** Phase status from the registry, defaulting to `planned` for phases the roadmap has not started. */
function phaseStatus(key) {
  return ROADMAP_PHASE_STATUS[key] ?? "planned";
}

function evidenceExists(rel) {
  return fs.existsSync(path.join(root, rel));
}

// ------------------------------------------------- 1. registry integrity

const seenIds = new Set();
for (const entry of capabilityRegistry.entries) {
  const where = `capability "${entry.id}"`;
  if (seenIds.has(entry.id)) fail(1, `${where} is declared twice`);
  seenIds.add(entry.id);
  if (!/^[a-z][a-zA-Z0-9]*(\.[a-zA-Z0-9]+)+$/.test(entry.id)) {
    fail(1, `${where} is not an "area.feature" id`);
  }
  if (!entry.summary || entry.summary.length < 10) fail(1, `${where} has no usable summary`);
  if (entry.status === "verified") {
    if (!entry.evidence || entry.evidence.length === 0) {
      fail(1, `${where} is "verified" but names no evidence`);
    }
  } else if (entry.status === "partial" || entry.status === "inProgress") {
    if (!entry.closesWith) fail(1, `${where} is "${entry.status}" but names no closesWith`);
  } else if (entry.status === "planned" || entry.status === "deferred") {
    // A capability may be unmapped only if the deferral itself is documented: either a roadmap
    // item/phase that will close it, or a note explaining why the roadmap schedules nothing (for
    // example networking, which the roadmap gates behind the Phase 29 prerequisites). Silence is
    // what this rule exists to prevent.
    if (!entry.closesWith && !entry.notes) {
      fail(1, `${where} is "${entry.status}" but names neither closesWith nor notes`);
    }
  }
  for (const plan of [entry.closesWith]) {
    if (!plan) continue;
    if (/^\d+\.\d+$/.test(plan)) {
      if (!roadmapItems.has(plan)) fail(3, `${where} closes with roadmap item "${plan}", which does not exist`);
    } else if (!roadmapPhases.has(plan) && !ROADMAP_PHASE_STATUS[plan]) {
      fail(3, `${where} closes with phase "${plan}", which does not exist`);
    }
  }
}

// ------------------------------------------------- 2. evidence paths exist

for (const entry of capabilityRegistry.entries) {
  for (const item of entry.evidence ?? []) {
    if (!/\.(ts|mjs|js|json|md)$|^\.github\//.test(item)) continue; // free-form names are allowed
    if (!evidenceExists(item)) fail(2, `capability "${entry.id}" cites "${item}", which does not exist`);
  }
  for (const item of entry.evidence ?? []) {
    if (/^docs\//.test(item) && !evidenceExists(item)) {
      fail(2, `capability "${entry.id}" cites "${item}", which does not exist`);
    }
  }
}

// ------------------------------------------------- 3. phases exist

for (const entry of capabilityRegistry.entries) {
  if (/^\d+\.\d+$/.test(entry.phase)) {
    if (!roadmapItems.has(entry.phase)) {
      fail(3, `capability "${entry.id}" claims roadmap item "${entry.phase}", which does not exist`);
    }
    continue;
  }
  const key = phaseKey(entry.phase);
  if (key === "10+") continue;
  if (!roadmapPhases.has(key)) {
    fail(3, `capability "${entry.id}" claims roadmap phase "${entry.phase}", which does not exist`);
  }
}

// ------------------------------------------------- 4. roadmap state block matches registry

for (const [key, expected] of expectedMarkers) {
  const actual = phaseState.get(key);
  if (!actual) {
    fail(4, `ROADMAP.md has no "PHASE ${key}" line in its CURRENT ENGINE STATE block`);
  } else if (actual !== expected) {
    fail(
      4,
      `ROADMAP.md marks phase ${key} as ${actual}, but the capability registry says ${expected}` +
        ` (${ROADMAP_PHASE_STATUS[key]})`,
    );
  }
}
for (const key of phaseState.keys()) {
  if (!expectedMarkers.has(key)) {
    fail(4, `ROADMAP.md marks phase ${key}, which the capability registry does not track`);
  }
}

// ------------------------------------------------- 5. Phase 9 items are claimed

const phase9Items = [...roadmapItems].filter((item) => item.startsWith("9."));
for (const item of phase9Items) {
  const owners = capabilityRegistry.entries.filter((entry) => entry.phase === item);
  if (owners.length === 0) fail(5, `Phase 9 item ${item} is not claimed by any capability`);
}

// ------------------------------------------------- 6. known issues reference live work

const knownIssueBullets = parseKnownIssues(knownIssues);
if (knownIssueBullets.length === 0) fail(6, "docs/KNOWN-ISSUES.md has no limitations left — delete the file or fix the parser");

for (const bullet of knownIssueBullets) {
  const where = `KNOWN-ISSUES.md:${bullet.line} ("${bullet.text.slice(0, 60)}…")`;
  if (bullet.refs.length === 0) {
    fail(6, `${where} has no (capability: …) or (roadmap: …) reference`);
    continue;
  }
  for (const ref of bullet.refs) {
    if (ref.kind === "capability") {
      const entry = capabilityRegistry.get(ref.value);
      if (!entry) {
        fail(6, `${where} references unknown capability "${ref.value}"`);
      } else if (entry.status === "verified") {
        fail(
          6,
          `${where} references "${ref.value}", which is now "verified" — the limitation is stale, delete it`,
        );
      }
    } else {
      const value = ref.value;
      if (/^\d+\.\d+$/.test(value)) {
        if (!roadmapItems.has(value)) {
          fail(6, `${where} references roadmap item "${value}", which does not exist`);
        } else if (phaseStatus(value.split(".")[0]) === "verified") {
          fail(6, `${where} references roadmap item "${value}" in a verified phase — the limitation is stale`);
        }
      } else {
        const key = phaseKey(value);
        if (key !== "10+" && !roadmapPhases.has(key) && !ROADMAP_PHASE_STATUS[key]) {
          fail(6, `${where} references roadmap phase "${value}", which does not exist`);
        } else if (phaseStatus(key) === "verified") {
          fail(6, `${where} references roadmap phase "${value}", which is verified — the limitation is stale`);
        }
      }
    }
  }
}

// ------------------------------------------------- report

const counts = {};
for (const entry of capabilityRegistry.entries) counts[entry.status] = (counts[entry.status] ?? 0) + 1;

if (failures.length > 0) {
  console.error(`docs:check FAILED — ${failures.length} violation${failures.length === 1 ? "" : "s"}\n`);
  for (const failure of failures) console.error(`  - ${failure}`);
  console.error(
    "\nThe registry (engine/src/core/capabilities.ts) is the source of truth: fix the claim," +
      " or fix the code, but do not let the two disagree.",
  );
  process.exit(1);
}

const gaps = capabilityRegistry.gaps();
console.log(
  `docs:check OK — ${capabilityRegistry.entries.length} capabilities ` +
    `(${Object.entries(counts)
      .map(([status, count]) => `${status} ${count}`)
      .join(", ")}), ${knownIssueBullets.length} known limitations, ` +
    `${phase9Items.length} Phase 9 items claimed, roadmap state block matches the registry.`,
);
// Two different things hide behind "no closesWith": work that is scheduled but has no roadmap
// pointer (a defect in this registry) and work the roadmap deliberately schedules nothing for. Both
// stay visible here — the second by name, with its decision in the entry's `notes`.
const unmapped = gaps.filter((g) => !g.closesWith);
const deferredByDecision = unmapped.filter((g) => g.status === "deferred");
const unmappedUnscheduled = unmapped.filter((g) => g.status !== "deferred");
console.log(
  `  unfinished work: ${gaps.length} entries; ${unmappedUnscheduled.length} without a roadmap item` +
    (deferredByDecision.length > 0
      ? `; ${deferredByDecision.length} deferred by decision (${deferredByDecision
          .map((g) => g.id)
          .join(", ")})`
      : ""),
);
console.log(
  "  NOT covered by CI: WebKit/Safari and mobile browsers (nothing compiles the shaders there)," +
    " GPU timings, and any soak run. The real-WebGPU gate runs as an advisory job that cannot block" +
    " a merge, and a runner with no WebGPU adapter reports that it did not run. A green CI run" +
    " means the CPU gates passed.",
);
