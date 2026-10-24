/**
 * A tiny pointer-gesture recogniser: drag, pinch, tap and double-tap from raw pointer events.
 *
 * It is DOM-free (callers feed it `pointerId, x, y, time`), so the rules that decide whether a touch
 * is a tap, a drag or the second half of a double-tap are unit-tested without a browser. The Mars
 * Orbit Explorer feeds it from pointer events; iOS Safari delivers the same stream as long as the
 * canvas has `touch-action: none` (the demo's canvas does).
 *
 * Rules:
 * - A single pointer that moves further than `dragSlopPx` becomes a **drag**. `dragStart` reports where
 *   the pointer *went down* (not where it crossed the slop), so a grab does not pop by the slop.
 * - A pointer that goes down and up within `tapMaxMs` and `tapSlopPx` is a **tap**; a second tap within
 *   `doubleTapMs` and `doubleTapSlopPx` of the first is a **double-tap** (and the second is not also
 *   reported as a tap).
 * - A second pointer turns the gesture into a **pinch** (any drag in progress is ended with `cancelled`).
 *   When one finger lifts, the other does nothing until it too is lifted, so lifting from a pinch never
 *   throws the planet.
 */

export interface GestureOptions {
  /** Pointer travel (CSS px) before a press becomes a drag. Default 6. */
  dragSlopPx?: number;
  /** Longest press (ms) that still counts as a tap. Default 350. */
  tapMaxMs?: number;
  /** Largest travel (px) a tap may have. Default 10. */
  tapSlopPx?: number;
  /** Longest gap (ms) between the two taps of a double-tap. Default 380. */
  doubleTapMs?: number;
  /** Largest distance (px) between the two taps. Default 32. */
  doubleTapSlopPx?: number;
}

export interface GestureHandlers {
  dragStart?(x: number, y: number, timeMs: number): void;
  drag?(x: number, y: number, timeMs: number): void;
  /** `cancelled` is true when a second finger arrived or the browser cancelled the touch (no throw). */
  dragEnd?(timeMs: number, cancelled: boolean): void;
  tap?(x: number, y: number, timeMs: number): void;
  doubleTap?(x: number, y: number, timeMs: number): void;
  pinchStart?(cx: number, cy: number, timeMs: number): void;
  /** `ratio` is the change in finger spacing since the previous event (>1 = spreading apart). */
  pinch?(ratio: number, cx: number, cy: number, timeMs: number): void;
  pinchEnd?(timeMs: number): void;
}

export type GestureMode = "idle" | "pending" | "drag" | "pinch" | "settling";

interface Track {
  x0: number;
  y0: number;
  t0: number;
  x: number;
  y: number;
}

export class GestureRecogniser {
  readonly dragSlopPx: number;
  readonly tapMaxMs: number;
  readonly tapSlopPx: number;
  readonly doubleTapMs: number;
  readonly doubleTapSlopPx: number;
  /** Every recognised event, for the diagnostics overlay (`name`, human-readable detail). */
  onEvent: ((name: string, detail: string) => void) | null = null;

  private readonly tracks = new Map<number, Track>();
  private _mode: GestureMode = "idle";
  private lastTap: { x: number; y: number; t: number } | null = null;
  private pinchSpacing = 0;

  constructor(private readonly handlers: GestureHandlers = {}, options: GestureOptions = {}) {
    this.dragSlopPx = options.dragSlopPx ?? 6;
    this.tapMaxMs = options.tapMaxMs ?? 350;
    this.tapSlopPx = options.tapSlopPx ?? 10;
    this.doubleTapMs = options.doubleTapMs ?? 380;
    this.doubleTapSlopPx = options.doubleTapSlopPx ?? 32;
  }

  get mode(): GestureMode {
    return this._mode;
  }

  get pointerCount(): number {
    return this.tracks.size;
  }

  pointerDown(id: number, x: number, y: number, timeMs: number): void {
    if (this.tracks.has(id)) return;
    if (this.tracks.size >= 2) {
      // A third finger is ignored but tracked so its release does not look like the first lifting.
      this.tracks.set(id, { x0: x, y0: y, t0: timeMs, x, y });
      return;
    }
    this.tracks.set(id, { x0: x, y0: y, t0: timeMs, x, y });
    if (this.tracks.size === 1) {
      this._mode = "pending";
      this.emit("down", `#${id} (${Math.round(x)}, ${Math.round(y)})`);
      return;
    }
    // Second finger: a pinch. A drag in progress ends without a throw; a pending tap is void.
    if (this._mode === "drag") this.handlers.dragEnd?.(timeMs, true);
    this.lastTap = null;
    this._mode = "pinch";
    this.pinchSpacing = this.spacing();
    const c = this.centre();
    this.emit("pinch-start", `spacing ${Math.round(this.pinchSpacing)} px`);
    this.handlers.pinchStart?.(c.x, c.y, timeMs);
  }

  pointerMove(id: number, x: number, y: number, timeMs: number): void {
    const t = this.tracks.get(id);
    if (!t) return;
    t.x = x;
    t.y = y;
    if (this._mode === "pending") {
      if (Math.hypot(x - t.x0, y - t.y0) > this.dragSlopPx) {
        this._mode = "drag";
        this.lastTap = null;
        this.emit("drag-start", `from (${Math.round(t.x0)}, ${Math.round(t.y0)})`);
        this.handlers.dragStart?.(t.x0, t.y0, timeMs);
        this.handlers.drag?.(x, y, timeMs);
      }
    } else if (this._mode === "drag") {
      this.handlers.drag?.(x, y, timeMs);
    } else if (this._mode === "pinch") {
      const spacing = this.spacing();
      if (spacing > 1 && this.pinchSpacing > 1) {
        const ratio = spacing / this.pinchSpacing;
        this.pinchSpacing = spacing;
        const c = this.centre();
        this.handlers.pinch?.(ratio, c.x, c.y, timeMs);
      }
    }
  }

  pointerUp(id: number, x: number, y: number, timeMs: number): void {
    const t = this.tracks.get(id);
    if (!t) return;
    t.x = x;
    t.y = y;
    const wasMode = this._mode;
    const firstTwo = [...this.tracks.keys()].slice(0, 2).includes(id);
    this.tracks.delete(id);
    if (wasMode === "pending") {
      const travel = Math.hypot(x - t.x0, y - t.y0);
      if (timeMs - t.t0 <= this.tapMaxMs && travel <= this.tapSlopPx) {
        const prev = this.lastTap;
        if (prev && timeMs - prev.t <= this.doubleTapMs && Math.hypot(x - prev.x, y - prev.y) <= this.doubleTapSlopPx) {
          this.lastTap = null;
          this.emit("double-tap", `(${Math.round(x)}, ${Math.round(y)})`);
          this.handlers.doubleTap?.(x, y, timeMs);
        } else {
          this.lastTap = { x, y, t: timeMs };
          this.emit("tap", `(${Math.round(x)}, ${Math.round(y)})`);
          this.handlers.tap?.(x, y, timeMs);
        }
      } else {
        this.lastTap = null;
      }
      this._mode = this.tracks.size === 0 ? "idle" : "settling";
    } else if (wasMode === "drag") {
      this.emit("drag-end", "released");
      this.handlers.dragEnd?.(timeMs, false);
      this._mode = this.tracks.size === 0 ? "idle" : "settling";
    } else if (wasMode === "pinch" && firstTwo) {
      this.emit("pinch-end", "");
      this.handlers.pinchEnd?.(timeMs);
      this._mode = this.tracks.size === 0 ? "idle" : "settling";
    } else if (this.tracks.size === 0) {
      this._mode = "idle";
    }
  }

  /** The browser took the pointer away (an OS gesture, a system alert): end everything without a throw. */
  pointerCancel(id: number, timeMs: number): void {
    if (!this.tracks.has(id)) return;
    this.cancelAll(timeMs);
  }

  cancelAll(timeMs: number): void {
    const mode = this._mode;
    this.tracks.clear();
    this.lastTap = null;
    this._mode = "idle";
    if (mode === "drag") {
      this.emit("drag-end", "cancelled");
      this.handlers.dragEnd?.(timeMs, true);
    } else if (mode === "pinch") {
      this.emit("pinch-end", "cancelled");
      this.handlers.pinchEnd?.(timeMs);
    }
  }

  private spacing(): number {
    const [a, b] = this.firstTwo();
    return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
  }

  private centre(): { x: number; y: number } {
    const [a, b] = this.firstTwo();
    return a && b ? { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } : { x: a?.x ?? 0, y: a?.y ?? 0 };
  }

  private firstTwo(): [Track | undefined, Track | undefined] {
    const it = this.tracks.values();
    return [it.next().value, it.next().value];
  }

  private emit(name: string, detail: string): void {
    this.onEvent?.(name, detail);
  }
}
