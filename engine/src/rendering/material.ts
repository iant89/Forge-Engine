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

export type MaterialTechnique = "standard" | "unlit" | "emissive" | "debug-line" | "blit" | "water" | "terrain";

export type MaterialTextureSlot = "albedo" | "normal" | "metallicRoughness" | "emissive" | "occlusion";

export interface MaterialTextureTransform {
  scale?: [number, number];
  offset?: [number, number];
  rotation?: number;
}

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
  /** Phase 16.1c: emissive colour map (sRGB), multiplied with `emissive × emissiveStrength`. */
  emissiveMap?: Texture | null;
  /** Phase 16.1c: ambient occlusion map (R channel, linear), scaled by `occlusionStrength`. */
  occlusionMap?: Texture | null;
  occlusionStrength?: number;
  /** Phase 16.1c: per-map samplers; a missing entry uses the renderer's default (linear-repeat). */
  samplers?: MaterialSamplers;
  doubleSided?: boolean;
  transparent?: boolean;
  /** Skip distance fog and aerial perspective (beacons that must read through dense weather). */
  fogExempt?: boolean;
  /**
   * Transparent only: write depth (default true, the historical behaviour). Set false for soft
   * see-through layers (impostor cards) so they never hide transparent draws or depth-tested
   * particles behind their quad footprint.
   */
  depthWrite?: boolean;
  tiling?: [number, number];
  offset?: [number, number];
  normalScale?: number;
  /** glTF texture-coordinate set per map; 0 = TEXCOORD_0, 1 = TEXCOORD_1. */
  uvSets?: Partial<MaterialUvSets>;
  /** Per-texture UV transforms; defaults to the identity transform. */
  uvTransforms?: Partial<Record<MaterialTextureSlot, MaterialTextureTransform>>;
}

export interface MaterialUvSets {
  albedo: number;
  normal: number;
  metallicRoughness: number;
  emissive: number;
  occlusion: number;
}

const MATERIAL_TEXTURE_SLOTS: readonly MaterialTextureSlot[] = ["albedo", "normal", "metallicRoughness", "emissive", "occlusion"];

type MaterialTextureTransformValue = { scale: [number, number]; offset: [number, number]; rotation: number };

function identityTextureTransform(): MaterialTextureTransformValue {
  return { scale: [1, 1], offset: [0, 0], rotation: 0 };
}

function normaliseTextureTransform(value: MaterialTextureTransform | undefined): MaterialTextureTransformValue {
  const scale = value?.scale ?? [1, 1];
  const offset = value?.offset ?? [0, 0];
  const rotation = value?.rotation ?? 0;
  return {
    scale: [Number.isFinite(scale[0]) ? scale[0] : 1, Number.isFinite(scale[1]) ? scale[1] : 1],
    offset: [Number.isFinite(offset[0]) ? offset[0] : 0, Number.isFinite(offset[1]) ? offset[1] : 0],
    rotation: Number.isFinite(rotation) ? rotation : 0,
  };
}

export const FLAG_ALBEDO = 1;
export const FLAG_NORMAL = 2;
export const FLAG_MR = 4;
export const FLAG_DOUBLE_SIDED = 8;
export const FLAG_UNLIT = 16;
export const FLAG_FOG_EXEMPT = 32;
export const FLAG_EMISSIVE_MAP = 64;
export const FLAG_OCCLUSION_MAP = 128;
export const FLAG_ALPHA_TEST = 256;
/** Transparent standard/terrain fragments may soften intersections against the resolved prepass depth. */
export const FLAG_TRANSPARENT = 512;

/** One sampler per texture slot (null = the shared default sampler). */
export interface MaterialSamplers {
  albedo: GPUSampler | null;
  normal: GPUSampler | null;
  metallicRoughness: GPUSampler | null;
  emissive: GPUSampler | null;
  occlusion: GPUSampler | null;
}

/** Shared fallback bindings; subclasses may extend group 2 without changing ordinary materials. */
export interface MaterialDefaults {
  white: Texture;
  normal: Texture;
  mr: Texture;
  sampler: GPUSampler;
}

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
  /** Skip distance fog and aerial perspective; a uniform flag, so toggling it never rebuilds a pipeline. */
  fogExempt = false;
  /** Transparent only: write depth (see {@link MaterialOptions.depthWrite}). */
  depthWrite = true;
  /** Discard instead of blending (foliage): cheaper and depth-correct. */
  alphaTest = 0;
  albedoMap: Texture | null = null;
  normalMap: Texture | null = null;
  metallicRoughnessMap: Texture | null = null;
  emissiveMap: Texture | null = null;
  occlusionMap: Texture | null = null;
  occlusionStrength = 1;
  /** Change through `setSamplers` (the bind group holds them). */
  readonly samplers: MaterialSamplers = { albedo: null, normal: null, metallicRoughness: null, emissive: null, occlusion: null };
  readonly tiling = new Vec2(1, 1);
  readonly offset = new Vec2(0, 0);
  readonly uvSets: MaterialUvSets = { albedo: 0, normal: 0, metallicRoughness: 0, emissive: 0, occlusion: 0 };
  readonly uvTransforms: Record<MaterialTextureSlot, MaterialTextureTransformValue> = {
    albedo: identityTextureTransform(),
    normal: identityTextureTransform(),
    metallicRoughness: identityTextureTransform(),
    emissive: identityTextureTransform(),
    occlusion: identityTextureTransform(),
  };
  dirty = true;
  /**
   * fe-38: per-object snow (written by `SnowMeltSystem` through `setSnowCover`): `amount` 0..1, the
   * `line` — the lowest world normal.y that still carries snow — and the pack's `wetness`.
   */
  readonly snowCover = { amount: 0, line: 1, wetness: 0 };
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
    if (options.uvSets) Object.assign(this.uvSets, options.uvSets);
    if (options.uvTransforms) {
      for (const slot of MATERIAL_TEXTURE_SLOTS) {
        if (options.uvTransforms[slot]) this.uvTransforms[slot] = normaliseTextureTransform(options.uvTransforms[slot]);
      }
    }
    for (const key of Object.keys(this.uvSets) as (keyof MaterialUvSets)[]) {
      const value = this.uvSets[key];
      if (value !== 0 && value !== 1) this.uvSets[key] = 0;
    }
    this.transparent = options.transparent ?? false;
    this.doubleSided = options.doubleSided ?? false;
    this.fogExempt = options.fogExempt ?? false;
    this.depthWrite = options.depthWrite ?? true;
    this.albedoMap = options.albedoMap ?? null;
    this.normalMap = options.normalMap ?? null;
    this.metallicRoughnessMap = options.metallicRoughnessMap ?? null;
    this.emissiveMap = options.emissiveMap ?? null;
    this.occlusionMap = options.occlusionMap ?? null;
    this.occlusionStrength = options.occlusionStrength ?? 1;
    if (options.samplers) Object.assign(this.samplers, options.samplers);
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

  setMaps(maps: { albedo?: Texture | null; normal?: Texture | null; metallicRoughness?: Texture | null; emissive?: Texture | null; occlusion?: Texture | null }): this {
    if ("albedo" in maps) this.albedoMap = maps.albedo ?? null;
    if ("normal" in maps) this.normalMap = maps.normal ?? null;
    if ("metallicRoughness" in maps) this.metallicRoughnessMap = maps.metallicRoughness ?? null;
    if ("emissive" in maps) this.emissiveMap = maps.emissive ?? null;
    if ("occlusion" in maps) this.occlusionMap = maps.occlusion ?? null;
    // The bind group holds the previous texture views; drop it so `ensureGpu` rebuilds with the
    // new maps (and the new pipeline flags land on the next draw).
    this.bindGroup = null;
    return this.markChanged();
  }

  /** Replace per-map samplers (null = default); rebuilds the bind group on the next draw. */
  setSamplers(samplers: Partial<MaterialSamplers>): this {
    Object.assign(this.samplers, samplers);
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
  ensureGpu(device: GraphicsDevice, bindGroupLayout: GPUBindGroupLayout, defaults: MaterialDefaults): void {
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
        entries: this.gpuBindings(defaults),
      });
    }
  }

  /** Additional material techniques keep the standard prefix and append their own bindings. */
  protected gpuBindings(defaults: MaterialDefaults): GPUBindGroupEntry[] {
    return [
      { binding: 0, resource: { buffer: this.uniformBuffer! } },
      { binding: 1, resource: (this.albedoMap ?? defaults.white).view },
      { binding: 2, resource: (this.normalMap ?? defaults.normal).view },
      { binding: 3, resource: (this.metallicRoughnessMap ?? defaults.mr).view },
      { binding: 4, resource: this.samplers.albedo ?? defaults.sampler },
      { binding: 11, resource: (this.emissiveMap ?? defaults.white).view },
      { binding: 12, resource: (this.occlusionMap ?? defaults.white).view },
      { binding: 13, resource: this.samplers.normal ?? defaults.sampler },
      { binding: 14, resource: this.samplers.metallicRoughness ?? defaults.sampler },
      { binding: 15, resource: this.samplers.emissive ?? defaults.sampler },
      { binding: 16, resource: this.samplers.occlusion ?? defaults.sampler },
    ];
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
    const flags = (this.albedoMap ? FLAG_ALBEDO : 0) | (this.normalMap ? FLAG_NORMAL : 0) | (this.metallicRoughnessMap ? FLAG_MR : 0) | (this.doubleSided ? FLAG_DOUBLE_SIDED : 0) | (this.technique === "unlit" || this.technique === "emissive" ? FLAG_UNLIT : 0) | (this.fogExempt ? FLAG_FOG_EXEMPT : 0) | (this.emissiveMap ? FLAG_EMISSIVE_MAP : 0) | (this.occlusionMap ? FLAG_OCCLUSION_MAP : 0) | (this.alphaTest > 0 ? FLAG_ALPHA_TEST : 0) | (this.transparent ? FLAG_TRANSPARENT : 0);
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
    const uvSets = (this.uvSets.albedo ? 1 : 0) | (this.uvSets.normal ? 2 : 0) | (this.uvSets.metallicRoughness ? 4 : 0) | (this.uvSets.emissive ? 8 : 0) | (this.uvSets.occlusion ? 16 : 0);
    a.setU32("uvSets", uvSets);
    a.setF32("occlusionStrength", this.occlusionStrength);
    a.setF32("alphaCutoff", this.alphaTest);
    const sc = a.struct.field("snowCover", "uniform");
    const so = sc.offset >> 2;
    f32[so] = this.snowCover.amount;
    f32[so + 1] = this.snowCover.line;
    f32[so + 2] = this.snowCover.wetness;
    f32[so + 3] = 0;
    const uvScaleOffset = a.struct.field("uvScaleOffset", "uniform");
    const uvRotation = a.struct.field("uvRotation", "uniform");
    const transformBase = uvScaleOffset.offset >> 2;
    const rotationBase = uvRotation.offset >> 2;
    for (let i = 0; i < MATERIAL_TEXTURE_SLOTS.length; i++) {
      const transform = this.uvTransforms[MATERIAL_TEXTURE_SLOTS[i]!];
      f32[transformBase + i * 4] = transform.scale[0];
      f32[transformBase + i * 4 + 1] = transform.scale[1];
      f32[transformBase + i * 4 + 2] = transform.offset[0];
      f32[transformBase + i * 4 + 3] = transform.offset[1];
      f32[rotationBase + i * 4] = Math.cos(transform.rotation);
      f32[rotationBase + i * 4 + 1] = Math.sin(transform.rotation);
      f32[rotationBase + i * 4 + 2] = 0;
      f32[rotationBase + i * 4 + 3] = 0;
    }
  }

  /** {@link SnowCoverTarget}: show snow on every surface of this material facing up past `snowLine`. */
  setSnowCover(amount: number, snowLine: number, wetness: number): void {
    this.snowCover.amount = amount;
    this.snowCover.line = snowLine;
    this.snowCover.wetness = wetness;
    this.markChanged();
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
      fogExempt: this.fogExempt,
      depthWrite: this.depthWrite,
      albedoMap: this.albedoMap,
      normalMap: this.normalMap,
      metallicRoughnessMap: this.metallicRoughnessMap,
      emissiveMap: this.emissiveMap,
      occlusionMap: this.occlusionMap,
      occlusionStrength: this.occlusionStrength,
      samplers: { ...this.samplers },
      uvSets: { ...this.uvSets },
      uvTransforms: Object.fromEntries(MATERIAL_TEXTURE_SLOTS.map((slot) => [slot, { ...this.uvTransforms[slot], scale: [...this.uvTransforms[slot].scale] as [number, number], offset: [...this.uvTransforms[slot].offset] as [number, number] }])) as Partial<Record<MaterialTextureSlot, MaterialTextureTransform>>,
    });
    m.alphaTest = this.alphaTest;
    m.baseColor.copyFrom(this.baseColor);
    const { uvSets, uvTransforms, ...overrides } = options;
    Object.assign(m, overrides);
    if (uvSets) Object.assign(m.uvSets, uvSets);
    if (uvTransforms) {
      for (const slot of MATERIAL_TEXTURE_SLOTS) {
        if (uvTransforms[slot]) m.uvTransforms[slot] = normaliseTextureTransform(uvTransforms[slot]);
      }
    }
    for (const key of Object.keys(m.uvSets) as (keyof MaterialUvSets)[]) {
      if (m.uvSets[key] !== 0 && m.uvSets[key] !== 1) m.uvSets[key] = 0;
    }
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
