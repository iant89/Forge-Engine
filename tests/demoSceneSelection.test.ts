import { describe, expect, it } from "vitest";
import { DEMO_SCENE_NAMES, isDemoSceneName, resolveDemoSceneName } from "../examples/src/sceneSelection.js";

describe("demo scene routing", () => {
  it("lands on the Mars rover showcase when there is no scene query", () => {
    expect(resolveDemoSceneName(null)).toBe("mars-showcase");
  });

  it("supports direct links to every scene", () => {
    for (const scene of DEMO_SCENE_NAMES) expect(resolveDemoSceneName(scene)).toBe(scene);
  });

  it("accepts every canonical scene in the selector switch path", () => {
    for (const scene of DEMO_SCENE_NAMES) expect(isDemoSceneName(scene)).toBe(true);
    expect(isDemoSceneName("not-a-scene")).toBe(false);
  });

  it("preserves the demo's scene aliases", () => {
    expect(resolveDemoSceneName("mars")).toBe("terrain");
    expect(resolveDemoSceneName("realistic-terrain")).toBe("realistic");
    expect(resolveDemoSceneName("mars-port")).toBe("mars-generator");
    expect(resolveDemoSceneName("mars-generator-port")).toBe("mars-generator");
    // `?scene=mars` keeps meaning the hand-written Martian terrain demo, not the port.
    expect(resolveDemoSceneName("mars")).toBe("terrain");
    expect(resolveDemoSceneName("vehicle-playground")).toBe("vehicle");
    expect(resolveDemoSceneName("showcase")).toBe("mars-showcase");
    expect(resolveDemoSceneName("course")).toBe("rover-course");
    expect(resolveDemoSceneName("alpine-rescue")).toBe("alpine-rescue");
  });

  it("falls back to the rover showcase for unknown query values", () => {
    expect(resolveDemoSceneName("not-a-scene")).toBe("mars-showcase");
  });
});
