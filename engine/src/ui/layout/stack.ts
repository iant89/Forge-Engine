/**
 * Stack (overlay) layout — every flow child occupies the content box, aligned per axis by its
 * `justifySelf` (horizontal) and `alignSelf` (vertical). The default is `stretch` on both axes, so a
 * stack of layers fills its container; a child with `alignSelf: "end"` and an auto height sits at the
 * bottom at its measured height. The content size is the largest child's margin box.
 */

import { UIRect } from "../core/geometry.js";
import type { Align, LayoutContext, LayoutNode, LayoutStrategy } from "./types.js";

const scratch = new UIRect();

export class StackLayout implements LayoutStrategy {
  readonly kind = "stack";

  constructor(
    public alignX: Align = "stretch",
    public alignY: Align = "stretch",
  ) {}

  measureContent(node: LayoutNode, availableWidth: number, availableHeight: number, ctx: LayoutContext): { width: number; height: number } {
    let w = 0;
    let h = 0;
    for (const c of node.layoutChildren) {
      if (!c.isFlowChild) continue;
      const m = c.marginBox;
      const s = c.measure(Math.max(0, availableWidth - m.left - m.right), Math.max(0, availableHeight - m.top - m.bottom), ctx);
      w = Math.max(w, s.width + m.left + m.right);
      h = Math.max(h, s.height + m.top + m.bottom);
    }
    return { width: w, height: h };
  }

  arrangeContent(node: LayoutNode, content: UIRect, ctx: LayoutContext): void {
    for (const c of node.layoutChildren) {
      if (!c.isFlowChild) continue;
      const m = c.marginBox;
      const areaW = Math.max(0, content.width - m.left - m.right);
      const areaH = Math.max(0, content.height - m.top - m.bottom);
      const s = c.measure(areaW, areaH, ctx);
      const ax = c.props.justifySelf ?? this.alignX;
      const ay = c.props.alignSelf ?? this.alignY;
      const w = ax === "stretch" && Number.isNaN(c.definiteWidth(areaW, ctx)) ? c.clampWidth(areaW, content.width, ctx) : s.width;
      const h = ay === "stretch" && Number.isNaN(c.definiteHeight(areaH, ctx)) ? c.clampHeight(areaH, content.height, ctx) : s.height;
      const x = content.x + m.left + offset(ax, areaW, w);
      const y = content.y + m.top + offset(ay, areaH, h);
      c.arrange(scratch.set(x, y, w, h), ctx);
    }
  }
}

export function offset(align: Align, area: number, size: number): number {
  if (align === "center") return (area - size) / 2;
  if (align === "end") return area - size;
  return 0;
}
