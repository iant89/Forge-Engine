/**
 * The demo's **Inspector**: one floating, dockable window that browses the read-only Phase 21
 * diagnostic APIs — ECS, render graph, GPU resources, physics, terrain, particles, streaming and
 * environment — instead of leaving them reachable only from a console command.
 *
 * It is a shell, not a data source: `examples/src/diag/inspectorTabs.ts` adapts each snapshot into
 * rows and fields, and this file owns the chrome (it reuses `mountDebugPanel`, so it drags by its
 * title bar, resizes by its corner grip, collapses to a corner icon, docks to a viewport edge and
 * remembers its layout).
 *
 * Shapes that matter here:
 *  - **List on the left, detail on the right, summary on top.** Every one of the eight snapshots is
 *    the same shape once it is adapted: a few headline numbers, a bounded list of things, and a
 *    detail view of the one you picked. One shell therefore covers all eight tabs.
 *  - **Refresh is throttled and only happens while the panel is open**, and the list DOM is only
 *    rebuilt when the rows actually changed — otherwise a 2 Hz refresh would steal the user's scroll
 *    position and their selection every time a badge ticked over.
 *  - **Rows are keyed, and a selection survives a refresh by key.** The ECS list re-sorts and
 *    re-filters constantly; selecting by position would slide onto a different entity.
 *  - **Overlays are opt-in and drawn per frame by the host.** A tab can offer a debug-line overlay
 *    (physics wireframes, terrain chunk bounds, particle/emitter markers, sun/wind/bolt vectors);
 *    the panel only flips a flag — the demo's frame loop asks it what to draw, so nothing is drawn
 *    for a panel nobody opened.
 *  - **The copy button exports the whole tab as text**, so a report can leave the page.
 */

import { ICONS, mountDebugPanel, type DebugPanel, type DebugPanelOptions, type StorageLike } from "./debugPanel.js";
import { bounds, type Rect, type SnapEdges } from "./panelLayout.js";
import type { InspectorSource, InspectorTab } from "./inspectorTabs.js";

export interface InspectorField {
  label: string;
  value: string;
}

export interface InspectorSection {
  title?: string;
  fields: readonly InspectorField[];
}

export interface InspectorRow {
  /** Stable key: the selection follows it across refreshes, not the position. */
  key: string;
  label: string;
  /** Short right-aligned text — a count, a time, a state. */
  badge?: string;
  /**
   * The detail pane for this row, computed on demand: a list of 200 entities must not pay for 200
   * entity inspections on every 2 Hz refresh when only one of them is on screen.
   */
  detail?: () => readonly InspectorSection[];
}

export interface InspectorTabData {
  /** Headline numbers for the whole tab. */
  summary: readonly InspectorField[];
  rows: readonly InspectorRow[];
  /** Caveats worth reading: truncation, missing subsystems, no adapter. */
  notes: readonly string[];
}

export interface InspectorPanelOptions {
  /** An element from the page to host the panel; it is wrapped and moved into the floating chrome. */
  body: HTMLElement;
  /** Toolbar button that opens / closes the panel. */
  button?: HTMLElement | null;
  tabs: readonly InspectorTab[];
  /** Live engine access; called on every refresh, so it must not cache a stale scene. */
  source: () => InspectorSource;
  /** localStorage key for the layout. */
  storageKey?: string;
  storage?: StorageLike | null;
  /** Minimum ms between refreshes while the panel is open. Default 500. */
  refreshMs?: number;
  /** Rows rendered per tab; the snapshots are already bounded, this bounds the DOM. Default 300. */
  maxRows?: number;
  /** Controls the collapsed icon must not cover. */
  avoid?: string[];
  doc?: Document;
  win?: DebugPanelOptions["win"];
  now?: () => number;
}

export interface InspectorState {
  visible: boolean;
  tab: string;
  /** Row key currently selected, or null. */
  selected: string | null;
  rows: number;
  filter: string;
  /** Overlay keys currently switched on. */
  overlays: string[];
  /** Debug lines the last `drawOverlays()` pushed through the host sink, so a gate can see them. */
  drawn: number;
  refreshed: number;
}

export interface InspectorPanel {
  readonly ui: DebugPanel;
  readonly visible: boolean;
  setVisible(visible: boolean): void;
  toggle(): void;
  /** Refresh if the panel is open and `refreshMs` has elapsed. */
  tick(nowMs?: number): void;
  /** Draw every enabled overlay's debug lines through the host's sink (called once per frame). */
  drawOverlays(): number;
  state(): InspectorState;
  layout(): { visible: boolean; collapsed: boolean; rect: Rect; snap: SnapEdges | null };
  dispose(): void;
}

const ROW_HEIGHT_NOTE = "rows are capped: narrow the filter to see the rest";

export function mountInspectorPanel(options: InspectorPanelOptions): InspectorPanel {
  const doc = options.doc ?? document;
  const now = options.now ?? (() => performance.now());
  const refreshMs = options.refreshMs ?? 500;
  const maxRows = Math.max(1, options.maxRows ?? 300);
  const tabs = options.tabs.filter((tab) => !!tab);

  let visible = false;
  let disposed = false;
  /** Debug lines the last `drawOverlays()` pushed through the host sink. */
  let drawn = 0;
  let nextRefresh = 0;
  let refreshed = 0;
  let tabIndex = 0;
  let filter = "";
  let selected: string | null = null;
  /** What the list currently shows, so a refresh that changes nothing rebuilds nothing. */
  let signature = "";
  const rowKeys: string[] = [];
  const overlays = new Set<string>();

  // ---------------------------------------------------------------- chrome
  const el = <K extends keyof HTMLElementTagNameMap>(tag: K): HTMLElementTagNameMap[K] => doc.createElement(tag);
  const root = el("div");
  root.style.cssText = "display:flex;flex-direction:column;min-height:0;overflow:hidden;font:11px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;color:#dbeafe";
  const tabBar = el("div");
  tabBar.className = "fip-tabs";
  tabBar.style.cssText = "flex:0 0 auto;display:flex;flex-wrap:wrap;gap:2px;padding:4px 6px;border-bottom:1px solid rgb(56 189 248 / 0.25)";
  const toolRow = el("div");
  toolRow.className = "fip-tools";
  toolRow.style.cssText = "flex:0 0 auto;display:flex;align-items:center;gap:6px;padding:4px 6px;border-bottom:1px solid rgb(56 189 248 / 0.15)";
  const summaryRow = el("div");
  summaryRow.className = "fip-summary";
  summaryRow.style.cssText = "flex:0 0 auto;padding:4px 8px;color:#a7f3d0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis";
  const split = el("div");
  split.style.cssText = "flex:1 1 auto;display:flex;min-height:0";
  const list = el("div");
  list.className = "fip-list";
  list.style.cssText = "flex:1 1 45%;min-width:120px;overflow:auto;border-right:1px solid rgb(56 189 248 / 0.15)";
  list.setAttribute("tabindex", "0");
  list.setAttribute("role", "listbox");
  list.setAttribute("aria-label", "Inspector rows");
  const detail = el("pre");
  detail.className = "fip-detail";
  detail.style.cssText = "flex:1 1 55%;min-width:140px;margin:0;padding:6px 8px;overflow:auto;white-space:pre-wrap;word-break:break-word;color:#e2e8f0";
  const noteRow = el("div");
  noteRow.className = "fip-notes";
  noteRow.style.cssText = "flex:0 0 auto;max-height:34px;overflow:auto;padding:3px 8px;color:#fcd34d;border-top:1px solid rgb(56 189 248 / 0.15)";
  split.appendChild(list);
  split.appendChild(detail);
  root.append(tabBar, toolRow, summaryRow, split, noteRow);

  const filterInput = el("input");
  filterInput.type = "search";
  filterInput.style.cssText =
    "flex:1 1 auto;min-width:60px;background:rgb(2 6 12 / 0.9);color:#dbeafe;border:1px solid rgb(56 189 248 / 0.35);" +
    "border-radius:4px;padding:3px 6px;font:inherit";
  filterInput.setAttribute("aria-label", "Filter rows");
  filterInput.className = "fip-filter";
  const overlayLabel = el("label");
  overlayLabel.style.cssText = "flex:0 0 auto;display:flex;align-items:center;gap:4px;white-space:nowrap;color:#7dd3fc";
  const overlayBox = el("input");
  overlayBox.type = "checkbox";
  overlayBox.setAttribute("aria-label", "Draw this tab's debug overlay");
  overlayBox.className = "fip-overlay";
  overlayLabel.appendChild(overlayBox);
  const overlayText = el("span");
  overlayLabel.appendChild(overlayText);
  const countLabel = el("span");
  countLabel.style.cssText = "flex:0 0 auto;color:rgb(203 213 225 / 0.7)";
  toolRow.append(filterInput, overlayLabel, countLabel);

  const tabButtons = tabs.map((tab, index) => {
    const button = el("button");
    button.type = "button";
    button.textContent = tab.title;
    button.style.cssText =
      "background:transparent;color:#7dd3fc;border:1px solid rgb(56 189 248 / 0.25);border-radius:4px;" +
      "padding:3px 7px;font:inherit;cursor:pointer;touch-action:manipulation";
    button.addEventListener("click", () => {
      if (tabIndex === index) return;
      tabIndex = index;
      selected = null;
      signature = "";
      refresh(true);
    });
    return button;
  });
  for (const button of tabButtons) tabBar.appendChild(button);

  // ---------------------------------------------------------------- rendering
  let lastText = "";

  const activeTab = (): InspectorTab | null => tabs[tabIndex] ?? null;

  /** The row key rides on the element, so a reused node always selects the row it is showing. */
  const keyed = (element: HTMLElement): { key: string | null } => element as unknown as { key: string | null };

  const paintRow = (row: InspectorRow, node: HTMLElement | null): HTMLElement => {
    const element = node ?? el("div");
    if (!node) {
      element.style.cssText =
        "display:flex;gap:6px;align-items:baseline;padding:2px 8px;cursor:pointer;white-space:nowrap;" +
        "overflow:hidden;user-select:none";
      element.setAttribute("role", "option");
      // Resolve the key at click time: the node is reused for different rows as the list changes,
      // so a handler that captured its index would select whatever used to be there.
      element.addEventListener("click", () => select(keyed(element).key));
    }
    keyed(element).key = row.key;
    const on = row.key === selected;
    element.style.background = on ? "rgb(56 189 248 / 0.22)" : "transparent";
    element.style.color = on ? "#e0f2fe" : "#dbeafe";
    element.setAttribute("aria-selected", on ? "true" : "false");
    const labelText = `${row.label}`;
    const badgeText = row.badge ?? "";
    if (element.children.length === 2) {
      (element.children[0] as HTMLElement).textContent = labelText;
      (element.children[1] as HTMLElement).textContent = badgeText;
    } else {
      const label = el("span");
      label.style.cssText = "flex:1 1 auto;overflow:hidden;text-overflow:ellipsis";
      label.textContent = labelText;
      const badge = el("span");
      badge.style.cssText = "flex:0 0 auto;color:rgb(148 163 184 / 0.9)";
      badge.textContent = badgeText;
      element.append(label, badge);
    }
    return element;
  };

  const select = (key: string | null): void => {
    if (key === selected) return;
    selected = key;
    // Repaint selection only: rebuilding the list would throw away the scroll position.
    for (let i = 0; i < list.children.length; i++) {
      const node = list.children[i] as HTMLElement | undefined;
      if (!node) continue;
      const on = rowKeys[i] === key;
      node.style.background = on ? "rgb(56 189 248 / 0.22)" : "transparent";
      node.style.color = on ? "#e0f2fe" : "#dbeafe";
      node.setAttribute("aria-selected", on ? "true" : "false");
    }
    paintDetail();
  };

  /** The selected row's detail, recomputed only when the selection changes. */
  let detailKey: string | null = null;
  let detailSections: readonly InspectorSection[] = [];

  const paintDetail = (): void => {
    const row = rows.find((r) => r.key === selected);
    if (!row) {
      detailKey = null;
      detailSections = [];
      detail.textContent = rows.length > 0 ? "select a row" : "nothing to inspect";
      lastText = composeText();
      return;
    }
    if (detailKey !== row.key) {
      detailKey = row.key;
      detailSections = row.detail?.() ?? [];
    }
    const lines: string[] = [row.label];
    for (const section of detailSections) {
      if (section?.title) lines.push("", section.title);
      for (const field of section?.fields ?? []) lines.push(`  ${pad(field.label)} ${field.value}`);
    }
    detail.textContent = lines.join("\n");
    lastText = composeText();
  };

  const pad = (label: string): string => (label.length >= 22 ? `${label} ` : label.padEnd(22));

  let rows: readonly InspectorRow[] = [];
  let summary: readonly InspectorField[] = [];
  let notes: readonly string[] = [];

  const composeText = (): string => {
    const tab = activeTab();
    const head = [`inspector: ${tab?.title ?? "—"}${filter ? `  filter ${JSON.stringify(filter)}` : ""}`];
    if (summary.length > 0) head.push(summary.map((f) => `${f.label} ${f.value}`).join("  ·  "));
    const row = rows.find((r) => r.key === selected);
    const body: string[] = [];
    if (rows.length > 0) body.push(...rows.map((r) => `${r.key === selected ? ">" : " "} ${r.label}${r.badge ? `  ${r.badge}` : ""}`));
    if (row) {
      body.push("", `— ${row.label} —`);
      for (const section of row.detail?.() ?? []) {
        if (section?.title) body.push(section.title);
        for (const field of section?.fields ?? []) body.push(`  ${pad(field.label)} ${field.value}`);
      }
    }
    for (const note of notes) body.push("", note);
    return [...head, ...body].join("\n");
  };

  const refresh = (force = false): void => {
    const tab = activeTab();
    if (!tab) return;
    const source = options.source();
    let data: InspectorTabData;
    try {
      data = tab.load(source, filter);
    } catch (error) {
      data = {
        summary: [],
        rows: [],
        notes: [`this tab's snapshot failed: ${error instanceof Error ? error.message : String(error)}`],
      };
    }
    rows = data.rows.slice(0, maxRows);
    summary = data.summary;
    notes = data.notes;
    rowKeys.length = 0;
    for (const row of rows) rowKeys.push(row.key);

    // The selection survives by key; a row that is gone takes its selection with it.
    if (selected !== null && !rowKeys.includes(selected)) {
      selected = null;
      detailKey = null;
    }

    for (let i = 0; i < tabButtons.length; i++) {
      const button = tabButtons[i]!;
      const on = i === tabIndex;
      button.style.background = on ? "rgb(56 189 248 / 0.28)" : "transparent";
      button.style.color = on ? "#e0f2fe" : "#7dd3fc";
      button.setAttribute("aria-pressed", on ? "true" : "false");
    }
    summaryRow.textContent = summary.map((f) => `${f.label} ${f.value}`).join("  ·  ");
    const overlay = tab.overlay;
    overlayLabel.style.display = overlay ? "flex" : "none";
    if (overlay) {
      overlayText.textContent = overlay.label;
      overlayBox.checked = overlays.has(overlay.key);
    }
    countLabel.textContent = data.rows.length > rows.length ? `${rows.length}/${data.rows.length}` : `${rows.length}`;

    const next = `${tabIndex}\n${rows.map((r) => `${r.key}|${r.label}|${r.badge ?? ""}`).join("\n")}`;
    if (next !== signature || force) {
      signature = next;
      // `children` rather than `childElementCount` / `lastElementChild`: the row nodes are reused
      // so a 2 Hz refresh does not rebuild the list (and steal the scroll position) every time.
      const wanted = Math.min(rows.length, list.children.length);
      for (let i = 0; i < wanted; i++) paintRow(rows[i]!, list.children[i] as HTMLElement);
      for (let i = wanted; i < rows.length; i++) list.appendChild(paintRow(rows[i]!, null));
      while (list.children.length > rows.length) list.removeChild(list.children[list.children.length - 1] as HTMLElement);
    }
    noteRow.textContent = notes.join(" · ");
    paintDetail();
    refreshed++;
  };

  const move = (delta: number): void => {
    if (rows.length === 0) return;
    const at = selected === null ? -1 : rowKeys.indexOf(selected);
    const next = Math.max(0, Math.min(rows.length - 1, at + delta));
    select(rowKeys[next] ?? null);
  };

  filterInput.addEventListener("input", () => {
    filter = filterInput.value ?? "";
    selected = null;
    signature = "";
    refresh(true);
  });
  list.addEventListener("keydown", (event) => {
    const key = (event as KeyboardEvent).key;
    if (key === "ArrowDown") {
      move(1);
      (event as { preventDefault?: () => void }).preventDefault?.();
    } else if (key === "ArrowUp") {
      move(-1);
      (event as { preventDefault?: () => void }).preventDefault?.();
    }
  });
  overlayBox.addEventListener("change", () => {
    const tab = activeTab();
    const overlay = tab?.overlay;
    if (!overlay) return;
    if (overlayBox.checked) overlays.add(overlay.key);
    else overlays.delete(overlay.key);
  });

  // ---------------------------------------------------------------- floating chrome
  const syncButton = (open: boolean): void => {
    const button = options.button;
    if (!button) return;
    button.classList.toggle("active", open);
    button.setAttribute("aria-pressed", open ? "true" : "false");
  };
  const paint = (): void => {
    refresh(true);
  };
  const open = (): void => {
    visible = true;
    syncButton(true);
    paint();
    nextRefresh = now() + refreshMs;
  };
  const close = (): void => {
    visible = false;
    syncButton(false);
  };

  options.body.parentNode?.insertBefore(root, options.body);
  const ui = mountDebugPanel({
    body: root,
    title: "inspector",
    barEdge: "top",
    getText: () => lastText,
    storageKey: options.storageKey ?? "forge.panel.inspector",
    defaultRect: (vp) => {
      const b = bounds(vp);
      const narrow = vp.w <= 820;
      const h = Math.min(narrow ? 280 : 380, Math.round(vp.h * 0.6));
      return { x: b.r - Math.min(narrow ? b.w - 20 : 620, b.w), y: b.t, w: Math.min(narrow ? b.w - 20 : 620, b.w), h };
    },
    minSize: { w: 320, h: 200 },
    iconCorner: "bottom-right",
    iconSvg: ICONS.bug,
    avoid: options.avoid,
    defaultCollapsed: true,
    storage: options.storage,
    doc,
    win: options.win,
    now,
    onCollapsedChange: (collapsed) => (collapsed ? close() : open()),
  });

  if (ui.collapsed) close();
  else open();

  const setVisible = (next: boolean): void => {
    if (next === visible) return;
    ui.setCollapsed(!next);
  };
  options.button?.addEventListener("click", () => setVisible(!visible));

  return {
    ui,
    get visible() {
      return visible;
    },
    setVisible,
    toggle: () => setVisible(!visible),
    tick(nowMs?: number) {
      if (disposed || !visible) return;
      const t = nowMs ?? now();
      if (t < nextRefresh) return;
      nextRefresh = t + refreshMs;
      refresh(false);
    },
    drawOverlays(): number {
      drawn = 0;
      if (disposed || overlays.size === 0) return 0;
      const source = options.source();
      if (!source.drawLine) return 0;
      let count = 0;
      for (const tab of tabs) {
        if (!tab.overlay || !overlays.has(tab.overlay.key)) continue;
        count += tab.overlay.draw(source) ?? 0;
      }
      drawn = count;
      return drawn;
    },
    state(): InspectorState {
      return {
        visible,
        tab: activeTab()?.id ?? "",
        selected,
        rows: rows.length,
        filter,
        overlays: [...overlays],
        drawn,
        refreshed,
      };
    },
    layout: () => ({ visible, collapsed: ui.collapsed, rect: ui.rect, snap: ui.snap }),
    dispose() {
      if (disposed) return;
      disposed = true;
      ui.dispose();
    },
  };
}

export { ROW_HEIGHT_NOTE };
