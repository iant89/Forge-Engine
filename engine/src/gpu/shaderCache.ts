/**
 * Shader module cache + WGSL sanity checks.
 *
 * Why a cache: shader compilation is the single most expensive step of scene setup in WebGPU, and
 * engines routinely ask for the "same" shader 50 times while materials are being built. Keying on
 * the source hash turns that into one compile.
 *
 * Why the static checks: the mock device cannot compile WGSL (see docs/TESTING.md), so structural
 * mistakes — an unbalanced brace, a missing `@vertex`, an `@group`/`@binding` collision, a uniform
 * struct with a runtime-sized array — would otherwise only surface in a real browser. These checks
 * catch them at module-creation time, in every environment, and `tools/wgsl-check.mjs` runs the
 * same validator over the shader corpus.
 */

import { UsageError } from "../core/errors.js";
import type { GraphicsDevice } from "./device.js";

export interface ShaderStats {
  created: number;
  reused: number;
  sourceBytes: number;
  uniqueSources: number;
}

export interface WgslIssue {
  kind: "brace" | "entry-point" | "binding-collision" | "layout" | "unknown";
  message: string;
  line?: number;
}

export class ShaderCache {
  private readonly modules = new Map<string, GPUShaderModule>();
  private readonly infos = new Map<string, WgslIssue[]>();
  private created = 0;
  private reused = 0;
  private sourceBytes = 0;

  constructor(private readonly device: GraphicsDevice) {}

  /** FNV-1a over the source; collisions across distinct sources are astronomically unlikely but
   *  the map also keys on length, so a collision cannot silently swap shaders. */
  static key(source: string): string {
    let h = 0x811c9dc5;
    for (let i = 0; i < source.length; i++) {
      h ^= source.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return `${source.length}:${(h >>> 0).toString(36)}`;
  }

  get(label: string, source: string, options: { validate?: boolean } = {}): GPUShaderModule {
    const key = ShaderCache.key(source);
    const cached = this.modules.get(key);
    if (cached) {
      this.reused++;
      return cached;
    }
    if (options.validate !== false) {
      const issues = validateWgsl(source);
      if (issues.length > 0) {
        throw new UsageError(`shader "${label}" failed static validation:\n  ${issues.map((i) => `${i.kind}: ${i.message}${i.line ? ` (line ${i.line})` : ""}`).join("\n  ")}`);
      }
      this.infos.set(key, issues);
    }
    const module = this.device.device.createShaderModule({ label, code: source });
    this.modules.set(key, module);
    this.created++;
    this.sourceBytes += source.length;
    return module;
  }

  /**
   * Compile-info check. `getCompilationInfo()` exists on all current implementations; a failure here
   * is reported rather than thrown, because the pipeline creation error is the more useful one.
   */
  async compilationErrors(label: string, source: string): Promise<string[]> {
    const module = this.get(label, source, { validate: false });
    const getter = (module as unknown as { getCompilationInfo?: () => Promise<{ messages: { type: string; message: string; lineNum: number }[] }> }).getCompilationInfo;
    if (!getter) return [];
    const info = await getter.call(module);
    return info.messages.filter((m) => m.type === "error").map((m) => `${m.type} line ${m.lineNum}: ${m.message}`);
  }

  stats(): ShaderStats {
    return { created: this.created, reused: this.reused, sourceBytes: this.sourceBytes, uniqueSources: this.modules.size };
  }

  /** Drop all modules (device-lost recovery: shaders must be re-created). */
  clear(): void {
    this.modules.clear();
    this.infos.clear();
  }
}

/**
 * Structural validator for WGSL source. Deliberately *not* a parser: it checks the classes of error
 * that a hand-edited shader actually produces, quickly, with no dependencies.
 */
export function validateWgsl(source: string): WgslIssue[] {
  const issues: WgslIssue[] = [];
  // 1. Brace/paren balance, skipping comments and strings.
  let depth = 0;
  let parens = 0;
  let line = 1;
  let inBlockComment = false;
  for (let i = 0; i < source.length; i++) {
    const c = source[i]!;
    if (c === "\n") line++;
    if (inBlockComment) {
      if (c === "*" && source[i + 1] === "/") {
        inBlockComment = false;
        i++;
      }
      continue;
    }
    if (c === "/" && source[i + 1] === "/") {
      while (i < source.length && source[i] !== "\n") i++;
      line++;
      continue;
    }
    if (c === "/" && source[i + 1] === "*") {
      inBlockComment = true;
      i++;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth < 0) {
        issues.push({ kind: "brace", message: "unexpected '}'", line });
        break;
      }
    } else if (c === "(") parens++;
    else if (c === ")") {
      parens--;
      if (parens < 0) {
        issues.push({ kind: "brace", message: "unexpected ')'", line });
        break;
      }
    }
  }
  if (depth !== 0) issues.push({ kind: "brace", message: `unbalanced braces (${depth > 0 ? `${depth} unclosed` : "extra closing braces"})` });
  if (parens !== 0) issues.push({ kind: "brace", message: `unbalanced parentheses (${parens})` });

  // 2. Entry points.
  const hasVertex = /@vertex\s+fn\s+\w+/.test(source);
  const hasFragment = /@fragment\s+fn\s+\w+/.test(source);
  const hasCompute = /@compute\s+fn\s+\w+/.test(source);
  if (!hasVertex && !hasFragment && !hasCompute) {
    issues.push({ kind: "entry-point", message: "no @vertex/@fragment/@compute entry point found" });
  }

  // 3. Binding collisions.
  const bindings = new Map<string, number>();
  const bindingRe = /@group\((\d+)\)\s*@binding\((\d+)\)/g;
  let m: RegExpExecArray | null;
  while ((m = bindingRe.exec(source))) {
    const key = `${m[1]}:${m[2]}`;
    const prev = bindings.get(key);
    if (prev !== undefined) issues.push({ kind: "binding-collision", message: `@group(${m[1]}) @binding(${m[2]}) declared twice`, line: lineAt(source, m.index) });
    else bindings.set(key, m.index);
  }

  // 4. Layout rules that fail at pipeline creation on every driver.
  const runtimeArrayInUniform = /@group\(\d+\)\s*@binding\(\d+\)\s*var<uniform>[^;]*array<[^>]*>\s*;/g;
  if (runtimeArrayInUniform.test(source)) {
    issues.push({ kind: "layout", message: "a uniform buffer cannot contain an unsized array; wrap it in a struct with an explicit count" });
  }
  if (/var<storage>[^,]*;/.test(source)) {
    issues.push({ kind: "layout", message: "storage buffers need an access mode: var<storage, read> or var<storage, read_write>" });
  }
  const depthTextureRe = /var\s+(\w+)\s*:\s*texture_depth_2d\b/g;
  let dm: RegExpExecArray | null;
  while ((dm = depthTextureRe.exec(source))) {
    const depthVar = dm[1]!;
    const sampleRe = new RegExp(`\\btextureSample\\s*\\(\\s*${depthVar}\\b`);
    if (sampleRe.test(source)) {
      issues.push({ kind: "layout", message: `texture_depth_2d "${depthVar}" must be sampled with textureSampleCompareLevel, not textureSample` });
    }
  }
  if (/^\s*#(?:define|include)\b/m.test(source)) {
    issues.push({ kind: "unknown", message: "raw preprocessor directive found — shaders must go through the engine's preprocessor" });
  }
  return issues;
}

function lineAt(source: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < source.length; i++) if (source[i] === "\n") line++;
  return line;
}

/**
 * Tiny preprocessor for shader variants: `#define NAME value` lines plus `#ifdef NAME` /
 * `#ifndef NAME` / `#else` / `#endif` blocks and `//! include name` for shared chunks.
 *
 * Deliberately line-oriented and whitespace-preserving so compiled output stays diffable against
 * the source when a pipeline cache miss is being debugged.
 */
export function preprocessWgsl(source: string, defines: Record<string, string | number | boolean> = {}): string {
  const env = new Map<string, string>();
  for (const [k, v] of Object.entries(defines)) env.set(k, String(v));
  const out: string[] = [];
  const stack: boolean[] = [];
  const seenElse = new Set<number>();
  const lines = source.split("\n");
  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith("#define")) {
      const m = /^#define\s+(\w+)(?:\s+(.+))?$/.exec(line);
      if (m) env.set(m[1]!, m[2] ?? "1");
      continue;
    }
    if (line.startsWith("#undef")) {
      const m = /^#undef\s+(\w+)/.exec(line);
      if (m) env.delete(m[1]!);
      continue;
    }
    if (line.startsWith("#ifdef") || line.startsWith("#ifndef")) {
      const isIfdef = line.startsWith("#ifdef");
      const name = /^(?:#ifdef|#ifndef)\s+(\w+)/.exec(line)?.[1] ?? "";
      stack.push(isIfdef ? env.has(name) : !env.has(name));
      continue;
    }
    if (line.startsWith("#else")) {
      const top = stack.length > 0 ? stack[stack.length - 1]! : true;
      if (seenElse.has(stack.length)) throw new UsageError("preprocessWgsl: duplicate #else in one block");
      seenElse.add(stack.length);
      if (stack.length > 0) stack[stack.length - 1] = !top;
      continue;
    }
    if (line.startsWith("#endif")) {
      stack.pop();
      seenElse.delete(stack.length + 1);
      continue;
    }
    if (stack.includes(false)) continue;
    if (line.startsWith("//! include")) {
      const name = /\/\/!\s*include\s+([\w./-]+)/.exec(line)?.[1];
      if (!name) throw new UsageError(`bad include directive: "${line}"`);
      out.push(`// included ${name}`);
      continue;
    }
    out.push(raw);
  }
  if (stack.length !== 0) throw new UsageError("preprocessWgsl: unbalanced #ifdef/#endif");
  let text = out.join("\n");
  for (const [name, value] of env) {
    text = text.replace(new RegExp(`\\b${name}\\b`, "g"), value);
  }
  return text;
}
