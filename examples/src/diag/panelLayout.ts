/**
 * Pure geometry + persistence for the draggable/resizable debug panels (see debugPanel.ts).
 * Kept DOM-free so drag/resize clamping, off-screen recovery and storage are unit-testable.
 */

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}
/** Per-side keep-out, in px (safe-area inset + margin). */
export interface Insets {
  l: number;
  t: number;
  r: number;
  b: number;
}
export interface Viewport {
  w: number;
  h: number;
  /** Usable-area keep-out per side (iPhone safe areas + the 10px margin). Absent = none. */
  inset?: Insets;
}

/** The usable box of a viewport: [l, r) × [t, b), never inverted. */
export function bounds(vp: Viewport): { l: number; t: number; r: number; b: number; w: number; h: number } {
  const i = vp.inset ?? { l: 0, t: 0, r: 0, b: 0 };
  const l = Math.max(0, i.l);
  const t = Math.max(0, i.t);
  const r = Math.max(l, vp.w - Math.max(0, i.r));
  const b = Math.max(t, vp.h - Math.max(0, i.b));
  return { l, t, r, b, w: r - l, h: b - t };
}

/** Safe-area insets plus a uniform margin. */
export function withMargin(safe: Insets, margin: number): Insets {
  return { l: safe.l + margin, t: safe.t + margin, r: safe.r + margin, b: safe.b + margin };
}
export interface MinSize {
  w: number;
  h: number;
}
/** Corner the resize handle sits on; the opposite corner stays fixed while resizing. */
export type ResizeCorner = "br" | "tr";

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
}

export interface Layout {
  collapsed: boolean;
  /** null = use the panel's default rect. */
  rect: Rect | null;
  /** Edges the panel was snapped to; re-applied after rotation/resize so it stays flush. */
  snap?: SnapEdges | null;
}

const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);

/** Fit size into the viewport (never below min unless the viewport itself is smaller), then keep it fully on-screen. */
export function clampRect(r: Rect, vp: Viewport, min: MinSize): Rect {
  const B = bounds(vp);
  const w = Math.min(Math.max(r.w, min.w), B.w);
  const h = Math.min(Math.max(r.h, min.h), B.h);
  const x = Math.min(Math.max(r.x, B.l), Math.max(B.l, B.r - w));
  const y = Math.min(Math.max(r.y, B.t), Math.max(B.t, B.b - h));
  return { x, y, w, h };
}

export function dragRect(start: Rect, dx: number, dy: number, vp: Viewport, min: MinSize): Rect {
  return clampRect({ ...start, x: start.x + dx, y: start.y + dy }, vp, min);
}

/** Resize from `corner`; the opposite edge stays put and the result never leaves the viewport. */
export function resizeRect(start: Rect, dx: number, dy: number, corner: ResizeCorner, vp: Viewport, min: MinSize): Rect {
  const B = bounds(vp);
  const maxW = B.r - start.x;
  const w = Math.min(Math.max(start.w + dx, min.w), Math.max(min.w, maxW));
  if (corner === "br") {
    const h = Math.min(Math.max(start.h + dy, min.h), Math.max(min.h, B.b - start.y));
    return clampRect({ x: start.x, y: start.y, w, h }, vp, min);
  }
  // "tr": bottom edge is fixed, the top edge follows the pointer.
  const bottom = start.y + start.h;
  const h = Math.min(Math.max(start.h - dy, min.h), Math.max(min.h, bottom - B.t));
  return clampRect({ x: start.x, y: bottom - h, w, h }, vp, min);
}

/**
 * True when a stored rect is no longer usable on this viewport: invalid numbers, or less than a
 * grabbable strip (`grab` px each way) of it would be visible. Such a layout is reset to the default
 * rather than clamped, so a layout saved on a big screen never comes back squashed into a corner.
 */
export function isOffscreen(r: Rect, vp: Viewport, grab = 44): boolean {
  if (![r.x, r.y, r.w, r.h].every(finite) || r.w <= 0 || r.h <= 0) return true;
  const visW = Math.min(r.x + r.w, vp.w) - Math.max(r.x, 0);
  const visH = Math.min(r.y + r.h, vp.h) - Math.max(r.y, 0);
  return visW < Math.min(grab, r.w) || visH < Math.min(grab, r.h);
}

/** Restore a layout for this viewport: off-screen → default (reset), otherwise clamped. */
export function resolveRect(stored: Rect | null, fallback: Rect, vp: Viewport, min: MinSize): { rect: Rect; reset: boolean } {
  if (!stored || isOffscreen(stored, vp)) return { rect: clampRect(fallback, vp, min), reset: stored !== null };
  return { rect: clampRect(stored, vp, min), reset: false };
}

export function loadLayout(storage: StorageLike | null, key: string, defaultCollapsed: boolean): Layout {
  let raw: string | null = null;
  try {
    raw = storage?.getItem(key) ?? null;
  } catch {
    raw = null;
  }
  if (!raw) return { collapsed: defaultCollapsed, rect: null };
  try {
    const v = JSON.parse(raw) as { collapsed?: unknown; rect?: Partial<Rect> | null; snap?: unknown };
    const collapsed = typeof v.collapsed === "boolean" ? v.collapsed : defaultCollapsed;
    const r = v.rect;
    const rect = r && finite(r.x) && finite(r.y) && finite(r.w) && finite(r.h) ? { x: r.x, y: r.y, w: r.w, h: r.h } : null;
    const sn = v.snap as SnapEdges | null | undefined;
    const snap =
      sn && typeof sn === "object" && (sn.x === "left" || sn.x === "right" || sn.x === undefined) && (sn.y === "top" || sn.y === "bottom" || sn.y === undefined) && (sn.x || sn.y)
        ? { ...(sn.x ? { x: sn.x } : {}), ...(sn.y ? { y: sn.y } : {}) }
        : null;
    return { collapsed, rect, snap };
  } catch {
    return { collapsed: defaultCollapsed, rect: null };
  }
}

export function saveLayout(storage: StorageLike | null, key: string, layout: Layout): void {
  try {
    storage?.setItem(key, JSON.stringify(layout));
  } catch {
    /* private mode / quota: persistence is best-effort */
  }
}

const overlaps = (a: Rect, b: Rect): boolean => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/**
 * Slide a corner icon away from on-screen controls: `up` (bottom corners) or `left` (top corners),
 * past every obstacle it touches, with `gap` px clearance. Stops at the viewport edge.
 */
export function placeIcon(icon: Rect, obstacles: Rect[], dir: "up" | "left", gap = 8, vp?: Viewport): Rect {
  const B = vp ? bounds(vp) : { l: 0, t: 0 };
  const r = { ...icon };
  for (let guard = 0; guard < 32; guard++) {
    const hit = obstacles.find((o) => o.w > 0 && o.h > 0 && overlaps(r, o));
    if (!hit) break;
    if (dir === "up") r.y = hit.y - gap - r.h;
    else r.x = hit.x - gap - r.w;
    if (r.x < B.l || r.y < B.t) {
      r.x = Math.max(B.l, r.x);
      r.y = Math.max(B.t, r.y);
      break;
    }
  }
  return r;
}

// ---------------------------------------------------------------------------------------------
// Edge snapping: hold a dragged panel near an edge for `dwellMs` → ghost of the flush position;
// release while the ghost shows → snap there. Corners snap to two edges.

export interface SnapEdges {
  x?: "left" | "right";
  y?: "top" | "bottom";
}

export function nearEdges(r: Rect, vp: Viewport, threshold: number): SnapEdges | null {
  const B = bounds(vp);
  const e: SnapEdges = {};
  if (r.x - B.l <= threshold) e.x = "left";
  else if (B.r - (r.x + r.w) <= threshold) e.x = "right";
  if (r.y - B.t <= threshold) e.y = "top";
  else if (B.b - (r.y + r.h) <= threshold) e.y = "bottom";
  return e.x || e.y ? e : null;
}

export const sameEdges = (a: SnapEdges | null, b: SnapEdges | null): boolean =>
  (a?.x ?? null) === (b?.x ?? null) && (a?.y ?? null) === (b?.y ?? null) && !!a === !!b;

/** Put `r` flush against `edges` (the other axis keeps its position), then clamp. */
export function snapRect(r: Rect, edges: SnapEdges, vp: Viewport, min: MinSize): Rect {
  const c = clampRect(r, vp, min);
  const B = bounds(vp);
  if (edges.x === "left") c.x = B.l;
  if (edges.x === "right") c.x = Math.max(B.l, B.r - c.w);
  if (edges.y === "top") c.y = B.t;
  if (edges.y === "bottom") c.y = Math.max(B.t, B.b - c.h);
  return c;
}

/**
 * Dwell timer for snapping. Feed every pointermove with the current rect and a clock; call
 * `tick(now)` from a timer too so the ghost appears while the finger is held still (no move events).
 * Changing the set of near edges (or leaving them) restarts the timer and hides the ghost.
 */
export class SnapTracker {
  private edges: SnapEdges | null = null;
  private since = 0;
  private rect: Rect | null = null;
  ghost: Rect | null = null;
  ghostEdges: SnapEdges | null = null;
  constructor(
    private readonly vp: () => Viewport,
    private readonly min: MinSize,
    readonly threshold = 24,
    readonly dwellMs = 2000,
  ) {}
  /** Returns true when the ghost visibility/target changed. */
  update(rect: Rect, now: number): boolean {
    this.rect = rect;
    const e = nearEdges(rect, this.vp(), this.threshold);
    if (!sameEdges(e, this.edges)) {
      this.edges = e;
      this.since = now;
      const had = this.ghost !== null;
      this.ghost = null;
      this.ghostEdges = null;
      return had || this.tick(now);
    }
    return this.tick(now);
  }
  tick(now: number): boolean {
    if (!this.edges || !this.rect || now - this.since < this.dwellMs) return false;
    const g = snapRect(this.rect, this.edges, this.vp(), this.min);
    const changed = !this.ghost || g.x !== this.ghost.x || g.y !== this.ghost.y || g.w !== this.ghost.w || g.h !== this.ghost.h;
    this.ghost = g;
    this.ghostEdges = { ...this.edges };
    return changed;
  }
  /** End of drag: the snapped rect + edges if the ghost was showing, else null. Resets the tracker. */
  release(): { rect: Rect; edges: SnapEdges } | null {
    const out = this.ghost && this.ghostEdges ? { rect: this.ghost, edges: this.ghostEdges } : null;
    this.edges = null;
    this.rect = null;
    this.ghost = null;
    this.ghostEdges = null;
    return out;
  }
}

/** Icon home position in a corner of the usable area. */
export function cornerIcon(corner: "top-right" | "bottom-right", vp: Viewport, size = 44): Rect {
  const B = bounds(vp);
  return { x: B.r - size, y: corner === "top-right" ? B.t : B.b - size, w: size, h: size };
}

/** Read `env(safe-area-inset-*)` from a probe whose padding is set to those env() values. */
export function readInsets(cs: { paddingLeft: string; paddingTop: string; paddingRight: string; paddingBottom: string } | null): Insets {
  const n = (v: string | undefined): number => {
    const x = parseFloat(v ?? "");
    return Number.isFinite(x) && x > 0 ? x : 0;
  };
  return cs ? { l: n(cs.paddingLeft), t: n(cs.paddingTop), r: n(cs.paddingRight), b: n(cs.paddingBottom) } : { l: 0, t: 0, r: 0, b: 0 };
}
