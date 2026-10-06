/**
 * Runtime asset validation (Phase 15.5).
 *
 * Validators return structured diagnostics instead of logging and continuing with data that will
 * fail later on a GPU. A descriptor can attach its own validator to `ResourceDescriptor.validate`;
 * the registry runs it before publishing a value and disposes rejected output. The standalone
 * helpers below are also useful in importers and editor tooling before GPU objects are created.
 */

import { AssetError } from "../core/errors.js";
import { formatInfo } from "../gpu/formats.js";
import { AssetId } from "./assetId.js";
import type { ResourceRegistry } from "./registry.js";

export type AssetDiagnosticSeverity = "error" | "warning";

export interface AssetDiagnostic {
  code: string;
  severity: AssetDiagnosticSeverity;
  message: string;
  /** JSON-pointer-like location within the asset, when one is known. */
  path?: string;
}

export interface AssetValidationResult {
  valid: boolean;
  diagnostics: AssetDiagnostic[];
}

/** A load-time validation failure; attached diagnostics survive through the registry's failed event. */
export class AssetValidationError extends AssetError {
  readonly diagnostics: readonly AssetDiagnostic[];

  constructor(assetId: string, diagnostics: readonly AssetDiagnostic[]) {
    const errors = diagnostics.filter((issue) => issue.severity === "error");
    super(
      `asset "${assetId}" failed validation: ${errors.map((issue) => `${issue.code}: ${issue.message}`).join("; ")}`,
      assetId,
      "E_ASSET_VALIDATION",
    );
    this.diagnostics = [...diagnostics];
  }
}

export interface MeshValidationData {
  positions: ArrayLike<number>;
  normals?: ArrayLike<number> | null;
  uvs?: ArrayLike<number> | null;
  tangents?: ArrayLike<number> | null;
  indices?: ArrayLike<number> | null;
}

/**
 * Detect malformed triangle mesh streams before `Geometry.create` or a GPU upload. Out-of-range
 * indices are an error (WebGPU may silently render nothing); optional attribute streams are
 * checked when present and must match the vertex count exactly.
 */
export function validateMeshData(mesh: MeshValidationData, assetId = "mesh"): AssetDiagnostic[] {
  const issues: AssetDiagnostic[] = [];
  const positions = mesh.positions;
  if (positions.length === 0) {
    issues.push(error("asset.mesh.empty", `${assetId} has no positions`, "/positions"));
    return issues;
  }
  if (positions.length % 3 !== 0) {
    issues.push(error("asset.mesh.position-stride", `${assetId} position component count must be divisible by 3`, "/positions"));
  }
  const vertexCount = Math.floor(positions.length / 3);
  for (let i = 0; i < positions.length; i++) {
    if (!Number.isFinite(positions[i])) {
      issues.push(error("asset.mesh.non-finite-position", `${assetId} has a non-finite position component at ${i}`, `/positions/${i}`));
      break;
    }
  }
  checkAttribute(mesh.normals, vertexCount * 3, "normals", assetId, issues);
  checkAttribute(mesh.uvs, vertexCount * 2, "uvs", assetId, issues);
  checkAttribute(mesh.tangents, vertexCount * 4, "tangents", assetId, issues);

  const indices = mesh.indices;
  if (indices && indices.length > 0) {
    if (indices.length % 3 !== 0) {
      issues.push(error("asset.mesh.index-stride", `${assetId} triangle index count must be divisible by 3`, "/indices"));
    }
    for (let i = 0; i < indices.length; i++) {
      const index = indices[i];
      if (!Number.isInteger(index) || index! < 0 || index! >= vertexCount) {
        issues.push(error("asset.mesh.index-range", `${assetId} index ${i} (${String(index)}) is outside [0, ${vertexCount})`, `/indices/${i}`));
        break;
      }
    }
  } else if (vertexCount % 3 !== 0) {
    issues.push(warning("asset.mesh.trailing-vertices", `${assetId} has vertices beyond its last complete triangle`, "/positions"));
  }
  return issues;
}

export interface TextureValidationData {
  width: number;
  height: number;
  depthOrArrayLayers?: number;
  mipLevelCount?: number;
  format: GPUTextureFormat;
  gpuBytes?: number;
  releasedState?: boolean;
}

export interface TextureValidationOptions {
  maxTextureDimension2D?: number;
  maxArrayLayers?: number;
  maxBytes?: number;
  textureCompressionBc?: boolean;
  textureCompressionEtc2?: boolean;
  textureCompressionAstc?: boolean;
}

/** Check dimensions, mip limits, known formats, compressed-format capability and memory size. */
export function validateTextureData(texture: TextureValidationData, options: TextureValidationOptions = {}, assetId = "texture"): AssetDiagnostic[] {
  const issues: AssetDiagnostic[] = [];
  const integerPositive = (value: number, key: string): boolean => {
    if (Number.isInteger(value) && value > 0) return true;
    issues.push(error("asset.texture.invalid-dimension", `${assetId} ${key} must be a positive integer (got ${value})`, `/${key}`));
    return false;
  };
  integerPositive(texture.width, "width");
  integerPositive(texture.height, "height");
  const layers = texture.depthOrArrayLayers ?? 1;
  integerPositive(layers, "depthOrArrayLayers");
  const maxDim = options.maxTextureDimension2D;
  if (maxDim !== undefined && (texture.width > maxDim || texture.height > maxDim)) {
    issues.push(error("asset.texture.dimension-limit", `${assetId} dimensions ${texture.width}x${texture.height} exceed the device limit ${maxDim}`, "/size"));
  }
  if (options.maxArrayLayers !== undefined && layers > options.maxArrayLayers) {
    issues.push(error("asset.texture.layer-limit", `${assetId} has ${layers} layers, exceeding ${options.maxArrayLayers}`, "/depthOrArrayLayers"));
  }
  let info: ReturnType<typeof formatInfo> | null = null;
  try {
    info = formatInfo(texture.format);
  } catch {
    issues.push(error("asset.texture.unknown-format", `${assetId} uses unknown texture format "${texture.format}"`, "/format"));
  }
  if (info?.isCompressed) {
    if ((texture.width > 0 && texture.width % info.blockWidth !== 0) || (texture.height > 0 && texture.height % info.blockHeight !== 0)) {
      issues.push(error("asset.texture.block-alignment", `${assetId} dimensions must align to the ${info.blockWidth}x${info.blockHeight} block size of "${texture.format}"`, "/size"));
    }
    const supported = texture.format.startsWith("bc")
      ? options.textureCompressionBc
      : texture.format.startsWith("etc2")
        ? options.textureCompressionEtc2
        : texture.format.startsWith("astc")
          ? options.textureCompressionAstc
          : false;
    if (supported === false) {
      issues.push(error("asset.texture.unsupported-format", `${assetId} requires unsupported compressed format "${texture.format}"`, "/format"));
    }
  }
  const mips = texture.mipLevelCount ?? 1;
  if (!Number.isInteger(mips) || mips < 1) {
    issues.push(error("asset.texture.invalid-mips", `${assetId} mipLevelCount must be a positive integer (got ${mips})`, "/mipLevelCount"));
  } else {
    const maximum = Math.floor(Math.log2(Math.max(1, texture.width, texture.height))) + 1;
    if (mips > maximum) issues.push(error("asset.texture.too-many-mips", `${assetId} has ${mips} mip levels, maximum for ${texture.width}x${texture.height} is ${maximum}`, "/mipLevelCount"));
  }
  if (texture.releasedState) issues.push(error("asset.texture.released", `${assetId} refers to a released GPU texture`));
  if (options.maxBytes !== undefined && options.maxBytes > 0 && texture.gpuBytes !== undefined && texture.gpuBytes > options.maxBytes) {
    issues.push(error("asset.memory.exceeded", `${assetId} needs ${texture.gpuBytes} bytes, exceeding the ${options.maxBytes}-byte limit`));
  }
  return issues;
}

export interface MaterialValidationData {
  technique: string;
  metallic?: number;
  roughness?: number;
  opacity?: number;
  emissiveStrength?: number;
  albedoMap?: { releasedState?: boolean } | null;
  normalMap?: { releasedState?: boolean } | null;
  metallicRoughnessMap?: { releasedState?: boolean } | null;
}

export interface RequiredTextureReference {
  slot: string;
  id: string;
}

export interface MaterialValidationOptions {
  supportedTechniques?: readonly string[];
  requiredTextures?: readonly RequiredTextureReference[];
  registry?: ResourceRegistry;
}

const MATERIAL_TECHNIQUES = ["standard", "unlit", "emissive", "debug-line", "blit", "water"] as const;

/** Detect unknown shader/material techniques, invalid PBR values, and absent or released maps. */
export function validateMaterialData(material: MaterialValidationData, options: MaterialValidationOptions = {}, assetId = "material"): AssetDiagnostic[] {
  const issues: AssetDiagnostic[] = [];
  const supported = options.supportedTechniques ?? MATERIAL_TECHNIQUES;
  if (!supported.includes(material.technique)) {
    issues.push(error("asset.material.unsupported", `${assetId} uses unsupported material technique "${material.technique}"`, "/technique"));
  }
  checkUnitInterval(material.metallic, "metallic", assetId, issues);
  checkUnitInterval(material.roughness, "roughness", assetId, issues);
  checkUnitInterval(material.opacity, "opacity", assetId, issues);
  if (material.emissiveStrength !== undefined && (!Number.isFinite(material.emissiveStrength) || material.emissiveStrength < 0)) {
    issues.push(error("asset.material.invalid-emissive", `${assetId} emissiveStrength must be finite and non-negative`, "/emissiveStrength"));
  }
  for (const [slot, texture] of [
    ["albedoMap", material.albedoMap],
    ["normalMap", material.normalMap],
    ["metallicRoughnessMap", material.metallicRoughnessMap],
  ] as const) {
    if (texture?.releasedState) issues.push(error("asset.texture.missing", `${assetId} ${slot} refers to a released texture`, `/${slot}`));
  }
  if (options.registry) {
    for (const reference of options.requiredTextures ?? []) {
      if (options.registry.stateOf(reference.id) !== "ready") {
        issues.push(error("asset.texture.missing", `${assetId} requires ${reference.slot} texture "${reference.id}", but it is not loaded`, `/${reference.slot}`));
      }
    }
  } else if ((options.requiredTextures?.length ?? 0) > 0) {
    issues.push(warning("asset.validation.no-registry", `${assetId} texture ids were supplied without a registry to resolve them`));
  }
  return issues;
}

/** Check a resource's declared dependencies, with a texture-specific diagnostic for missing maps. */
export function validateAssetDependencies(assetId: string, dependencyIds: readonly string[], registry: ResourceRegistry): AssetDiagnostic[] {
  const issues: AssetDiagnostic[] = [];
  for (const dependencyId of dependencyIds) {
    if (registry.stateOf(dependencyId) === "ready") continue;
    const texture = AssetId.kindOf(dependencyId) === "texture";
    issues.push(error(
      texture ? "asset.texture.missing" : "asset.dependency.missing",
      `${assetId} depends on ${texture ? "texture" : "asset"} "${dependencyId}", but it is not loaded`,
      `/dependencies/${dependencyId}`,
    ));
  }
  return issues;
}

/** Detect an asset or registry footprint that exceeds its configured resident-memory budget. */
export function validateMemoryBudget(bytes: number, maxBytes: number, assetId = "assets"): AssetDiagnostic[] {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return [error("asset.memory.invalid", `${assetId} memory estimate must be finite and non-negative (got ${bytes})`)];
  }
  if (maxBytes <= 0 || bytes <= maxBytes) return [];
  return [error("asset.memory.exceeded", `${assetId} uses ${bytes} bytes, exceeding the ${maxBytes}-byte budget`)];
}

export function validateRegistryMemory(registry: ResourceRegistry, maxBytes = registry.maxBytes): AssetValidationResult {
  return result(validateMemoryBudget(registry.bytes, maxBytes, "resource registry"));
}

export function validationResult(diagnostics: readonly AssetDiagnostic[]): AssetValidationResult {
  return result([...diagnostics]);
}

function result(diagnostics: AssetDiagnostic[]): AssetValidationResult {
  return { valid: !diagnostics.some((issue) => issue.severity === "error"), diagnostics };
}

function checkAttribute(values: ArrayLike<number> | null | undefined, expected: number, name: string, assetId: string, issues: AssetDiagnostic[]): void {
  if (values == null) return;
  if (values.length !== expected) {
    issues.push(error("asset.mesh.attribute-length", `${assetId} ${name} has ${values.length} components; expected ${expected}`, `/${name}`));
    return;
  }
  for (let i = 0; i < values.length; i++) {
    if (!Number.isFinite(values[i])) {
      issues.push(error("asset.mesh.non-finite-attribute", `${assetId} ${name} contains a non-finite value at ${i}`, `/${name}/${i}`));
      break;
    }
  }
}

function checkUnitInterval(value: number | undefined, name: string, assetId: string, issues: AssetDiagnostic[]): void {
  if (value === undefined) return;
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    issues.push(error("asset.material.invalid-pbr", `${assetId} ${name} must be finite and in [0, 1] (got ${value})`, `/${name}`));
  }
}

function error(code: string, message: string, path?: string): AssetDiagnostic {
  return { code, severity: "error", message, path };
}

function warning(code: string, message: string, path?: string): AssetDiagnostic {
  return { code, severity: "warning", message, path };
}
