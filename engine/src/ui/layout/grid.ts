/**
 * Grid layout — explicit and auto-flowed two-dimensional placement.
 *
 * Tracks: a number (fixed logical units), `"auto"` (sized to content), `"Nfr"` (a share of the
 * leftover space) or `{ min, max }` where `max` is a number, `"auto"` or `"Nfr"` (a `minmax()`).
 * `columns` may also be a count (`n × 1fr`) or `{ autoFill: minWidth }` — as many `1fr` columns as fit
 * with each at least `minWidth`, the responsive inventory/card-grid case. Rows beyond `rows` use
 * `autoRows` (default `"auto"`).
 *
 * Placement: items with an explicit `column`/`row` (1-based, with spans) are placed first; the rest
 * flow row-major into the first free cells that fit their span (CSS `grid-auto-flow: row`, sparse).
 *
 * Sizing (a simplified CSS track algorithm, columns first, then rows with the column widths known):
 * fixed tracks take their size; auto tracks take the largest single-span item, and multi-span items
 * spread any excess evenly over the auto tracks they cross; fr tracks share what is left, a track
 * whose `min` exceeds its share is frozen at the min and the share recomputed. With an indefinite
 * available size, fr tracks size to content (every `1fr` gets the largest per-fr content size).
 */

import { UsageError } from "../../core/errors.js";
import { UIRect } from "../core/geometry.js";
import { offset } from "./stack.js";
import type { Align, LayoutContext, LayoutNode, LayoutStrategy } from "./types.js";

export type TrackInput = number | "auto" | `${number}fr` | { min: number; max: number | "auto" | `${number}fr` };

interface Track {
  /** 0 fixed, 1 auto, 2 fr */
  kind: 0 | 1 | 2;
  value: number;
  min: number;
  max: number;
}

export interface GridOptions {
  columns?: readonly TrackInput[] | number | { autoFill: number };
  rows?: readonly TrackInput[];
  autoRows?: TrackInput;
  columnGap?: number;
  rowGap?: number;
  /** Default horizontal alignment of items in their area. */
  justifyItems?: Align;
  /** Default vertical alignment of items in their area. */
  alignItems?: Align;
}

export function parseTrack(t: TrackInput): Track {
  if (typeof t === "number") {
    if (!(t >= 0)) throw new UsageError(`ui grid: track size ${t} must be >= 0`);
    return { kind: 0, value: t, min: t, max: t };
  }
  if (t === "auto") return { kind: 1, value: 0, min: 0, max: Infinity };
  if (typeof t === "string") {
    const m = /^([\d.]+)fr$/.exec(t);
    if (!m) throw new UsageError(`ui grid: "${t}" is not a track (number, "auto", "Nfr" or {min,max})`);
    return { kind: 2, value: Number(m[1]), min: 0, max: Infinity };
  }
  const inner = parseTrack(t.max);
  return { kind: inner.kind, value: inner.value, min: t.min, max: inner.kind === 0 ? Math.max(inner.value, t.min) : Infinity };
}

interface Placement {
  node: LayoutNode;
  col: number;
  row: number;
  colSpan: number;
  rowSpan: number;
}

const rectScratch = new UIRect();

export class GridLayout implements LayoutStrategy {
  readonly kind = "grid";
  private columnDefs: Track[] = [];
  private autoFillMin = 0;
  private rowDefs: Track[] = [];
  private autoRow: Track;
  columnGap: number;
  rowGap: number;
  justifyItems: Align;
  alignItems: Align;

  private placements: Placement[] = [];
  private colSizes: number[] = [];
  private rowSizes: number[] = [];

  constructor(options: GridOptions = {}) {
    this.setColumns(options.columns ?? 1);
    this.rowDefs = (options.rows ?? []).map(parseTrack);
    this.autoRow = parseTrack(options.autoRows ?? "auto");
    this.columnGap = options.columnGap ?? 0;
    this.rowGap = options.rowGap ?? 0;
    this.justifyItems = options.justifyItems ?? "stretch";
    this.alignItems = options.alignItems ?? "stretch";
  }

  /** Replace the column definition (responsive track changes). */
  setColumns(columns: GridOptions["columns"]): void {
    this.autoFillMin = 0;
    if (typeof columns === "number") {
      if (!Number.isInteger(columns) || columns < 1) throw new UsageError(`ui grid: column count must be an integer >= 1 (got ${columns})`);
      this.columnDefs = Array.from({ length: columns }, () => parseTrack("1fr"));
    } else if (columns && !Array.isArray(columns) && "autoFill" in columns) {
      if (!(columns.autoFill > 0)) throw new UsageError("ui grid: autoFill must be > 0");
      this.autoFillMin = columns.autoFill;
      this.columnDefs = [];
    } else {
      const list = columns as readonly TrackInput[];
      if (list.length === 0) throw new UsageError("ui grid: at least one column is required");
      this.columnDefs = list.map(parseTrack);
    }
  }

  setRows(rows: readonly TrackInput[], autoRows?: TrackInput): void {
    this.rowDefs = rows.map(parseTrack);
    if (autoRows !== undefined) this.autoRow = parseTrack(autoRows);
  }

  /** Column tracks for a given available width (resolves `autoFill`). */
  private columnsFor(availableWidth: number): Track[] {
    if (this.autoFillMin <= 0) return this.columnDefs;
    const count = Number.isFinite(availableWidth) ? Math.max(1, Math.floor((availableWidth + this.columnGap) / (this.autoFillMin + this.columnGap))) : 1;
    if (this.columnDefs.length !== count) this.columnDefs = Array.from({ length: count }, () => ({ kind: 2 as const, value: 1, min: this.autoFillMin, max: Infinity }));
    return this.columnDefs;
  }

  /** Number of columns the last layout used (after `autoFill`). */
  get columnCount(): number {
    return Math.max(1, this.columnDefs.length);
  }

  private place(node: LayoutNode, columns: number): number {
    const placements = this.placements;
    placements.length = 0;
    const occupied = new Set<number>();
    const key = (r: number, c: number): number => r * 4096 + c;
    const fits = (r: number, c: number, rs: number, cs: number): boolean => {
      if (c + cs > columns) return false;
      for (let y = r; y < r + rs; y++) for (let x = c; x < c + cs; x++) if (occupied.has(key(y, x))) return false;
      return true;
    };
    const mark = (p: Placement): void => {
      for (let y = p.row; y < p.row + p.rowSpan; y++) for (let x = p.col; x < p.col + p.colSpan; x++) occupied.add(key(y, x));
    };
    let rowCount = 0;
    const auto: LayoutNode[] = [];
    for (const c of node.layoutChildren) {
      if (!c.isFlowChild) continue;
      const p = c.props;
      const colSpan = Math.min(p.columnSpan, columns);
      if (p.column > 0 || p.row > 0) {
        const col = p.column > 0 ? Math.min(p.column - 1, columns - colSpan) : 0;
        let row = p.row > 0 ? p.row - 1 : 0;
        if (p.row <= 0) while (!fits(row, col, p.rowSpan, colSpan)) row++;
        const pl: Placement = { node: c, col, row, colSpan, rowSpan: p.rowSpan };
        placements.push(pl);
        mark(pl);
        rowCount = Math.max(rowCount, row + p.rowSpan);
      } else auto.push(c);
    }
    let cursorR = 0;
    let cursorC = 0;
    for (const c of auto) {
      const p = c.props;
      const colSpan = Math.min(p.columnSpan, columns);
      while (!fits(cursorR, cursorC, p.rowSpan, colSpan)) {
        cursorC++;
        if (cursorC + colSpan > columns) {
          cursorC = 0;
          cursorR++;
        }
      }
      const pl: Placement = { node: c, col: cursorC, row: cursorR, colSpan, rowSpan: p.rowSpan };
      placements.push(pl);
      mark(pl);
      rowCount = Math.max(rowCount, cursorR + p.rowSpan);
      cursorC += colSpan;
      if (cursorC >= columns) {
        cursorC = 0;
        cursorR++;
      }
    }
    return rowCount;
  }

  private rowTrack(i: number): Track {
    return this.rowDefs[i] ?? this.autoRow;
  }

  /**
   * Size tracks on one axis. `contentOf(p)` gives the item's content size on that axis.
   */
  private sizeTracks(tracks: Track[], available: number, gap: number, out: number[], placements: Placement[], horizontal: boolean, contentOf: (p: Placement) => number): void {
    const n = tracks.length;
    out.length = n;
    for (let i = 0; i < n; i++) {
      const t = tracks[i]!;
      out[i] = t.kind === 0 ? t.value : t.min;
    }
    const start = (p: Placement): number => (horizontal ? p.col : p.row);
    const span = (p: Placement): number => (horizontal ? p.colSpan : p.rowSpan);
    const definite = Number.isFinite(available);
    // Auto tracks (and fr tracks when the space is indefinite) take their content.
    const contentSized = (t: Track): boolean => t.kind === 1 || (t.kind === 2 && !definite);
    for (const p of placements) {
      if (span(p) !== 1) continue;
      const t = tracks[start(p)]!;
      if (contentSized(t)) out[start(p)] = Math.min(t.max, Math.max(out[start(p)]!, contentOf(p)));
    }
    for (const p of placements) {
      if (span(p) === 1) continue;
      let size = gap * (span(p) - 1);
      let autos = 0;
      for (let i = start(p); i < start(p) + span(p); i++) {
        size += out[i]!;
        if (contentSized(tracks[i]!)) autos++;
      }
      const excess = contentOf(p) - size;
      if (excess > 0 && autos > 0) {
        for (let i = start(p); i < start(p) + span(p); i++) if (contentSized(tracks[i]!)) out[i] = out[i]! + excess / autos;
      }
    }
    if (!definite) {
      // Indefinite: every 1fr gets the largest per-fr content size.
      let unit = 0;
      for (let i = 0; i < n; i++) if (tracks[i]!.kind === 2 && tracks[i]!.value > 0) unit = Math.max(unit, out[i]! / tracks[i]!.value);
      for (let i = 0; i < n; i++) if (tracks[i]!.kind === 2) out[i] = Math.max(tracks[i]!.min, unit * tracks[i]!.value);
      return;
    }
    // fr tracks share the leftover; freeze any whose min exceeds its share.
    const frozen = new Array<boolean>(n).fill(false);
    for (let round = 0; round <= n; round++) {
      let used = gap * Math.max(0, n - 1);
      let fr = 0;
      for (let i = 0; i < n; i++) {
        if (tracks[i]!.kind === 2 && !frozen[i]) fr += tracks[i]!.value;
        else used += out[i]!;
      }
      if (fr <= 0) break;
      const unit = Math.max(0, available - used) / fr;
      let violated = false;
      for (let i = 0; i < n; i++) {
        const t = tracks[i]!;
        if (t.kind !== 2 || frozen[i]) continue;
        const share = unit * t.value;
        if (share < t.min) {
          out[i] = t.min;
          frozen[i] = true;
          violated = true;
        } else out[i] = Math.min(share, t.max);
      }
      if (!violated) break;
    }
  }

  private layout(node: LayoutNode, width: number, height: number, ctx: LayoutContext): { cols: Track[]; rows: Track[] } {
    const cols = this.columnsFor(width);
    const rowCount = this.place(node, cols.length);
    const rows: Track[] = [];
    for (let i = 0; i < Math.max(rowCount, this.rowDefs.length); i++) rows.push(this.rowTrack(i));
    const placements = this.placements;
    // Columns: content = item's preferred width with unbounded width.
    this.sizeTracks(cols, width, this.columnGap, this.colSizes, placements, true, (p) => {
      const m = p.node.marginBox;
      return p.node.measure(Infinity, Infinity, ctx).width + m.left + m.right;
    });
    // Rows: content = item's height at its area width.
    this.sizeTracks(rows, height, this.rowGap, this.rowSizes, placements, false, (p) => {
      const m = p.node.marginBox;
      const w = this.span(this.colSizes, p.col, p.colSpan, this.columnGap) - m.left - m.right;
      return p.node.measure(Math.max(0, w), Infinity, ctx).height + m.top + m.bottom;
    });
    return { cols, rows };
  }

  private span(sizes: number[], start: number, count: number, gap: number): number {
    let s = gap * (count - 1);
    for (let i = start; i < start + count; i++) s += sizes[i] ?? 0;
    return s;
  }

  measureContent(node: LayoutNode, availableWidth: number, _availableHeight: number, ctx: LayoutContext): { width: number; height: number } {
    // Height is measured content-sized (rows never stretch to fill during measurement).
    this.layout(node, availableWidth, Infinity, ctx);
    const w = this.span(this.colSizes, 0, this.colSizes.length, this.columnGap);
    const h = this.rowSizes.length > 0 ? this.span(this.rowSizes, 0, this.rowSizes.length, this.rowGap) : 0;
    return { width: w, height: h };
  }

  arrangeContent(node: LayoutNode, content: UIRect, ctx: LayoutContext): void {
    this.layout(node, content.width, content.height, ctx);
    const colX: number[] = [];
    let x = content.x;
    for (const s of this.colSizes) {
      colX.push(x);
      x += s + this.columnGap;
    }
    const rowY: number[] = [];
    let y = content.y;
    for (const s of this.rowSizes) {
      rowY.push(y);
      y += s + this.rowGap;
    }
    for (const p of this.placements) {
      const c = p.node;
      const m = c.marginBox;
      const areaW = Math.max(0, this.span(this.colSizes, p.col, p.colSpan, this.columnGap) - m.left - m.right);
      const areaH = Math.max(0, this.span(this.rowSizes, p.row, p.rowSpan, this.rowGap) - m.top - m.bottom);
      const s = c.measure(areaW, areaH, ctx);
      const ax = c.props.justifySelf ?? this.justifyItems;
      const ay = c.props.alignSelf ?? this.alignItems;
      const w = ax === "stretch" && Number.isNaN(c.definiteWidth(areaW, ctx)) ? c.clampWidth(areaW, areaW, ctx) : s.width;
      const h = ay === "stretch" && Number.isNaN(c.definiteHeight(areaH, ctx)) ? c.clampHeight(areaH, areaH, ctx) : s.height;
      c.arrange(rectScratch.set(colX[p.col]! + m.left + offset(ax, areaW, w), rowY[p.row]! + m.top + offset(ay, areaH, h), w, h), ctx);
    }
  }

  /** Track sizes from the last arrange (diagnostics + tests). */
  get lastColumnSizes(): readonly number[] {
    return this.colSizes;
  }

  get lastRowSizes(): readonly number[] {
    return this.rowSizes;
  }
}
