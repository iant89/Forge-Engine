/**
 * Game widgets, built only from the public component API (the same base classes, painter and events
 * any custom component uses). They model HUD presentation, not gameplay: a `HealthBar` shows numbers
 * it is given; nothing here knows about damage, inventories or abilities beyond the data passed in.
 *
 * | Widget | What it shows / does |
 * | --- | --- |
 * | `HealthBar`, `ShieldBar` (`ResourceBar`) | value/max with a lagging damage trail and an `alert` state below `lowThreshold` |
 * | `ResourceCounter` | icon + animated count + floating "+N" gains |
 * | `CooldownIndicator` | radial sweep + seconds remaining; fires `ready` |
 * | `AbilityButton` | icon, hotkey, cost; refuses presses while cooling down |
 * | `InventorySlot`, `EquipmentSlot` | item icon + stack count; drag source and drop target; rich tooltip |
 * | `ItemTooltip` | rarity-coloured name, type, stats, description |
 * | `ObjectiveTracker`, `QuestTracker` | objectives with progress, quests as collapsible groups |
 * | `MinimapContainer` | map image window, markers clamped to the edge, player arrow |
 * | `WorldSpaceLabel` | children positioned over a projected world point, distance fade, occlusion hook |
 * | `TargetHealthDisplay` | name, level, health and shield of the current target |
 * | `InteractionPrompt` | key cap + action, optional hold progress |
 * | `RadialMenu` | wedge menu selected by pointer angle or stick direction |
 * | `DialogueBox` | speaker + typewriter text + choices |
 * | `Hotbar` | numbered row of ability buttons with `handleKey` |
 */

import { UIElement, type UIElementOptions } from "../core/element.js";
import type { UIContext } from "../core/context.js";
import { UIContainer, type UIContainerOptions } from "../core/container.js";
import { UIRect } from "../core/geometry.js";
import type { LayoutContext } from "../layout/types.js";
import { StackLayout } from "../layout/stack.js";
import type { ResolvedStyle } from "../style/types.js";
import { UIState } from "../style/types.js";
import type { UIPainter } from "../render/painter.js";
import { parseColor, withAlpha, type ColorInput, type UIColor } from "../core/color.js";
import { UICustomEvent, type InputSource, type UIDragEvent } from "../input/events.js";
import { TextPart, UIControl, type UIControlOptions } from "./base.js";
import { Label, ProgressBar, StatDisplay, formatNumber, paintIcon, type ProgressOptions } from "./display.js";
import { Button, type ButtonOptions } from "./interactive.js";
import { CollapsiblePanel, Panel, Stack } from "./structural.js";
import { distanceFade, projectToViewport, type ProjectedPoint, type WorldCamera, type WorldPoint } from "../worldSpace.js";

// ====================================================================== Resource bars

export interface ResourceBarOptions extends ProgressOptions {
  /** Show "value / max" text. */
  showValues?: boolean;
  /** Fraction below which the bar enters the `alert` state. */
  lowThreshold?: number;
  /** Seconds the damage trail waits before catching up. */
  trailDelay?: number;
}

export class ResourceBar extends ProgressBar {
  static override styleName = "ResourceBar";
  /** The lagging "damage taken" value drawn behind the fill. */
  trailValue: number;
  lowThreshold: number;
  showValues: boolean;
  trailDelay: number;
  private readonly valueText = new TextPart("");

  constructor(options: ResourceBarOptions = {}) {
    super({ max: 100, ...options });
    this.trailValue = this.value;
    this.lowThreshold = options.lowThreshold ?? 0.25;
    this.showValues = options.showValues ?? true;
    this.trailDelay = options.trailDelay ?? 0.35;
    this.setStateBit(UIState.Alert, this.fraction <= this.lowThreshold);
  }

  protected override onValueChanged(from: number, to: number): void {
    this.setStateBit(UIState.Alert, this.fraction <= this.lowThreshold);
    const ctx = this.context;
    if (to >= this.trailValue || !ctx) {
      // Healing (or no animator): the trail snaps.
      this.trailValue = to;
      ctx?.animator.get(this, "trailValue")?.cancel();
      return;
    }
    // Damage: hold the trail at the pre-damage value, then ease it down.
    const start = Math.max(this.trailValue, from);
    this.trailValue = start;
    ctx.animator.tween(this, "trailValue", start, to, (v) => {
      this.trailValue = v;
      this.invalidateRender();
    }, { duration: 0.45, delay: this.trailDelay, easing: "easeInOut" });
  }

  protected override paintContent(p: UIPainter, s: ResolvedStyle): void {
    const trailColor = typeof s.custom.trail === "number" ? s.custom.trail : withAlpha(0xffffffff, 0.55);
    const tf = this.range.fraction(this.trailValue);
    if (tf > this.range.fraction(this.displayValue)) this.paintFill(p, s, tf, trailColor);
    this.paintFill(p, s, this.range.fraction(this.displayValue), s.accent);
    if (this.showValues) {
      const c = this.contentRect;
      this.valueText.set(`${Math.round(this.value)} / ${Math.round(this.max)}`);
      const l = this.valueText.layout(this.context, s, Infinity, Math.min(s.fontSize, Math.max(8, c.height - 2)));
      this.valueText.paint(p, l, c.x, c.y, c.width, c.height, s.foreground, "center");
    }
  }
}

export class HealthBar extends ResourceBar {
  static override styleName = "HealthBar";
  constructor(options: ResourceBarOptions = {}) {
    super(options);
    this.accessibility.label = this.accessibility.label || "Health";
  }
}

export class ShieldBar extends ResourceBar {
  static override styleName = "ShieldBar";
  constructor(options: ResourceBarOptions = {}) {
    super({ lowThreshold: 0, ...options });
    this.accessibility.label = this.accessibility.label || "Shield";
  }
}

// ====================================================================== ResourceCounter

export class ResourceCounter extends UIElement {
  static override styleName = "ResourceCounter";
  private _value: number;
  private shown: number;
  icon: string;
  private readonly text = new TextPart("");
  private readonly gains: { amount: number; age: number; part: TextPart }[] = [];
  /** Seconds a "+N" floats. */
  gainDuration = 1.1;

  constructor(options: UIElementOptions & { icon?: string; value?: number } = {}) {
    super(options);
    this.icon = options.icon ?? "diamond";
    this._value = options.value ?? 0;
    this.shown = this._value;
    this.pointerEvents = options.tooltip ? "auto" : "none";
    this.accessibility.role = "status";
    this.sync();
  }

  get value(): number {
    return this._value;
  }
  set value(v: number) {
    if (v === this._value) return;
    const delta = v - this._value;
    this._value = v;
    const ctx = this.context;
    if (ctx) {
      ctx.animator.tween(this, "shown", this.shown, v, (x) => {
        this.shown = x;
        this.sync();
      }, { duration: 0.35, easing: "easeOutCubic" });
      if (!ctx.reducedMotion) {
        this.gains.push({ amount: delta, age: 0, part: new TextPart(delta > 0 ? `+${formatNumber(delta)}` : formatNumber(delta)) });
        this.setTicking(true);
      }
    } else {
      this.shown = v;
      this.sync();
    }
    this.accessibility.value = String(v);
  }

  /** Floating gain labels currently alive (tests). */
  get floatingGains(): number {
    return this.gains.length;
  }

  private sync(): void {
    if (this.text.set(formatNumber(Math.round(this.shown)))) this.invalidateLayout();
    this.accessibility.value = String(this._value);
  }

  override update(dt: number): void {
    for (const g of this.gains) g.age += dt;
    while (this.gains.length > 0 && this.gains[0]!.age >= this.gainDuration) this.gains.shift();
    if (this.gains.length === 0) this.setTicking(false);
    this.invalidateRender();
  }

  protected override measureContent(): { width: number; height: number } {
    const s = this.computedStyle;
    // Reserve width for the widest digits so the counter does not jitter while counting.
    const l = this.text.layout(this.context, s, Infinity);
    return { width: s.iconSize + s.spacing + Math.max(l?.width ?? 0, s.fontSize * 2), height: Math.max(s.iconSize, l?.height ?? 0) };
  }

  protected override paintContent(p: UIPainter, s: ResolvedStyle): void {
    const c = this.contentRect;
    paintIcon(this.context, p, this.icon, c.x, c.y + (c.height - s.iconSize) / 2, s.iconSize, s.accent);
    const x = c.x + s.iconSize + s.spacing;
    this.text.paint(p, this.text.layout(this.context, s, Infinity), x, c.y, c.right - x, c.height, s.foreground, "start");
    for (const g of this.gains) {
      const t = g.age / this.gainDuration;
      const l = g.part.layout(this.context, s, Infinity, s.fontSize * 0.85);
      if (!l) continue;
      p.pushOpacity(1 - t);
      p.text(l, x, c.y - 4 - t * 22, g.amount >= 0 ? (typeof s.custom.positive === "number" ? s.custom.positive : 0x4ade80ff) : typeof s.custom.negative === "number" ? s.custom.negative : 0xf87171ff);
      p.popOpacity();
    }
  }
}

// ====================================================================== Cooldowns & abilities

/** Radial sweep showing remaining cooldown; fires `ready` (and flashes `alert`) when done. */
export class CooldownIndicator extends UIElement {
  static override styleName = "CooldownIndicator";
  private duration = 0;
  private remaining = 0;
  private readonly text = new TextPart("");
  showSeconds = true;

  constructor(options: UIElementOptions & { showSeconds?: boolean } = {}) {
    super(options);
    this.pointerEvents = "none";
    this.showSeconds = options.showSeconds ?? true;
    this.accessibility.role = "timer";
  }

  get active(): boolean {
    return this.remaining > 0;
  }

  get timeRemaining(): number {
    return this.remaining;
  }

  /** 0 (just started) .. 1 (ready). */
  get progress(): number {
    return this.duration <= 0 ? 1 : 1 - this.remaining / this.duration;
  }

  start(duration: number): void {
    this.duration = Math.max(0, duration);
    this.remaining = this.duration;
    this.setStateBit(UIState.Alert, false);
    this.setTicking(this.remaining > 0);
    this.invalidateRender();
  }

  reset(): void {
    this.remaining = 0;
    this.setTicking(false);
    this.invalidateRender();
  }

  override update(dt: number): void {
    if (this.remaining <= 0) return;
    this.remaining = Math.max(0, this.remaining - dt);
    this.accessibility.value = this.remaining > 0 ? `${this.remaining.toFixed(1)}s` : "ready";
    this.invalidateRender();
    if (this.remaining === 0) {
      this.setTicking(false);
      this.setStateBit(UIState.Alert, true);
      this.emit(new UICustomEvent("ready", null));
    }
  }

  protected override paintContent(p: UIPainter, s: ResolvedStyle): void {
    if (this.remaining <= 0) return;
    const b = this.bounds;
    const r = Math.min(b.width, b.height) / 2;
    const cx = b.x + b.width / 2;
    const cy = b.y + b.height / 2;
    const f = this.remaining / Math.max(1e-6, this.duration);
    // A ring as thick as its radius is a pie wedge.
    p.arc(cx, cy, r, r, Math.PI * 2 * (1 - f), Math.PI * 2, typeof s.custom.sweep === "number" ? s.custom.sweep : 0x000000aa);
    if (this.showSeconds && this.context) {
      this.text.set(this.remaining >= 10 ? String(Math.ceil(this.remaining)) : this.remaining.toFixed(1));
      this.text.paint(p, this.text.layout(this.context, s, Infinity, Math.max(9, r * 0.6)), b.x, b.y, b.width, b.height, s.foreground, "center");
    }
  }
}

export interface AbilityButtonOptions extends ButtonOptions {
  hotkey?: string;
  cooldown?: number;
  cost?: number;
  onUse?: (source: InputSource) => void;
}

export class AbilityButton extends Button {
  static override styleName = "AbilityButton";
  readonly cooldown: CooldownIndicator;
  cooldownTime: number;
  hotkey: string;
  cost: number;
  /** When false the ability is unaffordable (drawn dimmed, presses refused). */
  affordable = true;
  private readonly onUse: ((source: InputSource) => void) | null;
  private readonly hotkeyText: TextPart;
  private readonly costText: TextPart;

  constructor(options: AbilityButtonOptions = {}) {
    super({ ...options, text: "" });
    this.cooldownTime = options.cooldown ?? 0;
    this.hotkey = options.hotkey ?? "";
    this.cost = options.cost ?? 0;
    this.onUse = options.onUse ?? null;
    this.hotkeyText = new TextPart(this.hotkey);
    this.costText = new TextPart(this.cost > 0 ? String(this.cost) : "");
    this.cooldown = new CooldownIndicator();
    this.insertChild(this.cooldown);
    this.cooldown.on("ready", () => {
      this.setStateBit(UIState.Loading, false);
      this.emit(new UICustomEvent("ready", null));
    });
    this.accessibility.label = this.accessibility.label || options.text || options.icon || "Ability";
  }

  get ready(): boolean {
    return !this.cooldown.active && this.affordable && this.effectivelyEnabled;
  }

  /** Press: refused while cooling down or unaffordable; otherwise uses the ability and starts the cooldown. */
  override press(source: InputSource = "program"): boolean {
    if (!this.ready) {
      this.emit(new UICustomEvent("refused", { reason: this.cooldown.active ? "cooldown" : "cost" }));
      return false;
    }
    if (!super.press(source)) return false;
    this.onUse?.(source);
    if (this.cooldownTime > 0) {
      this.cooldown.start(this.cooldownTime);
      this.setStateBit(UIState.Loading, true);
    }
    return true;
  }

  protected override measureContent(): { width: number; height: number } {
    const d = Math.max(32, this.computedStyle.minWidth || 52);
    return { width: d, height: d };
  }

  protected override arrangeContent(content: UIRect, ctx: LayoutContext): void {
    this.cooldown.arrange(this.bounds.clone(), ctx);
    void content;
  }

  protected override paintContent(p: UIPainter, s: ResolvedStyle): void {
    const b = this.bounds;
    const size = Math.min(b.width, b.height) * 0.6;
    const color = this.affordable ? s.foreground : withAlpha(s.foreground, 0.35);
    if (this.icon) paintIcon(this.context, p, this.icon, b.x + (b.width - size) / 2, b.y + (b.height - size) / 2, size, color);
    if (this.hotkey) {
      this.hotkeyText.set(this.hotkey);
      const l = this.hotkeyText.layout(this.context, s, Infinity, Math.max(8, s.fontSize * 0.75));
      if (l) p.text(l, b.x + 4, b.y + 2, withAlpha(s.foreground, 0.8));
    }
    if (this.cost > 0) {
      this.costText.set(String(this.cost));
      const l = this.costText.layout(this.context, s, Infinity, Math.max(8, s.fontSize * 0.75));
      if (l) p.text(l, b.right - l.width - 4, b.bottom - l.height - 1, this.affordable ? s.accent : 0xf87171ff);
    }
  }
}

// ====================================================================== Inventory

export interface InventoryItem {
  id: string;
  name: string;
  icon: string;
  count?: number;
  rarity?: "common" | "uncommon" | "rare" | "epic" | "legendary";
  type?: string;
  stats?: Record<string, number>;
  description?: string;
}

export const RARITY_COLORS: Record<NonNullable<InventoryItem["rarity"]>, UIColor> = {
  common: 0xd1d5dbff,
  uncommon: 0x4ade80ff,
  rare: 0x60a5faff,
  epic: 0xc084fcff,
  legendary: 0xfbbf24ff,
};

/** Rich item tooltip (shown by slots; usable on its own). */
export class ItemTooltip extends Panel {
  static override styleName = "ItemTooltip";
  private readonly nameLabel: Label;
  private readonly typeLabel: Label;
  private readonly stats: Stack;
  private readonly description: Label;

  constructor(item: InventoryItem | null = null) {
    super({ direction: "column", gap: 4 });
    this.pointerEvents = "none";
    this.accessibility.role = "tooltip";
    this.setLayout({ width: 220 });
    this.nameLabel = this.add(new Label({ variant: "strong" }));
    this.typeLabel = this.add(new Label({ variant: "muted" }));
    this.stats = this.add(new Stack({ direction: "column", gap: 2 }));
    this.description = this.add(new Label({ wrap: "word", variant: "muted" }));
    if (item) this.setItem(item);
  }

  setItem(item: InventoryItem): void {
    this.nameLabel.text = item.name;
    this.nameLabel.color = RARITY_COLORS[item.rarity ?? "common"];
    this.typeLabel.text = [item.rarity ? item.rarity[0]!.toUpperCase() + item.rarity.slice(1) : "", item.type ?? ""].filter(Boolean).join(" ");
    this.typeLabel.visible = this.typeLabel.text.length > 0;
    this.stats.clear();
    for (const [k, v] of Object.entries(item.stats ?? {})) this.stats.add(new StatDisplay({ label: k, value: v > 0 ? `+${v}` : String(v) }));
    this.description.text = item.description ?? "";
    this.description.visible = !!item.description;
    this.accessibility.label = item.name;
  }
}

export interface DragPayload {
  item: InventoryItem;
  from: InventorySlot;
}

export interface InventorySlotOptions extends UIControlOptions {
  item?: InventoryItem | null;
  /** Decide whether a dragged item may be dropped here. */
  accepts?: (item: InventoryItem) => boolean;
  /** Called on drop; default swaps the two slots' items. */
  onDrop?: (from: InventorySlot, to: InventorySlot) => void;
  tooltipDelay?: number;
}

export class InventorySlot extends UIControl {
  static override styleName = "InventorySlot";
  private _item: InventoryItem | null;
  accepts: (item: InventoryItem) => boolean;
  private readonly onDropCallback: ((from: InventorySlot, to: InventorySlot) => void) | null;
  /** Drop feedback while an item is dragged over the slot. */
  dropState: "none" | "accept" | "reject" = "none";
  private readonly countText = new TextPart("");
  private tooltipPanel: ItemTooltip | null = null;
  private hoverTime = -1;
  tooltipDelay: number;

  constructor(options: InventorySlotOptions = {}) {
    super(options);
    this._item = options.item ?? null;
    this.accepts = options.accepts ?? (() => true);
    this.onDropCallback = options.onDrop ?? null;
    this.tooltipDelay = options.tooltipDelay ?? 0.35;
    this.accessibility.role = "gridcell";
    this.sync();
    this.on("dragstart", (e: UIDragEvent) => {
      if (this._item && this.effectivelyEnabled) {
        e.payload = { item: this._item, from: this } satisfies DragPayload;
        this.hideTooltip();
      }
    });
    this.on("dragenter", (e: UIDragEvent) => this.dragOver(e));
    this.on("dragover", (e: UIDragEvent) => this.dragOver(e));
    this.on("dragleave", () => this.setDrop("none"));
    this.on("drop", (e: UIDragEvent) => {
      const payload = e.payload as DragPayload | null;
      this.setDrop("none");
      if (!payload || payload.from === this || !this.accepts(payload.item)) return;
      e.stopPropagation();
      if (this.onDropCallback) this.onDropCallback(payload.from, this);
      else InventorySlot.swap(payload.from, this);
      this.emit(new UICustomEvent("itemdrop", { from: payload.from, to: this }));
    });
    this.on("pointerenter", () => {
      this.hoverTime = 0;
      this.setTicking(true);
    });
    this.on("pointerleave", () => this.hideTooltip());
    this.on("focus", (e) => {
      if (e.visible) this.showTooltip();
    });
    this.on("blur", () => this.hideTooltip());
  }

  /** Default drop behaviour: exchange items (respecting both slots' `accepts`). */
  static swap(a: InventorySlot, b: InventorySlot): boolean {
    const ia = a.item;
    const ib = b.item;
    if ((ia && !b.accepts(ia)) || (ib && !a.accepts(ib))) return false;
    a.item = ib;
    b.item = ia;
    return true;
  }

  get item(): InventoryItem | null {
    return this._item;
  }
  set item(i: InventoryItem | null) {
    this._item = i;
    this.sync();
  }

  private sync(): void {
    this.countText.set(this._item && (this._item.count ?? 1) > 1 ? String(this._item.count) : "");
    this.accessibility.label = this._item ? `${this._item.name}${this._item.count && this._item.count > 1 ? ` ×${this._item.count}` : ""}` : "Empty slot";
    this.invalidateRender();
    if (this.tooltipPanel && this._item) this.tooltipPanel.setItem(this._item);
    else if (this.tooltipPanel) this.hideTooltip();
  }

  private dragOver(e: UIDragEvent): void {
    const payload = e.payload as DragPayload | null;
    if (!payload || payload.from === this) return;
    this.setDrop(this.accepts(payload.item) ? "accept" : "reject");
  }

  private setDrop(s: "none" | "accept" | "reject"): void {
    if (s === this.dropState) return;
    this.dropState = s;
    this.setStateBit(UIState.Invalid, s === "reject");
    this.invalidateRender();
  }

  override update(dt: number): void {
    if (this.hoverTime < 0) {
      this.setTicking(false);
      return;
    }
    this.hoverTime += dt;
    if (this.hoverTime >= this.tooltipDelay) {
      this.showTooltip();
      this.setTicking(false);
    }
  }

  /** Show the item tooltip next to the slot. */
  showTooltip(): void {
    const ctx: UIContext | null = this.context;
    if (!ctx || !this._item || this.tooltipPanel) return;
    const tip = new ItemTooltip(this._item);
    const b = this.bounds;
    const left = b.right + 8 + 220 <= ctx.viewport.width ? b.right + 8 : Math.max(0, b.x - 228);
    tip.setLayout({ anchor: { left, top: Math.max(0, Math.min(b.y, ctx.viewport.height - 160)) } });
    ctx.overlays.show(tip, "tooltip");
    this.tooltipPanel = tip;
  }

  hideTooltip(): void {
    this.hoverTime = -1;
    const t = this.tooltipPanel;
    this.tooltipPanel = null;
    if (t && !t.disposed) t.dispose();
  }

  get tooltipVisible(): boolean {
    return this.tooltipPanel !== null;
  }

  protected override onDetach(): void {
    this.hideTooltip();
  }

  protected override measureContent(): { width: number; height: number } {
    const d = Math.max(24, this.computedStyle.minWidth || 48);
    return { width: d, height: d };
  }

  protected override paintContent(p: UIPainter, s: ResolvedStyle): void {
    const b = this.bounds;
    if (this._item) {
      const size = Math.min(b.width, b.height) * 0.62;
      const rarity = RARITY_COLORS[this._item.rarity ?? "common"];
      if (this._item.rarity && this._item.rarity !== "common") p.strokeRect(b.x + 2, b.y + 2, b.width - 4, b.height - 4, withAlpha(rarity, 0.8), 2, Math.max(0, s.radius.topLeft - 2));
      paintIcon(this.context, p, this._item.icon, b.x + (b.width - size) / 2, b.y + (b.height - size) / 2, size, rarity);
      const l = this.countText.layout(this.context, s, Infinity, Math.max(8, s.fontSize * 0.8));
      if (l && this.countText.text) p.text(l, b.right - l.width - 4, b.bottom - l.height - 2, s.foreground);
    } else this.paintEmpty(p, s);
    if (this.dropState !== "none") p.strokeRect(b.x, b.y, b.width, b.height, this.dropState === "accept" ? s.accent : 0xef4444ff, 2, s.radius.topLeft);
  }

  protected paintEmpty(_p: UIPainter, _s: ResolvedStyle): void {}

  protected override onDispose(): void {
    this.hideTooltip();
  }
}

/** A slot that only accepts items of one `slotType` and shows a placeholder icon when empty. */
export class EquipmentSlot extends InventorySlot {
  static override styleName = "EquipmentSlot";
  readonly slotType: string;
  placeholderIcon: string;

  constructor(options: InventorySlotOptions & { slotType: string; placeholderIcon?: string }) {
    super({ ...options, accepts: (item) => item.type === options.slotType && (options.accepts?.(item) ?? true) });
    this.slotType = options.slotType;
    this.placeholderIcon = options.placeholderIcon ?? "square-outline";
    this.accessibility.description = `${options.slotType} slot`;
  }

  protected override paintEmpty(p: UIPainter, s: ResolvedStyle): void {
    const b = this.bounds;
    const size = Math.min(b.width, b.height) * 0.5;
    paintIcon(this.context, p, this.placeholderIcon, b.x + (b.width - size) / 2, b.y + (b.height - size) / 2, size, withAlpha(s.foreground, 0.25));
  }
}

// ====================================================================== Objectives & quests

export interface Objective {
  id: string;
  text: string;
  current?: number;
  target?: number;
  done?: boolean;
}

class ObjectiveRow extends UIElement {
  static override styleName = "ObjectiveRow";
  readonly text = new TextPart("", { wrap: "word" });
  readonly progress = new TextPart("");
  objective: Objective;

  constructor(o: Objective) {
    super({ accessibility: { role: "listitem" } });
    this.pointerEvents = "none";
    this.objective = o;
    this.set(o);
  }

  set(o: Objective): void {
    this.objective = o;
    const textChanged = this.text.set(o.text);
    const progressChanged = this.progress.set(o.target !== undefined ? `${Math.min(o.current ?? 0, o.target)}/${o.target}` : "");
    const changed = textChanged || progressChanged;
    this.setStateBit(UIState.Checked, this.done);
    this.accessibility.label = o.text;
    this.accessibility.value = this.done ? "complete" : this.progress.text;
    if (changed) this.invalidateLayout();
    this.invalidateRender();
  }

  get done(): boolean {
    const o = this.objective;
    return o.done ?? (o.target !== undefined && (o.current ?? 0) >= o.target);
  }

  protected override measureContent(availableWidth: number): { width: number; height: number } {
    const s = this.computedStyle;
    const pw = this.progress.layout(this.context, s, Infinity)?.width ?? 0;
    const l = this.text.layout(this.context, s, Math.max(0, availableWidth - s.iconSize - s.spacing * 2 - pw));
    return { width: s.iconSize + s.spacing * 2 + (l?.width ?? 0) + pw, height: Math.max(s.iconSize, l?.height ?? 0) };
  }

  protected override paintContent(p: UIPainter, s: ResolvedStyle): void {
    const c = this.contentRect;
    const done = this.done;
    paintIcon(this.context, p, done ? "check" : "bullet", c.x, c.y + 1, s.iconSize * 0.9, done ? s.accent : withAlpha(s.foreground, 0.6));
    const pl = this.progress.layout(this.context, s, Infinity);
    const pw = pl?.width ?? 0;
    const tx = c.x + s.iconSize + s.spacing;
    const color = done ? withAlpha(s.foreground, 0.5) : s.foreground;
    const tl = this.text.layout(this.context, s, Math.max(0, c.right - tx - pw - s.spacing));
    if (tl) p.text(tl, tx, c.y, color);
    if (pl && pw > 0) p.text(pl, c.right - pw, c.y, done ? s.accent : withAlpha(s.foreground, 0.75));
  }
}

export class ObjectiveTracker extends Stack {
  static override styleName = "ObjectiveTracker";
  private readonly rows = new Map<string, ObjectiveRow>();

  constructor(options: UIContainerOptions & { objectives?: Objective[] } = {}) {
    super({ ...options, direction: "column", gap: 4 });
    this.accessibility.role = "list";
    for (const o of options.objectives ?? []) this.setObjective(o);
  }

  /** Add or update an objective. Completing one flashes the `alert` state on its row. */
  setObjective(o: Objective): void {
    const row = this.rows.get(o.id);
    if (!row) {
      const r = new ObjectiveRow(o);
      this.rows.set(o.id, r);
      this.add(r);
      return;
    }
    const wasDone = row.done;
    row.set({ ...row.objective, ...o });
    if (!wasDone && row.done) {
      row.setStateBit(UIState.Alert, true);
      this.emit(new UICustomEvent("complete", { id: o.id }));
      const ctx = this.context;
      if (ctx) ctx.animator.tween(row, "__flash", 0, 1, () => {}, { duration: 1.2, essential: true, onComplete: () => row.setStateBit(UIState.Alert, false) });
    }
  }

  progress(id: string, current: number): void {
    const row = this.rows.get(id);
    if (row) this.setObjective({ ...row.objective, current });
  }

  removeObjective(id: string): void {
    this.rows.get(id)?.dispose();
    this.rows.delete(id);
  }

  get allComplete(): boolean {
    return [...this.rows.values()].every((r) => r.done);
  }

  isComplete(id: string): boolean {
    return this.rows.get(id)?.done ?? false;
  }
}

export class QuestTracker extends Stack {
  static override styleName = "QuestTracker";
  private readonly quests = new Map<string, { panel: CollapsiblePanel; tracker: ObjectiveTracker }>();

  constructor(options: UIContainerOptions = {}) {
    super({ ...options, direction: "column", gap: 8 });
    this.accessibility.role = "list";
  }

  addQuest(id: string, title: string, objectives: Objective[]): ObjectiveTracker {
    const panel = new CollapsiblePanel({ title, expanded: true });
    const tracker = new ObjectiveTracker({ objectives });
    panel.add(tracker);
    tracker.on("complete", () => {
      if (tracker.allComplete) this.emit(new UICustomEvent("questcomplete", { id }));
    });
    this.quests.set(id, { panel, tracker });
    this.add(panel);
    return tracker;
  }

  quest(id: string): ObjectiveTracker | null {
    return this.quests.get(id)?.tracker ?? null;
  }

  removeQuest(id: string): void {
    this.quests.get(id)?.panel.dispose();
    this.quests.delete(id);
  }
}

// ====================================================================== Minimap

export interface MapMarker {
  /** Position in map space, 0..1 on each axis. */
  x: number;
  y: number;
  color?: ColorInput;
  icon?: string;
  /** Keep the marker at the edge when it is outside the visible window. */
  clampToEdge?: boolean;
}

export class MinimapContainer extends UIElement {
  static override styleName = "MinimapContainer";
  /** Texture or sprite with the map image. */
  map: string;
  /** Visible window centre in map space (0..1). */
  centerX = 0.5;
  centerY = 0.5;
  /** Fraction of the map visible across the widget (1 = whole map). */
  zoom: number;
  circular: boolean;
  /** Player heading in radians (0 = up); drawn as the arrow's direction indicator. */
  heading = 0;
  markers: MapMarker[] = [];

  constructor(options: UIElementOptions & { map?: string; zoom?: number; circular?: boolean; size?: number } = {}) {
    super(options);
    this.map = options.map ?? "";
    this.zoom = options.zoom ?? 0.35;
    this.circular = options.circular ?? true;
    this.accessibility.role = "img";
    this.accessibility.label = this.accessibility.label || "Minimap";
    if (options.size) this.setLayout({ width: options.size, height: options.size });
  }

  setView(centerX: number, centerY: number, heading = this.heading): void {
    this.centerX = centerX;
    this.centerY = centerY;
    this.heading = heading;
    this.invalidateRender();
  }

  setMarkers(m: MapMarker[]): void {
    this.markers = m;
    this.invalidateRender();
  }

  /** Map-space point → widget-local position (and whether it was clamped to the edge). */
  mapToLocal(mx: number, my: number): { x: number; y: number; clamped: boolean } {
    const b = this.bounds;
    const r = Math.min(b.width, b.height) / 2;
    let dx = ((mx - this.centerX) / this.zoom) * 2 * r;
    let dy = ((my - this.centerY) / this.zoom) * 2 * r;
    let clamped = false;
    const limit = r - 6;
    if (this.circular) {
      const d = Math.hypot(dx, dy);
      if (d > limit) {
        dx = (dx / d) * limit;
        dy = (dy / d) * limit;
        clamped = true;
      }
    } else if (Math.abs(dx) > limit || Math.abs(dy) > limit) {
      const k = limit / Math.max(Math.abs(dx), Math.abs(dy));
      dx *= k;
      dy *= k;
      clamped = true;
    }
    return { x: r + dx, y: r + dy, clamped };
  }

  protected override measureContent(): { width: number; height: number } {
    const d = Math.max(64, this.computedStyle.minWidth || 160);
    return { width: d, height: d };
  }

  protected override paintContent(p: UIPainter, s: ResolvedStyle): void {
    const b = this.bounds;
    const size = Math.min(b.width, b.height);
    const ctx = this.context;
    const src = this.map && ctx ? ctx.assets.resolve(this.map) : null;
    if (src) {
      const w = src.width * this.zoom;
      const h = src.height * this.zoom;
      p.image(this.map, b.x, b.y, size, size, {
        source: { x: src.x + (this.centerX * src.width - w / 2), y: src.y + (this.centerY * src.height - h / 2), width: w, height: h },
        radius: this.circular ? size / 2 : s.radius.topLeft,
        tint: s.imageTint,
      });
    } else p.fillRect(b.x, b.y, size, size, s.track, this.circular ? size / 2 : s.radius.topLeft);
    for (const m of this.markers) {
      const pos = this.mapToLocal(m.x, m.y);
      if (pos.clamped && m.clampToEdge === false) continue;
      const color = m.color !== undefined ? parseColor(m.color) : s.accent;
      if (m.icon) paintIcon(ctx, p, m.icon, b.x + pos.x - 7, b.y + pos.y - 7, 14, color);
      else p.fillRect(b.x + pos.x - 4, b.y + pos.y - 4, 8, 8, color, 4);
    }
    // Player arrow at the centre, pointing along the heading (quantised to the 4 arrow glyphs).
    const dirs = ["triangle-up", "triangle-right", "triangle-down", "triangle-left"];
    const q = ((Math.round(this.heading / (Math.PI / 2)) % 4) + 4) % 4;
    paintIcon(ctx, p, dirs[q]!, b.x + size / 2 - 7, b.y + size / 2 - 7, 14, s.foreground);
    if (this.circular) p.arc(b.x + size / 2, b.y + size / 2, size / 2, Math.max(1, s.borderWidth), 0, Math.PI * 2, s.borderColor);
    else p.strokeRect(b.x, b.y, size, size, s.borderColor, Math.max(1, s.borderWidth), s.radius.topLeft);
    if (ctx) {
      const n = ctx.text.layout({ text: "N", family: "default", size: 11, weight: 700 });
      p.text(n, b.x + size / 2 - n.width / 2, b.y + 2, s.foreground);
    }
  }
}

// ====================================================================== World-space label

export interface WorldSpaceLabelOptions extends UIContainerOptions {
  /** World position to follow (read every frame). */
  target: () => WorldPoint;
  camera: () => WorldCamera | null;
  /** Logical units above the projected point. */
  offsetY?: number;
  fadeStart?: number;
  maxDistance?: number;
  /** Return true to hide (e.g. a physics ray says the point is occluded). */
  occluded?: (point: WorldPoint) => boolean;
}

/**
 * Children (a label, a health bar…) placed over a projected world point. Put it in the `hud` layer.
 * Positioning is a render translation, so following a target costs no layout; it is hidden behind the
 * camera, beyond `maxDistance` or when `occluded` says so, and fades between `fadeStart` and
 * `maxDistance`.
 */
export class WorldSpaceLabel extends UIContainer {
  static override styleName = "WorldSpaceLabel";
  private readonly target: () => WorldPoint;
  private readonly camera: () => WorldCamera | null;
  offsetY: number;
  fadeStart: number;
  maxDistance: number;
  occluded: ((point: WorldPoint) => boolean) | null;
  readonly projected: ProjectedPoint = { x: 0, y: 0, depth: 0, inFront: false, onScreen: false };
  /** Last computed visibility (tests). */
  shown = false;

  constructor(options: WorldSpaceLabelOptions) {
    super({ ...options, strategy: new StackLayout("center", "center") });
    this.target = options.target;
    this.camera = options.camera;
    this.offsetY = options.offsetY ?? 8;
    this.fadeStart = options.fadeStart ?? 30;
    this.maxDistance = options.maxDistance ?? 60;
    this.occluded = options.occluded ?? null;
    this.pointerEvents = "none";
    this.setLayout({ position: "absolute", anchor: { left: 0, top: 0 } });
    this.setTicking(true);
  }

  override update(): void {
    const ctx = this.context;
    const cam = this.camera();
    if (!ctx || !cam) return;
    const p = this.target();
    projectToViewport(p, cam.viewProj, ctx.viewport.width, ctx.viewport.height, this.projected);
    const dist = Math.hypot(p.x - cam.position.x, p.y - cam.position.y, p.z - cam.position.z);
    const fade = distanceFade(dist, this.fadeStart, this.maxDistance);
    const show = this.projected.inFront && fade > 0 && !(this.occluded?.(p) ?? false);
    this.shown = show;
    const alpha = show ? fade : 0;
    if (alpha !== this.opacity) this.opacity = alpha;
    if (!show) return;
    const tx = Math.round(this.projected.x - this.bounds.width / 2);
    const ty = Math.round(this.projected.y - this.bounds.height - this.offsetY);
    if (tx !== this.translateX) this.translateX = tx;
    if (ty !== this.translateY) this.translateY = ty;
  }
}

// ====================================================================== Target display & prompts

export interface TargetInfo {
  name: string;
  level?: number;
  health: number;
  maxHealth: number;
  shield?: number;
  maxShield?: number;
}

export class TargetHealthDisplay extends Panel {
  static override styleName = "TargetHealthDisplay";
  readonly nameLabel: Label;
  readonly levelLabel: Label;
  readonly health: HealthBar;
  readonly shield: ShieldBar;

  constructor(options: UIContainerOptions & { target?: TargetInfo } = {}) {
    super({ ...options, direction: "column", gap: 4 });
    this.accessibility.role = "status";
    const head = this.add(new Stack({ direction: "row", gap: 6, align: "center" }));
    this.levelLabel = head.add(new Label({ variant: "badge" }));
    this.nameLabel = head.add(new Label({ variant: "strong", overflow: "ellipsis" }));
    this.nameLabel.setLayout({ flexGrow: 1, flexShrink: 1 });
    this.health = this.add(new HealthBar({ value: 1, max: 1 }));
    this.shield = this.add(new ShieldBar({ value: 0, max: 1, visible: false }));
    this.setLayout({ width: 240 });
    if (options.target) this.setTarget(options.target);
  }

  setTarget(t: TargetInfo | null): void {
    this.visible = t !== null;
    if (!t) return;
    this.nameLabel.text = t.name;
    this.levelLabel.text = t.level !== undefined ? String(t.level) : "";
    this.levelLabel.visible = t.level !== undefined;
    this.health.max = t.maxHealth;
    this.health.value = t.health;
    this.shield.visible = (t.maxShield ?? 0) > 0;
    if (t.maxShield) {
      this.shield.max = t.maxShield;
      this.shield.value = t.shield ?? 0;
    }
    this.accessibility.label = `${t.name}${t.level !== undefined ? ` level ${t.level}` : ""}`;
    this.accessibility.value = `${Math.round(t.health)} of ${Math.round(t.maxHealth)}`;
  }
}

export class InteractionPrompt extends UIElement {
  static override styleName = "InteractionPrompt";
  private readonly keyText: TextPart;
  private readonly actionText: TextPart;
  private _hold = 0;

  constructor(options: UIElementOptions & { key?: string; action?: string } = {}) {
    super(options);
    this.keyText = new TextPart(options.key ?? "E");
    this.actionText = new TextPart(options.action ?? "Interact");
    this.pointerEvents = "none";
    this.accessibility.role = "status";
    this.accessibility.label = `${this.keyText.text}: ${this.actionText.text}`;
  }

  set key(k: string) {
    if (this.keyText.set(k)) this.invalidateLayout();
  }
  set action(a: string) {
    if (this.actionText.set(a)) this.invalidateLayout();
  }

  /** Hold-to-interact progress 0..1 (drawn as a ring around the key). */
  get hold(): number {
    return this._hold;
  }
  set hold(v: number) {
    const c = Math.max(0, Math.min(1, v));
    if (c === this._hold) return;
    this._hold = c;
    this.invalidateRender();
  }

  protected override measureContent(): { width: number; height: number } {
    const s = this.computedStyle;
    const cap = s.fontSize * 1.9;
    const l = this.actionText.layout(this.context, s, Infinity);
    return { width: cap + s.spacing + (l?.width ?? 0), height: Math.max(cap, l?.height ?? 0) };
  }

  protected override paintContent(p: UIPainter, s: ResolvedStyle): void {
    const c = this.contentRect;
    const cap = s.fontSize * 1.9;
    const y = c.y + (c.height - cap) / 2;
    p.box(c.x, y, cap, cap, { background: s.track, borderColor: s.foreground, borderWidth: 1.5, radius: 6 });
    this.keyText.paint(p, this.keyText.layout(this.context, s, Infinity), c.x, y, cap, cap, s.foreground, "center");
    if (this._hold > 0) p.arc(c.x + cap / 2, y + cap / 2, cap / 2 + 4, 3, 0, Math.PI * 2 * this._hold, s.accent);
    const x = c.x + cap + s.spacing;
    this.actionText.paint(p, this.actionText.layout(this.context, s, Infinity), x, c.y, c.right - x, c.height, s.foreground, "start");
  }
}

// ====================================================================== RadialMenu

export interface RadialItem {
  label: string;
  icon?: string;
  disabled?: boolean;
  onSelect?: () => void;
}

export class RadialMenu extends UIControl {
  static override styleName = "RadialMenu";
  items: RadialItem[];
  private _hovered = -1;
  /** Inner dead-zone radius as a fraction of the outer radius. */
  innerRatio = 0.38;
  private readonly centerText = new TextPart("");

  constructor(options: UIControlOptions & { items?: RadialItem[]; size?: number } = {}) {
    super(options);
    this.items = options.items ?? [];
    this.accessibility.role = "menu";
    if (options.size) this.setLayout({ width: options.size, height: options.size });
    this.on("pointermove", (e) => this.pointAt(e.x - (this.bounds.x + this.bounds.width / 2), e.y - (this.bounds.y + this.bounds.height / 2)));
    this.on("navigate", (e) => {
      const dirs: Record<string, [number, number]> = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };
      const d = dirs[e.direction];
      if (!d) return;
      e.preventDefault();
      this.pointAt(d[0] * 100, d[1] * 100);
    });
  }

  get hovered(): number {
    return this._hovered;
  }

  /** Sector index for a direction (12 o'clock = item 0, clockwise), or −1 inside the dead zone. */
  sectorAt(dx: number, dy: number): number {
    const r = Math.min(this.bounds.width, this.bounds.height) / 2;
    if (this.items.length === 0 || Math.hypot(dx, dy) < r * this.innerRatio) return -1;
    let a = Math.atan2(dx, -dy);
    if (a < 0) a += Math.PI * 2;
    const step = (Math.PI * 2) / this.items.length;
    return Math.floor(((a + step / 2) % (Math.PI * 2)) / step);
  }

  /** Aim with a stick or pointer offset from the centre. */
  pointAt(dx: number, dy: number): void {
    const i = this.sectorAt(dx, dy);
    const target = i >= 0 && this.items[i]?.disabled ? -1 : i;
    if (target === this._hovered) return;
    this._hovered = target;
    this.accessibility.value = this.items[target]?.label ?? "";
    this.invalidateRender();
  }

  protected override onPress(): void {
    const item = this.items[this._hovered];
    if (!item || item.disabled) return;
    item.onSelect?.();
    this.emit(new UICustomEvent("select", { index: this._hovered, item }));
  }

  protected override measureContent(): { width: number; height: number } {
    const d = Math.max(120, this.computedStyle.minWidth || 220);
    return { width: d, height: d };
  }

  protected override paintBackground(): void {}

  protected override paintContent(p: UIPainter, s: ResolvedStyle): void {
    const b = this.bounds;
    const r = Math.min(b.width, b.height) / 2;
    const cx = b.x + b.width / 2;
    const cy = b.y + b.height / 2;
    const n = this.items.length;
    const thick = r * (1 - this.innerRatio);
    const step = (Math.PI * 2) / Math.max(1, n);
    const gap = 0.025;
    for (let i = 0; i < n; i++) {
      const it = this.items[i]!;
      const a0 = i * step - step / 2 + gap;
      const a1 = i * step + step / 2 - gap;
      const color = i === this._hovered ? s.accent : withAlpha(s.background || 0x111827ff, it.disabled ? 0.4 : 0.85);
      p.arc(cx, cy, r, thick, a0, a1, color);
      const mid = i * step;
      const lr = r - thick / 2;
      const ix = cx + Math.sin(mid) * lr;
      const iy = cy - Math.cos(mid) * lr;
      if (it.icon) paintIcon(this.context, p, it.icon, ix - s.iconSize / 2, iy - s.iconSize / 2, s.iconSize, it.disabled ? withAlpha(s.foreground, 0.4) : s.foreground);
    }
    const hovered = this.items[this._hovered];
    this.centerText.set(hovered ? hovered.label : "");
    const l = this.centerText.layout(this.context, s, r * this.innerRatio * 2);
    if (l) p.text(l, cx - l.width / 2, cy - l.height / 2, s.foreground);
  }
}

// ====================================================================== DialogueBox

export class DialogueBox extends Panel {
  static override styleName = "DialogueBox";
  readonly speaker: Label;
  readonly body: Label;
  readonly choices: Stack;
  private full = "";
  private revealed = 0;
  /** Characters per second of the typewriter effect. */
  speed: number;

  constructor(options: UIContainerOptions & { speed?: number } = {}) {
    super({ ...options, direction: "column", gap: 8 });
    this.speed = options.speed ?? 45;
    this.accessibility.role = "dialog";
    this.speaker = this.add(new Label({ variant: "strong" }));
    this.body = this.add(new Label({ wrap: "word" }));
    this.choices = this.add(new Stack({ direction: "column", gap: 4 }));
    this.focusable = true;
    this.on("click", (e) => {
      if (e.target === this || e.target === this.body || e.target === this.speaker) this.advance();
    });
    this.on("activate", (e) => {
      if (e.target !== this) return;
      e.preventDefault();
      this.advance();
    });
  }

  /** Show a line; `choices` become buttons once the text is fully revealed. */
  say(speaker: string, text: string, choices: { text: string; onSelect: () => void }[] = []): void {
    this.speaker.text = speaker;
    this.speaker.visible = speaker.length > 0;
    this.full = text;
    this.revealed = 0;
    this.choices.clear();
    for (const c of choices) this.choices.add(new Button({ text: c.text, variant: "choice", onPress: () => c.onSelect() }));
    this.choices.visible = false;
    this.accessibility.label = `${speaker}: ${text}`;
    const ctx = this.context;
    if (!ctx || ctx.reducedMotion || this.speed <= 0) this.skip();
    else {
      this.body.text = "";
      this.setTicking(true);
    }
  }

  get revealing(): boolean {
    return this.revealed < Array.from(this.full).length;
  }

  /** Finish the typewriter immediately. */
  skip(): void {
    this.revealed = Array.from(this.full).length;
    this.body.text = this.full;
    this.setTicking(false);
    this.choices.visible = this.choices.children.length > 0;
    if (this.choices.visible) (this.choices.children[0] as Button).focus(true);
  }

  /** Click/activate: skip the reveal, or fire `advance` when the line is complete and has no choices. */
  advance(): void {
    if (this.revealing) this.skip();
    else if (this.choices.children.length === 0) this.emit(new UICustomEvent("advance", null));
  }

  override update(dt: number): void {
    const chars = Array.from(this.full);
    const next = Math.min(chars.length, this.revealed + dt * this.speed);
    if (Math.floor(next) !== Math.floor(this.revealed)) this.body.text = chars.slice(0, Math.floor(next)).join("");
    this.revealed = next;
    if (next >= chars.length) this.skip();
  }
}

// ====================================================================== Hotbar

export class Hotbar extends Stack {
  static override styleName = "Hotbar";
  readonly slots: AbilityButton[] = [];

  constructor(options: UIContainerOptions & { abilities?: AbilityButtonOptions[]; gap?: number } = {}) {
    super({ ...options, direction: "row", gap: options.gap ?? 6, align: "center" });
    this.accessibility.role = "toolbar";
    (options.abilities ?? []).forEach((a) => this.addAbility(a));
  }

  addAbility(options: AbilityButtonOptions): AbilityButton {
    const b = new AbilityButton({ hotkey: options.hotkey ?? String(this.slots.length + 1), ...options });
    this.slots.push(b);
    this.add(b);
    return b;
  }

  /** Route a key ("1".."9" or a slot's hotkey) to its ability. Returns true when a slot matched. */
  handleKey(key: string): boolean {
    const slot = this.slots.find((s) => s.hotkey.toLowerCase() === key.toLowerCase());
    if (!slot) return false;
    slot.press("keyboard");
    return true;
  }
}
