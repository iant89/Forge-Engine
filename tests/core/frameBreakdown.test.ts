/**
 * @suite core:frameBreakdown
 * @group unit
 * @covers engine/src/debug/frameBreakdown.ts
 * @covers engine/src/scene/world.ts
 * @covers engine/src/scene/scene.ts
 * @desc Phase 21.1 frame profiler: category labels, system scopes, breakdown folding and formatting
 */

export const suite = {
  name: "core:frameBreakdown",
  group: "unit",
  covers:   [
    "engine/src/debug/frameBreakdown.ts",
    "engine/src/scene/world.ts",
    "engine/src/scene/scene.ts"
  ],
  desc: "Phase 21.1 frame profiler: category labels, system scopes, breakdown folding and formatting",
};
import assert from "node:assert/strict";
import { finish, group, test } from "selrun";
import { EntityWorld, Profiler, type ISystem, type ScopeStats, type SystemContext } from "@forge/engine";
import { PROFILE_CATEGORIES, classifyProfileName, formatFrameBreakdown, frameBreakdown, profileLabel } from "@forge/engine";

const stat = (name: string, ewmaMs: number): ScopeStats => ({ name, count: 1, totalMs: ewmaMs, meanMs: ewmaMs, minMs: ewmaMs, maxMs: ewmaMs, ewmaMs, gpuMs: 0 });

group("labels", () => {
  test("classifies the engine's system and object names into the roadmap categories", () => {
    assert.equal(classifyProfileName("physics"), "physics");
    assert.equal(classifyProfileName("particles"), "particles");
    assert.equal(classifyProfileName("snowfall"), "particles");
    assert.equal(classifyProfileName("TerrainWorld"), "terrain");
    assert.equal(classifyProfileName("population"), "terrain");
    assert.equal(classifyProfileName("tireTracks"), "terrain");
    assert.equal(classifyProfileName("scripts.fixed"), "scripting");
    assert.equal(classifyProfileName("audio"), "audio");
    assert.equal(classifyProfileName("vehicles"), "simulation");
    assert.equal(classifyProfileName("weather"), "simulation");
  });
  test("a declared profileCategory getter wins and adds no own state", () => {
    class Custom { readonly name = "thing"; get profileCategory() { return "rendering" as const; } }
    const c = new Custom();
    assert.equal(profileLabel(c), "rendering:thing");
    assert.deepEqual(Object.keys(c), ["name"]);
    assert.equal(profileLabel({ name: "x", profileCategory: "bogus" } as { name: string }), "simulation:x");
  });
});

group("scopes", () => {
  test("runSystems times each enabled system under its category label", () => {
    const world = new EntityWorld();
    const profiler = new Profiler();
    const mk = (name: string, enabled = true): ISystem => ({ name, order: 0, enabled, update() {} });
    world.registerSystem(mk("physics"));
    world.registerSystem(mk("audio"));
    world.registerSystem(mk("off", false));
    world.registerSystem({ ...mk("boom"), update() { throw new Error("boom"); } });
    const errors = console.error;
    console.error = () => {};
    try {
      world.runSystems({ profiler } as unknown as SystemContext);
    } finally {
      console.error = errors;
    }
    const names = profiler.snapshot().map((s) => s.name);
    for (const n of ["physics:physics", "audio:audio", "simulation:boom"]) assert.ok(names.includes(n), n);
    assert.ok(!names.includes("simulation:off"));
  });
});

group("breakdown", () => {
  test("folds categorised scopes, adds render submission, reports the remainder", () => {
    const b = frameBreakdown([stat("Frame", 10), stat("Render", 3), stat("physics:physics", 4), stat("physics:vehicles2", 1), stat("audio:audio", 0.5), stat("streaming:assets", 0.25), stat("other", 99)], 6, 1);
    assert.equal(b.cpuFrameMs, 13);
    assert.equal(b.gpuFrameMs, 6);
    assert.equal(b.categories.physics, 5);
    assert.equal(b.categories.rendering, 3);
    assert.equal(b.categories.streaming, 0.25);
    assert.deepEqual(b.top.physics, [{ name: "physics", ms: 4 }]);
    assert.equal(b.unattributedMs, 4.5);
    assert.deepEqual(Object.keys(b.categories), [...PROFILE_CATEGORIES]);
    const text = formatFrameBreakdown(b);
    assert.match(text, /frame cpu 13\.00 ms {2}gpu 6\.00 ms/);
    assert.match(text.split("\n")[1]!, /physics/);
    assert.match(formatFrameBreakdown(frameBreakdown([])), /gpu n\/a/);
  });
});

finish();
