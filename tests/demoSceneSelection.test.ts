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
      "mars-generator",
      "vehicle",
      "particles",
      "sky",
      "weather",
      "mars-showcase",
      "rover-course",
      "skinning",
    ];
    for (const scene of scenes) expect(resolveDemoSceneName(scene)).toBe(scene);
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
  });

  it("falls back to the rover showcase for unknown query values", () => {
    expect(resolveDemoSceneName("not-a-scene")).toBe("mars-showcase");
  });
});
