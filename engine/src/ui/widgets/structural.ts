/**
 * Structural widgets: containers that arrange and frame other elements.
 *
 * | Widget | Layout | Notes |
 * | --- | --- | --- |
 * | `Panel` | flex column | skinned surface (`Panel` skin), takes pointer events |
 * | `Stack` / `HStack` / `VStack` | flex | unskinned, pass-through for pointers |
 * | `Grid` | grid | tracks, spans, `autoFill` columns |
 * | `Overlay` | stack | layers children over each other |
 * | `Canvas` | anchor | free placement (HUDs) |
 * | `SafeArea` | flex column | adds the viewport's safe-area insets to its padding |
 * | `Spacer` | — | flexible (or fixed) empty space |
 * | `Separator` | — | thin horizontal/vertical rule |
 * | `ScrollView` | — | one content child, clipped, wheel/touch/scrollbar/keyboard scrolling |
 * | `SplitPane` | — | two panes and a draggable divider |
 * | `CollapsiblePanel` | flex column | header toggle + animated reveal of its body |
 */

import { UsageError } from "../../core/errors.js";
import { UIContainer, type UIContainerOptions } from "../core/container.js";
import { UIElement, type UIElementOptions } from "../core/element.js";
import { UIRect, type UIInsets } from "../core/geometry.js";
import type { UIContext } from "../core/context.js";
import { AnchorLayout } from "../layout/anchor.js";
import { FlexLayout, type FlexOptions } from "../layout/flex.js";
import { GridLayout, type GridOptions } from "../layout/grid.js";
import { StackLayout } from "../layout/stack.js";
import type { Align, LayoutContext } from "../layout/types.js";
import { UIState, type ResolvedStyle } from "../style/types.js";
import type { UIPainter } from "../render/painter.js";
import { withAlpha } from "../core/color.js";
import { ScrollModel, TextPart, UIControl, attachScrolling } from "./base.js";
import { UICustomEvent, type InputSource, type UIPointerEvent } from "../input/events.js";

// ====================================================================== Panel & stacks

export interface StackOptions extends UIContainerOptions, FlexOptions {}

export class Stack extends UIContainer {
  static override styleName = "Stack";
  readonly flex: FlexLayout;

  constructor(options: StackOptions = {}) {
    const flex = new FlexLayout(options);
    super({ ...options, strategy: flex });
    this.flex = flex;
  }

  get direction(): "row" | "column" {
    return this.flex.direction;
  }
  set direction(d: "row" | "column") {
    if (d === this.flex.direction) return;
    this.flex.direction = d;
    this.invalidateLayout();
  }

  get gap(): number {
    return this.flex.gap;
  }
  set gap(g: number) {
    this.flex.gap = g;
    this.flex.lineGap = g;
    this.invalidateLayout();
  }

  get justify(): FlexOptions["justify"] {
    return this.flex.justify;
  }
  set justify(j: NonNullable<FlexOptions["justify"]>) {
    this.flex.justify = j;
    this.invalidateLayout();
  }

  get align(): Align {
    return this.flex.align;
  }
  set align(a: Align) {
    this.flex.align = a;
    this.invalidateLayout();
  }

  get wrap(): boolean {
    return this.flex.wrap;
  }
  set wrap(w: boolean) {
    this.flex.wrap = w;
    this.invalidateLayout();
  }
}

export class HStack extends Stack {
  constructor(options: StackOptions = {}) {
    super({ ...options, direction: "row" });
  }
}

export class VStack extends Stack {
  constructor(options: StackOptions = {}) {
    super({ ...options, direction: "column" });
  }
}

/** Skinned surface; flex column by default. */
export class Panel extends Stack {
  static override styleName = "Panel";

  constructor(options: StackOptions = {}) {
    super({ direction: "column", ...options });
    this.pointerEvents = "auto";
    if (this.accessibility.role === "generic") this.accessibility.role = "group";
  }
}

export interface GridWidgetOptions extends UIContainerOptions, GridOptions {}

export class Grid extends UIContainer {
  static override styleName = "Grid";
  readonly grid: GridLayout;

  constructor(options: GridWidgetOptions = {}) {
    const grid = new GridLayout(options);
    super({ ...options, strategy: grid });
    this.grid = grid;
  }

  /** Change the column tracks at runtime (responsive grids). */
  setColumns(columns: GridOptions["columns"]): void {
    this.grid.setColumns(columns);
    this.invalidateLayout();
  }
}

export class Overlay extends UIContainer {
  static override styleName = "Overlay";
  constructor(options: UIContainerOptions & { alignX?: Align; alignY?: Align } = {}) {
    super({ ...options, strategy: new StackLayout(options.alignX, options.alignY) });
  }
}

/** Free-form anchor container (HUD canvas). */
export class Canvas extends UIContainer {
  static override styleName = "Canvas";
  constructor(options: UIContainerOptions = {}) {
    super({ ...options, strategy: new AnchorLayout() });
  }
}

/** Pads its content by the viewport's safe-area insets (notches, rounded corners, overscan). */
export class SafeArea extends Stack {
  static override styleName = "SafeArea";
  private readonly combined: UIInsets = { top: 0, right: 0, bottom: 0, left: 0 };
  /** Which edges to protect (default all). */
  edges: { top: boolean; right: boolean; bottom: boolean; left: boolean };

  constructor(options: StackOptions & { edges?: Partial<SafeArea["edges"]> } = {}) {
    super({ direction: "column", ...options });
    this.edges = { top: true, right: true, bottom: true, left: true, ...options.edges };
  }

  override get paddingBox(): Readonly<UIInsets> {
    const base = super.paddingBox;
    const safe = this.context?.viewport.safeArea;
    const c = this.combined;
    c.top = base.top + (this.edges.top ? safe?.top ?? 0 : 0);
    c.right = base.right + (this.edges.right ? safe?.right ?? 0 : 0);
    c.bottom = base.bottom + (this.edges.bottom ? safe?.bottom ?? 0 : 0);
    c.left = base.left + (this.edges.left ? safe?.left ?? 0 : 0);
    return c;
  }
}

export class Spacer extends UIElement {
  static override styleName = "Spacer";
  constructor(options: UIElementOptions & { size?: number } = {}) {
    super(options);
    this.pointerEvents = "none";
    if (options.size !== undefined) this.setLayout({ width: options.size, height: options.size, flexGrow: 0, flexShrink: 0 });
    else if (options.layout?.flexGrow === undefined) this.setLayout({ flexGrow: 1 });
  }
}

export class Separator extends UIElement {
  static override styleName = "Separator";
  readonly orientation: "horizontal" | "vertical";

  constructor(options: UIElementOptions & { orientation?: "horizontal" | "vertical" } = {}) {
    super(options);
    this.orientation = options.orientation ?? "horizontal";
    this.pointerEvents = "none";
    this.accessibility.role = "separator";
    if (options.layout?.alignSelf === undefined) this.setLayout({ alignSelf: "stretch" });
  }

  protected override measureContent(): { width: number; height: number } {
    const t = Math.max(1, this.computedStyle.borderWidth || 1);
    return this.orientation === "horizontal" ? { width: 0, height: t } : { width: t, height: 0 };
  }

  protected override paintBackground(p: UIPainter, s: ResolvedStyle): void {
    const c = this.contentRect;
    const t = Math.max(1, s.borderWidth || 1);
    if (this.orientation === "horizontal") p.fillRect(c.x, c.y + (c.height - t) / 2, c.width, t, s.borderColor || s.foreground);
    else p.fillRect(c.x + (c.width - t) / 2, c.y, t, c.height, s.borderColor || s.foreground);
  }
}

// ====================================================================== ScrollView

export interface ScrollViewOptions extends UIElementOptions {
  direction?: "vertical" | "horizontal" | "both";
  content?: UIElement;
  /** Content layout when the view creates its own content container. */
  contentLayout?: FlexOptions;
  showScrollbars?: boolean;
}

const SCROLLBAR = 6;

/**
 * Clips one content element and scrolls it. Wheel scrolling chains to an outer scroller at the edges;
 * touch drags scroll (and suppress the click on whatever was under the finger); the scrollbar thumb
 * can be dragged; keyboard focus moving inside scrolls the focused element into view.
 */
export class ScrollView extends UIElement {
  static override styleName = "ScrollView";
  readonly scroll: ScrollModel;
  private _content: UIElement;
  showScrollbars: boolean;
  private thumbDrag: { axis: "x" | "y"; start: number; startScroll: number } | null = null;
  private readonly contentArea = new UIRect();

  constructor(options: ScrollViewOptions = {}) {
    super(options);
    const dir = options.direction ?? "vertical";
    this.scroll = new ScrollModel(dir !== "vertical", dir !== "horizontal");
    this.clipChildren = true;
    this.showScrollbars = options.showScrollbars ?? true;
    this._content = options.content ?? new UIContainer({ strategy: new FlexLayout({ direction: "column", ...options.contentLayout }) });
    this.insertChild(this._content);
    for (const d of attachScrolling(this, this.scroll, () => this.scrolled())) this.own(d);
    this.on("focusin", (e) => {
      const t = e.target;
      if (!t || t === this) return;
      this.revealElement(t);
    });
    // Scrollbar thumb dragging happens in the capture phase so the content never sees it.
    this.on("pointerdown", (e) => this.thumbDown(e), { capture: true });
    this.on("pointermove", (e) => this.thumbMove(e), { capture: true });
    this.on("pointerup", (e) => {
      if (this.thumbDrag) {
        this.thumbDrag = null;
        e.stopPropagation();
      }
    }, { capture: true });
    this.on("click", (e) => {
      if (this.suppressClick) {
        this.suppressClick = false;
        e.stopPropagation();
      }
    }, { capture: true });
  }

  private suppressClick = false;

  /** The scrolled element. For the default container, add children here. */
  get content(): UIElement {
    return this._content;
  }

  set content(el: UIElement) {
    if (el === this._content) return;
    this._content.dispose();
    this._content = el;
    this.insertChild(el);
  }

  /** Add to the default content container. */
  add<T extends UIElement>(child: T): T {
    if (!(this._content instanceof UIContainer)) throw new UsageError("ScrollView.add: the content element is not a container");
    return this._content.add(child);
  }

  get scrollX(): number {
    return this.scroll.x;
  }
  set scrollX(v: number) {
    if (this.scroll.set(v, this.scroll.y)) this.scrolled();
  }
  get scrollY(): number {
    return this.scroll.y;
  }
  set scrollY(v: number) {
    if (this.scroll.set(this.scroll.x, v)) this.scrolled();
  }

  /** Scroll to an offset, optionally animated (honours reduced motion). */
  scrollTo(x: number, y: number, animate = false): void {
    const ctx = this.context;
    if (!animate || !ctx) {
      if (this.scroll.set(x, y)) this.scrolled();
      return;
    }
    ctx.animator.animate(this as ScrollView, { scrollX: Math.max(0, Math.min(this.scroll.maxX, x)), scrollY: Math.max(0, Math.min(this.scroll.maxY, y)) }, { duration: 0.25, easing: "easeOutCubic" });
  }

  /** Scroll so `el` (a descendant) is fully visible. */
  revealElement(el: UIElement): void {
    if (!this.isAncestorOf(el)) return;
    const b = el.bounds;
    const v = this.contentArea;
    let moved = false;
    if (this.scroll.vertical) moved = this.scroll.reveal("y", b.y - v.y + this.scroll.y, b.y - v.y + this.scroll.y + b.height) || moved;
    if (this.scroll.horizontal) moved = this.scroll.reveal("x", b.x - v.x + this.scroll.x, b.x - v.x + this.scroll.x + b.width) || moved;
    if (moved) this.scrolled();
  }

  private scrolled(): void {
    // Only the content's position changes: re-arrange in place.
    this.invalidateArrangeOnly();
    this.invalidateRender();
  }

  /** Re-arrange this element without re-measuring its ancestors. */
  protected invalidateArrangeOnly(): void {
    this._arrangeDirty = true;
    for (let p = this.parent; p; p = p.parent) p._subtreeDirty = true;
    this.context?.markLayoutDirty(this);
  }

  protected override measureContent(availableWidth: number, availableHeight: number, ctx: LayoutContext): { width: number; height: number } {
    const s = this._content.measure(this.scroll.horizontal ? Infinity : availableWidth, this.scroll.vertical ? Infinity : availableHeight, ctx);
    // A scroller wants its content size but can be squeezed to anything.
    return { width: this.scroll.horizontal ? Math.min(s.width, availableWidth) : s.width, height: this.scroll.vertical ? Math.min(s.height, availableHeight) : s.height };
  }

  protected override arrangeContent(content: UIRect, ctx: LayoutContext): void {
    this.contentArea.copy(content);
    const c = this._content;
    const s = c.measure(this.scroll.horizontal ? Infinity : content.width, this.scroll.vertical ? Infinity : content.height, ctx);
    const w = this.scroll.horizontal ? Math.max(s.width, content.width) : content.width;
    const h = this.scroll.vertical ? Math.max(s.height, content.height) : content.height;
    const m = this.scroll;
    m.viewportWidth = content.width;
    m.viewportHeight = content.height;
    m.contentWidth = w;
    m.contentHeight = h;
    m.set(m.x, m.y);
    c.arrange(new UIRect(content.x - m.x, content.y - m.y, w, h), ctx);
  }

  private thumbRect(axis: "x" | "y"): UIRect | null {
    const m = this.scroll;
    const b = this.bounds;
    if (axis === "y") {
      if (!m.vertical || m.maxY <= 0) return null;
      const track = b.height;
      const len = Math.max(24, (track * m.viewportHeight) / m.contentHeight);
      const pos = (m.y / m.maxY) * (track - len);
      return new UIRect(b.right - SCROLLBAR - 2, b.y + pos, SCROLLBAR, len);
    }
    if (!m.horizontal || m.maxX <= 0) return null;
    const track = b.width;
    const len = Math.max(24, (track * m.viewportWidth) / m.contentWidth);
    const pos = (m.x / m.maxX) * (track - len);
    return new UIRect(b.x + pos, b.bottom - SCROLLBAR - 2, len, SCROLLBAR);
  }

  private thumbDown(e: UIPointerEvent): void {
    if (!this.showScrollbars) return;
    for (const axis of ["y", "x"] as const) {
      const r = this.thumbRect(axis);
      if (r && r.x - 4 <= e.x && e.x <= r.right + 4 && r.y <= e.y && e.y <= r.bottom) {
        this.thumbDrag = { axis, start: axis === "y" ? e.y : e.x, startScroll: axis === "y" ? this.scroll.y : this.scroll.x };
        this.suppressClick = true;
        e.stopPropagation();
        e.preventDefault();
        return;
      }
    }
  }

  private thumbMove(e: UIPointerEvent): void {
    const d = this.thumbDrag;
    if (!d) return;
    e.stopPropagation();
    const m = this.scroll;
    const b = this.bounds;
    if (d.axis === "y") {
      const len = Math.max(24, (b.height * m.viewportHeight) / m.contentHeight);
      const per = m.maxY / Math.max(1, b.height - len);
      this.scrollY = d.startScroll + (e.y - d.start) * per;
    } else {
      const len = Math.max(24, (b.width * m.viewportWidth) / m.contentWidth);
      const per = m.maxX / Math.max(1, b.width - len);
      this.scrollX = d.startScroll + (e.x - d.start) * per;
    }
  }

  protected override paintOverlay(p: UIPainter, s: ResolvedStyle): void {
    if (!this.showScrollbars) return;
    for (const axis of ["y", "x"] as const) {
      const r = this.thumbRect(axis);
      if (r) p.fillRect(r.x, r.y, r.width, r.height, withAlpha(s.foreground, this.thumbDrag ? 0.7 : 0.4), SCROLLBAR / 2);
    }
  }
}

// ====================================================================== SplitPane

/** Two panes split by a draggable divider (`ratio` = first pane's share). */
export class SplitPane extends UIElement {
  static override styleName = "SplitPane";
  readonly orientation: "horizontal" | "vertical";
  private _ratio: number;
  minFirst: number;
  minSecond: number;
  readonly first: UIContainer;
  readonly second: UIContainer;
  readonly divider: SplitDivider;

  constructor(options: UIElementOptions & { orientation?: "horizontal" | "vertical"; ratio?: number; minFirst?: number; minSecond?: number; first?: UIElement; second?: UIElement } = {}) {
    super(options);
    this.orientation = options.orientation ?? "horizontal";
    this._ratio = Math.max(0, Math.min(1, options.ratio ?? 0.5));
    this.minFirst = options.minFirst ?? 48;
    this.minSecond = options.minSecond ?? 48;
    this.pointerEvents = "children";
    this.first = new UIContainer({ name: "first", clipChildren: true });
    this.second = new UIContainer({ name: "second", clipChildren: true });
    this.divider = new SplitDivider(this);
    this.insertChild(this.first);
    this.insertChild(this.divider);
    this.insertChild(this.second);
    if (options.first) this.first.add(options.first);
    if (options.second) this.second.add(options.second);
  }

  get ratio(): number {
    return this._ratio;
  }
  set ratio(r: number) {
    const c = Math.max(0, Math.min(1, r));
    if (c === this._ratio) return;
    this._ratio = c;
    this.invalidateLayout();
    this.emit(new UICustomEvent("change", { property: "ratio", value: c }));
  }

  protected override arrangeContent(content: UIRect, ctx: LayoutContext): void {
    const horizontal = this.orientation === "horizontal";
    const total = horizontal ? content.width : content.height;
    const d = horizontal ? this.divider.measure(Infinity, content.height, ctx).width : this.divider.measure(content.width, Infinity, ctx).height;
    const avail = Math.max(0, total - d);
    let a = avail * this._ratio;
    a = Math.max(Math.min(this.minFirst, avail), Math.min(a, avail - Math.min(this.minSecond, avail)));
    const b = avail - a;
    if (horizontal) {
      this.first.arrange(new UIRect(content.x, content.y, a, content.height), ctx);
      this.divider.arrange(new UIRect(content.x + a, content.y, d, content.height), ctx);
      this.second.arrange(new UIRect(content.x + a + d, content.y, b, content.height), ctx);
    } else {
      this.first.arrange(new UIRect(content.x, content.y, content.width, a), ctx);
      this.divider.arrange(new UIRect(content.x, content.y + a, content.width, d), ctx);
      this.second.arrange(new UIRect(content.x, content.y + a + d, content.width, b), ctx);
    }
  }

  protected override measureContent(availableWidth: number, availableHeight: number, ctx: LayoutContext): { width: number; height: number } {
    const f = this.first.measure(availableWidth, availableHeight, ctx);
    const s = this.second.measure(availableWidth, availableHeight, ctx);
    return this.orientation === "horizontal" ? { width: f.width + s.width + 6, height: Math.max(f.height, s.height) } : { width: Math.max(f.width, s.width), height: f.height + s.height + 6 };
  }
}

/** The SplitPane's drag handle (focusable: arrow keys move it). */
export class SplitDivider extends UIControl {
  static override styleName = "SplitDivider";
  private dragStart = 0;
  private startRatio = 0;

  constructor(private readonly pane: SplitPane) {
    super({ accessibility: { role: "separator", label: "Resize" } });
    this.on("dragstart", () => {
      this.startRatio = this.pane.ratio;
      this.dragStart = 0;
    });
    this.on("drag", (e) => {
      const horizontal = this.pane.orientation === "horizontal";
      const c = this.pane.contentRect;
      const total = Math.max(1, (horizontal ? c.width : c.height) - (horizontal ? this.bounds.width : this.bounds.height));
      this.pane.ratio = this.startRatio + ((horizontal ? e.dx : e.dy) - this.dragStart) / total;
      e.stopPropagation();
    });
    this.on("navigate", (e) => {
      const horizontal = this.pane.orientation === "horizontal";
      const delta = horizontal ? (e.direction === "left" ? -0.05 : e.direction === "right" ? 0.05 : 0) : e.direction === "up" ? -0.05 : e.direction === "down" ? 0.05 : 0;
      if (delta !== 0) {
        this.pane.ratio += delta;
        e.preventDefault();
      }
    });
  }

  protected override measureContent(): { width: number; height: number } {
    const t = Math.max(4, this.computedStyle.minWidth || 6);
    return { width: t, height: t };
  }

  protected override paintContent(p: UIPainter, s: ResolvedStyle): void {
    const b = this.bounds;
    const c = this.hasState(UIState.Hovered) || this.hasState(UIState.Pressed) ? s.accent : s.borderColor;
    if (this.pane.orientation === "horizontal") p.fillRect(b.x + b.width / 2 - 1, b.y, 2, b.height, c);
    else p.fillRect(b.x, b.y + b.height / 2 - 1, b.width, 2, c);
  }
}

// ====================================================================== CollapsiblePanel

/** Body wrapper that reports `reveal × measured height` so the panel can animate open/closed. */
class CollapseBody extends UIContainer {
  static override styleName = "CollapseBody";
  private _reveal = 1;

  constructor() {
    super({ strategy: new FlexLayout({ direction: "column" }), clipChildren: true });
  }

  get reveal(): number {
    return this._reveal;
  }
  set reveal(v: number) {
    const c = Math.max(0, Math.min(1, v));
    if (c === this._reveal) return;
    this._reveal = c;
    this.invalidateLayout();
  }

  override measure(availableWidth: number, _availableHeight: number, ctx: LayoutContext): { width: number; height: number } {
    // The body is always as tall as its content (× reveal); the panel decides how much fits.
    const s = super.measure(availableWidth, Infinity, ctx);
    return { width: s.width, height: s.height * this._reveal };
  }

  protected override arrangeContent(content: UIRect, ctx: LayoutContext): void {
    // Children keep their full height; the body clips them while it animates.
    const full = super.measure(content.width, Infinity, ctx);
    const r = new UIRect(content.x, content.y, content.width, full.height);
    (this.layout as FlexLayout).arrangeContent(this, r, ctx);
  }
}

class CollapseHeader extends UIControl {
  static override styleName = "CollapseHeader";
  readonly label: TextPart;

  constructor(private readonly panel: CollapsiblePanel, title: string) {
    super({ accessibility: { role: "button", label: title } });
    this.label = new TextPart(title);
  }

  protected override onPress(_source: InputSource): void {
    this.panel.expanded = !this.panel.expanded;
  }

  protected override measureContent(availableWidth: number): { width: number; height: number } {
    const s = this.computedStyle;
    const l = this.label.layout(this.context, s, availableWidth);
    return { width: (l?.width ?? 0) + s.iconSize + s.spacing, height: Math.max(l?.height ?? 0, s.iconSize) };
  }

  protected override paintContent(p: UIPainter, s: ResolvedStyle): void {
    const c = this.contentRect;
    const ctx = this.context;
    if (!ctx) return;
    const glyph = ctx.text.layout({ text: this.panel.expanded ? "▼" : "▶", family: "default", size: s.iconSize * 0.7 });
    p.text(glyph, c.x + (s.iconSize - glyph.width) / 2, c.y + (c.height - glyph.height) / 2, s.foreground);
    this.label.paint(p, this.label.layout(ctx, s, c.width - s.iconSize - s.spacing), c.x + s.iconSize + s.spacing, c.y, c.width - s.iconSize - s.spacing, c.height, s.foreground, "start");
  }
}

export class CollapsiblePanel extends Stack {
  static override styleName = "CollapsiblePanel";
  readonly header: CollapseHeader;
  readonly body: CollapseBody;
  private _expanded: boolean;

  constructor(options: StackOptions & { title?: string; expanded?: boolean; animate?: boolean } = {}) {
    super({ direction: "column", ...options });
    this.pointerEvents = "auto";
    this.header = new CollapseHeader(this, options.title ?? "");
    this.body = new CollapseBody();
    this._expanded = options.expanded ?? true;
    this.body.reveal = this._expanded ? 1 : 0;
    this.body.visible = this._expanded;
    super.add(this.header);
    super.add(this.body);
    this.animated = options.animate ?? true;
  }

  animated: boolean;

  /** Children go into the collapsible body. */
  override add<T extends UIElement>(child: T): T {
    return this.body.add(child);
  }

  get title(): string {
    return this.header.label.text;
  }
  set title(t: string) {
    if (this.header.label.set(t)) this.header.invalidateLayout();
  }

  get expanded(): boolean {
    return this._expanded;
  }
  set expanded(v: boolean) {
    if (v === this._expanded) return;
    this._expanded = v;
    this.setStateBit(UIState.Expanded, v);
    this.header.setStateBit(UIState.Expanded, v);
    this.header.accessibility.value = v ? "expanded" : "collapsed";
    const ctx: UIContext | null = this.context;
    if (v) this.body.visible = true;
    if (ctx && this.animated) {
      ctx.animator.tween(this.body, "reveal", this.body.reveal, v ? 1 : 0, (x) => (this.body.reveal = x), {
        duration: 0.2,
        easing: "easeOutCubic",
        onComplete: () => {
          if (!this._expanded) this.body.visible = false;
        },
      });
    } else {
      this.body.reveal = v ? 1 : 0;
      if (!v) this.body.visible = false;
    }
    this.header.invalidateRender();
    this.emitToggle(v);
  }

  private emitToggle(v: boolean): void {
    if (!this.disposed) this.emit(new UICustomEvent("toggle", { expanded: v }));
  }
}
