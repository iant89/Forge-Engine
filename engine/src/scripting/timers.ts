/**
 * Script timers (Phase 18.2).
 *
 * Two clocks:
 *  - `"sim"` (default) — deterministic. Durations are whole fixed steps (`seconds / fixedDt`, rounded
 *    up, at least 1, or exact `steps`), counted on the runtime's fixed-step tick. Due timers fire at
 *    the start of the fixed step they fall on, before that step's onFixedUpdate hooks, ordered by due
 *    tick then creation. The same sequence of fixed steps gives the same firings at the same ticks,
 *    whatever the frame rate or how the steps were split across frames.
 *  - `"render"` — variable rate. Durations are seconds of the frame clock (`dt`, time-scaled); due
 *    timers fire at the start of the update phase, before onUpdate. A repeating render timer fires
 *    at most once per frame; if a frame overshoots a whole interval the missed occurrences are
 *    dropped and the next one is scheduled an interval after now.
 *
 * Timers belong to the script that created them: they fire only while it is active and enabled, run
 * under the same error isolation as hooks (a throwing callback counts as that script's error), and
 * are cancelled when it is destroyed. A timer that comes due while its script is disabled waits and
 * fires at the first opportunity after the script is enabled again (a repeating one fires once and
 * then resumes its cadence from where it was).
 */

import type { ScriptContext } from "./script.js";

export type TimerClock = "sim" | "render";

export interface TimerOptions {
  /** Which clock measures the delay (default "sim"). */
  clock?: TimerClock;
  /** Exact fixed steps instead of seconds ("sim" only). */
  steps?: number;
}

export type TimerCallback = (context: ScriptContext, timer: TimerHandle) => void;

export interface TimerHandle {
  readonly clock: TimerClock;
  /** Repeating timers: the interval (steps for "sim", seconds for "render"); 0 for one-shots. */
  readonly interval: number;
  /** Times the callback has run. */
  readonly fires: number;
  /** False once cancelled, fired (one-shot), or its script is gone. */
  readonly active: boolean;
  cancel(): void;
}

/** @internal One scheduled timer. */
export class Timer implements TimerHandle {
  fires = 0;
  cancelled = false;
  /** Index in the heap (-1 when out). */
  heapIndex = -1;

  constructor(
    readonly owner: object,
    readonly clock: TimerClock,
    /** Due tick ("sim") or due render-time seconds ("render"). */
    public due: number,
    /** Steps or seconds between fires; 0 = one-shot. */
    readonly interval: number,
    readonly callback: TimerCallback,
    /** Creation order, the tie-break for equal due times. */
    readonly seq: number,
    private readonly onCancel: (t: Timer) => void,
  ) {}

  get active(): boolean {
    return !this.cancelled;
  }

  cancel(): void {
    if (this.cancelled) return;
    this.cancelled = true;
    this.onCancel(this);
  }
}

/** @internal Min-heap of timers by (due, seq). */
export class TimerQueue {
  private readonly heap: Timer[] = [];

  get size(): number {
    return this.heap.length;
  }

  peek(): Timer | undefined {
    return this.heap[0];
  }

  push(t: Timer): void {
    t.heapIndex = this.heap.length;
    this.heap.push(t);
    this.up(t.heapIndex);
  }

  pop(): Timer | undefined {
    const h = this.heap;
    if (h.length === 0) return undefined;
    const top = h[0]!;
    this.removeAt(0);
    return top;
  }

  remove(t: Timer): void {
    if (t.heapIndex >= 0 && this.heap[t.heapIndex] === t) this.removeAt(t.heapIndex);
  }

  clear(): void {
    for (const t of this.heap) t.heapIndex = -1;
    this.heap.length = 0;
  }

  private removeAt(i: number): void {
    const h = this.heap;
    const t = h[i]!;
    const last = h.pop()!;
    t.heapIndex = -1;
    if (i < h.length) {
      h[i] = last;
      last.heapIndex = i;
      this.up(i);
      this.down(last.heapIndex);
    }
  }

  private less(a: Timer, b: Timer): boolean {
    return a.due < b.due || (a.due === b.due && a.seq < b.seq);
  }

  private up(i: number): void {
    const h = this.heap;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!this.less(h[i]!, h[p]!)) break;
      this.swap(i, p);
      i = p;
    }
  }

  private down(i: number): void {
    const h = this.heap;
    for (;;) {
      const l = 2 * i + 1, r = l + 1;
      let m = i;
      if (l < h.length && this.less(h[l]!, h[m]!)) m = l;
      if (r < h.length && this.less(h[r]!, h[m]!)) m = r;
      if (m === i) return;
      this.swap(i, m);
      i = m;
    }
  }

  private swap(a: number, b: number): void {
    const h = this.heap;
    const ta = h[a]!, tb = h[b]!;
    h[a] = tb;
    h[b] = ta;
    ta.heapIndex = b;
    tb.heapIndex = a;
  }
}
