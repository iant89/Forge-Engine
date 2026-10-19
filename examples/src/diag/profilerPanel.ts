/**
 * The demo's floating **Profiler** panel: the report text inside the same draggable / resizable /
 * edge-snapping chrome as the stats HUD and the `?diag=1` report (see `debugPanel.ts`), so the
 * profiler is resizable (corner grip), collapsible (bar button → corner icon) and dockable (hold a
 * drag near a viewport edge for the dwell and release on the ghost).
 *
 * Shapes that matter here:
 *  - One piece of state, three controls. The panel's own collapse button, its corner icon and the
 *    toolbar's Profiler button all drive `collapsed`, and `onCollapsedChange` keeps the toolbar
 *    button's `active` / `aria-pressed` in sync whichever one the user touched. The panel starts
 *    collapsed: the demo opens on a scene, not on a diagnostic.
 *  - Repainting is throttled (`repaintMs`, 250 ms by default) and only happens while the panel is
 *    open, so a closed profiler costs nothing and an open one never re-renders at frame rate.
 *  - The body is pointer-transparent like the stats HUD's: a drag or a wheel over the report
 *    reaches the canvas, and the bar's Copy button is how the text leaves the page.
 */
import { ICONS, mountDebugPanel, type DebugPanel, type DebugPanelOptions, type StorageLike } from "./debugPanel.js";
import { bounds, type Rect, type SnapEdges } from "./panelLayout.js";
import { mountProfilerTimeline, type ProfilerTimeline, type ProfilerTimelineOptions, type TimelineState } from "./profilerTimeline.js";

/**
 * On-screen controls a collapsed profiler icon must not cover.
 *
 *
 * These are the *buttons*, not their containers: the touch overlays (`#weather-touch`, `#sky-touch`,
 * …) are `position: fixed; inset: 0` full-viewport layers with `pointer-events: none`, so listing a
 * container would shove the icon off the top of the screen instead of one row up. `.touch-btn` is
 * what the demo actually renders (13 of them across the sky, weather, offroad, vehicle, rescue and
 * rover-tool panels), and `tests/examples/profilerPanel.test.ts` pins every selector here against
 * `examples/index.html` so this list cannot rot again — an earlier revision named `.touch-controls`,
 * which no element in the page carries, and the icon sat on top of the weather panel's Pause button.
 *
 * `#hud-icon` and `#forge-diag-icon` are created at runtime by `mountDebugPanel`, so they are absent
 * from the static markup but present when this runs.
 */
export const PROFILER_AVOID = [
  "#toolbar",
  "#hud-icon",
  "#forge-diag-icon",
  "#controls-hint",
  ".touch-btn",
  ".veh-face",
  "#veh-gear-switch",
  "#veh-stick",
  ".arm-stick",
  "#rover-tool-panel",
];

export interface ProfilerPanelOptions {
  /** The element that shows the report (the `<pre>`); it is moved into the floating panel. */
  body: HTMLElement;
  /**
   * Draw the frame/scope history as a strip above the report (Phase 21.1). Omit or pass `null` for
   * the text-only panel. The strip is mounted with this panel's `doc`/`win`/`now`, so the fake-DOM
   * suite drives it deterministically.
   */
  timeline?: ProfilerTimelineOptions | null;
  /** Toolbar button that opens / closes the panel; absent is fine (the panel still works). */
  button?: HTMLElement | null;
  /** The report text; called on open and on each throttled repaint. */
  report: () => string;
  /** localStorage key for the layout (position, size, docked edges, collapsed). */
  storageKey?: string;
  storage?: StorageLike | null;
  /** Minimum ms between repaints while the panel is open. Default 250. */
  repaintMs?: number;
  avoid?: string[];
  doc?: Document;
  win?: DebugPanelOptions["win"];
  now?: () => number;
}

export interface ProfilerPanelLayout {
  /** Inverse of the panel's collapsed state: false while only the corner icon shows. */
  visible: boolean;
  collapsed: boolean;
  rect: Rect;
  snap: SnapEdges | null;
}

export interface ProfilerPanel {
  /** The underlying floating panel, for hosts that want the raw chrome (rect, snap, copy, …). */
  readonly ui: DebugPanel;
  readonly visible: boolean;
  /** Open or close the panel; keeps the toolbar button in sync either way. */
  setVisible(visible: boolean): void;
  toggle(): void;
  /** Repaint the report if the panel is open and `repaintMs` has elapsed since the last one. */
  tick(nowMs?: number): void;
  /** Current geometry + dock state (used by the browser gate and dev tooling). */
  layout(): ProfilerPanelLayout;
  /** The timeline strip's state, or null when the panel was mounted without one. */
  timelineState(): TimelineState | null;
  dispose(): void;
}

export function mountProfilerPanel(options: ProfilerPanelOptions): ProfilerPanel {
  const doc = options.doc ?? document;
  const now = options.now ?? (() => performance.now());
  const repaintMs = options.repaintMs ?? 250;
  let visible = false;
  let nextPaint = 0;

  /**
   * With a timeline, the panel's body is a small column: the strip, a one-line readout of the frame
   * it has selected, then the text report. The strip is a canvas because 180 columns × N categories
   * of DOM nodes would repaint far worse than the 4 Hz throttle the text report lives on; the
   * readout is a real element so it stays selectable and copyable.
   */
  let timeline: ProfilerTimeline | null = null;
  let readout: HTMLElement | null = null;
  let panelBody: HTMLElement = options.body;
  if (options.timeline) {
    panelBody = doc.createElement("div");
    panelBody.style.cssText = "display:flex;flex-direction:column;min-height:0;overflow:hidden";
    // The wrapper has to stand exactly where the report stood: `mountDebugPanel` inserts its own
    // root *before* the body it is given and then adopts it, so a wrapper that is not in the
    // document yet leaves the whole panel detached (and the demo's `#profiler-panel` id unreachable).
    options.body.parentNode?.insertBefore(panelBody, options.body);
    timeline = mountProfilerTimeline({ ...options.timeline, doc, win: options.win, now });
    // `pointer-events: auto` is repeated here (the widget sets it too, for hosts that mount the
    // strip on its own) because the panel's body is pointer-transparent and a `cssText` assignment
    // replaces every inline style on the element.
    timeline.el.style.cssText = "flex:0 0 auto;display:block;width:100%;height:96px;pointer-events:auto;touch-action:pan-y";
    readout = doc.createElement("div");
    readout.style.cssText =
      "flex:0 0 auto;font:10px/1.35 ui-monospace,SFMono-Regular,Menlo,monospace;color:#a7f3d0;" +
      "padding:3px 8px 4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis";
    // The report keeps the padding and colour the page gave it, but it is now one flex child among
    // three rather than the panel's own body, so it has to scroll for itself.
    options.body.style.cssText += ";margin:0;flex:1 1 auto;min-height:0;overflow:auto";
    panelBody.appendChild(timeline.el);
    panelBody.appendChild(readout);
    panelBody.appendChild(options.body);
  }

  const paint = (): void => {
    options.body.textContent = options.report();
    if (timeline) {
      timeline.paint();
      if (readout) readout.textContent = timeline.state().readout;
    }
  };
  const syncButton = (open: boolean): void => {
    const button = options.button;
    if (!button) return;
    button.classList.toggle("active", open);
    button.setAttribute("aria-pressed", open ? "true" : "false");
  };
  /** Paint once on open (never the stale placeholder) and start the repaint interval from now. */
  const open = (): void => {
    visible = true;
    syncButton(true);
    paint();
    nextPaint = now() + repaintMs;
  };
  const close = (): void => {
    visible = false;
    syncButton(false);
  };

  const ui = mountDebugPanel({
    body: panelBody,
    title: "profiler",
    barEdge: "top",
    getText: () => options.report(),
    storageKey: options.storageKey ?? "forge.panel.profiler",
    // Along the bottom of the safe area, where the panel has always lived; the bar adds 44px.
    defaultRect: (vp) => {
      const b = bounds(vp);
      const narrow = vp.w <= 820;
      const h = Math.min(narrow ? 236 : 300, Math.round(vp.h * 0.46));
      return { x: b.l, y: b.b - h, w: Math.min(narrow ? b.w - 20 : 560, b.w), h };
    },
    minSize: { w: 240, h: 120 },
    iconCorner: "bottom-right",
    iconSvg: ICONS.profiler,
    avoid: options.avoid ?? PROFILER_AVOID,
    // Closed until asked for: the toolbar button (and, once collapsed, the corner icon) opens it.
    defaultCollapsed: true,
    passThroughBody: true,
    storage: options.storage,
    doc,
    win: options.win,
    now,
    onCollapsedChange: (collapsed) => (collapsed ? close() : open()),
  });

  // A layout restored from localStorage may already be open; adopt it (and its toolbar state)
  // rather than assuming the panel starts closed.
  if (ui.collapsed) close();
  else open();

  const setVisible = (next: boolean): void => {
    if (next === visible) return;
    ui.setCollapsed(!next);
  };

  options.button?.addEventListener("click", () => setVisible(!visible));

  return {
    ui,
    get visible() {
      return visible;
    },
    setVisible,
    toggle: () => setVisible(!visible),
    tick(nowMs?: number) {
      if (!visible) return;
      const t = nowMs ?? now();
      if (t < nextPaint) return;
      nextPaint = t + repaintMs;
      paint();
    },
    layout: () => ({ visible, collapsed: ui.collapsed, rect: ui.rect, snap: ui.snap }),
    timelineState: () => timeline?.state() ?? null,
    dispose() {
      timeline?.dispose();
      ui.dispose();
    },
  };
}
