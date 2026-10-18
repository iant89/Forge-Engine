/**
 * Interactive controls. All derive from `UIControl` (focus, press from pointer/keyboard/gamepad,
 * disabled handling, focus ring) and report edits with `change` events carrying
 * `{ property, value }`, which is what two-way bindings listen to.
 *
 * Keyboard/gamepad conventions:
 *  * Enter / Space / A — press (buttons, toggles, checkboxes, radios, switches).
 *  * Left/Right (Up/Down for vertical) — adjust sliders; the `navigate` default (focus movement) is
 *    prevented only while the value can still move in that direction, so at the end of its range a
 *    slider lets focus continue to the next control.
 *  * Home / End / PageUp / PageDown — slider extremes and 10× steps.
 *  * Arrow keys inside a `RadioGroup` move the selection (roving focus).
 */

import { UIElement, type UIElementOptions } from "../core/element.js";
import type { UIContext } from "../core/context.js";
import type { ResolvedStyle } from "../style/types.js";
import { UIState } from "../style/types.js";
import type { UIPainter } from "../render/painter.js";
import type { LayoutContext } from "../layout/types.js";
import { FlexLayout } from "../layout/flex.js";
import { UIContainer, type UIContainerOptions } from "../core/container.js";
import { withAlpha } from "../core/color.js";
import { UICustomEvent, type InputSource, type UIKeyEvent, type UIPointerEvent } from "../input/events.js";
import { UIRect } from "../core/geometry.js";
import { RangeModel, TextPart, UIControl, type UIControlOptions } from "./base.js";
import { paintIcon } from "./display.js";

// ====================================================================== Button

export interface ButtonOptions extends UIControlOptions {
  text?: string;
  textKey?: string;
  icon?: string;
  /** Icon after the text instead of before it. */
  iconAfter?: boolean;
  /**
   * Second, smaller line under the text ("Continue" over "Ares Expo 2 · Sol 6"). Drawn in mixed case
   * at ~82 % size whatever the skin's `textTransform`; it is also the accessible description.
   */
  subtitle?: string;
}

export class Button extends UIControl {
  static override styleName = "Button";
  protected readonly label: TextPart;
  private _icon: string | null;
  private _textKey: string | null;
  iconAfter: boolean;
  private readonly sub = new TextPart("", { overflow: "ellipsis" });
  private subStyleFor: ResolvedStyle | null = null;
  private subStyle: ResolvedStyle | null = null;

  constructor(options: ButtonOptions = {}) {
    super(options);
    this.label = new TextPart(options.text ?? "", { overflow: "ellipsis" });
    if (options.subtitle) this.subtitle = options.subtitle;
    this._icon = options.icon ?? null;
    this._textKey = options.textKey ?? null;
    this.iconAfter = options.iconAfter ?? false;
    this.accessibility.label = this.accessibility.label || this.label.text || this._icon || "";
  }

  get text(): string {
    return this.label.text;
  }
  set text(t: string) {
    this._textKey = null;
    this.setText(t);
  }

  protected setText(t: string): void {
    if (this.label.set(t)) {
      this.accessibility.label = t;
      this.invalidateLayout();
    }
  }

  get textKey(): string | null {
    return this._textKey;
  }
  set textKey(k: string | null) {
    this._textKey = k;
    if (k && this.context) this.setText(this.context.localizer.t(k));
  }

  protected override onAttach(ctx: UIContext): void {
    if (this._textKey) this.setText(ctx.localizer.t(this._textKey));
  }

  onLocaleChanged(): void {
    if (this._textKey && this.context) this.setText(this.context.localizer.t(this._textKey));
  }

  get subtitle(): string {
    return this.sub.text;
  }
  set subtitle(t: string) {
    if (!this.sub.set(t)) return;
    this.accessibility.description = t;
    this.invalidateLayout();
  }

  /** The subtitle's style: derived from the button's (smaller, lighter, mixed case), cached per style. */
  private subtitleStyle(s: ResolvedStyle): ResolvedStyle {
    if (this.subStyleFor !== s || !this.subStyle) {
      this.subStyleFor = s;
      this.subStyle = { ...s, fontSize: Math.round(s.fontSize * 0.82 * 2) / 2, fontWeight: Math.min(s.fontWeight, 500), letterSpacing: Math.min(s.letterSpacing * 0.4, 1), textTransform: "none" };
    }
    return this.subStyle;
  }

  get icon(): string | null {
    return this._icon;
  }
  set icon(i: string | null) {
    if (i === this._icon) return;
    this._icon = i;
    this.invalidateLayout();
  }

  protected override measureContent(availableWidth: number, _h: number, _ctx: LayoutContext): { width: number; height: number } {
    const s = this.computedStyle;
    const iconW = this._icon ? s.iconSize : 0;
    const gap = this._icon && this.label.text ? s.spacing : 0;
    const textW = Math.max(0, availableWidth - iconW - gap);
    const l = this.label.text ? this.label.layout(this.context, s, textW) : null;
    const st = this.sub.text ? this.sub.layout(this.context, this.subtitleStyle(s), textW) : null;
    const blockW = Math.max(l?.width ?? 0, st?.width ?? 0);
    const blockH = (l?.height ?? 0) + (st ? st.height + 2 : 0);
    return { width: iconW + gap + Math.min(blockW, textW), height: Math.max(iconW, blockH) };
  }

  protected override paintContent(p: UIPainter, s: ResolvedStyle): void {
    const c = this.contentRect;
    const iconW = this._icon ? s.iconSize : 0;
    const gap = this._icon && this.label.text ? s.spacing : 0;
    const textW = Math.max(0, c.width - iconW - gap);
    const l = this.label.text ? this.label.layout(this.context, s, textW) : null;
    const st = this.sub.text ? this.sub.layout(this.context, this.subtitleStyle(s), textW) : null;
    const blockW = Math.max(l?.width ?? 0, st?.width ?? 0);
    const total = iconW + gap + blockW;
    const align = s.textAlign;
    let x = align === "center" ? c.x + (c.width - total) / 2 : align === "end" ? c.right - total : c.x;
    const iconY = c.y + (c.height - iconW) / 2;
    if (this._icon && !this.iconAfter) {
      paintIcon(this.context, p, this._icon, x, iconY, iconW, s.foreground);
      x += iconW + gap;
    }
    if (l || st) {
      const blockH = (l?.height ?? 0) + (st ? st.height + 2 : 0);
      const y = c.y + (c.height - blockH) / 2;
      const lineX = (w: number): number => (align === "center" ? x + (blockW - w) / 2 : align === "end" ? x + blockW - w : x);
      if (l) p.text(l, lineX(l.width), y, s.foreground);
      if (st) p.text(st, lineX(st.width), y + (l ? l.height + 2 : 0), withAlpha(s.foreground, 0.78));
      x += blockW + gap;
    }
    if (this._icon && this.iconAfter) paintIcon(this.context, p, this._icon, x, iconY, iconW, s.foreground);
  }
}

/** Icon-only button. Give it an accessible label (`accessibility.label` or `label`). */
export class IconButton extends Button {
  static override styleName = "IconButton";

  constructor(options: ButtonOptions & { label?: string } = {}) {
    super({ ...options, text: "" });
    if (options.label) this.accessibility.label = options.label;
    if (!this.tooltip && options.label) this.tooltip = options.label;
  }

  protected override onAttach(ctx: UIContext): void {
    super.onAttach(ctx);
    if (!this.accessibility.label || this.accessibility.label === this.icon) ctx.diagnostic("warn", `IconButton ${this.debugName} has no accessible label`, this);
  }
}

// ====================================================================== Toggles

/** A button that stays pressed (`checked`). */
export class ToggleButton extends Button {
  static override styleName = "ToggleButton";
  private _checked: boolean;

  constructor(options: ButtonOptions & { checked?: boolean; onChange?: (checked: boolean) => void } = {}) {
    super(options);
    this._checked = options.checked ?? false;
    this.onChangeCallback = options.onChange ?? null;
    this.accessibility.role = "switch";
    this.applyChecked();
  }

  private readonly onChangeCallback: ((checked: boolean) => void) | null;

  get checked(): boolean {
    return this._checked;
  }
  set checked(v: boolean) {
    if (v === this._checked) return;
    this._checked = v;
    this.applyChecked();
    this.onChangeCallback?.(v);
    this.emitChange("checked", v);
  }

  private applyChecked(): void {
    this.setStateBit(UIState.Checked, this._checked);
    this.accessibility.value = this._checked ? "on" : "off";
  }

  protected override onPress(_source: InputSource): void {
    this.checked = !this._checked;
  }
}

/** Box + check mark + label. `indeterminate` draws a dash and clears on the next press. */
export class Checkbox extends UIControl {
  static override styleName = "Checkbox";
  protected readonly label: TextPart;
  private _checked: boolean;
  private _indeterminate = false;
  private readonly onChangeCallback: ((checked: boolean) => void) | null;

  constructor(options: UIControlOptions & { text?: string; checked?: boolean; indeterminate?: boolean; onChange?: (checked: boolean) => void } = {}) {
    super(options);
    this.label = new TextPart(options.text ?? "");
    this._checked = options.checked ?? false;
    this._indeterminate = options.indeterminate ?? false;
    this.onChangeCallback = options.onChange ?? null;
    this.accessibility.role = "checkbox";
    this.accessibility.label = this.accessibility.label || this.label.text;
    this.sync();
  }

  get text(): string {
    return this.label.text;
  }
  set text(t: string) {
    if (this.label.set(t)) {
      this.accessibility.label = t;
      this.invalidateLayout();
    }
  }

  get checked(): boolean {
    return this._checked;
  }
  set checked(v: boolean) {
    if (v === this._checked && !this._indeterminate) return;
    this._checked = v;
    this._indeterminate = false;
    this.sync();
    this.onChangeCallback?.(v);
    this.emitChange("checked", v);
  }

  get indeterminate(): boolean {
    return this._indeterminate;
  }
  set indeterminate(v: boolean) {
    this._indeterminate = v;
    this.sync();
  }

  private sync(): void {
    this.setStateBit(UIState.Checked, this._checked && !this._indeterminate);
    this.accessibility.value = this._indeterminate ? "mixed" : this._checked ? "checked" : "unchecked";
    this.invalidateRender();
  }

  protected override onPress(): void {
    this.checked = this._indeterminate ? true : !this._checked;
  }

  protected override measureContent(availableWidth: number): { width: number; height: number } {
    const s = this.computedStyle;
    const box = s.iconSize;
    const l = this.label.text ? this.label.layout(this.context, s, Math.max(0, availableWidth - box - s.spacing)) : null;
    return { width: box + (l ? s.spacing + l.width : 0), height: Math.max(box, l?.height ?? 0) };
  }

  /** The box is drawn from the skin's accent/track/border; the element itself has no background. */
  protected override paintBackground(): void {}

  protected override paintContent(p: UIPainter, s: ResolvedStyle): void {
    const c = this.contentRect;
    const box = s.iconSize;
    const y = c.y + (c.height - box) / 2;
    const on = this._checked || this._indeterminate;
    p.box(c.x, y, box, box, { background: on ? s.accent : s.background || s.track, borderColor: on ? s.accent : s.borderColor, borderWidth: s.borderWidth || 1.5, radius: s.radius.topLeft });
    const mark = typeof s.custom.mark === "number" ? s.custom.mark : 0xffffffff;
    if (this._indeterminate) p.fillRect(c.x + box * 0.25, y + box * 0.45, box * 0.5, box * 0.12, mark, 1);
    else if (this._checked) paintIcon(this.context, p, "check", c.x + box * 0.1, y + box * 0.1, box * 0.8, mark);
    if (this.label.text) this.label.paint(p, this.label.layout(this.context, s, c.width - box - s.spacing), c.x + box + s.spacing, c.y, c.width - box - s.spacing, c.height, s.foreground, "start");
  }
}

export class Switch extends Checkbox {
  static override styleName = "Switch";
  /** Knob position 0..1, animated toward `checked`. */
  knob: number;

  constructor(options: UIControlOptions & { text?: string; checked?: boolean; onChange?: (checked: boolean) => void } = {}) {
    super(options);
    this.knob = options.checked ? 1 : 0;
    this.accessibility.role = "switch";
  }

  override get checked(): boolean {
    return super.checked;
  }
  override set checked(v: boolean) {
    const changed = v !== super.checked;
    super.checked = v;
    if (!changed) return;
    const ctx = this.context;
    if (ctx) ctx.animator.tween(this, "knob", this.knob, v ? 1 : 0, (k) => {
      this.knob = k;
      this.invalidateRender();
    }, { duration: 0.15, easing: "easeOut" });
    else this.knob = v ? 1 : 0;
  }

  protected override measureContent(availableWidth: number): { width: number; height: number } {
    const s = this.computedStyle;
    const h = s.iconSize;
    const w = h * 1.8;
    const l = this.text ? this.label.layout(this.context, s, Math.max(0, availableWidth - w - s.spacing)) : null;
    return { width: w + (l ? s.spacing + l.width : 0), height: Math.max(h, l?.height ?? 0) };
  }

  protected override paintContent(p: UIPainter, s: ResolvedStyle): void {
    const c = this.contentRect;
    const h = s.iconSize;
    const w = h * 1.8;
    const y = c.y + (c.height - h) / 2;
    const k = this.knob;
    const on = s.accent;
    const off = s.track;
    p.fillRect(c.x, y, w, h, k > 0.5 ? on : off, h / 2);
    const pad = h * 0.12;
    const d = h - pad * 2;
    p.fillRect(c.x + pad + (w - h) * k, y + pad, d, d, typeof s.custom.mark === "number" ? s.custom.mark : 0xffffffff, d / 2);
    if (this.text) this.label.paint(p, this.label.layout(this.context, s, c.width - w - s.spacing), c.x + w + s.spacing, c.y, c.width - w - s.spacing, c.height, s.foreground, "start");
  }
}

// ====================================================================== Radio

export class RadioButton extends UIControl {
  static override styleName = "RadioButton";
  private readonly label: TextPart;
  readonly value: string;
  private _checked = false;

  constructor(options: UIControlOptions & { text?: string; value?: string; checked?: boolean } = {}) {
    super(options);
    this.label = new TextPart(options.text ?? "");
    this.value = options.value ?? options.text ?? String(this.uid);
    this.accessibility.role = "radio";
    this.accessibility.label = this.accessibility.label || this.label.text;
    if (options.checked) this.checked = true;
  }

  get group(): RadioGroup | null {
    for (let e = this.parent; e; e = e.parent) if (e instanceof RadioGroup) return e;
    return null;
  }

  get checked(): boolean {
    return this._checked;
  }
  set checked(v: boolean) {
    if (v === this._checked) return;
    this._checked = v;
    this.setStateBit(UIState.Checked, v);
    this.accessibility.value = v ? "checked" : "unchecked";
    if (v) this.group?._select(this);
    this.emitChange("checked", v);
  }

  protected override onPress(): void {
    this.checked = true;
  }

  protected override measureContent(availableWidth: number): { width: number; height: number } {
    const s = this.computedStyle;
    const box = s.iconSize;
    const l = this.label.text ? this.label.layout(this.context, s, Math.max(0, availableWidth - box - s.spacing)) : null;
    return { width: box + (l ? s.spacing + l.width : 0), height: Math.max(box, l?.height ?? 0) };
  }

  protected override paintBackground(): void {}

  protected override paintContent(p: UIPainter, s: ResolvedStyle): void {
    const c = this.contentRect;
    const box = s.iconSize;
    const y = c.y + (c.height - box) / 2;
    p.box(c.x, y, box, box, { background: s.background || s.track, borderColor: this._checked ? s.accent : s.borderColor, borderWidth: s.borderWidth || 1.5, radius: box / 2 });
    if (this._checked) p.fillRect(c.x + box * 0.27, y + box * 0.27, box * 0.46, box * 0.46, s.accent, box * 0.23);
    if (this.label.text) this.label.paint(p, this.label.layout(this.context, s, c.width - box - s.spacing), c.x + box + s.spacing, c.y, c.width - box - s.spacing, c.height, s.foreground, "start");
  }
}

/**
 * Exclusive selection among descendant `RadioButton`s. Arrow keys move the selection and the
 * focus together (roving focus); only the checked radio is in the Tab order.
 */
export class RadioGroup extends UIContainer {
  static override styleName = "RadioGroup";
  private _value: string | null = null;
  private readonly onChangeCallback: ((value: string | null) => void) | null;

  constructor(options: UIContainerOptions & { direction?: "row" | "column"; gap?: number; value?: string; onChange?: (value: string | null) => void } = {}) {
    super({ ...options, strategy: new FlexLayout({ direction: options.direction ?? "column", gap: options.gap ?? 6 }) });
    this.accessibility.role = "radiogroup";
    this.onChangeCallback = options.onChange ?? null;
    this._value = options.value ?? null;
    this.on("navigate", (e) => {
      const radios = this.radios.filter((r) => r.effectivelyEnabled && r.visible);
      const cur = radios.findIndex((r) => r.focused);
      if (cur < 0) return;
      const step = e.direction === "down" || e.direction === "right" ? 1 : e.direction === "up" || e.direction === "left" ? -1 : 0;
      if (step === 0) return;
      e.preventDefault();
      const next = radios[(cur + step + radios.length) % radios.length]!;
      next.checked = true;
      next.focus(true);
    });
  }

  get radios(): RadioButton[] {
    const out: RadioButton[] = [];
    this.walk((e) => {
      if (e instanceof RadioButton) out.push(e);
    });
    return out;
  }

  get value(): string | null {
    return this._value;
  }
  set value(v: string | null) {
    const r = this.radios.find((x) => x.value === v);
    if (r) r.checked = true;
    else {
      for (const x of this.radios) x.checked = false;
      this.setValue(null);
    }
  }

  protected override onChildrenChanged(): void {
    const v = this._value;
    if (v !== null) for (const r of this.radios) if (r.value === v && !r.checked) r.checked = true;
    this.updateTabOrder();
  }

  /** @internal Called by a radio that became checked. */
  _select(radio: RadioButton): void {
    for (const r of this.radios) if (r !== radio && r.checked) r.checked = false;
    this.setValue(radio.value);
  }

  private setValue(v: string | null): void {
    this.updateTabOrder();
    if (v === this._value) return;
    this._value = v;
    this.onChangeCallback?.(v);
    this.emit(new UICustomEvent("change", { property: "value", value: v }));
  }

  private updateTabOrder(): void {
    const radios = this.radios;
    const anyChecked = radios.some((r) => r.checked);
    radios.forEach((r, i) => (r.tabIndex = r.checked || (!anyChecked && i === 0) ? 0 : -1));
  }
}

// ====================================================================== Slider

export interface SliderOptions extends UIControlOptions {
  value?: number;
  min?: number;
  max?: number;
  step?: number;
  orientation?: "horizontal" | "vertical";
  onChange?: (value: number) => void;
  /** Format for the accessible value text. */
  format?: (value: number) => string;
}

export class Slider extends UIControl {
  static override styleName = "Slider";
  protected readonly range: RangeModel;
  private _value: number;
  readonly orientation: "horizontal" | "vertical";
  private readonly onChangeCallback: ((value: number) => void) | null;
  format: (value: number) => string;

  constructor(options: SliderOptions = {}) {
    super(options);
    this.range = new RangeModel(options.min ?? 0, options.max ?? 1, options.step ?? 0);
    this._value = this.range.clamp(options.value ?? this.range.min);
    this.orientation = options.orientation ?? "horizontal";
    this.onChangeCallback = options.onChange ?? null;
    this.format = options.format ?? ((v) => String(Math.round(v * 100) / 100));
    this.accessibility.role = "slider";
    this.accessibility.value = this.format(this._value);
    this.on("pointerdown", (e) => this.setFromPointer(e));
    this.on("pointermove", (e) => {
      if (this.hasState(UIState.Pressed) || this.dragging) this.setFromPointer(e);
    });
    this.on("dragstart", () => (this.dragging = true));
    this.on("dragend", () => (this.dragging = false));
    this.on("navigate", (e) => {
      const horizontal = this.orientation === "horizontal";
      let dir = 0;
      if (horizontal && (e.direction === "left" || e.direction === "right")) dir = e.direction === "right" ? 1 : -1;
      if (!horizontal && (e.direction === "up" || e.direction === "down")) dir = e.direction === "up" ? 1 : -1;
      if (dir === 0) return;
      // At the end of the range, let focus move on.
      if ((dir > 0 && this._value >= this.range.max) || (dir < 0 && this._value <= this.range.min)) return;
      e.preventDefault();
      this.value = this._value + dir * this.range.increment;
    });
    this.on("keydown", (e: UIKeyEvent) => {
      const inc = this.range.increment;
      switch (e.key) {
        case "Home":
          this.value = this.range.min;
          break;
        case "End":
          this.value = this.range.max;
          break;
        case "PageUp":
          this.value = this._value + inc * 10;
          break;
        case "PageDown":
          this.value = this._value - inc * 10;
          break;
        default:
          return;
      }
      e.preventDefault();
    });
  }

  private dragging = false;

  get value(): number {
    return this._value;
  }
  set value(v: number) {
    const c = this.range.clamp(v);
    if (c === this._value) return;
    this._value = c;
    this.accessibility.value = this.format(c);
    this.invalidateRender();
    this.onChangeCallback?.(c);
    this.emitChange("value", c);
  }

  get min(): number {
    return this.range.min;
  }
  get max(): number {
    return this.range.max;
  }
  get step(): number {
    return this.range.step;
  }

  /** Track rectangle (content box minus the thumb's half-size margins). */
  protected track(): { x: number; y: number; length: number } {
    const c = this.contentRect;
    const t = this.thumbSize;
    return this.orientation === "horizontal" ? { x: c.x + t / 2, y: c.y + c.height / 2, length: Math.max(1, c.width - t) } : { x: c.x + c.width / 2, y: c.y + t / 2, length: Math.max(1, c.height - t) };
  }

  protected get thumbSize(): number {
    return this.computedStyle.iconSize;
  }

  protected fractionAt(e: UIPointerEvent): number {
    const t = this.track();
    return this.orientation === "horizontal" ? (e.x - t.x) / t.length : 1 - (e.y - t.y) / t.length;
  }

  protected setFromPointer(e: UIPointerEvent): void {
    if (!this.effectivelyEnabled) return;
    this.value = this.range.fromFraction(this.fractionAt(e));
  }

  protected override measureContent(): { width: number; height: number } {
    const t = this.thumbSize;
    return this.orientation === "horizontal" ? { width: 160, height: t } : { width: t, height: 160 };
  }

  protected override paintBackground(): void {}

  protected override paintContent(p: UIPainter, s: ResolvedStyle): void {
    this.paintTrack(p, s, 0, this.range.fraction(this._value));
    this.paintThumb(p, s, this.range.fraction(this._value), this.hasState(UIState.Pressed) || this.hasState(UIState.Hovered));
  }

  protected paintTrack(p: UIPainter, s: ResolvedStyle, f0: number, f1: number): void {
    const t = this.track();
    const thick = Math.max(2, s.borderWidth || 4);
    if (this.orientation === "horizontal") {
      p.fillRect(t.x, t.y - thick / 2, t.length, thick, s.track, thick / 2);
      p.fillRect(t.x + t.length * f0, t.y - thick / 2, t.length * (f1 - f0), thick, s.accent, thick / 2);
    } else {
      p.fillRect(t.x - thick / 2, t.y, thick, t.length, s.track, thick / 2);
      p.fillRect(t.x - thick / 2, t.y + t.length * (1 - f1), thick, t.length * (f1 - f0), s.accent, thick / 2);
    }
  }

  protected paintThumb(p: UIPainter, s: ResolvedStyle, f: number, hot: boolean): void {
    const t = this.track();
    const d = this.thumbSize;
    const cx = this.orientation === "horizontal" ? t.x + t.length * f : t.x;
    const cy = this.orientation === "horizontal" ? t.y : t.y + t.length * (1 - f);
    if (hot) p.fillRect(cx - d * 0.8, cy - d * 0.8, d * 1.6, d * 1.6, withAlpha(s.accent, 0.2), d * 0.8);
    p.box(cx - d / 2, cy - d / 2, d, d, { background: typeof s.custom.thumb === "number" ? s.custom.thumb : 0xffffffff, borderColor: s.accent, borderWidth: 2, radius: d / 2, shadowColor: 0x00000055, shadowBlur: 3, shadowOffsetY: 1 });
  }
}

/** Two thumbs selecting `[low, high]`. Each thumb is a focusable child (Tab moves between them). */
export class RangeSlider extends UIElement {
  static override styleName = "RangeSlider";
  readonly range: RangeModel;
  private _low: number;
  private _high: number;
  readonly lowThumb: RangeThumb;
  readonly highThumb: RangeThumb;
  private readonly onChangeCallback: ((low: number, high: number) => void) | null;
  private active: RangeThumb | null = null;

  constructor(options: UIElementOptions & { min?: number; max?: number; step?: number; low?: number; high?: number; onChange?: (low: number, high: number) => void } = {}) {
    super(options);
    this.range = new RangeModel(options.min ?? 0, options.max ?? 1, options.step ?? 0);
    this._low = this.range.clamp(options.low ?? this.range.min);
    this._high = this.range.clamp(Math.max(this._low, options.high ?? this.range.max));
    this.onChangeCallback = options.onChange ?? null;
    this.accessibility.role = "group";
    this.lowThumb = new RangeThumb(this, "low");
    this.highThumb = new RangeThumb(this, "high");
    this.insertChild(this.lowThumb);
    this.insertChild(this.highThumb);
    this.on("pointerdown", (e) => {
      if (!this.effectivelyEnabled) return;
      const f = this.fractionAt(e.x);
      const v = this.range.fromFraction(f);
      this.active = Math.abs(v - this._low) <= Math.abs(v - this._high) ? this.lowThumb : this.highThumb;
      if (this._low === this._high) this.active = v < this._low ? this.lowThumb : this.highThumb;
      this.active.focus(false);
      this.setThumb(this.active.which, v);
    });
    this.on("pointermove", (e) => {
      if (this.active && (this.hasState(UIState.Pressed) || this.active.hasState(UIState.Pressed))) this.setThumb(this.active.which, this.range.fromFraction(this.fractionAt(e.x)));
    });
    this.on("pointerup", () => (this.active = null));
  }

  get low(): number {
    return this._low;
  }
  set low(v: number) {
    this.setThumb("low", v);
  }
  get high(): number {
    return this._high;
  }
  set high(v: number) {
    this.setThumb("high", v);
  }

  /** @internal */
  setThumb(which: "low" | "high", v: number): void {
    const c = this.range.clamp(v);
    if (which === "low") {
      const n = Math.min(c, this._high);
      if (n === this._low) return;
      this._low = n;
    } else {
      const n = Math.max(c, this._low);
      if (n === this._high) return;
      this._high = n;
    }
    this.lowThumb.accessibility.value = String(this._low);
    this.highThumb.accessibility.value = String(this._high);
    this.invalidateLayout();
    this.onChangeCallback?.(this._low, this._high);
    this.emit(new UICustomEvent("change", { property: which, value: which === "low" ? this._low : this._high }));
  }

  private fractionAt(x: number): number {
    const c = this.contentRect;
    const t = this.computedStyle.iconSize;
    return (x - c.x - t / 2) / Math.max(1, c.width - t);
  }

  protected override measureContent(): { width: number; height: number } {
    return { width: 160, height: this.computedStyle.iconSize };
  }

  protected override arrangeContent(content: UIRect, ctx: LayoutContext): void {
    const d = this.computedStyle.iconSize;
    const len = Math.max(1, content.width - d);
    this.lowThumb.arrange(new UIRect(content.x + len * this.range.fraction(this._low), content.y + (content.height - d) / 2, d, d), ctx);
    this.highThumb.arrange(new UIRect(content.x + len * this.range.fraction(this._high), content.y + (content.height - d) / 2, d, d), ctx);
  }

  protected override paintContent(p: UIPainter, s: ResolvedStyle): void {
    const c = this.contentRect;
    const d = s.iconSize;
    const thick = Math.max(2, s.borderWidth || 4);
    const x0 = c.x + d / 2;
    const len = Math.max(1, c.width - d);
    const y = c.y + c.height / 2 - thick / 2;
    p.fillRect(x0, y, len, thick, s.track, thick / 2);
    const a = this.range.fraction(this._low);
    const b = this.range.fraction(this._high);
    p.fillRect(x0 + len * a, y, len * (b - a), thick, s.accent, thick / 2);
  }
}

export class RangeThumb extends UIControl {
  static override styleName = "RangeThumb";

  constructor(
    owner: RangeSlider,
    readonly which: "low" | "high",
  ) {
    super({ accessibility: { role: "slider", label: which === "low" ? "Minimum" : "Maximum" } });
    this.on("navigate", (e) => {
      if (e.direction !== "left" && e.direction !== "right") return;
      const dir = e.direction === "right" ? 1 : -1;
      const cur = which === "low" ? owner.low : owner.high;
      const lim = dir > 0 ? (which === "low" ? owner.high : owner.range.max) : which === "low" ? owner.range.min : owner.low;
      if ((dir > 0 && cur >= lim) || (dir < 0 && cur <= lim)) return;
      e.preventDefault();
      owner.setThumb(which, cur + dir * owner.range.increment);
    });
  }

  protected override paintContent(p: UIPainter, s: ResolvedStyle): void {
    const b = this.bounds;
    p.box(b.x, b.y, b.width, b.height, { background: typeof s.custom.thumb === "number" ? s.custom.thumb : 0xffffffff, borderColor: s.accent, borderWidth: 2, radius: b.width / 2, shadowColor: 0x00000055, shadowBlur: 3, shadowOffsetY: 1 });
  }

  protected override paintBackground(): void {}
}
