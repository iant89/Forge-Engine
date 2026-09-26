/**
 * Terrain pipeline *specifications* — a pipeline as structured-cloneable data.
 *
 * A `GeneratorPipeline` is a graph of class instances; a worker can only be sent plain data, and
 * Rule 8 ("worker jobs are deterministic functions of seed/key/input") is only meaningful if the
 * *pipeline itself* travels with the job. This module is the translation layer:
 *
 *    describePipeline(pipeline) → TerrainPipelineSpec → createPipelineFromSpec(spec)
 *
 * Two contracts make it safe to use as a worker payload:
 *  - **Every stage must be describable.** `describePipeline` throws `UsageError` for a custom stage
 *    it does not know instead of silently dropping it — terrain generated on a worker must never
 *    differ from terrain generated inline.
 *  - **Options are always explicit.** `describePipeline` writes the stage's *current* values (defaults
 *    filled in by the constructor), so the spec round-trips exactly: `describe(create(spec))` is
 *    structurally equal to `spec`, and two specs that differ produce different terrain.
 *
 * The spec is part of a chunk's cache key (Phase 10.3) for the same reason.
 */

import { InlineOnlyError, UsageError } from "../core/errors.js";
import {
  BiomeGenerator,
  CraterGenerator,
  ErosionGenerator,
  GeneratorPipeline,
  HeightGenerator,
  ScatterGenerator,
  type TerrainStage,
} from "./generators.js";
import {
  ClimateBiomeGenerator,
  DetailNoiseGenerator,
  HydraulicErosionGenerator,
  RealisticHeightGenerator,
  RealisticScatterGenerator,
  ThermalErosionGenerator,
  ValleyCarvingGenerator,
} from "./realistic.js";
import { MarsTerrainStage, type MarsSiteOptions } from "./mars/stage.js";
import type { MarsGenParams } from "./mars/config.js";

export type TerrainStageKind =
  | "height"
  | "crater"
  | "erosion"
  | "biome"
  | "scatter"
  | "realistic-height"
  | "thermal-erosion"
  | "hydraulic-erosion"
  | "valley-carving"
  | "detail-noise"
  | "climate-biome"
  | "realistic-scatter"
  | "mars";

/**
 * One option value in a spec.
 *
 * Scalars plus `string`: structured settings can travel as canonical JSON (the Mars stage's
 * `identity` carries its complete analytic configuration). Live Stage A field buffers stay inline.
 */
export type TerrainStageOptionValue = number | boolean | string;

export type TerrainStageOptions = Record<string, TerrainStageOptionValue>;

export interface TerrainStageSpec {
  kind: TerrainStageKind;
  options: TerrainStageOptions;
}

export interface TerrainPipelineSpec {
  stages: TerrainStageSpec[];
}

interface StageCodec {
  readonly kind: TerrainStageKind;
  /** Option names carried by the spec — the single list both directions are driven from. */
  readonly fields: readonly string[];
  /** Instance test for `describeStage`. */
  matches(stage: object): boolean;
  create(options: TerrainStageOptions): TerrainStage;
}

function codec<P extends object>(
  kind: TerrainStageKind,
  fields: readonly (keyof P & string)[],
  matches: (stage: object) => boolean,
  construct: (options: P) => TerrainStage,
): StageCodec {
  return {
    kind,
    fields,
    matches,
    create: (options) => construct(options as P),
  };
}

/**
 * The scalar surface the Mars codec reads off `MarsTerrainStage` (its identity fields). Declared
 * here rather than reusing `MarsTerrainStageOptions` because a codec's `fields` are the *spec*
 * keys, not constructor options. `identity` carries the complete analytic configuration as JSON;
 * a non-null field-cache marker explicitly prevents reconstruction without those live buffers.
 */
interface MarsStageSpecFields {
  identity: string;
  seed: number;
  radius: number;
  siteLatDeg: number;
  siteLonDeg: number;
  siteHeadingDeg: number;
  curvatureCompensation: boolean;
  detail: boolean;
}

/** The JSON identity is both a cache key and the analytic Mars worker payload. */
interface MarsStageIdentity extends MarsGenParams {
  site: Required<MarsSiteOptions>;
  detail: boolean;
  curvatureCompensation: boolean;
  globalFields: number[] | null;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function numbers(value: unknown, fields: readonly string[]): value is Record<string, unknown> {
  return record(value) && fields.every((key) => typeof value[key] === "number" && Number.isFinite(value[key]));
}

const vector = (value: unknown): boolean => numbers(value, ["x", "y", "z"]);

/**
 * Rebuild from the *entire* planet, never defaults plus seed: volcanoes/canyon/dichotomy, the site's
 * own radius, detail and curvature all change the surface. Reject malformed or inconsistent specs
 * rather than guessing, and never drop a live field cache to make a worker task appear successful.
 */
function createMarsStage(options: MarsStageSpecFields): MarsTerrainStage {
  let data: unknown;
  try {
    data = JSON.parse(options.identity) as unknown;
  } catch {
    throw new UsageError("mars terrain spec: identity must be complete configuration JSON");
  }
  if (
    !numbers(data, ["seed", "radius"]) ||
    !numbers(data.dichotomy, ["seed", "boundaryOffset", "amplitude", "waviness"]) || !vector(data.dichotomy.axis) ||
    !Array.isArray(data.canyon) || !data.canyon.every((c: unknown) =>
      numbers(c, ["width", "depth"]) && vector(c.a) && vector(c.b)) ||
    !Array.isArray(data.volcanoes) || !data.volcanoes.every((v: unknown) =>
      numbers(v, ["baseRadius", "height", "calderaRadius", "calderaDepth", "seed"]) && vector(v.center)) ||
    !numbers(data.site, ["latDeg", "lonDeg", "headingDeg", "radiusM"]) ||
    typeof data.detail !== "boolean" || typeof data.curvatureCompensation !== "boolean" ||
    !(data.globalFields === null || (Array.isArray(data.globalFields) &&
      data.globalFields.every((face: unknown) => typeof face === "number" && Number.isInteger(face) && face >= 0 && face < 6)))
  ) {
    throw new UsageError("mars terrain spec: identity has missing or invalid configuration fields");
  }
  const identity = data as unknown as MarsStageIdentity;
  if (!(identity.radius > 0 && identity.site.radiusM > 0)) {
    throw new UsageError("mars terrain spec: planet and site radii must be positive");
  }
  if (identity.globalFields !== null) {
    throw new InlineOnlyError(
      "the mars terrain stage samples a Stage A field cache held on the main thread; " +
        "run this cache-backed pipeline inline (TerrainWorld { syncGeneration: true })",
    );
  }
  const stage = new MarsTerrainStage({
    params: {
      seed: identity.seed,
      radius: identity.radius,
      dichotomy: identity.dichotomy,
      canyon: identity.canyon,
      volcanoes: identity.volcanoes,
    },
    site: identity.site,
    detail: identity.detail,
    curvatureCompensation: identity.curvatureCompensation,
  });
  if (
    stage.identity !== options.identity || stage.seed !== options.seed || stage.radius !== options.radius ||
    stage.siteLatDeg !== options.siteLatDeg || stage.siteLonDeg !== options.siteLonDeg ||
    stage.siteHeadingDeg !== options.siteHeadingDeg || stage.detail !== options.detail ||
    stage.curvatureCompensation !== options.curvatureCompensation
  ) {
    throw new UsageError("mars terrain spec: scalar options disagree with the serialized identity");
  }
  return stage;
}

/** The stage kinds the worker can reconstruct, with the options each one carries. */
export const TERRAIN_STAGE_CODECS: readonly StageCodec[] = [
  codec<NonNullable<ConstructorParameters<typeof HeightGenerator>[0]>>(
    "height",
    ["octaves", "frequency", "amplitude", "lacunarity", "gain", "ridgeWeight", "seaLevel"],
    (s) => s instanceof HeightGenerator,
    (options) => new HeightGenerator(options),
  ),
  codec("crater", ["density", "minRadius", "maxRadius", "depthRatio", "rimRatio"], (s) => s instanceof CraterGenerator, (options) => new CraterGenerator(options)),
  codec("erosion", ["iterations", "talusAngle", "erosionRate"], (s) => s instanceof ErosionGenerator, (options) => new ErosionGenerator(options)),
  codec("biome", [], (s) => s instanceof BiomeGenerator, () => new BiomeGenerator()),
  codec("scatter", ["countPerChunk", "maxSlope"], (s) => s instanceof ScatterGenerator, (options) => new ScatterGenerator(options)),
  codec(
    "realistic-height",
    [
      "seaLevel",
      "continentalAmplitude",
      "continentalFrequency",
      "mountainAmplitude",
      "mountainFrequency",
      "hillAmplitude",
      "hillFrequency",
      "detailAmplitude",
      "detailFrequency",
      "warpAmount",
      "warpFrequency",
      "mountainSharpness",
      "continentalBias",
      "mountainMaskThreshold",
      "swellAmplitude",
      "plateauStrength",
    ],
    (s) => s instanceof RealisticHeightGenerator,
    (options) => new RealisticHeightGenerator(options),
  ),
  codec("thermal-erosion", ["iterations", "talusAngle", "erosionRate", "depositionRate"], (s) => s instanceof ThermalErosionGenerator, (options) => new ThermalErosionGenerator(options)),
  codec(
    "hydraulic-erosion",
    ["iterations", "rainfall", "solubility", "evaporation", "sedimentCapacity", "depositionRate", "flowRate"],
    (s) => s instanceof HydraulicErosionGenerator,
    (options) => new HydraulicErosionGenerator(options),
  ),
  codec("valley-carving", ["minAccumulation", "carveDepth", "valleyWidth", "widthFalloff", "riverBedSlope"], (s) => s instanceof ValleyCarvingGenerator, (options) => new ValleyCarvingGenerator(options)),
  codec("detail-noise", ["amplitude", "frequency", "octaves", "minSlope", "blend"], (s) => s instanceof DetailNoiseGenerator, (options) => new DetailNoiseGenerator(options)),
  codec("climate-biome", ["seaLevel", "snowLine", "lapseRate", "moistureFrequency"], (s) => s instanceof ClimateBiomeGenerator, (options) => new ClimateBiomeGenerator(options)),
  codec("realistic-scatter", ["countPerChunk", "maxSlope", "minHeight", "maxHeight"], (s) => s instanceof RealisticScatterGenerator, (options) => new RealisticScatterGenerator(options)),
  // Analytic Mars stages round-trip from their full JSON configuration. Stages holding a live
  // Stage A field cache still refuse reconstruction: a worker must never omit that correction.
  codec<MarsStageSpecFields>(
    "mars",
    ["identity", "seed", "radius", "siteLatDeg", "siteLonDeg", "siteHeadingDeg", "curvatureCompensation", "detail"],
    (s) => s instanceof MarsTerrainStage,
    createMarsStage,
  ),
];

const CODEC_BY_KIND = new Map<TerrainStageKind, StageCodec>(TERRAIN_STAGE_CODECS.map((c) => [c.kind, c]));

/** True when a stage can be described; live-data variants may still require inline execution. */
export function isDescribableStage(stage: object): boolean {
  return TERRAIN_STAGE_CODECS.some((c) => c.matches(stage));
}

function kindOf(stage: TerrainStage): TerrainStageKind {
  for (const c of TERRAIN_STAGE_CODECS) {
    if (c.matches(stage)) return c.kind;
  }
  throw new UsageError(
    `terrain stage "${stage.name}" is not describable: only built-in generators can be sent to a worker. ` +
      `Register a task handler for custom stages instead of passing them to the terrain pipeline task.`,
  );
}

/** Describe one stage as plain data (its current option values, defaults included). */
export function describeStage(stage: TerrainStage): TerrainStageSpec {
  const kind = kindOf(stage);
  const c = CODEC_BY_KIND.get(kind)!;
  const source = stage as unknown as Record<string, TerrainStageOptionValue | undefined>;
  const options: TerrainStageOptions = {};
  for (const field of c.fields) {
    const value = source[field];
    if (value === undefined) {
      throw new UsageError(`terrain stage "${kind}" is missing option "${field}" (describeStage/read mismatch)`);
    }
    options[field] = value;
  }
  return { kind, options };
}

/** Rebuild a stage from a spec. Throws for an unknown kind rather than guessing. */
export function createStageFromSpec(spec: TerrainStageSpec): TerrainStage {
  const c = CODEC_BY_KIND.get(spec.kind);
  if (!c) throw new UsageError(`unknown terrain stage kind "${String(spec.kind)}"`);
  return c.create(spec.options ?? {});
}

/** Describe a whole pipeline (see the module contract: an unknown stage throws). */
export function describePipeline(pipeline: GeneratorPipeline): TerrainPipelineSpec {
  return { stages: pipeline.stages.map((stage) => describeStage(stage)) };
}

/** Rebuild a pipeline from a spec, in order. */
export function createPipelineFromSpec(spec: TerrainPipelineSpec): GeneratorPipeline {
  if (!spec || !Array.isArray(spec.stages)) throw new UsageError("TerrainPipelineSpec.stages must be an array");
  const pipeline = new GeneratorPipeline();
  for (const stage of spec.stages) pipeline.addStage(createStageFromSpec(stage));
  return pipeline;
}

/**
 * Stable identity for a spec. Two pipelines with the same stages and options hash identically, which
 * is what a terrain cache key needs; the hash is a plain FNV-1a over the JSON of the *ordered* stage
 * list (so a reordered pipeline is a different pipeline).
 */
export function hashPipelineSpec(spec: TerrainPipelineSpec): number {
  const text = JSON.stringify(spec);
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}
