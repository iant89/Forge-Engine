import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ROADMAP_MARKER,
  ROADMAP_PHASE_STATUS,
  capabilityMarker,
  capabilityRegistry,
  capabilityStatus,
} from "@forge/engine";

/**
 * Phase 9.5 / 9.6 — the capability registry is only useful if it cannot lie.
 *
 * These tests check the registry's own contract (ids, evidence, gaps) and the two documents it is
 * wired into: `ROADMAP.md`'s engine-state block must match its phase statuses, and every limitation
 * in `docs/KNOWN-ISSUES.md` must reference a capability that is *not* verified. The same rules run
 * as the `npm run docs:check` gate (`tools/docs-check.mjs`); this suite is the developer-loop half
 * and also proves the gate itself executes cleanly.
 */

const root = path.resolve(__dirname, "..");
const README_ANCHOR = "engine/src/core/capabilities.ts";

function read(rel: string): string {
  return fs.readFileSync(path.join(root, rel), "utf-8");
}

function exists(rel: string): boolean {
  return fs.existsSync(path.join(root, rel));
}

const roadmap = read("ROADMAP.md");
const knownIssues = read("docs/KNOWN-ISSUES.md");

const roadmapItems = new Set(
  roadmap
    .split("\n")
    .map((line) => line.match(/^(\d+\.\d+)\s+\S/)?.[1])
    .filter((item): item is string => Boolean(item)),
);

const roadmapPhases = new Set(
  roadmap
    .split("\n")
    .map((line) => line.match(/^\s*PHASE\s+([0-9]+[A-Za-z+]*)/)?.[1]?.toLowerCase())
    .filter((phase): phase is string => Boolean(phase)),
);

/** Roadmap engine-state block: `PHASE 8B` followed by a `[x]`-style marker line. */
function roadmapStateBlock(): Map<string, string> {
  const state = new Map<string, string>();
  const lines = roadmap.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const heading = lines[i]?.match(/^PHASE\s+([0-9]+[A-Za-z+]*)/);
    if (!heading) continue;
    const marker = lines[i + 1]?.match(/^\s*\[(.?)\]/);
    if (marker?.[1]) state.set(heading[1]!.toLowerCase(), `[${marker[1]}]`);
  }
  return state;
}

interface IssueRef {
  kind: "capability" | "roadmap";
  value: string;
}

/** Limitation bullets, with continuations joined, plus the references they carry. */
function knownIssueBullets(): { line: number; text: string; refs: IssueRef[] }[] {
  const bullets: { line: number; text: string; refs: IssueRef[] }[] = [];
  knownIssues.split("\n").forEach((line, index) => {
    if (!/^\*\s+/.test(line)) return;
    bullets.push({ line: index + 1, text: line.replace(/^\*\s+/, "").trim(), refs: [] });
  });
  // Continuations are indented; attach them before scanning for references.
  const lines = knownIssues.split("\n");
  for (const bullet of bullets) {
    let j = bullet.line; // bullet.line is 1-based and points at the following line
    while (lines[j]?.startsWith("  ") && lines[j]!.trim() !== "") {
      bullet.text += ` ${lines[j]!.trim()}`;
      j++;
    }
    for (const group of bullet.text.matchAll(/\(([^()]*)\)/g)) {
      for (const clause of group[1]!.split(",")) {
        const ref = clause.trim().match(/^(capability|roadmap)\s*:\s*(.+)$/);
        if (ref) bullet.refs.push({ kind: ref[1] as IssueRef["kind"], value: ref[2]!.trim() });
      }
    }
  }
  return bullets;
}

describe("Phase 9.5 — capability registry", () => {
  it("declares every capability once, with an area.feature id and a usable summary", () => {
    const ids = capabilityRegistry.entries.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBeGreaterThan(40);
    for (const entry of capabilityRegistry.entries) {
      expect(entry.id, `${README_ANCHOR}: bad id`).toMatch(/^[a-z][a-zA-Z0-9]*(\.[a-zA-Z0-9]+)+$/);
      expect(entry.summary.length, `${entry.id} summary`).toBeGreaterThan(10);
      expect(["verified", "partial", "inProgress", "planned", "deferred"]).toContain(entry.status);
    }
  });

  it("keeps every status honest: verified cites evidence, unfinished work names the closer", () => {
    for (const entry of capabilityRegistry.entries) {
      if (entry.status === "verified") {
        expect(entry.evidence?.length, `${entry.id} is verified with no evidence`).toBeGreaterThan(0);
      } else if (entry.status === "partial" || entry.status === "inProgress") {
        expect(entry.closesWith, `${entry.id} is ${entry.status} with no closesWith`).toBeTruthy();
      } else {
        expect(entry.closesWith ?? entry.notes, `${entry.id} names no path forward`).toBeTruthy();
      }
    }
  });

  it("only cites evidence that exists, and only closes with roadmap work that exists", () => {
    for (const entry of capabilityRegistry.entries) {
      for (const item of entry.evidence ?? []) {
        expect(exists(item), `${entry.id} cites a missing file: ${item}`).toBe(true);
      }
      const plan = entry.closesWith;
      if (!plan) continue;
      if (/^\d+\.\d+$/.test(plan)) {
        expect(roadmapItems.has(plan), `${entry.id} closes with unknown item ${plan}`).toBe(true);
      } else {
        expect(
          roadmapPhases.has(plan) || plan in ROADMAP_PHASE_STATUS,
          `${entry.id} closes with unknown phase ${plan}`,
        ).toBe(true);
      }
    }
  });

  it("claims every Phase 9 item and reports its gaps", () => {
    for (const item of [...roadmapItems].filter((entry) => entry.startsWith("9."))) {
      expect(
        capabilityRegistry.entries.some((entry) => entry.phase === item),
        `Phase 9 item ${item} has no capability`,
      ).toBe(true);
    }
    const gaps = capabilityRegistry.gaps();
    expect(gaps.length).toBeGreaterThan(0);
    // A gap with no roadmap item behind it is exactly what 9.6 exists to prevent — except for
    // expressly deferred work (audio, editor, networking), which the roadmap defers on purpose.
    for (const gap of gaps) {
      const entry = capabilityRegistry.get(gap.id)!;
      expect(gap.closesWith ?? (entry.status === "deferred" ? "deferred" : undefined), `${gap.id} has no plan`).toBeTruthy();
    }
  });

  it("mirrors the roadmap's engine-state block and its legend", () => {
    const state = roadmapStateBlock();
    for (const [phase, status] of Object.entries(ROADMAP_PHASE_STATUS)) {
      expect(state.get(phase), `ROADMAP.md state block missing ${phase}`).toBe(capabilityMarker(status));
    }
    expect(state.size).toBe(Object.keys(ROADMAP_PHASE_STATUS).length);
    const legend = new Set(Object.values(ROADMAP_MARKER));
    expect(legend).toEqual(new Set(["[x]", "[!]", "[~]", "[ ]", "[>]"]));
  });

  it("answers queries from the registry, and snapshots as plain JSON", () => {
    expect(capabilityStatus("terrain.lod")).toBe("verified");
    expect(capabilityStatus("rendering.renderGraph")).toBe("verified");
    expect(capabilityStatus("does.notExist")).toBeUndefined();
    expect(capabilityRegistry.get("particles.gpuSimulation")?.closesWith).toBe("12.3");
    expect(capabilityRegistry.list("deferred").map((entry) => entry.id)).toContain("audio.system");
    expect(capabilityMarker("planned")).toBe("[ ]");

    const snapshot = capabilityRegistry.snapshot();
    expect(JSON.parse(JSON.stringify(snapshot))).toEqual(snapshot);
    expect(Object.isFrozen(capabilityRegistry.entries)).toBe(true);
  });
});

describe("Phase 9.6 — known-issue enforcement", () => {
  it("links every known limitation to live work, and never to a finished capability", () => {
    const bullets = knownIssueBullets();
    expect(bullets.length).toBeGreaterThan(20);
    for (const bullet of bullets) {
      const where = `docs/KNOWN-ISSUES.md:${bullet.line}`;
      expect(bullet.refs.length, `${where} has no reference`).toBeGreaterThan(0);
      for (const ref of bullet.refs) {
        if (ref.kind === "capability") {
          const entry = capabilityRegistry.get(ref.value);
          expect(entry, `${where} references unknown capability ${ref.value}`).toBeTruthy();
          expect(entry!.status, `${where} references verified capability ${ref.value} — stale`).not.toBe("verified");
        } else if (/^\d+\.\d+$/.test(ref.value)) {
          expect(roadmapItems.has(ref.value), `${where} references unknown item ${ref.value}`).toBe(true);
          const phase = ref.value.split(".")[0]!;
          expect(
            ROADMAP_PHASE_STATUS[phase] ?? "planned",
            `${where} references item ${ref.value} in a verified phase`,
          ).not.toBe("verified");
        } else {
          expect(
            roadmapPhases.has(ref.value) || ref.value in ROADMAP_PHASE_STATUS,
            `${where} references unknown phase ${ref.value}`,
          ).toBe(true);
        }
      }
    }
  });

  it("has no stale Core entries left over from before Phase 9", () => {
    expect(knownIssues).not.toContain("Worker execution across threads has no test suite");
    expect(knownIssues).not.toContain("Resource cache eviction is untested");
    // The registry's own Core entries are proven by suites, so they cannot be listed as gaps.
    expect(capabilityStatus("workers.roundTrip")).toBe("verified");
    expect(capabilityStatus("resources.eviction")).toBe("verified");
  });

  it("runs the docs:check gate itself clean", () => {
    // `tools/docs-check.mjs` imports the TypeScript capability registry; plain `node` cannot load
    // `.ts` here, so we drive it the same way `npm run docs:check` does (`vite-node`).
    const viteNode = path.join(root, "node_modules", "vite-node", "vite-node.mjs");
    const output = execFileSync(process.execPath, [viteNode, path.join(root, "tools/docs-check.mjs")], {
      cwd: root,
      encoding: "utf-8",
    });
    expect(output).toContain("docs:check OK");
    expect(output).toContain("NOT covered by CI");
  });
});
