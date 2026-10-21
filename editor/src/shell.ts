/**
 * Small browser DOM shell for the Phase 26 workspace.
 *
 * This is intentionally a host-owned shell, not a renderer or a second UI framework. It provides a
 * usable hierarchy/inspector/panel workspace and a viewport slot; hosts can replace any region with
 * Forge UI or their own DOM while keeping the same EditorWorkspace contract.
 */

import type { Disposable } from "@forge/engine";
import { EDITOR_PANEL_IDS, type EditorPanelId } from "./panels.js";
import { EditorWorkspace } from "./workspace.js";

const STYLE_ID = "forge-editor-shell-style";

export interface EditorShellOptions {
  readonly root: HTMLElement;
  readonly workspace: EditorWorkspace;
  readonly title?: string;
  readonly viewport?: HTMLElement;
}

export interface EditorShellElements {
  readonly root: HTMLElement;
  readonly hierarchy: HTMLElement;
  readonly inspector: HTMLElement;
  readonly viewport: HTMLElement;
  readonly panels: HTMLElement;
}

/** Mount and own a minimal visible editor shell around an EditorWorkspace. */
export class EditorShell {
  readonly elements: EditorShellElements;
  private readonly workspace: EditorWorkspace;
  private readonly root: HTMLElement;
  private readonly subscription: Disposable;
  private activePanel: EditorPanelId = "environment";
  private disposed = false;

  constructor(options: EditorShellOptions) {
    this.root = options.root;
    this.workspace = options.workspace;
    installStyle(this.root.ownerDocument);
    this.root.classList.add("forge-editor-shell");
    this.root.replaceChildren();

    const toolbar = element(this.root.ownerDocument, "header", "fes-toolbar");
    const title = element(this.root.ownerDocument, "strong", "fes-title");
    title.textContent = options.title ?? "Forge Editor";
    toolbar.append(title);
    toolbar.append(button(this.root.ownerDocument, "Undo", () => { this.workspace.undo(); this.refresh(); }));
    toolbar.append(button(this.root.ownerDocument, "Redo", () => { this.workspace.redo(); this.refresh(); }));
    toolbar.append(button(this.root.ownerDocument, "Create entity", () => {
      this.workspace.createEntity("New Entity", { components: [{ type: "Transform" }] });
      this.refresh();
    }));
    toolbar.append(button(this.root.ownerDocument, "Duplicate", () => {
      const id = this.workspace.primarySelection;
      if (id !== null) this.workspace.duplicateEntity(id);
      this.refresh();
    }));
    toolbar.append(button(this.root.ownerDocument, "Delete", () => {
      this.workspace.deleteEntity();
      this.refresh();
    }));

    const body = element(this.root.ownerDocument, "div", "fes-body");
    const hierarchy = element(this.root.ownerDocument, "section", "fes-pane fes-hierarchy");
    const inspector = element(this.root.ownerDocument, "section", "fes-pane fes-inspector");
    const viewport = options.viewport ?? element(this.root.ownerDocument, "section", "fes-viewport");
    if (!options.viewport) viewport.textContent = "Viewport";
    const panels = element(this.root.ownerDocument, "section", "fes-pane fes-panels");
    body.append(hierarchy, viewport, inspector, panels);
    this.root.append(toolbar, body);
    this.elements = { root: this.root, hierarchy, inspector, viewport, panels };
    this.subscription = this.workspace.changed.on(() => this.refresh());
    this.refresh();
  }

  refresh(): void {
    if (this.disposed) return;
    this.renderHierarchy();
    this.renderInspector();
    this.renderPanels();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.subscription.dispose();
    this.root.replaceChildren();
    this.root.classList.remove("forge-editor-shell");
  }

  private renderHierarchy(): void {
    const doc = this.root.ownerDocument;
    this.elements.hierarchy.replaceChildren();
    const heading = element(doc, "h2", "fes-heading");
    heading.textContent = "Hierarchy";
    const filter = doc.createElement("input");
    filter.type = "search";
    filter.placeholder = "Filter entities or components";
    filter.className = "fes-filter";
    const list = element(doc, "div", "fes-tree");
    const paint = (): void => {
      list.replaceChildren();
      const snapshot = this.workspace.hierarchy({ filter: filter.value, limit: 2000 });
      for (const row of snapshot.rows) {
        const item = doc.createElement("button");
        item.className = "fes-tree-row";
        item.type = "button";
        item.style.paddingLeft = `${8 + row.depth * 16}px`;
        item.dataset.entity = String(row.id);
        item.classList.toggle("is-selected", row.selected);
        item.textContent = `${row.expanded ? "▾" : "▸"} ${row.label}`;
        item.title = row.components.join(", ");
        item.addEventListener("click", (event) => {
          this.workspace.select(row.id, { additive: (event as MouseEvent).shiftKey });
          this.refresh();
        });
        item.addEventListener("dblclick", () => {
          this.workspace.setExpanded(row.id, !row.expanded);
          this.refresh();
        });
        list.append(item);
      }
      if (snapshot.truncated) {
        const note = element(doc, "div", "fes-note");
        note.textContent = "Hierarchy truncated";
        list.append(note);
      }
    };
    filter.addEventListener("input", paint);
    this.elements.hierarchy.append(heading, filter, list);
    paint();
  }

  private renderInspector(): void {
    const doc = this.root.ownerDocument;
    this.elements.inspector.replaceChildren();
    const heading = element(doc, "h2", "fes-heading");
    heading.textContent = "Inspector";
    this.elements.inspector.append(heading);
    const detail = this.workspace.inspect();
    if (!detail) {
      const note = element(doc, "div", "fes-note");
      note.textContent = "Select an entity";
      this.elements.inspector.append(note);
      return;
    }
    const name = doc.createElement("input");
    name.value = detail.name;
    name.className = "fes-text-input";
    name.addEventListener("change", () => this.workspace.renameEntity(detail.id, name.value));
    this.elements.inspector.append(fieldLabel(doc, "Name", name));

    if (detail.transform) {
      const transform = element(doc, "fieldset", "fes-fieldset");
      const legend = doc.createElement("legend");
      legend.textContent = "Local Transform";
      transform.append(legend);
      for (const [key, values] of [["position", detail.transform.position], ["rotation", detail.transform.rotation], ["scale", detail.transform.scale]] as const) {
        const row = element(doc, "div", "fes-vector");
        row.dataset.field = key;
        for (let index = 0; index < values.length; index++) {
          const input = doc.createElement("input");
          input.type = "number";
          input.step = "any";
          input.value = String(values[index]);
          input.addEventListener("change", () => {
            const next = [...values] as number[];
            next[index] = Number(input.value);
            this.workspace.setLocalTransform(detail.id, { [key]: next } as never);
          });
          row.append(input);
        }
        transform.append(fieldLabel(doc, key, row));
      }
      this.elements.inspector.append(transform);
    }

    const components = element(doc, "div", "fes-components");
    for (const component of detail.components) {
      const section = doc.createElement("details");
      section.className = "fes-component";
      section.open = true;
      const summary = doc.createElement("summary");
      const enabled = doc.createElement("input");
      enabled.type = "checkbox";
      enabled.checked = component.enabled;
      enabled.addEventListener("change", (event) => {
        event.stopPropagation();
        this.workspace.setComponentEnabled(detail.id, component.type, enabled.checked);
      });
      summary.append(enabled, doc.createTextNode(` ${component.type}`));
      section.append(summary);
      for (const [key, value] of Object.entries(component.fields)) {
        const input = doc.createElement("input");
        input.className = "fes-text-input";
        input.value = Array.isArray(value) ? JSON.stringify(value) : String(value);
        input.addEventListener("change", () => {
          let next: unknown = input.value;
          if (Array.isArray(value)) {
            try { next = JSON.parse(input.value); } catch { input.value = JSON.stringify(value); return; }
          } else if (typeof value === "number") next = Number(input.value);
          else if (typeof value === "boolean") next = input.value === "true";
          this.workspace.setComponentFields(detail.id, component.type, { [key]: next as never });
        });
        section.append(fieldLabel(doc, key, input));
      }
      components.append(section);
    }
    this.elements.inspector.append(components);
  }

  private renderPanels(): void {
    const doc = this.root.ownerDocument;
    this.elements.panels.replaceChildren();
    const tabs = element(doc, "nav", "fes-tabs");
    const content = element(doc, "pre", "fes-panel-content");
    for (const id of EDITOR_PANEL_IDS) {
      const tab = button(doc, id, () => {
        this.activePanel = id;
        this.renderPanels();
      });
      tab.classList.toggle("is-active", id === this.activePanel);
      tabs.append(tab);
    }
    const snapshot = this.workspace.panel(this.activePanel);
    content.textContent = snapshot.available ? JSON.stringify(snapshot.data, null, 2) : (snapshot.message ?? "Unavailable");
    this.elements.panels.append(tabs, content);
  }
}

export function mountEditorShell(options: EditorShellOptions): EditorShell {
  return new EditorShell(options);
}

function element(document: Document, tag: string, className: string): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  return node;
}

function button(document: Document, label: string, action: () => void): HTMLButtonElement {
  const node = document.createElement("button");
  node.type = "button";
  node.textContent = label;
  node.addEventListener("click", action);
  return node;
}

function fieldLabel(document: Document, label: string, control: HTMLElement): HTMLElement {
  const wrapper = element(document, "label", "fes-field");
  const text = document.createElement("span");
  text.textContent = label;
  wrapper.append(text, control);
  return wrapper;
}

function installStyle(document: Document): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    .forge-editor-shell { color: #e8edf5; background: #111722; font: 13px system-ui, sans-serif; min-height: 320px; }
    .forge-editor-shell * { box-sizing: border-box; }
    .fes-toolbar { display:flex; align-items:center; gap:6px; padding:7px; background:#1c2635; border-bottom:1px solid #35445b; }
    .fes-title { margin-right:auto; letter-spacing:.04em; }
    .fes-toolbar button, .fes-tabs button { border:1px solid #435675; background:#26344b; color:inherit; border-radius:4px; padding:5px 8px; cursor:pointer; }
    .fes-toolbar button:hover, .fes-tabs button:hover, .fes-tree-row:hover { background:#334867; }
    .fes-body { display:grid; grid-template-columns:minmax(150px, 20%) minmax(180px, 1fr) minmax(220px, 28%) minmax(240px, 32%); min-height:300px; }
    .fes-pane { min-width:0; padding:8px; border-right:1px solid #2c3a50; overflow:auto; }
    .fes-pane:last-child { border-right:0; }
    .fes-viewport { display:grid; place-items:center; color:#8495b0; background:repeating-conic-gradient(#151e2c 0 25%, #121a27 0 50%) 50% / 24px 24px; }
    .fes-heading { font-size:12px; margin:0 0 8px; text-transform:uppercase; letter-spacing:.08em; color:#9db3d2; }
    .fes-filter, .fes-text-input, .fes-field input { width:100%; min-width:0; color:inherit; background:#182235; border:1px solid #3a4a64; border-radius:3px; padding:5px; }
    .fes-tree { display:flex; flex-direction:column; gap:2px; margin-top:7px; }
    .fes-tree-row { border:0; text-align:left; color:inherit; background:transparent; border-radius:3px; padding-top:5px; padding-bottom:5px; cursor:pointer; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    .fes-tree-row.is-selected { background:#365b8d; }
    .fes-note { color:#8391a7; padding:8px 0; }
    .fes-field { display:grid; grid-template-columns:72px minmax(0,1fr); gap:5px; align-items:center; margin:4px 0; color:#adbad0; }
    .fes-fieldset { border:1px solid #35445b; border-radius:4px; padding:6px; margin:8px 0; }
    .fes-fieldset legend { color:#9db3d2; padding:0 4px; }
    .fes-vector { display:grid; grid-template-columns:repeat(3, 1fr); gap:4px; }
    .fes-vector .fes-field { display:contents; }
    .fes-component { border-bottom:1px solid #2c3a50; padding:4px 0; }
    .fes-component summary { cursor:pointer; color:#cbd7e9; }
    .fes-tabs { display:flex; flex-wrap:wrap; gap:4px; margin-bottom:7px; }
    .fes-tabs button.is-active { background:#4675ae; }
    .fes-panel-content { white-space:pre-wrap; overflow:auto; max-height:260px; color:#b8c8df; margin:0; font-size:11px; }
  `;
  document.head.append(style);
}
