/**
 * Anchor layout — free-form placement against the container's edges.
 *
 * Per axis an element can be anchored to the start edge (`left`/`top`), the end edge
 * (`right`/`bottom`), both (stretch between them), or the centre (`centerX`/`centerY`, with an
 * offset). Edge offsets are lengths, so `"5%"` is a relative anchor. An unanchored axis sits at the
 * start edge. Margins are added outside the anchored box.
 *
 * Used two ways: as the strategy of an anchor container (`AnchorLayout`, e.g. a HUD canvas), whose
 * flow children are placed relative to its *content* box; and for any `position: "absolute"` child in
 * any container, placed relative to the parent's *border* box (so a close button can sit in the
 * corner of a padded panel).
 */

import { UIRect } from "../core/geometry.js";
import { resolveLength, type LayoutContext, type LayoutNode, type LayoutStrategy } from "./types.js";

const scratch = new UIRect();

/** Place `child` inside `area` according to its anchor props. */
export function placeAnchored(child: LayoutNode, area: Readonly<UIRect>, ctx: LayoutContext): void {
  const a = child.props.anchor;
  const m = child.marginBox;
  const vw = ctx.viewportWidth;
  const vh = ctx.viewportHeight;
  const L = a?.left ? resolveLength(a.left, area.width, vw, vh) : NaN;
  const R = a?.right ? resolveLength(a.right, area.width, vw, vh) : NaN;
  const T = a?.top ? resolveLength(a.top, area.height, vw, vh) : NaN;
  const B = a?.bottom ? resolveLength(a.bottom, area.height, vw, vh) : NaN;

  const innerW = Math.max(0, area.width - m.left - m.right);
  const innerH = Math.max(0, area.height - m.top - m.bottom);
  const stretchW = !Number.isNaN(L) && !Number.isNaN(R);
  const stretchH = !Number.isNaN(T) && !Number.isNaN(B);
  const availW = stretchW ? Math.max(0, innerW - L - R) : innerW;
  const availH = stretchH ? Math.max(0, innerH - T - B) : innerH;
  const desired = child.measure(availW, availH, ctx);
  const w = stretchW ? child.clampWidth(availW, area.width, ctx) : desired.width;
  const h = stretchH ? child.clampHeight(availH, area.height, ctx) : desired.height;

  let x: number;
  if (!Number.isNaN(L)) x = area.x + m.left + L;
  else if (!Number.isNaN(R)) x = area.x + area.width - m.right - R - w;
  else if (a?.centerX !== null && a?.centerX !== undefined) x = area.x + (area.width - w) / 2 + a.centerX;
  else x = area.x + m.left;

  let y: number;
  if (!Number.isNaN(T)) y = area.y + m.top + T;
  else if (!Number.isNaN(B)) y = area.y + area.height - m.bottom - B - h;
  else if (a?.centerY !== null && a?.centerY !== undefined) y = area.y + (area.height - h) / 2 + a.centerY;
  else y = area.y + m.top;

  child.arrange(scratch.set(x, y, w, h), ctx);
}

/** Absolute children are anchored to the parent's border box. */
export function arrangeAbsoluteChild(child: LayoutNode, parentBorderBox: Readonly<UIRect>, ctx: LayoutContext): void {
  placeAnchored(child, parentBorderBox, ctx);
}

export class AnchorLayout implements LayoutStrategy {
  readonly kind = "anchor";

  measureContent(node: LayoutNode, availableWidth: number, availableHeight: number, ctx: LayoutContext): { width: number; height: number } {
    let w = 0;
    let h = 0;
    for (const c of node.layoutChildren) {
      if (!c.isFlowChild) continue;
      const a = c.props.anchor;
      const m = c.marginBox;
      const size = c.measure(availableWidth, availableHeight, ctx);
      const left = a?.left ? resolveLength(a.left, availableWidth, ctx.viewportWidth, ctx.viewportHeight) : 0;
      const top = a?.top ? resolveLength(a.top, availableHeight, ctx.viewportWidth, ctx.viewportHeight) : 0;
      w = Math.max(w, (Number.isNaN(left) ? 0 : left) + size.width + m.left + m.right);
      h = Math.max(h, (Number.isNaN(top) ? 0 : top) + size.height + m.top + m.bottom);
    }
    return { width: w, height: h };
  }

  arrangeContent(node: LayoutNode, content: UIRect, ctx: LayoutContext): void {
    for (const c of node.layoutChildren) if (c.isFlowChild) placeAnchored(c, content, ctx);
  }
}
