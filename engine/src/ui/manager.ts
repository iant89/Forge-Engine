/**
 * `UIManager` — owns one UI: the viewport, the layer tree, every service, and the per-frame pipeline.
 *
 * ```ts
 * const ui = new UIManager({ width: canvas.width, height: canvas.height, devicePixelRatio: dpr });
 * ui.layer("hud").add(new HealthBar({ value: 0.8 }));
 * // each frame
 * ui.update(dt);            // bindings → animations → ticks → breakpoints → styles → layout → focus
 * const list = ui.render(); // rebuilt only when something visible changed
 * ```
 *
 * The manager implements `UIContext`, which is all an element ever sees of it. Layers are painted in
 * `UI_LAYERS` order (`base`, `hud`, `modal`, `popup`, `tooltip`, `toast`, `debug`) and hit-tested in
 * reverse; while a modal is open everything below the modal layer is unreachable.
 *
 * Frame cost model (asserted in `tests/ui/uiManager.test.ts`): a frame in which nothing changed
 * resolves no styles, measures and arranges nothing, and does not rebuild the draw list.
 */

import { UsageError } from "../core/errors.js";
import { Signal, type Disposable } from "../core/events.js";
import { UIRect, UIViewport, type UIInsets } from "./core/geometry.js";
import { UIContainer } from "./core/container.js";
import { DETACHED_STYLE, LAYOUT_COUNTERS, UIElement } from "./core/element.js";
import { UI_LAYERS, type UIContext, type UILayerName, type UIOverlayService, type UIStyleService } from "./core/context.js";
import { ComponentRegistry } from "./core/registry.js";
import { AnchorLayout } from "./layout/anchor.js";
import { StackLayout } from "./layout/stack.js";
import type { LayoutContext } from "./layout/types.js";
import { StyleResolver, type Mutable } from "./style/resolver.js";
import { TRANSITION_PROPERTIES, type ResolvedStyle, type TransitionProperty } from "./style/types.js";
import { lerpColor } from "./core/color.js";
import { TextEngine } from "./text/textEngine.js";
import { Localizer } from "./text/localization.js";
import { UIAnimator } from "./anim/animator.js";
import { Binder, type Binding, type BindingOptions, type BindingSource } from "./data/binding.js";
import { FocusManager } from "./input/focus.js";
import { InputRouter } from "./input/router.js";
import { dispatchUIEvent, UICustomEvent, type UIEvent } from "./input/events.js";
import { UIDrawList, DrawListPainter } from "./render/drawList.js";
import { UIAssets } from "./render/assets.js";
import { BreakpointSet, ResponsiveProfile, computeUiScale, type Breakpoint, type ResponsiveRules, type ScaleMode } from "./responsive.js";
import { registerBuiltinComponents } from "./widgets/registerBuiltins.js";
import { registerBuiltinStyles } from "./style/builtins.js";
import { ModalHost, TooltipBubble } from "./widgets/overlayHosts.js";
import { UIDiagnostics } from "./diagnostics.js";

export interface UIManagerOptions {
  /** Physical (swapchain) size in pixels. */
  width?: number;
  height?: number;
  devicePixelRatio?: number;
  /** User UI scale (multiplies the device pixel ratio). */
  uiScale?: number;
  scaleMode?: ScaleMode;
  textScale?: number;
  /** Theme name (default `"frontier"`). */
  theme?: string;
  /** Skin name (default `"frontier"`). */
  skin?: string;
  breakpoints?: readonly Breakpoint[];
  breakpointHysteresis?: number;
  reducedMotion?: boolean;
  /** Skip registering the built-in widgets, themes and skins (bare framework). */
  bare?: boolean;
  /** Seconds a pointer must rest on an element with a `tooltip` before it shows. */
  tooltipDelay?: number;
  /** Layout passes per frame before the manager reports a non-converging layout. */
  maxLayoutPasses?: number;
}

export interface UIFrameStats {
  elements: number;
  styleResolves: number;
  layoutPasses: number;
  measures: number;
  arranges: number;
  drawListRebuilt: boolean;
  drawInstances: number;
  drawBatches: number;
  activeAnimations: number;
  tickingElements: number;
  updateMs: number;
  renderMs: number;
}

export interface UIDiagnostic {
  level: "info" | "warn" | "error";
  message: string;
  element: string | null;
  time: number;
}

interface OpenOverlay {
  el: UIElement;
  layer: UILayerName;
  owner: UIElement | null;
  lightDismiss: boolean;
  host: UIElement;
}

const now = (): number => (typeof performance !== "undefined" ? performance.now() : Date.now());

class LayerContainer extends UIContainer {
  static override styleName = "Layer";
  constructor(readonly layerName: UILayerName) {
    super({ name: `layer:${layerName}` });
    // base/hud: children at their natural size, top-left, unless they set alignSelf/justifySelf
    // ("stretch" fills the screen, "center" centres). modal: hosts fill the screen. Others: anchored.
    this.layout = layerName === "modal" ? new StackLayout() : layerName === "base" || layerName === "hud" ? new StackLayout("start", "start") : new AnchorLayout();
  }
}

/** The tree root: arranges every layer over the whole viewport. */
class UIRoot extends UIContainer {
  static override styleName = "Root";
  constructor() {
    super({ name: "root" });
    this.layout = new StackLayout();
  }
}

export class UIManager implements UIContext, UIOverlayService, UIStyleService {
  readonly viewport = new UIViewport();
  readonly components = new ComponentRegistry();
  readonly resolver: StyleResolver;
  readonly text: TextEngine;
  readonly assets = new UIAssets();
  readonly animator = new UIAnimator();
  readonly binder = new Binder();
  readonly localizer = new Localizer();
  readonly focus: FocusManager;
  readonly router: InputRouter;
  readonly breakpoints: BreakpointSet;
  readonly diagnostics: UIDiagnostics;
  readonly root: UIRoot;
  private readonly layers = new Map<UILayerName, LayerContainer>();
  /** Fires after the breakpoint changes (`breakpoint` holds the new name). */
  readonly onBreakpointChange = new Signal();
  readonly onViewportChange = new Signal();

  private readonly styleDirty = new Set<UIElement>();
  private layoutRequested = true;
  private renderDirty = true;
  private readonly ticking = new Set<UIElement>();
  private readonly ids = new Map<string, UIElement>();
  private readonly profiles = new Map<UIElement, ResponsiveProfile>();
  private readonly openOverlays: OpenOverlay[] = [];
  private readonly modalStack: OpenOverlay[] = [];
  private readonly drawList = new UIDrawList();
  private readonly painter: DrawListPainter;
  private readonly layoutCtx: { viewportWidth: number; viewportHeight: number };
  private elementCount = 0;
  private _time = 0;
  private _disposed = false;
  private inLayout = false;
  private layoutInvalidatedDuringPass: UIElement[] = [];
  private readonly invalidationCounts = new Map<UIElement, number>();
  private readonly hotReported = new Set<UIElement>();
  private scaleMode: ScaleMode;
  private fixedUiScale: number;
  private cssWidth = 1;
  private cssHeight = 1;
  /** Diagnostics ring buffer (newest last). */
  readonly messages: UIDiagnostic[] = [];
  maxMessages = 200;
  tooltipDelay: number;
  maxLayoutPasses: number;
  /** Per-element invalidations within one frame before a "repeatedly invalidated" warning. */
  invalidationWarnThreshold = 64;
  /** `console.log`/assertion output: a one-line summary, not the whole (cyclic) UI graph. */
  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return `<UIManager ${this.viewport.width}x${this.viewport.height} ${this.elements} elements>`;
  }

  readonly lastFrame: UIFrameStats = {
    elements: 0,
    styleResolves: 0,
    layoutPasses: 0,
    measures: 0,
    arranges: 0,
    drawListRebuilt: false,
    drawInstances: 0,
    drawBatches: 0,
    activeAnimations: 0,
    tickingElements: 0,
    updateMs: 0,
    renderMs: 0,
  };
  private tooltip: { target: UIElement | null; since: number; bubble: TooltipBubble | null } = { target: null, since: 0, bubble: null };
  /** Bumped when the draw list was rebuilt (GPU upload signal). */
  get drawListVersion(): number {
    return this.drawList.version;
  }

  constructor(options: UIManagerOptions = {}) {
    this.resolver = new StyleResolver((level, message) => this.diagnostic(level, message));
    this.resolver.onChange = () => this.restyleAll();
    this.text = new TextEngine();
    this.assets.registerPage(this.text.builtin.page);
    this.assets.diagnostic = (m) => this.diagnostic("warn", m);
    this.localizer.diagnostic = (m) => this.diagnostic("warn", m);
    this.binder.onError = (m) => this.diagnostic("error", m);
    this.breakpoints = new BreakpointSet(options.breakpoints, options.breakpointHysteresis);
    this.tooltipDelay = options.tooltipDelay ?? 0.5;
    this.maxLayoutPasses = options.maxLayoutPasses ?? 8;
    this.scaleMode = options.scaleMode ?? "fixed";
    this.fixedUiScale = options.uiScale ?? 1;
    this.animator.reducedMotion = options.reducedMotion ?? false;
    this.text.textScale = options.textScale ?? 1;
    this.layoutCtx = { viewportWidth: 1, viewportHeight: 1 };
    this.painter = new DrawListPainter(this.drawList, (name) => this.assets.resolve(name));
    this.painter.onMissingImage = (name) => this.diagnostic("warn", `ui assets: image or sprite "${name}" is not registered (drawn as a magenta box)`);
    const self = this;
    this.focus = new FocusManager({
      get root() {
        return self.root;
      },
      get topModal() {
        return self.topModalHost;
      },
      dispatch: (e, t) => this.dispatch(e, t),
    });
    this.root = new UIRoot();
    this.router = new InputRouter({
      get root() {
        return self.root;
      },
      get topModal() {
        return self.topModalHost;
      },
      focus: this.focus,
      hitTest: (x, y) => this.hitTest(x, y),
      dispatch: (e, t) => this.dispatch(e, t),
      beforePointerDown: (_x, _y, hit) => this.lightDismiss(hit),
      get time() {
        return self._time;
      },
    });
    this.diagnostics = new UIDiagnostics(this);
    for (const name of UI_LAYERS) {
      const layer = new LayerContainer(name);
      if (name === "debug" || name === "tooltip") layer.pointerEvents = "none";
      this.layers.set(name, layer);
      this.root.add(layer);
    }
    this.root._attach(this);
    if (!options.bare) {
      registerBuiltinComponents(this.components);
      registerBuiltinStyles(this.resolver);
      this.resolver.setTheme(options.theme ?? "frontier");
      this.resolver.setSkin(options.skin ?? "frontier");
    } else {
      if (options.theme) this.resolver.setTheme(options.theme);
      if (options.skin) this.resolver.setSkin(options.skin);
    }
    this.localizer.onChange.on(() => this.onLocaleChanged());
    this.setViewport(options.width ?? 1280, options.height ?? 720, options.devicePixelRatio ?? 1);
  }

  // ================================================================== UIContext

  get styles(): UIStyleService {
    return this;
  }

  get overlays(): UIOverlayService {
    return this;
  }

  /** Elements currently open as overlays, oldest first. */
  get openOverlayElements(): UIElement[] {
    return this.openOverlays.map((o) => o.el);
  }

  get breakpoint(): string {
    return this.breakpoints.current;
  }

  get time(): number {
    return this._time;
  }

  get reducedMotion(): boolean {
    return this.animator.reducedMotion;
  }
  set reducedMotion(v: boolean) {
    this.animator.reducedMotion = v;
  }

  resolve(el: UIElement): ResolvedStyle {
    return this.resolver.resolve(el);
  }

  token(path: string): number | string | undefined {
    return this.resolver.token(path);
  }

  markStyleDirty(el: UIElement): void {
    this.styleDirty.add(el);
  }

  markLayoutDirty(el: UIElement): void {
    this.layoutRequested = true;
    const n = (this.invalidationCounts.get(el) ?? 0) + 1;
    this.invalidationCounts.set(el, n);
    if (n === this.invalidationWarnThreshold && !this.hotReported.has(el)) {
      this.hotReported.add(el);
      this.diagnostic("warn", `layout: ${el.debugName} invalidated its layout ${n} times in one frame (an invalidation loop?)`, el);
    }
    if (this.inLayout) this.layoutInvalidatedDuringPass.push(el);
  }

  markRenderDirty(): void {
    this.renderDirty = true;
  }

  setTicking(el: UIElement, on: boolean): void {
    if (on) this.ticking.add(el);
    else this.ticking.delete(el);
  }

  elementAttached(el: UIElement): void {
    this.elementCount++;
    if (el.id) {
      const other = this.ids.get(el.id);
      if (other && other !== el) this.diagnostic("error", `ui: duplicate element id "${el.id}" (${other.debugName} and ${el.debugName}); findById returns the first`, el);
      else this.ids.set(el.id, el);
    }
    const profile = this.profiles.get(el);
    if (profile && profile.applied !== this.breakpoint) profile.apply(this.breakpoint);
  }

  elementDetached(el: UIElement): void {
    this.elementCount--;
    if (el.id && this.ids.get(el.id) === el) this.ids.delete(el.id);
    this.styleDirty.delete(el);
    this.ticking.delete(el);
    this.focus.elementDetached(el);
    this.router.elementDetached(el);
    if (this.tooltip.target === el) this.hideTooltip();
    const open = this.openOverlays.find((o) => o.el === el || o.host === el);
    if (open && !this.closing.has(open.el)) this.forgetOverlay(open);
    if (el.disposed || !el.parent) this.profiles.delete(el);
  }

  dispatch(event: UIEvent, target: UIElement): boolean {
    return dispatchUIEvent(event, target, (error, ev, element) => this.diagnostic("error", `"${ev.type}" listener on ${element.debugName} threw: ${error instanceof Error ? error.message : String(error)}`, element));
  }

  diagnostic(level: "info" | "warn" | "error", message: string, el?: UIElement): void {
    this.messages.push({ level, message, element: el?.debugName ?? null, time: this._time });
    if (this.messages.length > this.maxMessages) this.messages.splice(0, this.messages.length - this.maxMessages);
  }

  // ================================================================== tree access

  layer(name: UILayerName): UIContainer {
    const l = this.layers.get(name);
    if (!l) throw new UsageError(`ui: unknown layer "${name}" (layers: ${UI_LAYERS.join(", ")})`);
    return l;
  }

  /** Shorthand for the base layer. */
  get base(): UIContainer {
    return this.layer("base");
  }

  findById(id: string): UIElement | null {
    return this.ids.get(id) ?? null;
  }

  get elements(): number {
    return this.elementCount;
  }

  /** Construct a registered component. */
  create<T extends UIElement = UIElement>(type: string, options: Record<string, unknown> = {}): T {
    return this.components.create<T>(type, options);
  }

  /** Bind a property to an observable/store field (see `Binder`). The binding dies with its element. */
  bind<S, T>(target: object, property: string, source: BindingSource<S>, options?: BindingOptions<S, T>): Binding {
    return this.binder.bind(target, property, source, options);
  }

  // ================================================================== themes / skins / scale

  setTheme(name: string): void {
    this.resolver.setTheme(name);
  }

  setSkin(name: string): void {
    this.resolver.setSkin(name);
  }

  get theme(): string {
    return this.resolver.theme;
  }

  get skin(): string {
    return this.resolver.skin;
  }

  private restyleAll(): void {
    if (!this.root) return;
    this.root.walk((e) => {
      e.invalidateStyle();
    });
  }

  private invalidateAllLayout(): void {
    this.root.walk((e) => {
      e.invalidateLayout();
    });
    this.renderDirty = true;
  }

  /** Physical size in pixels (+ optional device pixel ratio). */
  setViewport(width: number, height: number, devicePixelRatio = this.viewport.devicePixelRatio): void {
    if (!(width > 0 && height > 0)) throw new UsageError(`ui: viewport must be positive (got ${width}x${height})`);
    if (!(devicePixelRatio > 0)) throw new UsageError("ui: devicePixelRatio must be > 0");
    const vp = this.viewport;
    vp.physicalWidth = width;
    vp.physicalHeight = height;
    vp.devicePixelRatio = devicePixelRatio;
    this.cssWidth = width / devicePixelRatio;
    this.cssHeight = height / devicePixelRatio;
    vp.uiScale = computeUiScale(this.scaleMode, this.cssWidth, this.cssHeight, this.fixedUiScale);
    this.viewportChanged();
  }

  setUiScale(scale: number): void {
    if (!(scale > 0)) throw new UsageError("ui: uiScale must be > 0");
    this.fixedUiScale = scale;
    this.scaleMode = "fixed";
    this.viewport.uiScale = scale;
    this.viewportChanged();
  }

  setScaleMode(mode: ScaleMode): void {
    this.scaleMode = mode;
    this.viewport.uiScale = computeUiScale(mode, this.cssWidth, this.cssHeight, this.fixedUiScale);
    this.viewportChanged();
  }

  /** Safe-area insets in logical units (notches, overscan). Applied by `SafeArea` containers. */
  setSafeArea(insets: Partial<UIInsets>): void {
    const s = this.viewport.safeArea;
    s.top = insets.top ?? 0;
    s.right = insets.right ?? 0;
    s.bottom = insets.bottom ?? 0;
    s.left = insets.left ?? 0;
    this.viewportChanged();
  }

  get textScale(): number {
    return this.text.textScale;
  }
  set textScale(v: number) {
    if (!(v > 0)) throw new UsageError("ui: textScale must be > 0");
    if (v === this.text.textScale) return;
    this.text.textScale = v;
    this.text.clearCache();
    this.invalidateAllLayout();
  }

  private viewportChanged(): void {
    this.layoutCtx.viewportWidth = this.viewport.width;
    this.layoutCtx.viewportHeight = this.viewport.height;
    if (this.breakpoints.update(this.viewport.width)) this.applyBreakpoint();
    this.invalidateAllLayout();
    this.onViewportChange.fire();
  }

  setBreakpoints(list: readonly Breakpoint[]): void {
    this.breakpoints.set(list);
    if (this.breakpoints.update(this.viewport.width)) this.applyBreakpoint();
  }

  private applyBreakpoint(): void {
    const bp = this.breakpoints.current;
    for (const p of this.profiles.values()) p.apply(bp);
    this.onBreakpointChange.fire();
  }

  /** Attach per-breakpoint rules to an element (replaces earlier rules for it). */
  responsive(el: UIElement, rules: ResponsiveRules): Disposable {
    const profile = new ResponsiveProfile(el, rules);
    this.profiles.set(el, profile);
    if (el.attached) profile.apply(this.breakpoint);
    return { dispose: () => this.profiles.get(el) === profile && this.profiles.delete(el) };
  }

  private onLocaleChanged(): void {
    this.root.walk((e) => {
      (e as unknown as { onLocaleChanged?: () => void }).onLocaleChanged?.();
    });
  }

  // ================================================================== overlays

  /** The dialog (or drawer) opened by the most recent `showModal` that is still open. */
  get topModal(): UIElement | null {
    return this.modalStack[this.modalStack.length - 1]?.el ?? null;
  }

  /** The framework-owned backdrop host around `topModal`: the focus scope and hit-test blocker. */
  get topModalHost(): UIElement | null {
    return this.modalStack[this.modalStack.length - 1]?.host ?? null;
  }

  private readonly closing = new Set<UIElement>();

  show(el: UIElement, layer: UILayerName, options: { owner?: UIElement | null; lightDismiss?: boolean } = {}): void {
    if (this.isOpen(el)) return;
    this.layer(layer).add(el);
    this.openOverlays.push({ el, layer, owner: options.owner ?? null, lightDismiss: options.lightDismiss ?? false, host: el });
  }

  showModal(el: UIElement, options: { initialFocus?: UIElement | null; closeOnCancel?: boolean } = {}): void {
    if (this.isOpen(el)) return;
    const host = new ModalHost(el, options.closeOnCancel ?? true, () => this.close(el));
    // Popups owned outside the new modal cannot stay above it.
    for (const o of [...this.openOverlays]) if (o.lightDismiss && !(o.owner && el.isAncestorOf(o.owner))) this.close(o.el);
    this.layer("modal").add(host);
    const entry: OpenOverlay = { el, layer: "modal", owner: null, lightDismiss: false, host };
    this.openOverlays.push(entry);
    this.modalStack.push(entry);
    this.focus.enterModal(host, options.initialFocus ?? null);
  }

  close(el: UIElement): void {
    const open = this.openOverlays.find((o) => o.el === el);
    if (!open || this.closing.has(el)) return;
    this.closing.add(el);
    try {
      this.forgetOverlay(open);
      // A modal's host is framework-owned: detach the dialog from it, then dispose the host.
      if (open.host !== el) {
        el.removeFromParent();
        open.host.dispose();
      } else el.removeFromParent();
      if (!el.disposed) el.emit(new UICustomEvent("close", null, false));
    } finally {
      this.closing.delete(el);
    }
  }

  private forgetOverlay(open: OpenOverlay): void {
    const i = this.openOverlays.indexOf(open);
    if (i >= 0) this.openOverlays.splice(i, 1);
    const m = this.modalStack.indexOf(open);
    if (m >= 0) {
      this.modalStack.splice(m, 1);
      this.focus.exitModal(open.host);
    }
  }

  isOpen(el: UIElement): boolean {
    return this.openOverlays.some((o) => o.el === el);
  }

  private lightDismiss(hit: UIElement | null): void {
    for (const o of [...this.openOverlays]) {
      if (!o.lightDismiss) continue;
      if (hit && (o.el.isAncestorOf(hit) || (o.owner && o.owner.isAncestorOf(hit)))) continue;
      this.close(o.el);
    }
  }

  // ================================================================== tooltips

  private updateTooltip(): void {
    const hovered = this.router.hovered;
    let target: UIElement | null = null;
    for (let e = hovered; e; e = e.parent) {
      if (e.tooltip) {
        target = e;
        break;
      }
    }
    if (target !== this.tooltip.target) {
      this.hideTooltip();
      this.tooltip.target = target;
      this.tooltip.since = this._time;
      return;
    }
    if (target && !this.tooltip.bubble && this._time - this.tooltip.since >= this.tooltipDelay && !this.router.busy) {
      const bubble = new TooltipBubble(target.tooltip!);
      this.tooltip.bubble = bubble;
      const b = target.bounds;
      bubble.setLayout({ anchor: { left: Math.max(0, Math.min(b.x, this.viewport.width - 260)), top: b.bottom + 6 <= this.viewport.height - 40 ? b.bottom + 6 : Math.max(0, b.y - 40) } });
      this.layer("tooltip").add(bubble);
    } else if (target && this.tooltip.bubble && this.tooltip.bubble.text !== target.tooltip) {
      this.tooltip.bubble.text = target.tooltip!;
    }
  }

  private hideTooltip(): void {
    const b = this.tooltip.bubble;
    this.tooltip.bubble = null;
    this.tooltip.target = null;
    if (b && !b.disposed) b.dispose();
  }

  // ================================================================== frame

  /** Advance the UI by `dt` seconds and bring styles and layout up to date. */
  update(dt: number): UIFrameStats {
    if (this._disposed) throw new UsageError("ui: manager is disposed");
    const t0 = now();
    if (!this.animator.paused) this._time += Math.max(0, dt) * this.animator.timeScale;
    this.invalidationCounts.clear();
    this.router.update(dt);
    this.animator.update(dt);
    for (const el of [...this.ticking]) if (!el.disposed && el.attached) el.update(dt);
    this.updateTooltip();
    // Styles.
    const resolvesBefore = this.resolver.stats.resolves;
    if (this.styleDirty.size > 0) {
      for (let round = 0; round < 4 && this.styleDirty.size > 0; round++) {
        const batch = [...this.styleDirty];
        this.styleDirty.clear();
        for (const el of batch) {
          if (!el.attached || el.disposed) continue;
          const next = this.resolver.resolve(el);
          if (next !== el.computedStyle) this.startTransition(el, next);
          el._applyResolvedStyle(next);
        }
      }
    }
    // Layout.
    const m0 = LAYOUT_COUNTERS.measures;
    const a0 = LAYOUT_COUNTERS.arranges;
    let passes = 0;
    if (this.layoutRequested) {
      this.inLayout = true;
      try {
        while (this.root.layoutDirty && passes < this.maxLayoutPasses) {
          this.layoutInvalidatedDuringPass = [];
          this.layoutOnce();
          passes++;
        }
        if (this.root.layoutDirty) {
          const culprits = [...new Set(this.layoutInvalidatedDuringPass)].slice(0, 5).map((e) => e.debugName);
          this.diagnostic("warn", `layout did not converge after ${passes} passes; still invalidating: ${culprits.join(", ")}`);
        }
      } finally {
        this.inLayout = false;
      }
      this.layoutRequested = this.root.layoutDirty;
      if (passes > 0) this.renderDirty = true;
    }
    this.router.validate();
    this.focus.validate();
    const f = this.lastFrame;
    f.elements = this.elementCount;
    f.styleResolves = this.resolver.stats.resolves - resolvesBefore;
    f.layoutPasses = passes;
    f.measures = LAYOUT_COUNTERS.measures - m0;
    f.arranges = LAYOUT_COUNTERS.arranges - a0;
    f.activeAnimations = this.animator.activeCount;
    f.tickingElements = this.ticking.size;
    f.drawListRebuilt = false;
    f.updateMs = now() - t0;
    return f;
  }

  private readonly rootRect = new UIRect();

  private layoutOnce(): void {
    const ctx: LayoutContext = this.layoutCtx;
    const w = this.viewport.width;
    const h = this.viewport.height;
    this.root.measure(w, h, ctx);
    this.root.arrange(this.rootRect.set(0, 0, w, h), ctx);
  }

  /** True when the next `render()` would rebuild the draw list. */
  get needsRender(): boolean {
    return this.renderDirty;
  }

  /** Build (or reuse) the frame's draw list. */
  render(): UIDrawList {
    if (!this.renderDirty) {
      this.lastFrame.drawListRebuilt = false;
      return this.drawList;
    }
    const t0 = now();
    const p = this.painter;
    p.begin(this.drawList, this.viewport.width, this.viewport.height);
    let painted = 0;
    for (const name of UI_LAYERS) {
      painted += this.layers.get(name)!._paintTree(p);
    }
    this.diagnostics.paintOverlay(p);
    if (!p.balanced) this.diagnostic("error", "ui render: a paint hook left the clip/opacity/transform stack unbalanced");
    p.end();
    this.drawList.stats.elementsPainted = painted;
    this.renderDirty = false;
    const f = this.lastFrame;
    f.drawListRebuilt = true;
    f.drawInstances = this.drawList.count;
    f.drawBatches = this.drawList.batches.length;
    f.renderMs = now() - t0;
    return this.drawList;
  }

  /** Topmost element at a logical point, after modal blocking. */
  hitTest(x: number, y: number): UIElement | null {
    const modal = this.topModalHost;
    for (let i = UI_LAYERS.length - 1; i >= 0; i--) {
      const name = UI_LAYERS[i]!;
      const layer = this.layers.get(name)!;
      if (modal && name === "modal") return modal.hitTest(x, y) ?? modal;
      const hit = layer.hitTest(x, y);
      if (hit) return hit;
    }
    return null;
  }

  // ================================================================== transitions

  private startTransition(el: UIElement, next: ResolvedStyle): void {
    const from = el.paintStyle;
    if (from === DETACHED_STYLE || next.transition.length === 0 || this.animator.reducedMotion) {
      if (el._paintStyle) this.animator.cancelOwner(el._paintStyle);
      el._paintStyle = null;
      return;
    }
    const props = new Set<TransitionProperty>();
    let duration = 0;
    let delay = 0;
    let easing = next.transition[0]!.easing ?? "easeOut";
    for (const t of next.transition) {
      for (const p of t.properties === "all" ? TRANSITION_PROPERTIES : t.properties) props.add(p);
      if (t.duration > duration) {
        duration = t.duration;
        easing = t.easing ?? easing;
      }
      delay = Math.max(delay, t.delay ?? 0);
    }
    const changed = [...props].filter((p) => from[p] !== next[p]);
    if (changed.length === 0 || duration <= 0) {
      el._paintStyle = null;
      return;
    }
    const start = { ...from } as Mutable<ResolvedStyle>;
    const blend = { ...next } as Mutable<ResolvedStyle>;
    for (const p of changed) (blend as Record<string, unknown>)[p] = start[p];
    if (el._paintStyle) this.animator.cancelOwner(el._paintStyle);
    el._paintStyle = blend;
    this.animator.tween(blend, "t", 0, 1, (t) => {
      for (const p of changed) {
        const a = start[p];
        const b = next[p];
        if (p === "opacity" || p === "borderWidth") (blend as Record<string, unknown>)[p] = (a as number) + ((b as number) - (a as number)) * t;
        else if (p === "radius") {
          const ra = a as ResolvedStyle["radius"];
          const rb = b as ResolvedStyle["radius"];
          blend.radius = {
            topLeft: ra.topLeft + (rb.topLeft - ra.topLeft) * t,
            topRight: ra.topRight + (rb.topRight - ra.topRight) * t,
            bottomRight: ra.bottomRight + (rb.bottomRight - ra.bottomRight) * t,
            bottomLeft: ra.bottomLeft + (rb.bottomLeft - ra.bottomLeft) * t,
          };
        } else (blend as Record<string, unknown>)[p] = lerpColor(a as number, b as number, t);
      }
      el.invalidateRender();
    }, {
      duration,
      delay,
      easing,
      onComplete: () => {
        if (el._paintStyle === blend) {
          el._paintStyle = null;
          el.invalidateRender();
        }
      },
    });
  }

  // ================================================================== lifecycle

  get disposed(): boolean {
    return this._disposed;
  }

  dispose(): void {
    if (this._disposed) return;
    this.hideTooltip();
    this.animator.clear();
    this.root.dispose();
    this.styleDirty.clear();
    this.ticking.clear();
    this.profiles.clear();
    this.openOverlays.length = 0;
    this.modalStack.length = 0;
    this.onBreakpointChange.clear();
    this.onViewportChange.clear();
    this._disposed = true;
  }
}
