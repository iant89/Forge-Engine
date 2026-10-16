/**
 * `UIDiagnostics` — inspection, validation and the debug overlay.
 *
 * Everything here reads the live tree; nothing is cached, so results are always current. The debug
 * overlay is painted into the same draw list as the UI (after the `debug` layer) and costs nothing
 * while `overlay.enabled` is false.
 *
 * * `inspect()` / `dumpTree()` — the tree with bounds, state, style chain, variant, dirty flags.
 * * `styleSources(el)` — which skin blocks contributed to an element's style, in application order.
 * * `validateLayout()` — NaN/∞/negative geometry, elements smaller than their minimum (the viewport is
 *   too small for them), flow siblings that overlap in flex/grid containers, and content escaping a
 *   non-clipping parent.
 * * `focusOrder()`, `renderOrder()`, `accessibilityTree()`.
 * * `resourceReport()` — listeners, bindings, animations, ticking elements and elements: compare
 *   before/after a create–dispose cycle to find leaks.
 * * `startInputTrace()` / `inputTrace` — the router's ring buffer of routed inputs.
 * * `missingAssets` / `messages` — every diagnostic the manager recorded.
 */

import type { UIElement } from "./core/element.js";
import { UIContainer } from "./core/container.js";
import type { UIManager } from "./manager.js";
import type { UIPainter } from "./render/painter.js";
import { UIState } from "./style/types.js";
import type { InputTraceEntry } from "./input/router.js";
import { FlexLayout } from "./layout/flex.js";
import { GridLayout } from "./layout/grid.js";

export interface InspectNode {
  uid: number;
  id: string | null;
  type: string;
  name: string;
  bounds: [number, number, number, number];
  visible: boolean;
  enabled: boolean;
  focused: boolean;
  states: string[];
  styleChain: readonly string[];
  variant: string | null;
  layout: string | null;
  dirty: { style: boolean; measure: boolean; arrange: boolean };
  listeners: number;
  children: InspectNode[];
}

export interface LayoutIssue {
  kind: "invalid-geometry" | "below-minimum" | "overlap" | "overflow";
  element: string;
  detail: string;
}

export interface AccessibilityNode {
  role: string;
  label: string;
  description: string;
  value?: string;
  states: string[];
  focusable: boolean;
  children: AccessibilityNode[];
}

export interface DebugOverlayOptions {
  enabled: boolean;
  bounds: boolean;
  padding: boolean;
  focusOrder: boolean;
  hovered: boolean;
  stats: boolean;
}

export class UIDiagnostics {
  readonly overlay: DebugOverlayOptions = { enabled: false, bounds: true, padding: true, focusOrder: true, hovered: true, stats: true };

  constructor(private readonly ui: UIManager) {}

  inspect(el: UIElement = this.ui.root, maxDepth = Infinity): InspectNode {
    const node = (e: UIElement, depth: number): InspectNode => ({
      uid: e.uid,
      id: e.id,
      type: e.typeName,
      name: e.name,
      bounds: [e.bounds.x, e.bounds.y, e.bounds.width, e.bounds.height],
      visible: e.visible,
      enabled: e.effectivelyEnabled,
      focused: e.focused,
      states: this.ui.resolver.states.names(e.state),
      styleChain: e.styleChain,
      variant: e.variant,
      layout: e.layout?.kind ?? null,
      dirty: { style: e._styleDirty, measure: e._measureDirty, arrange: e._arrangeDirty },
      listeners: e.listenerCount,
      children: depth < maxDepth ? e.children.map((c) => node(c, depth + 1)) : [],
    });
    return node(el, 0);
  }

  /** Indented text dump: `Type#id [x,y wxh] {states}`. */
  dumpTree(el: UIElement = this.ui.root): string {
    const lines: string[] = [];
    const visit = (e: UIElement, depth: number): void => {
      const b = e.bounds;
      const states = this.ui.resolver.states.names(e.state);
      lines.push(`${"  ".repeat(depth)}${e.debugName} [${round(b.x)},${round(b.y)} ${round(b.width)}x${round(b.height)}]${e.visible ? "" : " (hidden)"}${states.length ? ` {${states.join(",")}}` : ""}${e.variant ? ` variant=${e.variant}` : ""}`);
      for (const c of e.children) visit(c, depth + 1);
    };
    visit(el, 0);
    return lines.join("\n");
  }

  /** Skin blocks that contributed to `el`'s style, in application order. */
  styleSources(el: UIElement): string[] {
    const r = this.ui.resolver;
    const out = ["defaults"];
    const chain = el.styleChain;
    for (const n of chain) if (r.componentSkin(n)) out.push(`${r.skin}:${n}`);
    if (el.variant) for (const n of chain) if (r.componentSkin(n)?.variants?.[el.variant]) out.push(`${r.skin}:${n}.variants.${el.variant}`);
    for (const s of r.states.ordered) {
      if ((el.state & s.bit) === 0) continue;
      for (const n of chain) if (r.componentSkin(n)?.states?.[s.name]) out.push(`${r.skin}:${n}.states.${s.name}`);
      if (el.variant) for (const n of chain) if (r.componentSkin(n)?.variants?.[el.variant]?.states?.[s.name]) out.push(`${r.skin}:${n}.variants.${el.variant}.states.${s.name}`);
    }
    if (el.style) out.push("instance overrides");
    return out;
  }

  validateLayout(el: UIElement = this.ui.root): LayoutIssue[] {
    const issues: LayoutIssue[] = [];
    const ctx = { viewportWidth: this.ui.viewport.width, viewportHeight: this.ui.viewport.height };
    const visit = (e: UIElement): void => {
      if (!e.visible) return;
      const b = e.bounds;
      if (!b.isValid) issues.push({ kind: "invalid-geometry", element: e.debugName, detail: `bounds ${b.x},${b.y} ${b.width}x${b.height}` });
      const parent = e.parent;
      if (parent && e.isFlowChild) {
        const minW = e.clampWidth(0, parent.contentRect.width, ctx);
        const minH = e.clampHeight(0, parent.contentRect.height, ctx);
        if (b.width + 1e-3 < minW || b.height + 1e-3 < minH) issues.push({ kind: "below-minimum", element: e.debugName, detail: `${round(b.width)}x${round(b.height)} < minimum ${round(minW)}x${round(minH)}` });
        if (!parent.clipChildren && parent !== this.ui.root && (b.right > parent.bounds.right + 0.5 || b.bottom > parent.bounds.bottom + 0.5 || b.x < parent.bounds.x - 0.5 || b.y < parent.bounds.y - 0.5) && !(parent.parent === this.ui.root)) {
          issues.push({ kind: "overflow", element: e.debugName, detail: `extends outside ${parent.debugName}` });
        }
      }
      if (e instanceof UIContainer && (e.layout instanceof FlexLayout || e.layout instanceof GridLayout)) {
        const kids = e.children.filter((c) => c.isFlowChild && c.bounds.width > 0 && c.bounds.height > 0);
        for (let i = 0; i < kids.length; i++) {
          for (let j = i + 1; j < kids.length; j++) {
            const a = kids[i]!.bounds;
            const c = kids[j]!.bounds;
            const ox = Math.min(a.right, c.right) - Math.max(a.x, c.x);
            const oy = Math.min(a.bottom, c.bottom) - Math.max(a.y, c.y);
            if (ox > 0.5 && oy > 0.5) issues.push({ kind: "overlap", element: kids[i]!.debugName, detail: `overlaps ${kids[j]!.debugName} by ${round(ox)}x${round(oy)}` });
          }
        }
      }
      for (const c of e.children) visit(c);
    };
    visit(el);
    return issues;
  }

  focusOrder(): string[] {
    return this.ui.focus.sequence().map((e) => e.debugName);
  }

  renderOrder(): string[] {
    const out: string[] = [];
    const visit = (e: UIElement): void => {
      if (!e.visible) return;
      out.push(e.debugName);
      for (const c of e.paintOrder) visit(c);
    };
    visit(this.ui.root);
    return out;
  }

  accessibilityTree(el: UIElement = this.ui.root): AccessibilityNode {
    const node = (e: UIElement): AccessibilityNode => {
      const a = e.accessibility;
      const n: AccessibilityNode = {
        role: a.role,
        label: a.label,
        description: a.description,
        states: this.ui.resolver.states.names(e.state),
        focusable: e.focusable,
        children: e.children.filter((c) => c.visible).map(node),
      };
      if (a.value !== undefined) n.value = a.value;
      return n;
    };
    return node(el);
  }

  resourceReport(): { elements: number; listeners: number; bindings: number; animations: number; ticking: number } {
    let listeners = 0;
    this.ui.root.walk((e) => {
      listeners += e.listenerCount;
    });
    return { elements: this.ui.elements, listeners, bindings: this.ui.binder.activeBindings, animations: this.ui.animator.activeCount, ticking: this.ui.lastFrame.tickingElements };
  }

  get missingAssets(): string[] {
    return this.ui.messages.filter((m) => m.message.startsWith("ui assets:")).map((m) => m.message);
  }

  startInputTrace(): void {
    this.ui.router.traceEnabled = true;
    this.ui.router.trace.length = 0;
  }

  stopInputTrace(): InputTraceEntry[] {
    this.ui.router.traceEnabled = false;
    return [...this.ui.router.trace];
  }

  get inputTrace(): readonly InputTraceEntry[] {
    return this.ui.router.trace;
  }

  /** Paint the debug overlay (called by the manager after the layers). */
  paintOverlay(p: UIPainter): void {
    const o = this.overlay;
    if (!o.enabled) return;
    const ui = this.ui;
    const visit = (e: UIElement, depth: number): void => {
      if (!e.visible) return;
      const b = e.bounds;
      if (o.padding) {
        const c = e.contentRect;
        if (c.width !== b.width || c.height !== b.height) p.strokeRect(c.x, c.y, c.width, c.height, 0x22c55e66, 1);
      }
      if (o.bounds && depth > 1) p.strokeRect(b.x, b.y, b.width, b.height, e.layoutDirty ? 0xef4444cc : 0x38bdf866, 1);
      for (const c of e.paintOrder) visit(c, depth + 1);
    };
    for (const layer of ui.root.children) if (layer.name !== "layer:debug") visit(layer, 1);
    if (o.hovered && ui.router.hovered) {
      const b = ui.router.hovered.bounds;
      p.strokeRect(b.x, b.y, b.width, b.height, 0xfacc15ff, 2);
    }
    if (o.focusOrder) {
      ui.focus.sequence().forEach((e, i) => {
        const l = ui.text.layout({ text: String(i + 1), family: "default", size: 10 });
        p.fillRect(e.bounds.x, e.bounds.y, l.width + 6, l.height, 0x000000b0, 3);
        p.text(l, e.bounds.x + 3, e.bounds.y, e.hasState(UIState.Focused) ? 0xfacc15ff : 0xffffffff);
      });
    }
    if (o.stats) {
      const f = ui.lastFrame;
      const text = `ui ${f.elements} el | styles ${f.styleResolves} | layout ${f.layoutPasses}p ${f.measures}m ${f.arranges}a | draw ${f.drawInstances} inst ${f.drawBatches} batches | anim ${f.activeAnimations} | ${ui.breakpoint} ${round(ui.viewport.width)}x${round(ui.viewport.height)} @${ui.viewport.scale.toFixed(2)}`;
      const l = ui.text.layout({ text, family: "default", size: 11 });
      p.fillRect(4, ui.viewport.height - l.height - 8, l.width + 8, l.height + 4, 0x000000c0, 3);
      p.text(l, 8, ui.viewport.height - l.height - 6, 0xe5e7ebff);
    }
  }
}

function round(v: number): number {
  return Math.round(v * 10) / 10;
}
