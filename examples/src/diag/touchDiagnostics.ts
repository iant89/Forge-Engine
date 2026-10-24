/**
 * Touch / gesture diagnostics overlay.
 *
 * A toggleable panel for finding out *why* touch input misbehaves on a particular device — most often
 * iOS Safari. It shows what the browser actually delivers (pointer events, with their `pointerType`,
 * positions and pressure; the legacy touch-event count; Safari's `gesturestart` pinch), what the
 * gesture recogniser made of it (tap / drag / double-tap / pinch), the canvas's `touch-action`, the
 * viewport and device pixel ratio, and a dot under every finger so a missed or offset touch is visible.
 *
 * It listens on `window` in the capture phase with passive listeners, so it never interferes with the
 * scene's own handlers, and it costs nothing while hidden (the listeners return immediately).
 * Toggle with the button the scene adds, or the `T` key; `?touchdiag=1` opens it at load.
 */

export interface DiagPointer {
  id: number;
  type: string;
  x: number;
  y: number;
  pressure: number;
  width: number;
  height: number;
  down: boolean;
}

/** One-line text for a pointer row (exported for tests). */
export function formatDiagPointer(p: DiagPointer): string {
  const size = p.width > 1 || p.height > 1 ? ` ${Math.round(p.width)}×${Math.round(p.height)}` : "";
  return `#${p.id} ${p.type} ${p.down ? "down" : "up  "} (${Math.round(p.x)}, ${Math.round(p.y)}) p${p.pressure.toFixed(2)}${size}`;
}

export interface TouchDiagnosticsOptions {
  /** The element that receives the gestures (its `touch-action` is reported). */
  target: HTMLElement;
  /** Extra live lines (the scene's gesture mode, orbit phase, …), refreshed ~4×/s while visible. */
  extra?: () => string[];
  /** Start visible. */
  visible?: boolean;
}

const MAX_LOG = 9;

export class TouchDiagnostics {
  readonly root: HTMLDivElement;
  private readonly body: HTMLPreElement;
  private readonly dots = new Map<number, HTMLDivElement>();
  private readonly pointers = new Map<number, DiagPointer>();
  private readonly log: string[] = [];
  private readonly counts = { pointer: 0, touch: 0, gesture: 0, wheel: 0, contextmenu: 0 };
  private readonly abort = new AbortController();
  private _visible = false;
  private lastRender = 0;
  private readonly t0 = performance.now();
  private readonly options: TouchDiagnosticsOptions;

  constructor(options: TouchDiagnosticsOptions) {
    this.options = options;
    this.root = document.createElement("div");
    this.root.id = "touch-diagnostics";
    this.root.hidden = true;
    this.root.style.cssText =
      "position:fixed;left:8px;bottom:8px;z-index:60;max-width:min(92vw,420px);padding:8px 10px;border-radius:10px;" +
      "background:rgba(8,12,18,0.82);color:#bfe9ff;font:11px/1.35 ui-monospace,Menlo,Consolas,monospace;" +
      "pointer-events:none;white-space:pre;overflow:hidden;";
    this.body = document.createElement("pre");
    this.body.style.cssText = "margin:0;font:inherit;white-space:pre-wrap;";
    this.root.appendChild(this.body);
    document.body.appendChild(this.root);

    const signal = this.abort.signal;
    const opts = { capture: true, passive: true, signal } as const;
    const onPointer = (e: PointerEvent, down: boolean | null): void => {
      this.counts.pointer++;
      const prev = this.pointers.get(e.pointerId);
      const isDown = down ?? prev?.down ?? false;
      const p: DiagPointer = { id: e.pointerId, type: e.pointerType || "?", x: e.clientX, y: e.clientY, pressure: e.pressure, width: e.width, height: e.height, down: isDown };
      this.pointers.set(e.pointerId, p);
      if (!this._visible) return;
      if (e.type !== "pointermove") this.push(`${e.type.replace("pointer", "ptr-")} ${formatDiagPointer(p)}`);
      this.moveDot(p);
      if (down === false) this.pointers.delete(e.pointerId);
      this.render();
    };
    window.addEventListener("pointerdown", (e) => onPointer(e, true), opts);
    window.addEventListener("pointermove", (e) => onPointer(e, null), opts);
    window.addEventListener("pointerup", (e) => onPointer(e, false), opts);
    window.addEventListener("pointercancel", (e) => onPointer(e, false), opts);
    const onTouch = (e: TouchEvent): void => {
      this.counts.touch++;
      if (this._visible && e.type !== "touchmove") this.push(`${e.type} touches=${e.touches.length} changed=${e.changedTouches.length}`);
    };
    for (const type of ["touchstart", "touchend", "touchcancel", "touchmove"] as const) window.addEventListener(type, onTouch, opts);
    // Safari's non-standard pinch events: seeing these means the page can still be zoomed by the browser.
    for (const type of ["gesturestart", "gesturechange", "gestureend"]) {
      window.addEventListener(type, () => {
        this.counts.gesture++;
        if (this._visible && type !== "gesturechange") this.push(`safari ${type} (browser pinch not suppressed)`);
      }, opts);
    }
    window.addEventListener("wheel", () => { this.counts.wheel++; }, opts);
    window.addEventListener("contextmenu", () => { this.counts.contextmenu++; if (this._visible) this.push("contextmenu"); }, opts);
    window.addEventListener("keydown", (e) => {
      if ((e.key === "t" || e.key === "T") && !e.ctrlKey && !e.metaKey && !e.altKey) this.toggle();
    }, { signal });
    this.setVisible(options.visible ?? false);
  }

  get visible(): boolean {
    return this._visible;
  }

  toggle(): boolean {
    this.setVisible(!this._visible);
    return this._visible;
  }

  setVisible(visible: boolean): void {
    this._visible = visible;
    this.root.hidden = !visible;
    for (const dot of this.dots.values()) dot.style.display = visible ? "block" : "none";
    if (visible) this.render();
  }

  /** Called by the scene with each recognised gesture (`tap`, `drag-start`, `double-tap`, …). */
  gesture(name: string, detail: string): void {
    if (this._visible) {
      this.push(`⇒ ${name} ${detail}`);
      this.render();
    }
  }

  /** Per-frame hook: refreshes the text ~4×/s while visible (extra lines change without events). */
  tick(nowMs: number): void {
    if (this._visible && nowMs - this.lastRender > 250) this.render();
  }

  dispose(): void {
    this.abort.abort();
    for (const dot of this.dots.values()) dot.remove();
    this.dots.clear();
    this.root.remove();
  }

  private push(line: string): void {
    const t = ((performance.now() - this.t0) / 1000).toFixed(2).padStart(7);
    this.log.push(`${t}s ${line}`);
    if (this.log.length > MAX_LOG) this.log.shift();
  }

  private moveDot(p: DiagPointer): void {
    let dot = this.dots.get(p.id);
    if (!p.down) {
      dot?.remove();
      this.dots.delete(p.id);
      return;
    }
    if (!dot) {
      dot = document.createElement("div");
      dot.style.cssText =
        "position:fixed;z-index:59;width:44px;height:44px;margin:-22px 0 0 -22px;border-radius:50%;pointer-events:none;" +
        "border:2px solid #5fd4ff;background:rgba(95,212,255,0.18);box-shadow:0 0 0 1px rgba(0,0,0,0.5);";
      document.body.appendChild(dot);
      this.dots.set(p.id, dot);
    }
    dot.style.left = `${p.x}px`;
    dot.style.top = `${p.y}px`;
  }

  private render(): void {
    this.lastRender = performance.now();
    const target = this.options.target;
    const touchAction = typeof getComputedStyle === "function" ? getComputedStyle(target).touchAction : "?";
    const vv = window.visualViewport;
    const lines: string[] = [];
    lines.push(`touch diagnostics  (T toggles)`);
    lines.push(`maxTouchPoints ${navigator.maxTouchPoints}  dpr ${window.devicePixelRatio}  viewport ${window.innerWidth}×${window.innerHeight}${vv ? ` visual ${Math.round(vv.width)}×${Math.round(vv.height)} @${vv.scale.toFixed(2)}` : ""}`);
    lines.push(`canvas touch-action: ${touchAction}${touchAction === "none" ? "" : "  ⚠ expected none"}`);
    lines.push(`events  pointer ${this.counts.pointer}  touch ${this.counts.touch}  safari-gesture ${this.counts.gesture}  wheel ${this.counts.wheel}`);
    for (const line of this.options.extra?.() ?? []) lines.push(line);
    const active = [...this.pointers.values()].filter((p) => p.down);
    lines.push(active.length ? `active pointers: ${active.length}` : "active pointers: none");
    for (const p of active) lines.push(`  ${formatDiagPointer(p)}`);
    lines.push("recent:");
    for (const l of this.log) lines.push(`  ${l}`);
    this.body.textContent = lines.join("\n");
  }
}
