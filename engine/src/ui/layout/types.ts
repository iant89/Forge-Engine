/**
 * Layout vocabulary: lengths, per-element layout properties and the strategy contract.
 *
 * A **length** is a number (logical units), `"auto"`, a percentage of the parent's content box
 * (`"50%"`), or a viewport fraction (`"10vw"`, `"10vh"`). Lengths are compiled once when set, so the
 * layout pass never parses strings.
 *
 * Percentages resolve against the parent's *definite* content size on that axis. When the parent's
 * size on that axis is indefinite (it is itself sized by its content and the available space is
 * unbounded) a percentage behaves as `auto` — the CSS rule, and the one that makes a cycle between a
 * parent sized by its children and a child sized by its parent impossible.
 */

import { UsageError } from "../../core/errors.js";
import type { InsetsInput, UIRect } from "../core/geometry.js";

export const enum LengthUnit {
  Px = 0,
  Percent = 1,
  Vw = 2,
  Vh = 3,
  Auto = 4,
}

export interface Length {
  readonly unit: LengthUnit;
  readonly value: number;
}

export type LengthInput = number | "auto" | `${number}%` | `${number}vw` | `${number}vh`;

export const AUTO: Length = Object.freeze({ unit: LengthUnit.Auto, value: 0 });
const PX_CACHE = new Map<number, Length>();

export function px(value: number): Length {
  let l = PX_CACHE.get(value);
  if (!l) {
    l = Object.freeze({ unit: LengthUnit.Px, value });
    if (PX_CACHE.size < 4096) PX_CACHE.set(value, l);
  }
  return l;
}

export function parseLength(input: LengthInput | Length | undefined): Length {
  if (input === undefined || input === "auto") return AUTO;
  if (typeof input === "number") {
    if (!Number.isFinite(input) || input < 0) throw new UsageError(`ui layout: length ${input} must be a finite, non-negative number`);
    return px(input);
  }
  if (typeof input === "object") return input;
  const m = /^(-?[\d.]+)(%|vw|vh)$/.exec(input);
  if (!m) throw new UsageError(`ui layout: "${input}" is not a length (number, "auto", "N%", "Nvw" or "Nvh")`);
  const value = Number(m[1]);
  if (!Number.isFinite(value) || value < 0) throw new UsageError(`ui layout: "${input}" must be non-negative`);
  const unit = m[2] === "%" ? LengthUnit.Percent : m[2] === "vw" ? LengthUnit.Vw : LengthUnit.Vh;
  return Object.freeze({ unit, value });
}

export function lengthToString(l: Length): string {
  switch (l.unit) {
    case LengthUnit.Px:
      return String(l.value);
    case LengthUnit.Percent:
      return `${l.value}%`;
    case LengthUnit.Vw:
      return `${l.value}vw`;
    case LengthUnit.Vh:
      return `${l.value}vh`;
    default:
      return "auto";
  }
}

/**
 * Resolve a length to logical units, or `NaN` for "no definite value" (auto, or a percentage of an
 * indefinite parent size). `NaN` rather than `undefined` keeps the hot path number-typed.
 */
export function resolveLength(l: Length, parentSize: number, viewportW: number, viewportH: number): number {
  switch (l.unit) {
    case LengthUnit.Px:
      return l.value;
    case LengthUnit.Percent:
      return Number.isFinite(parentSize) ? (parentSize * l.value) / 100 : NaN;
    case LengthUnit.Vw:
      return (viewportW * l.value) / 100;
    case LengthUnit.Vh:
      return (viewportH * l.value) / 100;
    default:
      return NaN;
  }
}

export type Align = "start" | "center" | "end" | "stretch";
export type Justify = "start" | "center" | "end" | "space-between" | "space-around" | "space-evenly";

/** Anchor edges for children of an anchor (free-form) container or absolutely positioned children. */
export interface AnchorInput {
  left?: LengthInput;
  top?: LengthInput;
  right?: LengthInput;
  bottom?: LengthInput;
  /** Centre horizontally, offset by this many units (0 = exact centre). */
  centerX?: number;
  centerY?: number;
}

export interface CompiledAnchor {
  left: Length | null;
  top: Length | null;
  right: Length | null;
  bottom: Length | null;
  centerX: number | null;
  centerY: number | null;
}

/** What an element can say about its own layout, independent of the container's algorithm. */
export interface LayoutPropsInput {
  /** `"absolute"` removes the element from its container's flow and places it by `anchor`. */
  position?: "flow" | "absolute";
  width?: LengthInput;
  height?: LengthInput;
  minWidth?: LengthInput;
  minHeight?: LengthInput;
  maxWidth?: LengthInput;
  maxHeight?: LengthInput;
  /** width / height; applied when exactly one axis is definite. */
  aspectRatio?: number;
  margin?: InsetsInput;
  /** Overrides the skin's padding when set. */
  padding?: InsetsInput;
  flexGrow?: number;
  flexShrink?: number;
  flexBasis?: LengthInput;
  /** Cross-axis alignment override inside flex; both axes inside stack. */
  alignSelf?: Align;
  justifySelf?: Align;
  /** Grid placement, 1-based like CSS. Unplaced items flow into the next free cell. */
  column?: number;
  row?: number;
  columnSpan?: number;
  rowSpan?: number;
  anchor?: AnchorInput;
  /** Paint and hit-test order among siblings (stable for ties). */
  zIndex?: number;
}

export interface LayoutContext {
  readonly viewportWidth: number;
  readonly viewportHeight: number;
}

/** Minimal view of an element a layout strategy needs (implemented by `UIElement`). */
export interface LayoutNode {
  readonly layoutChildren: readonly LayoutNode[];
  readonly marginBox: { top: number; right: number; bottom: number; left: number };
  readonly paddingBox: { top: number; right: number; bottom: number; left: number };
  readonly props: Readonly<CompiledLayoutProps>;
  readonly isFlowChild: boolean;
  /** Desired border-box size for the available space (∞ = unbounded). Cached by the element. */
  measure(availableWidth: number, availableHeight: number, ctx: LayoutContext): { width: number; height: number };
  arrange(rect: UIRect, ctx: LayoutContext): void;
  /** Resolved fixed size on an axis given the parent's content size, or NaN. */
  definiteWidth(parentContentWidth: number, ctx: LayoutContext): number;
  definiteHeight(parentContentHeight: number, ctx: LayoutContext): number;
  clampWidth(w: number, parentContentWidth: number, ctx: LayoutContext): number;
  clampHeight(h: number, parentContentHeight: number, ctx: LayoutContext): number;
}

export interface CompiledLayoutProps {
  position: "flow" | "absolute";
  width: Length;
  height: Length;
  minWidth: Length;
  minHeight: Length;
  maxWidth: Length;
  maxHeight: Length;
  aspectRatio: number;
  flexGrow: number;
  flexShrink: number;
  flexBasis: Length;
  alignSelf: Align | null;
  justifySelf: Align | null;
  column: number;
  row: number;
  columnSpan: number;
  rowSpan: number;
  anchor: CompiledAnchor | null;
  zIndex: number;
}

/**
 * A container's layout algorithm. `measureContent` returns the content-box size the children need
 * for the available content space; `arrangeContent` places the children inside `content` (content
 * box, logical units). Strategies are stateless across elements; per-container scratch lives in the
 * strategy instance, which belongs to exactly one container.
 */
export interface LayoutStrategy {
  readonly kind: string;
  measureContent(node: LayoutNode, availableWidth: number, availableHeight: number, ctx: LayoutContext): { width: number; height: number };
  arrangeContent(node: LayoutNode, content: UIRect, ctx: LayoutContext): void;
}

export function compileAnchor(a: AnchorInput | undefined): CompiledAnchor | null {
  if (!a) return null;
  const opt = (l: LengthInput | undefined): Length | null => (l === undefined ? null : parseLength(l));
  const anchor: CompiledAnchor = {
    left: opt(a.left),
    top: opt(a.top),
    right: opt(a.right),
    bottom: opt(a.bottom),
    centerX: a.centerX ?? null,
    centerY: a.centerY ?? null,
  };
  if (anchor.centerX !== null && (anchor.left || anchor.right)) throw new UsageError("ui layout: anchor.centerX cannot be combined with left/right");
  if (anchor.centerY !== null && (anchor.top || anchor.bottom)) throw new UsageError("ui layout: anchor.centerY cannot be combined with top/bottom");
  return anchor;
}

export function defaultLayoutProps(): CompiledLayoutProps {
  return {
    position: "flow",
    width: AUTO,
    height: AUTO,
    minWidth: AUTO,
    minHeight: AUTO,
    maxWidth: AUTO,
    maxHeight: AUTO,
    aspectRatio: 0,
    flexGrow: 0,
    flexShrink: 1,
    flexBasis: AUTO,
    alignSelf: null,
    justifySelf: null,
    column: 0,
    row: 0,
    columnSpan: 1,
    rowSpan: 1,
    anchor: null,
    zIndex: 0,
  };
}

/** Apply a partial input onto compiled props, validating each field. */
export function applyLayoutInput(target: CompiledLayoutProps, input: LayoutPropsInput): void {
  if (input.position !== undefined) target.position = input.position;
  if ("width" in input) target.width = parseLength(input.width);
  if ("height" in input) target.height = parseLength(input.height);
  if ("minWidth" in input) target.minWidth = parseLength(input.minWidth);
  if ("minHeight" in input) target.minHeight = parseLength(input.minHeight);
  if ("maxWidth" in input) target.maxWidth = parseLength(input.maxWidth);
  if ("maxHeight" in input) target.maxHeight = parseLength(input.maxHeight);
  if (input.aspectRatio !== undefined) {
    if (!(input.aspectRatio >= 0) || !Number.isFinite(input.aspectRatio)) throw new UsageError("ui layout: aspectRatio must be a finite number >= 0");
    target.aspectRatio = input.aspectRatio;
  }
  if (input.flexGrow !== undefined) target.flexGrow = nonNegative("flexGrow", input.flexGrow);
  if (input.flexShrink !== undefined) target.flexShrink = nonNegative("flexShrink", input.flexShrink);
  if ("flexBasis" in input) target.flexBasis = parseLength(input.flexBasis);
  if (input.alignSelf !== undefined) target.alignSelf = input.alignSelf;
  if (input.justifySelf !== undefined) target.justifySelf = input.justifySelf;
  if (input.column !== undefined) target.column = positiveInt("column", input.column);
  if (input.row !== undefined) target.row = positiveInt("row", input.row);
  if (input.columnSpan !== undefined) target.columnSpan = positiveInt("columnSpan", input.columnSpan);
  if (input.rowSpan !== undefined) target.rowSpan = positiveInt("rowSpan", input.rowSpan);
  if ("anchor" in input) target.anchor = compileAnchor(input.anchor);
  if (input.zIndex !== undefined) target.zIndex = input.zIndex;
}

function nonNegative(name: string, v: number): number {
  if (!(v >= 0) || !Number.isFinite(v)) throw new UsageError(`ui layout: ${name} must be a finite number >= 0 (got ${v})`);
  return v;
}

function positiveInt(name: string, v: number): number {
  if (!Number.isInteger(v) || v < 1) throw new UsageError(`ui layout: ${name} must be an integer >= 1 (got ${v})`);
  return v;
}
