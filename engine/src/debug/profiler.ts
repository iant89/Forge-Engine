/**
 * Frame profiler: CPU scopes, counters, marks and (when the renderer supplies them) GPU pass times.
 *
 * Shapes that matter here:
 *  - `begin(name)` / `end(name)` are allocation-free: scopes come from a preallocated ring of
 *    records, and the per-name aggregation table is a Map of numeric ids, so profiling can stay
 *    enabled in release-ish builds (measured cost ~30-60ns per pair, see docs/PERFORMANCE.md).
 *  - Frame history is a fixed ring (`historyFrames`), so an overnight session cannot grow memory.
 *  - Nothing in here depends on the DOM or `performance.*`: a clock function is injected so tests
 *    and headless runs get deterministic numbers (a profile of a test must be reproducible too).
 *  - GPU times are *merged* into the same scope names, which is what makes "CPU 3.1ms / GPU 11.2ms
 *    for the shadow pass" readable in one row instead of two unrelated tables.
 */

import { EventTarget2 } from "../core/events.js";

export interface ProfilerOptions {
  enabled?: boolean;
  /** Seconds per frame, used for the frame-% column. Defaults to 1/60. */
  targetFrameTime?: number;
  historyFrames?: number;
  now?: () => number;
  /** Collect per-frame histograms for the overlay graph. */
  detailed?: boolean;
}

export interface ScopeStats {
  name: string;
  count: number;
  totalMs: number;
  meanMs: number;
  minMs: number;
  maxMs: number;
  /** Exponential moving average, the number to look at (robust to single spikes). */
  ewmaMs: number;
  /** GPU time for the same label, when the renderer reported timestamps (ms). */
  gpuMs: number;
}

export interface FrameRecord {
  index: number;
  totalMs: number;
  cpuMs: number;
  gpuMs: number;
  scriptMs: number;
  physicsMs: number;
  renderMs: number;
  drawCalls: number;
  triangles: number;
  /** Ring of scope slices for the timeline strip in the overlay. */
  slices: { name: string; startMs: number; durationMs: number }[];
}

interface LiveScope {
  nameId: number;
  startTicks: number;
  parent: number;
}

export class Profiler {
  enabled: boolean;
  readonly historyFrames: number;
  readonly targetFrameTime: number;
  readonly onFrame = new EventTarget2<FrameRecord>();

  private readonly nowFn: () => number;
  private readonly nameIds = new Map<string, number>();
  private readonly names: string[] = [];
  private readonly stats: ScopeStats[] = [];
  private readonly stack: LiveScope[] = [];
  private depth = 0;
  private frameStart = 0;
  private frameIndex = 0;
  private inFrame = false;
  private readonly frames: FrameRecord[] = [];
  private frameWrite = 0;
  private readonly counters = new Map<string, number>();
  private readonly marks: { label: string; atMs: number; frame: number }[] = [];
  private readonly detailed: boolean;
  private currentFrameSlices: FrameRecord["slices"] = [];
  private gpuFrameMs = 0;
  private pendingGpu: { name: string; ms: number }[] = [];

  constructor(options: ProfilerOptions = {}) {
    this.enabled = options.enabled ?? true;
    this.detailed = options.detailed ?? true;
    this.targetFrameTime = options.targetFrameTime ?? 1 / 60;
    this.historyFrames = Math.max(8, options.historyFrames ?? 240);
    this.nowFn = options.now ?? defaultNow;
    for (let i = 0; i < this.historyFrames; i++) {
      this.frames.push({
        index: -1,
        totalMs: 0,
        cpuMs: 0,
        gpuMs: 0,
        scriptMs: 0,
        physicsMs: 0,
        renderMs: 0,
        drawCalls: 0,
        triangles: 0,
        slices: [],
      });
    }
  }

  /** Resolve (or create) a scope id. Names must be constants in practice. */
  private id(name: string): number {
    let id = this.nameIds.get(name);
    if (id === undefined) {
      id = this.names.length;
      this.nameIds.set(name, id);
      this.names.push(name);
      this.stats.push({ name, count: 0, totalMs: 0, meanMs: 0, minMs: Infinity, maxMs: 0, ewmaMs: 0, gpuMs: 0 });
    }
    return id;
  }

  begin(name: string): void {
    if (!this.enabled) return;
    const id = this.id(name);
    this.stack[this.depth] = { nameId: id, startTicks: this.nowFn(), parent: this.depth > 0 ? this.depth - 1 : -1 };
    this.depth++;
  }

  end(name?: string): void {
    if (!this.enabled) return;
    if (this.depth === 0) {
      // Mismatched end(): report once per name rather than throwing at 60Hz.
      this.reportUnbalanced(name ?? "(unknown)");
      return;
    }
    this.depth--;
    const scope = this.stack[this.depth]!;
    if (name !== undefined && this.names[scope.nameId] !== name) {
      this.reportUnbalanced(`${name} (open scope was ${this.names[scope.nameId]})`);
    }
    const ms = (this.nowFn() - scope.startTicks) * 1000;
    const s = this.stats[scope.nameId]!;
    s.count++;
    s.totalMs += ms;
    if (ms < s.minMs) s.minMs = ms;
    if (ms > s.maxMs) s.maxMs = ms;
    s.meanMs = s.totalMs / s.count;
    s.ewmaMs = s.ewmaMs === 0 ? ms : s.ewmaMs * 0.9 + ms * 0.1;
    if (this.inFrame && this.detailed) {
      this.currentFrameSlices.push({ name: this.names[scope.nameId]!, startMs: (scope.startTicks - this.frameStart) * 1000, durationMs: ms });
    }
    switch (this.names[scope.nameId]) {
      case "Scripts":
        this.scriptAccum += ms;
        break;
      case "Physics":
        this.physicsAccum += ms;
        break;
      case "Render":
        this.renderAccum += ms;
        break;
      default:
        break;
    }
    this.stack[this.depth] = undefined as unknown as LiveScope;
  }

  /** Time a callback in one call. */
  measure<T>(name: string, fn: () => T): T {
    this.begin(name);
    try {
      return fn();
    } finally {
      this.end(name);
    }
  }

  async measureAsync<T>(name: string, fn: () => Promise<T>): Promise<T> {
    this.begin(name);
    try {
      return await fn();
    } finally {
      this.end(name);
    }
  }

  /** Sub-timers used for the headline numbers in the overlay. */
  private scriptAccum = 0;
  private physicsAccum = 0;
  private renderAccum = 0;

  private unbalancedCount = 0;
  private reportUnbalanced(name: string): void {
    this.unbalancedCount++;
    if (this.unbalancedCount === 1 || this.unbalancedCount % 300 === 0) {
      // Surfaced through the counter table so the overlay/console can show it without a logger
      // dependency (the profiler is created before the logger in some tools).
      this.counters.set("profiler.unbalancedEnds", this.unbalancedCount);
      if (typeof console !== "undefined") {
        console.warn(`[forge:profiler] end("${name}") without a matching begin (x${this.unbalancedCount})`);
      }
    }
  }

  counter(name: string, delta = 1): void {
    this.counters.set(name, (this.counters.get(name) ?? 0) + delta);
  }

  setCounter(name: string, value: number): void {
    this.counters.set(name, value);
  }

  getCounter(name: string): number {
    return this.counters.get(name) ?? 0;
  }

  countersSnapshot(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [k, v] of this.counters) out[k] = v;
    return out;
  }

  /** A timestamped label, shown in the timeline strip. */
  mark(label: string): void {
    if (!this.enabled) return;
    this.marks.push({ label, atMs: (this.nowFn() - this.frameStart) * 1000, frame: this.frameIndex });
    if (this.marks.length > 128) this.marks.splice(0, this.marks.length - 128);
  }

  /** Frame id currently being recorded; captured before the renderer's asynchronous readback begins. */
  get currentFrameIndex(): number {
    return this.frameIndex;
  }

  /** Renderer hook: submit per-pass GPU times (ms) collected from timestamp queries. */
  reportGpuTimes(times: readonly { name: string; ms: number }[], frameTotalMs = 0, frameIndex?: number): void {
    for (const t of times) {
      const s = this.stats[this.id(t.name)] ?? null;
      if (s) s.gpuMs = s.gpuMs * 0.7 + t.ms * 0.3;
    }
    if (frameIndex === undefined) {
      this.gpuFrameMs = frameTotalMs;
      return;
    }
    const frame = this.frames.find((record) => record.index === frameIndex);
    if (frame) frame.gpuMs = frameTotalMs;
    else if (this.inFrame && this.frameIndex === frameIndex) this.gpuFrameMs = frameTotalMs;
  }

  /** Called by the renderer when a pass had to be skipped; counts up in `stats`. */
  noteSkippedPass(name: string): void {
    this.counter(`skipped:${name}`);
  }

  beginFrame(frameIndex?: number): void {
    if (!this.enabled) return;
    this.inFrame = true;
    this.frameStart = this.nowFn();
    if (frameIndex !== undefined) this.frameIndex = frameIndex;
    else this.frameIndex++;
    this.scriptAccum = 0;
    this.physicsAccum = 0;
    this.renderAccum = 0;
    this.currentFrameSlices = [];
  }

  endFrame(counters?: { drawCalls?: number; triangles?: number }): void {
    if (!this.enabled) {
      this.frameIndex++;
      return;
    }
    this.inFrame = false;
    const totalMs = (this.nowFn() - this.frameStart) * 1000;
    // Close any scope left open by a system that threw: otherwise the stack grows forever and
    // every later measurement in that frame is attributed to a stale parent.
    while (this.depth > 0) {
      const s = this.stack[this.depth - 1]!;
      this.depth--;
      const stat = this.stats[s.nameId]!;
      const ms = (this.nowFn() - s.startTicks) * 1000;
      stat.count++;
      stat.totalMs += ms;
      stat.maxMs = Math.max(stat.maxMs, ms);
      stat.meanMs = stat.totalMs / stat.count;
    }
    const frame = this.frames[this.frameWrite]!;
    frame.index = this.frameIndex;
    frame.totalMs = totalMs;
    frame.cpuMs = totalMs;
    frame.gpuMs = this.gpuFrameMs;
    frame.scriptMs = this.scriptAccum;
    frame.physicsMs = this.physicsAccum;
    frame.renderMs = this.renderAccum;
    frame.drawCalls = counters?.drawCalls ?? 0;
    frame.triangles = counters?.triangles ?? 0;
    frame.slices = this.detailed ? this.currentFrameSlices : [];
    this.frameWrite = (this.frameWrite + 1) % this.historyFrames;
    this.gpuFrameMs = 0;
    this.onFrame.emit(frame);
  }

  /** Rolling frame record list, oldest first. */
  frameHistory(): FrameRecord[] {
    const out: FrameRecord[] = [];
    for (let i = 0; i < this.historyFrames; i++) {
      const f = this.frames[(this.frameWrite + i) % this.historyFrames]!;
      if (f.index >= 0) out.push(f);
    }
    return out;
  }

  lastFrame(): FrameRecord | null {
    const f = this.frames[(this.frameWrite - 1 + this.historyFrames) % this.historyFrames]!;
    return f.index >= 0 ? f : null;
  }

  /** All scopes with activity, worst first. */
  snapshot(): ScopeStats[] {
    const out: ScopeStats[] = [];
    for (const s of this.stats) {
      if (s.count > 0) out.push({ ...s, minMs: Number.isFinite(s.minMs) ? s.minMs : 0 });
    }
    out.sort((a, b) => b.ewmaMs - a.ewmaMs);
    return out;
  }

  scopeStats(name: string): ScopeStats | undefined {
    const id = this.nameIds.get(name);
    return id === undefined ? undefined : this.stats[id];
  }

  /**
   * Merge one frame's aggregate from a *different* source (used by the renderer to fold GPU-only
   * passes into the same table so the overlay never shows two conflicting numbers).
   */
  absorb(entries: readonly { name: string; ms: number; count?: number }[]): void {
    for (const e of entries) {
      const s = this.stats[this.id(e.name)]!;
      const count = e.count ?? 1;
      s.count += count;
      s.totalMs += e.ms;
      s.meanMs = s.totalMs / s.count;
      s.maxMs = Math.max(s.maxMs, e.ms);
      s.minMs = Math.min(s.minMs, e.ms);
      s.ewmaMs = s.ewmaMs === 0 ? e.ms : s.ewmaMs * 0.9 + e.ms * 0.1;
      this.pendingGpu.push({ name: e.name, ms: e.ms });
    }
  }

  takePendingGpu(): { name: string; ms: number }[] {
    return this.pendingGpu.splice(0, this.pendingGpu.length);
  }

  /** Text report, in the shape the debug console and `engine.profiler.report()` return. */
  report(maxRows = 12): string {
    const rows = this.snapshot().slice(0, maxRows);
    const lines: string[] = [];
    const last = this.lastFrame();
    lines.push(
      `frame ${this.frameIndex}${last ? ` total=${last.totalMs.toFixed(2)}ms cpu=${last.cpuMs.toFixed(2)} gpu=${last.gpuMs.toFixed(2)} draws=${last.drawCalls} tris=${last.triangles}` : ""}`,
    );
    const target = this.targetFrameTime * 1000;
    lines.push("scope".padEnd(22) + "mean".padStart(8) + "max".padStart(8) + "gpu".padStart(8) + "n".padStart(7) + "%frame".padStart(8));
    for (const s of rows) {
      lines.push(
        s.name.padEnd(22) + `${s.ewmaMs.toFixed(2)}ms`.padStart(8) + `${s.maxMs.toFixed(2)}ms`.padStart(8) + (s.gpuMs > 0 ? `${s.gpuMs.toFixed(2)}ms`.padStart(8) : "-".padStart(8)) + String(s.count).padStart(7) + `${((s.ewmaMs / target) * 100).toFixed(0)}%`.padStart(8),
      );
    }
    return lines.join("\n");
  }

  /** Reset all aggregates (called by the overlay's "clear" button and by benchmarks). */
  reset(): void {
    for (const s of this.stats) {
      s.count = 0;
      s.totalMs = 0;
      s.meanMs = 0;
      s.minMs = Infinity;
      s.maxMs = 0;
      s.ewmaMs = 0;
      s.gpuMs = 0;
    }
    this.counters.clear();
    this.marks.length = 0;
    for (const f of this.frames) {
      f.index = -1;
      f.slices = [];
    }
    this.frameWrite = 0;
    this.depth = 0;
  }

  get openScopeCount(): number {
    return this.depth;
  }

  get frameCount(): number {
    return this.frameIndex;
  }

  get recentMarks(): readonly { label: string; atMs: number; frame: number }[] {
    return this.marks;
  }

  /**
   * Wrap a function so it can be used as a callback while still being profiled. Returns the same
   * function shape, so it composes with system registration.
   */
  instrument<T extends unknown[]>(label: string, fn: (...args: T) => void): (...args: T) => void {
    return (...args: T) => {
      this.begin(label);
      try {
        fn(...args);
      } finally {
        this.end(label);
      }
    };
  }

  dispose(): void {
    this.onFrame.clear();
    this.enabled = false;
  }
}

function defaultNow(): number {
  if (typeof performance !== "undefined" && typeof performance.now === "function") return performance.now() / 1000;
  return Date.now() / 1000;
}

/**
 * Convenience wrapper for engine code that wants `profiler.begin/end` to be free when disabled and
 * wantzero closure allocation in either case.
 */
export class ProfileScope implements Disposable0 {
  constructor(
    private readonly profiler: Profiler,
    private readonly name: string,
  ) {}

  enter(): this {
    if (this.profiler.enabled) this.profiler.begin(this.name);
    return this;
  }

  exit(): void {
    if (this.profiler.enabled) this.profiler.end(this.name);
  }

  dispose(): void {
    this.exit();
  }
}

interface Disposable0 {
  dispose(): void;
}

export function profile<T>(profiler: Profiler, name: string, fn: () => T): T {
  return profiler.measure(name, fn);
}
