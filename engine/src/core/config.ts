/**
 * Engine configuration.
 *
 * One typed record with defaults, normalized + validated in a single place. Subsystems never
 * invent their own option objects: they take a slice of `ResolvedConfig` (or read from
 * `EngineContext.config`). This is what makes it possible to print/serialize/hash a run's
 * configuration, which is a requirement for reproducible benchmarks and replays.
 *
 * Unknown keys are reported (not silently ignored) because silently-dropped options are the
 * classic cause of "I set it and nothing changed".
 */

import { UsageError, assertInRange, assertPositive } from "./errors.js";
import { clamp } from "../math/scalar.js";
import { LogLevel, type LogLevel as LogLevelType } from "./log.js";

export type QualityProfile = "minimal" | "low" | "medium" | "high" | "ultra";
export type BackendPreference = "webgpu" | "mock";
export type ToneMapper = "aces" | "agx" | "neutral" | "reinhard" | "linear";

export interface EngineConfig extends Partial<EngineConfigExtras> {
  /** Element (or OffscreenCanvas) to present into. Omit for headless/sim-only runs. */
  canvas?: HTMLCanvasElement | OffscreenCanvas;
  quality?: QualityProfile;
  backend?: BackendPreference;
  /** Explicit device features to require (initialization fails if missing). */
  requiredFeatures?: readonly string[];
  /** Features the engine uses when present; never fails init. */
  optionalFeatures?: readonly string[];
  limits?: Partial<GPUSupportedLimits>;
  /** Render at a fraction of canvas resolution (1 = native). Upscaled by the post chain. */
  renderScale?: number;
  /** Cap on the presented resolution's width (0 = unlimited). Guards against 8K browsers. */
  maxRenderWidth?: number;
  /** Enable the browser's HDR canvas path when the format is available. */
  hdr?: boolean;
  vsync?: boolean;
  /** Fixed simulation step in seconds. */
  fixedDeltaTime?: number;
  maxSubSteps?: number;
  /** Do not present, do not read canvas: used by tests/benchmarks. */
  headless?: boolean;
  logLevel?: LogLevelType | "silent" | "error" | "warn" | "info" | "debug" | "trace";
  /** Enable per-pass GPU timestamp queries (costs a resolve buffer read; on by default in dev). */
  gpuTimestamps?: boolean;
  /** Validate that every submitted command stream matches expectations (dev only, expensive). */
  renderValidation?: boolean;
  /** Run the fixed simulation in a worker (off by default; see ADR-008). */
  simulationWorker?: boolean;
  /** Number of engine worker threads for asset/terrain/physics prep (0 = inline). */
  workerCount?: number;
  /** Deterministic mode: fixed RNG for all subsystems, no wall-clock-derived behaviour. */
  deterministic?: boolean;
  /** Root URL for `assets.load*` paths. */
  assetBaseUrl?: string;
  /** Total GPU memory budget in MB; streaming evicts beyond it. */
  gpuMemoryBudgetMB?: number;
  /** Max textures resident in the sampler/aniso state used by terrain splats. */
  anisotropy?: number;
  /** Frame rate ceiling; 0 = uncapped. */
  maxFps?: number;
  /** Pause simulation when the tab is hidden (rendering also stops via RAF). */
  pauseWhenHidden?: boolean;
  /** Extra named defines injected into every shader (project-level feature flags). */
  shaderDefines?: Record<string, string | number | boolean>;
  /** Assert that no allocation happened during hot systems (dev). */
  allocationAudit?: boolean;
}

export interface ResolvedConfig extends Required<Omit<EngineConfig, "canvas" | "logLevel">> {
  canvas?: HTMLCanvasElement | OffscreenCanvas;
  logLevel: LogLevelType;
  /** Frozen after `resolveConfig`; `engine.config` returns this object. */
  /** Frozen copy of what the user passed, for `engine.config.dump()`. */
  readonly userOverrides: Readonly<Record<string, unknown>>;
  readonly configHash: number;
}

/**
 * Quality presets, expressed as deltas from `DEFAULTS` (see docs/PERFORMANCE.md for the
 * measured cost of each toggle).
 */
export const QUALITY_PROFILES: Record<QualityProfile, Partial<FullConfig>> = {
  minimal: {
    renderScale: 0.65,
    shadowCascades: 1,
    shadowMapSize: 512,
    contactShadows: false,
    depthPrepass: false,
    ssao: false,
    clusteredLighting: false,
    bloom: false,
    skyQuality: "low",
    motionBlur: false,
    depthOfField: false,
    volumetrics: false,
    reflections: "none",
    maxParticles: 20000,
    terrainVisibleDistance: 2000,
    gpuTimestamps: false,
  },
  low: {
    renderScale: 0.8,
    shadowCascades: 2,
    shadowMapSize: 1024,
    contactShadows: false,
    depthPrepass: false,
    ssao: false,
    clusteredLighting: false,
    bloom: true,
    skyQuality: "low",
    motionBlur: false,
    depthOfField: false,
    volumetrics: false,
    reflections: "screen-space",
    maxParticles: 50000,
    terrainVisibleDistance: 4000,
  },
  medium: {
    renderScale: 1,
    shadowCascades: 3,
    shadowMapSize: 2048,
    contactShadows: false,
    depthPrepass: true,
    ssao: true,
    bloom: true,
    skyQuality: "medium",
    motionBlur: false,
    depthOfField: false,
    volumetrics: true,
    reflections: "screen-space",
    maxParticles: 120000,
    terrainVisibleDistance: 8000,
  },
  high: {
    renderScale: 1,
    shadowCascades: 4,
    shadowMapSize: 2048,
    contactShadows: true,
    depthPrepass: true,
    ssao: true,
    bloom: true,
    skyQuality: "high",
    motionBlur: true,
    depthOfField: true,
    volumetrics: true,
    reflections: "screen-space",
    maxParticles: 250000,
    terrainVisibleDistance: 16000,
    gpuTimestamps: true,
  },
  ultra: {
    renderScale: 1,
    shadowCascades: 4,
    shadowMapSize: 4096,
    contactShadows: true,
    depthPrepass: true,
    ssao: true,
    bloom: true,
    skyQuality: "high",
    motionBlur: true,
    depthOfField: true,
    volumetrics: true,
    reflections: "screen-space",
    maxParticles: 500000,
    terrainVisibleDistance: 32000,
    gpuTimestamps: true,
  },
};

export interface EngineConfigExtras {
  shadowCascades: number;
  shadowMapSize: number;
  contactShadows: boolean;
  /**
   * Allow the depth prepass (`forge.prepass`): the opaque depth first, then one shading pass per
   * visible pixel. Also gates SSAO, which reads that depth. Caps `SceneSettings.depthPrepass`.
   */
  depthPrepass: boolean;
  /** Allow screen-space ambient occlusion (needs `depthPrepass`). Caps `SceneSettings.ssao.enabled`. */
  ssao: boolean;
  /**
   * Allow clustered (Forward+) lighting: local lights gathered into a 16×8×24 view-space grid, so a
   * fragment evaluates the lights in its own cluster instead of a fixed 16-entry uniform list.
   * Caps `SceneSettings.clusteredLighting`.
   */
  clusteredLighting: boolean;
  bloom: boolean;
  /** Cap on the sky pass's ray-march tier (`SceneSkySettings.quality` asks, this caps). */
  skyQuality: "low" | "medium" | "high";
  motionBlur: boolean;
  depthOfField: boolean;
  volumetrics: boolean;
  reflections: "none" | "screen-space" | "probes";
  maxParticles: number;
  terrainVisibleDistance: number;
  toneMapper: ToneMapper;
  exposure: number;
  /** Max queued worker tasks per category before dropping (backpressure). */
  taskQueueLimit: number;
  /** Terrain chunk budgets. */
  terrainMaxResidentChunks: number;
  terrainChunksPerFrame: number;
  /** Physics solver. */
  physicsSolverIterations: number;
  physicsEnableWarmStarting: boolean;
  /** Mesh/asset budgets. */
  maxTextureMB: number;
  maxMeshMB: number;
  /** Script watchdog: max ms a single script callback may take before being reported. */
  scriptWarnMs: number;
  /** Script watchdog: consecutive errors before a script component is disabled. */
  scriptErrorLimit: number;
}

export type FullConfig = ResolvedConfig & EngineConfigExtras;

const DEFAULTS: FullConfig = {
  backend: "webgpu",
  quality: "high",
  requiredFeatures: [],
  optionalFeatures: [],
  limits: {},
  renderScale: 1,
  maxRenderWidth: 0,
  hdr: true,
  vsync: true,
  fixedDeltaTime: 1 / 60,
  maxSubSteps: 5,
  headless: false,
  logLevel: LogLevel.Info,
  gpuTimestamps: false,
  renderValidation: false,
  simulationWorker: false,
  workerCount: 0,
  deterministic: false,
  assetBaseUrl: "/assets/",
  gpuMemoryBudgetMB: 1024,
  anisotropy: 8,
  maxFps: 0,
  pauseWhenHidden: true,
  shaderDefines: {},
  allocationAudit: false,
  userOverrides: {},
  configHash: 0,
  shadowCascades: 4,
  shadowMapSize: 2048,
  contactShadows: true,
  depthPrepass: true,
  ssao: true,
  clusteredLighting: true,
  bloom: true,
  skyQuality: "high",
  motionBlur: true,
  depthOfField: true,
  volumetrics: true,
  reflections: "screen-space",
  maxParticles: 250000,
  terrainVisibleDistance: 16000,
  toneMapper: "aces",
  exposure: 1,
  taskQueueLimit: 4096,
  terrainMaxResidentChunks: 256,
  terrainChunksPerFrame: 4,
  physicsSolverIterations: 8,
  physicsEnableWarmStarting: true,
  maxTextureMB: 512,
  maxMeshMB: 256,
  scriptWarnMs: 4,
  scriptErrorLimit: 8,
};

const KNOWN_KEYS = new Set<string>(Object.keys(DEFAULTS));

/** Compute the config hash (FNV-1a over a canonical serialization). */
function hashConfig(obj: Record<string, unknown>): number {
  const keys = Object.keys(obj).sort();
  let s = "";
  for (const k of keys) {
    const v = obj[k];
    if (v === null || v === undefined) continue;
    if (typeof v === "object") continue; // canvases, sinks: not part of reproducibility
    s += `${k}=${typeof v === "number" ? v.toFixed(6) : String(v)};`;
  }
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export interface ResolveOptions {
  /** Log warnings (unknown keys, clamped values) through the engine logger when provided. */
  onWarning?: (message: string) => void;
  strict?: boolean;
}

export function resolveConfig(input: EngineConfig = {}, options: ResolveOptions = {}): FullConfig {
  const overrides: Record<string, unknown> = {};
  for (const key of Object.keys(input)) {
    const value = (input as Record<string, unknown>)[key];
    if (value === undefined) continue;
    if (!KNOWN_KEYS.has(key)) {
      const msg = `Engine config: unknown option "${key}" (ignored). Known options: ${[...KNOWN_KEYS].join(", ")}`;
      if (options.strict) throw new UsageError(msg);
      options.onWarning?.(msg);
      continue;
    }
    overrides[key] = value;
  }

  const quality: QualityProfile = (input.quality as QualityProfile) ?? "high";
  if (!(quality in QUALITY_PROFILES)) {
    throw new UsageError(`Unknown quality profile "${quality}". Expected one of: ${Object.keys(QUALITY_PROFILES).join(", ")}`);
  }

  const merged = { ...DEFAULTS, ...QUALITY_PROFILES[quality], ...overrides } as FullConfig;
  // quality/userOverrides must survive the profile merge as the caller set them.
  merged.quality = quality;
  (merged as unknown as { userOverrides: Readonly<Record<string, unknown>> }).userOverrides = Object.freeze({ ...overrides });

  if (input.gpuTimestamps === undefined && QUALITY_PROFILES[quality].gpuTimestamps === undefined) {
    merged.gpuTimestamps = false;
  }

  // ---- validation / normalization ----
  assertPositive("fixedDeltaTime", merged.fixedDeltaTime);
  assertInRange("renderScale", merged.renderScale, 0.25, 2);
  assertInRange("exposure", merged.exposure, 0.01, 64);
  if (!Number.isInteger(merged.maxSubSteps) || merged.maxSubSteps < 1) {
    throw new UsageError(`maxSubSteps must be an integer >= 1, got ${merged.maxSubSteps}`);
  }
  if (merged.shadowCascades < 1 || merged.shadowCascades > 4) {
    const clamped = clamp(Math.round(merged.shadowCascades), 1, 4);
    options.onWarning?.(`shadowCascades ${merged.shadowCascades} clamped to ${clamped} (WebGPU atlas layout supports 1..4)`);
    merged.shadowCascades = clamped;
  }
  if ((merged.shadowMapSize & (merged.shadowMapSize - 1)) !== 0 || merged.shadowMapSize < 256) {
    const next = 2 ** Math.ceil(Math.log2(Math.max(256, merged.shadowMapSize)));
    options.onWarning?.(`shadowMapSize ${merged.shadowMapSize} is not a power of two >= 256; using ${next}`);
    merged.shadowMapSize = next;
  }
  if (merged.anisotropy < 1 || merged.anisotropy > 16) {
    const next = clamp(Math.round(merged.anisotropy), 1, 16);
    options.onWarning?.(`anisotropy ${merged.anisotropy} out of range; using ${next}`);
    merged.anisotropy = next;
  }
  if (merged.maxFps > 0 && (merged.maxFps < 10 || merged.maxFps > 500)) {
    options.onWarning?.(`maxFps ${merged.maxFps} looks wrong; clamping to [10, 500]`);
    merged.maxFps = clamp(merged.maxFps, 10, 500);
  }
  if (merged.workerCount < 0) throw new UsageError(`workerCount cannot be negative`);
  if (merged.logLevel === undefined) merged.logLevel = LogLevel.Info;
  if (!merged.assetBaseUrl.endsWith("/")) merged.assetBaseUrl += "/";
  if (merged.logLevel === undefined) merged.logLevel = LogLevel.Info;
  (merged as unknown as { configHash: number }).configHash = hashConfig(merged as unknown as Record<string, unknown>);
  return merged;
}

/** Human-readable dump for the console/debug overlay + `engine.config`. */
export function describeConfig(config: FullConfig): string {
  const lines: string[] = [];
  lines.push(`quality=${config.quality} backend=${config.backend} renderScale=${config.renderScale}`);
  lines.push(
    `shadows=${config.shadowCascades}x${config.shadowMapSize} prepass=${config.depthPrepass} ssao=${config.ssao} clustered=${config.clusteredLighting} bloom=${config.bloom} sky<=${config.skyQuality} volumetrics=${config.volumetrics} refl=${config.reflections}`,
  );
  lines.push(`fixedDt=${config.fixedDeltaTime.toFixed(5)} substeps<=${config.maxSubSteps} particles<=${config.maxParticles}`);
  lines.push(`terrain: visible=${config.terrainVisibleDistance}m resident<=${config.terrainMaxResidentChunks}/frame=${config.terrainChunksPerFrame}`);
  lines.push(`configHash=0x${config.configHash.toString(16)}`);
  return lines.join("\n");
}
