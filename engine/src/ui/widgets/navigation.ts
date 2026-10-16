/**
 * Navigation widgets: tabs, navigation bar, breadcrumbs, menu bar and command palette.
 *
 * * `TabContainer` — a tab strip (`TabButton`s) over one visible page. Left/Right move between tabs
 *   while the strip has focus; gamepad shoulder buttons (LB/RB → `pagenext`/`pageprevious`) switch
 *   pages from anywhere inside the container. Hidden pages keep their state (they are only hidden).
 * * `NavigationBar` — a row of destinations. At the `compact` breakpoint it collapses into a menu
 *   button that opens the same destinations in a `Drawer` (a real responsive presentation change,
 *   not a scale-down).
 * * `Breadcrumbs` — clickable path segments.
 * * `MenuBar` — top-level menus opening `ContextMenu`s; hovering another title while one is open
 *   switches menus; Left/Right switch between open menus.
 * * `CommandPalette` — a modal filter box over a list of commands (subsequence fuzzy match, best
 *   match first); Enter runs the highlighted command.
 */

import { UIElement } from "../core/element.js";
import type { UIContext } from "../core/context.js";
import { UIContainer, type UIContainerOptions } from "../core/container.js";
import { UIRect } from "../core/geometry.js";
import type { LayoutContext } from "../layout/types.js";
import { UIState } from "../style/types.js";
import { UICustomEvent, type InputSource, type UIKeyEvent } from "../input/events.js";
import { Button, IconButton, ToggleButton, type ButtonOptions } from "./interactive.js";
import { Label } from "./display.js";
import { Stack } from "./structural.js";
import { ContextMenu, Drawer, ModalDialog, type MenuItemDef } from "./overlays.js";
import { ListBox } from "./collections.js";
import { TextInput } from "./textInput.js";

// ====================================================================== Tabs

export class TabButton extends Button {
  static override styleName = "TabButton";
  constructor(options: ButtonOptions = {}) {
    super(options);
    this.accessibility.role = "tab";
  }
}

export class TabContainer extends UIElement {
  static override styleName = "TabContainer";
  readonly strip: Stack;
  readonly pages: UIContainer;
  private readonly tabs: { button: TabButton; page: UIElement }[] = [];
  private _selected = -1;
  onChange: ((index: number) => void) | null = null;

  constructor(options: UIContainerOptions & { onChange?: (index: number) => void } = {}) {
    super(options);
    this.onChange = options.onChange ?? null;
    this.accessibility.role = "tablist";
    this.strip = new Stack({ direction: "row", gap: 2, name: "tab-strip" });
    this.strip.styleClass = "TabStrip";
    this.pages = new UIContainer({ name: "tab-pages" });
    this.pages.styleClass = "TabPages";
    this.insertChild(this.strip);
    this.insertChild(this.pages);
    this.strip.on("navigate", (e) => {
      if (e.direction !== "left" && e.direction !== "right") return;
      const cur = this.tabs.findIndex((t) => t.button.focused);
      if (cur < 0) return;
      e.preventDefault();
      const next = (cur + (e.direction === "right" ? 1 : -1) + this.tabs.length) % this.tabs.length;
      this.selectedIndex = next;
      this.tabs[next]!.button.focus(true);
    });
    this.on("navigate", (e) => {
      if (e.direction !== "pagenext" && e.direction !== "pageprevious") return;
      if (this.tabs.length === 0) return;
      e.preventDefault();
      this.selectedIndex = (this._selected + (e.direction === "pagenext" ? 1 : -1) + this.tabs.length) % this.tabs.length;
    });
  }

  /** Add a tab; returns its page container's child (the `content`). */
  addTab(title: string, content: UIElement, icon?: string): TabButton {
    const index = this.tabs.length;
    const button = new TabButton({ text: title, icon, onPress: () => (this.selectedIndex = index) });
    this.strip.add(button);
    content.visible = false;
    this.pages.add(content);
    this.tabs.push({ button, page: content });
    if (this._selected < 0) this.selectedIndex = 0;
    else this.syncTabOrder();
    return button;
  }

  get tabCount(): number {
    return this.tabs.length;
  }

  page(i: number): UIElement | null {
    return this.tabs[i]?.page ?? null;
  }

  get selectedIndex(): number {
    return this._selected;
  }
  set selectedIndex(i: number) {
    if (i < 0 || i >= this.tabs.length || i === this._selected) return;
    const prev = this.tabs[this._selected];
    if (prev) {
      prev.page.visible = false;
      prev.button.setStateBit(UIState.Selected, false);
    }
    this._selected = i;
    const cur = this.tabs[i]!;
    cur.page.visible = true;
    cur.button.setStateBit(UIState.Selected, true);
    this.accessibility.value = cur.button.text;
    this.syncTabOrder();
    this.onChange?.(i);
    this.emit(new UICustomEvent("change", { property: "selectedIndex", value: i }));
  }

  /** Only the selected tab is a Tab stop (arrow keys move within the strip). */
  private syncTabOrder(): void {
    this.tabs.forEach((t, k) => (t.button.tabIndex = k === this._selected ? 0 : -1));
  }

  protected override measureContent(availableWidth: number, availableHeight: number, ctx: LayoutContext): { width: number; height: number } {
    const a = this.strip.measure(availableWidth, availableHeight, ctx);
    const b = this.pages.measure(availableWidth, Math.max(0, availableHeight - a.height), ctx);
    return { width: Math.max(a.width, b.width), height: a.height + b.height };
  }

  protected override arrangeContent(content: UIRect, ctx: LayoutContext): void {
    const a = this.strip.measure(content.width, content.height, ctx);
    this.strip.arrange(new UIRect(content.x, content.y, content.width, a.height), ctx);
    this.pages.arrange(new UIRect(content.x, content.y + a.height, content.width, Math.max(0, content.height - a.height)), ctx);
  }
}

// ====================================================================== NavigationBar

export interface NavItem {
  id: string;
  label: string;
  icon?: string;
}

export class NavigationBar extends UIElement {
  static override styleName = "NavigationBar";
  private items: NavItem[];
  private _current: string | null;
  readonly row: Stack;
  readonly menuButton: IconButton;
  private readonly buttons = new Map<string, ToggleButton>();
  private drawer: Drawer | null = null;
  onNavigate: ((id: string) => void) | null;
  /** Breakpoints at which the bar collapses into the menu button. */
  collapseAt: readonly string[];

  constructor(options: UIContainerOptions & { items?: NavItem[]; current?: string; onNavigate?: (id: string) => void; collapseAt?: readonly string[]; title?: string } = {}) {
    super(options);
    this.items = options.items ?? [];
    this._current = options.current ?? this.items[0]?.id ?? null;
    this.onNavigate = options.onNavigate ?? null;
    this.collapseAt = options.collapseAt ?? ["compact"];
    this.accessibility.role = "navigation";
    this.row = new Stack({ direction: "row", gap: 4, align: "center" });
    this.menuButton = new IconButton({ icon: "menu", label: "Menu", onPress: () => this.openDrawer() });
    this.insertChild(this.row);
    this.insertChild(this.menuButton);
    this.rebuild();
  }

  get current(): string | null {
    return this._current;
  }
  set current(id: string | null) {
    if (id === this._current) return;
    this._current = id;
    for (const [k, b] of this.buttons) b.checked = k === id;
    this.emit(new UICustomEvent("change", { property: "current", value: id }));
  }

  setItems(items: NavItem[]): void {
    this.items = items;
    this.rebuild();
  }

  private rebuild(): void {
    this.row.clear();
    this.buttons.clear();
    for (const item of this.items) {
      const b = new ToggleButton({ text: item.label, icon: item.icon, checked: item.id === this._current, variant: "nav", onPress: () => this.navigate(item.id) });
      b.accessibility.role = "link";
      this.buttons.set(item.id, b);
      this.row.add(b);
    }
  }

  private navigate(id: string): void {
    this.current = id;
    for (const [k, b] of this.buttons) b.checked = k === id;
    this.onNavigate?.(id);
    this.drawer?.close();
  }

  /** True when the bar shows the menu button instead of the items. */
  get collapsed(): boolean {
    return this.context ? this.collapseAt.includes(this.context.breakpoint) : false;
  }

  private openDrawer(): void {
    const ctx: UIContext | null = this.context;
    if (!ctx) return;
    if (!this.drawer || this.drawer.disposed) {
      this.drawer = new Drawer({ title: "Navigate" });
      for (const item of this.items) this.drawer.add(new Button({ text: item.label, icon: item.icon, variant: "ghost", onPress: () => this.navigate(item.id) }));
    }
    this.drawer.open(ctx);
  }

  protected override measureContent(availableWidth: number, availableHeight: number, ctx: LayoutContext): { width: number; height: number } {
    this.applyCollapse();
    const target = this.collapsed ? this.menuButton : this.row;
    return target.measure(availableWidth, availableHeight, ctx);
  }

  private applyCollapse(): void {
    const c = this.collapsed;
    if (this.row.visible === c) this.row.visible = !c;
    if (this.menuButton.visible !== c) this.menuButton.visible = c;
  }

  protected override arrangeContent(content: UIRect, ctx: LayoutContext): void {
    this.applyCollapse();
    const target = this.collapsed ? this.menuButton : this.row;
    const s = target.measure(content.width, content.height, ctx);
    target.arrange(new UIRect(content.x, content.y + (content.height - s.height) / 2, this.collapsed ? s.width : content.width, s.height), ctx);
  }

  protected override onDispose(): void {
    this.drawer?.dispose();
  }
}

// ====================================================================== Breadcrumbs

export class Breadcrumbs extends Stack {
  static override styleName = "Breadcrumbs";
  private path: { label: string; id: string }[] = [];
  onNavigate: ((id: string, index: number) => void) | null;
  separator: string;

  constructor(options: UIContainerOptions & { path?: { label: string; id: string }[]; separator?: string; onNavigate?: (id: string, index: number) => void } = {}) {
    super({ ...options, direction: "row", gap: 4, align: "center" });
    this.onNavigate = options.onNavigate ?? null;
    this.separator = options.separator ?? "»";
    this.accessibility.role = "navigation";
    this.setPath(options.path ?? []);
  }

  setPath(path: { label: string; id: string }[]): void {
    this.path = path;
    this.clear();
    path.forEach((seg, i) => {
      if (i > 0) this.add(new Label({ text: this.separator, variant: "muted" }));
      const last = i === path.length - 1;
      const b = new Button({ text: seg.label, variant: last ? "crumb-current" : "crumb", onPress: () => this.onNavigate?.(seg.id, i) });
      b.accessibility.role = "link";
      if (last) b.accessibility.value = "current";
      this.add(b);
    });
  }

  get segments(): readonly { label: string; id: string }[] {
    return this.path;
  }
}

// ====================================================================== MenuBar

export interface MenuDef {
  label: string;
  items: MenuItemDef[];
}

export class MenuBar extends Stack {
  static override styleName = "MenuBar";
  private readonly titles: Button[] = [];
  private readonly menus: ContextMenu[] = [];
  private openIndex = -1;

  constructor(options: UIContainerOptions & { menus?: MenuDef[] } = {}) {
    super({ ...options, direction: "row", gap: 0, align: "center" });
    this.pointerEvents = "auto";
    this.accessibility.role = "menubar";
    for (const m of options.menus ?? []) this.addMenu(m);
  }

  addMenu(def: MenuDef): void {
    const index = this.titles.length;
    const title = new Button({ text: def.label, variant: "menu", onPress: (src) => this.toggle(index, src) });
    title.accessibility.role = "menuitem";
    title.on("pointerenter", () => {
      if (this.openIndex >= 0 && this.openIndex !== index) this.openMenu(index, "pointer");
    });
    const menu = new ContextMenu({ items: def.items, placement: "below" });
    menu.on("navigate", (e) => {
      if (e.direction === "left" || e.direction === "right") {
        const focusedItem = menu.menuItems.find((i) => i.focused);
        if (e.direction === "right" && focusedItem?.def.items) return; // submenu handles it
        e.preventDefault();
        const next = (index + (e.direction === "right" ? 1 : -1) + this.titles.length) % this.titles.length;
        this.openMenu(next, "keyboard");
      }
    }, { capture: true });
    menu.on("close", () => {
      if (this.openIndex === index) {
        this.openIndex = -1;
        title.setStateBit(UIState.Expanded, false);
      }
    });
    this.titles.push(title);
    this.menus.push(menu);
    this.add(title);
  }

  get openMenuIndex(): number {
    return this.openIndex;
  }

  private toggle(index: number, source: InputSource): void {
    if (this.openIndex === index) this.menus[index]!.close();
    else this.openMenu(index, source);
  }

  openMenu(index: number, source: InputSource = "program"): void {
    const ctx = this.context;
    if (!ctx) return;
    if (this.openIndex >= 0 && this.openIndex !== index) this.menus[this.openIndex]!.close();
    this.openIndex = index;
    const menu = this.menus[index]!;
    this.titles[index]!.setStateBit(UIState.Expanded, true);
    if (!menu.isOpen) menu.openAt(ctx, this.titles[index]!, "below");
    if (source !== "pointer") menu.focusFirst();
  }

  protected override onDispose(): void {
    for (const m of this.menus) m.dispose();
  }
}

// ====================================================================== CommandPalette

export interface Command {
  id: string;
  label: string;
  shortcut?: string;
  run: () => void;
}

/** Subsequence fuzzy score (higher is better; −1 = no match). Contiguous and word-start hits score more. */
export function fuzzyScore(query: string, text: string): number {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (!q) return 0;
  let score = 0;
  let ti = 0;
  let prev = -2;
  for (const ch of q) {
    const at = t.indexOf(ch, ti);
    if (at < 0) return -1;
    score += 1;
    if (at === prev + 1) score += 2;
    if (at === 0 || t[at - 1] === " " || t[at - 1] === "-" || t[at - 1] === ".") score += 3;
    prev = at;
    ti = at + 1;
  }
  return score - t.length * 0.01;
}

export class CommandPalette extends ModalDialog {
  static override styleName = "CommandPalette";
  private commands: Command[];
  readonly input: TextInput;
  readonly results: ListBox;
  private shown: Command[] = [];

  constructor(options: UIContainerOptions & { commands?: Command[]; placeholder?: string } = {}) {
    super({ ...options, title: "", width: 460 });
    this.commands = options.commands ?? [];
    this.input = this.add(new TextInput({ placeholder: options.placeholder ?? "Type a command…" }));
    this.input.setLayout({ alignSelf: "stretch" });
    this.results = this.add(new ListBox({ onActivateItem: (i) => this.run(i) }));
    this.results.focusable = false;
    this.results.setLayout({ height: 260, alignSelf: "stretch" });
    this.input.on("change", () => this.refresh());
    this.input.on("keydown", (e: UIKeyEvent) => {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        this.results.active = Math.max(0, Math.min(this.shown.length - 1, this.results.active + (e.key === "ArrowDown" ? 1 : -1)));
        e.preventDefault();
      } else if (e.key === "Enter") {
        this.run(this.results.active);
        e.stopImmediatePropagation();
        e.preventDefault();
      }
    }, { capture: true });
    this.refresh();
  }

  setCommands(commands: Command[]): void {
    this.commands = commands;
    this.refresh();
  }

  /** Commands matching the current query, best first. */
  get matches(): readonly Command[] {
    return this.shown;
  }

  private refresh(): void {
    const q = this.input.value;
    this.shown = this.commands
      .map((c) => ({ c, s: fuzzyScore(q, c.label) }))
      .filter((x) => x.s >= 0)
      .sort((a, b) => b.s - a.s)
      .map((x) => x.c);
    this.results.setItems(this.shown.map((c) => ({ label: c.shortcut ? `${c.label}   ${c.shortcut}` : c.label, value: c.id })));
    this.results.active = this.shown.length > 0 ? 0 : -1;
  }

  /** Open with an empty query and focus in the input. */
  show(ctx: { overlays: UIContext["overlays"]; focus: UIContext["focus"] }): void {
    this.input.value = "";
    this.refresh();
    this.open(ctx, this.input);
  }

  private run(i: number): void {
    const cmd = this.shown[i];
    if (!cmd) return;
    this.close(cmd.id);
    cmd.run();
  }
}
