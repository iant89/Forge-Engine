/**
 * The demo's profiler **timeline strip**: the frame/scope history as a canvas above the text report
 * in the floating Profiler panel (`profilerPanel.ts`).
 *
 * The geometry comes from `@forge/engine`'s `frameTimeline` / `layoutTimeline` (pure, and pinned by
 * `tests/core/frameTimeline.test.ts`); this file is only the widget around it — sizing, pointer
 * selection and the drawing itself.
 *
 * Shapes that matter here:
 *  - **Two bands, one selection.** The top band is the rolling frame history (one column per frame,
 *    stacked by category, with the 60 Hz budget drawn as a line); the bottom is a lane chart of the
 *    selected frame's scopes, so "when did it spike?" and "what was in it?" are the same gesture.
 *  - **Hover to inspect, tap to pin.** Hovering a column selects it; tapping pins it so the numbers
 *    stop moving while you read them, and tapping it again releases it. Pinning is by *frame number*,
 *    not position, because the history is a ring: a pinned frame keeps its identity until it scrolls
 *    out of the window.
 *  - **Painting is throttled and only happens when the canvas has a size.** A closed panel costs
 *    nothing, and a hover that stays inside one column does not repaint.
 *  - **The drawing surface is a four-method interface** ({@link TimelineSurface}), not a
 *    `CanvasRenderingContext2D`, so the whole thing is paintable by a fake context in a Node test —
 *    the strip is pinned by its rectangles, not by a screenshot.
 */

import {
  frameTimeline,
  formatTimelineFrame,
  hitTestTimeline,
  layoutTimeline,
  type FrameRecord,
  type TimelineCategory,
  type TimelineFrame,
  type TimelineLayout,
  type TimelineModel,
} from "@forge/engine";

/** The strip's palette: one hue per roadmap category, dim slate for time inside none of them. */
export const TIMELINE_COLORS: Readonly<Record<TimelineCategory, string>> = {
  simulation: "#38bdf8",
  physics: "#818cf8",
  terrain: "#4ade80",
  streaming: "#fbbf24",
  rendering: "#f472b6",
  particles: "#2dd4bf",
  scripting: "#c084fc",
  audio: "#fca5a5",
  other: "#64748b",
};

const BACKDROP = "rgb(2 6 12 / 0.92)";
const GRID = "rgb(148 163 184 / 0.22)";
const BUDGET = "rgb(248 113 113 / 0.8)";
const GPU = "rgb(167 243 208 / 0.85)";
const CURSOR = "rgb(125 211 252 / 0.9)";
const LABEL = "#cbd5e1";
const LABEL_DIM = "rgb(203 213 225 / 0.65)";

/** The four canvas calls the strip needs — small enough to fake in a test, and all it really uses. */
export interface TimelineSurface {
  clearRect(x: number, y: number, w: number, h: number): void;
  fillRect(x: number, y: number, w: number, h: number): void;
  fillText(text: string, x: number, y: number): void;
  measureText(text: string): { width: number };
  /** Called once per paint so the strip can draw in CSS pixels on a device-pixel backing store. */
  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void;
  fillStyle: string;
  font: string;
  textBaseline: string;
}

export interface TimelineWindow {
  addEventListener?(type: string, fn: () => void): void;
  removeEventListener?(type: string, fn: () => void): void;
  devicePixelRatio?: number;
}

export interface ProfilerTimelineOptions {
  /** The frame history, newest last — `engine.profiler.frameHistory()`. */
  frames: () => readonly FrameRecord[];
  /** Supply an element (the demo does); otherwise one is created. */
  canvas?: HTMLCanvasElement;
  /** CSS pixel size. When absent the element's `clientWidth`/`clientHeight` are measured instead. */
  width?: number;
  height?: number;
  /** Frame budget drawn as a line, ms. Default 1000/60. */
  budgetMs?: number;
  /** Maximum visible frames before zooming in; the profiler's retained history remains the upper bound. Default 180. */
  maxFrames?: number;
  /** Share of the height given to the history band. Default 0.58. */
  bandRatio?: number;
  /** Lane row height, px. Default 11. */
  laneHeight?: number;
  /** Minimum column width, px. Default 2. */
  minColumnWidth?: number;
  /** Device-pixel cap for the backing store. Default 2. */
  maxDpr?: number;
  /** Override any category colour. */
  colors?: Partial<Record<TimelineCategory, string>>;
  /** Called whenever the selected frame changes (hover, pin, release or new data). */
  onSelect?: (frame: TimelineFrame | null) => void;
  /** Test hook: a fake 2D context (and an element without `getContext`). */
  createContext?: (canvas: HTMLCanvasElement) => TimelineSurface | null;
  doc?: Document;
  win?: TimelineWindow;
  now?: () => number;
}

export interface TimelineViewState {
  /** Number of source records currently available to the strip. */
  availableFrames: number;
  /** First and last engine frame numbers in the visible window, or null when empty. */
  windowStart: number | null;
  windowEnd: number | null;
  /** Visible frame count after zooming, capped by the available history. */
  windowFrames: number;
  /** True when the window has been moved away from the newest retained frame. */
  scrubbed: boolean;
  /** 1 means the configured window, larger values show a closer view. */
  zoom: number;
}

export interface TimelineState {
  /** Frames in the visible model (bounded by the current zoom window). */
  frames: number;
  /** Columns actually drawn (a narrow strip shows fewer than `frames`). */
  columns: number;
  /** Tallest frame in the window, ms. */
  peakMs: number;
  /** Position in `model.frames` of the selected frame, or null when there is no history. */
  selected: number | null;
  /** Engine frame number of the selected frame. */
  selectedFrame: number | null;
  /** Whether the selection is pinned (hover no longer moves it). */
  pinned: boolean;
  /** Engine frame number under the pointer, when there is one. */
  hoverFrame: number | null;
  /** Repaints so far. */
  painted: number;
  cssWidth: number;
  cssHeight: number;
  dpr: number;
  /** The selected frame as text — the readout under the strip. */
  readout: string;
  /** Current bounded scrub/zoom window. */
  view: TimelineViewState;
}

export interface ProfilerTimeline {
  readonly el: HTMLCanvasElement;
  /** Repaint when the strip is visible, has a size, and enough time has passed. */
  tick(nowMs?: number): void;
  /** Repaint now, whatever the throttle says (on open, resize or a selection change). */
  paint(): void;
  /** Set the CSS size (and the backing store) explicitly; the demo's tests drive this. */
  resize(width: number, height: number): void;
  /** Pin a frame by engine frame number, or release the pin with `null`. */
  pin(frameIndex: number | null): void;
  /** Move the right edge of the visible window to a retained frame and select it. */
  scrub(frameIndex: number): void;
  /** Zoom by a factor: values above one zoom in, below one zoom out. */
  zoom(factor: number): void;
  /** Return to the newest window at the configured maximum width. */
  resetView(): void;
  state(): TimelineState;
  dispose(): void;
}

const FONT = "9px ui-monospace,SFMono-Regular,Menlo,monospace";

/** Share of the strip given to the history band; the engine's own default is a little smaller. */
const DEFAULT_BAND_RATIO = 0.58;

/** Truncate a lane label to the room its rectangle has. */
function fitText(ctx: TimelineSurface, text: string, room: number): string {
  if (room <= 6 || ctx.measureText(text).width <= room) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (ctx.measureText(`${text.slice(0, mid)}…`).width <= room) lo = mid;
    else hi = mid - 1;
  }
  return lo > 0 ? `${text.slice(0, lo)}…` : "";
}

/**
 * Paint one model into one surface. Exported so a test can assert on the rectangles a given history
 * produces without needing a canvas at all.
 */
export function drawTimeline(
  ctx: TimelineSurface,
  model: TimelineModel,
  options: {
    width: number;
    height: number;
    colors?: Partial<Record<TimelineCategory, string>>;
    bandRatio?: number;
    laneHeight?: number;
    minColumnWidth?: number;
    selected?: number | null;
    budgetMs?: number;
  },
): TimelineLayout {
  const layout = layoutTimeline(model, {
    width: options.width,
    height: options.height,
    bandRatio: options.bandRatio,
    laneHeight: options.laneHeight,
    minColumnWidth: options.minColumnWidth,
    selected: options.selected,
  });
  const colors = { ...TIMELINE_COLORS, ...options.colors };
  const { band, columns, lanes } = layout;
  const w = options.width;
  const h = options.height;

  ctx.font = FONT;
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = BACKDROP;
  ctx.fillRect(0, 0, w, h);

  // The budget line spans the band alone: the lane chart below it is a different time axis.
  if (band.h > 0) {
    ctx.fillStyle = BUDGET;
    ctx.fillRect(0, Math.round(layout.budgetY), band.w, 1);
    ctx.fillStyle = LABEL_DIM;
    if (w > 92) {
      const label = `${model.budgetMs.toFixed(1)}ms`;
      ctx.fillText(label, 2, Math.max(8, Math.round(layout.budgetY) - 2));
    }
    if (w > 150 && model.frames.length > 0) {
      // "peak 0.00ms" on an empty strip reads as a measurement rather than as the absence of one.
      const peak = `peak ${model.peakMs.toFixed(1)}ms`;
      ctx.fillText(peak, w - ctx.measureText(peak).width - 2, Math.max(8, Math.round(layout.budgetY) - 2));
    }
  }

  for (const column of columns) {
    for (const segment of column.segments) {
      if (segment.h <= 0) continue;
      ctx.fillStyle = colors[segment.category];
      ctx.fillRect(column.x, band.y + segment.y, column.w, Math.max(1, segment.h));
    }
    if (column.gpuY !== null) {
      ctx.fillStyle = GPU;
      ctx.fillRect(column.x, band.y + Math.round(column.gpuY), column.w, 2);
    }
  }

  // The selected column is marked with a cursor on both edges, so it reads on a busy strip and on a
  // one-pixel-wide one.
  if (layout.selected !== null && columns.length > 0) {
    const position = columns.length - (model.frames.length - layout.selected);
    const column = columns[position - 1];
    if (column) {
      ctx.fillStyle = CURSOR;
      ctx.fillRect(column.x - 1, band.y, 1, band.h);
      ctx.fillRect(column.x + column.w, band.y, 1, band.h);
    }
  }

  if (lanes) {
    ctx.fillStyle = GRID;
    ctx.fillRect(0, lanes.y - 3, w, 1);
    for (const item of lanes.slices) {
      ctx.fillStyle = colors[item.slice.category];
      ctx.fillRect(item.x, lanes.y + item.y, item.w, item.h);
      const label = fitText(ctx, item.slice.label, item.w - 5);
      if (label) {
        ctx.fillStyle = LABEL;
        ctx.fillText(label, item.x + 3, lanes.y + item.y + item.h - 1);
      }
    }
  }

  return layout;
}

export function mountProfilerTimeline(options: ProfilerTimelineOptions): ProfilerTimeline {
  const doc = options.doc ?? document;
  const el = options.canvas ?? (doc.createElement("canvas") as HTMLCanvasElement);
  const ctx = options.createContext
    ? options.createContext(el)
    : ((el as { getContext?: (id: string) => unknown }).getContext?.("2d") as TimelineSurface | null | undefined) ?? null;
  const now = options.now ?? (() => (typeof performance === "undefined" ? Date.now() : performance.now()));
  const dprCap = Math.max(1, options.maxDpr ?? 2);
  const bandRatio = options.bandRatio ?? DEFAULT_BAND_RATIO;
  // The panel body is pointer-transparent so camera drags reach the canvas behind it; the strip is
  // interactive, so it takes its own pointer input back. `pan-y` keeps a vertical scroll gesture on
  // the strip working (a cancelled pointer clears the hover instead of selecting).
  el.style.pointerEvents = "auto";
  el.style.touchAction = "pan-y";

  let cssWidth = Math.max(0, options.width ?? 0);
  let cssHeight = Math.max(0, options.height ?? 0);
  let dpr = 1;
  let painted = 0;
  let lastPaint = -Infinity;
  const configuredFrames = Math.max(1, Math.floor(options.maxFrames ?? 180));
  /** Pinned / hovered frames are held by engine frame number: positions shift as the ring turns. */
  let pinnedFrame: number | null = null;
  let hoverFrame: number | null = null;
  let lastSelection: number | null = null;
  /** The right edge is an engine frame id, not an array position, so a profiler ring can advance. */
  let viewEndFrame: number | null = null;
  let windowFrames = configuredFrames;
  let dragging = false;
  let dragStartX = 0;
  let dragStartEndFrame: number | null = null;
  let disposed = false;
  el.tabIndex = 0;
  el.setAttribute("aria-label", "Profiler frame timeline. Use the mouse wheel to zoom and Shift-wheel or drag to scrub.");

  const measure = (): { w: number; h: number } => {
    if (cssWidth > 0 && cssHeight > 0) return { w: cssWidth, h: cssHeight };
    const element = el as unknown as { clientWidth?: number; clientHeight?: number };
    return { w: cssWidth || element.clientWidth || 0, h: cssHeight || element.clientHeight || 0 };
  };

  const syncBackingStore = (w: number, h: number): void => {
    const ratio = Math.min(dprCap, Math.max(1, options.win?.devicePixelRatio ?? 1));
    const canvas = el as unknown as { width: number; height: number };
    const bw = Math.max(0, Math.round(w * ratio));
    const bh = Math.max(0, Math.round(h * ratio));
    if (canvas.width !== bw) canvas.width = bw;
    if (canvas.height !== bh) canvas.height = bh;
    dpr = ratio;
  };

  const resolve = (model: TimelineModel, frameNumber: number | null): number | null => {
    if (frameNumber === null) return null;
    for (let i = model.frames.length - 1; i >= 0; i--) {
      if (model.frames[i]!.index === frameNumber) return i;
    }
    return null;
  };

  let readout = "";
  let latest: {
    model: TimelineModel;
    layout: TimelineLayout;
    selected: number | null;
    frame: TimelineFrame | null;
    available: number;
    start: number;
    end: number;
  } = {
    model: frameTimeline([], { maxFrames: configuredFrames, budgetMs: options.budgetMs }),
    layout: layoutTimeline(frameTimeline([], { maxFrames: configuredFrames, budgetMs: options.budgetMs }), { width: 0, height: 0 }),
    selected: null,
    frame: null,
    available: 0,
    start: 0,
    end: 0,
  };

  const recordsWindow = (records: readonly FrameRecord[]): { records: readonly FrameRecord[]; start: number; end: number } => {
    if (records.length === 0) return { records, start: 0, end: 0 };
    let end = records.length;
    if (viewEndFrame !== null) {
      const edge = records.findIndex((record) => record.index === viewEndFrame);
      if (edge >= 0) end = edge + 1;
      else viewEndFrame = null;
    }
    const start = Math.max(0, end - Math.min(windowFrames, records.length));
    // A scrubbed window cannot end before its first record. Keep the identity at the right edge so
    // newly appended records do not silently snap the user's old spike back to the live tail.
    const visible = records.slice(start, end);
    return { records: visible, start, end };
  };

  const sourceIndex = (records: readonly FrameRecord[], frame: number | null): number => {
    if (frame === null) return -1;
    return records.findIndex((record) => record.index === frame);
  };

  const viewState = (): TimelineViewState => ({
    availableFrames: latest.available,
    windowStart: latest.model.frames[0]?.index ?? null,
    windowEnd: latest.model.frames.at(-1)?.index ?? null,
    windowFrames: latest.model.frames.length,
    scrubbed: latest.end < latest.available,
    zoom: latest.model.frames.length > 0 ? Math.max(1, Math.min(configuredFrames, latest.available) / latest.model.frames.length) : 1,
  });

  const paint = (): void => {
    if (disposed || !ctx) return;
    const box = measure();
    syncBackingStore(box.w, box.h);
    if (box.w <= 0 || box.h <= 0) return;
    const records = options.frames() ?? [];
    const window = recordsWindow(records);
    const model = frameTimeline(window.records, {
      maxFrames: configuredFrames,
      budgetMs: options.budgetMs,
    });
    // A pinned frame that has scrolled out of the visible window cannot be kept; drop the pin rather
    // than silently showing a different frame than the one the user picked.
    if (pinnedFrame !== null && resolve(model, pinnedFrame) === null) pinnedFrame = null;
    if (hoverFrame !== null && resolve(model, hoverFrame) === null) hoverFrame = null;
    const hovered = resolve(model, hoverFrame);
    const selected = resolve(model, pinnedFrame) ?? hovered ?? (model.frames.length > 0 ? model.frames.length - 1 : null);
    // Draw in CSS pixels: the backing store is device-pixel sized, the geometry is not.
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const layout = drawTimeline(ctx, model, {
      width: box.w,
      height: box.h,
      colors: options.colors,
      bandRatio: bandRatio,
      laneHeight: options.laneHeight,
      minColumnWidth: options.minColumnWidth,
      selected,
    });
    painted++;
    lastPaint = now();
    const frame = selected === null ? null : model.frames[selected] ?? null;
    const selectedFrame = frame?.index ?? null;
    if (selectedFrame !== lastSelection) {
      lastSelection = selectedFrame;
      options.onSelect?.(frame);
    }
    const view = `view ${model.frames[0]?.index ?? "—"}–${model.frames.at(-1)?.index ?? "—"} / ${records.length}  ·  wheel zoom · shift-wheel or drag scrub`;
    readout = frame ? `${formatTimelineFrame(frame, model.budgetMs)}\n  ${view}` : records.length > 0 ? view : "";
    latest = { model, layout, selected, frame, available: records.length, start: window.start, end: window.end };
  };

  const hover = (frameNumber: number | null): void => {
    if (frameNumber === hoverFrame) return;
    hoverFrame = frameNumber;
    paint();
  };

  const pointerAt = (event: { clientX: number; clientY: number }): { x: number; y: number } => {
    const box = (el as unknown as { getBoundingClientRect?: () => { left: number; top: number } }).getBoundingClientRect?.() ?? { left: 0, top: 0 };
    return { x: event.clientX - box.left, y: event.clientY - box.top };
  };

  const hit = (event: { clientX: number; clientY: number }): number | null => {
    const box = measure();
    if (box.w <= 0 || box.h <= 0) return null;
    const { x, y } = pointerAt(event);
    // Hit-test the layout the strip last drew: the pointer must select what the user can see, and
    // that is only ever one frame behind at 10 Hz.
    const layout = latest.layout.width === box.w && latest.layout.height === box.h ? latest.layout : layoutTimeline(latest.model, {
      width: box.w,
      height: box.h,
      bandRatio: bandRatio,
      laneHeight: options.laneHeight,
      minColumnWidth: options.minColumnWidth,
      selected: latest.selected ?? null,
    });
    const found = hitTestTimeline(latest.model, layout, x, y);
    if (!found) return null;
    const frame = latest.model.frames[found.column];
    return frame ? frame.index : null;
  };

  const recordsNow = (): readonly FrameRecord[] => options.frames() ?? [];

  const moveWindowBy = (delta: number): void => {
    const records = recordsNow();
    if (records.length === 0 || !Number.isFinite(delta)) return;
    const currentEnd = viewEndFrame === null ? records.length : Math.max(1, sourceIndex(records, viewEndFrame) + 1);
    const nextEnd = Math.max(1, Math.min(records.length, currentEnd + Math.round(delta)));
    if (nextEnd === currentEnd) return;
    viewEndFrame = records[nextEnd - 1]!.index;
    hoverFrame = null;
    paint();
  };

  const scrub = (frameIndex: number): void => {
    const records = recordsNow();
    const index = sourceIndex(records, frameIndex);
    if (index < 0) return;
    viewEndFrame = records[index]!.index;
    pinnedFrame = records[index]!.index;
    hoverFrame = null;
    paint();
  };

  const zoom = (factor: number): void => {
    if (!Number.isFinite(factor) || factor <= 0) return;
    const records = recordsNow();
    if (records.length === 0) return;
    const currentEnd = viewEndFrame === null ? records.length : Math.max(1, sourceIndex(records, viewEndFrame) + 1);
    const currentStart = Math.max(0, currentEnd - Math.min(windowFrames, records.length));
    const target = Math.max(1, Math.min(records.length, Math.round(windowFrames / factor)));
    if (target === windowFrames && currentStart === 0 && currentEnd === records.length) return;
    const center = Math.min(records.length - 1, currentStart + Math.floor(Math.max(0, currentEnd - currentStart - 1) / 2));
    let start = Math.max(0, center - Math.floor(target / 2));
    let end = Math.min(records.length, start + target);
    start = Math.max(0, end - target);
    windowFrames = target;
    viewEndFrame = end === records.length && start === 0 ? null : records[end - 1]!.index;
    hoverFrame = null;
    paint();
  };

  const resetView = (): void => {
    viewEndFrame = null;
    windowFrames = configuredFrames;
    pinnedFrame = null;
    hoverFrame = null;
    paint();
  };

  const onMove = (event: unknown): void => {
    const input = event as { clientX: number; clientY: number; buttons?: number };
    if (dragStartEndFrame !== null && (input.buttons ?? 0) & 1) {
      const deltaX = input.clientX - dragStartX;
      if (!dragging && Math.abs(deltaX) >= 4) dragging = true;
      if (dragging) {
        const columns = Math.max(1, latest.layout.columns.length);
        const records = recordsNow();
        const base = sourceIndex(records, dragStartEndFrame);
        if (base >= 0) {
          const offset = Math.round(-deltaX / Math.max(1, measure().w / columns));
          const nextEnd = Math.max(1, Math.min(records.length, base + 1 + offset));
          viewEndFrame = records[nextEnd - 1]!.index;
          pinnedFrame = null;
          hoverFrame = null;
          paint();
        }
        return;
      }
    }
    if (pinnedFrame !== null) return; // pinned: the strip is frozen where the user put it
    hover(hit(input));
  };
  const onDown = (event: unknown): void => {
    const input = event as { clientX: number; clientY: number };
    const frameNumber = hit(input);
    if (frameNumber === null) return;
    dragStartX = input.clientX;
    dragStartEndFrame = viewEndFrame ?? latest.model.frames.at(-1)?.index ?? null;
    dragging = false;
    // Tap the pinned frame to release it; tap any other to pin that one. A real drag clears this pin
    // once movement passes the threshold and scrubs the retained window instead.
    pinnedFrame = pinnedFrame === frameNumber ? null : frameNumber;
    el.focus?.();
    paint();
  };
  const onUp = (): void => {
    dragStartEndFrame = null;
    dragging = false;
  };
  const onWheel = (event: unknown): void => {
    const input = event as { deltaY?: number; deltaX?: number; shiftKey?: boolean; ctrlKey?: boolean; metaKey?: boolean; preventDefault?: () => void };
    const dy = Number.isFinite(input.deltaY) ? input.deltaY! : 0;
    const dx = Number.isFinite(input.deltaX) ? input.deltaX! : 0;
    if ((input.shiftKey || Math.abs(dx) > Math.abs(dy)) && (dx !== 0 || dy !== 0)) {
      const direction = Math.abs(dx) > Math.abs(dy) ? dx : dy;
      moveWindowBy(direction > 0 ? -Math.max(1, Math.round(windowFrames / 8)) : Math.max(1, Math.round(windowFrames / 8)));
    } else if (dy !== 0 || input.ctrlKey || input.metaKey) {
      zoom(dy > 0 ? 0.8 : 1.25);
    }
    input.preventDefault?.();
  };
  const onKeyDown = (event: unknown): void => {
    const input = event as { key?: string; preventDefault?: () => void };
    switch (input.key) {
      case "ArrowLeft": moveWindowBy(-(input.key === "ArrowLeft" ? 1 : 0)); input.preventDefault?.(); break;
      case "ArrowRight": moveWindowBy(1); input.preventDefault?.(); break;
      case "PageUp": moveWindowBy(-Math.max(1, Math.round(windowFrames / 2))); input.preventDefault?.(); break;
      case "PageDown": moveWindowBy(Math.max(1, Math.round(windowFrames / 2))); input.preventDefault?.(); break;
      case "+": case "=": zoom(1.5); input.preventDefault?.(); break;
      case "-": case "_": zoom(0.67); input.preventDefault?.(); break;
      case "Home": resetView(); moveWindowBy(-recordsNow().length); input.preventDefault?.(); break;
      case "End": resetView(); input.preventDefault?.(); break;
      default: break;
    }
  };
  const onLeave = (): void => {
    if (!dragging) hover(null);
  };
  const onCancel = (): void => {
    onUp();
    hover(null);
  };

  el.addEventListener("pointermove", onMove);
  el.addEventListener("pointerdown", onDown);
  el.addEventListener("pointerup", onUp);
  el.addEventListener("pointerleave", onLeave);
  el.addEventListener("pointercancel", onCancel);
  el.addEventListener("wheel", onWheel);
  el.addEventListener("keydown", onKeyDown);

  return {
    el,
    tick(nowMs?: number) {
      const t = nowMs ?? now();
      if (t - lastPaint < 100) return;
      paint();
    },
    paint,
    resize(width: number, height: number) {
      cssWidth = Math.max(0, width);
      cssHeight = Math.max(0, height);
      paint();
    },
    pin(frameIndex: number | null) {
      pinnedFrame = frameIndex;
      paint();
    },
    scrub,
    zoom,
    resetView,
    state(): TimelineState {
      const box = measure();
      return {
        frames: latest.model.frames.length,
        columns: latest.layout.columns.length,
        peakMs: latest.model.peakMs,
        selected: latest.selected,
        selectedFrame: latest.frame?.index ?? null,
        pinned: pinnedFrame !== null,
        hoverFrame,
        painted,
        cssWidth: box.w,
        cssHeight: box.h,
        dpr,
        readout,
        view: viewState(),
      };
    },
    dispose() {
      disposed = true;
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointerleave", onLeave);
      el.removeEventListener("pointercancel", onCancel);
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("keydown", onKeyDown);
    },
  };
}
