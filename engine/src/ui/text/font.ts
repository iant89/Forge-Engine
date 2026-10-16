/**
 * Fonts: glyph sources, atlas pages and fallback chains.
 *
 * A `UIFontFace` answers "what does code point X look like": advance, box relative to the pen on the
 * baseline, and where its pixels are in an atlas page. Faces are tried in a family's fallback order,
 * so a family can be the built-in SDF face first and a runtime-rasterised face (any script the
 * platform can draw) second. Metrics are given at the face's `baseSize`; layout scales them by
 * `size / baseSize`.
 *
 * Atlas pages are CPU-side pixel arrays with a version counter. The GPU backend uploads a page when its
 * version changes (only the dirty rows), so a face can add glyphs at runtime without the renderer
 * knowing anything about fonts.
 */

import {
  FORGE_SANS_ASCENT,
  FORGE_SANS_ATLAS_BASE64,
  FORGE_SANS_ATLAS_HEIGHT,
  FORGE_SANS_ATLAS_WIDTH,
  FORGE_SANS_BASE_SIZE,
  FORGE_SANS_DESCENT,
  FORGE_SANS_GLYPHS,
  FORGE_SANS_KERNING,
  FORGE_SANS_SPREAD,
} from "./builtinFont.js";

/** CPU pixel data the GPU backend mirrors into a texture. */
export class UIAtlasPage {
  /** Bumped on every change; the backend re-uploads rows `[dirtyY0, dirtyY1)`. */
  version = 1;
  dirtyY0 = 0;
  dirtyY1: number;

  constructor(
    readonly name: string,
    readonly width: number,
    readonly height: number,
    readonly format: "r8unorm" | "rgba8unorm",
    readonly data: Uint8Array,
  ) {
    const bpp = format === "r8unorm" ? 1 : 4;
    if (data.length !== width * height * bpp) throw new Error(`UIAtlasPage ${name}: data is ${data.length} bytes, expected ${width * height * bpp}`);
    this.dirtyY1 = height;
  }

  /** Mark rows changed (merged with any pending range). */
  touch(y0: number, y1: number): void {
    if (this.dirtyY1 <= this.dirtyY0) {
      this.dirtyY0 = y0;
      this.dirtyY1 = y1;
    } else {
      this.dirtyY0 = Math.min(this.dirtyY0, y0);
      this.dirtyY1 = Math.max(this.dirtyY1, y1);
    }
    this.version++;
  }

  /** Called by the backend after uploading. */
  clearDirty(): void {
    this.dirtyY0 = 0;
    this.dirtyY1 = 0;
  }
}

export interface GlyphInfo {
  /** Pen advance at the face's base size. */
  advance: number;
  /** Box relative to the pen position on the baseline (+y down), at base size. Zero size = no ink. */
  x: number;
  y: number;
  width: number;
  height: number;
  u0: number;
  v0: number;
  u1: number;
  v1: number;
  page: UIAtlasPage | null;
  /** Distance-field glyph (resolution independent) vs. coverage mask (rasterised at one size). */
  sdf: boolean;
}

export interface UIFontFace {
  readonly name: string;
  readonly baseSize: number;
  /** Distance range in base pixels (SDF faces). */
  readonly spread: number;
  readonly ascent: number;
  readonly descent: number;
  glyph(codepoint: number): GlyphInfo | null;
  kerning(left: number, right: number): number;
}

function decodeBase64(b64: string): Uint8Array {
  if (typeof atob === "function") {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  const B = (globalThis as { Buffer?: { from(s: string, enc: string): Uint8Array } }).Buffer;
  if (!B) throw new Error("no base64 decoder available");
  return new Uint8Array(B.from(b64, "base64"));
}

function decodeRle(rle: Uint8Array, size: number): Uint8Array {
  const out = new Uint8Array(size);
  let o = 0;
  for (let i = 0; i < rle.length; i++) {
    const v = rle[i]!;
    if (v === 0) {
      o += rle[++i]!;
    } else out[o++] = v;
  }
  if (o !== size) throw new Error(`built-in font atlas decoded to ${o} texels, expected ${size}`);
  return out;
}

/** The built-in "Forge Sans" SDF face (DejaVu Sans derived; see FONT-LICENSE.md). */
export class ForgeSansFace implements UIFontFace {
  readonly name = "Forge Sans";
  readonly baseSize = FORGE_SANS_BASE_SIZE;
  readonly spread = FORGE_SANS_SPREAD;
  readonly ascent = FORGE_SANS_ASCENT;
  readonly descent = FORGE_SANS_DESCENT;
  readonly page: UIAtlasPage;
  private readonly glyphs = new Map<number, GlyphInfo>();
  private readonly kern = new Map<number, number>();

  constructor(pageName = "ui.font.forge-sans") {
    const w = FORGE_SANS_ATLAS_WIDTH;
    const h = FORGE_SANS_ATLAS_HEIGHT;
    this.page = new UIAtlasPage(pageName, w, h, "r8unorm", decodeRle(decodeBase64(FORGE_SANS_ATLAS_BASE64), w * h));
    const t = FORGE_SANS_GLYPHS;
    for (let i = 0; i < t.length; i += 8) {
      const gw = t[i + 4]!;
      const gh = t[i + 5]!;
      const ax = t[i + 6]!;
      const ay = t[i + 7]!;
      this.glyphs.set(t[i]!, {
        advance: t[i + 1]!,
        x: t[i + 2]!,
        y: t[i + 3]!,
        width: gw,
        height: gh,
        u0: ax / w,
        v0: ay / h,
        u1: (ax + gw) / w,
        v1: (ay + gh) / h,
        page: gw > 0 ? this.page : null,
        sdf: true,
      });
    }
    const k = FORGE_SANS_KERNING;
    for (let i = 0; i < k.length; i += 3) this.kern.set(k[i]! * 65536 + k[i + 1]!, k[i + 2]!);
  }

  glyph(cp: number): GlyphInfo | null {
    return this.glyphs.get(cp) ?? null;
  }

  kerning(left: number, right: number): number {
    return this.kern.get(left * 65536 + right) ?? 0;
  }

  /** Code points this face covers (tests/diagnostics). */
  get coverage(): number[] {
    return [...this.glyphs.keys()];
  }
}

/**
 * Rasteriser hook for runtime glyphs (e.g. `OffscreenCanvas.fillText` in the browser). Given a code
 * point and pixel size it returns an alpha coverage bitmap and metrics, or null if it cannot draw it.
 */
export interface GlyphRasterizer {
  rasterize(codepoint: number, size: number): { advance: number; x: number; y: number; width: number; height: number; alpha: Uint8Array } | null;
  readonly ascent: number;
  readonly descent: number;
}

/**
 * A face that rasterises glyphs on demand into its own coverage atlas. Used as a fallback for code
 * points the SDF face lacks (CJK, Cyrillic, emoji outlines…). Glyphs are rasterised once at
 * `baseSize` and scaled (coverage masks blur when scaled up — the documented trade-off for unlimited
 * script coverage without shipping a font per script).
 */
export class DynamicGlyphFace implements UIFontFace {
  readonly spread = 0;
  readonly page: UIAtlasPage;
  private readonly glyphs = new Map<number, GlyphInfo | null>();
  private penX = 1;
  private penY = 1;
  private rowH = 0;
  /** Glyphs that did not fit (atlas full). */
  overflowed = 0;

  constructor(
    readonly name: string,
    private readonly rasterizer: GlyphRasterizer,
    readonly baseSize = 32,
    atlasSize = 1024,
    pageName = `ui.font.dynamic.${name}`,
  ) {
    this.page = new UIAtlasPage(pageName, atlasSize, atlasSize, "r8unorm", new Uint8Array(atlasSize * atlasSize));
  }

  get ascent(): number {
    return this.rasterizer.ascent;
  }

  get descent(): number {
    return this.rasterizer.descent;
  }

  glyph(cp: number): GlyphInfo | null {
    if (this.glyphs.has(cp)) return this.glyphs.get(cp)!;
    const r = this.rasterizer.rasterize(cp, this.baseSize);
    if (!r) {
      this.glyphs.set(cp, null);
      return null;
    }
    const page = this.page;
    if (r.width === 0 || r.height === 0) {
      const g: GlyphInfo = { advance: r.advance, x: 0, y: 0, width: 0, height: 0, u0: 0, v0: 0, u1: 0, v1: 0, page: null, sdf: false };
      this.glyphs.set(cp, g);
      return g;
    }
    if (this.penX + r.width + 1 > page.width) {
      this.penX = 1;
      this.penY += this.rowH + 1;
      this.rowH = 0;
    }
    if (this.penY + r.height + 1 > page.height) {
      this.overflowed++;
      this.glyphs.set(cp, null);
      return null;
    }
    for (let y = 0; y < r.height; y++) page.data.set(r.alpha.subarray(y * r.width, (y + 1) * r.width), (this.penY + y) * page.width + this.penX);
    page.touch(this.penY, this.penY + r.height);
    const g: GlyphInfo = {
      advance: r.advance,
      x: r.x,
      y: r.y,
      width: r.width,
      height: r.height,
      u0: this.penX / page.width,
      v0: this.penY / page.height,
      u1: (this.penX + r.width) / page.width,
      v1: (this.penY + r.height) / page.height,
      page,
      sdf: false,
    };
    this.penX += r.width + 1;
    this.rowH = Math.max(this.rowH, r.height);
    this.glyphs.set(cp, g);
    return g;
  }

  kerning(): number {
    return 0;
  }
}

/**
 * Browser rasteriser over `OffscreenCanvas` 2D text. Only constructed where `OffscreenCanvas`
 * exists; it is a glyph *rasteriser*, not a rendering path — its pixels go through the UI atlas and
 * the WebGPU pass like every other glyph.
 */
export function createCanvasRasterizer(fontFamily = "sans-serif", size = 32): GlyphRasterizer | null {
  const OC = (globalThis as { OffscreenCanvas?: new (w: number, h: number) => { getContext(t: "2d", o?: unknown): unknown } }).OffscreenCanvas;
  if (!OC) return null;
  const canvas = new OC(size * 2, size * 2);
  const ctx = canvas.getContext("2d", { willReadFrequently: true }) as {
    font: string;
    textBaseline: string;
    fillStyle: string;
    clearRect(x: number, y: number, w: number, h: number): void;
    fillText(s: string, x: number, y: number): void;
    measureText(s: string): { width: number; actualBoundingBoxAscent: number; actualBoundingBoxDescent: number; actualBoundingBoxLeft: number; actualBoundingBoxRight: number };
    getImageData(x: number, y: number, w: number, h: number): { data: Uint8ClampedArray };
  } | null;
  if (!ctx) return null;
  ctx.font = `${size}px ${fontFamily}`;
  ctx.textBaseline = "alphabetic";
  const probe = ctx.measureText("Hg");
  return {
    ascent: probe.actualBoundingBoxAscent || size * 0.8,
    descent: probe.actualBoundingBoxDescent || size * 0.2,
    rasterize(cp: number) {
      const ch = String.fromCodePoint(cp);
      const m = ctx.measureText(ch);
      const left = Math.floor(-m.actualBoundingBoxLeft);
      const right = Math.ceil(m.actualBoundingBoxRight);
      const top = Math.ceil(m.actualBoundingBoxAscent);
      const bottom = Math.ceil(m.actualBoundingBoxDescent);
      const w = Math.min(size * 2, Math.max(0, right - left));
      const h = Math.min(size * 2, Math.max(0, top + bottom));
      if (m.width === 0 && w === 0) return null;
      if (w === 0 || h === 0) return { advance: m.width, x: 0, y: 0, width: 0, height: 0, alpha: new Uint8Array(0) };
      ctx.clearRect(0, 0, size * 2, size * 2);
      ctx.fillStyle = "#fff";
      ctx.fillText(ch, -left, top);
      const img = ctx.getImageData(0, 0, w, h).data;
      const alpha = new Uint8Array(w * h);
      for (let i = 0; i < w * h; i++) alpha[i] = img[i * 4 + 3]!;
      return { advance: m.width, x: left, y: -top, width: w, height: h, alpha };
    },
  };
}
