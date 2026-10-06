import { describe, expect, it } from "vitest";
import { TerrainDeformationField } from "@forge/engine";

describe("Phase 15.5 terrain deformation state", () => {
  it("stamps a bounded wheel depression and samples it", () => {
    const field = new TerrainDeformationField({ resolution: 9, maxChunks: 2 });
    expect(field.stamp("0:0", { x: 4, z: 4, radius: 1, depth: 0.02 }, 8)).toBe(true);
    expect(field.sample("0:0", 4, 4, 8)).toBeCloseTo(-0.02, 6);
    expect(field.sampleCount).toBeGreaterThan(0);
    expect(field.revision).toBe(1);
    expect(field.stamp("0:0", { x: 4, z: 4, radius: 1, depth: 0 }, 8)).toBe(false);
  });

  it("round-trips deformation and enforces the chunk budget", () => {
    const field = new TerrainDeformationField({ resolution: 5, maxChunks: 1 });
    field.stamp("a", { x: 2, z: 2, radius: 1, depth: 0.1 }, 4);
    expect(field.stamp("b", { x: 2, z: 2, radius: 1, depth: 0.1 }, 4)).toBe(false);
    const saved = field.serialize();
    const restored = new TerrainDeformationField({ resolution: 5, maxChunks: 1 });
    restored.restore(saved);
    expect(restored.sample("a", 2, 2, 4)).toBeCloseTo(-0.1, 6);
    expect(restored.sample("missing", 2, 2, 4)).toBe(0);
  });
});
