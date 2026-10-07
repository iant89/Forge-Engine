/**
 * Blend tree — composes multiple clip weights from 1D or 2D input parameters.
 *
 * A blend tree is a parameterised way to compute blend weights from gameplay parameters (e.g.,
 * speed, direction) without writing per-case logic. It sits alongside `AnimationStateMachine` as
 * a complementary tool: the state machine handles discrete state transitions (idle → walk → run),
 * while the blend tree handles continuous blending within a state (walk-forward vs walk-left vs
 * walk-right).
 *
 * Two blend modes:
 *  - **1D** (`BlendTree1D`): linear interpolation between two or more clips along a single axis.
 *    Clips are sorted by their threshold values; the two bracketing clips get interpolated weights.
 *  - **2D** (`BlendTree2D`): bilinear interpolation among four clips arranged on a 2D plane.
 *    The four clips form a rectangle; weights are computed from the parameter's position inside it.
 *
 * The tree outputs a `BlendResult[]` — clip names with their computed weights. The caller applies
 * them to the `AnimationComponent` (the tree does not own the component).
 *
 * Determinism: pure functions of (thresholds, parameter values). No RNG, no state.
 */

/** A clip entry in a blend tree with its threshold value(s). */
export interface BlendTreeClip {
  /** Clip name (must exist on the AnimationComponent). */
  name: string;
}

/** Result of a blend tree evaluation: a clip name with its computed weight. */
export interface BlendResult {
  name: string;
  weight: number;
}

/**
 * 1D blend tree: interpolates between clips arranged along a single axis.
 *
 * Clips must be sorted by their threshold values (ascending). The tree finds the two clips
 * bracketing the current parameter value and linearly interpolates their weights. Values outside
 * the threshold range clamp to the nearest clip.
 *
 * Example:
 * ```ts
 * const tree = new BlendTree1D([
 *   { name: "idle", threshold: 0 },
 *   { name: "walk", threshold: 0.5 },
 *   { name: "run", threshold: 1.0 },
 * ]);
 * const result = tree.evaluate(0.75); // idle: 0, walk: 0.5, run: 0.5
 * ```
 */
export class BlendTree1D {
  private readonly entries: { name: string; threshold: number }[];

  constructor(entries: { name: string; threshold: number }[]) {
    // Sort by threshold ascending — required for the bracket search.
    this.entries = [...entries].sort((a, b) => a.threshold - b.threshold);
  }

  /**
   * Evaluate the blend weights for a given parameter value.
   *
   * Returns an array of `{ name, weight }` — only the non-zero weights are included.
   * At most two clips have non-zero weight at any time (the bracketing pair).
   */
  evaluate(param: number): BlendResult[] {
    if (this.entries.length === 0) return [];
    if (this.entries.length === 1) return [{ name: this.entries[0]!.name, weight: 1 }];

    // Clamp to the threshold range.
    const first = this.entries[0]!;
    const last = this.entries[this.entries.length - 1]!;
    if (param <= first.threshold) return [{ name: first.name, weight: 1 }];
    if (param >= last.threshold) return [{ name: last.name, weight: 1 }];

    // Find the bracketing pair.
    let lo = 0;
    let hi = this.entries.length - 1;
    while (lo < hi - 1) {
      const mid = (lo + hi) >>> 1;
      if (this.entries[mid]!.threshold <= param) lo = mid;
      else hi = mid;
    }

    const eLo = this.entries[lo]!;
    const eHi = this.entries[hi]!;
    const range = eHi.threshold - eLo.threshold;
    const alpha = range > 0 ? (param - eLo.threshold) / range : 0;

    return [
      { name: eLo.name, weight: 1 - alpha },
      { name: eHi.name, weight: alpha },
    ];
  }

  /** The threshold range. */
  get minThreshold(): number { return this.entries[0]?.threshold ?? 0; }
  get maxThreshold(): number { return this.entries[this.entries.length - 1]?.threshold ?? 0; }
  get clipCount(): number { return this.entries.length; }
}

/**
 * 2D blend tree: bilinear interpolation among four clips arranged on a rectangle.
 *
 * The four clips form a rectangle in 2D parameter space. The parameter (x, y) is clamped to the
 * rectangle, and weights are computed using bilinear interpolation.
 *
 * Layout (standard locomotion blend space):
 * ```
 *   topLeft (−1, +1)    topRight (+1, +1)
 *   bottomLeft (−1, −1)  bottomRight (+1, −1)
 * ```
 *
 * Example:
 * ```ts
 * const tree = new BlendTree2D({
 *   bottomLeft:  { name: "walkLeft",  x: -1, y: -1 },
 *   bottomRight: { name: "walkRight", x: +1, y: -1 },
 *   topLeft:     { name: "runLeft",   x: -1, y: +1 },
 *   topRight:    { name: "runRight",  x: +1, y: +1 },
 * });
 * const result = tree.evaluate(0, 0); // each clip ≈ 0.25
 * ```
 */
export class BlendTree2D {
  private readonly bl: { name: string; x: number; y: number };
  private readonly br: { name: string; x: number; y: number };
  private readonly tl: { name: string; x: number; y: number };
  private readonly tr: { name: string; x: number; y: number };

  constructor(rect: {
    bottomLeft: { name: string; x: number; y: number };
    bottomRight: { name: string; x: number; y: number };
    topLeft: { name: string; x: number; y: number };
    topRight: { name: string; x: number; y: number };
  }) {
    this.bl = rect.bottomLeft;
    this.br = rect.bottomRight;
    this.tl = rect.topLeft;
    this.tr = rect.topRight;
  }

  /**
   * Evaluate the blend weights for a given (x, y) parameter position.
   *
   * Returns four `{ name, weight }` entries — one per corner clip. Weights sum to 1.
   * The parameter is clamped to the rectangle extents.
   */
  evaluate(x: number, y: number): BlendResult[] {
    // Compute the rectangle extents (they may not be ±1).
    const minX = Math.min(this.bl.x, this.tl.x);
    const maxX = Math.max(this.br.x, this.tr.x);
    const minY = Math.min(this.bl.y, this.br.y);
    const maxY = Math.max(this.tl.y, this.tr.y);

    // Clamp.
    const cx = Math.max(minX, Math.min(maxX, x));
    const cy = Math.max(minY, Math.min(maxY, y));

    // Normalised position within the rectangle [0, 1].
    const rangeX = maxX - minX;
    const rangeY = maxY - minY;
    const u = rangeX > 0 ? (cx - minX) / rangeX : 0; // left→right
    const v = rangeY > 0 ? (cy - minY) / rangeY : 0; // bottom→top

    // Bilinear weights.
    const wBL = (1 - u) * (1 - v);
    const wBR = u * (1 - v);
    const wTL = (1 - u) * v;
    const wTR = u * v;

    return [
      { name: this.bl.name, weight: wBL },
      { name: this.br.name, weight: wBR },
      { name: this.tl.name, weight: wTL },
      { name: this.tr.name, weight: wTR },
    ];
  }
}