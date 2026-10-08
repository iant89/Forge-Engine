/**
 * @suite controls:demoSceneSelection
 * @group unit
 * @covers examples/src/sceneSelection.ts
 * @desc Pins demo scene selection behavior and regression guarantees
 */

export const suite = {
  name: "controls:demoSceneSelection",
  group: "unit",
  covers:   [
    "examples/src/sceneSelection.ts"
  ],
  desc: "Pins demo scene selection behavior and regression guarantees",
};
import assert from "node:assert/strict";
import { finish, group, test } from "selrun";
import { DEMO_SCENE_NAMES, isDemoSceneName, resolveDemoSceneName } from "../../examples/src/sceneSelection.js";

group("demo scene routing", () => {
  test("lands on the Mars rover showcase when there is no scene query", () => {
    assert.equal(resolveDemoSceneName(null), "mars-showcase");
  });

  test("supports direct links to every scene", () => {
    for (const scene of DEMO_SCENE_NAMES) assert.equal(resolveDemoSceneName(scene), scene);
  });

  test("accepts every canonical scene in the selector switch path", () => {
    for (const scene of DEMO_SCENE_NAMES) assert.equal(isDemoSceneName(scene), true);
    assert.equal(isDemoSceneName("not-a-scene"), false);
  });

  test("preserves the demo's scene aliases", () => {
    assert.equal(resolveDemoSceneName("mars"), "terrain");
    assert.equal(resolveDemoSceneName("realistic-terrain"), "realistic");
    assert.equal(resolveDemoSceneName("mars-port"), "mars-generator");
    assert.equal(resolveDemoSceneName("mars-generator-port"), "mars-generator");
    // `?scene=mars` keeps meaning the hand-written Martian terrain demo, not the port.
    assert.equal(resolveDemoSceneName("mars"), "terrain");
    assert.equal(resolveDemoSceneName("vehicle-playground"), "vehicle");
    assert.equal(resolveDemoSceneName("showcase"), "mars-showcase");
    assert.equal(resolveDemoSceneName("course"), "rover-course");
    assert.equal(resolveDemoSceneName("alpine-rescue"), "alpine-rescue");
  });

  test("falls back to the rover showcase for unknown query values", () => {
    assert.equal(resolveDemoSceneName("not-a-scene"), "mars-showcase");
  });
});

await finish();
