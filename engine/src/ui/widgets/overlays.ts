/**
 * Overlay widgets: popups, menus, dialogs, toasts and drawers.
 *
 * * `Popup` — a container shown in the `popup` layer next to an owner element. It places itself
 *   below (or above / right / left) the owner, flips to the other side when it would leave the
 *   viewport and is clamped inside it. Light-dismiss: pressing outside it and its owner closes it.
 * * `ModalDialog` — title + body + footer in the `modal` layer: blocks input below, traps focus,
 *   Escape / gamepad B closes it (unless `dismissable: false`), focus returns to where it was.
 * * `ConfirmationDialog` — a modal with a message and confirm/cancel; `ask()` resolves true/false.
 * * `ContextMenu` — a popup list of commands with keyboard navigation and one-level submenus.
 * * `NotificationToast` + `Toasts` — transient messages stacked in the `toast` layer.
 * * `Drawer` — a modal panel docked to the left/right edge that slides in.
 */

import { UIContainer, type UIContainerOptions } from "../core/container.js";
import { UIElement } from "../core/element.js";
import type { UIContext } from "../core/context.js";
import { UIRect } from "../core/geometry.js";
import { FlexLayout } from "../layout/flex.js";
import type { LayoutContext } from "../layout/types.js";
import type { ResolvedStyle } from "../style/types.js";
import { UIState } from "../style/types.js";
import type { UIPainter } from "../render/painter.js";
import { withAlpha } from "../core/color.js";
import { UICustomEvent, type InputSource } from "../input/events.js";
import { TextPart, UIControl } from "./base.js";
import { Label } from "./display.js";
import { Button } from "./interactive.js";
import { Panel, Stack } from "./structural.js";

// ====================================================================== Popup

export type Placement = "below" | "above" | "right" | "left";

export class Popup extends UIContainer {
  static override styleName = "Popup";
  owner: UIElement | null = null;
  placement: Placement;
  /** Gap between owner and popup. */
  offset: number;
  private readonly placed = new UIRect();
  private explicit: { x: number; y: number } | null = null;

  constructor(options: UIContainerOptions & { placement?: Placement; offset?: number; direction?: "row" | "column"; gap?: number } = {}) {
    super({ ...options, strategy: options.strategy ?? new FlexLayout({ direction: options.direction ?? "column", gap: options.gap ?? 0 }) });
    this.pointerEvents = "auto";
    this.placement = options.placement ?? "below";
    this.offset = options.offset ?? 4;
    this.focusScope = true;
    this.on("cancel", (e) => {
      if (!this.isOpen) return;
      e.preventDefault();
      this.close();
    });
  }

  get isOpen(): boolean {
    return this.context?.overlays.isOpen(this) ?? false;
  }

  /** Open next to `owner` (light-dismiss). */
  openAt(ctx: UIContext, owner: UIElement | null, placement: Placement = this.placement): void {
    this.owner = owner;
    this.placement = placement;
    this.explicit = null;
    ctx.overlays.show(this, "popup", { owner, lightDismiss: true });
    this.invalidateLayout();
  }

  /** Open at a point (context menus). */
  openAtPoint(ctx: UIContext, x: number, y: number, owner: UIElement | null = null): void {
    this.owner = owner;
    this.explicit = { x, y };
    ctx.overlays.show(this, "popup", { owner, lightDismiss: true });
    this.invalidateLayout();
  }

  close(): void {
    this.context?.overlays.close(this);
  }

  override arrange(rect: UIRect, ctx: LayoutContext): void {
    const w = rect.width;
    const h = rect.height;
    const vw = ctx.viewportWidth;
    const vh = ctx.viewportHeight;
    let x: number;
    let y: number;
    if (this.explicit) {
      x = this.explicit.x;
      y = this.explicit.y;
      if (x + w > vw) x = Math.max(0, x - w);
      if (y + h > vh) y = Math.max(0, y - h);
    } else if (this.owner) {
      const o = this.owner.bounds;
      const off = this.offset;
      switch (this.placement) {
        case "above":
          x = o.x;
          y = o.y - h - off >= 0 ? o.y - h - off : o.bottom + off;
          break;
        case "right":
          x = o.right + off + w <= vw ? o.right + off : o.x - w - off;
          y = o.y;
          break;
        case "left":
          x = o.x - w - off >= 0 ? o.x - w - off : o.right + off;
          y = o.y;
          break;
        default:
          x = o.x;
          y = o.bottom + off + h <= vh ? o.bottom + off : o.y - h - off;
      }
    } else {
      x = rect.x;
      y = rect.y;
    }
    x = Math.max(0, Math.min(x, vw - w));
    y = Math.max(0, Math.min(y, vh - h));
    super.arrange(this.placed.set(x, y, w, h), ctx);
  }
}

// ====================================================================== ModalDialog

export interface ModalDialogOptions extends UIContainerOptions {
  title?: string;
  /** Escape / B / backdrop do not close it when false. */
  dismissable?: boolean;
  width?: number;
}

export class ModalDialog extends Panel {
  static override styleName = "ModalDialog";
  readonly titleLabel: Label;
  readonly body: Stack;
  readonly footer: Stack;
  dismissable: boolean;
  /** Last result passed to `close(result)`. */
  result: unknown = null;
  private previousFocus: UIElement | null = null;

  constructor(options: ModalDialogOptions = {}) {
    super({ ...options, direction: "column", gap: 12 });
    this.dismissable = options.dismissable ?? true;
    this.accessibility.role = "dialog";
    this.accessibility.label = options.title ?? "";
    this.titleLabel = new Label({ text: options.title ?? "", variant: "heading", visible: !!options.title });
    this.body = new Stack({ direction: "column", gap: 8 });
    this.footer = new Stack({ direction: "row", gap: 8, justify: "end" });
    super.add(this.titleLabel);
    super.add(this.body);
    super.add(this.footer);
    this.setLayout({ width: options.width ?? 380, maxWidth: "92vw", maxHeight: "90vh" });
  }

  /** Children go to the body. */
  override add<T extends UIElement>(child: T): T {
    return this.body.add(child);
  }

  addAction(text: string, onPress: () => void, variant: string | null = null): Button {
    return this.footer.add(new Button({ text, variant: variant ?? undefined, onPress }));
  }

  get title(): string {
    return this.titleLabel.text;
  }
  set title(t: string) {
    this.titleLabel.text = t;
    this.titleLabel.visible = t.length > 0;
    this.accessibility.label = t;
  }

  /** Open as a modal in `ui` (anything with the overlay service). */
  open(ctx: { overlays: UIContext["overlays"]; focus: UIContext["focus"] }, initialFocus: UIElement | null = null): void {
    this.result = null;
    this.previousFocus = ctx.focus.focused;
    ctx.overlays.showModal(this, { initialFocus, closeOnCancel: this.dismissable });
  }

  close(result: unknown = null): void {
    this.result = result;
    this.context?.overlays.close(this);
  }

  /** Element that had focus when the dialog opened (focus returns there on close). */
  get returnFocus(): UIElement | null {
    return this.previousFocus;
  }
}

export class ConfirmationDialog extends ModalDialog {
  static override styleName = "ConfirmationDialog";
  readonly message: Label;
  readonly confirmButton: Button;
  readonly cancelButton: Button;
  private resolver: ((v: boolean) => void) | null = null;

  constructor(options: ModalDialogOptions & { message?: string; confirmText?: string; cancelText?: string; danger?: boolean } = {}) {
    super({ title: options.title ?? "Are you sure?", ...options });
    this.message = this.add(new Label({ text: options.message ?? "", wrap: "word" }));
    this.cancelButton = this.addAction(options.cancelText ?? "Cancel", () => this.close(false));
    this.confirmButton = this.addAction(options.confirmText ?? "Confirm", () => this.close(true), options.danger ? "danger" : "primary");
    this.on("close", () => {
      const r = this.resolver;
      this.resolver = null;
      r?.(this.result === true);
    });
  }

  /** Open and resolve with the choice (Escape/cancel → false). Focus starts on Cancel (safe default). */
  ask(ctx: { overlays: UIContext["overlays"]; focus: UIContext["focus"] }): Promise<boolean> {
    return new Promise((resolve) => {
      this.resolver = resolve;
      this.open(ctx, this.cancelButton);
    });
  }
}

// ====================================================================== ContextMenu

export interface MenuItemDef {
  label?: string;
  shortcut?: string;
  icon?: string;
  disabled?: boolean;
  checked?: boolean;
  separator?: boolean;
  onSelect?: () => void;
  items?: readonly MenuItemDef[];
}

export class MenuItem extends UIControl {
  static override styleName = "MenuItem";
  readonly def: MenuItemDef;
  private readonly label: TextPart;
  private readonly shortcut: TextPart;

  constructor(
    def: MenuItemDef,
    private readonly menu: ContextMenu,
  ) {
    super({ enabled: !def.disabled, accessibility: { role: def.checked !== undefined ? "menuitemcheckbox" : "menuitem", label: def.label ?? "" } });
    this.def = def;
    this.label = new TextPart(def.label ?? "", { overflow: "ellipsis" });
    this.shortcut = new TextPart(def.items ? "▶" : def.shortcut ?? "");
    if (def.checked) this.setStateBit(UIState.Checked, true);
    this.on("pointerenter", () => {
      if (this.effectivelyEnabled) this.focus(false);
      this.menu._hover(this);
    });
  }

  protected override onPress(source: InputSource): void {
    this.menu._activate(this, source);
  }

  protected override measureContent(availableWidth: number): { width: number; height: number } {
    const s = this.computedStyle;
    const l = this.label.layout(this.context, s, availableWidth);
    const k = this.shortcut.layout(this.context, s, Infinity);
    return { width: s.iconSize + s.spacing + (l?.width ?? 0) + (k && k.width > 0 ? s.spacing * 4 + k.width : 0), height: Math.max(l?.height ?? 0, s.iconSize) };
  }

  protected override paintContent(p: UIPainter, s: ResolvedStyle): void {
    const c = this.contentRect;
    const ctx = this.context;
    if (!ctx) return;
    if (this.def.checked) {
      const g = ctx.text.layout({ text: "✓", family: "default", size: s.iconSize * 0.8 });
      p.text(g, c.x, c.y + (c.height - g.height) / 2, s.accent);
    }
    const k = this.shortcut.layout(ctx, s, Infinity);
    const kw = k && k.width > 0 ? k.width + s.spacing * 2 : 0;
    const lx = c.x + s.iconSize + s.spacing;
    this.label.paint(p, this.label.layout(ctx, s, c.right - lx - kw), lx, c.y, c.right - lx - kw, c.height, s.foreground, "start");
    if (k && k.width > 0) this.shortcut.paint(p, k, c.x, c.y, c.width, c.height, withAlpha(s.foreground, 0.55), "end");
  }
}

class MenuSeparator extends UIElement {
  static override styleName = "MenuSeparator";
  constructor() {
    super({ accessibility: { role: "separator" } });
    this.pointerEvents = "none";
  }
  protected override measureContent(): { width: number; height: number } {
    return { width: 0, height: 9 };
  }
  protected override paintContent(p: UIPainter, s: ResolvedStyle): void {
    const b = this.bounds;
    p.fillRect(b.x + 6, b.y + b.height / 2, b.width - 12, 1, s.borderColor || withAlpha(s.foreground, 0.2));
  }
}

export class ContextMenu extends Popup {
  static override styleName = "ContextMenu";
  private items: MenuItem[] = [];
  private submenu: ContextMenu | null = null;
  /** Parent menu for submenus. */
  parentMenu: ContextMenu | null = null;
  /** Fires with the selected definition. */
  onSelect: ((item: MenuItemDef) => void) | null = null;

  constructor(options: UIContainerOptions & { items?: readonly MenuItemDef[]; placement?: Placement } = {}) {
    super({ ...options, direction: "column" });
    this.accessibility.role = "menu";
    this.setLayout({ minWidth: 180 });
    if (options.items) this.setItems(options.items);
    this.on("navigate", (e) => {
      const focusables = this.items.filter((i) => i.canFocus);
      const cur = focusables.findIndex((i) => i.focused);
      if (e.direction === "up" || e.direction === "down") {
        e.preventDefault();
        if (focusables.length === 0) return;
        const next = cur < 0 ? (e.direction === "down" ? 0 : focusables.length - 1) : (cur + (e.direction === "down" ? 1 : -1) + focusables.length) % focusables.length;
        focusables[next]!.focus(true);
      } else if (e.direction === "right") {
        const item = focusables[cur];
        if (item?.def.items) {
          e.preventDefault();
          this.openSubmenu(item, true);
        }
      } else if (e.direction === "left" && this.parentMenu) {
        e.preventDefault();
        const owner = this.owner;
        this.close();
        owner?.focus(true);
      }
    });
  }

  setItems(defs: readonly MenuItemDef[]): void {
    for (const el of [...this.children]) el.dispose();
    this.items = [];
    for (const d of defs) {
      if (d.separator) this.add(new MenuSeparator());
      else this.items.push(this.add(new MenuItem(d, this)));
    }
  }

  get menuItems(): readonly MenuItem[] {
    return this.items;
  }

  /** Focus the first enabled item (keyboard-opened menus). */
  focusFirst(visible = true): void {
    this.items.find((i) => i.canFocus)?.focus(visible);
  }

  /** @internal */
  _hover(item: MenuItem): void {
    if (item.def.items) this.openSubmenu(item, false);
    else if (this.submenu) this.closeSubmenu();
  }

  /** @internal */
  _activate(item: MenuItem, source: InputSource): void {
    if (item.def.items) {
      this.openSubmenu(item, source !== "pointer");
      return;
    }
    item.def.onSelect?.();
    let root: ContextMenu = this;
    while (root.parentMenu) root = root.parentMenu;
    root.onSelect?.(item.def);
    root.emit(new UICustomEvent("select", item.def));
    root.closeAll();
  }

  private openSubmenu(item: MenuItem, focus: boolean): void {
    const ctx = this.context;
    if (!ctx || !item.def.items) return;
    if (this.submenu?.owner === item) {
      if (focus) this.submenu.focusFirst();
      return;
    }
    this.closeSubmenu();
    const sub = new ContextMenu({ items: item.def.items, placement: "right" });
    sub.parentMenu = this;
    this.submenu = sub;
    sub.openAt(ctx, item, "right");
    if (focus) sub.focusFirst();
  }

  private closeSubmenu(): void {
    const s = this.submenu;
    this.submenu = null;
    if (s) {
      s.close();
      s.dispose();
    }
  }

  override close(): void {
    this.closeSubmenu();
    super.close();
  }

  /** Close this menu and every ancestor menu. */
  closeAll(): void {
    let root: ContextMenu = this;
    while (root.parentMenu) root = root.parentMenu;
    const owner = root.owner;
    root.close();
    if (owner?.canFocus) owner.focus(true);
  }
}

// ====================================================================== Toasts

export type ToastKind = "info" | "success" | "warning" | "error";

export class NotificationToast extends Panel {
  static override styleName = "NotificationToast";
  readonly message: Label;
  readonly kind: ToastKind;
  /** Seconds before it dismisses itself (0 = stays until dismissed). */
  duration: number;
  private age = 0;

  constructor(options: UIContainerOptions & { message?: string; title?: string; kind?: ToastKind; duration?: number } = {}) {
    super({ ...options, direction: "column", gap: 2, variant: options.kind ?? "info" });
    this.kind = options.kind ?? "info";
    this.duration = options.duration ?? 4;
    this.accessibility.role = this.kind === "error" ? "alert" : "status";
    if (options.title) this.add(new Label({ text: options.title, variant: "strong" }));
    this.message = this.add(new Label({ text: options.message ?? "", wrap: "word" }));
    this.accessibility.label = `${options.title ?? ""} ${options.message ?? ""}`.trim();
    this.setLayout({ width: 300, maxWidth: "90vw" });
    this.on("click", () => this.dismiss());
    this.setTicking(true);
  }

  override update(dt: number): void {
    if (this.duration <= 0 || this.hasState(UIState.Hovered)) return;
    this.age += dt;
    if (this.age >= this.duration) this.dismiss();
  }

  dismiss(): void {
    if (this.disposed) return;
    const ctx = this.context;
    this.setTicking(false);
    if (!ctx || ctx.reducedMotion) {
      this.dispose();
      return;
    }
    ctx.animator.animate(this as NotificationToast, { opacity: 0 }, { duration: 0.2, onComplete: () => this.dispose() });
  }
}

/** Stacks toasts in a corner of the `toast` layer (newest at the bottom). */
export class Toasts {
  private stack: Stack | null = null;
  maxVisible = 4;

  constructor(
    private readonly ctx: UIContext,
    readonly corner: "top-right" | "bottom-right" | "top-left" | "bottom-left" = "bottom-right",
  ) {}

  private ensure(): Stack {
    if (this.stack && !this.stack.disposed) return this.stack;
    const top = this.corner.startsWith("top");
    const right = this.corner.endsWith("right");
    const s = new Stack({ direction: "column", gap: 8, align: right ? "end" : "start", name: "toasts" });
    s.setLayout({ anchor: { [top ? "top" : "bottom"]: 16, [right ? "right" : "left"]: 16 } as Record<string, number> });
    this.ctx.overlays.show(s, "toast");
    this.stack = s;
    return s;
  }

  show(message: string, kind: ToastKind = "info", options: { title?: string; duration?: number } = {}): NotificationToast {
    const s = this.ensure();
    const t = new NotificationToast({ message, kind, ...options });
    s.add(t);
    const extra = s.children.length - this.maxVisible;
    for (let i = 0; i < extra; i++) (s.children[0] as NotificationToast).dispose();
    if (!this.ctx.reducedMotion) {
      t.opacity = 0;
      t.translateY = 12;
      this.ctx.animator.animate(t as NotificationToast, { opacity: 1, translateY: 0 }, { duration: 0.2, easing: "easeOutCubic" });
    }
    return t;
  }

  get count(): number {
    return this.stack && !this.stack.disposed ? this.stack.children.length : 0;
  }
}

// ====================================================================== Drawer

export class Drawer extends Panel {
  static override styleName = "Drawer";
  readonly side: "left" | "right";

  constructor(options: UIContainerOptions & { side?: "left" | "right"; width?: number; title?: string } = {}) {
    super({ ...options, direction: "column", gap: 8 });
    this.side = options.side ?? "left";
    this.accessibility.role = "dialog";
    this.accessibility.label = options.title ?? "Drawer";
    this.setLayout({ width: options.width ?? 280, maxWidth: "85vw", justifySelf: this.side === "left" ? "start" : "end", alignSelf: "stretch" });
    if (options.title) super.add(new Label({ text: options.title, variant: "heading" }));
  }

  open(ctx: { overlays: UIContext["overlays"]; animator: UIContext["animator"]; reducedMotion: boolean }): void {
    ctx.overlays.showModal(this, { closeOnCancel: true });
    if (!ctx.reducedMotion) {
      this.translateX = this.side === "left" ? -320 : 320;
      ctx.animator.animate(this as Drawer, { translateX: 0 }, { duration: 0.25, easing: "easeOutCubic" });
    }
  }

  close(): void {
    const ctx = this.context;
    if (!ctx) return;
    if (ctx.reducedMotion) {
      ctx.overlays.close(this);
      return;
    }
    ctx.animator.animate(this as Drawer, { translateX: this.side === "left" ? -320 : 320 }, { duration: 0.2, easing: "easeIn", onComplete: () => ctx.overlays.close(this) });
  }

}
