/**
 * @suite examples:skyBisect
 * @group unit
 * @covers examples/src/diag/skyBisect.ts
 * @desc Pins the ?diag=1 sky bisect variants: every anchor exists in the shipped sky module, every variant still validates, and a moved anchor reports null instead of measuring the unmodified shader
 */

export const suite = {
  name: "examples:skyBisect",
  group: "unit",
  covers: [
    "examples/src/diag/skyBisect.ts",
  ],
  desc: "Pins the ?diag=1 sky bisect variants: every anchor exists in the shipped sky module, every variant still validates, and a moved anchor reports null instead of measuring the unmodified shader",
};

import assert from "node:assert/strict";
import { finish, group, test } from "selrun";
import { SKY_SHADER, validateWgsl } from "@forge/engine";
import { SKY_BISECT_VARIANTS, SKY_SHADER_LABEL, buildSkyBisectSource } from "../../examples/src/diag/skyBisect.js";

group("diag sky bisect variants", () => {
  test("the label is the one the pipeline factory registers the sky module under", () => {
    assert.equal(SKY_SHADER_LABEL, "sky.wgsl");
  });

  test("ids are unique and every variant cuts the shipped source", () => {
    const ids = SKY_BISECT_VARIANTS.map((v) => v.id);
    assert.equal(new Set(ids).size, ids.length);
    for (const variant of SKY_BISECT_VARIANTS) {
      const source = variant.apply(SKY_SHADER);
      assert.notEqual(source, null, `${variant.id}: anchor missing in the shipped sky module`);
      assert.notEqual(source, SKY_SHADER, `${variant.id}: applied without changing anything`);
    }
  });

  test("every variant is still valid WGSL (a variant that fails to compile measures nothing)", () => {
    for (const variant of SKY_BISECT_VARIANTS) {
      const source = variant.apply(SKY_SHADER);
      assert.notEqual(source, null);
      const issues = validateWgsl(source as string);
      assert.deepEqual(issues, [], `${variant.id}: ${JSON.stringify(issues)}`);
    }
  });

  test("const-bounds removes both per-pixel selects and no-ms removes the storage read", () => {
    const bounds = buildSkyBisectSource(SKY_SHADER, "const-bounds") as string;
    assert.ok(!bounds.includes("select(sky.viewSamples"), "view-sample select survived");
    assert.ok(!bounds.includes("select(sky.lightSamples"), "light-sample select survived");
    assert.ok(bounds.includes("let viewSamples = 16;"));
    assert.ok(bounds.includes("let lightSamples = 8;"));
    const noMs = buildSkyBisectSource(SKY_SHADER, "no-ms") as string;
    assert.ok(!noMs.includes("if (sky.multiScattering != 0) {"));
    // The horizon band still exists for the uniform-bounds variant's sake; only the select goes.
    const uniformBounds = buildSkyBisectSource(SKY_SHADER, "uniform-bounds") as string;
    assert.ok(uniformBounds.includes("let viewSamples = sky.viewSamples;"));
    const noSelect = buildSkyBisectSource(SKY_SHADER, "no-select") as string;
    assert.ok(!noSelect.includes("return select(t, -1.0, t < 0.0);"), "ray-sphere exit select survived");
    assert.ok(!noSelect.includes("return select(t1, -1.0, t1 <= 0.0);"), "ray-sphere entry select survived");
    assert.ok(!noSelect.includes("select(sky.viewSamples"), "view-sample select survived no-select");
  });

  test("const-color returns before the fragment stage computes anything", () => {
    const source = buildSkyBisectSource(SKY_SHADER, "const-color") as string;
    const ret = source.indexOf("return vec4<f32>(0.25, 0.5, 0.9, 1.0);");
    const dir = source.indexOf("let dir = normalize(in.farPoint - in.nearPoint);");
    assert.ok(ret > 0 && dir > ret, "the constant return must precede the atmosphere integral");
  });

  test("unknown ids and moved anchors report null rather than the unmodified shader", () => {
    assert.equal(buildSkyBisectSource(SKY_SHADER, "no-such-variant"), null);
    for (const variant of SKY_BISECT_VARIANTS) {
      assert.equal(variant.apply("// the sky moved on"), null, `${variant.id} cut a source without its anchor`);
    }
  });
});

finish();
