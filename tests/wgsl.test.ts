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
  DEBUG_SHADER,
  DEPTH_VERTEX,
  POST_SHADER,
  RENDERING_STRUCTS,
  STANDARD_FRAGMENT_BODY,
  STANDARD_INSTANCED_VERTEX,
  STANDARD_VERTEX,
  StructDef,
  arrayOf,
  f32,
  ofStruct,
  preprocessWgsl,
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
    expect(RENDERING_STRUCTS.PerFrameUniforms.byteSize("uniform")).toBe(240);
    expect(RENDERING_STRUCTS.PerFrameUniforms.offsetOf("flags")).toBe(224);
    expect(RENDERING_STRUCTS.LightUniforms.byteSize("uniform")).toBe(80);
    expect(RENDERING_STRUCTS.LightUniforms.offsetOf("spotAngles")).toBe(48);
    expect(RENDERING_STRUCTS.LightBlock.byteSize("uniform")).toBe(1296);
    expect(RENDERING_STRUCTS.LightBlock.offsetOf("lights")).toBe(16);
    expect(RENDERING_STRUCTS.ShadowUniforms.byteSize("uniform")).toBe(320);
    expect(RENDERING_STRUCTS.ShadowUniforms.offsetOf("cascadeTexelWorld")).toBe(272);
    expect(RENDERING_STRUCTS.ShadowPassUniforms.byteSize("uniform")).toBe(80);
    expect(RENDERING_STRUCTS.PostUniforms.byteSize("uniform")).toBe(48);
    expect(RENDERING_STRUCTS.PostUniforms.offsetOf("flags")).toBe(40);
    expect(RENDERING_STRUCTS.MaterialUniforms.byteSize("uniform")).toBe(80);
    expect(RENDERING_STRUCTS.MaterialUniforms.offsetOf("tiling")).toBe(48);
    expect(RENDERING_STRUCTS.ObjectUniforms.byteSize("uniform")).toBe(176);
    expect(RENDERING_STRUCTS.ObjectUniforms.offsetOf("instanceOffset")).toBe(160);
    expect(RENDERING_STRUCTS.InstanceStruct.byteSize("storage")).toBe(80);
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
