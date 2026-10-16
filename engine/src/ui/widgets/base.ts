/**
 * Shared widget behaviour. Widgets are built from these instead of re-implementing focus, press,
 * selection, value ranges, scrolling and text in each class:
 *
 *  * `TextPart` — a cached text layout owned by a widget (re-laid out only when its inputs change).
 *  * `UIControl` — focusable, pressable element: pointer clicks and keyboard/gamepad `activate`
 *    become one `press(source)` call; disabled controls ignore both.
 *  * `RangeModel` — min/max/step clamping and snapping for sliders, bars and spinners.
 *  * `SelectionModel` — single or multiple selection over indices, with change notification.
 *  * `ScrollModel` — scroll offsets, extents, clamping, wheel and touch-drag handling, with scroll
 *    chaining (a nested scroller at its edge lets the wheel bubble to its parent).
 */

import { UsageError } from "../../core/errors.js";
import type { Disposable } from "../../core/events.js";
import { UIElement, type UIElementOptions } from "../core/element.js";
import type { UIContext } from "../core/context.js";
import type { ResolvedStyle, TextAlign } from "../style/types.js";
import { UIState } from "../style/types.js";
import type { TextLayoutResult, TextOverflow, WrapMode } from "../text/textLayout.js";
import { UIActionEvent, UICustomEvent, type InputSource, type UIDragEvent, type UIWheelEvent } from "../input/events.js";
import type { UIPainter } from "../render/painter.js";
import type { UIColor } from "../core/color.js";

// ====================================================================== TextPart

export interface TextPartOptions {
  wrap?: WrapMode;
  overflow?: TextOverflow;
  maxLines?: number;
  align?: TextAlign;
}

/** A widget's piece of text: holds its last layout and re-lays out only on change. */
export class TextPart {
  private _text = "";
  private layoutResult: TextLayoutResult | null = null;
  private key = "";
  wrap: WrapMode;
  overflow: TextOverflow;
  maxLines: number;
  align: TextAlign | null;

  constructor(text = "", options: TextPartOptions = {}) {
    this._text = text;
    this.wrap = options.wrap ?? "none";
    this.overflow = options.overflow ?? "visible";
    this.maxLines = options.maxLines ?? Infinity;
    this.align = options.align ?? null;
  }

  get text(): string {
    return this._text;
  }

  /** Returns true when the text changed (caller invalidates layout). */
  set(text: string): boolean {
    if (text === this._text) return false;
    this._text = text;
    this.layoutResult = null;
    return true;
  }

  /** Lay out for a width (∞ = natural width). Cached on (text, width, style). */
  layout(ctx: UIContext | null, style: ResolvedStyle, maxWidth: number, sizeOverride?: number): TextLayoutResult | null {
    if (!ctx) return null;
    const size = sizeOverride ?? style.fontSize;
    const wrapWidth = this.wrap === "none" && this.overflow === "visible" ? Infinity : maxWidth;
    const key = `${wrapWidth}|${size}|${style.fontFamily}|${style.fontWeight}|${style.lineHeight}|${style.letterSpacing}|${this.align ?? style.textAlign}|${ctx.text.textScale}`;
    if (this.layoutResult && key === this.key) return this.layoutResult;
    this.key = key;
    this.layoutResult = ctx.text.layout({
      text: this._text,
      family: ctx.text.hasFamily(style.fontFamily) ? style.fontFamily : "default",
      size,
      weight: style.fontWeight,
      maxWidth: wrapWidth,
      wrap: this.wrap,
      overflow: this.overflow,
      maxLines: this.maxLines,
      lineHeight: style.lineHeight,
      letterSpacing: style.letterSpacing,
      align: this.align ?? style.textAlign,
    });
    return this.layoutResult;
  }

  /** Last layout (null before the first). */
  get last(): TextLayoutResult | null {
    return this.layoutResult;
  }

  invalidate(): void {
    this.layoutResult = null;
  }

  /** Paint inside a box, aligned horizontally by `align` and vertically centred unless `top`. */
  paint(p: UIPainter, layout: TextLayoutResult | null, x: number, y: number, width: number, height: number, color: UIColor, align: TextAlign, vertical: "top" | "center" = "center"): void {
    if (!layout) return;
    const dx = align === "center" ? (width - layout.width) / 2 : align === "end" ? width - layout.width : 0;
    const dy = vertical === "center" ? (height - layout.height) / 2 : 0;
    p.text(layout, x + dx, y + dy, color);
  }
}

// ====================================================================== UIControl

export interface UIControlOptions extends UIElementOptions {
  /** Called on click, Enter/Space or gamepad A. */
  onPress?: (source: InputSource) => void;
}

/**
 * Base for interactive widgets: focusable, pressable, disabled-aware. Subclasses override `onPress`.
 * A keyboard/gamepad press flashes the `pressed` state for 0.1 s so it reads like a click.
 */
export abstract class UIControl extends UIElement {
  static override styleName = "Control";
  private readonly pressCallback: ((source: InputSource) => void) | null;
  /** Presses since creation (tests, diagnostics). */
  pressCount = 0;

  constructor(options: UIControlOptions = {}) {
    super(options);
    this.focusable = true;
    this.accessibility.role = this.accessibility.role === "generic" ? "button" : this.accessibility.role;
    this.pressCallback = options.onPress ?? null;
    this.on("click", (e) => {
      if (e.button !== 0 && e.pointerType === "mouse") return;
      // A click on a nested control belongs to that control only.
      if (nearestControl(e.target) !== this) return;
      this.press("pointer");
    });
    this.on("activate", (e) => {
      if (e.target !== this && !this.activatesFromDescendants) return;
      e.preventDefault();
      this.flashPressed();
      this.press(e.source);
    });
  }

  /** Whether `activate` aimed at a focused descendant presses this control (composite widgets). */
  protected get activatesFromDescendants(): boolean {
    return false;
  }

  /** Programmatic press (honours `enabled`). Returns false when disabled. */
  press(source: InputSource = "program"): boolean {
    if (!this.effectivelyEnabled || this.disposed) return false;
    this.pressCount++;
    this.onPress(source);
    this.pressCallback?.(source);
    if (!this.disposed) this.emit(new UICustomEvent("press", { source }));
    return true;
  }

  protected onPress(_source: InputSource): void {}

  private flashPressed(): void {
    const ctx = this.context;
    if (!ctx) return;
    // Start (and so cancel any running flash, whose onCancel clears the state) before setting it.
    ctx.animator.tween(this, "__pressFlash", 0, 1, () => {}, {
      duration: 0.1,
      essential: true,
      onComplete: () => this.setStateBit(UIState.Pressed, false),
      onCancel: () => this.setStateBit(UIState.Pressed, false),
    });
    this.setStateBit(UIState.Pressed, true);
  }

  /** Emit a two-way-bindable `change` event for `property`. */
  protected emitChange(property: string, value: unknown): void {
    if (!this.disposed) this.emit(new UICustomEvent("change", { property, value }));
  }

  /** Draw the focus ring when focus is keyboard/gamepad driven. */
  protected override paintOverlay(p: UIPainter, s: ResolvedStyle): void {
    const ctx = this.context;
    if (ctx && this.focused && ctx.focus.focusVisible) {
      const b = this.bounds;
      const r = s.radius.topLeft;
      p.strokeRect(b.x - 3, b.y - 3, b.width + 6, b.height + 6, s.accent, 2, r > 0 ? r + 3 : 0);
    }
  }
}

/** The closest `UIControl` at or above `el`. */
export function nearestControl(el: UIElement | null): UIControl | null {
  for (let e = el; e; e = e.parent) if (e instanceof UIControl) return e;
  return null;
}

/** Activate `el` as if by keyboard (tests, programmatic UI automation). */
export function activate(el: UIElement): boolean {
  const ev = new UIActionEvent("activate", "program");
  el.emit(ev);
  return ev.defaultPrevented;
}

// ====================================================================== RangeModel

export class RangeModel {
  constructor(
    public min = 0,
    public max = 1,
    public step = 0,
  ) {
    if (!(max >= min)) throw new UsageError(`ui range: max (${max}) must be >= min (${min})`);
    if (!(step >= 0)) throw new UsageError("ui range: step must be >= 0");
  }

  clamp(v: number): number {
    if (!Number.isFinite(v)) v = this.min;
    let x = Math.max(this.min, Math.min(this.max, v));
    if (this.step > 0) {
      x = this.min + Math.round((x - this.min) / this.step) * this.step;
      x = Math.max(this.min, Math.min(this.max, x));
      // Remove floating noise from the snap (0.1 + 0.2 → 0.3).
      const decimals = Math.max(0, -Math.floor(Math.log10(this.step)) + 2);
      x = Number(x.toFixed(Math.min(12, decimals)));
    }
    return x;
  }

  /** 0..1 position of a value. */
  fraction(v: number): number {
    return this.max === this.min ? 0 : (v - this.min) / (this.max - this.min);
  }

  fromFraction(f: number): number {
    return this.clamp(this.min + Math.max(0, Math.min(1, f)) * (this.max - this.min));
  }

  /** Keyboard increment: the step, or 1% of the range. */
  get increment(): number {
    return this.step > 0 ? this.step : (this.max - this.min) / 100;
  }
}

// ====================================================================== SelectionModel

export class SelectionModel {
  private selected = new Set<number>();
  private _anchor = -1;
  onChange: ((selection: readonly number[]) => void) | null = null;

  constructor(public mode: "single" | "multiple" | "none" = "single") {}

  get indices(): number[] {
    return [...this.selected].sort((a, b) => a - b);
  }

  get index(): number {
    return this.selected.size > 0 ? this.indices[0]! : -1;
  }

  has(i: number): boolean {
    return this.selected.has(i);
  }

  get anchor(): number {
    return this._anchor;
  }

  /** Select one index (replacing in single mode; `toggle`/`extend` in multiple mode). */
  select(i: number, opts: { toggle?: boolean; extend?: boolean } = {}): void {
    if (this.mode === "none") return;
    const before = this.indices.join(",");
    if (this.mode === "single" || (!opts.toggle && !opts.extend)) {
      this.selected.clear();
      if (i >= 0) this.selected.add(i);
      this._anchor = i;
    } else if (opts.extend && this._anchor >= 0) {
      this.selected.clear();
      const [a, b] = this._anchor < i ? [this._anchor, i] : [i, this._anchor];
      for (let k = a; k <= b; k++) this.selected.add(k);
    } else {
      if (this.selected.has(i)) this.selected.delete(i);
      else this.selected.add(i);
      this._anchor = i;
    }
    if (this.indices.join(",") !== before) this.onChange?.(this.indices);
  }

  clear(): void {
    if (this.selected.size === 0) return;
    this.selected.clear();
    this._anchor = -1;
    this.onChange?.([]);
  }

  /** Keep selection valid after the item count changed. */
  clampTo(count: number): void {
    let changed = false;
    for (const i of [...this.selected]) {
      if (i >= count) {
        this.selected.delete(i);
        changed = true;
      }
    }
    if (this._anchor >= count) this._anchor = count - 1;
    if (changed) this.onChange?.(this.indices);
  }
}

// ====================================================================== ScrollModel

/**
 * Scroll offsets for a scrolling widget. Owns wheel and touch-drag handling; the widget supplies the
 * viewport and content extents after arrangement.
 */
export class ScrollModel {
  x = 0;
  y = 0;
  viewportWidth = 0;
  viewportHeight = 0;
  contentWidth = 0;
  contentHeight = 0;
  /** Logical units per wheel "line" (DOM deltaMode 0 deltas are already pixels). */
  wheelScale = 1;

  constructor(
    public horizontal: boolean,
    public vertical: boolean,
  ) {}

  get maxX(): number {
    return Math.max(0, this.contentWidth - this.viewportWidth);
  }

  get maxY(): number {
    return Math.max(0, this.contentHeight - this.viewportHeight);
  }

  /** Clamp; returns true if the offsets changed. */
  set(x: number, y: number): boolean {
    const nx = this.horizontal ? Math.max(0, Math.min(this.maxX, x)) : 0;
    const ny = this.vertical ? Math.max(0, Math.min(this.maxY, y)) : 0;
    if (nx === this.x && ny === this.y) return false;
    this.x = nx;
    this.y = ny;
    return true;
  }

  /**
   * Apply a wheel delta. Consumes it (returns true) only if the offset actually moved — at an edge the
   * wheel event keeps bubbling so an outer scroller takes over (scroll chaining).
   */
  wheel(e: UIWheelEvent): boolean {
    let dx = e.deltaX * this.wheelScale;
    let dy = e.deltaY * this.wheelScale;
    if (this.horizontal && !this.vertical && dx === 0) {
      dx = dy;
      dy = 0;
    }
    return this.set(this.x + dx, this.y + dy);
  }

  /** Touch-drag scrolling from bubbling `drag` events (content moves with the finger). */
  dragBy(dx: number, dy: number): boolean {
    return this.set(this.x - dx, this.y - dy);
  }

  /** Scroll so [start, end) on an axis is visible. */
  reveal(axis: "x" | "y", start: number, end: number): boolean {
    if (axis === "y") {
      const view = this.viewportHeight;
      if (start < this.y) return this.set(this.x, start);
      if (end > this.y + view) return this.set(this.x, end - view);
    } else {
      const view = this.viewportWidth;
      if (start < this.x) return this.set(start, this.y);
      if (end > this.x + view) return this.set(end - view, this.y);
    }
    return false;
  }
}

/**
 * Wire wheel + touch drag + keyboard paging of a `ScrollModel` onto an element. Returns the
 * subscriptions (owned by the element).
 */
export function attachScrolling(el: UIElement, model: ScrollModel, onScroll: () => void): Disposable[] {
  let lastDx = 0;
  let lastDy = 0;
  return [
    el.on("wheel", (e) => {
      if (model.wheel(e)) {
        e.preventDefault();
        e.stopPropagation();
        onScroll();
      }
    }),
    el.on("dragstart", (e: UIDragEvent) => {
      lastDx = e.dx;
      lastDy = e.dy;
    }),
    el.on("drag", (e: UIDragEvent) => {
      if (e.pointerType !== "touch" || e.payload !== null) return;
      const moved = model.dragBy(e.dx - lastDx, e.dy - lastDy);
      lastDx = e.dx;
      lastDy = e.dy;
      if (moved) {
        e.stopPropagation();
        onScroll();
      }
    }),
  ];
}
