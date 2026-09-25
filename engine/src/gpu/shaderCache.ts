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
 * same validator over the shader corpus. The validator also applies the uniform address-space
 * layout rules that WebKit enforces and Chromium relaxes, plus the `smoothstep` edge-order rule
 * that strict compilers enforce at module creation, so a shader that only compiles in Chrome
 * is rejected here before it ever reaches a device.
 *
 * Why compile info is reported: `createShaderModule` never throws. A module that fails to compile
 * is only visible through `getCompilationInfo()` or a later pipeline-creation error, and on a phone
 * neither reaches anyone. Every module created here has its compile messages routed to the device's
 * error log, so a compiler rejection shows up in `engine.stats().lastError` and the HUD.
 */

import { UsageError } from "../core/errors.js";
import { alignUp } from "../math/scalar.js";
import type { GraphicsDevice } from "./device.js";

export interface ShaderStats {
  created: number;
  reused: number;
  sourceBytes: number;
  uniqueSources: number;
}

export interface WgslIssue {
  kind: "brace" | "entry-point" | "binding-collision" | "layout" | "semantics" | "unknown";
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
    this.reportCompilationInfo(label, module);
    return module;
  }

  /**
   * Forward compiler diagnostics to the device's error log. Fire-and-forget: the module is usable
   * (or not) regardless, and the report is what makes a WebKit-only compile failure diagnosable
   * from the page itself. Devices without `getCompilationInfo` (the mock) are skipped.
   */
  private reportCompilationInfo(label: string, module: GPUShaderModule): void {
    const getter = (module as unknown as { getCompilationInfo?: () => Promise<GPUCompilationInfo> }).getCompilationInfo;
    if (typeof getter !== "function") return;
    let info: Promise<GPUCompilationInfo>;
    try {
      info = getter.call(module);
    } catch {
      return;
    }
    void info.then(
      (result) => {
        for (const message of result.messages) {
          const text = `shader "${label}" line ${message.lineNum}:${message.linePos}: ${message.message}`;
          if (message.type === "error") this.device.recordError("shader compile", text);
          else this.device.logger?.warn(`gpu: shader compile ${message.type}: ${text}`);
        }
      },
      () => {
        /* the compile-info promise rejecting is not itself a shader error */
      },
    );
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

  issues.push(...reversedSmoothstepIssues(source));
  issues.push(...reservedWordIssues(source));

  // 5. Uniform address-space layout. Chromium's compiler tolerates arrays with a stride below 16
  //    bytes (and other relaxed layouts) inside `var<uniform>` structs; WebKit rejects the module,
  //    which is a black canvas on Safari with nothing in the page to say why. Apply the strict rules
  //    everywhere so the strictest browser is the one that decides what ships.
  issues.push(...uniformLayoutIssues(source));
  return issues;
}

// --------------------------------------------------------------------------- uniform layout rules

interface WgslMember {
  name: string;
  type: string;
  /** Explicit `@align(n)` / `@size(n)` attributes, when present. */
  align?: number;
  size?: number;
}

interface WgslLayout {
  size: number;
  align: number;
}

/**
 * Reversed-edge `smoothstep(low, high, x)` with `low >= high`. The WGSL spec makes the result
 * indeterminate and strict compilers (Tint in older Chromium, WebKit) reject the module outright
 * at `createShaderModule` — which is exactly the "particle scenes fail in CI's browser gate while
 * newer Chromium shrugs it off" class of failure. GLSL tolerated the reversed idiom as
 * `1.0 - smoothstep(high, low, x)`, so the fix is mechanical. Only literal numeric edges can be
 * decided here (identifier/computed edges are runtime values, not a static error); comments are
 * blanked with their newlines preserved so reported lines match the source.
 */
export function reversedSmoothstepIssues(source: string): WgslIssue[] {
  const num = String.raw`[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?`;
  const re = new RegExp(String.raw`\bsmoothstep\s*\(\s*(${num})\s*,\s*(${num})\s*,`, "g");
  const cleaned = source.replace(/\/\*[\s\S]*?\*\//g, (s) => s.replace(/[^\n]/g, " ")).replace(/\/\/[^\n]*/g, " ");
  const issues: WgslIssue[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(cleaned))) {
    const low = Number(m[1]);
    const high = Number(m[2]);
    if (!Number.isFinite(low) || !Number.isFinite(high) || low < high) continue;
    issues.push({
      kind: "semantics",
      message:
        `smoothstep(${m[1]}, ${m[2]}, …) has low >= high, which strict WGSL compilers reject (the result is unspecified where they do not); ` +
        `write a reversed falloff as 1.0 - smoothstep(${m[2]}, ${m[1]}, x)`,
      line: lineAt(cleaned, m.index),
    });
  }
  return issues;
}

/**
 * WGSL words the specification reserves but the language does not use. Tint rejects a module that
 * names one at parse time — `'meta' is a reserved keyword` — so every pipeline built from it comes
 * back invalid, every frame that used one fails to submit, and the mock device reports nothing
 * because it never compiles a shader. They are held for future language features, so nothing about
 * them looks illegal to a reader: `meta`, `resource`, `template`, `cast`, `handle`, `shared`,
 * `module`, `type`. The Phase 13.3 cluster grid called its per-cluster (offset, count) array `meta`
 * and only the browser gate saw it.
 *
 * Deliberately excludes the words WGSL *does* use — `struct`, `let`, `var`, `fn`, `uniform`,
 * `storage`, `read`, `override`, the vector/matrix type names — and `f16`, which is a real type once
 * the extension is enabled. Attribute spellings (`@align`, `@invariant`) are skipped by the scan.
 */
export const WGSL_RESERVED_WORDS: readonly string[] = [
  "NULL", "Self", "abstractFloat", "abstractInt", "abstractNumeric", "align", "as", "asm", "assert",
  "asynchronous", "cast", "catch", "class", "const_cast", "consteval", "constexpr", "constinit",
  "delete", "do", "dynamic_cast", "enum", "explicit", "export", "extends", "fallthrough", "fixme",
  "friend", "from", "goto", "groupshared", "handle", "highp", "i64", "implements", "import",
  "inline", "interface", "invariant", "iterator", "layout", "lowp", "macro", "matrix", "mediump",
  "meta", "module", "mut", "mutable", "namespace", "new", "noinline", "nullptr", "offsetof",
  "operator", "or", "partition", "precision", "premerge", "protected", "public", "readonly",
  "reinterpret_cast", "requires", "resource", "restrict", "samper", "self", "shared", "signed",
  "sizeof", "smooth", "static", "static_assert", "static_cast", "storage_buffer", "super", "superp",
  "target", "template", "this", "throw", "try", "type", "typedef", "typename", "u64", "union",
  "unless", "unsigned", "using", "vec1", "vec5", "vec6", "vector", "virtual", "void", "volatile",
  "weak", "wgsl", "yield",
];

const RESERVED_WORD_SET: ReadonlySet<string> = new Set(WGSL_RESERVED_WORDS);

/**
 * Reserved words used as identifiers — struct members, locals, globals, function names. Comments are
 * blanked with their newlines kept, so a reported line is the line the identifier is really on, and a
 * prose mention of a reserved word is not an error.
 */
export function reservedWordIssues(source: string): WgslIssue[] {
  const cleaned = source.replace(/\/\*[\s\S]*?\*\//g, (s) => s.replace(/[^\n]/g, " ")).replace(/\/\/[^\n]*/g, " ");
  const issues: WgslIssue[] = [];
  const re = /(^|[^A-Za-z0-9_])([A-Za-z_][A-Za-z0-9_]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(cleaned))) {
    const word = m[2]!;
    if (m[1] === "@" || !RESERVED_WORD_SET.has(word)) continue;
    issues.push({
      kind: "semantics",
      message: `'${word}' is a reserved WGSL keyword and cannot be an identifier (Tint rejects the module at parse time)`,
      line: lineAt(cleaned, m.index + (m[1] === "" ? 0 : 1)),
    });
  }
  return issues;
}

/** Strip line and block comments so member parsing does not trip over prose. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, "");
}

/** Split `a, b<c, d>, e` on top-level commas (angle brackets and parentheses nest). */
function splitTopLevel(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === "<" || c === "(") depth++;
    else if (c === ">" || c === ")") depth--;
    else if (c === "," && depth === 0) {
      out.push(text.slice(start, i));
      start = i + 1;
    }
  }
  out.push(text.slice(start));
  return out.map((s) => s.trim()).filter((s) => s.length > 0);
}

function parseStructs(source: string): Map<string, WgslMember[]> {
  const structs = new Map<string, WgslMember[]>();
  const re = /\bstruct\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{([^}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source))) {
    const members: WgslMember[] = [];
    for (const piece of splitTopLevel(m[2]!)) {
      const member: WgslMember = { name: "", type: "" };
      const withoutAttrs = piece.replace(/@([A-Za-z_]+)(?:\(([^)]*)\))?/g, (_all, attr: string, arg: string | undefined) => {
        if (attr === "align" && arg) member.align = Number(arg);
        if (attr === "size" && arg) member.size = Number(arg);
        return " ";
      });
      const parts = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:\s*([\s\S]+?)\s*$/.exec(withoutAttrs);
      if (!parts) continue;
      member.name = parts[1]!;
      member.type = parts[2]!.replace(/\s+/g, "");
      members.push(member);
    }
    structs.set(m[1]!, members);
  }
  return structs;
}

const SCALAR_BYTES: Record<string, number> = { f32: 4, i32: 4, u32: 4, bool: 4, f16: 2 };

/**
 * Natural (non-uniform) layout of a WGSL type string, per the WGSL "Alignment and Size" table.
 * Returns `null` for types it does not know how to lay out (textures, pointers, undeclared structs),
 * which simply exempts them from the check.
 */
function layoutOf(type: string, structs: Map<string, WgslMember[]>, seen: Set<string> = new Set()): WgslLayout | null {
  const scalar = SCALAR_BYTES[type];
  if (scalar !== undefined) return { size: scalar, align: scalar };
  let m = /^vec([234])<(\w+)>$/.exec(type);
  if (m) {
    const n = Number(m[1]);
    const s = SCALAR_BYTES[m[2]!];
    if (s === undefined) return null;
    return n === 3 ? { size: 3 * s, align: 4 * s } : { size: n * s, align: n * s };
  }
  m = /^mat([234])x([234])<(\w+)>$/.exec(type);
  if (m) {
    const column = layoutOf(`vec${m[2]}<${m[3]}>`, structs, seen);
    if (!column) return null;
    const stride = alignUp(column.size, column.align);
    return { size: Number(m[1]) * stride, align: column.align };
  }
  m = /^array<([\s\S]+?)(?:,(\d+))?>$/.exec(type);
  if (m) {
    const element = layoutOf(m[1]!, structs, seen);
    if (!element) return null;
    const stride = alignUp(element.size, element.align);
    return { size: stride * Number(m[2] ?? 1), align: element.align };
  }
  const members = structs.get(type);
  if (!members || seen.has(type)) return null;
  seen.add(type);
  let offset = 0;
  let align = 1;
  for (const member of members) {
    const l = layoutOf(member.type, structs, seen);
    if (!l) {
      seen.delete(type);
      return null;
    }
    const memberAlign = Math.max(l.align, member.align ?? 0);
    offset = alignUp(offset, memberAlign) + (member.size ?? l.size);
    align = Math.max(align, memberAlign);
  }
  seen.delete(type);
  return { size: alignUp(offset, align), align };
}

/** `RequiredAlignOf(T, uniform)`: arrays and structs round up to 16, everything else is natural. */
function requiredUniformAlign(type: string, natural: number, structs: Map<string, WgslMember[]>): number {
  return type.startsWith("array<") || structs.has(type) ? Math.max(16, natural) : natural;
}

/**
 * The uniform-space constraints from WGSL "Address Space Layout Constraints", applied to every
 * `var<uniform>` store type: array strides are multiples of 16, array/struct members start at
 * multiples of 16, and a struct-typed member leaves roundUp(16, size) bytes before its successor.
 */
function uniformLayoutIssues(rawSource: string): WgslIssue[] {
  const source = stripComments(rawSource);
  const structs = parseStructs(source);
  const issues: WgslIssue[] = [];
  const reported = new Set<string>();
  const report = (message: string): void => {
    if (reported.has(message)) return;
    reported.add(message);
    issues.push({ kind: "layout", message });
  };

  const check = (type: string, path: string, visiting: Set<string>): void => {
    const arr = /^array<([\s\S]+?)(?:,(\d+))?>$/.exec(type);
    if (arr) {
      const element = arr[1]!;
      const l = layoutOf(element, structs);
      if (!l) return;
      const stride = alignUp(l.size, l.align);
      if (stride % 16 !== 0) {
        report(
          `${path}: ${type} has a ${stride}-byte element stride; arrays in the uniform address space need a multiple of 16 (WebKit rejects this shader, Chromium only accepts it via uniform_buffer_standard_layout). Use vec4 elements, a 16-byte struct, or individual scalar members.`,
        );
      }
      check(element, `${path}[]`, visiting);
      return;
    }
    const members = structs.get(type);
    if (!members || visiting.has(type)) return;
    visiting.add(type);
    let offset = 0;
    let previous: { name: string; type: string; end: number; padTo: number } | null = null;
    for (const member of members) {
      const l = layoutOf(member.type, structs);
      if (!l) {
        visiting.delete(type);
        return;
      }
      const memberAlign = Math.max(l.align, member.align ?? 0);
      offset = alignUp(offset, memberAlign);
      const required = requiredUniformAlign(member.type, memberAlign, structs);
      if (offset % required !== 0) {
        report(`${path}: member ${type}.${member.name} is at byte ${offset}, but ${member.type} members in the uniform address space must start at a multiple of ${required}`);
      }
      if (previous && offset < previous.padTo) {
        report(`${path}: member ${type}.${member.name} starts at byte ${offset}; the struct member ${previous.name} before it must be followed by at least ${previous.padTo - previous.end} bytes of padding in the uniform address space`);
      }
      check(member.type, `${path}.${member.name}`, visiting);
      const size = member.size ?? l.size;
      previous = structs.has(member.type) ? { name: member.name, type: member.type, end: offset + size, padTo: offset + alignUp(size, 16) } : null;
      offset += size;
    }
    visiting.delete(type);
  };

  const uniformRe = /var\s*<\s*uniform\s*>\s*([A-Za-z_][A-Za-z0-9_]*)\s*:\s*([^;]+);/g;
  let m: RegExpExecArray | null;
  while ((m = uniformRe.exec(source))) {
    const type = m[2]!.replace(/\s+/g, "");
    check(type, `var<uniform> ${m[1]}`, new Set());
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
