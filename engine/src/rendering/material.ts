/**
 * Materials: PBR parameters + the GPU uniform buffer and bind group they own.
 *
 * Design points that are load-bearing (see docs/RENDERING.md §6):
 *  - A material is *shared* by many renderables. Its uniform buffer is written only when `dirty`
 *    is set, and its bind group is created once and reused — so "set the cube's colour" costs one
 *    64-byte write, not a pipeline rebuild.
 *  - Pipeline selection depends only on `technique` + which maps are bound + blend/cull state.
 *    Changing a colour does not invalidate anything; changing `transparent` does, and that is the
 *    only reason the key includes it.
 *  - Missing textures resolve to shared 1×1 defaults rather than null, so the shader's texture
 *    branches stay uniform per pipeline and the bind group layout never has optional slots.
 */

import { BufferUsage } from "../gpu/constants.js";
import { MaterialUniforms } from "./uniforms.js";
import { StructAccessor, WriteBuffer } from "../gpu/bufferWriter.js";
import { Color } from "../math/color.js";
import { Vec2 } from "../math/vec.js";
import type { GraphicsDevice } from "../gpu/device.js";
import type { Texture } from "../resources/texture.js";

export type MaterialTechnique = "standard" | "unlit" | "emissive" | "debug-line" | "blit";

export interface MaterialOptions {
  label?: string;
  technique?: MaterialTechnique;
  /** sRGB hex (authoring) or a linear Color. */
  color?: number | Color;
  metallic?: number;
  roughness?: number;
  emissive?: number | Color;
  emissiveStrength?: number;
  opacity?: number;
  albedoMap?: Texture | null;
  normalMap?: Texture | null;
  metallicRoughnessMap?: Texture | null;
  doubleSided?: boolean;
  transparent?: boolean;
  tiling?: [number, number];
  offset?: [number, number];
  normalScale?: number;
}

export const FLAG_ALBEDO = 1;
export const FLAG_NORMAL = 2;
export const FLAG_MR = 4;
export const FLAG_DOUBLE_SIDED = 8;
export const FLAG_UNLIT = 16;

export class Material {
  label: string;
  technique: MaterialTechnique;
  readonly baseColor = new Color(1, 1, 1, 1);
  readonly emissive = new Color(0, 0, 0, 1);
  emissiveStrength = 0;
  metallic = 0;
  roughness = 0.5;
  opacity = 1;
  normalScale = 1;
  transparent = false;
  doubleSided = false;
  /** Discard instead of blending (foliage): cheaper and depth-correct. */
  alphaTest = 0;
  albedoMap: Texture | null = null;
  normalMap: Texture | null = null;
  metallicRoughnessMap: Texture | null = null;
  readonly tiling = new Vec2(1, 1);
  readonly offset = new Vec2(0, 0);
  dirty = true;
  /** Bumped on any change; the batch cache keys on (this, revision). */
  revision = 0;

  /** @internal GPU state, created lazily by the renderer. */
  uniformBuffer: GPUBuffer | null = null;
  /** @internal */ bindGroup: GPUBindGroup | null = null;
  /** @internal */ private cpu: WriteBuffer | null = null;
  /** @internal */ private accessor: StructAccessor | null = null;

  constructor(options: MaterialOptions = {}) {
    this.label = options.label ?? "Material";
    this.technique = options.technique ?? "standard";
    if (options.color !== undefined) this.setColor(options.color);
    if (options.emissive !== undefined) this.setEmissive(options.emissive);
    this.metallic = options.metallic ?? 0;
    this.roughness = options.roughness ?? 0.5;
    this.emissiveStrength = options.emissiveStrength ?? 0;
    this.opacity = options.opacity ?? 1;
    this.normalScale = options.normalScale ?? 1;
    this.transparent = options.transparent ?? false;
    this.doubleSided = options.doubleSided ?? false;
    this.albedoMap = options.albedoMap ?? null;
    this.normalMap = options.normalMap ?? null;
    this.metallicRoughnessMap = options.metallicRoughnessMap ?? null;
    if (options.tiling) this.tiling.set(options.tiling[0], options.tiling[1]);
    if (options.offset) this.offset.set(options.offset[0], options.offset[1]);
  }

  setColor(c: number | Color): this {
    if (typeof c === "number") {
      this.baseColor.setSrgbHex(c, this.baseColor.a);
    } else {
      this.baseColor.copyFrom(c);
    }
    return this.markChanged();
  }

  setAlpha(a: number): this {
    this.baseColor.a = a;
    this.transparent = a < 0.999;
    return this.markChanged();
  }

  setEmissive(c: number | Color): this {
    if (typeof c === "number") this.emissive.setSrgbHex(c, this.emissive.a);
    else this.emissive.copyFrom(c);
    this.emissiveStrength = this.emissiveStrength > 0 ? this.emissiveStrength : 1;
    return this.markChanged();
  }

  setMetallicRoughness(metallic: number, roughness: number): this {
    this.metallic = Math.min(1, Math.max(0, metallic));
    this.roughness = Math.min(1, Math.max(0.001, roughness));
    return this.markChanged();
  }

  setMaps(maps: { albedo?: Texture | null; normal?: Texture | null; metallicRoughness?: Texture | null }): this {
    if ("albedo" in maps) this.albedoMap = maps.albedo ?? null;
    if ("normal" in maps) this.normalMap = maps.normal ?? null;
    if ("metallicRoughness" in maps) this.metallicRoughnessMap = maps.metallicRoughness ?? null;
    // The bind group holds the previous texture views; drop it so `ensureGpu` rebuilds with the
    // new maps (and the new pipeline flags land on the next draw).
    this.bindGroup = null;
    return this.markChanged();
  }

  setTechnique(t: MaterialTechnique): this {
    if (this.technique === t) return this;
    this.technique = t;
    this.bindGroup = null; // pipeline selection changed; the renderer will rebuild everything
    return this.markChanged();
  }

  markChanged(): this {
    this.dirty = true;
    this.revision++;
    return this;
  }

  /** Cache key for the pipeline this material needs. */
  get pipelineKey(): string {
    const flags = (this.albedoMap ? 1 : 0) | (this.normalMap ? 2 : 0) | (this.metallicRoughnessMap ? 4 : 0) | (this.doubleSided ? 8 : 0);
    return `${this.technique}|${flags}|${this.transparent ? "blend" : "opaque"}|${this.alphaTest > 0 ? "cutout" : "solid"}`;
  }

  /** @internal Called by the renderer once per material creation. */
  ensureGpu(device: GraphicsDevice, bindGroupLayout: GPUBindGroupLayout, defaults: { white: Texture; normal: Texture; mr: Texture; sampler: GPUSampler }): void {
    if (!this.uniformBuffer) {
      const size = MaterialUniforms.byteSize("uniform");
      this.uniformBuffer = device.createBuffer({ label: `material.${this.label}`, size, usage: BufferUsage.UNIFORM | BufferUsage.COPY_DST });
      this.cpu = new WriteBuffer(size);
      this.accessor = new StructAccessor(MaterialUniforms, this.cpu, 0, "uniform");
      this.dirty = true;
    }
    if (this.dirty) this.writeCpu();
    if (!this.bindGroup) {
      this.bindGroup = device.device.createBindGroup({
        layout: bindGroupLayout,
        entries: [
          { binding: 0, resource: { buffer: this.uniformBuffer! } },
          { binding: 1, resource: (this.albedoMap ?? defaults.white).view },
          { binding: 2, resource: (this.normalMap ?? defaults.normal).view },
          { binding: 3, resource: (this.metallicRoughnessMap ?? defaults.mr).view },
          { binding: 4, resource: defaults.sampler },
        ],
      });
    }
  }

  /** @internal */
  takePendingUpload(): { buffer: GPUBuffer; bytes: Uint8Array } | null {
    if (!this.dirty || !this.cpu || !this.uniformBuffer) return null;
    this.writeCpu();
    this.dirty = false;
    return { buffer: this.uniformBuffer, bytes: this.cpu.bytes };
  }

  private writeCpu(): void {
    const a = this.accessor;
    if (!a) return;
    const flags = (this.albedoMap ? FLAG_ALBEDO : 0) | (this.normalMap ? FLAG_NORMAL : 0) | (this.metallicRoughnessMap ? FLAG_MR : 0) | (this.doubleSided ? FLAG_DOUBLE_SIDED : 0) | (this.technique === "unlit" || this.technique === "emissive" ? FLAG_UNLIT : 0);
    const base = a.struct.field("baseColorFactor", "uniform");
    const f32 = this.cpu!.f32;
    const o = base.offset >> 2;
    f32[o] = this.baseColor.r;
    f32[o + 1] = this.baseColor.g;
    f32[o + 2] = this.baseColor.b;
    f32[o + 3] = this.baseColor.a;
    const em = a.struct.field("emissiveFactor", "uniform");
    const eo = em.offset >> 2;
    f32[eo] = this.emissive.r;
    f32[eo + 1] = this.emissive.g;
    f32[eo + 2] = this.emissive.b;
    f32[eo + 3] = this.emissiveStrength;
    a.setF32("metallic", this.metallic);
    a.setF32("roughness", this.roughness);
    a.setF32("opacity", this.opacity);
    const t = a.struct.field("tiling", "uniform");
    const to = t.offset >> 2;
    f32[to] = this.tiling.x;
    f32[to + 1] = this.tiling.y;
    const off = a.struct.field("offset", "uniform");
    const oo = off.offset >> 2;
    f32[oo] = this.offset.x;
    f32[oo + 1] = this.offset.y;
    a.setF32("normalScale", this.normalScale);
    a.setU32("flags", flags);
  }

  /** @internal Free GPU resources (called by the renderer on scene unload + by `Material.dispose`). */
  dispose(device?: GraphicsDevice): void {
    void device;
    this.uniformBuffer?.destroy();
    this.uniformBuffer = null;
    this.bindGroup = null;
    this.accessor = null;
    this.cpu = null;
  }

  clone(options: MaterialOptions = {}): Material {
    const m = new Material({
      label: `${this.label}(copy)`,
      technique: this.technique,
      metallic: this.metallic,
      roughness: this.roughness,
      emissive: this.emissive.clone(),
      emissiveStrength: this.emissiveStrength,
      opacity: this.opacity,
      transparent: this.transparent,
      doubleSided: this.doubleSided,
      albedoMap: this.albedoMap,
      normalMap: this.normalMap,
      metallicRoughnessMap: this.metallicRoughnessMap,
    });
    m.baseColor.copyFrom(this.baseColor);
    Object.assign(m, options);
    return m.markChanged();
  }

  toString(): string {
    return `Material(${this.label}, ${this.technique})`;
  }

  // ------------------------------------------------------------------ presets

  static standard(options: MaterialOptions = {}): Material {
    return new Material({ technique: "standard", ...options });
  }

  /** Unlit: for sprites/HUD/emissive-only geometry (no lighting cost, no tone-map surprises). */
  static unlit(options: MaterialOptions = {}): Material {
    return new Material({ technique: "unlit", ...options });
  }

  static emissive(color: number, strength = 2, options: MaterialOptions = {}): Material {
    return new Material({ technique: "emissive", color, emissive: color, emissiveStrength: strength, ...options });
  }

  static metal(color: number, roughness = 0.35): Material {
    return new Material({ label: "metal", color, metallic: 1, roughness });
  }

  static dielectric(color: number, roughness = 0.6): Material {
    return new Material({ label: "dielectric", color, metallic: 0, roughness });
  }

  static glass(tint = 0xffffff, roughness = 0.05): Material {
    return new Material({ label: "glass", color: tint, metallic: 0, roughness, opacity: 0.25, transparent: true, doubleSided: true });
  }

  /** Terrain-ish material with the engine's default tiling behaviour. */
  static terrain(albedo: Texture, normal?: Texture): Material {
    return new Material({ label: "terrain", color: 0xffffff, metallic: 0, roughness: 0.9, albedoMap: albedo, normalMap: normal ?? null, tiling: [1, 1] });
  }
}

/** Shared material instances, so "the standard cube material" does not need to be re-created. */
export class MaterialLibrary {
  private readonly shared = new Map<string, Material>();

  constructor(private readonly device: GraphicsDevice) {}

  get(key: string, create: () => Material): Material {
    let m = this.shared.get(key);
    if (!m) {
      m = create();
      this.shared.set(key, m);
    }
    return m;
  }

  defaultMaterial(): Material {
    return this.get("default", () => new Material({ label: "default", color: 0xcccccc, roughness: 0.6, metallic: 0 }));
  }

  disposeAll(): void {
    for (const m of this.shared.values()) m.dispose(this.device);
    this.shared.clear();
  }
}
