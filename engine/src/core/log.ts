/**
 * Structured logging.
 *
 * The engine logs through a `Logger` tree (scoped per subsystem) rather than `console.*` so
 * that the debug console, the editor and embedders can capture/filter/replay messages without
 * monkey-patching globals. Records are kept in a bounded ring so `debug console` can show
 * history from before it was opened, and so a long-running page cannot grow memory with logs.
 */

import { clamp } from "../math/scalar.js";

export const LogLevel = {
  Silent: 0,
  Error: 1,
  Warn: 2,
  Info: 3,
  Debug: 4,
  Trace: 5,
} as const;
export type LogLevel = (typeof LogLevel)[keyof typeof LogLevel];

export const LogLevelName: Record<LogLevel, string> = {
  0: "silent",
  1: "error",
  2: "warn",
  3: "info",
  4: "debug",
  5: "trace",
};

export function parseLogLevel(value: string | number | undefined): LogLevel {
  if (typeof value === "number") return clamp(Math.round(value), 0, 5) as LogLevel;
  switch ((value ?? "info").toLowerCase()) {
    case "silent":
    case "none":
    case "off":
      return LogLevel.Silent;
    case "error":
      return LogLevel.Error;
    case "warn":
    case "warning":
      return LogLevel.Warn;
    case "debug":
      return LogLevel.Debug;
    case "trace":
    case "verbose":
      return LogLevel.Trace;
    default:
      return LogLevel.Info;
  }
}

export interface LogRecord {
  level: LogLevel;
  scope: string;
  message: string;
  /** Extra structured data (kept by reference; do not mutate). */
  data?: unknown;
  /** ms since the Logger was created — correlates with profiler markers. */
  timeMs: number;
  /** Monotonic sequence number for stable ordering & dedupe. */
  seq: number;
}

export interface LogSink {
  write(record: LogRecord): void;
  flush?(): void;
}

const COLOR_FOR_LEVEL: Record<number, number> = { 0: 245, 1: 214, 2: 39, 3: 8, 4: 8 };

/** Writes to console if present, respecting level. */
export class ConsoleSink implements LogSink {
  constructor(
    private readonly useColors = typeof (globalThis as unknown as { process?: unknown }).process === "undefined",
  ) {}

  write(r: LogRecord): void {
    const c = globalThis.console;
    if (!c) return;
    const prefix = this.useColors ? `\u001b[38;5;${COLOR_FOR_LEVEL[r.level] ?? 250}m[forge:${r.scope}]\u001b[0m` : `[forge:${r.scope}]`;
    const fn =
      r.level === LogLevel.Error ? c.error : r.level === LogLevel.Warn ? c.warn : r.level === LogLevel.Trace ? c.debug : c.log;
    if (r.data === undefined) fn.call(c, prefix, r.message);
    else fn.call(c, prefix, r.message, r.data);
  }
}

/** Bounded ring of the most recent records (used by the debug console + tests). */
export class LogBuffer implements LogSink {
  private readonly records: LogRecord[];
  private writeIndex = 0;
  private filled = 0;
  private _dropped = 0;

  constructor(readonly capacity = 1000) {
    this.records = new Array<LogRecord>(capacity);
  }

  write(r: LogRecord): void {
    if (this.records[this.writeIndex]) this._dropped++;
    this.records[this.writeIndex] = r;
    this.writeIndex = (this.writeIndex + 1) % this.capacity;
    this.filled = Math.min(this.filled + 1, this.capacity);
  }

  get length(): number {
    return this.filled;
  }

  get droppedCount(): number {
    return this._dropped;
  }

  /** Oldest → newest. */
  snapshot(): LogRecord[] {
    const out: LogRecord[] = [];
    if (this.filled < this.capacity) {
      for (let i = 0; i < this.filled; i++) out.push(this.records[i]!);
      return out;
    }
    for (let i = 0; i < this.capacity; i++) {
      out.push(this.records[(this.writeIndex + i) % this.capacity]!);
    }
    return out;
  }

  filter(predicate: (r: LogRecord) => boolean): LogRecord[] {
    return this.snapshot().filter(predicate);
  }

  clear(): void {
    this.records.fill(undefined as unknown as LogRecord, 0, this.capacity);
    this.writeIndex = 0;
    this.filled = 0;
    this._dropped = 0;
  }
}

export interface LoggerOptions {
  level?: LogLevel;
  sinks?: LogSink[];
  scope?: string;
  /** Shared parent state for child loggers. */
  shared?: LoggerShared;
  /** Coalesce repeated identical messages (prevents one broken script flooding the log). */
  dedupe?: boolean;
}

interface LoggerShared {
  seq: number;
  startTime: number;
  sinks: LogSink[];
  level: LogLevel;
  dedupeWindowMs: number;
  recent: Map<string, { count: number; lastMs: number; suppressed: number }>;
  counts: Record<LogLevel, number>;
}

const NOOP_SHARED_FACTORY = (): LoggerShared => ({
  seq: 0,
  startTime: nowMs(),
  sinks: [],
  level: LogLevel.Info,
  dedupeWindowMs: 1500,
  recent: new Map(),
  counts: { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 } as Record<LogLevel, number>,
});

function nowMs(): number {
  return typeof performance !== "undefined" && performance.now ? performance.now() : Date.now();
}

export class Logger {
  readonly scope: string;
  private readonly shared: LoggerShared;
  private readonly ownLevel?: LogLevel;

  constructor(options: LoggerOptions = {}) {
    this.scope = options.scope ?? "core";
    this.shared = options.shared ?? NOOP_SHARED_FACTORY();
    if (options.sinks && !options.shared) this.shared.sinks.push(...options.sinks);
    if (options.level !== undefined) {
      if (!options.shared) this.shared.level = options.level;
      else this.ownLevel = options.level;
    }
    if (options.dedupe === false && !options.shared) this.shared.dedupeWindowMs = 0;
  }

  /** Create a sub-logger that shares sinks, counters and history. */
  child(scope: string): Logger {
    return new Logger({ scope: this.scope === "core" ? scope : `${this.scope}.${scope}`, shared: this.shared });
  }

  get level(): LogLevel {
    return this.ownLevel ?? this.shared.level;
  }

  setLevel(level: LogLevel): void {
    if (this.ownLevel !== undefined) (this as unknown as { ownLevel?: LogLevel }).ownLevel = level;
    else this.shared.level = level;
  }

  get counts(): Readonly<Record<LogLevel, number>> {
    return this.shared.counts;
  }

  addSink(sink: LogSink): void {
    this.shared.sinks.push(sink);
  }

  removeSink(sink: LogSink): boolean {
    const i = this.shared.sinks.indexOf(sink);
    if (i < 0) return false;
    this.shared.sinks.splice(i, 1);
    return true;
  }

  /** The engine-wide record ring; the dev console reads this. */
  get history(): LogRecord[] {
    for (const s of this.shared.sinks) if (s instanceof LogBuffer) return s.snapshot();
    return [];
  }

  isEnabled(level: LogLevel): boolean {
    return level <= this.level;
  }

  log(level: LogLevel, message: string, data?: unknown): void {
    if (level > this.level) return;
    this.shared.counts[level] = (this.shared.counts[level] ?? 0) + 1;
    const t = nowMs();
    if (this.shared.dedupeWindowMs > 0) {
      const key = `${level}|${this.scope}|${message}`;
      const prev = this.shared.recent.get(key);
      if (prev && t - prev.lastMs < this.shared.dedupeWindowMs) {
        prev.count++;
        prev.lastMs = t;
        prev.suppressed++;
        return;
      }
      if (prev && prev.suppressed > 0) {
        this.emit({
          level,
          scope: this.scope,
          message: `${message} (previous message repeated ${prev.suppressed}×)`,
          data: undefined,
          timeMs: t - this.shared.startTime,
          seq: this.shared.seq++,
        });
      }
      this.shared.recent.set(key, { count: 1, lastMs: t, suppressed: 0 });
      if (this.shared.recent.size > 256) {
        // Keep the map bounded: drop the oldest entry (insertion order).
        const first = this.shared.recent.keys().next();
        if (!first.done) this.shared.recent.delete(first.value);
      }
    }
    this.emit({ level, scope: this.scope, message, data, timeMs: t - this.shared.startTime, seq: this.shared.seq++ });
  }

  error(message: string, data?: unknown): void {
    this.log(LogLevel.Error, message, data);
  }

  warn(message: string, data?: unknown): void {
    this.log(LogLevel.Warn, message, data);
  }

  info(message: string, data?: unknown): void {
    this.log(LogLevel.Info, message, data);
  }

  debug(message: string, data?: unknown): void {
    this.log(LogLevel.Debug, message, data);
  }

  trace(message: string, data?: unknown): void {
    this.log(LogLevel.Trace, message, data);
  }

  /** Log an exception with a consistent shape and (in debug) a stack. */
  exception(context: string, error: unknown): void {
    const e = error as Error | undefined;
    const stack = e && typeof e.stack === "string" && this.level >= LogLevel.Debug ? `\n${e.stack}` : "";
    this.log(LogLevel.Error, `${context}: ${e?.message ?? String(error)}${stack}`, e?.name === undefined ? undefined : { name: e.name, code: (e as { code?: string }).code });
  }

  private emit(record: LogRecord): void {
    for (const sink of this.shared.sinks) {
      try {
        sink.write(record);
      } catch {
        // A broken sink must not take the engine down.
      }
    }
  }

  /** Flush sinks that buffer (called on frame boundaries by the engine). */
  flush(): void {
    for (const s of this.shared.sinks) s.flush?.();
  }

  /** Factory used by `Engine`; one shared history buffer per engine instance. */
  static createRoot(options: { level?: LogLevel; sink?: LogSink } = {}): Logger {
    const shared = NOOP_SHARED_FACTORY();
    shared.level = options.level ?? LogLevel.Info;
    shared.sinks.push(options.sink ?? new ConsoleSink(), new LogBuffer(2000));
    return new Logger({ scope: "core", shared });
  }
}
