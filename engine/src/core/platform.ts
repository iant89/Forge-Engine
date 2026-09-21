/**
 * Platform capability probing.
 *
 * Every capability the engine cares about is resolved once, at startup, into an immutable
 * record; subsystems then read that record instead of sniffing the environment themselves.
 * This matters because WebGPU feature availability is *per adapter*, not per browser, and
 * because the engine must also run in Node (tests, headless tooling, worker contexts) where
 * `navigator`/`document` do not exist.
 */

import { LogLevel, Logger, parseLogLevel, type LogSink } from "./log.js";

export interface PlatformInfo {
  /** Running in a browser with a DOM. */
  hasDom: boolean;
  /** `navigator.gpu` present → WebGPU is available (not yet guaranteed to succeed). */
  hasWebGPU: boolean;
  /** Cross-origin isolation → SharedArrayBuffer usable. */
  hasSharedArrayBuffer: boolean;
  /** `OffscreenCanvas` + transferControlToOffscreen → renderer can live in a worker. */
  hasOffscreenCanvas: boolean;
  /** Dedicated workers available. */
  hasWorkers: boolean;
  /** `performance.mark`/measure available (devtools timeline integration). */
  hasPerformanceMarks: boolean;
  /** `WebAssembly` present (physics/WASM modules). */
  hasWasm: boolean;
  /** Cores reported by the browser (0 when unknown). */
  hardwareConcurrency: number;
  devicePixelRatio: number;
  /** `canvas.toDataURL`/2D context available for text + debug glyphs. */
  hasCanvas2D: boolean;
  userAgent: string;
  os: "windows" | "macos" | "linux" | "android" | "ios" | "unknown";
  browser: "chrome" | "edge" | "firefox" | "safari" | "node" | "unknown";
  /** WebGPU is only usable on a page with a secure context. */
  isSecureContext: boolean;
}

/** The subset of `navigator` the engine reads, typed so Node/workers without a DOM still compile. */
interface NavigatorLike {
  readonly userAgent?: string;
  readonly hardwareConcurrency?: number;
  readonly gpu?: {
    requestAdapter(options?: unknown): Promise<GPUAdapter | null>;
    getPreferredCanvasFormat(): GPUTextureFormat;
  };
  readonly sharedStorage?: unknown;
}

export function detectPlatform(): PlatformInfo {
  const g = globalThis as unknown as {
    navigator?: NavigatorLike;
    window?: { devicePixelRatio?: number; isSecureContext?: boolean };
    document?: Document;
    process?: unknown;
    OffscreenCanvas?: unknown;
    Worker?: unknown;
    WebAssembly?: unknown;
    SharedArrayBuffer?: unknown;
    performance?: Performance;
  };
  const nav = g.navigator;
  const ua = nav?.userAgent ?? "";
  const info: PlatformInfo = {
    hasDom: typeof g.document !== "undefined",
    hasWebGPU: !!nav?.gpu,
    hasSharedArrayBuffer: typeof g.SharedArrayBuffer !== "undefined",
    hasOffscreenCanvas: typeof g.OffscreenCanvas !== "undefined",
    hasWorkers: typeof g.Worker !== "undefined",
    hasPerformanceMarks: typeof g.performance?.mark === "function",
    hasWasm: typeof g.WebAssembly !== "undefined",
    hardwareConcurrency: nav?.hardwareConcurrency ?? safeOsCpuCount(),
    devicePixelRatio: g.window?.devicePixelRatio ?? 1,
    hasCanvas2D: hasCanvas2D(),
    userAgent: ua,
    os: detectOs(ua),
    browser: detectBrowser(ua),
    isSecureContext: g.window?.isSecureContext ?? typeof g.document === "undefined",
  };
  return info;
}

function safeOsCpuCount(): number {
  const proc = (globalThis as { process?: { os?: { cpus?: () => unknown[] } } }).process;
  try {
    return proc?.os?.cpus?.().length ?? 0;
  } catch {
    return 0;
  }
}

function hasCanvas2D(): boolean {
  if (typeof OffscreenCanvas === "undefined") return false;
  try {
    return !!new OffscreenCanvas(1, 1).getContext("2d");
  } catch {
    return false;
  }
}

function detectOs(ua: string): PlatformInfo["os"] {
  if (/Windows/i.test(ua)) return "windows";
  if (/Android/i.test(ua)) return "android";
  if (/iPhone|iPad|iPod/i.test(ua)) return "ios";
  if (/Mac OS X|Macintosh/i.test(ua)) return "macos";
  if (/Linux|X11/i.test(ua)) return "linux";
  return typeof (globalThis as unknown as { process?: unknown }).process !== "undefined" ? "linux" : "unknown";
}

function detectBrowser(ua: string): PlatformInfo["browser"] {
  if (/Edg\//i.test(ua)) return "edge";
  if (/Firefox\/|FxiOS\//i.test(ua)) return "firefox";
  // Every iOS browser carries "Safari/" (WebKit is mandatory there); Chrome/Edge/Firefox for iOS add
  // their own token, so only a UA without one is Safari proper. Desktop Safari reads
  // "Version/x Safari/y" with no "Chrome/".
  if (/Safari\//i.test(ua) && !/Chrome\/|Chromium\/|CriOS\/|EdgiOS\/|FxiOS\//i.test(ua)) return "safari";
  if (/Chrome\/|Chromium\/|CriOS\//i.test(ua)) return "chrome";
  return typeof (globalThis as unknown as { process?: unknown }).process !== "undefined" ? "node" : "unknown";
}

/**
 * WebGPU support probe. Returns the adapter if WebGPU works, plus a human-readable reason when
 * it does not (the number-one support question for a WebGPU engine is *why* it failed).
 */
export async function probeWebGPU(): Promise<{
  supported: boolean;
  adapter: GPUAdapter | null;
  reason?: string;
}> {
  const nav = (globalThis as unknown as { navigator?: NavigatorLike }).navigator;
  if (!nav?.gpu) {
    return {
      supported: false,
      adapter: null,
      reason: "navigator.gpu is undefined — the browser does not expose WebGPU (or the page is not a secure context).",
    };
  }
  try {
    const adapter = await nav.gpu.requestAdapter({ powerPreference: "high-performance" });
    if (!adapter) {
      return {
        supported: false,
        adapter: null,
        reason: "requestAdapter() returned null — no compatible GPU adapter (blocklisted driver, headless without --enable-unsafe-webgpu, or GPU disabled).",
      };
    }
    return { supported: true, adapter };
  } catch (e) {
    return { supported: false, adapter: null, reason: `requestAdapter() threw: ${String((e as Error).message ?? e)}` };
  }
}

export function getNavigatorGpu(): NavigatorLike["gpu"] | undefined {
  return (globalThis as unknown as { navigator?: NavigatorLike }).navigator?.gpu;
}

/**
 * Engine-wide logging bootstrap used by `Engine`. Exposed separately so tools/tests can create a
 * logger with identical semantics without constructing an engine.
 */
export function createLogger(options: {
  level?: LogLevel | string;
  sinks?: LogSink[];
  scope?: string;
}): Logger {
  const level = typeof options.level === "string" ? parseLogLevel(options.level) : options.level ?? LogLevel.Info;
  const logger = Logger.createRoot({ level, sink: options.sinks?.[0] });
  if (options.sinks && options.sinks.length > 1) {
    for (let i = 1; i < options.sinks.length; i++) logger.addSink(options.sinks[i]!);
  }
  if (options.scope && options.scope !== "core") return logger.child(options.scope);
  return logger;
}
