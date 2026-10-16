/**
 * `TextEngine` — font families, glyph fallback and the text-layout cache.
 *
 * Families are named fallback chains of faces (`"default"` is always defined and starts with the
 * built-in Forge Sans SDF face). `layout()` is memoised by every input that affects the result, in an
 * LRU bounded by `maxEntries`; hits, misses and evictions are counted for diagnostics. Widgets keep
 * their own last result and only call `layout()` when their text, width or style changed, so a static
 * screen does no text work at all.
 *
 * `textScale` is the accessibility text-size multiplier: every size passed to `layout` is multiplied
 * by it, so changing it (and invalidating layout, which the manager does) reflows all text.
 */

import { UsageError } from "../../core/errors.js";
import { ForgeSansFace, type UIAtlasPage, type UIFontFace } from "./font.js";
import { layoutText, type ResolvedGlyph, type TextLayoutParams, type TextLayoutResult } from "./textLayout.js";

export interface TextEngineStats {
  layouts: number;
  hits: number;
  misses: number;
  evictions: number;
  entries: number;
  missingGlyphs: number;
}

export class TextEngine {
  private readonly families = new Map<string, UIFontFace[]>();
  private readonly cache = new Map<string, TextLayoutResult>();
  maxEntries: number;
  textScale = 1;
  readonly stats: TextEngineStats = { layouts: 0, hits: 0, misses: 0, evictions: 0, entries: 0, missingGlyphs: 0 };
  readonly builtin: ForgeSansFace;

  constructor(options: { maxEntries?: number; builtin?: ForgeSansFace } = {}) {
    this.maxEntries = options.maxEntries ?? 1024;
    this.builtin = options.builtin ?? new ForgeSansFace();
    this.families.set("default", [this.builtin]);
  }

  /** Define (or replace) a family as an ordered fallback chain. */
  defineFamily(name: string, faces: readonly UIFontFace[]): void {
    if (faces.length === 0) throw new UsageError(`ui text: family "${name}" needs at least one face`);
    this.families.set(name, [...faces]);
    this.clearCache();
  }

  /** Append a fallback face to a family (e.g. a runtime rasteriser for scripts the SDF font lacks). */
  addFallback(family: string, face: UIFontFace): void {
    const chain = this.families.get(family);
    if (!chain) throw new UsageError(`ui text: unknown font family "${family}"`);
    chain.push(face);
    this.clearCache();
  }

  hasFamily(name: string): boolean {
    return this.families.has(name);
  }

  faces(family: string): readonly UIFontFace[] {
    return this.families.get(family) ?? this.families.get("default")!;
  }

  /** Every atlas page any family can draw from (the GPU backend uploads these). */
  pages(): UIAtlasPage[] {
    const out = new Set<UIAtlasPage>();
    for (const chain of this.families.values()) for (const f of chain) {
      const p = (f as { page?: UIAtlasPage }).page;
      if (p) out.add(p);
    }
    return [...out];
  }

  clearCache(): void {
    this.cache.clear();
    this.stats.entries = 0;
  }

  private resolveGlyph = (faces: readonly UIFontFace[], cp: number, size: number): ResolvedGlyph | null => {
    for (const face of faces) {
      const g = face.glyph(cp);
      if (!g) continue;
      // A fresh object per glyph: layoutText keeps them in an array during one layout.
      return { ...g, scale: size / face.baseSize, face };
    }
    return null;
  };

  /** Lay out text (memoised). Sizes are multiplied by `textScale`. */
  layout(params: TextLayoutParams): TextLayoutResult {
    this.stats.layouts++;
    const size = params.size * this.textScale;
    const key = `${params.family}\u0001${size}\u0001${params.weight ?? 400}\u0001${params.maxWidth ?? Infinity}\u0001${params.wrap ?? ""}\u0001${params.overflow ?? ""}\u0001${params.maxLines ?? ""}\u0001${params.lineHeight ?? ""}\u0001${params.letterSpacing ?? 0}\u0001${params.align ?? ""}\u0001${params.text}`;
    const hit = this.cache.get(key);
    if (hit) {
      // LRU refresh.
      this.cache.delete(key);
      this.cache.set(key, hit);
      this.stats.hits++;
      return hit;
    }
    this.stats.misses++;
    const faces = this.faces(params.family);
    const result = layoutText(faces, size === params.size ? params : { ...params, size }, this.resolveGlyph);
    this.stats.missingGlyphs += result.missing;
    if (this.cache.size >= this.maxEntries) {
      const oldest = this.cache.keys().next().value as string;
      this.cache.delete(oldest);
      this.stats.evictions++;
    }
    this.cache.set(key, result);
    this.stats.entries = this.cache.size;
    return result;
  }

  /** Width/height of a single line of text without wrapping. */
  measure(text: string, family: string, size: number, weight = 400): { width: number; height: number } {
    const r = this.layout({ text, family, size, weight, wrap: "none" });
    return { width: r.width, height: r.height };
  }
}
