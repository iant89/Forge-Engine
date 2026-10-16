/**
 * Collections: virtualized list/grid, list box, tree view, dropdown and combo box.
 *
 * **Virtualization.** `VirtualizedList` and `VirtualizedGrid` instantiate only the rows (cells)
 * that intersect the viewport plus `overscan`, and *recycle* them while scrolling: an element that
 * scrolls off one edge is re-bound to the index entering at the other, so scrolling creates no
 * elements and does not re-measure anything outside the list. Elements are created by the app's
 * `createItem()` and filled by `bindItem(el, item, index)`; the pool grows only when the viewport
 * gets taller. Row height is fixed (`itemExtent`) — variable-height virtualization needs per-item
 * measurement of the whole list and is a documented limitation.
 *
 * `ListBox` (alias `SelectableList`) is a virtualized list with single/multiple selection, a roving
 * active row, Up/Down/Home/End/PageUp/PageDown, Shift/Ctrl extension, type-ahead, and `change`/
 * `select` events. `TreeView` flattens expanded nodes into rows with Left/Right collapse/expand.
 */

import { UIElement, type UIElementOptions } from "../core/element.js";
import { UIRect } from "../core/geometry.js";
import type { UIContext } from "../core/context.js";
import type { LayoutContext } from "../layout/types.js";
import type { ResolvedStyle } from "../style/types.js";
import { UIState } from "../style/types.js";
import type { UIPainter } from "../render/painter.js";
import { withAlpha } from "../core/color.js";
import { UICustomEvent, type InputSource, type UIKeyEvent, type UIPointerEvent } from "../input/events.js";
import { ScrollModel, SelectionModel, TextPart, UIControl, attachScrolling, type UIControlOptions } from "./base.js";
import { paintIcon } from "./display.js";
import { Popup } from "./overlays.js";
import { TextInput, type TextInputOptions } from "./textInput.js";

// ====================================================================== virtualization core

export interface VirtualizedOptions<T> extends UIElementOptions {
  items?: readonly T[];
  createItem: () => UIElement;
  bindItem: (el: UIElement, item: T, index: number) => void;
  /** Extra rows instantiated beyond each edge of the viewport. */
  overscan?: number;
  /** After an element was (re)bound to an index (selection styling, etc.). */
  onBound?: (el: UIElement, index: number) => void;
}

abstract class VirtualizedBase<T> extends UIElement {
  readonly scroll = new ScrollModel(false, true);
  protected itemsList: readonly T[];
  protected readonly createItem: () => UIElement;
  protected readonly bindItem: (el: UIElement, item: T, index: number) => void;
  overscan: number;
  /** element → bound index (−1 = parked). */
  private readonly boundIndex = new Map<UIElement, number>();
  private readonly pool: UIElement[] = [];
  private dataVersion = 0;
  private readonly boundVersion = new Map<UIElement, number>();
  /** Items bound since creation (tests/benchmarks: recycling keeps this low). */
  binds = 0;
  readonly view = new UIRect();
  private readonly boundCallback: ((el: UIElement, index: number) => void) | null;

  constructor(options: VirtualizedOptions<T>) {
    super(options);
    this.itemsList = options.items ?? [];
    this.createItem = options.createItem;
    this.bindItem = options.bindItem;
    this.overscan = options.overscan ?? 2;
    this.boundCallback = options.onBound ?? null;
    this.clipChildren = true;
    for (const d of attachScrolling(this, this.scroll, () => this.relayout())) this.own(d);
  }

  get items(): readonly T[] {
    return this.itemsList;
  }

  /** Replace the data (all visible rows re-bind). */
  setItems(items: readonly T[]): void {
    this.itemsList = items;
    this.dataVersion++;
    this.onItemsChanged();
    this.invalidateLayout();
  }

  /** Re-bind visible rows after mutating items in place. */
  refresh(): void {
    this.dataVersion++;
    this.relayout();
  }

  protected onItemsChanged(): void {}

  get count(): number {
    return this.itemsList.length;
  }

  /** Elements currently instantiated (visible + parked). */
  get instantiated(): number {
    return this.pool.length;
  }

  get scrollY(): number {
    return this.scroll.y;
  }
  set scrollY(v: number) {
    if (this.scroll.set(0, v)) this.relayout();
  }

  protected relayout(): void {
    this._arrangeDirty = true;
    for (let p = this.parent; p; p = p.parent) p._subtreeDirty = true;
    this.context?.markLayoutDirty(this);
    this.invalidateRender();
  }

  /** Element currently showing `index`, if instantiated. */
  elementAt(index: number): UIElement | null {
    for (const [el, i] of this.boundIndex) if (i === index) return el;
    return null;
  }

  indexOf(el: UIElement): number {
    for (let e: UIElement | null = el; e; e = e.parent) {
      const i = this.boundIndex.get(e);
      if (i !== undefined) return i;
    }
    return -1;
  }

  /** Total content height for the current width. */
  protected abstract contentHeight(width: number): number;
  /** Visible index range for a scroll window. */
  protected abstract range(width: number, top: number, bottom: number): [number, number];
  /** Rect of an index in content space (y relative to content top). */
  protected abstract itemRect(index: number, width: number, out: UIRect): UIRect;

  protected override measureContent(availableWidth: number, availableHeight: number): { width: number; height: number } {
    const h = this.contentHeight(Number.isFinite(availableWidth) ? availableWidth : 320);
    return { width: Number.isFinite(availableWidth) ? availableWidth : 320, height: Math.min(h, Number.isFinite(availableHeight) ? availableHeight : h) };
  }

  protected override arrangeContent(content: UIRect, ctx: LayoutContext): void {
    this.view.copy(content);
    const m = this.scroll;
    m.viewportWidth = content.width;
    m.viewportHeight = content.height;
    m.contentWidth = content.width;
    m.contentHeight = this.contentHeight(content.width);
    m.set(0, m.y);
    const n = this.itemsList.length;
    let [first, last] = n === 0 ? [0, -1] : this.range(content.width, m.y, m.y + content.height);
    first = Math.max(0, first - this.overscan);
    last = Math.min(n - 1, last + this.overscan);
    const needed = Math.max(0, last - first + 1);
    // Grow the pool (only when the viewport needs more rows than ever before).
    while (this.pool.length < needed) {
      const el = this.createItem();
      this.pool.push(el);
      this.boundIndex.set(el, -1);
      this.insertChild(el);
    }
    // Keep elements already showing an index in range; recycle the rest.
    const free: UIElement[] = [];
    const showing = new Map<number, UIElement>();
    for (const el of this.pool) {
      const i = this.boundIndex.get(el)!;
      if (i >= first && i <= last && !showing.has(i)) showing.set(i, el);
      else free.push(el);
    }
    const r = new UIRect();
    for (let i = first; i <= last; i++) {
      let el = showing.get(i);
      if (!el) {
        el = free.pop()!;
        this.boundIndex.set(el, i);
      }
      if (this.boundVersion.get(el) !== this.dataVersion || !showing.has(i)) {
        this.bindItem(el, this.itemsList[i]!, i);
        this.boundVersion.set(el, this.dataVersion);
        this.binds++;
        this.boundCallback?.(el, i);
      }
      if (!el.visible) el.visible = true;
      this.itemRect(i, content.width, r);
      el.arrange(r.set(content.x + r.x, content.y + r.y - m.y, r.width, r.height), ctx);
    }
    for (const el of free) {
      this.boundIndex.set(el, -1);
      if (el.visible) el.visible = false;
    }
  }

  /** Scroll so `index` is fully visible. */
  scrollToIndex(index: number): void {
    const r = this.itemRect(index, this.view.width || 320, new UIRect());
    if (this.scroll.reveal("y", r.y, r.y + r.height)) this.relayout();
  }

  protected override paintOverlay(p: UIPainter, s: ResolvedStyle): void {
    const m = this.scroll;
    if (m.maxY <= 0) return;
    const b = this.bounds;
    const len = Math.max(24, (b.height * m.viewportHeight) / m.contentHeight);
    const y = b.y + (m.y / m.maxY) * (b.height - len);
    p.fillRect(b.right - 8, y, 6, len, withAlpha(s.foreground, 0.35), 3);
  }
}

export class VirtualizedList<T = unknown> extends VirtualizedBase<T> {
  static override styleName = "VirtualizedList";
  itemExtent: number;
  gap: number;

  constructor(options: VirtualizedOptions<T> & { itemExtent?: number; gap?: number }) {
    super(options);
    this.itemExtent = options.itemExtent ?? 28;
    this.gap = options.gap ?? 0;
    this.accessibility.role = "list";
  }

  protected contentHeight(): number {
    const n = this.itemsList.length;
    return n === 0 ? 0 : n * this.itemExtent + (n - 1) * this.gap;
  }

  protected range(_w: number, top: number, bottom: number): [number, number] {
    const stride = this.itemExtent + this.gap;
    // `bottom` is exclusive: the last row is the one containing the pixel just above it.
    return [Math.max(0, Math.floor(top / stride)), Math.min(this.itemsList.length - 1, Math.ceil(bottom / stride) - 1)];
  }

  protected itemRect(index: number, width: number, out: UIRect): UIRect {
    return out.set(0, index * (this.itemExtent + this.gap), width, this.itemExtent);
  }
}

export class VirtualizedGrid<T = unknown> extends VirtualizedBase<T> {
  static override styleName = "VirtualizedGrid";
  cellWidth: number;
  cellHeight: number;
  gap: number;

  constructor(options: VirtualizedOptions<T> & { cellWidth?: number; cellHeight?: number; gap?: number }) {
    super(options);
    this.cellWidth = options.cellWidth ?? 64;
    this.cellHeight = options.cellHeight ?? this.cellWidth;
    this.gap = options.gap ?? 4;
    this.accessibility.role = "grid";
  }

  /** Columns that fit the current width (≥ 1). */
  columnsFor(width: number): number {
    return Math.max(1, Math.floor((width + this.gap) / (this.cellWidth + this.gap)));
  }

  get columns(): number {
    return this.columnsFor(this.view.width || this.cellWidth);
  }

  protected contentHeight(width: number): number {
    const rows = Math.ceil(this.itemsList.length / this.columnsFor(width));
    return rows === 0 ? 0 : rows * this.cellHeight + (rows - 1) * this.gap;
  }

  protected range(width: number, top: number, bottom: number): [number, number] {
    const cols = this.columnsFor(width);
    const stride = this.cellHeight + this.gap;
    const r0 = Math.max(0, Math.floor(top / stride));
    const r1 = Math.ceil(bottom / stride) - 1; // `bottom` is exclusive
    return [r0 * cols, Math.min(this.itemsList.length - 1, (r1 + 1) * cols - 1)];
  }

  protected itemRect(index: number, width: number, out: UIRect): UIRect {
    const cols = this.columnsFor(width);
    return out.set((index % cols) * (this.cellWidth + this.gap), Math.floor(index / cols) * (this.cellHeight + this.gap), this.cellWidth, this.cellHeight);
  }

  protected override measureContent(availableWidth: number, availableHeight: number): { width: number; height: number } {
    const w = Number.isFinite(availableWidth) ? availableWidth : this.cellWidth * 4 + this.gap * 3;
    const h = this.contentHeight(w);
    return { width: w, height: Math.min(h, Number.isFinite(availableHeight) ? availableHeight : h) };
  }
}

// ====================================================================== ListBox

export interface ListItemData {
  label: string;
  value?: unknown;
  icon?: string;
  disabled?: boolean;
  description?: string;
}

export type ListItemInput = string | ListItemData;

export function toItemData(i: ListItemInput): ListItemData {
  return typeof i === "string" ? { label: i, value: i } : i;
}

/** A row of a ListBox / Dropdown / TreeView (not focusable: the list owns focus). */
export class ListItem extends UIElement {
  static override styleName = "ListItem";
  readonly label = new TextPart("", { overflow: "ellipsis" });
  icon: string | null = null;
  indent = 0;
  disclosure: "none" | "open" | "closed" = "none";
  active = false;

  constructor() {
    super({ accessibility: { role: "option" } });
  }

  setData(d: ListItemData): void {
    if (this.label.set(d.label)) this.invalidateRender();
    this.icon = d.icon ?? null;
    this.accessibility.label = d.label;
    this.enabled = !d.disabled;
    this.invalidateRender();
  }

  protected override paintContent(p: UIPainter, s: ResolvedStyle): void {
    const c = this.contentRect;
    let x = c.x + this.indent;
    const ctx = this.context;
    if (this.disclosure !== "none" && ctx) {
      const g = ctx.text.layout({ text: this.disclosure === "open" ? "▼" : "▶", family: "default", size: s.fontSize * 0.6 });
      p.text(g, x + (s.iconSize - g.width) / 2, c.y + (c.height - g.height) / 2, withAlpha(s.foreground, 0.7));
    }
    if (this.disclosure !== "none" || this.indent > 0) x += s.iconSize;
    if (this.icon) {
      paintIcon(ctx, p, this.icon, x, c.y + (c.height - s.iconSize) / 2, s.iconSize, s.foreground);
      x += s.iconSize + s.spacing;
    }
    this.label.paint(p, this.label.layout(ctx, s, Math.max(0, c.right - x)), x, c.y, Math.max(0, c.right - x), c.height, s.foreground, "start");
    if (this.active && ctx?.focus.focusVisible && this.parent?.focused) p.strokeRect(this.bounds.x + 1, this.bounds.y + 1, this.bounds.width - 2, this.bounds.height - 2, s.accent, 1.5, s.radius.topLeft);
  }
}

export interface ListBoxOptions extends UIControlOptions {
  items?: readonly ListItemInput[];
  selection?: "single" | "multiple" | "none";
  selectedIndex?: number;
  itemExtent?: number;
  onChange?: (indices: readonly number[]) => void;
  /** Enter / double-click / click in single mode. */
  onActivateItem?: (index: number, item: ListItemData) => void;
}

/** Selectable, virtualized list (also registered as `SelectableList`). */
export class ListBox extends UIControl {
  static override styleName = "ListBox";
  readonly list: VirtualizedList<ListItemData>;
  readonly selection: SelectionModel;
  private _active = -1;
  private typeahead = "";
  private typeaheadTime = -10;
  private readonly onChangeCallback: ((indices: readonly number[]) => void) | null;
  private readonly onActivateItem: ((index: number, item: ListItemData) => void) | null;

  constructor(options: ListBoxOptions = {}) {
    super(options);
    this.accessibility.role = "listbox";
    this.selection = new SelectionModel(options.selection ?? "single");
    this.onChangeCallback = options.onChange ?? null;
    this.onActivateItem = options.onActivateItem ?? null;
    this.list = new VirtualizedList<ListItemData>({
      items: (options.items ?? []).map(toItemData),
      itemExtent: options.itemExtent ?? 30,
      createItem: () => new ListItem(),
      bindItem: (el, item) => (el as ListItem).setData(item),
      onBound: (el, i) => this.syncRow(el as ListItem, i),
    });
    this.insertChild(this.list);
    this.selection.onChange = (sel) => {
      for (let i = 0; i < this.list.count; i++) {
        const el = this.list.elementAt(i);
        if (el) this.syncRow(el as ListItem, i);
      }
      this.accessibility.value = sel.map((i) => this.list.items[i]?.label ?? "").join(", ");
      this.onChangeCallback?.(sel);
      this.emitChange("selectedIndex", this.selection.index);
    };
    if (options.selectedIndex !== undefined && options.selectedIndex >= 0) {
      this.selection.select(options.selectedIndex);
      this._active = options.selectedIndex;
    }
    this.on("click", (e: UIPointerEvent) => {
      const i = this.list.indexOf(e.target!);
      if (i < 0 || this.list.items[i]?.disabled) return;
      this.active = i;
      this.selection.select(i, { toggle: e.modifiers.ctrl || e.modifiers.meta, extend: e.modifiers.shift });
      if (this.selection.mode === "single") this.activateItem(i);
    });
    this.on("navigate", (e) => {
      if (e.direction !== "up" && e.direction !== "down") return;
      const next = this.nextEnabled(this._active, e.direction === "down" ? 1 : -1);
      if (next === this._active || next < 0) return;
      e.preventDefault();
      this.moveActive(next, e.modifiers.shift);
    });
    this.on("keydown", (e: UIKeyEvent) => this.onKey(e));
  }

  /** Activation (Enter on the active row) is handled here, not as a button press. */
  protected override onPress(source: InputSource): void {
    if (source === "pointer") return;
    if (this._active >= 0) {
      if (this.selection.mode === "multiple") this.selection.select(this._active, { toggle: true });
      else this.selection.select(this._active);
      this.activateItem(this._active);
    }
  }

  private activateItem(i: number): void {
    const item = this.list.items[i];
    if (!item) return;
    this.onActivateItem?.(i, item);
    this.emit(new UICustomEvent("select", { index: i, item }));
  }

  private onKey(e: UIKeyEvent): void {
    const n = this.list.count;
    if (n === 0) return;
    const page = Math.max(1, Math.floor(this.list.view.height / this.list.itemExtent) - 1);
    let target = -1;
    switch (e.key) {
      case "Home":
        target = this.nextEnabled(-1, 1);
        break;
      case "End":
        target = this.nextEnabled(n, -1);
        break;
      case "PageDown":
        target = Math.min(n - 1, this._active + page);
        break;
      case "PageUp":
        target = Math.max(0, this._active - page);
        break;
      default:
        if (e.key.length === 1 && !e.modifiers.ctrl && !e.modifiers.meta && e.key !== " ") {
          const ctx = this.context;
          const now = ctx?.time ?? 0;
          this.typeahead = now - this.typeaheadTime > 0.8 ? e.key.toLowerCase() : this.typeahead + e.key.toLowerCase();
          this.typeaheadTime = now;
          for (let k = 0; k < n; k++) {
            const i = (Math.max(0, this._active) + (this.typeahead.length === 1 ? 1 : 0) + k) % n;
            if (this.list.items[i]!.label.toLowerCase().startsWith(this.typeahead) && !this.list.items[i]!.disabled) {
              target = i;
              break;
            }
          }
          if (target < 0) return;
        } else return;
    }
    e.preventDefault();
    if (target >= 0) this.moveActive(target, e.modifiers.shift);
  }

  private nextEnabled(from: number, dir: 1 | -1): number {
    const n = this.list.count;
    for (let i = from + dir; i >= 0 && i < n; i += dir) if (!this.list.items[i]!.disabled) return i;
    return from >= 0 && from < n ? from : -1;
  }

  private moveActive(i: number, extend: boolean): void {
    this.active = i;
    if (this.selection.mode === "single") this.selection.select(i);
    else if (extend) this.selection.select(i, { extend: true });
  }

  get active(): number {
    return this._active;
  }
  set active(i: number) {
    const prev = this._active;
    this._active = Math.max(-1, Math.min(this.list.count - 1, i));
    for (const k of [prev, this._active]) {
      const el = this.list.elementAt(k);
      if (el) this.syncRow(el as ListItem, k);
    }
    if (this._active >= 0) this.list.scrollToIndex(this._active);
  }

  private syncRow(row: ListItem, i: number): void {
    row.setStateBit(UIState.Selected, this.selection.has(i));
    row.active = i === this._active;
    row.invalidateRender();
  }

  get items(): readonly ListItemData[] {
    return this.list.items;
  }
  setItems(items: readonly ListItemInput[]): void {
    this.list.setItems(items.map(toItemData));
    this.selection.clampTo(items.length);
    if (this._active >= items.length) this._active = items.length - 1;
  }

  get selectedIndex(): number {
    return this.selection.index;
  }
  set selectedIndex(i: number) {
    if (i < 0) this.selection.clear();
    else this.selection.select(i);
    this.active = i;
  }

  get selectedItem(): ListItemData | null {
    return this.list.items[this.selection.index] ?? null;
  }

  protected override measureContent(availableWidth: number, availableHeight: number, ctx: LayoutContext): { width: number; height: number } {
    const s = this.list.measure(availableWidth, availableHeight, ctx);
    let w = 0;
    const st = this.computedStyle;
    for (const it of this.list.items.slice(0, 200)) w = Math.max(w, this.context ? this.context.text.measure(it.label, "default", st.fontSize).width + 24 + (it.icon ? st.iconSize + st.spacing : 0) : 0);
    return { width: Math.min(availableWidth, Math.max(w, 120)), height: Math.min(s.height, 30 * 8) };
  }

  protected override arrangeContent(content: UIRect, ctx: LayoutContext): void {
    this.list.arrange(content, ctx);
  }
}

export const SelectableList = ListBox;

// ====================================================================== TreeView

export interface TreeNode {
  label: string;
  icon?: string;
  children?: TreeNode[];
  expanded?: boolean;
  data?: unknown;
}

interface TreeRow {
  node: TreeNode;
  depth: number;
  parent: number;
}

export class TreeView extends UIControl {
  static override styleName = "TreeView";
  private roots: TreeNode[];
  private rows: TreeRow[] = [];
  readonly list: VirtualizedList<TreeRow>;
  private _active = -1;
  private _selected: TreeNode | null = null;
  indentSize = 16;
  onSelect: ((node: TreeNode) => void) | null = null;

  constructor(options: UIControlOptions & { nodes?: TreeNode[]; itemExtent?: number; onSelect?: (node: TreeNode) => void } = {}) {
    super(options);
    this.accessibility.role = "tree";
    this.roots = options.nodes ?? [];
    this.onSelect = options.onSelect ?? null;
    this.list = new VirtualizedList<TreeRow>({
      itemExtent: options.itemExtent ?? 26,
      createItem: () => new ListItem(),
      bindItem: (el, row, i) => {
        const li = el as ListItem;
        li.setData({ label: row.node.label, icon: row.node.icon });
        li.indent = row.depth * this.indentSize;
        li.disclosure = row.node.children?.length ? (row.node.expanded ? "open" : "closed") : "none";
        li.accessibility.role = "treeitem";
        li.accessibility.value = row.node.children?.length ? (row.node.expanded ? "expanded" : "collapsed") : undefined;
        li.setStateBit(UIState.Selected, row.node === this._selected);
        li.active = i === this._active;
      },
    });
    this.insertChild(this.list);
    this.rebuild();
    this.on("click", (e: UIPointerEvent) => {
      const i = this.list.indexOf(e.target!);
      if (i < 0) return;
      const row = this.rows[i]!;
      const rowEl = this.list.elementAt(i);
      // Clicking the disclosure triangle toggles; clicking the label selects.
      if (rowEl && row.node.children?.length && e.x < rowEl.contentRect.x + row.depth * this.indentSize + 20) this.toggle(row.node);
      else this.select(i);
    });
    this.on("dblclick", (e: UIPointerEvent) => {
      const i = this.list.indexOf(e.target!);
      if (i >= 0 && this.rows[i]!.node.children?.length) this.toggle(this.rows[i]!.node);
    });
    this.on("navigate", (e) => {
      const row = this.rows[this._active];
      switch (e.direction) {
        case "up":
        case "down": {
          const next = this._active + (e.direction === "down" ? 1 : -1);
          if (next < 0 || next >= this.rows.length) return;
          e.preventDefault();
          this.setActive(next);
          return;
        }
        case "right":
          if (!row) return;
          e.preventDefault();
          if (row.node.children?.length && !row.node.expanded) this.toggle(row.node);
          else if (row.node.children?.length) this.setActive(this._active + 1);
          return;
        case "left":
          if (!row) return;
          e.preventDefault();
          if (row.node.expanded) this.toggle(row.node);
          else if (row.parent >= 0) this.setActive(row.parent);
          return;
        default:
      }
    });
  }

  protected override onPress(source: InputSource): void {
    if (source !== "pointer" && this._active >= 0) this.select(this._active);
  }

  setNodes(nodes: TreeNode[]): void {
    this.roots = nodes;
    this.rebuild();
  }

  /** Visible (expanded) rows, depth-first. */
  get visibleRows(): readonly { node: TreeNode; depth: number }[] {
    return this.rows;
  }

  private rebuild(): void {
    const rows: TreeRow[] = [];
    const visit = (n: TreeNode, depth: number, parent: number): void => {
      const index = rows.length;
      rows.push({ node: n, depth, parent });
      if (n.expanded && n.children) for (const c of n.children) visit(c, depth + 1, index);
    };
    for (const r of this.roots) visit(r, 0, -1);
    this.rows = rows;
    this.list.setItems(rows);
    if (this._active >= rows.length) this._active = rows.length - 1;
  }

  toggle(node: TreeNode): void {
    if (!node.children?.length) return;
    const activeNode = this.rows[this._active]?.node;
    node.expanded = !node.expanded;
    this.rebuild();
    if (activeNode) this._active = this.rows.findIndex((r) => r.node === activeNode);
    this.list.refresh();
    this.emit(new UICustomEvent("toggle", { node, expanded: node.expanded }));
  }

  private setActive(i: number): void {
    this._active = i;
    this.list.refresh();
    this.list.scrollToIndex(i);
  }

  select(i: number): void {
    const row = this.rows[i];
    if (!row) return;
    this._active = i;
    this._selected = row.node;
    this.list.refresh();
    this.onSelect?.(row.node);
    this.emit(new UICustomEvent("select", { node: row.node }));
  }

  get selected(): TreeNode | null {
    return this._selected;
  }

  protected override measureContent(availableWidth: number, availableHeight: number, ctx: LayoutContext): { width: number; height: number } {
    const s = this.list.measure(availableWidth, availableHeight, ctx);
    return { width: Math.min(availableWidth, 240), height: s.height };
  }

  protected override arrangeContent(content: UIRect, ctx: LayoutContext): void {
    this.list.arrange(content, ctx);
  }
}

// ====================================================================== Dropdown & ComboBox

export interface DropdownOptions extends UIControlOptions {
  items?: readonly ListItemInput[];
  selectedIndex?: number;
  placeholder?: string;
  onChange?: (index: number, item: ListItemData | null) => void;
}

/** A button showing the selected option; opens a list popup. */
export class Dropdown extends UIControl {
  static override styleName = "Dropdown";
  private _items: ListItemData[];
  private _selected: number;
  readonly label = new TextPart("", { overflow: "ellipsis" });
  placeholder: string;
  private popup: Popup | null = null;
  private listBox: ListBox | null = null;
  private readonly onChangeCallback: ((index: number, item: ListItemData | null) => void) | null;

  constructor(options: DropdownOptions = {}) {
    super(options);
    this._items = (options.items ?? []).map(toItemData);
    this._selected = options.selectedIndex ?? -1;
    this.placeholder = options.placeholder ?? "Select…";
    this.onChangeCallback = options.onChange ?? null;
    this.accessibility.role = "combobox";
    this.syncLabel();
    this.on("navigate", (e) => {
      if (e.direction === "down" && !this.isOpen) {
        e.preventDefault();
        this.open("keyboard");
      }
    });
  }

  get items(): readonly ListItemData[] {
    return this._items;
  }
  setItems(items: readonly ListItemInput[]): void {
    this._items = items.map(toItemData);
    if (this._selected >= this._items.length) this._selected = -1;
    this.listBox?.setItems(this._items);
    this.syncLabel();
  }

  get selectedIndex(): number {
    return this._selected;
  }
  set selectedIndex(i: number) {
    const c = i >= 0 && i < this._items.length ? i : -1;
    if (c === this._selected) return;
    this._selected = c;
    this.syncLabel();
    this.onChangeCallback?.(c, this._items[c] ?? null);
    this.emitChange("selectedIndex", c);
  }

  get value(): unknown {
    return this._items[this._selected]?.value ?? null;
  }

  get isOpen(): boolean {
    return this.popup?.isOpen ?? false;
  }

  private syncLabel(): void {
    const item = this._items[this._selected];
    this.label.set(item ? item.label : this.placeholder);
    this.accessibility.value = item?.label ?? "";
    this.setStateBit(UIState.Expanded, this.isOpen);
    this.invalidateLayout();
  }

  protected override onPress(source: InputSource): void {
    if (this.isOpen) this.close();
    else this.open(source);
  }

  open(source: InputSource = "program"): void {
    const ctx: UIContext | null = this.context;
    if (!ctx) return;
    if (!this.popup) {
      this.popup = new Popup({ name: "dropdown-popup" });
      this.listBox = new ListBox({
        items: this._items,
        selectedIndex: this._selected,
        onActivateItem: (i) => {
          this.selectedIndex = i;
          this.close();
          this.focus(source !== "pointer");
        },
      });
      this.listBox.setLayout({ maxHeight: 240 });
      this.popup.add(this.listBox);
      this.popup.on("close", () => this.syncLabel());
    } else {
      this.listBox!.setItems(this._items);
      this.listBox!.selectedIndex = this._selected;
    }
    this.popup.setLayout({ minWidth: this.bounds.width });
    this.popup.openAt(ctx, this, "below");
    this.listBox!.active = Math.max(0, this._selected);
    this.listBox!.focus(source !== "pointer");
    this.syncLabel();
  }

  close(): void {
    this.popup?.close();
    this.syncLabel();
  }

  protected override onDetach(): void {
    if (this.isOpen) this.popup?.close();
  }

  protected override onDispose(): void {
    this.popup?.dispose();
  }

  protected override measureContent(availableWidth: number): { width: number; height: number } {
    const s = this.computedStyle;
    let w = 0;
    const ctx = this.context;
    if (ctx) for (const it of [...this._items.slice(0, 100), { label: this.placeholder }]) w = Math.max(w, ctx.text.measure(it.label, "default", s.fontSize, s.fontWeight).width);
    const l = this.label.layout(ctx, s, Infinity);
    return { width: Math.min(availableWidth, w + s.spacing + s.iconSize), height: Math.max(l?.height ?? 0, s.iconSize) };
  }

  protected override paintContent(p: UIPainter, s: ResolvedStyle): void {
    const c = this.contentRect;
    const ctx = this.context;
    const color = this._selected < 0 ? withAlpha(s.foreground, 0.55) : s.foreground;
    this.label.paint(p, this.label.layout(ctx, s, c.width - s.iconSize - s.spacing), c.x, c.y, c.width - s.iconSize - s.spacing, c.height, color, "start");
    paintIcon(ctx, p, this.isOpen ? "triangle-up" : "triangle-down", c.right - s.iconSize, c.y + (c.height - s.iconSize) / 2, s.iconSize * 0.75, withAlpha(s.foreground, 0.7));
  }
}

/** A text field with a filtered suggestion list. */
export class ComboBox extends TextInput {
  static override styleName = "ComboBox";
  private suggestions: ListItemData[];
  private popup: Popup | null = null;
  private listBox: ListBox | null = null;
  /** Matching items for the current text. */
  filtered: ListItemData[] = [];
  onPick: ((item: ListItemData) => void) | null;

  constructor(options: TextInputOptions & { items?: readonly ListItemInput[]; onPick?: (item: ListItemData) => void } = {}) {
    super(options);
    this.suggestions = (options.items ?? []).map(toItemData);
    this.onPick = options.onPick ?? null;
    this.accessibility.role = "combobox";
    this.on("change", (e: UICustomEvent<{ property: string }>) => {
      if (e.target === this && e.detail.property === "value" && this.focused) this.updateSuggestions(true);
    });
    this.on("keydown", (e: UIKeyEvent) => {
      if (!this.popupOpen) {
        if (e.key === "ArrowDown") {
          this.updateSuggestions(true);
          e.preventDefault();
        }
        return;
      }
      const lb = this.listBox!;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        lb.active = Math.max(0, Math.min(this.filtered.length - 1, lb.active + (e.key === "ArrowDown" ? 1 : -1)));
        e.preventDefault();
      } else if (e.key === "Enter" && lb.active >= 0) {
        this.pick(lb.active);
        e.stopImmediatePropagation();
        e.preventDefault();
      } else if (e.key === "Escape") {
        this.popup?.close();
        e.preventDefault();
      }
    }, { capture: true });
    this.on("blur", () => {
      // Let a click on a suggestion land first (it re-focuses us).
      if (this.popupOpen && !this.listBox?.hasState(UIState.Pressed)) this.popup?.close();
    });
  }

  get popupOpen(): boolean {
    return this.popup?.isOpen ?? false;
  }

  setItems(items: readonly ListItemInput[]): void {
    this.suggestions = items.map(toItemData);
  }

  /** Case-insensitive substring filter; prefix matches first. */
  matches(text: string): ListItemData[] {
    const q = text.trim().toLowerCase();
    if (!q) return [...this.suggestions];
    const starts: ListItemData[] = [];
    const contains: ListItemData[] = [];
    for (const it of this.suggestions) {
      const l = it.label.toLowerCase();
      if (l.startsWith(q)) starts.push(it);
      else if (l.includes(q)) contains.push(it);
    }
    return [...starts, ...contains];
  }

  private updateSuggestions(open: boolean): void {
    this.filtered = this.matches(this.value);
    const ctx = this.context;
    if (!ctx) return;
    if (this.filtered.length === 0) {
      this.popup?.close();
      return;
    }
    if (!this.popup) {
      this.popup = new Popup({ name: "combobox-popup" });
      this.listBox = new ListBox({ onActivateItem: (i) => this.pick(i) });
      this.listBox.focusable = false;
      this.listBox.setLayout({ maxHeight: 200 });
      this.popup.add(this.listBox);
    }
    this.listBox!.setItems(this.filtered);
    this.listBox!.active = 0;
    if (open && !this.popupOpen) {
      this.popup.setLayout({ minWidth: this.bounds.width });
      this.popup.openAt(ctx, this, "below");
    }
  }

  private pick(i: number): void {
    const item = this.filtered[i];
    if (!item) return;
    this.value = item.label;
    this.setCaret(this.value.length);
    this.popup?.close();
    this.onPick?.(item);
    this.emit(new UICustomEvent("select", { item }));
  }

  protected override onDispose(): void {
    this.popup?.dispose();
  }
}
