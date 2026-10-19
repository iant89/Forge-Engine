/**
 * @suite core:developerConsole
 * @group unit
 * @covers engine/src/debug/console.ts
 * @covers engine/src/debug/ecsInspector.ts
 * @covers engine/src/debug/environmentDebugger.ts
 * @covers engine/src/debug/particleDebugger.ts
 * @covers engine/src/debug/profiler.ts
 * @covers engine/src/debug/terrainDebugger.ts
 * @covers engine/src/index.ts
 * @covers engine/src/scene/scene.ts
 * @covers engine/src/terrain/world.ts
 * @desc Phase 21.10 — safe command dispatch, bounded transcript, and debugger command integration
 */

export const suite = {
  name: "core:developerConsole",
  group: "unit",
  covers: [
    "engine/src/debug/console.ts",
    "engine/src/debug/ecsInspector.ts",
    "engine/src/debug/environmentDebugger.ts",
    "engine/src/debug/particleDebugger.ts",
    "engine/src/debug/profiler.ts",
    "engine/src/debug/terrainDebugger.ts",
    "engine/src/index.ts",
    "engine/src/scene/scene.ts",
    "engine/src/terrain/world.ts",
  ],
  desc: "Phase 21.10 — safe command dispatch, bounded transcript, and debugger command integration",
};

import assert from "node:assert/strict";
import { finish, group, test } from "selrun";
import { createDeveloperConsole, DeveloperConsole, Profiler, Scene, TerrainWorld } from "@forge/engine";

group("developer console", () => {
  test("tokenizes quoted arguments, dispatches registered commands, and completes command names", () => {
    const console = new DeveloperConsole();
    console.register({
      name: "echo",
      description: "Return the provided tokens",
      handler: (args) => args,
    });

    const result = console.execute('echo "hello world" \'two words\' ""');
    assert.equal(result.ok, true);
    assert.deepEqual(result.args, ["hello world", "two words", ""]);
    assert.deepEqual(JSON.parse(result.output.join("\n")), ["hello world", "two words", ""]);
    assert.deepEqual(console.complete("ec"), ["echo", "ecs"]);
    assert.deepEqual(console.complete("echo "), []);
    assert.throws(() => console.register({ name: "echo", description: "duplicate", handler: () => null }), /already registered/);
  });

  test("uses an explicit command registry, reports syntax/errors, and bounds history and output", () => {
    const console = createDeveloperConsole({ stats: () => ({ frame: 42, fps: 59.8 }) }, { maxHistory: 3, maxOutputChars: 256 });
    assert.equal(console.execute("stats").ok, true);
    assert.equal(console.execute("Math.max 1 2").ok, false, "console input is not evaluated as code");
    assert.match(console.execute('help "unclosed').output.join("\n"), /unclosed quoted argument/);
    assert.equal(console.execute("unknown").ok, false);
    assert.equal(console.history.length, 3);
    assert.equal(console.history[0]!.command, "math.max");
    assert.match(console.execute("help stats").output.join("\n"), /stats/);
    assert.equal(console.history.length, 3);

    const large = createDeveloperConsole({}, { maxOutputChars: 256 });
    large.register({ name: "large", description: "Produce a large output", handler: () => "x".repeat(400) });
    const output = large.execute("large").output.join("\n");
    assert.ok(output.length < 300);
    assert.match(output, /output truncated/);

    const inputBounded = createDeveloperConsole({}, { maxInputChars: 256 });
    const rejected = inputBounded.execute(`help ${"x".repeat(300)}`);
    assert.equal(rejected.ok, false);
    assert.equal(rejected.input.length, 256);
    assert.match(rejected.output.join("\n"), /input limit/);
  });

  test("provides help, engine statistics, and bounded read-only scene diagnostics", () => {
    const scene = new Scene({ name: "console-test" });
    scene.createEntity("console-target");
    scene.addObject(new TerrainWorld({ syncGeneration: true, maxLOD: 0 }));
    let time = 0;
    const profiler = new Profiler({ now: () => time });
    profiler.beginFrame(1);
    profiler.begin("Update");
    time += 0.002;
    profiler.end("Update");
    time += 0.001;
    profiler.endFrame({ drawCalls: 3 });
    const console = createDeveloperConsole({
      stats: () => ({ frame: 7, fps: 60 }),
      currentScene: scene,
      profiler,
    });

    assert.match(console.execute("help").output.join("\n"), /rendergraph/);
    assert.deepEqual(JSON.parse(console.execute("stats").output.join("\n")), { frame: 7, fps: 60 });
    const profile = JSON.parse(console.execute("profiler 5").output.join("\n"));
    assert.match(profile.report, /Update/);
    assert.equal(profile.frameHistory[0].drawCalls, 3);
    assert.equal(profile.frameHistory[0].slices[0].name, "Update");
    const ecs = console.execute("ecs console-target 4");
    assert.equal(ecs.ok, true);
    assert.equal(JSON.parse(ecs.output.join("\n")).list.length, 1);

    const terrain = console.execute("terrain \"\" 0");
    assert.equal(terrain.ok, true);
    assert.equal(JSON.parse(terrain.output.join("\n")).list.length, 0);
    assert.equal(console.execute("environment 1 2 3").ok, true);
    assert.equal(console.execute("particles").ok, true);
    assert.equal(console.execute("physics").ok, false, "missing systems produce an actionable diagnostic");
    assert.equal(console.execute("rendergraph").ok, false, "missing renderer context produces an actionable diagnostic");

    const priorHistory = console.history.length;
    const cleared = console.execute("clear");
    assert.equal(cleared.ok, true);
    assert.equal(cleared.output[0], "Console history cleared.");
    assert.equal(console.history.length, 1, "the clear command itself remains in the transcript");
    assert.ok(priorHistory > 1);
  });
});

finish();
