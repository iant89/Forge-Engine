/**
 * `npm run check:wgsl` — validate every WGSL string the engine ships with, using the engine's own
 * structural validator (the same one the ShaderCache runs before `createShaderModule`).
 *
 * This is a cheap gate against the classic failure mode where a shader is edited by hand and stops
 * matching the generated layout structs. It does not replace a real `naga` compile: WGSL validation on
 * a browser GPU is stricter, so a green run here means "no structural errors found", not "compiles".
 *
 * Exit code is non-zero when any module fails, and the offending lines are printed with their cause.
 */
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const engine = await import(pathToFileURL(resolve("engine/dist/index.js")).href);
const { validateWgsl, preprocessWgsl, STANDARD_VERTEX, STANDARD_INSTANCED_VERTEX, STANDARD_FRAGMENT_BODY, DEPTH_VERTEX, DEBUG_SHADER, BLIT_SHADER, RENDERING_STRUCTS, diffWgslStruct, structSize, MaterialUniforms, ObjectUniforms, PerFrameUniforms, LightUniforms, ShadowUniforms, InstanceStruct } = engine;

const modules = {
  "shaders/standard.ts:STANDARD_VERTEX": STANDARD_VERTEX,
  "shaders/standard.ts:STANDARD_INSTANCED_VERTEX": STANDARD_INSTANCED_VERTEX,
  "shaders/standard.ts:STANDARD_FRAGMENT_BODY": STANDARD_FRAGMENT_BODY,
  "shaders/standard.ts:DEPTH_VERTEX": DEPTH_VERTEX,
  "shaders/standard.ts:DEBUG_SHADER": DEBUG_SHADER,
  "shaders/standard.ts:BLIT_SHADER": BLIT_SHADER,
};

let failed = 0;
for (const [name, source] of Object.entries(modules)) {
  if (typeof source !== "string") {
    console.error(`${name}: not a string (export missing?)`);
    failed++;
    continue;
  }
  const pre = preprocessWgsl(source, { QUALITY: 2, SHADOW_MODE: 1 });
  const prepped = typeof pre === "string" ? pre : pre?.source ?? source;
  const result = validateWgsl(prepped);
  const errs = result.errors ?? [];
  if (errs.length) {
    failed++;
    console.error(`${name}: ${errs.length} issue(s)`);
    for (const e of errs.slice(0, 8)) console.error(`   line ${e.line}: ${e.message}`);
  } else {
    console.log(`${name}: ok (${prepped.split("\n").length} lines)`);
  }
}

// Layout/shader agreement is enforced where it matters: PipelineFactory compares the struct text it
// embeds in each generated variant against the JS definition with `diffWgslStruct` and throws on a
// mismatch. This tool only checks that the shipped hand-written WGSL is structurally valid.
for (const [label, def] of Object.entries(RENDERING_STRUCTS ?? {})) {
  if (!def || typeof def.byteSize !== "function") {
    console.error(`RENDERING_STRUCTS.${label}: not a StructDef (layout registry broken)`);
    failed++;
    continue;
  }
  const size = def.byteSize("uniform");
  if (!(size > 0) || size % 16 !== 0) {
    console.error(`RENDERING_STRUCTS.${label}: size ${size} is not a positive multiple of 16`);
    failed++;
  } else {
    console.log(`RENDERING_STRUCTS.${label}: ${size} B`);
  }
}

if (failed > 0) {
  console.error(`\ncheck:wgsl FAILED (${failed} problem(s))`);
  process.exit(1);
}
console.log("\ncheck:wgsl passed (structural validation only — real GPU compile is stricter).");
