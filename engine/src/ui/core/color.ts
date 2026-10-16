/**
 * UI colours.
 *
 * A UI colour is a display-referred **sRGB** value with straight (non-premultiplied) alpha, packed as
 * one unsigned 32-bit integer `0xRRGGBBAA`. Packing keeps resolved styles small and immutable, makes
 * style-cache comparisons a number compare, and lets the animator interpolate without allocating.
 *
 * Why sRGB and not linear (unlike the 3D scene, AGENTS.md §3): UI is composited after the frame's
 * tonemap has already encoded to the (non-sRGB) swapchain format, and UI colours are authored the way
 * CSS authors them. Writing them unmodified and blending in that space reproduces what a designer
 * sees in any CSS tool.
 */

import { UsageError } from "../../core/errors.js";

export type UIColor = number;

export const TRANSPARENT: UIColor = 0;
export const WHITE: UIColor = 0xffffffff;
export const BLACK: UIColor = 0x000000ff;

export function rgba(r: number, g: number, b: number, a = 1): UIColor {
  const c = (v: number): number => Math.max(0, Math.min(255, Math.round(v)));
  return ((c(r) << 24) | (c(g) << 16) | (c(b) << 8) | c(a * 255)) >>> 0;
}

export function colorR(c: UIColor): number {
  return (c >>> 24) & 255;
}
export function colorG(c: UIColor): number {
  return (c >>> 16) & 255;
}
export function colorB(c: UIColor): number {
  return (c >>> 8) & 255;
}
/** Alpha in 0..1. */
export function colorA(c: UIColor): number {
  return (c & 255) / 255;
}

/** Same colour with alpha multiplied by `k` (opacity inheritance). */
export function withAlpha(c: UIColor, k: number): UIColor {
  const a = Math.max(0, Math.min(255, Math.round((c & 255) * k)));
  return ((c & 0xffffff00) | a) >>> 0;
}

/** Channel-wise interpolation in packed sRGB (what CSS transitions do). */
export function lerpColor(a: UIColor, b: UIColor, t: number): UIColor {
  if (t <= 0) return a;
  if (t >= 1) return b;
  const ch = (shift: number): number => {
    const x = (a >>> shift) & 255;
    const y = (b >>> shift) & 255;
    return Math.round(x + (y - x) * t) & 255;
  };
  return ((ch(24) << 24) | (ch(16) << 16) | (ch(8) << 8) | ch(0)) >>> 0;
}

/** Write a packed colour into `out[offset..offset+3]` as 0..1 floats. */
export function writeColorFloats(c: UIColor, out: Float32Array, offset: number, alphaScale = 1): void {
  out[offset] = ((c >>> 24) & 255) / 255;
  out[offset + 1] = ((c >>> 16) & 255) / 255;
  out[offset + 2] = ((c >>> 8) & 255) / 255;
  out[offset + 3] = ((c & 255) / 255) * alphaScale;
}

/** Relative luminance (WCAG 2.x) of an sRGB colour, ignoring alpha. */
export function relativeLuminance(c: UIColor): number {
  const lin = (v: number): number => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * lin(colorR(c)) + 0.7152 * lin(colorG(c)) + 0.0722 * lin(colorB(c));
}

/** WCAG contrast ratio between two opaque colours (1..21). */
export function contrastRatio(a: UIColor, b: UIColor): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

const NAMED: Readonly<Record<string, UIColor>> = {
  transparent: TRANSPARENT,
  white: WHITE,
  black: BLACK,
  red: 0xff0000ff,
  green: 0x008000ff,
  blue: 0x0000ffff,
  yellow: 0xffff00ff,
  gray: 0x808080ff,
  grey: 0x808080ff,
};

/**
 * Parse `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`, `rgb(r,g,b)`, `rgba(r,g,b,a)` or a basic name.
 * Returns `null` for anything else (callers turn that into a diagnostic, never a silent colour).
 */
export function tryParseColor(input: string): UIColor | null {
  const s = input.trim().toLowerCase();
  const named = NAMED[s];
  if (named !== undefined) return named;
  if (s.startsWith("#")) {
    const h = s.slice(1);
    if (!/^[0-9a-f]+$/.test(h)) return null;
    if (h.length === 3 || h.length === 4) {
      const d = (i: number): number => parseInt(h[i]! + h[i]!, 16);
      return rgba(d(0), d(1), d(2), h.length === 4 ? d(3) / 255 : 1);
    }
    if (h.length === 6) return ((parseInt(h, 16) << 8) | 0xff) >>> 0;
    if (h.length === 8) return parseInt(h, 16) >>> 0;
    return null;
  }
  const m = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(s);
  if (m) return rgba(Number(m[1]), Number(m[2]), Number(m[3]), m[4] === undefined ? 1 : Number(m[4]));
  return null;
}

/** A colour literal: a packed number or a parseable string. */
export type ColorInput = UIColor | string;

export function parseColor(input: ColorInput): UIColor {
  if (typeof input === "number") return input >>> 0;
  const c = tryParseColor(input);
  if (c === null) throw new UsageError(`ui: "${input}" is not a colour (#rgb, #rrggbb, #rrggbbaa, rgb(), rgba() or a basic name)`);
  return c;
}

export function colorToHex(c: UIColor): string {
  return `#${(c >>> 0).toString(16).padStart(8, "0")}`;
}
