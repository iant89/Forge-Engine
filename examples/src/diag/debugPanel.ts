/**
 * Shared floating debug panel for the demo (top stats HUD and the `?diag=1` report).
 *
 * Expanded: a fixed panel with a title bar (title · status · reset-layout · copy-icon · collapse at
 * the far right). The bar drags the panel; a 44px corner grip resizes it. Holding a drag within
 * `snapThreshold` px of a viewport edge for ~2 s shows a translucent ghost of the flush position
 * (corners snap to two edges) and releasing snaps there. Everything is clamped on-screen, including
 * after rotation/resize, and a stored layout that would be off-screen is reset to the default.
 * Collapsed: only a round 44px icon button in a corner, slid clear of on-screen controls (`avoid`).
 *
 * iPhone Safari: pointer events with pointer capture, `touch-action:none` on the bar and grip,
 * `touch-action:manipulation` on buttons, no hover reliance; the copy runs synchronously inside the
 * click so WebKit keeps the gesture (with the textarea/execCommand fallback in copyText.ts).
 * Position, size, snapped edges and collapsed state persist in localStorage (best-effort).
 */
import { copyText, type CopyEnv } from "./copyText.js";
import {
  SnapTracker,
  clampRect,
  dragRect,
  loadLayout,
  placeIcon,
  resizeRect,
  resolveRect,
  saveLayout,
  snapRect,
  cornerIcon,
  readInsets,
  withMargin,
  type Insets,
  type Layout,
  type MinSize,
  type Rect,
  type ResizeCorner,
  type SnapEdges,
  type StorageLike,
  type Viewport,
} from "./panelLayout.js";

export type { StorageLike } from "./panelLayout.js";

/** Label shown in the bar after a copy attempt. */
export function copyResultLabel(ok: boolean): string {
  return ok ? "Copied" : "Copy failed";
}

const svg = (body: string, size = 18): string =>
  `<svg viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
export const ICONS = {
  copy: svg('<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>'),
  reset: svg('<path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 3v6h6"/>'),
  collapse: svg('<path d="M5 12h14"/>'),
  bug: svg(
    '<rect x="8" y="6" width="8" height="14" rx="4"/><path d="M9 3l1.5 3M15 3l-1.5 3M4 10h4M16 10h4M4 15h4M16 15h4M5 20l3-2M19 20l-3-2M12 10v8"/>',
    22,
  ),
  stats: svg('<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>', 22),
  profiler: svg('<circle cx="12" cy="13.5" r="7.5"/><path d="M12 9.5V13l2.5 1.5M9 2.5h6M12 2.5V6"/>', 22),
  terminal: svg('<path d="M4 5h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Z"/><path d="m6 9 3 3-3 3M11 15h5"/>', 22),
  grip: svg('<path d="M20 8L8 20M20 14l-6 6M20 19l-1 1"/>', 16),
};

const STYLE_ID = "forge-debug-panel-style";
const CSS = `
.fdp{position:fixed;display:flex;flex-direction:column;min-width:0;min-height:0;z-index:60;
  background:rgb(2 4 8 / 0.9);border:1px solid rgb(56 189 248 / 0.55);border-radius:8px;overflow:hidden;
  box-shadow:0 6px 24px rgb(0 0 0 / 0.45)}
.fdp.fdp-collapsed{display:none!important}
.fdp.fdp-pass{pointer-events:none}
.fdp.fdp-pass>.fdp-bar,.fdp.fdp-pass>.fdp-grip{pointer-events:auto}
.fdp-safe-probe{position:fixed;left:0;top:0;width:0;height:0;visibility:hidden;pointer-events:none;
  padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)}
.fdp>.fdp-body{flex:1 1 auto;min-height:0;overflow:auto;margin:0;max-width:none!important;max-height:none!important}
.fdp-bar{flex:0 0 auto;display:flex;align-items:center;gap:2px;min-height:44px;padding:0 0 0 10px;
  font:11px ui-monospace,SFMono-Regular,Menlo,monospace;color:#7dd3fc;background:rgb(8 14 22 / 0.96);
  touch-action:none;cursor:grab;-webkit-user-select:none;user-select:none}
.fdp-bar-top{border-bottom:1px solid rgb(56 189 248 / 0.35)}
.fdp-bar-bottom{border-top:1px solid rgb(56 189 248 / 0.35)}
.fdp-dragging .fdp-bar{cursor:grabbing}
.fdp-title{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.fdp-status{color:#a7f3d0;white-space:nowrap}
.fdp-btn{display:inline-flex;align-items:center;justify-content:center;flex:0 0 auto;width:44px;height:44px;
  margin:0;padding:0;background:transparent;color:#7dd3fc;border:0;border-left:1px solid rgb(56 189 248 / 0.25);
  cursor:pointer;touch-action:manipulation;-webkit-tap-highlight-color:transparent}
.fdp-btn:active{background:rgb(56 189 248 / 0.2)}
.fdp-grip{position:absolute;right:0;width:44px;height:44px;display:flex;align-items:center;justify-content:center;
  color:rgb(125 211 252 / 0.8);touch-action:none;cursor:nwse-resize;z-index:1}
.fdp-grip-br{bottom:0;align-items:flex-end;justify-content:flex-end;padding:3px}
.fdp-grip-tr{top:0;align-items:flex-start;justify-content:flex-end;padding:3px;cursor:nesw-resize}
.fdp-grip-tr svg{transform:scaleY(-1)}
.fdp-ghost{position:fixed;z-index:59;pointer-events:none;display:none;border:2px dashed rgb(56 189 248 / 0.9);
  background:rgb(56 189 248 / 0.16);border-radius:8px}
.fdp-ghost.fdp-ghost-on{display:block}
.fdp-icon{position:fixed;z-index:61;width:44px;height:44px;border-radius:50%;padding:0;display:none;
  align-items:center;justify-content:center;background:rgb(2 4 8 / 0.88);color:#7dd3fc;
  border:1px solid rgb(56 189 248 / 0.7);box-shadow:0 2px 10px rgb(0 0 0 / 0.4);cursor:pointer;
  touch-action:manipulation;-webkit-tap-highlight-color:transparent}
.fdp-icon.fdp-icon-on{display:flex}
`;

export interface DebugPanelOptions {
  /** The element that shows the panel's text. It is moved into the new panel. */
  body: HTMLElement;
  title: string;
  /** Which edge of the panel carries the title bar. */
  barEdge: "top" | "bottom";
  getText: () => string;
  storageKey: string;
  /** Default expanded rect for a viewport (also what reset restores). */
  defaultRect: (vp: Viewport) => Rect;
  minSize?: MinSize;
  /** Corner for the collapsed icon. Top icons slide left past obstacles, bottom icons slide up. */
  iconCorner: "top-right" | "bottom-right";
  iconSvg: string;
  /** CSS selectors of controls the collapsed icon must not cover. */
  avoid?: string[];
  defaultCollapsed?: boolean;
  snapThreshold?: number;
  snapDwellMs?: number;
  /** Gap kept from the safe-area edges (px). Default 10. */
  margin?: number;
  /** Test hook: returns the probe's computed padding. Default getComputedStyle(probe). */
  readSafeArea?: () => { paddingLeft: string; paddingTop: string; paddingRight: string; paddingBottom: string } | null;
  /**
   * Called whenever the collapsed state changes — by the bar's collapse button, the corner icon, or
   * `setCollapsed` — so a host that mirrors the state elsewhere (the demo toolbar's Profiler
   * button) stays in sync. Not called during mount: read `collapsed` for the restored state.
   */
  onCollapsedChange?: (collapsed: boolean) => void;
  /** Body ignores touches (they reach the canvas); only the bar, its buttons and the grip take input. */
  passThroughBody?: boolean;
  storage?: StorageLike | null;
  clipboard?: CopyEnv["clipboard"];
  doc?: Document;
  win?: Pick<Window, "innerWidth" | "innerHeight" | "getComputedStyle" | "addEventListener" | "removeEventListener" | "setInterval" | "clearInterval" | "setTimeout" | "clearTimeout">;
  now?: () => number;
}

export interface DebugPanel {
  root: HTMLDivElement;
  bar: HTMLDivElement;
  grip: HTMLDivElement;
  ghost: HTMLDivElement;
  icon: HTMLButtonElement;
  copyButton: HTMLButtonElement;
  toggleButton: HTMLButtonElement;
  resetButton: HTMLButtonElement;
  readonly collapsed: boolean;
  readonly rect: Rect;
  readonly snap: SnapEdges | null;
  setCollapsed(collapsed: boolean): void;
  resetLayout(): void;
  relayout(): void;
  copy(): Promise<boolean>;
  dispose(): void;
}

function safeLocalStorage(): StorageLike | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

interface PtrEvent {
  pointerId: number;
  clientX: number;
  clientY: number;
  button?: number;
  stopPropagation(): void;
  preventDefault?(): void;
}

export function mountDebugPanel(opts: DebugPanelOptions): DebugPanel {
  const doc = opts.doc ?? document;
  const win = opts.win ?? window;
  const now = opts.now ?? (() => performance.now());
  const storage = opts.storage === undefined ? safeLocalStorage() : opts.storage;
  const min = opts.minSize ?? { w: 180, h: 88 };
  const corner: ResizeCorner = opts.barEdge === "bottom" ? "tr" : "br";
  if (!doc.getElementById(STYLE_ID)) {
    const style = doc.createElement("style");
    style.id = STYLE_ID;
    style.textContent = CSS;
    doc.head.appendChild(style);
  }
  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls: string): HTMLElementTagNameMap[K] => {
    const e = doc.createElement(tag);
    e.className = cls;
    return e;
  };
  // Safe-area probe: a hidden fixed element whose padding is env(safe-area-inset-*), read back via
  // getComputedStyle and refreshed on resize/orientationchange (rotation moves the notch side).
  const margin = opts.margin ?? 10;
  const probe = el("div", "fdp-safe-probe");
  doc.body.appendChild(probe);
  let safe: Insets = { l: 0, t: 0, r: 0, b: 0 };
  const measureSafe = (): void => {
    try {
      safe = readInsets(opts.readSafeArea ? opts.readSafeArea() : (win.getComputedStyle?.(probe as unknown as Element) ?? null));
    } catch {
      safe = { l: 0, t: 0, r: 0, b: 0 };
    }
  };
  const vp = (): Viewport => ({ w: win.innerWidth, h: win.innerHeight, inset: withMargin(safe, margin) });

  const stored = loadLayout(storage, opts.storageKey, opts.defaultCollapsed ?? false);
  let collapsed = stored.collapsed;
  let snap: SnapEdges | null = stored.snap ?? null;
  let custom: Rect | null = stored.rect;
  let rect: Rect = custom ?? opts.defaultRect(vp());

  const button = (cls: string, html: string, label: string): HTMLButtonElement => {
    const b = el("button", `fdp-btn ${cls}`);
    b.type = "button";
    b.innerHTML = html;
    b.setAttribute("aria-label", label);
    b.title = label;
    // A press on a button must not start a bar drag.
    b.addEventListener("pointerdown", (e) => e.stopPropagation());
    return b;
  };

  const root = el("div", opts.passThroughBody ? "fdp fdp-pass" : "fdp");
  if (opts.passThroughBody) opts.body.style.pointerEvents = "none";
  opts.body.parentNode?.insertBefore(root, opts.body);
  opts.body.classList.add("fdp-body");
  const bar = el("div", `fdp-bar fdp-bar-${opts.barEdge}`);
  const title = el("span", "fdp-title");
  title.textContent = opts.title;
  const status = el("span", "fdp-status");
  status.setAttribute("aria-live", "polite");
  const resetButton = button("fdp-reset", ICONS.reset, `Reset ${opts.title} layout`);
  const copyButton = button("fdp-copy", ICONS.copy, `Copy ${opts.title}`);
  const toggleButton = button("fdp-toggle", ICONS.collapse, `Collapse ${opts.title}`);
  toggleButton.setAttribute("aria-expanded", "true");
  bar.append(title, status, resetButton, copyButton, toggleButton);
  const grip = el("div", `fdp-grip fdp-grip-${corner}`);
  grip.innerHTML = ICONS.grip;
  grip.setAttribute("aria-label", `Resize ${opts.title}`);
  grip.setAttribute("role", "separator");
  if (opts.barEdge === "top") root.append(bar, opts.body, grip);
  else root.append(opts.body, bar, grip);
  const ghost = el("div", "fdp-ghost");
  const icon = el("button", "fdp-icon");
  icon.type = "button";
  icon.innerHTML = opts.iconSvg;
  icon.setAttribute("aria-label", `Show ${opts.title}`);
  icon.title = `Show ${opts.title}`;
  doc.body.appendChild(ghost);
  doc.body.appendChild(icon);

  const persist = (): void => saveLayout(storage, opts.storageKey, { collapsed, rect: custom, snap } satisfies Layout);

  const apply = (): void => {
    const s = root.style;
    s.left = `${rect.x}px`;
    s.top = `${rect.y}px`;
    s.width = `${rect.w}px`;
    s.height = `${rect.h}px`;
    root.classList.toggle("fdp-collapsed", collapsed);
    icon.classList.toggle("fdp-icon-on", collapsed);
  };

  const placeIconNow = (): void => {
    const v = vp();
    const base = cornerIcon(opts.iconCorner, v);
    const obstacles: Rect[] = [];
    for (const sel of opts.avoid ?? []) {
      let list: ArrayLike<Element> = [];
      try {
        list = doc.querySelectorAll(sel);
      } catch {
        list = [];
      }
      for (let i = 0; i < list.length; i++) {
        const node = list[i]!;
        if (node === icon) continue;
        const r = node.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) obstacles.push({ x: r.left, y: r.top, w: r.width, h: r.height });
      }
    }
    const p = placeIcon(base, obstacles, opts.iconCorner === "top-right" ? "left" : "up", 8, v);
    icon.style.left = `${p.x}px`;
    icon.style.top = `${p.y}px`;
  };

  /**
   * Re-fit to the current viewport. Snapped panels stay flush; others clamp. On load (`restoring`) a
   * stored layout that is off-screen for this viewport resets to the default instead; a live
   * rotation only clamps, so a panel the user just placed is never thrown back to the default.
   */
  const fit = (restoring: boolean): void => {
    measureSafe();
    const v = vp();
    if (custom && snap) rect = snapRect(custom, snap, v, min);
    else if (!restoring) rect = custom ? clampRect(custom, v, min) : clampRect(opts.defaultRect(v), v, min);
    else {
      const r = resolveRect(custom, opts.defaultRect(v), v, min);
      rect = r.rect;
      if (r.reset) {
        custom = null;
        snap = null;
        persist();
      }
    }
    if (custom) custom = rect;
    apply();
    placeIconNow();
  };
  const relayout = (): void => fit(false);

  const setCollapsed = (c: boolean): void => {
    collapsed = c;
    persist();
    relayout();
    opts.onCollapsedChange?.(c);
    if (!c) toggleButton.focus?.();
  };
  const resetLayout = (): void => {
    custom = null;
    snap = null;
    persist();
    relayout();
  };

  // --- drag (title bar) with edge snapping, and resize (grip) ---
  const tracker = new SnapTracker(vp, min, opts.snapThreshold ?? 24, opts.snapDwellMs ?? 2000);
  let drag: { id: number; sx: number; sy: number; start: Rect; mode: "move" | "resize" } | null = null;
  let dwellTimer: number | null = null;
  const showGhost = (): void => {
    const g = tracker.ghost;
    ghost.classList.toggle("fdp-ghost-on", g !== null);
    if (g) {
      ghost.style.left = `${g.x}px`;
      ghost.style.top = `${g.y}px`;
      ghost.style.width = `${g.w}px`;
      ghost.style.height = `${g.h}px`;
    }
  };
  const stopDwell = (): void => {
    if (dwellTimer !== null) win.clearInterval(dwellTimer);
    dwellTimer = null;
  };
  const begin = (mode: "move" | "resize", target: HTMLElement) => (e: PtrEvent): void => {
    if (drag || (e.button !== undefined && e.button !== 0)) return;
    e.stopPropagation();
    e.preventDefault?.();
    drag = { id: e.pointerId, sx: e.clientX, sy: e.clientY, start: { ...rect }, mode };
    try {
      target.setPointerCapture?.(e.pointerId);
    } catch {
      /* capture is an optimisation */
    }
    root.classList.add("fdp-dragging");
    if (mode === "move") {
      tracker.update(rect, now());
      stopDwell();
      // Ticks while the finger is held still (no pointermove), so the ghost appears on dwell alone.
      dwellTimer = win.setInterval(() => {
        if (tracker.tick(now())) showGhost();
      }, 100);
    }
  };
  const move = (e: PtrEvent): void => {
    if (!drag || e.pointerId !== drag.id) return;
    e.preventDefault?.();
    const dx = e.clientX - drag.sx;
    const dy = e.clientY - drag.sy;
    rect = drag.mode === "move" ? dragRect(drag.start, dx, dy, vp(), min) : resizeRect(drag.start, dx, dy, corner, vp(), min);
    apply();
    if (drag.mode === "move" && tracker.update(rect, now())) showGhost();
  };
  const end = (e: PtrEvent, cancelled = false): void => {
    if (!drag || e.pointerId !== drag.id) return;
    const mode = drag.mode;
    drag = null;
    stopDwell();
    root.classList.remove("fdp-dragging");
    if (mode === "move") {
      // iOS fires pointercancel for system gestures (edge swipe, notification pull); that is not a
      // release, so it never commits a pending snap.
      const released = tracker.release();
      const snapped = cancelled ? null : released;
      showGhost();
      if (snapped) {
        rect = snapped.rect;
        snap = snapped.edges;
      } else snap = null;
    } else if (snap) {
      // Keep the snapped edges flush after a resize.
      rect = snapRect(rect, snap, vp(), min);
    }
    custom = { ...rect };
    apply();
    persist();
  };
  const onBarDown = begin("move", bar);
  const onGripDown = begin("resize", grip);
  bar.addEventListener("pointerdown", onBarDown as unknown as EventListener);
  grip.addEventListener("pointerdown", onGripDown as unknown as EventListener);
  for (const t of [bar, grip]) {
    t.addEventListener("pointermove", move as unknown as EventListener);
    t.addEventListener("pointerup", end as unknown as EventListener);
    t.addEventListener("pointercancel", ((e: PtrEvent) => end(e, true)) as unknown as EventListener);
  }

  // --- buttons ---
  let reset: number | null = null;
  const copy = (): Promise<boolean> => {
    const clip = opts.clipboard !== undefined ? opts.clipboard : (globalThis.navigator?.clipboard ?? null);
    return copyText(opts.getText(), { clipboard: clip, document: doc }).then((ok) => {
      status.textContent = copyResultLabel(ok);
      if (reset) win.clearTimeout(reset);
      reset = win.setTimeout(() => (status.textContent = ""), 1500);
      return ok;
    });
  };
  const onCopy = (e: Event): void => {
    e.stopPropagation();
    void copy();
  };
  const onCollapse = (e: Event): void => {
    e.stopPropagation();
    setCollapsed(true);
  };
  const onExpand = (e: Event): void => {
    e.stopPropagation();
    setCollapsed(false);
  };
  const onReset = (e: Event): void => {
    e.stopPropagation();
    resetLayout();
  };
  copyButton.addEventListener("click", onCopy);
  toggleButton.addEventListener("click", onCollapse);
  icon.addEventListener("click", onExpand);
  resetButton.addEventListener("click", onReset);
  win.addEventListener("resize", relayout);
  win.addEventListener("orientationchange", relayout);
  // Scene switches show/hide the controls the icon avoids; re-place it cheaply once a second.
  const iconTimer = win.setInterval(() => {
    if (collapsed) placeIconNow();
  }, 1000);

  fit(true);

  return {
    root,
    bar,
    grip,
    ghost,
    icon,
    copyButton,
    toggleButton,
    resetButton,
    get collapsed() {
      return collapsed;
    },
    get rect() {
      return { ...rect };
    },
    get snap() {
      return snap ? { ...snap } : null;
    },
    setCollapsed,
    resetLayout,
    relayout,
    copy,
    dispose() {
      stopDwell();
      win.clearInterval(iconTimer);
      if (reset) win.clearTimeout(reset);
      win.removeEventListener("resize", relayout);
      win.removeEventListener("orientationchange", relayout);
      root.remove();
      probe.remove();
      ghost.remove();
      icon.remove();
    },
  };
}

