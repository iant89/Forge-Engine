/**
 * UI geometry: rectangles, sizes, edge insets and the viewport's coordinate systems.
 *
 * Every layout, hit-test and draw coordinate in the UI is in **logical units** relative to the
 * top-left of the UI viewport, +X right and +Y down (screen convention, unlike the 3D world's +Y
 * up). `UIViewport` owns the single conversion between logical units and physical swapchain pixels
 * (`devicePixelRatio × uiScale`); the GPU backend and the input adapter both use it, so what is drawn
 * and what is hit can never disagree.
 */

export interface UISize {
  width: number;
  height: number;
}

export interface UIPoint {
  x: number;
  y: number;
}

/** Axis-aligned rectangle in logical units. */
export class UIRect {
  constructor(
    public x = 0,
    public y = 0,
    public width = 0,
    public height = 0,
  ) {}

  get right(): number {
    return this.x + this.width;
  }

  get bottom(): number {
    return this.y + this.height;
  }

  set(x: number, y: number, width: number, height: number): this {
    this.x = x;
    this.y = y;
    this.width = width;
    this.height = height;
    return this;
  }

  copy(r: Readonly<UIRect>): this {
    return this.set(r.x, r.y, r.width, r.height);
  }

  clone(): UIRect {
    return new UIRect(this.x, this.y, this.width, this.height);
  }

  equals(r: Readonly<UIRect>): boolean {
    return this.x === r.x && this.y === r.y && this.width === r.width && this.height === r.height;
  }

  contains(px: number, py: number): boolean {
    return px >= this.x && py >= this.y && px < this.x + this.width && py < this.y + this.height;
  }

  intersects(r: Readonly<UIRect>): boolean {
    return r.x < this.x + this.width && r.x + r.width > this.x && r.y < this.y + this.height && r.y + r.height > this.y;
  }

  /** Intersect in place; an empty result has zero width/height (never negative). */
  intersect(r: Readonly<UIRect>): this {
    const x0 = Math.max(this.x, r.x);
    const y0 = Math.max(this.y, r.y);
    const x1 = Math.min(this.x + this.width, r.x + r.width);
    const y1 = Math.min(this.y + this.height, r.y + r.height);
    return this.set(x0, y0, Math.max(0, x1 - x0), Math.max(0, y1 - y0));
  }

  /** Shrink by insets (clamped so the size never goes negative). */
  deflate(i: Readonly<UIInsets>): this {
    const w = Math.max(0, this.width - i.left - i.right);
    const h = Math.max(0, this.height - i.top - i.bottom);
    return this.set(this.x + i.left, this.y + i.top, w, h);
  }

  get isEmpty(): boolean {
    return this.width <= 0 || this.height <= 0;
  }

  /** True when every component is a finite number and the size is non-negative. */
  get isValid(): boolean {
    return Number.isFinite(this.x) && Number.isFinite(this.y) && Number.isFinite(this.width) && Number.isFinite(this.height) && this.width >= 0 && this.height >= 0;
  }
}

/** Edge insets (padding, margin, safe areas, nine-slice borders). */
export interface UIInsets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export const ZERO_INSETS: Readonly<UIInsets> = Object.freeze({ top: 0, right: 0, bottom: 0, left: 0 });

/** Insets shorthand: one value, `[vertical, horizontal]`, or `[top, right, bottom, left]` (CSS order). */
export type InsetsInput = number | readonly [number, number] | readonly [number, number, number, number] | Partial<UIInsets>;

export function toInsets(input: InsetsInput | undefined, out: UIInsets = { top: 0, right: 0, bottom: 0, left: 0 }): UIInsets {
  if (input === undefined) {
    out.top = out.right = out.bottom = out.left = 0;
  } else if (typeof input === "number") {
    out.top = out.right = out.bottom = out.left = input;
  } else if (Array.isArray(input)) {
    if (input.length === 2) {
      out.top = out.bottom = input[0]!;
      out.left = out.right = input[1]!;
    } else {
      out.top = input[0]!;
      out.right = input[1]!;
      out.bottom = input[2]!;
      out.left = input[3]!;
    }
  } else {
    const p = input as Partial<UIInsets>;
    out.top = p.top ?? 0;
    out.right = p.right ?? 0;
    out.bottom = p.bottom ?? 0;
    out.left = p.left ?? 0;
  }
  return out;
}

export function insetsEqual(a: Readonly<UIInsets>, b: Readonly<UIInsets>): boolean {
  return a.top === b.top && a.right === b.right && a.bottom === b.bottom && a.left === b.left;
}

/** Corner radii, clockwise from top-left. */
export interface UICorners {
  topLeft: number;
  topRight: number;
  bottomRight: number;
  bottomLeft: number;
}

export type CornersInput = number | readonly [number, number, number, number] | Partial<UICorners>;

export function toCorners(input: CornersInput | undefined, out: UICorners = { topLeft: 0, topRight: 0, bottomRight: 0, bottomLeft: 0 }): UICorners {
  if (input === undefined) out.topLeft = out.topRight = out.bottomRight = out.bottomLeft = 0;
  else if (typeof input === "number") out.topLeft = out.topRight = out.bottomRight = out.bottomLeft = input;
  else if (Array.isArray(input)) {
    out.topLeft = input[0]!;
    out.topRight = input[1]!;
    out.bottomRight = input[2]!;
    out.bottomLeft = input[3]!;
  } else {
    const c = input as Partial<UICorners>;
    out.topLeft = c.topLeft ?? 0;
    out.topRight = c.topRight ?? 0;
    out.bottomRight = c.bottomRight ?? 0;
    out.bottomLeft = c.bottomLeft ?? 0;
  }
  return out;
}

/**
 * The UI viewport: physical size, device-pixel ratio, user UI scale and safe-area insets.
 *
 * `scale = devicePixelRatio × uiScale` physical pixels per logical unit. Safe-area insets are given
 * in **logical** units (what platform APIs such as CSS `env(safe-area-inset-*)` report once divided
 * by the UI scale), and are applied by `SafeArea` containers, never silently to the whole tree.
 */
export class UIViewport {
  physicalWidth = 1;
  physicalHeight = 1;
  devicePixelRatio = 1;
  uiScale = 1;
  readonly safeArea: UIInsets = { top: 0, right: 0, bottom: 0, left: 0 };

  get scale(): number {
    return this.devicePixelRatio * this.uiScale;
  }

  get width(): number {
    return this.physicalWidth / this.scale;
  }

  get height(): number {
    return this.physicalHeight / this.scale;
  }

  /** Physical pixel (e.g. a pointer position × dpr) → logical units. */
  physicalToLogical(px: number, py: number, out: UIPoint = { x: 0, y: 0 }): UIPoint {
    const s = this.scale;
    out.x = px / s;
    out.y = py / s;
    return out;
  }

  logicalToPhysical(x: number, y: number, out: UIPoint = { x: 0, y: 0 }): UIPoint {
    const s = this.scale;
    out.x = x * s;
    out.y = y * s;
    return out;
  }

  /** CSS pixel (DOM event `offsetX`) → logical units. */
  cssToLogical(cx: number, cy: number, out: UIPoint = { x: 0, y: 0 }): UIPoint {
    out.x = cx / this.uiScale;
    out.y = cy / this.uiScale;
    return out;
  }
}
