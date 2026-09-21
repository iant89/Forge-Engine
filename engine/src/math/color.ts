/**
 * Colour: sRGB-aware storage and conversion.
 *
 * The engine's rule (docs/ARCHITECTURE.md#color) is: colours are *authored* in sRGB, *stored* as
 * linear float32 triplets, and only converted at the two ends — when a user sets a hex value, and
 * when the swapchain format needs encoded output. Getting this wrong is the single most common
 * cause of "everything looks washed out", so the conversions live here and nowhere else.
 */

import { srgbToLinear, linearToSrgb } from "./scalar.js";
import { clamp } from "./scalar.js";

/** Packed 0xAARRGGBB helpers (the format the instance stream and debug draw use). */
export function packColorRGBA(r: number, g: number, b: number, a = 1): number {
  const u8 = (v: number) => (Math.min(1, Math.max(0, v)) * 255 + 0.5) | 0;
  return ((u8(a) << 24) | (u8(r) << 16) | (u8(g) << 8) | u8(b)) >>> 0;
}

export function unpackColor(packed: number, out: { r: number; g: number; b: number; a: number }): void {
  out.a = ((packed >>> 24) & 0xff) / 255;
  out.r = ((packed >>> 16) & 0xff) / 255;
  out.g = ((packed >>> 8) & 0xff) / 255;
  out.b = (packed & 0xff) / 255;
}

/**
 * Linear RGB colour. Fields are float32; values may exceed 1 for HDR/emissive use.
 */
export class Color {
  constructor(
    public r = 1,
    public g = 1,
    public b = 1,
    public a = 1,
  ) {}

  set(r: number, g: number, b: number, a = this.a): this {
    this.r = r;
    this.g = g;
    this.b = b;
    this.a = a;
    return this;
  }

  static readonly white = Object.freeze(new Color(1, 1, 1, 1));
  static readonly black = Object.freeze(new Color(0, 0, 0, 1));

  /** From a CSS-ish hex number, interpreted as sRGB (the authoring space). */
  static fromSrgbHex(hex: number, alpha = 1): Color {
    const c = new Color();
    c.setSrgbHex(hex, alpha);
    return c;
  }

  static fromLinearHex(hex: number, alpha = 1): Color {
    return new Color(((hex >> 16) & 0xff) / 255, ((hex >> 8) & 0xff) / 255, (hex & 0xff) / 255, alpha);
  }

  /** Parse "#rrggbb", "#rgb", "rgb(1,2,3)" or a named subset. Throws UsageError on garbage. */
  static parse(text: string): Color {
    const t = text.trim().toLowerCase();
    if (t.startsWith("#")) {
      const hex = t.slice(1);
      if (hex.length === 3 || hex.length === 4) {
        const r = parseInt(hex[0]! + hex[0]!, 16);
        const g = parseInt(hex[1]! + hex[1]!, 16);
        const b = parseInt(hex[2]! + hex[2]!, 16);
        const a = hex.length === 4 ? parseInt(hex[3]! + hex[3]!, 16) / 255 : 1;
        return Color.fromSrgbHex((r << 16) | (g << 8) | b, a);
      }
      if (hex.length === 6 || hex.length === 8) {
        const v = parseInt(hex.slice(0, 6), 16);
        const a = hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1;
        return Color.fromSrgbHex(v, a);
      }
    }
    const named = NAMED[t];
    if (named !== undefined) return Color.fromSrgbHex(named);
    const m = /^rgba?\(([^)]+)\)$/.exec(t);
    if (m) {
      const parts = m[1]!.split(",").map((p) => parseFloat(p.trim()));
      if (parts.length >= 3 && parts.every((p) => Number.isFinite(p))) {
        return new Color(srgbToLinear(parts[0]! / 255), srgbToLinear(parts[1]! / 255), srgbToLinear(parts[2]! / 255), parts[3] ?? 1);
      }
    }
    throw new Error(`Color.parse: unsupported colour "${text}"`);
  }

  setSrgbHex(hex: number, alpha = 1): this {
    this.r = srgbToLinear(((hex >> 16) & 0xff) / 255);
    this.g = srgbToLinear(((hex >> 8) & 0xff) / 255);
    this.b = srgbToLinear((hex & 0xff) / 255);
    this.a = alpha;
    return this;
  }

  /** sRGB bytes, as a swapchain/clear colour expects them. */
  toSrgbPacked(): number {
    return packColorRGBA(linearToSrgb(this.r), linearToSrgb(this.g), linearToSrgb(this.b), this.a);
  }

  /** Write as 4 float32 (used for uniform `vec4<f32>` fields). */
  writeLinear(out: Float32Array, offset = 0): void {
    out[offset] = this.r;
    out[offset + 1] = this.g;
    out[offset + 2] = this.b;
    out[offset + 3] = this.a;
  }

  /** Write as packed sRGB bytes (used for vertex colour attributes on sRGB-unaware paths). */
  writeSrgb(out: Uint8Array, offset = 0): void {
    const q = (v: number) => Math.round(linearToSrgb(v) * 255);
    out[offset] = q(this.r);
    out[offset + 1] = q(this.g);
    out[offset + 2] = q(this.b);
    out[offset + 3] = Math.round(this.a * 255);
  }

  scale(s: number): this {
    this.r *= s;
    this.g *= s;
    this.b *= s;
    return this;
  }

  lerp(c: Color, t: number): this {
    this.r += (c.r - this.r) * t;
    this.g += (c.g - this.g) * t;
    this.b += (c.b - this.b) * t;
    this.a += (c.a - this.a) * t;
    return this;
  }

  copyFrom(c: Color): this {
    this.r = c.r;
    this.g = c.g;
    this.b = c.b;
    this.a = c.a;
    return this;
  }

  clone(): Color {
    return new Color(this.r, this.g, this.b, this.a);
  }

  /** Perceptual luminance (Rec. 709), on linear values. */
  get luminance(): number {
    return 0.2126 * this.r + 0.7152 * this.g + 0.0722 * this.b;
  }

  /** Multiply by an intensity scalar, keeping alpha (used for light colours). */
  multipliedBy(intensity: number): Color {
    return new Color(this.r * intensity, this.g * intensity, this.b * intensity, this.a);
  }

  equals(c: Color, epsilon = 1e-6): boolean {
    return Math.abs(this.r - c.r) <= epsilon && Math.abs(this.g - c.g) <= epsilon && Math.abs(this.b - c.b) <= epsilon && Math.abs(this.a - c.a) <= epsilon;
  }

  toCss(): string {
    const q = (v: number) => Math.round(linearToSrgb(v) * 255);
    return this.a >= 1 ? `rgb(${q(this.r)},${q(this.g)},${q(this.b)})` : `rgba(${q(this.r)},${q(this.g)},${q(this.b)},${this.a.toFixed(3)})`;
  }

  toString(): string {
    return `Color(${this.r.toFixed(4)}, ${this.g.toFixed(4)}, ${this.b.toFixed(4)}, a=${this.a.toFixed(3)})`;
  }
}

const NAMED: Record<string, number> = {
  black: 0x000000,
  white: 0xffffff,
  gray: 0x808080,
  grey: 0x808080,
  red: 0xff0000,
  green: 0x00ff00,
  blue: 0x0000ff,
  yellow: 0xffff00,
  cyan: 0x00ffff,
  magenta: 0xff00ff,
  orange: 0xffa500,
  purple: 0x800080,
  lime: 0x00ff00,
  silver: 0xc0c0c0,
  navy: 0x000080,
  teal: 0x008080,
  maroon: 0x800000,
  olive: 0x808000,
  brown: 0xa52a2a,
  sky: 0x87ceeb,
};

/**
 * CIE xy chromaticity → linear RGB (used by the atmosphere/sky code for sun colour temperature).
 * `temperatureKelvin` in 1000-12000 K is the practical range for daylight.
 */
export function colorFromTemperature(kelvin: number, out = new Color()): Color {
  const t = Math.min(40000, Math.max(1000, kelvin)) / 100;
  let r: number;
  let g: number;
  let b: number;
  if (t <= 66) {
    r = 255;
    g = 99.4708025861 * Math.log(t) - 161.1195681661;
  } else {
    r = 329.698727446 * Math.pow(t - 60, -0.1332047592);
    g = 288.1221695283 * Math.pow(t - 60, -0.0755148492);
  }
  if (t >= 66) b = 255;
  else if (t <= 19) b = 0;
  else b = 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  const clamp01 = (v: number) => clamp(v, 0, 255) / 255;
  out.r = srgbToLinear(clamp01(r));
  out.g = srgbToLinear(clamp01(g));
  out.b = srgbToLinear(clamp01(b));
  out.a = 1;
  return out;
}
