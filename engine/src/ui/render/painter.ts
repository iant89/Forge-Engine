/**
 * `UIPainter` — what an element's `paint` hooks draw with.
 *
 * Elements never see a render pass, pipeline or texture: they emit primitives in logical units and
 * the painter turns them into draw-list instances (`render/drawList.ts`). The painter carries the
 * current clip rectangle, inherited opacity and translate/scale transform as stacks, so custom
 * components get correct clipping, fading and transforms without managing graphics state.
 */

import type { UIColor } from "../core/color.js";
import type { UICorners, UIInsets } from "../core/geometry.js";
import type { GradientDirection } from "../style/types.js";
import type { TextLayoutResult } from "../text/textLayout.js";

export interface BoxPaint {
  background?: UIColor;
  backgroundEnd?: UIColor;
  gradient?: GradientDirection;
  borderColor?: UIColor;
  borderWidth?: number;
  radius?: number | Readonly<UICorners>;
  shadowColor?: UIColor;
  shadowOffsetX?: number;
  shadowOffsetY?: number;
  shadowBlur?: number;
}

export interface ImagePaint {
  tint?: UIColor;
  /** Nine-slice borders in source pixels (requires a known texture size). */
  slice?: Readonly<UIInsets> | null;
  /** Sub-rectangle of the texture in pixels (sprite in an atlas); default whole texture. */
  source?: { x: number; y: number; width: number; height: number } | null;
  /** Rounded corners (stretched images only); `width / 2` makes a circle. */
  radius?: number;
}

export interface UIPainter {
  /** Rounded/bordered/gradient/shadowed box. */
  box(x: number, y: number, width: number, height: number, paint: Readonly<BoxPaint>): void;
  /** Solid rectangle (radius optional) — the cheap path for bars, separators, carets. */
  fillRect(x: number, y: number, width: number, height: number, color: UIColor, radius?: number): void;
  /** Rectangle outline of `thickness`. */
  strokeRect(x: number, y: number, width: number, height: number, color: UIColor, thickness?: number, radius?: number): void;
  /** Texture or atlas sprite by registered name; missing names are reported once and drawn as a magenta box. */
  image(name: string, x: number, y: number, width: number, height: number, paint?: Readonly<ImagePaint>): void;
  /** Circular arc (ring segment) from `startAngle` to `endAngle` radians, clockwise from 12 o'clock. */
  arc(cx: number, cy: number, radius: number, thickness: number, startAngle: number, endAngle: number, color: UIColor): void;
  /** A laid-out text block (from `TextEngine.layout`) with its top-left at (x, y). */
  text(layout: TextLayoutResult, x: number, y: number, color: UIColor): void;
  pushClip(x: number, y: number, width: number, height: number): void;
  popClip(): void;
  pushOpacity(alpha: number): void;
  popOpacity(): void;
  /** Translate then scale about (originX, originY). */
  pushTransform(tx: number, ty: number, scale: number, originX: number, originY: number): void;
  popTransform(): void;
  /** Current effective clip in logical units (after transforms), for culling. */
  readonly clipX0: number;
  readonly clipY0: number;
  readonly clipX1: number;
  readonly clipY1: number;
}
