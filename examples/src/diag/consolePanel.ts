/**
 * Visible developer terminal for the Phase 21 console API.
 *
 * The command model remains in the engine and is deliberately DOM-free. This small adapter supplies
 * the demo's input, transcript, history navigation and completion without ever evaluating text as
 * JavaScript. It uses the same floating chrome as the Profiler and Inspector, so the console is
 * useful on a phone as well as in a desktop dev layout and costs nothing while collapsed.
 */

import {
  DeveloperConsole,
  type DeveloperConsoleEntry,
  type DeveloperConsoleHost,
} from "@forge/engine";
import { ICONS, mountDebugPanel, type DebugPanel, type DebugPanelOptions, type StorageLike } from "./debugPanel.js";
import { bounds, type Rect, type SnapEdges } from "./panelLayout.js";

export interface ConsolePanelOptions {
  /** Empty page element that the terminal replaces with its floating body. */
  body: HTMLElement;
  /** Toolbar button that opens / closes the terminal. */
  button?: HTMLElement | null;
  /** Live engine objects used by the registered diagnostic commands. */
  host: DeveloperConsoleHost;
  /** Supply a command model in tests or a host that already registered custom commands. */
  console?: DeveloperConsole;
  storageKey?: string;
  storage?: StorageLike | null;
  avoid?: string[];
  doc?: Document;
  win?: DebugPanelOptions["win"];
  now?: () => number;
}

export interface ConsolePanelState {
  visible: boolean;
  entries: number;
  commands: number;
  input: string;
  completions: string[];
}

export interface ConsolePanel {
  readonly ui: DebugPanel;
  readonly console: DeveloperConsole;
  readonly visible: boolean;
  setVisible(visible: boolean): void;
  toggle(): void;
  /** Execute one command and repaint the bounded transcript. */
  execute(input: string): DeveloperConsoleEntry;
  /** State used by browser checks and dev tooling. */
  state(): ConsolePanelState;
  layout(): { visible: boolean; collapsed: boolean; rect: Rect; snap: SnapEdges | null };
  dispose(): void;
}

export function mountConsolePanel(options: ConsolePanelOptions): ConsolePanel {
  const doc = options.doc ?? document;
  const now = options.now ?? (() => performance.now());
  const developerConsole = options.console ?? new DeveloperConsole(options.host);
  let visible = false;
  let disposed = false;
  let historyCursor = -1;
  let completions: string[] = [];

  const el = <K extends keyof HTMLElementTagNameMap>(tag: K): HTMLElementTagNameMap[K] => doc.createElement(tag);
  const root = el("div");
  root.style.cssText =
    "display:flex;flex-direction:column;min-height:0;overflow:hidden;background:rgb(5 7 10 / 0.94);" +
    "font:11px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;color:#dbeafe";
  const output = el("pre");
  output.className = "forge-console-output";
  output.setAttribute("aria-live", "polite");
  output.style.cssText = "flex:1 1 auto;min-height:80px;margin:0;padding:8px;overflow:auto;white-space:pre-wrap;word-break:break-word;user-select:text";
  const form = el("div");
  form.style.cssText = "flex:0 0 auto;display:flex;gap:6px;padding:6px;border-top:1px solid rgb(56 189 248 / 0.22)";
  const input = el("input");
  input.type = "text";
  input.className = "forge-console-input";
  input.setAttribute("aria-label", "Developer console command");
  input.setAttribute("autocomplete", "off");
  input.setAttribute("spellcheck", "false");
  input.style.cssText = "flex:1 1 auto;min-width:0;background:rgb(2 6 12 / 0.95);color:#f8fafc;border:1px solid rgb(56 189 248 / 0.45);border-radius:4px;padding:5px 7px;font:inherit;user-select:text";
  const run = el("button");
  run.type = "button";
  run.textContent = "Run";
  run.setAttribute("aria-label", "Run developer console command");
  run.style.cssText = "flex:0 0 auto;background:rgb(14 116 144 / 0.65);color:#ecfeff;border:1px solid rgb(103 232 249 / 0.55);border-radius:4px;padding:4px 9px;font:inherit;cursor:pointer";
  const hint = el("div");
  hint.className = "forge-console-hint";
  hint.style.cssText = "flex:0 0 auto;min-height:18px;padding:2px 8px 4px;color:#7dd3fc;white-space:nowrap;overflow:hidden;text-overflow:ellipsis";
  form.append(input, run);
  root.append(output, form, hint);

  const transcript = (): string => developerConsole.history.map(formatEntry).join("\n");
  const paint = (): void => {
    output.textContent = transcript();
    const scroll = output as unknown as { scrollTop?: number; scrollHeight?: number };
    if (typeof scroll.scrollHeight === "number") scroll.scrollTop = scroll.scrollHeight;
    hint.textContent = completions.length > 0
      ? `completion: ${completions.join("  ")}`
      : "Enter runs a registered command · Up/Down recalls history · Tab completes names · input is never evaluated";
  };
  const runInput = (): DeveloperConsoleEntry => {
    const value = input.value ?? "";
    const entry = developerConsole.execute(value);
    input.value = "";
    historyCursor = -1;
    completions = [];
    paint();
    return entry;
  };
  const recall = (direction: number): void => {
    const history = developerConsole.history;
    if (history.length === 0) return;
    if (historyCursor < 0) historyCursor = direction < 0 ? history.length : 0;
    historyCursor = Math.max(0, Math.min(history.length, historyCursor + direction));
    input.value = historyCursor === history.length ? "" : history[historyCursor]?.input ?? "";
    completions = [];
    paint();
  };
  const complete = (): void => {
    completions = developerConsole.complete(input.value ?? "");
    if (completions.length === 1) {
      input.value = `${completions[0]} `;
      completions = [];
    }
    paint();
  };

  run.addEventListener("click", runInput);
  input.addEventListener("keydown", (event) => {
    const key = (event as KeyboardEvent).key;
    if (key === "Enter") {
      (event as { preventDefault?: () => void }).preventDefault?.();
      runInput();
    } else if (key === "ArrowUp") {
      (event as { preventDefault?: () => void }).preventDefault?.();
      recall(-1);
    } else if (key === "ArrowDown") {
      (event as { preventDefault?: () => void }).preventDefault?.();
      recall(1);
    } else if (key === "Tab") {
      (event as { preventDefault?: () => void }).preventDefault?.();
      complete();
    } else {
      completions = [];
    }
  });
  input.addEventListener("input", () => {
    completions = [];
  });

  options.body.parentNode?.insertBefore(root, options.body);
  const ui = mountDebugPanel({
    body: root,
    title: "console",
    barEdge: "top",
    getText: transcript,
    storageKey: options.storageKey ?? "forge.panel.console",
    defaultRect: (vp) => {
      const b = bounds(vp);
      const narrow = vp.w <= 820;
      const w = Math.min(narrow ? b.w - 20 : 620, b.w);
      const h = Math.min(narrow ? 270 : 330, Math.round(b.h * 0.48));
      return { x: b.l, y: b.b - h, w, h };
    },
    minSize: { w: 280, h: 180 },
    iconCorner: "bottom-right",
    iconSvg: ICONS.terminal,
    avoid: options.avoid,
    defaultCollapsed: true,
    storage: options.storage,
    doc,
    win: options.win,
    now,
    onCollapsedChange: (collapsed) => {
      visible = !collapsed;
      if (visible) {
        paint();
        input.focus?.();
      }
      options.button?.classList.toggle("active", visible);
      options.button?.setAttribute("aria-pressed", visible ? "true" : "false");
    },
  });
  if (ui.collapsed) {
    visible = false;
  } else {
    visible = true;
    options.button?.classList.toggle("active", true);
    options.button?.setAttribute("aria-pressed", "true");
    paint();
  }
  options.button?.addEventListener("click", () => {
    if (disposed) return;
    ui.setCollapsed(visible);
  });

  return {
    ui,
    console: developerConsole,
    get visible() {
      return visible;
    },
    setVisible(next) {
      if (next === visible) return;
      ui.setCollapsed(!next);
    },
    toggle() {
      ui.setCollapsed(visible);
    },
    execute(inputText: string) {
      input.value = inputText;
      return runInput();
    },
    state() {
      return { visible, entries: developerConsole.history.length, commands: developerConsole.commandList.length, input: input.value ?? "", completions: [...completions] };
    },
    layout: () => ({ visible, collapsed: ui.collapsed, rect: ui.rect, snap: ui.snap }),
    dispose() {
      if (disposed) return;
      disposed = true;
      ui.dispose();
    },
  };
}

function formatEntry(entry: DeveloperConsoleEntry): string {
  const lines = [`${entry.ok ? "›" : "!"} ${entry.input}`];
  if (entry.output.length > 0) lines.push(...entry.output.map((line) => `  ${line}`));
  return lines.join("\n");
}
