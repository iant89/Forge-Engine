/**
 * Device capability tiers + runtime frame-time adaptation (fe-28).
 *
 * Two halves, both pure and renderer-agnostic so any scene can use them:
 *
 * 1. {@link readDeviceCapabilityHints} gathers what the browser will tell us up front —
 *    `navigator.hardwareConcurrency`, `navigator.deviceMemory` (Chromium only), a mobile
 *    user-agent hint (`navigator.userAgentData.mobile` or a UA regex) and, when a WebGPU adapter
 *    is available, its limits, `info` (vendor/architecture) and `isFallbackAdapter`.
 *    {@link classifyDeviceTier} turns those hints into a starting {@link DeviceTier} with reasons.
 * 2. {@link FrameTimeMonitor} watches smoothed frame times at runtime and steps the tier down when
 *    frames stay slow, and back up (never above the starting ceiling) when they stay fast.
 *    {@link AdaptiveDeviceQuality} wires the two together.
 *
 * Map tiers to concrete knobs with {@link tierValue}, e.g.
 * `tierValue(q.tier, { high: 0.5, medium: 1, low: 1.5 })` for a re-route interval in seconds.
 * The tier is a hint: scenes decide which knobs are safe to change mid-run (particle rates,
 * update intervals) and which only at startup (shadow-map size, buffer capacities).
 */

export type DeviceTier = "low" | "medium" | "high";

/** Tiers in ascending order (index = numeric level). */
export const DEVICE_TIERS: readonly DeviceTier[] = ["low", "medium", "high"];

export interface DeviceCapabilityHints {
  /** Logical cores (0 / undefined = unknown). */
  hardwareConcurrency?: number;
  /** `navigator.deviceMemory` in GB (Chromium; coarse, capped at 8). */
  deviceMemoryGB?: number;
  /** Mobile/tablet hint from the UA (Client Hints or a UA-string match). */
  mobile?: boolean;
  /** WebGPU adapter `maxTextureDimension2D`. */
  maxTextureDimension2D?: number;
  /** WebGPU adapter `maxStorageBufferBindingSize` in bytes. */
  maxStorageBufferBindingSize?: number;
  /** WebGPU adapter vendor / architecture (from `adapter.info`), lower-cased. */
  gpuVendor?: string;
  gpuArchitecture?: string;
  /** Software/fallback adapter (SwiftShader & co.). */
  isFallbackAdapter?: boolean;
}

export interface DeviceTierResult {
  tier: DeviceTier;
  /** Score the tier came from (higher = more capable). */
  score: number;
  /** Human-readable reasons, for logs / debug overlays. */
  reasons: string[];
}

const MOBILE_UA = /Android|iPhone|iPad|iPod|Mobile|Silk|Kindle|Opera Mini|IEMobile/i;

interface NavigatorLike {
  hardwareConcurrency?: number;
  deviceMemory?: number;
  userAgent?: string;
  maxTouchPoints?: number;
  platform?: string;
  userAgentData?: { mobile?: boolean } | null;
}

interface AdapterLike {
  limits?: { maxTextureDimension2D?: number; maxStorageBufferBindingSize?: number } | null;
  info?: { vendor?: string; architecture?: string; isFallbackAdapter?: boolean } | null;
  isFallbackAdapter?: boolean;
}

/** True when the UA hints at a phone/tablet (including iPadOS posing as a Mac with touch). */
export function isMobileUserAgent(nav: NavigatorLike | null | undefined): boolean {
  if (!nav) return false;
  if (nav.userAgentData && typeof nav.userAgentData.mobile === "boolean" && nav.userAgentData.mobile) return true;
  const ua = nav.userAgent ?? "";
  if (MOBILE_UA.test(ua)) return true;
  return /Macintosh/.test(ua) && (nav.maxTouchPoints ?? 0) > 1;
}

/**
 * Collect capability hints. Every input is optional: pass nothing in Node/tests and you get an
 * empty hint set (which classifies as "high" — no evidence of a weak device).
 */
export function readDeviceCapabilityHints(
  nav: NavigatorLike | null | undefined = (globalThis as { navigator?: NavigatorLike }).navigator,
  adapter?: AdapterLike | null,
): DeviceCapabilityHints {
  const hints: DeviceCapabilityHints = {};
  if (nav) {
    if (typeof nav.hardwareConcurrency === "number" && nav.hardwareConcurrency > 0) hints.hardwareConcurrency = nav.hardwareConcurrency;
    if (typeof nav.deviceMemory === "number" && nav.deviceMemory > 0) hints.deviceMemoryGB = nav.deviceMemory;
    hints.mobile = isMobileUserAgent(nav);
  }
  if (adapter) {
    const limits = adapter.limits;
    if (limits?.maxTextureDimension2D) hints.maxTextureDimension2D = limits.maxTextureDimension2D;
    if (limits?.maxStorageBufferBindingSize) hints.maxStorageBufferBindingSize = limits.maxStorageBufferBindingSize;
    const info = adapter.info;
    if (info?.vendor) hints.gpuVendor = info.vendor.toLowerCase();
    if (info?.architecture) hints.gpuArchitecture = info.architecture.toLowerCase();
    const fallback = info?.isFallbackAdapter ?? adapter.isFallbackAdapter;
    if (typeof fallback === "boolean") hints.isFallbackAdapter = fallback;
  }
  return hints;
}

/**
 * Score the hints and pick a tier. Unknown inputs are neutral. A fallback (software) adapter is
 * always "low"; a mobile UA is capped at "medium".
 */
export function classifyDeviceTier(h: DeviceCapabilityHints): DeviceTierResult {
  const reasons: string[] = [];
  let score = 0;
  if (h.hardwareConcurrency !== undefined) {
    if (h.hardwareConcurrency <= 2) { score -= 2; reasons.push(`${h.hardwareConcurrency} cores`); }
    else if (h.hardwareConcurrency <= 4) { score -= 1; reasons.push(`${h.hardwareConcurrency} cores`); }
  }
  if (h.deviceMemoryGB !== undefined) {
    if (h.deviceMemoryGB <= 2) { score -= 2; reasons.push(`${h.deviceMemoryGB} GB memory`); }
    else if (h.deviceMemoryGB < 8) { score -= 1; reasons.push(`${h.deviceMemoryGB} GB memory`); }
  }
  if (h.maxTextureDimension2D !== undefined && h.maxTextureDimension2D < 8192) {
    score -= 1;
    reasons.push(`maxTextureDimension2D ${h.maxTextureDimension2D}`);
  }
  if (h.maxStorageBufferBindingSize !== undefined && h.maxStorageBufferBindingSize < 128 * 1024 * 1024) {
    score -= 1;
    reasons.push(`maxStorageBufferBindingSize ${h.maxStorageBufferBindingSize}`);
  }
  if (h.mobile) { score -= 1; reasons.push("mobile user agent"); }
  let tier: DeviceTier = score <= -3 ? "low" : score <= -1 ? "medium" : "high";
  if (h.mobile && tier === "high") tier = "medium";
  if (h.isFallbackAdapter) { tier = "low"; reasons.push("fallback (software) adapter"); }
  return { tier, score, reasons };
}

/** Pick the value for a tier. */
export function tierValue<T>(tier: DeviceTier, values: Readonly<Record<DeviceTier, T>>): T {
  return values[tier];
}

export function tierLevel(tier: DeviceTier): number {
  return DEVICE_TIERS.indexOf(tier);
}

export interface FrameTimeMonitorOptions {
  /** Frame budget in ms; frames slower than `budget * slowFactor` count as slow. Default 1000/50. */
  budgetMs?: number;
  /** Smoothed time above `budgetMs * slowFactor` is "slow" (default 1.25). */
  slowFactor?: number;
  /** Smoothed time below `budgetMs * fastFactor` is "fast" (default 0.6). */
  fastFactor?: number;
  /** Seconds of sustained slowness before stepping down (default 2). */
  downgradeAfterS?: number;
  /** Seconds of sustained headroom before stepping back up (default 8). */
  upgradeAfterS?: number;
  /** EMA weight of each new sample (default 0.1). */
  smoothing?: number;
  /** Frames longer than this are ignored (tab switches, GC hitches; default 250 ms). */
  outlierMs?: number;
}

/**
 * Exponentially smoothed frame-time watcher. Feed it every frame's duration; it answers -1 (step
 * down), +1 (step up) or 0. Hysteresis comes from the slow/fast bands plus the dwell times, and
 * the timers reset after every step so one hitch can't cascade.
 */
export class FrameTimeMonitor {
  readonly budgetMs: number;
  private readonly slowMs: number;
  private readonly fastMs: number;
  private readonly downAfter: number;
  private readonly upAfter: number;
  private readonly alpha: number;
  private readonly outlierMs: number;
  /** Smoothed frame time (ms); 0 before the first sample. */
  averageMs = 0;
  private slowFor = 0;
  private fastFor = 0;

  constructor(options: FrameTimeMonitorOptions = {}) {
    this.budgetMs = options.budgetMs ?? 1000 / 50;
    this.slowMs = this.budgetMs * (options.slowFactor ?? 1.25);
    this.fastMs = this.budgetMs * (options.fastFactor ?? 0.6);
    this.downAfter = options.downgradeAfterS ?? 2;
    this.upAfter = options.upgradeAfterS ?? 8;
    this.alpha = options.smoothing ?? 0.1;
    this.outlierMs = options.outlierMs ?? 250;
  }

  sample(frameMs: number): -1 | 0 | 1 {
    if (!(frameMs > 0) || frameMs > this.outlierMs) return 0;
    this.averageMs = this.averageMs === 0 ? frameMs : this.averageMs + (frameMs - this.averageMs) * this.alpha;
    const dt = frameMs / 1000;
    if (this.averageMs > this.slowMs) { this.slowFor += dt; this.fastFor = 0; }
    else if (this.averageMs < this.fastMs) { this.fastFor += dt; this.slowFor = 0; }
    else { this.slowFor = 0; this.fastFor = 0; }
    if (this.slowFor >= this.downAfter) { this.reset(); return -1; }
    if (this.fastFor >= this.upAfter) { this.reset(); return 1; }
    return 0;
  }

  reset(): void {
    this.slowFor = 0;
    this.fastFor = 0;
  }
}

export interface AdaptiveDeviceQualityOptions extends FrameTimeMonitorOptions {
  /** Force the starting tier (e.g. from a `?tier=` query) instead of classifying hints. */
  initialTier?: DeviceTier;
  /** Lowest tier the monitor may drop to (default "low"). */
  floor?: DeviceTier;
}

/**
 * Starting tier from device hints, adjusted at runtime by a {@link FrameTimeMonitor}. The tier
 * never rises above where it started (the ceiling), so a slow phone that hits a quiet moment
 * doesn't bounce up to desktop settings.
 */
export class AdaptiveDeviceQuality {
  readonly initial: DeviceTierResult;
  readonly monitor: FrameTimeMonitor;
  private level: number;
  private readonly ceiling: number;
  private readonly floor: number;
  /** Number of tier changes so far (handy for UI / tests). */
  changes = 0;

  constructor(hints: DeviceCapabilityHints = {}, options: AdaptiveDeviceQualityOptions = {}) {
    const classified = classifyDeviceTier(hints);
    this.initial = options.initialTier ? { ...classified, tier: options.initialTier, reasons: [...classified.reasons, "forced"] } : classified;
    this.level = tierLevel(this.initial.tier);
    this.ceiling = this.level;
    this.floor = tierLevel(options.floor ?? "low");
    this.monitor = new FrameTimeMonitor(options);
  }

  get tier(): DeviceTier {
    return DEVICE_TIERS[this.level]!;
  }

  /** Feed one frame's duration (ms). Returns true when the tier changed. */
  sample(frameMs: number): boolean {
    const step = this.monitor.sample(frameMs);
    if (step === 0) return false;
    const next = Math.max(this.floor, Math.min(this.ceiling, this.level + step));
    if (next === this.level) return false;
    this.level = next;
    this.changes++;
    return true;
  }

  /** Shorthand for `tierValue(this.tier, values)`. */
  value<T>(values: Readonly<Record<DeviceTier, T>>): T {
    return values[this.tier];
  }
}
