/**
 * Opt-in four-layer PBR material. Uses the standard 48-byte vertices and lighting passes; only
 * surface sampling and group 2 differ. Texture arrays are borrowed/shared; per-tile weights may be
 * owned by this material. Explicit ownership keeps streaming remesh/eviction leak-free.
 */
import { Material, type MaterialDefaults, type MaterialOptions, type MaterialTechnique } from "./material.js";
import { SplatUniforms } from "./uniforms.js";
import { SPLAT_BINDINGS } from "./shaders/terrain.js";
import { BufferUsage, gpuSource } from "../gpu/constants.js";
import { UsageError } from "../core/errors.js";
import type { Color } from "../math/color.js";
import type { Texture } from "../resources/texture.js";
import type { GraphicsDevice } from "../gpu/device.js";

export interface SplatTextureSet {
  /** Four slices; albedo must be sRGB, normals and metallic-roughness linear. */
  albedo: Texture;
  normal: Texture;
  metallicRoughness: Texture;
}

export interface SplatSurfaceLayer {
  color: Color;
  roughness: number;
  metallic: number;
  /** Metres per texture repeat (default 8); phase stays continuous across tile/LOD boundaries. */
  textureSize?: number;
  normalScale?: number;
  macroVariation?: number;
  microDetail?: number;
}

export interface SplatMaterialOptions {
  label?: string;
  layers: readonly SplatSurfaceLayer[];
  maps: SplatTextureSet;
  weightMap: Texture;
  originX: number;
  originZ: number;
  size: number;
  /** Dispose the per-tile mask with the material. Shared texture arrays are always borrowed. */
  ownsWeightMap?: boolean;
}

/** UV scale/phase computed in CPU double precision, avoiding large-world float32 texture swim. */
export function splatUvTransform(originX: number, originZ: number, size: number, period: number): [number, number, number, number] {
  if (![originX, originZ, size, period].every(Number.isFinite) || size <= 0 || period <= 0) {
    throw new UsageError("splat UV transform: finite origins and positive size/texture period required");
  }
  const phase = (value: number): number => ((value % period) + period) % period / period;
  return [size / period, size / period, phase(originX), phase(originZ)];
}

export class SplatMaterial extends Material {
  readonly layers: readonly SplatSurfaceLayer[];
  readonly maps: SplatTextureSet;
  readonly weightMap: Texture;
  readonly originX: number;
  readonly originZ: number;
  readonly size: number;
  private readonly ownsWeightMap: boolean;
  private splatBuffer: GPUBuffer | null = null;
  private clampSampler: GPUSampler | null = null;
  private readonly data = new Float32Array(SplatUniforms.byteSize("uniform") / 4);

  constructor(options: SplatMaterialOptions) {
    super({ label: options.label ?? "terrain-splat", technique: "terrain", color: 0xffffff, roughness: 1, metallic: 1 });
    if (options.layers.length !== 4) throw new UsageError("SplatMaterial requires exactly four surface layers");
    for (const name of ["albedo", "normal", "metallicRoughness"] as const) {
      const texture = options.maps[name];
      const format = name === "albedo" ? "rgba8unorm-srgb" : "rgba8unorm";
      if (!texture || texture.desc.depthOrArrayLayers !== 4 || texture.format !== format || texture.releasedState) {
        throw new UsageError(`SplatMaterial ${name}: four ${format} array slices required`);
      }
    }
    if (options.weightMap.format !== "rgba8unorm" || options.weightMap.desc.depthOrArrayLayers !== 1) {
      throw new UsageError("SplatMaterial weights must be a linear rgba8unorm 2D texture");
    }
    this.layers = options.layers.map((layer) => ({ ...layer, color: layer.color.clone() }));
    this.maps = options.maps;
    this.weightMap = options.weightMap;
    this.originX = options.originX;
    this.originZ = options.originZ;
    this.size = options.size;
    this.ownsWeightMap = options.ownsWeightMap ?? false;
    // Validate before creating GPU resources, including custom periods and NaN material data.
    for (const layer of this.layers) {
      splatUvTransform(this.originX, this.originZ, this.size, layer.textureSize ?? 8);
      if (![layer.color.r, layer.color.g, layer.color.b, layer.roughness, layer.metallic,
        layer.normalScale ?? 1, layer.macroVariation ?? 0, layer.microDetail ?? 0].every(Number.isFinite)) {
        throw new UsageError("SplatMaterial surface properties must be finite");
      }
    }
  }

  override ensureGpu(device: GraphicsDevice, layout: GPUBindGroupLayout, defaults: MaterialDefaults): void {
    let created = false;
    if (!this.splatBuffer) {
      this.splatBuffer = device.createBuffer({ label: `splat.${this.label}`, size: this.data.byteLength, usage: BufferUsage.UNIFORM | BufferUsage.COPY_DST });
      this.clampSampler = device.sampler("linear-clamp");
      created = true;
    }
    if (this.dirty || created) {
      const at = (name: string): number => SplatUniforms.offsetOf(name, "uniform") / 4;
      for (let i = 0; i < 4; i++) {
        const layer = this.layers[i]!;
        this.data.set([layer.color.r, layer.color.g, layer.color.b, 1], at("colors") + i * 4);
        this.data.set([layer.roughness, layer.metallic, layer.normalScale ?? 1, layer.macroVariation ?? 0], at("surfaces") + i * 4);
        this.data.set(splatUvTransform(this.originX, this.originZ, this.size, layer.textureSize ?? 8), at("uvTransforms") + i * 4);
        this.data[at("microDetails") + i] = layer.microDetail ?? 0;
      }
      this.data.set(splatUvTransform(this.originX, this.originZ, this.size, 512), at("macroUv"));
      device.device.queue.writeBuffer(this.splatBuffer, 0, gpuSource(this.data));
    }
    super.ensureGpu(device, layout, defaults);
  }

  protected override gpuBindings(defaults: MaterialDefaults): GPUBindGroupEntry[] {
    return [
      ...super.gpuBindings(defaults),
      { binding: SPLAT_BINDINGS.uniforms, resource: { buffer: this.splatBuffer! } },
      { binding: SPLAT_BINDINGS.albedo, resource: this.maps.albedo.view },
      { binding: SPLAT_BINDINGS.normal, resource: this.maps.normal.view },
      { binding: SPLAT_BINDINGS.mr, resource: this.maps.metallicRoughness.view },
      { binding: SPLAT_BINDINGS.weights, resource: this.weightMap.view },
      { binding: SPLAT_BINDINGS.sampler, resource: this.clampSampler! },
    ];
  }

  override setTechnique(technique: MaterialTechnique): this {
    if (technique !== "terrain") throw new UsageError("SplatMaterial requires the terrain technique");
    return this;
  }

  /** Like ordinary material maps, cloned textures are borrowed; keep their owner alive. */
  override clone(options: MaterialOptions = {}): SplatMaterial {
    if (options.technique && options.technique !== "terrain") throw new UsageError("SplatMaterial requires the terrain technique");
    const copy = new SplatMaterial({
      label: options.label ?? `${this.label}(copy)`, layers: this.layers, maps: this.maps,
      weightMap: this.weightMap, originX: this.originX, originZ: this.originZ, size: this.size,
    });
    copy.setColor(options.color ?? this.baseColor);
    copy.emissive.copyFrom(this.emissive);
    if (options.emissive !== undefined) copy.setEmissive(options.emissive);
    copy.emissiveStrength = options.emissiveStrength ?? this.emissiveStrength;
    copy.roughness = options.roughness ?? this.roughness;
    copy.metallic = options.metallic ?? this.metallic;
    copy.opacity = options.opacity ?? this.opacity;
    copy.doubleSided = options.doubleSided ?? this.doubleSided;
    copy.transparent = options.transparent ?? this.transparent;
    copy.alphaTest = this.alphaTest;
    return copy.markChanged();
  }

  override dispose(): void {
    super.dispose();
    this.splatBuffer?.destroy();
    this.splatBuffer = null;
    if (this.ownsWeightMap) this.weightMap.dispose();
  }
}
