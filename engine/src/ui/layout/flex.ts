/**
 * Flex layout — CSS flexbox's useful core, implemented as a layout strategy.
 *
 * Supported: `row`/`column` direction, `gap` (main axis) and `lineGap` (between wrapped lines),
 * `wrap`, `justify` (start/center/end/space-between/space-around/space-evenly), container `align`
 * plus per-item `alignSelf`, `flexGrow`/`flexShrink`/`flexBasis`, min/max constraints on both axes,
 * and margins. Not supported: `order`, `reverse` directions, baseline alignment, `align-content`
 * (lines pack at the start).
 *
 * Algorithm per line: hypothetical main size = definite `flexBasis`, else the item's measured size;
 * free space is distributed by grow factors (or removed by shrink × basis), and items that hit a
 * min/max are frozen and the rest re-distributed (the CSS "resolve flexible lengths" loop, bounded to
 * as many rounds as there are items). Items are then re-measured at their final main size so text
 * wraps to the width it actually got. Overflowing items overflow; clipping is the container's
 * `clipChildren` choice.
 */

import { UIRect } from "../core/geometry.js";
import { resolveLength, type Align, type Justify, type LayoutContext, type LayoutNode, type LayoutStrategy } from "./types.js";

export interface FlexOptions {
  direction?: "row" | "column";
  gap?: number;
  lineGap?: number;
  wrap?: boolean;
  justify?: Justify;
  align?: Align;
}

const rectScratch = new UIRect();

export class FlexLayout implements LayoutStrategy {
  readonly kind = "flex";
  direction: "row" | "column";
  gap: number;
  lineGap: number;
  wrap: boolean;
  justify: Justify;
  align: Align;

  // Per-arrange scratch (one strategy instance belongs to one container).
  private items: LayoutNode[] = [];
  private base: number[] = [];
  private main: number[] = [];
  private cross: number[] = [];
  private frozen: boolean[] = [];
  private lineStart: number[] = [];

  constructor(options: FlexOptions = {}) {
    this.direction = options.direction ?? "row";
    this.gap = options.gap ?? 0;
    this.lineGap = options.lineGap ?? this.gap;
    this.wrap = options.wrap ?? false;
    this.justify = options.justify ?? "start";
    this.align = options.align ?? "stretch";
  }

  private get row(): boolean {
    return this.direction === "row";
  }

  measureContent(node: LayoutNode, availableWidth: number, availableHeight: number, ctx: LayoutContext): { width: number; height: number } {
    const row = this.row;
    const availMain = row ? availableWidth : availableHeight;
    let lineMain = 0;
    let lineCross = 0;
    let totalMain = 0;
    let totalCross = 0;
    let count = 0;
    let lines = 0;
    for (const c of node.layoutChildren) {
      if (!c.isFlowChild) continue;
      const m = c.marginBox;
      const mMain = row ? m.left + m.right : m.top + m.bottom;
      const mCross = row ? m.top + m.bottom : m.left + m.right;
      const s = c.measure(row ? Math.max(0, availableWidth - mMain) : Math.max(0, availableWidth - mCross), row ? Math.max(0, availableHeight - mCross) : Math.max(0, availableHeight - mMain), ctx);
      const basis = this.basisOf(c, row ? availableWidth : availableHeight, ctx);
      const itemMain = (Number.isNaN(basis) ? (row ? s.width : s.height) : basis) + mMain;
      const itemCross = (row ? s.height : s.width) + mCross;
      if (this.wrap && count > 0 && Number.isFinite(availMain) && lineMain + this.gap + itemMain > availMain + 1e-6) {
        totalMain = Math.max(totalMain, lineMain);
        totalCross += lineCross + (lines > 0 ? this.lineGap : 0);
        lines++;
        lineMain = 0;
        lineCross = 0;
        count = 0;
      }
      lineMain += (count > 0 ? this.gap : 0) + itemMain;
      lineCross = Math.max(lineCross, itemCross);
      count++;
    }
    if (count > 0) {
      totalMain = Math.max(totalMain, lineMain);
      totalCross += lineCross + (lines > 0 ? this.lineGap : 0);
    }
    return row ? { width: totalMain, height: totalCross } : { width: totalCross, height: totalMain };
  }

  private basisOf(c: LayoutNode, parentMain: number, ctx: LayoutContext): number {
    const b = resolveLength(c.props.flexBasis, parentMain, ctx.viewportWidth, ctx.viewportHeight);
    if (!Number.isNaN(b)) return b;
    return this.row ? c.definiteWidth(parentMain, ctx) : c.definiteHeight(parentMain, ctx);
  }

  arrangeContent(node: LayoutNode, content: UIRect, ctx: LayoutContext): void {
    const row = this.row;
    const items = this.items;
    items.length = 0;
    for (const c of node.layoutChildren) if (c.isFlowChild) items.push(c);
    const n = items.length;
    if (n === 0) return;
    const contentMain = row ? content.width : content.height;
    const contentCross = row ? content.height : content.width;
    const base = this.base;
    const main = this.main;
    const cross = this.cross;
    const frozen = this.frozen;
    base.length = main.length = cross.length = frozen.length = n;

    // 1. Hypothetical main sizes (margin excluded).
    for (let i = 0; i < n; i++) {
      const c = items[i]!;
      const m = c.marginBox;
      const mCross = row ? m.top + m.bottom : m.left + m.right;
      const mMain = row ? m.left + m.right : m.top + m.bottom;
      const basis = this.basisOf(c, contentMain, ctx);
      if (!Number.isNaN(basis)) base[i] = this.clampMain(c, basis, contentMain, ctx);
      else {
        const s = c.measure(row ? Math.max(0, contentMain - mMain) : Math.max(0, contentCross - mCross), row ? Math.max(0, contentCross - mCross) : Math.max(0, contentMain - mMain), ctx);
        base[i] = row ? s.width : s.height;
      }
    }

    // 2. Break into lines.
    const lineStart = this.lineStart;
    lineStart.length = 0;
    lineStart.push(0);
    if (this.wrap) {
      let used = 0;
      for (let i = 0; i < n; i++) {
        const outer = base[i]! + mainMargins(items[i]!, row);
        if (i > lineStart[lineStart.length - 1]! && used + this.gap + outer > contentMain + 1e-6) {
          lineStart.push(i);
          used = outer;
        } else used += (i > lineStart[lineStart.length - 1]! ? this.gap : 0) + outer;
      }
    }
    lineStart.push(n);
    const lineCount = lineStart.length - 1;

    // 3. Per line: flex the main sizes, measure cross sizes.
    let crossCursor = 0;
    for (let li = 0; li < lineCount; li++) {
      const s0 = lineStart[li]!;
      const s1 = lineStart[li + 1]!;
      this.resolveFlexible(items, s0, s1, contentMain, ctx);
      // Cross sizes: re-measure at the final main size (text wraps to what it got).
      let lineCross = 0;
      for (let i = s0; i < s1; i++) {
        const c = items[i]!;
        const m = c.marginBox;
        const mCross = row ? m.top + m.bottom : m.left + m.right;
        const s = row ? c.measure(main[i]!, Math.max(0, contentCross - mCross), ctx) : c.measure(Math.max(0, contentCross - mCross), main[i]!, ctx);
        cross[i] = row ? s.height : s.width;
        lineCross = Math.max(lineCross, cross[i]! + mCross);
      }
      // A single-line container's line is exactly as tall (wide) as the container (CSS); larger
      // items overflow instead of growing the line past the container.
      if (lineCount === 1 && Number.isFinite(contentCross)) lineCross = contentCross;

      // Justify along the main axis.
      let used = 0;
      for (let i = s0; i < s1; i++) used += main[i]! + mainMargins(items[i]!, row);
      const count = s1 - s0;
      used += this.gap * (count - 1);
      const free = contentMain - used;
      let pos = 0;
      let between = this.gap;
      if (free > 0) {
        switch (this.justify) {
          case "center":
            pos = free / 2;
            break;
          case "end":
            pos = free;
            break;
          case "space-between":
            if (count > 1) between += free / (count - 1);
            else pos = 0;
            break;
          case "space-around":
            pos = free / count / 2;
            between += free / count;
            break;
          case "space-evenly":
            pos = free / (count + 1);
            between += free / (count + 1);
            break;
          default:
            break;
        }
      }

      for (let i = s0; i < s1; i++) {
        const c = items[i]!;
        const m = c.marginBox;
        const mStart = row ? m.left : m.top;
        const mEnd = row ? m.right : m.bottom;
        const cStart = row ? m.top : m.left;
        const cEnd = row ? m.bottom : m.right;
        const align = c.props.alignSelf ?? this.align;
        const areaCross = Math.max(0, lineCross - cStart - cEnd);
        let crossSize = cross[i]!;
        const crossDefinite = row ? c.definiteHeight(contentCross, ctx) : c.definiteWidth(contentCross, ctx);
        if (align === "stretch" && Number.isNaN(crossDefinite)) {
          crossSize = row ? c.clampHeight(areaCross, contentCross, ctx) : c.clampWidth(areaCross, contentCross, ctx);
        }
        let crossPos = 0;
        if (align === "center") crossPos = (areaCross - crossSize) / 2;
        else if (align === "end") crossPos = areaCross - crossSize;
        const mainPos = pos + mStart;
        const cp = crossCursor + cStart + crossPos;
        if (row) rectScratch.set(content.x + mainPos, content.y + cp, main[i]!, crossSize);
        else rectScratch.set(content.x + cp, content.y + mainPos, crossSize, main[i]!);
        c.arrange(rectScratch, ctx);
        pos = mainPos + main[i]! + mEnd + between;
      }
      crossCursor += lineCross + this.lineGap;
    }
    items.length = 0;
  }

  private clampMain(c: LayoutNode, v: number, parentMain: number, ctx: LayoutContext): number {
    return this.row ? c.clampWidth(v, parentMain, ctx) : c.clampHeight(v, parentMain, ctx);
  }

  /** CSS "resolve flexible lengths": distribute free space, freeze items that hit a bound, repeat. */
  private resolveFlexible(items: LayoutNode[], s0: number, s1: number, contentMain: number, ctx: LayoutContext): void {
    const row = this.row;
    const { base, main, frozen } = this;
    let outer = this.gap * (s1 - s0 - 1);
    for (let i = s0; i < s1; i++) {
      outer += base[i]! + mainMargins(items[i]!, row);
      main[i] = base[i]!;
      frozen[i] = false;
    }
    if (!Number.isFinite(contentMain)) return;
    const growing = outer < contentMain;
    for (let i = s0; i < s1; i++) {
      const p = items[i]!.props;
      if ((growing ? p.flexGrow : p.flexShrink) === 0) frozen[i] = true;
    }
    for (let round = 0; round <= s1 - s0; round++) {
      let used = this.gap * (s1 - s0 - 1);
      let factor = 0;
      for (let i = s0; i < s1; i++) {
        used += (frozen[i] ? main[i]! : base[i]!) + mainMargins(items[i]!, row);
        if (!frozen[i]) factor += growing ? items[i]!.props.flexGrow : items[i]!.props.flexShrink * base[i]!;
      }
      const free = contentMain - used;
      if (factor <= 0 || Math.abs(free) < 1e-9) break;
      let violation = false;
      for (let i = s0; i < s1; i++) {
        if (frozen[i]) continue;
        const p = items[i]!.props;
        const share = growing ? (free * p.flexGrow) / factor : (free * p.flexShrink * base[i]!) / factor;
        const target = Math.max(0, base[i]! + share);
        const clamped = this.clampMain(items[i]!, target, contentMain, ctx);
        main[i] = clamped;
        if (Math.abs(clamped - target) > 1e-6) {
          frozen[i] = true;
          violation = true;
        }
      }
      if (!violation) break;
    }
  }
}

function mainMargins(c: LayoutNode, row: boolean): number {
  const m = c.marginBox;
  return row ? m.left + m.right : m.top + m.bottom;
}
