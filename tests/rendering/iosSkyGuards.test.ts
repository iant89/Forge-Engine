/**
 * @suite rendering:iosSkyGuards
 * @group unit
 * @covers engine/src/rendering/skyMultiScattering.ts
 * @covers engine/src/rendering/shaders/multiScattering.ts
 * @covers engine/src/rendering/shaders/sky.ts
 * @covers engine/src/rendering/shaders/post.ts
 * @covers examples/src/diag/skyBisect.ts
 * @covers engine/src/particles/shader.ts
 * @covers engine/src/particles/gpuSystem.ts
 * @desc fe-17: iOS Safari black sky — fast-math-proof non-finite guards on the sky/LUT/post path, no depthReadOnly reliance
 */

export const suite = {
  name: "rendering:iosSkyGuards",
  group: "unit",
  covers: [
    "engine/src/rendering/skyMultiScattering.ts",
    "engine/src/rendering/shaders/multiScattering.ts",
    "engine/src/rendering/shaders/sky.ts",
    "engine/src/rendering/shaders/post.ts",
    "examples/src/diag/skyBisect.ts",
    "engine/src/particles/shader.ts",
    "engine/src/particles/gpuSystem.ts",
  ],
  desc: "fe-17: iOS Safari black sky — fast-math-proof non-finite guards on the sky/LUT/post path, no depthReadOnly reliance",
};

/**
 * Device evidence (iOS 18.7 / Safari 26.6.2, two ?diag=1 runs): the shipped sky module draws black
 * on the HDR path while byte-edited variants of it (and in run 1 only the no-ms one) draw, with zero
 * GPU errors; a `depthReadOnly` attachment is not loaded. A source-sensitive, error-free black is the
 * signature of a non-finite value under WebKit's fast-math Metal compile. These tests pin the
 * defences: every sky term, LUT texel and HDR post read is gated by an exponent-bit finiteness test
 * (immune to fast math folding x != x), and no render pass relies on the read-only depth load.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { assertContains, finish, group, test } from "selrun";
import { MULTI_SCATTERING_SHADER, POST_SHADER, PARTICLE_RENDER_SHADER, PARTICLE_RIBBON_SHADER, SKY_SHADER } from "@forge/engine";
import { SKY_BISECT_VARIANTS, buildSkyBisectSource } from "../../examples/src/diag/skyBisect.ts";

group("fe-17 non-finite guards (fast-math-proof)", () => {
  test("the LUT reader sanitizes every texel and the result with an exponent-bit test", () => {
    assertContains(SKY_SHADER, "fn msFinite(x: f32) -> bool");
    assertContains(SKY_SHADER, "bitcast<u32>(x) & 0x7f800000u");
    assertContains(SKY_SHADER, "msSanitize(textureLoad(multiScatteringLut, vec2<i32>(y0, row0), 0).rgb)");
    assertContains(SKY_SHADER, "return msSanitize(mix(mix(a, b, wy), mix(c, d, wy), wx));");
  });

  test("the compute pass never stores a non-finite texel", () => {
    assertContains(MULTI_SCATTERING_SHADER, "vec4<f32>(msSanitize(source), safeRho)");
  });

  test("the sky hands the HDR target only finite, bounded, non-negative radiance", () => {
    const guard = SKY_SHADER.indexOf("radiance = select(vec3<f32>(0.0), clamp(radiance, vec3<f32>(0.0), vec3<f32>(SKY_RADIANCE_MAX)), radianceOk);");
    const hdrReturn = SKY_SHADER.indexOf("if ((perFrame.flags & 2u) != 0u) {\n    return vec4<f32>(radiance, 1.0);");
    assert.ok(guard > 0 && hdrReturn > guard, "guard precedes the HDR return");
    assertContains(SKY_SHADER, "const SKY_RADIANCE_MAX: f32 = 60000.0;");
  });

  test("every accumulated sky term is gated on finiteness", () => {
    assertContains(SKY_SHADER, "fn skyFinite3(v: vec3<f32>) -> vec3<f32>");
    for (const term of ["sumR += skyFinite3(", "sumM += skyFinite3(", "msSum += skyFinite3(", "radiance = skyFinite3(sky.sunIntensity", "radiance = mix(radiance, skyFinite3(deck.rgb), deckA);"]) {
      assertContains(SKY_SHADER, term);
    }
    // fragmentMain only: the cloud deck's own accumulation is gated once, at its mix.
    const main = SKY_SHADER.slice(SKY_SHADER.indexOf("fn fragmentMain("));
    const unguarded = main.split("\n").filter((l) => /radiance \+= /.test(l) && !l.includes("skyFinite3("));
    assert.deepEqual(unguarded, []);
  });

  test("the ?diag=1 bisect keeps its anchors and has a same-semantics recompile control", () => {
    assert.equal(SKY_BISECT_VARIANTS[0]!.id, "recompile");
    for (const v of SKY_BISECT_VARIANTS) assert.notEqual(buildSkyBisectSource(SKY_SHADER, v.id), null, v.id);
    const control = buildSkyBisectSource(SKY_SHADER, "recompile")!;
    assert.ok(control.startsWith(SKY_SHADER) && control !== SKY_SHADER);
  });

  test("bloom and tonemap read a non-finite HDR texel as zero", () => {
    assertContains(POST_SHADER, "fn postFinite(x: f32) -> bool");
    assertContains(POST_SHADER, "postFinite(c.x) && postFinite(c.y) && postFinite(c.z)");
  });
});

group("fe-17 no reliance on depthReadOnly's implicit load", () => {
  const src = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");

  test("GPU particles depth-test in the fragment stage and attach no depth", () => {
    const sys = src("engine/src/particles/gpuSystem.ts");
    assert.ok(!/depthReadOnly:\s*true/.test(sys), "particle.render must not attach depth read-only");
    assert.ok(!/depthCompare:\s*"less-equal"/.test(sys), "particle pipelines carry no depthStencil");
    for (const s of [PARTICLE_RENDER_SHADER, PARTICLE_RIBBON_SHADER]) {
      assert.match(s, /if \((particleZ|ribbonZ) > sceneDepth\) \{\s*discard;/);
    }
  });

  test("no engine render pass sets depthReadOnly: true", () => {
    for (const p of ["engine/src/rendering/renderer.ts", "engine/src/particles/gpuSystem.ts"]) {
      assert.ok(!/depthReadOnly:\s*true/.test(src(p)), p);
    }
  });

});

finish();
