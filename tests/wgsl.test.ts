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

import { describe, expect, it } from "vitest";
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

describe("generated uniform structs are legal in every browser's uniform address space", () => {
  it("emits padding as scalars, never as a small-stride array", () => {
    for (const def of Object.values(RENDERING_STRUCTS)) {
      const wgsl = def.toWgsl("uniform");
      expect(wgsl, def.name).not.toMatch(/array<\s*(?:f32|i32|u32|bool|vec2<[^>]*>)\s*,/);
      expect(def.uniformLayoutProblems(), def.name).toEqual([]);
      const probe = `${wgsl}\n@group(0) @binding(0) var<uniform> probe: ${def.name};\n${ENTRY}`;
      expect(layoutIssues(probe), def.name).toEqual([]);
    }
  });

  it("keeps the byte layout the CPU writers depend on", () => {
    expect(RENDERING_STRUCTS.PerFrameUniforms.byteSize("uniform")).toBe(256);
    expect(RENDERING_STRUCTS.PerFrameUniforms.offsetOf("flags")).toBe(224);
    expect(RENDERING_STRUCTS.PerFrameUniforms.offsetOf("fogParams")).toBe(240);
    expect(RENDERING_STRUCTS.LightUniforms.byteSize("uniform")).toBe(80);
    expect(RENDERING_STRUCTS.LightUniforms.offsetOf("spotAngles")).toBe(48);
    expect(RENDERING_STRUCTS.LightBlock.byteSize("uniform")).toBe(1296);
    expect(RENDERING_STRUCTS.LightBlock.offsetOf("lights")).toBe(16);
    expect(RENDERING_STRUCTS.ShadowUniforms.byteSize("uniform")).toBe(656);
    expect(RENDERING_STRUCTS.ShadowUniforms.offsetOf("cascadeTexelWorld")).toBe(272);
    expect(RENDERING_STRUCTS.ShadowUniforms.offsetOf("spotViewProj")).toBe(288);
    expect(RENDERING_STRUCTS.ShadowUniforms.offsetOf("spotParams")).toBe(544);
    expect(RENDERING_STRUCTS.ShadowUniforms.offsetOf("spotCount")).toBe(608);
    expect(RENDERING_STRUCTS.ShadowPassUniforms.byteSize("uniform")).toBe(80);
    expect(RENDERING_STRUCTS.PostUniforms.byteSize("uniform")).toBe(48);
    expect(RENDERING_STRUCTS.PostUniforms.offsetOf("flags")).toBe(40);
    expect(RENDERING_STRUCTS.MaterialUniforms.byteSize("uniform")).toBe(80);
    expect(RENDERING_STRUCTS.MaterialUniforms.offsetOf("tiling")).toBe(48);
    expect(RENDERING_STRUCTS.ObjectUniforms.byteSize("uniform")).toBe(176);
    expect(RENDERING_STRUCTS.ObjectUniforms.offsetOf("instanceOffset")).toBe(160);
    expect(RENDERING_STRUCTS.InstanceStruct.byteSize("storage")).toBe(80);
    expect(RENDERING_STRUCTS.SkyUniforms.byteSize("uniform")).toBe(128);
    expect(RENDERING_STRUCTS.SkyUniforms.offsetOf("planetRadius")).toBe(96);
    expect(RENDERING_STRUCTS.SkyUniforms.offsetOf("viewSamples")).toBe(120);
    expect(RENDERING_STRUCTS.CloudUniforms.byteSize("uniform")).toBe(96);
    expect(RENDERING_STRUCTS.CloudUniforms.offsetOf("wind")).toBe(80);
    expect(RENDERING_STRUCTS.WaterUniforms.byteSize("uniform")).toBe(224);
    expect(RENDERING_STRUCTS.WaterUniforms.offsetOf("wavesB")).toBe(64);
    expect(RENDERING_STRUCTS.WaterUniforms.offsetOf("sunDirection")).toBe(208);
    expect(RENDERING_STRUCTS.SsaoUniforms.byteSize("uniform")).toBe(112);
    expect(RENDERING_STRUCTS.SsaoUniforms.offsetOf("radius")).toBe(64);
    expect(RENDERING_STRUCTS.SsaoUniforms.offsetOf("depthSize")).toBe(80);
    expect(RENDERING_STRUCTS.SsaoUniforms.offsetOf("sampleCount")).toBe(96);
  });

  it("every shipped shader variant passes the strict validator", () => {
    const sources = {
      STANDARD_VERTEX,
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
        expect(validateWgsl(preprocessWgsl(source, defines)), `${name} ${JSON.stringify(defines)}`).toEqual([]);
      }
    }
  });

  it("refuses to emit a struct whose arrays would have a sub-16-byte stride in uniform space", () => {
    const bad = new StructDef("BadUniform", [
      { name: "m", type: vec4 },
      { name: "weights", type: arrayOf(f32, 4) },
    ]);
    expect(bad.uniformLayoutProblems().join("\n")).toMatch(/4-byte element stride/);
    expect(() => bad.toWgsl("uniform")).toThrow(/uniform address space/);
    // The same definition is fine as a storage buffer, where scalar arrays are legal.
    expect(bad.toWgsl("storage")).toContain("weights: array<f32, 4>");
  });

  it("places struct-typed members on 16-byte boundaries with 16-byte padding after them", () => {
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
    expect(outer.offsetOf("inner", "uniform")).toBe(16);
    expect(outer.offsetOf("tail", "uniform")).toBe(32);
    expect(outer.uniformLayoutProblems()).toEqual([]);
    const probe = `${inner.toWgsl("uniform")}\n${outer.toWgsl("uniform")}\n@group(0) @binding(0) var<uniform> probe: Outer;\n${ENTRY}`;
    expect(layoutIssues(probe)).toEqual([]);
  });
});

describe("validateWgsl applies WebKit's uniform layout rules to hand-written WGSL", () => {
  it("flags the padding pattern that compiled on Chromium and failed on Safari", () => {
    const source = `
struct PerFrame { viewProj: mat4x4<f32>, flags: u32, pad68: array<u32, 3> }
@group(0) @binding(0) var<uniform> perFrame: PerFrame;
${ENTRY}`;
    const issues = layoutIssues(source);
    expect(issues.some((m) => /pad68.*4-byte element stride/.test(m))).toBe(true);
  });

  it("flags small strides through nested structs and root-level uniform arrays", () => {
    const source = `
struct Inner { a: f32, b: f32, c: f32 }
struct Block { count: i32, items: array<Inner, 4> }
@group(0) @binding(0) var<uniform> block: Block;
@group(0) @binding(1) var<uniform> weights: array<f32, 8>;
${ENTRY}`;
    const issues = layoutIssues(source);
    expect(issues.some((m) => /items.*12-byte element stride/.test(m))).toBe(true);
    expect(issues.some((m) => /weights.*4-byte element stride/.test(m))).toBe(true);
  });

  it("flags a struct member that is not followed by 16 bytes of padding", () => {
    const source = `
struct Inner { a: f32, b: f32, c: f32, d: f32, e: f32 }
struct Outer { inner: Inner, next: f32 }
@group(0) @binding(0) var<uniform> outer: Outer;
${ENTRY}`;
    expect(layoutIssues(source).some((m) => /next starts at byte 20/.test(m))).toBe(true);
  });

  it("accepts legal uniform layouts and ignores storage buffers", () => {
    const source = `
struct Light { position: vec4<f32>, color: vec3<f32>, pad28: u32 }
struct Frame { m: mat4x4<f32>, cascades: array<mat4x4<f32>, 4>, planes: array<vec4<f32>, 6>, lights: array<Light, 8>, count: u32, pad612: u32, pad616: u32, pad620: u32 }
@group(0) @binding(0) var<uniform> frame: Frame;
@group(0) @binding(1) var<storage, read> weights: array<f32>;
struct Particles { count: u32, data: array<f32, 64> }
@group(0) @binding(2) var<storage, read_write> particles: Particles;
${ENTRY}`;
    expect(layoutIssues(source)).toEqual([]);
  });
});

describe("validateWgsl enforces smoothstep edge order", () => {
  const semantics = (source: string): { message: string; line?: number }[] =>
    validateWgsl(source).filter((i) => i.kind === "semantics");

  it("flags the reversed-edge idiom a strict Tint rejected in the browser gate", () => {
    const source = `${ENTRY}
@fragment fn fsMain() -> @location(0) vec4<f32> {
  let edge = smoothstep(0.5, 0.35, 0.4);
  return vec4<f32>(edge);
}`;
    const issues = semantics(source);
    expect(issues.length).toBe(1);
    expect(issues[0]!.message).toMatch(/smoothstep\(0\.5, 0\.35, …\) has low >= high/);
    expect(issues[0]!.message).toMatch(/1\.0 - smoothstep\(0\.35, 0\.5, x\)/);
    expect(issues[0]!.line).toBe(3);
  });

  it("flags equal edges too (also unspecified), with negative and exponent literals", () => {
    const source = `${ENTRY}
@fragment fn fsMain() -> @location(0) vec4<f32> {
  let a = smoothstep(0.5, 0.5, 0.25);
  let b = smoothstep(-1e-1, -0.2, 0.0);
  return vec4<f32>(a + b);
}`;
    expect(semantics(source).map((i) => i.line)).toEqual([3, 4]);
  });

  it("accepts the spec-legal reversed falloff, ordinary calls and runtime edges", () => {
    const source = `${ENTRY}
@group(0) @binding(0) var<uniform> lens: f32;
@fragment fn fsMain() -> @location(0) vec4<f32> {
  let a = 1.0 - smoothstep(0.35, 0.5, 0.4);
  let b = smoothstep(0.005, 0.08, a);
  let c = smoothstep(lens, lens + 0.001, a);
  return vec4<f32>(a + b + c);
}`;
    expect(semantics(source)).toEqual([]);
  });

  it("ignores reversed edges inside comments, without shifting the reported line", () => {
    const source = `${ENTRY}
// let off = smoothstep(0.9, 0.1, 0.5);
/* let alsoOff = smoothstep(0.7,
   0.6, 0.5); */
@fragment fn fsMain() -> @location(0) vec4<f32> {
  let bad = smoothstep(1.0, 0.0, 0.5);
  return vec4<f32>(bad);
}`;
    const issues = semantics(source);
    expect(issues.length).toBe(1);
    expect(issues[0]!.line).toBe(6);
  });

  it("the shipped particle billboard uses the spec-legal form", () => {
    expect(validateWgsl(preprocessWgsl(PARTICLE_RENDER_SHADER, { QUALITY: 2, SHADOW_MODE: 1 }))).toEqual([]);
    expect(PARTICLE_RENDER_SHADER).toContain("1.0 - smoothstep(0.35, 0.5, r)");
  });
});

describe("clustered lighting structs (Phase 13.3)", () => {
  const FORWARD = `${STANDARD_VERTEX}\n${STANDARD_FRAGMENT_BODY}`;

  it("sizes both storage blocks from the grid constants, with nothing hardcoded", () => {
    expect(ClusterLightBlock.byteSize("storage")).toBe(16 + MAX_CLUSTERED_LIGHTS * LightUniforms.byteSize("storage"));
    expect(ClusterGridBlock.byteSize("storage")).toBe(CLUSTER_COUNT * 4 + CLUSTER_INDEX_CAPACITY * 4);
    // The grid is far past the 64 KiB uniform binding limit, which is why it is storage-bound; the
    // light block is storage too, so one binding style covers both and neither can grow into a limit.
    expect(ClusterGridBlock.byteSize("storage")).toBeGreaterThan(64 * 1024);
    expect(Object.keys(RENDERING_STORAGE_STRUCTS).sort()).toEqual([
      "ClusterGridBlock",
      "ClusterLightBlock",
      "ClusterRangeBlock",
      "ClusterRangeEntry",
      "ObjectBatchBlock",
      "ObjectBatchEntry",
      "ObjectCullStatsBlock",
    ]);
    // The per-cluster quantisation is small and read every fragment: that one is a uniform.
    expect(ClusterUniforms.byteSize("uniform")).toBe(48);
    expect(RENDERING_STRUCTS.ClusterUniforms).toBe(ClusterUniforms);
  });

  it("embeds the generated declarations verbatim in the shader that binds them", () => {
    for (const def of [ClusterLightBlock, ClusterGridBlock]) {
      expect(FORWARD, def.name).toContain(def.toWgsl("storage"));
    }
    expect(FORWARD).toContain(ClusterUniforms.toWgsl("uniform"));
    // The validator's uniform rules do not apply to storage space, so embedding them is legal.
    expect(layoutIssues(preprocessWgsl(FORWARD, { QUALITY: 2, SHADOW_MODE: 1 }))).toEqual([]);
  });

  it("routes directional and spot shadow indices to their own atlas layers", () => {
    expect(STANDARD_FRAGMENT_BODY).toContain("fn spotShadowAttenuation(");
    expect(STANDARD_FRAGMENT_BODY).toContain("uniforms_shadow.spotViewProj[shadowIndex]");
    expect(STANDARD_FRAGMENT_BODY).toContain("uniforms_shadow.count + shadowIndex");
    expect(STANDARD_FRAGMENT_BODY).toContain("textureSampleCompareLevel(shadowMap, shadowSampler, uv + o, layer, depth)");
    expect(STANDARD_FRAGMENT_BODY).toContain("power = power * spotShadowAttenuation(s.worldPos, N, L.shadowIndex);");
    expect(STANDARD_FRAGMENT_BODY).toContain("power = power * shadowAttenuation(s.worldPos, N, s.viewDepth);");
  });

  it("keeps one shading function for both light paths, behind a runtime flag", () => {
    // The uniform-list loop and the cluster loop call the same function: that single definition is
    // what makes clustering bit-identical when a scene has fewer lights than the old fixed list.
    expect(STANDARD_FRAGMENT_BODY.match(/fn lightContribution\(/g)).toHaveLength(1);
    expect(STANDARD_FRAGMENT_BODY.match(/lightContribution\(/g)).toHaveLength(3); // def + two call sites
    // A runtime flag, not a compile-time define: every shipped variant contains both paths, so the
    // browser gate can A/B them on one pipeline instead of two builds.
    expect(FORWARD).toContain("const FLAGS_CLUSTERED: u32 = 32u;");
    expect(STANDARD_FRAGMENT_BODY).toContain("if ((perFrame.flags & FLAGS_CLUSTERED) != 0u) {");
    expect(FORWARD).not.toMatch(/#if[^\n]*CLUSTER/);
  });
});

describe("validateWgsl rejects WGSL's reserved words", () => {
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

  it("flags every use of a reserved word as an identifier, on its real line", () => {
    const issues = reservedWordIssues(source);
    expect(issues).toHaveLength(4); // the member declaration, the local, and both uses on line 8
    for (const issue of issues) {
      expect(issue.kind).toBe("semantics");
      expect(issue.message).toContain("'meta' is a reserved WGSL keyword");
    }
    expect(issues.map((i) => i.line)).toEqual([3, 7, 8, 8]);
    expect(validateWgsl(source).filter((i) => i.message.includes("reserved"))).toHaveLength(4);
  });

  it("leaves attribute spellings and prose alone, and does not over-claim the language's own words", () => {
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
    expect(reservedWordIssues(legal)).toEqual([]);
    expect(validateWgsl(legal)).toEqual([]);
    // Words WGSL genuinely uses must not be in the list, or every shader would fail the gate.
    for (const word of ["struct", "let", "var", "fn", "uniform", "storage", "read", "override", "f16", "vec4", "array"]) {
      expect(WGSL_RESERVED_WORDS, word).not.toContain(word);
    }
    expect(WGSL_RESERVED_WORDS).toContain("meta");
    expect(new Set(WGSL_RESERVED_WORDS).size).toBe(WGSL_RESERVED_WORDS.length); // no duplicates
  });
});

describe("validateWgsl rejects mixed relational and bitwise operators", () => {
  // The Phase 13.4 assignment shader generated its coverage test from RANGE_KEY_BITS and paired a
  // comparison with a generated mask: `slice < (key >> 14u) & 31u`. WGSL forbids mixing a relational
  // operator with a bitwise one without parentheses, Tint rejects the module at createShaderModule,
  // and every frame failed to submit with "Invalid ComputePipeline" — while the mock device recorded
  // the pass, check:wgsl was structurally green and 561 unit tests passed. Only the browser gate saw
  // it, so the rule now lives here (and `LIGHT_CULL_SHADER` is parenthesised because of it).
  const mixed = (expr: string) =>
    ["@workgroup_size(64) @compute fn cs() {", `  if (${expr}) {`, "    return;", "  }", "}"].join("\n");

  it("flags the generated-decode shape, at the line it is on", () => {
    const issues = mixedOperatorIssues(mixed("slice < (key >> 14u) & 31u"));
    expect(issues).toHaveLength(1);
    expect(issues[0]!.kind).toBe("semantics");
    expect(issues[0]!.line).toBe(2);
    expect(issues[0]!.message).toContain("mixed at the same nesting level");
    expect(validateWgsl(mixed("slice < (key >> 14u) & 31u")).length).toBeGreaterThan(0);
  });

  it("flags the comparison and the bitwise operator in either order", () => {
    for (const expr of ["a < b & c", "a & b < c", "tileX >= (k >> 4u) | 3u", "x <= m ^ 1u && y > 0"]) {
      expect(mixedOperatorIssues(mixed(expr)), expr).toHaveLength(1);
    }
  });

  it("accepts the parenthesised form, logical operators, and type parameter lists", () => {
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
      expect(mixedOperatorIssues(mixed(expr)), expr).toEqual([]);
      expect(validateWgsl(mixed(expr)), expr).toEqual([]);
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
    expect(mixedOperatorIssues(generics)).toEqual([]);
    expect(validateWgsl(generics)).toEqual([]);
  });

  it("does not treat a return arrow as a comparison", () => {
    const source = `
fn f(key: u32) -> bool {
  return (key >> 4u) > 1u && (key & 3u) == 0u;
}
@workgroup_size(64) @compute fn cs() {
  if (f(1u)) {
    return;
  }
}`;
    expect(mixedOperatorIssues(source)).toEqual([]);
    expect(validateWgsl(source)).toEqual([]);
  });
});
