/**
 * @suite terrain:terrainDeformation
 * @group unit
 * @covers engine/src/index.ts
 * @covers engine/src/terrain/deformation.ts
 * @desc Pins terrain deformation behavior and regression guarantees
 */

export const suite = {
  name: "terrain:terrainDeformation",
  group: "unit",
  covers:   [
    "engine/src/index.ts",
    "engine/src/terrain/deformation.ts"
  ],
  desc: "Pins terrain deformation behavior and regression guarantees",
};
import assert from "node:assert/strict";
import { assertCloseTo, finish, group, test } from "selrun";
import { TerrainDeformationField } from "@forge/engine";

group("Phase 15.5 terrain deformation state", () => {
  test("stamps a bounded wheel depression and samples it", () => {
    const field = new TerrainDeformationField({ resolution: 9, maxChunks: 2 });
    assert.equal(field.stamp("0:0", { x: 4, z: 4, radius: 1, depth: 0.02 }, 8), true);
    assertCloseTo(field.sample("0:0", 4, 4, 8), -0.02, 6);
    assert.ok(field.sampleCount > 0);
    assert.equal(field.revision, 1);
    assert.equal(field.stamp("0:0", { x: 4, z: 4, radius: 1, depth: 0 }, 8), false);
  });

  test("round-trips deformation and enforces the chunk budget", () => {
    const field = new TerrainDeformationField({ resolution: 5, maxChunks: 1 });
    field.stamp("a", { x: 2, z: 2, radius: 1, depth: 0.1 }, 4);
    assert.equal(field.stamp("b", { x: 2, z: 2, radius: 1, depth: 0.1 }, 4), false);
    const saved = field.serialize();
    const restored = new TerrainDeformationField({ resolution: 5, maxChunks: 1 });
    restored.restore(saved);
    assertCloseTo(restored.sample("a", 2, 2, 4), -0.1, 6);
    assert.equal(restored.sample("missing", 2, 2, 4), 0);
  });
});

await finish();
