/**
 * `UIAssets` — the UI's named visual resources: textures, sprites (sub-rectangles of a texture,
 * optionally nine-sliced), atlases and icons.
 *
 * Ownership (docs/UI.md §5): the asset registry owns these *descriptions*; elements and skins hold
 * only names. The GPU backend owns the GPU textures it creates for `pixels`/`image` sources and
 * releases them when the source is unregistered or the backend is disposed; a `gpu` source is a
 * texture the application (or the engine's `ResourceRegistry`) owns — the UI never destroys it.
 *
 * Missing names are not fatal: the painter draws a magenta box and the manager records one
 * diagnostic naming the missing asset (`UIDiagnostics.missingAssets`).
 *
 * Icons resolve to a sprite of the same name if one exists, otherwise to a **glyph icon**: a code
 * point drawn from a font family. The built-in set maps common UI icons to Forge Sans symbols, so
 * menus and HUDs have check marks, arrows, stars and hearts without any image files.
 */

import { UsageError } from "../../core/errors.js";
import { toInsets, type InsetsInput, type UIInsets } from "../core/geometry.js";
import { UIAtlasPage } from "../text/font.js";
import type { ImageSource } from "./drawList.js";

export type UITextureSource =
  | { kind: "pixels"; page: UIAtlasPage }
  | { kind: "image"; width: number; height: number; image: unknown }
  | { kind: "gpu"; width: number; height: number; texture: GPUTexture };

export interface SpriteDef {
  texture: string;
  x: number;
  y: number;
  width: number;
  height: number;
  slice?: InsetsInput | null;
}

export interface GlyphIcon {
  codepoint: number;
  family: string;
}

export const BUILTIN_GLYPH_ICONS: Readonly<Record<string, number>> = {
  check: 0x2713,
  close: 0x2717,
  star: 0x2605,
  heart: 0x2665,
  "arrow-left": 0x2190,
  "arrow-up": 0x2191,
  "arrow-right": 0x2192,
  "arrow-down": 0x2193,
  "triangle-up": 0x25b2,
  "triangle-down": 0x25bc,
  "triangle-right": 0x25b6,
  "triangle-left": 0x25c0,
  dot: 0x25cf,
  circle: 0x25cb,
  bullet: 0x2022,
  ellipsis: 0x2026,
  plus: 0x2b,
  minus: 0x2212,
  multiply: 0xd7,
  degree: 0xb0,
  info: 0x2139,
  warning: 0x26a0,
  menu: 0x2630,
  settings: 0x2699,
  "star-outline": 0x2606,
  "heart-outline": 0x2661,
  swords: 0x2694,
  lightning: 0x26a1,
  home: 0x2302,
  enter: 0x21b5,
  command: 0x2318,
  square: 0x25a0,
  "square-outline": 0x25a1,
  diamond: 0x25c6,
  "chevron-left": 0x2039,
  "chevron-right": 0x203a,
  "check-bold": 0x2714,
  "close-small": 0x2715,
};

export class UIAssets {
  private readonly textures = new Map<string, UITextureSource>();
  private readonly sprites = new Map<string, { texture: string; x: number; y: number; width: number; height: number; slice: Readonly<UIInsets> | null }>();
  private readonly glyphIcons = new Map<string, GlyphIcon>();
  /** Bumped when textures are added/removed (the backend re-syncs). */
  version = 1;
  diagnostic: (message: string) => void = () => {};

  constructor() {
    for (const [name, cp] of Object.entries(BUILTIN_GLYPH_ICONS)) this.glyphIcons.set(name, { codepoint: cp, family: "default" });
  }

  /** Register RGBA8 pixels (row-major, width × height × 4 bytes). */
  registerPixels(name: string, width: number, height: number, rgba: Uint8Array): UIAtlasPage {
    const page = new UIAtlasPage(name, width, height, "rgba8unorm", rgba);
    this.setTexture(name, { kind: "pixels", page });
    return page;
  }

  /** Register an existing page (font atlases register themselves this way). */
  registerPage(page: UIAtlasPage): void {
    this.setTexture(page.name, { kind: "pixels", page });
  }

  /** A browser image (`ImageBitmap`, canvas) the backend copies with `copyExternalImageToTexture`. */
  registerImage(name: string, image: { width: number; height: number }): void {
    if (!(image.width > 0 && image.height > 0)) throw new UsageError(`ui assets: image "${name}" has no size`);
    this.setTexture(name, { kind: "image", width: image.width, height: image.height, image });
  }

  /** An engine/application-owned GPU texture (e.g. `Texture.gpuTexture`, a render target). */
  registerGpuTexture(name: string, texture: GPUTexture, width: number, height: number): void {
    this.setTexture(name, { kind: "gpu", width, height, texture });
  }

  /**
   * Fetch and decode an image in the browser (`fetch` + `createImageBitmap`). Rejects with a
   * diagnostic on failure; the name stays unresolved (magenta) rather than pointing at something else.
   */
  async loadImage(name: string, url: string): Promise<void> {
    const g = globalThis as { fetch?: (u: string) => Promise<{ ok: boolean; status: number; blob(): Promise<unknown> }>; createImageBitmap?: (b: unknown) => Promise<{ width: number; height: number }> };
    if (!g.fetch || !g.createImageBitmap) throw new UsageError("ui assets: loadImage needs fetch and createImageBitmap (browser)");
    try {
      const res = await g.fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const bitmap = await g.createImageBitmap(await res.blob());
      this.registerImage(name, bitmap);
    } catch (e) {
      const msg = `ui assets: failed to load image "${name}" from ${url}: ${e instanceof Error ? e.message : String(e)}`;
      this.diagnostic(msg);
      throw new Error(msg);
    }
  }

  private setTexture(name: string, src: UITextureSource): void {
    if (!name) throw new UsageError("ui assets: texture name is empty");
    this.textures.set(name, src);
    this.version++;
  }

  unregisterTexture(name: string): boolean {
    const had = this.textures.delete(name);
    if (had) {
      for (const [s, sp] of this.sprites) if (sp.texture === name) this.sprites.delete(s);
      this.version++;
    }
    return had;
  }

  texture(name: string): UITextureSource | undefined {
    return this.textures.get(name);
  }

  textureNames(): string[] {
    return [...this.textures.keys()];
  }

  registerSprite(name: string, def: SpriteDef): void {
    if (!(def.width > 0 && def.height > 0)) throw new UsageError(`ui assets: sprite "${name}" must have a positive size`);
    this.sprites.set(name, { texture: def.texture, x: def.x, y: def.y, width: def.width, height: def.height, slice: def.slice ? toInsets(def.slice) : null });
  }

  /** Register many sprites in one texture (`{ name: [x, y, w, h] }`). */
  registerAtlas(texture: string, frames: Record<string, readonly [number, number, number, number]>, slice?: InsetsInput): void {
    for (const [name, [x, y, w, h]] of Object.entries(frames)) this.registerSprite(name, { texture, x, y, width: w, height: h, slice: slice ?? null });
  }

  registerGlyphIcon(name: string, codepoint: number, family = "default"): void {
    this.glyphIcons.set(name, { codepoint, family });
  }

  glyphIcon(name: string): GlyphIcon | undefined {
    return this.sprites.has(name) ? undefined : this.glyphIcons.get(name);
  }

  hasSprite(name: string): boolean {
    return this.sprites.has(name);
  }

  /** Resolve a sprite or texture name for the painter (sprites take precedence). */
  resolve(name: string): ImageSource | null {
    const sp = this.sprites.get(name);
    const texName = sp ? sp.texture : name;
    const tex = this.textures.get(texName);
    if (!tex) return null;
    const tw = tex.kind === "pixels" ? tex.page.width : tex.width;
    const th = tex.kind === "pixels" ? tex.page.height : tex.height;
    if (sp) return { texture: texName, textureWidth: tw, textureHeight: th, x: sp.x, y: sp.y, width: sp.width, height: sp.height, slice: sp.slice };
    return { texture: texName, textureWidth: tw, textureHeight: th, x: 0, y: 0, width: tw, height: th, slice: null };
  }

  /** Every sprite/glyph-icon name (tooling). */
  iconNames(): string[] {
    return [...new Set([...this.sprites.keys(), ...this.glyphIcons.keys()])].sort();
  }
}
