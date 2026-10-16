/**
 * `UIDrawList` + `DrawListPainter` — the renderer-independent output of a UI frame.
 *
 * Every primitive becomes one fixed-size **instance** (36 floats, see `INSTANCE_FLOATS`): a quad
 * with its own colours, per-corner radii, border, kind and **clip rectangle**. Because clipping is
 * per instance (the fragment shader discards outside it), entering or leaving a scroll view never
 * breaks a batch. A batch is a run of consecutive instances that can share one bound texture:
 * untextured instances (boxes, shadows, arcs) join whatever batch is open, and only a textured
 * instance that needs a *different* texture starts a new batch. Instances are never reordered, so
 * translucent overlap is painted exactly in tree order.
 *
 * The draw list is rebuilt only when the UI is render-dirty; a static UI reuses the previous one and
 * the GPU backend skips its upload (`version` unchanged).
 */

import { colorA, writeColorFloats, type UIColor } from "../core/color.js";
import type { UICorners, UIInsets } from "../core/geometry.js";
import type { BoxPaint, ImagePaint, UIPainter } from "./painter.js";
import type { TextLayoutResult } from "../text/textLayout.js";
import { boldness } from "../text/textLayout.js";

export const INSTANCE_FLOATS = 36;
export const INSTANCE_BYTES = INSTANCE_FLOATS * 4;

export const enum PrimitiveKind {
  Box = 0,
  Shadow = 1,
  Image = 2,
  GlyphSdf = 3,
  GlyphMask = 4,
  Arc = 5,
}

/** Instance field offsets (floats). */
export const F = {
  rect: 0,
  uv: 4,
  color0: 8,
  color1: 12,
  border: 16,
  radii: 20,
  clip: 24,
  borderWidth: 28,
  kind: 29,
  p0: 30,
  p1: 31,
  p2: 32,
} as const;

export interface DrawBatch {
  /** Texture name, or null for a batch with only untextured instances. */
  texture: string | null;
  first: number;
  count: number;
}

export interface DrawListStats {
  instances: number;
  batches: number;
  culled: number;
  glyphs: number;
  elementsPainted: number;
}

export class UIDrawList {
  data = new Float32Array(INSTANCE_FLOATS * 256);
  count = 0;
  readonly batches: DrawBatch[] = [];
  private batchPool: DrawBatch[] = [];
  /** Bumped on every rebuild (the GPU backend uploads when it changes). */
  version = 0;
  readonly stats: DrawListStats = { instances: 0, batches: 0, culled: 0, glyphs: 0, elementsPainted: 0 };

  reset(): void {
    this.count = 0;
    for (const b of this.batches) this.batchPool.push(b);
    this.batches.length = 0;
    this.stats.instances = this.stats.batches = this.stats.culled = this.stats.glyphs = this.stats.elementsPainted = 0;
  }

  finish(): void {
    this.version++;
    this.stats.instances = this.count;
    this.stats.batches = this.batches.length;
  }

  /** Reserve one instance; returns its float offset. `texture` decides batching. */
  push(texture: string | null): number {
    if ((this.count + 1) * INSTANCE_FLOATS > this.data.length) {
      const grown = new Float32Array(this.data.length * 2);
      grown.set(this.data);
      this.data = grown;
    }
    const last = this.batches[this.batches.length - 1];
    if (!last || (texture !== null && last.texture !== null && last.texture !== texture)) {
      const b = this.batchPool.pop() ?? { texture: null, first: 0, count: 0 };
      b.texture = texture;
      b.first = this.count;
      b.count = 0;
      this.batches.push(b);
    } else if (texture !== null && last.texture === null) {
      last.texture = texture;
    }
    this.batches[this.batches.length - 1]!.count++;
    const o = this.count * INSTANCE_FLOATS;
    this.count++;
    return o;
  }

  /** Read one instance's kind (tests/diagnostics). */
  kindAt(i: number): PrimitiveKind {
    return this.data[i * INSTANCE_FLOATS + F.kind]! as PrimitiveKind;
  }

  /** Read one instance's rect (tests/diagnostics). */
  rectAt(i: number): [number, number, number, number] {
    const o = i * INSTANCE_FLOATS;
    return [this.data[o]!, this.data[o + 1]!, this.data[o + 2]!, this.data[o + 3]!];
  }
}

/** What `image()` needs to know about a texture or sprite name. */
export interface ImageSource {
  texture: string;
  /** Texture size in pixels. */
  textureWidth: number;
  textureHeight: number;
  /** Source rectangle in pixels. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** Default nine-slice for the sprite (overridden by the paint's `slice`). */
  slice: Readonly<UIInsets> | null;
}

export type ImageResolver = (name: string) => ImageSource | null;

const MISSING_COLOR: UIColor = 0xff00ffff;

interface ClipEntry {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

interface TransformEntry {
  s: number;
  dx: number;
  dy: number;
}

export class DrawListPainter implements UIPainter {
  private list: UIDrawList;
  private readonly clips: ClipEntry[] = [];
  private clipDepth = 0;
  private readonly opacities: number[] = [1];
  private readonly transforms: TransformEntry[] = [{ s: 1, dx: 0, dy: 0 }];
  private transformDepth = 0;
  private alpha = 1;
  /** Called once per missing image name. */
  onMissingImage: (name: string) => void = () => {};
  private readonly reportedMissing = new Set<string>();

  constructor(
    list: UIDrawList,
    private readonly resolveImage: ImageResolver,
  ) {
    this.list = list;
    this.clips.push({ x0: -Infinity, y0: -Infinity, x1: Infinity, y1: Infinity });
  }

  /** Start a frame into `list` with a root clip of the viewport. */
  begin(list: UIDrawList, width: number, height: number): void {
    this.list = list;
    list.reset();
    this.clipDepth = 0;
    const c = this.clips[0]!;
    c.x0 = 0;
    c.y0 = 0;
    c.x1 = width;
    c.y1 = height;
    this.opacities.length = 1;
    this.alpha = 1;
    this.transformDepth = 0;
  }

  end(): void {
    this.list.finish();
  }

  get clipX0(): number {
    return this.toLocalX(this.clips[this.clipDepth]!.x0);
  }
  get clipY0(): number {
    return this.toLocalY(this.clips[this.clipDepth]!.y0);
  }
  get clipX1(): number {
    return this.toLocalX(this.clips[this.clipDepth]!.x1);
  }
  get clipY1(): number {
    return this.toLocalY(this.clips[this.clipDepth]!.y1);
  }

  private toLocalX(gx: number): number {
    const t = this.transforms[this.transformDepth]!;
    return (gx - t.dx) / t.s;
  }
  private toLocalY(gy: number): number {
    const t = this.transforms[this.transformDepth]!;
    return (gy - t.dy) / t.s;
  }

  // ------------------------------------------------------------------ state stacks

  pushClip(x: number, y: number, width: number, height: number): void {
    const t = this.transforms[this.transformDepth]!;
    const cur = this.clips[this.clipDepth]!;
    const gx0 = x * t.s + t.dx;
    const gy0 = y * t.s + t.dy;
    const gx1 = (x + width) * t.s + t.dx;
    const gy1 = (y + height) * t.s + t.dy;
    this.clipDepth++;
    let e = this.clips[this.clipDepth];
    if (!e) {
      e = { x0: 0, y0: 0, x1: 0, y1: 0 };
      this.clips.push(e);
    }
    e.x0 = Math.max(cur.x0, gx0);
    e.y0 = Math.max(cur.y0, gy0);
    e.x1 = Math.max(e.x0, Math.min(cur.x1, gx1));
    e.y1 = Math.max(e.y0, Math.min(cur.y1, gy1));
  }

  popClip(): void {
    if (this.clipDepth === 0) throw new Error("ui painter: popClip without pushClip");
    this.clipDepth--;
  }

  pushOpacity(alpha: number): void {
    this.alpha *= alpha;
    this.opacities.push(this.alpha);
  }

  popOpacity(): void {
    if (this.opacities.length <= 1) throw new Error("ui painter: popOpacity without pushOpacity");
    this.opacities.pop();
    this.alpha = this.opacities[this.opacities.length - 1]!;
  }

  pushTransform(tx: number, ty: number, scale: number, originX: number, originY: number): void {
    const o = this.transforms[this.transformDepth]!;
    this.transformDepth++;
    let e = this.transforms[this.transformDepth];
    if (!e) {
      e = { s: 1, dx: 0, dy: 0 };
      this.transforms.push(e);
    }
    e.s = o.s * scale;
    e.dx = o.s * (originX * (1 - scale) + tx) + o.dx;
    e.dy = o.s * (originY * (1 - scale) + ty) + o.dy;
  }

  popTransform(): void {
    if (this.transformDepth === 0) throw new Error("ui painter: popTransform without pushTransform");
    this.transformDepth--;
  }

  /** Painter state is balanced (diagnostics assert this after every frame). */
  get balanced(): boolean {
    return this.clipDepth === 0 && this.transformDepth === 0 && this.opacities.length === 1;
  }

  // ------------------------------------------------------------------ emission

  /**
   * Write one instance. Returns false (and counts it) when it lies entirely outside the clip.
   */
  private emit(kind: PrimitiveKind, texture: string | null, x: number, y: number, w: number, h: number): number {
    const t = this.transforms[this.transformDepth]!;
    const gx = x * t.s + t.dx;
    const gy = y * t.s + t.dy;
    const gw = w * t.s;
    const gh = h * t.s;
    const c = this.clips[this.clipDepth]!;
    if (gw <= 0 || gh <= 0 || gx >= c.x1 || gy >= c.y1 || gx + gw <= c.x0 || gy + gh <= c.y0) {
      this.list.stats.culled++;
      return -1;
    }
    const o = this.list.push(texture);
    const d = this.list.data;
    d[o] = gx;
    d[o + 1] = gy;
    d[o + 2] = gw;
    d[o + 3] = gh;
    d[o + 4] = 0;
    d[o + 5] = 0;
    d[o + 6] = 1;
    d[o + 7] = 1;
    for (let i = 8; i < 24; i++) d[o + i] = 0;
    d[o + F.clip] = c.x0;
    d[o + F.clip + 1] = c.y0;
    d[o + F.clip + 2] = c.x1;
    d[o + F.clip + 3] = c.y1;
    d[o + F.borderWidth] = 0;
    d[o + F.kind] = kind;
    d[o + F.p0] = 0;
    d[o + F.p1] = 0;
    d[o + F.p2] = 0;
    d[o + 33] = 0;
    d[o + 34] = 0;
    d[o + 35] = 0;
    return o;
  }

  private writeRadii(o: number, radius: number | Readonly<UICorners> | undefined, w: number, h: number): void {
    const s = this.transforms[this.transformDepth]!.s;
    const d = this.list.data;
    const max = Math.min(w, h) / 2;
    if (radius === undefined) return;
    if (typeof radius === "number") {
      const r = Math.min(radius, max) * s;
      d[o + F.radii] = d[o + F.radii + 1] = d[o + F.radii + 2] = d[o + F.radii + 3] = r;
    } else {
      d[o + F.radii] = Math.min(radius.topLeft, max) * s;
      d[o + F.radii + 1] = Math.min(radius.topRight, max) * s;
      d[o + F.radii + 2] = Math.min(radius.bottomRight, max) * s;
      d[o + F.radii + 3] = Math.min(radius.bottomLeft, max) * s;
    }
  }

  box(x: number, y: number, width: number, height: number, p: Readonly<BoxPaint>): void {
    const a = this.alpha;
    const s = this.transforms[this.transformDepth]!.s;
    // Shadow first (under the box).
    const shadow = p.shadowColor ?? 0;
    if (shadow !== 0 && colorA(shadow) > 0) {
      const blur = Math.max(0.5, p.shadowBlur ?? 0);
      const o = this.emit(PrimitiveKind.Shadow, null, x + (p.shadowOffsetX ?? 0) - blur, y + (p.shadowOffsetY ?? 0) - blur, width + blur * 2, height + blur * 2);
      if (o >= 0) {
        writeColorFloats(shadow, this.list.data, o + F.color0, a);
        this.writeRadii(o, p.radius, width, height);
        this.list.data[o + F.p0] = blur * s;
      }
    }
    const bg = p.background ?? 0;
    const bw = p.borderWidth ?? 0;
    const bc = p.borderColor ?? 0;
    const gradient = p.gradient ?? "none";
    if ((bg === 0 && (gradient === "none" || (p.backgroundEnd ?? 0) === 0)) && (bw <= 0 || bc === 0)) return;
    const o = this.emit(PrimitiveKind.Box, null, x, y, width, height);
    if (o < 0) return;
    const d = this.list.data;
    writeColorFloats(bg, d, o + F.color0, a);
    writeColorFloats(gradient === "none" ? bg : p.backgroundEnd ?? bg, d, o + F.color1, a);
    writeColorFloats(bc, d, o + F.border, a);
    d[o + F.borderWidth] = bw * s;
    d[o + F.p1] = gradient === "vertical" ? 1 : gradient === "horizontal" ? 2 : 0;
    this.writeRadii(o, p.radius, width, height);
  }

  fillRect(x: number, y: number, width: number, height: number, color: UIColor, radius = 0): void {
    if (color === 0) return;
    const o = this.emit(PrimitiveKind.Box, null, x, y, width, height);
    if (o < 0) return;
    const d = this.list.data;
    writeColorFloats(color, d, o + F.color0, this.alpha);
    writeColorFloats(color, d, o + F.color1, this.alpha);
    if (radius > 0) this.writeRadii(o, radius, width, height);
  }

  strokeRect(x: number, y: number, width: number, height: number, color: UIColor, thickness = 1, radius = 0): void {
    if (color === 0) return;
    const o = this.emit(PrimitiveKind.Box, null, x, y, width, height);
    if (o < 0) return;
    const d = this.list.data;
    writeColorFloats(color, d, o + F.border, this.alpha);
    d[o + F.borderWidth] = thickness * this.transforms[this.transformDepth]!.s;
    if (radius > 0) this.writeRadii(o, radius, width, height);
  }

  arc(cx: number, cy: number, radius: number, thickness: number, startAngle: number, endAngle: number, color: UIColor): void {
    if (color === 0 || radius <= 0) return;
    const o = this.emit(PrimitiveKind.Arc, null, cx - radius, cy - radius, radius * 2, radius * 2);
    if (o < 0) return;
    const d = this.list.data;
    writeColorFloats(color, d, o + F.color0, this.alpha);
    d[o + F.p0] = startAngle;
    d[o + F.p1] = endAngle;
    d[o + F.p2] = Math.min(thickness, radius) * this.transforms[this.transformDepth]!.s;
  }

  image(name: string, x: number, y: number, width: number, height: number, paint: Readonly<ImagePaint> = {}): void {
    const src = this.resolveImage(name);
    if (!src) {
      if (!this.reportedMissing.has(name)) {
        this.reportedMissing.add(name);
        this.onMissingImage(name);
      }
      this.fillRect(x, y, width, height, MISSING_COLOR);
      return;
    }
    const tint = paint.tint ?? 0xffffffff;
    const sx = paint.source?.x ?? src.x;
    const sy = paint.source?.y ?? src.y;
    const sw = paint.source?.width ?? src.width;
    const sh = paint.source?.height ?? src.height;
    const slice = paint.slice === undefined ? src.slice : paint.slice;
    const tw = src.textureWidth;
    const th = src.textureHeight;
    if (!slice) {
      const o = this.imageQuad(src.texture, x, y, width, height, sx / tw, sy / th, (sx + sw) / tw, (sy + sh) / th, tint);
      if (o >= 0 && paint.radius) this.writeRadii(o, paint.radius, width, height);
      return;
    }
    // Nine-slice: destination borders = source borders in logical units, shrunk if the box is small.
    const scaleX = Math.min(1, width / Math.max(1e-6, slice.left + slice.right));
    const scaleY = Math.min(1, height / Math.max(1e-6, slice.top + slice.bottom));
    const dl = slice.left * scaleX;
    const dr = slice.right * scaleX;
    const dt = slice.top * scaleY;
    const db = slice.bottom * scaleY;
    const xs = [x, x + dl, x + width - dr, x + width];
    const ys = [y, y + dt, y + height - db, y + height];
    const us = [sx / tw, (sx + slice.left) / tw, (sx + sw - slice.right) / tw, (sx + sw) / tw];
    const vs = [sy / th, (sy + slice.top) / th, (sy + sh - slice.bottom) / th, (sy + sh) / th];
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 3; c++) {
        const w = xs[c + 1]! - xs[c]!;
        const h = ys[r + 1]! - ys[r]!;
        if (w <= 0 || h <= 0) continue;
        this.imageQuad(src.texture, xs[c]!, ys[r]!, w, h, us[c]!, vs[r]!, us[c + 1]!, vs[r + 1]!, tint);
      }
    }
  }

  private imageQuad(texture: string, x: number, y: number, w: number, h: number, u0: number, v0: number, u1: number, v1: number, tint: UIColor): number {
    const o = this.emit(PrimitiveKind.Image, texture, x, y, w, h);
    if (o < 0) return o;
    const d = this.list.data;
    d[o + 4] = u0;
    d[o + 5] = v0;
    d[o + 6] = u1;
    d[o + 7] = v1;
    writeColorFloats(tint, d, o + F.color0, this.alpha);
    return o;
  }

  text(layout: TextLayoutResult, x: number, y: number, color: UIColor): void {
    if (color === 0 || layout.glyphCount === 0) return;
    const g = layout.glyphs;
    const bias = boldness(layout.weight) * 0.07;
    for (let i = 0; i < layout.glyphCount; i++) {
      const b = i * 8;
      const sdf = layout.glyphSdf[i] === 1;
      const o = this.emit(sdf ? PrimitiveKind.GlyphSdf : PrimitiveKind.GlyphMask, layout.glyphPages[i]!.name, x + g[b]!, y + g[b + 1]!, g[b + 2]!, g[b + 3]!);
      if (o < 0) continue;
      const d = this.list.data;
      d[o + 4] = g[b + 4]!;
      d[o + 5] = g[b + 5]!;
      d[o + 6] = g[b + 6]!;
      d[o + 7] = g[b + 7]!;
      writeColorFloats(color, d, o + F.color0, this.alpha);
      d[o + F.p0] = bias;
      this.list.stats.glyphs++;
    }
  }
}
