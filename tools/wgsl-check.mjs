/**
 * `npm run check:wgsl` — validate every WGSL string the engine ships with, using the engine's own
 * structural validator (the same one the ShaderCache runs before `createShaderModule`).
 *
 * This is a cheap gate against the classic failure mode where a shader is edited by hand and stops
 * matching the generated layout structs. It does not replace a real compile: WGSL validation on a
 * browser GPU is stricter, so a green run here means "no structural errors found", not "compiles".
 *
 * What it does enforce is the uniform address-space layout (array strides and struct/array member
 * offsets that are multiples of 16). That rule is the one browsers disagree on: Chromium accepts a
 * relaxed layout without being asked, WebKit rejects the shader module, and `check:browser` runs on
 * Chromium — so this check is the only thing standing between "renders in Chrome" and "black canvas
 * in Safari". Every generated struct is checked both through its TypeScript layout
 * (`uniformLayoutProblems`) and through the WGSL text it emits.
 *
 * Exit code is non-zero when any module fails, and the offending lines are printed with their cause.
 */
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const engine = await import(pathToFileURL(resolve("engine/dist/index.js")).href);
const { validateWgsl, preprocessWgsl, STANDARD_VERTEX, STANDARD_INSTANCED_VERTEX, STANDARD_FRAGMENT_BODY, DEPTH_VERTEX, DEBUG_SHADER, BLIT_SHADER, POST_SHADER, SKY_SHADER, WATER_SHADER, PARTICLE_SIM_SHADER, RENDERING_STRUCTS } = engine;

// The forward shader is validated as the pipeline factory actually compiles it: one module holding
// the vertex stage and the fragment body (both variants), not the two halves in isolation.
const modules = {
  "shaders/standard.ts:STANDARD_VERTEX": STANDARD_VERTEX,
  "shaders/standard.ts:STANDARD_INSTANCED_VERTEX": STANDARD_INSTANCED_VERTEX,
  "shaders/standard.ts:STANDARD_FRAGMENT_BODY": STANDARD_FRAGMENT_BODY,
  "shaders/standard.ts:STANDARD_VERTEX+FRAGMENT": `${STANDARD_VERTEX}\n${STANDARD_FRAGMENT_BODY}`,
  "shaders/standard.ts:STANDARD_INSTANCED_VERTEX+FRAGMENT": `${STANDARD_INSTANCED_VERTEX}\n${STANDARD_FRAGMENT_BODY}`,
  "shaders/standard.ts:DEPTH_VERTEX": DEPTH_VERTEX,
  "shaders/standard.ts:DEBUG_SHADER": DEBUG_SHADER,
  "shaders/standard.ts:BLIT_SHADER": BLIT_SHADER,
  "shaders/post.ts:POST_SHADER": POST_SHADER,
  "shaders/sky.ts:SKY_SHADER": SKY_SHADER,
  "shaders/water.ts:WATER_SHADER": WATER_SHADER,
  "particles/shader.ts:PARTICLE_SIM_SHADER": PARTICLE_SIM_SHADER,
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
  const errs = Array.isArray(result) ? result : (result.errors ?? []);
  if (errs.length) {
    failed++;
    console.error(`${name}: ${errs.length} issue(s)`);
    for (const e of errs.slice(0, 8)) console.error(`   line ${e.line}: ${e.message}`);
  } else {
    console.log(`${name}: ok (${prepped.split("\n").length} lines)`);
  }
}

// The shaders embed `StructDef.toWgsl()` output directly, so the shader text and the CPU writer
// cannot drift apart by construction. What can go wrong is the definition itself being illegal in
// the uniform address space; check every registered struct as if it were bound with `var<uniform>`,
// both via the layout engine and via the emitted text, exactly as a strict compiler would see it.
for (const [label, def] of Object.entries(RENDERING_STRUCTS ?? {})) {
  if (!def || typeof def.byteSize !== "function" || typeof def.uniformLayoutProblems !== "function") {
    console.error(`RENDERING_STRUCTS.${label}: not a StructDef (layout registry broken)`);
    failed++;
    continue;
  }
  const size = def.byteSize("uniform");
  const problems = def.uniformLayoutProblems();
  let wgsl = "";
  try {
    wgsl = def.toWgsl("uniform");
  } catch (error) {
    problems.push(`toWgsl("uniform") threw: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (wgsl) {
    const probe = `${wgsl}\n@group(0) @binding(0) var<uniform> probe: ${def.name};\n@vertex fn vs() -> @builtin(position) vec4<f32> { return vec4<f32>(0.0); }\n`;
    for (const issue of validateWgsl(probe)) problems.push(`${issue.kind}: ${issue.message}`);
    if (/array<\s*(?:f32|i32|u32|bool|f16|vec2<[^>]*>)\s*,/.test(wgsl)) {
      problems.push("emitted WGSL contains an array whose stride is below 16 bytes (illegal in var<uniform>; padding must be scalar members)");
    }
  }
  if (!(size > 0) || size % 16 !== 0) problems.push(`size ${size} is not a positive multiple of 16`);
  if (problems.length > 0) {
    failed++;
    console.error(`RENDERING_STRUCTS.${label}: ${problems.length} uniform-layout problem(s)`);
    for (const p of problems) console.error(`   ${p}`);
  } else {
    console.log(`RENDERING_STRUCTS.${label}: ${size} B, uniform layout ok`);
  }
}

if (failed > 0) {
  console.error(`\ncheck:wgsl FAILED (${failed} problem(s))`);
  process.exit(1);
}
console.log("\ncheck:wgsl passed (structural validation + strict uniform layout — a real GPU compile can still be stricter).");
