/**
 * Frame timeline (Phase 21.1): the profiler's frame history as drawable rectangles.
 *
 * `Profiler.frameHistory()` keeps a bounded ring of {@link FrameRecord}s, each carrying the frame's
 * scope slices. This module turns that history into geometry — nothing here touches the DOM, a
 * canvas, or a clock, so a host can paint it with whatever it draws with (the demo paints it into a
 * 2D canvas inside the floating Profiler panel) and a test can assert on the rectangles directly.
 *
 * Shapes that matter here:
 *  - **Self time, not duration.** Slices nest: `Frame` wraps the whole scene update, and every
 *    scene-object and system scope sits inside it. Summing durations would count a system's time
 *    once for the system and again for every enclosing scope. Each slice is therefore charged only
 *    its *self* time — `durationMs` minus its direct children — so every millisecond is counted
 *    exactly once and a container's own overhead shows up as overhead, not as work.
 *  - **Categories are inherited, not guessed twice.** A scope names its category with the
 *    `<category>:<name>` prefix {@link profileLabel} produces. A nested scope with no prefix of its
 *    own inherits its nearest ancestor's category, so `upload` inside `terrain:TerrainSystem` is
 *    terrain work and not, as the name-only guess would have it, simulation. Only a *leaf* with no
 *    categorised ancestor falls back to {@link classifyProfileName}; a container with no category
 *    (`Frame`) is `other`, because its self time really is unattributed overhead.
 *  - **The column height is the frame's CPU time**, and the segments partition it. Whatever the
 *    scopes do not account for is `other`, drawn on top, so a gap between scopes stays visible as a
 *    gap instead of quietly shrinking the column.
 *  - **Everything is bounded.** At most `maxFrames` columns, at most `maxLanes` nesting levels in
 *    the lane chart, and the scale is a ceiling the caller already knows.
 *  - **`gpuMs` is a marker, not a segment.** GPU time overlaps the CPU frame that submitted it (and
 *    is read back frames later), so stacking it would double-count wall-clock that never happened
 *    twice. It is drawn as a tick across the column instead.
 */

import { classifyProfileName, PROFILE_CATEGORIES, type ProfileCategory } from "./frameBreakdown.js";
import type { FrameRecord } from "./profiler.js";

/** The eight roadmap categories plus `other` — frame time inside no categorised scope. */
export type TimelineCategory = ProfileCategory | "other";

/** Draw order, bottom of a column first: the roadmap categories in order, then the remainder. */
export const TIMELINE_CATEGORIES: readonly TimelineCategory[] = [...PROFILE_CATEGORIES, "other"];

export interface TimelineSlice {
  /** Scope name exactly as the profiler recorded it (category prefix included, when it has one). */
  readonly name: string;
  /** The name without its category prefix — what a host should show in a label. */
  readonly label: string;
  readonly category: TimelineCategory;
  readonly startMs: number;
  readonly durationMs: number;
  /** `durationMs` minus the durations of the slices nested directly inside it. */
  readonly selfMs: number;
  /** Nesting level: 0 is a scope opened straight off the frame. */
  readonly depth: number;
}

export interface TimelineFrame {
  readonly index: number;
  /** Frame CPU time as the engine measured it (beginFrame → endFrame), ms. */
  readonly cpuMs: number;
  /** GPU time attributed to this frame, ms; 0 when the adapter reports none. */
  readonly gpuMs: number;
  /** Self time per category, ms. Adds up to at most `cpuMs`. */
  readonly categories: Readonly<Record<TimelineCategory, number>>;
  /** `cpuMs` minus everything the scopes accounted for: gaps and unattributed overhead, ms. */
  readonly otherMs: number;
  /** Every slice of the frame, with its depth. Emission order (the profiler's end order). */
  readonly slices: readonly TimelineSlice[];
  /** How many nesting levels the frame used (depth + 1 of the deepest slice). */
  readonly lanes: number;
  /** End of the last slice, ms — the lane chart's natural time axis. */
  readonly spanMs: number;
}

export interface FrameTimelineOptions {
  /** How many of the newest frames to keep. Default 180 (three seconds at 60 Hz). */
  maxFrames?: number;
  /** Frame budget drawn as a line, ms. Default 16.67 (60 Hz). */
  budgetMs?: number;
  /** Deepest nesting level kept for the lane chart. Default 6. */
  maxLanes?: number;
}

export interface TimelineModel {
  /** The newest `maxFrames` frames, oldest first. Empty when the profiler has no history. */
  readonly frames: readonly TimelineFrame[];
  readonly budgetMs: number;
  /** Tallest frame's CPU time in the window, ms. 0 with no frames. */
  readonly peakMs: number;
  /**
   * Band ceiling, ms: the larger of `peakMs` and 1.25 × `budgetMs`. Nothing is clipped — a spike
   * compresses the ordinary frames instead of being cut off, because the spike is the thing you
   * opened the panel to find.
   */
  readonly scaleMs: number;
  readonly maxFrames: number;
}

export const DEFAULT_TIMELINE_FRAMES = 180;
export const DEFAULT_TIMELINE_BUDGET_MS = 1000 / 60;
export const DEFAULT_TIMELINE_LANES = 6;

const isCategory = (value: string): value is ProfileCategory => (PROFILE_CATEGORIES as readonly string[]).includes(value);

/** Split `terrain:TerrainSystem` into `[terrain, TerrainSystem]`; a bare name has no category. */
function splitLabel(name: string): { category: ProfileCategory | null; label: string } {
  const sep = name.indexOf(":");
  if (sep <= 0) return { category: null, label: name };
  const head = name.slice(0, sep);
  return { category: isCategory(head) ? head : null, label: name.slice(sep + 1) };
}

/** The slice while it is being built: categories and self time are resolved in a second pass. */
interface Slice {
  name: string;
  label: string;
  category: TimelineCategory;
  startMs: number;
  durationMs: number;
  selfMs: number;
  depth: number;
  hasChildren: boolean;
}

/**
 * Assign depths, and flag which slices are containers.
 *
 * The profiler appends slices in *end* order, so a child always appears before its parent. Sorting
 * by `startMs` (longest first on a tie, so an enclosing scope opens the lane) turns that into a
 * pre-order walk, and a stack of open scopes gives each slice its nesting level in one pass. In a
 * pre-order walk a slice has children exactly when the next slice is deeper than it is.
 */
function nestSlices(raw: readonly { name: string; startMs: number; durationMs: number }[], maxLanes: number): Slice[] {
  const order = raw
    .map((s, i) => ({ ...s, i }))
    .sort((a, b) => a.startMs - b.startMs || b.durationMs - a.durationMs || a.i - b.i);
  const out: Slice[] = new Array<Slice>(order.length);
  const stack: { end: number }[] = [];
  for (let n = 0; n < order.length; n++) {
    const s = order[n]!;
    while (stack.length > 0 && stack[stack.length - 1]!.end <= s.startMs) stack.pop();
    const depth = Math.min(stack.length, maxLanes - 1);
    const { category, label } = splitLabel(s.name);
    out[s.i] = {
      name: s.name,
      label,
      category: category ?? "other",
      startMs: s.startMs,
      durationMs: s.durationMs,
      selfMs: s.durationMs,
      depth,
      hasChildren: false,
    };
    stack.push({ end: s.startMs + s.durationMs });
    // The previous slice in this walk is this one's parent when it is one level shallower; a deeper
    // previous slice is a sibling of an already-closed subtree, so the check is on the next one.
    const prev = order[n - 1];
    if (prev) {
      const prevSlice = out[prev.i]!;
      if (depth > prevSlice.depth) prevSlice.hasChildren = true;
    }
  }
  return out;
}

/**
 * Resolve categories and subtract children from each parent's self time.
 *
 * Both need the parent chain, which is rebuilt here from the pre-order walk: the open ancestor of
 * depth `d` is the most recent slice seen at depth `d - 1`. Category precedence is own prefix, then
 * the nearest categorised ancestor, then the name-only guess for a leaf, then `other`.
 */
function attribute(slices: Slice[]): void {
  const chain: Slice[] = [];
  const order = [...slices].sort((a, b) => a.startMs - b.startMs || b.durationMs - a.durationMs);
  for (const slice of order) {
    chain.length = slice.depth;
    const parent = slice.depth > 0 ? chain[slice.depth - 1] : undefined;
    chain[slice.depth] = slice;
    const own = splitLabel(slice.name).category;
    if (own) slice.category = own;
    else if (parent && parent.category !== "other") slice.category = parent.category;
    else if (!slice.hasChildren) slice.category = classifyProfileName(slice.name);
    else slice.category = "other";
    if (parent) parent.selfMs -= slice.durationMs;
  }
}

/**
 * Fold the profiler's frame history into the timeline model.
 *
 * A record with no slices still produces a column — all of it `other` — because the per-frame
 * slices are only collected when the adapter exposes GPU timestamps, and a frame-time graph with no
 * category colours is still worth more than no graph.
 */
export function frameTimeline(records: readonly FrameRecord[], options: FrameTimelineOptions = {}): TimelineModel {
  const maxFrames = Math.max(1, Math.floor(options.maxFrames ?? DEFAULT_TIMELINE_FRAMES));
  const budgetMs = Math.max(0.001, options.budgetMs ?? DEFAULT_TIMELINE_BUDGET_MS);
  const maxLanes = Math.max(1, Math.floor(options.maxLanes ?? DEFAULT_TIMELINE_LANES));
  const window = records.length > maxFrames ? records.slice(records.length - maxFrames) : records;

  const frames: TimelineFrame[] = [];
  let peakMs = 0;
  for (const record of window) {
    const slices = nestSlices(record.slices ?? [], maxLanes);
    attribute(slices);
    const categories = Object.fromEntries(TIMELINE_CATEGORIES.map((c) => [c, 0])) as Record<TimelineCategory, number>;
    let accounted = 0;
    let lanes = 0;
    let spanMs = 0;
    for (const slice of slices) {
      const ms = Math.max(0, slice.selfMs);
      categories[slice.category] += ms;
      accounted += ms;
      lanes = Math.max(lanes, slice.depth + 1);
      spanMs = Math.max(spanMs, slice.startMs + slice.durationMs);
    }
    const cpuMs = Math.max(0, record.cpuMs || record.totalMs || 0);
    // A scope opened in an earlier frame can end inside this one, which makes `accounted` overshoot;
    // the remainder is floored at zero rather than going negative and eating another category.
    const otherMs = Math.max(0, cpuMs - accounted);
    categories.other += otherMs;
    peakMs = Math.max(peakMs, cpuMs);
    frames.push({
      index: record.index,
      cpuMs,
      gpuMs: Math.max(0, record.gpuMs || 0),
      categories,
      otherMs,
      slices: slices as readonly TimelineSlice[],
      lanes,
      spanMs,
    });
  }

  return { frames, budgetMs, peakMs, scaleMs: Math.max(peakMs, budgetMs * 1.25), maxFrames };
}

export interface TimelineSegment {
  readonly category: TimelineCategory;
  /** Offset from the band's top, px. Segments stack upwards from the bottom of the band. */
  readonly y: number;
  readonly h: number;
  readonly ms: number;
}

export interface TimelineColumn {
  readonly index: number;
  readonly x: number;
  readonly w: number;
  readonly totalMs: number;
  /** Stacked bottom-up: the roadmap categories in order, then the remainder. */
  readonly segments: readonly TimelineSegment[];
  /** Offset from the band's top of the GPU marker, px, or null when the frame reported none. */
  readonly gpuY: number | null;
  /** True when this frame's stack overflowed the band and was compressed to fit it. */
  readonly clipped: boolean;
}

export interface TimelineLaneSlice {
  readonly slice: TimelineSlice;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export interface TimelineLanes {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly laneHeight: number;
  /** ms per px along the lane chart's own time axis. */
  readonly scaleMs: number;
  readonly slices: readonly TimelineLaneSlice[];
}

export interface TimelineLayoutOptions {
  /** CSS pixels. */
  width: number;
  height: number;
  /**
   * Share of the height given to the history band; the rest (below a small gutter) is the lane chart
   * of the selected frame. Default 0.55. `1` means "band only".
   */
  bandRatio?: number;
  /** Gap between the band and the lane chart, px. Default 6. */
  gutter?: number;
  /** Lane row height, px. Default 11. */
  laneHeight?: number;
  /** Narrowest column, px; a strip too narrow for `maxFrames` columns simply shows fewer. Default 2. */
  minColumnWidth?: number;
  /** The frame the lane chart shows: an index into `model.frames`, or null (default) for the newest. */
  selected?: number | null;
}

export interface TimelineLayout {
  readonly width: number;
  readonly height: number;
  readonly band: { readonly x: number; readonly y: number; readonly w: number; readonly h: number };
  /** ms per px in the band. */
  readonly scaleMs: number;
  /** Offset from the band's top of the budget line, px. */
  readonly budgetY: number;
  readonly columns: readonly TimelineColumn[];
  readonly lanes: TimelineLanes | null;
  /** Index into `model.frames` the lane chart is showing, or null when there is nothing to show. */
  readonly selected: number | null;
}

/**
 * Lay the model out into rectangles. Pure: the same model in the same box always gives the same
 * rectangles, which is what lets the strip be pinned by a unit test instead of by a screenshot.
 */
export function layoutTimeline(model: TimelineModel, options: TimelineLayoutOptions): TimelineLayout {
  const width = Math.max(0, options.width);
  const height = Math.max(0, options.height);
  const bandRatio = clamp01(options.bandRatio ?? 0.55);
  const gutter = Math.max(0, options.gutter ?? 6);
  const laneHeight = Math.max(4, options.laneHeight ?? 11);
  const minColumnWidth = Math.max(1, options.minColumnWidth ?? 2);

  const frames = model.frames;
  const showLanes = bandRatio < 1 && height > 0 && frames.length > 0;
  const gutterPx = showLanes ? gutter : 0;
  const bandH = showLanes ? Math.max(0, Math.round(height * bandRatio)) : Math.max(0, height);
  const band = { x: 0, y: 0, w: width, h: bandH };

  const scaleMs = model.scaleMs;
  const columns: TimelineColumn[] = [];
  if (bandH > 0 && width > 0 && frames.length > 0) {
    const count = Math.max(1, Math.min(frames.length, Math.floor(width / minColumnWidth)));
    const shown = frames.slice(frames.length - count);
    const slot = width / count;
    // A column one device pixel narrower than its slot reads as a bar chart rather than a timeline;
    // that gap is what keeps 180 columns legible on a phone.
    const w = Math.max(1, slot - 1);
    for (let i = 0; i < shown.length; i++) {
      const frame = shown[i]!;
      const raw: { category: TimelineCategory; h: number; ms: number }[] = [];
      let stackH = 0;
      for (const category of TIMELINE_CATEGORIES) {
        const ms = frame.categories[category];
        if (ms <= 0) continue;
        const h = (ms / scaleMs) * bandH;
        stackH += h;
        raw.push({ category, h, ms });
      }
      // Frames are not guaranteed to fill the band (a very fast frame next to a spike), and a scope
      // straddling the frame boundary can overflow it; one factor fixes both without clipping.
      const fit = stackH > bandH && stackH > 0 ? bandH / stackH : 1;
      const segments: { category: TimelineCategory; y: number; h: number; ms: number }[] = [];
      let y = bandH;
      // Stack from the bottom in draw order, so the categorised work is grounded on the baseline
      // (column heights stay comparable across frames) and the unattributed remainder sits on top.
      for (const seg of raw) {
        const h = seg.h * fit;
        y -= h;
        segments.push({ category: seg.category, y, h: h, ms: seg.ms });
      }
      const gpuY = frame.gpuMs > 0 ? bandH - Math.min(bandH, (frame.gpuMs / scaleMs) * bandH) : null;
      columns.push({ index: frame.index, x: Math.round(i * slot), w, totalMs: frame.cpuMs, segments, gpuY, clipped: fit < 1 });
    }
  }

  let lanes: TimelineLanes | null = null;
  let selected: number | null = null;
  if (showLanes && frames.length > 0) {
    const wanted = options.selected === null || options.selected === undefined ? frames.length - 1 : Math.floor(options.selected);
    const index = Math.max(0, Math.min(frames.length - 1, wanted));
    const frame = frames[index]!;
    selected = index;
    const y = bandH + gutterPx;
    const h = Math.max(0, height - y);
    const axisMs = Math.max(frame.spanMs, frame.cpuMs, 0.001);
    const laneSlices: TimelineLaneSlice[] = [];
    if (h > 0 && width > 0) {
      for (const slice of frame.slices) {
        const row = slice.depth;
        if (row * laneHeight >= h) continue; // deeper than the panel can show
        laneSlices.push({
          slice,
          x: (slice.startMs / axisMs) * width,
          y: row * laneHeight,
          w: Math.max(1, (slice.durationMs / axisMs) * width),
          h: Math.max(1, Math.min(laneHeight - 1, h - row * laneHeight)),
        });
      }
    }
    lanes = { x: 0, y, w: width, h, laneHeight, scaleMs: axisMs / Math.max(1, width), slices: laneSlices };
  }

  return {
    width,
    height,
    band,
    scaleMs,
    budgetY: bandH - Math.min(bandH, (model.budgetMs / scaleMs) * bandH),
    columns,
    lanes,
    selected,
  };
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export interface TimelineHit {
  /** Index into `model.frames` of the frame under the point. */
  readonly column: number;
  /** The slice under the point, when the point is inside the lane chart. */
  readonly slice?: TimelineSlice;
}

/**
 * What is under a point, in layout coordinates. The band hit-tests by column on `x` alone, so a
 * hover anywhere in the strip's height selects that frame; the lane chart hit-tests by rectangle.
 */
export function hitTestTimeline(model: TimelineModel, layout: TimelineLayout, x: number, y: number): TimelineHit | null {
  // A point outside the strip is nothing at all: clamping x into the nearest column would select a
  // frame the pointer is nowhere near (the first one, for every point left of the panel).
  if (x < 0 || x > layout.width || y < 0 || y > layout.height) return null;
  if (layout.columns.length > 0 && y >= layout.band.y && y <= layout.band.y + layout.band.h) {
    const slot = layout.width / layout.columns.length;
    const i = Math.max(0, Math.min(layout.columns.length - 1, Math.floor(x / slot)));
    return { column: model.frames.length - layout.columns.length + i };
  }
  const lanes = layout.lanes;
  if (lanes && y >= lanes.y && y <= lanes.y + lanes.h) {
    // Lane rectangles are positioned relative to the lane block, the point is not.
    const ly = y - lanes.y;
    for (const s of lanes.slices) {
      if (x >= s.x && x <= s.x + s.w && ly >= s.y && ly <= s.y + s.h) {
        return { column: layout.selected ?? model.frames.length - 1, slice: s.slice };
      }
    }
    if (layout.selected !== null) return { column: layout.selected };
  }
  return null;
}

/** One frame as text: for the panel's readout, the console, and copy/paste. */
export function formatTimelineFrame(frame: TimelineFrame, budgetMs = DEFAULT_TIMELINE_BUDGET_MS): string {
  const head = [`#${frame.index}`, `cpu ${frame.cpuMs.toFixed(2)}ms`];
  if (frame.gpuMs > 0) head.push(`gpu ${frame.gpuMs.toFixed(2)}ms`);
  head.push(frame.cpuMs > budgetMs ? `over the ${budgetMs.toFixed(1)}ms budget` : `within the ${budgetMs.toFixed(1)}ms budget`);
  const rows: string[] = [];
  for (const category of TIMELINE_CATEGORIES) {
    const ms = frame.categories[category];
    if (ms > 0.0005) rows.push(`${category} ${ms.toFixed(2)}`);
  }
  const line = head.join("  ");
  return rows.length > 0 ? `${line}\n  ${rows.join("  ·  ")}` : line;
}
