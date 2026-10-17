/**
 * Text layout: code points → positioned glyph quads, line boxes and caret positions.
 *
 * What it does: per-code-point layout with kerning, letter spacing, line height, explicit newlines,
 * word wrapping (break after spaces and hyphens, anywhere between CJK ideographs, and inside a word
 * that is longer than the line), character wrapping, `maxLines`, and clip or ellipsis overflow, with
 * per-line start/centre/end alignment inside the block. Font fallback is per code point across the
 * family's faces; a code point no face has is drawn as "?" from the first face and counted.
 *
 * What it does not do (docs/UI.md §11): shaping, ligatures, combining-mark positioning or
 * bidirectional reordering. Right-to-left text is laid out in logical order.
 *
 * Results are immutable and shared through `TextEngine`'s cache; never mutate one.
 */

import type { UIAtlasPage, UIFontFace } from "./font.js";
import type { TextAlign } from "../style/types.js";

export type WrapMode = "word" | "char" | "none";
export type TextOverflow = "visible" | "clip" | "ellipsis";

export interface TextLayoutParams {
  text: string;
  family: string;
  size: number;
  weight?: number;
  /** Wrap width (∞ = never wrap). */
  maxWidth?: number;
  wrap?: WrapMode;
  overflow?: TextOverflow;
  maxLines?: number;
  /** Line height as a multiple of `size`. */
  lineHeight?: number;
  letterSpacing?: number;
  align?: TextAlign;
}

export interface TextLine {
  /** Code-point range `[start, end)`; `end` excludes the trailing newline/space it broke at. */
  readonly start: number;
  readonly end: number;
  readonly width: number;
  /** Top of the line box relative to the block. */
  readonly y: number;
  /** Horizontal offset of the line inside the block (alignment). */
  readonly x: number;
}

export interface TextLayoutResult {
  readonly width: number;
  readonly height: number;
  readonly lineHeight: number;
  /** Baseline offset from a line's top. */
  readonly baseline: number;
  readonly lines: readonly TextLine[];
  readonly glyphCount: number;
  /** 8 floats per glyph: x, y, w, h (block space), u0, v0, u1, v1. */
  readonly glyphs: Float32Array;
  readonly glyphPages: readonly UIAtlasPage[];
  /** 1 = distance-field glyph, 0 = coverage mask. */
  readonly glyphSdf: Uint8Array;
  readonly weight: number;
  readonly codepoints: Uint32Array;
  /** Caret x for each code-point index 0..n (block space). */
  readonly caretX: Float32Array;
  /** Line index for each caret position 0..n. */
  readonly caretLine: Uint16Array;
  /** Text was cut by `maxLines`/`maxWidth` (ellipsis or clip). */
  readonly truncated: boolean;
  /** Code points with no glyph in any face of the family. */
  readonly missing: number;
}

export interface ResolvedGlyph {
  advance: number;
  x: number;
  y: number;
  width: number;
  height: number;
  u0: number;
  v0: number;
  u1: number;
  v1: number;
  page: UIAtlasPage | null;
  sdf: boolean;
  /** Metrics scale for this glyph's face at the requested size. */
  scale: number;
  face: UIFontFace;
}

const QUESTION = 63;
const ELLIPSIS = 0x2026;

function isSpace(cp: number): boolean {
  return cp === 32 || cp === 9 || cp === 0x3000 || cp === 0xa0;
}

function isBreakAfter(cp: number): boolean {
  return isSpace(cp) || cp === 45 /* - */ || cp === 0x2013 || cp === 0x2014 || cp === 47 /* / */;
}

/** CJK ideographs, kana and hangul allow a break between any two characters. */
export function isIdeographic(cp: number): boolean {
  return (cp >= 0x2e80 && cp <= 0x9fff) || (cp >= 0xac00 && cp <= 0xd7af) || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xff00 && cp <= 0xffef) || (cp >= 0x20000 && cp <= 0x2fa1f);
}

/** Synthetic-bold widening factor for an SDF face (fraction of the size added to each advance). */
export function boldness(weight: number): number {
  return Math.max(0, Math.min(1, (weight - 400) / 300));
}

export function layoutText(
  faces: readonly UIFontFace[],
  params: TextLayoutParams,
  resolveGlyph: (faces: readonly UIFontFace[], cp: number, size: number) => ResolvedGlyph | null,
): TextLayoutResult {
  const size = params.size;
  const weight = params.weight ?? 400;
  const maxWidth = params.maxWidth ?? Infinity;
  const wrap = params.wrap ?? (Number.isFinite(maxWidth) ? "word" : "none");
  const overflow = params.overflow ?? "visible";
  const maxLines = params.maxLines ?? Infinity;
  const lineHeight = size * (params.lineHeight ?? 1.25);
  const letterSpacing = params.letterSpacing ?? 0;
  const align = params.align ?? "start";
  const primary = faces[0]!;
  const primaryScale = size / primary.baseSize;
  const ascent = primary.ascent * primaryScale;
  const descent = primary.descent * primaryScale;
  const baseline = (lineHeight - (ascent + descent)) / 2 + ascent;
  const bold = boldness(weight) * 0.04 * size;

  const cps: number[] = [];
  for (const ch of params.text) cps.push(ch.codePointAt(0)!);
  const n = cps.length;
  const advance = new Float32Array(n);
  const resolved: (ResolvedGlyph | null)[] = new Array(n);
  let missing = 0;
  for (let i = 0; i < n; i++) {
    const cp = cps[i]!;
    if (cp === 10 || cp === 13) {
      resolved[i] = null;
      continue;
    }
    let g = resolveGlyph(faces, cp, size);
    if (!g) {
      missing++;
      g = resolveGlyph(faces, QUESTION, size);
    }
    resolved[i] = g;
    let adv = g ? g.advance * g.scale + letterSpacing + (g.sdf ? bold : 0) : 0;
    if (i + 1 < n && g && g.face === primary) adv += primary.kerning(cp, cps[i + 1]!) * primaryScale;
    advance[i] = adv;
  }

  // ---- line breaking: produce [start, end, nextStart] triples.
  const breaks: number[] = [];
  let lineStart = 0;
  let width = 0;
  let lastBreak = -1; // index after which we may break
  let widthAtBreak = 0;
  for (let i = 0; i < n; i++) {
    const cp = cps[i]!;
    if (cp === 10) {
      breaks.push(lineStart, i, i + 1);
      lineStart = i + 1;
      width = 0;
      lastBreak = -1;
      continue;
    }
    if (cp === 13) continue;
    const w = advance[i]!;
    // A line's visible width excludes the letter spacing after its last glyph (see "positions"),
    // so the fit test must too, or text laid out at exactly its measured width would not fit.
    const fits = width + w - letterSpacing <= maxWidth + 1e-4 || isSpace(cp) || i === lineStart;
    if (!fits && wrap !== "none") {
      if (wrap === "word" && lastBreak >= lineStart) {
        // Break after lastBreak; trailing spaces of the line are not counted.
        let end = lastBreak + 1;
        while (end > lineStart && isSpace(cps[end - 1]!)) end--;
        breaks.push(lineStart, end, lastBreak + 1);
        lineStart = lastBreak + 1;
        width = 0;
        for (let k = lineStart; k < i; k++) width += advance[k]!;
      } else {
        breaks.push(lineStart, i, i);
        lineStart = i;
        width = 0;
      }
      lastBreak = -1;
      widthAtBreak = 0;
    }
    width += w;
    if (isBreakAfter(cp) || isIdeographic(cp) || (i + 1 < n && isIdeographic(cps[i + 1]!))) {
      lastBreak = i;
      widthAtBreak = width;
    }
  }
  void widthAtBreak;
  breaks.push(lineStart, n, n);

  let lineCount = breaks.length / 3;
  let truncated = false;
  if (lineCount > maxLines) {
    lineCount = maxLines;
    truncated = true;
  }

  // ---- ellipsis / clip on the last kept line
  const lineEnds: number[] = [];
  for (let l = 0; l < lineCount; l++) lineEnds.push(breaks[l * 3 + 1]!);
  let ellipsisGlyph: ResolvedGlyph | null = null;
  const lastLine = lineCount - 1;
  const lineWidthOf = (s: number, e: number): number => {
    let w = 0;
    for (let k = s; k < e; k++) w += advance[k]!;
    return w;
  };
  if (lineCount > 0) {
    const ls = breaks[lastLine * 3]!;
    let le = lineEnds[lastLine]!;
    const overWide = lineWidthOf(ls, le) - letterSpacing > maxWidth + 1e-4;
    if ((truncated || overWide) && overflow === "ellipsis") {
      ellipsisGlyph = resolveGlyph(faces, ELLIPSIS, size) ?? resolveGlyph(faces, 46, size);
      const ew = ellipsisGlyph ? ellipsisGlyph.advance * ellipsisGlyph.scale : 0;
      while (le > ls && lineWidthOf(ls, le) + ew > maxWidth + 1e-4) le--;
      while (le > ls && isSpace(cps[le - 1]!)) le--;
      lineEnds[lastLine] = le;
      truncated = true;
    } else if (overWide && overflow === "clip") {
      while (le > ls && lineWidthOf(ls, le) - letterSpacing > maxWidth + 1e-4) le--;
      lineEnds[lastLine] = le;
      truncated = true;
    }
  }

  // ---- positions
  const lines: TextLine[] = [];
  let blockWidth = 0;
  const lineWidths: number[] = [];
  for (let l = 0; l < lineCount; l++) {
    let w = lineWidthOf(breaks[l * 3]!, lineEnds[l]!);
    // Trailing letter spacing is not part of the visible width; an ellipsis ends the line itself
    // (it carries no spacing), so the last glyph's spacing before it is visible.
    if (l === lastLine && ellipsisGlyph) w += ellipsisGlyph.advance * ellipsisGlyph.scale;
    else if (w > 0 && letterSpacing !== 0) w -= letterSpacing;
    lineWidths.push(w);
    blockWidth = Math.max(blockWidth, w);
  }
  // Lines align within the block (the widest line); placing the block inside its box is the
  // painter's job, so a centred label still *measures* as wide as its text, not its container.
  const alignWidth = blockWidth;

  const caretX = new Float32Array(n + 1);
  const caretLine = new Uint16Array(n + 1);
  const glyphData: number[] = [];
  const pages: UIAtlasPage[] = [];
  const sdfFlags: number[] = [];
  const pushGlyph = (g: ResolvedGlyph, penX: number, top: number): void => {
    if (!g.page || g.width <= 0 || g.height <= 0) return;
    glyphData.push(penX + g.x * g.scale, top + baseline + g.y * g.scale, g.width * g.scale, g.height * g.scale, g.u0, g.v0, g.u1, g.v1);
    pages.push(g.page);
    sdfFlags.push(g.sdf ? 1 : 0);
  };
  for (let l = 0; l < lineCount; l++) {
    const s = breaks[l * 3]!;
    const e = lineEnds[l]!;
    const top = l * lineHeight;
    const lw = lineWidths[l]!;
    const x0 = align === "center" ? (alignWidth - lw) / 2 : align === "end" ? alignWidth - lw : 0;
    lines.push({ start: s, end: e, width: lw, y: top, x: x0 });
    let pen = x0;
    for (let i = s; i < e; i++) {
      caretX[i] = pen;
      caretLine[i] = l;
      const g = resolved[i];
      if (g) pushGlyph(g, pen, top);
      pen += advance[i]!;
    }
    caretX[e] = pen;
    caretLine[e] = l;
    if (l === lastLine && ellipsisGlyph) pushGlyph(ellipsisGlyph, pen, top);
    // Characters consumed by the break (spaces, newline) sit at the line end.
    const nextStart = l + 1 < lineCount ? breaks[(l + 1) * 3]! : truncated ? n : breaks[l * 3 + 2]!;
    for (let i = e + 1; i <= Math.min(nextStart, n); i++) {
      if (i < nextStart || l === lineCount - 1) {
        caretX[i] = pen;
        caretLine[i] = l;
      }
    }
  }
  if (lineCount === 0) caretX[0] = 0;

  const glyphs = new Float32Array(glyphData);
  return {
    width: alignWidth,
    height: Math.max(1, lineCount) * lineHeight,
    lineHeight,
    baseline,
    lines,
    glyphCount: pages.length,
    glyphs,
    glyphPages: pages,
    glyphSdf: new Uint8Array(sdfFlags),
    weight,
    codepoints: Uint32Array.from(cps),
    caretX,
    caretLine,
    truncated,
    missing,
  };
}

/** Code-point index nearest to (x, y) in block space (caret placement from a pointer). */
export function hitTestText(layout: TextLayoutResult, x: number, y: number): number {
  const n = layout.codepoints.length;
  if (layout.lines.length === 0) return 0;
  const lineIndex = Math.max(0, Math.min(layout.lines.length - 1, Math.floor(y / layout.lineHeight)));
  const line = layout.lines[lineIndex]!;
  let best = line.start;
  let bestD = Infinity;
  for (let i = line.start; i <= line.end && i <= n; i++) {
    const d = Math.abs(layout.caretX[i]! - x);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}
