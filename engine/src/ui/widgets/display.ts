/**
 * Display widgets: text, images, icons, indicators. None of them take focus; all take their colours,
 * typography and sizes from the skin (`Label`, `ProgressBar`, …) so a theme switch restyles them.
 *
 * Localized text: `Label`, `Badge` and `StatDisplay` accept a `textKey` (+ `textParams`). The text is
 * re-resolved and re-measured when the locale changes.
 */

import { UIElement, type UIElementOptions } from "../core/element.js";
import type { UIContext } from "../core/context.js";
import type { LayoutContext } from "../layout/types.js";
import type { ResolvedStyle, TextAlign } from "../style/types.js";
import type { UIPainter } from "../render/painter.js";
import { parseColor, tryParseColor, withAlpha, type ColorInput, type UIColor } from "../core/color.js";
import type { TextLayoutResult, TextOverflow, WrapMode } from "../text/textLayout.js";
import { RangeModel, TextPart } from "./base.js";

// ====================================================================== Label

export interface LabelOptions extends UIElementOptions {
  text?: string;
  textKey?: string;
  textParams?: Record<string, string | number>;
  wrap?: WrapMode;
  overflow?: TextOverflow;
  maxLines?: number;
  align?: TextAlign;
  /** Override the skin's text colour. */
  color?: ColorInput;
}

/** A block of text, localized or literal, wrapping and truncating as configured. */
export class Label extends UIElement {
  static override styleName = "Label";
  protected readonly part: TextPart;
  private _textKey: string | null;
  private _params: Record<string, string | number> | undefined;
  private _color: UIColor | null;

  constructor(options: LabelOptions = {}) {
    super(options);
    this.part = new TextPart(options.text ?? "", { wrap: options.wrap, overflow: options.overflow ?? (options.wrap && options.wrap !== "none" ? "visible" : "ellipsis"), maxLines: options.maxLines, align: options.align });
    this._textKey = options.textKey ?? null;
    this._params = options.textParams;
    this._color = options.color !== undefined ? parseColor(options.color) : null;
    this.pointerEvents = options.tooltip ? "auto" : "none";
    this.accessibility.role = this.accessibility.role === "generic" ? "text" : this.accessibility.role;
    this.syncA11y();
  }

  get text(): string {
    return this.part.text;
  }
  set text(t: string) {
    this._textKey = null;
    this.setResolvedText(t);
  }

  /** Localization key; the displayed text follows the active locale. */
  get textKey(): string | null {
    return this._textKey;
  }
  set textKey(k: string | null) {
    this._textKey = k;
    this.resolveKey();
  }

  get textParams(): Record<string, string | number> | undefined {
    return this._params;
  }
  set textParams(p: Record<string, string | number> | undefined) {
    this._params = p;
    this.resolveKey();
  }

  get color(): UIColor | null {
    return this._color;
  }
  set color(c: UIColor | string | null) {
    this._color = c === null ? null : typeof c === "string" ? tryParseColor(c) : c >>> 0;
    this.invalidateRender();
  }

  get wrap(): WrapMode {
    return this.part.wrap;
  }
  set wrap(w: WrapMode) {
    this.part.wrap = w;
    this.part.invalidate();
    this.invalidateLayout();
  }

  /** The last text layout (tests and custom painting). */
  get textLayout(): TextLayoutResult | null {
    return this.part.last;
  }

  private setResolvedText(t: string): void {
    if (this.part.set(t)) {
      this.syncA11y();
      this.invalidateLayout();
    }
  }

  private syncA11y(): void {
    this.accessibility.label = this.part.text;
  }

  private resolveKey(): void {
    if (this._textKey && this.context) this.setResolvedText(this.context.localizer.t(this._textKey, this._params));
  }

  protected override onAttach(_ctx: UIContext): void {
    this.resolveKey();
  }

  /** Called by the manager when the locale changes. */
  onLocaleChanged(): void {
    this.resolveKey();
  }

  protected override measureContent(availableWidth: number, _h: number, _ctx: LayoutContext): { width: number; height: number } {
    const l = this.part.layout(this.context, this.computedStyle, availableWidth);
    if (!l) return { width: 0, height: 0 };
    return { width: Math.min(l.width, availableWidth), height: l.height };
  }

  protected override paintContent(p: UIPainter, s: ResolvedStyle): void {
    const c = this.contentRect;
    const l = this.part.layout(this.context, s, c.width + 0.01);
    this.part.paint(p, l, c.x, c.y, c.width, c.height, this._color ?? s.foreground, this.part.align ?? s.textAlign);
  }
}

// ====================================================================== RichText

interface RichToken {
  text: string;
  color: UIColor | null;
  size: number | null;
  bold: boolean;
  icon: string | null;
  newline: boolean;
  space: boolean;
}

interface RichPlacement {
  token: RichToken;
  layout: TextLayoutResult | null;
  x: number;
  y: number;
  width: number;
  height: number;
  baseline: number;
}

/**
 * Text with inline formatting: `[b]bold[/b]`, `[color=#f87171]red[/color]` (or `$color.token`),
 * `[size=20]big[/size]`, `[icon=star]` (sprite or glyph icon). `[[` is a literal `[`. Unknown tags
 * are shown verbatim (and reported), never executed. Wraps at word boundaries; mixed sizes share a
 * baseline per line.
 */
export class RichText extends UIElement {
  static override styleName = "RichText";
  private _markup: string;
  private tokens: RichToken[] = [];
  private placements: RichPlacement[] = [];
  private placedWidth = NaN;
  private placedKey = "";
  private size = { width: 0, height: 0 };
  /** Unknown tags found by the last parse that have not been reported yet (no context at parse time). */
  private unreportedTags: string[] = [];

  constructor(options: UIElementOptions & { markup?: string } = {}) {
    super(options);
    this._markup = options.markup ?? "";
    this.pointerEvents = options.tooltip ? "auto" : "none";
    this.accessibility.role = "text";
    this.parse(true);
  }

  get markup(): string {
    return this._markup;
  }
  set markup(m: string) {
    if (m === this._markup) return;
    this._markup = m;
    this.parse(true);
    this.invalidateLayout();
  }

  /** Plain text without tags (accessibility). */
  get plainText(): string {
    return this.tokens.map((t) => (t.newline ? "\n" : t.icon ? "" : t.text)).join("");
  }

  /** `report` is true for a new markup string; re-parses for theme changes stay quiet. */
  private parse(report = false): void {
    if (report) this.unreportedTags = [];
    const out: RichToken[] = [];
    const colors: (UIColor | null)[] = [];
    const sizes: (number | null)[] = [];
    let bold = 0;
    const m = this._markup;
    let buf = "";
    const flush = (): void => {
      if (!buf) return;
      // Split into words and spaces so lines can break between them.
      for (const piece of buf.split(/( +|\n)/)) {
        if (!piece) continue;
        const base = { color: colors[colors.length - 1] ?? null, size: sizes[sizes.length - 1] ?? null, bold: bold > 0, icon: null };
        if (piece === "\n") out.push({ ...base, text: "", newline: true, space: false });
        else out.push({ ...base, text: piece, newline: false, space: piece.trim() === "" });
      }
      buf = "";
    };
    for (let i = 0; i < m.length; i++) {
      const ch = m[i]!;
      if (ch === "[" && m[i + 1] === "[") {
        buf += "[";
        i++;
        continue;
      }
      if (ch !== "[") {
        buf += ch;
        continue;
      }
      const close = m.indexOf("]", i);
      if (close < 0) {
        buf += m.slice(i);
        break;
      }
      const tag = m.slice(i + 1, close);
      let known = true;
      if (tag === "b") {
        flush();
        bold++;
      } else if (tag === "/b") {
        flush();
        bold = Math.max(0, bold - 1);
      } else if (tag.startsWith("color=")) {
        flush();
        const v = tag.slice(6);
        colors.push(v.startsWith("$") ? this.tokenColor(v) : tryParseColor(v));
      } else if (tag === "/color") {
        flush();
        colors.pop();
      } else if (tag.startsWith("size=")) {
        flush();
        const n = Number(tag.slice(5));
        sizes.push(Number.isFinite(n) && n > 0 ? n : null);
      } else if (tag === "/size") {
        flush();
        sizes.pop();
      } else if (tag.startsWith("icon=")) {
        flush();
        out.push({ text: "", color: colors[colors.length - 1] ?? null, size: sizes[sizes.length - 1] ?? null, bold: false, icon: tag.slice(5), newline: false, space: false });
      } else known = false;
      if (!known) {
        buf += `[${tag}]`;
        if (report) this.unreportedTags.push(tag);
      }
      i = close;
    }
    flush();
    this.tokens = out;
    this.placedKey = "";
    this.accessibility.label = this.plainText;
    this.reportUnknownTags();
  }

  private reportUnknownTags(): void {
    const ctx = this.context;
    if (!ctx || this.unreportedTags.length === 0) return;
    for (const tag of this.unreportedTags) ctx.diagnostic("warn", `RichText: unknown tag [${tag}]`, this);
    this.unreportedTags = [];
  }

  private tokenColor(ref: string): UIColor | null {
    const v = this.context?.styles.token(ref.slice(1));
    return typeof v === "number" ? v : null;
  }

  protected override onAttach(): void {
    // Token colours need the theme: re-parse now that we have a context.
    if (this._markup.includes("$")) this.parse();
    this.reportUnknownTags();
  }

  protected override onStyleChanged(): void {
    if (this._markup.includes("$")) this.parse();
    this.placedKey = "";
  }

  private place(maxWidth: number): void {
    const ctx = this.context;
    const s = this.computedStyle;
    const key = `${maxWidth}|${s.fontSize}|${s.fontWeight}|${s.lineHeight}|${ctx?.text.textScale ?? 1}`;
    if (key === this.placedKey) return;
    this.placedKey = key;
    this.placedWidth = maxWidth;
    this.placements = [];
    if (!ctx) {
      this.size = { width: 0, height: 0 };
      return;
    }
    let x = 0;
    let y = 0;
    let lineH = 0;
    let lineBase = 0;
    let lineStart = 0;
    let width = 0;
    const endLine = (): void => {
      for (let i = lineStart; i < this.placements.length; i++) {
        const pl = this.placements[i]!;
        pl.y = y + (lineBase - pl.baseline);
      }
      width = Math.max(width, x);
      y += lineH || s.fontSize * s.lineHeight;
      x = 0;
      lineH = 0;
      lineBase = 0;
      lineStart = this.placements.length;
    };
    for (const t of this.tokens) {
      if (t.newline) {
        endLine();
        continue;
      }
      const size = t.size ?? s.fontSize;
      let pl: RichPlacement;
      if (t.icon) {
        const g = ctx.assets.glyphIcon(t.icon);
        if (g) {
          const l = ctx.text.layout({ text: String.fromCodePoint(g.codepoint), family: g.family, size, lineHeight: s.lineHeight });
          pl = { token: t, layout: l, x: 0, y: 0, width: l.width, height: l.height, baseline: l.baseline };
        } else {
          const h = size * s.lineHeight;
          pl = { token: t, layout: null, x: 0, y: 0, width: size, height: h, baseline: (h + size) / 2 - size * 0.15 };
        }
      } else {
        const l = ctx.text.layout({ text: t.text, family: ctx.text.hasFamily(s.fontFamily) ? s.fontFamily : "default", size, weight: t.bold ? 700 : s.fontWeight, lineHeight: s.lineHeight, letterSpacing: s.letterSpacing });
        pl = { token: t, layout: l, x: 0, y: 0, width: l.width, height: l.height, baseline: l.baseline };
      }
      if (x > 0 && x + pl.width > maxWidth && !t.space) endLine();
      if (x === 0 && t.space) continue; // no leading spaces on wrapped lines
      pl.x = x;
      x += pl.width;
      lineH = Math.max(lineH, pl.height);
      lineBase = Math.max(lineBase, pl.baseline);
      this.placements.push(pl);
    }
    endLine();
    this.size = { width, height: y };
  }

  protected override measureContent(availableWidth: number): { width: number; height: number } {
    this.place(availableWidth);
    return { width: Math.min(this.size.width, availableWidth), height: this.size.height };
  }

  protected override paintContent(p: UIPainter, s: ResolvedStyle): void {
    const c = this.contentRect;
    if (this.placedWidth !== c.width) this.place(c.width + 0.01);
    for (const pl of this.placements) {
      if (pl.token.space) continue;
      const color = pl.token.color ?? s.foreground;
      if (pl.layout) p.text(pl.layout, c.x + pl.x, c.y + pl.y, color);
      else if (pl.token.icon) p.image(pl.token.icon, c.x + pl.x, c.y + pl.y + (pl.height - pl.width) / 2, pl.width, pl.width, { tint: color });
    }
  }
}

// ====================================================================== Image & Icon

export type ImageFit = "fill" | "contain" | "cover" | "none";

export class UIImage extends UIElement {
  static override styleName = "Image";
  private _source: string;
  fit: ImageFit;
  private _tint: UIColor;

  constructor(options: UIElementOptions & { source?: string; fit?: ImageFit; tint?: ColorInput } = {}) {
    super(options);
    this._source = options.source ?? "";
    this.fit = options.fit ?? "contain";
    this._tint = options.tint !== undefined ? parseColor(options.tint) : 0xffffffff;
    this.pointerEvents = options.tooltip ? "auto" : "none";
    this.accessibility.role = "img";
  }

  get source(): string {
    return this._source;
  }
  set source(s: string) {
    if (s === this._source) return;
    this._source = s;
    this.invalidateLayout();
  }

  get tint(): UIColor {
    return this._tint;
  }
  set tint(c: UIColor) {
    this._tint = c >>> 0;
    this.invalidateRender();
  }

  protected override measureContent(): { width: number; height: number } {
    const src = this._source ? this.context?.assets.resolve(this._source) : null;
    return src ? { width: src.width, height: src.height } : { width: 0, height: 0 };
  }

  protected override paintContent(p: UIPainter, s: ResolvedStyle): void {
    if (!this._source) return;
    const c = this.contentRect;
    const src = this.context?.assets.resolve(this._source);
    if (!src || this.fit === "fill" || src.slice) {
      p.image(this._source, c.x, c.y, c.width, c.height, { tint: this._tint === 0xffffffff ? s.imageTint : this._tint });
      return;
    }
    const sx = c.width / src.width;
    const sy = c.height / src.height;
    const k = this.fit === "contain" ? Math.min(sx, sy) : this.fit === "cover" ? Math.max(sx, sy) : 1;
    const w = src.width * k;
    const h = src.height * k;
    const tint = this._tint === 0xffffffff ? s.imageTint : this._tint;
    if (this.fit === "cover") {
      p.pushClip(c.x, c.y, c.width, c.height);
      p.image(this._source, c.x + (c.width - w) / 2, c.y + (c.height - h) / 2, w, h, { tint });
      p.popClip();
    } else p.image(this._source, c.x + (c.width - w) / 2, c.y + (c.height - h) / 2, w, h, { tint });
  }
}

/**
 * An icon by name: a registered sprite (tinted with the text colour) or a glyph icon from the
 * font. `size` overrides the skin's `iconSize`.
 */
export class Icon extends UIElement {
  static override styleName = "Icon";
  private _name: string;
  private _size: number | null;
  private _color: UIColor | null;

  constructor(options: UIElementOptions & { icon?: string; size?: number; color?: ColorInput } = {}) {
    super(options);
    this._name = options.icon ?? "";
    this._size = options.size ?? null;
    this._color = options.color !== undefined ? parseColor(options.color) : null;
    this.pointerEvents = options.tooltip ? "auto" : "none";
    this.accessibility.role = "img";
    if (!this.accessibility.label) this.accessibility.label = this._name;
  }

  get icon(): string {
    return this._name;
  }
  set icon(n: string) {
    if (n === this._name) return;
    this._name = n;
    this.invalidateRender();
  }

  get size(): number {
    return this._size ?? this.computedStyle.iconSize;
  }
  set size(v: number) {
    this._size = v;
    this.invalidateLayout();
  }

  get color(): UIColor | null {
    return this._color;
  }
  set color(c: UIColor | null) {
    this._color = c;
    this.invalidateRender();
  }

  protected override measureContent(): { width: number; height: number } {
    return { width: this.size, height: this.size };
  }

  protected override paintContent(p: UIPainter, s: ResolvedStyle): void {
    if (!this._name) return;
    const c = this.contentRect;
    paintIcon(this.context, p, this._name, c.x + (c.width - this.size) / 2, c.y + (c.height - this.size) / 2, this.size, this._color ?? s.foreground);
  }
}

/** Draw a named icon (sprite or glyph) in a square box. Shared by widgets that show icons. */
export function paintIcon(ctx: UIContext | null, p: UIPainter, name: string, x: number, y: number, size: number, color: UIColor): void {
  if (!ctx) return;
  const glyph = ctx.assets.glyphIcon(name);
  if (glyph) {
    const l = ctx.text.layout({ text: String.fromCodePoint(glyph.codepoint), family: glyph.family, size, lineHeight: 1 });
    p.text(l, x + (size - l.width) / 2, y + (size - l.height) / 2, color);
    return;
  }
  p.image(name, x, y, size, size, { tint: color });
}

// ====================================================================== ProgressBar & friends

export interface ProgressOptions extends UIElementOptions {
  value?: number;
  min?: number;
  max?: number;
  orientation?: "horizontal" | "vertical";
  indeterminate?: boolean;
  showLabel?: boolean;
  format?: (value: number, fraction: number) => string;
  /** Animate value changes over this many seconds (0 = instant). */
  smoothing?: number;
}

export class ProgressBar extends UIElement {
  static override styleName = "ProgressBar";
  protected readonly range: RangeModel;
  private _value: number;
  /** The drawn value (eases toward `value` when `smoothing` > 0). */
  displayValue: number;
  orientation: "horizontal" | "vertical";
  private _indeterminate: boolean;
  showLabel: boolean;
  format: (value: number, fraction: number) => string;
  smoothing: number;
  private phase = 0;
  private readonly labelPart = new TextPart("");

  constructor(options: ProgressOptions = {}) {
    super(options);
    this.range = new RangeModel(options.min ?? 0, options.max ?? 1);
    this._value = this.range.clamp(options.value ?? 0);
    this.displayValue = this._value;
    this.orientation = options.orientation ?? "horizontal";
    this._indeterminate = options.indeterminate ?? false;
    this.showLabel = options.showLabel ?? false;
    this.format = options.format ?? ((_v, f) => `${Math.round(f * 100)}%`);
    this.smoothing = options.smoothing ?? 0;
    this.pointerEvents = options.tooltip ? "auto" : "none";
    this.accessibility.role = "progressbar";
    this.syncA11y();
    if (this._indeterminate) this.setTicking(true);
  }

  get value(): number {
    return this._value;
  }
  set value(v: number) {
    const c = this.range.clamp(v);
    if (c === this._value) return;
    const from = this.displayValue;
    this._value = c;
    this.syncA11y();
    const ctx = this.context;
    if (ctx && this.smoothing > 0) ctx.animator.tween(this, "displayValue", from, c, (x) => {
      this.displayValue = x;
      this.invalidateRender();
    }, { duration: this.smoothing, easing: "easeOutCubic", essential: true });
    else {
      this.displayValue = c;
      this.invalidateRender();
    }
    this.onValueChanged(from, c);
  }

  protected onValueChanged(_from: number, _to: number): void {}

  get min(): number {
    return this.range.min;
  }
  get max(): number {
    return this.range.max;
  }
  set max(m: number) {
    this.range.max = Math.max(this.range.min, m);
    this.value = this._value;
    this.syncA11y();
    this.invalidateRender();
  }

  /** 0..1 */
  get fraction(): number {
    return this.range.fraction(this._value);
  }

  get indeterminate(): boolean {
    return this._indeterminate;
  }
  set indeterminate(v: boolean) {
    if (v === this._indeterminate) return;
    this._indeterminate = v;
    this.setTicking(v);
    this.invalidateRender();
  }

  protected syncA11y(): void {
    this.accessibility.value = this._indeterminate ? "busy" : this.format(this._value, this.range.fraction(this._value));
  }

  override update(dt: number): void {
    if (!this._indeterminate || this.context?.reducedMotion) return;
    this.phase = (this.phase + dt * 0.8) % 1;
    this.invalidateRender();
  }

  protected override measureContent(): { width: number; height: number } {
    const s = this.computedStyle;
    const t = Math.max(4, s.minHeight || 8);
    return this.orientation === "horizontal" ? { width: 120, height: t } : { width: t, height: 120 };
  }

  protected override paintBackground(p: UIPainter, s: ResolvedStyle): void {
    const b = this.bounds;
    p.box(b.x, b.y, b.width, b.height, { background: s.track, radius: s.radius, borderColor: s.borderColor, borderWidth: s.borderWidth, shadowColor: s.shadowColor, shadowBlur: s.shadowBlur, shadowOffsetY: s.shadowOffsetY });
  }

  protected override paintContent(p: UIPainter, s: ResolvedStyle): void {
    const c = this.contentRect;
    const r = s.radius.topLeft;
    if (this._indeterminate) {
      if (this.context?.reducedMotion) p.fillRect(c.x, c.y, c.width, c.height, withAlpha(s.accent, 0.5), r);
      else {
        const seg = 0.35;
        const start = this.phase * (1 + seg) - seg;
        const x0 = c.x + Math.max(0, start) * c.width;
        const x1 = c.x + Math.min(1, start + seg) * c.width;
        if (x1 > x0) p.fillRect(x0, c.y, x1 - x0, c.height, s.accent, r);
      }
    } else {
      this.paintFill(p, s, this.range.fraction(this.displayValue), s.accent);
    }
    if (this.showLabel) {
      this.labelPart.set(this._indeterminate ? "" : this.format(this._value, this.range.fraction(this._value)));
      const l = this.labelPart.layout(this.context, s, Infinity, Math.min(s.fontSize, Math.max(8, c.height - 2)));
      this.labelPart.paint(p, l, c.x, c.y, c.width, c.height, s.foreground, "center");
    }
  }

  protected paintFill(p: UIPainter, s: ResolvedStyle, f: number, color: UIColor): void {
    const c = this.contentRect;
    const r = s.radius.topLeft;
    if (f <= 0) return;
    if (this.orientation === "horizontal") p.fillRect(c.x, c.y, c.width * f, c.height, color, r);
    else p.fillRect(c.x, c.y + c.height * (1 - f), c.width, c.height * f, color, r);
  }
}

export class CircularProgress extends ProgressBar {
  static override styleName = "CircularProgress";

  constructor(options: ProgressOptions & { size?: number } = {}) {
    super(options);
    if (options.size) this.setLayout({ width: options.size, height: options.size });
  }

  protected override measureContent(): { width: number; height: number } {
    const d = Math.max(16, this.computedStyle.minWidth || 48);
    return { width: d, height: d };
  }

  protected override paintBackground(): void {}

  protected override paintContent(p: UIPainter, s: ResolvedStyle): void {
    const c = this.contentRect;
    const radius = Math.min(c.width, c.height) / 2;
    const cx = c.x + c.width / 2;
    const cy = c.y + c.height / 2;
    const thick = Math.max(2, s.borderWidth || radius * 0.18);
    p.arc(cx, cy, radius, thick, 0, Math.PI * 2, s.track);
    const TAU = Math.PI * 2;
    if (this.indeterminate) {
      const start = ((this.context?.time ?? 0) * 4) % TAU;
      p.arc(cx, cy, radius, thick, start, start + TAU * 0.3, s.accent);
    } else {
      const f = this.range.fraction(this.displayValue);
      if (f > 0) p.arc(cx, cy, radius, thick, 0, TAU * f, s.accent);
    }
    if (this.showLabel && !this.indeterminate && this.context) {
      const l = this.context.text.layout({ text: this.format(this.value, this.fraction), family: "default", size: Math.max(8, Math.min(s.fontSize, radius * 0.6)), weight: s.fontWeight });
      p.text(l, cx - l.width / 2, cy - l.height / 2, s.foreground);
    }
  }
}

/** Indeterminate spinner (an essential animation: keeps turning under reduced motion, slower). */
export class LoadingIndicator extends UIElement {
  static override styleName = "LoadingIndicator";
  private angle = 0;

  constructor(options: UIElementOptions & { size?: number } = {}) {
    super(options);
    this.pointerEvents = "none";
    this.accessibility.role = "progressbar";
    this.accessibility.value = "busy";
    if (options.size) this.setLayout({ width: options.size, height: options.size });
    this.setTicking(true);
  }

  override update(dt: number): void {
    const speed = this.context?.reducedMotion ? 1.5 : 6;
    this.angle = (this.angle + dt * speed) % (Math.PI * 2);
    this.invalidateRender();
  }

  protected override measureContent(): { width: number; height: number } {
    const d = Math.max(12, this.computedStyle.minWidth || 24);
    return { width: d, height: d };
  }

  protected override paintContent(p: UIPainter, s: ResolvedStyle): void {
    const c = this.contentRect;
    const r = Math.min(c.width, c.height) / 2;
    const thick = Math.max(2, s.borderWidth || r * 0.2);
    p.arc(c.x + c.width / 2, c.y + c.height / 2, r, thick, 0, Math.PI * 2, s.track);
    p.arc(c.x + c.width / 2, c.y + c.height / 2, r, thick, this.angle, this.angle + Math.PI * 1.4, s.accent);
  }
}

// ====================================================================== Badge, StatDisplay, NumericDisplay, StatusIndicator

export class Badge extends Label {
  static override styleName = "Badge";

  constructor(options: LabelOptions & { count?: number } = {}) {
    super({ ...options, text: options.count !== undefined ? String(options.count) : options.text, align: "center" });
    this.accessibility.role = "status";
  }

  set count(n: number) {
    this.text = n > 99 ? "99+" : String(n);
  }

  protected override measureContent(availableWidth: number, h: number, ctx: LayoutContext): { width: number; height: number } {
    const s = super.measureContent(availableWidth, h, ctx);
    // At least as wide as tall: a single digit reads as a circle.
    const pad = this.paddingBox;
    return { width: Math.max(s.width, s.height + pad.top + pad.bottom - pad.left - pad.right), height: s.height };
  }
}

export class StatDisplay extends UIElement {
  static override styleName = "StatDisplay";
  private readonly labelPart: TextPart;
  private readonly valuePart: TextPart;
  private readonly deltaPart = new TextPart("");
  private _delta = 0;
  private _labelKey: string | null;

  constructor(options: UIElementOptions & { label?: string; labelKey?: string; value?: string | number; delta?: number } = {}) {
    super(options);
    this.labelPart = new TextPart(options.label ?? "", { overflow: "ellipsis" });
    this.valuePart = new TextPart(String(options.value ?? ""));
    this._labelKey = options.labelKey ?? null;
    this.pointerEvents = options.tooltip ? "auto" : "none";
    this.accessibility.role = "text";
    this.delta = options.delta ?? 0;
    this.syncA11y();
  }

  get label(): string {
    return this.labelPart.text;
  }
  set label(t: string) {
    if (this.labelPart.set(t)) {
      this.syncA11y();
      this.invalidateLayout();
    }
  }

  get value(): string {
    return this.valuePart.text;
  }
  set value(v: string | number) {
    if (this.valuePart.set(String(v))) {
      this.syncA11y();
      this.invalidateLayout();
    }
  }

  /** Signed change shown after the value (+3 green / −2 red); 0 hides it. */
  get delta(): number {
    return this._delta;
  }
  set delta(d: number) {
    this._delta = d;
    this.deltaPart.set(d === 0 ? "" : d > 0 ? `+${d}` : `-${-d}`);
    this.invalidateLayout();
  }

  private syncA11y(): void {
    this.accessibility.label = this.labelPart.text;
    this.accessibility.value = this.valuePart.text;
  }

  protected override onAttach(ctx: UIContext): void {
    if (this._labelKey) this.label = ctx.localizer.t(this._labelKey);
  }

  onLocaleChanged(): void {
    if (this._labelKey && this.context) this.label = this.context.localizer.t(this._labelKey);
  }

  protected override measureContent(availableWidth: number): { width: number; height: number } {
    const s = this.computedStyle;
    const l = this.labelPart.layout(this.context, s, availableWidth);
    const v = this.valuePart.layout(this.context, s, Infinity);
    const d = this.deltaPart.layout(this.context, s, Infinity, s.fontSize * 0.85);
    const w = (l?.width ?? 0) + s.spacing * 2 + (v?.width ?? 0) + (this._delta !== 0 ? s.spacing + (d?.width ?? 0) : 0);
    return { width: w, height: Math.max(l?.height ?? 0, v?.height ?? 0) };
  }

  protected override paintContent(p: UIPainter, s: ResolvedStyle): void {
    const c = this.contentRect;
    const d = this._delta !== 0 ? this.deltaPart.layout(this.context, s, Infinity, s.fontSize * 0.85) : null;
    const v = this.valuePart.layout(this.context, s, Infinity);
    const dw = d ? d.width + s.spacing : 0;
    const vw = v?.width ?? 0;
    const l = this.labelPart.layout(this.context, s, Math.max(0, c.width - vw - dw - s.spacing));
    this.labelPart.paint(p, l, c.x, c.y, c.width, c.height, withAlpha(s.foreground, 0.72), "start");
    this.valuePart.paint(p, v, c.x, c.y, c.width - dw, c.height, s.accent, "end");
    if (d) {
      const pos = typeof s.custom.positive === "number" ? s.custom.positive : 0x4ade80ff;
      const neg = typeof s.custom.negative === "number" ? s.custom.negative : 0xf87171ff;
      this.deltaPart.paint(p, d, c.x, c.y, c.width, c.height, this._delta > 0 ? pos : neg, "end");
    }
  }
}

export interface NumericFormat {
  decimals?: number;
  prefix?: string;
  suffix?: string;
  /** Thousands separator ("" for none). */
  separator?: string;
}

export function formatNumber(v: number, f: NumericFormat = {}): string {
  const decimals = f.decimals ?? 0;
  const sep = f.separator ?? ",";
  const fixed = Math.abs(v).toFixed(decimals);
  const [int, frac] = fixed.split(".");
  const grouped = sep ? int!.replace(/\B(?=(\d{3})+(?!\d))/g, sep) : int!;
  return `${v < 0 && Number(fixed) !== 0 ? "-" : ""}${f.prefix ?? ""}${grouped}${frac ? `.${frac}` : ""}${f.suffix ?? ""}`;
}

/** A number that counts up/down to new values (`duration` seconds; instant with reduced motion). */
export class NumericDisplay extends Label {
  static override styleName = "NumericDisplay";
  private _target: number;
  private _shown: number;
  format: NumericFormat;
  duration: number;

  constructor(options: LabelOptions & { value?: number; format?: NumericFormat; duration?: number } = {}) {
    super(options);
    this._target = options.value ?? 0;
    this._shown = this._target;
    this.format = options.format ?? {};
    this.duration = options.duration ?? 0.4;
    super.text = formatNumber(this._shown, this.format);
  }

  get value(): number {
    return this._target;
  }
  set value(v: number) {
    if (v === this._target) return;
    this._target = v;
    const ctx = this.context;
    if (ctx && this.duration > 0) {
      ctx.animator.tween(this, "shown", this._shown, v, (x) => this.show(x), { duration: this.duration, easing: "easeOutCubic" });
    } else this.show(v);
  }

  /** The number currently displayed (mid-animation it lags `value`). */
  get shown(): number {
    return this._shown;
  }

  private show(x: number): void {
    this._shown = x;
    super.text = formatNumber(x, this.format);
  }
}

export type Status = "online" | "away" | "busy" | "offline" | "error" | "success" | "warning";

const STATUS_COLORS: Record<Status, UIColor> = {
  online: 0x22c55eff,
  success: 0x22c55eff,
  away: 0xf59e0bff,
  warning: 0xf59e0bff,
  busy: 0xef4444ff,
  error: 0xef4444ff,
  offline: 0x9ca3afff,
};

export class StatusIndicator extends UIElement {
  static override styleName = "StatusIndicator";
  private _status: Status;
  private readonly labelPart: TextPart;

  constructor(options: UIElementOptions & { status?: Status; label?: string } = {}) {
    super(options);
    this._status = options.status ?? "offline";
    this.labelPart = new TextPart(options.label ?? "");
    this.pointerEvents = options.tooltip ? "auto" : "none";
    this.accessibility.role = "status";
    this.accessibility.value = this._status;
  }

  get status(): Status {
    return this._status;
  }
  set status(s: Status) {
    if (s === this._status) return;
    this._status = s;
    this.accessibility.value = s;
    this.invalidateRender();
  }

  get label(): string {
    return this.labelPart.text;
  }
  set label(t: string) {
    if (this.labelPart.set(t)) this.invalidateLayout();
  }

  protected override measureContent(availableWidth: number): { width: number; height: number } {
    const s = this.computedStyle;
    const dot = s.iconSize * 0.6;
    const l = this.labelPart.text ? this.labelPart.layout(this.context, s, availableWidth) : null;
    return { width: dot + (l ? s.spacing + l.width : 0), height: Math.max(dot, l?.height ?? 0) };
  }

  protected override paintContent(p: UIPainter, s: ResolvedStyle): void {
    const c = this.contentRect;
    const dot = s.iconSize * 0.6;
    const custom = s.custom[this._status];
    const color = typeof custom === "number" ? custom : STATUS_COLORS[this._status];
    p.fillRect(c.x, c.y + (c.height - dot) / 2, dot, dot, color, dot / 2);
    if (this.labelPart.text) this.labelPart.paint(p, this.labelPart.layout(this.context, s, c.width - dot - s.spacing), c.x + dot + s.spacing, c.y, c.width - dot - s.spacing, c.height, s.foreground, "start");
  }
}
