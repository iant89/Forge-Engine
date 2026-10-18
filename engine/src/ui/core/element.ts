/**
 * `UIElement` — the base of every UI component.
 *
 * Contract (docs/UI.md §5, pinned by `tests/ui/uiElement.test.ts`):
 *
 *  * **Ownership.** An element has at most one parent, which owns it. `dispose()` is recursive and
 *    final: it detaches the element, disposes its children, releases listeners, bindings, animations,
 *    focus, hover and pointer capture, and makes every mutating call throw `ObjectDisposedError`.
 *    Detaching (`UIContainer.remove`) does not dispose; the element can be re-added elsewhere.
 *  * **Hierarchy safety.** Inserting an element that already has a parent moves it (safe
 *    reparenting); inserting an element into itself or into one of its own descendants throws, so the
 *    tree can never contain a cycle or a node with two parents.
 *  * **Invalidation** is split four ways — style, measure, arrange, render — each a dirty flag that
 *    the manager consumes once per frame. A measure change walks up to the nearest *layout boundary*
 *    (an element whose width and height are both fixed), so a change deep in a fixed-size panel does
 *    not re-measure the whole screen.
 *  * **Measure / arrange** are separate: `measure(availableW, availableH)` returns the border-box size
 *    the element wants (cached until invalidated or the available space changes); `arrange(rect)`
 *    places it and, only if its rect or content changed, its children.
 *  * **Behaviour vs. appearance.** Elements read their look from the resolved skin style
 *    (`computedStyle`) and paint through the `UIPainter`; nothing here knows how the renderer batches.
 */

import { ObjectDisposedError, UsageError } from "../../core/errors.js";
import type { Disposable } from "../../core/events.js";
import type { UIContext } from "./context.js";
import { UIRect, type UIInsets, toInsets, ZERO_INSETS } from "./geometry.js";
import {
  applyLayoutInput,
  defaultLayoutProps,
  LengthUnit,
  resolveLength,
  type CompiledLayoutProps,
  type LayoutContext,
  type LayoutNode,
  type LayoutPropsInput,
  type LayoutStrategy,
} from "../layout/types.js";
import { arrangeAbsoluteChild } from "../layout/anchor.js";
import { StackLayout } from "../layout/stack.js";
import { dispatchUIEvent, listenerHandle, type ListenerRecord, type UIEvent, type UIEventListener, type UIEventMap } from "../input/events.js";
import type { ResolvedStyle, StyleBlock } from "../style/types.js";
import { UIState } from "../style/types.js";
import type { UIPainter } from "../render/painter.js";

/** Pointer participation: `auto` (self + children), `children` (pass-through self), `none`. */
export type PointerEventsMode = "auto" | "children" | "none";

export interface AccessibilityInfo {
  role: string;
  label: string;
  description: string;
  /** Current value text for ranges/inputs ("75%", "On"). */
  value?: string;
}

let nextUid = 1;
/** Stateless: shared by every element without a layout strategy. */
const DEFAULT_STACK = new StackLayout();

/** Process-wide layout work counters (the manager reports per-frame deltas). */
export const LAYOUT_COUNTERS = { measures: 0, arranges: 0 };

const styleChainCache = new WeakMap<Function, readonly string[]>();

/** Fallback style before an element is attached to a manager (never painted). */
export const DETACHED_STYLE: ResolvedStyle = Object.freeze({
  background: 0,
  backgroundEnd: 0,
  gradient: "none",
  borderColor: 0,
  borderWidth: 0,
  radius: Object.freeze({ topLeft: 0, topRight: 0, bottomRight: 0, bottomLeft: 0 }),
  padding: ZERO_INSETS,
  foreground: 0xffffffff,
  accent: 0x3b82f6ff,
  track: 0x00000040,
  fontFamily: "default",
  fontSize: 14,
  fontWeight: 400,
  lineHeight: 1.25,
  letterSpacing: 0,
  textAlign: "start",
  textTransform: "none",
  opacity: 1,
  shadowColor: 0,
  shadowOffsetX: 0,
  shadowOffsetY: 0,
  shadowBlur: 0,
  image: null,
  imageSlice: null,
  imageTint: 0xffffffff,
  icon: null,
  iconSize: 16,
  spacing: 6,
  minWidth: 0,
  minHeight: 0,
  transition: Object.freeze([]),
  custom: Object.freeze({}),
}) as ResolvedStyle;

export interface UIElementOptions {
  id?: string;
  name?: string;
  variant?: string;
  style?: StyleBlock;
  layout?: LayoutPropsInput;
  visible?: boolean;
  enabled?: boolean;
  tooltip?: string;
  accessibility?: Partial<AccessibilityInfo>;
}

export abstract class UIElement implements LayoutNode {
  /** Skin component name for this class; subclasses override. The style chain is built from these. */
  static styleName = "Element";

  /** Process-unique numeric id (never reused). */
  readonly uid: number = nextUid++;
  /** Optional author id, unique within a manager (checked on attach). */
  readonly id: string | null;
  name: string;

  private _parent: UIElement | null = null;
  private readonly _children: UIElement[] = [];
  private _paintOrder: UIElement[] | null = null;
  private _context: UIContext | null = null;
  private _disposed = false;

  private _visible = true;
  private _enabled = true;
  private _opacity = 1;
  private _translateX = 0;
  private _translateY = 0;
  private _scale = 1;
  private _variant: string | null = null;
  private _styleOverrides: StyleBlock | null = null;
  private _styleClass: string | null = null;
  private _state = 0;
  private _tooltip: string | null = null;

  /** Clip children (and their hit testing) to this element's border box. */
  clipChildren = false;
  pointerEvents: PointerEventsMode = "auto";
  /** Receives keyboard focus (Tab order, gamepad navigation). */
  focusable = false;
  /** Tab order among focusables; ties keep tree order. Negative = focusable by pointer/program only. */
  tabIndex = 0;
  /** Contains focus traversal (Tab wraps inside) when set; modals are scopes automatically. */
  focusScope = false;
  readonly accessibility: AccessibilityInfo;

  /** Border box in viewport logical units (valid after layout). */
  readonly bounds = new UIRect();
  /** Content box (border box minus padding). */
  readonly contentRect = new UIRect();

  // ------------------------------------------------------------------ layout state
  private readonly _props: CompiledLayoutProps = defaultLayoutProps();
  private _layoutPadding: UIInsets | null = null;
  private readonly _margin: UIInsets = { top: 0, right: 0, bottom: 0, left: 0 };
  private _strategy: LayoutStrategy | null = null;
  /** @internal */ _measureDirty = true;
  /** @internal */ _arrangeDirty = true;
  /** @internal */ _subtreeDirty = true;
  private _cacheAvailW = NaN;
  private _cacheAvailH = NaN;
  private readonly _cacheSize = { width: 0, height: 0 };
  private readonly _lastArranged = new UIRect(NaN, NaN, NaN, NaN);
  /** @internal counters read by diagnostics */
  _measureCount = 0;
  /** @internal */ _arrangeCount = 0;
  /** @internal */ _invalidations = 0;

  // ------------------------------------------------------------------ style state
  /** @internal */ _styleDirty = true;
  private _computed: ResolvedStyle = DETACHED_STYLE;
  /** Painted style while a transition runs (null = paint `computedStyle`). */
  /** @internal */ _paintStyle: ResolvedStyle | null = null;

  // ------------------------------------------------------------------ events / ownership
  private _listenerMap: Map<string, ListenerRecord[]> | null = null;
  private readonly _owned: Disposable[] = [];

  constructor(options: UIElementOptions = {}) {
    this.id = options.id ?? null;
    this.name = options.name ?? options.id ?? "";
    this.accessibility = { role: "generic", label: "", description: "", ...options.accessibility };
    if (options.variant !== undefined) this._variant = options.variant;
    if (options.style) this._styleOverrides = options.style;
    if (options.layout) this.setLayout(options.layout);
    if (options.visible === false) this._visible = false;
    if (options.enabled === false) this._enabled = false;
    if (options.tooltip !== undefined) this._tooltip = options.tooltip;
    if (this._enabled === false) this._state |= UIState.Disabled;
  }

  // ================================================================== identity

  /** Registered component type name (set by the registry; class `styleName` otherwise). */
  get typeName(): string {
    return this._typeName ?? (this.constructor as typeof UIElement).styleName;
  }
  /** @internal */ _typeName: string | null = null;

  /** `console.log`/assertion output: the debug name, not the whole (cyclic) element graph. */
  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return `<${this.debugName}>`;
  }

  get debugName(): string {
    return `${this.typeName}${this.id ? `#${this.id}` : this.name ? `(${this.name})` : ""}[${this.uid}]`;
  }

  /**
   * Skin lookup chain, most generic first: the `styleName`s of the class hierarchy (deduplicated),
   * followed by `styleClass` when set. `IconButton` resolves `Element → Control → Button → IconButton`.
   */
  get styleChain(): readonly string[] {
    const ctor = this.constructor;
    let chain = styleChainCache.get(ctor);
    if (!chain) {
      const names: string[] = [];
      for (let p = ctor as unknown as { styleName?: string } | null; p && p !== Function.prototype; p = Object.getPrototypeOf(p) as { styleName?: string } | null) {
        const own = Object.prototype.hasOwnProperty.call(p, "styleName") ? p.styleName : undefined;
        if (own && !names.includes(own)) names.unshift(own);
      }
      chain = Object.freeze(names);
      styleChainCache.set(ctor, chain);
    }
    if (this._styleClass && !chain.includes(this._styleClass)) return [...chain, this._styleClass];
    return chain;
  }

  /** Extra skin component name layered last in the chain (style a plain `Button` as `TabButton`). */
  get styleClass(): string | null {
    return this._styleClass;
  }
  set styleClass(v: string | null) {
    if (v === this._styleClass) return;
    this._styleClass = v;
    this.invalidateStyle();
  }

  // ================================================================== tree

  get parent(): UIElement | null {
    return this._parent;
  }

  get children(): readonly UIElement[] {
    return this._children;
  }

  get context(): UIContext | null {
    return this._context;
  }

  get disposed(): boolean {
    return this._disposed;
  }

  get attached(): boolean {
    return this._context !== null;
  }

  /** True when `this` is `other` or one of its ancestors. */
  isAncestorOf(other: UIElement): boolean {
    for (let e: UIElement | null = other; e; e = e._parent) if (e === this) return true;
    return false;
  }

  /** Depth-first search of this subtree by author id. */
  findById(id: string): UIElement | null {
    if (this.id === id) return this;
    for (const c of this._children) {
      const f = c.findById(id);
      if (f) return f;
    }
    return null;
  }

  /** Visit this subtree depth-first (pre-order). Return `false` from `fn` to skip an element's children. */
  walk(fn: (el: UIElement) => boolean | void): void {
    if (fn(this) === false) return;
    for (const c of this._children) c.walk(fn);
  }

  /**
   * Insert `child` at `index` (default: end). Moves it out of its current parent first. Throws on
   * cycles, self-insertion and disposed elements. Protected so leaf widgets can compose internal
   * parts while only containers expose `add`.
   */
  protected insertChild(child: UIElement, index = this._children.length): UIElement {
    this.assertLive();
    if (child._disposed) throw new ObjectDisposedError(`UI element ${child.debugName}`);
    if (child === this) throw new UsageError(`ui: cannot add ${this.debugName} to itself`);
    if (child.isAncestorOf(this)) throw new UsageError(`ui: adding ${child.debugName} under ${this.debugName} would create a cycle`);
    if (child._parent === this) {
      const at = this._children.indexOf(child);
      const target = Math.max(0, Math.min(index, this._children.length - 1));
      if (at !== target) {
        this._children.splice(at, 1);
        this._children.splice(target, 0, child);
        this._paintOrder = null;
        this.invalidateLayout();
      }
      return child;
    }
    if (child._parent) child._parent.removeChild(child);
    const at = Math.max(0, Math.min(index, this._children.length));
    this._children.splice(at, 0, child);
    child._parent = this;
    this._paintOrder = null;
    if (this._context) child._attach(this._context);
    this.invalidateLayout();
    this.onChildrenChanged();
    return child;
  }

  /** Detach `child` (not disposed). Returns false if it was not a child. */
  protected removeChild(child: UIElement): boolean {
    const at = this._children.indexOf(child);
    if (at < 0) return false;
    this._children.splice(at, 1);
    this._paintOrder = null;
    if (child._context) child._detach();
    child._parent = null;
    if (!this._disposed) {
      this.invalidateLayout();
      this.onChildrenChanged();
    }
    return true;
  }

  /** Remove this element from its parent (no dispose). */
  removeFromParent(): void {
    this._parent?.removeChild(this);
  }

  /** Children sorted by `zIndex` (stable), i.e. paint order; hit testing walks it backwards. */
  get paintOrder(): readonly UIElement[] {
    if (!this._paintOrder) {
      const order = this._children.slice();
      let needsSort = false;
      for (const c of order) if (c._props.zIndex !== 0) needsSort = true;
      if (needsSort) {
        const index = new Map(order.map((c, i) => [c, i] as const));
        order.sort((a, b) => a._props.zIndex - b._props.zIndex || index.get(a)! - index.get(b)!);
      }
      this._paintOrder = order;
    }
    return this._paintOrder;
  }

  /** @internal */
  _attach(ctx: UIContext): void {
    this._context = ctx;
    ctx.elementAttached(this);
    this._styleDirty = true;
    ctx.markStyleDirty(this);
    if (this._ticking) ctx.setTicking(this, true);
    this.onAttach(ctx);
    for (const c of this._children) c._attach(ctx);
  }

  /** @internal */
  _detach(): void {
    for (const c of this._children) c._detach();
    const ctx = this._context;
    if (!ctx) return;
    this.onDetach(ctx);
    if (this._ticking) ctx.setTicking(this, false);
    ctx.animator.cancelOwner(this);
    this._paintStyle = null;
    ctx.elementDetached(this);
    ctx.markRenderDirty();
    this._context = null;
  }

  // ================================================================== lifecycle hooks

  /** Called after the element joins a manager (its parent was attached). */
  protected onAttach(_ctx: UIContext): void {}
  /** Called before it leaves (detached or disposed). */
  protected onDetach(_ctx: UIContext): void {}
  /** Called once, from `dispose()`, after children are disposed. */
  protected onDispose(): void {}
  /** Children were added/removed/reordered. */
  protected onChildrenChanged(): void {}

  private _ticking = false;
  /** Opt in/out of per-frame `update(dt)` (only ticking elements are visited each frame). */
  protected setTicking(on: boolean): void {
    if (this._ticking === on) return;
    this._ticking = on;
    this._context?.setTicking(this, on);
  }
  /** Per-frame hook for ticking elements (see `setTicking`). */
  update(_dt: number): void {}

  /** Tie a disposable (subscription, binding, timer) to this element's lifetime. */
  own<D extends Disposable>(d: D): D {
    if (this._disposed) {
      d.dispose();
      return d;
    }
    this._owned.push(d);
    return d;
  }

  dispose(): void {
    if (this._disposed) return;
    // Detach first so the manager drops focus/hover/capture/ticks while the tree is intact.
    if (this._parent) this._parent.removeChild(this);
    else if (this._context) this._detach();
    while (this._children.length > 0) this._children[this._children.length - 1]!.dispose();
    this._disposed = true;
    for (let i = this._owned.length - 1; i >= 0; i--) {
      try {
        this._owned[i]!.dispose();
      } catch (e) {
        if (typeof console !== "undefined") console.error(`[forge.ui] disposing a resource owned by ${this.debugName} threw`, e);
      }
    }
    this._owned.length = 0;
    if (this._listenerMap) {
      for (const list of this._listenerMap.values()) for (const r of list) r.active = false;
      this._listenerMap = null;
    }
    this.onDispose();
  }

  protected assertLive(): void {
    if (this._disposed) throw new ObjectDisposedError(`UI element ${this.debugName}`);
  }

  // ================================================================== visibility, enablement, state

  /** Hidden elements take no space, are not painted, hit or focused. */
  get visible(): boolean {
    return this._visible;
  }
  set visible(v: boolean) {
    if (v === this._visible) return;
    this._visible = v;
    this._parent?.invalidateLayout();
    this.invalidateLayout();
    this.invalidateRender();
  }

  /** Visible and every ancestor visible. */
  get effectivelyVisible(): boolean {
    for (let e: UIElement | null = this; e; e = e._parent) if (!e._visible) return false;
    return true;
  }

  get enabled(): boolean {
    return this._enabled;
  }
  set enabled(v: boolean) {
    if (v === this._enabled) return;
    this._enabled = v;
    this.walk((e) => {
      e.setStateBit(UIState.Disabled, !e.effectivelyEnabled);
    });
  }

  /** Enabled and every ancestor enabled. Disabled elements never receive interaction events. */
  get effectivelyEnabled(): boolean {
    for (let e: UIElement | null = this; e; e = e._parent) if (!e._enabled) return false;
    return true;
  }

  /** Current visual state bitset (`UIState`). */
  get state(): number {
    return this._state;
  }

  hasState(bit: number): boolean {
    return (this._state & bit) !== 0;
  }

  /** Set or clear a state bit; restyles only when the set actually changed. */
  setStateBit(bit: number, on: boolean): void {
    const next = on ? this._state | bit : this._state & ~bit;
    if (next === this._state) return;
    this._state = next;
    this.invalidateStyle();
    this.onStateChanged(bit, on);
  }

  protected onStateChanged(_bit: number, _on: boolean): void {}

  get variant(): string | null {
    return this._variant;
  }
  set variant(v: string | null) {
    if (v === this._variant) return;
    this._variant = v;
    this.invalidateStyle();
  }

  /** Per-instance style overrides (highest precedence). Assign a new object to change them. */
  get style(): StyleBlock | null {
    return this._styleOverrides;
  }
  set style(v: StyleBlock | null) {
    this._styleOverrides = v;
    this.invalidateStyle();
  }

  get tooltip(): string | null {
    return this._tooltip;
  }
  set tooltip(v: string | null) {
    this._tooltip = v;
  }

  /** Element-level opacity (multiplies the style's opacity and the ancestors'). Animatable. */
  get opacity(): number {
    return this._opacity;
  }
  set opacity(v: number) {
    const c = Math.max(0, Math.min(1, v));
    if (c === this._opacity) return;
    this._opacity = c;
    this.invalidateRender();
  }

  /** Render/hit-test translation (does not affect layout). Animatable. */
  get translateX(): number {
    return this._translateX;
  }
  set translateX(v: number) {
    if (v === this._translateX) return;
    this._translateX = v;
    this.invalidateRender();
  }
  get translateY(): number {
    return this._translateY;
  }
  set translateY(v: number) {
    if (v === this._translateY) return;
    this._translateY = v;
    this.invalidateRender();
  }
  /** Render/hit-test scale about the element's centre (does not affect layout). Animatable. */
  get scale(): number {
    return this._scale;
  }
  set scale(v: number) {
    if (!(v > 0)) throw new UsageError(`ui: scale must be > 0 (got ${v})`);
    if (v === this._scale) return;
    this._scale = v;
    this.invalidateRender();
  }

  // ================================================================== style

  /** The target resolved style (skin + theme + variant + states + overrides). */
  get computedStyle(): ResolvedStyle {
    return this._computed;
  }

  /** What is painted this frame: the transition blend while one runs, else `computedStyle`. */
  get paintStyle(): ResolvedStyle {
    return this._paintStyle ?? this._computed;
  }

  invalidateStyle(): void {
    if (this._disposed) return;
    this._styleDirty = true;
    this._context?.markStyleDirty(this);
  }

  /** @internal Called by the manager's style pass. */
  _applyResolvedStyle(next: ResolvedStyle): void {
    this._styleDirty = false;
    const prev = this._computed;
    if (prev === next) return;
    this._computed = next;
    if (
      prev.fontSize !== next.fontSize ||
      prev.fontFamily !== next.fontFamily ||
      prev.fontWeight !== next.fontWeight ||
      prev.lineHeight !== next.lineHeight ||
      prev.letterSpacing !== next.letterSpacing ||
      prev.textTransform !== next.textTransform ||
      prev.minWidth !== next.minWidth ||
      prev.minHeight !== next.minHeight ||
      prev.iconSize !== next.iconSize ||
      prev.spacing !== next.spacing ||
      prev.padding !== next.padding
    ) {
      this.invalidateLayout();
      // A fixed-size element's skin minimum can still change its size: re-measure in the parent.
      if (prev.minWidth !== next.minWidth || prev.minHeight !== next.minHeight) this._parent?.invalidateLayout();
    }
    this.onStyleChanged(prev, next);
    this.invalidateRender();
  }

  protected onStyleChanged(_prev: ResolvedStyle, _next: ResolvedStyle): void {}

  // ================================================================== layout properties

  get props(): Readonly<CompiledLayoutProps> {
    return this._props;
  }

  /** Merge layout properties (validated). Invalidates the element and its parent's layout. */
  setLayout(input: LayoutPropsInput): this {
    applyLayoutInput(this._props, input);
    if ("margin" in input) toInsets(input.margin, this._margin);
    if ("padding" in input) this._layoutPadding = input.padding === undefined ? null : toInsets(input.padding);
    if (input.zIndex !== undefined && this._parent) this._parent._paintOrder = null;
    this.invalidateLayout();
    this._parent?.invalidateLayout();
    return this;
  }

  /** The container algorithm for children (`null` for leaves). */
  get layout(): LayoutStrategy | null {
    return this._strategy;
  }
  set layout(s: LayoutStrategy | null) {
    this._strategy = s;
    this.invalidateLayout();
  }

  get marginBox(): Readonly<UIInsets> {
    return this._margin;
  }

  /** Padding: layout override if set, else the skin's. */
  get paddingBox(): Readonly<UIInsets> {
    return this._layoutPadding ?? this._computed.padding;
  }

  get isFlowChild(): boolean {
    return this._visible && this._props.position === "flow";
  }

  get layoutChildren(): readonly UIElement[] {
    return this._children;
  }

  /** Fixed width and height: a measure change inside cannot change this element's size. */
  get isLayoutBoundary(): boolean {
    return this._props.width.unit === LengthUnit.Px && this._props.height.unit === LengthUnit.Px;
  }

  /** Mark this element's measurement and arrangement stale (and its ancestors' up to a boundary). */
  invalidateLayout(): void {
    if (this._disposed) return;
    this._invalidations++;
    this._measureDirty = true;
    this._arrangeDirty = true;
    this._subtreeDirty = true;
    let p = this._parent;
    let boundaryReached = this.isLayoutBoundary && this._parent !== null;
    while (p) {
      if (boundaryReached) {
        p._subtreeDirty = true;
      } else if (p.isLayoutBoundary) {
        p._arrangeDirty = true;
        p._subtreeDirty = true;
        boundaryReached = true;
      } else {
        p._measureDirty = true;
        p._arrangeDirty = true;
        p._subtreeDirty = true;
      }
      p = p._parent;
    }
    this._context?.markLayoutDirty(this);
  }

  invalidateRender(): void {
    this._context?.markRenderDirty();
  }

  get layoutDirty(): boolean {
    return this._measureDirty || this._arrangeDirty || this._subtreeDirty;
  }

  definiteWidth(parentContentWidth: number, ctx: LayoutContext): number {
    return resolveLength(this._props.width, parentContentWidth, ctx.viewportWidth, ctx.viewportHeight);
  }

  definiteHeight(parentContentHeight: number, ctx: LayoutContext): number {
    return resolveLength(this._props.height, parentContentHeight, ctx.viewportWidth, ctx.viewportHeight);
  }

  /** Clamp to min/max (min wins over max, like CSS); skin minimums apply when layout leaves min auto. */
  clampWidth(w: number, parentContentWidth: number, ctx: LayoutContext): number {
    const max = resolveLength(this._props.maxWidth, parentContentWidth, ctx.viewportWidth, ctx.viewportHeight);
    let min = resolveLength(this._props.minWidth, parentContentWidth, ctx.viewportWidth, ctx.viewportHeight);
    if (Number.isNaN(min)) min = this._computed.minWidth;
    if (!Number.isNaN(max) && w > max) w = max;
    if (w < min) w = min;
    return w < 0 || Number.isNaN(w) ? 0 : w;
  }

  clampHeight(h: number, parentContentHeight: number, ctx: LayoutContext): number {
    const max = resolveLength(this._props.maxHeight, parentContentHeight, ctx.viewportWidth, ctx.viewportHeight);
    let min = resolveLength(this._props.minHeight, parentContentHeight, ctx.viewportWidth, ctx.viewportHeight);
    if (Number.isNaN(min)) min = this._computed.minHeight;
    if (!Number.isNaN(max) && h > max) h = max;
    if (h < min) h = min;
    return h < 0 || Number.isNaN(h) ? 0 : h;
  }

  /**
   * Desired border-box size given the available space (∞ = unbounded on that axis). Percentages
   * resolve against the available space the container offers (its content box, or a grid area).
   */
  measure(availableWidth: number, availableHeight: number, ctx: LayoutContext): { width: number; height: number } {
    if (!this._measureDirty && availableWidth === this._cacheAvailW && availableHeight === this._cacheAvailH) return this._cacheSize;
    this._measureCount++;
    LAYOUT_COUNTERS.measures++;
    const pad = this.paddingBox;
    const padW = pad.left + pad.right;
    const padH = pad.top + pad.bottom;
    let w = this.definiteWidth(availableWidth, ctx);
    let h = this.definiteHeight(availableHeight, ctx);
    const ratio = this._props.aspectRatio;
    if (ratio > 0) {
      if (!Number.isNaN(w) && Number.isNaN(h)) h = w / ratio;
      else if (Number.isNaN(w) && !Number.isNaN(h)) w = h * ratio;
    }
    // A definite size is clamped by min/max *before* the content is laid out at it: a `width: 520,
    // maxWidth: "94vw"` panel on a phone must wrap its text at 94vw, or its height is computed for
    // a width it never gets and its children are squeezed when it is arranged.
    if (!Number.isNaN(w)) w = this.clampWidth(w, availableWidth, ctx);
    if (!Number.isNaN(h)) h = this.clampHeight(h, availableHeight, ctx);
    if (Number.isNaN(w) || Number.isNaN(h)) {
      const innerW = Number.isNaN(w) ? Math.max(0, this.maxFor(availableWidth, true, ctx) - padW) : Math.max(0, w - padW);
      const innerH = Number.isNaN(h) ? Math.max(0, this.maxFor(availableHeight, false, ctx) - padH) : Math.max(0, h - padH);
      const content = this._strategy ? this._strategy.measureContent(this, innerW, innerH, ctx) : this.measureContent(innerW, innerH, ctx);
      if (Number.isNaN(w)) w = content.width + padW;
      if (Number.isNaN(h)) h = ratio > 0 && !Number.isNaN(w) ? w / ratio : content.height + padH;
    }
    this._cacheSize.width = this.clampWidth(w, availableWidth, ctx);
    this._cacheSize.height = this.clampHeight(h, availableHeight, ctx);
    this._cacheAvailW = availableWidth;
    this._cacheAvailH = availableHeight;
    this._measureDirty = false;
    return this._cacheSize;
  }

  private maxFor(available: number, horizontal: boolean, ctx: LayoutContext): number {
    const max = resolveLength(horizontal ? this._props.maxWidth : this._props.maxHeight, available, ctx.viewportWidth, ctx.viewportHeight);
    return Number.isNaN(max) ? available : Math.min(max, available);
  }

  /**
   * Content size without a layout strategy: leaves override this (text, images, composite parts);
   * the default is the stack rule (`StackLayout`'s stretch alignment) — content as large as the
   * largest flow child's margin box.
   */
  protected measureContent(availableWidth: number, availableHeight: number, ctx: LayoutContext): { width: number; height: number } {
    return DEFAULT_STACK.measureContent(this, availableWidth, availableHeight, ctx);
  }

  /** Place this element; re-arranges children only when the rect or their layout changed. */
  arrange(rect: UIRect, ctx: LayoutContext): void {
    const changed = !this._lastArranged.equals(rect);
    if (!changed && !this._arrangeDirty && !this._subtreeDirty) return;
    const full = changed || this._arrangeDirty;
    this.bounds.copy(rect);
    // Clear before doing the work: anything that invalidates *during* this arrangement (a child, an
    // onArranged hook) must stay dirty so the manager runs another pass — or reports that the
    // layout does not converge — instead of the flag being silently overwritten afterwards.
    this._arrangeDirty = false;
    this._subtreeDirty = false;
    // A fixed-size element re-arranged in place keeps its (fixed) measurement; anything else keeps the
    // flag until its parent measures it again.
    if (this.isLayoutBoundary) this._measureDirty = false;
    if (full) {
      this._arrangeCount++;
      LAYOUT_COUNTERS.arranges++;
      this._lastArranged.copy(rect);
      this.contentRect.copy(rect).deflate(this.paddingBox);
      if (this._strategy) this._strategy.arrangeContent(this, this.contentRect, ctx);
      else this.arrangeContent(this.contentRect, ctx);
      for (const c of this._children) {
        if (c._visible && c._props.position === "absolute") arrangeAbsoluteChild(c, this.bounds, ctx);
      }
      if (changed) this.invalidateRender();
      this.onArranged();
    } else {
      // Only something inside changed: re-run children at their current rects.
      for (const c of this._children) if (c._visible && c.layoutDirty) c.arrange(c._lastArranged.isValid ? c._lastArranged : c.bounds, ctx);
    }
  }

  /**
   * Leaf arrangement hook (place internal parts). Default: the stack rule — each flow child over the
   * content box, stretched on axes it leaves `auto`, at its own size on axes it fixes.
   */
  protected arrangeContent(content: UIRect, ctx: LayoutContext): void {
    DEFAULT_STACK.arrangeContent(this, content, ctx);
  }

  /** After arrangement (scroll extents, virtualization windows). */
  protected onArranged(): void {}

  // ================================================================== painting

  /**
   * Paint the element's own visuals. Default: the skin box (shadow, background/gradient, border,
   * image) over the border box. Widgets extend with `paintContent`; custom components may override.
   */
  protected paintBackground(p: UIPainter, s: ResolvedStyle): void {
    const b = this.bounds;
    if (s.image) {
      p.image(s.image, b.x, b.y, b.width, b.height, { tint: s.imageTint, slice: s.imageSlice });
    }
    if (s.background !== 0 || s.borderWidth > 0 || s.shadowColor !== 0) {
      p.box(b.x, b.y, b.width, b.height, s);
    }
  }

  /** Foreground drawing (text, icons, indicators). */
  protected paintContent(_p: UIPainter, _s: ResolvedStyle): void {}

  /** Drawn after children (scroll bars, focus rings, overlays). */
  protected paintOverlay(_p: UIPainter, _s: ResolvedStyle): void {}

  /** @internal Paint this subtree in order (called by the manager's render pass). */
  _paintTree(p: UIPainter): number {
    if (!this._visible) return 0;
    const s = this.paintStyle;
    const b = this.bounds;
    const alpha = this._opacity * s.opacity;
    if (alpha <= 0) return 0;
    const transformed = this._translateX !== 0 || this._translateY !== 0 || this._scale !== 1;
    if (transformed) p.pushTransform(this._translateX, this._translateY, this._scale, b.x + b.width / 2, b.y + b.height / 2);
    if (alpha < 1) p.pushOpacity(alpha);
    const culled = b.x > p.clipX1 || b.y > p.clipY1 || b.x + b.width < p.clipX0 || b.y + b.height < p.clipY0;
    // Counts elements that drew themselves (a culled element may still have visible children).
    let painted = culled ? 0 : 1;
    if (!culled || !this.clipChildren) {
      if (!culled) {
        this.paintBackground(p, s);
        this.paintContent(p, s);
      }
      if (this._children.length > 0 && !(culled && this.clipChildren)) {
        if (this.clipChildren) p.pushClip(b.x, b.y, b.width, b.height);
        for (const c of this.paintOrder) painted += c._paintTree(p);
        if (this.clipChildren) p.popClip();
      }
      if (!culled) this.paintOverlay(p, s);
    }
    if (alpha < 1) p.popOpacity();
    if (transformed) p.popTransform();
    return painted;
  }

  // ================================================================== hit testing & coordinates

  /** Map a viewport point into this element's untransformed space (inverse of render transforms). */
  toLocal(x: number, y: number, out: { x: number; y: number } = { x: 0, y: 0 }): { x: number; y: number } {
    const chain: UIElement[] = [];
    for (let e: UIElement | null = this; e; e = e._parent) chain.push(e);
    let lx = x;
    let ly = y;
    for (let i = chain.length - 1; i >= 0; i--) {
      const e = chain[i]!;
      if (e._translateX !== 0 || e._translateY !== 0 || e._scale !== 1) {
        const ox = e.bounds.x + e.bounds.width / 2;
        const oy = e.bounds.y + e.bounds.height / 2;
        lx = (lx - e._translateX - ox) / e._scale + ox;
        ly = (ly - e._translateY - oy) / e._scale + oy;
      }
    }
    out.x = lx - this.bounds.x;
    out.y = ly - this.bounds.y;
    return out;
  }

  /** Does this element's own shape contain the (untransformed, viewport-space) point? Override for round widgets. */
  containsPoint(x: number, y: number): boolean {
    return this.bounds.contains(x, y);
  }

  /**
   * Topmost element under (x, y) in this subtree, honouring visibility, `pointerEvents`, clipping,
   * z-order and render transforms. `x, y` are in the parent's (transformed) space.
   */
  hitTest(x: number, y: number): UIElement | null {
    if (!this._visible || this.pointerEvents === "none" || this._opacity <= 0) return null;
    let lx = x;
    let ly = y;
    if (this._translateX !== 0 || this._translateY !== 0 || this._scale !== 1) {
      const ox = this.bounds.x + this.bounds.width / 2;
      const oy = this.bounds.y + this.bounds.height / 2;
      lx = (x - this._translateX - ox) / this._scale + ox;
      ly = (y - this._translateY - oy) / this._scale + oy;
    }
    const inside = this.containsPoint(lx, ly);
    if (this.clipChildren && !inside) return null;
    const order = this.paintOrder;
    for (let i = order.length - 1; i >= 0; i--) {
      const hit = order[i]!.hitTest(lx, ly);
      if (hit) return hit;
    }
    return inside && this.pointerEvents === "auto" ? this : null;
  }

  // ================================================================== events

  /** Subscribe to a UI event. Disposed automatically with the element. */
  on<K extends keyof UIEventMap>(type: K, fn: UIEventListener<UIEventMap[K]>, options?: { capture?: boolean }): Disposable;
  on(type: string, fn: UIEventListener, options?: { capture?: boolean }): Disposable;
  on(type: string, fn: UIEventListener<never>, options: { capture?: boolean } = {}): Disposable {
    this.assertLive();
    const rec: ListenerRecord = { fn: fn as UIEventListener, capture: options.capture ?? false, active: true };
    this._listenerMap ??= new Map();
    const list = this._listenerMap.get(type);
    // Copy-on-write: a dispatch in progress keeps iterating the old array.
    this._listenerMap.set(type, list ? [...list, rec] : [rec]);
    return listenerHandle(() => {
      rec.active = false;
      const cur = this._listenerMap?.get(type);
      if (!cur) return;
      const next = cur.filter((r) => r !== rec);
      if (next.length > 0) this._listenerMap!.set(type, next);
      else this._listenerMap!.delete(type);
    });
  }

  /** @internal Listener records for one type (dispatch). */
  _listeners(type: string): readonly ListenerRecord[] | undefined {
    return this._listenerMap?.get(type);
  }

  /** Number of live listeners on this element (leak diagnostics). */
  get listenerCount(): number {
    let n = 0;
    if (this._listenerMap) for (const l of this._listenerMap.values()) n += l.length;
    return n;
  }

  /** Dispatch an event at this element through the manager (or directly when detached). */
  emit(event: UIEvent): boolean {
    if (this._disposed) return false;
    if (this._context) return this._context.dispatch(event, this);
    return dispatchUIEvent(event, this);
  }

  // ================================================================== focus helpers

  /** Can receive focus right now (focusable, enabled, visible, attached). */
  get canFocus(): boolean {
    return this.focusable && !this._disposed && this._context !== null && this.effectivelyEnabled && this.effectivelyVisible;
  }

  get focused(): boolean {
    return this._context?.focus.focused === this;
  }

  focus(visible = false): boolean {
    return this._context?.focus.focus(this, visible) ?? false;
  }

  blur(): void {
    this._context?.focus.blur(this);
  }
}
