/**
 * Responsive UI: breakpoints with hysteresis, reference-resolution scaling, and per-element profiles.
 *
 * Breakpoints are named minimum logical widths (`compact ≥ 0`, `medium ≥ 640`, `expanded ≥ 1024` by
 * default — override with your own). Moving *up* a breakpoint requires the width to exceed its
 * threshold by `hysteresis`, moving *down* requires falling below the threshold by the same margin,
 * so a window dragged to sit on a boundary does not thrash between layouts.
 *
 * A **responsive profile** is a set of per-breakpoint rules for one element: layout properties,
 * visibility, variant and style overrides. When the breakpoint changes the manager applies
 * `snapshot ← default ← rule[breakpoint]` — the snapshot is the element's own values for every key
 * any rule touches, taken when the profile was set, so leaving a breakpoint restores what was there.
 * Aspects no rule mentions (visibility, variant, style, layout) are never written, so a profile does
 * not fight other owners of them (a TabContainer hiding its inactive pages, app code toggling a panel).
 * The tree is never rebuilt; only the affected elements invalidate.
 *
 * Scaling: `scaleMode: "fixed"` keeps `uiScale` as set. A reference-resolution mode computes
 * `uiScale = exp(lerp(ln(w / refW), ln(h / refH), match))` clamped to `[min, max]` (match 0 = scale
 * with width, 1 = with height), or the smaller (`"expand"`) / larger (`"shrink"`) ratio. The manager
 * defaults to `DEFAULT_SCALE_MODE` (1280×720, expand, never below 1). Scaling is combined with
 * breakpoints, not a substitute for them: breakpoints read the *logical* width after scaling.
 */

import { UsageError } from "../core/errors.js";
import type { UIElement } from "./core/element.js";
import type { LayoutPropsInput } from "./layout/types.js";
import type { StyleBlock } from "./style/types.js";

export interface Breakpoint {
  name: string;
  minWidth: number;
}

export const DEFAULT_BREAKPOINTS: readonly Breakpoint[] = [
  { name: "compact", minWidth: 0 },
  { name: "medium", minWidth: 640 },
  { name: "expanded", minWidth: 1024 },
];

export class BreakpointSet {
  private list: Breakpoint[];
  private _current: Breakpoint | null = null;
  hysteresis: number;

  constructor(breakpoints: readonly Breakpoint[] = DEFAULT_BREAKPOINTS, hysteresis = 12) {
    this.list = BreakpointSet.validate(breakpoints);
    this.hysteresis = hysteresis;
  }

  static validate(bps: readonly Breakpoint[]): Breakpoint[] {
    if (bps.length === 0) throw new UsageError("ui breakpoints: at least one breakpoint is required");
    const sorted = [...bps].sort((a, b) => a.minWidth - b.minWidth);
    const names = new Set<string>();
    for (const b of sorted) {
      if (names.has(b.name)) throw new UsageError(`ui breakpoints: duplicate name "${b.name}"`);
      if (!(b.minWidth >= 0)) throw new UsageError(`ui breakpoints: "${b.name}" minWidth must be >= 0`);
      names.add(b.name);
    }
    if (sorted[0]!.minWidth !== 0) sorted[0] = { ...sorted[0]!, minWidth: 0 };
    return sorted;
  }

  set(breakpoints: readonly Breakpoint[]): void {
    this.list = BreakpointSet.validate(breakpoints);
    this._current = null;
  }

  get breakpoints(): readonly Breakpoint[] {
    return this.list;
  }

  get current(): string {
    return this._current?.name ?? this.list[0]!.name;
  }

  /** Evaluate for a logical width. Returns true if the breakpoint changed. */
  update(width: number): boolean {
    let target = this.list[0]!;
    for (const b of this.list) if (width >= b.minWidth) target = b;
    const cur = this._current;
    if (!cur) {
      this._current = target;
      return true;
    }
    if (target === cur) return false;
    const h = this.hysteresis;
    if (target.minWidth > cur.minWidth) {
      // Going up: the width must clear the target's threshold by the hysteresis margin; otherwise
      // we may still step up to an intermediate breakpoint that it does clear.
      let best = cur;
      for (const b of this.list) if (b.minWidth > cur.minWidth && width >= b.minWidth + h) best = b;
      if (best === cur) return false;
      this._current = best;
      return true;
    }
    // Going down: leave the current breakpoint only when clearly below its threshold.
    if (width >= cur.minWidth - h) return false;
    let best = this.list[0]!;
    for (const b of this.list) if (width >= b.minWidth - h && b.minWidth < cur.minWidth) best = b;
    this._current = best;
    return true;
  }
}

/**
 * How the UI scale follows the viewport. `match` is a number in [0, 1] (log-space blend of the width
 * and height ratios), `"expand"` (the smaller ratio: the whole reference layout always fits) or
 * `"shrink"` (the larger ratio: the reference layout always fills, cropping the other axis).
 */
export type ScaleMode = "fixed" | { referenceWidth: number; referenceHeight: number; match?: number | "expand" | "shrink"; min?: number; max?: number };

/**
 * The default: a UI authored for a 1280×720 (CSS pixel) window grows with the viewport so it fills a
 * large monitor at the same proportions (1920×1080 → 1.5, 2560×1440 → 2), and never shrinks below
 * its authored size — phones, tablets and small windows keep scale 1 and adapt through breakpoints,
 * so text stays at its designed size where screens are small.
 */
export const DEFAULT_SCALE_MODE: ScaleMode = Object.freeze({ referenceWidth: 1280, referenceHeight: 720, match: "expand", min: 1, max: 3 });

/** UI scale for a physical size under a scale mode (`fixedScale` is returned for "fixed"). */
export function computeUiScale(mode: ScaleMode, cssWidth: number, cssHeight: number, fixedScale: number): number {
  if (mode === "fixed") return fixedScale;
  const rw = Math.max(1e-6, cssWidth / mode.referenceWidth);
  const rh = Math.max(1e-6, cssHeight / mode.referenceHeight);
  let s: number;
  if (mode.match === "expand") s = Math.min(rw, rh);
  else if (mode.match === "shrink") s = Math.max(rw, rh);
  else {
    const match = Math.max(0, Math.min(1, mode.match ?? 0.5));
    s = Math.exp(Math.log(rw) + (Math.log(rh) - Math.log(rw)) * match);
  }
  return Math.max(mode.min ?? 0.25, Math.min(mode.max ?? 4, s));
}

export interface ResponsiveRule {
  layout?: LayoutPropsInput;
  visible?: boolean;
  variant?: string | null;
  style?: StyleBlock | null;
  /** Arbitrary per-breakpoint tweak (e.g. change a grid's columns); runs after the declarative parts. */
  apply?: (el: UIElement) => void;
}

/** Rules keyed by breakpoint name; `default` applies to breakpoints without their own rule. */
export type ResponsiveRules = Record<string, ResponsiveRule>;

interface Snapshot {
  layout: LayoutPropsInput;
  visible: boolean;
  variant: string | null;
  style: StyleBlock | null;
}

const LAYOUT_KEYS = [
  "position",
  "width",
  "height",
  "minWidth",
  "minHeight",
  "maxWidth",
  "maxHeight",
  "aspectRatio",
  "flexGrow",
  "flexShrink",
  "flexBasis",
  "alignSelf",
  "justifySelf",
  "column",
  "row",
  "columnSpan",
  "rowSpan",
  "zIndex",
] as const;

export class ResponsiveProfile {
  private readonly snapshot: Snapshot;
  /** Breakpoint applied last (diagnostics). */
  applied: string | null = null;

  constructor(
    readonly element: UIElement,
    readonly rules: ResponsiveRules,
  ) {
    const keys = new Set<string>();
    for (const r of Object.values(rules)) for (const k of Object.keys(r.layout ?? {})) keys.add(k);
    const layout: Record<string, unknown> = {};
    const props = element.props as unknown as Record<string, unknown>;
    for (const k of keys) {
      if (k === "margin") layout.margin = { ...element.marginBox };
      else if (k === "padding") layout.padding = { ...element.paddingBox };
      else if (k === "anchor") {
        const a = element.props.anchor;
        // Compiled lengths are valid inputs (parseLength passes Length objects through).
        layout.anchor = a
          ? { left: a.left ?? undefined, top: a.top ?? undefined, right: a.right ?? undefined, bottom: a.bottom ?? undefined, centerX: a.centerX ?? undefined, centerY: a.centerY ?? undefined }
          : undefined;
      }
      else if ((LAYOUT_KEYS as readonly string[]).includes(k)) layout[k] = props[k];
      else throw new UsageError(`ui responsive: unknown layout property "${k}"`);
    }
    this.snapshot = { layout: layout as LayoutPropsInput, visible: element.visible, variant: element.variant, style: element.style };
    const all = Object.values(rules);
    this.touches = {
      layout: keys.size > 0,
      visible: all.some((r) => r.visible !== undefined),
      variant: all.some((r) => r.variant !== undefined),
      style: all.some((r) => r.style !== undefined),
    };
  }

  /** Which aspects any rule sets. Untouched aspects stay under the element's (or app's) control. */
  private readonly touches: { layout: boolean; visible: boolean; variant: boolean; style: boolean };

  apply(breakpoint: string): void {
    const el = this.element;
    if (el.disposed) return;
    const rule = this.rules[breakpoint] ?? this.rules.default ?? {};
    const base = this.rules.default ?? {};
    const t = this.touches;
    if (t.layout) el.setLayout({ ...this.snapshot.layout, ...(base.layout ?? {}), ...(rule.layout ?? {}) });
    if (t.visible) el.visible = rule.visible ?? base.visible ?? this.snapshot.visible;
    if (t.variant) el.variant = rule.variant !== undefined ? rule.variant : base.variant !== undefined ? base.variant : this.snapshot.variant;
    if (t.style) {
      const style = rule.style !== undefined ? rule.style : base.style !== undefined ? base.style : this.snapshot.style;
      if (style !== el.style) el.style = style;
    }
    base.apply?.(el);
    if (rule !== base) rule.apply?.(el);
    this.applied = breakpoint;
  }
}
