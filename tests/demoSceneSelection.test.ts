import { describe, expect, it } from "vitest";
import { resolveDemoSceneName, type DemoSceneName } from "../examples/src/sceneSelection.js";

describe("demo scene URL routing", () => {
  it("lands on the Mars rover showcase when there is no scene query", () => {
    expect(resolveDemoSceneName(null)).toBe("mars-showcase");
  });

  it("supports direct links to every scene", () => {
    const scenes: DemoSceneName[] = [
      "pbr",
      "cubes",
      "terrain",
      "realistic",
      "vehicle",
      "particles",
      "sky",
      "weather",
      "mars-showcase",
    ];
    for (const scene of scenes) expect(resolveDemoSceneName(scene)).toBe(scene);
  });

  it("preserves the demo's scene aliases", () => {
    expect(resolveDemoSceneName("mars")).toBe("terrain");
    expect(resolveDemoSceneName("realistic-terrain")).toBe("realistic");
    expect(resolveDemoSceneName("vehicle-playground")).toBe("vehicle");
    expect(resolveDemoSceneName("showcase")).toBe("mars-showcase");
  });

  it("falls back to the rover showcase for unknown query values", () => {
    expect(resolveDemoSceneName("not-a-scene")).toBe("mars-showcase");
  });
});
