/**
 * Shared title bar for the demo's debug panels (the top stats HUD and the `?diag=1` report).
 *
 * The bar sits on the panel edge that faces the middle of the screen (bottom edge for the top HUD,
 * top edge for the bottom diag panel), so collapsing leaves only the bar where the panel was. At the
 * far right is a collapse/expand toggle; to its left a copy-icon button that copies the panel's full
 * text. Both are >= 44px tap targets with `touch-action: manipulation` for iPhone Safari, and use
 * plain `click` (which WebKit fires for taps and counts as a user gesture for the clipboard).
 * The collapsed state is persisted per panel in localStorage when it is available.
 */
import { copyText, type CopyEnv } from "./copyText.js";

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** Pure collapse state with best-effort persistence (storage may be absent or throw, e.g. private mode). */
export class CollapseState {
  private value: boolean;
  constructor(
    private readonly key: string,
    private readonly storage: StorageLike | null,
    initial = false,
  ) {
    let stored: string | null = null;
    try {
      stored = storage?.getItem(key) ?? null;
    } catch {
      stored = null;
    }
    this.value = stored === "1" ? true : stored === "0" ? false : initial;
  }
  get collapsed(): boolean {
    return this.value;
  }
  set(collapsed: boolean): boolean {
    this.value = collapsed;
    try {
      this.storage?.setItem(this.key, collapsed ? "1" : "0");
    } catch {
      /* persistence is a nice-to-have */
    }
    return this.value;
  }
  toggle(): boolean {
    return this.set(!this.value);
  }
}

/** Label shown on the copy button after a copy attempt. */
export function copyResultLabel(ok: boolean): string {
  return ok ? "Copied" : "Copy failed";
}

/** Text for the toggle: arrow points the way the panel will move. */
export function toggleGlyph(collapsed: boolean, barEdge: "top" | "bottom"): string {
  // bottom bar (top panel): expanded body is above → collapse = ▴, expand = ▾. Mirrored for top bar.
  if (barEdge === "bottom") return collapsed ? "▾" : "▴";
  return collapsed ? "▴" : "▾";
}

const COPY_ICON =
  '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
  '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';

const STYLE_ID = "forge-debug-panel-style";
const CSS = `
.fdp-bar{display:flex;align-items:center;gap:4px;min-height:44px;padding:0 0 0 10px;
  font:11px ui-monospace,SFMono-Regular,Menlo,monospace;color:#7dd3fc;background:rgb(2 4 8 / 0.9);
  border:1px solid rgb(56 189 248 / 0.55);pointer-events:auto;-webkit-user-select:none;user-select:none}
.fdp-title{flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.fdp-status{color:#a7f3d0;white-space:nowrap}
.fdp-btn{display:inline-flex;align-items:center;justify-content:center;min-width:44px;min-height:44px;
  margin:0;padding:0 8px;background:transparent;color:#7dd3fc;border:0;border-left:1px solid rgb(56 189 248 / 0.35);
  font:16px ui-monospace,Menlo,monospace;cursor:pointer;touch-action:manipulation;-webkit-tap-highlight-color:transparent}
.fdp-btn:active{background:rgb(56 189 248 / 0.2)}
.fdp-collapsed>.fdp-body{display:none!important}
`;

export interface DebugPanelOptions {
  /** The element that shows the panel's text. It is moved into the new wrapper. */
  body: HTMLElement;
  title: string;
  barEdge: "top" | "bottom";
  /** Full text to copy (may include more than is on screen). */
  getText: () => string;
  storageKey: string;
  storage?: StorageLike | null;
  clipboard?: CopyEnv["clipboard"];
  doc?: Document;
}

export interface DebugPanel {
  root: HTMLDivElement;
  bar: HTMLDivElement;
  copyButton: HTMLButtonElement;
  toggleButton: HTMLButtonElement;
  state: CollapseState;
  setCollapsed(collapsed: boolean): void;
  copy(): Promise<boolean>;
  dispose(): void;
}

function safeLocalStorage(): StorageLike | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/** Wrap `body` in a panel with the shared title bar. The caller positions `root`. */
export function mountDebugPanel(opts: DebugPanelOptions): DebugPanel {
  const doc = opts.doc ?? document;
  if (!doc.getElementById(STYLE_ID)) {
    const style = doc.createElement("style");
    style.id = STYLE_ID;
    style.textContent = CSS;
    doc.head.appendChild(style);
  }
  const state = new CollapseState(opts.storageKey, opts.storage === undefined ? safeLocalStorage() : opts.storage);
  const root = doc.createElement("div");
  root.className = "fdp";
  opts.body.parentNode?.insertBefore(root, opts.body);
  opts.body.classList.add("fdp-body");

  const bar = doc.createElement("div");
  bar.className = `fdp-bar fdp-bar-${opts.barEdge}`;
  const title = doc.createElement("span");
  title.className = "fdp-title";
  title.textContent = opts.title;
  const status = doc.createElement("span");
  status.className = "fdp-status";
  status.setAttribute("aria-live", "polite");
  const copyButton = doc.createElement("button");
  copyButton.type = "button";
  copyButton.className = "fdp-btn fdp-copy";
  copyButton.innerHTML = COPY_ICON;
  copyButton.setAttribute("aria-label", `Copy ${opts.title}`);
  copyButton.title = "Copy to clipboard";
  const toggleButton = doc.createElement("button");
  toggleButton.type = "button";
  toggleButton.className = "fdp-btn fdp-toggle";
  bar.append(title, status, copyButton, toggleButton);

  if (opts.barEdge === "top") root.append(bar, opts.body);
  else root.append(opts.body, bar);

  const render = (): void => {
    const c = state.collapsed;
    root.classList.toggle("fdp-collapsed", c);
    toggleButton.textContent = toggleGlyph(c, opts.barEdge);
    toggleButton.setAttribute("aria-expanded", String(!c));
    toggleButton.setAttribute("aria-label", c ? `Expand ${opts.title}` : `Collapse ${opts.title}`);
  };
  render();

  let reset: ReturnType<typeof setTimeout> | null = null;
  const copy = (): Promise<boolean> => {
    // Called synchronously from the click so iOS keeps the gesture for navigator.clipboard.
    const clip = opts.clipboard !== undefined ? opts.clipboard : (globalThis.navigator?.clipboard ?? null);
    return copyText(opts.getText(), { clipboard: clip, document: doc }).then((ok) => {
      status.textContent = copyResultLabel(ok);
      if (reset) clearTimeout(reset);
      reset = setTimeout(() => (status.textContent = ""), 1500);
      return ok;
    });
  };
  const onCopy = (e: Event): void => {
    e.stopPropagation();
    void copy();
  };
  const onToggle = (e: Event): void => {
    e.stopPropagation();
    state.toggle();
    render();
  };
  copyButton.addEventListener("click", onCopy);
  toggleButton.addEventListener("click", onToggle);

  return {
    root,
    bar,
    copyButton,
    toggleButton,
    state,
    setCollapsed(c) {
      state.set(c);
      render();
    },
    copy,
    dispose() {
      if (reset) clearTimeout(reset);
      copyButton.removeEventListener("click", onCopy);
      toggleButton.removeEventListener("click", onToggle);
      root.remove();
    },
  };
}
