/**
 * @suite docs:capabilities
 * @group unit
 * @covers .github/workflows/ci.yml
 * @covers ROADMAP.md
 * @covers benchmarks/src/lights.bench.ts
 * @covers docs/KNOWN-ISSUES.md
 * @covers docs/VERIFICATION.md
 * @covers engine/src/core/capabilities.ts
 * @covers engine/src/math/bvh.ts
 * @covers engine/src/physics/backend.ts
 * @covers engine/src/physics/system.ts
 * @covers examples/src/diag/terrainLayerCheck.ts
 * @covers package.json
 * @covers scripts/setup-deps.sh
 * @covers tests/animation/animation.test.ts
 * @covers tests/animation/animationSkinning.test.ts
 * @covers tests/animation/mechanicalAnimation.test.ts
 * @covers tests/core/tasks.test.ts
 * @covers tests/docs/capabilities.test.ts
 * @covers tests/environment/environment.test.ts
 * @covers tests/environment/environment8b.test.ts
 * @covers tests/examples/marsGeneratorScene.test.ts
 * @covers tests/examples/marsShowcase.test.ts
 * @covers tests/examples/mechanicalScene.test.ts
 * @covers tests/examples/skinningScene.test.ts
 * @covers tests/gpu/gpuMemory.test.ts
 * @covers tests/math/bvh.test.ts
 * @covers tests/math/math.test.ts
 * @covers tests/particles/particles.test.ts
 * @covers tests/physics/physics.test.ts
 * @covers tests/population/population.test.ts
 * @covers tests/rendering/clusters.test.ts
 * @covers tests/rendering/frame.test.ts
 * @covers tests/rendering/lightCulling.test.ts
 * @covers tests/rendering/objectCulling.test.ts
 * @covers tests/rendering/pipeline.test.ts
 * @covers tests/rendering/primitives.test.ts
 * @covers tests/rendering/renderGraph.test.ts
 * @covers tests/rendering/rendering.test.ts
 * @covers tests/rendering/renderingSkinning.test.ts
 * @covers tests/rendering/shaderHotReload.test.ts
 * @covers tests/rendering/shadows.test.ts
 * @covers tests/rendering/wgsl.test.ts
 * @covers tests/resources/assetPipeline.test.ts
 * @covers tests/resources/gltf.test.ts
 * @covers tests/resources/phase15.test.ts
 * @covers tests/resources/resources.test.ts
 * @covers tests/resources/streaming.test.ts
 * @covers tests/scene/coordinateSpaces.test.ts
 * @covers tests/scene/ecs.test.ts
 * @covers tests/support/workerThreads.ts
 * @covers tests/terrain/marsTerrain.test.ts
 * @covers tests/terrain/realisticTerrain.test.ts
 * @covers tests/terrain/terrain.test.ts
 * @covers tests/terrain/terrainMaterials.test.ts
 * @covers tests/tools/gpuEnv.test.ts
 * @covers tests/tools/marsTerrainPlan.test.ts
 * @covers tests/tsconfig.json
 * @covers tests/vehicles/vehiclePhysics.test.ts
 * @covers tests/vehicles/vehicles.test.ts
 * @covers tools/browser-check.mjs
 * @covers tools/browser-mars-workers.mjs
 * @covers tools/docs-check.mjs
 * @covers tools/gpu-env.mjs
 * @covers tools/wgsl-check.mjs
 * @desc Pins capabilities behavior and regression guarantees
 */

export const suite = {
  name: "docs:capabilities",
  group: "unit",
  covers: [
    ".github/workflows/ci.yml",
    "ROADMAP.md",
    "benchmarks/src/lights.bench.ts",
    "docs/KNOWN-ISSUES.md",
    "docs/VERIFICATION.md",
    "engine/src/core/capabilities.ts",
    "engine/src/math/bvh.ts",
    "engine/src/physics/backend.ts",
    "engine/src/physics/system.ts",
    "examples/src/diag/terrainLayerCheck.ts",
    "package.json",
    "scripts/setup-deps.sh",
    "tests/animation/animation.test.ts",
    "tests/animation/animationSkinning.test.ts",
    "tests/animation/mechanicalAnimation.test.ts",
    "tests/core/tasks.test.ts",
    "tests/docs/capabilities.test.ts",
    "tests/environment/environment.test.ts",
    "tests/environment/environment8b.test.ts",
    "tests/examples/marsGeneratorScene.test.ts",
    "tests/examples/marsShowcase.test.ts",
    "tests/examples/mechanicalScene.test.ts",
    "tests/examples/skinningScene.test.ts",
    "tests/gpu/gpuMemory.test.ts",
    "tests/math/bvh.test.ts",
    "tests/math/math.test.ts",
    "tests/particles/particles.test.ts",
    "tests/physics/physics.test.ts",
    "tests/population/population.test.ts",
    "tests/rendering/clusters.test.ts",
    "tests/rendering/frame.test.ts",
    "tests/rendering/lightCulling.test.ts",
    "tests/rendering/objectCulling.test.ts",
    "tests/rendering/pipeline.test.ts",
    "tests/rendering/primitives.test.ts",
    "tests/rendering/renderGraph.test.ts",
    "tests/rendering/rendering.test.ts",
    "tests/rendering/renderingSkinning.test.ts",
    "tests/rendering/shaderHotReload.test.ts",
    "tests/rendering/shadows.test.ts",
    "tests/rendering/wgsl.test.ts",
    "tests/resources/assetPipeline.test.ts",
    "tests/resources/gltf.test.ts",
    "tests/resources/phase15.test.ts",
    "tests/resources/resources.test.ts",
    "tests/resources/streaming.test.ts",
    "tests/scene/coordinateSpaces.test.ts",
    "tests/scene/ecs.test.ts",
    "tests/support/workerThreads.ts",
    "tests/terrain/marsTerrain.test.ts",
    "tests/terrain/realisticTerrain.test.ts",
    "tests/terrain/terrain.test.ts",
    "tests/terrain/terrainMaterials.test.ts",
    "tests/tools/gpuEnv.test.ts",
    "tests/tools/marsTerrainPlan.test.ts",
    "tests/tsconfig.json",
    "tests/vehicles/vehiclePhysics.test.ts",
    "tests/vehicles/vehicles.test.ts",
    "tools/browser-check.mjs",
    "tools/browser-mars-workers.mjs",
    "tools/docs-check.mjs",
    "tools/gpu-env.mjs",
    "tools/wgsl-check.mjs",
  ],
  desc: "Pins capabilities behavior and regression guarantees",
};
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import assert from "node:assert/strict";
import { assertContains, assertNotContains, finish, group, test } from "selrun";
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

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
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
    .map((line) => line.match(/^\s*PHASE\s+([0-9]+(?:\.[0-9]+)?[A-Za-z+]*)/)?.[1]?.toLowerCase())
    .filter((phase): phase is string => Boolean(phase)),
);

/** Roadmap engine-state block: `PHASE 8B` followed by a `[x]`-style marker line. */
function roadmapStateBlock(): Map<string, string> {
  const state = new Map<string, string>();
  const lines = roadmap.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const heading = lines[i]?.match(/^PHASE\s+([0-9]+(?:\.[0-9]+)?[A-Za-z+]*)/);
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

group("Phase 9.5 — capability registry", () => {
  test("declares every capability once, with an area.feature id and a usable summary", () => {
    const ids = capabilityRegistry.entries.map((entry) => entry.id);
    assert.equal(new Set(ids).size, ids.length);
    assert.ok(ids.length > 40);
    for (const entry of capabilityRegistry.entries) {
      assert.match(entry.id, /^[a-z][a-zA-Z0-9]*(\.[a-zA-Z0-9]+)+$/, `${README_ANCHOR}: bad id`);
      assert.ok(entry.summary.length > 10, `${entry.id} summary`);
      assertContains(["verified", "partial", "inProgress", "planned", "deferred"], entry.status);
    }
  });

  test("keeps every status honest: verified cites evidence, unfinished work names the closer", () => {
    for (const entry of capabilityRegistry.entries) {
      if (entry.status === "verified") {
        assert.ok((entry.evidence?.length ?? 0) > 0, `${entry.id} is verified with no evidence`);
      } else if (entry.status === "partial" || entry.status === "inProgress") {
        assert.ok(entry.closesWith, `${entry.id} is ${entry.status} with no closesWith`);
      } else {
        assert.ok(entry.closesWith ?? entry.notes, `${entry.id} names no path forward`);
      }
    }
  });

  test("only cites evidence that exists, and only closes with roadmap work that exists", () => {
    for (const entry of capabilityRegistry.entries) {
      for (const item of entry.evidence ?? []) {
        assert.equal(exists(item), true, `${entry.id} cites a missing file: ${item}`);
      }
      const plan = entry.closesWith;
      if (!plan) continue;
      if (/^\d+\.\d+$/.test(plan)) {
        assert.equal(roadmapItems.has(plan), true, `${entry.id} closes with unknown item ${plan}`);
      } else {
        assert.equal(roadmapPhases.has(plan) || plan in ROADMAP_PHASE_STATUS, true, `${entry.id} closes with unknown phase ${plan}`);
      }
    }
  });

  test("claims every Phase 9 item and reports its gaps", () => {
    for (const item of [...roadmapItems].filter((entry) => entry.startsWith("9."))) {
      assert.equal(capabilityRegistry.entries.some((entry) => entry.phase === item), true, `Phase 9 item ${item} has no capability`);
    }
    const gaps = capabilityRegistry.gaps();
    assert.ok(gaps.length > 0);
    // A gap with no roadmap item behind it is exactly what 9.6 exists to prevent — except for
    // expressly deferred work (audio, editor, networking), which the roadmap defers on purpose.
    for (const gap of gaps) {
      const entry = capabilityRegistry.get(gap.id)!;
      assert.ok(gap.closesWith ?? (entry.status === "deferred" ? "deferred" : undefined), `${gap.id} has no plan`);
    }
  });

  test("mirrors the roadmap's engine-state block and its legend", () => {
    const state = roadmapStateBlock();
    for (const [phase, status] of Object.entries(ROADMAP_PHASE_STATUS)) {
      assert.equal(state.get(phase), capabilityMarker(status), `ROADMAP.md state block missing ${phase}`);
    }
    assert.equal(state.size, Object.keys(ROADMAP_PHASE_STATUS).length);
    const legend = new Set(Object.values(ROADMAP_MARKER));
    assert.deepEqual(legend, new Set(["[x]", "[!]", "[~]", "[ ]", "[>]"]));
  });

  test("answers queries from the registry, and snapshots as plain JSON", () => {
    assert.equal(capabilityStatus("terrain.lod"), "verified");
    assert.equal(capabilityStatus("rendering.renderGraph"), "verified");
    assert.equal(capabilityStatus("does.notExist"), undefined);
    assert.equal(capabilityRegistry.get("particles.gpuSimulation")?.status, "verified");
    assert.equal(capabilityRegistry.get("particles.gpuRendering")?.closesWith, "12.7");
    assertContains(capabilityRegistry.list("deferred").map((entry) => entry.id), "audio.system");
    assert.equal(capabilityMarker("planned"), "[ ]");

    const snapshot = capabilityRegistry.snapshot();
    assert.deepEqual(JSON.parse(JSON.stringify(snapshot)), snapshot);
    assert.equal(Object.isFrozen(capabilityRegistry.entries), true);
  });
});

group("Phase 9.6 — known-issue enforcement", () => {
  test("links every known limitation to live work, and never to a finished capability", () => {
    const bullets = knownIssueBullets();
    assert.ok(bullets.length > 20);
    for (const bullet of bullets) {
      const where = `docs/KNOWN-ISSUES.md:${bullet.line}`;
      assert.ok(bullet.refs.length > 0, `${where} has no reference`);
      for (const ref of bullet.refs) {
        if (ref.kind === "capability") {
          const entry = capabilityRegistry.get(ref.value);
          assert.ok(entry, `${where} references unknown capability ${ref.value}`);
          assert.notEqual(entry!.status, "verified", `${where} references verified capability ${ref.value} — stale`);
        } else if (/^\d+\.\d+$/.test(ref.value)) {
          assert.equal(roadmapItems.has(ref.value), true, `${where} references unknown item ${ref.value}`);
          const phase = ref.value.split(".")[0]!;
          assert.notEqual(ROADMAP_PHASE_STATUS[phase] ?? "planned", "verified", `${where} references item ${ref.value} in a verified phase`);
        } else {
          assert.equal(roadmapPhases.has(ref.value) || ref.value in ROADMAP_PHASE_STATUS, true, `${where} references unknown phase ${ref.value}`);
        }
      }
    }
  });

  test("has no stale Core entries left over from before Phase 9", () => {
    assertNotContains(knownIssues, "Worker execution across threads has no test suite");
    assertNotContains(knownIssues, "Resource cache eviction is untested");
    // The registry's own Core entries are proven by suites, so they cannot be listed as gaps.
    assert.equal(capabilityStatus("workers.roundTrip"), "verified");
    assert.equal(capabilityStatus("resources.eviction"), "verified");
  });

  test("runs the docs:check gate itself clean", () => {
    // `tools/docs-check.mjs` imports the TypeScript capability registry; plain `node` cannot load
    // `.ts` here, so we drive it with the same TSX loader configured by `npm run docs:check`.
    const output = execFileSync(process.execPath, ["--import", "tsx", path.join(root, "tools/docs-check.mjs")], {
      cwd: root,
      encoding: "utf-8",
      env: { ...process.env, TSX_TSCONFIG_PATH: path.join(root, "tests/tsconfig.json") },
    });
    assertContains(output, "docs:check OK");
    assertContains(output, "NOT covered by CI");
  });
});

await finish();
