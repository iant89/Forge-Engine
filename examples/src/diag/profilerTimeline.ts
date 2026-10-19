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
  /** Newest frames kept. Default 180. */
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

export interface TimelineState {
  /** Frames in the model (bounded by `maxFrames`). */
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
  /** Pinned / hovered frames are held by engine frame number: positions shift as the ring turns. */
  let pinnedFrame: number | null = null;
  let hoverFrame: number | null = null;
  let lastSelection: number | null = null;
  let disposed = false;

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
  let latest: { model: TimelineModel; layout: TimelineLayout; selected: number | null; frame: TimelineFrame | null } = {
    model: frameTimeline([], { maxFrames: options.maxFrames, budgetMs: options.budgetMs }),
    layout: layoutTimeline(frameTimeline([], { maxFrames: options.maxFrames, budgetMs: options.budgetMs }), { width: 0, height: 0 }),
    selected: null,
    frame: null,
  };

  const paint = (): void => {
    if (disposed || !ctx) return;
    const box = measure();
    syncBackingStore(box.w, box.h);
    if (box.w <= 0 || box.h <= 0) return;
    const records = options.frames() ?? [];
    const model = frameTimeline(records, {
      maxFrames: options.maxFrames,
      budgetMs: options.budgetMs,
    });
    // A pinned frame that has scrolled out of the window cannot be kept; drop the pin rather than
    // silently showing a different frame than the one the user picked.
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
    if (selected !== lastSelection) {
      lastSelection = selected;
      options.onSelect?.(frame);
    }
    readout = frame ? formatTimelineFrame(frame, model.budgetMs) : "";
    latest = { model, layout, selected, frame };
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

  const onMove = (event: unknown): void => {
    if (pinnedFrame !== null) return; // pinned: the strip is frozen until released
    hover(hit(event as { clientX: number; clientY: number }));
  };
  const onDown = (event: unknown): void => {
    const frameNumber = hit(event as { clientX: number; clientY: number });
    if (frameNumber === null) return;
    // Tap the pinned frame to release it; tap any other to pin that one.
    pinnedFrame = pinnedFrame === frameNumber ? null : frameNumber;
    paint();
  };
  const onLeave = (): void => hover(null);

  el.addEventListener("pointermove", onMove);
  el.addEventListener("pointerdown", onDown);
  el.addEventListener("pointerleave", onLeave);
  el.addEventListener("pointercancel", onLeave);

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
      };
    },
    dispose() {
      disposed = true;
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointerleave", onLeave);
      el.removeEventListener("pointercancel", onLeave);
    },
  };
}
