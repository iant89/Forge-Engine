/**
 * @suite rendering:wgsl
 * @group unit
 * @covers engine/src/gpu/layout.ts
 * @covers engine/src/gpu/shaderCache.ts
 * @covers engine/src/index.ts
 * @covers engine/src/particles/shader.ts
 * @covers engine/src/rendering/clusters.ts
 * @covers engine/src/rendering/shaders/post.ts
 * @covers engine/src/rendering/shaders/sky.ts
 * @covers engine/src/rendering/shaders/ssao.ts
 * @covers engine/src/rendering/shaders/standard.ts
 * @covers engine/src/rendering/shaders/terrain.ts
 * @covers engine/src/rendering/shaders/water.ts
 * @covers engine/src/rendering/uniforms.ts
 * @desc WGSL layout rules that differ between browsers
 */

export const suite = {
  name: "rendering:wgsl",
  group: "unit",
  covers:   [
    "engine/src/gpu/layout.ts",
    "engine/src/gpu/shaderCache.ts",
    "engine/src/index.ts",
    "engine/src/particles/shader.ts",
    "engine/src/rendering/clusters.ts",
    "engine/src/rendering/shaders/post.ts",
    "engine/src/rendering/shaders/sky.ts",
    "engine/src/rendering/shaders/ssao.ts",
    "engine/src/rendering/shaders/standard.ts",
    "engine/src/rendering/shaders/terrain.ts",
    "engine/src/rendering/shaders/water.ts",
    "engine/src/rendering/uniforms.ts"
  ],
  desc: "WGSL layout rules that differ between browsers",
};
/**
 * WGSL layout rules that differ between browsers.
 *
 * Chromium's WGSL compiler accepts uniform structs with a relaxed layout (arrays with a stride
 * below 16 bytes, unaligned struct members) without being asked for it; WebKit rejects the whole
 * shader module. `check:browser` runs on Chromium, so these tests are what keeps a "renders in
 * Chrome, black canvas in Safari" regression out of the tree: the generated structs must be legal
 * in the uniform address space by construction, and the static validator must reject the pattern
 * that shipped the last time.
 */

import assert from "node:assert/strict";
import { assertContains, assertNotContains, assertThrows, finish, group, test } from "selrun";
import {
  BLIT_SHADER,
  CLUSTER_COUNT,
  CLUSTER_INDEX_CAPACITY,
  ClusterGridBlock,
  ClusterLightBlock,
  ClusterUniforms,
  DEBUG_SHADER,
  DEPTH_VERTEX,
  LightUniforms,
  MAX_CLUSTERED_LIGHTS,
  PARTICLE_RENDER_SHADER,
  POST_SHADER,
  RENDERING_STORAGE_STRUCTS,
  RENDERING_STRUCTS,
  SKY_SHADER,
  SSAO_SHADER,
  STANDARD_FRAGMENT_BODY,
  STANDARD_INSTANCED_VERTEX,
  STANDARD_VERTEX,
  TERRAIN_FRAGMENT_BODY,
  StructDef,
  WATER_SHADER,
  WGSL_RESERVED_WORDS,
  arrayOf,
  f32,
  mixedOperatorIssues,
  ofStruct,
  preprocessWgsl,
  reservedWordIssues,
  u32,
  validateWgsl,
  vec3,
  vec4,
} from "@forge/engine";

const ENTRY = `@vertex fn vs() -> @builtin(position) vec4<f32> { return vec4<f32>(0.0); }`;
const layoutIssues = (source: string): string[] => validateWgsl(source).filter((i) => i.kind === "layout").map((i) => i.message);

test("validates both terrain splat modules with the unchanged standard vertex/depth path", () => {
  for (const vertex of [STANDARD_VERTEX, STANDARD_INSTANCED_VERTEX]) {
    assert.deepEqual(validateWgsl(`${vertex}\n${TERRAIN_FRAGMENT_BODY}`), []);
  }
  assert.equal(RENDERING_STRUCTS.SplatUniforms.byteSize("uniform"), 224);
});

group("generated uniform structs are legal in every browser's uniform address space", () => {
  test("emits padding as scalars, never as a small-stride array", () => {
    for (const def of Object.values(RENDERING_STRUCTS)) {
      const wgsl = def.toWgsl("uniform");
      assert.doesNotMatch(wgsl, /array<\s*(?:f32|i32|u32|bool|vec2<[^>]*>)\s*,/, def.name);
      assert.deepEqual(def.uniformLayoutProblems(), [], def.name);
      const probe = `${wgsl}\n@group(0) @binding(0) var<uniform> probe: ${def.name};\n${ENTRY}`;
      assert.deepEqual(layoutIssues(probe), [], def.name);
    }
  });

  test("keeps the byte layout the CPU writers depend on", () => {
    assert.equal(RENDERING_STRUCTS.PerFrameUniforms.byteSize("uniform"), 256);
    assert.equal(RENDERING_STRUCTS.PerFrameUniforms.offsetOf("flags"), 224);
    assert.equal(RENDERING_STRUCTS.PerFrameUniforms.offsetOf("fogParams"), 240);
    assert.equal(RENDERING_STRUCTS.LightUniforms.byteSize("uniform"), 80);
    assert.equal(RENDERING_STRUCTS.LightUniforms.offsetOf("spotAngles"), 48);
    assert.equal(RENDERING_STRUCTS.LightBlock.byteSize("uniform"), 1296);
    assert.equal(RENDERING_STRUCTS.LightBlock.offsetOf("lights"), 16);
    assert.equal(RENDERING_STRUCTS.ShadowUniforms.byteSize("uniform"), 1456);
    assert.equal(RENDERING_STRUCTS.ShadowUniforms.offsetOf("cascadeTexelWorld"), 272);
    assert.equal(RENDERING_STRUCTS.ShadowUniforms.offsetOf("spotViewProj"), 288);
    assert.equal(RENDERING_STRUCTS.ShadowUniforms.offsetOf("spotParams"), 544);
    assert.equal(RENDERING_STRUCTS.ShadowUniforms.offsetOf("pointViewProj"), 608);
    assert.equal(RENDERING_STRUCTS.ShadowUniforms.offsetOf("pointParams"), 1376);
    assert.equal(RENDERING_STRUCTS.ShadowUniforms.offsetOf("pointCount"), 1408);
    assert.equal(RENDERING_STRUCTS.ShadowUniforms.offsetOf("spotCount"), 1412);
    assert.equal(RENDERING_STRUCTS.ShadowPassUniforms.byteSize("uniform"), 80);
    assert.equal(RENDERING_STRUCTS.PostUniforms.byteSize("uniform"), 48);
    assert.equal(RENDERING_STRUCTS.PostUniforms.offsetOf("flags"), 40);
    assert.equal(RENDERING_STRUCTS.MaterialUniforms.byteSize("uniform"), 80);
    assert.equal(RENDERING_STRUCTS.MaterialUniforms.offsetOf("tiling"), 48);
    assert.equal(RENDERING_STRUCTS.ObjectUniforms.byteSize("uniform"), 176);
    assert.equal(RENDERING_STRUCTS.ObjectUniforms.offsetOf("instanceOffset"), 160);
    assert.equal(RENDERING_STRUCTS.InstanceStruct.byteSize("storage"), 80);
    assert.equal(RENDERING_STRUCTS.SkyUniforms.byteSize("uniform"), 128);
    assert.equal(RENDERING_STRUCTS.SkyUniforms.offsetOf("planetRadius"), 96);
    assert.equal(RENDERING_STRUCTS.SkyUniforms.offsetOf("viewSamples"), 120);
    assert.equal(RENDERING_STRUCTS.CloudUniforms.byteSize("uniform"), 96);
    assert.equal(RENDERING_STRUCTS.CloudUniforms.offsetOf("wind"), 80);
    assert.equal(RENDERING_STRUCTS.WaterUniforms.byteSize("uniform"), 224);
    assert.equal(RENDERING_STRUCTS.WaterUniforms.offsetOf("wavesB"), 64);
    assert.equal(RENDERING_STRUCTS.WaterUniforms.offsetOf("sunDirection"), 208);
    assert.equal(RENDERING_STRUCTS.SsaoUniforms.byteSize("uniform"), 112);
    assert.equal(RENDERING_STRUCTS.SsaoUniforms.offsetOf("radius"), 64);
    assert.equal(RENDERING_STRUCTS.SsaoUniforms.offsetOf("depthSize"), 80);
    assert.equal(RENDERING_STRUCTS.SsaoUniforms.offsetOf("sampleCount"), 96);
  });

  test("keeps the moon anti-solar, atmosphere-attenuated and planet-occluded", () => {
    assert.match(SKY_SHADER, /let moonDir = -sunDir/);
    assert.match(SKY_SHADER, /raySphereEntry\(origin, moonDir, R\) < 0\.0/);
    assert.match(SKY_SHADER, /opticalDepthToSpace\(origin, moonDir, lightSamples\)/);
  });

  test("every shipped shader variant passes the strict validator", () => {
    const sources = {
      STANDARD_VERTEX,
  TERRAIN_FRAGMENT_BODY,
      STANDARD_INSTANCED_VERTEX,
      STANDARD_FRAGMENT_BODY,
      STANDARD_FORWARD: `${STANDARD_VERTEX}\n${STANDARD_FRAGMENT_BODY}`,
      STANDARD_FORWARD_INSTANCED: `${STANDARD_INSTANCED_VERTEX}\n${STANDARD_FRAGMENT_BODY}`,
      DEPTH_VERTEX,
      DEBUG_SHADER,
      BLIT_SHADER,
      POST_SHADER,
      SSAO_SHADER,
      SKY_SHADER,
      WATER_SHADER,
      // Includes the billboard whose reversed-edge smoothstep a strict Tint rejected (PR #32
      // follow-up): the shader corpus is pinned against every validator rule, not only layout.
      PARTICLE_RENDER_SHADER,
    };
    for (const [name, source] of Object.entries(sources)) {
      for (const defines of [
        { QUALITY: 0, SHADOW_MODE: 0 },
        { QUALITY: 2, SHADOW_MODE: 1 },
      ]) {
        assert.deepEqual(validateWgsl(preprocessWgsl(source, defines)), [], `${name} ${JSON.stringify(defines)}`);
      }
    }
  });

  test("refuses to emit a struct whose arrays would have a sub-16-byte stride in uniform space", () => {
    const bad = new StructDef("BadUniform", [
      { name: "m", type: vec4 },
      { name: "weights", type: arrayOf(f32, 4) },
    ]);
    assert.match(bad.uniformLayoutProblems().join("\n"), /4-byte element stride/);
    assertThrows(() => bad.toWgsl("uniform"), /uniform address space/);
    // The same definition is fine as a storage buffer, where scalar arrays are legal.
    assertContains(bad.toWgsl("storage"), "weights: array<f32, 4>");
  });

  test("places struct-typed members on 16-byte boundaries with 16-byte padding after them", () => {
    const inner = new StructDef("Inner", [
      { name: "a", type: f32 },
      { name: "b", type: f32 },
      { name: "c", type: f32 },
    ]);
    const outer = new StructDef("Outer", [
      { name: "head", type: u32 },
      { name: "inner", type: ofStruct(inner) },
      { name: "tail", type: f32 },
      { name: "dir", type: vec3 },
    ]);
    assert.equal(outer.offsetOf("inner", "uniform"), 16);
    assert.equal(outer.offsetOf("tail", "uniform"), 32);
    assert.deepEqual(outer.uniformLayoutProblems(), []);
    const probe = `${inner.toWgsl("uniform")}\n${outer.toWgsl("uniform")}\n@group(0) @binding(0) var<uniform> probe: Outer;\n${ENTRY}`;
    assert.deepEqual(layoutIssues(probe), []);
  });
});

group("validateWgsl applies WebKit's uniform layout rules to hand-written WGSL", () => {
  test("flags the padding pattern that compiled on Chromium and failed on Safari", () => {
    const source = `
struct PerFrame { viewProj: mat4x4<f32>, flags: u32, pad68: array<u32, 3> }
@group(0) @binding(0) var<uniform> perFrame: PerFrame;
${ENTRY}`;
    const issues = layoutIssues(source);
    assert.equal(issues.some((m) => /pad68.*4-byte element stride/.test(m)), true);
  });

  test("flags small strides through nested structs and root-level uniform arrays", () => {
    const source = `
struct Inner { a: f32, b: f32, c: f32 }
struct Block { count: i32, items: array<Inner, 4> }
@group(0) @binding(0) var<uniform> block: Block;
@group(0) @binding(1) var<uniform> weights: array<f32, 8>;
${ENTRY}`;
    const issues = layoutIssues(source);
    assert.equal(issues.some((m) => /items.*12-byte element stride/.test(m)), true);
    assert.equal(issues.some((m) => /weights.*4-byte element stride/.test(m)), true);
  });

  test("flags a struct member that is not followed by 16 bytes of padding", () => {
    const source = `
struct Inner { a: f32, b: f32, c: f32, d: f32, e: f32 }
struct Outer { inner: Inner, next: f32 }
@group(0) @binding(0) var<uniform> outer: Outer;
${ENTRY}`;
    assert.equal(layoutIssues(source).some((m) => /next starts at byte 20/.test(m)), true);
  });

  test("accepts legal uniform layouts and ignores storage buffers", () => {
    const source = `
struct Light { position: vec4<f32>, color: vec3<f32>, pad28: u32 }
struct Frame { m: mat4x4<f32>, cascades: array<mat4x4<f32>, 4>, planes: array<vec4<f32>, 6>, lights: array<Light, 8>, count: u32, pad612: u32, pad616: u32, pad620: u32 }
@group(0) @binding(0) var<uniform> frame: Frame;
@group(0) @binding(1) var<storage, read> weights: array<f32>;
struct Particles { count: u32, data: array<f32, 64> }
@group(0) @binding(2) var<storage, read_write> particles: Particles;
${ENTRY}`;
    assert.deepEqual(layoutIssues(source), []);
  });
});

group("validateWgsl enforces smoothstep edge order", () => {
  const semantics = (source: string): { message: string; line?: number }[] =>
    validateWgsl(source).filter((i) => i.kind === "semantics");

  test("flags the reversed-edge idiom a strict Tint rejected in the browser gate", () => {
    const source = `${ENTRY}
@fragment fn fsMain() -> @location(0) vec4<f32> {
  let edge = smoothstep(0.5, 0.35, 0.4);
  return vec4<f32>(edge);
}`;
    const issues = semantics(source);
    assert.equal(issues.length, 1);
    assert.match(issues[0]!.message, /smoothstep\(0\.5, 0\.35, …\) has low >= high/);
    assert.match(issues[0]!.message, /1\.0 - smoothstep\(0\.35, 0\.5, x\)/);
    assert.equal(issues[0]!.line, 3);
  });

  test("flags equal edges too (also unspecified), with negative and exponent literals", () => {
    const source = `${ENTRY}
@fragment fn fsMain() -> @location(0) vec4<f32> {
  let a = smoothstep(0.5, 0.5, 0.25);
  let b = smoothstep(-1e-1, -0.2, 0.0);
  return vec4<f32>(a + b);
}`;
    assert.deepEqual(semantics(source).map((i) => i.line), [3, 4]);
  });

  test("accepts the spec-legal reversed falloff, ordinary calls and runtime edges", () => {
    const source = `${ENTRY}
@group(0) @binding(0) var<uniform> lens: f32;
@fragment fn fsMain() -> @location(0) vec4<f32> {
  let a = 1.0 - smoothstep(0.35, 0.5, 0.4);
  let b = smoothstep(0.005, 0.08, a);
  let c = smoothstep(lens, lens + 0.001, a);
  return vec4<f32>(a + b + c);
}`;
    assert.deepEqual(semantics(source), []);
  });

  test("ignores reversed edges inside comments, without shifting the reported line", () => {
    const source = `${ENTRY}
// let off = smoothstep(0.9, 0.1, 0.5);
/* let alsoOff = smoothstep(0.7,
   0.6, 0.5); */
@fragment fn fsMain() -> @location(0) vec4<f32> {
  let bad = smoothstep(1.0, 0.0, 0.5);
  return vec4<f32>(bad);
}`;
    const issues = semantics(source);
    assert.equal(issues.length, 1);
    assert.equal(issues[0]!.line, 6);
  });

  test("the shipped particle billboard uses the spec-legal form", () => {
    assert.deepEqual(validateWgsl(preprocessWgsl(PARTICLE_RENDER_SHADER, { QUALITY: 2, SHADOW_MODE: 1 })), []);
    assertContains(PARTICLE_RENDER_SHADER, "1.0 - smoothstep(0.35, 0.5, r)");
  });
});

group("clustered lighting structs (Phase 13.3)", () => {
  const FORWARD = `${STANDARD_VERTEX}\n${STANDARD_FRAGMENT_BODY}`;

  test("sizes both storage blocks from the grid constants, with nothing hardcoded", () => {
    assert.equal(ClusterLightBlock.byteSize("storage"), 16 + MAX_CLUSTERED_LIGHTS * LightUniforms.byteSize("storage"));
    assert.equal(ClusterGridBlock.byteSize("storage"), CLUSTER_COUNT * 4 + CLUSTER_INDEX_CAPACITY * 4);
    // The grid is far past the 64 KiB uniform binding limit, which is why it is storage-bound; the
    // light block is storage too, so one binding style covers both and neither can grow into a limit.
    assert.ok(ClusterGridBlock.byteSize("storage") > 64 * 1024);
    assert.deepEqual(Object.keys(RENDERING_STORAGE_STRUCTS).sort(), [
      "ClusterGridBlock",
      "ClusterLightBlock",
      "ClusterRangeBlock",
      "ClusterRangeEntry",
      "ObjectBatchBlock",
      "ObjectBatchEntry",
      "ObjectCullStatsBlock",
    ]);
    // The per-cluster quantisation is small and read every fragment: that one is a uniform.
    assert.equal(ClusterUniforms.byteSize("uniform"), 48);
    assert.equal(RENDERING_STRUCTS.ClusterUniforms, ClusterUniforms);
  });

  test("embeds the generated declarations verbatim in the shader that binds them", () => {
    for (const def of [ClusterLightBlock, ClusterGridBlock]) {
      assertContains(FORWARD, def.toWgsl("storage"), def.name);
    }
    assertContains(FORWARD, ClusterUniforms.toWgsl("uniform"));
    // The validator's uniform rules do not apply to storage space, so embedding them is legal.
    assert.deepEqual(layoutIssues(preprocessWgsl(FORWARD, { QUALITY: 2, SHADOW_MODE: 1 })), []);
  });

  test("routes directional and spot shadow indices to their own atlas layers", () => {
    assertContains(STANDARD_FRAGMENT_BODY, "fn spotShadowAttenuation(");
    assertContains(STANDARD_FRAGMENT_BODY, "uniforms_shadow.spotViewProj[shadowIndex]");
    assertContains(STANDARD_FRAGMENT_BODY, "uniforms_shadow.count + shadowIndex");
    assertContains(STANDARD_FRAGMENT_BODY, "textureSampleCompareLevel(shadowMap, shadowSampler, uv + o, layer, depth)");
    assertContains(STANDARD_FRAGMENT_BODY, "power = power * spotShadowAttenuation(s.worldPos, N, L.shadowIndex);");
    assertContains(STANDARD_FRAGMENT_BODY, "power = power * shadowAttenuation(s.worldPos, N, s.viewDepth);");
  });

  test("keeps one shading function for both light paths, behind a runtime flag", () => {
    // The uniform-list loop and the cluster loop call the same function: that single definition is
    // what makes clustering bit-identical when a scene has fewer lights than the old fixed list.
    assert.equal((STANDARD_FRAGMENT_BODY.match(/fn lightContribution\(/g) ?? []).length, 1);
    assert.equal((STANDARD_FRAGMENT_BODY.match(/lightContribution\(/g) ?? []).length, 3); // def + two call sites
    // A runtime flag, not a compile-time define: every shipped variant contains both paths, so the
    // browser gate can A/B them on one pipeline instead of two builds.
    assertContains(FORWARD, "const FLAGS_CLUSTERED: u32 = 32u;");
    assertContains(STANDARD_FRAGMENT_BODY, "if ((perFrame.flags & FLAGS_CLUSTERED) != 0u) {");
    assert.doesNotMatch(FORWARD, /#if[^\n]*CLUSTER/);
  });
});

group("validateWgsl rejects WGSL's reserved words", () => {
  // The Phase 13.3 cluster grid shipped a per-cluster array called `meta`: legal to the mock device
  // and to every structural check, and a parse error to Tint ("'meta' is a reserved keyword"), which
  // made every pipeline built from standard.ts invalid and every frame fail to submit. Only the
  // browser gate saw it, so the rule now lives here.
  const source = [
    "struct ClusterGridBlock {",
    "  clusterOffsets: array<u32, 4>,",
    "  meta: array<u32, 4>,",
    "};",
    "@group(0) @binding(0) var<storage, read> grid: ClusterGridBlock;",
    "@fragment fn fs() -> @location(0) vec4<f32> {",
    "  let meta = 0;",
    "  return vec4<f32>(f32(grid.meta[meta]));",
    "}",
  ].join("\n");

  test("flags every use of a reserved word as an identifier, on its real line", () => {
    const issues = reservedWordIssues(source);
    assert.equal((issues).length, 4); // the member declaration, the local, and both uses on line 8
    for (const issue of issues) {
      assert.equal(issue.kind, "semantics");
      assertContains(issue.message, "'meta' is a reserved WGSL keyword");
    }
    assert.deepEqual(issues.map((i) => i.line), [3, 7, 8, 8]);
    assert.equal((validateWgsl(source).filter((i) => i.message.includes("reserved"))).length, 4);
  });

  test("leaves attribute spellings and prose alone, and does not over-claim the language's own words", () => {
    const legal = `
struct Uniforms { @align(16) tint: vec4<f32> };
struct Varyings { @builtin(position) @invariant clipPos: vec4<f32> };
@group(0) @binding(0) var<uniform> u: Uniforms;
@vertex fn vs() -> Varyings {
  // a meta comment about the shared type of this module
  var out: Varyings;
  out.clipPos = u.tint;
  return out;
}`;
    assert.deepEqual(reservedWordIssues(legal), []);
    assert.deepEqual(validateWgsl(legal), []);
    // Words WGSL genuinely uses must not be in the list, or every shader would fail the gate.
    for (const word of ["struct", "let", "var", "fn", "uniform", "storage", "read", "override", "f16", "vec4", "array"]) {
      assertNotContains(WGSL_RESERVED_WORDS, word, word);
    }
    assertContains(WGSL_RESERVED_WORDS, "meta");
    assert.equal(new Set(WGSL_RESERVED_WORDS).size, WGSL_RESERVED_WORDS.length); // no duplicates
  });
});

group("validateWgsl rejects mixed relational and bitwise operators", () => {
  // The Phase 13.4 assignment shader generated its coverage test from RANGE_KEY_BITS and paired a
  // comparison with a generated mask: `slice < (key >> 14u) & 31u`. WGSL forbids mixing a relational
  // operator with a bitwise one without parentheses, Tint rejects the module at createShaderModule,
  // and every frame failed to submit with "Invalid ComputePipeline" — while the mock device recorded
  // the pass, check:wgsl was structurally green and 561 unit tests passed. Only the browser gate saw
  // it, so the rule now lives here (and `LIGHT_CULL_SHADER` is parenthesised because of it).
  const mixed = (expr: string) =>
    ["@workgroup_size(64) @compute fn cs() {", `  if (${expr}) {`, "    return;", "  }", "}"].join("\n");

  test("flags the generated-decode shape, at the line it is on", () => {
    const issues = mixedOperatorIssues(mixed("slice < (key >> 14u) & 31u"));
    assert.equal((issues).length, 1);
    assert.equal(issues[0]!.kind, "semantics");
    assert.equal(issues[0]!.line, 2);
    assertContains(issues[0]!.message, "mixed at the same nesting level");
    assert.ok(validateWgsl(mixed("slice < (key >> 14u) & 31u")).length > 0);
  });

  test("flags the comparison and the bitwise operator in either order", () => {
    for (const expr of ["a < b & c", "a & b < c", "tileX >= (k >> 4u) | 3u", "x <= m ^ 1u && y > 0"]) {
      assert.equal((mixedOperatorIssues(mixed(expr))).length, 1, expr);
    }
  });

  test("accepts the parenthesised form, logical operators, and type parameter lists", () => {
    const legal = [
      "slice < ((key >> 14u) & 31u)",
      "(flags & 32u) != 0u",
      "a == b || (c & d) != 0u",
      "a && b > 0", // logical, not bitwise: mixing with a comparison is legal
      "x < 1.0",
      "a >> 3u == 0u", // shifts bind tighter than comparisons: Tint accepts this unparenthesised
      "a == b >> 3u",
    ];
    for (const expr of legal) {
      assert.deepEqual(mixedOperatorIssues(mixed(expr)), [], expr);
      assert.deepEqual(validateWgsl(mixed(expr)), [], expr);
    }
    // Type parameter lists read as a shift to a character-level scan; every shipped shader is full of
    // them, so a rule that flagged them would fail the gate on all of them.
    const generics = `
struct P { v: vec3<f32>, c: vec4<f32> };
@group(0) @binding(0) var<storage, read_write> trails: array<vec4<f32>>;
@group(0) @binding(1) var<storage, read_write> indirect: array<atomic<u32>>;
@workgroup_size(64) @compute fn cs() {
  let h = (1u ^ (2u >> 16u)) * 3u;
  if (h > 4u) {
    trails[0] = vec4<f32>(0.0);
  }
}`;
    assert.deepEqual(mixedOperatorIssues(generics), []);
    assert.deepEqual(validateWgsl(generics), []);
  });

  test("does not treat a return arrow as a comparison", () => {
    const source = `
fn f(key: u32) -> bool {
  return (key >> 4u) > 1u && (key & 3u) == 0u;
}
@workgroup_size(64) @compute fn cs() {
  if (f(1u)) {
    return;
  }
}`;
    assert.deepEqual(mixedOperatorIssues(source), []);
    assert.deepEqual(validateWgsl(source), []);
  });
});

await finish();
