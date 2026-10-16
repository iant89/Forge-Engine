/**
 * Framework-owned overlay elements: the modal backdrop host and the tooltip bubble.
 *
 * `ModalHost` fills the viewport, paints the `ModalBackdrop` skin, takes every pointer event that
 * reaches the modal layer (nothing below a modal is clickable), is a focus scope, and closes its
 * dialog on `cancel` (Escape / gamepad B) when `closeOnCancel` is set. The dialog keeps its own size
 * and is centred unless it sets `justifySelf`/`alignSelf` (drawers dock to an edge that way).
 */

import { UIContainer } from "../core/container.js";
import type { UIElement } from "../core/element.js";
import { StackLayout } from "../layout/stack.js";
import type { LayoutContext } from "../layout/types.js";
import type { ResolvedStyle } from "../style/types.js";
import type { UIPainter } from "../render/painter.js";
import { UIElement as Base } from "../core/element.js";
import { TextPart } from "./base.js";

export class ModalHost extends UIContainer {
  static override styleName = "ModalBackdrop";

  constructor(
    readonly dialog: UIElement,
    closeOnCancel: boolean,
    close: () => void,
  ) {
    super({ name: "modal-host", strategy: new StackLayout("center", "center") });
    this.pointerEvents = "auto";
    this.focusScope = true;
    this.accessibility.role = "dialog";
    this.add(dialog);
    this.on("cancel", (e) => {
      if (!closeOnCancel || e.defaultPrevented) return;
      e.preventDefault();
      close();
    });
  }
}

/** The hover tooltip the manager shows after `tooltipDelay`. */
export class TooltipBubble extends Base {
  static override styleName = "Tooltip";
  private readonly part: TextPart;
  maxWidth = 260;

  constructor(text: string) {
    super({ name: "tooltip" });
    this.pointerEvents = "none";
    this.accessibility.role = "tooltip";
    this.accessibility.label = text;
    this.part = new TextPart(text, { wrap: "word" });
  }

  get text(): string {
    return this.part.text;
  }
  set text(t: string) {
    if (this.part.set(t)) {
      this.accessibility.label = t;
      this.invalidateLayout();
    }
  }

  protected override measureContent(availableWidth: number, _h: number, _ctx: LayoutContext): { width: number; height: number } {
    const l = this.part.layout(this.context, this.computedStyle, Math.min(availableWidth, this.maxWidth));
    return { width: l?.width ?? 0, height: l?.height ?? 0 };
  }

  protected override paintContent(p: UIPainter, s: ResolvedStyle): void {
    const c = this.contentRect;
    this.part.paint(p, this.part.layout(this.context, s, Math.min(c.width + 0.01, this.maxWidth)), c.x, c.y, c.width, c.height, s.foreground, "start", "top");
  }
}
